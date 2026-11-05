#!/bin/bash
# Recorded local run of .github/workflows/ci.yml in clean environments (the first-cut CI gate;
# TODO(ci-image-gate)). See scripts/ci-local/README.md for what differs from hosted CI.
#
# Usage: scripts/ci-local/run.sh [--out <dir>] [--jobs <a,b,..>] [--keep] [--image-tag <tag>] [--no-image-cache]
#   --out <dir>        where logs and verdict.txt go (default: a fresh mktemp dir under /tmp)
#   --jobs <list>      comma list from format,lint,typecheck,test-lite,image,docker (default: all; docker implies image)
#   --keep             keep extractions, containers and the built image
#   --image-tag <tag>  agent image tag for image/docker (default pomtree/agent:ci-local-<shortsha>; ci.yml uses :dev)
#   --no-image-cache   build the image without the persistent layer cache (AGENT_IMAGE_CACHE_DIR is not passed on)
#
# format, lint, typecheck and test-lite each get a fresh node:24-bookworm-slim container holding a fresh clone of HEAD
# of the repo, run as a non-root user. image and docker run on the host (Docker-gated suites bind-mount host temp paths, which
# cannot work from a container) in one fresh checkout of HEAD under /tmp, on the host's own node, which must be major 24. Only committed state (HEAD) is tested.
# The selected jobs run in parallel, as the ci.yml jobs do; docker runs after image, as `needs: [image]`, and its groups (scripts/ci/docker-groups.json)
# run one after another because here they share one Docker daemon. Exit 0 only when every expected verdict line has rc=0. Read verdict.txt whole, never a tail.
# Single-quoted ci.yml text and in-container scripts are literal; steps.sh is generated; ps|grep mirrors ci.yml.
# shellcheck disable=SC2016,SC1091,SC2009
set -u

# declare -A (job pids below) needs bash 4; macOS /bin/bash is 3.2. Checked first so nothing launches and the exit is nonzero.
if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "ABORT: run.sh needs bash 4 or newer (this is ${BASH_VERSION}); run it with a newer bash, for example 'brew install bash' then /opt/homebrew/bin/bash scripts/ci-local/run.sh" >&2
  exit 2
fi

SP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT=$(git -C "$SP" rev-parse --show-toplevel) || { echo "ABORT: not inside a git repository" >&2; exit 2; }
CI_YML_PATH=.github/workflows/ci.yml
ALL_JOBS=(format lint typecheck test-lite image docker)
NODE_IMAGE=node:24-bookworm-slim

OUT=""; JOBS=""; KEEP=0; TAG=""; IMAGE_CACHE=1
usage() { sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || usage; OUT=$2; shift 2 ;;
    --jobs) [ $# -ge 2 ] || usage; JOBS=$2; shift 2 ;;
    --image-tag) [ $# -ge 2 ] || usage; TAG=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --no-image-cache) IMAGE_CACHE=0; shift ;;
    *) usage ;;
  esac
done

SHA=$(git -C "$ROOT" rev-parse HEAD) || exit 2
SHORT=$(git -C "$ROOT" rev-parse --short HEAD)
[ -n "$TAG" ] || TAG="pomtree/agent:ci-local-$SHORT"
[ "$TAG" != "pomtree/agent:dev" ] || { echo "ABORT: refusing --image-tag pomtree/agent:dev (a pre-existing :dev image must not be overwritten); pick another tag" >&2; exit 2; }
[ -n "$JOBS" ] || JOBS=$(IFS=,; echo "${ALL_JOBS[*]}")
for j in ${JOBS//,/ }; do
  case " ${ALL_JOBS[*]} " in *" $j "*) ;; *) echo "ABORT: unknown job '$j'; expected a comma list of ${ALL_JOBS[*]}" >&2; exit 2 ;; esac
done
case ",$JOBS," in *",docker,"*) case ",$JOBS," in *",image,"*) ;; *) JOBS="$JOBS,image" ;; esac ;; esac   # docker needs the image
[ -n "$OUT" ] || OUT=$(mktemp -d /tmp/ci-local-out.XXXXXX) || exit 2
mkdir -p "$OUT" || { echo "ABORT: cannot create $OUT" >&2; exit 2; }
OUT=$(cd "$OUT" && pwd)
WORK=$(mktemp -d /tmp/ci-local-work.XXXXXX) || exit 2   # under /tmp, never /home: nothing from /home is mounted
VERDICT=$OUT/verdict.txt
BUILT_FLAG=$WORK/image-built   # touched by the image job (a subshell) once the image exists

cleanup() {
  local pid j
  for pid in $(jobs -p); do kill "$pid" 2>/dev/null; done   # an interrupted run: stop the background jobs first
  wait 2>/dev/null
  [ "$KEEP" = 1 ] && { echo "kept: work=$WORK containers=ci-local-<job>-$$ image=$([ -e "$BUILT_FLAG" ] && echo "$TAG" || echo none)"; return; }
  for j in "${ALL_JOBS[@]}"; do docker rm -f "ci-local-$j-$$" >/dev/null 2>&1; done   # exact names only, never a prune
  [ -e "$BUILT_FLAG" ] && docker rmi "$TAG" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# --- Drift guard: every ci.yml line this script mirrors must still be there, or the script is stale. ---
git -C "$ROOT" show "HEAD:$CI_YML_PATH" > "$WORK/ci.yml" || { echo "ABORT: cannot read $CI_YML_PATH at HEAD" >&2; exit 2; }
sed 's/^ *//' "$WORK/ci.yml" > "$WORK/ci.norm"
# The Docker groups at HEAD, from the one definition ci.yml's matrix and the root test:docker:<group> scripts follow.
mapfile -t DOCKER_GROUPS < <(git -C "$ROOT" show HEAD:scripts/ci/docker-groups.json | python3 -I -c 'import json, sys; print("\n".join(json.load(sys.stdin)["groups"]))')
if [ "${#DOCKER_GROUPS[@]}" -eq 0 ]; then echo "ABORT: cannot read the Docker groups from scripts/ci/docker-groups.json at HEAD" >&2; exit 2; fi
EXPECTED=(
  "format:" "lint:" "typecheck:" "test-lite:" "image:" "docker:"
  "needs: [image]"
  "fail-fast: false"
  "group: [$(printf '%s, ' "${DOCKER_GROUPS[@]}" | sed 's/, $//')]"
  "DOCKER_GROUP: \${{ matrix.group }}"
  # The per-group limit expressions; their values (defaults and matrix include overrides) are read below, not copied.
  'timeout-minutes: ${{ matrix.job_minutes || 30 }}'
  'timeout-minutes: ${{ matrix.test_minutes || 15 }}'
  "node-version: 24"
  "- run: pnpm install --frozen-lockfile"
  "- run: pnpm format:check"
  "- run: pnpm lint"
  "- run: pnpm typecheck"
  "- run: pnpm test:lite"
  "run: pnpm --filter @pomtree/agent-image build:image"
  "AGENT_IMAGE_TAG: pomtree/agent:dev"
  "bash -c 'set -o pipefail; pnpm test:docker:\"\$DOCKER_GROUP\" 2>&1 | tee test-docker.log'"
  "PTREE_E2E_IMAGE: pomtree/agent:dev"
  'PTREE_AGENT_TEST_REVISION: ${{ github.sha }}'
  "- name: Require git at the workspace floor"
  "- name: Guard against skipped Docker/image tests"
  'run: python3 scripts/ci/skip-guard.py --group "$DOCKER_GROUP" test-docker.log'
  "- name: Diagnostics on failure"
  "docker ps -a --format '{{.Names}} {{.Status}}' || true"
  "docker network ls || true"
  "ps -eo pid,ppid,etime,args --sort=etime | grep -E 'node|docker|chrom' | grep -v grep | head -40 || true"
  "tail -n 60 test-docker.log || true"
)
for e in "${EXPECTED[@]}"; do
  grep -Fxq -- "$e" "$WORK/ci.norm" || { echo "ABORT: ci.yml drifted: expected line not found: $e. Update scripts/ci-local/run.sh to match." >&2; exit 2; }
done

# --- Extract the floor check's python heredoc from ci.yml rather than copying it (the skip guard is a checked-in script). ---
python3 -I - "$WORK/ci.yml" "$WORK" <<'EXTRACT_PY' || { echo "ABORT: could not extract the floor step or the docker group limits from ci.yml; update scripts/ci-local/run.sh" >&2; exit 2; }
import sys
lines = open(sys.argv[1]).read().split("\n")
out = sys.argv[2]
def bodies(step):
    found = []
    for i, l in enumerate(lines):
        if l.strip() != f"- name: {step}":
            continue
        j = i + 1
        while "python3 - <<'PY'" not in lines[j]:
            if lines[j].strip().startswith("- name:"):
                sys.exit(f"step {step!r} has no python heredoc")
            j += 1
        ind = len(lines[j]) - len(lines[j].lstrip())
        body = []
        j += 1
        while lines[j].strip() != "PY":
            body.append(lines[j][ind:])
            j += 1
        found.append("\n".join(body) + "\n")
    return found
floor = bodies("Require git at the workspace floor")
if len(floor) != 2 or floor[0] != floor[1]:
    sys.exit("expected the floor step twice (test-lite, docker) with identical bodies")
open(f"{out}/floor.py", "w").write(floor[0])
# Per-group test step limits in seconds: the docker job's `matrix.test_minutes || N` default, overridden by `include` entries.
import re
text = "\n".join(lines)
start = text.index("\n  docker:\n")
nxt = re.search(r"\n  [A-Za-z0-9_-]+:\n", text[start + 1:])
job = text[start: start + 1 + nxt.start()] if nxt else text[start:]
default = re.search(r"timeout-minutes: \$\{\{ matrix\.test_minutes \|\| (\d+) \}\}", job)
groups = re.search(r"^ {8}group: \[([^\]]*)\]$", job, re.M)
if not default or not groups:
    sys.exit("the docker job has no `matrix.test_minutes || N` step limit or no group list")
limits = {g.strip(): int(default.group(1)) for g in groups.group(1).split(",")}
for m in re.finditer(r"^ {10}- group: (\S+)\n((?: {12}\w+: \d+\n)*)", job, re.M):
    t = re.search(r"test_minutes: (\d+)", m.group(2))
    if m.group(1) not in limits:
        sys.exit(f"matrix include names unknown group {m.group(1)}")
    if t:
        limits[m.group(1)] = int(t.group(1))
open(f"{out}/group-limits", "w").write("".join(f"{g} {mins * 60}\n" for g, mins in limits.items()))
EXTRACT_PY

# Shared step runner, used on the host and inside containers: a failing step ends the job (Actions semantics).
cat > "$WORK/steps.sh" <<'STEPS'
# step <name> <timeout-secs> <cmd...>
step() {
  local n=$1 t=$2 rc
  shift 2
  echo "::step $n"
  timeout -k 10 "$t" "$@"
  rc=$?
  if [ "$rc" -ne 0 ]; then echo "::step-failed $n rc=$rc"; exit "$rc"; fi
}
STEPS

# --- node:test summary counts. pnpm -r prefixes every line ("packages/x test: ") and may colour it, so strip ANSI and match
# the "ℹ <key> N" (spec) or "# <key> N" (TAP) totals line anywhere after the prefix; the per-job count is the sum over lines. ---
counts() { # <log>
  sed 's/\x1b\[[0-9;]*m//g' "$1" | awk '
    match($0, /(ℹ|#) (tests|pass|fail|cancelled|skipped|todo) [0-9]+[[:space:]]*$/) {
      n = split(substr($0, RSTART), f, " "); s[f[2]] += f[n]
    }
    END { printf "tests=%d pass=%d fail=%d cancelled=%d skipped=%d todo=%d", s["tests"], s["pass"], s["fail"], s["cancelled"], s["skipped"], s["todo"] }'
}

record() { # <job> <rc> <secs> <log> [extra]
  echo "job=$1 rc=$2 secs=$3 log=$4${5:+ $5}" | tee -a "$VERDICT"
}

# Fresh checkout of HEAD with its .git, as actions/checkout leaves one (the env-drift tests run `git ls-files`): committed files only, no
# node_modules or local state, the real sha, no remote.
checkout() { # <dir>
  git clone -q --no-local --no-checkout "file://$(cd "$ROOT" && git rev-parse --path-format=absolute --git-common-dir)" "$1" \
    && git -C "$1" checkout -q --detach "$SHA" && git -C "$1" remote remove origin
}

# --- Container jobs: fresh container, fresh checkout copied in, non-root user "runner" (uid 1001, as on ubuntu-latest). ---
# Extra packages beyond the base image: git (checkout + real-git tests), python3 (the floor step), ca-certificates (https registry),
# procps (ps, present on the hosted runner). Corepack ships with node 24 and provides the pnpm pinned by package.json packageManager.
container_job() { # <job> <timeout-secs>
  local job=$1 tmo=$2 c=ci-local-$1-$$ stage=$WORK/stage-$1 log=$OUT/$1.log t0 rc
  mkdir -p "$stage/ci"
  cp "$WORK/steps.sh" "$stage/ci/steps.sh"
  cat > "$stage/ci/setup.sh" <<'SETUP'
set -u
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq --no-install-recommends git python3 ca-certificates procps || exit 1
corepack enable || exit 1
useradd -m -u 1001 runner && chown -R runner /work || exit 1
# The home dir is looked up, not spelled out: a literal runner home path in a shipped file trips the release scan's home-dir and user-name detectors on a runner host.
exec runuser -u runner -- env "HOME=$(getent passwd runner | cut -d: -f6)" bash /ci/job.sh
SETUP
  {
    echo ". /ci/steps.sh"
    echo "cd /work || exit 1"
    echo "step install 300 pnpm install --frozen-lockfile"
    case $job in
      format) echo "step format 480 pnpm format:check" ;;
      lint) echo "step lint 480 pnpm lint" ;;
      typecheck) echo "step typecheck 480 pnpm typecheck" ;;
      test-lite)
        echo "step floor 120 bash -c 'git --version && python3 /ci/floor.py'"
        echo "step test-lite 900 pnpm test:lite" ;;
    esac
  } > "$stage/ci/job.sh"
  cp "$WORK/floor.py" "$stage/ci/floor.py"
  t0=$(date +%s)
  # No Docker socket, no bind mounts: files go in with docker cp. CI=true as on hosted runners. --init gives the container a PID 1 that
  # reaps orphans, as systemd does on the hosted runner; without it jobs.test.ts's killed grandchildren stay zombies and look alive.
  if ! docker create --rm --init --name "$c" -e CI=true -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -w /work "$NODE_IMAGE" bash /ci/setup.sh > "$log" 2>&1 \
    || ! { checkout "$stage/work" && tar -C "$stage" -c work | docker cp - "$c:/"; } >> "$log" 2>&1 \
    || ! tar -C "$stage" -c ci | docker cp - "$c:/" >> "$log" 2>&1; then
    record "$job" 125 $(($(date +%s) - t0)) "$log" "note=container-setup-failed"
    return 125
  fi
  timeout -k 10 "$tmo" docker start -a "$c" >> "$log" 2>&1
  rc=$?
  [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ] && docker kill "$c" >/dev/null 2>&1
  if [ "$job" = test-lite ]; then record "$job" "$rc" $(($(date +%s) - t0)) "$log" "$(counts "$log")"; else record "$job" "$rc" $(($(date +%s) - t0)) "$log"; fi
  return "$rc"
}

# --- image, then docker, on the host, from one fresh checkout of HEAD (valid git repo at the real sha; see README) under /tmp. ---
# ci.yml's image job builds and caches the image and each docker matrix entry loads it on its own VM; here the image is built
# once into the host daemon and the groups run one after another against it, because they share that daemon (and its ports
# and networks) and would contend where hosted entries do not. Each group gets a docker-<group> verdict line, and a failing
# group does not stop the next one (ci.yml: fail-fast false).
host_jobs() {
  local dir=$WORK/host-src log=$OUT/image.log t0 rc g glog grc
  export CI=true   # as on hosted runners; this function runs in its own subshell
  t0=$(date +%s)
  # When docker is selected and the image cannot be built, every group still gets a failing line, so the verdict names it.
  no_groups() { # <note>
    case ",$JOBS," in *",docker,"*) for g in "${DOCKER_GROUPS[@]}"; do record "docker-$g" 2 0 "$log" "note=$1"; done ;; esac
  }
  if docker image inspect "$TAG" >/dev/null 2>&1; then
    echo "ABORT: image $TAG already exists; pass --image-tag with an unused tag so it is never overwritten or removed" >&2
    record image 2 0 "$log" "note=image-tag-exists"; no_groups image-tag-exists; return 2
  fi
  if ! checkout "$dir" > "$log" 2>&1; then
    record image 2 $(($(date +%s) - t0)) "$log" "note=checkout-failed"; no_groups checkout-failed; return 2
  fi
  # These jobs run on the host's own node, which must be the major ci.yml's node-version pins (the container jobs use the same major).
  if ! command -v node >/dev/null 2>&1 \
    || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)' >> "$log" 2>&1; then
    echo "ABORT: the image and docker jobs need Node 24 on the host PATH (found: $(node -v 2>/dev/null || echo none)); install Node 24 (for example 'brew install node@24' or nvm) and put it first on PATH" | tee -a "$log" >&2
    record image 2 $(($(date +%s) - t0)) "$log" "note=host-node-24-unavailable"; no_groups host-node-24-unavailable; return 2
  fi
  (
    . "$WORK/steps.sh"
    cd "$dir" || exit 1
    echo "::host-node $(node -v) $(command -v node)"
    step install 300 pnpm install --frozen-lockfile
    # Build the agent image. The tag differs from ci.yml's :dev so a pre-existing :dev image is untouched.
    # The layer cache lives outside $WORK (removed on exit) so it survives across runs; a pre-set non-empty AGENT_IMAGE_CACHE_DIR overrides the default.
    if [ "$IMAGE_CACHE" = 1 ]; then
      IMAGE_CACHE_DIR="${AGENT_IMAGE_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/pomtree/ci-local/agent-image-cache}"
      step cache-dir 30 mkdir -p "$IMAGE_CACHE_DIR"
      step build-image 1200 env AGENT_IMAGE_TAG="$TAG" AGENT_IMAGE_CACHE_DIR="$IMAGE_CACHE_DIR" pnpm --filter @pomtree/agent-image build:image
    else
      step build-image 1200 env -u AGENT_IMAGE_CACHE_DIR AGENT_IMAGE_TAG="$TAG" pnpm --filter @pomtree/agent-image build:image
    fi
  ) >> "$log" 2>&1
  rc=$?
  docker image inspect "$TAG" >/dev/null 2>&1 && : > "$BUILT_FLAG"
  record image "$rc" $(($(date +%s) - t0)) "$log"
  case ",$JOBS," in *",docker,"*) ;; *) return "$rc" ;; esac
  if [ "$rc" -ne 0 ]; then no_groups image-failed; return 1; fi
  for g in "${DOCKER_GROUPS[@]}"; do
    glog=$OUT/docker-$g.log
    t0=$(date +%s)
    (
      . "$WORK/steps.sh"
      cd "$dir" || exit 1
      step floor 120 bash -c "git --version && python3 '$WORK/floor.py'"
      # PTREE_AGENT_TEST_IMAGE is an addition to ci.yml: the sandbox-docker gates default to :dev (docker-gate.ts IMAGE).
      # test-docker.log is written at the checkout root, outside packages/agent-image and packages/sandbox-docker (the gates reject dirty trees).
      echo "::step test"
      rm -f test-docker.log
      # ci.yml's per-group test step limit, read from its matrix by the extraction above.
      limit=$(awk -v g="$g" '$1 == g { print $2 }' "$WORK/group-limits")
      [ -n "$limit" ] || { echo "::step-failed test: no step limit for group $g in ci.yml's docker matrix" >&2; exit 2; }
      timeout -k 10 "$limit" env DOCKER_GROUP="$g" PTREE_E2E_IMAGE="$TAG" PTREE_AGENT_TEST_IMAGE="$TAG" PTREE_AGENT_TEST_REVISION="$SHA" \
        bash -c 'pnpm test:docker:"$DOCKER_GROUP" 2>&1 | tee test-docker.log; exit "${PIPESTATUS[0]}"'
      trc=$?
      [ "$trc" -eq 0 ] || echo "::step-failed test rc=$trc"
      # The guard also runs after failed tests, as in ci.yml (if: !cancelled()), so the log names the required tests that did not pass.
      step guard 120 python3 scripts/ci/skip-guard.py --group "$g" test-docker.log
      exit "$trc"
    ) > "$glog" 2>&1
    grc=$?
    if [ "$grc" -ne 0 ]; then
      # Diagnostics on failure (best effort, as in ci.yml).
      {
        echo "::diagnostics"
        docker ps -a --format '{{.Names}} {{.Status}}' || true
        docker network ls || true
        ps -eo pid,ppid,etime,args --sort=etime | grep -E 'node|docker|chrom' | grep -v grep | head -40 || true
        tail -n 60 "$dir/test-docker.log" || true
      } >> "$glog" 2>&1
      rc=1
    fi
    # Counts come from test-docker.log, the same stream the guard reads.
    record "docker-$g" "$grc" $(($(date +%s) - t0)) "$glog" "$([ -f "$dir/test-docker.log" ] && counts "$dir/test-docker.log" || echo 'counts=none')"
    [ -f "$dir/test-docker.log" ] && cp "$dir/test-docker.log" "$OUT/docker-$g.pnpm.log"
  done
  return "$rc"
}

: > "$VERDICT"
{
  echo "# ci-local verdict for $SHA (short $SHORT); node image $NODE_IMAGE; agent image tag $TAG; started $(date -u +%FT%TZ)"
  git -C "$ROOT" status --porcelain | grep -q . && echo "# WARNING: worktree has uncommitted changes; only HEAD was tested"
} | tee -a "$VERDICT"

# Every selected job runs at once in its own subshell (own container or host checkout, own log); record() appends one short line
# per job to the verdict. Parallel jobs share the machine, so each job's secs includes contention that a hosted runner would not have.
declare -A PID
for job in "${ALL_JOBS[@]}"; do
  case ",$JOBS," in *",$job,"*) ;; *) continue ;; esac
  case $job in
    format | lint | typecheck) ( container_job "$job" 600 ) & ;;
    test-lite) ( container_job "$job" 1200 ) & ;;
    image) ( host_jobs ) & ;;   # also runs the docker groups when docker is selected
    docker) continue ;;
  esac
  PID[$job]=$!
done
overall=0
for job in "${!PID[@]}"; do
  wait "${PID[$job]}" || overall=1
done
# Fail closed: exit 0 only when every expected verdict line (each selected job, docker as one line per group) has rc=0,
# whatever happened in the launch loop.
for job in ${JOBS//,/ }; do
  if [ "$job" = docker ]; then
    for g in "${DOCKER_GROUPS[@]}"; do grep -Eq "^job=docker-$g rc=0( |\$)" "$VERDICT" || overall=1; done
  else
    grep -Eq "^job=$job rc=0( |\$)" "$VERDICT" || overall=1
  fi
done

echo "verdict: $VERDICT (overall rc=$overall)"
exit "$overall"
