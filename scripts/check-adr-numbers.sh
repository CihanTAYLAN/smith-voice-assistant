#!/usr/bin/env bash
# ADR numara butunlugu kapisi.
#
# NEDEN VAR: 2026-08-14'te ayni gun IKI numara cakismasi olustu.
#   1) `0004-opaque-provider-blocks.md` (2026-08-12, bir TEST commit'inin yan
#      urunu) ile `0004-personal-context-ingestion.md` (2026-08-14) ayni
#      numarayi paylasti. Ikinci yazar `ls` yapmadan "0003'ten sonrasi bos"
#      varsaydi. ADR 0006 zaten belirsiz bir "ADR 0004" atfi tasiyordu.
#   2) Duzeltmenin uzerinden bir saat gecmeden `0007-live-speech-to-speech.md`
#      ile `0007-mission-control.md` cakisti — bu kez sebep PARALEL calisan iki
#      oturumun birbirinin commit'ini gormemesiydi.
# Yani hata "dikkatsizlik" degil YAPISAL: sonraki bos numara insan/ajan
# hafizasindan turetiliyor ve iki yazar arasinda kilit yok. Talimat tavsiyedir,
# bu kapi garantidir.
#
# Kontroller:
#   1. Yinelenen NNNN prefiksi YOK              (cakismayi dogdugu commit'te yakalar)
#   2. Dosya adindaki numara == ilk satirdaki `# ADR NNNN`
#                                               (yeniden numaralandirmada icerik
#                                                guncellemesi atlanamaz)
#   3. Dizide bosluk varsa UYARI (dusurmez)     (silinen/tasinan ADR olabilir)
#
# Kullanim: bash scripts/check-adr-numbers.sh [dizin]
set -euo pipefail

dir="${1:-docs/decisions}"

if [ ! -d "$dir" ]; then
  echo "check-adr-numbers: dizin yok: $dir" >&2
  exit 1
fi

hata=0
declare -A sahip=()
numaralar=()

for yol in "$dir"/*.md; do
  # Glob hic eslesmezse kabuk deseni oldugu gibi verir.
  [ -e "$yol" ] || continue
  ad="$(basename "$yol")"

  # ADR olmayan dosyalar (README, sablon) sessizce atlanir.
  if [[ ! "$ad" =~ ^([0-9]{4})- ]]; then
    continue
  fi
  no="${BASH_REMATCH[1]}"

  # 1) Yinelenen numara
  if [ -n "${sahip[$no]:-}" ]; then
    echo "HATA: ADR numarasi $no iki dosyada:" >&2
    echo "        ${sahip[$no]}" >&2
    echo "        $ad" >&2
    echo "       Gelen atifi AZ olani sonraki bos numaraya tasi ve" >&2
    echo "       ilk satirdaki '# ADR NNNN' basligini da guncelle." >&2
    hata=1
  else
    sahip[$no]="$ad"
    numaralar+=("$no")
  fi

  # 2) Baslik numarasi dosya adiyla ayni mi
  baslik="$(head -1 "$yol")"
  if [[ "$baslik" =~ ^#[[:space:]]+ADR[[:space:]]+([0-9]{4}) ]]; then
    baslik_no="${BASH_REMATCH[1]}"
    if [ "$baslik_no" != "$no" ]; then
      echo "HATA: $ad ilk satirinda 'ADR $baslik_no' yaziyor, dosya adi $no." >&2
      hata=1
    fi
  else
    echo "HATA: $ad ilk satiri '# ADR NNNN — ...' bicimine uymuyor:" >&2
    echo "        $baslik" >&2
    hata=1
  fi
done

if [ "${#numaralar[@]}" -eq 0 ]; then
  echo "check-adr-numbers: $dir icinde ADR bulunamadi." >&2
  exit 1
fi

# 3) Bosluk kontrolu — UYARI. Silinmis veya bilincli atlanmis numara olabilir,
# bu yuzden kapiyi dusurmez.
IFS=$'\n' sirali=($(printf '%s\n' "${numaralar[@]}" | sort)); unset IFS
ilk=$((10#${sirali[0]}))
son=$((10#${sirali[${#sirali[@]}-1]}))
eksik=()
for ((i = ilk; i <= son; i++)); do
  aranan="$(printf '%04d' "$i")"
  [ -n "${sahip[$aranan]:-}" ] || eksik+=("$aranan")
done
if [ "${#eksik[@]}" -gt 0 ]; then
  echo "UYARI: numara dizisinde bosluk: ${eksik[*]} (dusurmez)" >&2
fi

if [ "$hata" -ne 0 ]; then
  echo "check-adr-numbers: BASARISIZ" >&2
  exit 1
fi

echo "check-adr-numbers: ${#numaralar[@]} ADR, numaralar tutarli. Sonraki bos numara: $(printf '%04d' $((son + 1)))"
