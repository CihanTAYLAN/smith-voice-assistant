# Smith surekli farkindalik taramasi - uc tarayiciyi sirayla kosturur (ADR 0006).
#
# NE YAPAR: Smith'in "kurulu oldugu makineyi ve dosya sistemini surekli
# goruyor" olmasini saglayan periyodik tazeleme. Uc tarayici:
#   machine  -> machine_state_connector.py  (donanim, disk, servisler)
#   fs       -> fs_xray_connector.py        (dizin agaci rontgeni + delta)
#   intel    -> intel_connector.py          (PH + TAAFT + HN gunluk brifi)
#
# NEDEN AYRI BIR SCRIPT: `ingest-all.ps1` BIR KERELIK dolum icindir (77 repo,
# 1004 not) ve DB'den exclude listesi uretir. Bu script PERIYODIK tazelemedir;
# delta mantigi konnektorlerin KENDI durum dosyalarinda
# (<veri koku>\awareness\*.json) yasar, DB sorgusu gerektirmez. Iki
# hattin karistirilmasi kotayi yakar; bu yuzden ayri durur.
#
# KOTA: tarayicilar degisiklik yoksa SIFIR embed harcar. Her adimin
# "EMBED HARCANAN: n" satiri toplanir ve sonda raporlanir.
#
# Kullanim:
#   .\scripts\awareness-scan.ps1                 # uc tarayici
#   .\scripts\awareness-scan.ps1 -Only fs        # tek tarayici
#   .\scripts\awareness-scan.ps1 -DryRun         # POST yok
#   .\scripts\awareness-scan.ps1 -Force          # delta kapisini atla (kota harcar)
#   .\scripts\awareness-scan.ps1 -SkipIntel      # saatlik kosu: istihbarat haric

[CmdletBinding()]
param(
    [ValidateSet('all', 'machine', 'fs', 'intel')]
    [string]$Only = 'all',
    [switch]$DryRun,
    [switch]$Force,
    [switch]$SkipIntel,
    [int]$CooldownSeconds = 5,
    [string]$LogPath
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Sidecar = Join-Path $RepoRoot 'apps\desktop\sidecar'
$Python = Join-Path $Sidecar '.venv\Scripts\python.exe'
$Gateway = 'http://127.0.0.1:4100'

# DURUM/LOG DIZINI tek veri kokunun altindadir (<veri koku>\awareness; kok: SMITH_DATA_DIR
# ya da %USERPROFILE%\.smith, bkz. smith-common.ps1), AppData altinda DEGIL.
# TUZAK (olculdu): MSIX paketli bir uygulamanin icinden yazilan AppData yollari
# sessizce paketin sanal deposuna yonlendirilir. Ayni yolu ZAMANLANMIS GOREV
# okudugunda dosyayi GORMEZ - gorev "dosya yok" diye duser ve delta durumu her
# kosuda bos gorunur. Veri koku sanallastirilmaz. Konnektorler (Python) ayni koku
# smith_paths.py ile cozer.
. (Join-Path $PSScriptRoot 'smith-common.ps1')
$AwarenessDir = Join-Path (Get-SmithDataDir) 'awareness'
New-Item -ItemType Directory -Force -Path $AwarenessDir | Out-Null
if (-not $LogPath) { $LogPath = Join-Path $AwarenessDir 'awareness-scan.log' }

# LOG DONDURME: log 1 MB'i asinca `.1` olarak tek yedege tasinir (eski yedegin ustune
# yazilir). Saatlik kosu her turda ekler, log sinirsiz buyumesin. Basarisizlik
# (ornegin dosya baska surecte acik) taramayi DUSURMEZ ama gorunur uyari verir.
$LogMaxBytes = 1MB
if ((Test-Path -LiteralPath $LogPath) -and ((Get-Item -LiteralPath $LogPath).Length -gt $LogMaxBytes)) {
    Move-Item -LiteralPath $LogPath -Destination ($LogPath + '.1') -Force -ErrorAction Continue
    if (Test-Path -LiteralPath $LogPath) {
        Write-Warning "Log dondurulemedi (1 MB asildi, dosya hala yerinde): $LogPath"
    }
}

# Konnektor ciktisi UTF-8'dir (Turkce ozet metinleri). Konsol kod sayfasi
# cp1254 kalirsa log dosyasina bozuk karakter yazilir.
$PrevEncoding = [Console]::OutputEncoding
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$script:LogLines = New-Object System.Collections.Generic.List[string]

function Write-Log([string]$Text, [string]$Color = 'Gray') {
    $stamped = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text
    $script:LogLines.Add($stamped)
    Write-Host $Text -ForegroundColor $Color
}

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Log "=== $Text" 'Cyan'
}

function Test-Preflight {
    if (-not (Test-Path $Python)) {
        throw "Sidecar python yok: $Python"
    }
    Write-Log "    python ok ($(& $Python --version 2>&1))"

    if ($DryRun) {
        Write-Log '    gateway kontrolu atlandi (kuru calistirma)'
        return
    }
    # Gateway kapaliysa TEMIZ hata: konnektorler tek tek 'Connection refused'
    # ile dusup yaniltici "0 embed" raporlamasin.
    try {
        $health = Invoke-RestMethod -Uri "$Gateway/v1/health" -TimeoutSec 8
    } catch {
        throw "Gateway $Gateway yanit vermiyor. Farkindalik taramasi hafizaya yazamaz. Once baslat: .\scripts\gateway-dev.ps1"
    }
    if (-not $health.ok) {
        throw "Gateway saglikli degil: $($health | ConvertTo-Json -Compress)"
    }
    Write-Log "    gateway ok (protocolVersion $($health.protocolVersion))"
}

function Invoke-Scanner([string]$Name, [string]$Script, [string[]]$ExtraArgs) {
    $path = Join-Path $Sidecar $Script
    if (-not (Test-Path $path)) { throw "Tarayici yok: $path" }

    $scanArgs = @()
    if ($DryRun) { $scanArgs += '--dry-run' }
    if ($Force) { $scanArgs += '--force' }
    $scanArgs += $ExtraArgs

    Write-Log "    calistiriliyor: $Script $($scanArgs -join ' ')"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    # Bir tarayicinin dusmesi digerlerini iptal ETMEMELI: farkindalik katmani
    # kismi da olsa tazelenir.
    $ErrorActionPreference = 'Continue'
    $output = & $Python $path @scanArgs 2>&1 | ForEach-Object { "$_" }
    $exit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $sw.Stop()

    foreach ($line in $output) { $script:LogLines.Add("    | $line"); Write-Host "    | $line" -ForegroundColor DarkGray }

    # Her tarayici son satirlarinda "EMBED HARCANAN: n" basar; kota takibi
    # tahminle degil tarayicinin kendi sayimiyla yapilir.
    $embed = 0
    $match = $output | Select-String -Pattern '^EMBED HARCANAN:\s*(\d+)' | Select-Object -Last 1
    if ($match) { $embed = [int]$match.Matches[0].Groups[1].Value }

    $status = if ($exit -eq 0) { 'ok' } else { "hata (exit $exit)" }
    Write-Log ("    {0} bitti: {1}, {2}s, embed {3}" -f $Name, $status, [int]$sw.Elapsed.TotalSeconds, $embed)
    return [pscustomobject]@{
        Tarayici = $Name
        Durum    = $status
        Saniye   = [int]$sw.Elapsed.TotalSeconds
        Embed    = $embed
        Exit     = $exit
    }
}

$results = @()
try {
    Write-Step 'Smith farkindalik taramasi - on kontrol'
    Test-Preflight
    Write-Log "    durum dosyalari: $AwarenessDir"

    # Sira bilincli: makine durumu en hizli ve en az kota harcayan; istihbarat
    # (ag'a giden, en yavas) en sonda.
    if ($Only -in @('all', 'machine')) {
        Write-Step 'Makine durumu (donanim / disk / servisler)'
        $results += Invoke-Scanner 'machine' 'machine_state_connector.py' @()
        if ($Only -eq 'all') { Start-Sleep -Seconds $CooldownSeconds }
    }

    if ($Only -in @('all', 'fs')) {
        Write-Step 'Dosya sistemi rontgeni'
        $results += Invoke-Scanner 'fs' 'fs_xray_connector.py' @()
        if ($Only -eq 'all') { Start-Sleep -Seconds $CooldownSeconds }
    }

    if ($Only -in @('all', 'intel')) {
        if ($SkipIntel -and $Only -eq 'all') {
            Write-Step 'Istihbarat - ATLANDI (-SkipIntel; saatlik kosuda gunluk brif gereksiz)'
        } else {
            Write-Step 'Dis istihbarat (Product Hunt / TAAFT / Hacker News)'
            $results += Invoke-Scanner 'intel' 'intel_connector.py' @()
        }
    }

    Write-Step 'Sonuc'
    $table = $results | Format-Table -AutoSize | Out-String
    Write-Host $table
    foreach ($line in ($table -split "`r?`n" | Where-Object { $_.Trim() })) { $script:LogLines.Add("    $line") }

    $totalEmbed = ($results | Measure-Object -Property Embed -Sum).Sum
    if (-not $totalEmbed) { $totalEmbed = 0 }
    $failed = @($results | Where-Object { $_.Exit -ne 0 })
    Write-Log "TOPLAM EMBED HARCANAN: $totalEmbed (kota takibi)" 'Green'
    if ($failed.Count -gt 0) {
        Write-Log "UYARI: $($failed.Count) tarayici hata verdi: $(($failed.Tarayici) -join ', ')" 'Yellow'
    }
    if ($DryRun) { Write-Log 'KURU CALISTIRMA: hicbir kayit yazilmadi.' 'Yellow' }
} catch {
    Write-Log "TARAMA DUSTU: $($_.Exception.Message)" 'Red'
    # Log'u yaz, sonra hatayi yukari tasi: zamanlanmis gorev exit kodunu gorsun.
    Add-Content -Path $LogPath -Value $script:LogLines -Encoding utf8
    [Console]::OutputEncoding = $PrevEncoding
    exit 1
} finally {
    [Console]::OutputEncoding = $PrevEncoding
}

Add-Content -Path $LogPath -Value $script:LogLines -Encoding utf8
Write-Host "Log: $LogPath" -ForegroundColor DarkGray
if ($failed.Count -gt 0) { exit 1 }
