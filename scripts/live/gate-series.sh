#!/usr/bin/env bash
# Run a caller-chosen LIST of live Gate items back to back under the runbook's money rules. Spends real money; see scripts/live/README.md.
# Usage: gate-series.sh --out <root> --prior-micros N [--grant N] [--stop-on-failure] [--dry-run] <item>...   |   gate-series.sh --out <root> --resume [--grant N] [flags] <same items>
# Items: ins3 | bud1 | cus1 | rec1 | yld1 | egr2 (repeat an item to repeat the run). BUD-2 is a post-hoc read, not a run, and has no driver.
# Phases: preflight and a zero-spend smoke (refuse on any failure, before the key is used), then the items in order. Three outcomes, three exit codes:
#   a failed item is reported at once and the series CONTINUES (--stop-on-failure to stop; exit 1 at the end);
#   a spend rule PAUSES the series, resumable only with an explicit --grant N of further quota (exit 3; a pause is not a failure);
#   a leak, or spend/leak state that cannot be determined, STOPS it for investigation (exit 4); 0 means every item passed; 2 is a refusal.
# Needs: what the drivers need (Docker, POMTREED_AGENT_IMAGE, POMTREED_MODEL_KEY_FILE; the key file is only tested for mode and blank lines by count, never read or printed).
# Calls ins3.sh, relay.sh and harness.sh unchanged and reads their run directories. Its only Docker calls are read-only (info, image inspect, label listings).
# Writes <root>/series.tsv (the ledger: resume state), <root>/rows.md (docs/validation.md's results-table header, then one row per attempt, for pasting; this script only appends to that file) and <root>/NN-<item>/ run directories.
# Rules (scripts/live/README.md, "Runbook: live runs"): one retry, only after exit 2 with spend < 50000 micros; pause when a run spends > 50000 micros and is not clean;
# authorization starts at 2,000,000 micros cumulative (the stop-and-ask) and grows only by --grant; no item starts if prior spend + its ceiling would pass it.
# Like pomtreed's budget pause (a refused call, a budget_raise approval, `pomtree decide ... --grant`), exhausting it parks the series; it never overspends silently.
# Never enable `set -x`; the key file's contents are never read here.
SP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -u
source "$SP/results-row.sh"

SOFT=2000000; HARD=2500000; STOP_SPEND=50000   # SOFT: the standing authorization; HARD: the total these constants allow, only warned about

usage() { sed -n '3p' "$0" | cut -c3-; exit 2; }
die() { echo "gate-series: $*" >&2; exit 2; }
isint() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
fmt() { if [ "$1" -ge 3600 ]; then printf '%dh%02dm' $(($1 / 3600)) $(($1 % 3600 / 60)); elif [ "$1" -ge 60 ]; then printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); else printf '%ds' "$1"; fi; }

OUT=""; PRIOR=""; GRANT=""; DRY=0; RESUME=0; STOPFAIL=0; SPECS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:-}"; shift 2 ;;
    --prior-micros) PRIOR="${2:-}"; shift 2 ;;
    --resume) RESUME=1; shift ;;
    --stop-on-failure) STOPFAIL=1; shift ;;
    --grant) GRANT="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage ;;
    --*) die "unknown option $1; see --help" ;;
    *) SPECS+=("$1"); shift ;;
  esac
done
[ -n "$OUT" ] || die "--out <root> is required (the directory for run directories, the ledger and the rows)"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
[ ${#SPECS[@]} -gt 0 ] || die "no items: this script never runs a list you did not choose; pass items (see --help)"
[ -z "$PRIOR" ] || isint "$PRIOR" || die "--prior-micros must be a whole number of micros"
[ -z "$GRANT" ] || isint "$GRANT" || die "--grant must be a whole number of micros (0 acknowledges a pause without adding quota)"

# item_info <kind> <run dir>: sets I_ID, CEIL (worst-case spend: the driver's own budget cap; bud1's is 25x its observed ~4,100 because the demo's root budget is not a cap),
# MEASURED (yes: one JSON field of the run's own accounting; no: charged at CEIL), CMD (the driver call) and ENTRY (files the driver runs, checked by the smoke).
item_info() {
  local rd="${2:-}"
  case "$1" in
    ins3) I_ID="INS-3"; CEIL=60000; MEASURED=yes; CMD=(bash "$SP/ins3.sh" "$rd"); ENTRY=(scripts/pomtree-up packages/pomtree/src/main.ts) ;;
    cus1) I_ID="CUS-1"; CEIL=120000; MEASURED=yes; CMD=(bash "$SP/relay.sh" "$rd" 2 120000 30000 cus1); ENTRY=(scripts/pomtree-up packages/pomtree/src/main.ts) ;;
    bud1) I_ID="BUD-1"; CEIL=100000; MEASURED=no; CMD=(bash "$SP/harness.sh" "$rd" bud1); ENTRY=(packages/e2e/src/demo/escalation-chain.ts) ;;
    rec1) I_ID="REC-1"; CEIL=180000; MEASURED=no; CMD=(bash "$SP/harness.sh" "$rd" rec1); ENTRY=(packages/e2e/src/crash-recovery-live-multi.ts "$SP/rec1-poll.mjs") ;;
    yld1) I_ID="YLD-1"; CEIL=150000; MEASURED=no; CMD=(bash "$SP/harness.sh" "$rd" yld1); ENTRY=(packages/e2e/src/demo/yield-resume.ts) ;;
    egr2) I_ID="EGR-2"; CEIL=200000; MEASURED=yes; CMD=(bash "$SP/harness.sh" "$rd" egr2); ENTRY=(examples/hn-digest/content-live.mts) ;;
    bud2) return 2 ;;
    *) return 1 ;;
  esac
}
for s in "${SPECS[@]}"; do
  item_info "$s"; case $? in 0) ;; 2) die "bud2 (BUD-2, journaled cost versus the provider's bill) is a post-hoc read of a finished run, not a run; there is no driver for it" ;; *) die "unknown item '$s'; items: ins3 bud1 cus1 rec1 yld1 egr2" ;; esac
done

REPO="${POMTREE_LIVE_REPO-}"; REPO="${REPO:-$(cd "$SP/../.." && pwd)}"
COMMIT="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)" || die "cannot read the base commit of $REPO; run from a git checkout or set POMTREE_LIVE_REPO"
[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no 2>/dev/null)" ] || COMMIT="$COMMIT+dirty"
LEDGER="$OUT/series.tsv"; ROWS="$OUT/rows.md"; LIST="${SPECS[*]}"

# Ledger: header "#gate-series prior=<N> list=<items>", then one TSV line per attempt: pos item attempt date outcome rc spend final secs.
# outcome "pending" (spend "?") marks an attempt started and not finished; final=yes means the item is done and resume skips it.
# Two comment-line kinds carry the pause state: "#grant N date" (authorization = SOFT + all grants) and "#pause rule cum auth next item ceiling" (parked on spend until a later #grant).
if [ "$RESUME" = 1 ]; then
  [ -s "$LEDGER" ] || die "--resume given but $LEDGER does not exist; start a series without --resume"
  head1="$(head -n1 "$LEDGER")"
  [ "${head1#\#gate-series prior=}" != "$head1" ] || die "$LEDGER is not a gate-series ledger"
  LPRIOR="${head1#\#gate-series prior=}"; LPRIOR="${LPRIOR%% *}"
  [ "${head1#*list=}" = "$LIST" ] || die "the item list differs from the ledger's ('${head1#*list=}'); resume with the original list"
  [ -z "$PRIOR" ] || [ "$PRIOR" = "$LPRIOR" ] || die "--prior-micros $PRIOR differs from the ledger's $LPRIOR; omit it on resume"
  PRIOR="$LPRIOR"
  PARKED="$(awk '/^#pause/ {p = $0} /^#grant/ {p = ""} END {print p}' "$LEDGER")"
  if [ -n "$PARKED" ] && [ -z "$GRANT" ] && [ "$DRY" = 0 ]; then
    IFS=$'\t' read -r _ prule pcum pauth pnp pni pnc <<< "$PARKED"
    echo "gate-series: the series is parked on spend, not failed: $prule" >&2
    echo "  spent so far: $pcum micros; authorization: $pauth micros; next: $([ "$pnp" = 0 ] && echo "nothing" || echo "[$pnp] $pni, ceiling $pnc micros")" >&2
    die "resume needs an explicit grant: add --grant <micros> of further quota (0 only to acknowledge a review pause); it is never assumed"
  fi
  awk -F'\t' '!/^#/ && $7 !~ /^[0-9]+$/ {bad=1} END {exit !bad}' "$LEDGER" \
    && die "the ledger has an attempt with undetermined spend (pending or '?'; fail closed, so a grant does not clear it): read that run directory, replace the spend with the figure in $LEDGER and set the last-but-one column (final) to yes to skip the item or no to rerun it, then resume"
else
  isint "$PRIOR" || die "--prior-micros N is required: the live spend already used (sum of the results table; 0 only if truly none), so the SOFT and HARD rules count the whole budget; the figure is stated in docs/validation.md"
  [ ! -e "$OUT" ] || [ "$DRY" = 1 ] || die "$OUT already exists; evidence is never overwritten. Continue that series with --resume, or use a new --out"
fi
ledger_done() { awk -F'\t' -v p="$1" '!/^#/ && $1 == p && $8 == "yes" {f=1} END {exit !f}' "$LEDGER" 2>/dev/null; }
for i in "${!SPECS[@]}"; do
  old="$(awk -F'\t' -v p="$((i + 1))" '!/^#/ && $1 == p {print $2; exit}' "$LEDGER" 2>/dev/null)"
  [ -z "$old" ] || [ "$old" = "${SPECS[$i]}" ] || die "position $((i + 1)) was run as '$old' but the list now has '${SPECS[$i]}'; resume with the original list"
done

# Authorization: SOFT plus every grant recorded in the ledger plus this invocation's --grant (recorded only once preflight and smoke have passed, so a refusal never banks it).
LGRANTS=0; [ ! -s "$LEDGER" ] || LGRANTS="$(awk -F'\t' '/^#grant/ {s += $2} END {print s + 0}' "$LEDGER")"
AUTH=$((SOFT + LGRANTS + ${GRANT:-0}))
CUM=$PRIOR; [ ! -s "$LEDGER" ] || CUM=$((PRIOR + $(awk -F'\t' '!/^#/ {s += $7} END {print s + 0}' "$LEDGER")))
REMAIN=0; for i in "${!SPECS[@]}"; do ledger_done $((i + 1)) || { item_info "${SPECS[$i]}"; REMAIN=$((REMAIN + CEIL)); }; done
echo "gate-series: $([ "$DRY" = 1 ] && echo dry || echo real)$([ "$RESUME" = 1 ] && echo " (resume)"), ${#SPECS[@]} items, base commit $COMMIT, out $OUT"
echo "  spent so far $CUM micros; authorization $AUTH micros ($SOFT standing + $((LGRANTS + ${GRANT:-0})) granted); ceilings of unfinished items total $REMAIN"
[ $((CUM + REMAIN)) -le "$AUTH" ] || echo "  forecast: the ceilings (worst case, not an estimate of spend) pass the authorization by $((CUM + REMAIN - AUTH)) micros; the series will pause before an item that cannot fit, and --grant resumes it"
[ "$AUTH" -le "$HARD" ] || echo "  note: this authorization exceeds the $HARD micros total in scripts/live/README.md; raising it means editing HARD in this script"

# stores: the store_id of every container and volume on the host that carries one (the daemon's ownership label on sandboxes, egress sidecars and their
# socket volumes). Prints sorted unique ids; fails if Docker cannot be queried.
stores() {
  { docker ps -a --filter label=store_id --format '{{.Label "store_id"}}' && docker volume ls --filter label=store_id --format '{{.Label "store_id"}}'; } 2>/dev/null | sed '/^$/d' | sort -u
  [ "${PIPESTATUS[0]}" = 0 ]
}
# leakcheck <rundir> <rc> <stores-before-file>: sets L_STATE (clean|leak|unknown) and L_WHY. A leak is a labelled container or volume whose store_id did not
# exist when this attempt started (so other Docker work, including a daemon already running, is ignored) or a key-leak match in the run directory.
# Known gap: a different daemon that starts during the attempt and still has containers at the end reads as a leak (a false stop, never a missed leak).
leakcheck() {
  local R="$1" rc="$2" now new n
  L_STATE=clean; L_WHY="no new store-labelled containers or volumes, 0 key-leak files"
  now="$(stores)" || { L_STATE=unknown; L_WHY="docker could not be queried for store labels"; return; }
  new="$(comm -13 "$3" <(printf '%s\n' "$now" | sed '/^$/d') | tr '\n' ' ')"
  [ -z "$new" ] || { L_STATE=leak; L_WHY="containers or volumes remain with store_id: $new"; return; }
  { [ "$rc" = 2 ] || [ "$rc" = 9 ]; } && return
  [ -r "$R/leak-files.rundir" ] || { L_STATE=unknown; L_WHY="leak-files.rundir missing (the key-leak grep did not finish)"; return; }
  n="$(wc -l < "$R/leak-files.rundir")"
  [ "$n" = 0 ] || { L_STATE=leak; L_WHY="$n run-directory files matched the key-leak grep (counts only; files listed in leak-files.rundir)"; return; }
  if [ -r "$R/series-driver.log" ] && [ "$(grep -c '^STOP:' "$R/series-driver.log")" != 0 ]; then L_STATE=leak; L_WHY="the driver printed a STOP line (see series-driver.log)"; fi
}

# Preflight and smoke: zero spend, each failure a refusal naming the cause and the action. Real runs only; a dry run prints the plan and checks none of this.
preflight() {
  local v kf="$POMTREED_MODEL_KEY_FILE" mode lbl full drift IMGSRC IMG_WHY
  docker info >/dev/null 2>&1 || die "Docker is not reachable; start the daemon (or fix DOCKER_HOST) and rerun"
  docker image inspect "$POMTREED_AGENT_IMAGE" >/dev/null 2>&1 || die "agent image '$POMTREED_AGENT_IMAGE' is not present locally; build it from the committed HEAD (scripts/live/README.md) and rerun"
  lbl="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$POMTREED_AGENT_IMAGE" 2>/dev/null | tr -d '\r\n')"; full="$(git -C "$REPO" rev-parse HEAD)"
  # The image must match the code the runs execute. Requiring the label to BE HEAD also forbade committing anything during a
  # series: recording a results row moves HEAD, so the next item refused to start and the rule "commit after each item" and
  # this check could not both be honoured. So accept a label that is an ancestor of HEAD when nothing the image is built from
  # changed in between; a docs or results-log commit is then fine, while a change to the image's own sources still refuses.
  # IMGSRC is everything the image is built from: the Dockerfile's COPY set (agent-image, sandbox-docker's proxy sources,
  # packages/pomtree, and packages/harness-pi/src/agent-guide.md), pomtree's one workspace dep (packages/core), and the two root
  # files build.ts reads (tsconfig.base.json for the bundle compile, package.json for the version it bakes). Widen it if the
  # build context widens. packages/observe is deliberately NOT here: pomtree does not depend on it, so it is not in the image.
  IMGSRC="packages/agent-image packages/sandbox-docker packages/pomtree packages/core packages/harness-pi/src/agent-guide.md tsconfig.base.json package.json"
  case "$full" in
    "${lbl:-no-label}"*) IMG_WHY="revision label matches HEAD (${COMMIT%+dirty})" ;;
    *)
      [ -n "$lbl" ] || die "the agent image '$POMTREED_AGENT_IMAGE' carries no org.opencontainers.image.revision label; rebuild it from this commit and rerun"
      git -C "$REPO" merge-base --is-ancestor "$lbl" HEAD 2>/dev/null \
        || die "agent image revision label '$lbl' is not an ancestor of HEAD ($COMMIT), so the image was not built from this history; rebuild it from this commit and rerun"
      drift="$(git -C "$REPO" diff --name-only "$lbl" HEAD -- $IMGSRC 2>/dev/null | tr '\n' ' ')"
      [ -z "$drift" ] || die "agent image revision label '$lbl' is behind HEAD ($COMMIT) and the image's own sources changed in between ($drift); rebuild the image from this commit and rerun"
      IMG_WHY="revision label $lbl is an ancestor of HEAD ($COMMIT) and no image source changed since ($IMGSRC)" ;;
  esac
  # The dirty-tree guard covers the same set as IMGSRC: an uncommitted edit to pomtree or core is baked into no image yet but IS
  # run from the working tree, so it would silently differ from what the image holds. It used to cover only the first two.
  [ -z "$(git -C "$REPO" status --porcelain --untracked-files=no -- $IMGSRC 2>/dev/null)" ] \
    || die "an image source has uncommitted changes (the gate rejects a dirty tree): $(git -C "$REPO" status --porcelain --untracked-files=no -- $IMGSRC | tr -s ' \n' ' '); commit or stash them, rebuild the image and rerun"
  command -v pi >/dev/null 2>&1 || die "no host 'pi' on PATH; install it (the drivers need it) and rerun"
  for v in POMTREED_MODEL_BASE_URL POMTREED_MODEL_UPSTREAM_KEY_FILE POMTREED_PI_PROVIDER OPENROUTER_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY; do
    [ -z "${!v+x}" ] || die "$v is set in this shell (value not shown); the drivers set the model environment themselves, so unset it and rerun"
  done
  { [ -f "$kf" ] && [ -s "$kf" ]; } || die "POMTREED_MODEL_KEY_FILE is not a non-empty regular file; fix the path (the file is never read here)"
  mode="$(stat -c %a "$kf" 2>/dev/null || stat -f %Lp "$kf" 2>/dev/null)"
  [ "$mode" = 600 ] || die "the key file has mode ${mode:-unknown}, not 600; run chmod 600 on it and rerun"
  [ "$(grep -c '^$' "$kf" 2>/dev/null)" = 0 ] || die "the key file has a blank line (the drivers refuse that); remove it and rerun"
  echo "preflight ok: docker, $IMG_WHY, pi, model env unset, key file 0600 without blank lines"
}
# smoke: proves the drivers are not stale in the ways cheap to check. It never uses the real key: the one driver run uses an empty dummy key file.
smoke() {
  local t0=$SECONDS d f sd="$OUT/smoke" rc
  [ ! -e "$sd/ok" ] || { echo "smoke: already passed in this series, skipped"; return; }
  mkdir -p "$sd"
  for d in ins3 relay harness stack; do bash -n "$SP/$d.sh" || die "driver $d.sh has a syntax error; fix it (it belongs to the live-run lane) and rerun"; done
  for s in "${SPECS[@]}"; do item_info "$s"; for f in "${ENTRY[@]}"; do
    case "$f" in /*) ;; *) f="$REPO/$f" ;; esac
    [ -e "$f" ] || die "driver for '$s' runs $f, which no longer exists at this commit; the driver is stale: update it and rerun"
  done; done
  case " $LIST " in *" egr2 "*)
    : > "$sd/dummy.key"; chmod 600 "$sd/dummy.key"; stores > "$sd/stores.before" || die "docker could not be queried for store labels"
    POMTREED_MODEL_KEY_FILE="$sd/dummy.key" bash "$SP/harness.sh" "$sd/egr2smoke" egr2smoke > "$sd/driver.log" 2>&1; rc=$?
    leakcheck "$sd/egr2smoke" "$rc" "$sd/stores.before"
    [ "$rc" = 0 ] || die "the zero-spend browser smoke (egr2smoke) exited $rc; read $sd/driver.log and $sd/egr2smoke/run.log, fix the cause (full image needed) and rerun"
    [ "$L_STATE" = clean ] || die "the browser smoke left a leak or an unreadable state: $L_WHY; clean up by hand and rerun" ;;
  esac
  : > "$sd/ok"; echo "smoke ok in $(fmt $((SECONDS - t0))): drivers parse, their entry files exist, $(case " $LIST " in *" egr2 "*) echo "browser smoke passed" ;; *) echo "no browser smoke (egr2 not listed)" ;; esac)"
}

# measure <rundir> <kind> <rc>: sets M_SPEND (whole micros, or "?") and M_WHY. Exit 2 or 9 is a pre-start refusal in the drivers: nothing spent.
# An unmeasured kind is charged its ceiling (a safe over-count); a measured kind reads one JSON field, and any parse failure is "?".
measure() {
  local R="$1" kind="$2" rc="$3" f="" field=""
  M_SPEND="?"; M_WHY=""
  { [ "$rc" = 2 ] || [ "$rc" = 9 ]; } && { M_SPEND=0; M_WHY="exit $rc is a pre-start refusal"; return; }
  if [ "$MEASURED" = no ]; then M_SPEND="$CEIL"; M_WHY="charged at the ceiling, not measured"; return; fi
  case "$kind" in ins3|cus1) f="$R/spend.json"; field=totalSpendMicros ;; egr2) f="$R/digest/cost-ledger.json"; field=totalMicros ;; esac
  M_SPEND="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const n=s[process.argv[2]];if(!Number.isSafeInteger(n)||n<0)process.exit(1);console.log(n)' "$f" "$field" 2>/dev/null)" \
    || { M_SPEND="?"; M_WHY="$(basename "$f") missing or without a whole-number $field"; return; }
  M_WHY="measured"
}

# judge <rc> <spend> <leak> <attempt>: sets OUTCOME, ACTION (next|retry|stop), STOPKIND (spend: pause, resumable with --grant | hard: needs investigation | failure) and RULE.
# A test failure only continues. Authorization is checked by gate() before each start, so a measured run that overshoots is caught before the next item.
judge() {
  local rc="$1" sp="$2" lk="$3" att="$4"
  OUTCOME=fail; ACTION=next; STOPKIND=""; RULE=""
  if [ "$sp" = "?" ] || [ "$lk" = unknown ]; then ACTION=stop; STOPKIND=hard; RULE="fail closed: spend or leak state of the run cannot be determined ($M_WHY; $L_WHY)"; return; fi
  [ "$rc" = 0 ] && [ "$lk" = clean ] && OUTCOME=pass
  { [ "$rc" = 2 ] || [ "$rc" = 9 ]; } && [ "$sp" = 0 ] && OUTCOME=blocked
  if [ "$lk" = leak ]; then ACTION=stop; STOPKIND=hard; RULE="leak: $L_WHY"; return; fi
  if [ "$sp" -gt "$STOP_SPEND" ] && [ "$OUTCOME" != pass ]; then ACTION=stop; STOPKIND=spend; RULE="over 50000 and not clean: this run spent $sp micros (exit $rc, leak $lk); review it, then resume with --grant 0 or more"; return; fi
  if [ "$OUTCOME" != pass ]; then
    [ "$rc" = 2 ] && [ "$att" = 1 ] && [ "$sp" -lt "$STOP_SPEND" ] && { ACTION=retry; return; }
    [ "$STOPFAIL" = 0 ] || { ACTION=stop; STOPKIND=failure; RULE="item failed (exit $rc, spend $sp) and --stop-on-failure is set"; }
  fi
}

# gate <ceiling>: no item starts if spent so far plus its ceiling would pass the authorization (RULE set; a spend pause).
gate() {
  [ $((CUM + $1)) -le "$AUTH" ] || { RULE="authorization: spent $CUM + this item's ceiling $1 would pass $AUTH micros"; return 1; }
}

# estimate <kinds of the unfinished items>: seconds of completed (pass or fail) runs in the ledger are the only basis; per kind when that kind has one, else the all-kinds mean.
estimate() {
  local t c g u
  read -r t c g u < <(awk -F'\t' -v kinds="$1" 'BEGIN {n = split(kinds, K, " ")} !/^#/ && ($5 == "pass" || $5 == "fail") && $9 + 0 > 0 {s[$2] += $9; k[$2]++; S += $9; C++}
    END {for (i = 1; i <= n; i++) {q = K[i]; if (k[q]) t += s[q] / k[q]; else if (C) {t += S / C; g++} else u++} printf "%d %d %d %d\n", t, C, g, u}' "$LEDGER")
  if [ "$c" = 0 ]; then echo "remaining: no estimate yet (no completed run to base one on)"; return; fi
  echo "remaining: about $(fmt "$t") (an estimate from $c completed run(s) of this series$([ "$g" = 0 ] || echo "; $g item(s) use the all-kinds mean")$([ "$u" = 0 ] || echo "; $u not counted"))"
}
progress() { # progress <index of the item just finished>
  local n p f rest=() j
  read -r n p f < <(awk -F'\t' '!/^#/ && $8 == "yes" {d++; if ($5 == "pass") p++; else f++} END {print d + 0, p + 0, f + 0}' "$LEDGER")
  for ((j = $1 + 1; j < ${#SPECS[@]}; j++)); do rest+=("${SPECS[$j]}"); done
  echo "  progress: $n/${#SPECS[@]} done ($p pass, $f not pass) | this session $(fmt $SECONDS) | spend $CUM of $AUTH micros authorized"
  echo "  $(estimate "${rest[*]}")"
}

if [ "$DRY" = 1 ]; then
  for i in "${!SPECS[@]}"; do item_info "${SPECS[$i]}" "$OUT/$(printf '%02d' $((i + 1)))-${SPECS[$i]}"; ledger_done $((i + 1)) && st="done in the ledger, would be skipped" || st="would run"
    echo "[$((i + 1))/${#SPECS[@]}] $I_ID ceiling $CEIL micros, $st"; echo "  cmd: ${CMD[*]}"; done
  echo "dry run: preflight, smoke and the runs were not performed"; exit 0
fi
: "${POMTREED_AGENT_IMAGE:?set POMTREED_AGENT_IMAGE to the agent image tag}"
: "${POMTREED_MODEL_KEY_FILE:?set POMTREED_MODEL_KEY_FILE to the operator key file}"
HOST="$(host_token)" || exit 2   # once: every row of this series names the machine it ran on
if [ "$RESUME" = 0 ]; then mkdir "$OUT" 2>/dev/null || die "cannot create $OUT"; fi
mkdir "$OUT/.lock" 2>/dev/null || die "another series holds $OUT/.lock; if none is running (a killed run leaves it), remove that directory and resume"
trap 'rmdir "$OUT/.lock" 2>/dev/null' EXIT
[ "$RESUME" = 1 ] || printf '#gate-series prior=%s list=%s\n' "$PRIOR" "$LIST" > "$LEDGER"
[ -s "$ROWS" ] || results_header > "$ROWS" || die "cannot write the header of $ROWS"   # a fresh series only; a resumed file keeps its header
preflight; smoke
[ -z "$GRANT" ] || { printf '#grant\t%s\t%s\n' "$GRANT" "$(date -u +%F)" >> "$LEDGER"; echo "grant recorded: $GRANT micros; authorization is now $AUTH micros"; }

ledger_add() { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >> "$LEDGER"; }
ledger_unpend() { awk -F'\t' -v p="$1" -v a="$2" '!($1 == p && $3 == a && $5 == "pending")' "$LEDGER" > "$LEDGER.tmp" && mv "$LEDGER.tmp" "$LEDGER"; }
STOPPED=""; STOPKIND=""; ACTION=next; SECONDS=0; RD=""; NEXTPOS=0
echo "series: ${#SPECS[@]} items; a failed item is reported and the series continues$([ "$STOPFAIL" = 0 ] || echo " (--stop-on-failure: it will stop)"); the money and leak rules stop it regardless"

for i in "${!SPECS[@]}"; do
  pos=$((i + 1)); spec="${SPECS[$i]}"
  ledger_done "$pos" && { echo "[$pos/${#SPECS[@]}] $spec: done in the ledger, skipped"; continue; }
  R="$OUT/$(printf '%02d' "$pos")-$spec"
  att=$(( $(awk -F'\t' -v p="$pos" '!/^#/ && $1 == p {n++} END {print n + 0}' "$LEDGER") + 1 ))
  while :; do
    RD="$R"; [ "$att" = 1 ] || RD="$R-retry"
    item_info "$spec" "$RD"
    [ "$att" -le 2 ] || die "position $pos already has $((att - 1)) attempts in the ledger; the one retry is spent"
    [ ! -e "$RD" ] || die "$RD already exists without a finished ledger entry; evidence is never overwritten. Read it, record its spend in $LEDGER (or move it aside) and resume"
    if ! gate "$CEIL"; then STOPPED="[$pos] $spec not started. $RULE"; STOPKIND=spend; NEXTPOS=$pos; break 2; fi
    echo "[$pos/${#SPECS[@]}] $I_ID attempt $att, ceiling $CEIL micros, started at +$(fmt $SECONDS)"; echo "  cmd: ${CMD[*]}"
    mkdir -p "$RD"; stores > "$RD/stores.before" || { STOPPED="[$pos] $spec not started. fail closed: docker could not be queried for store labels"; STOPKIND=hard; break 2; }
    day="$(date -u +%F)"; ledger_add "$pos" "$spec" "$att" "$day" pending '?' '?' no 0
    trap 'echo "gate-series: interrupted during ${RD##*/}; its spend is unknown. Resume asks you to record it in the ledger (see the README)"; rmdir "$OUT/.lock" 2>/dev/null; exit 130' INT TERM
    t0=$SECONDS; "${CMD[@]}" > "$RD/series-driver.log" 2>&1; rc=$?   # exit code captured directly, never through a pipe
    secs=$((SECONDS - t0)); trap 'rmdir "$OUT/.lock" 2>/dev/null' EXIT; trap - INT TERM
    measure "$RD" "$spec" "$rc"; leakcheck "$RD" "$rc" "$RD/stores.before"
    judge "$rc" "$M_SPEND" "$L_STATE" "$att"
    shown="$M_SPEND"; final=yes; case "$M_SPEND" in '?') final=no ;; *) CUM=$((CUM + M_SPEND)); [ "$MEASURED" = yes ] || [ "$M_SPEND" = 0 ] || shown="<=$M_SPEND" ;; esac
    [ "$ACTION" != retry ] || final=no
    ledger_unpend "$pos" "$att"; ledger_add "$pos" "$spec" "$att" "$day" "$OUTCOME" "$rc" "$M_SPEND" "$final" "$secs"
    ev="\`$(basename "$SP")/${CMD[1]##*/}\` $spec, exit $rc; ${L_WHY}; spend ${M_WHY}; rundir $(basename "$RD")"
    ROW_GATE="$I_ID" ROW_COMMIT="$COMMIT" ROW_DATE="$day" ROW_HOST="$HOST" ROW_OUTCOME="$OUTCOME" ROW_SPEND="$shown" ROW_EVIDENCE="$ev" results_row >> "$ROWS" || die "cannot write a results row to $ROWS"
    if [ "$OUTCOME" = pass ]; then echo "  PASS  $I_ID (exit $rc, spend $shown, $(fmt "$secs")); run dir $RD"
    else
      echo "  FAIL  $I_ID: $OUTCOME (exit $rc, leak $L_STATE, spend $shown, $(fmt "$secs"))"; echo "    run dir: $RD"
      for f in series-driver.log run.log pomtreed.log; do [ ! -e "$RD/$f" ] || echo "    log: $RD/$f"; done
    fi
    progress "$i"
    if [ "$ACTION" = retry ]; then
      if gate "$CEIL"; then echo "  retry once: exit $rc is a pre-start refusal with spend $shown < $STOP_SPEND"; att=2; continue; fi
      STOPPED="[$pos] $spec: retry not started. $RULE"; STOPKIND=spend; NEXTPOS=$pos; break 2
    fi
    break
  done
  if [ "$ACTION" = stop ]; then STOPPED="[$pos] $spec: $RULE"; [ "$STOPKIND" != spend ] || NEXTPOS=$((pos < ${#SPECS[@]} ? pos + 1 : 0)); break; fi
done

echo; echo "== summary (ledger $LEDGER) =="
while IFS=$'\t' read -r p it a _ oc rc sp fin sc; do
  rdn="$OUT/$(printf '%02d' "$p")-$it"; [ "$a" = 1 ] || rdn="$rdn-retry"
  printf '[%s] %-6s attempt %s %-7s exit %-3s spend %-8s %-7s final=%s  %s\n' "$p" "$it" "$a" "$oc" "$rc" "$sp" "$(fmt "${sc:-0}")" "$fin" "$rdn"
done < <(grep -v '^#' "$LEDGER" | sort -t$'\t' -k1,1n -k3,3n)
NOTPASS="$(awk -F'\t' '!/^#/ && $8 == "yes" && $5 != "pass" {n++} END {print n + 0}' "$LEDGER")"
print_pause() { # print_pause <rule> <cum> <auth> <next position or 0> <next item> <next ceiling>
  echo "  rule: $1"; echo "  spent so far: $2 micros; authorization: $3 micros"
  if [ "$4" = 0 ]; then echo "  next: nothing left to start"
  else echo "  next: [$4/${#SPECS[@]}] $5, ceiling $6 micros; a grant of at least $(( $2 + $6 > $3 ? $2 + $6 - $3 : 0 )) micros lets it start"; fi
}
echo "  last run dir: ${RD:-none this session}; run dirs and ledger under $OUT"
if [ "$STOPKIND" = spend ] && [ "$NEXTPOS" != 0 ]; then
  ni="${SPECS[$((NEXTPOS - 1))]}"; item_info "$ni"
  printf '#pause\t%s\t%s\t%s\t%s\t%s\t%s\n' "$RULE" "$CUM" "$AUTH" "$NEXTPOS" "$ni" "$CEIL" >> "$LEDGER"
  echo "SERIES PAUSED FOR SPEND (exit 3). Not a failure: it is parked and resumable, nothing was lost."
  print_pause "$RULE" "$CUM" "$AUTH" "$NEXTPOS" "$ni" "$CEIL"
  echo "  items that failed so far: $NOTPASS (listed above with their logs)"
  echo "  resume: $0 --out $OUT --resume --grant <micros> $LIST"
  exit 3
fi
if [ -n "$STOPPED" ] && [ "$STOPKIND" != spend ]; then
  if [ "$STOPKIND" = failure ]; then echo "SERIES STOPPED ON FAILURE (exit 1, --stop-on-failure): $STOPPED"; echo "  resume (skips finished items): $0 --out $OUT --resume $LIST"; exit 1; fi
  echo "SERIES STOPPED, NEEDS INVESTIGATION (exit 4; a leak or undeterminable state, not a quota pause: a grant does not clear it): $STOPPED"
  echo "  spent so far: $CUM micros. Read the run directory, clean up or record the spend in $LEDGER, then resume: $0 --out $OUT --resume $LIST"
  exit 4
fi
[ "$CUM" -le "$AUTH" ] || echo "WARNING: spend $CUM exceeds the authorization $AUTH micros (the last run overshot its ceiling); report it before any further run"
[ "$STOPKIND" != spend ] || echo "NOTE: the last item spent over $STOP_SPEND micros and was not clean; review it. Nothing is left to run."
if [ "$NOTPASS" != 0 ]; then echo "SERIES COMPLETE WITH $NOTPASS NOT-PASS ITEM(S) (exit 1): they carried on; failures are listed above with their logs. cumulative live spend: $CUM micros. Rows: $ROWS"; exit 1; fi
echo "SERIES COMPLETE, all items pass (exit 0). cumulative live spend: $CUM micros. Rows: $ROWS"
