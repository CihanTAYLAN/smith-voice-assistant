//! Bayrak env degiskenlerinin TEK semantigi.
//!
//! NEDEN VAR: 2026-08-15 denetiminde aynı crate'te DORT ayri lehce bulundu ve
//! ucu sessiz tuzak uretiyordu:
//!   - `SMITH_LIVE`  : `v != "0" && !v.is_empty()`, trim YOK, varsayilan KAPALI
//!     -> `dev-win.ps1` dot-source edilmeden `tauri dev` kosulunca Smith
//!     YAPISAL OLARAK SESSIZ kaliyordu. Ustelik kardes bayragin yanindaki yorum
//!     "yalniz 0 kapatir" diye TERSINI iddia ediyordu. Ayrica `" 0 "` (bosluklu)
//!     Live'i ACIYORDU.
//!   - `SMITH_SCREEN`: yalniz `v == "1"` -> `SMITH_SCREEN=true` SESSIZCE
//!     hicbir sey yapmiyordu.
//!   - `SMITH_STT_DEBUG_WAV`: `.is_ok()` -> `=0` bile ACIYORDU.
//! Dogru davranan ucu (`SMITH_LIVE_RESUME`, `SMITH_CONVERSATION_MEMORY`,
//! `SMITH_BOOT_CONTEXT`) ayni kodu ucuncu kez tekrar ediyordu.
//!
//! IKI MESRU VARSAYILAN vardir ve karisti1rilmamalidir:
//!   - `acik_varsayilan_acik`  : ozellik urunun parcasi, kapatmak istisna.
//!   - `acik_varsayilan_kapali`: acmak BILINCLI bir karar olmali — ekran
//!     icerigi buluta gider, teshis WAV'i diske ham ses yazar. Bunlarin
//!     "tanimsizsa acik" olmasi gizlilik acisindan kabul edilemez.
//!
//! Iki yolda da deger `trim` edilir ve yaygin yazimlar kabul edilir; tanimadigi
//! bir deger SESSIZCE yutulmaz, uyarilir ve varsayilana duser.

/// Kapali sayilan yazimlar.
const KAPALI: &[&str] = &["0", "false", "no", "off", "hayir", "kapali"];
/// Acik sayilan yazimlar.
const ACIK: &[&str] = &["1", "true", "yes", "on", "evet", "acik"];

/// Ham degeri uc duruma cevirir: `Some(true/false)` veya taninmadi (`None`).
fn coz(raw: &str) -> Option<bool> {
    let t = raw.trim().to_ascii_lowercase();
    if t.is_empty() {
        return None;
    }
    if KAPALI.contains(&t.as_str()) {
        return Some(false);
    }
    if ACIK.contains(&t.as_str()) {
        return Some(true);
    }
    None
}

fn oku(ad: &str, varsayilan: bool) -> bool {
    match std::env::var(ad) {
        Err(_) => varsayilan,
        Ok(raw) => match coz(&raw) {
            Some(v) => v,
            None => {
                // Taninmayan deger sessizce yutulmaz: kullanici bir sey
                // yazdiysa bir sey kastetmistir, ama ne kastettigini
                // tahmin etmiyoruz.
                eprintln!(
                    "[env] {ad}={raw:?} taninmadi -> varsayilan {} kullaniliyor \
                     (kabul edilenler: {} / {})",
                    if varsayilan { "ACIK" } else { "KAPALI" },
                    ACIK.join(","),
                    KAPALI.join(",")
                );
                varsayilan
            }
        },
    }
}

/// Urunun parcasi olan ozellikler: tanimsizsa ACIK, kapatmak istisna.
pub fn acik_varsayilan_acik(ad: &str) -> bool {
    oku(ad, true)
}

/// Gizlilik veya disk etkisi olan ozellikler: tanimsizsa KAPALI, acmak
/// BILINCLI bir karar.
pub fn acik_varsayilan_kapali(ad: &str) -> bool {
    oku(ad, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yaygin_yazimlar_ve_bosluk() {
        for s in ["0", " 0 ", "false", "FALSE", "off", "No", "kapali"] {
            assert_eq!(coz(s), Some(false), "{s:?} kapali sayilmali");
        }
        for s in ["1", " 1 ", "true", "TRUE", "on", "Yes", "acik"] {
            assert_eq!(coz(s), Some(true), "{s:?} acik sayilmali");
        }
    }

    /// SAHADA YASANAN TUZAK: bosluklu "0" bir bayragi ACIYORDU. Trim'in
    /// kaybolmasi bu testi kirmizi yapar.
    #[test]
    fn bosluklu_sifir_acmaz() {
        assert_eq!(coz(" 0 "), Some(false));
        assert_eq!(coz("\t0\n"), Some(false));
    }

    #[test]
    fn bos_ve_taninmayan_none_doner() {
        assert_eq!(coz(""), None);
        assert_eq!(coz("   "), None);
        assert_eq!(coz("belki"), None);
        assert_eq!(coz("2"), None);
    }

    /// Taninmayan deger VARSAYILANA duser — iki yonde de.
    #[test]
    fn taninmayan_deger_varsayilani_bozmaz() {
        assert!(coz("belki").is_none());
        // `oku` env'e dokunmadan sinanamaz; burada karar tablosunu sabitliyoruz:
        // None + varsayilan(true) => true, None + varsayilan(false) => false.
        for (varsayilan, beklenen) in [(true, true), (false, false)] {
            assert_eq!(coz("belki").unwrap_or(varsayilan), beklenen);
        }
    }

    /// IKI VARSAYILANIN AYRILIGI KORUNMALI: gizlilik etkisi olan bayraklarin
    /// "tanimsizsa acik" olmasi kabul edilemez.
    #[test]
    fn iki_varsayilan_ayri_kalir() {
        let ad = "SMITH_TEST_OLMAYAN_BAYRAK_XYZ";
        assert!(std::env::var(ad).is_err(), "test bayragi ortamda olmamali");
        assert!(
            acik_varsayilan_acik(ad),
            "urun ozelligi tanimsizsa ACIK olmali"
        );
        assert!(
            !acik_varsayilan_kapali(ad),
            "gizlilik etkili ozellik tanimsizsa KAPALI olmali"
        );
    }
}
