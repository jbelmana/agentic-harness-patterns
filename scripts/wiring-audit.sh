#!/bin/bash
# wiring-audit.sh — dead-control sweep: find declared-but-unwired state.
# Usage: wiring-audit.sh <src-dir> [env-example-file]
# Reports: (1) exported symbols with zero non-test references outside their
# defining file; (2) env vars declared in .env.example but never read in src.
# Origin: four P0s in one sweep (an unwired review queue, a dead scanned gate,
# a tool-registry drift) were all the same defect: declared != actual state.
set -uo pipefail

SRC="${1:?usage: wiring-audit.sh <defs-dir> [env-example] [ref-root]}"
ENVX="${2:-}"
# References are searched across REFROOT (default: parent of SRC, i.e. the whole
# src tree) — definitions in services are legitimately consumed by controllers.
REFROOT="${3:-$(dirname "$SRC")}"

echo "== Wiring audit: defs in $SRC, refs across $REFROOT =="
echo
echo "-- 1. Exported symbols with ZERO non-test external references --"
FOUND=0
while IFS=: read -r file sym; do
  [ -z "$sym" ] && continue
  refs=$(rg -l --no-messages -g '!*test*' -g '!*spec*' -g '!*__tests__*' \
    "\b${sym}\b" "$REFROOT" | rg -v -F "$file" | head -1)
  if [ -z "$refs" ]; then
    echo "DEAD?  $file :: $sym"
    FOUND=$((FOUND+1))
  fi
done < <(rg -o --no-messages -g '!*test*' -g '!*spec*' -g '!*__tests__*' \
  'export (?:async )?(?:function|const|class) ([A-Za-z0-9_]{4,})' \
  -r '$1' "$SRC" --no-heading | sort -u)
echo "($FOUND candidates — verify each: dynamic imports, index re-exports, and route registration can be false positives)"
echo
if [ -n "$ENVX" ] && [ -f "$ENVX" ]; then
  echo "-- 2. Env vars declared in $(basename "$ENVX") but never read in $SRC --"
  while read -r var; do
    [ -z "$var" ] && continue
    rg -q --no-messages "process\.env\.${var}\b|env\(['\"]${var}['\"]\)" "$REFROOT" \
      || echo "UNREAD  $var"
  done < <(rg -o '^([A-Z][A-Z0-9_]+)=' -r '$1' "$ENVX" | sort -u)
  echo
  echo "-- 3. Env vars read in $SRC but not declared in $(basename "$ENVX") --"
  while read -r var; do
    [ -z "$var" ] && continue
    rg -q "^${var}=" "$ENVX" || echo "UNDECLARED  $var"
  done < <(rg -o --no-messages 'process\.env\.([A-Z][A-Z0-9_]+)' -r '$1' "$SRC" | sort -u)
fi
echo
echo "Done. Every DEAD?/UNREAD line is a wiring question, not automatically a bug."
