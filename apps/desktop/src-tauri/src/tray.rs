//! Sistem tepsisi simgesi: Smith'i "kapatilmayan" bir masaustu varligi yapan
//! katman.
//!
//! Pet penceresi gorev cubugunda YOKTUR (`skipTaskbar`), cercevesizdir ve
//! kapatildiginda gorunmez olur; tepsi bu yuzden tek geri cagirma yuzeyidir.
//! Bu modul uc seyi saglar:
//!
//!   1. Menu: Goster/Gizle, Dashboard'u ac, Mikrofonu sustur, Ekran akisi,
//!      Cikis. Sol tik pet penceresini gosterir/gizler.
//!   2. Only the main pet window hides on close. Dashboard and other windows
//!      close normally. Explicit exit remains available in the tray menu.
//!   3. "Son pencere kapandi" yuzunden surecin sessizce olmesini engeller
//!      (`ExitRequested` filtresi, lib.rs'deki `run` geri cagrisi).
//!
//! GUVENLIK AGI: tepsi kurulamazsa (tepsi sunucusu olmayan masaustu, kaynak
//! hatasi) yukaridaki 2. ve 3. maddeler DEVRE DISI kalir. Aksi halde pencere
//! gizlenir, geri cagirma yuzeyi yoktur ve uygulama gorev yoneticisinden
//! baska yolla kapatilamaz. Bayrak `TRAY_READY`.
//!
//! Mikrofon susturma mantigi YENIDEN YAZILMADI: lib.rs'deki
//! `audio_set_mic_muted` komutunun kendisi cagrilir (ayni mixer durumu, ayni
//! `audio://mixer` olayi). Tepsi yalniz tetikleyicidir.
//!
//! Ekran akisi (surekli ekran paylasimi) ayni desende: tiklama lib.rs'deki
//! `screen_stream_set` komutunu cagirir; isaret, durum baska yerden (HUD
//! dugmesi, `ekran_akisi` sesli araci) degisince de esitlenir. Isaret = ekran
//! akisi acik; Live bagliyken ekran goruntuleri buluta gider.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Listener, Manager, WebviewWindow, Window, WindowEvent};

use crate::audio::DinlemeKipi;
use crate::window::MAIN_LABEL;
use crate::AudioState;

const TRAY_ID: &str = "smith-tray";
const ID_TOGGLE: &str = "tray-toggle";
const ID_DASHBOARD: &str = "tray-dashboard";
const ID_MIC: &str = "tray-mic";
const ID_OWNER: &str = "tray-owner";
const ID_EVERYONE: &str = "tray-everyone";
const ID_NAME: &str = "tray-name";
const ID_SCREEN: &str = "tray-screen";
const ID_QUIT: &str = "tray-quit";

/// Tepsi basariyla kuruldu mu? `false` iken pencere kapatma normal calisir.
static TRAY_READY: AtomicBool = AtomicBool::new(false);

/// Tepsi hazir ve kapatma istekleri gizlemeye cevrilmeli mi?
pub fn is_ready() -> bool {
    TRAY_READY.load(Ordering::Relaxed)
}

/// Tepsi simgesini ve menusunu kurar. Hata durumunda `TRAY_READY` false kalir.
pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let toggle = MenuItemBuilder::with_id(ID_TOGGLE, "Göster / Gizle").build(app)?;
    let dashboard = MenuItemBuilder::with_id(ID_DASHBOARD, "Dashboard'u aç").build(app)?;
    // Onay kutulu madde: isaret = mikrofon SUSTURULMUS. Tiklamada muda isareti
    // kendisi cevirir; asil durum `audio_set_mic_muted`tan okunup yeniden
    // yazilir, UI'dan (HUD) yapilan degisiklikler de `audio://mixer` ile gelir.
    let mic = CheckMenuItemBuilder::with_id(ID_MIC, "Mikrofonu sustur")
        .checked(mic_muted(app))
        .build(app)?;
    // Onay kutulu madde: isaret = surekli ekran akisi ACIK (ekran goruntuleri
    // Live bagliyken buluta gider). Asil durum `audio::akis_acik()`;
    // tiklamada muda isareti kendisi cevirir, komut donusuyle yeniden yazilir.
    let screen = CheckMenuItemBuilder::with_id(ID_SCREEN, "Ekran akışı")
        .checked(crate::audio::akis_acik())
        .build(app)?;
    let listening = [
        (ID_EVERYONE, DinlemeKipi::Herkes, "Herkesi dinle"),
        (ID_OWNER, DinlemeKipi::YalnizBeni, "Yalniz beni dinle"),
        (ID_NAME, DinlemeKipi::Isimle, "Yalniz adimla (oyun modu)"),
    ]
    .into_iter()
    .map(|(id, kip, label)| {
        CheckMenuItemBuilder::with_id(id, label)
            .checked(crate::audio::dinleme_kipi() == kip)
            .build(app)
            .map(|item| (kip, label, item))
    })
    .collect::<Result<Vec<_>, _>>()?;
    let quit = MenuItemBuilder::with_id(ID_QUIT, "Çıkış").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&toggle)
        .item(&dashboard)
        .separator()
        .item(&mic)
        .item(&screen)
        .item(&listening[0].2)
        .item(&listening[1].2)
        .item(&listening[2].2)
        .separator()
        .item(&quit)
        .build()?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("varsayilan pencere simgesi yok (tauri.conf.json bundle.icon)")?;

    let mic_item = mic.clone();
    let screen_item = screen.clone();
    let listening_items = listening.clone();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Smith")
        .menu(&menu)
        // Sol tik menu degil, pencere gosterir/gizler; menu sag tikta.
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            ID_TOGGLE => toggle_main(app),
            ID_DASHBOARD => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = crate::mission::mission_open(app).await {
                        eprintln!("[tray] dashboard acilamadi: {e}");
                    }
                });
            }
            ID_MIC => {
                let muted = !mic_muted(app);
                let view =
                    crate::audio_set_mic_muted(app.clone(), app.state::<AudioState>(), muted);
                // muda isareti kendi cevirdi; gercek durumla esitle.
                let _ = mic_item.set_checked(view.mic_muted);
            }
            ID_SCREEN => {
                let istenen = !crate::audio::akis_acik();
                let gercek = crate::screen_stream_set(app.clone(), istenen);
                // muda isareti kendi cevirdi; gercek durumla esitle.
                let _ = screen_item.set_checked(gercek);
            }
            ID_EVERYONE | ID_OWNER | ID_NAME => {
                let kip = match event.id().as_ref() {
                    ID_OWNER => DinlemeKipi::YalnizBeni,
                    ID_NAME => DinlemeKipi::Isimle,
                    _ => DinlemeKipi::Herkes,
                };
                let kip = crate::listen_mode_set(app.clone(), kip);
                for (mode, _, item) in &listening_items {
                    let _ = item.set_checked(*mode == kip);
                }
            }
            ID_QUIT => crate::window::quit_from(app.clone(), "tepsi"),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main(tray.app_handle());
            }
        })
        .build(app)?;

    // HUD'dan yapilan mikrofon degisikligi tepsi isaretine de yansisin.
    let mic_sync = mic.clone();
    app.listen("audio://mixer", move |ev| {
        if let Some(muted) = parse_mixer_mic_muted(ev.payload()) {
            let _ = mic_sync.set_checked(muted);
        }
    });

    // Ekran akisi baska yerden degisince (HUD dugmesi, sesli arac) isaret
    // esitlensin. Iki kaynak: komutun yaydigi `audio://screen-stream` (Live
    // oturumu olmasa da gelir) ve Live cekirdeginin `audio://tool` sozde-arac
    // olayi (sesli arac degisimi).
    for event in [SCREEN_STREAM_EVENT, TOOL_EVENT] {
        let screen_sync = screen.clone();
        app.listen(event, move |ev| {
            if let Some(acik) = parse_screen_stream_event(event, ev.payload()) {
                let _ = screen_sync.set_checked(acik);
            }
        });
    }

    for event in [crate::LISTEN_MODE_EVENT, TOOL_EVENT] {
        let items = listening.clone();
        app.listen(event, move |ev| {
            if let Some((kip, uyari)) = parse_listening_event(event, ev.payload()) {
                for (mode, label, item) in &items {
                    let _ = item.set_checked(*mode == kip);
                    let text = if *mode == kip && uyari {
                        if kip == DinlemeKipi::Isimle {
                            "adla seslenme algilanamiyor (yerel STT yok)".to_string()
                        } else {
                            format!("{label} (ses dogrulanamadi)")
                        }
                    } else {
                        label.to_string()
                    };
                    let _ = item.set_text(text);
                }
            }
        });
    }
    TRAY_READY.store(true, Ordering::Relaxed);
    Ok(())
}

use crate::SCREEN_STREAM_EVENT;
const TOOL_EVENT: &str = "audio://tool";

/// Ekran akisi olayindan yeni durumu okur; ilgisiz ya da bozuk yukte `None`.
///
/// - `audio://screen-stream`: `{"acik":bool}` (lib.rs `ScreenStreamView`).
/// - `audio://tool`: yalniz sozde-arac `ekran_akisi_durumu`; `durum` degeri
///   `akis_acik` | `akis_kapali` (cekirdek: `audio/live.rs`). Baska arac
///   olaylari ve bilinmeyen `durum` yok sayilir.
fn parse_screen_stream_event(event: &str, payload: &str) -> Option<bool> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    if event == SCREEN_STREAM_EVENT {
        return v.get("acik")?.as_bool();
    }
    if event == TOOL_EVENT {
        if v.get("ad")?.as_str()? != "ekran_akisi_durumu" {
            return None;
        }
        return match v.get("durum")?.as_str()? {
            "akis_acik" => Some(true),
            "akis_kapali" => Some(false),
            _ => None,
        };
    }
    None
}

fn parse_listening_event(event: &str, payload: &str) -> Option<(DinlemeKipi, bool)> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    if event == crate::LISTEN_MODE_EVENT {
        return Some((serde_json::from_value(v["kip"].clone()).ok()?, false));
    }
    if event != TOOL_EVENT || v["ad"] != "dinleme_modu_durumu" {
        return None;
    }
    let kip: DinlemeKipi = serde_json::from_value(v["durum"].clone()).ok()?;
    Some((
        kip,
        kip != DinlemeKipi::Herkes && v["sebep"].as_str().is_some_and(|s| !s.is_empty()),
    ))
}

fn mic_muted(app: &AppHandle) -> bool {
    app.state::<AudioState>().mic_muted.load(Ordering::Relaxed)
}

/// `audio://mixer` yukunden (`MixerView`, camelCase) `micMuted` alanini okur.
fn parse_mixer_mic_muted(payload: &str) -> Option<bool> {
    serde_json::from_str::<serde_json::Value>(payload)
        .ok()?
        .get("micMuted")?
        .as_bool()
}

/// Gorunurse gizler, degilse (veya kucultulmusse) gosterip odaklar.
fn toggle_window(win: &WebviewWindow) {
    let visible = win.is_visible().unwrap_or(false);
    let minimized = win.is_minimized().unwrap_or(false);
    if visible && !minimized {
        let _ = win.hide();
    } else {
        reveal(win);
    }
}

/// Pencereyi one getirir (ikinci baslatma ve tepsi icin ortak).
pub fn reveal(win: &WebviewWindow) {
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
}

fn toggle_main(app: &AppHandle) {
    match app.get_webview_window(MAIN_LABEL) {
        Some(win) => toggle_window(&win),
        None => eprintln!("[tray] '{MAIN_LABEL}' penceresi yok"),
    }
}

/// Ikinci baslatma geri cagrisi: mevcut ana pencereyi gosterir.
pub fn show_main(app: &AppHandle) {
    match app.get_webview_window(MAIN_LABEL) {
        Some(win) => reveal(&win),
        None => eprintln!("[tray] '{MAIN_LABEL}' penceresi yok"),
    }
}

/// Pencere kapatma istegi gizlemeye cevrilmeli mi? Yalniz tepsi hazirken (aksi
/// halde geri cagirma yuzeyi yoktur, bkz. modul basligi: guvenlik agi).
fn should_hide_on_close(label: &str, tray_ready: bool) -> bool {
    label == MAIN_LABEL && tray_ready
}

/// Surec cikisi engellenmeli mi? `code: None` = "son pencere kapandi" (Tauri'nin
/// kendiliginden istedigi cikis); `Some(_)` = acik `app.exit(code)` (tepsi
/// Cikis, `window_quit`) ve ENGELLENMEZ.
fn should_prevent_exit(tray_ready: bool, code: Option<i32>) -> bool {
    tray_ready && code.is_none()
}

/// Kapatma istegini gizlemeye cevirir. Tepsi kurulu degilse DOKUNMAZ (bkz.
/// modul basligi: guvenlik agi). lib.rs `on_window_event`inden cagrilir.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if should_hide_on_close(window.label(), is_ready()) {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

/// `RunEvent::ExitRequested` filtresi: uygunsa cikisi engeller. lib.rs `run`
/// geri cagrisindan cagrilir.
pub fn on_exit_requested(api: &tauri::ExitRequestApi, code: Option<i32>) {
    if should_prevent_exit(is_ready(), code) {
        api.prevent_exit();
    }
}

/// Tek ornek kilidi acik mi? Gelistirme (debug) derlemesi kilitlenmez: kalici
/// paketli exe tepside calisirken `tauri dev` baslatan gelistirici, dev sureci
/// sessizce cikip eski pencereyi gormekten kurtulur. `SMITH_ALLOW_MULTI=1`
/// release'te de kilidi kapatir (iki surec ayni mikrofonu acabilir; bilincli).
pub fn single_instance_enabled(debug_build: bool, allow_multi: bool) -> bool {
    !debug_build && !allow_multi
}

#[cfg(test)]
mod tests {
    #[test]
    fn uc_kip_gercek_komut_yuku_ve_oyun_modu_uyarisi() {
        for kip in [
            DinlemeKipi::Herkes,
            DinlemeKipi::YalnizBeni,
            DinlemeKipi::Isimle,
        ] {
            let json = serde_json::to_string(&crate::ListeningModeView { kip }).unwrap();
            assert_eq!(
                parse_listening_event(crate::LISTEN_MODE_EVENT, &json),
                Some((kip, false))
            );
        }
        assert_eq!(
            parse_listening_event(
                TOOL_EVENT,
                r#"{"ad":"dinleme_modu_durumu","durum":"isimle","sebep":"adla seslenme algilanamiyor (yerel STT yok)"}"#
            ),
            Some((DinlemeKipi::Isimle, true))
        );
        assert_eq!(
            parse_listening_event(crate::LISTEN_MODE_EVENT, r#"{"kip":"bozuk"}"#),
            None
        );
    }

    #[test]
    fn a2_dinleme_komutu_sesli_arac_ve_uyari_esitlenir() {
        assert_eq!(
            parse_listening_event(crate::LISTEN_MODE_EVENT, r#"{"kip":"yalniz_beni"}"#),
            Some((DinlemeKipi::YalnizBeni, false))
        );
        assert_eq!(
            parse_listening_event(
                TOOL_EVENT,
                r#"{"ad":"dinleme_modu_durumu","durum":"yalniz_beni","sebep":"ses dogrulanamadi"}"#
            ),
            Some((DinlemeKipi::YalnizBeni, true))
        );
        assert_eq!(
            parse_listening_event(
                TOOL_EVENT,
                r#"{"ad":"dinleme_modu_durumu","durum":"herkes"}"#
            ),
            Some((DinlemeKipi::Herkes, false))
        );
        for payload in [
            "{",
            r#"{"ad":"ekran_akisi_durumu","durum":"yalniz_beni"}"#,
            r#"{"ad":"dinleme_modu_durumu","durum":"bozuk"}"#,
        ] {
            assert_eq!(parse_listening_event(TOOL_EVENT, payload), None);
        }
    }
    use super::*;

    /// `audio://mixer` WIRE SOZLESMESI: lib.rs `MixerView` camelCase yollar.
    /// Alan adi degisirse tepsi isareti sessizce senkronu kaybeder.
    #[test]
    fn mixer_yukunden_mikrofon_durumu_okunur() {
        assert_eq!(
            parse_mixer_mic_muted(r#"{"micMuted":true,"outputMuted":false,"outputVolume":0.8}"#),
            Some(true)
        );
        assert_eq!(
            parse_mixer_mic_muted(r#"{"micMuted":false,"outputMuted":true,"outputVolume":0.0}"#),
            Some(false)
        );
    }

    #[test]
    fn bozuk_veya_eksik_yuk_yok_sayilir() {
        assert_eq!(parse_mixer_mic_muted("{"), None);
        assert_eq!(parse_mixer_mic_muted(r#"{"outputMuted":true}"#), None);
        assert_eq!(parse_mixer_mic_muted(r#"{"micMuted":"evet"}"#), None);
        assert_eq!(parse_mixer_mic_muted(""), None);
    }

    /// Gercek `MixerView` serilestirmesi ile ayristirici ayni sozlesmede
    /// kalmali (iki tarafin da kayma yapmasini yakalar).
    #[test]
    fn mixer_view_serilestirmesi_ayristirilabilir() {
        let view = crate::MixerView {
            mic_muted: true,
            output_muted: false,
            output_volume: 0.5,
        };
        let json = serde_json::to_string(&view).expect("serilesir");
        assert_eq!(parse_mixer_mic_muted(&json), Some(true));
    }

    /// Gercek `ScreenStreamView` / `ToolEvent` serilestirmesi ile ayristirici
    /// ayni sozlesmede kalmali (alan adi kaymasi tepsi isaretini sessizce bozar).
    #[test]
    fn ekran_akisi_olaylari_gercek_yuklerle_ayristirilir() {
        for acik in [true, false] {
            let json = serde_json::to_string(&crate::ScreenStreamView { acik }).expect("serilesir");
            assert_eq!(
                parse_screen_stream_event(SCREEN_STREAM_EVENT, &json),
                Some(acik),
                "{json}"
            );
        }
        for (durum, beklenen) in [("akis_acik", true), ("akis_kapali", false)] {
            let json = serde_json::to_string(&crate::ToolEvent {
                ad: "ekran_akisi_durumu".into(),
                durum,
                sebep: Some(format!("{{\"akis_acik\":{beklenen}}}")),
            })
            .expect("serilesir");
            assert_eq!(
                parse_screen_stream_event(TOOL_EVENT, &json),
                Some(beklenen),
                "{json}"
            );
        }
    }

    #[test]
    fn ilgisiz_ya_da_bozuk_ekran_akisi_olayi_yok_sayilir() {
        let tool = |ad: &str, durum: &str| format!(r#"{{"ad":"{ad}","durum":"{durum}"}}"#);
        // Baska arac olayi ayni durum degeriyle bile isareti degistirmez.
        assert_eq!(
            parse_screen_stream_event(TOOL_EVENT, &tool("hafizada_ara", "akis_acik")),
            None
        );
        // Bilinmeyen durum (surum uyumsuzlugu) yok sayilir.
        assert_eq!(
            parse_screen_stream_event(TOOL_EVENT, &tool("ekran_akisi_durumu", "belirsiz")),
            None
        );
        // Baglanti hatasi sozde-araci ekran isaretine dokunmaz.
        assert_eq!(
            parse_screen_stream_event(TOOL_EVENT, &tool("live_baglanti", "hata")),
            None
        );
        assert_eq!(parse_screen_stream_event(SCREEN_STREAM_EVENT, "{"), None);
        assert_eq!(
            parse_screen_stream_event(SCREEN_STREAM_EVENT, r#"{"acik":"evet"}"#),
            None
        );
        assert_eq!(
            parse_screen_stream_event("audio://mixer", r#"{"kip":"yalniz_beni"}"#),
            None
        );
    }

    #[test]
    fn tepsi_kurulmadan_kapatma_gizlemeye_cevrilmez() {
        // Bu test surecinde setup() hic cagrilmaz: bayrak false olmali.
        assert!(!is_ready());
        assert!(!should_hide_on_close(MAIN_LABEL, is_ready()));
    }

    #[test]
    fn kapatma_yalniz_tepsi_hazirken_gizlenir() {
        assert!(should_hide_on_close(MAIN_LABEL, true));
        assert!(!should_hide_on_close(MAIN_LABEL, false));
        assert!(!should_hide_on_close(crate::mission::MISSION_LABEL, true));
        assert!(!should_hide_on_close(crate::mission::MISSION_LABEL, false));
        assert!(!should_hide_on_close("other", true));
    }

    #[test]
    fn cikis_istegi_yalniz_son_pencere_kapanisinda_engellenir() {
        // Son pencere kapandi (kod yok) + tepsi hazir -> surec yasar.
        assert!(should_prevent_exit(true, None));
        // Acik cikis (tepsi Cikis / window_quit) ASLA engellenmez.
        assert!(!should_prevent_exit(true, Some(0)));
        assert!(!should_prevent_exit(true, Some(1)));
        // Tepsi yoksa eski davranis: son pencere kapaninca uygulama biter.
        assert!(!should_prevent_exit(false, None));
        assert!(!should_prevent_exit(false, Some(0)));
    }

    #[test]
    fn tek_ornek_kilidi_yalniz_release_ve_kacis_kapisi_yokken_acik() {
        assert!(single_instance_enabled(false, false));
        assert!(!single_instance_enabled(true, false), "debug kilitlenmez");
        assert!(
            !single_instance_enabled(false, true),
            "SMITH_ALLOW_MULTI kilidi kapatir"
        );
        assert!(!single_instance_enabled(true, true));
    }
}
