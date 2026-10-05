# ADR 0008 — Sağlayıcıya-opak bloklar taşınmaz ve kalıcılaştırılmaz

**Tarih:** 2026-08-12
**Durum:** Kabul edildi — bugünkü davranışı invariant'a çevirir, testle bağlar.
**Numara değişti (2026-08-14): 0004 → 0008.** Bu ADR 2026-08-12'de `0004` olarak
yazıldı (commit `59358fe`); 2026-08-14'te aynı numarayla ikinci bir ADR
([0004 — Kişisel Bağlam Besleme](0004-personal-context-ingestion.md)) eklendi ve
"ADR 0004" ifadesi belirsizleşti. Çakışma, gelen atıfı **az** olan tarafı — yani
bu dosyayı — taşıyarak çözüldü. Eski kayıtlarda, commit mesajlarında ve kod
yorumlarında **"ADR 0004"** olarak anılmış olabilir; içerik değişmedi.

## Bağlam

2026-08-12'de yayımlanan bir çalışma (`stolen-thoughts.com`), frontier model
API'lerinin döndürdüğü şifreli/imzalı `thinking` bloklarının **oturum, kullanıcı
ve model arası taşınabilir** olduğunu gösterdi. Saldırı basit: blok yakalanır,
aynı sağlayıcının **zayıf kardeş modeline** continuation olarak verilir
("bu tura ekli muhakemeyi birebir yaz"), jailbreak direnci düşük model düz metni
üretir. Güçlü modele saldırmak gerekmiyor; ücretsiz katman erişimi yeterli.

Ölçek: 6.708 herkese açık ajan trajektorisinden 315.320 blok kurtarılmış, 704
gizli artefakt (API anahtarı, parola, kart numarası, iç URL) çıkmış. Kritik
ayrıntı: **bunların 64'ü yalnızca reasoning bloğunun içindeydi**, görünür
çıktıda hiç yoktu.

Doğru zihinsel model şudur: o blok **opak bir metadata değil, herkese açık bir
oracle'ı olan şifreli metindir.** "Şifreli, o hâlde saklanabilir" akıl yürütmesi
yanlıştır. Bir yere yazıldıysa — log, trace, fixture, issue, dataset — düz metin
yazılmış sayılır.

**Smith bugün yapısal olarak bağışık ama bu kaza eseri:**

- `packages/llm/src/providers/anthropic.ts` yalnız `text` bloklarını
  birleştiriyor, kalanını düşürüyor; `ChatResult` sadece `text` + `usage`
  taşıyor. Asistan turu geçmişe düz string olarak dönüyor, yani çok turlu
  akışta da blob geri gitmiyor.
- `packages/llm/src/providers/openai-compat.ts` yalnız `delta.content` okuyor;
  DeepSeek/Ollama tarzı endpoint'lerin `reasoning_content` / `reasoning`
  alanlarını yok sayıyor.
- `packages/observability/src/tracing.ts`'teki `observe()` yalnız **açıkça
  verilen** `string | number | boolean` metadata'yı span'e yazıyor; prompt ve
  completion otomatik yakalanmıyor.

Bu davranış hiçbir yerde karar olarak yazılmamıştı. Kırılma anı nettir: birisi
extended thinking'i açtığında blok düşüren satır iki yoldan biriyle bozulur —
(a) sessiz bug, `tool_use` blokları da düşer; (b) daha kötüsü, çok turlu
thinking için "tüm blokları koru ve geri besle" diye düzeltilir ki bu tam olarak
taşınabilir ciphertext'i kalıcılaştırmak demektir.

**Faz 1 tek kullanıcı olsa da (ADR 0003) bu karar bugün gerekli:** çok kiracılı
omurga bilerek korunuyor, yani bugün yazılan `packages/llm` kodu Faz 2'nin
kiracılar arası sınırını da belirliyor. Faz 1 kritik yolu cihaz filosu + sandbox
runner + egress içeriyor, yani `tool_call` / `tool_result` çerçeveleri
çoğalacak — opak blok taşıma baskısı tam oradan gelecek. Ve tek kullanıcı olmak
sırların değerini düşürmez; söz konusu olan sahibin kendi anahtarları.

## Karar

1. **`ChatResult` sağlayıcıya-opak blob taşımaz.** İzin verilen alanlar yalnız
   `text` ve `usage`; `usage` içinde yalnız `inputTokens` ve `outputTokens`.
   Bu listeye alan eklemek bir ADR kararıdır, bir implementasyon detayı değil.

2. **Muhakeme izleri uçuşta tüketilir, hiçbir yere yazılmaz.** Depo, kuyruk,
   hafıza, telemetri ve log yollarının hiçbiri `thinking` /
   `redacted_thinking` / `reasoning_content` içeriği veya imzası taşımaz.

3. **Geçmiş düz metindir.** Sağlayıcıya giden her turun `content` alanı
   `string` olarak kalır. Blok dizisi geri beslenmez — bu, taşınabilir
   ciphertext'in sağlayıcıya geri gönderilmesini yapısal olarak engeller.

4. **Observability varsayılanı "metrik topla, içerik opt-in".** `observe()`
   yalnız açıkça verilen kimlik/ölçüm metadata'sını yazar. Langfuse veya başka
   bir arka uçta "tüm istek/yanıt gövdesini yakala" modu açılmaz; açılması
   gerekirse ayrı bir ADR ile ve kapsamı yazılarak açılır.

5. **Extended thinking bugün kullanılmıyor.** İhtiyaç doğarsa bu ADR
   güncellenmeden açılmaz. Açıldığında blokların uçuşta tüketilip atılması
   zorunludur; çok turlu muhakeme sürekliliği için blob saklamak bir çözüm
   değil, bu kararın ihlalidir.

## Doğrulama

`packages/llm/src/providers/opaque-blocks.test.ts` — 5 test, iki sağlayıcıyı
birlikte kapsar:

- anthropic: `thinking` + `redacted_thinking` + `tool_use` blokları içeren bir
  yanıtta yalnız text birleşir; sonuç fazla alan taşımaz; serileştirilmiş
  sonuçta imza ve "yalnız reasoning'de olan sır" sentinel'leri geçmez.
- anthropic: `onDelta` yalnız text bloklarını yayar — muhakeme tüketiciye
  akmaz.
- anthropic: isteğe giden her turun `content` alanı düz string.
- openai-compat: `reasoning_content` / `reasoning` alanları yok sayılır.
- openai-compat: sağlayıcı `usage` bildirmezse alan hiç oluşmaz (uydurulmaz).

**Testin regresyonu gerçekten yakaladığı iki kırılma modu simüle edilerek
doğrulandı (2026-08-12):**

| Kırılma                    | Simülasyon                                                   | Sonuç                                                                                          |
| -------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| (a) bloklar metne katıldı  | `block.type === 'text' ? block.text : JSON.stringify(block)` | test kırmızı                                                                                   |
| (b) bloklar sonuca eklendi | dönen nesneye `blocks: final.content`                        | test kırmızı — `ChatResult beklenmeyen alan tasiyor: expected [ 'blocks' ] to deeply equal []` |

Her iki denemeden sonra dosya geri alındı; `git status` temiz.

## İstisna (2026-08-24): tool-calling devamlılık token'ı — `thought_signature`

**Bağlam.** Faz 2b tool-loop'u (`packages/core` + `SMITH_AGENT_LOOP`) canlı Gemini'ye
karşı doğrulanınca çıktı: Gemini'nin OpenAI-uyumlu ucu **çok turlu function-calling'de**
round-1'de ürettiği `thought_signature`'ı round-2'de tool_call ile birlikte geri ister;
yoksa `400 INVALID_ARGUMENT: "Function call is missing a thought_signature"`.
`reasoning_effort=none` bile imzayı üretir → imzasız geçmek mümkün değil. Yani Gemini ile
araç kullanımı bu token round-trip'i olmadan ÇALIŞMAZ (kalite düşmez, tur KIRILIR). İmza
yanıtta `tool_calls[].extra_content` alanında gelir; bu, 3. maddeyle ("blok dizisi geri
beslenmez") görünürde çelişir.

**Karar — DAR ve KOŞULLU istisna (`c932d1c`).** `thought_signature` (ve ileride
tool-calling devamı için ZORUNLU benzeri opak devamlılık token'ları) `@smith/llm` içinde
TUR-İÇİ taşınabilir. Koşullar — hepsi zorunlu:

1. **Core'a girmez.** `packages/core` `LoopMessage`/`ToolCall` imzayı TAŞIMAZ; sağlayıcı-
   nötr geçmiş temiz kalır. Köprü yalnız `@smith/llm` adapter'ının
   (`apps/gateway/src/agent/llm-loop-model.ts`) tur-içi `Map<toolCallId, meta>`'sindedir;
   loop-model tur başına kurulur → harita tura izole, kalıcı değil.
2. **Kalıcılaştırılmaz.** DB/kuyruk/hafıza/telemetri/log imzayı yazmaz. `run-turn` yalnız
   final metni `Message`'a yazar; loop'un ara tool_call'ları (imza dahil) tur bitince atılır.
3. **Sağlayıcılar arası geçmez.** Yalnız üreten sağlayıcıya (openai-compat/Gemini) round-2'de
   geri döner.

**Neden invariant'ın tehdit modelini İHLAL ETMEZ.** `stolen-thoughts` tehdidi, decode
edilebilen `thinking`/`reasoning_content` CİPHERTEXT'inin kalıcı/cross-provider replay'idir.
`thought_signature` muhakeme METNİ değil, tek bir tool_call'ın devamlılık handle'ıdır; ve
yukarıdaki üç koşul (persist yok, cross-provider yok) tehdidin gerektirdiği kalıcı/taşınabilir
arşivi zaten dışlar. Reasoning METNİ hâlâ düşürülür: `generateWithTools` yalnız
`message.content` + tool_calls okur, `reasoning`/`reasoning_content` alanlarını yok sayar. 5. madde (extended thinking blob'u saklamak yasak) aynen geçerli — o, reasoning içeriğidir;
bu istisna reasoning içeriği DEĞİL.

**Doğrulama (ek).** `packages/llm/src/providers/tool-calling.test.ts`: (a) tool_call
`extra_content` → `providerMeta` yakalanır; (b) round-2 asistan mesajında `extra_content`
olarak geri konur, `content` null; (c) **yanıttaki `reasoning_content` sonuca/metne SIZMAZ**.
`opaque-blocks.test.ts` (ChatResult/streamChat yolu) DEĞİŞMEDİ, hâlâ yeşil — bu istisna o
invariant'ı kırmaz.

## Ne değişmez

- `@smith/protocol` DEĞİŞMEZ; bu karar tamamen `packages/llm` ve
  `packages/observability` içindedir, yeni mesaj tipi veya alan gerektirmez.
- ADR 0003'ün güvenlik modeli aynen geçerli. Bu ADR onu tamamlar: 0003 dış
  içeriğin **içeri** doğru saldırısını (prompt injection → sandbox + egress
  default-deny) düzenler, 0008 ise sırların **dışarı** doğru sızmasını.
- AGENTS.md §2'deki secret disiplini aynen geçerli; bu karar onun LLM
  katmanındaki somut karşılığıdır.

## Yan fayda

Bu bağışıklık yalnız bir güvenlik özelliği değil, Faz 2'de **satılabilir bir
iddia**: Smith'in muhakeme izleri hiçbir yerde birikmez, dolayısıyla replay ile
çözülebilecek bir arşiv de yoktur. Konumlandırmanın "veri nereye hiç gitmedi"
hattıyla aynı yere bakar.
