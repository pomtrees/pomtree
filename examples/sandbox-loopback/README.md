# loopback: a template sandbox backend

A complete, minimal sandbox backend contributed by an extension. It implements the `Sandbox` port against an invented HTTP API, "the loopback sandbox API", and ships an offline server for that API so the conformance suite can run it end to end with no network, account or cost. Copy this directory to start a new backend; the author guide is [`docs/sandbox-backends.md`](../../docs/sandbox-backends.md).

The loopback provider runs no process: a sandbox is a record that is "running" until it is stopped (exit 143) or killed (exit 137). That is enough to exercise everything the conformance suite checks through the port (lifecycle, idempotent create, unknown outcomes, listing by owner, labels, preemption, the User-Agent), and it is why the backend declares no terminal, connect, files, egress or resource limits. It also needs no `run` dep, which a contributed backend cannot declare yet (`TODO(sandbox-run-dep)`).

## Files

| File | What it is |
| --- | --- |
| `manifest.json` | The extension manifest. `provides` declares the `loopback` backend: its module, port version, one credential (`apiKey`) and one key (`sandbox.loopback.baseUrl`). |
| `entry.mts` | The extension's own entry module. It registers nothing; the extension exists to provide the backend. |
| `provider.mts` | The backend: exports `portVersion`, `declaration` and `create(deps)`. All provider calls go through one helper over `deps.request`. |
| `wire.mts` | The wire format as pure functions: create body, paths, label rule, record parsing. |
| `wire.test.mts` | Unit tests for `wire.mts`. |
| `conformance.mts` | The descriptor `pnpm conformance:sandbox` loads: a fresh offline server per clause, and the hooks the clauses use. |
| `conformance/loopback-server.mts` | The offline loopback sandbox API (`node:http` on 127.0.0.1, in memory). |
| `tsconfig.json` | Typecheck configuration for this directory. |

## Checks

Run from the repository root:

```sh
pnpm conformance:sandbox examples/sandbox-loopback
node --test examples/sandbox-loopback/wire.test.mts
npx tsc -p examples/sandbox-loopback
```

The conformance command prints the directory's pin, one `PASS`, `FAIL` or `SKIPPED` line per check, a summary and the floor line, and exits 0. Six clauses are skipped, each with its printed reason: the backend declares no `connect` or `files` capability, is not a Docker-API client, and its descriptor supplies no foreign-record or secrets hook.

`packages/pomtreed/src/sandbox-loopback-conformance.test.ts` runs the same command over this directory and over its seeded broken copy, `packages/testing/src/sandbox-loopback-broken`, which must fail on exactly four clauses.

## Running it under a daemon

Copy the directory into the daemon's `extensions.dir`, set `sandbox.backend` to `loopback`, add the pin the conformance command printed to `sandbox.reviewedBackends` (as `loopback=sha256:<hex>`), and set `POMTREED_SANDBOX_LOOPBACK_APIKEY_FILE` to the path of a mode 0600 file holding the key. Today only `docker` and `podman` run agents, so the daemon then verifies the pin without importing the module and refuses to start (`remoteBootRefusal`); the conformance command is where this backend runs. Even once that lifts, this backend is a template: it gives an agent no route to the daemon and enforces no resource limits, so boot admission would refuse it for real agents.
