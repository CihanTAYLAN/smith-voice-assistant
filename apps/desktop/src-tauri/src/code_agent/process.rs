//! Ajan ve doğrulayıcı aynı gerçek süreç sonucunu kullanır; özet başarı değildir.
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessResult {
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: u128,
    pub stdout_path: PathBuf,
    pub stderr_path: PathBuf,
}

impl ProcessResult {
    pub fn succeeded(&self) -> bool {
        self.exit_code == Some(0) && !self.timed_out
    }
}

pub fn run(
    command: &mut Command,
    timeout: Duration,
    directory: &Path,
    label: &str,
) -> Result<ProcessResult, String> {
    let stdout_path = directory.join(format!("{label}.stdout.log"));
    let stderr_path = directory.join(format!("{label}.stderr.log"));
    let stdout = File::create(&stdout_path).map_err(|e| e.to_string())?;
    let stderr = File::create(&stderr_path).map_err(|e| e.to_string())?;
    command.stdin(Stdio::null()).stdout(stdout).stderr(stderr);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let started = Instant::now();
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Ok(ProcessResult {
                exit_code: status.code(),
                timed_out: status.code() == Some(124),
                duration_ms: started.elapsed().as_millis(),
                stdout_path,
                stderr_path,
            });
        }
        if started.elapsed() >= timeout {
            // Windows'ta yalnız başlatıcıyı öldürmek pnpm/Node çocuklarını bırakır.
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let killed = Command::new("taskkill.exe")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .creation_flags(0x08000000)
                    .output()
                    .map_err(|e| format!("surec agaci durdurulamadi: {e}"))?;
                if !killed.status.success()
                    && child.try_wait().map_err(|e| e.to_string())?.is_none()
                {
                    return Err("surec agaci durdurulamadi; kosu hala canli olabilir".into());
                }
            }
            #[cfg(not(windows))]
            child.kill().map_err(|e| e.to_string())?;
            child.wait().map_err(|e| e.to_string())?;
            return Ok(ProcessResult {
                exit_code: None,
                timed_out: true,
                duration_ms: started.elapsed().as_millis(),
                stdout_path,
                stderr_path,
            });
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Claude JSON'unda gerçek tamamlanma, süreç başarısına ek bir koşuldur.
pub fn agent_summary(result: &ProcessResult) -> Result<String, String> {
    if !result.succeeded() {
        return Err(format!(
            "ajan basarisiz: exit {:?}, timeout {}",
            result.exit_code, result.timed_out
        ));
    }
    let size = std::fs::metadata(&result.stdout_path)
        .map_err(|e| e.to_string())?
        .len();
    if size > 4 * 1024 * 1024 {
        return Err("ajan JSON sonucu 4 MiB sinirini asti; ham log korundu".into());
    }
    let raw = std::fs::read_to_string(&result.stdout_path).map_err(|e| e.to_string())?;
    #[derive(Deserialize)]
    struct AgentOutput {
        result: String,
        is_error: Option<bool>,
        subtype: Option<String>,
    }
    let output: AgentOutput =
        serde_json::from_str(&raw).map_err(|e| format!("ajan sonucu gecerli JSON degil: {e}"))?;
    if output.is_error == Some(true)
        || output.subtype.as_deref().is_some_and(|s| s != "success")
        || output.result.trim().is_empty()
    {
        return Err("ajan tamamlanmis ve bos olmayan bir sonuc bildirmedi; logu inceleyin".into());
    }
    Ok(output.result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_must_be_complete_and_nonempty_even_after_exit_zero() {
        let dir = std::env::temp_dir().join(format!(
            "smith-process-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let result = ProcessResult {
            exit_code: Some(0),
            timed_out: false,
            duration_ms: 1,
            stdout_path: dir.join("stdout.json"),
            stderr_path: dir.join("stderr.log"),
        };
        for raw in [
            "",
            "{}",
            r#"{"result":""}"#,
            r#"{"result":"partial""#,
            r#"{"result":"no","is_error":true}"#,
            r#"{"result":"no","subtype":"error_max_turns"}"#,
        ] {
            std::fs::write(&result.stdout_path, raw).unwrap();
            assert!(agent_summary(&result).is_err(), "{raw}");
        }
        std::fs::write(
            &result.stdout_path,
            r#"{"result":"changed file","is_error":false,"subtype":"success"}"#,
        )
        .unwrap();
        assert_eq!(agent_summary(&result).unwrap(), "changed file");
    }

    #[test]
    fn timeout_and_signal_are_not_success() {
        let mut result = ProcessResult {
            exit_code: Some(0),
            timed_out: false,
            duration_ms: 1,
            stdout_path: PathBuf::new(),
            stderr_path: PathBuf::new(),
        };
        assert!(result.succeeded());
        result.timed_out = true;
        assert!(!result.succeeded());
        result.timed_out = false;
        result.exit_code = None;
        assert!(!result.succeeded());
        result.exit_code = Some(1);
        assert!(!result.succeeded());
        assert!(agent_summary(&result).is_err());
    }
}
