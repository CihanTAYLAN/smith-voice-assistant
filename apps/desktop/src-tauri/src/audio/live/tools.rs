//! Arac bildirimleri ve dispatch.

use super::conversation::{konusma_eki, konusma_hafizasi_acik, KONUSMA_LIMIT, KONUSMA_MAX_CHARS};
use super::memory_gap;
use super::microphone::{dinleme_ayarla, dinleme_kipi, dinleme_olayi, DinlemeKipi};
use super::profil;
use super::LiveEvent;
use std::sync::Arc;
use tokio::sync::mpsc;

/// `LiveEvent::Tool.durum` degerleri. Tek yerde tanimli: UI bunlari birebir
/// okuyor, serbest metin olsaydi yazim hatasi sessizce gorunmez bir durum
/// uretirdi.
pub(super) const TOOL_BASLADI: &str = "basladi";
pub(super) const TOOL_BITTI: &str = "bitti";
pub(super) const TOOL_REDDEDILDI: &str = "reddedildi";
/// `LiveEvent::Tool.durum` icin dorduncu deger, YALNIZ `LIVE_BAGLANTI` ile:
/// baglanti PLANSIZ kapandi, `sebep` insan okunur ozet (sinif, sunucunun kod ve
/// sebebi, bir sonraki denemeye kalan sure).
///
/// NEDEN `Tool` KANALI: `lib.rs` `LiveEvent` uzerinde exhaustive match yapiyor;
/// yeni bir varyant eklemek o dosyayi da degistirmeyi gerektirir. Mevcut kanal
/// `audio://tool` olarak UI'a zaten gidiyor ve bilinmeyen `durum`u iki tuketici
/// de yok sayar (`useLiveVoice.onTool`: "bilinmeyen durum: yok say";
/// `mindBubbles.toolThought`: `null`), yani eski UI bu olayla bozulmaz, yeni UI
/// `ad === 'live_baglanti'` dalini ekleyince hatayi gosterir. `reddedildi`
/// KULLANILMAZ: UI onu "ses izi dogrulanmadi" diye okur ve yanlis konusur.
pub(super) const TOOL_HATA: &str = "hata";

/// derin_dusun sonucu WHEN_IDLE ile bildirilir. Kod araci hizla run_id verir;
/// bu kimlik modele teslim edilmeden sonraki tura gecilmez.
/// Diger araclar acikca BLOCKING kalir (live-tools ve FunctionResponse semasi).
const ARAC_DAVRANISI: &str = "BLOCKING";

pub(super) fn arac_davranisi(ad: &str) -> &'static str {
    arac_bilgisi(ad).map_or(ARAC_DAVRANISI, |a| a.davranis)
}

/// Ad, etiket, ses izi sinifi, calisma davranisi ve sema tek tablodan turer.
/// Dispatch exhaustive kalir; yeni varyant icin isleyici yazmak zorunludur.
macro_rules! arac_tablosu {
    ($( $varyant:ident => ($ad:literal, $etiket:literal, $sinif:ident, $davranis:literal, [$($alias:literal),*], $sema:tt) ),* $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub(super) enum Arac { $($varyant),* }
        impl Arac {
            const HEPSI: &'static [Self] = &[$(Self::$varyant),*];
            pub(super) fn ad(self) -> &'static str { self.metadata().ad }
            const fn metadata(self) -> &'static AracBilgisi { &ARACLAR[self as usize] }
        }
        const ARACLAR: &[AracBilgisi] = &[$(AracBilgisi {
            ad: $ad, etiket: $etiket, sinif: SesSinifi::$sinif,
            davranis: $davranis, aliases: &[$($alias),*],
        }),*];
        pub(super) fn tool_declarations() -> serde_json::Value {
            let mut declarations = Vec::new();
            $(
                let mut declaration = serde_json::json!($sema);
                declaration["name"] = serde_json::json!($ad);
                declaration["behavior"] = serde_json::json!($davranis);
                declarations.push(declaration);
            )*
            serde_json::json!([{"functionDeclarations": declarations}])
        }
    };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SesSinifi {
    DusukRisk,
    Hafiza,
    PanoOkuma,
    HassasOkuma,
    Kod,
    Mission,
    Ekran,
    Dinleme,
    NoForeign,
}

pub(crate) struct AracBilgisi {
    ad: &'static str,
    etiket: &'static str,
    pub(crate) sinif: SesSinifi,
    davranis: &'static str,
    aliases: &'static [&'static str],
}

pub(crate) fn arac_bilgisi(ad: &str) -> Option<&'static AracBilgisi> {
    ARACLAR
        .iter()
        .find(|a| a.ad == ad || a.aliases.contains(&ad))
}

pub(crate) fn tool_labels() -> std::collections::BTreeMap<&'static str, &'static str> {
    ARACLAR
        .iter()
        .flat_map(|a| {
            std::iter::once((a.ad, a.etiket)).chain(a.aliases.iter().map(|ad| (*ad, a.etiket)))
        })
        .collect()
}

arac_tablosu! {
    HafizadaAra => ("hafizada_ara", "hafızada arıyor…", DusukRisk, "BLOCKING", [], {
        "description": "Cihan hakkinda kayitli gecmis bilgiyi arar.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "sorgu": { "type": "STRING" }
            },
            "required": ["sorgu"]
        }
    }),
    HafizayaKaydet => ("hafizaya_kaydet_ACIK_TALEP_ILE", "hafızaya yazıyor…", Hafiza, "BLOCKING", ["hafizaya_kaydet"], {
        "description": "Kalici not. Yalniz Cihan acikca hatirla/kaydet/not al derse; cikarim veya baskasinin sozunu kaydetme.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "icerik": {
                    "type": "STRING",
                    "description": "Tam, baglamli tek cumle"
                }
            },
            "required": ["icerik"]
        }
    }),
    TerminalCalistir => ("terminal_calistir", "komut çalıştırıyor…", NoForeign, "BLOCKING", [], {
        "description": "PowerShell. onay_gerekiyor ise sor; sonra AYNI komutu onay=true yolla. Uzun is/GUI arka_planda=true, sonucu is_id ile oku. Kod tarama/test/derleme icin kod_gorevi_ver.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "komut": { "type": "STRING" },
                "onay": { "type": "BOOLEAN", "description": "Varsayilan false; onay_gerekiyor sonrasi Cihan acikca onayladiysa true" },
                "arka_planda": {
                    "type": "BOOLEAN",
                    "description": "Uzun is/GUI icin true"
                },
                "sure_sn": { "type": "INTEGER", "minimum": 5, "maximum": 300,
                    "description": "5-300 sn; varsayilan 20" }
            },
            "required": ["komut"]
        }
    }),
    UygulamaAc => ("uygulama_ac", "uygulama açıyor…", NoForeign, "BLOCKING", [], {
        "description": "Uygulama, dosya, klasor veya URL acar.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "ad": { "type": "STRING" }
            },
            "required": ["ad"]
        }
    }),
    SistemDurumu => ("sistem_durumu", "sistemi kontrol ediyor…", DusukRisk, "BLOCKING", [], {
        "description": "CPU, RAM, GPU, disk, pil, OS ve acik kalma durumunu okur.",
        "parameters": { "type": "OBJECT", "properties": {} }
    }),
    SesKontrol => ("ses_kontrol", "ses ayarını değiştiriyor…", NoForeign, "BLOCKING", [], {
        "description": "Bilgisayarin ana sesini oku/ayarla/sustur/ac; Smith'in sesi degil.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "islem": { "type": "STRING", "description": "oku | ayarla | sustur | ac" },
                "deger": { "type": "NUMBER", "description": "ayarla: 0-100" }
            },
            "required": ["islem"]
        }
    }),
    EkraniNetGor => ("ekrani_net_gor", "ekranı okuyor…", DusukRisk, "BLOCKING", [], {
        "description": "Net ekran karesi. Yazi/kod/hata icin cagir; cok ekranda secimi ver, ad tahmin etme.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "ekran": {
                    "type": "STRING",
                    "description": "odak, sol, sag, hepsi, birincil veya indeks"
                }
            }
        }
    }),
    DosyaAra => ("dosya_ara", "dosya arıyor…", DusukRisk, "BLOCKING", [], {
        "description": "Bilgisayarda ad/desenle dosya arar; hassas ve gurultu klasorleri haric.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "desen": { "type": "STRING" },
                "klasor": { "type": "STRING", "description": "Bos ise kullanici klasoru" }
            },
            "required": ["desen"]
        }
    }),
    DosyaOku => ("dosya_oku", "dosya okuyor…", DusukRisk, "BLOCKING", [], {
        "description": "Metin dosyasini tam yoldan okur; yolu bilmiyorsan once dosya_ara.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "yol": { "type": "STRING" }
            },
            "required": ["yol"]
        }
    }),
    DerinDusun => ("derin_dusun", "derin düşünüyor…", NoForeign, "NON_BLOCKING", [], {
        "description": "Zor matematik/mantik/tasarim/karar icin guclu modele sor; sonucu kisa aktar, ic isleyisi anlatma.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "soru": {
                    "type": "STRING",
                    "description": "Tam, baglamli soru"
                }
            },
            "required": ["soru"]
        }
    }),
    InternetteAra => ("internette_ara", "internette arıyor…", DusukRisk, "BLOCKING", [], {
        "description": "Guncel/degisken bilgiyi Internette arar; tahmin etme.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "sorgu": { "type": "STRING" }
            },
            "required": ["sorgu"]
        }
    }),
    WebSayfaOku => ("web_sayfa_oku", "sayfayı okuyor…", DusukRisk, "BLOCKING", [], {
        "description": "http(s) sayfasini duz metin olarak okur.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "adres": { "type": "STRING" }
            },
            "required": ["adres"]
        }
    }),
    AcikUygulamalar => ("acik_uygulamalar", "açık pencerelere bakıyor…", DusukRisk, "BLOCKING", [], {
        "description": "Acik pencereli uygulamalari ve RAM kullanimini listeler.",
        "parameters": { "type": "OBJECT", "properties": {} }
    }),
    AjanOturumlari => ("ajan_oturumlari", "kod oturumlarına bakıyor…", HassasOkuma, "BLOCKING", [], {
        "description": "Claude Code/Codex oturum meta verisi. Gerekirse icerik=true yalniz Cihan'in isteklerini getirir.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "kaynak": {
                    "type": "STRING",
                    "description": "claude | codex | hepsi"
                },
                "adet": {
                    "type": "NUMBER",
                    "description": "varsayilan 8, en fazla 20"
                },
                "icerik": {
                    "type": "BOOLEAN",
                    "description": "Yalniz gerekirse true"
                }
            }
        }
    }),
    KodGoreviVer => ("kod_gorevi_ver", "kendi kodunu düzenliyor…", Kod, "BLOCKING", [], {
        "description": "Kod tarama/test/derleme/degisikligi izole worktree'de yapar. run_id baslangictir; host dogrulamasi varsayilan KAPALIDIR, sonucu kod_gorevi_durum ile oku. Merge/push yok.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "gorev": {
                    "type": "STRING",
                    "description": "Istek, kapsam, beklenen sonuc; ajan konusmayi GORMEZ"
                },
                "ad": {
                    "type": "STRING",
                    "description": "2-4 kelimelik is adi"
                },
                "dosyalar": {
                    "type": "STRING",
                    "description": "SERT IZIN LISTESI: virgullu canonical repo-goreli yollar; verilirse baska dosyayi degistiremez, bossa repo geneli"
                }
            },
            "required": ["gorev", "ad"]
        }
    }),
    KodGoreviDurum => ("kod_gorevi_durum", "kod görevinin durumunu okuyor…", Kod, "BLOCKING", [], {
        "description": "run_id kaydini SALT OKUNUR getirir; BASLATMAZ. Kayit canli PID DEGILDIR; editing/preparing calisiyor kaniti sayilmaz.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "run_id": {
                    "type": "STRING",
                    "description": "kod_gorevi_ver run_id"
                }
            },
            "required": ["run_id"]
        }
    }),
    GorevVer => ("gorev_ver", "panoya görev yazıyor…", Mission, "BLOCKING", [], {
        "description": "Panoya gorev yazar. ajan verilirse kosu/harcama baslar. Cihan ajan soylemediyse sahipsiz birak ve sor. Kendi kodun icin kod_gorevi_ver.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "baslik": {
                    "type": "STRING",
                    "description": "3-200 karakter"
                },
                "ayrinti": {
                    "type": "STRING",
                    "description": "Ajan konusmayi GORMEZ; kapsam ve sonucu yaz"
                },
                "ajan": {
                    "type": "STRING",
                    "description": "Ajan slug; VERILIRSE kosu baslar. Bilmiyorsan ekip_listesi"
                },
                "oncelik": {
                    "type": "NUMBER",
                    "description": "1 yuksek, 2 normal, 3 dusuk"
                }
            },
            "required": ["baslik"]
        }
    }),
    PanoDurumu => ("pano_durumu", "ekip panosuna bakıyor…", PanoOkuma, "BLOCKING", [], {
        "description": "Pano durum sayilari, INCELEME, engeller, calisan ajanlar ve gorev id'leri. Sayilari OLDUGU GIBI aktar.",
        "parameters": { "type": "OBJECT", "properties": {} }
    }),
    GorevDurum => ("gorev_durum", "görev durumunu değiştiriyor…", Mission, "BLOCKING", [], {
        "description": "Gorevi inbox/review/done/blocked yapar. assigned ve in_progress bu aracta HEDEF OLAMAZ; atama gorev_ata (gorev_ver.ajan). id pano_durumu'ndan.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "gorev_id": {
                    "type": "STRING",
                    "description": "tsk_ kimligi"
                },
                "durum": {
                    "type": "STRING",
                    "description": "inbox | review | done | blocked; atama gorev_ata"
                }
            },
            "required": ["gorev_id", "durum"]
        }
    }),
    YorumEkle => ("yorum_ekle", "göreve not yazıyor…", Mission, "BLOCKING", [], {
        "description": "Gorev thread'ine not yazar; @slug ajana seslenir.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "gorev_id": {
                    "type": "STRING",
                    "description": "tsk_ kimligi"
                },
                "metin": { "type": "STRING" }
            },
            "required": ["gorev_id", "metin"]
        }
    }),
    EkipListesi => ("ekip_listesi", "ekibe bakıyor…", PanoOkuma, "BLOCKING", [], {
        "description": "Ekip slug/rol/cihaz/durum listesi; atama oncesi slug'i al. Bossa uydurma.",
        "parameters": { "type": "OBJECT", "properties": {} }
    }),
    EkranAkisi => ("ekran_akisi", "ekran akışını ayarlıyor…", Ekran, "BLOCKING", [], {
        "description": "SUREKLI ekran izleme; varsayilan KAPALI. Tek bakis icin ekrani_net_gor. acik=true baslatir, false durdurur; token harcar.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "acik": {
                    "type": "BOOLEAN",
                    "description": "true ac, false kapat"
                }
            },
            "required": ["acik"]
        }
    }),
    ArkaPlanSonuc => ("arka_plan_sonuc", "arka plan sonucunu okuyor…", HassasOkuma, "BLOCKING", [], {
        "description": "Arka plan isini is_id ile okur; calisiyor bitmis degildir.",
        "parameters": { "type": "OBJECT", "properties": {
            "is_id": { "type": "STRING" }
        }, "required": ["is_id"] }
    }),
    DinlemeModu => ("dinleme_modu", "dinleme modunu ayarlıyor…", Dinleme, "BLOCKING", [], {
        "description": "Yerel ses gizlilik modu: herkes, yalniz_beni veya oyun icin isimle.",
        "parameters": { "type": "OBJECT", "properties": {
            "kip": { "type": "STRING", "enum": ["herkes", "yalniz_beni", "isimle"] },
            "yalniz_beni": { "type": "BOOLEAN", "description": "Eski istemci uyumu" }
        } }
    }),
    ArkaPlanIptal => ("arka_plan_iptal", "arka plan işini durduruyor…", NoForeign, "BLOCKING", [], {
        "description": "Arka plan isini is_id ile durdurur.",
        "parameters": { "type": "OBJECT", "properties": {
            "is_id": { "type": "STRING" }
        }, "required": ["is_id"] }
    }),
    HatirlatmaKur => ("hatirlatma_kur", "hatırlatma kuruyor…", Hafiza, "BLOCKING", [], {
        "description": "Hatirlatma. Goreli icin sure_dakika, masaustu GUNCEL saati kullanir. MUTLAK zaman ofsetli ISO 8601 Europe/Istanbul. Belirsizse tek kisa soru; arac yanitini teyit et.",
        "parameters": { "type": "OBJECT", "properties": {
            "metin": { "type": "STRING", "description": "En fazla 500 karakter" },
            "zaman": { "type": "STRING", "description": "Ofsetli ISO 8601" },
            "sure_dakika": { "type": "INTEGER", "minimum": 1, "maximum": 525600 }
        }, "required": ["metin"] }
    }),
    HatirlatmalariListele => ("hatirlatmalari_listele", "hatırlatmalara bakıyor…", NoForeign, "BLOCKING", [], {
        "description": "Bekleyen hatirlatmalarin id, metin ve yerel zamanini listeler; iptal id'sini buradan al.",
        "parameters": { "type": "OBJECT", "properties": {} }
    }),
    HatirlatmaIptal => ("hatirlatma_iptal", "hatırlatmayı iptal ediyor…", Hafiza, "BLOCKING", [], {
        "description": "Bekleyen hatirlatmayi iptal eder. rem_ id'yi listeden al, UYDURMA; belirsizse sor.",
        "parameters": { "type": "OBJECT", "properties": {
            "id": { "type": "STRING", "description": "rem_ kimligi" }
        }, "required": ["id"] }
    }),
    ProfilKaydet => ("profil_kaydet", "profile yazıyor…", Hafiza, "BLOCKING", [], {
        "description": "KALICI kisisel bilgi. Yalniz ACIKCA kaydet derse; cikarim KAYDETME. ASCII kucuk harf. Kisisel: profil_kaydet; olay/not: hafizaya_kaydet.",
        "parameters": { "type": "OBJECT", "properties": {
            "anahtar": { "type": "STRING", "description": "ASCII kucuk harf/rakam/_, 2-40" },
            "deger": { "type": "STRING", "description": "Tek satir, en fazla 300" }
        }, "required": ["anahtar", "deger"] }
    }),
    ProfilSil => ("profil_sil", "profilden siliyor…", Hafiza, "BLOCKING", [], {
        "description": "Profil bilgisini siler. YALNIZ acik istekte; anahtari profilden al, UYDURMA.",
        "parameters": { "type": "OBJECT", "properties": {
            "anahtar": { "type": "STRING" }
        }, "required": ["anahtar"] }
    }),
    HafizaSorusuCevapla => ("hafiza_sorusu_cevapla", "hafıza cevabını yazıyor…", Hafiza, "BLOCKING", [], {
        "description": "Acik hafiza sorusunun cevabini kaydeder.",
        "parameters": { "type": "OBJECT", "properties": {
            "id": { "type": "STRING" },
            "cevap": { "type": "STRING" }
        }, "required": ["id", "cevap"] }
    }),
    HafizaSorusuGec => ("hafiza_sorusu_gec", "hafıza sorusunu geçiyor…", Hafiza, "BLOCKING", [], {
        "description": "Hafiza sorusunu erteler; kalici=true kapatir.",
        "parameters": { "type": "OBJECT", "properties": {
            "id": { "type": "STRING" },
            "kalici": { "type": "BOOLEAN" }
        }, "required": ["id", "kalici"] }
    }),
}

/// Testler alias yolunu tablodaki ayni adla sinar.
#[cfg(test)]
const TAKMA_HAFIZAYA_KAYDET: &str = Arac::HafizayaKaydet.metadata().aliases[0];

/// `ekrani_net_gor` dispatch'e DUSMEZ (bkz. `Arac::EkraniNetGor`). Buraya
/// dusmek "ozel yol atlanmis" demektir; sessiz kalmak yerine modele gorunur
/// bir hata doner.
const EKRAN_OZEL_YOL: &str =
    "ekrani_net_gor bu yoldan yurutulmez: net kare arac yanitinda gonderilir";

/// Modelin verdigi gorev kimligi bir URL YOLUNA gomulur. Serbest metin oraya
/// girerse `../` ile baska bir uca gidilebilir ya da bozuk bir yol gateway'e
/// anlamsiz istek atar. Bu yuzden bicim ONCE dogrulanir; gecersizse cagri HIC
/// yapilmaz. (Pano penceresinin Rust kopruSundeki kapinin : mission.rs `gate` :
/// sesli yoldaki karsiligi.)
///
/// Desen `@smith/protocol` ile ayni: `tsk_` + 20..32 [0-9a-z].
fn gorev_id_gecerli(id: &str) -> bool {
    onekli_id_gecerli("tsk_", id)
}

/// Gateway kimlikleri `<onek>_` + 20..32 [0-9a-z] (`packages/db/src/ids.ts`).
/// Hatirlatma kimligi de modelden gelip bir URL yoluna girer: ayni kapi.
fn onekli_id_gecerli(onek: &str, id: &str) -> bool {
    let Some(govde) = id.strip_prefix(onek) else {
        return false;
    };
    (20..=32).contains(&govde.len())
        && govde
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// Modele donen ret metni. Uydurulmus id sessizce yutulmaz: model bunu duyar ve
/// dogru id'yi `pano_durumu`'ndan almayi ogrenir.
const GOREV_ID_GECERSIZ: &str =
    "gecersiz gorev kimligi: tsk_ ile baslayan gercek bir id gerekir (pano_durumu ile al)";

const HATIRLATMA_ID_GECERSIZ: &str =
    "gecersiz hatirlatma kimligi: rem_ ile baslayan gercek bir id gerekir (hatirlatmalari_listele ile al)";
const HAFIZA_SORUSU_ID_GECERSIZ: &str =
    "gecersiz hafiza sorusu kimligi: acilis baglamindaki gap_ id gerekir";
const HAFIZA_SORUSU_CEVAP_GECERSIZ: &str = "cevap 1-4000 karakter olmali";
const HATIRLATMA_ZAMAN_GECERSIZ: &str =
    "zaman gecersiz: ofsetli ISO 8601 gerekir (or. YYYY-MM-DDTHH:MM:SS+03:00); belirsizse Cihan'a tek kisa soru sor";
/// Gateway `text` sinirini (1-500 karakter) once burada uygular: gateway 400'u
/// modele gerekce tasimaz (`GatewayClient` yalniz durum kodunu bildirir).
const HATIRLATMA_MAX_KARAKTER: usize = 500;

/// `YYYY-MM-DDTHH:MM:SS[.fff]` + `Z` ya da `+HH:MM`/`-HH:MM` (gateway
/// `datetime({ offset: true })`). Takvim dogrulugu (gecmis, gecersiz gun, bir yil
/// siniri) gateway'e aittir; burada yalniz modele anlasilir bir ret icin bicim ve
/// alan araliklari sinanir.
fn zaman_gecerli(zaman: &str) -> bool {
    fn alan(s: &str, uzunluk: usize, en_cok: u32) -> Option<u32> {
        (s.len() == uzunluk && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse::<u32>().ok())
            .flatten()
            .filter(|n| *n <= en_cok)
    }
    let Some((tarih, saat)) = zaman.split_once('T') else {
        return false;
    };
    let tarih_tamam = match tarih.split('-').collect::<Vec<_>>()[..] {
        [y, ay, g] => {
            alan(y, 4, 9999).is_some()
                && alan(ay, 2, 12).is_some_and(|n| n >= 1)
                && alan(g, 2, 31).is_some_and(|n| n >= 1)
        }
        _ => false,
    };
    let (zaman_kismi, ofset) = match saat.strip_suffix('Z') {
        Some(s) => (s, None),
        None => match saat.rfind(['+', '-']) {
            Some(i) => (&saat[..i], Some(&saat[i + 1..])),
            None => return false,
        },
    };
    let (hms, kesir) = match zaman_kismi.split_once('.') {
        Some((h, k)) => (h, Some(k)),
        None => (zaman_kismi, None),
    };
    let saat_tamam = match hms.split(':').collect::<Vec<_>>()[..] {
        [s, d, sn] => {
            alan(s, 2, 23).is_some() && alan(d, 2, 59).is_some() && alan(sn, 2, 59).is_some()
        }
        _ => false,
    };
    let kesir_tamam = kesir.is_none_or(|k| !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit()));
    let ofset_tamam = ofset.is_none_or(|o| match o.split(':').collect::<Vec<_>>()[..] {
        [s, d] => alan(s, 2, 23).is_some() && alan(d, 2, 59).is_some(),
        _ => false,
    });
    tarih_tamam && saat_tamam && kesir_tamam && ofset_tamam
}

/// Europe/Istanbul 2016'dan beri yil boyu UTC+03:00. Hatirlatma ust siniri
/// bir yil oldugu icin bu sabit, desteklenen pencerenin tamaminda dogrudur.
fn istanbul_iso(unix_utc: u64) -> String {
    let yerel = unix_utc.saturating_add(3 * 60 * 60);
    let (y, ay, gun, saat, dakika, saniye) = crate::time_util::utc_parcalar(yerel);
    format!("{y:04}-{ay:02}-{gun:02}T{saat:02}:{dakika:02}:{saniye:02}+03:00")
}

fn hatirlatma_zamanini_coz(
    args: &serde_json::Value,
    simdi_unix: u64,
) -> Result<(String, String), &'static str> {
    let zaman = args["zaman"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let sure_var = args.get("sure_dakika").is_some_and(|v| !v.is_null());
    if zaman.is_some() && sure_var {
        return Err("zaman ve sure_dakika birlikte verilmez");
    }
    let simdi = istanbul_iso(simdi_unix);
    if sure_var {
        let dakika = args["sure_dakika"]
            .as_u64()
            .filter(|d| (1..=525_600).contains(d))
            .ok_or("sure_dakika 1-525600 arasi tam sayi olmali")?;
        let due = simdi_unix
            .checked_add(dakika.saturating_mul(60))
            .ok_or("sure_dakika zaman araligini asti")?;
        return Ok((istanbul_iso(due), simdi));
    }
    let zaman = zaman.ok_or(HATIRLATMA_ZAMAN_GECERSIZ)?;
    if !zaman_gecerli(zaman) {
        return Err(HATIRLATMA_ZAMAN_GECERSIZ);
    }
    Ok((zaman.to_owned(), simdi))
}

/// Live arac cagrisinin kimligi gateway'in `idempotency_key` kuralina (1-80
/// yazdirilabilir ASCII) uyuyorsa anahtar olur: kaybolan yanit yeniden denenirse
/// ayni hatirlatma ikinci kez kurulmaz. Uymuyorsa anahtarsiz gidilir.
fn idempotency_anahtari(cagri_id: &str) -> Option<&str> {
    ((1..=80).contains(&cagri_id.len()) && cagri_id.bytes().all(|b| (0x20..=0x7e).contains(&b)))
        .then_some(cagri_id)
}

/// Isim -> arac. SAF fonksiyon: env okumaz, ag gormez, testten dogrudan
/// cagrilabilir.
///
/// Bilinmeyen ad `None` doner ve cagiran taraf modele
/// `{"hata":"bilinmeyen arac: X"}` gonderir : sessiz yutma YOK.
fn arac_coz(name: &str) -> Option<Arac> {
    Arac::HEPSI.iter().copied().find(|a| {
        let bilgi = a.metadata();
        bilgi.ad == name || bilgi.aliases.contains(&name)
    })
}

/// Gateway arac koprusu: Live'in cagirdigi fonksiyonu HTTP'ye cevirir.
///
/// Token'i kendisi alir (`/v1/dev/login`) ve saklar: Live oturumu frontend'den
/// bagimsiz calisir, dolayisiyla UI'in token'ina guvenemez. Gateway kapaliysa
/// arac cagrisi hata metniyle doner : model bunu kullaniciya soyler, oturum
/// COKMEZ (sessiz "hatirlamiyorum" yerine gorunur sebep).
pub(super) struct ToolBridge {
    /// HTTP + token onbellegi `crate::gateway`'e tasindi: Mission Control panosu
    /// da ayni tabani ve ayni `/v1/dev/login` yolunu kullaniyor (ikinci gercek
    /// kullanim). Iki kopya token onbellegi zamanla ayrisirdi.
    pub(super) gw: crate::gateway::GatewayClient,
    /// Ses izi kapisi: son ifadenin Cihan'a ait olup olmadigini bilir.
    /// Kapi kapaliysa (env yok) hicbir araci engellemez.
    pub(super) speaker: Arc<crate::audio::speaker::SpeakerGate>,
    /// UI olay kanali. `None` = olay yayini yok (testler); arac yurutmesi bu
    /// durumda da AYNEN calisir : gorunurluk bir teshis katmanidir, araci
    /// bloke etmesi yasak.
    pub(super) olaylar: Option<mpsc::UnboundedSender<LiveEvent>>,
}

/// Gateway cagrisinin sonucunu modele donecek JSON'a cevirir.
///
/// Hata da modele DONER: "hatirlayamadim" demesi, sessizce uydurmasindan
/// iyidir. Iki hafiza dali ayni donusumu paylasiyor; dispatch exhaustive match'e
/// gecince arm'lar `Value` dondurmek zorunda kaldi, bu yuzden donusum tek yerde.
fn gateway_sonucu(r: Result<serde_json::Value, String>) -> serde_json::Value {
    match r {
        Ok(v) => v,
        Err(e) => serde_json::json!({ "hata": e }),
    }
}

fn kisa_gateway_sonucu(r: Result<serde_json::Value, String>) -> serde_json::Value {
    match r {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "hata": e }),
    }
}

impl ToolBridge {
    pub(super) fn from_env(
        speaker: Arc<crate::audio::speaker::SpeakerGate>,
        olaylar: Option<mpsc::UnboundedSender<LiveEvent>>,
    ) -> Self {
        Self {
            gw: crate::gateway::GatewayClient::from_env(),
            speaker,
            olaylar,
        }
    }

    /// UI'a arac durumu bildirir. Kanal yoksa veya alici dustuyse SESSIZCE
    /// gecer: gorunurluk arac yurutmesini asla engellemez.
    pub(super) fn bildir(&self, ad: &str, durum: &'static str, sebep: Option<String>) {
        if let Some(tx) = self.olaylar.as_ref() {
            let _ = tx.send(LiveEvent::Tool {
                ad: ad.to_string(),
                durum,
                sebep,
            });
        }
    }

    /// Kimliksiz kisayol: yalniz testler (uretim `call_id` kullanir).
    #[cfg(test)]
    pub(super) fn call(&self, name: &str, args: &serde_json::Value) -> serde_json::Value {
        self.call_id("", name, args)
    }

    /// Arac cagrisinin GORUNUR sarmalayicisi: kapi kontrolu + UI olaylari.
    /// `cagri_id`: Live arac cagrisinin kimligi (bos = yok); yan etkisi gateway'de
    /// kalici olan araclar (hatirlatma kurma) onu idempotency anahtari yapar.
    ///
    /// Olay yayini neden burada ve dispatch'te degil: `dispatch` her arac icin
    /// erken `return` ediyor: bitis olayini oraya dagitmak 13 yerde tekrar ve
    /// ilk eklenen aracta unutulacak bir adim olurdu. Tek giris/tek cikis.
    pub(super) fn call_id(
        &self,
        cagri_id: &str,
        name: &str,
        args: &serde_json::Value,
    ) -> serde_json::Value {
        self.bildir(name, TOOL_BASLADI, None);
        // SES IZI KAPISI : her seyden once. Hafizaya yazma yalniz Cihan
        // dogrulandiginda, makineyi degistiren araclar yabanci ses tespit
        // edilmediginde calisir (politika tablosu: audio/speaker.rs).
        // Reddedilen cagri gateway'e veya makineye HIC gitmez; sebep loglanir,
        // UI'a `reddedildi` olarak gider ve modele metin olarak doner.
        let kapatma = name == "ekran_akisi" && args["acik"].as_bool() == Some(false);
        let izin = if kapatma {
            Ok(())
        } else {
            self.speaker.check_tool(name)
        };
        if let Err((mesaj, neden)) = izin {
            eprintln!("[speaker] RED: {name} engellendi — {neden}");
            self.bildir(name, TOOL_REDDEDILDI, Some(neden.clone()));
            return serde_json::json!({ "hata": mesaj, "neden": neden });
        }
        let sonuc = self.dispatch(cagri_id, name, args);
        // Arac hata donse bile durum `bitti`: cagri YURUTULDU, sonucu hatali.
        // `reddedildi` yalniz kapinin karari icin ayrildi.
        self.bildir(name, TOOL_BITTI, None);
        sonuc
    }

    /// Arac cagrisini yurutur ve modele donecek JSON sonucu uretir.
    ///
    /// IKI SINIF ARAC: hafiza araclari gateway'e HTTP ile gider (tenancy/RLS
    /// tek yerde kalsin); SISTEM araclari YERELDE kosar (terminal/donanim/ses
    /// makinenin ustunde olmak zorunda, uzak surecte anlamsiz). Model bu ayrimi
    /// gormez : hepsi ayni arayuz.
    ///
    /// Yalniz `call` uzerinden cagrilir: ses izi kapisi orada, dispatch'ten
    /// ONCE isler.
    pub(super) fn dispatch(
        &self,
        cagri_id: &str,
        name: &str,
        args: &serde_json::Value,
    ) -> serde_json::Value {
        let Some(arac) = arac_coz(name) else {
            // Sessiz yutma YOK: model hatayi metin olarak gorur ve soyler.
            return serde_json::json!({ "hata": format!("bilinmeyen arac: {name}") });
        };
        // EXHAUSTIVE MATCH : `_` dali EKLENMEZ. Garantinin kendisi budur:
        // enum'a arac eklenip burada dallandirilmazsa kod DERLENMEZ.
        match arac {
            // --- YEREL SISTEM ARACLARI: gateway'e ugramaz, makinede kosar.
            Arac::TerminalCalistir => {
                let cmd = args["komut"].as_str().unwrap_or("");
                if cmd.trim().is_empty() {
                    return serde_json::json!({ "hata": "komut bos" });
                }
                let bg = args["arka_planda"].as_bool().unwrap_or(false);
                // `terminal_calistir` (run_powershell DEGIL): gizlilik kara
                // listesi kapisi yalniz bu giriste; bkz. `system_tools`.
                crate::system_tools::terminal_calistir_onayli(
                    cmd,
                    bg,
                    terminal_suresi(&args["sure_sn"]),
                    args["onay"].as_bool().unwrap_or(false),
                )
            }
            Arac::UygulamaAc => {
                let app = args["ad"].as_str().unwrap_or("");
                if app.trim().is_empty() {
                    return serde_json::json!({ "hata": "ad bos" });
                }
                crate::system_tools::open_app(app)
            }
            Arac::ArkaPlanSonuc => {
                crate::system_tools::arka_plan_sonuc(args["is_id"].as_str().unwrap_or(""))
            }
            Arac::ArkaPlanIptal => {
                crate::system_tools::arka_plan_iptal(args["is_id"].as_str().unwrap_or(""))
            }
            Arac::SistemDurumu => crate::system_tools::system_status(),
            Arac::DosyaAra => crate::system_tools::file_search(
                args["desen"].as_str().unwrap_or(""),
                args["klasor"].as_str(),
            ),
            Arac::DosyaOku => {
                crate::system_tools::file_read(args["yol"].as_str().unwrap_or(""), None)
            }
            Arac::DerinDusun => {
                let q = args["soru"].as_str().unwrap_or("");
                crate::system_tools::deep_think(q)
            }
            Arac::InternetteAra => {
                let q = args["sorgu"].as_str().unwrap_or("");
                crate::system_tools::web_search(q)
            }
            Arac::WebSayfaOku => {
                let u = args["adres"].as_str().unwrap_or("");
                crate::system_tools::web_read(u)
            }
            Arac::AcikUygulamalar => crate::system_tools::running_apps(),
            // Dosya sistemi okumasi (598 oturumun meta verisi + secilenlerin
            // 64 KB penceresi). BLOKLAYICI, ama `call` zaten `spawn_blocking`
            // icinde kosuyor (bkz. session_loop) : diger yerel araclarla ayni
            // sozlesme. Burada AYRICA spawn_blocking koymak derlemeyi kirar.
            // Yalniz arka plan kosusunu baslatir; sonuc run_id ile sonra okunur.
            Arac::KodGoreviVer => crate::code_agent::kod_gorevi_ver(
                args["gorev"].as_str().unwrap_or(""),
                args["ad"].as_str(),
                args["dosyalar"].as_str(),
            ),
            Arac::KodGoreviDurum => {
                match crate::code_agent::kosu_durumu(args["run_id"].as_str().unwrap_or("")) {
                    Ok(record) => record,
                    Err(error) => serde_json::json!({ "hata": error }),
                }
            }
            Arac::AjanOturumlari => crate::agent_sessions::ajan_oturumlari(
                args["kaynak"].as_str().unwrap_or("hepsi"),
                args["adet"].as_u64(),
                args["icerik"].as_bool().unwrap_or(false),
            ),
            // --- MISSION CONTROL (ADR 0007) -------------------------------
            // Hepsi gateway'e gider: durum makinesi, tenancy ve RLS orada TEK
            // yerde. Panonun kendisi de ayni ucleri cagiriyor : sesli yol ile
            // gorsel yol ayrisamaz.
            Arac::GorevVer => {
                let baslik = args["baslik"].as_str().unwrap_or("").trim().to_string();
                if baslik.chars().count() < 3 {
                    return serde_json::json!({ "hata": "baslik en az 3 karakter olmali" });
                }
                let mut govde = serde_json::json!({ "title": baslik, "via": "voice" });
                if let Some(a) = args["ayrinti"]
                    .as_str()
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                {
                    govde["detail"] = serde_json::json!(a);
                }
                // "@nova" da "nova" da kabul: kullanici konusurken isaret koymaz,
                // model bazen koyar.
                if let Some(aj) = args["ajan"]
                    .as_str()
                    .map(|t| t.trim().trim_start_matches('@').to_string())
                    .filter(|t| !t.is_empty())
                {
                    govde["assignee"] = serde_json::json!(aj);
                }
                if let Some(o) = args["oncelik"].as_u64().filter(|o| (1..=3).contains(o)) {
                    govde["priority"] = serde_json::json!(o);
                }
                gateway_sonucu(self.post("/v1/mission/tasks", govde))
            }
            Arac::PanoDurumu => gateway_sonucu(self.get("/v1/mission/summary")),
            Arac::GorevDurum => {
                let id = args["gorev_id"].as_str().unwrap_or("");
                if !gorev_id_gecerli(id) {
                    return serde_json::json!({ "hata": GOREV_ID_GECERSIZ });
                }
                let durum = args["durum"].as_str().unwrap_or("").trim().to_lowercase();
                gateway_sonucu(self.post(
                    &format!("/v1/mission/tasks/{id}/status"),
                    serde_json::json!({ "status": durum }),
                ))
            }
            Arac::YorumEkle => {
                let id = args["gorev_id"].as_str().unwrap_or("");
                if !gorev_id_gecerli(id) {
                    return serde_json::json!({ "hata": GOREV_ID_GECERSIZ });
                }
                let metin = args["metin"].as_str().unwrap_or("").trim().to_string();
                if metin.is_empty() {
                    return serde_json::json!({ "hata": "yorum metni bos" });
                }
                gateway_sonucu(self.post(
                    &format!("/v1/mission/tasks/{id}/comments"),
                    serde_json::json!({ "body": metin }),
                ))
            }
            Arac::EkipListesi => gateway_sonucu(self.get("/v1/mission/agents")),
            // --- EKRAN AKISI: yerel bayrak. Durum degisimi UI'a `session_loop`
            // icindeki ekran dongusunden (`EKRAN_AKISI_DURUMU`) iner.
            Arac::EkranAkisi => {
                let Some(acik) = args["acik"].as_bool() else {
                    return serde_json::json!({ "hata": "acik (true veya false) gerekli" });
                };
                crate::audio::screen::akis_ayarla(acik);
                serde_json::json!({
                    "akis_acik": acik,
                    "durum": if acik { "ekran akisi acildi" } else { "ekran akisi kapatildi" }
                })
            }
            Arac::DinlemeModu => {
                let Some(kip) = DinlemeKipi::arguman(args) else {
                    return serde_json::json!({ "hata": "kip: herkes | yalniz_beni | isimle gerekli" });
                };
                let degisen_surum = dinleme_ayarla(kip);
                if let Some(tx) = &self.olaylar {
                    let _ = tx.send(dinleme_olayi(kip, None));
                }
                serde_json::json!({ "kip": dinleme_kipi(), "yalniz_beni": dinleme_kipi() == DinlemeKipi::YalnizBeni,
                    "degisen_surum": degisen_surum })
            }
            Arac::SesKontrol => {
                let action = args["islem"].as_str().unwrap_or("oku");
                let value = args["deger"].as_f64();
                crate::system_tools::audio_control(action, value)
            }
            // --- HAFIZA ARACLARI: gateway (tenancy/RLS tek yerde kalsin).
            Arac::HafizadaAra => {
                let q = args["sorgu"].as_str().unwrap_or("").to_string();
                gateway_sonucu(
                    self.post("/v1/tools/memory/search", serde_json::json!({ "query": q })),
                )
            }
            Arac::HafizayaKaydet => {
                let c = args["icerik"].as_str().unwrap_or("").to_string();
                gateway_sonucu(self.post(
                    "/v1/tools/memory/remember",
                    serde_json::json!({ "content": c }),
                ))
            }
            // --- HATIRLATMA: gateway (kalici kayit ve teslim kirasi orada). Teslim
            // dongusu `crate::reminders`; burada yalniz kur, listele, iptal.
            Arac::HatirlatmaKur => {
                let metin = args["metin"].as_str().unwrap_or("").trim();
                if metin.is_empty() {
                    return serde_json::json!({ "hata": "metin bos" });
                }
                if metin.chars().count() > HATIRLATMA_MAX_KARAKTER {
                    return serde_json::json!({ "hata": "metin en fazla 500 karakter olabilir" });
                }
                let (zaman, simdi) = match hatirlatma_zamanini_coz(
                    args,
                    crate::time_util::unix_seconds(std::time::SystemTime::now()),
                ) {
                    Ok(v) => v,
                    Err(hata) => return serde_json::json!({ "hata": hata }),
                };
                let mut govde = serde_json::json!({ "text": metin, "due_at": zaman.clone() });
                if let Some(anahtar) = idempotency_anahtari(cagri_id) {
                    govde["idempotency_key"] = serde_json::json!(anahtar);
                }
                let mut sonuc = gateway_sonucu(self.post("/v1/tools/reminders", govde));
                if let Some(nesne) = sonuc.as_object_mut() {
                    nesne.insert("guncel_saat".into(), serde_json::json!(simdi));
                    nesne.insert("kurulan_zaman".into(), serde_json::json!(zaman));
                }
                sonuc
            }
            Arac::HatirlatmalariListele => gateway_sonucu(self.get("/v1/tools/reminders")),
            Arac::HatirlatmaIptal => {
                let id = args["id"].as_str().unwrap_or("");
                if !onekli_id_gecerli("rem_", id) {
                    return serde_json::json!({ "hata": HATIRLATMA_ID_GECERSIZ });
                }
                gateway_sonucu(self.post(
                    &format!("/v1/tools/reminders/{id}/cancel"),
                    serde_json::json!({}),
                ))
            }
            // --- KISISEL PROFIL: gateway (Memory tablosu, sir denetimi orada). Kalici
            // bilgi yalniz acik talepte yazilir (yonerge + sahip kaniti kapisi).
            Arac::ProfilKaydet => {
                let anahtar = args["anahtar"].as_str().unwrap_or("").trim();
                if !profil::anahtar_gecerli(anahtar) {
                    return serde_json::json!({ "hata": profil::ANAHTAR_GECERSIZ });
                }
                let deger = args["deger"].as_str().unwrap_or("").trim();
                if !profil::deger_gecerli(deger) {
                    return serde_json::json!({ "hata": profil::DEGER_GECERSIZ });
                }
                gateway_sonucu(self.post(
                    "/v1/tools/profile",
                    serde_json::json!({ "anahtar": anahtar, "deger": deger }),
                ))
            }
            Arac::ProfilSil => {
                let anahtar = args["anahtar"].as_str().unwrap_or("").trim();
                if !profil::anahtar_gecerli(anahtar) {
                    return serde_json::json!({ "hata": profil::ANAHTAR_GECERSIZ });
                }
                gateway_sonucu(self.gw.delete(&format!("/v1/tools/profile/{anahtar}")))
            }
            Arac::HafizaSorusuCevapla => {
                let id = args["id"].as_str().unwrap_or("").trim();
                if !memory_gap::id_gecerli(id) {
                    return serde_json::json!({ "hata": HAFIZA_SORUSU_ID_GECERSIZ });
                }
                let cevap = args["cevap"].as_str().unwrap_or("").trim();
                if cevap.is_empty() || cevap.chars().count() > 4000 {
                    return serde_json::json!({ "hata": HAFIZA_SORUSU_CEVAP_GECERSIZ });
                }
                kisa_gateway_sonucu(self.post(
                    &format!("/v1/memory/gaps/{id}/answer"),
                    serde_json::json!({ "answer": cevap }),
                ))
            }
            Arac::HafizaSorusuGec => {
                let id = args["id"].as_str().unwrap_or("").trim();
                if !memory_gap::id_gecerli(id) {
                    return serde_json::json!({ "hata": HAFIZA_SORUSU_ID_GECERSIZ });
                }
                let Some(kalici) = args["kalici"].as_bool() else {
                    return serde_json::json!({ "hata": "kalici boolean olmali" });
                };
                if !kalici {
                    return serde_json::json!({ "ok": true, "durum": "bu oturum ertelendi" });
                }
                kisa_gateway_sonucu(self.post(
                    &format!("/v1/memory/gaps/{id}/dismiss"),
                    serde_json::json!({}),
                ))
            }
            // --- OZEL YOL: normalde buraya HIC dusmez (alim dongusu yakalar).
            Arac::EkraniNetGor => serde_json::json!({ "hata": EKRAN_OZEL_YOL }),
        }
    }

    pub(super) fn post(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.gw.post(path, &body)
    }

    /// Gateway'den JSON okur (GET). `post` ile AYNI token yolunu kullanir:
    /// ikinci bir login yolu acilmaz, onbellek `GatewayClient` icinde tek yerde.
    pub(super) fn get(&self, path: &str) -> Result<serde_json::Value, String> {
        self.gw.get(path)
    }

    /// Yonergeye eklenecek "son konusma" blogu.
    ///
    /// Bos string uc halde doner: ozellik kapali, gateway kapali/hata verdi,
    /// ya da kayit bos. UCUNDE DE MODELE HICBIR SEY SOYLENMEZ : elde bilgi
    /// yokken "gecmisi hatirla" demek modeli uydurmaya davet ederdi.
    pub(super) fn son_konusma_blogu(&self) -> String {
        if !konusma_hafizasi_acik() {
            eprintln!("[konusma] gecmis hatirlatmasi kapali (SMITH_CONVERSATION_MEMORY=0)");
            return String::new();
        }
        let yol = format!(
            "/v1/tools/conversation/recent?limit={KONUSMA_LIMIT}&maxChars={KONUSMA_MAX_CHARS}"
        );
        let yanit = match self.get(&yol) {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("[konusma] gecmis alinamadi: {e}");
                None
            }
        };
        let blok = konusma_eki(true, yanit.as_ref());
        if blok.is_empty() {
            eprintln!("[konusma] gecmis blogu bos — yonergeye ek yok");
        } else {
            eprintln!("[konusma] gecmis blogu hazir ({} bayt)", blok.len());
        }
        blok
    }

    /// Yonergeye eklenecek "kisisel profil" blogu (bkz. `profil`). `son_konusma_blogu`
    /// ile ayni sozlesme: gateway kapali/hata verdi ya da profil bos ise bos string,
    /// UCUNDE DE MODELE HICBIR SEY SOYLENMEZ.
    pub(super) fn profil_blogu(&self) -> String {
        profil::blok_hazirla(
            self.get("/v1/tools/profile"),
            profil::yerel_saat_dilimi().as_deref(),
        )
    }

    /// Live setup'a en fazla bir hafiza sorusu verir. Soru ancak `/asked`
    /// basarili olduktan sonra doner; boylece modele verilip acik kalan kayit
    /// sonraki oturumda tekrar tekrar sorulmaz.
    pub(super) fn hafiza_sorusu_satiri(&self) -> String {
        let open = match self.get("/v1/memory/gaps?status=open&limit=1") {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[hafiza-boslugu] acik sorular alinamadi: {e}");
                return String::new();
            }
        };
        let mut secilen = memory_gap::sec(&open, None, std::time::SystemTime::now());
        if secilen.is_none() {
            let asked = match self.get("/v1/memory/gaps?status=asked&limit=100") {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[hafiza-boslugu] sorulmus sorular alinamadi: {e}");
                    return String::new();
                }
            };
            secilen = memory_gap::sec(&open, Some(&asked), std::time::SystemTime::now());
        }
        let Some(secilen) = secilen else {
            eprintln!("[hafiza-boslugu] aday soru yok");
            return String::new();
        };
        if let Err(e) = self.post(
            &format!("/v1/memory/gaps/{}/asked", secilen.id),
            serde_json::json!({}),
        ) {
            eprintln!("[hafiza-boslugu] asked bildirilemedi: {e}");
            return String::new();
        }
        secilen.satir
    }
}

fn terminal_suresi(v: &serde_json::Value) -> Option<u64> {
    v.as_u64()
        .or_else(|| {
            v.as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .map(|n| n as u64)
        })
        .map(|n| n.clamp(5, 300))
}

pub(super) fn arac_yaniti(id: &str, ad: &str, sonuc: serde_json::Value) -> serde_json::Value {
    let mut yanit = serde_json::json!({ "id": id, "name": ad, "response": yanit_nesnesi(sonuc) });
    if arac_davranisi(ad) == "NON_BLOCKING" {
        yanit["scheduling"] = serde_json::json!("WHEN_IDLE");
    }
    yanit
}

/// Gemini functionResponses.response bir protobuf Struct (JSON nesnesi) ister.
pub(super) fn yanit_nesnesi(v: serde_json::Value) -> serde_json::Value {
    if v.is_object() {
        v
    } else {
        serde_json::json!({ "sonuc": v })
    }
}

#[cfg(test)]
mod tests {
    use super::super::microphone::sahip_sonucu;
    use super::*;
    use crate::audio::speaker::{SpeakerVerdict, DENY_TOOL, DENY_WRITE};

    use super::super::screen_stream::ekran_akisi_olayi;

    #[test]
    fn a2_sahip_tamponu_sirali_tam_ifade_ve_akis_sonu() {
        use crate::audio::vad::{KapiCikti, KareDurumu, MikKapisi, SahipTamponu};
        let (tx, mut rx) = mpsc::unbounded_channel();
        for karar in [
            SpeakerVerdict::Owner,
            SpeakerVerdict::Unknown,
            SpeakerVerdict::Foreign,
        ] {
            let mut kapi = MikKapisi::new(1000);
            let mut tampon = SahipTamponu::default();
            let mut ifade = None;
            // 500 ms on-tampon + 1 sn konusma + 1 sn kuyruk; hepsi tekil sirada.
            for i in 0..125 {
                let durum = if (25..75).contains(&i) {
                    KareDurumu::Konusma
                } else {
                    KareDurumu::Sessiz
                };
                for cikti in kapi.adim(&vec![i as f32; 320], durum) {
                    if let Some(ses) = tampon.tut(cikti) {
                        ifade = Some(ses);
                    }
                }
                if i < 124 {
                    assert!(ifade.is_none(), "ifade bitmeden cikti uretildi");
                }
            }
            let ses = ifade.unwrap();
            let beklenen: Vec<f32> = (0..125).flat_map(|i| vec![i as f32; 320]).collect();
            assert_eq!(ses, beklenen);
            let giden = sahip_sonucu(ses, karar, &tx);
            if karar == SpeakerVerdict::Owner {
                assert_eq!(giden, vec![KapiCikti::Ses(beklenen), KapiCikti::AkisSonu]);
            } else {
                assert!(giden.is_empty());
            }
            let LiveEvent::Tool { ad, durum, sebep } = rx.try_recv().unwrap() else {
                panic!("durum olayi yok")
            };
            assert_eq!((ad.as_str(), durum), ("dinleme_modu_durumu", "yalniz_beni"));
            assert_eq!(sebep.is_some(), karar != SpeakerVerdict::Owner);
        }
    }

    #[test]
    fn a2_sidecar_yokken_ses_yok_uyari_var() {
        let gate = crate::audio::speaker::SpeakerGate::disabled();
        let ses = vec![0.1; 16_000];
        let karar = gate.verify(&ses);
        let (tx, mut rx) = mpsc::unbounded_channel();
        assert!(sahip_sonucu(ses, karar, &tx).is_empty());
        assert!(matches!(
            rx.try_recv().unwrap(),
            LiveEvent::Tool { sebep: Some(_), .. }
        ));
    }

    #[test]
    fn a2_tampon_tavani_en_eski_ornekleri_dusurur() {
        use crate::audio::vad::{KapiCikti, SahipTamponu};
        let mut tampon = SahipTamponu::default();
        assert!(tampon
            .tut(KapiCikti::Ses(vec![1.0; SahipTamponu::TAVAN]))
            .is_none());
        assert!(tampon.tut(KapiCikti::Ses(vec![2.0; 320])).is_none());
        assert_eq!(tampon.dusen, 320);
        let ses = tampon.tut(KapiCikti::AkisSonu).unwrap();
        assert_eq!(ses.len(), SahipTamponu::TAVAN);
        assert!(ses[..ses.len() - 320].iter().all(|v| *v == 1.0));
        assert_eq!(&ses[ses.len() - 320..], &[2.0; 320]);
    }

    #[test]
    fn terminal_float_sureyi_kabul_eder_ve_sinirlar() {
        use serde_json::json;
        for (v, beklenen) in [
            (json!(60.0), Some(60)),
            (json!(65.5), Some(65)),
            (json!(900), Some(300)),
            (json!(1), Some(5)),
            (json!(-1), None),
            (json!("60"), None),
            (json!(null), None),
        ] {
            assert_eq!(terminal_suresi(&v), beklenen);
        }
    }

    #[test]
    fn uzun_arac_yaniti_when_idle_ve_nesnedir() {
        for ad in [
            "derin_dusun",
            "kod_gorevi_ver",
            "arka_plan_sonuc",
            "arka_plan_iptal",
            "terminal_calistir",
        ] {
            let v = arac_yaniti("c1", ad, serde_json::json!("sonuc"));
            assert_eq!(v["id"], "c1");
            assert_eq!(v["name"], ad);
            assert!(v["response"].is_object());
            assert!(v["response"].get("scheduling").is_none());
            if matches!(ad, "derin_dusun") {
                assert_eq!(v["scheduling"], "WHEN_IDLE");
            } else {
                assert!(v.get("scheduling").is_none());
            }
        }
    }

    #[test]
    fn net_kare_dali_video_gondermez() {
        let kaynak = include_str!("session.rs");
        let dal = kaynak
            .split("if call[\"name\"].as_str() == Some(Arac::EkraniNetGor.ad()) {")
            .nth(1)
            .unwrap()
            .split("// SAYAC SPAWN'IN DISINDA ARTAR.")
            .next()
            .unwrap();
        assert!(!dal.contains("\"realtimeInput\""));
        assert_eq!(dal.matches("out.send(").count(), 1);
        assert!(dal.contains("net_kare_cercevesi(&id, sonuc)"));
    }

    #[test]
    fn terminal_suresi_ve_arka_plan_araclari() {
        let t = tool_declarations();
        let liste = t[0]["functionDeclarations"].as_array().unwrap();
        let terminal = liste
            .iter()
            .find(|t| t["name"] == "terminal_calistir")
            .unwrap();
        assert_eq!(
            terminal["parameters"]["properties"]["sure_sn"]["type"],
            "INTEGER"
        );
        for ad in ["arka_plan_sonuc", "arka_plan_iptal"] {
            assert!(liste.iter().any(|t| t["name"] == ad));
            let sonuc =
                bridge(SpeakerVerdict::Owner).call(ad, &serde_json::json!({"is_id":"gecersiz"}));
            assert!(sonuc["hata"].is_string());
            assert!(!sonuc.to_string().contains("bilinmeyen arac"));
            assert_eq!(
                bridge(SpeakerVerdict::Unknown).call(ad, &serde_json::json!({}))["neden"]
                    .is_string(),
                ad == "arka_plan_sonuc"
            );
            assert!(
                bridge(SpeakerVerdict::Foreign).call(ad, &serde_json::json!({}))["neden"]
                    .is_string()
            );
        }
    }

    #[test]
    fn yanit_nesnesi_tum_json_tiplerini_korur() {
        for v in [
            serde_json::json!({ "uygulama": "Smith", "ic": [1, null] }),
            serde_json::json!({}),
            serde_json::json!([{"uygulama": "Smith"}, {"uygulama": "Terminal"}]),
            serde_json::json!([]),
            serde_json::json!("metin"),
            serde_json::json!(42),
            serde_json::json!(-1.5),
            serde_json::json!(true),
            serde_json::json!(false),
            serde_json::Value::Null,
        ] {
            let sonuc = yanit_nesnesi(v.clone());
            assert!(sonuc.is_object(), "{v}");
            if v.is_object() {
                assert_eq!(sonuc, v);
            } else {
                assert_eq!(sonuc, serde_json::json!({ "sonuc": v }));
            }
        }
    }

    /// Kapiyi ARAC KOPRUSU seviyesinde dogrular: birim testler politikayi
    /// kanitliyor, buradaki testler kontrolun dispatch'ten ONCE yapildigini :
    /// yani reddedilen cagrinin gateway'e veya makineye HIC ulasmadigini :
    /// kanitlar. Aga cikilmaz: karar bagli sidecar olmadan enjekte edilir.
    fn bridge(v: SpeakerVerdict) -> ToolBridge {
        ToolBridge::from_env(
            Arc::new(crate::audio::speaker::SpeakerGate::armed_for_test(v)),
            None,
        )
    }

    /// Olay kanali bagli kopru: `audio://tool` akisini AG OLMADAN ve Tauri
    /// handle'i OLMADAN dogrulamak icin. Kanalin ucu testte durur; uretimde
    /// ayni olaylar `lib.rs`'te `app.emit` ile UI'a gider.
    fn bridge_ev(v: SpeakerVerdict) -> (ToolBridge, mpsc::UnboundedReceiver<LiveEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let b = ToolBridge::from_env(
            Arc::new(crate::audio::speaker::SpeakerGate::armed_for_test(v)),
            Some(tx),
        );
        (b, rx)
    }

    /// Kanaldaki olaylari (ad, durum, sebep) uclulerine indirger.
    fn olaylari_topla(
        rx: &mut mpsc::UnboundedReceiver<LiveEvent>,
    ) -> Vec<(String, &'static str, Option<String>)> {
        let mut out = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            match ev {
                LiveEvent::Tool { ad, durum, sebep } => out.push((ad, durum, sebep)),
                other => panic!("arac olayi beklenirken {other:?} geldi"),
            }
        }
        out
    }

    /// `ekrani_net_gor` ARAC KOPRUSUNU ATLAR (kareler yerelde yakalanir),
    /// dolayisiyla ses izi kapisindan da GECMEZ. Bugun zararsiz: arac iki
    /// politika listesinde de yok. Yarin biri onu hassas ilan ederse kapi
    /// sessizce uygulanmamis olurdu : bu test o gun kirmiziya doner ve
    /// dispatch'in de kapiya baglanmasi gerektigini soyler.
    #[test]
    fn ekran_araci_kapi_listelerinde_olmamali() {
        use crate::audio::speaker::{NO_FOREIGN_TOOLS, OWNER_ONLY_TOOLS};
        for liste in [OWNER_ONLY_TOOLS, NO_FOREIGN_TOOLS] {
            assert!(
                !liste.contains(&"ekrani_net_gor"),
                "ekrani_net_gor politika listesine eklenmis ama dispatch yolu \
                 kapiyi atliyor — ya kapiyi o yola da bagla ya listeden cikar"
            );
        }
    }

    /// Modele bildirilen arac adlari (bildirimdeki SIRAYLA).
    fn bildirilen_adlar() -> Vec<String> {
        let tools = tool_declarations();
        tools[0]["functionDeclarations"]
            .as_array()
            .expect("functionDeclarations dizi olmali")
            .iter()
            .map(|t| {
                t["name"]
                    .as_str()
                    .expect("her aracin adi olmali")
                    .to_string()
            })
            .collect()
    }

    /// Tasima oncesi bildirim sirasinin bagimsiz karakterizasyonu.
    fn tanik_indeks(a: Arac) -> usize {
        match a {
            Arac::HafizadaAra => 0,
            Arac::HafizayaKaydet => 1,
            Arac::TerminalCalistir => 2,
            Arac::UygulamaAc => 3,
            Arac::SistemDurumu => 4,
            Arac::SesKontrol => 5,
            Arac::EkraniNetGor => 6,
            Arac::DosyaAra => 7,
            Arac::DosyaOku => 8,
            Arac::DerinDusun => 9,
            Arac::InternetteAra => 10,
            Arac::WebSayfaOku => 11,
            Arac::AcikUygulamalar => 12,
            Arac::AjanOturumlari => 13,
            Arac::KodGoreviVer => 14,
            Arac::KodGoreviDurum => 15,
            Arac::GorevVer => 16,
            Arac::PanoDurumu => 17,
            Arac::GorevDurum => 18,
            Arac::YorumEkle => 19,
            Arac::EkipListesi => 20,
            Arac::EkranAkisi => 21,
            Arac::DinlemeModu => 23,
            Arac::ArkaPlanSonuc => 22,
            Arac::ArkaPlanIptal => 24,
            Arac::HatirlatmaKur => 25,
            Arac::HatirlatmalariListele => 26,
            Arac::HatirlatmaIptal => 27,
            Arac::ProfilKaydet => 28,
            Arac::ProfilSil => 29,
            Arac::HafizaSorusuCevapla => 30,
            Arac::HafizaSorusuGec => 31,
        }
    }

    /// ILERI YON: bildirilen her ad bir araca COZULMELI.
    ///
    /// Bildirime arac eklenip enum'a eklenmezse burada kirilir : sahada belirti
    /// konusmanin ortasinda modele donen `{"hata":"bilinmeyen arac: X"}` olurdu
    /// ve kullanici bunu kusur degil BECERIKSIZLIK sayardi.
    #[test]
    fn bildirilen_her_ad_cozulur() {
        for ad in bildirilen_adlar() {
            let arac = arac_coz(&ad).unwrap_or_else(|| {
                panic!(
                    "'{ad}' modele bildirilmis ama `arac_coz` cozemiyor: \
                     arac_tablosu ve ad cozumunu kontrol et"
                )
            });
            // Kanonik ad bildirimle BIREBIR ayni olmali; aksi halde takma ad
            // gibi davranir ve ters yon testi sessizce kacar.
            assert_eq!(arac.ad(), ad, "kanonik ad bildirimden farkli");
        }
    }

    /// TERS YON: enum'daki her varyantin bir BILDIRIMI olmali.
    ///
    /// "Enum'a ekledim, dispatch'i yazdim ama modele tanitmadim" hali: arac
    /// hicbir zaman cagrilmaz ve hicbir belirti uretmez.
    #[test]
    fn her_varyantin_bildirimi_var() {
        let adlar = bildirilen_adlar();
        for a in Arac::HEPSI.iter().copied() {
            assert!(
                adlar.contains(&a.ad().to_string()),
                "{a:?} enum'da var ama modele bildirilmemis ({})",
                a.ad()
            );
        }
        // Bildirim sirasi ile `HEPSI` sirasi ayni: bire-bir eslesme, fazlalik
        // yok. Takma adlar bildirimde YER ALMADIGI icin sayilar da esit.
        let hepsi: Vec<String> = Arac::HEPSI.iter().map(|a| a.ad().to_string()).collect();
        assert_eq!(hepsi, adlar, "enum listesi bildirim listesiyle ayni degil");
    }

    /// `Arac::HEPSI` gercekten TUM varyantlari tasiyor mu (bkz. `tanik_indeks`).
    #[test]
    fn varyant_listesi_tam() {
        for (i, a) in Arac::HEPSI.iter().copied().enumerate() {
            assert_eq!(tanik_indeks(a), i, "HEPSI sirasi tanikla uyusmuyor: {a:?}");
        }
        assert_eq!(
            Arac::HEPSI.len(),
            32,
            "arac tablosu karakterizasyon sirasindan farkli"
        );
    }

    /// TAKMA AD DAVRANISI DEGISMEDI: bildirimde uzun ad var
    /// (`_ACIK_TALEP_ILE`), model bazen kisasini cagiriyor; ikisi AYNI araca
    /// cozulur. Eskiden dispatch'te `"..." | "hafizaya_kaydet"` olarak vardi.
    #[test]
    fn takma_ad_ayni_araca_cozulur() {
        assert_eq!(
            arac_coz("hafizaya_kaydet"),
            Some(Arac::HafizayaKaydet),
            "takma ad cozulmedi"
        );
        assert_eq!(
            arac_coz("hafizaya_kaydet_ACIK_TALEP_ILE"),
            Some(Arac::HafizayaKaydet)
        );
        // Takma ad YALNIZ takma ad: bildirimde gorunmez, aksi halde model iki
        // ayni araci gorur ve hangisini cagiracagi belirsizlesir.
        assert!(
            !bildirilen_adlar().contains(&TAKMA_HAFIZAYA_KAYDET.to_string()),
            "takma ad modele de bildirilmis"
        );
    }

    /// Bilinmeyen ad SESSIZCE yutulmaz: `arac_coz` `None` doner ve dispatch
    /// modele gorunur hata gonderir (`kapi_listede_olmayan_araci_engellemez`
    /// wire metnini dogruluyor).
    #[test]
    fn bilinmeyen_ad_cozulmez() {
        for ad in ["bilinmeyen_arac_xyz", "", "hafizaya_kaydet_"] {
            assert!(arac_coz(ad).is_none(), "{ad:?} cozulmemeliydi");
        }
    }

    #[test]
    fn kod_gorevi_durumu_run_id_ister_ve_gecersiz_kimligi_reddeder() {
        let tools = tool_declarations();
        let declaration = tools[0]["functionDeclarations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "kod_gorevi_durum")
            .unwrap();
        assert_eq!(
            declaration["parameters"]["required"],
            serde_json::json!(["run_id"])
        );
        assert_eq!(arac_coz("kod_gorevi_durum"), Some(Arac::KodGoreviDurum));
        for args in [
            serde_json::json!({}),
            serde_json::json!({ "run_id": "../escape" }),
        ] {
            let out = bridge(SpeakerVerdict::Owner).call("kod_gorevi_durum", &args);
            assert_eq!(out["hata"], "gecersiz kosu kimligi");
        }
    }

    #[test]
    fn kod_gorevi_durumu_sahip_disindaki_sese_kayit_acmaz() {
        for verdict in [SpeakerVerdict::Unknown, SpeakerVerdict::Foreign] {
            let out = bridge(verdict).call(
                "kod_gorevi_durum",
                &serde_json::json!({ "run_id": "../escape" }),
            );
            assert_eq!(out["hata"], crate::audio::speaker::DENY_CODE);
        }
    }

    /// `ekrani_net_gor` ASIMETRISI: enum'a DAHIL (dispatch exhaustive kalsin)
    /// ama gercek yurutmesi `session_loop`'un alim dongusunde : arac yaniti
    /// JSON, goruntu tasiyamaz. Bu test asimetrinin BILINCLI oldugunu sabitler:
    /// dispatch'e dusmek "bilinmeyen arac" degil, ozel yol isaretidir.
    #[test]
    fn ekran_araci_enumda_ama_dispatch_ozel_yolda() {
        assert_eq!(arac_coz("ekrani_net_gor"), Some(Arac::EkraniNetGor));
        let out = bridge(SpeakerVerdict::Owner).call("ekrani_net_gor", &serde_json::json!({}));
        assert_eq!(
            out["hata"].as_str(),
            Some(EKRAN_OZEL_YOL),
            "ozel yol isareti kayboldu: {out}"
        );
        assert!(
            !out["hata"]
                .as_str()
                .unwrap_or_default()
                .contains("bilinmeyen arac"),
            "arac enum'dan dusmus"
        );
    }

    /// SES IZI KAPISI ISIMLE calisiyor ve `speaker.rs`'te yasiyor. Enum'a
    /// gecerken kapinin davranisi degismedi (bkz. `yabanci_ses_hafizaya_yazamaz`,
    /// `yabanci_ses_terminal_komutu_calistirmaz`); burada politika listelerinin
    /// GERCEK arac adlari tasidigi kanitlanir : listedeki bir yazim hatasi
    /// koruma tamamen etkisiz kalirdi ve hicbir belirti uretmezdi.
    #[test]
    fn kapi_listeleri_gercek_arac_adlari_tasir() {
        use crate::audio::speaker::{NO_FOREIGN_TOOLS, OWNER_ONLY_TOOLS};
        for ad in OWNER_ONLY_TOOLS.iter().chain(NO_FOREIGN_TOOLS) {
            assert!(
                arac_coz(ad).is_some(),
                "'{ad}' politika listesinde ama boyle bir arac yok"
            );
        }
        // Takma ad da kapida: kisa adi cagirmak bir kacis kapisi degil.
        assert!(OWNER_ONLY_TOOLS.contains(&TAKMA_HAFIZAYA_KAYDET));
        assert_eq!(
            arac_coz(TAKMA_HAFIZAYA_KAYDET),
            arac_coz("hafizaya_kaydet_ACIK_TALEP_ILE")
        );
    }

    /// Bildirim kumesi ve sirasi refactor oncesi sozlesmeyi korur.
    #[test]
    fn bildirilen_arac_kumesi_sabit() {
        let adlar = bildirilen_adlar();

        let beklenen = [
            "hafizada_ara",
            "hafizaya_kaydet_ACIK_TALEP_ILE",
            "terminal_calistir",
            "uygulama_ac",
            "sistem_durumu",
            "ses_kontrol",
            "ekrani_net_gor",
            "dosya_ara",
            "dosya_oku",
            "derin_dusun",
            "internette_ara",
            "web_sayfa_oku",
            "acik_uygulamalar",
            "ajan_oturumlari",
            "kod_gorevi_ver",
            "kod_gorevi_durum",
            "gorev_ver",
            "pano_durumu",
            "gorev_durum",
            "yorum_ekle",
            "ekip_listesi",
            "ekran_akisi",
            "arka_plan_sonuc",
            "dinleme_modu",
            "arka_plan_iptal",
            "hatirlatma_kur",
            "hatirlatmalari_listele",
            "hatirlatma_iptal",
            "profil_kaydet",
            "profil_sil",
            "hafiza_sorusu_cevapla",
            "hafiza_sorusu_gec",
        ];
        assert_eq!(
            adlar, beklenen,
            "arac tablosu bildirim sozlesmesini degistirdi; dispatch ve karakterizasyonu kontrol et"
        );

        let labels = tool_labels();
        assert_eq!(labels.len(), beklenen.len() + 1);
        for ad in &adlar {
            assert!(labels
                .get(ad.as_str())
                .is_some_and(|etiket| !etiket.is_empty()));
        }
        assert_eq!(
            labels["hafizaya_kaydet"],
            labels["hafizaya_kaydet_ACIK_TALEP_ILE"]
        );

        // Ad tekrari, modelin hangi bildirimi kullandigini belirsizlestirir.
        let mut tekil = adlar.clone();
        tekil.sort();
        tekil.dedup();
        assert_eq!(
            tekil.len(),
            adlar.len(),
            "ayni arac adi iki kez bildirilmis"
        );
    }

    /// GOREV KIMLIGI KAPISI. Model bu degeri uretiyor ve deger bir URL YOLUNA
    /// giriyor; dogrulama olmasa `../` ile baska bir gateway ucuna gidilebilirdi
    /// (pano penceresindeki `mission::gate`in sesli yoldaki esi).
    #[test]
    fn gorev_kimligi_dogrulanir() {
        assert!(gorev_id_gecerli("tsk_e5b2565c217a49d7b67cf28d4a74"));
        assert!(gorev_id_gecerli("tsk_00000000000000000000"));

        // Yol gezinmesi ve sema enjeksiyonu:
        assert!(!gorev_id_gecerli("tsk_../tools/memory/remember"));
        assert!(!gorev_id_gecerli("tsk_abc/../../health"));
        assert!(!gorev_id_gecerli("../../v1/health"));
        // Yanlis onek, bos, cok kisa, buyuk harf:
        assert!(!gorev_id_gecerli("agt_00000000000000000000"));
        assert!(!gorev_id_gecerli(""));
        assert!(!gorev_id_gecerli("tsk_kisa"));
        assert!(!gorev_id_gecerli("tsk_ABCDEFGHIJKLMNOPQRST"));
    }

    fn bildirim(ad: &str) -> serde_json::Value {
        tool_declarations()[0]["functionDeclarations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == ad)
            .unwrap_or_else(|| panic!("{ad} bildirilmeli"))
            .clone()
    }

    #[test]
    fn terminal_onayi_arac_bildiriminde_iki_adimli_sozlesmeyi_tasir() {
        let terminal = bildirim("terminal_calistir");
        let onay = &terminal["parameters"]["properties"]["onay"];
        assert_eq!(onay["type"], "BOOLEAN");
        let aciklama = onay["description"].as_str().expect("onay aciklamasi");
        for parca in [
            "Varsayilan false",
            "onay_gerekiyor",
            "acikca onayladiysa true",
        ] {
            assert!(aciklama.contains(parca), "onay bildiriminde '{parca}' yok");
        }
        assert!(!terminal["parameters"]["required"]
            .as_array()
            .expect("required")
            .iter()
            .any(|alan| alan == "onay"));
    }

    #[test]
    fn kod_gorevi_bildirimi_izin_listesi_ve_dogrulama_gercegini_soyler() {
        let arac = bildirim("kod_gorevi_ver");
        let aciklama = arac["description"].as_str().expect("aciklama");
        assert!(aciklama.contains("host dogrulamasi varsayilan KAPALIDIR"));
        assert!(!aciklama.contains("dogrulama ve diff kanitini toplar"));
        let dosyalar = arac["parameters"]["properties"]["dosyalar"]["description"]
            .as_str()
            .expect("dosyalar aciklamasi");
        for parca in ["SERT IZIN LISTESI", "baska dosyayi degistiremez"] {
            assert!(
                dosyalar.contains(parca),
                "dosyalar bildiriminde '{parca}' yok"
            );
        }
    }

    #[test]
    fn gorev_durum_bildirimi_atama_durumlarini_hedef_gostermez() {
        let arac = bildirim("gorev_durum");
        let hedef = arac["parameters"]["properties"]["durum"]["description"]
            .as_str()
            .expect("durum aciklamasi");
        assert_eq!(
            hedef.matches('|').count(),
            3,
            "dort elle durum olmali: {hedef}"
        );
        assert!(!hedef.contains("assigned"));
        assert!(!hedef.contains("in_progress"));
        assert!(hedef.contains("gorev_ata"));
        let aciklama = arac["description"].as_str().expect("aciklama");
        assert!(aciklama.contains("assigned ve in_progress bu aracta HEDEF OLAMAZ"));
        assert!(aciklama.contains("gorev_ata"));
    }

    #[test]
    fn kullaniciya_gorunen_arac_etiketleri_turkce_karakter_tasir() {
        let labels = tool_labels();
        for (ad, beklenen) in [
            ("hafizada_ara", "hafızada arıyor…"),
            ("terminal_calistir", "komut çalıştırıyor…"),
            ("kod_gorevi_ver", "kendi kodunu düzenliyor…"),
            ("gorev_durum", "görev durumunu değiştiriyor…"),
            ("ekran_akisi", "ekran akışını ayarlıyor…"),
        ] {
            assert_eq!(labels.get(ad).copied(), Some(beklenen), "{ad}");
        }
    }

    #[test]
    fn hatirlatma_araclari_bildirimi() {
        let kur = bildirim("hatirlatma_kur");
        assert_eq!(kur["parameters"]["required"], serde_json::json!(["metin"]));
        for alan in ["metin", "zaman"] {
            assert_eq!(kur["parameters"]["properties"][alan]["type"], "STRING");
        }
        assert_eq!(
            kur["parameters"]["properties"]["sure_dakika"]["type"],
            "INTEGER"
        );
        // Goreli zamani masaustu, takvim zamanini model cozer.
        let aciklama = kur["description"].as_str().unwrap();
        for parca in [
            "sure_dakika",
            "GUNCEL saat",
            "MUTLAK",
            "Europe/Istanbul",
            "tek kisa soru",
        ] {
            assert!(aciklama.contains(parca), "aciklamada '{parca}' yok");
        }
        assert_eq!(
            bildirim("hatirlatma_iptal")["parameters"]["required"],
            serde_json::json!(["id"])
        );
        assert!(bildirim("hatirlatmalari_listele")["parameters"]["required"].is_null());
        for ad in [
            "hatirlatma_kur",
            "hatirlatmalari_listele",
            "hatirlatma_iptal",
        ] {
            assert_eq!(bildirim(ad)["behavior"], "BLOCKING", "{ad}");
            assert!(arac_coz(ad).is_some(), "{ad}");
            assert!(tool_labels().get(ad).is_some_and(|e| !e.is_empty()), "{ad}");
        }
    }

    /// Kur ve iptal sahip kaniti ister (kisa ifade mirasi gecerli `Hafiza`
    /// sinifi); listeleme yalniz yabanciya kapali. Sinif tablodan gelir, bu test
    /// yanlis sinifa dusmeyi ve gercek kapi davranisini sabitler.
    #[test]
    fn hatirlatma_araclari_ses_izi_sinifi() {
        use crate::audio::speaker::{NO_FOREIGN_TOOLS, OWNER_ONLY_TOOLS};
        for ad in ["hatirlatma_kur", "hatirlatma_iptal"] {
            assert!(OWNER_ONLY_TOOLS.contains(&ad), "{ad} sahip-sart degil");
            assert!(!NO_FOREIGN_TOOLS.contains(&ad), "{ad} iki listede");
            assert_eq!(arac_bilgisi(ad).unwrap().sinif, SesSinifi::Hafiza);
        }
        assert!(NO_FOREIGN_TOOLS.contains(&"hatirlatmalari_listele"));
        assert!(!OWNER_ONLY_TOOLS.contains(&"hatirlatmalari_listele"));
        let armed = |v| crate::audio::speaker::SpeakerGate::armed_for_test(v);
        for ad in ["hatirlatma_kur", "hatirlatma_iptal"] {
            assert!(armed(SpeakerVerdict::Owner).check_tool(ad).is_ok(), "{ad}");
            for v in [SpeakerVerdict::Unknown, SpeakerVerdict::Foreign] {
                let (ret, _) = armed(v).check_tool(ad).unwrap_err();
                assert_eq!(ret, DENY_WRITE, "{ad} {v:?}");
            }
        }
        for v in [SpeakerVerdict::Owner, SpeakerVerdict::Unknown] {
            assert!(
                armed(v).check_tool("hatirlatmalari_listele").is_ok(),
                "{v:?}"
            );
        }
        assert_eq!(
            armed(SpeakerVerdict::Foreign)
                .check_tool("hatirlatmalari_listele")
                .unwrap_err()
                .0,
            DENY_TOOL
        );
    }

    #[test]
    fn hatirlatma_zamani_ofsetli_iso_8601_olmali() {
        for iyi in [
            "2026-10-04T10:00:00+03:00",
            "2026-10-04T10:00:00-05:30",
            "2026-10-04T07:00:00Z",
            "2026-10-04T10:00:00.250+03:00",
        ] {
            assert!(zaman_gecerli(iyi), "{iyi}");
        }
        for kotu in [
            "",
            "yarin 10'da",
            "2026-10-04",
            "2026-10-04T10:00",
            "2026-10-04T10:00:00",
            "2026-10-04T10:00:00+0300",
            "2026-10-04T10:00:00+03",
            "2026-10-04 10:00:00+03:00",
            "2026-13-04T10:00:00+03:00",
            "2026-10-32T10:00:00+03:00",
            "2026-10-04T24:00:00+03:00",
            "2026-10-04T10:60:00+03:00",
            "2026-10-04T10:00:60+03:00",
            "2026-10-04T10:00:00.+03:00",
            "2026-10-04T10:00:00+24:00",
            "26-10-04T10:00:00+03:00",
        ] {
            assert!(!zaman_gecerli(kotu), "{kotu:?} gecmemeliydi");
        }
    }

    #[test]
    fn goreli_hatirlatma_masaustu_saatinden_hesaplanir() {
        // 2026-10-03 10:30:00 +03:00 = 07:30:00Z.
        let simdi = 1_791_012_600;
        let (zaman, guncel) =
            hatirlatma_zamanini_coz(&serde_json::json!({"sure_dakika": 30}), simdi).unwrap();
        assert_eq!(guncel, "2026-10-03T10:30:00+03:00");
        assert_eq!(zaman, "2026-10-03T11:00:00+03:00");
        assert!(hatirlatma_zamanini_coz(
            &serde_json::json!({"zaman":"2026-10-04T09:00:00+03:00", "sure_dakika": 30}),
            simdi
        )
        .unwrap_err()
        .contains("birlikte"));
        for kotu in [0, 525_601] {
            assert!(
                hatirlatma_zamanini_coz(&serde_json::json!({"sure_dakika": kotu}), simdi).is_err()
            );
        }
    }

    #[test]
    fn hatirlatma_kur_gecersiz_girdiyi_gateway_oncesi_reddeder() {
        // Hata dispatch icinde doner: aga cikilmaz, model gerekceyi okur.
        let b = bridge(SpeakerVerdict::Owner);
        let uzun = "a".repeat(HATIRLATMA_MAX_KARAKTER + 1);
        for (args, parca) in [
            (serde_json::json!({}), "metin bos"),
            (
                serde_json::json!({ "metin": "  ", "zaman": "2026-10-04T10:00:00+03:00" }),
                "metin bos",
            ),
            (
                serde_json::json!({ "metin": uzun, "zaman": "2026-10-04T10:00:00+03:00" }),
                "500 karakter",
            ),
            (
                serde_json::json!({ "metin": "toplanti", "zaman": "yarin 10'da" }),
                "ISO 8601",
            ),
            (
                serde_json::json!({ "metin": "toplanti", "zaman": "2026-10-04T10:00:00" }),
                "ofsetli",
            ),
        ] {
            let out = b.call("hatirlatma_kur", &args);
            assert!(
                out["hata"].as_str().unwrap_or_default().contains(parca),
                "{args} -> {out}"
            );
        }
    }

    #[test]
    fn hatirlatma_kimligi_url_yoluna_girmeden_dogrulanir() {
        assert!(onekli_id_gecerli(
            "rem_",
            "rem_0123456789abcdef0123456789abcdef"
        ));
        for kotu in [
            "",
            "rem_",
            "rem_kisa",
            "tsk_0123456789abcdef0123456789abcdef",
            "rem_../tools/memory/remember",
            "rem_0123456789abcdef/../../health",
            "rem_0123456789ABCDEF0123456789ABCDEF",
            "../v1/health",
        ] {
            assert!(!onekli_id_gecerli("rem_", kotu), "{kotu:?}");
            let out = bridge(SpeakerVerdict::Owner)
                .call("hatirlatma_iptal", &serde_json::json!({ "id": kotu }));
            assert_eq!(out["hata"], HATIRLATMA_ID_GECERSIZ, "{kotu:?}");
        }
        // Gorev kimligi kapisi ayni yardimciyla ayni davranir.
        assert!(gorev_id_gecerli("tsk_00000000000000000000"));
        assert!(!onekli_id_gecerli(
            "tsk_",
            "rem_0123456789abcdef0123456789abcdef"
        ));
    }

    #[test]
    fn profil_araclari_bildirimi() {
        let kaydet = bildirim("profil_kaydet");
        assert_eq!(
            kaydet["parameters"]["required"],
            serde_json::json!(["anahtar", "deger"])
        );
        for alan in ["anahtar", "deger"] {
            assert_eq!(kaydet["parameters"]["properties"][alan]["type"], "STRING");
        }
        // Ayrim sozlesmedir: kalici kisisel bilgi profile, olay/not hafizaya; yalniz
        // acik talepte; anahtari model Ingilizceye/ASCII'ye cevirir.
        let aciklama = kaydet["description"].as_str().unwrap();
        for parca in [
            "KALICI",
            "ACIKCA",
            "KAYDETME",
            "ASCII kucuk harf",
            "hafizaya_kaydet",
            "profil_kaydet",
        ] {
            assert!(aciklama.contains(parca), "aciklamada '{parca}' yok");
        }
        assert_eq!(
            bildirim("profil_sil")["parameters"]["required"],
            serde_json::json!(["anahtar"])
        );
        assert!(bildirim("profil_sil")["description"]
            .as_str()
            .unwrap()
            .contains("UYDURMA"));
        for ad in ["profil_kaydet", "profil_sil"] {
            assert_eq!(bildirim(ad)["behavior"], "BLOCKING", "{ad}");
            assert!(tool_labels().get(ad).is_some_and(|e| !e.is_empty()), "{ad}");
        }
    }

    #[test]
    fn hafiza_sorusu_arac_sozlesmesi() {
        let cevapla = bildirim("hafiza_sorusu_cevapla");
        assert_eq!(
            cevapla["parameters"]["required"],
            serde_json::json!(["id", "cevap"])
        );
        let gec = bildirim("hafiza_sorusu_gec");
        assert_eq!(
            gec["parameters"]["required"],
            serde_json::json!(["id", "kalici"])
        );
        assert_eq!(gec["parameters"]["properties"]["kalici"]["type"], "BOOLEAN");
        for ad in ["hafiza_sorusu_cevapla", "hafiza_sorusu_gec"] {
            assert_eq!(bildirim(ad)["behavior"], "BLOCKING", "{ad}");
            assert_eq!(arac_bilgisi(ad).unwrap().sinif, SesSinifi::Hafiza, "{ad}");
        }
        let b = bridge(SpeakerVerdict::Owner);
        assert_eq!(
            b.call(
                "hafiza_sorusu_gec",
                &serde_json::json!({
                    "id": "gap_00000000000000000000",
                    "kalici": false
                })
            ),
            serde_json::json!({ "ok": true, "durum": "bu oturum ertelendi" })
        );
        for kotu in [
            "",
            "gap_kisa",
            "../health",
            "gap_00000000000000000000/answer",
        ] {
            let out = b.call(
                "hafiza_sorusu_cevapla",
                &serde_json::json!({ "id": kotu, "cevap": "cevap" }),
            );
            assert_eq!(out["hata"], HAFIZA_SORUSU_ID_GECERSIZ, "{kotu}");
        }
    }

    /// Profil araclari `hafizaya_kaydet` ile AYNI ses izi sinifindadir (sahip-sart,
    /// acik talep): Cihan degilse ya da dogrulanamadiysa yazilmaz.
    #[test]
    fn profil_araclari_hafizaya_kaydet_ile_ayni_ses_izi_sinifi() {
        use crate::audio::speaker::OWNER_ONLY_TOOLS;
        let hafiza = arac_bilgisi("hafizaya_kaydet").unwrap().sinif;
        for ad in ["profil_kaydet", "profil_sil"] {
            assert_eq!(arac_bilgisi(ad).unwrap().sinif, hafiza, "{ad}");
            assert!(OWNER_ONLY_TOOLS.contains(&ad), "{ad} sahip-sart degil");
            assert!(arac_coz(ad).is_some());
            let armed = |v| crate::audio::speaker::SpeakerGate::armed_for_test(v);
            assert!(armed(SpeakerVerdict::Owner).check_tool(ad).is_ok(), "{ad}");
            for v in [SpeakerVerdict::Unknown, SpeakerVerdict::Foreign] {
                let (ret, _) = armed(v).check_tool(ad).unwrap_err();
                assert_eq!(ret, DENY_WRITE, "{ad} {v:?}");
            }
            // Dogrulayici yokken (sidecar kapali) da yazilmaz: fail-closed.
            assert!(crate::audio::speaker::SpeakerGate::disabled()
                .check_tool(ad)
                .is_err());
        }
    }

    #[test]
    fn profil_girdisi_gateway_oncesi_dogrulanir_yol_gecisi_yok() {
        let b = bridge(SpeakerVerdict::Owner);
        let uzun = "a".repeat(301);
        for (args, beklenen) in [
            (serde_json::json!({}), profil::ANAHTAR_GECERSIZ),
            (
                serde_json::json!({ "anahtar": "Sehir", "deger": "Istanbul" }),
                profil::ANAHTAR_GECERSIZ,
            ),
            (
                serde_json::json!({ "anahtar": "şehir", "deger": "Istanbul" }),
                profil::ANAHTAR_GECERSIZ,
            ),
            (
                serde_json::json!({ "anahtar": "s", "deger": "Istanbul" }),
                profil::ANAHTAR_GECERSIZ,
            ),
            (
                serde_json::json!({ "anahtar": "../tools/memory", "deger": "x" }),
                profil::ANAHTAR_GECERSIZ,
            ),
            (
                serde_json::json!({ "anahtar": "a".repeat(41), "deger": "x" }),
                profil::ANAHTAR_GECERSIZ,
            ),
            (
                serde_json::json!({ "anahtar": "sehir", "deger": "  " }),
                profil::DEGER_GECERSIZ,
            ),
            (
                serde_json::json!({ "anahtar": "sehir" }),
                profil::DEGER_GECERSIZ,
            ),
            (
                serde_json::json!({ "anahtar": "sehir", "deger": "iki\nsatir" }),
                profil::DEGER_GECERSIZ,
            ),
            (
                serde_json::json!({ "anahtar": "sehir", "deger": "ayirici\u{2028}x" }),
                profil::DEGER_GECERSIZ,
            ),
            (
                serde_json::json!({ "anahtar": "sehir", "deger": uzun }),
                profil::DEGER_GECERSIZ,
            ),
        ] {
            let out = b.call("profil_kaydet", &args);
            assert_eq!(out["hata"], beklenen, "{args}");
        }
        for anahtar in ["", "Sehir", "../x", "sehir/../../v1/health", "a b"] {
            let out = b.call("profil_sil", &serde_json::json!({ "anahtar": anahtar }));
            assert_eq!(out["hata"], profil::ANAHTAR_GECERSIZ, "{anahtar:?}");
        }
        // Sinirdaki gecerli girdi dogrulamadan gecer (kontrol profil modulunde).
        assert!(profil::deger_gecerli(&"a".repeat(300)));
        assert!(profil::anahtar_gecerli("dogum_gunu"));
    }

    #[test]
    fn idempotency_anahtari_yalniz_gecerli_cagri_kimliginden_gelir() {
        assert_eq!(
            idempotency_anahtari("function-call-17180290239840201325"),
            Some("function-call-17180290239840201325")
        );
        assert_eq!(idempotency_anahtari("a"), Some("a"));
        assert_eq!(
            idempotency_anahtari(&"x".repeat(80)).map(str::len),
            Some(80)
        );
        for kotu in ["", "satir\nsonu", "türkçe", &"x".repeat(81)] {
            assert_eq!(idempotency_anahtari(kotu), None, "{kotu:?}");
        }
    }

    /// Wire degerleri sabitlenir: `lib.rs`'teki `tool_event_wire_semasi` bu
    /// metinleri duz yazarak serilesmeyi dogruluyor (sabitler bu modulun
    /// disina cikmiyor). Deger degisirse React'in `durum` karsilastirmasi
    /// sessizce eslesmez olurdu : bu test o degisiklige kapi koyar.
    #[test]
    fn durum_degerleri_wire_ile_ayni() {
        assert_eq!(TOOL_BASLADI, "basladi");
        assert_eq!(TOOL_BITTI, "bitti");
        assert_eq!(TOOL_REDDEDILDI, "reddedildi");
    }

    #[test]
    fn gecen_arac_basladi_ve_bitti_olayi_uretir() {
        // Aga cikmayan bir arac secildi (bilinmeyen ad -> dispatch hemen hata
        // doner): olculen sey olay SIRASI, arac ciktisi degil.
        let (b, mut rx) = bridge_ev(SpeakerVerdict::Owner);
        let _ = b.call("bilinmeyen_arac_xyz", &serde_json::json!({}));
        let olaylar = olaylari_topla(&mut rx);
        assert_eq!(
            olaylar,
            vec![
                ("bilinmeyen_arac_xyz".to_string(), TOOL_BASLADI, None),
                ("bilinmeyen_arac_xyz".to_string(), TOOL_BITTI, None),
            ]
        );
    }

    #[test]
    fn reddedilen_arac_bitti_yerine_reddedildi_yayinlar() {
        let (b, mut rx) = bridge_ev(SpeakerVerdict::Foreign);
        let out = b.call(
            "terminal_calistir",
            &serde_json::json!({ "komut": "echo x" }),
        );
        assert_eq!(out["hata"].as_str(), Some(DENY_TOOL));

        let olaylar = olaylari_topla(&mut rx);
        assert_eq!(
            olaylar.len(),
            2,
            "basladi + reddedildi beklendi: {olaylar:?}"
        );
        assert_eq!(
            olaylar[0],
            ("terminal_calistir".to_string(), TOOL_BASLADI, None)
        );
        let (ad, durum, sebep) = &olaylar[1];
        assert_eq!(ad, "terminal_calistir");
        assert_eq!(*durum, TOOL_REDDEDILDI);
        // Sebep UI'da gosterilecek: bos gecmesi ozelligi anlamsiz kilar.
        assert!(
            sebep.as_deref().unwrap_or_default().contains("Cihan degil"),
            "sebep bos veya beklenmeyen: {sebep:?}"
        );
        // KRITIK: reddedilen cagri `bitti` YAYINLAMAZ : aksi halde UI islemin
        // yapildigini gosterirdi.
        assert!(
            !olaylar.iter().any(|(_, d, _)| *d == TOOL_BITTI),
            "reddedilen cagri icin bitti yayinlandi: {olaylar:?}"
        );
    }

    #[test]
    fn olay_kanali_yoksa_arac_yine_calisir() {
        // Gorunurluk bir teshis katmani: kanal yokken (veya alici dustugunde)
        // arac yurutmesi AYNEN devam etmeli.
        let (b, rx) = bridge_ev(SpeakerVerdict::Owner);
        drop(rx); // alici dustu → send() Err doner
        let out = b.call("bilinmeyen_arac_xyz", &serde_json::json!({}));
        assert!(out["hata"]
            .as_str()
            .unwrap_or_default()
            .contains("bilinmeyen arac"));
    }

    #[test]
    fn yabanci_ses_hafizaya_yazamaz() {
        let b = bridge(SpeakerVerdict::Foreign);
        for tool in ["hafizaya_kaydet_ACIK_TALEP_ILE", "hafizaya_kaydet"] {
            let out = b.call(tool, &serde_json::json!({ "icerik": "yabanci bir cumle" }));
            assert_eq!(
                out["hata"].as_str(),
                Some(DENY_WRITE),
                "{tool} gecmemeliydi"
            );
            assert!(out["neden"]
                .as_str()
                .unwrap_or_default()
                .contains("Cihan degil"));
        }
    }

    #[test]
    fn dogrulama_yoksa_yazma_bloke_kalir() {
        // Sidecar kapali / kayit yok senaryosu: fail-safe yazmayi kapatir.
        let out = bridge(SpeakerVerdict::Unknown)
            .call("hafizaya_kaydet", &serde_json::json!({ "icerik": "x" }));
        assert_eq!(out["hata"].as_str(), Some(DENY_WRITE));
    }

    #[test]
    fn yabanci_ses_terminal_komutu_calistirmaz() {
        // KANIT: komut gercekten calisirsa bu dosya olusur. Ret dispatch'ten
        // once oldugu icin dosya ASLA olusmamali.
        let sentinel = std::env::temp_dir().join("smith-speaker-gate-sentinel.txt");
        let _ = std::fs::remove_file(&sentinel);
        let out = bridge(SpeakerVerdict::Foreign).call(
            "terminal_calistir",
            &serde_json::json!({ "komut": format!("Set-Content -Path '{}' -Value 1", sentinel.display()) }),
        );
        assert_eq!(out["hata"].as_str(), Some(DENY_TOOL));
        assert!(
            !sentinel.exists(),
            "komut calismis: kapi dispatch'ten sonra kalmis"
        );
    }

    #[test]
    fn kapi_listede_olmayan_araci_engellemez() {
        // Kapi genel bir kilit DEGIL: yalniz yazma ve hassas araclar. Listede
        // olmayan bir ad, karar ne olursa olsun normal dispatch'e gider.
        for v in [
            SpeakerVerdict::Foreign,
            SpeakerVerdict::Unknown,
            SpeakerVerdict::Owner,
        ] {
            let out = bridge(v).call("bilinmeyen_arac_xyz", &serde_json::json!({}));
            let hata = out["hata"].as_str().unwrap_or_default();
            assert!(hata.contains("bilinmeyen arac"), "{v:?} -> {hata}");
        }
    }

    /// Uctan uca KARE KARARI: `lib.rs` gibi besleyen sentetik dizi (konusma,
    /// yanki kapisi, sustur, sessizlik) ve gercek durum makinesi. Kapali
    /// donemde SIFIR kare, konusmada kare, her akis sonunda tek audioStreamEnd.
    #[test]
    fn kapali_donem_sifir_kare_uretir_konusma_kare_uretir() {
        use crate::audio::vad::{KapiCikti, KareDurumu, MikKapisi};
        let mut kapi = MikKapisi::new(1000);
        let konusma = vec![0.2f32; 320];
        let sessiz_mik = vec![0.001f32; 320];
        let sifir = vec![0.0f32; 320];
        let mut gonderilen_kapali = 0usize;
        let mut gonderilen_konusma = 0usize;
        let mut akis_sonu = 0usize;
        // 1 sn konusma
        for _ in 0..50 {
            for c in kapi.adim(&konusma, KareDurumu::Konusma) {
                match c {
                    KapiCikti::Ses(v) => gonderilen_konusma += v.len(),
                    KapiCikti::AkisSonu => akis_sonu += 1,
                }
            }
        }
        // Smith konusuyor (yanki kapisi): 3 sn tam sifir kare. Karar capture bayragindan.
        for _ in 0..150 {
            for c in kapi.adim(&sifir, KareDurumu::Kapali) {
                match c {
                    KapiCikti::Ses(v) => gonderilen_kapali += v.len(),
                    KapiCikti::AkisSonu => akis_sonu += 1,
                }
            }
        }
        // Yanki bitti, mikrofon acik ama sessiz: 5 sn.
        for _ in 0..250 {
            for c in kapi.adim(&sessiz_mik, KareDurumu::Sessiz) {
                match c {
                    KapiCikti::Ses(v) => gonderilen_kapali += v.len(),
                    KapiCikti::AkisSonu => akis_sonu += 1,
                }
            }
        }
        assert_eq!(gonderilen_konusma, 50 * 320);
        assert_eq!(gonderilen_kapali, 0, "kapali/sessiz donemde kare gitti");
        assert_eq!(akis_sonu, 1, "yanki kapisi akisi bir kez kapatmali");
    }

    // ---- EKRAN AKISI ----

    #[test]
    fn ekran_akisi_olayi_sozlesmesi() {
        for (acik, durum) in [(true, "akis_acik"), (false, "akis_kapali")] {
            let LiveEvent::Tool {
                ad,
                durum: d,
                sebep,
            } = ekran_akisi_olayi(acik)
            else {
                panic!("Tool olayi bekleniyordu");
            };
            assert_eq!(ad, "ekran_akisi_durumu");
            assert_eq!(d, durum);
            let s: serde_json::Value =
                serde_json::from_str(&sebep.expect("sebep JSON")).expect("JSON");
            assert_eq!(s, serde_json::json!({ "akis_acik": acik }));
        }
    }

    #[test]
    fn ekran_akisi_bildirimi_boolean_acik_ister() {
        let tools = tool_declarations();
        let d = tools[0]["functionDeclarations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "ekran_akisi")
            .expect("ekran_akisi bildirilmeli");
        assert_eq!(d["parameters"]["required"], serde_json::json!(["acik"]));
        assert_eq!(d["parameters"]["properties"]["acik"]["type"], "BOOLEAN");
        assert_eq!(arac_coz("ekran_akisi"), Some(Arac::EkranAkisi));
    }

    /// Ses izi kapisi: yabanci/kararsiz ses surekli izlemeyi acamaz ve bayrak
    /// DEGISMEZ; sahip acip kapatir; eksik arguman hata doner. GLOBAL ekran
    /// bayragina dokunan TEK test (paralel testlerle yaris olmasin diye).
    #[test]
    fn ekran_akisi_araci_bayragi_cevirir() {
        let eski = crate::audio::screen::akis_acik();
        crate::audio::screen::akis_ayarla(false);

        for v in [SpeakerVerdict::Foreign, SpeakerVerdict::Unknown] {
            let out = bridge(v).call("ekran_akisi", &serde_json::json!({ "acik": true }));
            assert_eq!(
                out["hata"].as_str(),
                Some(crate::audio::speaker::DENY_SCREEN),
                "{v:?}"
            );
            assert!(!crate::audio::screen::akis_acik(), "{v:?} akisi acabildi");
        }

        let (b, mut rx) = bridge_ev(SpeakerVerdict::Owner);
        let out = b.call("ekran_akisi", &serde_json::json!({ "acik": true }));
        assert_eq!(out["akis_acik"], true, "{out}");
        assert!(crate::audio::screen::akis_acik());
        assert!(crate::audio::screen::enabled(), "enabled() akisi izlemeli");
        let out = b.call("ekran_akisi", &serde_json::json!({ "acik": false }));
        assert_eq!(out["akis_acik"], false, "{out}");
        assert!(!crate::audio::screen::akis_acik());

        // Eksik / yanlis tipli arguman: hata, bayrak degismez.
        crate::audio::screen::akis_ayarla(true);
        for args in [
            serde_json::json!({}),
            serde_json::json!({ "acik": "true" }),
            serde_json::json!({ "acik": 1 }),
        ] {
            let out = b.call("ekran_akisi", &args);
            assert!(out["hata"].is_string(), "{args} -> {out}");
            assert!(
                crate::audio::screen::akis_acik(),
                "{args} bayragi degistirdi"
            );
        }

        // Gorunurluk: her cagri basladi + bitti.
        let adlar: Vec<(String, &str)> = olaylari_topla(&mut rx)
            .into_iter()
            .map(|(ad, durum, _)| (ad, durum))
            .collect();
        assert!(adlar.contains(&("ekran_akisi".to_string(), TOOL_BASLADI)));
        assert!(adlar.contains(&("ekran_akisi".to_string(), TOOL_BITTI)));

        // Kapatma her ses icin ve sidecar kurulmadan da serbesttir.
        for v in [SpeakerVerdict::Unknown, SpeakerVerdict::Foreign] {
            crate::audio::screen::akis_ayarla(true);
            let out = bridge(v).call("ekran_akisi", &serde_json::json!({ "acik": false }));
            assert_eq!(out["akis_acik"], false);
            assert!(!crate::audio::screen::akis_acik());
        }
        let disabled = ToolBridge::from_env(
            Arc::new(crate::audio::speaker::SpeakerGate::disabled()),
            None,
        );
        crate::audio::screen::akis_ayarla(true);
        assert_eq!(
            disabled.call("ekran_akisi", &serde_json::json!({ "acik": false }))["akis_acik"],
            false
        );
        assert!(
            disabled.call("ekran_akisi", &serde_json::json!({ "acik": true }))["hata"].is_string()
        );
        assert!(!crate::audio::screen::akis_acik());
        crate::audio::screen::akis_ayarla(eski);
    }
}

#[cfg(test)]
pub(crate) const fn sinif_adet(sinif: SesSinifi) -> usize {
    let mut n = 0;
    let mut i = 0;
    while i < ARACLAR.len() {
        if ARACLAR[i].sinif as u8 == sinif as u8 {
            n += 1 + ARACLAR[i].aliases.len();
        }
        i += 1;
    }
    n
}

#[cfg(test)]
pub(crate) const fn sinif_adlari<const N: usize>(sinif: SesSinifi) -> [&'static str; N] {
    let mut adlar = [""; N];
    let mut n = 0;
    let mut i = 0;
    while i < ARACLAR.len() {
        let a = &ARACLAR[i];
        if a.sinif as u8 == sinif as u8 {
            adlar[n] = a.ad;
            n += 1;
            let mut j = 0;
            while j < a.aliases.len() {
                adlar[n] = a.aliases[j];
                n += 1;
                j += 1;
            }
        }
        i += 1;
    }
    adlar
}
