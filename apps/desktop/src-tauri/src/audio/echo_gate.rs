//! Yanki politikasi ve mikrofon gorevine ait cihaz karari.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum YankiPolitikasi {
    Auto,
    On,
    Off,
}

impl YankiPolitikasi {
    pub fn parse(ham: Option<&str>) -> Self {
        match ham.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("on") => Self::On,
            Some("off") => Self::Off,
            _ => Self::Auto,
        }
    }

    pub(crate) fn etkin_mi(self, giris: &str, cikis: &str) -> bool {
        match self {
            Self::On => true,
            Self::Off => false,
            Self::Auto => !kulaklik(giris, cikis),
        }
    }
}

#[derive(Default)]
pub(crate) struct YankiKarari {
    son: Option<(YankiPolitikasi, String, String, bool)>,
}

impl YankiKarari {
    pub(crate) fn mikrofon_kapali_mi(
        &mut self,
        kip: YankiPolitikasi,
        giris: &str,
        cikis: &str,
        caliyor: bool,
        sustur: bool,
    ) -> bool {
        sustur || (caliyor && self.karar(kip, giris, cikis))
    }

    fn karar(&mut self, kip: YankiPolitikasi, giris: &str, cikis: &str) -> bool {
        if let Some((k, g, c, karar)) = &self.son {
            if *k == kip && g == giris && c == cikis {
                return *karar;
            }
        }
        let karar = kip.etkin_mi(giris, cikis);
        self.son = Some((kip, giris.into(), cikis.into(), karar));
        karar
    }
}

/// SAF karar: Turkce I/i dahil harf ve bosluk farklarini yok sayar.
fn kulaklik(giris: &str, cikis: &str) -> bool {
    fn normalize(ad: &str) -> String {
        ad.chars()
            .filter(|c| !c.is_whitespace() && *c != '\u{0307}')
            .flat_map(|c| match c {
                'I' | '\u{0130}' | '\u{0131}' => 'i'.to_lowercase(),
                _ => c.to_lowercase(),
            })
            .collect()
    }
    fn bilinen(ad: &str) -> bool {
        !matches!(
            ad,
            "" | "unknown" | "unknown device" | "unknowndevice" | "bilinmeyen" | "bilinmeyencihaz"
        )
    }
    let giris = normalize(giris);
    let cikis = normalize(cikis);
    if !bilinen(&giris) || !bilinen(&cikis) {
        return false;
    }
    [
        "kulaklik",
        "headphone",
        "headset",
        "earphone",
        "airpods",
        "buds",
    ]
    .iter()
    .any(|ad| cikis.contains(ad))
}

#[cfg(test)]
mod yanki_tests {
    use super::*;
    #[test]
    fn d1b_23_ayni_donanim_kulaklik_kaniti_degil() {
        assert!(YankiPolitikasi::Auto.etkin_mi(
            "Microphone Array (Realtek(R) Audio)",
            "Speakers (Realtek(R) Audio)"
        ));
        assert!(!YankiPolitikasi::Auto.etkin_mi("Mikrofon (Fuxi-H7 )", "Kulakliklar (Fuxi-H7 )"));
    }

    #[test]
    fn audit_onbellek_cihaz_degisimini_izler() {
        let mut k = YankiKarari::default();
        assert!(!k.karar(YankiPolitikasi::Auto, "Mic", "Headphones"));
        let onceki = k.son.as_ref().unwrap().1.as_ptr();
        assert!(!k.karar(YankiPolitikasi::Auto, "Mic", "Headphones"));
        assert_eq!(onceki, k.son.as_ref().unwrap().1.as_ptr());
        assert!(k.karar(YankiPolitikasi::Auto, "Mic", "Speaker"));
        assert!(!k.karar(YankiPolitikasi::Off, "Mic", "Speaker"));
    }

    #[test]
    fn cihaz_karari_bosluk_turkce_ve_bilinmeyen() {
        for (giris, cikis, acik) in [
            ("Mikrofon (Fuxi-H7 )", "Kulaklik (Fuxi-H7 )", false),
            (
                "Mikrofon ( FUXI-H7)",
                "Kulakl\u{0131}k (fux\u{0131}-h7 )",
                false,
            ),
            ("Mikrofon (FUX\u{0130})", "KULAKL\u{0130}K (fuxi)", false),
            // Ayni donanim adi tek basina kulaklik kaniti DEGILDIR (laptop hoparlor).
            ("Mikrofon (Fuxi-H7 )", "Cikis (Fuxi-H7 )", true),
            ("USB mic", "KULAKLIK", false),
            ("USB mic", "Headphones", false),
            ("USB mic", "Headset", false),
            ("USB mic", "Earphones", false),
            ("USB mic", "AirPods", false),
            ("USB mic", "Galaxy Buds", false),
            ("Mikrofon (USB)", "Hoparlor (Realtek)", true),
            ("Mic ()", "Speaker ()", true),
            ("Mic (unknown)", "Speaker (unknown)", true),
            ("", "Headphones", true),
            ("Mic", "", true),
            ("Mic", "bilinmeyen", true),
        ] {
            assert_eq!(
                YankiPolitikasi::Auto.etkin_mi(giris, cikis),
                acik,
                "{giris} / {cikis}"
            );
        }
    }

    #[test]
    fn zorlama_ve_susturma_yanki_kararindan_bagimsiz() {
        for ham in [None, Some("auto"), Some("bilinmeyen")] {
            assert_eq!(YankiPolitikasi::parse(ham), YankiPolitikasi::Auto);
        }
        assert_eq!(YankiPolitikasi::parse(Some(" ON ")), YankiPolitikasi::On);
        assert_eq!(YankiPolitikasi::parse(Some("off")), YankiPolitikasi::Off);
        for kip in [
            YankiPolitikasi::Auto,
            YankiPolitikasi::On,
            YankiPolitikasi::Off,
        ] {
            assert!(YankiKarari::default().mikrofon_kapali_mi(kip, "Mic", "Headset", true, true));
            assert!(YankiKarari::default().mikrofon_kapali_mi(kip, "Mic", "Speaker", false, true));
            assert!(!YankiKarari::default().mikrofon_kapali_mi(kip, "Mic", "Speaker", false, false));
        }
        assert!(!YankiKarari::default().mikrofon_kapali_mi(
            YankiPolitikasi::Auto,
            "Mic",
            "Headset",
            true,
            false
        ));
        assert!(YankiKarari::default().mikrofon_kapali_mi(
            YankiPolitikasi::Auto,
            "Mic",
            "Speaker",
            true,
            false
        ));
        assert!(YankiKarari::default().mikrofon_kapali_mi(
            YankiPolitikasi::On,
            "Mic",
            "Headset",
            true,
            false
        ));
        assert!(!YankiKarari::default().mikrofon_kapali_mi(
            YankiPolitikasi::Off,
            "Mic",
            "Speaker",
            true,
            false
        ));
    }
}
