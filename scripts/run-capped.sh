#!/bin/bash
# Run a command under a memory ceiling and a wall-clock limit, so a runaway test cannot exhaust the machine.
#
# Usage: scripts/run-capped.sh [--mem 8G] [--timeout 150s] -- <command>...
#   --mem      hard memory ceiling for the command and everything it spawns; default $POMTREE_RUN_MEM, else 8G.
#   --timeout  wall-clock limit (N, Ns or Nm); default $POMTREE_RUN_TIMEOUT, else 150s.
#   POMTREE_RUN_UNCAPPED=1  run the command with no cap and no time limit, after printing a notice.
#
# Exit code: the command's own, unchanged, except 124 when the time limit ended it (the code `timeout` uses). Usage
# errors and an unusable cap exit 2. A cap kill always exits 137 (SIGKILL); it is reported on stderr with its cause and action.
#
# How: the command runs in its own process group under `timeout`, inside a transient systemd scope with MemoryMax and
# MemorySwapMax=0 (a real cgroup ceiling: the kernel kills inside the scope, never the session). When systemd-run or a
# user bus is unavailable (macOS, containers, ssh without a session bus) it falls back to `ulimit -v`, a WEAKER cap on
# address space, not resident memory; node reserves a lot of address space, so give it room (16G or more). The fallback
# prints a notice. The cap is never dropped silently: if neither mechanism works the script refuses to run.
#
# Nesting: the tighter cap wins. A `systemd-run --user` scope is created under the user manager, not under the caller's
# cgroup, so a nested scope would ESCAPE a tighter outer cap. The script therefore reads the memory.max already in force
# (the minimum along its cgroup path) and, when that is at most the requested cap, keeps the command in the current
# cgroup and prints a notice; otherwise it creates its own, tighter scope. The time limit is always applied. stdin of the
# command is /dev/null.
set -u

die() { echo "run-capped: $*" >&2; exit 2; }

MEM=${POMTREE_RUN_MEM:-8G}
LIMIT=${POMTREE_RUN_TIMEOUT:-150s}
while [ $# -gt 0 ]; do
  case $1 in
    --mem) [ $# -ge 2 ] || die "--mem needs a value such as 8G; pass it or drop the flag"; MEM=$2; shift 2 ;;
    --timeout) [ $# -ge 2 ] || die "--timeout needs a value such as 150s; pass it or drop the flag"; LIMIT=$2; shift 2 ;;
    --) shift; break ;;
    *) die "unexpected argument '$1'; usage: $0 [--mem 8G] [--timeout 150s] -- <command>..." ;;
  esac
done
[ $# -ge 1 ] || die "no command given after --; usage: $0 [--mem 8G] [--timeout 150s] -- <command>..."

if [ "${POMTREE_RUN_UNCAPPED:-}" = 1 ]; then
  echo "run-capped: NOTICE POMTREE_RUN_UNCAPPED=1, running with no memory cap and no time limit: $*" >&2
  exec "$@"
fi

# Memory size such as 512M, 8G or 1T to kibibytes (the unit of ulimit -v).
mem_kib() {
  case $1 in
    *[!0-9KMGTkmgt]* | "" | [KMGTkmgt]*) return 1 ;;
  esac
  n=${1%[KMGTkmgt]}
  case $1 in
    *[Kk]) echo "$n" ;;
    *[Mm]) echo $((n * 1024)) ;;
    *[Gg]) echo $((n * 1024 * 1024)) ;;
    *[Tt]) echo $((n * 1024 * 1024 * 1024)) ;;
    *) echo $((n / 1024)) ;;
  esac
}
# Duration such as 90, 150s or 5m to seconds.
secs() {
  case $1 in
    *[!0-9sm]* | "" | [sm]*) return 1 ;;
  esac
  n=${1%[sm]}
  case $1 in
    *m) echo $((n * 60)) ;;
    *) echo "$n" ;;
  esac
}
MEM_KIB=$(mem_kib "$MEM") || die "invalid --mem '$MEM'; use a number with a K, M, G or T suffix, for example 8G"
LIMIT_S=$(secs "$LIMIT") || die "invalid --timeout '$LIMIT'; use seconds or a number with s or m, for example 150s"
[ "$LIMIT_S" -gt 0 ] || die "--timeout must be above zero; to run with no limit set POMTREE_RUN_UNCAPPED=1"

TIMEOUT=$(command -v timeout || command -v gtimeout) || die "neither timeout nor gtimeout is installed, so the time limit cannot be enforced; install coreutils or set POMTREE_RUN_UNCAPPED=1 to run uncapped"

# Memory limit in force for this process, in KiB: the smallest numeric memory.max from its cgroup up to the root (cgroup v2).
inherited_kib() {
  local path dir m best=""
  path=$(sed -n 's/^0:://p' /proc/self/cgroup 2> /dev/null) || return 1
  [ -n "$path" ] || return 1
  dir=/sys/fs/cgroup$path
  while [ -n "$dir" ] && [ "$dir" != /sys/fs/cgroup ] && [ "$dir" != /sys/fs ]; do
    m=$(cat "$dir/memory.max" 2> /dev/null) || m=""
    case $m in
      "" | max | *[!0-9]*) ;;
      *) m=$((m / 1024)); if [ -z "$best" ] || [ "$m" -lt "$best" ]; then best=$m; fi ;;
    esac
    dir=${dir%/*}
  done
  [ -n "$best" ] && echo "$best"
}

WRAP=()
if INHERITED=$(inherited_kib) && [ "$INHERITED" -le "$MEM_KIB" ]; then
  echo "run-capped: NOTICE the enclosing cgroup already limits memory to $((INHERITED / 1024))M, at most the requested $MEM; running inside it without a new scope" >&2
  MODE="inherited ${INHERITED}K cgroup"
elif reason=$(systemd-run --user --scope --quiet -p "MemoryMax=$MEM" -p MemorySwapMax=0 true 2>&1); then
  WRAP=(systemd-run --user --scope --quiet -p "MemoryMax=$MEM" -p MemorySwapMax=0)
  MODE="MemoryMax=$MEM cgroup"
else
  [ -n "$reason" ] || reason="systemd-run not found"
  echo "run-capped: NOTICE no systemd user scope available (${reason%%$'\n'*}); falling back to ulimit -v $MEM, a weaker cap on address space rather than resident memory" >&2
  ulimit -v "$MEM_KIB" 2> /dev/null || die "ulimit -v $MEM is not supported here, so no memory cap can be applied; run on Linux with systemd or set POMTREE_RUN_UNCAPPED=1 to run uncapped"
  MODE="ulimit -v $MEM"
fi

# Job control gives the command its own process group (its pid), which a timeout or a signal can kill as a unit.
set -m
START=$SECONDS
"${WRAP[@]}" "$TIMEOUT" -k 5 "${LIMIT_S}s" "$@" < /dev/null &
PGID=$!
SIGNALLED=0
# shellcheck disable=SC2329 # invoked by the trap
forward() { SIGNALLED=1; kill -TERM -- "-$PGID" 2> /dev/null; }
trap forward INT TERM
wait "$PGID"
rc=$?
trap - INT TERM
ELAPSED=$((SECONDS - START))

# Assert the group is gone; kill any survivor and say so.
group_alive() { [ -n "$(ps -o pid= -g "$PGID" 2> /dev/null)" ]; }
if group_alive; then
  kill -KILL -- "-$PGID" 2> /dev/null
  sleep 1
  if group_alive; then
    echo "run-capped: ERROR process group $PGID still has live processes after SIGKILL; find them with 'ps -g $PGID' and kill them by pid" >&2
    exit 1
  fi
  echo "run-capped: killed leftover processes of group $PGID after the command ended" >&2
fi

# After a kernel OOM kill systemd may stop the scope with SIGTERM before `timeout` reaps the SIGKILLed child, and
# `timeout` exits 124 when it is sent SIGTERM. Under the time limit and without a signal sent to this script, that 124 is
# the cap kill, so it is reported as 137 like the reaped case; the code of a cap kill is therefore always 137.
if [ "$rc" -eq 124 ] && [ "$ELAPSED" -lt "$LIMIT_S" ] && [ "$SIGNALLED" -eq 0 ]; then rc=137; fi

if [ "$rc" -eq 124 ] || { [ "$rc" -eq 137 ] && [ "$ELAPSED" -ge "$LIMIT_S" ]; }; then
  echo "run-capped: TIMEOUT after ${LIMIT_S}s; the command and its process group were killed and confirmed stopped. Find the hang or raise --timeout / POMTREE_RUN_TIMEOUT." >&2
  exit 124
fi
if [ "$rc" -eq 137 ] || [ "$rc" -eq 134 ]; then
  echo "run-capped: command ended with code $rc after ${ELAPSED}s, most likely killed for exceeding the memory cap ($MODE). Find the allocation that grows without bound; only if the work truly needs it, raise --mem / POMTREE_RUN_MEM." >&2
fi
exit "$rc"
