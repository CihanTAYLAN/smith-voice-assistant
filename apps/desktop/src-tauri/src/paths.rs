//! Smith durum dosyalarinin TEK veri koku.
//!
//! TEK KURAL (her calisma ortaminda ayni: `scripts/smith-common.ps1`
//! `Resolve-SmithDataDir`, `sidecar/smith_paths.py`, `apps/worker/src/engines/
//! run-dir.ts`):
//!   1. `SMITH_DATA_DIR` tanimli ve bos degilse o,
//!   2. degilse Windows'ta `%USERPROFILE%\.smith`, diger sistemlerde `~/.smith`.
//!
//! ASLA `%LOCALAPPDATA%` / `%APPDATA%` tabanli DEGIL. NEDEN: Claude masaustu
//! uygulamasi MSIX paketidir; ondan baslatilan surecler AppData yazilarini gizli
//! paket klasorune yonlendirir (`AppData\Local\Packages\<aile>\LocalCache\...`),
//! zamanlanmis gorevler ve kullanicinin terminali ise GERCEK AppData'yi gorur.
//! Sonuc iki ayri "gercek" (2026-10-03: ses izi kaydi, yedek aynasi ayari,
//! gunlukler, oturum sirri ve kilitler ikiye bolundu). Profil koku yonlendirilmez.
//! Kapi: `scripts/check-data-root.mjs` (repo genelinde AppData tabanli yolu yakalar).
//!
//! `smith.env` ozel durumu: dosya veri kokunde durur ve OKUNMADAN ONCE aranir.
//! `SMITH_DATA_DIR` yalniz `smith.env` icinde tanimliysa dosya varsayilan kokte
//! aranir; ozel kok kullanan makinede degisken isletim sistemi env'inde olmali
//! (`scripts/smith-env-export.ps1` dosyayi cozulmus kokune yazar, tutarli kalir).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Veri kokunu degistiren ortam degiskeni.
pub const DATA_DIR_ENV: &str = "SMITH_DATA_DIR";

const DEFAULT_DIR_NAME: &str = ".smith";

/// Tasima isaretinin dosya adi (veri kokunde). `scripts/smith-migrate-data.ps1
/// -Apply` yazar; varligi "eski konumdaki veri icin karar verildi" demektir ve
/// acilis uyarisini susturur.
pub const MIGRATION_MARKER: &str = ".veri-koku-tasindi";

/// Tasima betigi bu adlari kopyalamaz; uyari da saymaz (kilit/gecici dosya veri degildir).
const IGNORED_SUFFIXES: &[&str] = &[".lock", ".tmp", ".migrate-part"];

/// Bos veya yalniz bosluktan olusan degeri "tanimsiz" sayar; dolu degeri kirpar.
fn non_empty(v: OsString) -> Option<PathBuf> {
    match v.to_str() {
        Some(s) if s.trim().is_empty() => None,
        Some(s) => Some(PathBuf::from(s.trim())),
        None => Some(PathBuf::from(v)),
    }
}

/// Saf cozumleme: ortam disaridan gelir (testte process env'ine dokunulmaz).
fn resolve(env: &dyn Fn(&str) -> Option<OsString>, windows: bool) -> Option<PathBuf> {
    if let Some(dir) = env(DATA_DIR_ENV).and_then(non_empty) {
        return Some(dir);
    }
    // Birincil degisken platforma gore; digeri WSL/CI gibi karma ortamlar icin yedek.
    let (first, second) = if windows {
        ("USERPROFILE", "HOME")
    } else {
        ("HOME", "USERPROFILE")
    };
    let home = env(first)
        .and_then(non_empty)
        .or_else(|| env(second).and_then(non_empty))?;
    Some(home.join(DEFAULT_DIR_NAME))
}

/// Smith veri koku. `None`: ne `SMITH_DATA_DIR` ne ev dizini bulunabildi.
/// Dizin olusturmaz; yazan kod `create_dir_all` kendisi yapar.
pub fn data_dir() -> Option<PathBuf> {
    resolve(&|k| std::env::var_os(k), cfg!(windows))
}

/// `<veri koku>/<goreli yol>`.
pub fn data_path(rel: impl AsRef<Path>) -> Option<PathBuf> {
    data_dir().map(|d| d.join(rel))
}

// ---------------------------------------------------------------------------
// Geri uyum: eski (AppData tabanli) konumdaki veri icin acik uyari
// ---------------------------------------------------------------------------

fn ignored_name(name: &std::ffi::OsStr) -> bool {
    let n = name.to_string_lossy().to_ascii_lowercase();
    IGNORED_SUFFIXES.iter().any(|s| n.ends_with(s))
}

/// `dir` altinda (sembolik baglanti izlenmez, en cok `budget` girdi) veri sayilan
/// ilk dosyayi arar.
fn dir_has_data(dir: &Path, budget: &mut usize) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            return false;
        }
        *budget -= 1;
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            if dir_has_data(&entry.path(), budget) {
                return true;
            }
        } else if kind.is_file() && !ignored_name(&entry.file_name()) {
            return true;
        }
    }
    false
}

/// Eski konumlar (YALNIZ Windows): gercek `%LOCALAPPDATA%\smith` ve MSIX paketlerinin
/// sanal deposu `Packages\<aile>\LocalCache\Local\smith`. Hicbir bilesen artik
/// buralara yazmaz; liste yalniz acilis uyarisi icindir. Siralama deterministiktir.
fn legacy_roots(env: &dyn Fn(&str) -> Option<OsString>, windows: bool) -> Vec<PathBuf> {
    if !windows {
        return Vec::new();
    }
    let Some(local) = env("LOCALAPPDATA").and_then(non_empty) else {
        return Vec::new();
    };
    let mut roots = vec![local.join("smith")];
    if let Ok(packages) = std::fs::read_dir(local.join("Packages")) {
        let mut found: Vec<PathBuf> = packages
            .flatten()
            .map(|p| p.path().join("LocalCache").join("Local").join("smith"))
            .filter(|p| p.is_dir())
            .collect();
        found.sort();
        roots.extend(found);
    }
    roots
}

/// Veri kokunde tasima isareti yoksa ve eski konumlarda veri varsa uyari metni.
/// Isaret varsa (tasima yapildi ya da bilincli atlandi) ya da eski konumda veri
/// yoksa `None`.
fn legacy_notice(root: &Path, legacy: &[PathBuf]) -> Option<String> {
    if root.join(MIGRATION_MARKER).exists() {
        return None;
    }
    let with_data: Vec<String> = legacy
        .iter()
        .filter(|dir| dir_has_data(dir, &mut 5_000))
        .map(|dir| dir.display().to_string())
        .collect();
    if with_data.is_empty() {
        return None;
    }
    Some(format!(
        "[veri] UYARI: veri koku bos veya tasinmamis ({}); eski konumda veri var ({}). \
         Eski konuma YAZILMAZ, yeni kokle devam ediliyor. Veri koku bos, tasima betigini \
         calistir: pwsh scripts\\smith-migrate-data.ps1 (once -DryRun, sonra -Apply)",
        root.display(),
        with_data.join("; ")
    ))
}

/// Acilista bir kez cagrilir: eski konumda tasinmamis veri varsa acik log uyarisi.
pub fn warn_if_legacy_data() {
    let Some(root) = data_dir() else {
        return;
    };
    let legacy = legacy_roots(&|k| std::env::var_os(k), cfg!(windows));
    if let Some(message) = legacy_notice(&root, &legacy) {
        eprintln!("{message}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sahte ortam: `(ad, deger)` ciftleri; process env'ine dokunmaz.
    fn fake<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<OsString> + 'a {
        move |k: &str| {
            pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| OsString::from(*v))
        }
    }

    fn scratch(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("smith-paths-test-{}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn env_varsa_varsayilani_ezer() {
        let env = fake(&[
            ("SMITH_DATA_DIR", "D:\\veri"),
            ("USERPROFILE", "C:\\Users\\x"),
            ("HOME", "/home/x"),
        ]);
        assert_eq!(resolve(&env, true), Some(PathBuf::from("D:\\veri")));
        assert_eq!(resolve(&env, false), Some(PathBuf::from("D:\\veri")));
    }

    #[test]
    fn bos_veya_bosluk_env_tanimsiz_sayilir() {
        for bos in ["", "   ", "\t"] {
            let pairs = [("SMITH_DATA_DIR", bos), ("USERPROFILE", "C:\\Users\\x")];
            let env = fake(&pairs);
            assert_eq!(
                resolve(&env, true),
                Some(PathBuf::from("C:\\Users\\x").join(".smith")),
                "{bos:?} varsayilana dusmeli"
            );
        }
        // Dolu deger kirpilir.
        let env = fake(&[("SMITH_DATA_DIR", "  D:\\veri  ")]);
        assert_eq!(resolve(&env, true), Some(PathBuf::from("D:\\veri")));
    }

    #[test]
    fn windows_varsayilani_userprofile_altinda_dot_smith() {
        let env = fake(&[
            ("USERPROFILE", "C:\\Users\\x"),
            ("HOME", "/yanlis"),
            ("LOCALAPPDATA", "C:\\Users\\x\\AppData\\Local"),
            ("APPDATA", "C:\\Users\\x\\AppData\\Roaming"),
        ]);
        let got = resolve(&env, true).unwrap();
        assert_eq!(got, PathBuf::from("C:\\Users\\x").join(".smith"));
    }

    #[test]
    fn diger_sistemlerde_home_altinda_dot_smith() {
        let env = fake(&[
            ("HOME", "/home/x"),
            ("XDG_DATA_HOME", "/home/x/.local/share"),
            ("XDG_CONFIG_HOME", "/home/x/.config"),
        ]);
        assert_eq!(
            resolve(&env, false),
            Some(PathBuf::from("/home/x").join(".smith"))
        );
    }

    #[test]
    fn birincil_yoksa_diger_ev_degiskenine_duser() {
        let win = fake(&[("HOME", "/c/Users/x")]);
        assert_eq!(
            resolve(&win, true),
            Some(PathBuf::from("/c/Users/x").join(".smith"))
        );
        let unix = fake(&[("USERPROFILE", "C:\\Users\\x")]);
        assert_eq!(
            resolve(&unix, false),
            Some(PathBuf::from("C:\\Users\\x").join(".smith"))
        );
    }

    /// Kok cozumleme AppData'ya ASLA dusmez: ev dizini yoksa `None`, `%LOCALAPPDATA%`
    /// yedek DEGILDIR (eski davranis tam olarak buydu ve iki gercege bolunmeye yol acti).
    #[test]
    fn localappdata_ve_appdata_asla_kullanilmaz() {
        let env = fake(&[
            ("LOCALAPPDATA", "C:\\Users\\x\\AppData\\Local"),
            ("APPDATA", "C:\\Users\\x\\AppData\\Roaming"),
        ]);
        assert_eq!(resolve(&env, true), None);
        assert_eq!(resolve(&env, false), None);
    }

    #[test]
    fn data_path_koke_ekler() {
        // process env'ine bagli degil: kok ne olursa olsun son parca beklenen ad.
        if let Some(p) = data_path("window.json") {
            assert_eq!(p.file_name().unwrap(), "window.json");
            assert_eq!(p.parent(), data_dir().as_deref());
        }
    }

    #[test]
    fn eski_konumlar_yalniz_windowsta_ve_paketler_dahil() {
        let local = scratch("legacy-roots");
        let gercek = local.join("smith");
        let paket = local
            .join("Packages")
            .join("Uygulama_abc123")
            .join("LocalCache")
            .join("Local")
            .join("smith");
        let paketsiz = local.join("Packages").join("Baska_xyz");
        for d in [&gercek, &paket, &paketsiz] {
            std::fs::create_dir_all(d).unwrap();
        }
        let pairs = [("LOCALAPPDATA", local.to_str().unwrap())];
        let env = fake(&pairs);
        assert_eq!(legacy_roots(&env, true), vec![gercek, paket]);
        assert!(
            legacy_roots(&env, false).is_empty(),
            "Windows disinda eski konum yok"
        );
        assert!(legacy_roots(&fake(&[]), true).is_empty());
        std::fs::remove_dir_all(&local).unwrap();
    }

    #[test]
    fn uyari_isaret_yokken_ve_eski_konumda_veri_varken_verilir() {
        let tmp = scratch("notice");
        let root = tmp.join("kok");
        let legacy = tmp.join("eski");
        std::fs::create_dir_all(legacy.join("speaker")).unwrap();
        std::fs::write(legacy.join("speaker").join("owner.npy"), b"x").unwrap();

        // Kok HIC yok: tam senaryo ("veri koku bos").
        let msg = legacy_notice(&root, &[legacy.clone()]).expect("uyari beklenir");
        assert!(msg.contains("veri koku bos"), "{msg}");
        assert!(msg.contains("smith-migrate-data.ps1"), "{msg}");
        assert!(msg.contains(&legacy.display().to_string()), "{msg}");

        // Kok dolu ama isaret yok: yine uyari (kismi/yarim tasima).
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("window.json"), b"{}").unwrap();
        assert!(legacy_notice(&root, &[legacy.clone()]).is_some());

        // Isaret varsa susar (tasima yapildi ya da bilincli atlandi).
        std::fs::write(root.join(MIGRATION_MARKER), b"{}").unwrap();
        assert!(legacy_notice(&root, &[legacy]).is_none());
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[test]
    fn eski_konum_bossa_ya_da_yalniz_kilitse_uyari_yok() {
        let tmp = scratch("notice-bos");
        let root = tmp.join("kok");
        let legacy = tmp.join("eski");
        std::fs::create_dir_all(&legacy).unwrap();
        assert!(
            legacy_notice(&root, &[legacy.clone()]).is_none(),
            "bos dizin"
        );
        std::fs::write(legacy.join("smith-up.lock"), b"").unwrap();
        std::fs::write(legacy.join("x.tmp"), b"1").unwrap();
        std::fs::write(legacy.join("y.migrate-part"), b"1").unwrap();
        assert!(
            legacy_notice(&root, &[legacy.clone()]).is_none(),
            "kilit/gecici veri degil"
        );
        assert!(
            legacy_notice(&root, &[tmp.join("yok")]).is_none(),
            "olmayan dizin"
        );
        std::fs::write(legacy.join("health.json"), b"{}").unwrap();
        assert!(legacy_notice(&root, &[legacy]).is_some());
        std::fs::remove_dir_all(tmp).unwrap();
    }
}
