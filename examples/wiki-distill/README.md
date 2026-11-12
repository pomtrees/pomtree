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

## What is real and what is stubbed

All validation so far is offline. `templates.test.mts` loads the three templates through the real template loader, checks that their prompts equal `prompts/*.md`, that `budgets.env` agrees with the template budgets, that the reader prompt names only the one Wikipedia host and the distiller prompt carries the publish command, with negative controls showing each check can fail. It runs in `pnpm test:examples`.

`stub.test.mts` checks the rehearsal script `stub/wiki-distill.json` against the model stub's validator, that each role matches only its own rules, that the canned shell commands parse, and that each stub template equals its real twin in every field except the system prompt.

Unverified, because nothing has run live (tag `wiki-distill-live-validation`, marked in `templates.test.mts`): the editorial quality of the distillation, whether a small model follows the 24-step reader plan, and that the slice URLs return what the reader prompt expects and fit the interactive browser's result cap.

## Drive it

Open `/ui` in a browser, then run `examples/wiki-distill/drive.sh --title "<article>" --readers 4 --yes` with `POMTREED_STATE_DIR` set (`eval "$(scripts/pomtree-up <repo> --print-env)"`). Without `--yes` the script prints the plan, the cost ceiling and the pool and exits 2; `--dry-run` prints every command and calls nothing; `drive.sh --help` lists the flags and timeouts. The script spends real money unless the daemon runs the model stub. It never reads or prints the operator token. `WIKI_DISTILL_CLI` replaces the `pomtree` binary (the tests use it to run a fake CLI).

The UI sequence is: probe the UI with `pomtree ui reset` (exit 3 means no tab is connected, so open `/ui` and rerun); follow terminal and browser windows while the readers are spawned, then arrange them in a grid; close reader browser windows as the readers finish; spawn the orchestrator and follow its terminal and its summarizers'; spawn the distiller; and, when it publishes, open its report window. A missing window is never fatal, the driver only warns; open it yourself with `pomtree ui open terminal|browser <id>` or `pomtree ui open report <agent> <report>`. There is at most 16 tiles, and a narrow screen shows one window at a time. `pomtree ui` has no acknowledgement that a tab applied a command (the ui-command-ack tag in `packages/pomtreed/src/builtin/uiDrive.ts`).

The cost ceiling is N x `READER_MICROS` + `ORCHESTRATOR_MICROS` + `DISTILLER_MICROS` from `budgets.env` (2.5 USD for four readers at the shipped values), and the pool (`POMTREED_BUDGET_ROOT_MICROS` and `POMTREED_BUDGET_TOP_LEVEL_MICROS`, set to the same value) must cover it; `drive.sh` passes `--budget` on every spawn. A spawn refused with 409 `budget_exceeds_parent` means the pool is too small.

If a reader fails, its block becomes `NOT READ` and the run continues; if all fail the driver exits 1 with the cause. On failure it prints the commands to cancel the agents it spawned instead of cancelling them. A key is reusable only while its agent lives, so rerun with a new `--run-id`. Clean up with `pomtree cancel <id>`, `pomtree ui follow off`, `pomtree ui reset` and `pomtree report rm <distiller id> <report id>`.

## Rehearse for free

The rehearsal swaps the real model for the scripted model stub and costs nothing. It uses `stub/templates/*.json` (same ids as the real ones, so use one set per state directory) and `stub/wiki-distill.json`, one script that plays the reader, orchestrator, summarizer and distiller roles by marker and task token. Its readers fetch only `https://example.com/`, one audited public fetch and no spend; Wikipedia is never fetched. The `times` counters in the script are per stub process, so restart the stub between rehearsals.

Copy `stub/templates/*.json` into the templates folder, start the stub with `node packages/testing/bin/model-stub.ts --script examples/wiki-distill/stub/wiki-distill.json --port 0`, and point `scripts/pomtree-up` at the `baseUrl` it prints as in [Zero-spend first agent](../../docs/operating.md). The pool must cover the budgets and the daemon refuses to start unless `POMTREED_BUDGET_TOP_LEVEL_MICROS` is at most `POMTREED_BUDGET_ROOT_MICROS`, so set both to the same value (2600000 covers four readers).
