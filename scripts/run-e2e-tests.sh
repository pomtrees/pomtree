#!/usr/bin/env bash
# run-e2e-tests: run the key-requiring live e2e tests (docker-pi, pi-ext) against a real model.
# SPENDS REAL MONEY: every run makes real model calls through the model proxy.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/run-e2e-tests.sh --model PROVIDER/ID [--base-url URL] [--key-env VAR] [--only docker-pi|pi-ext|all] [--image TAG] [--dry-run]
  --model PROVIDER/ID  model to call, e.g. deepseek/deepseek-flash (required; spends real money)
  --base-url URL       upstream base URL (default per provider; required for other providers). Defaults:
                       deepseek=https://api.deepseek.com, openai=https://api.openai.com/v1,
                       anthropic=https://api.anthropic.com, openrouter=https://openrouter.ai/api/v1.
                       The deepseek and openrouter defaults are verified live (docker-pi); openai and anthropic are from knowledge and NOT verified live. The model proxy keeps the
                       base URL's path prefix and only forwards /chat/completions, /responses, /messages
                       (with or without /v1).
  --key-env VAR        host env var holding the API key (default per provider: deepseek=DEEPSEEK_API_KEY,
                       openai=OPENAI_API_KEY, anthropic=ANTHROPIC_API_KEY, openrouter=OPENROUTER_API_KEY;
                       required for other providers). The key is read from the host env and never printed. It is written to
                       a mode-0600 temp file (removed on exit); POMTREED_MODEL_UPSTREAM_KEY_FILE names docker-pi's key file, and this
                       script passes only the path, never the key.
  --only SUITE         docker-pi (default; needs the key), pi-ext (no key, no Pi login; makes no model call), or all
  --image TAG          agent image (default: $PTREE_E2E_IMAGE, else pomtree/agent:dev)
  --dry-run            run preflight, print the resolved plan, and exit 0 without running tests
  -h, --help           show this help
Exit: 0 pass; 124 when a suite hit its 240s timeout; node's code when a suite failed (a failure beats a skip);
      3 when any test is skipped or none passed (the point is to actually run them).
USAGE
}

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
model="" base_url="" key_env="" only="docker-pi" image="${PTREE_E2E_IMAGE:-pomtree/agent:dev}" dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --model) model="${2:?--model needs PROVIDER/ID}"; shift 2 ;;
    --base-url) base_url="${2:?--base-url needs URL}"; shift 2 ;;
    --key-env) key_env="${2:?--key-env needs VAR}"; shift 2 ;;
    --only) only="${2:?--only needs docker-pi, pi-ext or all}"; shift 2 ;;
    --image) image="${2:?--image needs TAG}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "run-e2e-tests: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

die() { echo "run-e2e-tests: $*" >&2; exit 1; }

case "$only" in docker-pi|pi-ext|all) ;; *) die "--only must be docker-pi, pi-ext or all (got $only)" ;; esac
[ -n "$model" ] || die "--model is required, PROVIDER/ID (see \`pomtree models\`), e.g. --model deepseek/deepseek-flash"
provider="${model%%/*}" id="${model#*/}"
if [ -z "$provider" ] || [ -z "$id" ] || [ "$provider" = "$model" ]; then die "--model must be PROVIDER/ID (see \`pomtree models\`)"; fi

# Provider defaults. The deepseek and openrouter base URLs are verified live; openai and anthropic are knowledge-only; see usage.
case "$provider" in
  deepseek) def_key=DEEPSEEK_API_KEY def_url=https://api.deepseek.com ;;
  openai) def_key=OPENAI_API_KEY def_url=https://api.openai.com/v1 ;;
  anthropic) def_key=ANTHROPIC_API_KEY def_url=https://api.anthropic.com ;;
  openrouter) def_key=OPENROUTER_API_KEY def_url=https://openrouter.ai/api/v1 ;;
  *) def_key="" def_url="" ;;
esac

need_key=1
[ "$only" = pi-ext ] && need_key=0
if [ -z "$key_env" ]; then key_env="$def_key"; fi
if [ "$need_key" -eq 1 ]; then
  [ -n "$key_env" ] || die "unknown provider '$provider': pass --key-env VAR"
fi
if [ -n "$key_env" ]; then
  case "$key_env" in ''|[0-9]*|*[!A-Za-z0-9_]*) die "--key-env must be an environment variable name (got $key_env)" ;; esac
fi
base_src="--base-url"
if [ -z "$base_url" ]; then base_url="$def_url"; if [ "$provider" = deepseek ] || [ "$provider" = openrouter ]; then base_src="provider default, verified live"; else base_src="provider default, not verified live"; fi; fi
if [ "$need_key" -eq 1 ] && [ -z "$base_url" ]; then die "unknown provider '$provider': pass --base-url URL"; fi

# The key value is read from the host env by indirect expansion and is never printed.
key=""
if [ "$need_key" -eq 1 ]; then
  key="${!key_env:-}"
  [ -n "$key" ] || die "$key_env is not set or empty in the host environment (export it, or pass --key-env VAR)"
fi

# Preflight.
# GNU timeout bounds every suite; macOS coreutils installs it as gtimeout.
tmo=""
for c in timeout gtimeout; do
  if command -v "$c" >/dev/null 2>&1; then tmo="$c"; break; fi
done
[ -n "$tmo" ] || die "neither timeout nor gtimeout on PATH (needed to bound the run; macOS: brew install coreutils, which provides gtimeout)"
docker info >/dev/null 2>&1 || die "docker daemon unreachable (start Docker, then check \`docker info\`)"
docker image inspect "$image" >/dev/null 2>&1 || die "image $image not found; build it with: AGENT_IMAGE_TAG=$image pnpm --filter @pomtree/agent-image build:image"
if [ "$only" != pi-ext ]; then
  command -v pi >/dev/null 2>&1 || die "pi not on PATH (docker-pi needs it)"
fi

suites=()
case "$only" in
  docker-pi) suites=(docker-pi) ;;
  pi-ext) suites=(pi-ext) ;;
  all) suites=(docker-pi pi-ext) ;;
esac

key_desc="not needed"
if [ "$need_key" -eq 1 ]; then key_desc="$key_env set (${#key} chars)"; fi

if [ "$dry_run" -eq 1 ]; then
  echo "run-e2e-tests: dry run, no tests executed"
  echo "  provider    $provider"
  echo "  model       $model"
  echo "  base URL    $base_url ($base_src)"
  echo "  key         $key_desc"
  echo "  image       $image"
  echo "  tests       ${suites[*]}"
  for s in "${suites[@]}"; do
    case "$s" in
      docker-pi) echo "  docker-pi   (cd packages/e2e && $tmo 240 node --test --test-reporter=spec src/docker-pi.test.ts)" ;;
      pi-ext) echo "  pi-ext      (cd packages/harness-pi && $tmo 240 node --test --test-reporter=spec src/pi-ext-live.test.ts)" ;;
    esac
  done
  exit 0
fi

# Exported for the child processes only (this script's environment).
export PTREE_DOCKER_TESTS=1
export PTREE_E2E_IMAGE="$image"
export PTREE_E2E_MODEL_BASE_URL="$base_url"
# POMTREED_MODEL_UPSTREAM_KEY_FILE names docker-pi's key file; the children get only the path, never the key (an env value would reach every grandchild).
if [ "$need_key" -eq 1 ]; then
  key_file="$(mktemp "${TMPDIR:-/tmp}/run-e2e-key.XXXXXX")"
  trap 'rm -f "$key_file"' EXIT
  chmod 600 "$key_file"
  printf '%s' "$key" >"$key_file"
  key=""
  export POMTREED_MODEL_UPSTREAM_KEY_FILE="$key_file"
fi
export POMTREED_PI_PROVIDER="$provider"
export PTREE_E2E_MODEL="$model"
export PTREE_LIVE_MODEL="$id"

echo "run-e2e-tests: this makes REAL model calls to $model and spends real money. Running: ${suites[*]}"

worst=0
run_suite() {
  local name="$1" dir="$2" file="$3" out rc=0 pass skipped reasons
  out="$(mktemp)"
  (cd "$root/$dir" && "$tmo" 240 node --test --test-reporter=spec "$file") >"$out" 2>&1 || rc=$?
  cat "$out"
  pass="$(sed -n 's/^ℹ pass \([0-9]*\).*/\1/p' "$out" | tail -n1)"
  skipped="$(sed -n 's/^ℹ skipped \([0-9]*\).*/\1/p' "$out" | tail -n1)"
  pass="${pass:-0}"; skipped="${skipped:-0}"
  if [ "$skipped" -gt 0 ]; then
    # Spec reporter marks skipped tests with ﹣ and appends "# reason".
    reasons="$(grep '^﹣' "$out" | grep ' # ' | sed 's/.* # //' | tr '\n' ';' || true)"
    echo "run-e2e-tests: $name: tests were skipped: ${reasons:-no reason reported}" >&2
  fi
  # Precedence: a timeout or failure is reported as such and its code beats an earlier skip's 3; the first failure's code is kept.
  if [ "$rc" -eq 124 ]; then
    echo "run-e2e-tests: $name: timed out after 240s (killed by $tmo)" >&2
  elif [ "$rc" -ne 0 ]; then
    echo "run-e2e-tests: $name: failed (node exit $rc)" >&2
  elif [ "$pass" -eq 0 ] && [ "$skipped" -eq 0 ]; then
    echo "run-e2e-tests: $name: no tests passed (pass 0)" >&2
  fi
  if [ "$rc" -ne 0 ]; then
    if [ "$worst" -eq 0 ] || [ "$worst" -eq 3 ]; then worst="$rc"; fi
  elif [ "$skipped" -gt 0 ] || [ "$pass" -eq 0 ]; then
    if [ "$worst" -eq 0 ]; then worst=3; fi
  fi
  rm -f "$out"
}

for s in "${suites[@]}"; do
  case "$s" in
    docker-pi) run_suite docker-pi packages/e2e src/docker-pi.test.ts ;;
    pi-ext) run_suite pi-ext packages/harness-pi src/pi-ext-live.test.ts ;;
  esac
done
exit "$worst"
