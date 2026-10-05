# Smith'i oturum acilisinda otomatik baslatan ve izleyen iki zamanlanmis gorevi
# kurar / kaldirir (kullanici kapsami, yonetici yetkisi ISTEMEZ).
#
# IKI GOREV:
#   Smith Stack     -> oturum acilisi, 30 sn gecikmeli: scripts\smith-up.ps1
#   Smith Watchdog  -> 5 dakikada bir: scripts\smith-watchdog.ps1 (smith-up -Ensure + bildirim)
#
# Desen, awareness-install-task.ps1'deki kanitli desenle aynidir (orada tuzaklar
# ayrintili): InteractiveToken + LeastPrivilege (UAC yukseltmesi istemez), gorev
# wscript.exe ile gizli bir VBS sarmalayicisini acar, sarmalayici veri kokunun altindadir
# (<veri koku>\autostart; kok: SMITH_DATA_DIR ya da %USERPROFILE%\.smith, bkz.
# smith-common.ps1; MSIX AppData yonlendirmesi zamanlanmis gorevi kor eder).
# Sarmalayici betigin cikis kodunu gorev sonucuna tasir (Get-ScheduledTaskInfo ->
# LastTaskResult), bkz. Write-HiddenTaskShim (smith-common.ps1).
#
# Kullanim:
#   .\scripts\smith-autostart.ps1 -WhatIf       # ne kuracagini goster, HICBIR SEY yazma
#   .\scripts\smith-autostart.ps1 -Install      # kur / guncelle (idempotent)
#   .\scripts\smith-autostart.ps1 -Uninstall    # iki gorevi ve sarmalayicilarini kaldir
#   .\scripts\smith-autostart.ps1               # kurulu gorevlerin durumunu goster
#   .\scripts\smith-autostart.ps1 -Install -NoDesktop   # masaustunu acilista baslatma

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$NoDesktop,
    [ValidateRange(1, 1440)]
    [int]$WatchdogMinutes = 5,
    [ValidateRange(0, 600)]
    [int]$LogonDelaySeconds = 30
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'smith-common.ps1')

$TaskStack = 'Smith Stack'
$TaskWatchdog = 'Smith Watchdog'
$StackScript = Join-Path $RepoRoot 'scripts\smith-up.ps1'
$WatchdogScript = Join-Path $RepoRoot 'scripts\smith-watchdog.ps1'

# Veri koku sanallastirilmaz (AppData MSIX icinden yazilinca yonlendirilir). Resolve:
# yan etkisiz, -WhatIf hicbir dizin olusturmaz.
$ShimDir = Join-Path (Resolve-SmithDataDir) 'autostart'
$StackVbs = Join-Path $ShimDir 'run-smith-stack.vbs'
$StackCmd = Join-Path $ShimDir 'run-smith-stack.cmd'
$StackLog = Join-Path $ShimDir 'task-stack.log'
$WatchdogVbs = Join-Path $ShimDir 'run-smith-watchdog.vbs'
$WatchdogCmd = Join-Path $ShimDir 'run-smith-watchdog.cmd'
$WatchdogLog = Join-Path $ShimDir 'task-watchdog.log'

# Gorev kabugu: powershell.exe 5.1 (her Windows'ta var; awareness gorevleriyle ayni).
# Betikler iki kabukla da calisir.
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$UserId = "$env:USERDOMAIN\$env:USERNAME"

$extraArgs = ''
if ($NoDesktop) { $extraArgs = '-NoDesktop' }

function Remove-TaskIfExists([string]$Name) {
    $existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if (-not $existing) { return $false }
    if ($PSCmdlet.ShouldProcess($Name, 'Zamanlanmis gorevi kaldir')) {
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
        Write-Host "  kaldirildi: $Name" -ForegroundColor DarkGray
    }
    return $true
}

function Show-TaskStatus {
    foreach ($name in @($TaskStack, $TaskWatchdog)) {
        $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if (-not $t) { Write-Host ('  {0,-15} KURULU DEGIL' -f $name) -ForegroundColor Yellow; continue }
        $i = Get-ScheduledTaskInfo -TaskName $name
        Write-Host ('  {0,-15} {1,-8} son kosu: {2}  sonuc: {3}  sonraki: {4}' -f $name, $t.State, $i.LastRunTime, $i.LastTaskResult, $i.NextRunTime)
    }
}

if ($Install -and $Uninstall) { throw '-Install ve -Uninstall birlikte verilemez.' }

if (-not $Install -and -not $Uninstall -and -not $WhatIfPreference) {
    Write-Host '=== Smith otomatik baslatma gorevleri' -ForegroundColor Cyan
    Show-TaskStatus
    Write-Host ''
    Write-Host 'Kurmak icin: .\scripts\smith-autostart.ps1 -Install   (once -WhatIf ile onizle)' -ForegroundColor DarkGray
    return
}

if ($Uninstall) {
    Write-Host '=== Smith otomatik baslatma gorevleri kaldiriliyor' -ForegroundColor Cyan
    $a = Remove-TaskIfExists $TaskStack
    $b = Remove-TaskIfExists $TaskWatchdog
    if (-not ($a -or $b)) { Write-Host '  kurulu gorev yoktu.' -ForegroundColor DarkGray }
    foreach ($f in @($StackVbs, $StackCmd, $WatchdogVbs, $WatchdogCmd)) {
        if ((Test-Path -LiteralPath $f) -and $PSCmdlet.ShouldProcess($f, 'Sarmalayiciyi sil')) {
            Remove-Item -LiteralPath $f -Force
        }
    }
    Write-Host "Bitti. (Loglar silinmedi: $ShimDir)" -ForegroundColor Green
    return
}

# --- Kurulum (-Install ya da yalniz -WhatIf onizlemesi) ---------------------

foreach ($s in @($StackScript, $WatchdogScript)) {
    if (-not (Test-Path -LiteralPath $s)) { throw "Betik yok: $s" }
}

Write-Host '=== Smith otomatik baslatma gorevleri kuruluyor' -ForegroundColor Cyan
if ($WhatIfPreference) { Write-Host '  (-WhatIf: hicbir dosya yazilmaz, hicbir gorev kaydedilmez)' -ForegroundColor Yellow }

# Sarmalayicilar
if ($PSCmdlet.ShouldProcess($ShimDir, 'Sarmalayici dizinini olustur')) {
    New-Item -ItemType Directory -Force -Path $ShimDir | Out-Null
}
$shims = @(
    @{ Vbs = $StackVbs; Cmd = $StackCmd; Script = $StackScript; Log = $StackLog; Title = 'Smith Stack' },
    @{ Vbs = $WatchdogVbs; Cmd = $WatchdogCmd; Script = $WatchdogScript; Log = $WatchdogLog; Title = 'Smith Watchdog' }
)
foreach ($sh in $shims) {
    Write-Host ('  sarmalayici: {0} -> {1} -File "{2}" {3}' -f $sh.Vbs, $PowerShellExe, $sh.Script, $extraArgs) -ForegroundColor DarkGray
    if ($PSCmdlet.ShouldProcess($sh.Vbs, 'Sarmalayici (.cmd + .vbs) yaz')) {
        Write-HiddenTaskShim -VbsPath $sh.Vbs -CmdPath $sh.Cmd -Interpreter $PowerShellExe `
            -ScriptPath $sh.Script -ScriptArgs $extraArgs -LogFile $sh.Log `
            -Title $sh.Title -Generator 'scripts\smith-autostart.ps1'
    }
}

# Ortak principal: LeastPrivilege + Interactive = UAC yukseltmesi istemez.
$principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited

function New-SmithSettings([int]$LimitMinutes) {
    return (New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -StartWhenAvailable `
            -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit (New-TimeSpan -Minutes $LimitMinutes))
}

function Register-SmithTask {
    param([string]$Name, [string]$VbsPath, $Triggers, $Settings, [string]$Description)
    $action = New-ScheduledTaskAction -Execute $Wscript -Argument "`"$VbsPath`"" -WorkingDirectory $RepoRoot
    Write-Host ("  gorev: {0}`n    eylem   : {1} {2}`n    tetik   : {3}" -f $Name, $Wscript, $action.Arguments,
        (($Triggers | ForEach-Object { $_.CimClass.CimClassName + ' (gecikme: ' + $_.Delay + ', tekrar: ' + $_.Repetition.Interval + ')' }) -join ', '))
    if (-not $PSCmdlet.ShouldProcess($Name, 'Zamanlanmis gorevi kaydet')) { return }
    Remove-TaskIfExists $Name | Out-Null
    # -ErrorAction Stop SART: Register-ScheduledTask XML reddini non-terminating hata olarak
    # verir; yakalanmazsa gorev kurulmamisken "kaydedildi" basilir (awareness'ta yasandi).
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Triggers -Principal $principal `
        -Settings $Settings -Description $Description -ErrorAction Stop | Out-Null
    if (-not (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue)) {
        throw "Gorev kaydi bildirildi ama gorev bulunamadi: $Name"
    }
    Write-Host "  kaydedildi ve dogrulandi: $Name" -ForegroundColor Green
}

# Smith Stack: oturum acilisi + gecikme (Docker Desktop ve masaustu oturumu otursun).
# Gorev sinirlari: docker bekleme (240 sn) + gateway/worker build + masaustu < 45 dk.
$logon = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$logon.Delay = 'PT{0}S' -f $LogonDelaySeconds
Register-SmithTask -Name $TaskStack -VbsPath $StackVbs -Triggers @($logon) -Settings (New-SmithSettings 45) `
    -Description 'Smith yigini tek komutla ayaga kaldirir: Docker, postgres, redis, gateway, worker, ses izi, masaustu (scripts\smith-up.ps1).'

# Smith Watchdog: -Once + RepetitionInterval, sure VERILMEZ. TUZAK (awareness'ta olculdu):
# `-RepetitionDuration ([TimeSpan]::MaxValue)` Task Scheduler tarafindan REDDEDILIR ve gorev
# hic kurulmaz; sonsuz tekrarin dogru ifadesi bayragi hic vermemektir.
$tick = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $WatchdogMinutes)
Register-SmithTask -Name $TaskWatchdog -VbsPath $WatchdogVbs -Triggers @($tick) -Settings (New-SmithSettings 30) `
    -Description "Smith bekcisi: her $WatchdogMinutes dakikada smith-up -Ensure; 3 ardisik denemede kalkmayan bilesen icin bildirim (scripts\smith-watchdog.ps1)."

# --- Dogrulama --------------------------------------------------------------
if (-not $WhatIfPreference) {
    Write-Host ''
    Write-Host '=== Kurulu gorevler' -ForegroundColor Cyan
    Show-TaskStatus
    Write-Host ''
    Write-Host "Loglar: $ShimDir (task-stack.log, task-watchdog.log), $(Get-SmithLogDir)" -ForegroundColor DarkGray
    Write-Host 'Elle tetiklemek icin: Start-ScheduledTask -TaskName "Smith Stack"' -ForegroundColor DarkGray
}
