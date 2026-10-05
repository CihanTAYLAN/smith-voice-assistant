#[path = "src/time_util.rs"]
mod time_util;

fn git(args: &[&str]) -> Option<String> {
    let result = std::process::Command::new("git").args(args).output().ok()?;
    result
        .status
        .success()
        .then(|| String::from_utf8_lossy(&result.stdout).trim().to_owned())
}

fn main() {
    let sha = git(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "bilinmiyor".into());
    let built = time_util::utc_iso(time_util::unix_seconds(std::time::SystemTime::now()));
    println!("cargo:rustc-env=SMITH_BUILD_SHA={sha}");
    println!("cargo:rustc-env=SMITH_BUILD_TIME={built}");
    for reference in [
        "HEAD".to_string(),
        git(&["symbolic-ref", "-q", "HEAD"]).unwrap_or_default(),
    ] {
        if !reference.is_empty() {
            if let Some(path) = git(&["rev-parse", "--git-path", &reference]) {
                println!("cargo:rerun-if-changed={path}");
            }
        }
    }
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src");
    tauri_build::build()
}
