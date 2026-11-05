# Pomtree

Pomtree is a framework for running trees of coding agents on one machine. A daemon, `pomtreed`, runs each agent in a Docker container and treats it like an operating-system process: a parent can spawn children, wait on them, and must collect ("reap") each child's result before it can report success itself. A child's failure arrives at its parent as an event rather than a poll. Agents are driven by the [Pi](https://github.com/earendil-works/pi) coding-agent CLI, which runs interactively inside the container and reports progress through an event side-channel (see `SPEC.md`, "Pi as an interactive harness").

The project borrows Pi's shape and applies it to orchestration: a small, opinionated core with extension points. The core handles a short list of hard safety problems itself, and it refuses to start until the operator has made the safety choices that depend on their trust model; the set is listed in [`docs/safety-decisions.md`](docs/safety-decisions.md). Users bring their own workflows, agent templates, messaging adapters and, later, dashboards; the sandbox, harness and store backends are fixed ([`docs/extending.md`](docs/extending.md)). It does not try to cover every orchestration need. It is for supervised use only; the one statement of that limit is in [`docs/safety-decisions.md`](docs/safety-decisions.md#supervised-use-only).

The repository is a TypeScript pnpm monorepo that runs directly from source: no build step, tests on `node:test`. [`SPEC.md`](SPEC.md) is the design of record; this file says why the project exists, what the code does, and how to start.

## The problem

Fleets of agents left to run unsupervised fail in four recurring ways ([`docs/prior-art.md`](docs/prior-art.md#1-the-problem-space), section 1). Spend runs away, because a looping agent or a fan-out of children has no ceiling smaller than the provider account's. Authority leaks, because children inherit the parent's credentials, network and files. Work is orphaned or lost: a parent exits while its children run, or a child finishes and nobody is left to receive its result. State is lost or corrupted, because a replacement for a presumed-dead agent runs while the original is still writing, or because a working tree changes with no checkpoint to return to.

These failures cut across layers. A durable workflow engine addresses lost state but not spend; a hosted agent platform addresses spend but not authority between sibling agents. Because the guarantees must hold across crashes, restarts and replacements, the project's argument (an inference, not a measurement) is that they are hard to add later to a system whose core does not own them.

## Prior art

[`docs/prior-art.md`](docs/prior-art.md) compares the existing families dimension by dimension, with sources, access dates and the qualifications omitted here. In one sentence each:

- **Durable-execution engines** (Temporal, Restate) cover lifecycles and cancellation, not spend, credentials or sandboxing.
- **Agent frameworks** (LangGraph, OpenAI Agents SDK) persist one agent loop's state in-process.
- **Claude Managed Agents**, the closest comparable, caps spend per session, shared by all its threads along with one sandbox and one set of credentials.
- **Agent-in-container and worktree tools** isolate each agent and leave spend and results to the user (secondary report, not re-verified).

Among the systems read from primary pages, none combines tree custody, nested dollar caps and sandboxed git checkpoints. For one agent, or one shared cap per session, Managed Agents or a framework is the simpler choice.

## Rationale

The thesis is that an agent should be managed like an operating-system process, whose `wait`, zombie (a finished process whose result nobody has collected) and orphan rules are well understood. In that model parenthood is custody: a parent that starts a child is answerable for it until it has collected the child's result. Every agent has exactly one parent, and a permanent root supervisor inside the daemon (reserved id `root`) parents everything started by an operator or a schedule, so no agent is ever parentless. None of the systems surveyed in `docs/prior-art.md` documents a parent that holds each child's result until it collects it.

What the code delivers on that thesis:

- **Results held for a live owner, in part.** A parent cannot report success while it has unreaped children. A finished child of a live non-root parent stays `exited`, unreaped, until that parent reaps it. A child of the root supervisor is reaped when it exits; its record is kept and its clipped handoff goes to the operator. Reaping keeps the record: it ends the hold, the budget claim and the parent's obligation to collect. When a parent dies, its exited, unreaped descendants are held for the nearest live ancestor (the operator, for the root) and never auto-reaped; the custodian is told once and can read and reap them. A parent can instead declare a disposition for a child's result (`pomtree spawn --disposition hold|reap-on-exit`, and `--ttl DURATION` to reap a held result after a time). Known gap: a parent cannot yet discard a child's unmerged work as a declared outcome.
- **Nested budgets enforced at the model proxy.** A child's budget is carved from its parent's and the unused part returns at reap. Each model call reserves money first, and the reservation is admitted only if it fits every ancestor's remainder ([`docs/economy.md`](docs/economy.md)). Money is integer micro-dollars throughout (`$1` is `1_000_000`).
- **Per-task credentials.** Agents never hold provider keys. Each agent gets its own scoped, expiring credential for the model proxy, and the upstream key stays behind the proxy.
- **Fencing by generation.** Every record carries a generation number, which identifies an agent's current incarnation and acts as a fencing token. Resuming an agent bumps it, so a still-running old container's writes are rejected.
- **Git custody.** Each agent works in a private clone; committed work comes back only as a git bundle checked in a throwaway quarantine repository, and the daemon is the only writer of any branch but the agent's own, merging without a checkout. This keeps one agent's mistakes off another's branch; it is not isolation from a hostile agent. Git handling assumes the agents are trusted, and what would have to hold before untrusted agents could run is in [`SPEC.md`](SPEC.md) ("Isolation, git, and credentials").

The other half of the thesis is that safety choices which depend on the operator's trust model should be made by the operator, not guessed by the framework. pomtreed refuses to start on a defined set of unsafe silent defaults (for example an unset egress proxy image or extension approval, or a chat channel with no sender allowlist), prints every violation at once, and creates no state. [`docs/safety-decisions.md`](docs/safety-decisions.md) is the checkable list: the invariants the framework owns, the decisions it forces, and the gap list of choices it still makes silently.

## What it does

### The process model

An agent is `pending`, `running`, `yielded` (suspended at a checkpoint), `exited`, or `reaped`.

```
pending ──► running ◄──► yielded
               │            │
               ▼            ▼
            exited ──────► reaped
```

`pomtree result` durably records the result and immediately sends the parent a `child_result` signal with its status and clipped handoff. The child remains running until its turn settles or its wrap-up window expires (the default is set in `packages/pomtreed/src/daemon/lifecycle.ts`; `pomtree spawn --wrapup DURATION` or API `wrapupMs`). Only after it stops does the parent receive `child_exited`; reaping before then returns "reported but not yet exited". Finish cleanup, commit and `pomtree push` to the local daemon before reporting. If uncommitted work remains, reporting pauses for approval: retry with `pomtree result --save-uncommitted TOKEN` to approve saving that snapshot as a commit and collecting it into the local daemon. A failed save blocks the report; approval does not publish to an upstream remote. The warning supplies the snapshot token (API: `saveUncommitted`); changing the files requires fresh approval.

Four lifecycle rules follow: reaping is mandatory for children of a non-root parent (an exited, unreaped one raises an alert and is held for its parent or, if that is gone, its custodian; the root's children are reaped at exit), failure is pushed rather than polled, orphans are cancelled by default (a grace period, then a kill; see Lifecycle rule 4 in [`SPEC.md`](SPEC.md#rules)), and budgets nest. A further set of design rules (stable opaque ids, a host id and generation on every record, `pomtree` talking only to the daemon API, idempotency keys on every mutating call, checkpoints holding ids and hashes rather than paths, no durable state in daemon memory) is cheap on one machine and keeps a multi-host version possible; they are listed with their rationale in `SPEC.md`.

### Ports and where the daemon sits

Everything durable (which agents exist, what they did, what they wait for) sits behind narrow interfaces called *ports*, defined in `packages/core/src/ports.ts`. The daemon is written only against those interfaces, and the concrete pieces (SQLite, Docker, Git, Pi, a report directory) live in separate packages.

```
   operator / agent in a sandbox ──► pomtree (CLI) ──► pomtreed (daemon: pure handlers over a Daemon)
                                                       │ ports (packages/core)
        Journal Registry Mailbox Checkpoints Sessions · Sandbox Workspace Harness · ModelGateway
        Orchestrator Placement · Reports Escalations Schedules Watchdogs Templates · ExtensionGateway
                                                       │ adapters
        store-sqlite · sandbox-docker · workspace-git · harness-pi · report-dir · template-dir · sched
```

`pomtreed` imports its adapters directly in `packages/pomtreed/src/main.ts`, so replacing one today means forking that file. On top sit cron schedules, static reports that agents publish, human questions through a messaging adapter, an operator web UI, and an extension host. Which ports are hardwired, and where an implementation leaks past its port, is in [`docs/extending.md`](docs/extending.md#3-interfaces-that-exist-but-are-hardwired).

### Closed by default

A stock install closes several doors until the operator opens them: pomtreed refuses to start with the operator UI, host or agent listener on a non-loopback address unless that is explicitly allowed (the agent listener may also be the loopback or docker bridge gateway address), chat-initiated spawns are off, no workflow can launch until its extension is listed as reviewed and granted templates, a template loaded from the template directory with no egress setting gets no outbound network access, and pomtreed refuses to start without a model upstream key file, a pinned egress proxy image, an explicit egress for spawns that name no template, and an explicit extension approval setting. The full list, and the defaults that are still silent (for example fetch pacing, journal retention and session bounds), is in [`docs/safety-decisions.md`](docs/safety-decisions.md).

### Extending it

Agent templates, reviewed in-process workflows (`examples/hn-digest`), file-loaded extensions and out-of-process messaging adapters work today without editing the repository. Two messaging adapters exist (`messaging-discord` and the terminal adapter `messaging-stdio`), and both pass the same wire-contract suite (`messagingWireSuite` in `@pomtree/testing`); adding the second needed no change to core or pomtreed. Extension code runs in the daemon process, so it is trusted, not isolated; the sandbox, harness, stores, orchestrator and UI panes are not yet pluggable. [`docs/extending.md`](docs/extending.md) is the inventory of what works, what is hardwired and what is only proposed.

### Limits

It is for supervised use only: it is not fit for unattended operation, nor for untrusted input or agents you consider hostile. Nothing in the code enforces that limit; the one statement of it, with the gates meant to lift it, is [`docs/safety-decisions.md`](docs/safety-decisions.md#supervised-use-only). It is single-host: placement is local, and only Pi runs as a harness. It is not a PR or CI workflow: output is branches an agent sends with `pomtree push`; parents merge children's branches into their own through the controller (`pomtree merge`), and you fetch results with `pomtree pull` and push them to your remote yourself, or through the pinned, approval-gated `publish` route. It is not a full permission system: approvals follow a fixed authority chain (`packages/core/src/approval.ts`). Known gap: the Discord messaging adapter runs out of process and has never been verified against live Discord. The agent path has been run against OpenRouter and DeepSeek; results for a release commit are recorded in [`docs/validation.md`](docs/validation.md). Other providers have not been run. Known gaps are tracked as [GitHub issues](https://github.com/pomtrees/pomtree/issues), labelled when filed.

## Getting started

[`GETTING_STARTED.md`](GETTING_STARTED.md) takes a bare machine of any OS through prerequisites (Node.js, git, pnpm, Docker with buildx; the versions are pinned in `package.json` and the agent image build), clone, install, the safety decisions, the Linux firewall step, building the agent image and starting the daemon. It is generated from one source that `pomtreed preflight` and `pomtreed init` also use, and a coding assistant can drive it with the `pomtree-onboarding` skill in `.agents/skills/pomtree-onboarding` (`.claude/skills/pomtree-onboarding` is a symlink to it).

On a machine with the prerequisites installed:

```sh
git clone https://github.com/pomtrees/pomtree.git && cd pomtree
pnpm install
pnpm check:lite; echo "check:lite rc=$?"   # format, lint, typecheck and tests (Docker-gated tests skipped); rc=0 means the checkout works
```

The primary first run is [GETTING_STARTED.md](GETTING_STARTED.md) through its Docker and image steps (up to [step 8, build the agent image](GETTING_STARTED.md#8-build-the-agent-image)), then [Try it locally](docs/operating.md#try-it-locally), which starts a first agent on a scripted fake model (no key, no money) and then a first agent on a real model with a spend cap. `scripts/pomtree-up`, the launcher that "Try it locally" uses, is a development launcher: it picks the forced safety decisions without asking, so it does not demonstrate the refusal to start described above. GETTING_STARTED's later steps (`pomtreed init`, a daemon started by hand) are the full operator path, and running pomtreed as a long-lived service is in [`deploy/INSTALL.md`](deploy/INSTALL.md). The `pomtree` commands are grouped in [`docs/operating.md`](docs/operating.md#commands-in-depth); `pomtree --help` is the authoritative list. A one-command scripted demo is future work.

## Docs

- [`SPEC.md`](SPEC.md): the design, including the lifecycle and design rules.
- [`GETTING_STARTED.md`](GETTING_STARTED.md): prerequisites, install, the firewall step and a first daemon.
- [`docs/operating.md`](docs/operating.md): the commands, waiting and interrupts, operations, and trying it locally.
- [`docs/configuration.md`](docs/configuration.md): configuration precedence, naming and secrets, and the generated parameter reference.
- [`docs/state.md`](docs/state.md): what pomtreed persists and where.
- [`docs/extending.md`](docs/extending.md): which extension points work today, which are hardwired, and which are proposed.
- [`docs/safety-decisions.md`](docs/safety-decisions.md): the invariants, the forced decisions, the silent-default gap list, and the supervised-use limit.
- [`docs/economy.md`](docs/economy.md): budgets, reservations, pricing and escalation.
- [`docs/tasks.md`](docs/tasks.md): tasks and the message path.
- [`docs/prior-art.md`](docs/prior-art.md): what existing systems cover, with sources, and what none combine.
- [`docs/faq.md`](docs/faq.md): short answers, with links, to questions operators and extension authors ask first.
- [`docs/demo.md`](docs/demo.md): scripted demos and the slim demo image.
- [`scripts/live/README.md`](scripts/live/README.md): the live-run drivers behind the release gates.
- [`docs/validation.md`](docs/validation.md): the release gates, with results recorded as they are run.
- [`deploy/INSTALL.md`](deploy/INSTALL.md): installing pomtreed as a service, backup and upgrade.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md).

## Repository layout

Each directory under `packages/` is one workspace package named `@pomtree/<directory>`. `scripts/pomtree-up` (a local launcher) and `deploy/` (a launchd plist, a systemd unit and install notes for `pomtreed`) sit beside them.

| Package | Role |
| --- | --- |
| `core` | Port contracts (including repo and merge ports), domain types, lifecycle rules, extension contract, and spawn templates |
| `pomtreed` | The daemon, HTTP API, extension host, operator UI |
| `pomtree` | The command-line client |
| `store-sqlite` | Journal, registry, mailbox, checkpoints, sessions, escalations, schedules, watchdog state on `node:sqlite` |
| `workspace-git` | Bare mirror and private full clones, quarantined bundle ingest, the merge engine (merge into a branch without a checkout), and publish |
| `sandbox-docker` | The Docker CLI sandbox adapter, with egress enforcement |
| `harness-pi` | The Pi harness adapter and the in-sandbox guide |
| `agent-image` | The agent container image (with an entrypoint that sets the agent's git identity), environment-manifest logic, and mount specs |
| `sched` | Cron, watchdog, and admission logic (pure) |
| `observe` | Spans, agent tree, live view, OTLP exporter, UI panes |
| `report-dir`, `template-dir` | Report and template store adapters |
| `messaging-discord` | Host adapter for human messaging over Discord |
| `messaging-stdio` | Terminal adapter for human messaging, the minimal reference adapter |
| `testing` | One scripted, call-recording fake per port, shared by every test suite |
| `e2e` | Cross-adapter tests |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for what is valued in a change, the checks and the pull-request process. AI coding agents working in the repository also read [`CLAUDE.md`](CLAUDE.md), which points back to it.

## License

Licensed under the Apache License 2.0; see [`LICENSE`](LICENSE).
