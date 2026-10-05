//! Ekran akisi ve net kare yanitlari.

use super::tools::{yanit_nesnesi, Arac};
use super::LiveEvent;
use base64::Engine as _;

/// Surekli ekran akisinin ACIK/KAPALI degisimini UI'a tasiyan sozde-"arac"
/// (`ad`). `LIVE_BAGLANTI` ile ayni desen ve ayni gerekce: `lib.rs`
/// `LiveEvent` uzerinde exhaustive match yapiyor, yeni varyant o dosyayi da
/// degistirmeyi gerektirirdi. `durum` degeri `EKRAN_AKISI_ACIK` ya da
/// `EKRAN_AKISI_KAPALI` (bilinmeyen `durum`u eski UI yok sayar); `sebep`
/// `{"akis_acik":true|false}` JSON'u. Olay YALNIZ degisimde yayinlanir.
pub(super) const EKRAN_AKISI_DURUMU: &str = "ekran_akisi_durumu";
pub(super) const EKRAN_AKISI_ACIK: &str = "akis_acik";
pub(super) const EKRAN_AKISI_KAPALI: &str = "akis_kapali";

fn net_kare_yaniti(etiketler: Vec<String>) -> serde_json::Value {
    serde_json::json!({
        "durum": "net kare gonderildi",
        "ekranlar": etiketler,
        "yonlendirme": "Bu yanittaki karelere bak (sirayla her ekran bir kare) ve simdi cevap ver; araci TEKRAR CAGIRMA."
    })
}

/// Net kareler ve ekran etiketleri ayni yanitta, ayni sirada tasinir.
pub(super) fn net_kare_cercevesi(
    id: &str,
    sonuc: Result<Vec<crate::audio::screen::ScreenFrame>, String>,
) -> String {
    let mut yanit = serde_json::json!({ "id": id, "name": Arac::EkraniNetGor.ad() });
    let note = match sonuc {
        Ok(kareler) => {
            let adet = kareler.len();
            let mut kb_toplam = 0usize;
            let mut etiketler = Vec::with_capacity(adet);
            let mut parts = Vec::with_capacity(adet);
            for kare in kareler {
                kb_toplam += kare.jpeg.len() / 1024;
                etiketler.push(kare.label);
                parts.push(serde_json::json!({ "inlineData": {
                    "mimeType": "image/jpeg",
                    "data": base64::engine::general_purpose::STANDARD.encode(&kare.jpeg)
                }}));
            }
            yanit["parts"] = serde_json::json!(parts);
            eprintln!(
                "[screen] net kare gonderildi ({adet} ekran, {kb_toplam} KB), arac yanitinda"
            );
            net_kare_yaniti(etiketler)
        }
        Err(e) => serde_json::json!({ "hata": e }),
    };
    yanit["response"] = yanit_nesnesi(note);
    serde_json::json!({ "toolResponse": { "functionResponses": [yanit] } }).to_string()
}

/// Ekran akisi KAPALIYKEN dongunun bayragi yoklama araligi. Kapaliyken
/// yakalama yapilmaz; acma istegi (ve UI bildirimi) en gec bu kadar gecikir.
pub(super) const EKRAN_KAPALI_UYKU: std::time::Duration = std::time::Duration::from_millis(500);

pub(super) enum GidenCerceve {
    Kontrol(String),
    Arac {
        metin: String,
        id: String,
        tur: u64,
        bas: std::time::Instant,
    },
    Ekran {
        metin: String,
        surum: u64,
    },
}

impl GidenCerceve {
    /// Gercek WS yazimindan hemen once: kuyrukta bekleyen eski kareyi at.
    pub(super) fn metin(self, simdiki_surum: u64) -> Option<String> {
        match self {
            Self::Kontrol(metin) | Self::Arac { metin, .. } => Some(metin),
            Self::Ekran { metin, surum } if surum & 1 == 1 && surum == simdiki_surum => Some(metin),
            Self::Ekran { .. } => None,
        }
    }
}

pub(super) async fn ekran_yakala<T: Send + 'static>(
    yakala: impl FnOnce() -> Result<Vec<T>, String> + Send + 'static,
    izin: impl Fn() -> bool,
) -> Result<Vec<T>, String> {
    if !izin() {
        return Ok(Vec::new());
    }
    let kareler = tokio::task::spawn_blocking(yakala)
        .await
        .map_err(|e| e.to_string())??;
    Ok(if izin() { kareler } else { Vec::new() })
}

/// Ekran akisi durum degisimini UI olayina cevirir (bkz. `EKRAN_AKISI_DURUMU`).
pub(super) fn ekran_akisi_olayi(acik: bool) -> LiveEvent {
    LiveEvent::Tool {
        ad: EKRAN_AKISI_DURUMU.into(),
        durum: if acik {
            EKRAN_AKISI_ACIK
        } else {
            EKRAN_AKISI_KAPALI
        },
        sebep: Some(serde_json::json!({ "akis_acik": acik }).to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn net_kare_yaniti_kareyi_bekletmez_ve_monitor_sirasini_korur() {
        for etiketler in [
            vec!["Odak".to_string()],
            vec!["Sol".to_string(), "Sag".to_string()],
        ] {
            let v = net_kare_yaniti(etiketler.clone());
            assert_eq!(v["ekranlar"], serde_json::json!(etiketler));
            let y = v["yonlendirme"].as_str().unwrap();
            assert!(y.is_ascii());
            assert_eq!(y, "Bu yanittaki karelere bak (sirayla her ekran bir kare) ve simdi cevap ver; araci TEKRAR CAGIRMA.");
        }
    }

    #[test]
    fn net_kare_cercevesi_jpeg_parcalarini_ekran_sirasiyla_tasir() {
        use crate::audio::screen::ScreenFrame;
        for adet in [1, 2, 3] {
            let kareler = (0..adet)
                .map(|i| ScreenFrame {
                    label: format!("Ekran {i}"),
                    jpeg: vec![0xff, 0xd8, i, 0xff, 0xd9],
                })
                .collect();
            let v: serde_json::Value =
                serde_json::from_str(&net_kare_cercevesi("cagri-1", Ok(kareler))).unwrap();
            assert_eq!(v.as_object().unwrap().len(), 1);
            assert!(v.get("realtimeInput").is_none());
            let yanitlar = v["toolResponse"]["functionResponses"].as_array().unwrap();
            assert_eq!(yanitlar.len(), 1);
            let yanit = &yanitlar[0];
            assert_eq!(yanit["id"], "cagri-1");
            assert_eq!(yanit["name"], "ekrani_net_gor");
            assert!(yanit["response"].is_object());
            assert_eq!(yanit["response"]["durum"], "net kare gonderildi");
            assert_eq!(yanit["parts"].as_array().unwrap().len(), adet as usize);
            assert_eq!(
                yanit["response"]["ekranlar"].as_array().unwrap().len(),
                adet as usize
            );
            for i in 0..adet {
                assert_eq!(
                    yanit["response"]["ekranlar"][i as usize],
                    format!("Ekran {i}")
                );
                let veri = &yanit["parts"][i as usize]["inlineData"];
                assert_eq!(veri["mimeType"], "image/jpeg");
                assert_eq!(
                    base64::engine::general_purpose::STANDARD
                        .decode(veri["data"].as_str().unwrap())
                        .unwrap(),
                    vec![0xff, 0xd8, i, 0xff, 0xd9]
                );
            }
        }
    }

    #[test]
    fn net_kare_cercevesi_hatada_parts_tasimaz() {
        let v: serde_json::Value =
            serde_json::from_str(&net_kare_cercevesi("hata-1", Err("yakalama hatasi".into())))
                .unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "toolResponse": { "functionResponses": [{
            "id": "hata-1", "name": "ekrani_net_gor", "response": { "hata": "yakalama hatasi" }
        }] }})
        );
    }

    #[tokio::test]
    async fn audit_6_capture_sirasinda_kapanan_akis_kareyi_atar() {
        let acik = Arc::new(AtomicBool::new(true));
        let capture_acik = acik.clone();
        let kareler = ekran_yakala(
            move || {
                capture_acik.store(false, Ordering::SeqCst);
                Ok(vec![1, 2])
            },
            || acik.load(Ordering::SeqCst),
        )
        .await
        .unwrap();
        assert!(
            kareler.is_empty(),
            "kapatma tamamlandiktan sonra capture sonucu gonderildi"
        );
    }

    #[test]
    fn audit_6_kuyruktaki_kare_kapatmada_ve_yeniden_acmada_atilir() {
        let kare = || GidenCerceve::Ekran {
            metin: "video".into(),
            surum: 1,
        };
        assert_eq!(kare().metin(1).as_deref(), Some("video"));
        assert!(kare().metin(2).is_none(), "kuyruk beklerken kapandi");
        assert!(
            kare().metin(5).is_none(),
            "yeniden acilma eski kareyi canlandiramaz"
        );
        assert_eq!(
            GidenCerceve::Kontrol("tek seferlik ekran".into())
                .metin(2)
                .as_deref(),
            Some("tek seferlik ekran")
        );
    }

    #[tokio::test]
    async fn audit_6_kapali_akis_capture_cagirmaz() {
        let kareler: Vec<u8> = ekran_yakala(|| panic!("kapaliyken capture"), || false)
            .await
            .unwrap();
        assert!(kareler.is_empty());
    }
}
