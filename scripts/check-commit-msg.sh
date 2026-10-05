#!/usr/bin/env bash
# Conventional Commits. Changesets ve otomatik changelog buna dayanir.
set -uo pipefail

msg_file="${1:-}"
[ -z "$msg_file" ] && exit 0
[ -f "$msg_file" ] || exit 0

first_line="$(head -1 "$msg_file")"

# Merge / revert / fixup commitlerini gecir
case "$first_line" in
  Merge*|Revert*|fixup!*|squash!*) exit 0 ;;
esac

if printf '%s' "$first_line" | grep -Eq '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9/-]+\))?!?: .{1,}'; then
  exit 0
fi

cat >&2 <<'MSG'
RED: Commit mesaji Conventional Commits formatinda degil.

Beklenen:  <tip>(<kapsam>): <ozet>
Tipler:    feat fix docs style refactor perf test build ci chore revert

Ornek:     feat(gateway): workspace scope'unu session token'a bagla
           fix(memory): pgvector sorgusunda tenant filtresi eksikti
MSG
exit 1
