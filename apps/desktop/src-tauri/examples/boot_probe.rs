//! ACILIS BAGLAMI CANLI SONDASI — "derlendi" kanit degildir.
//!
//! `system_tools` dersi (bkz. o dosyanin basi): COM vtable kaymasi ve
//! `"format "` yanlis pozitifi yalniz canli kosuda goruldu. Burada da ayni
//! sey gecerli: Win32 FFI imzalari derlenir ama YANLIS veri dondurebilir (dizilim
//! kaymasi, yanlis sanal tablo yuvasi), butce gercek makinede asilabilir.
//! Bu sonda uretilen metnin TAMAMINI, boyutunu ve sureyi basar — gizlilik
//! karari ancak gercek cikti okunarak denetlenebilir.
//!
//! Kullanim: cargo run --example boot_probe

use smith_desktop_lib::boot_context;

fn main() {
    println!("=== 1) SOGUK olcum (statik onbellek bos) ===");
    olc();

    println!("\n=== 2) ISINMIS olcum (statik onbellek dolu) ===");
    olc();

    println!("\n=== 3) ENV DIKISI: SMITH_BOOT_CONTEXT=0 ===");
    std::env::set_var("SMITH_BOOT_CONTEXT", "0");
    match boot_context::collect() {
        None => println!("dogru: kapaliyken baglam uretilmedi"),
        Some(s) => println!("HATA: kapali olmasina ragmen {} bayt uretti", s.text.len()),
    }
}

fn olc() {
    let baslangic = std::time::Instant::now();
    let snapshot = boot_context::collect();
    let cagri_suresi = baslangic.elapsed();
    match snapshot {
        None => println!("baglam uretilmedi (kapali ya da hicbir sey olculemedi)"),
        Some(s) => {
            println!(
                "sure: {} ms (butce {} ms) | boyut: {} bayt (tavan {} bayt) | ASCII: {}",
                s.elapsed.as_millis(),
                boot_context::BUDGET.as_millis(),
                s.text.len(),
                boot_context::MAX_BYTES,
                s.text.is_ascii()
            );
            println!(
                "cagri suresi (disardan olculen): {} ms",
                cagri_suresi.as_millis()
            );
            println!("--- MODELE GIDEN METNIN TAMAMI ---");
            println!("{}", s.text);
            println!("--- SON ---");
        }
    }
}
