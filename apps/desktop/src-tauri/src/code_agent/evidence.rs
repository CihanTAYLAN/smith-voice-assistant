//! Reviewable working-tree evidence, without changing the user's Git index.
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Serialize)]
pub struct ChangedPath {
    pub status: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct Evidence {
    pub base_sha: String,
    pub head_sha: String,
    pub changed_paths: Vec<ChangedPath>,
    pub patch_path: PathBuf,
    pub verification_pending: bool,
}

fn git_path(path: &Path) -> Result<String, String> {
    let path = path
        .to_str()
        .ok_or("Non-UTF-8 Git path")?
        .replace('\\', "/");
    Ok(if let Some(unc) = path.strip_prefix("//?/UNC/") {
        format!("//{unc}")
    } else {
        path.strip_prefix("//?/").unwrap_or(&path).to_owned()
    })
}

fn git(repo: &Path, index: Option<&Path>, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    command
        .current_dir(repo)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0");
    if let Some(index) = index {
        // std canonicalize Windows'ta \\?\ ekler. Git'in ortamdan okudugu
        // index yolu bu Win32 ozel bicimini kabul etmez (exit 128).
        command.env("GIT_INDEX_FILE", git_path(index)?);
    }
    let output = command
        .output()
        .map_err(|e| format!("git {}: {e}", args[0]))?;
    if !output.status.success() {
        return Err(format!("git {} failed ({})", args[0], output.status));
    }
    Ok(output.stdout)
}

fn utf8(bytes: Vec<u8>) -> Result<String, String> {
    String::from_utf8(bytes).map_err(|_| "Git returned a non-UTF-8 path or ref".into())
}

fn validate_path(root: &Path, relative: &str) -> Result<(), String> {
    let path = Path::new(relative);
    if relative.is_empty()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || relative
            .split(['/', '\\'])
            .any(|p| p.eq_ignore_ascii_case(".git"))
    {
        return Err("Repository path escape rejected".into());
    }
    let mut current = root.to_path_buf();
    for part in path.components() {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                // Never follow symlinks (including Windows junctions) when packaging evidence.
                #[cfg(windows)]
                let reparse = {
                    use std::os::windows::fs::MetadataExt;
                    metadata.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let reparse = false;
                if metadata.file_type().is_symlink() || reparse {
                    return Err("Symlink/reparse point in repository evidence rejected".into());
                }
                let resolved = fs::canonicalize(&current).map_err(|e| e.to_string())?;
                if !resolved.starts_with(root) {
                    return Err("Repository path escape rejected".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

/// `dosyalar` girdisini canonical goreli dosya yoluna cevirir (`/` ayiracli).
/// Belirsiz yazim izin listesinin disina tasabilecegi icin reddedilir: bos veya
/// `.`/`..` parcasi, mutlak/surucu yolu, akis (`a:b`), joker, kontrol karakteri,
/// sonda nokta veya bosluk, dizin, `.git`, symlink/junction ve sir dosyalari.
pub(super) fn canonical_relative(root: &Path, path: &str) -> Result<String, String> {
    let normalized = path.replace('\\', "/");
    if normalized.split('/').any(|p| {
        p.is_empty()
            || matches!(p, "." | "..")
            || p.ends_with(['.', ' '])
            || p.contains([':', '*', '?'])
            || p.chars().any(char::is_control)
    }) {
        return Err("dosyalar canonical goreli dosya yollari olmali".into());
    }
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    validate_path(&root, &normalized)?;
    reject_secret_path(&normalized)?;
    if root.join(&normalized).is_dir() {
        return Err("dosyalar dizin degil dosya belirtmeli".into());
    }
    Ok(normalized)
}

fn reject_secret_path(path: &str) -> Result<(), String> {
    let name = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_ascii_lowercase();
    let env = name == ".env"
        || (name.starts_with(".env.")
            && ![".example", ".sample", ".template"]
                .iter()
                .any(|suffix| name.ends_with(suffix)));
    if env
        || name == "dev-secrets.local.ps1"
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || name.starts_with("id_ecdsa")
        || [".pem", ".key", ".p12", ".pfx"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
    {
        return Err("Potential secret file changed; evidence collection refused".into());
    }
    Ok(())
}

/// `artifact_dir` must already exist outside the worktree. Each call keeps a
/// private index and a complete binary patch in its own new directory.
pub fn gather(worktree: &Path, base_sha: &str, artifact_dir: &Path) -> Result<Evidence, String> {
    gather_scoped(worktree, base_sha, artifact_dir, None)
}

/// `gather` + `dosyalar` izin listesi (`canonical_relative` ciktisi). Liste
/// verilirse degisen veya yeni HER yol listede olmali, aksi halde kanit
/// toplanmaz (fail-closed). `.gitignore`'lu dosyalar yamaya girmez, yani listeyi
/// asamaz.
pub fn gather_scoped(
    worktree: &Path,
    base_sha: &str,
    artifact_dir: &Path,
    allowed: Option<&[String]>,
) -> Result<Evidence, String> {
    if !matches!(base_sha.len(), 40 | 64) || !base_sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("base_sha must be a full commit object ID".into());
    }
    let root = fs::canonicalize(worktree).map_err(|e| e.to_string())?;
    if let Some(paths) = allowed {
        if paths.is_empty() {
            return Err("dosyalar izin listesi bos".into());
        }
        for path in paths {
            if canonical_relative(&root, path)? != *path {
                return Err("izin listesi canonical olmali".into());
            }
        }
    }
    let top = utf8(git(&root, None, &["rev-parse", "--show-toplevel"])?)?;
    if fs::canonicalize(top.trim()).map_err(|e| e.to_string())? != root {
        return Err("Evidence requires the worktree root".into());
    }
    let base = utf8(git(
        &root,
        None,
        &["rev-parse", "--verify", &format!("{base_sha}^{{commit}}")],
    )?)?;
    let head = utf8(git(
        &root,
        None,
        &["rev-parse", "--verify", "HEAD^{commit}"],
    )?)?;
    let base = base.trim().to_owned();
    let head = head.trim().to_owned();
    git(&root, None, &["merge-base", "--is-ancestor", &base, &head])?;
    let artifacts = fs::canonicalize(artifact_dir).map_err(|e| e.to_string())?;
    if artifacts.starts_with(&root) {
        return Err("Evidence artifacts must be outside the worktree".into());
    }
    // Teslim yolu git apply tarafindan da okunabilir standart yol olmali.
    let artifacts = PathBuf::from(git_path(&artifacts)?);
    // Inspect names before Git reads candidate contents into the private index.
    let modified = utf8(git(
        &root,
        None,
        &["diff", "--name-only", "-z", "--no-renames", &base, "--"],
    )?)?;
    let untracked = utf8(git(
        &root,
        None,
        &["ls-files", "-z", "--others", "--exclude-standard"],
    )?)?;
    for path in modified
        .split('\0')
        .chain(untracked.split('\0'))
        .filter(|p| !p.is_empty())
    {
        reject_secret_path(path)?;
        if allowed.is_some_and(|paths| !paths.iter().any(|p| p == path)) {
            return Err(format!("izin listesi disinda degisiklik: {path}"));
        }
    }
    let paths = utf8(git(
        &root,
        None,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    )?)?;
    for path in paths.split('\0').filter(|p| !p.is_empty()) {
        validate_path(&root, path)?;
    }
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let bundle = artifacts.join(format!(
        "evidence-{}-{stamp}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&bundle).map_err(|e| e.to_string())?;
    let index = bundle.join("index");
    git(&root, Some(&index), &["read-tree", &head])?;
    git(&root, Some(&index), &["add", "-A", "--", "."])?;
    // No rename inference: every NUL-delimited pair is exactly status + path.
    let names = utf8(git(
        &root,
        Some(&index),
        &[
            "diff",
            "--cached",
            "--name-status",
            "-z",
            "--no-renames",
            &base,
            "--",
        ],
    )?)?;
    let fields: Vec<_> = names.split_terminator('\0').collect();
    if fields.len() % 2 != 0 {
        return Err("Malformed Git name-status output".into());
    }
    let mut changed_paths = Vec::new();
    for pair in fields.chunks_exact(2) {
        validate_path(&root, pair[1])?;
        reject_secret_path(pair[1])?;
        if allowed.is_some_and(|paths| !paths.iter().any(|p| p == pair[1])) {
            return Err(format!("izin listesi disinda degisiklik: {}", pair[1]));
        }
        changed_paths.push(ChangedPath {
            status: pair[0].into(),
            path: pair[1].into(),
        });
    }
    let patch = git(
        &root,
        Some(&index),
        &[
            "diff",
            "--cached",
            "--binary",
            "--full-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            &base,
            "--",
        ],
    )?;
    let final_head = utf8(git(
        &root,
        None,
        &["rev-parse", "--verify", "HEAD^{commit}"],
    )?)?;
    if final_head.trim() != head {
        return Err("HEAD changed while collecting evidence".into());
    }
    let patch_path = bundle.join("changes.patch");
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&patch_path)
        .and_then(|mut f| f.write_all(&patch))
        .map_err(|e| e.to_string())?;
    Ok(Evidence {
        base_sha: base,
        head_sha: head,
        changed_paths,
        patch_path,
        verification_pending: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, PathBuf, String) {
        static ID: AtomicU64 = AtomicU64::new(0);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "smith-evidence-test-{}-{stamp}-{}",
            std::process::id(),
            ID.fetch_add(1, Ordering::Relaxed)
        ));
        let repo = dir.join("repo");
        let artifacts = dir.join("artifacts");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir(&artifacts).unwrap();
        git(&repo, None, &["init"]).unwrap();
        git(&repo, None, &["config", "core.autocrlf", "false"]).unwrap();
        git(
            &repo,
            None,
            &["config", "user.email", "test@example.invalid"],
        )
        .unwrap();
        git(&repo, None, &["config", "user.name", "Test"]).unwrap();
        fs::write(repo.join("tracked.txt"), "original\n").unwrap();
        git(&repo, None, &["add", "."]).unwrap();
        git(&repo, None, &["commit", "-m", "fixture"]).unwrap();
        let sha = utf8(git(&repo, None, &["rev-parse", "HEAD"]).unwrap())
            .unwrap()
            .trim()
            .into();
        (repo, artifacts, sha)
    }

    fn izin(yollar: &[&str]) -> Vec<String> {
        yollar.iter().map(|y| y.to_string()).collect()
    }

    #[test]
    fn izin_listesi_icindeki_degisiklik_kabul_edilir() {
        let (repo, artifacts, base) = fixture();
        fs::write(repo.join("tracked.txt"), "changed").unwrap();
        fs::write(repo.join("yeni.txt"), "new").unwrap();
        let liste = izin(&["tracked.txt", "yeni.txt"]);
        let proof = gather_scoped(&repo, &base, &artifacts, Some(&liste)).unwrap();
        assert_eq!(proof.changed_paths.len(), 2);
    }

    #[test]
    fn izin_listesi_disindaki_degisiklik_veya_yeni_dosya_kaniti_reddeder() {
        let (repo, artifacts, base) = fixture();
        fs::write(repo.join("tracked.txt"), "changed").unwrap();
        let liste = izin(&["baska.txt"]);
        assert!(gather_scoped(&repo, &base, &artifacts, Some(&liste)).is_err());

        fs::write(repo.join("yeni.txt"), "new").unwrap();
        let liste = izin(&["tracked.txt"]);
        let hata = gather_scoped(&repo, &base, &artifacts, Some(&liste)).unwrap_err();
        assert!(hata.contains("izin listesi disinda"), "{hata}");
    }

    /// `.gitignore`'lu dosya yamaya girmez: izin listesini asamaz, ama listedeki
    /// degisikligi de engellememeli (`pnpm install` `node_modules` birakir).
    #[test]
    fn gitignore_dosyasi_izin_listesi_icindeki_degisikligi_engellemez() {
        let (repo, artifacts, base) = fixture();
        fs::write(repo.join(".git/info/exclude"), "ignored.txt\n").unwrap();
        fs::write(repo.join("tracked.txt"), "changed").unwrap();
        fs::write(repo.join("ignored.txt"), "build artifact").unwrap();
        let liste = izin(&["tracked.txt"]);
        let proof = gather_scoped(&repo, &base, &artifacts, Some(&liste)).unwrap();
        assert_eq!(proof.changed_paths.len(), 1);
        let yama = fs::read_to_string(&proof.patch_path).unwrap();
        assert!(!yama.contains("ignored.txt"), "ignored dosya yamaya girdi");
    }

    #[test]
    fn bos_veya_canonical_olmayan_izin_listesi_kabul_edilmez() {
        let (repo, artifacts, base) = fixture();
        fs::write(repo.join("tracked.txt"), "changed").unwrap();
        for liste in [
            izin(&[]),
            izin(&["./tracked.txt"]),
            izin(&["../tracked.txt"]),
        ] {
            assert!(
                gather_scoped(&repo, &base, &artifacts, Some(&liste)).is_err(),
                "{liste:?}"
            );
        }
    }

    #[test]
    fn binary_new_staged_unstaged_files_roundtrip_without_touching_index() {
        let (repo, artifacts, base) = fixture();
        fs::write(repo.join("tracked.txt"), "staged\n").unwrap();
        fs::write(repo.join("staged.txt"), "new staged\n").unwrap();
        git(&repo, None, &["add", "."]).unwrap();
        fs::write(repo.join("tracked.txt"), "unstaged final\n").unwrap();
        let binary = [0, 1, 255, 42, 0, 128];
        fs::write(repo.join("new binary.bin"), binary).unwrap();
        let before = fs::read(repo.join(".git/index")).unwrap();
        let evidence = gather(&repo, &base, &artifacts).unwrap();
        assert_eq!(before, fs::read(repo.join(".git/index")).unwrap());
        assert_eq!(evidence.changed_paths.len(), 3);
        assert!(evidence
            .changed_paths
            .iter()
            .any(|p| p.path == "new binary.bin" && p.status == "A"));
        assert!(evidence.verification_pending);
        let checkout = artifacts.join("checkout");
        git(
            &repo,
            None,
            &[
                "worktree",
                "add",
                "--detach",
                checkout.to_str().unwrap(),
                &base,
            ],
        )
        .unwrap();
        git(
            &checkout,
            None,
            &["apply", "--binary", evidence.patch_path.to_str().unwrap()],
        )
        .unwrap();
        assert_eq!(fs::read(checkout.join("new binary.bin")).unwrap(), binary);
        assert_eq!(
            fs::read_to_string(checkout.join("tracked.txt")).unwrap(),
            "unstaged final\n"
        );
        assert_eq!(
            fs::read_to_string(checkout.join("staged.txt")).unwrap(),
            "new staged\n"
        );
    }

    #[test]
    fn rejects_invalid_base_non_repo_and_artifacts_inside_repo() {
        let (repo, artifacts, base) = fixture();
        assert!(gather(&repo, "HEAD", &artifacts).is_err());
        assert!(gather(&repo, &"0".repeat(40), &artifacts).is_err());
        assert!(gather(&artifacts, &base, &artifacts).is_err());
        assert!(gather(&repo, &base, &repo).is_err());
        assert!(validate_path(&repo, "../escape").is_err());
    }

    #[test]
    fn clean_repository_has_empty_patch() {
        let (repo, artifacts, base) = fixture();
        let evidence = gather(&repo, &base, &artifacts).unwrap();
        assert!(evidence.changed_paths.is_empty());
        assert!(fs::read(evidence.patch_path).unwrap().is_empty());
    }

    #[test]
    fn rename_is_reported_as_delete_and_add_and_patch_applies() {
        let (repo, artifacts, base) = fixture();
        fs::rename(repo.join("tracked.txt"), repo.join("renamed file.txt")).unwrap();
        let evidence = gather(&repo, &base, &artifacts).unwrap();
        assert_eq!(evidence.changed_paths.len(), 2);
        assert!(evidence
            .changed_paths
            .iter()
            .any(|p| p.path == "tracked.txt" && p.status == "D"));
        assert!(evidence
            .changed_paths
            .iter()
            .any(|p| p.path == "renamed file.txt" && p.status == "A"));
        let checkout = artifacts.join("checkout");
        git(
            &repo,
            None,
            &[
                "worktree",
                "add",
                "--detach",
                checkout.to_str().unwrap(),
                &base,
            ],
        )
        .unwrap();
        git(
            &checkout,
            None,
            &["apply", evidence.patch_path.to_str().unwrap()],
        )
        .unwrap();
        assert!(!checkout.join("tracked.txt").exists());
        assert_eq!(
            fs::read_to_string(checkout.join("renamed file.txt")).unwrap(),
            "original\n"
        );
    }

    #[test]
    fn rejects_secret_candidates_before_creating_bundle() {
        let (repo, artifacts, base) = fixture();
        fs::write(repo.join(".env"), "test-only-placeholder").unwrap();
        assert!(gather(&repo, &base, &artifacts)
            .unwrap_err()
            .contains("secret"));
        assert_eq!(fs::read_dir(artifacts).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_new_symlink_to_outside() {
        let (repo, artifacts, base) = fixture();
        std::os::unix::fs::symlink(&artifacts, repo.join("escape")).unwrap();
        assert!(gather(&repo, &base, &artifacts)
            .unwrap_err()
            .contains("Symlink"));
    }
}
