# Configuration

Every daemon and `pomtree` client setting is a key in a typed registry. Names, kinds, defaults, bounds and one-line descriptions live in the registry source, `packages/core/src/config/params-daemon.ts` (and `params.ts`, `params-client.ts`), and **Parameter reference** below is generated from it (`pnpm gen:config`; a test fails when it is stale), so the prose in this section does not restate them. `packages/core/config.schema.json` is the JSON Schema generated from it, for editor completion and validation of a config file.

**Precedence**, lowest to highest: the key's default, a JSON config file (`$POMTREED_CONFIG` or `--config PATH`), environment variables, then repeatable `--set key=value` flags. The first three layers are set once at start; a change needs a restart. Every value is validated strictly at startup: an unknown key, a malformed or out-of-bounds value, or a violated relation between two keys refuses to start with a message naming the key and the layer it came from. An unknown or misspelled environment variable name is refused, with a "did you mean" hint where a near name exists and the action `remove it, or use a name listed in docs/configuration.md`, rather than silently ignored. An unknown key in a config file or `--set` is also refused, but its message says only `unknown key ...` with no action.

**Naming rule.** A key's path is `concern.camelCaseName` (for example `report.maxBytes`). Its environment variable is the path in `SNAKE_CASE` with the `POMTREED_` prefix (`POMTREED_REPORT_MAX_BYTES`); client keys use `POMTREE_` (`POMTREE_CLIENT_DEBUG`). Milliseconds, bytes and micro-dollars (µ$; 1,000,000 = $1.00) are plain integers, and the unit is in the name (`_MS`, `_BYTES`, `_MICROS`). Keys an extension contributes live under the root namespace `ext` (see **Extension keys**).

**Extension keys.** An extension declares its own keys statically in its `manifest.json` (which also requires `apiVersion`, exactly the host's `EXTENSION_API_VERSION` from `core`, and the `capabilities` and `deps` blocks, outside which every operation is denied; a missing or mismatched `apiVersion` refuses the extension at load, and the flag map is in the extension section of `SPEC.md`) as a `params` array (JSON only, no code runs to read it): each entry has `key` (flat camelCase), `kind` (`bytes`, `count`, `ms`, `micros`, `ratio`, `bool`, `enum`, `string` or `list`), `doc`, `default`, and the kind's `min`, `max`, `values`, `ceiling` and `relations`; `ceiling` and relation `key`s name the extension's own keys bare and core keys by path (`report.maxBytes`). A key resolves as `ext.<segment>.<key>`, where `<segment>` is the camelCase of the extension name (`hn-digest` is `hnDigest`; two names with the same segment are refused), with the same layers, origins, bounds and relations as a core key and the derived variable `POMTREED_EXT_<NAME>_<KEY>` (for `hn-digest` and `maxCount`: `POMTREED_EXT_HN_DIGEST_MAX_COUNT`). Key and credential env names share one prefix, `POMTREED_EXT_<NAME>_`, derived from the camelCase segment (`a-1b` has segment `a1b`, so `POMTREED_EXT_A1B_`). An extension that declares neither params nor credentials owns no `ext.<segment>.` keys and needs no valid or unique segment. Extension keys are operator-scoped, host-side only (never delivered to containers) and never sensitive: secrets go through `manifest.credentials`, whose names are readable only when declared, from `POMTREED_EXT_<NAME>_<CRED>` or `<extensions dir>/<name>/credentials.<cred>`. The daemon scans the manifests under `extensions.dir` before it resolves, so only extensions present on disk own names: a key in the file or `--set`, or a `POMTREED_EXT_*` variable, that no present extension's manifest declares (an unloaded extension, a typo, an undeclared credential) refuses to start; when such a name has no owner and a manifest was refused, startup also prints `extension manifest not loaded: <dir>: <reason>`. A bad `params` declaration also refuses to start, naming the extension and key. An extension reads its resolved values through `host.config` (its own keys plus the non-sensitive core keys, frozen). The checked-in `config.schema.json` describes core keys and leaves the `ext` subtree open, since the extensions present are known only at start. The worked example is `examples/hn-digest`: its keys (`ext.hnDigest.*`) are declared in `manifest.json` and mirrored in `params.mts`, and its old core names (`POMTREED_ARTICLE_*`, `POMTREED_DIGEST_REPORT_MAX_BYTES`) are refused. They get a "was renamed to" hint only while the `hn-digest` extension is present in `extensions.dir`, because the renames are declared in its manifest (`renamedFrom`); without it the resolver reports a plain "unknown env ... did you mean".

**Inspecting.** `pomtreed config show` prints the effective configuration (extension keys included); `--origin` adds which layer (default, file, env, `--set`) supplied each value, and `--json` prints it machine-readably. Secrets are masked.

**Secrets.** A sensitive key is never read from the JSON file, a plain environment variable or `--set`. Write the value to a file (mode 0600, owned by the daemon user) and set `<ENV>_FILE` to its path: the upstream model key is `POMTREED_MODEL_UPSTREAM_KEY_FILE` and the search key is `POMTREED_SEARCH_KEY_FILE`. The proxy holds the upstream key and issues each agent a short-lived scoped token; agents never see it.

Operator guidance the registry descriptions cannot carry:

- **Required to start.** `POMTREED_MODEL_BASE_URL`, `POMTREED_MODEL_UPSTREAM_KEY_FILE`, and `POMTREED_PI_PROVIDER` (the provider the proxy serves). pomtreed never reads a Pi login file. The daemon always runs the model proxy and refuses to start without these. It also refuses to start while `POMTREED_AGENT_EGRESS_PROXY_IMAGE`, `POMTREED_AGENT_UNTEMPLATED_EGRESS` or `POMTREED_EXTENSIONS_APPROVAL` is unset; the forced decisions are listed in [Safety decisions](safety-decisions.md#class-2-decisions-the-framework-forces) and starter values are in `deploy/pomtreed.env.example`. `web_search` and `web_fetch` are proxied through the daemon (`POMTREED_SEARCH_PROVIDER`, `POMTREED_SEARCH_KEY_FILE`).
- **Locations.** `POMTREED_STATE_DIR` holds the database, secret, token, mirror, workspaces, sessions and templates. `POMTREED_REPO_DIR` is the repository workspaces are cut from.
- **Agent image.** Pin `POMTREED_AGENT_IMAGE` by digest in a service install so the daemon and the `pomtree` baked into the image cannot skew.
- **Listeners.** `POMTREED_AGENT_LISTEN`, `POMTREED_UI_LISTEN` and `POMTREED_HOST_LISTEN` take `host:port` (IPv6 as `[::1]:8787`) or `off`, and are parsed strictly. A non-loopback UI or host bind is refused unless `POMTREED_LISTEN_ALLOW_NONLOOPBACK` is on, because those listeners speak plain HTTP; an explicit agent endpoint host other than loopback or the detected docker bridge gateway is refused the same way. `pomtree doctor` shows the bound agent address.
- **Capacity.** `POMTREED_CAPACITY_MAX_SESSIONS` is `auto` or a positive integer. `auto` is computed once at startup from CPUs and RAM and clamped to a ceiling that reflects provider rate limits and spend, not machine capacity; an explicit integer bypasses it. `pomtree doctor` shows the result, and queued agents show why in `pomtree ps`/`show`.
- **Budgets.** `POMTREED_BUDGET_ROOT_MICROS` is the root pool; operator-spawned top-level agents are carved from it (`POMTREED_BUDGET_TOP_LEVEL_MICROS` each), and an agent-spawned child that omits a budget is carved `POMTREED_BUDGET_DEFAULT_MICROS`, capped at its parent's remainder.
- **Access log.** `POMTREED_ACCESS_LOG_MODE` also covers the model proxy (one line per proxied request: agent id, model, upstream status, charged micros, duration). It never logs headers, keys, tokens or bodies.
- **Messaging.** `POMTREED_MESSAGING_CHANNELS` names the host adapters and `POMTREED_ESCALATION_CHANNELS` the ordered channels root broadcasts user-bound messages to (`ui` is the operator UI Inbox and needs no host token; a custom list replaces the default, e.g. `discord,ui`). `POMTREED_MESSAGING_SENDERS` (comma-separated `channel:sender`) is mandatory when any chat channel other than `ui` is enabled: pomtreed refuses to start without it. Operator-rank routes (the operator token, the UI session) are not checked against it; never give the operator token to an adapter. With the default `ui` channel, `POMTREED_EXTENSIONS_APPROVAL=all` makes approvals wait in the UI Inbox even when the UI listener is off.
- **Workflows.** Enabling one is an explicit opt-in, described under Workflows in [Commands in depth](operating.md#commands-in-depth). `POMTREED_WORKFLOW_TEMPLATES` is a JSON object mapping a qualified driver to an array of template IDs.
- **Merge and publish.** `POMTREED_MERGE_CHECK` has no check runner wired yet, so pomtreed refuses to start while it is set; leave it unset. `POMTREED_PUBLISH_TARGETS` lists the `remote/branch` pairs the daemon may push to; the default is none.
- **Model proxy.** An extra path in `POMTREED_MODEL_PROXY_EXTRA_PATHS` is not in the per-endpoint table, so it must name one of the output-limit fields (`max_tokens`, `max_completion_tokens`, `max_output_tokens`); a path with no output limit (e.g. `/embeddings`) is refused. The proxy's per-credential cap charges the provider-reported `usage.cost` when the upstream returns it, else prices tokens from Pi's per-provider catalog (`POMTREED_PI_CATALOG_DIR`; found from the `pi` binary for the pinned Pi release when unset).
- **Per-agent state.** `POMTREED_STATE_GRANTS` (owner, optional prefix, mode `r` or `rw` per agent; default deny) and `POMTREED_STATE_LIMITS` are JSON values; see [`docs/state.md`](state.md).

Not in the registry, read as before (each is owned by its adapter or is access control, not a daemon parameter). The `POMTREED_`, `POMTREE_` and `PTREE_` names that are deliberately not parameters (including `POMTREED_MESSAGING_SENDERS`, `POMTREED_MESSAGING_TOKEN` and `POMTREED_URL`) are listed with their reasons at the end of **Parameter reference**; the Discord adapter's own variables:

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, `DISCORD_ALLOWED_SENDERS` | Discord adapter: bot token, channel, allowed sender ids |
| `DISCORD_CURSOR_FILE`, `DISCORD_PAIRINGS_FILE`, `DISCORD_POLL_INTERVAL_MS` | Discord adapter: outbox state file (the outbox seq cursor, send attempts and dead letters; the inbound message cursor is in memory and not persisted), approved `!pair` ids file (read at startup only; restart after hand edits), outbox poll interval (inbound messages and button presses arrive over the Discord Gateway) |
| `DISCORD_PASS_BUTTON` | Discord adapter: `1` adds a Pass button to asks (off by default) |
| `MESSAGING_STDIO_SENDER`, `MESSAGING_STDIO_CHANNEL`, `MESSAGING_STDIO_POLL_MS` | Terminal adapter (`packages/messaging-stdio`): your sender id (required; it must also be on `POMTREED_MESSAGING_SENDERS` as `<channel>:<id>`), the channel name (default `stdio`), and the outbox poll interval in milliseconds (default 1000). It also reads `POMTREED_URL` and `POMTREED_MESSAGING_TOKEN` (the path to its host token file) |
| `DISCORD_AGENT_ALLOWLISTS` | Discord adapter: JSON object mapping agent id to the sender ids allowed to answer it |
| `POMTREED_EXT_<NAME>_<CRED>` | Per-extension credentials, readable only for names the extension's `manifest.credentials` declares; any undeclared `POMTREED_EXT_*` name is refused at start (see **Extension keys**) |

**Choosing a model.** pomtreed lists the models Pi can use by running `pi --list-models` on the host (cached 60s; an empty list with a reason if Pi can't list them). `GET /v1/models` (operator) returns them; `pomtree models` prints them with the resolved default starred; `pomtree spawn --model provider/id` and the UI's New agent form pick one per agent (the form remembers your last choice in `localStorage` key `pomtree.lastModel`). A spawn that names no model gets the template, parent or daemon-level model, else Pi's own configured default (`defaultProvider`/`defaultModel` in its `settings.json`) if the provider lists it, else the first model Pi lists for the provider, else an error telling you to pass `--model provider/id` (see `pomtree models`).

Client side, `pomtree` reads `POMTREED_STATE_DIR`, `POMTREE_SOCKET`, `POMTREE_TOKEN`, and `POMTREE_API` (and
`POMTREE_CLIENT_DEBUG=1` to print stack traces); these are
not the daemon-side socket variable, so setting `POMTREED_SOCKET_PATH` does not configure the client.

Tests and demos: `PTREE_DOCKER_TESTS=1` enables the Docker-gated suites and `PTREE_E2E_IMAGE`
names the image the end-to-end tests use (see [Getting started](../README.md#getting-started)). The scripts in `packages/e2e/src/demo/`
are live demos that make real model calls and spend real money. Each refuses to run without
`POMTREED_LIVE=1`, is bounded by `POMTREED_DEMO_TIMEOUT_MS` (default 600000), takes its tree cap from
`POMTREED_BUDGET_ROOT_MICROS`, and reads `POMTREED_PI_PROVIDER` and
`POMTREED_AGENT_IMAGE`. They reach the model through the same key-issuing proxy as the daemon
(`packages/e2e/src/live-model.ts`), so they also need `POMTREED_MODEL_BASE_URL` and `POMTREED_MODEL_UPSTREAM_KEY_FILE` (a path to a 0600 file holding the key). The
Docker-gated `docker-pi` test takes the same upstream as `PTREE_E2E_MODEL_BASE_URL` and the same key file,
`POMTREED_MODEL_UPSTREAM_KEY_FILE` (the key itself is never an environment variable; see **Secrets** under [Configuration](#configuration)), and skips with a reason when either is unset. To run the key-requiring live tests in one go, use `scripts/run-e2e-tests.sh --model deepseek/deepseek-flash` (it passes the key file's path on, never its contents, and spends real money). Run one directly, e.g. `POMTREED_LIVE=1 node packages/e2e/src/demo/yield-resume.ts`:

- `chapters.ts`: a root agent drafts a book chapter by spawning two helpers.
- `report.ts`: a root agent writes a markdown file and publishes it as a report.
- `pi-ext.ts`: a root agent calls the `web_fetch` extension against a live page.
- `yield-resume.ts`: a live interactive Pi container is yielded and resumed twice, with a fresh key and a new container each time.

## Parameter reference

Generated; edit the registry, not these tables.

<!-- BEGIN GENERATED: config-reference (pnpm gen:config; do not edit by hand) -->

#### Core keys

Generated from the registry. Kinds `bytes`, `count`, `ms` and `micros` are plain non-negative integers in that unit; `ratio` is a number from 0 to 1. A value above its ceiling or violating a relation is refused, never clamped. A secret key is supplied only through the `_FILE` variable shown. `container` marks a key delivered to agent containers.

##### `report`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `report.maxBytes` | `POMTREED_REPORT_MAX_BYTES` | bytes | `8388608` | min 1 | operator | Cap on one agent report body (POST /v1/agents/self/reports). |
| `report.workflowMaxBytes` | `POMTREED_REPORT_WORKFLOW_MAX_BYTES` | bytes | `262144` | min 1; <= `report.maxBytes` | operator | Ceiling on one workflow-capability report and fetch. |
| `report.dir` | `POMTREED_REPORT_DIR` | path | unset | absolute | operator | Where agent reports are stored. Unset: <state.dir>/reports. |

##### `push`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `push.maxBytes` | `POMTREED_PUSH_MAX_BYTES` | bytes | `268435456` | min 1 | operator | Cap on one agent push body (POST /v1/agents/:id/push) and on one result-save bundle. |

##### `budget`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `budget.rootMicros` | `POMTREED_BUDGET_ROOT_MICROS` | micros | `10000000` |  | operator | The root budget pool that top-level agents are carved from. |
| `budget.topLevelMicros` | `POMTREED_BUDGET_TOP_LEVEL_MICROS` | micros | `5000000` | min 1; <= `budget.rootMicros` (ceiling) | run | Budget carved for a top-level (operator) spawn that names none. |
| `budget.defaultMicros` | `POMTREED_BUDGET_DEFAULT_MICROS` | micros | `1000000` | min 1; <= `budget.topLevelMicros` | run | Budget carved for an agent-spawned child that names none. |
| `budget.raiseMs` | `POMTREED_BUDGET_RAISE_MS` | ms | `86400000` | min 1 | operator | Per-rung window of a human rung on a budget_raise approval. |
| `budget.raisePct` | `POMTREED_BUDGET_RAISE_PCT` | count | `50` | min 1 | operator | Requested budget raise, as a percent of the agent's original budget. |

##### `model`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `model.upstreamKey` | `POMTREED_MODEL_UPSTREAM_KEY_FILE` (secret) | string | unset |  | operator | The model proxy's upstream API key. |
| `model.baseUrl` | `POMTREED_MODEL_BASE_URL` | string | unset |  | operator | The model provider's upstream base URL. Required: pomtreed refuses to start without it. |
| `model.upstreamTimeoutMs` | `POMTREED_MODEL_UPSTREAM_TIMEOUT_MS` | ms | `120000` | min 1 | operator | Upstream request timeout of the model proxy; also the stale-reservation reclaim age. |
| `model.proxy.port` | `POMTREED_MODEL_PROXY_PORT` | count | `18080` | min 1; max 65535 | operator | Model proxy TCP port. |
| `model.proxy.ttlMs` | `POMTREED_MODEL_PROXY_TTL_MS` | ms | `3600000` | min 1 | operator | Lifetime of the scoped model-proxy key issued when a container starts. |
| `model.proxy.maxRequestMicros` | `POMTREED_MODEL_PROXY_MAX_REQUEST_MICROS` | micros | `50000` | min 1 | operator | Reserved (and charged when cost cannot be read) per request to a model missing from the catalog. Not a per-request ceiling. |
| `model.proxy.extraPaths` | `POMTREED_MODEL_PROXY_EXTRA_PATHS` | list | none |  | operator | Upstream paths the proxy allows beyond its default allowlist. |

##### `browser`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `browser.capture.maxBytesCeiling` | `POMTREED_BROWSER_CAPTURE_MAX_BYTES_CEILING` | bytes | `1048576` | min 1; <= `browser.capture.rawAllocationMaxBytes`; <= `report.maxBytes` | operator, container | Ceiling on the maxBytes a browser_capture call may request (raw body and rendered DOM). |
| `browser.capture.rawAllocationMaxBytes` | `POMTREED_BROWSER_CAPTURE_RAW_ALLOCATION_MAX_BYTES` | bytes | `8388608` | min 1; <= `capacity.containerMemoryBytes` | operator, container | Largest declared main response a capture buffers at all (Playwright reads the whole entity); beyond it nothing is read. |
| `browser.capture.textMaxBytes` | `POMTREED_BROWSER_CAPTURE_TEXT_MAX_BYTES` | bytes | `1048576` | min 1; <= `report.maxBytes` | operator, container | UTF-8 bytes of mechanical page text a capture stores whole as one retained report (the digest's analyst reads it in pages); text beyond it is clipped and marked truncated. |
| `browser.capture.screenshotMaxBytes` | `POMTREED_BROWSER_CAPTURE_SCREENSHOT_MAX_BYTES` | bytes | `1048576` | min 1; <= `report.maxBytes` | operator, container | Largest capture screenshot PNG; a larger one is retaken smaller, never truncated. |
| `browser.capture.deadlineMinMs` | `POMTREED_BROWSER_CAPTURE_DEADLINE_MIN_MS` | ms | `1000` | min 1; < `browser.capture.deadlineMaxMs` | operator, container | Smallest deadline a browser_capture call may request. |
| `browser.capture.deadlineMaxMs` | `POMTREED_BROWSER_CAPTURE_DEADLINE_MAX_MS` | ms | `120000` | min 1 | operator, container | Largest deadline a browser_capture call may request. |

##### `state`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `state.dir` | `POMTREED_STATE_DIR` | path | unset | absolute | operator | The daemon's state directory (store, tokens, socket). Unset: ~/.pomtreed. The pomtree client reads it to find the socket and operator token. |
| `state.grants` | `POMTREED_STATE_GRANTS` | json | `{}` |  | operator | State-store grants: {"<driver or template id>": [{owner, prefix?, mode: "r"\|"rw"}]}. Parsed by pomtreed parseStateGrants. |
| `state.limits` | `POMTREED_STATE_LIMITS` | json | `{}` |  | operator | State-store quotas: {default?: Limits, owners?: {name: Limits}}; unset fields inherit STATE_LIMITS_DEFAULT. Parsed by core parseStateLimits. |

##### `templates`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `templates.dir` | `POMTREED_TEMPLATES_DIR` | path | unset | absolute | operator | Agent template directory. Unset: <state.dir>/templates. |

##### `session`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `session.dir` | `POMTREED_SESSION_DIR` | path | unset | absolute | operator | Root of the per-agent Pi session directories. Unset: <state.dir>/sessions. |
| `session.maxMs` | `POMTREED_SESSION_MAX_MS` | ms | `14400000` | min 1; <= `agent.tokenTtlMs` | operator | Longest session a spawn may request. |
| `session.defaultMs` | `POMTREED_SESSION_DEFAULT_MS` | ms | `14400000` | min 1; <= `session.maxMs` (ceiling) | run | Session length of a spawn that names none. |

##### `envCache`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `envCache.dir` | `POMTREED_ENV_CACHE_DIR` | path | unset | absolute | operator | Environment layer cache (<dir>/<manifestHash>). Unset: <state.dir>/env-cache. |

##### `extensions`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `extensions.dir` | `POMTREED_EXTENSIONS_DIR` | path | unset | absolute | operator | Extension host directory (realpathed at start). Unset: <state.dir>/extensions. |
| `extensions.approval` | `POMTREED_EXTENSIONS_APPROVAL` | string | unset |  | operator | Extensions whose gated actions need an approval: none, all, or a comma list of extension names. Required: pomtreed refuses to start while it is unset. |

##### `socket`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `socket.path` | `POMTREED_SOCKET_PATH` | path | unset | absolute | operator | The daemon's operator unix socket. Unset: <state.dir>/pomtreed.sock (shortened when over the OS path limit). Clients use POMTREE_SOCKET. |

##### `sandbox`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `sandbox.socket` | `POMTREED_SANDBOX_SOCKET` | path | `/run/pomtreed.sock` | absolute | operator | The daemon socket's path inside an agent container. |

##### `agent`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `agent.listen` | `POMTREED_AGENT_LISTEN` | string | unset |  | operator | Agent endpoint listener, host:port ([::1]:0 for IPv6; port 0 = ephemeral) or off. Unset: Linux binds the docker bridge gateway plus loopback, elsewhere 127.0.0.1:0. An explicit host other than loopback or the detected docker bridge gateway needs listen.allowNonloopback. Parsed by pomtreed parseListen. |
| `agent.probe` | `POMTREED_AGENT_PROBE` | bool | `true` |  | operator | On Linux with the gateway plan, prove agent-endpoint reachability from a real container at start. |
| `agent.image` | `POMTREED_AGENT_IMAGE` | string | `pomtree/agent:dev` |  | operator | The agent container image. |
| `agent.egressProxyImage` | `POMTREED_AGENT_EGRESS_PROXY_IMAGE` | string | unset |  | operator | The digest-pinned image the per-agent egress-proxy sidecar runs for every container spawn (name[:tag]@sha256:<64 hex>, or a local image id sha256:<64 hex>, e.g. the agent image's id from docker image inspect --format '{{.Id}}'), checked with docker image inspect before each sidecar starts. Required: pomtreed refuses to start while it is unset. |
| `agent.untemplatedEgress` | `POMTREED_AGENT_UNTEMPLATED_EGRESS` | string | unset |  | operator | Egress of a spawn that names no template (the built-in code template): registry (the model proxy and the package registries only; use this for a first run) or none (no network at all: an untemplated agent cannot reach the model proxy, so its model calls fail; pomtreed warns at start). Required: pomtreed refuses to start while it is unset. |
| `agent.tokenTtlMs` | `POMTREED_AGENT_TOKEN_TTL_MS` | ms | `86400000` | min 1 | operator | Lifetime of the agent API token issued when a container starts. |
| `agent.maxDepth` | `POMTREED_AGENT_MAX_DEPTH` | count | `4` |  | operator | Deepest spawn depth allowed. The root supervisor is depth 0 and operator-spawned agents are depth 1; a spawn is refused when its depth exceeds this value, so 0 refuses all spawns and 1 permits only operator-spawned agents. |
| `agent.maxChildren` | `POMTREED_AGENT_MAX_CHILDREN` | count | `8` |  | operator | Unreaped children one non-root parent may hold. |
| `agent.zombieMs` | `POMTREED_AGENT_ZOMBIE_MS` | ms | `600000` | min 1 | operator | How long an exited agent may stay unreaped before the zombie sweep raises an alert; the sweep never reaps it. |
| `agent.zombieSweepMs` | `POMTREED_AGENT_ZOMBIE_SWEEP_MS` | ms | `30000` | min 1 | operator | Interval of the zombie sweep, which also applies `--ttl` expiry on held children. Lower it only to make tests deterministic. |
| `agent.reconcileSweepMs` | `POMTREED_AGENT_RECONCILE_SWEEP_MS` | ms | `30000` | min 1 | operator | Interval between reconcile passes (container and record drift, operator-token expiry). Lower it only to make tests deterministic. |
| `agent.rootCustodyMax` | `POMTREED_AGENT_ROOT_CUSTODY_MAX` | count | `32` | min 1 | operator | Exited results held for the operator because their parent chain is dead up to the root; past this many, each further delivery is also raised as an alert. Results are never dropped. |
| `agent.interruptGraceMs` | `POMTREED_AGENT_INTERRUPT_GRACE_MS` | ms | `5000` |  | operator | After an interrupt, how long Pi may take to exit before the container is killed. |
| `agent.adoptOrphans` | `POMTREED_AGENT_ADOPT_ORPHANS` | bool | `false` |  | operator | On start, adopt running agent containers this daemon has no record of. |

##### `ui`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `ui.listen` | `POMTREED_UI_LISTEN` | string | `off` |  | operator | Operator UI listener, host:port or off. Loopback only unless listen.allowNonloopback. Parsed by pomtreed parseListen. |

##### `host`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `host.listen` | `POMTREED_HOST_LISTEN` | string | `off` |  | operator | Host-read (adapter) listener, host:port or off. Loopback only unless listen.allowNonloopback. Parsed by pomtreed parseListen. |
| `host.id` | `POMTREED_HOST_ID` | string | unset |  | operator | This daemon's host id, stamped on every record. Unset: os.hostname(). |

##### `listen`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `listen.allowNonloopback` | `POMTREED_LISTEN_ALLOW_NONLOOPBACK` | bool | `false` |  | operator | Accept a non-loopback bind for the plain-HTTP UI and host listeners, and an agent listener on a host other than loopback or the docker bridge gateway (put TLS and auth in front). |

##### `readyz`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `readyz.allowSandboxDown` | `POMTREED_READYZ_ALLOW_SANDBOX_DOWN` | bool | `false` |  | operator | Report ready while the sandbox (Docker) is down. |

##### `accessLog`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `accessLog.mode` | `POMTREED_ACCESS_LOG_MODE` | enum | `auto` | `auto`, `off`, `errors`, `all` | operator | Access log on stdout, one line per request, for the daemon and the model proxy. auto: all on a TTY, else errors. |

##### `drain`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `drain.timeoutMs` | `POMTREED_DRAIN_TIMEOUT_MS` | ms | `10000` |  | operator | How long shutdown waits for in-flight work to drain. Keep below the service manager's stop timeout. |

##### `idempotency`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `idempotency.retentionMs` | `POMTREED_IDEMPOTENCY_RETENTION_MS` | ms | `2592000000` | min 1 | operator | How long idempotency records are kept. |

##### `audit`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `audit.spoolVacuumGraceMs` | `POMTREED_AUDIT_SPOOL_VACUUM_GRACE_MS` | ms | `86400000` | max 2592000000 | operator | How long after its sandbox closed an egress audit spool is kept before it is deleted, once every row is acknowledged and journaled (the journal is the record; the spool is the raw copy). 0 = delete as soon as eligible. Each spool counts against the spool retention cap (AUDIT_MAX_SPOOLS) until then. |

##### `journal`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `journal.retentionMs` | `POMTREED_JOURNAL_RETENTION_MS` | ms | `0` |  | operator | Journal pruning age; 0 = no pruning. |
| `journal.keepPerAgent` | `POMTREED_JOURNAL_KEEP_PER_AGENT` | count | `1000` |  | operator | Newest journal entries kept per agent when pruning (journal.retentionMs > 0). |

##### `folder`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `folder.retentionMs` | `POMTREED_FOLDER_RETENTION_MS` | ms | `604800000` |  | operator | Paused agents idle past this lose their folder; 0 = never. |
| `folder.reapedGraceMs` | `POMTREED_FOLDER_REAPED_GRACE_MS` | ms | `0` |  | operator | How long a reaped agent's folder is kept. |
| `folder.minFreeBytes` | `POMTREED_FOLDER_MIN_FREE_BYTES` | bytes | `0` |  | operator | Below this much free disk the cleanup sweep removes eligible folders early; 0 = off. |

##### `repo`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `repo.dir` | `POMTREED_REPO_DIR` | path | unset | absolute | operator | The operator's repository agents clone from and merge into. Unset: the daemon's working directory. |
| `repo.defaultBranch` | `POMTREED_REPO_DEFAULT_BRANCH` | string | unset |  | operator | The branch agents start from and merge into. Unset: the repository's HEAD branch, else main. |

##### `merge`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `merge.deny` | `POMTREED_MERGE_DENY` | list | `.github/workflows/,.github/actions/,.gitmodules` |  | operator | Repo-relative path prefixes a merge may not touch. Empty = no denylist. |
| `merge.check` | `POMTREED_MERGE_CHECK` | string | unset |  | operator | Whitespace-separated command a merge must pass; empty = merges run with no check. No check runner is wired in this build, so pomtreed refuses to start while it is set. |

##### `publish`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `publish.targets` | `POMTREED_PUBLISH_TARGETS` | list | none |  | operator | remote/branch targets the daemon may publish to (only the daemon pushes). |
| `publish.deny` | `POMTREED_PUBLISH_DENY` | list | `.github/workflows/,.github/actions/,.gitmodules` |  | operator | Repo-relative path prefixes a publish may not touch. Empty = no denylist. |
| `publish.scan` | `POMTREED_PUBLISH_SCAN` | bool | `true` |  | operator | Scan a publish for credentials, commit messages and CI-file additions before pushing. |

##### `harness`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `harness.steerExt` | `POMTREED_HARNESS_STEER_EXT` | bool | `true` |  | operator | Load the Pi mailbox (steer) extension, through which a waiting agent sees messages. |
| `harness.jobsExt` | `POMTREED_HARNESS_JOBS_EXT` | bool | `false` |  | operator | Load the opt-in, unverified Pi background-jobs extension. |

##### `wait`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `wait.yieldMs` | `POMTREED_WAIT_YIELD_MS` | ms | `20000` |  | operator, container | A pomtree wait/inbox/ask wait longer than this yields the agent's container instead of long-polling. pomtreed delivers it to agent containers, so the in-container pomtree long-polls exactly as long as the daemon allows. |

##### `capacity`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `capacity.maxSessions` | `POMTREED_CAPACITY_MAX_SESSIONS` | string | `auto` |  | operator | Concurrent session cap: auto (min(memoryFraction*RAM/containerMemoryBytes, cpus/2*3, maxContainers, 16), at least 2) or a positive integer, which bypasses the 16 cap. |
| `capacity.maxContainers` | `POMTREED_CAPACITY_MAX_CONTAINERS` | count | `32` | min 1 | operator | Container limit enforced by the resource gate; also bounds the auto session cap. |
| `capacity.containerMemoryBytes` | `POMTREED_CAPACITY_CONTAINER_MEMORY_BYTES` | bytes | `2147483648` | min 1 | operator | Memory limit of a container whose spec names none, and the per-running-container reservation the memory gate and the auto session cap plan for. |
| `capacity.memoryFraction` | `POMTREED_CAPACITY_MEMORY_FRACTION` | ratio | `0.9` | min 0.01; max 1 | operator | Fraction of host RAM the memory gate and the auto session cap may plan for. |
| `capacity.minDiskFreeBytes` | `POMTREED_CAPACITY_MIN_DISK_FREE_BYTES` | bytes | `1073741824` |  | operator | Free disk below which the resource gate refuses new sessions. |

##### `watchdog`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `watchdog.sweepMs` | `POMTREED_WATCHDOG_SWEEP_MS` | ms | `30000` | min 1 | operator | Watchdog sweep interval. |
| `watchdog.stallMs` | `POMTREED_WATCHDOG_STALL_MS` | ms | `600000` | min 1 | operator | Silence after which the watchdog judges an agent stalled. |
| `watchdog.blockedMs` | `POMTREED_WATCHDOG_BLOCKED_MS` | ms | `1800000` | min 1 | operator | Time blocked after which the watchdog acts. |
| `watchdog.intensityWindowMs` | `POMTREED_WATCHDOG_INTENSITY_WINDOW_MS` | ms | `3600000` | min 1 | operator | Window over which watchdog restart intensity is counted. |
| `watchdog.stableMs` | `POMTREED_WATCHDOG_STABLE_MS` | ms | `1800000` | min 1 | operator | Run time after which a restarted agent counts as stable again. |

##### `cron`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `cron.tickMs` | `POMTREED_CRON_TICK_MS` | ms | `60000` | min 1 | operator | Cron scheduler tick interval. |

##### `cleanup`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `cleanup.sweepMs` | `POMTREED_CLEANUP_SWEEP_MS` | ms | `60000` | min 1 | operator | Folder cleanup sweep interval. |

##### `approval`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `approval.timeoutMs` | `POMTREED_APPROVAL_TIMEOUT_MS` | ms | `300000` | min 1 | operator | Per-rung fail-closed window of a human approval rung (also the web_fetch approval window). |

##### `ask`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `ask.timeoutMs` | `POMTREED_ASK_TIMEOUT_MS` | ms | `86400000` | min 1 | operator | How long an ask stays open. |

##### `escalation`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `escalation.agentRungMs` | `POMTREED_ESCALATION_AGENT_RUNG_MS` | ms | `600000` | min 1 | operator | Per-hop window of an agent rung on a bubbled ask or approval. |
| `escalation.channels` | `POMTREED_ESCALATION_CHANNELS` | list | `ui` |  | operator | Ordered channels asks and alerts go out on; the root broadcasts to every one. |

##### `messaging`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `messaging.channels` | `POMTREED_MESSAGING_CHANNELS` | list | none |  | operator | Chat-rank messaging channels to enable (each needs the sender allowlist POMTREED_MESSAGING_SENDERS). |
| `messaging.allowSpawn` | `POMTREED_MESSAGING_ALLOW_SPAWN` | bool | `false` |  | operator | Allow chat-rank senders to spawn agents. |

##### `chat`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `chat.approval` | `POMTREED_CHAT_APPROVAL` | list | none |  | operator | Chat-initiated routes (spawn, cancel) that wait for a human approval. |

##### `workflow`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `workflow.reviewedExtensions` | `POMTREED_WORKFLOW_REVIEWED_EXTENSIONS` | list | none |  | operator | Extensions whose workflow drivers are reviewed. Validated by pomtreed WorkflowRuntimePolicy. |
| `workflow.templates` | `POMTREED_WORKFLOW_TEMPLATES` | json | `{}` |  | operator | Templates each reviewed workflow driver may spawn: {"<ext>/<driver>": ["<template>", ...]}. Parsed by pomtreed WorkflowRuntimePolicy. |
| `workflow.fetch.userAgent` | `POMTREED_WORKFLOW_FETCH_USER_AGENT` | string | `pomtree` |  | operator | The one operator identity for every fetch path: sent on every request and redirect hop of agent web_fetch, the workflow fetch capability and every capture broker rung, and appended to Chromium's own User-Agent in browser captures (never a desktop-browser impersonation). Free-form, but it must start with a product token (an app name, optionally /version). A contact (an email address or an http(s) URL) is optional but recommended, e.g. "pomtree (+https://example.org/contact)"; some sites, such as SEC EDGAR, ask for one. Its product token is also the robots.txt token evaluated beside Claude-User. Blank or unset: the default "pomtree". pomtreed logs the effective identity at startup. |
| `workflow.fetch.minIntervalMs` | `POMTREED_WORKFLOW_FETCH_MIN_INTERVAL_MS` | ms | `0` | max 60000 | operator | Minimum time between two requests the workflow fetch capability sends to the same host, across every workflow on this daemon; each redirect hop is a request. E.g. 100 keeps SEC EDGAR (sec.gov) under its 10 requests per second. 0: unpaced. |

##### `test`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `test.mode` | `POMTREED_TEST_MODE` | bool | `false` |  | operator | Test mode: the only switch that admits the test-only seams below. pomtreed prints a WARNING at start while it is on. Never set it in production. |
| `test.fetchHosts` | `POMTREED_TEST_FETCH_HOSTS` | json | `{}` |  | operator | Test only, refused unless test.mode: route the workflow fetch capability for these hosts to a loopback fixture, {"data.sec.gov": 8443} -> http://127.0.0.1:8443 with the original Host header. The capability's allowlist, budget and caps still apply; other hosts use the network. Empty: off. |

##### `pi`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `pi.provider` | `POMTREED_PI_PROVIDER` | string | unset |  | operator | The provider the scoped proxy credential is written for (required; e.g. openrouter). |
| `pi.catalogDir` | `POMTREED_PI_CATALOG_DIR` | path | unset | absolute | operator | Pi model catalog directory (pricing). Unset: found from the pi binary on PATH. |

##### `search`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `search.provider` | `POMTREED_SEARCH_PROVIDER` | string | unset |  | operator | web_search provider; empty = none. |
| `search.key` | `POMTREED_SEARCH_KEY_FILE` (secret) | string | unset |  | operator | The web_search provider's API key. |

##### `webfetch`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `webfetch.enabled` | `POMTREED_WEBFETCH_ENABLED` | bool | `true` |  | operator | Offer web_fetch (runs on the host network, bypassing container egress). |
| `webfetch.maxCalls` | `POMTREED_WEBFETCH_MAX_CALLS` | count | `60` | min 1 | operator | web_fetch and web_search calls allowed per agent per fixed window (one shared count). Windows are aligned to the Unix epoch, not sliding, so up to twice this many calls can pass in a short span across a window boundary. |
| `webfetch.windowMs` | `POMTREED_WEBFETCH_WINDOW_MS` | ms | `60000` | min 1 | operator | Length of the web_fetch and web_search call-quota window. Fixed windows start at multiples of this since Unix time 0 (not sliding), so a burst can span a boundary (see webfetch.maxCalls). |
| `webfetch.timeoutMs` | `POMTREED_WEBFETCH_TIMEOUT_MS` | ms | `30000` | min 1000; max 300000 | operator | Whole-call deadline of one agent web_fetch call, every redirect hop included; past it the call is aborted and fails as a timeout. |
| `webfetch.maxTotalBytes` | `POMTREED_WEBFETCH_MAX_TOTAL_BYTES` | bytes | `33554432` | min 1048576 | operator | Total web_fetch bytes allowed per agent. |

##### `capture`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `capture.waitMs` | `POMTREED_CAPTURE_WAIT_MS` | ms | `20000` | min 0; max 120000 | operator | How long a capture request blocks before it returns pending (the requireApproval precedent); retrying with the same idempotency key, or waiting on the job, converges on the same job. |
| `capture.timeoutMs` | `POMTREED_CAPTURE_TIMEOUT_MS` | ms | `30000` | min 1000; max 600000 | operator | Whole-acquisition deadline of one capture rung (connect, first byte and body, every redirect hop included); past it the rung fails as a timeout. |
| `capture.maxBytes` | `POMTREED_CAPTURE_MAX_BYTES` | bytes | `8388608` | min 1024; max 16777216 | operator | Per-capture body cap; a larger body fails too_large. At most 16 MiB, the egress proxy's per-connection relay cap. |
| `capture.freshness.stableMs` | `POMTREED_CAPTURE_FRESHNESS_STABLE_MS` | ms | `604800000` | min 1 | operator | Maximum age of a cached capture of a stable page (DOI landing pages, documentation, reference pages). |
| `capture.freshness.dailyMs` | `POMTREED_CAPTURE_FRESHNESS_DAILY_MS` | ms | `86400000` | min 1; <= `capture.freshness.stableMs` | operator | Maximum age of a cached capture of a daily page (articles, filing indexes, blog posts); the default class. |
| `capture.freshness.liveMs` | `POMTREED_CAPTURE_FRESHNESS_LIVE_MS` | ms | `600000` | min 1; <= `capture.freshness.dailyMs` | operator | Maximum age of a cached capture of a live page (feeds, front pages, prices). |
| `capture.freshness.rules` | `POMTREED_CAPTURE_FRESHNESS_RULES` | json | `[]` |  | operator | Operator freshness rules, first match wins: [{"host": "www.sec.gov", "pathPrefix": "/Archives/", "class": "immutable"}, ...]; class is immutable, stable, daily or live. A URL no acquirer classes and no rule matches is daily. Parsed by core parseFreshnessRules. |
| `capture.denylist` | `POMTREED_CAPTURE_DENYLIST` | list | none |  | operator | Hosts the broker never captures (blocked/policy): each entry matches the host and its subdomains (core denylistMatch). |
| `capture.quota.requests` | `POMTREED_CAPTURE_QUOTA_REQUESTS` | count | `120` | min 1 | operator | Capture requests one agent may make per capture.quota.windowMs (cache hits included: the quota bounds the requester, not the origin). |
| `capture.quota.windowMs` | `POMTREED_CAPTURE_QUOTA_WINDOW_MS` | ms | `3600000` | min 1000 | operator | The capture request quota window. |

##### `otlp`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `otlp.endpoint` | `POMTREED_OTLP_ENDPOINT` | string | unset |  | operator | OTLP exporter endpoint; empty = no export. |

##### `client`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `client.debug` | `POMTREE_CLIENT_DEBUG` | bool | `false` |  | operator | Rethrow unexpected CLI failures with their stack instead of one line. |

#### Extension keys: `hn-digest`

Composed with `extendRegistry` from `examples/hn-digest/manifest.json`, exactly as the daemon composes a present extension, so these are the names and bounds it resolves. Keys exist only while the extension is present in `extensions.dir`; extension keys are host-side only and never sensitive.

##### `ext.hnDigest`

| Key | Environment variable | Kind | Default | Limits | Scope | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `ext.hnDigest.articleCaptureBytes` | `POMTREED_EXT_HN_DIGEST_ARTICLE_CAPTURE_BYTES` | bytes | `262144` | min 1; <= `browser.capture.maxBytesCeiling`; <= `ext.hnDigest.articleAuditBodyMaxBytes` | operator | Bytes of raw body and rendered DOM captured per article. |
| `ext.hnDigest.articleAuditBodyMaxBytes` | `POMTREED_EXT_HN_DIGEST_ARTICLE_AUDIT_BODY_MAX_BYTES` | bytes | `2097152` | min 1 | operator | Largest response body the digest host's audited fetch reads. |
| `ext.hnDigest.articleTextMaxBytes` | `POMTREED_EXT_HN_DIGEST_ARTICLE_TEXT_MAX_BYTES` | bytes | `1048576` | min 1; <= `report.maxBytes`; >= `browser.capture.textMaxBytes` | operator | UTF-8 bytes of article text the digest stores per story, as one retained report (static clip and evidence check); the analyst reads at most ext.hnDigest.articleAnalystReadMaxBytes of it. The browser worker's own clip (browser.capture.textMaxBytes) may not exceed it. |
| `ext.hnDigest.articlePageMaxBytes` | `POMTREED_EXT_HN_DIGEST_ARTICLE_PAGE_MAX_BYTES` | bytes | `16384` | min 4096; <= `ext.hnDigest.articleAnalystReadMaxBytes`; <= `report.maxBytes` | operator | UTF-8 bytes of one article page the digest publishes to the analyst (a page is a view of the stored text, never the verification authority). |
| `ext.hnDigest.articleAnalystReadMaxBytes` | `POMTREED_EXT_HN_DIGEST_ARTICLE_ANALYST_READ_MAX_BYTES` | bytes | `262144` | min 1; max 1048576 | operator | UTF-8 bytes of the stored article text the digest offers the analyst, as pages; the first pages that fit are published and the rest is named as unread. Quotes still verify against the whole stored text. |
| `ext.hnDigest.articleBrowserCaptureDeadlineMs` | `POMTREED_EXT_HN_DIGEST_ARTICLE_BROWSER_CAPTURE_DEADLINE_MS` | ms | `60000` | min 1; >= `browser.capture.deadlineMinMs`; <= `browser.capture.deadlineMaxMs` | operator | Deadline the digest's browser worker requests for one article capture. |
| `ext.hnDigest.reportMaxBytes` | `POMTREED_EXT_HN_DIGEST_REPORT_MAX_BYTES` | bytes | `65536` | min 1; <= `report.workflowMaxBytes` | operator | Largest rendered digest report the digest workflows publish (the content workflow's report bound and the metadata digest's report capability). |

#### Environment names that are deliberately not parameters

The resolver ignores these names under our prefixes (`POMTREED_`, `POMTREE_`, `PTREE_`) instead of refusing them as unknown. The config-file path `POMTREED_CONFIG` is reserved separately. A trailing `*` marks a family prefix.

| Name | Reason | Why |
| --- | --- | --- |
| `POMTREE_TOKEN` | runtime-injected | agent or operator credential; pomtreed issues it per container (lifecycle.ts) |
| `POMTREE_TOKEN_FILE` | runtime-injected | planned secret-mount path for POMTREE_TOKEN; not injected yet, so the token is passed as an environment variable and is visible in docker inspect |
| `PTREE_CAPTURE_JOB` | runtime-injected | the per-job capture spec the pomtreed capture broker issues for the capture worker; not operator config |
| `POMTREE_API` | runtime-injected | the agent endpoint URL pomtreed injects into a container |
| `POMTREE_SOCKET` | runtime-injected | the socket pomtreed injects into a container (POMTREE_API's unix alternative); the same name is the operator's client override, kept as one connection contract |
| `POMTREE_AGENT_ID` | runtime-injected | the container's agent id |
| `POMTREE_AGENT_GENERATION` | runtime-injected | the container's agent generation (fencing) |
| `POMTREE_AGENT_DEADLINE_AT` | runtime-injected | the container's session deadline |
| `POMTREE_BASE_COMMIT` | runtime-injected | the commit the agent's clone was cut from |
| `PTREE_BROWSER` | runtime-injected | per-template browser mode pomtreed injects (daemon-util.ts browserEnv) |
| `PTREE_BROWSER_MAX_STEPS` | runtime-injected | per-template browser step limit pomtreed injects |
| `PTREE_BROWSER_MAX_MS` | runtime-injected | per-template browser time limit pomtreed injects |
| `PTREE_BROWSER_PROFILE` | runtime-injected | per-template browser profile pomtreed injects (absent = capture-only) |
| `PTREE_BROWSER_USER_AGENT` | runtime-injected | the resolved workflow.fetch.userAgent pomtreed injects into a browser worker (a non-secret operator identity string, not a registry key delivered to containers) |
| `PTREE_CONFIG_JSON` | runtime-injected | the resolved container subset pomtreed injects (core config/container.ts) |
| `PTREE_EVENTS_SINK` | runtime-injected | in-image events sink path (agent-image pomtree-events) |
| `POMTREE_REVISION_FILE` | test-seam | the pomtree revision file path, overridden by tests |
| `PTREE_DOCKER_TESTS` | test-seam | gates Docker test suites |
| `POMTREE_TEST_TIMEOUT_SCALE` | test-seam | multiplier (>= 1) for test deadlines in the shared timing helpers; CI and the gate set 3 |
| `PTREE_AGENT_TEST_*` | test-seam | sandbox-docker test image gates |
| `PTREE_TEST_*` | test-seam | test capture gates |
| `PTREE_E2E_*` | test-seam | e2e image and live-model gates |
| `POMTREED_DEMO_*` | test-seam | e2e demo knobs |
| `POMTREED_LIVE` | test-seam | the e2e demos' spend gate |
| `POMTREED_MESSAGING_SENDERS` | not-a-parameter | inbound sender allowlist (access control, configured by its owner) |
| `POMTREED_MESSAGING_TOKEN` | owned-elsewhere | messaging-discord adapter config (path to its daemon token) |
| `POMTREED_URL` | owned-elsewhere | messaging-discord adapter config (the daemon URL it calls) |
| `POMTREED_KINDS` | identifier | core journal-kind table |
| `POMTREED_KIND_PREFIX` | identifier | core journal-kind prefix |

<!-- END GENERATED: config-reference -->
