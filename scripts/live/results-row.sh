# Sourced by gate-series.sh (and the round-trip test in packages/e2e). Writes docs/validation.md results-table rows with every cell placed BY
# HEADER NAME: the header row of that file's Results table is the one definition of the columns, read at call time, never copied here.
# results_header prints the header and its `| --- |` rule; results_row prints one row from ROW_GATE ROW_COMMIT ROW_DATE ROW_HOST ROW_OUTCOME ROW_SPEND ROW_EVIDENCE;
# host_token prints the Host value ("Host tokens" in docs/validation.md). A failure prints cause and action to stderr and returns nonzero, so the caller decides (gate-series.sh: `|| die`, `|| exit 2`).
RR_DOC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/docs/validation.md"

rr_header() { # sets RR_CELLS (trimmed header cells) and RR_LINE
  RR_LINE="$(grep -m1 '^| Gate |' "$RR_DOC" 2>/dev/null)" || { echo "results-row: no Results header (a line starting '| Gate |') in $RR_DOC; restore the table header there, it defines the columns" >&2; return 2; }
  local raw c; IFS='|' read -ra raw <<< "${RR_LINE#|}"; RR_CELLS=()
  for c in "${raw[@]}"; do c="${c#"${c%%[![:space:]]*}"}"; RR_CELLS+=("${c%"${c##*[![:space:]]}"}"); done
}

results_header() {
  rr_header || return 2; printf '%s\n' "$RR_LINE"
  local c rule="|"; for c in "${RR_CELLS[@]}"; do rule+=" --- |"; done; printf '%s\n' "$rule"
}

results_row() {
  rr_header || return 2; local c row="|"
  for c in "${RR_CELLS[@]}"; do
    case "$c" in
      Gate) row+=" ${ROW_GATE?} |" ;;
      Commit) row+=" ${ROW_COMMIT?} |" ;;
      "Date (UTC)") row+=" ${ROW_DATE?} |" ;;
      Host) row+=" ${ROW_HOST?} |" ;;
      Outcome) row+=" ${ROW_OUTCOME?} |" ;;
      "Spend (micros)") row+=" ${ROW_SPEND?} |" ;;
      Evidence) row+=" ${ROW_EVIDENCE?} |" ;;
      *) echo "results-row: unknown column '$c' in the Results header of $RR_DOC; add it to results_row in scripts/live/results-row.sh or revert the header" >&2; return 2 ;;
    esac
  done
  printf '%s\n' "$row"
}

rr_ver() { "$@" 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)+' | head -1; }
host_token() {
  local os dk nd pn gt pv
  os="$(uname -sr 2>/dev/null | tr ' ' '-')"; dk="$(rr_ver docker --version)"; nd="$(rr_ver node --version)"; pn="$(rr_ver pnpm --version)"; gt="$(rr_ver git --version)"; pv="$(rr_ver pi --version)"
  [ -n "$os" ] && [ -n "$dk" ] && [ -n "$nd" ] && [ -n "$pn" ] && [ -n "$gt" ] && [ -n "$pv" ] \
    || { echo "results-row: cannot build the Host token (os='$os' docker='$dk' node='$nd' pnpm='$pn' git='$gt' pi='$pv'); install or fix the failing command and rerun; see \"Host tokens\" in docs/validation.md" >&2; return 1; }
  printf '%s+docker%s+node%s+pnpm%s+git%s+pi%s\n' "$os" "$dk" "$nd" "$pn" "$gt" "$pv"
}
