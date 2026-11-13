#!/usr/bin/env bash
# rehearse.sh: one command to stand up the ZERO-SPEND wiki-distill rehearsal and run drive.sh against it.
#
# Usage: examples/wiki-distill/rehearse.sh [--target DIR] [--port N] [--keep] [--no-wait] [--open] [-h|--help]
#   --target DIR  git repo the agents work on (default: a fresh temp repo with one empty commit). It must already be a
#                 git repo; never point it at the pomtree checkout.
#   --port N      UI port, passed to scripts/pomtree-up (default: its own default, the next free port from 8787)
#   --keep        keep the scratch directory (key file, catalog copy, logs) and a temp target repo on exit
#   --no-wait     do not stop for Enter (sign-in, and before cleanup); for scripted runs
#   --open        pass --open to scripts/pomtree-up so it tries to open the UI in your default browser, already signed in (best
#                 effort; no pasting needed). The opener receives the signed-in link, so the operator token is in the opener's
#                 and the browser's argv (readable from /proc/<pid>/cmdline; see docs/operating.md); we never pass --show-token, so it is not printed in our output or the pomtree-up log.
#
# Needs: docker, or podman when POMTREED_SANDBOX_BACKEND=podman (working without sudo), the built agent image (POMTREED_AGENT_IMAGE, else the newest local
# pomtree/agent:* tag; this script never builds one), node, git. Run it from anywhere; it finds the checkout itself.
#
# What it never does: it uses no real model key and spends no money. The model is the scripted stub on loopback, the key
# file holds a random dummy, and any real-upstream settings in your environment are unset for everything started here.
# The readers fetch only https://example.com/ (one public fetch). Nothing is published or pushed.
#
# Cleanup: on exit, Ctrl-C or error it turns UI follow off and stops exactly the two processes it started (the stub and
# scripts/pomtree-up, by PID), then removes the scratch directory unless --keep. pomtree-up's state directory (under
# ~/.local/state/pomtree) is left in place; its path is printed.
#
# Test seams (command words, default shown): REHEARSE_STUB ("node <checkout>/packages/testing/bin/model-stub.ts"),
# REHEARSE_POMTREE_UP ("<checkout>/scripts/pomtree-up"), REHEARSE_DRIVE ("<here>/drive.sh"),
# REHEARSE_POMTREE_CLI ("node <checkout>/packages/pomtree/src/main.ts"). rehearse.test.mts points them at fakes.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
die() { echo "rehearse.sh: $*" >&2; exit 1; }

# --- options ---------------------------------------------------------------------------------------------------------
target="" port="" keep=0 wait_for_enter=1 open_ui=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) target="${2:?--target needs a DIR}"; shift 2 ;;
    --port) port="${2:?--port needs N}"; shift 2 ;;
    --keep) keep=1; shift ;;
    --no-wait|--yes) wait_for_enter=0; shift ;;
    --open) open_ui=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "rehearse.sh: unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done

# Command words for the pieces we run; each can be swapped by tests (see the seams above).
read -r -a stub_cmd <<<"${REHEARSE_STUB:-node $root/packages/testing/bin/model-stub.ts}"
read -r -a up_cmd <<<"${REHEARSE_POMTREE_UP:-$root/scripts/pomtree-up}"
read -r -a drive_cmd <<<"${REHEARSE_DRIVE:-$here/drive.sh}"
cli="${REHEARSE_POMTREE_CLI:-node $root/packages/pomtree/src/main.ts}"
read -r -a cli_cmd <<<"$cli"

# --- never reach a real model ----------------------------------------------------------------------------------------
# pomtree-up reads these as defaults, and a stray real key or upstream in your shell would otherwise leak into the
# stack. We pass the stub's URL and key file explicitly below; unset the rest so no child can see a real upstream.
unset POMTREED_MODEL_BASE_URL POMTREED_MODEL_UPSTREAM_KEY_FILE POMTREED_PI_PROVIDER POMTREED_TEMPLATES_DIR \
  OPENROUTER_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY

# --- scratch directory -----------------------------------------------------------------------------------------------
# Everything this script creates (key file, catalog copy, logs, pid files) lives here, so cleanup is one rm.
scratch="$(mktemp -d "${TMPDIR:-/tmp}/wiki-rehearse.XXXXXX")"
echo "scratch directory: $scratch"
stub_pid="" up_pid="" made_target=0 state=""

# --- cleanup (runs on every exit) ------------------------------------------------------------------------------------
# stop_pid PID: ask the process to stop, wait up to 30 s, force-kill if still alive, then assert it is gone.
stop_pid() {
  local pid="$1"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 300); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.1; done
  kill -KILL "$pid" 2>/dev/null || true
  sleep 0.2
  if kill -0 "$pid" 2>/dev/null; then echo "rehearse.sh: process $pid did not stop; kill it by hand: kill -KILL $pid" >&2; fi
}
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  # Put the browser windows back to normal while the daemon is still up (best effort).
  if [ -n "$up_pid" ] && [ -n "$state" ]; then
    timeout 10 "${cli_cmd[@]}" ui follow off >/dev/null 2>&1 || true
  fi
  # Kill by the exact PIDs we recorded, never by name.
  [ -z "$up_pid" ] || stop_pid "$up_pid"
  [ -z "$stub_pid" ] || stop_pid "$stub_pid"
  if [ "$keep" = 1 ]; then
    echo "kept: $scratch"
    [ "$made_target" = 0 ] || echo "kept target repo: $target"
  else
    rm -rf "$scratch"
    if [ "$made_target" = 1 ]; then rm -rf "$target"; fi
  fi
  [ -z "$state" ] || echo "pomtree-up state directory left in place: $state"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- target repository -----------------------------------------------------------------------------------------------
# The agents work on a git repo that is not this checkout. Default: a throwaway repo with one empty commit.
if [ -z "$target" ]; then
  target="$(mktemp -d "${TMPDIR:-/tmp}/wiki-rehearse-target.XXXXXX")"
  made_target=1
  git -C "$target" init -q
  git -C "$target" -c user.name=rehearse -c user.email=rehearse@localhost commit -q --allow-empty -m "Initial commit"
else
  [ -d "$target" ] || die "--target $target is not a directory; create a git repo there (git init) or omit --target"
  target="$(cd "$target" && pwd -P)"
  git -C "$target" rev-parse --git-dir >/dev/null 2>&1 || die "--target $target is not a git repository; run git init there or omit --target"
fi
[ "$target" != "$root" ] || die "--target is the pomtree checkout itself; pass a separate repo or omit --target"

# --- agent image -----------------------------------------------------------------------------------------------------
# Use the image the operator named, else the newest local pomtree/agent:* tag (the engine lists newest first; Podman prefixes localhost/).
# Mirrors scripts/live/engine.sh; duplicated because rehearse.test.mts copies this script into a sandbox, so a relative source of that file would break.
# The engine CLI follows pomtreed's own selector POMTREED_SANDBOX_BACKEND (unset means docker); auto and unknown values are refused.
engine="${POMTREED_SANDBOX_BACKEND-}"; engine="${engine:-docker}"
case "$engine" in docker | podman) ;; *) die "POMTREED_SANDBOX_BACKEND=$engine is not supported here; set it to docker or podman (auto cannot tell this script which CLI to use), or unset it for docker" ;; esac
command -v "$engine" >/dev/null || die "$engine CLI not found; install $engine and put $engine on PATH"
image="${POMTREED_AGENT_IMAGE:-}"
if [ -z "$image" ]; then
  image="$("$engine" images --format '{{.Repository}}:{{.Tag}}' | grep -E '^(localhost/)?pomtree/agent:' | head -n1 || true)"
fi
[ -n "$image" ] || die "no local pomtree/agent:* image found; build one (see GETTING_STARTED.md) or set POMTREED_AGENT_IMAGE, then rerun (this script never builds)"
echo "agent image: $image"
export POMTREED_AGENT_IMAGE="$image"

# --- dummy key file --------------------------------------------------------------------------------------------------
# pomtreed insists on a mode-0600 key file; the stub ignores the content, so it is random filler, not a real key.
key="$scratch/stub-key"
( umask 077; printf 'stub-%s%s%s' "$RANDOM" "$RANDOM" "$RANDOM" > "$key" )
chmod 600 "$key"

# --- model catalog from the image ------------------------------------------------------------------------------------
# Without a Pi model catalog pomtreed cannot price the stub's usage and the run never completes (docs/operating.md,
# "Zero-spend first agent"). Copy it out of the image into the scratch directory.
cid="$("$engine" create "$image")" || die "$engine create $image failed; check $engine works without sudo and the image exists"
"$engine" cp "$cid:/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/data" "$scratch/pi-catalog" ||
  { "$engine" rm "$cid" >/dev/null 2>&1 || true; die "could not copy the model catalog out of $image; check the image is a pomtree agent image"; }
"$engine" rm "$cid" >/dev/null 2>&1 || true
export POMTREED_PI_CATALOG_DIR="$scratch/pi-catalog"

# --- templates -------------------------------------------------------------------------------------------------------
# pomtreed loads templates from <state>/templates. Ask pomtree-up where the state is, then copy the stub templates
# (same ids as the real ones, different prompts) into it. Keep only the export lines; we eval just those.
env_out="$("${up_cmd[@]}" "$target" --print-env)" || die "scripts/pomtree-up --print-env failed for $target; run it by hand to see why"
exports="$(printf '%s\n' "$env_out" | grep '^export ' || true)"
eval "$exports"
state="${POMTREED_STATE_DIR:-}"
[ -n "$state" ] || die "pomtree-up --print-env gave no POMTREED_STATE_DIR; run it by hand: scripts/pomtree-up $target --print-env"
mkdir -p "$state/templates"
cp "$here"/stub/templates/*.json "$state/templates/"
echo "templates copied to $state/templates"

# --- model stub ------------------------------------------------------------------------------------------------------
# The scripted fake model, on a free loopback port. It prints one JSON line with its baseUrl once it is listening.
"${stub_cmd[@]}" --script "$here/stub/wiki-distill.json" --port 0 > "$scratch/stub.log" 2>&1 &
stub_pid=$!
echo "$stub_pid" > "$scratch/stub.pid"
stub_url=""
for _ in $(seq 100); do   # at most 10 s
  stub_url="$(sed -n 's/.*"baseUrl":"\([^"]*\)".*/\1/p' "$scratch/stub.log" | head -n1)"
  [ -z "$stub_url" ] || break
  kill -0 "$stub_pid" 2>/dev/null || die "the model stub exited during startup; see $scratch/stub.log (use --keep to preserve it)"
  sleep 0.1
done
[ -n "$stub_url" ] || die "the model stub printed no baseUrl within 10 s; see $scratch/stub.log (use --keep to preserve it)"
echo "model stub: $stub_url"

# --- daemon stack ----------------------------------------------------------------------------------------------------
# 2600000 micros is the pool drive.sh prints for 4 readers. The stub never charges money, but the budget tree still needs it.
# pomtreed refuses to start unless budget.topLevelMicros (default 5000000) <= budget.rootMicros, so the top-level cap is set equal to the pool. drive.sh passes an explicit --budget per spawn, so it only needs to be valid.
# --no-build: use the image as found, never build one.
up_args=("$target" --init --no-build --provider openrouter --model-base-url "$stub_url" --model-key-file "$key")
[ -z "$port" ] || up_args+=(--port "$port")
# --open: pomtree-up picks the opener (xdg-open or open) and opens its own signed-in link; the token is not printed (no --show-token).
[ "$open_ui" = 0 ] || up_args+=(--open)
# The access log goes to stdout (up.log) and, off a TTY, defaults to errors only; "all" records every UI request so a page that cannot connect (e.g. /live/ui) shows up there. It never logs tokens or cookies.
POMTREED_ACCESS_LOG_MODE="${POMTREED_ACCESS_LOG_MODE:-all}" POMTREED_BUDGET_ROOT_MICROS=2600000 POMTREED_BUDGET_TOP_LEVEL_MICROS=2600000 "${up_cmd[@]}" "${up_args[@]}" > "$scratch/up.log" 2>&1 &
up_pid=$!
echo "$up_pid" > "$scratch/up.pid"
# pomtree-up prints "pomtreed is up" only after the daemon answered its own readiness probe. Wait at most 60 s.
ready=0
for _ in $(seq 600); do
  if grep -q 'pomtreed is up' "$scratch/up.log" 2>/dev/null; then ready=1; break; fi
  kill -0 "$up_pid" 2>/dev/null || die "scripts/pomtree-up exited during startup; see $scratch/up.log (use --keep to preserve it)"
  sleep 0.1
done
[ "$ready" = 1 ] || die "the daemon was not ready within 60 s; see $scratch/up.log (use --keep to preserve it)"
echo "pomtreed doctor: $("${cli_cmd[@]}" doctor 2>&1 | head -n1 || true)"

# --- sign in ---------------------------------------------------------------------------------------------------------
# The UI needs a signed-in browser tab before drive.sh can steer it. The token file is only named here, never read.
ui_url="$(sed -n 's/^UI: *//p' "$scratch/up.log" | head -n1)"
echo
echo "UI:          ${ui_url:-see $scratch/up.log}"
if [ "$open_ui" = 1 ]; then
  echo "token file:  $state/operator.token"
  echo "A browser tab should have opened already signed in (best effort); if not, open the UI URL and paste the token file's contents (this script does not show it)."
else
  echo "token file:  $state/operator.token   (paste its contents into the sign-in page; this script does not show it)"
fi
if [ "$wait_for_enter" = 1 ]; then
  echo "Open the UI in Chrome and sign in, then press Enter."
  read -r _ || true
fi

# --- run the driver --------------------------------------------------------------------------------------------------
# drive.sh talks to the daemon through the same CLI and the exports we evaluated above. --yes is safe: the model is the stub.
echo "running drive.sh (readers: 4, stub model, no spend)"
drive_rc=0
WIKI_DISTILL_CLI="$cli" "${drive_cmd[@]}" --title anything --readers 4 --yes || drive_rc=$?
if [ "$drive_rc" -ne 0 ]; then echo "rehearse.sh: drive.sh failed with exit $drive_rc; see its output above and the README troubleshooting" >&2; fi

# --- leave it up -----------------------------------------------------------------------------------------------------
echo
echo "Next: look at the windows in Chrome, and 'pomtree tree' / 'pomtree spend' in another terminal (exports: $state)."
if [ "$wait_for_enter" = 1 ]; then
  echo "The stack stays up. Press Enter or Ctrl-C to stop everything."
  read -r _ || true
fi
exit "$drive_rc"
