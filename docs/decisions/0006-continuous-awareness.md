# ADR 0006 — Sürekli farkındalık katmanı (continuous awareness)

**Tarih:** 2026-08-14
**Durum:** Kabul edildi — üç tarayıcı + iki zamanlanmış görev kuruldu ve canlı doğrulandı.

## Bağlam

Kullanıcı mandası (birebir): _"Sürekli izlediğin ve kendini geliştirdiğin
bilgiler var ya, Smith onları da sürekli kontrol ediyor olsun. Sürekli her şeyi
görüyor olsun. Kurulu olduğu bilgisayardaki durumu biliyor olsun. Dosya
sisteminin röntgenini bilsin sürekli."_

Mevcut durum bu mandatı üç yerden karşılamıyordu:

- **ADR 0004 beslemesi TEK SEFERLİKTİ.** `ingest-all.ps1` 77 repo ve Obsidian
  notlarını bir kez doldurur; DB'den exclude listesi üretip _eksikleri
  tamamlar_. Zamanla tazelenen bir şey yok — Smith'in dünya modeli yazıldığı
  güne çakılı kalıyor.
  (DÜZELTME 2026-08-16: bu satır "1004 not" diyordu, üç yerden yanlış. (a) 1004
  bir ara sayımdır: aynı gün yazılan ADR 0004 §8 veritabanından **1016** saydı,
  vault'lardaki gerçek dosya sayısı bugün **1017** `.md`
  (`ObsidianVaults`: client-project 870, projectx 119, github-backup 14, personal 14).
  (b) Sayının cümledeki işi de yanlış: `ingest-all.ps1`'in varsayılanı
  `[int]$ObsidianMax = 300` (`ingest-all.ps1:26`), yani tek koşu vault'u
  **dolduramaz** — bu tek-seferliliğin yanına eklenmesi gereken ikinci kusurdur,
  ve `--exclude-file` mekanizması tam bu yüzden var. **77 repo doğru.**)
- **`sistem_durumu` aracı ANLIK sorgu yapıyor.** "Şu an CPU %23" doğru cevap
  ama bağlamsız: Smith "bu makinede RTX 5060 var", "C: sürücüsü kritik dolu",
  "postgres 5433'te koşuyor" gibi **kalıcı** bilgiyi bilerek konuşamıyordu.
- **Dosya sistemi topografyası hiç yoktu.** `code_connector` git _repolarını_
  biliyor (dil, commit, README) ama "Downloads'ta ne var", "disk neyle dolu",
  "dün ne değişti" sorularının kaynağı yoktu.
- **İstihbarat hafızanın dışındaydı.** Proaktif istihbarat mandatı brifleri
  dosyaya yazıyordu; Smith'in kendi hafızasında değildi.

## Karar

Hafıza altyapısına dokunmadan (pgvector + `/v1/tools/memory/*` aynen kalır),
**periyodik tazeleyen üç tarayıcı** eklendi. Bu bir zekâ değil **tazelik**
problemidir; ADR 0004'ün besleme deseni korunur, üzerine _delta_ eklenir.

| Tarayıcı               | Dosya                                             | Kayıt                                    | Sıklık       |
| ---------------------- | ------------------------------------------------- | ---------------------------------------- | ------------ |
| Dosya sistemi röntgeni | `apps/desktop/sidecar/fs_xray_connector.py`       | kök başına 1 (`fs:<kök>`, 5 kök)         | saatlik      |
| Makine durumu          | `apps/desktop/sidecar/machine_state_connector.py` | 3 (`machine:donanim`/`disk`/`servisler`) | saatlik      |
| Dış istihbarat         | `apps/desktop/sidecar/intel_connector.py`         | günde 1 (`intel:YYYY-MM-DD`)             | günlük 09:20 |

Orkestrasyon `scripts/awareness-scan.ps1`, kurulum `scripts/awareness-install-task.ps1`
(`SmithAwareness` saatlik + `SmithAwarenessIntel` günlük).

### 1. Kota kırmızı çizgisi: delta zorunlu

Bu katmanın **var olma koşulu** budur. Gateway her `/remember` POST'unda
yeniden embedding üretir; embed ucu free-tier'da dakikalık VE günlük limitli ve
bu limit daha önce canlı hafızayı kırdı (ADR 0004: 804 not ertelendi). Saatlik
koşan naif bir tarayıcı bunu kesin olarak tekrar eder.

İki savunma katmanı:

1. **Kayıt sayısı sabit.** Dosya başına kayıt YOK; ağaç başına 1, makine için 3,
   istihbarat için günde 1. Koşu başına üst sınır 9 kayıt.
2. **Delta kapısı.** Her tarayıcı kendi yapısal _snapshot_'ını
   `<veri kökü>\awareness\*.json`'a yazar (veri kökü: `SMITH_DATA_DIR` ya da
   `%USERPROFILE%\.smith`). Yeni koşu ÖNCE kaydedilmiş
   snapshot'la karşılaştırır; **eşitse POST hiç denenmez → 0 embed.**

Delta kapısının tasarımında üç ölçülmüş tuzak var, üçü de kotayı sessizce
yakıyordu:

- **"Değişiklik yok" cümlesi bile üretilmez.** Üretilseydi içerik ilk
  koşudan farklı olur ve her koşu bir embed yakardı.
- **Snapshot KASTEN kabadır.** Dizin boyutları 10 MB, toplam 100 MB kovasına
  yuvarlanır; dosya tarihleri gün granülerliğindedir. Bir log satırının
  büyümesi değil, ağacın gerçekten değişmesi embed harcar.
- **Oynak alanlar snapshot'a hiç girmez.** CPU/RAM/VRAM kullanımı, uptime
  _süresi_, docker'ın `"Up 7 hours"` metni dışarıda; uptime yerine **açılış
  zamanı** (yeniden başlatmaya kadar sabit) yazılır. Anlık değer
  `sistem_durumu` aracının işidir — onu hafızaya yazmak hem gürültü hem kota.

İki ek normalleştirme, aynı sebeple:

- `fs` karşılaştırması `compare_key()` üzerinden yapılır: "son değişen 10
  dosya" listesi görünümde mtime sırasındadır ama imzada **ada göre sıralanır**.
  Ham sırayı karşılaştırmak, aynı 10 dosyanın yeniden sıralanmasını bile
  değişiklik sayıyordu.
- `intel` imzası yalnız **kimlikleri** taşır (ürün adı / slug / başlık), gösterim
  metnini değil. HN puanları dakikalar içinde değişir (ölçüldü: 482→485→490);
  ham içeriği karşılaştırmak aynı haberler için her koşuda embed yakardı.

Her tarayıcı koşu sonunda `EMBED HARCANAN: n` basar; `awareness-scan.ps1` bunu
toplar. Kota takibi tahmin değil, tarayıcının kendi sayımıdır.

### 2. Gizlilik: kara liste tek kaynaktan ithal edilir

ADR 0004'ün kırmızı çizgisi aynen geçerlidir. `fs_xray_connector`,
`code_connector.BLACKLIST_DIRS` ve `blacklist_reason()`'ı **ithal eder,
kopyalamaz** — gizlilik listesinde ayrışma sızıntı demektir.

Ek olarak bu tarayıcı **salt-metaveridir**: hiçbir dosyanın _içeriği_ okunmaz,
yalnız ad/boyut/tarih. Gizlilik yüzeyi kasten küçük tutulur; içerik hasadı
`code_connector`'ın git-takipli ve kara-listeli yolundan geçmeye devam eder.

Reddedilen yollar **loglanır** — "prune ettim" iddiası değil görünür kanıt. WSL
tarafında `find` prune dalına ayrı bir `-printf "P\t%P\n"` eklendi; çıplak
`-prune` sessizdir ve o zaman `customers/` ile `db-dumps/`'ın taranmadığı
kanıtlanamaz.

Kanıt (canlı koşu, `workspace` kökü — yeniden ölçüldü 2026-08-16): `customers`,
`db-dumps`, `docker-data`, `github-backup` kökte prune edildi; kabul edilen
**51 865** girdinin hiçbiri kara listeye uymuyor (0 ihlal). Reddedilen 984 yolun
dağılımı:

| Sınıf                 | Sayı | Baskın olanlar                                                                     |
| --------------------- | ---- | ---------------------------------------------------------------------------------- |
| Dizin prune (toplam)  | 309  | `__pycache__` 132, `dist` 55, `.git` 39, `node_modules` 34, `.turbo` 26            |
| Dosya deseni (toplam) | 675  | `\.sql$` 519, `^\.env($\|\.)` 112, `\.pem$` 16, `^credentials` 14, `^secrets?\.` 7 |

**DÜZELTME (2026-08-16): "419 `node_modules`/`.git`/`target`/`.venv`" rakamı
yanlıştı ve yanlışlığın yönü öğreticidir.** O dört dizinin gerçek payı **77**
(`.git` 39 + `node_modules` 34 + `target` 2 + `.venv` 2); 419 sayısı dizin
prune'unun tamamına bile denk gelmiyor (toplam 309). Yani belge kara listeyi
**yanlış dizinlerle** övüyordu: gerçek hacmi getirenler hiç anılmayan
`__pycache__` (132), `dist` (55) ve `.turbo` (26). Diğer üç rakam doğrulandı
(`.env*` 112, `.pem` 16, girdi 51 865); ham `.sql` bugün **519** ölçüldü (ilk
koşuda 521 — ağaç bu arada değişti, bu bir sapma değil tazelik).

Ölçüm yöntemi (tekrarlanabilir): `fs_xray_connector.walk_wsl()` doğrudan
çağrılıp dönen `skipped` listesi sebebe göre sayıldı. `--probe --show-skips`
yalnız ilk 12 yolu bastığı için (`fs_xray_connector.py:567`) bu dağılım
komutun çıktısından **okunamaz** — bu ADR'deki yanlış rakamın büyük olasılıkla
kaynağı da budur. Kapı: sınıf dağılımı iddia edilecekse listenin tamamı
sayılmalıdır, ekrandaki ilk 12 satır değil.

`intel` kayıtları `public` (halka açık kaynak), `fs` ve `machine` `personal`.

### 3. Uydurma yasak

Bir istihbarat kaynağı 403/ağ hatası verirse **atlanır**, durum loglanır ve
kayıtta "ulaşılamayan kaynaklar" olarak açıkça yazılır. Hiçbir kaynak
çalışmazsa kayıt hiç yazılmaz. Hafıza Smith'in gerçek dünya modelidir, tahmin
deposu değil.

Aynı ilke sıralama iddialarına da uygulanır: PH Atom feed'i oy sayısı vermiyor
ve leaderboard sayfası CAPTCHA arkasında; bu yüzden "en çok oylanan 5" **iddia
edilmez**, o günün ürün listesi + toplam sayı verilir.

## Ölçülmüş tuzaklar

Bunlar tahmin değil, bu iş sırasında canlı olarak kırılıp düzeltilen şeyler.

**1. MSIX `%LOCALAPPDATA%` yönlendirmesi — bu işin en pahalı tuzağı.**
Durum dosyaları ilk sürümde `%LOCALAPPDATA%\smith\awareness`'a yazılıyordu.
MSIX paketli bir uygulamanın (Claude Desktop) içinden yazılan bu yol sessizce
paketin sanal deposuna yönlenir
(`AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\...`).
Zamanlanmış görev aynı yolu okuduğunda dosyayı **görmez**. Belirti tamamen
yanıltıcıydı: `wscript.exe` her tetiklemede `LastTaskResult=1` ile düşüyor ve
hiçbir log üretmiyordu — "VBS bozuk" gibi görünüyor, oysa aynı VBS elle
koşulduğunda sorunsuz çalışıyordu. Fark VBS'te değil **yolun görünürlüğündeydi**.
İki sonucu vardı: (a) görev hiç çalışmıyordu, (b) çalışsaydı bile delta durumunu
boş görüp her koşuda 9 embed yakacaktı — yani kotayı korumak için yazılan
mekanizma tam tersine işleyecekti. **Karar: farkındalık durumu `%USERPROFILE%\.smith\awareness`
altında tutulur; AppData asla kullanılmaz.** Ders: "elle test ettim, çalışıyor"
zamanlanmış görev için KANIT DEĞİLDİR; görevi tetikleyip `LastTaskResult`'a bak.

**Güncelleme (2026-10-03, kural genelleşti):** aynı tuzak Smith'in geri kalan tüm durum
dosyalarında da yaşandı (ses izi kaydı, yedek aynası ayarı, günlükler, oturum sırrı, `smith-up`
kilidi, `health.json` gerçek AppData ile paket kopyasına bölündü). Bu yüzden karar tek veri
köküne genişletildi: **tüm Smith durumu `SMITH_DATA_DIR` ya da `%USERPROFILE%\.smith` altında**
(Rust, Python, PowerShell, Node aynı kural; `awareness\` bu kökün alt dizinidir). Kural
`scripts/check-data-root.mjs` kapısıyla korunur; eski iki konum `scripts/smith-migrate-data.ps1`
ile veri köküne toplanır.

**2. `RepetitionDuration = [TimeSpan]::MaxValue` görevi hiç kurmuyor.**
XML'e `P99999999DT23H59M59S` yazılır, Task Scheduler bunu "aralık dışı" diye
reddeder. Sonsuz tekrarın doğru ifadesi bayrağı **hiç vermemektir** (üretilen
XML'de `<Duration>` alanı oluşmaz = sonsuza kadar tekrarla).

**3. `Register-ScheduledTask` hatası NON-TERMINATING'dir.** İlk sürüm görev
hiç kurulmamışken "kaydedildi" bastı. `-ErrorAction Stop` + kayıttan sonra
`Get-ScheduledTask` ile **doğrulama** eklendi. Kurulum artık yalanlayamaz.

**4. Elevation sınırları.** `-RunLevel Highest` ve `-LogonType S4U` ikisi de
yükseltme ister (S4U denendi: "Erişim engellendi"). Farkındalık taraması
yönetici yetkisi gerektirmediği için `LeastPrivilege` + `InteractiveToken`
seçildi. Bedeli bilinçli kabul edildi: görev yalnız kullanıcı oturum açmışken
koşar — zaten gateway'in ayakta olması gerekiyor.

**5. Pencere gizleme.** `Start-Process -WindowStyle Minimized` yine pencere
çizer. Tek güvenilir yol `WScript.Shell.Run(cmd, 0, False)`. Shim **iki
parçalıdır** (`.cmd` + `.vbs`): yönlendirme ve argümanlar `.cmd` içindedir,
böylece VBS tarafında iç içe tırnak kalmaz — bu makinede kanıtlanmış çalışan
desen (`SmithGithubRunner`) budur.

**6. `nvidia-smi` olmadan GPU bilgisi YANLIŞ.** `Win32_VideoController.AdapterRAM`
32-bit taşması yüzünden 8 GB kartı "4 GB" gösterir (ölçüldü: RTX 5060 → 4 GB;
`nvidia-smi` → 8151 MiB). Yanlış donanım bilgisini hafızaya yazmak hiç
yazmamaktan kötüdür; VRAM `nvidia-smi`'den alınır.

**7. Jina okuyucu vekili biçimi sabitlenmeden kullanılamaz.** `r.jina.ai` aynı
URL için koşudan koşuya iki farklı biçim döndürdü (bir kez markdown link'li,
bir kez düz metin); satır tabanlı parser sessizce boş dönüyordu.
`X-Return-Format: markdown` başlığı şart, ve parser sayfa yerleşimine değil
**kanonik URL şemasına** (`/ai/<slug>/`) tutunur.

**8. PH leaderboard'u CAPTCHA'ya takılır, Atom feed'i takılmaz.** `r.jina.ai`
öneki bile leaderboard'da "Performing security verification" alıyor; buna
karşın `/feed` **doğrudan** açılıyor. Feed sırası bir sıralama değildir ve
istekten isteğe karışır (aynı günün 12 ürünü 3 istekte de aynı küme, her
seferinde farklı sıra) → deterministik sıralama şart.

**9. Semantik geri çağırma içerik metnine bağlıdır.** İlk sürüm kayıtları
"Dosya sistemi röntgeni — `<yol>`" ile başlıyordu ve **kaybediyordu**:
"workspace klasörümde neler var" sorgusu, adında `workspace` geçen GitHub repo
kayıtlarını (0.722) gerçek dizin dökümünün önüne geçiriyordu. Çözüm, kaydın ilk
cümlesini **kullanıcının sorusuyla aynı kelimelerle** yazmak (`Root.question_hint`):
aynı sorgu 0.758 ile birinci sıraya çıktı. Bu, `code_connector`'daki
"sinyalsiz repo gerçek repoyu geçiyor" ölçümünün aynı dersidir — içerik metni
bir sunum detayı değil, geri çağırma kalitesinin kendisidir.

## Sonuçlar

**Kazanılan.** Smith kurulu olduğu makinenin donanımını, disk eğilimini,
ayakta olan servislerini, beş dizin ağacının topografyasını ve günün dış
istihbaratını **bilerek** konuşur; bilgi saatlik tazelenir ve tazeleme
kotayı yalnız gerçek değişiklikte harcar.

**Kabul edilen bedeller.**

- Görev yalnız kullanıcı oturum açmışken koşar (elevation yok → S4U yok).
- Kayıt içeriği şablonu değişirse delta bunu görmez (snapshot yapısaldır,
  metin değil) → şablon değişince `--force` ile bir kez tazelenmelidir.
- `intel` günde bir satır büyür (yılda ~365). Bilinçli: brifin tarih değeri
  var. 90 günden eskisini budamak sonraki iş.
- FS röntgeni derinlik 3'te özetler; daha derin yapı için `code_connector`.

**Açık iş.** Diğer cihazların (m2, server) periyodik taranması
`device_connector` ile mümkün ama bu ADR'de zamanlanmadı; ağ dışı bir cihaz
her koşuda "erişilemedi" yazıp kayıt tazeleyeceği için delta kapısı önce o
duruma göre tasarlanmalı.

## Doğrulama

```
# İlk koşu — 9 kayıt, 9 embed
.\scripts\awareness-scan.ps1        # machine 3 / fs 5 / intel 1

# İkinci koşu, hemen ardından — DELTA KANITI
.\scripts\awareness-scan.ps1        # TOPLAM EMBED HARCANAN: 0

# Zamanlanmış görev üzerinden (gerçek yol)
Start-ScheduledTask -TaskName SmithAwareness
# LastTaskResult: 0, TOPLAM EMBED HARCANAN: 0

# DB
docker exec smith-dev-postgres-1 psql -U smith -d smith -tAc \
  'select "sourceType",count(*) from "Memory" group by 1'
# fs|5  machine|3  intel|1

# Kara liste denetimi
python fs_xray_connector.py --probe --show-skips
```

Semantik geri çağırma (7 sorgu, `/v1/tools/memory/search`): 6'sında farkındalık
kaydı **birinci** sırada döndü — "diskimde ne kadar yer var" → `machine:disk`
(0.674), "workspace klasörümde neler var" → `fs:workspace` (0.758), "bugün
Product Hunt'ta ne çıktı" → `intel` (0.658), "masaüstümde hangi dosyalar var"
→ `fs:desktop` (0.733), "Obsidian kasalarımda kaç not var" →
`fs:obsidian-vaults` (0.653), "dün hangi dosyalar değişti" → `fs:workspace`
(0.692). "hangi servisler çalışıyor" sorgusunda `device:server` (0.686) birinci,
`machine:servisler` (0.674) ikinci geldi — soru gerçekten iki makine için de
geçerli olduğundan bu kusur sayılmadı.
