//! Canli sonda: `ajan_oturumlari` gercek Claude Code / Codex kayitlarinda.
//!
//! NEDEN VAR: bu depoda "derlendi = calisiyor" varsayimi iki kez pahaliya
//! geldi (COM vtable kaymasi, `format ` deseni). Birim testler sentetik
//! pencerelerle kosuyor; bu sonda GERCEK agaca bakar.
//!
//! Kullanim:
//!   cargo run --example sessions_probe            # yalniz meta veri
//!   cargo run --example sessions_probe -- icerik  # + maskeli prompt alintilari
//!
//! `icerik` modunda ekrana KENDI istekleriniz basilir; baskasinin yaninda
//! kosturmayin.

fn main() {
    let icerik = std::env::args().any(|a| a == "icerik");
    let t0 = std::time::Instant::now();
    let v = smith_desktop_lib::agent_sessions::ajan_oturumlari("hepsi", Some(6), icerik);
    let ms = t0.elapsed().as_millis();

    println!("=== ajan_oturumlari(hepsi, 6, icerik={icerik}) — {ms} ms ===");
    println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());

    // Butce tanigi: arac yaniti konusmayi bogmamali.
    let bayt = v.to_string().len();
    println!("\nyanit boyutu: {bayt} bayt");
    if bayt > 6000 {
        eprintln!("UYARI: yanit buyuk ({bayt} bayt) — model baglamini zorlar");
    }
}
