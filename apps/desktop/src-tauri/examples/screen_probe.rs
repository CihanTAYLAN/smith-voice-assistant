//! Ekran envanteri sondasi — xcap'in bu makinede NE gordugunu olcer.
//!
//! `screen.rs` cok-monitorlu tasarim kararini bu olcume dayandiriyor, o yuzden
//! olcum kodda duruyor: kac monitor, hangi cozunurluk, hangisi birincil,
//! `Monitor::all()` sirasi turlar arasi kararli mi, ve `active` modunun bagli
//! oldugu `Window::all()` cagrisi kac ms suruyor.
//!
//! Yakalama/kodlama davranisi burada DEGIL `cargo test --lib screen` icinde
//! dogrulanir: `audio::screen` modulu `audio` icinde private oldugu icin
//! ornekler ona erisemez, testler (modul icinden) erisir.
//!
//! Kullanim: cargo run --example screen_probe

fn main() {
    println!("=== 1) Monitor::all() — envanter ve SIRA KARARLILIGI (3 tur) ===");
    for tur in 1..=3 {
        let monitors = match xcap::Monitor::all() {
            Ok(m) => m,
            Err(e) => {
                println!("  ekranlar listelenemedi: {e}");
                return;
            }
        };
        println!("  --- tur {tur} ({} monitor) ---", monitors.len());
        for (i, m) in monitors.iter().enumerate() {
            println!(
                "    [{i}] id={} name={:?} {}x{} @({},{}) primary={} builtin={} scale={} rot={} hz={}",
                m.id().unwrap_or(0),
                m.name().unwrap_or_default(),
                m.width().unwrap_or(0),
                m.height().unwrap_or(0),
                m.x().unwrap_or(0),
                m.y().unwrap_or(0),
                m.is_primary().unwrap_or(false),
                m.is_builtin().unwrap_or(false),
                m.scale_factor().unwrap_or(0.0),
                m.rotation().unwrap_or(0.0),
                m.frequency().unwrap_or(0.0),
            );
        }
    }

    println!("\n=== 2) yakalama maliyeti (monitor basina) ===");
    if let Ok(monitors) = xcap::Monitor::all() {
        for (i, m) in monitors.iter().enumerate() {
            let t0 = std::time::Instant::now();
            match m.capture_image() {
                Ok(img) => println!(
                    "    [{i}] capture_image {}x{} -> {} ms",
                    img.width(),
                    img.height(),
                    t0.elapsed().as_millis()
                ),
                Err(e) => println!("    [{i}] capture_image HATA: {e}"),
            }
        }
    }

    println!("\n=== 3) `active` modunun bagimliligi: Window::all() + is_focused ===");
    for tur in 1..=3 {
        let t0 = std::time::Instant::now();
        match xcap::Window::all() {
            Ok(windows) => {
                let sayi = windows.len();
                let odak = windows.iter().find(|w| w.is_focused().unwrap_or(false));
                let ms = t0.elapsed().as_millis();
                match odak {
                    Some(w) => println!(
                        "  tur {tur}: {sayi} pencere, odak app={:?} monitor={:?} id={:?} ({ms} ms)",
                        w.app_name().unwrap_or_default(),
                        w.current_monitor().and_then(|m| m.name()).ok(),
                        w.current_monitor().and_then(|m| m.id()).ok(),
                    ),
                    None => {
                        println!("  tur {tur}: {sayi} pencere, ODAKLANMIS PENCERE YOK ({ms} ms)")
                    }
                }
            }
            Err(e) => println!("  tur {tur}: pencereler listelenemedi: {e}"),
        }
    }
}
