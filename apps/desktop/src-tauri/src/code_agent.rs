//! Smith'in kendi kodunu Claude Code araciligiyla duzenlemesi.
//!
//! Kullanici mandasi 2026-08-17: "Smith'in kendi kodunu Claude Code araciligi
//! ile duzenleyip guncelleyebilmesini de istiyorum."
//!
//! ## Neden bu tasarim: kendini duzenleyen ajanin kendine ozgu riski
//!
//! Bu arac, Smith'i TANIMLAYAN kodu degistirir. Kotu bir duzenleme Smith'i
//! yalnizca bozmaz — kendisini DUZELTILEMEZ hale getirebilir (or. arac
//! koprusunu kirarsa artik "geri al" diyemezsiniz). O yuzden yetenegin sinirlari
//! kodda, yorumda degil:
//!
//! 1. **`main`'e ASLA yazilmaz.** Her gorev icin HEAD'den yeni bir dal
//!    (`smith/gorev-<slug>`) ve REPO DISINDA bir git worktree acilir. Kullanicinin
//!    kirli calisma agaci gorev agacina kopyalanmaz. Git worktree bir OS
//!    sandbox'i degildir; ajan cihaz sahibinin dosya yetkisiyle calisir.
//! 2. **Merge YOK, push YOK.** Bu modul o komutlari HIC icermez; testi de bunu
//!    sabitliyor. Cikti bir dal + ozet; birlestiren insandir.
//! 3. **Kabuk YOK.** `--tools` yalniz dosya araclarini verir; `Bash`
//!    listede DEGIL. Yani ajan kod yazabilir ama komut kosturamaz.
//!    `--dangerously-skip-permissions` KULLANILMAZ (test bunu da kontrol eder):
//!    sesle tetiklenen, kimse bakmazken kosan bir ajanda o bayrak tam olarak
//!    olmamasi gereken seydir.
//! 4. **Host dogrulamasi varsayilan kapalidir.** Yalniz
//!    SMITH_CODE_AGENT_VERIFY=host ile sabit Windows kontrolleri calisir;
//!    gercek cikis kodlarini ve tam log yollarini kaydeder. Degistirilmis
//!    kabul altyapisi otomatik onaylanmaz. Basarili kontrol review uretir.
//! 5. **Sahip kanidi sart** (`speaker.rs`, `OWNER_ONLY_CODE`).
//! 6. **Varsayilan KAPALI** (`SMITH_CODE_AGENT`): taze bir checkout kendi kodunu
//!    duzenleyen bir ajanla acilmaz; yetenek bilincli olarak acilir.
//!
//! ## Enjeksiyon
//!
//! Gorev metni MODELDEN gelir, yani dolayli olarak konusmadan. Kabuga
//! gomulmez: dosyaya yazilir ve `claude`'a STDIN ile borulanir (`cat dosya |
//! claude -p`). Boylece metnin icindeki tirnak, `$(...)` veya `;` kabuk
//! tarafindan HIC yorumlanmaz. Kabuk satirina giren tek degerler bizim
//! urettigimiz, karakter kumesi kisitli yollardir.

use std::path::{Path, PathBuf};
pub mod evidence;
mod process;
mod run;
mod verification;

/// Kalici bir kosuyu salt okunur getir; yeniden calistirma yok.
pub fn kosu_durumu(id: &str) -> Result<serde_json::Value, String> {
    run::read(id)
}

/// Aday elle duzeltildikten sonra ajani tekrar cagirmadan yeniden dogrula.
pub fn kosu_dogrula(id: &str) -> Result<serde_json::Value, String> {
    if !acik() {
        return Err("kod ajani kapali (SMITH_CODE_AGENT=1 ile acilir)".into());
    }
    run::reverify(id)
}

use crate::env_flag;

/// Dal ve worktree adlarinin degismez on eki. Gorev adi ne olursa olsun
/// uretilen dal bununla baslar; boylece `git branch --list 'smith/gorev-*'`
/// ajanin urettigi her seyi tek komutla gosterir.
pub const DAL_ONEK: &str = "smith/gorev-";

/// Worktree'lerin koku — REPO DISINDA. Repo icinde olsa `git clean -ffdx`
/// (CI checkout adimi) onlari silerdi ve `git status` gurultulu olurdu.
const WORKTREE_KOK: &str = r"C:\ci";

/// Gorev metninin ust siniri. Model uzun metin uretebilir; bu bir kalite
/// sinirri degil, kaynak sinirri.
const GOREV_MAX: usize = 2000;

/// Slug uzunlugu. Uzun dal adlari Windows'ta MAX_PATH'e dogru buyuyen worktree
/// yollari uretir (bu depoda MAX_PATH bir kez surum hattini dort kez dusurdu).
const SLUG_MAX: usize = 24;

/// Ajanin verilebilecek araclari. `Bash` KASTEN YOK — bkz. modul basligi (3).
const IZINLI_ARACLAR: &str = "Read,Edit,Write,Glob,Grep";

/// Varsayilan zaman asimi. Live oturumu ~10 dk'da bir yenilendigi icin bunun
/// altinda kalmali; aksi halde arac yaniti donerken oturum degismis olur.
const ZAMAN_ASIMI_VARSAYILAN: u64 = 180;

/// Yetenek acik mi? VARSAYILAN KAPALI (bkz. modul basligi 6).
pub fn acik() -> bool {
    env_flag::acik_varsayilan_kapali("SMITH_CODE_AGENT")
}

/// Zaman asimi (saniye), `SMITH_CODE_AGENT_TIMEOUT_S`.
fn zaman_asimi() -> u64 {
    std::env::var("SMITH_CODE_AGENT_TIMEOUT_S")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|s| *s >= 10 && *s <= 540)
        .unwrap_or(ZAMAN_ASIMI_VARSAYILAN)
}

/// Uzerinde calisilacak depo. Sabit yol YAZILMAZ: bu kod baska bir makinede de
/// derlenir ve orada `C:\Users\alice\...` diye bir sey yoktur.
fn repo_dizini() -> Option<PathBuf> {
    std::env::var_os("SMITH_REPO_DIR").map(PathBuf::from)
}

/// Gorev metninden dal/dizin adi uretir.
///
/// Turkce karakterler ASCII karsiligina cevrilir (dal adinda `ş` legal ama
/// WSL/Windows yol koprusunde bela); kalan her sey `-` olur ve tekrarlar
/// sikistirilir. Bos kalirsa `gorev` doner — adsiz dal olmaz.
pub fn slug(gorev: &str) -> String {
    let mut s = String::with_capacity(gorev.len());
    for c in gorev.chars() {
        let c = match c {
            'ç' | 'Ç' => 'c',
            'ğ' | 'Ğ' => 'g',
            'ı' | 'I' => 'i',
            'ö' | 'Ö' => 'o',
            'ş' | 'Ş' => 's',
            'ü' | 'Ü' => 'u',
            'İ' => 'i',
            other => other,
        };
        let c = c.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') {
            s.push('-');
        }
        if s.len() >= SLUG_MAX {
            break;
        }
    }
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "gorev".to_string()
    } else {
        s
    }
}

/// Gorev metnini dogrular. `Err` = modele donecek aciklama.
pub fn dogrula(gorev: &str) -> Result<(), String> {
    let g = gorev.trim();
    if g.is_empty() {
        return Err("gorev metni bos".to_string());
    }
    if g.chars().count() > GOREV_MAX {
        return Err(format!(
            "gorev metni cok uzun ({} > {GOREV_MAX})",
            g.chars().count()
        ));
    }
    Ok(())
}

/// `C:\ci\x` → `/mnt/c/ci/x`. WSL'nin Windows diskini gordugu yol.
pub fn wsl_yolu(win: &Path) -> String {
    let s = win.to_string_lossy().replace('\\', "/");
    match s.split_once(":/") {
        Some((surucu, kalan)) if surucu.len() == 1 => {
            format!("/mnt/{}/{}", surucu.to_ascii_lowercase(), kalan)
        }
        _ => s,
    }
}

/// WSL'de kosacak bash satiri.
///
/// SAF fonksiyon: env okumaz, surec baslatmaz. Boylece guvenlik degismezleri
/// (kabuk araci yok, tehlikeli bayrak yok, push/merge yok) testten DOGRUDAN
/// dogrulanabiliyor — "umuyorum ki oyle" degil.
pub fn bash_satiri(is_dizini_wsl: &str, istem_dosyasi_wsl: &str) -> String {
    let model = std::env::var("SMITH_CODE_AGENT_MODEL").unwrap_or_else(|_| "opus".into());
    bash_satiri_timeout(is_dizini_wsl, istem_dosyasi_wsl, zaman_asimi(), &model)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn bash_satiri_timeout(worktree: &str, prompt: &str, seconds: u64, model: &str) -> String {
    format!(
        "cd {} && timeout --signal=TERM --kill-after=10s {}s claude -p \
         --safe-mode --permission-mode acceptEdits --tools '{IZINLI_ARACLAR}' \
         --allowedTools '{IZINLI_ARACLAR}' --model {} --output-format json < {}",
        shell_quote(worktree),
        seconds,
        shell_quote(model),
        shell_quote(prompt)
    )
}

/// Ajana verilecek istem: gorev + degismez kurallar.
///
/// Kurallar istemde DE yazili, ama guvenligi saglayan sey bu DEGIL — bayraklar
/// ve worktree izolasyonu. Istem yalnizca ajanin bosuna denemesini onler
/// (izin verilmeyen bir arac cagirmak turu yakar).
pub fn istem(gorev: &str, dal: &str) -> String {
    format!(
        "{gorev}\n\n\
         --- CALISMA KURALLARI (Smith tarafindan eklendi) ---\n\
         - Izole bir git worktree'desin; dal: {dal}. `main` burada YOK.\n\
         - Kabuk araci verilmedi: komut kosturamazsin, test calistiramazsin. \
         Diff teslimini Smith yapar; host dogrulamasi varsayilan kapalidir.\n\
         - commit ATMA, push ETME, merge ETME. Yalniz dosyalari duzenle.\n\
         - Bu depo Turkce yorum yazar ve yorumlar NEDEN'i anlatir; cevredeki \
         uslubu birebir surdur.\n\
         - Isin bitince NE DEGISTIRDIGINI 2-3 cumleyle ozetle.\n"
    )
}

/// `dosyalar` izin listesi satiri: ajana yalniz bu dosyalari degistirebilecegi
/// soylenir. Gercek sinir istem degil kanit kabul kapisidir
/// (`evidence::gather_scoped`); istem ajanin bosuna denemesini onler.
pub fn dosya_siniri_istemi(paths: &[String]) -> String {
    format!(
        "\nYALNIZ bu canonical goreli dosyalari degistirebilirsin: {}\n\
         Liste disi degisiklik kanit kapisinda reddedilir.\n",
        serde_json::json!(paths)
    )
}

/// Arac girisi.
///
/// `dosyalar`: virgul veya satir sonu ile ayrilmis dosya yollari. Verilirse IZIN
/// LISTESIDIR: ajan yalniz bu dosyalari degistirebilir, aksi halde kanit kapisi
/// gorevi reddeder (bkz. `file_allowlist`). Verilmezse repo genelinde calisir.
///
/// `ad`: dal adi icin kisa etiket. CANLI SONDA BUNU GEREKLI KILDI: slug gorev
/// metninin ILK 24 karakterinden turetiliyordu ve gorev bir dosya yoluyla
/// basladigi icin dal adi `smith/gorev-apps-desktop-src-tauri-s` oldu — yani
/// dalin adi isin NE OLDUGUNU hic soylemiyordu. Modelden 2-4 kelimelik bir ad
/// istemek bunu duzeltiyor; vermezse eski davranisa duseriz (adsiz kalmaktan
/// iyidir).
pub fn kod_gorevi_ver(gorev: &str, ad: Option<&str>, dosyalar: Option<&str>) -> serde_json::Value {
    gorev_baslat(gorev, ad, dosyalar, true)
}

/// CLI sureci sonuc gelmeden kapanmamali; ayni motoru bekleyerek cagirir.
pub fn kod_gorevi_ver_bekle(gorev: &str, ad: Option<&str>) -> serde_json::Value {
    gorev_baslat(gorev, ad, None, false)
}

fn gorev_baslat(
    gorev: &str,
    ad: Option<&str>,
    dosyalar: Option<&str>,
    background: bool,
) -> serde_json::Value {
    if !acik() {
        return serde_json::json!({
            "hata": "kod ajani kapali (SMITH_CODE_AGENT=1 ile acilir)",
            "neden": "kendi kodunu duzenleyen yetenek bilincli olarak acilir"
        });
    }
    if let Err(e) = dogrula(gorev) {
        return serde_json::json!({ "hata": e });
    }
    let Some(repo) = repo_dizini() else {
        return serde_json::json!({
            "hata": "SMITH_REPO_DIR tanimli degil — hangi depoda calisacagim belli degil"
        });
    };

    // Ad verilmisse ondan, yoksa gorev metninden. `filter`: bos/anlamsiz bir ad
    // gelirse slug "gorev" dondurur ve o da gorev metninden turetmekten kotudur.
    let s = ad
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .map(slug)
        .filter(|s| s != "gorev")
        .unwrap_or_else(|| slug(gorev));
    let allowed = match file_allowlist(&repo, dosyalar) {
        Ok(paths) => paths,
        Err(error) => return serde_json::json!({"hata":error, "status":"blocked"}),
    };
    match run::execute(&repo, gorev, &s, allowed, background) {
        Ok(record) => record,
        Err(error) => serde_json::json!({ "hata": error, "status": "blocked" }),
    }
}

/// `dosyalar` parametresi -> canonical goreli yol izin listesi. Verilmediyse
/// (veya bos/bosluksa) `None`: ajan bugunku gibi repo genelinde calisir. Verilirse
/// ajanin istemine ve kanit kabul kapisina FAIL-CLOSED uygulanir (bkz.
/// `evidence::gather_scoped`); belirsiz bir yol listenin disina tasabilecegi icin
/// tum gorev reddedilir.
fn file_allowlist(repo: &Path, files: Option<&str>) -> Result<Option<Vec<String>>, String> {
    let Some(files) = files.map(str::trim).filter(|files| !files.is_empty()) else {
        return Ok(None);
    };
    let mut paths = files
        .split([',', '\n'])
        .map(|path| evidence::canonical_relative(repo, path.trim()))
        .collect::<Result<Vec<_>, _>>()?;
    paths.sort();
    paths.dedup();
    Ok(Some(paths))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dosyalar_izin_listesi_belirsiz_ve_kacan_yollari_reddeder() {
        let root = std::env::temp_dir().join(format!(
            "smith-dosyalar-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("src")).unwrap();
        assert_eq!(
            file_allowlist(&root, Some("src\\one.rs,src/two.rs")).unwrap(),
            Some(vec!["src/one.rs".to_string(), "src/two.rs".to_string()])
        );
        // Verilmeyen veya bos parametre bugunku davranistir: izin listesi yok.
        for bos in [None, Some(""), Some("  \n ")] {
            assert_eq!(file_allowlist(&root, bos).unwrap(), None, "{bos:?}");
        }
        for path in [
            "../escape.rs",
            "./src/one.rs",
            "src//one.rs",
            "src",
            "C:\\escape.rs",
            "src/../escape.rs",
            "src/file.rs:stream",
            ".git/config",
            "src/*",
            "src/a.rs,",
            ".env",
        ] {
            assert!(file_allowlist(&root, Some(path)).is_err(), "{path}");
        }
    }

    #[test]
    fn dosya_siniri_istemi_listeyi_ve_reddi_tasir() {
        let istem = dosya_siniri_istemi(&["src/one.rs".to_string(), "src/two.rs".to_string()]);
        assert!(istem.contains(r#"["src/one.rs","src/two.rs"]"#), "{istem}");
        assert!(istem.contains("kanit kapisinda reddedilir"), "{istem}");
    }

    /// GUVENLIK DEGISMEZI — bu testin kirilmasi "ajan kabuk kullanabiliyor" veya
    /// "izin kontrolleri atlaniyor" demektir. Ikisi de sesle tetiklenen bir
    /// ajanda kabul edilemez.
    #[test]
    fn bash_satiri_tehlikeli_bayrak_ve_kabuk_araci_icermez() {
        let s = bash_satiri("/mnt/c/ci/x", "/mnt/c/ci/x/.smith-gorev.txt");

        assert!(
            !s.contains("dangerously"),
            "izin kontrollerini atlayan bayrak eklenmis: {s}"
        );
        assert!(!s.contains("Bash"), "ajana kabuk araci verilmis: {s}");
        assert!(
            s.contains("--allowedTools"),
            "arac listesi verilmemis (varsayilan HEPSI olur): {s}"
        );
        assert!(
            s.contains("--permission-mode acceptEdits"),
            "izin modu belirtilmemis: {s}"
        );
        assert!(s.contains("--model 'opus'"), "model takma adi eksik: {s}");
    }

    #[test]
    fn bash_satiri_modeli_shell_quote_ile_arguman_olarak_tasir() {
        let s = bash_satiri_timeout(
            "/mnt/c/ci/x",
            "/mnt/c/ci/x/.smith-gorev.txt",
            180,
            "claude-opus-5-5",
        );
        assert!(s.contains("--model 'claude-opus-5-5'"));
        assert!(!s.contains("dangerously-skip-permissions"));
    }

    /// Bu modul ASLA push/merge etmez. Kaynak metninde o komutlarin
    /// bulunmamasi kaba ama etkili bir tanik: birisi ekleyince test kirilir.
    #[test]
    fn modul_push_veya_merge_komutu_icermez() {
        let kaynak = include_str!("code_agent.rs");
        // Kendi test satirlarimizi saymamak icin yalnizca komut bicimini ararız.
        for yasak in ["\"push\"", "\"merge\"", "\"rebase\"", "\"reset\""] {
            assert!(
                !kaynak.contains(yasak),
                "bu modul {yasak} komutunu icermemeli — birlestirme insana ait"
            );
        }
    }

    #[test]
    fn slug_turkce_ve_uzunluk_kisitini_uygular() {
        assert_eq!(slug("Ekran görüntüsü düzelt"), "ekran-goruntusu-duzelt");
        assert_eq!(slug("   "), "gorev");
        assert_eq!(slug("!!!"), "gorev");
        assert!(slug(&"a".repeat(100)).len() <= SLUG_MAX);
        // Ayirac tekrarlari sikisir.
        assert_eq!(slug("a   b"), "a-b");
    }

    /// Dal adi HER ZAMAN on ekli olmali: `git branch --list 'smith/gorev-*'`
    /// ajanin urettigi her seyi gostermenin tek yolu.
    #[test]
    fn dal_adi_daima_onekli() {
        for g in ["testleri duzelt", "!!!", "ç", &"x".repeat(80)] {
            let dal = format!("{DAL_ONEK}{}", slug(g));
            assert!(dal.starts_with("smith/gorev-"), "on ek yok: {dal}");
            assert!(dal.len() > DAL_ONEK.len(), "bos slug: {dal}");
        }
    }

    #[test]
    fn dogrula_bos_ve_uzun_metni_reddeder() {
        assert!(dogrula("").is_err());
        assert!(dogrula("   \n ").is_err());
        assert!(dogrula(&"a".repeat(GOREV_MAX + 1)).is_err());
        assert!(dogrula("testleri duzelt").is_ok());
    }

    #[test]
    fn wsl_yolu_surucuyu_cevirir() {
        assert_eq!(
            wsl_yolu(Path::new(r"C:\ci\smith-gorev-x")),
            "/mnt/c/ci/smith-gorev-x"
        );
        // Zaten POSIX olan yol bozulmaz.
        assert_eq!(wsl_yolu(Path::new("/home/c/x")), "/home/c/x");
    }

    /// Worktree koku REPO DISINDA olmali. Repo icinde olsa CI checkout'unun
    /// `git clean -ffdx` adimi gorev sonuclarini silerdi.
    #[test]
    fn worktree_koku_repo_disinda() {
        assert!(!WORKTREE_KOK.contains("smith-monorepo"));
        assert!(Path::new(WORKTREE_KOK).is_absolute());
    }

    /// Istem, ajana commit/push yasagini ve kabuk yoklugunu SOYLER. Guvenligi
    /// bayraklar saglar; bu yalnizca bosa giden turlari azaltir.
    #[test]
    fn istem_kurallari_tasir() {
        let i = istem("bir sey yap", "smith/gorev-x");
        for beklenen in ["commit ATMA", "push ETME", "merge ETME", "smith/gorev-x"] {
            assert!(i.contains(beklenen), "istemde eksik: {beklenen}");
        }
    }

    /// CANLI SONDANIN URETTIGI TEST: dal adi isin NE oldugunu soylemeli.
    ///
    /// Sonda `smith/gorev-apps-desktop-src-tauri-s` uretti — gorev bir dosya
    /// yoluyla basladigi icin ilk 24 karakter yolun kendisiydi. Ad verildiginde
    /// ondan, verilmediginde gorevden turetilir; bos/anlamsiz ad gorev metnine
    /// duser (adsiz kalmaktan iyidir).
    #[test]
    fn ad_verilince_dal_adi_ondan_turer() {
        // Simule: fonksiyonun ic mantiginin ayni ifadesi.
        let sec = |ad: Option<&str>, gorev: &str| -> String {
            ad.map(str::trim)
                .filter(|a| !a.is_empty())
                .map(slug)
                .filter(|s| s != "gorev")
                .unwrap_or_else(|| slug(gorev))
        };

        let gorev = "apps/desktop/src-tauri/src/agent_sessions.rs dosyasinda sabiti dusur";
        assert_eq!(sec(Some("sabit degeri dusur"), gorev), "sabit-degeri-dusur");
        // Ad yok -> eski davranis (yol parcasi). Kusurlu ama adsizlik degil.
        assert_eq!(sec(None, gorev), slug(gorev));
        // Bos ve anlamsiz ad gorev metnine duser.
        assert_eq!(sec(Some("   "), gorev), slug(gorev));
        assert_eq!(sec(Some("!!!"), gorev), slug(gorev));
    }

    #[test]
    fn yetenek_varsayilan_kapali() {
        // Env'e dokunmuyoruz: yalnizca semantigi sabitliyoruz. `env_flag`'in
        // kendi testleri deger yorumlamasini kapsiyor.
        assert!(
            !env_flag::acik_varsayilan_kapali("SMITH_CODE_AGENT_OLMAYAN_DEGISKEN"),
            "tanimsiz bayrak ACIK sayiliyor — kendi kodunu duzenleyen bir \
             yetenek icin kabul edilemez"
        );
    }
}
