# ADR 0003 — Faz 1: Önce Kişisel JARVIS (SaaS açık opsiyon)

**Tarih:** 2026-08-12
**Durum:** Kabul edildi — aktif fazı ve öncelik sırasını tanımlar.

## Bağlam

Kuruluş kararı "gün bir multi-tenant SaaS" idi ve omurga buna göre inşa edildi:
Scope sözleşmesi, Postgres RLS (4/4 kanıtlı), workspace'li auth, kapsamlı
queue/memory. Bu katmanlar bugün çalışıyor ve doğrulanmış durumda.

2026-08-12'de Cihan vizyonu netleştirdi: **ilk aşamada Smith yalnızca ona
hizmet eder.** Hedef, çok gelişmiş JARVIS yeteneklerine sahip ve uygulamasının
kurulu olduğu **bütün cihazlar üzerinde yönetime sahip** kişisel bir asistan.
Satış/ürünleşme sonraya — ama ihtimal canlı tutulacak.

## Karar

1. **Faz 1 kapsamı = tek kullanıcı, tam yetenek.** Başarı ölçütü demo değil
   fiili iştir: Smith'in Cihan'ın günlük akışında araç çalıştırması, cihazlar
   arasında eylem alması ve proaktif algı üretmesi (ADR 0001 ses, ADR 0002
   görsel/durumsal).

2. **Çok kiracılı omurga aynen korunur.** Scope/RLS/auth sökülmez; yeni kod
   aynı sözleşmeyle yazılır. Tek kiracı bir **yapılandırma durumudur, mimari
   varsayım değil.** Gerekçe: sökmek geri dönülmez bilgi kaybı, tutmak ucuz;
   omurga Faz 2 satış opsiyonunun teminatıdır.

3. **Satış yüzeyleri park edilir.** Billing, workspace yönetim UX'i, self-serve
   onboarding Faz 2'ye ertelendi. Bunlara Faz 1'de efor harcanmaz.
   (DÜZELTME 2026-08-16: bu madde `packages/billing`'i var olan bir paket gibi
   anıyordu — öyle bir dizin **yok**, hiç yazılmadı. Park edilen şey bir kod
   değil bir **kapsamdır**; AGENTS.md §6 tablosunda da "park — Faz 2" satırı
   olarak duruyor. Yanlış okuma maliyeti: birinin "billing iskeleti var, üstüne
   koyarım" diye başlaması.)

4. **Cihaz filosu yönetimi birinci sınıf hedeftir.** Her kurulu istemci bir
   "device node"dur: kayıt + varlık (presence) + yetenek bildirimi sunucuda
   tutulur. Cihaz-tarafı araç yürütme **mevcut** `tool_call`/`tool_result`
   çerçeveleriyle taşınır — protokol forku yok; `hello`'ya opsiyonel
   `capabilities` alanı eklemek geriye dönük uyumludur (openclaw mirası bu
   akışı zaten öngörmüştü; gateway'deki "istemci aracı desteklenmiyor" reddi
   kaldırılacak ilk taş).

5. **Öncelik sırası (Faz 1 kritik yolu) — ilk sıralama (2026-08-12):**
   1. `packages/core` tool-loop — LLM tool_call üretir; yürütme iki hedefe
      yönlenir: sunucu (sandbox) veya cihaz (protocol WS).
   2. Device registry + presence + capability bildirimi.
   3. Sandbox runner (Docker+runsc) ve **egress proxy'si — ilk sunucu-tarafı
      araç canlıya çıkmadan ÖNCE** (bkz. `packages/sandbox` sözleşmesi).
   4. Proaktiflik hattı (ADR 0002'nin uygulanması).
   5. Apple hattı istemcileri (device-node modeliyle).

   **DÜZELTME (2026-08-16): #1 planlandığı yerde YAPILMADI, #4 BİTTİ.** Bu liste
   dört gün boyunca "sıradaki iş `packages/core`" diye okunmaya devam etti ve
   ADR 0007 ile ayrıştı (`0007:22` doğru söylüyor: "Olmayan tek sey
   `packages/core` tool-loop'u"). Bugünkü gerçek:

   - **`packages/core` diye bir paket YOK** ve workspace'te `@smith/core`
     referansı sıfır. Mevcut 11 paket: `tenancy`, `protocol`, `env`, `db`, `llm`,
     `memory`, `auth`, `queue`, `observability`, `sandbox`, `mission`.
   - **Tool-loop yazıldı, ama sunucuda değil CİHAZDA:**
     `apps/desktop/src-tauri/src/audio/live.rs` Gemini Live oturumunun
     function-calling akışını sürüyor — 13 araç tanımı, dispatch, `ToolBridge`
     ile gateway HTTP'sine köprü ve `SpeakerGate` kapısı. Yani bu maddenin
     "yürütme iki hedefe yönlenir" hedefi kısmen tutuldu (hafıza/mission
     gateway'de, terminal/donanım cihazda) ama **soyutlama paylaşılan bir pakette
     değil, tek istemcinin içinde**. Bedeli: ikinci bir istemci (Apple hattı,
     `apps/cli`) aynı döngüyü sıfırdan yazmak zorunda kalır — `packages/core`'un
     asıl gerekçesi buydu ve hâlâ geçerlidir.
   - **#4 proaktiflik hattı TAMAM:** [ADR 0005](0005-persona-and-proactivity.md)
     (üç tetikleyici + susturma sınırı, testle bağlı) ve ADR 0002'nin ekran
     algısı canlı.
   - #2 (device registry/presence) ve #3 (sandbox runner + egress) **açık**;
     `packages/sandbox` iskelet halinde.

   Kritik yol bu yüzden yeniden sıralanmalıdır: bugün sıradaki iş
   "`packages/core`'u sıfırdan yazmak" değil, **`live.rs`'te kanıtlanmış
   tool-loop'u paylaşılabilir bir pakete çıkarmak** (ikinci gerçek kullanım
   çıktığında — bkz. AGENTS.md'nin ortaklaştırma kuralı).

## Güvenlik modeli — iki yürütme hedefi, iki güven sınıfı

- **Sunucu-tarafı araçlar:** sandbox zorunlu, tek kullanıcıda bile. Tehdit
  kiracı komşusu değil, **dış içerik**: web sayfası/e-posta işleyen bir
  asistanda prompt injection, sandbox'sız aracı sahibin altyapısında keyfi
  koda çevirir. Egress default-deny bu yüzden kişisel kullanımda da geçerli.
- **Cihaz-tarafı araçlar:** cihaz sahibinin kendi donanımında, kendi
  yetkisiyle koşar — sandbox sınıfı izolasyon aranmaz. Yıkıcı eylemler için
  onay kapısı gerekir; onay çerçevesinin protokol karşılığı **açık sorudur**,
  ayrı bir kararla çözülecek.

## Ne değişmez

AGENTS.md §2'deki kırmızı çizgilerin tamamı: Scope zorunluluğu, RLS, sunucu
araçlarında sandbox, protokol geriye dönük uyumluluğu, secret disiplini.
