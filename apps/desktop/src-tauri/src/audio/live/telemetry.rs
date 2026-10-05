//! Kullanim, gecikme ve saglik olcumleri.

use crate::time_util::{utc_iso, utc_parcalar};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Gecmis zamanda arac kullanimi iddiasini yakalayan kaliplar.
const IDDIA_KALIPLARI: &[&str] = &[
    "inceledim",
    "taradim",
    "kontrol ettim",
    "baktim",
    "calistirdim",
    "aradim",
    "okudum",
    "sorguladim",
    "olctum",
    "getirdim",
];

/// Turkce metni ASCII'ye indirger (kalip karsilastirmasi icin).
fn ascii_indir(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'ı' | 'İ' | 'i' | 'I' => 'i',
            'ş' | 'Ş' => 's',
            'ğ' | 'Ğ' => 'g',
            'ü' | 'Ü' => 'u',
            'ö' | 'Ö' => 'o',
            'ç' | 'Ç' => 'c',
            'â' => 'a',
            other => other.to_ascii_lowercase(),
        })
        .collect()
}

/// Metinde arac kullanimi iddiasi varsa hangi kalibin eslestigini dondurur.
pub(super) fn iddia_izi(text: &str) -> Option<&'static str> {
    let t = ascii_indir(text);
    IDDIA_KALIPLARI.iter().copied().find(|k| t.contains(k))
}

/// Iddia var ama arac cagrilmamis: olcum dosyasina yaz.
pub(super) fn iddia_kaydet(kalip: &str, metin: &str) {
    olcum_kaydet(
        "iddia-log.jsonl",
        serde_json::json!({
            "t": chrono_yok_zaman_damgasi(),
            "kalip": kalip,
            "metin": kirp_metin(metin),
        }),
    );
}

/// Olcum satirini `<veri koku>\logs\<dosya>` altina ekler (kok: `crate::paths`).
///
/// Neden JSONL: "zaman zaman uyduruyor" sinifindaki bir kusur TEK ornekle
/// teshis edilemez, DAGILIM ister : ses izi tarafinda ayni desen ise yaradi.
/// Konusma metni buraya girer (kullanicinin kendi sozleri DEGIL, yalniz
/// modelin ciktisi) ve yalniz yerel diske yazilir.
///
/// Neden ORTAK: ikinci gercek kullanim (`ekran_tahmin_kaydet`) cikinca yazma
/// yolu ayristirildi. Dosya adi PARAMETRE cunku iki olgu AYRI dosyada tutulur;
/// karisirlarsa hicbirinin dagilimi okunamaz.
fn olcum_kaydet(dosya: &str, kayit: serde_json::Value) {
    let Some(dir) = crate::paths::data_path("logs") else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let p = dir.join(dosya);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
    {
        use std::io::Write as _;
        let _ = writeln!(f, "{kayit}");
    }
}

/// Log'a girecek replik kirpmasi. Tek satirlik bir JSONL kaydinin butun bir
/// monologu tasimasi gerekmiyor; olcum icin baslangic yeterli.
fn kirp_metin(metin: &str) -> String {
    metin.chars().take(400).collect()
}

/// EKRAN ICERIGI HAKKINDA IDDIA : 1. TEKIL SIMDIKI ZAMAN GOZLEM KALIPLARI.
///
const EKRAN_GOZLEM_KALIPLARI: &[&str] = &["goruyorum", "gorebiliyorum", "okuyorum"];

/// Gozlem iddiasinin EKRANA bagli oldugunu gosteren capa.
///
/// NEDEN IKI SART: tek basina fiil ekranla ilgisiz olabilir ("haklisin,
/// goruyorum"), tek basina capa ise SORUYU da yakalar ("ekranda bir sey mi
/// var?"). Ikisinin birlikte aranmasi yanlis pozitifi : bu tespitin en buyuk
/// riskini : kesiyor.
///
/// Uygulama adlari listede cunku iddia cogu zaman "ekran" kelimesini hic
/// gecirmeden dogrudan uygulamayi adlandiriyor (sahadaki ilk tahmin aynen
/// boyleydi).
const EKRAN_CAPALARI: &[&str] = &[
    "ekran",
    "pencere",
    "sekme",
    "masaustu",
    "cursor",
    "obsidian",
    "claude",
    "chrome",
    "vscode",
    "vs code",
    "powershell",
    "terminal",
    "spotify",
    "discord",
    "youtube",
    "explorer",
    "notepad",
    "slack",
    "figma",
];

/// Metinde ekran icerigi hakkinda olgusal iddia varsa `(kalip, capa)` doner.
///
/// OLCUTUN SINIRI (bilincli): "Obsidian'mis" / "Claude'mus" gibi fiilsiz
/// duzeltmeler YAKALANMAZ. Onlari yakalamak "acik"/"-mis" gibi gevsek desenler
/// gerektirirdi ve bunlar soruyu da ("Obsidian acik mi?") yakalayarak olcumu
/// gurultuye bogardi. Bir turda tek isaret yeterli: sahadaki uc tahminden ilki
/// bu olcute takiliyor ve tur isaretleniyor.
pub(super) fn ekran_iddiasi(text: &str) -> Option<(&'static str, &'static str)> {
    let t = ascii_indir(text);
    let kalip = EKRAN_GOZLEM_KALIPLARI
        .iter()
        .copied()
        .find(|k| t.contains(k))?;
    let capa = EKRAN_CAPALARI.iter().copied().find(|c| t.contains(c))?;
    Some((kalip, capa))
}

/// Ekran tahmini kaydinin JSON sekli. Yazma yolundan AYRI: bicim testten
/// diske dokunmadan dogrulanabilsin (`ekran_tahmin_kaydi_bicimi`).
fn ekran_tahmin_kaydi(kalip: &str, capa: &str, metin: &str) -> serde_json::Value {
    serde_json::json!({
        "t": chrono_yok_zaman_damgasi(),
        "kalip": kalip,
        "capa": capa,
        "metin": kirp_metin(metin),
    })
}

/// Ekran hakkinda iddia var ama net kare istenmemis: olcum dosyasina yaz.
///
/// AYRI DOSYA (`ekran-tahmin-log.jsonl`): "uydurma arac iddiasi" ile "ekran
/// tahmini" iki farkli olgu; ayni dosyada karisirlarsa hicbirinin dagilimi
/// okunamaz.
pub(super) fn ekran_tahmin_kaydet(kalip: &str, capa: &str, metin: &str) {
    olcum_kaydet(
        "ekran-tahmin-log.jsonl",
        ekran_tahmin_kaydi(kalip, capa, metin),
    );
}

/// `chrono` bagimliligi eklemeden kaba bir zaman damgasi (Unix saniye).
/// Amac siralama ve kabaca "ne zaman"; takvim aritmetigi gerekmiyor.
fn chrono_yok_zaman_damgasi() -> u64 {
    crate::time_util::unix_seconds(std::time::SystemTime::now())
}

// ---------------------------------------------------------------------------
// TOKEN SAYACI (Live usageMetadata gunlugu)
//
// `gemini-3.8-live` dinledigi/urettigi her saniyeyi faturalar ve her turda
// baglami yeniden sayar; harcama gorunmezse tasarruf olculemez. Sunucu
// mesajlarindaki `usageMetadata` (ai.google.dev/api/live, UsageMetadata)
// her ornek icin tek satir JSON olarak
// `<veri koku>\logs\live-usage-<yyyyMMdd>.jsonl` dosyasina eklenir
// (gun UTC). ICERIK/TRANSKRIPT ASLA yazilmaz: ayristirma bir BEYAZ LISTEDIR,
// yalniz sayaclar ve modalite adlari gecer. Ozet: `scripts/live-usage-report.ps1`.
//
// Dosya adi `.jsonl` kalmali: acilis betiginin log temizligi yalniz
// `<ad>-yyyyMMdd.log` adlarini siler.
// ---------------------------------------------------------------------------

/// Surec boyunca sabit UUID; yeniden baslatmalarda oturum sayaci cakismasini onler.
fn boot_id() -> &'static str {
    static ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ID.get_or_init(|| {
        let mut hex = crate::system_tools::yeni_is_id();
        hex.replace_range(12..13, "4");
        let variant = u8::from_str_radix(&hex[16..17], 16).expect("hex kimlik") & 3 | 8;
        hex.replace_range(16..17, &format!("{variant:x}"));
        format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        )
    })
}

/// Surec boyunca Live oturum sayaci (1'den); her yeniden baglanma yeni oturumdur.
static OTURUM_SAYACI: AtomicU64 = AtomicU64::new(0);

pub(super) fn yeni_oturum_no() -> u64 {
    OTURUM_SAYACI.fetch_add(1, Ordering::Relaxed) + 1
}

/// `usageMetadata` icindeki tamsayi sayaclar (Google alan adlariyla ayni).
const KULLANIM_SAYACLARI: &[&str] = &[
    "promptTokenCount",
    "responseTokenCount",
    "totalTokenCount",
    "cachedContentTokenCount",
    "toolUsePromptTokenCount",
    "thoughtsTokenCount",
];

/// Modalite kirilimi dizileri: her oge `{modality, tokenCount}`.
const KULLANIM_KIRILIMLARI: &[&str] = &[
    "promptTokensDetails",
    "cacheTokensDetails",
    "responseTokensDetails",
    "toolUsePromptTokensDetails",
];

/// Bir sunucu mesajindan gunluk satirini cikarir; `usageMetadata` yoksa ya da
/// taninan hicbir sayac icermiyorsa `None`. Kimlik surec boyunca sabittir.
///
/// BEYAZ LISTE: yalniz `KULLANIM_SAYACLARI` (u64) ve `KULLANIM_KIRILIMLARI`
/// ogeleri (modalite adi `[A-Za-z0-9_]{1,32}` + sayi) kopyalanir; mesajin
/// baska hicbir alani (transkript, ses, arac argumani) satira giremez.
fn kullanim_kaydi(
    v: &serde_json::Value,
    ts: &str,
    oturum_no: u64,
    model: &str,
) -> Option<serde_json::Value> {
    let u = v.get("usageMetadata")?.as_object()?;
    let mut kayit = serde_json::Map::new();
    kayit.insert("ts".into(), serde_json::json!(ts));
    kayit.insert("oturum_no".into(), serde_json::json!(oturum_no));
    kayit.insert("boot_id".into(), serde_json::json!(boot_id()));
    kayit.insert(
        "oturum_id".into(),
        serde_json::json!(format!("{}:{oturum_no}", boot_id())),
    );
    kayit.insert("model".into(), serde_json::json!(model));
    let mut sayac_var = false;
    for ad in KULLANIM_SAYACLARI {
        if let Some(n) = u.get(*ad).and_then(serde_json::Value::as_u64) {
            kayit.insert((*ad).into(), serde_json::json!(n));
            sayac_var = true;
        }
    }
    for ad in KULLANIM_KIRILIMLARI {
        let Some(dizi) = u.get(*ad).and_then(serde_json::Value::as_array) else {
            continue;
        };
        let temiz: Vec<serde_json::Value> = dizi
            .iter()
            .filter_map(|oge| {
                let modalite = oge.get("modality")?.as_str()?;
                let gecerli = !modalite.is_empty()
                    && modalite.len() <= 32
                    && modalite
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_');
                if !gecerli {
                    return None;
                }
                // proto3 sifir degeri tel formatinda atlayabilir: eksik = 0.
                let n = oge
                    .get("tokenCount")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                Some(serde_json::json!({ "modality": modalite, "tokenCount": n }))
            })
            .collect();
        if !temiz.is_empty() {
            kayit.insert((*ad).into(), serde_json::Value::Array(temiz));
            sayac_var = true;
        }
    }
    sayac_var.then(|| serde_json::Value::Object(kayit))
}

pub(super) fn simdi_unix() -> u64 {
    chrono_yok_zaman_damgasi()
}

/// Unix saniyesi -> UTC (yil, ay, gun, saat, dakika, saniye). `chrono`
/// eklemeden; gun hesabi Howard Hinnant'in `civil_from_days` algoritmasi.
/// `20261002` (gunluk dosya adi icin, UTC).
fn utc_gun(unix: u64) -> String {
    let (y, mo, d, ..) = utc_parcalar(unix);
    format!("{y:04}{mo:02}{d:02}")
}

/// Gunluk dosyanin yolu: `<taban>\live-usage-<yyyyMMdd>.jsonl`.
fn kullanim_yolu(taban: &std::path::Path, unix: u64) -> std::path::PathBuf {
    taban.join(format!("live-usage-{}.jsonl", utc_gun(unix)))
}

/// Satiri dosyaya ekler (klasoru gerekirse olusturur).
fn kullanim_yaz(yol: &std::path::Path, kayit: &serde_json::Value) -> std::io::Result<()> {
    use std::io::Write as _;
    if let Some(dizin) = yol.parent() {
        std::fs::create_dir_all(dizin)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(yol)?;
    writeln!(f, "{kayit}")
}

/// Yazma hatasi oturumu DUSURMEZ ve log'u bogmaz: ilk hata stderr'e bir kez
/// yazilir, sonrakiler sessiz gecer.
static KULLANIM_YAZMA_UYARISI: AtomicBool = AtomicBool::new(false);

pub(super) fn kullanim_hazirla(
    v: &serde_json::Value,
    oturum_no: u64,
    model: &str,
    mut saat: impl FnMut() -> u64,
) -> Option<(serde_json::Value, u64)> {
    let unix = saat();
    let kayit = kullanim_kaydi(v, &utc_iso(unix), oturum_no, model)?;
    Some((kayit, unix))
}

pub(super) fn kullanim_kaydet(kayit: &serde_json::Value, unix: u64) {
    let sonuc = match crate::paths::data_path("logs") {
        Some(taban) => kullanim_yaz(&kullanim_yolu(&taban, unix), kayit).map_err(|e| e.to_string()),
        None => Err("veri koku cozulemedi".to_string()),
    };
    if let Err(e) = sonuc {
        if !KULLANIM_YAZMA_UYARISI.swap(true, Ordering::Relaxed) {
            eprintln!("[live] token gunlugu yazilamadi ({e}); sonraki hatalar sessiz gecilecek");
        }
    }
}

/// Saat cagirmayan olcum: Konusma -> Sessiz gecisindeki son konusma karesi
/// referanstir. AkisSonu kuyruk sesini kapatir, olcum saatini degistirmez.
/// Continuous kipin VAD'siz eski yolunda son ses/sunucu tur basi yedegi etiketlenir.
#[derive(Default)]
pub(super) struct GecikmeOlcer {
    pub(super) son_ses: Option<std::time::Instant>,
    pub(super) konusma_sonu: Option<std::time::Instant>,
    pub(super) tampon_suresi: Option<std::time::Duration>,
    pub(super) stt_suresi: Option<std::time::Duration>,
    tur: Option<GecikmeTuru>,
    sira: u64,
}

struct GecikmeTuru {
    no: u64,
    arac_suresi: std::time::Duration,
    gonderim_bayt: usize,
    son_yanit: Option<std::time::Instant>,
    referans: std::time::Instant,
    ilk_ses: Option<std::time::Instant>,
    arac: usize,
    konusma_referansi: bool,
    tampon_suresi: Option<std::time::Duration>,
    stt_suresi: Option<std::time::Duration>,
}

impl GecikmeOlcer {
    pub(super) fn sifirla(&mut self) {
        *self = Self {
            sira: self.sira,
            ..Self::default()
        };
    }

    pub(super) fn ses(&mut self, simdi: std::time::Instant) {
        self.son_ses = Some(simdi);
        self.konusma_sonu = None;
    }

    pub(super) fn konusma_sonu(&mut self, simdi: std::time::Instant) {
        if let Some(tur) = &mut self.tur {
            if tur.ilk_ses.is_none() {
                tur.referans = simdi;
                tur.konusma_referansi = true;
            }
        } else {
            self.konusma_sonu = Some(simdi);
        }
        self.son_ses = None;
    }
    pub(super) fn tampon_gonderimi(&mut self, sure: std::time::Duration) {
        if let Some(tur) = &mut self.tur {
            tur.tampon_suresi = Some(sure);
        } else {
            self.tampon_suresi = Some(sure);
        }
    }

    pub(super) fn stt(&mut self, sure: std::time::Duration) {
        if let Some(tur) = &mut self.tur {
            tur.stt_suresi = Some(sure);
        } else {
            self.stt_suresi = Some(sure);
        }
    }

    pub(super) fn basla(&mut self, simdi: std::time::Instant) {
        if self.tur.is_none() {
            let son = self.konusma_sonu.take();
            self.sira += 1;
            self.tur = Some(GecikmeTuru {
                no: self.sira,
                arac_suresi: std::time::Duration::ZERO,
                gonderim_bayt: 0,
                son_yanit: None,
                referans: son.or(self.son_ses.take()).unwrap_or(simdi),
                ilk_ses: None,
                arac: 0,
                konusma_referansi: son.is_some(),
                tampon_suresi: self.tampon_suresi.take(),
                stt_suresi: self.stt_suresi.take(),
            });
        }
    }

    pub(super) fn arac(&mut self, adet: usize, simdi: std::time::Instant) -> u64 {
        self.basla(simdi);
        let tur = self.tur.as_mut().expect("tur basladi");
        tur.arac += adet;
        tur.no
    }

    pub(super) fn arac_yaniti(
        &mut self,
        no: u64,
        bas: std::time::Instant,
        son: std::time::Instant,
        bayt: usize,
    ) {
        let Some(tur) = self.tur.as_mut().filter(|t| t.no == no) else {
            return;
        };
        // Ilk sesten sonraki araclar ilk ses gecikmesini degistirmez.
        if tur.ilk_ses.is_some_and(|ilk| son > ilk) {
            return;
        }
        tur.arac_suresi += son.saturating_duration_since(bas);
        tur.gonderim_bayt += bayt;
        tur.son_yanit = Some(son);
    }

    pub(super) fn ilk_ses(&mut self, simdi: std::time::Instant) {
        self.basla(simdi);
        self.tur
            .as_mut()
            .expect("tur basladi")
            .ilk_ses
            .get_or_insert(simdi);
    }

    // Tur sonunda log: ilk sesten SONRA gelen araclar da sayiya dahil olur.
    // Kesinti de tur sonudur; sonraki turun sayaci ve ilk sesi sifirdan baslar.
    pub(super) fn bitir(&mut self) -> Option<String> {
        let tur = self.tur.take()?;
        let ilk = tur.ilk_ses?;
        let ms = ilk.saturating_duration_since(tur.referans).as_millis();
        let yedek = if tur.konusma_referansi {
            ""
        } else {
            " (referans: son ses/sunucu tur basi)"
        };
        let tampon = tur
            .tampon_suresi
            .map(|d| format!(" (tampon gonderimi: {} us)", d.as_micros()))
            .unwrap_or_default();
        let stt = tur
            .stt_suresi
            .map(|d| format!(" (stt: {} ms)", d.as_millis()))
            .unwrap_or_default();
        let arac = if tur.arac > 0 {
            let sonrasi = tur
                .son_yanit
                .map(|son| ilk.saturating_duration_since(son).as_millis().to_string())
                .unwrap_or_else(|| "yok".into());
            format!(
                ", arac_ms: {}, gonderim_kb: {}, arac_sonrasi_ms: {sonrasi}",
                tur.arac_suresi.as_millis(),
                tur.gonderim_bayt.div_ceil(1024)
            )
        } else {
            String::new()
        };
        Some(format!(
            "[gecikme] konusma sonu -> ilk ses {ms} ms{stt} (arac: {}{arac}){yedek}{tampon}",
            tur.arac
        ))
    }
}

#[derive(Default)]
pub(super) struct KareKaybi {
    pub(super) sayi: u64,
    pub(super) son_log: Option<std::time::Instant>,
}
impl KareKaybi {
    pub(super) fn dustu(&mut self, simdi: std::time::Instant) -> Option<u64> {
        self.sayi += 1;
        if self
            .son_log
            .is_none_or(|t| simdi.duration_since(t).as_secs() >= 5)
        {
            self.son_log = Some(simdi);
            return Some(std::mem::take(&mut self.sayi));
        }
        None
    }
    pub(super) fn bildir(&mut self, ad: &str) {
        if let Some(n) = self.dustu(std::time::Instant::now()) {
            eprintln!("[live] UYARI: {n} {ad} karesi dusuruldu (kanal dolu)");
        }
    }
}

#[derive(Default)]
pub(super) struct SunucuSessizligi {
    pub(super) bas: Option<std::time::Instant>,
    pub(super) esik: usize,
    model_acik: bool,
    son_mesaj: Option<std::time::Instant>,
    araclar: std::collections::HashSet<String>,
}
impl SunucuSessizligi {
    pub(super) fn baslat(&mut self, simdi: std::time::Instant) {
        self.bas = Some(simdi);
        self.esik = 0;
    }
    pub(super) fn mesaj(&mut self, simdi: std::time::Instant) {
        self.son_mesaj = Some(simdi);
        self.bas = self.model_acik.then_some(simdi);
        self.esik = 0;
    }
    pub(super) fn model_basladi(&mut self, simdi: std::time::Instant) {
        self.model_acik = true;
        self.mesaj(simdi);
    }
    pub(super) fn arac_basladi(&mut self, id: &str, simdi: std::time::Instant) {
        self.model_basladi(simdi);
        self.araclar.insert(id.to_owned());
    }
    pub(super) fn arac_gonderildi(&mut self, id: &str, simdi: std::time::Instant) {
        if self.araclar.remove(id) {
            self.mesaj(simdi);
        }
    }
    pub(super) fn bitir(&mut self) {
        *self = Self::default();
    }
    pub(super) fn yenile(&mut self, simdi: std::time::Instant) -> bool {
        if self.model_acik
            && self.araclar.is_empty()
            && self
                .son_mesaj
                .is_some_and(|son| simdi.saturating_duration_since(son).as_secs() >= 30)
        {
            self.bitir();
            return true;
        }
        false
    }
    pub(super) fn kontrol(&mut self, simdi: std::time::Instant) -> Option<u64> {
        let sn = *[10, 30].get(self.esik)?;
        if simdi.saturating_duration_since(self.bas?).as_secs() < sn {
            return None;
        }
        self.esik += 1;
        Some(sn)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum YanitsizEylem {
    YenidenIste {
        utterance_id: u64,
        transcript: String,
    },
    YenidenBaglan {
        utterance_id: u64,
    },
}

#[derive(Default)]
pub(super) struct TurOzeti {
    sira: u64,
    etkin: Option<TurIz>,
    son_yerel_ses: Option<std::time::Instant>,
    son_akis_sonu: Option<std::time::Instant>,
}

struct TurIz {
    id: u64,
    bas: std::time::Instant,
    transcript: String,
    input_transcript_seen: bool,
    first_input_transcription: Option<std::time::Instant>,
    tool_count: usize,
    audio_chunks: usize,
    first_server_content: Option<std::time::Instant>,
    first_audio_rx: Option<std::time::Instant>,
    turn_complete: Option<std::time::Instant>,
    last_local_voice: Option<std::time::Instant>,
    audio_stream_end_ws_written: Option<std::time::Instant>,
    bas_mono_ms: u64,
    first_device_sample: std::sync::Arc<std::sync::atomic::AtomicU64>,
    ten_logged: bool,
    reprompt_sent: bool,
    reconnect_sent: bool,
    no_response_reason: Option<&'static str>,
}

impl TurOzeti {
    fn yeni(&mut self, simdi: std::time::Instant) -> &mut TurIz {
        self.sira += 1;
        self.etkin.insert(TurIz {
            id: self.sira,
            bas: simdi,
            transcript: String::new(),
            input_transcript_seen: false,
            first_input_transcription: None,
            tool_count: 0,
            audio_chunks: 0,
            first_server_content: None,
            first_audio_rx: None,
            turn_complete: None,
            last_local_voice: self.son_yerel_ses,
            audio_stream_end_ws_written: self.son_akis_sonu,
            bas_mono_ms: super::monotonic_millis(),
            first_device_sample: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
            ten_logged: false,
            reprompt_sent: false,
            reconnect_sent: false,
            no_response_reason: None,
        })
    }

    fn etkin_veya_yeni(&mut self, simdi: std::time::Instant) -> &mut TurIz {
        if self.etkin.is_none() {
            self.yeni(simdi);
        }
        self.etkin.as_mut().expect("tur var")
    }

    pub(super) fn yerel_ses_sonu(&mut self, at: std::time::Instant) {
        self.son_yerel_ses = Some(at);
        self.etkin_veya_yeni(at).last_local_voice = Some(at);
    }

    pub(super) fn akis_sonu_yazildi(&mut self, at: std::time::Instant) {
        self.son_akis_sonu = Some(at);
        if let Some(tur) = &mut self.etkin {
            tur.audio_stream_end_ws_written = Some(at);
        }
    }

    pub(super) fn transcript(&mut self, text: &str, simdi: std::time::Instant) {
        let tur = self.etkin_veya_yeni(simdi);
        tur.input_transcript_seen = true;
        tur.first_input_transcription.get_or_insert(simdi);
        tur.transcript.push_str(text);
    }

    pub(super) fn server_content(&mut self, simdi: std::time::Instant) {
        self.etkin_veya_yeni(simdi)
            .first_server_content
            .get_or_insert(simdi);
    }

    pub(super) fn tool(&mut self, adet: usize, simdi: std::time::Instant) {
        let tur = self.etkin_veya_yeni(simdi);
        tur.first_server_content.get_or_insert(simdi);
        tur.tool_count += adet;
    }

    pub(super) fn audio(
        &mut self,
        simdi: std::time::Instant,
    ) -> std::sync::Arc<std::sync::atomic::AtomicU64> {
        let tur = self.etkin_veya_yeni(simdi);
        tur.first_server_content.get_or_insert(simdi);
        tur.first_audio_rx.get_or_insert(simdi);
        tur.audio_chunks += 1;
        tur.first_device_sample.clone()
    }

    pub(super) fn kontrol(&mut self, simdi: std::time::Instant) -> Option<YanitsizEylem> {
        let tur = self.etkin.as_mut()?;
        if !tur.input_transcript_seen || tur.first_server_content.is_some() {
            return None;
        }
        let gecen = simdi.saturating_duration_since(tur.bas);
        if gecen >= std::time::Duration::from_secs(10) && !tur.ten_logged {
            tur.ten_logged = true;
            eprintln!(
                "[no_response] utterance_id={} elapsed_ms={} transcript_chars={}",
                tur.id,
                gecen.as_millis(),
                tur.transcript.chars().count()
            );
            if yanit_bekleyen_metin(&tur.transcript) {
                tur.reprompt_sent = true;
                return Some(YanitsizEylem::YenidenIste {
                    utterance_id: tur.id,
                    transcript: tur.transcript.clone(),
                });
            }
        }
        if gecen >= std::time::Duration::from_secs(30) && !tur.reconnect_sent {
            tur.reconnect_sent = true;
            if tur.reprompt_sent {
                tur.no_response_reason = Some("timeout_30s");
                return Some(YanitsizEylem::YenidenBaglan {
                    utterance_id: tur.id,
                });
            }
            tur.no_response_reason = Some("not_addressed");
        }
        None
    }

    pub(super) fn turn_complete(&mut self, simdi: std::time::Instant) -> Option<String> {
        let mut tur = self.etkin.take()?;
        tur.turn_complete = Some(simdi);
        Some(tur.satir())
    }

    pub(super) fn kapat(&mut self, sebep: &'static str) -> Option<String> {
        let mut tur = self.etkin.take()?;
        tur.no_response_reason.get_or_insert(sebep);
        Some(tur.satir())
    }
}

fn yanit_bekleyen_metin(metin: &str) -> bool {
    let n = ascii_indir(metin);
    metin.contains('?')
        || ["smith", "simit", "smit", "cemil", "cemiyet", "schmidt"]
            .iter()
            .any(|ad| n.split(|c: char| !c.is_alphanumeric()).any(|p| p == *ad))
        || ["mi", "mu", "misin", "musun", "miyim", "miyiz", "midir"]
            .iter()
            .any(|ek| n.split(|c: char| !c.is_alphanumeric()).any(|p| p == *ek))
}

fn tur_ani(bas: std::time::Instant, at: Option<std::time::Instant>) -> String {
    at.map(|t| t.saturating_duration_since(bas).as_millis().to_string())
        .unwrap_or_else(|| "-".into())
}

impl TurIz {
    fn satir(&self) -> String {
        format!(
            "[tur-ozet] utterance_id={} input_transcript_seen={} tool_count={} audio_chunks={} last_local_voice={} audioStreamEnd_ws_written={} first_inputTranscription={} first_server_content={} first_audio_rx={} first_device_sample={} turnComplete={} no_response_reason={}",
            self.id,
            self.input_transcript_seen,
            self.tool_count,
            self.audio_chunks,
            tur_ani(self.bas, self.last_local_voice),
            tur_ani(self.bas, self.audio_stream_end_ws_written),
            tur_ani(self.bas, self.first_input_transcription),
            tur_ani(self.bas, self.first_server_content),
            tur_ani(self.bas, self.first_audio_rx),
            tur_mono_ani(self.bas_mono_ms, &self.first_device_sample),
            tur_ani(self.bas, self.turn_complete),
            self.no_response_reason.unwrap_or("-")
        )
    }
}

fn tur_mono_ani(bas: u64, at: &std::sync::atomic::AtomicU64) -> String {
    let at = at.load(std::sync::atomic::Ordering::Acquire);
    if at == 0 {
        "-".into()
    } else {
        at.saturating_sub(bas).to_string()
    }
}

/// Tam konusma metninin stderr'e yazilmasinin varsayilani. Metin gizlilik
/// yuzeyidir (parola, musteri adi, ozel konusma): debug derlemede teshis icin
/// ACIK, release derlemede KAPALI; `SMITH_LOG_TRANSCRIPT` ikisini de ezer.
const LOG_TRANSCRIPT_DEFAULT: bool = cfg!(debug_assertions);

/// Bir konusma satirini loglar. Kapaliyken metin yerine yalniz uzunluk yazilir:
/// akisin sagligi (konusma geldi mi, ne kadar) icerik sizdirmadan izlenir.
pub(crate) fn log_transcript(etiket: &str, text: &str) {
    let acik = if LOG_TRANSCRIPT_DEFAULT {
        crate::env_flag::acik_varsayilan_acik("SMITH_LOG_TRANSCRIPT")
    } else {
        crate::env_flag::acik_varsayilan_kapali("SMITH_LOG_TRANSCRIPT")
    };
    eprintln!("{}", transcript_satiri(etiket, text, acik));
}

fn transcript_satiri(etiket: &str, text: &str, acik: bool) -> String {
    if acik {
        format!("[{etiket}] {text}")
    } else {
        format!("[ses-ozet] kaynak={etiket} uzunluk={} bayt", text.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yanitsiz_tur_10_saniyede_bir_kez_uyarir_30_saniyede_yeniler() {
        let t = std::time::Instant::now();
        let mut ozet = TurOzeti::default();
        ozet.transcript("Smith, beni duyuyor musun?", t);
        assert!(ozet
            .kontrol(t + std::time::Duration::from_secs(9))
            .is_none());
        assert!(matches!(
            ozet.kontrol(t + std::time::Duration::from_secs(10)),
            Some(YanitsizEylem::YenidenIste {
                utterance_id: 1,
                ..
            })
        ));
        assert!(ozet
            .kontrol(t + std::time::Duration::from_secs(11))
            .is_none());
        assert!(matches!(
            ozet.kontrol(t + std::time::Duration::from_secs(30)),
            Some(YanitsizEylem::YenidenBaglan { utterance_id: 1 })
        ));
        assert!(ozet
            .kontrol(t + std::time::Duration::from_secs(31))
            .is_none());
        let satir = ozet.kapat("session_closed").unwrap();
        assert!(satir.contains("no_response_reason=timeout_30s"), "{satir}");
    }

    #[test]
    fn soru_eki_yalniz_ayri_kelimeyken_eslesir() {
        assert!(!yanit_bekleyen_metin("mikrofonu ac"));
        assert!(yanit_bekleyen_metin("bunu yapar misin"));
        assert!(yanit_bekleyen_metin("Smith saat kac"));
    }

    #[test]
    fn hitapsiz_tur_30_saniyede_yalnizca_kapanma_nedeni_kaydeder() {
        let t = std::time::Instant::now();
        let mut ozet = TurOzeti::default();
        ozet.transcript("mikrofonu ac", t);

        assert!(ozet
            .kontrol(t + std::time::Duration::from_secs(10))
            .is_none());
        assert!(ozet
            .kontrol(t + std::time::Duration::from_secs(30))
            .is_none());
        let satir = ozet.kapat("session_closed").unwrap();
        assert!(
            satir.contains("no_response_reason=not_addressed"),
            "{satir}"
        );
    }

    #[test]
    fn tur_ozeti_bes_asamayi_ve_cihaz_callbackini_tasir() {
        let t = std::time::Instant::now();
        let mut ozet = TurOzeti::default();
        ozet.yerel_ses_sonu(t);
        ozet.akis_sonu_yazildi(t + std::time::Duration::from_millis(1));
        ozet.transcript("merhaba", t + std::time::Duration::from_millis(2));
        ozet.server_content(t + std::time::Duration::from_millis(3));
        let marker = ozet.audio(t + std::time::Duration::from_millis(4));
        marker.store(
            super::super::monotonic_millis() + 5,
            std::sync::atomic::Ordering::Release,
        );
        let satir = ozet
            .turn_complete(t + std::time::Duration::from_millis(6))
            .unwrap();
        for alan in [
            "last_local_voice=0",
            "audioStreamEnd_ws_written=1",
            "first_inputTranscription=2",
            "first_server_content=3",
            "first_audio_rx=4",
            "first_device_sample=",
            "turnComplete=6",
        ] {
            assert!(satir.contains(alan), "eksik {alan}: {satir}");
        }
    }

    #[test]
    fn saha_model_basladiktan_sonra_sessizlik_izlenir() {
        let t = std::time::Instant::now();
        let mut s = SunucuSessizligi::default();
        s.baslat(t);
        s.model_basladi(t);
        s.mesaj(t);
        assert_eq!(s.kontrol(t + std::time::Duration::from_secs(30)), Some(10));
    }

    #[test]
    fn saha_arac_gecikmesi_kirilim_tasir() {
        let t = std::time::Instant::now();
        let mut g = GecikmeOlcer::default();
        g.konusma_sonu(t);
        g.arac(1, t);
        g.ilk_ses(t + std::time::Duration::from_secs(2));
        let log = g.bitir().unwrap();
        assert!(log.contains("arac_ms:"), "{log}");
        assert!(log.contains("gonderim_kb:"), "{log}");
        assert!(log.contains("arac_sonrasi_ms:"), "{log}");
    }

    #[test]
    fn saha_mod_gecisinden_onceki_yanit_yeni_tura_giremez() {
        let t = std::time::Instant::now();
        let mut g = GecikmeOlcer::default();
        let eski = g.arac(1, t);
        g.sifirla();
        g.arac(1, t);
        g.arac_yaniti(eski, t, t, 1024);
        g.ilk_ses(t);
        assert!(g.bitir().unwrap().contains("gonderim_kb: 0"));
    }

    #[test]
    fn saha_arac_kirilimi_gercek_gonderim_ve_tur_sinirini_korur() {
        let t = std::time::Instant::now();
        let ms = |n| t + std::time::Duration::from_millis(n);
        let mut g = GecikmeOlcer::default();
        g.konusma_sonu(t);
        let no = g.arac(2, ms(100));
        g.arac_yaniti(no, ms(100), ms(600), 1024);
        g.arac_yaniti(no, ms(100), ms(900), 819200);
        g.ilk_ses(ms(1500));
        g.arac_yaniti(no, ms(1500), ms(1600), 4000);
        assert_eq!(g.bitir().unwrap(), "[gecikme] konusma sonu -> ilk ses 1500 ms (arac: 2, arac_ms: 1300, gonderim_kb: 801, arac_sonrasi_ms: 600)");
        g.konusma_sonu(ms(2000));
        g.arac(1, ms(2100));
        g.arac_yaniti(no, ms(100), ms(2200), 9000);
        g.ilk_ses(ms(2300));
        assert_eq!(g.bitir().unwrap(), "[gecikme] konusma sonu -> ilk ses 300 ms (arac: 1, arac_ms: 0, gonderim_kb: 0, arac_sonrasi_ms: yok)");
    }

    #[test]
    fn saha_bekci_proaktif_susma_arac_ve_tur_sonunu_ayirir() {
        let t = std::time::Instant::now();
        let sn = |n| t + std::time::Duration::from_secs(n);
        let mut s = SunucuSessizligi::default();
        assert!(!s.yenile(sn(90)));
        s.baslat(t);
        assert_eq!(s.kontrol(sn(10)), Some(10));
        assert_eq!(s.kontrol(sn(30)), Some(30));
        assert!(!s.yenile(sn(90)), "proaktif susma yeniden baglanmaz");
        s.model_basladi(sn(100));
        s.mesaj(sn(120));
        assert!(!s.yenile(sn(149)));
        assert!(s.yenile(sn(150)));
        assert!(!s.yenile(sn(180)), "tek karar");
        s.arac_basladi("a", sn(200));
        s.arac_basladi("b", sn(200));
        assert!(!s.yenile(sn(260)), "yerel arac bekleniyor");
        s.arac_gonderildi("a", sn(270));
        assert!(!s.yenile(sn(310)), "ikinci arac bekleniyor");
        s.arac_gonderildi("b", sn(320));
        assert!(!s.yenile(sn(349)));
        assert!(s.yenile(sn(350)));
        s.model_basladi(sn(400));
        s.bitir(); // turnComplete ve interrupted ayni gecisi kullanir.
        s.arac_gonderildi("b", sn(410));
        assert!(!s.yenile(sn(500)), "gec yanit bitmis turu acamaz");
    }

    #[test]
    fn kullanim_kimligi_boot_boyunca_sabit_oturumlar_arasinda_farkli() {
        let message = serde_json::json!({"usageMetadata": {"totalTokenCount": 1}});
        let first = kullanim_kaydi(&message, "t", 1, "m").unwrap();
        let second = kullanim_kaydi(&message, "t", 2, "m").unwrap();
        assert_eq!(first["boot_id"], second["boot_id"]);
        assert_ne!(first["oturum_id"], second["oturum_id"]);
        let id = first["boot_id"].as_str().unwrap();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!("89ab".contains(&id[19..20]));
        assert_eq!(first["oturum_id"], format!("{id}:1"));
    }

    #[test]
    fn isimle_gecikme_stt_suresi_sonraki_tura_sizmaz() {
        let t = std::time::Instant::now();
        let mut olcer = GecikmeOlcer::default();
        olcer.konusma_sonu(t);
        olcer.stt(std::time::Duration::from_millis(350));
        olcer.ilk_ses(t + std::time::Duration::from_millis(900));
        assert!(olcer
            .bitir()
            .unwrap()
            .contains("konusma sonu -> ilk ses 900 ms (stt: 350 ms)"));
        olcer.konusma_sonu(t);
        olcer.ilk_ses(t + std::time::Duration::from_secs(1));
        assert!(!olcer.bitir().unwrap().contains("stt:"));
    }

    #[test]
    fn a2_gecikme_son_konusmayi_ve_tampon_suresini_ayri_olcer() {
        let t = std::time::Instant::now();
        let mut g = GecikmeOlcer::default();
        g.konusma_sonu(t);
        g.tampon_gonderimi(std::time::Duration::from_micros(1250));
        g.arac(2, t + std::time::Duration::from_millis(800));
        g.ilk_ses(t + std::time::Duration::from_millis(978));
        assert_eq!(
            g.bitir().unwrap(),
            "[gecikme] konusma sonu -> ilk ses 978 ms (arac: 2, arac_ms: 0, gonderim_kb: 0, arac_sonrasi_ms: yok) (tampon gonderimi: 1250 us)"
        );
    }

    #[test]
    fn audit_sessizlik_ve_dusen_kare_olcumu() {
        let bas = std::time::Instant::now();
        let mut s = SunucuSessizligi::default();
        assert_eq!(s.kontrol(bas + std::time::Duration::from_secs(40)), None);
        s.baslat(bas);
        for (sn, beklenen) in [
            (9, None),
            (10, Some(10)),
            (11, None),
            (30, Some(30)),
            (83, None),
        ] {
            assert_eq!(
                s.kontrol(bas + std::time::Duration::from_secs(sn)),
                beklenen
            );
        }
        s.baslat(bas);
        s.mesaj(bas);
        assert_eq!(s.kontrol(bas + std::time::Duration::from_secs(40)), None);
        let mut k = KareKaybi::default();
        assert_eq!(k.dustu(bas), Some(1));
        for _ in 0..9 {
            assert_eq!(k.dustu(bas), None);
        }
        assert_eq!(k.dustu(bas + std::time::Duration::from_secs(5)), Some(10));
    }

    #[test]
    fn gecikme_konusma_sonundan_ilk_ses_ve_tum_araclar_tek_satir() {
        let t = std::time::Instant::now();
        let ms = |n| t + std::time::Duration::from_millis(n);
        let mut g = GecikmeOlcer::default();
        g.ses(t);
        g.konusma_sonu(ms(100));
        g.arac(2, ms(200));
        g.ilk_ses(ms(1500));
        g.ilk_ses(ms(1700));
        g.arac(1, ms(1800));
        assert_eq!(
            g.bitir().unwrap(),
            "[gecikme] konusma sonu -> ilk ses 1400 ms (arac: 3, arac_ms: 0, gonderim_kb: 0, arac_sonrasi_ms: yok)"
        );
        assert!(g.bitir().is_none());
        g.ses(ms(2000));
        g.konusma_sonu(ms(2100));
        g.ilk_ses(ms(2300));
        assert_eq!(
            g.bitir().unwrap(),
            "[gecikme] konusma sonu -> ilk ses 200 ms (arac: 0)"
        );
    }

    #[test]
    fn gecikme_continuous_referansi_tur_basinda_donar() {
        let t = std::time::Instant::now();
        let ms = |n| t + std::time::Duration::from_millis(n);
        let mut g = GecikmeOlcer::default();
        g.ses(t);
        g.ses(ms(100));
        g.arac(1, ms(200));
        g.ses(ms(300));
        g.ilk_ses(ms(1000));
        g.konusma_sonu(ms(1300)); // Ilk sesten sonra gelen bitis negatif sure uretmez.
        assert_eq!(
            g.bitir().unwrap(),
            "[gecikme] konusma sonu -> ilk ses 900 ms (arac: 1, arac_ms: 0, gonderim_kb: 0, arac_sonrasi_ms: yok) (referans: son ses/sunucu tur basi)"
        );
    }

    #[test]
    fn gecikme_arac_beklerken_konusma_sonu_ve_sessiz_kesinti() {
        let t = std::time::Instant::now();
        let ms = |n| t + std::time::Duration::from_millis(n);
        let mut g = GecikmeOlcer::default();
        g.ses(t);
        g.arac(1, ms(100));
        g.ses(ms(200));
        g.konusma_sonu(ms(400));
        g.ilk_ses(ms(700));
        assert_eq!(
            g.bitir().unwrap(),
            "[gecikme] konusma sonu -> ilk ses 300 ms (arac: 1, arac_ms: 0, gonderim_kb: 0, arac_sonrasi_ms: yok)"
        );
        g.basla(ms(1200)); // Metin/proaktif tur: kullanici ses referansi yok.
        g.ilk_ses(ms(1300));
        assert_eq!(
            g.bitir().unwrap(),
            "[gecikme] konusma sonu -> ilk ses 100 ms (arac: 0) (referans: son ses/sunucu tur basi)"
        );
        g.arac(3, ms(1500));
        assert!(g.bitir().is_none()); // Ses cikarmadan kesilen tur.
        g.ilk_ses(ms(1600));
        assert_eq!(
            g.bitir().unwrap(),
            "[gecikme] konusma sonu -> ilk ses 0 ms (arac: 0) (referans: son ses/sunucu tur basi)"
        );
    }

    #[test]
    fn iddia_izi_gecmis_zamani_yakalar_yetenek_kipini_yakalamaz() {
        // Gercek turda gorulen cumleler.
        for iddia in [
            "Cloudflare access log'larini inceledim.",
            "Obsidian'daki notlarini taradim.",
            "Tarih ve kullanici adi komutlarini calistirdim.",
            "Hafizada aradim, bir sey bulamadim.",
            "Dosyayi okudum.",
            "Sistem durumunu kontrol ettim.",
        ] {
            assert!(iddia_izi(iddia).is_some(), "iddia yakalanmadi: {iddia:?}");
        }

        // YANLIS POZITIF OLMAMALI: bunlar bir sey YAPTIGINI soylemiyor.
        for masum in [
            "Istersen inceleyebilirim.",
            "Notlarini tarayabilirim.",
            "Sistem durumunu kontrol edebilirim.",
            "Bir bakalim mi?",
            "Hafizada arama yapabilirim.",
            "Bulamadim demedim, henuz bakmadim.",
            "Ekranda Cursor'da calistigin dosyayi goruyorum.",
            "Ne hakkinda konusalim?",
        ] {
            assert!(
                iddia_izi(masum).is_none(),
                "yanlis pozitif: {masum:?} -> {:?}",
                iddia_izi(masum)
            );
        }
    }

    #[test]
    fn ekran_iddiasi_gozlem_iddiasini_yakalar() {
        for iddia in [
            // Sahada gecen ilk tahmin (Turkce harfleriyle).
            "Ekranda Cursor'da çalıştığın dosyayı görüyorum.",
            "Obsidian'da bir not görüyorum.",
            "Ekrandaki hata mesajını okuyorum.",
            "Ekranını görebiliyorum.",
            "Şu an PowerShell penceresini görüyorum.",
        ] {
            assert!(
                ekran_iddiasi(iddia).is_some(),
                "ekran iddiasi yakalanmadi: {iddia:?}"
            );
        }
        // Kalip ve capa log'a giriyor: dogru cifti dondurmeli.
        assert_eq!(
            ekran_iddiasi("Ekranda Cursor goruyorum."),
            Some(("goruyorum", "ekran"))
        );
        assert_eq!(
            ekran_iddiasi("Obsidian'da bir not goruyorum."),
            Some(("goruyorum", "obsidian"))
        );
    }

    /// YANLIS POZITIF EN BUYUK RISK: bunlarin hicbiri ekran hakkinda OLGUSAL
    /// iddia DEGILDIR (olumsuzluk, yetenek kipi, soru, 2. tekil sahis).
    /// Isaretlenirlerse olcum gurultuye boğulur ve degerini kaybeder.
    #[test]
    fn ekran_iddiasi_masum_cumleleri_isaretlemez() {
        for masum in [
            "Ekranını göremiyorum.",
            "Ne görüyorsun?",
            "Ekranda bir şey mi var?",
            "Görebilirim.",
            "Ekranını görebilir miyim?",
            "Ekrandaki hatayı okuyabilirim.",
            "Ekranda bir şey görmüyorum.",
            "Ekranını paylaşır mısın?",
            "Ekrana bakmamı ister misin?",
            "Cursor'da ne görüyorsun?",
        ] {
            assert!(
                ekran_iddiasi(masum).is_none(),
                "yanlis pozitif: {masum:?} -> {:?}",
                ekran_iddiasi(masum)
            );
        }
    }

    /// CAPA SARTI: gozlem fiili tek basina yetmez. "Goruyorum" ekranla ilgisiz
    /// de olabilir; capa olmadan isaretlemek tespiti gurultuye cevirirdi.
    #[test]
    fn ekran_iddiasi_capasiz_gormeyi_isaretlemez() {
        assert!(ekran_iddiasi("Haklısın, görüyorum.").is_none());
        assert!(ekran_iddiasi("Sorunu görüyorum, mantık hatası var.").is_none());
        // Ayni cumle EKRAN capasiyla -> iddia.
        assert!(ekran_iddiasi("Ekranda sorunu görüyorum.").is_some());
    }

    /// Log bicimi: ekran tahmini AYRI dosyaya (`ekran-tahmin-log.jsonl`) yazilir
    /// ve `iddia-log.jsonl`'den fazladan `capa` alani tasir. Diske dokunmadan
    /// dogrulanir; yazma yolu (`olcum_kaydet`) env'e bagli.
    #[test]
    fn ekran_tahmin_kaydi_bicimi() {
        let uzun = "x".repeat(500);
        let k = ekran_tahmin_kaydi("goruyorum", "ekran", &uzun);
        let mut anahtarlar: Vec<&str> = k
            .as_object()
            .expect("kayit obje olmali")
            .keys()
            .map(String::as_str)
            .collect();
        anahtarlar.sort();
        assert_eq!(anahtarlar, vec!["capa", "kalip", "metin", "t"]);
        assert!(
            k["t"].as_u64().unwrap_or(0) > 1_700_000_000,
            "zaman damgasi yok: {k}"
        );
        assert_eq!(k["kalip"].as_str(), Some("goruyorum"));
        assert_eq!(k["capa"].as_str(), Some("ekran"));
        assert_eq!(
            k["metin"].as_str().unwrap_or_default().chars().count(),
            400,
            "metin 400 karaktere kirpilmali"
        );
    }

    /// Turkce harfler ASCII'ye indirilerek karsilastirilir; aksi halde
    /// "taradim" ile "taradım" ayri metinler olur ve tespit sessizce kacar.
    #[test]
    fn turkce_harfler_tespiti_kacirmaz() {
        assert!(iddia_izi("Notlarini TARADIM").is_some(), "buyuk harf kacti");
        assert!(iddia_izi("notlarini taradım").is_some(), "dotless i kacti");
        assert!(iddia_izi("ölçtüm").is_some(), "o/c/u kacti");
        assert_eq!(ascii_indir("İNCELEDİM"), "inceledim");
    }

    // ---- TOKEN SAYACI ----

    /// Gercek sema (ai.google.dev/api/live UsageMetadata) + ayni mesajda
    /// transkript: satira YALNIZ sayaclar girer.
    fn ornek_kullanim_mesaji() -> serde_json::Value {
        serde_json::json!({
            "serverContent": {
                "outputTranscription": { "text": "GIZLI-TRANSKRIPT-METNI" },
                "modelTurn": { "parts": [{ "inlineData": { "data": "QUJD" } }] }
            },
            "usageMetadata": {
                "promptTokenCount": 1200,
                "responseTokenCount": 300,
                "totalTokenCount": 1550,
                "cachedContentTokenCount": 100,
                "toolUsePromptTokenCount": 20,
                "thoughtsTokenCount": 30,
                "promptTokensDetails": [
                    { "modality": "AUDIO", "tokenCount": 900 },
                    { "modality": "TEXT", "tokenCount": 250 },
                    { "modality": "VIDEO", "tokenCount": 50 }
                ],
                "responseTokensDetails": [
                    { "modality": "AUDIO", "tokenCount": 280 },
                    { "modality": "TEXT", "tokenCount": 20 }
                ],
                "bilinmeyenAlan": "SIZMAMALI"
            }
        })
    }

    #[test]
    fn kullanim_kaydi_google_alan_adlarini_ve_kirilimi_tasir() {
        let k = kullanim_kaydi(
            &ornek_kullanim_mesaji(),
            "2026-10-02T09:00:01Z",
            3,
            "gemini-3.8-live",
        )
        .expect("usageMetadata var");
        assert_eq!(k["ts"], "2026-10-02T09:00:01Z");
        assert_eq!(k["oturum_no"], 3);
        assert_eq!(k["model"], "gemini-3.8-live");
        assert_eq!(k["promptTokenCount"], 1200);
        assert_eq!(k["responseTokenCount"], 300);
        assert_eq!(k["totalTokenCount"], 1550);
        assert_eq!(k["cachedContentTokenCount"], 100);
        assert_eq!(k["toolUsePromptTokenCount"], 20);
        assert_eq!(k["thoughtsTokenCount"], 30);
        let p = k["promptTokensDetails"].as_array().expect("dizi");
        assert_eq!(p.len(), 3);
        assert_eq!(
            p[0],
            serde_json::json!({ "modality": "AUDIO", "tokenCount": 900 })
        );
        assert_eq!(p[2]["modality"], "VIDEO");
        let r = k["responseTokensDetails"].as_array().expect("dizi");
        assert_eq!(
            r[1],
            serde_json::json!({ "modality": "TEXT", "tokenCount": 20 })
        );
        // Gelmeyen kirilim satira girmez.
        assert!(k.get("cacheTokensDetails").is_none());
    }

    /// ICERIK ASLA YAZILMAZ: ayni mesajdaki transkript, ses verisi ve taninmayan
    /// alanlar satirda bulunamaz.
    #[test]
    fn kullanim_kaydi_icerik_ve_bilinmeyen_alan_tasimaz() {
        let k = kullanim_kaydi(&ornek_kullanim_mesaji(), "t", 1, "m").expect("kayit");
        let s = k.to_string();
        for yasak in [
            "GIZLI-TRANSKRIPT",
            "QUJD",
            "SIZMAMALI",
            "serverContent",
            "inlineData",
        ] {
            assert!(!s.contains(yasak), "satira icerik sizdi: {yasak} -> {s}");
        }
    }

    #[test]
    fn kullanim_kaydi_usage_yoksa_veya_bossa_yazilmaz() {
        let yok = serde_json::json!({ "serverContent": { "turnComplete": true } });
        assert!(kullanim_kaydi(&yok, "t", 1, "m").is_none());
        let bos = serde_json::json!({ "usageMetadata": {} });
        assert!(kullanim_kaydi(&bos, "t", 1, "m").is_none());
        let nesne_degil = serde_json::json!({ "usageMetadata": "x" });
        assert!(kullanim_kaydi(&nesne_degil, "t", 1, "m").is_none());
    }

    #[test]
    fn kullanim_kaydi_kotu_kirilim_ogelerini_atlar_eksik_sayiyi_sifir_sayar() {
        let m = serde_json::json!({
            "usageMetadata": {
                "totalTokenCount": 7,
                "promptTokensDetails": [
                    { "modality": "TEXT" },
                    { "modality": "bad modality!", "tokenCount": 5 },
                    { "modality": "", "tokenCount": 5 },
                    { "tokenCount": 5 },
                    { "modality": "AUDIO", "tokenCount": "5" },
                    { "modality": "IMAGE", "tokenCount": 4 }
                ]
            }
        });
        let k = kullanim_kaydi(&m, "t", 1, "m").expect("kayit");
        let p = k["promptTokensDetails"].as_array().expect("dizi");
        assert_eq!(
            p,
            &vec![
                serde_json::json!({ "modality": "TEXT", "tokenCount": 0 }),
                // Sayi olmayan tokenCount de 0 sayilir (modalite gecerli).
                serde_json::json!({ "modality": "AUDIO", "tokenCount": 0 }),
                serde_json::json!({ "modality": "IMAGE", "tokenCount": 4 }),
            ]
        );
    }

    #[test]
    fn utc_zaman_damgasi_bilinen_degerler() {
        assert_eq!(utc_iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_iso(1_700_000_000), "2023-11-14T22:13:20Z");
        // Artik gun ve ay sinirlari.
        assert_eq!(utc_iso(1_709_164_800), "2024-02-29T00:00:00Z");
        assert_eq!(utc_iso(1_709_251_199), "2024-02-29T23:59:59Z");
        assert_eq!(utc_iso(1_709_251_200), "2024-03-01T00:00:00Z");
        // Yil sonu.
        assert_eq!(utc_iso(1_798_761_599), "2026-12-31T23:59:59Z");
        assert_eq!(utc_iso(1_798_761_600), "2027-01-01T00:00:00Z");
        assert_eq!(utc_gun(1_709_164_800), "20240229");
        assert_eq!(utc_gun(0), "19700101");
    }

    #[test]
    fn kullanim_dosyasi_adi_jsonl_ve_gun_damgali() {
        let taban = std::path::Path::new("logs");
        let yol = kullanim_yolu(taban, 1_709_164_800);
        assert_eq!(
            yol.file_name().and_then(|n| n.to_str()),
            Some("live-usage-20240229.jsonl")
        );
        // Acilis betiginin log temizligi yalniz `<ad>-yyyyMMdd.log` siler.
        assert!(yol.extension().is_some_and(|e| e == "jsonl"));
    }

    fn gecici_dizin(ad: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("smith-live-{ad}-{}", std::process::id()))
    }

    /// Dosyaya tek satir JSON olarak ekler; ikinci kayit eskisini bozmaz.
    #[test]
    fn kullanim_yaz_tek_satir_json_ekler() {
        let dizin = gecici_dizin("usage");
        let _ = std::fs::remove_dir_all(&dizin);
        let yol = kullanim_yolu(&dizin.join("alt").join("logs"), 1_709_164_800);
        let a = kullanim_kaydi(&ornek_kullanim_mesaji(), "t1", 1, "m").expect("kayit");
        let b = kullanim_kaydi(&ornek_kullanim_mesaji(), "t2", 1, "m").expect("kayit");
        kullanim_yaz(&yol, &a).expect("klasor olusturulup yazilmali");
        kullanim_yaz(&yol, &b).expect("ekleme");
        let icerik = std::fs::read_to_string(&yol).expect("okunur");
        let satirlar: Vec<&str> = icerik.lines().collect();
        assert_eq!(satirlar.len(), 2, "{icerik}");
        let ilk: serde_json::Value = serde_json::from_str(satirlar[0]).expect("JSON");
        let ikinci: serde_json::Value = serde_json::from_str(satirlar[1]).expect("JSON");
        assert_eq!(ilk["ts"], "t1");
        assert_eq!(ikinci["ts"], "t2");
        let _ = std::fs::remove_dir_all(&dizin);
    }

    /// Yazma hatasi PANIK/oturum dususu degil `Err` doner (cagiran bir kez uyarir).
    #[test]
    fn kullanim_yaz_hatada_err_doner_panik_etmez() {
        let dizin = gecici_dizin("usage-hata");
        let _ = std::fs::remove_dir_all(&dizin);
        std::fs::create_dir_all(&dizin).expect("gecici dizin");
        // "alt" bir DOSYA: altina dizin/dosya olusturulamaz.
        let engel = dizin.join("alt");
        std::fs::write(&engel, b"x").expect("engel dosyasi");
        let a = kullanim_kaydi(&ornek_kullanim_mesaji(), "t", 1, "m").expect("kayit");
        assert!(kullanim_yaz(&engel.join("logs").join("x.jsonl"), &a).is_err());
        let _ = std::fs::remove_dir_all(&dizin);
    }

    #[test]
    fn audit_9_gece_yarisi_kayit_ve_dosya_ayni_gun() {
        let mut saat = [1_709_164_799, 1_709_164_800].into_iter();
        let (kayit, unix) = kullanim_hazirla(&ornek_kullanim_mesaji(), 1, "m", || {
            saat.next().expect("en fazla iki okuma")
        })
        .unwrap();
        let yol = kullanim_yolu(std::path::Path::new("logs"), unix);
        assert_eq!(kayit["ts"], "2024-02-28T23:59:59Z");
        assert_eq!(yol.file_name().unwrap(), "live-usage-20240228.jsonl");
        assert_eq!(saat.next(), Some(1_709_164_800), "ikinci saat okunmamali");
    }

    #[test]
    fn d1b_19_kapali_log_icerik_tasimaz() {
        let text = "ozel konusma 123";
        for etiket in ["sen", "smith", "konusma smith"] {
            let kapali = transcript_satiri(etiket, text, false);
            assert!(!kapali.contains(text), "kapaliyken metin sizdi: {kapali}");
            assert!(!kapali.contains(&format!("[{etiket}]")));
            assert!(kapali.contains(&format!("uzunluk={}", text.len())));
            assert_eq!(
                transcript_satiri(etiket, text, true),
                format!("[{etiket}] {text}")
            );
        }
    }
}
