//! Baglanti omru, devralma ve yeniden deneme politikasi.

use super::conversation::{konusma_yazici, KAPANIYOR};
use super::microphone::{
    dinleme_surumu, mik_akisi_env, MikAkisi, MikKaresi, MikTamponu, SunucuVad,
};
use super::session::session_loop;
use super::setup::{live_model, setup_frame_model, sikistirma_env, Sikistirma};
use super::tools::TOOL_HATA;
use super::LiveEvent;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

/// Baglanti sagligi sozde-"araci" (`ad`): gercek bir arac DEGIL, Live
/// baglantisinin hatasini UI'a tasiyan kanal. Bkz. `TOOL_HATA`.
pub(super) const LIVE_BAGLANTI: &str = "live_baglanti";

pub(super) fn ws_url(key: &str) -> String {
    format!(
        "wss://generativelanguage.googleapis.com/ws/\
         google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={key}"
    )
}

/// Setup'a konacak devralma niyeti.
///
/// Env okumasi cagirana aittir (`devralma_acik`): boylece `setup_frame` SAF
/// kalir ve testler ortam degiskeni yarisina girmeden uc durumu de dogrular.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Devralma<'a> {
    /// `SMITH_LIVE_RESUME=0` : alan setup'a HIC girmez, sunucu handle yollamaz.
    Kapali,
    /// Devralma acik ama elde handle yok: bos config sunucudan handle ISTER.
    Yeni,
    /// Elde bir handle var: ayni konusma devralinir.
    Handle(&'a str),
}

/// Oturum devamliligi acik mi (`SMITH_LIVE_RESUME`).
///
/// Varsayilan ACIK: baglam kaybi bir kusur, korunmasi normal davranistir.
/// `SMITH_LIVE`'in sozlesmesiyle ayni: yalniz `"0"` kapatir.
pub(super) fn devralma_acik() -> bool {
    !std::env::var("SMITH_LIVE_RESUME").is_ok_and(|v| v.trim() == "0")
}

/// (bayrak, eldeki handle) -> setup'a konacak niyet.
pub(super) fn devralma_niyeti(acik: bool, handle: Option<&str>) -> Devralma<'_> {
    if !acik {
        return Devralma::Kapali;
    }
    match handle {
        Some(h) if !h.is_empty() => Devralma::Handle(h),
        _ => Devralma::Yeni,
    }
}

/// Sunucunun devralma noktasini ayristirir: `sessionResumptionUpdate`.
///
/// Sozlesme (ai.google.dev/api/live): `newHandle` = "New handle that represents
/// a state that can be resumed. **Empty if resumable=false**", `resumable` =
/// "True if the current session can be resumed at this point." Iki kosul
/// birlikte istenir; bos handle ile baglanmak temiz oturumdan farksizdir ama
/// bizi "devralma denendi" saymaya iterdi (yani ilk hatada saglam handle'i
/// dusururduk).
pub(super) fn yeni_handle(v: &serde_json::Value) -> Option<String> {
    let u = &v["sessionResumptionUpdate"];
    if u["resumable"].as_bool() != Some(true) {
        return None;
    }
    let h = u["newHandle"].as_str()?;
    if h.is_empty() {
        return None;
    }
    Some(h.to_string())
}

/// `goAway.timeLeft`: sunucu kapatacagini ONCEDEN haber verir. Duration proto3
/// JSON'da metindir ("60s"); alan gelmezse haberin KENDISI yine bilgidir, o
/// yuzden `None` degil "bilinmiyor" doner.
pub(super) fn go_away_kalan(v: &serde_json::Value) -> Option<String> {
    let g = &v["goAway"];
    if g.is_null() {
        return None;
    }
    Some(g["timeLeft"].as_str().unwrap_or("bilinmiyor").to_string())
}

/// Tek bir oturum denemesinden geriye kalan saglik izi. Handle politikasi
/// bundan turer : tahminden degil, oturumun gozlenen davranisindan.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(super) struct OturumIzi {
    pub(super) bekci_yenilemesi: bool,
    /// Setup bir handle ile gonderildi mi (yani devralma DENENDI mi).
    pub(super) devralma_denendi: bool,
    /// `setupComplete` alindi mi.
    pub(super) setup_tamam: bool,
    /// Handle ile setup beklemesi doldu mu.
    pub(super) setup_suresi_doldu: bool,
    /// Sunucu bu oturumda devralma noktasi verdi mi.
    pub(super) handle_geldi: bool,
    /// Sunucu kapanacagini haber verdi mi (planli kapanma).
    pub(super) go_away: bool,
    /// Modelden gercek icerik (ses veya cikis transkripti) geldi mi.
    pub(super) icerik_geldi: bool,
    /// `setupComplete`ten oturumun bitisine kadar gecen tam saniye. Oturum
    /// SONUNDA yazilir (`session_loop`); `setup_tamam` degilse 0 kalir.
    pub(super) yasam_sn: u64,
    /// Oturum bir HATA sinifinda (kota/yuk, kalici, ag) kapandi. `Planli`
    /// kapanis (goAway, normal 1000) hata sayilmaz. Oturum SONUNDA yazilir.
    pub(super) hata_kapanisi: bool,
}

/// `setupComplete`ten sonra bu kadar saniye yasayan ve hata sinifinda
/// kapanmayan oturum SAGLIKLI sayilir: sessiz (kullanici konusmadi) ama
/// calisan bir oturum, handle'ini dusurmeyi hak etmez; ayni esik geri cekilme
/// sayacini da sifirlar.
const SAGLIKLI_YASAM_SN: u64 = 60;

impl OturumIzi {
    /// Oturum kendini kanitladi mi: setup gecti VE oturumun gercekten CALISTIGI
    /// gorunur oldu : model konustu, sunucu planli kapanmayi haber verdi YA DA
    /// oturum hata sinifinda kapanmadan `SAGLIKLI_YASAM_SN` yasadi.
    ///
    /// Son kosul eskiden yoktu: icerik ya da goAway sart kosuldugu icin SESSIZ
    /// ama saglikli bir oturum (kullanici o sure konusmadi) kapaninca handle
    /// dusuyor ve konusma baglami bosa gidiyordu. Bozuk-handle emniyeti
    /// KORUNUR: bozuk handle'in imzasi "kisa omur + hata"dir (oturum ilk
    /// ifadede olur); ne kisa omur ne hata kapanisi bu kosulu saglar.
    ///
    /// `handle_geldi` BILINCLI OLARAK saglik izi SAYILMAZ. Gozlenen ariza
    /// (discuss.ai.google.dev/t/.../175234, ayni model): bozulmus bir handle ile
    /// setup KABUL EDILIYOR, sunucu devralma noktalari yollamaya devam ediyor,
    /// ama oturum ilk ifadede hicbir yanit uretmeden oluyor. Handle'in varligini
    /// saglik saymak tam da bu durumda bizi ayni bozuk soy zincirine kilitler.
    pub(super) fn saglikli(&self) -> bool {
        self.setup_tamam
            && (self.icerik_geldi
                || self.go_away
                || (self.yasam_sn >= SAGLIKLI_YASAM_SN && !self.hata_kapanisi))
    }

    /// Yeniden baglanma sayaci sifirlansin mi? YALNIZ oturum `setupComplete`ten
    /// sonra `SAGLIKLI_YASAM_SN` yasadiysa ya da sunucu goAway ile PLANLI
    /// kapandiysa. Kapanisin sinifi burada onemsiz: dakikalarca calismis bir
    /// oturumun sonundaki ag kopmasi yeni bir ariza serisinin ilk halkasidir.
    ///
    /// Eskiden her `Ok(())` sayaci sifirliyordu: kota hatasinda sunucu
    /// baglantiyi hemen kapatinca "basarili oturum" sanilip bekleme hep 1 sn
    /// kaliyor, saniyede bir yeniden baglanma firtinasi cikiyordu. Icerik
    /// gelmesi TEK BASINA yetmez: ilk cumlede kapanan ve tekrar tekrar acilan
    /// bir oturum da icerik uretir.
    pub(super) fn sayac_sifirlanir(&self) -> bool {
        self.setup_tamam && (self.go_away || self.yasam_sn >= SAGLIKLI_YASAM_SN)
    }

    /// Denemeden sonra handle korunmali mi?
    ///
    /// BU FONKSIYON BIR EMNIYET KAPISIDIR. Devralma denendigi halde oturum
    /// hicbir saglik izi birakmadan bittiyse handle DUSER: suresi dolmus ya da
    /// bozulmus bir handle her yeni oturumu ayni sekilde oldurur ve Smith
    /// KALICI olarak baglanamaz hale gelir (gozlenen ariza: handle ile setup
    /// kabul ediliyor, oturum ilk ifadede oluyor, ayni handle ile tekrar
    /// deneyen istemci sonsuz kirmizi donguye giriyor). Temiz oturumda
    /// (`devralma_denendi=false`) dusurulecek bir sey yoktur; orada `false`
    /// donmek her hatada handle'i bosa silmek olurdu.
    pub(super) fn handle_korunmali(&self) -> bool {
        !self.devralma_denendi
            || self.setup_suresi_doldu
            || self.bekci_yenilemesi
            || self.saglikli()
    }
}

/// Yeni handle'i saklar.
///
/// Deger LOGLANMAZ: handle bir kimlik bilgisidir, onunla oturum devralinabilir.
/// Yalniz oturumun ILK noktasi log satiri uretir : sunucu bunu periyodik
/// yolluyor, her seferinde basmak konusma logunu bogar.
pub(super) fn kaydet_handle(
    store: &std::sync::Mutex<Option<String>>,
    h: String,
    iz: &mut OturumIzi,
) {
    if !iz.handle_geldi {
        eprintln!("[live] devralma noktasi alindi (oturum surdurulebilir)");
    }
    iz.handle_geldi = true;
    if let Ok(mut g) = store.lock() {
        *g = Some(h);
    }
}

// ---------------------------------------------------------------------------
// KAPANIS SINIFLANDIRMASI VE GERI CEKILME POLITIKASI
//
// Eskiden sunucunun kapanis kodu ve sebebi `Ok(Message::Close(_)) | Err(_) =>
// break` ile atiliyordu: ne kota, ne yanlis anahtar, ne ag kopmasi ayirt
// edilebiliyordu ve her kapanis ayni 1 sn beklemeyle yeniden baglaniyordu.
// Kotada bu, saniyede bir yeniden baglanma firtinasiydi (kotayi daha da yakar,
// loglari bogar). Asagidakiler SAF fonksiyonlardir: ag ve saat olmadan sinanir.
// ---------------------------------------------------------------------------

/// `connect_async` icin ust sinir. Takili bir TCP/TLS el sikismasi sonsuza dek
/// "baglaniyor" gosterirdi.
pub(super) const BAGLANTI_ZAMAN_ASIMI: std::time::Duration = std::time::Duration::from_secs(15);
/// `setupComplete` beklemesi icin ust sinir (setup gonderildikten sonra).
///
/// Bosta kullanicinin sessizligi zaman asimi degildir. Acik model turu
/// icin ayri 30 sn bekci `session_loop` icinde calisir.
pub(super) const SETUP_ZAMAN_ASIMI: std::time::Duration = std::time::Duration::from_secs(10);

pub(super) fn setup_zaman_asimi(_devralma: Devralma<'_>) -> std::time::Duration {
    SETUP_ZAMAN_ASIMI
}

/// Bir oturumun NASIL bittigi. Geri cekilmeyi ve UI mesajini bu belirler.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum KapanisSinifi {
    /// Beklenen kapanis: goAway'den sonra ya da normal 1000/1001. Sessiz.
    Planli,
    /// Kota / yuk: 1011, 1013, sebepte quota / RESOURCE_EXHAUSTED / rate.
    /// Hemen yeniden baglanmak sorunu buyutur: uzun geri cekilme.
    KotaYuk,
    /// Smith'in arac yaniti yuku reddedildi (1007). Kisa kademeli yeniden deneme.
    AracYaniti,
    /// Yeniden denemekle duzelmez (diger 1007, 1008, API anahtari, izin, gecersiz
    /// istek). Uzun bekleme + UI'a acik hata; kullanicinin mudahalesi gerekir.
    Kalici,
    /// Ag: okuma hatasi, zaman asimi, akisin sebepsiz bitmesi. Kisa kademeli
    /// geri cekilme.
    Ag,
}

impl KapanisSinifi {
    pub(super) fn ad(self) -> &'static str {
        match self {
            Self::Planli => "planli",
            Self::KotaYuk => "kota/yuk",
            Self::Kalici => "kalici",
            Self::AracYaniti => "arac yaniti",
            Self::Ag => "ag",
        }
    }
}

/// Kapanisin tam kaydi: sinif + sunucunun verdigi ham kod ve sebep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Kapanis {
    pub(super) sinif: KapanisSinifi,
    pub(super) kod: Option<u16>,
    pub(super) sebep: String,
}

impl Kapanis {
    /// Sunucudan gelen kapanis (Close frame ya da setup asamasindaki hata
    /// govdesi): kod ve sebepten siniflandirilir.
    pub(super) fn sunucudan(kod: Option<u16>, sebep: &str, go_away: bool) -> Self {
        Self {
            sinif: kapanis_siniflandir(kod, sebep, go_away),
            kod,
            sebep: kirp_sebep(sebep),
        }
    }

    /// Ag sinifi: kod yok, sebep yerel bir aciklama.
    pub(super) fn ag(sebep: impl Into<String>) -> Self {
        Self {
            sinif: KapanisSinifi::Ag,
            kod: None,
            sebep: sebep.into(),
        }
    }

    /// Kullanici `stop` istedi: hata degil, planli.
    pub(super) fn durduruldu() -> Self {
        Self {
            sinif: KapanisSinifi::Planli,
            kod: None,
            sebep: "durduruldu".into(),
        }
    }
}

/// Sunucu sebep metnini log ve UI icin kisaltir (tek satir, en fazla 200 kar.).
fn kirp_sebep(s: &str) -> String {
    let tek: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if tek.chars().count() <= 200 {
        return tek;
    }
    let kirpik: String = tek.chars().take(200).collect();
    format!("{kirpik}...")
}

/// Sebep metnini kucuk harfli alfanumerik JETONLARA boler. Siniflandirma bu
/// jetonlara bakar, alt dizeye DEGIL: `generate`/`iterate` icinde `rate`,
/// `invalidate` icinde `invalid` yakalanmasin. `RESOURCE_EXHAUSTED` ve
/// `API_KEY_INVALID` gibi alt cizgili kodlar jetonlara ayrilir.
fn sebep_jetonlari(sebep: &str) -> Vec<String> {
    sebep
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// Kota/yuk belirten jetonlar (`rate limit`, `RESOURCE_EXHAUSTED`, `quota`).
const KOTA_JETONLARI: &[&str] = &["quota", "exhausted", "rate", "ratelimit", "ratelimited"];
/// Kalici hata belirten jetonlar. (`api key` ikilisi ayrica aranir.)
const KALICI_JETONLARI: &[&str] = &[
    "permission",
    "invalid",
    "unauthenticated",
    "unauthorized",
    "forbidden",
];

/// Kapanisi siniflandirir. ONCELIK sirasi onemli:
/// 1. goAway alindiysa kapanis PLANLIDIR (kod ne olursa olsun).
/// 2. Sebepte kota/yuk belirteci: koddan once (Google kotayi 1008 ya da 1011
///    ile verebilir; `quota` yazan 1008 kalici DEGIL).
/// 3. API key / izin hatasi kalici; 1007 + istemci yuku belirteci arac yaniti.
/// 4. Diger kalici belirtecler (invalid dahil).
/// 5. Kod: 1000/1001 planli; 1011/1013 kota-yuk; diger 1007/1008 kalici.
/// 6. Gerisi (1006, kodsuz, taninmayan) ag.
fn kapanis_siniflandir(kod: Option<u16>, sebep: &str, go_away: bool) -> KapanisSinifi {
    if go_away {
        return KapanisSinifi::Planli;
    }
    let jetonlar = sebep_jetonlari(sebep);
    let var = |liste: &[&str]| jetonlar.iter().any(|j| liste.contains(&j.as_str()));
    if var(KOTA_JETONLARI) {
        return KapanisSinifi::KotaYuk;
    }
    let api_key = jetonlar.windows(2).any(|w| w[0] == "api" && w[1] == "key");
    let yetki_hatasi =
        api_key || var(&["permission", "unauthenticated", "unauthorized", "forbidden"]);
    let sebep_kucuk = sebep.to_lowercase();
    if kod == Some(1007)
        && !yetki_hatasi
        && ["invalid json payload", "unknown name", "proto field"]
            .iter()
            .any(|belirtec| sebep_kucuk.contains(belirtec))
    {
        return KapanisSinifi::AracYaniti;
    }
    if api_key || var(KALICI_JETONLARI) {
        return KapanisSinifi::Kalici;
    }
    match kod {
        Some(1000) | Some(1001) => KapanisSinifi::Planli,
        Some(1011) | Some(1013) => KapanisSinifi::KotaYuk,
        Some(1007) | Some(1008) => KapanisSinifi::Kalici,
        _ => KapanisSinifi::Ag,
    }
}

/// WebSocket el sikismasi (HTTP) durumundan sinif: anahtar/izin/istek hatasi
/// kalicidir, 429/503 kota-yuk, gerisi ag.
fn http_durum_sinifi(durum: u16) -> KapanisSinifi {
    match durum {
        400 | 401 | 403 | 404 => KapanisSinifi::Kalici,
        429 | 503 => KapanisSinifi::KotaYuk,
        _ => KapanisSinifi::Ag,
    }
}

/// Mesajdan API anahtarini siler: `ws_url` anahtari sorgu parametresi olarak
/// tasir ve bir hata metni onu icerebilir; metin artik UI'a da gidiyor.
fn anahtari_maskele(mesaj: &str, key: &str) -> String {
    if key.is_empty() {
        mesaj.to_string()
    } else {
        mesaj.replace(key, "***")
    }
}

impl Kapanis {
    /// `connect_async` hatasi. HTTP el sikismasi reddedildiyse durumdan
    /// siniflandirilir (yanlis anahtar tipik olarak 400/403 doner); gerisi ag.
    pub(super) fn baglanti_hatasi(e: &tokio_tungstenite::tungstenite::Error, key: &str) -> Self {
        use tokio_tungstenite::tungstenite::Error as WsHata;
        let (sinif, kod) = match e {
            WsHata::Http(resp) => {
                let d = resp.status().as_u16();
                (http_durum_sinifi(d), Some(d))
            }
            _ => (KapanisSinifi::Ag, None),
        };
        Self {
            sinif,
            kod,
            sebep: kirp_sebep(&anahtari_maskele(&format!("baglanti kurulamadi: {e}"), key)),
        }
    }
}

/// Close frame'den (kod, sebep). Frame yoksa ikisi de bos.
pub(super) fn kapanma_bilgisi(
    frame: Option<&tokio_tungstenite::tungstenite::protocol::CloseFrame<'_>>,
) -> (Option<u16>, String) {
    match frame {
        Some(f) => (Some(u16::from(f.code)), f.reason.to_string()),
        None => (None, String::new()),
    }
}

/// `[live] sunucu kapatti kod=.. sebep=..` satiri. Frame'siz kapanista
/// `kod=yok`.
pub(super) fn kapanis_logu(kod: Option<u16>, sebep: &str) -> String {
    let kod = kod.map_or_else(|| "yok".to_string(), |k| k.to_string());
    format!(
        "[live] sunucu kapatti kod={kod} sebep={}",
        kirp_sebep(sebep)
    )
}

/// Ag kademeleri (sn): kisa, ama saniyede bir firtina yok.
const AG_BEKLEME_SN: [u64; 6] = [1, 2, 5, 10, 20, 30];
/// Kota/yuk: 30 sn'den baslar, her ardisik hatada iki katina cikar, 5 dk tavan.
const KOTA_ILK_BEKLEME_SN: u64 = 30;
const KOTA_TAVAN_BEKLEME_SN: u64 = 300;
/// Kalici hatada sabit 5 dk: duzelmeyecek bir istegi dakikada 60 kez degil, 12
/// kez deneriz; kullanici duzeltince (anahtar, izin) en gec 5 dk sonra toparlanir.
const KALICI_BEKLEME_SN: u64 = 300;

/// Siradaki yeniden baglanma oncesi bekleme (sn). `deneme`: sayac sifirlanmadan
/// bu yana yapilmis ardisik kapanis sayisi (ilk bekleme icin 0).
fn bekleme_sn(sinif: KapanisSinifi, deneme: usize) -> u64 {
    match sinif {
        KapanisSinifi::Planli | KapanisSinifi::Ag => {
            AG_BEKLEME_SN[deneme.min(AG_BEKLEME_SN.len() - 1)]
        }
        KapanisSinifi::KotaYuk => {
            // `<<` tasmasin diye kaydirma 4'te kesilir: 30 << 4 = 480 > tavan.
            (KOTA_ILK_BEKLEME_SN << deneme.min(4)).min(KOTA_TAVAN_BEKLEME_SN)
        }
        KapanisSinifi::Kalici => KALICI_BEKLEME_SN,
        KapanisSinifi::AracYaniti => {
            AG_BEKLEME_SN[deneme.saturating_add(1).min(AG_BEKLEME_SN.len() - 1)]
        }
    }
}

/// Bir kapanisin ardindan: (bu sefer beklenecek sn, sonraki sayac degeri).
/// Sayac yalniz `OturumIzi::sayac_sifirlanir` izin verirse sifirlanir.
fn geri_cekilme_adimi(iz: &OturumIzi, sinif: KapanisSinifi, sayac: usize) -> (u64, usize) {
    let sayac = if iz.sayac_sifirlanir() { 0 } else { sayac };
    (bekleme_sn(sinif, sayac), sayac + 1)
}

/// Kapanisin bekleme/teshis icin ETKIN sinifi. `kapanis_siniflandir` 1011
/// ("internal error") ve 1013'u (yuk) KOD'dan kota/yuk sayar (taze baglantida
/// bu dogru varsayim), ama `SAGLIKLI_YASAM_SN` yasamis bir oturumun kota
/// belirteci tasimayan 1011 kapanisi kota teshisi hak etmez: Smith 30 sn
/// susar ve UI'a yanlis teshis gider. Saha raporu: "58. dakikada 1011 deadline
/// expired" (sebep BOS DEGIL ama kota degil). O durumda Ag kademesi uygulanir.
///
/// KOTA JETONU TASIYAN sebep (`quota`, `RESOURCE_EXHAUSTED`, `rate limit`) ya
/// da kodla degil sebeple KotaYuk olmus bir kapanis degismez; HTTP reddi ve
/// setup oncesi kapanislar da (`setup_tamam` degil) degismez.
/// 1013 her zaman sunucunun acik yuk sinyalidir; uzun omur bunu degistirmez.
fn etkin_sinif(k: &Kapanis, iz: &OturumIzi) -> KapanisSinifi {
    let yalniz_kodla_kota = k.sinif == KapanisSinifi::KotaYuk
        && k.kod == Some(1011)
        && !sebep_jetonlari(&k.sebep)
            .iter()
            .any(|j| KOTA_JETONLARI.contains(&j.as_str()));
    if yalniz_kodla_kota && iz.setup_tamam && iz.yasam_sn >= SAGLIKLI_YASAM_SN {
        KapanisSinifi::Ag
    } else {
        k.sinif
    }
}

/// Bu denemede devralma DENENDI ama tutmadi (handle `handle_korunmali`
/// politikasiyla dusuyor). Sonraki deneme temiz baslar.
fn handle_dustu(iz: &OturumIzi) -> bool {
    iz.devralma_denendi && !iz.handle_korunmali()
}

/// `geri_cekilme_adimi` + bozuk-handle kurtarmasi. Handle bu turda dusurulduyse
/// kota/kalici sinifin uzun beklemesi UYGULANMAZ: arizayi handle yapmis olabilir
/// ve temiz oturum sorunsuz acilabilir; tek kisa (1 sn) deneme yapilir ve sayac
/// bu deneme icin ARTMAZ. Temiz deneme de ayni sinifla kapanirsa (`devralma_denendi`
/// artik false) normal uzun bekleme isler, yani firtina riski bir denemeyle sinirli.
fn geri_cekilme_karari(iz: &OturumIzi, sinif: KapanisSinifi, sayac: usize) -> (u64, usize) {
    if handle_dustu(iz)
        && (matches!(sinif, KapanisSinifi::KotaYuk | KapanisSinifi::Kalici)
            || (!iz.setup_tamam && iz.setup_suresi_doldu))
    {
        let sayac = if iz.sayac_sifirlanir() { 0 } else { sayac };
        return (AG_BEKLEME_SN[0], sayac);
    }
    geri_cekilme_adimi(iz, sinif, sayac)
}

/// Setup asamasinda sunucu oturumu KALICI sinifta (1007/1008 ya da kodsuz hata
/// govdesi) reddettiyse ve baglam sikistirmasi acikse, sorun bu alan olabilir
/// (canlida `gemini-3.8-live` icin dogrulanmadi): sikistirmasiz bir kez daha
/// denenir. HTTP reddi (400/403: anahtar) ve setup SONRASI kapanislar
/// tetiklemez. Kalici dusme oturum omru boyunca surer (`start` dongusu).
fn sikistirma_geri_dusus(sik: Sikistirma, k: &Kapanis, iz: &OturumIzi) -> bool {
    matches!(sik, Sikistirma::KayanPencere { .. })
        && !iz.setup_tamam
        && k.sinif == KapanisSinifi::Kalici
        && matches!(k.kod, None | Some(1007) | Some(1008))
}

/// Setup reddi sonrasi "sikistirmasiz bir kez daha" log satiri. Ayri fonksiyon:
/// satir devamindaki bosluk kusuru (metne uzun bosluk dizisi giriyordu)
/// testle kapiya baglansin.
fn sikistirma_geri_dusus_logu(k: &Kapanis) -> String {
    let kod = k.kod.map_or_else(|| "yok".to_string(), |c| c.to_string());
    format!(
        "[live] setup reddedildi (kod={kod}, sebep={}): baglam sikistirmasi \
         kapatilip bir kez daha denenecek",
        k.sebep
    )
}

/// UI'a giden insan okunur ozet (`LIVE_BAGLANTI`/`TOOL_HATA` olayinin `sebep`i).
fn hata_ozeti(k: &Kapanis, bekle_sn: u64) -> String {
    let kod = k.kod.map_or_else(|| "yok".to_string(), |c| c.to_string());
    let ne = match k.sinif {
        KapanisSinifi::Planli => "baglanti planli kapandi",
        KapanisSinifi::KotaYuk => "kota veya yuk siniri (Gemini Live)",
        KapanisSinifi::Kalici => {
            "kalici hata: API anahtari, izin veya istek kontrol edilmeli (Gemini Live)"
        }
        KapanisSinifi::Ag => "ag hatasi (Gemini Live)",
        KapanisSinifi::AracYaniti => {
            "Smith arac yaniti hatasi (gelistirici hatasi); yeniden baglaniyor"
        }
    };
    format!(
        "{ne}; kod={kod} sebep={}; {bekle_sn} sn sonra yeniden denenecek",
        if k.sebep.is_empty() { "yok" } else { &k.sebep }
    )
}

/// `sn` saniye bekler ama `stop` istenirse en gec yarim saniyede doner. Duz
/// `sleep(300 sn)` kullanicinin "sustur"undan sonra bile 5 dakika boyunca
/// thread'i (ve olay kanalini) ayakta tutardi.
async fn bekle_iptal_edilebilir(sn: u64, stop: &AtomicBool) {
    let bitis = std::time::Instant::now() + std::time::Duration::from_secs(sn);
    while !stop.load(Ordering::Relaxed) {
        let kalan = bitis.saturating_duration_since(std::time::Instant::now());
        if kalan.is_zero() {
            break;
        }
        tokio::time::sleep(kalan.min(std::time::Duration::from_millis(500))).await;
    }
}

/// Calisan bir Live oturumu. `drop` edilince ses gonderimi durur ve WS kapanir.
pub struct LiveSession {
    /// Cihazdan gelen kareler buraya yazilir (mono f32 + cihaz frekansi).
    pcm_tx: Arc<MikTamponu>,
    stop: Arc<AtomicBool>,
}

impl LiveSession {
    /// Sonda icin derlenmis setup; ag, ses veya cihaz yakalama baslatmaz.
    /// Oturuma ozel ek baglam cagiran tarafindan verilir.
    pub fn setup_cercevesi_json(ek: &str) -> String {
        setup_frame_model(
            Devralma::Yeni,
            ek,
            sikistirma_env(),
            &live_model(),
            SunucuVad::env(mik_akisi_env() == MikAkisi::Gated),
        )
    }

    /// Oturumu baslatir. `events` UI'a giden olay kanali.
    ///
    /// `SMITH_GEMINI_KEY` yoksa `Err` doner : cagiran taraf basamakli hatta
    /// dusmeye karar verir (sessiz bozulma yok).
    pub fn start(events: mpsc::UnboundedSender<LiveEvent>) -> Result<Self, String> {
        let key = std::env::var("SMITH_GEMINI_KEY")
            .map_err(|_| "SMITH_GEMINI_KEY yok (Live oturumu acilamaz)".to_string())?;

        let pcm_tx = Arc::new(MikTamponu::default());
        let pcm_rx = pcm_tx.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_task = stop.clone();

        // Kendi runtime'i: Tauri'nin async baglami olmadan da calisir ve
        // oturum omru bu thread'e baglidir.
        std::thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("[live] runtime kurulamadi: {e}");
                    return;
                }
            };
            rt.block_on(async move {
                // OTOMATIK YENIDEN BAGLANMA (sahada gorulen kusur): Gemini Live
                // oturumlari sunucu tarafinda SURE SINIRLI : sesli oturum ~10 dk
                // sonra kapaniyor. Eskiden bu noktada her sey duruyordu ve
                // kullanici elle "sustur -> yeniden basla" yapmak zorunda
                // kaliyordu ("Live oturumu kapandi" mesaji). Artik `stop`
                // istenmedikce yeni oturum kurulur.
                //
                // Backoff kademeli: ard arda kapaniyorsa (kota, ag, anahtar)
                // saniyede bir yeniden denemek hem bosa hem kotayi hizlandirir.
                // `pcm_rx` DONGUNUN DISINDA tutulur: mikrofon karelerini tasiyan
                // kanal her yeniden baglanmada yeniden kurulsaydi, capture
                // tarafindaki gonderici kirilirdi.
                //
                // OTURUM DEVAMLILIGI: devralma handle'i DONGUNUN USTUNDE durur.
                // `session_loop` her yeniden baglanmada yeniden cagriliyor;
                // handle onun yerel degiskeni olsaydi tam da korumasi gereken
                // seyle birlikte silinirdi. DISKE YAZILMAZ: (a) handle bir
                // kimlik bilgisidir, (b) uygulama yeniden baslarken taze
                // oturum DOGRU davranistir.
                let handle: Arc<std::sync::Mutex<Option<String>>> =
                    Arc::new(std::sync::Mutex::new(None));
                // Son tamamlanmis kullanici ifadesi oturumlar arasinda yasar.
                // WS koparken cevap gelmediyse yeni oturumda bir kez replay edilir.
                let ifade_koruma = Arc::new(std::sync::Mutex::new(
                    super::microphone::IfadeKoruma::default(),
                ));
                //
                // GERI CEKILME (bkz. `KapanisSinifi`, `bekleme_sn`): bekleme
                // kapanisin SINIFINA ve ardisik kapanis sayisina bagli. Sayac
                // yalniz oturum gercekten saglikli ve uzun yasadiysa sifirlanir
                // (`OturumIzi::sayac_sifirlanir`); eskiden her normal kapanis
                // sifirliyordu ve kotada saniyede bir yeniden baglanma vardi.
                let kayit_yazici = konusma_yazici();
                let mut attempt = 0usize;
                let mut baglanti_yenileme = false;
                // Sikistirma niyeti oturum omru boyunca BIR kez okunur; setup
                // reddi sonrasi kalici olarak kapatilabilir (`sikistirma_geri_dusus`).
                let mut sikistirma = sikistirma_env();
                while !stop_task.load(Ordering::Relaxed) {
                    let mut iz = OturumIzi::default();
                    let sonuc = session_loop(
                        &key,
                        pcm_rx.clone(),
                        events.clone(),
                        stop_task.clone(),
                        &handle,
                        &mut iz,
                        sikistirma,
                        kayit_yazici,
                        baglanti_yenileme,
                        ifade_koruma.clone(),
                    )
                    .await;
                    baglanti_yenileme =
                        iz.bekci_yenilemesi || (baglanti_yenileme && !iz.setup_tamam);
                    // HANDLE POLITIKASI (bkz. `OturumIzi::handle_korunmali`):
                    // devralma denendi ama oturum kendini kanitlamadiysa handle
                    // DUSER ve sonraki deneme temiz oturumla baslar. Aksi halde
                    // tek bozuk handle Smith'i kalici olarak susturur.
                    if !iz.handle_korunmali() {
                        if let Ok(mut g) = handle.lock() {
                            *g = None;
                        }
                        eprintln!(
                            "[live] devralma tutmadi, handle dusuruldu: sonraki oturum temiz baslar"
                        );
                    }
                    // Ok = oturum kuruldu ve sonra kapandi; Err = kurulamadi.
                    // Ikisi de ayni kayda iner, sinif belirler.
                    let mut kapanis = match sonuc {
                        Ok(k) | Err(k) => k,
                    };
                    kapanis.sinif = etkin_sinif(&kapanis, &iz);
                    // Kurulamayan oturum `Connected(true)` hic yollamadi ve
                    // `session_loop` sonunda `Connected(false)` da yollamaz:
                    // gostergeyi burada indir.
                    if !iz.setup_tamam {
                        let _ = events.send(LiveEvent::Connected(false));
                    }
                    if stop_task.load(Ordering::Relaxed) || KAPANIYOR.load(Ordering::Relaxed) {
                        break;
                    }
                    // Sunucu setup'i sikistirma yuzunden reddetmis olabilir: tek
                    // kisa deneme sikistirmasiz yapilir, sayac artmaz. Hata
                    // henuz kullaniciya gosterilmez; temiz deneme de dusurse
                    // normal (kalici) yol UI'a bildirir.
                    if sikistirma_geri_dusus(sikistirma, &kapanis, &iz) {
                        sikistirma = Sikistirma::Kapali;
                        eprintln!("{}", sikistirma_geri_dusus_logu(&kapanis));
                        bekle_iptal_edilebilir(AG_BEKLEME_SN[0], &stop_task).await;
                        continue;
                    }
                    let (wait, sonraki) = geri_cekilme_karari(&iz, kapanis.sinif, attempt);
                    attempt = sonraki;
                    eprintln!(
                        "[live] oturum kapandi (sinif={}, kod={}, omur={} sn) — {wait} sn sonra \
                         yeniden baglanilacak",
                        kapanis.sinif.ad(),
                        kapanis
                            .kod
                            .map_or_else(|| "yok".to_string(), |k| k.to_string()),
                        iz.yasam_sn
                    );
                    // Planli kapanma (goAway / sure siniri) kullaniciyi
                    // ilgilendirmez; plansiz olan UI'a ACIK hata olarak gider.
                    if kapanis.sinif != KapanisSinifi::Planli {
                        eprintln!("[live] HATA: {}", hata_ozeti(&kapanis, wait));
                        let _ = events.send(LiveEvent::Tool {
                            ad: LIVE_BAGLANTI.into(),
                            durum: TOOL_HATA,
                            sebep: Some(hata_ozeti(&kapanis, wait)),
                        });
                    }
                    bekle_iptal_edilebilir(wait, &stop_task).await;
                }
                let _ = events.send(LiveEvent::Connected(false));
            });
        });

        Ok(Self { pcm_tx, stop })
    }

    /// Oturum hazir olmadan da ses ayni sinirli on-tampona girer.
    pub fn feed(&self, samples: Arc<[f32]>, rate: u32, kapali: bool) {
        self.pcm_tx.ekle(MikKaresi {
            samples,
            rate,
            kapali,
            at: std::time::Instant::now(),
            listen_epoch: dinleme_surumu(),
        });
    }
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn saha_mikrofon_iki_saniye_blokajda_kaybolmaz() {
        let pcm_tx = Arc::new(MikTamponu::default());
        let rx = pcm_tx.clone();
        let session = LiveSession {
            pcm_tx,
            stop: Arc::new(AtomicBool::new(false)),
        };
        // 10 ms callback, gonderici iki saniye boyunca hic okumuyor.
        for n in 0..200 {
            session.feed(vec![n as f32; 480].into(), 48_000, false);
        }
        for n in 0..200 {
            let kare = rx.al().expect("iki saniyelik ses eksiksiz kalmali");
            assert_eq!(kare.samples[0], n as f32);
        }
    }

    #[test]
    fn saha_bekci_kisa_devralinmis_oturumun_handleini_korur() {
        let mut iz = OturumIzi {
            devralma_denendi: true,
            setup_tamam: true,
            ..Default::default()
        };
        assert!(!iz.handle_korunmali());
        iz.bekci_yenilemesi = true;
        assert!(iz.handle_korunmali());
        assert!(!iz.saglikli(), "bekci sahte saglik kaniti olamaz");
    }

    use super::super::setup::setup_frame;
    use super::super::tools::arac_davranisi;
    use KapanisSinifi::{Ag, AracYaniti, Kalici, KotaYuk, Planli};
    #[test]
    fn audit_resume_ve_kod_araci() {
        assert_eq!(setup_zaman_asimi(Devralma::Handle("h")).as_secs(), 10);
        assert_eq!(arac_davranisi("kod_gorevi_ver"), "BLOCKING");
    }

    #[test]
    fn devralma_timeout_on_saniye_handle_korunur() {
        assert_eq!(setup_zaman_asimi(Devralma::Handle("h")).as_secs(), 10);
        for d in [Devralma::Yeni, Devralma::Kapali] {
            assert_eq!(setup_zaman_asimi(d).as_secs(), 10);
        }
        let mut iz = OturumIzi {
            devralma_denendi: true,
            setup_suresi_doldu: true,
            ..Default::default()
        };
        assert!(iz.handle_korunmali());
        for n in [0, 3] {
            assert_eq!(
                geri_cekilme_karari(&iz, KapanisSinifi::Ag, n),
                geri_cekilme_adimi(&iz, KapanisSinifi::Ag, n)
            );
        }
        iz.devralma_denendi = false;
        assert_eq!(
            geri_cekilme_karari(&iz, KapanisSinifi::Ag, 3),
            geri_cekilme_adimi(&iz, KapanisSinifi::Ag, 3)
        );
    }

    #[test]
    fn duyma_gated_setup_yuksek_duyarlilik_ve_700_ms() {
        for devralma in [Devralma::Yeni, Devralma::Handle("duyma-test")] {
            let v: serde_json::Value = serde_json::from_str(&setup_frame(devralma)).unwrap();
            let aad = &v["setup"]["realtimeInputConfig"]["automaticActivityDetection"];
            assert_eq!(aad["startOfSpeechSensitivity"], "START_SENSITIVITY_HIGH");
            assert_eq!(aad["endOfSpeechSensitivity"], "END_SENSITIVITY_LOW");
            assert_eq!(aad["silenceDurationMs"], 700);
        }
    }

    #[test]
    fn arac_yuku_hatasi_kisa_kademeli_bekler_ve_dogru_anlatilir() {
        for sebep in [
            "Invalid JSON payload received. Unknown name \"response\" at 'tool_response.function_responses[0]': Proto field is not repeating",
            "Unknown name \"response\"",
            "Proto field is not repeating",
        ] {
            let k = Kapanis::sunucudan(Some(1007), sebep, false);
            let iz = iz_yasadi(17, false, true);
            let mut sayac = 0;
            for beklenen in [2, 5, 10, 20, 30, 30] {
                let (bekle, sonraki) = geri_cekilme_karari(&iz, etkin_sinif(&k, &iz), sayac);
                assert_eq!(bekle, beklenen, "{sebep}");
                sayac = sonraki;
            }
            let ozet = hata_ozeti(&k, 2);
            assert!(ozet.contains("Smith arac yaniti hatasi (gelistirici hatasi); yeniden baglaniyor"), "{ozet}");
            assert!(!ozet.contains("API anahtari"), "{ozet}");
        }
    }

    // ---- OTURUM DEVAMLILIGI (sessionResumption) ----
    //
    // Bu testler AGA CIKMAZ: sunucu mesajlari birebir wire sekliyle enjekte
    // edilir. Dogrulanan sozlesme (ai.google.dev/api/live):
    //   setup.sessionResumption         "If included, the server will send
    //                                    SessionResumptionUpdate messages."
    //   setup.sessionResumption.handle  "The handle of a previous session. If
    //                                    not present then a new session is
    //                                    created."
    //   sessionResumptionUpdate         { newHandle, resumable } : newHandle
    //                                    "Empty if resumable=false."

    /// Sunucudan gelen devralma noktasi gercek JSON seklinden okunur.
    #[test]
    fn devralma_handlei_sunucu_mesajindan_okunur() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"sessionResumptionUpdate":{"newHandle":"CiQ1NTRhMmQ0Zi1oYW5kbGU","resumable":true}}"#,
        )
        .expect("gecerli JSON");
        assert_eq!(yeni_handle(&v).as_deref(), Some("CiQ1NTRhMmQ0Zi1oYW5kbGU"));
    }

    /// Devralinamaz guncelleme handle URETMEZ. Bos handle'i saklamak iki kez
    /// zarar verirdi: bagli olmayan bir degeri setup'a koyar ve bizi "devralma
    /// denendi" saymaya iterdi : yani ilk hatada saglam handle dusurulurdu.
    #[test]
    fn devralinamaz_guncelleme_handle_uretmez() {
        for ham in [
            r#"{"sessionResumptionUpdate":{"resumable":false,"newHandle":""}}"#,
            r#"{"sessionResumptionUpdate":{"resumable":true,"newHandle":""}}"#,
            r#"{"sessionResumptionUpdate":{"newHandle":"h-1"}}"#,
            r#"{"serverContent":{"turnComplete":true}}"#,
            r#"{"setupComplete":{}}"#,
        ] {
            let v: serde_json::Value = serde_json::from_str(ham).expect("gecerli JSON");
            assert!(yeni_handle(&v).is_none(), "handle uretilmemeliydi: {ham}");
        }
    }

    /// `goAway` yakalanir. Alan gelmese bile haberin KENDISI bilgidir.
    #[test]
    fn goaway_haberi_yakalanir() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"goAway":{"timeLeft":"60s"}}"#).expect("gecerli JSON");
        assert_eq!(go_away_kalan(&v).as_deref(), Some("60s"));
        let bos: serde_json::Value =
            serde_json::from_str(r#"{"goAway":{}}"#).expect("gecerli JSON");
        assert_eq!(go_away_kalan(&bos).as_deref(), Some("bilinmiyor"));
        let alakasiz: serde_json::Value =
            serde_json::from_str(r#"{"serverContent":{}}"#).expect("gecerli JSON");
        assert!(go_away_kalan(&alakasiz).is_none());
    }

    /// Devralma KAPALIYKEN alan setup'a hic girmez ve elde handle olsa bile
    /// gonderilmez (kapali bayrak "handle'i gizle" degil "mekanizmayi kullanma"
    /// demek: sunucu da guncelleme yollamamalidir).
    #[test]
    fn devralma_kapaliyken_handle_setupa_girmez() {
        assert_eq!(
            devralma_niyeti(false, Some("h-42")),
            Devralma::Kapali,
            "SMITH_LIVE_RESUME=0 iken eldeki handle yine de kullanilmis"
        );
        let govde = setup_frame(Devralma::Kapali);
        assert!(
            !govde.contains("sessionResumption"),
            "devralma kapaliyken alan setup'a girmis: {govde}"
        );
        assert!(
            !govde.contains("h-42"),
            "kapali bayraga ragmen handle gonderiliyor"
        );
        // Bos handle de devralma sayilmaz: temiz oturum acilir.
        assert_eq!(devralma_niyeti(true, Some("")), Devralma::Yeni);
        assert_eq!(devralma_niyeti(true, None), Devralma::Yeni);
        assert_eq!(
            devralma_niyeti(true, Some("h-42")),
            Devralma::Handle("h-42")
        );
    }

    /// Env dikisi: varsayilan ACIK, yalniz "0" kapatir (`SMITH_LIVE` ile ayni
    /// sozlesme). Bu degiskeni baska hicbir test okumadigi icin ayarlamak
    /// paralel kosuma zarar vermez; test kendinden sonra ortami geri birakir.
    #[test]
    fn env_dikisi_varsayilan_acik_ve_sifir_kapatir() {
        let onceki = std::env::var("SMITH_LIVE_RESUME").ok();
        std::env::remove_var("SMITH_LIVE_RESUME");
        assert!(devralma_acik(), "varsayilan ACIK olmali");
        std::env::set_var("SMITH_LIVE_RESUME", "1");
        assert!(devralma_acik());
        std::env::set_var("SMITH_LIVE_RESUME", "0");
        assert!(!devralma_acik(), "SMITH_LIVE_RESUME=0 devralmayi kapatmali");
        match onceki {
            Some(v) => std::env::set_var("SMITH_LIVE_RESUME", v),
            None => std::env::remove_var("SMITH_LIVE_RESUME"),
        }
    }

    /// EN KRITIK REGRESYON: reddedilen handle DUSER.
    ///
    /// Handle takili kalirsa suresi dolmus veya bozulmus bir handle her yeni
    /// oturumu ayni sekilde oldurur; Smith kalici olarak baglanamaz hale gelir
    /// ve backoff bunu yalniz yavaslatir. Kural: devralma denendiyse handle
    /// ancak oturum KENDINI KANITLADIGINDA korunur.
    #[test]
    fn reddedilen_handle_dusurulur() {
        // (aciklama, iz, handle korunmali mi)
        let durumlar = [
            (
                "handle ile setup REDDEDILDI (sure doldu / bozuk handle)",
                OturumIzi {
                    devralma_denendi: true,
                    ..Default::default()
                },
                false,
            ),
            (
                "setup gecti ama oturum hicbir iz birakmadan oldu (zehirli handle)",
                OturumIzi {
                    devralma_denendi: true,
                    setup_tamam: true,
                    ..Default::default()
                },
                false,
            ),
            (
                "handle geldi ama oturum hic calismadi: handle'in VARLIGI saglik \
                 kaniti DEGIL (bozuk handle ile de devralma noktasi geliyor)",
                OturumIzi {
                    devralma_denendi: true,
                    setup_tamam: true,
                    handle_geldi: true,
                    ..Default::default()
                },
                false,
            ),
            (
                "devralma tuttu: planli kapanma (goAway)",
                OturumIzi {
                    devralma_denendi: true,
                    setup_tamam: true,
                    go_away: true,
                    ..Default::default()
                },
                true,
            ),
            (
                "devralma tuttu: model konustu",
                OturumIzi {
                    devralma_denendi: true,
                    setup_tamam: true,
                    icerik_geldi: true,
                    ..Default::default()
                },
                true,
            ),
            (
                "temiz oturum basarisiz oldu: dusurulecek handle YOK, elde bir \
                 sey varsa da silinmemeli (ag hatasi baglami silmez)",
                OturumIzi {
                    devralma_denendi: false,
                    ..Default::default()
                },
                true,
            ),
        ];
        for (ne, iz, beklenen) in durumlar {
            assert_eq!(
                iz.handle_korunmali(),
                beklenen,
                "{ne} -> handle_korunmali() beklenen {beklenen}, iz: {iz:?}"
            );
        }
    }

    /// Siniflandirma tablosu: (kod, sebep, goAway, beklenen).
    #[test]
    fn kapanis_kod_ve_sebepten_siniflanir() {
        let tablo: &[(Option<u16>, &str, bool, KapanisSinifi)] = &[
            // planli
            (Some(1000), "", false, Planli),
            (Some(1001), "going away", false, Planli),
            (Some(1011), "internal error", true, Planli), // goAway her seyi ezer
            (None, "", true, Planli),
            // kota / yuk: kod
            (Some(1011), "", false, KotaYuk),
            (Some(1013), "try again later", false, KotaYuk),
            // kota / yuk: sebep (koddan once; 1008 + quota kalici DEGIL)
            (
                Some(1008),
                "Quota exceeded for this project",
                false,
                KotaYuk,
            ),
            (Some(1011), "RESOURCE_EXHAUSTED: try later", false, KotaYuk),
            (Some(1006), "rate limit hit", false, KotaYuk),
            (
                Some(1000),
                "Resource has been exhausted (e.g. check quota).",
                false,
                KotaYuk,
            ),
            // kalici: kod
            (
                Some(1007),
                "Invalid JSON payload received",
                false,
                AracYaniti,
            ),
            (Some(1007), "Unknown name \"response\"", false, AracYaniti),
            (
                Some(1007),
                "Proto field is not repeating",
                false,
                AracYaniti,
            ),
            (Some(1007), "INVALID JSON PAYLOAD", false, AracYaniti),
            (Some(1007), "Invalid JSON payload", true, Planli),
            (Some(1008), "Invalid JSON payload", false, Kalici),
            (Some(1007), "API key not valid", false, Kalici),
            (Some(1008), "API_KEY_INVALID", false, Kalici),
            (Some(1007), "Permission denied", false, Kalici),
            (Some(1008), "Permission denied", false, Kalici),
            (
                Some(1007),
                "Invalid JSON payload: API_KEY_INVALID",
                false,
                Kalici,
            ),
            (Some(1007), "Unknown name; permission denied", false, Kalici),
            (Some(1007), "", false, Kalici),
            (Some(1008), "policy violation", false, Kalici),
            // kalici: sebep
            (
                Some(1011),
                "API key not valid. Please pass a valid API key.",
                false,
                Kalici,
            ),
            (None, "API_KEY_INVALID", false, Kalici),
            (Some(1006), "Permission denied on resource", false, Kalici),
            (
                Some(1011),
                "Request contains an invalid argument.",
                false,
                Kalici,
            ),
            // ag
            (Some(1006), "", false, Ag),
            (Some(1002), "protocol error", false, Ag),
            (Some(1005), "", false, Ag),
            (None, "", false, Ag),
            (None, "connection reset", false, Ag),
        ];
        for (kod, sebep, go_away, beklenen) in tablo {
            assert_eq!(
                kapanis_siniflandir(*kod, sebep, *go_away),
                *beklenen,
                "kod={kod:?} sebep={sebep:?} goAway={go_away}"
            );
        }
    }

    /// Jeton siniri: belirtec baska bir sozcugun ICINDE kalirsa eslesmez
    /// (`generate`/`iterate` icindeki `rate`, `invalidate` icindeki `invalid`),
    /// ama alt cizgi/noktalamayla ayrilmis kod adlari eslesir.
    #[test]
    fn siniflandirma_jeton_sinirina_bakar() {
        for masum in [
            "failed to generate response",
            "cannot iterate over stream",
            "please invalidate the cache",
            "apikeyless request", // `api` ve `key` ayri jeton degil
        ] {
            assert_eq!(
                kapanis_siniflandir(Some(1006), masum, false),
                Ag,
                "yanlis pozitif: {masum:?}"
            );
        }
        // Buyuk/kucuk harf ve ayirici fark etmez.
        assert_eq!(kapanis_siniflandir(None, "Rate_Limit", false), KotaYuk);
        assert_eq!(kapanis_siniflandir(None, "api-key missing", false), Kalici);
        // `api` ve `key` ayri ayri gecerse (bitisik degilse) kalici sayilmaz.
        assert_eq!(
            kapanis_siniflandir(None, "api rotated, key unchanged", false),
            Ag
        );
    }

    #[test]
    fn http_el_sikisma_durumlari_siniflanir() {
        for (d, s) in [
            (400, Kalici),
            (401, Kalici),
            (403, Kalici),
            (404, Kalici),
            (429, KotaYuk),
            (503, KotaYuk),
            (500, Ag),
            (502, Ag),
        ] {
            assert_eq!(http_durum_sinifi(d), s, "http {d}");
        }
    }

    /// Bekleme politikasi: kota 30 sn'den baslar, ikiye katlanir, 5 dk tavan;
    /// kalici sabit 5 dk; ag kisa kademeli; hicbiri 0 degil.
    #[test]
    fn bekleme_politikasi_siniflara_gore() {
        let kota: Vec<u64> = (0..8).map(|n| bekleme_sn(KotaYuk, n)).collect();
        assert_eq!(kota, [30, 60, 120, 240, 300, 300, 300, 300]);
        for n in [0, 1, 7, 1000, usize::MAX] {
            assert_eq!(bekleme_sn(Kalici, n), 300, "kalici deneme={n}");
            assert!(bekleme_sn(KotaYuk, n) <= 300, "kota tavani deneme={n}");
        }
        let ag: Vec<u64> = (0..8).map(|n| bekleme_sn(Ag, n)).collect();
        assert_eq!(ag, [1, 2, 5, 10, 20, 30, 30, 30]);
        assert_eq!(bekleme_sn(AracYaniti, usize::MAX), 30);
        assert_eq!(bekleme_sn(Planli, 0), 1);
        assert_eq!(bekleme_sn(Planli, 3), 10);
    }

    fn iz_yasadi(yasam_sn: u64, go_away: bool, hata: bool) -> OturumIzi {
        OturumIzi {
            setup_tamam: true,
            go_away,
            yasam_sn,
            hata_kapanisi: hata,
            ..Default::default()
        }
    }

    /// Sayac YALNIZ saglikli+uzun oturumda ya da goAway ile planli kapanista
    /// sifirlanir (eski hata: her `Ok(())` sifirliyordu).
    #[test]
    fn sayac_yalniz_uzun_saglikli_veya_planli_kapanista_sifirlanir() {
        // (aciklama, iz, sifirlanmali)
        let tablo = [
            ("setup'ta olen oturum", OturumIzi::default(), false),
            (
                "setup sonrasi 2 sn'de kota kapanisi",
                iz_yasadi(2, false, true),
                false,
            ),
            ("59 sn", iz_yasadi(59, false, false), false),
            (
                "60 sn sessiz ama saglikli",
                iz_yasadi(60, false, false),
                true,
            ),
            (
                "10 dk calisti sonra ag koptu",
                iz_yasadi(600, false, true),
                true,
            ),
            (
                "goAway ile planli kapanma (kisa omurlu bile)",
                iz_yasadi(5, true, false),
                true,
            ),
            (
                "setup yok ama sure dolu gorunuyor (tutarsiz iz): setup sart",
                OturumIzi {
                    yasam_sn: 999,
                    ..Default::default()
                },
                false,
            ),
        ];
        for (ne, iz, beklenen) in tablo {
            assert_eq!(iz.sayac_sifirlanir(), beklenen, "{ne}: {iz:?}");
        }
    }

    /// FIRTINA REGRESYONU: kota kapanislari 2 sn'de bir gelirken bekleme asla
    /// 1 sn'ye inmemeli, 30 sn'den baslayip 5 dk'ya tirmanmali.
    #[test]
    fn kota_kapanislari_yeniden_baglanma_firtinasi_uretmez() {
        let iz = iz_yasadi(2, false, true);
        let mut sayac = 0usize;
        let mut beklemeler = Vec::new();
        for _ in 0..7 {
            let (bekle, sonraki) = geri_cekilme_adimi(&iz, KotaYuk, sayac);
            beklemeler.push(bekle);
            sayac = sonraki;
        }
        assert_eq!(beklemeler, [30, 60, 120, 240, 300, 300, 300]);
    }

    /// Saglikli uzun oturum sonrasi sayac sifirlanir: kullanici bir kopmadan
    /// sonra 5 dk degil 1 sn bekler.
    #[test]
    fn uzun_saglikli_oturumdan_sonra_bekleme_basa_doner() {
        let kotada = iz_yasadi(2, false, true);
        let mut sayac = 0usize;
        for _ in 0..4 {
            sayac = geri_cekilme_adimi(&kotada, Ag, sayac).1;
        }
        assert_eq!(sayac, 4);
        let uzun = iz_yasadi(300, false, true); // 5 dk calisti, sonra ag koptu
        let (bekle, sonraki) = geri_cekilme_adimi(&uzun, Ag, sayac);
        assert_eq!((bekle, sonraki), (1, 1));
        // goAway ile planli kapanma da sifirlar.
        let (bekle, _) = geri_cekilme_adimi(&iz_yasadi(5, true, false), Planli, 5);
        assert_eq!(bekle, 1);
    }

    fn devralan_iz(setup_tamam: bool, yasam_sn: u64, hata: bool) -> OturumIzi {
        OturumIzi {
            devralma_denendi: true,
            setup_tamam,
            yasam_sn,
            hata_kapanisi: hata,
            ..Default::default()
        }
    }

    /// Devralma tutmayip handle dusurulduyse (bozuk handle imzasi: kisa omur +
    /// kota/kalici sinif) sonraki TEMIZ deneme sinifin uzun beklemesine
    /// takilmaz: tek kisa deneme, sayac bu deneme icin artmaz. Sonraki hata
    /// artik normal siniflara gore bekler (devralma denenmedi).
    #[test]
    fn dusen_handle_sonrasi_temiz_deneme_uzun_beklemez() {
        let bozuk = devralan_iz(true, 3, true);
        assert!(!bozuk.handle_korunmali());
        for sinif in [Kalici, KotaYuk] {
            assert_eq!(
                geri_cekilme_karari(&bozuk, sinif, 0),
                (1, 0),
                "{sinif:?}: handle dustu -> 1 sn, sayac artmaz"
            );
        }
        // Temiz oturum ayni hatayla kapanirsa politika normal isler.
        let temiz = OturumIzi {
            setup_tamam: true,
            yasam_sn: 3,
            hata_kapanisi: true,
            ..Default::default()
        };
        assert_eq!(geri_cekilme_karari(&temiz, Kalici, 0), (300, 1));
        assert_eq!(geri_cekilme_karari(&temiz, KotaYuk, 0), (30, 1));
        // Handle korunduysa (devralma tuttu) kisayol YOK.
        let tuttu = OturumIzi {
            icerik_geldi: true,
            ..devralan_iz(true, 120, true)
        };
        assert!(tuttu.handle_korunmali());
        assert_eq!(geri_cekilme_karari(&tuttu, KotaYuk, 3), (30, 1));
        // Ag/planli zaten kisa: kisayol onlari degistirmez.
        assert_eq!(geri_cekilme_karari(&bozuk, Ag, 2), (5, 3));
    }

    /// Uzun yasamis oturumun YALNIZ KODLA (1011) kota sayilan kapanisi,
    /// sebep bos olsun ya da kota disi bir metin tasisin, kota teshisi almaz
    /// (Ag kademesi); kisa omurlu kapanis ve kota jetonlu sebep KotaYuk kalir.
    #[test]
    fn uzun_oturum_sonrasi_yalniz_kodla_kota_sayilan_kapanis_ag_olur() {
        let k = |kod, sebep: &str| Kapanis::sunucudan(kod, sebep, false);
        let uzun = iz_yasadi(1200, false, true);
        let kisa = iz_yasadi(5, false, true);
        assert_eq!(etkin_sinif(&k(Some(1011), ""), &uzun), Ag);
        assert_eq!(etkin_sinif(&k(Some(1011), ""), &kisa), KotaYuk);
        // Saha raporu: 58. dakikada 1011 "deadline expired". Sebep BOS DEGIL
        // ama kota jetonu yok: eskiden KotaYuk (30 sn susku), artik Ag.
        assert_eq!(
            etkin_sinif(
                &k(
                    Some(1011),
                    "Deadline expired before operation could complete"
                ),
                &uzun
            ),
            Ag
        );
        assert_eq!(
            etkin_sinif(&k(Some(1011), "Deadline expired"), &kisa),
            KotaYuk,
            "kisa omurlu oturumda kodla kota teshisi korunur"
        );
        assert_eq!(etkin_sinif(&k(Some(1013), ""), &uzun), KotaYuk);
        assert_eq!(
            etkin_sinif(&k(Some(1013), "try again later"), &uzun),
            KotaYuk,
            "1013 sunucu yukunu acikca bildirir"
        );
        assert_eq!(
            etkin_sinif(&k(Some(1013), "try again later"), &kisa),
            KotaYuk
        );
        // Kota jetonu tasiyan sebep: uzun omur teshisi DEGISTIRMEZ.
        for sebep in [
            "RESOURCE_EXHAUSTED",
            "You exceeded your current quota",
            "rate limit reached",
        ] {
            assert_eq!(
                etkin_sinif(&k(Some(1011), sebep), &uzun),
                KotaYuk,
                "kota jetonlu sebep ({sebep:?}) Ag olmamali"
            );
            assert_eq!(etkin_sinif(&k(Some(1013), sebep), &uzun), KotaYuk);
        }
        assert_eq!(etkin_sinif(&k(Some(1007), ""), &uzun), Kalici);
        // Uzun omur + sayac sifirlanmasi: ilk bekleme 1 sn (30 degil).
        let sinif = etkin_sinif(&k(Some(1011), ""), &uzun);
        assert_eq!(geri_cekilme_karari(&uzun, sinif, 4), (1, 1));
    }

    /// Setup asamasinda kalici kapanis (1007/1008/kodsuz govde) ve sikistirma
    /// acikken bir kez sikistirmasiz denenir; setup SONRASI kapanis, HTTP
    /// reddi ve zaten kapali sikistirma bunu tetiklemez.
    #[test]
    fn setup_reddinde_sikistirma_bir_kez_kapatilir() {
        let acik = Sikistirma::KayanPencere { tetik: None };
        let setup_oncesi = OturumIzi::default();
        let kalici = |kod| Kapanis::sunucudan(kod, "invalid argument", false);
        for kod in [Some(1007), Some(1008), None] {
            assert!(
                sikistirma_geri_dusus(acik, &kalici(kod), &setup_oncesi),
                "kod={kod:?}"
            );
        }
        assert!(!sikistirma_geri_dusus(
            Sikistirma::Kapali,
            &kalici(Some(1007)),
            &setup_oncesi
        ));
        assert!(!sikistirma_geri_dusus(
            acik,
            &kalici(Some(1007)),
            &iz_yasadi(2, false, true)
        ));
        assert!(!sikistirma_geri_dusus(
            acik,
            &kalici(Some(403)),
            &setup_oncesi
        ));
        assert!(!sikistirma_geri_dusus(
            acik,
            &Kapanis::sunucudan(Some(1011), "", false),
            &setup_oncesi
        ));
        assert!(!sikistirma_geri_dusus(
            acik,
            &Kapanis::ag("setupComplete gelmedi"),
            &setup_oncesi
        ));
    }

    /// DEVRALMA SAGLIGI: sessiz ama saglikli oturum (>= 60 sn, hata sinifinda
    /// kapanmadi) handle'ini KORUR; bozuk-handle emniyeti (kisa omur + hata)
    /// ise ayni kalir.
    #[test]
    fn sessiz_ama_uzun_yasayan_oturum_handle_korur() {
        let devralan = |yasam_sn, hata| OturumIzi {
            devralma_denendi: true,
            setup_tamam: true,
            yasam_sn,
            hata_kapanisi: hata,
            ..Default::default()
        };
        // (aciklama, iz, handle korunmali)
        let tablo = [
            ("60 sn sessiz, hata degil", devralan(60, false), true),
            ("10 dk sessiz, hata degil", devralan(600, false), true),
            ("59 sn sessiz", devralan(59, false), false),
            (
                "bozuk handle imzasi: kisa omur + hata",
                devralan(3, true),
                false,
            ),
            (
                "uzun omur ama hata sinifinda kapandi",
                devralan(600, true),
                false,
            ),
            (
                "kisa omur, hata degil, icerik yok",
                devralan(3, false),
                false,
            ),
        ];
        for (ne, iz, beklenen) in tablo {
            assert_eq!(iz.handle_korunmali(), beklenen, "{ne}: {iz:?}");
        }
        // Eski kriterler degismedi: icerik ya da goAway hala yeter.
        let mut iz = devralan(3, true);
        iz.icerik_geldi = true;
        assert!(iz.saglikli(), "icerik gelmis oturum saglikli kalmali");
        let mut iz = devralan(3, true);
        iz.go_away = true;
        assert!(iz.saglikli(), "goAway gelmis oturum saglikli kalmali");
    }

    /// Close frame'den kod+sebep cikarilir ve log satiri sozlesmedeki bicimde.
    #[test]
    fn close_frame_kod_ve_sebep_cikarilir() {
        use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
        use tokio_tungstenite::tungstenite::protocol::CloseFrame;

        let frame = CloseFrame {
            code: CloseCode::Error, // 1011
            reason: "Quota exceeded".into(),
        };
        let (kod, sebep) = kapanma_bilgisi(Some(&frame));
        assert_eq!(kod, Some(1011));
        assert_eq!(sebep, "Quota exceeded");
        assert_eq!(
            kapanis_logu(kod, &sebep),
            "[live] sunucu kapatti kod=1011 sebep=Quota exceeded"
        );
        assert_eq!(kapanma_bilgisi(None), (None, String::new()));
        assert_eq!(
            kapanis_logu(None, ""),
            "[live] sunucu kapatti kod=yok sebep="
        );
        // Cok satirli / uzun sebep tek satira iner ve kisalir.
        let uzun = format!("a\nb {}", "x".repeat(500));
        let log = kapanis_logu(Some(1011), &uzun);
        assert!(!log.contains('\n'));
        assert!(log.ends_with("..."), "{log}");
        assert!(log.len() < 300);
    }

    /// Kapanis kaydi: kod+sebepten sinif cikar, goAway planliya cevirir.
    #[test]
    fn kapanis_kaydi_sunucudan_siniflanir() {
        let k = Kapanis::sunucudan(Some(1011), "quota", false);
        assert_eq!(
            (k.sinif, k.kod, k.sebep.as_str()),
            (KotaYuk, Some(1011), "quota")
        );
        let k = Kapanis::sunucudan(Some(1011), "quota", true);
        assert_eq!(k.sinif, Planli);
        assert_eq!(Kapanis::ag("x").sinif, Ag);
        assert_eq!(Kapanis::durduruldu().sinif, Planli);
    }

    /// `connect_async` HTTP reddi durumdan siniflanir; anahtar mesajdan silinir.
    #[test]
    fn baglanti_hatasi_http_durumundan_siniflanir_ve_anahtari_gizler() {
        use tokio_tungstenite::tungstenite::{http, Error as WsHata};
        let yanit = |kod: u16| {
            let r = http::Response::builder()
                .status(kod)
                .body(None)
                .expect("yanit");
            WsHata::Http(r)
        };
        let k = Kapanis::baglanti_hatasi(&yanit(403), "SIR-ANAHTAR");
        assert_eq!((k.sinif, k.kod), (Kalici, Some(403)));
        let k = Kapanis::baglanti_hatasi(&yanit(429), "SIR-ANAHTAR");
        assert_eq!((k.sinif, k.kod), (KotaYuk, Some(429)));
        let k = Kapanis::baglanti_hatasi(&yanit(502), "SIR-ANAHTAR");
        assert_eq!(k.sinif, Ag);
        let k = Kapanis::baglanti_hatasi(&WsHata::ConnectionClosed, "SIR-ANAHTAR");
        assert_eq!((k.sinif, k.kod), (Ag, None));

        assert_eq!(
            anahtari_maskele("GET ...?key=SIR-ANAHTAR&x=1 hata", "SIR-ANAHTAR"),
            "GET ...?key=***&x=1 hata"
        );
        assert_eq!(
            anahtari_maskele("metin", ""),
            "metin",
            "bos anahtar her seyi silmemeli"
        );
    }

    #[test]
    fn hata_ozeti_sinifi_kodu_sebebi_ve_beklemeyi_tasir() {
        let k = Kapanis::sunucudan(Some(1011), "Quota exceeded", false);
        let o = hata_ozeti(&k, 60);
        for parca in ["kota", "1011", "Quota exceeded", "60 sn"] {
            assert!(o.contains(parca), "ozet {parca:?} icermiyor: {o}");
        }
        let k = Kapanis::sunucudan(Some(1008), "API key not valid", false);
        let o = hata_ozeti(&k, 300);
        assert!(o.contains("kalici") && o.contains("300 sn"), "{o}");
        // Frame'siz ag hatasinda kod/sebep "yok" der, bos birakmaz.
        let o = hata_ozeti(&Kapanis::ag(""), 1);
        assert!(o.contains("kod=yok") && o.contains("sebep=yok"), "{o}");
    }

    /// Iptal edilebilir bekleme: `stop` zaten set ise uzun bekleme ANINDA doner.
    #[tokio::test(flavor = "current_thread")]
    async fn bekleme_stop_ile_hemen_biter() {
        let stop = AtomicBool::new(true);
        let t = std::time::Instant::now();
        bekle_iptal_edilebilir(300, &stop).await;
        assert!(
            t.elapsed() < std::time::Duration::from_secs(2),
            "stop set iken bekleme surdu: {:?}",
            t.elapsed()
        );
    }

    // ---- KUCUK DUZELTMELER ----

    /// Satir devamindaki bosluk kusuru: log metnine uzun bosluk dizisi
    /// giriyordu ("sikistirmasi        kapatilip").
    #[test]
    fn setup_reddi_logu_satir_devamini_dogru_birlestirir() {
        let k = Kapanis::sunucudan(Some(1007), "invalid argument", false);
        let s = sikistirma_geri_dusus_logu(&k);
        assert!(!s.contains("  "), "birden fazla bosluk var: {s:?}");
        assert!(
            s.contains("baglam sikistirmasi kapatilip bir kez daha denenecek"),
            "{s}"
        );
        assert!(s.contains("kod=1007") && s.contains("sebep=invalid argument"));
        // Kodsuz govde.
        let k = Kapanis::sunucudan(None, "bad", false);
        assert!(sikistirma_geri_dusus_logu(&k).contains("kod=yok"));
    }
    #[test]
    fn audit_8_uzun_oturum_1013_yuk_olarak_kalir() {
        let iz = iz_yasadi(3600, false, true);
        let k = Kapanis::sunucudan(Some(1013), "Try Again Later", false);
        let sinif = etkin_sinif(&k, &iz);
        assert_eq!(sinif, KotaYuk);
        assert_eq!(geri_cekilme_karari(&iz, sinif, 0), (30, 1));
    }

    #[test]
    fn audit_1_capture_bayragi_pcm_den_bagimsiz_tasinir() {
        let tx = Arc::new(MikTamponu::default());
        let rx = tx.clone();
        let session = LiveSession {
            pcm_tx: tx,
            stop: Arc::new(AtomicBool::new(false)),
        };
        for kapali in [false, true] {
            session.feed(vec![0.0; 512].into(), 16000, kapali);
            let frame = rx.al().unwrap();
            assert_eq!(frame.kapali, kapali);
            assert!(frame.samples.iter().all(|s| *s == 0.0));
        }
    }
}

/// El sikisma butcesi asilirsa normal ag geri cekilmesine doner.
pub(super) async fn baglan(
    key: &str,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Kapanis,
> {
    match tokio::time::timeout(
        BAGLANTI_ZAMAN_ASIMI,
        tokio_tungstenite::connect_async(ws_url(key)),
    )
    .await
    {
        Err(_) => {
            return Err(Kapanis::ag(format!(
                "baglanti {} sn icinde kurulamadi (zaman asimi)",
                BAGLANTI_ZAMAN_ASIMI.as_secs()
            )))
        }
        Ok(Err(e)) => return Err(Kapanis::baglanti_hatasi(&e, key)),
        Ok(Ok((ws, _))) => Ok(ws),
    }
}
