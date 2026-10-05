# Smith yerel STT sidecar'ini mevcut venv ve model onbellegi ile calistirir.
# Paket/model indirmez; model ilk isitma veya ses isteginde yuklenir.
param(
    [int]$Port = 8123
)

$ErrorActionPreference = 'Stop'
$side = Join-Path (Split-Path -Parent $PSScriptRoot) 'apps\desktop\sidecar'
$py = Join-Path $side '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $py)) { throw 'STT icin mevcut sidecar .venv gerekli; otomatik indirme yok.' }

$env:HF_HUB_OFFLINE = '1'
Write-Host "[stt] sunucu basliyor (port $Port)..."
& $py (Join-Path $side 'stt_server.py') --engine local --port $Port
exit $LASTEXITCODE
