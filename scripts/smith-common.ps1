# Smith 7/24 calistirma betiklerinin ortak yardimcilari.
# Kullananlar: smith-up.ps1, smith-watchdog.ps1, smith-autostart.ps1,
# pg-backup.ps1, awareness-install-task.ps1, awareness-scan.ps1, gateway-dev.ps1,
# speaker-server.ps1, smith-servers.ps1, live-usage-report.ps1, smith-env-export.ps1,
# smith-migrate-data.ps1.
#
# DOT-SOURCE edilir (`. (Join-Path $PSScriptRoot 'smith-common.ps1')`); yalniz
# fonksiyon tanimlar, yan etkisi yoktur. Hem Windows PowerShell 5.1 hem pwsh 7
# ile calismali; dosya SAF ASCII (BOM'suz dosyada Turkce karakter / em dash 5.1'de
# betigi kirar, bkz. scripts/check-ps1-ascii.sh).
#
# NEDEN Invoke-SmithNative: `$ErrorActionPreference = 'Stop'` altinda 5.1,
# native komutun stderr'ini (docker compose ilerleme satirlari dahil) ErrorRecord'a
# cevirip betigi dusurur. Native komutlar Start-Process + dosyaya yonlendirme ile
# kosulur: ciktisi, cikis kodu ve zaman asimi iki kabukta da ayni davranir.

$script:SmithLogName = $null

# --- Dizinler ---------------------------------------------------------------

# VERI KOKU: Smith'in TUM yerel durum dosyalari (log, health.json, last-backup.json,
# session-secret, ses izi, pencere konumu, awareness durumu, ...) tek kokte durur.
# TEK KURAL, her calisma ortaminda ayni (Rust src-tauri/src/paths.rs, Python
# sidecar/smith_paths.py, Node apps/worker/src/engines/run-dir.ts):
#   1) SMITH_DATA_DIR tanimli ve bos degilse o,
#   2) degilse %USERPROFILE%\.smith (Windows disinda ~/.smith).
# ASLA %LOCALAPPDATA% / %APPDATA% altinda DEGIL: MSIX paketli bir uygulamanin (Claude
# Desktop) icinden baslatilan surecler AppData yazilarini gizli paket klasorune
# yonlendirir (AppData\Local\Packages\<aile>\LocalCache\...); zamanlanmis gorev ve
# kullanici terminali ise GERCEK AppData'yi gorur. Sonuc iki ayri "gercek" (2026-10-03:
# ses izi, yedek aynasi ayari, gunlukler, oturum sirri, smith-up kilidi ve health.json
# ikiye bolundu). %USERPROFILE% yonlendirilmez. Kapi: scripts/check-data-root.mjs.

# Yan etkisiz cozumleme: dizin olusturmaz, uyari basmaz (tasima betigi -DryRun'da hicbir
# sey yazmasin). Mutlak yol ver; goreli SMITH_DATA_DIR oldugu gibi doner.
function Resolve-SmithDataDir {
    param(
        [string]$DataDir = $env:SMITH_DATA_DIR,
        [string]$UserProfile = $env:USERPROFILE
    )
    if (-not [string]::IsNullOrWhiteSpace($DataDir)) { return $DataDir.Trim() }
    if ([string]::IsNullOrWhiteSpace($UserProfile)) { $UserProfile = $env:HOME }
    if ([string]::IsNullOrWhiteSpace($UserProfile)) {
        throw 'Veri koku cozulemedi: SMITH_DATA_DIR ve USERPROFILE/HOME tanimsiz.'
    }
    return (Join-Path $UserProfile.Trim() '.smith')
}

# Veri kokunu doner, dizini olusturur ve eski konumda tasinmamis veri varsa surec basina
# BIR KEZ acik uyari yazar (bilesenler eski konuma yazmaz, yeni kokle devam eder).
function Get-SmithDataDir {
    $dir = Resolve-SmithDataDir
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Write-SmithLegacyDataNotice -DataDir $dir
    return $dir
}

# --- Eski (AppData tabanli) veri konumlari: yalniz tasima betigi ve acilis uyarisi ----

# MSIX paketinin (Claude Desktop) AppData sanal deposunun aile adi. Paket icinden yazilan
# AppData yollarinin gercek fiziksel yeri: AppData\Local\Packages\<aile>\LocalCache\Local.
$script:SmithMsixPackageFamily = 'Claude_pzs8sxrjxfjjc'
# Tasima betigi -Apply ile veri kokune bu isaret dosyasini yazar; varligi "eski konumdaki
# veri icin karar verildi" demektir ve acilis uyarisini susturur.
$script:SmithMigrationMarker = '.veri-koku-tasindi'
# Kopyalanmayan ve veri sayilmayan adlar: kilit ve gecici dosyalar (Rust/Python ile ayni liste).
$script:SmithMigrationIgnoredRegex = '\.(lock|tmp|migrate-part)$'

function Test-SmithMigrationIgnoredName([string]$Name) {
    return ($Name.ToLowerInvariant() -cmatch $script:SmithMigrationIgnoredRegex)
}

# Eski veri konumlari: gercek %LOCALAPPDATA%\smith ve paket kopyasi. Hicbir bilesen artik
# buralara yazmaz. Claude oturumundan calisan surec gercek konumu GOREMEZ (ayni addaki
# paket kopyasi golgeler); bu yuzden tasima betigi gercek kaynagi -RealRoot ya da WSL
# yoluyla da okuyabilir.
function Get-SmithLegacyDataRoots {
    param([string]$LocalAppData = $env:LOCALAPPDATA)
    if ([string]::IsNullOrWhiteSpace($LocalAppData)) { return @() }
    return @(
        [pscustomobject]@{ Label = 'gercek'; Path = (Join-Path $LocalAppData 'smith') },
        [pscustomobject]@{
            Label = 'paket'
            Path  = (Join-Path $LocalAppData ('Packages\{0}\LocalCache\Local\smith' -f $script:SmithMsixPackageFamily))
        }
    )
}

# $Path altinda (baglanti izlenmez, en cok $Budget girdi) veri sayilan ilk dosya var mi.
function Test-SmithLegacyDirHasData {
    param([string]$Path, [int]$Budget = 5000)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
    $stack = New-Object 'System.Collections.Generic.Stack[string]'
    $stack.Push($Path)
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        foreach ($item in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
            $Budget--
            if ($Budget -lt 0) { return $false }
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
            if ($item.PSIsContainer) { $stack.Push($item.FullName); continue }
            if (-not (Test-SmithMigrationIgnoredName $item.Name)) { return $true }
        }
    }
    return $false
}

# Veri kokunde tasima isareti yoksa ve eski konumlarda veri varsa uyari metni, yoksa $null.
function Get-SmithLegacyDataNotice {
    param([Parameter(Mandatory = $true)][string]$DataDir, $LegacyRoots = (Get-SmithLegacyDataRoots))
    if (Test-Path -LiteralPath (Join-Path $DataDir $script:SmithMigrationMarker)) { return $null }
    $withData = @($LegacyRoots | Where-Object { Test-SmithLegacyDirHasData $_.Path })
    if ($withData.Count -eq 0) { return $null }
    $where = ($withData | ForEach-Object { '{0}: {1}' -f $_.Label, $_.Path }) -join '; '
    return ('veri koku bos veya tasinmamis ({0}); eski konumda veri var ({1}). Eski konuma YAZILMAZ, yeni kokle devam ediliyor. Veri koku bos, tasima betigini calistir: pwsh scripts\smith-migrate-data.ps1 (once -DryRun, sonra -Apply)' -f $DataDir, $where)
}

$script:SmithLegacyNoticeDone = $false

# Surec basina bir kez. Bayrak ONCE kurulur: Write-SmithLog -> Get-SmithLogDir ->
# Get-SmithDataDir -> bu fonksiyon yinelemesini keser.
function Write-SmithLegacyDataNotice {
    param([Parameter(Mandatory = $true)][string]$DataDir)
    if ($script:SmithLegacyNoticeDone) { return }
    $script:SmithLegacyNoticeDone = $true
    $msg = Get-SmithLegacyDataNotice -DataDir $DataDir
    if ($msg) { Write-SmithLog $msg 'WARN' }
}

function Get-SmithLogDir {
    $dir = Join-Path (Get-SmithDataDir) 'logs'
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    return $dir
}

# --- Log / JSON -------------------------------------------------------------

function Set-SmithLogName([string]$Name) { $script:SmithLogName = $Name }

# Ekrana yazar; Set-SmithLogName verildiyse logs\<ad>-<yyyyMMdd>.log dosyasina da ekler.
function Write-SmithLog {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Write-Host $line
    if ($script:SmithLogName) {
        $path = Join-Path (Get-SmithLogDir) ('{0}-{1}.log' -f $script:SmithLogName, (Get-Date -Format 'yyyyMMdd'))
        [System.IO.File]::AppendAllText($path, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    }
}

# Atomik JSON yazimi (gecici dosya + tasima): okuyan yarim dosya gormez. BOM'suz UTF-8.
function Write-SmithJson {
    param([string]$Path, $Object, [int]$Depth = 6)
    $json = $Object | ConvertTo-Json -Depth $Depth
    $tmp = $Path + '.tmp'
    [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

# Dosya yoksa $null. Bozuk JSON'u yutmaz: ConvertFrom-Json hatasi yukari cikar.
function Read-SmithJson {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = [System.IO.File]::ReadAllText($Path)
    if (-not $text.Trim()) { return $null }
    return ($text | ConvertFrom-Json)
}

# Smith'in KENDI urettigi tarihli log adlari (tek dogruluk kaynagi):
#   <ad>-<yyyyMMdd>.log          Write-SmithLog (smith-up, watchdog, pg-backup) ve
#                                smith-up'in bilesen yonlendirmesi (gateway, worker, ...)
#   <ad>-<yyyyMMdd>-stderr.log   smith-up masaustu stderr yonlendirmesi
# Izin listesi: smith-up Start-ScriptComponent/Start-HiddenShell ve betiklerin
# Set-SmithLogName cagrilari. smith-watchdog.ps1 gercekte 'watchdog' uretir.
$script:SmithLogProducers = @('gateway', 'worker', 'speaker', 'stt', 'desktop', 'smith-up', 'watchdog', 'pg-backup')
# [0-9]: .NET'te \d Unicode rakamlarla da eslesir. \z mutlak dosya adi sonudur.
$script:SmithLogNameRegex = '^(?<producer>[a-z]+(?:-[a-z]+)*)-(?<date>[0-9]{8})(?<stderr>-stderr)?\.log\z'

# -cmatch (buyuk/kucuk harf DUYARLI): uretilen adlar kucuk harftir. Duyarsiz -match Windows
# PowerShell 5.1'de tr-TR kulturunde [A-Za-z] sinifinda buyuk 'I'yi kacirir (bkz.
# ConvertFrom-SmithEncodedCommand); silme kapisi kultur davranisina baglanmasin.
function Test-SmithLogName([string]$Name) {
    if ($Name -cnotmatch $script:SmithLogNameRegex) { return $false }
    if ($Matches['producer'] -cnotin $script:SmithLogProducers) { return $false }
    if ($Matches['stderr'] -and $Matches['producer'] -cne 'desktop') { return $false }
    $date = [datetime]::MinValue
    return [datetime]::TryParseExact($Matches['date'], 'yyyyMMdd',
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::None, [ref]$date)
}

# Tarihli loglari (<ad>-<yyyyMMdd>.log) $Days gunden eskiyse siler. Tarihsiz loglara
# (ornegin smith-servers.ps1'in speaker.log'u) dokunmaz.
#
# JOKER TUZAGI: Win32 joker eslesmesinde `?` uzanti noktasindan once SIFIR karakterle de
# eslesir, yani eski `-Filter '*-????????.log'` `desktop-cargo.log` gibi tarihsiz tani
# loglarini da aday yapti ve kalici sildi. -Filter yalniz GENIS aday listesi icindir
# (`*.log`); silmeden once ad Test-SmithLogName ile TAM regex'e dogrulanir.
#
# KILITLI LOG: bilesen loglari cmd '>>' yonlendirmesiyle acik tutulur; 7/24 calisan bir
# bilesenin acilis gunu logu 7 gunden eski olsa da surec yasadikca silinemez
# (IOException) ve LastWriteTime guncellenemez. Kilitli dosya atlanir (sonraki turda
# yeniden denenir), kalan eski loglarin silinmesi kesilmez. Cikis: { Removed; Locked }.
function Remove-OldSmithLogs {
    param([int]$Days = 7)
    $cutoff = (Get-Date).AddDays(-$Days)
    $removed = @()
    $locked = @()
    foreach ($f in @(Get-ChildItem -LiteralPath (Get-SmithLogDir) -Filter '*.log' -File)) {
        if (-not (Test-SmithLogName $f.Name)) { continue }
        if ($f.LastWriteTime -lt $cutoff) {
            try {
                Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop
                $removed += $f.Name
            } catch [System.IO.IOException] {
                $locked += $f.Name
            }
        }
    }
    return [pscustomobject]@{ Removed = $removed; Locked = $locked }
}

# --- Yoklamalar -------------------------------------------------------------

# Salt okur: C: ve Docker VHDX yolunun surucusu (ayniysa tek kayit).
# DriveMetrics test dikisi: @{ 'C:' = @{ FreeGB = 12; TotalGB = 100 } }.
# GB = 1GB (1024^3 bayt); esik TAM altinda tetiklenir, yuvarlama yalniz gosterimde.
function Get-SmithDiskStatus {
    param(
        [string]$DockerDataPath = (Join-Path $env:LOCALAPPDATA 'Docker\wsl\disk\docker_data.vhdx'),
        [hashtable]$DriveMetrics,
        [double]$WarnGB = $(if ($env:SMITH_DISK_WARN_GB) { [double]$env:SMITH_DISK_WARN_GB } else { 10 }),
        [double]$CritGB = $(if ($env:SMITH_DISK_CRIT_GB) { [double]$env:SMITH_DISK_CRIT_GB } else { 5 })
    )
    if (-not ($CritGB -gt 0 -and $WarnGB -gt $CritGB -and $WarnGB -lt [double]::PositiveInfinity)) {
        throw 'Disk esikleri: 0 < SMITH_DISK_CRIT_GB < SMITH_DISK_WARN_GB olmali.'
    }
    if ($DockerDataPath -cnotmatch '^(?<drive>[A-Za-z]):[\\/]') {
        throw 'DockerDataPath mutlak bir Windows surucu yolu olmali.'
    }
    $dockerDrive = $Matches['drive'].ToUpperInvariant() + ':'
    $drives = @('C:')
    if ($dockerDrive -cne 'C:') { $drives += $dockerDrive }
    foreach ($drive in $drives) {
        if ($null -ne $DriveMetrics) {
            if (-not $DriveMetrics.ContainsKey($drive)) { throw "Disk olcumu eksik: $drive" }
            $free = [double]$DriveMetrics[$drive].FreeGB
            $total = [double]$DriveMetrics[$drive].TotalGB
        } else {
            $info = [System.IO.DriveInfo]::new($drive + '\')
            $free = $info.AvailableFreeSpace / 1GB
            $total = $info.TotalSize / 1GB
        }
        $level = 'ok'
        if ($free -lt $CritGB) { $level = 'kritik' }
        elseif ($free -lt $WarnGB) { $level = 'uyari' }
        [pscustomobject]@{ Drive = $drive; FreeGB = $free; TotalGB = $total; Seviye = $level }
    }
}

# Kapasite uyarisi hizmet kesintisi degildir. Iki tuketici ayni health sozlesmesini kullanir.
function Get-SmithDiskHealth {
    param([object[]]$Disks = @(Get-SmithDiskStatus))
    $level = 'ok'
    if (@($Disks | Where-Object { $_.Seviye -eq 'kritik' }).Count -gt 0) { $level = 'kritik' }
    elseif (@($Disks | Where-Object { $_.Seviye -eq 'uyari' }).Count -gt 0) { $level = 'uyari' }
    $details = @($Disks | ForEach-Object {
        '{0} {1} GB bos / {2} GB ({3})' -f $_.Drive,
            $_.FreeGB.ToString('0.##', [System.Globalization.CultureInfo]::InvariantCulture),
            $_.TotalGB.ToString('0.##', [System.Globalization.CultureInfo]::InvariantCulture), $_.Seviye
    })
    return [pscustomobject]@{
        up = $true; durum = 'up'; ardisikBasarisizlik = 0
        seviye = $level; detay = ($details -join '; '); suruculer = @($Disks)
    }
}

# Saf zaman karari. Son bildirim surucu+seviye bazinda tutulur: kritik gecisi
# hemen bildirilir, seviye dalgalanmasi onceki bildirim zamanini sifirlamaz.
function Test-SmithDiskAlertDue {
    param(
        [ValidateSet('ok', 'uyari', 'kritik')][string]$Seviye,
        $LastNotification,
        [datetimeoffset]$Now = [datetimeoffset]::UtcNow
    )
    if ($Seviye -eq 'ok') { return $false }
    if (-not $LastNotification) { return $true }
    $minutes = 360
    if ($Seviye -eq 'kritik') { $minutes = 30 }
    # pwsh ConvertFrom-Json ISO tarihleri DateTime'a cevirebilir: saat dilimini ve
    # saniye alti hassasiyeti string cast ile kaybetme (5.1 ise string dondurur).
    if ($LastNotification -is [datetime] -or $LastNotification -is [datetimeoffset]) {
        $last = [datetimeoffset]$LastNotification
    } else {
        $last = [datetimeoffset]::Parse($LastNotification, [System.Globalization.CultureInfo]::InvariantCulture)
    }
    return ($Now - $last).TotalMinutes -ge $minutes
}

function Test-SmithTcpPort {
    param([int]$Port, [int]$TimeoutMs = 800)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        $client.EndConnect($iar)
        return $client.Connected
    } catch [System.Net.Sockets.SocketException] {
        return $false
    } finally {
        $client.Close()
    }
}

# Yanit 2xx ve govde JSON'da ok=true ise Up. Baglanti hatasi "kapali" demektir.
function Test-SmithHealthUrl {
    param([string]$Url, [int]$TimeoutSec = 4)
    # Istisna turu kabuga gore degisir (5.1: WebException, pwsh 7: HttpRequestException /
    # HttpResponseException); yoklamada "saglikli yanit alinamadi" tek anlamdir, neden
    # Detail'de saklanir.
    try {
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec
    } catch {
        return [pscustomobject]@{ Up = $false; Detail = $_.Exception.Message }
    }
    $body = $resp.Content | ConvertFrom-Json -ErrorAction SilentlyContinue
    if ($body -and $body.ok -eq $true) {
        return [pscustomobject]@{ Up = $true; Detail = "HTTP $($resp.StatusCode)" }
    }
    return [pscustomobject]@{ Up = $false; Detail = "HTTP $($resp.StatusCode), govde ok=true degil" }
}

# --- Native komut -----------------------------------------------------------

# Surec agacini (kok surec + tum cocuklari) durdurur. NEDEN: scp.exe kendi ssh.exe
# cocugunu baslatir; yalniz kok surec olurse cocuk yonlendirme dosyalarini tutmaya devam
# eder (2026-10-03 yedek aynasi takilmasi). .NET Framework (5.1) Process.Kill(agac)
# bilmez; taskkill /T /F iki kabukta da ayni calisir. Invoke-SmithNative'i KULLANMAZ
# (zaman asimi yinelemesi), pencere acmaz.
function Stop-SmithProcessTree {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    if (Test-Path -LiteralPath $taskkill) {
        $k = Start-Process -FilePath $taskkill -ArgumentList @('/PID', "$ProcessId", '/T', '/F') -WindowStyle Hidden -PassThru
        $null = $k.Handle
        if (-not $k.WaitForExit(15000)) { Stop-Process -Id $k.Id -Force -ErrorAction SilentlyContinue }
    } else {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    }
}

# Yonlendirme dosyasini PAYLASIMLI okur (FileShare.ReadWrite): kalan bir cocuk surec dosyayi
# yazmaya acik tutsa bile okuma dusmez. File.ReadAllText FileShare.Read ile acar ve
# "being used by another process" ile patlar.
function Read-SmithSharedText([string]$Path) {
    $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
    try {
        $reader = New-Object System.IO.StreamReader($fs, (New-Object System.Text.UTF8Encoding($false)), $true)
        try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally {
        $fs.Dispose()
    }
}

# Cikis: ExitCode (zaman asiminda -1), TimedOut, Output (stdout), Error (stderr).
# Zaman asiminda SUREC AGACI durdurulur ve cikti dosyalari paylasimli okunur.
function Invoke-SmithNative {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int]$TimeoutSec = 60
    )
    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    try {
        $quoted = (@($ArgumentList) | ForEach-Object {
                if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
            }) -join ' '
        $sp = @{
            FilePath               = $FilePath
            PassThru               = $true
            WindowStyle            = 'Hidden'
            RedirectStandardOutput = $outFile
            RedirectStandardError  = $errFile
        }
        if ($quoted) { $sp.ArgumentList = $quoted }
        $p = Start-Process @sp
        $null = $p.Handle   # 5.1: ExitCode WaitForExit(ms) sonrasi bos donmesin diye tutamac onbellegi
        $timedOut = -not $p.WaitForExit($TimeoutSec * 1000)
        if ($timedOut) {
            Stop-SmithProcessTree -ProcessId $p.Id
            # Sonlandirma asenkron: tutamaclar kapanmadan okumaya baslama.
            $null = $p.WaitForExit(5000)
            $code = -1
        } else {
            $code = $p.ExitCode
        }
        return [pscustomobject]@{
            ExitCode = $code
            TimedOut = $timedOut
            Output   = (Read-SmithSharedText $outFile)
            Error    = (Read-SmithSharedText $errFile)
        }
    } finally {
        Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
    }
}

# --- Docker -----------------------------------------------------------------

function Get-DockerExe {
    $cmd = Get-Command docker -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    return $null
}

function Get-DockerDesktopExe {
    $exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path -LiteralPath $exe) { return $exe }
    return $null
}

# Motor yanit veriyor mu: `docker version --format {{.Server.Version}}` 30 sn icinde 0 doner ve
# surum bos degil. `docker info` ile ayni sinyal (daemon API'sine ulasir) ama ~3 kat hizli
# (0.5 sn vs 1.5-2.7 sn; Status/bekci her 5 dakikada bu yoklamayi yapar).
function Test-DockerEngine {
    $docker = Get-DockerExe
    if (-not $docker) { return [pscustomobject]@{ Up = $false; Version = $null; Detail = 'docker CLI bulunamadi' } }
    $r = Invoke-SmithNative -FilePath $docker -ArgumentList @('version', '--format', '{{.Server.Version}}') -TimeoutSec 30
    $ver = $r.Output.Trim()
    if ($r.TimedOut) { return [pscustomobject]@{ Up = $false; Version = $null; Detail = 'docker version 30 sn icinde yanit vermedi' } }
    if ($r.ExitCode -eq 0 -and $ver) { return [pscustomobject]@{ Up = $true; Version = $ver; Detail = "motor $ver" } }
    return [pscustomobject]@{ Up = $false; Version = $null; Detail = 'motor yanit vermiyor' }
}

# Motor hazir olana dek bekler. -StartIfNeeded: Docker Desktop calismiyorsa baslatir.
# Cikis: $true / $false (yalniz bool; baska cikti uretmez).
function Wait-DockerEngine {
    param([int]$TimeoutSec = 240, [switch]$StartIfNeeded)
    if ((Test-DockerEngine).Up) { return $true }
    if (-not $StartIfNeeded) { return $false }
    if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
        $exe = Get-DockerDesktopExe
        if (-not $exe) {
            Write-SmithLog 'Docker Desktop.exe bulunamadi, baslatilamiyor.' 'ERROR'
            return $false
        }
        Write-SmithLog "Docker Desktop baslatiliyor: $exe"
        Start-Process -FilePath $exe | Out-Null
    } else {
        Write-SmithLog 'Docker Desktop calisiyor ama motor yanit vermiyor, bekleniyor.'
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        if ((Test-DockerEngine).Up) {
            Write-SmithLog 'Docker motoru hazir.'
            return $true
        }
    }
    Write-SmithLog "Docker motoru $TimeoutSec sn icinde hazir olmadi." 'ERROR'
    return $false
}

# --- Bildirim ---------------------------------------------------------------

# Windows bildirimi, ek modul olmadan. Once WinRT toast (yalniz Windows PowerShell 5.1:
# pwsh 7'de WinRT projeksiyonu yok), olmazsa NotifyIcon balonu.
# Cikis: kullanilan yontem ('toast' | 'balloon') ya da 'none: <nedenler>'.
function Show-SmithToast {
    param([string]$Title, [string]$Message)
    $errors = @()
    if ($PSVersionTable.PSEdition -ne 'Core') {
        try {
            [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
            [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
            $t = [System.Security.SecurityElement]::Escape($Title)
            $m = [System.Security.SecurityElement]::Escape($Message)
            $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
            $xml.LoadXml("<toast><visual><binding template=`"ToastGeneric`"><text>$t</text><text>$m</text></binding></visual></toast>")
            $toast = New-Object Windows.UI.Notifications.ToastNotification($xml)
            # PowerShell'in kayitli AppUserModelID'si: kayitsiz kimlikle toast gosterilmez.
            $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
            [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
            return 'toast'
        } catch {
            $errors += "toast: $($_.Exception.Message)"
        }
    }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $ni = New-Object System.Windows.Forms.NotifyIcon
        try {
            $ni.Icon = [System.Drawing.SystemIcons]::Warning
            $ni.BalloonTipTitle = $Title
            $ni.BalloonTipText = $Message
            $ni.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Warning
            $ni.Visible = $true
            $ni.ShowBalloonTip(10000)
            Start-Sleep -Seconds 6
        } finally {
            $ni.Visible = $false
            $ni.Dispose()
        }
        return 'balloon'
    } catch {
        $errors += "balloon: $($_.Exception.Message)"
    }
    return 'none: ' + ($errors -join ' | ')
}

# --- Zamanlanmis gorev sarmalayicisi -----------------------------------------

# Gorev icin IKI PARCALI gizli sarmalayici uretir: .cmd (log yonlendirme + dondurme +
# cikis kodu) ve onu cagiran .vbs. Gorev wscript.exe ile .vbs'i acar.
#
# Bolunme bilinclidir: tek parcali surumde VBS tum komutu ic ice tirnaklarla kuruyordu;
# o surum elle kosulunca calisiyor ama ZAMANLANMIS GOREVDEN kosulunca wscript exit 1
# verip hicbir sey yazmiyordu (awareness-install-task.ps1'de olculdu). Kanitli desen:
# VBS yalniz TEK bir .cmd dosyasini cagirir, yonlendirme ve argumanlar .cmd'dedir.
#
# CIKIS KODU: VBS `Run(cmd, 0, True)` ile bekler ve `WScript.Quit` ile kodu dondurur;
# .cmd `exit /b %ERRORLEVEL%` ile betigin kodunu tasir. Eskiden `Run ..., 0, False`
# beklemeden donuyordu ve Task Scheduler her kosuyu 0 (basarili) gorurdu; betik
# dusse de LastTaskResult 0 kaliyordu.
#
# LOG DONDURME: yonlendirme (>>) .cmd'de oldugu icin betigin kendisi log'u dondu-
# remez; .cmd her kosu oncesi log 1 MB'i asmissa tek yedege (.1) tasir.
#
# Dosyalar kasten veri kokunun altinda olmali (Resolve-SmithDataDir: SMITH_DATA_DIR ya da
# %USERPROFILE%\.smith), AppData altinda DEGIL: MSIX paketli uygulamalardan yazilan
# AppData yollari sanal depoya yonlendirilir ve zamanlanmis gorev onlari goremez.
function Write-HiddenTaskShim {
    param(
        [Parameter(Mandatory = $true)][string]$VbsPath,
        [Parameter(Mandatory = $true)][string]$CmdPath,
        [Parameter(Mandatory = $true)][string]$Interpreter,
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string]$ScriptArgs = '',
        [Parameter(Mandatory = $true)][string]$LogFile,
        [string]$Title = 'Smith gorevi',
        [string]$Generator = 'scripts\smith-common.ps1'
    )
    $argPart = ''
    if ($ScriptArgs) { $argPart = ' ' + $ScriptArgs }
    $cmd = @"
@echo off
rem $Title - gorev sarmalayicisi.
rem URETILEN DOSYA: $Generator tarafindan yazilir; elle duzenleme, yeniden uret.
rem Log 1 MB'i asarsa tek yedege (.1) tasinir; cikis kodu gorev sonucuna tasinir.
if exist "$LogFile" for %%F in ("$LogFile") do if %%~zF GTR 1048576 move /y "$LogFile" "$LogFile.1" >nul
"$Interpreter" -NoProfile -ExecutionPolicy Bypass -File "$ScriptPath"$argPart >> "$LogFile" 2>&1
exit /b %ERRORLEVEL%
"@
    $vbs = @"
' $Title - gizli pencere sarmalayicisi.
' URETILEN DOSYA: $Generator tarafindan yazilir; elle duzenleme, yeniden uret.
' 0 = pencere gizli, True = bitmesini bekle; WScript.Quit kodu gorev sonucuna tasir.
Dim sh, rc
Set sh = CreateObject("WScript.Shell")
rc = sh.Run("cmd /c ""$CmdPath""", 0, True)
WScript.Quit rc
"@
    # cmd.exe LF-only .cmd dosyalarinda yanlis davranabilir: CRLF'e normalle.
    $crlf = [string]([char]13) + [string]([char]10)
    $cmd = [regex]::Replace($cmd, "\r?\n", $crlf)
    $vbs = [regex]::Replace($vbs, "\r?\n", $crlf)
    Set-Content -LiteralPath $CmdPath -Value $cmd -Encoding ASCII
    Set-Content -LiteralPath $VbsPath -Value $vbs -Encoding ASCII
}

# --- Masaustu dev launcher --------------------------------------------------

# Masaustu dev derlemesinin (`pnpm --filter @smith/desktop tauri dev`) komut satiri izi.
# Tirnak istege bagli: smith-up bunu `'@smith/desktop' tauri dev` diye yazar, pnpm sureci
# `@smith/desktop tauri dev` diye gorur. Desenler KUCUK harf; girdi ToLowerInvariant ile
# kucultulup -cmatch ile eslenir (kulturden bagimsiz, asagidaki TUZAK nota bak).
$script:DesktopDevCommandRegex = '@smith[/\\]desktop[''"]?\s+tauri\s+dev\b'
# tauri-cli node sureci (pnpm sureci olse bile derleme yasadikca o yasar).
$script:DesktopTauriCliRegex = 'apps[/\\]desktop[/\\]node_modules\S*tauri\.js"?\s+"?dev\b'
# Cargo alt sureci tek basina kalabilir. Yalniz run/build ve TAM crate/dizin
# belirteci kabul edilir; smith-desktop-tools veya src-tauri-other eslesmez.
$script:DesktopCargoCommandRegex = '^(?:"[^"]*cargo(?:\.exe)?"|\S*cargo(?:\.exe)?)\s+(?:\+\S+\s+)?(?:run|build)\b'
$script:DesktopCargoTargetRegex = '(?:^|[\s/\\"=])(?:smith-desktop|src-tauri)(?=$|[\s/\\"])'

# `-EncodedCommand <base64>` govdesini cozer (UTF-16LE); yoksa ya da bozuksa $null.
# smith-up masaustu dev komutunu bu bicimde gizli kabuga verir, bu yuzden komut satirinda
# `tauri dev` yazmaz; launcher'i ancak govdeyi cozerek taniriz.
#
# TUZAK (olculdu): Windows PowerShell 5.1'de (.NET Framework) tr-TR kulturunde buyuk/kucuk
# harf DUYARSIZ regex (`(?i)` da, -match de) [A-Za-z] sinifinda buyuk 'I'yi kacirir: 176
# karakterlik base64 ilk 'I'da, 32. karakterde kesildi, govde cozulemedi, launcher
# taninmadi. pwsh 7'de gorulmez. Bu yuzden regex ile ayiklama yerine belirteclere bolunur
# (bayrak adi ToLowerInvariant ile karsilastirilir) ve base64 dogrulamasi -cnotmatch ile yapilir.
function ConvertFrom-SmithEncodedCommand([string]$CommandLine) {
    $tokens = @($CommandLine -split '\s+')
    for ($i = 0; $i -lt ($tokens.Count - 1); $i++) {
        if ($tokens[$i].ToLowerInvariant() -notin @('-e', '-ec', '-enc', '-encodedcommand')) { continue }
        $b64 = $tokens[$i + 1].Trim('"')
        if ($b64 -cnotmatch '^[A-Za-z0-9+/=]{16,}$') { return $null }
        try {
            return [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($b64))
        } catch [System.FormatException] {
            return $null
        }
    }
    return $null
}

# Calisan masaustu dev launcher'larini doner (yoksa bos dizi). Yalniz bilinen surec
# adlarina bakilir: baska bir komutun argumani olarak gecen `tauri dev` yazisi yanlis
# pozitif vermesin. $Snap: Get-ProcessSnapshot ciktisi (ProcessId, Name, CommandLine,
# CreationDate). Siralama: en eski ilk.
function Get-SmithDesktopDevLaunchers($Snap) {
    $hits = @()
    foreach ($p in @($Snap)) {
        if (-not $p.CommandLine) { continue }
        $name = ([string]$p.Name).ToLowerInvariant()
        if ($name -in @('pwsh.exe', 'powershell.exe')) {
            $body = ConvertFrom-SmithEncodedCommand $p.CommandLine
            if ($body -and $body.ToLowerInvariant() -cmatch $script:DesktopDevCommandRegex) { $hits += $p }
        } elseif ($name -in @('node.exe', 'pnpm.exe')) {
            $cl = $p.CommandLine.ToLowerInvariant()
            if ($cl -cmatch $script:DesktopDevCommandRegex -or $cl -cmatch $script:DesktopTauriCliRegex) { $hits += $p }
        } elseif ($name -ceq 'cargo.exe') {
            $cl = $p.CommandLine.ToLowerInvariant()
            if ($cl -cmatch $script:DesktopCargoCommandRegex -and $cl -cmatch $script:DesktopCargoTargetRegex) { $hits += $p }
        }
    }
    return @($hits | Sort-Object CreationDate)
}

# Masaustu durumu (saf karar: surec tablosu ve saat disaridan gelir, yan etkisi yoktur).
#   up       masaustu sureci calisiyor ($Running dolu)
#   starting surec yok ama dev launcher'i (pnpm/tauri/cargo derlemesi) calisiyor ve
#            $StuckAfterSec'ten genc: derleme dakikalar surer, "down" DEGIL
#   stuck    launcher $StuckAfterSec'ten uzun suredir calisiyor, surec hala yok
#   down     ne surec ne launcher
# starting/stuck iken ikinci masaustu BASLATILMAZ (iki surec mikrofonu birlikte acar).
# Cikis New-State ile ayni sekil: { Up; State; Detail; ProcId }.
function Get-SmithDesktopState {
    param(
        $Snap,
        [Parameter(Mandatory = $true)][string]$ProcessName,
        $Running = @(),
        [int]$StuckAfterSec = 900,
        [datetime]$Now = (Get-Date)
    )
    $procs = @($Running)
    if ($procs.Count -gt 0) {
        return [pscustomobject]@{ Up = $true; State = 'up'; Detail = "$ProcessName pid $($procs[0].Id)"; ProcId = 0 }
    }
    $launchers = @(Get-SmithDesktopDevLaunchers $Snap)
    if ($launchers.Count -eq 0) {
        return [pscustomobject]@{ Up = $false; State = 'down'; Detail = "$ProcessName sureci yok"; ProcId = 0 }
    }
    $l = $launchers[0]
    $ageSec = 0
    if ($l.CreationDate) { $ageSec = [int]($Now - $l.CreationDate).TotalSeconds }
    if ($ageSec -gt $StuckAfterSec) {
        return [pscustomobject]@{
            Up = $false; State = 'stuck'; ProcId = [int]$l.ProcessId
            Detail = "dev derlemesi (launcher pid $($l.ProcessId)) $ageSec sn once basladi (tavan $StuckAfterSec sn), $ProcessName sureci hala yok"
        }
    }
    return [pscustomobject]@{
        Up = $false; State = 'starting'; ProcId = [int]$l.ProcessId
        Detail = "dev derlemesi suruyor (launcher pid $($l.ProcessId), $ageSec sn / tavan $StuckAfterSec sn), $ProcessName sureci bekleniyor"
    }
}
