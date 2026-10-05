# smith-migrate-data.ps1 ve yardimcilari icin kendi kendine yeten sinama betigi.
#
# GUVENLIK: yalniz %TEMP% altindaki tekil gecici klasorde calisir. Tasima betigi HER cagrida
# acik -RealRoot / -PackageRoot / -Target gecici dizinleriyle kosulur (varsayilan GERCEK
# konumlara hic bakilmaz) ve SMITH_DATA_DIR da gecici dizine cevrilir. WSL kaynagi SAHTE
# kosucuyla (gecici dizine eslenen sahte find/cp/sha256sum/wslpath) sinanir: wsl.exe cagrilmaz.
#
# Kapsam: en yeni kazanir + .<kaynak>-eski, ses izi grubu daima gercekten, hedefte var olana
# dokunmama, DryRun hicbir sey yazmaz, Apply kaynaklari degistirmez/silmez ve tekrar kosulabilir,
# hata durumunda isaret yazilmaz, guvenlik korumalari, WSL ayristirma + uc uca sahte WSL akisi.
#
# Kullanim (iki kabukta da yesil olmali):
#   powershell.exe -NoProfile -File scripts\smith-migrate-data-test.ps1
#   pwsh -NoProfile -File scripts\smith-migrate-data-test.ps1
# Cikis: 0 = hepsi gecti, 1 = en az bir sinama kaldi.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'smith-common.ps1')
. (Join-Path $PSScriptRoot 'smith-migrate-data-functions.ps1')
. (Join-Path $PSScriptRoot 'powershell-test-helpers.ps1')

Initialize-SmithTestRun
$script:SmithLegacyNoticeDone = $true

$tempRoot = [System.IO.Path]::GetTempPath()
$work = Join-Path $tempRoot ('smith-migrate-test-{0}-{1}' -f $PID, [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$prevDataDir = $env:SMITH_DATA_DIR
$prevLocal = $env:LOCALAPPDATA
$env:SMITH_DATA_DIR = Join-Path $work 'varsayilan-kok-korumasi'
$base = [datetime]::new(2026, 10, 3, 12, 0, 0, [System.DateTimeKind]::Utc)
$caseNo = 0

# Yeni vaka dizini: real / pkg / target (target OLUSTURULMAZ).
function New-CaseDirs {
    $script:caseNo++
    $dir = Join-Path $work ('vaka{0:00}' -f $script:caseNo)
    $d = [pscustomobject]@{ Real = (Join-Path $dir 'real'); Pkg = (Join-Path $dir 'pkg'); Target = (Join-Path $dir 'target') }
    New-Item -ItemType Directory -Force -Path $d.Real, $d.Pkg | Out-Null
    return $d
}

# Dosya yazar: rel ('a\b.txt'), icerik, mtime = base - AgeSec.
function New-SrcFile([string]$Root, [string]$Rel, [string]$Content, [double]$AgeSec = 0) {
    $path = Join-Path $Root $Rel
    $parent = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [System.IO.File]::WriteAllText($path, $Content)
    [System.IO.File]::SetLastWriteTimeUtc($path, $base.AddSeconds(-$AgeSec))
    return $path
}

function Get-TreeSnapshot([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root)) { return '' }
    $rows = Get-ChildItem -LiteralPath $Root -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
        '{0}|{1}|{2}' -f $_.FullName.Substring($Root.Length), (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash, $_.LastWriteTimeUtc.Ticks
    }
    return ($rows -join "`n")
}

function Get-PlanRows($Plan) {
    return @($Plan | ForEach-Object { '{0}|{1}|{2}' -f $_.Action, $_.Source, $_.Dest })
}

function New-Plan($Case, [scriptblock]$Hasher = $null) {
    $realSrc = New-SmithMigrationSource -Label 'gercek' -Root $Case.Real
    $pkgSrc = New-SmithMigrationSource -Label 'paket' -Root $Case.Pkg
    $re = (Get-SmithMigrationEntries -Source $realSrc).Entries
    $pe = (Get-SmithMigrationEntries -Source $pkgSrc).Entries
    return (New-SmithMigrationPlan -RealEntries $re -PackageEntries $pe -TargetRoot $Case.Target -Hasher $Hasher)
}

# Tasima betigini gecici dizinlerle ve gecici SMITH_DATA_DIR ile ayri surecte kosar.
function Invoke-Migrate($Case, [string[]]$Extra = @()) {
    $exe = (Get-Process -Id $PID).Path
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'smith-migrate-data.ps1'),
        '-RealRoot', $Case.Real, '-PackageRoot', $Case.Pkg, '-Target', $Case.Target) + $Extra
    return (Invoke-SmithNative -FilePath $exe -ArgumentList $argv -TimeoutSec 180)
}

try {

    Invoke-Case 'Plan: tek kaynakli dosya kopyalanir; en yeni kazanir, kaybeden .<kaynak>-eski' {
        $c = New-CaseDirs
        New-SrcFile $c.Real 'window.json' 'gercek-eski-surum' 6000 | Out-Null     # gercek eski
        New-SrcFile $c.Pkg 'window.json' 'paket-yeni' 300 | Out-Null              # paket yeni
        New-SrcFile $c.Real 'logs\a.log' 'gercek-yeni' 600 | Out-Null             # gercek yeni
        New-SrcFile $c.Pkg 'logs\a.log' 'paket-eski-uzun' 3600 | Out-Null         # paket eski
        New-SrcFile $c.Real 'yalniz-gercek.txt' 'g' 10 | Out-Null
        New-SrcFile $c.Pkg 'alt\yalniz-paket.txt' 'p' 10 | Out-Null
        $rows = Get-PlanRows (New-Plan $c)
        Assert-SetEqual 'plan satirlari' $rows @(
            'Copy|paket|window.json', 'CopyOld|gercek|window.json.gercek-eski',
            'Copy|gercek|logs\a.log', 'CopyOld|paket|logs\a.log.paket-eski',
            'Copy|gercek|yalniz-gercek.txt', 'Copy|paket|alt\yalniz-paket.txt')
    }

    Invoke-Case 'Plan: 2 sn icinde esitlikte GERCEK kazanir; boyut+zaman ayniysa tek kopya' {
        $c = New-CaseDirs
        New-SrcFile $c.Real 'x.json' 'bes--' 100 | Out-Null          # 5 bayt
        New-SrcFile $c.Pkg 'x.json' 'alti---' 99 | Out-Null          # 7 bayt, 1 sn yeni -> esitlik
        New-SrcFile $c.Real 'ayni.json' 'dort' 100 | Out-Null
        New-SrcFile $c.Pkg 'ayni.json' 'dort' 99 | Out-Null          # ayni boyut, 1 sn fark -> ayni say
        New-SrcFile $c.Real 'sinir.json' 'a' 100 | Out-Null
        New-SrcFile $c.Pkg 'sinir.json' 'bb' 97 | Out-Null           # paket 3 sn yeni -> paket kazanir
        Assert-SetEqual 'esitlik/ayni/sinir' (Get-PlanRows (New-Plan $c)) @(
            'Copy|gercek|x.json', 'CopyOld|paket|x.json.paket-eski',
            'Copy|gercek|ayni.json',
            'Copy|paket|sinir.json', 'CopyOld|gercek|sinir.json.gercek-eski')
    }

    Invoke-Case 'Plan: ayni boyutta ayni icerik (SHA-256) tek kopya, farkli icerik cakisma' {
        $c = New-CaseDirs
        New-SrcFile $c.Real 'model.bin' 'AYNI-ICERIK-12345' 7200 | Out-Null
        New-SrcFile $c.Pkg 'model.bin' 'AYNI-ICERIK-12345' 60 | Out-Null          # ayni bayt, farkli zaman
        New-SrcFile $c.Real 'fark.bin' 'ICERIK-A-12345' 7200 | Out-Null
        New-SrcFile $c.Pkg 'fark.bin' 'ICERIK-B-12345' 60 | Out-Null              # ayni boyut, farkli bayt
        $realSrc = New-SmithMigrationSource -Label 'gercek' -Root $c.Real
        $pkgSrc = New-SmithMigrationSource -Label 'paket' -Root $c.Pkg
        $srcs = @{ gercek = $realSrc; paket = $pkgSrc }
        $hasher = { param($Entry) Get-SmithMigrationEntryHash -Source $srcs[$Entry.Source] -Entry $Entry }
        Assert-SetEqual 'hash ile' (Get-PlanRows (New-Plan $c $hasher)) @(
            'Copy|gercek|model.bin',
            'Copy|paket|fark.bin', 'CopyOld|gercek|fark.bin.gercek-eski')
        Assert-SetEqual 'hash olmadan ikisi de cakisma' (Get-PlanRows (New-Plan $c)) @(
            'Copy|paket|model.bin', 'CopyOld|gercek|model.bin.gercek-eski',
            'Copy|paket|fark.bin', 'CopyOld|gercek|fark.bin.gercek-eski')
        $h = Get-SmithMigrationEntryHash -Source $realSrc -Entry ((Get-SmithMigrationEntries -Source $realSrc).Entries | Where-Object { $_.Rel -eq 'model.bin' })
        Assert-True 'hash SHA-256 buyuk harf hex' ($h -cmatch '^[0-9A-F]{64}$') "$h"
    }

    Invoke-Case 'Plan: ses izi grubu gercek kayitliysa DAIMA gercek (paket daha yeni olsa da)' {
        $c = New-CaseDirs
        New-SrcFile $c.Real 'speaker\owner.npy' 'GERCEK-KAYIT' 90000 | Out-Null
        New-SrcFile $c.Real 'speaker\owner.json' '{"g":1}' 90000 | Out-Null
        New-SrcFile $c.Pkg 'speaker\owner.npy' 'PAKET-ESKI-KAYIT-DAHA-YENI' 10 | Out-Null
        New-SrcFile $c.Pkg 'speaker\owner.json' '{"p":2}' 10 | Out-Null
        New-SrcFile $c.Pkg 'speaker\owner_adapt.npy' 'ESKI-UYARLAMA' 5 | Out-Null     # yalniz pakette
        New-SrcFile $c.Pkg 'speaker\verify-log.jsonl' 'x' 5 | Out-Null                # grup disi: normal
        Assert-SetEqual 'grup yalniz gercekten' (Get-PlanRows (New-Plan $c)) @(
            'Copy|gercek|speaker\owner.npy', 'CopyOld|paket|speaker\owner.npy.paket-eski',
            'Copy|gercek|speaker\owner.json', 'CopyOld|paket|speaker\owner.json.paket-eski',
            'CopyOld|paket|speaker\owner_adapt.npy.paket-eski',
            'Copy|paket|speaker\verify-log.jsonl')
    }

    Invoke-Case 'Plan: gercek kaynakta ses izi kaydi yoksa paket kopyasi alinir' {
        $c = New-CaseDirs
        New-SrcFile $c.Pkg 'speaker\owner.npy' 'PAKET-KAYIT' 10 | Out-Null
        New-SrcFile $c.Pkg 'speaker\owner_adapt.npy' 'PAKET-UYARLAMA' 10 | Out-Null
        New-SrcFile $c.Real 'speaker\owner.json' '{"g":1}' 10 | Out-Null    # kayit (npy) yok -> grup normal akis
        Assert-SetEqual 'normal akis' (Get-PlanRows (New-Plan $c)) @(
            'Copy|paket|speaker\owner.npy', 'Copy|paket|speaker\owner_adapt.npy', 'Copy|gercek|speaker\owner.json')
    }

    Invoke-Case 'Plan: kilit/gecici dosyalar kopyalanmaz (YOKSAY satiri), hedefte var olana dokunulmaz' {
        $c = New-CaseDirs
        New-SrcFile $c.Real 'smith-up.lock' '' 5 | Out-Null
        New-SrcFile $c.Real 'x.tmp' 'a' 5 | Out-Null
        New-SrcFile $c.Real 'y.migrate-part' 'a' 5 | Out-Null
        New-SrcFile $c.Real 'var.json' 'gercek' 100 | Out-Null
        New-SrcFile $c.Pkg 'var.json' 'paket' 10 | Out-Null
        New-SrcFile $c.Real 'yeni.json' 'g' 100 | Out-Null
        New-Item -ItemType Directory -Force -Path $c.Target | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $c.Target 'var.json'), 'HEDEF-KALIR')
        [System.IO.File]::WriteAllText((Join-Path $c.Target 'var.json.gercek-eski'), 'HEDEF-ESKI-KALIR')
        $rows = Get-PlanRows (New-Plan $c)
        Assert-SetEqual 'plan' $rows @(
            'Ignore|gercek|smith-up.lock', 'Ignore|gercek|x.tmp', 'Ignore|gercek|y.migrate-part',
            'SkipExists|paket|var.json', 'SkipExists|gercek|var.json.gercek-eski', 'Copy|gercek|yeni.json')
    }

    Invoke-Case 'DryRun (varsayilan): hicbir sey yazmaz, hedef olusturmaz, kaynak degismez' {
        $c = New-CaseDirs
        New-SrcFile $c.Real 'a.json' 'gercek' 100 | Out-Null
        New-SrcFile $c.Real 'speaker\owner.npy' 'kayit' 100 | Out-Null
        New-SrcFile $c.Pkg 'a.json' 'paket' 10 | Out-Null
        New-SrcFile $c.Pkg 'logs\b.log' 'log' 10 | Out-Null
        $before = (Get-TreeSnapshot $c.Real) + '#' + (Get-TreeSnapshot $c.Pkg)
        $r = Invoke-Migrate $c
        Assert-True 'cikis 0' ($r.ExitCode -eq 0 -and -not $r.TimedOut) "exit $($r.ExitCode): $($r.Output) $($r.Error)"
        Assert-True 'hedef dizin olusturulmadi' (-not (Test-Path -LiteralPath $c.Target))
        Assert-True 'kaynaklar ayni (icerik + zaman)' ($before -ceq ((Get-TreeSnapshot $c.Real) + '#' + (Get-TreeSnapshot $c.Pkg)))
        Assert-True 'her dosya icin plan satiri' ($r.Output -match '\[PLAN\] KOPYALA\s+gercek\s+speaker\\owner\.npy' -and $r.Output -match '\[PLAN\] ESKI\s+gercek\s+a\.json\.gercek-eski' -and $r.Output -match '\[PLAN\] KOPYALA\s+paket\s+logs\\b\.log')
        Assert-True 'DryRun bildirimi' ($r.Output -match 'DryRun: hicbir dosya yazilmadi')
        Assert-True 'isaret yok' (-not (Test-Path -LiteralPath (Join-Path $c.Target $script:SmithMigrationMarker)))
    }

    Invoke-Case 'Apply: kopyalar (zaman korunur), kaynaklar degismez/silinmez, isaret yazilir, tekrar kosulabilir' {
        $c = New-CaseDirs
        New-SrcFile $c.Real 'window.json' 'gercek-eski' 6000 | Out-Null
        New-SrcFile $c.Pkg 'window.json' 'paket-yeni' 300 | Out-Null
        New-SrcFile $c.Real 'speaker\owner.npy' 'GERCEK-KAYIT' 9000 | Out-Null
        New-SrcFile $c.Pkg 'speaker\owner.npy' 'PAKET-DAHA-YENI' 5 | Out-Null
        New-SrcFile $c.Pkg 'logs\gateway-20261003.log' 'log-satiri' 50 | Out-Null
        New-SrcFile $c.Pkg 'session-secret' 'GIZLI-DEGER-SAHTE-ORNEK-0123456789abcdef' 50 | Out-Null
        New-SrcFile $c.Pkg 'smith-up.lock' '' 50 | Out-Null
        $before = (Get-TreeSnapshot $c.Real) + '#' + (Get-TreeSnapshot $c.Pkg)

        $r = Invoke-Migrate $c @('-Apply')
        Assert-True 'cikis 0' ($r.ExitCode -eq 0 -and -not $r.TimedOut) "exit $($r.ExitCode): $($r.Output) $($r.Error)"
        $t = $c.Target
        Assert-True 'kazanan (paket yeni) hedefte, eski (gercek) .gercek-eski' (
            ([System.IO.File]::ReadAllText((Join-Path $t 'window.json')) -ceq 'paket-yeni') -and
            ([System.IO.File]::ReadAllText((Join-Path $t 'window.json.gercek-eski')) -ceq 'gercek-eski'))
        Assert-True 'ses izi daima gercek, paket .paket-eski' (
            ([System.IO.File]::ReadAllText((Join-Path $t 'speaker\owner.npy')) -ceq 'GERCEK-KAYIT') -and
            ([System.IO.File]::ReadAllText((Join-Path $t 'speaker\owner.npy.paket-eski')) -ceq 'PAKET-DAHA-YENI'))
        Assert-True 'alt dizin + log kopyalandi' ([System.IO.File]::ReadAllText((Join-Path $t 'logs\gateway-20261003.log')) -ceq 'log-satiri')
        Assert-True 'zaman damgasi korundu (kazanan paket 300 sn once)' (
            ([System.IO.File]::GetLastWriteTimeUtc((Join-Path $t 'window.json')) - $base.AddSeconds(-300)).TotalSeconds -lt 1 -and
            ([System.IO.File]::GetLastWriteTimeUtc((Join-Path $t 'window.json')) - $base.AddSeconds(-300)).TotalSeconds -gt -1)
        Assert-True 'kilit dosyasi kopyalanmadi' (-not (Test-Path -LiteralPath (Join-Path $t 'smith-up.lock')))
        Assert-True 'gecici .migrate-part artigi yok' (@(Get-ChildItem -LiteralPath $t -Recurse -File -Filter '*.migrate-part').Count -eq 0)
        Assert-True 'kaynaklar DEGISMEDI (icerik + zaman, hicbir dosya silinmedi)' ($before -ceq ((Get-TreeSnapshot $c.Real) + '#' + (Get-TreeSnapshot $c.Pkg)))
        $marker = Join-Path $t $script:SmithMigrationMarker
        Assert-True 'tasima isareti yazildi (JSON)' ((Test-Path -LiteralPath $marker) -and ((Read-SmithJson $marker).kopyalanan -ge 4))
        Assert-True 'cikti [YAZILDI] satirlari tasir' ($r.Output -match '\[YAZILDI\] KOPYALA\s+paket\s+window\.json')

        if ($env:OS -eq 'Windows_NT') {
            $acl = Get-Acl -LiteralPath (Join-Path $t 'session-secret')
            Assert-True 'session-secret ACL: miras kapali (yalniz mevcut kullanici)' ($acl.AreAccessRulesProtected -and @($acl.Access).Count -eq 1) "kural sayisi: $(@($acl.Access).Count)"
        }

        # Tekrar kosu: her sey hedefte var -> hicbir dosya yazilmaz, hata yok.
        $snapT = Get-TreeSnapshot $t
        $r2 = Invoke-Migrate $c @('-Apply')
        Assert-True 'ikinci kosu cikis 0, 0 dosya yazildi' ($r2.ExitCode -eq 0 -and $r2.Output -match 'OZET: 0 dosya yazildi \(0 B\), 0 eski-yedek') "exit $($r2.ExitCode): $($r2.Output)"
        Assert-True 'ikinci kosu hedefi degistirmedi (isaret zamani haric)' (
            ((Get-TreeSnapshot $t) -replace '(?m)^.*veri-koku-tasindi.*$\n?', '') -ceq ($snapT -replace '(?m)^.*veri-koku-tasindi.*$\n?', ''))
    }

    Invoke-Case 'Apply: hedefte var olan dosya EZILMEZ' {
        $c = New-CaseDirs
        New-SrcFile $c.Real 'health.json' 'gercek' 100 | Out-Null
        New-SrcFile $c.Real 'yeni.txt' 'yeni' 100 | Out-Null
        New-Item -ItemType Directory -Force -Path $c.Target | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $c.Target 'health.json'), 'YENI-KOKTE-URETILEN')
        $r = Invoke-Migrate $c @('-Apply')
        Assert-True 'cikis 0' ($r.ExitCode -eq 0) "exit $($r.ExitCode): $($r.Output)"
        Assert-True 'var olan dosya aynen kaldi' ([System.IO.File]::ReadAllText((Join-Path $c.Target 'health.json')) -ceq 'YENI-KOKTE-URETILEN')
        Assert-True 'yeni dosya kopyalandi' ([System.IO.File]::ReadAllText((Join-Path $c.Target 'yeni.txt')) -ceq 'yeni')
        Assert-True 'ATLA satiri raporlandi' ($r.Output -match '\[PLAN\] ATLA\s+gercek\s+health\.json')
    }

    Invoke-Case 'Apply: bir dosya kopyalanamazsa digerleri surer, ISARET YAZILMAZ, cikis 1' {
        $c = New-CaseDirs
        New-SrcFile $c.Pkg 'iyi.txt' 'iyi' 10 | Out-Null
        $locked = New-SrcFile $c.Pkg 'kilitli.txt' 'kilitli' 10 | Out-Null
        $lockPath = Join-Path $c.Pkg 'kilitli.txt'
        $hold = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        try {
            $r = Invoke-Migrate $c @('-Apply')
        } finally { $hold.Dispose() }
        Assert-True 'cikis 1' ($r.ExitCode -eq 1) "exit $($r.ExitCode): $($r.Output) $($r.Error)"
        Assert-True 'saglam dosya yine kopyalandi' (Test-Path -LiteralPath (Join-Path $c.Target 'iyi.txt'))
        Assert-True 'HATA satiri + nedeni' ($r.Output -match '\[HATA\]\s+KOPYALA\s+paket\s+kilitli\.txt')
        Assert-True 'isaret yazilmadi (uyari surer)' (-not (Test-Path -LiteralPath (Join-Path $c.Target $script:SmithMigrationMarker)))
        Assert-True 'kismi dosya/artik yok' (-not (Test-Path -LiteralPath (Join-Path $c.Target 'kilitli.txt')) -and @(Get-ChildItem -LiteralPath $c.Target -Recurse -File -Filter '*.migrate-part').Count -eq 0)
        # Kilit kalkinca betik tekrar calisir: biten atlanir, kalan kopyalanir, isaret yazilir.
        $r2 = Invoke-Migrate $c @('-Apply')
        Assert-True 'ikinci kosu basarili ve tamamlar' ($r2.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $c.Target 'kilitli.txt')) -and (Test-Path -LiteralPath (Join-Path $c.Target $script:SmithMigrationMarker))) "exit $($r2.ExitCode): $($r2.Output)"
    }

    Invoke-Case 'Apply: iki kaynak da bossa yalniz isaret yazilir; kaynaklar yoksa DryRun yine 0' {
        $c = New-CaseDirs
        $r = Invoke-Migrate $c @('-Apply')
        Assert-True 'bos Apply: cikis 0, 0 dosya, isaret var' ($r.ExitCode -eq 0 -and $r.Output -match 'OZET: 0 dosya yazildi' -and (Test-Path -LiteralPath (Join-Path $c.Target $script:SmithMigrationMarker))) "exit $($r.ExitCode): $($r.Output)"
        $c2 = New-CaseDirs
        Remove-Item -LiteralPath $c2.Real, $c2.Pkg -Recurse -Force
        $r2 = Invoke-Migrate $c2
        Assert-True 'kaynak dizinler yokken DryRun 0 ve uyarir' ($r2.ExitCode -eq 0 -and ($r2.Output + $r2.Error) -match 'kaynak yok') "exit $($r2.ExitCode): $($r2.Output) $($r2.Error)"
        Assert-True 'DryRun hedefi olusturmadi' (-not (Test-Path -LiteralPath $c2.Target))
    }

    Invoke-Case 'Isaret acilis uyarisini susturur (uyari -> Apply -> sessiz)' {
        $c = New-CaseDirs
        New-SrcFile $c.Real 'speaker\owner.npy' 'kayit' 100 | Out-Null
        $roots = @([pscustomobject]@{ Label = 'gercek'; Path = $c.Real }, [pscustomobject]@{ Label = 'paket'; Path = $c.Pkg })
        Assert-True 'tasima oncesi uyari var' ($null -ne (Get-SmithLegacyDataNotice -DataDir $c.Target -LegacyRoots $roots))
        $r = Invoke-Migrate $c @('-Apply')
        Assert-True 'Apply basarili' ($r.ExitCode -eq 0) "exit $($r.ExitCode): $($r.Output)"
        Assert-True 'tasima sonrasi uyari yok' ($null -eq (Get-SmithLegacyDataNotice -DataDir $c.Target -LegacyRoots $roots))
    }

    Invoke-Case 'Guvenlik: hedef kaynakla ic ice ya da eski (AppData tabanli) konum olamaz' {
        $c = New-CaseDirs
        New-SrcFile $c.Real 'a.txt' 'x' 10 | Out-Null
        $exe = (Get-Process -Id $PID).Path
        $script = Join-Path $PSScriptRoot 'smith-migrate-data.ps1'
        $inside = Invoke-SmithNative -FilePath $exe -TimeoutSec 120 -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script, '-RealRoot', $c.Real, '-PackageRoot', $c.Pkg, '-Target', (Join-Path $c.Real 'alt'))
        Assert-True 'hedef kaynagin icinde: reddedilir (cikis 1, yazma yok)' ($inside.ExitCode -ne 0 -and ($inside.Output + $inside.Error) -match 'ic ice' -and -not (Test-Path -LiteralPath (Join-Path $c.Real 'alt'))) "exit $($inside.ExitCode): $($inside.Error)"
        $parent = Invoke-SmithNative -FilePath $exe -TimeoutSec 120 -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script, '-RealRoot', $c.Real, '-PackageRoot', $c.Pkg, '-Target', (Split-Path -Parent $c.Real))
        Assert-True 'hedef kaynagin ustu: reddedilir' ($parent.ExitCode -ne 0 -and ($parent.Output + $parent.Error) -match 'ic ice') "exit $($parent.ExitCode): $($parent.Error)"

        # Eski konum: LocalAppData'yi gecici dizine cevir; hedef <LocalAppData>\smith altinda -> RED.
        $fakeLocal = Join-Path $work 'sahte-localappdata'
        $env:LOCALAPPDATA = $fakeLocal
        try {
            $legacyTarget = Join-Path $fakeLocal 'smith\yeni'
            $r = Invoke-SmithNative -FilePath $exe -TimeoutSec 120 -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script, '-RealRoot', $c.Real, '-PackageRoot', $c.Pkg, '-Target', $legacyTarget)
            Assert-True 'hedef eski konumun icinde: reddedilir' ($r.ExitCode -ne 0 -and ($r.Output + $r.Error) -match 'eski \(AppData tabanli\)' -and -not (Test-Path -LiteralPath $legacyTarget)) "exit $($r.ExitCode): $($r.Error)"
        } finally { $env:LOCALAPPDATA = $prevLocal }

        $both = Invoke-SmithNative -FilePath $exe -TimeoutSec 120 -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script, '-RealRoot', $c.Real, '-PackageRoot', $c.Pkg, '-Target', $c.Target, '-Apply', '-DryRun')
        Assert-True '-Apply ile -DryRun birlikte verilemez' ($both.ExitCode -ne 0 -and ($both.Output + $both.Error) -match 'birlikte verilemez')
    }

    Invoke-Case 'WSL: find ciktisi ayristirilir (goreli yol, boyut, UTC zaman); guvensiz/bozuk satirlar atlanir' {
        $text = ("logs/a.log`t120`t1790000000.5000000000`n" +
            "speaker/owner.npy`t7040`t1790001234.0000000000`r`n" +
            "kilit.lock`t0`t1790000000.0`n" +
            "bozuk-satir-sekmesiz`n" +
            "../disari.txt`t5`t1790000000.0`n" +
            "/mutlak.txt`t5`t1790000000.0`n" +
            "C:evil.txt`t5`t1790000000.0`n" +
            "sayi-degil.txt`tabc`t1790000000.0`n")
        $p = ConvertFrom-SmithFindOutput -Text $text -Label 'gercek'
        Assert-True '3 gecerli girdi, 5 atlanan' (@($p.Entries).Count -eq 3 -and $p.Skipped -eq 5) "girdi=$(@($p.Entries).Count) atlanan=$($p.Skipped)"
        $log = @($p.Entries | Where-Object { $_.Rel -eq 'logs\a.log' })[0]
        Assert-True 'goreli yol \ ayiricili, boyut ve UTC zaman' ($log.Length -eq 120 -and $log.MtimeUtc.Kind -eq [System.DateTimeKind]::Utc -and $log.MtimeUtc -eq ([datetime]::new(1970, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc).AddSeconds(1790000000.5)))
        Assert-True 'etiket + Ignored bayragi' ($log.Source -ceq 'gercek' -and -not $log.Ignored -and (@($p.Entries | Where-Object { $_.Rel -eq 'kilit.lock' })[0].Ignored))
        Assert-True 'saf Windows->WSL cevirimi' ((ConvertTo-SmithWslPathPure 'C:\Users\x\.smith') -ceq '/mnt/c/Users/x/.smith' -and (Test-SmithWslPath '/mnt/c/x') -and -not (Test-SmithWslPath 'C:\x'))
    }

    Invoke-Case 'WSL: sahte kosucuyla uc uca (find + sha256sum + cp -p + wslpath), kaynak salt-okur' {
        $c = New-CaseDirs
        New-SrcFile $c.Real 'speaker\owner.npy' 'GERCEK-KAYIT' 9000 | Out-Null
        New-SrcFile $c.Real 'last-backup.json' 'gercek-eski-yedek' 7200 | Out-Null
        New-SrcFile $c.Pkg 'last-backup.json' 'paket-yeni-yedek!' 100 | Out-Null
        New-SrcFile $c.Real 'logs\yalniz-gercek.log' 'g' 100 | Out-Null
        $before = Get-TreeSnapshot $c.Real
        $fakeRoots = @{ '/fakewsl/real' = $c.Real; '/mnt/fake/target' = $c.Target }
        $script:WslCalls = New-Object System.Collections.Generic.List[string]
        $runner = {
            param([string[]]$Arguments)
            $script:WslCalls.Add(($Arguments -join ' '))
            $map = {
                param([string]$Wsl)
                foreach ($k in $fakeRoots.Keys) {
                    if ($Wsl -eq $k -or $Wsl.StartsWith($k + '/')) { return (Join-Path $fakeRoots[$k] $Wsl.Substring($k.Length).TrimStart('/').Replace('/', '\')) }
                }
                throw "bilinmeyen sahte WSL yolu: $Wsl"
            }
            $ok = { param($out) [pscustomobject]@{ ExitCode = 0; TimedOut = $false; Output = $out; Error = '' } }
            switch ($Arguments[0]) {
                'find' {
                    $root = & $map $Arguments[1]
                    $epoch = [datetime]::new(1970, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)
                    $lines = foreach ($f in Get-ChildItem -LiteralPath $root -Recurse -File) {
                        '{0}{1}{2}{3}{4}' -f $f.FullName.Substring($root.Length).TrimStart('\').Replace('\', '/'), "`t", $f.Length, "`t", (($f.LastWriteTimeUtc - $epoch).TotalSeconds.ToString('F6', [System.Globalization.CultureInfo]::InvariantCulture))
                    }
                    return (& $ok (($lines -join "`n") + "`n"))
                }
                'sha256sum' {
                    $h = (Get-FileHash -Algorithm SHA256 -LiteralPath (& $map $Arguments[2])).Hash.ToLowerInvariant()
                    return (& $ok ($h + '  ' + $Arguments[2] + "`n"))
                }
                'cp' {
                    $src = & $map $Arguments[3]
                    $dst = & $map $Arguments[4]
                    [System.IO.File]::Copy($src, $dst, $false)
                    [System.IO.File]::SetLastWriteTimeUtc($dst, [System.IO.File]::GetLastWriteTimeUtc($src))
                    return (& $ok '')
                }
                'wslpath' { return (& $ok '/mnt/fake/target') }
                default { throw "sahte kosucu: desteklenmeyen komut $($Arguments[0])" }
            }
        }
        $realSrc = New-SmithMigrationSource -Label 'gercek' -Root '/fakewsl/real' -Runner $runner
        $pkgSrc = New-SmithMigrationSource -Label 'paket' -Root $c.Pkg
        Assert-True 'WSL yolu wsl kaynagi, Windows yolu fs kaynagi' ($realSrc.Kind -eq 'wsl' -and $pkgSrc.Kind -eq 'fs')
        $re = (Get-SmithMigrationEntries -Source $realSrc).Entries
        $pe = (Get-SmithMigrationEntries -Source $pkgSrc).Entries
        Assert-True 'sahte find 3 gercek dosya listeledi' (@($re).Count -eq 3) "adet: $(@($re).Count)"
        $srcs = @{ gercek = $realSrc; paket = $pkgSrc }
        $hasher = { param($Entry) Get-SmithMigrationEntryHash -Source $srcs[$Entry.Source] -Entry $Entry }
        $plan = New-SmithMigrationPlan -RealEntries $re -PackageEntries $pe -TargetRoot $c.Target -Hasher $hasher
        Assert-SetEqual 'plan' (Get-PlanRows $plan) @(
            'Copy|gercek|speaker\owner.npy', 'Copy|paket|last-backup.json', 'CopyOld|gercek|last-backup.json.gercek-eski',
            'Copy|gercek|logs\yalniz-gercek.log')
        $wslTarget = Resolve-SmithWslPath -WindowsPath $c.Target -Runner $runner
        Assert-True 'wslpath sonucu kullanilir' ($wslTarget -ceq '/mnt/fake/target')
        $lines = New-Object System.Collections.Generic.List[string]
        $result = Invoke-SmithMigrationPlan -Plan $plan -TargetRoot $c.Target -Sources $srcs -Apply -TargetWslRoot $wslTarget -Emit { param($Text) $lines.Add($Text) }
        Assert-True 'hata yok, 3 asil + 1 eski yazildi' ($result.Sayimlar.Hata -eq 0 -and $result.Sayimlar.Kopyalanan -eq 3 -and $result.Sayimlar.EskiYedek -eq 1) (($result.Hatalar) -join '; ')
        Assert-True 'WSL kaynagindan gelen dosyalar dogru icerikle hedefte' (
            ([System.IO.File]::ReadAllText((Join-Path $c.Target 'speaker\owner.npy')) -ceq 'GERCEK-KAYIT') -and
            ([System.IO.File]::ReadAllText((Join-Path $c.Target 'last-backup.json.gercek-eski')) -ceq 'gercek-eski-yedek') -and
            ([System.IO.File]::ReadAllText((Join-Path $c.Target 'last-backup.json')) -ceq 'paket-yeni-yedek!'))
        Assert-True 'cp -p -- <wsl kaynak> <wsl hedef>.migrate-part bicimi' (@($script:WslCalls | Where-Object { $_ -match '^cp -p -- /fakewsl/real/speaker/owner\.npy /mnt/fake/target/speaker/owner\.npy\.migrate-part$' }).Count -eq 1) (($script:WslCalls -join ' | '))
        Assert-True 'gercek kaynak degismedi' ($before -ceq (Get-TreeSnapshot $c.Real))
        Assert-True 'artik .migrate-part yok' (@(Get-ChildItem -LiteralPath $c.Target -Recurse -File -Filter '*.migrate-part').Count -eq 0)
        Assert-True 'YAZILDI satirlari uretildi' (@($lines | Where-Object { $_ -like '[[]YAZILDI]*' }).Count -eq 4)
    }

} finally {
    $env:SMITH_DATA_DIR = $prevDataDir
    if ($null -eq $prevDataDir) { Remove-Item Env:\SMITH_DATA_DIR -ErrorAction SilentlyContinue }
    $env:LOCALAPPDATA = $prevLocal
    # Yalniz kendi olusturdugumuz gecici klasoru sil: ad deseni + TEMP altinda olma kontrolu.
    $leaf = Split-Path -Leaf $work
    if ($leaf -like 'smith-migrate-test-*' -and (Split-Path -Parent $work).TrimEnd('\') -eq $tempRoot.TrimEnd('\') -and (Test-Path -LiteralPath $work)) {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Complete-SmithTestRun
