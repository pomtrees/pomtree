# Extending pomtree

pomtree aims to be a small core that solves the hard safety problems once (fencing, budgets, reaping, credential custody, approvals) and forces the operator to make the remaining safety decisions explicitly, while users bring workflows, agent templates, adapters and, eventually, dashboards. This page is the single place that says which extension points exist, how far each is actually wired, and what is only proposed. It does not claim more pluggability than the code has. The design is [`SPEC.md`](../SPEC.md); the decisions an operator must make are listed in [`safety-decisions.md`](safety-decisions.md); contributor guidance is in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## 1. What can and cannot be changed

Three tiers govern every extension point.

**Framework-owned invariants** are not pluggable, and no extension, adapter or policy may weaken them: generation fencing, the agent lifecycle state machine (`LEGAL_TRANSITIONS` in `packages/core/src/ports.ts`), mandatory reaping, nested budget conservation, idempotency keys on every mutating call, the append-only journal, credential non-exposure (agents never hold provider keys), and the operator-rank emergency cancel, which is exempt from rate limits and chat-approval gating (`packages/pomtreed/src/channels.ts`). The rules are in [`SPEC.md`](../SPEC.md), "Design rules that keep distribution open" and the lifecycle sections. An extension point that could break one of these is, by design, not offered.

**Pluggable policy and backends** are the choices a deployment may legitimately vary: which sandbox, harness or store realizes a port, which channels carry human messages, which templates exist, what the operator allows. Some of these are real seams (Section 2), some are interfaces only (Section 3), and some are proposed (Section 4).

**User-supplied content** is what users write against the stable contracts: agent templates, workflows, extensions, adapter processes. This is where the framework is genuinely open.

## 2. Seams that work end to end

Each item here can be used without editing the repository.

**Agent templates.** A template is a JSON file in `templates.dir` (`POMTREED_TEMPLATES_DIR`), named by its file stem, loaded by `DirTemplateStore` in `packages/template-dir`. Its shape is `Template` in `packages/core/src/types.ts`, including an optional `disposition` (`hold` or `reap-on-exit`, with an optional TTL on `hold`) that sets what happens to the results of agents spawned from it; a spawn request overrides it. The loader validates strictly: images must be digest-pinned, the agent-side `extensions` list is a closed set (`KNOWN_EXTENSIONS`: `web_search`, `web_fetch`), and `allowlist` must be one of `ALLOWLIST_PROFILES` (`analyst`, `browse`, `specialist`). There is no template inheritance or composition, and a new tool profile is a core change, not a template. Examples: `examples/browse-agent`, `packages/template-dir/examples`. The `runtime` block is adapter-owned and opaque to core.

**Reviewed in-process workflows.** An extension registers a `WorkflowDef` (a pure `validate` plus a `run` handler) with `host.workflow`. The handler sees only the fenced `WorkflowRunContext` and the capabilities its definition declares in `WorkflowCapabilities` (`state`, `store`, `sharedStore`, `fetch`, `reports`, `ask`, `modelChildren`); an undeclared capability rejects. A workflow is launchable only when the operator opts in twice: lists the owning extension in `workflow.reviewedExtensions` and grants the driver its child templates in `workflow.templates` (`{"<ext>/<driver>": ["<template>"]}`). Neither defaults to anything, so a default install launches nothing. Trust is cooperative, not isolation: the handler runs in the daemon process and can reach ambient daemon code, so the declarations bound what a correct handler uses, not what a hostile one can do. Do not load workflow code you have not reviewed. Examples: `examples/hn-digest`.

**The extension host.** A file-loaded extension is a directory under `extensions.dir` with a `manifest.json` and an entry module whose default export is an `Extension` (`packages/core/src/extension.ts`). Through the `ExtensionHost` facade it can register `route` and `stream` handlers (served under `/v1/ext/<name>/`; only compiled-in builtins may register elsewhere), `verb` entries, `journalKind` validators (`ext.<name>.<kind>`), `onJournal` and `onSpawn` hooks, a `spawnSpec` transform, and workflows. The manifest must carry the exact `EXTENSION_API_VERSION`, a `capabilities` block and a `deps` list; anything not declared is denied by the facade, and a manifest missing any of these refuses that extension at load. The facade's `deps` give registry and journal reads, keyed `record` and `deliver`, and named credentials. The `store` dependency admits only `{"name":"state"}`. An optional `provides` list declares the components the extension contributes besides its own entry; only `{"kind":"sandbox","id","entry","portVersion"}` (with optional `params`, `credentials` and `deps`) is accepted, and any other kind refuses the extension at load with a message naming the kind. First-party sandbox backends are built into the host and declare no `provides`. The built-in reports, cron and observe components are extensions of the same shape.

**Extension configuration.** Keys declared in `manifest.json` `params` become registry keys `ext.<segment>.<key>` (`hn-digest` is `hnDigest`) with the same layers, bounds, relations and env names (`POMTREED_EXT_<NAME>_<KEY>`) as core keys, and an unknown key refuses startup. The extension reads them, frozen, from `host.config`.

**Messaging adapters over HTTP.** An adapter is a separate process that talks to pomtreed only through the host-token HTTP routes, with the wire types and `MESSAGING_API_VERSION` defined once in `packages/core/src/messaging.ts`. Section 2.1 walks through it. Two adapters exist, both passing the wire-contract suite: Discord (`packages/messaging-discord`, never verified against live Discord; its README lists the manual check) and a terminal adapter, `packages/messaging-stdio`, the minimal reference (no third-party dependencies, type-only imports of `@pomtree/core`); adding it needed no change to core or pomtreed.

Two limits apply to the whole list. Extension and workflow code is loaded at boot only. `manifest.remote` is parsed but nothing reads it, so every extension runs in-process. And `deps.authorize` denies every action because `EXTENSION_ACTIONS` is empty, so an extension cannot route a decision through the approval ladder. Known gap: asks bubble through the ancestor chain, but approvals bubble through agents only for budget raises; every other approval kind goes to the operator, then the owner.

### 2.1 Worked path: adding a messaging adapter

No pomtreed source change is needed; a channel name is data.

1. Write the adapter as its own process. Import the wire types from `@pomtree/core` type-only (`InboundMessage`, `OutboxEntry`, `MessageFailedBody`, `MessageReceipt`, the host read bodies), pin `MESSAGING_API_VERSION`, and refuse any response whose `x-pomtree-messaging-api` header differs. `packages/messaging-discord/src/client.ts` is the reference for a full client, `packages/messaging-stdio` for the smallest one.
2. Use only these routes with the host token: `GET /v1/messages?channel=&from=` (outbox), `POST /v1/messages` (answers and commands, keyed by `idempotencyKey`), `POST /v1/messages/failed`, and the `/v1/host/agents` read routes.
3. The operator names the channel in `messaging.channels` and, to receive asks and alerts, `escalation.channels`. Names may use letters, digits, `-` and `_`; `cli`, `operator` and `ui` are reserved. pomtreed then issues `messaging.<name>.token` in the state dir, scoped to that channel, and the adapter reads it.
4. The operator enables the host endpoint (`host.listen`) and sets `POMTREED_MESSAGING_SENDERS=<channel>:<sender>,...`. With a chat-rank channel enabled and no sender list, pomtreed refuses to start (`messagingSendersError`). The adapter's own allowlist does not satisfy this.
5. Testing: run `messagingWireSuite(adapter, daemon)` from `@pomtree/testing` against the real pomtreed (in this repo, `packages/e2e/src/messaging-wire-contract.test.ts` does so for both adapters, and `stubWireAdapter` supplies negative controls), and keep offline fakes of the chat platform inside the adapter package, as Discord does. The suite tests the wire client, not an adapter's chat-identity mapping.

An adapter has chat rank only. It cannot claim operator rank, which is a property of the channel entry and is never given to an adapter.

### 2.2 Worked path: adding a non-panel extension or workflow

1. Create `<extensions.dir>/<name>/manifest.json` with `apiVersion: 2`, `name`, `entry`, `capabilities` and `deps` (use `{}` and `[]` to declare nothing), plus optional `params` and `credentials`. Copy `examples/hn-digest/manifest.json` as a model.
2. Export an `Extension` as the default from the entry module. Register in `init(host)`; registration after `init` settles throws.
3. Declare only what you register: `routes` for `host.route` and `host.stream`, `verbs`, `journalKinds`, `hooks.journal`, `hooks.spawn`. Workflows need no flag. A mutating route (POST, PUT or DELETE) is reached only with an idempotency key, the body field `idempotencyKey` or `?key=` on a bodyless or raw-body call; pomtreed refuses a call without one with a 400 before your handler runs (`extensionKeyMissing` in `packages/pomtreed/src/error-codes.ts`), so read the key and dedupe on it.
4. For a workflow, add `workflow.reviewedExtensions` and `workflow.templates` entries, create the templates it may spawn, then launch with `pomtree workflow launch <ext>/<name> --input JSON`.
5. Verbs are published at `GET /v1/ext/commands`. Whether `pomtree` dispatches them as commands is not specified here.

A dashboard panel is not on this path. Adding one needs a core change (Section 4, item 4).

## 3. Interfaces that exist but are hardwired

A port in `packages/core/src/ports.ts` is a clean TypeScript interface, but the daemon's wiring file, `packages/pomtreed/src/main.ts`, imports one concrete implementation of each, and that file is described in its header as the only non-test file that imports real adapters. There is no registry, config key or plugin point that selects an alternative. "Bring your own" for any item below therefore means forking `main.ts`, and for some it means more. The table lists what `main.ts` constructs and where the implementation leaks beyond the port.

| Port | Hardwired implementation | Leak or caveat |
| --- | --- | --- |
| `Sandbox` | `DockerSandbox` (`makeSandbox` in `main.ts`) | Docker-specific config keys (`agent.egressProxyImage`, `sandbox.socket`) reach the daemon; `Template.runtime` is Docker-shaped in practice |
| `Workspace`, `RepoStore` | `GitWorkspace`, `GitRepoStore` | The mirror, bundle ingest and publish flow assume git |
| `Harness` | `createPiHarness` | `harness-argv.ts`, `pi-auth.ts`, `model-catalog.ts` and `pi.*` config keys in `pomtreed` name Pi; the `HarnessEvent` set is normalized, the startup path is not |
| Stores (registry, journal, mailbox, escalations, approvals, schedules and others) | SQLite via `openDaemonStore`, `openStateStore` | The SQLite-backed ports are test seams, not extension points (fakes are in `@pomtree/testing`); `DirReportStore` and `DirTemplateStore` are likewise constructed directly |
| `Orchestrator` | `LocalOrchestrator` (constructed in `main.ts`) | The port stays, but there is no second implementation and no selector |
| `ModelGateway` and model proxy | `ProxyCredentialGateway`, `ModelProxy` | Internal; the debit and revocation store is shared with the proxy server |
| `ExtensionGateway` | `createExtGateway` | Fixed set of agent tools (`web_search`, `web_fetch`) |
| Operator UI | `renderUiShell` in `packages/pomtreed/src/ui.ts` | A fixed set of tabs is hardcoded against `@pomtree/observe`; there is no pane API, and an extension can only serve its own route |

`@pomtree/testing` holds shared contract bodies (`packages/testing/src/port-contracts.ts`, plus `merge-contract.ts`) for several ports: registry, journal, quota counters, capture index, template store, model gateway, harness, placement, watchdog, session and state stores, and merge store. They run against the fakes and, for the store ports, against real SQLite. They are not packaged as a suite a third-party implementation is required to pass, and the `Sandbox` contract (`sandboxContractBody`) runs against the fake always and against `DockerSandbox` in `packages/sandbox-docker/src/sandbox-contract.test.ts` only when `PTREE_DOCKER_TESTS=1` (Docker-gated, so skipped in `pnpm test:lite`). There is no equivalent shared contract for `Workspace`, `RepoStore` or `Orchestrator`.

Multi-host operation is future work. `local-node.ts` is the in-process single node and there is no `pomtreed-node` package, so a second `Sandbox` or `Placement` implementation would have no node to run in.

## 4. Proposed seams, not built (future work)

Ranked by leverage. Each has a one-line contract and the precedent it follows. None of these exists; none should be depended on.

1. **Adapter provider registry.** `{kind, name, apiVersion, create(config, deps)}`, selected by config instead of imports in `main.ts`, with each kind carrying a required conformance suite in `@pomtree/testing`. It would turn the table in Section 3 from "fork `main.ts`" into "register a provider". Precedent: Terraform providers and OpenTelemetry collector component factories.
2. **`HarnessDriver`.** A driver owns argv, credential staging, catalog and event normalization, so the daemon never names Pi. Today these live in `harness-argv.ts`, `pi-auth.ts` and `model-catalog.ts`. Pi is pinned deliberately (the daemon targets only the latest Pi, the version pinned in `packages/agent-image/scripts/build.ts`), so this would be a decision to reopen, not an oversight.
3. **`AdmissionPolicy` and `LifecyclePolicy`.** `AdmissionPolicy` is a validating-only chain on spawn, launch, egress and approval that returns allow, deny or escalate, and can never widen authority or budget. Precedent: Kubernetes validating admission after mutating admission. `LifecyclePolicy` would choose `onOrphan`, zombie disposition, retention and the escalation ladder per template from options the framework offers, never from arbitrary code (`onOrphan` would replace the current behavior of cancelling every live child; zombie disposition is built as `ResultDisposition`, see [`safety-decisions.md`](safety-decisions.md)).
4. **`UiPane`.** `host.pane`, served from a sandboxed origin with escaping enforced by the host rather than by each pane. This is gated on an open XSS risk: agent-controlled text already reaches the operator UI with operator scope (a known gap; keep the UI off or localhost-only for unattended runs), so a pane API before that is resolved would widen the exposure. Precedent: VS Code webviews and Grafana panel plugins.
5. **Remote extension transport.** The same host-token HTTP boundary messaging adapters use, so an extension can run out of process and `manifest.remote` means something. Precedent: Terraform's out-of-process provider protocol.

6. **Installable Discord and model-provider extensions.** Discord (messaging) and the OpenAI and Anthropic model providers would become individually installable extensions, and OpenRouter would remain a non-mandatory default. They would be the first consumers of the provider registry (item 1) and the extension model, which is why item 1 should land first. Not built; future work. Current behavior: Discord is the in-repo `packages/messaging-discord` adapter and has not been run against live Discord; the agent path has been run against DeepSeek and OpenRouter (results for a release commit are recorded in [`validation.md`](validation.md)), and other model providers have not been run.

Item 1 is the highest leverage because it applies to every port and costs no new capability. Items 3 to 5 add authority-bearing surface and need the safety work in [`safety-decisions.md`](safety-decisions.md) first.
