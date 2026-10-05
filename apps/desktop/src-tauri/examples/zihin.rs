//! "Smith'in su an aklinda ne var?" — oturum acilirken modele GIDEN baglamin
//! dokumu. Kullanim: cargo run --example zihin
//!
//! Ayni dokum uygulamadan da alinabilir (`zihin_dokumu` Tauri komutu, dusunce
//! baloncugunun detay gorunumu). Bu ornek CLI'dan bakmak icin.
fn main() {
    println!("{}", smith_desktop_lib::audio::zihin_dokumu(""));
}
