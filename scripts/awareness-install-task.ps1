# Smith farkindalik taramasini Windows zamanlanmis gorev olarak kurar (ADR 0006).
#
# IKI GOREV kurulur:
#   SmithAwareness       -> SAATLIK: makine durumu + dosya sistemi rontgeni
#                           (-SkipIntel; gunluk brif saatlik kosuda gereksiz)
#   SmithAwarenessIntel  -> GUNLUK 09:20: dis istihbarat brifi
#
# 09:20 BILINCLI SECIM: kullanicinin mevcut `smith-daily-intel` gorevi 08:35'te
# kosuyor. Ayni dakikaya koymak iki istihbarat isini ust uste bindirir ve embed
# kotasini ayni pencerede iki kez zorlar. Farkli ad + farkli saat = o gorev
# BOZULMADAN yanina kurulur.
#
# TUZAKLAR (olculmus, hafizada kayitli - uyulmustur)
# --------------------------------------------------
# 1. `-RunLevel Highest` (HighestAvailable) gorev kaydinda UAC yukseltmesi
#    ister ve etkilesimsiz kurulumda duser. Farkindalik taramasi yonetici
#    yetkisi GEREKTIRMEZ (salt-okur probe + localhost HTTP) -> LeastPrivilege.
# 2. S4U/Password logon tipi de yukseltme ister -> InteractiveToken. Bedeli:
#    gorev yalniz kullanici oturum acmisken kosar. Bu KABUL EDILEBILIR, cunku
#    tarama zaten gateway'in (kullanici oturumunda kosan) ayakta olmasini
#    gerektirir.
# 3. `Start-Process -WindowStyle Minimized` yine de pencere CIZER. Tek gercek
#    gizli yol: `WScript.Shell.Run(cmd, 0, $false)` - bu yuzden gorev
#    wscript.exe uzerinden bir VBS shim cagirir (`SmithGithubRunner` gorevi de
#    ayni deseni kullaniyor).
#
# IDEMPOTENT: -Force mevcut gorevi yerinde gunceller; kayit basarisiz olursa
# calisan eski gorev silinmez.
#
# Kullanim:
#   .\scripts\awareness-install-task.ps1              # kur/guncelle
#   .\scripts\awareness-install-task.ps1 -Uninstall   # kaldir
#   .\scripts\awareness-install-task.ps1 -HourlyMinute 15 -IntelTime 09:20

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [ValidateRange(0, 59)]
    [int]$HourlyMinute = 10,
    [string]$IntelTime = '09:20',
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'smith-common.ps1')
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ScanScript = Join-Path $RepoRoot 'scripts\awareness-scan.ps1'
$TaskHourly = 'SmithAwareness'
$TaskIntel = 'SmithAwarenessIntel'

# SHIM/LOG DIZINI KASTEN AppData ALTINDA DEGIL, tek veri kokunun altindadir
# (<veri koku>\awareness; kok: SMITH_DATA_DIR ya da %USERPROFILE%\.smith, bkz.
# smith-common.ps1) - bu isin en pahali tuzagi buydu. MSIX paketli bir uygulamanin
# (Claude Desktop) icinden yazilan AppData yollari paketin sanal deposuna yonlendirilir.
# Shim'ler oraya yazilinca ZAMANLANMIS GOREV onlari GORMEDI: `wscript.exe` her
# tetiklemede LastTaskResult=1 ile dustu ve hicbir log uretmedi. Belirti "VBS bozuk"
# gibi gorunur - oysa VBS elle kosuldugunda sorunsuz calisiyordu; fark yolun
# GORUNURLUGUNDEYDI. Veri koku sanallastirilmaz.
$AwarenessDir = Join-Path (Resolve-SmithDataDir) 'awareness'
$VbsHourly = Join-Path $AwarenessDir 'run-awareness-hidden.vbs'
$VbsIntel = Join-Path $AwarenessDir 'run-awareness-intel-hidden.vbs'
$CmdHourly = Join-Path $AwarenessDir 'run-awareness.cmd'
$CmdIntel = Join-Path $AwarenessDir 'run-awareness-intel.cmd'
$LogHourly = Join-Path $AwarenessDir 'task-hourly.log'
$LogIntel = Join-Path $AwarenessDir 'task-intel.log'

function Remove-TaskIfExists([string]$Name) {
    $existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
        Write-Host "  kaldirildi: $Name" -ForegroundColor DarkGray
        return $true
    }
    return $false
}

if ($Uninstall) {
    Write-Host '=== Smith farkindalik gorevleri kaldiriliyor' -ForegroundColor Cyan
    $a = Remove-TaskIfExists $TaskHourly
    $b = Remove-TaskIfExists $TaskIntel
    if (-not ($a -or $b)) { Write-Host '  kurulu gorev yoktu.' -ForegroundColor DarkGray }
    Write-Host 'Bitti.' -ForegroundColor Green
    return
}

if (-not (Test-Path $ScanScript)) { throw "Tarama script'i yok: $ScanScript" }
New-Item -ItemType Directory -Force -Path $AwarenessDir | Out-Null

# --- VBS shim'leri: pencere CIZMEYEN tek yol (bkz. tuzak 3) ------------------
# pwsh yerine powershell.exe: gorev her makinede calissin diye Windows'ta
# garanti var olan kabuk secilir. Cikti log'a yonlendirilir; gorev penceresi
# olmadigi icin log tek gozlem yuzeyidir.
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Write-HiddenShim([string]$VbsPath, [string]$CmdPath, [string]$ScanArgs, [string]$LogFile) {
    # IKI PARCALI SHIM - ve bu bolunme bilinclidir.
    #
    # TUZAK (olculdu): tek parcali surumde VBS'in kendisi tum komutu ic ice
    # tirnaklarla kuruyordu (`cmd /c ""...ps1"" ... >> ""...log"" 2>&1`). O surum
    # ELLE kosuldugunda (wscript ve cscript, ikisi de exit 0) CALISIYOR, ama
    # ZAMANLANMIS GOREVDEN kosuldugunda wscript exit 1 verip hicbir sey
    # yazmiyordu - yani "elle test ettim, calisiyor" kaniti YANILTICI cikti.
    # Bu makinede KANITLANMIS calisan desen (`SmithGithubRunner` gorevi,
    # LastTaskResult 0) VBS'in yalniz TEK bir .cmd dosyasini cagirmasidir.
    # Yonlendirme ve argumanlar .cmd icine tasinir; VBS'te tirnak ic-ice
    # gecmesi kalmaz.
    #
    # Uretim ortak yardimciya tasindi (smith-common.ps1 -> Write-HiddenTaskShim; ayni
    # desen smith-autostart.ps1 gorevlerinde de kullaniliyor). Iki degisiklik:
    #  - CIKIS KODU: eski shim `Run ..., 0, False` ile beklemeden donuyordu; tarama dusse
    #    de gorev sonucu (LastTaskResult) hep 0 kaliyordu. Yeni shim bekler ve betigin
    #    cikis kodunu WScript.Quit ile gorev sonucuna tasir (0 = pencere gizli, True = bekle).
    #  - LOG DONDURME: .cmd, task-*.log 1 MB'i asinca tek yedege (.1) tasir.
    # Mevcut shim dosyalari bu script tekrar kosturulana dek eski halinde kalir.
    Write-HiddenTaskShim -VbsPath $VbsPath -CmdPath $CmdPath -Interpreter $PowerShellExe `
        -ScriptPath $ScanScript -ScriptArgs $ScanArgs -LogFile $LogFile `
        -Title 'Smith farkindalik taramasi (ADR 0006)' -Generator 'scripts\awareness-install-task.ps1'
    Write-Host "  shim: $CmdPath + $VbsPath" -ForegroundColor DarkGray
}

Write-Host '=== Smith farkindalik gorevleri kuruluyor' -ForegroundColor Cyan
Write-HiddenShim $VbsHourly $CmdHourly '-SkipIntel' $LogHourly
Write-HiddenShim $VbsIntel $CmdIntel '-Only intel' $LogIntel

# --- Ortak principal/ayarlar ------------------------------------------------
# LeastPrivilege + InteractiveToken: yukseltme ISTEMEZ (bkz. tuzak 1 ve 2).
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 5)

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

function Register-AwarenessTask {
    param(
        [string]$Name,
        [string]$VbsPath,
        [Microsoft.Management.Infrastructure.CimInstance[]]$Triggers,
        [string]$Description
    )
    $action = New-ScheduledTaskAction -Execute $wscript -Argument "`"$VbsPath`"" -WorkingDirectory $RepoRoot
    # -ErrorAction Stop SART: Register-ScheduledTask XML reddini NON-TERMINATING
    # hata olarak verir. Onu yakalamadan "kaydedildi" basmak, gorev hic
    # kurulmamisken basari raporlamak demektir (bir kez yasandi: gecersiz
    # RepetitionDuration -> gorev yok, cikti "kaydedildi").
    Register-ScheduledTask `
        -TaskName $Name `
        -Action $action `
        -Trigger $Triggers `
        -Principal $principal `
        -Settings $settings `
        -Description $Description `
        -Force `
        -ErrorAction Stop | Out-Null
    # Kayit iddiasi DOGRULANIR; gorev gercekten sorgulanabiliyor mu?
    if (-not (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue)) {
        throw "Gorev kaydi bildirildi ama gorev bulunamadi: $Name"
    }
    Write-Host "  kaydedildi ve dogrulandi: $Name" -ForegroundColor Green
}

# --- SmithAwareness: SAATLIK -----------------------------------------------
# Bugunun saat basindan $HourlyMinute dakika sonrasi referans alinir ve 1 saat
# araliklarla SURESIZ tekrarlanir.
#
# TUZAK (olculdu): `-RepetitionDuration ([TimeSpan]::MaxValue)` XML'e
# `P99999999DT23H59M59S` yazar ve Task Scheduler bunu "aralik disi deger" diye
# REDDEDER - gorev hic kurulmaz. Sonsuz tekrarin dogru ifadesi bayragi HIC
# VERMEMEKTIR: uretilen XML'de <Duration> alani olusmaz, bu da Task
# Scheduler'da "sonsuza kadar tekrarla" anlamina gelir (dogrulandi).
$hourlyStart = (Get-Date -Minute $HourlyMinute -Second 0).AddHours(1)
$hourlyTrigger = New-ScheduledTaskTrigger -Once -At $hourlyStart `
    -RepetitionInterval (New-TimeSpan -Hours 1)
# Oturum acilisinda da bir kez kossun: makine kapaliyken kacirilan saatler
# `StartWhenAvailable` ile telafi edilir, ama acilista taze bir tarama iyidir.
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$logonTrigger.Delay = 'PT3M'  # gateway ve docker ayaga kalksin

Register-AwarenessTask -Name $TaskHourly -VbsPath $VbsHourly `
    -Triggers @($hourlyTrigger, $logonTrigger) `
    -Description 'Smith surekli farkindalik: makine durumu + dosya sistemi rontgeni (saatlik, delta -> degisiklik yoksa 0 embed). ADR 0006.'

# --- SmithAwarenessIntel: GUNLUK ------------------------------------------
$intelTrigger = New-ScheduledTaskTrigger -Daily -At $IntelTime
Register-AwarenessTask -Name $TaskIntel -VbsPath $VbsIntel `
    -Triggers @($intelTrigger) `
    -Description "Smith surekli farkindalik: gunluk dis istihbarat brifi (Product Hunt / TAAFT / Hacker News). $IntelTime - mevcut smith-daily-intel (08:35) ile cakismaz. ADR 0006."

# --- Dogrulama -------------------------------------------------------------
Write-Host ''
Write-Host '=== Kurulu gorevler' -ForegroundColor Cyan
Get-ScheduledTask -TaskName $TaskHourly, $TaskIntel |
    Select-Object TaskName, State,
        @{ n = 'Tetikleyici'; e = { ($_.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ', ' } } |
    Format-Table -AutoSize | Out-String | Write-Host

Get-ScheduledTaskInfo -TaskName $TaskHourly |
    Select-Object TaskName, NextRunTime, LastRunTime, LastTaskResult |
    Format-Table -AutoSize | Out-String | Write-Host
Get-ScheduledTaskInfo -TaskName $TaskIntel |
    Select-Object TaskName, NextRunTime, LastRunTime, LastTaskResult |
    Format-Table -AutoSize | Out-String | Write-Host

Write-Host "Saatlik log : $LogHourly" -ForegroundColor DarkGray
Write-Host "Gunluk log  : $LogIntel" -ForegroundColor DarkGray
Write-Host "Tarama log  : $(Join-Path $AwarenessDir 'awareness-scan.log')" -ForegroundColor DarkGray
Write-Host ''
Write-Host 'Elle tetiklemek icin: Start-ScheduledTask -TaskName SmithAwareness' -ForegroundColor DarkGray
if (-not $NoStart) {
    Write-Host 'Ilk kosu tetikleniyor (SmithAwareness)...' -ForegroundColor Cyan
    Start-ScheduledTask -TaskName $TaskHourly
}
