import type {
  AgentId,
  AgentState,
  EscalationId,
  ExitStatus,
  JournalEntry,
  JsonValue,
  MessageFailedPayload,
  MessageKind,
  MessageSentPayload,
  MessagingChannel,
  MessagingSender,
} from "./types.ts";

// The inbound-message contract shared by pomtreed and the messaging adapters, declared once. The adapters never import pomtreed,
// so the list and the receipt shape live here; each side derives its own types from them.
export const INBOUND_INTENTS = ["answer", "signal", "spawn", "cancel", "status", "launch"] as const;
export type InboundIntent = (typeof INBOUND_INTENTS)[number];

// The receipt a delivered inbound message returns. The generics let an adapter that holds opaque strings (ids, state, exit)
// reuse the same kinds; pomtreed uses the defaults.
export type MessageReceipt<Agent extends string = AgentId, State extends string = AgentState, Exit = ExitStatus> =
  | { kind: "answered"; escalation: EscalationId }
  | { kind: "signaled"; to: Agent }
  | { kind: "spawned"; agent: Agent }
  | { kind: "launched"; agent: Agent }
  | { kind: "cancelled"; agent: Agent }
  | { kind: "status"; agent: Agent; state: State; exit?: Exit | null }
  | { kind: "rejected"; reason: string };

export type ReceiptKind = MessageReceipt["kind"];

// Record<ReceiptKind, true> makes adding or removing a kind in MessageReceipt a compile error here until the list follows.
const RECEIPT_KIND_SET: Record<ReceiptKind, true> = {
  answered: true,
  signaled: true,
  spawned: true,
  launched: true,
  cancelled: true,
  status: true,
  rejected: true,
};
export const RECEIPT_KINDS = Object.keys(RECEIPT_KIND_SET) as readonly ReceiptKind[];

// ---- The messaging wire contract (pomtreed's host-scope HTTP routes <-> a messaging adapter) ----
// The single definition of every body an adapter sends to or reads from pomtreed. Both sides import these; neither keeps a
// hand-written copy. An adapter outside this repo pins MESSAGING_API_VERSION: it changes when a shape here changes
// incompatibly (a field removed, renamed, retyped or made required). Adding an optional field does not change it, so a
// reader must ignore fields it does not know. The `Channel` parameter lets an adapter narrow `channel` to its own literal
// (e.g. "discord"); pomtreed uses the default (any channel name).
export const MESSAGING_API_VERSION = 1 as const;

// `POST /v1/messages` (host token). `replyTo` answers an open escalation or approval; `to` addresses an agent directly;
// `intent` selects a command (cancel/status need `to`; "launch" names `workflow` and its JSON `input`, default {}, and
// may omit `body`, read as ""). `pass` with `replyTo` abstains and hands the ask/approval up one rung (`body` ignored).
// The route takes `channel` from the body (it must equal the host token's channel) and always overwrites `sender.channel`
// with it. It also accepts `sender` as a bare id string with an optional top-level `name`; this type is the object form.
// The response is a MessageReceipt (201).
export interface InboundMessage<Channel extends MessagingChannel = MessagingChannel> {
  channel: Channel;
  sender: MessagingSender & { channel: Channel };
  body: string;
  replyTo?: EscalationId;
  to?: AgentId;
  intent?: InboundIntent;
  workflow?: string;
  input?: JsonValue;
  pass?: boolean;
  idempotencyKey: string;
}

// The adapter-side name of the same body.
export type InboundBody<Channel extends MessagingChannel = MessagingChannel> = InboundMessage<Channel>;

// One row of `GET /v1/messages?channel=&from=` (host token): a `message_sent` journal entry for the channel with
// seq >= from, returned as a JSON array. The route returns the whole JournalEntry (host, generation, traceparent too); an
// adapter relies only on the fields below. `ts` is the journal timestamp (epoch ms); `agent` is the journal it is on.
export interface OutboxEntry<Channel extends MessagingChannel = MessagingChannel> extends Pick<JournalEntry, "seq" | "ts" | "agent"> {
  payload: MessageSentPayload & { channel: Channel };
}

// Wire limits of `POST /v1/messages/failed`: longer fields are refused (400). The journaled `message_failed` clips its
// reason further, to MESSAGE_FAILED_JOURNAL_REASON_MAX.
export const MESSAGE_FAILED_SUBJECT_MAX = 500;
export const MESSAGE_FAILED_REASON_MAX = 2000;
export const MESSAGE_FAILED_JOURNAL_REASON_MAX = 500;

// `POST /v1/messages/failed` (host token): an adapter reports an outbound message it dead-lettered. Journaled on the root as
// a `message_failed` keyed by (channel, idempotencyKey), so a replay adds nothing. The response is `{ recorded: true }` (201).
export interface MessageFailedBody<Channel extends MessagingChannel = MessagingChannel> extends Omit<MessageFailedPayload, "kind" | "channel" | "purpose"> {
  channel: Channel;
  purpose: MessageKind;
  idempotencyKey: string;
}

// Host-scope read routes for chat commands: `GET /v1/host/agents[?state=]`, `/v1/host/agents/:id/budget`,
// `/v1/host/agents/:id/report`, each with `sender=<chat sender id>`. A non-200 response is a HostErrorBody.
export interface HostAgentView<State extends string = AgentState> {
  id: string;
  state: State;
  parent: string | null;
  name: string;
  createdAt: number;
  updatedAt: number;
  spentMicros: number;
  budgetMicros: number;
}

export interface HostAgentsBody<State extends string = AgentState> {
  agents: HostAgentView<State>[];
}

export interface HostBudgetBody {
  id: string;
  budgetMicros: number;
  spentMicros: number;
  remainingMicros: number;
}

// `report` is the sanitized result summary: null when the agent has no result yet.
export interface HostReportBody<State extends string = AgentState, Exit extends string = ExitStatus> {
  id: string;
  state: State;
  exit: Exit | null;
  report: string | null;
}

// Every pomtreed error response body.
export interface HostErrorBody {
  error: string;
}
