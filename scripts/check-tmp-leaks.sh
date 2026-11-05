#!/usr/bin/env bash
# Fails if `pnpm test:lite` leaves new pomtreed-*, pomtree-* (pomtree-e2e-*, pomtree-smoke-*, bare pomtree-*, ...), template-dir-*, report-dir-*, hn-live-test-*, vendor-*, hg-*, pi-auth-* or disk-bytes-* dirs in $TMPDIR (default /tmp).
# Tolerance: TMP_LEAK_TOLERANCE (default 5, absorbs concurrent runs). Run manually: scripts/check-tmp-leaks.sh
set -euo pipefail
T="${TMPDIR:-/tmp}"; tol="${TMP_LEAK_TOLERANCE:-5}"
count() { find "$T" -maxdepth 1 \( -name 'pomtreed-*' -o -name 'pomtree-*' -o -name 'template-dir-*' -o -name 'report-dir-*' -o -name 'hn-live-test-*' -o -name 'vendor-*' -o -name 'hg-*' -o -name 'pi-auth-*' -o -name 'disk-bytes-*' \) | wc -l; }
before=$(count)
pnpm test:lite >/dev/null
delta=$(( $(count) - before ))
echo "counted test dirs in $T: delta=$delta (tolerance $tol)"
[ "$delta" -le "$tol" ] || { echo "FAIL: tests leaked temp dirs" >&2; exit 1; }
