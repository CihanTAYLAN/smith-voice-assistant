//! Canli sonda: `kod_gorevi_ver` gercekten WSL'deki Claude Code'u kosturuyor mu?
//!
//! YAN ETKI URETIR: repo disinda bir git worktree ve `smith/gorev-*` dali acar.
//! Merge/push YAPMAZ. Temizlik:
//!   git worktree remove --force C:\ci\smith-gorev-<slug>
//!   git branch -D smith/gorev-<slug>
//!
//! Kullanim (gorev metnini arguman olarak ver):
//!   $env:SMITH_CODE_AGENT="1"; $env:SMITH_REPO_DIR="C:\...\smith-monorepo"
//!   cargo run --example code_agent_probe -- "yapilacak is"

fn main() {
    let gorev: String = std::env::args().skip(1).collect::<Vec<_>>().join(" ");
    if gorev.trim().is_empty() {
        eprintln!("kullanim: cargo run --example code_agent_probe -- \"<gorev>\"");
        std::process::exit(2);
    }

    println!("=== on kosullar ===");
    println!(
        "  SMITH_CODE_AGENT acik : {}",
        smith_desktop_lib::code_agent::acik()
    );
    println!(
        "  SMITH_REPO_DIR        : {:?}",
        std::env::var("SMITH_REPO_DIR").unwrap_or_else(|_| "<yok>".into())
    );
    println!(
        "  dal adi kaynagi       : {}",
        std::env::var("SMITH_GOREV_ADI").unwrap_or_else(|_| "<gorev metninden>".into())
    );

    let t0 = std::time::Instant::now();
    let ad = std::env::var("SMITH_GOREV_ADI").ok();
    let v = smith_desktop_lib::code_agent::kod_gorevi_ver_bekle(&gorev, ad.as_deref());
    println!("\n=== sonuc ({} sn) ===", t0.elapsed().as_secs());
    println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
}
