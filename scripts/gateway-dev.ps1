# Smith gateway'i yerel gelistirme modunda baslatir.
# .env repo kokunde; pnpm dev scripti onu yukluyorsa da guvence icin kritik
# degiskenler burada inline verilir (prisma/CLI process.env okur).

# Yerel sirlar (git'te DEGIL, .gitignore: *.local.ps1). Anahtarlar burada durur
# cunku BU dosya takipli: dogrudan yazmak reponun scan-secrets.sh kontrolunu
# RED'e dusuruyordu. Dosya yoksa sessizce devam edilir.
$smithSecrets = Join-Path $PSScriptRoot "dev-secrets.local.ps1"
if (Test-Path $smithSecrets) { . $smithSecrets }
# Tek veri koku (Get-SmithDataDir): oturum sirri burada durur.
. (Join-Path $PSScriptRoot "smith-common.ps1")

$ErrorActionPreference = "Continue"
Set-Location (Split-Path -Parent $PSScriptRoot)

$env:NODE_ENV = "development"
$env:PORT = "4100"
$env:SMITH_CONTEXT_EXCLUDE = if ($env:SMITH_CONTEXT_EXCLUDE) { $env:SMITH_CONTEXT_EXCLUDE } else { "obsidian:acme/*,code:_workshop-smoke/*,kw:acme" }

# Oturum imzalama sirri takipli dosyada DURMAZ (eskiden burada sabit bir deger
# vardi: repoya erisen herkes gateway token'i uretebilirdi). Cozum sirasi:
#   1) $env:SMITH_SESSION_SECRET (en az 32 karakter)
#   2) <veri koku>\session-secret (kullaniciya ozel dosya; kok: SMITH_DATA_DIR ya da
#      %USERPROFILE%\.smith, bkz. smith-common.ps1)
#   3) yoksa kriptografik rastgele uretilip 2'ye yazilir (ACL: yalniz bu kullanici)
# Deger HICBIR ZAMAN yazdirilmaz. Sir degisirse eski token'lar gecersiz olur;
# masaustu token'i /v1/dev/login ile yeniden alir, kalici veri etkilenmez.
function Get-SmithSessionSecret {
    $minLength = 32
    if ($env:SMITH_SESSION_SECRET) {
        $fromEnv = $env:SMITH_SESSION_SECRET.Trim()
        if ($fromEnv.Length -lt $minLength) {
            throw "SMITH_SESSION_SECRET en az $minLength karakter olmali (verilen deger kisa)."
        }
        return $fromEnv
    }

    $secretDir = Get-SmithDataDir
    $secretFile = Join-Path $secretDir "session-secret"
    if (Test-Path -LiteralPath $secretFile) {
        $existing = (Get-Content -LiteralPath $secretFile -Raw)
        if ($existing -and $existing.Trim().Length -ge $minLength) {
            return $existing.Trim()
        }
        Write-Host "[gateway-dev] session-secret dosyasi bos/kisa, yeniden uretiliyor"
    }

    if (-not (Test-Path -LiteralPath $secretDir)) {
        New-Item -ItemType Directory -Path $secretDir -Force | Out-Null
    }
    $bytes = New-Object byte[] 48
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $generated = [Convert]::ToBase64String($bytes)

    # Once bos dosya + ACL, sonra icerik: sir hic bir an baskalarina acik kalmaz.
    New-Item -ItemType File -Path $secretFile -Force | Out-Null
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $secretFile /inheritance:r /grant:r "*${sid}:(R,W)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -LiteralPath $secretFile -Force
        throw "session-secret dosyasinin ACL'i daraltilamadi (icacls cikis kodu $LASTEXITCODE)."
    }
    [System.IO.File]::WriteAllText($secretFile, $generated, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "[gateway-dev] yeni session-secret uretildi: $secretFile"
    return $generated
}
$env:SESSION_SECRET = Get-SmithSessionSecret
# Tauri origin'leri: dev = localhost:1420, paketli = tauri://localhost
# (Windows'ta https://tauri.localhost). Hepsi listede olmali; yoksa webview
# yaniti CORS'ta reddeder ve istemci sessizce "baglanamadi" der.
$env:CORS_ORIGINS = "http://localhost:3000,http://localhost:1420,http://127.0.0.1:1420,tauri://localhost,https://tauri.localhost,http://tauri.localhost"
$env:DATABASE_URL = "postgresql://smith:smith@127.0.0.1:5433/smith"
$env:MIGRATE_DATABASE_URL = "postgresql://smith:smith@127.0.0.1:5433/smith"
# Projenin kendi compose servisleri (docker: smith-dev-postgres-1 :5433,
# smith-dev-redis-1 :6380). 6379 baska projelere ait - oraya BAGLANMA.
$env:REDIS_URL = "redis://127.0.0.1:6380"
# OLLAMA_BASE_URL yalniz YEREL yedek yol: SMITH_* uclari verilmezse sohbet ve
# embedding buraya duser. Bu kurulumda ikisi de bulut ucuna gidiyor (asagi bkz.
# SMITH_LLM_* / SMITH_EMBED_*); "embedding daima yerel" ARTIK GECERLI DEGIL.
# Sohbet modeli free-tier bulut ucu - yerel 3B Turkce'de yetersizdi
# ("I am Sen Smith."), Gemini flash ayni istemde dogru cevap verdi.
$env:OLLAMA_BASE_URL = "http://127.0.0.1:11434"

# Sohbet: Google AI Studio (OpenAI-uyumlu uc) - kullanicinin KISISEL free-tier
# anahtari. Anahtar .env'de degil burada, cunku .env repo kokunde ve paylasilan
# bir dosya; bu script kisisel calistiricidir. Kota dolarsa: OpenAI-uyumlu
# baska bir uca (or. OpenRouter) gecmek icin bu uc satiri degistirmek yeterli.
$env:SMITH_LLM_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai"
# (anahtar dev-secrets.local.ps1'e tasindi: ${env:SMITH_LLM_API_KEY})
# SESLI KONUSMA ICIN MODEL SECIMI = TTFT (ilk kelimeye kadar gecen sure).
# Olculdu (2026-08-12, ayni istem, stream:true):
#   gemini-flash-latest       3129 ms  (thinking varsayilan acik)
#   gemini-flash-latest + low 2733 ms
#   gemini-flash-lite-latest   727 ms  <-- secildi
# Streaming zaten dogru calisiyor (parcalar 901/944/984/1067 ms'de akiyor);
# darbogaz modelin dusunme asamasiydi. Sesli sohbette 3 sn sessizlik kabul
# edilemez, lite'in kalitesi Turkce sohbet icin yeterli.
# ZEKA: `flash-lite` en kucuk siniftu ve kullanici "zekasi cok geri" dedi.
# `gemini-flash-latest` olculdu: ayni istemde dogru + gerekcelendirilmis Turkce
# cevap verdi (lite veremiyordu). Pro modeller free-tier'da 429 (kota) -> yok.
$env:SMITH_LLM_MODEL = "gemini-flash-latest"

# YEDEK SAGLAYICI YOK - BILINCLI KARAR (2026-09-18): Mistral kullanilmayacak
# ("mistral api olmayacak" - kullanici karari;). Kosullu
# Mistral blogu KALDIRILDI; zincir tek halka: Gemini. Kota dolarsa istek HATA
# verir - sessiz yedek YOK. Jenerik SMITH_LLM_FALLBACK_* mekanizmasi kodda
# durur (packages/llm) ama burada hicbir saglayici baglanmaz. (Gecmis:
# 2026-08-25'te kosullu eklenmisti; hic aktif olmadi - SMITH_MISTRAL_KEY
# hicbir zaman tanimlanmadi.)
# Stall'i kesen ust sure; 45 sn'de yanit yoksa deneme burada biter.
$env:SMITH_LLM_TIMEOUT_MS = "45000"

# Cihan karari 2026-10-03: 30 dk; ozet de bu bosta kalma penceresiyle tetiklenir.
if (-not $env:SMITH_SESSION_IDLE_HOURS) { $env:SMITH_SESSION_IDLE_HOURS = "0.5" }

# EMBEDDING = API (kullanici karari: "Ollama olmasin, verimsiz"). Ayni Google
# anahtari, gemini-embedding-001 @ 768 boyut (Matryoshka) -> DB vector(768)
# semasi degismez. Ollama artik hicbir yerde kullanilmiyor.
$env:SMITH_EMBED_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai"
# (anahtar dev-secrets.local.ps1'e tasindi: ${env:SMITH_EMBED_API_KEY})
$env:SMITH_EMBED_MODEL = "gemini-embedding-001"
$env:SMITH_EMBED_DIMENSIONS = "768"

# `dev` yalniz tsc --watch (derler, SUNUCU BASLATMAZ). Once derle, sonra kosur.
Write-Host "=== gateway build ==="
pnpm --filter "@smith/gateway" build 2>&1 | Select-Object -Last 5
Write-Host "=== gateway start (:4100) ==="
pnpm --filter "@smith/gateway" start 2>&1
