# Release validation record

How to read this page: each row in [Results](#results) says that one gate (named in [Gates](#gates)) ran at one commit on one host with the stated outcome; a commit counts as validated for a gate only if a `pass` row names that commit, or an earlier commit whose row still holds under rule 2 of [Rules](#rules). An empty table means no gate has been recorded yet.

This page is where release-gate results are recorded as they are run, one row per run. The gates are the checks that run against a real model provider, a real Pi, real Docker and a real machine, as opposed to the offline test suites that run on every commit. The live checks run on a single Linux machine with Docker, serially, on one provider and model (OpenRouter, model `anthropic/claude-haiku-5.5`; see [Model ids](#model-ids)), through the drivers in [scripts/live](../scripts/live/README.md), and each is paid for with a capped amount of real money measured in micros (millionths of a US dollar; 1,000,000 micros is $1, the unit of [economy.md](economy.md)). The zero-spend checks run on hosted CI and on a clean machine. Results are appended to the table below and are never edited.

## What the gates are for

The offline suites already cover deterministic logic. The custody state machine, the budget carve and settle arithmetic, fencing by generation and the boot refusals never consult a provider; they consult a number the provider supplied, so a fake (a test double in `packages/testing` that stands in for a port) exercises them exactly as well as the real thing and a live run would buy a bill and nothing else. Live runs are therefore spent only at the five seams where the fake is itself the assumption: the model provider's wire (what a real provider reports as cost, and in what shape), the real Pi harness, real Docker with the kernel and firewall, real crash and restart timing, and installing on a real machine.

Gates also differ in how far a pass travels. A host-validating gate tests one particular machine (INS-2's firewall half, and EGR-1's firewall, seccomp and uid-1000 half), so a pass is a statement about that host and transfers nowhere. A host-fragile gate has host-insensitive logic but only runs at all where the container-to-host path already works, so hosted CI is a legitimate place to run it.

## Gates

Gate ids are a prefix and a number: `INS` is install, `BUD` is budget, `CUS` is custody, `REC` is recovery, `YLD` is yield and `EGR` is egress. Each gate is described in one entry below. Other ids with these prefixes, such as YLD-4 and REC-8, and ids with other prefixes, such as SAF-5, name scenarios in the test suites: they are not release gates and have no row in the results table.

- **CI**: hosted CI is green at the commit. It runs format, lint, typecheck, the lite tests, the agent image build and the four Docker-gated groups on hosted runners, with no credentials. Driver: the workflow in `.github/workflows`; the evidence is the run URL.
- **INS-1**: a fresh clone installs and passes the lite gate on a machine with no prior checkout, following only the written install docs, and runs a zero-spend first agent. Driver: [GETTING_STARTED.md](../GETTING_STARTED.md) and [deploy/INSTALL.md](../deploy/INSTALL.md), by hand on a throwaway VM or container.
- **INS-2**: on Linux with a host firewall, containers reach the daemon (the `agent endpoint container probe ok` line in the daemon's startup log). A manual observation on the host being validated; see "Linux firewall" in [deploy/INSTALL.md](../deploy/INSTALL.md#linux-firewall).
- **INS-3**: a first live agent runs end to end through a proxy-issued per-task credential, the provider's reported cost is metered, and no credential leaks into the run directory (the key-leak greps). Driver: `scripts/live/ins3.sh`.
- **BUD-1**: nested budgets across three levels of agents, with a real budget refusal from the provider path bubbling up through each hop as an escalation. Driver: `scripts/live/harness.sh <rundir> bud1`.
- **BUD-2**: the micros pomtreed journals equal the provider's own bill for the same runs. This is a read, not a run, performed after the live runs against the provider's per-generation cost record; it has no driver and spends nothing.
- **CUS-1**: a parent killed mid-run does not lose its child's result; the exited child's result reaches the nearest live ancestor under real latency. Driver: `scripts/live/relay.sh ... cus1`.
- **REC-1**: after a `SIGKILL` of the daemon with a parent, two children and a solo agent running, the restarted daemon adopts them, fences old generations and settles each model call once. It is run three times because timing, not breadth, is the evidence. Driver: `scripts/live/harness.sh <rundir> rec1`.
- **YLD-1**: a live agent yields and resumes twice; the pre-yield token is rejected after resume, the checkpoint holds no host path and the spend ledger stays single. It is run twice. Driver: `scripts/live/harness.sh <rundir> yld1`.
- **EGR-1**: each egress kind (`none`, `registry`, `allowlist`, `audited-public`) confines a real container on this host. Driver: the Docker-gated suites of `@pomtree/sandbox-docker` and `@pomtree/e2e` with `PTREE_NET_TESTS=1`.
- **EGR-2**: a live browser digest under audited-public egress, with a real model: allowed hosts are reached, others are denied and audited. Needs the full agent image and the public web. Driver: `scripts/live/harness.sh <rundir> egr2`, after its zero-spend browser smoke test.

## Model ids

The ids used here are from the providers' own listings: OpenRouter lists [`anthropic/claude-haiku-5.5`](https://openrouter.ai/anthropic/claude-haiku-5.5) and DeepSeek lists [`deepseek-flash`](https://api-docs.deepseek.com/quick_start/pricing) (both retrieved 2026-11-04). `pomtree spawn --model` takes `provider/id`, split at the first slash, so the command-line forms are `openrouter/anthropic/claude-haiku-5.5` (as in `scripts/live/stack.sh`) and `deepseek/deepseek-flash`; templates carry the provider separately from the id.

## Host tokens

The Host column holds a token naming the machine a row ran on, so that a row is never credited from a different host. A token has the form `<os>+docker<version>+node<version>+pnpm<version>+git<version>+pi<version>`: the operating system and release (`uname -sr`), then the versions printed by `docker --version`, `node --version`, `pnpm --version`, `git --version` and the host `pi --version`. Hosted CI is written `ci:<runner label>` with the same version fields from its log. The same token string always means the same machine configuration; any version change makes a new token.

## Results

| Gate | Commit | Date (UTC) | Host | Outcome | Spend (micros) | Evidence |
| --- | --- | --- | --- | --- | --- | --- |

## Rules

1. A row validates exactly the commit in its Commit column, a short sha of a commit that is an ancestor of the commit containing the row.
2. A later commit keeps the row valid if and only if the paths it changed are all safe. Run `git diff --name-only <commit> HEAD`; every line must be under `docs/` (except `docs/configuration.md`, which is generated and tested against the code) or be a Markdown file in the repository root. Both commands below print nothing when the row is still valid:

   ```
   git diff --name-only <commit> HEAD | grep -Ev '^(docs/.*|[^/]+\.md)$'
   git diff --name-only <commit> HEAD | grep -x 'docs/configuration.md'
   ```

   The unsafe paths, each of which changes what was validated: `packages/agent-image`, `packages/sandbox-docker`, `packages/pomtree`, `packages/core`, `packages/harness-pi/src/agent-guide.md` (copied into the agent image), `tsconfig.base.json`, `package.json`, `pnpm-lock.yaml`, `.github/workflows`, `scripts/ci`, `scripts/live`, `packages/e2e/src/demo`, `packages/e2e/src/crash-recovery-live*` and `examples/hn-digest/content-live*`. Any other change also makes the row prior evidence: it still records what happened at its commit, but it does not validate the later one.

   `scripts/live/gate-series.sh` accepts an agent image labelled with an earlier commit only when nothing in its image-source set (`IMGSRC`) changed since; that set is narrower than the unsafe-path list because the unsafe list also includes run inputs (workflows, drivers, demos and lockfile) that change what a row validated without changing what the image is built from.

3. A rerun adds a row. Past rows are never edited, including to correct them; a correction is a new row that says what it supersedes.
4. INS-2 and EGR-1 are credited only from the host in their Host token. REC-1 passes are counted per (Gate, Commit, Host): three passes at one commit on one host, not three across hosts or commits.
5. Outcome is `pass`, `fail`, `blocked` or `skipped`, the last two with the reason in the same cell. Spend is micros from pomtreed's own accounting, `0` for gates that spend nothing. Evidence is the command that was run, its exit code and the run directory's name. The run directories themselves are not bundled with the repository, so a row's evidence can be audited only by someone who holds the directory.

Cumulative live spend: 0 micros. This is the only place the figure is stated; it is updated in the same change that adds a batch of rows. It is the live spend already recorded, and the value to pass as `--prior-micros` to `scripts/live/gate-series.sh`, which uses it to enforce its spend authorization.
