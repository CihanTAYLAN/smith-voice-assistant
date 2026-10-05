//! TTS playback — cpal cikis stream'i + ornek kuyrugu + cikis referans muslugu.
//!
//! TextToSpeechEngine'in urettigi mono f32 tamponlar cihaz cikis frekansina
//! resample edilip bir kuyruga girer; cpal output callback'i kuyruktan tuketir
//! (mono → cihaz kanallarina kopyalanir). Kuyruk `clear()` ile aninda
//! bosaltilabilir — Faz 3 barge-in ve tur-sinir/cancel dikisi. cpal Stream cogu
//! platformda !Send oldugu icin capture.rs gibi kendi thread'inde yasar.
//!
//! CIKIS REFERANSI (Faz 3): callback her blokta cihaza YAZDIGI mono orneklerin
//! RMS'ini bir enerji zarfina (`OutputEnvelope`) isler; `OutputReference` bu
//! zarfi thread'ler arasi okunabilir kilar. Neden gerekli: AEC (akustik yanki
//! bastirma) Faz 6'da. Bugun hoparlorden cikan Smith'in kendi sesi mikrofona
//! geri giriyor, yani naif bir "VAD konusma gordu → sozunu kes" kurali Smith'i
//! KENDI sesiyle susturur. Ayirt etmenin yolu mikrofon enerjisini o an calan
//! sesin enerjisiyle karsilastirmaktir; bu modul o karsilastirmanin "biz ne
//! caliyorduk" tarafini saglar. Karar mantigi burada degil, `bargein.rs`'te.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};

use super::resample::LinearResampler;
use super::{AudioError, MAX_QUEUED_SECONDS};

type Queue = Arc<Mutex<PlaybackQueue>>;

/// Oynatma kuyrugu: en fazla `MAX_QUEUED_SECONDS` ses tutar (bellek koruyucusu;
/// ses gercek zamandan hizli gelir, tavan uzun cevabi kirpmayacak kadar genis).
/// Asilirsa en ESKI ornekler atilir; kuyrukta `MAX_QUEUED_SECONDS`ten uzun
/// bekleyen ses de BAYATTIR ve calinmaz (takili ama olu isaretlenmemis cihaz).
/// Olu stream, yeniden kurulum ve `Interrupted`ta kuyruk ayrica temizlenir.
#[derive(Default)]
struct PlaybackQueue {
    samples: VecDeque<f32>,
    /// (kuyruga giris ani, o parcadan kalan ornek). Toplami `samples.len()`dir.
    ages: VecDeque<(std::time::Instant, usize, Option<Arc<AtomicU64>>)>,
    /// Kota veya bayatlik yuzunden atilan toplam ornek (sayac).
    dropped: u64,
    /// `dropped`in loga yansiyan kismi: callback'te `eprintln` stderr borusunda
    /// bloke olabilir, bu yuzden sayac orada artar, log izleyici thread'inde
    /// basilir (`atilani_bildir`).
    bildirilen: u64,
}

impl PlaybackQueue {
    fn clear(&mut self) -> usize {
        let kayip = self.samples.len();
        self.samples.clear();
        self.ages.clear();
        kayip
    }

    fn consumed(&mut self, mut count: usize) {
        while count > 0 {
            let Some((_, n, marker)) = self.ages.front_mut() else {
                break;
            };
            if marker.is_some() {
                if let Some(marker) = marker.take() {
                    let _ = marker.compare_exchange(
                        0,
                        super::live::monotonic_millis(),
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    );
                }
            }
            let take = count.min(*n);
            *n -= take;
            count -= take;
            if *n == 0 {
                self.ages.pop_front();
            }
        }
    }

    fn discard(&mut self, count: usize) {
        self.samples.drain(..count);
        self.consumed(count);
        self.dropped += count as u64;
    }

    fn expire(&mut self, now: std::time::Instant) {
        let count = self
            .ages
            .iter()
            .take_while(|(at, _, _)| {
                now.saturating_duration_since(*at).as_secs() >= MAX_QUEUED_SECONDS as u64
            })
            .map(|(_, count, _)| *count)
            .sum::<usize>();
        if count > 0 {
            self.discard(count);
        }
    }

    /// Son bildirimden beri atilan ornek sayisi ve toplam; yoksa `None`.
    fn atilani_bildir(&mut self) -> Option<(u64, u64)> {
        let yeni = self.dropped - self.bildirilen;
        self.bildirilen = self.dropped;
        (yeni > 0).then_some((yeni, self.dropped))
    }
}

/// Kota/bayatlik yuzunden atilan sesi loglar (sayac ve gerekce).
fn atilani_bildir(queue: &Queue) {
    let Ok(mut q) = queue.lock() else {
        return;
    };
    if let Some((yeni, toplam)) = q.atilani_bildir() {
        eprintln!(
            "[playback] {yeni} ornek atildi (kuyruk siniri {MAX_QUEUED_SECONDS} sn asildi veya ses bayatladi; toplam={toplam})"
        );
    }
}

#[cfg(test)]
impl From<Vec<f32>> for PlaybackQueue {
    fn from(samples: Vec<f32>) -> Self {
        let mut queue = Self::default();
        if !samples.is_empty() {
            queue
                .ages
                .push_back((std::time::Instant::now(), samples.len(), None));
        }
        queue.samples = samples.into();
        queue
    }
}

type EnvelopeRef = Arc<Mutex<OutputEnvelope>>;

/// Zarfin tuttugu en fazla blok sayisi. Blok basina 8 bayt → ~8 KB SABIT
/// bellek. Cihaz cok kucuk bloklarla surse bile (128 kare @48kHz ≈ 2.7 ms)
/// halka buyumez; en eski blok dusurulur.
const HISTORY_BLOCKS: usize = 1024;
/// Zarfin tuttugu en fazla ornek sayisi — 3 sn @48kHz. Sure siniri blok
/// sinirindan ayri tutulur: blok sayisi BELLEGI, ornek sayisi BAYATLIGI
/// sinirlar. Barge-in yalnizca son ~150-300 ms'ye bakar, 3 sn fazlasiyla yeter.
const HISTORY_SAMPLES: usize = 144_000;
/// Bu RMS'in altindaki blok "sessiz yazildi" sayilir (≈ -100 dBFS). Kuyruk
/// bosken yazilan 0.0'lari gercek sesten ayirmak icin esik gerekir.
const SILENCE_RMS: f32 = 1e-5;
/// `is_playing` icin son-yazma penceresi. Cihaz kuyrugu bosaltirken bizim
/// kuyrugumuz ERKEN bosalir ama ses hala duyuluyordur; bu yuzden kuyruga
/// bakmak tek basina yetmez.
const PLAYING_TAIL_MS: u32 = 150;

/// Cihaza yazilan tek bir callback blogunun enerji kaydi.
#[derive(Debug, Clone, Copy)]
struct Block {
    rms: f32,
    samples: u32,
}

/// Cihaza yazilan sesin enerji zarfi: saf, cihazsiz, test edilebilir.
///
/// Ne cpal ne Tauri ne saat bilir — yalnizca "kac ornek, ne guclu" kayitlarini
/// sinirli bir halkada tutar ve gecmise donuk pencere sorgusu yanitlar.
pub struct OutputEnvelope {
    blocks: VecDeque<Block>,
    total_samples: usize,
}

impl OutputEnvelope {
    pub fn new() -> Self {
        Self {
            // +1: `push_block` once ekler sonra budar, yani uzunluk anlik olarak
            // HISTORY_BLOCKS+1'e cikar. Kapasiteyi bastan buna gore ayirmak
            // callback'te YENIDEN TAHSIS olmamasini garanti eder.
            blocks: VecDeque::with_capacity(HISTORY_BLOCKS + 1),
            total_samples: 0,
        }
    }

    /// Bir cikis blogunun kaydi: `samples` ornek yazildi, guclerinin RMS'i
    /// `rms`. Gercek zamanli callback'ten cagrilir — tahsis yapmaz.
    pub fn push_block(&mut self, rms: f32, samples: usize) {
        if samples == 0 {
            return;
        }
        // NaN/inf zarfi kalici olarak zehirler (tum pencere ortalamalari NaN
        // olur); sessizlige indir. RMS tanimi geregi negatif olamaz.
        let rms = if rms.is_finite() { rms.abs() } else { 0.0 };
        let samples = u32::try_from(samples).unwrap_or(u32::MAX);

        self.blocks.push_back(Block { rms, samples });
        self.total_samples = self.total_samples.saturating_add(samples as usize);

        // Iki sinir birden: blok sayisi (bellek) ve ornek sayisi (bayatlik).
        // Tek blok butcesi asiyorsa dusurme — yoksa gecmis tamamen bosalir.
        while self.blocks.len() > HISTORY_BLOCKS
            || (self.total_samples > HISTORY_SAMPLES && self.blocks.len() > 1)
        {
            match self.blocks.pop_front() {
                Some(b) => self.total_samples -= b.samples as usize,
                None => break,
            }
        }
    }

    /// "Simdiden `back_ms` once BASLAYIP geriye dogru `window_ms` uzanan"
    /// pencerede cihaza yazilan sesin RMS'i, yani [now-back-window, now-back).
    ///
    /// `back_ms` yanki gecikmesi payidir: mikrofon bizim sesimizi ~10-100 ms
    /// sonra duyar, dolayisiyla mikrofonun SIMDIKI penceresiyle karsilastirilmasi
    /// gereken sey bizim BIRAZ ONCE yazdigimizdir.
    ///
    /// Bloklarin ici homojen kabul edilir (blok basina tek RMS tutuluyor);
    /// kesisen kisimlar ornek sayisiyla agirliklandirilir. Pencere gecmisi kismen
    /// asiyorsa yalnizca BILINEN kisim ortalanir (bilinmeyeni sessizlik saymak
    /// cikis enerjisini oldugundan dusuk gosterir; bu da tam olarak Smith'in
    /// kendi sesiyle susturulmasi riskidir). Kesisim yoksa 0.0.
    pub fn rms_back(&self, back_ms: u32, window_ms: u32, rate: u32) -> f32 {
        if rate == 0 || window_ms == 0 {
            return 0.0;
        }
        let win_start = ms_to_samples(back_ms, rate);
        let win_end = win_start + ms_to_samples(window_ms, rate);
        if win_end == win_start {
            return 0.0;
        }

        let mut energy = 0.0f64;
        let mut covered = 0u64;
        // Bloklarin "simdiden geriye" koordinati: en yeni blogun bitisi 0.
        let mut end_back = 0u64;
        for b in self.blocks.iter().rev() {
            let start_back = end_back + b.samples as u64;
            let lo = end_back.max(win_start);
            let hi = start_back.min(win_end);
            if hi > lo {
                let n = (hi - lo) as f64;
                energy += (b.rms as f64) * (b.rms as f64) * n;
                covered += hi - lo;
            }
            end_back = start_back;
            if end_back >= win_end {
                break;
            }
        }

        if covered == 0 {
            return 0.0;
        }
        (energy / covered as f64).sqrt() as f32
    }

    /// Son `ms` icinde sessiz OLMAYAN bir blok yazildi mi. `is_playing`'in
    /// "cihaz hala bizim sesimizi bosaltiyor" tarafi budur.
    pub fn has_signal_within(&self, ms: u32, rate: u32) -> bool {
        if rate == 0 {
            return false;
        }
        let limit = ms_to_samples(ms, rate);
        let mut end_back = 0u64;
        for b in self.blocks.iter().rev() {
            if end_back >= limit {
                return false;
            }
            if b.rms > SILENCE_RMS {
                return true;
            }
            end_back += b.samples as u64;
        }
        false
    }
}

impl Default for OutputEnvelope {
    fn default() -> Self {
        Self::new()
    }
}

/// ms → ornek. Ara hesap u64: 32 bit'te uzun pencere x yuksek frekans tasar.
fn ms_to_samples(ms: u32, rate: u32) -> u64 {
    ms as u64 * rate as u64 / 1000
}

/// Cikis referansi: playback'in cihaza ne yazdigini okuyan, klonlanabilir ve
/// thread'ler arasi paylasilabilir tutamac. Yalnizca OKUR — kuyruga dokunmaz.
///
/// Cihaz frekansini kendi bilir; cagiran taraf (barge-in) yalnizca ms konusur.
#[derive(Clone)]
pub struct OutputReference {
    queue: Queue,
    envelope: EnvelopeRef,
    // Stream'ten BAGIMSIZ paylasilan frekans: kurtarma sirasinda `build_output`
    // taze cihazin frekansini buraya yazar, bu tutamac onu okur. Boylece cihaz
    // (yeniden) kurulsa da sure/pencere hesaplari dogru rate'i gorur.
    device_rate: Arc<AtomicU32>,
}

impl OutputReference {
    /// Su anda ses cikiyor mu: kuyrukta bekleyen ornek VARSA, ya da son
    /// `PLAYING_TAIL_MS` icinde sessiz olmayan ornek YAZILDIYSA true.
    ///
    /// Ikinci kosul sart: cihaz kendi tamponunu bosaltirken bizim kuyrugumuz
    /// erken biter, ses ise hala duyulur. Yalniz kuyruga bakan bir kontrol
    /// cumlenin son ~100 ms'sinde "playback yok" der ve barge-in tam da orada
    /// Smith'in kendi kuyrugunu kullaniciya atfeder.
    ///
    /// Kilit alinamazsa false: kilidi zehirleyecek tek sey playback yolunun
    /// paniklemis olmasidir, o durumda gercekten ses calmiyordur.
    pub fn is_playing(&self) -> bool {
        // Kilitler ASLA ic ice alinmaz (once kuyruk biter, sonra zarf) — bu
        // yolla kilit sirasi diye bir sey olusmaz, kilitlenme imkansizdir.
        let queued = match self.queue.lock() {
            Ok(q) => !q.samples.is_empty(),
            Err(_) => false,
        };
        if queued {
            return true;
        }
        match self.envelope.lock() {
            Ok(env) => {
                env.has_signal_within(PLAYING_TAIL_MS, self.device_rate.load(Ordering::Relaxed))
            }
            Err(_) => false,
        }
    }

    /// Cihaza yazilan sesin, `back_ms` gecikme payiyla geriye kaydirilmis
    /// `window_ms`'lik penceredeki RMS'i (bkz. `OutputEnvelope::rms_back`).
    pub fn rms_back(&self, back_ms: u32, window_ms: u32) -> f32 {
        match self.envelope.lock() {
            Ok(env) => env.rms_back(back_ms, window_ms, self.device_rate.load(Ordering::Relaxed)),
            Err(_) => 0.0,
        }
    }

    /// Kuyrukta bekleyen (henuz cihaza yazilmamis) sesin suresi.
    pub fn queued_ms(&self) -> u32 {
        let rate = self.device_rate.load(Ordering::Relaxed);
        if rate == 0 {
            return 0;
        }
        match self.queue.lock() {
            Ok(q) => ((q.samples.len() as u64 * 1000) / rate as u64).min(u32::MAX as u64) as u32,
            Err(_) => 0,
        }
    }
}

/// Cikis kazanci — mixer'in "Hoparlor" satiri (UI komutlari yazar, ses
/// callback'i her blokta okur). Atomik: callback ses cihazinin teslim
/// tarihiyle kosar; orada kilit almak underrun (catirti) riskidir.
///
/// `volume` f32 biti olarak tutulur: AtomicF32 yok, `AtomicU32` + `to_bits`
/// bu depoda zaten kullanilan desen (`device_rate` benzer sekilde atomik).
/// Susturma AYRI bayraktir ve slider degerini EZMEZ — kullanici sesi kapatip
/// actiginda düzeyi aynen geri gelir.
pub struct OutputGain {
    volume: AtomicU32,
    muted: AtomicBool,
}

impl Default for OutputGain {
    fn default() -> Self {
        Self {
            // TAM SES varsayilan: kazanci olmayan bir kurulum eskisi gibi duyar.
            volume: AtomicU32::new(1.0f32.to_bits()),
            muted: AtomicBool::new(false),
        }
    }
}

impl OutputGain {
    /// 0.0..=1.0 araligina kirpilir; aralik disi deger sessizce kabul edilmez,
    /// kirpilir (tek dogru davranis: kullanici kaydiricisi zaten sinirli).
    pub fn set_volume(&self, v: f32) {
        self.volume
            .store(v.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    pub fn volume(&self) -> f32 {
        f32::from_bits(self.volume.load(Ordering::Relaxed)).clamp(0.0, 1.0)
    }

    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }

    pub fn muted(&self) -> bool {
        self.muted.load(Ordering::Relaxed)
    }

    /// Cihaza FIILEN uygulanacak kazanc: susturulduysa 0, degilse volume.
    /// Envelope (barge-in referansi) da bu degerle beslenir — susturulmusken
    /// cihaza giden sinyal gercekten sifirdir ve referans bunu yansitmali.
    pub fn gain(&self) -> f32 {
        if self.muted() {
            0.0
        } else {
            self.volume()
        }
    }
}

/// Playback kuyruguna yazan ve onu bosaltan, thread'ler arasi paylasilabilir
/// tutamac. Sentez worker'i bunun bir kopyasini tutar; stream'i tutan `Playback`
/// ayri yasar.
#[derive(Clone)]
pub struct PlaybackSink {
    queue: Queue,
    // Bkz. `OutputReference::device_rate`: kurtarmada taze cihazin frekansiyla
    // guncellenen paylasilan deger. `enqueue_mono` resample hedefini bundan okur.
    device_rate: Arc<AtomicU32>,
    status: std::sync::mpsc::Sender<PlaybackStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackClearReason {
    Interrupted,
    DeviceRateChanged,
}

impl PlaybackClearReason {
    fn ad(self) -> &'static str {
        match self {
            Self::Interrupted => "interrupted",
            Self::DeviceRateChanged => "device_rate_changed",
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    pub durum: &'static str,
    pub deneme: u32,
    pub kayip_ms: u64,
    pub cihaz: Option<String>,
    pub sebep: Option<String>,
}

impl PlaybackSink {
    /// `src_rate` frekansindaki mono ornekleri cihaz frekansina resample edip
    /// kuyruga ekler. Her cagri bagimsiz resample eder: her cumle iki ucu
    /// fade'li ayri bir tampon oldugu icin sinir hatasi duyulmaz.
    pub fn enqueue_mono(&self, samples: &[f32], src_rate: u32) {
        self.enqueue_marked(samples, src_rate, None);
    }

    pub(crate) fn enqueue_live(&self, samples: &super::live::SesParcasi, src_rate: u32) {
        self.enqueue_marked(samples, src_rate, Some(samples.cihaz_isareti()));
    }

    fn enqueue_marked(&self, samples: &[f32], src_rate: u32, marker: Option<Arc<AtomicU64>>) {
        let device_rate = self.device_rate.load(Ordering::Relaxed);
        let resampled = if src_rate == device_rate {
            samples.to_vec()
        } else {
            let mut out = Vec::new();
            LinearResampler::new(src_rate, device_rate).process(samples, &mut out);
            out
        };
        if let Ok(mut q) = self.queue.lock() {
            let now = std::time::Instant::now();
            q.expire(now);
            // Tasan kisim EN ESKI orneklerden atilir: once kuyrugun basi, tek
            // parca tavani asiyorsa parcanin kendi basi (en yeni ses kalir).
            let tasan = (q.samples.len() + resampled.len())
                .saturating_sub(device_rate as usize * MAX_QUEUED_SECONDS);
            let eski = tasan.min(q.samples.len());
            q.discard(eski);
            let parca_atilan = tasan - eski;
            q.dropped += parca_atilan as u64;
            let kalan = resampled.len() - parca_atilan;
            q.samples.extend(resampled.into_iter().skip(parca_atilan));
            if kalan > 0 {
                q.ages.push_back((now, kalan, marker));
            }
        }
    }

    /// Kuyrugu aninda bosaltir (barge-in / tur-sinir / cancel). Calan tampon bir
    /// sonraki callback'te susar.
    ///
    /// Zarf BILEREK temizlenmez: zarf "ne caldik" gecmisidir, kuyruk bosaltilsa
    /// da cihazin tamponundaki ses duyulmaya devam eder ve mikrofona girer.
    pub fn clear(&self, reason: PlaybackClearReason) {
        let rate = self.device_rate.load(Ordering::Relaxed);
        if let Ok(mut q) = self.queue.lock() {
            let kayip = q.clear();
            let kayip_ms = if rate == 0 {
                0
            } else {
                kayip as u64 * 1000 / rate as u64
            };
            eprintln!(
                "[playback] kuyruk temizlendi reason={} kayip_ms={kayip_ms}",
                reason.ad()
            );
            let _ = self.status.send(PlaybackStatus {
                durum: "cleared",
                deneme: 0,
                kayip_ms,
                cihaz: None,
                sebep: Some(reason.ad().into()),
            });
        }
    }
}

/// cpal cikis stream'ini kendi thread'inde tutar. Dusunce stream durur, cihaz
/// serbest kalir.
pub struct Playback {
    sink: PlaybackSink,
    pub device_name: super::CihazAdi,
    reference: OutputReference,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    status_rx: Option<std::sync::mpsc::Receiver<PlaybackStatus>>,
}

impl Playback {
    /// Varsayilan cikis cihazindan playback stream'ini baslatir (fail-fast: ILK
    /// stream gercekten kurulup calisana kadar bekler).
    ///
    /// `gain`: UI mixer'inin cikis kazanci. Ayni Arc tum stream omru boyunca
    /// yasar — stream koptugunda yeniden kurulum da ayni Arc'i kullanir, yani
    /// kurtarma sonrasi düzey/susturma durumu korunur.
    ///
    /// KURTARMA: ilk kurulumdan sonra gozcu thread'i stream'i canli tutar. cpal
    /// `err_fn` stream'i olu isaretlerse — ozellikle ses servisi coktugunde gelen
    /// `AUDCLNT_E_SERVICE_NOT_RUNNING` (0x88890010) — stream TAZE cihazla yeniden
    /// kurulur; capture.rs ile ayni desen. Onceden `err_fn` yalnizca log basiyor,
    /// olen cikis stream'i kalici sessizlige dusuyordu (sahada ~4 saat olculdu).
    /// Kuyruk/zarf/frekans stream'ten BAGIMSIZ yasar: yeniden kurulum sink ve
    /// reference tutamaclarini gecersizlestirmez.
    pub fn start(gain: Arc<OutputGain>) -> Result<Self, AudioError> {
        static BUSY: AtomicBool = AtomicBool::new(false);
        let reservation = super::SurucuRezervasyonu::al(&BUSY)?;
        // Paylasilan durum stream'ten bagimsiz yasar. Stream yeniden kurulsa da
        // sink/reference ayni Arc'lari tutar; taze cihazin frekansi `device_rate`e
        // atomik yazilir (gercek-zaman-guvenli, kilit yok).
        let queue: Queue = Arc::new(Mutex::new(PlaybackQueue::default()));
        let envelope: EnvelopeRef = Arc::new(Mutex::new(OutputEnvelope::new()));
        // 0 = "henuz cihaz secilmedi"; ilk `build_output` gercek frekansi yazar.
        // ready_rx.recv() basari donene kadar bekledigimiz icin sink/reference
        // cagirana ulastiginda deger dolmus olur (store, play/send'den once).
        let device_rate = Arc::new(AtomicU32::new(0));
        let device_name = super::CihazAdi::default();
        let name_thread = device_name.clone();
        let (status_tx, status_rx) = std::sync::mpsc::channel::<PlaybackStatus>();
        let status_thread = status_tx.clone();

        let sink = PlaybackSink {
            queue: queue.clone(),
            device_rate: device_rate.clone(),
            status: status_tx,
        };
        let reference = OutputReference {
            queue: queue.clone(),
            envelope: envelope.clone(),
            device_rate: device_rate.clone(),
        };

        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), AudioError>>();

        // Kalanlari (klonlanmamis orijinaller) thread'e tasi.
        let queue_thread = queue;
        let envelope_thread = envelope;
        let rate_thread = device_rate;
        let gain_thread = gain;

        let thread = std::thread::spawn(move || {
            let _reservation = reservation;
            // Ilk kurulum fail-fast (cihaz yoksa cagiran hemen gorsun); SONRAKI
            // kopuslarda sessiz kurtarma. Cihaz her denemede TAZE secilir —
            // varsayilan cikis degismis olabilir.
            let mut first = Some(ready_tx);
            let mut kurtariyor = false;
            let mut deneme = 0u32;
            while !stop_thread.load(Ordering::Relaxed) {
                if kurtariyor {
                    deneme = deneme.saturating_add(1);
                    eprintln!("[playback] yeniden kurulum denemesi {deneme}");
                    let _ = status_thread.send(PlaybackStatus {
                        durum: "retrying",
                        deneme,
                        kayip_ms: 0,
                        cihaz: None,
                        sebep: None,
                    });
                }
                let dead = Arc::new(AtomicBool::new(false));
                match build_output(
                    queue_thread.clone(),
                    envelope_thread.clone(),
                    rate_thread.clone(),
                    gain_thread.clone(),
                    dead.clone(),
                    stop_thread.clone(),
                    status_thread.clone(),
                    &name_thread,
                ) {
                    Ok(stream) if stop_thread.load(Ordering::SeqCst) => {
                        drop(stream);
                        break;
                    }
                    Ok(stream) => match stream.play() {
                        Ok(()) => {
                            if let Some(tx) = first.take() {
                                let _ = tx.send(Ok(()));
                            }
                            if kurtariyor {
                                let cihaz = name_thread
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .clone();
                                eprintln!("[playback] yeniden kuruldu: {cihaz}");
                                let _ = status_thread.send(PlaybackStatus {
                                    durum: "recovered",
                                    deneme,
                                    kayip_ms: 0,
                                    cihaz: Some(cihaz),
                                    sebep: None,
                                });
                                kurtariyor = false;
                                deneme = 0;
                            }
                            // Stream bu kapsamda hayatta kalmali; durana YA DA
                            // olene kadar bekle.
                            while !stop_thread.load(Ordering::Relaxed)
                                && !dead.load(Ordering::Relaxed)
                            {
                                std::thread::sleep(std::time::Duration::from_millis(100));
                                atilani_bildir(&queue_thread);
                            }
                            if dead.load(Ordering::Relaxed) && !stop_thread.load(Ordering::Relaxed)
                            {
                                eprintln!(
                                    "[playback] stream koptu (ses servisi/cihaz gecersizlesti); yeniden kuruluyor…"
                                );
                                let _ = status_thread.send(PlaybackStatus {
                                    durum: "recovering",
                                    deneme: 0,
                                    kayip_ms: 0,
                                    cihaz: None,
                                    sebep: Some("stream_error".into()),
                                });
                                drop(stream);
                                kurtariyor = true;
                                deneme = 0;
                                std::thread::sleep(kurtarma_bekleme(1));
                                continue;
                            }
                            // stop istendi: stream drop olur, cihaz serbest kalir.
                        }
                        Err(e) => {
                            if let Some(tx) = first.take() {
                                let _ = tx.send(Err(AudioError::Stream(e.to_string())));
                                return;
                            }
                            kurtariyor = true;
                            eprintln!(
                                "[playback] yeniden kurulum play hatasi deneme={deneme}: {e}"
                            );
                            let _ = status_thread.send(PlaybackStatus {
                                durum: "retry_failed",
                                deneme,
                                kayip_ms: 0,
                                cihaz: None,
                                sebep: Some(e.to_string()),
                            });
                            std::thread::sleep(kurtarma_bekleme(deneme.saturating_add(1)));
                        }
                    },
                    Err(e) => {
                        if let Some(tx) = first.take() {
                            let _ = tx.send(Err(e));
                            return;
                        }
                        kurtariyor = true;
                        eprintln!("[playback] yeniden kurulum hatasi deneme={deneme}: {e}");
                        let _ = status_thread.send(PlaybackStatus {
                            durum: "retry_failed",
                            deneme,
                            kayip_ms: 0,
                            cihaz: None,
                            sebep: Some(e.to_string()),
                        });
                        std::thread::sleep(kurtarma_bekleme(deneme.saturating_add(1)));
                    }
                }
            }
        });

        // Surucu takilirsa sinirli beklenir; thread'e durma bildirilir, gec
        // acilan stream hemen birakilir (yukaridaki `stop` kontrolu).
        match super::surucu_bekle(&ready_rx, super::AUDIO_DRIVER_TIMEOUT).and_then(|sonuc| sonuc) {
            Ok(()) => Ok(Self {
                sink,
                device_name,
                reference,
                stop,
                thread: Some(thread),
                status_rx: Some(status_rx),
            }),
            Err(e) => {
                stop.store(true, Ordering::SeqCst);
                Err(e)
            }
        }
    }

    /// Kuyruga yazmak/bosaltmak icin paylasilabilir tutamac.
    pub fn sink(&self) -> PlaybackSink {
        self.sink.clone()
    }

    /// Cihaza yazilani okumak icin paylasilabilir tutamac (barge-in referansi).
    pub fn reference(&self) -> OutputReference {
        self.reference.clone()
    }

    pub fn take_status(&mut self) -> Option<std::sync::mpsc::Receiver<PlaybackStatus>> {
        self.status_rx.take()
    }
}

fn kurtarma_bekleme(deneme: u32) -> std::time::Duration {
    let ms = match deneme {
        0 | 1 => 300,
        2 => 1_000,
        3 => 2_000,
        _ => 5_000,
    };
    std::time::Duration::from_millis(ms)
}

impl Drop for Playback {
    fn drop(&mut self) {
        if let Err(e) =
            super::surucu_kapat(&mut self.thread, &self.stop, super::AUDIO_DRIVER_TIMEOUT)
        {
            eprintln!("[audio] kapanis basarisiz: {e}");
        }
    }
}

/// Varsayilan cikis cihazini TAZE secip cikis stream'ini kurar. Her (yeniden)
/// kurulumda cagrilir; cihaz, format ve frekans o an neyse ona gore hesaplanir.
fn build_output(
    queue: Queue,
    envelope: EnvelopeRef,
    device_rate: Arc<AtomicU32>,
    gain: Arc<OutputGain>,
    dead: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    status: std::sync::mpsc::Sender<PlaybackStatus>,
    selected_name: &super::CihazAdi,
) -> Result<cpal::Stream, AudioError> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or(AudioError::NoOutputDevice)?;
    let supported = device
        .default_output_config()
        .map_err(|e| AudioError::Config(e.to_string()))?;
    // cpal 0.18: SampleRate = u32, ChannelCount = u16 (type alias).
    let rate = supported.sample_rate();
    let channels = supported.channels() as usize;
    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.into();

    // Cihaz taze secildi: paylasilan frekansi guncelle. Ses servisi yeniden
    // basladiginda cogunlukla ayni deger; cihaz gercekten degistiyse yeni deger
    // yazilir. `PlaybackSink` resample hedefini, `OutputReference` sure/pencere
    // hesabini bu atomikten okur → kurtarma sonrasi tutarli kalir.
    let eski_rate = device_rate.swap(rate, Ordering::Relaxed);
    if eski_rate != 0 && eski_rate != rate {
        if let Ok(mut q) = queue.lock() {
            let kayip = q.clear();
            let kayip_ms = kayip as u64 * 1000 / eski_rate as u64;
            eprintln!(
                "[playback] kuyruk temizlendi reason={} kayip_ms={kayip_ms}",
                PlaybackClearReason::DeviceRateChanged.ad()
            );
            let _ = status.send(PlaybackStatus {
                durum: "cleared",
                deneme: 0,
                kayip_ms,
                cihaz: None,
                sebep: Some(PlaybackClearReason::DeviceRateChanged.ad().into()),
            });
        }
    }
    *selected_name.lock().unwrap_or_else(|e| e.into_inner()) = device.to_string();

    // Hata = stream fiilen olu (WASAPI cogu hatadan geri donmez; ozellikle
    // AUDCLNT_E_SERVICE_NOT_RUNNING = 0x88890010 ses servisi coktugunde gelir ve
    // stream bir daha ornek istemez). Bayragi set et ki gozcu dongusu tazeden
    // kurabilsin — capture.rs ile ayni kurtarma sozlesmesi. Onceki `err_fn`
    // yalnizca log basiyordu, o yuzden 0x kurtardi.
    let err_fn = move |e| {
        eprintln!("[playback] stream hatasi: {e}; kurtarma tetiklendi");
        dead.store(true, Ordering::Relaxed);
    };

    // cpal 0.18: build_output_stream config'i DEGERLE alir; her kolda queue move.
    let stream = match sample_format {
        SampleFormat::F32 => {
            let gain = gain.clone();
            device.build_output_stream(
                config,
                move |out: &mut [f32], _| {
                    let g = if stop.load(Ordering::SeqCst) {
                        0.0
                    } else {
                        gain.gain()
                    };
                    fill(out, channels, &queue, &envelope, g, |s| s)
                },
                err_fn,
                None,
            )
        }
        SampleFormat::I16 => {
            let gain = gain.clone();
            device.build_output_stream(
                config,
                move |out: &mut [i16], _| {
                    let g = if stop.load(Ordering::SeqCst) {
                        0.0
                    } else {
                        gain.gain()
                    };
                    fill(out, channels, &queue, &envelope, g, |s| {
                        (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
                    })
                },
                err_fn,
                None,
            )
        }
        SampleFormat::U16 => {
            let gain = gain.clone();
            device.build_output_stream(
                config,
                move |out: &mut [u16], _| {
                    let g = if stop.load(Ordering::SeqCst) {
                        0.0
                    } else {
                        gain.gain()
                    };
                    fill(out, channels, &queue, &envelope, g, |s| {
                        ((s.clamp(-1.0, 1.0) + 1.0) * 0.5 * u16::MAX as f32) as u16
                    })
                },
                err_fn,
                None,
            )
        }
        other => {
            return Err(AudioError::Config(format!(
                "desteklenmeyen cikis ornek formati: {other:?}"
            )))
        }
    }
    .map_err(|e| AudioError::Stream(e.to_string()))?;

    Ok(stream)
}

/// Callback yardimcisi: kuyruktan mono ornek cekip cihaz kanallarina kopyalar,
/// hedef ornek tipine `conv` ile cevirir. Kuyruk bossa sessizlik (0.0) yazar.
///
/// `gain` mixer kazancidir ve KAYNAK degerine uygulanir; RMS de kazancli
/// degerden hesaplanir. Gerekce: "cihaza fiilen giden sinyal budur" ilkesi —
/// susturulmus cikista referans da sifir gormeli, yoksa barge-in esigi
/// duyulmayan bir sese gore hesaplanirdi.
///
/// Ayni gecistte cikis referansi da beslenir: RMS, kanal kopyalamadan ve tip
/// donusumunden ONCEki gercek mono degerler uzerinden hesaplanir — cihaza fiilen
/// giden sinyal budur; kuyruk bosken yazilan 0.0'lar da sayilir, cunku o anda
/// gercekten sessizlik caliyoruz.
fn fill<T>(
    out: &mut [T],
    channels: usize,
    queue: &Queue,
    envelope: &EnvelopeRef,
    gain: f32,
    conv: impl Fn(f32) -> T,
) where
    T: Copy,
{
    let mut guard = queue.lock().ok();
    if let Some(q) = guard.as_mut() {
        q.expire(std::time::Instant::now());
    }
    let before = guard.as_ref().map_or(0, |q| q.samples.len());
    let mut sum_sq = 0.0f32;
    let mut frames = 0usize;
    for frame in out.chunks_mut(channels.max(1)) {
        let raw = guard
            .as_mut()
            .and_then(|q| q.samples.pop_front())
            .unwrap_or(0.0);
        let sample = raw * gain;
        sum_sq += sample * sample;
        frames += 1;
        let value = conv(sample);
        for slot in frame.iter_mut() {
            *slot = value;
        }
    }
    // Zarf kilidini almadan ONCE kuyruk kilidini birak: bu callback hicbir anda
    // iki kilit birden tutmaz.
    if let Some(q) = guard.as_mut() {
        let consumed = before - q.samples.len();
        q.consumed(consumed);
    }
    drop(guard);

    if frames == 0 {
        return;
    }
    let rms = (sum_sq / frames as f32).sqrt();
    // GERCEK ZAMAN GUVENLIGI: bu callback ses cihazinin son teslim tarihiyle
    // kosar; burada bloklamak underrun (catirti/kesinti) demektir. Zarf kilidi
    // bu yuzden yalnizca `try_lock` ile denenir — okuyucu (barge-in) tarafla
    // cakisirsak bu blogun kaydi ATLANIR. Takas bilincli: bir blogun zarfta
    // eksik kalmasi barge-in penceresini en fazla bir blok kadar seyreltir
    // (pencere ortalamasi kalan bloklardan hesaplanir), sesin kesilmesi ise
    // dogrudan duyulan bir kusurdur. Tahsis de yok: halka kapasitesi bastan
    // ayrildi, `push_block` yalnizca yazip budar.
    if let Ok(mut env) = envelope.try_lock() {
        env.push_block(rms, frames);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cihaz_callbacki_ilk_gercek_ornegi_isaretler() {
        let marker = Arc::new(AtomicU64::new(0));
        let mut q = PlaybackQueue::default();
        q.samples.push_back(0.5);
        q.ages
            .push_back((std::time::Instant::now(), 1, Some(marker.clone())));
        let queue = Arc::new(Mutex::new(q));
        let envelope = Arc::new(Mutex::new(OutputEnvelope::new()));
        let mut out = [0.0];
        fill(&mut out, 1, &queue, &envelope, 1.0, |s| s);
        assert_eq!(out, [0.5]);
        assert_ne!(marker.load(Ordering::Acquire), 0);
    }

    #[test]
    fn servis_uc_deneme_yokken_sinirli_geri_cekilir_donunce_toparlanir() {
        let sahte_sonuclar = [false, false, false, true];
        let gecikmeler: Vec<_> = sahte_sonuclar
            .iter()
            .enumerate()
            .filter_map(|(i, basarili)| (!basarili).then(|| kurtarma_bekleme((i + 1) as u32)))
            .collect();
        assert_eq!(
            gecikmeler,
            vec![
                std::time::Duration::from_millis(300),
                std::time::Duration::from_secs(1),
                std::time::Duration::from_secs(2)
            ]
        );
        assert!(sahte_sonuclar[3], "dorduncu kurulum sesi oynatir");
    }
    #[test]
    fn d1b_14_bayat_ses_callbackte_calinmaz() {
        let now = std::time::Instant::now();
        let mut q = PlaybackQueue::from(vec![0.8; 3]);
        // Saat tavandan bir saniye daha eski bir giris: bayat sayilir ve calinmaz.
        let bayat = std::time::Duration::from_secs(MAX_QUEUED_SECONDS as u64 + 1);
        q.ages.front_mut().unwrap().0 = now
            .checked_sub(bayat)
            .expect("test saati tavan suresinden once baslamis olmali");
        q.samples.extend([0.2, 0.3]);
        q.ages.push_back((now, 2, None));
        let queue = Arc::new(Mutex::new(q));
        let envelope = Arc::new(Mutex::new(OutputEnvelope::new()));
        let mut out = [0.0; 3];
        fill(&mut out, 1, &queue, &envelope, 1.0, |s| s);
        assert_eq!(out, [0.2, 0.3, 0.0]);
        let q = queue.lock().unwrap();
        assert!(q.ages.is_empty());
        assert_eq!(q.dropped, 3);
    }

    /// Tasma politikasi: tavan (`MAX_QUEUED_SECONDS` sn) asilirsa en ESKI ses atilir.
    /// 10 Hz'lik sahte cihazda tavan birkac bin ornektir; gercek tamponlar ayrilmaz.
    #[test]
    fn d1b_14_tavan_asilinca_en_eski_ses_atilir() {
        const HZ: u32 = 10;
        let sn = |n: usize| n * HZ as usize;
        let tavan = MAX_QUEUED_SECONDS;
        let reference = reference(OutputEnvelope::new(), 0);
        reference.device_rate.store(HZ, Ordering::Relaxed);
        let sink = PlaybackSink {
            queue: reference.queue.clone(),
            device_rate: reference.device_rate.clone(),
            status: std::sync::mpsc::channel().0,
        };
        sink.enqueue_mono(&vec![0.1; sn(tavan - 1)], HZ);
        sink.enqueue_mono(&vec![0.8; sn(3)], HZ);
        assert_eq!(reference.queued_ms() as usize, tavan * 1000);
        let q = sink.queue.lock().unwrap();
        assert_eq!(q.samples.front(), Some(&0.1));
        assert_eq!(q.samples.back(), Some(&0.8));
        assert_eq!(q.samples.iter().filter(|v| **v == 0.8).count(), sn(3));
        assert_eq!(q.dropped, sn(2) as u64, "tasan 2 sn kuyrugun basindan");
        drop(q);
        // Tek parca tavani asarsa parcanin kendi basi atilir, en yeni ses kalir.
        sink.enqueue_mono(&vec![0.9; sn(tavan + 1)], HZ);
        assert_eq!(reference.queued_ms() as usize, tavan * 1000);
        let q = sink.queue.lock().unwrap();
        assert!(q.samples.iter().all(|v| *v == 0.9));
        assert_eq!(q.dropped, sn(tavan + 3) as u64);
    }

    /// Canli olcum (gemini-3.8-live): ses gercek zamanin ~4 kati hizla gelir; 40 sn'lik
    /// cevabin tamami ~10 sn'de teslim edilir ve kuyruk ~30 sn'ye cikar. Bu birikim
    /// HICBIR parcayi dusurmemeli (dar tavan uzun cevabin ortasini kirpiyordu).
    #[test]
    fn d1b_14_dort_kat_hizli_uzun_cevap_hic_parca_dusmez() {
        let reference = reference(OutputEnvelope::new(), 0);
        let sink = PlaybackSink {
            queue: reference.queue.clone(),
            device_rate: reference.device_rate.clone(),
            status: std::sync::mpsc::channel().0,
        };
        let mut tepe_ms = 0;
        for _ in 0..100 {
            // 100 ms gercek zaman: 400 ms ses gelir (24 kHz), 100 ms oynar (cihaz).
            sink.enqueue_mono(&vec![0.5; 9_600], 24_000);
            tepe_ms = tepe_ms.max(reference.queued_ms());
            let mut cikis = vec![0.0f32; block(100)];
            fill(
                &mut cikis,
                1,
                &reference.queue,
                &reference.envelope,
                1.0,
                |s| s,
            );
        }
        assert_eq!(reference.queue.lock().unwrap().dropped, 0, "parca dustu");
        assert!(
            (29_000..=31_000).contains(&tepe_ms),
            "olculen ~30 sn birikim bekleniyordu: {tepe_ms} ms"
        );
        assert!(
            tepe_ms as usize <= MAX_QUEUED_SECONDS * 1000,
            "tavan olculen birikimden dar"
        );
    }

    #[test]
    fn d1b_14_atilan_ses_sayaci_bir_kez_bildirilir() {
        let mut q = PlaybackQueue::default();
        assert_eq!(q.atilani_bildir(), None);
        q.dropped = 5;
        assert_eq!(q.atilani_bildir(), Some((5, 5)));
        assert_eq!(q.atilani_bildir(), None);
        q.dropped = 8;
        assert_eq!(q.atilani_bildir(), Some((3, 8)));
    }

    #[test]
    fn kesinti_kuyrugu_aninda_bosaltir_cihaz_gecmisi_kalir() {
        let mut env = OutputEnvelope::new();
        env.push_block(0.5, block(20));
        let reference = reference(env, RATE as usize * 8);
        let sink = PlaybackSink {
            queue: reference.queue.clone(),
            device_rate: reference.device_rate.clone(),
            status: std::sync::mpsc::channel().0,
        };
        assert!(reference.is_playing());
        sink.clear(PlaybackClearReason::Interrupted);
        assert!(reference.queue.lock().unwrap().samples.is_empty());
        // Kuyruk hemen bos; cihaza yazilmis son tampon geri alinamaz.
        assert!(reference.is_playing());
    }

    const RATE: u32 = 48_000;

    /// `ms` milisaniyelik blogun ornek sayisi.
    fn block(ms: u32) -> usize {
        (RATE as usize) * ms as usize / 1000
    }

    /// Cihazsiz cikis referansi — kuyruk ve zarf elle beslenir.
    fn reference(env: OutputEnvelope, queued: usize) -> OutputReference {
        OutputReference {
            queue: Arc::new(Mutex::new(vec![0.5f32; queued].into())),
            envelope: Arc::new(Mutex::new(env)),
            device_rate: Arc::new(AtomicU32::new(RATE)),
        }
    }

    #[test]
    fn bos_gecmis_sifir_doner() {
        let env = OutputEnvelope::new();
        assert_eq!(env.rms_back(0, 100, RATE), 0.0);
        assert_eq!(env.rms_back(50, 100, RATE), 0.0);
    }

    #[test]
    fn tek_blok_kendi_rms_ini_doner() {
        let mut env = OutputEnvelope::new();
        env.push_block(0.4, block(20));
        assert!((env.rms_back(0, 20, RATE) - 0.4).abs() < 1e-4);
    }

    #[test]
    fn cok_blok_pencerede_enerji_ortalamasi() {
        let mut env = OutputEnvelope::new();
        // 10 ms 0.0 + 10 ms 0.6 → 20 ms'lik pencerede RMS = sqrt(0.36/2).
        env.push_block(0.0, block(10));
        env.push_block(0.6, block(10));
        let expected = (0.36f32 / 2.0).sqrt();
        assert!((env.rms_back(0, 20, RATE) - expected).abs() < 1e-4);
    }

    #[test]
    fn back_ms_dogru_pencereyi_secer() {
        let mut env = OutputEnvelope::new();
        // Zaman ekseni (eskiden yeniye): 100 ms 0.8, sonra 100 ms sessizlik.
        env.push_block(0.8, block(100));
        env.push_block(0.0, block(100));
        // Son 100 ms sessiz.
        assert!(env.rms_back(0, 100, RATE) < 1e-6);
        // 100 ms geriden baslayan 100 ms'lik pencere gurultulu kismi gorur.
        assert!((env.rms_back(100, 100, RATE) - 0.8).abs() < 1e-4);
        // Sinirda oturan pencere yarisi sessiz: sqrt(0.64/2).
        let expected = (0.64f32 / 2.0).sqrt();
        assert!((env.rms_back(50, 100, RATE) - expected).abs() < 1e-4);
    }

    #[test]
    fn pencere_gecmisin_tamamen_disindaysa_sifir() {
        let mut env = OutputEnvelope::new();
        env.push_block(0.9, block(20));
        // Gecmis 20 ms; 100 ms geriden baslayan pencere hicbir bloga degmez.
        assert_eq!(env.rms_back(100, 50, RATE), 0.0);
    }

    #[test]
    fn gecmis_siniri_en_eskiyi_dusurur_bellek_sabit_kalir() {
        let mut env = OutputEnvelope::new();
        let cap = env.blocks.capacity();
        // 10 ms'lik bloklarla 60 sn yaz: hem ornek butcesi (3 sn) hem blok
        // siniri devreye girer.
        for _ in 0..6_000 {
            env.push_block(0.5, block(10));
        }
        assert!(env.blocks.len() <= HISTORY_BLOCKS);
        assert!(env.total_samples <= HISTORY_SAMPLES);
        assert_eq!(env.blocks.capacity(), cap, "halka yeniden tahsis etti");

        // Cok kucuk bloklarla (1 ms) blok siniri once dolar.
        let mut tiny = OutputEnvelope::new();
        let tiny_cap = tiny.blocks.capacity();
        for _ in 0..5_000 {
            tiny.push_block(0.5, block(1));
        }
        assert_eq!(tiny.blocks.len(), HISTORY_BLOCKS);
        assert_eq!(
            tiny.blocks.capacity(),
            tiny_cap,
            "halka yeniden tahsis etti"
        );
    }

    #[test]
    fn dusen_blok_pencereden_de_dusar() {
        let mut env = OutputEnvelope::new();
        // Once gurultu, sonra butceyi asacak kadar sessizlik → gurultu dusmeli.
        env.push_block(0.9, block(500));
        for _ in 0..40 {
            env.push_block(0.0, block(100));
        }
        // 4 sn geriye bakilsa bile gurultu artik gecmiste degil.
        assert_eq!(env.rms_back(0, 4_000, RATE), 0.0);
    }

    #[test]
    fn bozuk_ornek_zarfi_zehirlemez() {
        let mut env = OutputEnvelope::new();
        env.push_block(f32::NAN, block(10));
        env.push_block(0.4, block(10));
        let r = env.rms_back(0, 20, RATE);
        assert!(r.is_finite());
        assert!((r - (0.16f32 / 2.0).sqrt()).abs() < 1e-4);
    }

    #[test]
    fn sifir_frekans_veya_sifir_pencere_sifir_doner() {
        let mut env = OutputEnvelope::new();
        env.push_block(0.5, block(20));
        assert_eq!(env.rms_back(0, 100, 0), 0.0);
        assert_eq!(env.rms_back(0, 0, RATE), 0.0);
        assert!(!env.has_signal_within(150, 0));
    }

    #[test]
    fn son_pencerede_sinyal_tespiti() {
        let mut env = OutputEnvelope::new();
        env.push_block(0.7, block(20));
        assert!(env.has_signal_within(PLAYING_TAIL_MS, RATE));
        // 150 ms'den fazla sessizlik yazildiktan sonra sinyal geride kalir.
        for _ in 0..20 {
            env.push_block(0.0, block(10));
        }
        assert!(!env.has_signal_within(PLAYING_TAIL_MS, RATE));
    }

    #[test]
    fn kuyruk_bos_ama_kuyruk_sonu_hala_caliyor() {
        let mut env = OutputEnvelope::new();
        env.push_block(0.7, block(20));
        // Kuyruk BOS: naif kontrol "playback yok" derdi, zarf hayir diyor.
        assert!(reference(env, 0).is_playing());
    }

    #[test]
    fn sessiz_ve_bos_kuyruk_calmiyor() {
        let mut env = OutputEnvelope::new();
        for _ in 0..20 {
            env.push_block(0.0, block(10));
        }
        assert!(!reference(env, 0).is_playing());
    }

    #[test]
    fn kuyrukta_ses_varken_caliyor_sayilir() {
        // Zarf bombos (henuz hicbir sey yazilmadi) ama kuyruk dolu.
        assert!(reference(OutputEnvelope::new(), 480).is_playing());
    }

    #[test]
    fn queued_ms_kuyruk_suresini_verir() {
        assert_eq!(reference(OutputEnvelope::new(), 0).queued_ms(), 0);
        assert_eq!(
            reference(OutputEnvelope::new(), block(250)).queued_ms(),
            250
        );
    }

    #[test]
    fn referans_cihaz_frekansini_kendisi_bilir() {
        let mut env = OutputEnvelope::new();
        env.push_block(0.8, block(100));
        env.push_block(0.0, block(100));
        let r = reference(env, 0);
        assert!(r.rms_back(0, 100) < 1e-6);
        assert!((r.rms_back(100, 100) - 0.8).abs() < 1e-4);
    }

    /// REGRESYON — kurtarmanin pure-logic cekirdegi. Stream olup TAZE cihazla
    /// yeniden kurulunca `build_output` yeni frekansi paylasilan `device_rate`e
    /// yazar; sink ve reference ayni atomikten okudugu icin kurtarma sonrasi
    /// tutarli kalir. Eski tasarimda `device_rate` her tutamaca `u32` GOMULUYDU
    /// ve stream yeniden kurulsa da guncellenemiyordu — 480 ornek sonsuza dek
    /// 10 ms sayilirdi. Bu test o sabit-rate regresyonunu yakalar.
    #[test]
    fn kurtarmada_paylasilan_frekans_sink_ve_referansa_yansir() {
        let device_rate = Arc::new(AtomicU32::new(48_000));
        let queue: Queue = Arc::new(Mutex::new(PlaybackQueue::default()));
        let sink = PlaybackSink {
            queue: queue.clone(),
            device_rate: device_rate.clone(),
            status: std::sync::mpsc::channel().0,
        };
        let reference = OutputReference {
            queue: queue.clone(),
            envelope: Arc::new(Mutex::new(OutputEnvelope::new())),
            device_rate: device_rate.clone(),
        };

        // 48 kHz'de 480 ornek = 10 ms (src == device, resample yok).
        sink.enqueue_mono(&vec![0.1f32; 480], 48_000);
        assert_eq!(reference.queued_ms(), 10);

        // Kurtarma: build_output taze cihaz secti, frekans 24 kHz'e dustu.
        // Kuyruktaki AYNI 480 ornek artik 20 ms; gomulu-rate tasariminda 10 ms
        // KALIRDI.
        device_rate.store(24_000, Ordering::Relaxed);
        assert_eq!(reference.queued_ms(), 20);

        // Yeni enqueue de yeni frekansi kullanir: 24 kHz kaynak resample'siz
        // gecer, 240 ornek (10 ms @24kHz) daha ekler → toplam 30 ms.
        sink.enqueue_mono(&vec![0.1f32; 240], 24_000);
        assert_eq!(reference.queued_ms(), 30);
    }

    // --- mixer: cikis kazanci --------------------------------------------

    #[test]
    fn varsayilan_cikis_kazanci_tam_ses() {
        let g = OutputGain::default();
        assert_eq!(g.volume(), 1.0);
        assert!(!g.muted());
        assert_eq!(g.gain(), 1.0);
    }

    #[test]
    fn susturma_kazanci_sifirlar_ama_volume_korunur() {
        let g = OutputGain::default();
        g.set_volume(0.4);
        g.set_muted(true);
        // Susturulmusken kazanc sifir…
        assert_eq!(g.gain(), 0.0);
        // …ama kullanicinin düzeyi EZILMEZ; acinca aynen geri gelir.
        assert_eq!(g.volume(), 0.4);
        g.set_muted(false);
        assert_eq!(g.gain(), 0.4);
    }

    #[test]
    fn volume_aralik_disini_kirpar() {
        let g = OutputGain::default();
        g.set_volume(3.5);
        assert_eq!(g.volume(), 1.0);
        g.set_volume(-2.0);
        assert_eq!(g.volume(), 0.0);
    }

    #[test]
    fn fill_kazanci_orneklere_ve_zarfa_uygular() {
        // Kuyrukta 1.0, 0.5, -0.5; kazanc 0.5 → cihaza 0.5, 0.25, -0.25 gider ve
        // referans (zarf) da KAZANCLI degeri gorur: "cihaza fiilen giden sinyal
        // budur" ilkesi — susturulmus cikista barge-in esigi sifir gormeli.
        let queue: Queue = Arc::new(Mutex::new(vec![1.0f32, 0.5, -0.5].into()));
        let envelope: EnvelopeRef = Arc::new(Mutex::new(OutputEnvelope::new()));
        let mut out = vec![0.0f32; 3];
        fill(&mut out, 1, &queue, &envelope, 0.5, |s| s);
        assert_eq!(out, vec![0.5, 0.25, -0.25]);

        let env = envelope.lock().expect("zarf kilidi");
        // Kazancli degerlerin kareleri: 0.5² + 0.25² + 0.25² = 0.375.
        let expected = ((0.5f32.powi(2) + 0.25f32.powi(2) + 0.25f32.powi(2)) / 3.0).sqrt();
        assert!((env.rms_back(0, 1000, RATE) - expected).abs() < 1e-4);
    }
}
