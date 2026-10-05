# Smith — Engineering Instructions

**Snapshot:** 2026-10-03

Bu dosya tüm repo için ortak çalışma sözleşmesidir. Daha derindeki `AGENTS.md` yalnız kendi alt ağacına ek kural getirir; çelişkide en yakın dosya kazanır.

## 1. Smith nedir

Smith, Cihan'ın kendi altyapısında çalışan kişisel yapay zekâ asistanıdır. Tek bir çekirdek, çok sayıda yüzey: web, terminal, iOS, watchOS, macOS, Android, Windows ve mesajlaşma kanalları.

**Faz 1 — kişisel JARVIS (aktif faz):** Smith yalnızca Cihan'a hizmet eder. Hedef, uygulamasının kurulu olduğu bütün cihazlar üzerinde algı + eylem yetkisidir: cihazlar yeteneklerini bildirir, çekirdek araçları ya sunucu sandbox'ında ya da ilgili cihazda çalıştırır — bkz. [`docs/decisions/0003`](docs/decisions/0003-personal-first-jarvis.md). Billing ve workspace yönetimi gibi satış yüzeyleri bu fazda inşa edilmez.

**Faz 2 — ürünleşme (açık opsiyon):** Multi-tenant SaaS olarak satış ihtimali canlıdır. Çok kiracılı omurga (Scope, RLS, auth) bu yüzden Faz 1'de aynen korunur ve tüm yeni kod bu sözleşmeyle yazılır; tek kiracı bir yapılandırma durumudur, mimari varsayım değil.

Bu repoda çalışan agent, Cihan'ın proactive engineering partner'ı olarak davranır:

- Emri mekanik uygulamaz; hedefi, mevcut sistemi ve yan etkileri birlikte düşünür.
- Sonucu önce söyler. Teknik değişiklikten önce ne yapacağını ve nedenini sade Türkçeyle açıklar.
- Normal, açıkça istenmiş ve geri alınabilir işi onay döngüsüne sokmadan uygular ve doğrular.
- Mimari, schema, public API, auth, secret, tenant sınırı, production veya geri dönüşü zor kararda seçenekleri uygulamadan önce anlatır.
- Bilmediğini tahmin etmez. Kanıtlanamayan noktayı varsayım olarak adlandırır.

### İletişim

- Cihan ile Türkçe konuş; teknik terimleri, source identifier'larını ve wire değerlerini English bırak.
- "Hangi dosyayı değiştirdim" kadar "üründe ne değişti, neden önemli, nasıl doğrulandı" bilgisini de ver.
- Uzun log dökümü yerine kök neden ve somut çözüm.

## 2. Kırmızı çizgiler

Bunlar tercih değil, sistemin doğruluk koşullarıdır. Faz 1'in tek kullanıcılı kapsamı hiçbirini gevşetmez.

**Tenant izolasyonu.** Veri okuyan hiçbir kod yolu `Scope` taşımadan yazılmaz. Kapsam bir değer değil, taşınması zorunlu bir yetkidir — bkz. [`packages/tenancy/src/scope.ts`](packages/tenancy/src/scope.ts). Her tenant tablosu `workspaceId NOT NULL` taşır ve RLS politikası uygulanır. `createSystemScope` yalnızca arka plan işlerinde, yazılı gerekçeyle kullanılır. Uygulama katmanı bir filtreyi kaçırsa bile veritabanı satır döndürmemelidir; RLS son söz sahibidir.

**Araç çalıştırma izolasyonu.** Smith gerçek iş yapar: komut çalıştırır, dosya okur. Çok kiracılı bir sistemde bu, sandbox olmadan uzaktan kod çalıştırma hakkı satmak anlamına gelir. Sunucu tarafında çalışan hiçbir araç sandbox dışında yürütülmez — tek kullanıcılı Faz 1'de de: tehdit kiracı komşusu değil, işlenen dış içerikten gelen prompt injection'dır. Cihaz-tarafı araçlar ayrı güven modelindedir (cihaz sahibinin kendi yetkisi); bkz. ADR 0003.

**Protokol uyumluluğu.** [`packages/protocol`](packages/protocol) altı istemci familyasının ortak sözleşmesidir. Buraya eklenen alan geriye dönük uyumlu olmak zorundadır (opsiyonel veya varsayılanlı). Kırıcı değişiklik `PROTOCOL_VERSION` artırmadan girmez; gateway iki sürümü bir süre birlikte taşır.

**Secret.** Secret, token, private key ve gerçek `.env` içeriği repoya girmez. `scripts/scan-secrets.sh` pre-commit'te bunu zorlar. Log ve hata çıktılarında değerler maskelenir.

## 3. Doğrulama sözleşmesi

Bir iş, doğrulanmadan tamamlanmış sayılmaz. Kanıt = çalıştırılan komut ve çıktısı.

```bash
pnpm verify
```

`format:check → lint → typecheck → test → build` sırasını çalıştırır. CI da aynı sırayı çalıştırır; yerel kapı ile CI kapısı ayrışmaz.

Yerel kapılar (lefthook, `pnpm install` ile otomatik kurulur):

| Kapı         | Ne yapar                                              |
| ------------ | ----------------------------------------------------- |
| `pre-commit` | staged dosyalarda prettier + eslint + secret taraması |
| `commit-msg` | Conventional Commits formatını zorlar                 |
| `pre-push`   | tüm repoda typecheck                                  |

Hook'u atlamak (`--no-verify`) istisnai ve açıkça gerekçelendirilmiş bir durumdur.

## 4. Çalışma kuralları

- Çalışan kod, manifest, migration ve doğrulanmış runtime davranışı; README, plan ve eski notlardan üstündür.
- Göreve başlamadan önce `git status --short` ve en yakın `AGENTS.md` okunur.
- Yeni servis, config, component, schema, helper veya dependency eklemeden önce repo içinde karşılığı aranır.
- En küçük doğru değişiklik yapılır. **İkinci gerçek kullanım çıkmadan** generic abstraction kurulmaz.
- Kapsam dışı kullanıcı değişiklikleri korunur; "hazır buradayken" refactor yapılmaz.
- Placeholder, mock success, yutulan error, kırık test veya doğrulanmamış "tamamlandı" bırakılmaz.
- Semptom bastırma yasak: `any`, `ts-ignore`, geniş `try/catch`, atlanan test, susturulan uyarı yerine kök neden giderilir. ESLint bunların çoğunu zaten hata sayar.
- Protocol veya shared contract değiştiğinde tüm consumer'lar (gateway, web, cli, apple, android, channels) birlikte aranır.
- Smith'in yerel durum dosyaları (log, sağlık ve yedek durumu, oturum sırrı, ses izi, pencere konumu, `smith.env`, ...) **tek veri kökünde** durur: `SMITH_DATA_DIR` ya da `%USERPROFILE%\.smith` (Windows dışında `~/.smith`). `%LOCALAPPDATA%` / `%APPDATA%` tabanlı yol yazılmaz: Claude masaüstü uygulaması MSIX paketidir, ondan başlatılan süreçler AppData yazılarını paket kopyasına yönlendirir, zamanlanmış görev ve terminal ise gerçek AppData'yı görür (iki ayrı "gerçek"). Kural `scripts/check-data-root.mjs` kapısıyla (lefthook + `pnpm test`) zorlanır; kök çözümleme tek yerde: Rust `src-tauri/src/paths.rs`, Python `sidecar/smith_paths.py`, PowerShell `scripts/smith-common.ps1`, Node `apps/worker/src/engines/run-dir.ts`. Ayrıntı ve eski konumdan taşıma: [`docs/runbooks/7-24-calistirma.md`](docs/runbooks/7-24-calistirma.md).

## 5. Sürüm ve bağımlılık yönetimi

- Tüm sürümler `pnpm-workspace.yaml` içindeki **catalog**'dan gelir. Paket manifestinde `"catalog:"` yazılır, çıplak sürüm yazılmaz. Sürüm kayması bu yüzden imkânsızdır.
- `minimumReleaseAge: 2880` — 48 saatten yeni yayınlanmış sürüm kurulmaz. Supply-chain savunmasıdır. İstisna gerekiyorsa `minimumReleaseAgeExclude`'a gerekçesiyle eklenir.
- `allowBuilds` her build script'i için açık `true`/`false` kararı ister. Yeni bir paket build isterse install kırmızı kalır; sessiz kod çalıştırma yoktur.
- Ortak TypeScript, ESLint ve Prettier ayarları [`tooling/`](tooling) altındaki paketlerden gelir. Paket içinde kural kopyalanmaz.

## 6. Repo haritası

| Alan                     | Sorumluluk                                                                                            | Durum                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `tooling/typescript`     | Ortak tsconfig tabanları (`base`, `node`, `react`)                                                    | hazır                                                                                              |
| `tooling/eslint`         | Flat config; semptom bastırmayı hata sayar                                                            | hazır                                                                                              |
| `tooling/prettier`       | Tek biçimlendirme kaynağı                                                                             | hazır                                                                                              |
| `packages/tenancy`       | Workspace scope, rol hiyerarşisi, RLS politika üreteci                                                | hazır                                                                                              |
| `packages/protocol`      | Gateway wire sözleşmesi                                                                               | hazır                                                                                              |
| `packages/env`           | Zod ile doğrulanmış, fail-fast config                                                                 | hazır                                                                                              |
| `packages/db`            | Prisma + pgvector + RLS migration'ları                                                                | hazır                                                                                              |
| `packages/core`          | Agent döngüsü, tool registry, monotonik guard (ADR 0010)                                              | gateway'de bağlı (bayrak)                                                                          |
| `packages/llm`           | Provider router (Anthropic + OpenAI-uyumlu uçlar; canlı zincir: Gemini)                               | hazır                                                                                              |
| `packages/memory`        | pgvector embedding + kapsamlı arama + recall                                                          | hazır                                                                                              |
| `packages/mission`       | Mission Control: ekip kaydı, görev panosu durum makinesi (ADR 0007)                                   | hazır                                                                                              |
| `packages/auth`          | Parola + JWT + refresh rotasyonu + cihaz eşleştirme                                                   | hazır                                                                                              |
| `packages/sandbox`       | Araç çalıştırma izolasyonu (gVisor; iskelet + politika katmanı)                                       | iskelet                                                                                            |
| `packages/queue`         | BullMQ iş kuyruğu                                                                                     | hazır                                                                                              |
| `packages/observability` | Langfuse trace + yapısal log                                                                          | hazır                                                                                              |
| `packages/billing`       | Kota, kullanım ölçümü, iyzico/Stripe                                                                  | planlı — Faz 2; dizin henüz yok, sıfırdan yazılacak                                                |
| `packages/channels`      | Kanal adapter sözleşmesi (Telegram, WhatsApp, …)                                                      | planlı                                                                                             |
| `packages/plugin-sdk`    | Üçüncü taraf yetenek paketleri                                                                        | planlı                                                                                             |
| `apps/gateway`           | Hono HTTP + WebSocket; tek giriş kapısı                                                               | hazır                                                                                              |
| `apps/worker`            | Kuyruk tüketicisi: MEMORY_INDEX + SESSION_SUMMARY + AGENT_RUN (claude-code/codex motorları, ADR 0015) | hazır                                                                                              |
| `apps/web`               | Next.js yönetim yüzeyi + PWA                                                                          | planlı — prod compose'daki `web` servisi bu DEĞİL: nginx statik durum sayfası (`docker/prod/web/`) |
| `apps/cli`               | Terminal istemcisi                                                                                    | hazır                                                                                              |
| `apps/desktop`           | Tauri 2 + React/Vite masaüstü istemcisi (protocol WS); Live voice; arayüz = plasma-ui deck            | hazır (araçlar: `apps/desktop/src-tauri/src/audio/live/tools.rs`; test sayısı: `cargo test --lib`) |
| `apps/clients/apple`     | SmithKit + iOS + watchOS + macOS                                                                      | planlı                                                                                             |
| `apps/clients/android`   | Kotlin istemci                                                                                        | planlı                                                                                             |
| `docs/decisions/`        | Mimari karar kayitlari (ADR)                                                                          | aktif                                                                                              |

## 7. Dokümantasyon

Mimari kararlar `docs/decisions/` altında ADR olarak tutulur (`NNNN-kisa-baslik.md`,
ilk satır tam olarak `# ADR NNNN — Başlık`). Numara bütünlüğünü
`scripts/check-adr-numbers.sh` pre-commit kapısı denetler. Çok günlük etkisi olan
her karar (framework, şema, sağlayıcı, sandbox modeli) ADR gerektirir.

`CLAUDE.md` yalnız bu dosyaya yönlendirir; ikinci bir kural seti değildir.
