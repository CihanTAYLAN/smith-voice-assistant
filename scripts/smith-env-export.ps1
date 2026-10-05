# Paketli Smith exe'si icin env dosyasi uretir: <veri koku>\smith.env
# (veri koku: SMITH_DATA_DIR ya da %USERPROFILE%\.smith, bkz. smith-common.ps1)
#
# Neden gerekli: `tauri build --no-bundle` ciktisi (smith-desktop.exe) cift
# tiklanarak veya acilista baslatilir; dev-win.ps1'i dot-source eden bir kabuk
# yoktur, dolayisiyla SMITH_GEMINI_KEY ve diger SMITH_* degiskenleri surece
# gelmez ("Ses motoru baslatilamadi"). Uygulama acilista bu dosyayi okur
# (src-tauri/src/env_file.rs): yalniz o an TANIMSIZ olan anahtarlari yukler,
# isletim sistemi env'i her zaman baskindir.
#
# Ne yapar: scripts\dev-win.ps1'i (o da varsa dev-secrets.local.ps1'i yukler)
# bu surecte dot-source eder, ortaya cikan degiskenlerden MASAUSTUNUN OKUDUGU
# SMITH_* anahtarlarini (asagidaki ALLOWLIST) toplar ve KEY=VALUE satirlari
# olarak yazar. COMPUTERNAME / USERPROFILE gibi isletim sistemi degiskenleri zaten
# surece gelir.
#
# Sir guvenligi:
#   - Degerler ekrana BASILMAZ; yalniz anahtar adlari ve sayisi yazilir.
#   - Dosya once bos olusturulur, ACL'i yalniz mevcut kullaniciya kisitlanir
#     (icacls), SONRA icerik yazilir: sir hicbir an genis izinli dosyada durmaz.
#   - ALLOWLIST: yalniz masaustu Rust kodunun gercekten okudugu anahtarlar
#     yazilir (src-tauri/src altindaki env okumalarindan turetildi). Gateway /
#     worker / sidecar sirlari (SMITH_LLM_*, SMITH_EMBED_*, SMITH_MISTRAL_KEY,
#     SMITH_APP_PASSWORD, SMITH_TOKEN, Deepgram, ElevenLabs ...) hic yazilmaz:
#     masaustu bunlari okumaz, ama terminal / code_agent alt surecleri ortami
#     miras alir. Yeni bir env okuma eklenirse listeye de eklenmeli: bunu
#     talimat degil KAPI zorlar (scripts/smith-env-export-test.ps1 Rust kaynagini
#     tarar; bilincli dislananlar o testteki istisna listesindedir).
#   - SMITH_DATA_DIR listede: ozel veri koku kullanan makinede paketli uygulamanin
#     alt surecleri (sidecar, betikler) ayni koku gorsun. Dosyanin kendisi cozulmus
#     veri kokune yazilir; uygulama dosyayi okumadan once varsayilan/OS-env kokunde
#     arar, bu yuzden ozel kokte degisken OS env'inde de tanimli olmali.
#
# Kullanim:
#   .\scripts\smith-env-export.ps1                    # yaz
#   .\scripts\smith-env-export.ps1 -ListOnly          # yalniz anahtar adlarini goster, yazma
#   .\scripts\smith-env-export.ps1 -ScriptsDir <repo>\scripts
#       (dev-secrets.local.ps1 yalniz ana kopyada durur; baska bir worktree'den
#        calistirirken ana kopyanin scripts dizinini ver)
param(
    [string]$ScriptsDir = $PSScriptRoot,
    # Bos: <veri koku>\smith.env (Resolve-SmithDataDir; param varsayilani ortak
    # kutuphane yuklenmeden degerlendirilir, bu yuzden asagida doldurulur).
    [string]$OutFile = "",
    [switch]$ListOnly
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'smith-common.ps1')
if (-not $OutFile) { $OutFile = Join-Path (Resolve-SmithDataDir) "smith.env" }

function Fail([string]$msg) {
    Write-Error $msg
    exit 1
}

# Masaustu Rust kodunun (apps/desktop/src-tauri/src) okudugu SMITH_* anahtarlari.
# Denylist degil allowlist: listede olmayan hicbir degisken dosyaya girmez.
$allowKeys = @(
    "SMITH_BOOT_CONTEXT",
    "SMITH_CODEX_BIN",
    "SMITH_CODE_AGENT",
    "SMITH_CODE_AGENT_MODEL",
    "SMITH_CODE_AGENT_TIMEOUT_S",
    "SMITH_CONVERSATION_MEMORY",
    "SMITH_CONTEXT_EXCLUDE",
    "SMITH_DATA_DIR",
    "SMITH_DEV_EMAIL",
    "SMITH_DEV_WORKSPACE",
    "SMITH_ECHO_GATE",
    "SMITH_GATEWAY_HTTP",
    "SMITH_GEMINI_KEY",
    "SMITH_JOB_MAX_S",
    "SMITH_LISTEN_MODE",
    "SMITH_LIVE",
    "SMITH_LIVE_COMPRESS",
    "SMITH_LIVE_COMPRESS_TRIGGER",
    "SMITH_LIVE_MODEL",
    "SMITH_LIVE_RESUME",
    "SMITH_LIVE_SILENCE_MS",
    "SMITH_LOG_TRANSCRIPT",
    "SMITH_MIC_GAIN",
    "SMITH_MIC_GATE",
    "SMITH_MIC_STREAM",
    "SMITH_MISSION_OPEN",
    "SMITH_ONLY_OWNER",
    "SMITH_REMINDERS",
    "SMITH_REPO_DIR",
    "SMITH_SCREEN",
    "SMITH_SCREEN_INTERVAL_MS",
    "SMITH_SCREEN_MAX_EDGE",
    "SMITH_SCREEN_MONITORS",
    "SMITH_SCREEN_QUALITY",
    "SMITH_SPEAKER_SIDECAR",
    "SMITH_THINK_API_KEY",
    "SMITH_THINK_BASE_URL",
    "SMITH_THINK_CLAUDE_MODEL",
    "SMITH_THINK_ENGINE",
    "SMITH_THINK_MODEL",
    "SMITH_THINK_TIMEOUT_S",
    "SMITH_VAULT_DIR",
    "SMITH_WINDOW_PLAIN"
)

$devWin = Join-Path $ScriptsDir "dev-win.ps1"
if (-not (Test-Path -LiteralPath $devWin)) {
    Fail "dev-win.ps1 bulunamadi: $devWin (-ScriptsDir ile dizini ver)"
}

# dev-win.ps1 PATH/LIBCLANG'i de ayarlar ve banner basar; bu surec kisa omurlu,
# yan etkiler disari sizmaz. Cikti yutulur (degerler zaten yazdirmaz, ama
# ileride yazdirmasin diye).
. $devWin *> $null

$pairs = New-Object System.Collections.Generic.List[string]
$names = New-Object System.Collections.Generic.List[string]
$skipped = New-Object System.Collections.Generic.List[string]

foreach ($item in (Get-ChildItem Env: | Where-Object { $allowKeys -contains $_.Name } | Sort-Object Name)) {
    $name = $item.Name
    $value = [string]$item.Value

    if ($value.Length -eq 0) {
        # Bos deger yazmanin anlami yok; uygulamada "tanimsiz" ile ayni sonuc.
        $skipped.Add($name)
        continue
    }
    if ($value -match "[\r\n\0]") {
        # Satir tabanli dosya tasiyamaz.
        $skipped.Add($name)
        continue
    }

    # Ayristirici cevreleyen ESLESEN tirnagi sokuyor ve kacis islemez. Bas/son
    # bosluk veya tirnak iceren deger tirnaklanir; ikisi birden varsa tasinamaz.
    $text = $value
    if ($value -ne $value.Trim() -or $value.StartsWith('"') -or $value.StartsWith("'")) {
        if (-not $value.Contains('"')) {
            $text = '"' + $value + '"'
        } elseif (-not $value.Contains("'")) {
            $text = "'" + $value + "'"
        } else {
            $skipped.Add($name)
            continue
        }
    }

    $pairs.Add("$name=$text")
    $names.Add($name)
}

if ($names.Count -eq 0) {
    Fail "Yazilacak SMITH_* degiskeni bulunamadi (dev-win.ps1 hicbirini ayarlamadi)."
}

# Masaustunun tek zorunlu sirri: yoksa paketli exe "Ses motoru baslatilamadi"
# der ve stderr de yoktur. dev-secrets.local.ps1 yalniz ana kopyada durur;
# baska bir worktree'den -ScriptsDir'siz calisirken buraya duser. Anahtarsiz
# bir dosyanin mevcut dosyanin USTUNE yazilmasi da zarar olur.
if (-not ($names -contains "SMITH_GEMINI_KEY")) {
    $msg = "SMITH_GEMINI_KEY yok: dev-secrets.local.ps1 bulunamadi veya anahtari ayarlamiyor (-ScriptsDir ile ana kopyanin scripts dizinini ver)."
    if ($ListOnly) {
        Write-Warning $msg
    } else {
        Fail "$msg Dosya yazilmadi."
    }
}

Write-Host "[smith-env-export] $($names.Count) anahtar: $($names -join ', ')"
if ($skipped.Count -gt 0) {
    Write-Host "[smith-env-export] atlanan: $($skipped -join ', ')"
}

if ($ListOnly) {
    Write-Host "[smith-env-export] -ListOnly: dosya yazilmadi."
    exit 0
}

$dir = Split-Path -Parent $OutFile
if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

# 1) Bos gecici dosya + yalniz mevcut kullanici ACL'i, 2) icerik, 3) yerine tasi.
$tmp = "$OutFile.tmp"
New-Item -ItemType File -Path $tmp -Force | Out-Null
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $tmp /inheritance:r /grant:r "*${sid}:(F)" | Out-Null
if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    Fail "icacls basarisiz (exit $LASTEXITCODE); dosya yazilmadi."
}

$header = "# Smith env dosyasi - scripts\smith-env-export.ps1 uretti. Elle duzenleme serbest.`n" +
    "# Uygulama yalniz surecte TANIMSIZ olan anahtarlari yukler.`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($tmp, $header + ($pairs -join "`n") + "`n", $utf8NoBom)
Move-Item -LiteralPath $tmp -Destination $OutFile -Force

Write-Host "[smith-env-export] yazildi: $OutFile (ACL: yalniz mevcut kullanici)"
