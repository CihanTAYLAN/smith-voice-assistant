# ADR 0011 — Embedding sağlayıcısı: bulut Gemini (yerel Ollama'dan taşındı)

**Tarih:** 2026-08-13 (karar) / 2026-08-25 (yazıya geçirildi)
**Durum:** Kabul edildi.

## Bağlam

Başlangıçta embedding **yerel Ollama** (`nomic-embed-text`) ile üretiliyordu ve
"hafıza içeriği makineden çıkmaz" bir gizlilik ilkesiydi — [ADR 0004](0004-personal-context-ingestion.md)
gizlilik hattının parçası, [ADR 0009](0009-live-speech-to-speech.md)'da da Live
ses ihlaline karşı bir telafi olarak sayıldı ("embedding yerelde").

2026-08-13'te kullanıcı kararıyla değişti. İki gerçek gerekçe:

- **Çökme kırılganlığı:** Ollama container'ı/servisi düşünce hafıza TAMAMEN
  erişilemez oluyordu (2026-08-13 "hafıza boş" krizi; kök neden altyapıydı,
  embedding'in tek bir yerel sürece bağlı olması riski büyüttü).
- **Kalite/verim:** yerel embed Türkçe'de yetersiz ve verimsizdi.

Karar: embedding **bulut Gemini `gemini-embedding-001 @ 768`** boyuta taşındı
(aynı Google anahtarı; Gemini varsayılan 3072 üretir, istemci-tarafı Matryoshka
kırpma + L2 renormalize ile 768'e indirilir — DB `vector(768)` şeması değişmez).

## Karar

1. **Tek env dikişi.** Embedding `SMITH_EMBED_*` ile yapılandırılır; gateway VE
   worker TEK çözücüden okur (`createEmbedderFromEnv`, `packages/memory`, commit
   `a3459f2`). Elle-senkron iki çağrı drift üretmişti (worker OLLAMA'ya sabit
   kalıp gateway'in Gemini ayarını yok sayıyordu) — artık tek kaynak.

2. **Bulut embed'de hafıza METNİ sağlayıcıya (Google) gider.** Bu bilinçli bir
   gizlilik ödünüdür ve ses zaten Live'da buluta gittiği için ([ADR 0009](0009-live-speech-to-speech.md))
   tutarlıdır. "Embedding yerelde" ARTIK bir garanti DEĞİLDİR.

3. **`secret` sınıfı korunur.** Recall yalnız `['public','personal']` sınıfını
   embed'ler/döndürür ([ADR 0004](0004-personal-context-ingestion.md) §3); `secret`
   hafıza buluttaki modele hiç gitmez. Ama `public`/`personal` embed metni buluta
   çıkar — yüzey daraltıldı, sıfırlanmadı.

4. **Yerel geri dönüş duruyor.** `SMITH_EMBED_*` boş bırakılırsa embedding yerel
   Ollama/nomic'e düşer (offline geliştirme). Planlanan sağlayıcı yedek zinciri:
   Gemini → Mistral → OpenRouter → yerel Ollama.

5. **🟡 Sağlayıcı-flip tuzağı (açık risk).** `SMITH_EMBED_MODEL`/`BASE_URL`
   sonradan değişirse mevcut kayıtlar ESKİ vektör uzayında kalır; boyut ikisinde de
   768 olduğu için boyut kontrolü hata VERMEZ → recall sessizce çürür. Embed
   sağlayıcısı değişirse re-embed ZORUNLU (`DELETE FROM "Memory"` + konnektörleri
   tekrar çalıştır). Kayıt-başı embed-model damgası + açılış assert'i ayrı bir iş
   olarak açık.

## Doğrulama

- `packages/memory/src/embedder.ts`: `createEmbedderFromEnv` tek çözücü;
  `fitDimension` Matryoshka kırpma + L2 renorm; boyut ≠ 768 ise `EmbeddingError`.
- `apps/gateway/src/index.ts` + `apps/worker/src/index.ts`: ikisi de
  `createEmbedderFromEnv(env)`; açılışta `[gateway]/[worker] embed: <model>` loglar.
- DB'de (2026-08-25 ölçümü) 1230 kayıt tutarlı `gemini-embedding-001 @ 768`
  uzayında; karışık değil.

## Ne değişmez

- **[ADR 0008](0008-opaque-provider-blocks.md) aynen geçerli.** Embedding vektörü
  muhakeme (`thinking`/`reasoning`) bloğu değildir; bu ADR onunla çelişmez.
- DB `vector(768)` + `EMBEDDING_DIMENSIONS=768` değişmez.
- [ADR 0003](0003-personal-first-jarvis.md) kritik yolu ve çok-kiracılı RLS omurgası aynen geçerli.

## Supersedes

[ADR 0009](0009-live-speech-to-speech.md)'daki "Embedding yerelde" telafi maddesi
bu ADR'yle güncellendi: embedding artık buluttadır, o satır düzeltildi ve buraya
işaret ediyor.
