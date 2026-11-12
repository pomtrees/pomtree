# @pomtree/sandbox-e2b

The E2B hosted sandbox backend (`sandbox.backend` id `e2b`): an adapter for pomtree's `Sandbox` port over E2B's REST API, with no SDK and no new dependency. It was built from documentation only. No call has been made to E2B, every fixture is hand-written and labelled `inferred`, and the live tier is opt-in and was never run.

Wiring the provider into pomtreed's built-in registry is a separate task. Boot admission refuses this backend today. It declares no route from the sandbox to the daemon (`connect`, `reach.outbound` and `mounts.host` are all false), no enforced resource limits and no image path (`image.ociPull` and `image.template` are false). `src/provider.test.ts` asserts this refusal.

## What it does

- **Lifecycle.** `start` creates a sandbox from an E2B template: `sandbox.e2b.template`, or the image reference when that is empty. `stop` and `kill` both delete the sandbox, because E2B has no graceful stop; the adapter reports exit 143 for a stop and 137 for a kill. `inspect`, `attach`, `list(owner)` and `probe` read state through the list and get calls.
- **Identity and dedup.** The pomtree sandbox id is `sandboxIdForKey(key)`, stored in metadata as `pomtree.sandbox`. Creates go through the kit's `createOnce` with the tag-lookup mechanism, so a replayed or uncertain create adopts the sandbox its metadata names and never creates a second one.
- **Ownership (fail closed).** `list(owner)` returns only sandboxes whose `store_id` label equals the owner's store id and whose `daemon_epoch` label, if present, is not newer than the owner's. A sandbox without a `store_id` label is not returned at all, because several daemons may share one E2B account and reconcile kills what `list` returns. Host and generation are stamped from `SandboxSpec.host` and `SandboxSpec.generation` as metadata and read back by `list` and `inspect`; a sandbox without them lists null and reconcile never adopts it.
- **Listing limit.** One list page is read. A page of 100 entries (`E2B_LIST_PAGE_SIZE`, inferred) may be truncated, so `list` then throws `E2BListTruncatedError` (a `SandboxUnavailableError`) instead of acting on a partial answer; a non-array answer is refused too. The practical hard limit is 99 pomtree sandboxes per account and selector.
- **Paused.** A paused sandbox inspects as `running: false`, null exit code, status `paused`, and lists with state `paused`; it is never reported as exited.
- **Expiry.** A tracked sandbox that disappears without pomtree stopping it is reported as `expired`: `inspect` returns status `expired` with a null exit code, and `wait` rejects with `SandboxUnavailableError`. E2B's timeout is the only documented way the provider ends a sandbox on its own.
- **Configuration.** The keys are `sandbox.e2b.baseUrl` (https only, except loopback) and `sandbox.e2b.template`, plus the standard keys. The create timeout is `sandbox.e2b.leaseMs` in whole seconds, capped at one hour. The API key is the file credential `apiKey`, supplied through `POMTREED_SANDBOX_E2B_APIKEY_FILE`. It is read on every call and redacted from every message.

## Capabilities

The adapter declares only `list.byTag`, because the metadata filter on the list call is documented. Everything else is false. Idempotency is `tag-lookup`, tagging is `metadata`, output is `poll` (the port has no value for "no output"; `output()` yields nothing until envd is spoken), `maxLifetimeMs` is one hour (the Hobby plan limit; Pro allows 24 hours), and billing is per second, with nothing charged while paused.

## Provenance

The research notes this package relies on are second-hand summaries of docs.e2b.dev pages, made on 2026-11-11 and not byte-verified.

- **Documented:** `GET /v2/sandboxes?metadata=` with a URL-encoded `k=v&k=v` value, the 1-hour (Hobby) and 24-hour (Pro) lifetime limits, pause and resume paths, and E2B's statement that `POST /sandboxes` is deprecated in favour of `POST /v2/sandboxes`.
- **Inferred:** the create field names `templateID`, `timeout`, `metadata` and `envVars` (they match the vendored create schema in `@pomtree/testing`, whose own header says no source was consulted and every field is a guess), the default template `base`, `GET /sandboxes/{id}`, `DELETE /sandboxes/{id}`, the `X-API-Key` header, the base URL `https://api.e2b.dev`, the response fields (`sandboxID`, `state`, `clientID`), the state values `running` and `paused`, and the list page size 100.
- **Create path.** The adapter uses `POST /sandboxes` despite the deprecation note. The notes give no request or response schema for `POST /v2/sandboxes`, while the field names it does use are the ones the vendored schema (also inferred) describes for `POST /sandboxes`. Moving to `/v2` waits for a live recording.

## Unverified

These items stay open until a maintainer-approved live recording replaces the inferred fixtures.

- E2B's limits on metadata keys and values. `E2B_TAG_LIMITS` (128 characters of `[A-Za-z0-9._:-]`) is a guess, and annotation keys contain `/`.
- Paging of the v2 list call and its page size; only one page is read, and a full page fails closed (see the `e2b-list-pagination` TODO tag).
- Whether the v2 list returns paused sandboxes by default. If it does not, a replayed start for a paused sandbox would not find it and would create a second one.
- Whether `GET /sandboxes/{id}` answering 404 always means the sandbox is gone (rather than paused, or a transient routing miss).
- Whether a timed-out sandbox can be told apart from one deleted through the API, and whether E2B preempts sandboxes at all.
- The default create timeout: the FAQ says 5 minutes, while the REST schema says 15 (presumably seconds). The adapter always sends `timeout`.
- Whether create-time `envVars` are persisted or visible to others, which is why `secrets.env` is false.
- The REST endpoint behind the SDK's `setTimeout`, which is why `lease.extend` is false.
- envd, E2B's in-sandbox agent: its process, file and stream wire protocol is not documented in the notes.

## Not implemented (documented, deferred)

These features are documented by E2B but were left out of this adapter.

- Egress `network.allowOut` and `network.denyOut`. A spec with `egress` is refused rather than run unenforced. The vendored create schema has no `network` field either.
- Pause and resume (`POST /sandboxes/{id}/pause` and `/resume`) and snapshots (`POST /sandboxes/{id}/snapshots`).
- `spec.cmd`, `output()` streams and `resultWork`. All of them need envd (see the `e2b-envd-exec` TODO tag). A spec with `cmd` is refused, `output()` yields nothing, and `resultWork` throws.
- Template builds (`images.prepare`): the build API is documented for the SDK and CLI only.

## Tests

`pnpm --filter @pomtree/sandbox-e2b test` runs everything offline against the loopback provider stub from `@pomtree/testing`:

- strict replay of `src/fixtures/lifecycle.jsonl`;
- create dedup through the stateful stub, shaped as E2B by `src/stub-world.ts`;
- the shared conformance suite. `resolve-digest` is left out, because `imageIdentity` throws `SandboxCapabilityError` as the port prescribes without `image.digestAttest`. The main run stamps the owner's `store_id` and `daemon_epoch` labels on unlabelled specs, as pomtreed does, so `list-by-owner`'s "unlabelled sandbox is included" assertion is vacuous there (this backend deliberately never lists one); `label-rules` runs on the unwrapped adapter in its own test;
- fetch identity, 429 handling and credential redaction.

`src/live.test.ts` skips with the gate's printed reason unless `PTREE_LIVE_PROVIDERS=e2b`, `PTREE_LIVE_MAX_MICROS` and the key file are all set.
