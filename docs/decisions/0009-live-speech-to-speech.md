# ADR 0009 — Live speech-to-speech mimarisine geçiş

> **Numara değişti (2026-08-14): 0007 → 0009.** Bu ADR ilk olarak `0007` diye
> yazıldı; aynı gün paralel bir çalışma kolu `0007-mission-control.md`'yi
> commit'ledi (`e3f8844`) ve kodda 8 yerden `ADR 0007` diye atıf aldı. Çakışmayı
> bu dosya devraldı çünkü henüz commit edilmemişti ve hiç gelen atfı yoktu.
> İçerik değişmedi. Aynı gün içinde ikinci numara çakışması olduğu için
> `scripts/check-adr-numbers.sh` kapısı kuruldu.

**Tarih:** 2026-08-14
**Durum:** Kabul edildi ve canlı — birincil ses yolu Gemini Live, tek WebSocket.
[ADR 0001](0001-audio-perception.md)'in basamaklı hattının **üstünü alır**
(kısmen: yerel hat kararları tarihsel kayıt olarak geçerli).

## Bağlam

ADR 0001 sesi yerel bir **basamaklı hat** olarak kurdu: mikrofon → VAD → STT →
LLM → TTS → playback. Hat uçtan uca çalıştı ve her bacağı ayrı ayrı
iyileştirildi. Ama kullanıcının tekrarlayan tek şikâyeti değişmedi: _"çok geç
geliyor."_

Bileşen düzeyinde iyileştirme denendi ve **işe yaradı** — sorunu çözmedi:

| Bacak                       | Ölçüm                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------- |
| whisper.cpp (CPU)           | ifade başına **~16 sn** sabit, RTF 8–19 (`audio/stt.rs`, AVX2+OpenMP açıkken bile) |
| faster-whisper CUDA sidecar | ifade başına **~0,2–0,5 sn** (RTX 5060, int8_float16)                              |
| Basamaklı hat **toplamı**   | ilk-ses **~3,4 sn**, söz kesme (barge-in) **yok**                                  |

STT tek başına ~30 kat hızlandığı halde hat toplamı kabul edilemez kaldı.
Sebep aritmetik: her bacak kendi tamponunu, kendi kararını ve kendi gecikmesini
ekliyor (VAD hangover + STT + gateway turu + LLM + cümle tamponu + TTS +
playback kuyruğu). **Kusur bileşende değil mimaridedir** — bu ADR'nin varlık
sebebi budur.

## Karar

Sesi tek akışta veren bir sağlayıcıya geçildi: **Gemini Live, tek WebSocket,
speech-to-speech.** Ses girer, ses çıkar; aradaki STT/LLM/TTS bacakları
sağlayıcının içinde kalır.

| Karar            | Değer                                                          | Gerekçe                                                                                                       |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Model            | `gemini-3.1-flash-live-preview`                                | Ölçülen ilk-ses **613 ms**                                                                                    |
| Reddedilen model | `native-audio` sınıfı                                          | Daha yavaş **ve** persona yönergesini kabul etmiyordu ("Google tarafından eğitildim" ısrarı) — ADR 0005 çöker |
| Ses sözleşmesi   | giriş 16 kHz, çıkış 24 kHz, s16le mono                         | Sağlayıcı sözleşmesi; cihaz frekansı `LinearResampler` ile 16k'ya indirilir                                   |
| Konuşma tespiti  | **sunucu tarafı** `automaticActivityDetection`                 | Kesinti (barge-in) sunucuda; istemcide tur yönetimi kalmaz                                                    |
| VAD duyarlılığı  | `START`/`END_SENSITIVITY_LOW`, prefix 300 ms, sessizlik 900 ms | Fan/kısık müzik "kullanıcı konuşmaya başladı" sanılıp Smith'in sözünü kesiyordu                               |
| Ses              | `Kore`, `languageCode: tr-TR`                                  | Türkçe                                                                                                        |

**Cihaz sahipliği uygulamada kalır.** Mikrofon ve hoparlör masaüstünde (cpal);
eski Python spike'ı yalnız doğrulama içindi, üretim yolu değildir ve git
geçmişinde korunur.

**Araçlar ve hafıza function-calling köprüsüyle bağlandı.** Live modunda sohbet
turu gateway'de koşmadığı için hafıza kendiliğinden devreye girmiyordu
(kullanıcı: "hafızası yok"). `ToolBridge` Live'ın çağırdığı fonksiyonu HTTP'ye
çevirir; token'ı **kendisi** alır (`/v1/dev/login`) çünkü Live oturumu
frontend'den bağımsız çalışır ve UI'ın token'ına güvenemez. Gateway kapalıysa
araç çağrısı hata metniyle döner — model bunu söyler, **oturum çökmez**. Böylece
hafıza ve tenancy tek yerde (gateway) kalır ve `@smith/protocol` değişmez.
Terminal/donanım araçları ise cihazda kalır (`system_tools.rs`): ikisi aynı
köprüden geçer, yürütme yeri farklıdır.

## Bedeller — süslenmeden

### 1. Ses artık Google'a gidiyor (ADR 0001 ilkesinden geri adım)

ADR 0001'in kilitli kararı şuydu: "mümkün olduğunca yerel", gateway Ollama ile
yerelde koşar, desktop'ta tam-yerel bypass yok. Bugünkü gerçek: **ham mikrofon
sesi ve konuşmanın bağlamı Google'a akıyor.** Bu bir ihlaldir; kaydı burada
duruyor ki sessizce norm hâline gelmesin.

Telafi ilkeyi geri getirmez, yüzeyi daraltır:

- **Hassasiyet filtresi:** `secret` sınıfı hafıza Live'a ASLA enjekte edilmez
  ([ADR 0004](0004-personal-context-ingestion.md) §3).
- **~~Embedding yerelde~~ → GÜNCELLENDİ** ([ADR 0011](0011-embedding-provider.md),
  2026-08-13): embedding artık bulut Gemini'de; hafıza METNİ embed edilirken
  Google'a gider. Bu telafi ARTIK geçerli değil — kalan memory-gizlilik koruması
  `secret` filtresidir (üstteki madde).
- **Ekran varsayılan kapalı:** `SMITH_SCREEN=1` olmadan görüntü gitmez
  ([ADR 0002](0002-visual-situational-perception.md) — o ADR'de de aynı sınıf
  ihlal kayıtlı).
- **Yerel geri dönüş yolu duruyor** ama bugün sökük (aşağıya bak).

Bu bedelin gerçek karşılığı ölçülmüş bir üründür: 3,4 sn → 613 ms ve gerçek söz
kesme. Yerel bir speech-to-speech modeli çıkarsa bu karar **yeniden açılır**.

### 2. `SMITH_LIVE=0` bir "yedek yol" değil — duyar ama konuşmaz

Motor seçimi `lib.rs:375` içindedir: `SMITH_LIVE` **varsayılan AÇIK** ve yalnız
açıkça kapatan bir yazım (`0`, `false`, `off`, `no`, `hayir`, `kapali`) basamaklı
hatta düşürür; Live başlatılamazsa da aynı hatta düşülür
(gürültülü, `eprintln` uyarısıyla). **Ama basamaklı hattın renderer tarafı
kaldırıldı:** `useTts.ts`,
`useTranscription.ts`, `useSmithSession.ts` ve `Transcript.tsx` silindi.

Bugün `SMITH_LIVE=0` yapılırsa: mikrofon ve STT çalışır, transkript üretilir —
ama ne transkript arayüzü ne TTS sürücüsü vardır. **Smith duyar, konuşmaz.**
Rust tarafındaki `tts_feed`/`tts_flush`/`tts_cancel` komutlarının da çağıranı
kalmadı. Bu uyarı `scripts/dev-win.ps1` içinde yazılıdır; hattın geri gelmesi
bayrağı çevirmekle olmaz, renderer sürücüsünü yeniden yazmak gerekir.

Dürüst adı: **kısmen sökülmüş yol.** ADR 0001'in kararları o hat için hâlâ
geçerli, ama "istediğimizde geri dönebiliriz" cümlesi bugün doğru değildir.

**DÜZELTME — bayrak semantiği (2026-08-16).** Bu bölüm eskiden "`SMITH_LIVE`
tanımlı ve `0` değilse Live kurar" diyordu, yani **tanımsız = KAPALI**. Bugün
tersi: `env_flag::acik_varsayilan_acik("SMITH_LIVE")`, tanımsız = AÇIK
(commit `e1596d3`). Eski lehçe yapısal bir sessizlik üretiyordu —
`scripts/dev-win.ps1` dot-source edilmeden `tauri dev` koşan biri hiçbir belirti
görmeden konuşmayan bir Smith alıyordu; üstelik `" 0 "` (boşluklu) trim
edilmediği için Live'ı AÇIYORDU. Aynı commit dört farklı lehçeyi tek
`env_flag` modülünde birleştirdi ve gizlilik yüzeyi olan bayrakları
(`SMITH_SCREEN`, teşhis WAV'ı) bilinçli olarak `acik_varsayilan_kapali`'da
bıraktı.

### 3. Ücretsiz katman duvarları

Yerleşik `googleSearch` free-tier'da yok (her varyant WS 1011 "quota"); ölçüm ve
yerine konan kendi araçlarımız [ADR 0004](0004-personal-context-ingestion.md)
§5'te. Live'da "pro" sınıfı bir model Google'da yok, free-tier'da pro modeller de
429/1011 ile kapalı — bu yüzden zor sorular `derin_dusun` ile daha güçlü bir
metin modeline devredilir ("hızlı ağız, güçlü beyin").

## Ölçülmüş tuzaklar

Hepsi sahada görüldü; hiçbiri tahmin değil.

1. **`realtimeInput.mediaChunks` kaldırılmış.** Güncel şema tek bir
   `realtimeInput.audio` blobu bekler. Eski alanla oturum **WS 1007** ile
   kapanır. Bu tuzak protokol tarafındadır, hata mesajı yol göstermez.
2. **`setupComplete` BINARY çerçeve olarak geliyor.** Yalnız `Message::Text`
   bekleyen kod setup yanıtını hiç görmez ve UI sonsuza kadar "bağlanıyor"da
   kalır. Okuyucu her iki çerçeve tipini de metne çevirmek zorundadır.
3. **Kendi sesini duyup döngüye giriyordu.** Hoparlörden çıkan ses mikrofona
   geri kaçıyor, Gemini bunu "kullanıcı konuşuyor" sanıp kendini kesiyor ve
   yeniden başlıyordu (karışık/çok-dilli transkript, "sürekli yeniden
   başlıyor"). AEC olmadan doğru çözüm **yarım dübleks**: çıkış çalarken
   mikrofon oturuma gönderilmez, yerine **aynı uzunlukta dijital sessizlik**
   beslenir — akış sürekliliği ve konuşma-bitişi tespiti korunur, echo modele
   ulaşmaz. Yan fayda: konuşmacı doğrulama kapısı aynı akıştan beslendiği için
   Smith'in kendi sesi "yabancı konuşmacı" olarak ölçülmez. O kapı kalkarsa
   (AEC gelirse) `speaker.rs`'e playback farkındalığı eklenmelidir.
4. **Yeniden bağlanmada alıcı paylaşılmalı.** Mikrofon karelerini taşıyan
   `pcm_rx` oturum döngüsünün **dışında** tutulur. Kanal her yeniden bağlanmada
   yeniden kurulsaydı capture zinciri kopardı; `session_loop` her denemede
   yeniden çağrıldığı için alıcının ömrü döngüden uzun olmak zorundadır.
5. **"Sustur" ile süre-sınırı kapanışı karıştırılmamalı.** Kullanıcının kendi
   susturması hattı kapatır; sunucunun süre-sınırı kapanışı ise yeniden
   bağlanmayı tetiklemelidir. Aynı bayrakla yönetilirse Smith süre dolduğunda
   sessizce ölür.

## Oturum devamlılığı — devam eden iş

Sunucu oturumu **~10 dakikada** kapatır. Yeniden bağlanma otomatiktir ve
kademeli backoff'ludur, ama tek başına yetmez: yeni oturum **sıfır bağlamla**
açılır ve Smith konuşmanın tamamını aniden unutur.

Live API'nin karşılığı `sessionResumption`: sunucu checkpoint'lerde bir handle
yollar (`sessionResumptionUpdate`), sonraki `setup` o handle'ı taşırsa aynı
konuşma devralınır. `goAway.timeLeft` ile kapanış önceden haber verilir.

**Bugünkü durum:** mekanizma kodda uygulanmış görünüyor — `Devralma` niyeti
(kapalı/yeni/handle), `OturumIzi` emniyet kapısı, handle koruma politikası,
`SMITH_LIVE_RESUME=0` kaçış kapısı ve birim testleri mevcut. **Ancak canlı
~10 dakikalık sınırda uçtan uca doğrulama bu ADR yazılırken koşturulmadı** ve
dosya o sırada paralel sahiplikteydi. Bu yüzden burada **TAMAM yazılmıyor**:
devam eden iş. Kapanış koşulu, gerçek bir oturumun süre sınırını aşıp
konuşmanın devraldığının gözlenmesidir.

## DÜZELTME — echo kapısı barge-in matematiğini kullanmıyor (2026-08-16)

Aşağıdaki ilişki tablosu "barge-in matematiği (`bargein.rs`) o hattan geldi ve
**echo kapısında kullanılıyor**" diyordu. Yanlış, ve iki ayrı mekanizmayı tek
mekanizma gibi gösterdiği için tehlikeli: birine güvenip diğerini söken bir
değişiklik sessizce self-loop'u geri getirir.

- `audio/live.rs` içinde `bargein` **sıfır** isabet veriyor.
- `BargeInDetector`'ın repodaki tek çağrısı `lib.rs:732`, yani
  `spawn_transcription` — ADR'nin §2'de "kısmen sökülmüş yol" dediği basamaklı
  hat. Yani barge-in dedektörü bugün ölü yedek hattın parçası.
- Live'ın echo kapısı bambaşka ve çok daha basit bir şeydir:
  `lib.rs:440` (`spawn_live` içinde) `echo_ref.is_playing()` — yani
  `playback.rs OutputReference`'in "şu an duyulur ses çalıyor mu" sorusu. Doğru
  cevapta mikrofon karesi yerine aynı uzunlukta dijital sessizlik beslenir
  (yukarıdaki tuzak 3).
- Takas kodda açıkça yazılı: _"Barge-in bu surede feda edilir — AEC gelene kadar
  dogru takas; kullanilamaz self-loop'tan iyidir."_ Yani Smith konuşurken söz
  kesme çalışmaz; ADR'nin "gerçek söz kesme" kazancı **sunucu tarafı**
  `automaticActivityDetection`'dan gelir, `bargein.rs`'ten değil.

Sonuç: `bargein.rs` (34 KB, 21 test) korunmuş ama bağlanmamış bir yetenektir;
AEC geldiğinde (ADR 0001 Faz 6) yeniden bağlanacak doğal yer orasıdır.

## İlişkiler

| ADR                                           | İlişki                                                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [0001](0001-audio-perception.md)              | Üstünü aldığı karar. Basamaklı hat + yerel algı. **`bargein.rs` Live'da KULLANILMIYOR** — aşağıdaki düzeltme                     |
| [0002](0002-visual-situational-perception.md) | Ekran kareleri **aynı** Live WS'inden `realtimeInput.video` ile akar                                                             |
| [0004](0004-personal-context-ingestion.md)    | Hafıza + hassasiyet filtresi; `googleSearch` ölçümü ve yerine konan kendi araçlarımız                                            |
| [0005](0005-persona-and-proactivity.md)       | Persona/proaktiflik sözleşmesi Live'ın `systemInstruction`'ında yaşar — model seçimi bu yüzden persona'yı kabul etmek zorundaydı |
| [0006](0006-continuous-awareness.md)          | Tazelenen dünya modeli; Live oturumu bu hafızayı köprü üzerinden okur                                                            |

## Ne değişmez

- `@smith/protocol` ve `PROTOCOL_VERSION` **değişmedi**. Live bir cihaz-içi
  motordur; gateway sözleşmesi araç köprüsünün HTTP yüzeyinden geçer.
- Hafıza, tenancy ve observability gateway'de kalır. Cihaz tarafında hafıza
  kopyası tutulmaz.
- Yazma yetkisi ses iziyle kapılıdır (`speaker.rs`): doğrulanmamış ifade hafızaya
  yazamaz, yabancı ölçülen ifade makineyi değiştiren araçları çalıştıramaz.
- Mikrofon ve hoparlör sahipliği uygulamadadır; webview'e mikrofon açan bileşen
  yasaktır.

## Açık kalan

- Oturum devamlılığının canlı doğrulaması (yukarıda).
- AEC (ADR 0001 Faz 6): yarım dübleks echo kapısının yerini alırsa Smith
  konuşurken de dinleyebilir — bugün konuşurken duymuyor.
- Yerel speech-to-speech: çıktığı gün "ses Google'a gidiyor" bedeli yeniden
  değerlendirilir.
- Niyet kapısı Live'da bağlı değil (ADR 0001'in son bölümü): "odaklanmışken
  sessiz kal" davranışı bugün yalnız sistem yönergesiyle dayatılıyor.
