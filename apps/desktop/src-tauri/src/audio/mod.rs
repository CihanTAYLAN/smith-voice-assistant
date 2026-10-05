//! Smith ses altyapisi.
//!
//! Faz 0: tek mikrofon stream'ini yakala, broadcast ile dagit, RMS seviyeyi
//! UI'a akit. Fan-out mimarinin tohumu: ileride VAD/STT/speaker/sound worker'lari
//! ayni broadcast'e abone olur, capture degismez.
//!
//! Ses alt sistemi diger sistemlerden bagimsizdir ve ileride farkli input
//! device secimine izin verecek sekilde tasarlanmistir (bkz. list_input_devices).

mod capture;
mod echo_gate;
pub(crate) use echo_gate::{YankiKarari, YankiPolitikasi};
mod live;
mod playback;
mod resample;
mod screen;
mod speaker;
mod vad;

pub use capture::{list_input_devices, CpalAudioSource};
pub use live::{
    dinleme_ayarla, dinleme_kipi, konusma_kapat, zihin_dokumu, DinlemeKipi, LiveEvent, LiveSession,
    OUT_RATE as LIVE_OUT_RATE,
};
pub(crate) use live::{log_transcript, sistem_bildirimi, sistem_bildirimi_oncelikli, tool_labels};
pub use playback::{
    OutputGain, OutputReference, Playback, PlaybackClearReason, PlaybackSink, PlaybackStatus,
};
// Ekran paylasimi durumu UI'a bildirilir (`audio://screen`); `lib.rs` bu iki
// sorguyu cagirir. Yakalama, envanter ve monitor secimi modul icinde kalir —
// `audio::live` onlara ayni modul agacindan (`super::screen`) erisiyor, bu
// yuzden disariya acmaya GEREK YOK. (Cok monitor: 2026-08-15.)
pub use screen::{
    akis_acik, akis_ayarla, enabled as screen_enabled, interval_ms as screen_interval_ms,
};
pub use speaker::{SpeakerGate, SpeakerVerdict};
// VAD KALIR ve Live'in kritik yolundadir: ses izi kapisi ifade sinirlarini
// bununla buluyor (`live.rs`, `super::vad::SpeechEvent::Final`). Basamakli hat
// 2026-08-17'de sokuldugunde ilk refleks "VAD de gitti" olur — GITMEDI;
// silinirse hafizaya yazma tamamen olur.
pub use vad::{SileroVad, SpeechEvent, SpeechSegmenter};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::Duration;

use tokio::sync::broadcast;

/// Cihaz secimi kurtarmada yenilenince yanki karari da taze adi kullanir.
pub type CihazAdi = Arc<std::sync::Mutex<String>>;

/// Ham ses karesi — mono f32 ornekler + ornekleme frekansi.
/// Arc ile paylasilir; cok tuketici kopyalamadan okur.
#[derive(Clone, Debug)]
pub struct AudioFrame {
    pub samples: Arc<[f32]>,
    pub sample_rate: u32,
}

/// Ses kaynagi soyutlamasi. cpal bugunku tek implementasyon; motor degisimi
/// (or. sistem ses cikisi, dosya, uzak stream) bu trait'i uygulamakla olur.
pub trait AudioSource: Send {
    /// Yeni bir tuketici abonesi. Her abone tum kareleri bagimsiz alir.
    fn subscribe(&self) -> broadcast::Receiver<AudioFrame>;
    /// Yakalamayi durdurur (stream kapanir, kaynaklar serbest kalir). Surucu
    /// `AUDIO_DRIVER_TIMEOUT` icinde kapanmazsa `Err`: cagiran sonsuz beklemez.
    fn stop(self: Box<Self>) -> Result<(), AudioError>;
}

#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("Ses girisi bulunamadi (mikrofon yok veya erisim reddedildi).")]
    NoInputDevice,
    #[error("Ses cikisi bulunamadi (hoparlor yok veya erisim reddedildi).")]
    NoOutputDevice,
    #[error("Ses yapilandirmasi okunamadi: {0}")]
    Config(String),
    #[error("Ses stream'i kurulamadi: {0}")]
    Stream(String),
}

/// Ses surucusu acma ve kapatma cagrilarinin bekleme siniri. Surucu (WASAPI veya
/// ucuncu taraf) takilirsa cagiran bu sureden sonra ACIK hata alir; sonsuz
/// `recv`/`join` ile kilitlenmez. Capture ve playback ayni siniri kullanir.
pub(crate) const AUDIO_DRIVER_TIMEOUT: Duration = Duration::from_secs(5);

/// Smith sesinin tek bir asamada (olay kanali, oynatma kuyrugu) tutulabilecegi en
/// uzun sure; YALNIZ bellek koruyucusu (en kotu halde kanalda f32@24 kHz ~29 MB,
/// kuyrukta f32@48 kHz ~58 MB). Dar tutulamaz: canli olcumde (gemini-3.8-live) ses
/// gercek zamanin 4.1 kati hizla geldi, 40 sn'lik cevabin 39.9 sn'si 9.7 sn'de
/// teslim edilip kuyruk 30.2 sn'ye cikti. Bayat sesi bu tavan degil `Interrupted`
/// temizligi (`PlaybackSink::clear`) engeller; asilirsa en eski ses atilir ve sayac
/// loglanir.
pub(crate) const MAX_QUEUED_SECONDS: usize = 300;

fn surucu_bekle<T>(rx: &mpsc::Receiver<T>, sure: Duration) -> Result<T, AudioError> {
    rx.recv_timeout(sure).map_err(|e| {
        AudioError::Stream(match e {
            mpsc::RecvTimeoutError::Timeout => "surucu zaman asimi".into(),
            mpsc::RecvTimeoutError::Disconnected => {
                "surucu thread beklenmedik sekilde sonlandi".into()
            }
        })
    })
}

/// Surucu thread'ine durmasini bildirir ve bitmesini `sure` kadar bekler. Thread
/// takilirsa `Err`; tutamac devredildigi icin arka planda kendi hizinda biter ve
/// o zamana kadar yeni acilis `SurucuRezervasyonu` ile reddedilir.
fn surucu_kapat(
    thread: &mut Option<JoinHandle<()>>,
    stop: &AtomicBool,
    sure: Duration,
) -> Result<(), AudioError> {
    stop.store(true, Ordering::SeqCst);
    let Some(thread) = thread.take() else {
        return Ok(());
    };
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(thread.join());
    });
    surucu_bekle(&rx, sure)?.map_err(|_| AudioError::Stream("surucu thread panikledi".into()))
}

/// Timeout sonrasi eski surucu donmeden ikinci cihaz acilisi baslatilmaz.
#[derive(Debug)]
struct SurucuRezervasyonu(&'static AtomicBool);

impl SurucuRezervasyonu {
    fn al(busy: &'static AtomicBool) -> Result<Self, AudioError> {
        busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| AudioError::Stream("onceki surucu islemi halen bekleniyor".into()))?;
        Ok(Self(busy))
    }
}

impl Drop for SurucuRezervasyonu {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod driver_tests {
    use super::*;

    fn hata_metni<T: std::fmt::Debug>(sonuc: Result<T, AudioError>) -> String {
        sonuc.unwrap_err().to_string()
    }

    #[test]
    fn d1b_15_acilis_bekleme_sinirlidir() {
        let (tx, rx) = mpsc::channel::<()>();
        let bekleme = std::time::Instant::now();
        assert!(hata_metni(surucu_bekle(&rx, Duration::from_millis(20))).contains("zaman asimi"));
        assert!(bekleme.elapsed() < Duration::from_secs(2));
        drop(tx);
        assert!(hata_metni(surucu_bekle(&rx, Duration::from_millis(20))).contains("sonlandi"));
    }

    #[test]
    fn d1b_15_kapanis_takilan_thread_sure_sonunda_hata_verir() {
        let stop = AtomicBool::new(false);
        let (birak, bekle) = mpsc::channel::<()>();
        let mut thread = Some(std::thread::spawn(move || {
            let _ = bekle.recv();
        }));
        let sonuc = surucu_kapat(&mut thread, &stop, Duration::from_millis(20));
        assert!(hata_metni(sonuc).contains("zaman asimi"));
        assert!(stop.load(Ordering::SeqCst), "thread'e durma bildirilmedi");
        assert!(thread.is_none(), "tutamac cagirana geri kalmamali");
        birak.send(()).unwrap();
    }

    #[test]
    fn d1b_15_kapanis_biten_veya_olmayan_thread_hata_degildir() {
        let stop = AtomicBool::new(false);
        let mut thread = Some(std::thread::spawn(|| {}));
        assert!(surucu_kapat(&mut thread, &stop, Duration::from_secs(5)).is_ok());
        assert!(surucu_kapat(&mut thread, &stop, Duration::from_millis(1)).is_ok());
    }

    #[test]
    fn d1b_15_kapanis_panikleyen_thread_hata_olur() {
        let stop = AtomicBool::new(false);
        let mut thread = Some(std::thread::spawn(|| panic!("surucu coktu")));
        let sonuc = surucu_kapat(&mut thread, &stop, Duration::from_secs(5));
        assert!(hata_metni(sonuc).contains("panikledi"));
    }

    #[test]
    fn d1b_15_rezervasyon_ikinci_acilisi_reddeder_birakilinca_acar() {
        static MESGUL: AtomicBool = AtomicBool::new(false);
        let ilk = SurucuRezervasyonu::al(&MESGUL).unwrap();
        assert!(hata_metni(SurucuRezervasyonu::al(&MESGUL)).contains("halen bekleniyor"));
        drop(ilk);
        assert!(SurucuRezervasyonu::al(&MESGUL).is_ok());
    }
}
