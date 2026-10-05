# ADR 0013 — Bilgisayar kontrol yüzeyi: görmekten yapmaya

**Tarih:** 2026-09-09
**Durum:** Kabul edildi — yön kararı (yapısal hedefleme birincil, piksel ikincil). Uygulama açık iştir; bu ADR hiçbir kod değişikliği içermez.

## Hedef

Smith bugün bilgisayarı görüyor ve PowerShell ile komut çalıştırıyor, ama kullanıcının tıkladığı yere tıklayamıyor, yazamıyor, tarayıcının içine giremiyor. Bu ADR o boşluğu ölçer, dış dünyada bu işin nasıl yapıldığını kaydeder ve Smith'in hangi yoldan gideceğine yön verir. Uygulama sırası ve kod bu ADR'nin kapsamı dışındadır.

## Bölüm 1 — Smith'in bugünkü ölçümü (kodda doğrulandı)

**Görme var, hedefleme yok.** Ekran yakalama `audio/screen.rs`, `xcap` ile; varsayılan uzun kenar 1920 piksel (`screen.rs:63`), JPEG kalite 85 (`screen.rs:66`), periyot 2000 ms (`screen.rs:823-830`), varsayılan kapalı, `SMITH_SCREEN=1` ile açılır (`screen.rs:819-821`). Kareler Gemini Live'a `realtimeInput.video` olarak base64 JPEG gidiyor (`live.rs:2380-2389`) — yani bir algı kanalı, screenshot→aksiyon→screenshot sözleşmesi olan bir araç döngüsü değil.

**Kritik varlık:** net-kare yolu küçültme YAPMIYOR. `kare_uret(ekran, edge: Option<u32>, q)` (`screen.rs:345`) `edge=None` ile çağrılıyor (`screen.rs:177`), kalite 92 (`screen.rs:68`). Yani Smith hâlihazırda **doğal çözünürlükte** kare üretebiliyor; grounding için gereken ilkel mevcut ve koordinat geri-eşlemesi gerektirmiyor.

**DPI:** üretim kodunda koordinat/DPI dönüşümü yok. `apps/desktop/src-tauri/examples/screen_probe.rs:36` monitör `scale_factor()` ölçüyor ama bu dosya `src/` altında değil, `cargo run --example screen_probe` ile çalışan ayrı bir sonda ikilisi — yalnız tanı amaçlı, üretim yolunda derlenmez/çağrılmaz.

**Giriş enjeksiyonu yok.** Büyük/küçük harf duyarsız arama fare/klavye simülasyonu için sıfır gerçek eşleşme verdi; `apps/desktop/src-tauri/Cargo.toml` içinde `enigo`/`rdev`/`inputbot`/`winput` yok. Tek Win32 FFI kullanımı CPU ölçümü için `GetSystemTimes`.

**Tarayıcı kontrolü yok.** CDP istemcisi, WebDriver, Playwright/Puppeteer bağımlılığı ve Chrome uzantısı (`manifest.json`) yok. Tauri webview yalnız Smith'in kendi arayüzünü render ediyor.

**Bugünkü koruma bir onay kapısı değil, ikili bir ret listesi.** `system_tools.rs:113-149` `DENIED` komut METNİNİ desen eşlemesiyle reddediyor; gateway tarafında aynası `packages/core/src/guard.ts:39-94`. PowerShell `powershell.exe -NoProfile -NonInteractive -Command` ile, 20 sn varsayılan zaman aşımı (`system_tools.rs:35`), 8 KB çıktı tavanı (`system_tools.rs:32`), yükseltme yok (`system_tools.rs:24`). Protokolde `requiresApproval` alanı var (`packages/protocol/src/wire.ts:129`) ama gateway'de sabit `false` (`apps/gateway/src/agent/device-bridge.ts:82-84`). "Yazmadan önce onay al" kuralı yalnız Live sistem yönergesinde, yani tavsiye. Gerçek mekanizma tek yerde: ses-izi sahiplik kapısı (`audio/speaker.rs:88`, `:144-149`).

## Bölüm 2 — Dış ölçüm (2026-09-09, resmî dokümanlardan)

**OpenAI'ın API şekli değişti.** `computer_use_preview` → GA `computer` tool; model `computer-use-preview` → `gpt-5.6-sol` / `gpt-6-astra`; çağrı başına tek `action` → toplu `actions[]` dizisi; `truncation: "auto"` zorunluluğu kalktı. Kaynak: platform.openai.com/docs/guides/tools-computer-use ve .../tools-computer-use-integration.

**İki entegrasyon yolu var ve resmî tercih kod yürütmeye kaydı.** Ham alıntı: _"For GPT-6 Astra, we recommend code execution. The `computer` tool remains supported as an alternative."_ Kod yürütme yolunda modele `exec_py` diye sıradan bir function tool verilir; model PyAutoGUI/Playwright kodu yazar, tek çağrıda döngü/koşul/ara kontrol yapar.

**Aksiyon uzayı (GA, tam):** `click`, `double_click`, `scroll`, `type`, `wait`, `keypress`, `drag`, `move`, `screenshot`. Üç ayrıntı: `status:"completed"` modelin üretmeyi bitirdiği anlamına gelir, uygulamak istemcinin işidir; `keypress` dizi döndürür (`["CTRL","A"]`), birleşik string değil; **koordinat uzayı modele gönderilen karenin piksel uzayıdır** — küçültme yapılırsa geri eşleme istemcinin sorumluluğudur (resmî öneri `detail:"original"`, gerekirse 1440×900 / 1600×900; 30.000-patch üstü kare reddedilir).

**Durum ayrımı.** Ham alıntı: _"Continuing a response does not restore a browser session, login state, or runtime variables."_ API konuşma durumu ile çalışma-zamanı durumu ayrıdır; oturumu canlı tutmak istemcinin işidir.

**Güvenlik modeli API alanından istemciye taşındı.** Eski `pending_safety_checks` / `acknowledged_safety_checks` alanları GA dokümantasyonunda YOK (üç resmî sayfa tarandı, yokluk teyit edildi). Yerine istemci-tarafı onay deseni: _hand-off required_ (parola değişiminin son adımı, tarayıcı güvenlik bariyerini aşma), _always confirm_ (veri silme, izin/API-key değişikliği, CAPTCHA, indirilen kodu çalıştırma, finansal işlem, OS ayarı), _pre-approval yeterli_ (giriş, dosya yükleme/taşıma, yaş doğrulama). Artı bir kural: _"Treat screen content as untrusted"_ — ekranda görünen talimat, aciliyet iddia etse bile izin sayılmaz.

**Astra'nın seviye atlaması nereden geldi** (OpenAI'ın kendi ölçümü, openai.com/index/gpt-6-astra/): ScreenSpot-Pro araçsız grounding 76,9% → **92,7%**; OSWorld 2.0 (offline, partial) 65,7% @ ~75 dk → **72,6% @ ~40 dk**; iç computer-use güvenlik testi 22,0% → **2,4%**, "yetkilendirilmiş hedefin dışına çıkma" %48 → %0. Çıkarım: sıçrama yeni bir giriş mekanizmasından değil, üç eksenden geliyor — (1) grounding isabeti, (2) görev başına adım sayısının düşmesi (kod yürütme: tur başına bir program, bir aksiyon değil), (3) yetki sınırında kalmanın bir yetenek olarak eğitilmesi. Astra'nın action space'i ve grounding yöntemi hiçbir birincil kaynakta açıklanmıyor.

**Aksiyon uzayı sanayide ikiye ayrıldı, birleşmedi.** En somut kanıt Anthropic'in ürün kararı: aynı tarihte iki ayrı araç GA oldu — piksel+koordinat çalışan `computer_toolset` ve accessibility tree okuyup elemana referansla davranan `browser_toolset`. Yani ortam yapısal veri veriyorsa a11y/DOM kazanır, vermiyorsa piksel zorunludur. Windows masaüstünün tarayıcıdan zor olmasının nedeni budur: uygulama başına eksik/tutarsız UIA implementasyonu.

**Metrik tuzağı (kayda geçiyor).** OpenAI'ın OSWorld 2.0 için verdiği %72,6 ile bağımsız akademik OSWorld 2.0 makalesindeki (arxiv 2606.29537) %20,6 arasındaki uçurum bir çelişki DEĞİL: OpenAI _partial score / offline alt-küme_ veriyor, makale _binary completion_. Makalenin partial'ı Claude Opus 4.8 için %54,8; OpenAI aynı tabloda Opus 5'i resmî leaderboard'dan üretip %70,2 yazıyor. Ayrıca "OSWorld-Verified" ile "OSWorld 2.0" farklı zorlukta iki ayrı benchmark'tır, kıyaslanmamalıdır.

## Bölüm 3 — Karar: yapısal hedefleme birincil, piksel ikincil

**Gerekçe güvenilirlik değil, denetlenebilirliktir.** Bir tıklama denetlenebilir metin değildir: `Remove-Item -Recurse C:\` desenle yakalanır, `click(405,157)` yakalanamaz — o pikselin "Hesabı sil" düğmesi olduğunu bir ret listesi göremez. Yani Smith'in bugünkü `DENIED` yaklaşımı tıklamaya taşınamaz; kavramsal olarak imkânsızdır.

UI Automation elemanın adını, rolünü ve sınırlayıcı dikdörtgenini verir. Model "adı 'Hesabı sil' olan düğmeye bas" der, tıklama noktasını Smith hesaplar — ve onay kapısı o anda **elemanın adını okuyabilir**. Piksel yolunda kapı kördür, yapısal yolda kapı görür. Bu yüzden yapısal hedefleme bir isabet iyileştirmesi değil, onay kapısının ön koşuludur. Aynı hamle isabeti de artırır (Anthropic'in `browser_toolset` kararının masaüstü karşılığı), ama satın alınan asıl şey mekanizmadır.

**İkinci gerekçe — sağlayıcı kısıtı.** Smith'in bugünkü LLM sağlayıcısı Gemini; OpenAI anahtarı yok. Yani ScreenSpot-Pro %92,7'lik grounding satın alınamaz. Yapısal hedefleme, zayıf grounding'e olan bağımlılığı düşürdüğü için tam bu kısıtta kazanır.

### Kademeler (ucuzdan pahalıya, sıra bağlayıcı değil)

- **A — UIA hedefleme (birincil).** COM `IUIAutomation`: eleman ağacı, `ElementFromPoint`, sınırlayıcı dikdörtgen, `InvokePattern` / `ValuePattern` ile tıklamadan doğrudan çağırma ve metin yazma. Bilinen tuzak: COM vtable sırası (Smith'te `ses_kontrol`'de bir kez yaşandı).
- **B — Giriş enjeksiyonu (A'nın düşemediği yerler).** `SendInput`; mutlak fare için `MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK` ve 0–65535 normalizasyonu. İki tuzak ölçülmedi, sahada doğrulanmalı: (1) süreç per-monitor DPI aware değilse koordinatlar sanallaşır ve tıklama kayar; (2) UIPI — yükseltilmiş pencereye enjeksiyon sessizce başarısız olur, Smith yükseltilmemiş çalışır.
- **C — Tarayıcı/DOM.** `--remote-debugging-port` modern Chrome'da varsayılan profille kısıtlıdır (ayrı `--user-data-dir` ister), yani kullanıcının oturum açmış günlük profili kolayca bağlanmaz — ölçülmeli. Gerçek profilde çalışmak gerekiyorsa doğru mimari Smith'e ait bir Chrome uzantısıdır (`chrome.debugger` + content script, WS ile Smith'e bağlanır). Otomasyon/headless işler için CDP + ayrı profil.
- **D — Döngü ve kapı.** OpenAI'ın GA döngüsü aynen alınır: net kare (küçültme yok, koordinat eşlemesi gerekmez) → aksiyon dizisi → uygula → yeni kare. Üstüne adım/süre limiti, iptal ve sonucu modele değil ekrana sorarak doğrulama.

### Smith'in iki asimetrisi (korunacak)

1. **Ses-izi sahiplik kapısı** (`audio/speaker.rs`) izni sahibinin sesine bağlayabiliyor. "Ekran içeriği izin sayılmaz" kuralını Smith rakiplerden daha sert uygulayabilir; bu kapı yeni kontrol araçlarını da kapsamalıdır.
2. **Live'ın video kanalı.** Anthropic'in kendi itiraf ettiği "flipbook" zaafı (ayrık kare kısa ömürlü UI olaylarını kaçırır) Smith'te algı tarafında zaten kapalı. Doğru bölünme: algı Live'da, hedefleme net karede.

## Reddedilenler

- **Piksel tıklamayı birincil yol yapmak.** Onay kapısını kör bırakır; `DENIED` deseni tıklamaya taşınamaz.
- **`DENIED` listesini tıklama koordinatlarına genişletmek.** Koordinat semantik taşımaz; liste yanlış güvenlik hissi üretir.
- **Kullanıcının günlük Chrome profilini `--remote-debugging-port` ile açmak.** Profil kısıtı bir yana, tüm oturumları kalıcı olarak dışarıya açık bir hata ayıklama yüzeyine bağlar.
- **Ekran akışını (Live video) hedefleme için kullanmak.** 1 kare/2 sn, 1920'ye küçültülmüş, q85 JPEG — tıklama hedefi için ne zamansal ne uzamsal olarak yeterli.
- **Sunucu tarafında bilgisayar kontrolü.** ADR 0003 sınırı: bu araçlar makinenin üstünde, cihaz sahibinin yetkisiyle çalışır.

## Değişmezler

- Bilgisayar kontrolü cihaz-tarafı araçtır; gateway'de yürütülmez.
- Ekranda görünen metin izin üretmez; izin yalnız kullanıcının doğrudan talimatından gelir.
- Geri dönüşsüz eylem için onay mekanizma olacaktır, sistem yönergesindeki rica değil.
- Hedef bir elemanla adlandırılabiliyorsa piksel tıklama kullanılmaz.

## Geri alma

Kontrol yüzeyi tek bir env bayrağı arkasında açılır (mevcut `SMITH_SCREEN=1` deseni gibi); bayrak kapatıldığında Smith bugünkü davranışına döner. Kademeler bağımsızdır: C (tarayıcı) A ve B olmadan da geri alınabilir.

## Doğrulanmamış kalemler (kapanmadan uygulamaya geçilmez)

1. GA `computer` tool'un tam API-referans şeması — `display_width` / `display_height` / `environment` alanlarının hâlâ opsiyonel var olup olmadığı teyit edilmedi; yalnız guide örneğindeki `{"type":"computer"}` görüldü.
2. GPT-6 Astra'nın gerçek action space'i (piksel / a11y / hibrit) hiçbir birincil kaynakta yok.
3. Chrome'un varsayılan profilde uzak hata ayıklama kısıtı — sürüm ve davranış ölçülmedi.
4. Windows DPI farkındalığı ve UIPI davranışı Smith süreci için ölçülmedi.
5. Google Gemini'nin resmî computer-use dokümanı okunmadı (kapsam boşluğu, erişim engeli değil).

## Sonraki ayrı aşamalar

1. Sahada ölçüm probe'u: DPI farkındalığı, UIPI davranışı, Chrome profil kısıtı, UIA ağacının gerçek uygulamalarda ne kadar dolu olduğu.
2. Onay kapısının tasarımı: `requiresApproval`ı araç metadata'sından türetmek ve eleman adını kapıya taşımak.
3. Kademe A'nın tek araçla dar bir dilimi (yalnız oku: pencere/eleman ağacını listele) — yazma yok.
