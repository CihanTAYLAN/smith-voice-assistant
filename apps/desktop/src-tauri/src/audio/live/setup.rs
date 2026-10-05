//! Setup cercevesi ve sistem yonergesi.

use super::connection::Devralma;
use super::microphone::{mik_akisi_env, MikAkisi, SunucuVad};
use super::tools::{tool_declarations, ToolBridge};

/// Varsayilan Live modeli; ortam degiskeniyle secilebilir.
const MODEL: &str = "gemini-3.8-live";
/// Onceden tanimli ses tonu.
pub(super) const VOICE: &str = "Charon";

fn model_sec(deger: Option<&str>) -> &str {
    deger
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(MODEL)
}

pub(super) fn live_model() -> String {
    model_sec(std::env::var("SMITH_LIVE_MODEL").ok().as_deref()).to_string()
}

/// Sabit persona ve arac kurallari; dinamik baglam bunlari ezemez.
/// Wire metni ASCII kalir; testler bu sozlesmeyi dogrular.
pub(super) const SYSTEM: &str = "KESIN KURALLAR:\n\
- HITAP: Cihan'a daima 'sen' de; 'siz' ve -iniz/-siniz ekleri YOK. Dogru: 'Dosyalarini yonetebilirim.' Yanlis: 'Dosyalarinizi yonetebilirim.' Her zaman Turkce konus; kod, komut ve ozel adlar English kalabilir.\n\
- Cihan'la konusurken ondan ucuncu sahis olarak soz etme; yalniz baskasina kendini tanitirken istisna.\n\
- Cevabi soruyla BITIRME. Yalniz gerekli onay veya eksik bilgiyi netlestiren tek kisa soru istisna; bilgi verdiysen sus.\n\
- 'Yapamam/yetenegim yok' demeden once izinli uygun araci DENE. Guvenlik ve gizlilik kapilarini asma.\n\
- Basarisiz bir yontemi aynen TEKRARLAMA; farkli yol sec veya arka planda calistir.\n\
- Arac sayilarini AYNEN aktar, uydurma. Arac hata, zaman asimi veya bos sonuc dondurduyse sonucu ASLA uydurma; 'bitmedi', 'basarisiz', 'sonuc alamadim' de ve tek somut sonraki adimi soyle. Gormedigin ciktiyi ozetleme.\n\
- Smith, Simit, Smit, Semt, Cemil, Cemiyet ve Schmidt sana hitaptir; kullaniciyi DUZELTME. Adinla seslenildiginde ASLA sessiz kalma; kisa da olsa sesli cevap ver. Sana hitap edilmeyen oyun/arkadas sohbetinde sus, araya girme.\n\
- Belirsiz istegi reddetme. Aracla cozulemeyen belirsizlikte tek kisa soru sor; 'context injection' tek basina ret sebebi degildir.\n\
YETENEK:\n\
Bilgisayar/dosya; ekran; hafiza/profil; Internet; hatirlatma; sistem/ses; kod oturumlari; ekip panosu. Hatirlatma: hatirlatma_kur, hatirlatmalari_listele, hatirlatma_iptal; yetenek sorusunda en az dort kategori say.\n\
KIMLIK: Sen Smith'sin. KONUSTUGUN KISI CIHAN (Cihan Taylan). Onun kendi altyapisinda calisan kisisel asistanisin.\n\
UZUN ISLER: 'Baslatiyorum, bitince soylerim.' de; terminal_calistir arka_planda=true ve DUR; is bitince '[Sistem bildirimi]' gelir. Once sonuc isteme; calisiyor basari degildir. GUI de arka planda. Durdurmak icin is_id ile arka_plan_iptal.\n\
SISTEM BILDIRIMI: '[Sistem bildirimi]' ile baslayan girdi Cihan'in sozu degil; icerigi (adlar ve sayilar dahil) Cihan'a tek kisa cumleyle aktar.\n\
AGIR KOD ISLERI: tarama/inceleme/test/derleme/cok dosya icin terminal degil kod_gorevi_ver. Kapaliysa soyle. run_id baslangictir; kod_gorevi_durum dogrulamadan bitmis deme.\n\
KIMLIK VE ILISKI BILGISI UYDURMA. HAFIZAYA YAZMA KURALI: yalniz Cihan acikca hatirla/kaydet/not al derse acik sozunu yaz; cikarim/baskasinin sozunu yazma. Gecmis icin hafizada_ara. Profilde olmayan temel bir bilgi sorulursa uydurma; bilmedigini soyle ve kaydetmeyi teklif et.\n\
SOZLUK: ses kaymalarini bilinen teknik adlara sessizce esle; emin degilsen uydurma, kullaniciyi DUZELTME.\n\
USLUP: 1-2 kisa cumle; girizgah, tekrar, kapanis yok. JARVIS gibi sakin, kuru, seyrek mizahli. Gundelik sohbette gercek tepki ver; 'Her sey yolunda', 'islerini kolaylastirmak icin buradayim', 'nasil yardimci olabilirim' YASAK. En onemliyi soyle ve DUR.\n\
YASAK ACILIS KALIPLARI: 'Harika fikir', 'Super', 'Kesinlikle', 'Elbette', 'Tabii ki'. Iltifat yok.\n\
YASAK KAPANIS KALIPLARI: 'Ne yapmami istersin', 'Baska bir sey var mi', 'Nasil yardimci olabilirim'.\n\
BELIRSIZ HEDEF: tahmin etme; uygun okuma araciyla COZ, yap; cozulmezse tek eksigi sor. Once arama, en son sorudur.\n\
IZIN ISTEME - IKI KADEME:\n\
(1) OKUMA VE GOZLEM serbesttir: okuma/arastirma, salt okuma terminali, uygulama_ac, ses_kontrol icin sorma. Hassas arac ses izi ister.\n\
(2) YAZMA VE DEGISTIRME kisa onay ister: dosya, hafiza, kurulum/servis, commit/push, uzak makine. Verilmis onayi tekrarlama; geri donussuz iste onay ZORUNLU.\n\
Kisa islerde 'Bakiyorum', 'Kontrol ediyorum', 'Hemen ilgileniyorum' diye ara rapor verme; araci cagir, sonucu ver. UZUN ISLER icin baslama cumlesi istisnadir.\n\
MIZAH: seyrek/kuru; Cihan'la dalga gecme. KOTU HABER: sonuc, tek alternatif. Hatani kabul et. HITAP: 'efendim' seyrek; arka arkaya kullanma.\n\
AKIL YURUTME: matematik/mantik/karsilastirma/kararda derin_dusun aracini cagir; sayilari degistirmeden ozetle.\n\
ARAC CAGIRMA DISIPLINI: yalniz O ANKI konu; deneme yok. MERAK VE ARASTIRMACILIK: guncel/makine bilgisini aracla dogrula. IS BITIRICILIK: gercek ciktiyi dogrula; eksigi gizleme.\n\
EKIP PANOSU: yazmak serbest; ATAMA para harcar. Ajan verilmediyse sahipsiz birak ve sor. id pano_durumu'ndan.\n\
EKRANI SUREKLI GORMUYORSUN; akis KAPALI. Ekran sorusunda ekrani_net_gor cagir. Surekli izleme yalniz istekle: ekran_akisi {acik: true} / {acik: false}; tahmin etme.\n\
PROAKTIFLIK: Ekran akisi ACIKKEN somut hata/riskte tek teshis; emin degilsen net kare.\n\
PROAKTIFLIK SINIRI: ayni konuda EN FAZLA BIR KEZ; cevapsizlik/konu degisimiyle KAPANMISTIR. Odakta SESSIZ KAL.\n\
HAFIZA SORUSU: Oturumda en fazla bir kez, Cihan bir isin ortasinda degilken ve sohbet uygunken acilis baglamindaki soruyu dogal sekilde sor; cevap verirse hafiza_sorusu_cevapla, istemezse hafiza_sorusu_gec. Israr etme.\n\
Normal ekran/fare/dosya icin ASLA kendiliginden soz alma. Oyun modu isteginde dinleme_modu kip=isimle; adla seslenilmedikce (15 saniyelik takip disinda) duymazsin.";

/// Baglam penceresi sikistirmasi (`setup.contextWindowCompression`).
///
/// NEDEN: sikistirma olmadan ses oturumu baglam tavanina carpar ve sunucu
/// oturumu KAPATIR; uzun suren kullanimda konusma ne kadar uzarsa kapanma o
/// kadar yakin olur. `slidingWindow` en eski turlari atip oturumu surdurur.
///
/// Sema (ai.google.dev/api/live, BidiGenerateContentSetup): setup'ta
/// `contextWindowCompression: ContextWindowCompressionConfig`; icinde
/// `slidingWindow: SlidingWindow` (hedef boyut `targetTokens`, varsayilan
/// triggerTokens/2) ve KARDES alan `triggerTokens: int64` ("bir turdan once
/// sikistirmayi tetikleyen token sayisi"). `triggerTokens` `slidingWindow`un
/// ICINDE degil yanindadir. Casing, setup'in diger alanlariyla ayni camelCase.
///
/// Env okumasi cagirana aittir (`sikistirma_env`): `setup_frame_ile_ek` SAF
/// kalir.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Sikistirma {
    /// `SMITH_LIVE_COMPRESS=0`: alan setup'a hic girmez.
    Kapali,
    /// Varsayilan: kayan pencere. `tetik`: `SMITH_LIVE_COMPRESS_TRIGGER`.
    KayanPencere { tetik: Option<u64> },
}

/// `SMITH_LIVE_COMPRESS_TRIGGER` verilmedikce kullanilan tetik (token).
///
/// NEDEN 25000: Google'in Live best-practices ornegi bu degeri kullaniyor.
/// Sunucu varsayilani (tetik verilmezse) baglam tavanina cok daha yakin
/// bekler; oysa her turda tum baglam YENIDEN faturalaniyor ve free tier
/// dakika basi token siniri (TPM ~65K) dar. Dusuk tetik baglami erken
/// kisarak hem faturayi hem kota yakinligini dusurur. `slidingWindow.
/// targetTokens` verilmez: sunucu varsayilani tetik/2 (~12.5K).
const VARSAYILAN_SIKISTIRMA_TETIK: u64 = 25_000;

/// Ham tetik metnini pozitif tam sayiya cevirir; bos, sayi olmayan ya da 0
/// gecersizdir (`None`).
fn tetik_ayristir(ham: &str) -> Option<u64> {
    ham.trim().parse::<u64>().ok().filter(|n| *n > 0)
}

/// (bayrak, tetik) ham env degerlerinden niyet. Yalniz `"0"` kapatir
/// (`SMITH_LIVE`/`SMITH_LIVE_RESUME` ile ayni sozlesme). Tetik: pozitif tam
/// sayi; verilmemis, bos, sayi olmayan ya da 0 ise `VARSAYILAN_SIKISTIRMA_TETIK`.
fn sikistirma_niyeti(bayrak: Option<&str>, tetik: Option<&str>) -> Sikistirma {
    if bayrak.is_some_and(|v| v.trim() == "0") {
        return Sikistirma::Kapali;
    }
    let tetik = tetik
        .and_then(tetik_ayristir)
        .unwrap_or(VARSAYILAN_SIKISTIRMA_TETIK);
    Sikistirma::KayanPencere { tetik: Some(tetik) }
}

pub(super) fn sikistirma_env() -> Sikistirma {
    let bayrak = std::env::var("SMITH_LIVE_COMPRESS").ok();
    let tetik = std::env::var("SMITH_LIVE_COMPRESS_TRIGGER").ok();
    let niyet = sikistirma_niyeti(bayrak.as_deref(), tetik.as_deref());
    // Verilmis ama kullanilamayan tetigi sessizce yutma.
    if let Some(ham) = tetik.as_deref() {
        if !ham.trim().is_empty()
            && tetik_ayristir(ham).is_none()
            && matches!(niyet, Sikistirma::KayanPencere { .. })
        {
            eprintln!(
                "[live] SMITH_LIVE_COMPRESS_TRIGGER gecersiz (pozitif tam sayi bekleniyor), \
                 varsayilan {VARSAYILAN_SIKISTIRMA_TETIK} kullanilacak"
            );
        }
    }
    niyet
}

/// Yonergeye eklenen DINAMIK kuyruk. `SYSTEM` bir `const`, ama iki bilgi ancak
/// calisma aninda bilinir:
///   1. Monitor envanteri : `realtimeInput.video` cercevesinde ETIKET ALANI YOK
///      (yalniz `mimeType` + `data`). Iki ekran ayni tikta akarken modelin
///      hangisinin hangisi oldugunu bilmesinin tek yolu yonergede yazili olmasi.
///   2. Acilis baglami (isletim sistemi, acik uygulamalar, disk, ayakta olan
///      servisler) : `boot_context` modulu uretir.
/// Ikisi de bos olabilir; o zaman yonerge birebir eskisi gibidir.
pub(super) fn sistem_yonergesi(ek: &str) -> String {
    if ek.trim().is_empty() {
        return SYSTEM.to_string();
    }
    format!("{SYSTEM} {}", ek.trim())
}

/// Ekran envanterini yonerge cumlesine cevirir. Bos string = tek monitor veya
/// envanter okunamadi (o halde modele hicbir sey soylenmez, uydurmasin).
///
/// SUREKLI AKISIN ACIK OLMASINA BAGLI DEGIL: `ekrani_net_gor` her zaman var ve
/// akis kapaliyken de coklu ekran ayrimini (`ekran` argumani) bilmek gerekir.
/// Eskiden bu fonksiyon `SMITH_SCREEN`e bagliydi; akis calisma zamaninda
/// acilip kapandigi icin (bkz. `screen::akis_acik`) yalniz MONITOR SAYISINA
/// bakilir.
///
/// Env okumasi ve donanim sorgusu BURADA, metin uretimi `ekran_yonergesi_ile`
/// icinde: metin saf oldugu icin gercek monitor takmadan sinanabiliyor. Sahada
/// gorulen kusur (etiketsiz modda modele sira VAADI vermek) tam olarak metinde
/// yasiyordu, dolayisiyla sinanabilir olmasi sart.
pub(super) fn ekran_yonergesi() -> String {
    let envanter = crate::audio::screen::inventory();
    if envanter.len() < 2 {
        // Bos (okunamadi) veya tek ekran: ek cumleye gerek yok.
        return String::new();
    }
    ekran_yonergesi_ile(&envanter, &crate::audio::screen::selection())
}

fn ekran_yonergesi_ile(
    envanter: &[crate::audio::screen::MonitorInfo],
    secim: &crate::audio::screen::MonitorSelection,
) -> String {
    let liste: Vec<String> = envanter
        .iter()
        .map(|m| {
            format!(
                "{} ({}x{}{})",
                m.label,
                m.width,
                m.height,
                if m.is_primary { ", birincil" } else { "" }
            )
        })
        .collect();
    // AKISIN NE OLDUGUNU DOGRU SOYLE. Video kanali ETIKET TASIMAZ
    // (`realtimeInput.video` yalniz mimeType + data), dolayisiyla `all` modunda
    // ust uste gelen etiketsiz kareler modelde karisiyor : sahada "monitorlerimi
    // yanlis goruyor" olarak gozlendi. Eski metin modele "kareler soldan saga
    // sirayla gelir" diyordu; bu bir ISTEM VAADIYDI, kanal onu tasiyamiyor.
    // Artik akisin ne oldugu durustce yaziliyor ve ekran adi TEK kaynaktan
    // ogreniliyor: aracin yaniti.
    let akis = match secim {
        crate::audio::screen::MonitorSelection::Active => {
            "Akista gordugun kare kullanicinin O AN BAKTIGI ekrandir (odak degisince akis da \
             degisir); hangi ekran oldugunu TAHMIN ETME."
        }
        crate::audio::screen::MonitorSelection::All => {
            "Akista her tikta birden fazla ekranin karesi gelir ve KARELER ETIKETSIZDIR: \
             hangisinin hangi ekran oldugunu AYIRT EDEMEZSIN, o yuzden ekran adi SOYLEME."
        }
        crate::audio::screen::MonitorSelection::Rotate => {
            "Akis sirayla farkli ekranlari gosterir ve KARELER ETIKETSIZDIR; hangisini \
             gordugunu AYIRT EDEMEZSIN, ekran adi SOYLEME."
        }
        crate::audio::screen::MonitorSelection::Primary => {
            "Akista yalniz birincil ekrani goruyorsun."
        }
        crate::audio::screen::MonitorSelection::List(_) => "Akista secili ekranlari goruyorsun.",
    };
    format!(
        "COK EKRAN: bu makinede {} monitor var ({}). {} \
         Belirli bir ekrani gormen gerekirse `ekrani_net_gor` aracini `ekran` argumaniyla \
         cagir ('sol', 'sag', 'hepsi', '1', '2'); aracin YANITI hangi ekrani gonderdigini \
         soyler — ekran adini yalniz oradan ogrenirsin, kareden degil.",
        envanter.len(),
        liste.join(", "),
        akis
    )
}

/// Eksiz setup : **yalniz test**. Uretim yolu `setup_frame_model`: yonergenin
/// dinamik kuyrugu (monitor envanteri + acilis baglami) her oturumda uretilir.
/// Bu sarmalayici mevcut setup testlerinin okunur kalmasi icin duruyor;
/// uretimde cagrilmadigi icin kapsami test.
/// Sikistirma KAPALI: mevcut testler sikistirma alanindan bagimsiz kalir;
/// sikistirmanin kendi testleri `setup_frame_ile_ek`i dogrudan cagirir.
#[cfg(test)]
pub(super) fn setup_frame(devralma: Devralma<'_>) -> String {
    setup_frame_ile_ek(devralma, "", Sikistirma::Kapali)
}

/// "Smith'in su an aklinda ne var?" : oturum kurulurken modele GIDEN her seyin
/// insan okunur dokumu.
///
/// NEDEN VAR: kullanici Smith'in zihnini gormek istedi. Durust cevap sudur :
/// Smith'in "akli" bir ic monolog degil, oturum acilirken gonderilen BAGLAMDIR.
/// Bu fonksiyon o baglami URETIMIN KENDI YOLUNDAN toplar (`setup_frame_model`,
/// `ekran_yonergesi`, `boot_context::collect`); hicbir parcayi kopyalamaz.
/// Kopyalasaydi "dokumde gorunen" ile "gercekte gonderilen" ayrisirdi ve bu,
/// bu depoda tekrar tekrar dusulen tuzagin ta kendisi.
///
/// DOKUMDE OLMAYANLAR bilincli olarak listelenir: Gemini Live bir dusunce izi
/// (reasoning trace) DONDURMEZ, hafiza yalniz model arac cagirdiginda girer,
/// ekran kareleri ikili veridir. Neyin gorunmedigini soylemek, gorunenler kadar
/// onemli : aksi halde bu dokum "Smith'in akli bundan ibaret" yanilgisi uretir.
///
/// Ses/anahtar iceren hicbir alan basilmaz; setup cercevesinde zaten yok.
pub fn zihin_dokumu(konusma: &str) -> String {
    let ekran = ekran_yonergesi();
    let boot = if crate::boot_context::enabled() {
        crate::boot_context::collect()
            .map(|s| s.text)
            .unwrap_or_default()
    } else {
        String::new()
    };
    // Profil gateway'den gelir; dokum UI komutu takilmasin diye kisa butceli istemci
    // (`kayit_yazici`: 400 ms). Blok uretimi oturum kurulumuyla AYNI fonksiyondur.
    let profil = ToolBridge {
        gw: crate::gateway::GatewayClient::kayit_yazici(),
        speaker: std::sync::Arc::new(crate::audio::speaker::SpeakerGate::disabled()),
        olaylar: None,
    }
    .profil_blogu();
    zihin_dokumu_ile(&EkBloklari {
        ekran: &ekran,
        boot: &boot,
        konusma,
        profil: &profil,
        hafiza_sorusu: "",
    })
}

/// Yonergenin dinamik kuyrugunun bloklari. Oturum kurulumu (`session_loop`) ve
/// `zihin_dokumu` birlestirmeyi AYNI fonksiyondan (`dinamik_ek`) yapar: dokumde
/// gorunen ile modele giden ayrisamaz. Sira modelin okuma sirasidir; profil en
/// sonda durur (kalici bilgi, soru gelince en taze hatirlanan yer).
pub(super) struct EkBloklari<'a> {
    pub(super) ekran: &'a str,
    pub(super) boot: &'a str,
    pub(super) konusma: &'a str,
    pub(super) profil: &'a str,
    pub(super) hafiza_sorusu: &'a str,
}

/// Bos olmayan bloklar tek bosluklarla birlesir (`sistem_yonergesi` bunu SYSTEM'in
/// ardina ekler).
pub(super) fn dinamik_ek(b: &EkBloklari<'_>) -> String {
    [b.ekran, b.boot, b.konusma, b.profil, b.hafiza_sorusu]
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn zihin_dokumu_ile(bloklar: &EkBloklari<'_>) -> String {
    use std::fmt::Write as _;

    let (ekran, boot, konusma, profil) =
        (bloklar.ekran, bloklar.boot, bloklar.konusma, bloklar.profil);
    let ek = dinamik_ek(bloklar);
    let model = live_model();
    let frame = setup_frame_model(
        Devralma::Yeni,
        &ek,
        sikistirma_env(),
        &model,
        SunucuVad::env(mik_akisi_env() == MikAkisi::Gated),
    );
    let json: serde_json::Value = serde_json::from_str(&frame).unwrap_or_default();
    let yonerge = json["setup"]["systemInstruction"]["parts"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let araclar: Vec<&str> = json["setup"]["tools"][0]["functionDeclarations"]
        .as_array()
        .map(|a| a.iter().filter_map(|t| t["name"].as_str()).collect())
        .unwrap_or_default();

    let mut o = String::new();
    let _ = writeln!(
        o,
        "=== SMITH'IN ZIHNI — oturum acilirken modele giden her sey ===\n"
    );
    let _ = writeln!(o, "model      : {model}   ses: {VOICE}   dil: tr-TR");
    let _ = writeln!(o, "arac sayisi: {} ({})", araclar.len(), araclar.join(", "));
    let _ = writeln!(
        o,
        "\n-- BOYUT DAGILIMI (setup her ~10 dk'da bir TEKRAR gonderilir) --"
    );
    let _ = writeln!(o, "  sabit yonerge (SYSTEM) : {:>6} bayt", SYSTEM.len());
    let _ = writeln!(o, "  ekran envanteri        : {:>6} bayt", ekran.len());
    let _ = writeln!(o, "  acilis baglami         : {:>6} bayt", boot.len());
    let _ = writeln!(o, "  son konusma            : {:>6} bayt", konusma.len());
    let _ = writeln!(o, "  kisisel profil         : {:>6} bayt", profil.len());
    let _ = writeln!(o, "  ------------------------------------");
    let _ = writeln!(o, "  yonerge TOPLAM         : {:>6} bayt", yonerge.len());
    let _ = writeln!(o, "  setup cercevesi (JSON) : {:>6} bayt", frame.len());

    let bolum = |o: &mut String, baslik: &str, icerik: &str| {
        let _ = writeln!(o, "\n----- {baslik} -----");
        if icerik.trim().is_empty() {
            let _ = writeln!(o, "(bos)");
        } else {
            let _ = writeln!(o, "{}", icerik.trim());
        }
    };
    bolum(&mut o, "1. EKRAN ENVANTERI", ekran);
    bolum(&mut o, "2. ACILIS BAGLAMI (bu makineden olculdu)", boot);
    bolum(&mut o, "3. SON KONUSMA (gateway'den)", konusma);
    bolum(&mut o, "4. KISISEL PROFIL (gateway'den)", profil);
    bolum(&mut o, "5. SABIT YONERGE", SYSTEM);

    let _ = writeln!(o, "\n----- BU DOKUMDE **OLMAYANLAR** -----");
    let _ = writeln!(
        o,
        "- DUSUNCE IZI BUGUN KAPALI (YOK DEGIL). Live API `thinkingLevel` +\n\
         \x20 `includeThoughts` destekliyor; varsayilan `minimal` oldugu icin\n\
         \x20 biz acmiyoruz (`low`+ olculen 613 ms ilk-ses suresini bozar).\n\
         \x20 Acilirsa gelen sey HAM dusunce zinciri DEGIL, OZETtir. Ayrica\n\
         \x20 ozet part'lari ayni content akisina karisir: `part.thought`\n\
         \x20 filtrelenmezse Smith kendi ic muhakemesini SESLI OKUR (LiveKit'te\n\
         \x20 bilinen bug). Bugun gorunen: modele giren baglam ve cikan ses.\n\
         - HAFIZA BURADA DEGIL. 1200+ kayit yonergeye konmaz; model `hafizada_ara`\n\
         \x20 aracini cagirdiginda O AN getirilir (gizli kayitlar haric).\n\
         - EKRAN KARELERI ikili veri olarak ayri akar (`realtimeInput.video`),\n\
         \x20 metin dokumu yok.\n\
         - SES ham PCM olarak akar; burada gorunmez.\n\
         - Devralma handle'i bir kimlik bilgisidir, kasten basilmaz."
    );
    o
}

#[cfg(test)]
pub(super) fn setup_frame_ile_ek(
    devralma: Devralma<'_>,
    ek: &str,
    sikistirma: Sikistirma,
) -> String {
    setup_frame_model(devralma, ek, sikistirma, MODEL, SunucuVad::yeni(true, None))
}

pub(super) fn setup_frame_model(
    devralma: Devralma<'_>,
    ek: &str,
    sikistirma: Sikistirma,
    model: &str,
    vad: SunucuVad,
) -> String {
    let yonerge = sistem_yonergesi(ek);
    let mut frame = serde_json::json!({
        "setup": {
            "tools": tool_declarations(),
            "model": format!("models/{}", model.strip_prefix("models/").unwrap_or(model)),
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": VOICE } },
                    "languageCode": "tr-TR"
                }
            },
            "systemInstruction": { "parts": [{ "text": yonerge }] },
            // Silero kapisi kuruluysa gurultuyu zaten eler; kisik hitabi
            // sunucuda ikinci kez eleme. Continuous/kurulum hatasinda LOW kalir.
            "realtimeInputConfig": {
                "automaticActivityDetection": {
                    "startOfSpeechSensitivity": if vad.gated { "START_SENSITIVITY_HIGH" } else { "START_SENSITIVITY_LOW" },
                    "endOfSpeechSensitivity": "END_SENSITIVITY_LOW",
                    "prefixPaddingMs": 300,
                    "silenceDurationMs": vad.silence_ms
                }
            },
            // Transkripsiyonlar teshis DEGIL urun gereksinimi: kullanici
            // konusmanin yazili izini de goruyor.
            "inputAudioTranscription": {},
            "outputAudioTranscription": {}
        }
    });
    // OTURUM DEVAMLILIGI (ai.google.dev/api/live):
    //   `setup.sessionResumption` : "If included, the server will send
    //   SessionResumptionUpdate messages." Yani alan setup'a GIRMEDIKCE sunucu
    //   hic handle yollamaz; devralmanin baslangic kosulu bu bos objedir.
    //   `sessionResumption.handle` : "The handle of a previous session. If not
    //   present then a new session is created."
    match devralma {
        Devralma::Kapali => {}
        Devralma::Yeni => frame["setup"]["sessionResumption"] = serde_json::json!({}),
        Devralma::Handle(h) => {
            frame["setup"]["sessionResumption"] = serde_json::json!({ "handle": h });
        }
    }
    // BAGLAM SIKISTIRMASI (bkz. `Sikistirma`): `slidingWindow` bos obje =
    // sunucu varsayilanlari; `triggerTokens` KARDES alandir, `slidingWindow`un
    // icinde degil. Alan setup'a girmezse oturum baglam tavaninda kapanir.
    if let Sikistirma::KayanPencere { tetik } = sikistirma {
        let mut cfg = serde_json::json!({ "slidingWindow": {} });
        if let Some(n) = tetik {
            cfg["triggerTokens"] = serde_json::json!(n);
        }
        frame["setup"]["contextWindowCompression"] = cfg;
    }
    frame.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::speaker::SpeakerVerdict;

    use super::super::conversation::TurTamponu;
    use super::super::profil;

    #[test]
    fn a2_proaktif_bellek_yeni_setup() {
        if std::env::var_os("SMITH_A2_MEMORY_CHILD").is_none() {
            let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../scripts")
                .canonicalize()
                .unwrap();
            let path = root.join(format!("live-probe-a2-memory-{}", std::process::id()));
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "audio::live::tests::a2_proaktif_bellek_yeni_setup",
                    "--nocapture",
                ])
                .env("SMITH_A2_MEMORY_CHILD", "1")
                .env("SMITH_DATA_DIR", &path)
                .env("SMITH_BOOT_CONTEXT", "1")
                .status()
                .unwrap();
            if path.exists() {
                std::fs::remove_dir_all(&path).unwrap();
            }
            assert!(status.success());
            return;
        }
        TurTamponu {
            input: String::new(),
            output: "C diskin %98 dolu".into(),
        }
        .bitir(SpeakerVerdict::Owner, None);
        let boot = crate::boot_context::collect().unwrap();
        let setup: serde_json::Value = serde_json::from_str(&setup_frame_model(
            Devralma::Yeni,
            &boot.text,
            Sikistirma::Kapali,
            &live_model(),
            SunucuVad::yeni(true, None),
        ))
        .unwrap();
        let yonerge = setup["setup"]["systemInstruction"]["parts"][0]["text"]
            .as_str()
            .unwrap();
        assert_eq!(yonerge.matches("Bunlari zaten soyledin").count(), 1);
        assert!(yonerge.contains("disk doluluk"));
        let file = std::path::PathBuf::from(std::env::var_os("SMITH_DATA_DIR").unwrap())
            .join("proaktif-bellek.json");
        let once = std::fs::read(&file).unwrap();
        for text in ["", "...", "yedek cok eski"] {
            TurTamponu {
                input: String::new(),
                output: text.into(),
            }
            .bitir(SpeakerVerdict::Foreign, None);
        }
        TurTamponu {
            input: String::new(),
            output: "...".into(),
        }
        .bitir(SpeakerVerdict::Owner, None);
        assert_eq!(once, std::fs::read(file).unwrap());
    }

    #[test]
    fn audit_isimle_seslenme_yonergesi() {
        for ad in ["Simit", "Smit", "Semt", "Cemil", "Cemiyet", "Schmidt"] {
            assert!(SYSTEM.contains(ad), "{ad}");
        }
    }

    /// Masaustunun oturuma enjekte ettigi "[Sistem bildirimi]" girdisinin nasil
    /// okunacagi ve hatirlatma yetenegi yonergede tek cumleyle durur; bildirim
    /// onegi `bildirim.rs`teki `ONEK` ile ayni olmali.
    #[test]
    fn yonerge_sistem_bildirimi_ve_hatirlatma_cumlelerini_tasir() {
        assert!(SYSTEM.contains(&format!(
            "'{}' ile baslayan girdi Cihan'in sozu degil; icerigi (adlar ve sayilar dahil) Cihan'a tek kisa cumleyle aktar.",
            super::super::bildirim::ONEK
        )));
        assert!(SYSTEM
            .contains("Hatirlatma: hatirlatma_kur, hatirlatmalari_listele, hatirlatma_iptal;"));
        assert!(SYSTEM.contains("is bitince '[Sistem bildirimi]' gelir"));
        assert!(!SYSTEM.contains("arka_plan_sonuc ile takip et"));
    }

    #[test]
    fn dinamik_ek_bos_bloklari_atlar_sirayi_korur() {
        let tam = EkBloklari {
            ekran: "E",
            boot: "B",
            konusma: "K",
            profil: "P",
            hafiza_sorusu: "H",
        };
        assert_eq!(dinamik_ek(&tam), "E B K P H");
        let bosluklu = EkBloklari {
            ekran: "E",
            boot: "",
            konusma: "  \n",
            profil: "P",
            hafiza_sorusu: "",
        };
        assert_eq!(dinamik_ek(&bosluklu), "E P");
        let bos = EkBloklari {
            ekran: "",
            boot: "",
            konusma: "",
            profil: "",
            hafiza_sorusu: "",
        };
        assert_eq!(dinamik_ek(&bos), "");
        assert_eq!(
            sistem_yonergesi(&dinamik_ek(&bos)),
            SYSTEM,
            "ek yokken yonerge sabit"
        );
    }

    #[test]
    fn hafiza_sorusu_dinamik_kuyrugun_sonunda_tek_satir_gorunur() {
        let soru = "Acik hafiza sorusu (id=gap_00000000000000000000): Hangi sehirdesin?";
        let bloklar = EkBloklari {
            ekran: "E",
            boot: "B",
            konusma: "K",
            profil: "P",
            hafiza_sorusu: soru,
        };
        let ek = dinamik_ek(&bloklar);
        assert!(ek.ends_with(soru), "{ek}");
        assert_eq!(ek.matches("Acik hafiza sorusu").count(), 1);
    }

    /// Profil blogu hem modele giden yonergede (konusma blogunun ardinda) hem
    /// `zihin_dokumu`nde gorunur: ikisi AYNI `dinamik_ek` ile kurulur.
    #[test]
    fn profil_blogu_yonergede_ve_zihin_dokumunde_gorunur() {
        let blok = format!("{}\n- sehir: Istanbul", profil::BASLIK);
        let bloklar = EkBloklari {
            ekran: "",
            boot: "",
            konusma: "[SON KONUSMA] eski ret",
            profil: &blok,
            hafiza_sorusu: "",
        };
        let frame: serde_json::Value = serde_json::from_str(&setup_frame_ile_ek(
            Devralma::Yeni,
            &dinamik_ek(&bloklar),
            Sikistirma::Kapali,
        ))
        .unwrap();
        let yonerge = frame["setup"]["systemInstruction"]["parts"][0]["text"]
            .as_str()
            .unwrap();
        assert!(
            yonerge.ends_with(&format!("[SON KONUSMA] eski ret {blok}")),
            "profil konusma blogunun ardinda olmali"
        );

        let dokum = zihin_dokumu_ile(&bloklar);
        assert!(dokum.contains("4. KISISEL PROFIL (gateway'den)"));
        assert!(dokum.contains("- sehir: Istanbul"));
        assert!(dokum.contains(&format!("kisisel profil         : {:>6} bayt", blok.len())));
        assert!(
            dokum.contains(&format!(
                "yonerge TOPLAM         : {:>6} bayt",
                yonerge.len()
            )),
            "dokumun toplami modele giden yonergeyle ayni olmali"
        );

        let bos = zihin_dokumu_ile(&EkBloklari {
            ekran: "",
            boot: "",
            konusma: "",
            profil: "",
            hafiza_sorusu: "",
        });
        assert!(bos.contains("4. KISISEL PROFIL (gateway'den) -----\n(bos)"));
        assert!(bos.contains(&format!(
            "yonerge TOPLAM         : {:>6} bayt",
            SYSTEM.len()
        )));
    }

    /// EK MONTAJI TEK YERDE: oturum kurulumu ve dokum bloklari elle birlestirmez,
    /// `dinamik_ek` kullanir (birlestirme bir yerde duruyor, ikinci kopya ayrisir).
    #[test]
    fn ek_montaji_tek_yerde() {
        let birlestirme = format!(".join({:?})", " ");
        assert_eq!(
            include_str!("setup.rs").matches(&birlestirme).count(),
            1,
            "setup.rs'te bosluklu birlestirme yalniz dinamik_ek icinde olmali"
        );
        let session = include_str!("session.rs");
        let uretim = session.split("#[cfg(test)]").next().unwrap();
        assert!(uretim.contains("dinamik_ek(&EkBloklari {"));
        assert!(!uretim.contains(&birlestirme));
    }

    /// Profil sorusu yonergesi: bilmedigini uydurma, kaydetmeyi teklif et.
    #[test]
    fn yonerge_profilde_olmayan_bilgiyi_uydurmaz() {
        assert!(SYSTEM.contains(
            "Profilde olmayan temel bir bilgi sorulursa uydurma; bilmedigini soyle ve kaydetmeyi teklif et."
        ));
    }

    #[test]
    fn model_env_dikisi_setup_ve_varsayilan() {
        assert_eq!(model_sec(None), MODEL);
        assert_eq!(model_sec(Some("  ")), MODEL);
        let model = model_sec(Some(" gemini-3.1-flash-live-preview "));
        let frame: serde_json::Value = serde_json::from_str(&setup_frame_model(
            Devralma::Yeni,
            "",
            Sikistirma::Kapali,
            model,
            SunucuVad::yeni(true, None),
        ))
        .unwrap();
        assert_eq!(
            frame["setup"]["model"],
            "models/gemini-3.1-flash-live-preview"
        );
    }

    /// Opt-in sonda dokumu: uretim setup fonksiyonunu kullanir. Taban verilirse
    /// eski setup'in dinamik ekini aynen tasir (A/B kosusunda tek degisken yeni
    /// kod olur); verilmezse ek bostur (yalniz sabit yonerge).
    #[test]
    fn sonda_setup_uretimi() {
        let Ok(out) = std::env::var("SMITH_LIVE_PROBE_OUT") else {
            return;
        };
        // Dinamik ek, tabanin yonergesinde SYSTEM'in SON SATIRINDAN sonra baslar;
        // ortadaki bir cumle sentinel olursa ondan sonraki sabit metin eke karisir
        // ve yeni setup'ta cift yazilir.
        let son_satir = SYSTEM.lines().last().expect("SYSTEM bos olamaz");
        let ek = std::env::var("SMITH_LIVE_PROBE_BASELINE")
            .ok()
            .map(|baseline| {
                let eski: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(baseline).unwrap()).unwrap();
                eski["setup"]["systemInstruction"]["parts"][0]["text"]
                    .as_str()
                    .unwrap()
                    .split_once(son_satir)
                    .expect("taban yonergesi bu SYSTEM'in son satiriyla bitmiyor")
                    .1
                    .trim()
                    .to_string()
            })
            .unwrap_or_default();
        let frame = setup_frame_model(
            Devralma::Yeni,
            &ek,
            Sikistirma::Kapali,
            &live_model(),
            SunucuVad::env(mik_akisi_env() == MikAkisi::Gated),
        );
        std::fs::write(out, frame).unwrap();
    }

    #[test]
    fn duyma_continuous_ve_kurulamayan_kapi_setup_low() {
        for d in [Devralma::Yeni, Devralma::Handle("duyma-test")] {
            let v: serde_json::Value = serde_json::from_str(&setup_frame_model(
                d,
                "",
                Sikistirma::Kapali,
                MODEL,
                SunucuVad::yeni(false, None),
            ))
            .unwrap();
            let aad = &v["setup"]["realtimeInputConfig"]["automaticActivityDetection"];
            assert_eq!(aad["startOfSpeechSensitivity"], "START_SENSITIVITY_LOW");
            assert_eq!(aad["endOfSpeechSensitivity"], "END_SENSITIVITY_LOW");
            assert_eq!(aad["silenceDurationMs"], 700);
        }
    }

    #[test]
    fn duyma_sessizlik_env_sinirlari_artik_payini_korur() {
        for (ham, ms) in [
            (None, 700),
            (Some(""), 700),
            (Some("bozuk"), 700),
            (Some("-1"), 300),
            (Some("299"), 300),
            (Some(" 900 "), 900),
            (Some("2001"), 2000),
            (Some("999999"), 2000),
        ] {
            let vad = SunucuVad::yeni(true, ham);
            assert_eq!(vad.silence_ms, ms);
            let v: serde_json::Value = serde_json::from_str(&setup_frame_model(
                Devralma::Yeni,
                "",
                Sikistirma::Kapali,
                MODEL,
                vad,
            ))
            .unwrap();
            assert_eq!(
                v["setup"]["realtimeInputConfig"]["automaticActivityDetection"]
                    ["silenceDurationMs"],
                vad.silence_ms
            );
        }
        for n in 0..=2500 {
            let vad = SunucuVad::yeni(true, Some(&n.to_string()));
            let mut k = crate::audio::vad::MikKapisi::new(vad.silence_ms + 300);
            use crate::audio::vad::{KapiCikti, KareDurumu};
            k.adim(&[1.0; 160], KareDurumu::Konusma);
            for _ in 0..(vad.silence_ms + 300).div_ceil(10) - 1 {
                assert!(!k
                    .adim(&[0.0; 160], KareDurumu::Sessiz)
                    .contains(&KapiCikti::AkisSonu));
            }
            assert!(k
                .adim(&[0.0; 160], KareDurumu::Sessiz)
                .contains(&KapiCikti::AkisSonu));
        }
    }

    #[test]
    fn kesin_kurallar_ilk_ve_sinirli() {
        let metin = sistem_yonergesi("[SON KONUSMA] eski ret");
        assert!(metin.starts_with("KESIN KURALLAR:\n"));
        let blok = metin.split("YETENEK:").next().unwrap();
        assert_eq!(blok.lines().filter(|s| s.starts_with("- ")).count(), 8);
        for kural in [
            "Turkce",
            "-iniz/-siniz",
            "DUZELTME",
            "Gormedigin ciktiyi ozetleme",
        ] {
            assert!(blok.contains(kural), "eksik: {kural}");
        }
    }

    /// Uzun araclar disinda davranis degismez; setup'ta tum alanlar aciktir.
    #[test]
    fn uzun_araclar_non_blocking_digerleri_blocking() {
        let frame: serde_json::Value = serde_json::from_str(&setup_frame(Devralma::Yeni)).unwrap();
        let tools = &frame["setup"]["tools"];
        let liste = tools[0]["functionDeclarations"]
            .as_array()
            .expect("functionDeclarations dizi olmali");
        assert!(!liste.is_empty(), "bildirim listesi bos");
        for bildirim in liste {
            assert_eq!(
                bildirim["behavior"].as_str(),
                Some(
                    if matches!(bildirim["name"].as_str(), Some("derin_dusun")) {
                        "NON_BLOCKING"
                    } else {
                        "BLOCKING"
                    }
                ),
                "behavior eksik/yanlis: {bildirim}"
            );
        }
    }

    /// MODEL TASIMA KAPISI: setup cercevesi GA modelini tasir.
    ///
    /// Model string'i tek sabitten gelir; bu test sabitin CERCEVEYE
    /// ulastigini olcer. Legacy preview'a sessiz donus, tam da bu tasimanin
    /// sebebi olan riski geri getirirdi: yedegi olmayan tek bacak, kaldirma
    /// tarihi ilan edilmemis bir uca basar.
    #[test]
    fn setup_cercevesi_ga_modelini_tasir() {
        let frame = setup_frame(Devralma::Yeni);
        assert!(
            frame.contains(&format!("\"model\":\"models/{MODEL}\"")),
            "model alani beklenen degeri tasimiyor"
        );
        assert!(
            !frame.contains("flash-live-preview"),
            "legacy preview modeli setup'a geri gelmis"
        );
    }

    /// YERLESIK ARAMA KAPISI. Olculdu: `googleSearch` iceren her setup free
    /// tier'da WS 1011 (kota/plan) ile kapaniyor : yani bu blogun setup'a geri
    /// eklenmesi Live oturumunu HIC ACILMAZ hale getirir. Yorum tavsiyedir, bu
    /// test mekanizmadir: kanit olmadan geri eklenirse kirmiziya doner.
    #[test]
    fn setup_yalniz_kendi_araclarini_tanitir() {
        let tools = tool_declarations();
        let arr = tools.as_array().expect("tools bir dizi olmali");
        assert_eq!(arr.len(), 1, "beklenmeyen ek arac blogu: {tools}");
        let anahtarlar: Vec<&str> = arr[0]
            .as_object()
            .expect("arac blogu obje olmali")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(anahtarlar, vec!["functionDeclarations"]);
        assert!(
            !setup_frame(Devralma::Yeni).contains("googleSearch"),
            "yerlesik arama setup'a girmis — free tier'da WS 1011 verir"
        );
    }

    /// SISTEM YONERGESI KAPISI (ADR 0005). Yonerge tek bir Rust string'idir:
    /// derleyici korumasi yoktur, bir satir yeniden yazilirken sessizce
    /// dusebilir ve kayip ancak canli konusmada : kotu davranis olarak : fark
    /// edilir. Bu test her kural AILESINDEN bir cirpi ifade arar; ifadeyi
    /// degistirmek serbesttir ama kurali dusurmek kirmiziya doner.
    ///
    /// Metnin tamami degil cirpilar kontrol edilir: yonerge yasayan bir metin,
    /// birebir esitlik her uslup rotusunda yalanci alarm verirdi.
    #[test]
    fn sistem_yonergesi_kritik_kurallari_tasir() {
        // (kural ailesi, yonergede bulunmasi gereken cirpi)
        let kurallar = [
            ("kimlik", "Sen Smith'sin"),
            ("muhatap Cihan", "KONUSTUGUN KISI CIHAN"),
            ("kimlik uydurma yasagi", "KIMLIK VE ILISKI BILGISI UYDURMA"),
            ("sozluk / yanlis duyma", "kullaniciyi DUZELTME"),
            ("kisalik", "1-2 kisa cumle"),
            ("yagcilik yasagi", "YASAK ACILIS KALIPLARI"),
            ("soruyla bitirme yasagi", "YASAK KAPANIS KALIPLARI"),
            ("izin isteme yasagi", "IZIN ISTEME"),
            ("izin kademeleri", "IKI KADEME"),
            ("okuma serbest", "OKUMA VE GOZLEM serbesttir"),
            ("yazma onayi", "YAZMA VE DEGISTIRME kisa onay ister"),
            // Belirsizlik kurali bilincli olarak SORU degil ARAMA uretir.
            // Gerekcesi ikili: (a) kullanici bugun zaten fazla soru sorulmasindan
            // sikayet etti, (b) modelin belirsizlik karsisinda cesur varsayim
            // yapmasi sesli hatta yanlis cevap degil YANLIS EYLEM demektir -
            // system_tools iki adimli onay ve kesin ret siniflari uygular ama
            // yanlis hedefe uygulanan izinli islem yine kapidan gecebilir.
            ("belirsiz hedef", "BELIRSIZ HEDEF"),
            // Siralama kuralin KENDISI: once arama, en son soru. Bu cirpi
            // duserse kural bir "emin degilsen sor" lisansina donusur ve
            // kullanicinin sikayet ettigi davranis geri gelir.
            ("belirsizlikte once arama", "en son sorudur"),
            ("merak", "MERAK VE ARASTIRMACILIK"),
            ("is bitiricilik", "IS BITIRICILIK"),
            // Pano kurali (ADR 0007). Iki sey birden tasiyor: yetenegin VARLIGI
            // (model panonun var oldugunu bilmezse hic cagirmaz) ve atamanin
            // PARA HARCADIGI. Cirpi duserse ikinci kisim once kaybolur ve model
            // sorulmadan ajana is atmaya baslar.
            ("ekip panosu", "ATAMA para harcar"),
            ("olculu hitap", "efendim"),
            ("hafizaya yazma kurali", "HAFIZAYA YAZMA KURALI"),
            ("derin_dusun zorunlulugu", "derin_dusun aracini cagir"),
            ("arac disiplini", "ARAC CAGIRMA DISIPLINI"),
            // Ekran akisi varsayilan KAPALI (2026-10): model "surekli goruyorum"
            // varsaymamali, soruldukca net kare istemeli, surekli izleme yalniz
            // istenirse `ekran_akisi` ile acilmali.
            ("ekran farkindaligi", "EKRANI SUREKLI GORMUYORSUN"),
            ("surekli izleme araci", "ekran_akisi {acik: true}"),
            ("ekrani net gor yonlendirmesi", "ekrani_net_gor cagir"),
            ("proaktiflik", "PROAKTIFLIK:"),
            ("proaktiflik siniri", "EN FAZLA BIR KEZ"),
            ("odaklanmisken sessizlik", "SESSIZ KAL"),
        ];
        for (aile, cirpi) in kurallar {
            assert!(
                SYSTEM.contains(cirpi),
                "sistem yonergesinden '{aile}' kurali dusmus (aranan: {cirpi:?}) - \
                 ADR 0005'e bak, kurali geri koy veya ADR'yi guncelle"
            );
        }

        // NEGATIF KAPI: kaldirilan izin lisanslari geri gelmesin. Bunlar
        // yonergedeki "izin isteme" kuralini FIILEN iptal ediyordu ve
        // "anlatayim mi" birebir soru yasagindan da muaf tutulmustu.
        for lisans in ["'anlatayim mi?' diye sor", "araci cagirmak yerine sor"] {
            assert!(
                !SYSTEM.contains(lisans),
                "kaldirilan izin lisansi geri gelmis: {lisans:?} - kullanici \
                 sikayeti tam buydu, okuma araclari izin ISTEMEZ"
            );
        }

        // Yasak kaliplarin KENDISI yonergede yazili olmali: modele "boyle
        // konusma" demenin tek yolu kalibi ismiyle saymaktir. Liste budanirsa
        // Smith jenerik asistan diline geri doner.
        for kalip in ["Harika fikir", "Elbette", "Ne yapmami istersin"] {
            assert!(
                SYSTEM.contains(kalip),
                "yasak kalip listesinden {kalip:?} cikarilmis - ADR 0005"
            );
        }

        // Proaktiflik iki yonlu tanimli olmali: "soz al" kurallarinin
        // yanindaki fren cumleleri de duruyor mu?
        for fren in ["KAPANMISTIR", "ASLA kendiliginden soz alma"] {
            assert!(
                SYSTEM.contains(fren),
                "proaktiflik freni {fren:?} dusmus - frensiz proaktiflik her \
                 kareye yorum yapan asistan uretir (ADR 0005)"
            );
        }
    }

    /// Yonerge ve arac aciklamalari duz ASCII yazilir (dosya konvansiyonu).
    /// Turkce harf girmesi tek basina zarar vermez ama iki somut riski var:
    /// (a) sesli hatta okunan metinde kismi Turkce yazim SOZLUK terimlerinin
    /// yazimini kaydiriyor, (b) kopyala-yapistir ile gelen karakterler goze
    /// gorunmez bicimde WS JSON'una siziyor. Konvansiyon yorumla degil bu
    /// testle korunur.
    #[test]
    fn sistem_yonergesi_turkce_harf_tasimaz() {
        // c-cedil, g-breve, noktasiz i, buyuk noktali I, o-umlaut, s-cedil,
        // u-umlaut (kucuk + buyuk); son cift y-acute, `i`nin cp1254/latin-1
        // karismasindan dogan klasik mojibake izi.
        const TURKCE: [char; 14] = [
            '\u{e7}', '\u{c7}', '\u{11f}', '\u{11e}', '\u{131}', '\u{130}', '\u{f6}', '\u{d6}',
            '\u{15f}', '\u{15e}', '\u{fc}', '\u{dc}', '\u{fd}', '\u{dd}',
        ];
        let araclar = tool_declarations().to_string();
        for (nerede, metin) in [("SYSTEM", SYSTEM), ("tool_declarations", araclar.as_str())] {
            if let Some(c) = metin.chars().find(|c| TURKCE.contains(c)) {
                // Baglam char sinirinda kesilir: byte dilimi panige panik ekler.
                let onceki: String = metin
                    .split(c)
                    .next()
                    .unwrap_or_default()
                    .chars()
                    .rev()
                    .take(40)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                panic!(
                    "{nerede} icinde Turkce harf {c:?} var - ASCII yazima cevir. \
                     Once gelen metin: ...{onceki}"
                );
            }
        }
    }

    /// YONERGENIN DINAMIK KUYRUGU. `SYSTEM` bir `const`; monitor envanteri ve
    /// acilis baglami ancak calisma aninda bilinir. Kritik olan sey: ek BOSKEN
    /// yonerge birebir eskisi gibi kalmali (regresyon yok), ek varken de
    /// yonergenin TAMAMI korunmali : ekin sabit metni ezmesi butun kisilik ve
    /// guvenlik kurallarini sessizce dusururdu.
    #[test]
    fn dinamik_ek_yonergeyi_ezmez_bos_ekte_birebir_ayni() {
        assert_eq!(
            sistem_yonergesi(""),
            SYSTEM,
            "ek bos iken yonerge degismis olmali DEGIL - eski davranis korunmuyor"
        );
        assert_eq!(sistem_yonergesi("   \n  "), SYSTEM, "bosluk ek sayilmamali");

        let ekli = sistem_yonergesi("COK EKRAN: 2 monitor var.");
        assert!(
            ekli.starts_with(SYSTEM),
            "ek, sabit yonergenin ONUNE gecmis - kurallar dusebilir"
        );
        assert!(ekli.contains("COK EKRAN: 2 monitor var."), "ek kaybolmus");
        // Yonergenin kritik kurallari ek eklendikten SONRA da yerinde mi?
        for cirpi in ["Sen Smith'sin", "IKI KADEME", "MERAK VE ARASTIRMACILIK"] {
            assert!(
                ekli.contains(cirpi),
                "ek sonrasi '{cirpi}' kurali kaybolmus"
            );
        }
    }

    /// Dinamik ek gercekten TELE giriyor mu? `systemInstruction` icinde
    /// olmazsa model monitor sirasini hic ogrenmez ve iki ekrani ayni ekranin
    /// degismis hali sanir (`realtimeInput.video` etiket alani TASIMAZ).
    #[test]
    fn setup_dinamik_eki_system_instructiona_koyar() {
        let govde = setup_frame_ile_ek(
            Devralma::Yeni,
            "COK EKRAN: 2 monitor var.",
            Sikistirma::Kapali,
        );
        let json: serde_json::Value = serde_json::from_str(&govde).expect("gecerli JSON");
        let metin = json["setup"]["systemInstruction"]["parts"][0]["text"]
            .as_str()
            .expect("systemInstruction metni");
        assert!(
            metin.contains("COK EKRAN: 2 monitor var."),
            "dinamik ek systemInstruction'a girmemis"
        );
        assert!(metin.contains("Sen Smith'sin"), "sabit yonerge kaybolmus");

        // Ek verilmeyen yol eski davranisla BIREBIR ayni olmali.
        assert_eq!(
            setup_frame(Devralma::Yeni),
            setup_frame_ile_ek(Devralma::Yeni, "", Sikistirma::Kapali),
            "eksiz setup ile eski setup ayrismis"
        );
    }

    /// Ekran yonergesi ENV'e bagli oldugu icin iki sonuc da mesrudur; test
    /// davranisi degil TUTARLILIGI kontrol eder: uretilen metin ya bos olur ya
    /// da modelin ekran adini NEREDEN ogrenecegini soyler.
    #[test]
    fn ekran_yonergesi_ya_bos_ya_tam() {
        let y = ekran_yonergesi();
        if y.is_empty() {
            return; // ekran kapali veya tek monitor
        }
        for parca in ["COK EKRAN", "monitor var", "ekrani_net_gor", "ekran"] {
            assert!(
                y.contains(parca),
                "ekran yonergesi yarim: '{parca}' yok. Uretilen: {y}"
            );
        }
    }

    #[test]
    fn etiketsiz_modlarda_model_ekran_adi_uydurmaya_davet_edilmez() {
        let envanter = vec![
            crate::audio::screen::MonitorInfo {
                index: 1,
                id: 1,
                label: "Ekran 1/2 (sol, 1920x1080)".into(),
                width: 1920,
                height: 1080,
                is_primary: false,
            },
            crate::audio::screen::MonitorInfo {
                index: 2,
                id: 2,
                label: "Ekran 2/2 (sag, 1920x1080, birincil)".into(),
                width: 1920,
                height: 1080,
                is_primary: true,
            },
        ];
        for (sel, etiketsiz) in [
            (crate::audio::screen::MonitorSelection::All, true),
            (crate::audio::screen::MonitorSelection::Rotate, true),
            (crate::audio::screen::MonitorSelection::Active, false),
        ] {
            let y = ekran_yonergesi_ile(&envanter, &sel);
            if etiketsiz {
                assert!(
                    y.contains("AYIRT EDEMEZSIN"),
                    "etiketsiz modda model uyarilmamis -> ekran adi uydurur: {y}"
                );
                assert!(
                    !y.contains("soldan saga"),
                    "kanalin tasiyamadigi bir sira VAADI verilmis: {y}"
                );
            } else {
                assert!(
                    y.contains("BAKTIGI"),
                    "aktif modda akisin ne oldugu soylenmemis: {y}"
                );
            }
            assert!(
                y.contains("ekrani_net_gor"),
                "ekran adinin ogrenilecegi TEK kaynak (arac yaniti) soylenmemis: {y}"
            );
        }
    }

    /// Handle varken setup onu TASIR; yokken alan ILK-BAGLANTI seklinde (bos
    /// obje) gider : bos obje sunucuya "bana handle yolla" der.
    #[test]
    fn setup_handlei_tasir_yokken_ilk_baglanti_seklinde() {
        let devralan: serde_json::Value =
            serde_json::from_str(&setup_frame(Devralma::Handle("h-42"))).expect("gecerli JSON");
        assert_eq!(
            devralan["setup"]["sessionResumption"]["handle"].as_str(),
            Some("h-42"),
            "handle setup'a girmemis: devralma calismaz"
        );

        let ilk: serde_json::Value =
            serde_json::from_str(&setup_frame(Devralma::Yeni)).expect("gecerli JSON");
        let alan = &ilk["setup"]["sessionResumption"];
        assert!(
            alan.is_object() && alan.as_object().expect("obje").is_empty(),
            "ilk baglantida sessionResumption bos obje olmali, bulunan: {alan}"
        );
    }

    /// Sikistirma ham env degerlerinden niyet: varsayilan ACIK, yalniz "0"
    /// kapatir, tetik yalniz pozitif tam sayi.
    #[test]
    fn sikistirma_niyeti_envden() {
        let varsayilan = Sikistirma::KayanPencere {
            tetik: Some(VARSAYILAN_SIKISTIRMA_TETIK),
        };
        assert_eq!(VARSAYILAN_SIKISTIRMA_TETIK, 25_000);
        assert_eq!(sikistirma_niyeti(None, None), varsayilan);
        assert_eq!(sikistirma_niyeti(Some("1"), None), varsayilan);
        assert_eq!(sikistirma_niyeti(Some(""), None), varsayilan);
        assert_eq!(sikistirma_niyeti(Some("0"), None), Sikistirma::Kapali);
        assert_eq!(
            sikistirma_niyeti(Some(" 0 "), Some("8000")),
            Sikistirma::Kapali
        );
        assert_eq!(
            sikistirma_niyeti(None, Some("12000")),
            Sikistirma::KayanPencere {
                tetik: Some(12_000)
            }
        );
        assert_eq!(
            sikistirma_niyeti(None, Some(" 12000 ")),
            Sikistirma::KayanPencere {
                tetik: Some(12_000)
            }
        );
        // Gecersiz tetik yok sayilir (VARSAYILAN_SIKISTIRMA_TETIK), oturum acilir.
        for kotu in ["", "abc", "-5", "0", "1.5", "99999999999999999999999"] {
            assert_eq!(
                sikistirma_niyeti(None, Some(kotu)),
                varsayilan,
                "tetik={kotu:?}"
            );
        }
    }

    /// Setup JSON'u: alan adlari ve konumu Google semasina uyar.
    /// `contextWindowCompression.slidingWindow` (bos obje) ve KARDES
    /// `triggerTokens`; mevcut alanlarla ayni camelCase.
    #[test]
    fn setup_baglam_sikistirmasini_semaya_uygun_tasir() {
        let json = |s| -> serde_json::Value {
            serde_json::from_str(&setup_frame_ile_ek(Devralma::Yeni, "", s)).expect("gecerli JSON")
        };

        // Varsayilan: kayan pencere, tetik yok.
        let v = json(Sikistirma::KayanPencere { tetik: None });
        let cfg = &v["setup"]["contextWindowCompression"];
        assert!(
            cfg["slidingWindow"]
                .as_object()
                .is_some_and(|o| o.is_empty()),
            "slidingWindow bos obje olmali: {cfg}"
        );
        assert!(
            cfg.get("triggerTokens").is_none(),
            "tetik verilmemisken alan girmis: {cfg}"
        );
        assert_eq!(cfg.as_object().map(|o| o.len()), Some(1));

        // Tetikli: triggerTokens slidingWindow'un KARDESI, sayi olarak.
        let v = json(Sikistirma::KayanPencere {
            tetik: Some(12_000),
        });
        let cfg = &v["setup"]["contextWindowCompression"];
        assert_eq!(cfg["triggerTokens"].as_u64(), Some(12_000), "{cfg}");
        assert!(cfg["slidingWindow"].get("triggerTokens").is_none());

        // Kapali: alan HIC girmez.
        let ham = setup_frame_ile_ek(Devralma::Yeni, "", Sikistirma::Kapali);
        assert!(
            !ham.contains("contextWindowCompression"),
            "kapaliyken alan girmis"
        );
        assert!(!ham.contains("slidingWindow"));

        // Sikistirma diger setup alanlarini bozmaz: model, arac, devralma yerinde.
        let v = json(Sikistirma::KayanPencere { tetik: None });
        assert_eq!(
            v["setup"]["model"].as_str(),
            Some(format!("models/{MODEL}").as_str())
        );
        assert!(v["setup"]["sessionResumption"].is_object());
        assert!(v["setup"]["tools"].is_array());
    }

    /// Env dikisi (`SMITH_LIVE_COMPRESS*`): bu degiskenleri baska test okumaz.
    #[test]
    fn sikistirma_env_dikisi() {
        let eski = (
            std::env::var("SMITH_LIVE_COMPRESS").ok(),
            std::env::var("SMITH_LIVE_COMPRESS_TRIGGER").ok(),
        );
        std::env::remove_var("SMITH_LIVE_COMPRESS");
        std::env::remove_var("SMITH_LIVE_COMPRESS_TRIGGER");
        assert_eq!(
            sikistirma_env(),
            Sikistirma::KayanPencere {
                tetik: Some(VARSAYILAN_SIKISTIRMA_TETIK)
            },
            "tetik verilmezse varsayilan 25000 olmali"
        );
        std::env::set_var("SMITH_LIVE_COMPRESS_TRIGGER", "9000");
        assert_eq!(
            sikistirma_env(),
            Sikistirma::KayanPencere { tetik: Some(9000) }
        );
        std::env::set_var("SMITH_LIVE_COMPRESS", "0");
        assert_eq!(sikistirma_env(), Sikistirma::Kapali);
        match eski.0 {
            Some(v) => std::env::set_var("SMITH_LIVE_COMPRESS", v),
            None => std::env::remove_var("SMITH_LIVE_COMPRESS"),
        }
        match eski.1 {
            Some(v) => std::env::set_var("SMITH_LIVE_COMPRESS_TRIGGER", v),
            None => std::env::remove_var("SMITH_LIVE_COMPRESS_TRIGGER"),
        }
    }

    /// Varsayilan tetik (env yok) setup'a `triggerTokens: 25000` olarak girer.
    #[test]
    fn varsayilan_sikistirma_setupa_25000_tetikle_girer() {
        let niyet = sikistirma_niyeti(None, None);
        let v: serde_json::Value =
            serde_json::from_str(&setup_frame_ile_ek(Devralma::Yeni, "", niyet))
                .expect("gecerli JSON");
        let cfg = &v["setup"]["contextWindowCompression"];
        assert_eq!(cfg["triggerTokens"].as_u64(), Some(25_000), "{cfg}");
        assert!(cfg["slidingWindow"].is_object());
        // Env ile verilen tetik varsayilani ezer.
        let niyet = sikistirma_niyeti(None, Some("9000"));
        let v: serde_json::Value =
            serde_json::from_str(&setup_frame_ile_ek(Devralma::Yeni, "", niyet))
                .expect("gecerli JSON");
        assert_eq!(
            v["setup"]["contextWindowCompression"]["triggerTokens"].as_u64(),
            Some(9_000)
        );
    }

    /// Sistem yonergesi: surekli goruyor VARSAYIMI yok, akis araci ve net kare
    /// yonlendirmesi var.
    #[test]
    fn yonerge_ekrani_surekli_gordugunu_varsaymaz() {
        assert!(!SYSTEM.contains("EKRANI GORUYORSUN"));
        assert!(!SYSTEM.contains("ekranin bir karesi surekli sana akiyor"));
        for cirpi in [
            "EKRANI SUREKLI GORMUYORSUN",
            "ekrani_net_gor cagir",
            "ekran_akisi {acik: true}",
            "Ekran akisi ACIKKEN",
        ] {
            assert!(SYSTEM.contains(cirpi), "yonergede yok: {cirpi}");
        }
    }
}
