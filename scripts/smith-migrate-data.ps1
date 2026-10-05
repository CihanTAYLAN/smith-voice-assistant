# Smith veri kokunu TEK yere tasir: eski (AppData tabanli) IKI konumu birlestirip veri kokune
# kopyalar. Varsayilan -DryRun: plan yazar, HICBIR dosya/dizin olusturmaz. -Apply ile yazar.
#
# NEDEN: Claude masaustu uygulamasi MSIX paketidir; ondan baslatilan surecler AppData
# yazilarini gizli paket klasorune yonlendirir, zamanlanmis gorevler ve kullanicinin terminali
# ise GERCEK AppData'yi gorur. 2026-10-03: ses izi, yedek aynasi ayari, gunlukler, oturum
# sirri, smith-up kilidi ve health.json ikiye bolundu. Artik her bilesen tek veri kokune yazar
# (SMITH_DATA_DIR ya da %USERPROFILE%\.smith, bkz. smith-common.ps1 Resolve-SmithDataDir);
# bu betik eski iki konumdaki dosyalari o koke toplar.
#
# KAYNAKLAR (ikisi de salt-okur; HICBIR kosulda silinmez ya da degistirilmez):
#   gercek : <LocalAppData>\smith                                        (-RealRoot)
#   paket  : <LocalAppData>\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\smith  (-PackageRoot)
#
# KURALLAR:
#   - Ayni goreli yol iki kaynakta varsa EN YENI kazanir; kaybeden ".<kaynak>-eski" sonekiyle
#     yanina konur (ornek: last-backup.json.gercek-eski). Esitlikte (2 sn) gercek kazanir.
#     Boyut + zaman ayniysa ya da ayni boyutta icerik ayniysa (SHA-256) tek kopya alinir.
#   - speaker\owner.npy, owner.json ve owner_adapt.npy gercek kaynakta kayitliysa DAIMA gercek
#     kaynaktan alinir (kullanicinin son kaydi); paket surumleri ".paket-eski" olarak saklanir.
#   - Hedefte zaten var olan yola dokunulmaz ve rapor edilir (betik tekrar kosulabilir).
#   - *.lock / *.tmp / *.migrate-part kopyalanmaz (kilit ve gecici dosyalar veri degildir).
#   - session-secret ve smith.env hedefte ACL'i yalniz mevcut kullaniciya daraltilir.
#   - Hatasiz -Apply sonunda veri kokune ".veri-koku-tasindi" isareti yazilir: bilesenlerin
#     "eski konumda tasinmamis veri var" acilis uyarisi susar. Tasimak istemiyorsan da -Apply bir
#     kez calistirilabilir (kopyalanacak dosya yoksa yalniz isaret yazilir).
#
# GERCEK KAYNAK VE CLAUDE OTURUMU: Claude masaustu oturumundan calisan bir surec gercek
# <LocalAppData>\smith dizinini DOGRUDAN goremez (ayni addaki paket kopyasi gercegi golgeler;
# olculdu: paket kopyasi olmayan dosyalar gorunur, gercek ses izi gorunmez). Bu yuzden gercek
# kaynak iki yoldan okunabilir:
#   -RealViaWsl   : gercek konumu WSL (/mnt/c/...) uzerinden okur (wsl.exe; WSL penceresi gerekmez).
#   -RealRoot <yol>: acik kok; Windows yolu ya da WSL yolu (/mnt/c/Users/<ad>/AppData/Local/smith).
# Kullanicinin kendi terminalinden (Claude disi) hicbiri gerekmez: varsayilan dogrudan okur.
# WSL kaynaklari tek `find -printf` ile listelenir, dosyalar WSL `cp -p` ile kopyalanir
# (zaman damgasi korunur); hedef (profil koku) yonlendirilmez, dogrudan yazilir.
#
# Kullanim:
#   pwsh -NoProfile -File scripts\smith-migrate-data.ps1                    # plan (DryRun)
#   pwsh -NoProfile -File scripts\smith-migrate-data.ps1 -Apply             # uygula
#   pwsh -NoProfile -File scripts\smith-migrate-data.ps1 -RealViaWsl        # Claude oturumundan plan
#   pwsh -NoProfile -File scripts\smith-migrate-data.ps1 -RealViaWsl -Apply
#   pwsh -NoProfile -File scripts\smith-migrate-data.ps1 -RealRoot /mnt/c/Users/ad/AppData/Local/smith
#   -Target <dizin>  : hedef kok (varsayilan: Resolve-SmithDataDir); -WslDistro <ad>: WSL dagitimi
#
# Cikis kodu: 0 = tamam (DryRun dahil), 1 = en az bir dosya kopyalanamadi.
# ONERILEN SIRA: Smith'i kapat (masaustu + gateway/worker/ses izi), -DryRun ile plani oku,
# -Apply, sonra smith-up.ps1 ile yeniden baslat (eski surecler eski konuma yazmaya devam eder).
[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$DryRun,
    [string]$RealRoot = '',
    [switch]$RealViaWsl,
    [string]$PackageRoot = '',
    [string]$Target = '',
    [string]$WslDistro = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'smith-common.ps1')
. (Join-Path $PSScriptRoot 'smith-migrate-data-functions.ps1')
# Eski konum uyarisi bu betikte gereksiz (sorunu bu betik cozuyor) ve Resolve zaten sessiz.
$script:SmithLegacyNoticeDone = $true

if ($Apply -and $DryRun) { throw '-Apply ve -DryRun birlikte verilemez (varsayilan zaten DryRun).' }
if ($RealRoot -and $RealViaWsl) { throw '-RealRoot ve -RealViaWsl birlikte verilemez.' }

$legacy = @(Get-SmithLegacyDataRoots)
if ($legacy.Count -eq 0 -and (-not $RealRoot -or -not $PackageRoot)) {
    throw 'Eski konumlar cozulemedi (LocalAppData tanimsiz): -RealRoot ve -PackageRoot ver.'
}
if (-not $Target) { $Target = Resolve-SmithDataDir }

# Duz scriptblock (GetNewClosure DEGIL): kapanis dinamik modul kapsamina baglanir ve betik
# kapsamindaki Invoke-SmithWsl'i goremez; $WslDistro betik kapsamindan okunur.
$runner = { param([string[]]$Arguments) Invoke-SmithWsl -Arguments $Arguments -Distro $WslDistro }

if ($RealRoot) {
    $realEffective = $RealRoot
} elseif ($RealViaWsl) {
    $realEffective = Resolve-SmithWslPath -WindowsPath $legacy[0].Path -Runner $runner
} else {
    $realEffective = $legacy[0].Path
}
if ($PackageRoot) { $packageEffective = $PackageRoot } else { $packageEffective = $legacy[1].Path }

# --- Guvenlik: hedef eski konum olamaz, kaynakla ic ice olamaz -----------------------------
$forbidden = @($legacy | ForEach-Object { $_.Path })
if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) { $forbidden += (Join-Path $env:APPDATA 'smith') }
foreach ($bad in $forbidden) {
    if (Test-SmithPathInside $Target $bad) {
        throw "Hedef eski (AppData tabanli) konumun icinde olamaz: $Target (yasak kok: $bad)"
    }
}
foreach ($root in @($realEffective, $packageEffective)) {
    if (Test-SmithWslPath $root) { continue }
    if ((Test-SmithPathInside $Target $root) -or (Test-SmithPathInside $root $Target)) {
        throw "Hedef ile kaynak ic ice olamaz: hedef $Target, kaynak $root"
    }
}

$sources = @{
    gercek = New-SmithMigrationSource -Label 'gercek' -Root $realEffective -Runner $runner
    paket  = New-SmithMigrationSource -Label 'paket' -Root $packageEffective -Runner $runner
}

$mode = 'DryRun (hicbir sey yazilmaz)'
if ($Apply) { $mode = 'APPLY (yazar; kaynaklar silinmez)' }
Write-Host ('=== Smith veri tasima: {0}' -f $mode) -ForegroundColor Cyan
Write-Host ('hedef  : {0}' -f $Target)
foreach ($label in @('gercek', 'paket')) {
    $s = $sources[$label]
    Write-Host ('{0,-7}: {1}  ({2})' -f $label, $s.Root, $(if ($s.Kind -eq 'wsl') { 'WSL uzerinden okunur' } else { 'dogrudan okunur' }))
}

if ($Apply) {
    $running = @(Get-Process -Name 'smith-desktop' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        Write-Warning 'smith-desktop calisiyor: eski surecler eski konuma yazmaya devam eder. Guvenli sira: Smith''i kapat, tasi, yeniden baslat.'
    }
}

$lists = @{}
foreach ($label in @('gercek', 'paket')) {
    $s = $sources[$label]
    if ($s.Kind -eq 'fs' -and -not (Test-Path -LiteralPath $s.Root -PathType Container)) {
        Write-Warning ('kaynak yok, atlandi: {0} ({1})' -f $label, $s.Root)
        $lists[$label] = [pscustomobject]@{ Entries = @(); Skipped = 0 }
        continue
    }
    $lists[$label] = Get-SmithMigrationEntries -Source $s
    if ($lists[$label].Skipped -gt 0) {
        Write-Warning ('{0}: {1} satir/yol ayristirilamadi ya da guvensiz, atlandi.' -f $label, $lists[$label].Skipped)
    }
}
Write-Host ('bulunan: gercek {0} dosya, paket {1} dosya' -f @($lists['gercek'].Entries).Count, @($lists['paket'].Entries).Count)
Write-Host ''

$hasher = { param($Entry) Get-SmithMigrationEntryHash -Source $sources[$Entry.Source] -Entry $Entry }
$plan = New-SmithMigrationPlan -RealEntries $lists['gercek'].Entries -PackageEntries $lists['paket'].Entries -TargetRoot $Target -Hasher $hasher

$targetWsl = ''
if ($Apply) {
    if (-not (Test-Path -LiteralPath $Target)) { New-Item -ItemType Directory -Force -Path $Target | Out-Null }
    if ($sources['gercek'].Kind -eq 'wsl' -or $sources['paket'].Kind -eq 'wsl') {
        $targetWsl = Resolve-SmithWslPath -WindowsPath $Target -Runner $runner
    }
}

$result = Invoke-SmithMigrationPlan -Plan $plan -TargetRoot $Target -Sources $sources -Apply:$Apply -TargetWslRoot $targetWsl

$c = $result.Sayimlar
Write-Host ''
Write-Host ('OZET: {0} dosya {1} ({2}), {3} eski-yedek, {4} atlandi (hedefte var), {5} yoksayildi, {6} hata' -f
    $c.Kopyalanan, $(if ($Apply) { 'yazildi' } else { 'yazilacak' }), (Format-SmithMigrationSize $c.Bayt),
    $c.EskiYedek, $c.Atlanan, $c.Yoksayilan, $c.Hata)

if (-not $Apply) {
    Write-Host 'DryRun: hicbir dosya yazilmadi ve hedef dizine dokunulmadi. Uygulamak icin ayni komuta -Apply ekle.'
    exit 0
}

if ($c.Hata -gt 0) {
    Write-Host ''
    foreach ($e in $result.Hatalar) { Write-Host ('HATA: ' + $e) -ForegroundColor Red }
    Write-Host 'Tasima isareti YAZILMADI (acilis uyarisi surer). Hatalari giderip betigi yeniden calistir; bitenler atlanir.' -ForegroundColor Yellow
    exit 1
}

Write-SmithMigrationMarker -TargetRoot $Target -Result $result -SourceRoots ([ordered]@{ gercek = $sources['gercek'].Root; paket = $sources['paket'].Root })
Write-Host ('Tasima isareti yazildi: {0}' -f (Join-Path $Target $script:SmithMigrationMarker)) -ForegroundColor Green
Write-Host 'Bitti. Kaynaklar silinmedi; kontrol ettikten sonra silmek sana ait. Smith bilesenlerini yeniden baslat: scripts\smith-up.ps1' -ForegroundColor Green
exit 0
