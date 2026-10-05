# Smith'i tek komutla ayaga kaldirir (7/24 calistirma).
#
# Sira: Docker motoru -> postgres+redis (compose) -> gateway + worker + ses izi
# sidecar'i (paralel, gizli pencere) -> masaustu. Idempotent: zaten ayakta olan
# bilesen ikinci kez baslatilmaz; baslatma suren (launcher betigi calisan) bilesen
# de yeniden baslatilmaz.
#
# Kullanim:
#   .\scripts\smith-up.ps1            # eksikleri ayaga kaldir (+ masaustu)
#   .\scripts\smith-up.ps1 -Status    # saglik tablosu (salt okur; cikis 0 = hepsi ayakta)
#   .\scripts\smith-up.ps1 -DryRun    # ne yapacagini yaz, HICBIR SEY baslatma
#   .\scripts\smith-up.ps1 -Ensure    # bekci kipi: yalniz dusuk bilesenleri kaldirir
#                                     (masaustunu BASLATMAZ ve gerekli saymaz: kullanici
#                                     bilerek kapattiysa her 5 dk yeniden acilmasin)
#   .\scripts\smith-up.ps1 -NoDesktop # masaustunu ne baslat ne say
#
# Neyi MEVCUT betiklere birakir (bu betik env/sir yuklemez):
#   gateway  -> scripts\gateway-dev.ps1   (build + start, :4100)
#   worker   -> scripts\worker-dev.ps1    (build + start, kuyruk tuketicisi)
#   speaker  -> scripts\speaker-server.ps1 (ses izi dogrulama, :8124; smith-servers.ps1 de
#               bunu baslatir, burada log adi tutarli olsun diye dogrudan cagrilir)
#   desktop  -> release exe (env dosyasini kendisi yukler) ya da dev yolu
#               (dev-win.ps1 + `pnpm tauri dev`, _winrun.ps1 deseni)
#
# Masaustu dev yolu: `pnpm tauri dev` derlemesi dakikalar surer. smith-up bunu BEKLEMEZ;
# derleme launcher'i (pnpm / tauri / -EncodedCommand kabugu) calistigi surece masaustu
# durumu "starting" olur (tavan 900 sn, asilirsa "stuck"). starting/stuck iken ikinci
# masaustu BASLATILMAZ (iki surec mikrofonu birlikte acar); -Ensure ve bekci zaten
# masaustunu hic baslatmaz. Derlemesi suren masaustu cikis kodunu bozmaz.
#
# Takili bilesen: launcher betigi calisiyor ama bilesen StartTimeout'un 2 katindan uzun
# suredir saglikli degilse "stuck" sayilir. -Ensure bunu ARDISIK 3 turda gorunce
# (gecici yavaslik oldurmesin) launcher surec agacini durdurup yeniden baslatir;
# elle kosuda hemen yeniden baslatir.
#
# Ciktilar: <veri koku>\logs\<bilesen>-<yyyyMMdd>.log (7 gunden eskisi silinir),
# durum: <veri koku>\health.json (veri koku: SMITH_DATA_DIR ya da %USERPROFILE%\.smith,
# bkz. smith-common.ps1). Calisan tek kopya kilitle korunur
# (smith-up.lock): bekci ile acilis ayni anda kosarsa ikincisi cikar.
#
# Cikis kodu: 0 = gerekli tum bilesenler ayakta (ya da yalniz masaustu dev derlemesi
# suruyor), 1 = en az biri dusuk.

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Status,
    [switch]$Ensure,
    [switch]$NoDesktop,
    [int]$DockerTimeoutSec = 240
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'smith-common.ps1')

$ComposeFile = Join-Path $RepoRoot 'docker\dev-compose.yml'
$GatewayHealthUrl = 'http://127.0.0.1:4100/v1/health'
$PgPort = 5433
$RedisPort = 6380
$SpeakerPort = 8124
$AllComponents = @('docker', 'postgres', 'redis', 'gateway', 'worker', 'speaker', 'stt', 'desktop')
# Masaustu yalniz acilista (Ensure degil) baslatilir ve gerekli sayilir.
$StartDesktop = -not ($NoDesktop -or $Ensure)
$Required = @($AllComponents | Where-Object { -not ($_ -eq 'desktop' -and -not $StartDesktop) })

# Bilesen basina "ayaga kalkis" bekleme tavani (sn). desktop = release exe (derleme yok,
# surec saniyeler icinde kalkar); desktopDev = `pnpm tauri dev` derlemesi (dakikalar surer):
# smith-up bunu BEKLEMEZ, yalniz launcher'in yasadigi sure "starting" sayilir ve tavan
# (desktopDev x StuckFactor = 900 sn) asilinca "stuck" olur.
$StartTimeout = @{ gateway = 180; worker = 120; speaker = 150; stt = 30; desktop = 30; desktopDev = 450 }

# Launcher bu carpanla StartTimeout'u asan sureden beri saglikli bilesen vermiyorsa "stuck".
# Ensure, bu durumu yeniden baslatmadan once bu kadar ardisik turda gormeli.
$StuckFactor = 2
$StuckConfirmRounds = 2
$DesktopStuckSec = $StartTimeout['desktopDev'] * $StuckFactor

# Launcher betigi calisiyor mu = "baslatma suruyor" (build / model yukleme). Bilesen
# henuz saglikli degilken ikinci kopya baslatmayi onler.
$Launchers = @{
    gateway = 'gateway-dev.ps1'
    worker  = 'worker-dev.ps1'
    speaker = 'speaker-server.ps1'
    stt     = 'stt-server.ps1'
}

$HealthPath = Join-Path (Get-SmithDataDir) 'health.json'

# --- Kabuk / masaustu cozumleme --------------------------------------------

function Get-ShellExe {
    $pwsh7 = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
    if (Test-Path -LiteralPath $pwsh7) { return $pwsh7 }
    $cmd = Get-Command pwsh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    return (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
}

# Release exe adi: tauri.conf.json mainBinaryName > Cargo default-run > Cargo [package] name.
function Resolve-DesktopExe {
    $tauriDir = Join-Path $RepoRoot 'apps\desktop\src-tauri'
    $binary = $null
    $confPath = Join-Path $tauriDir 'tauri.conf.json'
    if (Test-Path -LiteralPath $confPath) {
        $conf = [System.IO.File]::ReadAllText($confPath) | ConvertFrom-Json
        $prop = $conf.PSObject.Properties['mainBinaryName']
        if ($prop -and $prop.Value) { $binary = [string]$prop.Value }
    }
    $cargoPath = Join-Path $tauriDir 'Cargo.toml'
    if (-not $binary -and (Test-Path -LiteralPath $cargoPath)) {
        $cargo = [System.IO.File]::ReadAllText($cargoPath)
        if ($cargo -match '(?ms)^\[package\]\s*(.*?)(?=^\[|\z)') {
            $pkg = $Matches[1]
            if ($pkg -match '(?m)^\s*default-run\s*=\s*"([^"]+)"') { $binary = $Matches[1] }
            elseif ($pkg -match '(?m)^\s*name\s*=\s*"([^"]+)"') { $binary = $Matches[1] }
        }
    }
    if (-not $binary) { $binary = 'smith-desktop' }

    $candidates = @()
    if ($env:SMITH_DESKTOP_EXE) { $candidates += $env:SMITH_DESKTOP_EXE }
    if ($env:CARGO_TARGET_DIR) { $candidates += (Join-Path $env:CARGO_TARGET_DIR "release\$binary.exe") }
    $candidates += (Join-Path $tauriDir "target\release\$binary.exe")
    $found = $null
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { $found = $c; break }
    }
    # SMITH_DESKTOP_PROCESS_NAME: yalniz sinama icin (scripts\smith-common-test.ps1), izlenen
    # surec adini gercek masaustunden ayirir; ayni anda calisan gercek masaustu sonucu bozmasin.
    $procName = $binary
    if ($env:SMITH_DESKTOP_PROCESS_NAME) { $procName = $env:SMITH_DESKTOP_PROCESS_NAME }
    return [pscustomobject]@{ Binary = $binary; ProcessName = $procName; Exe = $found; Candidates = $candidates }
}

# --- Durum olcumu ------------------------------------------------------------

# ProcId: "stuck" durumunda durdurulacak launcher sureci (yoksa 0).
function New-State([bool]$Up, [string]$State, [string]$Detail, [int]$ProcId = 0) {
    return [pscustomobject]@{ Up = $Up; State = $State; Detail = $Detail; ProcId = $ProcId }
}

function Get-ProcessSnapshot {
    return @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } |
            Select-Object ProcessId, Name, CommandLine, CreationDate)
}

# `pwsh/powershell ... -File ...<betik>` calisan sureci doner (yalniz kabuk sureclerine
# bakar: baska bir komutun argumani olarak gecen betik adi yanlis pozitif vermesin).
# Birden fazlaysa en eskisi; yoksa $null.
function Get-LauncherProcess($Snap, [string]$Script) {
    $re = '-File\s+"?[^"]*' + [regex]::Escape($Script)
    $hits = @($Snap | Where-Object { $_.Name -in @('pwsh.exe', 'powershell.exe') -and $_.CommandLine -match $re })
    if ($hits.Count -eq 0) { return $null }
    return ($hits | Sort-Object CreationDate | Select-Object -First 1)
}

# Launcher calisiyorsa "starting"; StartTimeout x StuckFactor'u asmissa "stuck" (bilesen
# o kadar suredir saglikli degil: asilmis olay dongusu, takili build / model yukleme).
# Launcher bilesenle birlikte on planda kosar, bu yuzden saglikli bilesen varken de yasar;
# bu fonksiyon yalniz bilesen SAGLIKSIZKEN cagrilir. Launcher yoksa $null.
function Get-LauncherState($Snap, [string]$Name, [string]$Waiting) {
    $p = Get-LauncherProcess $Snap $Launchers[$Name]
    if (-not $p) { return $null }
    $ageSec = 0
    if ($p.CreationDate) { $ageSec = [int]((Get-Date) - $p.CreationDate).TotalSeconds }
    $limit = $StartTimeout[$Name] * $StuckFactor
    if ($ageSec -gt $limit) {
        return (New-State $false 'stuck' "$($Launchers[$Name]) $ageSec sn once basladi (tavan $limit sn), bilesen saglikli degil" $p.ProcessId)
    }
    return (New-State $false 'starting' "$($Launchers[$Name]) calisiyor, $Waiting" $p.ProcessId)
}

function Get-ComponentState {
    param([string]$Name, $Snap, $Desktop)
    switch ($Name) {
        'docker' {
            $d = Test-DockerEngine
            if ($d.Up) { return (New-State $true 'up' $d.Detail) }
            return (New-State $false 'down' $d.Detail)
        }
        'postgres' {
            if (Test-SmithTcpPort $PgPort) { return (New-State $true 'up' ":$PgPort") }
            return (New-State $false 'down' ":$PgPort dinlenmiyor")
        }
        'redis' {
            if (Test-SmithTcpPort $RedisPort) { return (New-State $true 'up' ":$RedisPort") }
            return (New-State $false 'down' ":$RedisPort dinlenmiyor")
        }
        'gateway' {
            $h = Test-SmithHealthUrl $GatewayHealthUrl
            if ($h.Up) { return (New-State $true 'up' "/v1/health $($h.Detail)") }
            $ls = Get-LauncherState $Snap 'gateway' 'saglik bekleniyor'
            if ($ls) { return $ls }
            return (New-State $false 'down' '/v1/health yanit vermiyor (:4100)')
        }
        'worker' {
            # Worker'in portu yok: `pnpm --filter @smith/worker start` sureci ayaktaysa calisiyordur.
            foreach ($p in $Snap) {
                if ($p.CommandLine -match '@smith[/\\]worker"?\s+start') { return (New-State $true 'up' "pid $($p.ProcessId)") }
            }
            $ls = Get-LauncherState $Snap 'worker' 'build/start bekleniyor'
            if ($ls) { return $ls }
            return (New-State $false 'down' 'worker sureci yok')
        }
        'speaker' {
            if (Test-SmithTcpPort $SpeakerPort) { return (New-State $true 'up' ":$SpeakerPort") }
            $ls = Get-LauncherState $Snap 'speaker' 'model yukleniyor'
            if ($ls) { return $ls }
            return (New-State $false 'down' ":$SpeakerPort dinlenmiyor")
        }
        'stt' {
            if (Test-SmithTcpPort 8123) { return (New-State $true 'up' ':8123 (model tembel)') }
            $ls = Get-LauncherState $Snap 'stt' 'sunucu baslatiliyor'
            if ($ls) { return $ls }
            return (New-State $false 'down' ':8123 dinlenmiyor')
        }
        'desktop' {
            if ($NoDesktop) { return (New-State $false 'skipped' '-NoDesktop') }
            # Surec yokken dev launcher'i (pnpm/tauri/cargo derlemesi) calisiyorsa DOWN degil
            # "starting": derleme dakikalar surer, bu sirada ikinci masaustu baslatilmaz.
            $proc = @(Get-Process -Name $Desktop.ProcessName -ErrorAction SilentlyContinue)
            return (Get-SmithDesktopState -Snap $Snap -ProcessName $Desktop.ProcessName -Running $proc -StuckAfterSec $DesktopStuckSec)
        }
    }
}

function Get-AllStates($Desktop) {
    $snap = Get-ProcessSnapshot
    $states = [ordered]@{}
    foreach ($n in $AllComponents) { $states[$n] = Get-ComponentState -Name $n -Snap $snap -Desktop $Desktop }
    $states['disk'] = Get-SmithDiskHealth
    return $states
}

# --- Saglik dosyasi ----------------------------------------------------------

function Get-PreviousFailures {
    $prev = Read-SmithJson $HealthPath
    $map = @{}
    if ($prev -and $prev.bilesenler) {
        foreach ($p in $prev.bilesenler.PSObject.Properties) {
            $map[$p.Name] = [int]$p.Value.ardisikBasarisizlik
        }
    }
    return $map
}

# Sayac: ayakta -> 0. Dusuk ve $CountFailures -> +1. Dusuk ama sayilmiyor (Status) -> onceki
# deger korunur. Gerekli olmayan bilesen (-NoDesktop, Ensure'da masaustu) sayilmaz.
function Save-Health {
    param($States, [string]$Mode, [bool]$CountFailures)
    $prev = Get-PreviousFailures
    $comp = [ordered]@{}
    $allUp = $true
    foreach ($n in $AllComponents) {
        $s = $States[$n]
        $fails = 0
        if ($prev.ContainsKey($n)) { $fails = $prev[$n] }
        if ($s.Up) { $fails = 0 }
        elseif ($s.State -ne 'skipped' -and ($Required -contains $n) -and $CountFailures) { $fails = $fails + 1 }
        if (($Required -contains $n) -and (-not $s.Up)) { $allUp = $false }
        $comp[$n] = [ordered]@{
            up                  = $s.Up
            durum               = $s.State
            ardisikBasarisizlik = $fails
            detay               = $s.Detail
        }
    }
    $comp['disk'] = $States['disk']
    $doc = [ordered]@{
        zaman      = (Get-Date -Format 'o')
        mod        = $Mode
        tumAyakta  = $allUp
        bilesenler = $comp
    }
    Write-SmithJson -Path $HealthPath -Object $doc
    return $doc
}

function Write-StateTable($States, $Failures) {
    Write-Host ''
    Write-Host ('{0,-10} {1,-9} {2,-9} {3}' -f 'bilesen', 'durum', 'basarisiz', 'detay')
    foreach ($n in $AllComponents) {
        $s = $States[$n]
        $f = 0
        if ($Failures -and $Failures.ContainsKey($n)) { $f = $Failures[$n] }
        $label = $s.State.ToUpperInvariant()
        $color = 'Red'
        if ($s.Up) { $color = 'Green' } elseif ($s.State -in @('starting', 'skipped')) { $color = 'Yellow' }
        Write-Host ('{0,-10} {1,-9} {2,-9} {3}' -f $n, $label, $f, $s.Detail) -ForegroundColor $color
    }
    $disk = $States['disk']
    $color = 'Green'
    if ($disk.seviye -eq 'uyari') { $color = 'Yellow' }
    elseif ($disk.seviye -eq 'kritik') { $color = 'Red' }
    Write-Host ('{0,-10} {1,-9} {2,-9} {3}' -f 'disk', $disk.seviye.ToUpperInvariant(), '-', $disk.detay) -ForegroundColor $color
    Write-Host ''
}

# Gerekli olup ayakta olmayan bilesenler. Derlemesi suren masaustu (dev yolu, "starting")
# BASARISIZLIK DEGILDIR: cikis kodunu bozmaz, health.json'da ise durum olarak gorunur.
function Get-HardDown($States) {
    return @($AllComponents | Where-Object {
            ($Required -contains $_) -and (-not $States[$_].Up) -and
            (-not ($_ -eq 'desktop' -and $States[$_].State -eq 'starting'))
        })
}

# --- Baslatma yardimcilari ---------------------------------------------------

function Start-HiddenShell {
    param([string]$Name, [string]$ShellArgs)
    $log = Join-Path (Get-SmithLogDir) ('{0}-{1}.log' -f $Name, (Get-Date -Format 'yyyyMMdd'))
    # WScript.Shell.Run(..., 0, $false): pencere HIC olusturulmaz (smith-servers.ps1 deseni).
    $cmd = 'cmd /c ""' + $script:ShellExe + '" ' + $ShellArgs + ' >> "' + $log + '" 2>&1"'
    $sh = New-Object -ComObject WScript.Shell
    [void]$sh.Run($cmd, 0, $false)
    Write-SmithLog "[baslat] $Name (gizli) -> $log"
}

function Start-ScriptComponent([string]$Name) {
    $script = Join-Path $PSScriptRoot $Launchers[$Name]
    Start-HiddenShell -Name $Name -ShellArgs ('-NoProfile -ExecutionPolicy Bypass -File "' + $script + '"')
}

function Start-DesktopComponent($Desktop) {
    # Onceki saglik tablosu bayatlamis olabilir: yan etkiden hemen once tekrar bak.
    $fresh = Get-ComponentState -Name 'desktop' -Snap (Get-ProcessSnapshot) -Desktop $Desktop
    if ($fresh.State -ne 'down') {
        Write-SmithLog "desktop baslatilmadi: son kontrolde $($fresh.State) ($($fresh.Detail))."
        return $false
    }
    $logBase = Join-Path (Get-SmithLogDir) ('desktop-{0}' -f (Get-Date -Format 'yyyyMMdd'))
    if ($Desktop.Exe) {
        Write-SmithLog "[baslat] desktop (release) $($Desktop.Exe)"
        # GUI penceresini uygulama kendisi acar; yalniz stdout/stderr dosyaya alinir.
        Start-Process -FilePath $Desktop.Exe -WorkingDirectory (Split-Path -Parent $Desktop.Exe) `
            -RedirectStandardOutput ($logBase + '.log') -RedirectStandardError ($logBase + '-stderr.log') | Out-Null
        return $true
    }
    # Release exe yok: dev yolu (_winrun.ps1 deseni). Komut -EncodedCommand ile gecer,
    # ic ice tirnak sorunu olmaz.
    Write-SmithLog '[baslat] desktop (dev: release exe yok) dev-win.ps1 + pnpm tauri dev'
    $devWin = Join-Path $PSScriptRoot 'dev-win.ps1'
    $body = "Set-Location '$RepoRoot'; . '$devWin'; pnpm --filter '@smith/desktop' tauri dev 2>&1"
    $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($body))
    Start-HiddenShell -Name 'desktop' -ShellArgs ('-NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + $enc)
    return $true
}

# Launcher surec agacini durdurur (pnpm / node / python cocuklari dahil): "stuck" bilesen
# yeniden baslatilmadan once. Yalniz ProcId'si bilinen launcher'a dokunur.
function Stop-LauncherTree([string]$Name, [int]$ProcId) {
    Write-SmithLog "[durdur] $Name launcher agaci (pid $ProcId) sonlandiriliyor (taskkill /T /F)"
    $r = Invoke-SmithNative -FilePath (Join-Path $env:SystemRoot 'System32\taskkill.exe') -ArgumentList @('/PID', "$ProcId", '/T', '/F') -TimeoutSec 30
    if ($r.TimedOut -or $r.ExitCode -ne 0) {
        Write-SmithLog "taskkill pid $ProcId basarisiz (exit $($r.ExitCode)): $(($r.Output + $r.Error).Trim())" 'WARN'
    }
}

# compose ile yalniz postgres+redis. `down` / `prune` ASLA: veri silinir.
function Start-ComposeDeps {
    $docker = Get-DockerExe
    Write-SmithLog "[compose] up -d postgres redis ($ComposeFile)"
    $r = Invoke-SmithNative -FilePath $docker -ArgumentList @('compose', '-f', $ComposeFile, 'up', '-d', 'postgres', 'redis') -TimeoutSec 240
    if ($r.TimedOut -or $r.ExitCode -ne 0) {
        $tail = (($r.Output + $r.Error).Trim() -split "`r?`n" | Select-Object -Last 5) -join ' | '
        Write-SmithLog "compose up basarisiz (exit $($r.ExitCode), zaman asimi: $($r.TimedOut)): $tail" 'ERROR'
        return $false
    }
    # Port acik olmasi Postgres'in hazir oldugu anlamina gelmez (docker-proxy once acar):
    # pg_isready ile gercek hazirligi bekle.
    $idr = Invoke-SmithNative -FilePath $docker -ArgumentList @('compose', '-f', $ComposeFile, 'ps', '-q', 'postgres') -TimeoutSec 30
    $cid = ($idr.Output.Trim() -split "`r?`n" | Select-Object -First 1)
    if (-not $cid) {
        Write-SmithLog 'postgres container kimligi alinamadi.' 'ERROR'
        return $false
    }
    $deadline = (Get-Date).AddSeconds(120)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        $q = Invoke-SmithNative -FilePath $docker -ArgumentList @('exec', $cid, 'pg_isready', '-U', 'smith', '-d', 'smith') -TimeoutSec 20
        if ($q.ExitCode -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 3
    }
    if (-not $ready) {
        Write-SmithLog 'Postgres 120 sn icinde hazir olmadi (pg_isready).' 'ERROR'
        return $false
    }
    Write-SmithLog '[compose] postgres hazir (pg_isready).'
    $rdeadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $rdeadline) {
        if (Test-SmithTcpPort $RedisPort) { Write-SmithLog '[compose] redis hazir.'; return $true }
        Start-Sleep -Seconds 2
    }
    Write-SmithLog "Redis :$RedisPort 30 sn icinde acilmadi." 'ERROR'
    return $false
}

# --- Ana akis ----------------------------------------------------------------

$script:ShellExe = Get-ShellExe
$desktop = Resolve-DesktopExe
$mode = 'up'
if ($Ensure) { $mode = 'ensure' }

if ($Status) {
    $states = Get-AllStates $desktop
    $doc = Save-Health -States $states -Mode 'status' -CountFailures $false
    $fails = Get-PreviousFailures
    Write-StateTable $states $fails
    Write-Host "saglik dosyasi: $HealthPath"
    if (@(Get-HardDown $states).Count -eq 0) { exit 0 } else { exit 1 }
}

if (-not $DryRun) { Set-SmithLogName 'smith-up' }

# Kilit: bekci ve acilis ayni anda kosarsa ikinci kopya cift baslatma yapmasin.
# Mutex GC'de birakilir; FileStream kilidi surec olene dek tutulur. DryRun kilit almaz.
$lockStream = $null
if (-not $DryRun) {
    $lockPath = Join-Path (Get-SmithDataDir) 'smith-up.lock'
    try {
        $lockStream = New-Object System.IO.FileStream($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    } catch [System.IO.IOException] {
        Write-SmithLog 'Baska bir smith-up calisiyor (kilit alinamadi), bu kosu atlandi.'
        exit 0
    }
}

function Step([string]$Text, [scriptblock]$Action) {
    if ($DryRun) { Write-SmithLog "[plan] $Text"; return $true }
    Write-SmithLog $Text
    return (& $Action)
}

try {
    Write-SmithLog "smith-up basladi (mod: $mode$(if ($DryRun) { ', DryRun' }), kabuk: $script:ShellExe)"
    $states = Get-AllStates $desktop
    if ($DryRun) {
        Write-StateTable $states (Get-PreviousFailures)
        Write-SmithLog "[plan] repo: $RepoRoot"
        Write-SmithLog "[plan] compose dosyasi: $ComposeFile"
        Write-SmithLog "[plan] loglar: $(Get-SmithLogDir) (<bilesen>-<yyyyMMdd>.log, 7 gunden eskisi silinir)"
        if (-not $StartDesktop) { Write-SmithLog '[plan] masaustu: bu kipte baslatilmaz (-NoDesktop ya da -Ensure)' }
        elseif ($desktop.Exe) { Write-SmithLog "[plan] masaustu: release exe $($desktop.Exe)" }
        else { Write-SmithLog "[plan] masaustu: release exe YOK (aranan: $($desktop.Candidates -join '; ')), dev yoluna dusulur (derleme dakikalar surer, smith-up beklemez; tavan $DesktopStuckSec sn)" }
    }

    # 1) Docker motoru
    $dockerOk = $states['docker'].Up
    if (-not $dockerOk) {
        $dockerOk = Step "docker: Docker Desktop baslatilir, motor icin en cok $DockerTimeoutSec sn beklenir" {
            Wait-DockerEngine -TimeoutSec $DockerTimeoutSec -StartIfNeeded
        }
    }

    # 2) postgres + redis
    $depsOk = ($states['postgres'].Up -and $states['redis'].Up)
    if (-not $depsOk) {
        if ($dockerOk) {
            $depsOk = Step 'postgres+redis: docker compose up -d postgres redis, pg_isready beklenir' { Start-ComposeDeps }
        } else {
            Write-SmithLog 'postgres+redis atlandi: Docker motoru hazir degil.' 'WARN'
        }
    }
    if (-not $DryRun) { $states = Get-AllStates $desktop }

    # 3) gateway / worker / speaker (paralel baslat, sonra bekle)
    $launched = @()
    foreach ($n in @('gateway', 'worker', 'speaker', 'stt')) {
        $s = $states[$n]
        if ($s.Up) { continue }
        if ($s.State -eq 'starting') {
            Write-SmithLog "$n zaten baslatiliyor ($($s.Detail)), ikinci kez baslatilmaz."
            continue
        }
        if ($s.State -eq 'stuck') {
            # Ensure: gecici yavaslik (bir saglik yoklamasi zaman asimi) saglikli bileseni
            # oldurmesin; ardisik StuckConfirmRounds tur "stuck" gorulunce yeniden baslat.
            # Sayac Save-Health'te her turda artar (stuck = dusuk).
            if ($Ensure -and (Get-PreviousFailures)[$n] -lt $StuckConfirmRounds) {
                Write-SmithLog "$n takili gorunuyor ($($s.Detail)); yeniden baslatma icin $StuckConfirmRounds ardisik tur teyidi bekleniyor." 'WARN'
                continue
            }
            [void](Step "${n}: takili launcher (pid $($s.ProcId)) durdurulur, sonra yeniden baslatilir" {
                    Stop-LauncherTree $n $s.ProcId
                    Start-Sleep -Seconds 2
                    $true
                })
        }
        if ($n -notin @('speaker', 'stt') -and -not $depsOk) {
            Write-SmithLog "$n atlandi: postgres/redis hazir degil." 'WARN'
            continue
        }
        [void](Step "${n}: scripts\$($Launchers[$n]) gizli pencerede baslatilir, saglik en cok $($StartTimeout[$n]) sn beklenir" {
                Start-ScriptComponent $n
                $true
            })
        $launched += $n
    }
    if (-not $DryRun -and $launched.Count -gt 0) {
        $deadlines = @{}
        foreach ($n in $launched) { $deadlines[$n] = (Get-Date).AddSeconds($StartTimeout[$n]) }
        $pending = @($launched)
        while ($pending.Count -gt 0) {
            Start-Sleep -Seconds 3
            $snap = Get-ProcessSnapshot
            $still = @()
            foreach ($n in $pending) {
                $st = Get-ComponentState -Name $n -Snap $snap -Desktop $desktop
                if ($st.Up) { Write-SmithLog "[hazir] $n ($($st.Detail))"; continue }
                if ((Get-Date) -gt $deadlines[$n]) { Write-SmithLog "[zaman asimi] $n $($StartTimeout[$n]) sn icinde saglikli olmadi: $($st.Detail)" 'ERROR'; continue }
                $still += $n
            }
            $pending = $still
        }
        $states = Get-AllStates $desktop
    }

    # 4) masaustu (en son; gateway ayaktaysa)
    if ($StartDesktop -and -not $states['desktop'].Up) {
        $ds = $states['desktop']
        if ($ds.State -in @('starting', 'stuck')) {
            # Dev derlemesi suruyor (ya da tavani asti): IKINCI masaustu ASLA. Iki surec
            # mikrofonu birlikte acar. Takili launcher'i burada oldurmeyiz (gateway/worker'daki
            # gibi): derleme kullanicinin elindeki isi olabilir; karar kullanicida.
            $lvl = 'INFO'
            if ($ds.State -eq 'stuck') { $lvl = 'WARN' }
            Write-SmithLog "desktop zaten baslatiliyor ($($ds.Detail)), ikinci kez baslatilmaz." $lvl
        } else {
            $gatewayOk = $states['gateway'].Up -or ($DryRun -and ($launched -contains 'gateway'))
            if ($gatewayOk) {
                $desktopStarted = Step 'desktop: masaustu baslatilir' { Start-DesktopComponent $desktop }
                if (-not $DryRun -and $desktopStarted) {
                    if ($desktop.Exe) {
                        # Release exe: derleme yok, surec saniyeler icinde kalkar (kisa tavan).
                        $ddeadline = (Get-Date).AddSeconds($StartTimeout['desktop'])
                        while ((Get-Date) -lt $ddeadline) {
                            Start-Sleep -Seconds 2
                            if (@(Get-Process -Name $desktop.ProcessName -ErrorAction SilentlyContinue).Count -gt 0) { break }
                        }
                    } else {
                        # Dev yolu: `pnpm tauri dev` derlemesi dakikalar surer; smith-up BEKLEMEZ.
                        # Yalniz launcher surec tablosunda gorunene dek kisa bekler (en cok 20 sn),
                        # yoksa son durum yoklamasi "down" gorup yaniltirdi.
                        $ldeadline = (Get-Date).AddSeconds(20)
                        while ((Get-Date) -lt $ldeadline) {
                            Start-Sleep -Seconds 2
                            $st = Get-ComponentState -Name 'desktop' -Snap (Get-ProcessSnapshot) -Desktop $desktop
                            if ($st.State -ne 'down') { break }
                        }
                        Write-SmithLog "[bilgi] masaustu dev derlemesi arka planda suruyor (tavan $DesktopStuckSec sn); smith-up beklemiyor. Durum: smith-up.ps1 -Status"
                    }
                }
                if (-not $DryRun) { $states = Get-AllStates $desktop }
            } else {
                Write-SmithLog 'desktop atlandi: gateway saglikli degil.' 'WARN'
            }
        }
    }

    if ($DryRun) {
        Write-SmithLog '[plan] DryRun: hicbir sey baslatilmadi, health.json yazilmadi.'
        exit 0
    }

    # 5) saglik dosyasi + log temizligi + ozet
    $doc = Save-Health -States $states -Mode $mode -CountFailures $true
    # Log temizligi en-iyi-caba: hicbir hata (kilitli dosya, erisim) cikis kodunu bozmamali.
    try {
        $cleanup = Remove-OldSmithLogs -Days 7
        if ($cleanup.Removed.Count -gt 0) { Write-SmithLog "$($cleanup.Removed.Count) eski log silindi (7 gunden eski)." }
        if ($cleanup.Locked.Count -gt 0) { Write-SmithLog "$($cleanup.Locked.Count) eski log kilitli (bilesen yazmaya devam ediyor), atlandi: $($cleanup.Locked -join ', ')" }
    } catch {
        Write-SmithLog "Log temizligi basarisiz (yok sayildi): $($_.Exception.Message)" 'WARN'
    }
    Write-StateTable $states (Get-PreviousFailures)
    $hardDown = @(Get-HardDown $states)
    if ($doc.tumAyakta) { Write-SmithLog 'Tum gerekli bilesenler ayakta.' }
    elseif ($hardDown.Count -eq 0) { Write-SmithLog 'Gerekli bilesenler ayakta; masaustu dev derlemesi suruyor (smith-up.ps1 -Status ile izle).' }
    else { Write-SmithLog 'Eksik bilesen var (tabloya bak).' 'WARN' }
} finally {
    if ($lockStream) { $lockStream.Dispose() }
}
if ($hardDown.Count -eq 0) { exit 0 } else { exit 1 }
