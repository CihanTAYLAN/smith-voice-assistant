# Piper TTS — HTTP sözleşmesi

**Doğrulama tarihi:** 2026-08-12 · **Paket:** `piper-tts` 1.6.0 (`piper1-gpl`, `piper.http_server`) · **Ses:** `tr_TR-dfki-medium` (MIT, 63.2 MB)

Bu dosya tahmine değil, kurulu paketin kaynağına (`.venv-piper/Lib/site-packages/piper/http_server.py`) ve
canlı sunucudan alınan ölçümlere dayanır. Rust istemcisi (`src-tauri/src/audio/tts.rs`) başka bir şey
okumadan bu dosyayla yazılabilir.

## 1. Sunucuyu başlatma

| Amaç                        | Komut                                              |
| --------------------------- | -------------------------------------------------- |
| Tüm algı sunucuları (gizli) | `.\scripts\smith-servers.ps1 start`                |
| Yalnız Piper (ön planda)    | `.\scripts\tts-piper-server.ps1`                   |
| Durum / durdurma            | `.\scripts\smith-servers.ps1 status` \| `... stop` |
| Log                         | `<veri koku>\logs\tts-piper.log`                   |

`tts-piper-server.ps1` idempotenttir: port zaten bir Piper süreci tarafından dinleniyorsa ikinci kopya
açmaz (exit 0), portu **başka** bir süreç tutuyorsa PID + komut satırını yazıp exit 1 verir, hiçbir şeyi
öldürmez. Paket kuruluysa ağa çıkmaz; model çifti (`.onnx` + `.onnx.json`) eksikse indirir.
`-Port`, `-Voice`, `-BindHost` parametreleri vardır (varsayılan `5000`, `tr_TR-dfki-medium`, `127.0.0.1`).

Adres **yalnız loopback**: `http://127.0.0.1:5000`. Aynı makinedeki diğer portlar: STT sidecar `8123`,
WhisperLiveKit `8000`.

## 2. Uç noktalar

| Metot  | Path          | Girdi                | Çıktı                                    |
| ------ | ------------- | -------------------- | ---------------------------------------- |
| `POST` | `/synthesize` | JSON gövde (aşağıda) | **Ham WAV baytları**                     |
| `GET`  | `/info`       | —                    | JSON: aktif ses + son sentez (fonemler)  |
| `GET`  | `/voices`     | —                    | JSON: indirilmiş seslerin config'leri    |
| `GET`  | `/all-voices` | —                    | JSON: HuggingFace voices.json (ağ ister) |
| `POST` | `/download`   | `{"voice": "<ad>"}`  | Ses adı (düz metin)                      |
| `GET`  | `/`           | —                    | Tarayıcı test sayfası (HTML)             |

Smith'in kullandığı tek uç nokta `/synthesize`; `/info` sağlık kontrolü için yeterlidir.

## 3. `POST /synthesize` istek gövdesi

Gövde JSON'dur ve **UTF-8** kodlanmalıdır. Sunucu `json.loads(request.data)` ile ham gövdeyi okur;
bu yüzden `Content-Type` header'ı **denetlenmez** (yine de `application/json` gönderin).

| Alan            | Tip    | Zorunlu  | Varsayılan           | Not                                           |
| --------------- | ------ | -------- | -------------------- | --------------------------------------------- |
| `text`          | string | **evet** | —                    | Boş/whitespace ise **HTTP 500**               |
| `voice`         | string | hayır    | başlatılan ses       | Bilinmeyen ad **sessizce** varsayılana düşer  |
| `speaker_id`    | int    | hayır    | `null`               | `tr_TR-dfki-medium` tek konuşmacılı; etkisiz  |
| `speaker`       | string | hayır    | —                    | `speaker_id` verilirse yok sayılır            |
| `length_scale`  | float  | hayır    | model config (`1.0`) | Büyük = **yavaş**. 1.5 → süre ×1.39 (ölçüldü) |
| `noise_scale`   | float  | hayır    | model config         | Üretici gürültüsü                             |
| `noise_w_scale` | float  | hayır    | model config         | Fonem genişliği gürültüsü                     |

> **Tuzak:** Paketin kendi docstring'i bu alanı `length_w_scale` diye yazar; **yanlıştır**. Kod yalnız
> `noise_w_scale` okur. Yanlış ad hata vermez, sessizce yok sayılır (HTTP 200 döner).

## 4. Yanıt

| Özellik          | Değer                                                           |
| ---------------- | --------------------------------------------------------------- |
| Durum            | `200`                                                           |
| `Content-Type`   | **`text/html; charset=utf-8`** — yanıltıcı; gövde ikili WAV'dır |
| `Content-Length` | Doğru (chunked değil), `Connection: close`                      |
| Gövde            | Kanonik 44 baytlık RIFF/WAVE başlığı + `data` chunk'ı           |

> **Tuzak:** Content-Type'a **bakmayın**. Flask view'ü `bytes` döndürdüğü için mimetype varsayılan
> `text/html` kalır. İçerik gerçekten WAV'dır (`RIFF....WAVE`).

Başlık alanları doğrulandı — `ChunkSize` ve `data` boyutu doğru yazılır, yani `hound`/`symphonia`
gibi katı parser'lar sorunsuz okur (streaming yazıcılardaki bozuk boyut sorunu **yok**):

```
52 49 46 46 24 cc 00 00 57 41 56 45 66 6d 74 20 10 00 00 00 01 00 01 00
22 56 00 00 44 ac 00 00 02 00 10 00 64 61 74 61 00 cc 00 00
RIFF | size | WAVE | fmt  | 16 | PCM(1) | ch=1 | 22050 | 44100 | align=2 | 16 bit | data | size
```

| Ses formatı (ölçüldü) | Değer                                |
| --------------------- | ------------------------------------ |
| Örnekleme frekansı    | **22050 Hz**                         |
| Kanal                 | **1 (mono)**                         |
| Bit derinliği         | **16 bit signed PCM, little-endian** |
| Başlık boyutu         | 44 bayt                              |

Rust tarafı: `TextToSpeechEngine::sample_rate()` → `22_050` döner (mevcut `PLACEHOLDER_RATE` ile aynı,
playback resample yolu değişmez). `synthesize()` için: 44 baytı atla **veya** düzgün RIFF parse et,
`i16` örnekleri `f32 / 32768.0` ile normalize et.

### Hata yolları

| Durum              | Sonuç                                                        |
| ------------------ | ------------------------------------------------------------ |
| `text` boş / yok   | `500` + HTML hata sayfası (**400 değil**)                    |
| Bozuk JSON         | `500` + HTML                                                 |
| `GET /synthesize`  | `405`                                                        |
| Bilinmeyen `voice` | `200` — varsayılan sesle sentezler, sadece log'a uyarı yazar |

> **Tuzak:** Hatalar makine-okunur değildir; gövde HTML'dir. İstemci **yalnız** HTTP durum koduna ve
> gövdenin `RIFF` ile başlayıp başlamadığına bakmalıdır. Metni göndermeden önce `trim` edip boşsa
> istek atmamak en ucuz korumadır.

## 5. Ölçümler (bu makine: i7-12700F, CPU-only, CUDA yok)

Sentez tamamen CPU'da; `onnxruntime` çıkarım sırasında GIL'i bırakır.

| Koşul                          | Metin süresi | İstek süresi | RTF   |
| ------------------------------ | ------------ | ------------ | ----- |
| **Soğuk** (sürecin ilk isteği) | 4.95 sn      | **1060 ms**  | 0.214 |
| Sıcak                          | 4.28 sn      | 330 ms       | 0.077 |
| Sıcak                          | 4.42 sn      | 490 ms       | 0.111 |
| Sıcak                          | 5.04 sn      | 516 ms       | 0.102 |
| Sıcak (kısa cümle)             | 2.15 sn      | 133 ms       | 0.062 |

- **Soğuk bedeli tek seferliktir** (~500 ms ekstra, ilk `onnxruntime` çıkarımının arena tahsisi).
  Sunucu açılışında model zaten yüklenir; port dinlemeye başladıysa ağır iş bitmiştir.
- Sıcak **RTF ≈ 0.06–0.11**, yani gerçek zamanın ~10 katı hızında. CPU fazlasıyla yeterli, CUDA gereksiz.
- İlk sesin gecikmesini düşük tutmak için cümle-chunk beslemesi (mevcut `SentenceBuffer`) doğru
  yaklaşımdır: tek cümle ~130–500 ms'de hazır olur.

**Eş zamanlılık:** Werkzeug dev sunucusu threaded çalışır — 3 eş zamanlı istek 471 ms'de bitti
(seri olsaydı ~1478 ms). Yani barge-in/çoklu cümle senaryosunda istekler birbirini bloklamaz.

## 6. Bilinen tuzaklar (özet)

1. `Content-Type: text/html` gelir ama gövde WAV'dır — header'a göre karar vermeyin.
2. Hata gövdesi HTML'dir, JSON değil; boş `text` **500** verir.
3. `length_w_scale` diye bir alan **yoktur** (docstring hatası); doğrusu `noise_w_scale`.
4. Bilinmeyen `voice` sessizce varsayılana düşer — yanlış sesle konuşma fark edilmeyebilir.
5. Log'daki `The onnx package is required for include_alignments` uyarısı **zararsızdır**; yalnız
   `/info` fonem hizalamalarını boş bırakır, sentezi etkilemez.
6. `--sentence-silence` varsayılanı `0.0`: çok cümleli metinlerde cümleler arasında duraklama olmaz.
   Gerekirse sunucuyu bu bayrakla başlatın (istek başına ayarlanamaz).
7. Werkzeug **dev** sunucusudur; localhost-only kaldığı sürece sorun değil, dışarı açılmamalıdır.
8. PowerShell'den `curl.exe` ile test ederken JSON'u **tek tırnak** içine alın ve iç tırnakları
   kaçırmayın (`'{"text":"..."}'`). `'{\"text\":...}'` yazımı gövdeye ters bölü sokar → 500.

## 7. Örnek

```powershell
# PowerShell (PS 7.6 ile doğrulandı) — 200, 94764 bayt, 2.15 sn ses
curl.exe -s -X POST http://127.0.0.1:5000/synthesize `
  -H "Content-Type: application/json" `
  -d '{"text":"Merhaba efendim, curl testi."}' `
  -o test.wav -w "http=%{http_code} bytes=%{size_download}`n"
```

```bash
# bash
curl -s -X POST http://127.0.0.1:5000/synthesize \
  -H 'Content-Type: application/json' \
  -d '{"text":"Merhaba efendim.","length_scale":1.0}' \
  -o test.wav
```

Python test istemcisi (format + gecikme + RTF raporlar):

```powershell
$py = ".\apps\desktop\sidecar\.venv-piper\Scripts\python.exe"
& $py .\apps\desktop\sidecar\test_piper_client.py --out ornek.wav   # tek cümle + WAV analizi
& $py .\apps\desktop\sidecar\test_piper_client.py --bench           # soğuk + sıcak gecikme serisi
```

Türkçe aksanlı karakterler (ç ğ ı ö ş ü) UTF-8 gövdeyle sorunsuz çalışır; doğrulandı
("Günaydın efendim. Çağrı kaydını özetledim…" → 5.13 sn, `/info` fonemleri `ɡunajdˈɪn efændˈɪm`).
