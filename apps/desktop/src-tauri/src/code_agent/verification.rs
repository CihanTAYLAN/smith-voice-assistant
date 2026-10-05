//! Fixed Smith checks; modified verification infrastructure cannot approve itself.
use super::evidence::{ChangedPath, Evidence};
use super::process::{self, ProcessResult};
use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

/// Host dogrulamasini acan ortam degiskeni; yalniz tam deger `host` acar.
const HOST_DOGRULAMA_ENV: &str = "SMITH_CODE_AGENT_VERIFY";

/// Host dogrulamasi kapaliyken dogrulama nedeni ve kosu kaydinin `sirada` metni.
pub(super) const HOST_VERIFICATION_DISABLED: &str =
    "dogrulama calistirilmadi (guvenlik): degisiklikleri inceleyip elle dogrula";

const SCRIPTS: [(&str, &str, u64); 3] = [
    ("install", "$ErrorActionPreference='Stop'; & pnpm install --frozen-lockfile --ignore-scripts; exit $LASTEXITCODE", 300),
    ("prisma-generate", "$ErrorActionPreference='Stop'; & pnpm --filter @smith/db --fail-if-no-match exec prisma generate; exit $LASTEXITCODE", 120),
    ("verify", "$ErrorActionPreference='Stop'; & pnpm verify; exit $LASTEXITCODE", 600),
];

#[derive(Debug, Serialize)]
pub struct Check {
    pub label: String,
    pub command: Vec<String>,
    pub process: ProcessResult,
}

#[derive(Debug, Serialize)]
pub struct Verification {
    pub status: String,
    pub reason: Option<String>,
    pub checks: Vec<Check>,
}

impl Verification {
    fn stop(status: &str, reason: &str) -> Self {
        Self {
            status: status.into(),
            reason: Some(reason.into()),
            checks: Vec::new(),
        }
    }
}

fn requires_review(change: &ChangedPath) -> bool {
    let path = change.path.replace('\\', "/").to_ascii_lowercase();
    let name = path.rsplit('/').next().unwrap_or(&path);
    let test = path.split('/').any(|s| matches!(s, "tests" | "__tests__"))
        || matches!(name, "test.rs" | "tests.rs")
        || name.contains(".test.")
        || name.contains(".spec.")
        || name.ends_with("_test.rs")
        || name.ends_with("_tests.rs");
    let config = matches!(
        name,
        "package.json"
            | "cargo.toml"
            | "cargo.lock"
            | "build.rs"
            | "pnpm-lock.yaml"
            | "package-lock.json"
            | "yarn.lock"
            | "bun.lock"
            | "bun.lockb"
            | "pnpm-workspace.yaml"
            | "turbo.json"
            | "turbo.jsonc"
            | ".npmrc"
            | ".pnpmfile.cjs"
            | "pnpmfile.cjs"
            | "lefthook.yml"
            | "rust-toolchain"
            | "rust-toolchain.toml"
            | "tauri.conf.json"
    ) || name.contains(".config.")
        || name.starts_with("tsconfig")
        || name.starts_with(".prettier")
        || name.starts_with(".eslint");
    config
        || path.starts_with("tooling/")
        || path
            .split('/')
            .any(|s| matches!(s, "scripts" | "config" | "configs"))
        || path.starts_with(".github/")
        || path.split('/').any(|s| s == ".cargo")
        || path == "apps/desktop/src-tauri/src/code_agent.rs"
        || path.starts_with("apps/desktop/src-tauri/src/code_agent/")
        || (test && change.status != "A")
}

fn modifies_inline_tests(worktree: &Path, evidence: &Evidence) -> Result<bool, String> {
    for change in &evidence.changed_paths {
        if change.status == "A" || !change.path.to_ascii_lowercase().ends_with(".rs") {
            continue;
        }
        let object = format!("{}:{}", evidence.base_sha, change.path);
        let mut command = Command::new("git");
        command.current_dir(worktree).args(["show", &object]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let output = command
            .output()
            .map_err(|e| format!("Cannot inspect baseline Rust tests: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "Cannot inspect baseline Rust tests: git show failed ({})",
                output.status
            ));
        }
        let source = String::from_utf8(output.stdout)
            .map_err(|_| "Baseline Rust source is not UTF-8".to_owned())?;
        let compact: String = source.chars().filter(|c| !c.is_whitespace()).collect();
        if compact.contains("#[cfg(test)]") || compact.contains("#[test]") {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Runs only fixed commands. Passing checks produces evidence for human review,
/// never a commit, merge, deployment, or an automatic completion decision.
///
/// HOST DOGRULAMASI VARSAYILAN KAPALI: `pnpm verify` aday kodu (yeni test
/// dosyalari dahil) kullanici yetkisiyle Windows host'ta calistirir; aday bir
/// teste `child_process.execSync` eklerse sandbox disi komut kosar. Yalniz
/// `SMITH_CODE_AGENT_VERIFY=host` acar. Kapaliyken `not_run_security` doner ve
/// kosu `review` olmaz. Kalici cozum ag ve sirsiz bir sandbox'ta dogrulamadir.
pub fn verify(
    worktree: &Path,
    artifact_dir: &Path,
    evidence: &Evidence,
) -> Result<Verification, String> {
    let kip = std::env::var(HOST_DOGRULAMA_ENV).ok();
    verify_with(kip.as_deref(), worktree, artifact_dir, evidence)
}

/// `verify`'in ortamdan bagimsiz govdesi: kip disaridan verilir, test ortama bakmaz.
fn verify_with(
    kip: Option<&str>,
    worktree: &Path,
    artifact_dir: &Path,
    evidence: &Evidence,
) -> Result<Verification, String> {
    if kip != Some("host") {
        return Ok(Verification::stop(
            "not_run_security",
            HOST_VERIFICATION_DISABLED,
        ));
    }
    verify_host(worktree, artifact_dir, evidence)
}

fn verify_host(
    worktree: &Path,
    artifact_dir: &Path,
    evidence: &Evidence,
) -> Result<Verification, String> {
    if evidence.head_sha != evidence.base_sha {
        return Ok(Verification::stop(
            "blocked",
            "HEAD differs from the task base",
        ));
    }
    if evidence.changed_paths.is_empty() {
        return Ok(Verification::stop("not_run", "No changes to verify"));
    }
    if evidence.changed_paths.iter().any(requires_review) {
        return Ok(Verification::stop("requires_review", "Verification infrastructure or existing tests changed; review the gate before executing it"));
    }
    match modifies_inline_tests(worktree, evidence) {
        Ok(true) => {
            return Ok(Verification::stop(
                "requires_review",
                "Existing Rust inline tests changed; review the gate before executing it",
            ))
        }
        Ok(false) => {}
        Err(reason) => return Ok(Verification::stop("blocked", &reason)),
    }
    let manifest = match std::fs::read(worktree.join("package.json")) {
        Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(value) => value,
            Err(_) => return Ok(Verification::stop("blocked", "Invalid Smith package.json")),
        },
        Err(_) => {
            return Ok(Verification::stop(
                "blocked",
                "Smith package.json is unavailable",
            ))
        }
    };
    if manifest.get("name").and_then(|name| name.as_str()) != Some("smith") {
        return Ok(Verification::stop(
            "blocked",
            "Verification supports only the Smith repository",
        ));
    }
    let root = std::fs::canonicalize(worktree).map_err(|e| e.to_string())?;
    let artifacts = std::fs::canonicalize(artifact_dir).map_err(|e| e.to_string())?;
    if artifacts.starts_with(&root) {
        return Ok(Verification::stop(
            "blocked",
            "Verification logs must be outside the worktree",
        ));
    }
    let mut result = Verification {
        status: "passed".into(),
        reason: None,
        checks: Vec::new(),
    };
    for (label, script, timeout) in SCRIPTS {
        let args = ["-NoProfile", "-NonInteractive", "-Command", script];
        let mut command = Command::new("powershell.exe");
        command.args(args).current_dir(&root);
        if !run_check(
            &mut result,
            label,
            "powershell.exe",
            &args,
            &mut command,
            timeout,
            &artifacts,
        ) {
            return Ok(result);
        }
    }
    if evidence
        .changed_paths
        .iter()
        .any(|p| p.path.ends_with(".rs"))
    {
        let args = ["test", "--lib"];
        let mut command = Command::new("cargo");
        command
            .args(args)
            .current_dir(root.join("apps/desktop/src-tauri"));
        run_check(
            &mut result,
            "cargo-test",
            "cargo",
            &args,
            &mut command,
            600,
            &artifacts,
        );
    }
    Ok(result)
}

fn run_check(
    result: &mut Verification,
    label: &str,
    program: &str,
    args: &[&str],
    command: &mut Command,
    seconds: u64,
    artifacts: &Path,
) -> bool {
    match process::run(command, Duration::from_secs(seconds), artifacts, label) {
        Ok(process) => {
            let success = process.succeeded();
            result.checks.push(Check {
                label: label.into(),
                command: std::iter::once(program)
                    .chain(args.iter().copied())
                    .map(str::to_owned)
                    .collect(),
                process,
            });
            if !success {
                result.status = "failed".into();
                result.reason = Some(format!(
                    "{label} failed or timed out; inspect the retained logs"
                ));
            }
            success
        }
        Err(error) => {
            result.status = "blocked".into();
            result.reason = Some(format!("{label} could not complete: {error}"));
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn change(path: &str, status: &str) -> ChangedPath {
        ChangedPath {
            path: path.into(),
            status: status.into(),
        }
    }

    fn evidence(paths: Vec<ChangedPath>) -> Evidence {
        Evidence {
            base_sha: "a".repeat(40),
            head_sha: "a".repeat(40),
            changed_paths: paths,
            patch_path: PathBuf::new(),
            verification_pending: true,
        }
    }

    /// Aday kod host'ta ancak acik bir kararla kosar: yeni bir test dosyasi
    /// (`requires_review` ona izin verir) bile `pnpm verify` ile calismaz.
    #[test]
    fn host_dogrulamasi_yalniz_tam_host_degeriyle_acilir() {
        let missing = Path::new("missing-verification-test-repository");
        let input = evidence(vec![change("src/new.test.ts", "A")]);
        for kip in [
            None,
            Some(""),
            Some("1"),
            Some("true"),
            Some("HOST"),
            Some("host "),
        ] {
            let result = verify_with(kip, missing, missing, &input).unwrap();
            assert_eq!(result.status, "not_run_security", "{kip:?}");
            assert!(result.checks.is_empty(), "{kip:?}");
            assert_eq!(
                result.reason.as_deref(),
                Some(HOST_VERIFICATION_DISABLED),
                "{kip:?}"
            );
        }
        // Acikken host yolu calisir (burada eksik depo yuzunden `blocked`).
        let acik = verify_with(Some("host"), missing, missing, &input).unwrap();
        assert_ne!(acik.status, "not_run_security");
    }

    #[test]
    fn protects_gate_and_existing_tests_but_allows_new_tests_and_product_code() {
        for path in [
            "apps/web/package.json",
            "pnpm-lock.yaml",
            "scripts/check.sh",
            "tooling/eslint/index.js",
            ".github/workflows/ci.yml",
            "apps/web/vitest.config.ts",
            "apps/desktop/src-tauri/build.rs",
            "apps/desktop/src-tauri/src/code_agent.rs",
            "apps/desktop/src-tauri/src/code_agent/evidence.rs",
            "apps/web/src/a.test.ts",
            "packages/core/tests/guard.rs",
        ] {
            assert!(requires_review(&change(path, "M")), "{path}");
        }
        assert!(requires_review(&change("apps/web/src/a.test.ts", "D")));
        assert!(requires_review(&change("apps\\web\\package.json", "A")));
        assert!(!requires_review(&change("apps/web/src/a.test.ts", "A")));
        assert!(!requires_review(&change("apps/web/src/App.tsx", "M")));
        assert!(!requires_review(&change(
            "apps/desktop/src-tauri/src/product.rs",
            "M"
        )));
    }

    #[test]
    fn no_changes_and_gate_mutation_never_spawn_checks() {
        let missing = Path::new("missing-verification-test-repository");
        let unchanged = verify_host(missing, missing, &evidence(vec![])).unwrap();
        assert_eq!(unchanged.status, "not_run");
        assert!(unchanged.checks.is_empty());
        let gate = verify_host(
            missing,
            missing,
            &evidence(vec![change("package.json", "M")]),
        )
        .unwrap();
        assert_eq!(gate.status, "requires_review");
        assert!(gate.checks.is_empty());
    }

    #[test]
    fn changed_head_and_unknown_repository_block_without_running_commands() {
        let missing = Path::new("missing-verification-test-repository");
        let mut input = evidence(vec![change("src/file.ts", "M")]);
        input.head_sha = "b".repeat(40);
        assert_eq!(
            verify_host(missing, missing, &input).unwrap().status,
            "blocked"
        );
        input.head_sha = input.base_sha.clone();
        let unknown = verify_host(missing, missing, &input).unwrap();
        assert_eq!(unknown.status, "blocked");
        assert!(unknown.checks.is_empty());
    }

    #[test]
    fn removed_inline_tests_are_detected_from_base_and_git_failure_blocks() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let repo =
            std::env::temp_dir().join(format!("smith-verification-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&repo).unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .current_dir(&repo)
                .args(args)
                .output()
                .unwrap();
            assert!(output.status.success());
            String::from_utf8(output.stdout).unwrap()
        };
        git(&["init"]);
        std::fs::write(repo.join("product.rs"), "#[cfg (test)] mod tests {}\n").unwrap();
        std::fs::write(repo.join("unit.rs"), "#[test] fn check() {}\n").unwrap();
        std::fs::write(repo.join("plain.rs"), "pub fn value() {}\n").unwrap();
        git(&["add", "."]);
        git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "fixture",
        ]);
        let base = git(&["rev-parse", "HEAD"]).trim().to_owned();
        // Removing the attribute in the candidate must not erase the baseline policy.
        std::fs::write(repo.join("product.rs"), "pub fn changed() {}\n").unwrap();
        let mut input = evidence(vec![change("product.rs", "M")]);
        input.base_sha = base.clone();
        input.head_sha = base;
        assert_eq!(
            verify_host(&repo, &repo, &input).unwrap().status,
            "requires_review"
        );
        input.changed_paths = vec![change("unit.rs", "D")];
        assert!(modifies_inline_tests(&repo, &input).unwrap());
        input.changed_paths = vec![change("plain.rs", "M")];
        assert!(!modifies_inline_tests(&repo, &input).unwrap());
        input.changed_paths = vec![change("new.rs", "A")];
        assert!(!modifies_inline_tests(&repo, &input).unwrap());
        input.changed_paths = vec![change("missing.rs", "M")];
        let result = verify_host(&repo, &repo, &input).unwrap();
        assert_eq!(result.status, "blocked");
        assert!(result.checks.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn absent_pnpm_is_a_failed_process_for_every_powershell_gate() {
        for (_, script, _) in SCRIPTS {
            // Empty the child PATH only; an unavailable pnpm must never exit zero.
            let output = Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    &format!("$env:PATH=''; {script}"),
                ])
                .output()
                .unwrap();
            assert!(!output.status.success());
        }
    }
}
