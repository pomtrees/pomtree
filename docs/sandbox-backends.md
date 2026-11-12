# Writing a sandbox backend

This page is for anyone, person or AI agent, adding a sandbox backend to pomtree as an extension. It covers what a backend is, the contract it implements, how it is packaged, loaded and reviewed, and how to show it works. The worked example throughout is [`examples/sandbox-loopback`](../examples/sandbox-loopback), a complete backend you can copy.

## 1. What a sandbox backend is

pomtree runs every agent inside a sandbox: an isolated environment the daemon (`pomtreed`) starts, watches, stops and lists. A **sandbox backend** is the code that does this on one kind of infrastructure: a local container engine, a cluster, or a hosted sandbox service. The daemon talks to it only through the `Sandbox` port, an interface in `packages/core/src/ports.ts`, so the rest of pomtree does not change when the backend does.

Built-in backends ship with the daemon: `docker` and `podman` today, with the ids `kubernetes`, `sail` and `e2b` reserved for first-party backends (`BUILTIN_BACKENDS` in `packages/pomtreed/src/sandbox-backends.ts`). Any other backend is **contributed** by an extension: a directory with a `manifest.json` whose `provides` list declares the backend. The operator selects a backend with `sandbox.backend` (see [`docs/configuration.md`](configuration.md)) and must pin a contributed one by content hash before the daemon will load it (section 10).

**Today only `docker` and `podman` run agents.** Selecting `kubernetes`, `sail` or `e2b` refuses to start, because this build has no provider for them. Selecting a contributed backend makes the daemon verify its manifest entry and its pin without importing it, then refuse to start, because remote placement is not wired (`remoteBootRefusal`). A contributed backend is never constructed by the daemon yet. The conformance command (section 9) is where one runs today, and what this page describes is the contract it will run under.

## 2. The port at a glance

A backend's `create(deps)` returns an object implementing `Sandbox` (`packages/core/src/ports.ts`). The required members:

| Member | What it must do |
| --- | --- |
| `declaration` | The static capability declaration (section 3). Readable without any I/O. |
| `start(spec, idempotencyKey)` | Create and start a sandbox. Repeating a key returns the same sandbox (section 7). Throws `SandboxOutcomeUnknownError` when the create got no reply. |
| `attach(id, agent)` | Re-adopt a running sandbox after a daemon restart, creating nothing. Throws `SandboxUnavailableError` for an unknown or stopped one. |
| `stop(id, graceMs, key)`, `kill(id, key)` | End a sandbox. An already-gone sandbox is success. A killed sandbox exits 137. |
| `inspect(id)` | `{ running, exitCode, status? }`, or `null` for an unknown id. Must agree with `wait()`. |
| `list(owner)` | Every sandbox this owner's daemon may have created (section 8). |
| `reclaim(owner)` | Remove provider-side leftovers this owner owns that no live sandbox uses; return the ids reclaimed. |
| `imageIdentity(ref)` | Resolve an image reference to a stable identity. |
| `resultWork(id, opts)` | Report or collect workspace changes; a backend with no workspace reports a clean one. |

`probe(runtime?)` is optional: a readiness check that may only narrow the declaration. The returned handle has `id`, `output()` and `wait()`. Optional facets (`terminal`, `connect`, `files`, `snapshots`, `pause`, `lease`, `images`) are present only when the declaration claims a capability they realise; an undeclared facet must be absent or throw `SandboxCapabilityError`. The error classes (`SandboxUnavailableError`, `SandboxOutcomeUnknownError`, `SandboxCapabilityError`, `IdempotencyConflictError`) are exported by `@pomtree/core`.

## 3. Capabilities and the declaration

The declaration (`SandboxDeclaration` in `packages/core/src/sandbox-capabilities.ts`) answers every name in `SANDBOX_CAPABILITIES` with `true` or `false`, plus fixed facts: `idempotency`, `tagging` (`metadata` or `name-encoded`), `output` (`stream` or `poll`), `region`, `maxLifetimeMs`, `preemptible` and `billing`. `validateDeclaration` lists what is wrong with one. Declare a capability only when the backend really provides it: the daemon admits or refuses a backend from its declaration at boot (`admitBackend`), and the conformance suite runs the clauses each declared capability needs.

The loopback example declares only `list.byTag` and `image.digestAttest`, because its provider runs no process and so has no terminal, files, network policy or resource limits to offer.

## 4. The manifest

A backend extension's `manifest.json` is an ordinary extension manifest (the extension host is described in [`docs/extending.md`](extending.md)) with a `provides` entry. From the example:

```json
{
  "apiVersion": 2,
  "name": "loopback",
  "entry": "entry.mts",
  "capabilities": {},
  "deps": [],
  "provides": [
    {
      "kind": "sandbox",
      "id": "loopback",
      "entry": "provider.mts",
      "portVersion": 1,
      "credentials": ["apiKey"],
      "params": [{ "key": "baseUrl", "kind": "string", "default": "http://127.0.0.1:8790", "doc": "URL of the loopback sandbox API the backend talks to." }]
    }
  ]
}
```

The rules, enforced by `parseManifest` in `packages/pomtreed/src/extension-manifest.ts`:

- `id` matches `^[a-z][a-z0-9-]{0,30}$`, equals the extension `name` or starts with `<name>-`, and is not `auto`, a built-in id, or anything starting with `pomtree`.
- `entry` is a relative path inside the extension directory: the provider module.
- `portVersion` is the `Sandbox` port version the module speaks. It must equal `SANDBOX_PORT_VERSION` from `@pomtree/core` exactly; there is no range negotiation.
- `params` declares the backend's own configuration keys, in the same format as extension `params`. They resolve under `sandbox.<segment>.<key>`, where the segment is the camelCase of the id, with the environment variable `POMTREED_SANDBOX_<ID>_<KEY>`. Every backend also gets a standard set of keys (`maxSandboxes`, `leaseMs`, `region` and the `rate.*` cost keys, `STANDARD_SANDBOX_KEYS` in `packages/core/src/config/sandbox-manifest.ts`), so do not redeclare those names.
- `credentials` lists credential names only (section 6).

The extension's own `entry` module is still required. A backend-only extension's entry registers nothing, as `examples/sandbox-loopback/entry.mts` shows.

## 5. The provider module

The module named by `provides[].entry` exports three names, the `SandboxBackendModule` shape in `packages/core/src/sandbox-backend.ts`:

```ts
export const portVersion = SANDBOX_PORT_VERSION;
export const declaration: SandboxDeclaration = { /* section 3 */ };
export function create(deps: SandboxBackendDeps): Sandbox { /* section 2 */ }
```

The loader fills `id`, `params` and `credentials` from the manifest, so the module does not repeat them. `create` receives `SandboxBackendDeps`, built by the daemon's facade (`createSandboxBackendDeps` in `packages/pomtreed/src/sandbox-backend-deps.ts`):

| Dep | Use |
| --- | --- |
| `request(url, init)` | HTTP calls, and `request.openWebSocket(url)` for WebSockets. Stamps the User-Agent (section 12) and applies per-call TLS options. Prefer it. |
| `fetch` | A stamped `fetch` for code that needs the standard API. Redirects are not followed automatically. |
| `credential(name)` | Reads one declared credential (section 6). |
| `config` | The backend's resolved `sandbox.<segment>.*` values, frozen. |
| `log(event, fields)`, `now()` | Structured logging and the clock. |

A module may import only `node:` builtins (except `child_process`, `vm`, `worker_threads`, `module`, `cluster` and `inspector`), the packages the daemon ships (`@pomtree/core` and `@pomtree/sandbox-kit`, `SHIPPED_PACKAGES` in `packages/pomtreed/src/sandbox-provider-load.ts`) and files inside its own directory. Anything else, the daemon's internals included, is refused when the module is imported, with a message naming the import. `@pomtree/testing` is not shipped, so the provider cannot use the shared fake; type-only imports are fine, because they leave nothing to resolve at run time. Use `.mts` files (or `.js`/`.ts` with a `package.json` declaring the module type inside the directory).

The `SandboxBackendDeps` type also has an optional `run` (a process runner for backends that drive a local CLI), meant for a backend whose `provides[].deps` lists `"run"`. It is not usable yet (tracked as `TODO(sandbox-run-dep)` in `packages/pomtreed/src/extension-manifest.ts`). The manifest parser checks `provides[].deps` against the extension-level dep names and refuses `"run"`, while the loader accepts only `"run"`. The daemon also has no process runner to hand over, so its deps facade is built without one. Drive a provider over HTTP or WebSocket instead.

## 6. Credentials are files

A backend declares credential names in `provides[].credentials` and reads each one with `deps.credential(name)`. The operator supplies a credential as a file, never as a value: the variable `POMTREED_SANDBOX_<ID>_<NAME>_FILE` (computed by `secretFileEnv(sandboxCredentialEnv(id, name))` in `@pomtree/core`; for the example, `POMTREED_SANDBOX_LOOPBACK_APIKEY_FILE`) holds the absolute path of a regular file of at most 64 KiB, readable by its owner only (mode 0600 or 0400; any group or other bit is refused with a `chmod 600` hint). The facade refuses a name the manifest did not declare, and reads the file again on every call, so a rotated key takes effect without a restart. Read the credential per request, as the example's single `call` helper does, and never cache it, log it or put it in a sandbox's create-time environment.

## 7. Idempotency: the requirement and the three mechanisms

The daemon retries. `start(spec, key)` called twice with the same key must return the same sandbox and leave exactly one. When a create gets no reply, `start` throws `SandboxOutcomeUnknownError` carrying the key and the id the retry will return; the daemon retries with the same key, and if that cannot finish, startup reconcile looks for the sandbox with `list(owner)`. `sandboxIdForKey(key)` in `@pomtree/core` derives a deterministic id from a key. A declaration states how the backend achieves this in `idempotency`:

- `unique-name`: the sandbox's provider-side name is derived from the key, and the provider refuses a second resource with the same name. On that refusal the backend looks up the existing one and returns it. The example does this: it names the sandbox `sandboxIdForKey(key)`, and on a 409 it compares the stored create fingerprint with its own and returns the existing sandbox (or throws `IdempotencyConflictError` when the same key came with a different spec).
- `native-token`: the provider deduplicates on a client-supplied token, such as an `Idempotency-Key` header. Declare `idempotencyWindowMs`, the time the provider keeps tokens, and send a byte-identical body on retry if the provider compares bodies.
- `tag-lookup`: before creating, the backend lists by a tag that carries the key and returns a match.

`none` is expressible only so that `validateDeclaration` can refuse it.

## 8. Tags, labels and `list(owner)`

`list(owner)` must return every sandbox the owner's daemon may have created, so reconcile can find a sandbox whose create reply was lost. The owner (`SandboxOwner`) has a `host`, a `storeId` and an `epoch`. Sandboxes started with `spec.labels` carry them: the daemon labels with `store_id` and `daemon_epoch`. Exclude a sandbox labelled with another `store_id` or a `daemon_epoch` newer than the owner's, and include unlabelled ones. Echo the labels a sandbox was started with in its listing.

Label names are `[A-Za-z0-9_.-]+` and never start with `pomtree`: that prefix is reserved for pomtree's own tags (`SANDBOX_TAGS`: `pomtree.sandbox`, `pomtree.agent`, `pomtree.backend`, `pomtree.host`, `pomtree.generation`). Refuse a bad label before creating anything. `tagging: "metadata"` means tags are stored as provider metadata; `"name-encoded"` means they are encoded in the resource name for providers without metadata. `list.byTag` declares that the owner filter runs on the provider side; without it, list everything and filter on the client.

Each listing has `host` and `generation`. Stamp them when the backend knows which daemon host and generation created the sandbox; otherwise report `null` for both, as the example and the Docker adapter do, and the daemon reports such sandboxes without adopting them.

## 9. The conformance command

One command runs the shared conformance suite (`@pomtree/testing`) against a backend through the daemon's own manifest parser, pin and loader:

```sh
pnpm conformance:sandbox <extension dir> [--backend <id>] [--accept-closed]
```

It parses `manifest.json`, prints the directory's pin as `pin: <id>=sha256:<hex>`, loads the provider under the import guard with offline deps (requests may reach only loopback hosts, and every declared credential reads a sentinel value), imports `<dir>/conformance.mts` if present, runs every clause, and prints one line per check, a summary and the floor line. Exit codes: 0 conformant; 1 a clause or the floor failed, or the run was gated; 2 the extension could not be read, parsed, pinned or loaded. The command lives in `packages/pomtreed/scripts/sandbox-conformance.ts`; its header lists exactly what it does and does not protect.

`conformance.mts` default-exports `({ provider, deps, base }) => descriptor`, where `base` is the descriptor the command built. Return `base` with what only you know: a `make()` that points the backend at a test provider, the `hooks` that let clauses observe requests or make the provider misbehave (`SandboxConformanceHooks` in `packages/testing/src/sandbox-conformance.ts`), and options such as `listingTags` or `startConflict`. A clause that needs a capability the backend does not declare, or a hook the descriptor does not supply, is skipped with its reason printed; a declared capability whose clause fails is a failure, never a skip. The floor fails a run in which no clause passed, or in which a declared capability's clauses did not pass (capabilities the coverage table `SANDBOX_CAPABILITY_COVERAGE` defers are exempt). A backend that needs a live endpoint returns a `gate`; a gated run exits 1 unless `--accept-closed` is passed.

## 10. The pin and the operator's review

A contributed backend runs only when the operator names it in `sandbox.backend` and pins its directory in `sandbox.reviewedBackends` as `<id>=sha256:<hex>`. The pin (`hashExtensionTree` in `packages/core/src/sandbox-backend.ts`) is a SHA-256 over every file in the directory: its path, size and content hash, sorted. Changing, adding, renaming or removing any file changes the pin, and the daemon then refuses to load the backend and prints the new hash. Symbolic links and native addons (`.node`, `.wasm`) are refused. The pin printed by the conformance command is computed from the tree it just loaded, so it proves the bytes did not change during that run, not that anyone reviewed them.

Pinning is the operator's statement that they read the code. The operator is responsible for that review: the module will run inside the daemon with the daemon's privileges.

## 11. Threat model

Be precise about what protects whom. A contributed backend runs in the daemon's own Node process, with its full privileges: it can read the daemon's environment and files and open connections. The pin and the import guard are friction against accidents (an unreviewed file swapped in, an import of the daemon's internals or an unreviewed package), not isolation. The guard has documented gaps (the header of `packages/pomtreed/src/sandbox-provider-load.ts` lists them, such as `process.getBuiltinModule`), and a hostile module that has been reviewed and pinned is not contained. The facade's guarantees (the stamped User-Agent, declared-only credentials, the file mode check, frozen config) hold against bugs and careless code, not against a backend written to get around them. The conformance command executes the extension's code on the machine of whoever runs it: run it only on code you are willing to run.

## 12. The fetch identity

Every outbound request pomtree makes carries one User-Agent: `workflow.fetch.userAgent` (default `pomtree`, `DEFAULT_FETCH_USER_AGENT` in `@pomtree/core`). `deps.request`, `deps.request.openWebSocket` and `deps.fetch` set it; a call that sets its own User-Agent throws. Do not invent a User-Agent string and do not call the global `fetch`, `node:http` or `node:https` directly: those requests leave without the operator's identity, and the `user-agent-stamped` clause fails when its hook sees one.

## 13. Adding a backend as an AI agent

1. Open an issue describing the backend: the provider, the id, and which idempotency mechanism its API supports.
2. Copy `examples/sandbox-loopback` to a new directory. Rename the extension `name` and the backend `id` everywhere (manifest, `provider.mts`, `entry.mts`, `wire.mts`).
3. Write the manifest (section 4): params, credentials, `portVersion` equal to `SANDBOX_PORT_VERSION`.
4. Write the wire format as pure functions with unit tests, like `wire.mts` and `wire.test.mts`.
5. Write `provider.mts`: the declaration first (claim only what the provider does), then each port method, every call through one helper over `deps.request`.
6. Write the offline test provider and `conformance.mts`: for a hosted API, a loopback server answering its documented routes, recording User-Agents, and able to lose a create reply and preempt a sandbox.
7. Run `pnpm conformance:sandbox <dir>` until it exits 0, then make your own seeded broken copy and show that the command fails on each defect's clause.
8. Write the README: what the backend supports, its keys and credentials, and how to run its checks.
9. For an in-repo change, run `pnpm check:lite` (and `pnpm gen:config` if configuration keys changed).

Do not: import the daemon's packages or `@pomtree/testing` from the provider; read credentials from anywhere but `deps.credential`; put a credential in a sandbox's create-time environment; declare a capability the provider does not enforce; widen a declaration from `probe`; or make a network call during the conformance run except to a loopback host.

Report: the conformance output (pin line, summary and floor lines, exit code); each skipped clause and why; the failing clauses of your seeded broken copy, with the red run; the unit test counts; and every capability declared false that a reader might expect true.

## 14. Walkthrough: the loopback example

[`examples/sandbox-loopback`](../examples/sandbox-loopback) implements the port against an invented HTTP API whose routes are listed at the top of its `wire.mts`. `provider.mts` sends every call through one `call` helper, which reads the `apiKey` credential, calls `deps.request` and maps a 401 to `SandboxUnavailableError("auth")`. `start` checks the labels, names the sandbox `sandboxIdForKey(key)` and posts a deterministic body; no reply becomes `SandboxOutcomeUnknownError`, and a 409 returns the existing sandbox. `list(owner)` sends the owner's store and epoch as query parameters, which is why the declaration claims `list.byTag`.

`conformance.mts` starts `conformance/loopback-server.mts`, an in-memory `node:http` server on 127.0.0.1, for every clause, points the provider at it through `config.baseUrl`, and supplies three hooks: `requests` (the server records each User-Agent), `unknownOutcome` (the server applies or drops the next create and closes the connection without replying) and `preempt`. Run it from the repository root:

```sh
pnpm conformance:sandbox examples/sandbox-loopback
```

The output starts with the pin and ends with the summary and floor lines; the run exits 0:

```text
pin: loopback=sha256:<64 hex>
PASS declaration
PASS probe
PASS lifecycle-run
...
CONFORMANCE loopback: conformance: 17 passed, 0 failed, 6 skipped (...)
CONFORMANCE loopback floor: <n> capabilities covered, <n> deferred
```

Its seeded broken copy, `packages/testing/src/sandbox-loopback-broken`, carries four marked defects in `provider.mts` and fails `label-rules`, `lifecycle-run`, `list-by-owner` and `user-agent-stamped`; `packages/pomtreed/src/sandbox-loopback-conformance.test.ts` asserts both runs.

## 15. Current limits

- Only `docker` and `podman` run agents (section 1). A contributed backend is verified at boot and then refused (`remoteBootRefusal` in `packages/pomtreed/src/sandbox-backends.ts`), so the conformance command is the only place one runs today.
- A contributed backend cannot declare the `run` dep yet: `TODO(sandbox-run-dep)` (section 5).
- Boot admission (`admitBackend`) refuses a backend that gives the agent no route to the daemon (`connect`, `reach.outbound` or `mounts.host`) or does not enforce resource limits (`resources.limits`). The loopback example declares neither, so it is a template and a conformance subject, not a backend to run agents on.
