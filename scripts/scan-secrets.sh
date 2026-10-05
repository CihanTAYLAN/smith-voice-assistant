#!/usr/bin/env bash
# Secret'in repoya girmesini engelleyen son kapi.
# Amac paranoya degil: bir kere sizan secret sonsuza kadar git gecmisindedir.
set -uo pipefail

files=("$@")
[ ${#files[@]} -eq 0 ] && exit 0

fail=0

# Dosya adina gore reddedilenler
for f in "${files[@]}"; do
  case "$f" in
    *.pem|*.key|*.p8|*.p12|*.mobileprovision|*id_rsa*|*id_ed25519*)
      echo "RED: '$f' bir anahtar dosyasi gorunumunde. Commit edilmez." >&2
      fail=1
      ;;
    .env|.env.*|*/.env|*/.env.*)
      case "$f" in *.env.example) continue ;; esac
      echo "RED: '$f' ortam dosyasi. Yalnizca .env.example commit edilir." >&2
      fail=1
      ;;
  esac
done

# Icerige gore reddedilenler
patterns=(
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'sk-[A-Za-z0-9]{32,}'
  # GitHub: ghp (PAT), gho (OAuth), ghu (kullanici), ghs (sunucu), ghr (yenileme).
  'gh[opsur]_[A-Za-z0-9]{36,}'
  'github_pat_[A-Za-z0-9_]{60,}'
  'AKIA[0-9A-Z]{16}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
  # Google/Gemini API anahtari. Bosluk degil GERCEK bir olay uzerine eklendi
  # (2026-08-12): calisan bir Gemini anahtari scripts/dev-win.ps1'e duz metin
  # yazilmisti ve bu kapi onu TANIMIYORDU. Anahtarlar 'AIza' onekiyle baslar ve
  # 35 karakter devam eder.
  'AIza[0-9A-Za-z_-]{35}'
  # Stripe canli (sk_live_, rk_live_), npm ve Hugging Face jetonlari. Bu liste
  # packages/memory/src/redact.ts ile paritededir (redact.test.ts yakalar).
  '[sr]k_live_[A-Za-z0-9]{16,}'
  'npm_[A-Za-z0-9]{36,}'
  'hf_[A-Za-z0-9]{34,}'
)

for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  case "$f" in
    scripts/scan-secrets.sh) continue ;;
  esac
  for p in "${patterns[@]}"; do
    if grep -nEq "$p" "$f" 2>/dev/null; then
      echo "RED: '$f' icinde secret gorunumunde bir dizi var (desen: $p)." >&2
      echo "      Gercekten secret ise repodan cikar. Yanlis pozitifse deseni scripts/scan-secrets.sh icinde daralt." >&2
      fail=1
    fi
  done
done

exit $fail
