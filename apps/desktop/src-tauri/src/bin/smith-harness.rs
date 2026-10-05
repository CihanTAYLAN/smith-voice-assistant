//! JSON CLI: aynı cihaz akışı UI olmadan çağrılabilir; dış entegrasyon sınırı.
use smith_desktop_lib::code_agent;

fn execute(args: &[String]) -> Result<serde_json::Value, String> {
    match args {
        [command, task_file] if command == "run" => {
            let task = std::fs::read_to_string(task_file).map_err(|e| e.to_string())?;
            Ok(code_agent::kod_gorevi_ver_bekle(&task, None))
        }
        [command, id] if command == "status" => code_agent::kosu_durumu(id),
        [command, id] if command == "verify" => code_agent::kosu_dogrula(id),
        _ => Err(
            "kullanim: smith-harness run <gorev-dosyasi> | status <run-id> | verify <run-id>"
                .into(),
        ),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = execute(&args);
    let (value, code) = match result {
        Ok(value) => {
            let failed = value.get("hata").is_some() || value["status"] == "blocked";
            (value, if failed { 1 } else { 0 })
        }
        Err(error) => (
            serde_json::json!({ "status": "blocked", "error": error }),
            1,
        ),
    };
    match serde_json::to_string(&value) {
        Ok(json) => println!("{json}"),
        Err(error) => {
            eprintln!("sonuc serilestirilemedi: {error}");
            std::process::exit(1);
        }
    }
    std::process::exit(code);
}
