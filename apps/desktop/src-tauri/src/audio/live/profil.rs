//! Kisisel profil blogu: gateway'deki kalici bilgileri (sehir, dogum gunu, ...) her
//! oturumun yonergesinin dinamik kuyruguna ekleyen metin.
//!
//! Kaynak `GET /v1/tools/profile` (`{"entries":[{anahtar, deger, guncellendi}],
//! "cihazlar":[{ad, yuzey, sonGorulme}]}`). Profil yalniz Cihan'in ACIKCA
//! kaydettirdigi bilgileri tasir; konusmadan cikarim yapilmaz (kullanici karari).
//! Blok YALNIZ en az bir gecerli kayit varsa uretilir: kayit yokken modele "profil
//! var" izlenimi vermek, bilmedigi bir seyi bildigini sanmasina yol acar. Hata ya da
//! bos profilde bos string doner ve modele hicbir sey soylenmez.

use serde_json::Value;

use super::conversation::tek_satir;

/// Bloga hitap eden baslik: metin INSANA DEGIL MODELE yazilir.
pub(super) const BASLIK: &str =
    "CIHAN PROFILI (Cihan'in acikca kaydettirdigi kalici bilgiler; guncel kabul et):";
/// Blogun sert bayt tavani (baslik, cihaz ve saat dilimi satirlari dahil). Asilirsa
/// en eski guncellenen kayitlar duser.
pub(super) const MAX_BAYT: usize = 768;
/// Cihaz satirinin sinirlari: ad uzunlugu (karakter) ve en cok cihaz.
const CIHAZ_AD_KARAKTER: usize = 40;
const MAX_CIHAZ: usize = 6;

/// Modele donen ret metinleri: gateway 400'u gerekce tasimaz (`GatewayClient` yalniz
/// durum kodunu bildirir), bu yuzden kurallar once burada uygulanir.
pub(super) const ANAHTAR_GECERSIZ: &str = "anahtar ASCII kucuk harf, rakam ve alt cizgi olmali (2-40 karakter, or. sehir, dogum_gunu); Turkce soyleneni sen cevir";
pub(super) const DEGER_GECERSIZ: &str = "deger 1-300 karakter ve tek satir olmali";
const MAX_DEGER_KARAKTER: usize = 300;

/// Gateway'in deger kurali: kirpilmis, 1-300 karakter, tek satir (kontrol ve satir/
/// paragraf ayiricisi yok).
pub(super) fn deger_gecerli(deger: &str) -> bool {
    !deger.is_empty()
        && deger.chars().count() <= MAX_DEGER_KARAKTER
        && !deger
            .chars()
            .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
}

struct Kayit {
    anahtar: String,
    deger: String,
    /// ISO 8601 UTC (JS `toISOString`: sabit genislik, sozluk sirasi = zaman sirasi).
    guncellendi: String,
}

/// Gateway'in anahtar kurali: `[a-z0-9_]{2,40}`. Kural disi anahtar profil satiri
/// olamaz (satir bicimi modele "anahtar: deger" olarak gider).
pub(super) fn anahtar_gecerli(anahtar: &str) -> bool {
    (2..=40).contains(&anahtar.len())
        && anahtar
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn kayitlari_ayristir(yanit: &Value) -> Vec<Kayit> {
    yanit["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| {
            let anahtar = e["anahtar"].as_str().filter(|a| anahtar_gecerli(a))?;
            let deger = tek_satir(e["deger"].as_str()?);
            (!deger.is_empty()).then(|| Kayit {
                anahtar: anahtar.to_string(),
                deger,
                guncellendi: e["guncellendi"].as_str().unwrap_or_default().to_string(),
            })
        })
        .collect()
}

/// `Kayitli cihazlar: ad (yuzey), ...`; cihaz yoksa `None`.
fn cihaz_satiri(yanit: &Value) -> Option<String> {
    let liste: Vec<String> = yanit["cihazlar"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let ad = tek_satir(c["ad"].as_str()?);
            let ad: String = ad.chars().take(CIHAZ_AD_KARAKTER).collect();
            let yuzey = tek_satir(c["yuzey"].as_str().unwrap_or_default());
            (!ad.is_empty()).then(|| {
                if yuzey.is_empty() {
                    ad
                } else {
                    format!("{ad} ({yuzey})")
                }
            })
        })
        .take(MAX_CIHAZ)
        .collect();
    (!liste.is_empty()).then(|| format!("Kayitli cihazlar: {}", liste.join(", ")))
}

/// Gateway yanitindan profil blogu ve tavan yuzunden DUSEN kayit sayisi.
/// `saat_dilimi`: ayri bir satir (`saat_dilimi_cumlesi`), yalniz blok varsa girer.
/// Yanit yoksa (gateway kapali/hata) ya da gecerli kayit yoksa `("", 0)`.
///
/// Tavan: sabit satirlar (baslik, cihazlar, saat dilimi) once ayrilir; kayitlar EN
/// YENI guncellenenden eskiye eklenir, sigmayan ilk kayit ve daha eskileri duser.
/// Gosterim sirasi anahtar sirasidir (oturumlar arasi kararli metin).
pub(super) fn profil_eki(yanit: Option<&Value>, saat_dilimi: Option<&str>) -> (String, usize) {
    let Some(yanit) = yanit else {
        return (String::new(), 0);
    };
    let mut kayitlar = kayitlari_ayristir(yanit);
    if kayitlar.is_empty() {
        return (String::new(), 0);
    }
    let sabit = |cihaz: &Option<String>| -> usize {
        BASLIK.len()
            + cihaz.as_ref().map_or(0, |c| 1 + c.len())
            + saat_dilimi.map_or(0, |s| 1 + s.len())
    };
    let mut cihaz = cihaz_satiri(yanit);
    if sabit(&cihaz) > MAX_BAYT {
        cihaz = None; // cihaz listesi kayit alanini yemesin
    }
    let mut kullanilan = sabit(&cihaz);

    kayitlar.sort_by(|a, b| {
        b.guncellendi
            .cmp(&a.guncellendi)
            .then_with(|| a.anahtar.cmp(&b.anahtar))
    });
    let toplam = kayitlar.len();
    let mut tutulan = Vec::new();
    for k in kayitlar {
        let satir = 1 + "- ".len() + k.anahtar.len() + ": ".len() + k.deger.len();
        if kullanilan + satir > MAX_BAYT {
            break;
        }
        kullanilan += satir;
        tutulan.push(k);
    }
    let dusen = toplam - tutulan.len();
    if tutulan.is_empty() {
        return (String::new(), dusen);
    }
    tutulan.sort_by(|a, b| a.anahtar.cmp(&b.anahtar));

    let mut blok = String::with_capacity(kullanilan);
    blok.push_str(BASLIK);
    for k in &tutulan {
        blok.push_str(&format!("\n- {}: {}", k.anahtar, k.deger));
    }
    if let Some(c) = cihaz {
        blok.push('\n');
        blok.push_str(&c);
    }
    if let Some(s) = saat_dilimi {
        blok.push('\n');
        blok.push_str(s);
    }
    (blok, dusen)
}

/// Gateway cagrisinin sonucundan yonerge blogu. `son_konusma_blogu` ile ayni
/// sozlesme: gateway kapali/hata, bos profil ya da gecersiz yanit icin bos string;
/// UCUNDE DE MODELE HICBIR SEY SOYLENMEZ (elde bilgi yokken "profilin var" demek
/// modeli uydurmaya davet ederdi). Sebep loga yazilir.
pub(super) fn blok_hazirla(sonuc: Result<Value, String>, saat_dilimi: Option<&str>) -> String {
    let yanit = match sonuc {
        Ok(v) => Some(v),
        Err(e) => {
            eprintln!("[profil] profil alinamadi: {e}");
            None
        }
    };
    let (blok, dusen) = profil_eki(yanit.as_ref(), saat_dilimi);
    if dusen > 0 {
        eprintln!("[profil] {MAX_BAYT} bayt tavani asildi: en eski {dusen} kayit dustu");
    }
    if blok.is_empty() {
        eprintln!("[profil] profil blogu bos, yonergeye ek yok");
    } else {
        eprintln!("[profil] profil blogu hazir ({} bayt)", blok.len());
    }
    blok
}

/// `Saat dilimi: Turkey Standard Time (UTC+03:00)`.
fn saat_dilimi_cumlesi(ad: &str, sapma_dk: i32) -> String {
    let isaret = if sapma_dk < 0 { '-' } else { '+' };
    let dk = sapma_dk.unsigned_abs();
    format!(
        "Saat dilimi: {} (UTC{isaret}{:02}:{:02})",
        tek_satir(ad),
        dk / 60,
        dk % 60
    )
}

#[cfg(windows)]
#[allow(non_snake_case)]
mod win {
    #[repr(C)]
    pub struct SYSTEMTIME {
        pub wYear: u16,
        pub wMonth: u16,
        pub wDayOfWeek: u16,
        pub wDay: u16,
        pub wHour: u16,
        pub wMinute: u16,
        pub wSecond: u16,
        pub wMilliseconds: u16,
    }

    #[repr(C)]
    pub struct DYNAMIC_TIME_ZONE_INFORMATION {
        pub Bias: i32,
        pub StandardName: [u16; 32],
        pub StandardDate: SYSTEMTIME,
        pub StandardBias: i32,
        pub DaylightName: [u16; 32],
        pub DaylightDate: SYSTEMTIME,
        pub DaylightBias: i32,
        pub TimeZoneKeyName: [u16; 128],
        pub DynamicDaylightTimeDisabled: u8,
    }

    pub const TIME_ZONE_ID_DAYLIGHT: u32 = 2;
    pub const TIME_ZONE_ID_INVALID: u32 = 0xFFFF_FFFF;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetDynamicTimeZoneInformation(info: *mut DYNAMIC_TIME_ZONE_INFORMATION) -> u32;
    }
}

/// Isletim sisteminin saat dilimi (ad + UTC sapmasi) tek satir olarak. Acilis
/// baglaminin ZAMAN satiri yalniz yerel saati verir, sapmayi vermez; hatirlatma
/// ofsetli zaman ister. Win32 FFI, surec acmaz (`boot_context` ile ayni gerekce).
/// Windows disinda `None`.
#[cfg(windows)]
pub(super) fn yerel_saat_dilimi() -> Option<String> {
    let mut bilgi = std::mem::MaybeUninit::<win::DYNAMIC_TIME_ZONE_INFORMATION>::zeroed();
    // SAFETY: API yalniz verilen yapiya yazar; sifirlanmis bellek bu duz-veri
    // yapisi (i32/u16/u8 alanlari) icin gecerli bir deger.
    let kimlik = unsafe { win::GetDynamicTimeZoneInformation(bilgi.as_mut_ptr()) };
    if kimlik == win::TIME_ZONE_ID_INVALID {
        return None;
    }
    // SAFETY: cagri basarili; yapi tamamen sifirlandi ve API tarafindan dolduruldu.
    let bilgi = unsafe { bilgi.assume_init() };
    let ad_coz = |u: &[u16]| {
        let son = u.iter().position(|c| *c == 0).unwrap_or(u.len());
        String::from_utf16_lossy(&u[..son])
    };
    let mut ad = ad_coz(&bilgi.TimeZoneKeyName);
    if ad.is_empty() {
        ad = ad_coz(&bilgi.StandardName);
    }
    if ad.is_empty() {
        return None;
    }
    let ek = if kimlik == win::TIME_ZONE_ID_DAYLIGHT {
        bilgi.DaylightBias
    } else {
        bilgi.StandardBias
    };
    // Bias = UTC - yerel (dakika): UTC+03:00 icin -180.
    Some(saat_dilimi_cumlesi(&ad, -(bilgi.Bias + ek)))
}

#[cfg(not(windows))]
pub(super) fn yerel_saat_dilimi() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn yanit(kayitlar: &[(&str, &str, &str)]) -> Value {
        json!({
            "entries": kayitlar
                .iter()
                .map(|(a, d, g)| json!({ "anahtar": a, "deger": d, "guncellendi": g }))
                .collect::<Vec<_>>(),
            "cihazlar": [
                { "ad": "Cihan-PC", "yuzey": "windows", "sonGorulme": "2026-10-03T08:00:00.000Z" }
            ],
        })
    }

    #[test]
    fn blok_bicimi_baslik_kayitlar_cihaz_ve_saat_dilimi() {
        let y = yanit(&[
            ("sehir", "Istanbul", "2026-10-03T07:00:00.000Z"),
            ("dogum_gunu", "12 Mart", "2026-10-02T07:00:00.000Z"),
        ]);
        let (blok, dusen) = profil_eki(
            Some(&y),
            Some("Saat dilimi: Turkey Standard Time (UTC+03:00)"),
        );
        assert_eq!(dusen, 0);
        assert_eq!(
            blok,
            "CIHAN PROFILI (Cihan'in acikca kaydettirdigi kalici bilgiler; guncel kabul et):\n\
             - dogum_gunu: 12 Mart\n\
             - sehir: Istanbul\n\
             Kayitli cihazlar: Cihan-PC (windows)\n\
             Saat dilimi: Turkey Standard Time (UTC+03:00)"
        );
        // Saat dilimi bilinmiyorsa satir hic girmez.
        let (blok, _) = profil_eki(Some(&y), None);
        assert!(!blok.contains("Saat dilimi") && blok.contains("Kayitli cihazlar"));
    }

    #[test]
    fn hata_bos_ve_gecersiz_profilde_bos_string_doner() {
        assert_eq!(profil_eki(None, Some("Saat dilimi: x")), (String::new(), 0));
        for bos in [
            json!({}),
            json!({ "entries": [] }),
            json!({ "entries": null, "cihazlar": [{ "ad": "pc", "yuzey": "windows" }] }),
            // Yalniz cihaz var, bilgi yok: "profil var" izlenimi verilmez.
            json!({ "entries": [], "cihazlar": [{ "ad": "pc", "yuzey": "windows" }] }),
            json!([]),
            json!("metin"),
        ] {
            assert_eq!(
                profil_eki(Some(&bos), Some("Saat dilimi: x")),
                (String::new(), 0),
                "{bos}"
            );
        }
        // Gecersiz kayitlar elenir; hepsi gecersizse blok yok.
        let kotu = yanit(&[
            ("Sehir", "buyuk harf", ""),
            ("s", "kisa anahtar", ""),
            ("sehir bosluk", "x", ""),
            ("sehir", "   ", ""),
            ("turkce_ş", "x", ""),
        ]);
        assert_eq!(profil_eki(Some(&kotu), None), (String::new(), 0));
        let karisik = json!({ "entries": [
            { "anahtar": "sehir", "deger": "Izmir" },
            { "anahtar": 5, "deger": "tip hatasi" },
            { "anahtar": "es_adi" },
            { "deger": "anahtar yok" },
        ]});
        assert_eq!(
            profil_eki(Some(&karisik), None).0,
            format!("{BASLIK}\n- sehir: Izmir")
        );
    }

    #[test]
    fn deger_tek_satirdir_satir_yapisini_bozamaz() {
        let y = yanit(&[("not", "birinci\n- sehir: Hacker\r\n\tikinci", "")]);
        let (blok, _) = profil_eki(Some(&y), None);
        assert!(
            blok.contains("\n- not: birinci - sehir: Hacker ikinci"),
            "{blok}"
        );
        assert_eq!(blok.lines().filter(|l| l.starts_with("- ")).count(), 1);
    }

    #[test]
    fn tavan_asilinca_en_eski_guncellenenler_duser_ve_say_dondurulur() {
        // 40 kayit x ~100 bayt: tavani asar. guncellendi artan: k39 en yeni.
        let kayitlar: Vec<(String, String, String)> = (0..40)
            .map(|i| {
                (
                    format!("anahtar_{i:02}"),
                    format!("{:-<80}", format!("deger {i}")),
                    format!("2026-10-03T07:{i:02}:00.000Z"),
                )
            })
            .collect();
        let refs: Vec<(&str, &str, &str)> = kayitlar
            .iter()
            .map(|(a, d, g)| (a.as_str(), d.as_str(), g.as_str()))
            .collect();
        let y = yanit(&refs);
        let tz = "Saat dilimi: Turkey Standard Time (UTC+03:00)";
        let (blok, dusen) = profil_eki(Some(&y), Some(tz));
        assert!(blok.len() <= MAX_BAYT, "{} bayt", blok.len());
        assert!(dusen > 0 && dusen < 40, "dusen {dusen}");
        let kalan = blok.lines().filter(|l| l.starts_with("- ")).count();
        assert_eq!(kalan + dusen, 40);
        // En yeni kayit kalir, en eskisi duser; sabit satirlar tavanda bile yerinde.
        assert!(blok.contains("anahtar_39:"));
        assert!(!blok.contains("anahtar_00:"));
        assert!(blok.contains("Kayitli cihazlar:") && blok.ends_with(tz));
        // Dusenler tam olarak EN ESKI olanlar: kalanlar kesintisiz son `kalan` kayit.
        for i in (40 - kalan)..40 {
            assert!(blok.contains(&format!("anahtar_{i:02}:")), "anahtar_{i:02}");
        }
        // Gosterim sirasi anahtar sirasi (kararli metin).
        let sirali: Vec<&str> = blok
            .lines()
            .filter(|l| l.starts_with("- "))
            .map(|l| l.split(':').next().unwrap())
            .collect();
        let mut kopya = sirali.clone();
        kopya.sort_unstable();
        assert_eq!(sirali, kopya);
    }

    #[test]
    fn zaman_damgasi_olmayan_kayit_en_eski_sayilir() {
        let buyuk = "x".repeat(300);
        let mut kayitlar: Vec<(String, String, String)> = (0..8)
            .map(|i| {
                (
                    format!("dolgu_{i}"),
                    buyuk.clone(),
                    format!("2026-10-03T07:0{i}:00.000Z"),
                )
            })
            .collect();
        kayitlar.push(("damgasiz".into(), buyuk, String::new()));
        let refs: Vec<(&str, &str, &str)> = kayitlar
            .iter()
            .map(|(a, d, g)| (a.as_str(), d.as_str(), g.as_str()))
            .collect();
        let (blok, dusen) = profil_eki(Some(&yanit(&refs)), None);
        assert!(dusen >= 1);
        assert!(!blok.contains("damgasiz:"), "damgasiz ilk dusmeli");
        assert!(blok.contains("dolgu_7:"));
    }

    #[test]
    fn cihaz_satiri_sinirli_ve_cihaz_yoksa_hic_girmez() {
        let mut y = yanit(&[("sehir", "Istanbul", "")]);
        y["cihazlar"] = json!((0..10)
            .map(|i| json!({ "ad": format!("cihaz-{i}-{}", "u".repeat(60)), "yuzey": "ios" }))
            .collect::<Vec<_>>());
        let blok = profil_eki(Some(&y), None).0;
        let satir = blok
            .lines()
            .find(|l| l.starts_with("Kayitli cihazlar:"))
            .unwrap();
        assert_eq!(satir.matches("(ios)").count(), MAX_CIHAZ);
        assert!(satir.contains("cihaz-0-uuu") && !satir.contains("cihaz-6-"));
        assert!(
            !satir.contains(&"u".repeat(CIHAZ_AD_KARAKTER)),
            "ad kirpilmali"
        );
        y["cihazlar"] = json!([]);
        assert!(!profil_eki(Some(&y), None).0.contains("Kayitli cihazlar"));
        y["cihazlar"] = json!([{ "ad": "pc" }]);
        assert!(profil_eki(Some(&y), None)
            .0
            .ends_with("Kayitli cihazlar: pc"));
    }

    /// Gateway cagrisi hatali/bos/dolu donerken yonerge blogu: hata ve bos profilde
    /// bos string (modele hicbir sey soylenmez), doluysa blok.
    #[test]
    fn blok_hazirla_hata_bos_ve_dolu_halleri() {
        assert_eq!(
            blok_hazirla(Err("baglanti reddedildi".into()), Some("Saat dilimi: x")),
            ""
        );
        assert_eq!(blok_hazirla(Ok(json!({ "entries": [] })), None), "");
        assert_eq!(blok_hazirla(Ok(json!("beklenmeyen")), None), "");
        let y = yanit(&[("sehir", "Istanbul", "2026-10-03T07:00:00.000Z")]);
        let blok = blok_hazirla(Ok(y), Some("Saat dilimi: x"));
        assert!(blok.starts_with(BASLIK), "{blok}");
        assert!(blok.contains("\n- sehir: Istanbul"), "{blok}");
        assert!(blok.ends_with("Saat dilimi: x"), "{blok}");
    }

    #[test]
    fn anahtar_ve_deger_kurallari() {
        for iyi in ["sehir", "dogum_gunu", "es_adi", "ab", "a1", &"a".repeat(40)] {
            assert!(anahtar_gecerli(iyi), "{iyi}");
        }
        for kotu in [
            "",
            "a",
            "Sehir",
            "şehir",
            "sehir adi",
            "sehir-adi",
            "a/b",
            "..",
            &"a".repeat(41),
        ] {
            assert!(!anahtar_gecerli(kotu), "{kotu:?}");
        }
        assert!(deger_gecerli("Istanbul"));
        assert!(deger_gecerli(&"ş".repeat(300)));
        for kotu in [
            "",
            &"a".repeat(301),
            "iki\nsatir",
            "sekme\tvar",
            "ayirici\u{2028}x",
            "p\u{2029}",
        ] {
            assert!(!deger_gecerli(kotu), "{kotu:?}");
        }
    }

    #[test]
    fn saat_dilimi_cumlesi_isaret_ve_dakika() {
        for (ad, dk, beklenen) in [
            (
                "Turkey Standard Time",
                180,
                "Saat dilimi: Turkey Standard Time (UTC+03:00)",
            ),
            (
                "Eastern Standard Time",
                -300,
                "Saat dilimi: Eastern Standard Time (UTC-05:00)",
            ),
            (
                "India Standard Time",
                330,
                "Saat dilimi: India Standard Time (UTC+05:30)",
            ),
            ("UTC", 0, "Saat dilimi: UTC (UTC+00:00)"),
            (
                "Newfoundland Standard Time",
                -210,
                "Saat dilimi: Newfoundland Standard Time (UTC-03:30)",
            ),
        ] {
            assert_eq!(saat_dilimi_cumlesi(ad, dk), beklenen);
        }
    }

    /// CANLI (Win32): sapma makul, ad dolu ve cumle tek satir.
    #[cfg(windows)]
    #[test]
    fn yerel_saat_dilimi_isletim_sisteminden_okunur() {
        let c = yerel_saat_dilimi().expect("saat dilimi okunamadi");
        assert!(c.starts_with("Saat dilimi: ") && !c.contains('\n'), "{c}");
        let sapma = c.rsplit_once("(UTC").unwrap().1.trim_end_matches(')');
        let isaret = if sapma.starts_with('-') { -1 } else { 1 };
        let (s, d) = sapma[1..].split_once(':').expect("SS:DD");
        let dk = isaret * (s.parse::<i32>().unwrap() * 60 + d.parse::<i32>().unwrap());
        assert!((-12 * 60..=14 * 60).contains(&dk), "{c}");
        // Ayni sorgu iki kez ayni sonucu verir (kararli, yan etkisiz).
        assert_eq!(yerel_saat_dilimi().as_deref(), Some(c.as_str()));
    }
}
