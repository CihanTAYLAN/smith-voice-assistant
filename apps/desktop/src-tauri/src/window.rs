// Smith'i "bir pencere" olmaktan cikarip masaustunde yasayan bir varlik yapan
// katman. Kullanici mandasi 2026-08-14: "Seni bir pencerede gormek istemiyorum,
// seffaf olsun, masaustunde serbest dolassin."
//
// Bu modul YALNIZ pencere davranisindan sorumludur: cercevesizlik, seffaflik,
// her zaman ustte durma, tiklama gecirgenligi, surukleme ve konum bellegi.
// Ses/arac/olay mantigi lib.rs ve audio/ altinda kalir.
//
// TASARIM NOTU — tiklama gecirgenliginin catch-22'si
// -------------------------------------------------
// Pet masaustunun ustunde durdugu icin altindaki uygulamalara tiklamayi
// engellememeli: `set_ignore_cursor_events(true)`. Ama o bayrak aciksa webview
// HIC fare olayi almaz — yani React "fare petin uzerine geldi" olayini da
// goremez. Dolayisiyla "React hover'da true, ayrilinca false cagirir" tasarimi
// tek basina calismaz: gecirgen duruma bir kez girildikten sonra React'in geri
// donmesini saglayacak tetik kalmaz.
//
// Cozum: hit-test'i isletim sistemi tarafinda, yani BURADA yapmak. React bir
// kez "benim dokunulabilir dikdortgenlerim bunlar" der (`window_set_hit_areas`),
// Rust tarafindaki gozcu iplik imleci ~40 ms'de bir okur ve gecirgenligi kendisi
// cevirir. Yetki tek elde toplanir:
//
//   * hit alani KAYITLI  → gecirgenligin sahibi Rust gozcusudur.
//   * hit alani BOS      → sahibi React'tir, `window_set_interactive` ile surer.
//
// Iki taraf ayni bayragi ayni anda surmez; yarisma yok.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow};

/// tauri.conf.json'daki tek pencerenin etiketi. HUD ayri pencere DEGIL; React
/// ayni seffaf pencerenin icine yerlestirir.
pub const MAIN_LABEL: &str = "main";

/// Kacis kapisi: bu env verildiginde pencere eski normal davranisina doner
/// (dekorasyonlu, opak, gorev cubugunda, ustte degil). Cercevesiz + seffaf +
/// her zaman ustte bir pencere kilitlenirse kullanici uygulamayi kapatamaz;
/// bu bayrak o durumdan cikis yoludur. Bilincli olarak `dev-win.ps1`'e
/// eklenmedi — orasi baska bir sahibin dosyasi.
pub const PLAIN_ENV: &str = "SMITH_WINDOW_PLAIN";

/// Imlec gozcusunun ornekleme araligi. 40 ms ~25 Hz: fare hareketiyle ayni
/// buyukluk sinifinda (insan bir dugmeye 40 ms'de girip cikmaz) ve maliyeti
/// olcusuz kucuk (iki syscall). Daha kisa tutmak CPU'yu bosa yakar, daha uzun
/// tutmak "tiklamam yutuldu" hissi yaratir.
const WATCH_INTERVAL: Duration = Duration::from_millis(40);

/// Hit alanlarina uygulanan pay (CSS px). Imlec tam sinirda titredigi zaman
/// gecirgenligin saniyede onlarca kez cevrilmesini onler.
const HIT_MARGIN: f64 = 4.0;

/// Bir pencerenin "kullanilabilir" sayilmasi icin bir ekranla ortusmesi gereken
/// en az miktar (fiziksel px, her iki eksende). Bunun altinda kalan konum
/// kullaniciya erisilemez bir pet demektir → diske yazilmaz ve acilista kirpilir.
const MIN_VISIBLE_PX: i32 = 96;

/// Konum diske en fazla bu sıklıkta yazilir. `Moved` olayi surukleme boyunca
/// saniyede onlarca kez gelir; her birinde dosya yazmak anlamsiz I/O olur.
const SAVE_THROTTLE: Duration = Duration::from_millis(600);

/// PLAIN modda pencereyi gercekten opak yapan renk. Seflik pencere
/// olusturulurken sabitlenir ve calisma aninda geri alinamaz (`set_transparent`
/// yok); bu yuzden opakligi arka plan rengiyle saglıyoruz. Boylece React hicbir
/// sey cizmese bile PLAIN mod opak gorunur.
const PLAIN_BG: tauri::window::Color = tauri::window::Color(17, 18, 22, 255);

/// Pet moduna GERI donerken kullanilan seffaf arka plan.
const TRANSPARENT_BG: tauri::window::Color = tauri::window::Color(0, 0, 0, 0);

// ---------------------------------------------------------------------------
// Saf geometri — Tauri'siz test edilebilir
// ---------------------------------------------------------------------------

/// Fiziksel piksel dikdortgeni (pencere veya ekran).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

/// Iki dikdortgenin eksen basina ortusmesi.
fn overlap(a_pos: i32, a_len: i32, b_pos: i32, b_len: i32) -> i32 {
    let start = a_pos.max(b_pos);
    let end = (a_pos + a_len).min(b_pos + b_len);
    (end - start).max(0)
}

/// Konum yeterince gorunuyor mu? Windows minimize edilmis pencereye
/// (-32000, -32000) verir; bu yordam onu da eler.
pub fn is_placement_usable(win: Rect, monitors: &[Rect]) -> bool {
    monitors.iter().any(|m| {
        overlap(win.x, win.width, m.x, m.width) >= MIN_VISIBLE_PX.min(win.width)
            && overlap(win.y, win.height, m.y, m.height) >= MIN_VISIBLE_PX.min(win.height)
    })
}

/// Konumu ekran duzenine geri ceker. Ekran sayisi/cozunurlugu degistiginde
/// (dizustu dock'tan cikti, ikinci monitor gitti) kaydedilmis konum ekran disina
/// dusebilir; o zaman pet erisilemez olur.
///
/// Kural: konum halen yeterince gorunuyorsa DOKUNULMAZ — cok monitorlu
/// duzenlerde negatif koordinat mesru bir konumdur, "duzeltmek" hatadir.
pub fn clamp_placement(win: Rect, monitors: &[Rect]) -> (i32, i32) {
    if monitors.is_empty() || is_placement_usable(win, monitors) {
        return (win.x, win.y);
    }
    let target = best_monitor(win, monitors);
    (
        clamp_axis(win.x, win.width, target.x, target.width),
        clamp_axis(win.y, win.height, target.y, target.height),
    )
}

/// Pencere ekrandan buyukse ekranin kosesine hizala; degilse ekranin icine sik.
fn clamp_axis(pos: i32, len: i32, m_pos: i32, m_len: i32) -> i32 {
    if len >= m_len {
        m_pos
    } else {
        pos.clamp(m_pos, m_pos + m_len - len)
    }
}

/// En cok ortusen ekran; hicbiriyle ortusmuyorsa merkezi en yakin olan.
fn best_monitor(win: Rect, monitors: &[Rect]) -> Rect {
    let mut best = monitors[0];
    let mut best_area = -1i64;
    let mut best_dist = i64::MAX;
    for m in monitors {
        let area = overlap(win.x, win.width, m.x, m.width) as i64
            * overlap(win.y, win.height, m.y, m.height) as i64;
        let dx = (win.x + win.width / 2 - (m.x + m.width / 2)) as i64;
        let dy = (win.y + win.height / 2 - (m.y + m.height / 2)) as i64;
        let dist = dx * dx + dy * dy;
        if area > best_area || (area == best_area && dist < best_dist) {
            best = *m;
            best_area = area;
            best_dist = dist;
        }
    }
    best
}

/// React'in bildirdigi dokunulabilir dikdortgen: CSS (logical) px, webview'in
/// gorunum alaninin sol ust kosesine gore. Dekorasyon kapali oldugu icin bu
/// koken pencerenin ic kokeniyle ayni.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct HitArea {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Global fiziksel imlec konumunu pencere-yerel CSS px'e cevirir.
pub fn to_local(cursor: (f64, f64), inner_origin: (i32, i32), scale: f64) -> (f64, f64) {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    (
        (cursor.0 - inner_origin.0 as f64) / scale,
        (cursor.1 - inner_origin.1 as f64) / scale,
    )
}

/// Imlec dokunulabilir bir alanin (pay dahil) icinde mi?
pub fn hits(local: (f64, f64), areas: &[HitArea], margin: f64) -> bool {
    areas.iter().any(|a| {
        local.0 >= a.x - margin
            && local.0 <= a.x + a.width + margin
            && local.1 >= a.y - margin
            && local.1 <= a.y + a.height + margin
    })
}

// ---------------------------------------------------------------------------
// Konum bellegi — kendi kucuk JSON'u, eklenti yok
// ---------------------------------------------------------------------------

/// Diskte tutulan konum. YALNIZ konum: boyut bilincli olarak kaydedilmiyor,
/// cunku React'in tasarim boyutu degistiginde eski boyut kalici olarak kazanir
/// ve "pet neden kirpik" diye teshis edilmesi zor bir hataya donusur.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
}

/// `<veri koku>\window.json`: sirlar ve loglarla ayni tek kok (`crate::paths`).
pub fn placement_path() -> Option<PathBuf> {
    crate::paths::data_path("window.json")
}

/// Bozuk/eksik dosya olumcul degildir: konum bellegi bir kolaylik, uygulamanin
/// acilma kosulu degil. Hata durumunda None doner ve pencere varsayilan yerinde
/// acilir.
pub fn parse_placement(raw: &str) -> Option<Placement> {
    serde_json::from_str::<Placement>(raw).ok()
}

pub fn load_placement(path: &Path) -> Option<Placement> {
    parse_placement(&std::fs::read_to_string(path).ok()?)
}

pub fn save_placement(path: &Path, placement: &Placement) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string(placement)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, json)
}

// ---------------------------------------------------------------------------
// Calisma zamani durumu
// ---------------------------------------------------------------------------

/// React'e donen anlik goruntu. React hangi modda oldugunu bilmeli: pet modunda
/// seffaf/cercevesiz cizim, PLAIN modda normal pencere cizimi yapar.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSnapshot {
    /// Pet modu mu (cercevesiz + seffaf + ustte)? `SMITH_WINDOW_PLAIN=1` ile false.
    pub pet: bool,
    /// Cerceve su an acik mi (`window_toggle_frame` ile degisir)?
    pub framed: bool,
    /// Pencere su an fare olaylarini aliyor mu?
    pub interactive: bool,
    /// Hit alani kayitli mi — yani gecirgenligin sahibi Rust gozcusu mu?
    pub auto_hit: bool,
    pub x: i32,
    pub y: i32,
    pub scale_factor: f64,
}

pub struct WindowRuntime {
    /// Pet modu. PLAIN env ile kapatilir; calisma aninda degismez.
    pet: bool,
    /// Cerceve durumu (kacis kapisi ile acilir/kapanir).
    framed: AtomicBool,
    /// `set_ignore_cursor_events(!interactive)` ile senkron tutulan gercek durum.
    interactive: AtomicBool,
    /// OS pencere mutasyonlari (`set_interactive`, `window_toggle_frame`) bu kilit
    /// altinda "kontrol, uygula, sakla" siralamasiyla yapilir; kilitsiz gozcu ile
    /// React komutu yarisip state ile gercek OS durumunu ayristirabilir.
    mutation: Mutex<()>,
    hit_areas: Mutex<Vec<HitArea>>,
    placement_path: Option<PathBuf>,
    last_saved: Mutex<Option<Instant>>,
}

impl WindowRuntime {
    fn new(pet: bool, placement_path: Option<PathBuf>) -> Self {
        Self {
            pet,
            framed: AtomicBool::new(!pet),
            // Acilis DELIBERE olarak etkilesimli: React henuz hit alanini
            // bildirmeden pencereyi gecirgen yapmak, React hic yuklenmezse
            // hicbir sekilde erisilemeyen bir hayalet birakir.
            interactive: AtomicBool::new(true),
            mutation: Mutex::new(()),
            hit_areas: Mutex::new(Vec::new()),
            placement_path,
            last_saved: Mutex::new(None),
        }
    }

    fn auto_hit(&self) -> bool {
        self.hit_areas
            .lock()
            .map(|a| !a.is_empty())
            .unwrap_or(false)
    }
}

pub fn plain_mode_requested() -> bool {
    matches!(std::env::var(PLAIN_ENV), Ok(v) if v == "1" || v.eq_ignore_ascii_case("true"))
}

/// Pencereyi kurar: modu belirler, kaydedilmis konumu (kirparak) uygular,
/// gorunur yapar ve pet modunda imlec gozcusunu baslatir.
pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let pet = !plain_mode_requested();
    app.manage(WindowRuntime::new(pet, placement_path()));

    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        // Pencere yoksa yapacak bir sey yok; ses hatti pencereden bagimsiz
        // calisiyor, bu yuzden uygulamayi dusurmuyoruz.
        eprintln!("[window] '{MAIN_LABEL}' penceresi bulunamadi, kurulum atlandi");
        return Ok(());
    };

    let chrome = if pet {
        // Acilista arka plan rengine DOKUNULMAZ: seflik pencere dogarken
        // tauri.conf.json'dan geldi, uzerine yazmak (test edilemeyen bir
        // platform ayrintisi yuzunden) seffafligi bozma riski tasir.
        apply_pet_chrome(&window, false)
    } else {
        apply_plain_chrome(&window)
    };
    if let Err(e) = chrome {
        // Cerceve ayari uygulanamasa da uygulama dusmez: ses hatti pencereden
        // bagimsiz calisiyor, pencere de kacis kapilariyla duzeltilebilir.
        eprintln!("[window] cerceve ayarlari uygulanamadi: {e}");
    }

    if let Err(e) = restore_position(app, &window) {
        eprintln!("[window] kaydedilmis konum uygulanamadi: {e}");
    }

    // tauri.conf.json'da `visible: false`: pencere once varsayilan yerinde
    // gorunup sonra kaydedilmis konuma ziplamasin. Konum ne olursa olsun
    // gorunur yapilir — aksi halde hata durumunda gorunmez uygulama kalir.
    let _ = window.show();

    if pet {
        spawn_cursor_watcher(app.clone());
    }
    Ok(())
}

/// `restore_transparency`: yalniz cerceveli moddan GERI donerken true. Windows'ta
/// webview katmani icin alpha 0 desteklenir (0 disindaki her alpha 255'e
/// cevrilir), yani `Color(0,0,0,0)` "tamamen seffaf" demektir.
fn apply_pet_chrome(window: &WebviewWindow, restore_transparency: bool) -> tauri::Result<()> {
    // Bu alanlar tauri.conf.json'da da ayni degerlerle duruyor; buradaki
    // tekrar, PLAIN moddan `window_toggle_frame` ile geri donusu mumkun kilar.
    window.set_decorations(false)?;
    window.set_shadow(false)?;
    window.set_always_on_top(true)?;
    window.set_skip_taskbar(true)?;
    if restore_transparency {
        window.set_background_color(Some(TRANSPARENT_BG))?;
    }
    Ok(())
}

fn apply_plain_chrome(window: &WebviewWindow) -> tauri::Result<()> {
    window.set_decorations(true)?;
    window.set_shadow(true)?;
    window.set_always_on_top(false)?;
    window.set_skip_taskbar(false)?;
    // Seflik pencere dogarken sabitlendi; opakligi arka plan rengiyle saglıyoruz.
    window.set_background_color(Some(PLAIN_BG))?;
    window.set_ignore_cursor_events(false)?;
    Ok(())
}

/// Ekranlari fiziksel dikdortgen listesine cevirir. `work_area` kullaniyoruz:
/// gorev cubugunun altinda kalan bir pet'e tiklamak zordur.
fn monitor_rects(window: &WebviewWindow) -> Vec<Rect> {
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let area = m.work_area();
            Rect::new(
                area.position.x,
                area.position.y,
                area.size.width as i32,
                area.size.height as i32,
            )
        })
        .collect()
}

fn restore_position(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let runtime = app.state::<WindowRuntime>();
    let Some(path) = runtime.placement_path.clone() else {
        return Ok(());
    };
    let Some(saved) = load_placement(&path) else {
        return Ok(());
    };

    let size = window.outer_size().map_err(|e| e.to_string())?;
    let win = Rect::new(saved.x, saved.y, size.width as i32, size.height as i32);
    let (x, y) = clamp_placement(win, &monitor_rects(window));
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// Imlec gozcusu: hit alani kayitliysa gecirgenligi isletim sistemi tarafinda
/// cevirir. Bkz. dosya basindaki catch-22 notu.
fn spawn_cursor_watcher(app: AppHandle) {
    // Kalici bir OS hatasi her 40 ms'de loga basilmaz: hata dizisinin yalniz
    // ilk turu yazilir, basari gelince sayac sifirlanir.
    let mut hata_vardi = false;
    std::thread::spawn(move || loop {
        std::thread::sleep(WATCH_INTERVAL);

        let Some(window) = app.get_webview_window(MAIN_LABEL) else {
            return; // pencere kapandi
        };
        // `try_state`: bu iplik pencerenin omrunu asabilir; kapanis sirasinda
        // durum kaybolmussa panik yerine sessizce cikmali.
        let Some(runtime) = app.try_state::<WindowRuntime>() else {
            return;
        };

        // Cerceve acikken (kacis kapisi) gecirgenlik yonetilmez: kullanici
        // pencereyi normal pencere gibi kullanmak istiyor.
        if runtime.framed.load(Ordering::Relaxed) {
            continue;
        }

        let areas = match runtime.hit_areas.lock() {
            Ok(guard) if !guard.is_empty() => guard.clone(),
            // Bos liste → yetki React'te; gozcu karismaz.
            _ => continue,
        };

        let (Ok(cursor), Ok(origin), Ok(scale)) = (
            window.cursor_position(),
            window.inner_position(),
            window.scale_factor(),
        ) else {
            continue;
        };

        let local = to_local((cursor.x, cursor.y), (origin.x, origin.y), scale);
        let desired = hits(local, &areas, HIT_MARGIN);
        match set_interactive(&window, runtime.inner(), desired) {
            Ok(()) => hata_vardi = false,
            Err(error) if !hata_vardi => {
                hata_vardi = true;
                eprintln!("[window] gecirgenlik uygulanamadi: {error}");
            }
            Err(_) => {}
        }
    });
}

/// Gecirgenligi tek noktadan surer. Olay yalniz OS cagrisi BASARILI olunca
/// gonderilir: etkilesimliden gecirgene gecerken React'in fare olaylari
/// kesilecegi icin `mouseleave` gelmez ve hover durumu takili kalir; bu olay onu
/// temizler. OS basarisizsa state ve olay degismez, hata doner; ayni deger tekrar
/// gelince cagri yeniden denenir (state eskiyi gosterdigi icin erken donmez).
///
/// Cerceveli kipte pencere HER ZAMAN etkilesimlidir: gozcu `framed`i kontrol
/// ettikten sonra `window_toggle_frame` araya girebilir; kilit altinda tekrar
/// bakmak pencerenin tiklanamaz kalmasini onler.
fn set_interactive(
    window: &WebviewWindow,
    runtime: &WindowRuntime,
    interactive: bool,
) -> Result<(), String> {
    let _guard = runtime
        .mutation
        .lock()
        .map_err(|_| "pencere mutasyon kilidi")?;
    let interactive = interactive || runtime.framed.load(Ordering::Relaxed);
    update_window_state(
        &runtime.interactive,
        interactive,
        || {
            window
                .set_ignore_cursor_events(!interactive)
                .map_err(|e| e.to_string())
        },
        || {
            let _ = window.emit("window://interactive", InteractiveEvent { interactive });
        },
    )
}

/// Durumu YALNIZ OS degisikligi basarili olunca gunceller ve olayi o zaman yollar
/// (`apply` -> `state` -> `emit`); istenen deger zaten kayitliysa hicbir sey yapmaz.
fn update_window_state(
    state: &AtomicBool,
    desired: bool,
    apply: impl FnOnce() -> Result<(), String>,
    emit: impl FnOnce(),
) -> Result<(), String> {
    if state.load(Ordering::Relaxed) == desired {
        return Ok(());
    }
    apply()?;
    state.store(desired, Ordering::Relaxed);
    emit();
    Ok(())
}

#[derive(Clone, Copy, Serialize)]
struct InteractiveEvent {
    interactive: bool,
}

/// Pencere olaylari: konum bellegi buradan beslenir. lib.rs'den baglanir.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != MAIN_LABEL {
        return;
    }
    let app = window.app_handle();
    match event {
        tauri::WindowEvent::Moved(_) => persist_position(app, false),
        tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
            persist_position(app, true)
        }
        _ => {}
    }
}

/// `force`: kapanista kisitlama uygulanmaz — son konum kaybedilmemeli.
fn persist_position(app: &AppHandle, force: bool) {
    // `Destroyed` kapanis sirasinda gelir; durum o anda kaybolmus olabilir.
    let Some(runtime) = app.try_state::<WindowRuntime>() else {
        return;
    };
    let Some(path) = runtime.placement_path.clone() else {
        return;
    };

    if !force {
        let Ok(mut last) = runtime.last_saved.lock() else {
            return;
        };
        if let Some(t) = *last {
            if t.elapsed() < SAVE_THROTTLE {
                return;
            }
        }
        *last = Some(Instant::now());
    }

    let Some(view) = app.get_webview_window(MAIN_LABEL) else {
        return;
    };
    let (Ok(pos), Ok(size)) = (view.outer_position(), view.outer_size()) else {
        return;
    };

    // Windows minimize edilmis pencereye (-32000, -32000) verir ve bunu
    // `Moved` olayi olarak yollar. O konumu diske yazmak, uygulamanin bir
    // dahaki acilista ekran disinda dogmasi demek olurdu.
    let win = Rect::new(pos.x, pos.y, size.width as i32, size.height as i32);
    if !is_placement_usable(win, &monitor_rects(&view)) {
        return;
    }

    if let Err(e) = save_placement(&path, &Placement { x: pos.x, y: pos.y }) {
        eprintln!("[window] konum kaydedilemedi: {e}");
    }
}

// ---------------------------------------------------------------------------
// React'e acilan komutlar
// ---------------------------------------------------------------------------

/// Pencerenin fare olaylarini alip almadigini dogrudan surer.
///
/// Hit alani kayitli DEGILSE gecirgenligin sahibi React'tir ve bu komut tek
/// yetkilidir. Hit alani kayitliysa gozcu iplik bir sonraki turda (≤40 ms)
/// kendi kararini yazar; bu cagri gecici kalir.
#[tauri::command]
pub fn window_set_interactive(
    app: AppHandle,
    runtime: State<'_, WindowRuntime>,
    interactive: bool,
) -> Result<(), String> {
    let window = app.get_webview_window(MAIN_LABEL).ok_or("pencere yok")?;
    set_interactive(&window, runtime.inner(), interactive)
}

/// React'in dokunulabilir dikdortgenlerini bildirir (CSS px, gorunum alanina
/// gore). Bos liste gondermek gozcuyu susturur ve yetkiyi React'e geri verir.
#[tauri::command]
pub fn window_set_hit_areas(
    runtime: State<'_, WindowRuntime>,
    areas: Vec<HitArea>,
) -> Result<(), String> {
    let mut guard = runtime.hit_areas.lock().map_err(|_| "hit alani kilidi")?;
    *guard = areas;
    Ok(())
}

/// Isletim sisteminin pencere tasima donguşunu baslatir.
///
/// `data-tauri-drag-region` yerine bilincli olarak bu komut: (1) o oznitelik
/// `core:window:allow-start-dragging` iznini gerektirir ve bizim capability
/// dosyamizdaki `core:default` bu izni ICERMEZ (varsayilan set salt-okunur) —
/// yani sessizce calismaz; (2) Tauri'nin yerlesik surukleme isleyicisi cift
/// tiklamada `internal_toggle_maximize` cagirir, cercevesiz seffaf bir pet'in
/// ekrani kaplamasi istenmeyen bir davranistir; (3) kendi komutumuz ACL yuzeyini
/// genisletmez (uygulama komutlari izin gerektirmez).
#[tauri::command]
pub fn window_start_drag(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window(MAIN_LABEL).ok_or("pencere yok")?;
    window.start_dragging().map_err(|e| e.to_string())
}

/// KACIS KAPISI 1: cerceveyi acar/kapatir. Cerceve acikken pencere normal bir
/// pencere gibi davranir (baslik cubugu, gorev cubugu, ustte degil, opak,
/// gecirgen degil) — yani kapatma dugmesi geri gelir. Yeni "framed" degerini
/// dondurur.
#[tauri::command]
pub fn window_toggle_frame(
    app: AppHandle,
    runtime: State<'_, WindowRuntime>,
) -> Result<bool, String> {
    let window = app.get_webview_window(MAIN_LABEL).ok_or("pencere yok")?;
    let _guard = runtime
        .mutation
        .lock()
        .map_err(|_| "pencere mutasyon kilidi")?;
    let framed = !runtime.framed.load(Ordering::Relaxed);
    update_window_state(
        &runtime.framed,
        framed,
        || {
            if framed {
                apply_plain_chrome(&window)
            } else {
                apply_pet_chrome(&window, true)
            }
            .map_err(|e| e.to_string())
        },
        || {
            if framed {
                runtime.interactive.store(true, Ordering::Relaxed);
                let _ = window.emit(
                    "window://interactive",
                    InteractiveEvent { interactive: true },
                );
            }
        },
    )?;
    Ok(framed)
}

/// KACIS KAPISI 2: uygulamayi kapatir. Cikmadan once konumu diske yazar —
/// `exit` yolunda `Destroyed` olayina guvenmek istemiyoruz.
#[tauri::command]
pub fn window_quit(app: AppHandle) {
    quit_from(app, "hud");
}

pub(crate) fn quit_from(app: AppHandle, kaynak: &str) {
    eprintln!("[pencere] cikis istendi (kaynak: {kaynak})");
    persist_position(&app, true);
    app.exit(0);
}

/// React'in hangi modda cizim yapacagini bilmesi icin anlik durum.
#[tauri::command]
pub fn window_state(
    app: AppHandle,
    runtime: State<'_, WindowRuntime>,
) -> Result<WindowSnapshot, String> {
    let window = app.get_webview_window(MAIN_LABEL).ok_or("pencere yok")?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let scale_factor = window.scale_factor().map_err(|e| e.to_string())?;
    Ok(WindowSnapshot {
        pet: runtime.pet,
        framed: runtime.framed.load(Ordering::Relaxed),
        interactive: runtime.interactive.load(Ordering::Relaxed),
        auto_hit: runtime.auto_hit(),
        x: pos.x,
        y: pos.y,
        scale_factor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIMARY: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };
    /// Solda duran ikinci monitor: cok monitorlu duzenlerde koordinatlar
    /// negatiftir ve bu MESRUDUR.
    const LEFT: Rect = Rect {
        x: -1920,
        y: 0,
        width: 1920,
        height: 1080,
    };
    const PET: (i32, i32) = (420, 520);

    fn pet_at(x: i32, y: i32) -> Rect {
        Rect::new(x, y, PET.0, PET.1)
    }

    #[test]
    fn ekran_icindeki_konum_dokunulmaz() {
        let win = pet_at(100, 140);
        assert!(is_placement_usable(win, &[PRIMARY]));
        assert_eq!(clamp_placement(win, &[PRIMARY]), (100, 140));
    }

    #[test]
    fn ikincil_ekranin_negatif_konumu_korunur() {
        let win = pet_at(-1800, 200);
        let monitors = [PRIMARY, LEFT];
        assert!(is_placement_usable(win, &monitors));
        assert_eq!(clamp_placement(win, &monitors), (-1800, 200));
    }

    #[test]
    fn ikinci_ekran_gidince_konum_kalan_ekrana_cekilir() {
        // Ayni konum, ama artik yalniz birincil ekran var → pet kayip.
        let win = pet_at(-1800, 200);
        assert!(!is_placement_usable(win, &[PRIMARY]));
        assert_eq!(clamp_placement(win, &[PRIMARY]), (0, 200));
    }

    #[test]
    fn ekran_disina_tasan_konum_kirpilir() {
        let win = pet_at(5000, 100);
        assert!(!is_placement_usable(win, &[PRIMARY]));
        // Sag kenara yapisir: 1920 - 420 = 1500.
        assert_eq!(clamp_placement(win, &[PRIMARY]), (1500, 100));
    }

    #[test]
    fn sinirda_yeterli_gorunurluk_kabul_edilir() {
        // Tam MIN_VISIBLE_PX kadar goruen konum kalir...
        let ok = pet_at(1920 - MIN_VISIBLE_PX, 100);
        assert!(is_placement_usable(ok, &[PRIMARY]));
        // ...bir piksel eksigi kirpilir.
        let bad = pet_at(1920 - MIN_VISIBLE_PX + 1, 100);
        assert!(!is_placement_usable(bad, &[PRIMARY]));
        assert_eq!(clamp_placement(bad, &[PRIMARY]), (1500, 100));
    }

    #[test]
    fn minimize_edilmis_konum_kaydedilmez() {
        // Windows minimize edilmis pencereye bu konumu verir ve `Moved`
        // olayi olarak yollar. Diske yazilirsa pet bir daha gorunmez.
        let win = pet_at(-32000, -32000);
        assert!(!is_placement_usable(win, &[PRIMARY]));
        assert_eq!(clamp_placement(win, &[PRIMARY]), (0, 0));
    }

    #[test]
    fn pencere_ekrandan_buyukse_kosede_hizalanir() {
        let win = Rect::new(5000, 5000, 2400, 1400);
        assert_eq!(clamp_placement(win, &[PRIMARY]), (0, 0));
    }

    #[test]
    fn en_cok_ortusen_ekran_secilir() {
        // Iki ekranin da disinda, ama sol ekrana daha yakin bir konum.
        let win = pet_at(-4000, 300);
        assert_eq!(clamp_placement(win, &[PRIMARY, LEFT]), (-1920, 300));
    }

    #[test]
    fn ekran_listesi_bossa_konum_korunur() {
        // Monitor sorgusu basarisiz olduysa (bos liste) konumu "duzeltmek"
        // rastgele bir yere tasimak olur; dokunmuyoruz.
        let win = pet_at(-32000, -32000);
        assert_eq!(clamp_placement(win, &[]), (-32000, -32000));
    }

    #[test]
    fn json_gidis_donus() {
        let p = Placement { x: -1804, y: 337 };
        let raw = serde_json::to_string(&p).expect("serilesir");
        assert_eq!(raw, r#"{"x":-1804,"y":337}"#);
        assert_eq!(parse_placement(&raw), Some(p));
    }

    #[test]
    fn bozuk_veya_eksik_json_yok_sayilir() {
        // Konum bellegi bir kolayliktir; bozuk dosya uygulamayi dusurmez.
        assert_eq!(parse_placement("{"), None);
        assert_eq!(parse_placement(r#"{"x":10}"#), None);
        assert_eq!(parse_placement(""), None);
        // Ileri uyumluluk: bilinmeyen alan okumayi bozmaz.
        assert_eq!(
            parse_placement(r#"{"x":10,"y":20,"width":420}"#),
            Some(Placement { x: 10, y: 20 })
        );
    }

    #[test]
    fn dosyaya_yazip_geri_okur() {
        let dir = std::env::temp_dir().join(format!("smith-window-test-{}", std::process::id()));
        let path = dir.join("nested").join("window.json");
        let p = Placement { x: 77, y: -12 };

        // Ust dizin yoksa olusturulmali (ilk calistirmada boyle olur).
        save_placement(&path, &p).expect("yazilir");
        assert_eq!(load_placement(&path), Some(p));

        // Olmayan dosya None doner, panik yok.
        assert_eq!(load_placement(&dir.join("yok.json")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn imlec_alan_icinde_etkilesim_ister() {
        let areas = [HitArea {
            x: 10.0,
            y: 10.0,
            width: 100.0,
            height: 100.0,
        }];
        assert!(hits((60.0, 60.0), &areas, HIT_MARGIN));
        assert!(!hits((300.0, 60.0), &areas, HIT_MARGIN));
        assert!(!hits((60.0, 400.0), &areas, HIT_MARGIN));
    }

    #[test]
    fn kenar_payi_titremeyi_onler() {
        let areas = [HitArea {
            x: 10.0,
            y: 10.0,
            width: 100.0,
            height: 100.0,
        }];
        // Payin icinde → halen etkilesimli (sinirda saniyede onlarca kez
        // gecirgenlik cevirmemek icin).
        assert!(hits((7.0, 60.0), &areas, HIT_MARGIN));
        // Payin disinda → gecirgen.
        assert!(!hits((5.0, 60.0), &areas, HIT_MARGIN));
    }

    #[test]
    fn bos_alan_listesi_asla_isabet_vermez() {
        // Gozcu bu durumda hic karar yazmaz (yetki React'te); saf yordamin
        // sozlesmesi de "isabet yok" olmali.
        assert!(!hits((60.0, 60.0), &[], HIT_MARGIN));
    }

    #[test]
    fn birden_cok_alan_ayri_ayri_test_edilir() {
        // Pet + HUD ayni seffaf pencerede yasiyor; ikisi de dokunulabilir.
        let areas = [
            HitArea {
                x: 0.0,
                y: 0.0,
                width: 120.0,
                height: 120.0,
            },
            HitArea {
                x: 260.0,
                y: 400.0,
                width: 150.0,
                height: 60.0,
            },
        ];
        assert!(hits((10.0, 10.0), &areas, HIT_MARGIN));
        assert!(hits((300.0, 430.0), &areas, HIT_MARGIN));
        // Aradaki seffaf bosluk: altindaki uygulamaya gecmeli.
        assert!(!hits((200.0, 250.0), &areas, HIT_MARGIN));
    }

    #[test]
    fn olcek_faktoru_uygulanir() {
        // 150% DPI: fiziksel imlec → CSS px. Bu cevrim yanlis olursa hit alani
        // ekranda gordugumuz yerden kayar ve pet "tiklanamaz" gorunur.
        let (x, y) = to_local((500.0, 400.0), (200, 100), 1.5);
        assert!((x - 200.0).abs() < 1e-9, "x={x}");
        assert!((y - 200.0).abs() < 1e-9, "y={y}");
    }

    #[test]
    fn bozuk_olcek_faktoru_birim_kabul_edilir() {
        // Sifir/negatif olcek bolme hatasi verirdi.
        assert_eq!(to_local((300.0, 200.0), (100, 100), 0.0), (200.0, 100.0));
    }

    /// OS cagrisi basarisizsa state ve olay DEGISMEZ; ayni deger tekrar gelince
    /// cagri yeniden denenir (eskiden hata yutuluyor, state "basarili" gorunuyor
    /// ve tekrar eden deger erken donup yeniden denemeyi engelliyordu).
    #[test]
    fn basarisiz_os_mutasyonu_durumu_ve_olayi_degistirmez_yeniden_denenir() {
        let state = AtomicBool::new(true);
        let olaylar = std::cell::Cell::new(0);
        let sonuc = update_window_state(
            &state,
            false,
            || Err("OS hatasi".into()),
            || olaylar.set(olaylar.get() + 1),
        );
        assert_eq!(sonuc, Err("OS hatasi".to_string()));
        assert!(state.load(Ordering::Relaxed), "state degisti");
        assert_eq!(olaylar.get(), 0, "olay yollandi");

        let cagrilar = std::cell::Cell::new(0);
        update_window_state(
            &state,
            false,
            || {
                cagrilar.set(cagrilar.get() + 1);
                Ok(())
            },
            || olaylar.set(olaylar.get() + 1),
        )
        .unwrap();
        assert_eq!(
            cagrilar.get(),
            1,
            "basarisiz denemeden sonra yeniden denenmedi"
        );
        assert_eq!(olaylar.get(), 1);
        assert!(!state.load(Ordering::Relaxed));

        // Deger zaten kayitliysa OS'e hic dokunulmaz.
        update_window_state(&state, false, || panic!("gereksiz OS cagrisi"), || panic!()).unwrap();
    }
}
