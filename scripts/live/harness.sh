#!/usr/bin/env bash
# Run one live harness/demo under the key-file rule with engine snapshots. Usage: harness.sh <rundir> <kind> [args...]
# Serves: REC-10 (rec10 adopt, rec10k dead-container), REC-1 (rec1), YLD-1 (yld1), BUD-1 (bud1), EGR-2 (egr2smoke, egr2; full image). Spends real money; see scripts/live/README.md.
# Needs: Docker or Podman (ENGINE, from POMTREED_SANDBOX_BACKEND; see scripts/live/README.md), POMTREED_AGENT_IMAGE, POMTREED_MODEL_KEY_FILE (never read or printed), run from a built checkout; POMTREE_LIVE_REPO overrides the repo root.
# kind: rec10 | rec10k | rec1 | yld1 | bud1 | egr2smoke | egr2
SP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SP/stack.sh"
R="$1"; KIND="$2"; mkdir -p "$R"
[ "$(grep -c '^$' "$KEYFILE" 2>>"$R/grep.err")" = 0 ] || { echo "STOP: key file has an empty line"; exit 9; }
snap "$R" before
cd "$WT" || exit 1
export POMTREED_MODEL_BASE_URL=https://openrouter.ai/api POMTREED_MODEL_UPSTREAM_KEY_FILE="$KEYFILE" POMTREED_PI_PROVIDER=openrouter
IMG="${POMTREED_AGENT_IMAGE:?set POMTREED_AGENT_IMAGE to the agent image tag}"
case "$KIND" in
  rec10) node packages/e2e/src/crash-recovery-live.ts --image "$IMG" --out "$R/out" > "$R/run.log" 2>&1; rc=$? ;;
  rec10k) node packages/e2e/src/crash-recovery-live.ts --image "$IMG" --out "$R/out" --kill-container > "$R/run.log" 2>&1; rc=$? ;;
  # rec1 also runs a read-only side poller of the harness's pomtreed DB for the budget-stall escalation evidence (rec1-poll.mjs).
  rec1) node "$SP/rec1-poll.mjs" "${TMPDIR:-/tmp}" > "$R/rec1-poll.log" 2>&1 & POLL=$!
         node packages/e2e/src/crash-recovery-live-multi.ts --image "$IMG" --out "$R/out" --budget-micros 60000 > "$R/run.log" 2>&1; rc=$?
         kill "$POLL" 2>/dev/null ;;
  yld1) POMTREED_LIVE=1 POMTREED_DEMO_MODEL=anthropic/claude-haiku-5.5 POMTREED_BUDGET_ROOT_MICROS=150000 POMTREED_AGENT_IMAGE="$IMG" \
          node packages/e2e/src/demo/yield-resume.ts > "$R/run.log" 2>&1; rc=$? ;;
  bud1) POMTREED_LIVE=1 POMTREED_DEMO_MODEL=anthropic/claude-haiku-5.5 POMTREED_AGENT_IMAGE="$IMG" \
          node packages/e2e/src/demo/escalation-chain.ts > "$R/run.log" 2>&1; rc=$? ;;
  # egr2smoke: the browser smoke precondition (PTREE_NET_TESTS=1, no model spend). egr2: one live story with the fetch identity
  # unset; a side loop copies only each worker container's "Chromium User-Agent" stderr line (no secret) to ua-lines.txt.
  egr2smoke) PTREE_DOCKER_TESTS=1 PTREE_NET_TESTS=1 PTREE_E2E_IMAGE="$IMG" \
          node --test --test-timeout=240000 examples/hn-digest/content-live-browser-smoke.test.mts > "$R/run.log" 2>&1; rc=$? ;;
  egr2) mkdir -p "$R/state" "$R/digest"
        ( while :; do for c in $("$ENGINE" ps --filter label=pomtree=1 --format '{{.Names}}'); do
            "$ENGINE" logs "$c" 2>&1 | grep -a 'Chromium User-Agent' | sed "s/^/$c /" >> "$R/ua-raw.txt"; done; sleep 2; done ) & UA=$!
        # content-live.mts takes a digest pin or a local image id, never a tag.
        IMGID=$(image_id "$IMG") || { echo "no image $IMG"; exit 2; }
        env -u POMTREED_WORKFLOW_FETCH_USER_AGENT node examples/hn-digest/content-live.mts --stories 1 --article-method browser \
          --budget-micros 200000 --state-dir "$R/state" --output-dir "$R/digest" --image "$IMGID" > "$R/run.log" 2>&1; rc=$?
        kill "$UA" 2>/dev/null; sort -u "$R/ua-raw.txt" > "$R/ua-lines.txt" 2>/dev/null ;;
  *) echo "unknown kind"; exit 2 ;;
esac
echo "$rc" > "$R/exit_code"
sleep 3
snap "$R" after
leak_dir "$R" rundir
# Leak detection is about what the run LEFT BEHIND, so only additions are a leak. A removal is something that existed before the run and
# is gone after it, which says nothing about this run's hygiene: anything else on the host may remove a pre-existing entry inside the
# run's window. During REC-1 run 3 of the 2026-11-03 campaign 15 orphaned egress socket volumes went away mid-run because an operator
# removed them by hand, and the old whole-file diff reported "vol CHANGED", which reads as a leak and was not one.
# Additions still print and are what a reader should act on. For containers compare the NAME only: the snapshot carries the status text,
# which drifts on its own ("Exited (0) 2 days ago"), and a status that merely aged is not a change in what exists.
for x in ps vol net; do
  if [ "$x" = ps ]; then cut -d' ' -f1 < "$R/engine-$x.before" | sort > "$R/.$x.b"; cut -d' ' -f1 < "$R/engine-$x.after" | sort > "$R/.$x.a"
  else sort < "$R/engine-$x.before" > "$R/.$x.b"; sort < "$R/engine-$x.after" > "$R/.$x.a"; fi
  added=$(comm -13 "$R/.$x.b" "$R/.$x.a"); removed=$(comm -23 "$R/.$x.b" "$R/.$x.a")
  rm -f "$R/.$x.b" "$R/.$x.a"
  if [ -n "$added" ]; then echo "$x LEAKED $(printf '%s\n' "$added" | wc -l) entry(ies) left behind by this run:"; printf '%s\n' "$added" | sed 's/^/  leaked /'
  elif [ -n "$removed" ]; then echo "$x unchanged by this run, apart from $(printf '%s\n' "$removed" | wc -l) pre-existing entry(ies) reclaimed:"; printf '%s\n' "$removed" | sed 's/^/  reclaimed /'
  else echo "$x unchanged"; fi
done
echo "rc=$rc"
exit "$rc"
