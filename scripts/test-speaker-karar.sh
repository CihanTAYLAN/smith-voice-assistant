#!/usr/bin/env bash
# Ses izi KARAR mantiginin regresyon testini kosar (pre-commit kapisi).
#
# Neden ayri script: lefthook bu makinede komutlari bash ile calistirmiyor,
# dolayisiyla POSIX testleri (`[ -x ... ]`) dogrudan `run:` icinde sessizce
# basarisiz oluyordu — kapi teste HIC ulasmadan dusuyordu (olculdu: 0.05 sn).
# Depodaki `scan-secrets` adimi da ayni sebeple `bash …` diye cagriliyor.
set -euo pipefail

kok="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test="$kok/apps/desktop/sidecar/test_speaker_karar.py"

py="$kok/apps/desktop/sidecar/.venv/Scripts/python.exe"
[ -x "$py" ] || py="$kok/apps/desktop/sidecar/.venv/bin/python"
if [ ! -x "$py" ]; then
  echo "sidecar venv bulunamadi: $py" >&2
  echo "Kurulum: cd apps/desktop/sidecar && uv sync" >&2
  exit 1
fi

# Sunucunun kendi stderr gunlugu (referans yukleme satirlari) kapinin ciktisini
# bogmasin; test sonucu stdout'ta ve cikis kodunda.
"$py" "$test" 2>/dev/null

# Enrollment quality/confirmation regressions also use synthetic audio only.
"$py" "$kok/apps/desktop/sidecar/test_speaker_enrollment.py"
