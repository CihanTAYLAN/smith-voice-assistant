//! Paketli exe icin env dosyasi: `<veri koku>\smith.env` (kok: `crate::paths`,
//! `SMITH_DATA_DIR` ya da `%USERPROFILE%\.smith`; AppData tabanli degil).
//!
//! NEDEN VAR: `tauri build --no-bundle` ciktisi cift tiklanarak (veya acilista
//! otomatik) baslatilir; `dev-win.ps1` dot-source eden bir kabuk yoktur ve
//! `.env.local` yolu derleme makinesinin `CARGO_MANIFEST_DIR`'ina bagli
//! (`lib.rs::yukle_env_local`). Anahtarsiz acilan paketli Smith "Ses motoru
//! baslatilamadi" ile dogardi. Bu dosya o bosluk icin: `scripts/
//! smith-env-export.ps1` yazar, uygulama acilista okur.
//!
//! SOZLESME:
//!   - Satir bicimi `KEY=VALUE`. Bos satirlar ve `#` ile baslayan satirlar
//!     atlanir; satir basi `export ` kabul edilir; deger cevresindeki tek veya
//!     cift tirnak sokulur. Satir ici `#` YORUM SAYILMAZ (deger icinde mesrudur).
//!   - YALNIZ surecte zaten tanimli OLMAYAN anahtarlar yuklenir. Isletim sistemi
//!     env'i her zaman baskindir (`dotenvy` ile ayni oncelik; `.env.local`
//!     yuklendikten SONRA calisir, o yuzden dev'de onun degerleri korunur).
//!   - DEGERLER ASLA LOGLANMAZ ve anahtar adlari da loglanmaz: yalniz yuklenen
//!     anahtar SAYISI yazilir. Dosya yok -> sessiz no-op (dev akisi ve baska
//!     makineler etkilenmez).
//!
//! Ayristirma ve uygulama SAF yordamlardir (env'e dokunmayan kapanislar alir);
//! gercek `std::env` baglantisi yalniz `load_smith_env`te.

use std::path::PathBuf;

/// `KEY=VALUE` satirlarini ayristirir. Gecersiz satirlar (anahtarsiz, `=`siz,
/// gecersiz anahtar, NUL iceren deger) SESSIZCE atlanir: `std::env::set_var`
/// bos/`=` iceren anahtarda veya NUL'da panik atar, bozuk bir dosya acilista
/// uygulamayi dusuremez.
pub fn parse_env(content: &str) -> Vec<(String, String)> {
    // UTF-8 BOM: PowerShell 5.1 `Set-Content -Encoding UTF8` yazar; ilk anahtar
    // adinin onune yapisip eslesmeyi bozmasin.
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    content.lines().filter_map(parse_line).collect()
}

fn parse_line(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let line = line
        .strip_prefix("export ")
        .map(str::trim_start)
        .unwrap_or(line);
    let (key, value) = line.split_once('=')?;
    let key = key.trim();
    if !gecerli_anahtar(key) {
        return None;
    }
    let value = unquote(value.trim());
    if value.contains('\0') {
        return None;
    }
    Some((key.to_string(), value.to_string()))
}

/// Ortam degiskeni adi: ASCII harf/rakam/alt cizgi, rakamla baslamaz.
fn gecerli_anahtar(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Cevreleyen ESLESEN tirnak ciftini soyar; tek basina veya uyumsuz tirnak
/// degerin parcasidir (ornegin `it's` dokunulmaz).
fn unquote(value: &str) -> &str {
    let b = value.as_bytes();
    if b.len() >= 2 {
        let (first, last) = (b[0], b[b.len() - 1]);
        if first == last && (first == b'"' || first == b'\'') {
            return &value[1..value.len() - 1];
        }
    }
    value
}

/// Ayristirilmis ciftleri uygular: `tanimli(anahtar)` true ise atlanir, aksi
/// halde `ayarla(anahtar, deger)` cagrilir. Yuklenen anahtar SAYISINI dondurur.
/// Ayni anahtar dosyada iki kez gecerse ilki kazanir (ikincisi artik "tanimli").
pub fn apply(
    pairs: &[(String, String)],
    mut tanimli: impl FnMut(&str) -> bool,
    mut ayarla: impl FnMut(&str, &str),
) -> usize {
    let mut yuklenen = 0;
    for (k, v) in pairs {
        if tanimli(k) {
            continue;
        }
        ayarla(k, v);
        yuklenen += 1;
    }
    yuklenen
}

/// `<veri koku>\smith.env`: tek kural her platformda ayni (Windows
/// `%USERPROFILE%\.smith\smith.env`, digerlerinde `~/.smith/smith.env`;
/// `SMITH_DATA_DIR` varsa o kok). Dosya OKUNMADAN once aranir; `SMITH_DATA_DIR`
/// yalniz dosyanin icinde tanimliysa varsayilan kokte aranir (bkz. `crate::paths`).
pub fn env_file_path() -> Option<PathBuf> {
    crate::paths::data_path("smith.env")
}

/// Dosyayi okuyup surec ortamina yukler. Tek-iplikli baslangicta cagrilmali
/// (`set_var` baska iplikler env okurken veri yarisi yaratir): `run()`in en
/// basinda, hicbir iplik/eklenti baslamadan once.
pub fn load_smith_env() {
    let Some(yol) = env_file_path() else {
        return;
    };
    let icerik = match std::fs::read_to_string(&yol) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            // Yol loglanir (sir degil); icerik asla.
            eprintln!("[env] smith.env okunamadi ({}): {e}", yol.display());
            return;
        }
    };
    let pairs = parse_env(&icerik);
    let yuklenen = apply(
        &pairs,
        |k| std::env::var_os(k).is_some(),
        |k, v| std::env::set_var(k, v),
    );
    eprintln!(
        "[env] smith.env: {yuklenen} anahtar yuklendi ({})",
        yol.display()
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn p(k: &str, v: &str) -> (String, String) {
        (k.to_string(), v.to_string())
    }

    #[test]
    fn temel_satirlar_ayristirilir() {
        let got = parse_env("A=1\nB=iki\nC=\n");
        assert_eq!(got, vec![p("A", "1"), p("B", "iki"), p("C", "")]);
    }

    #[test]
    fn yorum_ve_bos_satirlar_atlanir() {
        let got = parse_env("# yorum\n\n   \n  # girintili yorum\nA=1\n");
        assert_eq!(got, vec![p("A", "1")]);
    }

    #[test]
    fn tirnaklar_soyulur_yalniz_eslesen() {
        let got = parse_env("A=\"cift\"\nB='tek'\nC=\"yarim\nD=it's\nE=\"karisik'\nF=\"\"\n");
        assert_eq!(
            got,
            vec![
                p("A", "cift"),
                p("B", "tek"),
                p("C", "\"yarim"),
                p("D", "it's"),
                p("E", "\"karisik'"),
                p("F", ""),
            ]
        );
    }

    #[test]
    fn deger_icinde_esittir_ve_diyez_korunur() {
        // Ilk `=` ayirir; sonrasi degerdir. Satir ici `#` yorum degildir.
        let got = parse_env("URL=http://x/?a=b#frag\nTOKEN=abc==\n");
        assert_eq!(
            got,
            vec![p("URL", "http://x/?a=b#frag"), p("TOKEN", "abc==")]
        );
    }

    #[test]
    fn crlf_bom_ve_export_oneki() {
        let got = parse_env("\u{feff}A=1\r\nexport B=2\r\n  export   C = \"3\"  \r\n");
        assert_eq!(got, vec![p("A", "1"), p("B", "2"), p("C", "3")]);
    }

    #[test]
    fn gecersiz_satirlar_atlanir_panik_yok() {
        // `=`siz, anahtarsiz, bosluklu/rakamla baslayan anahtar, NUL'lu deger:
        // set_var panigine giden her sey ayristirmada elenir.
        let got = parse_env("SADECE_METIN\n=bos\nA B=1\n1A=2\nNUL=a\0b\nOK=1\n");
        assert_eq!(got, vec![p("OK", "1")]);
    }

    #[test]
    fn yalniz_tanimsiz_anahtarlar_yuklenir() {
        let pairs = parse_env("VAR=dosya\nYENI=yeni\nAYNI=ilk\nAYNI=ikinci\n");
        let mut env: HashMap<String, String> = HashMap::new();
        env.insert("VAR".into(), "isletim_sistemi".into());

        // `tanimli` ve `ayarla` ayni haritaya baktigi icin iki kapanis tek
        // RefCell uzerinden paylasilir.
        let env = std::cell::RefCell::new(env);
        let n = apply(
            &pairs,
            |k| env.borrow().contains_key(k),
            |k, v| {
                env.borrow_mut().insert(k.to_string(), v.to_string());
            },
        );
        let env = env.into_inner();

        assert_eq!(n, 2, "yalniz YENI ve AYNI(ilk) yuklenmeli");
        assert_eq!(env["VAR"], "isletim_sistemi", "mevcut deger ezilmez");
        assert_eq!(env["YENI"], "yeni");
        assert_eq!(env["AYNI"], "ilk", "tekrarlanan anahtarda ilki kazanir");
    }

    #[test]
    fn bos_tanimli_deger_de_tanimlidir() {
        // `setx X ""` gibi bos ama TANIMLI bir degisken dosyadakini ezmemeli.
        let pairs = parse_env("X=dosya\n");
        let n = apply(&pairs, |_| true, |_, _| panic!("ezilmemeli"));
        assert_eq!(n, 0);
    }

    #[test]
    fn dosya_yolu_veri_kokunde() {
        // Kok process env'ine bagli (SMITH_DATA_DIR ya da ev dizini); sabit olan:
        // dosya adi ve dosyanin dogrudan kokun altinda olmasi.
        if let Some(yol) = env_file_path() {
            assert_eq!(yol.file_name().unwrap(), "smith.env");
            assert_eq!(yol.parent(), crate::paths::data_dir().as_deref());
        }
    }
}
