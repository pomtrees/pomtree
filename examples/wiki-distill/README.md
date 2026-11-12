# wiki-distill: distill a dense Wikipedia article with three templates

Nothing in this directory has been run live; read [What is real and what is stubbed](#what-is-real-and-what-is-stubbed) before you spend anything.

## What this is

Three spawn templates for a four-stage pipeline. Readers (browser agents) each read a different slice of one Wikipedia article and write plain-text notes. An orchestrator agent spawns one summarizer per block of notes and returns condensed briefs. A distiller agent turns the briefs into a few tasteful paragraphs and publishes them as a static HTML report. The aim is a thesis, ordering by importance rather than page order, concrete specifics, no filler, and the source URL cited. The prompts in `prompts/` carry those demands and `templates/*.json` embed the same text.

`drive.sh` spawns the readers and the distiller as root children with the plain `pomtree` CLI (the orchestrator spawns its own summarizers) and steers the web UI with `pomtree ui`; [Drive it](#drive-it) says how to run it.

## Install the templates

pomtreed reads templates from `templates.dir` (`POMTREED_TEMPLATES_DIR`, an absolute path; unset means `<state dir>/templates`, see [Configuration](../../docs/configuration.md)). Copy `templates/*.json` into that folder; the file stem is the template id. The stack needs `--provider openrouter`, `--model-base-url` and `--model-key-file` (see [First real-model agent](../../docs/operating.md)) and the model in `budgets.env`.

## Design choices you should know

- **Who spawns whom.** Agents cannot spawn templated children, so the readers and the distiller must be root children (their prompts and egress come from templates), and only the summarizers are children of the orchestrator.
- **Readers are browser agents.** A `web_fetch`-only agent has no handoff path, so its output could not feed the next stage. A browser reader ends with `capture_finish`, whose summary is its handoff.
- **Egress is audited, not confined.** Readers run with `audited-public` egress, which is not confined to Wikipedia hosts: only the reader prompt tells the agent to stay on `en.wikipedia.org`, and the audit log records every connection (tag `wiki-distill-fetch-reader`, marked in `templates.test.mts`).
- **Slicing.** Readers use the MediaWiki API on the one host: they fetch the section list, then read sections by index. Reader `r` of `N` takes the top-level sections (the lead counts as position 0) whose position modulo `N` is `r`, unless the task lists explicit section indexes.
- **Handoff text.** Stage outputs travel as handoff text, pasted into the next agent's task. Limits: reader notes 3500 bytes, each brief 1500 bytes.
- **Shell safety in the orchestrator.** It writes each summarizer's instructions and block to a file, spawns with the file's contents as the task, and each summarizer reports its brief from a file, so quotes or `$` in the article's text cannot break a command.
- **Budgets.** `budgets.env` holds the per-role `budgetMicros` the templates carry.
- **robots.txt.** The capture broker evaluates it; the browser capture path does not consult it today (`TODO(robots)` in `packages/agent-image/src/browser-capture.ts`), so the readers' pages are not robots-checked.

## What is real and what is stubbed

All validation so far is offline. `templates.test.mts` loads the three templates through the real template loader, checks that their prompts equal `prompts/*.md`, that `budgets.env` agrees with the template budgets, that the reader prompt names only the one Wikipedia host and the distiller prompt carries the publish command, with negative controls showing each check can fail. It runs in `pnpm test:examples`.

`stub.test.mts` checks the rehearsal script `stub/wiki-distill.json` against the model stub's validator, that each role matches only its own rules, that the canned shell commands parse, and that each stub template equals its real twin in every field except the system prompt.

Unverified, because nothing has run live (tag `wiki-distill-live-validation`, marked in `templates.test.mts`): the editorial quality of the distillation, whether a small model follows the 24-step reader plan, and that the slice URLs return what the reader prompt expects and fit the interactive browser's result cap.

## Drive it

Open `/ui` in a browser, then run `examples/wiki-distill/drive.sh --title "<article>" --readers 4 --yes` with `POMTREED_STATE_DIR` set (`eval "$(scripts/pomtree-up <repo> --print-env)"`). Without `--yes` the script prints the plan, the cost ceiling and the pool and exits 2; `--dry-run` prints every command and calls nothing; `drive.sh --help` lists the flags and timeouts. The script spends real money unless the daemon runs the model stub. It never reads or prints the operator token. `WIKI_DISTILL_CLI` replaces the `pomtree` binary (the tests use it to run a fake CLI).

The UI sequence is: probe the UI with `pomtree ui reset` (exit 3 means no tab is connected, so open `/ui` and rerun); follow terminal and browser windows while the readers are spawned, then arrange them in a grid; close reader browser windows as the readers finish; spawn the orchestrator and follow its terminal and its summarizers'; spawn the distiller; and, when it publishes, open its report window. A missing window is never fatal, the driver only warns; open it yourself with `pomtree ui open terminal|browser <id>` or `pomtree ui open report <agent> <report>`. There are at most 16 tiles, and a narrow screen shows one window at a time. `pomtree ui` has no acknowledgement that a tab applied a command (the ui-command-ack tag in `packages/pomtreed/src/builtin/uiDrive.ts`).

The cost ceiling is N x `READER_MICROS` + `ORCHESTRATOR_MICROS` + `DISTILLER_MICROS` from `budgets.env` (2.5 USD for four readers at the shipped values), and the pool (`POMTREED_BUDGET_ROOT_MICROS` and `POMTREED_BUDGET_TOP_LEVEL_MICROS`, set to the same value) must cover it; `drive.sh` passes `--budget` on every spawn. A spawn refused with 409 `budget_exceeds_parent` means the pool is too small.

If a reader fails, its block becomes `NOT READ` and the run continues; if all fail the driver exits 1 with the cause. On failure it prints the commands to cancel the agents it spawned instead of cancelling them. A key is reusable only while its agent lives, so rerun with a new `--run-id`. Clean up with `pomtree cancel <id>`, `pomtree ui follow off`, `pomtree ui reset` and `pomtree report rm <distiller id> <report id>`.

## Rehearse for free

The rehearsal swaps the real model for the scripted model stub and costs nothing. It uses `stub/templates/*.json` (same ids as the real ones, so use one set per state directory) and `stub/wiki-distill.json`, one script that plays the reader, orchestrator, summarizer and distiller roles by marker and task token. Its readers fetch only `https://example.com/`, one audited public fetch and no spend; Wikipedia is never fetched. The `times` counters in the script are per stub process, so restart the stub between rehearsals.

One command does all of this: `examples/wiki-distill/rehearse.sh` (flags `--target DIR`, `--port N`, `--keep`, `--no-wait`, `--open`) starts the stub and `scripts/pomtree-up` against a scratch directory with a dummy key file, prints the UI URL and the token file's path (never its contents), waits for you to open the UI (or opens it with `--open`, already signed in), runs `drive.sh --readers 4 --yes` against the stub, and stops what it started on Enter or Ctrl-C. It needs Docker, a built agent image (`POMTREED_AGENT_IMAGE`, else the newest local `pomtree/agent:*`; it never builds one) and node, uses no real key and unsets real-upstream settings for what it starts.

By hand: copy `stub/templates/*.json` into the templates folder, start the stub with `node packages/testing/bin/model-stub.ts --script examples/wiki-distill/stub/wiki-distill.json --port 0`, and point `scripts/pomtree-up` at the `baseUrl` it prints as in [Zero-spend first agent](../../docs/operating.md). The pool must cover the budgets and the daemon refuses to start unless `POMTREED_BUDGET_TOP_LEVEL_MICROS` is at most `POMTREED_BUDGET_ROOT_MICROS`, so set both to the same value (2600000 covers four readers).

## Real run, in order

The key file is created by you, mode 0600, as in [First real-model agent](../../docs/operating.md); no step below shows or passes a key. Use a fresh shell, or unset `POMTREED_PI_CATALOG_DIR`, if you rehearsed first (a real provider prices its own usage), and a different target repository or `--state` so the stub run's state is not reused. Copy `templates/*.json` (not the stub ones) into the state directory's `templates` folder first, as in [Install the templates](#install-the-templates).

```sh
POMTREED_BUDGET_ROOT_MICROS=2600000 POMTREED_BUDGET_TOP_LEVEL_MICROS=2600000 scripts/pomtree-up ~/target-real --init --provider openrouter --model-base-url https://openrouter.ai/api --model-key-file ~/.config/pomtreed/model.key
# open the printed /ui URL in a browser, then in a second terminal:
eval "$(scripts/pomtree-up ~/target-real --print-env)"
pomtree doctor
examples/wiki-distill/drive.sh --title "<article>" --readers 4 --oldid <revision, optional> --dry-run
examples/wiki-distill/drive.sh --title "<article>" --readers 4 --oldid <revision, optional> --yes
```

Before the first real run, set a spend limit on the OpenRouter key itself (in OpenRouter's key settings; recommended, not enforced by this repo), at or just above the pool. `--dry-run` prints every command and calls nothing. Without `--yes` the script prints the plan, ceiling and pool and exits 2.

## Cost ceiling

Per-role budgets come from `budgets.env`: 400000 micros (0.40 USD) per reader, 600000 (0.60 USD) for the orchestrator, from which its summarizers are carved at 60000 each, and 300000 (0.30 USD) for the distiller. With the formula and pool rule from [Drive it](#drive-it), the pool for each reader count N is:

| Readers N | Ceiling | Pool |
| --- | --- | --- |
| 2 | 1.70 USD | 1800000 |
| 3 | 2.10 USD | 2200000 |
| 4 | 2.50 USD | 2600000 |
| 5 | 2.90 USD | 3000000 |
| 6 | 3.30 USD | 3400000 |

An agent that runs out of budget parks behind a `budget_raise` approval, and nothing is spent unless you grant it; mechanics are in [economy](../../docs/economy.md). No run of this demo has been measured, so the ceiling is a cap, not a forecast.

## What needs your explicit go

- Spend, up to the ceiling above, on OpenRouter.
- A public fetch of the named Wikipedia article (and of `example.com` in the rehearsal).
- Sending the page text to OpenRouter as model input.

## Stop and clean up

Cancelling agents, turning UI follow off and removing the report are covered in [Drive it](#drive-it). Beyond that:

- Check what is left: `pomtree tree`, `pomtree spend`, and `pomtree reap <id>` for an exited child you still hold.
- Docker leftovers of a stopped daemon: `docker ps -a --filter name=pomtree-egress-proxy-` and `docker volume ls --filter name=pomtree-egress-socket-`; never remove a sidecar of a daemon that is still running (see [Operating](../../docs/operating.md)).
- Stop `scripts/pomtree-up` with Ctrl-C, and the model stub if you started it by hand. `rehearse.sh` stops what it started.

## Troubleshooting

- A spawn refused with "budget ... exceeds the ... the parent has left" (exit 5): the pool is too small; set `POMTREED_BUDGET_ROOT_MICROS` to the value the driver prints.
- Timeouts: a reader is waited for up to `READER_TIMEOUT_S` (default 720 seconds); the orchestrator and distiller have `ORCH_TIMEOUT_S` (900) and `DIST_TIMEOUT_S` (600). See `drive.sh --help`.
- A rehearsal that stalls or loops: restart the stub, whose `times` counters are per process.
- Browser windows and egress details for browser agents: [examples/browse-agent/README.md](../browse-agent/README.md).
