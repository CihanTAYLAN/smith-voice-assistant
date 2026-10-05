//! Gecici tani: mikrofondan GERCEKTEN veri geliyor mu?
//! 5 saniye yakalar, saniyelik RMS ve tepe degeri basar.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

fn main() {
    let host = cpal::default_host();
    let device = host.default_input_device().expect("giris cihazi yok");
    println!("cihaz: {}", device);

    let config = device.default_input_config().expect("config yok");
    println!("config: {:?}", config);
    let sample_rate = config.sample_rate();
    let channels = config.channels() as usize;

    let acc: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let acc2 = Arc::clone(&acc);

    let stream = device
        .build_input_stream(
            config.clone().into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if let Ok(mut buf) = acc2.lock() {
                    buf.extend_from_slice(data);
                }
            },
            |err| eprintln!("stream hatasi: {err}"),
            None,
        )
        .expect("stream kurulamadi");

    stream.play().expect("stream baslatilamadi");
    println!("--- 5 saniye KONUSUN ---");

    let per_sec = sample_rate as usize * channels;
    for s in 1..=5 {
        std::thread::sleep(Duration::from_secs(1));
        let buf = acc.lock().unwrap();
        let start = buf.len().saturating_sub(per_sec);
        let win = &buf[start..];
        if win.is_empty() {
            println!("  {s}sn: ORNEK YOK");
            continue;
        }
        let rms = (win.iter().map(|x| x * x).sum::<f32>() / win.len() as f32).sqrt();
        let peak = win.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        println!(
            "  {s}sn: ornek={} rms={:.5} tepe={:.5}",
            win.len(),
            rms,
            peak
        );
    }

    drop(stream);
    let total = acc.lock().unwrap().len();
    println!("toplam ornek: {total}");
    if total == 0 {
        println!("SONUC: HIC VERI GELMEDI");
    } else {
        let buf = acc.lock().unwrap();
        let rms = (buf.iter().map(|x| x * x).sum::<f32>() / buf.len() as f32).sqrt();
        println!("SONUC: veri akti, genel rms={:.5}", rms);
        if rms < 0.0001 {
            println!("UYARI: sinyal sessiz — cihaz var ama ses gelmiyor olabilir");
        }
    }
}
