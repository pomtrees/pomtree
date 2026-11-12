#!/usr/bin/env bash
# TODO(wiki-distill-live-validation): this script ran once live (2026-11-12, two readers) and drive.test.mts (fake CLI) exercises it offline. Still unverified: the editorial quality, whether a small model follows the 24-step reader plan at larger reader counts, and what the slice URLs returned given the aborted navigations.
# Operator-run driver for the wiki-distill demo: spawns readers, orchestrator and distiller with the plain `pomtree` CLI
# and choreographs the web UI (`pomtree ui ...`). Spends real money unless the daemon runs the model stub: see README.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKOUT="$(cd "$SCRIPT_DIR/../.." && pwd)"

usage() {
  cat <<'USAGE'
usage: drive.sh --title TITLE --yes [--readers N] [--run-id ID] [--oldid REV] [--slices "0,3;1,4;..."] [--dry-run]

  --title T       Wikipedia article title, e.g. "Byzantine Empire" (required, no default)
  --readers N     number of parallel reader agents, 2..6 (default 4)
  --run-id ID     run stamp [a-z0-9]{4,24} used in every idempotency key and report key (default: from the clock)
  --oldid REV     pin the article revision (default: unpinned)
  --slices S      explicit section indexes per reader, readers separated by ';', e.g. "0,3;1,4;2;5" (count must equal N; default: auto)
  --yes           required to spawn (spends money against the daemon pool); without it the plan, ceiling and pool are printed and exit is 2
  --dry-run       print every command that would run and call nothing (no --yes needed)
  -h, --help      this text

environment: POMTREED_STATE_DIR (required unless WIKI_DISTILL_CLI is set; eval "$(scripts/pomtree-up <repo> --print-env)"),
WIKI_DISTILL_CLI (command words overriding the pomtree binary), WIKI_DISTILL_BUDGETS (budgets file, default budgets.env beside this script),
DRIVE_POLL_S (poll sleep, default 3), READER_TIMEOUT_S (720), ORCH_TIMEOUT_S (900), DIST_TIMEOUT_S (600), WAIT_CHUNK_MS (30000).
Open /ui in a browser first. The driver never reads or prints the operator token.
USAGE
}

die_usage() {
  echo "drive.sh: $1" >&2
  echo "run 'drive.sh --help' for usage" >&2
  exit 2
}

TITLE=""
READERS=4
RUN=""
OLDID="unpinned"
SLICES=""
YES=0
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --title) [ $# -ge 2 ] || die_usage "--title needs a value"; TITLE="$2"; shift 2 ;;
    --readers) [ $# -ge 2 ] || die_usage "--readers needs a value"; READERS="$2"; shift 2 ;;
    --run-id) [ $# -ge 2 ] || die_usage "--run-id needs a value"; RUN="$2"; shift 2 ;;
    --oldid) [ $# -ge 2 ] || die_usage "--oldid needs a value"; OLDID="$2"; shift 2 ;;
    --slices) [ $# -ge 2 ] || die_usage "--slices needs a value"; SLICES="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die_usage "unknown argument '$1'" ;;
  esac
done

[ -n "$TITLE" ] || die_usage "--title is required (for example --title \"Byzantine Empire\")"
[[ "$READERS" =~ ^[0-9]+$ ]] && [ "$READERS" -ge 2 ] && [ "$READERS" -le 6 ] || die_usage "--readers must be an integer from 2 to 6, got '$READERS'"
[ -n "$RUN" ] || RUN="d$(date +%s)"
[[ "$RUN" =~ ^[a-z0-9]{4,24}$ ]] || die_usage "--run-id must match [a-z0-9]{4,24}, got '$RUN'"
[[ "$OLDID" =~ ^([0-9]+|unpinned)$ ]] || die_usage "--oldid must be a revision number, got '$OLDID'"

SLICE_LIST=()
if [ -n "$SLICES" ]; then
  IFS=';' read -r -a SLICE_LIST <<<"$SLICES"
  [ "${#SLICE_LIST[@]}" -eq "$READERS" ] || die_usage "--slices has ${#SLICE_LIST[@]} reader entries but --readers is $READERS; give exactly $READERS entries separated by ';'"
  for i in "${!SLICE_LIST[@]}"; do
    SLICE_LIST[i]="${SLICE_LIST[i]// /}"
    [[ "${SLICE_LIST[i]}" =~ ^[0-9]+(,[0-9]+)*$ ]] || die_usage "--slices entry '${SLICE_LIST[i]}' must be a comma list of section indexes"
  done
fi

BUDGETS="${WIKI_DISTILL_BUDGETS:-$SCRIPT_DIR/budgets.env}"
[ -f "$BUDGETS" ] || { echo "drive.sh: budgets file '$BUDGETS' not found; restore examples/wiki-distill/budgets.env or set WIKI_DISTILL_BUDGETS" >&2; exit 2; }
# shellcheck disable=SC1090
. "$BUDGETS"
for k in MODEL READER_MICROS ORCHESTRATOR_MICROS DISTILLER_MICROS; do
  [ -n "${!k:-}" ] || { echo "drive.sh: $k missing in '$BUDGETS'; add the line $k=<value>" >&2; exit 2; }
done

CEILING=$((READERS * READER_MICROS + ORCHESTRATOR_MICROS + DISTILLER_MICROS))
POOL=$(((CEILING / 100000 + 1) * 100000))
dollars() { printf '$%d.%02d' $(($1 / 1000000)) $(($1 % 1000000 / 10000)); }

TITLE_PARAM="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1].trim().replace(/ +/g, "_")))' "$TITLE")"
SOURCE_URL="https://en.wikipedia.org/wiki/$TITLE_PARAM"
READER_TIMEOUT_S="${READER_TIMEOUT_S:-720}"
ORCH_TIMEOUT_S="${ORCH_TIMEOUT_S:-900}"
DIST_TIMEOUT_S="${DIST_TIMEOUT_S:-600}"
WAIT_CHUNK_MS="${WAIT_CHUNK_MS:-30000}"
POLL_S="${DRIVE_POLL_S:-3}"

echo "plan: distill '$TITLE' ($SOURCE_URL, revision $OLDID), run $RUN"
echo "  $READERS readers x $(dollars "$READER_MICROS"), orchestrator $(dollars "$ORCHESTRATOR_MICROS"), distiller $(dollars "$DISTILLER_MICROS"), model $MODEL"
echo "  ceiling: $CEILING micros ($(dollars "$CEILING")) = $READERS*$READER_MICROS + $ORCHESTRATOR_MICROS + $DISTILLER_MICROS"
echo "  recommended daemon pool: POMTREED_BUDGET_ROOT_MICROS=$POOL POMTREED_BUDGET_TOP_LEVEL_MICROS=$POOL (the daemon refuses to start if the top-level cap, default 5000000, exceeds the pool; a spawn above the pool's remainder is refused, so the pool is the hard ceiling)"
if [ "$YES" -ne 1 ] && [ "$DRY" -ne 1 ]; then
  echo "drive.sh: not spawning without --yes; review the plan above, set the pool, then rerun with --yes (or use --dry-run to see the commands)" >&2
  exit 2
fi

# Resolve the pomtree command.
PTREE=()
if [ -n "${WIKI_DISTILL_CLI:-}" ]; then
  read -r -a PTREE <<<"$WIKI_DISTILL_CLI"
elif command -v pomtree >/dev/null 2>&1; then
  PTREE=(pomtree)
else
  PTREE=(node "$CHECKOUT/packages/pomtree/src/main.ts")
fi
if [ -z "${WIKI_DISTILL_CLI:-}" ] && [ -z "${POMTREED_STATE_DIR:-}" ] && [ "$DRY" -ne 1 ]; then
  echo "drive.sh: POMTREED_STATE_DIR is not set, so pomtree cannot find the daemon; run: eval \"\$(scripts/pomtree-up <repo> --print-env)\" and rerun" >&2
  exit 2
fi

SPAWNED=()
PROBED=0
UI_N=0
DUMMY_N=0
PT_OUT=""
PT_RC=0

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "$rc" -ne 0 ] && [ "$DRY" -ne 1 ]; then
    if [ "$PROBED" -eq 1 ]; then ui_cmd follow off || true; fi
    if [ "${#SPAWNED[@]}" -gt 0 ]; then
      echo "drive.sh: failed (exit $rc); agents it spawned are NOT cancelled automatically. To stop them:" >&2
      for id in "${SPAWNED[@]}"; do echo "  pomtree cancel $id" >&2; done
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Print a command with `+ ` and only the first 80 characters of task text.
show() {
  local out="+ pomtree" prev="" a
  for a in "$@"; do
    if [ "$prev" = "--task" ]; then
      a="$(printf '%s' "$a" | tr '\n' ' ')"
      [ "${#a}" -le 80 ] || a="${a:0:80}..."
      a="'$a'"
      prev=""
    else
      prev="$a"
    fi
    out+=" $a"
  done
  printf '%s\n' "$out"
}

# Run pomtree; sets PT_OUT (stdout) and PT_RC. Dry run prints only.
pt() {
  show "$@"
  if [ "$DRY" -eq 1 ]; then PT_OUT=""; PT_RC=0; return 0; fi
  PT_OUT="$("${PTREE[@]}" "$@")" && PT_RC=0 || PT_RC=$?
}

# `pomtree ui <args>` with a deterministic, per-call key. Returns the exit code; sets UI_TABS.
UI_TABS=""
ui_cmd() {
  UI_N=$((UI_N + 1))
  local joined="$*" slug
  slug="${joined//[^a-zA-Z0-9]/-}"
  slug="${slug:0:60}"
  pt ui "$@" --key "wd-$RUN-ui-$UI_N-$slug"
  UI_TABS=""
  if [ "$DRY" -eq 1 ]; then return 0; fi
  UI_TABS="$(printf '%s\n' "$PT_OUT" | sed -n 's/.* to \([0-9][0-9]*\) tab.*/\1/p' | head -n 1)"
  return "$PT_RC"
}

# A UI command is a show: a failure warns, the pipeline carries on. There is no ack (see the ui-command-ack tag in packages/pomtreed/src/builtin/uiDrive.ts), so a sent command is assumed applied by the tab(s).
ui() {
  ui_cmd "$@" || echo "drive.sh: warning: 'pomtree ui $*' failed (exit $PT_RC); continuing, the UI is only the show" >&2
}

jget() { printf '%s' "$PT_OUT" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let j;
  try { j = JSON.parse(s); } catch { process.exit(3); }
  const r = j.record ?? {};
  const f = process.argv[1];
  if (f === "done") process.stdout.write(j.done ? "yes" : "no");
  else if (f === "state") process.stdout.write(String(r.state ?? ""));
  else if (f === "exit") process.stdout.write(String(r.exit ?? ""));
  else if (f === "summary") process.stdout.write(typeof r.result?.summary === "string" ? r.result.summary : "");
});' "$1"; }

# spawn_agent <template> <name> <key-suffix> <micros> <task>: sets SPAWN_ID (no subshell, so SPAWNED survives).
SPAWN_ID=""
spawn_agent() {
  local template="$1" name="$2" suffix="$3" micros="$4" task="$5" id
  pt spawn --template "$template" --task "$task" --name "$name" --budget "$micros" --key "wd-$RUN-$suffix"
  [ "$PT_RC" -eq 0 ] || { echo "drive.sh: spawn of $name failed (exit $PT_RC); read the daemon message above (budget pool too small and key reuse are the usual causes) and fix it" >&2; exit 1; }
  if [ "$DRY" -eq 1 ]; then
    DUMMY_N=$((DUMMY_N + 1))
    id="$(printf 'ag-%026x' "$DUMMY_N")"
  else
    id="$PT_OUT"
  fi
  [[ "$id" =~ ^ag-[0-9a-f]+$ ]] || { echo "drive.sh: spawn of $name printed '$id', not an agent id; update pomtree or check the daemon" >&2; exit 1; }
  SPAWNED+=("$id")
  SPAWN_ID="$id"
}

# wait_once <id>: one `pomtree wait` chunk; sets W_STATE, W_EXIT, W_SUMMARY. Returns 0 when the agent is done, 1 when still running; exits on other errors.
W_STATE="" W_EXIT="" W_SUMMARY=""
wait_once() {
  local id="$1"
  W_STATE="" W_EXIT="" W_SUMMARY=""
  pt --json wait "$id" --timeout "$WAIT_CHUNK_MS"
  if [ "$DRY" -eq 1 ]; then
    W_STATE=exited W_EXIT=succeeded W_SUMMARY="<handoff of $id>"
    return 0
  fi
  if [ "$PT_RC" -eq 0 ] && [ "$(jget done)" = "yes" ]; then
    W_STATE="$(jget state)" W_EXIT="$(jget exit)" W_SUMMARY="$(jget summary)"
    return 0
  fi
  if [ "$PT_RC" -ne 0 ] && [ "$PT_RC" -ne 7 ]; then
    echo "drive.sh: 'pomtree wait $id' failed (exit $PT_RC); check the daemon with 'pomtree ps' and rerun" >&2
    exit 1
  fi
  return 1
}

# wait_agent <id> <timeout-s>: loops wait_once until done (0) or the deadline (1).
wait_agent() {
  local id="$1" limit="$2" deadline=$((SECONDS + $2))
  while ! wait_once "$id"; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "drive.sh: $id did not finish within ${limit}s; it is still running: inspect it with 'pomtree tree', stop it with 'pomtree cancel $id', or raise the matching *_TIMEOUT_S" >&2
      return 1
    fi
    sleep "$POLL_S"
  done
}

# 1. Probe: open /ui in a browser first. `ui reset` is harmless and reports the connected tab count.
ui_cmd reset && rc=0 || rc=$?
if [ "$rc" -eq 3 ] || { [ "$DRY" -ne 1 ] && [ "$rc" -eq 0 ] && [ "${UI_TABS:-0}" -eq 0 ]; }; then
  echo "drive.sh: no UI tab is connected: open /ui in the browser, then rerun" >&2
  exit 1
elif [ "$rc" -ne 0 ]; then
  echo "drive.sh: 'pomtree ui reset' failed (exit $rc); check the daemon and POMTREED_STATE_DIR (eval \"\$(scripts/pomtree-up <repo> --print-env)\"), then rerun" >&2
  exit 1
fi
PROBED=1
if [ "${UI_TABS:-1}" -gt 1 ]; then
  echo "note: $UI_TABS UI tabs are connected; every command goes to all of them"
fi

# 2. Readers: follow is on before the first spawn. Operator spawns have the root supervisor as parent, so plain `follow on` (no --of) matches them.
ui follow on --views terminal,browser
READER_IDS=()
for ((r = 1; r <= READERS; r++)); do
  r0=$((r - 1))
  sections="auto"
  [ "${#SLICE_LIST[@]}" -eq 0 ] || sections="${SLICE_LIST[r0]}"
  # TODO(wiki-distill-fetch-reader): readers are audited-public browser agents; there is no host-confined fetch path, so the wikipedia-only rule rests on the reader prompt.
  task="ARTICLE: $TITLE
TITLE_PARAM: $TITLE_PARAM
READER: $r0 OF $READERS
OLDID: $OLDID
SECTIONS: $sections"
  spawn_agent wiki-reader "wiki-reader-$r" "reader-$r" "$READER_MICROS" "$task"
  id="$SPAWN_ID"
  READER_IDS+=("$id")
  echo "reader $r spawned: $id"
  ui open terminal "$id"
  ui open browser "$id"
done
ui follow off
ui arrange grid

# 3. Collect the reader notes.
BLOCKS=""
OK_READERS=0
REV_FOUND=""
for ((r = 1; r <= READERS; r++)); do
  id="${READER_IDS[r - 1]}"
  r0=$((r - 1))
  if wait_agent "$id" "$READER_TIMEOUT_S" && [ "$W_EXIT" = "succeeded" ] && [ -n "$W_SUMMARY" ]; then
    text="$W_SUMMARY"
    if [ -z "$REV_FOUND" ]; then REV_FOUND="$(printf '%s\n' "$W_SUMMARY" | sed -n 's/^REV: \([0-9][0-9]*\)$/\1/p' | head -n 1)"; fi
    OK_READERS=$((OK_READERS + 1))
  else
    text="NOT READ: reader $r0 failed (${W_EXIT:-${W_STATE:-timeout}})"
    echo "warning: $text" >&2
  fi
  BLOCKS+="=== BLOCK $r ===
$text
=== END BLOCK $r ===
"
  ui close browser "$id"
done
if [ "$OK_READERS" -eq 0 ]; then
  echo "drive.sh: all $READERS readers failed or returned nothing; check 'pomtree tree' and the reader traces (egress to en.wikipedia.org, budget), fix the cause, then rerun with a new --run-id. Cancel leftovers with 'pomtree cancel <id>'" >&2
  exit 1
fi

# 4. Orchestrator: follow --of must be set right after the spawn, before its first child.
otask="RUN: $RUN
ARTICLE: $TITLE
SOURCE_URL: $SOURCE_URL
BLOCKS: $READERS
$BLOCKS"
spawn_agent wiki-orchestrator wiki-orchestrator orchestrator "$ORCHESTRATOR_MICROS" "$otask"
ORCH="$SPAWN_ID"
echo "orchestrator spawned: $ORCH"
ui open terminal "$ORCH"
ui focus terminal "$ORCH"
ui follow on --views terminal --of "$ORCH"
SEEN=" "
orch_done=0
orch_deadline=$((SECONDS + ORCH_TIMEOUT_S))
while :; do
  # Explicit opens are an idempotent backup for children whose spawn frame the tab missed.
  pt --json ps --parent "$ORCH"
  if [ "$DRY" -ne 1 ] && [ "$PT_RC" -eq 0 ]; then
    kids="$(printf '%s' "$PT_OUT" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{for(const a of JSON.parse(s))console.log(a.id)}catch{}})')"
    for kid in $kids; do
      case "$SEEN" in *" $kid "*) continue ;; esac
      SEEN+="$kid "
      ui open terminal "$kid"
    done
  fi
  if wait_once "$ORCH"; then orch_done=1; break; fi
  [ "$SECONDS" -lt "$orch_deadline" ] || break
  sleep "$POLL_S"
done
ui follow off
if [ "$orch_done" -ne 1 ]; then
  echo "drive.sh: orchestrator $ORCH did not finish within ${ORCH_TIMEOUT_S}s; inspect with 'pomtree tree' and stop it with 'pomtree cancel $ORCH'" >&2
  exit 1
fi
if [ "$W_EXIT" != "succeeded" ] || [ -z "$W_SUMMARY" ]; then
  echo "drive.sh: orchestrator ended '${W_EXIT:-$W_STATE}' with ${W_SUMMARY:+a}${W_SUMMARY:-no} handoff; read 'pomtree tree' and its trace, fix the cause, then rerun with a new --run-id" >&2
  exit 1
fi
BRIEFS="$W_SUMMARY"

# 5. Distiller. An unpinned run records the revision the readers saw (their REV: line); a pinned --oldid wins.
REVISION="$OLDID"
if [ "$OLDID" = "unpinned" ] && [ -n "$REV_FOUND" ]; then REVISION="$REV_FOUND"; fi
REPORT_KEY="wd-$RUN-distillation"
dtask="RUN: $RUN
ARTICLE: $TITLE
SOURCE_URL: $SOURCE_URL
REVISION: $REVISION
REPORT_KEY: $REPORT_KEY
$BRIEFS"
spawn_agent wiki-distiller wiki-distiller distiller "$DISTILLER_MICROS" "$dtask"
DIST="$SPAWN_ID"
echo "distiller spawned: $DIST"
ui open terminal "$DIST"
if ! wait_agent "$DIST" "$DIST_TIMEOUT_S" || [ "$W_EXIT" != "succeeded" ]; then
  echo "drive.sh: distiller $DIST ended '${W_EXIT:-${W_STATE:-timeout}}' without finishing; inspect its trace, then rerun with a new --run-id (cancel with 'pomtree cancel $DIST')" >&2
  exit 1
fi

# 6. Find and open the report.
RID=""
if [ "$DRY" -eq 1 ]; then
  pt --json report list "$DIST"
  RID="$(printf '%064x' 0)"
else
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pt --json report list "$DIST"
    RID="$(printf '%s' "$PT_OUT" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const a=JSON.parse(s).find((x)=>x.name==="distillation.html"&&/^[0-9a-f]{64}$/.test(x.id));if(a)process.stdout.write(a.id)}catch{}})')"
    [ -z "$RID" ] || break
    sleep "$POLL_S"
  done
  [ -n "$RID" ] || { echo "drive.sh: the distiller exited but published no distillation.html; check 'pomtree report list $DIST' and its trace, then rerun with a new --run-id" >&2; exit 1; }
fi
ui open report "$DIST" "$RID"
ui follow off

echo
echo "done. report id: $RID (agent $DIST)"
echo "reopen the report window:  pomtree ui open report $DIST $RID"
echo "spend and tree:            pomtree spend ; pomtree tree"
echo "cleanup (not run by this script):"
echo "  pomtree report rm $DIST $RID"
echo "  pomtree ui reset"
