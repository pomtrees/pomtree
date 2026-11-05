import type { EscalationId, MessageKind } from "@pomtree/core";
import type { DiscordButton, HostAgentsBody, HostBudgetBody, HostReportBody, MessageReceipt } from "./types.ts";
import { MAX_BUTTON_LABEL, MAX_BUTTONS } from "./types.ts";

type HostAgentView = HostAgentsBody["agents"][number];

// Discord's maximum message content length (characters).
export const MAX_OUTBOUND_LENGTH = 2000;

const TRUNCATION_MARKER = "… [truncated]";

// Renders a `message_sent` journal entry into the Discord message text. Long subjects are
// truncated to Discord's 2000-character limit with an explicit marker so a single oversized
// ask cannot make `send` fail and wedge the outbox.
export function renderOutbound(purpose: MessageKind, subject: string): string {
  const full = `[${purpose}] ${subject}`;
  if (full.length <= MAX_OUTBOUND_LENGTH) return full;
  return `${full.slice(0, MAX_OUTBOUND_LENGTH - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

// Renders a coalesced batch of alerts into one Discord message: one `[alert]` prefix with the
// individual subjects joined by newlines, still truncated to the Discord limit.
export function renderAlertBatch(subjects: string[]): string {
  return renderOutbound("alert", subjects.join("\n"));
}

// Renders pomtreed's receipt back to the human who sent the inbound message (the ack).
export function renderReceipt(receipt: MessageReceipt): string {
  switch (receipt.kind) {
    case "answered":
      return `✓ answered ${receipt.escalation}`;
    case "signaled":
      return `✓ signaled ${receipt.to}`;
    case "spawned":
      return `✓ spawned ${receipt.agent}`;
    case "launched":
      return `✓ launched ${receipt.agent}`;
    case "cancelled":
      return `✓ cancelled ${receipt.agent}`;
    case "status":
      return `${receipt.agent}: ${receipt.state}${receipt.exit ? ` (${typeof receipt.exit === "string" ? receipt.exit : JSON.stringify(receipt.exit)})` : ""}`;
    case "rejected":
      return `✗ rejected: ${receipt.reason}`;
  }
}

// Renders a host read (`!ps`, `!budget`, `!report`) body for the human. All pomtreed-supplied
// strings (names, ids, states, reports) are untrusted free text; the caller wraps the result in
// renderOutbound, which caps it to the Discord limit.
const PS_MAX_LINES = 20;

function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

// The body is read defensively: the declared shapes are core's, but a field may be missing on the wire.
export function renderHostBody(verb: "ps" | "budget" | "report", body: unknown): string {
  if (verb === "ps") {
    const b = (body ?? {}) as Partial<HostAgentsBody>;
    const agents = (Array.isArray(b.agents) ? b.agents : []) as Partial<HostAgentView>[];
    if (agents.length === 0) return "no agents";
    const lines = agents.slice(0, PS_MAX_LINES).map((a) => {
      const name = a.name ? ` ${String(a.name)}` : "";
      return `${String(a.id)} ${String(a.state)} ${dollars(Number(a.spentMicros))}/${dollars(Number(a.budgetMicros))}${name}`;
    });
    if (agents.length > PS_MAX_LINES) lines.push(`… ${agents.length - PS_MAX_LINES} more`);
    return lines.join("\n");
  }
  if (verb === "budget") {
    const b = (body ?? {}) as Partial<HostBudgetBody>;
    return `${String(b.id)}: spent ${dollars(Number(b.spentMicros))} of ${dollars(Number(b.budgetMicros))}, remaining ${dollars(Number(b.remainingMicros))}`;
  }
  const b = (body ?? {}) as Partial<HostReportBody>;
  const report = typeof b.report === "string" ? b.report : "no report";
  return `${String(b.id)} ${String(b.state)}(${String(b.exit ?? "-")}): ${report}`;
}

// The ids an ask can carry: an escalation is "es-" + 64 lowercase hex (pomtreed escalationIdFor), an approval "ap-" + 32
// lowercase hex (pomtreed approvalIdFor). Neither may run on into more hex.
const ESCALATION_ID = "es-[0-9a-f]{64}";
const APPROVAL_ID = "ap-[0-9a-f]{32}";
const ESCALATION_RE = new RegExp(`(?:${ESCALATION_ID}|${APPROVAL_ID})(?![0-9a-f])`);
export const APPROVAL_ID_RE = new RegExp(`^${APPROVAL_ID}$`);
export const ESCALATION_ID_RE = new RegExp(`^${ESCALATION_ID}$`);

// Extracts an escalation or approval id from free text (a Discord reply or the message it replies to).
export function parseEscalationId(text: string | undefined): EscalationId | undefined {
  return text?.match(ESCALATION_RE)?.[0];
}

// ---- Buttons on asks and approvals ----
// A button's custom_id is `pm1:<id>:<choice>`: a version prefix, the ap-/es- id the press answers, and the choice
// (`a` approve, `d` deny, `p` pass, `o<n>` the n-th option, 0-based). It is at most 100 characters (Discord's limit)
// and carries no secret, sender or rank: a press is authorised by who pressed it, never by what the id says, and the
// id is parsed strictly because a client can send any string.
export const CUSTOM_ID_MAX = 100;
const ACTION_VERSION = "pm1";
export type ActionChoice = { kind: "approve" } | { kind: "deny" } | { kind: "pass" } | { kind: "option"; index: number };
export interface ButtonAction {
  id: EscalationId; // an ap- id (approve/deny/pass) or an es- id (option/pass)
  choice: ActionChoice;
}

// The short, stable code of a choice: the custom_id suffix, also used in the idempotency key.
export function choiceKey(c: ActionChoice): string {
  return c.kind === "option" ? `o${c.index}` : c.kind.slice(0, 1);
}

export function encodeAction(a: ButtonAction): string {
  const s = `${ACTION_VERSION}:${a.id}:${choiceKey(a.choice)}`;
  if (s.length > CUSTOM_ID_MAX || decodeAction(s) === null) throw new Error(`unencodable button action ${s.slice(0, CUSTOM_ID_MAX)}`);
  return s;
}

const ACTION_RE = new RegExp(`^${ACTION_VERSION}:(${APPROVAL_ID}|${ESCALATION_ID}):(a|d|p|o(?:0|[1-9][0-9]?))$`);

// Parses a custom_id strictly; anything else (another version, a foreign id shape, an option index past
// MAX_BUTTONS - 1, approve/deny on an ask or an option on an approval) is null.
export function decodeAction(customId: string): ButtonAction | null {
  if (customId.length > CUSTOM_ID_MAX) return null;
  const [, id, code] = ACTION_RE.exec(customId) ?? [];
  if (id === undefined || code === undefined) return null;
  const approval = id.startsWith("ap-");
  if (code === "p") return { id, choice: { kind: "pass" } };
  if (code === "a" || code === "d") return approval ? { id, choice: { kind: code === "a" ? "approve" : "deny" } } : null;
  const index = Number(code.slice(1));
  return !approval && index < MAX_BUTTONS ? { id, choice: { kind: "option", index } } : null;
}

// The body POSTed for a press: pomtreed reads "approve"/"deny" on an approval and the option text on an ask.
export function actionBody(c: ActionChoice, options: readonly string[] | undefined): string | undefined {
  if (c.kind === "option") return options?.[c.index];
  return c.kind;
}

// Which buttons an outbound ask carries. An approval (subjectKind "approval", or an ap- id when pomtreed did not say)
// gets Approve and Deny; an ask with 1..MAX_BUTTONS options gets one button per option; more options, an empty
// option, or none fall back to text replies. Pass is added only when enabled (`pass`), within the button limit.
export function askButtons(ask: { replyTo?: EscalationId; subjectKind?: "ask" | "approval"; options?: readonly string[] }, pass = false): DiscordButton[] {
  const id = ask.replyTo;
  if (!id) return [];
  const kind = ask.subjectKind ?? (APPROVAL_ID_RE.test(id) ? "approval" : "ask");
  const passButton = (): DiscordButton[] => (pass ? [{ customId: encodeAction({ id, choice: { kind: "pass" } }), label: "Pass", style: "secondary" }] : []);
  if (kind === "approval") {
    if (!APPROVAL_ID_RE.test(id)) return [];
    return [
      { customId: encodeAction({ id, choice: { kind: "approve" } }), label: "Approve", style: "success" },
      { customId: encodeAction({ id, choice: { kind: "deny" } }), label: "Deny", style: "danger" },
      ...passButton(),
    ];
  }
  if (!ESCALATION_ID_RE.test(id)) return [];
  const options = ask.options ?? [];
  const room = MAX_BUTTONS - (pass ? 1 : 0);
  if (options.length === 0 || options.length > room || options.some((o) => o.trim() === "")) return passButton();
  return [
    ...options.map(
      (o, index): DiscordButton => ({ customId: encodeAction({ id, choice: { kind: "option", index } }), label: buttonLabel(o), style: "primary" }),
    ),
    ...passButton(),
  ];
}

const LABEL_TRUNCATION = "…";

// A label longer than Discord's limit is cut and marked; a marked label is not used as an answer (see adapter.ts).
export function buttonLabel(text: string): string {
  return text.length <= MAX_BUTTON_LABEL ? text : `${text.slice(0, MAX_BUTTON_LABEL - LABEL_TRUNCATION.length)}${LABEL_TRUNCATION}`;
}
export function isTruncatedLabel(label: string): boolean {
  return label.length === MAX_BUTTON_LABEL && label.endsWith(LABEL_TRUNCATION);
}

// The outcome of a press is appended to the original message text after STATUS_SEP; a later outcome replaces it.
const STATUS_SEP = "\n— ";
export function withStatus(content: string | undefined, status: string): string {
  const base = content ?? "";
  const cut = base.lastIndexOf(STATUS_SEP);
  const original = cut >= 0 ? base.slice(0, cut) : base;
  const suffix = `${STATUS_SEP}${status}`.slice(0, 500);
  const room = MAX_OUTBOUND_LENGTH - suffix.length;
  const head = original.length <= room ? original : `${original.slice(0, room - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
  return `${head}${suffix}`;
}
