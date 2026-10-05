# pg-backup'a ozgu yardimcilar. Bu dosya yalniz fonksiyon tanimlar; dot-source
# edildiginde is yapmaz. Ag, bildirim veya process baslatma yan etkisi yoktur.

# pg-backup'in URETTIGI dump adlari icin tek ayristirici:
# smith-<veritabani>-<yyyyMMdd>-<HHmmss>[-<n>].dump[.part]
# Regex bicimi, TryParseExact takvim/saat gercekligini, suffix ise Int32 sinirini
# dogrular. Yerel listeleme, yerel/uzak budama ve SSH kopya kapisi bunu kullanir.
function Get-SmithBackupFileInfo {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Database
    )

    $regex = '^smith-' + [regex]::Escape($Database) +
        '-(?<date>[0-9]{8})-(?<time>[0-9]{6})(?:-(?<suffix>[0-9]+))?\.dump(?<part>\.part)?$'
    $match = [regex]::Match($Name, $regex,
        [System.Text.RegularExpressions.RegexOptions]::CultureInvariant)
    if (-not $match.Success) { return $null }

    $timestamp = [datetime]::MinValue
    $stampText = $match.Groups['date'].Value + '-' + $match.Groups['time'].Value
    if (-not [datetime]::TryParseExact(
            $stampText,
            'yyyyMMdd-HHmmss',
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::None,
            [ref]$timestamp)) {
        return $null
    }

    $suffix = 0
    if ($match.Groups['suffix'].Success -and
        -not [int]::TryParse(
            $match.Groups['suffix'].Value,
            [System.Globalization.NumberStyles]::None,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [ref]$suffix)) {
        return $null
    }

    return [pscustomobject]@{
        Name      = $Name
        Timestamp = $timestamp
        Suffix    = $suffix
        IsPart    = $match.Groups['part'].Success
    }
}

# Cikti klasorundeki tum pg-backup kosularini siralar (SMITH_DATA_DIR farkli olsa da).
# FileStream kosu boyunca tutulur; Mutex/GC tek-ornek garantisi vermez.
# Kilit dosyasi silinmez: ayni yolun farkli dosya kimlikleriyle acilmasini onler.
function Enter-SmithBackupLock {
    param([Parameter(Mandatory = $true)][string]$Dir)
    $null = [System.IO.Directory]::CreateDirectory($Dir)
    $path = Join-Path $Dir 'pg-backup.lock'
    try {
        return [System.IO.FileStream]::new($path, [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    } catch [System.IO.IOException] {
        return $null
    }
}

# Yalniz kilidi tutan kosu stale part temizleyebilir. Taze part, yarim kalmis bir
# onceki kosudan gelse bile iki saat dolmadan korunur.
function Remove-StaleSmithDumpParts {
    param(
        [Parameter(Mandatory = $true)][string]$Dir,
        [Parameter(Mandatory = $true)][string]$Database,
        [Parameter(Mandatory = $true)][System.IO.FileStream]$LockStream
    )
    $lockPath = [System.IO.Path]::GetFullPath((Join-Path $Dir 'pg-backup.lock'))
    if (-not $LockStream.CanWrite -or $LockStream.Name -ne $lockPath) {
        throw 'pg-backup temizligi icin bu cikti klasorunun acik kilidi gerekli.'
    }
    foreach ($stale in @(Get-SmithDumpFiles -Dir $Dir -Database $Database -Part)) {
        Remove-Item -LiteralPath $stale.FullName -Force
    }
}

# Aday listesi genistir; kabul karari yalniz Get-SmithBackupFileInfo'dan gelir.
# Veritabani adi Get-ChildItem jokerine verilmez; '?' ve '*' duz karakter kalir.
function Get-SmithDumpFiles {
    param(
        [Parameter(Mandatory = $true)][string]$Dir,
        [Parameter(Mandatory = $true)][string]$Database,
        [switch]$Part
    )
    $partCutoff = (Get-Date).AddHours(-2)
    return @(Get-ChildItem -LiteralPath $Dir -Filter 'smith-*.dump*' -File |
            Where-Object {
                $info = Get-SmithBackupFileInfo -Name $_.Name -Database $Database
                $null -ne $info -and $info.IsPart -eq $Part.IsPresent -and
                    (-not $Part -or $_.LastWriteTime -lt $partCutoff)
            })
}

# Budanabilir dump'lari doner. En yeni $MinKeep dump yasa bakilmadan korunur.
# Bos dosya basarili dump sayilmaz ve ne sayilir ne silinir.
function Get-PrunableDumps {
    param(
        [Parameter(Mandatory = $true)][string]$Dir,
        [Parameter(Mandatory = $true)][string]$Database,
        [int]$RetentionDays = 14,
        [int]$MinKeep = 7
    )
    $all = @(Get-SmithDumpFiles -Dir $Dir -Database $Database |
            Where-Object { $_.Length -gt 0 } |
            Sort-Object @{ Expression = 'LastWriteTime'; Descending = $true },
                @{ Expression = 'Name'; Descending = $true })
    $cutoff = (Get-Date).AddDays(-$RetentionDays)
    $result = @()
    for ($i = $MinKeep; $i -lt $all.Count; $i++) {
        if ($all[$i].LastWriteTime -lt $cutoff) { $result += $all[$i] }
    }
    return $result
}

function Resolve-SmithBackupSshConfig {
    param(
        [AllowEmptyString()][string]$EnvValue,
        $FileConfig
    )

    $target = $null
    $remoteDir = $null
    $keepValue = 14
    $source = $null

    if (-not [string]::IsNullOrWhiteSpace($EnvValue)) {
        $separator = $EnvValue.IndexOf(':')
        if ($separator -le 0 -or $separator -eq ($EnvValue.Length - 1)) {
            throw 'SMITH_BACKUP_MIRROR_SSH bicimi ssh_hedef:uzak_dizin olmali.'
        }
        $target = $EnvValue.Substring(0, $separator).Trim()
        $remoteDir = $EnvValue.Substring($separator + 1).Trim()
        $source = 'env'
    } elseif ($null -ne $FileConfig) {
        $target = [string]$FileConfig.ssh_hedef
        $remoteDir = [string]$FileConfig.uzak_dizin
        if ($null -ne $FileConfig.sakla -and -not [string]::IsNullOrWhiteSpace([string]$FileConfig.sakla)) {
            $keepValue = $FileConfig.sakla
        }
        $source = 'file'
    } else {
        return $null
    }

    if ($target -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        throw 'SSH hedefi guvenli bir OpenSSH alias olmali.'
    }

    $remoteDir = $remoteDir.Trim().TrimEnd('/')
    if ($remoteDir -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*$') {
        throw 'Uzak dizin home altinda guvenli, goreli bir POSIX yolu olmali.'
    }

    $keep = 0
    if (-not [int]::TryParse([string]$keepValue,
            [System.Globalization.NumberStyles]::Integer,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [ref]$keep) -or $keep -lt 1 -or $keep -gt 10000) {
        throw 'SSH ayna sakla degeri 1 ile 10000 arasinda bir tamsayi olmali.'
    }

    return [pscustomobject]@{
        SshTarget = $target
        RemoteDir = $remoteDir
        Keep      = $keep
        Source    = $source
    }
}

function Get-SmithRemoteBackupPrunePlan {
    param(
        [string[]]$Names = @(),
        [Parameter(Mandatory = $true)][string]$Database,
        [ValidateRange(1, 10000)][int]$Keep
    )

    $valid = @()
    $ignored = @()

    foreach ($name in @($Names)) {
        $info = Get-SmithBackupFileInfo -Name ([string]$name) -Database $Database
        if ($null -eq $info -or $info.IsPart) {
            $ignored += [string]$name
            continue
        }
        $valid += $info
    }

    $ordered = @($valid | Sort-Object `
            @{ Expression = 'Timestamp'; Descending = $true },
            @{ Expression = 'Suffix'; Descending = $true },
            @{ Expression = 'Name'; Descending = $true })
    $kept = @($ordered | Select-Object -First $Keep | ForEach-Object { $_.Name })
    $deleted = @($ordered | Select-Object -Skip $Keep | ForEach-Object { $_.Name })

    return [pscustomobject]@{
        KeepNames    = $kept
        DeleteNames  = $deleted
        IgnoredNames = @($ignored)
    }
}

function Test-SmithBackupSshAlertDue {
    param(
        $LastSuccessTime,
        [datetimeoffset]$Now = [datetimeoffset]::Now,
        [ValidateRange(1, 87600)][int]$MaxAgeHours = 72
    )

    if ($null -eq $LastSuccessTime -or [string]::IsNullOrWhiteSpace([string]$LastSuccessTime)) {
        return $false
    }
    $last = [datetimeoffset]::MinValue
    if (-not [datetimeoffset]::TryParse(
            [string]$LastSuccessTime,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::RoundtripKind,
            [ref]$last)) {
        return $false
    }
    return (($Now - $last).TotalHours -gt $MaxAgeHours)
}

function New-SmithBackupState {
    param(
        $PreviousState,
        [datetimeoffset]$Now = [datetimeoffset]::Now
    )

    $lastSshMirrorTime = $null
    if ($null -ne $PreviousState -and
        $null -ne $PreviousState.PSObject.Properties['yansi_ssh_zaman']) {
        $lastSshMirrorTime = $PreviousState.yansi_ssh_zaman
    }

    return [ordered]@{
        zaman                 = $Now.ToString('o')
        dosya                 = $null
        boyut                 = 0
        ok                    = $false
        hata                  = $null
        yansi                 = $null
        yansi_ssh             = $null
        yansi_ssh_hata        = $null
        yansi_ssh_budama_hata = $null
        yansi_ssh_zaman       = $lastSshMirrorTime
    }
}

# SSH/SCP ortak secenekleri. ConnectTimeout YALNIZ TCP baglantisini kapsar; el sikisma ya da
# oturum asili kalirsa ServerAlive* (5 sn aralik x 2 cevapsiz yoklama = ~10 sn) baglantiyi
# dusurur (2026-10-03: uzak listeleme adimi asili kaldi, 300 sn toplam tavana kadar bekledi).
function Get-SmithBackupSshOptions {
    return @(
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=5',
        '-o', 'ServerAliveCountMax=2'
    )
}

# Adim basina zaman asimi tavani (sn): dosya kopyasi 120, diger kisa uzak komutlar 30.
# Toplam tavan (Invoke-SmithBackupSshMirror -TotalTimeoutSec) ayrica gecerli kalir; adim
# tavani kalan toplam surenin altindaysa o kullanilir.
function Get-SmithBackupStepTimeoutSec {
    param([Parameter(Mandatory = $true)][ValidateSet('copy', 'quick')][string]$Kind)
    if ($Kind -eq 'copy') { return 120 }
    return 30
}

# SSH aynasi BASARILI sonucunu last-backup durumuna yazar. Atomik ad degisimi tamamlandiysa
# ayna basarilidir: yansi_ssh dolar, hata alani temizlenir, son basari zamani guncellenir.
# Budama/listeleme hatasi (Result.PruneError) ayna basarisini BOZMAZ; ayri alanda kalir.
function Set-SmithBackupSshMirrorSuccess {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Result,
        [datetimeoffset]$Now = [datetimeoffset]::Now
    )
    $State.yansi_ssh = $Result.Reference
    $State.yansi_ssh_hata = $null
    $State.yansi_ssh_budama_hata = $Result.PruneError
    $State.yansi_ssh_zaman = $Now.ToString('o')
}

# SSH aynasi BASARISIZ sonucunu yazar; son basarili ayna zamani korunur.
function Set-SmithBackupSshMirrorFailure {
    param(
        [Parameter(Mandatory = $true)]$State,
        [AllowEmptyString()][string]$Message
    )
    $State.yansi_ssh = $null
    $State.yansi_ssh_hata = Get-SmithBackupShortError $Message
    $State.yansi_ssh_budama_hata = $null
}

function Get-SmithBackupShortError {
    param(
        [AllowEmptyString()][string]$Message,
        [ValidateRange(32, 2000)][int]$MaxLength = 240
    )

    $short = ([string]$Message -replace '\s+', ' ').Trim()
    if (-not $short) { return 'bilinmeyen SSH ayna hatasi' }
    if ($short.Length -gt $MaxLength) { return $short.Substring(0, $MaxLength) }
    return $short
}
