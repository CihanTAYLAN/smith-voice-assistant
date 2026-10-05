//! Derlenmis Live setup cercevesini JSON olarak basar; ag/ses oturumu acmaz.
//! Kullanim: cargo run --example live_setup_dump -- --out cikti.json
//! Anahtar icermez. Acilis baglami mevcut zihin dokumunden alinir.

use serde_json::Value;

fn main() {
    let mut out: Option<String> = None;
    let mut context: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--out" => out = args.next(),
            "--context" => context = args.next(),
            "-h" | "--help" => {
                eprintln!("kullanim: live_setup_dump [--out <dosya>] [--context <baglam-dosyasi>]");
                return;
            }
            other => {
                eprintln!("bilinmeyen arguman: {other}");
                std::process::exit(2);
            }
        }
    }
    let frame = match cerceve(context.as_deref()) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("HATA: {e}");
            std::process::exit(1);
        }
    };
    let metin = serde_json::to_string_pretty(&frame).expect("json");
    match out {
        Some(yol) => {
            if let Err(e) = std::fs::write(&yol, metin.as_bytes()) {
                eprintln!("HATA: {yol} yazilamadi: {e}");
                std::process::exit(1);
            }
            eprintln!("yazildi: {yol}");
        }
        None => println!("{metin}"),
    }
}

fn cerceve(context: Option<&str>) -> Result<Value, String> {
    let ek = match context {
        Some(path) => {
            std::fs::read_to_string(path).map_err(|e| format!("baglam okunamadi: {e}"))?
        }
        None => canli_baglam()?,
    };
    serde_json::from_str(&smith_desktop_lib::audio::LiveSession::setup_cercevesi_json(&ek))
        .map_err(|e| e.to_string())
}

/// Saat, kaynak kullanimi ve odak degisebildigi icin tekrarli karsilastirmada
/// --context kullanilir; varsayilan export canli baglami toplamayi surdurur.
fn canli_baglam() -> Result<String, String> {
    let dokum = smith_desktop_lib::audio::zihin_dokumu("");
    Ok([
        bolum(&dokum, "1. EKRAN ENVANTERI")?,
        bolum(&dokum, "2. ACILIS BAGLAMI")?,
        bolum(&dokum, "3. SON KONUSMA")?,
    ]
    .into_iter()
    .filter(|p| !p.trim().is_empty())
    .collect::<Vec<_>>()
    .join(" "))
}

/// `----- <baslik...> -----` basligindan sonraki bolum govdesi (kirpilmis).
/// `(bos)` = bos bolum.
fn bolum(dokum: &str, baslik_oneki: &str) -> Result<String, String> {
    let isaret = format!("\n----- {baslik_oneki}");
    let bas = dokum
        .find(&isaret)
        .ok_or_else(|| format!("dokumde `{baslik_oneki}` bolumu yok"))?;
    let govde_bas = dokum[bas + 1..]
        .find('\n')
        .map(|i| bas + 1 + i + 1)
        .ok_or("bolum basligi satir sonu yok")?;
    let son = dokum[govde_bas..]
        .find("\n----- ")
        .map(|i| govde_bas + i)
        .unwrap_or(dokum.len());
    let metin = dokum[govde_bas..son].trim();
    Ok(if metin == "(bos)" {
        String::new()
    } else {
        metin.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dokum_bolumleri() {
        let d = "x\n\n----- 1. EKRAN ENVANTERI -----\n(bos)\n\n----- 4. SABIT YONERGE -----\nmetin burada\n\n----- BU DOKUMDE **OLMAYANLAR** -----\nz";
        assert_eq!(bolum(d, "1. EKRAN ENVANTERI").unwrap(), "");
        assert_eq!(bolum(d, "4. SABIT YONERGE").unwrap(), "metin burada");
    }
}
