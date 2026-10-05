# ADR 0004 — Kişisel Bağlam Besleme (Personal Context Ingestion)

Durum: Kabul edildi (2026-08-13) · Bağlam kaynağı: kullanıcı mandası "Smith
cihazlarımdaki bilgileri (dosya sistemi, GitHub, kimlik) bilsin ve bunu bilerek
konuşsun — çok zeki olsun."

Revizyon (2026-08-14): §5'in `googleSearch` kararı ölçümle geçersiz kaldı ve
değiştirildi; §6 faz durumları ile §8 besleme sonucu veritabanından sayılarak
doğrulandı. Kararın kendisi (besleme + hassasiyet) değişmedi.

## 1. Temel kavrayış — yeni beyin değil, besleme

Hafıza altyapısı ZATEN var ve çalışıyor: pgvector (768) + Gemini embedding +
`/v1/tools/memory/*` araçları + Gemini Live function-calling köprüsü. Semantik
arama kanıtlandı (farklı kelimelerle doğru geri çağırma). Dolayısıyla bu iş bir
**zekâ** problemi değil, bir **besleme (ingestion)** problemidir:

```
kaynak → çek → özetle/kırp → embed (Gemini) → Memory tablosuna upsert
                                                (sourceType, sensitivity, sourceId)
```

**DÜZELTME (2026-08-16): "parçala (chunk)" adımı hiçbir konnektörde YOK.** Bu
şema chunk'lamayı planlıyordu; sevk edilen yedi konnektörün hiçbiri metni
parçalamıyor, hepsi **kaynak başına sabit sayıda kayıt** yazıyor ve içeriği
kırpıyor. Kanonik örnek `apps/desktop/sidecar/obsidian_connector.py:154`:
`summary = " ".join(raw.split())[:500]` — yani not başına **1 kayıt**, ilk ~500
karakter. Dosyanın kendi başlığı da bunu itiraf ediyor ("tam chunk'lama F2").
Etkisi ölçülebilir: 500 karakterden sonrası aranabilir değil, uzun bir notun
gövdesi hafızada yok. Şema yukarıda gerçeğe göre düzeltildi; chunk'lama açık iş
kalemi olarak §6'ya taşındı.

Smith zaten her konuşmada `hafizada_ara` çağırdığı için, hafıza dolunca
otomatik "bilerek" konuşur. Yeni kod = konnektörler + tazeleme + hassasiyet.

## 2. Gerçek envanter (2026-08-13, salt-okur keşif)

- **GitHub:** kullanıcının **77 reposu** (çoğu private), `gh` WSL'de
  auth'lu (scope: repo/workflow/read:org). En aktif: sample-app-monorepo, smith-monorepo.
- **Yerel git repoları:** WSL `~/workspace`'te 8 repo; çoğu GitHub'ı yansıtıyor
  (delta = commit'siz yerel değişiklik). `api-server` remote'suz → yalnız yerelde.
  (DÜZELTME 2026-08-16: bu "8" 2026-08-13 keşfinin sayısıdır ve F2 beslemesinden
  önce yazıldı; `code_connector.py`'nin bugün beslediği yerel repo sayısı **39**,
  karşılığı **78 kayıt** — repo başına `:ozet` + `:durum`. Sayım:
  `select count(distinct split_part("sourceId",':',2)) from "Memory" where "sourceType"='code'`.)
- **Obsidian:** 4 vault (github-backup, client-project, projectx, personal) — saf
  markdown, **en yüksek sinyal/gürültü** kaynağı.
- **Cihazlar:** Windows (ana), `ssh m2` (MacBook), `ssh server` (sunucu) — üçü de erişilebilir.
- **KARA LISTE (gizlilik):** veritabani dokumleri ve istemci projelerinin dizinleri
  **gercek musteri verisi** sayilir; Smith'e ASLA beslenmez.

## 3. Hassasiyet katmanı (önce bu — beslemeden önce)

`Memory` satırlarına `sensitivity` alanı: `public | personal | secret`.

- Retrieval sınıfa göre filtrelenir. **Live modunda `secret` ASLA modele
  enjekte edilmez** (Live sesi + bağlamı Google'a gidiyor).
- Konnektör her kaydı sınıflar; müşteri/kimlik/anahtar deseni → `secret` veya hiç yazılmaz.
- `scan-secrets.sh` desenleri besleme hattında da çalışır (anahtar sızdırma engeli).

**DÜZELTME (2026-08-16): "retrieval sınıfa göre filtrelenir" bu ADR yazıldığında
BİR SÖZDÜ, iki recall yolundan biri onu tutmuyordu — bugün gerçek.** Sapma şuydu:
`packages/memory` içindeki `searchMemories` varsayılanı
`['public','personal','secret']`, yani **fail-open**'dı ve
`apps/gateway/src/turn.ts` (sohbet turu recall'i) bu parametreyi hiç
vermiyordu. Live yolu (`apps/gateway/src/routes/tools.ts`) doğru filtreliyordu →
**iki recall yolu sessizce ayrışmıştı** ve sohbet turu gizli kayıtları modele,
dolayısıyla bulut sağlayıcısına enjekte etmeye hazırdı. Zarar görmemenin tek
sebebi veritabanında henüz `secret` kayıt olmamasıydı; yani bu bir tasarım değil
**zamanlama şansıydı** (bugünkü dağılım: `personal` 1173, `public` 42,
`secret` 0).

Düzeltme iki katmanlı (commit `e1596d3`):

1. `turn.ts` artık sınıfı açıkça sınırlıyor.
2. `packages/memory/src/repo.ts` varsayılanı **fail-closed** yapıldı:
   `options.allowedSensitivity ?? ['public', 'personal']` (`repo.ts:101`).
   Gerekçe dosyanın kendi yorumunda: `secret` bir **yazma** sınıfıdır (`remember`
   kabul eder), geri getirmede onu isteyen hiçbir çağıran yok — o yüzden
   unutulan bir parametre artık sızdıramaz, gizliyi görmek isteyen açıkça istemek
   zorunda.

Mekanizma: `packages/memory/src/sensitivity.test.ts`. Ders bu ADR'ye yazılmayı
hak ediyor: **bir gizlilik sözü ancak varsayılanı fail-closed ise sözdür**;
"her çağıran doğru parametreyi verir" bir tavsiyedir, kapı değil.

## 4. Kaynak konnektörleri (öncelik sırası)

| #   | Kaynak                                                         | Meşruiyet                                             | Efor  | Değer                     |
| --- | -------------------------------------------------------------- | ----------------------------------------------------- | ----- | ------------------------- |
| 1   | Obsidian vault'ları                                            | Yerel, meşru                                          | Kolay | Çok yüksek (saf metin)    |
| 2   | GitHub (repo meta + README + diller + son commit)              | `gh`/API, meşru                                       | Kolay | Yüksek (77 repo, kanonik) |
| 3   | Yerel workspace (kod/doküman, node_modules & kara-liste hariç) | Yerel                                                 | Orta  | Yüksek                    |
| 4   | Cihaz envanteri (m2 + server: ne var, ne çalışıyor)            | SSH, kendi cihazı                                     | Orta  | Orta                      |
| 5   | LinkedIn / Instagram kimliği                                   | **Scraping YASAK** → veri dışa-aktarımı / elle profil | Zor   | Düşük-orta                |

**LinkedIn/Instagram:** otomatik kazıma her ikisinin ToS'una aykırı (ban riski).
Meşru yol: kullanıcının kendi **veri dışa-aktarımını** (LinkedIn/Instagram "verini
indir") Smith'e vermesi, veya profilini elle bir nota yazması. Konnektör bu
dışa-aktarım dosyasını işler; canlı siteye hiç dokunmaz.

## 5. İnternet araştırması (ayrı ama ilişkili gap)

Kullanıcı "internet araştırması yok" dedi. Çözüm hafızadan bağımsız: Smith güncel
bilgiyi konuşurken arar. (Faz 1'e dahil.)

**İlk karar (2026-08-13):** Gemini Live'a `googleSearch` yerleşik aracını tanıt
(function-calling ile birlikte) → ek altyapı yok.

**DÜZELTME — ölçüldü ve kapatıldı (2026-08-14).** `googleSearch` ücretsiz
katmanda **yok**. Araç `SMITH_LIVE_SEARCH=1` bayrağı arkasında bekletildi, sonra
sonda çalıştırıldı (`gemini-3.1-flash-live-preview`, WS `setup` çerçevesi, her
varyant 20 sn arayla 3 kez):

| Setup şeması                                      | Sonuç                   |
| ------------------------------------------------- | ----------------------- |
| yalnız `functionDeclarations`                     | KABUL (`setupComplete`) |
| `functionDeclarations` + ayrı `{googleSearch:{}}` | WS **1011**             |
| tek objede ikisi birlikte                         | WS **1011**             |
| yalnız `{googleSearch:{}}`                        | WS **1011**             |

1011'in gövdesi gerekçeyi yazıyor: _"You exceeded your current quota, please
check your plan and billing details"_ → şema hatası **değil**, free-tier'da
bulunmayan bir özellik. Kota tavanı değil **özellik yetkisi** olduğunun kontrolü:
kabul edilen şema aynı dakikada arka arkaya iki kez, üç kez 1011 aldıktan hemen
sonra bir kez daha kabul edildi — tek değişken `googleSearch`. Aynı sınıf:
free-tier'da `pro` modelleri de 429/1011 ile kapalı (bkz. `deep_think` gerekçesi).

**Yeni karar:** arama Smith'in kendi tarafında, cihazda. İki araç
`apps/desktop/src-tauri/src/system_tools.rs` içinde, anahtarsız ve ücretsiz:

| Live aracı       | Uygulama     | Ne yapar                                         |
| ---------------- | ------------ | ------------------------------------------------ |
| `internette_ara` | `web_search` | DuckDuckGo HTML ucu → düz metin                  |
| `web_sayfa_oku`  | `web_read`   | okuma vekili (`r.jina.ai`), 403/JS duvarını aşar |

`SMITH_LIVE_SEARCH` bayrağı kaldırıldı. Ücretli katmana geçilse bile yerleşik
aramayı açmak serbest değil: iki arama yolunun **çakışma** sorusu (model hangisini
seçer, sonuçlar çelişirse ne olur) önce cevaplanmalı.

**Mekanizma — yorum tavsiyedir, test garantidir:** `live.rs` içindeki
`setup_yalniz_kendi_araclarini_tanitir` testi setup çerçevesinde `googleSearch`
görürse kırmızıya döner. Kanıt üretilmeden geri eklenemez.

## 6. Fazlar

Durum etiketleri 2026-08-14'te veritabanından sayılarak doğrulandı (§8).

- **F1 — Hassasiyet + ilk konnektörler — TAMAM:** `Memory.sensitivity` alanı +
  retrieval filtresi; Obsidian + GitHub-meta konnektörleri; internet araması
  Smith'in kendi `internette_ara` / `web_sayfa_oku` araçlarıyla (§5 — yerleşik
  `googleSearch` ölçülüp kapatıldı).
  Çıktı: Smith kullanıcının notlarını ve repolarını biliyor + internete bakabiliyor.
- **F2 — Kod/workspace beslemesi — TAMAM (incremental VE chunk'lama hariç):**
  yerel repo içerikleri (kara-liste + gitignore filtreli),
  `apps/desktop/sidecar/code_connector.py`, 39 repo / 78 kayıt. Çıktı: "X
  projesinde neredeydim" cevaplanır. Dosya değişince yeniden embed
  **yapılmıyor**; bu besleme tek seferliktir ve tazelik F5'e devredildi.
  (DÜZELTME 2026-08-16: F2 "tam chunk'lama" işini de taşıyordu — §1'e bak,
  chunk'lama hiçbir konnektörde yok. Repo başına kayıt sayısı sabit: `:ozet` ve
  `:durum`; dosya düzeyinde parça yok. Bu yüzden F2'nin **TAMAM** etiketi
  yalnızca "repo meta + özet" kapsamı için geçerlidir.)
- **F3 — Cihaz envanteri — TAMAM:** `device_connector.py`, 3 kayıt
  (`device:windows-ana`, `device:m2`, `device:server`).
- **F4 — Dış kimlik — AÇIK:** LinkedIn/Instagram veri dışa-aktarımı işleyici
  (kullanıcı dosyayı verince).
- **F5 — Tazeleme/zamanlama — [ADR 0006](0006-continuous-awareness.md)'ya
  DEVREDİLDİ:** periyodik yeniden tarama + delta kapısı orada kuruldu
  (`fs` / `machine` / `intel` tarayıcıları + zamanlanmış görevler). Kod
  repolarının değişiklik-tetikli yeniden embed'i hâlâ açık.

## 7. Karar

**İlk karar (2026-08-13):** Konnektörler `apps/worker` altında (kuyruk +
zamanlama zaten var), her biri mevcut `upsertMemory`'ye yazar;
`@smith/protocol` ve gateway değişmez. Beslemeden ÖNCE hassasiyet alanı gelir
(yanlış veri buluta gitmesin). LinkedIn/Instagram yalnız kullanıcı veri
dışa-aktarımıyla — scraping yok.

**DÜZELTME — yerleşim ve dil değişti (2026-08-16).** Konnektörlerin hiçbiri
`apps/worker` altında değil ve hiçbiri TypeScript değil. Yedisi de **Python** ve
**`apps/desktop/sidecar/`** altında:

| Konnektör                    | ADR   |
| ---------------------------- | ----- |
| `obsidian_connector.py`      | §6 F1 |
| `github_connector.py`        | §6 F1 |
| `code_connector.py`          | §6 F2 |
| `device_connector.py`        | §6 F3 |
| `fs_xray_connector.py`       | 0006  |
| `machine_state_connector.py` | 0006  |
| `intel_connector.py`         | 0006  |

`upsertMemory`'yi doğrudan çağırmıyorlar; **gateway'in HTTP ucuna POST ediyorlar**
(`/v1/tools/memory/remember`, kendi token'ıyla). Kararın özü korundu — kuyruk
yerine zamanlanmış görev, kütüphane çağrısı yerine HTTP — ve iki sonucu var:
(a) tenancy/RLS ve embedding tek yerde, gateway'de kalıyor; (b) her POST bir
embed harcadığı için kota kapısı konnektörün kendi işi oldu (ADR 0006 §1 delta
kapısı bu yüzden var). Orkestrasyon `scripts/ingest-all.ps1` ve
`scripts/awareness-scan.ps1`.

## 8. Besleme sonucu (2026-08-14, veritabanından sayıldı)

```sql
select "sourceType", count(*) from "Memory" group by 1 order by 2 desc;
```

Sayım **2026-08-16'da yeniden koşturuldu**; büyüyen iki satır güncellendi
(`note` 20 → 31, `intel` 1 → 2, toplam 1203 → 1215). Diğer satırlar değişmedi.

| `sourceType` | Kayıt    | Kaynak                                 |
| ------------ | -------- | -------------------------------------- |
| `obsidian`   | 1016     | F1 — `obsidian_connector.py`           |
| `code`       | 78       | F2 — `code_connector.py` (39 repo × 2) |
| `github`     | 77       | F1 — `github_connector.py` (repo meta) |
| `note`       | 31       | elle yazılan çekirdek + sesli kayıtlar |
| `fs`         | 5        | ADR 0006 — dosya sistemi röntgeni      |
| `machine`    | 3        | ADR 0006 — makine durumu               |
| `device`     | 3        | F3 — `device_connector.py`             |
| `intel`      | 2        | ADR 0006 — dış istihbarat              |
| **toplam**   | **1215** |                                        |

Hassasiyet dağılımı (aynı koşu): `personal` 1173, `public` 42, `secret` **0** —
§3'teki fail-closed düzeltmesinin neden "zamanlama şansı" olduğunun sayısı budur.

**Embed kotası — ertelenen 804 not kapandı.** Free-tier embedding ucu hem
dakikalık hem günlük limitli; 1004 Obsidian notunu tek koşuda embed'lemek günlük
kotayı tükettiği için besleme 200 notta durdurulup **804 not ertelenmişti**.
Kalan notlar sonraki günlerde tamamlandı; bugünkü sayım 1016. Bu kısıt ADR
0006'nın delta kapısının var olma nedenidir — saatlik koşan naif bir tarayıcı
aynı duvara çarpar.

**Yetim kayıt temizliği.** `code_connector.py` kara listesine `worktrees` girmeden
önce yazılmış 4 kayıt silindi:
`code:earlier-project/.claude/worktrees/quirky-shannon-424e33:{ozet,durum}` ve
`…/wonderful-wozniak-0a9c37:{ozet,durum}`. Bu dizinler diskte hâlâ duruyor ama
`.git` dosyaları macOS yolunu (`/Users/alice/…`) işaret ediyor →
`git worktree list` ikisini de **prunable** sayıyor, dizin içinde her git komutu
`fatal: not a git repository` veriyor. Kayıtlar bu yüzden bilgi taşımıyordu
("aktif branch ?", "toplam ? commit", "takipli dosya: 0") ve README özetini ana
`code:earlier-project:ozet` kaydıyla yarışacak şekilde kopyalıyordu — kara listenin
`worktrees` girdisinin gerekçesi tam olarak bu. Kara liste bugün aynı yolu
reddediyor: `python code_connector.py --audit-blacklist` →
`RED (kara liste dizini: worktrees)`.
