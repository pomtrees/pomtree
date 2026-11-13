#!/usr/bin/env bash
# INS-3 + CRD-5: first live agent through pomtree-up, with count-only key-leak greps. Usage: ins3.sh <rundir>
# Serves: items INS-3 and CRD-5 (first live agent; count-only key-leak greps). Spends real money; see scripts/live/README.md.
# Needs: Docker or Podman (ENGINE, from POMTREED_SANDBOX_BACKEND; see scripts/live/README.md), a built agent image (POMTREED_AGENT_IMAGE), the operator key file (POMTREED_MODEL_KEY_FILE; never read or printed here), a short state root (POMTREE_LIVE_TMP, default /tmp).
SP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SP/stack.sh"
R="$1"; mkdir -p "$R"
[ "$(grep -c '^$' "$KEYFILE" 2>>"$R/grep.err")" = 0 ] || { echo "STOP: key file has an empty line"; exit 9; }
stack_up "$R" || { stack_down && stack_rm; exit 2; }
pomtree doctor > "$R/doctor.txt" 2>&1; echo "doctor rc=$?"
pomtree models > "$R/models.txt" 2>&1
grep -i haiku "$R/models.txt"
pomtree --json spawn --task "Create hello.txt containing hi, commit it, run pomtree push, then report" \
  --budget 60000 --name first-live --model "$MODEL" > "$R/spawn.json" 2> "$R/spawn.err"; echo "spawn rc=$?"
ID=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.id??j.agent?.id??"")' "$R/spawn.json")
echo "agent $ID"
[ -n "$ID" ] || { cat "$R/spawn.json"; stack_down && stack_rm; exit 2; }
# Leak-grep the running containers once they have done some work.
for i in $(seq 1 60); do
  C=$("$ENGINE" ps --filter label=pomtree=1 --format '{{.Names}}')
  [ -n "$C" ] && break; sleep 0.5
done
sleep 2
for c in $("$ENGINE" ps --filter label=pomtree=1 --format '{{.Names}}'); do echo "container $c"; leak_container "$c"; done
pomtree wait "$ID" --timeout 240000 > "$R/wait.txt" 2>&1; rc=$?; echo "wait rc=$rc"
# 2 and 9 mean a pre-start refusal to gate-series.sh (spend 0, a paid retry allowed), but `pomtree wait` uses 2 for usage and
# daemon-400 errors that happen after the stack is up, when money may already be spent. Remap so the two cannot be confused.
case "$rc" in 2 | 9) echo "remapping post-start wait status $rc to 7"; rc=7 ;; esac
pomtree show "$ID" > "$R/show.txt" 2>&1
pomtree --json show "$ID" > "$R/show.json" 2>&1
pomtree spend > "$R/spend.txt" 2>&1; pomtree --json spend > "$R/spend.json" 2>&1
pomtree tree > "$R/tree.txt" 2>&1
pomtree trace "$ID" --out "$R/trace.md" > /dev/null 2>&1
cat "$R/show.txt" | head -30; cat "$R/spend.txt"
# Verdict: the agent must have actually succeeded. Without this the script's only verdict was `pomtree wait`'s status, and its
# exit status was whatever the last snapshot diff below returned, so a failed agent still looked like a clean run.
ST=$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const a=s.agent??s;console.log(`${a.state}/${a.exit}`)' "$R/show.json" 2>/dev/null)
echo "final state $ST"
case "$ST" in reaped/succeeded|exited/succeeded) echo "verdict: the live agent succeeded" ;;
  *) echo "VERDICT FAIL: the live agent ended $ST, not succeeded"; [ "$rc" = 0 ] && rc=5 ;; esac
stack_down || exit 8
leak_dir "$S/state" state; stack_rm
leak_dir "$R" rundir
echo "leftover: $("$ENGINE" ps -a --filter label=pomtree=1 -q | wc -l) containers"
diff "$R/engine-vol.before" "$R/engine-vol.after" && echo "volumes unchanged"
diff "$R/engine-net.before" "$R/engine-net.after" && echo "networks unchanged"
# Exit with the RUN's status, like harness.sh does. Previously the script fell off the end, so its exit status was the
# network-snapshot diff above and every run that left the networks alone reported success whatever the agent did.
echo "$rc" > "$R/exit_code"
echo "rc=$rc"
exit "$rc"
