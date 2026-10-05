//! Hatirlatma teslim dongusu: gateway'deki vadesi gelmis hatirlatmalari yoklar ve
//! her biri icin Windows bildirimi + sesli sistem bildirimi verip teslimi isaretler.
//!
//! Kayit ve teslim kirasi gateway'dedir (`/v1/tools/reminders`): `GET /due`
//! kayitlari 120 sn'lik atomik kira ile verir, `POST /:id/delivered` kirayi
//! kapatir. Bu modul yalniz yoklar: teslim isareti basarisiz olursa kayit kira
//! dolunca yeniden gelir; ayni surecte ikinci kez SOYLENMEZ (`Defter`), yalniz
//! teslim isareti yeniden denenir. Kurma/listeleme/iptal Live araclaridadir
//! (`audio::live::tools`).

use std::collections::VecDeque;
use std::time::Duration;

use crate::gateway::GatewayClient;

/// Yoklama araligi. Kira 120 sn: teslim isareti kacsa bile birkac yoklama icinde
/// kayit yine gorunur olmaz, kira dolunca gelir.
const YOKLAMA_ARALIGI: Duration = Duration::from_secs(20);
/// Duyurulan kimliklerin hatirlandigi en cok sayi (en eskisi duser).
const DEFTER_TAVANI: usize = 256;
/// Bir bildirimin gosterecegi en cok karakter (Windows bildirim govdesi kisadir).
const TOAST_MAX_KARAKTER: usize = 200;
const TOAST_ZAMAN_ASIMI: Duration = Duration::from_secs(8);

/// Gateway'in teslim kirasiyla verdigi, vadesi gelmis hatirlatma.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Vadesi {
    id: String,
    metin: String,
    claim_token: String,
}

/// Gateway'in bu modulun kullandigi iki ucu. Testte sahtesi yazilir.
trait Gateway {
    fn vadesi_gelenler(&self) -> Result<Vec<Vadesi>, String>;
    fn teslim_isaretle(&self, id: &str, claim_token: &str) -> Result<(), String>;
}

impl Gateway for GatewayClient {
    fn vadesi_gelenler(&self) -> Result<Vec<Vadesi>, String> {
        self.get("/v1/tools/reminders/due")
            .map(|yanit| vadesi_ayristir(&yanit))
    }

    fn teslim_isaretle(&self, id: &str, claim_token: &str) -> Result<(), String> {
        self.post(
            &format!("/v1/tools/reminders/{id}/delivered"),
            &serde_json::json!({ "claimToken": claim_token }),
        )
        .map(|_| ())
    }
}

/// `{"reminders":[{id, text, claimToken, ...}]}` yanitini kayitlara cevirir. Alani
/// eksik kayit atlanir (teslim isaretlenemez, duyurmak tekrar duyurmaya yol acar).
fn vadesi_ayristir(yanit: &serde_json::Value) -> Vec<Vadesi> {
    yanit["reminders"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|k| {
            let alan = |ad: &str| k[ad].as_str().filter(|s| !s.is_empty()).map(str::to_string);
            Some(Vadesi {
                id: alan("id")?,
                metin: alan("text")?,
                claim_token: alan("claimToken")?,
            })
        })
        .collect()
}

/// Bu surecte duyurulmus hatirlatma kimlikleri. Kira dolup kayit yeniden geldiginde
/// ikinci kez soylememenin tek kaynagi.
#[derive(Default)]
struct Defter {
    duyurulan: VecDeque<String>,
}

impl Defter {
    fn var_mi(&self, id: &str) -> bool {
        self.duyurulan.iter().any(|d| d == id)
    }

    fn ekle(&mut self, id: String) {
        if self.duyurulan.len() >= DEFTER_TAVANI {
            self.duyurulan.pop_front();
        }
        self.duyurulan.push_back(id);
    }
}

/// Bir yoklamanin ozeti (log ve test icin).
#[derive(Debug, Default, PartialEq, Eq)]
struct TurSonucu {
    duyurulan: usize,
    /// Daha once duyurulmus, yalniz teslim isareti yeniden denenen kayit sayisi.
    atlanan: usize,
    isaretlenemeyen: usize,
    /// Gateway'e ulasilamadi / yanit okunamadi: hicbir sey duyurulmaz.
    hata: Option<String>,
}

/// Tek yoklama: vadesi gelenleri al; her kayit icin SIRA: duyur (kayit duyurulduysa
/// bir daha duyurulmaz) -> deftere yaz -> teslimi isaretle. Duyuru isaretten ONCE:
/// cokus aninda hatirlatma kaybolmaz (en kotu halde tekrar gelir). Gateway hatasinda
/// hicbir sey yapilmaz, sonraki yoklama yeniden dener.
fn tur(kaynak: &impl Gateway, defter: &mut Defter, duyur: &mut impl FnMut(&Vadesi)) -> TurSonucu {
    let mut sonuc = TurSonucu::default();
    let kayitlar = match kaynak.vadesi_gelenler() {
        Ok(k) => k,
        Err(e) => {
            sonuc.hata = Some(e);
            return sonuc;
        }
    };
    for kayit in kayitlar {
        if defter.var_mi(&kayit.id) {
            sonuc.atlanan += 1;
        } else {
            duyur(&kayit);
            defter.ekle(kayit.id.clone());
            sonuc.duyurulan += 1;
        }
        if let Err(e) = kaynak.teslim_isaretle(&kayit.id, &kayit.claim_token) {
            sonuc.isaretlenemeyen += 1;
            eprintln!("[hatirlatma] teslim isaretlenemedi ({}): {e}", kayit.id);
        }
    }
    sonuc
}

/// Gateway durum gecisinin log satiri: kapaliyken her yoklamada degil, YALNIZ
/// kesinti basinda ve donuste yazilir (20 sn'de bir satir gunluk dosyayi doldurur).
fn gecis_logu(kesintide: &mut bool, sonuc: &TurSonucu) -> Option<String> {
    match (&sonuc.hata, *kesintide) {
        (Some(hata), false) => {
            *kesintide = true;
            Some(format!(
                "[hatirlatma] gateway'e ulasilamiyor ({hata}); sessizce yeniden denenecek"
            ))
        }
        (None, true) => {
            *kesintide = false;
            Some("[hatirlatma] gateway'e yeniden ulasildi".to_string())
        }
        _ => None,
    }
}

/// Duyuru: Windows bildirimi + sesli sistem bildirimi. Bildirim basarisiz olsa da
/// sesli bildirim kuyruga girer (ikisi birbirinden bagimsiz).
fn duyur(kayit: &Vadesi) {
    if let Err(e) = toast_goster("Hatirlatma", &kayit.metin) {
        eprintln!(
            "[hatirlatma] masaustu bildirimi gosterilemedi ({}): {e}",
            kayit.id
        );
    }
    // Oncelikli: kullanicinin bilerek kurdugu uyari oyun modunu (isimle) da deler.
    crate::audio::sistem_bildirimi_oncelikli(format!("Hatirlatma: {}", kayit.metin));
    eprintln!(
        "[hatirlatma] duyuruldu ({}, {} karakter)",
        kayit.id,
        kayit.metin.chars().count()
    );
}

/// Teslim dongusunu ayri bir thread'de baslatir. Blokleyici HTTP kullandigi icin
/// async gorev degil thread; pencere olusturmaz. `SMITH_REMINDERS=0` kapatir.
pub fn baslat() {
    if !crate::env_flag::acik_varsayilan_acik("SMITH_REMINDERS") {
        eprintln!("[hatirlatma] teslim dongusu kapali (SMITH_REMINDERS=0)");
        return;
    }
    let thread = std::thread::Builder::new()
        .name("smith-reminders".into())
        .spawn(|| {
            let gateway = GatewayClient::from_env();
            let mut defter = Defter::default();
            let mut kesintide = false;
            loop {
                let sonuc = tur(&gateway, &mut defter, &mut duyur);
                if let Some(satir) = gecis_logu(&mut kesintide, &sonuc) {
                    eprintln!("{satir}");
                }
                std::thread::sleep(YOKLAMA_ARALIGI);
            }
        });
    match thread {
        Ok(_) => eprintln!(
            "[hatirlatma] teslim dongusu basladi ({} sn aralik)",
            YOKLAMA_ARALIGI.as_secs()
        ),
        Err(e) => eprintln!("[hatirlatma] teslim dongusu baslatilamadi: {e}"),
    }
}

// ---------------------------------------------------------------------------
// WINDOWS BILDIRIMI
//
// Projede bildirim eklentisi yok; yeni bagimlilik (tauri-plugin-notification:
// WinRT/windows-core, cpal'in windows-core pini) yerine Windows PowerShell 5.1'in
// WinRT projeksiyonu kullanilir. Metin BETIGE GOMULMEZ: ortam degiskenleriyle
// gider ve betikte XML-kacisla (`SecurityElement.Escape`) okunur; betik sabittir,
// kullanici metni kabuk ya da XML enjeksiyonuna acik degildir. Betik
// `-EncodedCommand` ile gider (tirnak sorunu yok). PowerShell 7 WinRT'yi
// desteklemez: bilerek 5.1. Degisken adlari (`TOAST_*`) bilerek SMITH_ onekli
// degil: bunlar uygulamanin okudugu ayar degil alt surece giden bir boru, SMITH_*
// adlari ise scripts/smith-env-export-test.ps1 kapisina tabidir.
// ---------------------------------------------------------------------------

/// Bildirim XML'ini kurar (`$xml`). Gostermeden de calistirilabilir (test).
const TOAST_XML: &str = r#"$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$baslik = [System.Security.SecurityElement]::Escape($env:TOAST_BASLIK)
$metin = [System.Security.SecurityElement]::Escape($env:TOAST_METIN)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$baslik</text><text>$metin</text></binding></visual></toast>")
"#;

/// Windows PowerShell'in kayitli uygulama kimligi (AUMID): kendi baslatici
/// kaydi olmayan bir surec bildirim gosterebilsin diye.
const TOAST_GOSTER: &str = r#"$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show($toast)
"#;

/// Kontrol karakterleri (XML'de gecersiz olabilir) bosluga, bosluklar teklesir,
/// `TOAST_MAX_KARAKTER`de karakter sinirindan kirpilir. Tek satir kurali
/// `audio::live` icindeki `tek_satir` ile aynidir; o modulun disindan erisilmez.
fn toast_metni(metin: &str) -> String {
    let tek: String = metin
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if tek.chars().count() <= TOAST_MAX_KARAKTER {
        return tek;
    }
    let kisa: String = tek.chars().take(TOAST_MAX_KARAKTER - 3).collect();
    format!("{}...", kisa.trim_end())
}

#[cfg(windows)]
fn ps51_komutu(betik: &str, baslik: &str, metin: &str) -> std::process::Command {
    use base64::Engine as _;
    let kok = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    let yol = std::path::PathBuf::from(kok)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let utf16: Vec<u8> = betik.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut komut = std::process::Command::new(yol);
    komut
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand"])
        .arg(base64::engine::general_purpose::STANDARD.encode(utf16))
        .env("TOAST_BASLIK", toast_metni(baslik))
        .env("TOAST_METIN", toast_metni(metin));
    komut
}

#[cfg(windows)]
fn toast_goster(baslik: &str, metin: &str) -> Result<(), String> {
    let mut komut = ps51_komutu(&format!("{TOAST_XML}{TOAST_GOSTER}"), baslik, metin);
    crate::system_tools::run_bounded(&mut komut, TOAST_ZAMAN_ASIMI)
        .map(|_| ())
        .ok_or_else(|| "PowerShell bildirimi gosteremedi ya da zaman asimina ugradi".to_string())
}

#[cfg(not(windows))]
fn toast_goster(_baslik: &str, _metin: &str) -> Result<(), String> {
    Err("masaustu bildirimi yalniz Windows'ta".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn vadesi(id: &str, token: &str) -> Vadesi {
        Vadesi {
            id: id.into(),
            metin: format!("metin {id}"),
            claim_token: token.into(),
        }
    }

    /// Sahte gateway: yoklama yanitlari ve teslim isareti sonuclari sirayla verilir,
    /// yapilan isaretler kaydedilir.
    #[derive(Default)]
    struct Sahte {
        yoklamalar: RefCell<VecDeque<Result<Vec<Vadesi>, String>>>,
        isaret_sonuclari: RefCell<VecDeque<Result<(), String>>>,
        isaretler: RefCell<Vec<(String, String)>>,
    }

    impl Gateway for Sahte {
        fn vadesi_gelenler(&self) -> Result<Vec<Vadesi>, String> {
            self.yoklamalar
                .borrow_mut()
                .pop_front()
                .unwrap_or_else(|| Ok(Vec::new()))
        }

        fn teslim_isaretle(&self, id: &str, claim_token: &str) -> Result<(), String> {
            self.isaretler
                .borrow_mut()
                .push((id.to_string(), claim_token.to_string()));
            self.isaret_sonuclari
                .borrow_mut()
                .pop_front()
                .unwrap_or(Ok(()))
        }
    }

    fn calistir(sahte: &Sahte, defter: &mut Defter, duyurulan: &RefCell<Vec<String>>) -> TurSonucu {
        tur(sahte, defter, &mut |k: &Vadesi| {
            duyurulan.borrow_mut().push(k.id.clone())
        })
    }

    #[test]
    fn vadesi_gelen_once_duyurulur_sonra_teslim_isaretlenir() {
        let sahte = Sahte::default();
        sahte
            .yoklamalar
            .borrow_mut()
            .push_back(Ok(vec![vadesi("rem_a", "t1"), vadesi("rem_b", "t2")]));
        let duyurulan = RefCell::new(Vec::new());
        let mut defter = Defter::default();
        let mut sira = Vec::new();
        let sonuc = tur(&sahte, &mut defter, &mut |k: &Vadesi| {
            // Duyuru anina kadar hicbir kayit isaretlenmemis olmali.
            sira.push((k.id.clone(), sahte.isaretler.borrow().len()));
            duyurulan.borrow_mut().push(k.id.clone());
        });
        assert_eq!(
            sonuc,
            TurSonucu {
                duyurulan: 2,
                ..TurSonucu::default()
            }
        );
        assert_eq!(sira, vec![("rem_a".into(), 0), ("rem_b".into(), 1)]);
        assert_eq!(
            *sahte.isaretler.borrow(),
            vec![
                ("rem_a".to_string(), "t1".to_string()),
                ("rem_b".to_string(), "t2".to_string())
            ],
            "her kayit KENDI claimToken'i ile isaretlenir"
        );
    }

    /// Kira: teslim isareti kacarsa kayit kira dolunca YENI claimToken ile geri
    /// gelir; ayni surecte ikinci kez soylenmez, yalniz yeni token ile isaretlenir.
    #[test]
    fn kira_dolunca_geri_gelen_kayit_tekrar_soylenmez_yalniz_isaretlenir() {
        let sahte = Sahte::default();
        {
            let mut y = sahte.yoklamalar.borrow_mut();
            y.push_back(Ok(vec![vadesi("rem_a", "eski")]));
            // 120 sn kira boyunca (6 yoklama) gateway kaydi vermez.
            for _ in 0..6 {
                y.push_back(Ok(vec![]));
            }
            y.push_back(Ok(vec![vadesi("rem_a", "yeni")]));
        }
        sahte.isaret_sonuclari.borrow_mut().push_back(Err(
            "/v1/tools/reminders/rem_a/delivered cagrisi basarisiz".into(),
        ));
        let duyurulan = RefCell::new(Vec::new());
        let mut defter = Defter::default();

        let ilk = calistir(&sahte, &mut defter, &duyurulan);
        assert_eq!((ilk.duyurulan, ilk.isaretlenemeyen), (1, 1));
        for _ in 0..6 {
            assert_eq!(
                calistir(&sahte, &mut defter, &duyurulan),
                TurSonucu::default()
            );
        }
        let son = calistir(&sahte, &mut defter, &duyurulan);
        assert_eq!(
            (son.duyurulan, son.atlanan, son.isaretlenemeyen),
            (0, 1, 0),
            "ikinci kez duyurulmamali, yalniz isaretlenmeli"
        );
        assert_eq!(*duyurulan.borrow(), vec!["rem_a".to_string()]);
        assert_eq!(
            *sahte.isaretler.borrow(),
            vec![
                ("rem_a".to_string(), "eski".to_string()),
                ("rem_a".to_string(), "yeni".to_string())
            ]
        );
    }

    #[test]
    fn gateway_hatasinda_hicbir_sey_yapilmaz_sonraki_yoklama_dener() {
        let sahte = Sahte::default();
        {
            let mut y = sahte.yoklamalar.borrow_mut();
            y.push_back(Err("baglanti reddedildi".into()));
            y.push_back(Ok(vec![vadesi("rem_a", "t1")]));
        }
        let duyurulan = RefCell::new(Vec::new());
        let mut defter = Defter::default();

        let hata = calistir(&sahte, &mut defter, &duyurulan);
        assert_eq!(hata.hata.as_deref(), Some("baglanti reddedildi"));
        assert_eq!((hata.duyurulan, hata.atlanan), (0, 0));
        assert!(duyurulan.borrow().is_empty() && sahte.isaretler.borrow().is_empty());

        let duzeldi = calistir(&sahte, &mut defter, &duyurulan);
        assert_eq!((duzeldi.duyurulan, duzeldi.hata), (1, None));
    }

    #[test]
    fn bir_kaydin_isareti_kacarsa_digerleri_yine_duyurulur() {
        let sahte = Sahte::default();
        sahte
            .yoklamalar
            .borrow_mut()
            .push_back(Ok(vec![vadesi("rem_a", "t1"), vadesi("rem_b", "t2")]));
        sahte
            .isaret_sonuclari
            .borrow_mut()
            .push_back(Err("409".into()));
        let duyurulan = RefCell::new(Vec::new());
        let sonuc = calistir(&sahte, &mut Defter::default(), &duyurulan);
        assert_eq!((sonuc.duyurulan, sonuc.isaretlenemeyen), (2, 1));
        assert_eq!(
            sahte.isaretler.borrow().len(),
            2,
            "ikinci kayit da isaretlendi"
        );
    }

    #[test]
    fn defter_tavanda_en_eskiyi_unutur() {
        let mut d = Defter::default();
        for i in 0..DEFTER_TAVANI + 5 {
            d.ekle(format!("rem_{i}"));
        }
        assert_eq!(d.duyurulan.len(), DEFTER_TAVANI);
        assert!(!d.var_mi("rem_0") && !d.var_mi("rem_4"));
        assert!(d.var_mi("rem_5") && d.var_mi(&format!("rem_{}", DEFTER_TAVANI + 4)));
    }

    #[test]
    fn gateway_yaniti_ayristirilir_eksik_alanli_kayit_atlanir() {
        let yanit = serde_json::json!({ "reminders": [
            { "id": "rem_a", "text": "toplanti", "due_at": "x", "claimToken": "t1",
              "claimExpiresAt": "y", "due_at_yerel": "z" },
            { "id": "rem_b", "text": "", "claimToken": "t2" },
            { "id": "rem_c", "text": "claimToken yok" },
            { "text": "id yok", "claimToken": "t4" },
            { "id": 5, "text": "tip hatasi", "claimToken": "t5" },
        ]});
        assert_eq!(
            vadesi_ayristir(&yanit),
            vec![Vadesi {
                id: "rem_a".into(),
                metin: "toplanti".into(),
                claim_token: "t1".into(),
            }]
        );
        for bos in [
            serde_json::json!({}),
            serde_json::json!({ "reminders": null }),
            serde_json::json!({ "reminders": [] }),
            serde_json::json!([]),
        ] {
            assert!(vadesi_ayristir(&bos).is_empty(), "{bos}");
        }
    }

    #[test]
    fn gecis_logu_yalniz_kesinti_basinda_ve_donuste_yazilir() {
        let hata = TurSonucu {
            hata: Some("kapali".into()),
            ..TurSonucu::default()
        };
        let iyi = TurSonucu::default();
        let mut kesintide = false;
        assert_eq!(gecis_logu(&mut kesintide, &iyi), None);
        assert!(gecis_logu(&mut kesintide, &hata).is_some_and(|l| l.contains("kapali")));
        for _ in 0..5 {
            assert_eq!(gecis_logu(&mut kesintide, &hata), None, "tekrar loglanmaz");
        }
        assert!(gecis_logu(&mut kesintide, &iyi).is_some_and(|l| l.contains("yeniden ulasildi")));
        assert_eq!(gecis_logu(&mut kesintide, &iyi), None);
    }

    #[test]
    fn toast_metni_tek_satir_kisa_ve_xml_icin_temiz() {
        assert_eq!(
            toast_metni(" iki\n\nsatir\t ve  bosluk "),
            "iki satir ve bosluk"
        );
        assert_eq!(toast_metni("zil\u{7}karakteri"), "zil karakteri");
        assert_eq!(toast_metni(" \n "), "");
        let uzun = toast_metni(&"ş".repeat(TOAST_MAX_KARAKTER * 2));
        assert_eq!(uzun.chars().count(), TOAST_MAX_KARAKTER);
        assert!(uzun.ends_with("..."));
    }

    #[test]
    fn toast_betigi_sabittir_metin_betige_degil_ortama_gider() {
        // Betik sabit bir sabittir: kullanici metni yalniz iki ortam degiskeni olarak
        // okunur ve XML'e kacisla girer; baska hicbir yerden betige karismaz.
        assert!(TOAST_XML.contains("[System.Security.SecurityElement]::Escape($env:TOAST_BASLIK)"));
        assert!(TOAST_XML.contains("[System.Security.SecurityElement]::Escape($env:TOAST_METIN)"));
        assert_eq!(TOAST_XML.matches("$env:").count(), 2);
        assert_eq!(TOAST_GOSTER.matches("$env:").count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn toast_komutu_betigi_kodlar_ve_metni_ortama_koyar() {
        use base64::Engine as _;
        let komut = ps51_komutu("Write-Output 'x'", "Baslik", "Gövde ç ş");
        let args: Vec<String> = komut
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            &args[..3],
            ["-NoProfile", "-NonInteractive", "-EncodedCommand"]
        );
        let ham = base64::engine::general_purpose::STANDARD
            .decode(&args[3])
            .expect("base64");
        let utf16: Vec<u16> = ham
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        assert_eq!(String::from_utf16(&utf16).unwrap(), "Write-Output 'x'");
        let ortam: std::collections::HashMap<_, _> = komut
            .get_envs()
            .filter_map(|(k, v)| {
                Some((
                    k.to_string_lossy().into_owned(),
                    v?.to_string_lossy().into_owned(),
                ))
            })
            .collect();
        assert_eq!(ortam["TOAST_BASLIK"], "Baslik");
        assert_eq!(ortam["TOAST_METIN"], "Gövde ç ş");
    }

    /// CANLI PowerShell 5.1, bildirim GOSTERILMEZ: betigin XML kurulum yarisi ozel
    /// karakterli metinle calisir, XML'den okunan metin girdiyle birebir ayni olmali
    /// (kacis dogru, Unicode korunuyor, enjeksiyon yok). Gosterim yarisi
    /// (`TOAST_GOSTER`) yalniz sozdizimi icin ayristirilir.
    #[cfg(windows)]
    #[test]
    fn toast_xml_ozel_karakterleri_kacirir_gostermeden_dogrulanir() {
        use base64::Engine as _;
        let baslik = "Hatirlatma & <b>kalin</b>";
        let metin = "Cihan'in \"tirnakli\" <metni> & ç ş ğ ü ö ı İ ]]> ' $(Get-Date) `n";
        let betik = format!(
            "{TOAST_XML}$t = $xml.GetElementsByTagName('text')\n\
             $cikti = $t.Item(0).InnerText + [char]10 + $t.Item(1).InnerText\n\
             [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($cikti)))"
        );
        let mut komut = ps51_komutu(&betik, baslik, metin);
        let (stdout, _) = crate::system_tools::run_bounded(&mut komut, Duration::from_secs(30))
            .expect("PowerShell 5.1 calismadi ya da XML kurulamadi");
        let cozulen = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(stdout.trim())
                .expect("base64"),
        )
        .unwrap();
        let (b, m) = cozulen.split_once('\n').expect("iki metin");
        assert_eq!(b, toast_metni(baslik));
        assert_eq!(m, toast_metni(metin));

        // Gosterim yarisi gecerli PowerShell mi: calistirilmadan ayristirilir. Hedef
        // betik ayri bir ortam degiskeniyle gelir (`ps51_komutu` metni tek satira indirir).
        let ayristir = "$t = $null; $e = $null; \
             [void][System.Management.Automation.Language.Parser]::ParseInput(\
             $env:SMITH_PARSE_HEDEF, [ref]$t, [ref]$e); if ($e.Count -gt 0) { exit 1 }";
        let mut komut = ps51_komutu(ayristir, "x", "x");
        komut.env("SMITH_PARSE_HEDEF", TOAST_GOSTER);
        assert!(
            crate::system_tools::run_bounded(&mut komut, Duration::from_secs(30)).is_some(),
            "TOAST_GOSTER PowerShell sozdizimi gecersiz"
        );
        let mut bozuk = ps51_komutu(ayristir, "x", "x");
        bozuk.env("SMITH_PARSE_HEDEF", "$x = (");
        assert!(
            crate::system_tools::run_bounded(&mut bozuk, Duration::from_secs(30)).is_none(),
            "ayristirici bozuk betigi yakalamali (test kendini sinar)"
        );
    }
}
