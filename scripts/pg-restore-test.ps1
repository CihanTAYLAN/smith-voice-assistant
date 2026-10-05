# pg-backup.ps1'in urettigi dump'i ATILABILIR bir Postgres konteynerine geri
# yukler ve canli veritabaniyla karsilastirir. Amac: "yedek aliniyor" ile
# "yedek geri geliyor" AYNI SEY DEGIL -- bu script ikinciyi kanitlar.
#
# GUVENLIK: bu script SADECE kendi olusturdugu, benzersiz adli test
# konteyneri + volume'u ile calisir (varsayilan: smith-pg-restoretest /
# smith-pgdata-restoretest). Canli container'a (smith-dev-postgres-1) veya
# canli volume'e (pgdata) YAZMAZ, SADECE OKUR (pg_dump zaten alinmis dosyadan
# calisir, bu script canliya SELECT bile atmiyor -- karsilastirma icin
# ayri bir okuma adimi kullanicidan istenir, bkz. cikti).
#
# Kullanim:
#   .\scripts\pg-backup.ps1
#   .\scripts\pg-restore-test.ps1 -DumpFile backups\smith-smith-20260918-...dump
#   .\scripts\pg-restore-test.ps1 -DumpFile <yol> -KeepContainer   # temizleme, incelemek icin birak
param(
    [Parameter(Mandatory = $true)]
    [string]$DumpFile,
    [string]$Image = "pgvector/pgvector:pg16",
    [string]$TestContainer = "smith-pg-restoretest",
    [string]$TestVolume = "smith-pgdata-restoretest",
    [string]$PgUser = "smith",
    [string]$PgPassword = "smith",
    [string]$PgDatabase = "smith",
    [string]$LiveComposeFile = (Join-Path $PSScriptRoot "..\docker\dev-compose.yml"),
    [string]$LiveService = "postgres",
    [switch]$KeepContainer
)

$ErrorActionPreference = "Stop"

function Fail([string]$msg) {
    # Cleanup ONCE cagrilir: Write-Error, $ErrorActionPreference=Stop altinda
    # sonlandirici hale gelir ve fonksiyonun geri kalanini atlar -- sirasi
    # ters olsaydi test konteyneri/volume'u arkada kalirdi (ilk denemede
    # tam boyle oldu).
    Cleanup
    Write-Error $msg
    exit 1
}

function Cleanup {
    if ($KeepContainer) {
        Write-Host "[pg-restore-test] -KeepContainer verildi, temizlenmiyor: $TestContainer / $TestVolume"
        return
    }

    # GUVENLIK KAPISI (koordinator bulgusu): -TestContainer / -TestVolume
    # DISARIDAN gecersiz kilinabilir. Varsayilanlarin guvenli olmasi yetmez --
    # "smith-dev-postgres-1" + "smith-dev_pgdata" verilirse bu fonksiyon
    # SORGUSUZ canli konteyneri silip ardindan (artik "in use" olmayan) canli
    # pgdata volume'unu silerdi -- script'in var olma sebebi olan kaza. Silme
    # calistirmadan ONCE hedefi kanitla.
    #
    # 1) Ad deseni: her iki ad da "restoretest" icermiyorsa DOKUNMA.
    if ($TestContainer -notmatch "restoretest") {
        Write-Error "GUVENLIK: -TestContainer 'restoretest' icermiyor ($TestContainer) -- silme REDDEDILDI, hicbir docker rm/volume rm calistirilmadi."
        exit 1
    }
    if ($TestVolume -notmatch "restoretest") {
        Write-Error "GUVENLIK: -TestVolume 'restoretest' icermiyor ($TestVolume) -- silme REDDEDILDI, hicbir docker rm/volume rm calistirilmadi."
        exit 1
    }

    # 2) Ek emniyet: ad deseni "restoretest" icerse bile, hedef konteyner
    # GERCEKTEN canli compose projesine (smith-dev) kayitliyse silme. Sadece
    # konteyner varsa calisir (yoksa docker inspect zaten hata basar, gereksiz).
    $existing = docker ps -a --filter "name=^/$TestContainer$" --format "{{.Names}}" 2>$null
    if ($existing -eq $TestContainer) {
        $project = docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' $TestContainer 2>$null
        if ($project -eq "smith-dev") {
            Write-Error "GUVENLIK: $TestContainer canli compose projesine ait (com.docker.compose.project=smith-dev) -- silme REDDEDILDI."
            exit 1
        }
    }

    Write-Host "[pg-restore-test] temizleniyor: $TestContainer / $TestVolume"
    docker rm -f $TestContainer 2>$null | Out-Null
    docker volume rm $TestVolume 2>$null | Out-Null
}

if (-not (Test-Path $DumpFile)) {
    Fail "Dump dosyasi bulunamadi: $DumpFile"
}
$DumpFile = (Resolve-Path $DumpFile).Path

try {
    docker version --format "{{.Server.Version}}" | Out-Null
} catch {
    Fail "Docker yanit vermiyor ($($_.Exception.Message))."
}

# Isim carpismasini onceden yakala: baskasinin kullandigi adla YANLISLIKLA
# calisip onu silmeyelim.
$existing = docker ps -a --filter "name=^/$TestContainer$" --format "{{.Names}}"
if ($existing -eq $TestContainer) {
    Fail "Bu adda bir konteyner zaten var: $TestContainer. Once elle temizle veya -TestContainer ile baska ad ver."
}

Write-Host "[pg-restore-test] test konteyneri baslatiliyor: $TestContainer (imaj: $Image, port yayinlanmiyor)"
# Port publish etmiyoruz (host portu ile carpisma riski yok); her sey
# docker exec uzerinden container ici network'te calisir.
docker run -d --name $TestContainer `
    -e POSTGRES_USER=$PgUser `
    -e POSTGRES_PASSWORD=$PgPassword `
    -e POSTGRES_DB=$PgDatabase `
    -v "${TestVolume}:/var/lib/postgresql/data" `
    $Image | Out-Null
if ($LASTEXITCODE -ne 0) {
    Fail "Test konteyneri baslatilamadi (exit $LASTEXITCODE)."
}

Write-Host "[pg-restore-test] postgres hazir olmasi bekleniyor..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    docker exec $TestContainer pg_isready -U $PgUser -d $PgDatabase 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $ready) {
    Fail "Test postgres 60 saniyede hazir olmadi."
}
Write-Host "[pg-restore-test] hazir (deneme $($i + 1))"

# Canlidaki grant'lar smith_app rolune atifta bulunuyor (Memory ve digerleri).
# Rol yoksa pg_restore o GRANT satirlarinda hata basar (fatal degil ama
# gurultu + eksik yetki). Dev provision ile ayni desen: idempotent olustur.
Write-Host "[pg-restore-test] smith_app rolu + pgvector extension hazirlaniyor"
# Tek tirnakli here-string: PowerShell hicbir seyi yorumlamasin, $$ psql'e
# oldugu gibi gitsin (cift tirnakli olsaydi PowerShell'de backslash escape
# degil, \$\$ psql'e bozuk gidiyordu -- ilk denemede boyle kirildi).
$provisionSql = @'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='smith_app') THEN
    CREATE ROLE smith_app LOGIN PASSWORD 'smith_app';
  END IF;
END $$;
CREATE EXTENSION IF NOT EXISTS vector;
'@
$provisionSql | docker exec -i $TestContainer psql -U $PgUser -d $PgDatabase -v ON_ERROR_STOP=1
if ($LASTEXITCODE -ne 0) {
    Fail "smith_app rolu / vector extension hazirlanamadi."
}

$dumpName = Split-Path $DumpFile -Leaf
$tmpInContainer = "/tmp/$dumpName"
Write-Host "[pg-restore-test] dump iceri kopyalaniyor: $DumpFile -> ${TestContainer}:$tmpInContainer"
docker cp $DumpFile "${TestContainer}:$tmpInContainer"
if ($LASTEXITCODE -ne 0) {
    Fail "docker cp (iceri) basarisiz."
}

Write-Host "[pg-restore-test] pg_restore calisiyor"
docker exec $TestContainer pg_restore -U $PgUser -d $PgDatabase --no-owner --role=$PgUser $tmpInContainer
$restoreExit = $LASTEXITCODE
# pg_restore bazi zararsiz uyarilarla (or. zaten var olan extension sahiplik
# notu) exit 1 dondurebilir; asil kanit asagidaki veri karsilastirmasi.
docker exec $TestContainer rm -f $tmpInContainer | Out-Null
Write-Host "[pg-restore-test] pg_restore exit kodu: $restoreExit (asagidaki dogrulama asil kanit)"

Write-Host ""
Write-Host "=== GERI YUKLENEN KOPYA ==="
$restoredTables = docker exec $TestContainer psql -U $PgUser -d $PgDatabase -tAc "SELECT string_agg(tablename, ', ' ORDER BY tablename) FROM pg_tables WHERE schemaname='public';"
Write-Host "Tablolar: $restoredTables"

$restoredMemoryCount = (docker exec $TestContainer psql -U $PgUser -d $PgDatabase -tAc "SELECT count(*) FROM `"Memory`";").Trim()
Write-Host "Memory satir sayisi (geri yuklenen): $restoredMemoryCount"

$restoredExt = docker exec $TestContainer psql -U $PgUser -d $PgDatabase -tAc "SELECT string_agg(extname || '=' || extversion, ', ') FROM pg_extension;"
Write-Host "Extensions (geri yuklenen): $restoredExt"

$restoredEmbeddingType = (docker exec $TestContainer psql -U $PgUser -d $PgDatabase -tAc "SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = '`"Memory`"'::regclass AND attname='embedding';").Trim()
Write-Host "embedding kolon tipi (geri yuklenen): $restoredEmbeddingType"

Write-Host ""
Write-Host "=== CANLI VERITABANI (karsilastirma icin, SADECE OKUMA) ==="
$liveContainerId = (docker compose -f $LiveComposeFile ps -q $LiveService 2>$null | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace($liveContainerId)) {
    Write-Host "UYARI: canli servis bulunamadi ($LiveComposeFile), karsilastirma atlandi."
} else {
    $liveContainerName = (docker inspect --format "{{.Name}}" $liveContainerId).TrimStart("/")
    $liveMemoryCount = (docker exec $liveContainerName psql -U $PgUser -d $PgDatabase -tAc "SELECT count(*) FROM `"Memory`";").Trim()
    $liveExt = docker exec $liveContainerName psql -U $PgUser -d $PgDatabase -tAc "SELECT string_agg(extname || '=' || extversion, ', ') FROM pg_extension;"
    Write-Host "Memory satir sayisi (canli, $liveContainerName): $liveMemoryCount"
    Write-Host "Extensions (canli): $liveExt"
    Write-Host ""
    if ($liveMemoryCount -eq $restoredMemoryCount) {
        Write-Host "SONUC: Memory satir sayisi ESLESIYOR ($liveMemoryCount = $restoredMemoryCount)"
    } else {
        Write-Host "SONUC: Memory satir sayisi FARKLI (canli=$liveMemoryCount, geri-yuklenen=$restoredMemoryCount) -- dump ile canli arasinda zaman farki varsa beklenir, aksi halde arastir."
    }
}

Cleanup
Write-Host ""
Write-Host "[pg-restore-test] BITTI"
