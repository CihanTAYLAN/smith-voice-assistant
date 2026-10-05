//! cpal tabanli mikrofon yakalama.
//!
//! cpal Stream cogu platformda !Send oldugu icin ozel bir thread'de yasar;
//! kontrol AtomicBool ile yapilir. Callback her ses tamponunu mono'ya indirip
//! broadcast'e gonderir. Boylece capture thread'i tek is yapar: yakala ve dagit.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use tokio::sync::broadcast;

use super::{AudioError, AudioFrame, AudioSource};

/// broadcast tampon derinligi: yavas bir tuketici kare kacirabilir (Lagged)
/// ama capture asla bloke olmaz — gercek-zamanli ses icin dogru takas.
const CHANNEL_CAPACITY: usize = 64;

pub struct CpalAudioSource {
    tx: broadcast::Sender<AudioFrame>,
    pub device_name: super::CihazAdi,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl CpalAudioSource {
    /// Varsayilan (device_name = None) veya adiyla secilen giris cihazindan
    /// yakalamaya baslar. Ses hemen akmaya baslar.
    pub fn start(device_name: Option<String>) -> Result<Self, AudioError> {
        static BUSY: AtomicBool = AtomicBool::new(false);
        let reservation = super::SurucuRezervasyonu::al(&BUSY)?;
        let (tx, _rx) = broadcast::channel::<AudioFrame>(CHANNEL_CAPACITY);
        let stop = Arc::new(AtomicBool::new(false));
        let selected_name = super::CihazAdi::default();
        let name_thread = selected_name.clone();

        let tx_thread = tx.clone();
        let stop_thread = stop.clone();

        // Stream !Send: kendi thread'inde kurulur ve orada yasar.
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), AudioError>>();

        let thread = std::thread::spawn(move || {
            let _reservation = reservation;
            // Ilk kurulum fail-fast (mic yoksa kullanici hemen gorsun); SONRAKI
            // kopuslarda sessiz kurtarma. Neden: WASAPI cihazi uyuyunca/degisince
            // AUDCLNT_E_DEVICE_INVALIDATED (OS Error -2004287472) atar ve stream
            // OLUR — sahada olculdu: ses akisi sessizce durdu, VAD/STT'ye hicbir
            // sey gitmedi. Kalici dinleyici stream olumunde kendini yeniden
            // kurmali; cihaz da her denemede TAZE secilir (varsayilan degismis
            // olabilir).
            let mut first = Some(ready_tx);
            while !stop_thread.load(Ordering::Relaxed) {
                let dead = Arc::new(AtomicBool::new(false));
                match build_stream(
                    device_name.clone(),
                    tx_thread.clone(),
                    dead.clone(),
                    stop_thread.clone(),
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
                            while !stop_thread.load(Ordering::Relaxed)
                                && !dead.load(Ordering::Relaxed)
                            {
                                std::thread::sleep(std::time::Duration::from_millis(100));
                            }
                            if dead.load(Ordering::Relaxed) && !stop_thread.load(Ordering::Relaxed)
                            {
                                eprintln!(
                                    "[audio] stream koptu (cihaz gecersizlesti); yeniden kuruluyor…"
                                );
                                drop(stream);
                                std::thread::sleep(std::time::Duration::from_millis(300));
                                continue;
                            }
                            // stop istendi: stream drop olur, cihaz serbest.
                        }
                        Err(e) => {
                            if let Some(tx) = first.take() {
                                let _ = tx.send(Err(AudioError::Stream(e.to_string())));
                                return;
                            }
                            eprintln!("[audio] play hatasi: {e}; 1 sn sonra tekrar");
                            std::thread::sleep(std::time::Duration::from_millis(1000));
                        }
                    },
                    Err(e) => {
                        if let Some(tx) = first.take() {
                            let _ = tx.send(Err(e));
                            return;
                        }
                        eprintln!("[audio] yeniden kurulum hatasi: {e}; 1 sn sonra tekrar");
                        std::thread::sleep(std::time::Duration::from_millis(1000));
                    }
                }
            }
        });

        // Stream'in gercekten kurulup calistigini dogrula (fail-fast). Surucu
        // takilirsa sinirli beklenir; thread'e durma bildirilir, gec acilan
        // stream hemen birakilir (yukaridaki `stop` kontrolu).
        match super::surucu_bekle(&ready_rx, super::AUDIO_DRIVER_TIMEOUT).and_then(|sonuc| sonuc) {
            Ok(()) => Ok(Self {
                tx,
                device_name: selected_name,
                stop,
                thread: Some(thread),
            }),
            Err(e) => {
                stop.store(true, Ordering::SeqCst);
                Err(e)
            }
        }
    }
}

impl AudioSource for CpalAudioSource {
    fn subscribe(&self) -> broadcast::Receiver<AudioFrame> {
        self.tx.subscribe()
    }

    fn stop(mut self: Box<Self>) -> Result<(), AudioError> {
        super::surucu_kapat(&mut self.thread, &self.stop, super::AUDIO_DRIVER_TIMEOUT)
    }
}

impl Drop for CpalAudioSource {
    fn drop(&mut self) {
        // Box::stop cagrilmadan drop olursa da thread'i temiz kapat.
        if let Err(e) =
            super::surucu_kapat(&mut self.thread, &self.stop, super::AUDIO_DRIVER_TIMEOUT)
        {
            eprintln!("[audio] kapanis basarisiz: {e}");
        }
    }
}

fn build_stream(
    device_name: Option<String>,
    tx: broadcast::Sender<AudioFrame>,
    dead: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    selected_name: &super::CihazAdi,
) -> Result<cpal::Stream, AudioError> {
    let host = cpal::default_host();

    let device = match device_name {
        // cpal 0.18: Device: Display; ad = to_string(), ayri name() metodu yok.
        Some(name) => host
            .input_devices()
            .map_err(|e| AudioError::Config(e.to_string()))?
            .find(|d| d.to_string() == name)
            .ok_or(AudioError::NoInputDevice)?,
        None => host
            .default_input_device()
            .ok_or(AudioError::NoInputDevice)?,
    };

    let supported = device
        .default_input_config()
        .map_err(|e| AudioError::Config(e.to_string()))?;
    // cpal 0.18: SampleRate = u32 (type alias), .0 yok.
    let sample_rate = supported.sample_rate();
    let channels = supported.channels() as usize;
    let sample_format = supported.sample_format();
    // TESHIS: hangi cihaz, hangi format? Whisper "yanlis" cozuyorsa ilk suphe
    // yanlis giris cihazi (Stereo Mix / kamera mik / dizi mikrofon) veya
    // beklenmedik hiz/kanal. Bu satir suclu cihazi aninda gorunur kilar.
    eprintln!(
        "[audio] secilen giris cihazi: '{}' | {} Hz | {} kanal | format {:?}",
        device.to_string(),
        sample_rate,
        channels,
        sample_format
    );
    let config: StreamConfig = supported.into();
    *selected_name.lock().unwrap_or_else(|e| e.into_inner()) = device.to_string();

    // Hata = stream fiilen olu (WASAPI cogu hatadan geri donmez). Bayragi set
    // et ki capture thread'i yeniden kurabilsin.
    let err_fn = move |e| {
        eprintln!("[audio] stream hatasi: {e}; kurtarma tetiklendi");
        dead.store(true, Ordering::Relaxed);
    };

    // Cok kanalli giris mono'ya indirilir (kanal ortalamasi).
    let emit = move |mono: Vec<f32>| {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let _ = tx.send(AudioFrame {
            samples: Arc::from(mono.into_boxed_slice()),
            sample_rate,
        });
    };

    // cpal 0.18: build_input_stream config'i DEGERLE alir; her kolda clone.
    let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
            config,
            move |data: &[f32], _| emit(downmix_f32(data, channels)),
            err_fn,
            None,
        ),
        SampleFormat::I16 => device.build_input_stream(
            config,
            move |data: &[i16], _| {
                let f: Vec<f32> = data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                emit(downmix_f32(&f, channels));
            },
            err_fn,
            None,
        ),
        SampleFormat::U16 => device.build_input_stream(
            config,
            move |data: &[u16], _| {
                let f: Vec<f32> = data
                    .iter()
                    .map(|&s| (s as f32 / u16::MAX as f32) * 2.0 - 1.0)
                    .collect();
                emit(downmix_f32(&f, channels));
            },
            err_fn,
            None,
        ),
        other => {
            return Err(AudioError::Config(format!(
                "desteklenmeyen ornek formati: {other:?}"
            )))
        }
    }
    .map_err(|e| AudioError::Stream(e.to_string()))?;

    Ok(stream)
}

/// Interleaved cok-kanalli ornekleri kanal ortalamasiyla mono'ya indirir.
fn downmix_f32(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks(channels)
        .map(|frame| frame.iter().copied().sum::<f32>() / channels as f32)
        .collect()
}

/// Mevcut giris cihazlarinin adlarini dondurur (ileride device secimi icin).
pub fn list_input_devices() -> Result<Vec<String>, AudioError> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|e| AudioError::Config(e.to_string()))?;
    Ok(devices.map(|d| d.to_string()).collect())
}
