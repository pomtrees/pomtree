# Pomtree: Single-Node Design

Oct 4, 2026 · The pomtree Authors

This is the design of record. Other docs may say "task" for the general contract and the non-container kind; this spec, identifiers, routes, and types say "agent" (see [`docs/tasks.md`](docs/tasks.md), decision "Vocabulary first").

## Summary

One daemon, `pomtreed`, runs agents as Docker containers and keeps every durable fact (who exists, what they did, what they are waiting for) behind narrow interfaces, called ports, that can later point at shared storage. Everything else is bought, not built: our own code is `pomtreed`, the `pomtree` command-line tool, and the ports.

The stack is Docker sandboxes, Pi (pinned in the image) as the agent harness, Git for source state, SQLite for the registry, journal, and mailboxes, and a model gateway that enforces per-agent budgets. An in-process orchestrator runs the lifecycles. Traces use OpenTelemetry.

pomtree is a pluggable framework in the spirit of Pi: a small core that handles the hard safety problems out of the box (custody of results, nested budgets enforced at the model proxy, per-task credentials, fencing) and forces explicit safety decisions, while workflows, agent templates, dashboards, and adapters are brought by the user. "Pluggable" names the seams (the ports). Templates, workflows, extensions, and messaging adapters plug in through public contracts, the last checked by a shared wire-contract suite (`messagingWireSuite` in `@pomtree/testing`). Sandbox, harness, and store backends are chosen in `packages/pomtreed/src/main.ts`, not by configuration, and [docs/extending.md](docs/extending.md) inventories which seams are open. The daemon forces explicit safety decisions: it refuses to start on a defined set of unsafe silent defaults, listed in [docs/safety-decisions.md](docs/safety-decisions.md), which also lists the defaults that remain silent.

Agents are treated like operating-system processes: a parent spawns children, waits on them, and must reap each one, meaning collect its result, before it can finish.

## Design rules that keep distribution open

Each rule is cheap on one machine and expensive to retrofit.

1. **Address everything by stable id.** Agents, sessions, checkpoints, and sandboxes get opaque ids; nothing is referred to by host name or file path.
2. **Stamp every record with a host id and a generation number.** The generation is a fencing token: an agent resumed elsewhere leaves the old instance with a stale generation, and its writes are rejected.
3. **`pomtree` talks only to the daemon's API,** a Unix socket on one machine and the same API over an authenticated network later. It never opens the database or files itself.
4. **Every mutating operation is idempotent.** Each call carries a key, since retries and duplicate delivery are certain. The API refuses a mutating call without one with a 400 that names the field; `pomtree` and the agent tools generate one per invocation, so a user never has to.
5. **Checkpoints are host-independent.** They are written through the checkpoint port, hold only ids and hashes, and never contain local paths. A workspace is named by an opaque id plus node id. Across a host loss the guarantee holds only through the last ingested commit; unpushed work on a dead host is lost.
6. **No state in daemon memory.** `pomtreed` can be killed and restarted at any time and rebuilds from the stores. Known gap: the live session-handle map, the admission waiters, the inbound receipt cache and the provider circuit breaker are held in daemon memory (the provider attempt count is store-backed). Viewer-only memory is exempt: `TerminalHub`'s session map and the browser hub's latest frame are caches of what a stream last showed, the stream mutates nothing, and losing them only drops or blanks a viewer.
7. **Test the distributed paths on one machine.** Run two nodes with different host ids under one controller and force resumes across them.
8. **Fail closed.** When a gate, credential, policy, or store cannot be evaluated, the answer is deny or stop admitting, never allow.
9. **Policy lives in one place.** Platform-specific code realizes behavior; it never becomes a second source of policy.

These rules are inferences from how distributed systems usually fail.

## Distribution

Future work: multi-host operation is designed but not built, and the single-host daemon is the supported shape. More hosts would be added as one controller plus per-host nodes. `pomtreed` stays the only writer of the registry, journal, checkpoints, and trusted state. A thin `pomtreed-node` per host runs containers through the Docker adapter and dials out to the controller; agents reach only a relay on their own node. A single-host install runs the node in-process (`local-node.ts`). Shared storage is assumed no stronger than NFS, so no worktree, SQLite file, or git state is shared across hosts.

Liveness is judged from one heartbeat interval H. A silent node pauses its containers (`docker pause`) before the controller may declare it lost and replace its agents, with a margin of at least 2H checked at configuration load; past a long limit it kills them. A stale instance therefore meets its successor only at the API, where the generation fence rejects it. The fence is checked by whoever accepts a write, never by a clock, since a paused container resumes with a jumped one.

## Dependencies chosen

| Need | Choice | Alternatives considered | Main caveat |
| --- | --- | --- | --- |
| Sandboxes | Docker, hardened (see Isolation) | microVMs (Firecracker, microsandbox, Kata), gVisor | Containers share the host kernel. |
| Agent harness | Pi, version pinned in the image | Claude Code, Codex | Young and fast-moving; no built-in sandbox or approvals. |
| Durable control flow | In-process orchestrator over SQLite | Temporal, DBOS, Inngest | Temporal's server is MIT-licensed and has native Schedules. Not the default: it needs a SQL database, several services and a worker, and its close policies and retention do not hold a result until the owner acknowledges it. Reopen if a durable external orchestrator adapter is wanted or its agent integrations cover the custody and budget rules here. Detail and sources: [docs/prior-art.md](docs/prior-art.md). |
| Registry, journal, mailboxes | SQLite (`node:sqlite`) | Postgres, NATS JetStream | One writer at a time; high availability is the trigger for replacing it. |
| Source state | Git, one branch per agent | | Suits text; build outputs use hash-keyed caches. |
| Model access and budgets | Gateway port: in-house key-issuing proxy; LiteLLM-style later | LiteLLM, Bifrost | LiteLLM needs Postgres. |
| Traces | OpenTelemetry GenAI spans, small hand-rolled OTLP exporter | Phoenix, Langfuse, Jaeger | GenAI conventions are still experimental. |
| Language | TypeScript on Node 24, no build step, `node:test` | Go, Rust | Pi suits TypeScript. |

Dependency policy: no new runtime dependencies without discussion; prefer Node built-ins and small purpose-built primitives. A dependency is adopted only where it retires a named class of bugs.

## Abstraction boundaries

Ports separate `pomtreed` from its dependencies. Each is defined by what the daemon needs, not what the first dependency offers, so replacing one is mechanical. A port exists only where a second implementation is plausible.

| Port | What the daemon asks of it | Single-node adapter | Later adapter |
| --- | --- | --- | --- |
| Sandbox | Start, stop, kill, re-adopt, and inspect an isolated environment from resource limits and named mounts, never host paths; open a terminal; stream output; apply an egress policy, including audited-public | Docker (CLI plus Engine API) | Remote node (`pomtreed-node`); later Kubernetes, microVMs; contributed backends ([`docs/sandbox-backends.md`](docs/sandbox-backends.md)) |
| Harness | Start or resume an agent session and return normalized events | Interactive Pi with an events side-channel | Other harnesses |
| Orchestrator | Run lifecycles durably with timers, wake conditions, cancellation | In-process | A durable external engine |
| Journal | Append ordered events; subscribe from a position | SQLite | Same, on the controller |
| Registry | Agent records (id, parent, state, host, generation, exit cause, sandbox backend); the backend is pinned while the record holds a sandbox id (a different selected backend is refused and the agent is held until the recorded one is selected again or the agent is abandoned) and cleared with the sandbox; peer lookups; the one resume edge, exited to running | SQLite | Shared database |
| Mailbox | Durable inbox per agent | SQLite | Same, on the controller |
| CheckpointStore | Write and read checkpoints | SQLite plus Git | Object store |
| SessionStore | Keep harness session files by id | Local directory | Object store |
| Workspace | A private full git clone per agent and repo: create, fork, pack, unpack, evict, ingest committed work, serve, resolve, publish, prune | Local Git | The same on each node; the controller keeps the mirrors |
| RepoStore | Repos (id, name, credential handle, default branch, policy); the only writer of a merge target: merge in the mirror, one at a time per repo, compare-and-swap ref move | SQLite, backed by a bare mirror | Shared database |
| MergeStore | Durable merge journal, failed rounds per child, and status, so a crash resumes a merge | SQLite | Shared database |
| CheckRunner | Run a repo's optional check command on an exact candidate commit; a failure leaves the target untouched | No production runner; the daemon refuses to start when a merge check is configured | Per node |
| HostStore | Host table (resources, labels, mounts, status) and expiring reservations behind Placement | SQLite | Shared database |
| ModelGateway | Issue per-agent keys, meter use, enforce budgets; the proxy is the only path to a provider, so agents never hold provider keys | In-house key-issuing proxy | LiteLLM |
| ExtensionGateway | Host-proxied tools for agents (web search and fetch) with approval and SSRF guards | In-daemon proxy | Same, replicated |
| Placement | Where a session runs; admission under capacity | Local; queue when full | Host-table scheduler; later Slurm or Kubernetes queues |
| ReportStore | Per-agent published reports, content-addressed, generation-fenced | Visible directory | Object store |
| EscalationStore | Human asks and answers with expiry and authority chain | SQLite | Shared database |
| ScheduleStore | Cron schedules and cursors | SQLite | Shared database |
| WatchdogStore | Watchdog state and retry counters | SQLite | Shared database |
| TemplateStore | Named agent templates, one per agent type (prompt, extensions, limits) | Directory | Shared store |

Two boundaries matter most. The Harness port normalizes Pi's output into a small event set, so the live view, traces, and watchdog never depend on Pi's format. The Journal is the single record of agent activity, read independently by the live view, trace exporter, and watchdogs. The Registry is the queryable truth about which agents exist; the Orchestrator drives transitions, and its own log is an implementation detail nothing else reads.

### Pi as an interactive harness

Pi runs interactively as the container's PID 1 with a TTY, not as a one-shot JSON process; its stdout is for humans and is never parsed. Structured events (message, tool_call, tool_result, usage, error, note, agent_settled) come from a side-channel: the `pomtree-events` Pi extension appends JSONL to `events.jsonl` beside `session.jsonl`, and `packages/harness-pi` tails and normalizes it. Interactive Pi always exits 0, so exits are classified from the sink and container state.

`Sandbox.attach` re-adopts a live container after a `pomtreed` restart. The `terminal` facet's `open(id, size?)`, read via `need(sandbox, "terminal")`, opens a `TerminalSession` on a sandbox started with `SandboxSpec.tty`; the Docker adapter (`packages/sandbox-docker`) implements it with an HTTP Upgrade attach carrying raw bytes. The `loopback` facet's `open(id, port)`, read via `need(sandbox, "loopback")`, opens a `ByteStream` to a container-loopback TCP port limited to `LOOPBACK_PORTS` (today only Chromium's DevTools port); the Docker adapter runs a non-TTY exec of the baked bridge `LOOPBACK_BRIDGE_MAIN` and demultiplexes its stdout, so no port is ever published. A backend that has not run it live declares `loopback` false.

A settled turn with no recorded result (`pomtree result` or yield) is `waiting`, not finished: the session and container stay up until a result is recorded, the container exits, the budget runs out (the agent parks pending a raise, else ends), or an operator stops it. The stall ladder exempts a waiting agent; other trips still apply. `waiting` is a flag on a running agent, not a sixth state, derived from the journal (`ext.pomtreed.waiting`) and exposed as `waitingSince`. Messages reach a live agent as steers, queued until the current tool and thinking rounds finish; an idle Pi turns one into a new turn. The extension consumes (acks) a signal when it queues it, so `pomtree inbox --wait` can show nothing for an already-delivered message. Known gaps: steer delivery to a waiting agent is checked against Pi's source but not against a live Pi, and may collide with the user typing in the same terminal; a waiting agent has no idle timeout, so nothing bounds it unless the spawn sets a deadline; yield and exit detection for TTY Pi are not redefined for the terminal design, so a TTY Pi that exits 0 on SIGTERM has no exit-cause label.

An agent may not passively settle. Every legitimate settle is declared, by the agent (`pomtree result`, `pomtree yield`, or `pomtree await-user`) or by the user (Esc). `pomtree await-user` is valid only after an unanswered human message, is consumed by the following settle, and is otherwise refused. A user abort counts only when the harness reports an aborted turn and the terminal hub saw a bare Esc just before, since the harness event file is agent-writable. Any other settle is passive: the daemon re-prompts, and after a bounded number of consecutive passive settles the run fails. Known gaps, all failing toward a nudge: a lone Esc coalesced with other bytes, or a kitty-protocol Esc, is missed, and `await-user` can be refused if its call beats the journaling of buffered user input (the agent retries). The Esc check proves only that a viewer websocket sent 0x1b recently, not that a human did; an agent with docker exec or attach rights, or a rogue viewer, could forge one (an accepted limitation). The daemon cannot see background jobs, so a settle with a running background job counts as passive (`job_wait` and yield count as activity).

A TTY yield stays daemon-driven: stop the container, then checkpoint; a resume starts a new container on the restored session. The intended terminal behavior is to keep the last screen under a banner giving the reason, hold the socket idle, and reattach on resume. Known gaps: the websocket currently closes with the container with no banner, and a resume shows a fresh Pi on the restored session; tools are at-least-once across a resume (an in-flight tool call at yield is lost, not replayed, and the model may re-run it); a yield during token generation is unexercised.

### Extensions

Optional capabilities (reports, cron, the live view and OTLP export, the operator UI, messaging channels such as Discord) are extensions to `pomtreed`, not core code. An extension declares routes, scoped credentials, and journal consumers through a contract in `core` and receives a host facade, not the daemon. Every extension, file-loaded or compiled in (observe, reports, cron), declares what it uses in its manifest, and one facade enforces it: `apiVersion` must equal the host's `EXTENSION_API_VERSION` from `core` (a missing or different value refuses the extension at load), and `capabilities` and `deps` are required (an empty `{}` or `[]` declares nothing; a missing or invalid block refuses that extension's load), and anything undeclared is denied with `extension <name>: <op> requires <flag>`. `capabilities.routes` gates `host.route` and `host.stream`, `capabilities.verbs` gates `host.verb`, `capabilities.journalKinds` gates `host.journalKind`, `capabilities.hooks.journal` gates `host.onJournal`, and `capabilities.hooks.spawn` gates `host.onSpawn` and `host.spawnSpec`; `host.workflow` has no flag and stays gated by workflow admission. `deps` names gate `deps.getAgent` and `deps.listAgents` (`registry`), `deps.journal.read` and `deps.journal.subscribe` (`journal`), `deps.record`, `deps.deliver`, `deps.authorize` and `deps.credential` (`credentials`, which also needs the name in `manifest.credentials`); `hostId`, `now` and `log` need no flag, and the `store` dep has no flag. `deps.authorize` is deny-all over a closed action set that is empty (`EXTENSION_ACTIONS` in `core`); an action is added only per need, with its policy. A manifest without the required blocks is refused at load, with a message saying what to add. The manifest may also carry a `provides` list of contributed components, each `{kind, id, entry, portVersion, params?, credentials?, deps?}`; `EXTENSION_API_VERSION` is 2 for this field, and only kind `sandbox` is accepted (any other kind refuses the extension at load, naming the kind). First-party sandbox backends are built into the host and declare nothing. Core owns the lifecycle, ports, and fencing; extensions may be absent without breaking it. Calls made on an agent's behalf (`ExtensionGateway`) pass through the approval primitive below. `observe` records operator UI commands as extension journal kind `ext.observe.ui_command` and serves them as a journal view at `GET /live/ui`, so the stateless rule holds and the core contract is unchanged.

A workflow handler reaches only the capabilities its extension declares in `WorkflowCapabilities`; an undeclared one rejects. `store` is keyed durable state owned by the extension, scoped by the host to the workflow and instance. `sharedStore` (mode `r` or `rw`) gives `ctx.workflow.shared`, a store shared by all of one extension's workflows and by no other extension's, under the owner `<ext>` and the prefix `ext/s/`. It has the same size cap, compare-and-set and journaling as `store`; a workflow write to `store` or `shared` must carry a generation fence (the task it runs as), and an unfenced workflow write is refused; agents never write under `ext/s/`: the daemon refuses every agent write there, refuses an rw agent grant whose prefix overlaps it, and refuses with 403 a whole-owner prefix removal by an agent that would reach it; under mode `r` writes are refused. Operators write its keys with `pomtree state put` or `/v1/state`, and a reader sees who wrote each record (`writer`). A write is data only: it wakes, delivers and launches nothing. `fetch` reads a public page for the handler within a per-task request budget (`maxRequests`). It sends the operator-configured `workflow.fetch.userAgent` (none when empty) and follows redirects only to the same host (https, port 443, re-allowlisted and re-pinned on every hop, at most 5 hops, each hop counted toward `maxRequests`). It also honours the operator's per-host minimum interval, `workflow.fetch.minIntervalMs` (default 0, off), across every workflow on the daemon, and each redirect hop is a request; this is how the operator meets a site's rate limit, such as SEC EDGAR's published limit of 10 requests per second (see Sources). A broker for all web acquisition (cache, robots handling, signed captures, viewer roles) is future work.

### Authority and approval

Gates (an extension call, a spawn, a publish, a merge into the default branch, a human ask) are decided by an approval record with a ladder of rungs: a policy table, then one `agent:<id>` rung per ancestor of the requester (nearest first, the root excluded), then the operator, then the owner. Each rung has its own window, taken from configuration. Deny is final. Abstain, escalate, or timeout moves to the next rung; past the top rung the answer is deny. An approver's rank must exceed the requester's, and every transition is journaled. A decision may carry a grant (for example extra budget, committed by the deciding ancestor out of its own remaining budget; a top-level agent's grant draws from the root's remaining budget). A budget-raise request is one such gate: if granted, the parked agent resumes with the raised budget; if denied or timed out, it ends `over_budget`. Escalations carry a deadline and are re-notified up the ladder; an answer wakes a yielded asker. There is no model approver.

## Agent lifecycle and reaping

Five states: pending, running, yielded, exited, reaped. A parent cannot finish successfully until it has reaped every child. The model is borrowed from operating systems, whose wait, zombie, and orphan rules are well understood. Every agent has a parent; a root supervisor inside `pomtreed` parents everything started by a schedule or an operator, so no agent is parentless and the root never exits.

A finished agent has an exit status (succeeded, failed, cancelled, timed out, over budget) and an exit cause (why it ended: clean, OOM, provider error, sandbox unavailable, journal unwritable, and so on); every failure path names its cause and the operator action, and a timed-out agent's journal says that its session deadline passed. It stays exited, as a zombie holding its result, until its parent collects it. The rule is scoped: children of the root supervisor are reaped at exit (the root never collects). Reaping moves the agent to reaped and ends the hold (the budget claim, the zombie alert and the parent's obligation to collect); the record and its result stay in the store. Children of the root supervisor are persisted and delivered, and a child of a live non-root parent is held unreaped until that parent collects it. When a parent dies, its exited, unreaped descendants are held for the nearest live ancestor, the custodian (derived from the immutable parent chain; the root counts as live), and are never auto-reaped, so custody and delivery are not lost. The custodian is told once (a `child_exited` signal marked `custodyOf` and a wake, applied whatever the custodian waits on (a message, a timer or an any-mode child wait) except an all-children join, an open ask or a budget park; for the root, a status line to the operator) and may show, read and reap the held agent through the API; no one else gains access. Past `agent.rootCustodyMax` held agents each further delivery also raises an alert and an error entry; nothing is refused or dropped. An agent in custody keeps its budget hold on its parent's ledger node until it is reaped. Known gap: an operator cannot discard a root-custody agent's pushed, unmerged work; reap is always guarded, so the agent stays unreaped until it merges or escalates. A running agent may yield and wake any number of times; every path ends in exited, and only the parent's reap moves it on. The one legal move back is a resume of an exited, unreaped child by an ancestor (exited to running, generation bumped, result cleared), used to hand it a merge conflict.

A parent declares what happens to a child's result with a disposition, given at spawn or in the template (the request wins; absent means hold). `hold` keeps the exited child until its parent or custodian reaps it. `reap-on-exit` reaps it at exit, after the parent or custodian has been told and the clipped handoff has been delivered with the `child_exited` signal. `hold` may carry a TTL: once it passes, the custodian is told, naming the child's branch and how to pull it, and the child is reaped, unless its merge is unsettled (the same check that guards an explicit reap): then the child stays held, one journal row says why, and it expires at the first sweep after the merge settles, or when its custodian or the operator reaps it. `reap-on-exit`, a per-child declaration, is not guarded by the merge check. Children of the root supervisor behave as `reap-on-exit` whatever they declare, and deterministic agents always hold. A root child that never pushed keeps its published reports until the operator removes them with `pomtree report rm`; there is no report TTL (a known gap).

A child finishes in two phases. When it reports `pomtree result`, its parent receives the result (status and handoff text) at once. The child then has a short bounded wrap-up window; when it settles or the window ends, the daemon stops it and signals exit, and only then can the parent reap it. Cleanup, including `pomtree push`, belongs before the result.

### Merging

A parent merges a child by asking the controller (`pomtree merge`). Every agent writes only its own refs, so the controller is the only writer of any other branch. Merges run one at a time per repo. The controller pins both tips, merges in its mirror with a hardened `git merge-tree` (no checkout, so no agent file touches it), checks the repo's policy on the merged result (denied or unsafe paths, submodules, size), optionally runs the repo's check on the exact candidate commit, and moves the target by compare-and-swap. A moved target forces a retry; a crash leaves the old ref or the new one. Each step is journaled and idempotent.

A conflict or failed check returns to the parent, who resolves it in its own clone and asks again, or resumes the child with the conflicted paths. After a bounded number of failed rounds per child the user is asked. The top-level agent's own branch merges into the default branch only under the user's approval. `reap` returns the child's ref and tip and does not merge; it is refused until the child is merged, escalated, or has nothing to merge, and a dead parent's child counts as merged when it is merged into its custodian's ref (the default branch for a root custodian). The one exception is a reap the parent itself declared, `reap-on-exit` or a TTL expiry: it skips this guard, because reaping keeps the record and the `agent/<id>` branch and the notice says where the work is. The journal records `merged`, `merge_conflict`, `check_failed`, and `merge_escalated`.

### Rules

1. **Reaping is mandatory** for every agent whose parent is not the root supervisor, whether done by the parent, by a custodian, or by its declared disposition; reaping ends the parent's hold on the result, it does not delete the record. Every spawn returns a handle. `pomtree result` fails while unreaped children remain and lists them.
2. **Zombies are watched.** A child exited but unreaped past a limit raises an alert through the escalation channel. The root's inbox is a passthrough: signals addressed to the root, including a child's exit, are relayed to the [user outbox](docs/tasks.md#4-root-and-the-message-path) with the sender attributed, not enqueued.
3. **Failure is pushed, not polled.** A parent's default wake condition includes "any child exited with failure".
4. **Live orphans are cancelled by default.** If a parent dies, its live children get a cancel signal and a grace period, then a kill, before its exited descendants are handed to the custodian. Detachments (a child that outlives its spawner) could be added if a use-case motivates them.
5. **Budgets nest.** A child's budget is carved from its parent's; the unused part returns on reap. Budget is a conserved ledger and the swarm's allocation signal: [`docs/economy.md`](docs/economy.md).
6. **Fan-out is bounded.** Limits on tree depth and children per parent, enforced at spawn.
7. **Every end has a cause.** A container exit with no reported result, a swallowed commit failure, or an unclassified error is not a clean success; the cause is recorded.

### Signals

Signals are events in an agent's inbox. `child_exited` goes to the parent; `cancel` asks an agent to stop, with a grace period before a forced kill; `timeout` is raised by the platform and ends the agent with the matching status; `budget_warning` is raised before the budget runs out. Exhausting the budget is not terminal: the agent parks (yields) and a budget-raise request climbs the ancestor chain as an `escalation` ([`docs/economy.md`](docs/economy.md#13-budget-exhaustion-and-escalation)). `budget_exceeded` is a reserved signal kind that the platform does not emit. An `escalation` climbs the ancestor chain: each ancestor, parent first, is woken to decide it or pass it up, and the root relays it to the user; answers to an asker reuse `human_answer`. Signals are classified by kind. Level-style kinds (`nudge`, `cancel`, `timeout`, `pause`, `budget_exceeded`, `budget_warning`) coalesce, so the latest wins; payload kinds (`message`, `child_exited`, `human_message`, `human_answer`, `escalation`) queue. A signal's id is its send's idempotency key, and an agent acks consumed signals by id under its own key, so acks are idempotent and order-free. Agent-originated `message` signals carry the sender's generation and are fenced; daemon-originated signals are issued by the daemon and are unfenced. Harness commands are typed operations with per-adapter descriptors, not raw text.

## Spawn, fork, yield, and resume

An agent's whole identity can be rebuilt from a Pi session file, a Git commit, and a small checkpoint record that ties them together. That makes yield and resume cheap and lets a resumed agent run on any host.

### Spawn and fork

Spawning creates a registry entry; placement admits it; the workspace gives it a clone and branch; the model gateway issues a key with a carved-out budget; the sandbox starts a container from the pinned image; the harness starts a session with the task prompt. A template is the agent type: one named definition of image (by digest), harness, tools, resources, egress, and resume behavior. Core owns the fields placement, checkpointing, approval, and tools read; the adapter owns the Docker realization. Delegation only narrows: an agent's spawn may lower resources and narrow egress, and a spawn whose egress or resource limits exceed its parent's is refused with an error naming both and the fix (a resource limit the parent leaves unset bounds nothing, except memory, which compares against the daemon's default); an untemplated child is checked too, never silently clamped. The operator is not bounded by a parent, and a deterministic workflow driver, which has no sandbox, is bounded by the operator's template grant instead. The comparison is `egressWithin` and `resourcesExceeded` in `packages/pomtreed/src/daemon/delegation.ts`. A child inherits its parent's declared dependency list, never its actual installs. A fork also copies the parent's session and folder; the copied repository is sanitised before git runs in it. Pi session files carry a `parentSession` header field for sessions created by fork or clone.

### Yield

To yield, an agent reports and the container stops; `pomtreed` then reads the session file, writes a checkpoint, and registers a wait condition. The folder stays on the node's disk until a later garbage-collection pass, so uncommitted work survives. The checkpoint holds the session reference, workspace id and node id, last ingested commit, wait condition, remaining budget, image digest, host, and generation, plus a format version; a reader refuses a version newer than it understands, and a row without one is format 1. A crash between stop and checkpoint leaves the agent `running` with no container; recovery finds the folder and writes the checkpoint idempotently. Known gaps: tools are at-least-once across a resume, and cleanup after a child is reaped is incomplete (a child whose commits were only partly cherry-picked keeps a refused workspace prune that is retried on every sweep).

### Resume

When the wait condition is met, the orchestrator starts a continuation. Placement prefers the previous host, where the kept folder is. A fresh container starts from the pinned image digest, mounts that folder (from another host, moved as opaque bytes; if gone, the last ingested commit), restores the session, and appends the waking event. Each resume increases the generation so a stale instance can never write, and a forced resume first reclaims the old container so two instances never share a folder. Pi derives its session directory from the working directory, so containers use one fixed working directory or an explicit session path.

### Checkpointed actions

Resuming continues a conversation; it does not replay one, so an action taken before a yield must never run twice. Actions through `pomtree` (spawn, message, ask) are recorded once even if retried. Direct actions have no such guarantee, so externally visible actions are typed, keyed `pomtree` commands and Git history is the record of file changes. Long transcripts need summarizing at yield; whether Pi's compaction fits is unverified.

## Scheduling, cron, and watchdogs

Four jobs: starting work on a clock (cron), watching for stuck agents (watchdogs), deciding what may run now (admission), and deciding where a session runs (placement). On one node the last two reduce to a queue but stay separate ports.

### Cron

A schedule holds an id, a cron expression, a task template, and policies. Each firing spawns a child of the root with a task key built from the schedule id and scheduled time, so a repeated firing is a recognized duplicate; the cursor advances only after the spawn succeeds. An optional `agent` target makes it a periodic wakeup: a running or waiting target gets the task as a steer, a yielded target is resumed with it, and an exited target orphans the schedule and raises one alert. Agents may only target themselves, within limits on count and minimum interval. Known gaps: agent-created schedules skip the approval primitive, a quarantined yielded target holds the fire as a retried 409 with no alert, and `pause` and `resume` are operator-only. Policies cover missed runs (skip, run one, catch up, capped), overlap (skip or queue), and jitter. Cron is a daemon-side extension over the `ScheduleStore`.

### Watchdogs

Each running agent is checked for recent journal events, a deadline, budget burn rate, and repeated failures. A trip starts a ladder: nudge, cancel, kill and resume from the last checkpoint (up to a retry cap the resume does not reset), then escalate to a human; repeated trips quarantine the agent. An agent blocked on an open human ask is exempt. One agent's failing check never stops the sweep.

The daemon needs its own watchdog: the host's service manager restarts `pomtreed` if it dies. At startup and periodically it reconciles the registry against the containers that exist, adopting live ones, removing strays, and resuming agents marked running that have none. Only one `pomtreed` may own a state directory and socket.

### Admission and priority

Placement admits a session only if capacity allows: CPU, memory, a concurrent-session cap, and provider rate limits. Excess work queues by priority class (alert response, interactive, scheduled); a queued spawn returns immediately and the parent normally yields. Resumes go through admission too. Later the same port asks a capacity provider (Slurm, Kubernetes) for more.

### Sessions and sandboxes

The unit of scheduling is the session, not the container. A lease links a session to a sandbox slot; each sandbox hosts one session initially, and the lease lets forks share a warm sandbox or a session move later.

## Isolation, git, and credentials

Agents run arbitrary commands, so the host never trusts anything an agent can write, and host-side git never runs inside an agent-writable tree with that tree's configuration. The controller owns a bare mirror per repo and each agent works in a private full clone. Committed work crosses only by ingest: a bundle checked in a throwaway quarantine repository and copied into refs under the agent's own name, so no agent writes another's branch. Ingest is fast-forward only; an operator may force it, which is refused for agent scope and records the overwritten tip, so a stale or rewritten agent push cannot erase a controller merge. The mirror's `.git` is never mounted writable. Running agents that may be hostile is out of scope: see "Supervised use only" in [`docs/safety-decisions.md`](docs/safety-decisions.md).

Containers run non-root with dropped capabilities, no new privileges, an init process, and pid and log limits. Egress is limited by default to the node relay and the registries the environment names (`registry`), through a policy-enforcing proxy (allowlist, address pinning, no private ranges); workers explicitly approved for audited-public may instead use that mode below, which does not broaden the default. Browser profiles run under a custom Chromium seccomp profile; gVisor is an opt-in worker runtime (a template's `runtime.ociRuntime`), with the default unchanged, and microVMs are deferred. Agents never hold provider keys, only scoped, expiring credentials bound to their id and generation. The credential gateway, registry-only egress, and pinned publish are preconditions for any second host or browser profile. Git credentials and publishing are held only by the daemon, behind the approval primitive; `publish` pushes one pinned commit, reachable from the agent's ingested refs or the default branch. In a multi-host design, only the controller holds provider credentials and trusted repositories; a node is trusted solely for the tokens and mounts of its agents.

### Audited public egress

`EgressPolicy` gains an opt-in `audited-public` kind beside `none`, `registry`, and `allowlist`; existing defaults are unchanged. It is used only through an operator-authorized workflow or template and per actual worker admission, never as a blanket global mode or by an agent's self-asserted network grant. Defaults for existing and unrelated templates are unchanged. A run-scoped operator grant may cover its bounded child tree; it is not an approval prompt for each HTTP request or child. It permits HTTP and HTTPS to public destinations on any valid port, with no per-domain allowlist. It does not permit UDP, or access to private, loopback, link-local, multicast, metadata, or host-owned addresses, including any address a mixed public/private DNS answer exposes. Private access exists only through exact controller-supplied relay endpoints; the hard denial of metadata, link-local, loopback, unspecified, and multicast addresses is never overridden. Public access grants neither provider credentials nor model spend.

The worker runs with no network interface other than loopback. A local TCP byte bridge inside the worker forwards to the existing per-worker HTTP/CONNECT audit proxy, reached only through a read-only shared Unix socket volume. The proxy runs in its own container on one shared external network with inter-container traffic disabled, so proxies cannot reach each other's ports, is controlled by `pomtreed`, and reuses the existing proxy parser and audit code. The proxy serves two sockets over one audit writer: the main one (Pi and its tools, including the relay authorities) and a browser one with no relay authorities, bridged to its own loopback port in a browser-capable worker, so page script cannot reach a relay endpoint. The worker starts Pi by absolute path (the realpath of the pinned binary under the image's node) and looks any other bare command up only in the image's fixed path, never through the agent-writable directories that lead its `PATH`. The worker's only outside communication is that audited socket: it has no Docker DNS, bridge, routable IPv6, off-box DNS, UDP, or host route. This requires no host firewall changes or elevated worker capabilities. Proxy environment variables alone do not confine a browser, so socket permission enforcement and proxy-environment support must be verified on the actual platform before the mode is enabled. The socket volume is ephemeral and is not audit evidence. The read-only immutable configuration and the proxy's read-write durable audit spool are separate, and the worker never receives world-writable access to either. Model traffic still goes to the controller's scoped model proxy, and no provider key enters the worker or the sidecar.

Each connection is admitted against a durable audit record before it is dialed; if that record cannot be written, the connection is refused. Records carry the agent, task, host, generation, and sandbox identity captured when the sandbox was created, never relabelled to a later generation. They are sanitized (no credentials, cookies, query strings, or bodies) and bounded. Records are ingested into the journal idempotently, and unacknowledged records survive cleanup. Each record also carries a hash-chain value over its predecessor (the first chains from the sandbox id). `pomtreed` recomputes the chain, journals every ingested row's value, and refuses a spool that does not reproduce the journaled head, so a changed, deleted, reordered or truncated ingested row is detected even if the proxy re-chains its own file; rows not yet ingested are not protected, and a MAC would add nothing because its key would sit in the same compromised container. A spool is deleted only after its sandbox closed it (the host marks it once the proxy is gone), every row is acknowledged and journaled, a verification pass reproduces the journaled head, and a grace window passed (`audit.spoolVacuumGraceMs`); the deletion is journaled first, and the sandbox id is never reused.

CONNECT audit sees the requested authority, validated peer address, outcome, duration, and byte counts. It does not see HTTPS paths, status codes, redirects, content, or WebSocket messages, and this design claims no payload capture. Browser action, navigation, and screenshot records complement connection audit with application intent and results; they do not cover service workers, background traffic, or arbitrary network use. Changing its scope (payload inspection, new protocols, or multi-host operation) is a new design decision, not a configuration change.

### Template prompt and browsing profiles

`Template.systemPrompt` is appended to Pi's built-in system prompt (`--append-system-prompt`), never replacing it. It comes only from the template file: a spawn request cannot set or override it. It is one argv value, so the template loader bounds it to `SYSTEM_PROMPT_MAX_BYTES` UTF-8 bytes and refuses NUL (`systemPromptProblem` in `core`). It is guidance, not enforcement: only the tool list and egress policy are enforced.

`Template.allowlist` names a tool profile that fixes the worker's complete Pi tool set, so the caller never chooses tools; a spawn may require a profile (`requireAllowlist`) and the host refuses a template without it. The `browse` profile offers only `web_fetch` (plus the events sink), with no shell, file tools, MCP, skills or `pomtree` tool, so untrusted page text never reaches a shell. The loader refuses it unless `extensions` lists `web_fetch` and `egress` is an `allowlist`; `web_fetch` reaches only those hosts over https, re-checked after every redirect. It reads text only, with no JavaScript rendering or clicking.

The `analyst` profile is a closed paged reader: it offers only `article_page` (reads one page report its coordinator published) and `analysis_result` (returns one bounded result), with no shell, file, network or `pomtree` tool. The `specialist` profile is the same shape: it offers only `thread_page`, `source_page` and `post_draft`, so the worker reads pages its coordinator published and returns one post draft, which the coordinator validates and stamps. A template using `analyst` or `specialist` lists no extensions (the profile loads its own) and uses egress `none` or `registry`; neither carries an `env` or an env manifest, so `registry` egress reaches only the model relay; `registry` is what works for these profiles, and `allowlist` and `audited-public` are refused. Known gap: `none` resolves to an empty allow-list with no model relay (it means no model), so a template under `none` cannot reach the model route, and there is no explicit model-only egress kind.

`Template.browser` marks the container as a browser worker and requires `audited-public` egress; its step and wall-clock budgets come from the template, never from a spawn request. `browser.profile` selects the worker's tool set. Absent, the worker is the capture-only worker (`browser_capture` and `capture_finish`) used by the digest, which issues capture receipts. The closed value `interactive` (`BROWSER_PROFILES` in `core`) is a profile in which the model drives a fresh headless Chromium with a fixed navigation, snapshot, click, type, key, scroll, screenshot and tab tool set ending in `capture_finish`; the image owns the list. It has no shell, file or `pomtree` tool and no `browser_capture`, so it never issues a capture receipt. The loader refuses `interactive` without `audited-public` egress or together with an `allowlist` profile. Every call counts against a step budget, with the last step reserved for `capture_finish`, and a wall-clock budget; a recorded `capture_finish` result ends the run and sets its status, and an exhausted time budget stops the worker. Browser action and screenshot reports complement the connection audit above.

The accepted risk of `interactive` is prompt injection: page content reaches the model, which acts on the page. The tool list and the audited proxy bound what a steered agent can do, but cannot stop it from taking in-page actions such as following a link the page asks for. The browser profile is fresh and never signed in, and the template's instructions (untrusted page data, no logins, purchases or downloads) are not enforced. Operator how-to, limits and result handling: [`examples/browse-agent/README.md`](examples/browse-agent/README.md).

## Live view and operator UI

The live view shows the agent tree (from registry parent ids) and each agent's activity (from the journal): name and id, state, age, latest activity, tokens and cost, remaining budget, wait condition, and host. Yielded agents stay in the tree.

The harness port's normalized events are appended to the journal with lifecycle events; the live view, trace exporter, and watchdogs subscribe independently. The operator UI is served by `pomtreed` (an extension) over server-sent events and works on a phone: tree, per-agent terminal, reports, audit log, escalations, messages, placement. `pomtree top` is the terminal version.

The per-agent terminal is an xterm.js view of Pi's own TUI, vendored without a build step (`packages/observe/vendor`). `GET /v1/agents/:id/terminal` is a hand-rolled websocket: binary frames carry raw terminal bytes, client text frames resize, a server text frame signals close. The route is operator-only and checks Origin. One shared `TerminalSession` per agent fans out to all viewers with replay.

`GET /v1/agents/:id/browser` is a read-only live view of the agent's headless Chromium, a hand-rolled websocket with the terminal's guard (operator-only, Origin must match Host, 409 when the agent is not running, and 409 naming the backend when the sandbox backend provides no `loopback` facet). The daemon reaches Chromium's DevTools port only through the sandbox `loopback` facet (`need(sandbox, "loopback")`), never a published port, sends nothing but `Page.startScreencast`, `Page.screencastFrameAck` and `Page.stopScreencast`, validates every frame, and relays only JPEG binary messages and small status/closed JSON texts. While the per-window input flag is unbuilt or off, the UI can send nothing (a data message closes 1008). There are at most 8 viewers per agent (the 9th gets 503), and the page's url and title are agent-controlled text. Operator input is decided but not built: it is allowed only behind a per-window flag that defaults to off (every window is read-only until the operator turns it on), the agent is told when control is taken and returned, and one controller holds a window at a time. The full rule, its rationale and the open items are in `docs/safety-decisions.md`, "Operator input into the agent's browser".

### Traces

Each agent invocation is an OpenTelemetry span with a span per tool call beneath it; spawning passes trace context to the child so spans nest across the tree. Spans are built from normalized events, so Pi needs no changes. Prompt and response text is excluded by default. Open risk: the conventions are experimental.

## Command-line interface

One binary, `pomtree`, serves agents in sandboxes and operators on the host through the same API. Each caller presents a scoped credential; a command outside the scope is refused. An agent's credential is issued at spawn, tied to its id and generation, and cannot be widened. Every command can print JSON, exit codes are meaningful, and every mutating command sends an idempotency key (per invocation, never derived from the body).

| Command | Audience | What it does |
| --- | --- | --- |
| `pomtree spawn` | Agent | Start a child, optionally from a template or forked |
| `pomtree wait` | Agent | Block briefly on a child, with a timeout |
| `pomtree yield` | Agent | Checkpoint and sleep until a wait condition is met |
| `pomtree await-user` | Agent | Declare waiting for the human to reply |
| `pomtree reap` | Agent | Collect a child's result, ref, and tip (refused until merged or escalated) |
| `pomtree push`, `pull` | Agent | Send committed work for ingest, fast-forward only (`--force` is operator-only); fetch ingested branches |
| `pomtree merge <child>`, `merge --into <branch>` | Agent | Merge a child's pushed branch into the caller's own; the top-level agent merges its own into the default branch, under approval |
| `pomtree result` | Agent | Return the typed result and finish |
| `pomtree peers`, `send`, `inbox` | Agent | Find other agents and exchange messages |
| `pomtree ask` | Agent | Raise a human escalation |
| `pomtree budget` | Agent | Show remaining budget |
| `pomtree ext` | Agent | Call host-proxied tools |
| `pomtree report` | Agent, operator | Publish, list, show, remove reports |
| `pomtree state` | Agent (within granted owners), operator | Read and write durable workflow-store documents; list, export, import, remove |
| `pomtree ps`, `tree` | Operator | List agents; show their nesting |
| `pomtree top` | Operator | Live terminal view |
| `pomtree show <id>` | Operator | State, checkpoint, wait condition, recent events |
| `pomtree logs <id>` | Operator | Event stream and transcript |
| `pomtree cancel`, `kill <id>` | Operator | Send a cancel signal or force a kill |
| `pomtree resume <id>` | Operator; an ancestor, for an exited unreaped child | Resume an agent from its last checkpoint |
| `pomtree sched ls`, `add`, `rm`, `pause` | Operator; agent for its own | Manage schedules |
| `pomtree template` | Operator | List and show templates |
| `pomtree drain` | Operator | Drain this host within a deadline; the `HOST` argument is accepted and ignored |
| `pomtree doctor` | Operator | Reconcile state; check dependencies |

Future work (multi-host): `pomtree hosts` and a `drain <host>` that routes to a named host, and `pomtreectl`, a host-local kill switch, by label, that works while the controller is down. None of these is built.

## Design concerns for distribution

Items the rules above already address (split brain, duplicate delivery, retry storms) are not repeated; these remain open.

- **Correctness under failure.** Duplicate side effects after a resume are mitigated by keyed `pomtree` actions only.
- **State and data.** Retention and GC of checkpoints, transcripts, journal, and zombies. Transcript growth versus context window. Backup and integrity checking of the SQLite file. Clock skew. Each SQLite database (store and state) is one baseline schema at `user_version` 1, stamped with a distinct `PRAGMA application_id`; a database without the stamp or with a foreign one is refused at open and must be moved aside and re-initialized. Later schema changes ship as ordered forward-only migrations keyed on `PRAGMA user_version`; before a real migration the store runs an integrity check and writes a `<db>.pre-v<N>.bak` backup, and it refuses a database newer than the code. Older backups are pruned after a successful migration. There is no downgrade path.
- **Scale and cost.** Fairness across priority classes. Model rate limits shared by every host. Budgets across retries, forks, and resumes.
- **Security and isolation.** Container strength versus microVMs. Per-sandbox egress. Who may message or spawn whom.
- **Operations.** Versioning: persisted SQLite is versioned by `PRAGMA user_version` and identified by `PRAGMA application_id`, and checkpoints carry a format version, the messaging adapter contract and extension API carry their own versions, and the other wire shapes have none; only the pinned harness version is targeted. Draining a host without losing work. Trace and journal ordering across hosts.

## Open questions

Each is to be answered by a small experiment.

- **Pi:** whether forks should reuse Pi's `parentSession` link; yield and exit detection for TTY Pi; whether its compaction suits yield; whether it returns image tool results.
- **Isolation:** when tasks justify microVMs; whether a Chromium seccomp profile suffices for untrusted pages.
- **Images:** whether to adopt an image registry or ship images over the node link (`docker save`).
- **Budgets:** whether a LiteLLM-style gateway earns its weight over the in-house proxy.
- **Sessions and containers:** whether one session per sandbox stays right.
- **Cron:** the default missed-run and overlap policy.

## Sources

All links below were retrieved on 2026-11-04.

- Durable execution: [Restate vs Temporal](https://restate.dev/vs/temporal) (vendor comparison, retrieved 2026-11-04); [Temporal Schedules](https://docs.temporal.io/schedule) (native schedules, retrieved 2026-11-04); [Temporal repository](https://github.com/temporalio/temporal) (MIT license, retrieved 2026-11-04)
- Pi: [repository](https://github.com/earendil-works/pi) (MIT license, retrieved 2026-11-04); [session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md) (the `parentSession` header field, retrieved 2026-11-04); [security notes](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md) (no built-in sandbox, no per-tool-call approval, retrieved 2026-11-04)
- Sandboxes: [agent sandbox list](https://github.com/fishman/awesome-agent-sandbox) (curated list of microVM, container and process sandboxes, retrieved 2026-11-04)
- Tracing: [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) (repository retrieved 2026-11-04; its README states no stability level, and the "experimental" status above rests on the opentelemetry.io listing showing Status: Development, which was not re-read in full)
- Rate limits: [SEC, Accessing EDGAR Data](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data) (current maximum request rate of 10 requests per second, retrieved 2026-11-04)
- Model gateway: [LiteLLM proxy deployment](https://docs.litellm.ai/docs/proxy/deploy) (PostgreSQL required for keys, teams and spend tracking, retrieved 2026-11-04)
