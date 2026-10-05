# ADR 0005 — Smith'in kişiliği ve proaktiflik sınırı

**Tarih:** 2026-08-14
**Durum:** Kabul edildi — Live sistem yönergesinin davranış sözleşmesini tanımlar, testle bağlanır.

## Bağlam

Kullanıcı mandası: "Spider-Man'in E.D.I.T.H.'i, Iron Man'in JARVIS'i ve
FRIDAY'i gibi." Bu bir üslup ricası değil, bir yetenek tarifi: o asistanlar
(a) sorulmadan da işe yarar, (b) her cümlede izin istemez, (c) sakin ve
kendinden emindir.

Smith bugün işlevsel: **13 araç** (sayım düzeltmesi 2026-08-16: burada 14
yazıyordu; `live.rs`'in `functionDeclarations` bloğunda 13 tanım var —
`hafizada_ara`, `hafizaya_kaydet_ACIK_TALEP_ILE`, `terminal_calistir`,
`uygulama_ac`, `sistem_durumu`, `ses_kontrol`, `ekrani_net_gor`, `dosya_ara`,
`dosya_oku`, `derin_dusun`, `internette_ara`, `web_sayfa_oku`,
`acik_uygulamalar`), tam makine erişimi, sürekli akan ekran karesi
(ADR 0002), Live speech-to-speech hattı. Eksik olan davranıştı. Gözlenen
kusurlar:

- **Yağcılık ve jenerik asistan dili:** "Harika fikir!", "Elbette",
  "Süper" ile başlayan cevaplar.
- **Her cevabı soruyla kapatma:** "Ne yapmamı istersin?" — sesli bir hatta bu,
  her turu kullanıcıya geri iterek konuşmayı iki katına çıkarır.
- **İzin isteme ve ara rapor:** "Bakıyorum", "Yapayım mı?" — araç zaten var,
  cevap sonuçtur.
- **Pasif ekran:** kare akıyor ama model onu bir yetenek olarak kullanmıyor,
  hatta "ekranını göremiyorum" diyebiliyordu.
- **Proaktiflik hiç yok:** ekrandaki kırmızı log kendiliğinden teşhis edilmiyor.

Kritik gerilim şudur: **proaktifliği tek yönlü açmak Smith'i çekilmez yapar.**
Ekran karesi 2 saniyede bir akıyor; "gördüğünde söyle" talimatı frenlenmezse
model her karede yorum yapmaya iter ve sesli asistan gürültüye dönüşür. Yani
proaktiflik bir "aç" kararı değil, bir **eşik + susturma** kararıdır.

İkinci tespit yöntemseldir: **sıfat listesi davranış değiştirmez.** "Sakin,
ölçülü, kendinden emin ol" talimatı modelin aynı turda "Harika fikir!" demesini
engellemiyor — çünkü sıfat model için ölçülebilir bir kısıt değil. Ölçülebilir
olan şey üretilen dizedir.

## Karar

1. **Kişilik, yasak kalıp + zorunlu davranış çiftleriyle yazılır.** Yönergede
   sıfat demeti yok; her kural ya bir dizeyi yasaklar ya bir eylemi zorunlu
   kılar. Yasaklananlar isimleriyle sayılır:
   - _Açılış:_ "Harika fikir", "Harika bir soru", "Süper", "Mükemmel",
     "Kesinlikle", "Elbette", "Tabii ki", "Memnuniyetle", "Ne güzel".
   - _Kapanış:_ "Ne yapmamı istersin", "Başka bir şey var mı", "Nasıl yardımcı
     olabilirim", "Yardımcı olabileceğim başka bir konu var mı".
   - _Ara rapor:_ "Bakıyorum", "Kontrol ediyorum", "Hemen ilgileniyorum".

2. **Soru bir istisnadır, varsayılan değil.** Cevap bilgi verdiyse cümle biter.
   Soru yalnız iki halde sorulur: gerçek bir seçim var ve doğrusunu Smith
   seçemiyor, ya da işlem geri dönüşü olmayan bir şey. Kısalık için var olan
   "anlatayım mı?" bu yasağın dışında bırakıldı — aksi halde mevcut kısalık
   kuralıyla çelişirdi.

3. **İzin isteme iki kademeye ayrıldı: okuma serbest, yazma kısa onay ister.**

   _İlk karar (2026-08-14):_ "İzin isteme **kaldırıldı**, kapsam içi iş doğrudan
   yapılır. Fren zaten yönergede değil kodda: `system_tools` yalnız geri dönüşü
   olmayan işleri reddediyor ve `SpeakerGate` yabancı sesi kapıda tutuyor.
   Yönergenin ayrıca izin istemesi güvenlik katmanı değil, sadece gecikmeydi."

   **DÜZELTME (2026-08-16): sevk edilen yönerge bunu YAPMIYOR ve bu maddenin ilk
   hali sözleşmenin TERSİNİ anlatıyordu.** `live.rs`'teki `SYSTEM` yönergesinde
   blok birebir "IZIN ISTEME - IKI KADEME (bu ayrim kesindir, kendi basina
   genisletmezsin)" başlığıyla duruyor ve iki kademe şudur:

   - **(1) Okuma ve gözlem serbest, sormadan yapılır:** `dosya_oku`, `dosya_ara`,
     `hafizada_ara`, `sistem_durumu`, `acik_uygulamalar`, `ekrani_net_gor`,
     `internette_ara`, `web_sayfa_oku`, `derin_dusun` ve durumu **okuyan**
     terminal komutları (dizin listeleme, dosya içeriği, `git status/log`, süreç
     ve port sorguları). `uygulama_ac` ve `ses_kontrol` de sormadan yapılır —
     ikisi de geri dönülebilir.
   - **(2) Yazma ve değiştirme KISA ONAY İSTER:** dosya oluşturma, üzerine
     yazma, silme, taşıma, hafızaya kayıt, kurulum/kaldırma, servis
     başlatma-durdurma, `git commit/push`, uzak makineye dokunan komutlar. Onay
     cümlesi tek nefeslik olur ve "tamam" gelince beklemeden yapılır, ikinci kez
     sorulmaz. Geri dönüşü **olmayan** işlerde (silme, force push, uzaktaki
     veri) onay **ZORUNLUDUR**.

   Yani kaldırılan şey izin istemenin kendisi değil, **okuma tarafındaki** izin
   istemesiydi ("bakayım mı", "kontrol edeyim mi"). Kademeler testle bağlı:
   `sistem_yonergesi_kritik_kurallari_tasir` üç ayrı çırpı arıyor —
   `("izin kademeleri", "IKI KADEME")`,
   `("okuma serbest", "OKUMA VE GOZLEM serbesttir")`,
   `("yazma onayi", "YAZMA VE DEGISTIRME kisa onay ister")`. Bu düzeltmenin
   gerekçesi belgesel değil operasyonel: bu maddenin eski hali okuyup "yazma
   işlemleri onay gerektirmiyor" sonucuna varan birini yanlış bir güvenlik
   modeline götürüyordu. Belgenin kendi 8. maddesi de "madde 3'ün **birinci
   kademesinde**" diyerek çelişkiyi zaten kanıtlıyordu.

4. **Hitap ölçülü.** "Efendim" korunur (global JARVIS tercihi) ama seyrek:
   selamlaşma, önemli onay, kendiliğinden söz alma anı. Aynı cümlede iki kez ya
   da arka arkaya iki cevapta yasak. Sesli hatta her cümleye eklenen hitap
   yapaylık üretiyor; varsayılan hitapsız konuşmaktır.

5. **Ekran bir yetenek olarak ilan edilir.** "Ekranını göremiyorum" demek
   yasak. Küçük metin akan karede okunmaz, o yüzden metin/kod/hata satırı
   okunacaksa `ekrani_net_gor` çağrılır ve **tahmin edilmez**. Karşı kural aynı
   yerde: ekranı tarif etmek, her değişikliği bildirmek, aynı gözlemi ikinci kez
   söylemek yasak.

6. **Proaktiflik üç tetikleyiciye bağlandı** — bunların dışında kendiliğinden
   söz alınmaz:
   1. hata mesajı, kırmızı log, stack trace, başarısız build/test çıkışı;
   2. kullanıcının açıkça tıkandığı bir şey (aynı hatayı tekrar deniyor, aynı
      yerde dönüyor, araması sonuç vermiyor);
   3. Smith'in gördüğü ve kullanıcının kaçırdığı somut risk (yanlış branch,
      yanlış ortam/hesap, dolu disk, ekranda görünen bir sır).

   Söz alırken **tarif değil teşhis**: neyin bozulduğu + tek somut sonraki adım.
   "Ekranda bir hata var" yetersiz; "testi kıran şu, şu satırı düzeltmek yeter"
   geçerli.

7. **Proaktiflik sınırı (bu kararın çekirdeği).**
   - Aynı konuda kendiliğinden **en fazla bir kez** söz alınır.
   - Kullanıcı cevap vermez, "tamam" deyip geçer veya konuyu değiştirirse konu
     **kapanmıştır**: bir daha kendiliğinden açılmaz, hatırlatılmaz,
     "söylemiştim" denmez. Ancak kullanıcı sorarsa ya da ekranda **yeni ve
     farklı** bir belirti çıkarsa yeniden açılır.
   - Kullanıcı başka bir işe odaklanmışsa **sessiz kalınır**: oyun, video, film,
     müzik, görüşme/toplantı, uzun metin yazma. Bu hallerde yalnız kendisine
     hitap edilirse konuşur.
   - Şunlar için asla kendiliğinden söz alınmaz: normal ekran içeriğini tarif
     etmek, istenmeyen kod/üslup eleştirisi, "şunu da yapabilirsin" öneri
     listesi, aynı gözlemin tekrarı, laf olsun diye sohbet başlatmak,
     kullanıcının yazdığı metni düzeltmek.
   - Kullanıcı konuşurken araya girilmez, cümlesinin bitmesi beklenir.

8. **Belirsiz hedef soruya değil aramaya çevrilir** (2026-08-15 eki). Bir eylemin
   hedefi söylenenden çıkmıyorsa — hangi dosya, hangi uygulama, hangi pencere,
   hangi değer — Smith **tahmin etmez**; önce `dosya_ara`, `acik_uygulamalar`,
   `sistem_durumu` veya `ekrani_net_gor` ile hedefi çözer. Bu araçlar madde 3'ün
   birinci kademesinde zaten serbesttir, yani çözüm izin gerektirmez. Çözüldüyse
   soru sorulmadan yapılır; **yalnız araç da çözemiyorsa** tek kısa soru sorulur
   (seçenek listesi sunmadan, tek eksik bilgiyi sorarak).

   _Neden madde 2'nin içine yazılmadı:_ madde 2 "gerçek bir seçim varsa sor"
   diyor ve bu, Smith'in seçimin varlığını **fark ettiğini** varsayıyor. Buradaki
   arıza sınıfı tam olarak fark etmemesi — belirsizlik karşısında cesur bir
   varsayım yapıp devam etmesi. Sesli hatta bu, yanlış cevap değil **yanlış
   eylem** demektir: `system_tools` yalnız geri dönüşü olmayan işleri reddeder,
   yani yanlış hedefe uygulanan geri dönülebilir bir işlem (yanlış uygulamayı
   açmak, yanlış değeri yazmak) her iki kapıdan da geçer.

   _Neden bir "emin değilsen sor" kuralı değil:_ aynı gün kullanıcı yönergenin
   fazla soru sordurmasından şikâyet etti ve kök neden yönergenin kendi içinde
   çelişmesiydi. Yeni bir soru lisansı o çelişkiyi geri getirirdi. Kural bu
   yüzden **sıralama** kuralıdır: önce arama, en son soru. Sıralamanın kendisi
   testte ayrı bir çırpı olarak kilitlidir.

## Neden bu denge

Yanlış tarafa kaymanın maliyeti simetrik değil. **Az proaktif bir asistan
kullanılmaz; fazla proaktif bir asistan kapatılır.** Kapatılan asistanın hiç
yeteneği yoktur, yani gürültü riski sessizlik riskinden pahalıdır. Bu yüzden
tetikleyici listesi kısa ve somut (üç madde, hepsi ekranda gözlenebilir olay),
susturma listesi ise uzun tutuldu.

"En fazla bir kez" kuralı bilinçli olarak sert: ısrar mekanizması yok, "ikinci
kez nazikçe hatırlat" yok. Nedeni Live oturumunun yapısı — kare akışı sürekli,
yani bir belirti onlarca turda görünür kalır. Yumuşak bir sınır ("çok
tekrarlama") pratikte her karede tekrar demektir. Sınırı olayın kendisine değil
**konuya** bağlamak da bilinçli: aynı hata 30 kare boyunca ekranda durur, bu 30
ayrı tetikleyici değil bir konudur.

## Doğrulama

Yönerge tek bir Rust string'i (`SYSTEM`, `apps/desktop/src-tauri/src/audio/live.rs`).
Derleyici korumasi yok: bir satır yeniden yazılırken sessizce düşebilir ve kayıp
ancak canlı konuşmada, kötü davranış olarak fark edilir. İki test bunu kapıya
bağlar:

- **`sistem_yonergesi_kritik_kurallari_tasir`** — **24 kural ailesinden** birer
  çırpı ifade arar (kimlik, muhatap, kimlik uydurma yasağı, sözlük, kısalık,
  yağcılık yasağı, soruyla bitirme yasağı, izin isteme yasağı, izin kademeleri,
  okuma serbestliği, yazma onayı, **belirsiz hedef**, **belirsizlikte önce
  arama**, merak, iş bitiricilik, hitap, hafızaya yazma, `derin_dusun`, araç
  disiplini, ekran farkındalığı, `ekrani_net_gor`, proaktiflik, proaktiflik
  sınırı, sessiz kalma). Ayrıca yasak kalıp listesinin
  kendisinin ve iki proaktiflik freninin (`KAPANMISTIR`,
  `ASLA kendiliginden soz alma`) durduğunu doğrular. Metnin tamamı değil çırpılar
  kontrol edilir: yönerge yaşayan bir metin, birebir eşitlik her üslup
  rötuşunda yalancı alarm verirdi.
- **`sistem_yonergesi_turkce_harf_tasimaz`** — yönerge ve araç açıklamaları düz
  ASCII yazılır (dosya konvansiyonu). Bu test hem konvansiyonu hem de
  kopyala-yapıştır ile gelen mojibake izlerini (`ý` gibi) yakalar. Bu sırada iki
  mevcut kaza düzeltildi: `aracı` → `araci` (yönerge) ve `biçimde` → `bicimde`
  (`derin_dusun` açıklaması).

**Kırılma kanıtı (2026-08-14).** İki kural geçici olarak bozuldu, testler
kırmızıya döndü, dosya geri alındı:

| Simülasyon                                                                 | Sonuç                                                                                               |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `kendiliginden EN FAZLA BIR KEZ soz alirsin` → `kendiliginden soz alirsin` | `FAILED` — "sistem yonergesinden 'proaktiflik siniri' kurali dusmus (aranan: \"EN FAZLA BIR KEZ\")" |
| `eksiklik degil` → `eksiklik değil`                                        | `FAILED` — "SYSTEM icinde Turkce harf 'ğ' var - ASCII yazima cevir"                                 |

Geri alma sonrası: `cargo test --lib` → **93 passed; 0 failed; 1 ignored**
(taban 91 + 2 yeni test). `cargo check --all-targets` → temiz, uyarı yok.

**Kırılma kanıtı — madde 8 (2026-08-15).** Yeni kural bloğu yönergeden silindi
(ADR'nin tarif ettiği "bir satır yeniden yazılırken sessizce düşer" senaryosu);
`cargo test --lib sistem_yonergesi` → `FAILED`, mesaj: _"sistem yonergesinden
'belirsiz hedef' kurali dusmus (aranan: \"BELIRSIZ HEDEF\")"_. Blok geri
konduktan sonra `cargo test --lib live` → **23 passed; 0 failed**.

## Ne değişmez

- **`@smith/protocol` DEĞİŞMEZ.** Bu karar tamamen sistem yönergesi ve araç
  açıklamaları içindedir.
- **Araç adları ve parametre şemaları DEĞİŞMEZ** — React tarafı ve Rust
  dispatch onlara bağlı. Yalnız iki açıklama zenginleşti: `ekrani_net_gor`
  (hata sezince sorulmadan çağır) ve `derin_dusun` (iç işleyişi anlatma).
- **Güvenlik kapıları yönergeye devredilmedi.** Proaktiflik ve izin
  kademelendirmesi (madde 3) davranış katmanındadır — yönergedeki "yazma onayı"
  bir güvenlik kapısı değil, bir nezaket kuralıdır; gerçek fren kodda kalır — `SpeakerGate`
  (ADR 0001 hattı) yabancı sesi araç/hafıza yolunda keser, `system_tools` geri
  dönüşü olmayan komutları reddeder. Yönerge bir güvenlik sınırı değildir ve
  hiçbir zaman öyle sayılmaz.
- ADR 0002'nin ekran algısı aynen geçerli; bu ADR o kareyi **pasif girdiden
  davranışa** çevirir, yakalama hattına dokunmaz.
- ADR 0003'ün Faz 1 kapsamı (tek kullanıcı = Cihan) korunur; yönerge muhatabı
  hâlâ tek kişi olarak sabitliyor.

## Açık kalan

- **Kişilik ölçülemiyor.** Bugünkü test yönergenin _var olduğunu_ kanıtlıyor,
  modelin ona _uyduğunu_ kanıtlamıyor. Gerçek ölçüm için yasak kalıpları
  transkript üstünde sayan bir eval gerekir (`packages/evals`); tetikleyici,
  ürün istihbarat backlog'undaki kuralla aynı: gerçek kullanım trafiği.
- **Proaktiflik sınırı model belleğine güveniyor.** "Aynı konuda bir kez" kuralı
  oturum içi bağlama dayanıyor; oturum yenilenirse sayaç sıfırlanır. Kalıcı bir
  "bu konuyu zaten açtım" kaydı istenirse hafıza katmanına yazmak gerekir — bu,
  hafızaya yazma kuralıyla (yalnız açık talep) çakışacağı için ayrı bir karar
  konusudur.
