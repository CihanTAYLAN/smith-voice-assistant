//! Koşu kaydı modelin çalışma ağacının dışında yaşar; yeni oturumdan okunabilir.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use super::{evidence, process, verification};

/// Windows dosya tutamaci kilidi surec cokunce OS tarafindan birakilir.
/// Kalici bir sentinel'in varligini "canli kosu" sanip sonsuza dek kilitlemez.
fn lock(dir: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    options
        .open(dir.join("run.lock"))
        .map_err(|e| format!("kosu kilidi alinamadi: {e}"))
}

fn root() -> Result<PathBuf, String> {
    // Tek veri koku (SMITH_DATA_DIR ya da ~/.smith): `crate::paths`.
    crate::paths::data_path("code-runs").ok_or_else(|| "veri koku bulunamadi".to_string())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Salt okunur: persisted state canlı süreç iddiası değildir, yeniden çalıştırmaz.
pub fn read(id: &str) -> Result<Value, String> {
    if !valid_id(id) {
        return Err("gecersiz kosu kimligi".into());
    }
    let path = root()?.join(id).join("run.json");
    let data = std::fs::read_to_string(&path).map_err(|e| format!("kosu okunamadi: {e}"))?;
    let mut value: Value =
        serde_json::from_str(&data).map_err(|e| format!("bozuk kosu kaydi: {e}"))?;
    if value.get("run_id").and_then(Value::as_str) != Some(id) {
        return Err("kosu kimligi kayitla eslesmiyor".into());
    }
    value["live_status_checked"] = json!(false);
    Ok(value)
}

fn save(dir: &Path, record: &Value) -> Result<(), String> {
    let tmp = dir.join("run.json.tmp");
    let bytes = serde_json::to_vec_pretty(record).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, dir.join("run.json")).map_err(|e| e.to_string())
}

/// Kosu kaydindaki `dosyalar` izin listesi; kayit yoksa veya `null` ise `None`
/// (repo geneli). Bozuk kayit fail-closed: `Err`.
fn allowed_files(record: &Value) -> Result<Option<Vec<String>>, String> {
    match record.get("allowed_files") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|_| "bozuk dosyalar izin listesi".into()),
    }
}

/// Bitmemis kaydi `interrupted` durumuna alir. Cagiran kosu kilidini ALDIGI icin
/// (canli bir kosu kilidi tutar) kayit bir cokusten kalmistir; eski durum
/// `interrupted_status`ta saklanir ve yeniden dogrulamaya izin verilir.
fn recover_interrupted(record: &mut Value) {
    if matches!(
        record["status"].as_str(),
        Some("preparing" | "editing" | "collecting_evidence" | "verifying")
    ) {
        record["interrupted_status"] = record["status"].clone();
        record["status"] = json!("interrupted");
        record["live_status_checked"] = json!(true);
    }
}

pub fn reverify(id: &str) -> Result<Value, String> {
    if !cfg!(windows) {
        return Err("yerel dogrulayici Windows gerektirir".into());
    }
    if !valid_id(id) {
        return Err("gecersiz kosu kimligi".into());
    }
    let dir = root()?.join(id);
    let _lock = lock(&dir)?;
    let mut record = read(id)?;
    recover_interrupted(&mut record);
    let worktree = PathBuf::from(record["worktree"].as_str().ok_or("worktree kaydi yok")?);
    let expected = PathBuf::from(super::WORKTREE_KOK).join(format!("smith-{id}"));
    if worktree != expected {
        return Err("worktree yolu kosu kimligiyle eslesmiyor".into());
    }
    let base = record["base_sha"]
        .as_str()
        .ok_or("base SHA yok")?
        .to_owned();
    record["status"] = json!("verifying");
    record["verification_trigger"] = json!("manual_reverify");
    record["harness_pid"] = json!(std::process::id());
    save(&dir, &record)?;
    let result = allowed_files(&record)
        .and_then(|paths| evidence::gather_scoped(&worktree, &base, &dir, paths.as_deref()))
        .and_then(|proof| finish_verification(&worktree, &dir, &base, &proof, &mut record));
    if let Err(error) = result {
        record["status"] = json!("blocked");
        record["error"] = json!(error);
    }
    save(&dir, &record)?;
    Ok(record)
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("git baslatilamadi: {e}"))?;
    if !output.status.success() {
        return Err(format!("git {} basarisiz: {}", args[0], output.status));
    }
    String::from_utf8(output.stdout)
        .map(|s| s.trim().to_owned())
        .map_err(|e| e.to_string())
}

pub fn execute(
    repo: &Path,
    task: &str,
    label: &str,
    allowed: Option<Vec<String>>,
    background: bool,
) -> Result<Value, String> {
    if !cfg!(windows) {
        return Err("yerel kod motoru Windows + WSL gerektirir".into());
    }
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    let id = format!(
        "{}-{}-{}",
        now.as_nanos(),
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    );
    let repo = std::fs::canonicalize(repo).map_err(|e| e.to_string())?;
    let top = git(&repo, &["rev-parse", "--show-toplevel"])?;
    if std::fs::canonicalize(top).map_err(|e| e.to_string())? != repo {
        return Err("SMITH_REPO_DIR depo kokunu gostermeli".into());
    }
    let base = git(&repo, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    let directory = root()?.join(&id);
    std::fs::create_dir_all(directory.parent().ok_or("kosu kok dizini yok")?)
        .map_err(|e| e.to_string())?;
    std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let _lock = lock(&directory)?;
    if std::fs::canonicalize(&directory)
        .map_err(|e| e.to_string())?
        .starts_with(&repo)
    {
        return Err("kosu kaydi kaynak repo disinda olmali".into());
    }
    let branch = format!("{}{}-{}", super::DAL_ONEK, super::slug(label), id);
    let worktree = PathBuf::from(super::WORKTREE_KOK).join(format!("smith-{id}"));
    let parent = worktree.parent().ok_or("worktree kok dizini yok")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if parent.starts_with(&repo) {
        return Err("worktree kaynak depo disinda olmali".into());
    }
    let mut record = json!({
        "schema_version": 1, "run_id": id, "status": "preparing",
        "repo": repo, "base_sha": base, "dal": branch, "worktree": worktree,
        "record_path": directory.join("run.json"), "task": task,
        "started_at_unix_ms": now.as_millis(),
        "harness_pid": std::process::id(),
        "allowed_files": allowed,
        "acceptance": "human_review_required"
    });
    save(&directory, &record)?;
    let initial = record.clone();
    let task = task.to_owned();
    let execute = move || -> Result<Value, String> {
        let _lock = _lock;
        if let Err(error) = execute_inner(
            &repo,
            &worktree,
            &directory,
            &base,
            &branch,
            &task,
            &mut record,
        ) {
            record["status"] = json!("blocked");
            record["error"] = json!(error);
        }
        save(&directory, &record)?;
        Ok(record)
    };
    if background {
        std::thread::Builder::new()
            .name(format!("smith-code-{id}"))
            .spawn(move || {
                if let Err(error) = execute() {
                    eprintln!("[code-agent] kosu sonucu kaydedilemedi: {error}");
                }
            })
            .map_err(|e| format!("kosu baslatilamadi: {e}"))?;
        Ok(initial)
    } else {
        execute()
    }
}

fn execute_inner(
    repo: &Path,
    worktree: &Path,
    dir: &Path,
    base: &str,
    branch: &str,
    task: &str,
    record: &mut Value,
) -> Result<(), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["worktree", "add", "-b", branch])
        .arg(worktree)
        .arg(base)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("worktree acilamadi: {}", output.status));
    }
    let prompt = dir.join("prompt.md");
    let mut instruction = super::istem(task, branch);
    if let Some(paths) = allowed_files(record)? {
        instruction.push_str(&super::dosya_siniri_istemi(&paths));
    }
    std::fs::write(&prompt, instruction).map_err(|e| e.to_string())?;
    record["status"] = json!("editing");
    save(dir, record)?;
    // İç timeout WSL'deki süreçleri durdurur; dış timeout Windows başlatıcısını da sınırlar.
    let line = super::bash_satiri(&super::wsl_yolu(worktree), &super::wsl_yolu(&prompt));
    let mut command = Command::new("wsl.exe");
    command
        .args(["--exec", "bash", "-lc", &line])
        .env("WSL_UTF8", "1");
    let result = process::run(
        &mut command,
        Duration::from_secs(super::zaman_asimi() + 30),
        dir,
        "agent",
    )?;
    let summary = process::agent_summary(&result);
    record["agent_process"] = serde_json::to_value(result).map_err(|e| e.to_string())?;
    record["status"] = json!("collecting_evidence");
    save(dir, record)?;
    let proof = evidence::gather_scoped(worktree, base, dir, allowed_files(record)?.as_deref())?;
    record["evidence"] = serde_json::to_value(&proof).map_err(|e| e.to_string())?;
    let summary = match summary {
        Ok(summary) => summary,
        Err(error) => {
            record["agent_error"] = json!(&error);
            return Err(error);
        }
    };
    record["ajan_ozeti"] = json!(summary);
    record["verification_trigger"] = json!("automatic");
    record["status"] = json!("verifying");
    save(dir, record)?;
    finish_verification(worktree, dir, base, &proof, record)
}

fn finish_verification(
    worktree: &Path,
    dir: &Path,
    base: &str,
    proof: &evidence::Evidence,
    record: &mut Value,
) -> Result<(), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    let attempt = dir.join(format!("checks-{}", now.as_nanos()));
    std::fs::create_dir(&attempt).map_err(|e| e.to_string())?;
    let checks = verification::verify(worktree, &attempt, proof)?;
    // Bir test/build kaynak dosyayi degistirdiyse test edilen aday ile teslim
    // edilen aday ayni degildir. Yeni kanit bu ayrismayi gorunur kilar.
    let mut after =
        evidence::gather_scoped(worktree, base, &attempt, allowed_files(record)?.as_deref())?;
    let before_patch = std::fs::read(&proof.patch_path).map_err(|e| e.to_string())?;
    let after_patch = std::fs::read(&after.patch_path).map_err(|e| e.to_string())?;
    after.verification_pending = checks.status != "passed"
        || before_patch != after_patch
        || after.head_sha != proof.head_sha;
    record["evidence"] = serde_json::to_value(&after).map_err(|e| e.to_string())?;
    record["status"] = json!(if checks.status == "passed" {
        "review"
    } else {
        "blocked"
    });
    record["verification"] = serde_json::to_value(checks).map_err(|e| e.to_string())?;
    if before_patch != after_patch || after.head_sha != proof.head_sha {
        record["status"] = json!("blocked");
        record["error"] = json!("Dogrulama sirasinda aday degisti; yeni diff yeniden incelenmeli.");
    } else if let Some(object) = record.as_object_mut() {
        object.remove("error");
    }
    record["sirada"] = if record["verification"]["status"] == "not_run_security" {
        json!(verification::HOST_VERIFICATION_DISABLED)
    } else {
        json!("Kaniti ve diff'i inceleyin; birlestirme ve urun kabulu kullaniciya aittir.")
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cokmus kosu (kilit birakilmis, kayit `editing`/`verifying` kalmis) yeniden
    /// dogrulanabilmeli; biten kayit degismez.
    #[test]
    fn bitmemis_kosu_interrupted_olur_biten_kayit_degismez() {
        for status in ["preparing", "editing", "collecting_evidence", "verifying"] {
            let mut kayit = json!({"status": status});
            recover_interrupted(&mut kayit);
            assert_eq!(kayit["status"], "interrupted", "{status}");
            assert_eq!(kayit["interrupted_status"], status);
            assert_eq!(kayit["live_status_checked"], true);
        }
        for status in ["review", "blocked", "interrupted"] {
            let mut kayit = json!({"status": status});
            recover_interrupted(&mut kayit);
            assert_eq!(kayit, json!({"status": status}), "{status}");
        }
    }

    #[test]
    fn record_replacement_is_readable_and_has_no_half_json() {
        let dir = std::env::temp_dir().join(format!(
            "smith-record-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        save(&dir, &json!({"run_id":"test", "status":"editing"})).unwrap();
        save(
            &dir,
            &json!({"run_id":"test", "status":"blocked", "error":"offline"}),
        )
        .unwrap();
        let actual: Value =
            serde_json::from_slice(&std::fs::read(dir.join("run.json")).unwrap()).unwrap();
        assert_eq!(actual["error"], "offline");
        assert!(!dir.join("run.json.tmp").exists());
    }

    #[cfg(windows)]
    #[test]
    fn run_lock_is_exclusive_and_released_with_handle() {
        let dir = std::env::temp_dir().join(format!(
            "smith-lock-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let first = lock(&dir).unwrap();
        assert!(lock(&dir).is_err());
        drop(first);
        assert!(lock(&dir).is_ok());
    }

    #[test]
    fn status_cannot_escape_run_directory() {
        for id in ["", "..", "../other", "a/b", "a\\b", "C:\\other"] {
            assert!(!valid_id(id));
            assert!(read(id).is_err());
        }
        assert!(valid_id("123-456-0"));
    }
}
