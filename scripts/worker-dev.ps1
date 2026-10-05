# Smith WORKER'ini yerel gelistirme modunda baslatir (kuyruk tuketicisi).
#
# NEDEN VAR: Windows tarafinda worker'i baslatan HICBIR script yoktu.
# Bu betik Windows yerel gelistirme worker'inin kanonik baslatma yoludur.
# Eksikligi sahada gorunmez bir ariza olarak ortaya cikiyordu: Mission Control
# panosunda bir gorev atandiginda kuyruga AGENT_RUN isi duser, ama tuketen
# surec olmadigi icin kosu sonsuza kadar 'queued' kalir. Pano "atandi" der,
# hicbir sey olmaz
# ve hata da yoktur - en kotu ariza sinifi.
#
# Kuyruklar: MEMORY_INDEX, SESSION_SUMMARY, AGENT_RUN.
# Env degerleri gateway-dev.ps1 ile AYNI kaynaktan (ayni DB, ayni Redis, ayni
# LLM/embed uclari); ikisi ayrisirsa worker mesaji baska modele gomer.

$smithSecrets = Join-Path $PSScriptRoot "dev-secrets.local.ps1"
if (Test-Path $smithSecrets) { . $smithSecrets }

$ErrorActionPreference = "Continue"
Set-Location (Split-Path -Parent $PSScriptRoot)

$env:NODE_ENV = "development"
$env:SMITH_CONTEXT_EXCLUDE = if ($env:SMITH_CONTEXT_EXCLUDE) { $env:SMITH_CONTEXT_EXCLUDE } else { "obsidian:acme/*,code:_workshop-smoke/*,kw:acme" }
$env:DATABASE_URL = "postgresql://smith:smith@127.0.0.1:5433/smith"
# Projenin kendi compose servisleri (smith-dev-postgres-1 :5433,
# smith-dev-redis-1 :6380). 6379 baska projelere ait - oraya BAGLANMA.
$env:REDIS_URL = "redis://127.0.0.1:6380"
$env:OLLAMA_BASE_URL = "http://127.0.0.1:11434"
# SESSION_SECRET BILEREK YOK (2026-10): worker env semasi (workerEnvSchema)
# onu okumaz; token imzalama gateway'in isidir. Sabit bir sir satiri burada
# hem gereksiz hem gateway'in uretilmis (<veri koku>\session-secret)
# sirrinden SAPMA riskiydi.
$env:CORS_ORIGINS = "http://localhost:1420"

# LLM ve embedding: gateway-dev.ps1 ile birebir ayni (anahtarlar
# dev-secrets.local.ps1'ten gelir).
$env:SMITH_LLM_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai"
$env:SMITH_LLM_MODEL = "gemini-flash-latest"

# YEDEK SAGLAYICI YOK - BILINCLI KARAR (2026-09-18): Mistral kullanilmayacak;
# kosullu Mistral blogu KALDIRILDI (gateway-dev.ps1 ile ayni karar, ayni
# tarih).
# Zincir tek halka: Gemini; kota dolarsa worker isi HATA ile biter.
$env:SMITH_LLM_TIMEOUT_MS = "45000"
$env:SMITH_EMBED_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai"
$env:SMITH_EMBED_MODEL = "gemini-embedding-001"
$env:SMITH_EMBED_DIMENSIONS = "768"

# --- MISSION CONTROL IS GUCU (ADR 0007) ------------------------------------
# Kisisel cihaz aboneligi acik (ADR 0015 karar 4, Cihan 2026-10-02).
# WSL Claude girisi gerekir; disaridan verilen "0" dahil deger korunur.
$env:SMITH_MISSION_EXECUTOR = if ($env:SMITH_MISSION_EXECUTOR) { $env:SMITH_MISSION_EXECUTOR } else { "1" }
# Kosu basina tavan (ms). Ic (WSL `timeout`) ve dis (JS zamanlayici) iki katman
# bunu kullanir; 10 dk'nin altinda tutmak pratikte iyi calisiyor.
$env:SMITH_MISSION_TIMEOUT_MS = "420000"
# Izin modu allowlist'ten gecer: default | acceptEdits | plan.
# `bypassPermissions` KODDA reddedilir, buradan da acilamaz.
$env:SMITH_MISSION_PERMISSION_MODE = "acceptEdits"

# `dev` yalniz tsc --watch (derler, SUREC BASLATMAZ). Once derle, sonra kosur.
Write-Host "=== worker build ==="
pnpm --filter "@smith/worker" build 2>&1 | Select-Object -Last 5
Write-Host "=== worker start (mission executor: $($env:SMITH_MISSION_EXECUTOR)) ==="
pnpm --filter "@smith/worker" start 2>&1
