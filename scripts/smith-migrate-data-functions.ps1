# smith-migrate-data.ps1'e ozgu yardimcilar. Bu dosya yalniz fonksiyon tanimlar; dot-source
# edildiginde is yapmaz (ag/surec/dosya yan etkisi yok). smith-common.ps1 ONCE yuklenmis
# olmali (Test-SmithMigrationIgnoredName, Get-SmithLegacyDataRoots, Invoke-SmithNative,
# Read-SmithSharedText, Write-SmithJson, $script:SmithMigrationMarker).
#
# Iki iyi bilinen kural burada:
#   - ayni goreli yol iki kaynakta varsa EN YENI kazanir, kaybeden ".<kaynak>-eski" sonekiyle
#     yanina konur (silinmez); tam esitlikte (2 sn) GERCEK kaynak kazanir;
#   - ses izi grubu (speaker\owner.npy, owner.json, owner_adapt.npy) gercek kaynakta kayitliysa
#     DAIMA gercek kaynaktan alinir (kullanicinin son kaydi; paketteki eski uyarlama yeni kaydi
#     bozmasin), paket surumleri ".paket-eski" olarak yedeklenir.
# Kaynaklar HICBIR kosulda silinmez/degistirilmez; hedefte zaten var olan dosyaya dokunulmaz.

# Ses izi grubu: kayit + meta + uyarlama TEK birim (uyarlama kaydin urunu; baska kayitla karismaz).
$script:MigrationOwnerGroup = @('speaker\owner.npy', 'speaker\owner.json', 'speaker\owner_adapt.npy')
# Hedefe kopyalaninca ACL'i yalniz mevcut kullaniciya daraltilan dosyalar (gateway-dev.ps1 deseni).
$script:MigrationSecretFiles = @('session-secret', 'smith.env')
# Iki kaynak arasi zaman farki bu sn'nin altindaysa "ayni an" sayilir (NTFS / WSL hassasiyeti).
$script:MigrationTieSeconds = 2

# --- Yol yardimcilari -------------------------------------------------------------

# Goreli yolu '\' ayiriciya cevirir; mutlak, surucu iceren ya da '..' parcali yolu REDDEDER ($null).
function ConvertTo-SmithMigrationRel([string]$Rel) {
    if ([string]::IsNullOrWhiteSpace($Rel)) { return $null }
    if ($Rel.StartsWith('/') -or $Rel.StartsWith('\') -or $Rel -match '^[A-Za-z]:') { return $null }
    $norm = $Rel.Replace('/', '\')
    if ($norm.StartsWith('.\')) { $norm = $norm.Substring(2) }
    if ($norm.Contains(':')) { return $null }
    foreach ($part in $norm.Split('\')) {
        if ($part -eq '' -or $part -eq '.' -or $part -eq '..') { return $null }
    }
    return $norm
}

# Child, Parent'in icinde ya da Parent'e esit mi (buyuk/kucuk harf duyarsiz, ayirici sinirli).
function Test-SmithPathInside([string]$Child, [string]$Parent) {
    $c = [System.IO.Path]::GetFullPath($Child).TrimEnd('\') + '\'
    $p = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    return $c.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase)
}

# C:\a\b -> /mnt/c/a/b (varsayilan drvfs koku). wslpath varsa Resolve-SmithWslPath onu tercih eder.
function ConvertTo-SmithWslPathPure([string]$WindowsPath) {
    if ($WindowsPath -notmatch '^(?<d>[A-Za-z]):[\\/]*(?<r>.*)$') { throw "Windows yolu degil: $WindowsPath" }
    $rest = $Matches['r'].Replace('\', '/').TrimEnd('/')
    $root = '/mnt/' + $Matches['d'].ToLowerInvariant()
    if ($rest) { return $root + '/' + $rest }
    return $root
}

# --- WSL kosucusu -----------------------------------------------------------------

# wsl.exe -e <komut...> calistirir; { ExitCode, Output, Error, TimedOut } doner. -e: kabuk
# YOK (arguman kacisi sorunu yok). WSL_UTF8: wsl.exe'nin kendi iletileri UTF-8 olsun.
function Invoke-SmithWsl {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$Distro = '',
        [int]$TimeoutSec = 120
    )
    $wsl = Get-Command wsl.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $wsl) { throw 'wsl.exe bulunamadi (gercek kaynak WSL yolundan okunamaz).' }
    $env:WSL_UTF8 = '1'
    $argv = @()
    if ($Distro) { $argv += @('-d', $Distro) }
    $argv += '-e'
    $argv += $Arguments
    return (Invoke-SmithNative -FilePath $wsl.Source -ArgumentList $argv -TimeoutSec $TimeoutSec)
}

# Kok bir WSL yolu mu (mutlak POSIX yolu). Windows yollari (C:\...) degil.
function Test-SmithWslPath([string]$Path) {
    return ($Path.StartsWith('/') -and -not $Path.StartsWith('//'))
}

# Windows yolunun WSL karsiligi: once `wslpath -a -u` (ozel mount kokunu bilir); komut basarisiz
# donerse saf cevirim (/mnt/<surucu>/...). wsl.exe yoksa Invoke-SmithWsl acik hata firlatir.
function Resolve-SmithWslPath {
    param([Parameter(Mandatory = $true)][string]$WindowsPath, [Parameter(Mandatory = $true)][scriptblock]$Runner)
    $r = & $Runner @('wslpath', '-a', '-u', $WindowsPath)
    $text = ([string]$r.Output).Trim()
    if ($r.ExitCode -eq 0 -and $text.StartsWith('/')) { return $text }
    return (ConvertTo-SmithWslPathPure $WindowsPath)
}

# --- Kaynak okuma -----------------------------------------------------------------

# Kaynak tanimi: Label (gercek|paket), Kind (fs|wsl), Root, Runner (yalniz wsl).
function New-SmithMigrationSource {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Root,
        [scriptblock]$Runner
    )
    $kind = 'fs'
    if (Test-SmithWslPath $Root) { $kind = 'wsl' }
    if ($kind -eq 'wsl' -and -not $Runner) { throw "WSL kaynagi ($Root) icin kosucu gerekli." }
    return [pscustomobject]@{ Label = $Label; Kind = $kind; Root = $Root.TrimEnd('/', '\'); Runner = $Runner }
}

# Dosya sistemi kaynagi: baglanti izlenmez; kilit/gecici dosyalar Ignored isaretli doner.
function Get-SmithMigrationFsEntries {
    param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$Label)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return @() }
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $found = New-Object 'System.Collections.Generic.List[object]'
    $stack = New-Object 'System.Collections.Generic.Stack[string]'
    $stack.Push($rootFull)
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        foreach ($item in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
            if ($item.PSIsContainer) { $stack.Push($item.FullName); continue }
            $found.Add([pscustomobject]@{
                    Rel      = $item.FullName.Substring($rootFull.Length).TrimStart('\')
                    Length   = [long]$item.Length
                    MtimeUtc = $item.LastWriteTimeUtc
                    Source   = $Label
                    Ignored  = (Test-SmithMigrationIgnoredName $item.Name)
                })
        }
    }
    return $found.ToArray()
}

# WSL kaynagi: tek `find -printf` cagrisi (salt-okur). Satir: <goreli>\t<boyut>\t<epoch sn>.
# Ayristirilamayan satirlar (ad icinde sekme/satir sonu) ve guvensiz yollar atlanir ve say.
function ConvertFrom-SmithFindOutput {
    param([string]$Text, [Parameter(Mandatory = $true)][string]$Label)
    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    $epoch = [datetime]::new(1970, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)
    $entries = New-Object 'System.Collections.Generic.List[object]'
    $skipped = 0
    foreach ($line in @($Text -split "`n")) {
        $l = $line.TrimEnd("`r")
        if ([string]::IsNullOrWhiteSpace($l)) { continue }
        $f = $l.Split("`t")
        $len = 0L
        $sec = 0.0
        if ($f.Count -ne 3 -or
            -not [long]::TryParse($f[1], [System.Globalization.NumberStyles]::None, $inv, [ref]$len) -or
            -not [double]::TryParse($f[2], [System.Globalization.NumberStyles]::Float, $inv, [ref]$sec)) {
            $skipped++
            continue
        }
        $rel = ConvertTo-SmithMigrationRel $f[0]
        if ($null -eq $rel) { $skipped++; continue }
        $name = $rel.Substring($rel.LastIndexOf('\') + 1)
        $entries.Add([pscustomobject]@{
                Rel      = $rel
                Length   = $len
                MtimeUtc = $epoch.AddSeconds($sec)
                Source   = $Label
                Ignored  = (Test-SmithMigrationIgnoredName $name)
            })
    }
    return [pscustomobject]@{ Entries = $entries.ToArray(); Skipped = $skipped }
}

function Get-SmithMigrationEntries {
    param([Parameter(Mandatory = $true)]$Source)
    if ($Source.Kind -eq 'fs') {
        return [pscustomobject]@{ Entries = @(Get-SmithMigrationFsEntries -Root $Source.Root -Label $Source.Label); Skipped = 0 }
    }
    $r = & $Source.Runner @('find', $Source.Root, '-type', 'f', '-printf', '%P\t%s\t%T@\n')
    if ($r.ExitCode -ne 0) {
        throw ("WSL kaynagi listelenemedi ({0}, exit {1}): {2}" -f $Source.Root, $r.ExitCode, ([string]$r.Error).Trim())
    }
    return (ConvertFrom-SmithFindOutput -Text ([string]$r.Output) -Label $Source.Label)
}

# --- Plan -------------------------------------------------------------------------

function New-SmithMigrationPlanItem {
    param([string]$Action, $Entry, [string]$Dest, [string]$Note = '')
    $label = $null
    if ($Entry) { $label = $Entry.Source }
    return [pscustomobject]@{ Action = $Action; Source = $label; Entry = $Entry; Dest = $Dest; Note = $Note }
}

function ConvertTo-SmithMigrationIndex($Entries) {
    $index = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($e in @($Entries)) {
        if ($e.Ignored) { continue }
        $index[$e.Rel] = $e
    }
    return $index
}

# Girdinin SHA-256'si (buyuk harf hex) ya da $null. Yalniz ayni boyutlu CAKISMALARDA sorulur:
# icerik ayniysa kaybedenin ".<kaynak>-eski" kopyasi gereksizdir (ornek: iki kez inen 27 MB model).
# Okunamayan dosya ($null) muhafazakar yola duser: normal cakisma, ikisi de saklanir.
function Get-SmithMigrationEntryHash {
    param([Parameter(Mandatory = $true)]$Source, [Parameter(Mandatory = $true)]$Entry)
    if ($Source.Kind -eq 'fs') {
        try {
            return (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Source.Root $Entry.Rel) -ErrorAction Stop).Hash
        } catch [System.IO.IOException] {
            return $null
        } catch [System.UnauthorizedAccessException] {
            return $null
        }
    }
    $wsl = $Source.Root + '/' + $Entry.Rel.Replace('\', '/')
    $r = & $Source.Runner @('sha256sum', '--', $wsl)
    if ($r.ExitCode -ne 0) { return $null }
    $first = ([string]$r.Output).Trim().Split(' ')[0]
    if ($first -match '^[0-9a-fA-F]{64}$') { return $first.ToUpperInvariant() }
    return $null
}

# Saf plan: hedef dizinde YALNIZ varlik sorgusu yapar (Test-Path), hicbir sey yazmaz.
# Action: Copy | CopyOld | SkipExists | Ignore. Dest: hedef kokune gore goreli yol.
# -Hasher: { param($Entry) -> SHA-256 | $null } (yalniz ayni boyutlu cakismalarda cagrilir).
function New-SmithMigrationPlan {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()]$RealEntries,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()]$PackageEntries,
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [scriptblock]$Hasher = $null
    )
    $real = ConvertTo-SmithMigrationIndex $RealEntries
    $pkg = ConvertTo-SmithMigrationIndex $PackageEntries
    $items = New-Object 'System.Collections.Generic.List[object]'

    foreach ($e in @($RealEntries) + @($PackageEntries)) {
        if ($e.Ignored) {
            $items.Add((New-SmithMigrationPlanItem -Action 'Ignore' -Entry $e -Dest $e.Rel -Note 'kilit/gecici dosya, kopyalanmaz'))
        }
    }

    $handled = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    # Ses izi grubu: gercek kaynakta KAYIT varsa grup yalniz gercekten gelir.
    if ($real.ContainsKey('speaker\owner.npy')) {
        foreach ($rel in $script:MigrationOwnerGroup) {
            [void]$handled.Add($rel)
            if ($real.ContainsKey($rel)) {
                $items.Add((New-SmithMigrationPlanItem -Action 'Copy' -Entry $real[$rel] -Dest $rel -Note 'daima gercek kaynak (kullanicinin son kaydi)'))
            }
            if ($pkg.ContainsKey($rel)) {
                $note = 'paket surumu yedek (gercek kayit asil)'
                $items.Add((New-SmithMigrationPlanItem -Action 'CopyOld' -Entry $pkg[$rel] -Dest ($rel + '.paket-eski') -Note $note))
            }
        }
    }

    $rels = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($k in $real.Keys) { [void]$rels.Add($k) }
    foreach ($k in $pkg.Keys) { [void]$rels.Add($k) }
    foreach ($rel in @($rels | Sort-Object)) {
        if ($handled.Contains($rel)) { continue }
        $inReal = $real.ContainsKey($rel)
        $inPkg = $pkg.ContainsKey($rel)
        if ($inReal -and -not $inPkg) {
            $items.Add((New-SmithMigrationPlanItem -Action 'Copy' -Entry $real[$rel] -Dest $rel))
            continue
        }
        if ($inPkg -and -not $inReal) {
            $note = ''
            if ($script:MigrationOwnerGroup -contains $rel) { $note = 'gercek kaynakta ses izi kaydi yok: paket kopyasi alinir' }
            $items.Add((New-SmithMigrationPlanItem -Action 'Copy' -Entry $pkg[$rel] -Dest $rel -Note $note))
            continue
        }
        $r = $real[$rel]
        $p = $pkg[$rel]
        $delta = ($r.MtimeUtc - $p.MtimeUtc).TotalSeconds
        if ([math]::Abs($delta) -lt $script:MigrationTieSeconds -and $r.Length -eq $p.Length) {
            $items.Add((New-SmithMigrationPlanItem -Action 'Copy' -Entry $r -Dest $rel -Note 'iki kaynakta ayni (boyut + zaman)'))
            continue
        }
        if ($Hasher -and $r.Length -eq $p.Length) {
            $hashReal = & $Hasher $r
            $hashPackage = & $Hasher $p
            if ($hashReal -and $hashPackage -and $hashReal -ceq $hashPackage) {
                $items.Add((New-SmithMigrationPlanItem -Action 'Copy' -Entry $r -Dest $rel -Note 'iki kaynakta ayni icerik (SHA-256)'))
                continue
            }
        }
        # Gercek kaynak, paketten en fazla (tie) sn eski olsa da kazanir: esitlikte gercek.
        if ($delta -gt (-1 * $script:MigrationTieSeconds)) { $winner = $r; $loser = $p } else { $winner = $p; $loser = $r }
        $why = 'kazanan {0} {1:yyyy-MM-dd HH:mm:ss}Z, eski {2} {3:yyyy-MM-dd HH:mm:ss}Z' -f $winner.Source, $winner.MtimeUtc, $loser.Source, $loser.MtimeUtc
        $items.Add((New-SmithMigrationPlanItem -Action 'Copy' -Entry $winner -Dest $rel -Note ('cakisma: ' + $why)))
        $items.Add((New-SmithMigrationPlanItem -Action 'CopyOld' -Entry $loser -Dest ('{0}.{1}-eski' -f $rel, $loser.Source) -Note ('cakisma: ' + $why)))
    }

    # Hedefte zaten var olan yola ASLA dokunulmaz; rapor edilir.
    $final = New-Object 'System.Collections.Generic.List[object]'
    foreach ($it in $items) {
        if ($it.Action -in @('Copy', 'CopyOld') -and (Test-Path -LiteralPath (Join-Path $TargetRoot $it.Dest))) {
            $final.Add((New-SmithMigrationPlanItem -Action 'SkipExists' -Entry $it.Entry -Dest $it.Dest -Note 'hedefte zaten var; dokunulmadi'))
        } else {
            $final.Add($it)
        }
    }
    # Bastaki virgul SART: bos plan $null'a acilmasin (Mandatory -Plan bos diziyi/null'u reddeder).
    return , @($final | Sort-Object @{ Expression = { $_.Dest.ToLowerInvariant() } }, Action)
}

function Format-SmithMigrationSize([long]$Bytes) {
    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    if ($Bytes -ge 1MB) { return ($Bytes / 1MB).ToString('0.0', $inv) + ' MB' }
    if ($Bytes -ge 1KB) { return ($Bytes / 1KB).ToString('0.0', $inv) + ' KB' }
    return "$Bytes B"
}

# Tek plan satiri (SAF ASCII). Prefix: PLAN | YAZILDI | HATA.
function Format-SmithMigrationLine {
    param([Parameter(Mandatory = $true)]$Item, [string]$Prefix = 'PLAN', [string]$Extra = '')
    $label = @{ Copy = 'KOPYALA'; CopyOld = 'ESKI'; SkipExists = 'ATLA'; Ignore = 'YOKSAY' }[$Item.Action]
    $src = '-'
    $detail = ''
    if ($Item.Entry) {
        $src = $Item.Source
        $detail = '({0}, {1:yyyy-MM-dd HH:mm:ss}Z)' -f (Format-SmithMigrationSize $Item.Entry.Length), $Item.Entry.MtimeUtc
    }
    $line = '[{0}] {1,-8} {2,-7} {3} {4}' -f $Prefix, $label, $src, $Item.Dest, $detail
    if ($Item.Note) { $line += '  # ' + $Item.Note }
    if ($Extra) { $line += '  ' + $Extra }
    return $line.TrimEnd()
}

# --- Uygulama ---------------------------------------------------------------------

# Dosyanin ACL'ini yalniz mevcut kullaniciya daraltir (gateway-dev.ps1 session-secret deseni).
function Set-SmithSecretFileAcl([string]$Path) {
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $Path /inheritance:r /grant:r "*${sid}:(R,W)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls basarisiz (exit $LASTEXITCODE)" }
}

# Tek dosyayi hedefe kopyalar: once <hedef>.migrate-part, boyut dogrulamasi, sonra YERINE ad
# degisimi (var olani EZMEZ). Kaynak degistirilmez. Dest: tam hedef yolu.
function Copy-SmithMigrationFile {
    param(
        [Parameter(Mandatory = $true)]$Source,
        [Parameter(Mandatory = $true)]$Entry,
        [Parameter(Mandatory = $true)][string]$Dest,
        [string]$TargetWslRoot = '',
        [string]$TargetRoot = ''
    )
    $part = $Dest + '.migrate-part'
    $dir = Split-Path -Parent $Dest
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }

    if ($Source.Kind -eq 'fs') {
        $srcPath = Join-Path $Source.Root $Entry.Rel
        [System.IO.File]::Copy($srcPath, $part, $false)
    } else {
        $srcWsl = $Source.Root + '/' + $Entry.Rel.Replace('\', '/')
        $relDest = $Dest.Substring($TargetRoot.TrimEnd('\').Length).TrimStart('\')
        $dstWsl = $TargetWslRoot.TrimEnd('/') + '/' + $relDest.Replace('\', '/') + '.migrate-part'
        $r = & $Source.Runner @('cp', '-p', '--', $srcWsl, $dstWsl)
        if ($r.ExitCode -ne 0) {
            throw ("WSL kopyalama basarisiz (exit {0}): {1}" -f $r.ExitCode, ([string]$r.Error).Trim())
        }
    }

    # Kaynak kopya sirasinda buyumus olabilir (calisan surecin logu): eksik kopya hatadir, fazlasi degil.
    $copied = (Get-Item -LiteralPath $part).Length
    if ($copied -lt $Entry.Length) {
        Remove-Item -LiteralPath $part -Force
        throw ("boyut uyusmuyor (beklenen en az {0} bayt, kopya {1} bayt)" -f $Entry.Length, $copied)
    }
    [System.IO.File]::Move($part, $Dest)
    [System.IO.File]::SetLastWriteTimeUtc($Dest, $Entry.MtimeUtc)
}

# Plani sirayla uygular (-Apply) ya da yalniz yazar (varsayilan). Her oge icin bir satir
# $Emit'e verilir. Hata bir dosyada digerlerini durdurmaz. Sonuc: Sayimlar + Hatalar.
function Invoke-SmithMigrationPlan {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()]$Plan,
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)]$Sources,
        [switch]$Apply,
        [string]$TargetWslRoot = '',
        [scriptblock]$Emit = { param($Text) Write-Host $Text }
    )
    $counts = [ordered]@{ Kopyalanan = 0; EskiYedek = 0; Atlanan = 0; Yoksayilan = 0; Hata = 0; Bayt = [long]0 }
    $errors = New-Object 'System.Collections.Generic.List[string]'
    foreach ($item in @($Plan)) {
        if ($item.Action -eq 'SkipExists') {
            $counts.Atlanan++
            & $Emit (Format-SmithMigrationLine -Item $item -Prefix 'PLAN')
            continue
        }
        if ($item.Action -eq 'Ignore') {
            $counts.Yoksayilan++
            & $Emit (Format-SmithMigrationLine -Item $item -Prefix 'PLAN')
            continue
        }
        if (-not $Apply) {
            & $Emit (Format-SmithMigrationLine -Item $item -Prefix 'PLAN')
            if ($item.Action -eq 'Copy') { $counts.Kopyalanan++ } else { $counts.EskiYedek++ }
            $counts.Bayt += $item.Entry.Length
            continue
        }
        $dest = Join-Path $TargetRoot $item.Dest
        try {
            Copy-SmithMigrationFile -Source $Sources[$item.Source] -Entry $item.Entry -Dest $dest -TargetWslRoot $TargetWslRoot -TargetRoot $TargetRoot
            if ($script:MigrationSecretFiles -contains $item.Dest) {
                try {
                    Set-SmithSecretFileAcl $dest
                } catch {
                    Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
                    throw ("gizli dosyanin ACL'i daraltilamadi, kopya geri alindi: " + $_.Exception.Message)
                }
            }
            if ($item.Action -eq 'Copy') { $counts.Kopyalanan++ } else { $counts.EskiYedek++ }
            $counts.Bayt += $item.Entry.Length
            & $Emit (Format-SmithMigrationLine -Item $item -Prefix 'YAZILDI')
        } catch {
            $counts.Hata++
            $msg = ([string]$_.Exception.Message -replace '\s+', ' ').Trim()
            $errors.Add(('{0}: {1}' -f $item.Dest, $msg))
            & $Emit (Format-SmithMigrationLine -Item $item -Prefix 'HATA' -Extra ('! ' + $msg))
        }
    }
    return [pscustomobject]@{ Sayimlar = $counts; Hatalar = $errors.ToArray() }
}

# Tasima isaretini yazar: varligi "eski konumdaki veri icin karar verildi" demektir ve
# acilis uyarisini susturur. YALNIZ hatasiz -Apply sonunda yazilir.
function Write-SmithMigrationMarker {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)]$Result,
        [Parameter(Mandatory = $true)]$SourceRoots
    )
    $doc = [ordered]@{
        zaman      = (Get-Date -Format 'o')
        kaynaklar  = $SourceRoots
        kopyalanan = $Result.Sayimlar.Kopyalanan
        eskiYedek  = $Result.Sayimlar.EskiYedek
        atlanan    = $Result.Sayimlar.Atlanan
        betik      = 'scripts\smith-migrate-data.ps1'
    }
    Write-SmithJson -Path (Join-Path $TargetRoot $script:SmithMigrationMarker) -Object $doc
}
