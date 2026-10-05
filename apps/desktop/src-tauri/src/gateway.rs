use std::fmt;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

/// Proaktif yenileme esigi. Gateway dev-login token'i 12 saatte olur (sunucu
/// sozlesmesi); bir saat once yenilemek istegin yolda iken bitmemesi icin pay
/// birakir, 401 yolu ayrica son savunmadir. Gozlenen ariza: uzun suren
/// masaustu oturumunda olmus token SONSUZA DEK kullaniliyordu.
const TOKEN_YENILEME_YASI: Duration = Duration::from_secs(11 * 3600);
const GATEWAY_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const GATEWAY_TOTAL_TIMEOUT: Duration = Duration::from_secs(30);
const GATEWAY_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Hata govdesinden okunacak en cok bayt. Gateway'in `{error}` yaniti kucuktur;
/// araya giren bir proxy'nin HTML sayfasi gibi beklenmedik buyuk govde bellegi
/// sisirmez (limit asilirsa mesaj yok sayilir, durum kodu yine hatada kalir).
const HATA_GOVDE_BAYT: u64 = 4096;
/// Gateway mesajinin ust siniri (bayt): hata satiri modele ve panoya kisa gider.
const HATA_MESAJ_BAYT: usize = 300;

/// Tum ajanlarin ortak ayari: 4xx/5xx yanitlari `ureq` hatasi DEGIL yanittir.
/// Eskiden `ureq` her 4xx'i `Error::StatusCode(kod)`a cevirip govdeyi atiyordu;
/// model ve pano yalniz "http status: 409" goruyor, gateway'in `{error: "..."}`
/// sebebi (gecersiz gorev gecisi, profil dogrulama mesaji...) kayboluyordu.
/// Durum denetimi artik `basari_bekle`de TEK yerde yapilir.
fn ajan_ayari() -> ureq::config::ConfigBuilder<ureq::typestate::AgentScope> {
    ureq::Agent::config_builder().http_status_as_error(false)
}

fn gateway_agent_with_timeouts(connect: Duration, total: Duration, read: Duration) -> ureq::Agent {
    ajan_ayari()
        .timeout_connect(Some(connect))
        .timeout_global(Some(total))
        .timeout_recv_response(Some(read))
        .timeout_recv_body(Some(read))
        .build()
        .into()
}

fn gateway_agent() -> ureq::Agent {
    gateway_agent_with_timeouts(
        GATEWAY_CONNECT_TIMEOUT,
        GATEWAY_TOTAL_TIMEOUT,
        GATEWAY_READ_TIMEOUT,
    )
}

/// Bir gateway cagrisinin basarisizligi.
///
/// `Display` metni, eskiden `String` donen yolun metnidir
/// (`{path} cagrisi basarisiz: http status: 409`) ve gateway'in sebebi de eklenir;
/// `String` donen cagiranlar (Live araclari, hatirlatma) degismeden calisir.
/// Mission Control koprusu ise metni parcalamak yerine alanlari okur (`mission.rs`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayHatasi {
    /// Gateway yanit verdiyse HTTP durumu; ag, zaman asimi ya da oturum
    /// acilamamasi gibi yanitin hic gelmedigi hallerde `None`.
    pub durum: Option<u16>,
    /// Gateway'in 4xx/5xx govdesindeki `error` metni: maskeli, tek satir, kisaltilmis.
    pub mesaj: Option<String>,
    metin: String,
}

impl GatewayHatasi {
    fn yeni(durum: Option<u16>, mesaj: Option<String>, metin: String) -> Self {
        Self {
            durum,
            mesaj,
            metin,
        }
    }

    /// Yanit alinamadi ya da okunamadi (ag, zaman asimi, oturum acilamadi).
    fn iletisim(metin: impl Into<String>) -> Self {
        Self::yeni(None, None, metin.into())
    }

    /// Gateway 2xx disi bir durumla yanit verdi: `{onek}: http status: {kod}` ve
    /// varsa gateway'in sebebi parantez icinde.
    fn durumlu(onek: &str, kod: u16, mesaj: Option<String>) -> Self {
        let metin = match &mesaj {
            Some(m) => format!("{onek}: http status: {kod} ({m})"),
            None => format!("{onek}: http status: {kod}"),
        };
        Self::yeni(Some(kod), mesaj, metin)
    }
}

impl fmt::Display for GatewayHatasi {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.metin)
    }
}

/// Tek bir istegin sonucu: yetki hatasi ayri bir durum, cunku onun tedavisi
/// (token'i at, yeniden login ol) diger hatalardan (ag, 5xx, 409) farklidir.
#[derive(Debug, PartialEq, Eq)]
enum CagriHatasi {
    /// HTTP 401: token reddedildi (sure doldu / gateway yeniden basladi).
    Yetkisiz,
    /// Baska her hata; cagirana aynen doner.
    Diger(GatewayHatasi),
}

/// Tasima katmani hatasi (ag, zaman asimi, protokol). HTTP durumlari buraya
/// GELMEZ: ajanlar `http_status_as_error(false)` ile kurulur (bkz. `ajan_ayari`).
fn tasima_hatasi(path: &str, e: ureq::Error) -> CagriHatasi {
    CagriHatasi::Diger(GatewayHatasi::iletisim(format!(
        "{path} cagrisi basarisiz: {e}"
    )))
}

/// 2xx yaniti aynen verir; digerini hataya cevirir (`{onek}: http status: KOD
/// (gateway mesaji)`). 401'i AYIRMAK cagirana aittir (`gonder`): 403 yetki
/// YETERSIZLIGIDIR (yeni token cozmez), 409 gateway'in is kurali yanitidir.
fn basari_bekle(
    onek: &str,
    mut yanit: ureq::http::Response<ureq::Body>,
) -> Result<ureq::http::Response<ureq::Body>, GatewayHatasi> {
    if yanit.status().is_success() {
        return Ok(yanit);
    }
    let kod = yanit.status().as_u16();
    Err(GatewayHatasi::durumlu(onek, kod, hata_mesaji(&mut yanit)))
}

/// Gateway'in hata govdesindeki `error` metni: maskelenir (token/anahtar izi
/// `[MASKELI]`, dosya yolu `<yol>`), tek satira indirilir ve kisaltilir. Govde JSON
/// degilse, `error` metin degilse ya da `HATA_GOVDE_BAYT`i asarsa `None`.
fn hata_mesaji(yanit: &mut ureq::http::Response<ureq::Body>) -> Option<String> {
    let govde: Value = yanit
        .body_mut()
        .with_config()
        .limit(HATA_GOVDE_BAYT)
        .read_json()
        .ok()?;
    let tek_satir = crate::agent_sessions::maskele(govde.get("error")?.as_str()?)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let temiz = yol_maskele(&tek_satir);
    (!temiz.is_empty()).then(|| crate::agent_sessions::kirp(&temiz, HATA_MESAJ_BAYT))
}

/// Mutlak dosya yollarini (`C:\...`, `C:/...`, `\\sunucu\...`, `/Users/...`,
/// `/home/...`) `<yol>` yapar: gateway metni (dogrulama hatasi, ajan kok dizini)
/// kullanicinin dizinlerini tasiyabilir ve satir panoya, log'a ve buluttaki modele
/// gider. Gateway mesajlari bugun yol tasimaz; bu ikinci sigortadir (bosluk iceren
/// klasor adlarinin devami tam yakalanmaz). Girdi tek bosluklu olmalidir.
fn yol_maskele(metin: &str) -> String {
    metin
        .split(' ')
        .map(|kelime| if yol_gibi(kelime) { "<yol>" } else { kelime })
        .collect::<Vec<_>>()
        .join(" ")
}

fn yol_gibi(kelime: &str) -> bool {
    let k = kelime.trim_start_matches(['(', '"', '\'', '`', '[']);
    let b = k.as_bytes();
    let surucu =
        b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/');
    surucu || k.starts_with("\\\\") || k.starts_with("/Users/") || k.starts_with("/home/")
}

/// Token + alinma ani. Yas `Instant` ile olculur (duvar saati degil): sistem
/// saati degisse de token yasi sacmalamaz.
struct TokenOnbellegi {
    ic: Mutex<Option<(String, Instant)>>,
}

impl TokenOnbellegi {
    fn new() -> Self {
        Self {
            ic: Mutex::new(None),
        }
    }

    /// Taze token'i verir. Yasi esigi gecmis token YOK sayilir (proaktif yenileme).
    fn al(&self, simdi: Instant) -> Option<String> {
        let g = self.ic.lock().ok()?;
        let (token, alindi) = g.as_ref()?;
        let yas = simdi.saturating_duration_since(*alindi);
        (yas < TOKEN_YENILEME_YASI).then(|| token.clone())
    }

    fn koy(&self, token: String, simdi: Instant) {
        if let Ok(mut g) = self.ic.lock() {
            *g = Some((token, simdi));
        }
    }

    /// Reddedilen token'i atar — AMA yalniz hala onbellekteki oysa. Paralel iki
    /// cagri ayni anda 401 alirsa ikincisi, birincinin yeni aldigi gecerli
    /// token'i silmemeli (gereksiz ikinci login + yaris).
    fn gecersiz_say(&self, reddedilen: &str) {
        if let Ok(mut g) = self.ic.lock() {
            if g.as_ref().is_some_and(|(t, _)| t == reddedilen) {
                *g = None;
            }
        }
    }
}

/// Token alir, istegi yapar; 401 gelirse onbellegi temizler, BIR KEZ yeniden
/// login olur ve istegi BIR KEZ tekrarlar. Ikinci 401 ya da baska hata cagirana
/// doner (sonsuz dongu yok).
///
/// Ag, saat ve login enjekte edilir: mantik (ne zaman yenile, ne zaman tekrar
/// dene) birim testte surec/ag acmadan sinanir.
fn yetkili_cagri<T>(
    onbellek: &TokenOnbellegi,
    simdi: impl Fn() -> Instant,
    login: impl FnMut() -> Result<String, GatewayHatasi>,
    path: &str,
    cagri: impl FnMut(&str) -> Result<T, CagriHatasi>,
) -> Result<T, GatewayHatasi> {
    yetkili_cagri_politikasi(onbellek, simdi, login, path, cagri, true)
}

fn yetkili_cagri_politikasi<T>(
    onbellek: &TokenOnbellegi,
    simdi: impl Fn() -> Instant,
    mut login: impl FnMut() -> Result<String, GatewayHatasi>,
    path: &str,
    mut cagri: impl FnMut(&str) -> Result<T, CagriHatasi>,
    hemen_tekrarla: bool,
) -> Result<T, GatewayHatasi> {
    let token = match onbellek.al(simdi()) {
        Some(t) => t,
        None => {
            let t = login()?;
            onbellek.koy(t.clone(), simdi());
            t
        }
    };
    match cagri(&token) {
        Ok(v) => Ok(v),
        Err(CagriHatasi::Diger(e)) => Err(e),
        Err(CagriHatasi::Yetkisiz) => {
            onbellek.gecersiz_say(&token);
            if !hemen_tekrarla {
                return Err(GatewayHatasi::yeni(Some(401), None, "yetkisiz".into()));
            }
            let yeni = login()?;
            onbellek.koy(yeni.clone(), simdi());
            match cagri(&yeni) {
                Ok(v) => Ok(v),
                Err(CagriHatasi::Diger(e)) => Err(e),
                Err(CagriHatasi::Yetkisiz) => Err(GatewayHatasi::yeni(
                    Some(401),
                    None,
                    format!("{path} cagrisi basarisiz: 401 (yeniden login sonrasi da reddedildi)"),
                )),
            }
        }
    }
}

/// GATEWAY HTTP ISTEMCISI — taban URL, token onbellegi ve JSON cagrilari.
///
/// NEDEN AYRI MODUL: bu mantik `audio::live::ToolBridge` icinde dogdu (Live
/// oturumunun hafiza araclari). Mission Control panosu ayni token ve ayni tabana
/// ihtiyac duyunca IKINCI GERCEK KULLANIM cikti ve buraya tasindi. Iki kopya
/// olsaydi ayrisirdi: birinde token onbellegi olur digerinde olmaz, biri
/// `/v1/dev/login` kullanir digeri baska bir yol acar.
///
/// TOKEN'I KENDISI ALIR (`/v1/dev/login`) ve saklar. Sebep tasarimsaldir:
/// masaustunun webview'i kimlik gormez — ne token ne parola. Gateway'e giden
/// her sey Rust tarafindan gecer, dolayisiyla arayuzde sizacak bir sir yoktur.
///
/// TOKEN OMRU: gateway token'i 12 saatte olur ve gateway yeniden baslayinca
/// da gecersizlesir. Eskiden onbellek hic temizlenmiyordu, uzun suren
/// masaustunde Dashboard/Mission KALICI 401 veriyordu. Simdi: yasi 11 saati
/// gecen token istekten once yenilenir; yine de 401 gelirse onbellek temizlenir,
/// bir kez yeniden login olunur ve istek bir kez tekrarlanir.
///
/// Gateway kapaliysa cagri HATA METNIYLE doner, panik atmaz: cagiran (model ya
/// da pano) sebebi kullaniciya gosterir. Sessiz bos sonuc yasak.
///
/// HATA GOVDESI: gateway 4xx/5xx'te `{error: "..."}` doner. O metin (maskeli ve
/// kisaltilmis) hata satirina eklenir; "sebebini oldugu gibi soyle" diyen arac
/// aciklamalari ancak boyle yerine getirilebilir. Yapisal hali `cagri` +
/// `GatewayHatasi` ile alinir (Mission Control koprusu).
pub struct GatewayClient {
    base: String,
    email: String,
    workspace: String,
    token: TokenOnbellegi,
    agent: ureq::Agent,
}

impl GatewayClient {
    pub fn from_env() -> Self {
        Self::with_agent(gateway_agent())
    }

    fn with_agent(agent: ureq::Agent) -> Self {
        Self {
            base: std::env::var("SMITH_GATEWAY_HTTP")
                .unwrap_or_else(|_| "http://127.0.0.1:4100".into()),
            email: std::env::var("SMITH_DEV_EMAIL").unwrap_or_else(|_| "cihan@example.test".into()),
            workspace: std::env::var("SMITH_DEV_WORKSPACE").unwrap_or_default(),
            token: TokenOnbellegi::new(),
            agent,
        }
    }

    /// Kuyruk yazicisinin login ve append adimlari ayni kisa butceyi kullanir.
    pub(crate) fn kayit_yazici() -> Self {
        Self::with_agent(
            ajan_ayari()
                .timeout_global(Some(Duration::from_millis(400)))
                .build()
                .into(),
        )
    }

    /// Yanit govdesi gerekmeyen kalici kuyruk. 401 token'i siler; tekrar
    /// kuyrugun mevcut geri cekilme takviminde yapilir, kapanis butcesi uzamaz.
    pub(crate) fn post_kuyruk(&self, path: &str, body: &Value) -> Result<(), String> {
        yetkili_cagri_politikasi(
            &self.token,
            Instant::now,
            || self.login(),
            path,
            |token| self.gonder(Istek::Post(body), path, token).map(drop),
            false,
        )
        .map_err(|e| e.to_string())
    }

    /// Gecerli bir token verir: onbellekteki taze ise o, degilse yeni login.
    pub fn token(&self) -> Result<String, String> {
        if let Some(t) = self.token.al(Instant::now()) {
            return Ok(t);
        }
        let t = self.login().map_err(|e| e.to_string())?;
        self.token.koy(t.clone(), Instant::now());
        Ok(t)
    }

    fn login(&self) -> Result<String, GatewayHatasi> {
        if self.workspace.is_empty() {
            return Err(GatewayHatasi::iletisim("SMITH_DEV_WORKSPACE tanimli degil"));
        }
        let yanit = self
            .agent
            .post(format!("{}/v1/dev/login", self.base))
            .send_json(serde_json::json!({
                "email": self.email,
                "workspaceId": self.workspace
            }))
            .map_err(|e| GatewayHatasi::iletisim(format!("gateway login hatasi: {e}")))?;
        let resp: Value = basari_bekle("gateway login hatasi", yanit)?
            .body_mut()
            .read_json()
            .map_err(|e| GatewayHatasi::iletisim(format!("gateway login yaniti okunamadi: {e}")))?;
        resp["token"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| GatewayHatasi::iletisim("gateway login token dondurmedi"))
    }

    /// Tek istek yolu: dort fiil (`Istek`) icin ayni token yonetimi, 401'de tek
    /// yeniden deneme ve ayni hata govdesi okuma. Mission Control koprusu hatayi
    /// yapisal alir; `get`/`post`/`delete`/`patch` ayni sonucu metne indirir.
    pub fn cagri(&self, istek: Istek<'_>, path: &str) -> Result<Value, GatewayHatasi> {
        yetkili_cagri(
            &self.token,
            Instant::now,
            || self.login(),
            path,
            |token| {
                let mut yanit = self.gonder(istek, path, token)?;
                govde_oku(path, &mut yanit)
            },
        )
    }

    /// Istegi yollar ve yalniz 2xx yaniti verir. 401 `Yetkisiz` (tedavisi yeniden
    /// login); diger durumlar gateway'in `error` metniyle `Diger`.
    fn gonder(
        &self,
        istek: Istek<'_>,
        path: &str,
        token: &str,
    ) -> Result<ureq::http::Response<ureq::Body>, CagriHatasi> {
        let url = format!("{}{path}", self.base);
        let yetki = format!("Bearer {token}");
        let sonuc = match istek {
            Istek::Get => self.agent.get(&url).header("Authorization", &yetki).call(),
            Istek::Delete => self
                .agent
                .delete(&url)
                .header("Authorization", &yetki)
                .call(),
            Istek::Post(govde) => self
                .agent
                .post(&url)
                .header("Authorization", &yetki)
                .send_json(govde),
            Istek::Patch(govde) => self
                .agent
                .patch(&url)
                .header("Authorization", &yetki)
                .send_json(govde),
        };
        let yanit = sonuc.map_err(|e| tasima_hatasi(path, e))?;
        if yanit.status().as_u16() == 401 {
            return Err(CagriHatasi::Yetkisiz);
        }
        basari_bekle(&format!("{path} cagrisi basarisiz"), yanit).map_err(CagriHatasi::Diger)
    }

    pub fn get(&self, path: &str) -> Result<Value, String> {
        self.cagri(Istek::Get, path).map_err(|e| e.to_string())
    }

    pub fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        self.cagri(Istek::Post(body), path)
            .map_err(|e| e.to_string())
    }

    /// Silme (yalniz Mission Control ajan temizligi). Gateway tarafi bu ucu
    /// KOSULLU tutuyor: kosu gecmisi olan ajan silinmez, 409 doner — yani
    /// "sil" dugmesi muhasebe kaybina yol acamaz.
    pub fn delete(&self, path: &str) -> Result<Value, String> {
        self.cagri(Istek::Delete, path).map_err(|e| e.to_string())
    }

    /// Kismi guncelleme (ajan profili / SOUL duzenleme). Gateway CORS'unda
    /// PATCH acik; POST ile taklit etmek kaynagi yeniden yaratmak olurdu.
    pub fn patch(&self, path: &str, body: &Value) -> Result<Value, String> {
        self.cagri(Istek::Patch(body), path)
            .map_err(|e| e.to_string())
    }
}

/// Bir gateway istegi: fiil + (varsa) govde. Gecersiz bilesimler (govdeli GET,
/// govdesiz POST) kurulamaz.
#[derive(Debug, Clone, Copy)]
pub enum Istek<'a> {
    Get,
    Delete,
    Post(&'a Value),
    Patch(&'a Value),
}

fn govde_oku(
    path: &str,
    resp: &mut ureq::http::Response<ureq::Body>,
) -> Result<Value, CagriHatasi> {
    resp.body_mut().read_json().map_err(|e| {
        CagriHatasi::Diger(GatewayHatasi::iletisim(format!(
            "{path} yaniti okunamadi: {e}"
        )))
    })
}

/// Sureli sahte HTTP sunuculari; gateway, mission ve diger testler ortak kullanir.
///
/// ESKI KALIP (`listener.accept()` + `thread.join()`) istemci hic baglanamazsa
/// SONSUZA DEK takiliyordu: yuklu makinede istemcinin zaman asimi baglanmadan
/// dolabiliyor, kabul bekleyen thread'i kimse uyandirmiyordu (13 dk olculdu).
/// Burada kabul, okuma ve bekleme SINIRLIDIR; `bitir` ya da `drop` thread'i her an
/// durdurur, yani hicbir test sunucu yuzunden takilamaz.
#[cfg(test)]
pub(crate) mod test_sunucu {
    use std::io::{ErrorKind, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    use super::{gateway_agent_with_timeouts, GatewayClient, TokenOnbellegi};

    /// Sunucu thread'inin mutlak omru: `bitir` unutulsa bile thread bu surede olur.
    const EN_UZUN_OMUR: Duration = Duration::from_secs(20);
    /// Bekleyen dongulerin uyanma araligi (durdurma bayragini bu kadar sikligla gorur).
    const BEKLEME_ADIMI: Duration = Duration::from_millis(5);
    /// Bir istegin basligini ve govdesini okumak icin taninan en uzun sure.
    const ISTEK_SINIRI: Duration = Duration::from_secs(2);
    /// `Sessiz` davranista baglantinin acik tutuldugu sure.
    const SESSIZ_BEKLEME: Duration = Duration::from_secs(1);

    /// Sunucunun bir isteGe verdigi karar.
    pub(crate) enum Davranis {
        /// Istegi oku, yanit VERME (baglanti acik kalir): zaman asimi testleri.
        Sessiz,
        Yanit {
            durum: u16,
            govde: String,
        },
    }

    pub(crate) struct Sunucu {
        /// `http://127.0.0.1:PORT`
        pub(crate) taban: String,
        dur: Arc<AtomicBool>,
        kayit: Arc<Mutex<Vec<String>>>,
        is: Option<JoinHandle<()>>,
    }

    impl Sunucu {
        /// `davranis(metod, yol)` her kabul edilen istek icin cagrilir.
        pub(crate) fn baslat(davranis: impl Fn(&str, &str) -> Davranis + Send + 'static) -> Self {
            let dinleyici = TcpListener::bind("127.0.0.1:0").expect("test dinleyicisi");
            let taban = format!("http://{}", dinleyici.local_addr().expect("adres"));
            dinleyici
                .set_nonblocking(true)
                .expect("bloklamayan dinleyici");
            let dur = Arc::new(AtomicBool::new(false));
            let kayit = Arc::new(Mutex::new(Vec::new()));
            let is = {
                let (dur, kayit) = (dur.clone(), kayit.clone());
                std::thread::spawn(move || dongu(&dinleyici, &davranis, &dur, &kayit))
            };
            Self {
                taban,
                dur,
                kayit,
                is: Some(is),
            }
        }

        /// Thread'i durdurur ve kabul ettigi istekleri ("METOD yol") sirayla verir.
        pub(crate) fn bitir(mut self) -> Vec<String> {
            self.durdur();
            self.kayit.lock().map(|k| k.clone()).unwrap_or_default()
        }

        fn durdur(&mut self) {
            self.dur.store(true, Ordering::Release);
            if let Some(is) = self.is.take() {
                let _ = is.join();
            }
        }
    }

    impl Drop for Sunucu {
        fn drop(&mut self) {
            self.durdur();
        }
    }

    /// Sahte sunucuya bakan istemci; `sure` baglanti, toplam ve okuma zaman asimidir.
    pub(crate) fn istemci(taban: &str, sure: Duration) -> GatewayClient {
        GatewayClient {
            base: taban.to_string(),
            email: "test@example.test".into(),
            workspace: "test-workspace".into(),
            token: TokenOnbellegi::new(),
            agent: gateway_agent_with_timeouts(sure, sure, sure),
        }
    }

    /// Gercek gateway gibi: login'e `{"token": ...}` verir, baska her yola sabit
    /// `(durum, govde)` doner.
    pub(crate) fn gateway_gibi(
        durum: u16,
        govde: &str,
    ) -> impl Fn(&str, &str) -> Davranis + Send + 'static {
        let govde = govde.to_string();
        move |_, yol| {
            if yol.ends_with("/v1/dev/login") {
                Davranis::Yanit {
                    durum: 200,
                    govde: r#"{"token":"tok-test"}"#.into(),
                }
            } else {
                Davranis::Yanit {
                    durum,
                    govde: govde.clone(),
                }
            }
        }
    }

    fn dongu(
        dinleyici: &TcpListener,
        davranis: &impl Fn(&str, &str) -> Davranis,
        dur: &AtomicBool,
        kayit: &Mutex<Vec<String>>,
    ) {
        let son = Instant::now() + EN_UZUN_OMUR;
        while !dur.load(Ordering::Acquire) && Instant::now() < son {
            match dinleyici.accept() {
                Ok((akim, _)) => {
                    let _ = baglanti(akim, davranis, dur, kayit);
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => std::thread::sleep(BEKLEME_ADIMI),
                Err(_) => return,
            }
        }
    }

    fn baglanti(
        mut akim: TcpStream,
        davranis: &impl Fn(&str, &str) -> Davranis,
        dur: &AtomicBool,
        kayit: &Mutex<Vec<String>>,
    ) -> std::io::Result<()> {
        // Windows'ta kabul edilen soket dinleyicinin bloklamayan kipini miras alir.
        akim.set_nonblocking(false)?;
        akim.set_read_timeout(Some(BEKLEME_ADIMI * 10))?;
        let Some((metod, yol)) = istegi_oku(&mut akim, dur)? else {
            return Ok(());
        };
        if let Ok(mut k) = kayit.lock() {
            k.push(format!("{metod} {yol}"));
        }
        match davranis(&metod, &yol) {
            Davranis::Sessiz => {
                let son = Instant::now() + SESSIZ_BEKLEME;
                while !dur.load(Ordering::Acquire) && Instant::now() < son {
                    std::thread::sleep(BEKLEME_ADIMI);
                }
            }
            Davranis::Yanit { durum, govde } => {
                write!(
                    akim,
                    "HTTP/1.1 {durum} Test\r\nContent-Type: application/json\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n{govde}",
                    govde.len()
                )?;
                akim.flush()?;
            }
        }
        Ok(())
    }

    /// Istek basligini ve govdesini tuketir; `(metod, yol)` verir. Durdurma bayragi,
    /// `ISTEK_SINIRI` ya da erken kapanma `None` demektir. Govdeyi tuketmek sart:
    /// okunmamis veriyle kapanan soket RST yollar ve istemci yaniti okuyamadan
    /// "baglanti sifirlandi" gorur.
    fn istegi_oku(
        akim: &mut TcpStream,
        dur: &AtomicBool,
    ) -> std::io::Result<Option<(String, String)>> {
        let son = Instant::now() + ISTEK_SINIRI;
        let mut alinan: Vec<u8> = Vec::new();
        let baslik_sonu = loop {
            if let Some(i) = alinan.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
            if !oku_biraz(akim, &mut alinan, dur, son)? {
                return Ok(None);
            }
        };
        let baslik = String::from_utf8_lossy(&alinan[..baslik_sonu]).into_owned();
        let mut satirlar = baslik.lines();
        let mut ilk = satirlar.next().unwrap_or_default().split_whitespace();
        let metod = ilk.next().unwrap_or_default().to_string();
        let yol = ilk.next().unwrap_or_default().to_string();
        let uzunluk: usize = satirlar
            .filter_map(|satir| satir.split_once(':'))
            .find(|(ad, _)| ad.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, deger)| deger.trim().parse().ok())
            .unwrap_or(0);
        while alinan.len() < baslik_sonu + uzunluk {
            if !oku_biraz(akim, &mut alinan, dur, son)? {
                return Ok(None);
            }
        }
        Ok(Some((metod, yol)))
    }

    /// Soketten bir parca okur. `false`: durma zamani (bayrak, son tarih, EOF).
    fn oku_biraz(
        akim: &mut TcpStream,
        alinan: &mut Vec<u8>,
        dur: &AtomicBool,
        son: Instant,
    ) -> std::io::Result<bool> {
        if dur.load(Ordering::Acquire) || Instant::now() >= son {
            return Ok(false);
        }
        let mut parca = [0u8; 2048];
        match akim.read(&mut parca) {
            Ok(0) => Ok(false),
            Ok(n) => {
                alinan.extend_from_slice(&parca[..n]);
                Ok(true)
            }
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => Ok(true),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_sunucu::{gateway_gibi, istemci, Davranis, Sunucu};
    use super::*;
    use serde_json::json;
    use std::cell::{Cell, RefCell};
    use std::net::TcpStream;

    /// Gateway'in gercek 409 sebep metni bicimi (`routes/mission.ts`).
    const GOREV_RED: &str =
        "Gecersiz gorev gecisi: review -> assigned. Izin verilenler: in_progress, blocked";

    fn iletisim_hatasi(metin: &str) -> CagriHatasi {
        CagriHatasi::Diger(GatewayHatasi::iletisim(metin))
    }

    #[test]
    fn kuyruk_401_sonraki_deneme_icin_tokeni_siler_hemen_tekrarlamaz() {
        let cache = TokenOnbellegi::new();
        cache.koy("eski".into(), Instant::now());
        let calls = Cell::new(0);
        let logins = Cell::new(0);
        let result: Result<(), GatewayHatasi> = yetkili_cagri_politikasi(
            &cache,
            Instant::now,
            || {
                logins.set(logins.get() + 1);
                Ok("yeni".into())
            },
            "/append",
            |_| {
                calls.set(calls.get() + 1);
                Err(CagriHatasi::Yetkisiz)
            },
            false,
        );
        assert_eq!(result.map_err(|e| e.to_string()), Err("yetkisiz".into()));
        assert_eq!(calls.get(), 1);
        assert_eq!(logins.get(), 0);
        assert!(cache.al(Instant::now()).is_none());
        let result = yetkili_cagri_politikasi(
            &cache,
            Instant::now,
            || {
                logins.set(logins.get() + 1);
                Ok("yeni".into())
            },
            "/append",
            |token| Ok(token.to_owned()),
            false,
        );
        assert_eq!(result, Ok("yeni".into()));
        assert_eq!(logins.get(), 1);
    }

    /// Gateway token omru (sunucu sozlesmesi).
    const TOKEN_OMRU: Duration = Duration::from_secs(12 * 3600);

    #[test]
    fn yanit_vermeyen_gateway_cagrisi_sinirli_surede_doner() {
        let sunucu = Sunucu::baslat(|_, _| Davranis::Sessiz);
        let client = istemci(&sunucu.taban, Duration::from_millis(100));

        let started = Instant::now();
        let result = client.token();
        let elapsed = started.elapsed();
        assert!(result.is_err(), "yanitsiz sunucu basarili sayilmamali");
        assert!(
            elapsed < Duration::from_millis(500),
            "gateway timeout uygulanmadi: {elapsed:?}"
        );
        sunucu.bitir();
    }

    /// ESKI kalibin arizasi: istemci HIC baglanmaz (yuklu makinede zaman asimi
    /// baglantidan once dolar). `accept()` + `join()` burada sonsuza dek takilirdi.
    #[test]
    fn sahte_sunucu_istemci_hic_baglanmasa_da_takilmadan_biter() {
        let sunucu = Sunucu::baslat(|_, _| Davranis::Sessiz);
        let basladi = Instant::now();
        let istekler = sunucu.bitir();
        assert!(istekler.is_empty());
        assert!(
            basladi.elapsed() < Duration::from_secs(2),
            "sunucu thread'i kapanmadi: {:?}",
            basladi.elapsed()
        );
    }

    /// Istemci baglanip hicbir sey gondermezse de (okuma bekleyen thread) kapanir.
    #[test]
    fn sahte_sunucu_susan_istemciyle_de_takilmadan_biter() {
        let sunucu = Sunucu::baslat(|_, _| Davranis::Sessiz);
        let adres = sunucu.taban.trim_start_matches("http://").to_string();
        let _susan = TcpStream::connect(adres).expect("baglanti");
        let basladi = Instant::now();
        sunucu.bitir();
        assert!(
            basladi.elapsed() < Duration::from_secs(2),
            "sunucu thread'i kapanmadi: {:?}",
            basladi.elapsed()
        );
    }

    /// Sahte saat: gercek `Instant` + ofset (Windows'ta `Instant::now() - 12h`
    /// acilistan beri gecen sure kisaysa tasar; ileri ekleme her zaman guvenli).
    struct Saat {
        taban: Instant,
        ofset: Cell<Duration>,
    }
    impl Saat {
        fn new() -> Self {
            Self {
                taban: Instant::now(),
                ofset: Cell::new(Duration::ZERO),
            }
        }
        fn simdi(&self) -> Instant {
            self.taban + self.ofset.get()
        }
        fn ilerle(&self, d: Duration) {
            self.ofset.set(self.ofset.get() + d);
        }
    }

    /// Her cagrida bir sonraki token'i veren sahte login.
    fn login_sayaci(sayac: &Cell<u32>) -> impl FnMut() -> Result<String, GatewayHatasi> + '_ {
        move || {
            sayac.set(sayac.get() + 1);
            Ok(format!("tok-{}", sayac.get()))
        }
    }

    #[test]
    fn taze_token_yeniden_kullanilir_login_tekrarlanmaz() {
        let saat = Saat::new();
        let ob = TokenOnbellegi::new();
        let login = Cell::new(0);
        let mut login_fn = login_sayaci(&login);
        for _ in 0..3 {
            let r = yetkili_cagri(
                &ob,
                || saat.simdi(),
                &mut login_fn,
                "/x",
                |t| Ok::<_, CagriHatasi>(t.to_string()),
            );
            assert_eq!(r.as_deref(), Ok("tok-1"));
        }
        assert_eq!(login.get(), 1, "taze token varken tekrar login olunmus");
    }

    /// 401 -> onbellek temizlenir, bir kez yeniden login, istek bir kez tekrar.
    #[test]
    fn yetkisiz_gelince_yeniden_login_olur_ve_istegi_tekrarlar() {
        let saat = Saat::new();
        let ob = TokenOnbellegi::new();
        ob.koy("eski".into(), saat.simdi());
        let login = Cell::new(0);
        let gorulen = RefCell::new(Vec::<String>::new());
        let r = yetkili_cagri(
            &ob,
            || saat.simdi(),
            login_sayaci(&login),
            "/x",
            |t| {
                gorulen.borrow_mut().push(t.to_string());
                if t == "eski" {
                    Err(CagriHatasi::Yetkisiz)
                } else {
                    Ok("tamam")
                }
            },
        );
        assert_eq!(r, Ok("tamam"));
        assert_eq!(*gorulen.borrow(), vec!["eski", "tok-1"]);
        assert_eq!(login.get(), 1);
        // Yeni token onbellekte: sonraki cagri login olmaz.
        assert_eq!(ob.al(saat.simdi()).as_deref(), Some("tok-1"));
    }

    /// Ikinci 401 cagirana doner: sonsuz login/istek dongusu yok.
    #[test]
    fn ikinci_yetkisiz_hata_olarak_doner_ve_en_fazla_bir_tekrar_yapilir() {
        let saat = Saat::new();
        let ob = TokenOnbellegi::new();
        let login = Cell::new(0);
        let cagri = Cell::new(0);
        let r: Result<(), GatewayHatasi> = yetkili_cagri(
            &ob,
            || saat.simdi(),
            login_sayaci(&login),
            "/gizli",
            |_| {
                cagri.set(cagri.get() + 1);
                Err(CagriHatasi::Yetkisiz)
            },
        );
        let hata = r.expect_err("ikinci 401 hata olmali");
        assert_eq!(hata.durum, Some(401));
        let metin = hata.to_string();
        assert!(metin.contains("/gizli") && metin.contains("401"), "{metin}");
        assert_eq!(cagri.get(), 2, "istek tam bir kez tekrarlanmali");
        assert_eq!(login.get(), 2, "ilk login + tek yeniden login");
    }

    /// 401 disi hatada (ag, 5xx, 409) login/tekrar YOK: yeni token bunu cozmez.
    #[test]
    fn diger_hatalar_tekrarlanmaz_ve_token_silinmez() {
        let saat = Saat::new();
        let ob = TokenOnbellegi::new();
        let login = Cell::new(0);
        let cagri = Cell::new(0);
        let r: Result<(), GatewayHatasi> = yetkili_cagri(
            &ob,
            || saat.simdi(),
            login_sayaci(&login),
            "/x",
            |_| {
                cagri.set(cagri.get() + 1);
                Err(iletisim_hatasi("/x cagrisi basarisiz: 409"))
            },
        );
        assert_eq!(r, Err(GatewayHatasi::iletisim("/x cagrisi basarisiz: 409")));
        assert_eq!(cagri.get(), 1);
        assert_eq!(login.get(), 1);
        assert_eq!(ob.al(saat.simdi()).as_deref(), Some("tok-1"));
    }

    /// Yenileme login'i basarisizsa istek HIC tekrarlanmaz, login hatasi doner.
    #[test]
    fn yeniden_login_basarisizsa_login_hatasi_doner() {
        let saat = Saat::new();
        let ob = TokenOnbellegi::new();
        ob.koy("eski".into(), saat.simdi());
        let cagri = Cell::new(0);
        let r: Result<(), GatewayHatasi> = yetkili_cagri(
            &ob,
            || saat.simdi(),
            || {
                Err(GatewayHatasi::iletisim(
                    "gateway login hatasi: baglanti reddedildi",
                ))
            },
            "/x",
            |_| {
                cagri.set(cagri.get() + 1);
                Err(CagriHatasi::Yetkisiz)
            },
        );
        assert_eq!(
            r,
            Err(GatewayHatasi::iletisim(
                "gateway login hatasi: baglanti reddedildi"
            ))
        );
        assert_eq!(cagri.get(), 1);
    }

    /// Yasi 11 saati geciren token istekten ONCE yenilenir (401 beklenmez).
    #[test]
    fn yasli_token_proaktif_yenilenir() {
        let saat = Saat::new();
        let ob = TokenOnbellegi::new();
        let login = Cell::new(0);
        let mut login_fn = login_sayaci(&login);
        let mut al = || {
            yetkili_cagri(
                &ob,
                || saat.simdi(),
                &mut login_fn,
                "/x",
                |t| Ok::<_, CagriHatasi>(t.to_string()),
            )
        };
        assert_eq!(al().as_deref(), Ok("tok-1"));

        // 10 sa 59 dk: hala taze. (Sabit DEGIL literal: sozlesme "11 saat";
        // esigi kaydiran bir degisiklik bu testi sessizce izlememeli.)
        saat.ilerle(Duration::from_secs(11 * 3600 - 60));
        assert_eq!(al().as_deref(), Ok("tok-1"));

        // 11 saati gecti: yenilenir, istek YENI token ile gider.
        saat.ilerle(Duration::from_secs(120));
        assert_eq!(al().as_deref(), Ok("tok-2"));
        assert_eq!(login.get(), 2);
    }

    #[test]
    fn yenileme_esigi_token_omrunden_kisa() {
        assert!(
            TOKEN_YENILEME_YASI < TOKEN_OMRU,
            "yenileme token olmeden once olmali"
        );
    }

    /// Paralel iki cagri ayni eski token ile 401 alirsa, ikincisi birincinin
    /// aldigi YENI token'i silmemeli.
    #[test]
    fn gecersiz_say_yalniz_reddedilen_token_hala_duruyorsa_siler() {
        let saat = Saat::new();
        let ob = TokenOnbellegi::new();
        ob.koy("yeni".into(), saat.simdi());
        ob.gecersiz_say("eski"); // baska bir cagri zaten yeniledi
        assert_eq!(ob.al(saat.simdi()).as_deref(), Some("yeni"));
        ob.gecersiz_say("yeni");
        assert_eq!(ob.al(saat.simdi()), None);
    }

    fn login_sayisi(istekler: &[String]) -> usize {
        istekler
            .iter()
            .filter(|i| i.ends_with("/v1/dev/login"))
            .count()
    }

    /// Wire eslemesi: yalniz 401 yetki hatasi sayilir (yeniden login tetikler).
    /// 403 yetki YETERSIZLIGIDIR, yeni token cozmez.
    #[test]
    fn yalniz_401_yetkisiz_sayilir() {
        for kod in [403u16, 404, 409, 500] {
            let sunucu = Sunucu::baslat(gateway_gibi(kod, "{}"));
            let hata = istemci(&sunucu.taban, Duration::from_secs(5))
                .cagri(Istek::Get, "/x")
                .expect_err("4xx/5xx hata olmali");
            assert_eq!(hata.durum, Some(kod));
            assert!(hata.to_string().contains("/x"), "{hata}");
            let istekler = sunucu.bitir();
            assert_eq!(login_sayisi(&istekler), 1, "{kod} yeniden login yapti");
        }

        let sunucu = Sunucu::baslat(gateway_gibi(401, r#"{"error":"yetkisiz"}"#));
        let hata = istemci(&sunucu.taban, Duration::from_secs(5))
            .cagri(Istek::Get, "/x")
            .expect_err("kalici 401 hata olmali");
        assert_eq!(hata.durum, Some(401));
        assert!(
            hata.to_string()
                .contains("401 (yeniden login sonrasi da reddedildi)"),
            "{hata}"
        );
        let istekler = sunucu.bitir();
        assert_eq!(login_sayisi(&istekler), 2, "401: ilk login + tek yenileme");
    }

    /// 4xx govdesindeki `error` metni dort fiilin hepsinde hataya girer: arac
    /// aciklamalarindaki "sebebini oldugu gibi soyle" ancak boyle yerine gelir.
    #[test]
    fn gateway_4xx_sebebi_dort_fiilde_de_hataya_eklenir() {
        let sunucu = Sunucu::baslat(gateway_gibi(
            409,
            &json!({ "error": GOREV_RED }).to_string(),
        ));
        let client = istemci(&sunucu.taban, Duration::from_secs(5));
        let govde = json!({ "status": "assigned" });
        let sonuclar = [
            ("GET", client.get("/v1/mission/tasks/t1")),
            ("POST", client.post("/v1/mission/tasks/t1/status", &govde)),
            ("PATCH", client.patch("/v1/mission/agents/a1", &govde)),
            ("DELETE", client.delete("/v1/mission/agents/a1")),
        ];
        for (fiil, sonuc) in sonuclar {
            let hata = sonuc.expect_err(fiil);
            assert!(hata.contains("http status: 409"), "{fiil}: {hata}");
            assert!(hata.contains(GOREV_RED), "{fiil}: sebep kayboldu: {hata}");
        }
        let istekler = sunucu.bitir();
        assert_eq!(login_sayisi(&istekler), 1, "409 yeniden login tetikledi");
    }

    #[test]
    fn yapisal_hata_durumu_ve_sebebi_ayri_alanlarda_tasir() {
        let sunucu = Sunucu::baslat(gateway_gibi(
            409,
            &json!({ "error": GOREV_RED }).to_string(),
        ));
        let hata = istemci(&sunucu.taban, Duration::from_secs(5))
            .cagri(Istek::Post(&json!({})), "/v1/mission/tasks/t1/status")
            .expect_err("409 hata olmali");
        assert_eq!(hata.durum, Some(409));
        assert_eq!(hata.mesaj.as_deref(), Some(GOREV_RED));
        assert_eq!(
            hata.to_string(),
            format!(
                "/v1/mission/tasks/t1/status cagrisi basarisiz: http status: 409 ({GOREV_RED})"
            )
        );
    }

    /// Govde JSON degilse (araya giren proxy'nin HTML'i) sebep UYDURULMAZ; durum kalir.
    #[test]
    fn json_olmayan_hata_govdesi_durumu_korur_sebep_uydurmaz() {
        let sunucu = Sunucu::baslat(gateway_gibi(502, "<html>bad gateway</html>"));
        let hata = istemci(&sunucu.taban, Duration::from_secs(5))
            .cagri(Istek::Get, "/v1/mission/board")
            .expect_err("502 hata olmali");
        assert_eq!(hata.durum, Some(502));
        assert_eq!(hata.mesaj, None);
        assert_eq!(
            hata.to_string(),
            "/v1/mission/board cagrisi basarisiz: http status: 502"
        );
    }

    /// Sebep metni modele ve panoya gider: anahtar maskelenir, tek satira iner, kisalir.
    #[test]
    fn gateway_sebebi_maskelenir_tek_satira_iner_ve_kisaltilir() {
        // Sahte anahtar calisma aninda birlestirilir (scan-secrets kaynakta gormesin).
        let sir = format!("{}{}", "sk-", "proj-abcdefghijklmnop1234");
        let uzun = "a".repeat(HATA_MESAJ_BAYT * 2);
        let govde = json!({ "error": format!("token={sir}\nikinci   satir {uzun}") }).to_string();
        let sunucu = Sunucu::baslat(gateway_gibi(400, &govde));
        let hata = istemci(&sunucu.taban, Duration::from_secs(5))
            .cagri(Istek::Get, "/x")
            .expect_err("400 hata olmali");
        let mesaj = hata.mesaj.clone().expect("sebep");
        assert!(!mesaj.contains(&sir), "anahtar sizdi: {mesaj}");
        assert!(!hata.to_string().contains(&sir), "anahtar sizdi: {hata}");
        assert!(!mesaj.contains('\n'), "{mesaj:?}");
        assert!(mesaj.starts_with("token=[MASKELI] ikinci satir"), "{mesaj}");
        assert!(mesaj.len() <= HATA_MESAJ_BAYT, "{} bayt", mesaj.len());
        assert!(mesaj.ends_with("..."), "{mesaj}");
    }

    /// Gateway metni dosya yolu tasirsa (dogrulama hatasi, ajan kok dizini) `<yol>` olur;
    /// API yolu ve URL'ye dokunulmaz.
    #[test]
    fn gateway_sebebi_dosya_yollarini_maskeler() {
        let ham = r#"Kok gecersiz: C:\Users\biri\proje D:/is/x (\\sunucu\paylasim\a) /home/biri/kod /Users/biri/k ve /v1/mission/tasks https://ornek.test/a guvenli"#;
        let sunucu = Sunucu::baslat(gateway_gibi(400, &json!({ "error": ham }).to_string()));
        let hata = istemci(&sunucu.taban, Duration::from_secs(5))
            .cagri(Istek::Get, "/x")
            .expect_err("400 hata olmali");
        assert_eq!(
            hata.mesaj.as_deref(),
            Some("Kok gecersiz: <yol> <yol> <yol> <yol> <yol> ve /v1/mission/tasks https://ornek.test/a guvenli")
        );
        assert!(!hata.to_string().contains("biri"), "{hata}");
    }

    #[test]
    fn yol_benzeri_olmayan_kelimeler_maskelenmez() {
        for kelime in [
            "C:",
            "C:x",
            "a:b/c",
            "http://x",
            "/v1/mission/board",
            "Users/biri",
            "a\\b",
        ] {
            assert!(!yol_gibi(kelime), "yol sanildi: {kelime}");
        }
        for kelime in [
            "C:\\a", "c:/a", "\\\\s\\p", "/Users/x", "/home/x", "(C:\\a)", "\"D:/a\"",
        ] {
            assert!(yol_gibi(kelime), "yol sanilmadi: {kelime}");
        }
    }

    #[test]
    fn login_reddi_gateway_sebebini_tasir() {
        let sunucu = Sunucu::baslat(|_, _| Davranis::Yanit {
            durum: 403,
            govde: r#"{"error":"dev login yalniz yerel gelistirme icindir"}"#.into(),
        });
        let hata = istemci(&sunucu.taban, Duration::from_secs(5))
            .token()
            .expect_err("403 login hatasi olmali");
        assert_eq!(
            hata,
            "gateway login hatasi: http status: 403 (dev login yalniz yerel gelistirme icindir)"
        );
    }

    #[test]
    fn kuyruk_yazimi_4xx_sebebini_tasir() {
        let sunucu = Sunucu::baslat(gateway_gibi(400, r#"{"error":"text bos olamaz"}"#));
        let hata = istemci(&sunucu.taban, Duration::from_secs(5))
            .post_kuyruk("/v1/tools/conversation/append", &json!({}))
            .expect_err("400 hata olmali");
        assert!(
            hata.contains("http status: 400 (text bos olamaz)"),
            "{hata}"
        );
    }
}
