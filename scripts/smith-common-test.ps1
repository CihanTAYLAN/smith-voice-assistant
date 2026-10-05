# smith-common.ps1 ve smith-up.ps1 icin kendi kendine yeten sinama betigi.
#
# Kapsadigi ana arizalar (ikisi de canli kosuda olculdu):
#   1) Log temizligi JOKER kusuru: Remove-OldSmithLogs `-Filter '*-????????.log'` ile
#      aday aliyordu; Win32 jokerinde `?` uzanti noktasindan once SIFIR karakterle de
#      eslestigi icin `desktop-cargo.log` gibi tarihsiz tani loglari silindi. Sinama:
#      aday listesi genis, silmeden once TAM ad dogrulamasi.
#   2) Masaustu dev yolu: `pnpm tauri dev` derlemesi dakikalar surer; smith-up 30 sn sonra
#      "surec yok" diyip DOWN raporluyordu. Sinama: launcher calisiyorsa `starting`,
#      tavan asilinca `stuck`, ikinci masaustu ASLA baslatilmaz.
#
# GUVENLIK: yalniz %TEMP% altindaki gecici klasorde calisir; SMITH_DATA_DIR oraya
# yonlendirilir ve silme ONCESI log dizininin gecici klasor oldugu dogrulanir.
# Gercek veri kokune (SMITH_DATA_DIR ya da %USERPROFILE%\.smith) dokunmaz. Masaustu
# sinamalari SAHTE surec kullanir (uyuyan bir kabuk); gercek masaustu baslatilmaz/durdurulmaz.
# smith-up testleri -DryRun ve -Status kosar; hicbir sey baslatmaz, health izole yazilir.
#
# Kullanim (iki kabukta da yesil olmali):
#   powershell.exe -NoProfile -File scripts\smith-common-test.ps1
#   pwsh -NoProfile -File scripts\smith-common-test.ps1
# Cikis: 0 = hepsi gecti, 1 = en az bir sinama kaldi.
[CmdletBinding()]
param(
    # -SkipE2E: smith-up -DryRun/-Status alt sureclerini kosma (salt-okur yoklama yapar).
    [switch]$SkipE2E
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'smith-common.ps1')
. (Join-Path $PSScriptRoot 'powershell-test-helpers.ps1')

Initialize-SmithTestRun

# Eski konum uyarisi (Get-SmithDataDir ilk cagrida) bu makinenin GERCEK eski dizinlerini
# okur; test gurultusu olmasin diye kapatilir. Uyari davranisinin kendisi asagidaki
# 'Eski konum uyarisi' vakasinda sahte dizinlerle ve bayrak acilarak sinanir.
$script:SmithLegacyNoticeDone = $true

function New-AgedFile {
    param([string]$Dir, [string]$Name, [int]$AgeDays, [string]$Content = 'x')
    $p = Join-Path $Dir $Name
    [System.IO.File]::WriteAllText($p, $Content)
    (Get-Item -LiteralPath $p).LastWriteTime = (Get-Date).AddDays(-$AgeDays)
}

# --- Gecici calisma alani ------------------------------------------------------

$tempRoot = [System.IO.Path]::GetTempPath()
$work = Join-Path $tempRoot ('smith-common-test-{0}-{1}' -f $PID, [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$prevDataDir = $env:SMITH_DATA_DIR
$prevDesktopProc = $env:SMITH_DESKTOP_PROCESS_NAME
$fakeProcs = New-Object System.Collections.Generic.List[object]

# Gecici klasorde SMITH_DATA_DIR kurar ve log dizininin GERCEKTEN orasi oldugunu kanitlar;
# degilse silme yapan hicbir sey calistirilmaz.
function Use-TempDataDir([string]$Name) {
    $dir = Join-Path $work $Name
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $env:SMITH_DATA_DIR = $dir
    $expected = Join-Path $dir 'logs'
    $actual = Get-SmithLogDir
    if ($actual -ne $expected) { throw "GUVENLIK: log dizini gecici klasor degil ($actual != $expected), sinama durduruldu." }
    return $actual
}

# Sahte masaustu launcher'i: uyuyan bir kabuk; komut satirinda base64 govde (smith-up'in
# Start-DesktopComponent'inin urettigi -EncodedCommand bicimi) tasir.
function Start-FakeDesktopLauncher {
    $body = "Start-Sleep -Seconds 600 # pnpm --filter '@smith/desktop' tauri dev (SAHTE sinama sureci)"
    $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($body))
    $exe = (Get-Process -Id $PID).Path
    $p = Start-Process -FilePath $exe -ArgumentList @('-NoProfile', '-EncodedCommand', $enc) -WindowStyle Hidden -PassThru
    $fakeProcs.Add($p)
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        $snap = Get-ProcessSnapshotForTest
        if (@($snap | Where-Object { $_.ProcessId -eq $p.Id }).Count -gt 0) { return $p }
        Start-Sleep -Milliseconds 300
    }
    throw "Sahte launcher surec listesinde gorunmedi (pid $($p.Id))."
}
function Get-ProcessSnapshotForTest {
    return @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } |
            Select-Object ProcessId, Name, CommandLine, CreationDate)
}
function Stop-FakeProcesses {
    foreach ($p in $fakeProcs) {
        if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    }
    $fakeProcs.Clear()
}

try {

    # === 0) Veri koku (tek kural) ve eski konum uyarisi ===============================

    Invoke-Case 'Veri koku: SMITH_DATA_DIR > %USERPROFILE%\.smith; AppData asla kullanilmaz' {
        Assert-True 'SMITH_DATA_DIR varsa o' ((Resolve-SmithDataDir -DataDir 'D:\veri' -UserProfile 'C:\Users\x') -ceq 'D:\veri')
        Assert-True 'bos/bosluk env tanimsiz sayilir, deger kirpilir' (
            ((Resolve-SmithDataDir -DataDir '   ' -UserProfile 'C:\Users\x') -ceq (Join-Path 'C:\Users\x' '.smith')) -and
            ((Resolve-SmithDataDir -DataDir '  D:\veri  ' -UserProfile 'C:\Users\x') -ceq 'D:\veri'))
        Assert-True 'varsayilan USERPROFILE altinda .smith' ((Resolve-SmithDataDir -DataDir '' -UserProfile 'C:\Users\x') -ceq (Join-Path 'C:\Users\x' '.smith'))

        $saved = @{ D = $env:SMITH_DATA_DIR; L = $env:LOCALAPPDATA; A = $env:APPDATA; H = $env:HOME }
        try {
            Remove-Item Env:\SMITH_DATA_DIR -ErrorAction SilentlyContinue
            $env:LOCALAPPDATA = 'C:\Users\x\AppData\Local'
            $env:APPDATA = 'C:\Users\x\AppData\Roaming'
            $resolved = Resolve-SmithDataDir
            Assert-True 'process env: varsayilan = %USERPROFILE%\.smith' ($resolved -ceq (Join-Path $env:USERPROFILE '.smith')) $resolved
            Assert-True 'LOCALAPPDATA/APPDATA tabanli DEGIL' (($resolved -notlike 'C:\Users\x\AppData*') -and ($resolved -notlike "$env:LOCALAPPDATA*"))
            # Ev dizini yoksa AppData'ya DUSMEZ: acik hata.
            Remove-Item Env:\HOME -ErrorAction SilentlyContinue
            $threw = $false
            try { $null = Resolve-SmithDataDir -DataDir '' -UserProfile '' } catch { $threw = $_.Exception.Message -match 'Veri koku cozulemedi' }
            Assert-True 'ev dizini yoksa AppData yedegi yok: acik hata' $threw
        } finally {
            foreach ($pair in @(@('SMITH_DATA_DIR', 'D'), @('LOCALAPPDATA', 'L'), @('APPDATA', 'A'), @('HOME', 'H'))) {
                if ($null -eq $saved[$pair[1]]) { Remove-Item "Env:\$($pair[0])" -ErrorAction SilentlyContinue } else { Set-Item "Env:\$($pair[0])" $saved[$pair[1]] }
            }
        }
    }

    Invoke-Case 'Get-SmithDataDir: cozulen koku olusturur; Resolve yan etkisizdir' {
        $dir = Join-Path $work 'datadir-yeni'
        $env:SMITH_DATA_DIR = $dir
        Assert-True 'Resolve dizin olusturmaz' (((Resolve-SmithDataDir) -ceq $dir) -and -not (Test-Path -LiteralPath $dir))
        Assert-True 'Get-SmithDataDir ayni yolu doner ve olusturur' (((Get-SmithDataDir) -ceq $dir) -and (Test-Path -LiteralPath $dir -PathType Container))
        Assert-True 'log dizini kokun altinda' ((Get-SmithLogDir) -ceq (Join-Path $dir 'logs'))
    }

    Invoke-Case 'Eski konum uyarisi: isaret yokken ve eski konumda veri varken; isaret/bos/kilit/surec basina bir kez' {
        $local = Join-Path $work 'legacy-local'
        $roots = Get-SmithLegacyDataRoots -LocalAppData $local
        Assert-True 'iki eski kok: gercek ve paket' ($roots.Count -eq 2 -and $roots[0].Label -ceq 'gercek' -and $roots[1].Label -ceq 'paket')
        Assert-True 'gercek kok = <LocalAppData>\smith' ($roots[0].Path -ceq (Join-Path $local 'smith'))
        Assert-True 'paket koku = Packages\<aile>\LocalCache\Local\smith' ($roots[1].Path -ceq (Join-Path $local 'Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\smith'))
        Assert-True 'LocalAppData yoksa eski kok yok' (@(Get-SmithLegacyDataRoots -LocalAppData '').Count -eq 0)

        $data = Join-Path $work 'legacy-yeni-kok'
        # 1) Eski konumlar yok/bos: uyari yok.
        Assert-True 'eski konum yokken uyari yok' ($null -eq (Get-SmithLegacyDataNotice -DataDir $data -LegacyRoots $roots))
        New-Item -ItemType Directory -Force -Path $roots[0].Path | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $roots[0].Path 'smith-up.lock'), '')
        [System.IO.File]::WriteAllText((Join-Path $roots[0].Path 'x.tmp'), '1')
        Assert-True 'yalniz kilit/gecici dosya veri sayilmaz' ($null -eq (Get-SmithLegacyDataNotice -DataDir $data -LegacyRoots $roots))

        # 2) Veri var + kok HIC yok: tam senaryo.
        New-Item -ItemType Directory -Force -Path (Join-Path $roots[1].Path 'speaker') | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $roots[1].Path 'speaker\owner_adapt.npy'), 'x')
        $msg = Get-SmithLegacyDataNotice -DataDir $data -LegacyRoots $roots
        Assert-True 'uyari: veri koku bos + tasima betigi + eski yol' ($msg -match 'veri koku bos' -and $msg -match 'smith-migrate-data.ps1' -and $msg.Contains($roots[1].Path))
        Assert-True 'veri olmayan eski kok uyaridan hari (gercek: yalniz kilit)' (-not $msg.Contains($roots[0].Path))

        # 3) Kok dolu ama isaret yok: yine uyari (yarim tasima). Isaret: susar.
        New-Item -ItemType Directory -Force -Path $data | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $data 'window.json'), '{}')
        Assert-True 'kok dolu ama isaret yokken uyari surer' ($null -ne (Get-SmithLegacyDataNotice -DataDir $data -LegacyRoots $roots))
        [System.IO.File]::WriteAllText((Join-Path $data $script:SmithMigrationMarker), '{}')
        Assert-True 'tasima isareti varsa uyari yok' ($null -eq (Get-SmithLegacyDataNotice -DataDir $data -LegacyRoots $roots))
        Remove-Item -LiteralPath (Join-Path $data $script:SmithMigrationMarker) -Force

        # 4) Get-SmithDataDir: surec basina TEK uyari (bayrak acik), veri kokunu yine kullanir.
        $savedLocal = $env:LOCALAPPDATA
        try {
            $env:LOCALAPPDATA = $local
            $env:SMITH_DATA_DIR = $data
            $script:SmithLegacyNoticeDone = $false
            $captured = & { $null = Get-SmithDataDir; $null = Get-SmithDataDir; $null = Get-SmithLogDir } 6>&1
            $warns = @($captured | Where-Object { $_ -is [System.Management.Automation.InformationRecord] } |
                    ForEach-Object { [string]$_.MessageData } | Where-Object { $_ -match 'veri koku bos' })
            Assert-True 'uyari surec basina bir kez yazilir' ($warns.Count -eq 1) "uyari sayisi: $($warns.Count)"
            Assert-True 'uyari WARN seviyeli' ($warns[0] -match '\[WARN\]')
            Assert-True 'yeni kokle devam edilir (eski konuma yazilmaz)' ((Get-SmithDataDir) -ceq $data)
        } finally {
            $env:LOCALAPPDATA = $savedLocal
            $script:SmithLegacyNoticeDone = $true
        }
    }

    Invoke-Case 'Read-SmithSharedText: yazmaya acik tutulan dosya okunur (File.ReadAllText ayni durumda patlar)' {
        $p = Join-Path $work 'paylasimli.txt'
        $writer = [System.IO.File]::Open($p, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes('merhaba dunya')
            $writer.Write($bytes, 0, $bytes.Length)
            $writer.Flush()
            Assert-True 'paylasimli okuma icerigi verir' ((Read-SmithSharedText $p) -ceq 'merhaba dunya')
            $threw = $false
            try { $null = [System.IO.File]::ReadAllText($p) } catch [System.IO.IOException] { $threw = $true }
            Assert-True 'eski yontem (ReadAllText) IOException verir' $threw
        } finally { $writer.Dispose() }
    }

    Invoke-Case 'Invoke-SmithNative: zaman asiminda SUREC AGACI durdurulur, cikti okunur (sahte surec agaci)' {
        $exe = (Get-Process -Id $PID).Path
        $pidFile = Join-Path $work 'agac-torun.pid'
        $childCmd = "Set-Content -LiteralPath '$pidFile' -Value `$PID; Start-Sleep -Seconds 600"
        $childEnc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($childCmd))
        # Ebeveyn (kok surec) torunu AYNI yonlendirilmis tutamaclarla baslatir ve kendisi de uyur:
        # gercek scp.exe -> ssh.exe iliskisinin sahtesi.
        $parentCmd = "Start-Process -FilePath '$exe' -ArgumentList '-NoProfile','-EncodedCommand','$childEnc' -NoNewWindow; Start-Sleep -Seconds 600"
        $parentEnc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($parentCmd))
        $grandchild = $null
        try {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $r = Invoke-SmithNative -FilePath $exe -ArgumentList @('-NoProfile', '-EncodedCommand', $parentEnc) -TimeoutSec 6
            $sw.Stop()
            if (Test-Path -LiteralPath $pidFile) { $grandchild = [int]((Get-Content -LiteralPath $pidFile -Raw).Trim()) }
            Assert-True 'zaman asimi bildirilir' ($r.TimedOut -and $r.ExitCode -eq -1)
            Assert-True 'cagri asili kalmadan doner (zaman asimi + kisa pay)' ($sw.Elapsed.TotalSeconds -lt 30) "sure: $([int]$sw.Elapsed.TotalSeconds) sn"
            Assert-True 'cikti dosyalari okundu (kalan tutamac okumayi dusurmedi)' (($r.Output -is [string]) -and ($r.Error -is [string]))
            Assert-True 'sahte torun surec basladi (test gecerli)' ($null -ne $grandchild) 'torun PID dosyasi yok'
            if ($null -ne $grandchild) {
                $gone = $false
                for ($i = 0; $i -lt 40; $i++) {
                    if (-not (Get-Process -Id $grandchild -ErrorAction SilentlyContinue)) { $gone = $true; break }
                    Start-Sleep -Milliseconds 250
                }
                Assert-True 'torun surec de oldu (yalniz kok degil, TUM AGAC)' $gone "torun pid $grandchild hala calisiyor"
            }
        } finally {
            # Test hicbir kosulda 600 sn uyuyan surec birakmaz.
            if ($null -eq $grandchild -and (Test-Path -LiteralPath $pidFile)) { $grandchild = [int]((Get-Content -LiteralPath $pidFile -Raw).Trim()) }
            if ($null -ne $grandchild) { Stop-Process -Id $grandchild -Force -ErrorAction SilentlyContinue }
        }
    }

    Invoke-Case 'Invoke-SmithNative: normal cikis (stdout, stderr, cikis kodu) degismedi' {
        $exe = (Get-Process -Id $PID).Path
        $cmd = "[Console]::Out.Write('merhaba'); [Console]::Error.Write('uyari'); exit 7"
        $r = Invoke-SmithNative -FilePath $exe -ArgumentList @('-NoProfile', '-Command', $cmd) -TimeoutSec 60
        Assert-True 'cikis kodu 7, zaman asimi yok' ($r.ExitCode -eq 7 -and -not $r.TimedOut)
        Assert-True 'stdout ve stderr okunur' ($r.Output -ceq 'merhaba' -and $r.Error -ceq 'uyari') "out=[$($r.Output)] err=[$($r.Error)]"
    }

    Invoke-Case 'STT: bilesen sagligi ve bagimsiz launcher (sunucu acilmaz)' {
        $tokens = $null; $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'smith-up.ps1'), [ref]$tokens, [ref]$errors)
        $SttScriptsRoot = $PSScriptRoot
        foreach ($name in @('New-State', 'Get-ComponentState', 'Start-ScriptComponent')) {
            $fn = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
            . ([scriptblock]::Create($fn.Extent.Text.Replace('$PSScriptRoot', '$SttScriptsRoot')))
        }
        $script:SttPortUp = $true
        function Test-SmithTcpPort($Port) { return $Port -eq 8123 -and $script:SttPortUp }
        function Get-LauncherState($Snap, $Name, $Detail) { return $null }
        $state = Get-ComponentState -Name 'stt' -Snap @() -Desktop $null
        Assert-True 'STT 8123 up, model tembel bilgisi' ($state.Up -and $state.Detail -match 'tembel')
        $script:SttPortUp = $false
        $state = Get-ComponentState -Name 'stt' -Snap @() -Desktop $null
        Assert-True 'STT yoksa down' (-not $state.Up -and $state.State -eq 'down')
        $entry = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$Launchers' }, $true)
        $Launchers = $entry.Find({ param($node) $node -is [System.Management.Automation.Language.HashtableAst] }, $true).SafeGetValue()
        $script:SttLaunch = $null
        function Start-HiddenShell($Name, $ShellArgs) { $script:SttLaunch = "$Name $ShellArgs" }
        Start-ScriptComponent 'stt'
        Assert-True 'STT bagimsiz baslaticiyi standart argumanlarla cagirir' ($script:SttLaunch -match 'stt-server.ps1"$')
        Assert-True 'STT baslatici dosyasi mevcut' (Test-Path -LiteralPath (Join-Path $PSScriptRoot $Launchers.stt))
        $common = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'smith-common.ps1'), [ref]$tokens, [ref]$errors)
        Assert-True 'ortak kutuphane giris noktasi parametresi tasimaz' ($null -eq $common.ParamBlock)
        Assert-True 'STT log ureticisi kayitli' (Test-SmithLogName 'stt-20261003.log')
    }

    Invoke-Case 'Disk: esikler, ayni surucu ve tr-TR' {
        $culture = [System.Threading.Thread]::CurrentThread.CurrentCulture
        try {
            [System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::GetCultureInfo('tr-TR')
            foreach ($row in @(@(12, 'ok'), @(9, 'uyari'), @(4, 'kritik'), @(10, 'ok'), @(5, 'uyari'), @(0, 'kritik'))) {
                $disks = @(Get-SmithDiskStatus -DockerDataPath 'c:\Docker\disk\docker_data.vhdx' -WarnGB 10 -CritGB 5 -DriveMetrics @{ 'c:' = @{ FreeGB = $row[0]; TotalGB = 100 } })
                Assert-True "$($row[0]) GB -> $($row[1])" ($disks.Count -eq 1 -and $disks[0].Seviye -ceq $row[1])
                Assert-True 'kapasite ve surucu korunur' ($disks[0].Drive -ceq 'C:' -and $disks[0].FreeGB -eq $row[0] -and $disks[0].TotalGB -eq 100)
            }
            $disks = @(Get-SmithDiskStatus -DockerDataPath 'I:\Docker\disk\docker_data.vhdx' -WarnGB 10 -CritGB 5 -DriveMetrics @{ 'C:' = @{ FreeGB = 12; TotalGB = 100 }; 'I:' = @{ FreeGB = 4; TotalGB = 200 } })
            Assert-SetEqual 'Docker baska surucudeyse ikisi izlenir (buyuk I)' @($disks.Drive) @('C:', 'I:')
            $health = Get-SmithDiskHealth -Disks $disks
            Assert-True 'disk up kalir, en kotu seviye kritik' ($health.up -and $health.seviye -eq 'kritik' -and $health.ardisikBasarisizlik -eq 0)
            Assert-True 'health surucu detaylarini tasir' ($health.suruculer.Count -eq 2 -and $health.detay -cmatch 'I: 4 GB bos / 200 GB \(kritik\)')
        } finally { [System.Threading.Thread]::CurrentThread.CurrentCulture = $culture }
    }

    Invoke-Case 'Disk: env esikleri ve varsayilanlar' {
        $warn = $env:SMITH_DISK_WARN_GB
        $crit = $env:SMITH_DISK_CRIT_GB
        try {
            $fixture = @{ 'C:' = @{ FreeGB = 12; TotalGB = 100 } }
            $env:SMITH_DISK_WARN_GB = $null
            $env:SMITH_DISK_CRIT_GB = $null
            Assert-True 'varsayilan 10/5: 12 GB ok' ((Get-SmithDiskStatus -DockerDataPath 'C:\docker_data.vhdx' -DriveMetrics $fixture).Seviye -eq 'ok')
            $env:SMITH_DISK_WARN_GB = '15.5'
            $env:SMITH_DISK_CRIT_GB = '7.5'
            Assert-True 'env uyari esigi okunur' ((Get-SmithDiskStatus -DockerDataPath 'C:\docker_data.vhdx' -DriveMetrics $fixture).Seviye -eq 'uyari')
            $fixture['C:'].FreeGB = 7
            Assert-True 'env kritik esigi okunur' ((Get-SmithDiskStatus -DockerDataPath 'C:\docker_data.vhdx' -DriveMetrics $fixture).Seviye -eq 'kritik')
            $fixture['C:'].FreeGB = 9.999
            Assert-True 'siniflandirma yuvarlamadan once yapilir, parametre envden ustun' ((Get-SmithDiskStatus -DockerDataPath 'C:\docker_data.vhdx' -DriveMetrics $fixture -WarnGB 10 -CritGB 5).Seviye -eq 'uyari')
        } finally {
            $env:SMITH_DISK_WARN_GB = $warn
            $env:SMITH_DISK_CRIT_GB = $crit
        }
    }

    Invoke-Case 'Disk: sahte zamanla bildirim kisma ve JSON yeniden okuma' {
        $null = Use-TempDataDir 'disk-throttle'
        $now = [datetimeoffset]'2026-10-23T12:00:00.750+05:00'
        $path = Join-Path (Get-SmithDataDir) 'watchdog-state.json'
        Write-SmithJson -Path $path -Object @{ diskBildirimleri = @{ 'C:' = @{ uyari = $now.ToString('o'); kritik = $now.ToString('o') } } }
        $state = (Read-SmithJson $path).diskBildirimleri.'C:'
        Assert-True 'ok hic bildirim uretmez' (-not (Test-SmithDiskAlertDue -Seviye ok -Now $now))
        Assert-True 'ilk uyari hemen' (Test-SmithDiskAlertDue -Seviye uyari -Now $now)
        Assert-True 'ilk kritik hemen (uyari zamanindan bagimsiz)' (Test-SmithDiskAlertDue -Seviye kritik -Now $now)
        Assert-True 'uyari 6 saatten once kisilir' (-not (Test-SmithDiskAlertDue -Seviye uyari -LastNotification $state.uyari -Now $now.AddHours(6).AddSeconds(-1)))
        Assert-True 'uyari tam 6 saatte gelir' (Test-SmithDiskAlertDue -Seviye uyari -LastNotification $state.uyari -Now $now.AddHours(6))
        Assert-True 'kritik 30 dakikadan once kisilir' (-not (Test-SmithDiskAlertDue -Seviye kritik -LastNotification $state.kritik -Now $now.AddMinutes(30).AddSeconds(-1)))
        Assert-True 'kritik tam 30 dakikada gelir' (Test-SmithDiskAlertDue -Seviye kritik -LastNotification $state.kritik -Now $now.AddMinutes(30))
        Assert-True 'JSON saat dilimi ve milisaniyeyi korur' (-not (Test-SmithDiskAlertDue -Seviye kritik -LastNotification $state.kritik -Now $now.AddMinutes(30).AddMilliseconds(-1)))
        Assert-True 'saat geri alinirsa tekrar bildirim yok' (-not (Test-SmithDiskAlertDue -Seviye kritik -LastNotification $state.kritik -Now $now.AddHours(-1)))
    }

    Invoke-Case 'Disk: bekci state, seviye gecisi ve yeniden baslatma' {
        $tokens = $null
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'smith-watchdog.ps1'), [ref]$tokens, [ref]$errors)
        $fn = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Update-DiskNotifications' }, $true)
        . ([scriptblock]::Create($fn.Extent.Text))
        $observed = @{ Toasts = 0 }
        function Show-SmithToast { param($Title, $Message) $observed.Toasts++; return 'test' }
        function Write-SmithLog { param($Message, $Level) }
        $null = Use-TempDataDir 'disk-watchdog'
        $path = Join-Path (Get-SmithDataDir) 'watchdog-state.json'
        $state = [pscustomobject]@{ smithUpCokme = 2 }
        $disk = [pscustomobject]@{ Drive = 'C:'; FreeGB = [double]9; TotalGB = [double]100; Seviye = 'uyari' }
        $health = Get-SmithDiskHealth -Disks @($disk)
        $now = [datetimeoffset]'2026-10-23T12:00:00.750+05:00'
        Update-DiskNotifications -State $state -DiskHealth $health -Now $now
        Write-SmithJson -Path $path -Object $state
        $state = Read-SmithJson $path
        Update-DiskNotifications -State $state -DiskHealth $health -Now $now.AddMinutes(5)
        Assert-True 'yeniden okunan state uyariyi kisar, cokme sayaci korunur' ($observed.Toasts -eq 1 -and $state.smithUpCokme -eq 2)
        $disk.Seviye = 'kritik'
        $disk.FreeGB = 4
        Update-DiskNotifications -State $state -DiskHealth $health -Now $now.AddMinutes(5)
        Assert-True 'uyaridan kritige geciste aninda bildirim' ($observed.Toasts -eq 2)
        $disk.Seviye = 'ok'
        Update-DiskNotifications -State $state -DiskHealth $health -Now $now.AddMinutes(10)
        $disk.Seviye = 'kritik'
        Update-DiskNotifications -State $state -DiskHealth $health -Now $now.AddMinutes(34)
        Assert-True 'ok-kritik dalgalanmasi kisma suresini sifirlamaz' ($observed.Toasts -eq 2)
        Update-DiskNotifications -State $state -DiskHealth $health -Now $now.AddMinutes(35)
        Assert-True 'kritik 30 dakika sonra tekrar' ($observed.Toasts -eq 3)
        $disk.Seviye = 'uyari'
        Update-DiskNotifications -State $state -DiskHealth $health -Now $now.AddHours(6)
        Assert-True 'uyari kendi 6 saat penceresinde tekrar' ($observed.Toasts -eq 4)
        $disk.Drive = 'D:'
        Update-DiskNotifications -State $state -DiskHealth $health -Now $now.AddHours(6)
        Assert-True 'ikinci surucu bagimsiz bildirilir' ($observed.Toasts -eq 5)
    }

    Invoke-Case 'Disk: health ve Status cikis sozlesmesi' {
        $tokens = $null
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'smith-up.ps1'), [ref]$tokens, [ref]$errors)
        foreach ($name in @('Get-PreviousFailures', 'Save-Health', 'Get-HardDown')) {
            $fn = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
            . ([scriptblock]::Create($fn.Extent.Text))
        }
        $null = Use-TempDataDir 'disk-health'
        $HealthPath = Join-Path (Get-SmithDataDir) 'health.json'
        $AllComponents = @('gateway')
        $Required = @('gateway')
        foreach ($level in @('ok', 'uyari', 'kritik')) {
            $states = @{ gateway = [pscustomobject]@{ Up = $true; State = 'up'; Detail = 'test' }; disk = (Get-SmithDiskHealth -Disks @([pscustomobject]@{ Drive = 'C:'; FreeGB = [double]4; TotalGB = [double]100; Seviye = $level })) }
            $doc = Save-Health -States $states -Mode 'status' -CountFailures $false
            $saved = Read-SmithJson $HealthPath
            Assert-True "health disk ${level}: up ve tumAyakta korunur" ($saved.bilesenler.disk.up -and $saved.bilesenler.disk.seviye -eq $level -and $doc.tumAyakta)
            Assert-True "disk $level cikisi bozmaz" (@(Get-HardDown $states).Count -eq 0)
            $states.gateway.Up = $false
            $states.gateway.State = 'down'
            Assert-SetEqual "disk $level hizmet arizasini gizlemez" @(Get-HardDown $states) @('gateway')
        }
    }

    # === 1) Log temizligi =========================================================

    Invoke-Case 'Remove-OldSmithLogs: joker aday listesi, yalniz smith-up adli tarihli loglar silinir' {
        $logs = Use-TempDataDir 'log-senaryo-1'
        $files = @(
            'desktop-cargo.log', 'gateway-20260901.log', 'smith-up-20260901.log',
            'smith-restart.err.log', 'desktop.err.log', 'iddia-log.jsonl',
            'worker-2026090.log', 'x-202609011.log'
        )
        foreach ($f in $files) { New-AgedFile -Dir $logs -Name $f -AgeDays 10 }
        $res = Remove-OldSmithLogs -Days 7
        $left = @(Get-ChildItem -LiteralPath $logs -File | ForEach-Object { $_.Name })
        Assert-SetEqual 'silinenler (yalniz gateway + smith-up)' $res.Removed @('gateway-20260901.log', 'smith-up-20260901.log')
        Assert-SetEqual 'kalanlar (tani/tarihsiz/bozuk adli 6 dosya)' $left @(
            'desktop-cargo.log', 'smith-restart.err.log', 'desktop.err.log',
            'iddia-log.jsonl', 'worker-2026090.log', 'x-202609011.log'
        )
    }

    Invoke-Case 'Remove-OldSmithLogs: smith-up/watchdog/pg-backup/desktop gercek ad desenleri' {
        $logs = Use-TempDataDir 'log-senaryo-2'
        $deleted = @(
            'gateway-20260901.log', 'worker-20260901.log', 'speaker-20260901.log', 'stt-20261003.log',
            'desktop-20260901.log', 'desktop-20260901-stderr.log',
            'smith-up-20260901.log', 'watchdog-20260901.log', 'pg-backup-20260901.log'
        )
        $kept = @(
            'gateway-20261399.log',        # takvimde olmayan tarih
            'gateway-20260231.log', 'gateway-20260229.log', 'gateway-00000901.log',
            'incident-20260901.log', 'smith-watchdog-20260901.log',
            'gateway-20260901-stderr.log', # stderr yalniz desktop tarafindan uretilir
            'gateway-20260901.log.1',      # farkli uzanti
            'gateway-20260901.logx',       # 8.3 kisa ad tuzagi: *.log kisa adla eslesebilir
            'speaker.log',                 # smith-servers.ps1 tarihsiz logu
            'kullanici-notu-20260901.txt'
        )
        foreach ($f in ($deleted + $kept)) { New-AgedFile -Dir $logs -Name $f -AgeDays 10 }
        New-AgedFile -Dir $logs -Name 'gateway-20261001.log' -AgeDays 1   # yeni: yasi gecmedi
        $res = Remove-OldSmithLogs -Days 7
        $left = @(Get-ChildItem -LiteralPath $logs -File | ForEach-Object { $_.Name })
        Assert-SetEqual 'silinenler' $res.Removed $deleted
        Assert-SetEqual 'kalanlar (genc + desen disi)' $left ($kept + @('gateway-20261001.log'))
    }

    Invoke-Case 'Test-SmithLogName: artik yil ve tr-TR altinda izin listesi' {
        $thread = [System.Threading.Thread]::CurrentThread
        $previous = $thread.CurrentCulture
        try {
            $thread.CurrentCulture = [System.Globalization.CultureInfo]::GetCultureInfo('tr-TR')
            Assert-True 'artik yil 29 Subat kabul edilir' (Test-SmithLogName 'gateway-20240229.log')
            Assert-True '31 Subat reddedilir' (-not (Test-SmithLogName 'gateway-20260231.log'))
            Assert-True 'yabanci uretici reddedilir' (-not (Test-SmithLogName 'incident-20260901.log'))
            Assert-True 'buyuk harfli yabanci uretici reddedilir' (-not (Test-SmithLogName 'INCIDENT-20260901.log'))
        } finally { $thread.CurrentCulture = $previous }
    }

    # === 2) Masaustu durumu (sahte surec tablosu) ===================================

    $now = Get-Date
    function New-Row([int]$ProcId, [string]$Name, [string]$Cmd, [int]$AgeSec) {
        return [pscustomobject]@{ ProcessId = $ProcId; Name = $Name; CommandLine = $Cmd; CreationDate = $now.AddSeconds(-$AgeSec) }
    }
    $pnpmCmd = '"C:\node\node.exe" C:\node/node_modules/corepack/dist/pnpm.js --filter @smith/desktop tauri dev'
    $tauriCmd = 'node   "C:\r\smith-monorepo\apps\desktop\node_modules\.bin\\..\@tauri-apps\cli\tauri.js" "dev"'
    $devBody = "Set-Location 'C:\r'; . 'C:\r\scripts\dev-win.ps1'; pnpm --filter '@smith/desktop' tauri dev 2>&1"
    $encCmd = 'pwsh.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' +
        [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($devBody))
    $cap = 900

    Invoke-Case 'cargo: smith-desktop build/run starting, alakasiz crate down' {
        foreach ($cmd in @(
            'cargo.exe run --manifest-path C:\repo\apps\desktop\src-tauri\Cargo.toml',
            'cargo.exe build -p smith-desktop',
            'CARGO.EXE BUILD --package SMITH-DESKTOP',
            'cargo.exe +stable run --manifest-path "C:\repo with spaces\src-tauri\Cargo.toml"'
        )) {
            $s = Get-SmithDesktopState -Snap @((New-Row 301 'cargo.exe' $cmd 60)) -ProcessName 'smith-desktop' -Now $now
            Assert-True "cargo starting: $cmd" ($s.State -eq 'starting') "durum: $($s.State)"
        }
        foreach ($cmd in @(
            'cargo.exe build -p other-crate',
            'cargo.exe run --manifest-path C:\other\Cargo.toml',
            'cargo.exe build -p smith-desktop-tools',
            'cargo.exe build --manifest-path C:\other\src-tauri-other\Cargo.toml',
            'cargo.exe test -p smith-desktop'
        )) {
            $s = Get-SmithDesktopState -Snap @((New-Row 302 'cargo.exe' $cmd 60)) -ProcessName 'smith-desktop' -Now $now
            Assert-True "alakasiz cargo down: $cmd" ($s.State -eq 'down') "durum: $($s.State)"
        }
    }

    Invoke-Case 'Start-DesktopComponent: baslatmadan hemen once yeni surec tablosunu kullanir' {
        # Yalniz fonksiyonu AST'den yukle; smith-up giris noktasi ASLA calistirilmaz.
        $tokens = $null
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'smith-up.ps1'), [ref]$tokens, [ref]$errors)
        $fn = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-DesktopComponent' }, $true)
        . ([scriptblock]::Create($fn.Extent.Text))
        $null = Use-TempDataDir 'desktop-recheck'
        $DesktopStuckSec = 900
        $observed = @{ Snap = @(); Reads = 0; Starts = 0 }
        function Get-ProcessSnapshot { $observed.Reads++; return $observed.Snap }
        function Get-ComponentState($Name, $Snap, $Desktop) {
            $running = @($Snap | Where-Object { $_.Name -eq ($Desktop.ProcessName + '.exe') } | ForEach-Object { [pscustomobject]@{ Id = $_.ProcessId } })
            Get-SmithDesktopState -Snap $Snap -ProcessName $Desktop.ProcessName -Running $running
        }
        function Write-SmithLog { param($Message, $Level) }
        function Start-Process { $observed.Starts++ }
        function Start-HiddenShell { $observed.Starts++ }
        $desktopFixture = [pscustomobject]@{ ProcessName = 'smith-desktop'; Exe = 'C:\fake\smith-desktop.exe' }
        foreach ($row in @(
            (New-Row 401 'smith-desktop.exe' 'smith-desktop.exe' 1),
            (New-Row 402 'node.exe' $pnpmCmd 1),
            (New-Row 403 'cargo.exe' 'cargo.exe build -p smith-desktop' 901)
        )) {
            $observed.Snap = @($row)
            $result = Start-DesktopComponent $desktopFixture
            Assert-True "yeni surec goruldu, baslatma yok: $($row.Name)" ($observed.Starts -eq 0 -and $result -eq $false)
        }
        Assert-True 'her baslatma girisinde tablo yeniden alindi' ($observed.Reads -eq 3)
        $observed.Snap = @()
        $result = Start-DesktopComponent $desktopFixture
        Assert-True 'bos yeni tablo ile tek baslatma' ($observed.Starts -eq 1 -and $result -eq $true -and $observed.Reads -eq 4)
    }

    Invoke-Case 'Get-SmithDesktopState: derleme suruyorken starting (eski davranis: 30 sn sonra down)' {
        $snap = @((New-Row 101 'node.exe' $pnpmCmd 45))
        $s = Get-SmithDesktopState -Snap $snap -ProcessName 'smith-desktop' -Running @() -StuckAfterSec $cap -Now $now
        Assert-True 'durum starting' ($s.State -eq 'starting') "durum: $($s.State), detay: $($s.Detail)"
        Assert-True 'Up degil' (-not $s.Up)
        Assert-True 'launcher pid raporlanir' ($s.ProcId -eq 101) "ProcId: $($s.ProcId)"
    }

    Invoke-Case 'Get-SmithDesktopState: -EncodedCommand kabugu ve tauri-cli node sureci de launcher sayilir' {
        $s1 = Get-SmithDesktopState -Snap @((New-Row 102 'pwsh.exe' $encCmd 5)) -ProcessName 'smith-desktop' -Running @() -StuckAfterSec $cap -Now $now
        Assert-True 'encoded kabuk -> starting' ($s1.State -eq 'starting') "durum: $($s1.State)"
        $s2 = Get-SmithDesktopState -Snap @((New-Row 103 'node.exe' $tauriCmd 60)) -ProcessName 'smith-desktop' -Running @() -StuckAfterSec $cap -Now $now
        Assert-True 'tauri.js "dev" -> starting' ($s2.State -eq 'starting') "durum: $($s2.State)"
    }

    Invoke-Case 'ConvertFrom-SmithEncodedCommand: tr-TR kulturunde de govdenin TAMAMI cozulur (Turkce I tuzagi)' {
        # Satir ici (?i) 5.1'de tr-TR kulturunde [A-Za-z] sinifinda buyuk 'I'yi kacirir ve
        # base64'u ilk 'I'da keser. Makinenin kulturunden bagimsiz kanitlamak icin kulturu zorla.
        $thread = [System.Threading.Thread]::CurrentThread
        $prevCulture = $thread.CurrentCulture
        try {
            $thread.CurrentCulture = [System.Globalization.CultureInfo]::GetCultureInfo('tr-TR')
            $body = ConvertFrom-SmithEncodedCommand $encCmd
            Assert-True 'govde bastan sona cozuldu' ($body -ceq $devBody) "cozulen: [$body]"
            $s = Get-SmithDesktopState -Snap @((New-Row 150 'powershell.exe' $encCmd 5)) -ProcessName 'smith-desktop' -Running @() -StuckAfterSec $cap -Now $now
            Assert-True 'tr-TR altinda encoded kabuk -> starting' ($s.State -eq 'starting') "durum: $($s.State)"
            Assert-True "tr-TR altinda log adi dogrulamasi ('i' iceren adlar)" ((Test-SmithLogName 'smith-up-20260901.log') -and (Test-SmithLogName 'pg-backup-20260901.log') -and (Test-SmithLogName 'desktop-20260901-stderr.log'))
            Assert-True 'tr-TR altinda desen disi ad reddedilir' (-not (Test-SmithLogName 'desktop-cargo.log'))
        } finally {
            $thread.CurrentCulture = $prevCulture
        }
    }

    Invoke-Case 'Get-SmithDesktopState: tavan (900 sn) ustunde stuck, altinda starting' {
        $under = Get-SmithDesktopState -Snap @((New-Row 104 'node.exe' $pnpmCmd 899)) -ProcessName 'smith-desktop' -Running @() -StuckAfterSec $cap -Now $now
        Assert-True '899 sn -> starting' ($under.State -eq 'starting') "durum: $($under.State)"
        $over = Get-SmithDesktopState -Snap @((New-Row 105 'node.exe' $pnpmCmd 901)) -ProcessName 'smith-desktop' -Running @() -StuckAfterSec $cap -Now $now
        Assert-True '901 sn -> stuck' ($over.State -eq 'stuck') "durum: $($over.State)"
        Assert-True 'stuck de Up degil' (-not $over.Up)
    }

    Invoke-Case 'Get-SmithDesktopState: surec kalkinca up, launcher yoksa down' {
        $running = @([pscustomobject]@{ Id = 4242 })
        $up = Get-SmithDesktopState -Snap @((New-Row 106 'node.exe' $pnpmCmd 300)) -ProcessName 'smith-desktop' -Running $running -StuckAfterSec $cap -Now $now
        Assert-True 'surec varsa up (launcher calissa da)' ($up.Up -and $up.State -eq 'up') "durum: $($up.State)"
        $down = Get-SmithDesktopState -Snap @() -ProcessName 'smith-desktop' -Running @() -StuckAfterSec $cap -Now $now
        Assert-True 'ne surec ne launcher -> down' ((-not $down.Up) -and $down.State -eq 'down') "durum: $($down.State)"
    }

    Invoke-Case 'Get-SmithDesktopState: alakasiz surecler launcher sayilmaz (yanlis pozitif yok)' {
        $other = @(
            (New-Row 201 'node.exe' '"node.exe" pnpm.js --filter @smith/worker start' 500),
            (New-Row 202 'node.exe' '"node.exe" pnpm.js --filter @smith/gateway start' 500),
            (New-Row 203 'pwsh.exe' 'pwsh.exe -NoProfile -File C:\r\scripts\smith-up.ps1 -Ensure' 500),
            (New-Row 204 'pwsh.exe' "pwsh.exe -Command ""pnpm --filter '@smith/desktop' tauri dev""" 500),
            (New-Row 205 'notepad.exe' 'notepad.exe @smith/desktop tauri dev' 500),
            (New-Row 206 'pwsh.exe' ('pwsh.exe -EncodedCommand ' + [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes('Get-Date # baska is'))) 500),
            (New-Row 207 'node.exe' 'node.exe C:\baska\proje\node_modules\@tauri-apps\cli\tauri.js dev' 500)
        )
        $s = Get-SmithDesktopState -Snap $other -ProcessName 'smith-desktop' -Running @() -StuckAfterSec $cap -Now $now
        Assert-True '7 alakasiz surec -> down' ($s.State -eq 'down') "durum: $($s.State), detay: $($s.Detail)"
    }

    Invoke-Case 'Get-SmithDesktopDevLaunchers: GERCEK sahte surec (uyuyan -EncodedCommand kabugu) tespit edilir' {
        $fake = Start-FakeDesktopLauncher
        $found = @(Get-SmithDesktopDevLaunchers (Get-ProcessSnapshotForTest))
        Assert-True 'sahte launcher listede' (@($found | Where-Object { $_.ProcessId -eq $fake.Id }).Count -eq 1) ("bulunanlar: " + (($found | ForEach-Object { $_.ProcessId }) -join ', '))
        # Durum karari yalniz SAHTE surecin canli CIM satirindan verilir: bu makinede gercek bir
        # masaustu dev launcher'i (daha eski) calisiyor olabilir ve sonucu bulandirmasin.
        $onlyFake = @(Get-ProcessSnapshotForTest | Where-Object { $_.ProcessId -eq $fake.Id })
        $s = Get-SmithDesktopState -Snap $onlyFake -ProcessName ('smith-desktop-yok-' + $PID) -Running @() -StuckAfterSec $cap
        Assert-True 'canli CIM satirindan starting' ($s.State -eq 'starting' -and $s.ProcId -eq $fake.Id) "durum: $($s.State), pid: $($s.ProcId)"
        Stop-Process -Id $fake.Id -Force
        $null = $fake.WaitForExit(10000)
        $after = @(Get-SmithDesktopDevLaunchers (Get-ProcessSnapshotForTest))
        Assert-True 'surec olunce listeden duser' (@($after | Where-Object { $_.ProcessId -eq $fake.Id }).Count -eq 0)
    }

    # === 3) smith-up.ps1 -Status/-DryRun (hicbir sey baslatmaz) =======================

    if ($SkipE2E) {
        Write-Host '== smith-up -Status/-DryRun sinamalari atlandi (-SkipE2E)'
    } else {
        $upPath = Join-Path $PSScriptRoot 'smith-up.ps1'
        $shellExe = (Get-Process -Id $PID).Path
        $fakeName = 'smith-desktop-sahte-{0}' -f $PID

        Invoke-Case 'smith-up -Status: disk satiri ve health kaydi (izole veri dizini)' {
            $null = Use-TempDataDir 'e2e-status'
            $r = Invoke-SmithNative -FilePath $shellExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $upPath, '-Status') -TimeoutSec 240
            $out = $r.Output + $r.Error
            $diskLines = @($out -split "`r?`n" | Where-Object { $_ -cmatch '^disk\s+(OK|UYARI|KRITIK)\s+-\s+C: .* GB bos' })
            Assert-True 'Status tablosunda disk satiri' ($diskLines.Count -eq 1) $out
            foreach ($line in $diskLines) { Write-Host "  Status: $line" }
            $saved = Read-SmithJson (Join-Path (Get-SmithDataDir) 'health.json')
            Assert-True 'Status disk health up=true, seviye ayri' ($saved.bilesenler.disk.up -and $saved.bilesenler.disk.seviye -in @('ok', 'uyari', 'kritik'))
            $hardDown = @($saved.bilesenler.PSObject.Properties | Where-Object {
                $_.Name -ne 'disk' -and -not $_.Value.up -and -not ($_.Name -eq 'desktop' -and $_.Value.durum -eq 'starting')
            })
            $expectedExit = 0
            if ($hardDown.Count -gt 0) { $expectedExit = 1 }
            Assert-True 'Status cikisi yalniz hizmet durumunu izler' ($r.ExitCode -eq $expectedExit -and -not $r.TimedOut) "exit $($r.ExitCode), beklenen $expectedExit"
            Write-Host "  Status exit: $($r.ExitCode)"
        }

        Invoke-Case 'smith-up -DryRun: starting masaustu icin ikinci masaustu planlanmaz' {
            $null = Use-TempDataDir 'e2e-1'
            $env:SMITH_DESKTOP_PROCESS_NAME = $fakeName
            $fake = Start-FakeDesktopLauncher
            $r = Invoke-SmithNative -FilePath $shellExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $upPath, '-DryRun') -TimeoutSec 240
            $out = $r.Output + $r.Error
            Assert-True 'DryRun cikis 0' ($r.ExitCode -eq 0) "exit $($r.ExitCode): $out"
            # Sahte launcher STARTING verir. Bu makinede gercek (eski) bir dev launcher'i da
            # calisiyorsa en eskisi esas alinir ve tavan asilmissa STUCK gorunur; guvence ikisinde
            # de aynidir: ikinci masaustu planlanmaz.
            Assert-True 'tabloda desktop STARTING ya da STUCK' ($out -match '(?m)^desktop\s+(STARTING|STUCK)') $out
            Assert-True "masaustu baslatma plani YOK" ($out -notmatch '\[plan\] desktop: masaustu baslatilir') $out
            Assert-True "'zaten baslatiliyor' kaydi var" ($out -match 'desktop zaten baslatiliyor') $out
            Stop-Process -Id $fake.Id -Force
            $null = $fake.WaitForExit(10000)
        }

        Invoke-Case 'smith-up -Ensure -DryRun: bekci kipi masaustunu hic planlamaz' {
            $null = Use-TempDataDir 'e2e-2'
            $env:SMITH_DESKTOP_PROCESS_NAME = $fakeName
            $r = Invoke-SmithNative -FilePath $shellExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $upPath, '-Ensure', '-DryRun') -TimeoutSec 240
            $out = $r.Output + $r.Error
            Assert-True 'Ensure DryRun cikis 0' ($r.ExitCode -eq 0) "exit $($r.ExitCode): $out"
            Assert-True 'masaustu baslatma plani YOK' ($out -notmatch '\[plan\] desktop: masaustu baslatilir') $out
        }
    }

} finally {
    Stop-FakeProcesses
    $env:SMITH_DATA_DIR = $prevDataDir
    if ($null -eq $prevDataDir) { Remove-Item Env:\SMITH_DATA_DIR -ErrorAction SilentlyContinue }
    $env:SMITH_DESKTOP_PROCESS_NAME = $prevDesktopProc
    if ($null -eq $prevDesktopProc) { Remove-Item Env:\SMITH_DESKTOP_PROCESS_NAME -ErrorAction SilentlyContinue }
    # Yalniz kendi olusturdugumuz gecici klasoru sil: ad deseni + TEMP altinda olma kontrolu.
    $leaf = Split-Path -Leaf $work
    if ($leaf -like 'smith-common-test-*' -and (Split-Path -Parent $work).TrimEnd('\') -eq $tempRoot.TrimEnd('\') -and (Test-Path -LiteralPath $work)) {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Complete-SmithTestRun
