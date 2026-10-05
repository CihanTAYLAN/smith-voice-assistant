//! Live oturumunun gonderim ve alim dongusu.

use super::bildirim::{
    cerceve as bildirim_cercevesi, cevaba_izin_ver, geri_koy, teslim_icin_al, Zamanlayici,
};
use super::connection::{
    devralma_acik, devralma_niyeti, go_away_kalan, kapanis_logu, kapanma_bilgisi, kaydet_handle,
    setup_zaman_asimi, yeni_handle, Devralma, Kapanis, KapanisSinifi, OturumIzi,
};
use super::conversation::{
    sessiz_yanit, AliciKaydi, KayitYazici, TurKayitlari, TurTamponu, KAPANIYOR,
};
use super::microphone::{
    akis_sonu_cercevesi, dinleme_kipi, dinleme_olayi, dinleme_surumu, dinleme_tamponunu_sifirla,
    isimle_arac_reddi, mik_akisi_env, mik_ariza_bildir, mik_kare_guncel, mikrofon_adim,
    mikrofon_adim_izli, sahip_sonucu, ses_cercevesi, stt_isinmasi, yerel_stt, DinlemeKipi,
    IfadeKoruma, IsimKapisi, KesintiKurtarma, MikAkisi, MikKaresi, MikTamponu, SpeakerIs,
    SunucuVad, YanitIzni, ADLA_UYARI, DINLEME_UYARI, IN_RATE, STT_ZAMAN_ASIMI,
};
use super::screen_stream::{
    ekran_akisi_olayi, ekran_yakala, net_kare_cercevesi, GidenCerceve, EKRAN_KAPALI_UYKU,
};
use super::setup::{
    dinamik_ek, ekran_yonergesi, live_model, setup_frame_model, EkBloklari, Sikistirma, VOICE,
};
use super::telemetry::{
    ekran_iddiasi, ekran_tahmin_kaydet, iddia_izi, iddia_kaydet, kullanim_hazirla, kullanim_kaydet,
    simdi_unix, yeni_oturum_no, GecikmeOlcer, KareKaybi, SunucuSessizligi, TurOzeti, YanitsizEylem,
};
use super::tools::{arac_yaniti, Arac, ToolBridge, TOOL_BASLADI, TOOL_BITTI};
use super::{LiveEvent, SesParcasi};
use crate::audio::resample::LinearResampler;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

pub const OUT_RATE: u32 = 24_000;

fn tur_bitti(sc: &serde_json::Value) -> bool {
    sc["turnComplete"].as_bool() == Some(true) || sc["interrupted"].as_bool() == Some(true)
}

fn yenileme_bildir(events: &mpsc::UnboundedSender<LiveEvent>) {
    // Genel HUD baloncugu; hata kanali basariyi baglanti hatasina cevirir.
    for durum in [TOOL_BASLADI, TOOL_BITTI] {
        let _ = events.send(LiveEvent::Tool {
            ad: "baglanti tazelendi".into(),
            durum,
            sebep: None,
        });
    }
}

enum Gonderim {
    Ses(MikKaresi),
    Kontrol(GidenCerceve),
}

#[derive(Default)]
struct AracTeslimIzi {
    bekleyen: std::collections::HashMap<String, (std::time::Instant, Option<std::time::Instant>)>,
}

impl AracTeslimIzi {
    fn dispatch_done(&mut self, id: &str, simdi: std::time::Instant) {
        self.bekleyen.insert(id.to_owned(), (simdi, None));
        eprintln!("[tool-delivery] id={id} stage=dispatch_done");
    }

    fn ws_written(&mut self, id: &str, simdi: std::time::Instant) {
        if let Some((dispatch, yazildi)) = self.bekleyen.get_mut(id) {
            *yazildi = Some(simdi);
            eprintln!(
                "[tool-delivery] id={id} stage=ws_written dispatch_to_ws_ms={}",
                simdi.saturating_duration_since(*dispatch).as_millis()
            );
        }
    }

    fn server_resumed(&mut self, simdi: std::time::Instant) -> usize {
        let hazir: Vec<String> = self
            .bekleyen
            .iter()
            .filter_map(|(id, (_, yazildi))| yazildi.map(|_| id.clone()))
            .collect();
        for id in &hazir {
            if let Some((_, Some(yazildi))) = self.bekleyen.remove(id) {
                eprintln!(
                    "[tool-delivery] id={id} stage=server_resumed ws_to_server_ms={}",
                    simdi.saturating_duration_since(yazildi).as_millis()
                );
            }
        }
        hazir.len()
    }
}

async fn siradaki(
    pcm: &MikTamponu,
    out: &mut mpsc::Receiver<GidenCerceve>,
    seri: &mut usize,
) -> Gonderim {
    // Ses oncelikli; surekli mikrofonda arac yaniti da ac kalmaz.
    if *seri >= 8 {
        if let Ok(frame) = out.try_recv() {
            *seri = 0;
            return Gonderim::Kontrol(frame);
        }
    }
    tokio::select! {
        biased;
        kare = pcm.recv() => { *seri = (*seri + 1).min(8); Gonderim::Ses(kare) },
        Some(frame) = out.recv() => { *seri = 0; Gonderim::Kontrol(frame) },
    }
}

async fn kontrol_gonder<W>(
    write: &mut W,
    frame: GidenCerceve,
    gecikme: &std::sync::Mutex<GecikmeOlcer>,
    sessizlik: &std::sync::Mutex<SunucuSessizligi>,
    teslim: &std::sync::Mutex<AracTeslimIzi>,
) -> Result<(), W::Error>
where
    W: futures_util::Sink<Message> + Unpin,
    W::Error: std::fmt::Display,
{
    let olcum = match &frame {
        GidenCerceve::Arac { id, tur, bas, .. } => Some((id.clone(), *tur, *bas)),
        _ => None,
    };
    let Some(metin) = frame.metin(crate::audio::screen::akis_surumu()) else {
        return Ok(());
    };
    let bayt = metin.len();
    if let Err(e) = write.send(Message::Text(metin)).await {
        if let Some((id, _, _)) = &olcum {
            eprintln!("[tool-delivery] id={id} stage=ws_write_failed error={e}");
        } else {
            eprintln!("[live] kontrol frame yazilamadi: {e}");
        }
        return Err(e);
    }
    if let Some((id, tur, bas)) = olcum {
        let simdi = std::time::Instant::now();
        teslim
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .ws_written(&id, simdi);
        gecikme
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .arac_yaniti(tur, bas, simdi, bayt);
        sessizlik
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .arac_gonderildi(&id, simdi);
    }
    Ok(())
}

/// Tek bir Live oturumu kurar ve oturum kapanana kadar surdurur.
///
/// `pcm_rx` ODUNC alinir (sahiplenilmez): oturum kapanip yenisi kurulunca ayni
/// mikrofon kanali devam etmeli, yoksa capture tarafi kirilir.
///
/// `handle_store` devralma handle'ini TASIR (okur ve gunceller); `iz` bu
/// denemenin saglik izini cagirana geri verir : handle politikasi orada isler.
pub(super) async fn session_loop(
    key: &str,
    pcm_rx: Arc<MikTamponu>,
    events: mpsc::UnboundedSender<LiveEvent>,
    stop: Arc<AtomicBool>,
    handle_store: &std::sync::Mutex<Option<String>>,
    iz: &mut OturumIzi,
    sikistirma: Sikistirma,
    kayit_tx: Option<&KayitYazici>,
    baglanti_yenileme: bool,
    ifade_koruma: Arc<std::sync::Mutex<IfadeKoruma>>,
) -> Result<Kapanis, Kapanis> {
    let model = live_model();
    eprintln!("[live] oturum modeli: {model}");
    let ws = super::connection::baglan(key).await?;
    let (mut write, mut read) = ws.split();

    // Devralma niyeti: eldeki handle + env bayragi. `devralma_denendi` izine
    // BURADA yazilir (gonderilen setup'in gercegi), tahminle degil.
    let devralinan = handle_store.lock().ok().and_then(|g| g.clone());
    let niyet = devralma_niyeti(devralma_acik(), devralinan.as_deref());
    iz.devralma_denendi = matches!(niyet, Devralma::Handle(_));
    if iz.devralma_denendi {
        eprintln!("[live] onceki oturum devralinmaya calisiliyor");
    }

    // SES IZI KAPISI ve ARAC KOPRUSU setup'tan ONCE kurulur: yonergenin dinamik
    // kuyruguna giren "son konusma" blogu gateway'den geliyor ve o cagri
    // koprunun token yonetimine muhtac (ikinci bir login yolu acilmaz). Ikisi de
    // yalniz env okur; WS durumundan bagimsizdir, dolayisiyla erken kurulmalari
    // davranisi degistirmez.
    let speaker = Arc::new(crate::audio::speaker::SpeakerGate::from_env());
    let bridge = Arc::new(ToolBridge::from_env(speaker.clone(), Some(events.clone())));

    // Yonergenin DINAMIK kuyrugu her oturumda yeniden uretilir: oturum ~10
    // dakikada bir yeniden kuruluyor, dolayisiyla acilis baglami da tazelenir
    // (monitor takilip cikarilabilir, uygulamalar degisir, disk dolar).
    //
    // Acilis baglami BLOKLAYICI (PowerShell sorgulari, butce 800 ms) ->
    // `spawn_blocking` sart; aksi halde tek-thread runtime'da ses tikirdar.
    // Hata veya kapali bayrak = bos string, oturum etkilenmez (fail-open).
    // BLOKLAYICI: `ekran_yonergesi` icinde `screen::inventory()` var, o da
    // `xcap::Monitor::all()` ile Win32 donanim numaralandirmasi yapiyor.
    // ONCEDEN DOGRUDAN BURADA CAGRILIYORDU ve sahada Live HIC baglanmadi
    let ek_ekran = match tokio::task::spawn_blocking(ekran_yonergesi).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[screen] envanter okunamadi: {e}");
            String::new()
        }
    };
    let ek_boot = match tokio::task::spawn_blocking(crate::boot_context::collect).await {
        Ok(Some(s)) => {
            eprintln!(
                "[boot] acilis baglami hazir ({} bayt, {} ms)",
                s.text.len(),
                s.elapsed.as_millis()
            );
            s.text
        }
        Ok(None) => String::new(),
        Err(e) => {
            eprintln!("[boot] acilis baglami toplanamadi: {e}");
            String::new()
        }
    };
    // SON KONUSMA: uygulama kapaninca konusma kayboluyordu; gateway'de saklanan
    // replikler acilista geri yuklenir. Cagri BLOKLAYICI (ureq) ->
    // `spawn_blocking`, `boot_context` ile ayni gerekce. Gateway kapali/hatali
    // ise bos string doner ve yonergeye HIC blok eklenmez.
    let ek_konusma = {
        let b = bridge.clone();
        match tokio::task::spawn_blocking(move || b.son_konusma_blogu()).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[konusma] gecmis toplanamadi: {e}");
                String::new()
            }
        }
    };
    // KISISEL PROFIL: Cihan'in acikca kaydettirdigi kalici bilgiler (sehir, dogum
    // gunu...). Ayni gerekce ve ayni sozlesme (BLOKLAYICI -> `spawn_blocking`;
    // gateway kapali/hata/bos profil = bos string). Token zaten konusma blogunun
    // cagrisiyla alindi, ikinci login olmaz.
    let ek_profil = {
        let b = bridge.clone();
        match tokio::task::spawn_blocking(move || b.profil_blogu()).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[profil] profil toplanamadi: {e}");
                String::new()
            }
        }
    };
    // HAFIZA BOSLUGU: en eski acik soru, yoksa 24 saati gecmis `asked` kaydi.
    // Satir ancak gateway `/asked` gecisini kabul ederse modele gider.
    let ek_hafiza_sorusu = {
        let b = bridge.clone();
        match tokio::task::spawn_blocking(move || b.hafiza_sorusu_satiri()).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[hafiza-boslugu] soru toplanamadi: {e}");
                String::new()
            }
        }
    };
    let ek = dinamik_ek(&EkBloklari {
        ekran: &ek_ekran,
        boot: &ek_boot,
        konusma: &ek_konusma,
        profil: &ek_profil,
        hafiza_sorusu: &ek_hafiza_sorusu,
    });
    // Ilk acilis ve devralma ayni yoldan gecer. Setup niyete degil,
    // gercekten kurulmus kapinin durumuna gore uretilir.
    // GERCEK MIKROFON KAPISI (`SMITH_MIC_STREAM`, varsayilan `gated`): yalniz
    // konusma varken ses gider. Yanki kapisi ve "mikrofonu sustur" `lib.rs`te
    // kareyle birlikte acik `kapali` isareti olarak gelir; bunlar HIC gonderilmez.
    // Silero kurulumu BLOKLAYICI (ONNX oturumu) -> spawn_blocking. Kurulamazsa
    // FAIL-OPEN: surekli akis (Smith sagir kalmaz), sebep log'a yazilir.
    let mut sunucu_vad = SunucuVad::env(false);
    let mut mik: Option<(
        crate::audio::vad::MikKapisi,
        crate::audio::vad::KonusmaIzleyici,
    )> = None;
    let mik_kipi = mik_akisi_env();
    // Continuous kipte de VAD hazir: gizlilik modu calisma aninda acilabilir.
    match tokio::task::spawn_blocking(crate::audio::vad::SileroVad::new).await {
        Ok(Ok(vad)) => {
            eprintln!(
                "[live] mikrofon kapisi ACIK (on-tampon {} ms, artik {} ms)",
                crate::audio::vad::ON_TAMPON_MS,
                sunucu_vad.silence_ms + 300
            );
            mik = Some((
                crate::audio::vad::MikKapisi::new(sunucu_vad.silence_ms + 300),
                crate::audio::vad::KonusmaIzleyici::new(Box::new(vad)),
            ));
        }
        Ok(Err(e)) => {
            eprintln!("[live] mikrofon kapisi kurulamadi (VAD: {e}): surekli akisa dusuldu");
            if dinleme_kipi() != DinlemeKipi::Herkes {
                let kip = dinleme_kipi();
                let uyari = if kip == DinlemeKipi::Isimle {
                    ADLA_UYARI
                } else {
                    DINLEME_UYARI
                };
                let _ = events.send(dinleme_olayi(kip, Some(uyari.into())));
            } else {
                mik_ariza_bildir(&events);
            }
        }
        Err(e) => {
            eprintln!("[live] mikrofon kapisi kurulamadi (gorev: {e}): surekli akisa dusuldu");
            if dinleme_kipi() != DinlemeKipi::Herkes {
                let kip = dinleme_kipi();
                let uyari = if kip == DinlemeKipi::Isimle {
                    ADLA_UYARI
                } else {
                    DINLEME_UYARI
                };
                let _ = events.send(dinleme_olayi(kip, Some(uyari.into())));
            } else {
                mik_ariza_bildir(&events);
            }
        }
    }
    sunucu_vad.gated =
        mik.is_some() && (mik_kipi == MikAkisi::Gated || dinleme_kipi() != DinlemeKipi::Herkes);
    write
        .send(Message::Text(setup_frame_model(
            niyet, &ek, sikistirma, &model, sunucu_vad,
        )))
        .await
        .map_err(|e| Kapanis::ag(format!("setup gonderilemedi: {e}")))?;

    // Ilk yanit `setupComplete` olmali; olmazsa protokol/anahtar sorunu var ve
    // bunu sessizce yutmak "mikrofon calismiyor" seklinde geri doner.
    //
    // TUZAK (sahada goruldu): sunucu JSON'u **BINARY** frame olarak yolluyor :
    // yalniz `Message::Text` beklemek "setup yaniti metin degil" hatasi verip
    // oturumu hic kurmuyordu (UI sonsuza dek "baglaniyor" gosterdi). Her iki
    // frame tipi de ayni JSON'u tasir; ikisini de kabul et.
    //
    // Devralma acikken sunucu araya bir `sessionResumptionUpdate` koyabilir
    // (dokumanda sirasi garanti edilmiyor); onu kaydedip aramaya devam ederiz.
    // Arama SINIRLI (5 frame): sinirsiz okumak, yanlis bir uc noktada oturumu
    // sonsuza dek "baglaniyor" halinde tutar.
    //
    // ZAMAN ASIMI (`SETUP_ZAMAN_ASIMI`): sunucu setup'i kabul edip hic yanit
    // vermezse bekleme sonsuz olurdu. Asim AG sinifidir. Setup asamasinda
    // sunucunun Close'u ve hata govdesi de siniflandirilir: yanlis anahtar
    // burada 1007/1008 ya da "API key not valid" govdesiyle gelir.
    let setup_suresi = setup_zaman_asimi(niyet);
    let setup_bekle = async {
        for _ in 0..5 {
            let msg = match read.next().await {
                Some(Ok(m)) => m,
                Some(Err(e)) => return Err(Kapanis::ag(format!("setup okunamadi: {e}"))),
                None => return Err(Kapanis::ag("baglanti setup oncesi kapandi")),
            };
            let body = match &msg {
                Message::Text(t) => t.to_string(),
                Message::Binary(b) => String::from_utf8_lossy(b).into_owned(),
                Message::Close(frame) => {
                    let (kod, sebep) = kapanma_bilgisi(frame.as_ref());
                    eprintln!("{}", kapanis_logu(kod, &sebep));
                    return Err(Kapanis::sunucudan(kod, &sebep, false));
                }
                other => return Err(Kapanis::ag(format!("beklenmeyen setup frame'i: {other:?}"))),
            };
            if body.contains("setupComplete") {
                iz.setup_tamam = true;
                break;
            }
            if let Some(h) = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| yeni_handle(&v))
            {
                kaydet_handle(handle_store, h, iz);
                continue;
            }
            return Err(Kapanis::sunucudan(
                None,
                &format!("beklenmeyen setup yaniti: {body}"),
                false,
            ));
        }
        if !iz.setup_tamam {
            return Err(Kapanis::ag(
                "setupComplete gelmedi (setup yaniti taninamadi)",
            ));
        }
        Ok(())
    };
    match tokio::time::timeout(setup_suresi, setup_bekle).await {
        Err(_) => {
            iz.setup_suresi_doldu = true;
            return Err(Kapanis::ag(format!(
                "setupComplete {} sn icinde gelmedi (zaman asimi)",
                setup_suresi.as_secs()
            )));
        }
        Ok(sonuc) => sonuc?,
    }
    let setup_ani = std::time::Instant::now();
    let oturum_no = yeni_oturum_no();
    eprintln!("[live] oturum hazir ({model}, ses={VOICE}, oturum_no={oturum_no})");
    let kurtarma = ifade_koruma
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .kurtarmayi_al();
    match kurtarma {
        Some(KesintiKurtarma::TamIfade { id, ses }) => {
            write
                .send(Message::Text(ses_cercevesi(&ses)))
                .await
                .map_err(|e| Kapanis::ag(format!("ifade replay sesi gonderilemedi: {e}")))?;
            write
                .send(Message::Text(akis_sonu_cercevesi()))
                .await
                .map_err(|e| Kapanis::ag(format!("ifade replay sonu gonderilemedi: {e}")))?;
            eprintln!("[live] kesinti kurtarma: tam ifade yeniden gonderildi id={id}");
            let _ = events.send(LiveEvent::Tool {
                ad: "baglanti_kurtarma".into(),
                durum: TOOL_BITTI,
                sebep: Some("Baglanti yenilendi; son soyledigin yeniden gonderildi.".into()),
            });
        }
        Some(KesintiKurtarma::TekrarIste { id }) => {
            let metin = "[Sistem bildirimi] Baglanti yenilendi; son soyledigini tekrar soylemesini Cihan'dan kisa ve nazikce iste.";
            write
                .send(Message::Text(bildirim_cercevesi(metin)))
                .await
                .map_err(|e| Kapanis::ag(format!("tekrar istemi gonderilemedi: {e}")))?;
            eprintln!("[live] kesinti kurtarma: kismi ifade replay edilmedi id={id:?}");
            let _ = events.send(LiveEvent::Tool {
                ad: "baglanti_kurtarma".into(),
                durum: TOOL_BITTI,
                sebep: Some("Baglanti yenilendi; son soyledigini tekrar soyle.".into()),
            });
        }
        None => {}
    }
    let _ = events.send(LiveEvent::Connected(true));
    if baglanti_yenileme {
        yenileme_bildir(&events);
    }

    // OTURUM-YEREL bitis bayragi. `stop` BU ISE KULLANILAMAZ: o bayrak tum Live
    // hattini kapatir (kullanicinin "sustur"u) ve `start`'taki yeniden baglanma
    // dongusu de ona bakar. Oturum sonunda `stop`'u set etmek, sunucunun ilk
    // sure-siniri kapanmasinda yeniden baglanmayi da olduruyordu: Smith
    // sessizce ve kalici olarak susuyordu. Gonderici ve ekran task'lari bu
    // yuzden IKI bayraga birlikte bakar: global durdurma + oturum sonu.
    let oturum_bitti = Arc::new(AtomicBool::new(false));

    // Cikan kontrol frame'leri (arac yanitlari) icin ikinci kanal: `write`
    // gonderici task'ina tasiniyor, alici task oraya dogrudan yazamaz.
    let (out_tx, mut out_rx) = mpsc::channel::<GidenCerceve>(8);

    // Gonderici: cihaz frekansindan 16k'ya indirir, s16le'ye cevirir, yollar.
    // Ayrica arac yanitlarini ayni WS'ten gecirir (tek yazar kurali).
    // ISTEMCI GURULTU KAPISI (ikinci savunma katmani): RMS bu esigin altindaki
    // kareler DIJITAL SESSIZLIGE cevrilir -> fan/kisik muzik sunucuya hic
    // ulasmaz, ama akis kesilmez (sessizlik gonderilir, boylece "konusma
    // bitti" tespiti calisir). Sadece esik altindaki gurultu bastirilir;
    // gercek konusma esigi asip oldugu gibi gecer. `hangover` konusma
    // bitisinin son hecesini kirpmamak icin birkac kareyi acik tutar.
    // Varsayilan 0.0 = KAPALI (sunucu tarafli LOW duyarlilik tek basina
    // yeterliyse istemci kapisi gerekmez); ortam cok gurultuluyse
    // `SMITH_MIC_GATE=0.012` gibi bir degerle ac. Cok yuksek verirsen kendi
    // konusmani keser : kademeli artir.
    let gate: f32 = std::env::var("SMITH_MIC_GATE")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0.0);

    // SES IZI KAPISI. Ayni 16 kHz akistan beslenir ama ISLEME AYRI BIR OS
    // THREAD'INDE yapilir: Silero ONNX cikarimi ve sidecar'in TCP gidis-donusu
    // blokedir; bunlari tek-thread'li runtime'a koymak ses akisini tikirdatir.
    // Kuyruk doluysa kare DUSER : dogrulama gercek-zamanli sese asla
    // backpressure uygulamaz (guvenlik kapisi konusmayi bozmamali).
    //
    // NOT: hoparlor yanki kapisi acikken bu akis `lib.rs`'te DIJITAL SESSIZLIGE
    // cevrilir; Smith'in kendi sesi bu yuzden "yabanci
    // konusmaci" olarak olculmez (bkz. speaker.rs "kendi sesi tuzagi").
    let spk_tx = if speaker.enabled() {
        let (tx, mut rx) = mpsc::channel::<SpeakerIs>(64);
        let gate_worker = speaker.clone();
        // Karar degisimini UI'a bildirmek icin olay kanali (bkz. LiveEvent::Speaker).
        let events_worker = events.clone();
        std::thread::spawn(move || {
            let vad = match crate::audio::vad::SileroVad::new() {
                Ok(v) => v,
                Err(e) => {
                    eprintln!(
                        "[speaker] VAD kurulamadi ({e}) — ifade sinirlari bulunamaz, \
                         hafizaya yazma BLOKE kalir"
                    );
                    return;
                }
            };
            let mut seg = crate::audio::vad::SpeechSegmenter::new(Box::new(vad), IN_RATE);
            let mut last_label: Option<String> = None;
            let mut son_epoch = None;
            while let Some(is) = rx.blocking_recv() {
                let (sinir, epoch) = match &is {
                    SpeakerIs::Kare(no, epoch, _) | SpeakerIs::Ifade { no, epoch, .. } => {
                        (*no, *epoch)
                    }
                };
                if epoch != dinleme_surumu() {
                    gate_worker.kare_kayip(sinir);
                    gate_worker.kare_islendi(sinir, false);
                    continue;
                }
                if son_epoch != Some(epoch) {
                    seg.sifirla();
                    gate_worker.dogrulanamadi();
                    last_label = None;
                    son_epoch = Some(epoch);
                }
                let (no, frame) = match is {
                    SpeakerIs::Kare(no, _, frame) => (no, frame),
                    SpeakerIs::Ifade {
                        no,
                        epoch: _,
                        ses,
                        konusma_ornek,
                        yanit,
                    } => {
                        gate_worker.ifade_basladi(no);
                        let v = if konusma_ornek < crate::audio::speaker::MIN_OWNER_SAMPLES {
                            gate_worker.kisa_ifade();
                            crate::audio::SpeakerVerdict::Unknown
                        } else {
                            gate_worker.verify(&ses)
                        };
                        let v = if epoch != dinleme_surumu() {
                            gate_worker.kare_kayip(no);
                            gate_worker.dogrulanamadi();
                            crate::audio::SpeakerVerdict::Unknown
                        } else {
                            v
                        };
                        gate_worker.kare_islendi(no, false);
                        let _ = events_worker.send(LiveEvent::Speaker(match v {
                            crate::audio::SpeakerVerdict::Owner => "owner",
                            crate::audio::SpeakerVerdict::Foreign => "foreign",
                            crate::audio::SpeakerVerdict::Unknown => "unknown",
                        }));
                        let _ = yanit.send(v);
                        seg.sifirla();
                        continue;
                    }
                };
                let once_konusuyor = seg.konusuyor();
                let mut final_var = false;
                for ev in seg.feed(&frame) {
                    if matches!(ev, crate::audio::vad::SpeechEvent::Start) {
                        gate_worker.ifade_basladi(no);
                    }
                    // Yalniz tamamlanmis ifade dogrulanir: Partial'lar buyuyen
                    // ayni tamponu tasir, her birini dogrulamak ayni karari
                    // tekrar tekrar hesaplamak olurdu.
                    if let crate::audio::vad::SpeechEvent::Final(utt) = ev {
                        final_var = true;
                        let v = if seg.son_final_konusma_ornek()
                            < crate::audio::speaker::MIN_OWNER_SAMPLES
                        {
                            gate_worker.kisa_ifade();
                            crate::audio::SpeakerVerdict::Unknown
                        } else {
                            gate_worker.verify(&utt)
                        };
                        let v = if epoch != dinleme_surumu() {
                            gate_worker.kare_kayip(no);
                            gate_worker.dogrulanamadi();
                            crate::audio::SpeakerVerdict::Unknown
                        } else {
                            v
                        };
                        let label = match v {
                            crate::audio::SpeakerVerdict::Owner => "owner",
                            crate::audio::SpeakerVerdict::Foreign => "foreign",
                            crate::audio::SpeakerVerdict::Unknown => "unknown",
                        };
                        // Yalniz DEGISINCE bildir: her ifadede olay gondermek
                        // UI'i bosa render eder.
                        if last_label.as_deref() != Some(label) {
                            last_label = Some(label.to_string());
                            let _ = events_worker.send(LiveEvent::Speaker(label));
                        }
                    }
                }
                if once_konusuyor && !seg.konusuyor() && !final_var {
                    if seg.konusma_ornek() < crate::audio::speaker::MIN_OWNER_SAMPLES {
                        gate_worker.kisa_ifade();
                    } else {
                        gate_worker.dogrulanamadi();
                    }
                }
                gate_worker.kare_islendi(no, seg.konusuyor());
            }
        });
        Some(tx)
    } else {
        None
    };

    // En fazla uygulanacak kazanc. 8x zayif mikrofonu konusma seviyesine
    // tasir; `SMITH_MIC_GAIN=1` ile kapatilir (kazanc uygulanmaz).
    let gain_target: f32 = std::env::var("SMITH_MIC_GAIN")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .filter(|v: &f32| (1.0..=20.0).contains(v))
        .unwrap_or(8.0);
    let stop_send = stop.clone();
    let gecikme = Arc::new(std::sync::Mutex::new(GecikmeOlcer::default()));
    let gecikme_send = gecikme.clone();
    let tur_ozeti = Arc::new(std::sync::Mutex::new(TurOzeti::default()));
    let tur_ozeti_send = tur_ozeti.clone();
    let sessizlik = Arc::new(std::sync::Mutex::new(SunucuSessizligi::default()));
    let sessizlik_send = sessizlik.clone();
    let arac_teslim = Arc::new(std::sync::Mutex::new(AracTeslimIzi::default()));
    let arac_teslim_send = arac_teslim.clone();
    let bitti_send = oturum_bitti.clone();
    let speaker_send = speaker.clone();
    let events_send = events.clone();
    let yanit_izni = Arc::new(std::sync::Mutex::new(YanitIzni::default()));
    let yanit_izni_send = yanit_izni.clone();
    let ifade_koruma_send = ifade_koruma.clone();
    // Yerel VAD'in "kullanici simdi konusuyor" karari: sistem bildirimi sunucu
    // transkriptini beklemeden araya girmesin (kapi kapaliysa hep false).
    let mik_konusuyor = Arc::new(AtomicBool::new(false));
    let mik_konusuyor_send = mik_konusuyor.clone();
    let sender = tokio::spawn(async move {
        let mut resampler: Option<(u32, LinearResampler)> = None;
        let mut buf16k: Vec<f32> = Vec::new();
        let mut gate_hangover: i32 = 0;
        let mut peak_est: f32 = 0.0;
        let mut spk_kayip = KareKaybi::default();
        let mut sahip_tampon = crate::audio::vad::SahipTamponu::default();
        let mut isim_kapisi = IsimKapisi::default();
        let mut dinleme_epoch = dinleme_surumu();
        let mut dinleme_modu = dinleme_kipi();
        let mut son_konusma = None;
        let mut konusuyordu = false;
        let mut uyari_gosterildi = false;
        let _ = events_send.send(dinleme_olayi(dinleme_modu, None));
        let mut ses_serisi = 0;
        'ana: loop {
            let MikKaresi {
                samples,
                rate,
                kapali: mik_kapali,
                at: kare_ani,
                listen_epoch,
            } = match siradaki(&pcm_rx, &mut out_rx, &mut ses_serisi).await {
                Gonderim::Ses(kare) => kare,
                Gonderim::Kontrol(frame) => {
                    if kontrol_gonder(
                        &mut write,
                        frame,
                        &gecikme_send,
                        &sessizlik_send,
                        &arac_teslim_send,
                    )
                    .await
                    .is_err()
                    {
                        break;
                    }
                    continue;
                }
            };
            if stop_send.load(Ordering::Relaxed)
                || bitti_send.load(Ordering::Relaxed)
                || KAPANIYOR.load(Ordering::Relaxed)
            {
                break;
            }
            // Yakalama anindaki mod degismisse KUYRUKTAKI eski kareler atilir.
            if !mik_kare_guncel(listen_epoch, dinleme_surumu()) {
                continue;
            }
            let rs = match resampler.as_mut() {
                Some((r, rs)) if *r == rate => rs,
                _ => {
                    resampler = Some((rate, LinearResampler::new(rate, IN_RATE)));
                    &mut resampler.as_mut().expect("kuruldu").1
                }
            };
            buf16k.clear();
            rs.process(&samples, &mut buf16k);
            if buf16k.is_empty() {
                continue;
            }
            let yeni_mod = dinleme_kipi();
            let yeni_sur = dinleme_surumu();
            if yeni_sur != dinleme_epoch || yeni_mod != dinleme_modu {
                dinleme_modu = yeni_mod;
                dinleme_epoch = yeni_sur;
                dinleme_tamponunu_sifirla(&mut sahip_tampon, &mut isim_kapisi);
                let sinir = speaker_send.kare_sirala();
                speaker_send.kare_kayip(sinir);
                if let Some((kapi, izleyici)) = mik.as_mut() {
                    *kapi = crate::audio::vad::MikKapisi::new(sunucu_vad.silence_ms + 300);
                    izleyici.sifirla();
                }
                resampler = None;
                konusuyordu = false;
                son_konusma = None;
                uyari_gosterildi = false;
                let _ = events_send.send(dinleme_olayi(dinleme_modu, None));
                continue;
            }
            if dinleme_modu == DinlemeKipi::Isimle
                && !uyari_gosterildi
                && stt_isinmasi().is_some_and(|is| is.kalan(std::time::Instant::now()).is_err())
            {
                let _ = events_send.send(dinleme_olayi(dinleme_modu, Some(ADLA_UYARI.into())));
                uyari_gosterildi = true;
            }
            // Ses izi kapisina kopya: `buf16k` her turda temizlendigi icin
            // kopya sart. Gurultu kapisi UYGULANMADAN once gonderiyoruz :
            // susturulmus kare dogrulamaya kirpilmis konusma olarak gider.
            if let Some(tx) = spk_tx
                .as_ref()
                .filter(|_| dinleme_modu != DinlemeKipi::YalnizBeni)
            {
                let no = speaker_send.kare_sirala();
                if let Err(hata) = tx.try_send(SpeakerIs::Kare(no, dinleme_epoch, buf16k.clone())) {
                    speaker_send.kare_kayip(no);
                    if matches!(hata, mpsc::error::TrySendError::Full(_)) {
                        spk_kayip.bildir("ses izi");
                    }
                }
            }
            // Neden AGC degil de tepe-takipli sabit hedef: konusma icinde
            // kare-kare normalize etmek sessiz kareleri buyutup gurultuyu
            // pompalar. Burada YAVAS hareket eden bir tepe tahmini tutulur,
            // kazanc ondan turer ve kirpilma tepeye gore sinirlanir. Env ile
            // kapatilabilir (`SMITH_MIC_GAIN=1`).
            if gain_target > 1.0 {
                let peak = buf16k.iter().fold(0.0f32, |m, s| m.max(s.abs()));
                // Tepe tahmini: hizli yukselir, yavas duser (konusma zarfini takip
                // eder, tek bir patlamayla kalibrasyonu bozmaz).
                peak_est = if peak > peak_est {
                    peak * 0.5 + peak_est * 0.5
                } else {
                    peak_est * 0.995
                };
                if peak_est > 1e-4 {
                    // Hedef tepe 0.6: transkripsiyon icin bol pay, kirpilma yok.
                    let g = (0.6 / peak_est).clamp(1.0, gain_target);
                    for s in buf16k.iter_mut() {
                        *s = (*s * g).clamp(-1.0, 1.0);
                    }
                }
            }

            // Gurultu kapisi: esik altindaki kareyi sustur (hangover haric).
            let mut voiced = true;
            if gate > 0.0 {
                let rms = (buf16k.iter().map(|s| s * s).sum::<f32>() / buf16k.len() as f32).sqrt();
                if rms >= gate {
                    gate_hangover = 8; // ~konusma bitisinde birkac kare tasi
                } else if gate_hangover > 0 {
                    gate_hangover -= 1;
                } else {
                    voiced = false;
                }
            }
            if !voiced {
                buf16k.iter_mut().for_each(|s| *s = 0.0);
            }
            // KAPI KARARI. `Continuous` (ya da VAD kurulamadi): her kare, eski
            // davranis birebir. `Gated`: kare kapali-donem karesiyse KAPALI,
            // degilse Silero karari; durum makinesi (`vad::MikKapisi`) hangi
            // sesin gidecegine ve `audioStreamEnd` anina karar verir. Ses izi
            // kopyasi yukarida, kapidan BAGIMSIZ olarak zaten beslendi.
            let gated = mik.is_some();
            let mut hazir_ifadeler = Vec::new();
            let mut giden =
                if mik_kipi == MikAkisi::Continuous && dinleme_modu == DinlemeKipi::Herkes {
                    mikrofon_adim(&mut None, &buf16k, mik_kapali)
                } else {
                    mikrofon_adim_izli(&mut mik, &buf16k, mik_kapali, |n, durum, cikti, kalan| {
                        mik_konusuyor_send.store(
                            durum == crate::audio::vad::KareDurumu::Konusma,
                            Ordering::Relaxed,
                        );
                        let simdi =
                            kare_ani - std::time::Duration::from_secs_f64(kalan as f64 / 16_000.0);
                        if dinleme_modu != DinlemeKipi::Herkes {
                            if durum == crate::audio::vad::KareDurumu::Konusma
                                && sahip_tampon.konusma_ornek == 0
                            {
                                let no = speaker_send.kare_sirala();
                                speaker_send.ifade_basladi(no);
                            }
                            if let Some(ifade) = sahip_tampon.isle(n, durum, cikti, simdi) {
                                hazir_ifadeler.push(ifade);
                            }
                        } else if durum == crate::audio::vad::KareDurumu::Konusma {
                            son_konusma = Some(simdi);
                            konusuyordu = true;
                        } else if konusuyordu {
                            if let Some(son) = son_konusma {
                                gecikme_send
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .konusma_sonu(son);
                                tur_ozeti_send
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .yerel_ses_sonu(son);
                            }
                            konusuyordu = false;
                        }
                    })
                };
            if dinleme_modu != DinlemeKipi::Herkes {
                if mik.is_none() || (dinleme_modu == DinlemeKipi::YalnizBeni && spk_tx.is_none()) {
                    sahip_tampon = crate::audio::vad::SahipTamponu::default();
                    if !uyari_gosterildi {
                        eprintln!("[live] {DINLEME_UYARI}");
                        let uyari = if dinleme_modu == DinlemeKipi::Isimle {
                            ADLA_UYARI
                        } else {
                            DINLEME_UYARI
                        };
                        let _ = events_send.send(dinleme_olayi(dinleme_modu, Some(uyari.into())));
                        uyari_gosterildi = true;
                    }
                    continue;
                }
                if mik_kapali {
                    sahip_tampon = crate::audio::vad::SahipTamponu::default();
                    continue;
                }
                let mut hazir = Vec::new();
                for ifade in hazir_ifadeler {
                    let ses = ifade.ses;
                    if dinleme_modu == DinlemeKipi::Isimle {
                        let baslangic = std::time::Instant::now();
                        let stt_ses = ses.clone();
                        let isinma = stt_isinmasi();
                        let isinma_suresi = isinma
                            .as_ref()
                            .and_then(|is| is.kalan(baslangic).ok())
                            .unwrap_or_default();
                        let bekle = yerel_stt(
                            stt_ses,
                            isinma,
                            std::net::SocketAddr::from(([127, 0, 0, 1], 8123)),
                        );
                        let bekle = tokio::time::timeout(isinma_suresi + STT_ZAMAN_ASIMI, bekle);
                        tokio::pin!(bekle);
                        let metin = loop {
                            tokio::select! {
                                biased;
                                Some(frame) = out_rx.recv() => {
                                    if kontrol_gonder(&mut write, frame, &gecikme_send, &sessizlik_send, &arac_teslim_send).await.is_err() { break 'ana; }
                                }
                                sonuc = &mut bekle => break match sonuc {
                                    Ok(Ok(metin)) => Ok(metin),
                                    _ => Err(()),
                                },
                                _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {
                                    if dinleme_surumu() != dinleme_epoch || stop_send.load(Ordering::Relaxed)
                                        || bitti_send.load(Ordering::Relaxed) { break Err(()); }
                                }
                            }
                        };
                        if dinleme_surumu() != dinleme_epoch {
                            continue;
                        }
                        let stt_suresi = baslangic.elapsed();
                        let karar = isim_kapisi
                            .karar(metin.as_deref().map_err(|_| ()), std::time::Instant::now());
                        let _ = events_send
                            .send(dinleme_olayi(dinleme_modu, karar.err().map(str::to_owned)));
                        if karar == Ok(true) && !ses.is_empty() {
                            {
                                let mut olcer =
                                    gecikme_send.lock().unwrap_or_else(|e| e.into_inner());
                                if let Some(son) = ifade.son_konusma {
                                    olcer.konusma_sonu(son);
                                    tur_ozeti_send
                                        .lock()
                                        .unwrap_or_else(|e| e.into_inner())
                                        .yerel_ses_sonu(son);
                                }
                                olcer.stt(stt_suresi);
                            }
                            // Sonraki ifadenin kararindan ONCE gercek gonderim.
                            let gonderim = std::time::Instant::now();
                            yanit_izni_send
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .gonderildi(dinleme_epoch);
                            ifade_koruma_send
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .ses(&ses);
                            for frame in [ses_cercevesi(&ses), akis_sonu_cercevesi()] {
                                if dinleme_surumu() != dinleme_epoch {
                                    break;
                                }
                                if write.send(Message::Text(frame)).await.is_err() {
                                    break 'ana;
                                }
                            }
                            if dinleme_surumu() == dinleme_epoch {
                                ifade_koruma_send
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .akis_sonu();
                                isim_kapisi.gonderildi(std::time::Instant::now());
                                gecikme_send
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .tampon_gonderimi(gonderim.elapsed());
                                sessizlik_send
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .baslat(std::time::Instant::now());
                            }
                        }
                        continue;
                    }
                    let no = speaker_send.kare_sirala();
                    speaker_send.ifade_basladi(no);
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    let is = SpeakerIs::Ifade {
                        no,
                        epoch: dinleme_epoch,
                        ses: ses.clone(),
                        konusma_ornek: ifade.konusma_ornek,
                        yanit: tx,
                    };
                    let tx = spk_tx.as_ref().expect("kapi var");
                    let bekle = async {
                        if tx.send(is).await.is_err() {
                            return crate::audio::SpeakerVerdict::Unknown;
                        }
                        rx.await.unwrap_or(crate::audio::SpeakerVerdict::Unknown)
                    };
                    tokio::pin!(bekle);
                    let son_sure = tokio::time::Instant::now() + std::time::Duration::from_secs(12);
                    let karar = loop {
                        tokio::select! {
                            biased;
                            // Sidecar beklenirken arac/ekran yanitlari da ilerler.
                            Some(frame) = out_rx.recv() => {
                                if kontrol_gonder(&mut write, frame, &gecikme_send, &sessizlik_send, &arac_teslim_send).await.is_err() { break 'ana; }
                            }
                            v = &mut bekle => break v,
                            _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {
                                if dinleme_surumu() != dinleme_epoch
                                    || stop_send.load(Ordering::Relaxed) || bitti_send.load(Ordering::Relaxed)
                                    || tokio::time::Instant::now() >= son_sure {
                                    // Gec sidecar sonucu, iptal edilen ifadenin yetkisini acamaz.
                                    speaker_send.kare_kayip(no);
                                    break crate::audio::SpeakerVerdict::Unknown;
                                }
                            }
                        }
                    };
                    if dinleme_surumu() != dinleme_epoch {
                        sahip_tampon = crate::audio::vad::SahipTamponu::default();
                        continue;
                    }
                    uyari_gosterildi = karar != crate::audio::SpeakerVerdict::Owner;
                    if uyari_gosterildi {
                        eprintln!("[live] yalniz beni: ifade atildi ({karar:?})");
                    }
                    if karar == crate::audio::SpeakerVerdict::Owner {
                        if let Some(son) = ifade.son_konusma {
                            gecikme_send
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .konusma_sonu(son);
                            tur_ozeti_send
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .yerel_ses_sonu(son);
                        }
                    }
                    hazir.extend(sahip_sonucu(ses, karar, &events_send));
                }
                // Ayni callback'te baslayan sonraki yarim ifade taze yetkiyi kapatir.
                if sahip_tampon.konusma_ornek > 0 {
                    let no = speaker_send.kare_sirala();
                    speaker_send.ifade_basladi(no);
                }
                giden = hazir;
            } else if gated && mik.is_none() {
                mik_ariza_bildir(&events_send);
            }
            // Dogrulama beklerken degisen mod eski tamponu acamaz.
            if dinleme_surumu() != dinleme_epoch {
                continue;
            }
            let gonderim_baslangic = std::time::Instant::now();
            let tampon_gonderiliyor = dinleme_modu != DinlemeKipi::Herkes && !giden.is_empty();
            for parca in giden {
                if dinleme_surumu() != dinleme_epoch {
                    break;
                }
                let akis_sonu = matches!(parca, crate::audio::vad::KapiCikti::AkisSonu);
                let kullanici_sesi = !mik_kapali
                    && matches!(
                        &parca, crate::audio::vad::KapiCikti::Ses(ses)
                        if ses.iter().any(|s| s.abs() > 1e-5)
                    );
                let frame = match parca {
                    crate::audio::vad::KapiCikti::Ses(ses) => {
                        ifade_koruma_send
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .ses(&ses);
                        ses_cercevesi(&ses)
                    }
                    crate::audio::vad::KapiCikti::AkisSonu => akis_sonu_cercevesi(),
                };
                if write.send(Message::Text(frame)).await.is_err() {
                    break 'ana;
                }
                let simdi = std::time::Instant::now();
                if akis_sonu {
                    ifade_koruma_send
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .akis_sonu();
                    tur_ozeti_send
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .akis_sonu_yazildi(simdi);
                }
                let mut olcer = gecikme_send.lock().unwrap_or_else(|e| e.into_inner());
                if kullanici_sesi
                    && mik_kipi == MikAkisi::Continuous
                    && dinleme_modu == DinlemeKipi::Herkes
                {
                    olcer.ses(simdi);
                }
                if akis_sonu {
                    sessizlik_send
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .baslat(simdi);
                }
            }
            if tampon_gonderiliyor {
                let sure = gonderim_baslangic.elapsed();
                gecikme_send
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .tampon_gonderimi(sure);
                eprintln!(
                    "[live] yalniz beni: tampon gonderimi {} us",
                    sure.as_micros()
                );
            }
        }
        let _ = write.close().await;
    });

    // EKRAN AKISI: dusuk kare hiziyla ekrani ayni WS'ten `realtimeInput.video`
    // olarak yollar. Yakalama BLOKLAYICI (GDI/DXGI) -> spawn_blocking; aksi
    // halde tek-thread runtime'da ses akisi tikirdar. Hata karesi atlanir,
    // oturum dusmez.
    //
    // DONGU OTURUMDA HER ZAMAN KURULUR: akis calisma zamaninda acilip kapanir
    // (`screen::akis_ayarla`: "ekranimi izle" araci ya da arayuz). Her tikta
    // `akis_acik()` okunur; KAPALIYKEN yakalama yapilmaz, 500 ms uyunur.
    // Durum DEGISINCE UI'a `EKRAN_AKISI_DURUMU` olayi gider.
    {
        let out = out_tx.clone();
        let stop_screen = stop.clone();
        let bitti_screen = oturum_bitti.clone();
        let events_screen = events.clone();
        let interval = crate::audio::screen::interval_ms();
        let baslangic = crate::audio::screen::akis_acik();
        eprintln!(
            "[screen] akis dongusu hazir (baslangic: {}, {interval} ms aralik)",
            if baslangic { "ACIK" } else { "kapali" }
        );
        tokio::spawn(async move {
            let mut bildirilen = baslangic;
            loop {
                if stop_screen.load(Ordering::Relaxed) || bitti_screen.load(Ordering::Relaxed) {
                    break;
                }
                let surum = crate::audio::screen::akis_surumu();
                let acik = surum & 1 == 1;
                if acik != bildirilen {
                    bildirilen = acik;
                    eprintln!(
                        "[screen] ekran akisi {}",
                        if acik { "ACILDI" } else { "kapatildi" }
                    );
                    let _ = events_screen.send(ekran_akisi_olayi(acik));
                }
                if !acik {
                    tokio::time::sleep(EKRAN_KAPALI_UYKU).await;
                    continue;
                }
                // COK MONITOR: tek kare yerine SECIME gore kare LISTESI.
                // Kareler ayni tikta sirayla gonderilir; sira `screen`
                // modulunde (x, y, id) ile deterministik, yonergedeki
                // "soldan saga" cumlesi buna dayaniyor.
                let izin = || {
                    crate::audio::screen::akis_surumu() == surum
                        && !stop_screen.load(Ordering::Relaxed)
                        && !bitti_screen.load(Ordering::Relaxed)
                };
                match ekran_yakala(crate::audio::screen::capture_jpeg_frames, izin).await {
                    Ok(kareler) => {
                        let mut kesildi = false;
                        for kare in kareler {
                            if !izin() {
                                break;
                            }
                            let frame = serde_json::json!({
                                "realtimeInput": {
                                    "video": {
                                        "mimeType": "image/jpeg",
                                        "data": base64::engine::general_purpose::STANDARD
                                            .encode(&kare.jpeg)
                                    }
                                }
                            })
                            .to_string();
                            if !izin() {
                                break;
                            }
                            if out
                                .send(GidenCerceve::Ekran {
                                    metin: frame,
                                    surum,
                                })
                                .await
                                .is_err()
                            {
                                kesildi = true; // oturum kapandi
                                break;
                            }
                        }
                        if kesildi {
                            break;
                        }
                    }
                    Err(e) => eprintln!("[screen] kare atlandi: {e}"),
                }
                tokio::time::sleep(std::time::Duration::from_millis(interval)).await;
            }
        });
    }

    // Arac koprusu (`bridge`) setup'tan once kuruldu: son konusma blogu onun
    // uzerinden alindi. Model fonksiyon cagirdiginda ayni kopru kullanilir; olay
    // kanali bagli oldugu icin her cagri UI'da gorunur (`audio://tool`).

    // Konusma logu durumu: parcalar birikir, rol degisince/tur bitince yazilir.
    // `Some(false)` = kullanici, `Some(true)` = Smith.
    let _alici_kaydi = AliciKaydi::yeni();
    let mut tampon = TurTamponu::default();
    let mut tur_kayitlari = TurKayitlari::default();
    // Olay kanali sinirsiz: tuketici durursa Smith sesi sinirsiz birikmesin diye
    // kanaldaki ses `MAX_QUEUED_SECONDS` ile sinirlanir (bkz. `SesParcasi`).
    let ses_butcesi = Arc::new(AtomicUsize::new(0));
    let mut ses_kayip = KareKaybi::default();
    // KALICI KAYIT: tamamlanan her replik arka plan yazicisina gider.
    // `None` = kapali (SMITH_CONVERSATION_MEMORY=0) -> yalniz log satiri kalir.
    // Yazici yeniden baglanma dongusunden odunc alinir.
    // UYDURMA TESPITI: bu turda arac cagrildi mi? Model "inceledim/taradim"
    // derken hicbir arac cagrilmamissa bu bir uydurmadir (sahada gorulen kusur,
    // bkz. `iddia_izi`). Son arac zamani da tutulur cunku model onceki turda
    // gercekten cagirdigi bir araca atifta bulunabilir : o yanlis pozitif olur.
    let mut turda_arac = 0usize;
    let son_arac_yaniti = Arc::new(std::sync::Mutex::new(None::<std::time::Instant>));
    let mut arac_isleri: std::collections::HashMap<String, Arc<AtomicBool>> =
        std::collections::HashMap::new();
    let mut son_arac = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_secs(3600))
        .unwrap_or_else(std::time::Instant::now);
    // EKRAN TAHMINI: bu turda NET KARE istendi mi? `turda_arac` bu is icin
    // yetmez : hangi ARACIN cagrildigi gerekiyor (terminal komutu ekranin
    // uzerinde ne oldugu hakkinda kanit uretmez), o yuzden AYRI BAYRAK.
    //
    // SPAWN TUZAGI (bu dosyada bir kez yasandi, bkz. asagidaki sayac notu):
    // bayrak `tokio::spawn(async move ...)` icine konursa `bool` Copy oldugu
    // icin closure bir KOPYA tasir, dis degisken HIC degismez ve tespit tamamen
    // gurultuye doner. Bu yuzden spawn'in DISINDA set edilir.
    let mut turda_net_kare = false;
    let mut son_net_kare = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_secs(3600))
        .unwrap_or_else(std::time::Instant::now);

    // Alicinin bitis nedeni. `None` kalirsa dongu `stop` ile ya da akisin
    // kendiliginden bitmesiyle sonlandi (asagida ayrilir).
    let mut kapanis: Option<Kapanis> = None;

    // Sistem bildirimi zamanlayicisi (bkz. `bildirim`): model ve kullanici
    // etkinligi asagidaki alim dongusunden beslenir, gonderim `tik` kolunda.
    let mut bildirim = Zamanlayici::yeni(std::time::Instant::now());

    // Alici: transkripsiyon + ses + kesinti + arac cagrilari.
    let mut tik = tokio::time::interval(std::time::Duration::from_millis(100));
    let mut alici_epoch = dinleme_surumu();
    loop {
        let simdiki_epoch = dinleme_surumu();
        if alici_epoch != simdiki_epoch {
            alici_epoch = simdiki_epoch;
            sessizlik.lock().unwrap_or_else(|e| e.into_inner()).bitir();
            gecikme.lock().unwrap_or_else(|e| e.into_inner()).sifirla();
            if dinleme_kipi() == DinlemeKipi::Isimle {
                let _ = events.send(LiveEvent::Interrupted);
                tampon = TurTamponu::default();
            }
        }
        let msg = tokio::select! {
            msg = read.next() => match msg { Some(m) => m, None => break },
            _ = tik.tick() => {
                if stop.load(Ordering::Relaxed) || KAPANIYOR.load(Ordering::Relaxed) { break; }
                tur_kayitlari.ilerle(&speaker, kayit_tx);
                let simdi = std::time::Instant::now();
                match tur_ozeti
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .kontrol(simdi)
                {
                    Some(YanitsizEylem::YenidenIste { utterance_id, transcript }) => {
                        let transcript: String = transcript.chars().take(500).collect();
                        let metin = format!(
                            "[Sistem bildirimi] Cihan sana dedi ki: '{transcript}'. Kisaca cevap ver. Bu onceki ifadenin tekraridir; zaten cevap uretiyorsan ikinci cevap uretme."
                        );
                        match out_tx.try_send(GidenCerceve::Kontrol(bildirim_cercevesi(&metin))) {
                            Ok(()) => eprintln!(
                                "[no_response] yeniden istem gonderildi utterance_id={utterance_id}"
                            ),
                            Err(e) => eprintln!(
                                "[no_response] yeniden istem kuyruga yazilamadi utterance_id={utterance_id}: {e}"
                            ),
                        }
                    }
                    Some(YanitsizEylem::YenidenBaglan { utterance_id }) => {
                        eprintln!(
                            "[no_response] 30 sn: kontrollu yeniden baglanma utterance_id={utterance_id}"
                        );
                        iz.bekci_yenilemesi = true;
                        kapanis = Some(Kapanis {
                            sinif: KapanisSinifi::Planli,
                            kod: None,
                            sebep: format!("yanitsiz tur utterance_id={utterance_id}"),
                        });
                        let _ = events.send(LiveEvent::Interrupted);
                        break;
                    }
                    None => {}
                }
                let handle_var = devralma_acik() && handle_store.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|h| !h.is_empty());
                if handle_var && sessizlik.lock().unwrap_or_else(|e| e.into_inner()).yenile(simdi) {
                    eprintln!("[live] acik model turunda 30 sn mesaj yok: baglanti devralmayla yenileniyor");
                    iz.bekci_yenilemesi = true;
                    kapanis = Some(Kapanis { sinif: KapanisSinifi::Planli, kod: None, sebep: "takilan tur".into() });
                    let _ = events.send(LiveEvent::Interrupted);
                    break;
                }
                if let Some(sn) = sessizlik.lock().unwrap_or_else(|e| e.into_inner()).kontrol(std::time::Instant::now()) {
                    eprintln!("[live] sunucu sessiz: {sn} sn");
                }
                // SISTEM BILDIRIMI: kuyrukta bekleyen varsa ve oturum bostaysa (ya da
                // tavan dolduysa) gonderilir. Kanal doluysa/kapaliysa metin kuyruga doner.
                // Oyun modunda (adla seslenilmedikce susan kip) yalniz ONCELIKLI
                // bildirim (hatirlatma) gider ve cevabina izin acilir.
                arac_isleri.retain(|_, iptal| !iptal.load(Ordering::Relaxed));
                let oyun_modu = dinleme_kipi() == DinlemeKipi::Isimle;
                if let Some(b) = teslim_icin_al(
                    &mut bildirim,
                    simdi,
                    mik_konusuyor.load(Ordering::Relaxed),
                    arac_isleri.len(),
                    oyun_modu,
                ) {
                    cevaba_izin_ver(
                        &b,
                        oyun_modu,
                        dinleme_surumu(),
                        &mut yanit_izni.lock().unwrap_or_else(|e| e.into_inner()),
                    );
                    match out_tx.try_send(GidenCerceve::Kontrol(bildirim_cercevesi(&b.metin))) {
                        Ok(()) => eprintln!(
                            "[bildirim] oturuma iletildi ({} karakter)",
                            b.metin.chars().count()
                        ),
                        Err(_) => geri_koy(b),
                    }
                }
                continue;
            }
        };
        if stop.load(Ordering::Relaxed) || KAPANIYOR.load(Ordering::Relaxed) {
            break;
        }
        let text = match msg {
            Ok(Message::Text(t)) => t,
            Ok(Message::Binary(b)) => String::from_utf8_lossy(&b).into_owned(),
            // KAPANIS NEDENI: kod ve sebep eskiden burada ATILIYORDU. Simdi
            // loglanir ve siniflandirilir (geri cekilme buna bakar).
            Ok(Message::Close(frame)) => {
                let (kod, sebep) = kapanma_bilgisi(frame.as_ref());
                eprintln!("{}", kapanis_logu(kod, &sebep));
                kapanis = Some(Kapanis::sunucudan(kod, &sebep, iz.go_away));
                break;
            }
            // Okuma hatasi (baglanti sifirlandi, protokol hatasi): AG sinifi,
            // ama goAway ile haber verilmis bir kapanisin ardindan gelirse
            // planli sayilir (sunucu kapatirken el sikisma yapmadan keser).
            Err(e) => {
                eprintln!("[live] okuma hatasi: {e}");
                kapanis = Some(if iz.go_away {
                    Kapanis::sunucudan(None, &format!("okuma hatasi: {e}"), true)
                } else {
                    Kapanis::ag(format!("okuma hatasi: {e}"))
                });
                break;
            }
            Ok(_) => continue,
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        // TOKEN SAYACI: usageMetadata baska alanlarla (serverContent vb.) AYNI
        // mesajda gelebilir, bu yuzden asagidaki erken `continue`lerden ONCE
        // okunur ve mesaj islenmeye devam eder. Yalniz sayaclar yazilir.
        if let Some((kayit, unix)) = kullanim_hazirla(&v, oturum_no, &model, simdi_unix) {
            kullanim_kaydet(&kayit, unix);
        }
        // DEVRALMA NOKTASI: sunucu belirli checkpoint'lerde yeni bir handle
        // yollar. Sakla : baglanti koptugunda bir sonraki `setup` bunu tasir ve
        // AYNI konusma devam eder. Bu olmadan Smith her ~10 dakikada bir o turun
        // diyalogunu tamamen unutuyordu.
        if let Some(h) = yeni_handle(&v) {
            kaydet_handle(handle_store, h, iz);
            continue;
        }
        // GOAWAY: sunucu kapatacagini ONCEDEN haber verir (`timeLeft`). Iki isi
        // var: (a) kapanma surpriz olmaktan cikar, (b) planli kapanma oturumun
        // SAGLIKLI oldugunun kanitidir, yani elimizdeki handle iyi.
        if let Some(kalan) = go_away_kalan(&v) {
            iz.go_away = true;
            eprintln!("[live] sunucu kapanma haberi verdi (kalan: {kalan})");
            continue;
        }
        // ARAC CAGRISI: `toolCall.functionCalls[]`. Her cagri gateway'e gider
        // ve yaniti `toolResponse` olarak ayni WS'ten geri doner. HTTP cagrisi
        // BLOKLAYICI (ureq) -> spawn_blocking, aksi halde tek-thread runtime
        // ses akisini durdururdu.
        arac_isleri.retain(|_, iptal| !iptal.load(Ordering::Relaxed));
        if let Some(ids) = v["toolCallCancellation"]["ids"].as_array() {
            for id in ids.iter().filter_map(serde_json::Value::as_str) {
                sessizlik
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .arac_gonderildi(id, std::time::Instant::now());
                if let Some(iptal) = arac_isleri.remove(id) {
                    iptal.store(true, Ordering::Relaxed);
                }
            }
        }
        let yanit_serbest = yanit_izni
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .serbest(dinleme_kipi(), dinleme_surumu());
        if !yanit_serbest && (v.get("serverContent").is_some() || v.get("toolCall").is_some()) {
            if let Some(calls) = v["toolCall"]["functionCalls"].as_array() {
                // BLOCKING arac cevapsiz kalirsa sonraki seslenis de bekler.
                let _ = out_tx
                    .send(GidenCerceve::Kontrol(isimle_arac_reddi(calls)))
                    .await;
            }
            continue;
        }
        if v.get("toolCall").is_some()
            || v["serverContent"].get("modelTurn").is_some()
            || v["serverContent"].get("outputTranscription").is_some()
        {
            ifade_koruma
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .cevap_basladi();
            yanit_izni.lock().unwrap_or_else(|e| e.into_inner()).basla();
        }
        if let Some(calls) = v["toolCall"]["functionCalls"].as_array() {
            let cagri_ani = std::time::Instant::now();
            if arac_teslim
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .server_resumed(cagri_ani)
                > 0
            {
                sessizlik
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .mesaj(cagri_ani);
            }
            tur_ozeti
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .tool(calls.len(), cagri_ani);
            bildirim.model_etkinligi(cagri_ani);
            let tur_no = gecikme
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .arac(calls.len(), cagri_ani);
            for call in calls.clone() {
                sessizlik
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .arac_basladi(call["id"].as_str().unwrap_or_default(), cagri_ani);
                let bridge = bridge.clone();
                let out = out_tx.clone();
                let teslim = arac_teslim.clone();
                // `ekrani_net_gor`: kareler FunctionResponse.parts icinde,
                // aciklamayla birlikte TEK toolResponse olarak gonderilir.
                //
                // Ad SABIT DEGIL, enum'dan geliyor: bu ozel yol ile bildirim
                // arasindaki bag tek kaynaktan (`Arac::EkraniNetGor.ad()`)
                // okunur; bildirimdeki ad degisirse bu dal sessizce olu kalmaz.
                if call["name"].as_str() == Some(Arac::EkraniNetGor.ad()) {
                    eprintln!("[live] arac cagrisi: ekrani_net_gor {}", call["args"]);
                    turda_arac += 1;
                    son_arac = std::time::Instant::now();
                    // EKRAN TAHMINI OLCUMU: net kare BU turda istendi.
                    // Periyodik akis karesi bunu set ETMEZ (bkz. `ekran_iddiasi`).
                    turda_net_kare = true;
                    son_net_kare = son_arac;
                    let id = call["id"].as_str().unwrap_or_default().to_string();
                    // Modelin istedigi ekran. Yoksa "odak" -> kullanicinin
                    // baktigi ekran (bkz. selection_from_model).
                    let istenen = call["args"]["ekran"].as_str().unwrap_or("").to_string();
                    let sel = crate::audio::screen::selection_from_model(&istenen);
                    // Bu yol arac koprusunu ATLIYOR (kareler yerelde yakalanir),
                    // olaylari burada elle yayinlamak zorundayiz;
                    // aksi halde tek gorunmez arac bu olurdu.
                    let ev = events.clone();
                    let _ = ev.send(LiveEvent::Tool {
                        ad: Arac::EkraniNetGor.ad().into(),
                        durum: TOOL_BASLADI,
                        sebep: None,
                    });
                    tokio::spawn(async move {
                        // COK MONITOR: net kare de SECIME uymak ZORUNDA. Akis
                        // aktif ekrani gosterirken bu yol yalniz birincili
                        // okusa, kullanici sol ekranda "sunu oku" dediginde
                        // YANLIS ekran gelirdi.
                        let shot = tokio::task::spawn_blocking(move || {
                            crate::audio::screen::capture_sharp_selection(&sel)
                        })
                        .await;
                        let sonuc = match shot {
                            Ok(sonuc) => sonuc,
                            Err(e) => Err(e.to_string()),
                        };
                        let resp = net_kare_cercevesi(&id, sonuc);
                        let frame = GidenCerceve::Arac {
                            metin: resp,
                            id: id.clone(),
                            tur: tur_no,
                            bas: cagri_ani,
                        };
                        teslim
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .dispatch_done(&id, std::time::Instant::now());
                        if let Err(e) = out.send(frame).await {
                            eprintln!(
                                "[tool-delivery] id={id} stage=dispatch_to_queue_failed error={e}"
                            );
                        }
                        let _ = ev.send(LiveEvent::Tool {
                            ad: Arac::EkraniNetGor.ad().into(),
                            durum: TOOL_BITTI,
                            sebep: None,
                        });
                    });
                    continue;
                }
                // SAYAC SPAWN'IN DISINDA ARTAR. Icine koymak derleyici uyarisi
                // uretti ("value captured ... never read") ve haklıydi: `usize`
                // Copy oldugu icin `async move` bir KOPYA tasiyor, dis degisken
                // hic degismezdi. Sonuc sinsi olurdu: sayac daima 0 kalir, her
                // iddia yanlis isaretlenir ve tespit tamamen gurultuye donerdi.
                turda_arac += 1;
                son_arac = std::time::Instant::now();
                let iptal = Arc::new(AtomicBool::new(false));
                let cagri_id = call["id"].as_str().unwrap_or_default().to_string();
                if let Some(eski) = arac_isleri.insert(cagri_id, iptal.clone()) {
                    eski.store(true, Ordering::Relaxed);
                }
                let son_yanit = son_arac_yaniti.clone();
                let yanit_izni_arac = yanit_izni.clone();
                tokio::spawn(async move {
                    let name = call["name"].as_str().unwrap_or_default().to_string();
                    let id = call["id"].as_str().unwrap_or_default().to_string();
                    let args = call["args"].clone();
                    eprintln!("[live] arac cagrisi: {name} {args}");
                    let iptal_is = iptal.clone();
                    let cagri_id = id.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        if iptal_is.load(Ordering::Relaxed) {
                            return serde_json::json!({ "hata": "arac cagrisi iptal edildi" });
                        }
                        bridge.call_id(&cagri_id, &name, &args)
                    })
                    .await
                    .unwrap_or_else(|e| serde_json::json!({ "hata": e.to_string() }));
                    // Baslamis bloklayici is geri alinamaz; iptal edilmis
                    // cagriya gec yanit gonderilmez. Terminal isi ayri iptal araci tasir.
                    if iptal.swap(true, Ordering::Relaxed) {
                        return;
                    }
                    if call["name"] == "dinleme_modu" {
                        yanit_izni_arac
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .gecis_onayi(result["degisen_surum"].as_u64(), dinleme_surumu());
                    }
                    *son_yanit.lock().unwrap_or_else(|e| e.into_inner()) =
                        Some(std::time::Instant::now());
                    let frame = serde_json::json!({
                        "toolResponse": { "functionResponses": [arac_yaniti(
                            &id, call["name"].as_str().unwrap_or_default(), result
                        )] }
                    })
                    .to_string();
                    teslim
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .dispatch_done(&id, std::time::Instant::now());
                    if let Err(e) = out
                        .send(GidenCerceve::Arac {
                            metin: frame,
                            id: id.clone(),
                            tur: tur_no,
                            bas: cagri_ani,
                        })
                        .await
                    {
                        eprintln!(
                            "[tool-delivery] id={id} stage=dispatch_to_queue_failed error={e}"
                        );
                    }
                });
            }
            continue;
        }

        let sc = &v["serverContent"];
        if sc.is_null() {
            continue;
        }

        if sc.get("modelTurn").is_some() || sc.get("outputTranscription").is_some() {
            let simdi = std::time::Instant::now();
            arac_teslim
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .server_resumed(simdi);
            tur_ozeti
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .server_content(simdi);
            sessizlik
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .mesaj(simdi);
            bildirim.model_etkinligi(simdi);
            sessizlik
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .model_basladi(simdi);
            gecikme
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .basla(simdi);
        }
        // KONUSMA LOGU: transkriptler yalniz UI'a gidiyordu; log'da sadece arac
        // cagrilari vardi. "Transcripti oku" dendiginde konusmanin KENDISI
        // gorulemiyordu ve teshis korlemeydi (or. "ekrandaki yaziyi okuyabildi
        // mi?" sorusu cevaplanamiyordu). Parcalar akarken satir satir basmak
        // gurultulu olur; ayni rolun parcalari birlestirilip rol degisince
        // tek satir olarak yazilir.
        if let Some(t) = sc["inputTranscription"]["text"].as_str() {
            if !t.is_empty() {
                let simdi = std::time::Instant::now();
                tur_ozeti
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .transcript(t, simdi);
                bildirim.kullanici_etkinligi(simdi);
                tampon.ekle(false, t);
                let _ = events.send(LiveEvent::UserText(t.to_string()));
            }
        }
        if let Some(t) = sc["outputTranscription"]["text"].as_str() {
            if !t.is_empty() {
                // Modelden gercek cikti geldi: oturum yasadi (handle politikasi
                // bunu saglik izi sayar).
                iz.icerik_geldi = true;
                tampon.ekle(true, t);
                // Salt noktalama UI'daki parca loguna da dusmesin.
                if !sessiz_yanit(t) {
                    let _ = events.send(LiveEvent::AssistantText(t.to_string()));
                }
            }
        }
        // Tur bitti: biriken satiri yaz.
        if tur_bitti(sc) {
            if sc["interrupted"].as_bool() == Some(true) {
                let _ = events.send(LiveEvent::Interrupted);
            }
            // UYDURMA SUPHESI: Smith arac kullandigini IDDIA etti ama bu turda
            // hicbir arac cagrilmadi ve son gercek cagri da uzak. Kodla
            // engellenemez (model davranisi) ama OLCULUR : yonergeyi tahminle
            // degil dagilimla sertlestirmek icin.
            if !tampon.output.is_empty() && turda_arac == 0 {
                if let Some(kalip) = iddia_izi(&tampon.output) {
                    // Onceki turda gercekten cagirmis olabilir; o yanlis pozitif
                    // olur. 30 sn'den yeni bir cagri varsa isaretlemiyoruz.
                    let yakin_yanit = son_arac_yaniti
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .is_some_and(|t| t.elapsed() <= std::time::Duration::from_secs(30));
                    if son_arac.elapsed() > std::time::Duration::from_secs(30) && !yakin_yanit {
                        super::telemetry::log_transcript(
                            &format!(
                                "live UYDURMA SUPHESI: model '{kalip}' dedi ama bu turda arac cagrilmadi"
                            ),
                            &tampon.output,
                        );
                        iddia_kaydet(kalip, &tampon.output);
                    }
                }
            }
            // EKRAN TAHMINI SUPHESI: Smith ekran icerigi hakkinda olgusal
            // iddia kurdu ama bu turda NET kare istemedi. Ayni gerekce:
            // kodla engellenemez, olculur (bkz. `ekran_iddiasi`).
            //
            // Onceki turda net kare almis olabilir : o zaman iddia mesrudur ve
            // isaretlemek yanlis pozitif olurdu; `iddia_izi` ile ayni 30 sn
            // tazelik penceresi kullanilir.
            if !tampon.output.is_empty()
                && !turda_net_kare
                && son_net_kare.elapsed() > std::time::Duration::from_secs(30)
            {
                if let Some((kalip, capa)) = ekran_iddiasi(&tampon.output) {
                    super::telemetry::log_transcript(
                        &format!(
                            "live EKRAN TAHMINI: model '{kalip}' dedi ({capa}) ama net kare istemedi"
                        ),
                        &tampon.output,
                    );
                    ekran_tahmin_kaydet(kalip, capa, &tampon.output);
                }
            }
            turda_arac = 0;
            turda_net_kare = false;
            tur_kayitlari.ekle(
                speaker.kayit_siniri(),
                std::mem::take(&mut tampon),
                kayit_tx,
            );
            tur_kayitlari.ilerle(&speaker, kayit_tx);
        }
        if let Some(parts) = sc["modelTurn"]["parts"].as_array() {
            for p in parts {
                let Some(b64) = p["inlineData"]["data"].as_str() else {
                    continue;
                };
                let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) else {
                    continue;
                };
                let samples: Vec<f32> = bytes
                    .chunks_exact(2)
                    .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
                    .collect();
                if !samples.is_empty() {
                    let cihaz_isareti = tur_ozeti
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .audio(std::time::Instant::now());
                    gecikme
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .ilk_ses(std::time::Instant::now());
                    iz.icerik_geldi = true;
                    let tavan = crate::audio::MAX_QUEUED_SECONDS * OUT_RATE as usize;
                    match SesParcasi::ayir_isaretli(samples, &ses_butcesi, tavan, cihaz_isareti) {
                        Some(parca) => {
                            let _ = events.send(LiveEvent::Audio(parca));
                        }
                        None => ses_kayip.bildir("cikis sesi"),
                    }
                }
            }
        }
        if tur_bitti(sc) {
            bildirim.tur_bitti(std::time::Instant::now());
            speaker.arac_turu_bitti();
            sessizlik.lock().unwrap_or_else(|e| e.into_inner()).bitir();
            yanit_izni.lock().unwrap_or_else(|e| e.into_inner()).bitir();
            ifade_koruma
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .tur_bitti();
            if let Some(log) = tur_ozeti
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .turn_complete(std::time::Instant::now())
            {
                eprintln!("{log}");
            }
        }
        // Son ses parcasi ve turnComplete AYNI mesajda olabilir; once sesi olc.
        if tur_bitti(sc) {
            if let Some(log) = gecikme.lock().unwrap_or_else(|e| e.into_inner()).bitir() {
                eprintln!("{log}");
            }
        }
    }

    // Oturum kapanirken biriken son satiri da yaz. Sunucu ~10 dakikada bir
    // kapatiyor; `turnComplete` gelmeden kesilen bir replik aksi halde HER
    // oturum sinirinda sessizce kaybolurdu. Yazici uygulama omru boyunca
    // yasadigi icin bu replik sonraki oturumunkilerden once teslim edilir.
    tur_kayitlari.ekle(speaker.kayit_siniri(), tampon, kayit_tx);
    tur_kayitlari.ilerle(&speaker, kayit_tx);
    if !tur_kayitlari.bekleyen.is_empty() {
        eprintln!(
            "[konusma] ses izi karari beklenen {} tur oturum sonunda yazilamadi",
            tur_kayitlari.bekleyen.len()
        );
    }
    if let Some(log) = gecikme.lock().unwrap_or_else(|e| e.into_inner()).bitir() {
        eprintln!("{log}");
    }
    ifade_koruma
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .koptu(mik_konusuyor.load(Ordering::Relaxed));
    if let Some(log) = tur_ozeti
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .kapat("connection_closed")
    {
        eprintln!("{log}");
    }

    // YALNIZ oturum-yerel bayrak set edilir; `stop` global durdurmaya ait.
    oturum_bitti.store(true, Ordering::Relaxed);
    sender.abort();
    let _ = events.send(LiveEvent::Connected(false));

    // Bitis nedeni ayrilmadiysa: ya kullanici durdurdu ya da akis Close frame'i
    // gelmeden bitti (kablo cekildi, sunucu sessizce dustu).
    let kapanis = kapanis.unwrap_or_else(|| {
        if stop.load(Ordering::Relaxed) || KAPANIYOR.load(Ordering::Relaxed) {
            Kapanis::durduruldu()
        } else {
            eprintln!("[live] akis Close frame'i olmadan bitti");
            Kapanis::sunucudan(None, "akis kapanis cercevesi olmadan bitti", iz.go_away)
        }
    });
    // Saglik izi: handle politikasi ve geri cekilme sayaci bunlara bakar.
    for iptal in arac_isleri.values() {
        iptal.store(true, Ordering::Relaxed);
    }
    iz.yasam_sn = setup_ani.elapsed().as_secs();
    iz.hata_kapanisi = kapanis.sinif != KapanisSinifi::Planli;
    Ok(kapanis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suphe_loglari_transcript_kapisini_atlamaz() {
        let kaynak = include_str!("session.rs");
        let tur_bitisi = kaynak
            .split("// Tur bitti: biriken satiri yaz.")
            .nth(1)
            .expect("tur bitisi")
            .split("turda_arac = 0")
            .next()
            .expect("suphe blogu");
        assert_eq!(tur_bitisi.matches("telemetry::log_transcript").count(), 2);
        assert!(!tur_bitisi.contains("chars().take(120)"));
    }

    #[test]
    fn saha_yenileme_hud_bildirimi_hata_uretmez_acik_arac_birakmaz() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        yenileme_bildir(&tx);
        for beklenen in [TOOL_BASLADI, TOOL_BITTI] {
            let LiveEvent::Tool { ad, durum, sebep } = rx.try_recv().unwrap() else {
                panic!("HUD olayi");
            };
            assert_eq!(ad, "baglanti tazelendi");
            assert_eq!(durum, beklenen);
            assert!(sebep.is_none());
        }
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn saha_kesinti_gecikme_turunu_kapatir() {
        assert!(tur_bitti(&serde_json::json!({"interrupted": true})));
        assert!(tur_bitti(&serde_json::json!({"turnComplete": true})));
        assert!(!tur_bitti(&serde_json::json!({"modelTurn": {}})));
    }

    #[tokio::test]
    async fn saha_buyuk_yazim_beklerken_ses_kalir_olcum_flush_sonrasidir() {
        let pcm = MikTamponu::default();
        let (serbest, bekle) = tokio::sync::oneshot::channel::<()>();
        let basladi = Arc::new(tokio::sync::Notify::new());
        let basladi_is = basladi.clone();
        let sink = futures_util::sink::unfold(Some(bekle), move |bekle, _: Message| {
            let basladi = basladi_is.clone();
            async move {
                basladi.notify_one();
                bekle.unwrap().await.unwrap();
                Ok::<_, String>(None)
            }
        });
        let t = std::time::Instant::now();
        let mut olcer = GecikmeOlcer::default();
        olcer.konusma_sonu(t);
        let tur = olcer.arac(1, t);
        let gecikme = Arc::new(std::sync::Mutex::new(olcer));
        let sessizlik = Arc::new(std::sync::Mutex::new(SunucuSessizligi::default()));
        let teslim = Arc::new(std::sync::Mutex::new(AracTeslimIzi::default()));
        sessizlik.lock().unwrap().arac_basladi("a", t);
        let g = gecikme.clone();
        let s = sessizlik.clone();
        let d = teslim.clone();
        let is = tokio::spawn(async move {
            kontrol_gonder(
                &mut Box::pin(sink),
                GidenCerceve::Arac {
                    metin: "x".repeat(800 * 1024),
                    id: "a".into(),
                    tur,
                    bas: t,
                },
                &g,
                &s,
                &d,
            )
            .await
            .unwrap();
        });
        basladi.notified().await;
        // Saat beklemeden iki saniyelik callback uretimini canlandir.
        for n in 0..200 {
            pcm.ekle(MikKaresi {
                samples: vec![n as f32; 480].into(),
                rate: 48_000,
                kapali: false,
                at: t + std::time::Duration::from_millis(n * 10),
                listen_epoch: 0,
            });
        }
        assert!(
            !sessizlik
                .lock()
                .unwrap()
                .yenile(t + std::time::Duration::from_secs(60)),
            "yazim bitmedi"
        );
        serbest.send(()).unwrap();
        is.await.unwrap();
        for n in 0..200 {
            assert_eq!(pcm.recv().await.samples[0], n as f32);
        }
        let mut g = gecikme.lock().unwrap();
        g.ilk_ses(std::time::Instant::now());
        let log = g.bitir().unwrap();
        assert!(log.contains("gonderim_kb: 800"), "{log}");
        assert!(!log.contains("arac_sonrasi_ms: yok"));
        assert!(sessizlik
            .lock()
            .unwrap()
            .yenile(std::time::Instant::now() + std::time::Duration::from_secs(30)));
    }

    #[tokio::test]
    async fn saha_basarisiz_yazim_gonderildi_sayilmaz() {
        let sink = futures_util::sink::unfold((), |(), _: Message| async { Err::<(), _>("ag") });
        let t = std::time::Instant::now();
        let mut g = GecikmeOlcer::default();
        let tur = g.arac(1, t);
        let g = std::sync::Mutex::new(g);
        let s = std::sync::Mutex::new(SunucuSessizligi::default());
        let d = std::sync::Mutex::new(AracTeslimIzi::default());
        s.lock().unwrap().arac_basladi("a", t);
        let sonuc = kontrol_gonder(
            &mut Box::pin(sink),
            GidenCerceve::Arac {
                metin: "yanit".into(),
                id: "a".into(),
                tur,
                bas: t,
            },
            &g,
            &s,
            &d,
        )
        .await;
        assert_eq!(sonuc, Err("ag"));
        let mut g = g.lock().unwrap();
        g.ilk_ses(t);
        assert!(g
            .bitir()
            .unwrap()
            .contains("gonderim_kb: 0, arac_sonrasi_ms: yok"));
        assert!(!s
            .lock()
            .unwrap()
            .yenile(t + std::time::Duration::from_secs(60)));
    }

    #[tokio::test]
    async fn saha_gonderici_sese_oncelik_verir_kontrolu_ac_birakmaz() {
        let pcm = MikTamponu::default();
        let (tx, mut rx) = mpsc::channel(8);
        tx.send(GidenCerceve::Kontrol("x".repeat(800 * 1024)))
            .await
            .unwrap();
        // Iki saniye blokaj: 200 adet 10 ms kare gondericiyi bekliyor.
        for n in 0..200 {
            pcm.ekle(MikKaresi {
                samples: vec![n as f32; 480].into(),
                rate: 48_000,
                kapali: false,
                at: std::time::Instant::now(),
                listen_epoch: 0,
            });
        }
        let mut seri = 0;
        let mut ses = 0;
        let mut kontrol = 0;
        for _ in 0..201 {
            match siradaki(&pcm, &mut rx, &mut seri).await {
                Gonderim::Ses(kare) => {
                    assert_eq!(kare.samples[0], ses as f32);
                    ses += 1;
                }
                Gonderim::Kontrol(frame) => {
                    assert_eq!(ses, 8);
                    assert_eq!(frame.metin(0).unwrap().len(), 800 * 1024);
                    kontrol += 1;
                }
            }
        }
        assert_eq!((ses, kontrol), (200, 1));
    }
}
