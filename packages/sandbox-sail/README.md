# @pomtree/sandbox-sail

The `sail` sandbox backend: the `Sandbox` port on Sail Research's Sailboxes, persistent Linux microVMs behind a REST API. The package ships the provider (`sailProvider` in `src/provider.ts`), its config manifest and its tests. Registering it as a built-in backend in the daemon is a separate task; until then the daemon cannot select it.

Nothing here was checked against the live API. The adapter and its replay fixtures were written from the vendor documentation (read 2026-11-11, sources in each fixture header), so every fixture is marked `inferred`. A pass of the offline tests proves the adapter's control logic against the documented shapes, not Sail's behaviour.

## Configuration

`sandbox.sail.baseUrl` (default `https://sailbox-api.sailresearch.com/v1`) is the only backend-specific key. It must be https, because the API token is sent to it; plain http is accepted only for a loopback address (a local stub or proxy). The standard keys (`leaseMs`, `region`, rates and spend ceilings) come from the config composer. The API key is the `apiToken` credential, supplied only as a mode-600 file. Sail documents no regions, so a non-empty `sandbox.sail.region` is refused when the adapter is built.

## How the port maps onto Sailboxes

- **Create and deduplication.** `start` creates a sailbox through the kit's `createOnce` with the `native-token` mechanism: the `Idempotency-Key` header carries the sandbox id derived from the caller's key, and the body is serialised with sorted keys so a replay is byte-identical (Sail refuses a reused key with a different body). Before creating, and after an unknown outcome, the adapter lists sailboxes and adopts the one carrying this key's tags. The declared key window is 10 minutes, the shorter of the two retention bounds the idempotency page gives.
- **Tags.** Sail has no labels or metadata and names are not unique. The resource name (`pomtree-<32 hex of the sandbox id>`) marks a sailbox as pomtree's; the owner tags (sandbox id, agent, backend, host, generation) and the spec's labels ride in one create-time variable, `SANDBOX_OWNER_TAGS`, because the documentation says create-time `env` is returned by get and list. That variable is visible inside the box and is not secret. A sailbox whose name and tags disagree is treated as foreign. The host and generation come from `SandboxSpec.host` and `SandboxSpec.generation`, and `list` and `inspect` read them back.
- **Listing.** There is no server-side tag filter (`list.byTag` is false), so `list(owner)` reads every sailbox and filters on the client: another store id or a newer daemon epoch is excluded. The daemon's owner labels (`store_id`, `daemon_epoch`) come back in `labels`, with the host and generation, which is what remote reconcile's ownership check reads.
- **Trust.** One API key is one trust domain. The name prefix and owner tags are identifiers, not secrets: anyone holding the same key, or another key of the same account, can create a sailbox with a matching name and tags, and the adapter will treat it as pomtree's. This is not a security boundary between tenants of one account; give each deployment its own account or key.
- **Command.** Sail never runs an image's `ENTRYPOINT` or `CMD`, so `spec.cmd` runs as a background exec. Without `cmd` the box starts idle and runs until stopped.
- **Stop, kill and exit.** A sailbox has no graceful stop that ends it, so both terminate it; this adapter then reports exit 137. A sandbox absent from a complete listing is gone, which the port counts as success; a listing that may be partial makes them fail instead (see Limits). A sailbox that ends without pomtree terminating it (lifetime, provider action) inspects as `terminated` with no exit code, and `wait` rejects, because the port cannot carry an expired or preempted reason yet.
- **Channels.** `connect` opens the documented port tunnel (WebSocket, binary frames, `{"type":"eof"}` half-close) to a fixed port per channel (`SAIL_CHANNEL_PORTS`). A tunnel that closes before the box sends eof was cut, and its reader throws.

- **Create failures.** A 5xx, a 408, a 409 or a lost connection leaves a create's outcome unknown, so the adapter looks the sandbox up by its tags before anything else; other 4xx answers are definite refusals. Provider error bodies are shown with the token and every echoed `env` object removed.
- **Image identity.** Sail does not report what it ran, so `image.digestAttest` is not declared and `imageIdentity` throws `SandboxCapabilityError`: the daemon resolves identity from the registry. The shared `resolve-digest` conformance clause assumes every backend attests, so this package's run leaves it out.

## Limits

The adapter reads one page of `GET /sailboxes`. A reply with `SAIL_LIST_PAGE_SIZE` (100, an inferred default page size) or more sailboxes, or with a next-page marker, is refused with `SailListTruncatedError`, and `list`, `attach`, `inspect`, `stop` and `kill` fail loudly instead of treating a box past the first page as gone. So the key may see at most 99 sailboxes in all, pomtree's or not. Paging is tracked as `sail-list-paging`.

## Declaration

Declared true: `connect` (the tunnel), `image.ociPull` (images pinned as `name@sha256:<digest>`) and `isolation.microvm` (every box runs its own kernel). Everything else is false because its REST shape was not read or the adapter does not implement it. `resources.limits` is false because pids limits are not documented, and boot admission refuses a backend without it, so the daemon will not admit `sail` until that is settled (`provider.test.ts` pins this).

## Unverified

Each item is inferred from documentation or chosen without it, and needs a recorded exchange before it is trusted.

- The terminate endpoint: the documentation names an idempotent terminate; the adapter uses `DELETE /sailboxes/{id}` and treats 404 as gone.
- Status values (`running`, `sleeping`, `paused`, `terminated` and others): a record without a status is read as running.
- The list reply envelope (`{"sailboxes": [...]}`), its default page size and its next-page marker (see Limits).
- Name length and character limits; the adapter assumes a 63-character DNS label.
- Whether create's `image` takes a registry reference directly or only a built Sail image (the SDK builds registry images through `from_registry`).
- Exec: the `command` and `background` field names, the `exec_id` field of the `started` event, the exec status endpoint `GET /sailboxes/{id}/exec/{execId}` and its `exit_code` field, and whether the exec endpoint honours `Idempotency-Key`.
- Exec output event shapes; until they are known, `output()` yields nothing and `resultWork` refuses.
- Error bodies and status codes beyond those the create page names (the adapter reads 401 and 403 as a bad key, 404 as gone, and 5xx, 408 and 409 as an unknown outcome on create).
- The idempotency model of the loopback stub (a replayed key returns the first resource, a different body is refused) is itself a reading of the documentation, not observed behaviour.
- A tunnel's end-of-stream marker is matched exactly (`{"type":"eof"}`); any other text frame fails the channel, by design (fail closed).
- Whether a terminated sailbox stays readable (the lifecycle page says at least a day) and what a provider-ended box reports.
- No agent image listens on the channel ports yet.
