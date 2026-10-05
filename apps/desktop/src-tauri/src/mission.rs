use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::agent_sessions::maskele;
use crate::gateway::{GatewayClient, GatewayHatasi, Istek};

/// MISSION CONTROL PENCERESI VE KOPRUSU (ADR 0007).
///
/// Pano ayri bir pencerede yasar: pet penceresi (main) cercevesiz, seffaf,
/// ustte ve 420x520; buna kanban sigmaz. Ayrica pet penceresinin seffafligi
/// CALISMA ANINDA acilamaz (tauri.conf.json'da sabit), yani ayni pencereyi iki
/// mod arasinda gezdirmek mumkun degil — pano kendi penceresini alir.
///
/// Frontend AYRI GIRIS NOKTASINDAN yuklenir (`mission.html`): pet penceresinin
/// CSS'i seffaflik icin ayarlidir (`face.css overflow:hidden`, gecirgen govde)
/// ve panonun opak yerlesimiyle karisirsa iki pencerenin biri bozulur.
///
/// KOPRU TASARIMI: webview kimlik gormez. Pano `mission_call` ile Rust'a
/// soyler, Rust token'i `GatewayClient`ten alip cagirir. Boylece pano
/// kodunda token, parola veya workspace bilgisi HIC bulunmaz.
pub const MISSION_LABEL: &str = "mission";

const BOOT_WATCHDOG: std::time::Duration = std::time::Duration::from_secs(45);

static OPENING: AtomicBool = AtomicBool::new(false);

/// One owner performs lookup, teardown, build and focus. Concurrent requests
/// join that opening implicitly: the owner brings the completed window forward.
/// Callers must never touch a partially registered webview.
struct OpeningGuard<'a>(&'a AtomicBool);

impl<'a> OpeningGuard<'a> {
    fn acquire(opening: &'a AtomicBool) -> Option<Self> {
        opening
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .ok()
            .map(|_| Self(opening))
    }
}

impl Drop for OpeningGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// `destroy` queues an event. Do not reuse the label until Tauri has removed
/// its old registration; on timeout, fail instead of creating a duplicate.
async fn destroy_mission(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(MISSION_LABEL) {
        win.destroy()
            .map_err(|e| format!("pano penceresi yok edilemedi: {e}"))?;
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while app.get_webview_window(MISSION_LABEL).is_some() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| "pano penceresinin kapanmasi zaman asimina ugradi".to_string())?;
    }
    Ok(())
}

/// Panelin cagirabilecegi yollar. `/v1/mission/*`, hafiza okuma uclari ve
/// Dashboard'daki acik soru akisi. Genel hafiza yazma ucu kapali kalir:
/// `/v1/tools/memory/remember` bu kapidan GECEMEZ.
const ALLOWED_PREFIXES: &[&str] = &[
    "/v1/mission/",
    "/v1/tools/memory/search",
    "/v1/tools/memory/list",
];

fn hafiza_boslugu_yolu(method: &str, raw_path: &str) -> bool {
    if method == "GET" {
        return raw_path == "/v1/memory/gaps";
    }
    if method != "POST" {
        return false;
    }
    let Some(kalan) = raw_path.strip_prefix("/v1/memory/gaps/") else {
        return false;
    };
    let Some((id, eylem)) = kalan.split_once('/') else {
        return false;
    };
    let Some(govde) = id.strip_prefix("gap_") else {
        return false;
    };
    (20..=32).contains(&govde.len())
        && govde
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && matches!(eylem, "answer" | "dismiss")
}

fn client() -> &'static GatewayClient {
    static CLIENT: OnceLock<GatewayClient> = OnceLock::new();
    CLIENT.get_or_init(GatewayClient::from_env)
}

/// Pencereden gelen yol/metod ciftini dogrular.
///
/// NEDEN GENEL BIR KOMUT + KAPI, DOKUZ AYRI KOMUT YERINE: pano REST bicimini
/// zaten biliyor; her uc icin bir Tauri komutu yazmak ayni sozlesmeyi iki kez
/// (Rust + TS) tanimlamak ve her yeni uc icin Rust'a dokunmak demekti. Ama
/// "webview'den herhangi bir gateway yolunu cagir" da kabul edilemez: bu kapi
/// yuzeyi `/v1/mission/*` + izinli hafiza uclari ile sinirlar. Auth uclari ve
/// sistem araclari bu komuttan ERISILEMEZ; genel hafiza yazma ucu kapalidir.
///
/// Yol gezinmesi (`..`) ve sema/host enjeksiyonu (`//`, `http`) reddedilir:
/// `/v1/mission/../tools/memory/search` on eki gecerdi ama baska bir ucu
/// cagirirdi.
///
/// Ham metin kontrolu tek basina yetmez: `/v1/mission/%2e%2e/tools/memory/remember`
/// ham on eki gecer, ama URL ayristirici yolu `/v1/tools/memory/remember` yapar.
/// Bu yuzden yol once ayristirilir; normalizasyon girdiyi DEGISTIRIYORSA
/// (`..`, `.`, ters bolu, host kaymasi, parca) ya da yuzde kodlamasi varsa
/// reddedilir. Sorgu dizesi (`?limit=60`) kodlu olabilir; yalniz yol denetlenir.
pub fn gate(method: &str, path: &str) -> Result<(), String> {
    let raw_path = path.split('?').next().unwrap_or(path);
    let url = tauri::Url::parse(&format!("http://smith.invalid{path}"))
        .map_err(|_| "gecersiz yol".to_string())?;
    if url.host_str() != Some("smith.invalid")
        || url.path() != raw_path
        || url.fragment().is_some()
        || raw_path.contains(['%', '\\'])
    {
        return Err("normalize edilen veya kodlanmis yol reddedildi".into());
    }
    let m = method.to_ascii_uppercase();
    // DELETE 2026-08-21'de eklendi: panonun ajan temizligi icin. Yikici gorunse
    // de gateway tarafi KOSULLU (kosu gecmisi olan ajan silinemez, 409) ve yol
    // on eki yine `/v1/mission/*` ile sinirli. PUT hala yok: guncelleme PATCH
    // ile yapiliyor, ikinci bir yazma metodu ikinci bir yol demek.
    if !matches!(m.as_str(), "GET" | "POST" | "PATCH" | "DELETE") {
        return Err(format!("izin verilmeyen metod: {method}"));
    }
    // On ek eslesmesi: mission icin alt yollar serbest; hafiza uclari TAM
    // yol (veya `?sorgu`) olmali — `/v1/tools/memory/searchXYZ` gecemez.
    let izinli = ALLOWED_PREFIXES.iter().any(|prefix| {
        path.starts_with(prefix)
            && (prefix.ends_with('/')
                || path.len() == prefix.len()
                || path.as_bytes().get(prefix.len()) == Some(&b'?'))
    }) || hafiza_boslugu_yolu(&m, raw_path);
    if !izinli {
        return Err(format!("izin verilmeyen yol: {path}"));
    }
    if path.contains("..") || path.contains("//") {
        return Err(format!("supheli yol: {path}"));
    }
    Ok(())
}

/// `mission_call` hata sinifi. Kapali bir liste: pano ham metin eslestirmez, sinifi
/// okur. Tel degerleri arayuzdeki `MissionErrorCode` ile AYNIDIR (kebab-case); bir
/// sinif eklenirse `apps/desktop/src/mission/api.ts` da guncellenir.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MissionKodu {
    NotFound,
    Conflict,
    Validation,
    Unauthorized,
    Unavailable,
    Unknown,
}

impl MissionKodu {
    /// Gateway'in HTTP durumundan sinif. Durum yoksa gateway'e ulasilamamistir.
    fn durumdan(durum: Option<u16>) -> Self {
        match durum {
            None => Self::Unavailable,
            Some(404) => Self::NotFound,
            Some(409) => Self::Conflict,
            Some(400 | 422) => Self::Validation,
            Some(401 | 403) => Self::Unauthorized,
            Some(_) => Self::Unknown,
        }
    }

    /// Gateway sebep vermediginde kullanilan genel ve sabit metin.
    fn varsayilan_mesaj(self) -> &'static str {
        match self {
            Self::NotFound => "kayit bulunamadi",
            Self::Conflict => "islem mevcut durumla celisiyor",
            Self::Validation => "gecersiz istek",
            Self::Unauthorized => "oturum dogrulanamadi",
            Self::Unavailable => "gateway'e ulasilamadi",
            Self::Unknown => "beklenmeyen hata",
        }
    }
}

/// Webview'in `mission_call` hatasi olarak gordugu YAPISAL deger.
///
/// Eskiden ham `String` donuyordu; arayuz bu metni "404/409/gateway/timeout" alt
/// dizgilerinden siniflandiriyordu ve metin degisince sinif sessizce kayiyordu.
/// Simdi sinif Rust'ta durumdan turetilir ve arayuz `code`/`status` okur.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MissionHatasi {
    code: MissionKodu,
    /// Gateway yanit verdiyse HTTP durumu; ag/oturum hatalarinda `null`.
    status: Option<u16>,
    /// Maskeli ve kisa sebep: gateway'in `error` metni ya da sinifin sabit metni.
    /// Istek yolu, token ve ag ayrintisi (host, port, OS hatasi) ASLA girmez.
    message: String,
}

impl MissionHatasi {
    fn gatewayden(hata: &GatewayHatasi) -> Self {
        let code = MissionKodu::durumdan(hata.durum);
        Self {
            code,
            status: hata.durum,
            message: hata
                .mesaj
                .clone()
                .unwrap_or_else(|| code.varsayilan_mesaj().to_string()),
        }
    }

    /// Kapidan gecmeyen istek: panonun kendi hatasi, gateway'e hic gitmedi.
    fn reddedildi() -> Self {
        Self {
            code: MissionKodu::Unknown,
            status: None,
            message: "istek kapidan gecmedi".to_string(),
        }
    }
}

/// Panonun gateway cagrisi. Sonuc JSON olarak aynen doner; hata YAPISAL doner
/// (`MissionHatasi`) ve pano sinifa gore kullaniciya mesaj gosterir (sessiz bos
/// ekran yok). Ham ayrinti maskelenip Rust log'una yazilir, webview'e gitmez.
#[tauri::command]
pub fn mission_call(
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, MissionHatasi> {
    mission_cagir(client(), &method, &path, body)
}

/// `mission_call`in govdesi: kapi, gateway cagrisi ve hata sinifi. Gateway
/// istemcisi enjekte edilir; testler gercek gateway'siz sahte sunucuyla sinanir.
fn mission_cagir(
    gw: &GatewayClient,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, MissionHatasi> {
    if let Err(neden) = gate(method, path) {
        eprintln!("[mission] istek kapidan gecmedi: {}", maskele(&neden));
        return Err(MissionHatasi::reddedildi());
    }
    let fiil = method.to_ascii_uppercase();
    let govde = body.unwrap_or_else(|| serde_json::json!({}));
    let istek = match fiil.as_str() {
        "GET" => Istek::Get,
        "POST" => Istek::Post(&govde),
        "PATCH" => Istek::Patch(&govde),
        "DELETE" => Istek::Delete,
        // `gate` yalniz yukaridaki dort fiili gecirir.
        _ => return Err(MissionHatasi::reddedildi()),
    };
    gw.cagri(istek, path).map_err(|hata| {
        let yapisal = MissionHatasi::gatewayden(&hata);
        eprintln!(
            "[mission] {fiil} {} basarisiz: sinif={:?} durum={:?} ayrinti={}",
            path.split('?').next().unwrap_or(path),
            yapisal.code,
            yapisal.status,
            maskele(&hata.to_string())
        );
        yapisal
    })
}

/// SMITH DASHBOARD penceresini acar; acikken one getirir. Pet penceresinden
/// ve (ileride) sesli araclardan cagrilir. (Pencere label'i `mission` KALDI —
/// kimlik degil adres; ama kullanici-yuzu ad artik Dashboard.)
#[tauri::command]
pub async fn mission_open(app: AppHandle) -> Result<(), String> {
    let Some(_opening) = OpeningGuard::acquire(&OPENING) else {
        return Ok(());
    };
    if let Some(win) = app.get_webview_window(MISSION_LABEL) {
        // Gizlenen pano AYNI webview ile geri gelir. Editor, secili sekme ve
        // yuklenmis veri korunur; her acilista 10-15 sn soguk yukleme yoktur.
        win.show().map_err(|e| e.to_string())?;
        win.unminimize().map_err(|e| e.to_string())?;
        return win.set_focus().map_err(|e| e.to_string());
    }

    // Reset BEFORE build: a fast frontend can signal ready during creation.
    crate::dashboard::boot_reset();
    let page_loaded = Arc::new(AtomicBool::new(false));
    let loaded_on_event = page_loaded.clone();
    let built =
        WebviewWindowBuilder::new(&app, MISSION_LABEL, WebviewUrl::App("mission.html".into()))
            .title("Smith Dashboard")
            .inner_size(1280.0, 820.0)
            .min_inner_size(900.0, 560.0)
            // Cam govde kendi baslik cubugunu cizer (JARVIS estetigi). Seffaflik
            // ISTENMEDI: buyuk bir panoda `backdrop-filter` masaustunu ornekleyemez
            // (olculmus), yani "cam" etkisi zaten opak yuzeyde uretiliyor.
            .decorations(false)
            .resizable(true)
            .center()
            .on_page_load(move |_win, payload| {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                    loaded_on_event.store(true, Ordering::Release);
                }
            })
            .build();
    let win = match built {
        Ok(win) => win,
        Err(error) => {
            // Unregistered native handles belong to the builder (RAII).
            // Remove registered remnants before releasing the opening guard.
            destroy_mission(&app)
                .await
                .map_err(|cleanup| format!("pano penceresi acilamadi: {error}; {cleanup}"))?;
            return Err(format!("pano penceresi acilamadi: {error}"));
        }
    };
    let alive = Arc::new(AtomicBool::new(true));
    let alive_on_event = alive.clone();
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            alive_on_event.store(false, Ordering::Release);
        }
    });
    // is_visible is a native roundtrip, including errors queued after build.
    let reveal = win
        .show()
        .and_then(|()| win.unminimize())
        .and_then(|()| win.set_focus())
        .and_then(|()| win.is_visible())
        .map_err(|e| e.to_string())
        .and_then(|visible| {
            visible
                .then_some(())
                .ok_or_else(|| "pano gorunur degil".to_string())
        });
    if let Err(error) = reveal {
        destroy_mission(&app)
            .await
            .map_err(|cleanup| format!("pano gosterilemedi: {error}; {cleanup}"))?;
        return Err(format!("pano gosterilemedi: {error}"));
    }

    // Boot nobeti yalniz sayfa yukleme olayi HIC bitmediyse yeniden yukler.
    // Vite soguk derlemesi yavas ama ilerliyorsa `Finished` gelir; React boot
    // sinyali gecikse bile 45 sn sonunda yalniz uyari yazilir, yukleme kesilmez.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(BOOT_WATCHDOG).await;
        match boot_action(
            alive.load(Ordering::Acquire),
            crate::dashboard::booted(),
            page_loaded.load(Ordering::Acquire),
        ) {
            BootAction::Stop => {}
            BootAction::Warn => eprintln!(
                "[dashboard] sayfa yuklendi ama boot sinyali 45 sn icinde gelmedi; reload yok"
            ),
            BootAction::Reload => {
                eprintln!(
                    "[dashboard] sayfa yukleme olayi 45 sn icinde bitmedi; pencere yeniden yukleniyor"
                );
                if let Err(error) = win.reload() {
                    eprintln!("[dashboard] pencere yeniden yuklenemedi: {error}");
                }
            }
        }
    });
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BootAction {
    Stop,
    Warn,
    Reload,
}

fn boot_action(alive: bool, booted: bool, page_loaded: bool) -> BootAction {
    if !alive || booted {
        BootAction::Stop
    } else if page_loaded {
        BootAction::Warn
    } else {
        BootAction::Reload
    }
}

fn should_hide_dashboard(label: &str) -> bool {
    label == MISSION_LABEL
}

/// X ve Alt+F4 panoyu yok etmez. Uygulamanin ana penceresi ve tepsi yasarken
/// pano webview'i gizlenir; sonraki `mission_open` ayni ornegi one getirir.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if should_hide_dashboard(window.label()) {
            api.prevent_close();
            if let Err(error) = window.hide() {
                eprintln!("[dashboard] pencere gizlenemedi: {error}");
            }
        }
    }
}

/// Cercevesiz pencerenin baslik cubugu icin surukleme. `window_start_drag` pet
/// penceresine (MAIN_LABEL) sabitlidir; onu genellestirmek yerine panonun kendi
/// komutu eklendi — tek yazar, tek pencere.
#[tauri::command]
pub fn mission_start_drag(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window(MISSION_LABEL)
        .ok_or("pano penceresi yok")?;
    win.start_dragging().map_err(|e| e.to_string())
}

/// Panoyu kapatir. Uygulamayi DEGIL: pet penceresi calismaya devam eder.
#[tauri::command]
pub fn mission_close(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(MISSION_LABEL) {
        return win.hide().map_err(|e| e.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        boot_action, gate, mission_cagir, should_hide_dashboard, BootAction, MissionHatasi,
        MissionKodu, OpeningGuard,
    };
    use crate::gateway::test_sunucu::{gateway_gibi, istemci, Sunucu};
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    const SURE: Duration = Duration::from_secs(5);
    const RED: &str = "Gecersiz gorev gecisi: review -> assigned. Izin verilenler: in_progress";

    #[test]
    fn yuklenmis_sayfa_boot_gecikince_yeniden_yuklenmez() {
        assert_eq!(boot_action(true, false, true), BootAction::Warn);
        assert_eq!(boot_action(true, false, false), BootAction::Reload);
        assert_eq!(boot_action(true, true, false), BootAction::Stop);
        assert_eq!(boot_action(false, false, false), BootAction::Stop);
    }

    #[test]
    fn yalniz_dashboard_kapatma_istegi_gizlenir() {
        assert!(should_hide_dashboard("mission"));
        assert!(!should_hide_dashboard("main"));
    }

    /// Login'e basarili, baska her yola `(durum, govde)` donen sahte gateway'e karsi
    /// `mission_cagir` calistirir.
    fn cagir_durumla(
        durum: u16,
        govde: &str,
        fiil: &str,
        yol: &str,
    ) -> Result<serde_json::Value, MissionHatasi> {
        let sunucu = Sunucu::baslat(gateway_gibi(durum, govde));
        mission_cagir(&istemci(&sunucu.taban, SURE), fiil, yol, None)
    }

    #[test]
    fn concurrent_open_requests_have_only_one_builder_owner() {
        let opening = AtomicBool::new(false);
        let owners = AtomicUsize::new(0);
        let barrier = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    barrier.wait();
                    let guard = OpeningGuard::acquire(&opening);
                    if guard.is_some() {
                        owners.fetch_add(1, Ordering::Relaxed);
                    }
                    // Hold the owner until all competing requests have tried.
                    barrier.wait();
                    drop(guard);
                });
            }
        });
        assert_eq!(owners.load(Ordering::Relaxed), 1);
        assert!(OpeningGuard::acquire(&opening).is_some());
    }

    #[test]
    fn failed_open_releases_guard_for_retry() {
        let opening = AtomicBool::new(false);
        let fail = || -> Result<(), &str> {
            let _guard = OpeningGuard::acquire(&opening).expect("first owner");
            assert!(OpeningGuard::acquire(&opening).is_none());
            Err("build failed")
        };
        assert!(fail().is_err());
        assert!(OpeningGuard::acquire(&opening).is_some());
    }

    #[test]
    fn mission_yollari_gecer() {
        assert!(gate("GET", "/v1/mission/board").is_ok());
        assert!(gate("get", "/v1/mission/summary").is_ok());
        assert!(gate("POST", "/v1/mission/tasks").is_ok());
        assert!(gate("PATCH", "/v1/mission/agents/agt_1").is_ok());
        assert!(gate("GET", "/v1/mission/events?limit=60").is_ok());
    }

    /// KAPININ ASIL ISI: pano penceresi, gateway'in geri kalanina ULASAMAZ.
    /// Bu testler olmadan on ek kontrolu bir yorumdan ibaret olurdu.
    #[test]
    fn mission_disi_yollar_reddedilir() {
        assert!(gate("POST", "/v1/dev/login").is_err());
        assert!(gate("POST", "/v1/tools/memory/remember").is_err());
        assert!(gate("GET", "/v1/health").is_err());
        assert!(gate("POST", "/v1/auth/login").is_err());
    }

    /// HAFIZA OKUMA uclari ile acik soru cevaplama/gecme Dashboard icin ACIK;
    /// genel yazma ucu ve benzer gorunen yol adlari kapali.
    #[test]
    fn hafiza_okuma_acik_yazma_kapali() {
        assert!(gate("POST", "/v1/tools/memory/search").is_ok());
        assert!(gate("POST", "/v1/tools/memory/search?x=1").is_ok());
        assert!(gate("GET", "/v1/tools/memory/list?limit=10").is_ok());
        assert!(gate("POST", "/v1/tools/memory/searchXYZ").is_err());
        assert!(gate("POST", "/v1/tools/memory/remember").is_err());
        assert!(gate("GET", "/v1/tools/memory/remember").is_err());
        assert!(gate("GET", "/v1/memory/gaps?status=open").is_ok());
        for action in ["answer", "dismiss"] {
            assert!(gate(
                "POST",
                &format!("/v1/memory/gaps/gap_00000000000000000000/{action}")
            )
            .is_ok());
        }
        for path in [
            "/v1/memory/gaps/gap_00000000000000000000/asked",
            "/v1/memory/gaps/gap_kisa/answer",
            "/v1/memory/gaps/gap_00000000000000000000/answer/fazla",
            "/v1/memory/maintenance/run",
        ] {
            assert!(gate("POST", path).is_err(), "{path}");
        }
    }

    #[test]
    fn yol_gezinmesi_reddedilir() {
        // On ek dogru ama hedef baska bir uc: kabul edilseydi kapi anlamsizdi.
        assert!(gate("POST", "/v1/mission/../tools/memory/remember").is_err());
        assert!(gate("GET", "/v1/mission//v1/health").is_err());
    }

    /// URL ayristirici kodlu `..`'i normalize eder: ham on ek kontrolu gecer ama
    /// istek baska bir ucu (kapali hafiza yazma) cagirirdi.
    #[test]
    fn kodlanmis_veya_normalize_olan_yol_reddedilir() {
        for path in [
            "/v1/mission/%2e%2e/tools/memory/remember",
            "/v1/mission/%2E./tools/memory/remember",
            "/v1/mission/%252e%252e/tools",
            "/v1/mission/a\\..\\tools/memory/remember",
            "/v1/mission/./board",
            "/v1/mission/board#/../../tools",
            "/v1/mission/x\t/../../tools/memory/remember",
        ] {
            assert!(gate("POST", path).is_err(), "{path:?}");
        }
        // Sorgu dizesindeki yuzde kodlamasi mesrudur: yalniz yol denetlenir.
        assert!(gate("GET", "/v1/mission/events?q=a%20b&limit=60").is_ok());
        assert!(gate("POST", "/v1/tools/memory/search?q=%C3%A7").is_ok());
    }

    #[test]
    fn yazma_metodlari_sinirli() {
        // DELETE ARTIK IZINLI (ajan temizligi) — ama yalniz mission on ekinde.
        assert!(gate("DELETE", "/v1/mission/agents/agt_1").is_ok());
        assert!(gate("DELETE", "/v1/tools/memory/remember").is_err());
        // PUT hala yok: guncelleme PATCH ile yapilir.
        assert!(gate("PUT", "/v1/mission/tasks/tsk_1").is_err());
        assert!(gate("HEAD", "/v1/mission/board").is_err());
    }

    #[test]
    fn basarili_cagri_govdeyi_aynen_verir() {
        let sunucu = Sunucu::baslat(gateway_gibi(200, r#"{"agents":[],"tasks":[]}"#));
        let sonuc = mission_cagir(
            &istemci(&sunucu.taban, SURE),
            "get",
            "/v1/mission/board",
            None,
        );
        assert_eq!(sonuc, Ok(json!({ "agents": [], "tasks": [] })));
    }

    /// Sinif durumdan Rust'ta turetilir: pano metin eslestirmez.
    #[test]
    fn gateway_durumu_kapali_siniflara_eslenir() {
        for (durum, sinif) in [
            (404u16, MissionKodu::NotFound),
            (409, MissionKodu::Conflict),
            (400, MissionKodu::Validation),
            (422, MissionKodu::Validation),
            (401, MissionKodu::Unauthorized),
            (403, MissionKodu::Unauthorized),
            (429, MissionKodu::Unknown),
            (500, MissionKodu::Unknown),
        ] {
            let hata =
                cagir_durumla(durum, "{}", "GET", "/v1/mission/board").expect_err("hata olmali");
            assert_eq!(hata.code, sinif, "{durum}");
            assert_eq!(hata.status, Some(durum), "{durum}");
        }
    }

    /// Gateway'in sebebi `message`a girer: model ve pano "sebebini oldugu gibi" soyler.
    #[test]
    fn gateway_sebebi_mesaja_tasinir() {
        let govde = json!({ "error": RED }).to_string();
        let hata = cagir_durumla(409, &govde, "POST", "/v1/mission/tasks/t1/status")
            .expect_err("409 hata olmali");
        assert_eq!(
            hata,
            MissionHatasi {
                code: MissionKodu::Conflict,
                status: Some(409),
                message: RED.to_string(),
            }
        );
    }

    /// Sebep yoksa sinifin sabit metni gider; istek yolu, host, token ve OS hatasi ASLA.
    #[test]
    fn mesaj_istek_yolunu_hostu_ve_ag_ayrintisini_tasimaz() {
        let hata = cagir_durumla(404, "{}", "GET", "/v1/mission/tasks/tsk_gizli")
            .expect_err("404 hata olmali");
        assert_eq!(hata.message, "kayit bulunamadi");

        // Ulasilamayan gateway: kapali bir porta baglanti reddi.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let kapali = istemci(&format!("http://127.0.0.1:{port}"), Duration::from_secs(2));
        let hata = mission_cagir(&kapali, "GET", "/v1/mission/tasks/tsk_gizli", None)
            .expect_err("kapali gateway hata olmali");
        assert_eq!(hata.code, MissionKodu::Unavailable);
        assert_eq!(hata.status, None);
        assert_eq!(hata.message, "gateway'e ulasilamadi");
        for gizli in [
            "tsk_gizli",
            "127.0.0.1",
            "/v1/mission",
            "tok-test",
            "Bearer",
        ] {
            assert!(
                !hata.message.contains(gizli),
                "{gizli} sizdi: {}",
                hata.message
            );
        }
    }

    #[test]
    fn kapidan_gecmeyen_istek_gatewaye_gitmez_ve_yolu_yansitmaz() {
        let sunucu = Sunucu::baslat(gateway_gibi(200, "{}"));
        let client = istemci(&sunucu.taban, SURE);
        let hata =
            mission_cagir(&client, "POST", "/v1/dev/login", None).expect_err("kapi reddetmeli");
        assert_eq!(
            hata,
            MissionHatasi {
                code: MissionKodu::Unknown,
                status: None,
                message: "istek kapidan gecmedi".to_string(),
            }
        );
        assert!(
            sunucu.bitir().is_empty(),
            "reddedilen istek gateway'e gitti"
        );
    }

    /// Webview'in gordugu JSON: arayuzdeki `MissionErrorCode` degerleriyle birebir.
    #[test]
    fn hata_tel_bicimi_arayuz_sozlesmesiyle_ayni() {
        let hata = MissionHatasi {
            code: MissionKodu::Conflict,
            status: Some(409),
            message: RED.to_string(),
        };
        assert_eq!(
            serde_json::to_value(&hata).unwrap(),
            json!({ "code": "conflict", "status": 409, "message": RED })
        );
        let ulasilamadi = MissionHatasi {
            code: MissionKodu::Unavailable,
            status: None,
            message: "x".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&ulasilamadi).unwrap()["status"],
            json!(null)
        );

        let kodlar: Vec<_> = [
            MissionKodu::NotFound,
            MissionKodu::Conflict,
            MissionKodu::Validation,
            MissionKodu::Unauthorized,
            MissionKodu::Unavailable,
            MissionKodu::Unknown,
        ]
        .iter()
        .map(|kod| serde_json::to_value(kod).unwrap())
        .collect();
        assert_eq!(
            kodlar,
            vec![
                json!("not-found"),
                json!("conflict"),
                json!("validation"),
                json!("unauthorized"),
                json!("unavailable"),
                json!("unknown"),
            ]
        );
    }
}
