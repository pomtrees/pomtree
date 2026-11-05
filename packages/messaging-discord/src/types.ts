import type {
  InboundBody as CoreInboundBody,
  HostAgentsBody as CoreHostAgentsBody,
  HostBudgetBody as CoreHostBudgetBody,
  HostErrorBody as CoreHostErrorBody,
  HostReportBody as CoreHostReportBody,
  MessageFailedBody as CoreMessageFailedBody,
  MessageReceipt as CoreMessageReceipt,
  OutboxEntry as CoreOutboxEntry,
} from "@pomtree/core";

// The pomtreed wire shapes are core's (packages/core/src/messaging.ts), instantiated for this channel. This package imports
// only types from @pomtree/core, so it can move to its own repo pinned to MESSAGING_API_VERSION.

// A `message_sent` journal entry as returned by `GET /v1/messages` (pomtreed's outbox). The adapter reads `seq`, `ts` and
// `agent` in addition to the payload, so it can coalesce alerts per agent and track per-entry retries.
export type OutboxEntry = CoreOutboxEntry<"discord">;

// The body POSTed to `POST /v1/messages`. The adapter sets `replyTo` (answers), `to`/`intent` (commands) and `pass`.
export type InboundBody = CoreInboundBody<"discord">;

// The Discord identity of an inbound sender.
export type DiscordSender = InboundBody["sender"];

// Host-scope read bodies (`GET /v1/host/...`): the `!ps`, `!budget` and `!report` sources.
export type HostAgentsBody = CoreHostAgentsBody;
export type HostBudgetBody = CoreHostBudgetBody;
export type HostReportBody = CoreHostReportBody;
export type HostErrorBody = CoreHostErrorBody;

// The receipt kinds are core's; ids, state and exit are opaque strings to the adapter.
export type MessageReceipt = CoreMessageReceipt<string, string, string>;

// An inbound Discord message from the injected transport.
export interface DiscordInbound {
  id: string; // Discord message id -> idempotencyKey
  authorId: string; // Discord user id -> sender.sender
  authorName?: string; // display name -> sender.name
  body: string; // message text -> body
  replyToText?: string; // content of the message being replied to (source for replyTo)
  replyToId?: string; // id of the message being replied to (verified as bot-authored before answering)
}

// The pomtreed HTTP client boundary (injectable; the real one speaks node:http).
export interface PomtreedClient {
  outbox(from: number): Promise<OutboxEntry[]>;
  postMessage(body: InboundBody): Promise<MessageReceipt>;
  // Host-scope read (`GET /v1/host<path>?sender=<sender>`). Returns the status and body as-is;
  // only a transport failure throws. `path` is e.g. "/agents" or "/agents/ID/budget".
  hostRead(path: string, sender: string): Promise<{ status: number; body: unknown }>;
  // Report a dead-lettered outbound message to pomtreed's audit trail (`POST /v1/messages/failed`).
  messageFailed?(body: MessageFailedBody): Promise<void>;
}

// `POST /v1/messages/failed`: a dead-lettered outbound message (wire limits: core MESSAGE_FAILED_*).
export type MessageFailedBody = CoreMessageFailedBody<"discord">;

// A failed Discord send. `retryAfterMs` is the parsed `Retry-After` header (milliseconds),
// non-null when Discord asked the adapter to back off (e.g. a 429 rate limit).
export class DiscordSendError extends Error {
  readonly status: number; // 0 = transport/network failure, otherwise the HTTP status
  readonly retryAfterMs: number | null;
  constructor(status: number, retryAfterMs: number | null, message: string) {
    super(message);
    this.name = "DiscordSendError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// A button attached to an outbound message; `customId` comes back in a DiscordInteraction.
export interface DiscordButton {
  customId: string;
  label: string;
  style?: "primary" | "secondary" | "success" | "danger";
}
// Buttons are laid out in rows of BUTTONS_PER_ROW, at most MAX_BUTTON_ROWS rows (Discord's component limits).
export const BUTTONS_PER_ROW = 5;
export const MAX_BUTTON_ROWS = 5;
export const MAX_BUTTONS = BUTTONS_PER_ROW * MAX_BUTTON_ROWS;
export const MAX_BUTTON_LABEL = 80;
export interface SendOptions {
  buttons?: readonly DiscordButton[];
}
// An edit of the message a button was on. `buttons` absent leaves the message's buttons as they are; an empty list
// removes them.
export interface EditOptions {
  buttons?: readonly DiscordButton[];
}
// A button press (a Discord message-component interaction): who pressed which button on which message. The real
// transport emits only presses on a message the bot itself authored, in the configured channel. `customId`,
// `buttonLabel` and `messageContent` come from that bot-authored message; `customId` is still parsed strictly
// (render.ts decodeAction) and is never trusted for the sender, rank or a secret.
export interface DiscordInteraction {
  id: string;
  userId: string;
  userName?: string;
  customId: string;
  messageId: string; // the message the button is on
  channelId: string;
  buttonLabel?: string; // the pressed button's label, as rendered on the message
  messageContent?: string; // the message's current text
  // Opaque to the adapter: the transport's key for acknowledging and editing this interaction. The interaction
  // token never leaves the transport, so logging or serialising a DiscordInteraction cannot leak it.
  handle: object;
}

// The Discord transport boundary (injectable; the real one is the Discord bot).
export interface DiscordTransport {
  // Returns the id of the created Discord message so the adapter can correlate it back to the
  // escalation it carries (`replyTo`) without parsing `es-…` out of message text. Throws
  // DiscordSendError on failure.
  send(channelId: string, content: string, opts?: SendOptions): Promise<string>;
  // Button presses (Discord message-component interactions). A transport that emits them also implements
  // deferUpdate and editInteraction.
  onInteraction?(handler: (i: DiscordInteraction) => void | Promise<void>): () => void;
  // Acknowledges a press without changing the message (DEFERRED_UPDATE_MESSAGE); Discord needs this within 3 s.
  deferUpdate?(i: DiscordInteraction): Promise<void>;
  // Edits the message the pressed button is on (after deferUpdate). Throws DiscordSendError on failure.
  editInteraction?(i: DiscordInteraction, content: string, opts?: EditOptions): Promise<void>;
  onMessage(handler: (msg: DiscordInbound) => void | Promise<void>): () => void;
  // Answers whether the bot authored the message with `messageId`.
  isBotAuthored(channelId: string, messageId: string): Promise<boolean>;
  start?(): Promise<void>;
  stop?(): void;
}

// A dead-lettered outbox entry, recorded (persisted to the cursor file) once an entry exceeds
// its retry cap. This is the adapter's journaled `message_failed` record.
export interface DeadLetter {
  seqs: number[]; // journal seqs this dead-letter covers (coalesced alerts cover several)
  agent: string; // the agent the alert/entry was for
  subject: string; // the rendered content that failed to send
  reason: string; // why it failed (Discord status or transport error)
  at: number; // epoch ms
}

// Durable outbox state held in the visible cursor file: the poll cursor, per-entry attempt
// counts, an outstanding Retry-After backoff, and the dead-letter journal.
export interface OutboxState {
  cursor: number; // inclusive lower bound for the next poll
  attempts: Record<string, number>; // seq -> failed-send count
  retryAfter: number | null; // epoch ms; no sends until this time
  deadLetters: DeadLetter[]; // journaled message_failed records
}

// Outbox-state persistence boundary (injectable; the real one is a visible file).
export interface OutboxStore {
  read(): Promise<OutboxState>;
  write(state: OutboxState): Promise<void>;
}

export interface Config {
  token: string; // host token (contents of the POMTREED_MESSAGING_TOKEN file)
  baseUrl: string; // pomtreed base URL
  discordToken: string; // Discord bot token
  discordChannelId: string; // outbound Discord channel
  cursorPath: string; // cursor file path
  pairingsPath: string; // persisted sender pairings file (plain JSON, see pairings.ts)
  pollIntervalMs: number; // outbox poll interval
  // Sender allowlist (Discord user ids). Empty/absent = deny everyone (default-deny); a
  // configured list admits only the listed ids.
  allowedSenders: string[];
  agentAllowlists?: Record<string, string[]>; // per-agent answer allowlists (DISCORD_AGENT_ALLOWLISTS JSON)
  passButton?: boolean; // render a Pass button on asks and approvals (DISCORD_PASS_BUTTON=1; default off)
}
