//! Ortak sistem bildirimi kanali: uygulamanin her yerinden (arka plan isi bitti,
//! hatirlatma vakti geldi) acik Live oturumuna kisa metin enjekte eden TEK yol.
//!
//! Uretici (`sistem_bildirimi`) kuyruga yazar ve hemen doner; oturum yoksa metin
//! bekler ve yeni oturumda teslim edilir. Tuketici (`session_loop`) kuyruktan
//! yalniz oturum bostayken ya da tavan suresi dolunca ceker (`Zamanlayici`): model
//! ya da kullanici konusurken araya girmek konusmayi keser (olculdu, bkz.
//! `live-probe-scenarios.json` q_bildirim_konusurken).
//!
//! OYUN MODU (`DinlemeKipi::Isimle`, adla seslenilmedikce susulur): kapi modelin
//! cevabini dusurur. `sistem_bildirimi_oncelikli` (hatirlatma: kullanicinin bilerek
//! kurdugu uyari) bu modda da iletilir ve cevaba izin acar; `sistem_bildirimi`
//! (is bitti) mod kapanana dek kuyrukta BEKLER, sessizce kaybolmaz.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::conversation::tek_satir;
use super::microphone::YanitIzni;

/// Her bildirimin basina gelen etiket. Yonerge modele bu etiketle baslayan
/// girdinin Cihan'in sozu olmadigini soyler (`setup::SYSTEM`).
pub(super) const ONEK: &str = "[Sistem bildirimi]";

/// Son etkinlikten (model ya da kullanici) beri gecmesi gereken sessizlik.
const BOSLUK: Duration = Duration::from_millis(1500);
/// Bosluk hic gelmezse bildirim ilk gorulmesinden bu kadar sonra yine gider.
const TAVAN: Duration = Duration::from_secs(30);
/// Oturum hic acilmazsa kuyruk buyumesin: tavan asilinca en eski bildirim duser.
const KUYRUK_TAVANI: usize = 16;
/// Tek bildirimin karakter siniri (tek satir ve kisa: model tek cumleyle aktarir).
const MAX_KARAKTER: usize = 600;

/// Kuyruktaki bildirim: etiketli tam metin + oyun modunu delip delmedigi.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Bildirim {
    pub(super) metin: String,
    pub(super) oncelikli: bool,
}

/// Bekleyen bildirimler. Ayni metin bekliyorsa ikinci kez eklenmez; teslim edilen
/// bildirim kuyruktan CIKAR, yani her bildirim bir kez iletilir.
struct Kuyruk {
    bekleyen: VecDeque<Bildirim>,
}

impl Kuyruk {
    const fn new() -> Self {
        Self {
            bekleyen: VecDeque::new(),
        }
    }

    /// `false`: ayni metin zaten bekliyordu (oncelik yukselir, dusmez). Tavan
    /// asilirsa en eski duser.
    fn ekle(&mut self, yeni: Bildirim) -> bool {
        if let Some(var) = self.bekleyen.iter_mut().find(|b| b.metin == yeni.metin) {
            var.oncelikli |= yeni.oncelikli;
            return false;
        }
        if self.bekleyen.len() >= KUYRUK_TAVANI {
            self.bekleyen.pop_front();
            eprintln!("[bildirim] kuyruk dolu ({KUYRUK_TAVANI}): en eski bildirim dustu");
        }
        self.bekleyen.push_back(yeni);
        true
    }

    /// Siradaki gonderilebilir bildirim: oyun modunda yalniz oncelikliler.
    fn siradaki(&self, oyun_modu: bool) -> Option<usize> {
        self.bekleyen.iter().position(|b| b.oncelikli || !oyun_modu)
    }

    fn al(&mut self, oyun_modu: bool) -> Option<Bildirim> {
        let sira = self.siradaki(oyun_modu)?;
        self.bekleyen.remove(sira)
    }

    /// Iletilemeyen bildirim siradaki olarak geri doner (sirasini kaybetmez).
    fn geri_koy(&mut self, b: Bildirim) {
        if !self.bekleyen.iter().any(|var| var.metin == b.metin) {
            self.bekleyen.push_front(b);
        }
    }
}

static KUYRUK: Mutex<Kuyruk> = Mutex::new(Kuyruk::new());

fn kuyruk() -> std::sync::MutexGuard<'static, Kuyruk> {
    KUYRUK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Tek satir (`tek_satir`), `MAX_KARAKTER`de karakter sinirindan kirpilir (ASCII
/// `...` izi).
fn temizle(metin: &str) -> String {
    let tek = tek_satir(metin);
    if tek.chars().count() <= MAX_KARAKTER {
        return tek;
    }
    let kisa: String = tek.chars().take(MAX_KARAKTER - 3).collect();
    format!("{}...", kisa.trim_end())
}

fn kuyruga_al(metin: &str, oncelikli: bool) {
    let govde = temizle(metin);
    if govde.is_empty() {
        return;
    }
    let mut k = kuyruk();
    if k.ekle(Bildirim {
        metin: format!("{ONEK} {govde}"),
        oncelikli,
    }) {
        eprintln!(
            "[bildirim] siraya alindi ({} karakter, {} bekliyor{})",
            govde.chars().count(),
            k.bekleyen.len(),
            if oncelikli { ", oncelikli" } else { "" }
        );
    }
}

/// Acik (ya da bir sonraki) Live oturumuna sistem bildirimi gonderir: `metin`
/// bildirimin govdesidir, `[Sistem bildirimi]` etiketi buradan eklenir. Hemen
/// doner; teslim oturum bosta oldugunda yapilir. Bos metin yok sayilir. Oyun
/// modunda mod kapanana dek bekler.
pub(crate) fn sistem_bildirimi(metin: String) {
    kuyruga_al(&metin, false);
}

/// `sistem_bildirimi` gibi, ama oyun modunu (adla seslenilmedikce susan kip) da
/// delip modelin cevabina izin acar: kullanicinin bilerek kurdugu uyarilar icin.
pub(crate) fn sistem_bildirimi_oncelikli(metin: String) {
    kuyruga_al(&metin, true);
}

/// Bir oturumun bildirim zamanlayicisi: ne zaman gondermenin guvenli oldugunu
/// saat parametreli (`Instant` disaridan gelir) ve I/O'suz karar verir.
pub(super) struct Zamanlayici {
    son_etkinlik: Instant,
    model_acik: bool,
    ilk_gorulme: Option<Instant>,
}

impl Zamanlayici {
    /// Oturum kurulurken: ilk `BOSLUK` boyunca bildirim gitmez.
    pub(super) fn yeni(simdi: Instant) -> Self {
        Self {
            son_etkinlik: simdi,
            model_acik: false,
            ilk_gorulme: None,
        }
    }

    /// Modelden icerik (ses, transkript, arac cagrisi) geldi: tur acik.
    pub(super) fn model_etkinligi(&mut self, simdi: Instant) {
        self.model_acik = true;
        self.son_etkinlik = simdi;
    }

    /// `turnComplete` ya da `interrupted`: tur kapandi.
    pub(super) fn tur_bitti(&mut self, simdi: Instant) {
        self.model_acik = false;
        self.son_etkinlik = simdi;
    }

    /// Kullanicinin sesinden transkript geldi.
    pub(super) fn kullanici_etkinligi(&mut self, simdi: Instant) {
        self.son_etkinlik = simdi;
    }

    /// Bekleyen bildirim simdi gonderilmeli mi? Bostaysa ya da ilk gorulmesinden
    /// `TAVAN` gectiyse `true`; bekleyen yoksa tavan penceresi sifirlanir. Gonderim
    /// sonrasi `BOSLUK` yeniden baslar: pespese bildirimler modelin cevabini bekler.
    pub(super) fn gonder(
        &mut self,
        simdi: Instant,
        bekleyen: bool,
        kullanici_konusuyor: bool,
        devam_eden_arac: usize,
    ) -> bool {
        if !bekleyen {
            self.ilk_gorulme = None;
            return false;
        }
        let ilk = *self.ilk_gorulme.get_or_insert(simdi);
        let bosta = !kullanici_konusuyor
            && devam_eden_arac == 0
            && !self.model_acik
            && simdi.saturating_duration_since(self.son_etkinlik) >= BOSLUK;
        if !bosta && simdi.saturating_duration_since(ilk) < TAVAN {
            return false;
        }
        self.ilk_gorulme = None;
        self.son_etkinlik = simdi;
        true
    }
}

/// Oturum dongusunun cagrisi: zamanlayici izin verirse siradaki gonderilebilir
/// bildirimi alir. `oyun_modu` iken yalniz oncelikli bildirimler sayilir (digerleri
/// kuyrukta kalir, 30 sn tavani onlar icin islemez). Iletilemezse `geri_koy`.
pub(super) fn teslim_icin_al(
    z: &mut Zamanlayici,
    simdi: Instant,
    kullanici_konusuyor: bool,
    devam_eden_arac: usize,
    oyun_modu: bool,
) -> Option<Bildirim> {
    let mut k = kuyruk();
    let bekleyen = k.siradaki(oyun_modu).is_some();
    z.gonder(simdi, bekleyen, kullanici_konusuyor, devam_eden_arac)
        .then(|| k.al(oyun_modu))
        .flatten()
}

pub(super) fn geri_koy(b: Bildirim) {
    kuyruk().geri_koy(b);
}

/// Oncelikli bildirim oyun modunda gonderilirken modelin cevabina izin acar: kapi
/// (`YanitIzni`) yoksa bildirimi alan modelin sesi sessizce dusurulurdu. Oyun modu
/// disinda ya da oncelikli olmayan bildirimde bir sey yapmaz.
pub(super) fn cevaba_izin_ver(b: &Bildirim, oyun_modu: bool, epoch: u64, izni: &mut YanitIzni) {
    if b.oncelikli && oyun_modu {
        izni.gonderildi(epoch);
    }
}

/// Bildirimin tel cercevesi: Live `realtimeInput.text`.
pub(super) fn cerceve(metin: &str) -> String {
    serde_json::json!({ "realtimeInput": { "text": metin } }).to_string()
}

#[cfg(test)]
mod tests {
    use super::super::microphone::DinlemeKipi;
    use super::*;

    fn sn(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    /// Genel kuyruga dokunan testler birbirini ezmesin diye seri kosar.
    static GENEL_KUYRUK_TESTI: Mutex<()> = Mutex::new(());

    fn b(metin: &str, oncelikli: bool) -> Bildirim {
        Bildirim {
            metin: metin.into(),
            oncelikli,
        }
    }

    #[test]
    fn kuyruk_sirali_ayni_metin_bir_kez_ve_teslimde_cikar() {
        let mut k = Kuyruk::new();
        assert!(k.ekle(b("a", false)));
        assert!(k.ekle(b("b", false)));
        assert!(
            !k.ekle(b("a", false)),
            "bekleyen ayni metin ikinci kez girmez"
        );
        assert_eq!(k.al(false).map(|x| x.metin).as_deref(), Some("a"));
        assert_eq!(k.al(false).map(|x| x.metin).as_deref(), Some("b"));
        assert_eq!(k.al(false), None);
        // Teslim edilen yeniden olusan bir olay olarak tekrar girebilir.
        assert!(k.ekle(b("a", false)));
    }

    #[test]
    fn kuyruk_tavani_en_eskiyi_dusurur_geri_konan_basa_gelir() {
        let mut k = Kuyruk::new();
        for i in 0..KUYRUK_TAVANI + 3 {
            k.ekle(b(&format!("m{i}"), false));
        }
        assert_eq!(k.bekleyen.len(), KUYRUK_TAVANI);
        let alinan = k.al(false).unwrap();
        assert_eq!(alinan.metin, "m3");
        k.geri_koy(alinan.clone());
        k.geri_koy(alinan);
        assert_eq!(k.bekleyen.front().map(|x| x.metin.as_str()), Some("m3"));
        assert_eq!(k.bekleyen.iter().filter(|x| x.metin == "m3").count(), 1);
    }

    /// OYUN MODU: yalniz oncelikli (hatirlatma) gider; oncelikli olmayan (is bitti)
    /// kuyrukta KALIR ve mod kapaninca, sirasi bozulmadan gider.
    #[test]
    fn oyun_modunda_yalniz_oncelikli_gider_digeri_mod_kapaninca_gider() {
        let mut k = Kuyruk::new();
        k.ekle(b("is bitti", false));
        k.ekle(b("hatirlatma", true));
        k.ekle(b("ikinci is", false));
        assert_eq!(k.siradaki(true), Some(1));
        assert_eq!(k.al(true).map(|x| x.metin).as_deref(), Some("hatirlatma"));
        assert_eq!(k.siradaki(true), None, "oyun modunda gonderilecek kalmadi");
        assert_eq!(k.al(true), None);
        assert_eq!(k.bekleyen.len(), 2, "oncelikli olmayanlar dusmedi");
        assert_eq!(k.al(false).map(|x| x.metin).as_deref(), Some("is bitti"));
        assert_eq!(k.al(false).map(|x| x.metin).as_deref(), Some("ikinci is"));
        // Oyun disinda oncelik sirayi degistirmez: ilk gelen ilk gider.
        k.ekle(b("normal", false));
        k.ekle(b("acil", true));
        assert_eq!(k.al(false).map(|x| x.metin).as_deref(), Some("normal"));
    }

    #[test]
    fn ayni_metin_tekrar_gelirse_oncelik_yukselir_dusmez() {
        let mut k = Kuyruk::new();
        assert!(k.ekle(b("x", false)));
        assert!(!k.ekle(b("x", true)));
        assert!(k.bekleyen[0].oncelikli);
        assert!(!k.ekle(b("x", false)));
        assert!(k.bekleyen[0].oncelikli, "oncelik geri dusmez");
    }

    #[test]
    fn metin_tek_satir_kisa_ve_bos_olmaz() {
        assert_eq!(
            temizle("  iki\n\nsatir\t ve  bosluk "),
            "iki satir ve bosluk"
        );
        assert_eq!(temizle("kontrol\u{7}\u{0}karakter"), "kontrol karakter");
        assert_eq!(temizle("\n \t"), "");
        let uzun = "ç".repeat(MAX_KARAKTER + 50);
        let kirpik = temizle(&uzun);
        assert_eq!(kirpik.chars().count(), MAX_KARAKTER);
        assert!(kirpik.ends_with("..."));
        assert_eq!(
            temizle(&"x".repeat(MAX_KARAKTER)).chars().count(),
            MAX_KARAKTER
        );
    }

    /// Genel kuyrugu yalniz bu test kullanir (paralel testlerle yaris olmasin);
    /// eklenen metinler diger testlerin kuyrugunu etkilemez.
    #[test]
    fn sistem_bildirimi_etiketi_ekler_ve_bos_metni_yok_sayar() {
        let _seri = GENEL_KUYRUK_TESTI.lock().unwrap_or_else(|e| e.into_inner());
        let benzersiz = format!("deneme-{}", std::process::id());
        sistem_bildirimi(String::new());
        sistem_bildirimi("  \n ".into());
        sistem_bildirimi(format!("  {benzersiz}\n  ikinci satir "));
        sistem_bildirimi_oncelikli(format!("{benzersiz} acil"));
        let mut bizim = Vec::new();
        let mut baskalari = Vec::new();
        while let Some(m) = kuyruk().al(false) {
            if m.metin.contains(&benzersiz) {
                bizim.push(m);
            } else {
                baskalari.push(m);
            }
        }
        for m in baskalari {
            geri_koy(m);
        }
        assert_eq!(
            bizim,
            vec![
                b(&format!("{ONEK} {benzersiz} ikinci satir"), false),
                b(&format!("{ONEK} {benzersiz} acil"), true),
            ],
            "etiket tek kez, govde tek satir, oncelik uretici fonksiyondan"
        );
    }

    #[test]
    fn bostayken_gonderir_konusurken_bekler() {
        let t0 = Instant::now();
        let mut z = Zamanlayici::yeni(t0);
        // Oturum yeni kuruldu: ilk BOSLUK boyunca bekler.
        assert!(!z.gonder(t0 + Duration::from_millis(100), true, false, 0));
        assert!(!z.gonder(t0 + Duration::from_millis(1499), true, false, 0));
        assert!(z.gonder(t0 + BOSLUK, true, false, 0), "bosta: gonderilmeli");
    }

    #[test]
    fn model_ya_da_kullanici_ya_da_arac_mesgulken_bekler() {
        let t0 = Instant::now();
        let mut z = Zamanlayici::yeni(t0);
        z.model_etkinligi(t0 + sn(5));
        assert!(!z.gonder(t0 + sn(10), true, false, 0), "model turu acik");
        z.tur_bitti(t0 + sn(10));
        assert!(!z.gonder(t0 + sn(10), true, false, 0), "tur yeni bitti");
        assert!(!z.gonder(t0 + sn(12), true, true, 0), "kullanici konusuyor");
        assert!(!z.gonder(t0 + sn(12), true, false, 1), "arac suruyor");
        z.kullanici_etkinligi(t0 + sn(13));
        assert!(
            !z.gonder(t0 + sn(14), true, false, 0),
            "kullanici yeni konustu"
        );
        assert!(z.gonder(t0 + sn(15), true, false, 0));
    }

    #[test]
    fn otuz_saniyede_bosluk_olmazsa_yine_gonderir() {
        let t0 = Instant::now();
        let mut z = Zamanlayici::yeni(t0);
        z.model_etkinligi(t0 + sn(1));
        // Model turu hic kapanmiyor (ya da kullanici susmuyor).
        assert!(!z.gonder(t0 + sn(2), true, true, 2), "pencere acildi");
        assert!(!z.gonder(t0 + sn(31), true, true, 2), "tavana 1 sn var");
        assert!(
            z.gonder(t0 + sn(32), true, true, 2),
            "tavan: mesgul olsa da gider"
        );
    }

    #[test]
    fn gonderimden_sonra_bosluk_yeniden_baslar_tavan_penceresi_sifirlanir() {
        let t0 = Instant::now();
        let mut z = Zamanlayici::yeni(t0);
        assert!(z.gonder(t0 + sn(5), true, false, 0));
        // Hemen ardindan gelen ikinci bildirim, modelin cevabini bekler.
        assert!(!z.gonder(t0 + sn(5), true, false, 0));
        assert!(!z.gonder(t0 + sn(6), true, false, 0));
        assert!(z.gonder(t0 + sn(5) + BOSLUK, true, false, 0));
        // Bekleyen kalmayinca pencere kapanir: sonradan gelen kendi 30 sn'sini alir.
        let mut z = Zamanlayici::yeni(t0);
        z.model_etkinligi(t0);
        assert!(!z.gonder(t0 + sn(1), true, false, 0));
        assert!(!z.gonder(t0 + sn(20), false, false, 0), "bekleyen yok");
        assert!(
            !z.gonder(t0 + sn(40), true, false, 0),
            "pencere yeniden basladi"
        );
        assert!(z.gonder(t0 + sn(70), true, false, 0));
    }

    /// Genel kuyrukla: zamanlayici izin vermeden hicbir sey alinmaz; oyun modunda
    /// oncelikli olmayan bildirim icin 30 sn tavani da isletilmez (bekleyen yok
    /// sayilir), mod kapaninca ayni bildirim gider.
    #[test]
    fn teslim_icin_al_izin_ve_oyun_modu() {
        let _seri = GENEL_KUYRUK_TESTI.lock().unwrap_or_else(|e| e.into_inner());
        let benzersiz = format!("teslim-{}", std::process::id());
        sistem_bildirimi(format!("{benzersiz} normal"));
        let bizimki = |m: &Bildirim| m.metin.contains(&benzersiz);
        let t0 = Instant::now();
        let mut z = Zamanlayici::yeni(t0);
        z.model_etkinligi(t0);
        assert_eq!(
            teslim_icin_al(&mut z, t0 + Duration::from_millis(10), false, 0, false),
            None,
            "model konusuyor: kuyruga dokunulmaz"
        );
        // 60 sn gecti (tavan asildi) ama oyun modunda normal bildirim gonderilmez.
        let mut z = Zamanlayici::yeni(t0);
        let oyunda = teslim_icin_al(&mut z, t0 + sn(60), false, 0, true);
        assert!(
            oyunda.as_ref().is_none_or(|m| !bizimki(m)),
            "oyun modunda is bitti bildirimi gitti: {oyunda:?}"
        );
        if let Some(m) = oyunda {
            geri_koy(m); // baska testin oncelikli bildirimi olabilir
        }
        // Mod kapandi: bildirim (baska testlerinkinden once ya da sonra) bizim.
        let mut alinan = Vec::new();
        let mut z = Zamanlayici::yeni(t0);
        for i in 0..KUYRUK_TAVANI + 1 {
            match teslim_icin_al(&mut z, t0 + sn(100 + 2 * i as u64), false, 0, false) {
                Some(m) if bizimki(&m) => {
                    alinan.push(m);
                    break;
                }
                Some(m) => alinan.push(m),
                None => break,
            }
        }
        let bizim = alinan
            .iter()
            .find(|m| bizimki(m))
            .expect("bildirim gitmedi");
        assert!(!bizim.oncelikli);
        for m in alinan.into_iter().filter(|m| !bizimki(m)) {
            geri_koy(m);
        }
    }

    /// Hatirlatma oyun modunda cevaba izin acar; is bitti bildirimi acmaz (zaten
    /// gonderilmez); oyun disinda kapiya dokunulmaz.
    #[test]
    fn oncelikli_bildirim_oyun_modunda_cevaba_izin_acar() {
        let epoch = 6; // Isimle surum numarasi (surum & 3 == 2)
        let acil = b("hatirlatma", true);
        let normal = b("is bitti", false);

        let mut izni = YanitIzni::default();
        assert!(
            !izni.serbest(DinlemeKipi::Isimle, epoch),
            "baslangic: kapali"
        );
        cevaba_izin_ver(&normal, true, epoch, &mut izni);
        assert!(!izni.serbest(DinlemeKipi::Isimle, epoch));
        cevaba_izin_ver(&acil, false, epoch, &mut izni);
        assert!(!izni.serbest(DinlemeKipi::Isimle, epoch), "oyun modu degil");
        cevaba_izin_ver(&acil, true, epoch, &mut izni);
        assert!(
            izni.serbest(DinlemeKipi::Isimle, epoch),
            "acil: cevap serbest"
        );
        // Cevap basladi ve bitti: izin tuketilir, sonraki sessiz tur yine kapali.
        izni.basla();
        assert!(izni.serbest(DinlemeKipi::Isimle, epoch));
        izni.bitir();
        assert!(!izni.serbest(DinlemeKipi::Isimle, epoch));
        // Mod degisti (yeni surum): eski izin yeni surumde gecmez.
        cevaba_izin_ver(&acil, true, epoch, &mut izni);
        assert!(!izni.serbest(DinlemeKipi::Isimle, epoch + 4));
    }

    /// Uretici -> oncelik eslesmesi KAYNAKTA sabitlenir: hatirlatma oncelikli
    /// fonksiyonu, arka plan isi bitisi normal olani cagirir. Biri digerinin
    /// fonksiyonuna kayarsa (is bitti oyun modunu deler ya da hatirlatma susar) burada kirilir.
    #[test]
    fn uretici_oncelikleri_kaynakta_sabit() {
        let uretim = |kaynak: &'static str| kaynak.split("#[cfg(test)]").next().unwrap();
        let isler = uretim(include_str!("../../system_tools.rs"));
        assert!(isler.contains("crate::audio::sistem_bildirimi,"));
        assert!(!isler.contains("sistem_bildirimi_oncelikli"));
        let hatirlatma = uretim(include_str!("../../reminders.rs"));
        assert!(hatirlatma.contains("crate::audio::sistem_bildirimi_oncelikli("));
        assert!(!hatirlatma.contains("crate::audio::sistem_bildirimi("));
    }

    #[test]
    fn cerceve_realtime_input_text_tasir() {
        let v: serde_json::Value =
            serde_json::from_str(&cerceve("[Sistem bildirimi] Hatirlatma: su ic")).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "realtimeInput": { "text": "[Sistem bildirimi] Hatirlatma: su ic" } })
        );
    }
}
