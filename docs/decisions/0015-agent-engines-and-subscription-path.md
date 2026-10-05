# ADR 0015 — Ajan motorları ve abonelik hattı (ikinci motor: Codex)

**Tarih:** 2026-09-18
**Durum:** Kabul edildi — Codex motoru yazıldı, sözleşme testleri yeşil,
Windows hattı **canlı** doğrulandı; WSL hattı kurulum bekliyor (kullanıcı eylemi).

## Bağlam

Kullanıcı mandası (birebir): _"ben smith kullanırken, codex ve claude code
aboneliklerimi de kullanmak istiyorum."_

Bugüne kadar tek iş gücü vardı: `apps/worker/src/engines/claude-code.ts` —
WSL'de headless `claude` CLI, yani **Claude aboneliğiyle** koşan motor
(ADR 0007 §4). ADR 0007 aynı yerde ikinci motoru öngörmüş ve registry'yi
"ikinci gerçek kullanım çıkmadan kurma" diye bağlamıştı. O ikinci kullanım
Codex'tir.

Bu karar verilirken masada bir **üçüncü seçenek** vardı ve elendi: hazır bir
model router'ı (`weave-os/router` 2.0, ELv2) araya koymak. Gerekçe §Alternatifler.

## Karar

**1. Motor, koşu satırında taşınan bir alandır.** `AgentRun.engine` (kolon
zaten vardı) atama anında yazılır; varsayılan `claude-code`. Aynı ajan farklı
görevlerde farklı motorla koşabilir; hangi motorun koştuğu sonradan tahmin
edilmez, kayıttan okunur.

**2. İki motor, tek sözleşme.** `EngineRunInput` → `EngineRunResult`
(`apps/worker/src/engines/engine-result.ts`). Kayıt yeri `engines/index.ts` ve
tip `Record<AgentEngine, …>`: kanonik listeye üçüncü motor eklenirse worker
**derlenmez** — "eklendi ama kayıt yerine yazılmadı" sessiz bir runtime
hatasına dönüşemez. Çağıran (`consumers/agent-run.ts`) motora özgü hiçbir şey
bilmez.

**3. Motor kimliği = abonelik; kimlik kurulumu KULLANICI eylemidir.** Kod
yalnızca kimliğin durumunu tespit eder ve raporlar (`codex login status` →
panelde `identity`). Bir token/auth dosyası **kopyalanmaz, taşınmaz,
loglanmaz**; kod asla kimlik kurmaz.

**4. Abonelik hattı cihaza bağlıdır ve kişiseldir.** Motor `device`
ekseninde koşar (ADR 0003). Faz 2'de çok kiracılı bir kurulum tek kişinin
abonelik kotasıyla beslenemez: kiracı kendi anahtarını/aboneliğini getirir.
Bu satır bugün kod olarak değil, **sınır olarak** burada duruyor.

**5. Koşacağı makine İŞ KÖKÜNÜN LEHÇESİNDEN türetilir, tercih edilmez.**
`resolveCodexHost`: kök `C:\…` ise Windows, `/…` ise WSL. Karışık liste →
**hata**. `SMITH_CODEX_HOST` (`auto` | `wsl` | `windows`) türetmeyi ezebilir;
varsayılan `auto`. Gerekçe ölçülmüştür: sabit `wsl` varsayılanı, Windows iş
kökü olan bir ajanda "CLI bulunamadı" üretiyordu; yol çevirisi (`wslpath`)
YAPILMAZ çünkü bir motor tek makinede koşar.

**6. Sandbox modu allowlist'tir** (`read-only`, `workspace-write`);
`danger-full-access` ve `--dangerously-bypass-*` HİÇBİR koşulda geçmez.
Kullanıcının interaktif Codex ayarları kosuya **miras alınmaz**
(`--ignore-user-config --ignore-rules`).

**7. Cihaz sözlüğüne `windows` eklendi.** Ajanın `device` etiketi makineyi
anlatır (gateway allowlist'i: `wsl` | `windows` | `m2` | `server`); motor
etikete değil lehçeye bakar, ama yanlış etiket panoyu yalan söyler hale
getirirdi.

## Ölçülen gerçekler (tahmin değil)

Ölçüm ortamı: codex-cli **0.153.4** (kurulu, ChatGPT abonelik girişi var) ve
**0.155.0** (npm), 2026-09-18.

| #   | Ölçüm                                                                                                                          | Karara etkisi                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | `codex exec --json` JSONL akışı: `thread.started` / `turn.started` / `item.completed{agent_message}` / `turn.completed{usage}` | Ayrıştırıcı şeması (`codex-result.ts`) bu şemaya göre yazıldı                                                          |
| 2   | **Başarısız turda exit kodu 0.** `turn.failed` + exit 0 birlikte geldi                                                         | Yalnız exit koduna bakan motor "yapılmamış işi başarılı" sayardı; ayrıştırıcı terminal olayı şart koşar                |
| 3   | stderr gürültüsü (`rmcp::transport::worker …`) stdout akışının arasına düşüyor                                                 | Satır satır ayrıştırma + JSON olmayan satırı atlama; terminal olay yoksa başarısız                                     |
| 4   | Hata metni JSON-içinde-JSON geliyor (`{"error":{"message":"…"}}`)                                                              | `unwrapMessage` insan-okunur sebebi çıkarır; thread'e blok yazılmaz                                                    |
| 5   | **Windows'ta `-s workspace-write` yazmaya izin vermiyor** ("writing is blocked by read-only sandbox"), git deposunda bile      | Windows hattı bugün salt-okur/analiz; yazma işleri WSL'e (gerçek sandbox)                                              |
| 6   | `~/.codex/config.toml`: `sandbox_mode = "danger-full-access"`, `approval_policy = "never"`, model `gpt-5.3-codex-spark`        | İnteraktif ayar miras alınsa koşu ya **güvensiz** ya **kırık** olurdu (o model ChatGPT hesabıyla desteklenmiyor → 400) |
| 7   | Kullanıcının execpolicy kuralları yazmayı "blocked by policy" ile reddetti                                                     | `--ignore-rules`: koşunun sınırını kullanıcının kayan kuralları değil, motorun sandbox modu tanımlar                   |
| 8   | `--system-prompt-file` YOK; prompt stdin'den (`-`) okunuyor                                                                    | Sistem prompt'u görev metnine eklenir (`composePrompt`); kullanıcı metni argv'ye girmez                                |
| 9   | Depo olmayan kökte "Not inside a trusted directory" ile hiç başlamıyor                                                         | `--skip-git-repo-check`; yazma sınırı git'e değil sandbox'a dayanır                                                    |
| 10  | WSL'de `codex` yok (`claude` 2.1.266 var) → exit 127                                                                           | Motor bunu "sonuç bildirmedi" değil, **yapılacak işi söyleyen** mesaja çevirir                                         |
| 11  | `wslpath` çevrimi atlandığında motor 300 ms'de `No such file or directory` ile ölüyor                                          | Ortak yardımcı `engines/wsl-path.ts`; iki motor aynı deseni kullanır                                                   |
| 12  | **Canlı mission koşusu:** Windows hattında `Get-Content …` komutu "blocked by policy" ile reddedildi — **okuma dahil**         | Windows hattı yalnız _metin_ işleri için kullanılabilir; dosya/komut işleri WSL'e aittir. Panel bunu not olarak yazar  |
| 13  | `codex login status` çıktıyı **stderr**'e yazıyor, exit 0                                                                      | Kimlik probu iki akışı da okur (`first_line_any_stream`); yalnız stdout okuyan sürüm panelde kimliği boş gösterdi      |
| 14  | Mission hattı canlı çalıştı: `assign(engine=codex)` → kuyruk → worker → motor → `review`; `23473` giriş / `123` çıkış token    | Hat düzeyinde uçtan uca kapı geçildi; motor seçimi kayda geçti                                                         |

## Alternatifler ve neden değil

**Weave Router 2.0 (veya benzeri bir dış router) araya konması.** Kullanıcı
isteği "aboneliklerimi kullanmak"tı; router bunu **çözemez**: abonelik bir API
kimliği vermez, router her istek için kimlik ister. Weave'in kendi README'si
de bunu doğruluyor — Codex için "Codex'in kendi ChatGPT OAuth girişi korunur"
diyor, yani aboneliği kullanan istemci yine kendi istemcisidir. Buna ek üç
gerekçe: (a) ELv2 "üçüncü taraflara hosted/managed service olarak sunulamaz"
maddesi Faz 2 SaaS ile gerilir, (b) hosted varyant promptları üçüncü tarafa
gönderir, (c) Smith'in kendi rol tabanlı yönlendirmesinin (`packages/llm`)
önüne konması **ikinci bir doğruluk kaynağı** yaratırdı. Router fikri
maliyet optimizasyonu olarak açık kalır; yeri `packages/llm` ve kararı ölçüm
bekler (bkz. `cost-analyst` rolü).

**Windows'ta yazmayı açmak için `danger-full-access` verilmesi.** Ölçüm (5)
sonrası tek teknik yol buydu; kök `AGENTS.md` §2 gereği reddedildi.

**Kimlik dosyasının Windows'tan WSL'e kopyalanması.** Kod kimlik taşımaz
(karar 3); kullanıcı isterse kendi eliyle yapar, motor bunu beklemez.

## Sonuç ve açık işler

**Motor seviyesi kanıt (canlı, 2026-09-18):** Windows hattı gerçek abonelikle
koştu — `ok: true`, `text: "ok"`, `sessionId`, `27689` giriş / `5` çıkış token.
Log: `~/.smith/mission/runs/run_probe_engine_win/engine.log`.

**Hat seviyesi kanıt (canlı, 2026-09-18 · ajan `@vega`, `engine=codex`):**
`assign` → kuyruk → worker (executor açık) → motor → teslim. İki koşu, iki
farklı dürüst sonuç:

| Görev                                 | Motor sonucu                                                      | Mission sonucu                                            |
| ------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| `notlar.md` özeti (dosya okuma ister) | `ok`/exit 0 ama ajan `ENGEL:` bildirdi (politika komutu reddetti) | görev **`blocked`** — yapılmamış iş başarılı gösterilmedi |
| Yalnız metin üretimi                  | `ok`, `23473` giriş / `123` çıkış token                           | görev **`review`**, teslim metni + thread kaydı yazıldı   |

**Kullanıcı eylemi (tek adım):** WSL'de `bun add -g @openai/codex` +
`codex login` → dosya/komut işleri açılır. Panel bunu "yok" satırında zaten
söyler.

**Açık:** Codex motoru maliyet bildirmez (abonelik) — token bildirir; panel
bunu gizlemez. LLM **rol** bazlı kullanım hâlâ ölçülmüyor (chat/summarizer);
yönlendirme kararı ondan önce verilemez. `--ignore-user-config` global
`AGENTS.md` keşfini kaldırmıyor (motorun cevapları kullanıcının sesiyle
karışık geliyor) — ayrı bir başlık olarak not edildi.

**Kayıt yerine eklenmeyenler:** motor registry'sine dinamik kayıt, öncelik,
fallback — üçüncü motor gerçekten çıkana kadar eklenmez (kök `AGENTS.md` §4).

## Referanslar

- `apps/worker/src/engines/{engine-result,index,codex,codex-result,executor,wsl-path,run-dir}.ts`
- `packages/mission/src/engines.ts` (kanonik motor listesi), `repo.ts` (`assignTask`, `summarizeRunUsage`)
- `apps/desktop/src-tauri/src/dashboard.rs` (motor nöbeti — `dashboard_engines`)
- ADR 0003 (cihaz yetkisi), ADR 0007 §4 (ikinci motor öngörüsü), ADR 0008
