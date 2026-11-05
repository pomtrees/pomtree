// Pure logic for the pomtree-mailbox Pi extension (TODO(steer) design A): poll the agent's inbox over the
// agent endpoint (GET /v1/agents/self/inbox), dedupe, order by priority, and format steering text. No Pi imports.
export interface MailSignal {
  kind: string;
  [k: string]: unknown;
}

const PRIORITY: Record<string, number> = {
  cancel: 0,
  human_message: 1,
  human_answer: 1,
  escalation: 1,
  message: 2,
  child_result: 3,
  child_exited: 3,
  job_exited: 3,
  nudge: 4,
  budget_warning: 5,
};
export const isInterrupt = (s: MailSignal) => s.interrupt === true;
// interrupt (daemon-flagged, any kind) > cancel > human > ...
const rank = (s: MailSignal) => (isInterrupt(s) ? -1 : (PRIORITY[s.kind] ?? 5));

// Every delivered signal carries an `id` (the send's idempotency key): dedupe and ack are by id. A coalesced level
// signal (nudge, budget_warning, ...) that is replaced arrives with a NEW id and is injected once as new information.
const idOf = (s: MailSignal): string | undefined => (typeof s.id === "string" && s.id ? s.id : undefined);
const dollars = (micros: unknown) => (typeof micros === "number" ? `$${(micros / 1e6).toFixed(2)}` : "unknown");

export function formatSignal(s: MailSignal): string {
  const body = typeof s.body === "string" ? s.body : "";
  const from = (v: unknown) => (typeof v === "string" ? v : v && typeof v === "object" ? JSON.stringify(v) : "unknown");
  switch (s.kind) {
    case "cancel":
      return "[pomtree] CANCEL requested by the operator: stop now, commit any work worth keeping, and finish.";
    case "human_message":
      return `[pomtree] Message from a human (${from(s.from)}): ${body}`;
    case "human_answer":
      return `[pomtree] Answer to your escalation (${from(s.from)}): ${body}`;
    case "message":
      return `[pomtree] Message from agent ${from(s.from)}: ${body}`;
    case "nudge":
      return `[pomtree] ${body}`;
    case "child_result":
      return `[pomtree] Child agent ${from(s.child)} reported (${String(s.status)}). Handoff: ${String(s.handoff)}`;
    case "child_exited": {
      const child = from(s.child);
      const held = s.custodyOf
        ? ` Held for you: its parent ${from(s.custodyOf)} is gone; inspect it with \`pomtree show ${child}\`, then \`pomtree reap ${child}\`.`
        : "";
      return `[pomtree] Child agent ${child} exited (${JSON.stringify(s.exit)}).${held}`;
    }
    case "escalation": {
      const id = String(s.escalation);
      const raise =
        s.subject === "budget_raise"
          ? ` Requested budget raise: ${dollars(s.requestedMicros)} (spent ${dollars(s.spentMicros)} of ${dollars(s.budgetMicros)}). Approving grants ${dollars(s.requestedMicros)} (or --grant $USD) out of YOUR own remaining budget; if you cannot cover it, run \`pomtree decide ${id} pass\` so the request goes up another layer.`
          : "";
      const opts = Array.isArray(s.options) && s.options.length ? ` Options: ${s.options.join(" | ")}.` : "";
      const deadline = typeof s.deadlineAt === "number" ? new Date(s.deadlineAt).toISOString() : "unknown";
      return `[pomtree] ESCALATION ${id} (${String(s.subject)}) from agent ${from(s.from)}: ${body}${raise}${opts} Deadline: ${deadline}. You hold this decision; respond before the deadline, or it passes up: \`pomtree decide ${id} approve|deny|pass [--grant $USD]\`, \`pomtree answer ${id} <text>\`, or \`pomtree pass ${id}\`.`;
    }
    case "budget_warning":
      return `[pomtree] Budget warning: ${dollars(s.remainingMicros)} remaining of ${dollars(s.budgetMicros)} (crossed the ${typeof s.thresholdFraction === "number" ? Math.round(s.thresholdFraction * 100) : "?"}% threshold). Run \`pomtree push\` now to save your work before the budget runs out, then wrap up: report your result or yield rather than starting new work.`;
    default: {
      const { id: _id, ...rest } = s;
      return `[pomtree] Signal ${s.kind}: ${JSON.stringify(rest)}`;
    }
  }
}

// Remembers signal ids already injected so a repeated delivery is not re-injected, counts failed injections, and tracks
// interrupt/cancel aborts that have not yet ended the turn.
export class Dedupe {
  private seen = new Set<string>();
  private failures = new Map<string, number>();
  private aborts = new Map<string, { attempts: number; lastAt: number; gaveUp: boolean }>();
  private ended = false;
  // Non-marking variants: mark a signal only after it was injected, so a failed injection is retried next poll.
  isNew(s: MailSignal): boolean {
    const id = idOf(s);
    return id !== undefined && !this.seen.has(id);
  }
  mark(s: MailSignal): void {
    const id = idOf(s);
    if (id !== undefined) this.seen.add(id);
  }
  fresh(sigs: MailSignal[]): MailSignal[] {
    const out: MailSignal[] = [];
    for (const s of sigs) {
      if (!this.isNew(s)) continue;
      this.mark(s);
      out.push(s);
    }
    return out;
  }
  // Records a failed injection of `s`; returns its failure count so far.
  fail(s: MailSignal): number {
    const id = idOf(s) ?? "";
    const n = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, n);
    return n;
  }
  // Abort bookkeeping for an interrupt/cancel signal: attempts so far and when the last was made (0 attempts when none).
  abortState(s: MailSignal): { attempts: number; lastAt: number; gaveUp: boolean } {
    return this.aborts.get(idOf(s) ?? "") ?? { attempts: 0, lastAt: 0, gaveUp: false };
  }
  // Records an abort attempt for `s` at `now`; returns the attempt count.
  aborting(s: MailSignal, now: number): number {
    const id = idOf(s) ?? "";
    const st = this.abortState(s);
    this.aborts.set(id, { ...st, attempts: st.attempts + 1, lastAt: now });
    return st.attempts + 1;
  }
  giveUp(s: MailSignal): void {
    this.aborts.set(idOf(s) ?? "", { ...this.abortState(s), gaveUp: true });
  }
  // True while an abort was made, its turn has not settled yet and retries remain (the caller polls faster then).
  abortPending(): boolean {
    for (const st of this.aborts.values()) if (!st.gaveUp) return true;
    return false;
  }
  // The turn settled (Pi's agent_settled): every interrupt/cancel aborted so far took effect and is handled. Returns whether
  // any was, i.e. whether this settle is the interruption (the daemon then ends the run, so the caller stops polling).
  turnEnded(): boolean {
    if (!this.aborts.size) return false;
    for (const id of this.aborts.keys()) this.seen.add(id);
    this.aborts.clear();
    this.ended = true;
    return true;
  }
  // An interrupt/cancel already ended a turn of this process: the daemon is ending the run, so nothing more is injected.
  interrupted(): boolean {
    return this.ended;
  }
}

// `inject:false` means abort ONLY. Why: the interactive Pi stays open after ctx.abort(); the aborted turn settles and the
// daemon ends the run on that settle, then delivers the human's text through the resume prompt, so a message sent here would
// start a competing turn or duplicate the resume prompt. Cancel is terminal, so no steer is needed either.
export interface Injection {
  text: string;
  deliverAs: "steer" | "followUp";
  abort: boolean;
  inject: boolean;
}

// Highest priority first (stable within a rank). interrupt/cancel abort only; human messages steer after the current
// tool batch; everything else queues as follow-up.
export function planPairs(sigs: MailSignal[]): { s: MailSignal; inj: Injection }[] {
  return sigs
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .map(({ s }) => {
      const abort = isInterrupt(s) || s.kind === "cancel";
      return { s, inj: { text: abort ? "" : formatSignal(s), deliverAs: rank(s) <= 1 ? ("steer" as const) : ("followUp" as const), abort, inject: !abort } };
    });
}
export const plan = (sigs: MailSignal[]): Injection[] => planPairs(sigs).map((p) => p.inj);

export type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// One poll; the inbox always peeks (does NOT consume server-side); injected signals are consumed afterwards with ackInbox, so an
// unacked signal (extension restart, failed injection) is re-delivered.
// Returns the signals, or [] on any transport/HTTP failure (retried next tick).
export async function pollInbox(env: Record<string, string | undefined>, fetchFn: Fetch): Promise<MailSignal[]> {
  const api = env.POMTREE_API,
    token = env.POMTREE_TOKEN;
  if (!api || !token) return [];
  try {
    const r = await fetchFn(`${api.replace(/\/$/, "")}/v1/agents/self/inbox`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return [];
    const body = await r.json();
    return Array.isArray(body) ? (body as MailSignal[]).filter((s) => s && typeof s.kind === "string" && idOf(s) !== undefined) : [];
  } catch {
    return [];
  }
}

export type Post = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

// Consume signals already injected, by id (POST /v1/agents/self/inbox/ack {ids, idempotencyKey}). Fail-safe: returns false on any failure (the
// signals stay queued and the in-process Dedupe prevents re-injection until the extension restarts).
export async function ackInbox(env: Record<string, string | undefined>, post: Post, ids: string[], idempotencyKey: string): Promise<boolean> {
  const api = env.POMTREE_API,
    token = env.POMTREE_TOKEN;
  if (!api || !token || !ids.length) return false;
  try {
    const r = await post(`${api.replace(/\/$/, "")}/v1/agents/self/inbox/ack`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ids, idempotencyKey }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// One message for everything injectable this tick. Pi starts a turn for `sendUserMessage` on an IDLE session (a waiting
// agent; `deliverAs` is ignored then, agent-session.js prompt()), but a second call before the first turn is streaming
// would race it, so several signals are joined into one message. `steer` wins when any signal is a steer.
export interface Batch {
  text: string;
  deliverAs: "steer" | "followUp";
  signals: MailSignal[];
}
export function batchInjections(pairs: { s: MailSignal; inj: Injection }[]): Batch | null {
  const inj = pairs.filter((p) => p.inj.inject);
  if (!inj.length) return null;
  return {
    text: inj.map((p) => p.inj.text).join("\n\n"),
    deliverAs: inj.some((p) => p.inj.deliverAs === "steer") ? "steer" : "followUp",
    signals: inj.map((p) => p.s),
  };
}

// An injection Pi keeps rejecting is dropped after this many attempts (acked with a logged note) so it cannot wedge the inbox.
export const MAX_INJECT_ATTEMPTS = 3;
// An interrupt/cancel abort that has not ended the turn (no agent_settled) while the signal stays queued is repeated at most
// every ABORT_RETRY_MS, MAX_ABORT_ATTEMPTS times in all; then the daemon's backstop (container kill after
// agent.interruptGraceMs, default 5000 ms, which the container is not told) ends the run. The values keep the retries inside
// that default grace at the busy poll interval.
export const ABORT_RETRY_MS = 1000;
export const MAX_ABORT_ATTEMPTS = 3;

export interface TickDeps {
  env: Record<string, string | undefined>;
  get: Fetch;
  post: Post;
  dedupe: Dedupe;
  // May return a promise (Pi's send is async); a throw or rejection counts as a failed injection.
  sendUserMessage: (text: string, opts: { deliverAs: "steer" | "followUp" }) => void | Promise<unknown>;
  abort?: () => void;
  nextAckKey: () => string;
  log?: (line: string) => void;
  now?: () => number;
}

// One poll-inject-ack cycle. Returns "aborted" when this tick aborted the turn for a queued interrupt/cancel, else "ok". Polling
// goes on: the interrupt is handled only when the turn settles (Dedupe.turnEnded); until then it is re-aborted (bounded, see
// MAX_ABORT_ATTEMPTS) and nothing else is injected. Fail-safe: a failed injection leaves signals unmarked and unacked (re-polled), up to
// MAX_INJECT_ATTEMPTS, then they are acked with a logged note; ack happens only after a successful injection.
// TODO(steer): Pi reports a rejected prompt via its error channel, not by throwing, so that case is still acked as injected.
export async function runTick(d: TickDeps): Promise<"ok" | "aborted"> {
  if (d.dedupe.interrupted()) return "ok";
  const sigs = (await pollInbox(d.env, d.get)).filter((s) => d.dedupe.isNew(s));
  const pairs = planPairs(sigs);
  const stop = pairs.find((p) => p.inj.abort);
  if (stop) {
    // abort ONLY, no sendUserMessage and no ack (the daemon consumes it).
    const now = (d.now ?? Date.now)();
    const st = d.dedupe.abortState(stop.s);
    if (st.attempts > 0 && now - st.lastAt < ABORT_RETRY_MS) return "ok"; // give the last abort time to settle the turn
    if (st.attempts >= MAX_ABORT_ATTEMPTS) {
      if (!st.gaveUp) {
        d.dedupe.giveUp(stop.s);
        d.log?.(
          `[pomtree-mailbox] interrupt ${idOf(stop.s)}: ctx.abort() did not end the turn after ${MAX_ABORT_ATTEMPTS} attempts; leaving it to the daemon's interrupt backstop (container kill after agent.interruptGraceMs)`,
        );
      }
      return "ok";
    }
    d.dedupe.aborting(stop.s, now); // counted before the call, so a throwing abort is bounded too
    try {
      d.abort?.();
      return "aborted";
    } catch {
      return "ok";
    }
  }
  const b = batchInjections(pairs);
  if (!b) return "ok";
  try {
    await d.sendUserMessage(b.text, { deliverAs: b.deliverAs });
  } catch (e) {
    const dropped = b.signals.filter((s) => d.dedupe.fail(s) >= MAX_INJECT_ATTEMPTS);
    if (!dropped.length) return "ok"; // injection failed: leave unmarked so the next poll retries
    const ids = dropped.map((s) => idOf(s)!);
    d.log?.(`[pomtree-mailbox] injection failed ${MAX_INJECT_ATTEMPTS}x (${e instanceof Error ? e.message : String(e)}); dropping signals ${ids.join(",")}`);
    for (const s of dropped) d.dedupe.mark(s);
    await ackIds(d, ids);
    return "ok";
  }
  for (const s of b.signals) d.dedupe.mark(s);
  await ackIds(
    d,
    b.signals.map((s) => idOf(s)!),
  );
  return "ok";
}

async function ackIds(d: TickDeps, ids: string[]): Promise<void> {
  try {
    await ackInbox(d.env, d.post, ids, d.nextAckKey());
  } catch {
    /* unacked: re-delivered later */
  }
}
