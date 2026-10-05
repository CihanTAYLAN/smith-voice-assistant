# Smith kisisel baglam beslemesi - tek komutla tum konnektorler (ADR 0004).
#
# Sira: github -> obsidian -> code -> device. Aralarda kota dinlenmesi var.
#
# KOTA GERCEGI (bu script'in var olma nedeni): gateway her /remember POST'unda
# yeniden embedding uretir ve embed ucu free-tier'da DAKIKALIK (RPM) ve GUNLUK
# limitlidir. Yazilmis bir kaydi tekrar gondermek DB'yi bozmaz (sourceId upsert)
# ama kotayi bosa harcar. Bu yuzden script IDEMPOTENT'tir:
#   - obsidian ve code konnektorleri `--exclude-file` destekler; exclude dosyasi
#     her kosuda DB'den TAZE uretilir (dosyada tutulan liste bayatlar).
#   - github ve device konnektorlerinde exclude bayragi YOK; bu yuzden DB'de o
#     kaynaktan kayit varsa adim ATLANIR. Tazelemek icin -Force ver.
#
# Kullanim:
#   .\scripts\ingest-all.ps1                 # eksikleri tamamla
#   .\scripts\ingest-all.ps1 -DryRun         # hicbir POST yok, plan + sayilar
#   .\scripts\ingest-all.ps1 -Force          # github/device kayitlarini da tazele
#   .\scripts\ingest-all.ps1 -Only code      # tek adim

[CmdletBinding()]
param(
    [ValidateSet('all', 'github', 'obsidian', 'code', 'device')]
    [string]$Only = 'all',
    [switch]$Force,
    [switch]$DryRun,
    [int]$ObsidianMax = 300,
    [int]$CodeMax = 250,
    [int]$CooldownSeconds = 45
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Sidecar = Join-Path $RepoRoot 'apps\desktop\sidecar'
$Python = Join-Path $Sidecar '.venv\Scripts\python.exe'
$Gateway = 'http://127.0.0.1:4100'
$PgContainer = 'smith-dev-postgres-1'
$WorkspaceId = 'ws_b98888ec6fe14f64bc57ca2ff599c31f'

# psql cikisi UTF-8'dir. Konsol kod sayfasi cp1254 kalirsa ASCII disi bir
# sourceId (Turkce adli bir not) bozularak okunur, exclude eslesmesi kacar ve
# o kayit bosa yeniden embed edilir. Yakalamadan once UTF-8'e sabitle.
$PrevEncoding = [Console]::OutputEncoding
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$WorkDir = Join-Path $env:TEMP 'smith-ingest'
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "=== $Text" -ForegroundColor Cyan
}

function Write-Note([string]$Text) { Write-Host "    $Text" -ForegroundColor DarkGray }

function Invoke-Psql([string]$Sql) {
    # Dev container yalniz `smith` superuser'ini sunuyor; superuser RLS'yi
    # bypass ettigi icin her Memory sorgusu asagida explicit workspace filtresi tasir.
    $out = & docker exec $PgContainer psql -U smith -d smith -tAc $Sql 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "psql basarisiz (container $PgContainer): $out"
    }
    [string[]]$rows = @($out | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    # Bastaki virgul SART: `return $rows` tek elemanli diziyi cozup STRING
    # dondurur, sonra cagiran taraftaki [0] dizinin ilk elemani yerine STRINGIN
    # ILK KARAKTERINI verir; `[int]` de onu ASCII koduna cevirir ("1113" -> 49).
    # Sessiz ve tamamen yanlis sayi uretir.
    return , $rows
}

function Get-MemoryTotal {
    $sql = 'select count(*) from "Memory" where "workspaceId"=''{0}''' -f $WorkspaceId
    return [int](Invoke-Psql $sql)[0]
}

function Get-SourceCounts {
    # `group by 1` burada CALISMAZ: 1. sutun count(*) iceren ifadenin tamami
    # olur ve Postgres "aggregate functions are not allowed in GROUP BY" der.
    $sql = 'select "sourceType" || ''|'' || count(*) from "Memory" where "workspaceId"=''{0}'' group by "sourceType" order by "sourceType"' -f $WorkspaceId
    $rows = Invoke-Psql $sql
    $map = [ordered]@{}
    foreach ($row in $rows) {
        $parts = $row -split '\|', 2
        if ($parts.Count -eq 2) { $map[$parts[0]] = [int]$parts[1] }
    }
    return $map
}

function New-ExcludeFile([string]$SourceType) {
    # Exclude listesi DB'den TAZE uretilir; onceki kosunun dosyasina guvenilmez.
    $sql = 'select "sourceId" from "Memory" where "workspaceId"=''{0}'' and "sourceType"=''{1}'' and "sourceId" is not null' -f $WorkspaceId, $SourceType
    $ids = Invoke-Psql $sql
    $path = Join-Path $WorkDir "exclude-$SourceType.txt"
    [System.IO.File]::WriteAllLines(
        $path,
        [string[]]$ids,
        [System.Text.UTF8Encoding]::new($false)
    )
    return [pscustomobject]@{ Path = $path; Count = $ids.Count }
}

function Test-Preflight {
    try {
        $health = Invoke-RestMethod -Uri "$Gateway/v1/health" -TimeoutSec 8
    } catch {
        throw "Gateway $Gateway yanit vermiyor. Once baslat: .\scripts\gateway-dev.ps1"
    }
    if (-not $health.ok) { throw "Gateway saglikli degil: $($health | ConvertTo-Json -Compress)" }
    Write-Note "gateway ok (protocolVersion $($health.protocolVersion))"

    $running = & docker ps --filter "name=$PgContainer" --format '{{.Names}}' 2>&1
    if ($LASTEXITCODE -ne 0 -or -not ($running -match [regex]::Escape($PgContainer))) {
        throw "Postgres container '$PgContainer' calismiyor. Once: docker compose -f docker/dev-compose.yml up -d"
    }
    Write-Note "postgres ok ($PgContainer)"

    if (-not (Test-Path $Python)) { throw "Sidecar python yok: $Python" }
    Write-Note "python ok ($(& $Python --version 2>&1))"
}

function Invoke-Connector([string]$Name, [string[]]$ConnectorArgs) {
    $script = Join-Path $Sidecar "$Name`_connector.py"
    if (-not (Test-Path $script)) { throw "Konnektor yok: $script" }
    $log = Join-Path $WorkDir "$Name.log"
    Write-Note "calistiriliyor: $Name $($ConnectorArgs -join ' ')"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    # Konnektorler kendi hatalarini kodla raporlar (kota duvari dahil); tek bir
    # adimin dusmesi digerlerini iptal etmesin.
    $ErrorActionPreference = 'Continue'
    # `Out-Host` SART: Tee-Object nesneleri gecirir, onlar da fonksiyonun cikis
    # akisina karisip donen degeri (exit kodu) kirletir - ozet tablosunda
    # konnektor log'u gorunur.
    & $Python $script @ConnectorArgs 2>&1 | Tee-Object -FilePath $log | Out-Host
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $sw.Stop()
    Write-Note "$Name bitti: exit $code, $([int]$sw.Elapsed.TotalSeconds)s, log $log"
    return $code
}

function Start-Cooldown([string]$Next) {
    if ($DryRun -or $CooldownSeconds -le 0) { return }
    Write-Note "kota dinlenmesi $CooldownSeconds s (sonraki: $Next)"
    Start-Sleep -Seconds $CooldownSeconds
}

$ExitCode = 0
try {
    Write-Step 'On kontrol'
    Test-Preflight

    Write-Step 'Baslangic hafiza durumu'
    $before = Get-SourceCounts
    $before.GetEnumerator() | ForEach-Object { Write-Note "$($_.Key): $($_.Value)" }
    Write-Note "TOPLAM: $(Get-MemoryTotal)"

    $steps = @()

    # --- github: exclude bayragi YOK -> DB'de kayit varsa atla (-Force ile tazele)
    if ($Only -in @('all', 'github')) {
        $has = [int]($before['github'])
        if ($has -gt 0 -and -not $Force) {
            Write-Step "github - ATLANDI (DB'de $has kayit var; tazelemek icin -Force)"
            $steps += [pscustomobject]@{ Ad = 'github'; Durum = "atlandi ($has zaten yazili)"; Exit = 0 }
        } elseif ($DryRun) {
            Write-Step 'github - KURU CALISTIRMA (konnektorde --dry-run yok, atlandi)'
            $steps += [pscustomobject]@{ Ad = 'github'; Durum = 'kuru calistirma'; Exit = 0 }
        } else {
            Write-Step 'github'
            $code = Invoke-Connector 'github' @()
            $steps += [pscustomobject]@{ Ad = 'github'; Durum = 'kosuldu'; Exit = $code }
            Start-Cooldown 'obsidian'
        }
    }

    # --- obsidian: --exclude-file destekli, exclude DB'den taze
    if ($Only -in @('all', 'obsidian')) {
        Write-Step 'obsidian'
        $ex = New-ExcludeFile 'obsidian'
        Write-Note "exclude: $($ex.Count) sourceId ($($ex.Path))"
        $obsArgs = @('--max', "$ObsidianMax", '--exclude-file', $ex.Path)
        if ($DryRun) {
            Write-Note 'KURU CALISTIRMA: --max 0 ile POST yapilmaz, yalniz sayim raporlanir'
            $obsArgs = @('--max', '0', '--exclude-file', $ex.Path)
        }
        $code = Invoke-Connector 'obsidian' $obsArgs
        $steps += [pscustomobject]@{ Ad = 'obsidian'; Durum = 'kosuldu'; Exit = $code }
        Start-Cooldown 'code'
    }

    # --- code: --exclude-file ve --dry-run destekli
    if ($Only -in @('all', 'code')) {
        Write-Step 'code'
        $ex = New-ExcludeFile 'code'
        Write-Note "exclude: $($ex.Count) sourceId ($($ex.Path))"
        $codeArgs = @('--max', "$CodeMax", '--exclude-file', $ex.Path)
        if ($DryRun) { $codeArgs += '--dry-run' }
        $code = Invoke-Connector 'code' $codeArgs
        $steps += [pscustomobject]@{ Ad = 'code'; Durum = 'kosuldu'; Exit = $code }
        Start-Cooldown 'device'
    }

    # --- device: exclude bayragi YOK; 3 kayit, degeri tazelikte -> -Force ile
    if ($Only -in @('all', 'device')) {
        $has = [int]($before['device'])
        if ($has -gt 0 -and -not $Force) {
            Write-Step "device - ATLANDI (DB'de $has kayit var; tazelemek icin -Force)"
            $steps += [pscustomobject]@{ Ad = 'device'; Durum = "atlandi ($has zaten yazili)"; Exit = 0 }
        } elseif ($DryRun) {
            Write-Step 'device - KURU CALISTIRMA (konnektorde --dry-run yok, atlandi)'
            $steps += [pscustomobject]@{ Ad = 'device'; Durum = 'kuru calistirma'; Exit = 0 }
        } else {
            Write-Step 'device'
            $code = Invoke-Connector 'device' @()
            $steps += [pscustomobject]@{ Ad = 'device'; Durum = 'kosuldu'; Exit = $code }
        }
    }

    Write-Step 'Sonuc'
    $after = Get-SourceCounts
    $keys = @($before.Keys) + @($after.Keys) | Select-Object -Unique | Sort-Object
    $rows = foreach ($k in $keys) {
        $b = if ($before.Contains($k)) { [int]$before[$k] } else { 0 }
        $a = if ($after.Contains($k)) { [int]$after[$k] } else { 0 }
        [pscustomobject]@{ Kaynak = $k; Once = $b; Sonra = $a; Fark = $a - $b }
    }
    $rows | Format-Table -AutoSize | Out-String | Write-Host
    $steps | Format-Table -AutoSize | Out-String | Write-Host
    $total = Get-MemoryTotal
    Write-Host "Toplam hafiza kaydi: $total" -ForegroundColor Green
    $failedSteps = @($steps | Where-Object { $_.Exit -ne 0 })
    if ($failedSteps.Count -gt 0) {
        Write-Warning "$($failedSteps.Count) konnektor hata verdi: $(($failedSteps.Ad) -join ', ')"
        $ExitCode = 1
    }
    if ($DryRun) { Write-Host 'KURU CALISTIRMA: hicbir kayit yazilmadi.' -ForegroundColor Yellow }
} finally {
    [Console]::OutputEncoding = $PrevEncoding
}
if ($ExitCode -ne 0) { exit $ExitCode }
