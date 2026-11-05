#!/usr/bin/env bash
# Live poem relay (RLY-5/RLY-6) and the dead-middle variant (CUS-1). Usage: relay.sh <rundir> <k> <topBudget> <reserve> [cus1]
# Serves: RLY-5 (k=1), RLY-6 (k=2,3) and CUS-1 (mode cus1: the middle is killed while holding). Spends real money; see scripts/live/README.md.
# Example: relay.sh <rundir> 2 120000 30000.
# Needs: Docker, a built agent image (POMTREED_AGENT_IMAGE), the operator key file (POMTREED_MODEL_KEY_FILE; never read or printed here), a short state root (POMTREE_LIVE_TMP, default /tmp).
SP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SP/stack.sh"
R="$1"; K="$2"; TOPB="$3"; RES="$4"; MODE="${5:-}"; LEAF=$((K + 1)); mkdir -p "$R"
[ "$(grep -c '^$' "$KEYFILE" 2>>"$R/grep.err")" = 0 ] || { echo "STOP: key file has an empty line"; exit 9; }
js() { node -e "const s=JSON.parse(require('fs').readFileSync(0,'utf8'));$1"; }

relay_text() { # relay_text <level>
  local L="$1" extra=""
  # The extra steps are part of the shared text (every level copies the whole text to its child), each gated on a level.
  if [ "$MODE" = cus1 ]; then
    extra=" EXTRA STEPS. Only if your level is 2: after your child has exited and before you reap it, run \`pomtree ask \"child exited; reply OK to reap\" --wait 600000\`, then continue. Only if your level is 1: if your child ends without a poem (for example it was cancelled), reap it, then run \`pomtree inbox\` once (it consumes the signals) and look for a held descendant (a child_exited signal with custodyOf); its handoff carries the poem; if you missed it, run \`pomtree wait <its id>\`, whose output carries the same handoff; then reap it with \`pomtree reap <its id>\`, and use the poem from its result."
  fi
  printf '%s' "POEM RELAY. Leaf level: $LEAF. Your level: $L. If your level is below the leaf level: run \`pomtree budget\`, then spawn exactly one child with \`pomtree spawn --name relay-<L+1> --budget <your remaining budget minus $RES> --task \"<this whole text, with Your level set to L+1>\"\`, run \`pomtree wait <child id> --timeout 60000\` until the child has exited, run \`pomtree reap <child id>\`, and take the poem from the child's handoff without changing it. If your level is the leaf level: write a poem of at most eight lines about how you feel right now. Then, only if your level is 1: write the poem into \`poem.html\` as a minimal static HTML page with no scripts, run \`pomtree report publish poem.html --media-type text/html --name poem\`, and run \`pomtree ask \"poem published; reply OK to finish\" --wait 600000\`. Finally run \`pomtree result --summary \"<the poem, unchanged>\"\`. Do nothing else.$extra"
}

stack_up "$R" || { stack_down && stack_rm; exit 2; }
pomtree doctor > "$R/doctor.txt" 2>&1; echo "doctor rc=$?"
relay_text 1 > "$R/task-l1.txt"
pomtree --json spawn --name relay-1 --budget "$TOPB" --model "$MODEL" --task "$(cat "$R/task-l1.txt")" > "$R/spawn.json" 2> "$R/spawn.err"; echo "spawn rc=$?"
TOP=$(js 'console.log(s.id??s.agent?.id??"")' < "$R/spawn.json"); echo "top $TOP"
[ -n "$TOP" ] || { cat "$R/spawn.json"; stack_down && stack_rm; exit 2; }
leaked=0; grepped=0; killed=""; ESC=""
T0=$SECONDS
while [ $((SECONDS - T0)) -lt 900 ]; do
  sleep 3
  # Leak-grep each agent container once (while it runs).
  if [ "$grepped" -lt "$((K + 1))" ]; then
    for c in $(docker ps --filter label=pomtree=1 --format '{{.Names}}'); do
      grep -qx "$c" "$R/grepped.txt" 2>/dev/null && continue
      echo "$c" >> "$R/grepped.txt"; grepped=$((grepped + 1))
      out=$(leak_container "$c"); echo "container $c: $(echo $out)" | tee -a "$R/leak-containers.txt"
      [ "$(echo "$out" | awk '$2 != "0"' | wc -l)" = 0 ] || leaked=1
    done
  fi
  [ "$leaked" = 1 ] && { echo "STOP: nonzero leak count"; break; }
  pomtree --json ps > "$R/ps.json" 2>/dev/null
  if [ "$MODE" = cus1 ] && [ -z "$killed" ]; then
    MID=$(js 'const a=(Array.isArray(s)?s:s.agents??[]).find(x=>x.name==="relay-2");console.log(a?a.id:"")' < "$R/ps.json")
    if [ -n "$MID" ] && pomtree --json escalations ls --agent "$MID" 2>/dev/null | js 'process.exit((Array.isArray(s)?s:[]).some(e=>e.state==="open"&&String(e.question).includes("child exited"))?0:1)'; then
      pomtree --json show "$MID" > "$R/mid-before-kill.json" 2>&1
      pomtree kill "$MID" > "$R/kill.txt" 2>&1; echo "killed middle $MID rc=$? at $((SECONDS - T0))s"; killed=$MID
    fi
  fi
  ESC=$(pomtree --json escalations ls --agent "$TOP" 2>/dev/null | js 'const e=(Array.isArray(s)?s:[]).find(e=>e.state==="open"&&String(e.question).includes("poem published"));console.log(e?e.id:"")')
  if [ -n "$ESC" ]; then
    echo "release ask $ESC at $((SECONDS - T0))s"
    pomtree --json show "$TOP" > "$R/top-at-fetch.json" 2>&1
    pomtree --json report list "$TOP" > "$R/reports.json" 2>&1
    RID=$(js 'console.log((Array.isArray(s)?s:[])[0]?.id??"")' < "$R/reports.json")
    pomtree report show "$TOP" "$RID" --out "$R/poem.html" > "$R/report-show.txt" 2>&1; echo "report show rc=$?"
    pomtree answer "$ESC" OK > "$R/answer.txt" 2>&1; echo "answer rc=$?"
    break
  fi
  st=$(pomtree --json show "$TOP" 2>/dev/null | js 'const a=s.agent??s;console.log(a.state)')
  case "$st" in exited|reaped) echo "top ended before the ask: $st"; break ;; esac
done
pomtree wait "$TOP" --timeout 240000 > "$R/wait.txt" 2>&1; rc=$?; echo "wait rc=$rc"
# gate-series.sh reads a driver exit of 2 or 9 as a PRE-START refusal: it records spend 0 without reading spend.json and
# allows a paid retry. `pomtree wait` uses 2 for usage and daemon-400 errors, which happen after the stack is up and money may
# already have been spent, so remap those two to 7 and keep 2 and 9 for this script's own pre-start refusals above.
case "$rc" in 2 | 9) echo "remapping post-start wait status $rc to 7 (2 and 9 mean pre-start refusal to gate-series)"; rc=7 ;; esac
sleep 5
pomtree tree > "$R/tree.txt" 2>&1
pomtree --json ps > "$R/ps-final.json" 2>&1
for id in $(js '(Array.isArray(s)?s:s.agents??[]).forEach(a=>console.log(a.id))' < "$R/ps-final.json"); do
  pomtree --json show "$id" > "$R/show-$id.json" 2>&1; pomtree show "$id" > "$R/show-$id.txt" 2>&1
  pomtree trace "$id" --out "$R/trace-$id.md" > /dev/null 2>&1
done
pomtree --json spend > "$R/spend.json" 2>&1; pomtree spend > "$R/spend.txt" 2>&1
cat "$R/tree.txt" "$R/spend.txt"
# Verdict: verify-relay.mjs is this run's assertion set (poem identity, reaps, carve and settle arithmetic, spend under the
# cap). scripts/live/README.md has always said to check a relay run with it, but nothing ran it, so a caller got no verdict
# at all; and this script's exit status was the network-snapshot diff below, so any run that left the networks alone looked
# clean. Run it here and fold its status in, so the run carries its own verdict.
node "$SP/verify-relay.mjs" "$R" "$TOPB" "$K" > "$R/verify.txt" 2>&1; vrc=$?
grep -E "^FAIL|^VERDICT|^SPEND" "$R/verify.txt"
[ "$vrc" = 0 ] || { echo "VERDICT FAIL: verify-relay.mjs exited $vrc (see verify.txt)"; [ "$rc" = 0 ] && rc="$vrc"; }
[ "$leaked" = 0 ] || { echo "VERDICT FAIL: a container leak grep was nonzero"; [ "$rc" = 0 ] && rc=6; }
stack_down || exit 8
leak_dir "$S/state" state; stack_rm
leak_dir "$R" rundir
echo "leftover: $(docker ps -a --filter label=pomtree=1 -q | wc -l) containers"
diff "$R/docker-vol.before" "$R/docker-vol.after" && echo "volumes unchanged"
diff "$R/docker-net.before" "$R/docker-net.after" && echo "networks unchanged"
# Exit with the RUN's status, like harness.sh does (see the verdict note above).
echo "$rc" > "$R/exit_code"
echo "rc=$rc"
exit "$rc"
