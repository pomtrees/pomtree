#!/usr/bin/env bash
# Offline fake of the pomtree CLI for drive.test.mts. Logs one line per call to $FAKE_LOG (args joined by " | ", newlines shown as \n),
# full spawn task text to $FAKE_TASKS. Never reads, prints or touches any token. Knobs: FAKE_TABS (0|1|2), FAKE_FAIL_READER=<r, 1-based>, FAKE_FAIL_ALL_READERS=1, FAKE_WAIT_TIMEOUTS=<n> (exit-7 answers per agent before done).
set -euo pipefail

: "${FAKE_LOG:?FAKE_LOG must name the call log file}"
: "${FAKE_TASKS:=${FAKE_LOG}.tasks}"
MAP="${FAKE_LOG}.agents"
touch "$MAP"

line=""
for a in "$@"; do line+="${line:+ | }${a//$'\n'/\\n}"; done
printf '%s\n' "$line" >>"$FAKE_LOG"

args=()
for a in "$@"; do [ "$a" = "--json" ] || args+=("$a"); done
set -- "${args[@]}"
cmd="${1:-}"
[ $# -eq 0 ] || shift

idof() { printf 'ag-%s' "$(printf '%s' "$1" | sha256sum | cut -c1-26)"; }
opt() { # opt <flag> <args...>: value after flag
  local f="$1" prev=""
  shift
  for a in "$@"; do
    if [ "$prev" = "$f" ]; then printf '%s' "$a"; return; fi
    prev="$a"
  done
}
name_of() { awk -v id="$1" '$1 == id { print $2 }' "$MAP"; }

case "$cmd" in
  ui)
    tabs="${FAKE_TABS:-1}"
    if [ "$tabs" = "0" ]; then
      echo "ui command $(wc -l <"$FAKE_LOG" | tr -d ' ') was recorded but no UI tab is connected: open /ui in the browser and run it again" >&2
      exit 3
    fi
    echo "sent ui command $(wc -l <"$FAKE_LOG" | tr -d ' ') to $tabs tab(s)"
    ;;
  spawn)
    name="$(opt --name "$@")"
    [ -n "$name" ] || { echo "fake: spawn needs --name" >&2; exit 2; }
    task="$(opt --task "$@")"
    id="$(idof "$name")"
    printf '%s %s\n' "$id" "$name" >>"$MAP"
    printf '%s' "$task" >"${FAKE_LOG}.task.$id"
    printf '### SPAWN %s %s\n%s\n### END SPAWN\n' "$name" "$id" "$task" >>"$FAKE_TASKS"
    echo "$id"
    ;;
  wait)
    id="${1:-}"
    name="$(name_of "$id")"
    [ -n "$name" ] || { echo "fake: unknown agent $id" >&2; exit 3; }
    left="$(cat "${FAKE_LOG}.wt.$id" 2>/dev/null || echo "${FAKE_WAIT_TIMEOUTS:-0}")"
    if [ "$left" -gt 0 ]; then
      echo $((left - 1)) >"${FAKE_LOG}.wt.$id"
      printf '{"done":false,"record":{"id":"%s","state":"running","exit":null,"result":null}}\n' "$id"
      exit 7
    fi
    state=exited exit_=succeeded summary=""
    case "$name" in
      wiki-reader-*)
        r="${name#wiki-reader-}"
        r0=$((r - 1))
        if [ "${FAKE_FAIL_ALL_READERS:-}" = "1" ] || [ "${FAKE_FAIL_READER:-}" = "$r" ]; then
          exit_=failed
        else
          summary="=== NOTES $r0 ===
REV: 1000001
Section $r0: canned fact $r0 (1204, 3 million).
NOT READ: none"
        fi
        ;;
      wiki-orchestrator)
        n="$(sed -n 's/^BLOCKS: //p' "${FAKE_LOG}.task.$id" | head -n 1)"
        for ((i = 1; i <= ${n:-4}; i++)); do
          summary+="=== BRIEF $i ===
canned brief $i
=== END BRIEF $i ===
"
        done
        ;;
      wiki-distiller) summary="published distillation.html" ;;
    esac
    node -e 'const [id, state, exit, summary] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ done: true, record: { id, state, exit, exitCode: exit === "succeeded" ? 0 : 1, result: summary ? { summary } : null } }) + "\n");' "$id" "$state" "$exit_" "$summary"
    ;;
  ps)
    n="$(sed -n 's/^BLOCKS: //p' "${FAKE_LOG}.task.$(opt --parent "$@")" 2>/dev/null | head -n 1)"
    out="["
    for ((i = 1; i <= ${n:-4}; i++)); do
      [ "$i" -eq 1 ] || out+=","
      out+="{\"id\":\"$(idof "wiki-summarizer-$i")\",\"name\":\"wiki-summarizer-$i\",\"state\":\"running\",\"exit\":null}"
    done
    echo "$out]"
    ;;
  report)
    if [ "${1:-}" = "list" ]; then
      echo "[{\"id\":\"$(printf 'report' | sha256sum | cut -c1-64)\",\"agent\":\"${2:-}\",\"name\":\"distillation.html\",\"mediaType\":\"text/html\",\"sizeBytes\":2048,\"createdAt\":0}]"
    fi
    ;;
  spend) echo "spent 0 of 2600000 micros (fake)" ;;
  tree) echo "fake tree" ;;
  cancel) echo "cancel requested" ;;
  *) echo "fake: unsupported command '$cmd'" >&2; exit 2 ;;
esac
