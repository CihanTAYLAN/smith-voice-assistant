//! Gecici tani araci: cpal hangi giris cihazlarini goruyor?
use cpal::traits::{DeviceTrait, HostTrait};

fn main() {
    let host = cpal::default_host();
    println!("host: {:?}", host.id());

    match host.default_input_device() {
        Some(d) => println!("VARSAYILAN GIRIS: {}", d),
        None => println!("VARSAYILAN GIRIS: YOK"),
    }

    match host.input_devices() {
        Ok(devs) => {
            let mut n = 0;
            for d in devs {
                println!("  giris: {}", d);
                if let Ok(cfg) = d.default_input_config() {
                    println!("      config: {:?}", cfg);
                }
                n += 1;
            }
            println!("toplam giris cihazi: {n}");
        }
        Err(e) => println!("input_devices HATA: {e}"),
    }
}
