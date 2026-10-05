//! SMITH DASHBOARD Rust komutlari: boot nobeti, dosya yoneticisi, bilgi grafigi.
//!
//! GUVENLIK MODELI: panel, cihaz sahibinin KENDI yuzeyidir (ADR 0003 —
//! cihaz-tarafi araclar sahibin yetkisiyle calisir; webview kimlik gormez,
//! gateway'e `mission_call` kopruSU uzerinden yalniz okuma uclari aciktir).
//! Yine de sinirlar KODDA cunku "kendi makinesi" bile yanlislikla zarar
//! gorebilir:
//!
//!  - Dosya yollari IZINLI KOKLERIN altinda olmali; yol kanoniklestirilir, yani
//!    symlink ile kok disina cikilamaz.
//!  - `.git/` icine YAZILAMAZ (surpriz bozulma sinifi).
//!  - Okuma/yazma 512 KB ile sinirli; ikili dosya okunmaz.
//!  - Yazma "beklenen mtime" ister; diskte degisen dosyanin ustune yazmak
//!    REDDEDILIR — sessiz veri kaybi, bu deponun yasak sinifidir.
//!
//! GRAFIK: ObsidianVaults altindaki .md notlari + [[wiki]] / markdown
//! linklerinden kenarlar. `[[x]]` cozumlemesi once vault-kok yolu, sonra
//! kaynak dosyaya gore goreli yol, en son DOSYA ADI eslesmesi ile yapilir.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::context_exclude::ContextExclude;

const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_LIST_ENTRIES: usize = 3000;
const MAX_VAULT_FILES: usize = 800;
const MAX_VAULT_EDGES: usize = 5000;

/// Boot nobeti: panel cizilince `dashboard_ready` isaretler; `mission.rs`
/// watchdog'u isaretlenmezse pencereyi bir kez yeniden yukler.
static BOOTED: AtomicBool = AtomicBool::new(false);

pub fn boot_reset() {
    BOOTED.store(false, Ordering::Relaxed);
}

pub fn booted() -> bool {
    BOOTED.load(Ordering::Relaxed)
}

/// Teshis: panel ici hatalar Rust log'una duser (`[dashboard] ...`).
#[tauri::command]
pub fn dashboard_log(message: String) {
    eprintln!("[dashboard] {message}");
}

/// Panel cizildi sinyali — beyaz ekran nobetini besler.
#[tauri::command]
pub fn dashboard_ready() {
    BOOTED.store(true, Ordering::Relaxed);
    eprintln!("[dashboard] boot ok (panel cizildi)");
}

// --- ortak yol politakasi ---------------------------------------------------

fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(PathBuf::from))
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn vault_root() -> PathBuf {
    std::env::var("SMITH_VAULT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home_dir().join("ObsidianVaults"))
}

fn vault_source_id(path: &Path) -> Option<String> {
    let root = vault_root();
    let root = std::fs::canonicalize(&root).unwrap_or(root);
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let rel = path.strip_prefix(root).ok()?;
    let mut rel = rel.to_string_lossy().replace('\\', "/");
    if rel.is_empty() {
        None
    } else {
        if path.is_dir() && !rel.ends_with('/') {
            rel.push('/');
        }
        Some(format!("obsidian:{rel}"))
    }
}

fn vault_path_excluded(path: &Path, content: &str, exclude: &ContextExclude) -> bool {
    vault_source_id(path)
        .map(|source_id| exclude.matches(&source_id, content))
        .unwrap_or(false)
}

/// Izinli kokler. `SMITH_REPO_DIR` dev-win.ps1'den gelir (sabit yol koda
/// YAZILMAZ — dikis burada); vault koku `SMITH_VAULT_DIR` ile ezilebilir.
fn allowed_roots() -> Vec<(String, PathBuf)> {
    let home = home_dir();
    let mut roots = Vec::new();
    let repo = std::env::var("SMITH_REPO_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join("smith-monorepo"));
    if repo.is_dir() {
        roots.push(("smith-monorepo".to_string(), repo));
    }
    let vault = vault_root();
    if vault.is_dir() {
        roots.push(("ObsidianVaults".to_string(), vault));
    }
    // Smith veri koku (SMITH_DATA_DIR ya da ~/.smith) panelde ".smith" etiketiyle gorunur.
    let smith = crate::paths::data_dir().unwrap_or_else(|| home.join(".smith"));
    if smith.is_dir() {
        roots.push((".smith".to_string(), smith));
    }
    roots.push(("home".to_string(), home));
    roots
}

/// Var olan yolu kanoniklestirir; henuz olmayan dosya icin UST DIZINI
/// kanoniklestirip dosya adini ekler (yeni dosya yazimi icin).
fn canonical_target(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return std::fs::canonicalize(path).map_err(|e| format!("yol cozulemedi: {e}"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| "gecersiz yol (ust dizin yok)".to_string())?;
    let parent_c =
        std::fs::canonicalize(parent).map_err(|e| format!("ust dizin cozulemedi: {e}"))?;
    let name = path
        .file_name()
        .ok_or_else(|| "gecersiz dosya adi".to_string())?;
    Ok(parent_c.join(name))
}

/// Kanonik hedef izinli koklerden birinin altinda mi?
fn ensure_under_roots(target: &Path, roots: &[(String, PathBuf)]) -> Result<PathBuf, String> {
    let canon = canonical_target(target)?;
    for (_, root) in roots {
        if let Ok(root_c) = std::fs::canonicalize(root) {
            if canon.starts_with(&root_c) {
                return Ok(canon);
            }
        }
    }
    Err(format!(
        "izin verilmeyen yol (izinli koklerin disinda): {}",
        target.display()
    ))
}

/// Gosterim icin `\\?\` onekini kirpar; komut girdisi olarak onekli yol da
/// sorunsuzdur (yeniden kanoniklestirilir).
fn display_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

fn mtime_ms(md: &std::fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --- dosya yoneticisi -------------------------------------------------------

#[derive(Serialize)]
pub struct FsRoot {
    label: String,
    path: String,
}

#[derive(Serialize)]
pub struct FsEntry {
    name: String,
    path: String,
    kind: &'static str,
    size: u64,
    #[serde(rename = "mtimeMs")]
    mtime_ms: i64,
}

/// Bir dizinin listesi. `MAX_LIST_ENTRIES`i asan dizin KESILIR; eskiden bu sessiz
/// oluyordu ve panel eksik listeyi tam saniyordu. Artik kesildigi, toplam ve limit
/// yanitta gider; arayuz tek satirlik uyari gosterir.
#[derive(Serialize)]
pub struct FsListing {
    entries: Vec<FsEntry>,
    /// `entries` dizinin tamamini tasimiyor.
    truncated: bool,
    /// Dizindeki giris sayisi (kesilenler dahil; durumu okunamayanlar haric).
    total: usize,
    /// Tek listenin tasidigi en cok giris.
    limit: usize,
}

#[derive(Serialize)]
pub struct FileContent {
    content: String,
    #[serde(rename = "mtimeMs")]
    mtime_ms: i64,
    size: u64,
}

#[derive(Serialize)]
pub struct FsWriteResult {
    #[serde(rename = "mtimeMs")]
    mtime_ms: i64,
    size: u64,
}

#[tauri::command]
pub fn dashboard_fs_roots() -> Vec<FsRoot> {
    allowed_roots()
        .into_iter()
        .map(|(label, path)| FsRoot {
            label,
            path: display_path(&path),
        })
        .collect()
}

#[tauri::command]
pub fn dashboard_fs_list(path: String) -> Result<FsListing, String> {
    let roots = allowed_roots();
    let dir = ensure_under_roots(Path::new(&path), &roots)?;
    list_dir(&dir, MAX_LIST_ENTRIES)
}

/// `dir`in girislerinden en cok `limit` tanesini verir. Fazlasi SAYILIR ama
/// okunmaz (durum sorgusu yok): `total` ve `truncated` dogru kalir, maliyet
/// dizin boyutuyla degil limitle orantili artar.
fn list_dir(dir: &Path, limit: usize) -> Result<FsListing, String> {
    let rd = std::fs::read_dir(dir).map_err(|e| format!("dizin okunamadi: {e}"))?;
    let mut out: Vec<FsEntry> = Vec::new();
    let mut kesilen = 0usize;
    let exclude = ContextExclude::from_env();
    for item in rd.flatten() {
        if out.len() >= limit {
            kesilen += 1;
            continue;
        }
        let md = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = md.is_dir();
        let item_path = item.path();
        let content = if !is_dir && md.len() <= MAX_FILE_BYTES {
            std::fs::read_to_string(&item_path).unwrap_or_default()
        } else {
            String::new()
        };
        if vault_path_excluded(&item_path, &content, &exclude) {
            continue;
        }
        out.push(FsEntry {
            name: item.file_name().to_string_lossy().to_string(),
            path: display_path(&item_path),
            kind: if is_dir { "dir" } else { "file" },
            size: if is_dir { 0 } else { md.len() },
            mtime_ms: mtime_ms(&md),
        });
    }
    // Dizinler once, sonra ada gore (Turkce'ye duyarli kucuk harf).
    out.sort_by(|a, b| {
        let ad = a.kind == "dir";
        let bd = b.kind == "dir";
        bd.cmp(&ad)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(FsListing {
        total: out.len() + kesilen,
        truncated: kesilen > 0,
        limit,
        entries: out,
    })
}

#[tauri::command]
pub fn dashboard_fs_read(path: String) -> Result<FileContent, String> {
    let roots = allowed_roots();
    let p = ensure_under_roots(Path::new(&path), &roots)?;
    let md = std::fs::metadata(&p).map_err(|e| format!("dosya yok: {e}"))?;
    if !md.is_file() {
        return Err("bir dizin okunamaz".to_string());
    }
    if md.len() > MAX_FILE_BYTES {
        return Err(format!(
            "dosya cok buyuk ({} KB > {} KB)",
            md.len() / 1024,
            MAX_FILE_BYTES / 1024
        ));
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("okuma hatasi: {e}"))?;
    let content = String::from_utf8(bytes).map_err(|_| "ikili dosya (metin degil)".to_string())?;
    if vault_path_excluded(&p, &content, &ContextExclude::from_env()) {
        return Err("baglam dislama kuraliyla gizlendi".to_string());
    }
    Ok(FileContent {
        content,
        mtime_ms: mtime_ms(&md),
        size: md.len(),
    })
}

/// Dosyayi ayni dizindeki gecici dosya uzerinden yazar: icerik tamamen yazilip
/// diske esitlendikten sonra `rename` ile yerine konur (Windows'ta mevcut
/// dosyanin ustune degistirme). `std::fs::write` once dosyayi KESIYORDU: disk
/// dolarsa veya uygulama yazma ortasinda cokerse onceki icerik kaybolur ya da
/// yarim dosya kalirdi. Hata halinde gecici dosya silinir, hedefe dokunulmaz.
///
/// `write` kapanisi icerigi yazar (testte yarida hata verebilsin diye disaridan).
fn write_file(
    path: &Path,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> std::io::Result<()> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("dosya dizini yok"))?;
    let temp = parent.join(format!(
        ".smith-write-{}-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(std::io::Error::other)?
            .as_nanos(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let result = write(&mut file).and_then(|()| file.sync_all());
    drop(file);
    let result = result.and_then(|()| std::fs::rename(&temp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[tauri::command]
pub fn dashboard_fs_write(
    path: String,
    content: String,
    expected_mtime_ms: Option<i64>,
) -> Result<FsWriteResult, String> {
    let roots = allowed_roots();
    let p = ensure_under_roots(Path::new(&path), &roots)?;
    if p.components().any(|c| c.as_os_str() == ".git") {
        return Err("`.git` icine yazilamaz".to_string());
    }
    if p.is_dir() {
        return Err("bir dizinin ustune yazilamaz".to_string());
    }
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err(format!(
            "icerik cok buyuk ({} KB > {} KB)",
            content.len() / 1024,
            MAX_FILE_BYTES / 1024
        ));
    }
    if vault_path_excluded(&p, &content, &ContextExclude::from_env()) {
        return Err("baglam dislama kuraliyla gizlendi".to_string());
    }
    if p.exists() {
        let md = std::fs::metadata(&p).map_err(|e| format!("dosya durumu okunamadi: {e}"))?;
        if let Some(expected) = expected_mtime_ms {
            let current = mtime_ms(&md);
            if (current - expected).abs() > 2 {
                return Err("dosya diskte degisti — once yeniden yukle, sonra kaydet".to_string());
            }
        }
    }
    write_file(&p, |file| {
        use std::io::Write;
        file.write_all(content.as_bytes())
    })
    .map_err(|e| format!("yazma hatasi: {e}"))?;
    let md = std::fs::metadata(&p).map_err(|e| format!("yazim sonrasi durum okunamadi: {e}"))?;
    Ok(FsWriteResult {
        mtime_ms: mtime_ms(&md),
        size: md.len(),
    })
}

// --- bilgi grafigi (vault) --------------------------------------------------

#[derive(Serialize)]
pub struct VaultNode {
    id: String,
    label: String,
    vault: String,
    size: u64,
}

#[derive(Serialize)]
pub struct VaultEdge {
    from: String,
    to: String,
}

#[derive(Serialize)]
pub struct VaultGraph {
    root: String,
    nodes: Vec<VaultNode>,
    edges: Vec<VaultEdge>,
}

/// `a/b/../c.md` → `a/c.md` (bos ve `.` segmentleri atilir).
fn normalize_rel(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// Metinden [[wiki]] ve `](hedef.md)` link hedeflerini cikarir.
fn scan_links(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        match after.find("]]") {
            Some(end) => {
                let raw = &after[..end];
                let target = raw
                    .split('|')
                    .next()
                    .unwrap_or("")
                    .split('#')
                    .next()
                    .unwrap_or("")
                    .trim();
                if !target.is_empty() {
                    out.push(target.to_string());
                }
                rest = &after[end + 2..];
            }
            None => break,
        }
    }
    let mut rest = text;
    while let Some(start) = rest.find("](") {
        let after = &rest[start + 2..];
        match after.find(')') {
            Some(end) => {
                let raw = after[..end].trim();
                let lower = raw.to_ascii_lowercase();
                if lower.ends_with(".md") && !lower.starts_with("http") {
                    out.push(raw.to_string());
                }
                rest = &after[end + 1..];
            }
            None => break,
        }
    }
    out
}

/// Bir link hedefini vault dugum id'sine cozer (id: `<vault>/<relpath>`).
/// Sirasiyla: kaynak VAULT koku, kaynak dizine goreli yol, dosya adi eslesmesi.
/// Wiki linkleri (`[[not]]`) vault-kok gorelidir; markdown linkleri (`](../x.md)`)
/// kaynak dosyaya gorelidir — ikisi de bu uc denemeyle cozulur.
fn resolve_link(
    source_id: &str,
    raw: &str,
    by_lower: &HashMap<String, String>,
    by_base: &HashMap<String, String>,
) -> Option<String> {
    let t = raw.trim().replace('\\', "/");
    let t = t.strip_prefix("./").unwrap_or(&t).to_string();
    if t.is_empty() {
        return None;
    }
    let with_ext = if t.to_ascii_lowercase().ends_with(".md") {
        t
    } else {
        format!("{t}.md")
    };
    // 1) Kaynak vault koku ([[decisions/adr]] → <vault>/decisions/adr.md)
    let source_vault = source_id.split('/').next().unwrap_or("");
    if !source_vault.is_empty() {
        let candidate = normalize_rel(&format!("{source_vault}/{with_ext}"));
        if let Some(id) = by_lower.get(&candidate.to_ascii_lowercase()) {
            return Some(id.clone());
        }
    }
    // 2) Kaynak dizine goreli ([../decisions/adr.md])
    let source_dir = source_id.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    if !source_dir.is_empty() {
        let candidate = normalize_rel(&format!("{source_dir}/{with_ext}"));
        if let Some(id) = by_lower.get(&candidate.to_ascii_lowercase()) {
            return Some(id.clone());
        }
    }
    // 3) Dosya adi eslesmesi ([[Not Adi]])
    let base = with_ext.rsplit('/').next().unwrap_or(&with_ext);
    by_base.get(&base.to_ascii_lowercase()).cloned()
}

/// Vault agacini gezer: `.` ile baslayan dizinler, `node_modules` ve
/// `worktrees` ATLANIR (ikincisi repo worktree'lerinin kopyasi olurdu).
fn collect_notes(dir: &Path, out: &mut Vec<(String, PathBuf, u64)>) {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for item in entries {
        let name = item.file_name().to_string_lossy().to_string();
        let path = item.path();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if name.starts_with('.') || name == "node_modules" || name == "worktrees" {
                continue;
            }
            collect_notes(&path, out);
        } else if name.to_ascii_lowercase().ends_with(".md") {
            let size = item.metadata().map(|m| m.len()).unwrap_or(0);
            out.push((name, path, size));
        }
    }
}

fn build_vault_graph(
    root: &Path,
    max_files: usize,
    exclude: &ContextExclude,
) -> Result<VaultGraph, String> {
    if !root.is_dir() {
        return Err(format!("vault koku yok: {}", root.display()));
    }

    let mut vaults: Vec<PathBuf> = std::fs::read_dir(&root)
        .map_err(|e| format!("vault koku okunamadi: {e}"))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    vaults.sort();

    // Toplama: (id, path, size)
    let mut collected: Vec<(String, PathBuf, u64)> = Vec::new();
    for vault_dir in vaults {
        let vault_name = vault_dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if vault_name.starts_with('.') {
            continue;
        }
        if exclude.matches(&format!("obsidian:{vault_name}/"), "") {
            continue;
        }
        let mut notes = Vec::new();
        collect_notes(&vault_dir, &mut notes);
        for (name, path, size) in notes {
            let rel = path
                .strip_prefix(&vault_dir)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| name.clone());
            let id = format!("{vault_name}/{rel}");
            if !exclude.matches(&format!("obsidian:{id}"), "") {
                collected.push((id, path, size));
            }
        }
    }
    // Deterministik: once ada gore sirala, sonra keyword filtresi ve global sinir.
    collected.sort_by(|a, b| a.0.cmp(&b.0));
    let mut selected: Vec<(String, PathBuf, u64, Option<String>)> = Vec::new();
    for (id, path, size) in collected {
        let text = std::fs::read_to_string(&path).ok();
        if exclude.matches(&format!("obsidian:{id}"), text.as_deref().unwrap_or("")) {
            continue;
        }
        selected.push((id, path, size, text));
        if selected.len() >= max_files {
            break;
        }
    }

    let mut nodes: Vec<VaultNode> = Vec::with_capacity(selected.len());
    let mut by_lower: HashMap<String, String> = HashMap::with_capacity(selected.len());
    // Dosya adi indeksi: ayni adli notlarda ILK (id sirasi deterministik) kazanir.
    let mut by_base: HashMap<String, String> = HashMap::with_capacity(selected.len());
    for (id, path, size, _) in &selected {
        let label = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| id.clone());
        let vault = id.split('/').next().unwrap_or("").to_string();
        by_lower.insert(id.to_ascii_lowercase(), id.clone());
        let base = id.rsplit('/').next().unwrap_or(id).to_ascii_lowercase();
        by_base.entry(base).or_insert_with(|| id.clone());
        nodes.push(VaultNode {
            id: id.clone(),
            label,
            vault,
            size: *size,
        });
    }

    let mut edges: Vec<VaultEdge> = Vec::new();
    for (id, _, _, text) in &selected {
        if edges.len() >= MAX_VAULT_EDGES {
            break;
        }
        let text = match text {
            Some(text) => text,
            None => continue, // ikili/okunamayan dosya: dugum kalir, kenar yok
        };
        for raw in scan_links(text) {
            if let Some(target) = resolve_link(id, &raw, &by_lower, &by_base) {
                if &target != id && edges.len() < MAX_VAULT_EDGES {
                    edges.push(VaultEdge {
                        from: id.clone(),
                        to: target,
                    });
                }
            }
        }
    }

    Ok(VaultGraph {
        root: display_path(root),
        nodes,
        edges,
    })
}

#[tauri::command]
pub fn dashboard_vault_graph() -> Result<VaultGraph, String> {
    let root = vault_root();
    build_vault_graph(&root, MAX_VAULT_FILES, &ContextExclude::from_env())
}

// --- motor nobeti (is gucu) -------------------------------------------------

/// Tek motorun panelde gorunen durumu.
///
/// `note` alani bos biralabilir ama "kullanilamiyor" hali SUSMAZ: sebep ve
/// yapilmasi gereken sey buraya yazilir. Panelin isi durumu gostermek, umut
/// vermek degil.
#[derive(Serialize)]
pub struct EngineStatus {
    id: String,
    label: String,
    /// Kosacagi makine: `wsl` | `windows`.
    host: String,
    available: bool,
    version: Option<String>,
    /// Abonelik/kimlik durumu (Codex: "Logged in using ChatGPT").
    identity: Option<String>,
    note: Option<String>,
}

/// Ciktinin ilk DOLU satiri. Bos satirlar ve `MISSING` isaretcisi yok sayilir.
fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && *line != "MISSING")
        .map(str::to_string)
}

/// Motor probu son tarihi: takilan bir CLI veya WSL baslatma asamasi paneli
/// sonsuza kadar bekletmez (eskiden `.output()` zaman asimsizdi ve tamponu
/// sinirsizdi).
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Komutu son tarihli ve cikti kotali kosar (`system_tools::run_bounded`); ilk
/// dolu satiri doner.
fn probe(command: &mut std::process::Command) -> Option<String> {
    let (stdout, stderr) = crate::system_tools::run_bounded(command, PROBE_TIMEOUT)?;
    first_line_any_stream(&stdout, &stderr)
}

/// WSL icinde bir kabuk komutu kosar. Komut ICINDE `timeout 8s` vardir: panel
/// acilirken takilan bir CLI paneli bekletmemeli (WSL'in kendi baslatma
/// asamasini `PROBE_TIMEOUT` sinirlar). `WSL_UTF8=1` sart: wsl.exe varsayilan
/// olarak UTF-16LE yazar (motorlarda da ayni tuzak olculdu).
fn wsl_probe(script: &str) -> Option<String> {
    probe(
        std::process::Command::new("wsl.exe")
            .args(["-e", "bash", "-lc", script])
            .env("WSL_UTF8", "1"),
    )
}

/// Iki akistan ilk dolu satiri secer: once stdout, sonra stderr.
///
/// OLCULDU (2026-09-18): `codex login status` sonucu **stderr**'e yaziyor ve
/// exit 0 donuyor. Yalniz stdout okuyan prob kimligi bos gosterdi; panel
/// "hazir" satirinda abonelik bilgisi kayboldu. CLI'nin hangi akisi sectigi
/// onun kendi isi — prob ikisini de okur.
fn first_line_any_stream(stdout: &str, stderr: &str) -> Option<String> {
    first_line(stdout).or_else(|| first_line(stderr))
}

/// Yerel (Windows) bir CLI'nin ciktisini okur.
fn bin_probe(bin: &str, args: &[&str]) -> Option<String> {
    probe(std::process::Command::new(bin).args(args))
}

/// Motorun PATH'teki adi; tam yol gerekirse `SMITH_CODEX_BIN` ile ezilir
/// (motorlarla AYNI anahtar — panel ile motorun farkli surumu gostermesi
/// kabul edilemez).
fn codex_bin() -> String {
    std::env::var("SMITH_CODEX_BIN").unwrap_or_else(|_| "codex".to_string())
}

/// MOTOR NOBETI — panelin "is gucu" bolumu bunu cagirir.
///
/// Olculen kisitlar (2026-09-18) notlarda yazilidir; panel bunlari gizlemez:
/// Codex'in WSL'de kurulu olmasi yazma islerini mumkun kilar (Linux sandbox),
/// Windows'ta ise sandbox `workspace-write` altinda bile yazmayi reddediyor.
#[tauri::command]
pub fn dashboard_engines() -> Vec<EngineStatus> {
    let claude_wsl = wsl_probe(
        "command -v claude >/dev/null 2>&1 && timeout 8s claude --version 2>/dev/null || echo MISSING",
    );
    let codex_wsl = wsl_probe(
        "command -v codex >/dev/null 2>&1 && timeout 8s codex --version 2>/dev/null || echo MISSING",
    );
    let bin = codex_bin();
    let codex_win = bin_probe(&bin, &["--version"]);
    let codex_win_identity = bin_probe(&bin, &["login", "status"]);

    // Kullanilabilirlik, deger TASINMADAN once hesaplanir (surum alani option'i
    // sahiplenir).
    let claude_available = claude_wsl.is_some();
    let codex_wsl_available = codex_wsl.is_some();

    vec![
        EngineStatus {
            id: "claude-code".to_string(),
            label: "Claude Code".to_string(),
            host: "wsl".to_string(),
            available: claude_available,
            version: claude_wsl,
            identity: None,
            note: if claude_available {
                None
            } else {
                Some("WSL'de claude bulunamadi; kimlik kullanici eylemi (claude setup-token, ADR 0007).".to_string())
            },
        },
        EngineStatus {
            id: "codex".to_string(),
            label: "Codex (WSL)".to_string(),
            host: "wsl".to_string(),
            available: codex_wsl_available,
            version: codex_wsl,
            identity: None,
            // Not YALNIZ kurulu degilken gosterilir: kurulu bir motora
            // "kurulum gerekir" yazmak panelin yalan soylemesidir.
            note: if codex_wsl_available {
                None
            } else {
                Some(
                    "Yazma isleri icin dogru ev: WSL'de kurulum + giris gerekir (`bun add -g @openai/codex` && `codex login`).".to_string(),
                )
            },
        },
        EngineStatus {
            id: "codex".to_string(),
            label: "Codex (Windows)".to_string(),
            host: "windows".to_string(),
            available: codex_win.is_some(),
            version: codex_win,
            identity: codex_win_identity,
            // Olculdu (2026-09-18, CANLI mission kosusu): Windows sandbox'i komut
            // calistirmayi politika geregi reddediyor — OKUMA dahil ("blocked by
            // policy"). Yani bu hat yalniz metin ureten isler icin kullanilabilir;
            // dosya/komut isleri WSL motoruna aittir. Panel bunu "salt-okur" diye
            // yumusak soylemez: kullanici gercek siniri gorur.
            note: Some(
                "Olculdu: komut calistirma engelli (okuma dahil) — yalniz metin isleri; dosya isleri WSL motorunda.".to_string(),
            ),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rel_dotlari_cozer() {
        assert_eq!(normalize_rel("a/b/../c.md"), "a/c.md");
        assert_eq!(normalize_rel("./a//b.md"), "a/b.md");
        assert_eq!(normalize_rel("../../x.md"), "x.md");
    }

    #[test]
    fn scan_links_wiki_ve_md_hedeflerini_bulur() {
        let text =
            "bak [[Not Adi|takma]] ve [[#baslik]] ve [link](../a/b.md) ve [x](https://ornek.md)";
        let links = scan_links(text);
        assert!(links.contains(&"Not Adi".to_string()));
        assert!(links.contains(&"../a/b.md".to_string()));
        // http linki ALINMAZ; baslik-yalniz wiki bos sayilmaz.
        assert!(!links.iter().any(|l| l.starts_with("http")));
        assert!(!links.contains(&"".to_string()));
    }

    #[test]
    fn resolve_link_once_kok_sonra_goreli_sonra_ad() {
        let mut by_lower = HashMap::new();
        by_lower.insert(
            "vault/decisions/adr.md".to_string(),
            "vault/decisions/adr.md".to_string(),
        );
        by_lower.insert(
            "vault/gunler/gun.md".to_string(),
            "vault/gunler/gun.md".to_string(),
        );
        let mut by_base = HashMap::new();
        by_base.insert("adr.md".to_string(), "vault/decisions/adr.md".to_string());
        by_base.insert("gun.md".to_string(), "vault/gunler/gun.md".to_string());
        // kaynak VAULT koku
        assert_eq!(
            resolve_link("vault/x/y.md", "decisions/adr", &by_lower, &by_base).as_deref(),
            Some("vault/decisions/adr.md")
        );
        // kaynak dizine goreli ("../" cozulur)
        assert_eq!(
            resolve_link("vault/x/y.md", "../decisions/adr.md", &by_lower, &by_base).as_deref(),
            Some("vault/decisions/adr.md")
        );
        // dosya adi eslesmesi
        assert_eq!(
            resolve_link("vault/x/y.md", "gun", &by_lower, &by_base).as_deref(),
            Some("vault/gunler/gun.md")
        );
    }

    #[test]
    fn vault_siniri_dislananlardan_sonra_kalan_notlarla_dolar() {
        let root = gecici_dizin("vault-exclude");
        let acme = root.join("Acme");
        let globex = root.join("Globex");
        std::fs::create_dir_all(&acme).unwrap();
        std::fs::create_dir_all(&globex).unwrap();
        for index in 0..4 {
            std::fs::write(acme.join(format!("{index}.md")), "isveren").unwrap();
        }
        std::fs::write(globex.join("a.md"), "Globex A").unwrap();
        std::fs::write(globex.join("b.md"), "gizlenecek kelime").unwrap();
        std::fs::write(globex.join("c.md"), "Globex C").unwrap();

        let graph = build_vault_graph(
            &root,
            2,
            &ContextExclude::parse("obsidian:acme/*,kw:gizlenecek"),
        )
        .unwrap();

        let ids: Vec<&str> = graph.nodes.iter().map(|node| node.id.as_str()).collect();
        assert_eq!(ids, ["Globex/a.md", "Globex/c.md"]);
        assert!(graph
            .edges
            .iter()
            .all(|edge| !edge.from.contains("Acme") && !edge.to.contains("Acme")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn yol_politikasi_kok_icini_kabul_eder_disini_reddeder() {
        let base = std::env::temp_dir().join(format!("smith-dash-test-{}", std::process::id()));
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).expect("root olusturuldu");
        std::fs::create_dir_all(&outside).expect("outside olusturuldu");
        let file_inside = root.join("a.md");
        std::fs::write(&file_inside, "x").expect("dosya yazildi");
        let file_outside = outside.join("b.md");
        std::fs::write(&file_outside, "x").expect("dosya yazildi");

        let roots = vec![("test".to_string(), root.clone())];
        assert!(ensure_under_roots(&file_inside, &roots).is_ok());
        assert!(ensure_under_roots(&file_outside, &roots).is_err());
        // Henuz olmayan dosya: ust dizin kokun icinde ise kabul.
        assert!(ensure_under_roots(&root.join("yeni.md"), &roots).is_ok());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn kimlik_ciktisi_iki_akistan_da_okunur() {
        // Olculen vaka: `codex login status` stderr'e yazar.
        assert_eq!(
            first_line_any_stream("", "Logged in using ChatGPT\n"),
            Some("Logged in using ChatGPT".to_string())
        );
        assert_eq!(
            first_line_any_stream("codex-cli 0.153.4\n", "gurultu\n"),
            Some("codex-cli 0.153.4".to_string())
        );
        assert_eq!(first_line_any_stream("", ""), None);
    }

    #[test]
    fn motor_ciktisi_ayristirma() {
        // Bos satir ve MISSING isaretcisi "surum" sayilmaz: panelde
        // "MISSING" yazan bir surum kutusu, hatanin gorunmez hali olurdu.
        assert_eq!(
            first_line("\n  2.1.266 (Claude Code)\n"),
            Some("2.1.266 (Claude Code)".to_string())
        );
        assert_eq!(first_line("MISSING\n"), None);
        assert_eq!(first_line("\n\n"), None);
        assert_eq!(
            first_line("Logged in using ChatGPT"),
            Some("Logged in using ChatGPT".to_string())
        );
    }

    /// `codex login status` gibi CLI'lar kimligi stderr'e yazar: basarili
    /// cikista iki akis da okunur (deadline ve kota `run_bounded` testlerinde).
    #[cfg(windows)]
    #[test]
    fn motor_probu_stderr_ciktisini_da_okur() {
        assert_eq!(
            bin_probe("cmd.exe", &["/c", "echo kimlik 1>&2"]),
            Some("kimlik".to_string())
        );
    }

    /// Sifir disi cikis veya bulunamayan komut "motor yok" demektir.
    #[cfg(windows)]
    #[test]
    fn motor_probu_basarisiz_komutta_bos_doner() {
        assert_eq!(
            bin_probe("cmd.exe", &["/c", "echo hata 1>&2 & exit 3"]),
            None
        );
        assert_eq!(bin_probe("smith-olmayan-komut-1f3a.exe", &[]), None);
    }

    fn gecici_dizin(ad: &str) -> PathBuf {
        let dizin = std::env::temp_dir().join(format!(
            "smith-dash-{ad}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dizin).expect("gecici dizin");
        dizin
    }

    /// Eskiden sinirdan sonrasi SESSIZCE kesiliyordu; panel eksik listeyi tam saniyordu.
    #[test]
    fn dizin_listesi_sinir_asilinca_kesildigini_bildirir() {
        let dizin = gecici_dizin("liste-kesik");
        for i in 0..5 {
            std::fs::write(dizin.join(format!("dosya-{i}.txt")), "x").unwrap();
        }
        let kesik = list_dir(&dizin, 3).unwrap();
        assert!(kesik.truncated);
        assert_eq!(kesik.entries.len(), 3);
        assert_eq!(kesik.total, 5);
        assert_eq!(kesik.limit, 3);

        // Tam sinirda kesilmez: kesildi bayragi yalniz GERCEKTEN giris dusunce acilir.
        let tam = list_dir(&dizin, 5).unwrap();
        assert!(!tam.truncated);
        assert_eq!((tam.entries.len(), tam.total, tam.limit), (5, 5, 5));
        let bol = list_dir(&dizin, 100).unwrap();
        assert!(!bol.truncated);
        assert_eq!((bol.entries.len(), bol.total), (5, 5));

        // Arayuzun okudugu tel bicimi.
        let json = serde_json::to_value(&kesik).unwrap();
        assert_eq!(json["truncated"], true);
        assert_eq!(json["total"], 5);
        assert_eq!(json["limit"], 3);
        assert_eq!(json["entries"].as_array().map(Vec::len), Some(3));
        assert!(json["entries"][0]["mtimeMs"].is_i64());
        let _ = std::fs::remove_dir_all(&dizin);
    }

    /// Siralama kesilen kumeye uygulanir; dizinler once, ada gore.
    #[test]
    fn dizin_listesi_dizinleri_once_ve_ada_gore_siralar() {
        let dizin = gecici_dizin("liste-sira");
        std::fs::write(dizin.join("b.txt"), "x").unwrap();
        std::fs::create_dir(dizin.join("z-klasor")).unwrap();
        std::fs::write(dizin.join("A.txt"), "x").unwrap();
        let liste = list_dir(&dizin, 10).unwrap();
        let adlar: Vec<&str> = liste.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(adlar, ["z-klasor", "A.txt", "b.txt"]);
        let _ = std::fs::remove_dir_all(&dizin);
    }

    #[test]
    fn mtime_catisma_kapisi() {
        // Kapi davranisi dashboard_fs_write icinde; burada yalniz kanonik
        // hedefin var olmayan ust dizinde HATA verdigini dogruluyoruz —
        // "yazim yolu cozulemedi" sessizce basarili sayilmasin.
        let missing = std::env::temp_dir().join("smith-dash-yok-klasor-xyz/file.md");
        assert!(canonical_target(&missing).is_err());
    }

    /// Yazim yarida kesilirse (disk dolu, cokme) onceki icerik yerinde kalir ve
    /// gecici dosya birakilmaz; basarili yazim dosyayi tamamen degistirir.
    #[test]
    fn basarisiz_yazim_onceki_dosyayi_korur() {
        use std::io::Write;
        let dizin = std::env::temp_dir().join(format!(
            "smith-atomik-yazim-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dizin).unwrap();
        let yol = dizin.join("not.txt");
        std::fs::write(&yol, "onceki").unwrap();
        let sonuc = write_file(&yol, |dosya| {
            dosya.write_all(b"yarim")?;
            Err(std::io::Error::other("disk dolu"))
        });
        assert!(sonuc.is_err());
        assert_eq!(std::fs::read_to_string(&yol).unwrap(), "onceki");
        write_file(&yol, |dosya| dosya.write_all(b"tamam")).unwrap();
        assert_eq!(std::fs::read_to_string(&yol).unwrap(), "tamam");
        assert_eq!(
            std::fs::read_dir(&dizin).unwrap().count(),
            1,
            "gecici dosya kaldi"
        );
        let _ = std::fs::remove_dir_all(&dizin);
    }
}
