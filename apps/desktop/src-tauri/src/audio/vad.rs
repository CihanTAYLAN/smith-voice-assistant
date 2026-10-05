//! Voice Activity Detection + konusma segmentleme.
//!
//! Silero VAD (voice_activity_detector crate, onnx modeli gomulu — indirme yok)
//! 16kHz 512-ornek chunk'larla calisir. Segmenter, prob esiklerini hangover ile
//! bir konusma durum makinesine cevirir: gereksiz sessizlik STT'ye gitmez.

use voice_activity_detector::VoiceActivityDetector as SileroInner;

use super::resample::LinearResampler;

/// VAD soyutlamasi. Silero bugunku implementasyon; motor degisimi trait
/// implementasyonuyla olur (ADR 0001 modularity).
pub trait VoiceActivityDetector: Send {
    /// 512 ornekli 16kHz chunk icin konusma olasiligi (0..1).
    fn predict(&mut self, chunk: Vec<f32>) -> f32;
}

pub struct SileroVad {
    inner: SileroInner,
}

impl SileroVad {
    pub fn new() -> Result<Self, String> {
        let inner = SileroInner::builder()
            .sample_rate(16_000_i64)
            .chunk_size(512_usize)
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { inner })
    }
}

impl VoiceActivityDetector for SileroVad {
    fn predict(&mut self, chunk: Vec<f32>) -> f32 {
        self.inner.predict(chunk)
    }
}

/// Segmenter'in urettigi olaylar. Ses tamponlari 16kHz mono f32'dir.
#[derive(Debug, Clone)]
pub enum SpeechEvent {
    /// Konusma basladi.
    Start,
    /// Konusma surerken periyodik ara tampon (partial STT icin).
    Partial(Vec<f32>),
    /// Konusma bitti; tam ifade tamponu (final STT icin).
    Final(Vec<f32>),
}

const CHUNK: usize = 512; // 16kHz'de 32ms
const START_THRESH: f32 = 0.5;
/// Mikrofon kapisi yumusak kelime baslarini kacirmasin. Yanlis acilmanin
/// maliyeti yalniz kisa bir ses gonderimidir; kulaklikta yanki kapisi yoktur.
const KAPI_START_THRESH: f32 = 0.4;
const END_THRESH: f32 = 0.35;
/// Konusma bitisi icin ardisik sessizlik suresi (ms). GPU decode ~0.2 sn;
/// final his = hangover + decode ≈ 0.55 sn — Siri/Alexa sinifina yaklasir.
/// 350'nin alti dogal soluklanmalarda cumleyi boler; takip penceresi (gate)
/// bolunmeyi telafi eder ama UX'i bozar, daha da indirme.
const HANGOVER_MS: usize = 350;
/// Partial STT'yi ~her bu kadar ms'de bir tetikle. GPU decode 200-270 ms
/// olculdu; 350 ms kadansta duty ~%65 ve bayat-partial dusurme emniyeti var.
/// Ilk gorunur yazi ≈ 0.55 sn — "konusurken yaziyor" hissinin esigi.
const PARTIAL_EVERY_MS: usize = 350;
/// Ilk partial icin gereken en az ifade suresi. Yarim kelime whisper'a
/// gitmesin — kirpilmis ses, halusinasyonun en verimli girdisi.
const MIN_PARTIAL_MS: usize = 350;
/// Konusma baslamadan ONCE tutulan chunk sayisi (pre-roll, ~320 ms). Silero
/// ancak esik asilinca tetiklenir; ilk hecenin yukselen kenari esikten ONCE
/// akmistir. Pre-roll'suz whisper kesik kelime basini yanlis cozer
/// ("Smith" → "mit/simit" hatalarinin bir bileseni de buydu).
const PREROLL_CHUNKS: usize = 10;
/// Ifade bu uzunluga ulastiktan sonra ILK dogal duraklamada (prob < END)
/// bolunur. Neden: her partial buyuyen ifadenin TAMAMINI bastan decode eder;
/// sinirsiz buyume decode suresini kadansin ustune cikarir → guncellemeler
/// seyreklesir, en sonunda "algilamiyor" hissi (sahada rapor edildi). Bolme
/// final uretir; devam eden konusma yeni ifade olarak surer.
const SOFT_MAX_UTTERANCE_MS: usize = 12_000;
/// Mutlak tavan: dogal duraklama hic gelmese de (surekli konusma/gurultu)
/// ifade burada KOSULSUZ bolunur. Sonsuz buyume = donma; asla izin verme.
const HARD_MAX_UTTERANCE_MS: usize = 15_000;
/// Sessizlik basladigi anda atilan "spekulatif" partial icin son partial'dan
/// beri gecmesi gereken en az sure (prob salinimlarinda spam olmasin).
const SPEC_PARTIAL_MIN_GAP_MS: usize = 200;
/// Cok kisa gurultuleri (ms) ifade sayma. 250 ms fazla gevsekti: bir klavye
/// tiklamasi veya nefes bile Silero'da 0.5'i asip "ifade" olabiliyordu.
const MIN_UTTERANCE_MS: usize = 600;
/// Ifadenin ortalama gucu (dBFS) bu esigin altindaysa STT'ye GONDERILMEZ.
///
/// Silero olasiligi tek basina yetmez: sabit fan/oda gurultusu esigi asabilir.
/// Ustelik `stt.rs`'teki `normalize_gain()` zayif sinyali 20x'e kadar
/// yukselttigi icin, kapisiz birakilan sessizlik whisper'a "konusma gibi"
/// gelen bir tampon olarak ulasip "(Muzik)" / "(Gerilim muzigi)" turu altyazi
/// etiketleri uretiyor. Yani kazanc duzeltmesi bu kapiyi ZORUNLU kildi.
const MIN_RMS_DBFS: f32 = -50.0;

const MS_PER_CHUNK: usize = CHUNK * 1000 / 16_000; // 32

/// 16kHz mono tamponun suresi (ms).
fn ms_of(samples: &[f32]) -> usize {
    samples.len() * 1000 / 16_000
}

/// Ortalama guc (dBFS). Bos veya tam sessiz tampon icin -sonsuz.
fn rms_dbfs(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return f32::NEG_INFINITY;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    let rms = (sum / samples.len() as f32).sqrt();
    if rms <= 1e-9 {
        f32::NEG_INFINITY
    } else {
        20.0 * rms.log10()
    }
}

/// Bir ifade STT'ye gonderilmeye deger mi: hem yeterince uzun hem yeterince
/// gucu olmali. Iki kosuldan biri bile dusunce whisper uydurmaya baslar.
fn is_speech_worthy(utt: &[f32]) -> bool {
    ms_of(utt) >= MIN_UTTERANCE_MS && rms_dbfs(utt) >= MIN_RMS_DBFS
}

/// Konusma durum makinesi. Cihaz sesini alir, 16k'ya indirir, chunk'lar,
/// Silero ile konusma segmentlerine boler.
pub struct SpeechSegmenter {
    vad: Box<dyn VoiceActivityDetector>,
    resampler: LinearResampler,
    buf16k: Vec<f32>,                              // henuz chunk'lanmamis 16k artik
    utterance: Vec<f32>,                           // aktif ifadenin tum 16k ornekleri
    preroll: std::collections::VecDeque<Vec<f32>>, // konusma oncesi son chunk'lar
    speaking: bool,
    konusma_ornek: usize,
    son_final_konusma_ornek: usize,
    silence_ms: usize,
    since_partial_ms: usize,
}

impl SpeechSegmenter {
    pub fn new(vad: Box<dyn VoiceActivityDetector>, in_rate: u32) -> Self {
        Self {
            vad,
            resampler: LinearResampler::new(in_rate, 16_000),
            buf16k: Vec::new(),
            utterance: Vec::new(),
            preroll: std::collections::VecDeque::with_capacity(PREROLL_CHUNKS + 1),
            speaking: false,
            konusma_ornek: 0,
            son_final_konusma_ornek: 0,
            silence_ms: 0,
            since_partial_ms: 0,
        }
    }

    /// Uzun ifadeyi bolen Final, konusmanin gercekten bittigini garanti etmez.
    pub fn konusuyor(&self) -> bool {
        self.speaking
    }

    pub fn son_final_konusma_ornek(&self) -> usize {
        self.son_final_konusma_ornek
    }
    pub fn konusma_ornek(&self) -> usize {
        self.konusma_ornek
    }
    pub fn sifirla(&mut self) {
        self.buf16k.clear();
        self.utterance.clear();
        self.preroll.clear();
        self.speaking = false;
        self.konusma_ornek = 0;
        self.silence_ms = 0;
        self.since_partial_ms = 0;
    }
    /// Bir cihaz ses karesini isler ve ortaya cikan olaylari dondurur.
    pub fn feed(&mut self, frame: &[f32]) -> Vec<SpeechEvent> {
        let mut events = Vec::new();
        self.resampler.process(frame, &mut self.buf16k);

        while self.buf16k.len() >= CHUNK {
            let chunk: Vec<f32> = self.buf16k.drain(..CHUNK).collect();
            let prob = self.vad.predict(chunk.clone());

            if self.speaking {
                self.utterance.extend_from_slice(&chunk);
                self.since_partial_ms += MS_PER_CHUNK;
                let utt_ms = ms_of(&self.utterance);

                if prob < END_THRESH {
                    // Spekulatif partial: sessizligin ILK chunk'inda ifadeyi
                    // hemen decode'a yolla. Hangover dolup Final geldiginde
                    // STT thread'i bu decode'un sonucunu cache'ten yayinlar —
                    // final gecikmesi decode maliyetinden tamamen kurtulur.
                    // RMS kapisi partial'da da ZORUNLU: 0.4 sn'lik nefes/gurultu
                    // blipleri whisper'a gidince "Altyazi M.K." turu halusinasyon
                    // ureyip UI'a dusuyordu (sahada gozlendi).
                    if self.silence_ms == 0
                        && self.since_partial_ms >= SPEC_PARTIAL_MIN_GAP_MS
                        && utt_ms >= MIN_PARTIAL_MS
                        && rms_dbfs(&self.utterance) >= MIN_RMS_DBFS
                    {
                        self.since_partial_ms = 0;
                        events.push(SpeechEvent::Partial(self.utterance.clone()));
                    }
                    self.silence_ms += MS_PER_CHUNK;
                    if self.silence_ms >= HANGOVER_MS {
                        // Ifade bitti.
                        let utt = std::mem::take(&mut self.utterance);
                        self.speaking = false;
                        self.silence_ms = 0;
                        self.since_partial_ms = 0;
                        if is_speech_worthy(&utt) {
                            self.son_final_konusma_ornek = self.konusma_ornek;
                            events.push(SpeechEvent::Final(utt));
                        }
                    } else if utt_ms >= SOFT_MAX_UTTERANCE_MS {
                        // Uzun konusma + dogal duraklama: burada bol.
                        self.split_utterance(&mut events);
                    }
                } else {
                    self.konusma_ornek += CHUNK;
                    self.silence_ms = 0;
                    if utt_ms >= HARD_MAX_UTTERANCE_MS {
                        // Duraklama gelmedi; tavanda kosulsuz bol.
                        self.split_utterance(&mut events);
                    } else if self.since_partial_ms >= PARTIAL_EVERY_MS
                        && utt_ms >= MIN_PARTIAL_MS
                        && rms_dbfs(&self.utterance) >= MIN_RMS_DBFS
                    {
                        self.since_partial_ms = 0;
                        events.push(SpeechEvent::Partial(self.utterance.clone()));
                    }
                }
            } else if prob > START_THRESH {
                self.konusma_ornek = CHUNK;
                self.speaking = true;
                self.silence_ms = 0;
                self.since_partial_ms = 0;
                self.utterance.clear();
                // Pre-roll: esikten onceki ~320 ms'yi ifadenin basina koy —
                // ilk hecenin yukselen kenari kaybolmasin.
                for pc in self.preroll.drain(..) {
                    self.utterance.extend_from_slice(&pc);
                }
                self.utterance.extend_from_slice(&chunk);
                events.push(SpeechEvent::Start);
            } else {
                // Konusma yok: pre-roll halkasini guncel tut.
                self.preroll.push_back(chunk);
                if self.preroll.len() > PREROLL_CHUNKS {
                    self.preroll.pop_front();
                }
            }
        }

        events
    }

    /// Konusma SURERKEN ifadeyi boler: mevcut tamponu Final olarak yayinlar,
    /// konusma durumunu bozmadan yeni ifadeye baslar. Sinirsiz buyume = her
    /// partial'da buyuyen tam-decode = donma; bolme bunu yapisal engeller.
    fn split_utterance(&mut self, events: &mut Vec<SpeechEvent>) {
        let utt = std::mem::take(&mut self.utterance);
        self.silence_ms = 0;
        self.since_partial_ms = 0;
        if is_speech_worthy(&utt) {
            self.son_final_konusma_ornek = self.konusma_ornek;
            events.push(SpeechEvent::Final(utt));
        }
        self.konusma_ornek = 0;
    }
}

// ---------------------------------------------------------------------------
// MIKROFON KAPISI (Live'a giden sesin gercek kapisi)
//
// Eskiden her mikrofon karesi Live'a gidiyordu; sessizlikte, yanki kapisinda
// (Smith konusurken) ve "mikrofonu sustur"da bile (sifir karesi olarak) akis
// surerdi ve `gemini-3.8-live` dinledigi her saniyeyi faturalar. Asagidaki iki
// parca bunu cozer: `KonusmaIzleyici` (Silero + gecikme esigi: "su an konusma
// var mi") ve `MikKapisi` (SAF durum makinesi: hangi kare gider, on-tampon,
// `audioStreamEnd` ne zaman). Ikisi ayri: durum makinesi sentetik girdilerle,
// model ve ONNX olmadan sinanir.
// ---------------------------------------------------------------------------

/// Konusma baslamadan ONCE tutulan ses (ms). Silero esigi yumusak baslangictan
/// gec asabilir. Sahada "Kullanici..." -> "'deki..." ve "Smith..." ->
/// "Mit..." olarak ilk yaklasik 1 sn kayboldu; 1.6 sn bu kaybi ve 32 ms VAD
/// penceresini guvenlik payiyla kapsar.
pub const ON_TAMPON_MS: usize = 1600;
/// Konusma bittikten sonra akisin acik kalma suresi (ms). Son hecenin ve
/// dogal duraklamalarin kesilmemesi icin; sunucunun kendi sessizlik esigi
/// (`silenceDurationMs` varsayilan 700, env ust siniri 2000) bunun ICINDE
/// en az 300 ms payla dolar, yani sunucu konusma sonunu
/// kendi algilar, `audioStreamEnd` yalniz kalan onbellegi bosaltir.
#[cfg(test)]
const ARTIK_MS: usize = 1000;

const KAPI_ON_TAMPON_ORNEK: usize = 16_000 * ON_TAMPON_MS / 1000;
#[cfg(test)]
const KAPI_ARTIK_ORNEK: usize = 16_000 * ARTIK_MS / 1000;
const ADAY_RMS_DBFS: f32 = -50.0;
const ADAY_OZET_ARALIGI: std::time::Duration = std::time::Duration::from_secs(60);

/// Bir kare icin kapinin girdisi.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KareDurumu {
    /// Mikrofon KAPALI (yanki kapisi veya sustur): bu kare hicbir kosulda
    /// gonderilmez ve acik akis varsa kapatilir.
    Kapali,
    /// Mikrofon acik, konusma yok.
    Sessiz,
    /// Mikrofon acik, konusma var.
    Konusma,
}

/// Kapinin dis dunyaya karari.
#[derive(Debug, Clone, PartialEq)]
pub enum KapiCikti {
    /// Bu sesi (16 kHz mono f32) `realtimeInput.audio` olarak gonder.
    Ses(Vec<f32>),
    /// Bir kez `realtimeInput.audioStreamEnd=true` gonder: akis durdu.
    AkisSonu,
}

/// Buluta cikmadan once tutulan ifade. Tavan PCM ornekleriyle kesin sinirlidir.
#[derive(Default)]
pub struct SahipTamponu {
    ses: std::collections::VecDeque<f32>,
    pub konusma_ornek: usize,
    pub dusen: usize,
    son_konusma: Option<std::time::Instant>,
    tasma_bildirildi: bool,
}

pub struct SahipIfadesi {
    pub ses: Vec<f32>,
    pub konusma_ornek: usize,
    pub son_konusma: Option<std::time::Instant>,
}

impl SahipTamponu {
    pub const TAVAN: usize = 30 * 16_000;

    pub fn tut(&mut self, cikti: KapiCikti) -> Option<Vec<f32>> {
        match cikti {
            KapiCikti::Ses(ses) => {
                self.ses.extend(ses);
                let fazla = self.ses.len().saturating_sub(Self::TAVAN);
                self.ses.drain(..fazla);
                self.dusen += fazla;
                if fazla > 0 && !self.tasma_bildirildi {
                    eprintln!(
                        "[live] yalniz beni: 30 sn tampon tavani, en eski kareler dusuruluyor"
                    );
                    self.tasma_bildirildi = true;
                }
                None
            }
            KapiCikti::AkisSonu => Some(self.ses.drain(..).collect()),
        }
    }

    /// VAD parcasi ile onun ciktisi AYNI adimda islenir; buyuk callback'te
    /// ikinci ifadenin suresi ilk kisa ifadeye karisamaz.
    pub fn isle(
        &mut self,
        n: usize,
        durum: KareDurumu,
        cikti: &[KapiCikti],
        at: std::time::Instant,
    ) -> Option<SahipIfadesi> {
        if durum == KareDurumu::Kapali {
            *self = Self::default();
            return None;
        }
        if durum == KareDurumu::Konusma {
            self.konusma_ornek += n;
            self.son_konusma = Some(at);
        }
        for parca in cikti {
            if let Some(ses) = self.tut(parca.clone()) {
                let ifade = SahipIfadesi {
                    ses,
                    konusma_ornek: self.konusma_ornek,
                    son_konusma: self.son_konusma,
                };
                *self = Self::default();
                return Some(ifade);
            }
        }
        None
    }

    pub fn karar(ses: Vec<f32>, sahip: bool) -> Vec<KapiCikti> {
        if sahip && !ses.is_empty() {
            vec![KapiCikti::Ses(ses), KapiCikti::AkisSonu]
        } else {
            Vec::new()
        }
    }
}

/// SAF durum makinesi: hangi kare Live'a gider.
///
/// Durumlar: akis KAPALI (hicbir sey gitmez, kareler on-tamponda doner) ve
/// akis ACIK (her kare gider; konusma yoksa verilen artik sure sayilir). Gecisler:
/// - `Konusma` + kapali -> ac: ON-TAMPON + kare tek `Ses` olarak gider.
/// - `Sessiz` + acik: kare yine gider (artik sure); verilen artik sure dolunca
///   `AkisSonu` ve kapanir.
/// - `Kapali` + acik: `AkisSonu` ve kapanir, on-tampon SILINIR (kapali
///   donemden once kalan ses sonradan gonderilmez).
/// - `Kapali` + kapali: hicbir sey (SIFIR kare, sessizlik de gonderilmez).
#[derive(Debug, Default)]
pub struct MikKapisi {
    akis_acik: bool,
    on_tampon: std::collections::VecDeque<Vec<f32>>,
    on_tampon_ornek: usize,
    artik_ornek: usize,
    artik_sinir: usize,
    ifade_teshisi: Option<KapiIfadeTeshisi>,
    aday_aktif: bool,
    aday_ornek: usize,
    acilmayan_aday: u64,
    aday_ozet_baslangici: Option<std::time::Instant>,
}

#[derive(Debug)]
struct KapiIfadeTeshisi {
    acilis_gecikme_ornek: usize,
    on_tampon_ornek: usize,
    ifade_ornek: usize,
}

impl MikKapisi {
    pub fn new(artik_ms: usize) -> Self {
        let mut kapi = Self::default();
        kapi.artik_sinir = 16 * artik_ms;
        kapi
    }

    /// Testlerin akis gecisini gozledigi durum.
    #[cfg(test)]
    fn akis_acik(&self) -> bool {
        self.akis_acik
    }

    /// Bir 16 kHz kareyi isler; gonderilecekleri sirayla dondurur (en fazla bir
    /// `Ses`, ardindan en fazla bir `AkisSonu`).
    pub fn adim(&mut self, kare: &[f32], durum: KareDurumu) -> Vec<KapiCikti> {
        self.aday_ozetle(std::time::Instant::now());
        match durum {
            KareDurumu::Kapali => {
                self.on_tampon.clear();
                self.on_tampon_ornek = 0;
                self.artik_ornek = 0;
                self.aday_sifirla();
                if self.akis_acik {
                    self.akis_acik = false;
                    self.ifade_bitir(true);
                    vec![KapiCikti::AkisSonu]
                } else {
                    Vec::new()
                }
            }
            KareDurumu::Konusma => {
                self.artik_ornek = 0;
                let mut ses = Vec::new();
                if !self.akis_acik {
                    self.akis_acik = true;
                    let acilis_gecikme_ornek = if self.aday_aktif {
                        self.aday_ornek + kare.len()
                    } else {
                        kare.len()
                    };
                    self.ifade_teshisi = Some(KapiIfadeTeshisi {
                        acilis_gecikme_ornek,
                        on_tampon_ornek: self.on_tampon_ornek,
                        ifade_ornek: acilis_gecikme_ornek,
                    });
                    self.aday_sifirla();
                    ses.reserve(self.on_tampon_ornek + kare.len());
                    for eski in self.on_tampon.drain(..) {
                        ses.extend_from_slice(&eski);
                    }
                    self.on_tampon_ornek = 0;
                } else if let Some(teshis) = self.ifade_teshisi.as_mut() {
                    teshis.ifade_ornek += kare.len();
                }
                ses.extend_from_slice(kare);
                vec![KapiCikti::Ses(ses)]
            }
            KareDurumu::Sessiz => {
                if self.akis_acik {
                    self.artik_ornek += kare.len();
                    let mut cikti = vec![KapiCikti::Ses(kare.to_vec())];
                    if self.artik_ornek >= self.artik_sinir {
                        self.akis_acik = false;
                        self.artik_ornek = 0;
                        cikti.push(KapiCikti::AkisSonu);
                        self.ifade_bitir(true);
                    }
                    cikti
                } else {
                    self.aday_izle(kare);
                    self.on_tampona_ekle(kare);
                    Vec::new()
                }
            }
        }
    }

    /// On-tampon halkasi: en az `ON_TAMPON_MS` tutar, bir kareden fazla tasmaz.
    fn on_tampona_ekle(&mut self, kare: &[f32]) {
        if kare.is_empty() {
            return;
        }
        self.on_tampon.push_back(kare.to_vec());
        self.on_tampon_ornek += kare.len();
        while let Some(ilk) = self.on_tampon.front() {
            if self.on_tampon_ornek - ilk.len() < KAPI_ON_TAMPON_ORNEK {
                break;
            }
            self.on_tampon_ornek -= ilk.len();
            self.on_tampon.pop_front();
        }
    }

    fn aday_izle(&mut self, kare: &[f32]) {
        if rms_dbfs(kare) >= ADAY_RMS_DBFS {
            self.aday_aktif = true;
            self.aday_ornek += kare.len();
        } else if self.aday_aktif {
            self.acilmayan_aday += 1;
            self.aday_sifirla();
        }
    }

    fn aday_sifirla(&mut self) {
        self.aday_aktif = false;
        self.aday_ornek = 0;
    }

    fn aday_ozetle(&mut self, simdi: std::time::Instant) {
        let Some(baslangic) = self.aday_ozet_baslangici else {
            self.aday_ozet_baslangici = Some(simdi);
            return;
        };
        if simdi.saturating_duration_since(baslangic) < ADAY_OZET_ARALIGI {
            return;
        }
        eprintln!(
            "[live] mikrofon kapisi enerji ozeti: acilmayan_aday={} pencere_ms={} aday_esigi_dbfs={ADAY_RMS_DBFS}",
            self.acilmayan_aday,
            simdi.saturating_duration_since(baslangic).as_millis()
        );
        self.acilmayan_aday = 0;
        self.aday_ozet_baslangici = Some(simdi);
    }

    fn ifade_bitir(&mut self, audio_stream_end: bool) {
        let Some(teshis) = self.ifade_teshisi.take() else {
            return;
        };
        eprintln!(
            "[live] mikrofon kapisi ifade: acilis_gecikmesi_ms={} on_tampon_ms={} ifade_ms={} audioStreamEnd={audio_stream_end}",
            ms_of_ornek(teshis.acilis_gecikme_ornek),
            ms_of_ornek(teshis.on_tampon_ornek),
            ms_of_ornek(teshis.ifade_ornek)
        );
    }
}

impl Drop for MikKapisi {
    fn drop(&mut self) {
        self.ifade_bitir(false);
    }
}

fn ms_of_ornek(ornek: usize) -> usize {
    ornek * 1000 / 16_000
}

/// "Su an konusma var mi" karari: Silero olasiligini mikrofon kapisinin daha
/// duyarli baslangic esigi ve ortak bitis esiginden gecirir. Rastgele boyutlu
/// 16 kHz karelerden 512 ornekli chunk biriktirir.
pub struct KonusmaIzleyici {
    vad: Box<dyn VoiceActivityDetector>,
    tampon: Vec<f32>,
    konusuyor: bool,
}

impl KonusmaIzleyici {
    pub fn new(vad: Box<dyn VoiceActivityDetector>) -> Self {
        Self {
            vad,
            tampon: Vec::new(),
            konusuyor: false,
        }
    }

    /// Her tamamlanan Silero parcasi kendi karariyla doner. Yarim parca
    /// sonraki callback'i bekler; ses ve karar ayni sinirlari tasir.
    /// ONNX paniginde bu callback'in henuz gonderilmemis sesi geri verilir.
    pub fn isle(&mut self, kare16k: &[f32]) -> Result<Vec<(Vec<f32>, KareDurumu)>, Vec<f32>> {
        self.tampon.extend_from_slice(kare16k);
        let kurtarma = self.tampon.clone();
        let mut parcalar = Vec::new();
        while self.tampon.len() >= CHUNK {
            let chunk: Vec<f32> = self.tampon.drain(..CHUNK).collect();
            let prob = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                self.vad.predict(chunk.clone())
            }));
            let Ok(prob) = prob else {
                return Err(kurtarma);
            };
            if !prob.is_finite() {
                return Err(kurtarma);
            }
            if self.konusuyor {
                if prob < END_THRESH {
                    self.konusuyor = false;
                }
            } else if prob > KAPI_START_THRESH {
                self.konusuyor = true;
            }
            parcalar.push((
                chunk,
                if self.konusuyor {
                    KareDurumu::Konusma
                } else {
                    KareDurumu::Sessiz
                },
            ));
        }
        Ok(parcalar)
    }

    /// Mikrofon kapaliyken cagrilir: biriken yarim chunk ve karar atilir (kapali
    /// donemden once kalan ses sonraki konusmaya karismasin).
    pub fn sifirla(&mut self) {
        self.tampon.clear();
        self.konusuyor = false;
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn audit_varsayilan_artik_sure() {
        let mut k = MikKapisi::new(1000);
        k.adim(&kare(1.0), KareDurumu::Konusma);
        for _ in 0..49 {
            k.adim(&kare(0.0), KareDurumu::Sessiz);
        }
        assert_eq!(
            k.adim(&kare(0.0), KareDurumu::Sessiz).last(),
            Some(&KapiCikti::AkisSonu)
        );
    }

    use super::*;

    /// 16kHz'de `ms` milisaniyelik, sabit genlikli tampon.
    fn buf(ms: usize, amplitude: f32) -> Vec<f32> {
        vec![amplitude; 16_000 * ms / 1000]
    }

    #[test]
    fn sessizlik_eksi_sonsuz_dbfs() {
        assert_eq!(rms_dbfs(&[]), f32::NEG_INFINITY);
        assert_eq!(rms_dbfs(&buf(100, 0.0)), f32::NEG_INFINITY);
    }

    #[test]
    fn tam_olcek_sifir_dbfs() {
        assert!((rms_dbfs(&buf(100, 1.0)) - 0.0).abs() < 0.01);
    }

    #[test]
    fn sabit_genlik_beklenen_dbfs() {
        // 0.01 genlik → 20*log10(0.01) = -40 dBFS
        assert!((rms_dbfs(&buf(100, 0.01)) + 40.0).abs() < 0.01);
    }

    #[test]
    fn kisa_ifade_reddedilir() {
        // Yeterince gucu var ama 300 ms < 600 ms.
        assert!(!is_speech_worthy(&buf(300, 0.05)));
    }

    #[test]
    fn kisik_ifade_reddedilir() {
        // Yeterince uzun ama 0.002 genlik ≈ -54 dBFS < -50 dBFS esigi.
        // normalize_gain() bunu 20x buyutup whisper'a "konusma" gibi
        // gostermeden once burada durur.
        assert!(!is_speech_worthy(&buf(1_000, 0.002)));
    }

    #[test]
    fn uzun_ve_yeterli_guclu_ifade_kabul_edilir() {
        assert!(is_speech_worthy(&buf(1_000, 0.05)));
    }

    #[test]
    fn ms_of_dogru_sayar() {
        assert_eq!(ms_of(&buf(600, 0.1)), 600);
        assert_eq!(ms_of(&[]), 0);
    }

    // ---- MIKROFON KAPISI ----
    //
    // Kareler sentetik: 20 ms (320 ornek) ve her kare kendi `deger`iyle dolu;
    // hangi karenin gittigi (ve hangi SIRAYLA) degerlerden okunur.

    const KARE: usize = 320; // 20 ms @ 16 kHz

    fn kare(deger: f32) -> Vec<f32> {
        vec![deger; KARE]
    }

    /// Cikti dizisinden gonderilen ornek sayisi.
    fn ornek_say(cikti: &[KapiCikti]) -> usize {
        cikti
            .iter()
            .map(|c| match c {
                KapiCikti::Ses(v) => v.len(),
                KapiCikti::AkisSonu => 0,
            })
            .sum()
    }

    fn akis_sonu_say(cikti: &[KapiCikti]) -> usize {
        cikti.iter().filter(|c| **c == KapiCikti::AkisSonu).count()
    }

    #[test]
    fn kapi_kapaliyken_ve_sessizken_hic_kare_gitmez() {
        let mut k = MikKapisi::new(1000);
        let mut gonderilen = 0;
        // 10 sn: yarisi kapali (yanki/sustur), yarisi mikrofon acik ama sessiz.
        for i in 0..500 {
            let d = if i % 2 == 0 {
                KareDurumu::Kapali
            } else {
                KareDurumu::Sessiz
            };
            let c = k.adim(&kare(0.01), d);
            gonderilen += ornek_say(&c);
            assert_eq!(akis_sonu_say(&c), 0, "akis hic acilmadi, AkisSonu olmaz");
        }
        assert_eq!(gonderilen, 0, "sessizlikte/kapaliyken SIFIR kare gitmeli");
        assert!(!k.akis_acik());
    }

    #[test]
    fn konusma_baslayinca_on_tampon_ve_ilk_kare_siraliyla_gider() {
        let mut k = MikKapisi::new(1000);
        // 2 sn sessizlik (100 kare): son 1.6 sn ve konusma karesi gider.
        for i in 1..=100 {
            assert!(k.adim(&kare(i as f32), KareDurumu::Sessiz).is_empty());
        }
        let c = k.adim(&kare(999.0), KareDurumu::Konusma);
        assert_eq!(c.len(), 1, "tek birlesik Ses beklenir: {c:?}");
        let KapiCikti::Ses(ses) = &c[0] else {
            panic!("Ses bekleniyordu: {c:?}");
        };
        assert_eq!(ses.len(), 81 * KARE);
        let degerler: Vec<f32> = ses.chunks(KARE).map(|c| c[0]).collect();
        let beklenen: Vec<f32> = (21..=100).map(|i| i as f32).chain([999.0]).collect();
        assert_eq!(degerler, beklenen, "on-tampon son 1600 ms olmali, sirali");
        assert!(k.akis_acik());
    }

    #[test]
    fn on_tampon_baslangicta_azsa_olan_kadar_gider() {
        let mut k = MikKapisi::new(1000);
        for i in 1..=3 {
            let _ = k.adim(&kare(i as f32), KareDurumu::Sessiz);
        }
        let c = k.adim(&kare(9.0), KareDurumu::Konusma);
        assert_eq!(ornek_say(&c), 4 * KARE);
    }

    #[test]
    fn kapi_teshisi_gecikme_tampon_ifade_ve_acilmayan_adayi_sayar() {
        let mut k = MikKapisi::new(20);
        for _ in 0..3 {
            let _ = k.adim(&kare(0.02), KareDurumu::Sessiz);
        }
        let _ = k.adim(&kare(0.2), KareDurumu::Konusma);
        let teshis = k.ifade_teshisi.as_ref().expect("ifade teshisi baslamali");
        assert_eq!(teshis.acilis_gecikme_ornek, 4 * KARE);
        assert_eq!(teshis.on_tampon_ornek, 3 * KARE);
        assert_eq!(teshis.ifade_ornek, 4 * KARE);
        let _ = k.adim(&kare(0.2), KareDurumu::Konusma);
        assert_eq!(k.ifade_teshisi.as_ref().unwrap().ifade_ornek, 5 * KARE);
        let c = k.adim(&kare(0.0), KareDurumu::Sessiz);
        assert_eq!(c.last(), Some(&KapiCikti::AkisSonu));
        assert!(k.ifade_teshisi.is_none());

        let _ = k.adim(&kare(0.02), KareDurumu::Sessiz);
        let _ = k.adim(&kare(0.0), KareDurumu::Sessiz);
        assert_eq!(k.acilmayan_aday, 1);
    }

    #[test]
    fn konusma_sonrasi_artik_sure_gider_sonra_tek_akis_sonu() {
        let mut k = MikKapisi::new(1000);
        let _ = k.adim(&kare(1.0), KareDurumu::Konusma);
        let artik_kare = KAPI_ARTIK_ORNEK / KARE;
        assert_eq!(artik_kare * KARE, KAPI_ARTIK_ORNEK);
        for i in 0..artik_kare {
            let c = k.adim(&kare(0.0), KareDurumu::Sessiz);
            assert_eq!(ornek_say(&c), KARE, "artik surede kare gitmeli ({i})");
            if i + 1 < artik_kare {
                assert_eq!(akis_sonu_say(&c), 0);
                assert!(k.akis_acik());
            } else {
                assert_eq!(c.last(), Some(&KapiCikti::AkisSonu), "son karede AkisSonu");
            }
        }
        assert!(!k.akis_acik());
        // Sonrasi sessizlik: hicbir sey gitmez, ikinci AkisSonu da yok.
        for _ in 0..100 {
            assert!(k.adim(&kare(0.0), KareDurumu::Sessiz).is_empty());
        }
    }

    #[test]
    fn konusma_artik_sayaci_sifirlar() {
        let mut k = MikKapisi::new(1000);
        let _ = k.adim(&kare(1.0), KareDurumu::Konusma);
        // 800 ms sessizlik (esigin altinda), tekrar konusma, tekrar 800 ms.
        for _ in 0..40 {
            let c = k.adim(&kare(0.0), KareDurumu::Sessiz);
            assert_eq!(akis_sonu_say(&c), 0);
        }
        let _ = k.adim(&kare(1.0), KareDurumu::Konusma);
        for _ in 0..40 {
            let c = k.adim(&kare(0.0), KareDurumu::Sessiz);
            assert_eq!(akis_sonu_say(&c), 0, "sayac sifirlanmadi");
        }
        assert!(k.akis_acik());
    }

    #[test]
    fn kapali_acik_akisi_bir_kez_kapatir() {
        let mut k = MikKapisi::new(1000);
        let _ = k.adim(&kare(1.0), KareDurumu::Konusma);
        let c = k.adim(&kare(0.0), KareDurumu::Kapali);
        assert_eq!(c, vec![KapiCikti::AkisSonu], "karesiz, yalniz AkisSonu");
        assert!(!k.akis_acik());
        // Kapali surdukce ne kare ne ikinci AkisSonu.
        for _ in 0..50 {
            assert!(k.adim(&kare(0.0), KareDurumu::Kapali).is_empty());
        }
    }

    #[test]
    fn kapali_donem_on_tamponu_siler() {
        let mut k = MikKapisi::new(1000);
        for _ in 0..10 {
            let _ = k.adim(&kare(7.0), KareDurumu::Sessiz);
        }
        let _ = k.adim(&kare(0.0), KareDurumu::Kapali);
        let c = k.adim(&kare(9.0), KareDurumu::Konusma);
        let KapiCikti::Ses(ses) = &c[0] else {
            panic!("Ses bekleniyordu");
        };
        assert!(
            ses.iter().all(|s| *s == 9.0),
            "kapali donemden once kalan ses gonderildi"
        );
    }

    #[test]
    fn tipik_senaryoda_yalniz_konusma_ve_paylari_gider() {
        // 10 sn sessiz, 2 sn konusma, 10 sn sessiz (50 kare/sn).
        let mut k = MikKapisi::new(1000);
        let mut toplam = 0;
        let mut son = 0;
        for _ in 0..500 {
            let c = k.adim(&kare(0.0), KareDurumu::Sessiz);
            toplam += ornek_say(&c);
            son += akis_sonu_say(&c);
        }
        for _ in 0..100 {
            let c = k.adim(&kare(1.0), KareDurumu::Konusma);
            toplam += ornek_say(&c);
            son += akis_sonu_say(&c);
        }
        for _ in 0..500 {
            let c = k.adim(&kare(0.0), KareDurumu::Sessiz);
            toplam += ornek_say(&c);
            son += akis_sonu_say(&c);
        }
        // On-tampon + 2 sn konusma + sunucu sessizlik esigine pay birakan artik.
        assert_eq!(toplam, 16_000 * (ON_TAMPON_MS + 2000 + ARTIK_MS) / 1000);
        assert_eq!(son, 1, "tek konusma = tek AkisSonu");
    }

    /// Onceden verilen olasiliklari sirayla donen sahte VAD.
    struct SiraliVad {
        olasiliklar: Vec<f32>,
        i: usize,
    }

    impl VoiceActivityDetector for SiraliVad {
        fn predict(&mut self, chunk: Vec<f32>) -> f32 {
            assert_eq!(chunk.len(), CHUNK);
            let p = self.olasiliklar.get(self.i).copied().unwrap_or(0.0);
            self.i += 1;
            p
        }
    }

    fn izleyici(olasiliklar: &[f32]) -> KonusmaIzleyici {
        KonusmaIzleyici::new(Box::new(SiraliVad {
            olasiliklar: olasiliklar.to_vec(),
            i: 0,
        }))
    }

    #[test]
    fn izleyici_mikrofon_kapisi_esiklerini_kullanir() {
        // 0.2 sessiz; 0.41 > KAPI_START_THRESH(0.4) baslatir; 0.4 >= END(0.35)
        // surdurur; 0.3 < END bitirir; 0.39 < KAPI_START yeniden baslatmaz.
        let mut iz = izleyici(&[0.2, 0.41, 0.4, 0.3, 0.39]);
        let chunk = vec![0.0f32; CHUNK];
        assert!(
            iz.isle(&chunk).unwrap()[0].1 == KareDurumu::Sessiz,
            "0.2: sessiz"
        );
        assert!(
            iz.isle(&chunk).unwrap()[0].1 == KareDurumu::Konusma,
            "0.41: konusma basladi"
        );
        assert!(
            iz.isle(&chunk).unwrap()[0].1 == KareDurumu::Konusma,
            "0.4: gecikme, konusma surer"
        );
        assert!(
            iz.isle(&chunk).unwrap()[0].1 == KareDurumu::Sessiz,
            "0.3: bitti"
        );
        assert!(
            iz.isle(&chunk).unwrap()[0].1 == KareDurumu::Sessiz,
            "0.39: baslama esiginin altinda"
        );
    }

    #[test]
    fn izleyici_parcali_kareleri_chunk_olarak_biriktirir() {
        let mut iz = izleyici(&[0.9]);
        // 512 ornek icin 300 + 300 (ikinci cagrida chunk tamamlanir).
        assert!(
            iz.isle(&vec![0.0; 300]).unwrap().is_empty(),
            "chunk tamamlanmadi: karar eski"
        );
        assert!(
            iz.isle(&vec![0.0; 300]).unwrap()[0].1 == KareDurumu::Konusma,
            "chunk tamamlandi: konusma"
        );
    }

    #[test]
    fn izleyici_sifirla_karari_ve_yarim_chunk_i_atar() {
        let mut iz = izleyici(&[0.9, 0.9]);
        assert_eq!(
            iz.isle(&vec![0.0; CHUNK]).unwrap()[0].1,
            KareDurumu::Konusma
        );
        iz.sifirla();
        // Sifirlama sonrasi 300 ornek yeni chunk icin yetmez: karar false.
        assert!(iz.isle(&vec![0.0; 300]).unwrap().is_empty());
    }
}
