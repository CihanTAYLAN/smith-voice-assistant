# Smith hafiza veritabaninin (Postgres + pgvector) yedegini alir.
#
# Neden gerekli: canli pgdata volume'unde daha once olculmus bir veri kaybi
# vakasi var (docker compose down + volume prune -> 1226 hafiza kaydi silindi).
# Isimli volume (pgdata:) o riski azaltti ama YEDEK DEGIL -- ayni makinede tek
# kopya olmaya devam ediyor. Bu script dump'i ayri bir dosyaya cikarir.
#
# Nasil calisir: pg_dump'i HOST'ta degil, calisan postgres container'inin
# ICINDE calistirir (host'ta pg_dump/psql kurulu degil, yalniz Docker var).
# Custom format (-F c): sikistirilmis + pg_restore ile secici/paralel geri
# yukleme destekler + CREATE EXTENSION dahil (pgvector kurulumunu tasir).
#
# Gece 03:00 gorevi icin dayanikli: Docker motoru kapaliysa Docker Desktop'i
# baslatip 240 sn'ye kadar bekler, postgres container'i `compose up -d` ile
# kaldirir (asla `down`/`prune`), pg_isready bekler, sonra yedekler. Dump
# container icinde `pg_restore -l` ile dogrulanir (bozuk arsiv "basarili" sayilmaz).
#
# Cikis kodu: 0 = yedek alindi, 1 = basarisiz (Windows bildirimi de gosterilir).
# Her kosuda <veri koku>\last-backup.json yazilir (kok: SMITH_DATA_DIR ya da
# %USERPROFILE%\.smith, bkz. smith-common.ps1):
#   {zaman, dosya, boyut, ok, hata, yansi, yansi_ssh, yansi_ssh_hata,
#    yansi_ssh_budama_hata, yansi_ssh_zaman}
#
# Budama: -RetentionDays'ten eski dump YALNIZ kendisinden yeni en az 7 dump varsa
# silinir (en yeni 7 dump yasa bakilmadan korunur; bkz. Get-PrunableDumps).
# -NoPrune hicbir sey silmez.
#
# Yarim dump: dump once `<ad>.dump.part` olarak iner, dogrulamalar gecince `.dump`'a
# tasinir; hata yolunda `.part` silinir (budama yalniz tam dump'lari sayar).
#
# Boyut kontrolu: yeni dump, onceki saglam dump'in -MinSizeRatio (varsayilan 0.5) altindaysa
# yedek BASARISIZ sayilir (volume kaybi + bos Postgres'in "basarili" bos yedek uretmesine
# karsi); dump `.suspect` olarak saklanir, budama yapilmaz.
#
# Ayna: $env:SMITH_BACKUP_MIRROR tanimliysa (ornegin baska disk / ag paylasimi /
# bulut senkron klasoru) her BASARILI dump oraya da kopyalanir. Ayna kopyasi
# basarisizsa yedek BASARISIZ sayilir (kullanici off-site istiyor, sessizce
# yalniz-yerel kalmasin); ayna dizini budanmaz.
#
# SSH aynasi: SMITH_BACKUP_MIRROR_SSH veya
# <veri koku>\backup-mirror.json ayarlanirsa saglam dump uzak makineye
# kopyalanir, boyutu dogrulanir ve yalniz tam Smith dump adlari adetle budanir.
# SSH aynasi hatasi yerel yedegi basarisiz yapmaz; son basarili SSH zamani korunur.
# Atomik ad degisimi (.part -> .dump) tamamlandiysa ayna BASARILIDIR: sonraki uzak
# listeleme/budama hatasi yalniz uyaridir ("ayna tamam, budama atlandi") ve last-backup
# durumunda yansi_ssh_budama_hata alanina yazilir. Her SSH/SCP adiminin kendi tavani vardir
# (scp 120 sn, digerleri 30 sn; toplam 300 sn tavani ayrica kalir) ve baglanti
# ServerAliveInterval ile asili kalmaz.
#
# Kullanim:
#   .\scripts\pg-backup.ps1                # varsayilan: docker/dev-compose.yml, backups\
#   .\scripts\pg-backup.ps1 -RetentionDays 30
#   .\scripts\pg-backup.ps1 -NoPrune        # eski dosyalari silme
#   .\scripts\pg-backup.ps1 -MinSizeRatio 0 # boyut kontrolunu kapat (bilerek kuculen DB'yi kabul et)
#
# Geri yukleme dogrulamasi icin: .\scripts\pg-restore-test.ps1 -DumpFile <yol>
param(
    [string]$ComposeFile = (Join-Path $PSScriptRoot "..\docker\dev-compose.yml"),
    [string]$Service = "postgres",
    [string]$PgUser = "smith",
    [string]$PgDatabase = "smith",
    [string]$OutDir = (Join-Path $PSScriptRoot "..\backups"),
    [int]$RetentionDays = 14,
    [switch]$NoPrune,
    [ValidateRange(0, 1)]
    [double]$MinSizeRatio = 0.5
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'smith-common.ps1')
. (Join-Path $PSScriptRoot 'pg-backup-functions.ps1')
Set-SmithLogName 'pg-backup'

function Get-SmithBackupSshConfigFromSystem {
    param([string]$ConfigPath)

    $fileConfig = $null
    if ([string]::IsNullOrWhiteSpace($env:SMITH_BACKUP_MIRROR_SSH) -and
        (Test-Path -LiteralPath $ConfigPath)) {
        $fileConfig = Read-SmithJson -Path $ConfigPath
    }
    return Resolve-SmithBackupSshConfig -EnvValue $env:SMITH_BACKUP_MIRROR_SSH -FileConfig $fileConfig
}

function Invoke-SmithBackupMirrorProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][System.Diagnostics.Stopwatch]$Stopwatch,
        [Parameter(Mandatory = $true)][string]$Step,
        [int]$TotalTimeoutSec = 300,
        [int]$StepTimeoutSec = 30
    )

    $remaining = [int][math]::Floor($TotalTimeoutSec - $Stopwatch.Elapsed.TotalSeconds)
    if ($remaining -lt 1) {
        throw "SSH ayna islemi toplam $TotalTimeoutSec sn zaman tavanini asti ($Step)."
    }
    # Etkin tavan: adim tavani ile kalan toplam surenin kucugu. Asili kalan tek adim
    # tum toplam sureyi (300 sn) yemesin.
    $timeout = [math]::Min($remaining, $StepTimeoutSec)
    $result = Invoke-SmithNative -FilePath $FilePath -ArgumentList $ArgumentList -TimeoutSec $timeout
    if ($result.TimedOut) {
        if ($timeout -lt $remaining) {
            throw "SSH ayna adimi $timeout sn icinde tamamlanmadi ($Step; adim tavani $StepTimeoutSec sn, toplam tavan $TotalTimeoutSec sn)."
        }
        throw "SSH ayna islemi toplam $TotalTimeoutSec sn zaman tavanini asti ($Step)."
    }
    if ($result.ExitCode -ne 0) {
        $detail = Get-SmithBackupShortError ($result.Error + ' ' + $result.Output)
        throw "$Step basarisiz (exit $($result.ExitCode)): $detail"
    }
    return $result
}

function Invoke-SmithBackupSshMirror {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$LocalPath,
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][long]$LocalSize,
        [Parameter(Mandatory = $true)][string]$Database,
        [switch]$SkipPrune,
        [int]$TotalTimeoutSec = 300
    )

    if ($Database -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]*$') {
        throw 'SSH ayna icin veritabani adi guvenli bir dosya adi bileseni olmali.'
    }
    $fileInfo = Get-SmithBackupFileInfo -Name $FileName -Database $Database
    if ($null -eq $fileInfo -or $fileInfo.IsPart) {
        throw 'SSH ayna dosya adi beklenen Smith dump desenine uymuyor.'
    }

    $sshCommand = Get-Command ssh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $scpCommand = Get-Command scp.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $sshCommand) { throw 'ssh.exe bulunamadi.' }
    if (-not $scpCommand) { throw 'scp.exe bulunamadi.' }

    $sshOptions = Get-SmithBackupSshOptions
    $remoteDirQuoted = "'$($Config.RemoteDir)'"
    $remotePath = $Config.RemoteDir + '/' + $FileName
    $remotePathQuoted = "'$remotePath'"
    $remotePartPath = $remotePath + '.part'
    $remotePartPathQuoted = "'$remotePartPath'"
    $remoteReference = '{0}:{1}' -f $Config.SshTarget, $remotePath
    $remotePartReference = '{0}:{1}' -f $Config.SshTarget, $remotePartPath
    $timer = [System.Diagnostics.Stopwatch]::StartNew()

    try {
        $mkdirArgs = @($sshOptions) + @($Config.SshTarget, "mkdir -p $remoteDirQuoted")
        $null = Invoke-SmithBackupMirrorProcess -FilePath $sshCommand.Source -ArgumentList $mkdirArgs `
            -Stopwatch $timer -Step 'uzak dizin olusturma' -TotalTimeoutSec $TotalTimeoutSec `
            -StepTimeoutSec (Get-SmithBackupStepTimeoutSec 'quick')

        # Uzakta da yarim kopyayi final dump sayma: once .part, boyut kontrolu,
        # sonra ayni dizinde atomik ad degisimi. Budama yalniz final .dump gorur.
        $scpArgs = @($sshOptions) + @($LocalPath, $remotePartReference)
        $null = Invoke-SmithBackupMirrorProcess -FilePath $scpCommand.Source -ArgumentList $scpArgs `
            -Stopwatch $timer -Step 'SCP kopyasi' -TotalTimeoutSec $TotalTimeoutSec `
            -StepTimeoutSec (Get-SmithBackupStepTimeoutSec 'copy')

        $sizeArgs = @($sshOptions) + @($Config.SshTarget, "wc -c < $remotePartPathQuoted")
        $sizeResult = Invoke-SmithBackupMirrorProcess -FilePath $sshCommand.Source -ArgumentList $sizeArgs `
            -Stopwatch $timer -Step 'uzak boyut dogrulamasi' -TotalTimeoutSec $TotalTimeoutSec `
            -StepTimeoutSec (Get-SmithBackupStepTimeoutSec 'quick')
        $remoteSizeText = $sizeResult.Output.Trim()
        $remoteSize = 0L
        if ($remoteSizeText -cnotmatch '^[0-9]+$' -or -not [long]::TryParse($remoteSizeText, [ref]$remoteSize)) {
            throw "Uzak boyut okunamadi: $(Get-SmithBackupShortError $remoteSizeText)"
        }
        if ($remoteSize -ne $LocalSize) {
            throw "Uzak boyut uyusmuyor (yerel $LocalSize byte, uzak $remoteSize byte)."
        }

        $moveArgs = @($sshOptions) + @($Config.SshTarget, "mv -f $remotePartPathQuoted $remotePathQuoted")
        $null = Invoke-SmithBackupMirrorProcess -FilePath $sshCommand.Source -ArgumentList $moveArgs `
            -Stopwatch $timer -Step 'uzak atomik tamamlama' -TotalTimeoutSec $TotalTimeoutSec `
            -StepTimeoutSec (Get-SmithBackupStepTimeoutSec 'quick')

        # BURADAN SONRA AYNA BASARILIDIR: final .dump uzakta yerinde ve boyutu dogrulandi.
        # Listeleme/budama hatasi yalniz uyaridir; yutulmaz ama aynayi basarisiz yapmaz
        # (2026-10-03: asili kalan listeleme adimi saglam aynayi "basarisiz" yazdirdi).
        $pruneError = $null
        if (-not $SkipPrune) {
            try {
                # Uzak login shell zsh olabilir; zsh NOMATCH bos hidden globu hata yapar.
                # Globlari single-quoted sh -c govdesinde POSIX sh'e birak.
                $listScript = 'for f in "' + $Config.RemoteDir + '"/* "' + $Config.RemoteDir +
                    '"/.[!.]* "' + $Config.RemoteDir + '"/..?*; do [ -f "$f" ] || continue; basename "$f"; done'
                $listCommand = "sh -c '$listScript'"
                $listArgs = @($sshOptions) + @($Config.SshTarget, $listCommand)
                $listResult = Invoke-SmithBackupMirrorProcess -FilePath $sshCommand.Source -ArgumentList $listArgs `
                    -Stopwatch $timer -Step 'uzak dosya listesi' -TotalTimeoutSec $TotalTimeoutSec `
                    -StepTimeoutSec (Get-SmithBackupStepTimeoutSec 'quick')
                $remoteNames = @($listResult.Output -split "`r?`n" | Where-Object { $_ -ne '' })
                $plan = Get-SmithRemoteBackupPrunePlan -Names $remoteNames -Database $Database -Keep $Config.Keep
                foreach ($ignored in @($plan.IgnoredNames)) {
                    $safeIgnored = Get-SmithBackupShortError $ignored
                    Write-SmithLog "[pg-backup] SSH ayna desen disi dosya korunuyor: $safeIgnored" 'WARN'
                }
                if ($plan.DeleteNames.Count -gt 0) {
                    $deletePaths = @($plan.DeleteNames | ForEach-Object { "'$($Config.RemoteDir)/$_'" })
                    $deleteArgs = @($sshOptions) + @($Config.SshTarget, ('rm -f ' + ($deletePaths -join ' ')))
                    $null = Invoke-SmithBackupMirrorProcess -FilePath $sshCommand.Source -ArgumentList $deleteArgs `
                        -Stopwatch $timer -Step 'uzak budama' -TotalTimeoutSec $TotalTimeoutSec `
                        -StepTimeoutSec (Get-SmithBackupStepTimeoutSec 'quick')
                    foreach ($deleted in @($plan.DeleteNames)) {
                        Write-SmithLog "[pg-backup] SSH ayna eski yedek silindi: $deleted"
                    }
                }
            } catch {
                $pruneError = Get-SmithBackupShortError $_.Exception.Message
                Write-SmithLog "[pg-backup] SSH ayna tamam, budama atlandi: $pruneError" 'WARN'
            }
        }
    } finally {
        $timer.Stop()
    }

    return [pscustomobject]@{ Reference = $remoteReference; PruneError = $pruneError }
}

# Docker, durum yazimi ve her turlu temizlige girmeden kilit al. Cakisan kosu
# calisan yedegin durumunu/logunu da degistirmez; yalniz acik mesaj ve exit 1.
$backupLock = Enter-SmithBackupLock -Dir $OutDir
if (-not $backupLock) {
    Write-Host '[pg-backup] BASARISIZ: baska bir pg-backup calisiyor veya cikti kilidi alinamadi; bu kosu atlandi, hicbir dosya silinmedi.'
    exit 1
}

try {
$MinKeep = 7
$DockerTimeoutSec = 240
$statePath = Join-Path (Get-SmithDataDir) 'last-backup.json'
$previousState = $null
try {
    $previousState = Read-SmithJson -Path $statePath
} catch {
    Write-SmithLog "[pg-backup] onceki durum okunamadi, SSH ayna zamani tasinamadi: $(Get-SmithBackupShortError $_.Exception.Message)" 'WARN'
}
$state = New-SmithBackupState -PreviousState $previousState

# Basarisizlik tek noktadan raporlanir: durum dosyasi + log + bildirim + sifir olmayan cikis.
try {
    $docker = Get-DockerExe
    if (-not $docker) { throw "docker CLI bulunamadi." }

    # Docker motoru yoksa Docker Desktop'i baslat ve bekle (gece gorevi motor kapaliyken
    # dusmesin). Zorlama yok: 240 sn'de gelmezse net hata.
    if (-not (Wait-DockerEngine -TimeoutSec $DockerTimeoutSec -StartIfNeeded)) {
        throw "Docker motoru $DockerTimeoutSec sn icinde hazir olmadi. Docker Desktop'i kontrol et."
    }

    if (-not (Test-Path $ComposeFile)) {
        throw "Compose dosyasi bulunamadi: $ComposeFile"
    }

    # Servisi kaldir (zaten calisiyorsa no-op). YALNIZ `up -d <servis>`: down/prune veri siler.
    Write-SmithLog "[pg-backup] compose up -d $Service ($ComposeFile)"
    $up = Invoke-SmithNative -FilePath $docker -ArgumentList @('compose', '-f', $ComposeFile, 'up', '-d', $Service) -TimeoutSec 240
    if ($up.TimedOut -or $up.ExitCode -ne 0) {
        $tail = (($up.Output + $up.Error).Trim() -split "`r?`n" | Select-Object -Last 5) -join ' | '
        throw "compose up basarisiz (exit $($up.ExitCode), zaman asimi: $($up.TimedOut)): $tail"
    }

    $idr = Invoke-SmithNative -FilePath $docker -ArgumentList @('compose', '-f', $ComposeFile, 'ps', '-q', $Service) -TimeoutSec 30
    $containerId = ($idr.Output.Trim() -split "`r?`n" | Select-Object -First 1)
    if ([string]::IsNullOrWhiteSpace($containerId)) {
        throw "Servis '$Service' calismiyor ($ComposeFile)."
    }

    $nameR = Invoke-SmithNative -FilePath $docker -ArgumentList @('inspect', '--format', '{{.Name}}', $containerId) -TimeoutSec 30
    $containerName = $nameR.Output.Trim().TrimStart("/")
    $stateR = Invoke-SmithNative -FilePath $docker -ArgumentList @('inspect', '--format', '{{.State.Status}}', $containerId) -TimeoutSec 30
    if ($stateR.Output.Trim() -ne "running") {
        throw "Container '$containerName' calisir durumda degil (durum: $($stateR.Output.Trim()))."
    }

    # Postgres kabul etmeye hazir olana dek bekle (container 'running' != veritabani hazir).
    $deadline = (Get-Date).AddSeconds(120)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        $q = Invoke-SmithNative -FilePath $docker -ArgumentList @('exec', $containerName, 'pg_isready', '-U', $PgUser, '-d', $PgDatabase) -TimeoutSec 20
        if ($q.ExitCode -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 3
    }
    if (-not $ready) { throw "Postgres 120 sn icinde hazir olmadi (pg_isready)." }

    Write-SmithLog "[pg-backup] container: $containerName ($Service, $ComposeFile)"

    if (-not (Test-Path $OutDir)) {
        New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    }
    $OutDir = (Resolve-Path $OutDir).Path

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $fileName = "smith-$PgDatabase-$stamp.dump"
    $tmpInContainer = "/tmp/$fileName"
    $hostPath = Join-Path $OutDir $fileName

    # Ayni saniyede ikinci calistirma (idempotent test) icin ufak bir sonek ekle,
    # ustune yazma.
    $suffix = 0
    while ((Test-Path -LiteralPath $hostPath) -or (Test-Path -LiteralPath ($hostPath + '.part'))) {
        $suffix++
        $fileName = "smith-$PgDatabase-$stamp-$suffix.dump"
        $tmpInContainer = "/tmp/$fileName"
        $hostPath = Join-Path $OutDir $fileName
    }

    # Dump once `.part` olarak iner, dogrulamalar gecince `.dump` adina tasinir: yarim kalan
    # kopya (docker cp kopmasi, surecin oldurulmesi) `.dump` filtresine hic girmez, budama
    # ve "onceki yedek" hesabi onu saglam yedek saymaz. Kilit altinda yalniz iki saatten
    # eski, tam adi dogrulanmis artiklar silinir. Taze/elle adlandirilmis part korunur.
    Remove-StaleSmithDumpParts -Dir $OutDir -Database $PgDatabase -LockStream $backupLock
    $partPath = $hostPath + '.part'

    Write-SmithLog "[pg-backup] pg_dump calisiyor -> $tmpInContainer (container ici)"
    $dump = Invoke-SmithNative -FilePath $docker -ArgumentList @('exec', $containerName, 'pg_dump', '-U', $PgUser, '-d', $PgDatabase, '-F', 'c', '-f', $tmpInContainer) -TimeoutSec 1800
    try {
        try {
            if ($dump.TimedOut -or $dump.ExitCode -ne 0) {
                throw "pg_dump basarisiz (exit $($dump.ExitCode), zaman asimi: $($dump.TimedOut)): $($dump.Error.Trim())"
            }

            # Arsiv icerigi okunabiliyor mu: bozuk/yarim dump "basarili" sayilmasin.
            $list = Invoke-SmithNative -FilePath $docker -ArgumentList @('exec', $containerName, 'pg_restore', '-l', $tmpInContainer) -TimeoutSec 300
            if ($list.TimedOut -or $list.ExitCode -ne 0) {
                throw "Dump dogrulamasi (pg_restore -l) basarisiz (exit $($list.ExitCode)): $($list.Error.Trim())"
            }

            Write-SmithLog "[pg-backup] disari kopyalaniyor -> $partPath"
            $cp = Invoke-SmithNative -FilePath $docker -ArgumentList @('cp', "${containerName}:$tmpInContainer", $partPath) -TimeoutSec 600
            if ($cp.TimedOut -or $cp.ExitCode -ne 0) {
                throw "docker cp basarisiz (exit $($cp.ExitCode)): $($cp.Error.Trim())"
            }
        } finally {
            # Container icindeki gecici dosyayi temizle -- container'in KENDI /tmp'i,
            # canli veriye veya volume'e dokunmuyor. Temizlik hatasi yedegi bozmaz.
            [void](Invoke-SmithNative -FilePath $docker -ArgumentList @('exec', $containerName, 'rm', '-f', $tmpInContainer) -TimeoutSec 30)
        }

        if (-not (Test-Path -LiteralPath $partPath)) {
            throw "Dump dosyasi host'ta olusmadi: $partPath"
        }
        $size = (Get-Item -LiteralPath $partPath).Length
        if ($size -le 0) {
            throw "Dump dosyasi bos: $partPath"
        }

        # Boyut kontrolu: pg_dump bos/yeni yaratilmis bir veritabanindan da "gecerli" arsiv
        # uretir (pgdata volume kaybolup compose up bos Postgres yarattiginda). Onceki
        # saglam dump'a gore ani kuculme yedegi BASARISIZ sayar. Supheli dump `.suspect`
        # olarak saklanir (kanit; budamaya ve "onceki yedek" hesabina girmez). Bilerek
        # kuculduyse bir kez `-MinSizeRatio 0` ile kabul edilir.
        if ($MinSizeRatio -gt 0) {
            $prev = Get-SmithDumpFiles -Dir $OutDir -Database $PgDatabase |
                Where-Object { $_.Length -gt 0 } |
                Sort-Object @{ Expression = 'LastWriteTime'; Descending = $true }, @{ Expression = 'Name'; Descending = $true } |
                Select-Object -First 1
            if ($prev -and $size -lt ($prev.Length * $MinSizeRatio)) {
                $suspectPath = $hostPath + '.suspect'
                Move-Item -LiteralPath $partPath -Destination $suspectPath -Force
                $state.dosya = $suspectPath
                $state.boyut = $size
                throw ("Dump onceki yedege gore supheli derecede kucuk: $size byte, onceki $($prev.Length) byte ($($prev.Name)), " +
                    "oran < $MinSizeRatio. Veritabani/volume kaybi olabilir; dump $suspectPath olarak saklandi, budama yapilmadi. " +
                    "Bilerek kuculduyse bir kez -MinSizeRatio 0 ile calistir.")
            }
        }
        Move-Item -LiteralPath $partPath -Destination $hostPath -Force
    } finally {
        # Hata yolunda yarim `.part` dosyasi kalmasin.
        if (Test-Path -LiteralPath $partPath) { Remove-Item -LiteralPath $partPath -Force -ErrorAction SilentlyContinue }
    }

    $sizeMb = [math]::Round($size / 1MB, 2)
    Write-SmithLog "[pg-backup] OK: $hostPath ($sizeMb MB, $size byte)"
    $state.dosya = $hostPath
    $state.boyut = $size

    # Dump saglam; ayna kopyasi (varsa) basarisizsa yine de yedek BASARISIZ sayilir.
    $mirror = $env:SMITH_BACKUP_MIRROR
    if ($mirror) {
        if (-not (Test-Path $mirror)) { New-Item -ItemType Directory -Force -Path $mirror | Out-Null }
        $mirrorFile = Join-Path $mirror $fileName
        try {
            Copy-Item -LiteralPath $hostPath -Destination $mirrorFile -Force
            if ((Get-Item -LiteralPath $mirrorFile).Length -ne $size) {
                throw "boyut uyusmuyor"
            }
        } catch {
            throw "Ayna kopyasi basarisiz ($mirrorFile): $($_.Exception.Message). Yerel dump saglam: $hostPath"
        }
        $state.yansi = $mirrorFile
        Write-SmithLog "[pg-backup] ayna kopyasi: $mirrorFile"
    }

    # SSH aynasi ayri bir dayaniklilik katmanidir. Mac kapali/uykudaysa yerel
    # yedek basarili kalir; yalniz SSH alanlari ve gerekirse 72 saat uyarisi yazilir.
    $sshConfigPath = Join-Path (Get-SmithDataDir) 'backup-mirror.json'
    $sshRequested = -not [string]::IsNullOrWhiteSpace($env:SMITH_BACKUP_MIRROR_SSH) -or
        (Test-Path -LiteralPath $sshConfigPath)
    if ($sshRequested) {
        try {
            $sshConfig = Get-SmithBackupSshConfigFromSystem -ConfigPath $sshConfigPath
            $mirrorResult = Invoke-SmithBackupSshMirror -Config $sshConfig -LocalPath $hostPath `
                -FileName $fileName -LocalSize $size -Database $PgDatabase -SkipPrune:$NoPrune
            Set-SmithBackupSshMirrorSuccess -State $state -Result $mirrorResult
            Write-SmithLog "[pg-backup] SSH ayna kopyasi dogrulandi: $($mirrorResult.Reference)"
        } catch {
            Set-SmithBackupSshMirrorFailure -State $state -Message $_.Exception.Message
            Write-SmithLog "[pg-backup] SSH ayna basarisiz; yerel yedek basarili kaldi: $($state.yansi_ssh_hata)" 'WARN'
            if (Test-SmithBackupSshAlertDue -LastSuccessTime $state.yansi_ssh_zaman) {
                $how = Show-SmithToast -Title 'Smith yedek aynasi UYARI' -Message 'Yedek aynasi 3 gundur yapilamadi'
                Write-SmithLog "[pg-backup] SSH ayna 72 saat uyarisi: $how" 'WARN'
            }
        }
    }

    if (-not $NoPrune) {
        $old = @(Get-PrunableDumps -Dir $OutDir -Database $PgDatabase -RetentionDays $RetentionDays -MinKeep $MinKeep)
        foreach ($f in $old) {
            Write-SmithLog "[pg-backup] eski yedek siliniyor (>$RetentionDays gun, ardinda en az $MinKeep yeni yedek var): $($f.Name)"
            Remove-Item -LiteralPath $f.FullName -Force
        }
    }

    $state.ok = $true
    Write-SmithLog "[pg-backup] BITTI"
} catch {
    $state.ok = $false
    $state.hata = $_.Exception.Message
}

$state.zaman = (Get-Date -Format 'o')
Write-SmithJson -Path $statePath -Object $state

if (-not $state.ok) {
    Write-SmithLog "[pg-backup] BASARISIZ: $($state.hata)" 'ERROR'
    $how = Show-SmithToast -Title 'Smith yedegi BASARISIZ' -Message $state.hata
    Write-SmithLog "[pg-backup] bildirim: $how"
    exit 1
}

Write-Host "DUMP_PATH=$($state.dosya)"
Write-Host "DUMP_SIZE_BYTES=$($state.boyut)"
exit 0
} finally {
    $backupLock.Dispose()
}
