//! Gateway'deki hafiza bosluklarindan Live acilisina tek soru secimi.

use serde_json::Value;
use std::time::{Duration, SystemTime};

use super::conversation::tek_satir;

const TEKRAR_SORMA_SURESI: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Aday {
    pub(super) id: String,
    pub(super) satir: String,
}

pub(super) fn id_gecerli(id: &str) -> bool {
    let Some(govde) = id.strip_prefix("gap_") else {
        return false;
    };
    (20..=32).contains(&govde.len())
        && govde
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

fn zaman_anahtari<'a>(deger: &'a Value, alan: &str) -> Option<&'a str> {
    let zaman = deger[alan].as_str()?;
    let onek = zaman.get(..19)?;
    (onek.as_bytes().get(4) == Some(&b'-')
        && onek.as_bytes().get(7) == Some(&b'-')
        && onek.as_bytes().get(10) == Some(&b'T'))
    .then_some(onek)
}

fn aday(gap: &Value) -> Option<Aday> {
    let id = gap["id"].as_str().filter(|id| id_gecerli(id))?;
    let soru = tek_satir(gap["question"].as_str()?);
    (!soru.is_empty()).then(|| Aday {
        id: id.to_string(),
        satir: format!("Acik hafiza sorusu (id={id}): {soru}"),
    })
}

fn gaps(yanit: &Value) -> impl Iterator<Item = &Value> {
    yanit["gaps"].as_array().into_iter().flatten()
}

/// Once en eski `open`, o yoksa en az 24 saat once sorulmus en eski `asked`.
/// Donus tek satirdir; bos/gecersiz listede `None`.
pub(super) fn sec(
    open_yanit: &Value,
    asked_yanit: Option<&Value>,
    simdi: SystemTime,
) -> Option<Aday> {
    if let Some(gap) = gaps(open_yanit).find(|gap| aday(gap).is_some()) {
        return aday(gap);
    }
    let kesim = crate::time_util::utc_iso(crate::time_util::unix_seconds(
        simdi.checked_sub(TEKRAR_SORMA_SURESI)?,
    ));
    let kesim = kesim.get(..19)?;
    let gap = gaps(asked_yanit?).find(|gap| {
        aday(gap).is_some() && zaman_anahtari(gap, "askedAt").is_some_and(|asked| asked <= kesim)
    })?;
    aday(gap)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ESKI: SystemTime = SystemTime::UNIX_EPOCH;

    fn gap(id: &str, soru: &str, created: &str, asked: Option<&str>) -> Value {
        json!({
            "id": id,
            "question": soru,
            "createdAt": created,
            "askedAt": asked,
        })
    }

    #[test]
    fn acilis_satiri_en_fazla_bir_en_eski_open_soru() {
        let eski = gap(
            "gap_00000000000000000000",
            "En eski\nsoru?",
            "2026-10-01T08:00:00.000Z",
            None,
        );
        let yeni = gap(
            "gap_11111111111111111111",
            "Yeni soru?",
            "2026-10-02T08:00:00.000Z",
            None,
        );
        let secilen = sec(&json!({ "gaps": [eski, yeni] }), None, ESKI).unwrap();
        assert_eq!(secilen.id, "gap_00000000000000000000");
        assert_eq!(
            secilen.satir,
            "Acik hafiza sorusu (id=gap_00000000000000000000): En eski soru?"
        );
        assert_eq!(secilen.satir.lines().count(), 1);
    }

    #[test]
    fn bos_ve_gecersiz_listede_satir_yok() {
        for yanit in [json!({}), json!({ "gaps": [] }), json!({ "gaps": "x" })] {
            assert_eq!(sec(&yanit, None, ESKI), None);
        }
        let gecersiz = json!({ "gaps": [{ "id": "../health", "question": "Soru?" }] });
        assert_eq!(sec(&gecersiz, None, ESKI), None);
    }

    #[test]
    fn open_yokken_yirmi_dort_saati_gecmis_asked_tekrar_adaydir() {
        let simdi = SystemTime::UNIX_EPOCH + Duration::from_secs(48 * 60 * 60);
        let eski = gap(
            "gap_00000000000000000000",
            "Eski soru?",
            "1970-01-01T00:00:00.000Z",
            Some("1970-01-01T12:00:00.000Z"),
        );
        let yeni = gap(
            "gap_11111111111111111111",
            "Yeni soru?",
            "1970-01-01T01:00:00.000Z",
            Some("1970-01-02T12:00:01.000Z"),
        );
        let secilen = sec(
            &json!({ "gaps": [] }),
            Some(&json!({ "gaps": [eski, yeni] })),
            simdi,
        )
        .unwrap();
        assert_eq!(secilen.id, "gap_00000000000000000000");
    }
}
