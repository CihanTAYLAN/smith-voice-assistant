// Smith masaustu host'u (Tauri 2).
//
// Ses alt sistemi: mikrofon → seviye olcumu (UI) + Gemini Live oturumu
// (speech-to-speech). TEK ses motoru Live'dir; yedek hat YOKTUR.
//
// TARIH — basamakli hat (VAD→STT→LLM→TTS) 2026-08-17'de SOKULDU. Neden: Live'a
// gecildikten sonra (ADR 0009) o hat ulasilamaz hale gelmisti — tek cagirani
// "Live basarisiz olursa" daliydi, renderer surucusu (`useTts.ts`) silinmisti ve
// `tts_feed`/`tts_flush`/`tts_cancel`/`audio_stt_status`/`audio_download_model`
// komutlarinin frontend'de SIFIR cagirani vardi. ~2300 satir + 38 test + whisper
// (cmake/libclang/GGML) derleme yuku hicbir seyi korumuyordu.
// Geri getirmek isteyen bilincli bir is yapar: renderer surucusu + TTS/STT
// modulleri birlikte yazilir; bir bayragi cevirmek yetmez.

// `pub`: examples/ altindaki tani binary'leri (or. zihin) ayni kodu
// kullanabilsin — teshis kopya implementasyonla degil, gercek yolla yapilir.
pub mod audio;
// Yerel sistem erisimi (terminal, uygulama, donanim, ses). Kullanici mandasi
// 2026-08-13: Smith kurulu oldugu makinenin tum kaynaklarina erisir. `pub`:
// Live arac koprusu (audio::live) buradan cagirir.
pub mod system_tools;
// Acilis baglami: oturum acilirken olculen anlik ortam fotografi (saat, OS,
// donanim, disk, acik uygulamalar, odaktaki pencere, ag, yigin). Kullanici
// mandasi 2026-08-15: Smith her ayaga kalktiginda ortami BILEREK dogar.
// `pub`: canli sonda (examples/boot_probe) ve audio::live buradan cagirir.
// Bayrak env degiskenlerinin TEK semantigi. Denetimde ayni crate'te dort ayri
// lehce bulundu ve ucu sessiz tuzak uretiyordu (bkz. modul basligi).
pub mod boot_context;
mod proactive_memory;
// Claude Code + Codex oturum kayitlarini OKUR (kullanici mandasi 2026-08-17:
// "Smith'in Claude Code ve Codex oturumlarimi da kontrol edebilmesini
// istiyorum"). `system_tools`'tan AYRI: oradaki is makineyle konusmak, buradaki
// is iki kayit formatini ayristirip sonucu bir GIZLILIK butcesine sigdirmak.
// Varsayilan olarak konusma icerigi DONDURMEZ; gerekcesi modul basliginda.
pub mod agent_sessions;
// Smith'in kendi kodunu Claude Code araciligiyla duzenlemesi (kullanici mandasi
// 2026-08-17). Yetenegin sinirlari kodda: repo disinda worktree + yeni dal,
// merge/push YOK, ajana kabuk araci verilmez, sahip kanidi sart, varsayilan
// KAPALI. Gerekcesi modul basliginda.
pub mod code_agent;
mod context_exclude;
mod env_file;
mod env_flag;
// Smith durum dosyalarinin TEK veri koku (SMITH_DATA_DIR ya da ~/.smith); AppData
// tabanli yol yok. Gerekce modul basliginda.
mod paths;
// Gateway HTTP istemcisi: taban + token onbellegi. Iki tuketici var (Live arac
// koprusu ve Mission Control panosu), bu yuzden tek yerde durur.
pub mod gateway;
// Smith Dashboard penceresi: gorev panosu + dosyalar + bilgi grafigi +
// hafiza; `/v1/mission/*` + hafiza OKUMA uclari ile sinirli kopru
// (ADR 0007). Webview kimlik gormez; cagri Rust'tan gecer.
pub mod mission;
// Dashboard'un Rust komutlari: boot nobeti (beyaz ekran watchdog'u), dosya
// yoneticisi (izinli kokler + mtime catisma kapisi), vault bilgi grafigi.
pub mod dashboard;
// Pencere davranisi: cercevesiz + seffaf + masaustunde serbest dolasan pet.
// Kullanici mandasi 2026-08-14. Ses/arac mantigindan tamamen ayri tutuldu.
pub mod window;
// Sistem tepsisi: pet penceresinin tek geri cagirma yuzeyi + "kapat = gizle"
// davranisi. Uygulama kalici (hep acik) calisir; gercek cikis yalniz buradan.
mod time_util;
mod tray;
// Hatirlatma teslim dongusu: gateway'de vadesi gelenleri yoklar, masaustu
// bildirimi + sesli sistem bildirimi verir (kurma/listeleme Live araclarinda).
mod reminders;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use audio::{list_input_devices, AudioSource, CpalAudioSource, OutputGain, Playback};

#[derive(Default)]
struct AudioState {
    source: Mutex<SourceState>,
    /// Mixer mikrofon kapisi: true iken yakalanan ses oturuma GONDERILMEZ
    /// (yerine ayni uzunlukta sessizlik beslenir; akis surekliligi ve
    /// konusma-bitisi tespiti korunur, oturum ayakta kalir). `audio_stop`un
    /// aksine oturumu KAPATMAZ. Oturumlar arasi yasar.
    mic_muted: Arc<AtomicBool>,
    /// Mixer cikis kazanci: her `Playback` ayni Arc'i kullanir; stream kopsa
    /// da kurtarma ayni düzey/susturma durumunu surdurur (bkz. `OutputGain`).
    output_gain: Arc<OutputGain>,
}

/// Mikrofon kaynagi ve gecis durumu. Surucu acma/kapama (takilabilir) bu
/// kilidin DISINDA kosar; kilit yalniz asagidaki bayraklari degistirir. Boylece
/// bir surucu takilsa da `audio_start`/`audio_stop` kilitlenmez, acik hata doner.
#[derive(Default)]
struct SourceState {
    source: Option<Box<dyn AudioSource>>,
    /// Surucu aciliyor: ikinci acilis ve kapanis reddedilir.
    opening: bool,
    /// Surucu kapaniyor: yeni acilis kapanis bitene kadar reddedilir.
    stopping: bool,
    /// Acilis surerken `stop` istendi: acilan kaynak hemen kapatilir.
    cancelled: bool,
    /// Live oturumunun mikrofon gorevini durdurur: surucu thread'i takilsa bile
    /// yayin kanali ona bagli kalmaz, oturum kapanir.
    cancel: Option<tokio::sync::oneshot::Sender<()>>,
}

impl AudioState {
    /// Mikrofonu kilit disinda acar. `start`, kilit disinda calisan ve iptal
    /// sinyali (`cancel`) alan acilis islemidir; sonuc kilit altinda islenir.
    fn start_source(
        &self,
        start: impl FnOnce(tokio::sync::oneshot::Receiver<()>) -> Result<Box<dyn AudioSource>, String>,
    ) -> Result<(), String> {
        let rx = {
            let mut state = self.source.lock().map_err(|_| "state kilidi")?;
            if state.opening || state.stopping {
                return Err("ses surucusu islemi devam ediyor".into());
            }
            if state.source.is_some() {
                return Ok(());
            }
            let (tx, rx) = tokio::sync::oneshot::channel();
            state.opening = true;
            state.cancelled = false;
            state.cancel = Some(tx);
            rx
        };
        let result = start(rx);
        let mut state = self.source.lock().map_err(|_| "state kilidi")?;
        state.opening = false;
        match result {
            Ok(source) if !state.cancelled => {
                state.source = Some(source);
                Ok(())
            }
            Ok(source) => {
                state.stopping = true;
                drop(state);
                let stopped = source.stop();
                self.source.lock().map_err(|_| "state kilidi")?.stopping = false;
                stopped.map_err(|e| e.to_string())?;
                Err("ses baslatma iptal edildi".into())
            }
            Err(e) => {
                state.cancel.take();
                Err(e)
            }
        }
    }

    /// Mikrofonu ve Live oturumunun mikrofon gorevini durdurur. Surucu kapanisi
    /// kilit disinda ve sureli: zaman asiminda `Err` doner, durum yine tutarlidir
    /// (kaynak birakilmis sayilir). Eski surucu donene kadar yeni acilis
    /// `SurucuRezervasyonu` ile acik hata verir.
    fn stop_source(&self) -> Result<(), String> {
        let (source, cancel) = {
            let mut state = self.source.lock().map_err(|_| "state kilidi")?;
            if state.stopping {
                return Err("ses surucusu kapatiliyor".into());
            }
            state.cancelled = true;
            let source = state.source.take();
            state.stopping = source.is_some();
            (source, state.cancel.take())
        };
        if let Some(cancel) = cancel {
            let _ = cancel.send(());
        }
        if let Some(source) = source {
            let result = source.stop();
            self.source.lock().map_err(|_| "state kilidi")?.stopping = false;
            result.map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[derive(Clone, Serialize)]
struct LevelEvent {
    rms: f32,
    peak: f32,
}

/// Live oturumundan UI'a giden konusma parcasi. `role`: "user" | "assistant".
/// `interrupted` true iken metin bostur ve UI calan cevabi kesik isaretler.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveTurn {
    role: String,
    text: String,
    interrupted: bool,
}

impl LiveTurn {
    fn user(text: String) -> Self {
        Self {
            role: "user".into(),
            text,
            interrupted: false,
        }
    }
    fn assistant(text: String) -> Self {
        Self {
            role: "assistant".into(),
            text,
            interrupted: false,
        }
    }
    fn interrupted() -> Self {
        Self {
            role: "assistant".into(),
            text: String::new(),
            interrupted: true,
        }
    }
}

/// Ses izi karari (`audio://speaker`). `karar`: "owner" | "unknown" | "foreign".
/// UI hafizaya yazma yetkisini bundan turetir; yazma denemesi beklemez.
#[derive(Clone, Serialize)]
struct SpeakerStatus {
    karar: &'static str,
}

/// Ekran paylasimi durumu (`audio://screen`). Alan adlari Turkce — `ToolEvent`
/// ile ayni sozlesme; UI birebir bunlari okuyor.
#[derive(Clone, Serialize)]
struct ScreenStatus {
    aktif: bool,
    /// Kareler arasi bekleme; UI "2 sn'de bir kare" diye gosterebilir.
    #[serde(rename = "aralikMs")]
    aralik_ms: u64,
}

#[derive(Clone, Serialize)]
struct LiveStatus {
    connected: bool,
}

/// Live durumunun tek kaynagi. Olay kacirilsa veya webview yeniden yuklense de
/// `live_status_get` ayni atomikten anlik goruntuyu verir.
static LIVE_CONNECTED: AtomicBool = AtomicBool::new(false);

fn live_status_view(source: &AtomicBool) -> LiveStatus {
    LiveStatus {
        connected: source.load(Ordering::Acquire),
    }
}

fn live_status_yay(app: &AppHandle, connected: bool) {
    LIVE_CONNECTED.store(connected, Ordering::Release);
    let _ = app.emit("audio://live-status", live_status_view(&LIVE_CONNECTED));
}

#[tauri::command]
fn live_status_get() -> LiveStatus {
    live_status_view(&LIVE_CONNECTED)
}

/// `audio://tool` — Smith'in su an hangi araci calistirdigini UI'a bildirir.
///
/// NEDEN: arac cagrilari yalniz stderr'e basiliyordu; kullanici Smith'in
/// terminal mi kostugunu, internete mi ciktigini, yoksa ses izi kapisinin
/// engelledigini goremiyordu — sessizlik "takildi" gibi okunuyordu.
///
/// ALAN ADLARI TURKCE VE SABIT: React tarafi bunlari birebir okuyor
/// (`ad` / `durum` / `sebep`), bu yuzden `rename_all` YOK. `durum` degerleri
/// `basladi` | `bitti` | `reddedildi`; `sebep` yalniz `reddedildi`de dolu ve
/// None iken alan hic serilesmez (UI'da `undefined`).
#[derive(Clone, Serialize)]
struct ToolEvent {
    ad: String,
    durum: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    sebep: Option<String>,
}

#[tauri::command]
fn audio_devices() -> Result<Vec<String>, String> {
    list_input_devices().map_err(|e| e.to_string())
}

#[tauri::command]
fn audio_start(
    app: AppHandle,
    state: State<'_, AudioState>,
    device: Option<String>,
) -> Result<(), String> {
    // Surucu acilisi `AudioState` kilidinin DISINDA ve sureli kosar (bkz. `start_source`).
    state.start_source(|cancel| {
        let source = CpalAudioSource::start(device).map_err(|e| e.to_string())?;
        let rx_level = source.subscribe();
        let rx_pipe = source.subscribe();
        let input_name = source.device_name.clone();
        spawn_level_meter(app.clone(), rx_level);

        // SMITH_LIVE: ses motorunun ACMA/KAPAMA anahtari. Bu bir "motor secimi"
        // DEGIL: basamakli hat 2026-08-17'de sokuldu, Live tek motordur ve kapaliyken
        // geriye yalnizca UI seviye gostergesi kalir (hicbir ses makineden cikmaz).
        // VARSAYILAN ACIK (2026-08-15 denetimi): eskiden tanimsiz `SMITH_LIVE`
        // Live'i KAPATIYORDU, yani `dev-win.ps1` dot-source edilmeden `tauri dev`
        // kosan biri YAPISAL OLARAK SESSIZ bir Smith aliyordu, tek belirti bir
        // eprintln'di. Kardes bayraklarin (`SMITH_LIVE_RESUME`,
        // `SMITH_CONVERSATION_MEMORY`, `SMITH_BOOT_CONTEXT`) sozlesmesi de bu.
        if !env_flag::acik_varsayilan_acik("SMITH_LIVE") {
            eprintln!(
                "[live] SMITH_LIVE=0 -> SES MOTORU KAPALI. Yalniz mikrofon seviyesi \
                 olculur; Smith DUYMAZ ve KONUSMAZ (basamakli yedek hat 2026-08-17'de \
                 sokuldu). Acmak icin SMITH_LIVE=1."
            );
            return Ok(Box::new(source));
        }

        if let Err(e) = spawn_live(
            &app,
            rx_pipe,
            state.mic_muted.clone(),
            state.output_gain.clone(),
            input_name,
            cancel,
        ) {
            // GERI DUSULECEK HAT YOK. Bu hatayi yutmak, bu depoda saatlere mal olan
            // "acildi ama duymuyor" tuzaginin aynisidir; bu yuzden UC yerden birden
            // bildirilir ve komut Err doner.
            //
            // (1) Mikrofonu BIRAK. Acik kalirsa `start_source`un idempotans kisa
            //     yolu ikinci denemeyi SESSIZCE basarili sayar ve Live bir daha HIC
            //     kurulmaz.
            let stopped = Box::new(source).stop();
            // (2) Kullanici yuzeyi: Live gostergesini "bagli degil"e cek (UI bu olayi
            //     zaten dinliyor) + `audio_start` Err'i `useMicLevel`'in hata
            //     satirinda gorunur.
            live_status_yay(&app, false);
            // (3) Log.
            eprintln!("[live] BASLATILAMADI: {e}");
            let kapanis = stopped
                .err()
                .map(|e| format!(" Mikrofon kapanisi: {e}."))
                .unwrap_or_default();
            return Err(format!(
                "Ses motoru (Gemini Live) baslatilamadi: {e}. Yedek hat YOK. \
                 Muhtemel sebep: SMITH_GEMINI_KEY yok/gecersiz veya ag erisimi.{kapanis}"
            ));
        }
        Ok(Box::new(source))
    })
}

/// Live oturumunu kurar: cihaz karelerini oturuma akitir, donen sesi playback'e
/// verir, transkripsiyonlari UI'a `audio://live` ile bildirir.
///
/// `mic_muted` ve `output_gain`: mixer'in oturumlar arasi yasayan iki
/// tutamaci — mikrofon kapisi ve cikis kazanci. Ikisi de `AudioState`ten
/// klonlanip buraya verilir; sahipligi oturum alir, KAYNAK AudioState'te kalir.
fn spawn_live(
    app: &AppHandle,
    mut rx: tokio::sync::broadcast::Receiver<audio::AudioFrame>,
    mic_muted: Arc<AtomicBool>,
    output_gain: Arc<OutputGain>,
    input_name: audio::CihazAdi,
    mut cancel: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), String> {
    use audio::{LiveEvent, LiveSession, LIVE_OUT_RATE};

    let (ev_tx, mut ev_rx) = tokio::sync::mpsc::unbounded_channel::<LiveEvent>();
    let session = LiveSession::start(ev_tx)?;

    // Playback: TTS hattiyla ayni cikis (tek cihaz sahibi) — Live sesi de
    // oradan calar, boylece barge-in'de tek yerden temizlenir.
    let mut playback = Playback::start(output_gain).map_err(|e| e.to_string())?;
    if let Some(status_rx) = playback.take_status() {
        let app_status = app.clone();
        std::thread::spawn(move || {
            while let Ok(status) = status_rx.recv() {
                let _ = app_status.emit("audio://playback-status", status);
            }
        });
    }
    let sink = playback.sink();
    // Hoparlorde eski yarim-dupleks korumasi, kulaklikta soz kesme serbest.
    let echo_ref = playback.reference();
    let output_name = playback.device_name.clone();
    let echo_gate = audio::YankiPolitikasi::parse(std::env::var("SMITH_ECHO_GATE").ok().as_deref());
    {
        let input = input_name.lock().unwrap_or_else(|e| e.into_inner());
        let output = output_name.lock().unwrap_or_else(|e| e.into_inner());
        let acik = echo_gate.etkin_mi(&input, &output);
        let durum = if acik { "ACIK" } else { "KAPALI" };
        if echo_gate == audio::YankiPolitikasi::Auto {
            let cihaz = if acik { "hoparlor" } else { "kulaklik" };
            eprintln!("[audio] yanki kapisi: {durum} ({cihaz}: {output})");
        } else {
            eprintln!("[audio] yanki kapisi: {durum} (SMITH_ECHO_GATE ile zorlandi)");
        }
    }

    // 1. Mikrofon -> oturum (echo kapisiyla).
    tauri::async_runtime::spawn(async move {
        let mut karar = audio::YankiKarari::default();
        loop {
            let frame = tokio::select! {
                _ = &mut cancel => break,
                frame = rx.recv() => frame,
            };
            match frame {
                Ok(frame) => {
                    // Kurtarmada secilen cihaz adlari tazelenir. Susturma her
                    // kipte ustundur; kapali kare PCM'i asla disari cikmaz.
                    let kapali = karar.mikrofon_kapali_mi(
                        echo_gate,
                        &input_name.lock().unwrap_or_else(|e| e.into_inner()),
                        &output_name.lock().unwrap_or_else(|e| e.into_inner()),
                        echo_ref.is_playing(),
                        mic_muted.load(Ordering::Relaxed),
                    );
                    if kapali {
                        let silent: std::sync::Arc<[f32]> =
                            vec![0.0f32; frame.samples.len()].into();
                        session.feed(silent, frame.sample_rate, true);
                    } else {
                        session.feed(frame.samples, frame.sample_rate, false);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
        // session burada drop olur → WS kapanir.
    });

    // 2. Oturum -> hoparlor + UI.
    let app_ev = app.clone();
    std::thread::spawn(move || {
        let _playback = playback; // stream'i canli tut
        while let Some(ev) = ev_rx.blocking_recv() {
            match ev {
                LiveEvent::Audio(samples) => sink.enqueue_live(&samples, LIVE_OUT_RATE),
                LiveEvent::Interrupted => {
                    // Kullanici sozu kesti: kuyruktaki sesi ANINDA at, yoksa
                    // Smith kullanicinin uzerine konusmaya devam eder.
                    sink.clear(audio::PlaybackClearReason::Interrupted);
                    let _ = app_ev.emit("audio://live", LiveTurn::interrupted());
                }
                // TESHIS: konusma metnini log'a da yaz. Onceden yalniz arac
                // cagrilari loglaniyordu; "Smith yanlis anladi / cevap kotu"
                // sikayetlerinde ne soylendigini ve ne cevaplandigini GOREMIYOR,
                // kor tahmin yapiyordum. AMA tam metin log'da ikinci, kalici bir
                // kopyadir (parola, musteri adi): yalniz `SMITH_LOG_TRANSCRIPT`
                // acikken (debug derlemede varsayilan acik, release'de kapali)
                // yazilir; kapaliyken yalniz uzunluk (bkz. `audio::log_transcript`).
                LiveEvent::UserText(t) => {
                    audio::log_transcript("sen", &t);
                    let _ = app_ev.emit("audio://live", LiveTurn::user(t));
                }
                LiveEvent::AssistantText(t) => {
                    audio::log_transcript("smith", &t);
                    let _ = app_ev.emit("audio://live", LiveTurn::assistant(t));
                }
                LiveEvent::Connected(ok) => {
                    live_status_yay(&app_ev, ok);
                    // Ekran bayragi oturumdan bagimsizdir; baglanti kopunca
                    // tercih kapanmaz. UI aktarimi Live durumuyla ayirir.
                    if ok {
                        let _ = app_ev.emit(
                            "audio://screen",
                            ScreenStatus {
                                aktif: audio::screen_enabled(),
                                aralik_ms: audio::screen_interval_ms(),
                            },
                        );
                    }
                }
                // SES IZI KARARI → UI "Hafiza" gostergesi. Eskiden gosterge
                // ancak bir YAZMA denemesi gozlenince konusabiliyordu ve
                // pratikte "—" kaliyordu (kullanici hakli olarak "dogru
                // calismiyor" dedi). Karar her ifadede zaten hesaplaniyor;
                // dogrudan bildirmek gostergeyi gercege baglar.
                LiveEvent::Speaker(v) => {
                    eprintln!("[speaker] karar -> {v}");
                    let _ = app_ev.emit("audio://speaker", SpeakerStatus { karar: v });
                }
                // Arac gorunurlugu. Log'a da yazilir: UI kapaliyken (veya
                // emit basarisizken) teshis izi kaybolmasin.
                LiveEvent::Tool { ad, durum, sebep } => {
                    match sebep.as_deref() {
                        Some(s) => eprintln!("[arac] {ad} {durum} — {s}"),
                        None => eprintln!("[arac] {ad} {durum}"),
                    }
                    let _ = app_ev.emit("audio://tool", ToolEvent { ad, durum, sebep });
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn audio_stop(state: State<'_, AudioState>) -> Result<(), String> {
    state.stop_source()
}

// --- MIXER: mikrofon kapisi + cikis kazanci -------------------------------
//
// NEDEN AYRI KOMUTLAR: tek `sustur` dugmesi TUM ses hattini (mikrofon + Live
// oturumu) kapatıyordu; kullanici ise bunlari AYRI yonetmek istedi ("mikrofonumu
// kapatabilecegim, ses düzeyini yonetebilecegim bir karistirici"). Mixer
// durumu AudioState'te yasar, oturum kapansa da korunur.

/// Mixer durumu — UI'a giden tek goruntu (hem komut yaniti hem `audio://mixer`
/// olayi). Alanlar camelCase: React tarafi `micMuted` / `outputMuted` /
/// `outputVolume` okur; bu bir WIRE SOZLESMESI, degistirirken UI'i de ara.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MixerView {
    mic_muted: bool,
    output_muted: bool,
    output_volume: f32,
}

fn mixer_view(state: &AudioState) -> MixerView {
    MixerView {
        mic_muted: state.mic_muted.load(Ordering::Relaxed),
        output_muted: state.output_gain.muted(),
        output_volume: state.output_gain.volume(),
    }
}

/// Mixer'in guncel durumu (UI acilista ve hot-reload sonrasi sorar; Rust
/// tarafi kaynak dogrudur).
#[tauri::command]
fn audio_mixer_state(state: State<'_, AudioState>) -> MixerView {
    mixer_view(&state)
}

/// Mikrofon kapisi: acikken yakalanan ses oturuma SESSIZLIK olarak beslenir.
/// Oturumu KAPATMAZ (o is `audio_stop`ta) — Smith duymayi birakir, oturum ve
/// konusma devam eder. Seviye gostergesi etkilenmez: mikrofon hala calisiyor,
/// yalnizca oturuma gitmiyor.
#[tauri::command]
fn audio_set_mic_muted(app: AppHandle, state: State<'_, AudioState>, muted: bool) -> MixerView {
    state.mic_muted.store(muted, Ordering::Relaxed);
    let view = mixer_view(&state);
    let _ = app.emit("audio://mixer", view.clone());
    view
}

/// Cikis sesi susturma (Smith'in sesi). Kaydirici düzeyi EZILMEZ; susturma
/// kaldirilinca ayni düzey geri gelir (bkz. `OutputGain`).
#[tauri::command]
fn audio_set_output_muted(app: AppHandle, state: State<'_, AudioState>, muted: bool) -> MixerView {
    state.output_gain.set_muted(muted);
    let view = mixer_view(&state);
    let _ = app.emit("audio://mixer", view.clone());
    view
}

/// Cikis ses düzeyi (0.0..=1.0). Kirpma Rust'ta yapilir
/// (`OutputGain::set_volume`) — UI'a guvenilmez.
#[tauri::command]
fn audio_set_output_volume(app: AppHandle, state: State<'_, AudioState>, volume: f32) -> MixerView {
    state.output_gain.set_volume(volume);
    let view = mixer_view(&state);
    let _ = app.emit("audio://mixer", view.clone());
    view
}

// --- EKRAN AKISI: surekli ekran paylasimi acik/kapali -----------------------
//
// Ekran goruntuleri buluta (Gemini Live) gider; bu yuzden acik/kapali durumu
// kullanicinin elinde ve HER an gorunur olmali (HUD dugmesi + tepsi maddesi).
// Kaynak gercegi `audio::screen` icindeki calisma zamani bayragidir (ilk
// degeri `SMITH_SCREEN` env'inden alir); Live cekirdegi ayni bayragi ekran
// dongusunde yoklar ve oturum aciksa degisimi `audio://tool` sozde-arac olayi
// (`ekran_akisi_durumu`) olarak da bildirir. Oturum YOKKEN o olay gelmeyecegi
// icin komut kendi olayini yayar: HUD ve tepsi oturumdan bagimsiz esitlenir.

/// Ekran akisi degisim olayi (`audio://screen-stream`). Alan adi `acik`
/// (camelCase tek kelime): React `useScreenStream` ve tepsi birebir bunu okur.
#[derive(Clone, Serialize)]
struct ScreenStreamView {
    acik: bool,
}

/// `audio://screen-stream` olayinin adi; tepsi ayni sabiti dinler.
pub(crate) const SCREEN_STREAM_EVENT: &str = "audio://screen-stream";

/// Ekran akisinin guncel durumu (UI acilista ve hot-reload sonrasi sorar).
#[tauri::command]
fn screen_stream_get() -> bool {
    audio::akis_acik()
}

/// Surekli ekran akisini ac/kapat. Donen deger UYGULANAN durumdur (otoriter);
/// ayni deger `audio://screen-stream` olayiyla da yayilir ki tepsi ve HUD
/// birbirinin degisimini gorsun.
#[tauri::command]
fn screen_stream_set(app: AppHandle, acik: bool) -> bool {
    audio::akis_ayarla(acik);
    let aktif = audio::akis_acik();
    let _ = app.emit(SCREEN_STREAM_EVENT, ScreenStreamView { acik: aktif });
    aktif
}

pub(crate) const LISTEN_MODE_EVENT: &str = "audio://listen-mode";

#[derive(Clone, serde::Serialize)]
struct ListeningModeView {
    kip: audio::DinlemeKipi,
}

#[tauri::command]
fn listen_mode_get() -> audio::DinlemeKipi {
    audio::dinleme_kipi()
}

#[tauri::command]
fn listen_mode_set(app: AppHandle, kip: audio::DinlemeKipi) -> audio::DinlemeKipi {
    let _ = audio::dinleme_ayarla(kip);
    let kip = audio::dinleme_kipi();
    let _ = app.emit(LISTEN_MODE_EVENT, ListeningModeView { kip });
    kip
}

/// Seviye tuketicisi: kareleri ~40ms pencerelerde toplayip UI'a akitir.
fn spawn_level_meter(app: AppHandle, mut rx: tokio::sync::broadcast::Receiver<audio::AudioFrame>) {
    tauri::async_runtime::spawn(async move {
        let mut window: Vec<f32> = Vec::new();
        loop {
            match rx.recv().await {
                Ok(frame) => {
                    window.extend_from_slice(&frame.samples);
                    let target = (frame.sample_rate as usize * 40) / 1000;
                    if window.len() >= target {
                        let (rms, peak) = rms_peak(&window);
                        window.clear();
                        if app.emit("audio://level", LevelEvent { rms, peak }).is_err() {
                            break;
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => window.clear(),
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

fn rms_peak(samples: &[f32]) -> (f32, f32) {
    if samples.is_empty() {
        return (0.0, 0.0);
    }
    let mut sum_sq = 0.0f32;
    let mut peak = 0.0f32;
    for &s in samples {
        sum_sq += s * s;
        let a = s.abs();
        if a > peak {
            peak = a;
        }
    }
    let rms = (sum_sq / samples.len() as f32).sqrt();
    ((rms * 4.0).min(1.0), peak.min(1.0))
}

/// Gelistirme anahtarlarini (`SMITH_GEMINI_KEY` vb.) repo ici
/// `.env.local`'den yukler (uygulama kokunun bir alti: `apps/desktop/`).
///
/// NEDEN: Windows'ta kullanici env degiskeni eklemek `setx` + OTURUM
/// KAPATMA/YENIDEN ACMA ister; anahtarsiz acilan Smith "Ses motoru
/// baslatilamadi" ile doguyordu (25-09-2026'da sahada yasandi). Anahtarin
/// dogal yeri zaten gitignore'lu `.env.local` — simdi Rust tarafi da onu okur.
///
/// GUVENLIK ve ONCELIK: dotenvy mevcut isletim sistemi degiskenini ASLA ezmez
/// (guncel env > dosya). Dosya yoksa (prod paket) sessiz no-op — gizli
/// davranis degisikligi yok. Kasten `dotenv()` (cwd yuruyusu) KULLANILMAZ:
/// o, calisma dizinine gore repo kokundeki gateway `.env`'ini de
/// yukleyebilirdi (desktop'un gormemesi gereken sunucu sirlarini sokardi).
fn yukle_env_local() {
    let yol = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(".env.local");
    match dotenvy::from_path(&yol) {
        Ok(()) => eprintln!("[env] .env.local yuklendi ({})", yol.display()),
        Err(dotenvy::Error::Io(_)) => {} // dosya yok: prod/anahtarsiz calisma, sorun degil
        Err(e) => eprintln!("[env] .env.local okunamadi (ayristirma): {e}"),
    }
}

/// "Smith'in su an aklinda ne var?" — oturum acilirken modele GIDEN baglamin
/// tamami. Kullanici istegi: dusunce baloncugunun arkasindaki detay gorunumu.
///
/// Dokum URETIMIN KENDI yolundan uretilir (`audio::zihin_dokumu`), kopya degil;
/// aksi halde "gorunen" ile "gonderilen" ayrisirdi.
#[tauri::command]
fn zihin_dokumu() -> String {
    audio::zihin_dokumu("")
}

#[tauri::command]
fn tool_labels() -> std::collections::BTreeMap<&'static str, &'static str> {
    audio::tool_labels()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    eprintln!(
        "[smith] surum {} ({})",
        env!("SMITH_BUILD_SHA"),
        env!("SMITH_BUILD_TIME")
    );
    std::panic::set_hook(Box::new(|info| {
        eprintln!(
            "[panic] {}",
            info.to_string()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        );
    }));
    let mut exit_code = 0;
    yukle_env_local();
    // Paketli exe'nin anahtarlari: <veri koku>\smith.env (yalniz tanimsiz
    // anahtarlar). `set_var` yuzunden iplik/eklenti baslamadan ONCE cagrilir.
    env_file::load_smith_env();
    // Eski (AppData tabanli) konumda tasinmamis veri varsa acik uyari; bilesenler
    // eski konuma yazmaz, yeni kokle devam edilir (bkz. paths.rs).
    paths::warn_if_legacy_data();
    let builder = tauri::Builder::default();
    // TEK ORNEK: ilk eklenti olmali. Ikinci baslatma mevcut ana pencereyi one
    // getirir ve kendisi cikar (kilit `com.smith.desktop` kimligine bagli).
    // Mikrofonu ve Live oturumunu iki surec ayni anda acarsa cihaz cakisir.
    // Debug derlemesi ve `SMITH_ALLOW_MULTI=1` kilitlenmez (bkz. tray.rs).
    #[cfg(desktop)]
    let builder = if tray::single_instance_enabled(
        cfg!(debug_assertions),
        env_flag::acik_varsayilan_kapali("SMITH_ALLOW_MULTI"),
    ) {
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main(app);
        }))
    } else {
        builder
    };
    let builder = builder.plugin(tauri_plugin_opener::init());
    // macOS mikrofon/erisim izinlerini runtime'da isteyebilmek icin (imzali
    // app'te cpal tek basina TCC prompt'unu tetiklemiyor). Yalniz macOS.
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_macos_permissions::init());

    builder
        .setup(|app| {
            app.manage(AudioState::default());
            // Pencereyi masaustu varligina cevirir ve kaydedilmis konumu
            // uygular. Basarisiz olursa uygulama acilmaz — pencere kurulumu
            // sessizce yarim kalirsa kullanici gorunmez/erisilemez bir pet ile
            // kalir, bu yuzden hata yutulmuyor.
            window::setup(app.handle())?;
            // Tepsi: pet gorev cubugunda yok, geri cagirma yuzeyi bu. Kurulamazsa
            // uygulama yine acilir ama "kapat = gizle" devre disi kalir (kullanici
            // pencereyi kapatip cikabilsin; bkz. tray.rs guvenlik agi).
            if let Err(e) = tray::setup(app.handle()) {
                eprintln!("[tray] tepsi simgesi kurulamadi (kapat = cik): {e}");
            }
            // Hatirlatma teslim dongusu (kendi thread'i; pencere olusturmaz).
            reminders::baslat();
            // SMITH_MISSION_OPEN=1 → pano acilista da acilir. Iki isi var:
            // (1) "Smith'i actigimda ekip panosu da onumde olsun" tercihi,
            // (2) panonun tek tik olmadan DOGRULANABILIR olmasi (gelistirme ve
            //     ekran goruntusu alma yolu). Varsayilan KAPALI: pet penceresi
            //     sessiz bir masaustu varligi olarak kalir.
            if env_flag::acik_varsayilan_kapali("SMITH_MISSION_OPEN") {
                let app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = mission::mission_open(app).await {
                        // Dashboard failure must not prevent the pet from starting.
                        eprintln!("[mission] pano acilista acilamadi: {e}");
                    }
                });
            }
            Ok(())
        })
        // Konum bellegi: pet nereye birakildiysa orada acilir. Ardindan kapatma
        // istegi (yalniz ana pencere) gizlemeye cevrilir; konum once
        // kaydedilir cunku gizlenen pencere `Destroyed` almaz.
        .on_window_event(|window, event| {
            window::on_window_event(window, event);
            tray::on_window_event(window, event);
            mission::on_window_event(window, event);
        })
        .invoke_handler(tauri::generate_handler![
            zihin_dokumu,
            tool_labels,
            audio_devices,
            audio_start,
            audio_stop,
            audio_mixer_state,
            audio_set_mic_muted,
            audio_set_output_muted,
            audio_set_output_volume,
            live_status_get,
            listen_mode_get,
            listen_mode_set,
            screen_stream_get,
            screen_stream_set,
            window::window_set_interactive,
            window::window_set_hit_areas,
            window::window_start_drag,
            window::window_toggle_frame,
            window::window_quit,
            window::window_state,
            mission::mission_open,
            mission::mission_close,
            mission::mission_start_drag,
            mission::mission_call,
            dashboard::dashboard_log,
            dashboard::dashboard_ready,
            dashboard::dashboard_fs_roots,
            dashboard::dashboard_fs_list,
            dashboard::dashboard_fs_read,
            dashboard::dashboard_fs_write,
            dashboard::dashboard_vault_graph,
            dashboard::dashboard_engines
        ])
        .build(tauri::generate_context!())
        .expect("Smith masaustu uygulamasi baslatilamadi")
        .run(move |_app, event| {
            // Son pencere kapanirsa (`code: None`) surec OLMEZ; yalniz acik
            // `exit(code)` (tepsi Cikis, `window_quit`) cikarir. Tepsi yoksa
            // eski davranis: son pencere kapaninca uygulama biter.
            if matches!(event, tauri::RunEvent::Exit) {
                eprintln!("[pencere] surec cikiyor (kod: {exit_code})");
                audio::konusma_kapat();
            }
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if let Some(code) = code {
                    exit_code = code;
                }
                tray::on_exit_requested(&api, code);
            }
        });
}

#[cfg(test)]
mod window_creation_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_status_olayi_ve_sorgusu_ayni_kaynagi_okur() {
        let source = AtomicBool::new(false);
        assert!(!live_status_view(&source).connected);
        source.store(true, Ordering::Release);
        assert!(live_status_view(&source).connected);
    }

    /// `audio://tool` WIRE SOZLESMESI. React tarafi alan adlarini birebir
    /// okuyor; bir yeniden adlandirma veya `rename_all` eklemesi UI'i sessizce
    /// bozar (event gelir, alanlar `undefined` olur). Bu test o degisikligi
    /// derleme kapisinda yakalar.
    ///
    /// `durum` degerleri burada bilincli olarak DUZ METIN yazildi: sabitler
    /// `audio::live`'a ait (modul dis dunyaya kapali) ve oradaki test
    /// degerlerin bu metinlerle ayni kaldigini kanitliyor
    /// (`durum_degerleri_wire_ile_ayni`). Iki testin biri kirilirsa sozlesme
    /// kaymasi gorunur olur.
    #[test]
    fn tool_event_wire_semasi() {
        let basladi = ToolEvent {
            ad: "hafizada_ara".into(),
            durum: "basladi",
            sebep: None,
        };
        // `sebep` None iken alan HIC serilesmez → UI'da `undefined`.
        assert_eq!(
            serde_json::to_value(&basladi).expect("serilesir"),
            serde_json::json!({ "ad": "hafizada_ara", "durum": "basladi" })
        );

        let red = ToolEvent {
            ad: "terminal_calistir".into(),
            durum: "reddedildi",
            sebep: Some("ses izi Cihan degil".into()),
        };
        assert_eq!(
            serde_json::to_value(&red).expect("serilesir"),
            serde_json::json!({
                "ad": "terminal_calistir",
                "durum": "reddedildi",
                "sebep": "ses izi Cihan degil"
            })
        );
    }
}

#[cfg(test)]
mod audio_lifecycle_tests {
    use super::*;
    struct FakeSource {
        stop: Box<dyn FnOnce() -> Result<(), audio::AudioError> + Send>,
    }
    impl AudioSource for FakeSource {
        fn subscribe(&self) -> tokio::sync::broadcast::Receiver<audio::AudioFrame> {
            tokio::sync::broadcast::channel(1).1
        }
        fn stop(self: Box<Self>) -> Result<(), audio::AudioError> {
            (self.stop)()
        }
    }
    #[test]
    fn d1b_15_acilis_kilitsiz_iptal_gec_sonucu_reddeder() {
        let state = Arc::new(AudioState::default());
        let (ready_tx, ready) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_state = state.clone();
        let stopped_worker = stopped.clone();
        let worker = std::thread::spawn(move || {
            worker_state.start_source(|_| {
                ready_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(Box::new(FakeSource {
                    stop: Box::new(move || {
                        stopped_worker.store(true, Ordering::SeqCst);
                        Ok(())
                    }),
                }))
            })
        });
        ready.recv().unwrap();
        assert!(state.source.try_lock().is_ok());
        assert!(state.start_source(|_| panic!("ikinci acilis")).is_err());
        state.stop_source().unwrap();
        release.send(()).unwrap();
        assert!(worker.join().unwrap().unwrap_err().contains("iptal"));
        assert!(stopped.load(Ordering::SeqCst));
        assert!(state.source.lock().unwrap().source.is_none());
    }
    #[test]
    fn d1b_15_kapanis_kilitsiz_hata_state_kapali() {
        let state = Arc::new(AudioState::default());
        let weak = Arc::downgrade(&state);
        state
            .start_source(|_| {
                Ok(Box::new(FakeSource {
                    stop: Box::new(move || {
                        let state = weak.upgrade().unwrap();
                        assert!(state.source.try_lock().is_ok());
                        Err(audio::AudioError::Stream("surucu zaman asimi".into()))
                    }),
                }))
            })
            .unwrap();
        assert!(state.start_source(|_| panic!("idempotans")).is_ok());
        assert!(state.stop_source().unwrap_err().contains("zaman asimi"));
        assert!(state.source.lock().unwrap().source.is_none());
        assert!(state.stop_source().is_ok());
        assert!(state.start_source(|_| Err("acilis hatasi".into())).is_err());
        assert!(!state.source.lock().unwrap().opening);
    }
}
