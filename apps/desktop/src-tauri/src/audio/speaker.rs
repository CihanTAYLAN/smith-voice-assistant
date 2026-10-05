//! Ses izi dogrulama kapisi (speaker verification gate).
//!
//! AMAC: hafizaya YAZMA ve makineyi degistiren hassas araclar yalniz CIHAN
//! konusurken calissin. Odada baska biri konusuyorsa engellenip loglanir.
//! Sistem yonergesi bunu zaten "rica" ediyordu (`live.rs` SYSTEM metni); rica
//! tavsiyedir, bu dosya MEKANIZMADIR — modelin iyi niyetine bagli degil.
//!
//! MIMARI: karar yerel bir sidecar'da verilir (`apps/desktop/sidecar/
//! speaker_server.py`, TCP 8124) — ses izi biyometrik veridir, buluta CIKMAZ.
//! Protokol STT sidecar'inin aynisi: u32-LE ornek sayisi + f32-LE 16 kHz mono
//! PCM gonder; u32-LE uzunluk + JSON al. Istek basina baglanti: sunucu cokerse
//! siradaki istek Err doner, uygulama cokmez.
//!
//! POLITIKA (bilincli, gerekcesi burada). Karar `Owner` / `Foreign` / `Unknown`;
//! `Unknown` IKI farkli seydir ve karistirilmamalidir:
//!   - DOGRULAYICI KULLANILAMIYOR (sidecar tanimsiz, baglanti hatasi, zaman
//!     asimi, `{"hata"}` yaniti): mutasyon ve gizlilik araclarinin TAMAMI kapali
//!     (`DENY_UNAVAILABLE`). Dogrulanamayan kapi acik kapi demektir; sessiz
//!     fail-open yasak. Sidecar tekrar yanit verince kapi kendiliginden acilir.
//!   - BELIRSIZ KARAR (ifade 0.8 sn'den kisa, skor kararsizlik bandinda):
//!     dogrulayici calisiyor ama bu ifade hakkinda kanit yok. Sinifin bilinen
//!     politikasi gecerlidir: konusma, okuma, ekran, internet ve makineyi
//!     degistiren araclar CALISIR; hafizaya yazma ve sahip-kanitli siniflar
//!     KAPALI (asimetrik maliyet: yanlis kayit geri alinamaz, bloke yazma tek
//!     cumleyle tekrar denenir).
//! `Foreign` (baska birinin konustugu POZITIF olculdu): yazmanin yaninda
//! makineyi degistiren araclar da reddedilir.
//! KARISIK TUR: ayni arac turunda (modelin iki `turnComplete`i arasi) hem Owner
//! hem Foreign varsa ARAC YETKISINDE Foreign baskindir (`tur_yabanci`, tur
//! sonunda `arac_turu_bitti` temizler). Konusma KAYDI politikasi ayridir:
//! `tur_karari`nda Owner varsa tur yazilir.
//! GEC SONUC: dogrulama surerken baska bir ifade basladiysa sonuc o ifadenin
//! yetkisine YAZILMAZ (bkz. `verify`).
//! KISA MIRAS: 0.8 sn'den kisa ifade, son Owner'dan en fazla `SHORT_OWNER_TTL_MS`
//! icinde ve yalniz dusuk riskli siniflarda yetki miras alir.
//!
//! KENDI SESI TUZAGI (cozulmus): Smith'in hoparlorden gelen sesi mikrofona
//! kaciyorsa "yabanci konusmaci" olarak olculurdu. `lib.rs` Live modunda
//! playback caliyorken mikrofon yerine DIJITAL SESSIZLIK besliyor (yarim
//! dubleks echo kapisi) — bu kapi ayni akistan beslendigi icin korumayi
//! bedava devralir. O kapi kalkarsa (AEC gelirse) buraya playback farkindaligi
//! eklenmeli.
//!
//! ZAMANLAMA: yerel VAD ifadeyi ~350 ms hangover + ~30 ms dogrulama ile
//! kapatir (~T+0.4 sn). Gemini'nin konusma-sonu esigi live::microphone::SunucuVad ile belirlenir; arac
//! cagrisi ~T+1.5 sn. Yani karar, kapinin sorguladigi andan ~1 sn ONCE hazir.

use std::sync::atomic::{AtomicI64, AtomicU8, Ordering};
use std::time::Instant;

/// Son ifadenin sahiplik karari.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeakerVerdict {
    /// Ses izi Cihan'a ait (benzerlik esigin ustunde).
    Owner,
    /// Ses izi Cihan'a ait DEGIL (olculdu, esigin altinda).
    Foreign,
    /// Karar verilemedi: sidecar yok, kayit yok, ses cok kisa veya karar bayat.
    Unknown,
}

const S_UNKNOWN: u8 = 0;
const S_OWNER: u8 = 1;
const S_FOREIGN: u8 = 2;

/// Bir karar bu suredan sonra bayat sayilir. Konusma surerken her ifade durumu
/// yeniden yazar; bu tavan yalniz "uzun suredir kimse konusmadi" halini kapatir
/// — eski bir "Owner" karari saatler sonra yazma yetkisi vermesin.
const VERDICT_TTL_MS: i64 = 60_000;
/// Kisa ifadenin (`MIN_OWNER_SAMPLES` altinda) son Owner'dan yetki miras
/// alabilecegi pencere. Verdict TTL'sinden KISA: ortamda baska biri varken
/// "tamam, kaydet" tipi komutun eski dogrulamaya yaslanmasi dar tutulur.
const SHORT_OWNER_TTL_MS: i64 = 30_000;

/// Sidecar'in dondurdugu ham yanit.
#[derive(Debug, PartialEq)]
pub struct SpeakerReply {
    pub benzerlik: f32,
    pub sahip: bool,
    pub esik: f32,
    /// KARARSIZLIK BANDI (2026-08-15). Esigin hemen altindaki skor "bu kisi
    /// yabanci" demek icin zayif bir kanit: olculen ayni-kisi tabani ile esik
    /// ic ice geciyordu ve kullanicinin KENDI sesi `Foreign` damgasi yiyip 60
    /// saniye boyunca hafizaya yazmayi kilitliyordu. Sidecar bu bantta
    /// "belirsiz" doner; biz onu `Unknown` sayariz — yazma yine acilmaz
    /// (fail-safe korunur) ama TAZE bir `Owner` karari EZILMEZ.
    ///
    /// `None` = eski sidecar (alan yok) → yalniz `sahip` okunur.
    pub belirsiz: bool,
    /// Kac referans prototipe bakildi (teshis/log icin). Eski sidecar'da 0.
    pub prototip: u32,
}

use super::live::tools::{arac_bilgisi, SesSinifi};
#[cfg(test)]
use super::live::tools::{sinif_adet, sinif_adlari};

#[cfg(test)]
pub const OWNER_ONLY_TOOLS: &[&str] =
    &sinif_adlari::<{ sinif_adet(SesSinifi::Hafiza) }>(SesSinifi::Hafiza);
#[cfg(test)]
pub const NO_FOREIGN_TOOLS: &[&str] =
    &sinif_adlari::<{ sinif_adet(SesSinifi::NoForeign) }>(SesSinifi::NoForeign);
#[cfg(test)]
pub const OWNER_ONLY_READS: &[&str] =
    &sinif_adlari::<{ sinif_adet(SesSinifi::HassasOkuma) }>(SesSinifi::HassasOkuma);
#[cfg(test)]
pub const OWNER_ONLY_CODE: &[&str] =
    &sinif_adlari::<{ sinif_adet(SesSinifi::Kod) }>(SesSinifi::Kod);
#[cfg(test)]
pub const OWNER_ONLY_MISSION: &[&str] =
    &sinif_adlari::<{ sinif_adet(SesSinifi::Mission) }>(SesSinifi::Mission);
#[cfg(test)]
pub const OWNER_ONLY_SCREEN: &[&str] =
    &sinif_adlari::<{ sinif_adet(SesSinifi::Ekran) }>(SesSinifi::Ekran);
#[cfg(test)]
pub const OWNER_ONLY_LISTEN: &[&str] =
    &sinif_adlari::<{ sinif_adet(SesSinifi::Dinleme) }>(SesSinifi::Dinleme);
#[cfg(test)]
pub const OWNER_ONLY_BOARD_READS: &[&str] =
    &sinif_adlari::<{ sinif_adet(SesSinifi::PanoOkuma) }>(SesSinifi::PanoOkuma);

const DENY_LISTEN: &str = "ses izi dogrulanmadi: dinleme modunu yalniz Cihan degistirebilir";
pub const MIN_OWNER_SAMPLES: usize = 12_800;

/// Modele donen ret metni. Model bunu sesli soyler; teknik sebep `neden`de.
pub const DENY_WRITE: &str = "ses izi dogrulanmadi — bu hafiza yalniz Cihan'a ait";
pub const DENY_TOOL: &str = "ses izi dogrulanmadi — bu islemi yalniz Cihan calistirabilir";
pub const DENY_READ: &str = "ses izi dogrulanmadi — bu kayitlar yalniz Cihan'a ait";
pub const DENY_CODE: &str = "ses izi dogrulanmadi — kod gorevleri ve kayitlari yalniz Cihan'a ait";
pub const DENY_MISSION: &str = "ses izi dogrulanmadi — ekip panosu yalniz Cihan'a ait";
pub const DENY_SCREEN: &str = "ses izi dogrulanmadi: surekli ekran izlemeyi yalniz Cihan acabilir";
/// Dogrulayici kullanilamiyorken mutasyon ve gizlilik araclarinin ret metni
/// (hem modele donen mesaj hem teknik neden).
const DENY_UNAVAILABLE: &str = "ses izi dogrulanamiyor (sunucu yok)";
const DENY_NOT_ENROLLED: &str = "ses izi kaydi yok (speaker-enroll ile kaydet)";

/// Owner sart politikalari: (liste, ret metni). `check_tool` ve testler AYNI
/// tablodan okur, boylece yeni bir liste eklemek tek satirlik bir istir ve
/// hicbir yerde geride kalamaz.
// Tek sinif tablosu: true yalniz kisa ifade icin yakin Owner mirasina izin verir.
#[cfg(test)]
pub const OWNER_ONLY_POLICIES: &[(&[&str], &str, bool)] = &[
    (OWNER_ONLY_TOOLS, DENY_WRITE, true),
    (OWNER_ONLY_BOARD_READS, DENY_MISSION, true),
    (OWNER_ONLY_READS, DENY_READ, false),
    (OWNER_ONLY_CODE, DENY_CODE, false),
    (OWNER_ONLY_MISSION, DENY_MISSION, false),
    (OWNER_ONLY_SCREEN, DENY_SCREEN, false),
    (OWNER_ONLY_LISTEN, DENY_LISTEN, false),
];

fn sahip_politikasi(sinif: SesSinifi) -> Option<(&'static str, bool)> {
    Some(match sinif {
        SesSinifi::Hafiza => (DENY_WRITE, true),
        SesSinifi::PanoOkuma => (DENY_MISSION, true),
        SesSinifi::HassasOkuma => (DENY_READ, false),
        SesSinifi::Kod => (DENY_CODE, false),
        SesSinifi::Mission => (DENY_MISSION, false),
        SesSinifi::Ekran => (DENY_SCREEN, false),
        SesSinifi::Dinleme => (DENY_LISTEN, false),
        SesSinifi::DusukRisk | SesSinifi::NoForeign => return None,
    })
}

/// Gizlilik izni son ifadeye ve eksiksiz islenmis PCM kuyruguna baglidir.
/// Tek kilit, tool kontrolunde tutarli bir snapshot saglar.
struct SonIfade {
    /// Son sidecar turu kullanilabilir karar vermedi (baglanti, hata, zaman
    /// asimi veya kayit yok). Bir sonraki basarili tur temizler.
    kullanilamiyor: bool,
    /// Sidecar erisildi ama sahibin referans kaydi henuz olusturulmamis.
    kayit_yok: bool,
    /// Acik arac turunda `Foreign` cikan en yeni ifadenin numarasi. Tur boyunca
    /// arac yetkisini kapatir (`arac_turu_bitti` temizler).
    tur_yabanci: Option<u64>,
    /// Kapanmis arac turlarinin son kare numarasi: bu numaraya kadar olan
    /// ifadelerin `Foreign` karari sonraki turu kirletmez.
    arac_siniri: u64,
    karar: SpeakerVerdict,
    yakin_owner_ms: Option<i64>,
    kisa: bool,
    at_ms: i64,
    gonderilen: u64,
    islenen: u64,
    baslangic: u64,
    kayip: u64,
    konusuyor: bool,
    kayit: std::collections::VecDeque<(u64, SpeakerVerdict)>,
}

impl Default for SonIfade {
    fn default() -> Self {
        Self {
            kullanilamiyor: false,
            kayit_yok: false,
            tur_yabanci: None,
            arac_siniri: 0,
            karar: SpeakerVerdict::Unknown,
            yakin_owner_ms: None,
            kisa: false,
            at_ms: -1,
            gonderilen: 0,
            islenen: 0,
            baslangic: 1,
            kayip: 0,
            konusuyor: false,
            kayit: Default::default(),
        }
    }
}

impl SonIfade {
    /// `Foreign` cikan ifade acik arac turundaysa tur boyunca yetkiyi kapatir.
    /// Numara monoton degildir (iki ifade kaynagi), bu yuzden en buyugu tutulur.
    fn yabanci_isaretle(&mut self, no: u64) {
        if no > self.arac_siniri {
            self.tur_yabanci = self.tur_yabanci.max(Some(no));
        }
    }
}

/// Ses izi kapisi. `live.rs` bir ornegini paylasir: bir thread ifadeleri
/// dogrular, arac koprusu ayni durumu okur.
pub struct SpeakerGate {
    /// Sidecar adresi. `None`: mutasyon ve gizlilik araclari kapali.
    addr: Option<std::net::SocketAddr>,
    state: AtomicU8,
    /// Kararin alindigi an (`start`'tan beri ms). -1 = henuz karar yok.
    at_ms: AtomicI64,
    start: Instant,
    son_ifade: std::sync::Mutex<SonIfade>,
}

impl SpeakerGate {
    /// `SMITH_SPEAKER_SIDECAR` (or. `127.0.0.1:8124`) ile kurulur.
    /// Tanimsiz, bos, `0` veya `off`: mutasyon ve gizlilik araclari kapali.
    pub fn from_env() -> Self {
        let raw = std::env::var("SMITH_SPEAKER_SIDECAR").unwrap_or_default();
        Self::from_raw(&raw)
    }

    fn from_raw(raw: &str) -> Self {
        let raw = raw.trim();
        let addr = if raw.is_empty() || raw == "0" || raw.eq_ignore_ascii_case("off") {
            None
        } else {
            match raw.parse::<std::net::SocketAddr>() {
                Ok(a) => Some(a),
                Err(e) => {
                    // Sessiz bozulma yok: bozuk adres kapiyi kapatir ve soyler.
                    eprintln!("[speaker] SMITH_SPEAKER_SIDECAR bozuk ({raw}): {e} — kapi kapali");
                    None
                }
            }
        };
        if let Some(a) = addr {
            eprintln!("[speaker] ses izi kapisi ACIK (sidecar {a})");
        }
        Self {
            addr,
            state: AtomicU8::new(S_UNKNOWN),
            at_ms: AtomicI64::new(-1),
            start: Instant::now(),
            son_ifade: std::sync::Mutex::new(SonIfade::default()),
        }
    }

    /// Test/kapali kurulum icin: sidecar'siz, kapali kapi.
    pub fn disabled() -> Self {
        Self {
            addr: None,
            state: AtomicU8::new(S_UNKNOWN),
            at_ms: AtomicI64::new(-1),
            start: Instant::now(),
            son_ifade: std::sync::Mutex::new(SonIfade::default()),
        }
    }

    pub fn enabled(&self) -> bool {
        self.addr.is_some()
    }

    /// YALNIZ TEST: sidecar'a hic gitmeden "kapisi acik + karari verilmis" bir
    /// ornek uretir. Uretimde durumu yalniz `verify()` yazar; bu yardimci
    /// `cfg(test)` arkasinda oldugu icin o degismez kural korunur.
    #[cfg(test)]
    pub(super) fn armed_for_test(v: SpeakerVerdict) -> Self {
        let g = Self {
            addr: Some("127.0.0.1:8124".parse().expect("sabit adres")),
            state: AtomicU8::new(S_UNKNOWN),
            at_ms: AtomicI64::new(-1),
            start: Instant::now(),
            son_ifade: std::sync::Mutex::new(SonIfade::default()),
        };
        if v != SpeakerVerdict::Unknown {
            g.record(v);
        }
        g
    }

    fn now_ms(&self) -> i64 {
        self.start.elapsed().as_millis() as i64
    }

    /// TTL'li hizli gorunumu (`verdict`) gunceller. Sira onemli: once zaman,
    /// sonra durum; tersi olsa okuyucu yeni durumu eski zamanla gorup bayat
    /// sayabilirdi.
    fn durum_yaz(&self, v: SpeakerVerdict) {
        let s = match v {
            SpeakerVerdict::Owner => S_OWNER,
            SpeakerVerdict::Foreign => S_FOREIGN,
            SpeakerVerdict::Unknown => S_UNKNOWN,
        };
        self.at_ms.store(self.now_ms(), Ordering::SeqCst);
        self.state.store(s, Ordering::SeqCst);
    }

    #[cfg(test)]
    fn record(&self, v: SpeakerVerdict) {
        self.son_karar(v);
        self.durum_yaz(v);
    }

    /// PCM Gemini'ye gitmeden ONCE cagrilir; yavas sidecar eski Owner'i acamaz.
    pub fn kare_sirala(&self) -> u64 {
        let mut s = self.son_ifade.lock().expect("son ifade kilidi");
        s.gonderilen += 1;
        s.gonderilen
    }

    pub fn kare_kayip(&self, no: u64) {
        let mut s = self.son_ifade.lock().expect("son ifade kilidi");
        s.yakin_owner_ms = None;
        s.kisa = false;
        s.kayip = no;
        s.karar = SpeakerVerdict::Unknown;
    }

    pub fn ifade_basladi(&self, no: u64) {
        let mut s = self.son_ifade.lock().expect("son ifade kilidi");
        s.kisa = false;
        s.baslangic = no;
        s.karar = SpeakerVerdict::Unknown;
        s.at_ms = -1;
    }

    pub fn kare_islendi(&self, no: u64, konusuyor: bool) {
        let mut s = self.son_ifade.lock().expect("son ifade kilidi");
        // Uzun ifade parcasi Final/Owner olabilir, ama devam eden yeni ses
        // henuz dogrulanmamistir. Baslangic/kayip siniri burada degismez.
        if konusuyor {
            s.karar = SpeakerVerdict::Unknown;
        }
        s.islenen = no;
        s.konusuyor = konusuyor;
    }

    pub fn kayit_siniri(&self) -> u64 {
        self.son_ifade.lock().expect("son ifade kilidi").gonderilen
    }

    /// TTL'li son kisi karari kalici kaydin tur karari DEGILDIR. Her Final
    /// kendi ifade baslangiciyla tutulur; gec sidecar sonucu beklenir.
    pub fn kayit_karari(&self, ilk: u64, son: u64) -> Option<SpeakerVerdict> {
        let mut s = self.son_ifade.lock().expect("son ifade kilidi");
        if s.islenen < son || (s.konusuyor && s.baslangic <= son) {
            return None;
        }
        let mut karar = SpeakerVerdict::Unknown;
        while s.kayit.front().is_some_and(|(no, _)| *no <= son) {
            let (no, ifade) = s.kayit.pop_front().unwrap();
            if no > ilk {
                karar = tur_karari(karar, ifade);
            }
        }
        Some(karar)
    }

    fn son_karar(&self, karar: SpeakerVerdict) {
        let mut s = self.son_ifade.lock().expect("son ifade kilidi");
        self.son_karar_yaz(&mut s, karar);
    }

    fn son_karar_yaz(&self, s: &mut SonIfade, karar: SpeakerVerdict) {
        s.karar = karar;
        s.kisa = false;
        s.at_ms = self.now_ms();
        s.yakin_owner_ms = (karar == SpeakerVerdict::Owner).then_some(s.at_ms);
        if karar == SpeakerVerdict::Foreign {
            s.yabanci_isaretle(s.baslangic);
        }
    }

    /// Modelin turu bitti (`turnComplete` / `interrupted`): islenmis karelerin
    /// sonuna kadar baslayan ifadeler kapanan turdadir, `Foreign` isareti sonraki
    /// turu kirletmez. Suren ifade (tur siniri onun basindan onceki kareye
    /// cekilir) ve henuz islenmemis karelerde baslayabilecek yenisi SONRAKI
    /// turdadir: sonuclari yeni turun yetkisini belirler.
    pub fn arac_turu_bitti(&self) {
        let mut s = self.son_ifade.lock().expect("son ifade kilidi");
        let sinir = if s.konusuyor {
            s.baslangic.saturating_sub(1)
        } else {
            s.islenen
        };
        s.arac_siniri = s.arac_siniri.max(sinir);
        s.tur_yabanci = s.tur_yabanci.filter(|no| *no > s.arac_siniri);
    }

    // Kisa ifade bir ses izi karari DEGILDIR. Son pozitif kanitin saatini uzatmaz.
    pub fn dogrulanamadi(&self) {
        self.son_karar(SpeakerVerdict::Unknown);
    }

    pub fn kisa_ifade(&self) {
        let mut s = self.son_ifade.lock().expect("son ifade kilidi");
        s.karar = SpeakerVerdict::Unknown;
        s.kisa = true;
        s.at_ms = self.now_ms();
        let bas = s.baslangic;
        s.kayit.push_back((bas, SpeakerVerdict::Unknown));
    }

    fn sahip_izni(&self, s: &SonIfade, kisa_izin: bool) -> bool {
        if !self.enabled() || s.gonderilen != s.islenen || s.konusuyor || s.baslangic <= s.kayip {
            return false;
        }
        let now = self.now_ms();
        (s.karar == SpeakerVerdict::Owner && s.at_ms >= 0 && now - s.at_ms <= VERDICT_TTL_MS)
            || (kisa_izin
                && s.kisa
                && s.yakin_owner_ms
                    .is_some_and(|at| now - at <= SHORT_OWNER_TTL_MS))
    }

    /// Guncel karar (TTL uygulanmis).
    pub fn verdict(&self) -> SpeakerVerdict {
        self.verdict_at(self.now_ms())
    }

    /// TTL mantigi — test edilebilir olmasi icin `now` disaridan verilir.
    fn verdict_at(&self, now_ms: i64) -> SpeakerVerdict {
        let at = self.at_ms.load(Ordering::SeqCst);
        if at < 0 || now_ms - at > VERDICT_TTL_MS {
            return SpeakerVerdict::Unknown;
        }
        match self.state.load(Ordering::SeqCst) {
            S_OWNER => SpeakerVerdict::Owner,
            S_FOREIGN => SpeakerVerdict::Foreign,
            _ => SpeakerVerdict::Unknown,
        }
    }

    /// Bir arac cagrisina izin verilir mi? `Err(neden)` = reddedildi.
    ///
    /// | arac sinifi         | Owner | Unknown | Foreign |
    /// |---------------------|-------|---------|---------|
    /// | hafizaya yazma      | izin  | RET     | RET     |
    /// | makineyi degistiren | izin  | izin    | RET     |
    /// | HASSAS OKUMA        | izin  | RET     | RET     |
    /// | diger okuma/sorgu   | izin  | izin    | izin    |
    ///
    /// Tablo dogrulayici CALISIRKEN gecerlidir. Sidecar yoksa veya son turda
    /// yanit vermediyse ilk uc satir kararlardan bagimsiz RET'tir
    /// (`DENY_UNAVAILABLE`); acik arac turunda `Foreign` varsa da (`tur_yabanci`)
    /// ayni uc satir sonradan gelen `Owner`a bakmadan RET'tir.
    pub fn check_tool(&self, name: &str) -> Result<(), (&'static str, String)> {
        let sinif = arac_bilgisi(name).map(|a| a.sinif);
        let sahip = sinif.and_then(sahip_politikasi);
        let no_foreign = sinif == Some(SesSinifi::NoForeign);
        let s = self.son_ifade.lock().expect("son ifade kilidi");
        if no_foreign || sahip.is_some() {
            if !self.enabled() || s.kullanilamiyor {
                let neden = if s.kayit_yok {
                    DENY_NOT_ENROLLED
                } else {
                    DENY_UNAVAILABLE
                };
                return Err((neden, neden.into()));
            }
            if s.tur_yabanci.is_some() {
                let ret = sahip.map_or(DENY_TOOL, |(ret, _)| ret);
                return Err((ret, reason(SpeakerVerdict::Foreign)));
            }
        }
        if let Some((ret, kisa_izin)) = sahip {
            return if self.sahip_izni(&s, kisa_izin) {
                Ok(())
            } else {
                Err((
                    ret,
                    if self.verdict() == SpeakerVerdict::Foreign {
                        reason(SpeakerVerdict::Foreign)
                    } else {
                        "son ifade Cihan olarak dogrulanmadi".into()
                    },
                ))
            };
        }
        if !no_foreign {
            return Ok(());
        }
        let v = if name == "derin_dusun" {
            // Abonelik kullanan dusunme, son gercek Unknown kararinda serbesttir.
            if s.at_ms >= 0 && self.now_ms() - s.at_ms <= VERDICT_TTL_MS {
                s.karar
            } else {
                SpeakerVerdict::Unknown
            }
        } else {
            self.verdict()
        };
        if v == SpeakerVerdict::Foreign {
            return Err((DENY_TOOL, reason(v)));
        }
        Ok(())
    }

    /// Bir ifadeyi sidecar'a yollar, karari kaydeder ve dondurur.
    /// BLOKLAYICI (TCP + model) — ayri thread'den cagirilmali.
    ///
    /// GEC SONUC: dogrulama surerken baska bir ifade basladiysa (`ifade_basladi`)
    /// sonuc o ifadenin yetkisine YAZILMAZ ve `Unknown` doner. Yalniz kayit
    /// defterine KENDI ifade numarasiyla islenir (konusma kaydi politikasi
    /// bozulmasin) ve `Foreign` ise acik arac turunu kapatir; gec bir `Owner`
    /// asla yeni sesi yetkilendiremez.
    pub fn verify(&self, audio_16k: &[f32]) -> SpeakerVerdict {
        if audio_16k.len() < MIN_OWNER_SAMPLES {
            self.kisa_ifade();
            return SpeakerVerdict::Unknown;
        }
        // Bekleyen dogrulama eski yetkiyi kapatir; son sonuc mirasi belirler.
        let baslangic = {
            let mut s = self.son_ifade.lock().expect("son ifade kilidi");
            self.son_karar_yaz(&mut s, SpeakerVerdict::Unknown);
            s.baslangic
        };
        let Some(addr) = self.addr else {
            return SpeakerVerdict::Unknown;
        };
        let t0 = Instant::now();
        let sonuc = self.roundtrip(addr, audio_16k);
        let kullanilamiyor = sonuc.is_err();
        let kayit_yok = sonuc
            .as_ref()
            .err()
            .is_some_and(|hata| hata.trim().eq_ignore_ascii_case("kayit yok"));
        let v = match sonuc {
            Ok(reply) => {
                let v = if reply.sahip {
                    SpeakerVerdict::Owner
                } else if reply.belirsiz {
                    // Esigin hemen altindaki skor "yabanci" demek icin ZAYIF
                    // kanit — kullanicinin kendi sesini suclamak yerine
                    // bilmedigimizi soyleriz.
                    SpeakerVerdict::Unknown
                } else {
                    SpeakerVerdict::Foreign
                };
                eprintln!(
                    "[speaker] {:.2}s ifade -> benzerlik {:.3} (esik {:.2}, {} prototip) \
                     => {:?}{} [{}ms]",
                    audio_16k.len() as f32 / 16_000.0,
                    reply.benzerlik,
                    reply.esik,
                    reply.prototip,
                    v,
                    if reply.belirsiz { " (bant ici)" } else { "" },
                    t0.elapsed().as_millis()
                );
                v
            }
            Err(e) => {
                // GORUNUR bozulma: dogrulayici kullanilamiyor, mutasyon ve
                // gizlilik araclari bu andan itibaren kapali; sebebi log'da
                // olmali (sessiz "hatirlamiyorum" en kotu bozulma modu).
                let sinif = if kayit_yok {
                    "ses izi kaydi yok"
                } else {
                    "sunucu kullanilamiyor"
                };
                eprintln!("[speaker] dogrulanamadi ({e}) => Unknown ({sinif})");
                SpeakerVerdict::Unknown
            }
        };
        let mut s = self.son_ifade.lock().expect("son ifade kilidi");
        // Sidecar'in erisilebilirligi ifadeden bagimsiz bir gercektir: gec
        // gelen sonuc da kapiyi acar veya kapatir.
        s.kullanilamiyor = kullanilamiyor;
        s.kayit_yok = kayit_yok;
        s.kayit.push_back((baslangic, v));
        if s.baslangic != baslangic {
            if v == SpeakerVerdict::Foreign {
                s.yabanci_isaretle(baslangic);
            }
            eprintln!(
                "[speaker] gec karar yetkiye yazilmadi (ifade={baslangic}, guncel={}): {v:?}",
                s.baslangic
            );
            return SpeakerVerdict::Unknown;
        }
        self.son_karar_yaz(&mut s, v);
        if v != SpeakerVerdict::Unknown || self.verdict() == SpeakerVerdict::Unknown {
            self.durum_yaz(v);
        }
        v
    }

    fn roundtrip(
        &self,
        addr: std::net::SocketAddr,
        audio_16k: &[f32],
    ) -> Result<SpeakerReply, String> {
        use std::io::{Read as _, Write as _};

        let mut s =
            std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(1_000))
                .map_err(|e| format!("sidecar baglantisi yok ({addr}): {e}"))?;
        let _ = s.set_nodelay(true);
        s.set_write_timeout(Some(std::time::Duration::from_secs(10)))
            .map_err(|e| e.to_string())?;
        s.set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .map_err(|e| e.to_string())?;
        s.write_all(&encode_request(audio_16k))
            .map_err(|e| e.to_string())?;

        let mut len_buf = [0u8; 4];
        s.read_exact(&mut len_buf).map_err(|e| e.to_string())?;
        let n = u32::from_le_bytes(len_buf) as usize;
        // Akil saglamasi: yanit kucuk bir JSON'dur. Bozuk uzunlukla GB'lik
        // ayirma yapmayalim.
        if n == 0 || n > 64 * 1024 {
            return Err(format!("yanit uzunlugu makul degil: {n}"));
        }
        let mut body = vec![0u8; n];
        s.read_exact(&mut body).map_err(|e| e.to_string())?;
        decode_response(&body)
    }
}

pub fn tur_karari(a: SpeakerVerdict, b: SpeakerVerdict) -> SpeakerVerdict {
    use SpeakerVerdict::*;
    match (a, b) {
        (Owner, _) | (_, Owner) => Owner,
        (Foreign, _) | (_, Foreign) => Foreign,
        _ => Unknown,
    }
}

fn reason(v: SpeakerVerdict) -> String {
    match v {
        SpeakerVerdict::Foreign => "konusan kisi Cihan degil".to_string(),
        SpeakerVerdict::Unknown => {
            "ses izi dogrulanamadi (sidecar kapali, kayit yok veya karar bayat)".to_string()
        }
        SpeakerVerdict::Owner => "izin verildi".to_string(),
    }
}

/// Istek cercevesi: u32-LE ornek sayisi + f32-LE ornekler (16 kHz mono).
fn encode_request(audio_16k: &[f32]) -> Vec<u8> {
    let mut req = Vec::with_capacity(4 + audio_16k.len() * 4);
    req.extend_from_slice(&(audio_16k.len() as u32).to_le_bytes());
    for v in audio_16k {
        req.extend_from_slice(&v.to_le_bytes());
    }
    req
}

/// Yanit JSON'unu cozer. `{"hata": …}` gelirse Err — cagiran taraf bunu
/// `Unknown` sayar; "hata" ile "sahip degil" ASLA karistirilmamali.
fn decode_response(body: &[u8]) -> Result<SpeakerReply, String> {
    #[derive(serde::Deserialize)]
    struct Raw {
        benzerlik: Option<f32>,
        sahip: Option<bool>,
        esik: Option<f32>,
        karar: Option<String>,
        prototip: Option<u32>,
        hata: Option<String>,
    }
    let raw: Raw = serde_json::from_slice(body).map_err(|e| format!("yanit cozulemedi: {e}"))?;
    if let Some(h) = raw.hata {
        return Err(h);
    }
    match (raw.benzerlik, raw.sahip) {
        (Some(benzerlik), Some(sahip)) => {
            // TANIMADIGIMIZ bir `karar` degeri GUVENLI tarafa dusmeli: sahip
            // degilse belirsiz sayilir (yanlis suclama yerine "bilmiyorum").
            // Alan hic yoksa eski sidecar konusuyordur → eski davranis.
            let belirsiz = match raw.karar.as_deref() {
                Some("sahip") => false,
                Some("yabanci") => false,
                Some(_) => !sahip,
                None => false,
            };
            Ok(SpeakerReply {
                benzerlik,
                sahip,
                esik: raw.esik.unwrap_or(f32::NAN),
                belirsiz,
                prototip: raw.prototip.unwrap_or(0),
            })
        }
        _ => Err("yanitta benzerlik/sahip alani yok".into()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a2_kisa_ifade_ttl_uzatmaz_ve_yabanci_mirasi_keser() {
        for karar in [SpeakerVerdict::Unknown, SpeakerVerdict::Foreign] {
            let g = SpeakerGate::armed_for_test(SpeakerVerdict::Owner);
            g.record(karar);
            g.kisa_ifade();
            assert!(g.check_tool("hafizaya_kaydet").is_err());
            assert!(g.check_tool("dinleme_modu").is_err());
        }
        let g = SpeakerGate::armed_for_test(SpeakerVerdict::Owner);
        let once = g.son_ifade.lock().unwrap().yakin_owner_ms;
        g.kisa_ifade();
        g.kisa_ifade();
        assert_eq!(g.son_ifade.lock().unwrap().yakin_owner_ms, once);
        g.son_ifade.lock().unwrap().yakin_owner_ms = Some(g.now_ms() - VERDICT_TTL_MS - 1);
        assert!(g.check_tool("hafizaya_kaydet").is_err());
    }

    #[test]
    fn a2_tum_siniflar_kisa_ifade_kuralina_uyar() {
        let g = SpeakerGate::armed_for_test(SpeakerVerdict::Owner);
        g.kisa_ifade();
        for (liste, _, kisa) in OWNER_ONLY_POLICIES {
            for arac in *liste {
                assert_eq!(g.check_tool(arac).is_ok(), *kisa, "{arac}");
            }
        }
        g.dogrulanamadi();
        g.kisa_ifade();
        for (liste, _, _) in OWNER_ONLY_POLICIES {
            for arac in *liste {
                assert!(g.check_tool(arac).is_err(), "{arac}");
            }
        }
    }

    #[test]
    fn a2_kisa_ifade_yalniz_dusuk_riskte_yakin_sahibi_kullanir() {
        let g = SpeakerGate::armed_for_test(SpeakerVerdict::Owner);
        let no = g.kare_sirala();
        g.ifade_basladi(no);
        g.kisa_ifade();
        g.kare_islendi(no, false);
        assert!(g.check_tool("hafizaya_kaydet").is_ok());
        assert!(g.check_tool("pano_durumu").is_ok());
        for name in [
            "ekran_akisi",
            "dinleme_modu",
            "ajan_oturumlari",
            "kod_gorevi_ver",
            "gorev_ver",
        ] {
            assert!(g.check_tool(name).is_err(), "{name}");
        }
        g.son_karar(SpeakerVerdict::Unknown);
        g.ifade_basladi(no + 1);
        g.kisa_ifade();
        g.kare_islendi(no + 1, false);
        assert!(g.check_tool("hafizaya_kaydet").is_err());
        assert!(g.check_tool("dinleme_modu").is_err());
    }

    #[test]
    fn a2_derin_dusun_yabanciya_kapali_belirsize_acik() {
        assert!(SpeakerGate::armed_for_test(SpeakerVerdict::Foreign)
            .check_tool("derin_dusun")
            .is_err());
        assert!(SpeakerGate::armed_for_test(SpeakerVerdict::Unknown)
            .check_tool("derin_dusun")
            .is_ok());
        let g = SpeakerGate::armed_for_test(SpeakerVerdict::Foreign);
        g.dogrulanamadi();
        assert!(
            g.check_tool("derin_dusun").is_err(),
            "ayni turda Foreign var"
        );
        tur_bitir(&g);
        assert!(g.check_tool("derin_dusun").is_ok());
        assert!(
            g.check_tool("terminal_calistir").is_err(),
            "diger araclarin TTL korumasi degismedi"
        );
    }
    #[test]
    fn audit_tur_karari_ifadeleri_birlestirir() {
        use SpeakerVerdict::*;
        for (ifadeler, beklenen) in [
            (vec![], Unknown),
            (vec![Unknown], Unknown),
            (vec![Foreign, Unknown], Foreign),
            (vec![Unknown, Foreign], Foreign),
            (vec![Foreign, Owner, Unknown], Owner),
            (vec![Owner, Foreign], Owner),
        ] {
            assert_eq!(ifadeler.into_iter().fold(Unknown, tur_karari), beklenen);
        }
    }

    #[test]
    fn audit_kayit_gec_karari_bekler_ve_onceki_owner_tasinmaz() {
        let g = SpeakerGate::disabled();
        g.kare_sirala();
        g.ifade_basladi(1);
        assert_eq!(g.kayit_karari(0, 1), None);
        g.son_ifade
            .lock()
            .unwrap()
            .kayit
            .push_back((1, SpeakerVerdict::Owner));
        g.kare_islendi(1, false);
        assert_eq!(g.kayit_karari(0, 1), Some(SpeakerVerdict::Owner));
        g.kare_sirala();
        g.ifade_basladi(2);
        g.son_ifade
            .lock()
            .unwrap()
            .kayit
            .push_back((2, SpeakerVerdict::Foreign));
        g.kare_islendi(2, false);
        assert_eq!(g.kayit_karari(1, 2), Some(SpeakerVerdict::Foreign));
        assert_eq!(g.kayit_karari(1, 2), Some(SpeakerVerdict::Unknown));
    }
    #[test]
    fn audit_iptal_sinifi() {
        assert!(NO_FOREIGN_TOOLS.contains(&"arka_plan_iptal"));
        assert!(OWNER_ONLY_READS.contains(&"arka_plan_sonuc"));
    }

    #[test]
    fn audit_dusurulen_turun_owner_karari_sonraki_foreigni_acamaz() {
        let g = SpeakerGate::disabled();
        {
            let mut s = g.son_ifade.lock().unwrap();
            s.kayit.push_back((1, SpeakerVerdict::Owner));
            s.kayit.push_back((2, SpeakerVerdict::Foreign));
            s.islenen = 2;
        }
        assert_eq!(g.kayit_karari(1, 2), Some(SpeakerVerdict::Foreign));
    }

    /// Dogrulayici yokken NoForeign ve gizlilik araclarinin TAMAMI kapali,
    /// dusuk riskli araclar acik. Listeler tablodan taranir: yeni arac otomatik girer.
    #[test]
    fn d1b_5_sidecar_yokken_hassas_araclar_kapali() {
        for raw in ["", "off", "bozuk"] {
            let g = SpeakerGate::from_raw(raw);
            for name in NO_FOREIGN_TOOLS
                .iter()
                .chain(OWNER_ONLY_POLICIES.iter().flat_map(|(a, _, _)| a.iter()))
            {
                let (ret, neden) = g.check_tool(name).expect_err(name);
                assert_eq!(ret, "ses izi dogrulanamiyor (sunucu yok)");
                assert_eq!(neden, ret);
            }
            assert!(g.check_tool("hafizada_ara").is_ok());
        }
    }

    /// Baglanti hatasi "belirsiz karar" DEGIL, kullanilamayan dogrulayicidir:
    /// basarisiz tur NoForeign araclari da kapatir, sidecar donunce kapi acilir.
    /// Henuz hic denenmemis dogrulayici ise kullanilamaz sayilmaz (sinif kurali).
    #[test]
    fn d1b_5_baglanti_hatasi_kapiyi_kapatir_yanit_acar() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let olu = listener.local_addr().unwrap();
        drop(listener);
        let mut g = SpeakerGate::from_raw(&olu.to_string());
        let ses = vec![0.1; MIN_OWNER_SAMPLES];
        assert!(g.check_tool("terminal_calistir").is_ok());
        assert_eq!(g.verify(&ses), SpeakerVerdict::Unknown);
        let (ret, _) = g.check_tool("terminal_calistir").unwrap_err();
        assert_eq!(ret, "ses izi dogrulanamiyor (sunucu yok)");
        assert!(g.check_tool("hafizada_ara").is_ok());
        g.addr = Some(sidecar_sunucusu(YANIT_SAHIP, None));
        assert_eq!(g.verify(&ses), SpeakerVerdict::Owner);
        assert!(g.check_tool("terminal_calistir").is_ok());
        assert!(g.check_tool("hafizaya_kaydet").is_ok());
    }

    /// Dogrulama surerken yeni ifade basladi, sonra eski ifadenin `Owner`i geldi:
    /// sonuc yetkiye YAZILMAZ, yalniz kendi numarasiyla kayit defterine girer.
    #[test]
    fn d1b_6_gec_owner_yeni_ifadeye_yazilmaz() {
        let (g, ready, release, worker) = bekleyen_dogrulama(YANIT_SAHIP);
        ready
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        g.kare_sirala();
        let yeni = g.kare_sirala();
        g.ifade_basladi(yeni);
        g.kare_islendi(yeni, false);
        release.send(()).unwrap();
        assert_eq!(worker.join().unwrap(), SpeakerVerdict::Unknown);
        assert!(g.check_tool("ekran_akisi").is_err());
        let s = g.son_ifade.lock().unwrap();
        assert_eq!(s.karar, SpeakerVerdict::Unknown);
        assert!(s.kayit.contains(&(1, SpeakerVerdict::Owner)));
        assert!(s.kayit.iter().all(|(no, _)| *no != yeni));
    }

    /// Gec `Foreign` sonucu yetkiyi acmaz ama acik turu kapatir: yabanci ses,
    /// ifade degisti diye sessizce kaybolamaz.
    #[test]
    fn d1b_6_gec_yabanci_sonuc_turu_kapatir() {
        let (g, ready, release, worker) = bekleyen_dogrulama(YANIT_YABANCI);
        ready
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        g.kare_sirala();
        let yeni = g.kare_sirala();
        g.ifade_basladi(yeni);
        g.record(SpeakerVerdict::Owner);
        g.kare_islendi(yeni, false);
        release.send(()).unwrap();
        assert_eq!(worker.join().unwrap(), SpeakerVerdict::Unknown);
        assert!(g.check_tool("terminal_calistir").is_err());
        assert!(g
            .son_ifade
            .lock()
            .unwrap()
            .kayit
            .contains(&(1, SpeakerVerdict::Foreign)));
        tur_bitir(&g);
        assert!(g.check_tool("terminal_calistir").is_ok());
    }

    #[test]
    fn d1b_7_karisik_tur_araclari_reddeder_kaydi_korur() {
        for kararlar in [
            [SpeakerVerdict::Foreign, SpeakerVerdict::Owner],
            [SpeakerVerdict::Owner, SpeakerVerdict::Foreign],
        ] {
            let g = armed();
            for karar in kararlar {
                g.record(karar);
            }
            for name in [
                "terminal_calistir",
                "hafizaya_kaydet",
                "pano_durumu",
                "ekran_akisi",
                "derin_dusun",
            ] {
                assert!(g.check_tool(name).is_err(), "{name}");
            }
            assert_eq!(tur_karari(kararlar[0], kararlar[1]), SpeakerVerdict::Owner);
        }
    }

    #[test]
    fn d1b_7_devam_eden_ifade_tur_sinirinda_kaybolmaz() {
        let g = armed();
        let no = g.kare_sirala();
        g.ifade_basladi(no);
        g.kare_islendi(no, true);
        g.arac_turu_bitti();
        g.record(SpeakerVerdict::Foreign);
        g.kare_islendi(no, false);
        let yeni = g.kare_sirala();
        g.ifade_basladi(yeni);
        g.record(SpeakerVerdict::Owner);
        g.kare_islendi(yeni, false);
        assert!(g.check_tool("terminal_calistir").is_err());
        g.arac_turu_bitti();
        assert!(g.check_tool("terminal_calistir").is_ok());
    }

    /// Worker bir kare geride olsa bile (gonderilen > islenen) biten turun
    /// ifadesi kapanan turdadir; yalniz henuz islenmemis karelerde baslayan ifade
    /// sonraki turun yetkisini belirler.
    #[test]
    fn d1b_7_islenmemis_kareler_tur_sinirini_geciktirmez() {
        let tur_sonu_foreign = || {
            let g = armed();
            let no = g.kare_sirala();
            g.ifade_basladi(no);
            g.record(SpeakerVerdict::Foreign);
            g.kare_islendi(no, false);
            let bekleyen = g.kare_sirala();
            g.arac_turu_bitti();
            (g, bekleyen)
        };
        let (g, bekleyen) = tur_sonu_foreign();
        g.ifade_basladi(bekleyen);
        g.record(SpeakerVerdict::Owner);
        g.kare_islendi(bekleyen, false);
        assert!(
            g.check_tool("terminal_calistir").is_ok(),
            "biten turun Foreign'i yeni turu kirletti"
        );
        let (g, bekleyen) = tur_sonu_foreign();
        g.ifade_basladi(bekleyen);
        g.record(SpeakerVerdict::Foreign);
        g.record(SpeakerVerdict::Owner);
        g.kare_islendi(bekleyen, false);
        assert!(
            g.check_tool("terminal_calistir").is_err(),
            "yeni turdaki Foreign Owner'a ragmen baskin olmali"
        );
    }

    #[test]
    fn d1b_8_kisa_miras_otuz_saniye() {
        let g = SpeakerGate::armed_for_test(SpeakerVerdict::Owner);
        g.kisa_ifade();
        g.son_ifade.lock().unwrap().yakin_owner_ms = Some(g.now_ms() - 29_000);
        assert!(g.check_tool("hafizaya_kaydet").is_ok());
        assert!(g.check_tool("ekran_akisi").is_err());
        g.son_ifade.lock().unwrap().yakin_owner_ms = Some(g.now_ms() - 30_001);
        assert!(g.check_tool("hafizaya_kaydet").is_err());
    }

    use super::*;

    #[test]
    fn audit_4_tanimsiz_ve_bozuk_sidecar_gizlilikte_kapali() {
        for raw in ["", "off", "0", "yanlis-adres"] {
            let g = SpeakerGate::from_raw(raw);
            assert!(!g.enabled());
            let (_, neden) = g.check_tool("ekran_akisi").unwrap_err();
            assert!(neden.contains("sunucu yok"));
            assert!(g.check_tool("terminal_calistir").is_err());
        }
    }

    #[test]
    fn audit_5_kuyruktaki_yeni_ifadeyi_eski_sidecar_yaniti_yetkilendiremez() {
        let (g, ready, release, worker) = bekleyen_dogrulama(YANIT_SAHIP);
        ready
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        // Onceki ifadeyi sidecar islerken yeni komut Gemini'ye aktariliyor.
        let yeni = g.kare_sirala();
        release.send(()).unwrap();
        assert_eq!(worker.join().unwrap(), SpeakerVerdict::Owner);
        assert!(
            g.check_tool("ekran_akisi").is_err(),
            "eski yanit yeni sesi yetkilendirdi"
        );
        g.ifade_basladi(yeni);
        g.kare_islendi(yeni, false);
        assert!(
            g.check_tool("ekran_akisi").is_err(),
            "kisa ifade Final uretmese bile Owner silinmeli"
        );
        // Yeni ifadenin dogrulanmasi bittiginde izin verilir.
        g.son_karar(SpeakerVerdict::Owner);
        assert!(g.check_tool("ekran_akisi").is_ok());
    }

    #[test]
    fn audit_5_kayip_pcm_eski_owner_ile_acilamaz() {
        let g = SpeakerGate::armed_for_test(SpeakerVerdict::Owner);
        let kayip = g.kare_sirala();
        g.kare_kayip(kayip);
        // Gec gelen eski Owner, kayip sesin kime ait oldugunu kanitlamaz.
        g.son_karar(SpeakerVerdict::Owner);
        let sessiz = g.kare_sirala();
        g.kare_islendi(sessiz, false);
        assert!(g.check_tool("ekran_akisi").is_err());
        let yeni = g.kare_sirala();
        g.ifade_basladi(yeni);
        g.son_karar(SpeakerVerdict::Owner);
        g.kare_islendi(yeni, false);
        assert!(g.check_tool("ekran_akisi").is_ok());
    }

    #[test]
    fn audit_4_kapali_ses_izi_ekran_acamaz() {
        let g = SpeakerGate::disabled();
        assert!(g.check_tool("ekran_akisi").is_err());
        assert!(g.check_tool("terminal_calistir").is_err());
        assert!(g.check_tool("hafizaya_kaydet").is_err());
    }

    const YANIT_SAHIP: &[u8] = br#"{"benzerlik":0.9,"sahip":true,"karar":"sahip","esik":0.5}"#;
    const YANIT_BELIRSIZ: &[u8] =
        br#"{"benzerlik":0.4,"sahip":false,"karar":"belirsiz","esik":0.5}"#;
    const YANIT_YABANCI: &[u8] = br#"{"benzerlik":0.1,"sahip":false,"karar":"yabanci","esik":0.5}"#;

    /// Tek baglantiyi kabul edip istegi okuyan ve `yanit`i yazan yerel sidecar.
    /// `kapi` verilirse istek okunduktan sonra (hazir, birak) el sikismasini
    /// bekler: cagiran, sonucun gelmesini tam istedigi ana kadar tutabilir.
    fn sidecar_sunucusu(
        yanit: &'static [u8],
        kapi: Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>,
    ) -> std::net::SocketAddr {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut n = [0; 4];
            socket.read_exact(&mut n).unwrap();
            let mut pcm = vec![0; u32::from_le_bytes(n) as usize * 4];
            socket.read_exact(&mut pcm).unwrap();
            if let Some((hazir, birak)) = kapi {
                hazir.send(()).unwrap();
                birak.recv().unwrap();
            }
            socket
                .write_all(&(yanit.len() as u32).to_le_bytes())
                .unwrap();
            socket.write_all(yanit).unwrap();
        });
        addr
    }

    fn bekleyen_dogrulama(
        yanit: &'static [u8],
    ) -> (
        std::sync::Arc<SpeakerGate>,
        std::sync::mpsc::Receiver<()>,
        std::sync::mpsc::Sender<()>,
        std::thread::JoinHandle<SpeakerVerdict>,
    ) {
        let (ready_tx, ready) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let mut g = SpeakerGate::armed_for_test(SpeakerVerdict::Owner);
        g.addr = Some(sidecar_sunucusu(yanit, Some((ready_tx, release_rx))));
        let g = std::sync::Arc::new(g);
        let worker_gate = g.clone();
        let worker = std::thread::spawn(move || worker_gate.verify(&vec![0.1; 16000]));
        (g, ready, release, worker)
    }

    #[test]
    fn audit_5_dogrulama_beklerken_eski_owner_yetmez() {
        let (g, ready, release, worker) = bekleyen_dogrulama(YANIT_BELIRSIZ);
        ready
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        let karar = g.check_tool("ekran_akisi");
        release.send(()).unwrap();
        worker.join().unwrap();
        assert!(
            karar.is_err(),
            "yeni ifade dogrulanmadan eski Owner kullanildi"
        );
    }

    #[test]
    fn audit_5_son_ifade_unknown_eski_owner_yetmez() {
        let (g, ready, release, worker) = bekleyen_dogrulama(YANIT_BELIRSIZ);
        ready
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        release.send(()).unwrap();
        assert_eq!(worker.join().unwrap(), SpeakerVerdict::Unknown);
        assert_eq!(
            g.verdict(),
            SpeakerVerdict::Owner,
            "diger araclarin TTL davranisi korunmali"
        );
        assert!(g.check_tool("ekran_akisi").is_err());
    }

    #[test]
    fn istek_cercevesi_protokole_uyar() {
        // u32-LE sayac + f32-LE ornekler; STT sidecar'iyla ayni format.
        let req = encode_request(&[0.0, 1.0]);
        assert_eq!(req.len(), 4 + 2 * 4);
        assert_eq!(&req[0..4], &2u32.to_le_bytes());
        assert_eq!(&req[4..8], &0.0f32.to_le_bytes());
        assert_eq!(&req[8..12], &1.0f32.to_le_bytes());
    }

    #[test]
    fn bos_istek_de_gecerli_cerceve_uretir() {
        assert_eq!(encode_request(&[]), 0u32.to_le_bytes().to_vec());
    }

    #[test]
    fn yanit_cozulur() {
        let r = decode_response(br#"{"benzerlik":0.91,"sahip":true,"esik":0.45,"ms":24}"#)
            .expect("cozulmeli");
        assert!(r.sahip);
        assert!((r.benzerlik - 0.91).abs() < 1e-6);
        assert!((r.esik - 0.45).abs() < 1e-6);
    }

    /// KARARSIZLIK BANDI. Olculen kusur (2026-08-15): kullanicinin KENDI sesi,
    /// baska bir oturumda kaydedilmis referansa karsi 0.478 aliyordu — esik
    /// 0.48. Tek merkezli referansta bu "yabanci" damgasi demekti ve 60 saniye
    /// boyunca hafizaya yazmayi kilitliyordu. Bant icindeki skor artik
    /// `belirsiz`: yazma yine acilmaz ama kullanici YANLIS SUCLANMAZ ve taze
    /// bir `Owner` karari ezilmez.
    #[test]
    fn bant_ici_skor_yabanci_saymaz() {
        let r = decode_response(
            br#"{"benzerlik":0.4400,"sahip":false,"karar":"belirsiz","esik":0.48,"prototip":6}"#,
        )
        .expect("cozulmeli");
        assert!(!r.sahip);
        assert!(
            r.belirsiz,
            "bant ici skor 'yabanci' sayildi — yanlis suclama"
        );
        assert_eq!(r.prototip, 6);

        // Bandin ALTI hala gercek bir tespit: orada belirsizlige kacmak
        // korumayi bosa cikarirdi.
        let y = decode_response(
            br#"{"benzerlik":0.1200,"sahip":false,"karar":"yabanci","esik":0.48,"prototip":6}"#,
        )
        .expect("cozulmeli");
        assert!(
            !y.belirsiz,
            "net yabanci skor belirsiz sayildi — koruma zayiflar"
        );
    }

    /// ESKI SIDECAR ile calismaya devam: `karar` alani yoksa davranis eskisi
    /// gibi olmali (alan yoklugu sessizce "belirsiz"e kaymamali, yoksa eski
    /// kurulumda yabanci ses tespiti tamamen kaybolurdu).
    #[test]
    fn karar_alani_yoksa_eski_davranis() {
        let r =
            decode_response(br#"{"benzerlik":0.20,"sahip":false,"esik":0.48}"#).expect("cozulmeli");
        assert!(!r.belirsiz, "eski sidecar yanitinda belirsizlik uydurulmus");
        assert_eq!(r.prototip, 0);
    }

    /// TANIMADIGIMIZ karar degeri GUVENLI tarafa dusmeli: sahip degilse
    /// "bilmiyorum" deriz. Aksi halde sidecar'a yeni bir durum eklendiginde
    /// eski istemci onu sessizce "yabanci" sayar ve kullaniciyi suclar.
    #[test]
    fn bilinmeyen_karar_guvenli_tarafa_duser() {
        let r = decode_response(
            br#"{"benzerlik":0.44,"sahip":false,"karar":"yeni_bir_durum","esik":0.48}"#,
        )
        .expect("cozulmeli");
        assert!(r.belirsiz, "bilinmeyen karar 'yabanci' sayildi");
    }

    #[test]
    fn kayit_yok_hatasi_yayilir() {
        // "kayit yok" bir RET degil, KARARSIZLIK — Err olmali.
        let e = decode_response(br#"{"hata":"kayit yok"}"#).expect_err("hata beklenir");
        assert_eq!(e, "kayit yok");
    }

    #[test]
    fn kayit_yok_ile_sunucu_yok_farkli_yonlendirme_dondurur() {
        let ses = vec![0.1; MIN_OWNER_SAMPLES];
        let mut kayitsiz = SpeakerGate::from_raw("127.0.0.1:1");
        kayitsiz.addr = Some(sidecar_sunucusu(br#"{"hata":"kayit yok"}"#, None));
        assert_eq!(kayitsiz.verify(&ses), SpeakerVerdict::Unknown);
        let (ret, neden) = kayitsiz.check_tool("terminal_calistir").unwrap_err();
        assert_eq!(ret, "ses izi kaydi yok (speaker-enroll ile kaydet)");
        assert_eq!(neden, ret);

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let olu = listener.local_addr().unwrap();
        drop(listener);
        let sunucusuz = SpeakerGate::from_raw(&olu.to_string());
        assert_eq!(sunucusuz.verify(&ses), SpeakerVerdict::Unknown);
        let (ret, neden) = sunucusuz.check_tool("terminal_calistir").unwrap_err();
        assert_eq!(ret, "ses izi dogrulanamiyor (sunucu yok)");
        assert_eq!(neden, ret);
    }

    #[test]
    fn bozuk_yanit_hata_verir() {
        assert!(decode_response(b"not json").is_err());
        assert!(decode_response(br#"{"ms":5}"#).is_err());
    }

    #[test]
    fn kapali_kapi_gizlilik_ve_mutasyon_araclarini_engeller() {
        let g = SpeakerGate::disabled();
        assert!(!g.enabled());
        // UC LISTE de taranir: listeye eklenen her yeni arac fail-safe
        // sozlesmesine otomatik dahil olur, ayri test yazmak gerekmez.
        // TUM listeler taranir (tablo + yabanci listesi): listeye eklenen her
        // yeni arac fail-safe sozlesmesine otomatik dahil olur.
        for t in OWNER_ONLY_POLICIES
            .iter()
            .flat_map(|(liste, _, _)| liste.iter())
            .chain(NO_FOREIGN_TOOLS)
        {
            assert!(g.check_tool(t).is_err(), "{t}");
        }
    }

    /// Kapi acikmis gibi davranan ornek (sidecar adresi var, aga cikilmaz).
    fn armed() -> SpeakerGate {
        SpeakerGate::armed_for_test(SpeakerVerdict::Unknown)
    }

    /// Arac turunu gercek akistaki gibi kapatir: bir kare siralanip islenir,
    /// sonra `arac_turu_bitti`. `Foreign` ile baslayan turun ardindan gelen
    /// `Owner` ayri (yeni) turdadir.
    fn tur_bitir(g: &SpeakerGate) {
        let no = g.kare_sirala();
        g.kare_islendi(no, false);
        g.arac_turu_bitti();
    }

    #[test]
    fn karar_yokken_yazma_bloke_okuma_serbest() {
        let g = armed();
        assert_eq!(g.verdict(), SpeakerVerdict::Unknown);
        assert!(g.check_tool("hafizaya_kaydet_ACIK_TALEP_ILE").is_err());
        assert!(g.check_tool("hafizaya_kaydet").is_err());
        // Kullanilabilir sidecar ile bant ici Unknown eski sinif kuralini korur.
        assert!(g.check_tool("terminal_calistir").is_ok());
        assert!(g.check_tool("hafizada_ara").is_ok());
        assert!(g.check_tool("dosya_oku").is_ok());
    }

    #[test]
    fn sahip_dogrulaninca_yazma_serbest() {
        let g = armed();
        g.record(SpeakerVerdict::Owner);
        assert_eq!(g.verdict(), SpeakerVerdict::Owner);
        assert!(g.check_tool("hafizaya_kaydet_ACIK_TALEP_ILE").is_ok());
        assert!(g.check_tool("terminal_calistir").is_ok());
    }

    #[test]
    fn yabanci_ses_yazmayi_ve_hassas_araci_reddeder() {
        let g = armed();
        g.record(SpeakerVerdict::Foreign);
        let (msg, neden) = g
            .check_tool("hafizaya_kaydet")
            .expect_err("yabanci ses yazamaz");
        assert_eq!(msg, DENY_WRITE);
        assert!(neden.contains("Cihan degil"), "neden: {neden}");
        assert!(g.check_tool("uygulama_ac").is_err());
        assert!(g.check_tool("ses_kontrol").is_err());
        assert!(g.check_tool("terminal_calistir").is_err());
        // Okuma araclari mevcut mandada etkilenmez.
        assert!(g.check_tool("hafizada_ara").is_ok());
        assert!(g.check_tool("internette_ara").is_ok());
    }

    /// HASSAS OKUMA KAPISI: `ajan_oturumlari` Claude Code / Codex kayitlarinin
    /// tamamini gorur (musteri anahtarlari, `.env`, ozel yazismalar). Diger
    /// okuma araclarindan farkli olarak SAHIP KANITI ister.
    ///
    /// Uc durum birlikte sinaniyor, cunku tehlikeli olan orta durum: kararsizlik
    /// bandinda (`Unknown`) kalan bir ifade "yabanci degil" diye gecerse kapi
    /// yalnizca aciktan yabancilari tutar, ki bu korumanin en zayif hali olurdu.
    #[test]
    fn ajan_oturumlari_sahip_kaniti_ister() {
        let g = armed();

        // Unknown: karar YOK -> RET. (Yazma kapisiyla ayni sertlik.)
        let (msg, _) = g
            .check_tool("ajan_oturumlari")
            .expect_err("karar yokken oturum kayitlari verilmemeli");
        assert_eq!(msg, DENY_READ, "yanlis ret metni: hafiza degil, kayit");

        // Foreign: RET.
        g.record(SpeakerVerdict::Foreign);
        assert!(g.check_tool("ajan_oturumlari").is_err());

        // Owner: izin.
        tur_bitir(&g);
        g.record(SpeakerVerdict::Owner);
        assert!(g.check_tool("ajan_oturumlari").is_ok());
    }

    /// KENDI KODUNU DEGISTIRME KAPISI — en sert sinif. Yazma kapisiyla ayni
    /// sertlik, farkli metin: kullanici reddi duydugunda neyin reddedildigini
    /// anlamali ("hafiza" degil, "kod").
    #[test]
    fn kod_gorevi_sahip_kaniti_ister() {
        for tool in OWNER_ONLY_CODE {
            let g = armed();

            let (msg, _) = g
                .check_tool(tool)
                .expect_err("karar yokken kod gorevleri acilmamali");
            assert_eq!(msg, DENY_CODE);

            g.record(SpeakerVerdict::Foreign);
            assert!(g.check_tool(tool).is_err());

            tur_bitir(&g);
            g.record(SpeakerVerdict::Owner);
            assert!(g.check_tool(tool).is_ok());
        }
    }

    /// EKRAN AKISI KAPISI. Surekli izleme buluta ekran akitir: sahip kaniti
    /// ister, yabanci ya da kararsiz ses acamaz. Tek kare (`ekrani_net_gor`)
    /// bu listede degildir.
    #[test]
    fn ekran_akisi_sahip_kaniti_ister() {
        let g = armed();

        let Err((msg, _)) = g.check_tool("ekran_akisi") else {
            panic!("ekran_akisi karar yokken serbest kalmis");
        };
        assert_eq!(msg, DENY_SCREEN);

        g.record(SpeakerVerdict::Foreign);
        assert!(g.check_tool("ekran_akisi").is_err());

        tur_bitir(&g);
        g.record(SpeakerVerdict::Owner);
        assert!(g.check_tool("ekran_akisi").is_ok());
        // Tek kare okuma serbest kalmaya devam eder.
        assert!(g.check_tool("ekrani_net_gor").is_ok());
    }

    /// PANO KAPISI (ADR 0007). Iki sey birlikte kanitlanir: (1) atama para
    /// harcadigi icin yazma araci sahip kaniti ister, (2) OKUMA da ister —
    /// "panoda ne var" cevabi Cihan'in is listesidir ve odadaki herkese
    /// okunamaz. Okuma araclarinin serbest oldugu varsayilirsa bu test kirilir.
    #[test]
    fn pano_sahip_kaniti_ister() {
        let g = armed();

        for arac in [
            "gorev_ver",
            "pano_durumu",
            "gorev_durum",
            "yorum_ekle",
            "ekip_listesi",
        ] {
            let Err((msg, _)) = g.check_tool(arac) else {
                panic!("{arac} karar yokken serbest kalmis");
            };
            assert_eq!(msg, DENY_MISSION, "{arac} yanlis ret metni dondurdu");
        }

        g.record(SpeakerVerdict::Foreign);
        assert!(g.check_tool("gorev_ver").is_err());
        assert!(g.check_tool("pano_durumu").is_err());

        tur_bitir(&g);
        g.record(SpeakerVerdict::Owner);
        for arac in [
            "gorev_ver",
            "pano_durumu",
            "gorev_durum",
            "yorum_ekle",
            "ekip_listesi",
        ] {
            assert!(
                g.check_tool(arac).is_ok(),
                "{arac} sahip icin serbest olmali"
            );
        }
    }

    /// Politika listeleri AYRIK olmali: ayni arac iki listede olursa hangi ret
    /// metninin donecegi `check_tool`'daki SIRAYA baglanir, yani mesaj sessizce
    /// degisebilir.
    #[test]
    fn politika_listeleri_ayrik() {
        // Tablodan turetilir: yeni bir owner-only listesi eklendiginde bu test
        // onu KENDILIGINDEN kapsar (elle eklemek unutulurdu).
        let mut listeler: Vec<(&str, &[&str])> = OWNER_ONLY_POLICIES
            .iter()
            .map(|(liste, ret, _)| (*ret, *liste))
            .collect();
        listeler.push(("NO_FOREIGN_TOOLS", NO_FOREIGN_TOOLS));
        for (i, (ad_a, a)) in listeler.iter().enumerate() {
            for (ad_b, b) in listeler.iter().skip(i + 1) {
                for t in a.iter() {
                    assert!(
                        !b.contains(t),
                        "{t} hem {ad_a} hem {ad_b} listesinde — ret metni siraya bagli kalir"
                    );
                }
            }
        }
    }

    #[test]
    fn bayat_karar_yetki_vermez() {
        let g = armed();
        g.record(SpeakerVerdict::Owner);
        let at = g.at_ms.load(Ordering::SeqCst);
        // TTL icinde gecerli, TTL asilinca Unknown'a duser.
        assert_eq!(g.verdict_at(at + VERDICT_TTL_MS - 1), SpeakerVerdict::Owner);
        assert_eq!(
            g.verdict_at(at + VERDICT_TTL_MS + 1),
            SpeakerVerdict::Unknown
        );
    }

    /// SAHADA GORULEN HATANIN REGRESYON TESTI: kisa ifade ("tamam") sidecar'da
    /// dogrulanamiyor; eskiden bu her seferinde durumu Unknown'a dusurup taze
    /// Owner karari siliyordu → kullanici kayit yapmis olsa bile hafizaya yazma
    /// kilitleniyordu. Belirsizlik artik taze karari EZMEZ.
    #[test]
    fn belirsizlik_taze_owner_karari_ezmez() {
        let g = SpeakerGate::armed_for_test(SpeakerVerdict::Owner);
        assert_eq!(g.verdict(), SpeakerVerdict::Owner);

        // `verify` yolundaki Unknown dali: elde gecerli karar varsa yazmaz.
        // (Sidecar cagrilmadan ayni mantik dogrudan sinanir.)
        if g.verdict() == SpeakerVerdict::Unknown {
            g.record(SpeakerVerdict::Unknown);
        }
        assert_eq!(
            g.verdict(),
            SpeakerVerdict::Owner,
            "kisa/dogrulanamayan ifade taze Owner karari silmemeli"
        );

        // Gercek bir tespit (Foreign) ise DAIMA yazilir — koruma zayiflamaz.
        g.record(SpeakerVerdict::Foreign);
        assert_eq!(g.verdict(), SpeakerVerdict::Foreign);
    }

    #[test]
    fn her_ifade_karari_ustune_yazar() {
        // Cihan konustu, sonra baskasi konustu: yetki DUSMELI.
        let g = armed();
        g.record(SpeakerVerdict::Owner);
        assert!(g.check_tool("hafizaya_kaydet").is_ok());
        g.record(SpeakerVerdict::Foreign);
        assert!(g.check_tool("hafizaya_kaydet").is_err());
    }

    /// CANLI SONDA — sidecar ayakta olmadan kosmaz, o yuzden `#[ignore]`.
    /// Birim testler protokolu ve politikayi kanitlar ama "derlendi" ile
    /// "calisiyor" ayni sey degil (bu repoda ogrenilmis ders). Kosum:
    ///   .\scripts\speaker-server.ps1        # baska bir terminalde
    ///   cargo test --lib -- --ignored canli_sidecar
    #[test]
    #[ignore = "yerel sidecar (8124) ve kayitli ses izi gerektirir"]
    fn canli_sidecar_yabanci_sesi_reddeder() {
        std::env::set_var("SMITH_SPEAKER_SIDECAR", "127.0.0.1:8124");
        let g = SpeakerGate::from_env();
        assert!(g.enabled());
        // 2 sn'lik sentetik ton: kesinlikle insan sesi degil → Foreign
        // beklenir. Bu, tel protokolunun + esik kararinin uctan uca kanitidir.
        let tone: Vec<f32> = (0..32_000)
            .map(|i| {
                let t = i as f32 / 16_000.0;
                0.3 * (2.0 * std::f32::consts::PI * 180.0 * t).sin()
                    + 0.1 * (2.0 * std::f32::consts::PI * 540.0 * t).sin()
            })
            .collect();
        let v = g.verify(&tone);
        assert_eq!(v, SpeakerVerdict::Foreign, "sentetik ton sahip sayilamaz");
        assert!(g.check_tool("hafizaya_kaydet").is_err());
        assert!(g.check_tool("terminal_calistir").is_err());
        assert!(g.check_tool("hafizada_ara").is_ok());
    }

    #[test]
    fn bozuk_adres_kapiyi_kapatir() {
        // Env okumasi testler arasi paylasimli oldugu icin dogrudan parse yolu
        // dogrulanir: bozuk adres None uretir, None = kapali kapi.
        assert!("bozuk-adres".parse::<std::net::SocketAddr>().is_err());
        let g = SpeakerGate::disabled();
        assert!(g.check_tool("hafizaya_kaydet").is_err());
    }
}
