//! Soylenmis proaktif konular; yeniden baglanma ve surec restart'ini asar.
//! Ham asistan metni diske yazilmaz: yalniz bilinen konu ve sabit ozet.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const WINDOW: u64 = 12 * 3600;
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
struct Kayit {
    son_soylenme: String,
    ozet: String,
}
type Bellek = BTreeMap<String, Kayit>;

fn konular(text: &str) -> Vec<&'static str> {
    let text = text
        .replace('İ', "i")
        .to_lowercase()
        .replace('ı', "i")
        .replace('ş', "s")
        .replace('ğ', "g")
        .replace('ü', "u")
        .replace('ö', "o")
        .replace('ç', "c");
    let has = |words: &[&str]| words.iter().any(|w| text.contains(w));
    let mut topics = Vec::new();
    if has(&["disk", "surucu", "depolama"])
        && has(&["dolu", "doluluk", "alan az", "yer az", "yer kalmadi"])
    {
        topics.push("disk doluluk");
    }
    if has(&["yedek", "backup"])
        && has(&[
            "eski",
            "gun",
            "saat",
            "alinamadi",
            "basarisiz",
            "hata",
            "yas",
        ])
    {
        topics.push("yedek yasi/basarisizligi");
    }
    if has(&["kota", "baglanti", "internet", "ag baglantisi"])
        && has(&[
            "asildi",
            "doldu",
            "tuken",
            "hata",
            "koptu",
            "kesil",
            "yok",
            "basarisiz",
            "sinir",
        ])
    {
        topics.push("kota/baglanti hatasi");
    }
    if has(&["guncelleme", "yeni surum", "update"])
        && has(&[
            "var",
            "hazir",
            "bekliyor",
            "mevcut",
            "basarisiz",
            "kurul",
            "yukle",
        ])
    {
        topics.push("guncelleme");
    }
    topics
}

fn yol() -> Option<PathBuf> {
    crate::paths::data_path("proaktif-bellek.json")
}

fn oku(path: &Path) -> Bellek {
    match oku_sonuc(path) {
        Ok(memory) => memory,
        Err(e) => {
            eprintln!("[proaktif] bellek okunamadi: {e}");
            Bellek::new()
        }
    }
}

fn oku_sonuc(path: &Path) -> std::io::Result<Bellek> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Bellek::new()),
        Err(e) => return Err(e),
    };
    match serde_json::from_slice(&bytes) {
        Ok(memory) => Ok(memory),
        Err(_) => {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let file = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("proaktif-bellek.json");
            let quarantine = path.with_file_name(format!("{file}.bozuk-{stamp}"));
            std::fs::rename(path, &quarantine)?;
            eprintln!(
                "[proaktif] bozuk JSON kenara alindi: {}",
                quarantine.display()
            );
            Ok(Bellek::new())
        }
    }
}

fn birlestir_en_yeni(hedef: &mut Bellek, disk: Bellek) {
    for (topic, record) in disk {
        let disk_yeni = hedef
            .get(&topic)
            .is_none_or(|current| record.son_soylenme > current.son_soylenme);
        if disk_yeni {
            hedef.insert(topic, record);
        }
    }
}

/// Live kancasi tam asistan ifadesi bittiginde cagirir. Yazma hatasi donmez,
/// yalniz loglanir; sesli oturumu dusurmez. Zaman testte enjekte edilebilir.
pub fn isle(asistan_metni: &str, simdi: SystemTime) {
    let Some(path) = yol() else { return };
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if isle_dosyada(&path, asistan_metni, simdi).is_err() {
        eprintln!("[proaktif] bellek yazilamadi; oturum devam ediyor");
    }
}

fn isle_dosyada(path: &Path, text: &str, now: SystemTime) -> std::io::Result<()> {
    isle_dosyada_yazma_oncesi(path, text, now, || {})
}

fn isle_dosyada_yazma_oncesi(
    path: &Path,
    text: &str,
    now: SystemTime,
    before_write: impl FnOnce(),
) -> std::io::Result<()> {
    let topics = konular(text);
    if topics.is_empty() {
        return Ok(());
    }
    let mut memory = oku_sonuc(path)?;
    for topic in topics {
        memory.insert(
            topic.into(),
            Kayit {
                son_soylenme: utc_iso(now),
                ozet: topic.into(),
            },
        );
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    before_write();
    // SMITH_ALLOW_MULTI icin iyimser birlestirme: baska surecin ilk okumadan
    // sonra yazdiklarini son anda tekrar aliriz. Bu tam bir surecler-arasi kilit
    // degildir; yeniden okuma ile rename arasindaki dar yaris bilincli kalir.
    birlestir_en_yeni(&mut memory, oku_sonuc(path)?);
    let bytes = serde_json::to_vec_pretty(&memory)?;
    // Tek surec kilidi + ayni diskte rename: yarim JSON'u okuyucuya gosterme.
    let pending = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&pending, bytes)?;
    let result = std::fs::rename(&pending, path);
    if result.is_err() {
        let _ = std::fs::remove_file(&pending);
    }
    result
}

/// Son 12 saatte zaten soylenmis konularin kisa, ASCII yonerge blogu.
pub fn yonerge_eki(simdi: SystemTime) -> String {
    let Some(path) = yol() else {
        return String::new();
    };
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    render(&oku(&path), simdi)
}

fn render(memory: &Bellek, now: SystemTime) -> String {
    let end = utc_iso(now);
    let start = utc_iso(
        now.checked_sub(Duration::from_secs(WINDOW))
            .unwrap_or(UNIX_EPOCH),
    );
    let mut topics = Vec::new();
    // Diskteki serbest metin yonergeye tasinmaz, sadece bilinen konular.
    for topic in [
        "disk doluluk",
        "yedek yasi/basarisizligi",
        "kota/baglanti hatasi",
        "guncelleme",
    ] {
        let Some(record) = memory.get(topic) else {
            continue;
        };
        let stamp = &record.son_soylenme;
        if stamp.len() != 20 || stamp <= &start || stamp > &end {
            continue;
        }
        // En fazla 12 saatlik pencere; ISO UTC siralamasi zaman siralamasidir.
        let hours = (1..=12)
            .find(|h| {
                now.checked_sub(Duration::from_secs(h * 3600))
                    .is_some_and(|t| stamp > &utc_iso(t))
            })
            .unwrap_or(12)
            - 1;
        topics.push(format!("{topic} ({hours} sa once)"));
    }
    if topics.is_empty() {
        String::new()
    } else {
        format!(
            "Bunlari zaten soyledin, kullanici sormadikca TEKRARLAMA: {}.\n",
            topics.join(", ")
        )
    }
}

// Cagiranin SystemTime degerini ortak UTC bicimine ceviren ince sarmalayici.
fn utc_iso(time: SystemTime) -> String {
    crate::time_util::utc_iso(crate::time_util::unix_seconds(time))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn konu_tanima() {
        for (text, topic) in [
            ("C diskiniz %98 dolu", "disk doluluk"),
            (
                "Yedeğiniz 3 gün eski, yedek başarısız",
                "yedek yasi/basarisizligi",
            ),
            ("Kota aşıldı, bağlantı hatası", "kota/baglanti hatasi"),
            ("Güncelleme mevcut", "guncelleme"),
        ] {
            assert_eq!(konular(text), vec![topic]);
        }
        assert!(konular("Disk dosyasını açtım. Merhaba efendim.").is_empty());
    }

    #[test]
    fn buyuk_turkce_i_konuyu_kacirmaz() {
        assert_eq!(konular("DİSKİNİZ %98 DOLU"), vec!["disk doluluk"]);
    }
    #[test]
    fn pencere_ve_utc() {
        let now = UNIX_EPOCH + Duration::from_secs(1_709_164_800);
        assert_eq!(utc_iso(now), "2024-02-29T00:00:00Z");
        for (age, visible) in [
            (0, true),
            (7200, true),
            (43199, true),
            (43200, false),
            (50000, false),
        ] {
            let mut m = Bellek::new();
            m.insert(
                "disk doluluk".into(),
                Kayit {
                    son_soylenme: utc_iso(now - Duration::from_secs(age)),
                    ozet: "untrusted".into(),
                },
            );
            let text = render(&m, now);
            assert_eq!(!text.is_empty(), visible);
            assert!(!text.contains("untrusted"));
            if age == 7200 {
                assert!(text.contains("(2 sa once)"));
            }
        }
    }
    #[test]
    fn bozuk_json_kenara_alinir_ve_yeni_bellek_yazilir() {
        let dir = std::env::temp_dir().join(format!(
            "smith-proaktif-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("proaktif-bellek.json");
        std::fs::write(&path, "{broken").unwrap();
        assert!(oku(&path).is_empty());
        isle_dosyada(&path, "Disk dolu", UNIX_EPOCH).unwrap();
        assert_eq!(oku(&path).len(), 1);
        let bozuk = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("proaktif-bellek.json.bozuk-")
            })
            .count();
        assert_eq!(bozuk, 1, "bozuk JSON tek kopya olarak kenara alinmali");
        isle_dosyada(&path, "Guncelleme mevcut", UNIX_EPOCH).unwrap();
        assert_eq!(oku(&path).len(), 2);
        assert!(isle_dosyada(&path.join("child.json"), "Disk dolu", UNIX_EPOCH).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn yazmadan_once_diski_yeniden_okur_ve_en_yeni_konuyu_korur() {
        let dir = std::env::temp_dir().join(format!(
            "smith-proaktif-merge-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("proaktif-bellek.json");
        let now = UNIX_EPOCH + Duration::from_secs(100);

        isle_dosyada_yazma_oncesi(&path, "Disk dolu", now, || {
            let mut other = Bellek::new();
            other.insert(
                "disk doluluk".into(),
                Kayit {
                    son_soylenme: utc_iso(UNIX_EPOCH + Duration::from_secs(200)),
                    ozet: "disk doluluk".into(),
                },
            );
            other.insert(
                "guncelleme".into(),
                Kayit {
                    son_soylenme: utc_iso(UNIX_EPOCH + Duration::from_secs(150)),
                    ozet: "guncelleme".into(),
                },
            );
            std::fs::write(&path, serde_json::to_vec_pretty(&other).unwrap()).unwrap();
        })
        .unwrap();

        let merged = oku(&path);
        assert_eq!(merged.len(), 2, "diger surecin konusu kaybolmamali");
        assert_eq!(
            merged["disk doluluk"].son_soylenme,
            utc_iso(UNIX_EPOCH + Duration::from_secs(200)),
            "ayni konuda en yeni son_soylenme kazanmali"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
