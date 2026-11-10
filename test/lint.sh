#!/usr/bin/env bash
# Static checks that do not need Home Assistant.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "== bash syntax =="
for file in install/*.sh scripts/*.sh test/*.sh; do
  bash -n "$file"
  echo "  ok $file"
done

if command -v shellcheck >/dev/null 2>&1; then
  echo "== shellcheck =="
  shellcheck -S warning install/*.sh scripts/*.sh test/*.sh
fi

if command -v node >/dev/null 2>&1; then
  echo "== node syntax =="
  for file in app/server/*.js app/web/app.js; do
    node --check "$file"
    echo "  ok $file"
  done
  echo "== unit tests =="
  (cd app && node --test test/unit/*.test.js test/smoke/*.test.js)
else
  echo "node not found – skipping JavaScript checks"
fi
