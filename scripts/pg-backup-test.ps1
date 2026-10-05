# pg-backup yardimci testleri. Ag ve docker cagirmaz; dosya sistemi testleri
# yalniz bu kosunun %TEMP% altindaki tekil klasorunde calisir.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'pg-backup-functions.ps1')
. (Join-Path $PSScriptRoot 'powershell-test-helpers.ps1')

Initialize-SmithTestRun

function New-AgedBackupTestFile {
    param([string]$Dir, [string]$Name, [int]$AgeDays, [string]$Content = 'x')
    $path = Join-Path $Dir $Name
    [System.IO.File]::WriteAllText($path, $Content)
    (Get-Item -LiteralPath $path).LastWriteTime = (Get-Date).AddDays(-$AgeDays)
}

$tempRoot = [System.IO.Path]::GetTempPath()
$work = Join-Path $tempRoot ('pg-backup-test-{0}-{1}' -f
    $PID, [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null

try {
    Invoke-Case 'tek yedek adi ayristiricisi' {
        $valid = Get-SmithBackupFileInfo -Name 'smith-smith-20280229-030405-2.dump' -Database 'smith'
        Assert-True 'artik yil, saat ve suffix ayrisir' ($null -ne $valid -and
            $valid.Timestamp.ToString('yyyyMMdd-HHmmss') -eq '20280229-030405' -and
            $valid.Suffix -eq 2 -and -not $valid.IsPart)

        $part = Get-SmithBackupFileInfo -Name 'smith-smith-20260901-030000.dump.part' -Database 'smith'
        Assert-True 'part ayni ayristiricida taninir' ($null -ne $part -and $part.IsPart)
        Assert-True 'gecersiz takvim reddedilir' ($null -eq
            (Get-SmithBackupFileInfo -Name 'smith-smith-20261399-030000.dump' -Database 'smith'))
        Assert-True 'gecersiz saat reddedilir' ($null -eq
            (Get-SmithBackupFileInfo -Name 'smith-smith-20261003-256199.dump' -Database 'smith'))
        Assert-True 'Int32 disi suffix reddedilir' ($null -eq
            (Get-SmithBackupFileInfo -Name 'smith-smith-20261003-030000-99999999999.dump' -Database 'smith'))
    }

    Invoke-Case 'SSH kopya kapisi ortak ayristiriciyi kullanir' {
        # Yalniz fonksiyonu AST'den yukle; pg-backup giris noktasi ASLA calistirilmaz.
        $tokens = $null
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile(
            (Join-Path $PSScriptRoot 'pg-backup.ps1'), [ref]$tokens, [ref]$errors)
        $function = $ast.Find({
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                    $node.Name -eq 'Invoke-SmithBackupSshMirror'
            }, $true)
        Assert-True 'SSH kopya fonksiyonu ayristirilir' ($errors.Count -eq 0 -and $null -ne $function)
        . ([scriptblock]::Create($function.Extent.Text))

        $rejected = $false
        try {
            $null = Invoke-SmithBackupSshMirror -Config ([pscustomobject]@{
                    SshTarget = 'sahte'; RemoteDir = 'smith-backups'; Keep = 2
                }) -LocalPath 'sahte.dump' -FileName 'smith-smith-20261399-030000.dump' `
                -LocalSize 1 -Database 'smith'
        } catch {
            $rejected = $_.Exception.Message -like '*dosya adi*'
        }
        Assert-True 'gecersiz takvim SSH veya SCP aranmadan reddedilir' $rejected
    }

    Invoke-Case 'uzak budama secimi' {
        $names = @(
            'smith-smith-20261003-030000.dump',
            'smith-smith-20261002-030000.dump',
            'smith-smith-20261002-030000-2.dump',
            'smith-smith-20261001-030000.dump',
            'smith-smith-elle.dump',
            'notes.txt',
            'smith-other-20260930-030000.dump',
            'smith-smith-20261399-030000.dump',
            'smith-smith-20261003-031500.dump.part'
        )
        $plan = Get-SmithRemoteBackupPrunePlan -Names $names -Database 'smith' -Keep 2
        Assert-True 'en yeni iki dump korunur' (($plan.KeepNames -join ',') -eq
            'smith-smith-20261003-030000.dump,smith-smith-20261002-030000-2.dump') `
            ($plan.KeepNames -join ',')
        Assert-True 'kalan gecerli dump dosyalari budanir' (($plan.DeleteNames -join ',') -eq
            'smith-smith-20261002-030000.dump,smith-smith-20261001-030000.dump') `
            ($plan.DeleteNames -join ',')
        Assert-True 'desen disi, part ve baska DB dosyalari korunur' `
            ($plan.IgnoredNames.Count -eq 5) ($plan.IgnoredNames -join ',')
        Assert-True 'desen disi dosya silme listesine girmez' `
            (@($plan.DeleteNames | Where-Object { $_ -in $plan.IgnoredNames }).Count -eq 0)
    }

    Invoke-Case 'ayar cozumu' {
        $fileConfig = [pscustomobject]@{
            ssh_hedef = 'dosya-hedef'; uzak_dizin = 'dosya-yolu'; sakla = 22
        }
        $fromEnv = Resolve-SmithBackupSshConfig -EnvValue 'env-hedef:env-yolu' -FileConfig $fileConfig
        Assert-True 'env dosyayi ezer' ($fromEnv.SshTarget -eq 'env-hedef' -and
            $fromEnv.RemoteDir -eq 'env-yolu' -and $fromEnv.Keep -eq 14 -and $fromEnv.Source -eq 'env')
        $fromFile = Resolve-SmithBackupSshConfig -EnvValue '' -FileConfig $fileConfig
        Assert-True 'env yoksa dosya kullanilir' ($fromFile.SshTarget -eq 'dosya-hedef' -and
            $fromFile.RemoteDir -eq 'dosya-yolu' -and $fromFile.Keep -eq 22 -and
            $fromFile.Source -eq 'file')
        $missing = Resolve-SmithBackupSshConfig -EnvValue '' -FileConfig $null
        Assert-True 'env ve dosya yoksa ayar yoktur' ($null -eq $missing)

        $unsafeDirsRejected = 0
        foreach ($unsafeDir in @('/tmp/smith-backups', '.ssh')) {
            try {
                $null = Resolve-SmithBackupSshConfig -EnvValue "hedef:$unsafeDir" -FileConfig $fileConfig
            } catch {
                $unsafeDirsRejected++
            }
        }
        Assert-True 'mutlak ve gizli uzak dizinler reddedilir' ($unsafeDirsRejected -eq 2)
        $shellConfigRejected = $false
        try {
            $null = Resolve-SmithBackupSshConfig `
                -EnvValue 'hedef;komut:smith-backups' -FileConfig $fileConfig
        } catch {
            $shellConfigRejected = $true
        }
        Assert-True 'SSH hedefindeki kabuk karakteri reddedilir' $shellConfigRejected
    }

    Invoke-Case '72 saat uyari karari' {
        $now = [datetimeoffset]'2026-10-03T12:00:00+03:00'
        Assert-True '71 saat eski basari uyari vermez' `
            (-not (Test-SmithBackupSshAlertDue -LastSuccessTime $now.AddHours(-71).ToString('o') -Now $now))
        Assert-True 'tam 72 saat uyari vermez' `
            (-not (Test-SmithBackupSshAlertDue -LastSuccessTime $now.AddHours(-72).ToString('o') -Now $now))
        Assert-True '72 saatten eski basari uyari verir' `
            (Test-SmithBackupSshAlertDue -LastSuccessTime $now.AddHours(-73).ToString('o') -Now $now)
        Assert-True 'onceki basari yoksa uyari vermez' `
            (-not (Test-SmithBackupSshAlertDue -LastSuccessTime $null -Now $now))
    }

    Invoke-Case 'last-backup alan tasimasi' {
        $now = [datetimeoffset]'2026-10-03T12:00:00+03:00'
        $previous = [pscustomobject]@{
            zaman = '2026-10-03T01:00:00+03:00'; yansi_ssh = 'onceki'
            yansi_ssh_hata = 'onceki hata'; yansi_ssh_zaman = '2026-10-01T03:00:00+03:00'
        }
        $state = New-SmithBackupState -PreviousState $previous -Now $now
        Assert-True 'son basarili SSH zamani korunur' `
            ($state.yansi_ssh_zaman -eq $previous.yansi_ssh_zaman)
        Assert-True 'yeni kosuda SSH sonuc ve hata alanlari sifirlanir' `
            ($null -eq $state.yansi_ssh -and $null -eq $state.yansi_ssh_hata)
        Assert-True 'yeni kosu ana sonucu basarisiz baslatir' `
            (-not $state.ok -and $state.boyut -eq 0)
        $fresh = New-SmithBackupState -PreviousState $null -Now $now
        Assert-True 'onceki durum yoksa SSH zamani bostur' ($null -eq $fresh.yansi_ssh_zaman)
        Assert-True 'yeni kosuda budama hata alani da sifirlanir' ($null -eq $state.yansi_ssh_budama_hata)
    }

    Invoke-Case 'ayna durumu: basari (budama uyarisiyla bile) ve basarisizlik yazimi' {
        $now = [datetimeoffset]'2026-10-03T12:00:00+03:00'
        $previous = [pscustomobject]@{ yansi_ssh_zaman = '2026-10-01T03:00:00+03:00' }

        $ok = New-SmithBackupState -PreviousState $previous -Now $now
        Set-SmithBackupSshMirrorSuccess -State $ok -Now $now -Result ([pscustomobject]@{
                Reference = 'mac:smith-backups/smith-smith-20261003-030000.dump'; PruneError = $null })
        Assert-True 'basari: ayna yolu, hata bos, zaman yeni' ($ok.yansi_ssh -like 'mac:*' -and
            $null -eq $ok.yansi_ssh_hata -and $null -eq $ok.yansi_ssh_budama_hata -and
            $ok.yansi_ssh_zaman -eq $now.ToString('o'))

        $warn = New-SmithBackupState -PreviousState $previous -Now $now
        Set-SmithBackupSshMirrorSuccess -State $warn -Now $now -Result ([pscustomobject]@{
                Reference = 'mac:smith-backups/x.dump'; PruneError = 'uzak dosya listesi basarisiz' })
        Assert-True 'budama uyarisi ayna basarisini bozmaz: ayna dolu, hata bos, uyari ayri alanda, zaman yeni' (
            $warn.yansi_ssh -eq 'mac:smith-backups/x.dump' -and $null -eq $warn.yansi_ssh_hata -and
            $warn.yansi_ssh_budama_hata -eq 'uzak dosya listesi basarisiz' -and
            $warn.yansi_ssh_zaman -eq $now.ToString('o'))

        $bad = New-SmithBackupState -PreviousState $previous -Now $now
        Set-SmithBackupSshMirrorFailure -State $bad -Message "scp   asili`nkaldi"
        Assert-True 'basarisizlik: ayna bos, hata kisa/tek satir, son basari zamani korunur' (
            $null -eq $bad.yansi_ssh -and $bad.yansi_ssh_hata -eq 'scp asili kaldi' -and
            $null -eq $bad.yansi_ssh_budama_hata -and $bad.yansi_ssh_zaman -eq $previous.yansi_ssh_zaman)
    }

    Invoke-Case 'kilit cakismasinda temizlik yok; kilit birakilinca yeniden alinabilir' {
        $dir = Join-Path $work 'backup-lock'
        New-Item -ItemType Directory -Path $dir | Out-Null
        $name = 'smith-smith-20260901-030000.dump.part'
        New-AgedBackupTestFile -Dir $dir -Name $name -AgeDays 3
        $first = $null
        $second = $null
        try {
            $first = Enter-SmithBackupLock -Dir $dir
            Assert-True 'ilk kilit alindi' ($null -ne $first)
            [GC]::Collect()
            [GC]::WaitForPendingFinalizers()
            $second = Enter-SmithBackupLock -Dir $dir
            Assert-True 'ikinci kilit reddedildi (GC sonrasi da)' ($null -eq $second)
            if ($second) {
                Remove-StaleSmithDumpParts -Dir $dir -Database 'smith' -LockStream $second
            }
            Assert-True 'kilit cakismasinda eski part bile korunur' `
                (Test-Path -LiteralPath (Join-Path $dir $name))
            $rejected = $false
            try {
                Remove-StaleSmithDumpParts -Dir $dir -Database 'smith' -LockStream $null
            } catch {
                $rejected = $true
            }
            Assert-True 'kilitsiz temizlik reddedilir' $rejected
            Assert-True 'kilitsiz denemede dosya korunur' `
                (Test-Path -LiteralPath (Join-Path $dir $name))
        } finally {
            if ($second) { $second.Dispose() }
            if ($first) { $first.Dispose() }
        }
        $again = Enter-SmithBackupLock -Dir $dir
        try {
            Assert-True 'Dispose sonrasi kilit alinabilir' ($null -ne $again)
        } finally {
            if ($again) { $again.Dispose() }
        }
    }

    Invoke-Case 'yalniz iki saatten eski gecerli part temizlenir' {
        $dir = Join-Path $work 'backup-stale'
        New-Item -ItemType Directory -Path $dir | Out-Null
        $old = 'smith-smith-20260901-030000.dump.part'
        $fresh = 'smith-smith-20260902-030000.dump.part'
        $manual = 'smith-smith-elle.dump.part'
        New-AgedBackupTestFile -Dir $dir -Name $old -AgeDays 3
        New-AgedBackupTestFile -Dir $dir -Name $fresh -AgeDays 0
        New-AgedBackupTestFile -Dir $dir -Name $manual -AgeDays 3
        Assert-SetEqual 'taze part stale aday listesinde yok' `
            @(Get-SmithDumpFiles -Dir $dir -Database 'smith' -Part | ForEach-Object { $_.Name }) @($old)
        $held = Enter-SmithBackupLock -Dir $dir
        try {
            Remove-StaleSmithDumpParts -Dir $dir -Database 'smith' -LockStream $held
            Assert-True 'eski part silindi' (-not (Test-Path -LiteralPath (Join-Path $dir $old)))
            Assert-True 'taze part silinmedi' (Test-Path -LiteralPath (Join-Path $dir $fresh))
            Assert-True 'elle adlandirilan part silinmedi' `
                (Test-Path -LiteralPath (Join-Path $dir $manual))
        } finally {
            if ($held) { $held.Dispose() }
        }
    }

    Invoke-Case 'yerel budama yalniz pg-backup adli dump dosyalarini secer' {
        $dir = Join-Path $work 'dump-prune'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        for ($i = 1; $i -le 10; $i++) {
            New-AgedBackupTestFile -Dir $dir `
                -Name ('smith-smith-202609{0:00}-030000.dump' -f $i) -AgeDays (31 - $i)
        }
        foreach ($file in @(
                'smith-smith-oncesi-migrasyon.dump', 'smith-smith-notes.dump',
                'smith-smith-2026080-030000.dump', 'smith-other-20260801-030000.dump',
                'smith-smith-20260801-030000.dump.suspect',
                'smith-smith-20260801-030000.dump.part')) {
            New-AgedBackupTestFile -Dir $dir -Name $file -AgeDays 60
        }
        $prune = @(Get-PrunableDumps -Dir $dir -Database 'smith' `
                -RetentionDays 14 -MinKeep 7 | ForEach-Object { $_.Name })
        Assert-SetEqual 'budanabilir = en eski 3 gecerli dump' $prune @(
            'smith-smith-20260901-030000.dump',
            'smith-smith-20260902-030000.dump',
            'smith-smith-20260903-030000.dump'
        )
    }

    Invoke-Case 'yerel listeleme tek ayristiriciyi kullanir' {
        $dir = Join-Path $work 'dump-list'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        foreach ($file in @(
                'smith-smith-20260901-030000.dump.part',
                'smith-smith-20260901-030000-2.dump.part',
                'smith-smith-elle-tutulan.dump.part',
                'smith-smith-20261399-030000.dump',
                'smith-smith-20260901-030000.dump')) {
            New-AgedBackupTestFile -Dir $dir -Name $file -AgeDays 3
        }
        $parts = @(Get-SmithDumpFiles -Dir $dir -Database 'smith' -Part |
                ForEach-Object { $_.Name })
        Assert-SetEqual '.part adaylari' $parts @(
            'smith-smith-20260901-030000.dump.part',
            'smith-smith-20260901-030000-2.dump.part'
        )
        $dumps = @(Get-SmithDumpFiles -Dir $dir -Database 'smith' |
                ForEach-Object { $_.Name })
        Assert-SetEqual 'gecersiz takvim yerel aday degildir' $dumps `
            @('smith-smith-20260901-030000.dump')
        $wild = @(Get-SmithDumpFiles -Dir $dir -Database 'sm?th')
        Assert-True "veritabani adindaki '?' joker olarak calismaz" ($wild.Count -eq 0) `
            ("eslesen: " + (($wild | ForEach-Object { $_.Name }) -join ', '))
    }

    Invoke-Case 'SSH secenekleri ve adim tavanlari' {
        $options = (Get-SmithBackupSshOptions) -join ' '
        Assert-True 'BatchMode + ConnectTimeout korunur' ($options -match 'BatchMode=yes' -and $options -match 'ConnectTimeout=10')
        Assert-True 'ServerAliveInterval=5 ve ServerAliveCountMax=2 (asili el sikisma ~10 sn)' (
            $options -match 'ServerAliveInterval=5' -and $options -match 'ServerAliveCountMax=2')
        Assert-True 'scp adimi 120 sn' ((Get-SmithBackupStepTimeoutSec 'copy') -eq 120)
        Assert-True 'diger adimlar 30 sn' ((Get-SmithBackupStepTimeoutSec 'quick') -eq 30)
    }

    # pg-backup.ps1'in giris noktasi ASLA calistirilmaz: iki fonksiyon AST'den yuklenir, ssh/scp
    # SAHTE (Invoke-SmithNative ve Get-Command bu kapsamda golgelenir; ag/docker/surec yok).
    function Import-MirrorFunctions {
        $tokens = $null
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile(
            (Join-Path $PSScriptRoot 'pg-backup.ps1'), [ref]$tokens, [ref]$errors)
        $loaded = @()
        foreach ($name in @('Invoke-SmithBackupMirrorProcess', 'Invoke-SmithBackupSshMirror')) {
            $fn = $ast.Find({
                    param($node)
                    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                        $node.Name -eq $name
                }, $true)
            $loaded += $fn.Extent.Text
        }
        return $loaded
    }

    Invoke-Case 'SSH ayna: atomik ad degisimi tamam, listeleme asili kalirsa ayna BASARILI + uyari' {
        foreach ($text in (Import-MirrorFunctions)) { . ([scriptblock]::Create($text)) }
        $script:Calls = New-Object System.Collections.Generic.List[object]
        $script:Logs = New-Object System.Collections.Generic.List[string]
        function Get-Command { [CmdletBinding()] param([string]$Name, [string]$CommandType) return [pscustomobject]@{ Source = "C:\sahte\$Name" } }
        function Write-SmithLog { param($Message, $Level) $script:Logs.Add("[$Level] $Message") }
        function Invoke-SmithNative {
            param([string]$FilePath, [string[]]$ArgumentList, [int]$TimeoutSec)
            $joined = $ArgumentList -join ' '
            $script:Calls.Add([pscustomobject]@{ File = (Split-Path -Leaf $FilePath); Args = $joined; Timeout = $TimeoutSec })
            $result = [pscustomobject]@{ ExitCode = 0; TimedOut = $false; Output = ''; Error = '' }
            if ($joined -match 'wc -c') { $result.Output = "12345`n" }
            if ($joined -match 'sh -c') { $result = [pscustomobject]@{ ExitCode = -1; TimedOut = $true; Output = ''; Error = '' } }
            return $result
        }
        $config = [pscustomobject]@{ SshTarget = 'sahte'; RemoteDir = 'smith-backups'; Keep = 2 }
        $name = 'smith-smith-20261003-030000.dump'

        $result = Invoke-SmithBackupSshMirror -Config $config -LocalPath 'sahte.dump' -FileName $name -LocalSize 12345 -Database 'smith'
        Assert-True 'ayna yolu doner (basarili)' ($result.Reference -eq "sahte:smith-backups/$name") "$($result.Reference)"
        Assert-True 'budama hatasi sonuca islenir, istisna firlatilmaz' ($null -ne $result.PruneError -and $result.PruneError -match 'uzak dosya listesi')
        $warnLine = @($script:Logs | Where-Object { $_ -like '[[]WARN] *ayna tamam, budama atlandi:*' })
        Assert-True "WARN: 'ayna tamam, budama atlandi: <neden>'" ($warnLine.Count -eq 1) ($script:Logs -join ' | ')
        Assert-True 'atomik ad degisimi (mv -f) listelemeden ONCE yapildi' (
            (($script:Calls | ForEach-Object { $_.Args }) -join "`n") -match '(?s)mv -f.*sh -c')
        $scp = @($script:Calls | Where-Object { $_.File -eq 'scp.exe' })
        Assert-True 'scp adimi 120 sn tavanli' ($scp.Count -eq 1 -and $scp[0].Timeout -eq 120) "timeout: $($scp[0].Timeout)"
        $quick = @($script:Calls | Where-Object { $_.File -ne 'scp.exe' })
        Assert-True 'diger adimlar 30 sn tavanli' (@($quick | Where-Object { $_.Timeout -gt 30 }).Count -eq 0) (($quick | ForEach-Object { $_.Timeout }) -join ',')
        Assert-True 'tum cagrilar ServerAlive secenekleri tasir' (
            @($script:Calls | Where-Object { $_.Args -notmatch 'ServerAliveInterval=5 -o ServerAliveCountMax=2' }).Count -eq 0)
    }

    Invoke-Case 'SSH ayna: uzak budama (rm) hatasi da yalniz uyaridir' {
        foreach ($text in (Import-MirrorFunctions)) { . ([scriptblock]::Create($text)) }
        $script:Logs = New-Object System.Collections.Generic.List[string]
        function Get-Command { [CmdletBinding()] param([string]$Name, [string]$CommandType) return [pscustomobject]@{ Source = "C:\sahte\$Name" } }
        function Write-SmithLog { param($Message, $Level) $script:Logs.Add("[$Level] $Message") }
        function Invoke-SmithNative {
            param([string]$FilePath, [string[]]$ArgumentList, [int]$TimeoutSec)
            $joined = $ArgumentList -join ' '
            $result = [pscustomobject]@{ ExitCode = 0; TimedOut = $false; Output = ''; Error = '' }
            if ($joined -match 'wc -c') { $result.Output = "12345`n" }
            if ($joined -match 'sh -c') {
                $result.Output = "smith-smith-20260101-030000.dump`nsmith-smith-20260102-030000.dump`nsmith-smith-20261003-030000.dump`n"
            }
            if ($joined -match 'rm -f') { $result = [pscustomobject]@{ ExitCode = 255; TimedOut = $false; Output = ''; Error = 'Connection reset by peer' } }
            return $result
        }
        $config = [pscustomobject]@{ SshTarget = 'sahte'; RemoteDir = 'smith-backups'; Keep = 2 }
        $result = Invoke-SmithBackupSshMirror -Config $config -LocalPath 'sahte.dump' -FileName 'smith-smith-20261003-030000.dump' -LocalSize 12345 -Database 'smith'
        Assert-True 'rm hatasi: ayna basarili, uyari dolu' ($result.Reference -like 'sahte:*' -and $result.PruneError -match 'uzak budama')
        Assert-True 'WARN satiri yazildi' (@($script:Logs | Where-Object { $_ -like '*ayna tamam, budama atlandi:*' }).Count -eq 1)
    }

    Invoke-Case 'SSH ayna: normal akis uyarisiz; -SkipPrune listelemeye hic gitmez' {
        foreach ($text in (Import-MirrorFunctions)) { . ([scriptblock]::Create($text)) }
        $script:Calls = New-Object System.Collections.Generic.List[object]
        function Get-Command { [CmdletBinding()] param([string]$Name, [string]$CommandType) return [pscustomobject]@{ Source = "C:\sahte\$Name" } }
        function Write-SmithLog { param($Message, $Level) }
        function Invoke-SmithNative {
            param([string]$FilePath, [string[]]$ArgumentList, [int]$TimeoutSec)
            $joined = $ArgumentList -join ' '
            $script:Calls.Add($joined)
            $result = [pscustomobject]@{ ExitCode = 0; TimedOut = $false; Output = ''; Error = '' }
            if ($joined -match 'wc -c') { $result.Output = "12345`n" }
            if ($joined -match 'sh -c') { $result.Output = "smith-smith-20261003-030000.dump`n" }
            return $result
        }
        $config = [pscustomobject]@{ SshTarget = 'sahte'; RemoteDir = 'smith-backups'; Keep = 2 }
        $normal = Invoke-SmithBackupSshMirror -Config $config -LocalPath 'sahte.dump' -FileName 'smith-smith-20261003-030000.dump' -LocalSize 12345 -Database 'smith'
        Assert-True 'normal akis: uyari yok' ($null -ne $normal.Reference -and $null -eq $normal.PruneError)
        $script:Calls.Clear()
        $skip = Invoke-SmithBackupSshMirror -Config $config -LocalPath 'sahte.dump' -FileName 'smith-smith-20261003-030000.dump' -LocalSize 12345 -Database 'smith' -SkipPrune
        Assert-True '-SkipPrune: listeleme/budama komutu yok, uyari yok' (
            $null -eq $skip.PruneError -and @($script:Calls | Where-Object { $_ -match 'sh -c|rm -f' }).Count -eq 0)
    }

    Invoke-Case 'SSH ayna: kopya (mv oncesi) asili kalirsa ayna BASARISIZ ve mv hic denenmez' {
        foreach ($text in (Import-MirrorFunctions)) { . ([scriptblock]::Create($text)) }
        $script:Calls = New-Object System.Collections.Generic.List[object]
        function Get-Command { [CmdletBinding()] param([string]$Name, [string]$CommandType) return [pscustomobject]@{ Source = "C:\sahte\$Name" } }
        function Write-SmithLog { param($Message, $Level) }
        function Invoke-SmithNative {
            param([string]$FilePath, [string[]]$ArgumentList, [int]$TimeoutSec)
            $script:Calls.Add(($ArgumentList -join ' '))
            if ($FilePath -like '*scp.exe') { return [pscustomobject]@{ ExitCode = -1; TimedOut = $true; Output = ''; Error = '' } }
            return [pscustomobject]@{ ExitCode = 0; TimedOut = $false; Output = ''; Error = '' }
        }
        $config = [pscustomobject]@{ SshTarget = 'sahte'; RemoteDir = 'smith-backups'; Keep = 2 }
        $message = $null
        try {
            $null = Invoke-SmithBackupSshMirror -Config $config -LocalPath 'sahte.dump' -FileName 'smith-smith-20261003-030000.dump' -LocalSize 12345 -Database 'smith'
        } catch { $message = $_.Exception.Message }
        Assert-True 'scp zaman asimi hata firlatir (adim tavani mesajiyla)' ($null -ne $message -and $message -match 'SCP kopyasi' -and $message -match '120 sn')  "$message"
        Assert-True 'mv ve listeleme hic denenmedi' (@($script:Calls | Where-Object { $_ -match 'mv -f|sh -c' }).Count -eq 0)
    }

    Invoke-Case 'SSH ayna: adim tavani kalan toplam sureyle sinirlanir' {
        foreach ($text in (Import-MirrorFunctions)) { . ([scriptblock]::Create($text)) }
        $script:Seen = 0
        function Invoke-SmithNative {
            param([string]$FilePath, [string[]]$ArgumentList, [int]$TimeoutSec)
            $script:Seen = $TimeoutSec
            return [pscustomobject]@{ ExitCode = -1; TimedOut = $true; Output = ''; Error = '' }
        }
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $message = $null
        try {
            Invoke-SmithBackupMirrorProcess -FilePath 'x' -ArgumentList @('a') -Stopwatch $sw -Step 'deneme' -TotalTimeoutSec 20 -StepTimeoutSec 120
        } catch { $message = $_.Exception.Message }
        Assert-True 'tavan = min(kalan toplam, adim tavani) = en cok 20' ($script:Seen -ge 1 -and $script:Seen -le 20) "gecen: $($script:Seen)"
        Assert-True 'toplam tavan mesaji' ($message -match 'toplam 20 sn zaman tavanini asti') "$message"
        $message = $null
        try {
            Invoke-SmithBackupMirrorProcess -FilePath 'x' -ArgumentList @('a') -Stopwatch $sw -Step 'deneme' -TotalTimeoutSec 300 -StepTimeoutSec 30
        } catch { $message = $_.Exception.Message }
        Assert-True 'adim tavani 30: Invoke-SmithNative 30 ile cagrilir' ($script:Seen -eq 30) "gecen: $($script:Seen)"
        Assert-True 'adim tavani mesaji (toplam degil)' ($message -match 'adimi 30 sn icinde tamamlanmadi') "$message"
    }
} finally {
    $leaf = Split-Path -Leaf $work
    if ($leaf -like 'pg-backup-test-*' -and
        (Split-Path -Parent $work).TrimEnd('\') -eq $tempRoot.TrimEnd('\') -and
        (Test-Path -LiteralPath $work)) {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Complete-SmithTestRun
