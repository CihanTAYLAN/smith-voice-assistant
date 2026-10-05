# Smith prod deploy: imajlari YERELDE derle, SSH ile sunucuya yukle, Dokploy'u tetikle.
#
# Neden boyle: Dokploy bu host'un KENDISI (12 CPU, load ~9). Monorepo build'i
# (pnpm + turbo) host'ta calistirilinca Dokploy API'si 502 verip job'i iptal
# ediyordu. Uzak registry (GHCR) icin PAT gerekiyor; host'taki registry
# 127.0.0.1:5000'de, disaridan erisilemez. Bu yuzden: build disarida, calistirma
# host'ta.
#
# Kullanim:
#   pwsh -File scripts/deploy-prod.ps1                 # gateway + worker + web
#   pwsh -File scripts/deploy-prod.ps1 -Services web    # sadece web
#   pwsh -File scripts/deploy-prod.ps1 -SkipBuild       # sadece aktar + deploy
#
# Gerekli ortam (dosyaya YAZILMAZ):
#   DOKPLOY_API_KEY  - cloud.example.com API anahtari
#   DOKPLOY_URL      - varsayilan: https://cloud.example.com
#   DOKPLOY_COMPOSE_ID - smith-prod compose servisi
#   DOKPLOY_SSH_HOST  - varsayilan: server
param(
  [string[]]$Services = @('gateway', 'worker', 'web'),
  [switch]$SkipBuild,
  [switch]$SkipDeploy
)

$ErrorActionPreference = 'Stop'

$dokployUrl = if ($env:DOKPLOY_URL) { $env:DOKPLOY_URL.TrimEnd('/') } else { 'https://cloud.example.com' }
$composeId = if ($env:DOKPLOY_COMPOSE_ID) { $env:DOKPLOY_COMPOSE_ID } else { '6RmnZwFnVHDOooJOO_bMo' }
$sshHost = if ($env:DOKPLOY_SSH_HOST) { $env:DOKPLOY_SSH_HOST } else { 'server' }
$apiKey = $env:DOKPLOY_API_KEY

# Imaj adlari compose.prod.yml ile ayni olmak ZORUNDA: compose `image:` satiri
# bu etiketi bekliyor ve `pull_policy: never` yuzunden registry'ye sormuyor.
$images = @{
  gateway = 'smith-gateway:prod'
  worker  = 'smith-worker:prod'
  web     = 'smith-web:prod'
}
$dockerfiles = @{
  gateway = 'docker/prod/Dockerfile.gateway'
  worker  = 'docker/prod/Dockerfile.worker'
  web     = 'docker/prod/Dockerfile.web'
}
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  foreach ($svc in $Services) {
    if (-not $images.ContainsKey($svc)) { throw "bilinmeyen servis: $svc" }
  }

  if (-not $SkipBuild) {
    foreach ($svc in $Services) {
      Write-Host "=== build: $($images[$svc]) ===" -ForegroundColor Cyan
      docker build -f $dockerfiles[$svc] -t $images[$svc] .
      if ($LASTEXITCODE -ne 0) { throw "build basarisiz: $svc" }
    }
  }

  foreach ($svc in $Services) {
    $img = $images[$svc]
    Write-Host "=== aktar: $img -> $sshHost ===" -ForegroundColor Cyan
    # Tek akis: save -> [gzip] -> ssh -> load. Host'ta gecici dosya birikmez.
    # Olcum (2026-09-26, smith-worker:prod yerelde olculdu):
    #   docker save            -> 663,6 MB / 21,3 sn
    #   wsl gzip -1            -> 221,6 MB / 14,3 sn   (3,0x kuculme, CPU 14 sn)
    #   uplink ~2,7 MB/s'te    -> HAM 246 sn  |  GZIP 96 sn  -> gzip 149 sn KAZANIR
    # YANI SIKI SIKILMIYOR, KAZANIYOR. Onceki yorumda iki sure ETIKET KARIsTIYDI
    # ("ham 148 sn, siki ~250 sn" yaziyordu): 250 sn zaten 2,7 MB/s'te HAM
    # aktarimin suresiydi; 148 sn ise ~4,5 MB/s'te ham sureden geliyor. Kod
    # dogruydu, gerekcesi tersti - yorumu okuyan biri gzip'i YAVAS sanip dali
    # silerdi. Duzeltme: sayilar gercek olcumle degistirildi, karar ayni.
    if (Get-Command wsl -ErrorAction SilentlyContinue) {
      docker save $img | wsl -e bash -c 'gzip -1' | ssh $sshHost 'gzip -d | docker load'
    } else {
      docker save $img | ssh $sshHost 'docker load'
    }
    if ($LASTEXITCODE -ne 0) { throw "aktarim basarisiz: $img" }
  }

  if ($SkipDeploy) {
    Write-Host 'atlandi: -SkipDeploy, Dokploy tetiklenmedi' -ForegroundColor Yellow
    return
  }

  if (-not $apiKey) {
    Write-Host 'DOKPLOY_API_KEY yok; imajlar sunucuda, deploy elle yapilacak.' -ForegroundColor Yellow
    return
  }

  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
  $body = @{
    composeId  = $composeId
    title      = "deploy $stamp"
    description = "ps1: $($Services -join ', ')"
  } | ConvertTo-Json
  Write-Host '=== dokploy deploy ===' -ForegroundColor Cyan
  $resp = Invoke-RestMethod -Uri "$dokployUrl/api/compose.redeploy" -Method Post `
    -Headers @{ 'x-api-key' = $apiKey } -ContentType 'application/json' -Body $body -TimeoutSec 60
  Write-Host ($resp | ConvertTo-Json -Compress)
  Write-Host "girdi: $dokployUrl/project/.../compose/$composeId" -ForegroundColor Green
}
finally {
  Pop-Location
}
