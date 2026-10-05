# Smith bekcisi: smith-up.ps1 -Ensure'i calistirir, dusuk kalan bileseni bildirir.
#
# 'Smith Watchdog' zamanlanmis gorevi bunu 5 dakikada bir kosar (smith-autostart.ps1).
# Bir bilesen ARDISIK 3 denemede (smith-up -Ensure kosusunda) kalkmazsa Windows
# bildirimi gosterilir ve logs\watchdog-<yyyyMMdd>.log'a yazilir. Ayni arizada bildirim
# yagmuru olmasin diye ilk bildirimden sonra her 12 denemede bir (5 dk aralikla ~1 saat)
# tekrarlanir. Saglik durumu: <veri koku>\health.json (bkz. smith-common.ps1).
# Disk her turda olculur: uyari 6 saatte, kritik 30 dakikada en fazla bir kez
# (surucu ve seviye basina). Disk uyarisi yalniz bilgidir, silme/durdurma yapmaz.
#
# smith-up.ps1 -Ensure masaustunu BASLATMAZ ve gerekli saymaz (kullanici bilerek
# kapattiysa yeniden acilmaz; masaustu yalniz oturum acilisinda baslar). smith-up
# kendisi cokerse bekci dusmez: hata loglanir, ardisik cokme sayaci
# <veri koku>\watchdog-state.json dosyasinda tutulur ve ayni esikle bildirilir.
#
# Kullanim:
#   .\scripts\smith-watchdog.ps1               # bir tur: ensure + bildirim kontrolu
#   .\scripts\smith-watchdog.ps1 -TestNotify   # yalniz test bildirimi goster
#   .\scripts\smith-watchdog.ps1 -NoDesktop    # smith-up'a -NoDesktop gecir (Ensure zaten baslatmaz)
#
# Cikis kodu: 0 = hepsi ayakta, 1 = en az bir bilesen dusuk ya da smith-up calismadi
# (Task Scheduler sonucu).

[CmdletBinding()]
param(
    [switch]$NoDesktop,
    [switch]$TestNotify,
    [ValidateRange(1, 100)]
    [int]$AlertAfter = 3,
    [ValidateRange(1, 1000)]
    [int]$RepeatEvery = 12
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'smith-common.ps1')
Set-SmithLogName 'watchdog'

if ($TestNotify) {
    $how = Show-SmithToast -Title 'Smith bekcisi: test' -Message 'Bu bir test bildirimidir; bir sey yapmaniz gerekmiyor.'
    Write-SmithLog "test bildirimi gonderildi (yontem: $how)"
    if ($how -like 'none:*') { exit 1 }
    exit 0
}

$up = Join-Path $PSScriptRoot 'smith-up.ps1'
$upParams = @{ Ensure = $true }
if ($NoDesktop) { $upParams.NoDesktop = $true }

# Ayni arizada bildirim yagmuru olmasin: ilk bildirim AlertAfter'da, sonra RepeatEvery'de bir.
function Test-AlertDue([int]$Count) {
    return ($Count -ge $AlertAfter -and ((($Count - $AlertAfter) % $RepeatEvery) -eq 0))
}

# Yalniz disk bildirimi ve state guncellemesi; Now sahte saatle sinanabilir.
function Update-DiskNotifications {
    param($State, $DiskHealth, [datetimeoffset]$Now = [datetimeoffset]::UtcNow)
    if (-not $State.PSObject.Properties['diskBildirimleri']) {
        $State | Add-Member -NotePropertyName diskBildirimleri -NotePropertyValue ([pscustomobject]@{})
    }
    foreach ($disk in $DiskHealth.suruculer) {
        if ($disk.Seviye -eq 'ok') { continue }
        if (-not $State.diskBildirimleri.PSObject.Properties[$disk.Drive]) {
            $State.diskBildirimleri | Add-Member -NotePropertyName $disk.Drive -NotePropertyValue ([pscustomobject]@{})
        }
        $times = $State.diskBildirimleri.PSObject.Properties[$disk.Drive].Value
        $last = $times.PSObject.Properties[$disk.Seviye]
        $lastTime = $null
        if ($last) { $lastTime = $last.Value }
        if (Test-SmithDiskAlertDue -Seviye $disk.Seviye -LastNotification $lastTime -Now $Now) {
            $msg = (Get-SmithDiskHealth -Disks @($disk)).detay
            $how = Show-SmithToast -Title "Smith disk: $($disk.Seviye)" -Message $msg
            Write-SmithLog "Disk bildirimi: $msg (yontem: $how)" 'WARN'
            $times | Add-Member -NotePropertyName $disk.Seviye -NotePropertyValue $Now.ToString('o') -Force
        }
    }
}

$runStart = Get-Date
$statePath = Join-Path (Get-SmithDataDir) 'watchdog-state.json'
$alerts = @()

# Disk bildirimi Ensure'den once: servislerin toparlanmasini beklemez.
$prevState = Read-SmithJson $statePath
if (-not $prevState) { $prevState = [pscustomobject]@{ smithUpCokme = 0 } }
$diskHealth = Get-SmithDiskHealth
Update-DiskNotifications -State $prevState -DiskHealth $diskHealth
# Zamanlar Ensure cokerse de korunur; mevcut state alanlari kaybolmaz.
Write-SmithJson -Path $statePath -Object $prevState

Write-SmithLog 'bekci turu basladi (smith-up -Ensure)'
# smith-up'in her turlu cokmesi (terminating hata) bekciyi dusurmemeli: bekcinin tek isi
# bildirimdir. Surec siniri oldugu icin hata turu ayirt edilmeden yakalanir; mesaj loga
# yazilir ve ardisik cokme sayaci bildirime baglanir.
$upCrash = $null
$upExit = $null
try {
    & $up @upParams
    $upExit = $LASTEXITCODE
    Write-SmithLog "smith-up -Ensure bitti (exit $upExit)"
} catch {
    $upCrash = $_.Exception.Message
    Write-SmithLog "smith-up -Ensure calisirken dustu: $upCrash" 'ERROR'
}

$crashCount = 0
if ($prevState -and $prevState.PSObject.Properties['smithUpCokme']) { $crashCount = [int]$prevState.smithUpCokme }
if ($upCrash) { $crashCount++ } else { $crashCount = 0 }
$prevState | Add-Member -NotePropertyName zaman -NotePropertyValue (Get-Date -Format 'o') -Force
$prevState | Add-Member -NotePropertyName smithUpCokme -NotePropertyValue $crashCount -Force
Write-SmithJson -Path $statePath -Object $prevState
if ($upCrash -and (Test-AlertDue $crashCount)) {
    $alerts += ('smith-up calismiyor ({0} ardisik tur: {1})' -f $crashCount, $upCrash)
}

$healthPath = Join-Path (Get-SmithDataDir) 'health.json'
$health = Read-SmithJson $healthPath
$healthFresh = $false
if ($health -and $health.zaman) { $healthFresh = ([datetime]$health.zaman) -ge $runStart }
if (-not $healthFresh) {
    # Bu turda yazilmamis health.json eski sayaclari tasir: ayni deger her turda yeniden
    # bildirim tetiklemesin diye okunmaz.
    Write-SmithLog "health.json bu turda guncellenmedi (baska bir smith-up kilitli ya da smith-up Save-Health'e ulasamadi): $healthPath" 'WARN'
} else {
    foreach ($p in $health.bilesenler.PSObject.Properties) {
        $fails = [int]$p.Value.ardisikBasarisizlik
        if ($p.Value.up -or $fails -lt $AlertAfter) { continue }
        if (Test-AlertDue $fails) {
            $alerts += ('{0} ({1} ardisik basarisiz: {2})' -f $p.Name, $fails, $p.Value.detay)
        } else {
            Write-SmithLog "$($p.Name) hala dusuk ($fails ardisik), bildirim tekrar penceresinde degil."
        }
    }
}

# Eski saglik dosyasinin zamanini degistirme: disk yazimi servisleri taze gostermez.
if (-not $health) {
    $health = [pscustomobject]@{ zaman = $null; mod = 'watchdog'; tumAyakta = $false; bilesenler = [pscustomobject]@{} }
}
$health.bilesenler | Add-Member -NotePropertyName disk -NotePropertyValue $diskHealth -Force
Write-SmithJson -Path $healthPath -Object $health

if ($alerts.Count -gt 0) {
    $msg = 'Kalkmayan bilesen: ' + ($alerts -join '; ')
    Write-SmithLog $msg 'ERROR'
    $how = Show-SmithToast -Title 'Smith ayaga kalkmiyor' -Message $msg
    Write-SmithLog "bildirim gonderildi (yontem: $how)"
}

if ($upCrash) { exit 1 }
if (-not $healthFresh) { if ($upExit) { exit 1 } else { exit 0 } }
if ($health.tumAyakta) { exit 0 } else { exit 1 }
