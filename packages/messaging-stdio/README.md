# @pomtree/messaging-stdio

A pomtreed messaging adapter for a terminal: it prints the user outbox (asks, alerts, status, reports) to stdout and turns typed lines into `POST /v1/messages`. It is the second adapter next to Discord and exists to show that a new adapter needs no change in `@pomtree/core` or pomtreed: its wire conformance is the shared suite in `packages/e2e/src/messaging-wire-contract.test.ts`.

## Grammar

One line per message; blank lines are ignored.

- `#<escalation> <text>`: answer an open ask or approval.
- `@<agent> <text>`: signal an agent.
- `!status <agent>`, `!cancel <agent>`: commands.

Each outbox entry prints as `[<purpose>] <agent>: <subject>`; an ask adds `(answer: #<id> <text>; options: a | b)`. Receipts print as one line, and a refusal as `rejected: <reason>`. Lines are posted with the idempotency key `stdio:<session>:<line>`, and a failed delivery is retried with the same key.

## Configuration

Read in `src/config.ts`; nothing here is a `POMTREED_*` setting of pomtreed's.

- `POMTREED_MESSAGING_TOKEN` (required): path to the host token file for the channel.
- `MESSAGING_STDIO_SENDER` (required): your sender id; it must be on pomtreed's allowlist as `stdio:<id>`.
- `POMTREED_URL` (default `http://127.0.0.1:8080`), `MESSAGING_STDIO_CHANNEL` (default `stdio`), `MESSAGING_STDIO_POLL_MS` (default `1000`).

## Boundary

The package depends only on type-only imports of the wire contract in `packages/core/src/messaging.ts` and on pomtreed's HTTP routes (`GET/POST /v1/messages`, `POST /v1/messages/failed`) with a host token. `src/client.ts` pins `MESSAGING_API_VERSION` typed as `typeof MESSAGING_API_VERSION` and refuses a response of another version, or without the header on a 2xx. It has no host read client, so the suite's `host-read` clause is skipped for it. The outbox cursor lives in memory: a restart replays from the start.

## Enabling it on pomtreed

Set `POMTREED_MESSAGING_CHANNELS=stdio`, `POMTREED_ESCALATION_CHANNELS=stdio` and `POMTREED_MESSAGING_SENDERS=stdio:<id>` (pomtreed refuses to start with a chat channel and no sender list), enable the host endpoint (`host.listen`, see [docs/extending.md](../../docs/extending.md) section 2.1), and restart pomtreed. At boot pomtreed issues the host token for the channel as `messaging.stdio.token` in its state dir; point `POMTREED_MESSAGING_TOKEN` at that file (the adapter reads the token from it, as the Discord adapter does; see [messaging-discord](../messaging-discord/README.md)). Then run `pomtree-stdio` (`src/main.ts`).
