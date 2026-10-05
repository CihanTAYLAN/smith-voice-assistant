//! Source guard for the Windows WebView2 UI-thread deadlock. No GUI is started.
use std::path::Path;

// Blank comments and literals while preserving byte positions and delimiters.
fn code_only(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = bytes.to_vec();
    let mut i = 0;
    while i < bytes.len() {
        let start = i;
        if bytes[i..].starts_with(b"//") {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if bytes[i..].starts_with(b"/*") {
            i += 2;
            let mut depth = 1;
            while i < bytes.len() && depth > 0 {
                if bytes[i..].starts_with(b"/*") {
                    depth += 1;
                    i += 2;
                } else if bytes[i..].starts_with(b"*/") {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
        } else if bytes[i] == b'r' {
            let mut quote = i + 1;
            while bytes.get(quote) == Some(&b'#') {
                quote += 1;
            }
            if bytes.get(quote) != Some(&b'"') {
                i += 1;
                continue;
            }
            let end = format!("\"{}", "#".repeat(quote - i - 1));
            i = source[quote + 1..]
                .find(&end)
                .map_or(bytes.len(), |n| quote + 1 + n + end.len());
        } else if bytes[i] == b'"'
            || (bytes[i] == b'\''
                && (bytes.get(i + 2) == Some(&b'\'') || bytes.get(i + 1) == Some(&b'\\')))
        {
            let quote = bytes[i];
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' {
                    i = (i + 2).min(bytes.len());
                } else if bytes[i] == quote {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
        } else {
            i += 1;
            continue;
        }
        out[start..i].fill(b' ');
    }
    String::from_utf8(out).expect("blanked source stays UTF-8")
}

fn closing(code: &str, start: usize, open: u8, close: u8) -> usize {
    let mut depth = 0;
    for (i, byte) in code.bytes().enumerate().skip(start) {
        if byte == open {
            depth += 1;
        } else if byte == close {
            depth -= 1;
            if depth == 0 {
                return i;
            }
        }
    }
    panic!("unbalanced source at {start}");
}

fn without_spawned_tasks(code: &str) -> String {
    let mut out = code.as_bytes().to_vec();
    for marker in [
        "tauri::async_runtime::spawn(",
        "tauri::async_runtime::spawn_blocking(",
    ] {
        for (start, _) in code.match_indices(marker) {
            let open = start + marker.len() - 1;
            let end = closing(&code, open, b'(', b')');
            let argument = code[open + 1..end].trim_start();
            let prefixes: &[&str] = if marker.contains("spawn_blocking") {
                &["move ||", "||"]
            } else {
                &["async move", "async"]
            };
            let body = prefixes
                .iter()
                .find_map(|prefix| argument.strip_prefix(prefix))
                .map(str::trim_start);
            if let Some(body) = body.filter(|body| body.starts_with('{')) {
                let body_start = end - body.len();
                let body_end = closing(code, body_start, b'{', b'}');
                // Only the deferred body is safe, not eager argument evaluation
                // or method arguments after the async block.
                out[body_start..=body_end].fill(b' ');
            }
        }
    }
    String::from_utf8(out).expect("blanked source stays UTF-8")
}

fn creates_window(code: &str) -> bool {
    ["WebviewWindowBuilder::", "WindowBuilder::", "mission_open("]
        .iter()
        .any(|needle| code.contains(needle))
}

fn violations(source: &str) -> Vec<String> {
    let code = code_only(source);
    let mut errors = Vec::new();
    for (start, _) in code.match_indices("#[tauri::command") {
        let body = start + code[start..].find('{').expect("command body");
        let end = closing(&code, body, b'{', b'}');
        if !code[start..body].contains("async fn")
            && creates_window(&without_spawned_tasks(&code[body..=end]))
        {
            errors.push(format!("synchronous window command at byte {start}"));
        }
    }
    for marker in [
        ".on_menu_event(",
        ".on_tray_icon_event(",
        ".on_window_event(",
        ".setup(",
    ] {
        for (start, _) in code.match_indices(marker) {
            let open = start + marker.len() - 1;
            let end = closing(&code, open, b'(', b')');
            if creates_window(&without_spawned_tasks(&code[open..=end])) {
                errors.push(format!("window creation in {marker} at byte {start}"));
            }
        }
    }
    errors
}

fn check_tree(dir: &Path, errors: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).expect("source directory") {
        let path = entry.expect("source entry").path();
        if path.is_dir() {
            check_tree(&path, errors);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            let source = std::fs::read_to_string(&path).expect("Rust source");
            errors.extend(
                violations(&source)
                    .into_iter()
                    .map(|e| format!("{}: {e}", path.display())),
            );
        }
    }
}

#[test]
fn window_creation_never_blocks_ui_callbacks_or_sync_commands() {
    let mut errors = Vec::new();
    check_tree(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut errors,
    );
    assert!(errors.is_empty(), "{}", errors.join("\n"));
}

#[test]
fn guard_rejects_old_command_and_direct_event_creation() {
    assert_eq!(
        violations(
            "#[tauri::command] pub fn mission_open() { WebviewWindowBuilder::new().build(); }"
        )
        .len(),
        1
    );
    for event in [
        "on_menu_event",
        "on_tray_icon_event",
        "on_window_event",
        "setup",
    ] {
        assert_eq!(
            violations(&format!(
                "app.{event}(|a, e| {{ WebviewWindowBuilder::new().build(); }})"
            ))
            .len(),
            1
        );
        assert_eq!(
            violations(&format!("app.{event}(|a, e| {{ mission_open(a); }})")).len(),
            1
        );
        assert!(violations(&format!("app.{event}(|a, e| {{ tauri::async_runtime::spawn(async move {{ mission_open(a).await; }}); }})")).is_empty());
    }
    assert_eq!(
        violations("#[tauri::command] fn open() { tauri::window::WindowBuilder::new(); }").len(),
        1
    );
    assert!(violations(
        "#[tauri::command] async fn mission_open() { WebviewWindowBuilder::new().build(); }"
    )
    .is_empty());
}

#[test]
fn guard_ignores_literals_comments_and_checks_code_after_spawn() {
    assert!(violations(r##"#[tauri::command] fn example() { let s = r#"} WebviewWindowBuilder::new()"#; /* { */ }"##).is_empty());
    assert_eq!(violations("app.on_menu_event(|a, e| { tauri::async_runtime::spawn(async {}); WebviewWindowBuilder::new(); })").len(), 1);
}

#[test]
fn guard_checks_eager_spawn_arguments_and_code_after_test_modules() {
    assert_eq!(violations("app.on_menu_event(|a,e| { tauri::async_runtime::spawn({ WebviewWindowBuilder::new(); async {} }); })").len(), 1);
    assert_eq!(violations("#[cfg(test)] mod tests {} #[tauri::command] fn open() { WebviewWindowBuilder::new(); }").len(), 1);
    assert_eq!(violations("app.on_menu_event(|a,e| { tauri::async_runtime::spawn(async {}.inspect(WebviewWindowBuilder::new())); })").len(), 1);
    assert!(violations("app.on_menu_event(|a,e| { tauri::async_runtime::spawn_blocking(move || { WebviewWindowBuilder::new(); }); })").is_empty());
}
