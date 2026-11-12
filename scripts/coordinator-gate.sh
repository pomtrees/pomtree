#!/bin/bash
# Coordinator commit-and-push gate for pomtree.
#
# Usage: scripts/coordinator-gate.sh [--branch <remote>/<branch>] <commit-message-file> <path>...
#   <path>...   files to stage, relative to the repository root (explicit paths only; never a directory or ".").
#   --branch    the remote branch to push to and diff against; defaults to the current branch's upstream.
#   CHECK_ONLY=1  run the gate and print the verdict without committing or pushing.
#
# What it does, in order:
#   1. Stages the given paths and refuses to continue if anything else is unstaged or untracked.
#   2. Runs the four legs of `pnpm check:lite` without bail into one log under ${TMPDIR:-/tmp}/pomtree-gate:
#      format:check, lint, typecheck and test:lite. It invokes the very package scripts check:lite invokes, so the
#      gate can never execute less than check:lite: test:lite's coverage of the packages, the examples and the
#      release-export scan is check:lite's coverage by construction, not by a list kept in step here.
#   3. Verdict, from EXIT CODES ONLY. Any nonzero static leg blocks. A nonzero test leg blocks unless it is the one
#      documented tolerance, a failure under whole-tree parallel load that does not survive a split re-run: the tree
#      minus pomtreed, the examples and the release-export scan must then all pass on a re-run AND pomtreed must pass alone.
#      That case is documented in the commit message, not fixed, per the feature-branch policy (owner decision,
#      2026-10-24, recorded for pomtreed under load). The width of that tolerance, stated honestly: exit codes cannot
#      attribute the first run's failure to pomtreed, because a pomtreed load flake and a flake anywhere else present the
#      identical observable state (first leg red, every split re-run green). Attributing it would mean parsing test
#      titles, which is what made this gate vacuous to begin with, so the gate tolerates that state rather than that
#      package, and the caveat says so without naming a culprit. Anything that reproduces on the re-run blocks.
#   4. Commits with the message (plus the caveat, before the trailers) and pushes HEAD to the remote branch.
#
# Why the verdict reads exit codes and never test output: a title filter is silent when it misses, so a hole in it
# looks exactly like a green tree. This gate used to decide on `grep -E '^packages/[a-z0-9-]+ test: ✖ [^f]' |
# grep -v 'TODO('`, which dropped every failing test whose title began with "f" or mentioned a TODO tag, over a
# fail-closed fallback that only asked whether a POMTREED failure had been named. A red e2e test, a crashed core package
# and one named pomtreed failure in the same log therefore produced VERDICT-OK. packages/e2e/src/coordinator-gate.test.ts
# drives this script over a scripted pnpm and keeps that log as a negative control; it is also why the caveat below
# points at the log instead of naming the failing tests, since naming them would need the parser back.
#
# Read the whole verdict line, never a tail of the log. Exit 0 means VERDICT-OK (CHECK_ONLY) or SHIPPED; anything
# else printed NOT-SHIPPED or ABORT with the log path.
set -u

usage() { echo "usage: $0 [--branch <remote>/<branch>] <commit-message-file> <path>..." >&2; exit 2; }

UPSTREAM=""
if [ "${1:-}" = "--branch" ]; then
  [ $# -ge 2 ] || usage
  UPSTREAM=$2
  shift 2
fi
[ $# -ge 2 ] || usage

MSG_IN=$1; shift
[ -f "$MSG_IN" ] || { echo "ABORT: commit message file not found: $MSG_IN" >&2; exit 2; }
MSG="$(cd "$(dirname "$MSG_IN")" && pwd)/$(basename "$MSG_IN")"

ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel) || { echo "ABORT: not inside a git repository" >&2; exit 1; }
cd "$ROOT" || exit 1

if [ -z "$UPSTREAM" ]; then
  UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) || {
    echo "ABORT: the current branch has no upstream; pass --branch <remote>/<branch>" >&2
    exit 2
  }
fi
REMOTE=${UPSTREAM%%/*}
BRANCH=${UPSTREAM#*/}
[ -n "$REMOTE" ] && [ -n "$BRANCH" ] && [ "$REMOTE" != "$UPSTREAM" ] || { echo "ABORT: --branch must be <remote>/<branch>, got: $UPSTREAM" >&2; exit 2; }

LOGDIR=${TMPDIR:-/tmp}/pomtree-gate
mkdir -p "$LOGDIR" || { echo "ABORT: cannot create $LOGDIR" >&2; exit 1; }

git add -- "$@"
[ -z "$(git status --short | grep -v '^[MAD] ')" ] || { echo "ABORT: unstaged or untracked changes present"; git status --short | grep -v '^[MAD] '; exit 1; }

L=$LOGDIR/gate-$(date +%s).log
CONC=${WORKSPACE_TEST_CONCURRENCY:-6}
# Loaded-machine multiplier for test deadlines (packages/testing/src/timing.ts); CI sets the same 3.
export POMTREE_TEST_TIMEOUT_SCALE="${POMTREE_TEST_TIMEOUT_SCALE:-3}"
# A brace group, not a subshell, so the exit codes survive the redirection and the verdict never has to read the log.
{ pnpm format:check; fmt_rc=$?; pnpm lint; lint_rc=$?; pnpm typecheck; tc_rc=$?; pnpm test:lite; test_rc=$?; } > "$L" 2>&1
echo "gate legs: format:check=$fmt_rc lint=$lint_rc typecheck=$tc_rc test:lite=$test_rc" >> "$L"

BAD=""
[ "$fmt_rc" -eq 0 ] || BAD="$BAD format:check"
[ "$lint_rc" -eq 0 ] || BAD="$BAD lint"
[ "$tc_rc" -eq 0 ] || BAD="$BAD typecheck"
[ -z "$BAD" ] || { echo "NOT-SHIPPED: static checks failed:$BAD ($L)"; exit 1; }

CAVEAT=""
if [ "$test_rc" -ne 0 ]; then
  # Re-run the test leg split three ways, so "only pomtreed failed" is established by three exit codes rather than by
  # reading titles. Anything red here blocks, whatever it is called and whether or not it names a test at all.
  { pnpm -r --no-bail --workspace-concurrency="$CONC" --filter '!@pomtree/pomtreed' test; rest_rc=$?
    pnpm test:examples; ex_rc=$?
    pnpm test:release-export; rex_rc=$?; } > "$L.rest" 2>&1
  echo "gate re-run: packages-except-pomtreed=$rest_rc examples=$ex_rc release-export=$rex_rc" >> "$L.rest"
  BAD=""
  [ "$rest_rc" -eq 0 ] || BAD="$BAD packages-except-pomtreed"
  [ "$ex_rc" -eq 0 ] || BAD="$BAD examples"
  [ "$rex_rc" -eq 0 ] || BAD="$BAD release-export"
  [ -z "$BAD" ] || { echo "NOT-SHIPPED: tests failed outside pomtreed:$BAD ($L.rest)"; exit 1; }
  { pnpm --filter @pomtree/pomtreed test; pomtreed_rc=$?; } > "$L.pomtreed" 2>&1
  [ "$pomtreed_rc" -eq 0 ] || { echo "NOT-SHIPPED: pomtreed fails alone too ($L.pomtreed)"; exit 1; }
  # Branch policy (owner, 2026-10-24): document, don't block. Whether the change touches pomtreed only changes the caveat's wording.
  if git diff --cached --quiet "$REMOTE/$BRANCH" -- packages/pomtreed; then TOUCH="this change touches no pomtreed file"; else TOUCH="this change touches pomtreed"; fi
  CAVEAT="Caveat: the whole-tree parallel test run failed and did not reproduce when re-run split up (TODO(load-flakes)); the failing tests are named in the gate log $L, which is where attribution has to come from, since the gate reads exit codes and cannot say which package was at fault. $TOUCH. On re-run the tree minus pomtreed, the examples and the release-export scan all pass, and pomtreed passes alone."
fi

if [ "${CHECK_ONLY:-}" = 1 ]; then echo "VERDICT-OK${CAVEAT:+ CAVEAT: $CAVEAT}"; exit 0; fi

# The caveat goes before the message's trailer lines (Co-Authored-By and the like), which are kept as written.
FINAL=$L.msg
if [ -n "$CAVEAT" ]; then
  { grep -v '^Co-Authored-By:' "$MSG"; printf '%s\n' "$CAVEAT"; if grep -q '^Co-Authored-By:' "$MSG"; then printf '\n'; grep '^Co-Authored-By:' "$MSG"; fi; } > "$FINAL"
else
  cp "$MSG" "$FINAL"
fi
git commit -q -F "$FINAL" && git push -q "$REMOTE" "HEAD:$BRANCH" && echo "SHIPPED $(git rev-parse --short HEAD)${CAVEAT:+ (caveat)}"
