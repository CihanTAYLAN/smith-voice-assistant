#!/usr/bin/env bash
# .ps1 dosyalari ASCII olmali. Kapinin sebebi olculmus bir ariza:
#
#   Windows PowerShell 5.1 (`powershell.exe`), BOM'SUZ bir .ps1 dosyasini
#   UTF-8 degil ANSI (bu makinede cp1254) varsayarak okur. UTF-8 ile yazilmis
#   bir tire (U+2014 "—") uc bayta acilir ve ANSI'de uc anlamsiz karaktere
#   donusur. Yorum satirinda zararsizdir, ama bir DIZE icinde tokenizer'i
#   kirar: "The string is missing the terminator" gibi, gercek sebeple hicbir
#   ilgisi olmayan hatalar verir ve script HIC calismaz.
#
#   2026-08-15'te tam olarak bu yasandi: speaker-enroll.ps1'e bir em-dash
#   girdi, script kullanicinin makinesinde parse hatasiyla dustu. Sozdizimi
#   kontrolu YAPILMISTI — ama pwsh 7 ile, o UTF-8 varsayiyor ve hatayi
#   goremiyor. Yani "test ettim" demek yetmedi, DOGRU YORUMLAYICI ile test
#   etmek gerekti.
#
# Cozum olarak BOM eklemek yerine ASCII sart kosuluyor: depodaki Turkce zaten
# ASCII-lestirilmis ("duser", "cozulemedi"), yani bu kural mevcut uslubun
# devami. Tipik degistirmeler:  —  ->  -      →  ->  ->      …  ->  ...
set -uo pipefail

hatali=0
for f in "$@"; do
  case "$f" in
  *.ps1) ;;
  *) continue ;;
  esac
  [ -f "$f" ] || continue
  # ASCII disi bayt iceren satirlar (LC_ALL=C: bayt bazli eslesme).
  satirlar=$(LC_ALL=C grep -n '[^ -~	]' "$f" || true)
  if [ -n "$satirlar" ]; then
    hatali=1
    echo "ASCII disi karakter: $f" >&2
    echo "$satirlar" | head -5 | sed 's/^/    /' >&2
  fi
done

if [ "$hatali" -ne 0 ]; then
  cat >&2 <<'MSG'

  Windows PowerShell 5.1 BOM'suz dosyalari ANSI okur; ASCII disi bir karakter
  DIZE icindeyse script parse hatasiyla hic calismaz.
  Degistir:   —  ->  -        →  ->  ->        …  ->  ...
MSG
  exit 1
fi
