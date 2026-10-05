//! Live ses oturumunun dis yuzeyi. Giris 16 kHz, cikis 24 kHz mono.

mod bildirim;
mod connection;
mod conversation;
mod memory_gap;
mod microphone;
mod profil;
mod screen_stream;
mod session;
mod setup;
mod telemetry;
pub(crate) mod tools;

pub(crate) use bildirim::{sistem_bildirimi, sistem_bildirimi_oncelikli};
pub use connection::LiveSession;
pub use conversation::konusma_kapat;
pub use microphone::{dinleme_ayarla, dinleme_kipi, DinlemeKipi};
pub use session::OUT_RATE;
pub use setup::zihin_dokumu;
pub(crate) use telemetry::log_transcript;
pub(crate) use tools::tool_labels;

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

pub(super) fn monotonic_millis() -> u64 {
    static BAS: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    BAS.get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis()
        .max(1) as u64
}

/// Olay kanalindaki Smith sesi (24 kHz mono f32). Kanal sinirsizdir
/// (`UnboundedSender`; arac koprusu ayni tipi kullanir), bu yuzden tuketici
/// durursa ses sinirsiz birikirdi: uretici her parcayi bir butceye ayirir,
/// butce dolunca parcayi dusurur. Parca tuketilip dusunce butceye geri doner.
/// Klonlanmaz: tek tuketici vardir. `[f32]` gibi okunur.
#[derive(Debug)]
pub struct SesParcasi {
    ornekler: Vec<f32>,
    butce: Arc<AtomicUsize>,
    ilk_cihaz_ornegi: Arc<AtomicU64>,
}

impl SesParcasi {
    /// `tavan` orneklik `butce`den yer ayirir; sigmazsa `None` (cagiran dusurur ve
    /// sayar). Bos kanal her boyutta tek parca kabul eder: tavandan buyuk parca
    /// sesi sonsuza dek susturmasin.
    #[cfg(test)]
    pub(super) fn ayir(ornekler: Vec<f32>, butce: &Arc<AtomicUsize>, tavan: usize) -> Option<Self> {
        Self::ayir_isaretli(ornekler, butce, tavan, Arc::new(AtomicU64::new(0)))
    }

    pub(super) fn ayir_isaretli(
        ornekler: Vec<f32>,
        butce: &Arc<AtomicUsize>,
        tavan: usize,
        ilk_cihaz_ornegi: Arc<AtomicU64>,
    ) -> Option<Self> {
        let onceki = butce.fetch_add(ornekler.len(), Ordering::SeqCst);
        if onceki > 0 && onceki + ornekler.len() > tavan {
            butce.fetch_sub(ornekler.len(), Ordering::SeqCst);
            return None;
        }
        Some(Self {
            ornekler,
            butce: butce.clone(),
            ilk_cihaz_ornegi,
        })
    }

    pub(super) fn cihaz_isareti(&self) -> Arc<AtomicU64> {
        self.ilk_cihaz_ornegi.clone()
    }
}

impl std::ops::Deref for SesParcasi {
    type Target = [f32];
    fn deref(&self) -> &[f32] {
        &self.ornekler
    }
}

impl Drop for SesParcasi {
    fn drop(&mut self) {
        self.butce.fetch_sub(self.ornekler.len(), Ordering::SeqCst);
    }
}

/// Live oturumunun UI'a bildirdigi olaylar.
#[derive(Debug)]
pub enum LiveEvent {
    /// Kullanicinin konusmasinin metni (sunucu transkripsiyonu).
    UserText(String),
    /// Smith'in cevabinin metni (ses ile birlikte akar).
    AssistantText(String),
    /// Kullanici Smith'in sozunu kesti: calan ses atilmali.
    Interrupted,
    /// Smith'ten gelen ses.
    Audio(SesParcasi),
    /// Oturum durumu (baglandi / koptu) : UI gostergesi icin.
    Connected(bool),
    /// Ses izi karari degisti. UI'in "Hafiza" gostergesi eskiden ancak bir
    /// YAZMA denemesi gozlenince konusabiliyordu; oysa karar her ifadede
    /// zaten hesaplaniyor. Bunu dogrudan bildirmek gostergeyi gercege baglar.
    /// Deger: "owner" | "unknown" | "foreign".
    Speaker(&'static str),
    /// Arac hattinin gorunur hali: kullanici Smith'in NE YAPTIGINI gorsun.
    ///
    /// NEDEN: arac cagrilari yalniz stderr'e basiliyordu; kullanici acisindan
    /// Smith sessiz kaliyordu ("terminal komutu mu kosuyor, internete mi cikti,
    /// ses izi kapisi mi reddetti?" ayirt edilemiyordu).
    ///
    /// `durum` sozlesmesi: her cagri `basladi` ile acilir ve TEK bir bitis
    /// durumu alir : `bitti` (yurutuldu, hata donse bile) veya `reddedildi`
    /// (ses izi kapisi engelledi; `sebep` teknik gerekce). Reddedilen cagriya
    /// `bitti` GONDERILMEZ, aksi halde UI "yapildi" gosterirdi.
    Tool {
        ad: String,
        durum: &'static str,
        sebep: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn d1b_14_kanal_ses_butcesi_asilinca_parca_duser_tuketilince_acilir() {
        let butce = Arc::new(AtomicUsize::new(0));
        let ilk = SesParcasi::ayir(vec![0.1; 60], &butce, 100).unwrap();
        assert_eq!(&*ilk, &[0.1; 60][..]);
        assert!(SesParcasi::ayir(vec![0.2; 60], &butce, 100).is_none());
        assert_eq!(
            butce.load(Ordering::SeqCst),
            60,
            "reddedilen parca butceyi tutmamali"
        );
        let ikinci = SesParcasi::ayir(vec![0.3; 40], &butce, 100).unwrap();
        assert!(SesParcasi::ayir(vec![0.4; 1], &butce, 100).is_none());
        drop(ilk);
        assert!(SesParcasi::ayir(vec![0.5; 60], &butce, 100).is_some());
        drop(ikinci);
        assert_eq!(butce.load(Ordering::SeqCst), 0);
    }

    /// Kanal kotasi gercek tavandan beslenir (`MAX_QUEUED_SECONDS`): tuketici durup
    /// 40 sn'lik cevabin tamami (100 ms'lik 400 parca) birikse bile parca dusmez.
    #[test]
    fn d1b_14_kanal_kotasi_40_sn_cevabi_kesmez() {
        let butce = Arc::new(AtomicUsize::new(0));
        let tavan = crate::audio::MAX_QUEUED_SECONDS * OUT_RATE as usize;
        let parcalar: Vec<_> = (0..400)
            .map(|_| SesParcasi::ayir(vec![0.0; OUT_RATE as usize / 10], &butce, tavan))
            .collect();
        assert!(
            parcalar.iter().all(Option::is_some),
            "40 sn'lik cevap kesildi"
        );
    }

    #[test]
    fn d1b_14_bos_kanal_tavandan_buyuk_tek_parcayi_kabul_eder() {
        let butce = Arc::new(AtomicUsize::new(0));
        let buyuk = SesParcasi::ayir(vec![0.0; 500], &butce, 100).unwrap();
        assert!(SesParcasi::ayir(vec![0.0; 1], &butce, 100).is_none());
        drop(buyuk);
        assert_eq!(butce.load(Ordering::SeqCst), 0);
    }
}
