# @pomtree/messaging-discord

A pomtreed messaging adapter for Discord: it posts the user outbox (asks, alerts, status, reports) to one channel, turns replies, `!` commands and button presses into `POST /v1/messages`, and answers `!ps`, `!budget` and `!report` from pomtreed's host read routes. Configuration (`DISCORD_*`, `POMTREED_URL`, `POMTREED_MESSAGING_TOKEN`) is read in `src/config.ts` and stays local to this package; [docs/configuration.md](../../docs/configuration.md) lists the variables.

## Boundary

The package is an extension that is meant to move to its own repository. It depends only on:

- `@pomtree/core`, as type-only imports of the messaging wire contract in `packages/core/src/messaging.ts` (`InboundBody`, `OutboxEntry`, `MessageFailedBody`, `MessageReceipt`, the host read bodies), instantiated for the `"discord"` channel in `src/types.ts`. An out-of-repo copy pins `MESSAGING_API_VERSION`: `src/client.ts` declares the expected value typed as `typeof MESSAGING_API_VERSION` (so a core bump fails the typecheck) and refuses any response whose `x-pomtree-messaging-api` header is a different version, or absent on a 2xx, with a `MessagingVersionError` (`cause` is `missing` or `mismatch`).
- Four exact-pinned Discord packages: `@discordjs/core`, `@discordjs/ws`, `@discordjs/rest` and `discord-api-types` (see `package.json`). Nothing else from the repository is imported.

It talks to pomtreed only over HTTP with the host token (`src/client.ts`):

- `GET /v1/messages?channel=discord&from=<seq>`: the outbox.
- `POST /v1/messages`: answers (`replyTo`, and `pass` for a Pass press), commands (`to`, `intent`), keyed by `idempotencyKey`.
- `POST /v1/messages/failed`: a dead-lettered outbound message.
- `GET /v1/host/agents`, `/v1/host/agents/:id/budget`, `/v1/host/agents/:id/report` with `sender=`.

The Discord test fakes (`src/fakes.ts`: a gateway and a REST built on `makeRequest`) live here rather than in `@pomtree/testing` for the same reason: they depend on the Discord libraries.

## Transport

`src/discord.ts` `gatewayTransport` holds a gateway (WebSocket) connection for messages and button presses and uses the REST API for sends, interaction acknowledgements, edits and catch-up. It requests the `GuildMessages` and `MessageContent` intents. Inbound delivery is at least once: the cursor (the last delivered message id) advances only after pomtreed accepts a message, every READY catches up from the cursor over REST because a fresh identify does not replay missed events, and a failed delivery stops live delivery until a catch-up re-delivers from the cursor. The cursor lives in memory: on restart it is primed at the channel's newest message, so messages posted while the adapter was down are not replayed.

## Buttons

An ask from the outbox gets buttons when pomtreed says what it is (`src/render.ts` `askButtons`): Approve and Deny for an approval (`subjectKind: "approval"`, or an `ap-` id when `subjectKind` is absent), one button per option for an ask with 1 to 25 `options`, and otherwise none (answer by replying). A Pass button is added only with `DISCORD_PASS_BUTTON=1`.

A press arrives as an interaction. The adapter acknowledges it first (`DEFERRED_UPDATE_MESSAGE`, since Discord fails a press not acknowledged within 3 s), posts the decision to pomtreed as the reply a human would type (`approve`, `deny`, the option text, or `pass`), then edits the message with the outcome and removes the buttons. If pomtreed cannot be reached the message says "failed, press again" and keeps its buttons. The idempotency key is `btn:<message id>:<user id>:<choice>`, so a double press is one decision, and a second person's conflicting press is shown "already decided".

## Security

- Who may press: the same rules as a text reply. The presser must be on `DISCORD_ALLOWED_SENDERS` or paired, and allowed to address the ask's agent (`DISCORD_AGENT_ALLOWLISTS`); after a restart, when the message's agent is unknown, only a sender on every allowlist may press. pomtreed re-checks the sender and its own rate limits. Pairing buttons (`pair:approve|deny:<id>`) are pressable only by configured senders.
- `custom_id` is untrusted input. It is `pm1:<ap-/es- id>:<choice>`, at most 100 characters, parsed strictly (`decodeAction`), and carries no secret, sender or rank. When the adapter knows which id a message carries, a button naming another id is refused.
- Component ownership: the transport emits only presses on a message the bot itself authored (checked against the bot user id from READY or `users/@me`), in the configured channel. Other channels and other authors are ignored, so another bot instance can answer its own.
- Tokens: the bot token and interaction tokens are never logged or put in an error message. An interaction's token stays inside the transport, keyed by an opaque handle, and is scrubbed from REST error text. All sends and edits use `allowed_mentions: { parse: [] }`.

## Live verification

The tests are offline (`pnpm --filter @pomtree/messaging-discord test`). Known gap: the adapter has never been run against live Discord, and an agent cannot check the live path, which needs:

1. A Discord application with a bot user, with the privileged Message Content intent enabled in the developer portal.
2. A test guild with one text channel; the bot invited with View Channel, Send Messages and Read Message History there.
3. The bot token in `DISCORD_TOKEN`, the channel id in `DISCORD_CHANNEL_ID`, your user id in `DISCORD_ALLOWED_SENDERS`, a running pomtreed with `discord` in `POMTREED_MESSAGING_CHANNELS` and `POMTREED_ESCALATION_CHANNELS` and `POMTREED_MESSAGING_SENDERS=discord:<your user id>` (pomtreed refuses to start with a chat channel and no sender list; the adapter's own `DISCORD_ALLOWED_SENDERS` does not satisfy it), and its host token file in `POMTREED_MESSAGING_TOKEN`.
4. Network access to discord.com and the gateway.

Then check: the adapter connects and logs no errors; a message posted while it is running reaches pomtreed once; a message posted while it is stopped is not replayed after restart, and one posted during a gateway reconnect is caught up; an approval shows Approve and Deny, a press acknowledges within 3 s and the message is edited with the outcome and no buttons; a second user's press shows "already decided"; a press by an unlisted user changes nothing; with pomtreed stopped a press shows "failed, press again" and keeps the buttons.
