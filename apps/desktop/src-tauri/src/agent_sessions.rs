//! Claude Code ve Codex oturumlarini OKUR. Yalniz okuma; hicbir sey yazmaz.
//!
//! NEDEN AYRI MODUL: `system_tools.rs` makineyle konusur (PowerShell, COM,
//! WinAPI). Buradaki is tamamen iki AYRI KAYIT FORMATINI ayristirmak ve
//! sonucu bir GIZLILIK BUTCESINE sigdirmak. Iki kaygiyi ayni dosyada tutmak
//! butceyi gozden kaciran bir duzenlemeye davetiye olurdu.
//!
//! ## Gizlilik: bu modulun varlik sebebi kadar onemli
//!
//! Oturum kayitlari bu makinedeki EN HASSAS dosyalar arasinda: icinde
//! musteri anahtarlari, `.env` icerikleri, tam dosya dokumleri ve baskalarina
//! ait veriler var. Smith'in baglami ise buluttaki modele gidiyor. Dolayisiyla
//! "oturumlari oku" araci, dikkatsiz yazilirsa bir SIZINTI KANALIDIR.
//!
//! Dort katmanli savunma:
//!   1. VARSAYILAN ICERIK YOK. Liste modu yalnizca meta veri dondurur (baslik,
//!      proje, dal, zaman, boyut, etkinlik). "Ne uzerinde calisiyorum" sorusunun cevabi
//!      icin konusma metnine GEREK YOKTUR. Meta veri alanlari (`cwd`, dal,
//!      baslik musteri adi veya token tasiyabilir) da maskelenir ve alan/toplam
//!      bayt kotasina girer (`metadata_sanitize`).
//!   2. Icerik ancak `icerik=true` ile gelir ve YALNIZ KULLANICI PROMPT'LARI
//!      dondurulur. Arac cikti/lari, dosya icerikleri ve asistan yanitlari
//!      HIC cikarilmaz. Etkinlik yalniz arac adi ve ilk dizin/uzanti sayimini alir;
//!      asistan metni, thinking, komut, todo ve arac sonucu alinmaz.
//!   3. Donen her metin `maskele()`'den gecer ve sert bir bayt butcesine
//!      kirpilir.
//!
//!   4. [`YASAK_PARCALAR`]: kimlik dosyalari (`auth.json`,
//! `.credentials.json`, `.env`) bu modulun ACAMAYACAGI dosyalardir. Kontrol
//! yol duzeyinde, icerige bakmadan yapilir. Oturum agacinda symlink ve
//! junction da izlenmez: kok disina cikan dizin okunmaz
//! (`gercek_alt_dizinler`).

use crate::time_util::sivil_tarih;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Liste modunda donen varsayilan oturum sayisi.
const ADET_VARSAYILAN: usize = 8;
/// Ust sinir. Model "hepsini getir" derse bile bu asilmaz: 598 oturumun meta
/// verisi bile tek arac yanitina sigmaz ve konusmayi bogar.
const ADET_MAX: usize = 20;

/// Baslik/cwd/dal icin dosyanin BASINDAN okunacak pencere.
///
/// Neden pencere: bu oturumun kendi kaydi 16 MB. Tam okumak hem yavas hem
/// gereksiz — aradigimiz alanlar ilk kayitlarda. Pencere disinda kalan bir
/// baslik "yok" olarak doner; yanlis bilgi donmez.
const PENCERE_BYTES: usize = 64 * 1024;
/// Etkinlik yalniz son 512 KiB icindeki tam kayitlardan uretilir.
const SON_PENCERE_BYTES: usize = 512 * 1024;
/// Liste modunda tek bir meta veri alaninin (baslik, proje, dal...) bayt siniri.
const META_ALAN_BYTES: usize = 160;
/// Tum arac yanitindaki meta veri nesnelerinin (etkinlik haric) toplam JSON bayt
/// butcesi; asilirsa kalan oturumlar listelenmez.
const META_TOPLAM_BYTES: usize = 6000;
/// JSON kacislari ve alan adlari DAHIL, icerik butcesinden bagimsiz.
const ETKINLIK_MAX_BYTES: usize = 700;
/// Tum arac yanitindaki etkinlik nesnelerinin toplam JSON bayt butcesi.
const ETKINLIK_TOPLAM_BYTES: usize = 2000;

/// Icerik modunda TOPLAM bayt butcesi. `live.rs`'teki `KONUSMA_MAX_BYTES`
/// (1200) ile bilincli olarak ayni mertebede: ikisi de "modele ne kadar
/// gecmis girer" sorusunun cevabi.
const ICERIK_MAX_BYTES: usize = 1200;
/// Tek bir prompt'un kirpilma sinirri.
const ICERIK_MAX_PROMPT: usize = 220;
/// Icerik modunda en fazla kac prompt dondurulur.
const ICERIK_MAX_ADET: usize = 6;

/// "Canli" esigi: bu sureden yeni yazilmis bir oturum su an aciktir.
/// Claude Code her mesajda dosyaya yazdigi icin mtime guvenilir bir nabizdir.
const CANLI_ESIK: Duration = Duration::from_secs(5 * 60);

/// Yol duzeyinde ACILMASI YASAK dosyalar. Bu modul kimlik dosyalarina
/// dokunmaz; kontrol icerige bakmadan, yolun kendisinde yapilir.
///
/// `.codex/auth.json` ve `~/.claude/.credentials.json` gercek OAuth
/// jetonlarini tasiyor. Bunlari "zaten okumuyoruz" demek yeterli degil —
/// gelecekte bir glob genislemesi kazara kapsayabilir, o yuzden kapi kodda.
const YASAK_PARCALAR: &[&str] = &["auth.json", ".credentials", ".env", "id_ed25519", "id_rsa"];

/// Anahtar adinin SONU bunlardan biriyse (`x_api_key`, `Authorization`) deger
/// bir sirdir.
const HASSAS_ADLAR: &[&str] = &[
    "password",
    "passwd",
    "parola",
    "secret",
    "token",
    "apikey",
    "api_key",
    "key",
    "credential",
    "sifre",
    "authorization",
    "signature",
    "sig",
];

fn hassas_ad(ad: &str) -> bool {
    let kucuk = ad.to_ascii_lowercase();
    HASSAS_ADLAR.iter().any(|hassas| kucuk.ends_with(hassas))
}

/// Sir gibi gorunen degerleri maskeler.
///
/// Desenler `scripts/scan-secrets.sh` ile ayni aileden. GENEL "32+ karakterlik
/// her sey" kurali BILINCLI OLARAK YOK: git SHA'lari ve UUID'ler o kurala
/// takilir ve cikti okunamaz hale gelirdi. Hedefli on-ek + anahtar=deger
/// yaklasimi, gurultuyu sirlarin uzerine yigmadan kapatiyor.
///
/// Iki gecis: once bosluk ve satir sonunu asan sirlar (`maskele_bosluklu`),
/// sonra kelime kelime on-ek ve `anahtar=deger` (`maskele_kelimeler`).
pub fn maskele(s: &str) -> String {
    maskele_kelimeler(&maskele_bosluklu(s))
}

/// Kelime sinirini asan sirlari maskeler: PEM ozel anahtar bloklari ve hassas
/// adli atamalar (`API_KEY = x`, `Authorization: Bearer x`, `"token": "x"`).
fn maskele_bosluklu(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let rest = &s[i..];
        if let Some(uzunluk) = pem_blogu(rest) {
            out.push_str("[MASKELI:private-key]");
            i += uzunluk;
        } else if let Some((onek, deger)) = atama_degeri(rest) {
            out.push_str(&rest[..onek]);
            out.push_str("[MASKELI]");
            i += onek + deger;
        } else {
            // Ad bir butun olarak tuketilir: `x_password` icinde `password`
            // ikinci kez aranmaz.
            let adim = match ad_uzunlugu(rest) {
                0 => rest.chars().next().map_or(1, char::len_utf8),
                ad => ad,
            };
            out.push_str(&rest[..adim]);
            i += adim;
        }
    }
    out
}

/// Bastaki `[A-Za-z0-9_-]` kosusunun bayt uzunlugu (anahtar veya degisken adi).
fn ad_uzunlugu(rest: &str) -> usize {
    rest.bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        .count()
}

/// `-----BEGIN ... PRIVATE KEY-----` blogunun bayt uzunlugu; bitis satiri yoksa
/// metnin sonuna kadar (eksik blok da maskelenir).
fn pem_blogu(rest: &str) -> Option<usize> {
    if !rest.starts_with("-----BEGIN ") {
        return None;
    }
    let baslik_sonu = rest.find("-----\n").or_else(|| rest.find("-----\r"))?;
    if !rest[..baslik_sonu].contains("PRIVATE KEY") {
        return None;
    }
    let bitis = rest.find("-----END ").and_then(|bas| {
        let govde = bas + "-----END ".len();
        rest[govde..]
            .find("-----")
            .map(|son| govde + son + "-----".len())
    });
    Some(bitis.unwrap_or(rest.len()))
}

/// `anahtar = deger` atamasinin `(onek, deger)` bayt uzunluklari: `onek` anahtar,
/// ayirac ve acilis tirnagini kapsar; `deger` maskelenecek kisimdir (kapanis
/// tirnagi dahil degil).
fn atama_degeri(rest: &str) -> Option<(usize, usize)> {
    let ad = &rest[..ad_uzunlugu(rest)];
    if !hassas_ad(ad) {
        return None;
    }
    let sonrasi =
        rest[ad.len()..].trim_start_matches(|c: char| c.is_whitespace() || matches!(c, '\'' | '"'));
    let deger = sonrasi.strip_prefix(['=', ':'])?.trim_start();
    let (deger, tirnak) = match deger.chars().next() {
        Some(q @ ('\'' | '"')) => (&deger[1..], Some(q)),
        _ => (deger, None),
    };
    let uzunluk = match tirnak {
        Some(q) => tirnakli_deger(deger, q),
        None if ad.eq_ignore_ascii_case("authorization") => yetki_degeri(deger),
        None => deger
            .find(|c: char| {
                c.is_whitespace() || matches!(c, '&' | ';' | ',' | '\'' | '"' | '}' | ']' | '|')
            })
            .unwrap_or(deger.len()),
    };
    Some((rest.len() - deger.len(), uzunluk))
}

/// Kapanis tirnagina kadar uzunluk. `\` ve backtick sonraki karakteri kacirir;
/// ikiye katlanmis tirnak (`''`, PowerShell) kacis sayilir. Kapanis yoksa metnin
/// sonuna kadar (kirpik deger de maskelenir).
fn tirnakli_deger(deger: &str, tirnak: char) -> usize {
    let mut karakterler = deger.char_indices().peekable();
    while let Some((i, c)) = karakterler.next() {
        if matches!(c, '\\' | '`') {
            karakterler.next();
        } else if c == tirnak
            && karakterler
                .next_if(|&(_, sonraki)| sonraki == tirnak)
                .is_none()
        {
            return i;
        }
    }
    deger.len()
}

/// `Authorization: <sema> <belirtec>`: sema (Bearer, Basic...) atlanir, belirtec
/// bosluk veya ayiraca kadar alinir; ikisi birlikte maskelenir.
fn yetki_degeri(deger: &str) -> usize {
    let sema_sonu = deger.find(char::is_whitespace).unwrap_or(deger.len());
    let belirtec = deger[sema_sonu..].trim_start();
    let belirtec_uzunlugu = belirtec
        .find(|c: char| c.is_whitespace() || matches!(c, '\'' | '"' | ';' | '}' | ','))
        .unwrap_or(belirtec.len());
    deger.len() - belirtec.len() + belirtec_uzunlugu
}

/// Kelime kelime maskeleme: bilinen sir on-ekleri ve `anahtar=deger`.
fn maskele_kelimeler(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for parca in s.split_inclusive(|c: char| c.is_whitespace() || c == '"' || c == '\'') {
        let (govde, kuyruk) = parca.split_at(
            parca
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
                .unwrap_or(parca.len()),
        );
        out.push_str(&maskele_kelime(govde));
        out.push_str(kuyruk);
    }
    out
}

/// Tek bir "kelime"yi degerlendirir. Ayri fonksiyon: testten dogrudan
/// cagrilabiliyor ve bolme mantigi ile karar mantigi karismiyor.
fn maskele_kelime(k: &str) -> String {
    const ONEKLER: &[&str] = &[
        "sk-",
        "sk_",
        "ghp_",
        "gho_",
        "github_pat_",
        "AKIA",
        "ASIA",
        "AIza",
        "xoxb-",
        "xoxp-",
        "xox",
        "eyJ",
        "glpat-",
        "dckr_pat_",
        "hf_",
        "SG.",
        "Bearer",
    ];
    if let Some(onek) = ONEKLER.iter().find(|o| {
        k.match_indices(**o).any(|(i, _)| {
            // Bastaki desenlerin mevcut davranisini koru. Gomulu eslesmede
            // token govdesi ara: task-list/risk-management sir degildir.
            (i == 0 && k.len() >= 8)
                || k[i + o.len()..]
                    .bytes()
                    .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
                    .count()
                    >= 12
        })
    }) {
        return format!("[MASKELI:{onek}]");
    }
    // anahtar=deger / anahtar:deger bicimi
    if let Some(i) = k.find(['=', ':']) {
        let (ad, deger) = k.split_at(i);
        let deger = &deger[1..];
        if !deger.is_empty() && hassas_ad(ad) {
            return format!("{ad}=[MASKELI]");
        }
    }
    if k.contains("PRIVATE KEY") {
        return "[MASKELI:private-key]".to_string();
    }
    k.to_string()
}

/// Bir oturumun meta verisi. Icerik TASIMAZ.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OturumMeta {
    pub kaynak: &'static str,
    pub id: String,
    pub baslik: Option<String>,
    pub proje: Option<String>,
    pub dal: Option<String>,
    /// Son yazma zamani, "AA-GG SS:DD" — **UTC**. Adinda `utc` var cunku bu
    /// makine UTC+3'te ve alan adi "son" oldugunda 3 saat yanlis okunuyordu.
    pub son_utc: String,
    /// Saat diliminden bagimsiz bagil sure ("12 dk once"). Kullaniciya
    /// soylenecek olan BUDUR.
    pub once: String,
    pub boyut_kb: u64,
    pub canli: bool,
    pub etkinlik: serde_json::Value,
    /// Oturum dosyasi. `listele` tarama sirasinda bilir; pencere okumasi ve icerik
    /// modu AYNI dosyayi kullanir (kimlikten yeniden arama yok: her arama butun
    /// oturum agacini tariyordu). Yanita GIRMEZ, yalniz dosyaya gitmek icindir.
    pub yol: PathBuf,
}

/// Claude Code'un proje dizin adini okunabilir yola cevirir.
///
/// Format bir kodlama: `C--Users-alice` → `C:/Users/alice`,
/// `--wsl-localhost-ubuntu-home-alice-workspace-...` → WSL yolu.
/// Kodlama kayipli (`-` hem ayirac hem ad karakteri olabilir), o yuzden bu
/// fonksiyon KESIN yol degil OKUNABILIR ETIKET uretir — cagiran taraf bunu
/// dosya acmak icin KULLANMAZ.
pub fn proje_etiketi(dizin_adi: &str) -> String {
    if let Some(kalan) = dizin_adi.strip_prefix("--wsl-localhost-") {
        // Cift slash BILINCLI: gercek yol `\\wsl.localhost\ubuntu\home\...`
        // yani bir UNC payi. `wsl:/ubuntu/...` yazmak onu yerel bir dizinmis
        // gibi gosterirdi.
        return format!("wsl://{}", kalan.replace('-', "/"));
    }
    if let Some(kalan) = dizin_adi.strip_prefix("ssh-") {
        return format!("ssh:{kalan}");
    }
    // "C--Users-x" → surucu harfi + yol
    if let Some((surucu, kalan)) = dizin_adi.split_once("--") {
        if surucu.len() == 1 {
            return format!(
                "{}:/{}",
                surucu.to_ascii_uppercase(),
                kalan.replace('-', "/")
            );
        }
    }
    dizin_adi.to_string()
}

/// Yolun okunmasi yasak mi?
fn yasakli(yol: &Path) -> bool {
    let s = yol.to_string_lossy().to_ascii_lowercase();
    YASAK_PARCALAR.iter().any(|p| s.contains(p))
}

/// Dosyanin ilk `PENCERE_BYTES` baytini metin olarak okur.
///
/// UTF-8 sinirinda kesme olasiligi var; `from_utf8_lossy` kullaniyoruz cunku
/// amac tam sadakat degil, alan cikarmak. Yasakli yolda bos doner.
fn pencere_oku(yol: &Path) -> String {
    if yasakli(yol) || sembolik_yol(yol) {
        return String::new();
    }
    let Ok(dosya) = fs::File::open(yol) else {
        return String::new();
    };
    let mut bytes = Vec::new();
    if dosya
        .take(PENCERE_BYTES as u64)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return String::new();
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Sondan sinirli okuma; pencerenin basindaki yarim JSON kaydi atilir.
/// Yazilmakta olan son eksik kayit JSON ayrismadigi icin kullanilmaz.
fn son_pencere_oku(yol: &Path) -> String {
    if yasakli(yol) || sembolik_yol(yol) {
        return String::new();
    }
    let Ok(mut dosya) = fs::File::open(yol) else {
        return String::new();
    };
    let Ok(meta) = dosya.metadata() else {
        return String::new();
    };
    let bas = meta.len().saturating_sub(SON_PENCERE_BYTES as u64);
    // Onceki bayt, pencere tam satir sinirinda basliyorsa o satiri korur.
    let mut onceki = [b'\n'];
    if bas > 0
        && (dosya.seek(SeekFrom::Start(bas - 1)).is_err() || dosya.read_exact(&mut onceki).is_err())
    {
        return String::new();
    }
    let mut bytes = Vec::new();
    if dosya
        .take(SON_PENCERE_BYTES as u64)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return String::new();
    }
    let bas = if onceki[0] == b'\n' {
        0
    } else {
        bytes
            .iter()
            .position(|b| *b == b'\n')
            .map_or(bytes.len(), |i| i + 1)
    };
    String::from_utf8_lossy(&bytes[bas..]).into_owned()
}

/// Transkriptlerin UTC ISO-8601 damgasi; bilinmeyen bicimde yas uydurulmaz.
fn kayit_zamani(s: &str) -> Option<SystemTime> {
    let s = s.strip_suffix('Z').or_else(|| s.strip_suffix("+00:00"))?;
    let (tarih, saat) = s.split_once('T')?;
    let mut t = tarih.split('-').map(str::parse::<i64>);
    let (yil, ay, gun) = (t.next()?.ok()?, t.next()?.ok()?, t.next()?.ok()?);
    if t.next().is_some()
        || !(1970..=9999).contains(&yil)
        || !(1..=12).contains(&ay)
        || !(1..=31).contains(&gun)
    {
        return None;
    }
    let (saat, kesir) = saat
        .split_once('.')
        .map_or((saat, None), |(a, b)| (a, Some(b)));
    if kesir.is_some_and(|k| k.is_empty() || !k.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    let mut h = saat.split(':').map(str::parse::<u64>);
    let (sa, dk, sn) = (h.next()?.ok()?, h.next()?.ok()?, h.next()?.ok()?);
    if h.next().is_some() || sa > 23 || dk > 59 || sn > 59 {
        return None;
    }
    // civil_from_days'in tersi; sivil_tarih ile geri kontrol gecersiz gunleri reddeder.
    let y = yil - i64::from(ay <= 2);
    let era = y / 400;
    let yoe = y - era * 400;
    let mp = ay + if ay > 2 { -3 } else { 9 };
    let days =
        era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + (153 * mp + 2) / 5 + gun - 1 - 719468;
    if sivil_tarih(days) != (yil, ay as u32, gun as u32) {
        return None;
    }
    let nanos = kesir
        .map(|k| format!("{k:0<9}")[..9].parse::<u32>().ok())
        .unwrap_or(Some(0))?;
    SystemTime::UNIX_EPOCH.checked_add(Duration::new(
        days as u64 * 86400 + sa * 3600 + dk * 60 + sn,
        nanos,
    ))
}

/// Yalniz ASCII ayiraclari tanir; kodlama/Unicode normalizasyonu YOK.
/// UNC, device, drive-relative ve herhangi bir ust dizin gecisi reddedilir.
fn yol_parcalari(s: &str) -> Option<(&str, Vec<&str>)> {
    let (kok, kalan) = if s.starts_with("//") {
        return None;
    } else if s.as_bytes().get(1) == Some(&b':') {
        if !s.as_bytes()[0].is_ascii_alphabetic() || s.as_bytes().get(2) != Some(&b'/') {
            return None;
        }
        (&s[..2], &s[3..])
    } else if let Some(kalan) = s.strip_prefix('/') {
        ("/", kalan)
    } else {
        ("", s)
    };
    let mut parcalar = Vec::new();
    for p in kalan.split('/').filter(|p| !p.is_empty() && *p != ".") {
        if p == ".." || p.contains(':') || p.starts_with('~') {
            return None;
        }
        parcalar.push(p);
    }
    Some((kok, parcalar))
}

fn izinli_alan(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Icerik okunmaz. Mevcut prefix'lerde symlink ve Windows junction reddedilir.
/// Silinmis/tasinmis tarihi dosyalar icin eksik prefix leksik kontrolde kalir.
fn sembolik_yol(yol: &Path) -> bool {
    if !yol.is_absolute() {
        return false; // Baska platformun transkripti; yerel relative IO yapma.
    }
    let mut prefix = PathBuf::new();
    for parca in yol.components() {
        prefix.push(parca);
        // Windows'ta yalniz C: process cwd'sidir; C:/ olusmadan sorgulama.
        if !prefix.is_absolute() {
            continue;
        }
        match fs::symlink_metadata(&prefix) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return true;
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return true;
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => return true,
        }
    }
    false
}

/// Sadece cwd'ye gore ilk dizin ve son uzanti aciklanir; ad/alt dizin tasinmaz.
fn etkinlik_alani(yol: &str, cwd: Option<&str>, kullanici: Option<&str>) -> (String, String) {
    let dis = || ("[dis]".into(), String::new());
    let yol = yol.replace('\\', "/");
    let cwd = cwd.unwrap_or("").replace('\\', "/");
    let Some((taban_kok, taban)) = yol_parcalari(&cwd) else {
        return dis();
    };
    if taban_kok.is_empty() || yol.is_empty() || yol.ends_with('/') {
        return dis();
    }
    let Some((kok, hedef)) = yol_parcalari(&yol) else {
        return dis();
    };
    let goreli = if kok.is_empty() {
        hedef.as_slice()
    } else {
        if !kok.eq_ignore_ascii_case(taban_kok)
            || hedef.len() <= taban.len()
            || !hedef.iter().zip(&taban).all(|(a, b)| {
                if kok == "/" {
                    a == b
                } else {
                    a.eq_ignore_ascii_case(b)
                }
            })
        {
            return dis();
        }
        &hedef[taban.len()..]
    };
    let Some(dosya) = goreli.last() else {
        return dis();
    };
    let tam = if kok.is_empty() {
        format!("{cwd}/{yol}")
    } else {
        yol.clone()
    };
    if sembolik_yol(Path::new(&tam)) {
        return dis();
    }
    let ilk = if goreli.len() == 1 { "." } else { goreli[0] };
    let kullanici_dizini = kullanici.is_some_and(|k| ilk.eq_ignore_ascii_case(k))
        || taban.windows(2).any(|p| {
            (p[0].eq_ignore_ascii_case("users") || p[0].eq_ignore_ascii_case("home"))
                && ilk.eq_ignore_ascii_case(p[1])
        });
    let dizin = if izinli_alan(ilk, 32)
        && !crate::system_tools::privacy_denied(ilk)
        && !yasakli(Path::new(ilk))
        && !kullanici_dizini
    {
        ilk.to_ascii_lowercase()
    } else {
        "[gizli]".into()
    };
    let uzanti = dosya
        .rfind('.')
        .filter(|i| *i > 0)
        .map(|i| &dosya[i..])
        .unwrap_or("");
    let uzanti = if uzanti.len() > 1 && izinli_alan(uzanti, 8) {
        uzanti.to_ascii_lowercase()
    } else {
        String::new()
    };
    (dizin, uzanti)
}

/// Cikti etiketleri yalniz sabitlerden gelir; bilinmeyen adin hicbir parcasi
/// tasinmaz. Namespace destegi yalniz Codex'in bilinen `functions.` onekidir.
fn etkinlik_araci(ad: &str, kaynak: &str) -> &'static str {
    let ad = if kaynak == "codex" {
        ad.strip_prefix("functions.").unwrap_or(ad)
    } else {
        ad
    };
    let izinli: &[&str] = match kaynak {
        "claude" => &[
            "Read",
            "Write",
            "Edit",
            "MultiEdit",
            "NotebookEdit",
            "Bash",
            "Glob",
            "Grep",
            "WebFetch",
            "WebSearch",
            "Task",
            "TodoWrite",
        ],
        "codex" => &[
            "exec_command",
            "apply_patch",
            "shell",
            "update_plan",
            "view_image",
            "web_search",
            "write_stdin",
        ],
        _ => &[],
    };
    izinli
        .iter()
        .copied()
        .find(|izin| *izin == ad)
        .unwrap_or(if ad.starts_with("mcp__") {
            "mcp"
        } else {
            "diger"
        })
}

/// Patch'in TAMAMI gramerden gecmeden hicbir baslik disa verilmez.
/// Dosya icerigi satirlari ancak +, - veya bosluk ile baslayabilir.
fn patch_yollari(patch: &str) -> Option<Vec<&str>> {
    let satirlar: Vec<_> = patch.lines().collect();
    if satirlar.first() != Some(&"*** Begin Patch") || satirlar.last() != Some(&"*** End Patch") {
        return None;
    }
    let mut yollar = Vec::new();
    let mut i = 1;
    let son = satirlar.len() - 1;
    while i < son {
        let baslik = satirlar[i];
        let (yol, tur) = if let Some(p) = baslik.strip_prefix("*** Update File: ") {
            (p, "update")
        } else if let Some(p) = baslik.strip_prefix("*** Add File: ") {
            (p, "add")
        } else if let Some(p) = baslik.strip_prefix("*** Delete File: ") {
            (p, "delete")
        } else {
            return None;
        };
        if yol.is_empty() {
            return None;
        }
        yollar.push(yol);
        i += 1;
        if tur == "delete" {
            continue;
        }
        if tur == "update" && i < son {
            if let Some(p) = satirlar[i].strip_prefix("*** Move to: ") {
                if p.is_empty() {
                    return None;
                }
                yollar.push(p);
                i += 1;
            }
        }
        let mut icerik = false;
        let mut hunk_bos = false;
        while i < son && !satirlar[i].starts_with("*** ") {
            let s = satirlar[i];
            if tur == "update" && (s == "@@" || s.starts_with("@@ ")) {
                if hunk_bos {
                    return None;
                }
                hunk_bos = true;
            } else if s.starts_with('+')
                || (tur == "update" && (s.starts_with('-') || s.starts_with(' ')))
            {
                icerik = true;
                hunk_bos = false;
            } else {
                return None;
            }
            i += 1;
        }
        if tur == "update" {
            if !icerik || hunk_bos {
                return None;
            }
            if i < son && satirlar[i] == "*** End of File" {
                i += 1;
            }
        }
    }
    Some(yollar)
}

fn etkinlik_cagrilari<'a>(v: &'a serde_json::Value, kaynak: &str) -> Vec<&'a serde_json::Value> {
    if kaynak == "claude" && v["type"] == "assistant" {
        v["message"]["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["type"] == "tool_use")
            .collect()
    } else if kaynak == "codex"
        && v["type"] == "response_item"
        && matches!(
            v["payload"]["type"].as_str(),
            Some("function_call" | "custom_tool_call")
        )
    {
        vec![&v["payload"]]
    } else {
        Vec::new()
    }
}

fn hata_yok(v: &serde_json::Value) -> bool {
    v.get("is_error").is_none_or(|x| x == false)
        && v.get("error").is_none_or(serde_json::Value::is_null)
}

/// Bilinmeyen sonuc basari degildir. Kod varsa tam sayi sifir olmali;
/// duz apply_patch ciktisinda tum metin bilinen basari gramerine uymali.
fn codex_basarili(v: &serde_json::Value) -> bool {
    if !hata_yok(v) {
        return false;
    }
    let Some(output) = v.get("output") else {
        return false;
    };
    let parsed = output
        .as_str()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
    let output = parsed.as_ref().unwrap_or(output);
    if !hata_yok(output) {
        return false;
    }
    let kodlar: Vec<_> = [
        v.get("exit_code"),
        v["metadata"].get("exit_code"),
        output.get("exit_code"),
        output["metadata"].get("exit_code"),
    ]
    .into_iter()
    .flatten()
    .collect();
    if !kodlar.is_empty() {
        return kodlar.iter().all(|k| k.as_i64() == Some(0));
    }
    let Some(metin) = output.as_str().or_else(|| output["output"].as_str()) else {
        return false;
    };
    let mut satirlar = metin.lines();
    satirlar.next() == Some("Success. Updated the following files:") && {
        let kalan: Vec<_> = satirlar.collect();
        !kalan.is_empty()
            && kalan.iter().all(|s| {
                ["A ", "M ", "D "]
                    .iter()
                    .any(|p| s.strip_prefix(p).is_some_and(|y| !y.is_empty()))
            })
    }
}

/// Son 50 arac; basarisi eslesmis yollar icin en son gorulen 6 alan.
/// Adet, pencerenin tamamindaki (dizin, uzanti) gozlemlerinin sayisidir.
fn etkinlik_ozeti(
    pencere: &str,
    kaynak: &str,
    cwd: Option<&str>,
    simdi: SystemTime,
) -> serde_json::Value {
    let kayitlar: Vec<serde_json::Value> = pencere
        .lines()
        .filter_map(|s| serde_json::from_str(s).ok())
        .collect();
    let id_alani = if kaynak == "claude" { "id" } else { "call_id" };
    let mut cagri_adetleri = HashMap::new();
    let mut sonuclar = HashMap::new();
    for (sira, v) in kayitlar.iter().enumerate() {
        for cagri in etkinlik_cagrilari(v, kaynak) {
            if let Some(id) = cagri[id_alani].as_str().filter(|s| !s.is_empty()) {
                *cagri_adetleri.entry(id).or_insert(0usize) += 1;
            }
        }
        let sonuc_listesi: Vec<_> = if kaynak == "claude" && v["type"] == "user" {
            v["message"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|b| b["type"] == "tool_result")
                .filter_map(|b| {
                    b["tool_use_id"]
                        .as_str()
                        .map(|id| (id, "tool_result", hata_yok(b)))
                })
                .collect()
        } else if kaynak == "codex" && v["type"] == "response_item" {
            let p = &v["payload"];
            match (p["type"].as_str(), p["call_id"].as_str()) {
                (Some(tur @ ("function_call_output" | "custom_tool_call_output")), Some(id)) => {
                    vec![(id, tur, codex_basarili(p))]
                }
                _ => Vec::new(),
            }
        } else {
            Vec::new()
        };
        for (id, tur, basarili) in sonuc_listesi {
            // Yinelenen kimlik, once basari sonra hata dahil, belirsizdir.
            sonuclar
                .entry(id)
                .and_modify(|s: &mut (usize, &str, bool)| s.2 = false)
                .or_insert((sira, tur, basarili));
        }
    }
    let mut araclar = VecDeque::new();
    let mut alanlar: Vec<((String, String), u64)> = Vec::new();
    let mut adetler = HashMap::new();
    let kullanici = std::env::var("USERNAME").ok();
    let mut son = None;
    let mut yol_ekle = |yol: &str| {
        let alan = etkinlik_alani(yol, cwd, kullanici.as_deref());
        let adet = adetler.entry(alan.clone()).or_insert(0u64);
        *adet += 1;
        alanlar.retain(|(p, _)| *p != alan);
        alanlar.push((alan, *adet));
        if alanlar.len() > 6 {
            alanlar.remove(0);
        }
    };
    for (sira, v) in kayitlar.iter().enumerate() {
        // Son kaydin zamani yoksa onceki kaydin yasini ona mal etme.
        son = v["timestamp"].as_str().and_then(kayit_zamani);
        let cagrilar = etkinlik_cagrilari(v, kaynak);
        for cagri in cagrilar {
            let Some(ad) = cagri["name"].as_str().filter(|s| !s.is_empty()) else {
                continue;
            };
            let etiket = etkinlik_araci(ad, kaynak);
            araclar.push_back(etiket);
            if araclar.len() > 50 {
                araclar.pop_front();
            }
            let sonuc_turu = match cagri["type"].as_str() {
                Some("tool_use") => "tool_result",
                Some("function_call") => "function_call_output",
                Some("custom_tool_call") => "custom_tool_call_output",
                _ => continue,
            };
            let basarili = cagri[id_alani].as_str().is_some_and(|id| {
                cagri_adetleri.get(id) == Some(&1)
                    && sonuclar.get(id).is_some_and(|(sonuc_sirasi, tur, basari)| {
                        *basari && *sonuc_sirasi > sira && *tur == sonuc_turu
                    })
            });
            if !basarili {
                continue;
            }
            if kaynak == "claude"
                && matches!(
                    etiket,
                    "Edit" | "Write" | "Read" | "MultiEdit" | "NotebookEdit"
                )
            {
                if let Some(yol) = cagri["input"]["file_path"].as_str() {
                    yol_ekle(yol);
                }
            } else if kaynak == "codex" && etiket == "apply_patch" {
                let args = cagri["arguments"]
                    .as_str()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
                let patch = cagri["input"]
                    .as_str()
                    .or_else(|| args.as_ref().unwrap_or(&cagri["arguments"])["patch"].as_str());
                if let Some(yollar) = patch.and_then(patch_yollari) {
                    for yol in yollar {
                        yol_ekle(yol);
                    }
                }
            }
        }
    }
    let mut sayilar = serde_json::Map::new();
    for ad in &araclar {
        let sayi = sayilar.entry(*ad).or_insert(serde_json::json!(0));
        *sayi = serde_json::json!(sayi.as_u64().unwrap_or(0) + 1);
    }
    let yas = son.map(|s| simdi.duration_since(s).unwrap_or(Duration::ZERO).as_secs());
    let mut o = serde_json::json!({
        "son_araclar":araclar.iter().skip(araclar.len().saturating_sub(12)).collect::<Vec<_>>(),
        "arac_sayilari":sayilar,
        "alanlar":alanlar.into_iter().map(|((dizin, uzanti), adet)|
            serde_json::json!({"dizin":dizin,"uzanti":uzanti,"adet":adet})).collect::<Vec<_>>(),
        "son_hareket_sn":yas, "mesgul":yas.is_some_and(|s| s < 90)
    });
    // Tam nesne yalniz BIR kez olculur. Silinen elemanin JSON boyutu ve
    // virgulu dusulur; kalanlar tek geciste tutulur, buyuk kopyalar uretilmez.
    let mut boyut = json_boyutu(&o);
    if boyut > ETKINLIK_MAX_BYTES {
        boyut += ",\"kirpildi\":true".len();
        o["kirpildi"] = serde_json::json!(true);
        for alan in ["alanlar", "son_araclar"] {
            let dizi = o[alan].as_array_mut().unwrap();
            let mut adet = dizi.len();
            dizi.retain(|v| {
                if boyut <= ETKINLIK_MAX_BYTES {
                    return true;
                }
                boyut -= json_boyutu(v) + usize::from(adet > 1);
                adet -= 1;
                false
            });
        }
        let sayilar = o["arac_sayilari"].as_object_mut().unwrap();
        for ad in araclar {
            if boyut <= ETKINLIK_MAX_BYTES {
                break;
            }
            if let Some(sayi) = sayilar.remove(ad) {
                boyut -= json_boyutu(&serde_json::json!(ad))
                    + 1
                    + json_boyutu(&sayi)
                    + usize::from(!sayilar.is_empty());
            }
        }
    }
    o
}

/// JSON escaping dahil uzunlugu hesaplar, ara String/Vec olusturmaz.
fn json_boyutu(v: &serde_json::Value) -> usize {
    struct Sayac(usize);
    impl std::io::Write for Sayac {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0 += buf.len();
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut sayac = Sayac(0);
    serde_json::to_writer(&mut sayac, v).expect("Value JSON ve bellek sayaci yazilabilir");
    #[cfg(test)]
    ETKINLIK_OLCULEN_BYTES.with(|n| n.set(n.get() + sayac.0));
    sayac.0
}

#[cfg(test)]
thread_local! {
    static ETKINLIK_OLCULEN_BYTES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// mtime → ("AA-GG SS:DD", canli mi).
/// mtime → (UTC damgasi, "ne kadar once", canli mi).
///
/// NEDEN IKI ZAMAN ALANI (canli sondada bulundu, 2026-08-17): tek basina
/// mutlak damga SESSIZ YANLIS bilgi uretiyordu. `std` saat dilimi bilmiyor,
/// yani damga UTC; kullanici UTC+3'te. "En son ne zaman?" sorusuna 3 saat
/// yanlis cevap veriliyordu ve hicbir belirti yoktu — yanlis saat de bir
/// saattir, o yuzden "yaklasik dogru" kabul edilemez.
///
/// Cozum iki katmanli: (1) mutlak alan artik ADIYLA UTC oldugunu soyluyor,
/// (2) BAGIL sure eklendi. Bagil sure saat diliminden bagimsiz olarak dogru ve
/// "ne zaman calisiyordum" sorusunun asil cevabi zaten o.
fn zaman(meta: &fs::Metadata, simdi: SystemTime) -> (String, String, bool) {
    let Ok(m) = meta.modified() else {
        return ("?".to_string(), "?".to_string(), false);
    };
    let gecen = simdi.duration_since(m).unwrap_or(Duration::ZERO);
    let canli = gecen < CANLI_ESIK;
    let secs = m
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (epoch_etiketi(secs), bagil_sure(gecen.as_secs()), canli)
}

/// Saniye → "az once" / "12 dk once" / "3 sa once" / "2 gun once".
///
/// Saat dilimi gerektirmez: iki `SystemTime` arasindaki FARK mutlaktir.
pub fn bagil_sure(sn: u64) -> String {
    match sn {
        0..=59 => "az once".to_string(),
        60..=3599 => format!("{} dk once", sn / 60),
        3600..=86_399 => format!("{} sa once", sn / 3600),
        _ => format!("{} gun once", sn / 86_400),
    }
}

/// Epoch saniyesi → "AA-GG SS:DD" (UTC).
///
/// Neden elle: `chrono` bu crate'te yok ve tek bir etiket icin bagimlilik
/// eklemek bedeli hak etmiyor. Sivil takvim donusumu Howard Hinnant'in
/// `civil_from_days` algoritmasi (kamu malı) ile yapiliyor.
pub fn epoch_etiketi(secs: u64) -> String {
    let gunler = (secs / 86_400) as i64;
    let gun_ici = secs % 86_400;
    let (_, ay, gun) = sivil_tarih(gunler);
    format!(
        "{:02}-{:02} {:02}:{:02}",
        ay,
        gun,
        gun_ici / 3600,
        (gun_ici % 3600) / 60
    )
}

/// 1970-01-01'den itibaren gun sayisi → (yil, ay, gun).

/// Claude Code kayit penceresinden alan cikarir.
///
/// Tam JSON ayristirmasi yapmiyoruz: pencere ortadan kesilmis olabilir ve
/// tek bir bozuk satir butun cikarimi dusurmemeli. Satir satir denenir,
/// ayristirilamayan satir sessizce atlanir (veri yoklugu, hata degil).
fn claude_alanlar(pencere: &str) -> (Option<String>, Option<String>, Option<String>) {
    let mut baslik = None;
    let mut cwd = None;
    let mut dal = None;
    for satir in pencere.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(satir) else {
            continue;
        };
        if baslik.is_none() {
            for alan in ["customTitle", "aiTitle"] {
                if let Some(t) = v[alan].as_str() {
                    if !t.trim().is_empty() {
                        baslik = Some(kirp(t, 120));
                        break;
                    }
                }
            }
        }
        if cwd.is_none() {
            if let Some(c) = v["cwd"].as_str() {
                cwd = Some(c.to_string());
            }
        }
        if dal.is_none() {
            if let Some(b) = v["gitBranch"].as_str() {
                // "HEAD" BILGI TASIMAZ: git deposu olmayan bir cwd'de veya
                // detached durumda bu deger geliyor ve canli sondada butun
                // oturumlar "dal: HEAD" gorunuyordu. Bos birakmak, anlamsiz bir
                // dal adi uydurmaktan iyidir.
                let b = b.trim();
                if !b.is_empty() && b != "HEAD" {
                    dal = Some(b.to_string());
                }
            }
        }
    }
    (baslik, cwd, dal)
}

/// Codex `session_meta` satirindan alan cikarir. Ilk satirda bulunur.
fn codex_alanlar(pencere: &str) -> (Option<String>, Option<String>) {
    for satir in pencere.lines().take(20) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(satir) else {
            continue;
        };
        if v["type"].as_str() != Some("session_meta") {
            continue;
        }
        let p = &v["payload"];
        let cwd = p["cwd"].as_str().map(|s| s.to_string());
        let baslik = p["thread_name"]
            .as_str()
            .or_else(|| p["name"].as_str())
            .map(|s| kirp(s, 120));
        return (baslik, cwd);
    }
    (None, None)
}

/// UTF-8 sinirini bozmadan kirpar. Donen metin ASLA `max` bayti gecmez.
///
/// ILK YAZIMDA HATALIYDI ve butce testi yakaladi: `format!("{}...", &s[..max])`
/// her parcayi max+3 bayt yapiyordu, yani `ICERIK_MAX_BYTES` parca sayisi kadar
/// 3 bayt asilabiliyordu. Kucuk gorunen bir tasma, ama bu modulun tek isi
/// butceyi tutmak — "yaklasik tutar" bir butce degildir.
pub(crate) fn kirp(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    // Uc nokta sigmiyorsa hic eklenmez; yoksa "..." tek basina max'i asardi.
    let hedef = if max <= 3 { max } else { max - 3 };
    let mut kes = hedef;
    while kes > 0 && !s.is_char_boundary(kes) {
        kes -= 1;
    }
    if max <= 3 {
        return s[..kes].to_string();
    }
    format!("{}...", &s[..kes])
}

/// Ev dizini. `USERPROFILE` yoksa `HOME` denenir (WSL/CI).
fn ev() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// `dizin` altindaki girdiler; okunamayan dizin bos sayilir.
fn girdiler(dizin: &Path) -> impl Iterator<Item = fs::DirEntry> {
    fs::read_dir(dizin).into_iter().flatten().flatten()
}

/// `dizin` altindaki GERCEK alt dizinler. Symlink ve Windows junction kok disina
/// cikabilir (`.claude/projects/x` -> baska bir dizin): `read_dir` hedefi izler
/// ve dis JSONL modele tasinirdi. `DirEntry::file_type` baglantiyi izlemez ve ek
/// sistem cagrisi gerektirmez (5000+ oturum dosyasinda dosya basina
/// `canonicalize` pahali); baglanti `is_symlink` olur, `is_dir`/`is_file` degil.
fn gercek_alt_dizinler(dizin: &Path) -> Vec<PathBuf> {
    girdiler(dizin)
        .filter(|g| g.file_type().is_ok_and(|tur| tur.is_dir()))
        .map(|g| g.path())
        .collect()
}

/// `dizin` altindaki gercek `.jsonl` dosyalari; kimlik dosyalari (`yasakli`) haric.
fn gercek_jsonl_dosyalari(dizin: &Path) -> Vec<PathBuf> {
    girdiler(dizin)
        .filter(|g| g.file_type().is_ok_and(|tur| tur.is_file()))
        .map(|g| g.path())
        .filter(|yol| yol.extension().and_then(|e| e.to_str()) == Some("jsonl") && !yasakli(yol))
        .collect()
}

/// Claude Code oturum dosyalarini toplar: `~/.claude/projects/<proje>/<id>.jsonl`
fn claude_dosyalari(kok: &Path) -> Vec<(PathBuf, String)> {
    let root = kok.join(".claude").join("projects");
    if sembolik_yol(&root) {
        return Vec::new();
    }
    let mut v = Vec::new();
    for proje in gercek_alt_dizinler(&root) {
        let dizin_adi = proje.file_name().unwrap_or_default().to_string_lossy();
        let etiket = proje_etiketi(&dizin_adi);
        v.extend(
            gercek_jsonl_dosyalari(&proje)
                .into_iter()
                .map(|yol| (yol, etiket.clone())),
        );
    }
    v
}

/// Codex oturum dosyalarini toplar: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
fn codex_dosyalari(kok: &Path) -> Vec<PathBuf> {
    let taban = kok.join(".codex").join("sessions");
    if sembolik_yol(&taban) {
        return Vec::new();
    }
    // Yil/ay/gun -> uc seviye. `walkdir` bagimliligi eklemeden elle ineriz.
    let mut v = Vec::new();
    for yil in gercek_alt_dizinler(&taban) {
        for ay in gercek_alt_dizinler(&yil) {
            for gun in gercek_alt_dizinler(&ay) {
                v.extend(gercek_jsonl_dosyalari(&gun));
            }
        }
    }
    v
}

/// Meta veri listesi. `kaynak`: "claude" | "codex" | baska her sey = ikisi.
///
/// `kok` parametreli: testler gercek ev dizinine dokunmadan gecici bir agac
/// kurabiliyor. Uretimde [`ev`] verilir.
pub fn listele(kok: &Path, kaynak: &str, adet: usize, simdi: SystemTime) -> Vec<OturumMeta> {
    let adet = adet.clamp(1, ADET_MAX);
    let claude_ister = kaynak != "codex";
    let codex_ister = kaynak != "claude";
    let mut hepsi: Vec<(SystemTime, OturumMeta)> = Vec::new();

    if claude_ister {
        for (yol, proje) in claude_dosyalari(kok) {
            let Ok(meta) = fs::metadata(&yol) else {
                continue;
            };
            let (son_utc, once, canli) = zaman(&meta, simdi);
            hepsi.push((
                meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                OturumMeta {
                    kaynak: "claude",
                    id: yol
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    baslik: None,
                    proje: Some(proje),
                    dal: None,
                    son_utc,
                    once,
                    boyut_kb: meta.len() / 1024,
                    canli,
                    etkinlik: serde_json::Value::Null,
                    yol,
                },
            ));
        }
    }
    if codex_ister {
        for yol in codex_dosyalari(kok) {
            let Ok(meta) = fs::metadata(&yol) else {
                continue;
            };
            let (son_utc, once, canli) = zaman(&meta, simdi);
            hepsi.push((
                meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                OturumMeta {
                    kaynak: "codex",
                    id: yol
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    baslik: None,
                    proje: None,
                    dal: None,
                    son_utc,
                    once,
                    boyut_kb: meta.len() / 1024,
                    canli,
                    etkinlik: serde_json::Value::Null,
                    yol,
                },
            ));
        }
    }

    // En yeni once. Pencere okumasi PAHALI oldugu icin SIRALAMADAN SONRA,
    // yalniz donecek olanlara yapilir — 598 dosyanin 64 KB'ini okumak
    // gereksiz ve yavas olurdu.
    hepsi.sort_by(|a, b| b.0.cmp(&a.0));
    hepsi.truncate(adet);

    let mut cikti = Vec::with_capacity(hepsi.len());
    for (_, mut m) in hepsi {
        m.etkinlik = etkinlik_ozeti("", m.kaynak, None, simdi);
        let pencere = pencere_oku(&m.yol);
        let cwd;
        if m.kaynak == "claude" {
            let (baslik, c, dal) = claude_alanlar(&pencere);
            cwd = c;
            m.baslik = baslik;
            m.dal = dal;
            if let Some(c) = &cwd {
                m.proje = Some(c.clone());
            }
        } else {
            let (baslik, c) = codex_alanlar(&pencere);
            cwd = c;
            m.baslik = baslik;
            m.proje = cwd.clone();
        }
        m.etkinlik = etkinlik_ozeti(&son_pencere_oku(&m.yol), m.kaynak, cwd.as_deref(), simdi);
        cikti.push(m);
    }
    // En yeni oturumlar basta. En eskiden kirparak tum yanitin etkinlik
    // butcesini uygula; yer tutucularin JSON baytlari da toplamda kalir.
    let boyutlar: Vec<_> = cikti.iter().map(|m| json_boyutu(&m.etkinlik)).collect();
    let mut toplam: usize = boyutlar.iter().sum();
    let kirpilmis = serde_json::json!({"kirpildi":true});
    let kucuk = json_boyutu(&kirpilmis);
    for (m, boyut) in cikti.iter_mut().zip(boyutlar).rev() {
        if toplam <= ETKINLIK_TOPLAM_BYTES {
            break;
        }
        toplam = toplam - boyut + kucuk;
        m.etkinlik = kirpilmis.clone();
    }
    cikti
}

/// Bir oturumdan YALNIZ KULLANICI PROMPT'LARINI cikarir, maskeler, butceye
/// kirpar.
///
/// TASARIM KARARI: asistan yanitlari ve arac ciktilari HIC okunmuyor. Sebep
/// gizlilik: dosya icerikleri, komut ciktilari ve yapistirilmis sirlar
/// oralarda yasiyor. Kullanicinin kendi cumlesi "ne uzerinde calisiyordum"
/// sorusuna zaten en dogru cevabi veriyor.
pub fn kullanici_promptlari(pencere: &str, kaynak: &str) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    let mut butce = ICERIK_MAX_BYTES;
    for satir in pencere.lines() {
        if v.len() >= ICERIK_MAX_ADET || butce == 0 {
            break;
        }
        let Ok(o) = serde_json::from_str::<serde_json::Value>(satir) else {
            continue;
        };
        let metin = if kaynak == "claude" {
            if o["type"].as_str() != Some("user") || o["isMeta"].as_bool() == Some(true) {
                continue;
            }
            metin_cikar(&o["message"]["content"])
        } else {
            if o["type"].as_str() != Some("response_item") {
                continue;
            }
            let p = &o["payload"];
            if p["role"].as_str() != Some("user") {
                continue;
            }
            metin_cikar(&p["content"])
        };
        let Some(metin) = metin else { continue };
        let metin = maskele(metin.trim());
        if metin.is_empty() {
            continue;
        }
        let parca = kirp(&metin, ICERIK_MAX_PROMPT.min(butce));
        butce = butce.saturating_sub(parca.len());
        v.push(parca);
    }
    v
}

/// `content` alani ya duz string ya `[{type:"text",text:...}]` dizisi.
fn metin_cikar(c: &serde_json::Value) -> Option<String> {
    if let Some(s) = c.as_str() {
        return Some(s.to_string());
    }
    let dizi = c.as_array()?;
    let mut out = String::new();
    for p in dizi {
        if let Some(t) = p["text"].as_str() {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(t);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Arac girisi. `live.rs` dispatch'i bunu cagirir.
///
/// `icerik=false` (varsayilan) → SIFIR konusma metni.
///
/// BLOKLAYICI (dosya sistemi). Cagiran taraf `ToolBridge::call`, ve o zaten
/// `spawn_blocking` icinde kosuyor (live.rs) — bu yuzden burada AYRICA
/// `spawn_blocking` YOK. Ilk yazimda koymustum ve iki hata birden uretti:
/// senkron fonksiyonda `await`, ve gereksiz bir katman.
pub fn ajan_oturumlari(kaynak: &str, adet: Option<u64>, icerik: bool) -> serde_json::Value {
    let Some(kok) = ev() else {
        return serde_json::json!({ "hata": "ev dizini bulunamadi" });
    };
    ajan_oturumlari_kok(&kok, kaynak, adet, icerik)
}

/// Liste modundaki meta veri alanlarini tek noktadan temizler: gizlilik kara
/// listesine takilan alan `[GIZLI]` olur, kalani maskelenir, kontrol karakterleri
/// bosluga cevrilir ve alan `META_ALAN_BYTES`'a kirpilir. `cwd`, dal, baslik
/// musteri adi veya token tasiyabilir; `icerik=false` bunu degistirmez.
fn metadata_sanitize(value: &mut serde_json::Value) {
    if let Some(fields) = value.as_object_mut() {
        for field in fields.values_mut() {
            if let Some(text) = field.as_str() {
                let clean = if crate::system_tools::privacy_denied(text) {
                    "[GIZLI]".to_owned()
                } else {
                    maskele(text)
                        .chars()
                        .map(|c| if c.is_control() { ' ' } else { c })
                        .collect()
                };
                *field = serde_json::json!(kirp(&clean, META_ALAN_BYTES));
            }
        }
    }
}

fn ajan_oturumlari_kok(
    kok: &Path,
    kaynak: &str,
    adet: Option<u64>,
    icerik: bool,
) -> serde_json::Value {
    let adet = adet.unwrap_or(ADET_VARSAYILAN as u64) as usize;
    let liste = listele(&kok, kaynak, adet, SystemTime::now());
    if liste.is_empty() {
        return serde_json::json!({
            "oturumlar": [],
            "not": "Claude Code veya Codex oturum kaydi bulunamadi"
        });
    }
    let mut canli = 0;
    let mut meta_butcesi = META_TOPLAM_BYTES;
    let mut dizi = Vec::with_capacity(liste.len());
    for m in &liste {
        // Kimlik dosya adindan gelir: `chars()` ile kesilir (bayt dilimi cok baytli
        // karakterin ortasinda panik uretirdi).
        let mut o = serde_json::json!({
            "kaynak": m.kaynak,
            "id": maskele(&m.id).chars().take(8).collect::<String>(),
            "proje": m.proje,
            "dal": m.dal,
            "baslik": m.baslik,
            "once": m.once,
            "son_utc": m.son_utc,
            "boyut_kb": m.boyut_kb,
            "canli": m.canli,
        });
        metadata_sanitize(&mut o);
        // Etkinligin kendi butcesi var (`ETKINLIK_TOPLAM_BYTES`); burada yalniz meta veri sayilir.
        let boyut = json_boyutu(&o);
        if boyut > meta_butcesi {
            break;
        }
        meta_butcesi -= boyut;
        o["etkinlik"] = m.etkinlik.clone();
        if m.canli {
            canli += 1;
        }
        if icerik {
            let p = kullanici_promptlari(&pencere_oku(&m.yol), m.kaynak);
            o["son_istekler"] = serde_json::json!(p);
        }
        dizi.push(o);
    }
    serde_json::json!({
        "oturumlar": dizi,
        "canli_sayisi": canli,
        "not": if icerik {
            "icerik: yalniz KULLANICI istekleri, maskeli ve kirpilmis"
        } else {
            "yalniz meta veri; konusma icerigi istenmedi"
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asgari_aciklama_normal_kullanim() {
        let e = etkinlik_testi(
            &[
                serde_json::json!({"type":"assistant","message":{"content":[
                    {"type":"tool_use","id":"a","name":"Edit","input":{"file_path":"apps/desktop/src/a.ts"}},
                    {"type":"tool_use","id":"b","name":"Edit","input":{"file_path":"scripts/b.ps1"}}
                ]}}),
                serde_json::json!({"type":"user","message":{"content":[
                    {"type":"tool_result","tool_use_id":"b","is_error":false},
                    {"type":"tool_result","tool_use_id":"a","is_error":false}
                ]}}),
            ],
            "claude",
        );
        assert!(e.get("dosyalar").is_none());
        assert_eq!(
            e["alanlar"],
            serde_json::json!([
                {"dizin":"apps","uzanti":".ts","adet":1},
                {"dizin":"scripts","uzanti":".ps1","adet":1}
            ])
        );
    }

    #[test]
    fn asgari_aciklama_basarisiz_cagri_sizmaz() {
        let e = etkinlik_testi(
            &[
                serde_json::json!({"type":"assistant","message":{"content":[
                    {"type":"tool_use","id":"a","name":"Read","input":{"file_path":"src/PROJECT_CODENAME_BLUE.txt"}}
                ]}}),
                serde_json::json!({"type":"user","message":{"content":[
                    {"type":"tool_result","tool_use_id":"a","is_error":true}
                ]}}),
            ],
            "claude",
        );
        assert!(!e.to_string().contains("PROJECT_CODENAME_BLUE"));
        assert_eq!(e["alanlar"], serde_json::json!([]));
        assert_eq!(e["arac_sayilari"]["Read"], 1);
    }

    fn etkinlik_testi(satirlar: &[serde_json::Value], kaynak: &str) -> serde_json::Value {
        ozet_testi(satirlar, kaynak, Some("C:/repo"))
    }

    fn ozet_testi(
        satirlar: &[serde_json::Value],
        kaynak: &str,
        cwd: Option<&str>,
    ) -> serde_json::Value {
        let pencere = satirlar
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        etkinlik_ozeti(
            &pencere,
            kaynak,
            cwd,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_020),
        )
    }

    fn basarili_cagri(kaynak: &str, id: &str, yol: &str) -> Vec<serde_json::Value> {
        if kaynak == "claude" {
            vec![
                serde_json::json!({"type":"assistant","message":{"content":[
                    {"type":"tool_use","id":id,"name":"Read","input":{"file_path":yol}}
                ]}}),
                serde_json::json!({"type":"user","message":{"content":[
                    {"type":"tool_result","tool_use_id":id,"content":"ARAC_SONUC_METNI"}
                ]}}),
            ]
        } else {
            vec![
                serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call",
                    "call_id":id,"name":"apply_patch","input":format!("*** Begin Patch\n*** Add File: {yol}\n+DOSYA_ICERIGI\n*** End Patch")}}),
                serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call_output",
                    "call_id":id,"output":format!("Success. Updated the following files:\nA {yol}\n")}}),
            ]
        }
    }

    #[test]
    fn denetim_girdileri_tam_jsonda_hic_cikmaz() {
        for kaynak in ["claude", "codex"] {
            for (yol, gizli) in [
                ("src/PROJECT_CODENAME_BLUE.txt", "PROJECT_CODENAME_BLUE"),
                ("%63ustomers/Acme/nda.pdf", "%63ustomers"),
                ("src/ｃｕｓｔｏｍｅｒｓ/Acme/nda.pdf", "ｃｕｓｔｏｍｅｒｓ"),
                ("src/custоmers/Acme/nda.pdf", "custоmers"),
                ("∕home∕alice∕Deals∕Orion∕nda.pdf", "∕home∕alice"),
                ("＼Users＼alice＼Deals＼Orion＼nda.pdf", "＼Users＼"),
                ("src/alice@example.com.txt", "alice@example.com"),
                ("contacts/+90-555-123-4567.txt", "+90-555-123-4567"),
                ("notes/alice/PROJECT_ORION.md", "PROJECT_ORION"),
                (
                    concat!("tmp/prefix-", "sk", "-abc12345678.txt"),
                    concat!("sk", "-abc12345678"),
                ),
                ("tmp/aB3dE5fG7h9.txt", "aB3dE5fG7h9"),
                (
                    "src/QWxhZGRpbjpvcGVuIHNlc2FtZQ==.txt",
                    "QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
                ),
                ("src/012345abcdef.txt", "012345abcdef"),
                ("src/AbGhJk123456.txt", "AbGhJk123456"),
                ("src/CREDEN~12/index.ts", "CREDEN~12"),
                ("src/cus\u{200b}tomers/Acme/nda.pdf", "cus\u{200b}tomers"),
                (
                    concat!("tmp/prefix-", "gh", "o_0123456789abcdef.txt"),
                    concat!("gh", "o_0123456789abcdef"),
                ),
                (
                    concat!("tmp/prefix-", "AI", "za0123456789abcdef.txt"),
                    concat!("AI", "za0123456789abcdef"),
                ),
                (
                    concat!("tmp/a-", "xox", "b-0123456789abcdef.txt"),
                    concat!("xox", "b-0123456789abcdef"),
                ),
                (
                    concat!("tmp/prefix-", "ey", "JhbGciOiJIUzI1NiJ9.txt"),
                    concat!("ey", "JhbGciOiJIUzI1NiJ9"),
                ),
                ("tmp/.env.local", ".env.local"),
            ] {
                let e = ozet_testi(
                    &basarili_cagri(kaynak, "ok", yol),
                    kaynak,
                    Some("C:/Users/alice/repo"),
                );
                assert_eq!(e["alanlar"].as_array().unwrap().len(), 1, "{kaynak}: {yol}");
                let json = e.to_string();
                for yasak in [
                    yol,
                    gizli,
                    "alice",
                    "Acme",
                    "Orion",
                    "DOSYA_ICERIGI",
                    "ARAC_SONUC_METNI",
                ] {
                    assert!(!json.contains(yasak), "{kaynak}: sizinti {yasak}: {json}");
                    assert!(
                        !json.contains(&yasak.to_ascii_lowercase()),
                        "kucuk harf sizintisi: {json}"
                    );
                }
                assert!(e.get("dosyalar").is_none());
            }
        }
    }

    #[test]
    fn alanlar_ham_ascii_izin_listesi_ve_sinirlar() {
        for dizin in [
            "%63ustomers",
            "ｃｕｓｔｏｍｅｒｓ",
            "custоmers",
            "cus\u{200b}tomers",
            "a b",
            "alice@example.com",
            "+90-555-123-4567",
            "CREDEN~2",
            "abc∕def",
            "abc＼def",
            "a\0b",
        ] {
            let (d, u) = etkinlik_alani(&format!("{dizin}/file.TS"), Some("C:/repo"), None);
            assert_eq!(d, "[gizli]", "{dizin:?}");
            assert_eq!(u, ".ts");
        }
        for dizin in [
            "customers",
            "secret-stuff",
            "credential",
            "db-dumps",
            ".env",
            "auth.json",
        ] {
            assert_eq!(
                etkinlik_alani(&format!("{dizin}/file.rs"), Some("C:/repo"), None).0,
                "[gizli]"
            );
        }
        for (ad, uzanti) in [
            ("a.TS", ".ts"),
            ("a.test.RS", ".rs"),
            (".env", ""),
            ("a.", ""),
            ("README", ""),
            ("a.1234567", ".1234567"),
            ("a.12345678", ""),
            ("a.ｔｓ", ""),
            ("a.t%s", ""),
            ("a.t@s", ""),
            ("a.t+s", ""),
            ("a.t s", ""),
        ] {
            assert_eq!(
                etkinlik_alani(ad, Some("C:/repo"), None),
                (".".into(), uzanti.into())
            );
        }
        assert_eq!(
            etkinlik_alani(&format!("{}/a.rs", "a".repeat(32)), Some("C:/repo"), None).0,
            "a".repeat(32)
        );
        assert_eq!(
            etkinlik_alani(&format!("{}/a.rs", "a".repeat(33)), Some("C:/repo"), None).0,
            "[gizli]"
        );
        assert_eq!(
            etkinlik_alani("Apps_1-2.3/a.rs", Some("C:/repo"), None).0,
            "apps_1-2.3"
        );
    }

    #[test]
    fn kullanici_adi_cwd_ve_environment_kaynaklarindan_gizlenir() {
        for (cwd, kullanici, yol) in [
            ("C:/Users/alice/repo", None, "ALICE/file.ts"),
            ("/home/alice/repo", None, "alice/file.ts"),
            ("C:/repo", Some("alice"), "Alice/file.ts"),
        ] {
            assert_eq!(
                etkinlik_alani(yol, Some(cwd), kullanici),
                ("[gizli]".into(), ".ts".into())
            );
        }
        if let Ok(kullanici) = std::env::var("USERNAME") {
            if !kullanici.is_empty() {
                let e = etkinlik_testi(
                    &basarili_cagri("claude", "a", &format!("{kullanici}/a.rs")),
                    "claude",
                );
                assert_eq!(e["alanlar"][0]["dizin"], "[gizli]");
            }
        }
    }

    #[test]
    fn normal_dosya_adlari_ozeti_degistirmez() {
        for (yol, dizin, uzanti) in [
            ("docs/ReleaseNotes2026.md", "docs", ".md"),
            ("src/customerService.ts", "src", ".ts"),
            ("notes/xoxo-notes.txt", "notes", ".txt"),
            ("src/task-runner.rs", "src", ".rs"),
            ("C:\\REPO\\apps\\desktop\\src\\a.ts", "apps", ".ts"),
            ("./scripts/b.ps1", "scripts", ".ps1"),
        ] {
            let e = etkinlik_testi(&basarili_cagri("claude", "a", yol), "claude");
            assert_eq!(
                e["alanlar"],
                serde_json::json!([{"dizin":dizin,"uzanti":uzanti,"adet":1}])
            );
            assert!(!e.to_string().contains(yol));
        }
    }

    #[test]
    fn dis_yollar_tek_grupta_uzantisiz_sayilir() {
        let yollar = [
            "C:/Users/alice/Deals/nda.pdf",
            "C:/repository/file.rs",
            "D:/repo/file.rs",
            "../private/file.rs",
            "src/../file.rs",
            "src/../../private/file.rs",
            "C:private.txt",
            "//?/C:/repo/file.rs",
            "//server/share/file.rs",
            "\\\\server\\share\\file.rs",
            "/repo/file.rs",
            "~/file.rs",
            "src/a.rs:secret",
            "",
            "src/",
        ];
        let satirlar: Vec<_> = yollar
            .iter()
            .enumerate()
            .flat_map(|(i, yol)| basarili_cagri("claude", &i.to_string(), yol))
            .collect();
        let e = etkinlik_testi(&satirlar, "claude");
        assert_eq!(
            e["alanlar"],
            serde_json::json!([{"dizin":"[dis]","uzanti":"","adet":yollar.len()}])
        );
        for (cwd, yol) in [
            (Some("/repo"), "/Repo/file.rs"),
            (Some("//server/share"), "file.rs"),
            (None, "src/file.rs"),
            (Some("relative"), "src/a.rs"),
        ] {
            assert_eq!(etkinlik_alani(yol, cwd, None), ("[dis]".into(), "".into()));
        }
    }

    fn gecici_kok(ad: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "smith-{ad}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    /// Windows'ta junction (yonetici hakki gerekmez), unix'te symlink kurar.
    fn dizin_baglantisi_kur(link: &Path, hedef: &Path) {
        #[cfg(windows)]
        {
            let sonuc = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(hedef)
                .output()
                .unwrap();
            assert!(
                sonuc.status.success(),
                "junction kurulumu basarisiz: {:?}",
                sonuc.status
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(hedef, link).unwrap();
    }

    /// Yalniz baglantiyi kaldirir; hedefe dokunmaz.
    fn dizin_baglantisi_kaldir(link: &Path) {
        #[cfg(windows)]
        fs::remove_dir(link).unwrap();
        #[cfg(unix)]
        fs::remove_file(link).unwrap();
    }

    #[test]
    fn sembolik_baglanti_ve_junction_dis_sayilir() {
        let kok = gecici_kok("alan-link");
        let repo = kok.join("repo");
        let hedef = kok.join("target");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&hedef).unwrap();
        fs::write(hedef.join("a.ts"), "safe").unwrap();
        let link = repo.join("linked");
        dizin_baglantisi_kur(&link, &hedef);
        assert_eq!(
            etkinlik_alani("linked/a.ts", repo.to_str(), None),
            ("[dis]".into(), "".into())
        );
        assert_eq!(
            etkinlik_alani("a.ts", link.to_str(), None),
            ("[dis]".into(), "".into())
        );
        // Sadece link kaldirilir; hedefin korunmasi ayrica dogrulanir.
        dizin_baglantisi_kaldir(&link);
        assert!(hedef.join("a.ts").exists());
        fs::remove_dir_all(&kok).unwrap();
    }

    /// Oturum agacindaki junction/symlink kok disini gostermemeli: `read_dir`
    /// hedefi izler ve dis JSONL modele tasinirdi. Gercek dizinler listelenmeye
    /// devam eder (kontrol: "hicbir sey listelenmiyor" sahte gecis olmasin).
    #[test]
    fn oturum_kokunun_disina_cikan_baglanti_izlenmez() {
        let kok = gecici_kok("oturum-baglanti");
        let dis = kok.join("dis");
        fs::create_dir_all(dis.join("10").join("03")).unwrap();
        fs::write(dis.join("claude.jsonl"), "{}").unwrap();
        fs::write(dis.join("10").join("03").join("rollout-dis.jsonl"), "{}").unwrap();

        let projeler = kok.join(".claude").join("projects");
        fs::create_dir_all(projeler.join("gercek")).unwrap();
        fs::write(projeler.join("gercek").join("oturum.jsonl"), "{}").unwrap();
        let claude_link = projeler.join("baglanti");
        dizin_baglantisi_kur(&claude_link, &dis);

        let oturumlar = kok.join(".codex").join("sessions");
        let gun = oturumlar.join("2026").join("10").join("03");
        fs::create_dir_all(&gun).unwrap();
        fs::write(gun.join("rollout-gercek.jsonl"), "{}").unwrap();
        let codex_link = oturumlar.join("2027");
        dizin_baglantisi_kur(&codex_link, &dis);

        let claude = claude_dosyalari(&kok);
        let codex = codex_dosyalari(&kok);
        dizin_baglantisi_kaldir(&claude_link);
        dizin_baglantisi_kaldir(&codex_link);
        fs::remove_dir_all(&kok).unwrap();

        assert_eq!(claude.len(), 1, "{claude:?}");
        assert!(claude[0].0.ends_with("oturum.jsonl"), "{claude:?}");
        assert_eq!(codex.len(), 1, "{codex:?}");
        assert!(codex[0].ends_with("rollout-gercek.jsonl"), "{codex:?}");
    }

    #[test]
    fn alan_adetleri_ve_en_son_alti_grup() {
        let mut satirlar: Vec<_> = (0..8)
            .flat_map(|i| basarili_cagri("claude", &i.to_string(), &format!("dir{i}/a.ts")))
            .collect();
        satirlar.extend(basarili_cagri("claude", "again", "dir0/other/deep/b.ts"));
        let e = etkinlik_testi(&satirlar, "claude");
        let alanlar = e["alanlar"].as_array().unwrap();
        assert_eq!(alanlar.len(), 6);
        assert_eq!(alanlar[0]["dizin"], "dir3");
        assert_eq!(
            alanlar[5],
            serde_json::json!({"dizin":"dir0","uzanti":".ts","adet":2})
        );
        let satirlar: Vec<_> = ["src/a.rs", "src/b.rs", "src/deep/c.ts"]
            .iter()
            .enumerate()
            .flat_map(|(i, y)| basarili_cagri("claude", &i.to_string(), y))
            .collect();
        assert_eq!(
            etkinlik_testi(&satirlar, "claude")["alanlar"],
            serde_json::json!([
            {"dizin":"src","uzanti":".rs","adet":2},{"dizin":"src","uzanti":".ts","adet":1}])
        );
    }

    #[test]
    fn claude_sonuc_hatasi_ve_bozuk_tip_reddedilir() {
        for hata in [
            serde_json::json!(true),
            serde_json::json!("false"),
            serde_json::Value::Null,
            serde_json::json!(0),
        ] {
            let mut satirlar = basarili_cagri("claude", "id", "src/PROJECT_CODENAME_BLUE.txt");
            satirlar[1]["message"]["content"][0]["is_error"] = hata;
            let e = etkinlik_testi(&satirlar, "claude");
            assert_eq!(e["alanlar"], serde_json::json!([]));
            assert!(!e.to_string().contains("PROJECT_CODENAME_BLUE"));
            assert_eq!(e["arac_sayilari"]["Read"], 1);
        }
    }

    #[test]
    fn eslesmeyen_yinelenen_ve_ters_sirali_sonuclar_sayilmaz() {
        for kaynak in ["claude", "codex"] {
            let base = basarili_cagri(kaynak, "id", "src/PROJECT_CODENAME_BLUE.txt");
            let mut yanlis = base.clone();
            let mut eksik = base.clone();
            let mut cift = base.clone();
            cift.push(base[1].clone());
            let mut cift_cagri = base.clone();
            cift_cagri.insert(0, base[0].clone());
            if kaynak == "claude" {
                yanlis[1]["message"]["content"][0]["tool_use_id"] = serde_json::json!("other");
                eksik[0]["message"]["content"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("id");
            } else {
                yanlis[1]["payload"]["call_id"] = serde_json::json!("other");
                eksik[0]["payload"]
                    .as_object_mut()
                    .unwrap()
                    .remove("call_id");
            }
            for satirlar in [
                vec![base[0].clone()],
                vec![base[1].clone(), base[0].clone()],
                yanlis,
                eksik,
                cift,
                cift_cagri,
            ] {
                let e = etkinlik_testi(&satirlar, kaynak);
                assert_eq!(e["alanlar"], serde_json::json!([]), "{kaynak}: {e}");
                assert!(!e.to_string().contains("PROJECT_CODENAME_BLUE"));
            }
        }
    }

    #[test]
    fn codex_yalniz_acik_basari_ve_dogru_cikti_turu() {
        for (output, basarili) in [
            (
                serde_json::json!({"output":"safe","metadata":{"exit_code":0}}),
                true,
            ),
            (
                serde_json::json!({"output":"safe","metadata":{"exit_code":0}})
                    .to_string()
                    .into(),
                true,
            ),
            (serde_json::json!({"exit_code":0}), true),
            (serde_json::json!({"metadata":{"exit_code":1}}), false),
            (serde_json::json!({"exit_code":"0"}), false),
            (serde_json::json!({"exit_code":0,"error":"failed"}), false),
            (serde_json::json!({"exit_code":0,"is_error":true}), false),
            (
                serde_json::json!({"exit_code":0,"metadata":{"exit_code":1}}),
                false,
            ),
            (
                serde_json::json!(
                    "Error: failed\nSuccess. Updated the following files:\nA src/a.rs"
                ),
                false,
            ),
            (
                serde_json::json!(
                    "Success. Updated the following files:\nA src/a.rs\nError: failed"
                ),
                false,
            ),
            (
                serde_json::json!("Success. Updated the following files:"),
                false,
            ),
            (serde_json::json!("unknown"), false),
        ] {
            let mut satirlar = basarili_cagri("codex", "id", "src/a.rs");
            satirlar[1]["payload"]["output"] = output;
            let e = etkinlik_testi(&satirlar, "codex");
            assert_eq!(
                e["alanlar"].as_array().unwrap().len(),
                usize::from(basarili),
                "{e}"
            );
            assert_eq!(e["arac_sayilari"]["apply_patch"], 1);
        }
        let mut satirlar = basarili_cagri("codex", "id", "src/a.rs");
        satirlar[1]["payload"]["type"] = serde_json::json!("function_call_output");
        assert_eq!(
            etkinlik_testi(&satirlar, "codex")["alanlar"],
            serde_json::json!([])
        );
        satirlar[1]["payload"]["type"] = serde_json::json!("custom_tool_call_output");
        satirlar[1]["payload"]["is_error"] = serde_json::json!(true);
        assert_eq!(
            etkinlik_testi(&satirlar, "codex")["alanlar"],
            serde_json::json!([])
        );
    }

    #[test]
    fn patch_grameri_ve_namespace_korunur() {
        for patch in ["*** Update File: PROJECT_CODENAME_BLUE",
            "*** Begin Patch\n*** Update File: PROJECT_CODENAME_BLUE\nASISTAN_METNI\n*** End Patch",
            "*** Begin Patch\n*** Add File: PROJECT_CODENAME_BLUE\n+safe",
            "*** Begin Patch\n*** Add File: src/a.rs\n+safe\n*** End Patch\n*** Update File: PROJECT_CODENAME_BLUE",
            "*** Begin Patch\n*** Update File: PROJECT_CODENAME_BLUE\n*** End Patch"] {
            let mut satirlar = basarili_cagri("codex","id","src/a.rs");
            satirlar[0]["payload"]["input"] = serde_json::json!(patch);
            let e = etkinlik_testi(&satirlar,"codex");
            assert_eq!(e["alanlar"],serde_json::json!([]));
            assert!(!e.to_string().contains("PROJECT_CODENAME_BLUE"));
        }
        let patch = "*** Begin Patch\r\n*** Delete File: src/old.rs\r\n*** Update File: src/before.rs\r\n*** Move to: src/after.rs\r\n@@\r\n-old\r\n+new\r\n*** End of File\r\n*** Add File: src/new.rs\r\n+*** Update File: PROJECT_CODENAME_BLUE\r\n*** End Patch\r\n";
        for ad in [
            "apply_patch",
            "functions.apply_patch",
            "private.apply_patch",
        ] {
            for (tur, args) in [
                ("custom_tool_call", serde_json::Value::Null),
                ("function_call", serde_json::json!({"patch":patch})),
                (
                    "function_call",
                    serde_json::json!(serde_json::json!({"patch":patch}).to_string()),
                ),
            ] {
                let mut satirlar = basarili_cagri("codex", "id", "src/a.rs");
                satirlar[0]["payload"] = serde_json::json!({"type":tur,"call_id":"id","name":ad});
                if tur == "custom_tool_call" {
                    satirlar[0]["payload"]["input"] = serde_json::json!(patch);
                } else {
                    satirlar[0]["payload"]["arguments"] = args;
                }
                satirlar[1]["payload"]["type"] = serde_json::json!(format!("{tur}_output"));
                let e = etkinlik_testi(&satirlar, "codex");
                let beklenen = if ad == "private.apply_patch" {
                    serde_json::json!([])
                } else {
                    serde_json::json!([{"dizin":"src","uzanti":".rs","adet":4}])
                };
                assert_eq!(e["alanlar"], beklenen);
                assert!(!e.to_string().contains("PROJECT_CODENAME_BLUE"));
                assert!(!e.to_string().contains("private"));
            }
        }
    }

    #[test]
    fn arac_izin_listesi_ve_serbest_metin_gizliligi() {
        for kaynak in ["claude", "codex"] {
            let mut satirlar = Vec::new();
            for (i, ad) in ["mcp__acme-merger-blue__search", "ASISTAN_GIZLI_METNI"]
                .iter()
                .enumerate()
            {
                let mut c = basarili_cagri(kaynak, &i.to_string(), "src/PROJECT_CODENAME_BLUE.txt");
                if kaynak == "claude" {
                    c[0]["message"]["content"][0]["name"] = serde_json::json!(ad);
                } else {
                    c[0]["payload"]["name"] = serde_json::json!(ad);
                }
                satirlar.extend(c);
            }
            let e = etkinlik_testi(&satirlar, kaynak);
            assert_eq!(e["son_araclar"], serde_json::json!(["mcp", "diger"]));
            assert_eq!(e["arac_sayilari"], serde_json::json!({"mcp":1,"diger":1}));
            assert_eq!(e["alanlar"], serde_json::json!([]));
        }
        let mut satirlar = basarili_cagri("claude", "id", "src/a.rs");
        satirlar[0]["message"]["content"].as_array_mut().unwrap().extend([
            serde_json::json!({"type":"text","text":"ASISTAN_METNI"}),
            serde_json::json!({"type":"thinking","thinking":"DUSUNCE_METNI"}),
            serde_json::json!({"type":"tool_use","name":"Bash","input":{"command":"BASH_METNI","file_path":"BASH_YOLU"}}),
            serde_json::json!({"type":"tool_use","name":"TodoWrite","input":{"todos":["TODO_METNI"]}}),
        ]);
        for yasak in [
            "ASISTAN_METNI",
            "DUSUNCE_METNI",
            "BASH_METNI",
            "BASH_YOLU",
            "TODO_METNI",
            "ARAC_SONUC_METNI",
        ] {
            assert!(!etkinlik_testi(&satirlar, "claude")
                .to_string()
                .contains(yasak));
        }
    }

    #[test]
    fn dolu_alanlar_once_kirpilir_ve_yedi_yuz_bayt_asılmaz() {
        let mut satirlar: Vec<_> = (0..6)
            .flat_map(|i| {
                basarili_cagri(
                    "claude",
                    &i.to_string(),
                    &format!("{i}{}/a.1234567", "a".repeat(31)),
                )
            })
            .collect();
        for ad in [
            "NotebookEdit",
            "MultiEdit",
            "TodoWrite",
            "WebSearch",
            "WebFetch",
            "Grep",
            "Glob",
            "Bash",
            "Edit",
            "Write",
            "Read",
            "Task",
        ] {
            satirlar.push(serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":ad,"input":{}}]}}));
        }
        let e = etkinlik_testi(&satirlar, "claude");
        assert!(e.to_string().len() <= 700);
        assert_eq!(e["kirpildi"], true);
        assert!(e["alanlar"].as_array().unwrap().len() < 6);
        assert_eq!(e["son_araclar"].as_array().unwrap().len(), 12);
        assert_eq!(e["arac_sayilari"]["Read"], 7);
    }

    #[test]
    fn yirmi_oturum_iki_bin_bayt_butcesi() {
        let kok = gecici_kok("budget");
        let dizin = kok.join(".codex/sessions/2001/09/09");
        fs::create_dir_all(&dizin).unwrap();
        for i in 0..20 {
            let mut satirlar =
                vec![serde_json::json!({"type":"session_meta","payload":{"cwd":"C:/repo"}})];
            for j in 0..6 {
                satirlar.extend(basarili_cagri(
                    "codex",
                    &j.to_string(),
                    &format!("dir{j}/a.rs"),
                ));
            }
            fs::write(
                dizin.join(format!("rollout-{i:03}.jsonl")),
                satirlar
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
            .unwrap();
        }
        let cikti = ajan_oturumlari_kok(&kok, "codex", Some(20), false);
        fs::remove_dir_all(&kok).unwrap();
        let oturumlar = cikti["oturumlar"].as_array().unwrap();
        assert_eq!(oturumlar.len(), 20);
        let toplam: usize = oturumlar
            .iter()
            .map(|o| o["etkinlik"].to_string().len())
            .sum();
        assert!(toplam <= 2000, "{toplam}");
        assert_eq!(
            oturumlar[0]["etkinlik"]["alanlar"]
                .as_array()
                .unwrap()
                .len(),
            6
        );
        assert_eq!(
            oturumlar[19]["etkinlik"],
            serde_json::json!({"kirpildi":true})
        );
        println!("20 oturum toplam etkinlik: {toplam} bayt");
    }

    #[test]
    fn uzun_metadata_butce_maliyeti_sinirlidir() {
        let satirlar: Vec<_> = (0..50)
            .map(|i| {
                serde_json::json!({"type":"assistant","message":{"content":[
                    {"type":"tool_use","name":format!("{i}{}","ğ".repeat(5*1024)),"input":{}}
                ]}})
            })
            .collect();
        ETKINLIK_OLCULEN_BYTES.with(|n| n.set(0));
        for _ in 0..20 {
            let e = etkinlik_testi(&satirlar, "claude");
            assert_eq!(e["arac_sayilari"], serde_json::json!({"diger":50}));
            assert!(e.to_string().len() <= 700);
        }
        assert!(ETKINLIK_OLCULEN_BYTES.with(|n| n.get()) < 20 * 2000);
    }

    /// Varsayilan (`icerik=false`) liste de sir, musteri adi ve uzun yol tasimaz:
    /// meta veri alanlari tek sanitizer'dan gecer; alan ve toplam bayt kotasi var.
    #[test]
    fn meta_veri_alanlari_maskelenir_ve_butceyi_asmaz() {
        let kok = gecici_kok("meta-butce");
        let proje = kok.join(".claude").join("projects").join("proje");
        fs::create_dir_all(&proje).unwrap();
        let kayit = serde_json::json!({
            "type": "user",
            "cwd": format!("API_KEY = fixture-value {}", "x".repeat(8000)),
            "gitBranch": "password=fixture-value",
        })
        .to_string();
        for i in 0..20 {
            fs::write(proje.join(format!("oturum-{i}.jsonl")), &kayit).unwrap();
        }
        let sonuc = ajan_oturumlari_kok(&kok, "claude", Some(20), false);
        fs::remove_dir_all(&kok).unwrap();

        let mut toplam = 0;
        for oturum in sonuc["oturumlar"].as_array().unwrap() {
            let mut meta = oturum.clone();
            meta.as_object_mut().unwrap().remove("etkinlik");
            for alan in meta
                .as_object()
                .unwrap()
                .values()
                .filter_map(|v| v.as_str())
            {
                assert!(alan.len() <= META_ALAN_BYTES, "{alan}");
            }
            toplam += json_boyutu(&meta);
        }
        assert!(toplam <= META_TOPLAM_BYTES, "{toplam}");
        let metin = sonuc.to_string();
        assert!(!metin.contains("fixture-value"), "{metin}");
    }

    #[test]
    fn buyuk_dosya_sinirli_pencere_ve_sonuc_eslesmesi() {
        use std::io::{Seek, SeekFrom, Write};
        let kok = gecici_kok("window");
        let dizin = kok.join(".codex/sessions/2001/09/09");
        fs::create_dir_all(&dizin).unwrap();
        let yol = dizin.join("rollout-test.jsonl");
        let mut dosya = fs::File::create(&yol).unwrap();
        writeln!(
            dosya,
            "{}",
            serde_json::json!({"type":"session_meta","payload":{"cwd":"C:/repo"}})
        )
        .unwrap();
        dosya.seek(SeekFrom::Start(200 * 1024 * 1024)).unwrap();
        writeln!(dosya).unwrap();
        for mut kayit in basarili_cagri("codex", "id", "src/latest.rs") {
            kayit["timestamp"] = serde_json::json!("2001-09-09T01:46:40Z");
            writeln!(dosya, "{kayit}").unwrap();
        }
        write!(dosya, "{{\"type\":").unwrap();
        drop(dosya);
        assert_eq!(pencere_oku(&yol).len(), PENCERE_BYTES);
        assert!(son_pencere_oku(&yol).len() <= SON_PENCERE_BYTES);
        let liste = listele(
            &kok,
            "codex",
            1,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_020),
        );
        assert_eq!(
            liste[0].etkinlik["alanlar"],
            serde_json::json!([{"dizin":"src","uzanti":".rs","adet":1}])
        );
        assert_eq!(liste[0].etkinlik["son_hareket_sn"], 20);
        let kayit = "{\"timestamp\":\"2001-09-09T01:46:40Z\"}\n";
        let kuyruk = format!("{kayit}{}", " ".repeat(SON_PENCERE_BYTES - kayit.len()));
        fs::write(&yol, format!("x\n{kuyruk}")).unwrap();
        assert_eq!(son_pencere_oku(&yol), kuyruk);
        fs::write(&yol, format!("xx{kuyruk}")).unwrap();
        assert_eq!(son_pencere_oku(&yol), &kuyruk[kayit.len()..]);
        fs::remove_dir_all(&kok).unwrap();
    }

    /// Ayni oturum kimligi iki projede bulunabilir (kopyalanan/devam ettirilen
    /// oturum). Her giris KENDI dosyasindan okunur: eskiden dosya kimlikten yeniden
    /// aranirdi (her arama butun agaci tariyordu) ve ilk eslesme iki girisin de
    /// alanlarini ve istek metnini veriyordu.
    #[test]
    fn ayni_kimlikli_oturumlar_kendi_dosyalarindan_okunur() {
        let kok = gecici_kok("ayni-kimlik");
        for (proje, cwd, istek) in [
            ("C--a", "C:/proje-a", "yalniz-a-istegi"),
            ("C--b", "C:/proje-b", "yalniz-b-istegi"),
        ] {
            let dizin = kok.join(".claude/projects").join(proje);
            fs::create_dir_all(&dizin).unwrap();
            let kayit = serde_json::json!({
                "type": "user",
                "cwd": cwd,
                "message": { "content": istek }
            });
            fs::write(dizin.join("ortak-kimlik.jsonl"), format!("{kayit}\n")).unwrap();
        }

        let liste = listele(&kok, "claude", 8, SystemTime::now());
        let mut projeler: Vec<_> = liste.iter().filter_map(|m| m.proje.as_deref()).collect();
        projeler.sort_unstable();
        assert_eq!(projeler, ["C:/proje-a", "C:/proje-b"]);

        let sonuc = ajan_oturumlari_kok(&kok, "claude", Some(8), true);
        let mut istekler: Vec<_> = sonuc["oturumlar"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|o| o["son_istekler"].as_array().unwrap())
            .filter_map(|i| i.as_str())
            .collect();
        istekler.sort_unstable();
        assert_eq!(istekler, ["yalniz-a-istegi", "yalniz-b-istegi"]);
        fs::remove_dir_all(&kok).unwrap();
    }

    #[test]
    fn etkinlik_claude_son_on_iki_ve_elli_cagri() {
        let satirlar: Vec<_> = (0..60).map(|i| serde_json::json!({
            "type":"assistant", "timestamp":"2001-09-09T01:46:40Z",
            "message":{"content":[{"type":"tool_use","name":if i < 10 {"OldTool"} else if i >= 57 {"Write"} else if i % 2 == 0 {"Read"} else {"Edit"},"input":{}}]}
        })).collect();
        let e = etkinlik_testi(&satirlar, "claude");
        assert_eq!(
            e["son_araclar"],
            serde_json::json!([
                "Read", "Edit", "Read", "Edit", "Read", "Edit", "Read", "Edit", "Read", "Write",
                "Write", "Write"
            ])
        );
        assert_eq!(
            e["arac_sayilari"],
            serde_json::json!({"Read":24,"Edit":23,"Write":3})
        );
        assert_eq!(e["son_hareket_sn"], 20);
        assert_eq!(e["mesgul"], true);
    }

    #[test]
    fn etkinlik_mesgul_esigi_ve_eksik_zaman() {
        for (damga, beklenen, mesgul) in [
            ("2001-09-09T01:45:31Z", 89, true),
            ("2001-09-09T01:45:30Z", 90, false),
        ] {
            let e = etkinlik_testi(&[serde_json::json!({"timestamp":damga})], "claude");
            assert_eq!(e["son_hareket_sn"], beklenen);
            assert_eq!(e["mesgul"], mesgul);
        }
        let e = etkinlik_testi(&[], "codex");
        assert!(e["son_hareket_sn"].is_null());
        assert_eq!(e["mesgul"], false);
        let e = etkinlik_testi(
            &[
                serde_json::json!({"timestamp":"2001-09-09T01:46:40Z"}),
                serde_json::json!({"type":"summary"}),
            ],
            "claude",
        );
        assert!(e["son_hareket_sn"].is_null());
        assert_eq!(e["mesgul"], false);
    }

    #[test]
    fn etkinlik_zaman_damgasi_kesir_ve_gecersiz_tarih() {
        assert_eq!(
            kayit_zamani("1970-01-01T00:00:00Z"),
            Some(SystemTime::UNIX_EPOCH)
        );
        assert_eq!(
            kayit_zamani("2001-09-09T01:46:40.123Z"),
            Some(SystemTime::UNIX_EPOCH + Duration::new(1_000_000_000, 123_000_000))
        );
        assert_eq!(
            kayit_zamani("2001-09-09T01:46:40+00:00"),
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000))
        );
        assert!(kayit_zamani("2000-02-29T00:00:00Z").is_some());
        for damga in [
            "2025-02-29T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-01-01T00:00:00.xyzZ",
            "bozuk",
        ] {
            assert_eq!(kayit_zamani(damga), None, "{damga}");
        }
    }

    #[test]
    fn maskele_bilinen_onekleri_kapatir() {
        let s = maskele(concat!(
            "anahtar ",
            "sk",
            "-abc123def456 ve ",
            "gh",
            "p_0123456789abcdef kaldi"
        ));
        assert!(!s.contains("abc123def456"), "sk- maskelenmedi: {s}");
        assert!(!s.contains("0123456789abcdef"), "ghp_ maskelenmedi: {s}");
        assert!(s.contains("MASKELI"), "maskeleme isareti yok: {s}");
    }

    #[test]
    fn maskele_anahtar_deger_bicimini_kapatir() {
        let s = maskele("API_KEY=super-gizli-deger password:hunter2000");
        assert!(!s.contains("super-gizli-deger"), "deger acikta: {s}");
        assert!(!s.contains("hunter2000"), "parola acikta: {s}");
    }

    /// REGRESYON: genel "32+ karakter" kurali eklenirse bu test kirmiziya
    /// doner. O kural git SHA'larini ve UUID'leri maskeleyip ciktiyi
    /// okunamaz yapiyordu; maskelemenin bedeli okunabilirlik OLMAMALI.
    #[test]
    fn maskele_sha_ve_uuid_bozmaz() {
        let girdi = "commit 6816300a1b2c3d4e5f60718293a4b5c6d7e8f900 oturum \
                     aa98acbc-afca-4527-8ab1-26e988ae05ea";
        assert_eq!(maskele(girdi), girdi);
    }

    /// Anahtar ile deger arasinda bosluk, tirnak veya satir sonu olabilir; eski
    /// kelime bolen maskeleme bunlarda sirri aynen birakiyordu.
    #[test]
    fn maskele_bosluk_ve_satir_sonu_asan_sirlari_kapatir() {
        for metin in [
            "Authorization: Bearer fixture-value",
            "API_KEY = fixture-value",
            "password: 'fixture-value'",
            r#"{"Authorization":"Bearer fixture-value"}"#,
            "https://example.invalid/?signature=fixture-value&safe=yes",
            "-----BEGIN PRIVATE KEY-----\nfixture-value\n-----END PRIVATE KEY-----",
            "-----BEGIN OPENSSH PRIVATE KEY-----\r\nfixture-value",
        ] {
            let maskeli = maskele(metin);
            assert!(!maskeli.contains("fixture-value"), "{metin} -> {maskeli}");
        }
        assert_eq!(
            maskele("https://example.invalid/?signature=fixture-value&safe=yes"),
            "https://example.invalid/?signature=[MASKELI]&safe=yes"
        );
    }

    /// Tirnakli degerde kacis (`\"`, backtick, `''`) degerin kuyrugunu acikta
    /// birakmamali.
    #[test]
    fn maskele_kacisli_tirnak_degerin_kuyrugunu_acikta_birakmaz() {
        for metin in [
            r#"password="alpha\"fixture-value""#,
            "password='alpha''fixture-value'",
            "password=\"alpha`\"fixture-value\"",
        ] {
            let maskeli = maskele(metin);
            assert!(!maskeli.contains("fixture-value"), "{metin} -> {maskeli}");
        }
    }

    /// Duz yazidaki `basic`/`bearer` sozcukleri sir degildir; yalniz
    /// `Authorization` basligindaki sema + belirtec maskelenir.
    #[test]
    fn maskele_duz_yazidaki_basic_ve_bearer_kelimelerini_bozmaz() {
        let metin = "bu basic bir ornek; Bearer of bad news; Basic functionality";
        assert_eq!(maskele(metin), metin);
    }

    /// Dilimleme bayt sinirlarinda kuruldugu icin cok baytli karakter, kirpik
    /// tirnak ve eksik PEM blogu panik uretmemeli.
    #[test]
    fn maskele_rastgele_unicode_girdide_panik_etmez() {
        const PARCALAR: &[&str] = &[
            "password",
            "api_key",
            "Authorization",
            "Bearer",
            "token",
            "=",
            ":",
            " ",
            "'",
            "\"",
            "\\",
            "`",
            "\n",
            "\r\n",
            "x",
            "é",
            "ğ",
            "日本",
            "-----BEGIN PRIVATE KEY-----",
            "-----END PRIVATE KEY-----",
            "-----BEGIN ",
        ];
        let mut durum = 0x9E37_79B9_7F4A_7C15_u64;
        let mut sonraki = move || {
            durum ^= durum << 13;
            durum ^= durum >> 7;
            durum ^= durum << 17;
            durum as usize
        };
        for _ in 0..3000 {
            let metin: String = (0..1 + sonraki() % 14)
                .map(|_| PARCALAR[sonraki() % PARCALAR.len()])
                .collect();
            let _ = maskele(&metin);
        }
    }

    #[test]
    fn proje_etiketi_uc_bicimi_cozer() {
        assert_eq!(proje_etiketi("C--Users-alice"), "C:/Users/alice");
        assert_eq!(
            proje_etiketi("--wsl-localhost-ubuntu-home-alice"),
            "wsl://ubuntu/home/alice"
        );
        assert!(proje_etiketi("ssh-eb7905c9").starts_with("ssh:"));
    }

    /// Bagimsiz dogrulanabilir iki capa. ILK YAZIMDA epoch degerini ELIMLE
    /// hesaplamistim ve 18 saat yanlisti — capayi tahminle secmek testi
    /// implementasyonun kopyasina cevirir. Bu iki deger genel gecer bilinen
    /// noktalar: epoch'un kendisi ve "bir milyar saniye" ani.
    #[test]
    fn epoch_etiketi_bilinen_tarihleri_verir() {
        assert_eq!(epoch_etiketi(0), "01-01 00:00");
        // 1_000_000_000 = 2001-09-09 01:46:40 UTC
        assert_eq!(epoch_etiketi(1_000_000_000), "09-09 01:46");
    }

    /// Bagil sure dort esigin HER BIRINDE dogru olmali; saat dilimi
    /// gerektirmedigi icin kullaniciya soylenen zaman budur.
    #[test]
    fn bagil_sure_esikleri_dogru() {
        assert_eq!(bagil_sure(0), "az once");
        assert_eq!(bagil_sure(59), "az once");
        assert_eq!(bagil_sure(60), "1 dk once");
        assert_eq!(bagil_sure(3599), "59 dk once");
        assert_eq!(bagil_sure(3600), "1 sa once");
        assert_eq!(bagil_sure(86_399), "23 sa once");
        assert_eq!(bagil_sure(86_400), "1 gun once");
    }

    /// REGRESYON (canli sondada bulundu): `gitBranch: "HEAD"` bir dal adi
    /// degil. Filtre kalkarsa butun oturumlar "dal: HEAD" gorunur ve bu,
    /// bilgi tasimayan bir alani bilgi gibi sunar.
    #[test]
    fn head_dal_adi_sayilmaz() {
        let (_, _, dal) = claude_alanlar("{\"cwd\":\"C:/x\",\"gitBranch\":\"HEAD\"}\n");
        assert_eq!(dal, None, "HEAD dal olarak kabul edildi");

        let (_, _, dal) = claude_alanlar("{\"cwd\":\"C:/x\",\"gitBranch\":\"main\"}\n");
        assert_eq!(dal.as_deref(), Some("main"), "gercek dal dusuruldu");
    }

    #[test]
    fn claude_alanlari_bozuk_satiri_atlar() {
        let pencere = "{bozuk json\n\
            {\"type\":\"user\",\"cwd\":\"C:/x\",\"gitBranch\":\"main\"}\n\
            {\"type\":\"custom-title\",\"customTitle\":\"Smith CI temizligi\"}\n";
        let (baslik, cwd, dal) = claude_alanlar(pencere);
        assert_eq!(baslik.as_deref(), Some("Smith CI temizligi"));
        assert_eq!(cwd.as_deref(), Some("C:/x"));
        assert_eq!(dal.as_deref(), Some("main"));
    }

    #[test]
    fn codex_alanlari_session_meta_okur() {
        let pencere = "{\"type\":\"turn_context\",\"payload\":{}}\n\
            {\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/home/c/x\",\"thread_name\":\"deneme\"}}\n";
        let (baslik, cwd) = codex_alanlar(pencere);
        assert_eq!(cwd.as_deref(), Some("/home/c/x"));
        assert_eq!(baslik.as_deref(), Some("deneme"));
    }

    /// GIZLILIK SOZLESMESI: asistan yaniti ve arac ciktisi DONMEZ.
    /// Bu test kirilirsa sizinti kanali acilmis demektir.
    #[test]
    fn promptlar_yalniz_kullaniciyi_dondurur() {
        let pencere = "{\"type\":\"user\",\"message\":{\"content\":\"testleri kosar misin\"}}\n\
            {\"type\":\"assistant\",\"message\":{\"content\":\"AWS_SECRET=cokgizlideger\"}}\n\
            {\"type\":\"user\",\"isMeta\":true,\"message\":{\"content\":\"meta satir\"}}\n";
        let p = kullanici_promptlari(pencere, "claude");
        assert_eq!(p, vec!["testleri kosar misin".to_string()]);
        assert!(
            !p.join(" ").contains("cokgizlideger"),
            "asistan icerigi sizdi: {p:?}"
        );
    }

    #[test]
    fn promptlar_bayt_butcesini_asmaz() {
        let uzun = "a".repeat(5000);
        let satir = format!("{{\"type\":\"user\",\"message\":{{\"content\":\"{uzun}\"}}}}\n");
        let pencere = satir.repeat(10);
        let p = kullanici_promptlari(&pencere, "claude");
        let toplam: usize = p.iter().map(|s| s.len()).sum();
        assert!(toplam <= ICERIK_MAX_BYTES, "butce asildi: {toplam}");
        assert!(p.len() <= ICERIK_MAX_ADET, "adet asildi: {}", p.len());
    }

    #[test]
    fn yasakli_yollar_okunmaz() {
        for y in [
            "C:/Users/x/.codex/auth.json",
            "C:/Users/x/.claude/.credentials.json",
            "C:/Users/x/proje/.env",
        ] {
            assert!(yasakli(Path::new(y)), "yasak listesine takilmadi: {y}");
            assert!(
                pencere_oku(Path::new(y)).is_empty(),
                "yasakli dosya okundu: {y}"
            );
            assert!(son_pencere_oku(Path::new(y)).is_empty());
        }
    }

    #[test]
    fn adet_ust_sinira_kirpilir() {
        let kok = std::env::temp_dir().join("smith-ajan-test-bos");
        let _ = fs::create_dir_all(&kok);
        // Dosya yok: bos liste, panik yok. Ust sinir mantigi clamp ile korunur.
        assert!(listele(&kok, "hepsi", 9999, SystemTime::now()).is_empty());
    }

    #[test]
    fn kirp_utf8_sinirini_bozmaz() {
        let s = "ğüşiöçĞÜŞİÖÇ tekrar tekrar tekrar";
        for max in 1..s.len() {
            let _ = kirp(s, max); // panik olmamali
        }
    }

    /// Kimlik dosya adindan gelir: ilk 8 BAYT'tan kesmek cok baytli karakterin
    /// ortasina denk gelip araci dusururdu.
    #[test]
    fn unicode_oturum_kimligi_arac_cagrisini_dusurmez() {
        let kok = gecici_kok("unicode-kimlik");
        let proje = kok.join(".claude").join("projects").join("proje");
        fs::create_dir_all(&proje).unwrap();
        fs::write(proje.join("aaaaaaaé.jsonl"), "{}").unwrap();
        let sonuc = ajan_oturumlari_kok(&kok, "claude", Some(1), false);
        fs::remove_dir_all(&kok).unwrap();
        assert_eq!(sonuc["oturumlar"][0]["id"], "aaaaaaaé");
    }
}
