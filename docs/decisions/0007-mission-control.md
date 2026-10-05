# ADR 0007 — Mission Control: ekip, gorev panosu ve is gucu

**Tarih:** 2026-08-14
**Durum:** Kabul edildi ve uygulandi. Sunucu tarafi (2026-08-14), pano penceresi
(2026-08-17), sesli araclar + ekip yonetimi (2026-08-21). Kalan tek yapisal
eksik is gucunun KIMLIGI (`claude setup-token`, kullanici eylemi) ve iki yolun
canli kaniti — bkz. "Kalan is".

## Baglam

Kullanici mandasi: OpenClaw ekosisteminde dolasan "Mission Control" panolarinin
(orgun sema + kanban + ajan thread'leri + heartbeat) yaptigini **ve daha
fazlasini** Smith'e kazandirmak.

Incelenen ornekler (JARVIS-Mission-Control-OpenClaw, MissionDeck, arsivlenmis
openclaw-mission-control) ortak bir sey yapiyor: **ajan runtime'i yazmiyorlar.**
Is gucu zaten kurulu olan headless ajan CLI'lari; pano yalniz koordinasyon
katmani. Durum git'te JSON dosyalari, kimlik SOUL.md, iletisim `@mention`,
tetikleme 2-5 dakikalik heartbeat.

Smith'in durumu bundan farkli: gateway, protokol, RLS'li Postgres, pgvector
hafiza (hassasiyet sinifli), Live speech-to-speech, ekran algisi, sistem
araclari, saatlik farkindalik tarayicilari, BullMQ + worker, cihaz filosu
(windows/m2/server) VAR. Olmayan tek sey `packages/core` tool-loop'u — yani
Smith'in kendi ajan yurutme motoru.

## Karar

### 1. Pano DB'de yasar, dosyada degil

Bes tablo (`Agent`, `Task`, `TaskComment`, `TaskEvent`, `AgentRun`) tenant
verisidir: `workspaceId NOT NULL` + RLS + `smith_app` yetkileri. Ornekler
git-versiyonlu JSON kullaniyor; Smith'te kirmizi cizgi RLS oldugu icin bu yol
kapali. Kazanc yalniz uyum degil: gorev/kosu/maliyet iliskisel sorgulanabilir.

`TaskEvent` **append-only**: `smith_app` rolune UPDATE/DELETE verilmedi. Akis
bir kayittir; gecmisi degistirme yolu kodda degil **veritabaninda** yok.

### 2. Durum makinesi tek yerde, uc yazar icin

Pano uc yerden yazilir: UI, Smith'in sesli araci, executor. Gecis kurali
`packages/mission/src/status.ts`'te tanimli ve repo katmani onu zorlar. Iki
kasitli kisit:

- `in_progress → done` YOK. Teslim daima `review`'dan gecer; **ajanin kendi
  isini "tamam" ilan etmesi bu sistemin en pahali hatasi olurdu.**
- `inbox → in_progress` YOK. Is ancak sahibi varken baslar.

Revizyon ve yeniden acma atamayla yapilir: `review` ve `done` gorevleri
`assigned` durumuna alinir ve yeni kosu yaratilir; sahipsiz geri alma yolunda
`inbox` kullanilir, cunku `/status` `assigned` ve `in_progress` hedeflerini
reddeder. Boylece sahip temizleme ve calisma baslatma ayrimi korunur.

### 3. Tek HTTP yuzeyi: `/v1/mission/*`

Pano penceresi ve sesli araclar **ayni** ucleri cagirir. Hafizada oldugu gibi
ayri bir `/v1/tools/mission/*` yuzeyi acilmadi — iki yuzey iki dogruluk kaynagi
demektir ve zamanla ayrisir. `POST /tasks` gorev yaratir **ve** istege bagli
olarak ayni cagrida atar; "bunu Nova'ya ver" tek istektir. `via: "voice"`
gonderildiginde `createdBy = "smith"` yazilir, akista "Smith acti" ile "ben
actim" ayrisir. Ajan referansi slug ya da id olabilir: sesli yolda elde daima
slug vardir.

`@smith/protocol` DEGISMEDI. Pano HTTP'den akiyor; WS sozlesmesine yeni frame
eklenmedi.

### 4. Is gucu: headless Claude Code, WSL'de

`packages/core` gelene kadar ajanlara gercek is yaptirmanin yolu makinede
kurulu headless bir ajan CLI'sini kosmaktir — incelenen orneklerin yaptiginin
aynisi, ama cihaz filosuna yayilabilir bicimde. `claude` bu makinede **yalniz
WSL tarafinda** kurulu; worker `wsl.exe -e bash -lc` ile cagirir.

Bunun olculmus bir yan faydasi var: **ajan sonucu gateway'e POST etmez**, worker
stdout'u toplar. WSL'den Windows localhost'a erisimin NAT'ta kapali olmasi bu
hatti hic etkilemez.

`packages/core` geldiginde `apps/worker/src/engines/claude-code.ts`'in yanina
ikinci motor gelir; cagiran (`consumers/agent-run.ts`) degismez. Bugun **tek**
motor var — ikinci gercek kullanim cikmadan motor registry'si kurulmadi.

### 5. Idempotency capasi veritabaninda

Atama, ayni scoped transaction icinde tam bir `AgentRun` satiri (`queued`)
yaratir ve kuyruga atilan isin `jobId`'si o satirin id'sidir. Consumer satiri
`queued`→`running` olarak **WHERE kosuluyla** ustlenir; ustlenemezse hicbir sey
yapmaz. Neden iki katman: kuyruk kaydi `removeOnComplete` ile temizlenir, satir
kalir. Bu is **para harciyor**; cift tetikleme ikinci kez faturalanmamali.

Ayni sebeple `AGENT_RUN` kuyrugunun preset'i `attempts: 1`. Yarida kalan bir
kosu dosya yazmis olabilir; otomatik tekrar hem ikinci kez odeme hem yarim isin
uzerine yazmaktir. Yeniden deneme karari panodan, insan tarafindan verilir.

Yeniden atama, o goreve ait **bekleyen** (`queued`) kosulari iptal eder ve atama
surer. Aksi halde eski ajanin kuyrukta duran isi tutup calisir ve gorev,
atandigi kisiden baskasi tarafindan yapilir. **Calisan** (`running`) kosu varken
atama `active_run` ile reddedilir (409): motor disaridan nazikce durdurulamaz,
ikinci kosu ayni dosyalara yazardi. Kosu bitince ya da worker durmussa lease
dolup sahipsiz kosu sonlandirilinca (en gec birkac dakika) yeniden atanir.

### 6. Guvenlik: cihaz-tarafi yurutme, ama sinirsiz degil

ADR 0003'e gore cihaz-tarafi araclar cihaz sahibinin yetkisiyle kosar; sandbox
sinifi izolasyon aranmaz. Yine de kapilar mekanizmadir, talimat degil:

1. `--add-dir` yalniz ajanin `workRoots` kokleri; liste bossa dosya izni yok.
   Bu kapi YALNIZ DOSYA ARACLARI (Read, Edit, Write) icindir: adsiz `Bash` izni
   yol siniri olmadan kosar ve `cd ~` ile kapiyi asar. Bash'i sinirlamak icin
   `allowedTools` icinde desen kullanilir (or. `Bash(git:*)`); desensiz Bash
   cihaz sahibinin yetkisiyle kosar (ADR 0003), bilincli kabul edilmis bir
   sinirdir, kapi iddiasi degil.
2. `--permission-mode` **allowlist**'ten gecer (`default|acceptEdits|plan`).
   `bypassPermissions` ve `--dangerously-skip-permissions` hicbir kosulda
   gecilmez — env ile bile acilamaz.
3. Iki katmanli zaman asimi: WSL icinde `timeout`, disarida JS zamanlayici.
   Yalniz JS yeterli degil, cunku `wsl.exe`'yi oldurmek Linux tarafindaki
   sureci her zaman oldurmez.
4. Motor `SMITH_MISSION_EXECUTOR=1` olmadan hic cagrilmaz; kapaliyken kosu
   `cancelled` yazilir ve thread'e sebep dusulur — yapilmamis is yapilmis
   gosterilmez.
5. Prompt'lar **dosyadan** gecer (`--system-prompt-file`, stdin). Komut
   satirinda serbest kullanici metni tasinmaz; shell enjeksiyonu yuzeyi yok.

SOUL metnindeki "sinirlarin disina cikma" cumleleri bir guvenlik kapisi
DEGILDIR, niyet bildirimidir. Kapi CLI bayraklaridir.

## Ornekten ayrildigimiz yerler ("daha fazlasi")

| Ornek                                           | Smith                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| Panoyu yazarak surersin                         | Sesle DE surulur: bes Live araci (\*)                            |
| Tek makine                                      | Ajan `device` tasir (wsl / m2 / server)                          |
| Ajan hafizasi yok                               | Ajanlar Smith'in pgvector hafizasini `secret` kapisiyla paylasir |
| Maliyet, Claude klasoru kazinarak tahmin edilir | `AgentRun` motorun bildirdigi maliyeti ve token'i tutar          |
| Heartbeat ile ajan is ceker (2-5 dk gecikme)    | Atama aninda kuyruk tetikler (gecikme yok)                       |
| Durum JSON dosyalarinda                         | RLS'li Postgres, append-only akis                                |

**(\*) BU SATIR BIR SURE YANLISTI — ders kayitta kalsin (2026-08-16 → 2026-08-21).**

2026-08-21'de kapandi: `gorev_ver`, `pano_durumu`, `gorev_durum`, `yorum_ekle`,
`ekip_listesi` bildirime ve dispatch'e girdi (asagi bkz.). Asagidaki tespit o
tarihte GECERLIYDI ve neden yazildigi onemli: belge, olculmemis bir hedefi
gerceklesmis gibi anlatiyordu.

Ilk satir
"`/v1/mission/*` Live araclarindan cagrilir" diyordu; bu bir HEDEFTI ve
gerceklesmis gibi yazilmisti. Bugunku olcum:

- `audio/live.rs`'in `functionDeclarations` blogunda **13 arac** var ve
  **hicbiri mission araci degil** (`gorev_ver`, `pano_durumu`, `gorev_durum`,
  `yorum_ekle`, `ekip_listesi` yok).
- `/v1/mission` deseni repoda yalniz **iki** yerde geciyor ve ikisi de sunucu
  tarafi: `apps/gateway/src/index.ts:164` (mount) ve
  `apps/gateway/src/routes/mission.ts:31` (yorum). **Hicbir istemci — ne
  masaustu, ne CLI, ne pano — bu ucleri cagirmiyor.**

Yani 3. karar maddesinin "tek HTTP yuzeyi" karari gecerli ve dogru kuruldu; eksik olan
**cagiran**. Bu zaten "Kalan is" #2 (pano penceresi) ve #3 (sesli arac
tanimlari) olarak listeliydi — tablo ile kalan-is listesi celisiyordu ve tablo
kazanmis gibi okunuyordu. **DEVAM EDEN IS olarak isaretlenir**:
`packages/mission` sunucu tarafi kuruldu ve testli, sesli ve gorsel surucusu
yazilmadi.

## Olculmus tuzaklar

**1. Prisma her yeni migration'in basina `DROP INDEX "Memory_embedding_hnsw_idx"`
koyuyor.** HNSW indeksi elle yazilmis bir migration'dan gelir (pgvector operator
class'i semada ifade edilemez), Prisma onu "fazlalik" sanir. Kosmasina izin
verilseydi semantik arama sessizce kesin taramaya duser, **hicbir test kirmizi
olmazdi**. Bu satir uretilen her migration'dan silinmelidir.

**2. `Memory.sensitivity` kolonu migration'siz eklenmisti.** Sema ile migration
gecmisi ayrismis, Prisma "drift" gorup `migrate reset` istiyordu — yani embed
kotasiyla doldurulmus 1203 hafiza kaydi silinecekti. Cozum reset degil, eksik
migration'i geriye donuk yazip mevcut DB icin `migrate resolve --applied`
isaretlemek oldu. **Ders: `migrate dev` reset teklif ettiginde once neden drift
oldugunu sor.**

**3. Motor hata verirken `subtype` hala "success" yaziyor.** Asil mesaj `result`
alanindadir (`"Not logged in · Please run /login"`). Ilk surum `subtype`
okudugu icin panoya "Kosu tamamlanamadi: success" gibi teshis edilemez bir
sebep dusuyordu. Teshis edilemeyen hata, hatanin kendisinden kotudur.

**4. `bash -lc` sart.** `claude` `~/.local/bin` altinda; non-login kabukta PATH
bos kalir. `wsl.exe` ciktisi ayrica UTF-16LE'dir → `WSL_UTF8=1` verilmeli.

**5. Windows→WSL yol donusumu tahminle yapilmaz** — `wslpath -a` cagrilir.

**6. Kosu dosyalari veri kokunde (`<veri koku>\mission\runs`) tutulur; kok
`SMITH_DATA_DIR` ya da `%USERPROFILE%\.smith`, `%LOCALAPPDATA%` altinda DEGIL**
(ADR 0006'nin MSIX sanal depo tuzagi; 2026-10-03'te tum Smith durumu icin tek kok).

## Dogrulama

```
pnpm verify                                  # 60/60 gorev yesil (26 mission testi)
prisma migrate deploy                        # 2 migration; HNSW indeksi ayakta (dogrulandi)
```

RLS kaniti (smith_app rolu, canli DB):

```
yabanci workspace gorur: 0     dogru workspace gorur: 1     kapsamsiz gorur: 0
```

Uctan uca (gateway :4101 + worker, `SMITH_MISSION_EXECUTOR=1`):

- `POST /v1/mission/agents` → @nova kuruldu (device wsl, workRoots 1, allowedTools 3)
- `POST /v1/mission/tasks {assignee:"nova", via:"voice"}` → gorev `assigned`,
  `createdBy=smith`, kosu kuyruga dustu
- worker kosuyu ustlendi → gorev `in_progress`, ajan `working`, thread'e `claim`
- motor WSL'de kostu: dosyalar yazildi, `wslpath` cevirdi, bayraklar gecti,
  `timeout` sarmaladi, JSON ayristirildi
- **Motor kimlik dogrulamasi yok** (`Not logged in`): kosu `failed`, gorev
  `blocked`, sebep thread'e gercek metniyle yazildi
- `POST /tasks/:id/status {done}` (inbox'tan) → **409** + izin verilen gecisler
- yeniden atama → yeni kosu, onceki bekleyen kosu iptal

## Pano penceresi — 2026-08-17'de kuruldu

Kalan is #2 kapandi. Yapilanlar ve kararlari:

- **Ayri pencere** (`src-tauri/src/mission.rs`, etiket `mission`, 1280x820,
  cercevesiz). Pet penceresine kanban sigmaz ve pet'in seffafligi calisma
  aninda acilamaz (conf'ta sabit) — ayni pencereyi iki mod arasinda gezdirmek
  mumkun degildi.
- **Ayri frontend girisi** (`mission.html` + Vite cok sayfali derleme). Pet'in
  CSS'inin en kritik kurali "zemin YOK"; panonun opak yerlesimiyle ayni belgede
  bulussalar biri gorunmez olurdu. Uretim derlemesinde `dist/mission.html`
  kendi bundle'iyla uretilir (dogrulandi) — giris silinirse belirti "paketli
  uygulamada bos pencere" olur.
- **Kimlik webview'e girmez.** Pano `mission_call` komutuyla Rust'a soyler,
  token'i `GatewayClient` ekler. Kapi `/v1/mission/*` on ekiyle sinirli, metod
  allowlist'li ve `..` / `//` iceren yollari reddeder; 4 test bunu kanitlar
  (auth, hafiza ve sistem uclari panodan ERISILEMEZ). Kapi bir yorum degil.
- **Gateway istemcisi ortaklastirildi**: HTTP + token onbellegi
  `audio::live::ToolBridge` icinden `crate::gateway`'e tasindi (ikinci gercek
  kullanim). Iki kopya token onbellegi zamanla ayrisirdi.
- **Gecis tablosu panoda kopyalanmadi**: `/v1/mission/board` yanitina eklendi,
  pano yalniz sunucunun kabul ettigi gecisleri dugme olarak gosterir.
  **Surukle-birak KASTEN yok**: `in_progress → done` yasak oldugu icin her
  kolona birakmak, kullaniciya reddedilecek hareketi onermek olurdu.
- **Yerlesim mantigi React'ten ayri ve testli** (`src/mission/layout.ts`): org
  agaci dongude sonsuza gidebilir, kolon gruplama bilinmeyen bir durumu yutup
  gorevi panodan KAYBEDEBILIRDI. Ikisi de gorsel olarak "calisiyor" gorunur;
  bu yuzden test edilir (bilinmeyen durum `blocked` kolonunda gosterilir).
- `SMITH_MISSION_OPEN=1` panoyu acilista acar (varsayilan kapali).

Dogrulama: `pnpm verify` 60/60, `cargo test --lib` 177/177, pencere gercekten
acildi (`EnumWindows` → "Smith — Mission Control", 1296x829), `/v1/mission/board`
`transitions` ile birlikte dondu, canli sayfanin DOM'u alti kolonu ve org
bos-durumunu gosterdi. **Ekran goruntusu ALINAMADI**: `PrintWindow` WebView2
icerigini bos dondurur (GPU kompozisyonu) ve ekran kopyalama yolu onde duran
uygulamayi yakalar — kanit metinsel.

## 2026-08-21 — sesli surus, ekip yonetimi ve gorunmez bir kuyruk arizasi

Uc kalan is kapandi, bir de listede OLMAYAN ariza bulundu.

**Pano artik sesle surulur.** Bes arac (`gorev_ver`, `pano_durumu`,
`gorev_durum`, `yorum_ekle`, `ekip_listesi`) `audio/live.rs`'e eklendi ve hepsi
ayni `/v1/mission/*` uclarina gider. Kapisi yeni bir liste: `OWNER_ONLY_MISSION`
— **okumalar dahil**, cunku atama para harcar ve "panoda ne var" cevabi Cihan'in
is listesidir. `speaker.rs`'in kendi notu "dorduncu liste gelirse bu uc `if`i
tabloya cevir" diyordu; geldi, cevrildi (`OWNER_ONLY_POLICIES`) ve iki test artik
o tablodan besleniyor. Modelin verdigi gorev kimligi bir URL yoluna girdigi icin
`gorev_id_gecerli` ile dogrulanir — pano penceresindeki `mission::gate`in sesli
yoldaki esi.

**Panodan ekip kurulur.** Ajan yaratma formu, SOUL duzenleme, devre disi birakma
(`status=offline`) ve silme. Silme KOSULLU ve kural SUNUCUDA: `AgentRun.agentId`
CASCADE oldugu icin calismis bir ajani silmek maliyet kaydini da silerdi →
`deleteAgentIfUnused` kosu varsa 409 doner ve devre disi birakmayi onerir.

**LISTEDE OLMAYAN ARIZA: kuyrugun tuketicisi yoktu.** Windows tarafinda worker'i
baslatan hicbir script yoktu; eski betik yalnız WSL klonu içindi. Yani panodan
atanan gorev kuyruga dusuyor, kimse tuketmiyor ve kosu sonsuza kadar `queued`
kaliyordu: pano "atandi" der, hicbir sey olmaz, HATA DA YOKTUR. En kotu ariza
sinifi. `scripts/worker-dev.ps1` yazildi (gateway ile ayni env kaynagi +
`SMITH_MISSION_EXECUTOR` varsayilan kapali) ve kanit alindi: ayni atama artik 6
saniyede tuketiliyor, kosu `cancelled` yaziliyor, thread'e sebep dusuyor.

**Yan urun (ADR 0007 disi ama ayni oturumda olculdu):** `P2028 - Unable to start
a transaction` hatasinin sebebi transaction katmani DEGILDI. `pg` havuzu
varsayilanlarla kuruluydu; `connectionTimeoutMillis: 0` yuzunden soguk bir
baglanti **641 saniye** askida kaldi (olculdu) ve Prisma'nin 2 sn'lik `maxWait`i
gercek sebebi ortuyordu. Sureler acik yazildi: baglanti 5 sn'de "connection
timeout" der, `maxWait` (8 sn) ondan buyuk. Kok neden makine seviyesindeydi
(WSL2 servisi dustu, Docker Desktop onun ustunde kosuyor) — bu duzeltme arizayi
onlemez, TESHIS EDILEBILIR yapar.

## Kalan is

1. **Motorun kimligi.** WSL'de bir kez `claude setup-token` (veya `/login`)
   gerekiyor; bu kullanici eylemidir, otomatiklestirilmez. `SMITH_CODE_AGENT` ve
   Mission Control is gucu AYNI engelde bekliyor.
2. **Canli kanit borcu:** sesli turun tamami (mikrofon → model → arac) ve ajan
   yaratma/silme uclarinin HTTP dogrulamasi yapilamadi; WSL2/Docker dustugu icin
   DB'ye erisilemedi. Kod tarafi yesil (pnpm verify 64/64, cargo 191/191) ama
   bu iki yol SAHADA henuz gorulmedi.
3. F2: heartbeat ozerkligi, `@mention` bildirimi, m2/server'e SSH ile kosu,
   GitHub Issues senkronu, ajan basina maliyet paneli.
