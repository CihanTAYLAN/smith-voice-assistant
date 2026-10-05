# ADR 0001 — Yerel Gerçek-Zamanlı Ses & İşitsel Algı Mimarisi

**Tarih:** 2026-08-10
**Durum:** Faz 0–2 uygulandı ve canlı doğrulandı. Ama **birincil ses mimarisi
2026-08-14'te değişti**: basamaklı hat (VAD→STT→LLM→TTS) yedek yola çekildi,
birincil yol Gemini Live speech-to-speech. Bu ADR'nin kilitlenen kararları
basamaklı hat için hâlâ geçerlidir; bugünkü gerçek için son bölümü oku.
**Üstü alındı (kısmen):** [ADR 0009](0009-live-speech-to-speech.md) — geçişin
kararı, bedelleri ve ölçülmüş tuzakları orada. Uyarı: basamaklı hattın renderer
tarafı söküldüğü için `SMITH_LIVE=0` bugün **duyar ama konuşmaz**.

## Bağlam

`apps/desktop` (Tauri 2) üzerine, mümkün olduğunca yerel çalışan gerçek-zamanlı
ses algı katmanı: mikrofon → VAD → STT → speaker → environmental sound →
unified event → LLM → TTS → playback, barge-in dahil.

**Kilit tespit:** Smith'te LLM (`@smith/llm`: Ollama + Claude, streaming),
hafıza (`@smith/memory`: pgvector), tenancy, observability ve `@smith/protocol`
zaten var. Ses algı katmanı bunların üstüne oturur; LLM/hafıza yeniden yazılmaz.
Yeni ve yerel olması gereken kısım Tauri/Rust tarafındaki ses hattıdır.

## Kilitlenen kararlar (kullanıcı seçti, 2026-08-10)

1. **LLM yolu:** Ses olayları `@smith/protocol` (WS) ile **mevcut gateway'e**
   gider. LLM/hafıza/tenancy/observability yeniden kullanılır. Gateway Ollama
   ile yerelde koşar → "local" korunur. Desktop'ta tam-yerel bypass YOK.
2. **STT motoru:** **whisper.cpp** (whisper-rs), VAD-kapılı chunking. Türkçe
   doğruluğu için; partial = mevcut segmentin ara decode'u, final = VAD bitişi.
   sherpa streaming zipformer Türkçe'de zayıf olduğu için elendi.
3. **Geliştirme hedefi:** Cross-platform (macOS M2 + Windows). cpal + onnx
   zaten cross-platform; WSL'de mikrofon çalışmaz, host'ta koşulur.
4. **Runtime:** **sherpa-rs** birleşik onnxruntime (VAD + diarization + speaker
   embedding + audio tagging + TTS). STT için whisper.cpp ayrı tutulur (Türkçe).

## Kütüphane/model seçimleri

| Katman              | Seçim                                            | Not                                 |
| ------------------- | ------------------------------------------------ | ----------------------------------- |
| Audio capture       | `cpal` + `tokio::broadcast` fan-out              | tek stream → çok tüketici           |
| VAD                 | Silero (sherpa-rs veya `silero-vad-rs`)          | always-on, ucuz                     |
| STT                 | whisper.cpp / whisper-rs                         | Türkçe; VAD-kapılı chunking         |
| Diarization/ID      | sherpa pyannote + speaker embedding              | Faz 4                               |
| Environmental sound | sherpa audio tagging (AudioSet)                  | Faz 5                               |
| TTS                 | **Piper** (tr_TR sesleri, MIT, CPU, cümle-chunk) | Kokoro'da Türkçe YOK                |
| AEC                 | `webrtc-audio-processing` (AEC3)                 | Faz 6; output-reference tap gün bir |
| Concurrency         | tokio task + channel; event bus = broadcast      | harici altyapı yok                  |

## Soyutlamalar (trait'ler)

`AudioSource`, `VoiceActivityDetector`, `SpeechToTextEngine`, `SpeakerAnalyzer`,
`SoundClassifier`, `TextToSpeechEngine`, `AudioSink`. Motor değişimi = trait
implementasyonu değişimi. `LLMProvider` zaten `@smith/llm`'de var.

## Mimari

```
[ DESKTOP — Tauri/Rust, yerel, düşük latency ]
Microphone → cpal → broadcast(AudioFrame)
   ├─ VAD (always-on)
   ├─ STT worker (VAD-kapılı)   → partial/final
   ├─ Speaker worker (VAD-kapılı) → who
   └─ Sound classifier (periyodik) → what
        ↓ Unified AudioEvent (tokio broadcast event bus)
        ↓ @smith/protocol (WS) — YENİ frame'ler (v2)
[ GATEWAY — mevcut Smith, yerelde ]
   LLM (Ollama/Claude) + memory (pgvector) + tenancy + observability
        ↓ streaming delta
[ DESKTOP ] Sentence buffer → Piper TTS → playback (cpal out)
        ↑ Barge-in: VAD-during-playback → playback+queue iptal
                   + protokol `cancel` → LLM iptal
                   + output-reference tap (AEC hazır)
```

## Protokol etkisi (v2, Faz 2+)

**İlk plan (2026-08-10):** Yeni frame'ler: `audio_event`, `transcript_partial`.
Barge-in için mevcut `cancel` client frame'i yeniden kullanılır. Faz 0-1
protokol değişikliği GEREKTİRMEZ (tamamen yerel).

**DÜZELTME (2026-08-16): bu "v2" hiç sevk edilmedi.** `audio_event` ve
`transcript_partial` frame'leri protokole eklenmedi; bugün
`packages/protocol/src/wire.ts:14` hâlâ `PROTOCOL_VERSION = 1` diyor. Aşağıdaki
Faz 2 maddesi zaten "Protokol DEGISMEDI (… PROTOCOL_VERSION 1)" diye yazıyordu —
yani bu başlık aynı belgenin içinde çelişiyordu. Yukarıdaki mimari şemadaki
"YENİ frame'ler (v2)" satırı da aynı sınıf: gerçekleşmemiş bir plandır. Sebep:
ses hattı gateway'e taşınmadan önce Live'a geçti (ADR 0009) ve cihaz-içi motor
kendi WebSocket'ini kullanıyor; araçlar HTTP'den geçtiği için protokol yüzeyi
hiç genişlemedi.

## Fazlar (ilk milestone küçük)

- **Faz 0 — Temel:** ✅ TAMAM (commit'te). cpal capture + broadcast fan-out
  - RMS seviye tüketicisi + Tauri komutları (audio_start/stop/devices) +
    `useMicLevel`. cargo check geçti (WSL'de yerel ALSA); tarayıcıda
    zarif devre-dışı doğrulandı. Native mikrofon testi host'ta (Mac/Windows).
    (DÜZELTME 2026-08-16: bu satır eskiden `useMicLevel`'in yanında bir
    `MicMeter` bileşeni de anıyordu; öyle bir dosya repoda YOK ve hiçbir yerden
    referans almıyor. Bugün kanca `apps/desktop/src/useMicLevel.ts` ve tek
    tüketicisi `App.tsx:98`.)
- **Faz 1 — Hedef milestone:** ✅ TAMAM. Silero VAD (voice_activity_detector,
  gömülü onnx model) + streaming lineer resampler (48k→16k) + hangover'lı
  konuşma segmenter + whisper.cpp STT (whisper-rs, ggml-base, dil=tr, ilk
  kullanımda indirilir). Pipeline: broadcast → forwarder(tokio) → VAD thread →
  STT thread → `audio://transcript` (partial/final) + `audio://vad`. UI:
  `useTranscription` + `Transcript` (partial italik, final satır, model indirme
  akışı). WSL toolchain kuruldu (micromamba: gcc/g++/cmake/clang/openssl,
  sudo'suz) → cargo check geçti. Native mic testi host'ta.
- **Faz 2:** ✅ TAMAM. transcript (final) → device dispatch seam
  (`dispatchUtterance`, renderer'da tek yol; ileride niyet/onem kapisi burada
  slot'lanir, protokol degismez) → gateway `prompt` frame'i → LLM streaming
  `delta` → cumle-chunk tampon (`SentenceBuffer`, Rust) → yerel TTS
  (`TextToSpeechEngine` trait) → cpal output playback (kuyruk + `clear()` =
  Faz 3 barge-in/tur-sinir dikisi). Renderer: `useTts` (delta→feed, done→flush,
  yeni tur→cancel) + `useSmithSession` onDelta/onResponseEnd kancalari;
  transcription state App'e tasindi, `Transcript` salt sunum. Protokol
  DEGISMEDI (mevcut `prompt`/`delta`/`done`; PROTOCOL_VERSION 1).
  **İlk durum (2026-08-10) — TTS motoru PLACEHOLDER'DI** (`PlaceholderTts`:
  metin uzunluguyla orantili ton, gercek konusma DEGIL). Sebep: ADR runtime
  karari sherpa-rs, ama sherpa-onnx (C++) + onnxruntime derlemesi WSL'nin
  sudo'suz micromamba toolchain'inde yuksek riskli. Trait + cumle tampon +
  playback hatti uctan uca derlendi/dogrulandi; gercek Piper/sherpa-rs
  `TextToSpeechEngine`'in ikinci implementasyonu olarak host'ta (Mac/Windows)
  slot'lanacak — model ilk kullanimda indirilir, repoya binary girmez.
  cargo check (WSL) + `pnpm verify` gecti.
  **DÜZELTME (2026-08-16): placeholder artık BİRİNCİL motor değil, YEDEK.**
  `lib.rs:147 select_tts_engine()` önce `PiperHttpTts::from_env()` deniyor;
  `from_env()` ortam değişkeni tanımsız olsa bile `contract::DEFAULT_BASE_URL`
  ile Piper HTTP sunucusuna bağlanmayı dener ve yalnız değer açıkça
  "kapalı" yazımlarından biriyse `None` döner. Yani sıra şu: Piper bağlanırsa
  gerçek konuşma (`[tts] motor: piper HTTP @ …`), bağlanamazsa veya
  `SMITH_TTS_SERVER` ile kapatılmışsa `PlaceholderTts` tonu. Sunucu
  `scripts/tts-piper-server.ps1` ile kaldırılır. **Bu satırın pratik önemi
  bugün sınırlı:** basamaklı hat yedek yola çekildiği ve renderer sürücüsü
  söküldüğü için TTS hattının çağıranı kalmadı (ADR 0009 §2).
- **Faz 3 — YAZILDI, ama Live yolunda BAĞLI DEĞİL** (durum düzeltmesi
  2026-08-16; eskiden burada hiçbir işaret yoktu, yani "yapılmadı" okunuyordu).
  `audio/bargein.rs` var (34 KB, 21 birim testi) ve output-reference tap
  `audio/playback.rs OutputReference` olarak duruyor. Ama `BargeInDetector`'ın
  tek çağrısı `lib.rs:732`, yani `spawn_transcription` — sökülmüş basamaklı hat.
  Live yolunda söz kesme **sunucu tarafındadır**
  (`automaticActivityDetection`); `OutputReference` ise Live'da barge-in için
  değil **yarım-dübleks echo kapısı** olarak kullanılıyor
  (`lib.rs:440`, `spawn_live` içinde `echo_ref.is_playing()`), ve oradaki yorum
  takası açıkça yazıyor: "Barge-in bu surede feda edilir". Ayrıntı ADR 0009.
- **Faz 4 — kimlik YAPILDI, diarization YAPILMADI** (durum düzeltmesi
  2026-08-16). Konuşmacı **tanıma/doğrulama** canlı ve birincil Live yolunda
  kapı görevi görüyor: `audio/speaker.rs SpeakerGate` (17 test) +
  `sidecar/speaker_server.py` sidecar'ı; `live.rs:1396` kapıyı
  `SpeakerGate::from_env()` ile kuruyor ve `OWNER_ONLY_TOOLS` /
  `NO_FOREIGN_TOOLS` listeleri araç yürütmesini kapılıyor (bkz. bu belgenin son
  bölümü ve ADR 0009 "Ne değişmez"). **Diarization ("kim ne zaman konuştu"
  segmentasyonu) gerçekten YOK** ve bu ADR'de tek satırda kimlikle
  birleştirilmiş olması iki farklı işi tek durum etiketi altında saklıyordu.
- **Faz 5:** environmental sound + unified event + context/memory entegrasyonu.
- **Faz 6:** AEC + resource management (model load/unload) + privacy/debug flag.

## Yerleşim

Yeni Rust modülü `apps/desktop/src-tauri/src/audio/` (büyürse workspace
crate'ine terfi). İnce `lib.rs` korunur. Modeller: ilk çalıştırmada indir +
checksum, app-data dizininde cache (repo'ya binary girmez).

## Kaynak dağıtımı ve gizlilik

- Modeller repoya konmaz; ilk açılışta indirilir, checksum'la doğrulanır.
- Raw audio diske yazılmaz; debug kaydı yalnız açık bir development flag'iyle.

## STT Türkçe doğruluğu — üç düzeltme (2026-08-12)

**Belirti:** Kullanıcı "ses deneme" gibi açık ve net cümleler söylüyor, transcript
yanlış çıkıyor.

**Üç ayrı neden bulundu ve üçü birden düzeltildi:**

1. **Model küçüktü.** `ggml-base` Türkçe'de zayıf. Varsayılan **`small`** yapıldı;
   `SMITH_WHISPER_MODEL` ile `tiny|base|small|medium|large-v3-turbo` seçilebilir
   (tanınmayan değer sessizce varsayılana düşer). Model dosyası ve indirme URL'si
   artık seçili adı takip eder.
2. **Sinyal çok zayıftı.** WSLg/RDP üzerinden gelen mikrofon sinyali ölçüldü:
   **RMS ≈ 0.004, tepe ≈ 0.027** (~-31 dB). Whisper bu seviyede kelimeleri
   karıştırır. `normalize_gain()` eklendi: hedef RMS 0.08, kazanç en fazla 20×
   (sessiz tamponlarda gürültü büyütmemek için) ve tepe 0.98'i aşmayacak şekilde
   kırpılır. Sinyal zaten yeterliyse dokunulmaz. 5 birim testi.
3. **Decode parametreleri kısa komuta uygun değildi.** Greedy → **beam search**
   (beam 5), `no_context(true)` (VAD cümleyi zaten ayırıyor; önceki metni bağlam
   vermek kısa komutlarda tekrar/halüsinasyon üretiyordu), `single_segment`,
   `suppress_blank`, `suppress_nst`, `temperature 0`, thread sayısı makineye göre
   (çekirdeğin yarısı, 2–8 arası — ses hattının geri kalanı aç kalmasın).

   **DÜZELTME (2026-08-16): beam search GERİ ALINDI.** Bugün
   `audio/stt.rs:319` tek geçişli greedy kullanıyor:
   `FullParams::new(SamplingStrategy::Greedy { best_of: 1 })`. Geri alma
   gerekçesi aynı dosyanın hemen üstündeki yorumda yazıyor: beam 5 her segmenti
   ~5× pahalı decode ediyor ve `large-v3-turbo` CPU'da zaten ağır — "çok geç
   düşüyor" şikâyetinin ana kaynağı buydu; turbo modeli greedy'de de yüksek
   isabetli. Bu maddenin diğer parametreleri (`no_context`, `single_segment`,
   `suppress_blank`, `suppress_nst`, `temperature 0`, thread sayısı) geçerli.

**Ayrıca:** `initial_prompt` ile **"Smith"** özel adı modele tanıtıldı.

**DÜZELTME (2026-08-16): "kapı hiç açılmaz" ifadesi yanlıştı.** Bu paragraf
eskiden wake-word kapısının `\bsmith\b` ile eşleştiğini ve model adı
"simit/ismiş" diye çözerse kapının hiç açılmayacağını söylüyordu. Kapı bugün
tam olarak o varyantları **kasten kabul ediyor**
(`apps/desktop/src/dispatchUtterance.ts:30`):

```ts
export const DEFAULT_WAKE_WORD =
  /\b(smith|smitth?|smit|zmit|simit|simith|ismit|ismith|ismis|ismish)\b/iu;
```

Ayrıca metin eşleştirmeden önce `normalizeForWake` ile küçük harfe indirilip
birleşik aksan işaretleri atılıyor, yani "İsmit"/"sîmît" de eşleşiyor. Yani
tasarım "STT ile güreşmek" değil, gerçekleşmeleri kabul etmektir; `initial_prompt`
hâlâ faydalıdır ama kapının doğruluğu ona bağlı değildir.

**Tanı araçları (kalıcı):** `cargo run --example list_input` (cpal hangi giriş
cihazlarını görüyor) ve `--example mic_probe` (5 sn yakalar, saniyelik RMS/tepe
basar). Ses "çalışmıyor" denildiğinde önce bunlar koşturulur — cihaz yok mu,
sinyal mi zayıf, ayrımı bir dakikada yapılır.

**WSL DÜZELTMESİ:** Bu ADR "WSL'de mikrofon çalışmaz, host'ta koşulur" diyordu.
**Yanlış.** WSLg PulseAudio mikrofonu geçiriyor; eksik olan yalnızca ALSA'nın
pulse eklentisiydi. `libasound2-plugins` + `libasound2-data` sudo'suz kurulup
`~/.asoundrc` pulse'a yönlendirildiğinde cpal cihazı gördü ve **96 000 örnek/sn
gerçek veri aktı**. Bu ölçüm için kullanılan eski WSL tanı betiği git geçmişinde
korunur. WSL artık ses geliştirmesi için kullanılabilir; host yalnızca native
paketleme için gerekli.

## Niyet kapısı — ölçüldü, model reddedildi, kural seçildi (2026-08-12)

**Soru:** Sürekli açık mikrofonda her final transcript gateway'e gitmeli mi?
Gitmezse maliyet ve gecikme düşer; kapı cihazda çalışmalı ki ham ses dışarı
çıkmasın. Önce cihaz-içi küçük bir model düşünüldü ve **karar ölçüme
bağlandı**: eşik önceden yazıldı — cihazda p95 < 300 ms ise iki katmana geç.

**Ölçüm:** MacBook Air M2, Ollama, few-shot prompt, 48–60 örnek/koşu, warmup
hariç, `keep_alive` açık.

| Yapılandırma                    | p95    | Doğruluk   | Kritik hata                           |
| ------------------------------- | ------ | ---------- | ------------------------------------- |
| qwen2.5:0.5b, 3 sınıf           | 114 ms | %42        | hepsine "A" der                       |
| qwen2.5:1.5b, 3 sınıf           | 155 ms | %25        | hepsine "B" der                       |
| qwen3.5:4b, 3 sınıf             | 895 ms | ölçülemedi | thinking modeli, `response` boş       |
| qwen2.5:1.5b, ikili             | 153 ms | %75        | **FN 8/24 — komutun 1/3'ü yutuluyor** |
| qwen2.5:1.5b, ikili + asimetrik | 147 ms | —          | FN 0 ✅ ama **tasarruf %5**           |

**Sonuç:** Gecikme eşiği rahatça geçildi (114–155 ms), yani darboğaz gecikme
değildi. Ama 0.5–1.5B modeller bu ayrımı güvenilir yapamıyor: hatayı azaltmak
için asimetri uygulandığında kapı hiçbir şey yutmuyor, yutmaya başladığında
komutların üçte birini yiyor. Asimetri bilgi eklemiyor, yalnızca hatayı bir
uçtan öbürüne taşıyor. Sesli asistanda yutulan komut en pahalı hatadır.

**Karar:** Niyet kapısı **kural tabanlıdır**: wake-word geçen konuşma sevk
edilir; sevkten sonra `followUpMs` (varsayılan 15 sn) boyunca hitap tekrarı
istenmez. (Kalıp `\bsmith\b` diye yazılmıştı; uygulanan hali fonetik varyantları
da kapsıyor — yukarıdaki 2026-08-16 düzeltmesi.) 0 ms, model yok, deterministik, ölçülen test setinde
~%90 tasarruf. Yani Smith **hitap edilince cevap verir**, her şeyi dinleyip
anlamaya çalışmaz — bu bir ürün kararıdır, model yetersizliğinin telafisi
değildir.

**Sonuçları:**

- `@smith/protocol` DEĞİŞMEZ; `triage` mesaj tipi eklenmez. Kapı tamamen
  `apps/desktop/src/dispatchUtterance.ts` içindedir (`createUtteranceGate`).
- Yutulan konuşma TTS'i kesmez — arka plan konuşması Smith'i susturmamalı.
- Watch/iOS istemcileri de aynı kuralı taşıyabilir; model indirmesi gerekmez.

**Yeniden açılma koşulu:** Bu göreve fine-tune edilmiş küçük bir model, ya da
logprobs veren bir runtime ile gerçek güven eşiği (Ollama 0.20.5 logprobs
vermiyor — test edildi). İkisi de bugün için iş kalemi açar; ölçüm scriptleri
tekrar koşmaya hazır.

## Basamaklı hattan Live'a geçiş — niyet kapısı bugün BAĞLI DEĞİL (2026-08-14)

**Bu ADR'nin mimari şeması artık birincil yol değil.** Basamaklı hat uçtan uca
çalıştı, ama ölçülen ilk-ses gecikmesi **~3,4 sn** ve söz kesme (barge-in) yoktu;
kusur parametrelerde değil mimarideydi. Birincil yol Gemini **Live
speech-to-speech** oldu (`gemini-3.1-flash-live-preview`, ölçülen ilk ses
613 ms; `apps/desktop/src-tauri/src/audio/live.rs`).

Basamaklı hat silinmedi, **yedek yol**: `lib.rs` içindeki motor seçimi
`SMITH_LIVE`'a bakar; Live başlatılamazsa `spawn_transcription` ile basamaklı
hatta düşer. İkisi asla birlikte koşmaz — aynı mikrofon iki kez işlenir ve aynı
cevap iki kez üretilir. Renderer tarafındaki besleme yolu (transcript sevki +
`useTts` cümle tamponu) bu geçişte kaldırıldı; `App.tsx` bugün yalnız
`useMicLevel` + `useLiveVoice` kullanıyor ve `useLiveVoice` salt dinleyicidir.

**DÜZELTME — `SMITH_LIVE` semantiği değişti (2026-08-16).** Bu paragraf eskiden
"`SMITH_LIVE` tanımlı ve `0` değilse Live kurar; **değişken yoksa** basamaklı
hatta düşer" diyordu ve `scripts/dev-win.ps1`'in bayrağı `1` vermesine
dayanıyordu. Bugünkü sözleşme tersine çevrildi: bayrak **varsayılan AÇIK** ve
yalnız açıkça kapatan bir yazım (`0`, `false`, `off`, `no`, `hayir`, `kapali` —
trim'lenmiş, büyük/küçük harf duyarsız) Live'ı kapatır
(`apps/desktop/src-tauri/src/env_flag.rs`, `acik_varsayilan_acik("SMITH_LIVE")`,
`lib.rs:375`). Değişiklik commit `e1596d3` ile geldi; gerekçesi `env_flag.rs`
başlığında yazıyor: eski lehçede `dev-win.ps1` dot-source edilmeden `tauri dev`
koşan biri **yapısal olarak sessiz** bir Smith alıyordu ve tek belirti bir
`eprintln`'di; üstelik `" 0 "` (boşluklu) Live'ı AÇIYORDU. Tanınmayan bir değer
sessizce yutulmaz, uyarılır ve varsayılana düşer. Aynı dosya iki meşru
varsayılanı ayırıyor: ekran ve teşhis WAV'ı gibi gizlilik yüzeyi olan bayraklar
`acik_varsayilan_kapali`'dır.

Bu geçişin ADR'si **[ADR 0009](0009-live-speech-to-speech.md)**'dur (DÜZELTME
2026-08-16: burada "henüz yok, bugünün birincil kaynağı koddur" yazıyordu —
ADR 0009 tam olarak bu geçişi, bedellerini ve ölçülmüş tuzaklarını kaydediyor ve
bu belgenin başındaki "Üstü alındı" satırı ona zaten link veriyor).

**Niyet kapısı kararı uygulandı, ama bugün hiçbir şeyi korumuyor.** Önceki
bölümde kilitlenen wake-word kapısı `apps/desktop/src/dispatchUtterance.ts`
(`createUtteranceGate`) olarak yazıldı, 9 birim testiyle duruyor ve commit
`40e36c4` main'de. Ancak Live'a geçiş + kullanıcının **"hitapsız always-on"**
mandası ile `App.tsx` yeniden yazıldı ve **çağrı yeri düştü**:

```bash
grep -rn "createUtteranceGate\|dispatchUtterance" apps/desktop/src/ \
  --include=*.ts --include=*.tsx | grep -v "^apps/desktop/src/dispatchUtterance"
# → sıfır isabet
```

Kalan bütün isabetler kapının kendi dosyası ve kendi testidir: kod yaşıyor ama
yalnızca kendi testini besliyor. Sebep mimari — Live'da konuşma tespiti **sunucu
tarafında**: `setup.realtimeInputConfig.automaticActivityDetection`
(`START/END_SENSITIVITY_LOW`, `prefixPaddingMs` 300, `silenceDurationMs` 900).
Cihaz tarafında kapılacak bir "final transcript sevki" adımı kalmadı.

**Kapı neden SİLİNMEDİ.** "Cihan başka bir işe odaklanmışsa sessiz kal: oyun,
video, film, müzik, görüşme/toplantı… bu hallerde yalnız sana hitap edilirse
cevap ver" davranışı bugün `live.rs` içindeki SYSTEM yönergesinde, yani **yalnız
istemle** dayatılıyor. Bu reponun ilkesi istemin tavsiye, kodun garanti
olduğudur; kapı o garantinin doğal yeridir ve kararı zaten ölçülmüş
(kural tabanlı, 0 ms, model yok). Karşılaştırma: konuşmacı doğrulaması kod
tarafında gerçekten kapılı — ama yalnız **araç yürütmesi** için
(`audio/speaker.rs`: `OWNER_ONLY_TOOLS`, `NO_FOREIGN_TOOLS`). "Smith cevap
versin mi" sorusunun bugün hiçbir kod karşılığı yok.

**Yeniden bağlama koşulu:** Kapı Live'da transcript sevkine değil **oturum
davranışına** bağlanır — sunucu VAD'i konuşmayı zaten sınırlıyor, kapının işi
"bu konuşma Smith'e mi?" sorusunu cevaplayıp yanıt üretimini bastırmaktır.
Girdi olarak `inputAudioTranscription` metni hazır. O yol açılmadan
`dispatchUtterance.ts` ölü koddur; ama silinmesi, bu davranışı istemden koda
taşıma seçeneğini de kapatır — bu yüzden bilinçli olarak duruyor.
