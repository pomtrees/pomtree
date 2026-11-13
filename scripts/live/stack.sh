# shellcheck shell=bash
# Wave 4 live-stack helpers. Source this file; never prints key material. The engine CLI (ENGINE) comes from engine.sh.
# Usage: source stack.sh; stack_up <rundir>; ...; stack_down
# Required: POMTREED_MODEL_KEY_FILE (path to the operator key file, set by the operator) and POMTREED_AGENT_IMAGE (agent image tag). Optional: POMTREE_LIVE_REPO (repo root, default: two levels above this file), POMTREE_LIVE_TMP (parent of the short state root, default /tmp), POMTREE_LIVE_MODEL.
# Rules: grep on the key file uses only -c/-l/-q with stderr to $R/grep.err (unquoted log); no tracing (never set -x).
# Operator overrides are read as `${NAME-}` (no colon) first so env-drift sees a read, not a `NAME:` set site; the defaults follow.
WT="${POMTREE_LIVE_REPO-}"; WT="${WT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
KEYFILE="${POMTREED_MODEL_KEY_FILE:?set POMTREED_MODEL_KEY_FILE to the operator key file}"   # consumed only by pomtreed via --model-key-file; count-only greps below
# pomtreed's strict env refuses the unknown name POMTREED_MODEL_KEY_FILE, so keep it out of every child's environment.
export -n POMTREED_MODEL_KEY_FILE
: "${POMTREED_AGENT_IMAGE:?set POMTREED_AGENT_IMAGE to the agent image tag}"; export POMTREED_AGENT_IMAGE
MODEL="${POMTREE_LIVE_MODEL-}"; MODEL="${MODEL:-openrouter/anthropic/claude-haiku-5.5}"
pomtree() { node "$WT/packages/pomtree/src/main.ts" "$@"; }
source "$(dirname "${BASH_SOURCE[0]}")/engine.sh"

snap() { # snap <dir> <label>
  "$ENGINE" ps -a --format '{{.Names}} {{.Image}} {{.Status}}' > "$1/engine-ps.$2"
  "$ENGINE" volume ls -q > "$1/engine-vol.$2"
  "$ENGINE" network ls --format '{{.Name}}' > "$1/engine-net.$2"
}

stack_up() { # stack_up <rundir> [extra env assignments are taken from the caller's env]
  # Short state path: keeps the socket inside the state dir (pomtree-up relocates one over 100 chars to /tmp/pomtreed-<hash>,
  # and since pomtree-up-sock its readiness probe follows it), so stack_rm removes every trace of the run.
  R="$1"; LIVE_TMP="${POMTREE_LIVE_TMP-}"; S=$(mktemp -d "${LIVE_TMP:-/tmp}/w4-XXXXXX"); echo "$S" > "$R/state-root"
  mkdir -p "$S/repo" "$S/state"; chmod 700 "$S/state"
  git -C "$S/repo" init -q -b main
  snap "$R" before
  ( cd "$WT" || exit 1; POMTREED_BUDGET_TOP_LEVEL_MICROS=150000 POMTREED_BUDGET_DEFAULT_MICROS=60000 \
      scripts/pomtree-up "$S/repo" --init --no-build --state "$S/state" --provider openrouter \
      --model-base-url https://openrouter.ai/api --model-key-file "$KEYFILE" > "$R/pomtree-up.log" 2>&1 & echo $! > "$R/pomtree-up.pid" )
  export POMTREED_STATE_DIR="$S/state"
  for i in $(seq 1 90); do
    grep -q "pomtreed is up" "$R/pomtree-up.log" 2>/dev/null && return 0
    kill -0 "$(cat "$R/pomtree-up.pid")" 2>/dev/null || { echo "pomtree-up exited early"; return 1; }
    sleep 1
  done
  echo "pomtree-up not up after 90s"; return 1
}

stack_down() {
  local pid; pid=$(cat "$R/pomtree-up.pid")
  kill -TERM "$pid" 2>/dev/null
  for i in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -0 "$pid" 2>/dev/null && { echo "pomtree-up still alive after 60s; SIGKILL"; kill -KILL "$pid" 2>/dev/null; }
  # TODO(live-stack-singleton): namespace live stacks for parallel runs. Current behavior: stack_down waits on fixed port 18080.
  # The pomtree-egress network and the pomtree=1 label filters in scripts/live are host-wide, so stacks share them.
  # pomtreed must be gone too: nothing may still listen on the model proxy port.
  for i in $(seq 1 30); do ss -ltn 2>/dev/null | grep -q ':18080 ' || break; sleep 1; done
  if ss -ltn 2>/dev/null | grep -q ':18080 '; then
    echo "STOP: a pomtreed still listens on 18080 after stack_down"; pgrep -af 'packages/pomtreed/src/main.ts' | cut -c1-80
    return 1
  fi
  sleep 2
  snap "$R" after
}
# After the leak greps: keep the pomtreed log and repo history, then remove the temp state root.
stack_rm() {
  cp "$S/state/pomtreed.log" "$R/pomtreed.log" 2>/dev/null
  git -C "$S/repo" log --all --oneline > "$R/repo-log.txt" 2>&1
  rm -rf "$S" 2>"$R/rm.err" || echo "rm of $S failed (see rm.err)"
  [ -e "$S" ] && echo "state root still present: $S" || echo "state root removed"
}

# Count-only key-leak greps (print integers or counts of files only).
# Coordinator constraints: only -c/-l/-q; grep stderr to $R/grep.err (never quoted); nonzero stops the run.
leak_container() { # leak_container <container>
  local c="$1"
  echo "env $("$ENGINE" inspect "$c" --format '{{json .Config.Env}}' | grep -c -F -f "$KEYFILE" 2>>"$R/grep.err")"
  echo "logs $("$ENGINE" logs "$c" 2>&1 | grep -c -F -f "$KEYFILE" 2>>"$R/grep.err")"
  echo "fs $("$ENGINE" export "$c" 2>>"$R/grep.err" | tar -xO 2>/dev/null | grep -c -F -f "$KEYFILE" 2>>"$R/grep.err")"
}
# Running containers the live drivers leak-grep: the workers (label pomtree=1) and the egress sidecars (label pomtree.egress=1). A
# sidecar never carries a model key, so a match there is a leak; sort -u keeps a container with both labels once.
leak_targets() {
  { "$ENGINE" ps --filter label=pomtree=1 --format '{{.Names}}'; "$ENGINE" ps --filter label=pomtree.egress=1 --format '{{.Names}}'; } | sort -u
}
leak_dir() { grep -r -l -F -f "$KEYFILE" "$1" > "$R/leak-files.$2" 2>>"$R/grep.err"; echo "files-$2 $(wc -l < "$R/leak-files.$2")"; }
key_ok() { echo "emptylines $(grep -c '^$' "$KEYFILE" 2>>"$R/grep.err")"; }
