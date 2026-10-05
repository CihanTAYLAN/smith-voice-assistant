# Smith Windows dev ortami: cargo (MSVC) + cmake + LLVM/libclang env'ini kurar.
# User env degiskenleri tool shell'lerine miras gecmedigi icin PATH/LIBCLANG
# burada inline set edilir. Kullanim:
#   . .\scripts\dev-win.ps1        # env'i mevcut shell'e yukle
#   pnpm --filter @smith/desktop tauri dev
#
# NOT (2026-08-17): cmake + LLVM/libclang'i Windows'ta ceken TEK bagimlilik
# whisper-rs-sys idi ve basamakli ses hattiyla birlikte kaldirildi. `cargo tree`
# artik Windows hedefinde ne `cmake` ne `bindgen` crate'i gostermiyor, yani bu iki
# satir muhtemelen gereksiz -- ama SOGUK derlemeyle dogrulanmadi, o yuzden
# duruyorlar. Zararsizlar; kaldirmadan once tam temiz build ile dogrula.

# Yerel sirlar (git'te DEGIL, .gitignore: *.local.ps1). Anahtarlar burada durur
# cunku BU dosya takipli: dogrudan yazmak reponun scan-secrets.sh kontrolunu
# RED'e dusuruyordu. Dosya yoksa sessizce devam edilir.
$smithSecrets = Join-Path $PSScriptRoot "dev-secrets.local.ps1"
if (Test-Path $smithSecrets) { . $smithSecrets }

$cmakeBin = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Kitware.CMake_Microsoft.Winget.Source_8wekyb3d8bbwe\cmake-4.4.2-windows-x86_64\bin"
$llvmBin  = Join-Path $env:USERPROFILE "llvm\bin"
$cargoBin = "$env:USERPROFILE\.cargo\bin"
$env:LIBCLANG_PATH = $llvmBin
$env:PATH = "$cargoBin;$llvmBin;$cmakeBin;$env:PATH"
$env:SMITH_CONTEXT_EXCLUDE = if ($env:SMITH_CONTEXT_EXCLUDE) { $env:SMITH_CONTEXT_EXCLUDE } else { "obsidian:acme/*,code:_workshop-smoke/*,kw:acme" }

# SES MOTORU: Gemini Live speech-to-speech, tek WebSocket. TEK motordur.
# Basamakli hat (VAD+STT+LLM+TTS) ~3.4 sn ilk-ses gecikmesi uretiyordu ve soz
# kesme yoktu; Live'da olculen 613 ms + sunucu tarafli kesinti.
#
# BASAMAKLI HAT 2026-08-17'DE SOKULDU. Onceki uyari ("SMITH_LIVE=0 ile
# donebilirsin" dogru degil) artik bir uyari degil, bir olgu: o kod yok.
# Bugun SMITH_LIVE=0: mikrofon acilir, UI seviye gostergesi calisir, baska
# hicbir sey olmaz -- Smith DUYMAZ ve KONUSMAZ (makineden ses de cikmaz).
# Live baslatilamazsa `audio_start` artik HATA DONER (sessizce yedege dusmez);
# hata UI'da mikrofon satirinda gorunur.
$env:SMITH_LIVE = "1"
# (anahtar dev-secrets.local.ps1'e tasindi: ${env:SMITH_GEMINI_KEY})
# EKRAN GORME (kullanici: "ekranimi da gorsun"). Ekran icerigi buluta gider ->
# bilincli acilir. 2 sn'de bir 1920px JPEG kare (q85); kapatmak icin "0".
# Periyodik ekran akisi varsayilan KAPALI (Cihan karari 2026-10-02: ekran istenince gorulur; net kare icin ekrani_net_gor araci her zaman acik). Free tier'da kareler Google urun gelistirmesinde kullanilabilir.
$env:SMITH_SCREEN = "0"
$env:SMITH_SCREEN_INTERVAL_MS = "2000"
# COK MONITOR (kullanici mandasi 2026-08-15: "butun monitorlerimi gorebilmesini
# istiyorum"). Bu masada iki 1920x1080 ekran var ve ikisinin de model adi AYNI
# (LS24DG30X) -> ayirt etme indekse dayanir, sira (x, y, id) ile deterministik.
#   all     : her tikta HER monitor -> mandanin harfi. BEDEL: kare sayisi ve
#             video token'i 2x (30 -> 60 kare/dk). Kota hatasi gorursen asagiya
#             bak.
#   active  : yalniz odaklanmis pencerenin ekrani. Kota bugunkuyle AYNI ve
#             cozunurluk hic dusmuyor; olcum bunu oneriyor.
#   rotate  : sirayla bir ekran. Kota sabit, ekran basina tazelik 2 -> 4 sn.
#   primary : eski davranis (yalniz birincil).
# Yan yana BIRLESTIRME olculdu ve ELENDI: 3840x1080'i 1920 uzun kenara
# sigdirmak monitor basina 960x540 birakiyor; cozunurluk tam bu yuzden
# 1280'den 1920'ye cikarilmisti, birlestirme o karari geri alirdi.
#
# "all" DENENDI VE SAHADA DUSTU (2026-08-15): kullanici "monitorlerimi yanlis
# goruyor" dedi. Sebep yapisal - `realtimeInput.video` ETIKET ALANI TASIMAZ,
# yalniz mimeType+data. `all` modunda tek video kanalina saniyede iki ETIKETSIZ
# kare akiyor ve modelin hangisinin hangi ekran oldugunu bilmesinin tek yolu
# yonergedeki "sirayla soldan saga" cumlesiydi. Istem tavsiyedir, kanal garanti
# vermez -> kareler karisti. Bir istemin tasiyamayacagi yuku tasimasini
# beklemek hataydi.
#
# "active": akis TEK ve belirsizlik tasimiyor - kullanicinin BAKTIGI ekran.
# Manda ("butun monitorlerimi gorsun") kaybolmadi, yer degistirdi: Smith artik
# her ekrani `ekrani_net_gor` aracina `ekran` argumaniyla ('sol'/'sag'/'hepsi')
# isteyerek gorebiliyor ve aracin YANITI hangi ekran oldugunu soyluyor. Yani
# ekran adi artik tahminden degil, veriden geliyor. Kota da 2x'ten 1x'e dondu.
$env:SMITH_SCREEN_MONITORS = "active"

# Live ARAC KOPRUSU: model `hafizada_ara` / `hafizaya_kaydet` cagirdiginda
# masaustu bu gateway'e HTTP ile gider. Live modunda sohbet turu gateway'de
# kosmadigi icin hafiza YALNIZ bu yolla calisir (kullanici: "hafizasi yok").
# Token'i Rust kendisi alir (/v1/dev/login) - UI'in token'ina bagli degil.
$env:SMITH_GATEWAY_HTTP = "http://127.0.0.1:4100"
$env:SMITH_DEV_EMAIL = "cihan@example.test"
$env:SMITH_DEV_WORKSPACE = "ws_b98888ec6fe14f64bc57ca2ff599c31f"

# SES IZI DOGRULAMASI (speaker verification) - YEREL, biyometrik veri cikmaz.
# Hafizaya YAZMA yalniz Cihan'in sesi dogrulandiginda calisir; makineyi
# degistiren araclar (terminal/uygulama_ac/ses_kontrol) yabanci ses tespit
# edilirse reddedilir. Okuma/ekran/internet araclari etkilenmez.
# Sunucu: .\scripts\speaker-server.ps1   Kayit (bir kere): .\scripts\speaker-enroll.ps1
# Sunucu kapali veya kayit yoksa FAIL-CLOSED: asistan calisir ama mutasyon ve
# gizlilik araclari kapali kalir (gerekce: audio/speaker.rs). Kapatmak icin bu
# satiri "0" yap.
$env:SMITH_SPEAKER_SIDECAR = "127.0.0.1:8124"
# Esik: bu makinede olculdu (ayni kisi >= 0.64, olculen impostor tavani 0.32).
# DIKKAT - bu degiskeni SIDECAR SURECI okur, masaustu degil: burada set etmek
# yalniz sunucuyu AYNI shell'den baslatirsan etkili olur. Kalici degisiklik icin
# `.\scripts\speaker-server.ps1 -Threshold 0.5` kullan. Python varsayilani da
# 0.48 (2026-08-15'te olculen karara cekildi) oldugu icin iki yol da ayni
# davranir; kayit sirasinda olculen dagilima
# gore speaker-enroll.ps1 daha uygun bir deger onerebilir.
# Esik 0.45 -> 0.55: KAYIT SIRASINDA OLCULDU (2026-08-14). Cihan'in kendi
# ifadeleri arasi en dusuk benzerlik 0.735, centroid'e en dusuk 0.891, kayitta
# kullanilmayan ifade 0.883; yabanci ses tavani 0.32. 0.55 iki tarafa da bol
# pay birakir. Script'in kendi onerisi de buydu.
# 0.55 -> 0.48 (CANLI OLCUM, 2026-08-14): kayit ortaminda self-verify 0.883
# cikiyordu ama CANLI ifadeler 0.63-0.67 aralikta (kisa ifade + mikrofon
# kazanci + echo kapisi). 0.55 ile pay yalnizca ~0.08 kaliyordu ve bir ifade
# 0.409 alip YANLIS REDDEDILDI (hafizaya yazma keyfi kilitlenir). Yabanci ses
# tavani 0.32 olculdugu icin 0.48 iki tarafa da guvenli: yanlis ret gider,
# koruma zayiflamaz.
$env:SMITH_SPEAKER_THRESHOLD = "0.48"

# KENDI KODUNU DUZENLEME (kullanici mandasi 2026-08-17). Smith bir kod gorevini
# WSL'deki Claude Code'a devreder: repo DISINDA bir git worktree + yeni dal
# (`smith/gorev-*`), ajana kabuk verilmez, merge/push YAPILMAZ, sonuc Cihan'in
# incelemesini bekler. Gerekce ve sinirlar: src/code_agent.rs modul basligi.
#
# Kisisel cihaz aboneligi (ADR 0015 karar 4, Cihan 2026-10-02).
# Kod gorevi OWNER_ONLY kapisindan gecer; izole worktree, kabuk/merge/push yok.
$env:SMITH_CODE_AGENT = if ($env:SMITH_CODE_AGENT) { $env:SMITH_CODE_AGENT } else { "1" }
# Dusunme: Claude Code aboneligi; hata halinde mevcut Gemini yoluna duser.
$env:SMITH_THINK_ENGINE = if ($env:SMITH_THINK_ENGINE) { $env:SMITH_THINK_ENGINE } else { "claude" }
# SMITH_MIC_STREAM: gated = yalniz VAD konusma araligini gonder; continuous = surekli
# mikrofon akisi. Ses izi/OWNER_ONLY arac yetkisi iki modda da korunur.
# Ornek: $env:SMITH_MIC_STREAM = "gated"  # veya "continuous"
# Ajanin uzerinde calisacagi depo. Sabit yol koda YAZILMADI (baska makinede
# yoktur); dikis burada.
$env:SMITH_REPO_DIR = Split-Path -Parent $PSScriptRoot
# Gorev basina tavan (sn). Live oturumu ~10 dk'da yenilendigi icin bunun
# altinda kalmali, yoksa arac yaniti donerken oturum degismis olur.
$env:SMITH_CODE_AGENT_TIMEOUT_S = "180"

# --- SMITH DASHBOARD (ADR 0007; eski adi Mission Control) --------------------
# Dashboard ayri bir pencere (gorevler + dosyalar + bilgi grafigi + hafiza);
# HUD'daki kare dugmesi onu her zaman acar. Bu bayrak yalniz "acilista da
# acilsin mi" sorusunu yanitlar. VARSAYILAN KAPALI: pet sessiz bir masaustu
# varligi olarak dogar, panel istenince gelir. DIKKAT - bu satir KOSULSUZ
# yazar; kabuktan gelen SMITH_MISSION_OPEN'i EZER (2026-09-18'de boyle bir
# dogrulama karisikligina yol acti; acilista acmak istiyorsan degeri burada 1 yap).
$env:SMITH_MISSION_OPEN = "0"
# NOT: is gucu (atanan gorevi kosturan tuketici) BU SURECTE DEGIL, worker'da
# yasar. Acmak icin scripts/worker-dev.ps1 icindeki SMITH_MISSION_EXECUTOR.
# Worker kosmuyorsa panodan atanan gorev kuyrukta 'queued' kalir.

# SOKULENLER (2026-08-17, basamakli ses hatti): SMITH_STT_SIDECAR,
# SMITH_TTS_SERVER, SMITH_WHISPER_MODEL, SMITH_STT_DEBUG_WAV, SMITH_BARGEIN ve
# GGML_*/CMAKE_BUILD_TYPE bloklarini bilincli olarak KALDIRDIK: hicbirini okuyan
# kod kalmadi. Buraya geri eklemek isteyen once okuyani yazar.
Write-Host "[dev-win] cargo=$((Get-Command cargo -EA SilentlyContinue).Source)"
Write-Host "[dev-win] cmake=$((Get-Command cmake -EA SilentlyContinue).Source)"
Write-Host "[dev-win] LIBCLANG_PATH=$env:LIBCLANG_PATH"
