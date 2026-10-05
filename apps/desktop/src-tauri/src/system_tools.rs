//! YEREL SISTEM ARACLARI — Smith'in kurulu oldugu makineye erisimi.
//!
//! Kullanici mandasi (2026-08-13): "client'in kurulu oldugu bilgisayardaki
//! butun kaynaklara erissin: terminal, uygulamalar, donanim, ses, her sey."
//!
//! NEDEN BURADA (gateway'de degil): bu araclar MAKINENIN USTUNDE calismak
//! zorunda. Gateway uzak/ayri bir surec; terminal ve donanim erisimi istemcinin
//! kendi ayricaliklariyla olur. Hafiza araclari gateway'e gider (tenancy tek
//! yerde kalsin), sistem araclari YERELDE kalir — ikisi ayni `ToolBridge`
//! arayuzunden cagrilir, model farki gormez.
//!
//! GUVENLIK MODELI (bilincli ve dar):
//! - Her cagri STDERR'e loglanir → kullanici ne yapildigini gorebilir. Komut
//!   metni inline token/parola tasiyabilir: loga `agent_sessions::maskele`'den
//!   gecmis haliyle yazilir (`log_komutu`).
//! - Komutlar timeout'la kosar (cagri basina, varsayilan 20 sn, `sure_sn` ile
//!   5-300 sn); asilirsa surec GERCEKTEN oldurulur ve reap edilir (bkz.
//!   `run_powershell_opts`). Pencere/GUI acan komutlar (`ShowDialog()`...)
//!   taninip zaman asimsiz, ayri surec olarak baslar; `arka_planda` isleri
//!   cikti dosyasina yazar ve `arka_plan_sonuc` ile sorulur.
//! - **Geri donussuz komutlar IKI ADIMLI ONAY ister** (ozyineli/zorlamali silme,
//!   kapatma, `git reset --hard`, Docker verisi silme; bkz.
//!   `DESTRUCTIVE_COMMANDS`): ilk cagri calistirmaz, model Cihan'a sorar, ayni
//!   komut `onay=true` ile gelirse kosar. Bu, "model yanlis anladi"
//!   senaryosunun geri donusu olmayan hasara donusmesini engeller.
//! - **Telafisiz ve guvenligi dusuren komutlar onayla BILE acilmaz**: disk/bolum
//!   bicimlendirme ve onyukleme (`DENIED_COMMANDS`, kelime tabanli) ile Defender
//!   ve guvenlik duvari kapatma, kullanici/yetki degistirme, yurutme politikasi
//!   (`DENIED`, metin tabanli); kullanici bunlari kendisi yapar.
//! - **Gizlilik kara listesi TEK KAYNAK**: `PRIVACY_DENY`. `file_read`,
//!   `file_search` ve `boot_context::sir_izi` ayni listeyi ithal eder.
//! - Cikti kirpilir (8 KB): model baglamini bir `Get-ChildItem -Recurse` cikti
//!   selinde bogmak hem pahali hem faydasiz.
//! - Elevation YOK: Smith kullanicinin yetkileriyle kosar, yonetici istemez.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::boot_context;

/// Cikti ust siniri — model baglamini korumak icin.
const MAX_OUTPUT: usize = 8 * 1024;
/// Dosya okumada ikili tespiti penceresi: ilk 1 KB'de NUL varsa metin degildir.
const IKILI_TESPIT_BAYT: usize = 1024;
/// Varsayilan komut zaman asimi. Cagri basina `PsOpts::timeout` ile daraltilir;
/// uzun surecler `arka_planda` ile calistirilir.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

// ---------------------------------------------------------------------------
// GIZLILIK KARA LISTESI — TEK KAYNAK
//
// ADR 0006'nin "ithal eder, kopyalamaz" ilkesi bugune kadar yalniz Python
// konnektorlerinde uygulanmisti. Rust tarafinda AYNI liste UC yerde
// kopyalanmisti: `file_read::DENY`, `file_search`'un `$skip`'i ve
// `boot_context::SECRET_MARKERS`. Kopyalanan bir guvenlik listesi kaymaya
// mahkumdur: biri guncellenir, digeri unutulur ve sizinti SESSIZCE acilir.
// Uc tuketici de artik asagidaki iki listeden okur.
//
// AYRIMIN GEREKCESI: uc listenin icerigi yalniz farkli degildi, TURU de
// farkliydi. `node_modules`/`target\` bir GUVENLIK siniri degil arama
// gurultusudur; onlari `boot_context`'in sir kapisina karistirmak kapinin
// anlamini bulandirirdi. Bu yuzden iki liste: `PRIVACY_DENY` (guvenlik
// siniri, uc tuketici) ve `SEARCH_NOISE` (alaka filtresi, yalniz arama).
// Hicbir desen dusurulmedi; `kara_liste_birlesimi_hicbir_deseni_kaybetmez`
// testi bunu tarihsel snapshot'lara karsi kanitlar.
// ---------------------------------------------------------------------------

/// Gizlilik/sir kara listesi. Kucuk harfe cevrilmis metinde `contains` aranir.
///
/// **HEPSI KUCUK HARF OLMAK ZORUNDA.** Bu bir uslup notu degil olculmus bir
/// hata: `boot_context`'te `"-----BEGIN"` ilk surumde BUYUK yazilmisti ve
/// `lower.contains(...)` hicbir zaman dogru donmuyordu — private key kapisi
/// TAMAMEN OLU koddu. `kara_liste_kucuk_harf` testi tekrarini engeller.
///
/// Kaynak isaretleri: **[B]** `boot_context::SECRET_MARKERS`,
/// **[R]** `file_read::DENY`, **[S]** `file_search` `$skip` (gizlilik kismi).
pub const PRIVACY_DENY: &[&str] = &[
    // -- sir izleri (metinde de yolda da anlamli) --
    "-----begin", // [B] private key/sertifika govdesi
    "password",   // [B]
    "parola",     // [B]
    "passwd",     // [B]
    "api key",    // [B]
    "apikey",     // [B]
    "api_key",    // [B]
    "secret",     // [B]
    "bearer ",    // [B] (sondaki bosluk bilincli: "bearercard" eslesmesin)
    "credential", // [B]
    // -- dosya/dizin izleri --
    ".env",       // [B] + [R] — [R]'deki desen `\.env` idi; `.env` onu KAPSAR
    "id_rsa",     // [B] + [R]
    "id_ed25519", // [B] + [R]
    ".pem",       // [B] + [R]
    "customers",  // [B] + [R] + [S] — musteri verisi (ADR 0004)
    "db-dumps",   // [B] + [R] + [S] — veritabani dokumu
];

/// Arama gurultusu — **guvenlik siniri DEGIL**, alaka filtresi.
///
/// Yalniz `file_search` kullanir: bu dizinler ya turetilmis (build ciktisi) ya
/// da sonucu bogan (bagimlilik agaci) yerlerdir. Eskiden PowerShell REGEX
/// parcalariydi (`'\.git\\'`); artik duz metin desenleridir ve kucuk harfli
/// yolda `Contains` ile aranir — Rust tarafiyla ayni semantik.
pub const SEARCH_NOISE: &[&str] = &[
    "node_modules",         // [S]
    ".git\\",               // [S] (eski regex `\.git\\` = duz metin ".git\")
    "target\\",             // [S]
    ".venv",                // [S]
    "docker-data",          // [S]
    "appdata\\local\\temp", // [S]
];

/// Metin gizlilik kara listesine takiliyor mu? (kucuk harfe cevirip arar)
pub fn privacy_denied(text: &str) -> bool {
    let lower = text.to_lowercase();
    PRIVACY_DENY.iter().any(|d| lower.contains(d))
}

/// `terminal_calistir` komut metninde aranan YOL desenleri: `(desen, sag_sinir)`.
///
/// NEDEN AYRI LISTE: `PRIVACY_DENY` iki turu karistirir. Dosya/dizin izleri
/// (`.env`, `customers`) bir komutta yol olarak gecer; sir KELIMELERI
/// (`password`, `bearer `) ise masum komutlarda da cikar (`Get-Credential`,
/// `-Password` parametresi) ve komut kapisinda kullanilamaz kilardi. Bu liste
/// `PRIVACY_DENY`in yol alt kumesidir; `terminal_deseni_ortak_listeden_turer`
/// testi her desenin ortak listeyle KAPSANDIGINI zorlar, yani liste ondan
/// bagimsiz kayamaz.
///
/// ESLESME KURALI: kucuk harfe cevrilmis komutta ALT DIZE aranir, jeton sinirina
/// bakilmaz. Boylece `C:\is\customers\a.txt` (desen jetonun ORTASINDA), `Type
/// CUSTOMERS\a` ve `secrets.json` (desenin ardindan harf gelir) yakalanir;
/// jeton basi arayan (`starts_with`) bir kapi bunlari kacirirdi. Tek istisna
/// `sag_sinir=true`: `.env` ardindan HARF/RAKAM gelirse baska bir sozcuktur
/// (`obj.environment`), o zaman eslesmez; `.env.local`, `.env"`, `.env_bak` ve
/// satir sonu eslesir. Desen noktayla basladigi icin `Get-ChildItem env:` ve
/// `pnpm run environment` zaten hic eslesmez. `nesne_erisimi_serbest=true`
/// (yalniz `.env`): SOLUNDA harf/rakam, SAGINDA `.` ya da `[` olan `.env` bir
/// dosya degil nesne erisimidir (`process.env.HOME`, `process.env['X']`) ve
/// eslesmez; `prod.env` (sag tarafta bosluk/satir sonu) hala eslesir.
///
/// `auth.json` YALNIZ bu listededir, `PRIVACY_DENY`de DEGIL: ortak liste alt
/// dize eslestirir ve `file_read`/`file_search`/`boot_context`un masum
/// `locales/en/auth.json` gibi dosyalari da gizlemesine yol acardi. Komut metninde
/// ise CLI oturum belgesi (`~/.codex/auth.json`) tek gercekci hedeftir.
///
/// SINIR: kara liste hiz kesicidir, kum havuzu degil. Parcalanmis sozcukler
/// (`'cust'+'omers'`) kapidan gecer; asil guvence cihaz sahibinin yetkisi ve
/// ses izi kapisidir (ADR 0003).
const KOMUT_YOL_DESENLERI: &[(&str, bool, bool)] = &[
    (".env", true, true),
    (".envrc", false, false), // `.env` + harf: sag sinir yuzunden ayri girdi
    ("customers", false, false),
    ("secret", false, false),
    ("id_rsa", false, false),
    ("id_ed25519", false, false),
    (".pem", false, false),
    ("db-dumps", false, false),
    ("auth.json", false, false), // yalniz terminalde (bkz. yukaridaki not)
    // `.credentials` (Claude) VE noktasiz `credentials` (`~/.aws/credentials`,
    // `~/.cargo/credentials.toml`): ortak listedeki `credential` ile tutarli.
    ("credentials", false, false),
];

/// Komut metni gizlilik yol desenlerinden birine takiliyor mu? Takilirsa
/// eslesen deseni dondurur.
fn komut_gizlilik_deseni(cmd: &str) -> Option<&'static str> {
    let lower = cmd.to_lowercase();
    KOMUT_YOL_DESENLERI
        .iter()
        .find_map(|&(desen, sag_sinir, nesne_erisimi_serbest)| {
            lower
                .match_indices(desen)
                .any(|(bas, _)| {
                    let sol = lower[..bas].chars().next_back();
                    let sag = lower[bas + desen.len()..].chars().next();
                    if nesne_erisimi_serbest
                        && sol.is_some_and(char::is_alphanumeric)
                        && matches!(sag, Some('.') | Some('['))
                    {
                        return false;
                    }
                    !sag_sinir || sag.is_none_or(|c| !c.is_alphanumeric())
                })
                .then_some(desen)
        })
}

/// `terminal_calistir` girisi: gizlilik kapisi + yikici komut onayi + PowerShell
/// kosusu.
///
/// ESKI ACIK: `file_read` kara listeyi uyguluyordu ama terminal uygulamiyordu;
/// ayni dosya `Get-Content C:\x\.env` ile okunabiliyordu, yani kapi bir
/// kapinin yaninda duran acik pencereydi. Kapi YALNIZ buradadir ve
/// `run_powershell_opts`te degildir: oradan `file_search` gibi ic cagrilar da
/// geciyor ve script'leri kara liste desenlerini METIN olarak tasiyor.
///
/// Sure vermeyen cagri bugunku 20 sn tavanini kullanir; komut basina sure icin
/// `terminal_calistir_sureli`.
pub fn terminal_calistir(cmd: &str, background: bool) -> serde_json::Value {
    terminal_calistir_sureli(cmd, background, None)
}

/// `terminal_calistir` + komut basina sure (`sure_sn`: 5..=300 sn, verilmezse
/// 20). Bu sure senkron kosu icindir; arka plan isleri ayri 30 dakika
/// (`SMITH_JOB_MAX_S`) ve 20 MiB kotasina tabidir. GUI kullaniciya birakilir.
///
/// Onay VERMEZ: yikici komut `onay_gerekiyor` doner (bkz.
/// `terminal_calistir_onayli`).
pub fn terminal_calistir_sureli(
    cmd: &str,
    background: bool,
    sure_sn: Option<u64>,
) -> serde_json::Value {
    terminal_calistir_onayli(cmd, background, sure_sn, false)
}

/// Sureli giris + iki adimli onay. `onay=true` yalniz AYNI komut daha once
/// `onay_gerekiyor` dondurduyse ise yarar (bkz. `onay_kapisi`).
///
/// SIRA (degismez): 1) gizlilik kapisi, 2) felaket kapisi (`denied_reason`:
/// onayla acilmaz), 3) yikici komut onayi, 4) pencere/GUI tespiti, 5) arka plan
/// isi, 6) sureli senkron kosu. Felaket kapisi 4-6'da `run_powershell_opts`/
/// `arka_plan_is_baslat_in` icinde de calisir (ic cagrilar da korunur). Onay
/// iki kapidan SONRA gelir: reddedilecek komut icin Cihan'a soru sorulmaz.
pub fn terminal_calistir_onayli(
    cmd: &str,
    background: bool,
    sure_sn: Option<u64>,
    onay: bool,
) -> serde_json::Value {
    terminal_sonucu(terminal_calistir_ham(cmd, background, sure_sn, onay))
}

fn terminal_calistir_ham(
    cmd: &str,
    background: bool,
    sure_sn: Option<u64>,
    onay: bool,
) -> serde_json::Value {
    if let Some(desen) = komut_gizlilik_deseni(cmd) {
        // Komut LOGLANMAZ: reddedilen yol musteri adi tasiyabilir.
        eprintln!("[sys] REDDEDILDI (gizlilik, desen '{desen}')");
        return serde_json::json!({
            "durum": "reddedildi",
            "hata": format!(
                "bu komut gizlilik kara listesindeki bir yola dokunuyor (desen: '{desen}': \
                 musteri verisi/sir) — calistirilmadi"
            )
        });
    }
    if let Some(reason) = denied_reason(cmd) {
        return reddedildi(cmd, reason);
    }
    if yikici_komut(cmd) && !onay_kapisi(cmd, onay) {
        eprintln!("[sys] ONAY GEREKIYOR: {}", log_komutu(cmd));
        return serde_json::json!({
            "durum": "onay_gerekiyor",
            "aciklama": "Bu komut kalici silme, sistem degisikligi veya kapatma yapabilir; \
                         Cihan'a sor ve yalniz acik onayindan sonra ayni komutu onay=true ile \
                         tekrar gonder."
        });
    }
    if pencere_acan_komut(cmd) {
        // `arka_planda` verilmemis olsa bile: ShowDialog() gibi cagrilar pencere
        // kapanana kadar bloklar ve zaman asimi sureci oldururdu (saha, 2026-10-01).
        let mut v = run_powershell_opts(
            cmd,
            PsOpts {
                background: true,
                pencere: true,
                ..PsOpts::default()
            },
        );
        if v.get("hata").is_none() {
            if let Some(ipucu) = pencere_ipucu(cmd) {
                v["ipucu"] = serde_json::json!(ipucu);
            }
        }
        return v;
    }
    if background {
        return arka_plan_is_baslat(cmd);
    }
    run_powershell_opts(
        cmd,
        PsOpts {
            timeout: sure_sinirla(sure_sn),
            ..PsOpts::default()
        },
    )
}

/// Basari yalniz tamamlanmis ve sifir cikis kodlu komut icindir.
/// Baslatma/iptal talebi komutun basardigina kanit degildir.
fn terminal_sonucu(mut v: serde_json::Value) -> serde_json::Value {
    let eski = v["durum"].as_str().unwrap_or("").to_owned();
    let kod = v["cikis_kodu"].as_i64();
    let durum = match eski.as_str() {
        "zaman_asimi" => "zaman_asimi",
        "reddedildi" => "reddedildi",
        "onay_gerekiyor" => "onay_gerekiyor",
        "calisiyor"
        | "arka planda calisiyor"
        | "arka planda baslatildi"
        | "pencere arka planda acildi"
        | "iptal_isteniyor" => "calisiyor",
        "" | "bitti" if kod == Some(0) && v.get("hata").is_none() => "bitti",
        _ => "hata",
    };
    if !eski.is_empty() && eski != durum {
        v["is_durumu"] = serde_json::json!(eski);
    }
    v["basarili"] = serde_json::json!(durum == "bitti");
    v["durum"] = serde_json::json!(durum);
    if durum == "zaman_asimi" {
        let not = "komut BITMEDI, sonucu yok; basari iddia etme";
        let aciklama = v["aciklama"].as_str().unwrap_or("");
        if !aciklama.contains(not) {
            v["aciklama"] = serde_json::json!(format!("{aciklama} {not}").trim());
        }
    }
    v
}

/// Komut basina sure alt/ust siniri (sn). Alt sinir: 1-2 sn'lik bir deger
/// PowerShell acilisini bile sigdirmaz. Ust sinir: sesli asistan bir komutu
/// dakikalarca bekleyemez; daha uzun isler `arka_planda` ile calisir.
const MIN_SURE_SN: u64 = 5;
const MAX_SURE_SN: u64 = 300;

/// Istenen sureyi `MIN_SURE_SN..=MAX_SURE_SN` araligina kirpar; verilmezse
/// bugunku varsayilan (20 sn).
fn sure_sinirla(sure_sn: Option<u64>) -> Duration {
    match sure_sn {
        None => DEFAULT_TIMEOUT,
        Some(s) => Duration::from_secs(s.clamp(MIN_SURE_SN, MAX_SURE_SN)),
    }
}

// ---------------------------------------------------------------------------
// PENCERE / GUI ACAN KOMUTLAR
//
// SAHA (2026-10-01, Smith konusma kaydi): "PowerShell ile bir pencere olustur,
// icine kaynak kullanimini yaz" dendi; model `$form.ShowDialog()` calistirdi.
// ShowDialog pencere kapanana kadar BLOKLAR; arac 20 sn'de sureci oldurdu ve
// modele zaman asimi hatasi dondu. Pencere kullaniciya gorunmustu ama kapandi;
// model bunu basarisizlik sayip sonraki her istekte "grafiksel pencere olusturma
// yetenegim yok" dedi. Kok neden: bloklayan GUI cagrisi ile "zaman asimi =
// basarisizlik" varsayiminin birlesmesi.
//
// Cozum: pencere acan komut TANINIR ve zaman asimsiz, Smith'in surec agacindan
// AYRI bir sureç olarak baslar; arac hemen "pencere arka planda acildi" doner.
// ---------------------------------------------------------------------------

/// `lower` icinde `ad` bir CAGRI olarak geciyor mu? (`ad`, istege bagli
/// bosluk, `(`) `.show` yalniz `.show(` ile eslesir; `.showdialog(` ya da
/// `git show` ile eslesmez.
fn cagri_var(lower: &str, ad: &str) -> bool {
    lower.match_indices(ad).any(|(bas, _)| {
        lower[bas + ad.len()..]
            .trim_start_matches([' ', '\t'])
            .starts_with('(')
    })
}

/// `lower` icinde `jeton` var ve ardindan harf/rakam/`_` gelmiyor mu? Tur
/// adlarinin uzantilarini ayirir: `windows.forms.form` eslesir,
/// `windows.forms.formborderstyle` eslesmez.
fn jeton_var(lower: &str, jeton: &str) -> bool {
    lower.match_indices(jeton).any(|(bas, _)| {
        lower[bas + jeton.len()..]
            .chars()
            .next()
            .is_none_or(|c| !(c.is_alphanumeric() || c == '_'))
    })
}

/// GUI derlemesi yukleniyor/anliliyor mu? (`.Show()` ve `Application.Run`
/// icin baglam kaniti: her `terminal` cagrisi taze bir PowerShell'dir, yani bir
/// `Form` ancak bu derlemelerden biri yuklenirse var olabilir.)
fn gui_isareti(lower: &str) -> bool {
    [
        "windows.forms",
        "presentationframework",
        "presentationcore",
        "windowsbase",
        "windows.window",
    ]
    .iter()
    .any(|i| lower.contains(i))
}

/// Komut bir pencere/dialog acip kapanmasini BEKLIYOR mu? (saf fonksiyon)
///
/// Taninanlar: `ShowDialog(`, `Out-GridView`, `MessageBox]::Show` (WPF ve
/// WinForms), `Interaction]::MsgBox/InputBox`, `WScript.Shell` `.Popup(`,
/// `System.Windows.Forms.Form` / `System.Windows.Window` / `XamlReader`
/// kurulumu ve GUI derlemesi baglaminda `.Show(` ile `Application]::Run(`.
/// GUI derlemesini yuklemek (`Clipboard`, `Screen`, `SendKeys`) TEK BASINA
/// pencere sayilmaz.
///
/// Yorum ve string icerigi yetki/sure degistiren bir GUI isareti sayilmaz.
fn pencere_acan_komut(cmd: &str) -> bool {
    let lower = powershell_kod(cmd).to_lowercase();
    if lower.split([';', '\n', '|', '{', '}']).any(|statement| {
        let tokens: Vec<_> = statement.split_whitespace().collect();
        tokens.contains(&"start-process") && tokens.contains(&"-wait")
    }) {
        return true;
    }
    const DOGRUDAN: &[&str] = &[
        "out-gridview",
        "messagebox]::show",
        "interaction]::msgbox",
        "interaction]::inputbox",
    ];
    if DOGRUDAN.iter().any(|d| lower.contains(d)) || cagri_var(&lower, ".showdialog") {
        return true;
    }
    if lower.contains("wscript.shell") && cagri_var(&lower, ".popup") {
        return true;
    }
    const KURULUM: &[&str] = &["forms.form", "windows.window", "windows.markup.xamlreader"];
    if KURULUM.iter().any(|j| jeton_var(&lower, j)) {
        return true;
    }
    gui_isareti(&lower) && (cagri_var(&lower, ".show") || cagri_var(&lower, "application]::run"))
}

/// `.Show()` mesaj dongusu CALISTIRMAZ: betik bitince pencere kapanir. Komut
/// bu durumdaysa modele cozumu soyleyen bir ipucu doner.
fn pencere_ipucu(cmd: &str) -> Option<&'static str> {
    let lower = powershell_kod(cmd).to_lowercase();
    let dongu = cagri_var(&lower, ".showdialog")
        || cagri_var(&lower, "application]::run")
        || cagri_var(&lower, "dispatcher]::run")
        || lower.contains("messagebox]::show")
        || lower.contains("out-gridview");
    (cagri_var(&lower, ".show") && gui_isareti(&lower) && !dongu).then_some(
        "Show() mesaj dongusu calistirmaz: betik bitince pencere kapanir. Pencerenin acik \
         kalmasi icin ShowDialog() veya [System.Windows.Forms.Application]::Run($form) kullan.",
    )
}

/// Yalniz siniflandirma icin lexer; betik aynen calistirilir. Stringlerin
/// interpolation'i da silinir: metin, ayrik surec izni icin kanit degildir.
/// Silinen bolumlerin yerini bosluk alir, iki ayri token birlesmez.
fn powershell_kod(script: &str) -> String {
    let chars: Vec<char> = script.chars().collect();
    let mut out = String::with_capacity(script.len());
    let mut i = 0;
    while i < chars.len() {
        let start = i;
        if chars[i] == '<' && chars.get(i + 1) == Some(&'#') {
            i += 2;
            let mut depth = 1;
            while i < chars.len() && depth > 0 {
                if chars[i] == '<' && chars.get(i + 1) == Some(&'#') {
                    depth += 1;
                    i += 2;
                } else if chars[i] == '#' && chars.get(i + 1) == Some(&'>') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
        } else if chars[i] == '#' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if chars[i] == '@' && matches!(chars.get(i + 1), Some('\'' | '"')) {
            let quote = chars[i + 1];
            i += 2;
            while i < chars.len() {
                if chars[i] == quote
                    && chars.get(i + 1) == Some(&'@')
                    && (i == 0 || chars[i - 1] == '\n')
                {
                    i += 2;
                    break;
                }
                i += 1;
            }
        } else if matches!(chars[i], '\'' | '"') {
            i = powershell_string_sonu(&chars, i);
        } else if chars[i] == '`' {
            // Kacirilmis # ve tirnak yeni yorum/string baslatmaz.
            out.push(' ');
            i += 1;
            if i < chars.len() {
                out.push(' ');
                i += 1;
            }
            continue;
        } else {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        for c in &chars[start..i] {
            out.push(if *c == '\n' { '\n' } else { ' ' });
        }
    }
    out
}

/// Expandable string icindeki $(...) ifadesi kendi string/comment kurallarina
/// sahiptir. Iteratif stack, LLM'in derin ic ice metninde Rust stack'ini tasirmaz.
fn powershell_string_sonu(chars: &[char], start: usize) -> usize {
    enum Katman {
        Metin(char),
        Ifade(usize),
    }
    let mut stack = vec![Katman::Metin(chars[start])];
    let mut i = start + 1;
    while i < chars.len() && !stack.is_empty() {
        match stack.last_mut().expect("katman") {
            Katman::Metin(quote) => {
                if *quote == '"' && chars[i] == '`' {
                    i = (i + 2).min(chars.len());
                } else if *quote == '"' && chars[i] == '$' && chars.get(i + 1) == Some(&'(') {
                    stack.push(Katman::Ifade(1));
                    i += 2;
                } else if chars[i] == *quote {
                    i += 1;
                    if chars.get(i) == Some(quote) {
                        i += 1;
                    } else {
                        stack.pop();
                    }
                } else {
                    i += 1;
                }
            }
            Katman::Ifade(depth) => {
                if chars[i] == '`' {
                    i = (i + 2).min(chars.len());
                } else if chars[i] == '@' && matches!(chars.get(i + 1), Some('\'' | '"')) {
                    let quote = chars[i + 1];
                    i += 2;
                    while i < chars.len() {
                        if chars[i] == quote
                            && chars.get(i + 1) == Some(&'@')
                            && chars[i - 1] == '\n'
                        {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                } else if chars[i] == '<' && chars.get(i + 1) == Some(&'#') {
                    let mut comments = 1;
                    i += 2;
                    while i < chars.len() && comments > 0 {
                        if chars[i] == '<' && chars.get(i + 1) == Some(&'#') {
                            comments += 1;
                            i += 2;
                        } else if chars[i] == '#' && chars.get(i + 1) == Some(&'>') {
                            comments -= 1;
                            i += 2;
                        } else {
                            i += 1;
                        }
                    }
                } else if chars[i] == '#' {
                    while i < chars.len() && chars[i] != '\n' {
                        i += 1;
                    }
                } else if matches!(chars[i], '\'' | '"') {
                    stack.push(Katman::Metin(chars[i]));
                    i += 1;
                } else if chars[i] == '(' {
                    *depth += 1;
                    i += 1;
                } else if chars[i] == ')' {
                    *depth -= 1;
                    i += 1;
                    if *depth == 0 {
                        stack.pop();
                    }
                } else {
                    i += 1;
                }
            }
        }
    }
    i
}

/// Ayri surec baslaticisinin (`cmd start`) bekleme tavani. `start` bekletmez;
/// bu yalnizca takilmaya karsi bir sigorta.
const AYRI_BASLATMA_SURESI: Duration = Duration::from_secs(10);

/// Betik cmd metni degildir: ortamdan okunur. Ilk hatayi (native stderr
/// dahil) en fazla 8 KB kaydeder; stdout atilir. Probe dizini kaldirilinca
/// uzun omurlu GUI yeni dosya yaratamaz. Hata yakalama yalniz bu GUI yolunda.
const AYRI_CAGRI: &str = "& ([scriptblock]::Create($env:SMITH_AYRI_GOZLEM))";
const AYRI_GOZLEM: &str = r#"
$ErrorActionPreference = 'Stop'
$probe = $env:SMITH_AYRI_PROBE
try {
    [IO.File]::WriteAllText(($probe + '/ready'), $PID.ToString())
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (-not [IO.File]::Exists(($probe + '/go'))) {
        if ($watch.Elapsed.TotalSeconds -ge 10) { exit 125 }
        Start-Sleep -Milliseconds 20
    }
    $script = [scriptblock]::Create($env:SMITH_AYRI_BETIK)
    $global:LASTEXITCODE = 0
    & $script 2>&1 | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) { throw $_ }
    }
    if ($LASTEXITCODE -ne 0) { throw ('cikis kodu ' + $LASTEXITCODE) }
} catch {
    $message = $_.ToString()
    if ($message.Length -gt 8192) { $message = $message.Substring(0,8192) }
    try { [IO.File]::WriteAllText(($probe + '/error'), $message) } catch { }
} finally {
    try { [IO.File]::WriteAllText(($probe + '/done'), '1') } catch { }
}
"#;

struct GuiProbe(PathBuf);
impl Drop for GuiProbe {
    fn drop(&mut self) {
        // Yalniz bu cagri icin yarattigimiz uc dosya ve bos dizin.
        for ad in ["ready", "go", "error", "done"] {
            let _ = std::fs::remove_file(self.0.join(ad));
        }
        let _ = std::fs::remove_dir(&self.0);
    }
}

/// Launcher cikisi basari kaniti degildir. Kabuk hazir olunca 1,5 sn hata
/// gozlemlenir; soguk PowerShell acilisi icin ayri, sinirli 10 sn pay vardir.
fn ayri_surec_baslat(shell: &Path, script: &str) -> Result<(), String> {
    let probe = GuiProbe(std::env::temp_dir().join(format!(
        "smith-gui-{}-{}",
        std::process::id(),
        yeni_is_id()
    )));
    std::fs::create_dir(&probe.0).map_err(|e| format!("hata kaydi acilamadi: {e}"))?;
    let mut command = Command::new("cmd.exe");
    command
        .args(["/c", "start", "", "/B"])
        .arg(shell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-STA",
            "-Command",
            AYRI_CAGRI,
        ])
        .env_remove("SMITH_KONTROLLU")
        .env("SMITH_AYRI_GOZLEM", AYRI_GOZLEM)
        .env("SMITH_AYRI_BETIK", script)
        .env("SMITH_AYRI_PROBE", &probe.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let child = command
        .spawn()
        .map_err(|e| format!("baslatici acilamadi: {e}"))?;
    let (status, timeout, _, _) = bekle_sinirli(child, AYRI_BASLATMA_SURESI)?;
    if timeout {
        return Err("baslatici zaman asimi; pencere acilmis olabilir".into());
    }
    if !status.is_some_and(|s| s.success()) {
        return Err("baslatici basarisiz".into());
    }
    let start = Instant::now();
    let mut ready = None;
    #[cfg(windows)]
    let mut process = None;
    loop {
        if let Ok(error) = dosya_kuyrugu(&probe.0.join("error"), MAX_OUTPUT) {
            return Err(error);
        }
        if ready.is_none() {
            if let Ok(pid) = std::fs::read_to_string(probe.0.join("ready")) {
                if let Ok(pid) = pid.parse::<u32>() {
                    #[cfg(windows)]
                    {
                        process = Some(is_agaci::surec_ac(pid).map_err(|e| e.to_string())?);
                    }
                    std::fs::write(probe.0.join("go"), "1").map_err(|e| e.to_string())?;
                    ready = Some(Instant::now());
                }
            }
        }
        #[cfg(windows)]
        if let Some(process) = &process {
            if let Some(code) = is_agaci::cikis_kodu(process).map_err(|e| e.to_string())? {
                if let Ok(e) = dosya_kuyrugu(&probe.0.join("error"), MAX_OUTPUT) {
                    return Err(e);
                }
                return if code == 0 {
                    Ok(())
                } else {
                    Err(format!("GUI betigi cikis kodu {code}"))
                };
            }
        }
        if ready.is_some_and(|t| t.elapsed() >= Duration::from_millis(1500)) {
            return Ok(());
        }
        if ready.is_none() && start.elapsed() >= AYRI_BASLATMA_SURESI {
            return Err("kabuk hazirligi dogrulanamadi; pencere acilmis olabilir".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn pencere_baslat(shell: &Path, script: &str) -> serde_json::Value {
    match ayri_surec_baslat(shell, script) {
        Ok(()) => serde_json::json!({
            "durum": "pencere arka planda acildi",
            "aciklama": "GUI komutu ayri surecte baslatildi; ilk 1,5 saniyede hata saptanmadi. Pencerenin gorunurlugu dogrulanmadi; kullanicinin gordugu sonucu esas al.",
        }),
        Err(e) => serde_json::json!({"hata": format!("pencere acilamadi: {}", clip(&e))}),
    }
}

// ---------------------------------------------------------------------------
// ARKA PLAN ISLERI
//
// SAHA (2026-10-02): "en buyuk veri nerede" -> `Get-ChildItem -Recurse |
// Measure-Object` 20 sn'de oldu, sonuc hic gelmedi, Smith sessiz kaldi.
// `arka_planda` onceden cikti toplamiyordu (boru dusuruluyordu): is calisir ama
// sonucu KIMSE goremezdi. Artik cikti `<veri koku>\jobs\job-<id>.out`
// dosyasina akar ve `arka_plan_sonuc(is_id)` durumu + son 8 KB'i verir.
//
// Dosya adi `job-<32 hex>.out`: log temizliginin `<ad>-yyyyMMdd.log` silme
// desenine UYMAZ. Bu dosyalarin temizligi de YALNIZ bu tam adla yapilir
// (`is_dosya_adindan_id`), joker degil: Windows'ta `?` sifir karakterle de
// eslesir ve baska dosyalari silmisti.
// ---------------------------------------------------------------------------

/// Eski is dosyalarinin silinme esigi.
const IS_DOSYASI_OMRU: Duration = Duration::from_secs(24 * 3600);
const MAX_ESZAMANLI_IS: usize = 4;
const MAX_IS_CIKTISI: usize = 20 * 1024 * 1024;

fn is_azami_suresi() -> Duration {
    // Sifir/gecersiz deger siniri kapatmaz. Bir is saklama omrunu asamaz.
    Duration::from_secs(
        std::env::var("SMITH_JOB_MAX_S")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|s| *s > 0)
            .unwrap_or(30 * 60)
            .min(IS_DOSYASI_OMRU.as_secs()),
    )
}

/// `is_id`: tam 32 KUCUK hex karakter. Yol ayiricisi, `.`, surucu ve uzunluk
/// oyunlari bu bicimle yapisal olarak imkansizdir (beyaz liste).
fn is_id_gecerli(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `job-<32 kucuk hex>.out` TAM adini cozer; baska hicbir ad eslesmez.
fn is_dosya_adindan_id(ad: &str) -> Option<&str> {
    let id = ad.strip_prefix("job-")?.strip_suffix(".out")?;
    is_id_gecerli(id).then_some(id)
}

/// Is dosyalarinin dizini: `<veri koku>\jobs` (kok: `crate::paths`). Kok
/// cozulemezse (ev dizini yok) gecici dizinin altindaki `smith\jobs`.
fn jobs_dizini() -> PathBuf {
    crate::paths::data_dir()
        .unwrap_or_else(|| std::env::temp_dir().join("smith"))
        .join("jobs")
}

/// Calisan/biten bir isin bellek kaydi. Cikis kodu surecin kendisinden gelir
/// (bekleyen is parcacigi yazar); Smith yeniden baslarsa kayit kaybolur ve
/// durum `bilinmiyor` olur, cikti dosyada kalir.
struct IsKaydi {
    basladi: Instant,
    pid: u32,
    dizin: PathBuf,
    iptal: std::sync::Arc<std::sync::atomic::AtomicBool>,
    bitti: std::sync::Mutex<Option<IsSonucu>>,
}

#[derive(Clone)]
struct IsSonucu {
    sure: Duration,
    kod: Option<i32>,
    durum: &'static str,
    hata: Option<String>,
}

type IsTablosu = std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<IsKaydi>>>;

fn isler() -> &'static IsTablosu {
    static TABLO: std::sync::OnceLock<IsTablosu> = std::sync::OnceLock::new();
    TABLO.get_or_init(Default::default)
}

/// 128 bit'lik benzersiz kimlik (32 hex). Guvenlik sirri degil, ayristirici:
/// sayac + zaman + surec no + `RandomState` anahtarlari.
pub(crate) fn yeni_is_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static SAYAC: AtomicU64 = AtomicU64::new(0);
    let sayac = SAYAC.fetch_add(1, Ordering::Relaxed);
    let nano = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let parca = |tuz: u64| {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(tuz);
        h.write_u128(nano);
        h.write_u64(sayac);
        h.write_u32(std::process::id());
        h.finish()
    };
    format!("{:016x}{:016x}", parca(1), parca(2))
}

/// `arka_planda=true` komutunu baslatir: cikti `job-<id>.out`a akar, arac
/// HEMEN `is_id` doner. Felaket kapisi burada da calisir.
fn arka_plan_is_baslat(cmd: &str) -> serde_json::Value {
    static TEMIZLIK: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
    if temizlik_zamani_geldi(
        &mut TEMIZLIK.lock().unwrap_or_else(|e| e.into_inner()),
        Instant::now(),
    ) {
        eski_isleri_temizle();
    }
    arka_plan_is_baslat_in(&jobs_dizini(), cmd)
}

fn temizlik_zamani_geldi(son: &mut Option<Instant>, simdi: Instant) -> bool {
    if son.is_none_or(|t| simdi.saturating_duration_since(t) >= Duration::from_secs(3600)) {
        *son = Some(simdi);
        true
    } else {
        false
    }
}

fn arka_plan_is_baslat_in(dizin: &Path, cmd: &str) -> serde_json::Value {
    terminal_sonucu(arka_plan_is_baslat_in_ham(dizin, cmd))
}

fn arka_plan_is_baslat_in_ham(dizin: &Path, cmd: &str) -> serde_json::Value {
    if let Some(reason) = denied_reason(cmd) {
        return reddedildi(cmd, reason);
    }
    // Sayma + spawn + kayit tek kilit altinda: paralel cagrilar tavan asamaz.
    let mut tablo = isler().lock().unwrap_or_else(|e| e.into_inner());
    if tablo
        .values()
        .filter(|k| k.bitti.lock().unwrap_or_else(|e| e.into_inner()).is_none())
        .count()
        >= MAX_ESZAMANLI_IS
    {
        return serde_json::json!({"hata": "en fazla 4 arka plan isi ayni anda calisabilir"});
    }
    if let Err(e) = std::fs::create_dir_all(dizin) {
        return serde_json::json!({ "hata": format!("is dizini acilamadi: {e}") });
    }
    let is_id = yeni_is_id();
    let yol = dizin.join(format!("job-{is_id}.out"));
    let dosya = match std::fs::File::create(&yol) {
        Ok(f) => f,
        Err(e) => return serde_json::json!({ "hata": format!("is dosyasi acilamadi: {e}") }),
    };
    eprintln!(
        "[sys] terminal (arka plan, is {is_id}): {}",
        log_komutu(cmd)
    );
    let (_, _, mut command) = ps_hazirla(cmd);
    let (child, agac) = match kontrollu_baslat(&mut command) {
        Ok(c) => c,
        Err(e) => {
            drop(dosya);
            let _ = std::fs::remove_file(&yol);
            return serde_json::json!({ "hata": format!("baslatilamadi: {e}") });
        }
    };
    let kayit = std::sync::Arc::new(IsKaydi {
        basladi: Instant::now(),
        pid: child.id(),
        dizin: dizin.to_path_buf(),
        iptal: Default::default(),
        bitti: std::sync::Mutex::new(None),
    });
    tablo.insert(is_id.clone(), kayit.clone());
    drop(tablo);
    let pid = kayit.pid;
    let timeout = is_azami_suresi();
    let izleyici_id = is_id.clone();
    let cikti_yolu = yol.clone();
    let monitor = std::thread::Builder::new()
        .name(format!("smith-job-{is_id}"))
        .spawn(move || {
            let (sonuc, _, _) = sureci_izle(child, timeout, Some(dosya), kayit.iptal.clone(), agac);
            isi_kapat(
                &kayit,
                &izleyici_id,
                &cikti_yolu,
                sonuc,
                crate::audio::sistem_bildirimi,
            );
        });
    if let Err(e) = monitor {
        // Closure dusunce Job Object surec agacini kapatir.
        isler()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&is_id);
        let _ = std::fs::remove_file(&yol);
        return serde_json::json!({"hata": format!("is izleyicisi baslatilamadi: {e}")});
    }
    serde_json::json!({
        "is_id": is_id,
        "durum": "arka planda calisiyor",
        "pid": pid,
        "sonuc_icin": "Sonucu ogrenmek icin arka_plan_sonuc aracini bu is_id ile cagir.",
    })
}

/// Dosyanin SON `sinir` baytini metin olarak okur (kuyruk: bitisteki sonuc ve
/// hata en degerli kisimdir). Kirpilirsa basa not eklenir; kesilen coklu bayt
/// karakterin artigi atilir.
fn dosya_kuyrugu(yol: &Path, sinir: usize) -> std::io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(yol)?;
    let boy = f.metadata()?.len();
    let baslangic = boy.saturating_sub(sinir as u64);
    f.seek(SeekFrom::Start(baslangic))?;
    let mut buf = Vec::new();
    f.take(sinir as u64).read_to_end(&mut buf)?;
    let mut atlanan = 0;
    if baslangic > 0 {
        while atlanan < buf.len() && (buf[atlanan] & 0xC0) == 0x80 {
            atlanan += 1;
        }
    }
    let metin = String::from_utf8_lossy(&buf[atlanan..]);
    let metin = metin.trim();
    Ok(if baslangic > 0 {
        format!(
            "…[ilk {} bayt kirpildi]\n{metin}",
            baslangic + atlanan as u64
        )
    } else {
        metin.to_string()
    })
}

fn saniye_yuvarla(d: Duration) -> f64 {
    (d.as_secs_f64() * 10.0).round() / 10.0
}

/// Biten isin ham sonuc nesnesi (`arka_plan_sonuc` yaniti ve bitis bildirimi
/// ayni kaynaktan beslenir).
fn is_sonucu_json(son: &IsSonucu) -> serde_json::Value {
    let mut v = serde_json::json!({
        "durum": son.durum,
        "gecen_sn": saniye_yuvarla(son.sure),
    });
    // Cikis kodu alinamadiysa (sinyalle olum) alan YOK, uydurulmaz.
    if let Some(kod) = son.kod {
        v["cikis_kodu"] = serde_json::json!(kod);
    }
    if let Some(hata) = &son.hata {
        v["hata"] = serde_json::json!(hata);
    }
    v
}

/// Bitis bildirimi ozetinin karakter siniri ve ozet icin okunan cikti kuyrugu.
/// Maskeleme kuyrugun TAMAMINA uygulanir, kirpma ondan sonra yapilir: kirpma
/// bir sirri ortadan bolup maskeleme desenini kacirmasin.
const BILDIRIM_OZET_KARAKTER: usize = 300;
const BILDIRIM_KUYRUK_BAYT: usize = 2048;

/// Cikti metnini bildirim ozetine cevirir: maskeli, tek satir, en fazla
/// `BILDIRIM_OZET_KARAKTER` (sonuc ve hata sondadir, kirpilirsa bas kesilir).
/// `log_komutu` ortak maskele filtresidir: komut metni gibi cikti da inline
/// token ya da parola tasiyabilir.
fn bildirim_ozeti(metin: &str) -> String {
    let tek = log_komutu(metin)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let toplam = tek.chars().count();
    if toplam <= BILDIRIM_OZET_KARAKTER {
        return tek;
    }
    let son: String = tek
        .chars()
        .skip(toplam - (BILDIRIM_OZET_KARAKTER - 3))
        .collect();
    format!("...{}", son.trim_start())
}

/// Is bitince oturuma giden sistem bildirimi govdesi (`[Sistem bildirimi]`
/// etiketini kanal ekler). Iptal edilen is icin `None`: kullanici zaten durdurdu.
/// `kuyruk` cikti dosyasinin sonudur; ozet yoksa cikis kodu, o da yoksa hata metni.
fn bitis_bildirimi(is_id: &str, sonuc: &IsSonucu, kuyruk: &str) -> Option<String> {
    if sonuc.durum == "iptal" {
        return None;
    }
    let durum = match terminal_sonucu(is_sonucu_json(sonuc))["durum"].as_str() {
        Some("bitti") => "basarili",
        Some("zaman_asimi") => "zaman asimi",
        _ => "hata",
    };
    let ayrinti = [
        bildirim_ozeti(kuyruk),
        sonuc
            .kod
            .map(|k| format!("cikis kodu {k}"))
            .unwrap_or_default(),
        sonuc
            .hata
            .as_deref()
            .map(bildirim_ozeti)
            .unwrap_or_default(),
    ]
    .into_iter()
    .find(|s| !s.is_empty())
    .unwrap_or_else(|| "cikti yok".into());
    Some(format!(
        "Arka plan isi {is_id} bitti: {durum}, {}. Sonucu Cihan'a bildir.",
        ayrinti.trim_end_matches('.')
    ))
}

/// Izleyici thread'inin bitis adimi: sonucu kayda yazar (`arka_plan_sonuc` hemen
/// `bitti` gorur), SONRA bildirimi verir. `bildir` testte yakalanir, uretimde
/// `audio::sistem_bildirimi`dir.
fn isi_kapat(
    kayit: &IsKaydi,
    is_id: &str,
    cikti_yolu: &Path,
    sonuc: IsSonucu,
    bildir: impl FnOnce(String),
) {
    let kuyruk = dosya_kuyrugu(cikti_yolu, BILDIRIM_KUYRUK_BAYT).unwrap_or_default();
    let bildirim = bitis_bildirimi(is_id, &sonuc, &kuyruk);
    *kayit.bitti.lock().unwrap_or_else(|e| e.into_inner()) = Some(sonuc);
    if let Some(metin) = bildirim {
        bildir(metin);
    }
}

/// Durum: calisiyor, bitti, zaman_asimi, cikti_kotasi, iptal, hata,
/// durdurma_hatasi veya bilinmiyor. Son 8 KB cikti ve gecen sure korunur.
pub fn arka_plan_sonuc(is_id: &str) -> serde_json::Value {
    arka_plan_sonuc_in(&jobs_dizini(), is_id)
}

/// Yalniz bu Smith surecinin izledigi isi iptal eder. PID ile yeniden arama
/// yapmaz: bildirim child handle'ini elinde tutan izleyiciye gider.
pub fn arka_plan_iptal(is_id: &str) -> serde_json::Value {
    terminal_sonucu(arka_plan_iptal_ham(is_id))
}

fn arka_plan_iptal_ham(is_id: &str) -> serde_json::Value {
    if !is_id_gecerli(is_id) {
        return serde_json::json!({"hata": "is_id gecersiz"});
    }
    let kayit = isler()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(is_id)
        .cloned();
    let Some(kayit) = kayit else {
        return serde_json::json!({"hata": "izlenen is bulunamadi"});
    };
    if let Some(sonuc) = kayit
        .bitti
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        return serde_json::json!({"is_id": is_id, "durum": sonuc.durum, "cikis_kodu": sonuc.kod});
    }
    kayit
        .iptal
        .store(true, std::sync::atomic::Ordering::Release);
    serde_json::json!({"is_id": is_id, "durum": "iptal_isteniyor"})
}

fn arka_plan_sonuc_in(dizin: &Path, is_id: &str) -> serde_json::Value {
    terminal_sonucu(arka_plan_sonuc_in_ham(dizin, is_id))
}

fn arka_plan_sonuc_in_ham(dizin: &Path, is_id: &str) -> serde_json::Value {
    let is_id = is_id.trim();
    if !is_id_gecerli(is_id) {
        // Girdi YANKILANMAZ: gecersiz is_id yol/kontrol karakteri tasiyabilir.
        return serde_json::json!({
            "hata": "is_id gecersiz: arka planda baslatma sonucundaki is_id aynen verilmeli \
                     (32 karakter, kucuk harf ve rakam)"
        });
    }
    let yol = dizin.join(format!("job-{is_id}.out"));
    let cikti = match dosya_kuyrugu(&yol, MAX_OUTPUT) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return serde_json::json!({
                "hata": format!(
                    "is bulunamadi (is_id: {is_id}): yanlis kimlik ya da 24 saati asan is \
                     temizlendi"
                )
            });
        }
        Err(e) => return serde_json::json!({ "hata": format!("is ciktisi okunamadi: {e}") }),
    };
    let kayit = isler()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(is_id)
        .cloned();
    let mut sonuc = match kayit {
        Some(k) => match k.bitti.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            Some(son) => is_sonucu_json(&son),
            None => serde_json::json!({
                "durum": "calisiyor",
                "gecen_sn": saniye_yuvarla(k.basladi.elapsed()),
            }),
        },
        None => serde_json::json!({
            "durum": "bilinmiyor",
            "aciklama": "Smith yeniden basladigi icin surecin durumu izlenemiyor; cikti dosyadaki \
                         son halidir. Cikti buyuyorsa is suruyor olabilir.",
        }),
    };
    sonuc["is_id"] = serde_json::json!(is_id);
    sonuc["cikti"] = serde_json::json!(cikti);
    sonuc
}

/// 24 saatten eski is dosyalarini siler (`job-<32 hex>.out` TAM adi) ve bellek
/// kayitlarini budar. Yeni islerde saatte en fazla bir kez calisir; baslangicta
/// elle de cagrilabilir. Silinen dosya sayisini doner.
pub fn eski_isleri_temizle() -> usize {
    eski_isleri_temizle_in(&jobs_dizini(), IS_DOSYASI_OMRU)
}

fn eski_isleri_temizle_in(dizin: &Path, esik: Duration) -> usize {
    let mut tablo = isler().lock().unwrap_or_else(|e| e.into_inner());
    tablo.retain(|_, k| {
        k.dizin != dizin
            || k.basladi.elapsed() < esik
            || k.bitti.lock().unwrap_or_else(|e| e.into_inner()).is_none()
    });
    let Ok(girdiler) = std::fs::read_dir(dizin) else {
        return 0;
    };
    let mut silinen = 0;
    for girdi in girdiler.flatten() {
        let ad = girdi.file_name();
        // Yalniz TAM ad deseni; baska hicbir dosyaya dokunulmaz.
        if ad.to_str().and_then(is_dosya_adindan_id).is_none() {
            continue;
        }
        if ad
            .to_str()
            .and_then(is_dosya_adindan_id)
            .and_then(|id| tablo.get(id))
            .is_some_and(|k| k.bitti.lock().unwrap_or_else(|e| e.into_inner()).is_none())
        {
            continue;
        }
        let Ok(meta) = girdi.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let eski = meta
            .modified()
            .ok()
            .and_then(|m| m.elapsed().ok())
            .is_some_and(|gecen| gecen >= esik);
        if eski && std::fs::remove_file(girdi.path()).is_ok() {
            silinen += 1;
        }
    }
    silinen
}

// ---------------------------------------------------------------------------
// GERI DONUSSUZ KOMUTLAR: IKI ADIMLI ONAY ve KATI RET
//
// Eski tasarim bu siniflari metin kara listesiyle REDDEDIYORDU ve liste
// `Remove-Item -LiteralPath 'C:\Users\x\Documents' -Recurse -Force` gibi her
// gunluk yazimi kacirdi: belgeler kalici silinirdi. Simdi iki sinif var; ikisi
// de KELIME tabanli ve ayni ayristiriciyi (`komut_kelimeleri`) kullanir:
//   * `DESTRUCTIVE_COMMANDS` + `DELETE_COMMANDS`: terminal aracinda iki adimli
//     onay ister. Ilk cagri calistirmaz, model Cihan'a sorar, ayni komut
//     `onay=true` ile gelirse kosar.
//   * `DENIED_COMMANDS`: disk/bolum bicimlendirme ve onyukleme. Onay model
//     aracili ve bu kalemlerde hata telafisiz oldugu icin onayla BILE acilmaz.
// Listeler hiz kesicidir, kum havuzu degil (bkz. `KOMUT_YOL_DESENLERI` notu):
// asil guvence cihaz sahibinin yetkisi ve ses izi kapisidir (ADR 0003).
// ---------------------------------------------------------------------------

/// Her kullanimda onay isteyen komutlar: `(komut, ek kelimeler)`. Komut adi bir
/// KELIME olarak gecerse ve ek kelimelerin HEPSI ardindan gelirse eslesir
/// (`git -C x clean -fdx` = `git` + `clean`; `cipher /w:C:\` = `cipher` + `/w`).
///
/// Kapatma kalemleri eskiden `DENIED`de (kati red) idi, simdi onayla kosar; disk
/// ve onyukleme kalemleri `DENIED_COMMANDS`te kati red olarak KALDI. Docker
/// kalemleri veri kaybi sinifidir: `prune` ve `down` baglanmamis volume'lari,
/// `volume rm` isimli olani siler. `dd` yalniz `of=` ile yikicidir
/// (`Get-Date -Format dd` masum); `wsl --unregister` dagitimi, `--shutdown`
/// calisan tum WSL oturumlarini oldurur.
const DESTRUCTIVE_COMMANDS: &[(&str, &[&str])] = &[
    // Kalici veri kaybi
    ("clear-recyclebin", &[]),
    ("cipher", &["/w"]),
    ("sdelete", &[]),
    ("shred", &[]),
    ("dd", &["of"]),
    ("vssadmin", &["delete"]),
    ("wevtutil", &["cl"]),
    ("reg", &["delete"]),
    ("git", &["clean"]),
    ("git", &["reset", "--hard"]),
    ("docker", &["prune"]),
    ("docker", &["volume", "rm"]),
    ("docker", &["down"]),
    ("docker-compose", &["down"]),
    ("wsl", &["--unregister"]),
    // Kapatma
    ("stop-computer", &[]),
    ("restart-computer", &[]),
    ("shutdown", &[]),
    ("wsl", &["--shutdown"]),
];

/// Silme komutlari: YALNIZ ozyineli/zorlamali kullanimda onay ister
/// (`silme_bayragi`). Bayraksiz tek dosya silme serbest kalir: sik bir is ve
/// asistanin ise yaramasi icin gerekli.
const DELETE_COMMANDS: &[&str] = &["remove-item", "ri", "rm", "del", "erase", "rd", "rmdir"];

/// Komut metnini kucuk harfli KELIMELERE boler: bosluk, tirnak ve PowerShell
/// ayiraclari kelimeyi keser (`$x=Remove-Item`, `& 'format.com'`, `{ rm x -r }`),
/// backtick (kacis) atilir. Onay ve kati ret siniflarinin TEK ayristiricisi.
fn komut_kelimeleri(cmd: &str) -> Vec<String> {
    cmd.to_ascii_lowercase()
        .replace('`', "")
        .split(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    '\'' | '"' | ';' | '|' | '&' | '(' | ')' | '{' | '}' | ',' | '='
                )
        })
        .filter(|kelime| !kelime.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `tablo`daki hangi komut sinifi bu kelimelerde var? Komut adi bir KELIME olarak
/// gecerse ve ek kelimelerin HEPSI ardindan gelirse eslesir; eslesen komut adini
/// doner (ret metni icin). Komutun GERCEK konumunu cozmeye calismaz, yani
/// `Get-Help rm -r` de eslesir: yanlis pozitifin bedeli onay sinifinda bir soru,
/// yanlis negatifinki veri kaybidir.
fn komut_sinifi(kelimeler: &[String], tablo: &[(&'static str, &[&str])]) -> Option<&'static str> {
    kelimeler.iter().enumerate().find_map(|(i, kelime)| {
        let ad = komut_adi(kelime);
        let sonrasi = &kelimeler[i + 1..];
        tablo
            .iter()
            .find(|(komut, ekler)| {
                *komut == ad && ekler.iter().all(|ek| ek_kelime_var(sonrasi, ek))
            })
            .map(|(komut, _)| *komut)
    })
}

/// Komut onay gerektiren yikici bir sinifa giriyor mu? Silme komutlari yalniz
/// ozyineli/zorlamali bayrakla (`silme_bayragi`), digerleri `DESTRUCTIVE_COMMANDS`
/// ile eslesir.
fn yikici_komut(cmd: &str) -> bool {
    let kelimeler = komut_kelimeleri(cmd);
    let silme = kelimeler.iter().any(|kelime| silme_bayragi(kelime))
        && kelimeler
            .iter()
            .any(|kelime| DELETE_COMMANDS.contains(&komut_adi(kelime)));
    silme || komut_sinifi(&kelimeler, DESTRUCTIVE_COMMANDS).is_some()
}

/// `C:\Windows\System32\format.com` -> `format`; `Modul\Remove-Item` -> `remove-item`.
fn komut_adi(kelime: &str) -> &str {
    let ad = kelime.rsplit(['/', '\\']).next().unwrap_or(kelime);
    [".exe", ".cmd", ".com", ".bat"]
        .iter()
        .find_map(|uzanti| ad.strip_suffix(uzanti))
        .unwrap_or(ad)
}

/// Komut sinifi tablosunda ek-kelime yerine yazilan ozel deger: "HEMEN sonraki
/// kelime bir birim veya `format` anahtari olmali" (`birim_veya_anahtar`).
const BIRIM: &str = "<birim>";

/// `ek` kelimelerin arasinda mi? `/x` anahtarlari `:deger` ekli de eslesir
/// (`cipher /w:C:\`). `BIRIM` ozel degeri yalniz HEMEN sonraki kelimeye bakar.
fn ek_kelime_var(kelimeler: &[String], ek: &str) -> bool {
    if ek == BIRIM {
        return kelimeler
            .first()
            .is_some_and(|kelime| birim_veya_anahtar(kelime));
    }
    kelimeler.iter().any(|kelime| {
        kelime == ek
            || (ek.starts_with('/')
                && kelime
                    .strip_prefix(ek)
                    .is_some_and(|geri| geri.starts_with(':')))
    })
}

/// `format`in hemen ardindan gelen kelime bir birim (`c:`, `c:\`, `\\.\...`) veya
/// `format.com` anahtari (`/q`, `/fs:ntfs`, `/v:ad`: en fazla iki harf) mi? Gercek
/// `format` her zaman bir birim ister; duz yazidaki `format` kelimesi
/// (`Select-String format`, `rg format src`) disk bicimlendirme DEGILDIR ve onay
/// yolu olmayan kati ret'e takilmamali.
fn birim_veya_anahtar(kelime: &str) -> bool {
    let surucu = matches!(
        kelime.as_bytes(),
        [harf, b':'] | [harf, b':', b'\\' | b'/'] if harf.is_ascii_alphabetic()
    );
    let anahtar = kelime.strip_prefix('/').is_some_and(|ad| {
        let ad = ad.split(':').next().unwrap_or_default();
        (1..=2).contains(&ad.len()) && ad.bytes().all(|b| b.is_ascii_alphabetic())
    });
    surucu || anahtar || kelime.starts_with("\\\\")
}

/// Silmeyi ozyineli/zorlamali yapan bayrak mi? PowerShell `-Recurse`/`-Force` ve
/// benzersiz kisaltmalari (`-r`, `-fo`), GNU `--recursive`, unix `-rf`, cmd
/// `/s /q /f`. Yalniz `-` veya `/` ile baslayan kelimeler bayraktir.
fn silme_bayragi(kelime: &str) -> bool {
    let Some(bayrak) = kelime.strip_prefix(['-', '/']) else {
        return false;
    };
    let bayrak = bayrak.trim_start_matches('-');
    let bayrak = bayrak.split(':').next().unwrap_or_default(); // -Recurse:$true
    let kisaltma = ["recurse", "recursive", "force"]
        .iter()
        .any(|uzun| uzun.starts_with(bayrak));
    // `-rf`, `-fr`, `/s`, `/q`: kisa harf demetleri.
    let demet = bayrak.len() <= 4
        && bayrak.bytes().all(|b| b.is_ascii_alphabetic())
        && bayrak.bytes().any(|b| b"rfsq".contains(&b));
    !bayrak.is_empty() && (kisaltma || demet)
}

/// Onay bekleyen komut metinleri ve ilk istenme anlari.
type BekleyenOnaylar = std::sync::Mutex<std::collections::HashMap<String, Instant>>;
/// Bir onayin gecerli kaldigi sure; sonra komut yeniden sorulur.
const ONAY_SURESI: Duration = Duration::from_secs(300);
/// Ayni anda bekleyen onay tavani (bellek siniri); asilirsa liste sifirlanir.
const ONAY_TAVANI: usize = 32;

/// Iki adimli onay. Ilk cagri komutu KAYDEDER ve `false` doner (komut
/// calismaz); AYNI komut metni `onay=true` ile `ONAY_SURESI` icinde gelirse
/// BIR KEZ `true` doner. `onay=true` ile gelen ILK cagri da calistirmaz: model
/// onayi pesinen veremez, once `onay_gerekiyor` yanitini almis olmali.
fn onay_kapisi(cmd: &str, onay: bool) -> bool {
    static BEKLEYEN: std::sync::OnceLock<BekleyenOnaylar> = std::sync::OnceLock::new();
    let mut bekleyen = BEKLEYEN
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    bekleyen.retain(|_, an| an.elapsed() < ONAY_SURESI);
    if onay && bekleyen.remove(cmd).is_some() {
        return true;
    }
    if bekleyen.len() >= ONAY_TAVANI {
        bekleyen.clear();
    }
    bekleyen.insert(cmd.to_owned(), Instant::now());
    false
}

/// Onayla BILE acilmayan KELIME TABANLI komutlar: diski veya bolumu
/// bicimlendirir, onyuklemeyi bozar. Onay model aracilidir (sunucu Cihan'in
/// gercekten evet dediginden emin olamaz) ve bu kalemlerde hata telafisizdir:
/// `DESTRUCTIVE_COMMANDS`taki gibi bir onay yolu YOK. Ayni bicim ve ayni
/// eslestirici (`komut_sinifi`); kelime tabanli oldugu icin `Get-Date -Format`
/// (`-format` bir bayrak) eslesmez. `format` yalniz bir birim/anahtar ardindan
/// gelirse eslesir (`BIRIM`): gercek kullanim bu, `Select-String format` masum.
const DENIED_COMMANDS: &[(&str, &[&str])] = &[
    ("format", &[BIRIM]),
    ("format-volume", &[]),
    ("clear-disk", &[]),
    ("remove-partition", &[]),
    ("initialize-disk", &[]),
    ("diskpart", &[]),
    ("bcdedit", &[]),
];

/// Onayla BILE acilmayan METIN TABANLI komutlar: sistem guvenligini dusurur
/// (yurutme politikasi, Defender, guvenlik duvari, kullanici/yetki degistirme).
/// Onay "yanlis anladi" hasarini onler; guvenlik politikasini dusurme yetkisi
/// vermez, bunu Cihan kendisi yapar.
const DENIED: &[&str] = &[
    "set-executionpolicy",
    "disable-windowsoptionalfeature",
    "set-mppreference", // Defender kapatma
    "add-mppreference",
    "netsh advfirewall set", // guvenlik duvari kapatma
    "new-localuser",
    "set-localuser",
    "add-localgroupmember",
    "takeown /f c:\\",
    "icacls c:\\ ",
];

/// Komut reddedilmeli mi? Reddedilirse sebep doner. Metin tabanli `DENIED` ve
/// kelime tabanli `DENIED_COMMANDS` ikisi de onayla acilmaz.
fn denied_reason(cmd: &str) -> Option<String> {
    let lower = cmd.to_lowercase();
    let desen = DENIED
        .iter()
        .copied()
        .find(|d| lower.contains(d))
        .or_else(|| komut_sinifi(&komut_kelimeleri(cmd), DENIED_COMMANDS));
    desen.map(|d| {
        format!(
            "Bu komut guvenlik geregi reddedildi (desen: '{d}'). Geri donusu olmayan \
             veya sistem guvenligini dusuren islemleri Smith yapmaz; bunu kendin yapmalisin."
        )
    })
}

/// Felaket kapisinin red yaniti: komut loga maskeli yazilir, model sebebi gorur.
fn reddedildi(cmd: &str, reason: String) -> serde_json::Value {
    eprintln!("[sys] REDDEDILDI: {}", log_komutu(cmd));
    serde_json::json!({ "hata": reason, "durum": "reddedildi" })
}

/// Ciktiyi ust sinira kirpar ve kirpildigini belirtir.
fn clip(s: &str) -> String {
    let t = s.trim();
    if t.len() <= MAX_OUTPUT {
        return t.to_string();
    }
    let mut cut = MAX_OUTPUT;
    while cut > 0 && !t.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n…[cikti kirpildi, toplam {} bayt]", &t[..cut], t.len())
}

/// Bir PowerShell cagrisinin ayarlari.
///
/// NEDEN: `run_powershell` tek bir sabit tavana (20 sn) ve TEK bir loglama
/// bicimine mahkumdu. Iki gercek bedeli olctuk:
///
/// 1. **Cagri basina son tarih yoktu.** `boot_context` kendi 800 ms butcesini
///    kanaldan zorlamak zorunda kaldi; sure dolunca ana yol vazgeciyordu ama
///    COCUK SUREC yasamaya devam ediyordu (20 sn'e kadar).
/// 2. **Her cagri TUM script'i stderr'e basiyordu.** `audio_control`'un C#
///    blogu ve acilis baglaminin registry script'i ~1 KB gurultuyu 10 dakikada
///    bir tekrarliyordu; gercek `terminal_calistir` cagrilari bu selde
///    kayboluyordu.
///
/// `Default` bugunku davranistir: 20 sn tavan, tam script logu.
#[derive(Clone, Copy)]
pub struct PsOpts<'a> {
    /// Cikti beklenmez, surec birakilir (uzun/atesle-unut isler).
    pub background: bool,
    /// Pencere/GUI komutu (yalniz `background` ile anlamli): surec Smith'in
    /// surec agacindan AYRI baslatilir ve sonuc "pencere arka planda acildi"
    /// olur (bkz. `ayri_surec_baslat`). `terminal_calistir_sureli` ayarlar.
    pub pencere: bool,
    /// Bu cagrinin son tarihi. Dolunca surec oldurulur ve reap edilir.
    pub timeout: Duration,
    /// Log etiketi. `None` = tum script loglanir, sirlar maskeli (kullanici
    /// seffafligi: `terminal_calistir` icin model ne kosturdu gorunmeli).
    /// `Some(l)` = yalniz `[sys] l` yazilir.
    pub label: Option<&'a str>,
}

impl Default for PsOpts<'_> {
    fn default() -> Self {
        Self {
            background: false,
            pencere: false,
            timeout: DEFAULT_TIMEOUT,
            label: None,
        }
    }
}

impl<'a> PsOpts<'a> {
    /// Etiketli, sessiz cagri: script yerine tek satirlik etiket loglanir.
    fn labeled(label: &'a str) -> Self {
        Self {
            label: Some(label),
            ..Self::default()
        }
    }

    fn suffix(&self) -> &'static str {
        match (self.background, self.pencere) {
            (true, true) => " (pencere, arka plan)",
            (true, false) => " (arka plan)",
            _ => "",
        }
    }
}

/// Sureyi insan diliyle yazar (hata mesaji icin).
fn sure_metni(d: Duration) -> String {
    if d.as_millis() >= 1000 {
        format!("{:.0} saniye", d.as_secs_f64())
    } else {
        format!("{} ms", d.as_millis())
    }
}

/// PowerShell komutu kosar. `background` ise cikti beklemez (uzun isler).
///
/// Geriye donuk uyumlu giris kapisi: `PsOpts::default()` ile
/// `run_powershell_opts`'a devreder. Ayarli cagri icin onu dogrudan kullan.
pub fn run_powershell(cmd: &str, background: bool) -> serde_json::Value {
    run_powershell_opts(
        cmd,
        PsOpts {
            background,
            ..PsOpts::default()
        },
    )
}

/// PowerShell 7 (pwsh) yolu — varsa. 5.1'in ANSI varsayilanlari dosya
/// encodingini bozar (bkz. `run_powershell_opts` basligi); 7'de her sey UTF-8.
fn pwsh_path() -> Option<std::path::PathBuf> {
    let base = std::env::var("ProgramFiles").ok()?;
    let p = std::path::PathBuf::from(base)
        .join("PowerShell")
        .join("7")
        .join("pwsh.exe");
    p.is_file().then_some(p)
}

/// Kabuk ne olursa olsun UTF-8 sigortasi (on-ek): boru/cikti kodlamasi ve dosya
/// varsayilanlari BOM'suz UTF-8'e cekilir. `utf8NoBOM` yalniz PS7+'ta taninir —
/// surum kapisi 5.1'de hatasiz gecmesi icin.
const PS_UTF8_PREAMBLE: &str = "try { $OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); if ($PSVersionTable.PSVersion.Major -ge 7) { $PSDefaultParameterValues['*:Encoding'] = 'utf8NoBOM' } } catch { }";

/// Kabuk yolu + UTF-8 on-ekli betik + hazir `Command` (borulu stdio).
///
/// KOSU SONU KAPISI: komut `try { ... } finally { ... }` icinde kosar; sonunda
/// `$Error` doluysa ilk hata yeniden firlatilir, son native komut sifir disi
/// cikmissa onun kodu ile cikilir. PowerShell non-terminating hatada
/// (`Get-Item 'C:\olmayan'`) 0 ile cikar; kapi olmadan `hata_cikti` dolu bir
/// komut `basarili:true` raporlanirdi. `-ErrorAction SilentlyContinue` ve
/// yakalanip (`try/catch`) islenen hatalar da `$Error`a girer: bilerek
/// yutulacak hata icin `-ErrorAction Ignore` kullanilir.
fn ps_hazirla(cmd: &str) -> (PathBuf, String, Command) {
    let shell = pwsh_path().unwrap_or_else(|| PathBuf::from("powershell.exe"));
    let script = format!("if ($env:SMITH_KONTROLLU -eq '1') {{ if ([Console]::In.ReadLine() -ne 'smith-run') {{ exit 125 }} }}\n{PS_UTF8_PREAMBLE}\n$Error.Clear(); $global:LASTEXITCODE = 0\ntry {{\n{cmd}\n}} finally {{ if ($Error.Count -gt 0) {{ throw $Error[0] }}; if ($global:LASTEXITCODE -ne 0) {{ exit $global:LASTEXITCODE }} }}");
    let mut command = Command::new(&shell);
    command.env_remove("SMITH_KONTROLLU");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    (shell, script, command)
}

/// PowerShell komutu kosar — cagri basina zaman asimi ve log etiketi ile.
pub fn run_powershell_opts(cmd: &str, opts: PsOpts<'_>) -> serde_json::Value {
    terminal_sonucu(run_powershell_opts_ham(cmd, opts))
}

/// Loga yazilacak komut/etiket metni. Terminal komutu inline Bearer token, parola
/// veya imzali URL tasiyabilir; kalici loga (stderr'i toplayan dosyalar dahil)
/// yalniz ortak `maskele` filtresinden gecmis haliyle girer.
fn log_komutu(metin: &str) -> String {
    crate::agent_sessions::maskele(metin)
}

fn run_powershell_opts_ham(cmd: &str, opts: PsOpts<'_>) -> serde_json::Value {
    if let Some(reason) = denied_reason(cmd) {
        return reddedildi(cmd, reason);
    }
    match opts.label {
        Some(l) => eprintln!("[sys] {}{}", log_komutu(l), opts.suffix()),
        None => eprintln!("[sys] terminal{}: {}", opts.suffix(), log_komutu(cmd)),
    }

    // -NoProfile: kullanici profili yavas ve yan etkili olabilir.
    // -NonInteractive: prompt bekleyip kilitlenmesin.
    //
    // KABUK + ENCODING (2026-09-18 saha dersi): onceden kosulsuz
    // `powershell.exe` (Windows PowerShell 5.1) cagriliyordu; 5.1'de
    // `Get-Content` BOM'suz dosyayi SISTEM KOD SAYFASI ile okur (bu makinede
    // cp1254) ve `Set-Content -Encoding utf8` BOM ekler. Smith'in dosya
    // duzenleme komutlari bu yuzden Turkce metinleri cift-kodladi ve vault'ta
    // 46 dosyayi bozdu. Cozum: PowerShell 7 (varsa) — varsayilanlari UTF-8 —
    // arti her cagriya UTF-8 on-ekleri (7 yoksa 5.1'e duser).
    let (shell, script, mut command) = ps_hazirla(cmd);

    if opts.background {
        // Arka plan: cikti toplanmaz, surec birakilir. Ses/uygulama baslatma
        // gibi "bitmesini beklemek anlamsiz" isler icin.
        //
        // NULL, `piped()` DEGIL: borular kimse tarafindan okunmuyor ve `Child`
        // dusurulunce parent ucu kapaniyordu; surec kirik boruya yaziyordu. Olcum
        // (PowerShell 7) bunu tolere ettigini gosterdi, ama bu bir sans:
        // baska bir kabuk/native komut ilk yazida olebilir. Cikti istenen
        // arka plan isleri `arka_plan_is_baslat` yolundan dosyaya gider.
        command.stdout(Stdio::null()).stderr(Stdio::null());
        if opts.pencere {
            return pencere_baslat(&shell, &script);
        }
        return match command.spawn() {
            Ok(child) => serde_json::json!({
                "durum": "arka planda baslatildi",
                "pid": child.id()
            }),
            Err(e) => serde_json::json!({ "hata": format!("baslatilamadi: {e}") }),
        };
    }

    let started = Instant::now();
    let (child, agac) = match kontrollu_baslat(&mut command) {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "hata": format!("baslatilamadi: {e}") }),
    };

    let (durum, zaman_asimi, stdout, stderr) = match bekle_sinirli_agac(child, opts.timeout, agac) {
        Ok(t) => t,
        Err(e) => return serde_json::json!({ "hata": format!("bekleme hatasi: {e}") }),
    };

    if zaman_asimi {
        let sure = sure_metni(opts.timeout);
        eprintln!(
            "[sys] zaman asimi ({sure}): {}",
            log_komutu(opts.label.unwrap_or(cmd))
        );
        // KISMI CIKTIYI ATMA: iptal edilmis bir aramanin bulduklari da
        // kullanicinin isine yarar; "hicbir sey bulamadim" demek bilgi kaybi.
        let mut result = serde_json::json!({
            "durum": "zaman_asimi",
            "hata": format!("komut {sure} icinde bitmedi, iptal edildi"),
            "sure_ms": started.elapsed().as_millis(),
        });
        if !stdout.trim().is_empty() {
            result["kismi_cikti"] = serde_json::json!(clip(&stdout));
        }
        // SAHA (2026-10-01/02): zaman asimi iki kez modele "basarisiz" diye
        // okundu ve bir daha denenmedi. `label == None` terminal_calistir
        // kosusudur (bkz. `PsOpts::label`); etiketli ic cagrilarin
        // (`dosya_ara`...) `arka_planda`/`sure_sn` parametresi olmadigindan onlara
        // bu yonerge EKLENMEZ.
        if opts.label.is_none() {
            result["aciklama"] = serde_json::json!(format!(
                "Komut {sure} icinde bitmedi ve durduruldu. Bu 'yapilamaz' demek DEGIL, \
                 yalnizca sure sinirina takildi: komutun etkisi (ornegin acilan bir pencere) \
                 kullaniciya gorunmus olabilir, durdurulunca kapanmis olabilir. Uzun suren \
                 komut icin sure_sn ver (en fazla 300); pencere acan veya cok uzun suren \
                 komut icin arka_planda=true kullan ve sonucu arka_plan_sonuc ile sor. \
                 'Yapilamaz' sonucuna varmadan once kullaniciya sor: ne gordu?"
            ));
        }
        return result;
    }

    let code = durum.and_then(|s| s.code()).unwrap_or(-1);
    let mut result = serde_json::json!({
        "cikis_kodu": code,
        "sure_ms": started.elapsed().as_millis(),
        "cikti": clip(&stdout),
    });
    if !stderr.trim().is_empty() {
        result["hata_cikti"] = serde_json::json!(clip(&stderr));
    }
    result
}

/// Yerel bir komutu son tarihli ve cikti kotali kosar: dashboard motor probu
/// gibi kisa, sabit komutlar icin. PowerShell veya kabuk katmani YOK (arguman
/// tirnaklama sorunu yok), konsol penceresi acilmaz. Govde `run_wsl_bounded` ve
/// `run_powershell_opts` ile ayni (`bekle_sinirli`): son tarih dolunca surec
/// agaci oldurulur, bellek `MAX_IS_CIKTISI` ile sinirlidir.
///
/// Sifir cikisla bitmediyse veya `timeout` dolduysa `None`. Basarida
/// `(stdout, stderr)` `MAX_OUTPUT`a kirpilmis doner: kimligi stderr'e yazan CLI'lar
/// (`codex login status`) icin ikisi de gerekir.
pub fn run_bounded(command: &mut Command, timeout: Duration) -> Option<(String, String)> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let child = command.spawn().ok()?;
    match bekle_sinirli(child, timeout) {
        Ok((Some(durum), false, stdout, stderr)) if durum.success() => {
            Some((clip(&stdout), clip(&stderr)))
        }
        _ => None,
    }
}

/// WSL'de bir bash satiri kosar ve ciktisini metin olarak dondurur.
///
/// NEDEN POWERSHELL UZERINDEN DEGIL: PowerShell katmani eklemek bash satirini
/// IKI kez tirnaklamak demek ve bu depoda o katman defalarca sessizce komutu
/// bozdu (bkz. `wsl bash -lc` + `2>/dev/null` tuzagi). `Command::args` ile
/// argumanlar kabuk yorumundan HIC gecmez.
///
/// `WSL_UTF8=1` SART: `wsl.exe` varsayilan olarak UTF-16 yazar ve cikti
/// okunamaz hale gelir.
pub fn run_wsl_bounded(bash_line: &str, timeout_s: u64) -> String {
    run_wsl_bounded_input(bash_line, Duration::from_secs(timeout_s), None)
}

fn run_wsl_bounded_stdin(bash_line: &str, timeout: Duration, input: &str) -> String {
    run_wsl_bounded_input(bash_line, timeout, Some(input.as_bytes()))
}

fn run_wsl_bounded_input(bash_line: &str, timeout: Duration, input: Option<&[u8]>) -> String {
    use std::io::Write;

    let mut command = Command::new("wsl.exe");
    command
        .env("WSL_UTF8", "1")
        .args(["-e", "bash", "-lc", bash_line])
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => return format!("wsl baslatilamadi: {e}"),
    };
    let writer = input.and_then(|bytes| {
        let mut stdin = child.stdin.take()?;
        let bytes = bytes.to_vec();
        Some(std::thread::spawn(move || stdin.write_all(&bytes)))
    });
    let result = match bekle_sinirli(child, timeout) {
        Ok((_, true, stdout, _)) => {
            // Zaman asiminda KISMI ciktiyi koruyoruz: ajan is yapmis olabilir ve
            // worktree yerinde duruyor, yani emek kaybolmuyor.
            format!(
                "ZAMAN ASIMI ({}) — is yarida kesildi, worktree \
                 duruyor.\n{}",
                sure_metni(timeout),
                stdout.trim()
            )
        }
        Ok((durum, false, stdout, stderr)) => {
            let kod = durum.and_then(|s| s.code()).unwrap_or(-1);
            if kod == 0 {
                stdout.trim().to_string()
            } else {
                format!("cikis kodu {kod}\n{}\n{}", stdout.trim(), stderr.trim())
            }
        }
        Err(e) => format!("bekleme hatasi: {e}"),
    };
    if let Some(writer) = writer {
        if !matches!(writer.join(), Ok(Ok(()))) && !result.starts_with("ZAMAN ASIMI") {
            return "wsl stdin yazilamadi".into();
        }
    }
    result
}

/// Cocuk surecin borularini BOSALTARAK sinirli sure bekler.
/// Doner: (cikis durumu, zaman asimi mi, stdout, stderr).
///
/// NEDEN ORTAK FONKSIYON: asagidaki dersin IKINCI bir kopyasi kacinilmaz olarak
/// eskir. `run_powershell_opts` ve `run_wsl_bounded` ayni govdeyi paylasir;
/// boylece boru bosaltma kusuru bir yerde duzeltilip otekinde geri gelemez.
/// Job Object, kok surec erken ciksa bile butun cocuklarin sahipligini tutar.
/// Cargo'ya crate eklemeden dar Win32 ABI; handle RAII ile kapatilir.
#[cfg(windows)]
mod is_agaci {
    use super::*;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    type Handle = *mut std::ffi::c_void;
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_processes: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Accounting {
        user_time: i64,
        kernel_time: i64,
        period_user: i64,
        period_kernel: i64,
        faults: u32,
        total: u32,
        active: u32,
        terminated: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: Handle, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            info: *const std::ffi::c_void,
            size: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, code: u32) -> i32;
        fn QueryInformationJobObject(
            job: Handle,
            class: i32,
            info: Handle,
            size: u32,
            returned: *mut u32,
        ) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn GetExitCodeProcess(process: Handle, code: *mut u32) -> i32;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    }
    pub(super) fn surec_ac(pid: u32) -> std::io::Result<OwnedHandle> {
        // SAFETY: salt sorgulama + bekleme; GUI komutu go kapisinda bekler.
        let handle = unsafe { OpenProcess(0x0010_0000 | 0x1000, 0, pid) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: OpenProcess'in sahipligi bu OwnedHandle'a geciyor.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }
    pub(super) fn cikis_kodu(process: &OwnedHandle) -> std::io::Result<Option<u32>> {
        // SAFETY: sahip olunan canli handle, sifir sureli sorgu.
        match unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } {
            0x102 => Ok(None), // WAIT_TIMEOUT: hala calisiyor
            0 => {
                let mut code = 0;
                // SAFETY: yerel u32 cikis parametresi ve canli process handle.
                if unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut code) } == 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(Some(code))
                }
            }
            _ => Err(std::io::Error::last_os_error()),
        }
    }
    pub(super) struct SurecAgaci(OwnedHandle);
    impl SurecAgaci {
        pub(super) fn yeni() -> std::io::Result<Self> {
            // SAFETY: isimsiz, kalitilmayan job; null guvenlik ozellikleri.
            let h = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
            if h.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: yeni, benzersiz sahipli handle; yalniz OwnedHandle kapatir.
            let job = Self(unsafe { OwnedHandle::from_raw_handle(h) });
            let mut limits = ExtendedLimits::default();
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                                         // SAFETY: class 9 icin repr(C) EXTENDED_LIMIT_INFORMATION ve tam boyu.
            let ok = unsafe {
                SetInformationJobObject(
                    h,
                    9,
                    (&limits as *const ExtendedLimits).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            };
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(job)
        }
        pub(super) fn bagla(&self, child: &std::process::Child) -> std::io::Result<()> {
            // SAFETY: iki handle da cagri boyunca canli. Betik stdin kapisinda.
            if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), child.as_raw_handle()) }
                == 0
            {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
        pub(super) fn aktif(&self) -> Result<bool, String> {
            let mut info = Accounting::default();
            // SAFETY: class 1, repr(C) BASIC_ACCOUNTING_INFORMATION ve tam boyu.
            let ok = unsafe {
                QueryInformationJobObject(
                    self.0.as_raw_handle(),
                    1,
                    (&mut info as *mut Accounting).cast(),
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(format!(
                    "job sorgulanamadi: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(info.active != 0)
        }
        pub(super) fn serbest_birak(&self) -> Result<(), String> {
            // Normal senkron launcher basariyla bitti ve borular kapandi.
            // Baslatilan bagimsiz uygulama kapanmamali. Timeout/iptal/is yolu
            // bu metodu cagirmaz, agac sahipligini korur.
            let limits = ExtendedLimits::default();
            // SAFETY: class 9 ve dogru repr(C) yapi; yalniz kill-on-close kaldirilir.
            if unsafe {
                SetInformationJobObject(
                    self.0.as_raw_handle(),
                    9,
                    (&limits as *const ExtendedLimits).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            } == 0
            {
                return Err(format!(
                    "basarili launcher birakilamadi: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        }
        pub(super) fn durdur(&self) -> Result<(), String> {
            // SAFETY: sahip olunan canli job; Smith bu job'un uyesi degil.
            if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } == 0 {
                return Err(format!(
                    "job sonlandirilamadi: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let start = Instant::now();
            while self.aktif()? {
                if start.elapsed() >= Duration::from_secs(2) {
                    return Err("job sonlandirma zaman asimi".into());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(())
        }
    }
}
#[cfg(windows)]
use is_agaci::SurecAgaci;
#[cfg(not(windows))]
struct SurecAgaci;

fn kontrollu_baslat(
    command: &mut Command,
) -> Result<(std::process::Child, Option<SurecAgaci>), String> {
    #[cfg(windows)]
    {
        use std::io::Write;
        let agac = SurecAgaci::yeni().map_err(|e| format!("job olusturulamadi: {e}"))?;
        command.env("SMITH_KONTROLLU", "1").stdin(Stdio::piped());
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        if let Err(e) = agac.bagla(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("job baglanamadi, betik calistirilmadi: {e}"));
        }
        let write = child
            .stdin
            .take()
            .ok_or("baslatma kapisi yok")?
            .write_all(b"smith-run\n");
        if let Err(e) = write {
            let _ = agac.durdur();
            let _ = child.wait();
            return Err(format!("baslatma kapisi acilamadi: {e}"));
        }
        Ok((child, Some(agac)))
    }
    #[cfg(not(windows))]
    command
        .spawn()
        .map(|child| (child, None))
        .map_err(|e| e.to_string())
}

fn agaci_durdur(child: &mut std::process::Child, agac: Option<&SurecAgaci>) -> Result<(), String> {
    #[cfg(windows)]
    if let Some(agac) = agac {
        return agac.durdur();
    }
    #[cfg(not(windows))]
    let _ = agac;
    surec_agacini_durdur(child)
}

/// taskkill de takilabilir: sonlandirma icin toplam iki saniye pay ayrilir.
fn surec_agacini_durdur(child: &mut std::process::Child) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut killer = Command::new("taskkill.exe")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("surec agaci durdurulamadi: {e}"))?;
        let start = Instant::now();
        loop {
            match killer.try_wait() {
                Ok(Some(s)) if s.success() => break,
                Ok(Some(_)) => return Err("surec agaci durdurulamadi (taskkill basarisiz)".into()),
                Ok(None) if start.elapsed() < Duration::from_secs(2) => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                result => {
                    let _ = killer.kill();
                    let _ = killer.wait();
                    return Err(format!(
                        "surec agaci durdurulamadi (taskkill zaman asimi/hata: {result:?})"
                    ));
                }
            }
        }
    }
    #[cfg(not(windows))]
    child.kill().map_err(|e| e.to_string())?;
    // TerminateProcess/taskkill tamamlandiktan sonra reap de sinirlidir.
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) if start.elapsed() < Duration::from_millis(500) => {
                std::thread::sleep(Duration::from_millis(10))
            }
            _ => return Err("sonlandirma sonrasi surec hala izleniyor".into()),
        }
    }
}

enum CiktiBorusu {
    Out(std::process::ChildStdout),
    Err(std::process::ChildStderr),
}

impl CiktiBorusu {
    fn oku(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        use std::io::Read;
        match self {
            Self::Out(p) => p.read(buf),
            Self::Err(p) => p.read(buf),
        }
    }

    /// Windows anonymous pipe Read'i bloklar. Peek ile veri/EOF beklenir;
    /// boylece iptalden sonra okuyucu thread ve handle da serbest kalir.
    #[cfg(windows)]
    fn hazir(&self) -> std::io::Result<bool> {
        use std::os::windows::io::AsRawHandle;
        #[link(name = "kernel32")]
        extern "system" {
            fn PeekNamedPipe(
                handle: *mut std::ffi::c_void,
                buffer: *mut std::ffi::c_void,
                size: u32,
                read: *mut u32,
                available: *mut u32,
                left: *mut u32,
            ) -> i32;
        }
        let handle = match self {
            Self::Out(p) => p.as_raw_handle(),
            Self::Err(p) => p.as_raw_handle(),
        };
        let mut available = 0;
        // SAFETY: pipe thread'in kendi canli handle'i; yalniz available yazilir.
        let ok = unsafe {
            PeekNamedPipe(
                handle,
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(available > 0)
        }
    }

    #[cfg(not(windows))]
    fn hazir(&self) -> std::io::Result<bool> {
        Ok(true)
    }
}

#[derive(Default)]
struct CiktiHedefi {
    out: Vec<u8>,
    err: Vec<u8>,
    dosya: Option<std::fs::File>,
    yazilan: usize,
    kota_asildi: bool,
    hata: Option<String>,
}

fn boru_oku(
    pipe: Option<CiktiBorusu>,
    err: bool,
    hedef: std::sync::Arc<std::sync::Mutex<CiktiHedefi>>,
    dur: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        use std::io::Write;
        let Some(mut pipe) = pipe else { return };
        let mut buf = [0u8; 8192];
        while !dur.load(std::sync::atomic::Ordering::Acquire) {
            match pipe.hazir() {
                Ok(false) => {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                // ERROR_BROKEN_PIPE / ERROR_NO_DATA: normal EOF.
                Err(e) if matches!(e.raw_os_error(), Some(109 | 232)) => break,
                Err(e) => {
                    hedef.lock().unwrap_or_else(|e| e.into_inner()).hata = Some(e.to_string());
                    break;
                }
                Ok(true) => {}
            }
            match pipe.oku(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let mut h = hedef.lock().unwrap_or_else(|e| e.into_inner());
                    if h.kota_asildi || h.hata.is_some() {
                        break;
                    }
                    if h.dosya.is_some() {
                        let kalan = MAX_IS_CIKTISI.saturating_sub(h.yazilan);
                        let yaz = n.min(kalan);
                        if let Err(e) = h.dosya.as_mut().expect("dosya").write_all(&buf[..yaz]) {
                            h.hata = Some(format!("is ciktisi yazilamadi: {e}"));
                            break;
                        }
                        h.yazilan += yaz;
                        if yaz < n {
                            h.kota_asildi = true;
                            break;
                        }
                    } else {
                        let target = if err { &mut h.err } else { &mut h.out };
                        // Bellek de sinirli; boru sonuna kadar bosaltilir.
                        let keep = n.min(MAX_IS_CIKTISI.saturating_sub(target.len()));
                        target.extend_from_slice(&buf[..keep]);
                    }
                }
                Err(e) => {
                    hedef.lock().unwrap_or_else(|e| e.into_inner()).hata = Some(e.to_string());
                    break;
                }
            }
        }
    })
}

fn sureci_izle(
    mut child: std::process::Child,
    timeout: Duration,
    dosya: Option<std::fs::File>,
    iptal: std::sync::Arc<std::sync::atomic::AtomicBool>,
    agac: Option<SurecAgaci>,
) -> (IsSonucu, String, String) {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };
    let start = Instant::now();
    let arka_plan = dosya.is_some();
    let hedef = Arc::new(Mutex::new(CiktiHedefi {
        dosya,
        ..Default::default()
    }));
    let dur = Arc::new(AtomicBool::new(false));
    let out = boru_oku(
        child.stdout.take().map(CiktiBorusu::Out),
        false,
        hedef.clone(),
        dur.clone(),
    );
    let err = boru_oku(
        child.stderr.take().map(CiktiBorusu::Err),
        true,
        hedef.clone(),
        dur.clone(),
    );
    let mut sonuc = IsSonucu {
        sure: Duration::ZERO,
        kod: None,
        durum: "bitti",
        hata: None,
    };
    let mut exited = false;
    loop {
        {
            let h = hedef.lock().unwrap_or_else(|e| e.into_inner());
            if h.kota_asildi {
                sonuc.durum = "cikti_kotasi";
            }
            if let Some(e) = &h.hata {
                sonuc.durum = "hata";
                sonuc.hata = Some(e.clone());
            }
        }
        if sonuc.durum == "bitti" && iptal.load(Ordering::Acquire) {
            sonuc.durum = "iptal";
        }
        if sonuc.durum == "bitti" && start.elapsed() >= timeout {
            sonuc.durum = "zaman_asimi";
        }
        if sonuc.durum != "bitti" {
            if let Err(e) = agaci_durdur(&mut child, agac.as_ref()) {
                sonuc.hata = Some(e);
                // Basarili durdurma iddiasi yapma.
                sonuc.durum = "durdurma_hatasi";
            }
            break;
        }
        if !exited {
            match child.try_wait() {
                Ok(Some(s)) => {
                    exited = true;
                    sonuc.kod = s.code();
                }
                Ok(None) => {}
                Err(e) => {
                    sonuc.durum = "hata";
                    sonuc.hata = Some(e.to_string());
                    if let Err(kill) = agaci_durdur(&mut child, agac.as_ref()) {
                        sonuc.hata = Some(kill);
                    }
                    break;
                }
            }
        }
        if exited && out.is_finished() && err.is_finished() {
            #[cfg(windows)]
            if arka_plan {
                if let Some(tree) = &agac {
                    match tree.aktif() {
                        Ok(true) => {
                            std::thread::sleep(Duration::from_millis(10));
                            continue;
                        }
                        Ok(false) => {}
                        Err(e) => {
                            sonuc.hata = Some(e);
                            sonuc.durum = "hata";
                        }
                    }
                }
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // Kesin sinir: inherited handle EOF getirmese de join sonsuza kadar beklemez.
    let grace = Instant::now();
    while !(out.is_finished() && err.is_finished()) && grace.elapsed() < Duration::from_millis(200)
    {
        std::thread::sleep(Duration::from_millis(5));
    }
    dur.store(true, Ordering::Release);
    let grace = Instant::now();
    while !(out.is_finished() && err.is_finished()) && grace.elapsed() < Duration::from_millis(100)
    {
        std::thread::sleep(Duration::from_millis(5));
    }
    if out.is_finished() {
        let _ = out.join();
    }
    if err.is_finished() {
        let _ = err.join();
    }
    let mut h = hedef.lock().unwrap_or_else(|e| e.into_inner());
    // Son okuma ile try_wait arasinda kota/hata gelmis olabilir.
    if sonuc.durum == "bitti" {
        if h.kota_asildi {
            sonuc.durum = "cikti_kotasi";
        }
        if let Some(e) = &h.hata {
            sonuc.durum = "hata";
            sonuc.hata = Some(e.clone());
        }
    }
    h.dosya.take();
    #[cfg(windows)]
    if !arka_plan && sonuc.durum == "bitti" && sonuc.kod == Some(0) {
        if let Some(tree) = &agac {
            if let Err(e) = tree.serbest_birak() {
                sonuc.hata = Some(e);
                sonuc.durum = "hata";
            }
        }
    }
    #[cfg(not(windows))]
    let _ = arka_plan;
    sonuc.sure = start.elapsed();
    (
        sonuc,
        String::from_utf8_lossy(&h.out).into_owned(),
        String::from_utf8_lossy(&h.err).into_owned(),
    )
}

fn bekle_sinirli(
    child: std::process::Child,
    timeout: Duration,
) -> Result<(Option<std::process::ExitStatus>, bool, String, String), String> {
    bekle_sinirli_agac(child, timeout, None)
}

fn bekle_sinirli_agac(
    child: std::process::Child,
    timeout: Duration,
    agac: Option<SurecAgaci>,
) -> Result<(Option<std::process::ExitStatus>, bool, String, String), String> {
    let (son, out, err) = sureci_izle(child, timeout, None, Default::default(), agac);
    if let Some(e) = son.hata {
        return Err(e);
    }
    #[cfg(windows)]
    let status = son.kod.map(|c| {
        use std::os::windows::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(c as u32)
    });
    #[cfg(unix)]
    let status = son.kod.map(|c| {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(c << 8)
    });
    Ok((status, son.durum == "zaman_asimi", out, err))
}

/// Uygulama/dosya/URL acar. `ad` bir exe adi, tam yol, dosya veya URL olabilir.
///
/// `Start-Process` kullanir: kayitli uygulamalari (chrome, spotify), dosyalari
/// (varsayilan programla) ve URL'leri ayni sekilde acar.
pub fn open_app(name: &str) -> serde_json::Value {
    if let Some(reason) = denied_reason(name) {
        return serde_json::json!({ "hata": reason, "durum": "reddedildi" });
    }
    // Tek tirnak kacisi: PowerShell'de '' iki tirnak demektir.
    let escaped = name.replace('\'', "''");
    let cmd = format!("Start-Process -FilePath '{escaped}'");
    let etiket = format!("uygulama ac: {name}");
    match run_powershell_opts(
        &cmd,
        PsOpts {
            background: true,
            ..PsOpts::labeled(&etiket)
        },
    ) {
        v if v.get("hata").is_some() => v,
        _ => serde_json::json!({ "durum": format!("'{name}' acildi") }),
    }
}

/// Donanim + sistem durumu: CPU, RAM, disk, GPU, pil, uptime.
///
/// ## NEDEN CIM DEGIL — OLCUM
///
/// Bu arac 2026-08-15'e kadar tek bir PowerShell script'inde `Win32_Processor`,
/// `Win32_VideoController` ve `Win32_Battery` sorguluyordu. Bu makinede
/// olculdu: **isinmis 2 677-3 034 ms, SOGUK 35 535 ms**. Sesli bir asistanda bu
/// olu zamandir — kullanici "sistem durumu nedir" deyip 3-35 saniye bekliyordu.
/// Suclu WMI: soguk baslayan bir CIM sorgusu saniyeler surer.
///
/// `boot_context` ayni veriyi ZATEN ucuz yollardan aliyordu (tum acilis
/// baglami 468 ms, butcesi 800 ms). Bu arac artik o yolu kullanir; oradaki
/// fonksiyonlar **kopyalanmadi, ithal edildi**.
///
/// | Alan                              | Yeni kaynak                                     |
/// | --------------------------------- | ----------------------------------------------- |
/// | `ram_toplam_gb`, `ram_bos_gb`     | `boot_context::memory()` — `GlobalMemoryStatusEx` |
/// | `disk_c_*`                        | `boot_context::fixed_disks()` — `GetDiskFreeSpaceExW` |
/// | `pil_yuzde`                       | `boot_context::battery()` — `GetSystemPowerStatus` |
/// | `acik_kalma_saat`                 | `boot_context::uptime()` — `GetTickCount64`     |
/// | `cpu`, `gpu`, `isletim_sistemi`   | `boot_context` statik olcumu — REGISTRY (CIM yok) |
/// | `cekirdek`                        | `available_parallelism()` (boot_context ile ayni)|
/// | `cpu_yuzde`                       | `GetSystemTimes` ornekleme (asagida)            |
///
/// VRAM TUZAGI: eski script GPU icin yalniz `Name` donduruyordu; `AdapterRAM`
/// kullanilsaydi 32-bit tasma yuzunden RTX 5060 "4 GB" gorunecekti. Registry
/// yolu `HardwareInformation.qwMemorySize` (64-bit) okur ve `gpu` alani artik
/// dogru VRAM'i de tasir (7.96 GiB; `nvidia-smi` 8151 MiB ile tutarli).
pub fn system_status() -> serde_json::Value {
    // Statik olcum registry FFI ile onbelleklenir. CPU yuzdesi
    // ise ORNEKLEME suresi ister. Ikisi paralel akar: `boot_context::collect`
    // ile ayni desen.
    let statik_isi = std::thread::spawn(statik_bilgi);
    let cpu_pct = cpu_load_pct();
    let statik = statik_isi.join().unwrap_or_default();

    let f = StatusFacts {
        cpu: statik.as_ref().and_then(|s| s.cpu.clone()),
        cores: std::thread::available_parallelism().ok().map(|n| n.get()),
        cpu_pct,
        ram: boot_context::memory(),
        gpu: statik.as_ref().and_then(|s| s.gpu.clone()),
        disk_c: boot_context::fixed_disks()
            .into_iter()
            .find(|d| d.letter == 'C'),
        battery: boot_context::battery(),
        os: statik.and_then(|s| s.os),
        uptime: boot_context::uptime(),
    };
    build_status(&f)
}

/// Statik olcum: once surec-omurlu onbellek, yoksa dogrudan registry FFI.
///
/// Onbellek `boot_context`'in kendi onbellegidir — ikinci bir tane KURULMADI.
/// Acilis baglami zaten her oturumda onu isittigi icin, gercek kullanimda bu
/// yol PowerShell'e hic dokunmaz.
fn statik_bilgi() -> Option<boot_context::StaticFacts> {
    boot_context::static_facts()
}

/// `system_status` ciktisini olusturan saf veri.
struct StatusFacts {
    cpu: Option<String>,
    cores: Option<usize>,
    cpu_pct: Option<u32>,
    ram: Option<boot_context::Ram>,
    gpu: Option<String>,
    disk_c: Option<boot_context::Disk>,
    battery: Option<boot_context::Battery>,
    os: Option<String>,
    uptime: Option<Duration>,
}

/// Bir ondalik basamaga yuvarlar (eski script'in `[math]::Round(x,1)` sozlesmesi).
fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// Saf JSON kurucu — ALAN SOZLESMESI burada.
///
/// Ayri fonksiyon cunku alan kaybi bir gerilemedir (model bu araca gore
/// konusuyor) ve bunu uydurma girdilerle, surec acmadan test edebilmek
/// gerekiyor: `alan_sozlesmesi_korunur`.
fn build_status(f: &StatusFacts) -> serde_json::Value {
    if f.cpu.is_none()
        && f.ram.is_none()
        && f.disk_c.is_none()
        && f.os.is_none()
        && f.uptime.is_none()
    {
        return serde_json::json!({ "hata": "sistem durumu alinamadi" });
    }
    serde_json::json!({
        "cpu": f.cpu,
        "cekirdek": f.cores,
        "cpu_yuzde": f.cpu_pct,
        "ram_toplam_gb": f.ram.map(|r| round1(r.total_gb)),
        "ram_bos_gb": f.ram.map(|r| round1(r.free_gb)),
        "gpu": f.gpu,
        "disk_c_bos_gb": f.disk_c.map(|d| round1(d.free_gb)),
        "disk_c_toplam_gb": f.disk_c.map(|d| round1(d.total_gb)),
        // Eski sozlesme birebir: pil yoksa SAYI degil bu metin doner.
        "pil_yuzde": match f.battery {
            Some(b) => serde_json::json!(b.percent),
            None => serde_json::json!("pil yok (masaustu)"),
        },
        "isletim_sistemi": f.os,
        "acik_kalma_saat": f.uptime.map(|d| round1(d.as_secs_f64() / 3600.0)),
    })
}

/// Anlik CPU yuzdesi — `GetSystemTimes` ile iki ornek arasindaki fark.
///
/// Eski yol `Win32_Processor.LoadPercentage` idi ve tek basina bir CIM
/// sorgusuydu (olculen 3 sn'lik gecikmenin buyuk parcasi). `GetSystemTimes`
/// kernel32'de, surec acmaz, yeni bagimlilik istemez. Bedel: anlamli bir yuzde
/// icin IKI ornek gerekir, yani ornekleme penceresi kadar beklenir. 120 ms
/// secildi: 500 ms'lik hedefin dortte biri, ve bu pencere boyunca statik olcum
/// paralel akiyor — yani pratikte bedava.
#[cfg(windows)]
fn cpu_load_pct() -> Option<u32> {
    /// Ornekleme penceresi.
    const SAMPLE: Duration = Duration::from_millis(120);
    let (i0, k0, u0) = system_times()?;
    std::thread::sleep(SAMPLE);
    let (i1, k1, u1) = system_times()?;
    // `kernel` bosta gecen sureyi ICERIR; toplam = kernel + user.
    let toplam = (k1.checked_sub(k0)?).checked_add(u1.checked_sub(u0)?)?;
    let bosta = i1.checked_sub(i0)?;
    if toplam == 0 || bosta > toplam {
        return None;
    }
    Some((((toplam - bosta) as f64 / toplam as f64) * 100.0).round() as u32)
}

/// (idle, kernel, user) — 100 ns birimli sayaclar.
#[cfg(windows)]
fn system_times() -> Option<(u64, u64, u64)> {
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct FILETIME {
        low: u32,
        high: u32,
    }
    impl FILETIME {
        fn as_u64(self) -> u64 {
            ((self.high as u64) << 32) | self.low as u64
        }
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemTimes(idle: *mut FILETIME, kernel: *mut FILETIME, user: *mut FILETIME) -> i32;
    }
    let (mut i, mut k, mut u) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    // SAFETY: uc cikti isaretcisi de gecerli yerel degiskenlere bakiyor; API
    // yalniz bu yapilara yazar ve `#[repr(C)]` ABI ile birebir (2 x u32).
    let ok = unsafe { GetSystemTimes(&mut i, &mut k, &mut u) };
    (ok != 0).then(|| (i.as_u64(), k.as_u64(), u.as_u64()))
}

// Windows disi hedeflerde CPU yuzdesi olculmez; alan `null` doner.
#[cfg(not(windows))]
fn cpu_load_pct() -> Option<u32> {
    None
}

/// Ses kontrolu: seviye oku/ayarla/sustur.
///
/// Windows'ta ses seviyesi icin resmi PowerShell cmdlet'i YOK; ek modul (
/// AudioDeviceCmdlets) kurmak da kullaniciya bagimlilik dayatir. Bu yuzden
/// `IAudioEndpointVolume` COM arayuzu `Add-Type` ile inline P/Invoke edilir —
/// harici bagimlilik sifir, Windows'un kendi API'si.
pub fn audio_control(action: &str, value: Option<f64>) -> serde_json::Value {
    let ps_type = r#"
if (-not ('AudioCtl' -as [type])) {
Add-Type -Language CSharp @'
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
// VTABLE SIRASI BIREBIR DOGRU OLMALI: COM cagrilari isme gore degil SIRAYA
// gore baglanir. Bir slot kaydiginda yanlis fonksiyon cagrilir ve hata
// "Deger beklenen aralikta degil" gibi ALAKASIZ gorunur (sahada boyle
// yakalandi: SetMute/GetMute iki slot kaymisti, cunku kanal-volume metotlari
// sayilmamisti). Resmi sira:
//  1 RegisterControlChangeNotify   2 UnregisterControlChangeNotify
//  3 GetChannelCount               4 SetMasterVolumeLevel
//  5 SetMasterVolumeLevelScalar    6 GetMasterVolumeLevel
//  7 GetMasterVolumeLevelScalar    8 SetChannelVolumeLevel
//  9 SetChannelVolumeLevelScalar  10 GetChannelVolumeLevel
// 11 GetChannelVolumeLevelScalar  12 SetMute
// 13 GetMute                      14 GetVolumeStepInfo ...
interface IAudioEndpointVolume {
  int f1(); int f2(); int f3(); int f4();
  int SetMasterVolumeLevelScalar(float level, System.Guid ctx);   // 5
  int f6();
  int GetMasterVolumeLevelScalar(out float level);                // 7
  int f8(); int f9(); int f10(); int f11();
  int SetMute(bool mute, System.Guid ctx);                        // 12
  int GetMute(out bool mute);                                     // 13
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref System.Guid id, int clsCtx, int act, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice dev); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class AudioCtl {
  static IAudioEndpointVolume Vol() {
    IMMDeviceEnumerator e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev; e.GetDefaultAudioEndpoint(0, 1, out dev);
    System.Guid g = typeof(IAudioEndpointVolume).GUID;
    IAudioEndpointVolume aev; dev.Activate(ref g, 23, 0, out aev); return aev;
  }
  public static float Get() { float v; Vol().GetMasterVolumeLevelScalar(out v); return v * 100; }
  public static void Set(float p) { Vol().SetMasterVolumeLevelScalar(p / 100, System.Guid.Empty); }
  public static bool Muted() { bool m; Vol().GetMute(out m); return m; }
  public static void Mute(bool m) { Vol().SetMute(m, System.Guid.Empty); }
}
'@
}
"#;

    let body = match action {
        "oku" => "[pscustomobject]@{ seviye = [math]::Round([AudioCtl]::Get()); susturuldu = [AudioCtl]::Muted() } | ConvertTo-Json -Compress".to_string(),
        "ayarla" => {
            let v = value.unwrap_or(50.0).clamp(0.0, 100.0);
            format!("[AudioCtl]::Set({v}); [pscustomobject]@{{ seviye = [math]::Round([AudioCtl]::Get()) }} | ConvertTo-Json -Compress")
        }
        "sustur" => "[AudioCtl]::Mute($true); [pscustomobject]@{ susturuldu = $true } | ConvertTo-Json -Compress".to_string(),
        "ac" => "[AudioCtl]::Mute($false); [pscustomobject]@{ susturuldu = $false } | ConvertTo-Json -Compress".to_string(),
        other => {
            return serde_json::json!({
                "hata": format!("bilinmeyen islem '{other}'; gecerli: oku, ayarla, sustur, ac")
            })
        }
    };

    // Etiketli: bu cagrinin script'i ~2 KB C# blogu. Tam halini her seferinde
    // stderr'e basmak gercek terminal cagrilarini gorunmez kiliyordu.
    let etiket = format!("ses kontrol: {action}");
    let out = run_powershell_opts(&format!("{ps_type}\n{body}"), PsOpts::labeled(&etiket));
    parse_json_output(out, "ses kontrolu basarisiz")
}

/// Calisan uygulamalar (pencereli olanlar) — "neler acik" sorusunun cevabi.
pub fn running_apps() -> serde_json::Value {
    let script = r#"
Get-Process | Where-Object { $_.MainWindowTitle -ne '' } |
  Sort-Object -Property @{Expression={$_.WorkingSet64}; Descending=$true} |
  Select-Object -First 20 @{n='uygulama';e={$_.ProcessName}}, @{n='baslik';e={$_.MainWindowTitle}},
    @{n='ram_mb';e={[math]::Round($_.WorkingSet64/1MB)}} | ConvertTo-Json -Compress
"#;
    let out = run_powershell_opts(script, PsOpts::labeled("acik uygulamalar"));
    parse_json_output(out, "uygulama listesi alinamadi")
}

/// Web okuma vekili. Sayfayi LLM-dostu duz metne cevirir ve 403/JS duvarlarini
/// asar (hafizada kayitli: TAAFT gibi siteler yalniz bu yolla okunabildi).
const READER: &str = "https://r.jina.ai/";
/// Web ciktisi ust siniri — arama sonucu modelin baglamini bogmamali.
const MAX_WEB: usize = 6 * 1024;

/// Internette arar ve sonuc metnini dondurur.
///
/// NEDEN KENDI ARACIMIZ: Gemini'nin yerlesik `googleSearch` araci Live'da
/// OLCULDU ve **free-tier'da kota hatasi** veriyor (setup semasi kabul ediliyor
/// ama her varyant 1011 "exceeded your current quota" ile kapaniyor; yalniz
/// functionDeclarations'li setup calisiyor). Yani ucretli ozellik. Kullanicinin
/// "internet arastirmasi yok" eksigini kapatmak icin arama kendi tarafimizda
/// yapilir: DuckDuckGo HTML ucu, r.jina.ai okuma vekiliyle duz metne cevrilir.
/// Ucretsiz, anahtarsiz, herkese acik veri.
/// DOSYA SISTEMI — ad/desen ile dosya arar.
///
/// Neden ayri arac: `terminal_calistir` teknik olarak her seyi yapabilir ama
/// model serbest PowerShell yazmak zorunda kalinca yanlis/yavas komut uretiyor
/// (or. tum diski tarayan `Get-ChildItem -Recurse`). Bu arac aramayi guvenli
/// varsayilanlara sabitler: kullanici klasorleri + derinlik siniri + sonuc
/// tavani + gurultu dizinlerini (node_modules, .git, target) haric tutma.
/// Ayrica MUSTERI VERISI kara listesi burada uygulanir (ADR 0004).
pub fn file_search(pattern: &str, root: Option<&str>) -> serde_json::Value {
    if pattern.trim().is_empty() {
        return serde_json::json!({ "hata": "desen bos" });
    }
    let base = root
        .filter(|r| !r.trim().is_empty())
        .unwrap_or("C:\\Users\\alice");

    let etiket = format!("dosya ara: '{pattern}' ({base})");
    match run_powershell_opts(&file_search_script(base, pattern), PsOpts::labeled(&etiket)) {
        v if v.get("cikti").is_some() => {
            let raw = v["cikti"].as_str().unwrap_or("").trim().to_string();
            if raw.is_empty() {
                return serde_json::json!({ "sonuc": [], "not": "eslesen dosya yok" });
            }
            match serde_json::from_str::<serde_json::Value>(&raw) {
                Ok(parsed) => serde_json::json!({ "sonuc": parsed }),
                Err(_) => serde_json::json!({ "sonuc_metin": raw }),
            }
        }
        other => other,
    }
}

/// PowerShell dizi literali uretir: `'a','b'`. Tek tirnak kacisi `''`.
fn ps_string_array(items: &[&str]) -> String {
    items
        .iter()
        .map(|s| format!("'{}'", s.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",")
}

/// Arama script'ini uretir. Ayri fonksiyon: kara listenin GERCEKTEN script'e
/// girdigini surec acmadan test edebilmek icin (`arama_scripti_ortak_listeyi_tasir`).
///
/// Tek tirnak kacisi BURADA yapilir — script'i kuran, icine giren her metni de
/// kacirmali; kacisi cagirana birakmak "biri unutur" sinifindan bir aciktir.
///
/// `$skip` artik REGEX degil duz metin: eskiden `'\.git\\'` gibi kacisli regex
/// parcalariydi ve ayni desenin Rust tarafindaki yazimindan farkliydi — tek
/// kaynak ancak tek SEMANTIKLE mumkun. Kucuk harfe cevirme
/// `ToLowerInvariant` ile yapilir: `ToLower()` gecerli kulturu kullanir ve
/// tr-TR'de 'I' -> 'ı' katlar, yani "ID_RSA" gibi bir yol eslesmezdi.
fn file_search_script(base: &str, pattern: &str) -> String {
    let skip: Vec<&str> = SEARCH_NOISE
        .iter()
        .chain(PRIVACY_DENY.iter())
        .copied()
        .collect();
    let base = base.replace('\'', "''");
    let safe_pattern = pattern.replace('\'', "''");
    format!(
        r#"
$ErrorActionPreference = 'SilentlyContinue'
# Gurultu + GIZLILIK KARA LISTESI — TEK KAYNAK: system_tools::{{SEARCH_NOISE, PRIVACY_DENY}}.
$skip = {skip}
Get-ChildItem -Path '{base}' -Filter '{safe_pattern}' -Recurse -Depth 5 -File |
  Where-Object {{ $p = $_.FullName.ToLowerInvariant(); -not ($skip | Where-Object {{ $p.Contains($_) }}) }} |
  Select-Object -First 40 |
  ForEach-Object {{ [pscustomobject]@{{
      yol = $_.FullName
      kb = [math]::Round($_.Length/1KB,1)
      tarih = $_.LastWriteTime.ToString('yyyy-MM-dd')
  }} }} | ConvertTo-Json -Compress -Depth 3
"#,
        skip = ps_string_array(&skip)
    )
}

/// Dosyanin ilk `limit` karakterini kapsayan bayt penceresini okur: UTF-8'de
/// bir karakter en fazla 4 bayttir ve "kesildi" bayragi icin `limit + 1`.
/// karakter gerekir; ikili tespiti icin de en az `IKILI_TESPIT_BAYT`. Tum
/// dosya okunmaz: kirpmadan once dosya boyutu kadar bellek ayirmak buyuk veya
/// sparse bir dosyada bellegi tuketirdi.
fn file_prefix(reader: impl std::io::Read, limit: usize) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let pencere = limit
        .saturating_add(1)
        .saturating_mul(4)
        .max(IKILI_TESPIT_BAYT);
    let mut bytes = Vec::new();
    reader.take(pencere as u64).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// DOSYA OKUMA — bir dosyanin ilk N karakterini dondurur.
///
/// Sinir bilincli: tam dosya modelin baglamini doldurur ve kotayi yakar.
/// Ikili dosyalar reddedilir (anlamsiz bayt yigini modele gitmesin).
pub fn file_read(path: &str, max_chars: Option<usize>) -> serde_json::Value {
    let limit = max_chars.unwrap_or(4000).min(20_000);
    // Kara liste ONCE: gizlilik siniri, dosyanin VAR OLUP OLMADIGINDAN once
    // gelir. Eskiden `is_file()` ondeydi ve kara listedeki bir yol icin
    // "dosya yok" / "kara listede" ayrimi dosyanin varligini sizdiriyordu.
    // Liste tek kaynaktan gelir (bkz. `PRIVACY_DENY`).
    if privacy_denied(path) {
        return serde_json::json!({
            "hata": "bu dosya gizlilik kara listesinde (musteri verisi/sir) — okunmadi"
        });
    }
    let p = std::path::Path::new(path);
    if !p.is_file() {
        return serde_json::json!({ "hata": format!("dosya yok: {path}") });
    }
    match std::fs::File::open(p).and_then(|dosya| file_prefix(dosya, limit)) {
        Ok(bytes) => {
            // Ikili tespiti: ilk 1KB'de NUL varsa metin degil.
            if bytes.iter().take(IKILI_TESPIT_BAYT).any(|b| *b == 0) {
                return serde_json::json!({ "hata": "ikili dosya — metin olarak okunamaz" });
            }
            let text = String::from_utf8_lossy(&bytes);
            let truncated: String = text.chars().take(limit).collect();
            serde_json::json!({
                "yol": path,
                "icerik": truncated,
                "kesildi": text.chars().count() > limit
            })
        }
        Err(e) => serde_json::json!({ "hata": format!("okunamadi: {e}") }),
    }
}

pub fn web_search(query: &str) -> serde_json::Value {
    if query.trim().is_empty() {
        return serde_json::json!({ "hata": "sorgu bos" });
    }
    eprintln!("[web] arama: {}", log_komutu(query));
    let encoded = url_encode(query);
    let url = format!("{READER}https://duckduckgo.com/html/?q={encoded}");
    match fetch_text(&url) {
        Ok(text) => serde_json::json!({ "sorgu": query, "sonuclar": text }),
        Err(e) => serde_json::json!({ "hata": format!("arama basarisiz: {e}") }),
    }
}

/// Bir web sayfasini okur (duz metin).
pub fn web_read(url: &str) -> serde_json::Value {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return serde_json::json!({ "hata": "gecerli bir http(s) adresi ver" });
    }
    eprintln!("[web] oku: {}", log_komutu(u));
    match fetch_text(&format!("{READER}{u}")) {
        Ok(text) => serde_json::json!({ "adres": u, "icerik": text }),
        Err(e) => serde_json::json!({ "hata": format!("sayfa okunamadi: {e}") }),
    }
}

fn fetch_text(url: &str) -> Result<String, String> {
    fetch_text_timeout(url, Duration::from_secs(20))
}

/// Web istegi: `timeout` toplam, baglanti ve govde okuma icin acik son tarih;
/// govde en fazla `MAX_WEB + 1` bayt okunur (kirpildi isareti icin bir bayt
/// fazla). Eskiden zaman asimsiz istek yanit vermeyen sunucuda asili kaliyor ve
/// `read_to_string` tum govdeyi bellege alip sonra kirpiyordu.
fn fetch_text_timeout(url: &str, timeout: Duration) -> Result<String, String> {
    use std::io::Read;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .timeout_connect(Some(timeout.min(Duration::from_secs(5))))
        .timeout_recv_body(Some(timeout.min(Duration::from_secs(10))))
        .build()
        .into();
    let mut resp = agent
        .get(url)
        .header("Accept", "text/plain")
        .call()
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(MAX_WEB + 1);
    resp.body_mut()
        .as_reader()
        .take((MAX_WEB + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let body = String::from_utf8_lossy(&bytes);
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("bos yanit".into());
    }
    if trimmed.len() <= MAX_WEB {
        return Ok(trimmed.to_string());
    }
    let mut cut = MAX_WEB;
    while cut > 0 && !trimmed.is_char_boundary(cut) {
        cut -= 1;
    }
    Ok(format!("{}\n…[kirpildi]", &trimmed[..cut]))
}

/// Minimal yuzde kodlama (sorgu dizesi icin). Harici bagimlilik eklemeye
/// deger bir is degil; alfanumerik + `-_.~` disi her bayt kodlanir.
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// ZEKA YUKSELTMESI — "hizli agiz, guclu beyin" deseni.
///
/// Sorun (kullanici: "zekasi cok geri"): Live sesli modeli `gemini-3.8-live`
/// (once `gemini-3.1-flash-live-preview`) **flash sinifi** — dusuk gecikme
/// icin secildi ama akil yurutmede zayif; ayrica free-tier'da pro modeller ve
/// googleSearch KOTA ile kapali (olculdu: 429 / 1011).
///
/// DUSUNME SINIFI ARTIK VAR, AMA BU DESENE TAKILIR (2026-09-18): Google
/// `gemini-3.8-live-extended-thinking`'i GA'ya aldi ve bu anahtarla
/// ACILIYOR (olculdu: setupComplete 422 ms, aracsiz setup). Ancak arac
/// bildirimi iceren setup'i 1007 ile reddediyor: "BLOCKING function calls
/// are not supported for this model" — yani bu model YALNIZ zaman uyumsuz
/// arac modunu kabul ediyor. Smith'in arac hatti ise senkron (`ARAC_DAVRANISI`,
/// audio/live.rs). Bu yuzden kopru deseni DURUYOR: extended-thinking'e gecis,
/// once zaman uyumsuz arac yolunun kurulmasini gerektirir.
///
/// Cozum: zor sorularda Live modeli konusmayi surdurur ama cevabi DAHA GUCLU
/// bir modele sorar. Olculdu: `gemini-flash-latest` (lite DEGIL) ayni istemde
/// dogru ve gerekcelendirilmis Turkce cevap verdi. Ucretli anahtar gelirse
/// `SMITH_THINK_MODEL`/`_BASE_URL`/`_API_KEY` ile daha guclusune cevrilir —
/// kod degismez.
pub fn deep_think(question: &str) -> serde_json::Value {
    if question.trim().is_empty() {
        return serde_json::json!({ "hata": "soru bos" });
    }
    let engine = std::env::var("SMITH_THINK_ENGINE").unwrap_or_else(|_| "gemini".into());
    let timeout_env = std::env::var("SMITH_THINK_TIMEOUT_S").ok();
    let timeout_s = think_timeout_s(timeout_env.as_deref());
    think_with(
        &engine,
        Duration::from_secs(timeout_s),
        |remaining| claude_think(question, remaining),
        |remaining| gemini_think(question, remaining),
    )
}

fn think_with(
    engine: &str,
    timeout: Duration,
    claude: impl FnOnce(Duration) -> Result<String, &'static str>,
    gemini: impl FnOnce(Duration) -> serde_json::Value,
) -> serde_json::Value {
    let started = Instant::now();
    let deadline = started.checked_add(timeout).unwrap_or(started);
    let mut result = if engine == "claude" {
        match claude(deadline.saturating_duration_since(Instant::now())) {
            Ok(text) => serde_json::json!({"cevap": text, "motor": "claude"}),
            Err(reason) => {
                eprintln!("[think] Claude kullanilamadi: {reason}; Gemini yedegi");
                let remaining = deadline.saturating_duration_since(Instant::now());
                let mut v = if remaining.is_zero() {
                    serde_json::json!({"hata": "derin dusunme toplam zaman sinirina ulasti"})
                } else {
                    gemini(remaining)
                };
                v["motor"] = serde_json::json!("gemini-yedek");
                v["yedek_nedeni"] = serde_json::json!(reason);
                v
            }
        }
    } else {
        let mut v = gemini(deadline.saturating_duration_since(Instant::now()));
        v["motor"] = serde_json::json!("gemini");
        v
    };
    result["zaman_siniri_sn"] = serde_json::json!(timeout.as_secs());
    result["sure_ms"] = serde_json::json!(started.elapsed().as_millis());
    result
}

fn think_bash(model: &str, timeout: Duration) -> String {
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\"'\"'"));
    let timeout_arg = format!("{:.3}s", timeout.as_secs_f64().max(0.001));
    // CLI safe-mode abonelik kimligini korur, hooks/skills/plugins'i kapatir.
    // env -u: bir API key varsa bile kisisel abonelik hattini sec.
    format!(
        "env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL \
         -u CLAUDE_CODE_USE_BEDROCK -u CLAUDE_CODE_USE_VERTEX -u CLAUDE_CODE_USE_FOUNDRY \
         timeout --signal=TERM --kill-after=2s {timeout_arg} claude -p \
         --safe-mode --tools '' --strict-mcp-config --mcp-config '{{\"mcpServers\":{{}}}}' \
         --disable-slash-commands --no-session-persistence --model {} \
         --output-format json",
        quote(model)
    )
}

fn parse_think(raw: &str) -> Result<String, &'static str> {
    let v: serde_json::Value = serde_json::from_str(raw).map_err(|_| "CLI sonucu JSON degil")?;
    if v["type"] != "result" || v["subtype"] != "success" || v["is_error"] != false {
        return Err("Claude basarili sonuc vermedi");
    }
    v["result"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .ok_or("Claude cevabi bos")
}

fn claude_unrecognized_model(raw: &str) -> bool {
    raw.contains("[claude-code:unrecognized_model]")
}

fn think_timeout_s(raw: Option<&str>) -> u64 {
    raw.and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(120)
        .clamp(10, 600)
}

fn claude_think(question: &str, budget: Duration) -> Result<String, &'static str> {
    let model = std::env::var("SMITH_THINK_CLAUDE_MODEL").unwrap_or_else(|_| "opus".into());
    let started = Instant::now();
    let deadline = started.checked_add(budget).unwrap_or(started);
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("derin dusunme toplam zaman siniri doldu");
    }
    let line = think_bash(&model, remaining);
    let raw = run_wsl_bounded_stdin(&line, remaining, question);
    if claude_unrecognized_model(&raw) {
        eprintln!("[think] Claude model '{model}' taninmadi; 'opus' ile tekrar deneniyor");
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("derin dusunme toplam zaman siniri doldu");
        }
        let retry = think_bash("opus", remaining);
        parse_think(&run_wsl_bounded_stdin(&retry, remaining, question))
    } else {
        parse_think(&raw)
    }
}

fn gemini_think(question: &str, budget: Duration) -> serde_json::Value {
    let base = std::env::var("SMITH_THINK_BASE_URL")
        .unwrap_or_else(|_| "https://generativelanguage.googleapis.com/v1beta/openai".into());
    let model = std::env::var("SMITH_THINK_MODEL").unwrap_or_else(|_| "gemini-flash-latest".into());
    let key = std::env::var("SMITH_THINK_API_KEY")
        .or_else(|_| std::env::var("SMITH_GEMINI_KEY"))
        .unwrap_or_default();
    if key.is_empty() {
        return serde_json::json!({ "hata": "dusunme modeli icin anahtar yok" });
    }
    gemini_think_with(question, &base, &model, &key, budget)
}

fn gemini_think_with(
    question: &str,
    base: &str,
    model: &str,
    key: &str,
    budget: Duration,
) -> serde_json::Value {
    if budget.is_zero() {
        return serde_json::json!({ "hata": "derin dusunme toplam zaman sinirina ulasti" });
    }
    eprintln!("[think] {model}: istek gonderiliyor");

    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": "Turkce, kisa ve KESIN cevap ver. Adim adim dusun ama \
    yalniz SONUCU yaz. Emin olmadigin yeri acikca belirt." },
            { "role": "user", "content": question }
        ]
    });
    let connect = budget.min(Duration::from_secs(5));
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(budget))
        .timeout_connect(Some(connect))
        .timeout_recv_response(Some(budget))
        .timeout_recv_body(Some(budget))
        .build()
        .into();
    let result = agent
        .post(format!("{base}/chat/completions"))
        .header("Authorization", format!("Bearer {key}"))
        .send_json(&body)
        .map_err(|e| e.to_string())
        .and_then(|mut r| {
            r.body_mut()
                .read_json::<serde_json::Value>()
                .map_err(|e| e.to_string())
        });
    match result {
        Ok(v) => match v["choices"][0]["message"]["content"].as_str() {
            Some(text) => serde_json::json!({ "cevap": text }),
            None => {
                serde_json::json!({ "hata": format!("beklenmeyen yanit: {}", &v.to_string()[..v.to_string().len().min(200)]) })
            }
        },
        Err(e) => serde_json::json!({ "hata": format!("dusunme modeli hatasi: {e}") }),
    }
}

/// `run_powershell` ciktisindaki JSON metnini gercek JSON'a cevirir.
///
/// Neden ayri: PowerShell `ConvertTo-Json` STRING dondurur; onu modele string
/// olarak vermek "JSON'u tekrar ayristir" isini modele yikardi. Ayristirma
/// basarisizsa ham cikti geri verilir (bilgi kaybetmemek icin).
fn parse_json_output(out: serde_json::Value, err_label: &str) -> serde_json::Value {
    if out.get("hata").is_some() {
        return out;
    }
    let raw = out.get("cikti").and_then(|v| v.as_str()).unwrap_or("");
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(v) => v,
        Err(_) if raw.trim().is_empty() => serde_json::json!({ "hata": err_label }),
        Err(_) => serde_json::json!({ "cikti": raw }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn think_command_tools_and_shell_injection() {
        let prompt_path = "/mnt/c/a'b/prompt.txt";
        let cmd = think_bash("model'$(touch x)", Duration::from_secs(120));
        assert!(cmd.contains("--tools '' --strict-mcp-config"));
        assert!(cmd.contains("--safe-mode"));
        assert!(cmd.contains("--no-session-persistence"));
        assert!(cmd.contains("--model 'model'\"'\"'$(touch x)'"));
        assert!(
            !cmd.contains(prompt_path) && cmd.ends_with("--output-format json"),
            "soru dosya yoluyla degil stdin ile aktarilmali: {cmd}"
        );
        assert!(!cmd.contains("dangerously"));
        assert!(cmd.contains("timeout --signal=TERM --kill-after=2s 120.000s"));
    }

    #[test]
    fn think_json_and_fallback_are_fail_closed() {
        assert_eq!(
            parse_think(r#"{"type":"result","subtype":"success","is_error":false,"result":"6"}"#),
            Ok("6".into())
        );
        for bad in [
            "",
            "ZAMAN ASIMI\n{}",
            "cikis kodu 1\n{}",
            "Not logged in",
            "{}",
            r#"{"type":"result","subtype":"success","is_error":true,"result":"6"}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":" "}"#,
        ] {
            assert!(parse_think(bad).is_err());
            let v = think_with(
                "claude",
                Duration::from_secs(120),
                |_| parse_think(bad),
                |_| serde_json::json!({"cevap":"yedek"}),
            );
            assert_eq!(v["motor"], "gemini-yedek");
            assert_eq!(v["cevap"], "yedek");
        }
        assert!(claude_unrecognized_model(
            "cikis kodu 1\n[claude-code:unrecognized_model] {\"model\":\"x\"}"
        ));
        assert!(!claude_unrecognized_model(
            "cikis kodu 1\n[claude-code:auth_error] giris yok"
        ));
        let v = think_with(
            "claude",
            Duration::from_secs(120),
            |_| Ok("6".into()),
            |_| panic!("Gemini cagrilmamali"),
        );
        assert_eq!(v["motor"], "claude");
        let v = think_with(
            "gemini",
            Duration::from_secs(120),
            |_| panic!("Claude cagrilmamali"),
            |_| serde_json::json!({"cevap":"6"}),
        );
        assert_eq!(v["motor"], "gemini");
        assert_eq!(v["zaman_siniri_sn"], 120);
        let v = think_with(
            "claude",
            Duration::from_secs(120),
            |_| Err("giris yok"),
            |_| serde_json::json!({"hata":"anahtar yok"}),
        );
        assert!(v.get("cevap").is_none());
        assert_eq!(v["motor"], "gemini-yedek");
    }

    #[test]
    fn think_timeout_10_ile_600_arasina_kisilir() {
        for (raw, expected) in [
            (None, 120),
            (Some("bozuk"), 120),
            (Some("0"), 10),
            (Some("1"), 10),
            (Some("10"), 10),
            (Some("120"), 120),
            (Some("600"), 600),
            (Some("999999"), 600),
        ] {
            assert_eq!(think_timeout_s(raw), expected, "raw={raw:?}");
        }
    }

    #[test]
    fn think_yedegi_ayri_tavan_degil_kalan_toplam_butceyi_kullanir() {
        let gemini_budget = std::cell::Cell::new(Duration::ZERO);
        let result = think_with(
            "claude",
            Duration::from_secs(1),
            |_| {
                std::thread::sleep(Duration::from_millis(20));
                Err("claude yok")
            },
            |remaining| {
                gemini_budget.set(remaining);
                serde_json::json!({"cevap":"yedek"})
            },
        );
        assert!(gemini_budget.get() > Duration::ZERO);
        assert!(gemini_budget.get() < Duration::from_secs(1));
        assert_eq!(result["zaman_siniri_sn"], 1);
        assert!(result["sure_ms"].as_u64().is_some());
    }

    #[test]
    fn yanit_vermeyen_gemini_cagrisi_sinirli_surede_doner() {
        use crate::gateway::test_sunucu::{Davranis, Sunucu};

        let sunucu = Sunucu::baslat(|_, _| Davranis::Sessiz);
        let started = Instant::now();
        let result = gemini_think_with(
            "2 ile 3'u carp",
            &sunucu.taban,
            "test-model",
            "test-key",
            Duration::from_millis(100),
        );
        let elapsed = started.elapsed();
        assert!(result.get("hata").is_some(), "yanitsiz sunucu: {result}");
        assert!(
            elapsed < Duration::from_millis(500),
            "Gemini timeout uygulanmadi: {elapsed:?}"
        );
        sunucu.bitir();
    }

    #[test]
    fn web_loglari_sirlari_maskeler() {
        for girdi in [
            "smith token=super-secret aramasi",
            "https://example.test/?api_key=super-secret",
        ] {
            let log = log_komutu(girdi);
            assert!(!log.contains("super-secret"), "sir loga sizdi: {log}");
            assert!(log.contains("[MASKELI]"), "maske yok: {log}");
        }
    }

    #[test]
    fn web_okuma_yanit_vermeyen_sunucuda_sinirli_surede_doner() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut istek = [0u8; 4096];
            let _ = stream.read(&mut istek);
            // Basliklar gelir, govde hic gelmez.
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n");
            std::thread::sleep(Duration::from_secs(1));
        });
        let basladi = Instant::now();
        let sonuc = fetch_text_timeout(&url, Duration::from_millis(150));
        let gecen = basladi.elapsed();
        assert!(sonuc.is_err(), "govdesi gelmeyen yanit: {sonuc:?}");
        assert!(
            gecen < Duration::from_millis(800),
            "web zaman asimi uygulanmadi: {gecen:?}"
        );
        server.join().unwrap();
    }

    #[test]
    fn web_okuma_govdeyi_tamamini_beklemeden_kirpar() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut istek = [0u8; 4096];
            let _ = stream.read(&mut istek);
            // 20 MB bildirir, tavandan yalniz bir bayt fazlasini yollar ve keser.
            let baslik = "HTTP/1.1 200 OK\r\nContent-Length: 20000000\r\n\r\n";
            let _ = stream.write_all(baslik.as_bytes());
            let _ = stream.write_all(&vec![b'a'; MAX_WEB + 1]);
        });
        let sonuc = fetch_text(&url);
        server.join().unwrap();
        let metin = sonuc.expect("tavan kadar govde yeterli olmali");
        assert!(metin.ends_with("[kirpildi]"), "uzunluk: {}", metin.len());
    }

    #[test]
    #[ignore = "canli Claude abonelik ve WSL sondasi"]
    fn canli_claude_stdin_sondasi() {
        let started = Instant::now();
        let answer = claude_think("2 ile 3'u carp, yalniz sayiyi yaz", Duration::from_secs(60))
            .expect("Claude canli sonda basarisiz");
        println!(
            "[CANLI THINK] cevap={answer:?} sure_ms={}",
            started.elapsed().as_millis()
        );
        assert_eq!(answer.trim(), "6");
    }

    #[test]
    fn terminal_tum_yanit_tiplerinde_basari_kanit_gerektirir() {
        for (raw, success, status) in [
            (
                serde_json::json!({"cikis_kodu":0,"cikti":"ok"}),
                true,
                "bitti",
            ),
            (
                serde_json::json!({"durum":"bitti","cikis_kodu":7}),
                false,
                "hata",
            ),
            (serde_json::json!({"durum":"bitti"}), false, "hata"),
            (serde_json::json!({"hata":"baslatilamadi"}), false, "hata"),
            (
                serde_json::json!({"durum":"reddedildi","hata":"gizlilik"}),
                false,
                "reddedildi",
            ),
            (
                serde_json::json!({"durum":"reddedildi","hata":"felaket"}),
                false,
                "reddedildi",
            ),
            (
                serde_json::json!({"durum":"arka planda calisiyor","pid":123}),
                false,
                "calisiyor",
            ),
            (
                serde_json::json!({"durum":"pencere arka planda acildi","pid":123}),
                false,
                "calisiyor",
            ),
            (
                serde_json::json!({"durum":"iptal_isteniyor"}),
                false,
                "calisiyor",
            ),
            (
                serde_json::json!({"durum":"iptal","cikis_kodu":0}),
                false,
                "hata",
            ),
            (serde_json::json!({"durum":"cikti_kotasi"}), false, "hata"),
            (serde_json::json!({"durum":"bilinmiyor"}), false, "hata"),
            (
                serde_json::json!({"durum":"zaman_asimi","kismi_cikti":"basladi"}),
                false,
                "zaman_asimi",
            ),
        ] {
            let v = terminal_sonucu(raw);
            assert_eq!(v["basarili"], success, "{v}");
            assert_eq!(v["durum"], status, "{v}");
            assert_eq!(terminal_sonucu(v.clone()), v, "sozlesme idempotent olmali");
            if status == "zaman_asimi" {
                assert!(v["aciklama"]
                    .as_str()
                    .unwrap()
                    .contains("komut BITMEDI, sonucu yok; basari iddia etme"));
            }
        }
    }

    #[test]
    fn terminal_sonuc_sozlesmesi_red_ve_cikis() {
        let red = terminal_calistir("Get-Content C:\\x\\.env", false);
        assert_eq!(red["basarili"], false);
        assert_eq!(red["durum"], "reddedildi");
        for (cmd, success, status) in [("exit 0", true, "bitti"), ("exit 7", false, "hata")] {
            let v = terminal_calistir(cmd, false);
            assert_eq!(v["basarili"], success, "{v}");
            assert_eq!(v["durum"], status, "{v}");
        }
        let v = arka_plan_iptal("../invalid");
        assert_eq!(v["basarili"], false);
        assert_eq!(v["durum"], "hata");
    }

    /// PowerShell non-terminating hatayi `$Error`a yazar ama 0 ile cikar; kosu
    /// sonu kapisi bunu basari saymamali ve hata metnini korumali.
    #[cfg(windows)]
    #[test]
    fn sonlanmayan_powershell_hatasi_basari_sayilmaz() {
        for cmd in [
            "Write-Error 'smith-test-hatasi'; Write-Output 'devam'",
            "Write-Error 'smith-test-hatasi'; exit 0",
            "Write-Error 'smith-test-hatasi'; cmd /c exit 0",
            "Get-Item 'C:\\smith-olmayan-yol-1f3a'",
        ] {
            let v = terminal_calistir(cmd, false);
            assert_eq!(v["basarili"], false, "{cmd}: {v}");
            assert_eq!(v["durum"], "hata", "{cmd}: {v}");
            assert!(
                !v["hata_cikti"].as_str().unwrap_or("").is_empty(),
                "{cmd}: {v}"
            );
        }
        // Son native komutun sifir disi kodu, sonraki basarili cmdlet'e ragmen korunur.
        let v = terminal_calistir("cmd /c exit 3; Write-Output 'sonra'", false);
        assert_eq!(v["cikis_kodu"], 3, "{v}");
        assert_eq!(v["basarili"], false, "{v}");
    }

    fn is_test_kilidi() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Assertion/panic durumunda da sadece bu testin islerini kapatir.
    struct IsTestAlani(PathBuf);
    impl Drop for IsTestAlani {
        fn drop(&mut self) {
            let kayitlar: Vec<_> = isler()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .values()
                .filter(|k| k.dizin == self.0)
                .cloned()
                .collect();
            for k in &kayitlar {
                k.iptal.store(true, std::sync::atomic::Ordering::Release);
            }
            let start = Instant::now();
            while kayitlar
                .iter()
                .any(|k| k.bitti.lock().unwrap_or_else(|e| e.into_inner()).is_none())
                && start.elapsed() < Duration::from_secs(5)
            {
                std::thread::sleep(Duration::from_millis(20));
            }
            let _ = std::fs::remove_dir_all(&self.0);
            isler()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .retain(|_, k| k.dizin != self.0);
        }
    }

    #[cfg(windows)]
    #[test]
    fn audit_cancel_kills_job_tree_and_is_idempotent() {
        let _lock = is_test_kilidi();
        let dir = test_is_dizini("audit-cancel");
        let _cleanup = IsTestAlani(dir.clone());
        let marker = dir.join("child.pid");
        let script = format!("$p = Start-Process cmd.exe -ArgumentList '/c ping -t 127.0.0.1' -NoNewWindow -PassThru; Set-Content -LiteralPath '{}' -Value $p.Id; $p.WaitForExit()", marker.display());
        let v = arka_plan_is_baslat_in(&dir, &script);
        let id = v["is_id"].as_str().expect("job id");
        let pid = isaret_bekle(&marker, Duration::from_secs(15))
            .expect("child pid")
            .trim()
            .parse::<u32>()
            .unwrap();
        let child = is_agaci::surec_ac(pid).expect("child must initially be alive");
        assert_eq!(arka_plan_iptal(id)["is_durumu"], "iptal_isteniyor");
        let result = is_sonunu_bekle(&dir, id);
        assert_eq!(result["is_durumu"], "iptal", "{result}");
        assert!(
            is_agaci::cikis_kodu(&child).unwrap().is_some(),
            "child survived cancellation"
        );
        assert_eq!(arka_plan_iptal(id)["is_durumu"], "iptal");
        assert!(arka_plan_iptal("../x").get("hata").is_some());
        assert!(arka_plan_iptal("ffffffffffffffffffffffffffffffff")
            .get("hata")
            .is_some());
    }

    fn is_sonunu_bekle(dir: &Path, id: &str) -> serde_json::Value {
        let start = Instant::now();
        loop {
            let s = arka_plan_sonuc_in(dir, id);
            if s["durum"] != "calisiyor" || start.elapsed() >= Duration::from_secs(20) {
                return s;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(windows)]
    #[test]
    fn audit_comment_cannot_escape_real_timeout() {
        let _lock = is_test_kilidi();
        let start = Instant::now();
        let result = terminal_calistir_sureli(
            "while ($true) { Start-Sleep 60 } # $f.ShowDialog()",
            false,
            Some(5),
        );
        assert!(
            result["hata"]
                .as_str()
                .is_some_and(|s| s.contains("5 saniye")),
            "{result}"
        );
        assert!(start.elapsed() < Duration::from_secs(9));
    }

    #[cfg(windows)]
    #[test]
    fn audit_root_exit_does_not_leave_descendant_or_reader() {
        let _lock = is_test_kilidi();
        let marker = test_isareti("audit-root-exit");
        let script = format!("$p = Start-Process cmd.exe -ArgumentList '/c ping -n 13 127.0.0.1' -NoNewWindow -PassThru; Set-Content -LiteralPath '{}' -Value $p.Id; exit 0", marker.display());
        let start = Instant::now();
        let result = terminal_calistir_sureli(&script, false, Some(5));
        let pid = std::fs::read_to_string(&marker)
            .expect("child pid")
            .trim()
            .parse::<u32>()
            .unwrap();
        let gone = is_agaci::surec_ac(pid)
            .map(|h| is_agaci::cikis_kodu(&h).unwrap().is_some())
            .unwrap_or(true);
        let _ = std::fs::remove_file(marker);
        assert!(
            result["hata"]
                .as_str()
                .is_some_and(|s| s.contains("5 saniye")),
            "{result}"
        );
        assert!(gone, "root exited but child survived");
        assert!(start.elapsed() < Duration::from_secs(9));
    }

    #[cfg(windows)]
    #[test]
    fn audit_successful_no_wait_launcher_keeps_its_child() {
        let _lock = is_test_kilidi();
        let marker = test_isareti("audit-launcher");
        let script = format!("Start-Process -FilePath $env:ComSpec -ArgumentList '/c ping -n 4 127.0.0.1 >nul & echo done > \"{}\"' -WindowStyle Hidden", marker.display());
        let result = terminal_calistir_sureli(&script, false, Some(5));
        let survived = isaret_bekle(&marker, Duration::from_secs(7)).is_some();
        let _ = std::fs::remove_file(marker);
        assert_eq!(result["cikis_kodu"], 0, "{result}");
        assert!(survived, "successful launcher killed its child");
    }

    #[test]
    fn audit_cleanup_prunes_expired_records_and_files_only() {
        let _lock = is_test_kilidi();
        let dir = test_is_dizini("audit-prune");
        let _cleanup = IsTestAlani(dir.clone());
        std::fs::create_dir_all(&dir).unwrap();
        let old = yeni_is_id();
        let fresh = yeni_is_id();
        for (id, age) in [
            (&old, IS_DOSYASI_OMRU + Duration::from_secs(1)),
            (&fresh, Duration::ZERO),
        ] {
            let file = std::fs::File::create(dir.join(format!("job-{id}.out"))).unwrap();
            file.set_times(
                std::fs::FileTimes::new().set_modified(std::time::SystemTime::now() - age),
            )
            .unwrap();
            isler().lock().unwrap().insert(
                id.clone(),
                std::sync::Arc::new(IsKaydi {
                    basladi: Instant::now() - age,
                    pid: 0,
                    dizin: dir.clone(),
                    iptal: Default::default(),
                    bitti: std::sync::Mutex::new(Some(IsSonucu {
                        sure: Duration::ZERO,
                        kod: Some(0),
                        durum: "bitti",
                        hata: None,
                    })),
                }),
            );
        }
        assert_eq!(eski_isleri_temizle_in(&dir, IS_DOSYASI_OMRU), 1);
        let table = isler().lock().unwrap();
        assert!(!table.contains_key(&old));
        assert!(table.contains_key(&fresh));
        assert!(!dir.join(format!("job-{old}.out")).exists());
        assert!(dir.join(format!("job-{fresh}.out")).exists());
    }

    #[test]
    fn audit_gui_comments_and_strings_are_not_code() {
        for cmd in [
            "while ($true) { Start-Sleep 60 } # $f.ShowDialog()",
            "Start-Sleep 1 <# $f.ShowDialog() #>",
            "Write-Output '$f.ShowDialog()'",
            "Write-Output \"$f.ShowDialog()\"",
            "Write-Output @'\n$f.ShowDialog()\n'@",
            "Write-Output @\"\n$f.ShowDialog()\n\"@",
            "Write-Output 'it''s $f.ShowDialog()'",
            "Write-Output \"a`\" $f.ShowDialog()\"",
            "Write-Output \"$(Write-Output \".ShowDialog()\")\"",
        ] {
            assert!(!pencere_acan_komut(cmd), "false GUI: {cmd}");
        }
    }

    #[test]
    fn audit_start_process_wait_is_detached() {
        for cmd in [
            "Start-Process notepad.exe -Wait",
            "Start-Process -Wait -FilePath notepad.exe",
        ] {
            assert!(pencere_acan_komut(cmd), "missed: {cmd}");
        }
        assert!(!pencere_acan_komut(
            "Write-Output 'Start-Process notepad -Wait'"
        ));
    }

    #[test]
    fn audit_cleanup_runs_again_after_one_hour() {
        let mut last = None;
        let now = Instant::now();
        assert!(temizlik_zamani_geldi(&mut last, now));
        assert!(!temizlik_zamani_geldi(
            &mut last,
            now + Duration::from_secs(3599)
        ));
        assert!(temizlik_zamani_geldi(
            &mut last,
            now + Duration::from_secs(3600)
        ));
        assert!(!temizlik_zamani_geldi(
            &mut last,
            now + Duration::from_secs(3601)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn audit_gui_early_errors_are_reported() {
        let _lock = is_test_kilidi();
        for cmd in [
            "throw 'audit-early-error'; if ($false) { $f.ShowDialog() }",
            "exit 7; if ($false) { $f.ShowDialog() }",
            "cmd /c exit 9; if ($false) { $f.ShowDialog() }",
            "if ($false) { $f.ShowDialog() }; )",
            "Write-Error 'audit-nonterminating-error'; if ($false) { $f.ShowDialog() }",
        ] {
            let v = terminal_calistir(cmd, false);
            assert!(
                v["hata"]
                    .as_str()
                    .is_some_and(|s| s.contains("pencere acilamadi")),
                "{v}"
            );
            let error = v["hata"].as_str().unwrap();
            assert!(
                !error.contains("hazirligi") && !error.contains("baslatici"),
                "script error was not observed: {v}"
            );
            if cmd.contains("audit-early-error") {
                assert!(error.contains("audit-early-error"), "{v}");
            }
            if cmd.starts_with("exit 7") {
                assert!(error.contains("cikis kodu 7"), "{v}");
            }
            if cmd.starts_with("cmd /c exit 9") {
                assert!(error.contains("cikis kodu 9"), "{v}");
            }
            if cmd.contains("audit-nonterminating-error") {
                assert!(error.contains("audit-nonterminating-error"), "{v}");
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn audit_timeout_kills_descendant_and_returns_on_time() {
        let _lock = is_test_kilidi();
        let marker = test_isareti("audit-child");
        let script = format!(
            "$p = Start-Process cmd.exe -ArgumentList '/c ping -n 13 127.0.0.1' -NoNewWindow -PassThru; Set-Content -LiteralPath '{}' -Value $p.Id; $p.WaitForExit()",
            marker.display()
        );
        let start = Instant::now();
        let v = terminal_calistir_sureli(&script, false, Some(5));
        let elapsed = start.elapsed();
        let pid = std::fs::read_to_string(&marker).expect("child PID");
        let check = run_powershell(
            &format!(
                "if (Get-Process -Id {} -ErrorAction SilentlyContinue) {{ 'alive' }}",
                pid.trim()
            ),
            false,
        );
        // Cleanup precedes assertions, including the red run.
        let _ = std::fs::remove_file(marker);
        assert!(
            elapsed < Duration::from_secs(9),
            "reader stuck for {elapsed:?}: {v}"
        );
        assert!(
            !check["cikti"]
                .as_str()
                .unwrap_or_default()
                .contains("alive"),
            "descendant survived: {check}"
        );
        assert!(v.get("hata").is_some(), "{v}");
    }

    #[cfg(windows)]
    #[test]
    fn audit_jobs_have_concurrency_limit() {
        let _lock = is_test_kilidi();
        let dir = test_is_dizini("audit-cap");
        let _cleanup = IsTestAlani(dir.clone());
        let mut accepted = Vec::new();
        for _ in 0..5 {
            let v = arka_plan_is_baslat_in(&dir, "Start-Sleep -Seconds 4");
            if let Some(id) = v["is_id"].as_str() {
                accepted.push(id.to_owned());
            }
        }
        for id in &accepted {
            is_bitmesini_bekle(&dir, id, Duration::from_secs(20));
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(accepted.len(), 4, "must accept only four concurrent jobs");
    }

    #[cfg(windows)]
    #[test]
    fn audit_job_output_is_bounded() {
        let _lock = is_test_kilidi();
        let dir = test_is_dizini("audit-quota");
        let _cleanup = IsTestAlani(dir.clone());
        let v = arka_plan_is_baslat_in(
            &dir,
            "1..12 | ForEach-Object { [Console]::Out.Write('x' * 1MB); [Console]::Error.Write('y' * 1MB) }",
        );
        let id = v["is_id"].as_str().expect("job");
        let start = Instant::now();
        let result = loop {
            let s = arka_plan_sonuc_in(&dir, id);
            if s["durum"] != "calisiyor" || start.elapsed() > Duration::from_secs(30) {
                break s;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let size = std::fs::metadata(dir.join(format!("job-{id}.out")))
            .unwrap()
            .len();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(size <= 20 * 1024 * 1024, "unbounded output: {size}");
        assert_eq!(result["is_durumu"], "cikti_kotasi", "{result}");
    }

    #[cfg(windows)]
    #[test]
    fn audit_job_deadline_environment() {
        let _lock = is_test_kilidi();
        if std::env::var_os("SMITH_AUDIT_DEADLINE_CHILD").is_none() {
            let result = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "system_tools::tests::audit_job_deadline_environment",
                    "--nocapture",
                ])
                .env("SMITH_AUDIT_DEADLINE_CHILD", "1")
                .env("SMITH_JOB_MAX_S", "1")
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stdout)
            );
            return;
        }
        let dir = test_is_dizini("audit-deadline");
        let _cleanup = IsTestAlani(dir.clone());
        let v = arka_plan_is_baslat_in(&dir, "Start-Sleep -Seconds 4");
        let id = v["is_id"].as_str().expect("job");
        let start = Instant::now();
        let result = loop {
            let s = arka_plan_sonuc_in(&dir, id);
            if s["durum"] != "calisiyor" || start.elapsed() > Duration::from_secs(15) {
                break s;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let _ = std::fs::remove_dir_all(dir);
        assert_eq!(result["durum"], "zaman_asimi", "{result}");
    }

    /// REGRESYON — SAHADA GORULEN KUSUR (2026-08-15, kullanici konusmasi):
    /// `dosya_ara` tekrar tekrar "zaman asimina ugradim" diyordu. Sebep komutun
    /// yavas olmasi DEGILDI; `stdout`/`stderr` `piped()` oldugu halde bekleme
    /// dongusu borulari HIC bosaltmiyordu. Cocuk surec OS boru tamponunu
    /// (Windows'ta ~4 KB) doldurdugu anda YAZMADA BLOKE oluyor, hic bitmiyor ve
    /// komut DAIMA timeout'a dusuyordu. Yani cikti buyudugu anda arac
    /// kullanilamaz hale geliyordu.
    ///
    /// Bu test 4 KB'i acik ara asan bir cikti uretir. Bosaltma kaldirilirsa
    /// komut timeout'a duser, `cikis_kodu` yerine `hata` doner ve test kirmizi
    /// olur. Timeout'u buyutmek testi GECIREMEZ: bloke olan surec hic bitmez.
    #[test]
    fn buyuk_cikti_boru_tamponunda_kilitlenmez() {
        // ~48 KB: tek satirlik guvenli bir komut, hicbir dosya sistemi etkisi yok.
        let out = run_powershell_opts(
            "1..800 | ForEach-Object { 'x' * 60 }",
            PsOpts {
                timeout: Duration::from_secs(20),
                label: Some("test: buyuk cikti"),
                ..Default::default()
            },
        );
        assert!(
            out.get("hata").is_none(),
            "buyuk cikti kilitlendi (boru bosaltilmiyor): {out}"
        );
        assert_eq!(
            out["cikis_kodu"].as_i64(),
            Some(0),
            "komut basarisiz dondu: {out}"
        );
        let cikti = out["cikti"].as_str().unwrap_or_default();
        assert!(
            cikti.len() > 4096,
            "cikti boru tamponundan buyuk olmali, yoksa test hicbir sey kanitlamaz: {} bayt",
            cikti.len()
        );
    }

    /// Zaman asiminda KISMI cikti atilmaz: iptal edilmis bir aramanin
    /// bulduklari da isine yarar. (`sleep` sonrasi cikti gelmez, o yuzden
    /// burada yalniz sozlesme sabitleniyor: hata + sure alanlari var.)
    #[test]
    fn zaman_asiminda_hata_ve_sure_doner() {
        let out = run_powershell_opts(
            "Start-Sleep -Seconds 30",
            PsOpts {
                timeout: Duration::from_millis(400),
                label: Some("test: zaman asimi"),
                ..Default::default()
            },
        );
        assert!(
            out["hata"].as_str().unwrap_or_default().contains("iptal"),
            "zaman asimi hatasi beklenirdi: {out}"
        );
        assert!(
            out["sure_ms"].as_u64().is_some(),
            "sure bildirilmemis: {out}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn sinirli_calistirici_basarida_iki_akisi_da_doner() {
        let sn30 = Duration::from_secs(30);
        let (cikti, _) = run_bounded(Command::new("cmd.exe").args(["/c", "echo merhaba"]), sn30)
            .expect("basarili komut");
        assert_eq!(cikti.trim(), "merhaba");
        let (_, hata) = run_bounded(
            Command::new("cmd.exe").args(["/c", "echo kimlik 1>&2"]),
            sn30,
        )
        .expect("basarili komut");
        assert_eq!(hata.trim(), "kimlik");
    }

    /// Sifir disi cikis ve dolan son tarih `None`dur; takilan surec beklenmez
    /// (probe 30 sn uyur: kapi calismasa test o kadar surerdi).
    #[cfg(windows)]
    #[test]
    fn sinirli_calistirici_sifir_disi_cikis_ve_zaman_asiminda_none_doner() {
        let sn30 = Duration::from_secs(30);
        assert!(run_bounded(Command::new("cmd.exe").args(["/c", "exit 3"]), sn30).is_none());
        let basladi = Instant::now();
        let takilan = run_bounded(
            Command::new("powershell.exe").args([
                "-NoProfile",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]),
            Duration::from_millis(500),
        );
        assert!(takilan.is_none());
        assert!(
            basladi.elapsed() < Duration::from_secs(20),
            "{:?}",
            basladi.elapsed()
        );
    }

    #[cfg(windows)]
    #[test]
    fn sinirli_calistirici_ciktiyi_kirpar() {
        let (cikti, _) = run_bounded(
            Command::new("powershell.exe").args([
                "-NoProfile",
                "-Command",
                "[Console]::Out.Write('x' * 100000)",
            ]),
            Duration::from_secs(60),
        )
        .expect("basarili komut");
        assert!(cikti.len() < 2 * MAX_OUTPUT, "kirpilmadi: {}", cikti.len());
        assert!(cikti.contains("cikti kirpildi"), "kirpma isareti yok");
    }

    /// Onayla bile acilmayan METIN TABANLI sinif: sistem guvenligini dusuren komutlar.
    #[test]
    fn guvenlik_dusuren_komutlar_reddedilir() {
        for bad in [
            "Set-MpPreference -DisableRealtimeMonitoring $true",
            "Set-ExecutionPolicy Bypass",
            "netsh advfirewall set allprofiles state off",
            "New-LocalUser -Name x",
            "Add-LocalGroupMember -Group Administrators -Member x",
        ] {
            assert!(denied_reason(bad).is_some(), "reddedilmeliydi: {bad}");
        }
    }

    /// Onayla bile acilmayan KELIME TABANLI sinif: diski/bolumu bicimlendirir,
    /// onyuklemeyi bozar. Onay yolu (`yikici_komut`) bu siniftan AYRIDIR.
    #[test]
    fn disk_bicimlendirme_ve_onyukleme_kelime_tabanli_reddedilir() {
        for bad in [
            "format c: /q",
            "format D:",
            "format /q d:",
            "format.com E: /fs:ntfs",
            "& 'C:\\Windows\\System32\\format.com' Z:",
            "cmd /c format z: /y",
            "Format-Volume -DriveLetter D",
            "Clear-Disk -Number 1 -RemoveData",
            "Remove-Partition -DriveLetter E",
            "Initialize-Disk -Number 2",
            "diskpart /s fixture.txt",
            "bcdedit /set {default} safeboot minimal",
        ] {
            let sebep = denied_reason(bad).unwrap_or_default();
            assert!(
                sebep.contains("guvenlik geregi reddedildi"),
                "{bad}: {sebep}"
            );
            assert!(!yikici_komut(bad), "onay yolu olmamali: {bad}");
        }
        let sebep = denied_reason("cmd /c diskpart /s x").unwrap();
        assert!(sebep.contains("'diskpart'"), "{sebep}");
    }

    #[test]
    fn normal_komutlar_gecer() {
        for ok in [
            "Get-Date",
            "Get-Process | Select-Object -First 3",
            "Remove-Item C:\\Users\\x\\temp\\dosya.txt",
            "Get-ChildItem D:\\projeler",
        ] {
            assert!(denied_reason(ok).is_none(), "gecmeliydi: {ok}");
            assert!(!yikici_komut(ok), "onay istememeliydi: {ok}");
        }
    }

    /// REGRESYON: `"format "` deseni `-Format` parametresini yakaliyordu ve
    /// masum komutlar reddediliyordu (canli sondada goruldu). Yanlis pozitif
    /// guvenlik kapisini kullanilamaz kilar; bu test onu geri gelmekten korur.
    #[test]
    fn format_parametresi_yanlis_pozitif_uretmez() {
        for ok in [
            "Get-Date -Format 'yyyy-MM-dd HH:mm'",
            "Get-Date -Format \"dd MMMM yyyy\"",
            "Get-Date -Format dd",
            "Get-ChildItem | Format-Table -AutoSize",
            "Get-Process | Format-List",
            "$x | ConvertTo-Json | Out-String -Format",
            "git log --format=%h",
            // Duz yazidaki `format` kelimesi disk bicimlendirme degil: kati ret
            // onay yolu olmadigi icin bunlarin takilmasi kullanilamaz kapi demek.
            "Select-String -Pattern format -Path x.rs",
            "rg -n \"fn format\" C:\\repo\\*.rs",
            "Get-Help format",
        ] {
            assert!(denied_reason(ok).is_none(), "yanlis pozitif: {ok}");
            assert!(!yikici_komut(ok), "yanlis pozitif: {ok}");
        }
        // Gercek disk bicimlendirme kati ret: birim veya `format` anahtari ardindan gelir.
        for bad in ["format c: /q", "Format-Volume -DriveLetter D"] {
            assert!(denied_reason(bad).is_some(), "{bad}");
        }
    }

    // -----------------------------------------------------------------------
    // YIKICI KOMUT ONAYI
    // -----------------------------------------------------------------------

    /// Onay sinifi: bu komutlarin her biri tek basina "Cihan'a sor" demektir.
    #[test]
    fn yikici_komut_siniflari_onay_ister() {
        for cmd in [
            // Silme: ozyineli veya zorlamali
            "Remove-Item -LiteralPath 'C:\\Users\\x\\Documents' -Recurse -Force",
            "$null=Remove-Item fixture -Force",
            "Microsoft.PowerShell.Management\\Remove-Item fixture -r",
            "ri fixture -fo",
            "rm -rf /",
            "rm --recursive --force fixture",
            "del /f fixture",
            "rd /s fixture",
            "rmdir /s /q fixture",
            "cmd /c del /q /f fixture",
            // Kalici veri kaybi
            "Clear-RecycleBin -Force",
            "git -C fixture clean -fdx",
            "git reset --hard",
            "vssadmin delete shadows",
            "cipher /w:fixture",
            "reg delete HKLM\\Software\\X",
            "dd if=/dev/zero of=fixture",
            "docker system prune -f",
            "docker volume rm fixture",
            "docker compose down",
            "wsl --unregister fixture",
            // Kapatma
            "$x=Stop-Computer",
            "Restart-Computer",
            "cmd /c shutdown /s",
            "shutdown /s /t 0",
            "wsl --shutdown",
        ] {
            assert!(yikici_komut(cmd), "{cmd}");
        }
    }

    /// Yanlis pozitif onay kapisini yorucu kilar: gunluk komutlar onay sormaz.
    #[test]
    fn yikici_komut_gundelik_komutlara_takilmaz() {
        for cmd in [
            "Get-Date -Format yyyy",
            "Get-Date -Format \"dd MMMM yyyy\"",
            "Get-Item fixture",
            "Get-ChildItem -Recurse | Format-Table",
            "git status",
            "git reset --soft HEAD",
            "git log --format=%h",
            "docker ps",
            "docker compose up -d",
            "wsl -l -v",
            // Bayraksiz tek dosya silme "asistanin ise yaramasi icin" serbest.
            "Remove-Item C:\\Users\\x\\temp\\dosya.txt",
            "Remove-Item -LiteralPath 'a b.txt'",
            "del dosya.txt",
        ] {
            assert!(!yikici_komut(cmd), "{cmd}");
        }
    }

    #[test]
    fn yikici_terminal_komutu_onay_ister() {
        // Calissa bile zararsiz: `-WhatIf` ve olmayan birim.
        let v = terminal_calistir("Clear-RecycleBin -DriveLetter Y -WhatIf", false);
        assert_eq!(v["durum"], "onay_gerekiyor", "{v}");
        assert_eq!(v["basarili"], false, "{v}");
    }

    /// Kati ret onay yoluna GIRMEZ: ilk cagri da, `onay=true` ile ikinci cagri da
    /// (arka plan dahil) reddedilir ve komut calistirilmaz. Calissa bile zararsiz
    /// sectigim varyantlar: olmayan birim/betik, `-WhatIf`, salt okunur `/enum`.
    #[test]
    fn kati_ret_onay_true_ile_ikinci_cagrida_da_reddedilir() {
        for cmd in [
            "format y: /q",
            "Format-Volume -DriveLetter Y -WhatIf",
            "diskpart /s smith-olmayan-betik-1f3a.txt",
            "bcdedit /enum",
        ] {
            for (arka_plan, onay) in [(false, false), (false, true), (true, true)] {
                let v = terminal_calistir_onayli(cmd, arka_plan, None, onay);
                assert_eq!(
                    v["durum"], "reddedildi",
                    "{cmd} arka_plan={arka_plan} onay={onay}: {v}"
                );
                assert_eq!(v["basarili"], false, "{cmd}: {v}");
                assert!(
                    v.get("cikis_kodu").is_none() && v.get("is_id").is_none(),
                    "{cmd}: {v}"
                );
            }
        }
    }

    /// Kelime tabanli oldugu icin `Get-Date -Format` onaysiz ve reddedilmeden calisir.
    #[cfg(windows)]
    #[test]
    fn get_date_format_dd_onaysiz_calisir() {
        let v = terminal_calistir("Get-Date -Format dd", false);
        assert_eq!(v["durum"], "bitti", "{v}");
        assert_eq!(v["basarili"], true, "{v}");
        let gun: u32 = v["cikti"].as_str().unwrap().trim().parse().unwrap();
        assert!((1..=31).contains(&gun), "{v}");
    }

    /// Kapatma onay sinifindadir (kati ret DEGIL): ilk cagri `onay_gerekiyor`, ayni
    /// komut `onay=true` ile calisir. Zararsiz iki kapatma-sinifi komut: `shutdown /?`
    /// (yalniz yardim metni) ve `Stop-Computer -WhatIf`.
    #[cfg(windows)]
    #[test]
    fn kapatma_iki_adimli_onayla_calisir() {
        for cmd in ["shutdown /?", "Stop-Computer -WhatIf"] {
            let ilk = terminal_calistir_onayli(cmd, false, None, false);
            assert_eq!(ilk["durum"], "onay_gerekiyor", "{cmd}: {ilk}");
            let ikinci = terminal_calistir_onayli(cmd, false, None, true);
            assert_ne!(ikinci["durum"], "onay_gerekiyor", "{cmd}: {ikinci}");
            assert_ne!(ikinci["durum"], "reddedildi", "{cmd}: {ikinci}");
            assert!(
                ikinci.get("cikti").is_some(),
                "komut calismadi: {cmd}: {ikinci}"
            );
        }
    }

    /// Onay ve kati ret siniflarinin TEK ayristiricisi.
    #[test]
    fn komut_kelimeleri_atama_tirnak_ve_baglaci_boler() {
        assert_eq!(
            komut_kelimeleri(
                "$X=Remove-Item 'a b';`Stop-Computer | & 'C:\\Windows\\format.com' D:"
            ),
            [
                "$x",
                "remove-item",
                "a",
                "b",
                "stop-computer",
                "c:\\windows\\format.com",
                "d:"
            ]
        );
    }

    /// Reddedilecek komut icin Cihan'a onay sorulmaz: gizlilik kapisi onden gelir.
    #[test]
    fn gizlilik_kapisi_onay_kapisindan_once_calisir() {
        let v = terminal_calistir(
            "Remove-Item C:\\is\\customers\\a.txt -Recurse -Force",
            false,
        );
        assert_eq!(v["durum"], "reddedildi", "{v}");
    }

    /// Onay AYNI komut metni icin ve TEK KULLANIMLIKTIR; `onay=true` gelen ilk
    /// cagri da calistirmaz (model onayi pesinen veremez).
    #[cfg(windows)]
    #[test]
    fn onay_ayni_komut_icin_ve_tek_kullanimliktir() {
        let yol = test_isareti("onay");
        std::fs::write(&yol, "fixture").unwrap();
        let cmd = format!(
            "Remove-Item -LiteralPath '{}' -Force",
            yol.display().to_string().replace('\'', "''")
        );
        let durum = |cmd: &str, arka_plan: bool, onay: bool| {
            terminal_calistir_onayli(cmd, arka_plan, None, onay)["durum"].clone()
        };
        assert_eq!(durum(&cmd, false, true), "onay_gerekiyor");
        assert!(yol.exists(), "onaysiz ilk cagri calisti");
        assert_eq!(
            durum(&format!("{cmd} # degisti"), false, true),
            "onay_gerekiyor"
        );
        assert!(yol.exists(), "farkli komut onayi devraldi");
        let v = terminal_calistir_onayli(&cmd, false, None, true);
        assert_eq!(v["basarili"], true, "{v}");
        assert!(!yol.exists(), "onaylanan komut calismadi");
        assert_eq!(
            durum(&cmd, false, true),
            "onay_gerekiyor",
            "onay tekrar kullanildi"
        );
        assert_eq!(
            durum(&cmd, true, false),
            "onay_gerekiyor",
            "arka plan yolu onayi atladi"
        );
    }

    // -----------------------------------------------------------------------
    // TERMINAL GIZLILIK KAPISI
    // -----------------------------------------------------------------------

    /// Kapinin kendisi: kara listedeki yola dokunan komut CALISTIRILMAZ.
    /// `terminal_calistir` uzerinden gidilir (surec acmadan: red erken doner).
    #[test]
    fn terminal_kara_listedeki_yolu_reddeder() {
        for cmd in [
            "Get-Content C:\\x\\.env.local",
            "type customers\\a.txt",
            "type C:\\is\\customers\\a.txt", // desen jetonun ORTASINDA
            "TYPE C:\\IS\\CUSTOMERS\\A.TXT", // buyuk harf normalizasyonu
            "gc $HOME\\.ssh\\id_rsa",
            "cat ~/.ssh/id_ed25519",
            "Get-Content server.pem",
            "gc 'D:\\yedek\\db-dumps\\prod.sql'",
            "cat ~/.codex/auth.json",
            "Get-Content ~\\.claude\\.credentials.json",
            "gc C:\\k\\secrets.json", // desenin ardindan harf gelir
            "gc C:\\k\\client_secret.json",
            "Select-String x .env", // satir sonunda
            "gc \".env\"",
            "gc prod.env", // uzanti olarak
            "cat .envrc",
            "gc .env_backup",
            "Get-Content ~\\.aws\\credentials", // noktasiz credentials
            "cat ~/.cargo/credentials.toml",
        ] {
            let v = terminal_calistir(cmd, false);
            assert!(
                v["hata"].as_str().unwrap_or("").contains("kara liste"),
                "kara liste uygulanmadi: {cmd} -> {v}"
            );
            assert!(v.get("cikis_kodu").is_none(), "komut kosmus: {cmd}");
        }
        // Arka plan kosusu da ayni kapidan gecer.
        let v = terminal_calistir("Start-Process notepad C:\\x\\.env", true);
        assert!(
            v["hata"].as_str().unwrap_or("").contains("kara liste"),
            "arka plan kapiyi atladi: {v}"
        );
    }

    /// YANLIS POZITIF: masum komutlar kapiya takilmamali (kullanilamaz kapi).
    #[test]
    fn terminal_gizlilik_kapisi_yanlis_pozitif_uretmez() {
        for ok in [
            "Get-ChildItem env:",
            "pnpm run environment",
            "git status",
            "node -e \"console.log(cfg.environment)\"",
            "Get-Content C:\\repo\\src\\main.rs",
            "Get-Date -Format 'yyyy-MM-dd'",
            "Get-Process | Where-Object CPU -gt 10",
            "cargo test --lib",
            "$env:PATH",
            "node -e \"console.log(process.env.HOME)\"", // nesne erisimi
            "node -e \"process.env['X']\"",
            "git config credential.helper", // tekil credential
        ] {
            assert_eq!(komut_gizlilik_deseni(ok), None, "yanlis pozitif: {ok}");
        }
    }

    /// Yol listesi `PRIVACY_DENY`den bagimsiz kayamaz: her desen ortak listedeki
    /// bir kayitla KAPSANMALI (alt dize). Biri ortak listeden dusurulurse
    /// terminal kapisi sessizce baska bir seyi korumaya baslamis olurdu.
    #[test]
    fn terminal_deseni_ortak_listeden_turer() {
        // Bilincli terminal-ozel desenler: ortak listeye girseler `file_read`/
        // `file_search` masum dosyalari (`locales/en/auth.json`) da gizlerdi.
        const TERMINALE_OZGU: &[&str] = &["auth.json"];
        for (desen, _, _) in KOMUT_YOL_DESENLERI {
            assert_eq!(
                *desen,
                desen.to_lowercase(),
                "buyuk harf = olu kod: {desen:?}"
            );
            if TERMINALE_OZGU.contains(desen) {
                assert!(
                    !PRIVACY_DENY.iter().any(|d| desen.contains(d)),
                    "terminal-ozel desen ortak listeye sizmis: {desen:?}"
                );
                continue;
            }
            assert!(
                PRIVACY_DENY.iter().any(|d| desen.contains(d)),
                "desen PRIVACY_DENY ile kapsanmiyor: {desen:?}"
            );
        }
    }

    /// Ortak listedeki dosya/dizin izleri (sir KELIMELERI degil) terminal
    /// kapisinda da bulunmali: liste buyurse kapi geride kalmasin.
    #[test]
    fn ortak_listenin_yol_izleri_terminalde_da_var() {
        for iz in [
            ".env",
            "id_rsa",
            "id_ed25519",
            ".pem",
            "customers",
            "db-dumps",
        ] {
            assert!(
                KOMUT_YOL_DESENLERI.iter().any(|(d, _, _)| d.contains(iz)),
                "yol izi terminal kapisinda yok: {iz:?}"
            );
            assert!(PRIVACY_DENY.contains(&iz), "ortak listede yok: {iz:?}");
        }
    }

    /// Kalici loga giren komut sirsiz olmali ama KOMUTUN KENDISI gorunmeli
    /// (kullanici seffafligi: model ne kosturdu).
    #[test]
    fn komut_logu_sirlari_maskeler_komutu_gizlemez() {
        let log = log_komutu(
            "curl -H 'Authorization: Bearer abc123def456ghi' \
             'https://x.invalid/a?signature=zzz999&ok=1' --data password=hunter2x",
        );
        for sir in ["abc123def456ghi", "zzz999", "hunter2x"] {
            assert!(!log.contains(sir), "{sir} loga sizdi: {log}");
        }
        assert!(log.starts_with("curl -H "), "komut gorunmeli: {log}");
        assert!(log.contains("ok=1"), "sir olmayan kisim korunmali: {log}");
    }

    #[test]
    fn cikti_kirpilir_ve_isaretlenir() {
        let big = "a".repeat(MAX_OUTPUT + 500);
        let out = clip(&big);
        assert!(out.len() < big.len());
        assert!(out.contains("kirpildi"));
    }

    #[test]
    fn kisa_cikti_dokunulmaz() {
        assert_eq!(clip("  merhaba  "), "merhaba");
    }

    #[test]
    fn bilinmeyen_ses_islemi_hata_doner() {
        let v = audio_control("zipla", None);
        assert!(v.get("hata").is_some());
    }

    // -----------------------------------------------------------------------
    // GIZLILIK KARA LISTESI — birlestirmenin kaniti
    // -----------------------------------------------------------------------

    /// Birlestirmeden ONCEKI uc liste, birebir. Bunlar TARIHSEL SNAPSHOT'tir:
    /// asla "guncellenmez", cunku isleri yeni listenin eskisini KAPSADIGINI
    /// kanitlamak. Yeni bir desen eklemek serbest, eskiyi dusurmek degil.
    const ESKI_FILE_READ_DENY: &[&str] = &[
        "db-dumps",
        "customers",
        "\\.env",
        "id_rsa",
        "id_ed25519",
        ".pem",
    ];
    const ESKI_FILE_SEARCH_SKIP: &[&str] = &[
        "node_modules",
        ".git\\",
        "target\\",
        ".venv",
        "db-dumps",
        "customers",
        "docker-data",
        "appdata\\local\\temp",
    ];
    const ESKI_BOOT_SECRET_MARKERS: &[&str] = &[
        "-----begin",
        "password",
        "parola",
        "passwd",
        "api key",
        "apikey",
        "api_key",
        "secret",
        "bearer ",
        "credential",
        ".env",
        "id_rsa",
        "id_ed25519",
        ".pem",
        "customers",
        "db-dumps",
    ];

    /// Eski desen `p`, yeni listedeki bir desen tarafindan KAPSANIYOR mu?
    ///
    /// Kapsama testi esitlik degil ALT DIZE: yeni `.env`, eski `\.env`'i
    /// kapsar (`\.env` iceren her metin `.env` de icerir). Yani eski listenin
    /// yakaladigi hicbir metin yeni listeden kacamaz.
    fn kapsaniyor(p: &str, birlesim: &[&str]) -> bool {
        birlesim.iter().any(|y| p.contains(y))
    }

    /// MUTASYON KAPISI: birlesimden bir desen dusurulurse bu test kirmizi olur.
    #[test]
    fn kara_liste_birlesimi_hicbir_deseni_kaybetmez() {
        let arama: Vec<&str> = SEARCH_NOISE
            .iter()
            .chain(PRIVACY_DENY.iter())
            .copied()
            .collect();
        for p in ESKI_FILE_READ_DENY {
            assert!(
                kapsaniyor(p, PRIVACY_DENY),
                "file_read deseni birlesimde yok: {p:?}"
            );
        }
        for p in ESKI_BOOT_SECRET_MARKERS {
            assert!(
                kapsaniyor(p, PRIVACY_DENY),
                "boot_context deseni birlesimde yok: {p:?}"
            );
        }
        for p in ESKI_FILE_SEARCH_SKIP {
            assert!(
                kapsaniyor(p, &arama),
                "file_search deseni birlesimde yok: {p:?}"
            );
        }
    }

    /// Arama listesi ile gizlilik listesi KARISMAMALI: `node_modules` bir
    /// guvenlik siniri degil, ve `boot_context` (pencere basliklari) onu
    /// uygulamamali. Ayrimin bozulmasi kapinin anlamini bulandirir.
    #[test]
    fn arama_gurultusu_gizlilik_listesine_sizmaz() {
        for n in SEARCH_NOISE {
            assert!(
                !PRIVACY_DENY.contains(n),
                "arama gurultusu gizlilik listesine girmis: {n:?}"
            );
        }
    }

    /// Arama kucuk harfe cevrilmis metinde yapilir: BUYUK harf tasiyan bir
    /// desen sessizce OLU KOD olur (`-----BEGIN` dersi).
    #[test]
    fn kara_liste_kucuk_harf() {
        for p in PRIVACY_DENY.iter().chain(SEARCH_NOISE.iter()) {
            assert_eq!(*p, p.to_lowercase(), "desen buyuk harf tasiyor: {p:?}");
        }
    }

    /// TUKETICI 1: `file_read` listeyi gercekten uyguluyor mu?
    #[test]
    fn file_read_ortak_listeyi_uygular() {
        for yol in [
            "C:\\Users\\x\\Customers\\ACME\\fatura.txt", // buyuk harf de yakalanmali
            "C:\\dev\\db-dumps\\prod.sql",
            "C:\\repo\\.env.production",
            "C:\\Users\\x\\.ssh\\id_ed25519",
            "C:\\certs\\server.pem",
            "C:\\notlar\\API_KEY listesi.txt",
        ] {
            let v = file_read(yol, None);
            assert!(
                v["hata"].as_str().unwrap_or("").contains("kara liste"),
                "kara liste uygulanmadi: {yol} -> {v}"
            );
        }
        // Masum yol kara listeye takilmamali (yanlis pozitif = kullanilamaz kapi).
        let v = file_read("C:\\repo\\src\\main.rs", None);
        assert!(
            !v["hata"].as_str().unwrap_or("").contains("kara liste"),
            "yanlis pozitif: {v}"
        );
    }

    /// Okuma yalniz gereken pencereyi alir: dosyanin tamami bellege girmez.
    #[test]
    fn dosya_okuma_yalniz_gerekli_oneki_okur() {
        let mut okuyucu = std::io::Cursor::new(vec![b'a'; 1_000_000]);
        let bytes = file_prefix(&mut okuyucu, 10).unwrap();
        assert!(bytes.len() <= IKILI_TESPIT_BAYT);
        assert_eq!(okuyucu.position() as usize, bytes.len());
    }

    /// Dosya boyutu okumayi engellemez: 65 MB'lik bir kaydin basi yine okunur.
    #[test]
    fn buyuk_dosyanin_basi_okunur() {
        use std::io::Write;
        let yol =
            std::env::temp_dir().join(format!("smith-buyuk-dosya-{}.txt", std::process::id()));
        let mut dosya = std::fs::File::create(&yol).unwrap();
        for _ in 0..65 {
            dosya.write_all(&vec![b'a'; 1 << 20]).unwrap();
        }
        drop(dosya);
        let v = file_read(yol.to_str().unwrap(), Some(10));
        let _ = std::fs::remove_file(&yol);
        assert_eq!(v["icerik"], "aaaaaaaaaa", "{v}");
        assert_eq!(v["kesildi"], true, "{v}");
    }

    /// TUKETICI 2: arama script'i ortak listeyi TASIYOR mu? (Surec acmadan.)
    #[test]
    fn arama_scripti_ortak_listeyi_tasir() {
        let script = file_search_script("C:\\Users\\x", "*.rs");
        for p in PRIVACY_DENY.iter().chain(SEARCH_NOISE.iter()) {
            let literal = format!("'{p}'");
            assert!(
                script.contains(&literal),
                "desen script'e girmemis: {p:?}\n{script}"
            );
        }
        // Tek tirnak kacisi: kullanici metni PowerShell ifadesini kiramaz.
        assert!(file_search_script("C:\\a'b", "x'y").contains("C:\\a''b"));
    }

    // -----------------------------------------------------------------------
    // system_status — ALAN SOZLESMESI
    // -----------------------------------------------------------------------

    fn ornek_status() -> StatusFacts {
        StatusFacts {
            cpu: Some("Intel Core i7-12700F".into()),
            cores: Some(20),
            cpu_pct: Some(7),
            ram: Some(boot_context::Ram {
                total_gb: 31.84,
                used_pct: 62,
                free_gb: 12.21,
            }),
            gpu: Some("NVIDIA GeForce RTX 5060 8 GB".into()),
            disk_c: Some(boot_context::Disk {
                letter: 'C',
                free_gb: 66.53,
                total_gb: 930.47,
            }),
            battery: None,
            os: Some("Windows 11 Pro 25H2 (build 26200)".into()),
            uptime: Some(Duration::from_secs(101_520)),
        }
    }

    /// GERILEME KAPISI: model bu araca gore konusuyor; CIM'den FFI'ya gecerken
    /// bir alanin sessizce dusmesi gorunmez bir yetenek kaybi olurdu. Anahtar
    /// kumesi eski PowerShell ciktisiyla BIREBIR ayni olmali.
    #[test]
    fn alan_sozlesmesi_korunur() {
        let v = build_status(&ornek_status());
        let beklenen = [
            "cpu",
            "cekirdek",
            "cpu_yuzde",
            "ram_toplam_gb",
            "ram_bos_gb",
            "gpu",
            "disk_c_bos_gb",
            "disk_c_toplam_gb",
            "pil_yuzde",
            "isletim_sistemi",
            "acik_kalma_saat",
        ];
        let obj = v.as_object().expect("nesne bekleniyordu");
        for k in beklenen {
            assert!(obj.contains_key(k), "alan dusmus: {k}\n{v}");
        }
        assert_eq!(obj.len(), beklenen.len(), "beklenmeyen alan var: {v}");
        // Yuvarlama sozlesmesi: eski script `[math]::Round(x,1)` kullaniyordu.
        assert_eq!(v["ram_toplam_gb"], 31.8);
        assert_eq!(v["ram_bos_gb"], 12.2);
        assert_eq!(v["disk_c_bos_gb"], 66.5);
        assert_eq!(v["disk_c_toplam_gb"], 930.5);
        assert_eq!(v["acik_kalma_saat"], 28.2);
        // Pil yoksa SAYI degil metin doner — eski sozlesme birebir.
        assert_eq!(v["pil_yuzde"], "pil yok (masaustu)");
        // VRAM tuzagi: `AdapterRAM` 32-bit tasmasi "4 GB" gosteriyordu.
        assert!(v["gpu"].as_str().unwrap().contains("8 GB"));
    }

    /// Pil VARSA yuzde sayi olarak doner.
    #[test]
    fn pil_varsa_yuzde_doner() {
        let mut f = ornek_status();
        f.battery = Some(boot_context::Battery {
            percent: 87,
            charging: true,
        });
        assert_eq!(build_status(&f)["pil_yuzde"], 87);
    }

    /// Hicbir sey olculemediyse (Windows disi hedef) eski hata sozlesmesi.
    #[test]
    fn olculemeyen_durum_hata_doner() {
        let f = StatusFacts {
            cpu: None,
            cores: None,
            cpu_pct: None,
            ram: None,
            gpu: None,
            disk_c: None,
            battery: None,
            os: None,
            uptime: None,
        };
        assert_eq!(build_status(&f)["hata"], "sistem durumu alinamadi");
    }

    // -----------------------------------------------------------------------
    // run_powershell — cagri basina son tarih
    // -----------------------------------------------------------------------

    #[test]
    fn sure_metni_okunabilir() {
        assert_eq!(sure_metni(Duration::from_millis(700)), "700 ms");
        assert_eq!(sure_metni(Duration::from_secs(20)), "20 saniye");
    }

    /// CANLI: cagri basina son tarih GERCEKTEN uygulanir ve surec oldurulur.
    /// Eskiden tek sabit tavan (20 sn) vardi; boot_context butcesini kanaldan
    /// zorlamak zorunda kaliyor, cocuk surec yetim kaliyordu.
    #[cfg(windows)]
    #[test]
    fn cagri_basina_zaman_asimi_uygulanir() {
        let basla = Instant::now();
        let v = run_powershell_opts(
            "Start-Sleep -Seconds 30",
            PsOpts {
                timeout: Duration::from_millis(400),
                label: Some("test: zaman asimi"),
                ..Default::default()
            },
        );
        let gecen = basla.elapsed();
        assert!(
            v["hata"].as_str().unwrap_or("").contains("iptal edildi"),
            "zaman asimi hatasi beklenmisti: {v}"
        );
        // Varsayilan 20 sn tavani devrede olsaydi bu esik asilirdi.
        assert!(
            gecen < Duration::from_secs(5),
            "son tarih uygulanmadi: {} ms",
            gecen.as_millis()
        );
    }

    /// ENCODING REGRESYONU (2026-09-18): kabuk uzerinden yazilan Turkce metin
    /// dosyada BOZULMAMALI ve BOM EKLENMEMELI. Bu test, `powershell.exe` (5.1)
    /// donemindeki ANSI/cift-kodlama hatasinin geri gelmesini yakalar —
    /// sahadaki 46 dosyalik bozulmanin kapiya baglanmis hali.
    #[cfg(windows)]
    #[test]
    fn turkce_yazim_bom_eklemez_ve_bozmaz() {
        let p = std::env::temp_dir().join(format!("smith-enc-{}.txt", std::process::id()));
        let yol = p.to_string_lossy().to_string();
        let cmd = format!(
            "Set-Content -Path '{yol}' -Value 'çğıöşü İÇĞÜŞÖ'; Get-Content -Path '{yol}' -Raw"
        );
        let v = run_powershell(&cmd, false);
        // TEK gercek kaynak dosyadir: baytlari oku (stdout bicimi degisebilir).
        let bytes = std::fs::read(&p).expect("test dosyasi yazilamadi");
        let text = String::from_utf8(bytes).expect("dosya gecerli utf8 degil");
        assert!(!text.starts_with('\u{feff}'), "BOM eklendi");
        assert!(
            text.contains('ç') && text.contains('İ'),
            "turkce bozuldu: {text:?} | sonuc: {v}"
        );
        let _ = std::fs::remove_file(&p);
    }

    // -----------------------------------------------------------------------
    // PENCERE / GUI ACAN KOMUTLAR
    //
    // SAHA (2026-10-01, Smith konusma kaydi): "PowerShell ile pencere ac" dendi,
    // model `$form.ShowDialog()` calistirdi. ShowDialog pencere kapanana kadar
    // bloklar; arac 20 sn'de sureci OLDURDU ve modele zaman asimi hatasi dondu.
    // Pencere gorunmustu ama kapandi; model bunu basarisizlik sayip bundan sonra
    // "grafiksel pencere olusturma yetenegim yok" dedi. Testler gercek pencere
    // ACMAZ: tanima saf fonksiyonla, surec davranisi gorunmez ve zararsiz
    // betiklerle (calistirilmayan GUI dali tasiyan `Start-Sleep`) sinanir.
    // -----------------------------------------------------------------------

    /// Test isaret dosyasi: surec kendi pid'ini buraya yazar.
    fn test_isareti(etiket: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("smith-pencere-{etiket}-{}.txt", std::process::id()))
    }

    /// Dosyanin ICERIGI dolana kadar bekler (olusturma ile yazma arasindaki
    /// yaris yuzunden yalniz varligina bakilmaz). Gelmezse `None`.
    fn isaret_bekle(yol: &std::path::Path, en_cok: Duration) -> Option<String> {
        let basla = Instant::now();
        while basla.elapsed() < en_cok {
            if let Ok(s) = std::fs::read_to_string(yol) {
                if !s.trim().is_empty() {
                    return Some(s);
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        None
    }

    #[test]
    fn pencere_tanima_sahadaki_ve_bilinen_kaliplari_yakalar() {
        for cmd in [
            // SAHA 1: WinForms + ShowDialog
            "Add-Type -AssemblyName System.Windows.Forms; $form = New-Object System.Windows.Forms.Form; \
             $form.Text = 'Kaynak'; $l = New-Object System.Windows.Forms.Label; $form.Controls.Add($l); \
             $form.ShowDialog()",
            // SAHA 2: WPF Window + ShowDialog
            "Add-Type -AssemblyName PresentationFramework; $w = New-Object System.Windows.Window; \
             $w.Title = 'K'; $w.ShowDialog()",
            "[void]$form.ShowDialog()",
            "$form.ShowDialog ()", // bosluklu cagri
            "$FORM.SHOWDIALOG()",  // buyuk harf
            "Get-Process | Out-GridView",
            "Get-Process | Out-GridView -Title 'x' -Wait",
            "[System.Windows.MessageBox]::Show('merhaba')",
            "Add-Type -AssemblyName System.Windows.Forms; \
             [System.Windows.Forms.MessageBox]::Show('merhaba', 'baslik')",
            "[Microsoft.VisualBasic.Interaction]::MsgBox('x')",
            "[Microsoft.VisualBasic.Interaction]::InputBox('ad?')",
            "(New-Object -ComObject WScript.Shell).Popup('merhaba', 0, 'Smith', 0)",
            // .Show() yalniz GUI baglaminda pencere sayilir
            "Add-Type -AssemblyName System.Windows.Forms; \
             $f = New-Object System.Windows.Forms.Form; $f.Show()",
            "Add-Type -AssemblyName PresentationFramework; $w = [Windows.Window]::new(); $w.Show()",
            "Add-Type -AssemblyName System.Windows.Forms; $f.Show()",
            // Form/pencere kurulumu + mesaj dongusu
            "[System.Windows.Forms.Application]::Run($form)",
            "Add-Type -AssemblyName PresentationFramework; \
             $w = [Windows.Markup.XamlReader]::Load($okuyucu)",
        ] {
            assert!(pencere_acan_komut(cmd), "pencere acan komut taninmadi: {cmd}");
        }
    }

    /// YANLIS POZITIF: pencere acmayan komutlar arka plana atilmamali; atilirsa
    /// modelin ciktisi ve cikis kodu sessizce kaybolur.
    #[test]
    fn pencere_tanima_yanlis_pozitif_vermez() {
        for cmd in [
            "Get-Process | Format-Table",
            "Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 | Format-Table Name, CPU",
            "Write-Host 'Show'",
            "Write-Host 'ShowDialog'",
            "git show",
            "git show HEAD~1 --stat",
            "git log --oneline | Select-Object -First 5",
            "Get-Content C:\\repo\\show.txt",
            "Get-Date -Format 'HH:mm'",
            "cargo test --lib",
            "$o.Show",
            "Start-Process notepad",
            "Get-Process | Select-Object -ExpandProperty MainWindowTitle",
            // GUI derlemesi yuklemek tek basina pencere DEGIL
            "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText('x')",
            "Add-Type -AssemblyName System.Windows.Forms; \
             [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $_.Bounds }",
            "Add-Type -AssemblyName PresentationFramework; \
             [System.Windows.SystemParameters]::PrimaryScreenWidth",
            // `Form`/`Window` ile baslayan ama farkli tur adlari
            "[System.Windows.Forms.FormBorderStyle]::None",
            "[System.Windows.WindowState]::Maximized",
        ] {
            assert!(!pencere_acan_komut(cmd), "yanlis pozitif: {cmd}");
        }
    }

    /// `.Show()` mesaj dongusu calistirmaz: betik bitince pencere kapanir. Bu
    /// durum icin modele ipucu doner; ShowDialog/Run kullananlara DONMEZ.
    #[test]
    fn show_icin_mesaj_dongusu_ipucu_verilir() {
        let yalniz_show = "Add-Type -AssemblyName System.Windows.Forms; \
                           $f = New-Object System.Windows.Forms.Form; $f.Show()";
        let ipucu = pencere_ipucu(yalniz_show).expect(".Show() icin ipucu beklenirdi");
        assert!(
            ipucu.contains("ShowDialog"),
            "ipucu cozumu soylemiyor: {ipucu}"
        );

        for cmd in [
            "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; \
             $f.ShowDialog()",
            "Add-Type -AssemblyName System.Windows.Forms; $f.Show(); \
             [System.Windows.Forms.Application]::Run($f)",
            "[System.Windows.MessageBox]::Show('x')",
            "Get-Process | Out-GridView",
        ] {
            assert_eq!(pencere_ipucu(cmd), None, "gereksiz ipucu: {cmd}");
        }
    }

    /// GIZLILIK ve FELAKET kapilari GUI yolunda da ONCE calisir: pencere
    /// olarak taninan komut bile kara listedeki yola dokunuyorsa kosmaz.
    #[test]
    fn pencere_komutunda_once_gizlilik_ve_felaket_kapisi_gelir() {
        let gizli = "Add-Type -AssemblyName System.Windows.Forms; \
                     $f = New-Object System.Windows.Forms.Form; \
                     $f.Text = (Get-Content C:\\x\\.env -Raw); $f.ShowDialog()";
        assert!(
            pencere_acan_komut(gizli),
            "bu test GUI olarak taninan komutla anlamli"
        );
        let v = terminal_calistir(gizli, false);
        assert!(
            v["hata"].as_str().unwrap_or("").contains("kara liste"),
            "gizlilik kapisi GUI yolunda atlandi: {v}"
        );
        assert!(
            v["durum"] == "reddedildi" && v["basarili"] == false && v.get("pid").is_none(),
            "surec baslamis: {v}"
        );

        // Zararsiz bir yasakli desen (yalniz surec kapsamli): kapi yine onde.
        let v = terminal_calistir(
            "Set-ExecutionPolicy -Scope Process Bypass; $f.ShowDialog()",
            false,
        );
        assert!(
            v["hata"].as_str().unwrap_or("").contains("reddedildi"),
            "felaket kapisi GUI yolunda atlandi: {v}"
        );
        assert!(
            v["durum"] == "reddedildi" && v["basarili"] == false && v.get("pid").is_none(),
            "surec baslamis: {v}"
        );

        // SURELI giris de ayni kapidan gecer (GUI + gizlilik, GUI + felaket).
        let v = terminal_calistir_sureli(gizli, false, Some(120));
        assert!(
            v["hata"].as_str().unwrap_or("").contains("kara liste"),
            "sureli giris gizlilik kapisini atladi: {v}"
        );
        let v = terminal_calistir_sureli(
            "Set-ExecutionPolicy -Scope Process Bypass; $f.ShowDialog()",
            true,
            Some(120),
        );
        assert!(
            v["hata"].as_str().unwrap_or("").contains("reddedildi"),
            "sureli giris felaket kapisini atladi: {v}"
        );
        assert!(
            v.get("is_id").is_none() && v.get("pid").is_none(),
            "surec baslamis: {v}"
        );
    }

    /// ZAMAN ASIMI SONUCU modeli "yapilamaz"a goturmemeli: neyin oldugunu,
    /// etkinin gorunmus olabilecegini, `arka_planda=true`yu ve kullaniciya
    /// sormayi acikca soylemeli. Mevcut alan adlari (`hata`, `sure_ms`) korunur.
    #[test]
    fn terminal_zaman_asimi_sonucu_modeli_yanlis_sonuca_goturmez() {
        // label=None => terminal_calistir kosusu (bkz. `PsOpts::label`).
        let v = run_powershell_opts(
            "Start-Sleep -Seconds 30",
            PsOpts {
                timeout: Duration::from_millis(400),
                ..Default::default()
            },
        );
        let hata = v["hata"].as_str().unwrap_or_default();
        assert!(
            hata.contains("bitmedi") && hata.contains("iptal edildi"),
            "mevcut hata metni korunmali: {v}"
        );
        assert!(
            v["sure_ms"].as_u64().is_some(),
            "sure_ms alani korunmali: {v}"
        );
        let aciklama = v["aciklama"].as_str().unwrap_or_default();
        for parca in [
            "durduruldu",
            "gorunmus olabilir",
            "arka_planda=true",
            "arka_plan_sonuc",
            "sure_sn",
            "yapilamaz",
            "kullaniciya sor",
        ] {
            assert!(
                aciklama.contains(parca),
                "zaman asimi aciklamasinda '{parca}' yok: {v}"
            );
        }

        // Ic cagrilar (etiketli: dosya_ara, sistem_durumu...) `arka_planda`
        // parametresi olmayan araclardir: onlara bu yonerge EKLENMEZ.
        let ic = run_powershell_opts(
            "Start-Sleep -Seconds 30",
            PsOpts {
                timeout: Duration::from_millis(400),
                label: Some("test: ic cagri zaman asimi"),
                ..Default::default()
            },
        );
        assert!(
            ic["aciklama"] == "komut BITMEDI, sonucu yok; basari iddia etme",
            "ic cagriya terminal yeniden deneme yonergesi eklenmemeli: {ic}"
        );
    }

    /// CANLI: pencere acan komut ARACI BLOKLAMAZ ve sureci OLDURMEZ: arac
    /// komutun bitmesinden (5 sn) cok once doner, surec isini sonra bitirir.
    /// (Surec gorunmez; calistirilmayan `ShowDialog()` dali komutu pencere olarak
    /// tanitir.)
    #[cfg(windows)]
    #[test]
    fn pencere_komutu_hemen_doner_ve_arka_planda_yasar() {
        let _lock = is_test_kilidi();
        let isaret = test_isareti("hemen");
        let _ = std::fs::remove_file(&isaret);
        let cmd = format!(
            "Start-Sleep -Milliseconds 5000; Set-Content -LiteralPath '{}' -Value $PID; if ($false) {{ $f.ShowDialog() }}",
            isaret.display()
        );
        assert!(
            pencere_acan_komut(&cmd),
            "bu test GUI olarak taninan komutla anlamli"
        );

        let basla = Instant::now();
        let v = terminal_calistir(&cmd, false);
        let gecen = basla.elapsed();
        eprintln!(
            "[test] pencere komutu donus suresi: {} ms",
            gecen.as_millis()
        );

        assert_eq!(
            v["is_durumu"], "pencere arka planda acildi",
            "beklenen durum yok: {v}"
        );
        assert!(
            v.get("hata").is_none() && v.get("cikis_kodu").is_none(),
            "pencere komutu bitmesi beklenerek kosulmus: {v}"
        );
        assert!(
            !isaret.exists(),
            "arac komutun bitmesini bekledi: marker donusten once yazildi ({} ms)",
            gecen.as_millis()
        );
        // Ayri surec yolu kullanildi (dogrudan-arka-plan yedegine DUSULMEDI):
        // yedek `uyari` ve `pid` tasirdi.
        assert!(
            v.get("uyari").is_none() && v.get("pid").is_none(),
            "ayri surec yerine yedek yola dusuldu: {v}"
        );

        let yazilan = isaret_bekle(&isaret, Duration::from_secs(40))
            .expect("surec arac dondukten sonra OLDURULDU: isaret dosyasi hic yazilmadi");
        let pid = yazilan
            .trim()
            .parse::<u32>()
            .expect("isaret bir pid olmali");
        assert!(
            pid > 0 && pid != std::process::id(),
            "isaret baska bir surecin pid'i olmali: {yazilan:?}"
        );
        let _ = std::fs::remove_file(&isaret);
    }

    /// CANLI: pencere betigi ayri surece BOZULMADAN gecer ve STA dairesinde
    /// kosar (WinForms/WPF STA ister). Betik `cmd.exe` katmanindan degil ortam
    /// degiskeninden gectigi icin `& | ^ ! %PATH%`, tirnak ve Turkce karakter
    /// cmd'nin yorumuna girmez; bu test bunu sabitler.
    #[cfg(windows)]
    #[test]
    fn pencere_betigi_sta_calisir_ve_ozel_karakterleri_korur() {
        let isaret = test_isareti("sta");
        let _ = std::fs::remove_file(&isaret);
        let cmd = format!(
            "Set-Content -LiteralPath '{}' -Value ([Threading.Thread]::CurrentThread.GetApartmentState().ToString() + '|' + 'ç''&|^!%PATH%\"x'); if ($false) {{ $f.ShowDialog() }}",
            isaret.display()
        );
        assert!(
            pencere_acan_komut(&cmd),
            "bu test GUI olarak taninan komutla anlamli"
        );
        let v = terminal_calistir(&cmd, false);
        assert_eq!(v["is_durumu"], "pencere arka planda acildi", "{v}");
        assert!(v.get("uyari").is_none(), "yedek yola dusuldu: {v}");

        let yazilan = isaret_bekle(&isaret, Duration::from_secs(40))
            .expect("betik calismadi: isaret dosyasi yazilmadi");
        assert_eq!(
            yazilan.trim(),
            "STA|ç'&|^!%PATH%\"x",
            "betik bozuldu ya da STA degil"
        );
        let _ = std::fs::remove_file(&isaret);
    }

    /// CANLI: `.Show()` ipucu gercek donusta da gorunur (alan adi: `ipucu`).
    #[cfg(windows)]
    #[test]
    fn show_komutu_sonucunda_ipucu_alani_doner() {
        // Betik 300 ms uyur ve cikar; ulasilmayan dal GUI siniflandirmasini sinar.
        let cmd = "Start-Sleep -Milliseconds 300; if ($false) { [System.Windows.Forms.Application]::EnableVisualStyles(); $f.Show() }";
        assert!(
            pencere_acan_komut(cmd),
            "bu test GUI olarak taninan komutla anlamli"
        );
        // Sureli giris + `arka_planda=true` verilse bile GUI yolu kazanir
        // (is dosyasi acilmaz, pencere ayri surec olarak baslar).
        let v = terminal_calistir_sureli(cmd, true, Some(60));
        assert_eq!(v["is_durumu"], "pencere arka planda acildi", "{v}");
        assert!(
            v.get("is_id").is_none(),
            "GUI komutu is dosyasina gitmemeli: {v}"
        );
        assert!(
            v["ipucu"].as_str().unwrap_or("").contains("ShowDialog"),
            "ipucu alani yok: {v}"
        );
    }

    /// CANLI: genel arka plan yolu (`open_app`, `run_powershell(.., true)`)
    /// parent boruyu birakmis olsa bile cikti yazan sureci OLDURMEZ. Eskiden
    /// stdout/stderr `piped()` ama hic okunmuyor ve `Child` dusurulunce borular
    /// kapaniyordu. OLCUM (2026-10-02): PowerShell kirik boruya yazmayi
    /// tolere ediyor, yani bu test duzeltmeden ONCE de gecer; `Stdio::null()`
    /// kirik boru bagimliligini kaldirir ve bu testle korunur.
    #[cfg(windows)]
    #[test]
    fn arka_plan_sureci_cikti_yazinca_olmez() {
        let isaret = test_isareti("cikti");
        let _ = std::fs::remove_file(&isaret);
        let cmd = format!(
            "Start-Sleep -Milliseconds 1500; Write-Output 'cikti'; \
             [Console]::Error.WriteLine('hata'); \
             Set-Content -LiteralPath '{}' -Value 'tamam'",
            isaret.display()
        );
        let v = run_powershell(&cmd, true);
        assert_eq!(v["is_durumu"], "arka planda baslatildi", "{v}");
        let yazilan = isaret_bekle(&isaret, Duration::from_secs(30))
            .expect("arka plan sureci cikti yazarken oldu: isaret yazilmadi");
        assert_eq!(yazilan.trim(), "tamam");
        let _ = std::fs::remove_file(&isaret);
    }

    /// Smith TAKLIDI: normal kosuda hicbir sey yapmaz. Asagidaki iki test bu
    /// test ikilisini yeniden calistirir; yardimci surec `terminal_calistir`i
    /// cagirir, sonucu `<isaret>.basladi`ya yazar ve (istenirse) `taskkill /T`
    /// ile oldurulmeyi bekler. Yani gercek "Smith kapandi / yeniden basladi"
    /// senaryosu, gercek kodla.
    #[test]
    fn yardimci_smith_taklidi() {
        let Ok(isaret) = std::env::var("SMITH_TEST_PENCERE_ISARET") else {
            return;
        };
        let uyku = std::env::var("SMITH_TEST_PENCERE_UYKU_MS").unwrap_or_else(|_| "5000".into());
        let cmd = format!(
            "Start-Sleep -Milliseconds {uyku}; Set-Content -LiteralPath '{isaret}' -Value $PID; if ($false) {{ $f.ShowDialog() }}"
        );
        // SMITH_TEST_DOGRUDAN: pencere yolunu atlayip GENEL arka plan yolunu
        // (dogrudan alt surec) sinar; yalniz karsilastirmali olcum icin.
        let v = if std::env::var("SMITH_TEST_DOGRUDAN").is_ok() {
            run_powershell(&cmd, true)
        } else {
            terminal_calistir(&cmd, false)
        };
        std::fs::write(format!("{isaret}.basladi"), v.to_string()).expect("basladi yazilamadi");
        if std::env::var("SMITH_TEST_SMITH_BEKLE").is_ok() {
            // Oldurulmeyi bekler (test, `taskkill /T` ile bitirir).
            std::thread::sleep(Duration::from_secs(120));
        }
    }

    /// Yardimcinin donmesi beklenen `durum` degeri (karsilastirmali olcumde
    /// `SMITH_TEST_DOGRUDAN` ayarliysa genel arka plan yolu).
    #[cfg(windows)]
    fn beklenen_durum() -> &'static str {
        if std::env::var("SMITH_TEST_DOGRUDAN").is_ok() {
            "arka planda baslatildi"
        } else {
            "pencere arka planda acildi"
        }
    }

    #[cfg(windows)]
    fn smith_taklidi_baslat(
        isaret: &std::path::Path,
        uyku_ms: u32,
        bekle: bool,
    ) -> std::process::Child {
        let mut c = Command::new(std::env::current_exe().expect("test ikilisi bulunamadi"));
        c.args([
            "--exact",
            "system_tools::tests::yardimci_smith_taklidi",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("SMITH_TEST_PENCERE_ISARET", isaret)
        .env("SMITH_TEST_PENCERE_UYKU_MS", uyku_ms.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
        if bekle {
            c.env("SMITH_TEST_SMITH_BEKLE", "1");
        }
        c.spawn().expect("smith taklidi baslatilamadi")
    }

    /// CANLI: Smith KAPANINCA pencere sureci yasamaya devam eder.
    #[cfg(windows)]
    #[test]
    fn pencere_sureci_smith_kapaninca_yasar() {
        let isaret = test_isareti("kapanis");
        let basladi = std::path::PathBuf::from(format!("{}.basladi", isaret.display()));
        let _ = std::fs::remove_file(&isaret);
        let _ = std::fs::remove_file(&basladi);

        let mut smith = smith_taklidi_baslat(&isaret, 6000, false);
        let _ = smith.wait(); // "Smith" cikti
        let b = std::fs::read_to_string(&basladi).expect("yardimci sonuc yazmadi");
        assert!(b.contains(beklenen_durum()), "pencere acilmadi: {b}");

        assert!(
            isaret_bekle(&isaret, Duration::from_secs(40)).is_some(),
            "pencere sureci Smith kapanirken OLDU"
        );
        let _ = std::fs::remove_file(&isaret);
        let _ = std::fs::remove_file(&basladi);
    }

    /// CANLI: Smith'in SUREC AGACI oldurulunce (`taskkill /T`: `tauri dev`
    /// yeniden derlemesi, `smith-up.ps1` launcher durdurma ve elle yeniden
    /// baslatma ayni yontemi kullanir) pencere sureci OLMEZ. Dogrudan alt surec
    /// olarak baslatilsaydi agacin parcasi olur ve burada olurdu.
    #[cfg(windows)]
    #[test]
    fn pencere_sureci_smith_surec_agaci_olunce_yasar() {
        let isaret = test_isareti("agac");
        let basladi = std::path::PathBuf::from(format!("{}.basladi", isaret.display()));
        let _ = std::fs::remove_file(&isaret);
        let _ = std::fs::remove_file(&basladi);

        let mut smith = smith_taklidi_baslat(&isaret, 9000, true);
        isaret_bekle(&basladi, Duration::from_secs(30)).expect("pencere baslatilamadi");
        let b = std::fs::read_to_string(&basladi).unwrap_or_default();
        assert!(b.contains(beklenen_durum()), "pencere acilmadi: {b}");

        // Smith yeniden baslatildi: surec agaci oldurulur.
        let kill = Command::new("taskkill.exe")
            .args(["/PID", &smith.id().to_string(), "/T", "/F"])
            .output()
            .expect("taskkill calismadi");
        assert!(kill.status.success(), "taskkill basarisiz: {kill:?}");
        let _ = smith.wait();

        assert!(
            isaret_bekle(&isaret, Duration::from_secs(40)).is_some(),
            "pencere sureci Smith'in surec agaciyla birlikte OLDU"
        );
        let _ = std::fs::remove_file(&isaret);
        let _ = std::fs::remove_file(&basladi);
    }

    // -----------------------------------------------------------------------
    // KOMUT BASINA SURE + ARKA PLAN ISLERI
    //
    // SAHA (2026-10-02): "en buyuk veri nerede" -> `Get-ChildItem -Recurse |
    // Measure-Object` 20 sn'de oldurulduk; Smith sessiz kaldi, kullanici "orada
    // misin" dedi, sonuc hic gelmedi. Cozum: komut basina sure (5-300 sn) ve
    // sonucu sonradan sorulabilen arka plan isleri (`arka_plan_sonuc`).
    // -----------------------------------------------------------------------

    #[test]
    fn sure_siniri_kirpilir() {
        assert_eq!(
            sure_sinirla(None),
            Duration::from_secs(20),
            "varsayilan bugunku 20 sn"
        );
        for (girdi, beklenen) in [
            (0u64, 5u64),
            (1, 5),
            (4, 5),
            (5, 5),
            (6, 6),
            (20, 20),
            (120, 120),
            (300, 300),
            (301, 300),
            (3600, 300),
            (u64::MAX, 300),
        ] {
            assert_eq!(
                sure_sinirla(Some(girdi)),
                Duration::from_secs(beklenen),
                "girdi {girdi} sn"
            );
        }
    }

    /// CANLI: istenen sure alt sinira yukseltilir ve GERCEKTEN uygulanir
    /// (`Some(1)` -> 5 sn; 30 sn'lik uyku 5 sn'de kesilir, 1 sn'de degil).
    #[cfg(windows)]
    #[test]
    fn sureli_terminal_siniri_uc_uca_uygulanir() {
        let basla = Instant::now();
        let v = terminal_calistir_sureli("Start-Sleep -Seconds 30", false, Some(1));
        let gecen = basla.elapsed();
        assert!(
            v["hata"].as_str().unwrap_or("").contains("5 saniye"),
            "alt sinir (5 sn) uygulanmadi: {v}"
        );
        assert!(
            gecen >= Duration::from_secs(5) && gecen < Duration::from_secs(20),
            "sure sinirina uyulmadi: {} ms",
            gecen.as_millis()
        );
    }

    fn test_is_dizini(etiket: &str) -> std::path::PathBuf {
        let d =
            std::env::temp_dir().join(format!("smith-jobs-test-{etiket}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d); // yalniz bu testin kendi gecici dizini
        d
    }

    /// Is `durum == "bitti"` olana kadar sorar (en cok `en_cok`).
    fn is_bitmesini_bekle(
        dizin: &std::path::Path,
        is_id: &str,
        en_cok: Duration,
    ) -> serde_json::Value {
        let basla = Instant::now();
        loop {
            let s = arka_plan_sonuc_in(dizin, is_id);
            if s["durum"] != "calisiyor" || basla.elapsed() > en_cok {
                return s;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// CANLI (gorunmez, hemen biten surec): arac HEMEN `is_id` doner; cikti
    /// dosyaya yazilir; sonuc durum + cikis kodu + cikti + gecen sureyi verir.
    #[cfg(windows)]
    #[test]
    fn arka_plan_is_hemen_doner_ve_sonucu_okunur() {
        let _lock = is_test_kilidi();
        let dizin = test_is_dizini("sonuc");
        let _cleanup = IsTestAlani(dizin.clone());
        let basla = Instant::now();
        let v = arka_plan_is_baslat_in(
            &dizin,
            "Write-Output 'merhaba is'; [Console]::Error.WriteLine('hata satiri'); exit 3",
        );
        assert!(basla.elapsed() < Duration::from_secs(3), "arac isi bekledi");
        assert_eq!(v["is_durumu"], "arka planda calisiyor", "{v}");
        let is_id = v["is_id"].as_str().expect("is_id donmeli").to_string();
        assert!(
            is_id_gecerli(&is_id),
            "uretilen is_id kendi dogrulamasindan gecmeli: {is_id}"
        );

        // Dosya adi log temizliginin `<ad>-yyyyMMdd.log` desenine UYMAZ.
        let ad = format!("job-{is_id}.out");
        assert!(dizin.join(&ad).is_file(), "cikti dosyasi yok");
        assert!(
            !ad.ends_with(".log"),
            "log temizligi deseniyle cakisir: {ad}"
        );

        let s = is_bitmesini_bekle(&dizin, &is_id, Duration::from_secs(30));
        assert_eq!(s["durum"], "hata", "{s}");
        assert_eq!(s["basarili"], false);
        assert_eq!(s["cikis_kodu"], 3, "cikis kodu yok/yanlis: {s}");
        let cikti = s["cikti"].as_str().unwrap_or_default();
        assert!(cikti.contains("merhaba is"), "stdout yok: {s}");
        assert!(cikti.contains("hata satiri"), "stderr dosyaya gitmedi: {s}");
        assert!(s["gecen_sn"].as_f64().is_some(), "gecen sure yok: {s}");
        assert_eq!(s["is_id"], is_id.as_str());
        let _ = std::fs::remove_dir_all(&dizin);
    }

    /// CANLI: calisan is `calisiyor` der, cikis kodu YOKTUR; bitince `bitti`.
    #[cfg(windows)]
    #[test]
    fn arka_plan_is_calisirken_durum_calisiyor_der() {
        let _lock = is_test_kilidi();
        let dizin = test_is_dizini("calisan");
        let _cleanup = IsTestAlani(dizin.clone());
        let v = arka_plan_is_baslat_in(
            &dizin,
            "Write-Output 'basladi'; Start-Sleep -Seconds 4; Write-Output 'bitti'",
        );
        let is_id = v["is_id"].as_str().expect("is_id donmeli").to_string();

        let s = arka_plan_sonuc_in(&dizin, &is_id);
        assert_eq!(s["durum"], "calisiyor", "is hemen bitmis gorunuyor: {s}");
        assert!(
            s.get("cikis_kodu").is_none(),
            "calisan isin cikis kodu olmaz: {s}"
        );
        assert!(s["gecen_sn"].as_f64().is_some(), "gecen sure yok: {s}");

        let s = is_bitmesini_bekle(&dizin, &is_id, Duration::from_secs(40));
        assert_eq!(s["durum"], "bitti", "{s}");
        assert_eq!(s["cikis_kodu"], 0, "{s}");
        assert!(
            s["cikti"].as_str().unwrap_or_default().contains("bitti"),
            "{s}"
        );
        let _ = std::fs::remove_dir_all(&dizin);
    }

    /// Arka plan isi de felaket kapisindan gecer (surec baslamaz, dosya acilmaz).
    #[test]
    fn arka_plan_isi_felaket_kapisindan_gecer() {
        let dizin = test_is_dizini("felaket");
        let v = arka_plan_is_baslat_in(&dizin, "Set-ExecutionPolicy -Scope Process Bypass");
        assert!(
            v["hata"].as_str().unwrap_or("").contains("reddedildi"),
            "felaket kapisi is yolunda atlandi: {v}"
        );
        assert!(v.get("is_id").is_none(), "{v}");
        assert!(!dizin.exists(), "reddedilen komut icin dizin/dosya acildi");
    }

    fn is_sonucu(durum: &'static str, kod: Option<i32>, hata: Option<&str>) -> IsSonucu {
        IsSonucu {
            sure: Duration::from_secs(3),
            kod,
            durum,
            hata: hata.map(str::to_string),
        }
    }

    /// Bitis bildirimi: durum sozcugu, ozet/cikis kodu/hata metni onceligi, tek
    /// nokta; iptal edilen is icin bildirim YOK.
    #[test]
    fn bitis_bildirimi_durum_ozet_ve_iptal() {
        let id = "0123456789abcdef0123456789abcdef";
        let b = |s: &IsSonucu, kuyruk: &str| bitis_bildirimi(id, s, kuyruk);
        assert_eq!(
            b(&is_sonucu("bitti", Some(0), None), "Downloads: 12 GB; Videos: 8 GB").as_deref(),
            Some(&*format!(
                "Arka plan isi {id} bitti: basarili, Downloads: 12 GB; Videos: 8 GB. Sonucu Cihan'a bildir."
            ))
        );
        for (sonuc, kuyruk, beklenen) in [
            (
                is_sonucu("bitti", Some(3), None),
                "hata satiri",
                "hata, hata satiri",
            ),
            (
                is_sonucu("bitti", Some(3), None),
                "  \n ",
                "hata, cikis kodu 3",
            ),
            (
                is_sonucu("zaman_asimi", None, None),
                "",
                "zaman asimi, cikti yok",
            ),
            (
                is_sonucu("zaman_asimi", None, None),
                "yarim cikti",
                "zaman asimi, yarim cikti",
            ),
            (
                is_sonucu("hata", None, Some("is ciktisi yazilamadi")),
                "",
                "hata, is ciktisi yazilamadi",
            ),
            (
                is_sonucu("cikti_kotasi", Some(0), None),
                "cok cikti",
                "hata, cok cikti",
            ),
            (
                is_sonucu("durdurma_hatasi", None, Some("surec durmadi")),
                "",
                "hata, surec durmadi",
            ),
            (
                is_sonucu("bitti", Some(0), None),
                "Tamam.",
                "basarili, Tamam",
            ),
        ] {
            let metin = b(&sonuc, kuyruk).expect("bildirim beklenir");
            assert!(
                metin.starts_with(&format!("Arka plan isi {id} bitti: {beklenen}. Sonucu")),
                "{metin}"
            );
            assert!(metin.ends_with(". Sonucu Cihan'a bildir."), "{metin}");
            assert!(!metin.contains(".."), "cift nokta: {metin}");
        }
        assert_eq!(b(&is_sonucu("iptal", None, None), "kismi cikti"), None);
    }

    #[test]
    fn bitis_ozeti_maskeli_tek_satir_ve_sinirli() {
        // Satir sonlari ozetten ONCE maskeleme icin gorulur (PEM blogu satirlar boyunca).
        let sirli = "yukleme tamam\nAuthorization: Bearer abcdef0123456789SIRRINKENDISI\n\
                     -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----\nson";
        let ozet = bildirim_ozeti(sirli);
        assert!(!ozet.contains("SIRRINKENDISI"), "{ozet}");
        assert!(!ozet.contains("MIIEvQIBADANBgkq"), "{ozet}");
        assert!(ozet.contains("[MASKELI"), "{ozet}");
        assert!(!ozet.contains('\n') && !ozet.contains("  "), "{ozet:?}");
        assert!(ozet.ends_with("son"));

        let uzun = format!("{} SON", "ç".repeat(1000));
        let kirpik = bildirim_ozeti(&uzun);
        assert_eq!(kirpik.chars().count(), BILDIRIM_OZET_KARAKTER, "{kirpik}");
        assert!(
            kirpik.starts_with("...") && kirpik.ends_with("ç SON"),
            "sonu korunmali"
        );
        assert_eq!(bildirim_ozeti("kisa"), "kisa");
        assert_eq!(bildirim_ozeti(" \n\t "), "");
    }

    /// Izleyicinin bitis adimi: sonuc kayda ONCE yazilir (model bildirimi alinca
    /// `arka_plan_sonuc` zaten `bitti` gorur), bildirim ondan sonra gider; iptal
    /// edilen isin sonucu da yazilir ama bildirim gitmez.
    #[test]
    fn isi_kapat_once_kaydeder_sonra_bildirir_iptalde_susar() {
        let dizin = test_is_dizini("kapat");
        std::fs::create_dir_all(&dizin).expect("dizin");
        let id = "abababababababababababababababab";
        let yol = dizin.join(format!("job-{id}.out"));
        std::fs::write(&yol, "Downloads: 12 GB; Videos: 8 GB\n").expect("yaz");
        let yeni_kayit = || IsKaydi {
            basladi: Instant::now(),
            pid: 0,
            dizin: dizin.clone(),
            iptal: Default::default(),
            bitti: Default::default(),
        };

        let kayit = yeni_kayit();
        let mut gelen = Vec::new();
        isi_kapat(&kayit, id, &yol, is_sonucu("bitti", Some(0), None), |m| {
            assert!(
                kayit.bitti.lock().unwrap().is_some(),
                "bildirim sonuc kaydedilmeden gitti"
            );
            gelen.push(m);
        });
        assert_eq!(
            gelen,
            vec![format!(
                "Arka plan isi {id} bitti: basarili, Downloads: 12 GB; Videos: 8 GB. Sonucu Cihan'a bildir."
            )]
        );

        let iptal = yeni_kayit();
        isi_kapat(&iptal, id, &yol, is_sonucu("iptal", None, None), |m| {
            panic!("iptal icin bildirim gitti: {m}")
        });
        assert_eq!(iptal.bitti.lock().unwrap().as_ref().unwrap().durum, "iptal");

        // Cikti dosyasi yoksa (silinmis) bildirim yine gider, ozet yerine cikis kodu.
        let yok = yeni_kayit();
        let mut yok_gelen = Vec::new();
        isi_kapat(
            &yok,
            id,
            &dizin.join("yok.out"),
            is_sonucu("bitti", Some(2), None),
            |m| yok_gelen.push(m),
        );
        assert!(yok_gelen[0].contains("hata, cikis kodu 2"), "{yok_gelen:?}");
        let _ = std::fs::remove_dir_all(&dizin);
    }

    /// `is_id` YOL GECISINE KAPALI: yalniz tam 32 kucuk hex karakter gecer;
    /// `..`, ayirici, surucu, uzunluk/BUYUK harf oynamalari reddedilir ve
    /// reddedilen girdi cevapta yankilanmaz.
    #[test]
    fn is_id_dogrulamasi_yol_gecisine_kapali() {
        let dizin = test_is_dizini("dogrulama");
        std::fs::create_dir_all(&dizin).expect("dizin");
        let id = "0123456789abcdef0123456789abcdef";
        assert!(is_id_gecerli(id));

        let otuz_bir = &id[..31];
        let otuz_uc = format!("{id}0");
        let buyuk = id.to_uppercase();
        let gecis_1 = format!("..\\{id}");
        let gecis_2 = format!("../{id}");
        let gecis_3 = format!("{id}\\..");
        let gecis_4 = format!("{id}/x");
        let dosya_adi = format!("job-{id}.out");
        for kotu in [
            "",
            " ",
            ".",
            "..",
            "../x",
            "..\\..\\Windows\\win.ini",
            "C:\\Windows\\win.ini",
            "\\\\sunucu\\paylasim\\x",
            "a/b",
            "%2e%2e%2f",
            "job-",
            "*",
            "?",
            otuz_bir,
            otuz_uc.as_str(),
            buyuk.as_str(),
            gecis_1.as_str(),
            gecis_2.as_str(),
            gecis_3.as_str(),
            gecis_4.as_str(),
            dosya_adi.as_str(),                     // tam dosya adi is_id DEGILDIR
            "0123456789abcdef0123456789abcdeg",     // 32 karakter ama hex degil
            "0123456789abcdef0123456789abcd\u{e7}", // coklu bayt
        ] {
            assert!(!is_id_gecerli(kotu), "gecersiz is_id gecti: {kotu:?}");
            let v = arka_plan_sonuc_in(&dizin, kotu);
            assert!(
                v["hata"].as_str().unwrap_or("").contains("gecersiz"),
                "is_id reddedilmedi: {kotu:?} -> {v}"
            );
            assert!(
                v.get("cikti").is_none(),
                "gecersiz is_id icin cikti okundu: {kotu:?}"
            );
            assert!(
                !v.to_string().contains("Windows") && !v.to_string().contains("sunucu"),
                "girdi cevapta yankilandi: {v}"
            );
        }

        // Gecerli bicimde ama olmayan is: temiz 'bulunamadi'.
        let v = arka_plan_sonuc_in(&dizin, id);
        assert!(
            v["hata"].as_str().unwrap_or("").contains("bulunamadi"),
            "olmayan is: {v}"
        );
        let _ = std::fs::remove_dir_all(&dizin);
    }

    /// Cikti SON 8 KB ile sinirlidir (kuyruk: bitisteki hata/sonuc onemlidir),
    /// kirpilma belirtilir, coklu bayt karakter ortasindan kesilince metin
    /// bozulmaz. Registry'de olmayan is (Smith yeniden basladi) `bilinmiyor`dur.
    #[test]
    fn sonuc_ciktisi_son_8kb_ile_sinirlidir() {
        let dizin = test_is_dizini("kuyruk");
        std::fs::create_dir_all(&dizin).expect("dizin");

        let uzun_id = "abababababababababababababababab";
        let icerik = format!("{}SON-SATIR", "\u{e7}".repeat(6000)); // 12 KB, 2 bayt/karakter
        std::fs::write(dizin.join(format!("job-{uzun_id}.out")), icerik).expect("yaz");
        let v = arka_plan_sonuc_in(&dizin, uzun_id);
        assert_eq!(v["is_durumu"], "bilinmiyor", "kayitta olmayan is: {v}");
        let c = v["cikti"].as_str().expect("cikti");
        assert!(c.ends_with("SON-SATIR"), "kuyruk degil bas dondu: {c:?}");
        assert!(c.contains("kirpildi"), "kirpilma belirtilmedi");
        assert!(c.len() <= MAX_OUTPUT + 128, "8 KB'i asti: {} bayt", c.len());
        assert!(
            !c.contains('\u{fffd}'),
            "coklu bayt karakter ortasindan kesildi"
        );

        let kisa_id = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
        std::fs::write(dizin.join(format!("job-{kisa_id}.out")), "kisa cikti\n").expect("yaz");
        let v = arka_plan_sonuc_in(&dizin, kisa_id);
        assert_eq!(
            v["cikti"], "kisa cikti",
            "kisa cikti dokunulmadan donmeli: {v}"
        );
        let _ = std::fs::remove_dir_all(&dizin);
    }

    /// Temizlik YALNIZ tam ad desenine (`job-<32 kucuk hex>.out`) dokunur.
    /// Joker kusuru (Windows'ta `?` sifir karakterle de eslesir) ayni dizindeki
    /// BASKA dosyalari silmemeli: bu yuzden deseni joker degil tam ad kontroluyle
    /// eslestiriyoruz ve hepsini burada somut adlarla sabitliyoruz.
    #[test]
    fn eski_is_temizligi_yalniz_tam_ad_desenine_dokunur() {
        let dizin = test_is_dizini("temizlik");
        std::fs::create_dir_all(&dizin).expect("dizin");
        let id = "0123456789abcdef0123456789abcdef";
        let silinecek = format!("job-{id}.out");
        let korunacak_dizin = format!("job-{}.out", "99887766554433221100ffeeddccbbaa");
        std::fs::create_dir_all(dizin.join(&korunacak_dizin)).expect("dizin adli girdi");
        let korunacaklar: Vec<String> = vec![
            "job-.out".into(), // `?`/`*` kusuru: sifir karakter
            "job-x.out".into(),
            format!("job-{}.out", &id[..31]),
            format!("job-{id}0.out"),
            format!("job-{id}.out.bak"),
            format!("job-{id}.exit"),
            format!("job-{}.out", "ABCDEF0123456789ABCDEF0123456789"), // buyuk harf
            format!("xjob-{id}.out"),
            "app-20260101.log".into(),
            "notlar.txt".into(),
        ];
        std::fs::write(dizin.join(&silinecek), "x").expect("yaz");
        for k in &korunacaklar {
            std::fs::write(dizin.join(k), "x").expect("yaz");
        }

        // Taze dosya 24 saat esiginde SILINMEZ.
        assert_eq!(
            eski_isleri_temizle_in(&dizin, Duration::from_secs(24 * 3600)),
            0
        );
        assert!(dizin.join(&silinecek).exists(), "taze is silindi");

        // Esik sifir: yalniz tam desene uyan DOSYA silinir.
        assert_eq!(eski_isleri_temizle_in(&dizin, Duration::ZERO), 1);
        assert!(!dizin.join(&silinecek).exists(), "eski is silinmedi");
        for k in &korunacaklar {
            assert!(dizin.join(k).exists(), "desene UYMAYAN dosya silindi: {k}");
        }
        assert!(
            dizin.join(&korunacak_dizin).is_dir(),
            "dizin adli girdi silindi"
        );

        // Desen taniyicisi: tam ad -> id, gerisi None.
        assert_eq!(is_dosya_adindan_id(&silinecek), Some(id));
        for k in &korunacaklar {
            assert_eq!(is_dosya_adindan_id(k), None, "yanlis eslesme: {k}");
        }
        let _ = std::fs::remove_dir_all(&dizin);
    }
}
