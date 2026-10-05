//! Ekran yakalama — Smith'in "ekranimi da gorsun" yetenegi.
//!
//! Live API ses ile ayni akista goruntu karesi de kabul eder
//! (`realtimeInput.video`, mimeType image/jpeg). Bu modul ekrani yakalar,
//! kucultup JPEG'e cevirir; gonderim `live.rs`'in tek yazar kuralina uyarak
//! mevcut kontrol kanalindan gecer.
//!
//! TASARIM KARARLARI:
//! - **Kare hizi cok dusuk (varsayilan 1 kare / 2 sn).** Ekran video degil
//!   BAGLAM; saniyede 30 kare ne gerekli ne tasinabilir. Yuksek fps hem WS'i
//!   bogar hem token/kota yakar.
//! - **Kucultme sart:** 4K kare ~8 MB JPEG olur; base64'te 11 MB. Uzun kenar
//!   1280'e indirilince ~150-250 KB'a duser ve model icin yeterli okunur.
//! - **Varsayilan KAPALI** (`SMITH_SCREEN=1` ile acilir): ekran icerigi buluta
//!   gider, bu bilincli bir karar olmali — sessizce acilmaz.
//!
//! ## Cok monitor (`SMITH_SCREEN_MONITORS`)
//!
//! Kullanici mandasi: "butun monitorlerimi gorebilmesini istiyorum." Uc yol
//! olculdu, biri **olcumle** elendi:
//!
//! - **Monitorleri tek karede yan yana birlestirmek ELENDI.** Bu makinede iki
//!   ekran da 1920x1080 (olcum: `cargo run --example screen_probe`). Yan yana
//!   koymak 3840x1080 verir; uzun kenar `DEFAULT_MAX_EDGE`e (1920) indirilince
//!   monitor basina 960x540 kalir — bugunkunun DORTTE BIRI piksel. Bu projede
//!   cozunurluk tam bu yuzden 1280'den 1920'ye cikarilmisti ("ekrandaki
//!   yazilari okuyamiyor"); birlestirme o karari geri alir. Kota sabit kalirdi
//!   ama okunabilirlik cokerdi, yani bedeli yanlis yerden odenirdi.
//! - **Her monitor ayri kare (`all`)** okunabilirligi korur (bu makinede
//!   kucultme HIC devreye girmez, 1920x1080 zaten sinirda) ama kare sayisini
//!   ve video token'ini monitor sayisiyla CARPAR: 30 kare/dk → 60 kare/dk.
//!   Kota bu projede olculmus bir duvar (`googleSearch` free-tier'da 1011,
//!   embed gunluk kotasi bir kez tukendi), o yuzden varsayilan olamaz.
//! - **Odaklanmis pencerenin monitoru (`active`, VARSAYILAN):** kota bugunkunun
//!   AYNISI (30 kare/dk), okunabilirlik bugunkunun AYNISI (kucultme yok) ve
//!   asil kusuru duzeltir — bugun Smith soldaki ekrani HIC gormuyor, kullanici
//!   orada calisirken kordur. Ek bir gerekce tel formatindan geliyor:
//!   `realtimeInput.video` yalniz `mimeType` + `data` tasir, ETIKET ALANI YOK
//!   (bkz. `live.rs`). Tek akisli bir mod modelin "ekran" kavramiyla birebir
//!   ortusur; cok akisli modda modelin hangi kareyi hangi ekran sandigi
//!   cagiranin etiketi ayrica tasimasina bagli kalir.
//! - **`rotate`:** her tikta SIRADAKI monitor. Mandayi harfiyen karsilayan ve
//!   kotayi sabit tutan tek mod (30 kare/dk); bedeli monitor basina tazelik
//!   2 sn'den 2 sn x monitor sayisina duser (bu masada 4 sn).
//!
//! Tek monitorlu makinede `primary`, `all`, `active` ve `rotate` ayni tek
//! kareyi uretir — regresyon yok.

use std::io::Cursor;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Once;

use image::{codecs::jpeg::JpegEncoder, DynamicImage};

/// Yakalanan karenin uzun kenari (piksel).
///
/// 1280 ile baslamistik; sahada YETMEDI — kullanici "ekrandaki yazilari
/// okuyamiyor" dedi (Smith bunu kendi hafizasina bile kaydetti). 1440p ekranda
/// 1280'e indirmek kucuk arayuz metnini (menu, kod, log) okunamaz yapiyor.
/// 1920: metin okunur hale gelir, kare ~350-500 KB'ta kalir. Env ile
/// yukseltilebilir (`SMITH_SCREEN_MAX_EDGE`) — 4K'da tam cozunurluk isteyen
/// olursa kotayi bilerek harcar.
const DEFAULT_MAX_EDGE: u32 = 1920;
/// JPEG kalitesi. 70 metinde artefakt uretiyordu (harf kenarlari bulasiyor);
/// 85 metni belirgin netlestirir, boyut artisi ~%40 — okunabilirlik icin deger.
const DEFAULT_QUALITY: u8 = 85;
/// Net karede baslangic kalitesi; butce asilirsa kademeli azaltilir.
const SHARP_QUALITY: u8 = 92;
const NET_KARE_BAYT: usize = 400 * 1024;
const NET_TOPLAM_BAYT: usize = 700 * 1024;
const NET_MIN_KENAR: u32 = 1600;

fn net_kare_butcesi(adet: usize) -> usize {
    NET_KARE_BAYT.min(NET_TOPLAM_BAYT / adet.max(1))
}
/// `SMITH_SCREEN_MONITORS=1,2` listesinde kabul edilen en buyuk indeks.
/// Amac dogrulama degil AKIL SAGLIGI: "99999" gibi bir deger yazim hatasidir,
/// sessizce tasinmasi yerine dusurulup varsayilana donulur.
const MAX_MONITOR_INDEX: usize = 64;

fn max_edge() -> u32 {
    std::env::var("SMITH_SCREEN_MAX_EDGE")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v| (640..=3840).contains(v))
        .unwrap_or(DEFAULT_MAX_EDGE)
}

fn quality() -> u8 {
    std::env::var("SMITH_SCREEN_QUALITY")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v| (40..=95).contains(v))
        .unwrap_or(DEFAULT_QUALITY)
}

/// Hangi monitorler yakalanir (`SMITH_SCREEN_MONITORS`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonitorSelection {
    /// Yalniz birincil ekran — 2026-08-14 oncesinin davranisi.
    Primary,
    /// Her monitor icin ayri kare. Kota monitor sayisiyla CARPILIR.
    All,
    /// Odaklanmis pencerenin bulundugu monitor (varsayilan). Cozulemezse
    /// birincile duser.
    Active,
    /// Her cagrida siradaki monitor. Kota sabit, tazelik monitor sayisina bolunur.
    Rotate,
    /// Acik indeks listesi (1-tabanli, soldan saga; sirali ve tekrarsiz).
    List(Vec<usize>),
}

/// Varsayilan mod. Gerekce modul basliginda: bugunkuyle AYNI kota, AYNI
/// okunabilirlik, ve kullanicinin calistigi ekran artik gorunuyor.
const DEFAULT_SELECTION: MonitorSelection = MonitorSelection::Active;

/// `SMITH_SCREEN_MONITORS` degerini ayristirir. Gecersiz her girdi güvenli
/// varsayilana duser — panik YOK, `Err` YOK (ekran algisi yapilandirma
/// hatasindan dolayi tamamen kor kalmamali).
fn parse_selection(raw: &str) -> MonitorSelection {
    let t = raw.trim().to_ascii_lowercase();
    match t.as_str() {
        "primary" => return MonitorSelection::Primary,
        "all" => return MonitorSelection::All,
        "active" => return MonitorSelection::Active,
        "rotate" => return MonitorSelection::Rotate,
        _ => {}
    }
    // Liste yolu: "1,2" / " 2 , 1 " / "1,1,2". Bozuk parcalar dusurulur.
    let mut idx: Vec<usize> = t
        .split(',')
        .filter_map(|p| p.trim().parse::<usize>().ok())
        .filter(|i| (1..=MAX_MONITOR_INDEX).contains(i))
        .collect();
    if idx.is_empty() {
        return DEFAULT_SELECTION;
    }
    idx.sort_unstable();
    idx.dedup();
    MonitorSelection::List(idx)
}

/// Etkin monitor secimi (`SMITH_SCREEN_MONITORS`, tanimsizsa varsayilan).
pub fn selection() -> MonitorSelection {
    std::env::var("SMITH_SCREEN_MONITORS")
        .ok()
        .map(|v| parse_selection(&v))
        .unwrap_or(DEFAULT_SELECTION)
}

/// MODELIN sozlugunden secim. `ekrani_net_gor` aracinin `ekran` argumani.
///
/// NEDEN AYRI BIR AYRISTIRICI: `SMITH_SCREEN_MONITORS` bir yapilandirma
/// dizesidir (`all`/`active`/`1,2`), model ise Turkce konusur ("sol ekran",
/// "digeri"). Ikisini tek fonksiyona sikistirmak, modelin "sag" demesiyle
/// kullanicinin "rotate" yazmasini ayni yerde ele almak olurdu.
///
/// Bos/taninmayan girdi `Active`'e duser: model ne dedigini bilmiyorsa
/// kullanicinin BAKTIGI ekran her zaman en makul cevaptir.
pub fn selection_from_model(raw: &str) -> MonitorSelection {
    let t = raw.trim().to_ascii_lowercase();
    match t.as_str() {
        "" | "odak" | "aktif" | "bu" | "buradaki" | "active" => MonitorSelection::Active,
        "hepsi" | "tumu" | "tum" | "ikisi" | "all" => MonitorSelection::All,
        "birincil" | "ana" | "primary" => MonitorSelection::Primary,
        "sol" | "soldaki" | "left" => MonitorSelection::List(vec![1]),
        // "sag" 1-tabanli son indekse denk gelir; iki monitorde 2, tekte 1.
        "sag" | "sagdaki" | "right" => {
            let n = inventory().len().max(1);
            MonitorSelection::List(vec![n])
        }
        _ => parse_selection(&t),
    }
}

/// Net kareleri ACIK bir secimle yakalar — `ekrani_net_gor` aracinin yolu.
///
/// `sharp_selection` BURADA da uygulanir: tek seferlik bir bakista "sirayla"
/// anlamsizdir (model "goster" der, sira bekleyemez) → `Rotate` istenirse
/// hepsi gonderilir. Bu kural akis yoluyla ortak; iki yerde ayrismasi
/// "akis dogru ekrani gosteriyor ama net kare baskasini okuyor" sinifina
/// kapi acardi.
pub fn capture_sharp_selection(sel: &MonitorSelection) -> Result<Vec<ScreenFrame>, String> {
    capture_frames_with(&sharp_selection(sel.clone()), None, SHARP_QUALITY)
}

/// Bir monitorun kimligi — log, UI ve kare etiketi icin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonitorInfo {
    /// 1-tabanli sira: soldan saga (bkz. `enumerate` siralamasi).
    pub index: usize,
    /// Platform kimligi (Windows'ta HMONITOR). `active` eslemesi bunu kullanir.
    pub id: u32,
    /// Modele/kullaniciya gorunen ayirt edici etiket.
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
}

/// Tek bir monitorun tek karesi.
///
/// `label` MODEL ICIN: hangi ekrani gordugunu bilmeli. Ama dikkat —
/// `realtimeInput.video` cercevesinde etiket alani YOK; etiketi modele
/// tasimak (metin turu, log, UI) cagiranin isidir. Bu modul yalniz ayirt
/// edici bir etiket URETTIGINI garanti eder.
#[derive(Debug, Clone)]
pub struct ScreenFrame {
    pub label: String,
    pub jpeg: Vec<u8>,
}

/// Envanter + yakalama tutamagi birlikte. `xcap::Monitor` ucuz kopyalanir
/// (icinde yalniz HMONITOR var), o yuzden bilgiyle beraber tasiniyor.
struct Ekran {
    info: MonitorInfo,
    monitor: xcap::Monitor,
}

/// n monitorluk bir masada `index`in uzamsal adi. Kullanici "sol ekranim"
/// diyor; etiket bu sozlugu tasimazsa model o cumleyi hicbir kareye baglayamaz.
fn konum_etiketi(index: usize, n: usize) -> Option<String> {
    match n {
        0 | 1 => None,
        2 if index == 1 => Some("sol".to_string()),
        2 => Some("sag".to_string()),
        _ => Some(format!("soldan {index}.")),
    }
}

/// Monitorleri **deterministik** sirada dondurur.
///
/// `xcap::Monitor::all()` Windows'ta `EnumDisplayMonitors` sirasini dondurur ve
/// bu sira isletim sistemi tarafindan garanti EDILMEZ. Indeksler
/// (`SMITH_SCREEN_MONITORS=1,2`) ve etiketler ("sol ekran") o siraya baglanirsa
/// bir gun sessizce yer degistirirler. (x, y) ile siralamak hem kararlidir hem
/// kullanicinin uzamsal sozlugune oturur: 1 = en soldaki.
fn enumerate() -> Result<Vec<Ekran>, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("ekranlar listelenemedi: {e}"))?;
    if monitors.is_empty() {
        return Err("ekran bulunamadi".to_string());
    }
    // Geometri her cagrida bir syscall (EnumDisplaySettingsW) — bir kez oku.
    let mut olculen: Vec<(i32, i32, u32, u32, u32, bool, xcap::Monitor)> = monitors
        .into_iter()
        .map(|m| {
            (
                m.x().unwrap_or(i32::MAX),
                m.y().unwrap_or(i32::MAX),
                m.width().unwrap_or(0),
                m.height().unwrap_or(0),
                m.id().unwrap_or(0),
                m.is_primary().unwrap_or(false),
                m,
            )
        })
        .collect();
    olculen.sort_by_key(|(x, y, _, _, id, _, _)| (*x, *y, *id));

    let n = olculen.len();
    Ok(olculen
        .into_iter()
        .enumerate()
        .map(|(i, (_, _, w, h, id, primary, monitor))| {
            let index = i + 1;
            let mut parcalar = Vec::with_capacity(3);
            if let Some(k) = konum_etiketi(index, n) {
                parcalar.push(k);
            }
            parcalar.push(format!("{w}x{h}"));
            if primary {
                parcalar.push("birincil".to_string());
            }
            Ekran {
                info: MonitorInfo {
                    index,
                    id,
                    label: format!("Ekran {index}/{n} ({})", parcalar.join(", ")),
                    width: w,
                    height: h,
                    is_primary: primary,
                },
                monitor,
            }
        })
        .collect())
}

/// Olculen monitor envanteri (log ve UI icin). Hata durumunda bos liste —
/// cagirani `Result` ile ugrastirmaya deger bir bilgi degil.
pub fn inventory() -> Vec<MonitorInfo> {
    enumerate()
        .map(|v| v.into_iter().map(|e| e.info).collect())
        .unwrap_or_default()
}

/// Birincil ekranin dizideki yeri; birincil isaretlenmemisse ilk ekran.
fn birincil_pos(ekranlar: &[Ekran]) -> usize {
    ekranlar.iter().position(|e| e.info.is_primary).unwrap_or(0)
}

/// Odaklanmis pencerenin monitor kimligi. Odak yoksa (masaustu secili, hepsi
/// simge durumunda) veya pencere listesi alinamazsa `None` → cagiran birincile
/// duser. Bu SESSIZ bir dususe uygun: normal bir durum, hata degil.
fn aktif_monitor_id() -> Option<u32> {
    let windows = xcap::Window::all().ok()?;
    let odak = windows
        .into_iter()
        .find(|w| w.is_focused().unwrap_or(false))?;
    odak.current_monitor().ok()?.id().ok()
}

/// `rotate` icin tur sayaci. Modul-duzeyi durum bilincli: cagiran (`live.rs`)
/// durumsuz bir fonksiyon cagirir, gezinme burada saklanir. Monitor sayisi
/// oturum ortasinda degisirse modulo kendini toparlar.
static ROTATE_NEXT: AtomicUsize = AtomicUsize::new(0);

/// Liste modu hicbir mevcut monitore denk gelmediginde bir kez uyarir.
/// Her 2 saniyede bir ayni satiri basmak log'u ise yaramaz hale getirir.
static LISTE_UYARISI: Once = Once::new();

/// Secimi mevcut envantere cozer → yakalanacak pozisyonlar (0-tabanli).
/// Bos liste ASLA donmez: en kotu durumda birincil.
fn secili_pozisyonlar(sel: &MonitorSelection, ekranlar: &[Ekran]) -> Vec<usize> {
    let n = ekranlar.len();
    match sel {
        MonitorSelection::Primary => vec![birincil_pos(ekranlar)],
        MonitorSelection::All => (0..n).collect(),
        MonitorSelection::Active => {
            let pos = aktif_monitor_id()
                .and_then(|id| ekranlar.iter().position(|e| e.info.id == id))
                .unwrap_or_else(|| birincil_pos(ekranlar));
            vec![pos]
        }
        MonitorSelection::Rotate => vec![ROTATE_NEXT.fetch_add(1, Ordering::Relaxed) % n],
        MonitorSelection::List(idx) => {
            let pos: Vec<usize> = idx.iter().filter(|i| **i <= n).map(|i| i - 1).collect();
            if pos.is_empty() {
                LISTE_UYARISI.call_once(|| {
                    eprintln!(
                        "[screen] SMITH_SCREEN_MONITORS={idx:?} hicbir ekrana denk gelmedi ({n} monitor var) → birincil kullaniliyor"
                    );
                });
                return vec![birincil_pos(ekranlar)];
            }
            pos
        }
    }
}

/// Yakala + (istenirse) kucult + JPEG'e kodla.
fn kare_uret(
    ekran: &Ekran,
    edge: Option<u32>,
    q: u8,
    butce: Option<usize>,
) -> Result<Vec<u8>, String> {
    // xcap zaten `image::RgbaImage` dondurur (Cargo.lock'ta tek `image` 0.25.10
    // var, yani ayni tip) — ham tampondan yeniden kurmaya gerek yok.
    let shot = ekran
        .monitor
        .capture_image()
        .map_err(|e| format!("ekran yakalanamadi: {e}"))?;
    let (w, h) = (shot.width(), shot.height());
    let img = DynamicImage::ImageRgba8(shot);

    // Uzun kenari edge'e indir (oran korunur). Zaten kucukse dokunma.
    let img = match edge {
        Some(edge) if w.max(h) > edge => {
            let scale = edge as f32 / w.max(h) as f32;
            img.resize(
                (w as f32 * scale) as u32,
                (h as f32 * scale) as u32,
                // Lanczos3, Triangle DEGIL: metin kucultmede belirleyici fark.
                // Triangle harfleri bulastiriyordu (okunamama sikayetinin bir parcasi).
                image::imageops::FilterType::Lanczos3,
            )
        }
        _ => img,
    };
    match butce {
        Some(butce) => net_kare_kodla(&img, butce),
        None => jpeg_kodla(&img, q),
    }
}

fn jpeg_kodla(img: &DynamicImage, q: u8) -> Result<Vec<u8>, String> {
    // JPEG alfa kanali tasimaz; RGB'ye cevirmek zorunlu.
    let rgb = img.to_rgb8();

    let mut out = Cursor::new(Vec::new());
    JpegEncoder::new_with_quality(&mut out, q)
        .encode_image(&DynamicImage::ImageRgb8(rgb))
        .map_err(|e| format!("jpeg kodlanamadi: {e}"))?;
    Ok(out.into_inner())
}

fn net_kare_kodla(img: &DynamicImage, butce: usize) -> Result<Vec<u8>, String> {
    let kenar = img.width().max(img.height());
    let taban = NET_MIN_KENAR.min(kenar);
    let mut aday = img.clone();
    // Once kalite, sonra tek kucultme. Her boyutta tekrar q92'ye cikmak
    // buyuk karelerde kodlama gecikmesini gereksiz yere carpar.
    for (hedef, q) in [
        (kenar, SHARP_QUALITY),
        (kenar, 80),
        (taban, 80),
        (taban, 65),
        (taban, 50),
        (taban, 35),
        (taban, 20),
    ] {
        if aday.width().max(aday.height()) != hedef {
            aday = img.resize(hedef, hedef, image::imageops::FilterType::Lanczos3);
        }
        let jpeg = jpeg_kodla(&aday, q)?;
        if jpeg.len() <= butce {
            eprintln!(
                "[screen] net kare {} KB (kalite {q}, {}x{})",
                jpeg.len().div_ceil(1024),
                aday.width(),
                aday.height()
            );
            return Ok(jpeg);
        }
    }
    Err(format!(
        "net kare {butce} bayt butcesine sigmadi ({taban} px altina inilmedi)"
    ))
}

/// Secilen monitorleri yakalar.
///
/// **Kismi basarisizlik oturumu dusurmez:** bir monitor hata verirse o kare
/// atlanir ve digerleri yollanir. Hicbir kare uretilemezse `Err` — cagiran
/// zaten tek kareyi atliyor.
fn capture_frames_with(
    sel: &MonitorSelection,
    edge: Option<u32>,
    q: u8,
) -> Result<Vec<ScreenFrame>, String> {
    let ekranlar = enumerate()?;
    let pozlar = secili_pozisyonlar(sel, &ekranlar);
    let butce = edge.is_none().then(|| net_kare_butcesi(pozlar.len()));
    let mut frames = Vec::with_capacity(pozlar.len());
    let mut son_hata = None;
    for p in pozlar {
        let Some(ekran) = ekranlar.get(p) else {
            continue;
        };
        match kare_uret(ekran, edge, q, butce) {
            Ok(jpeg) => frames.push(ScreenFrame {
                label: ekran.info.label.clone(),
                jpeg,
            }),
            Err(e) => {
                eprintln!("[screen] {} atlandi: {e}", ekran.info.label);
                son_hata = Some(e);
            }
        }
    }
    if frames.is_empty() {
        return Err(son_hata.unwrap_or_else(|| "yakalanacak ekran bulunamadi".to_string()));
    }
    Ok(frames)
}

/// PERIYODIK AKIS — `SMITH_SCREEN_MONITORS` secimine gore bir veya daha fazla
/// kare. Tek monitorlu makinede tek kare (eski davranisla ayni yol).
pub fn capture_jpeg_frames() -> Result<Vec<ScreenFrame>, String> {
    capture_frames_with(&selection(), Some(max_edge()), quality())
}

/// Tek seferlik net istekte gecerli secim. Yalniz `rotate` degisir: gezinme
/// AKISIN kota stratejisidir; tek seferlik ve bilincli bir istege sirasi
/// gelmis rastgele bir ekrani dondurmek dogruluk kumari olur.
///
/// NOT: eskiden bir de `capture_sharp_frames()` vardi (net kareyi ETKIN
/// env secimiyle alirdi). 2026-08-15'te kaldirildi — `ekrani_net_gor` artik
/// MODELIN istedigi ekrani aliyor (`capture_sharp_selection`), dolayisiyla
/// env secimine bagli sarmalayicinin cagirani kalmadi.
fn sharp_selection(sel: MonitorSelection) -> MonitorSelection {
    match sel {
        MonitorSelection::Rotate => MonitorSelection::All,
        other => other,
    }
}

/// Birincil ekranin tek karesi — **DONMUS REFERANS UYGULAMA, YALNIZ TEST**.
///
/// Uretimde artik cagrilmiyor: `live.rs` cok monitor secimini destekleyen
/// `capture_jpeg_frames`'e gecti (2026-08-15). Bu iki fonksiyon yine de
/// duruyor cunku `birincil_secimi_eski_davranisla_ayni_kareyi_uretir`
/// regresyon kapisi cok-monitorlu yolun `primary` secimiyle ESKI davranisi
/// karsilastiriyor — kiyas noktasi olmadan o kapi anlamsizlasir.
///
/// `#[cfg(test)]`: uretimde cagrilmayan kod olu koddur ve AGENTS.md uyariyi
/// SUSTURMAYI yasakliyor. Dogru cozum `#[allow(dead_code)]` degil, kodu
/// gercek kapsamina (test) cekmektir.
#[cfg(test)]
pub fn capture_primary_jpeg() -> Result<Vec<u8>, String> {
    let mut frames = capture_frames_with(&MonitorSelection::Primary, Some(max_edge()), quality())?;
    Ok(frames.remove(0).jpeg)
}

/// Birincil ekranin butceli net karesi; secim regresyonu icin test yolu.
#[cfg(test)]
pub fn capture_primary_sharp() -> Result<Vec<u8>, String> {
    let mut frames = capture_frames_with(&MonitorSelection::Primary, None, SHARP_QUALITY)?;
    Ok(frames.remove(0).jpeg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saha_net_kare_bayt_butcesine_uyar() {
        let mut seed = 7u32;
        let rgb = image::RgbImage::from_fn(1920, 1080, |_, _| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            image::Rgb([(seed >> 24) as u8, (seed >> 16) as u8, (seed >> 8) as u8])
        });
        let jpeg = net_kare_kodla(&DynamicImage::ImageRgb8(rgb), 350 * 1024).unwrap();
        assert!(jpeg.len() <= 350 * 1024, "net kare {} bayt", jpeg.len());
        let img = image::load_from_memory(&jpeg).unwrap();
        assert!(img.width().max(img.height()) >= 1600);
    }

    #[test]
    fn saha_net_kare_toplam_butce_ve_cozunurluk_tabani() {
        assert_eq!(net_kare_butcesi(1), 400 * 1024);
        assert_eq!(net_kare_butcesi(2), 350 * 1024);
        for adet in 1..=64 {
            assert!(net_kare_butcesi(adet) * adet <= NET_TOPLAM_BAYT);
        }
        let img = DynamicImage::ImageRgb8(image::RgbImage::new(1600, 900));
        assert!(
            net_kare_kodla(&img, 1).is_err(),
            "tabanin altina inerek butce tutturulmaz"
        );
        let kucuk = DynamicImage::ImageRgb8(image::RgbImage::new(800, 600));
        let jpeg = net_kare_kodla(&kucuk, net_kare_butcesi(1)).unwrap();
        let sonuc = image::load_from_memory(&jpeg).unwrap();
        assert_eq!((sonuc.width(), sonuc.height()), (800, 600));
    }

    #[test]
    fn saha_net_kare_sonda_girdisini_uretim_yoluyla_kodlar() {
        let Ok(girdi) = std::env::var("SMITH_NET_KARE_PROBE_IN") else {
            return;
        };
        let cikti = std::env::var("SMITH_NET_KARE_PROBE_OUT").expect("sonda cikti yolu");
        let ham = std::fs::read(girdi).unwrap();
        let img = image::load_from_memory(&ham).unwrap();
        let jpeg = net_kare_kodla(&img, net_kare_butcesi(2)).unwrap();
        assert!(jpeg.len() < ham.len());
        eprintln!(
            "[screen] sonda kaynak {} bayt -> {} bayt",
            ham.len(),
            jpeg.len()
        );
        std::fs::write(cikti, jpeg).unwrap();
    }

    /// Gercek yakalama testleri masaustu oturumu olmayan bir ortamda
    /// basarisiz olabilir; o durumda mesaj basilir ama test BASARISIZ SAYILMAZ
    /// (ortam kisiti, kod kusuru degil). Yerelde gercek dogrulama saglar.
    fn ekranlar_veya_atla() -> Option<Vec<Ekran>> {
        match enumerate() {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("[test] envanter alinamadi (ortam kisiti olabilir): {e}");
                None
            }
        }
    }

    fn gecerli_jpeg(jpeg: &[u8], nereden: &str) {
        assert!(
            jpeg.len() > 5_000,
            "{nereden}: jpeg cok kucuk: {} bayt",
            jpeg.len()
        );
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "{nereden}: JPEG SOI imzasi yok");
        assert!(
            jpeg.len() < 2_000_000,
            "{nereden}: jpeg beklenenden buyuk ({} bayt) — kucultme calismiyor",
            jpeg.len()
        );
    }

    /// Gercek ekran yakalama: kod derlendi DEGIL, CALISIYOR mu?
    #[test]
    fn ekran_yakalanir_ve_jpeg_uretir() {
        match capture_primary_jpeg() {
            Ok(jpeg) => {
                gecerli_jpeg(&jpeg, "capture_primary_jpeg");
                eprintln!("[test] ekran karesi: {} KB", jpeg.len() / 1024);
            }
            Err(e) => eprintln!("[test] ekran yakalanamadi (ortam kisiti olabilir): {e}"),
        }
    }

    /// Envanter bos olmamali ve her monitor AYIRT EDILEBILIR bir etiket
    /// tasimali: model hangi ekrani gordugunu bilmek zorunda. Bu makinede iki
    /// ekran da ayni marka/model ve ayni cozunurluk — yani `name()` tek basina
    /// yetmiyor, etiketin indeksi tasimasi ZORUNLU.
    #[test]
    fn envanter_dolu_ve_etiketler_ayirt_edici() {
        let Some(ekranlar) = ekranlar_veya_atla() else {
            return;
        };
        assert!(!ekranlar.is_empty(), "monitor listesi bos");
        let mut etiketler: Vec<&str> = ekranlar.iter().map(|e| e.info.label.as_str()).collect();
        let toplam = etiketler.len();
        etiketler.sort_unstable();
        etiketler.dedup();
        assert_eq!(
            etiketler.len(),
            toplam,
            "etiketler ayirt edici degil: {etiketler:?}"
        );
        for (i, e) in ekranlar.iter().enumerate() {
            assert_eq!(e.info.index, i + 1, "indeks 1-tabanli ve sirali olmali");
            assert!(e.info.width > 0 && e.info.height > 0, "cozunurluk sifir");
            eprintln!(
                "[test] {} → {}x{} id={} primary={}",
                e.info.label, e.info.width, e.info.height, e.info.id, e.info.is_primary
            );
        }
        assert!(
            ekranlar.iter().filter(|e| e.info.is_primary).count() <= 1,
            "birden fazla birincil ekran isaretli"
        );
    }

    /// Envanter siralamasi turlar arasi KARARLI olmali; indeksler ve "sol/sag"
    /// etiketleri buna baglidir.
    #[test]
    fn envanter_siralamasi_kararli() {
        let Some(a) = ekranlar_veya_atla() else {
            return;
        };
        let Some(b) = ekranlar_veya_atla() else {
            return;
        };
        let ids_a: Vec<u32> = a.iter().map(|e| e.info.id).collect();
        let ids_b: Vec<u32> = b.iter().map(|e| e.info.id).collect();
        assert_eq!(ids_a, ids_b, "monitor siralamasi turlar arasi degisti");
    }

    /// `all`: her monitor icin bir kare ve HEPSI gecerli JPEG.
    #[test]
    fn tum_monitorler_gecerli_kare_uretir() {
        let Some(ekranlar) = ekranlar_veya_atla() else {
            return;
        };
        match capture_frames_with(
            &MonitorSelection::All,
            Some(DEFAULT_MAX_EDGE),
            DEFAULT_QUALITY,
        ) {
            Ok(frames) => {
                assert_eq!(
                    frames.len(),
                    ekranlar.len(),
                    "all modu monitor sayisi kadar kare uretmeli"
                );
                let mut etiketler: Vec<&str> = frames.iter().map(|f| f.label.as_str()).collect();
                let toplam = etiketler.len();
                etiketler.sort_unstable();
                etiketler.dedup();
                assert_eq!(etiketler.len(), toplam, "kare etiketleri tekrar ediyor");
                for f in &frames {
                    gecerli_jpeg(&f.jpeg, &f.label);
                    eprintln!("[test] all: {} → {} KB", f.label, f.jpeg.len() / 1024);
                }
            }
            Err(e) => eprintln!("[test] all yakalanamadi (ortam kisiti olabilir): {e}"),
        }
    }

    /// REGRESYON KAPISI: `primary` secimi eski `capture_primary_jpeg` ile AYNI
    /// yolu kullanmali. Ekran icerigi iki cagri arasinda degisebildigi icin
    /// baytlar degil COZUNURLUK karsilastirilir — kucultme yolu ayni ise
    /// boyutlar birebir esittir.
    #[test]
    fn birincil_secimi_eski_davranisla_ayni_kareyi_uretir() {
        if ekranlar_veya_atla().is_none() {
            return;
        }
        let yeni = capture_frames_with(
            &MonitorSelection::Primary,
            Some(DEFAULT_MAX_EDGE),
            DEFAULT_QUALITY,
        );
        let (Ok(yeni), Ok(eski)) = (yeni, capture_primary_jpeg()) else {
            eprintln!("[test] birincil yakalanamadi (ortam kisiti olabilir)");
            return;
        };
        assert_eq!(yeni.len(), 1, "primary tek kare uretmeli");
        let a = image::load_from_memory(&yeni[0].jpeg).expect("yeni kare decode edilemedi");
        let b = image::load_from_memory(&eski).expect("eski kare decode edilemedi");
        assert_eq!(
            (a.width(), a.height()),
            (b.width(), b.height()),
            "primary secimi eski yoldan farkli cozunurluk uretti"
        );
        eprintln!("[test] primary regresyon: {}x{}", a.width(), a.height());

        // NET KARE de ayni kapidan gecer. `ekrani_net_gor` yolu akistan AYRI
        // bir cozunurluk/kalite kullaniyor; birincil secimi orada da eski
        // davranisla ayni kalmali, yoksa "akis dogru ekrani gosteriyor ama net
        // kare baska ekrani okuyor" sinifina kapi acilir.
        let yeni_net = capture_frames_with(&MonitorSelection::Primary, None, SHARP_QUALITY);
        let (Ok(yeni_net), Ok(eski_net)) = (yeni_net, capture_primary_sharp()) else {
            eprintln!("[test] net kare yakalanamadi (ortam kisiti olabilir)");
            return;
        };
        assert_eq!(yeni_net.len(), 1, "primary net kare tek olmali");
        let c = image::load_from_memory(&yeni_net[0].jpeg).expect("yeni net kare decode edilemedi");
        let d = image::load_from_memory(&eski_net).expect("eski net kare decode edilemedi");
        assert_eq!(
            (c.width(), c.height()),
            (d.width(), d.height()),
            "net kare primary secimi eski yoldan farkli cozunurluk uretti"
        );
        eprintln!("[test] primary net regresyon: {}x{}", c.width(), c.height());
    }

    /// `active`: her zaman TEK kare (kota bugunkuyle ayni) ve etiket mevcut
    /// envanterden gelmeli.
    #[test]
    fn aktif_monitor_tek_kare_uretir() {
        let Some(ekranlar) = ekranlar_veya_atla() else {
            return;
        };
        match capture_frames_with(
            &MonitorSelection::Active,
            Some(DEFAULT_MAX_EDGE),
            DEFAULT_QUALITY,
        ) {
            Ok(frames) => {
                assert_eq!(frames.len(), 1, "active tek kare uretmeli");
                gecerli_jpeg(&frames[0].jpeg, &frames[0].label);
                assert!(
                    ekranlar.iter().any(|e| e.info.label == frames[0].label),
                    "active etiketi envanterde yok: {}",
                    frames[0].label
                );
                eprintln!("[test] active → {}", frames[0].label);
            }
            Err(e) => eprintln!("[test] active yakalanamadi (ortam kisiti olabilir): {e}"),
        }
    }

    /// `rotate`: her cagri TEK kare (kota sabit) ve monitor sayisi kadar cagri
    /// TUM ekranlari kapsar.
    #[test]
    fn sirayla_gezinme_tum_ekranlari_kapsar() {
        let Some(ekranlar) = ekranlar_veya_atla() else {
            return;
        };
        let n = ekranlar.len();
        let mut gorulen: Vec<String> = Vec::new();
        for _ in 0..n {
            match capture_frames_with(
                &MonitorSelection::Rotate,
                Some(DEFAULT_MAX_EDGE),
                DEFAULT_QUALITY,
            ) {
                Ok(frames) => {
                    assert_eq!(frames.len(), 1, "rotate her cagride tek kare uretmeli");
                    gecerli_jpeg(&frames[0].jpeg, &frames[0].label);
                    gorulen.push(frames[0].label.clone());
                }
                Err(e) => {
                    eprintln!("[test] rotate yakalanamadi (ortam kisiti olabilir): {e}");
                    return;
                }
            }
        }
        gorulen.sort_unstable();
        gorulen.dedup();
        assert_eq!(
            gorulen.len(),
            n,
            "{n} cagri {} farkli ekran gordu: {gorulen:?}",
            gorulen.len()
        );
        eprintln!("[test] rotate {n} cagride tum ekranlari kapsadi");
    }

    /// Gecersiz liste (var olmayan indeks) → panik YOK, kor kalma YOK:
    /// birincile duser.
    #[test]
    fn gecersiz_liste_birincile_duser() {
        let Some(ekranlar) = ekranlar_veya_atla() else {
            return;
        };
        let pozlar = secili_pozisyonlar(&MonitorSelection::List(vec![99]), &ekranlar);
        assert_eq!(pozlar, vec![birincil_pos(&ekranlar)]);
        // Var olan + var olmayan karisik: yalniz var olan kalir.
        let pozlar = secili_pozisyonlar(&MonitorSelection::List(vec![1, 99]), &ekranlar);
        assert_eq!(pozlar, vec![0]);
    }

    /// Net kare secime uyar; `rotate` tek seferlik istekte `all` gibi davranir.
    #[test]
    fn net_kare_secime_uyar() {
        let Some(ekranlar) = ekranlar_veya_atla() else {
            return;
        };
        match capture_frames_with(&MonitorSelection::Primary, None, SHARP_QUALITY) {
            Ok(frames) => {
                assert_eq!(frames.len(), 1);
                assert_eq!(&frames[0].jpeg[..2], &[0xFF, 0xD8], "JPEG SOI imzasi yok");
                let img = image::load_from_memory(&frames[0].jpeg).expect("decode edilemedi");
                let birincil = &ekranlar[birincil_pos(&ekranlar)].info;
                assert!(frames[0].jpeg.len() <= net_kare_butcesi(1));
                assert!(img.width() <= birincil.width && img.height() <= birincil.height);
                assert!(
                    img.width().max(img.height())
                        >= NET_MIN_KENAR.min(birincil.width.max(birincil.height))
                );
                eprintln!(
                    "[test] net kare: {}x{} → {} KB",
                    img.width(),
                    img.height(),
                    frames[0].jpeg.len() / 1024
                );
            }
            Err(e) => eprintln!("[test] net kare alinamadi (ortam kisiti olabilir): {e}"),
        }
        // `rotate` tek seferlik istekte `all` olur; digerleri aynen kalir.
        assert_eq!(
            sharp_selection(MonitorSelection::Rotate),
            MonitorSelection::All
        );
        assert_eq!(
            sharp_selection(MonitorSelection::Active),
            MonitorSelection::Active
        );
        assert_eq!(
            sharp_selection(MonitorSelection::List(vec![2])),
            MonitorSelection::List(vec![2])
        );
    }

    // --- SMITH_SCREEN_MONITORS ayristirmasi (env'e DOKUNMAZ: testler paralel
    // kosar, env yazmak yaris kosulu olurdu — bu yuzden saf fonksiyon test
    // ediliyor ve yakalama yollari secimi parametre olarak aliyor). ---

    #[test]
    fn secim_anahtar_kelimeleri_ayristirilir() {
        assert_eq!(parse_selection("primary"), MonitorSelection::Primary);
        assert_eq!(parse_selection("all"), MonitorSelection::All);
        assert_eq!(parse_selection("active"), MonitorSelection::Active);
        assert_eq!(parse_selection("rotate"), MonitorSelection::Rotate);
        // Bosluk ve buyuk/kucuk harf toleransi: env degerleri elle yazilir.
        assert_eq!(parse_selection("  ALL  "), MonitorSelection::All);
        assert_eq!(parse_selection("Active"), MonitorSelection::Active);
        assert_eq!(parse_selection("PrImArY"), MonitorSelection::Primary);
    }

    #[test]
    fn secim_listesi_ayristirilir_sirali_ve_tekrarsiz() {
        assert_eq!(parse_selection("1"), MonitorSelection::List(vec![1]));
        assert_eq!(parse_selection("1,2"), MonitorSelection::List(vec![1, 2]));
        assert_eq!(
            parse_selection(" 2 , 1 "),
            MonitorSelection::List(vec![1, 2])
        );
        assert_eq!(parse_selection("1,1,2"), MonitorSelection::List(vec![1, 2]));
        assert_eq!(
            parse_selection("3,1,2"),
            MonitorSelection::List(vec![1, 2, 3])
        );
        // Bozuk parca dusurulur, saglam olan kalir.
        assert_eq!(parse_selection("1,abc"), MonitorSelection::List(vec![1]));
        assert_eq!(parse_selection("1,0,2"), MonitorSelection::List(vec![1, 2]));
    }

    #[test]
    fn gecersiz_secim_guvenli_varsayilana_duser() {
        for raw in [
            "", "   ", "cop", "0", "-1", "1.5", ",", ",,,", "99999",
            "all,1", // karisik sozdizimi: "all" sayi degil → dusurulur, geriye 1 kalir
            "primary!", "🙂",
        ] {
            let s = parse_selection(raw);
            assert!(
                s == DEFAULT_SELECTION || matches!(s, MonitorSelection::List(_)),
                "gecersiz girdi {raw:?} beklenmeyen secime dustu: {s:?}"
            );
        }
        // Acikca varsayilan bekleyenler (liste bile olusturamayacak girdiler).
        for raw in [
            "", "   ", "cop", "0", "-1", ",", ",,,", "99999", "primary!", "🙂",
        ] {
            assert_eq!(
                parse_selection(raw),
                DEFAULT_SELECTION,
                "gecersiz girdi {raw:?} varsayilana dusmedi"
            );
        }
    }

    #[test]
    fn konum_etiketleri_monitor_sayisina_gore() {
        assert_eq!(konum_etiketi(1, 1), None);
        assert_eq!(konum_etiketi(1, 2).as_deref(), Some("sol"));
        assert_eq!(konum_etiketi(2, 2).as_deref(), Some("sag"));
        assert_eq!(konum_etiketi(2, 3).as_deref(), Some("soldan 2."));
        assert_eq!(konum_etiketi(3, 3).as_deref(), Some("soldan 3."));
    }
}

/// SUREKLI EKRAN AKISI bayragi: calisma zamaninda acilip kapanabilir.
///
/// NEDEN AYRI TIP: baslangic degeri env'den ("ilk erisimde") gelir ama
/// kullanici "ekranimi izle / izlemeyi birak" diyerek oturum ortasinda
/// degistirebilir. Baslangic kaynagi PARAMETRE: testler global ortam
/// degiskenine dokunmadan "ilk erisim" ve "ayarla" sirasini sinayabilir.
///
/// Siralama garantisi: `ayarla` ONCE baslangici tuketir. Aksi halde bir
/// `ayarla(false)` sonrasi gelen ilk `acik()` env'i okuyup kullanicinin
/// kararini ezerdi.
struct AkisBayragi {
    deger: std::sync::atomic::AtomicU64,
    ilk: Once,
}

impl AkisBayragi {
    const fn yeni() -> Self {
        Self {
            deger: std::sync::atomic::AtomicU64::new(0),
            ilk: Once::new(),
        }
    }

    fn baslat(&self, baslangic: impl FnOnce() -> bool) {
        self.ilk
            .call_once(|| self.deger.store(u64::from(baslangic()), Ordering::SeqCst));
    }

    fn acik(&self, baslangic: impl FnOnce() -> bool) -> bool {
        self.surum(baslangic) & 1 == 1
    }

    fn surum(&self, baslangic: impl FnOnce() -> bool) -> u64 {
        self.baslat(baslangic);
        self.deger.load(Ordering::SeqCst)
    }

    fn ayarla(&self, acik: bool, baslangic: impl FnOnce() -> bool) {
        self.baslat(baslangic);
        let _ = self
            .deger
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |eski| {
                if (eski & 1 == 1) == acik {
                    None
                } else {
                    Some(((eski & !1) + 2) | u64::from(acik))
                }
            });
    }
}

static AKIS: AkisBayragi = AkisBayragi::yeni();

/// Baslangic degeri: `SMITH_SCREEN` (varsayilan KAPALI, ekran icerigi buluta
/// gidiyor, acikca istenmeden gonderilmez).
fn akis_env_baslangici() -> bool {
    crate::env_flag::acik_varsayilan_kapali("SMITH_SCREEN")
}

/// Surekli ekran akisi su an ACIK mi. Ilk erisimde `SMITH_SCREEN` env'inden
/// baslar; sonra `akis_ayarla` ile degisir. Live oturumunun ekran dongusu her
/// tikta buna bakar (kapaliyken yakalama yapmaz).
///
/// IMZA SABIT: arayuz katmani cagiriyor.
/// Dusuk bit acik/kapali; ust bitler her degisimde ilerler. Eski capture
/// kapatip yeniden acma sonrasinda da gecersizdir.
pub fn akis_surumu() -> u64 {
    AKIS.surum(akis_env_baslangici)
}

pub fn akis_acik() -> bool {
    AKIS.acik(akis_env_baslangici)
}

/// Surekli ekran akisini acar/kapatir (kullanici karari, `ekran_akisi` araci
/// ya da arayuz dugmesi). Degisim oturumdaki ekran dongusunden
/// `EKRAN_AKISI_DURUMU` olayiyla UI'a bildirilir (en gec ~500 ms icinde).
///
/// IMZA SABIT: arayuz katmani cagiriyor.
pub fn akis_ayarla(acik: bool) {
    AKIS.ayarla(acik, akis_env_baslangici)
}

/// Ekran akisi acik mi. Eski ad (`SMITH_SCREEN` bayragi) korunuyor: `lib.rs`
/// Live baglandiginda `audio://screen` olayinin `aktif` alanini bununla
/// uretiyor (`audio::screen_enabled`); artik CALISMA ZAMANI durumunu verir.
pub fn enabled() -> bool {
    akis_acik()
}

#[cfg(test)]
mod akis_testleri {
    use super::*;

    #[test]
    fn ilk_erisim_baslangic_degerini_kullanir_bir_kez() {
        let b = AkisBayragi::yeni();
        assert!(b.acik(|| true), "baslangic true iken ilk okuma true olmali");
        // Baslangic kaynagi bir daha CAGRILMAZ: ayarlanmis deger ezilmez.
        b.ayarla(false, || panic!("baslangic ikinci kez cagrildi"));
        assert!(!b.acik(|| panic!("baslangic ikinci kez cagrildi")));
    }

    #[test]
    fn varsayilan_kapali_baslangic_kapali_okunur() {
        let b = AkisBayragi::yeni();
        assert!(!b.acik(|| false));
    }

    #[test]
    fn ayarla_baslangictan_once_gelirse_baslangic_kullanici_kararini_ezmez() {
        let b = AkisBayragi::yeni();
        // Env "acik" diyor ama kullanici ilk islem olarak kapatti.
        b.ayarla(false, || true);
        assert!(!b.acik(|| true), "ilk okuma env'i okuyup karari ezdi");
        b.ayarla(true, || true);
        assert!(b.acik(|| false));
    }

    #[test]
    fn kapatip_acmak_eski_capture_surumunu_gecersiz_kilar() {
        let b = AkisBayragi::yeni();
        let eski = b.surum(|| true);
        b.ayarla(true, || false);
        assert_eq!(b.surum(|| false), eski, "ayni deger surumu degistirmez");
        b.ayarla(false, || false);
        assert_eq!(b.surum(|| false) & 1, 0);
        b.ayarla(true, || false);
        assert!(b.acik(|| false));
        assert_ne!(b.surum(|| false), eski);
    }

    // GLOBAL bayrak (`akis_acik` / `akis_ayarla` / `enabled`) testi bilincli
    // olarak burada DEGIL `live.rs`te (`ekran_akisi_araci_bayragi_cevirir`):
    // paralel kosan testler tek global bayragi paylasir, dokunan test TEK olmali.
}

/// Kareler arasi bekleme (ms). `SMITH_SCREEN_INTERVAL_MS` ile ayarlanir.
pub fn interval_ms() -> u64 {
    std::env::var("SMITH_SCREEN_INTERVAL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v| *v >= 500) // 500 ms alti kotayi bosa yakar
        .unwrap_or(2000)
}
