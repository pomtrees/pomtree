# Live validation drivers

Shell drivers behind the live runs recorded in [docs/validation.md](../../docs/validation.md), which also expands the gate ids used below (INS-3, BUD-1, CUS-1, REC-1, YLD-1, EGR-2, BUD-2). They drive a real model through `pomtree-up` or the e2e live harnesses, so every run spends money and needs Docker. Run them only deliberately, under the runbook below.

## Scripts

- `stack.sh`: sourced helpers (`stack_up`, `stack_down`, `stack_rm`, `snap`, and the count-only `leak_*` greps). Not run directly.
- `ins3.sh <rundir>`: first live agent through `pomtree-up` (INS-3) with the key-leak greps.
- `relay.sh <rundir> <k> <topBudget> <reserve> [cus1]`: the poem relay at depth k, where each level hands the poem to the next agent; with `cus1` the middle agent is killed while it holds (CUS-1).
- `verify-relay.mjs <rundir> <topBudget> <k>`: checks a relay run directory offline (level count, poem identity, reaps, carve and settle arithmetic, spend under the cap). Exits 4 when a check fails, so a caller can gate on it; `relay.sh` runs it itself and folds its status into its own exit code. `<k>` is required: without it the level count cannot be checked and a relay that never relayed would pass.
- `harness.sh <rundir> <kind>`: one e2e live harness with Docker snapshots and the leak grep. Kinds: `rec10` and `rec10k` (a single-agent `SIGKILL` recovery: adopting a running container, and a dead container), `rec1` (REC-1), `yld1` (YLD-1), `bud1` (BUD-1), `egr2smoke` (the no-spend browser smoke test with `PTREE_NET_TESTS=1`) and `egr2` (one live browser story with `POMTREED_WORKFLOW_FETCH_USER_AGENT` unset; it keeps each worker's `Chromium User-Agent` stderr line in `ua-lines.txt`). Both EGR-2 kinds need the full image.
- `gate-series.sh --out <root> [--prior-micros <N>] [flags] <item>...`: runs a chosen list of the drivers above back to back under the runbook's stop rules (below).
- `results-row.sh`: sourced helpers (`results_header`, `results_row`, `host_token`) that write results-table rows by the column names of the Results header in docs/validation.md. Not run directly.
- `rec1-poll.mjs <tmp dir>`: read-only side poller that `harness.sh rec1` runs; it prints the budget-stall escalation rows, approvals and unsettled debits of the harness's pomtreed database (ids and numbers only) to `rec1-poll.log`.

## Environment

- `POMTREED_MODEL_KEY_FILE` (required): path to the operator's key file. A driver-only variable read by these scripts, distinct from the daemon's `POMTREED_MODEL_UPSTREAM_KEY_FILE`; the scripts pass the path on to pomtreed as that daemon variable and use it only as a grep pattern file.
- `POMTREED_AGENT_IMAGE` (required): the agent image tag the run uses (build it first from the committed commit under test).
- `POMTREE_LIVE_TMP` (optional, default `/tmp`): parent of the short state root. `pomtree-up` relocates a socket path over 100 characters to `/tmp/pomtreed-<hash>/` and exports `POMTREE_SOCKET` for its readiness probe (`pomtree-up-sock`), so a long root also works; a short one keeps the socket inside the state dir, where `stack_rm` removes it.
- `POMTREE_LIVE_REPO` (optional): repo root to run `pomtree` and `pomtree-up` from; default is the checkout containing these scripts.
- `POMTREE_LIVE_MODEL` (optional): model for `ins3.sh` and `relay.sh`; default `openrouter/anthropic/claude-haiku-5.5`; the id forms and their source are in [docs/validation.md](../../docs/validation.md#model-ids).

## Order of use

1. Free reruns first (the lite gate and the Docker-gated suites); build the image.
2. `ins3.sh` (INS-3), then `harness.sh <rundir> rec10` and `rec10k`, then `yld1`, `bud1`, `rec1`.
3. `relay.sh` at k=1, 2, 3, then `relay.sh ... cus1`; check each with `verify-relay.mjs`.
4. Stop at the first failed stop rule in the runbook and report.

## Running a series

`gate-series.sh` runs the items you list, in order, serially, and nothing by default (no list, no run). It calls the drivers unchanged, reads each run directory, and enforces the runbook's spend rules. Its only Docker calls are read-only (`info`, `image inspect`, label listings); it never reads the key file (it checks its mode and counts blank lines).

```
scripts/live/gate-series.sh --out <root> --prior-micros <N> ins3 bud1 cus1 rec1 rec1 rec1 yld1 yld1 egr2
scripts/live/gate-series.sh --out <root> --resume [--grant <micros>] <the same items>
scripts/live/gate-series.sh --out <root> --prior-micros <N> --dry-run <items>    # prints the plan and each command; runs and writes nothing
```

Flags: `--out`, `--prior-micros`, `--resume`, `--grant`, `--stop-on-failure`, `--dry-run`. There is no manifest-file option: the items are listed on the command line.

Items: `ins3` (INS-3), `bud1`, `cus1` (the relay at k=2 with a dead middle), `rec1`, `yld1`, `egr2`; repeat one to repeat the run. BUD-2 (journaled cost against the provider's bill) is a read of a finished run, not a run, and has no driver; the script refuses it. `<root>` must not exist on a fresh start, and `--prior-micros` is the live spend before this series (required): use the cumulative figure at the bottom of [docs/validation.md](../../docs/validation.md). Each item gets `<root>/NN-<item>/` (a retry gets `NN-<item>-retry/`).

### Phases

1. Preflight, zero spend, each a refusal naming cause and action: Docker reachable; the agent image present with an `org.opencontainers.image.revision` label that matches the commit under test (or is an ancestor of it with no change to the image's source paths in between); `packages/agent-image` and `packages/sandbox-docker` clean; a host `pi` on `PATH`; the model environment variables unset in the invoking shell (`POMTREED_MODEL_BASE_URL`, `POMTREED_MODEL_UPSTREAM_KEY_FILE`, `POMTREED_PI_PROVIDER`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`; values are never shown); the key file a non-empty regular file, mode 600, with no blank line.
2. Smoke, zero spend, run once per series with an empty dummy key file so the real key is never loaded: every driver script parses (`bash -n`); every file a listed driver runs still exists at this commit (this catches a driver left stale while `packages/e2e` moved); and, when `egr2` is listed, the existing `egr2smoke` browser test runs through `harness.sh` and must leave nothing behind. It does not prove that a driver's flags, a paid path, the daemon's budget enforcement or the spend files' shapes are right at HEAD; a driver can pass the smoke and still fail its first paid run.
3. The items. After each one the script prints PASS or FAIL at once, and for a non-pass the run directory and the existing log files (`series-driver.log`, `run.log`, `pomtreed.log`) by absolute path, then a progress line. A summary of every attempt prints at the end, so a long unattended run can be read from the bottom.

### Three outcomes

- **An item fails**: the series carries on by default (a failed item costs at most its own ceiling). `--stop-on-failure` stops instead. A failure does not by itself change the exit code until the end, when the series exits 1.
- **A spend rule trips**: the series parks (PAUSED FOR SPEND, exit 3). It is not a failure and nothing is lost. It prints what was spent, the authorization, the rule, the next item with its ceiling and the smallest grant that lets it start. Resuming needs an explicit `--grant <micros>`.
- **A hard stop** (exit 4): a leak (a labelled container or volume left behind, a key-leak match, or a driver `STOP:` line), or spend or leak state that cannot be determined. A grant does not clear this; it needs investigation, because carrying on past unknown spend is how a cap is passed unnoticed.

Exit codes: 0 all pass, 1 finished with failures (or stopped by `--stop-on-failure`), 2 refused (preflight, smoke or arguments), 3 paused for spend, 4 hard stop.

### Spend rules

The authorization starts at the standing figure `SOFT` in `gate-series.sh` and grows only by `--grant`, which is recorded in the ledger and printed. No item starts if spent-so-far plus its ceiling would pass the authorization. A run that spends more than `STOP_SPEND` and is not clean also pauses (resume with `--grant 0` once you have reviewed it). One retry, only after exit 2 (the drivers' pre-start refusal) with spend under `STOP_SPEND`. `HARD` is the operator's overall total: a pause point too, not a wall; a grant that takes the authorization past it prints a note that the total is the operator's to raise. The script never infers, defaults or escalates a grant.

This mirrors the product: when an agent exhausts its budget pomtreed does not kill it; the model proxy refuses the call, an `ext.pomtreed.budget_escalated` row is written, a `budget_raise` approval is raised, and the agent parks until an operator runs `pomtree decide <approval> approve --grant`. The runner parks for a quota grant the same way instead of inventing a harsher policy for the harness.

Spend per kind: `ins3` and `cus1` read `spend.json`, `egr2` reads `digest/cost-ledger.json`: one whole-number field each, anything else is a hard stop. `bud1`, `rec1` and `yld1` have no parser; they are charged their ceiling (a safe over-count, shown as `<=N` in the row), so replace it with the real figure when recording the row. The per-item ceilings are in `item_info` in `gate-series.sh`. An exit 2 or 9 is a pre-start refusal and counts as 0.

Leak check: a container or volume carrying a `store_id` label (the owning daemon's label on sandboxes, egress sidecars and their socket volumes) whose id did not exist when the attempt started. Other Docker work is ignored if it is unlabelled or its daemon was already running. Known gap: a different daemon that starts during an attempt and still has containers at the end reads as a leak (a false stop, never a missed leak). Networks are not checked (the shared egress network outlives runs). Only one live stack can run per host: the proxy port is fixed and the egress network and container label are host-wide, so a concurrent stack makes the leak evidence unattributable. Run series serially.

### Progress and estimates

Resolution is per item: the drivers print nothing usable mid-run, so there is no within-item estimate. After each item the script shows items done, this session's elapsed time, spend against the authorization, and an estimated remaining time. The only basis is the measured durations of runs already completed in this series (kept in the ledger, so a resume keeps them): per kind where that kind has completed, otherwise the mean of all completed runs, and it says so. Before the first completed run it prints no estimate. The smoke's duration is not used (a free browser test does not predict a paid run).

### Resume

`<root>/series.tsv` is the ledger: one line per attempt (position, item, attempt, date, outcome, exit code, spend, final, seconds), plus `#grant` and `#pause` lines. Items marked final are skipped, so a resumed series never re-spends a finished item, and an item whose run directory already exists without a finished ledger line is refused rather than overwritten. Resume refuses a changed item list, an unreadable or undetermined spend, a missing ledger and a `--prior-micros` that differs from the ledger. A dry run writes nothing, so a dry and a real ledger cannot mix. A lock directory `<root>/.lock` stops two runs on one series; remove it only if no run is active (a killed script leaves it).

- After a pause: rerun with `--resume --grant <micros>` and the same items (and flags). Without a grant it refuses and restates the figures.
- After a stop on failure: fix the cause, rerun with `--resume` and the same items; finished items, including the failed one, are skipped. To rerun a failed item, start a new series for it with `--prior-micros` set to the cumulative figure.
- After a hard stop: read the run directory, clean up the leak or record the spend, then `--resume`.
- After a crash or a deliberate interruption (Ctrl-C) between items: `--resume`. During an item: that item's ledger line stays `pending`, and resume refuses until you read its run directory and edit the line: replace `pending` with `pass` or `fail` and both `?` fields (exit code and spend) with the figures and set the final column to `yes` (done) or `no` (rerun it in a retry directory). Never guess the figure.

Output in `<root>`: `rows.md` starts with the header and rule of the Results table in [docs/validation.md](../../docs/validation.md), read from that file at run time by `results-row.sh` (so the column order cannot drift from it), then has one row per attempt with every cell, Host included, placed by header name; paste the rows under that table by hand. The script never edits `docs/validation.md`. A row's outcome is `pass`, `blocked` (pre-start refusal) or `fail`; check a `fail` row before pasting.

## Runbook: live runs

This section is the single source for how a live run is operated. It holds the mechanism; the figures are constants in `gate-series.sh` and are not restated here.

### Caps and ceilings

The standing authorization is `SOFT`, the operator's overall total is `HARD` (a warning, not a wall) and the over-spend review threshold is `STOP_SPEND`; the ceiling charged to each item is set per item in `item_info`. All are at the top of `gate-series.sh`. Raising any is an edit to that script, made deliberately and in its own change. A digest run through `examples/hn-digest/content-live.mts` has its own caps: the default model budget is 200,000 micros per story, and a `--budget-micros` above `LIVE_BUDGET_CEILING_MICROS` (in `content-live-runtime.mts`) is refused unless `--i-know-the-cap` is given. Its deadline defaults to 10 minutes, plus 4 minutes per story for the browser article method; `--deadline-ms` overrides it. Its operator guide is [CONTENT.md](../../examples/hn-digest/CONTENT.md).

### Pause and ask

A spend limit is a pause to give further quota, not a termination. Reaching the authorization parks the series in a resumable state (exit 3) and asks for a grant; nothing spends beyond the currently authorized figure without an explicit `--grant <micros>`. At every pause the operator needs four figures before deciding: what the run that paused spent, the cumulative live spend of the series, the authorization remaining against `HARD`, and the amount being asked for. Silence is not a grant, and an unspent remainder is not one either.

### Retry and hard stop

One retry only, and only after a pre-start refusal or an environmental failure that spent under `STOP_SPEND`. A run that spends over `STOP_SPEND` and is not clean pauses the series and reports instead of retrying. One case stays a hard stop and is not softened into a pause: being unable to determine spend, or to establish a run's leak and leftover state (an unreadable settlement, a missing journal row, a failed `docker ps`, volume or network snapshot, or any other gap that leaves the figures unknown). It ends the series with no resume until the cause is understood, because continuing on unknown spend is how a cap is passed unnoticed.

### Run protocol

- Run from a checkout at the committed commit under test, with an image built from that same commit.
- Capture the exit code without a pipe: `cmd > log 2>&1; echo $? > exit_code`. A pipe into `tee` hides the command's status (under zsh read `${pipestatus[1]}` if a pipe is unavoidable).
- Snapshot `docker ps`, volumes and networks before and after the run. The drivers do this; do it by hand for anything else.
- Report the spend (from pomtreed's own accounting, in micros) and every check that ran, and add the row to [docs/validation.md](../../docs/validation.md).
- Remove the images built for a run afterwards; they are local.
- An agent or script that runs a live driver passes a temporary `--state-dir` for digest runs (an existing empty directory), so a run never touches `~/.pomtreed`.

### Key file

The key file holds only the upstream provider key. It is owned by the operator, mode 0600, with no blank lines. It is never printed, echoed, logged, traced or written elsewhere, and agents never read it: drivers read it in-process through the path in `POMTREED_MODEL_KEY_FILE` and hand pomtreed the same path as `POMTREED_MODEL_UPSTREAM_KEY_FILE` (the digest entry reads `POMTREED_MODEL_UPSTREAM_KEY_FILE` with `POMTREED_PI_PROVIDER` and `POMTREED_MODEL_BASE_URL` set, and holds the key in memory). Do not pass `--show-token` or `--open` to `pomtree-up`: the login link carries the operator token and would land in logs.

### Credential wrapper

The key file is created by a credential wrapper that the operator supplies; the repository does not include one. A wrapper must meet this contract: read the key from the operator's credential store, write it to a new file with mode 0600 (created with that mode, not chmodded afterwards), print nothing about the key, and export only the file's path as `POMTREED_MODEL_KEY_FILE` before running the command it wraps, which reads the file in-process and passes the path on. It never echoes the key to the terminal, a log, the process list or the environment, and the file's lifetime stays under the operator's control.

### Image build and launch

1. Preconditions: Docker reachable, a host `pi` on `PATH` and the model environment variables unset in the invoking shell (the series preflight checks all three).
2. Build the image from the committed commit: `AGENT_IMAGE_TAG=<tag> pnpm --filter @pomtree/agent-image build:image:demo` for the slim target, `build:image` for the full one. The full target clones pi-browser at a pinned revision during the build and is needed only for EGR-2. Set `POMTREED_AGENT_IMAGE` to the tag. `scripts/pomtree-up --no-build` uses that image, dies if it is missing, and only warns when its revision label differs from HEAD.
3. Launch: `POMTREED_BUDGET_TOP_LEVEL_MICROS=150000 POMTREED_BUDGET_DEFAULT_MICROS=60000 scripts/pomtree-up --no-build --state <temp dir> --provider openrouter --model-base-url https://openrouter.ai/api --model-key-file <0600 key file>`. The base URL for an Anthropic-messages model on OpenRouter is `https://openrouter.ai/api`, never ending in `/v1`, because the request path `/v1/messages` is appended to it; OpenAI-compatible models use the provider's `/v1` endpoint. `pomtree-up` neither sets nor clears the budget variables, so pomtreed inherits them.
4. Pass an explicit `--budget` on every `pomtree spawn`. The configured defaults (`budget.topLevelMicros`, `budget.rootMicros`, see [configuration](../../docs/configuration.md)) are far above a live-run cap, and the demo scripts default their root budget well above it too, so override both.
5. The host Pi catalog can differ from the Pi pinned in `packages/agent-image/scripts/build.ts`. Confirm the live catalog's price for the model at boot: pomtreed prices settlement from the host binary's catalog, while the agent runs the pinned in-container Pi.

Gated Docker suites need an image built from a committed tree: build as above, then set `PTREE_DOCKER_TESTS=1`, `PTREE_AGENT_TEST_IMAGE=<tag>` (read by the sandbox-docker gate), `PTREE_E2E_IMAGE=<tag>` (read by the e2e suites) and `PTREE_AGENT_TEST_REVISION=<short sha>`. The gate rejects dirty `packages/agent-image` and `packages/sandbox-docker` trees; test uncommitted work from a throwaway clone. `PTREE_NET_TESTS=1` enables the public-web tests. Run the digest browser smoke test (`examples/hn-digest/content-live-browser-smoke.test.mts`) before a live browser run on a new commit.

## Secrets rule

Never print, echo or trace the key. The scripts grep with the key file as the pattern using only `-c`, `-l` and `-q`, send grep stderr to an unquoted log (`$R/grep.err`), and never enable `set -x`. Keep any edit within that rule. Run directories hold only counts and file names, but treat them as untrusted until the leak grep over the run directory reports 0.

## Results

Each run's outcome and spend (from pomtreed's own accounting, in micros) go to a new row in [docs/validation.md](../../docs/validation.md); rows are appended, never edited.
