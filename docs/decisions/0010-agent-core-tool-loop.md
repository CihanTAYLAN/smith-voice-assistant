# ADR 0010 — Ajan çekirdeği: birleşik tool-loop `packages/core` ve dsh'den seçmeli hasat

**Tarih:** 2026-08-17
**Durum:** Kabul edildi — yön kararı (hasat et, rebase etme). Uygulama Faz 2–3 açık iştir; kapanış koşulu her fazın kendi doğrulama kapısıdır.

## Bağlam

AGENTS.md §6 repo haritası `packages/core`'u "**sıradaki — Faz 1 kritik yolu**" diye işaretler: ajan döngüsü + tool registry, yürütme sunucu sandbox + cihaz (`protocol tool_call`). Bu paket bugün **yok** (doğrulandı: `packages/` altında `core` dizini yok). Sonuç, Smith'in iki kopuk yürütme yolu olmasıdır:

- **Metin yolu** (`apps/gateway`, `runChatTurn`): tek-atış. Hafıza sistem prompt'una enjekte edilir, yanıt stream edilir; **araç iterasyonu yoktur.**
- **Ses yolu** ([0009](0009-live-speech-to-speech.md), Gemini Live): gerçek bir tool-calling döngüsü var ama **döngünün sahibi Google'ın sunucu-taraflı function-calling'i**; Smith yalnız şema + `ToolBridge` executor'ı verir.

Protokol bu boşluğu zaten öngörür: `packages/protocol/src/wire.ts` `tool_call`'ı (server→client, `wire.ts:122`, `requiresApproval`) ve `tool_result`'ı (client→server, `wire.ts:79`) **tanımlar** — ama gateway kullanmaz; `tool_result` gelince reddeder (`apps/gateway/src/index.ts:423-430`, `tool_denied`: "Bu sunucu henuz istemci araci desteklemiyor"). Sözleşme hazır, motor yok.

**Dış tetikleyici.** 2026-08 ortasında DeepSeek, `dsh` (DeepSeek Harness) adlı açık kaynak (MIT) bir ajan harness'ı yayımladı: Cordis "her şey plugin" kernel'i üzerine ~55 paket. Windows'a klonlanıp WSL'de çalıştırıldı (`dsh --help`, exit 0; WSL çekirdeğinde landlock hazır — `CONFIG_SECURITY_LANDLOCK=y`), mimarisi haritalandı. Önemli olan: dsh, Smith'in kritik yolundaki parçaları — birleşik ajan döngüsü (`ReactLoopAgent`), tipli tool registry + guard pipeline, subagent seam, schedule/spill/compaction — temiz ve MIT olarak yapmış (dsh'nin landlock sandbox runner'ı ise Smith'in gVisor tasarımına uymaz — bkz. Karar #5). Harness plumbing'i hızla emtialaşıyor.

## Karar

**1. `packages/core` kurulur:** sağlayıcı-nötr, gateway-tarafı birleşik tool-loop. Turn/step modeli; step = bir model çağrısı + çağırdığı araçlar; tool-call yoksa tur biter, varsa devam. Bu, AGENTS.md §6'nın "sıradaki" işaretini gerçekler ve Smith'i döngünün **sahibi** yapar (bugün ses yolunda değil).

**2. dsh'den DESEN hasadı — kod-tabanı devralma (rebase) değil.** Alınacaklar: (a) `ReactLoopAgent` turn/step döngüsü ve stop mantığı; (b) **"model-visible ⟺ logged"** invariant'ı — modele giden her şey oturum kaydından yeniden türetilebilir olmalı; (c) tipli `defineTool` (author şeması → JSON Schema), Smith'te Zod ile; (d) **monotonik guard** — yalnız _deny_ edebilen, hiçbir dinleyici sırasının izni geri açamadığı kapı. Cordis kernel'i benimsenmez (gerekçe aşağıda).

**3. Atıl protokol frame'leri canlanır.** `tool_call`/`tool_result` zaten `wire.ts`'te tanımlı olduğundan bu **`PROTOCOL_VERSION` artırmaz** (AGENTS.md §2 protokol uyumluluğu korunur); yalnız gateway davranışı değişir: `index.ts:423-430` reddi gerçek dispatch + sonuç toplamayla değiştirilir. `requiresApproval` (varsayılan kapalı — `wire.test.ts` kilitliyor) onay yoluna bağlanır.

**4. Guard'a "yalnız geri dönüşü olmayan işi deny et" kuralı gömülür.** Cihaz-tarafı `system_tools.rs`'in `DENIED` listesinin (format/shutdown/`reg delete hklm`…) sunucu-tarafı muadili; monotonik guard bu kuralın tek noktası olur. Dosya silme gibi geri alınabilir işler serbest (mevcut cihaz-tarafı politikayla tutarlı).

**5. Sunucu-tarafı araç yürütme sandbox'a bağlanır (Faz 3) — dsh'den DEĞİL, Smith'in kendi tasarımıyla.** AGENTS.md §2: sunucuda çalışan hiçbir araç sandbox dışında yürütülmez (Faz 1 tek kullanıcı olsa da; tehdit = dış içerikten prompt injection). Smith'in sandbox'ı bilinçli olarak **Docker + gVisor (`runsc`)** = _sandboxed-kernel_ sınıfıdır (`packages/sandbox/src/runtime.ts`, server'te ölçüldü); üretimde _shared-kernel_ (`runc`) `assertRuntimeAllowed` ile reddedilir ve egress zorlaması runner'da değil bir **proxy**'de yaşar (`runner.ts` sözleşmesi).

> **DÜZELTME (uygulama sırasında, `runtime.ts` okunarak):** Bu ADR'nin ilk taslağı Faz 3 için dsh'nin `@deepseek-ai/node-addon-landlock-run` addon'unu "somut Linux runner adayı" diye öneriyordu. **Yanlış.** Landlock _shared-kernel + yalnız-dosya + egress'siz_ bir sınıftır; Smith'in gerektirdiği _sandboxed-kernel_ izolasyonunun **altında** kalır ve `SandboxRunner` (create/exec/destroy konteyner) sözleşmesine oturmaz. **Landlock harvest'i geri çekildi.** Faz 3 = Smith'in kendi `SandboxRunner`'ı (Docker+runsc) + egress proxy'nin uygulanması — bir _sprint_, bir hasat değil. Sandbox katmanında dsh'den alınacak bir şey yoktur; dsh'nin sandbox'ı da (yalnız dosya etkisi, egress yok) Smith'inkinden zayıftır.

## Reddedilen alternatif — dsh'yi temel almak (rebase)

Smith'i dsh plugin'lerine taşımak elendi:

- dsh bir **kodlama harness'ı**: araçları fs/bash/lsp, tek-kullanıcı yerel dev aracı. **Egress kontrolü yok** (sandbox yalnız dosya etkisini yönetir, ağ kapsam dışı), **tenancy yok**, oturum kaydı diskte. Bunlar AGENTS.md §2 kırmızı çizgileriyle (tenant izolasyonu, araç izolasyonu, egress default-deny) doğrudan çelişir.
- Cordis'in "her şey swappable servis" esnekliği, tek fikirli bir ürün için bugün kanıtlanmamış maliyettir. AGENTS.md §4: **ikinci gerçek kullanım çıkmadan generic abstraction kurulmaz.** Plugin kernel satın almak bu kuralın ihlali; `packages/plugin-sdk` zaten "planlı" (§6), bugünün ihtiyacı değil.
- Rebase, protokol-öncelikli tasarımı + RLS omurgayı + opaque-block invariant'ını ([0008](0008-opaque-provider-blocks.md)) kaybettirir — Smith'in farklılaştırıcıları; dsh'de hiçbiri yok.

Kısa: **plumbing emtiadır, hasat edilir; farklılaştırıcı (ses + algı + gizlilik invariant'ları + kişisel-bağlam hafıza + proaktiflik) korunur ve efor oraya kayar.**

## Ne değişmez

- **[0008](0008-opaque-provider-blocks.md) (opaque-block invariant) loop'ta korunur.** Tool-loop çok turlu geçmişi yönetir; her turun sağlayıcıya giden `content`'i düz string kalır, `thinking`/`reasoning` blobu geri beslenmez. 0008 bu baskının "`tool_call`/`tool_result` çoğaldığında" geleceğini zaten yazmıştı — core'un doğrulama kapısına bir opaque-block invariant kontrolü eklenir.
- **AGENTS.md §2 kırmızı çizgileri.** Her `packages/core` kod yolu `Scope` taşır (tenant izolasyonu); sunucu-tarafı araç sandbox dışına çıkmaz (araç izolasyonu); protokol geriye dönük uyumlu kalır (`PROTOCOL_VERSION` artmaz).
- **[0009](0009-live-speech-to-speech.md).** Cihaz-içi Live loop'u (Gemini-owned, `ToolBridge`) yerinde kalır; `packages/core` onun _gateway-tarafı, sağlayıcı-nötr_ muadilidir. İkisi function-calling'i farklı yerde koşturur.

## Açık kalan / doğrulama planı

- **P0 — checkout gerçeği (uygulama öncesi).** Kanonik ağaç **Windows `smith-monorepo`** (`6816300`, origin+1), üstünde büyük commit edilmemiş "mission control" çalışması açık (`apps/desktop/src-tauri/src/mission.rs`, `apps/desktop/src/mission/`, `PLAN.md`…). WSL `~/workspace/smith` (`62dd7dc`) bu HEAD'in **atasıdır** — stale. Faz 2 (TS core) Windows'ta yazıldı. Faz 3 (Docker+gVisor runner) gVisor'lu bir ortam ister (server; WSL değil). İki ağacın reconcile'ı + dirty worktree'nin korunması ön koşuldur; kapsam dışı kullanıcı değişikliğine dokunulmaz (AGENTS.md §4).
- **Faz 2 kapısı:** loop-stop matris testleri (araçsız→bitti / araçlı→devam / iptal / max-token) + gateway'de `tool_call → tool_result` round-trip + opaque-block invariant kontrolü + `pnpm verify` yeşil.
- **Faz 3 kapısı:** Docker + gVisor (`runsc`) ortamında canlı izolasyon testi — sandbox içindeki çekirdeğin host'unki olmadığı + egress'in proxy dışına çıkamadığı gösterilir (server'te gVisor `release-20260803.0` doğrulanmıştı). Bu bir sprint'tir (runner + egress proxy + runtime kaydı), harvest değil.
- **Hasat edilmeyip ertelenen** (bugünün ihtiyacı değil): subagent seam, Code Mode, hooks köprüleri, spill/compaction — kanıtlanmış ihtiyaçta ayrı kararla.

## İlişkiler

| ADR                                    | İlişki                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [0003](0003-personal-first-jarvis.md)  | Faz 1 kritik yolu (core → cihaz filosu → sandbox+egress → proaktiflik); bu ADR onun ilk taşını (core) döşer                         |
| [0008](0008-opaque-provider-blocks.md) | Loop çok turlu geçmişi yönetir; opaque-block invariant'ı orada korunur — 0008'in öngördüğü `tool_call` çoğalması burada gerçekleşir |
| [0009](0009-live-speech-to-speech.md)  | Cihaz-içi Gemini loop'u (`ToolBridge`); `packages/core` gateway-tarafı, sağlayıcı-nötr muadili                                      |
