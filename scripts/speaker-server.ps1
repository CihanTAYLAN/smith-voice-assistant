# Smith ses izi dogrulama sidecar'ini kurar (ilk sefer) ve calistirir.
#
# NE YAPAR: gelen her ifadenin Cihan'a ait olup olmadigina karar verir. Masaustu
# bu karari hafizaya YAZMA ve hassas arac kapisi olarak kullanir. Karar TAMAMEN
# YERELDIR - ses izi biyometrik veridir, buluta cikmaz.
#
# Model ilk calistirmada iner (~28 MB, sherpa-onnx model zoo) ve
# <veri koku>\speaker altinda durur (kok: SMITH_DATA_DIR ya da %USERPROFILE%\.smith,
# bkz. smith-common.ps1); repoya binary girmez.
#
# ONCE KAYIT GEREKIR (bir kere):
#   .\scripts\speaker-enroll.ps1
param(
    [int]$Port = 8124,
    # Ayrisma marji bu makinede olculdu: ayni kisi >= 0.64, impostor <= 0.32.
    # Bos birakilirsa apps/desktop/sidecar/speaker_server.py icindeki
    # DEFAULT_THRESHOLD tek kaynagi gecerli olur.
    [string]$Threshold = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'smith-common.ps1')
$side = Join-Path (Split-Path -Parent $PSScriptRoot) 'apps\desktop\sidecar'
Set-Location $side

if (-not (Test-Path ".venv")) {
    Write-Host "[speaker] venv kuruluyor..."
    uv venv .venv | Out-Host
}
$py = Join-Path $side ".venv\Scripts\python.exe"
# Idempotent: kuruluysa hizli gecer. sherpa-onnx fbank cikarimini kendi tasir ->
# torch GEREKMEZ (speechbrain/resemblyzer yolu ~2 GB bagimlilik getiriyordu).
uv pip install -p $py -q sherpa-onnx numpy | Out-Host

if ($Threshold -ne "") { $env:SMITH_SPEAKER_THRESHOLD = $Threshold }

$ref = Join-Path (Get-SmithDataDir) "speaker\owner.npy"
if (-not (Test-Path $ref)) {
    Write-Host ""
    Write-Host "[speaker] UYARI: kayitli ses izi YOK ($ref)" -ForegroundColor Yellow
    Write-Host "[speaker] Sunucu acilir ama her ifadeye 'kayit yok' der; masaustu bu durumda" -ForegroundColor Yellow
    Write-Host "[speaker] dogrulayici kullanilamiyor sayar: mutasyon ve gizlilik araclari" -ForegroundColor Yellow
    Write-Host "[speaker] KAPALI kalir (fail-closed)." -ForegroundColor Yellow
    Write-Host "[speaker] Cozum: .\scripts\speaker-enroll.ps1" -ForegroundColor Yellow
    Write-Host ""
}

Write-Host "[speaker] sunucu basliyor (port $Port)..."
& $py (Join-Path $side 'speaker_server.py') --port $Port
exit $LASTEXITCODE
