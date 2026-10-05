//! Mikrofon kareleri ve dinleme kipleri.

use super::tools::{arac_yaniti, TOOL_HATA};
use super::LiveEvent;
use base64::Engine as _;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::sync::mpsc;

pub(super) const IN_RATE: u32 = 16_000;

// ---------------------------------------------------------------------------
// MIKROFON AKISI KIPI VE KARE YARDIMCILARI
// ---------------------------------------------------------------------------

/// Mikrofonun Live'a nasil aktigi (`SMITH_MIC_STREAM`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum MikAkisi {
    /// VARSAYILAN: yalniz konusma varken ses gider (on-tampon, artik sure,
    /// `audioStreamEnd`); bkz. `vad::MikKapisi`.
    Gated,
    /// Eski davranis BIREBIR: her kare (sessizlik ve kapali-donem sifirlari
    /// dahil) gider.
    Continuous,
}

/// Ham env degerinden kip. Yalniz `continuous` eskiye doner; bos, `gated` ve
/// taninmayan her sey `Gated` (faturayi koruyan taraf varsayilan).
fn mik_akisi_niyeti(ham: Option<&str>) -> MikAkisi {
    match ham.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("continuous") => MikAkisi::Continuous,
        _ => MikAkisi::Gated,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum DinlemeKipi {
    Herkes,
    YalnizBeni,
    Isimle,
}

impl DinlemeKipi {
    pub fn ad(self) -> &'static str {
        match self {
            Self::Herkes => "herkes",
            Self::YalnizBeni => "yalniz_beni",
            Self::Isimle => "isimle",
        }
    }

    pub(super) fn oku(s: &str) -> Option<Self> {
        match s.trim() {
            "herkes" => Some(Self::Herkes),
            "yalniz_beni" => Some(Self::YalnizBeni),
            "isimle" => Some(Self::Isimle),
            _ => None,
        }
    }

    pub(super) fn env(kip: Option<&str>, eski: Option<&str>) -> Self {
        kip.and_then(Self::oku).unwrap_or_else(|| {
            if eski.is_some_and(|s| s.trim() == "1") {
                Self::YalnizBeni
            } else {
                Self::Herkes
            }
        })
    }

    pub(super) fn arguman(args: &serde_json::Value) -> Option<Self> {
        if let Some(kip) = args.get("kip") {
            return kip.as_str().and_then(Self::oku);
        }
        args["yalniz_beni"]
            .as_bool()
            .map(|acik| if acik { Self::YalnizBeni } else { Self::Herkes })
    }
}

// Alt iki bit kip, kalan bitler surum: yakalama tek atomik anlik goruntu alir.
static DINLEME_DURUMU: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static DINLEME_ILK: std::sync::Once = std::sync::Once::new();

pub(super) fn dinleme_surumu() -> u64 {
    DINLEME_ILK.call_once(|| {
        let kip = DinlemeKipi::env(
            std::env::var("SMITH_LISTEN_MODE").ok().as_deref(),
            std::env::var("SMITH_ONLY_OWNER").ok().as_deref(),
        );
        stt_isit(kip);
        DINLEME_DURUMU.store(kip as u64, Ordering::SeqCst);
        stt_canli_tutmayi_uyandir();
    });
    DINLEME_DURUMU.load(Ordering::SeqCst)
}

pub fn dinleme_kipi() -> DinlemeKipi {
    match dinleme_surumu() & 3 {
        1 => DinlemeKipi::YalnizBeni,
        2 => DinlemeKipi::Isimle,
        _ => DinlemeKipi::Herkes,
    }
}

pub fn dinleme_ayarla(kip: DinlemeKipi) -> Option<u64> {
    dinleme_surumu();
    stt_isit(kip);
    let degisen = DINLEME_DURUMU
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |eski| {
            if eski & 3 == kip as u64 {
                None
            } else {
                Some(((eski & !3) + 4) | kip as u64)
            }
        })
        .ok()
        .map(|eski| ((eski & !3) + 4) | kip as u64);
    stt_canli_tutmayi_uyandir();
    degisen
}

pub(super) fn dinleme_olayi(kip: DinlemeKipi, uyari: Option<String>) -> LiveEvent {
    LiveEvent::Tool {
        ad: "dinleme_modu_durumu".into(),
        durum: kip.ad(),
        sebep: uyari,
    }
}

fn adla_seslenildi(metin: &str) -> bool {
    let sade: String = metin
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .map(|c| match c {
            'ı' | 'î' => 'i',
            'â' => 'a',
            'û' => 'u',
            _ => c,
        })
        .collect();
    sade.split(|c: char| !c.is_alphanumeric() && c != '_')
        .any(|s| {
            matches!(
                s,
                "smith"
                    | "smitt"
                    | "smitth"
                    | "smit"
                    | "zmit"
                    | "simit"
                    | "simith"
                    | "ismit"
                    | "ismith"
                    | "ismis"
                    | "ismish"
                    | "cemil"
                    | "cemiyet"
                    | "semt"
                    | "schmidt"
                    | "smid"
            )
        })
}

#[derive(Default)]
pub(super) struct YanitIzni {
    pub(super) epoch: u64,
    pub(super) bekleyen: bool,
    pub(super) cevapliyor: bool,
}

impl YanitIzni {
    pub(super) fn gonderildi(&mut self, epoch: u64) {
        if self.epoch != epoch {
            *self = Self {
                epoch,
                ..Self::default()
            };
        }
        self.bekleyen = true;
    }

    pub(super) fn gecis_onayi(&mut self, degisen_surum: Option<u64>, simdiki_surum: u64) {
        if degisen_surum == Some(simdiki_surum) && simdiki_surum & 3 == DinlemeKipi::Isimle as u64 {
            self.gonderildi(simdiki_surum);
        }
    }

    pub(super) fn serbest(&self, kip: DinlemeKipi, epoch: u64) -> bool {
        kip != DinlemeKipi::Isimle || (self.epoch == epoch && (self.bekleyen || self.cevapliyor))
    }

    pub(super) fn basla(&mut self) {
        if !self.cevapliyor && self.bekleyen {
            self.bekleyen = false;
            self.cevapliyor = true;
        }
    }

    pub(super) fn bitir(&mut self) {
        self.cevapliyor = false;
    }
}

pub(super) fn isimle_arac_reddi(calls: &[serde_json::Value]) -> String {
    let yanitlar: Vec<_> = calls
        .iter()
        .map(|call| {
            arac_yaniti(
                call["id"].as_str().unwrap_or_default(),
                call["name"].as_str().unwrap_or_default(),
                serde_json::json!({ "hata": "Oyun modu: adla seslenilmeden arac calistirilmaz." }),
            )
        })
        .collect();
    serde_json::json!({ "toolResponse": { "functionResponses": yanitlar } }).to_string()
}

pub(super) fn dinleme_tamponunu_sifirla(
    tampon: &mut crate::audio::vad::SahipTamponu,
    isim: &mut IsimKapisi,
) {
    *tampon = crate::audio::vad::SahipTamponu::default();
    *isim = IsimKapisi::default();
}

pub(super) const ADLA_UYARI: &str = "adla seslenme algilanamiyor (yerel STT yok)";
const TAKIP_SURESI: std::time::Duration = std::time::Duration::from_secs(15);
pub(super) const STT_ZAMAN_ASIMI: std::time::Duration = std::time::Duration::from_millis(1500);

#[derive(Default)]
pub(super) struct IsimKapisi {
    pub(super) son_gonderim: Option<std::time::Instant>,
}

impl IsimKapisi {
    pub(super) fn karar(
        &self,
        metin: Result<&str, ()>,
        simdi: std::time::Instant,
    ) -> Result<bool, &'static str> {
        let metin = metin.map_err(|()| ADLA_UYARI)?;
        Ok(!metin.trim().is_empty()
            && (adla_seslenildi(metin)
                || self
                    .son_gonderim
                    .is_some_and(|son| simdi.saturating_duration_since(son) < TAKIP_SURESI)))
    }

    pub(super) fn gonderildi(&mut self, simdi: std::time::Instant) {
        self.son_gonderim = Some(simdi);
    }
}

const STT_ISINMA_SURESI: std::time::Duration = std::time::Duration::from_secs(30);
static STT_ISINMA: std::sync::Mutex<Option<Arc<SttIsinma>>> = std::sync::Mutex::new(None);
const STT_CANLI_TUTMA_ARALIGI: std::time::Duration = std::time::Duration::from_secs(300);
static STT_CANLI_TUTMA: std::sync::OnceLock<Option<std::thread::Thread>> =
    std::sync::OnceLock::new();

#[derive(Default)]
struct SttCanliTutma {
    sonraki: Option<(u64, std::time::Instant)>,
}

impl SttCanliTutma {
    fn zamanla(
        &mut self,
        durum: u64,
        simdi: std::time::Instant,
    ) -> (bool, Option<std::time::Duration>) {
        if durum & 3 != DinlemeKipi::Isimle as u64 {
            self.sonraki = None;
            return (false, None);
        }
        let son = match self.sonraki {
            Some((epoch, son)) if epoch == durum => son,
            _ => simdi + STT_CANLI_TUTMA_ARALIGI,
        };
        let gonder = simdi >= son;
        let son = if gonder {
            simdi + STT_CANLI_TUTMA_ARALIGI
        } else {
            son
        };
        self.sonraki = Some((durum, son));
        (gonder, Some(son.saturating_duration_since(simdi)))
    }
}

fn stt_canli_tutmayi_uyandir() {
    if STT_CANLI_TUTMA.get().is_none()
        && DINLEME_DURUMU.load(Ordering::SeqCst) & 3 != DinlemeKipi::Isimle as u64
    {
        return;
    }
    let worker = STT_CANLI_TUTMA.get_or_init(|| {
        match std::thread::Builder::new()
            .name("stt-canli-tutma".into())
            .spawn(|| {
                let mut zamanlama = SttCanliTutma::default();
                loop {
                    // Once girisinde de calisir; kip getter'ina yeniden girilmez.
                    let durum = DINLEME_DURUMU.load(Ordering::SeqCst);
                    let (gonder, bekle) = zamanlama.zamanla(durum, std::time::Instant::now());
                    if gonder {
                        if DINLEME_DURUMU.load(Ordering::SeqCst) == durum {
                            if let Err(hata) = stt_istegi(
                                &[],
                                std::net::SocketAddr::from(([127, 0, 0, 1], 8123)),
                                STT_ISINMA_SURESI,
                            ) {
                                eprintln!("[stt] canli tutma basarisiz: {hata}");
                            }
                        }
                        continue;
                    }
                    match bekle {
                        Some(sure) => std::thread::park_timeout(sure),
                        None => std::thread::park(),
                    }
                }
            }) {
            Ok(worker) => Some(worker.thread().clone()),
            Err(hata) => {
                eprintln!("[stt] canli tutma baslatilamadi: {hata}");
                None
            }
        }
    });
    if let Some(worker) = worker {
        worker.unpark();
    }
}

pub(super) struct SttIsinma {
    son: std::time::Instant,
    sonuc: tokio::sync::watch::Receiver<Option<bool>>,
}

impl SttIsinma {
    pub(super) fn kalan(&self, simdi: std::time::Instant) -> Result<std::time::Duration, ()> {
        match *self.sonuc.borrow() {
            Some(true) => Ok(std::time::Duration::ZERO),
            Some(false) => Err(()),
            None => self
                .son
                .checked_duration_since(simdi)
                .filter(|s| !s.is_zero())
                .ok_or(()),
        }
    }

    async fn bekle(&self) -> Result<(), ()> {
        if self.kalan(std::time::Instant::now())?.is_zero() {
            return Ok(());
        }
        let mut sonuc = self.sonuc.clone();
        let hazir = tokio::time::timeout_at(
            tokio::time::Instant::from_std(self.son),
            sonuc.wait_for(|s| s.is_some()),
        )
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
        if *hazir == Some(true) {
            Ok(())
        } else {
            Err(())
        }
    }
}

pub(super) fn stt_isinmasi() -> Option<Arc<SttIsinma>> {
    STT_ISINMA.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn stt_isit(kip: DinlemeKipi) {
    if kip != DinlemeKipi::Isimle {
        return;
    }
    let mut isinma = STT_ISINMA.lock().unwrap_or_else(|e| e.into_inner());
    if isinma.as_ref().is_some_and(|is| {
        is.kalan(std::time::Instant::now())
            .is_ok_and(|kalan| !kalan.is_zero())
    }) {
        return;
    }
    let (tx, rx) = tokio::sync::watch::channel(None);
    *isinma = Some(Arc::new(SttIsinma {
        son: std::time::Instant::now() + STT_ISINMA_SURESI,
        sonuc: rx,
    }));
    let worker_tx = tx.clone();
    // Once/tepsi yolunda Tokio runtime'i beklenmez; is yalniz yerel TCP yapar.
    if std::thread::Builder::new()
        .name("stt-isinma".into())
        .spawn(move || {
            let sonuc = stt_istegi(
                &[],
                std::net::SocketAddr::from(([127, 0, 0, 1], 8123)),
                STT_ISINMA_SURESI,
            );
            let _ = worker_tx.send(Some(sonuc.is_ok()));
        })
        .is_err()
    {
        let _ = tx.send(Some(false));
    }
}

pub(super) async fn yerel_stt(
    ses: Vec<f32>,
    isinma: Option<Arc<SttIsinma>>,
    adres: std::net::SocketAddr,
) -> Result<String, ()> {
    // Ifade mevcut tamponda kalir; model kilidine paralel decode gonderilmez.
    isinma.ok_or(())?.bekle().await?;
    tokio::task::spawn_blocking(move || stt_istegi(&ses, adres, STT_ZAMAN_ASIMI))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

// Yuksek bit yerel-mecburi; sifir ornek yalniz isitma kontroludur.
fn stt_istegi(
    ses: &[f32],
    adres: std::net::SocketAddr,
    butce: std::time::Duration,
) -> Result<String, String> {
    use std::io::{Read, Write};
    let baslangic = std::time::Instant::now();
    let kalan = || {
        butce
            .checked_sub(baslangic.elapsed())
            .filter(|d| !d.is_zero())
            .ok_or("stt zaman asimi".to_string())
    };
    let mut stream =
        std::net::TcpStream::connect_timeout(&adres, kalan()?).map_err(|e| e.to_string())?;
    stream.set_nodelay(true).map_err(|e| e.to_string())?;
    let mut istek = Vec::with_capacity(4 + ses.len() * 4);
    istek.extend_from_slice(&((ses.len() as u32) | 0x8000_0000).to_le_bytes());
    for s in ses {
        istek.extend_from_slice(&s.to_le_bytes());
    }
    let mut offset = 0;
    while offset < istek.len() {
        stream
            .set_write_timeout(Some(kalan()?))
            .map_err(|e| e.to_string())?;
        let n = stream.write(&istek[offset..]).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("stt baglantisi kapandi".into());
        }
        offset += n;
    }
    let mut oku = |mut hedef: &mut [u8]| -> Result<(), String> {
        while !hedef.is_empty() {
            stream
                .set_read_timeout(Some(kalan()?))
                .map_err(|e| e.to_string())?;
            let n = stream.read(hedef).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("stt baglantisi kapandi".into());
            }
            hedef = &mut hedef[n..];
        }
        Ok(())
    };
    let mut header = [0; 4];
    oku(&mut header)?;
    let n = u32::from_le_bytes(header) as usize;
    if n > 64 * 1024 {
        return Err("stt yaniti cok buyuk".into());
    }
    let mut body = vec![0; n];
    oku(&mut body)?;
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    if !matches!(v["device"].as_str(), Some("cuda" | "cpu"))
        || v.get("error").is_some()
        || (ses.is_empty() && v["ready"] != true)
    {
        return Err("yerel stt yaniti yok".into());
    }
    v["text"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "stt metni yok".into())
}

pub(super) const DINLEME_UYARI: &str = "Ses izi dogrulanamadi: bu ifade buluta gonderilmedi. Daha uzun konusun veya Yalniz beni dinle modunu HUD/tepsiden kapatin.";

pub(super) fn sahip_sonucu(
    ses: Vec<f32>,
    karar: crate::audio::SpeakerVerdict,
    events: &mpsc::UnboundedSender<LiveEvent>,
) -> Vec<crate::audio::vad::KapiCikti> {
    let sahip = karar == crate::audio::SpeakerVerdict::Owner;
    let _ = events.send(dinleme_olayi(
        DinlemeKipi::YalnizBeni,
        if sahip {
            None
        } else {
            Some(DINLEME_UYARI.into())
        },
    ));
    crate::audio::vad::SahipTamponu::karar(ses, sahip)
}

pub(super) enum SpeakerIs {
    Kare(u64, u64, Vec<f32>),
    Ifade {
        no: u64,
        epoch: u64,
        ses: Vec<f32>,
        konusma_ornek: usize,
        yanit: tokio::sync::oneshot::Sender<crate::audio::SpeakerVerdict>,
    },
}

pub(super) fn mik_akisi_env() -> MikAkisi {
    let ham = std::env::var("SMITH_MIC_STREAM").ok();
    if let Some(v) = ham.as_deref() {
        let t = v.trim().to_ascii_lowercase();
        if !t.is_empty() && t != "gated" && t != "continuous" {
            eprintln!(
                "[live] SMITH_MIC_STREAM={v:?} taninmadi (gated | continuous), gated kullaniliyor"
            );
        }
    }
    mik_akisi_niyeti(ham.as_deref())
}

#[derive(Clone, Copy)]
pub(super) struct SunucuVad {
    pub(super) gated: bool,
    pub(super) silence_ms: usize,
}

impl SunucuVad {
    pub(super) fn yeni(gated: bool, ham: Option<&str>) -> Self {
        let silence_ms = ham
            .and_then(|v| v.trim().parse::<i64>().ok())
            .unwrap_or(700)
            .clamp(300, 2000) as usize;
        Self { gated, silence_ms }
    }

    pub(super) fn env(gated: bool) -> Self {
        Self::yeni(
            gated,
            std::env::var("SMITH_LIVE_SILENCE_MS").ok().as_deref(),
        )
    }
}

/// Susturma bilgisi PCM degerinden cikarilmaz; capture kaynagindan gelir.
pub(super) struct MikKaresi {
    pub(super) samples: Arc<[f32]>,
    pub(super) rate: u32,
    pub(super) kapali: bool,
    pub(super) at: std::time::Instant,
    pub(super) listen_epoch: u64,
}

const KESINTI_IFADE_TAVANI: usize = 30 * IN_RATE as usize;

#[derive(Debug, Clone, PartialEq)]
pub(super) enum KesintiKurtarma {
    TamIfade { id: u64, ses: Vec<f32> },
    TekrarIste { id: Option<u64> },
}

#[derive(Default)]
pub(super) struct IfadeKoruma {
    sira: u64,
    biriken: Vec<f32>,
    son: Option<KorunanIfade>,
    kurtarma: Option<KesintiKurtarma>,
}

struct KorunanIfade {
    id: u64,
    ses: Vec<f32>,
    cevap_basladi: bool,
    tamamlandi: bool,
    yeniden_gonderildi: bool,
}

impl IfadeKoruma {
    pub(super) fn ses(&mut self, ses: &[f32]) {
        if ses.is_empty() {
            return;
        }
        let fazla = self
            .biriken
            .len()
            .saturating_add(ses.len())
            .saturating_sub(KESINTI_IFADE_TAVANI);
        if fazla > 0 {
            self.biriken.drain(..fazla.min(self.biriken.len()));
        }
        self.biriken.extend_from_slice(ses);
    }

    pub(super) fn akis_sonu(&mut self) -> Option<u64> {
        if self.biriken.is_empty() {
            return None;
        }
        self.sira += 1;
        let id = self.sira;
        self.son = Some(KorunanIfade {
            id,
            ses: std::mem::take(&mut self.biriken),
            cevap_basladi: false,
            tamamlandi: false,
            yeniden_gonderildi: false,
        });
        Some(id)
    }

    pub(super) fn cevap_basladi(&mut self) {
        if let Some(son) = &mut self.son {
            son.cevap_basladi = true;
        }
    }

    pub(super) fn tur_bitti(&mut self) {
        if let Some(son) = &mut self.son {
            son.tamamlandi = true;
        }
    }

    pub(super) fn koptu(&mut self, konusuyor: bool) {
        if konusuyor || !self.biriken.is_empty() {
            let id = self.son.as_ref().map(|s| s.id);
            self.biriken.clear();
            self.kurtarma = Some(KesintiKurtarma::TekrarIste { id });
            return;
        }
        let Some(son) = &mut self.son else {
            return;
        };
        if !son.cevap_basladi && !son.tamamlandi && !son.yeniden_gonderildi {
            son.yeniden_gonderildi = true;
            self.kurtarma = Some(KesintiKurtarma::TamIfade {
                id: son.id,
                ses: son.ses.clone(),
            });
        }
    }

    pub(super) fn kurtarmayi_al(&mut self) -> Option<KesintiKurtarma> {
        self.kurtarma.take()
    }
}

// 4 sn mono f32: 48 kHz'de 768000, 192 kHz'de 3072000 bayt.
// Callback boyutundan bagimsiz sure siniri; metadata da en fazla 4096 kare.
const MIK_TAMPON_SURE: std::time::Duration = std::time::Duration::from_secs(4);
const MIK_TAMPON_BAYT: usize = 4 * 192_000 * std::mem::size_of::<f32>();

#[derive(Default)]
pub(super) struct MikTamponu {
    durum: std::sync::Mutex<MikKuyruk>,
    hazir: tokio::sync::Notify,
}

#[derive(Default)]
struct MikKuyruk {
    kareler: std::collections::VecDeque<MikKaresi>,
    sure: std::time::Duration,
    bayt: usize,
    dusen: u64,
}

impl MikKuyruk {
    fn cikar(&mut self) -> Option<MikKaresi> {
        let kare = self.kareler.pop_front()?;
        self.sure = self.sure.saturating_sub(kare.suresi());
        self.bayt -= kare.samples.len() * std::mem::size_of::<f32>();
        Some(kare)
    }
}

impl MikKaresi {
    fn suresi(&self) -> std::time::Duration {
        std::time::Duration::from_secs_f64(self.samples.len() as f64 / self.rate as f64)
    }
}

impl MikTamponu {
    pub(super) fn ekle(&self, mut kare: MikKaresi) {
        if kare.rate == 0 || kare.samples.is_empty() {
            return;
        }
        let mut k = self.durum.lock().unwrap_or_else(|e| e.into_inner());
        let azami = (kare.rate as usize * 4).min(MIK_TAMPON_BAYT / 4);
        if kare.samples.len() > azami {
            kare.samples = kare.samples[kare.samples.len() - azami..].into();
            k.dusen += 1;
        }
        let bayt = kare.samples.len() * std::mem::size_of::<f32>();
        while !k.kareler.is_empty()
            && (k.sure + kare.suresi() > MIK_TAMPON_SURE
                || k.bayt + bayt > MIK_TAMPON_BAYT
                || k.kareler.len() >= 4096)
        {
            k.cikar();
            k.dusen += 1;
        }
        k.sure += kare.suresi();
        k.bayt += bayt;
        k.kareler.push_back(kare);
        drop(k);
        self.hazir.notify_one();
    }

    pub(super) fn al(&self) -> Option<MikKaresi> {
        let mut k = self.durum.lock().unwrap_or_else(|e| e.into_inner());
        if k.dusen > 0 {
            eprintln!(
                "[live] UYARI: {} eski mikrofon karesi dusuruldu (4 sn tampon dolu)",
                std::mem::take(&mut k.dusen)
            );
        }
        k.cikar()
    }

    pub(super) async fn recv(&self) -> MikKaresi {
        loop {
            let hazir = self.hazir.notified();
            if let Some(kare) = self.al() {
                return kare;
            }
            hazir.await;
        }
    }
}

pub(super) fn mik_kare_guncel(kare_sur: u64, simdiki_sur: u64) -> bool {
    kare_sur == simdiki_sur
}

pub(super) fn mikrofon_adim(
    mik: &mut Option<(
        crate::audio::vad::MikKapisi,
        crate::audio::vad::KonusmaIzleyici,
    )>,
    buf16k: &[f32],
    mik_kapali: bool,
) -> Vec<crate::audio::vad::KapiCikti> {
    mikrofon_adim_izli(mik, buf16k, mik_kapali, |_, _, _, _| {})
}
pub(super) fn mikrofon_adim_izli(
    mik: &mut Option<(
        crate::audio::vad::MikKapisi,
        crate::audio::vad::KonusmaIzleyici,
    )>,
    buf16k: &[f32],
    mik_kapali: bool,
    mut izle: impl FnMut(usize, crate::audio::vad::KareDurumu, &[crate::audio::vad::KapiCikti], usize),
) -> Vec<crate::audio::vad::KapiCikti> {
    use crate::audio::vad::{KapiCikti, KareDurumu};
    let Some((kapi, izleyici)) = mik.as_mut() else {
        // Resampler onceki acik karenin son ornegini tasiyabilir. Continuous
        // kipte de susturma/yanki sinirindan tek bir ses ornegi sizmasin.
        return vec![KapiCikti::Ses(if mik_kapali {
            vec![0.0; buf16k.len()]
        } else {
            buf16k.to_vec()
        })];
    };
    if mik_kapali {
        izleyici.sifirla();
        let cikti = kapi.adim(buf16k, KareDurumu::Kapali);
        izle(buf16k.len(), KareDurumu::Kapali, &cikti, 0);
        return cikti;
    }
    match izleyici.isle(buf16k) {
        Ok(parcalar) => {
            let mut kalan = parcalar.iter().map(|(ses, _)| ses.len()).sum::<usize>();
            parcalar
                .into_iter()
                .flat_map(|(ses, durum)| {
                    kalan -= ses.len();
                    let cikti = kapi.adim(&ses, durum);
                    izle(ses.len(), durum, &cikti, kalan);
                    cikti
                })
                .collect()
        }
        Err(ses) => {
            let giden = kapi.adim(&ses, KareDurumu::Konusma);
            // Bozulmus ONNX state bir daha kullanilmaz: bu oturum continuous.
            *mik = None;
            giden
        }
    }
}

pub(super) fn mik_ariza_bildir(events: &mpsc::UnboundedSender<LiveEvent>) {
    let sebep = "mikrofon kapisi arizalandi: bu oturumda surekli ses aktarimi kullaniliyor";
    eprintln!("[live] {sebep}");
    let _ = events.send(LiveEvent::Tool {
        ad: "mikrofon_akisi".into(),
        durum: TOOL_HATA,
        sebep: Some(sebep.into()),
    });
}

/// 16 kHz mono f32 -> `realtimeInput.audio` JSON cercevesi (s16le, base64).
pub(super) fn ses_cercevesi(kare16k: &[f32]) -> String {
    let mut pcm = Vec::with_capacity(kare16k.len() * 2);
    for s in kare16k {
        pcm.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    serde_json::json!({
        "realtimeInput": {
            "audio": {
                "mimeType": format!("audio/pcm;rate={IN_RATE}"),
                "data": base64::engine::general_purpose::STANDARD.encode(&pcm)
            }
        }
    })
    .to_string()
}

/// `realtimeInput.audioStreamEnd=true`: ses akisi durdu, sunucu onbellekteki
/// sesi bosaltsin (ai.google.dev/gemini-api/docs/live-guide: akis bir saniyeden
/// uzun duraklarsa gonderilir; otomatik etkinlik algilama ACIKKEN gecerlidir,
/// bu projede acik). Akis yeni bir `audio` mesajiyla yeniden acilir.
pub(super) fn akis_sonu_cercevesi() -> String {
    serde_json::json!({ "realtimeInput": { "audioStreamEnd": true } }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kopusta_yalniz_tam_ifade_bir_kez_yeniden_gonderilir() {
        let mut koruma = IfadeKoruma::default();
        koruma.ses(&[0.1, 0.2, 0.3]);
        assert_eq!(koruma.akis_sonu(), Some(1));
        koruma.koptu(false);
        assert_eq!(
            koruma.kurtarmayi_al(),
            Some(KesintiKurtarma::TamIfade {
                id: 1,
                ses: vec![0.1, 0.2, 0.3]
            })
        );
        koruma.koptu(false);
        assert_eq!(
            koruma.kurtarmayi_al(),
            None,
            "ayni ifade ikinci kez replay edilmez"
        );
    }

    #[test]
    fn kopusta_kismi_ifade_atilir_ve_tekrar_istenir() {
        let mut koruma = IfadeKoruma::default();
        koruma.ses(&[0.4, 0.5]);
        koruma.koptu(true);
        assert_eq!(
            koruma.kurtarmayi_al(),
            Some(KesintiKurtarma::TekrarIste { id: None })
        );
        assert_eq!(koruma.akis_sonu(), None, "kismi ses yeni oturuma sizmaz");
    }

    #[test]
    fn cevap_baslamis_veya_tamamlanmis_ifade_replay_edilmez() {
        for tamamlandi in [false, true] {
            let mut koruma = IfadeKoruma::default();
            koruma.ses(&[0.1]);
            koruma.akis_sonu();
            if tamamlandi {
                koruma.tur_bitti();
            } else {
                koruma.cevap_basladi();
            }
            koruma.koptu(false);
            assert_eq!(koruma.kurtarmayi_al(), None);
        }
    }

    #[test]
    fn saha_tampon_dort_saniye_ve_en_yeni_sesi_korur() {
        for rate in [16_000, 48_000, 192_000] {
            let tampon = MikTamponu::default();
            for n in 0..500 {
                tampon.ekle(MikKaresi {
                    samples: vec![n as f32; rate / 100].into(),
                    rate: rate as u32,
                    kapali: false,
                    at: std::time::Instant::now(),
                    listen_epoch: 0,
                });
            }
            {
                let k = tampon.durum.lock().unwrap();
                assert_eq!(k.kareler.len(), 400);
                assert_eq!(k.dusen, 100);
                assert_eq!(k.sure, MIK_TAMPON_SURE);
                assert!(k.bayt <= MIK_TAMPON_BAYT);
            }
            for n in 100..500 {
                assert_eq!(tampon.al().unwrap().samples[0], n as f32);
            }
            assert!(tampon.al().is_none());
        }
    }

    #[tokio::test]
    async fn saha_acilis_ontamponu_ve_uyandirma_kayipsiz() {
        let tampon = Arc::new(MikTamponu::default());
        let kare = || MikKaresi {
            samples: vec![0.5; 480].into(),
            rate: 48_000,
            kapali: false,
            at: std::time::Instant::now(),
            listen_epoch: 0,
        };
        tampon.ekle(kare());
        assert_eq!(tampon.durum.lock().unwrap().dusen, 0);
        assert_eq!(tampon.recv().await.samples.len(), 480);
        let alici = tampon.clone();
        let is = tokio::spawn(async move { alici.recv().await });
        tokio::task::yield_now().await;
        tampon.ekle(kare());
        assert_eq!(is.await.unwrap().samples.len(), 480);
    }
    use crate::audio::resample::LinearResampler;
    use crate::audio::speaker::SpeakerVerdict;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    #[test]
    fn stt_canli_tutma_saf_bes_dakika_zamanlamasi() {
        let t = std::time::Instant::now();
        let sn = std::time::Duration::from_secs;
        let mut zamanlama = SttCanliTutma::default();
        for kip in [DinlemeKipi::Herkes, DinlemeKipi::YalnizBeni] {
            assert_eq!(zamanlama.zamanla(kip as u64, t), (false, None));
        }
        let isimle = DinlemeKipi::Isimle as u64;
        assert_eq!(zamanlama.zamanla(isimle, t), (false, Some(sn(300))));
        assert_eq!(zamanlama.zamanla(isimle, t + sn(299)), (false, Some(sn(1))));
        assert_eq!(
            zamanlama.zamanla(isimle, t + sn(300)),
            (true, Some(sn(300)))
        );
        // Ayni anda uyanma veya basarisiz istek tekrar deneme dongusu yaratmaz.
        assert_eq!(
            zamanlama.zamanla(isimle, t + sn(300)),
            (false, Some(sn(300)))
        );
        assert_eq!(zamanlama.zamanla(isimle, t + sn(599)), (false, Some(sn(1))));
        assert_eq!(
            zamanlama.zamanla(isimle, t + sn(600)),
            (true, Some(sn(300)))
        );
        // Uzun uyku sonrasi kacirilan periyotlar topluca gonderilmez.
        assert_eq!(
            zamanlama.zamanla(isimle, t + sn(3600)),
            (true, Some(sn(300)))
        );
        assert_eq!(
            zamanlama.zamanla(isimle, t + sn(3600)),
            (false, Some(sn(300)))
        );
    }

    #[test]
    fn stt_canli_tutma_cikista_durur_yeni_giriste_sifirlanir() {
        let t = std::time::Instant::now();
        let sn = std::time::Duration::from_secs;
        for kip in [DinlemeKipi::Herkes, DinlemeKipi::YalnizBeni] {
            let mut zamanlama = SttCanliTutma::default();
            assert_eq!(zamanlama.zamanla(2, t), (false, Some(sn(300))));
            assert_eq!(
                zamanlama.zamanla(4 | kip as u64, t + sn(300)),
                (false, None)
            );
            assert_eq!(
                zamanlama.zamanla(4 | kip as u64, t + sn(900)),
                (false, None)
            );
            assert_eq!(zamanlama.zamanla(10, t + sn(901)), (false, Some(sn(300))));
            assert_eq!(zamanlama.zamanla(10, t + sn(1201)), (true, Some(sn(300))));
            // Worker cikisi gormeden hizla yeniden girilse de epoch degisir.
            assert_eq!(zamanlama.zamanla(18, t + sn(1501)), (false, Some(sn(300))));
        }
    }

    #[test]
    fn stt_isinma_butcesi_saf_durum_gecisleri() {
        let t = std::time::Instant::now();
        let (tx, rx) = tokio::sync::watch::channel(None);
        let isinma = SttIsinma {
            son: t + STT_ISINMA_SURESI,
            sonuc: rx,
        };
        assert_eq!(isinma.kalan(t), Ok(STT_ISINMA_SURESI));
        assert_eq!(
            isinma.kalan(t + std::time::Duration::from_secs(14)),
            Ok(std::time::Duration::from_secs(16))
        );
        assert_eq!(isinma.kalan(t + STT_ISINMA_SURESI), Err(()));
        tx.send(Some(false)).unwrap();
        assert_eq!(isinma.kalan(t), Err(()));
        tx.send(Some(true)).unwrap();
        assert_eq!(
            isinma.kalan(t + STT_ISINMA_SURESI),
            Ok(std::time::Duration::ZERO)
        );
        // Isinma basarisi hitap/takip izni vermez.
        assert_eq!(IsimKapisi::default().karar(Ok("adsiz"), t), Ok(false));
    }

    #[tokio::test]
    async fn stt_ilk_ifade_isinmayi_bekler_ve_ayni_pcm_gonderilir() {
        use std::io::{Read, Write};
        let server = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = server.local_addr().unwrap();
        let (gelen_tx, gelen_rx) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let (mut sock, _) = server.accept().unwrap();
            let mut request = [0; 8];
            sock.read_exact(&mut request).unwrap();
            gelen_tx.send(request).unwrap();
            let body = br#"{"text":"Smith","device":"cuda"}"#;
            sock.write_all(&(body.len() as u32).to_le_bytes()).unwrap();
            sock.write_all(body).unwrap();
        });
        let (tx, rx) = tokio::sync::watch::channel(None);
        let isinma = Arc::new(SttIsinma {
            son: std::time::Instant::now() + STT_ISINMA_SURESI,
            sonuc: rx,
        });
        let ilk_ifade = yerel_stt(vec![0.25], Some(isinma), addr);
        tokio::pin!(ilk_ifade);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(30), &mut ilk_ifade)
                .await
                .is_err()
        );
        assert!(gelen_rx.try_recv().is_err(), "isinmadan decode gonderildi");
        tx.send(Some(true)).unwrap();
        assert_eq!(ilk_ifade.await, Ok("Smith".into()));
        let request = gelen_rx.recv().unwrap();
        assert_eq!(
            u32::from_le_bytes(request[..4].try_into().unwrap()),
            0x8000_0001
        );
        assert_eq!(f32::from_le_bytes(request[4..].try_into().unwrap()), 0.25);
        thread.join().unwrap();
    }

    #[tokio::test]
    async fn stt_isinma_hatasi_ve_sure_asimi_ilk_ifadeyi_kapali_tutar() {
        for sonuc in [Some(false), None] {
            let (_tx, rx) = tokio::sync::watch::channel(sonuc);
            let isinma = Arc::new(SttIsinma {
                son: std::time::Instant::now(),
                sonuc: rx,
            });
            let metin = yerel_stt(
                vec![0.25],
                Some(isinma),
                std::net::SocketAddr::from(([127, 0, 0, 1], 0)),
            )
            .await;
            assert_eq!(metin, Err(()));
            assert_eq!(
                IsimKapisi::default()
                    .karar(metin.as_deref().map_err(|_| ()), std::time::Instant::now()),
                Err(ADLA_UYARI)
            );
        }
    }

    #[test]
    fn stt_isitma_tcp_pcm_yollamaz_ve_acik_hazir_onayi_ister() {
        use std::io::{Read, Write};
        for (body, basarili) in [
            (r#"{"text":"","device":"cuda","ready":true}"#, true),
            (r#"{"text":"","device":"cuda"}"#, false),
            (r#"{"text":"","device":"deepgram","ready":true}"#, false),
            (r#"{"error":"model yok"}"#, false),
        ] {
            let server = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let addr = server.local_addr().unwrap();
            let thread = std::thread::spawn(move || {
                let (mut sock, _) = server.accept().unwrap();
                let mut header = [0; 4];
                sock.read_exact(&mut header).unwrap();
                assert_eq!(u32::from_le_bytes(header), 0x8000_0000);
                sock.write_all(&(body.len() as u32).to_le_bytes()).unwrap();
                sock.write_all(body.as_bytes()).unwrap();
            });
            assert_eq!(
                stt_istegi(&[], addr, std::time::Duration::from_secs(2)).is_ok(),
                basarili
            );
            thread.join().unwrap();
        }
    }

    #[test]
    fn isimle_stt_tcp_sozlesmesi_ve_hatalar() {
        use std::io::{Read, Write};
        for (body, beklenen) in [
            (r#"{"text":"Smith","device":"cuda","ms":12}"#, Some("Smith")),
            (r#"{"text":"Smith","device":"cpu","ms":12}"#, Some("Smith")),
            (r#"{"text":"Smith","device":"deepgram"}"#, None),
            (r#"{"error":"model yok"}"#, None),
            ("{", None),
            (r#"{"text":false,"device":"cuda"}"#, None),
        ] {
            let server = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let addr = server.local_addr().unwrap();
            let thread = std::thread::spawn(move || {
                let (mut sock, _) = server.accept().unwrap();
                let mut req = [0; 8];
                sock.read_exact(&mut req).unwrap();
                assert_eq!(
                    u32::from_le_bytes(req[..4].try_into().unwrap()),
                    0x8000_0001
                );
                assert_eq!(f32::from_le_bytes(req[4..].try_into().unwrap()), 0.25);
                sock.write_all(&(body.len() as u32).to_le_bytes()).unwrap();
                sock.write_all(body.as_bytes()).unwrap();
            });
            let result = stt_istegi(&[0.25], addr, std::time::Duration::from_secs(2));
            assert_eq!(result.ok().as_deref(), beklenen);
            thread.join().unwrap();
        }
    }

    #[test]
    fn isimle_stt_kismi_yanit_zaman_asimi_ve_kapali_port() {
        use std::io::{Read, Write};
        let server = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = server.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let (mut sock, _) = server.accept().unwrap();
            let mut req = [0; 8];
            sock.read_exact(&mut req).unwrap();
            sock.write_all(&[100, 0]).unwrap(); // Yarim uzunluk basligi.
            let mut end = [0; 1];
            sock.set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let _ = sock.read(&mut end);
        });
        assert!(stt_istegi(&[0.25], addr, std::time::Duration::from_millis(100)).is_err());
        thread.join().unwrap();
        assert!(stt_istegi(&[0.25], addr, std::time::Duration::from_millis(100)).is_err());
    }

    #[test]
    fn isimle_ts_ile_ayni_hitap_vektorleri() {
        let ts = include_str!("../../../../src/dispatchUtterance.test.ts");
        let json = ts
            .split("/* wake-vectors:start */")
            .nth(1)
            .unwrap()
            .split("/* wake-vectors:end */")
            .next()
            .unwrap()
            .trim()
            .trim_end_matches(';');
        let vektorler: Vec<(String, bool)> = serde_json::from_str(json).unwrap();
        assert_eq!(vektorler.len(), 32);
        for (metin, beklenen) in vektorler {
            assert_eq!(adla_seslenildi(&metin), beklenen, "{metin}");
        }
    }

    #[test]
    fn isimle_ad_gonderim_takip_tazeleme_ve_tam_sinir() {
        let mut kapi = IsimKapisi::default();
        let t = std::time::Instant::now();
        assert_eq!(kapi.karar(Ok("saga gidin"), t), Ok(false));
        assert_eq!(kapi.karar(Ok("Smith ekranimda ne var"), t), Ok(true));
        // Karar tek basina pencere acmaz, yalniz gercek gonderim acar.
        assert_eq!(kapi.karar(Ok("bir de bunu"), t), Ok(false));
        kapi.gonderildi(t);
        assert_eq!(
            kapi.karar(
                Ok("bir de bunu"),
                t + TAKIP_SURESI - std::time::Duration::from_millis(1)
            ),
            Ok(true)
        );
        assert_eq!(kapi.karar(Ok("bir de bunu"), t + TAKIP_SURESI), Ok(false));
        let sonraki = t + std::time::Duration::from_secs(10);
        kapi.gonderildi(sonraki);
        assert_eq!(
            kapi.karar(Ok("acikla"), t + std::time::Duration::from_secs(20)),
            Ok(true)
        );
        assert_eq!(kapi.karar(Ok("acikla"), sonraki + TAKIP_SURESI), Ok(false));
    }

    #[test]
    fn isimle_stt_hatasi_acik_pencerede_bile_atilir_ve_uyarilir() {
        let mut kapi = IsimKapisi::default();
        let t = std::time::Instant::now();
        for acik in [false, true] {
            if acik {
                kapi.gonderildi(t);
            }
            assert_eq!(kapi.karar(Err(()), t), Err(ADLA_UYARI));
            assert_eq!(kapi.karar(Ok(""), t), Ok(false));
        }
        assert_eq!(kapi.karar(Ok("adsiz"), t + TAKIP_SURESI), Ok(false));
    }

    #[test]
    fn kip_degisiminde_tek_tampon_ve_takip_temizlenir() {
        use crate::audio::vad::{KapiCikti, SahipTamponu};
        let mut tampon = SahipTamponu::default();
        let mut isim = IsimKapisi::default();
        let t = std::time::Instant::now();
        tampon.tut(KapiCikti::Ses(vec![0.3; 512]));
        isim.gonderildi(t);
        dinleme_tamponunu_sifirla(&mut tampon, &mut isim);
        assert_eq!(tampon.tut(KapiCikti::AkisSonu), Some(vec![]));
        assert_eq!(isim.karar(Ok("adsiz"), t), Ok(false));
        assert!(!mik_kare_guncel(2, 6), "bekleyen STT yeni kipe ait degil");
    }

    #[test]
    fn isimle_proaktif_cikti_kapali_kabul_edilen_tek_tur_acik() {
        let mut izin = YanitIzni::default();
        assert!(!izin.serbest(DinlemeKipi::Isimle, 2));
        izin.gonderildi(2);
        assert!(izin.serbest(DinlemeKipi::Isimle, 2));
        izin.basla();
        assert!(izin.serbest(DinlemeKipi::Isimle, 2));
        assert!(!izin.serbest(DinlemeKipi::Isimle, 6));
        izin.bitir();
        assert!(!izin.serbest(DinlemeKipi::Isimle, 2));
        assert!(izin.serbest(DinlemeKipi::Herkes, 0));
        assert!(izin.serbest(DinlemeKipi::YalnizBeni, 1));
    }

    #[test]
    fn isimle_eski_tur_kapanisi_yeni_takip_istegini_susturmaz() {
        let mut izin = YanitIzni::default();
        izin.gonderildi(2);
        izin.basla();
        izin.gonderildi(2); // Smith konusurken yeni kullanici ifadesi.
        izin.bitir(); // Eski turun interrupted veya turnComplete olayi.
        assert!(izin.serbest(DinlemeKipi::Isimle, 2));
        izin.bitir(); // Ardindan gelen eski turnComplete de zararsiz.
        assert!(izin.serbest(DinlemeKipi::Isimle, 2));
        izin.basla();
        izin.bitir();
        assert!(!izin.serbest(DinlemeKipi::Isimle, 2));
    }

    #[test]
    fn isimle_izinsiz_arac_yanitla_reddedilir_beklemede_kalmaz() {
        let calls = vec![serde_json::json!({"id":"oyun-1","name":"ekrani_net_gor"})];
        let frame: serde_json::Value = serde_json::from_str(&isimle_arac_reddi(&calls)).unwrap();
        let responses = frame["toolResponse"]["functionResponses"]
            .as_array()
            .unwrap();
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0]["id"], "oyun-1");
        assert_eq!(responses[0]["name"], "ekrani_net_gor");
        assert!(responses[0]["response"]["hata"]
            .as_str()
            .unwrap()
            .contains("Oyun modu"));
    }

    #[test]
    fn isimle_tekrar_secim_ve_gec_sonuc_proaktif_izin_acamaz() {
        let mut izin = YanitIzni::default();
        izin.gonderildi(2);
        izin.basla();
        izin.gecis_onayi(None, 2); // Ayni kipe tekrar gecis.
        izin.bitir();
        assert!(!izin.serbest(DinlemeKipi::Isimle, 2));
        izin.gecis_onayi(Some(2), 6); // Eski aracin gec sonucu.
        assert!(!izin.serbest(DinlemeKipi::Isimle, 6));
        izin.gecis_onayi(Some(6), 6); // Gercek sesli geciste tek onay.
        izin.basla();
        izin.bitir();
        assert!(!izin.serbest(DinlemeKipi::Isimle, 6));
    }

    #[test]
    fn kip_env_ve_eski_sesli_arac_sozlesmesi() {
        assert_eq!(DinlemeKipi::env(None, Some("1")), DinlemeKipi::YalnizBeni);
        assert_eq!(DinlemeKipi::env(None, None), DinlemeKipi::Herkes);
        for kip in [
            DinlemeKipi::Herkes,
            DinlemeKipi::YalnizBeni,
            DinlemeKipi::Isimle,
        ] {
            assert_eq!(DinlemeKipi::env(Some(kip.ad()), Some("1")), kip);
            assert_eq!(
                DinlemeKipi::arguman(&serde_json::json!({"kip": kip})),
                Some(kip)
            );
        }
        assert_eq!(
            DinlemeKipi::arguman(&serde_json::json!({"yalniz_beni": true})),
            Some(DinlemeKipi::YalnizBeni)
        );
        assert_eq!(
            DinlemeKipi::arguman(&serde_json::json!({"yalniz_beni": false})),
            Some(DinlemeKipi::Herkes)
        );
        assert_eq!(
            DinlemeKipi::arguman(&serde_json::json!({"kip":"bozuk", "yalniz_beni":true})),
            None
        );
    }

    #[test]
    fn a2_mod_degisiminde_kuyruktaki_eski_kareler_atilir() {
        assert!(mik_kare_guncel(0, 0));
        assert!(mik_kare_guncel(1, 1));
        assert!(!mik_kare_guncel(1, 4));
        assert!(!mik_kare_guncel(0, 1));
        assert!(!mik_kare_guncel(1, 9), "ac/kapat/ac eski sesi diriltemez");
    }

    #[test]
    fn a2_buyuk_callback_kisa_ifadeyi_sonraki_sesten_ayirir() {
        use crate::audio::vad::SahipTamponu;
        // 320 ms A, 1024 ms sessizlik, 960 ms B, 1024 ms sessizlik.
        let probs: Vec<f32> = [vec![1.0; 10], vec![0.0; 32], vec![1.0; 30], vec![0.0; 32]].concat();
        let mut mik = denetim_mik(&probs);
        let mut tampon = SahipTamponu::default();
        let mut ifadeler = Vec::new();
        let now = std::time::Instant::now();
        mikrofon_adim_izli(
            &mut mik,
            &vec![0.2; probs.len() * 512],
            false,
            |n, durum, cikti, kalan| {
                if let Some(ifade) = tampon.isle(
                    n,
                    durum,
                    cikti,
                    now - std::time::Duration::from_secs_f64(kalan as f64 / 16_000.0),
                ) {
                    ifadeler.push(ifade);
                }
            },
        );
        assert_eq!(ifadeler.len(), 2);
        assert_eq!(ifadeler[0].konusma_ornek, 10 * 512);
        assert_eq!(ifadeler[1].konusma_ornek, 30 * 512);
        assert!(ifadeler[0].konusma_ornek < crate::audio::speaker::MIN_OWNER_SAMPLES);
        assert!(ifadeler[1].konusma_ornek >= crate::audio::speaker::MIN_OWNER_SAMPLES);
        assert!(ifadeler[0].son_konusma < ifadeler[1].son_konusma);
    }

    #[test]
    fn a2_kapali_mod_eski_kareler_ve_akis_sonu() {
        use crate::audio::vad::KapiCikti;
        // Bu yol owner tamponunu kullanmaz: ilk konusma karesi aninda cikar.
        let mut mik = denetim_mik(&[0.0, 1.0, 0.0]);
        assert!(mikrofon_adim(&mut mik, &[0.1; 512], false).is_empty());
        assert_eq!(
            mikrofon_adim(&mut mik, &[0.2; 512], false),
            vec![KapiCikti::Ses([vec![0.1; 512], vec![0.2; 512]].concat())]
        );
        assert_eq!(
            mikrofon_adim(&mut mik, &[0.3; 512], false),
            vec![KapiCikti::Ses(vec![0.3; 512])]
        );
        assert_eq!(
            mikrofon_adim(&mut mik, &[0.4; 512], true),
            vec![KapiCikti::AkisSonu]
        );
        assert_eq!(
            mikrofon_adim(&mut None, &[0.5; 320], false),
            vec![KapiCikti::Ses(vec![0.5; 320])]
        );
        assert_eq!(
            mikrofon_adim(&mut None, &[0.5; 320], true),
            vec![KapiCikti::Ses(vec![0.0; 320])]
        );
    }

    #[test]
    fn a2_tampon_gonderim_referansi_yerel_websocket() {
        // Mikrofon, ses cihazi ve bulut yok. Uretim PCM kodlayicisi + WS sink.
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            for saniye in [2, 30] {
                let mut sureler = Vec::new();
                for _ in 0..5 {
                    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                    let addr = listener.local_addr().unwrap();
                    let alici = tokio::spawn(async move {
                        let (tcp, _) = listener.accept().await.unwrap();
                        let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                        let mut frames = Vec::new();
                        for _ in 0..2 { frames.push(ws.next().await.unwrap().unwrap()); }
                        frames
                    });
                    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}")).await.unwrap();
                    let ses = vec![0.125; saniye * 16_000];
                    let bas = std::time::Instant::now();
                    ws.send(Message::Text(ses_cercevesi(&ses))).await.unwrap();
                    ws.send(Message::Text(akis_sonu_cercevesi())).await.unwrap();
                    sureler.push(bas.elapsed().as_micros());
                    let frames = alici.await.unwrap();
                    let v: serde_json::Value = serde_json::from_str(frames[0].to_text().unwrap()).unwrap();
                    let bytes = base64::engine::general_purpose::STANDARD.decode(v["realtimeInput"]["audio"]["data"].as_str().unwrap()).unwrap();
                    assert_eq!(bytes.len(), ses.len()*2);
                    assert_eq!(frames[1].to_text().unwrap(), akis_sonu_cercevesi());
                }
                sureler.sort();
                eprintln!("[a2-olcum] {saniye} sn tampon: medyan={} us min={} us max={} us (5 kosu, yerel WS)", sureler[2], sureler[0], sureler[4]);
            }
        });
    }

    #[test]
    fn continuous_susturma_resampler_artigini_da_siler() {
        let mut rs = LinearResampler::new(48_000, IN_RATE);
        let mut buf = Vec::new();
        rs.process(&[1.0; 4], &mut buf);
        buf.clear();
        rs.process(&[0.0; 4], &mut buf);
        assert!(
            buf.iter().any(|s| *s != 0.0),
            "resampler artik sesi uretmeli"
        );
        assert_eq!(
            mikrofon_adim(&mut None, &buf, true),
            vec![crate::audio::vad::KapiCikti::Ses(vec![0.0; buf.len()])]
        );
        assert_eq!(
            mikrofon_adim(&mut None, &buf, false),
            vec![crate::audio::vad::KapiCikti::Ses(buf)]
        );
    }

    // ---- MIKROFON KAPISI (live.rs tarafi) ----

    #[test]
    fn mik_akisi_varsayilan_gated_yalniz_continuous_eskiye_doner() {
        assert_eq!(mik_akisi_niyeti(None), MikAkisi::Gated);
        assert_eq!(mik_akisi_niyeti(Some("")), MikAkisi::Gated);
        assert_eq!(mik_akisi_niyeti(Some("gated")), MikAkisi::Gated);
        assert_eq!(mik_akisi_niyeti(Some("continuous")), MikAkisi::Continuous);
        assert_eq!(
            mik_akisi_niyeti(Some("  CONTINUOUS ")),
            MikAkisi::Continuous
        );
        // Taninmayan deger faturayi koruyan tarafa (gated) duser.
        assert_eq!(mik_akisi_niyeti(Some("hep")), MikAkisi::Gated);
        assert_eq!(mik_akisi_niyeti(Some("0")), MikAkisi::Gated);
    }

    #[test]
    fn ses_cercevesi_realtime_input_audio_semasina_uyar() {
        let kare: Vec<f32> = vec![0.0, 0.5, -0.5, 1.0, -1.0, 2.0];
        let v: serde_json::Value = serde_json::from_str(&ses_cercevesi(&kare)).expect("JSON");
        let a = &v["realtimeInput"]["audio"];
        assert_eq!(a["mimeType"], "audio/pcm;rate=16000");
        let b64 = a["data"].as_str().expect("data");
        let ham = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .expect("base64");
        assert_eq!(ham.len(), kare.len() * 2);
        let ornekler: Vec<i16> = ham
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect();
        assert_eq!(ornekler[0], 0);
        assert_eq!(ornekler[3], 32767);
        assert_eq!(ornekler[4], -32767);
        assert_eq!(ornekler[5], 32767, "kirpilma: 2.0 -> tam olcek");
        assert!(v["realtimeInput"].get("audioStreamEnd").is_none());
        assert!(v["realtimeInput"].get("mediaChunks").is_none());
    }

    #[test]
    fn akis_sonu_cercevesi_yalniz_audio_stream_end_tasir() {
        let v: serde_json::Value = serde_json::from_str(&akis_sonu_cercevesi()).expect("JSON");
        assert_eq!(
            v,
            serde_json::json!({ "realtimeInput": { "audioStreamEnd": true } })
        );
    }

    struct DenetimVad(std::collections::VecDeque<f32>);
    impl crate::audio::vad::VoiceActivityDetector for DenetimVad {
        fn predict(&mut self, _: Vec<f32>) -> f32 {
            let p = self.0.pop_front().unwrap_or(0.0);
            assert!(!p.is_nan(), "sahte ONNX arizasi");
            p
        }
    }
    fn denetim_mik(
        probs: &[f32],
    ) -> Option<(
        crate::audio::vad::MikKapisi,
        crate::audio::vad::KonusmaIzleyici,
    )> {
        Some((
            crate::audio::vad::MikKapisi::new(1000),
            crate::audio::vad::KonusmaIzleyici::new(Box::new(DenetimVad(
                probs.iter().copied().collect(),
            ))),
        ))
    }
    #[test]
    fn audit_1_cihaz_sifirlari_artik_sureyi_atlamaz() {
        use crate::audio::vad::KapiCikti;
        let mut mik = denetim_mik(&[0.9, 0.0, 0.9]);
        let ses = vec![0.2; 512];
        mikrofon_adim(&mut mik, &ses, false);
        let sifir = vec![0.0; 512];
        let c = mikrofon_adim(&mut mik, &sifir, false);
        assert!(
            !c.contains(&KapiCikti::AkisSonu),
            "cihaz sessizligi erken akis sonu uretti"
        );
        assert_eq!(c, vec![KapiCikti::Ses(sifir)]);
    }
    #[test]
    fn audit_2_tek_callback_kisa_evet_gonderilir() {
        use crate::audio::vad::KapiCikti;
        let mut mik = denetim_mik(&[0.9, 0.2]);
        let ses = vec![0.2; 1024];
        let c = mikrofon_adim(&mut mik, &ses, false);
        let giden: Vec<f32> = c
            .into_iter()
            .flat_map(|p| match p {
                KapiCikti::Ses(v) => v,
                _ => vec![],
            })
            .collect();
        assert_eq!(giden.len(), ses.len(), "kisa evet on-tamponda kaldi");
        assert_eq!(giden, ses);
    }

    #[test]
    fn yumusak_baslangicin_ilk_ornegi_on_tamponda_korunur() {
        use crate::audio::vad::KapiCikti;

        // 640 ms sessizlik + 960 ms yumusak baslangic, sonra guclu konusma.
        // Silero yumusak baslangicta esigi asmasa da ilk sesli ornek gitmeli.
        let mut probs = vec![0.0; 20];
        probs.extend(vec![0.2; 30]);
        probs.push(0.9);
        let mut mik = denetim_mik(&probs);
        let mut ses = vec![0.0; 20 * 512];
        ses.extend(vec![0.02; 30 * 512]);
        ses.extend(vec![0.2; 512]);

        let giden: Vec<f32> = mikrofon_adim(&mut mik, &ses, false)
            .into_iter()
            .flat_map(|parca| match parca {
                KapiCikti::Ses(ses) => ses,
                KapiCikti::AkisSonu => Vec::new(),
            })
            .collect();

        let ilk_sesli = giden
            .iter()
            .position(|ornek| *ornek != 0.0)
            .expect("yumusak baslangic gonderilmeli");
        assert_eq!(ilk_sesli, 20 * 512, "ilk hecenin ilk ornegi korunmali");
        assert_eq!(giden.len(), 51 * 512, "1.6 sn on-tampon ve tetik parcasi");
    }
    #[test]
    fn audit_3_vad_panigi_oturumu_continuous_yapar() {
        use crate::audio::vad::KapiCikti;
        let mut mik = denetim_mik(&[f32::NAN]);
        let ses = vec![0.2; 512];
        let c = mikrofon_adim(&mut mik, &ses, false);
        assert!(mik.is_none(), "arizali VAD tekrar kullanilamaz");
        assert_eq!(c, vec![KapiCikti::Ses(ses.clone())]);
        assert_eq!(mikrofon_adim(&mut mik, &ses, false), c);
    }

    #[test]
    fn audit_3_ariza_bir_kez_bildirilir_sonraki_kareler_akar() {
        let mut mik = denetim_mik(&[0.9, f32::NAN]);
        let (tx, mut rx) = mpsc::unbounded_channel();
        for _ in 0..3 {
            let gated = mik.is_some();
            let c = mikrofon_adim(&mut mik, &vec![0.2; 1024], false);
            if gated && mik.is_none() {
                mik_ariza_bildir(&tx);
            }
            let toplam: usize = c
                .iter()
                .map(|p| match p {
                    crate::audio::vad::KapiCikti::Ses(v) => v.len(),
                    _ => 0,
                })
                .sum();
            assert_eq!(toplam, 1024, "panic oncesindeki chunk da kaybolmamali");
        }
        assert!(
            matches!(rx.try_recv().unwrap(), LiveEvent::Tool { ad, durum: TOOL_HATA, .. } if ad == "mikrofon_akisi")
        );
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn audit_5_uzun_ifade_bolunmesi_devam_eden_sesi_yetkilendirmez() {
        use crate::audio::vad::{SpeechEvent, SpeechSegmenter};
        let mut seg = SpeechSegmenter::new(Box::new(DenetimVad(vec![0.9; 480].into())), 16000);
        let ev = seg.feed(&vec![0.2; 512 * 480]);
        assert!(
            ev.iter().any(|e| matches!(e, SpeechEvent::Final(_))),
            "uzun ifade bolunmeli"
        );
        assert!(seg.konusuyor(), "Final sonrasi konusma suruyor");
        // Worker once bu Final'i Owner dogrular, sonra kareyi tamamlar.
        let g = crate::audio::speaker::SpeakerGate::armed_for_test(SpeakerVerdict::Owner);
        let no = g.kare_sirala();
        g.kare_islendi(no, seg.konusuyor());
        assert!(
            g.check_tool("ekran_akisi").is_err(),
            "konusma bitmeden parcali Owner kullanildi"
        );
    }

    #[test]
    fn audit_2_callback_sinirlari_sesi_kaybetmez_ve_tekrarlamaz() {
        use crate::audio::vad::KapiCikti;
        let mut mik = denetim_mik(&[0.9, 0.2, 0.9]);
        let ses: Vec<f32> = (0..1536).map(|i| i as f32 / 1536.0).collect();
        let giden: Vec<f32> = [&ses[..300], &ses[300..900], &ses[900..]]
            .into_iter()
            .flat_map(|kare| mikrofon_adim(&mut mik, kare, false))
            .flat_map(|p| match p {
                KapiCikti::Ses(v) => v,
                _ => vec![],
            })
            .collect();
        assert_eq!(giden, ses);
    }
}
