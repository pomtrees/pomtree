# hn-digest scenario runner

`scenario.mts` drives the hn-digest workflow through the real stack (`runtime.mts`: SQLite, dir reports, daemon, CLI socket, host HTTP) and the real `DiscordAdapter` over a scripted Discord transport. Metadata only: no model, sandbox, harness, provider, or real Discord.

## Commands

- Offline tests (default, no network, about 20 s): `node --test examples/hn-digest/scenario.test.mts examples/hn-digest/handler.test.mts examples/hn-digest/logic.test.mts`
- Direct offline run: `node examples/hn-digest/scenario.mts` (optional `--deadline-ms N`, integer 1..180000)
- Live HN: `POMTREED_WORKFLOW_FETCH_USER_AGENT="hn-digest (+https://example.org/contact)" node examples/hn-digest/scenario.mts --live-hn` (the User-Agent is optional: it defaults to `pomtree`, and a contact in it is recommended). Not run by tests. Live runs are never retried automatically.

## Source budget (live and offline share the same caps)

- Exact origin `https://hacker-news.firebaseio.com`, port 443, no credentials, query or fragment.
- Paths only: `/v0/topstories.json` or `/v0/item/<positive safe integer>.json`.
- At most 3 feed dispatches (first plus two refreshes) and 10 item dispatches. Dispatches are counted before any request.
- The ordinary run is 2 feeds and 4 items (two launches with `limit: 2`). Counts are reported as dispatches, responses and failures separately.
- 10 s per request, response body cap 262144 bytes, serial fetches. No redirects (refused in the lower layer), no articles, comments, login, or writes.
- Live DNS: `resolveDns` is omitted, so the existing lookup, blocked-address check and connect pin run. Offline uses a stubbed `1.1.1.1` only.
- Whole run: `deadlineMs` (integer 1..180000, default 180000) bounds every fetch, CLI call, and wait. About 5 s (or a quarter of a short deadline) is kept free for `runtime.close()`. Options can lower the cap, never raise it.

## Simulated services

- Discord: scripted transport records every outbound body in `transcript.json`. Inbound replies go through `DiscordAdapter.handleInbound`. No exactly-once Discord delivery is claimed: report and outbox keys are fixed per run, not Discord posts.
- Model: none. This runner stays metadata-only. The offline model planner that consumes its artifact is described in [Insight model scenario](#insight-model-scenario).

## Artifacts

Under `artifactDir` (default `mkdtemp(os.tmpdir(), 'hn-scenario-')`, kept after a run):
- `manifest.json`: `status` (`passed` | `failed`), `live`, `timing`, `dispatch`, `checks`, `counts`, `phases`, `runIds`, `reportIds`, `entryIds`, `outboxPurposes`, `unusedCalls`, `simulatedDiscord`.
- `source/sources.json`: array of `{url, status, sha256, fetchedAt, bytes, file}`; `file` is an absolute path under `artifactDir/source/raw/`. `model-scenario.mts` consumes this directory layout (see [Insight model scenario](#insight-model-scenario)).
- `transcript.json`: simulated Discord posts in order.

The manifest and transcript contain no tokens or secrets. A failed run exits nonzero. The manifest carries local artifact/diagnostic paths,
and the source index uses absolute raw paths. To relocate an artifact for the offline model planner, rewrite index `file` paths relative to the
artifact root (for example `source/raw/<sha256>.json`); the loader still realpath-fences every referenced file.

## Semantics

- Fixed keys make retries idempotent: report, outbox and seen writes are keyed per run.
- Declines clear the plan (per-plan semantics), leave seen unchanged, and add no tombstone.
- The handler acks only deliveries in its own inbox. Confirmation is persisted before its ack; if the ack fails, a repair does not reask or republish.
- A feed with zero ids fails the run (nothing is planned or marked seen); "No new posts" means every feed id was already seen, and the report and outbox say `feed N ids, M seen`. A fetch or parse failure keeps a short cause (`errorCause` in `logic.mts`: credentials and query strings redacted, clipped).
- Insights are not implemented: a nonzero `insightBudgetMicros` is rejected.
- Report and outbox are root-owned; access follows report-view auth. Links, recurring cron and browser flows are deferred.
- Cooperative trust, not isolation: the reviewed in-process host is admitted only through `reviewedOwners` (production owners default false).

## Insight model scenario

Files: `model-scenario.mts`, `model-scenario.test.mts`, `insight.mts` (workflow `hn-insight/synthesize`), and the additive `packages/e2e/src/live-model.ts` option `fetch` (injection point, default unchanged). This path has never run against a live provider.

### Offline (default)

```
node examples/hn-digest/model-scenario.mts --source-artifact DIR
node --test examples/hn-digest/model-scenario.test.mts
```

`DIR` is the artifact directory written by the metadata scenario (`scenario.mts`), the single supported input: `DIR/manifest.json` (`status: "passed"`, boolean `live`), `DIR/source/sources.json` (array of `{url, status, sha256, fetchedAt, bytes, file}`), raw bodies under `DIR/source/raw/`. The loader (`loadSourceArtifact`):

- reads only regular files, checks their sizes before reading and also caps reads; uses nonblocking opens so a FIFO is refused, not awaited; fences every path by realpath (index inside `source/`, raws inside `source/raw/`; escaping symlinks and `..` refused), caps the index at 13 records and manifest, index and each raw at 262144 bytes;
- verifies byte count and sha256 of every raw body it relies on (the first successful feed and each selected item);
- normalizes with the shared `logic.mts` parsers (`parseFeed`, `selectRanked`, `parseItem`): feed order gives rank, the first 3 captured parseable items among the first 10 unique feed IDs become the planning input, and `sourceUrl` is derived, never fetched;
- keeps raw sha256 values as provenance (`feed`, `provenance`) separately from `inputSha256`, the hash of the normalized input;
- never throws: unreadable, malformed, escaping, oversize or mismatched input yields a refusal reason (CLI exit 1).

A file path is refused ("must be a directory"). No temporary resources are created, and no credentials, Docker or network are touched.

### Live path (not enabled)

`--live-deepseek` is a positive opt-in and exits 3, fail-closed, for any path. It additionally requires `manifest.live === true` and prints the refusal reason when the artifact does not qualify. It does not open a runtime, read credentials or contact the network. Enabling it needs extension-gateway wiring like pomtreed's own (`createExtGateway` with a capture broker, in `packages/pomtreed/src/main.ts`).

### Guards (pre-dispatch, fail-closed)

- Origin `https://api.deepseek.com`, path `/chat/completions`, no query, POST only.
- `model === "deepseek-flash"`; integer `1 <= max_tokens <= 1024`.
- At most 2 dispatched upstream attempts; the 3rd is refused before the inner fetch. Redirects are not followed. A cleared, ref'ed 60s request timer supplies the transport signal and also bounds response reads; injected transports must honor that signal during dispatch.
- Provider response accumulation is capped at 262144 bytes; the wrapper consumes the original response (never clones or tees it), releases the reader and returns a new response over the bounded bytes. The cap bounds retained bytes, not an injected transport's allocation of a single chunk.
- Oversize bodies record `truncated`; transport and body-read errors record `failed` without a hash or token details and propagate. Refused or failed responses abort the transport and join body cancellation for up to 250ms; rejection or an incomplete join records `cleanupFailed`. Late cancellation rejections are handled. The reader lock and timers are released even on failure.
- An external unread clone sibling belongs to the injecting caller. Its cancellation cannot be forced through the consumed branch; such an incomplete join is bounded and visible, not a guarantee that an uncooperative transport released its resources.
- Budget total 100000 micros; items 1..3.
- Metrics hold only attempt, model, maxTokens, status, body sha256, non-negative safe-integer token counts and the truncated, failed and cleanupFailed flags. No headers, keys, or prompts.
- Source-capture helpers (`guardSourceRequest`, `remainingSourceBudget`, `mapDiscussionToItems`) are pure and unused by the live path.

### Limitations

- Known gap: no live HN, model, Docker or provider run exists, so settled cost and provider-bill parity are unmeasured (the local reservation is not a provider hard cap).
- Known gap: the live path has no canonical CLI wiring for capture-then-synthesize, no live `sourceFetch` transport, no attempt counters that persist across launches, and no record of the child's actual provider, model and egress.
- Discussion capture and sentiment are not part of the metadata artifact, so the offline plan carries no discussion samples.
- If a feed or item was captured more than once, its first successful record is used. An artifact spans multiple launches: the offline plan combines captured items using that first feed's ranking, not necessarily one launch or the latest snapshot. The emitted raw hashes and timestamps identify the selected records. Known gap: no run or snapshot-selection policy exists yet.
