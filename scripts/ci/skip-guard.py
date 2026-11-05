#!/usr/bin/env python3
"""Skip guard for the Docker-gated CI groups.

Usage: scripts/ci/skip-guard.py --group <name> [--group <name> ...] <log>

Every test title that a named group requires (scripts/ci/docker-groups.json, `required`) must appear as a passing line in
<log>, the node:test output of that group's run; a skip, a failure or a missing line fails the guard. Deliberately NOT
required (they stay skipped): docker-pi (needs a live model key; no secrets in CI), pi-ext-live (needs the agent image and
POMTREED_PI_PROVIDER, which no CI group sets yet; it needs no key and makes no model call), and the
agent-net Docker Desktop (non-Linux) test. Matches both spec and TAP node:test output, with or without pnpm's "pkg test:"
prefix and ANSI colour, and matches the title exactly (`results` below), so a longer title that contains a required one does
not satisfy it. packages/e2e/src/ci-guard.test.ts checks that each name is a full test title defined in exactly one
test file of its group, so a renamed test fails test-lite instead of silently failing this guard.

A failing test that no group `required` list names is invisible here BY DESIGN: this guard counts only skips and required
titles. Such a failure still turns its job red through the test step's own exit code under `pipefail`, so a green guard alone
does not prove "no failures".

The log may also hold at most the group's `maxSkips` skipped tests (the by-design skips its `maxSkipsWhy` names), so a test
that newly skips fails the guard even when it is not required.

Exit 0 when every required test passed and the skips are within the limit, 1 otherwise, 2 on a usage error (unknown group,
unreadable log).
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Optional

MANIFEST = Path(__file__).resolve().parent / "docker-groups.json"
ANSI = re.compile(r"\x1b\[[0-9;]*m")
# What marks a result line and classifies it: the spec reporter's ✔/✖/﹣ or TAP's `ok N - ` / `not ok N - `. The lookbehind
# keeps the `not ok` of a TAP failure from being read as the `ok` of a pass when the prefix below swallows the `not `.
MARK = r"(?P<mark>✔|✖|﹣|not ok \d+ -|(?<!not )ok \d+ -)"
# What node:test may put after the title: the spec reporter's duration, then a `# ...` comment. Anchored at the end of the
# line, so a title's own parentheses are never mistaken for the duration.
TRAILER = r"(?: \(\d+(?:\.\d+)?ms\))?(?P<comment> #.*)?"
# A comment follows a title only as TAP's `# SKIP <why>` / `# TODO <why>`, or as the spec reporter's reason on a ﹣ line.
TAP_COMMENT = re.compile(r" # (?:SKIP|TODO)\b")
# What may precede the mark: pnpm prefixes each line of a workspace script's output with "<dir> <script>: ", and both reporters
# indent a subtest. Nothing else, so a stack frame, a diff line or another test's line that quotes the title is not a result.
PREFIX = r"(?:\S+ \S+: )?\s*"


def is_skip(line: str) -> bool:
    return "# SKIP" in line or "﹣" in line


def results(lines: list[str], name: str) -> list[tuple[str, str]]:
    """The log lines reporting the result of exactly the test `name`, each with the mark that classifies it.

    A result line is matched whole and the title exactly, not as a substring: a longer title that contains `name`, a stack
    frame or a diff line that quotes it, and a comment of some other test all report nothing about this one. Before
    2026-11-03 the match was a substring, so a passing `<name> and more` satisfied a `<name>` that never ran. What may
    surround the title is PREFIX and TRAILER above.
    """
    pattern = re.compile(rf"{PREFIX}{MARK} {re.escape(name)}{TRAILER}$")
    out = []
    for line in lines:
        hit = pattern.match(line.rstrip())
        if not hit:
            continue
        comment = hit.group("comment")
        # A ﹣ line carries the spec reporter's free-text skip reason; any other mark takes only TAP's `# SKIP`/`# TODO`, so
        # `✔ <name> # 2` is a different test's line, not this one's.
        if comment and hit.group("mark") != "﹣" and not TAP_COMMENT.match(comment):
            continue
        out.append((line, hit.group("mark")))
    return out


def verdict(hits: list[tuple[str, str]]) -> Optional[str]:
    """None when the test passed; otherwise why not, judged from its result lines (`results` above).

    "skipped": a skip marker. "failed": a ✖ (spec) or `not ok N -` (TAP) line. "absent (not reached)": no result line at
    all, as when the run timed out or crashed before the test reported (node:test prints failure details only at the end).
    """
    if any(is_skip(line) or mark == "﹣" for line, mark in hits):
        return "skipped"
    if any(mark == "✖" or mark.startswith("not ") for _, mark in hits):
        return "failed"
    if hits:
        return None
    return "absent (not reached)"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Fail unless every test a Docker group requires passed in its log.")
    parser.add_argument("--group", action="append", required=True, help="a group in scripts/ci/docker-groups.json (repeatable)")
    parser.add_argument("log", help="the node:test output of the group's run")
    args = parser.parse_args(argv)
    groups = json.loads(MANIFEST.read_text())["groups"]
    unknown = [g for g in args.group if g not in groups]
    if unknown:
        print(f"unknown group {', '.join(unknown)}; expected one of {', '.join(groups)}: fix the CI matrix or {MANIFEST.name}", file=sys.stderr)
        return 2
    try:
        lines = [ANSI.sub("", line) for line in open(args.log, errors="replace")]
    except OSError as e:
        print(f"cannot read the test log {args.log}: {e.strerror}; the test step did not write it, so no required test is proven to have run", file=sys.stderr)
        return 2
    bad = []
    for group in args.group:
        for name in groups[group]["required"]:
            cause = verdict(results(lines, name))
            if cause:
                bad.append(name)
                print(f"NOT RUN/PASSED ({group}): {name}: {cause}")
    skipped = [line.strip() for line in lines if is_skip(line)]
    limit = sum(groups[g]["maxSkips"] for g in args.group)
    print("total skipped lines in log:", len(skipped))
    if len(skipped) > limit:
        bad.append("maxSkips")
        print(
            f"TOO MANY SKIPS ({', '.join(args.group)}): {len(skipped)} skipped tests, more than maxSkips {limit} "
            f"({'; '.join(groups[g]['maxSkipsWhy'] for g in args.group)}): a test that used to run now skips; fix its gate, "
            f"or raise maxSkips and its maxSkipsWhy in {MANIFEST.name} if the skip is by design"
        )
        for line in skipped:
            print(f"  {line}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
