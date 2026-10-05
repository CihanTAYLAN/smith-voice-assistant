# ADR 0002 — Görsel/Durumsal Algı ve Proaktiflik (eski Smith MVP'den hasat)

**Tarih:** 2026-08-11
**Durum:** Hasat edilen iki fikir de **uygulandı** (2026-08-14) — ekran algısı
`audio/screen.rs` + Live `realtimeInput.video`, proaktiflik
[ADR 0005](0005-persona-and-proactivity.md). Mimari plandan farklı ve bir gizlilik
kırmızı çizgisi değişti; son bölüme bak.

## Kaynak

2025-08 tarihli Python "Smith MVP — Durumsal AI Asistanı" (eski
`<owner>/smith` GitHub reposu (onceki prototip)) bugünkü Smith'in kavramsal atasıdır. O kod
silindi/arşivlendi ama **taşıdığı fikir buraya hasat edildi.** Eski MVP'nin
özü:

- **Sürekli ekran algısı:** ~saniyede bir screenshot → vision model ile analiz.
- **Durum analizi (`state_analyzer`):** ekran değişimlerini tespit et → proaktif
  aksiyon öner (kullanıcı sormadan).
- **Modüler input sistemi:** screenshot / voice / text girdileri tek soyutlama
  arkasında (`base_input`).
- Multi-provider LLM (Groq/OpenAI fallback), Qdrant hafıza, Whisper voice.

## Neden önemli (Smith için)

Smith'in ses algı katmanını (ADR 0001) kurduk: mikrofon → olay → LLM. Eski
MVP'nin fikri bunun **görsel muadili**: ekran = ikinci bir algı akışı. İkisi
birleşince Smith "duyan + gören + proaktif" bir asistana yaklaşır — playbook'un
"proaktif" tezinin somut hali.

Smith bu fikirleri 2026-08-11'de aşıyor sayılmazdı; yalnız **ses** tarafını
yapmıştı — görsel algı ve proaktiflik o gün yoktu. (Bugünkü durum: son bölüm.)

## Smith'e nasıl oturur (ilerideki iş, ADR 0001 mimarisiyle uyumlu)

- **Yeni algı kaynağı:** ses `AudioSource` gibi bir `ScreenSource` (Tauri/Rust;
  ekran yakalama + kısma/throttle). Aynı "capture → broadcast → worker" deseni.
- **Vision analizi:** yakalanan kareler bir vision-capable modele (Claude vision
  veya yerel) → yapılandırılmış "ekranda ne var/ne değişti" olayı.
- **Unified event katmanı (ADR 0001 Faz 5):** ses olayları + ekran olayları
  ortak event modeline akar → gateway'e semantic context.
- **Proaktiflik = niyet/önem kapısı:** cihaz-içi kapı (bkz. memory
  `smith-cihaz-ici-niyet-kapisi`) hangi durumun kullanıcıyı rahatsız etmeye
  değecek kadar önemli olduğuna karar verir. Görsel durum bu kapının en güçlü
  tetikleyicisi.

## Kırmızı çizgiler (taşınır)

- **Gizlilik:** ekran görüntüsü ham haliyle diske/buluta yazılmaz; yerel işlenir,
  yalnız semantic olay dışarı çıkar (ADR 0001 gizlilik ilkesiyle aynı).
- **Kaynak:** sürekli screenshot pahalıdır → değişim-tetikli + throttle, ADR 0001
  resource-management ilkesi.

## Karar

Fikir korundu. Uygulama, ses hattı (ADR 0001) olgunlaştıktan ve niyet/önem
kapısı M2'de ölçülüp kurulduktan **sonra** ayrı bir faz olarak ele alınacak.
Eski Python MVP kodu referans olarak gerekli değildir (mimari Rust/Tauri'ye
taşındı); bu ADR yeterli hasattır.

## Durum düzeltmesi — uygulandı, ama plandan farklı (2026-08-14)

Bu ADR "henüz uygulanmadı" diyordu; **artık doğru değil.** İki fikir de canlı:

| ADR 0002'nin planı                                 | Bugünkü gerçek                                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ScreenSource` + "capture → broadcast → worker"    | `apps/desktop/src-tauri/src/audio/screen.rs`; kare doğrudan Live oturumuna basılır, ayrı broadcast/worker yok                                                                         |
| Vision analizi ayrı modelde → yapılandırılmış olay | Kare aynı WS'ten `realtimeInput.video` (`image/jpeg`) ile Live modeline gider; ara olay katmanı yok                                                                                   |
| Unified event katmanı (ADR 0001 Faz 5)             | Kurulmadı — ses ve görüntü zaten aynı Live oturumunda birleşiyor                                                                                                                      |
| Proaktiflik = cihaz-içi niyet/önem kapısı          | [ADR 0005](0005-persona-and-proactivity.md): sistem yönergesindeki davranış sözleşmesi + testler. Niyet kapısı ölçüldü ve kural tabanlı oldu (ADR 0001) ama Live'da bugün bağlı değil |

**Ölçülmüş parametreler** (`screen.rs`): uzun kenar **1920 px** (1280 sahada
yetmedi — küçük arayüz metni okunamıyordu), JPEG kalitesi **85** (70'te harf
kenarları bulaşıyordu), **1 kare / 2 sn** (`SMITH_SCREEN_INTERVAL_MS`, alt sınır
500 ms — `interval_ms()` varsayılanı 2000). Yakalama bloklayıcı (GDI/DXGI) →
`spawn_blocking`; aksi halde tek-thread runtime'da ses akışı tıkırdıyor. Kare
hatası atlanır, oturum düşmez. İstek üzerine tek net kare de var:
`ekrani_net_gor` aracı. Yanıtı araç köprüsünü **atlar**
(görüntü araç yanıtında taşınamıyor, video kanalından gider); bu atlama bir guard
testiyle işaretli — araç konuşmacı politikası listelerine eklenirse test kırmızıya
döner, çünkü o dispatch yolu kapıyı atlıyor.

**DÜZELTME — fonksiyon adı (2026-08-16).** Bu paragraf net kare yolunu
`capture_primary_sharp` diye anıyordu. Üretim yolu
**`capture_sharp_selection(&MonitorSelection)`** (`screen.rs:176`);
`capture_primary_sharp` (`screen.rs:455`) bugün `#[cfg(test)]` ile işaretli, yani
üretimde çağrılmıyor — dosyanın kendi yorumu da bunu söylüyor ("uretimde
cagrilmayan kod olu koddur"). Yanlış ad, bakım yapan birini yalnız-birincil
davranışı olan ölü bir fonksiyona götürüyordu.

**Gizlilik kırmızı çizgisi değişti — kaydı burada.** Bu ADR "ekran yerel işlenir,
yalnız semantic olay dışarı çıkar" diyordu. Bugünkü uygulamada **ham kare buluta
(Google Live'a) gidiyor.** Telafi çizginin kendisi değil kapısı: özellik
**varsayılan KAPALI** ve yalnız bilinçli olarak açılır
(`SMITH_SCREEN`, `env_flag::acik_varsayilan_kapali` — `1/true/yes/on/evet/acik`
kabul edilir, `SMITH_SCREEN=true` artık sessizce yutulmaz), ham kare diske
yazılmaz. "Yalnız semantic olay" hedefi yerel bir vision modeli gerektirir ve
**açık iş kalemidir**.

**DÜZELTME — GİZLİLİK YÜZEYİ SANDIĞIMIZDAN BÜYÜK (2026-08-16).** Yukarıdaki
"yalnız birincil ekran" ve "tek ekran gönderilir (sürpriz gizlilik yüzeyi yok)"
ifadelerinin **ikisi de artık yanlış**, ve bu yanlışlık tam olarak bir gizlilik
kararının dayandığı cümleydi. Çok-monitör desteği geldi; bugünkü gerçek:

| Konu               | Belgenin dediği | `screen.rs`'teki gerçek                                                                |
| ------------------ | --------------- | -------------------------------------------------------------------------------------- |
| Varsayılan seçim   | birincil ekran  | `DEFAULT_SELECTION = MonitorSelection::Active` — **odaklanmış** ekran (birincil değil) |
| Kaç ekran gönderir | her zaman bir   | `SMITH_SCREEN_MONITORS` belirler: `primary` / `active` / `rotate` / `all` / `1,2`      |
| Azami yüzey        | tek ekran       | `all` veya indeks listesi **her seçili monitörün** karesini aynı akışta yollar         |

Sonuçları açıkça yazmak gerekiyor:

- **Varsayılan davranış bile "birincil ekran" değil.** `Active` odaklanmış ekranı
  seçer; iki monitörlü bir masada bu, kullanıcının o an baktığı ekranın —
  hangisi olursa — buluta gitmesi demektir. Boş/tanınmayan girdi de `Active`'e
  düşer (`screen.rs:129`, `:156`).
- **`all` çoklu kare gönderir.** Periyodik akışta `Rotate` bile `All`'a
  eşlenir (`screen.rs:430`), yani "sırayla bir tane" niyeti akış tarafında
  bütün ekranlara dönüşür. Kare başına ~350–500 KB olduğu düşünülürse bu hem
  gizlilik hem kota kalemidir.
- **Kapı hâlâ tek ve doğru yerde:** `SMITH_SCREEN` kapalıysa hiçbir monitör
  gönderilmez. Yani korunan şey "kaç ekran" değil, **özelliğin kendisinin
  varsayılan kapalı olması**. Bu ADR'nin gizlilik telafisi bundan sonra yalnız
  buna dayanmalıdır; "tek ekran" cümlesi bir telafi olarak kullanılamaz.

**İkinci fark:** plan "değişim-tetikli + throttle" diyordu; uygulama sabit
aralıklı throttle. Değişim tespiti yok; kota etkisi bilinçli kabul edildi.
