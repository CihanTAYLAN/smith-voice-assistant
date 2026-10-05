//! Konusma tamponlari, gizlilik ve kalici kayit kuyrugu.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// KONUSMA KALICILIGI
//
// Bugunku kusur: Live oturumunun transkripti yalniz stderr'e ve UI'a gidiyordu;
// uygulama kapaninca konusmanin tamami kayboluyordu. `sessionResumption` bunu
// COZMEZ : o yalniz ayni surec omru icinde, ~10 dakikalik oturum sinirlarini
// birbirine dikiyor.
//
// Cozum iki yonlu ve tel sozlesmesi gateway ile ORTAK:
//   POST /v1/tools/conversation/append   { role, text }
//   GET  /v1/tools/conversation/recent?limit&maxChars
// Oturum SINIRI KARARI SUNUCUDA: istemci oturum kimligi tasimaz, gondermez.
//
// GIZLILIK: buradan gecen metin Live konusmasinin transkriptidir, yani zaten
// Google'a gitmis ve gateway'de saklanan veridir. Yeni bir sizinti yuzeyi
// acilmiyor; `boot_context`'in sir tarama kapisi orada pencere BASLIKLARI
// (kullanicinin yazmadigi, cevreden toplanan veri) icin vardi.
// ---------------------------------------------------------------------------

/// Tel sozlesmesindeki rol degerleri. Tek yerde tanimli: yazma ve okuma
/// yollari ayni sabitleri kullanir, yazim hatasi sessizce yanlis rol uretemez.
const ROL_USER: &str = "user";
const ROL_ASSISTANT: &str = "assistant";

/// `recent` istegi: kac tur ve kac karakter istenir.
pub(super) const KONUSMA_LIMIT: usize = 12;
pub(super) const KONUSMA_MAX_CHARS: usize = 1000;

/// Yeniden baglanmada tekrar gonderilen konusma blogunun sert UTF-8 bayt tavani.
/// Sunucunun kirpmasina guvenilmez; en yeni turlar korunur, eski turlar duser.
const KONUSMA_MAX_BYTES: usize = 600;

/// Tek bir turun kirpildigini gosteren iz (ASCII: yonerge duz ASCII yazilir).
const KIRPMA_IZI: &str = "...";

/// Kalici kayit kuyrugu sinirli kalir; gateway kesintisinde en yeni 200 tur
/// korunur. Ses parcasi degil, tamamlanmis replikler tutulur.
const KAYIT_KUYRUK: usize = 200;

/// Modele hitap eden baslik. Metin INSANA DEGIL MODELE yazilir.
///
/// Yonerge satiri olmadan model bu blogu "rapor edilecek icerik" saniyor ve her
/// oturum acilisinda (yani ~10 dakikada bir) gecmisi ozetlemeye kalkiyor;
/// `boot_context::HEADER` ayni sebeple ayni kurali tasiyor.
const KONUSMA_BASLIK: &str = "[SON KONUSMA] Asagidaki satirlar bu oturumdan ONCEKI konusmanin \
son bolumudur (eskiden yeniye siralidir). Bu bir HATIRLATMADIR: listeyi okuma, ozetleme, \
'gecen sefer sunu konusmustuk' diye rapor verme. Konu devam ediyorsa kaldigin yerden dogal \
sur; devam etmiyorsa hic anma.";

/// Konusma kaliciligi acik mi (`SMITH_CONVERSATION_MEMORY=0` kapatir).
///
/// Env dikisi `SMITH_LIVE_RESUME` / `SMITH_BOOT_CONTEXT` ile ayni sozlesme:
/// varsayilan ACIK, yalniz birebir `"0"` kapatir. Boylece "tanimli ama bos"
/// veya "1" gibi degerler sessizce kapatmaz.
pub(super) fn konusma_hafizasi_acik() -> bool {
    !std::env::var("SMITH_CONVERSATION_MEMORY").is_ok_and(|v| v.trim() == "0")
}

/// Kalici kayda gonderilen, TAMAMLANMIS tek replik.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Replik {
    /// Tel degeri: `"user"` | `"assistant"`.
    role: &'static str,
    text: String,
}

/// `recent` yanitindan okunan tek tur.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Tur {
    pub(super) role: &'static str,
    pub(super) text: String,
}

/// Rolun modele gosterilecek etiketi.
pub(super) fn etiket(rol: &str) -> &'static str {
    if rol == ROL_ASSISTANT {
        "Smith"
    } else {
        "Cihan"
    }
}

/// Metni tek satira indirger: kontrol karakterleri ve satir sonlari bosluga
/// duser, tekrarli bosluk teklesir. Satir yapisi blogun sozlesmesidir; veri onu
/// bozarsa model rolleri yanlis eslestirir.
pub(super) fn tek_satir(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// `max` bayta kadar, KARAKTER SINIRINDA kirpar (UTF-8: Turkce harf 2 bayt,
/// bayt ortasindan kesmek panige yol acardi).
fn kirp(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut cut = max;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    &s[..cut]
}

/// `recent` yanitini turlere cevirir. Sira ESKIDEN YENIYE korunur.
fn turlari_ayristir(v: &serde_json::Value) -> Vec<Tur> {
    let Some(arr) = v["turns"].as_array() else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(arr.len());
    for t in arr {
        // ROL TAHMIN EDILMEZ: taninmayan rol ATILIR. Yanlis eslemek modelin
        // kendi sozlerini Cihan'a atfetmesine yol acar : sessiz ve sinsi bir
        // kusur; eksik bir satirin bedeli ise yalnizca eksiklik.
        let rol = match t["role"].as_str() {
            Some(r) if r == ROL_ASSISTANT => ROL_ASSISTANT,
            Some(r) if r == ROL_USER => ROL_USER,
            other => {
                eprintln!("[konusma] taninmayan rol atlandi: {other:?}");
                continue;
            }
        };
        let metin = tek_satir(t["text"].as_str().unwrap_or_default());
        if metin.is_empty() {
            continue;
        }
        out.push(Tur {
            role: rol,
            text: metin,
        });
    }
    out
}

/// Yanittan yonergeye eklenecek blok.
///
/// `acik` bayragi DISARIDAN verilir (env okumasi cagirana ait : `devralma_niyeti`
/// ile ayni disiplin): boylece testler ortam degiskeni yarisina girmeden iki
/// halini de dogrular. `yanit` yoksa (gateway kapali veya hata) blok URETILMEZ.
pub(super) fn konusma_eki(acik: bool, yanit: Option<&serde_json::Value>) -> String {
    if !acik {
        return String::new();
    }
    let Some(v) = yanit else {
        return String::new();
    };
    konusma_blogu(&turlari_ayristir(v))
}

/// Turlari tek bloga cevirir. DAIMA `KONUSMA_MAX_BYTES` icinde kalir.
fn konusma_blogu(turlar: &[Tur]) -> String {
    let mut satirlar: Vec<String> = Vec::new();
    let mut toplam = KONUSMA_BASLIK.len();
    // EN YENIDEN ESKIYE yurunur: tavan asilinca dusen daima EN ESKI turdur ve
    // EN YENI tur her halukarda kalir (konusmanin son hali en degerli olan).
    for t in turlar.iter().rev() {
        let bas = format!("\n{}: ", etiket(t.role));
        if toplam + bas.len() + t.text.len() <= KONUSMA_MAX_BYTES {
            toplam += bas.len() + t.text.len();
            satirlar.push(format!("{bas}{}", t.text));
            continue;
        }
        if !satirlar.is_empty() {
            break; // yer bitti: daha eski turlar hic girmez
        }
        // EN YENI tur tek basina sigmiyor: kirpilir ama ASLA tamamen atilmaz.
        let pay = KONUSMA_MAX_BYTES.saturating_sub(toplam + bas.len() + KIRPMA_IZI.len());
        let kirpik = kirp(&t.text, pay).trim_end();
        if kirpik.is_empty() {
            return String::new(); // anlamli tek kelime bile sigmiyor
        }
        toplam += bas.len() + kirpik.len() + KIRPMA_IZI.len();
        satirlar.push(format!("{bas}{kirpik}{KIRPMA_IZI}"));
        break;
    }
    if satirlar.is_empty() {
        return String::new();
    }
    satirlar.reverse(); // tele/modele ESKIDEN YENIYE gider
    let mut s = String::with_capacity(toplam);
    s.push_str(KONUSMA_BASLIK);
    for satir in satirlar {
        s.push_str(&satir);
    }
    s
}

/// Saf, sinirli FIFO. Kimlik monoton artar: ayni tur yeniden eklenmez.
/// HTTP tekrarinda oturum oneki + yerel sira ayni client_message_id uretir.
#[derive(Default)]
struct KayitKuyrugu {
    bekleyen: std::collections::VecDeque<(u64, Replik)>,
    son_id: u64,
    tasma_loglandi: bool,
    tasma_zamani: Option<std::time::Instant>,
    hata_sayisi: u32,
    yeniden: Option<std::time::Instant>,
    kapanis: Option<std::time::Instant>,
}

impl KayitKuyrugu {
    /// true: bu tasma doneminin ilk kaybi, bir kez loglanmali.
    fn ekle(&mut self, id: u64, mut replik: Replik) -> bool {
        if id <= self.son_id {
            return false;
        }
        self.son_id = id;
        replik.text = replik.text.chars().take(4000).collect();
        self.bekleyen.push_back((id, replik));
        let mut tasti = false;
        while self.bekleyen.len() > KAYIT_KUYRUK
            || self
                .bekleyen
                .iter()
                .map(|(_, r)| r.text.len() + r.role.len() + 64)
                .sum::<usize>()
                > 256 * 1024
        {
            self.bekleyen.pop_front();
            tasti = true;
        }
        let logla = tasti
            && !self.tasma_loglandi
            && self.tasma_zamani.is_none_or(|t| t.elapsed().as_secs() >= 5);
        if logla {
            self.tasma_zamani = Some(std::time::Instant::now());
        }
        self.tasma_loglandi |= tasti;
        logla
    }

    fn tamamla(&mut self, id: u64, basarili: bool, simdi: std::time::Instant) {
        if basarili {
            // HTTP sirasinda tasma olduysa yeni front'u silme.
            if self.bekleyen.front().is_some_and(|r| r.0 == id) {
                self.bekleyen.pop_front();
            }
            self.hata_sayisi = 0;
            self.yeniden = None;
            self.tasma_loglandi = false;
        } else {
            let sure = (5u64 << self.hata_sayisi.min(4)).min(60);
            self.hata_sayisi = self.hata_sayisi.saturating_add(1);
            self.yeniden = Some(simdi + std::time::Duration::from_secs(sure));
        }
    }
}

#[derive(Default)]
pub(super) struct KayitYazici {
    paylasilan: Arc<(std::sync::Mutex<KayitKuyrugu>, std::sync::Condvar)>,
    thread: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl KayitYazici {
    fn ekle(&self, replik: Replik) {
        let (kilit, uyan) = &*self.paylasilan;
        let mut q = kilit.lock().unwrap_or_else(|e| e.into_inner());
        if q.kapanis.is_some() {
            return;
        }
        let id = q.son_id + 1;
        if q.ekle(id, replik) {
            eprintln!("[konusma] kayit kuyrugu dolu: en eski tur dusuruldu (sinir={KAYIT_KUYRUK})");
        }
        uyan.notify_one();
    }
}

static YAZICI: std::sync::OnceLock<KayitYazici> = std::sync::OnceLock::new();
pub(super) static KAPANIYOR: AtomicBool = AtomicBool::new(false);
static ALICILAR: (std::sync::Mutex<usize>, std::sync::Condvar) =
    (std::sync::Mutex::new(0), std::sync::Condvar::new());

pub(super) struct AliciKaydi;
impl AliciKaydi {
    pub(super) fn yeni() -> Self {
        *ALICILAR.0.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        Self
    }
}
impl Drop for AliciKaydi {
    fn drop(&mut self) {
        *ALICILAR.0.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        ALICILAR.1.notify_all();
    }
}

fn kayit_govdesi(oturum: &str, id: u64, r: &Replik) -> serde_json::Value {
    serde_json::json!({"role": r.role, "text": r.text,
        "client_message_id": format!("{oturum}_{id:x}")})
}

impl KayitYazici {
    fn baslat(
        mut gonder: impl FnMut(serde_json::Value) -> Result<(), String> + Send + 'static,
    ) -> Self {
        let yazici = Self::default();
        let paylasilan = yazici.paylasilan.clone();
        let oturum = format!(
            "{:x}_{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let thread = std::thread::spawn(move || {
            let (kilit, uyan) = &*paylasilan;
            loop {
                let (id, r) = {
                    let mut q = kilit.lock().unwrap_or_else(|e| e.into_inner());
                    loop {
                        let simdi = std::time::Instant::now();
                        if q.kapanis
                            .is_some_and(|son| q.bekleyen.is_empty() || simdi >= son)
                        {
                            if !q.bekleyen.is_empty() {
                                eprintln!(
                                    "[konusma] kapanis suresi doldu: {} replik kaldi",
                                    q.bekleyen.len()
                                );
                            }
                            return;
                        }
                        let kalan = q
                            .yeniden
                            .map(|t| t.saturating_duration_since(simdi))
                            .unwrap_or_default();
                        if !q.bekleyen.is_empty() && kalan.is_zero() {
                            break q.bekleyen.front().unwrap().clone();
                        }
                        let bekle = q
                            .kapanis
                            .map(|son| son.saturating_duration_since(simdi))
                            .unwrap_or(std::time::Duration::from_secs(60));
                        let bekle = if kalan.is_zero() {
                            bekle
                        } else {
                            bekle.min(kalan)
                        };
                        q = uyan
                            .wait_timeout(q, bekle)
                            .unwrap_or_else(|e| e.into_inner())
                            .0;
                    }
                };
                let sonuc = gonder(kayit_govdesi(&oturum, id, &r));
                let mut q = kilit.lock().unwrap_or_else(|e| e.into_inner());
                q.tamamla(id, sonuc.is_ok(), std::time::Instant::now());
                if let Err(e) = sonuc {
                    eprintln!("[konusma] kayit basarisiz (tur={id}), kuyrukta: {e}");
                }
            }
        });
        *yazici.thread.lock().unwrap() = Some(thread);
        yazici
    }

    #[cfg(test)]
    fn kapat(&self) {
        self.kapat_son(std::time::Instant::now() + std::time::Duration::from_secs(2));
    }

    fn kapat_son(&self, son: std::time::Instant) {
        let Some(thread) = self.thread.lock().unwrap_or_else(|e| e.into_inner()).take() else {
            return;
        };
        {
            let mut q = self.paylasilan.0.lock().unwrap_or_else(|e| e.into_inner());
            // Her HTTP adimi 400 ms ile sinirli; login + append icin 800 ms
            // pay birakilir. Join dahil toplam kapanis butcesi iki saniyedir.
            q.kapanis = Some(son - std::time::Duration::from_millis(900));
            q.yeniden = None;
        }
        self.paylasilan.1.notify_all();
        if thread.join().is_err() {
            eprintln!("[konusma] yazici thread panikledi");
        }
    }
}

pub fn konusma_kapat() {
    let son = std::time::Instant::now() + std::time::Duration::from_secs(2);
    KAPANIYOR.store(true, Ordering::Relaxed);
    // Alici en gec 100 ms'de son transkripti kuyruga koyar. Ortak butce
    // kullanilir; alici + yazici icin ayri ayri iki saniye beklenmez.
    let alicilar = ALICILAR.0.lock().unwrap_or_else(|e| e.into_inner());
    let _ = ALICILAR
        .1
        .wait_timeout_while(alicilar, std::time::Duration::from_millis(300), |n| *n > 0);
    if let Some(yazici) = YAZICI.get() {
        yazici.kapat_son(son);
    }
}

pub(super) fn konusma_yazici() -> Option<&'static KayitYazici> {
    if !konusma_hafizasi_acik() {
        return None;
    }
    Some(YAZICI.get_or_init(|| {
        let gateway = crate::gateway::GatewayClient::kayit_yazici();
        KayitYazici::baslat(move |govde| {
            gateway.post_kuyruk("/v1/tools/conversation/append", &govde)
        })
    }))
}

#[derive(Default)]
pub(super) struct TurTamponu {
    pub(super) input: String,
    pub(super) output: String,
}

impl TurTamponu {
    pub(super) fn ekle(&mut self, smith: bool, text: &str) {
        let buf = if smith {
            &mut self.output
        } else {
            &mut self.input
        };
        let kalan = 4000usize.saturating_sub(buf.chars().count());
        buf.extend(text.chars().take(kalan));
    }
    pub(super) fn bitir(
        mut self,
        karar: crate::audio::SpeakerVerdict,
        kayit: Option<&KayitYazici>,
    ) {
        if karar == crate::audio::SpeakerVerdict::Foreign {
            eprintln!("[konusma] yabanci tur kayda yazilmadi");
            return;
        }
        // Kisa ifadeler ses izi uretemeyebilir. Unknown eski davranisi korur;
        // bir Owner tum turu sahiplenir, Owner yoksa Foreign kaydi engeller.
        flush_line(&mut Some(false), &mut self.input, kayit);
        flush_line(&mut Some(true), &mut self.output, kayit);
    }
    pub(super) fn bytes(&self) -> usize {
        self.input.len() + self.output.len()
    }
}

// Ses izi gec dondugunde WS okuyucusu beklemez. Tamamlanmis turlar FIFO'da
// tutulur; karar hazir olunca kullanici ve asistan birlikte commit edilir.
#[derive(Default)]
pub(super) struct TurKayitlari {
    pub(super) bekleyen: std::collections::VecDeque<(u64, u64, TurTamponu)>,
    pub(super) son_sinir: u64,
    pub(super) tasma: bool,
}
impl TurKayitlari {
    pub(super) fn ekle(&mut self, no: u64, tur: TurTamponu, kayit: Option<&KayitYazici>) {
        let ilk = self.son_sinir;
        self.son_sinir = no;
        if tur.bytes() == 0 {
            return;
        }
        self.bekleyen.push_back((ilk, no, tur));
        let mut q = kayit.map(|k| k.paylasilan.0.lock().unwrap_or_else(|e| e.into_inner()));
        while self
            .bekleyen
            .iter()
            .map(|(_, _, t)| t.bytes())
            .sum::<usize>()
            + q.as_ref().map_or(0, |q| {
                q.bekleyen
                    .iter()
                    .map(|(_, r)| r.text.len() + 64 + r.role.len())
                    .sum::<usize>()
            })
            > 256 * 1024
        {
            // Yazici kuyrugundakiler karar bekleyenlerden eskidir.
            if !q.as_mut().is_some_and(|q| q.bekleyen.pop_front().is_some()) {
                self.bekleyen.pop_front();
            }
            if !self.tasma {
                eprintln!("[konusma] karar kuyrugu dolu: en eski tur dusuruldu");
            }
            self.tasma = true;
        }
    }
    pub(super) fn ilerle(
        &mut self,
        speaker: &crate::audio::speaker::SpeakerGate,
        kayit: Option<&KayitYazici>,
    ) {
        while let Some((ilk, no, _)) = self.bekleyen.front() {
            let Some(karar) = speaker.kayit_karari(*ilk, *no) else {
                break;
            };
            self.bekleyen.pop_front().unwrap().2.bitir(karar, kayit);
            self.tasma = false;
        }
    }
}

pub(super) fn sessiz_yanit(text: &str) -> bool {
    text.chars()
        .all(|c| c.is_whitespace() || c == '.' || c == '\u{2026}')
}

fn flush_line(role: &mut Option<bool>, text: &mut String, kayit: Option<&KayitYazici>) {
    let trimmed = text.trim();
    let smith = *role == Some(true);
    if !trimmed.is_empty() && !(smith && sessiz_yanit(trimmed)) {
        let who = if smith { "smith" } else { "sen" };
        super::log_transcript(&format!("konusma {who}"), trimmed);
        let replik = Replik {
            role: if smith { ROL_ASSISTANT } else { ROL_USER },
            text: trimmed.chars().take(4000).collect(),
        };
        if smith {
            crate::proactive_memory::isle(&replik.text, std::time::SystemTime::now());
        }
        if let Some(tx) = kayit {
            tx.ekle(replik);
        }
    }
    text.clear();
    *role = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::super::connection::Devralma;

    use super::super::setup::{setup_frame_ile_ek, sistem_yonergesi, Sikistirma, SYSTEM};

    #[test]
    fn audit_yazici_tekrarinda_kimlik_ayni_kalir() {
        let (gonder, al) = std::sync::mpsc::channel();
        let mut ilk = true;
        let tx = KayitYazici::baslat(move |v| {
            gonder.send(v).unwrap();
            if std::mem::take(&mut ilk) {
                Err("yanit kayboldu".into())
            } else {
                Ok(())
            }
        });
        tx.ekle(replik("ayni mesaj"));
        let bir = al.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        let son = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while tx.paylasilan.0.lock().unwrap().hata_sayisi == 0 {
            assert!(std::time::Instant::now() < son);
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        // Kapanis retry beklemesini kaldirir ve AYNI mesaji tekrar yollar.
        tx.kapat();
        let iki = al.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        assert_eq!(bir, iki);
        assert!(tx.paylasilan.0.lock().unwrap().bekleyen.is_empty());
    }

    #[test]
    fn audit_karar_ve_yazici_kuyrugu_ortak_butce() {
        let tx = KayitYazici::default();
        for _ in 0..12 {
            tx.ekle(replik(&"x".repeat(4000)));
        }
        let mut bekleyen = TurKayitlari::default();
        for i in 0..40 {
            let mut tur = TurTamponu::default();
            tur.ekle(false, &"😀".repeat(4000));
            bekleyen.ekle(i, tur, Some(&tx));
        }
        let q = tx.paylasilan.0.lock().unwrap();
        assert!(
            q.bekleyen.is_empty(),
            "en eski yazici replikleri once dusmeli"
        );
        let bytes = bekleyen
            .bekleyen
            .iter()
            .map(|(_, _, t)| t.bytes())
            .sum::<usize>();
        assert!(bytes <= 256 * 1024);
        assert!(bekleyen.bekleyen.front().unwrap().0 > 0);
    }
    #[test]
    fn audit_tur_sirasi_gizlilik_ve_kimlik() {
        use crate::audio::SpeakerVerdict::*;
        for (karar, adet) in [(Owner, 2), (Unknown, 2), (Foreign, 0)] {
            let tx = KayitYazici::default();
            let mut tur = TurTamponu::default();
            tur.ekle(true, "cevap ");
            tur.ekle(false, "soru ");
            tur.ekle(true, "sonu");
            tur.ekle(false, "sonu");
            tur.bitir(karar, Some(&tx));
            let q = tx.paylasilan.0.lock().unwrap();
            assert_eq!(q.bekleyen.len(), adet);
            if adet == 2 {
                assert_eq!(q.bekleyen[0].1.role, ROL_USER);
                assert_eq!(q.bekleyen[0].1.text, "soru sonu");
                assert_eq!(q.bekleyen[1].1.role, ROL_ASSISTANT);
                assert_eq!(q.bekleyen[1].1.text, "cevap sonu");
                let ilk = kayit_govdesi("oturum_123", 1, &q.bekleyen[0].1);
                assert_eq!(ilk, kayit_govdesi("oturum_123", 1, &q.bekleyen[0].1));
                assert_ne!(
                    ilk["client_message_id"],
                    kayit_govdesi("oturum_123", 2, &q.bekleyen[0].1)["client_message_id"]
                );
                let id = ilk["client_message_id"].as_str().unwrap();
                assert!((8..=64).contains(&id.len()));
                assert!(id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'));
            }
        }
    }

    #[test]
    fn audit_tampon_utf8_siniri() {
        let mut tur = TurTamponu::default();
        for _ in 0..5000 {
            tur.ekle(false, "ş😀");
            tur.ekle(true, "ü😀");
        }
        assert_eq!(tur.input.chars().count(), 4000);
        assert_eq!(tur.output.chars().count(), 4000);
    }

    #[test]
    fn audit_yazici_kapanista_fifo_drain_ve_join() {
        let gelen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let kopya = gelen.clone();
        let tx = KayitYazici::baslat(move |v| {
            kopya.lock().unwrap().push(v);
            Ok(())
        });
        for i in 0..5 {
            tx.ekle(replik(&format!("replik {i}")));
        }
        tx.kapat();
        tx.kapat();
        assert!(tx.thread.lock().unwrap().is_none());
        let gelen = gelen.lock().unwrap();
        assert_eq!(gelen.len(), 5);
        for (i, v) in gelen.iter().enumerate() {
            assert_eq!(v["text"], format!("replik {i}"));
        }
    }

    #[test]
    fn audit_yazici_hata_kapanisi_sinirli() {
        let tx = KayitYazici::baslat(|_| Err("ulasamiyor".into()));
        tx.ekle(replik("korunacak"));
        let bas = std::time::Instant::now();
        tx.kapat();
        assert!(bas.elapsed() < std::time::Duration::from_secs(2));
        assert_eq!(tx.paylasilan.0.lock().unwrap().bekleyen.len(), 1);
    }

    #[test]
    fn audit_kayit_butcesi_ve_uc_nokta() {
        let tx = KayitYazici::default();
        flush_line(&mut Some(true), &mut "...".into(), Some(&tx));
        assert!(tx.paylasilan.0.lock().unwrap().bekleyen.is_empty());
        flush_line(&mut Some(false), &mut "ş😀".repeat(5000), Some(&tx));
        assert_eq!(
            tx.paylasilan.0.lock().unwrap().bekleyen[0]
                .1
                .text
                .chars()
                .count(),
            4000
        );
    }

    #[test]
    fn audit_kuyruk_bayt_siniri() {
        let mut q = KayitKuyrugu::default();
        for id in 1..=200 {
            q.ekle(id, replik(&"😀".repeat(4000)));
        }
        assert!(q.bekleyen.iter().map(|(_, r)| r.text.len()).sum::<usize>() <= 256 * 1024);
    }

    fn replik(metin: &str) -> Replik {
        Replik {
            role: ROL_USER,
            text: metin.into(),
        }
    }

    #[test]
    fn kayit_fifo_hata_tekrar_ve_kimlik() {
        let mut q = KayitKuyrugu::default();
        let simdi = std::time::Instant::now();
        q.ekle(1, replik("ayni"));
        q.ekle(2, replik("ayni"));
        q.ekle(2, replik("duplicate"));
        assert_eq!(q.bekleyen.len(), 2);
        q.tamamla(1, false, simdi);
        assert_eq!(q.bekleyen.front().unwrap().0, 1);
        q.tamamla(1, true, simdi);
        q.ekle(1, replik("ack sonrasi duplicate"));
        assert_eq!(q.bekleyen.len(), 1);
        assert_eq!(q.bekleyen.front().unwrap().0, 2);
        q.tamamla(2, true, simdi);
        assert!(q.bekleyen.is_empty());
    }

    #[test]
    fn kayit_tasma_tek_log_ve_gec_ack_yeni_turu_silmez() {
        let mut q = KayitKuyrugu::default();
        for id in 1..=KAYIT_KUYRUK as u64 {
            assert!(!q.ekle(id, replik("tur")));
        }
        assert!(q.ekle(201, replik("yeni")));
        assert!(!q.ekle(202, replik("yeni")));
        assert_eq!(q.bekleyen.len(), 200);
        assert_eq!(q.bekleyen.front().unwrap().0, 3);
        q.tamamla(1, true, std::time::Instant::now());
        assert_eq!(q.bekleyen.front().unwrap().0, 3);
    }

    #[test]
    fn kayit_retry_5_60_tavani_yeni_tur_ertelemez_basari_sifirlar() {
        let mut q = KayitKuyrugu::default();
        let simdi = std::time::Instant::now();
        q.ekle(1, replik("tur"));
        for sn in [5, 10, 20, 40, 60, 60] {
            q.tamamla(1, false, simdi);
            assert_eq!(q.yeniden.unwrap().duration_since(simdi).as_secs(), sn);
        }
        let yeniden = q.yeniden;
        q.ekle(2, replik("yeni"));
        assert_eq!(q.yeniden, yeniden);
        q.tamamla(1, true, simdi);
        assert_eq!(q.yeniden, None);
        q.tamamla(2, false, simdi);
        assert_eq!(q.yeniden.unwrap().duration_since(simdi).as_secs(), 5);
    }

    // ---- KONUSMA KALICILIGI ----
    //
    // Bu testler AGA CIKMAZ: gateway yanitlari tel sozlesmesinin birebir JSON
    // sekliyle enjekte edilir ve yazma yolu kanal ucundan gozlenir.
    //   POST /v1/tools/conversation/append  { role, text }
    //        -> { sessionId, messageId, yeniOturum }
    //   GET  /v1/tools/conversation/recent  ?limit&maxChars
    //        -> { sessionId, turns: [{ role, text, at }], kesildi }

    /// Tel seklinde bir `recent` yaniti uretir (test kolayligi icin).
    fn recent(turlar: &[(&str, &str)]) -> serde_json::Value {
        let t: Vec<serde_json::Value> = turlar
            .iter()
            .map(|(r, x)| serde_json::json!({ "role": r, "text": x, "at": "2026-08-15T09:12:04.317Z" }))
            .collect();
        serde_json::json!({ "sessionId": "ses_01J8ZKQ9", "turns": t, "kesildi": false })
    }

    /// Yanit GERCEK JSON seklinden ayristirilir: bos / tek / cok tur.
    #[test]
    fn recent_yaniti_gercek_json_seklinden_ayristirilir() {
        let bos: serde_json::Value =
            serde_json::from_str(r#"{"sessionId":null,"turns":[],"kesildi":false}"#)
                .expect("gecerli JSON");
        assert!(turlari_ayristir(&bos).is_empty());
        assert_eq!(
            konusma_eki(true, Some(&bos)),
            "",
            "bos kayitta blok olmamali"
        );

        let tek: serde_json::Value = serde_json::from_str(
            r#"{"sessionId":"ses_01J8ZKQ9","turns":[
                {"role":"user","text":"gateway'i yeniden baslat","at":"2026-08-15T09:12:04.317Z"}
            ],"kesildi":false}"#,
        )
        .expect("gecerli JSON");
        assert_eq!(
            turlari_ayristir(&tek),
            vec![Tur {
                role: ROL_USER,
                text: "gateway'i yeniden baslat".into()
            }]
        );

        let cok: serde_json::Value = serde_json::from_str(
            r#"{"sessionId":"ses_01J8ZKQ9","turns":[
                {"role":"user","text":"disk doluluk ne durumda","at":"2026-08-15T09:12:04.317Z"},
                {"role":"assistant","text":"C: %97 dolu.","at":"2026-08-15T09:12:07.001Z"},
                {"role":"user","text":"temizle o zaman","at":"2026-08-15T09:12:20.442Z"}
            ],"kesildi":true}"#,
        )
        .expect("gecerli JSON");
        let turlar = turlari_ayristir(&cok);
        assert_eq!(turlar.len(), 3);
        // Sira ESKIDEN YENIYE korunur : ters cevirmek konusmayi anlamsiz yapar.
        assert_eq!(turlar[0].text, "disk doluluk ne durumda");
        assert_eq!(turlar[2].text, "temizle o zaman");

        let blok = konusma_blogu(&turlar);
        assert!(blok.starts_with(KONUSMA_BASLIK), "baslik yok: {blok}");
        // ROL ETIKETI: Smith'in cumlesi Smith'e, Cihan'inki Cihan'a. Ters
        // esleme modelin kendi sozlerini kullaniciya atfetmesine yol acar.
        assert!(
            blok.contains("\nSmith: C: %97 dolu."),
            "assistant turu Smith'e yazilmamis: {blok}"
        );
        assert!(
            blok.contains("\nCihan: temizle o zaman"),
            "user turu Cihan'a yazilmamis: {blok}"
        );
        assert!(
            !blok.contains("\nCihan: C: %97 dolu."),
            "Smith'in cumlesi Cihan'a atfedilmis: {blok}"
        );
    }

    /// Taninmayan rol ATILIR. Contrat degistiginde tahmin etmek, modelin kendi
    /// sozlerini kullaniciya atfetmesi demektir; eksik satirin bedeli yalnizca
    /// eksikliktir.
    #[test]
    fn taninmayan_rol_atlanir() {
        let v = recent(&[
            ("system", "gizli yonerge"),
            ("model", "eski sema"),
            ("user", "bu kalir"),
        ]);
        let turlar = turlari_ayristir(&v);
        assert_eq!(
            turlar,
            vec![Tur {
                role: ROL_USER,
                text: "bu kalir".into()
            }],
            "taninmayan rol bir sekilde gecmis: {turlar:?}"
        );
    }

    /// BAYT TAVANI. Blok sistem yonergesine giriyor ve oturum ~10 dakikada bir
    /// yeniden kuruluyor: tavan asilirsa her yeniden baglanmada kota yenir.
    #[test]
    fn konusma_blogu_bayt_tavanini_asla_asmaz() {
        // Tavanin KENDISI de bir karardir: const'u buyutmek bu testi kendi
        // kendine gecerli kilmasin. Ust sinir `boot_context`'in tavani :
        // konusma kuyrugu, olculen acilis fotografindan daha az yer hak eder.
        assert!(
            KONUSMA_MAX_BYTES <= crate::boot_context::MAX_BYTES,
            "konusma tavani acilis baglami tavanini gecmis ({KONUSMA_MAX_BYTES} > {})",
            crate::boot_context::MAX_BYTES
        );
        assert!(
            KONUSMA_BASLIK.len() + 80 < KONUSMA_MAX_BYTES,
            "baslik tek basina tavani dolduruyor: en az bir tur icin yer kalmali"
        );

        // 12 uzun tur, Turkce harflerle: bayt saymanin karakter saymaktan
        // farkli oldugunu da zorlar (Turkce harf UTF-8'de 2 bayt).
        let uzun: Vec<(String, String)> = (0..12)
            .map(|i| {
                let rol = if i % 2 == 0 { "user" } else { "assistant" };
                (
                    rol.to_string(),
                    format!("tur{i} ") + &"çok uzun bir cümle ".repeat(30),
                )
            })
            .collect();
        let refs: Vec<(&str, &str)> = uzun.iter().map(|(r, t)| (r.as_str(), t.as_str())).collect();
        let blok = konusma_blogu(&turlari_ayristir(&recent(&refs)));
        assert!(
            blok.len() <= KONUSMA_MAX_BYTES,
            "tavan asildi: {} bayt\n{blok}",
            blok.len()
        );

        // TEK tur tek basina tavani asiyor: kirpilir ama blok yine gecerli ve
        // tavan icinde kalir.
        let dev = "x".repeat(5000);
        let blok = konusma_blogu(&turlari_ayristir(&recent(&[("assistant", &dev)])));
        assert!(
            blok.len() <= KONUSMA_MAX_BYTES,
            "tek dev turda tavan asildi: {} bayt",
            blok.len()
        );
        assert!(blok.starts_with(KONUSMA_BASLIK), "baslik dusmus");
        assert!(blok.ends_with(KIRPMA_IZI), "kirpma izi yok: {blok}");
    }

    /// Tavan asilinca EN ESKI tur duser, EN YENI daima kalir.
    #[test]
    fn tavan_asilinca_en_eski_duser_en_yeni_kalir() {
        let dolgu = "dolgu cumlesi ".repeat(20);
        let turlar: Vec<(String, String)> = (0..10)
            .map(|i| {
                let rol = if i % 2 == 0 { "user" } else { "assistant" };
                (rol.to_string(), format!("ISARET{i} {dolgu}"))
            })
            .collect();
        let refs: Vec<(&str, &str)> = turlar
            .iter()
            .map(|(r, t)| (r.as_str(), t.as_str()))
            .collect();
        let blok = konusma_blogu(&turlari_ayristir(&recent(&refs)));

        assert!(blok.len() <= KONUSMA_MAX_BYTES);
        assert!(
            blok.contains("ISARET9"),
            "EN YENI tur dusmus — konusmanin son hali en degerli olan: {blok}"
        );
        assert!(
            !blok.contains("ISARET0"),
            "EN ESKI tur kalmis ama tavan asilmiyor: kirpma yanlis uctan yapiliyor"
        );
        // Kalan turlar hala ESKIDEN YENIYE sirali mi?
        let mut onceki = -1i32;
        for satir in blok.lines().skip(1) {
            let n: i32 = satir
                .split("ISARET")
                .nth(1)
                .and_then(|s| s.split_whitespace().next())
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(|| panic!("isaret okunamadi: {satir}"));
            assert!(n > onceki, "sira bozulmus ({onceki} -> {n}):\n{blok}");
            onceki = n;
        }
    }

    /// Gateway kapali / hata / bos yanit -> blok HIC uretilmez. Uydurma yok:
    /// bilgi yoksa modele hicbir sey soylenmez.
    #[test]
    fn gateway_yoksa_veya_yanit_bossa_blok_uretilmez() {
        assert_eq!(konusma_eki(true, None), "", "hata halinde blok uretilmis");
        for ham in [
            r#"{}"#,
            r#"{"sessionId":null,"turns":[],"kesildi":false}"#,
            r#"{"turns":[{"role":"user","text":"   "}]}"#,
            r#"{"turns":[{"role":"user"}]}"#,
            r#"{"turns":"bozuk"}"#,
        ] {
            let v: serde_json::Value = serde_json::from_str(ham).expect("gecerli JSON");
            assert_eq!(
                konusma_eki(true, Some(&v)),
                "",
                "blok uretilmemeliydi: {ham}"
            );
        }
    }

    /// Kapaliyken blok URETILMEZ. Env dikisi `SMITH_LIVE_RESUME` ile ayni
    /// sozlesmede: varsayilan ACIK, yalniz birebir "0" kapatir.
    #[test]
    fn konusma_hafizasi_kapaliyken_blok_uretilmez() {
        let dolu = recent(&[("user", "bir sey"), ("assistant", "baska sey")]);
        assert_eq!(
            konusma_eki(false, Some(&dolu)),
            "",
            "ozellik kapaliyken blok uretilmis"
        );
        assert!(!konusma_eki(true, Some(&dolu)).is_empty(), "acikken bos");

        let onceki = std::env::var("SMITH_CONVERSATION_MEMORY").ok();
        std::env::remove_var("SMITH_CONVERSATION_MEMORY");
        assert!(konusma_hafizasi_acik(), "varsayilan ACIK olmali");
        std::env::set_var("SMITH_CONVERSATION_MEMORY", "1");
        assert!(konusma_hafizasi_acik());
        std::env::set_var("SMITH_CONVERSATION_MEMORY", "0");
        assert!(
            !konusma_hafizasi_acik(),
            "SMITH_CONVERSATION_MEMORY=0 kapatmali"
        );
        assert_eq!(
            konusma_eki(konusma_hafizasi_acik(), Some(&dolu)),
            "",
            "env kapaliyken blok uretilmis"
        );
        match onceki {
            Some(v) => std::env::set_var("SMITH_CONVERSATION_MEMORY", v),
            None => std::env::remove_var("SMITH_CONVERSATION_MEMORY"),
        }
    }

    /// Blok SABIT yonergenin ONUNE gecemez (`dinamik_ek_yonergeyi_ezmez...`
    /// ilkesi): gecerse butun kisilik ve guvenlik kurallari sessizce duserdi.
    #[test]
    fn konusma_blogu_sabit_yonergenin_onune_gecmez() {
        let blok = konusma_blogu(&turlari_ayristir(&recent(&[
            ("user", "disk doluluk ne durumda"),
            ("assistant", "C: %97 dolu."),
        ])));
        assert!(!blok.is_empty(), "test icin blok uretilmeliydi");

        let yonerge = sistem_yonergesi(&blok);
        assert!(
            yonerge.starts_with(SYSTEM),
            "konusma blogu sabit yonergenin onune gecmis"
        );
        assert!(yonerge.contains(KONUSMA_BASLIK), "blok kaybolmus");
        for cirpi in ["Sen Smith'sin", "IKI KADEME", "PROAKTIFLIK:"] {
            assert!(
                yonerge.contains(cirpi),
                "blok sonrasi '{cirpi}' kurali kaybolmus"
            );
        }

        // Blok TELE de girmeli: `systemInstruction` disinda kalirsa hatirlatma
        // modele hic ulasmaz.
        let govde = setup_frame_ile_ek(Devralma::Yeni, &blok, Sikistirma::Kapali);
        let json: serde_json::Value = serde_json::from_str(&govde).expect("gecerli JSON");
        let metin = json["setup"]["systemInstruction"]["parts"][0]["text"]
            .as_str()
            .expect("systemInstruction metni");
        assert!(metin.contains("[SON KONUSMA]"), "blok setup'a girmemis");
    }

    /// ROL ESLEMESI: Smith -> `assistant`, kullanici -> `user`. Ters esleme
    /// modelin kendi sozlerini Cihan'a atfetmesine yol acar : sessiz ve sinsi
    /// bir kusur, bu yuzden ayri bir kapisi var.
    #[test]
    fn flush_line_rol_eslemesini_ters_cevirmez() {
        let tx = KayitYazici::default();
        // (pending_role, beklenen wire rolu)
        for (rol, beklenen) in [
            (Some(true), ROL_ASSISTANT), // true = Smith
            (Some(false), ROL_USER),     // false = kullanici
            (None, ROL_USER),            // rol bilinmiyorsa kullanici (mevcut kural)
        ] {
            let mut r = rol;
            let mut t = String::from("  bir cumle  ");
            flush_line(&mut r, &mut t, Some(&tx));
            assert_eq!(
                tx.paylasilan
                    .0
                    .lock()
                    .unwrap()
                    .bekleyen
                    .pop_front()
                    .unwrap()
                    .1,
                Replik {
                    role: beklenen,
                    text: "bir cumle".into()
                },
                "rol {rol:?} yanlis eslenmis"
            );
            // Eski sozlesme korunuyor mu: tampon temizlenir, rol sifirlanir.
            assert!(t.is_empty(), "tampon temizlenmemis");
            assert_eq!(r, None, "rol sifirlanmamis");
        }
    }

    #[test]
    fn flush_line_bos_metni_atlar_dolu_kuyrukta_en_eskiyi_dusurur() {
        let tx = KayitYazici::default();
        for bos in ["", "   ", "\n\t "] {
            flush_line(&mut Some(false), &mut bos.to_string(), Some(&tx));
        }
        assert!(tx.paylasilan.0.lock().unwrap().bekleyen.is_empty());
        for i in 0..KAYIT_KUYRUK + 2 {
            flush_line(&mut Some(true), &mut format!("replik {i}"), Some(&tx));
        }
        let q = tx.paylasilan.0.lock().unwrap();
        assert_eq!(q.bekleyen.len(), KAYIT_KUYRUK);
        assert_eq!(q.bekleyen.front().unwrap().1.text, "replik 2");
        drop(q);
        let mut metin = "kanalsiz".to_string();
        flush_line(&mut Some(true), &mut metin, None);
        assert!(metin.is_empty());
    }
}
