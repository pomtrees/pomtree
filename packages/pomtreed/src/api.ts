import {
  CAPTURE_LIST_LIMIT_MAX,
  CONFIG_DEFAULTS,
  captureRequestProblem,
  IdempotencyConflictError,
  INBOUND_INTENTS,
  MESSAGE_FAILED_REASON_MAX,
  MESSAGE_FAILED_SUBJECT_MAX,
  MESSAGING_API_VERSION,
  StaleGenerationError,
  TemplateError,
} from "@pomtree/core";
import type {
  AgentId,
  AgentRecord,
  AgentState,
  ApprovalState,
  CaptureListResponse,
  CaptureRequest,
  CaptureRequestBody,
  CaptureResponse,
  CaptureShowResponse,
  EscalationState,
  HostAgentsBody,
  HostBudgetBody,
  HostReportBody,
  JsonValue,
  MessageKind,
  MessagingSender,
  ResultDisposition,
  Template,
  TemplateStore,
  WaitCondition,
} from "@pomtree/core";
import { tokenProblem, verifyToken, verifyUiCookie } from "./auth.ts";
import {
  IDEMPOTENCY_EXT_KEY_REQUIRED,
  IDEMPOTENCY_KEY_REQUIRED,
  IDEMPOTENCY_QUERY_KEY_REQUIRED,
  TEMPLATES_NOT_CONFIGURED,
  staleGenerationBody,
  templateErrorBody,
  unauthorizedBody,
  unknownModelMessage,
  extensionKeyMissing,
  unknownTemplateMessage,
} from "./error-codes.ts";
import type { ApiErrorCode } from "./error-codes.ts";
import { LifecycleError } from "./lifecycle.ts";
import type { Principal } from "./auth.ts";
import type { CaptureRequester } from "./capture/types.ts";
import type { Daemon } from "./daemon.ts";
import type { InboundMessage } from "./daemon.ts";
import type { ChannelAction } from "./daemon-types.ts";
import { CLI_CHANNEL, UI_CHANNEL } from "./channels.ts";
import { BUDGET_RAISE_KIND, parseBudgetRaiseTarget } from "./budget-raise.ts";
import { matchExtensionRoute } from "./route-match.ts";
import { HOST_LIST_MAX, HostReadLimiter, hostAgentView, hostReportText, validHostSender } from "./host-read.ts";
import { toUser } from "./to-user.ts";
import { buildTrace } from "./trace-build.ts";
import { mergeHttp } from "./merge-route.ts";
import { handleState } from "./state-routes.ts";
import type { AuthedExtensionRequest } from "./route-match.ts";

export interface ApiRequest {
  method: string;
  url: string; // path plus query
  token?: string;
  // Browser UI session cookie header; when present and valid it grants operator scope, so the
  // operator UI's inline fetches authenticate without a Bearer header.
  cookie?: string;
  body?: unknown;
}
export interface ApiResponse {
  status: number;
  body: unknown;
  // When set, `body` is raw bytes (not JSON) and this is the media type to serve.
  contentType?: string;
  // Extra response headers (e.g. security headers on raw report downloads).
  headers?: Record<string, string>;
  // Internal error detail for the daemon log only (5xx); never serialized into the response.
  detail?: string;
}

class ApiError extends Error {
  status: number;
  code?: ApiErrorCode;
  constructor(status: number, message: string, code?: ApiErrorCode) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// A row of GET /v1/templates: a valid template as before, or a file that fails validation as `{ id, error }` (the observe New
// agent form reads exactly the string `error` field and shows the row as unavailable). TODO(contract-drift): the form's reader
// lives in another package; pomtreed's api.templates test pins this shape until both import one definition.
export type TemplateRow = Template | { id: string; error: string };

// The per-file listing when the store offers it (template-dir's DirTemplateStore.listEntries), else the strict port listing.
// TODO(contract-drift): listEntries is not on core's TemplateStore port; read by duck type until the port carries it.
async function templateRows(t: TemplateStore): Promise<TemplateRow[]> {
  const per = t as TemplateStore & { listEntries?: () => Promise<(Template | { id: string; error: Error })[]> };
  if (typeof per.listEntries !== "function") return t.list();
  return (await per.listEntries()).map((r) => ("error" in r && r.error instanceof Error ? { id: r.id, error: r.error.message } : (r as Template)));
}

// 500 bodies never carry the raw error (it can leak host paths); the detail goes to the daemon log.
function internalError(e: unknown): ApiResponse {
  console.error(`pomtreed: internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  return { status: 500, body: { error: "internal error" }, detail: e instanceof Error ? e.message : String(e) };
}

const UI_MESSAGE_MAX = 4000; // chars in a free-text UI message to an agent
const STATES: AgentState[] = ["pending", "running", "yielded", "exited", "reaped"];

function obj(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError(400, "body must be a JSON object");
  return body as Record<string, unknown>;
}

function str(o: Record<string, unknown>, k: string, required = true): string | undefined {
  const v = o[k];
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || !v) throw new ApiError(400, `${k} must be a non-empty string`);
  return v;
}

// Every mutating call carries an idempotency key (SPEC design rule 4): a missing one is refused here, at the API boundary, with the fix.
function idemKey(o: Record<string, unknown>): string {
  const v = o.idempotencyKey;
  if (typeof v !== "string" || !v) throw new ApiError(400, IDEMPOTENCY_KEY_REQUIRED);
  return v;
}

// A required string that str() has already validated; the throw is unreachable and keeps the type narrow without a non-null assertion.
function reqStr(o: Record<string, unknown>, k: string): string {
  const v = str(o, k);
  if (v === undefined) throw new ApiError(400, `${k} must be a non-empty string`);
  return v;
}

function num(v: unknown, what: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, `${what} must be a non-negative number`);
  return n;
}

function positiveInt(v: unknown, what: string): number | undefined {
  const n = num(v, what);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < 1) throw new ApiError(400, `${what} must be a positive integer`);
  return n;
}

// Shape only; the lifecycle's dispositionError is the one authority for the rules (mode values, ttlMs with reap-on-exit).
function dispositionBody(v: unknown): ResultDisposition {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ApiError(400, "disposition must be an object {mode, ttlMs?}");
  const o = v as Record<string, unknown>;
  const ttlMs = positiveInt(o.ttlMs, "disposition.ttlMs");
  return { mode: str(o, "mode") as ResultDisposition["mode"], ...(ttlMs !== undefined && { ttlMs }) };
}

function oneOf<T extends string>(v: unknown, what: string, allowed: readonly T[], fallback: T): T {
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new ApiError(400, `${what} must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

function strArray(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ApiError(400, `${what} must be an array of strings`);
  return v as string[];
}

function parseWait(v: unknown): WaitCondition {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ApiError(400, "wait must be a JSON object");
  const w = v as Record<string, unknown>;
  switch (w.kind) {
    case "message":
      return { kind: "message" };
    case "timer": {
      const at = Number(w.at);
      if (!Number.isFinite(at)) throw new ApiError(400, "wait.timer.at must be a number");
      return { kind: "timer", at };
    }
    case "child_exited":
      return { kind: "child_exited", children: strArray(w.children, "wait.children"), mode: oneOf(w.mode, "wait.mode", ["any", "all"] as const, "any") };
    case "any": {
      if (!Array.isArray(w.of)) throw new ApiError(400, "wait.of must be an array");
      return { kind: "any", of: (w.of as unknown[]).map(parseWait) };
    }
    default:
      throw new ApiError(400, "wait.kind must be one of: message, timer, child_exited, any");
  }
}

// The response header naming the messaging wire contract version (core MESSAGING_API_VERSION). Set on every response of the
// adapter-facing routes of that contract, errors included: /v1/messages[/failed] and the /v1/host read routes.
export const MESSAGING_API_HEADER = "x-pomtree-messaging-api";

function isMessagingRoute(url: string): boolean {
  const path = new URL(url, "http://pomtreed").pathname;
  return path === "/v1/messages" || path.startsWith("/v1/messages/") || path === "/v1/host" || path.startsWith("/v1/host/");
}

export async function handle(daemon: Daemon, req: ApiRequest): Promise<ApiResponse> {
  const out = await handleRoute(daemon, req);
  if (!isMessagingRoute(req.url)) return out;
  return { ...out, headers: { ...out.headers, [MESSAGING_API_HEADER]: String(MESSAGING_API_VERSION) } };
}

async function handleRoute(daemon: Daemon, req: ApiRequest): Promise<ApiResponse> {
  try {
    const principal = req.token
      ? verifyToken(daemon.deps.secret, req.token)
      : req.cookie !== undefined && verifyUiCookie(daemon.deps.secret, req.cookie)
        ? ({ scope: "operator" } as const)
        : null;
    // Extension routes dispatch first (so direct callers — tests, e2e — see them exactly as the HTTP
    // server does; the server has already matched and dispatched them before calling handle(), so this
    // is a no-op there). The matched request carries the authenticated principal via the AuthedExtensionRequest
    // augmentation, which builtins read back with principalOf().
    const url = new URL(req.url, "http://pomtreed");
    const ext = matchExtensionRoute(daemon.deps.extensionHost?.routes() ?? [], req.method, url.pathname, principal, false);
    if (ext.kind === "denied") {
      if (principal) return { status: 403, body: { error: "forbidden" } };
      return {
        status: 401,
        body: unauthorizedBody(req.token ? tokenProblem(daemon.deps.secret, req.token) : "missing", req.token?.startsWith("ag.") === true),
      };
    }
    if (ext.kind === "match") {
      if (extensionKeyMissing(req.method, req.body, url.searchParams)) return { status: 400, body: { error: IDEMPOTENCY_EXT_KEY_REQUIRED } };
      const extReq: AuthedExtensionRequest = {
        method: req.method,
        path: url.pathname,
        params: ext.params,
        query: url.searchParams,
        body: req.body,
        principal,
      };
      try {
        const out = await ext.def.handler(extReq);
        return { status: out.status, body: out.body, contentType: out.contentType, headers: out.headers };
      } catch (e) {
        return internalError(e);
      }
    }
    if (!principal) {
      const problem = req.token ? tokenProblem(daemon.deps.secret, req.token) : "missing";
      return { status: 401, body: unauthorizedBody(problem, req.token?.startsWith("ag.") === true) };
    }
    return await route(daemon, principal, req);
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, body: { error: e.message, ...(e.code !== undefined && { code: e.code }) } };
    if (e instanceof LifecycleError) return { status: e.status, body: { error: e.message, ...e.extra } };
    if (e instanceof StaleGenerationError) return { status: 409, body: staleGenerationBody(e) };
    // A key replayed with a different request (store fingerprint mismatch): the message names the key and both remedies.
    if (e instanceof IdempotencyConflictError) return { status: 409, body: { error: e.message, code: e.code } };
    // A template file that fails validation is the request naming a broken template, not a daemon fault: 422 with the field reason.
    if (e instanceof TemplateError) return { status: 422, body: templateErrorBody(e) };
    return internalError(e);
  }
}

const ok = (body: unknown, status = 200) => ({ status, body });

const hostReadLimiters = new WeakMap<Daemon, HostReadLimiter>();

async function route(daemon: Daemon, p: Principal, req: ApiRequest): Promise<ApiResponse> {
  const url = new URL(req.url, "http://pomtreed");
  const seg = url.pathname.split("/").filter(Boolean);
  const q = url.searchParams;
  if (seg[0] !== "v1") throw new ApiError(404, "not found");
  const operator = () => {
    if (p.scope !== "operator") throw new ApiError(403, "operator scope required");
  };
  // The operator-rank identity of this request: a bearer operator token (the CLI/REST) is `cli:operator`, the UI session cookie
  // is `ui:operator`. Both are rank operator in the channel registry (always allowed, audited, exempt from limits).
  const operatorActor = (): MessagingSender => ({ channel: req.token ? CLI_CHANNEL : UI_CHANNEL, sender: "operator" });
  // Every operator-routed write goes through the one action core (daemon.performAction) in its raw shape: caller keys as-is,
  // native result back, errors propagate.
  const act = async <T>(action: ChannelAction, key: string): Promise<T> => {
    const out = await daemon.performAction(operatorActor(), action, key, { raw: true });
    if (out.kind === "rejected") throw new ApiError(out.status ?? 403, out.reason);
    return out.value as T;
  };
  // A host token is good only for a CONFIGURED adapter channel. Tokens are stateless HMACs, so one issued for a removed channel (or
  // for ui, cli or operator, which are not adapters) still verifies; this refuses it on every host route.
  const adapterChannel = (channel: string): boolean => daemon.deps.channels.get(channel)?.kind === "adapter";
  // Agents address themselves, and (when allowed) their own children and the exited agents they hold in custody (a dead parent's
  // zombies); anything else is 403 without revealing existence.
  const target = async (raw: string | undefined, allowChild = false): Promise<AgentId> => {
    if (!raw) throw new ApiError(404, "not found");
    // Host (Discord) and ext tokens must not read arbitrary agents/events/checkpoints/wait; only the
    // operator, or the agent addressing itself/its children, may.
    if (p.scope !== "operator" && p.scope !== "agent") throw new ApiError(403, "operator or agent scope required");
    if (p.scope === "agent") await fence();
    if (raw === "self") {
      if (p.scope !== "agent") throw new ApiError(400, "'self' needs an agent credential");
      return p.agent;
    }
    if (p.scope === "agent" && p.agent !== raw) {
      // A child is one the agent parents; a zombie is an exited descendant whose parent is gone and whose custodian is the agent.
      if (allowChild) {
        const c = await daemon.get(raw);
        if (c && (await daemon.canWaitOn(p.agent, c))) return raw;
      }
      throw new ApiError(
        403,
        allowChild ? "agents may only address themselves, their children, and the exited agents they hold in custody" : "agents may only address themselves",
      );
    }
    return raw;
  };
  const exists = async (id: AgentId) => {
    const r = await daemon.get(id);
    if (!r) throw new ApiError(404, `no such agent: ${id}`);
    return r;
  };
  // Fence stale agent credentials: the token carries the generation it was issued for, and a kill_resume
  // bumps the registry generation, so a still-alive old container's token must stop addressing the daemon.
  // Expiry is checked structurally in verifyToken; this closes the generation half of token lifecycle.
  const fence = async () => {
    if (p.scope !== "agent") return;
    const me = await daemon.get(p.agent);
    if (me && me.generation !== p.generation) throw new StaleGenerationError(p.agent, p.generation, me.generation);
  };
  // Agent-scoped routes only a live agent may use: the token's generation is fenced against the
  // registry (fence), and a reaped/exited agent's token must not keep addressing the daemon.
  const requireRunning = async (id: AgentId) => {
    await fence();
    const r = await daemon.get(id);
    if (!r) throw new ApiError(404, `no such agent: ${id}`);
    if (r.state !== "running") throw new ApiError(409, `agent is ${r.state}, not running`);
  };

  const [, res, id, action, sub] = seg;
  const m = req.method;

  if (res === "doctor" && m === "GET" && !id) {
    operator();
    return ok(await daemon.doctor());
  }

  // `pomtree whoami`: prove the caller's token and endpoint (a preflight an agent runs on the socket when TCP is down).
  if (res === "whoami" && m === "GET" && !id) {
    if (p.scope !== "agent") throw new ApiError(403, "agent scope required");
    await fence(); // reject a stale-generation token here
    const me = await exists(p.agent);
    const doc = await daemon.doctor();
    return ok({ id: me.id, name: me.name, state: me.state, generation: me.generation, host: me.host, endpoint: doc.agentEndpoint });
  }

  // Operator summary (the footer of `pomtree top`/`ps`/`tree`): agents by state, total spend, open escalations, hosts.
  if (res === "summary" && m === "GET" && !id) {
    operator();
    const agents = await daemon.list();
    const agentsByState: Record<string, number> = {};
    let totalSpendMicros = 0;
    let waiting = 0; // running agents idle after a settled turn; a subset of agentsByState.running, not a state
    for (const a of agents) {
      agentsByState[a.state] = (agentsByState[a.state] ?? 0) + 1;
      if (a.state === "running" && (await daemon.waitingSince(a.id).catch(() => null)) !== null) waiting++;
      totalSpendMicros += (await daemon.deps.gateway.spend(a.id)).spentMicros;
    }
    const openEscalations = (await daemon.deps.escalations.list({ state: "open" })).length;
    const hosts = await daemon.placementStatus();
    return ok({
      agentsByState,
      waiting,
      totalSpendMicros,
      openEscalations,
      hosts,
      sessions: { used: hosts.running.length, max: hosts.maxConcurrent, mode: daemon.deps.maxSessions?.mode ?? "manual" },
    });
  }

  // Operator drain (the daemon half of `pomtree drain`): stop admission and leave running containers
  // adoptable. `deadline` is the absolute time past which the caller force-exits nonzero.
  if (res === "drain" && m === "POST" && !id) {
    operator();
    const b = obj(req.body ?? {});
    idemKey(b); // required for uniformity; a replay is safe by state (shutdown is a no-op once draining)
    const deadline = num(b.deadline, "deadline");
    if (deadline === undefined) throw new ApiError(400, "deadline must be a non-negative number");
    await daemon.shutdown(deadline);
    return ok({ draining: true }, 202);
  }

  // Agent-facing peers: list who the caller can message, and deliver a message. Unlike `target` below,
  // messaging addresses any known agent, so the peer id is resolved straight against the registry (an
  // unknown id is a clear 404, and a stale sender generation surfaces as 409 from the mailbox).
  if (res === "peers") {
    if (p.scope !== "agent") throw new ApiError(403, "agent scope required");
    if (m === "GET" && !id) return ok(await daemon.peers(p.agent));
    if (id && action === "send" && m === "POST") {
      const b = obj(req.body);
      if (b.interrupt === true || b.mode === "interrupt")
        throw new ApiError(403, "only the operator may interrupt an agent; agents cannot use --interrupt (send a normal message)");
      const generation = num(b.generation, "generation");
      if (generation === undefined || !Number.isInteger(generation)) throw new ApiError(400, "generation must be a non-negative integer");
      await requireRunning(p.agent);
      return ok(await daemon.sendMessage(p.agent, id, str(b, "body")!, generation, idemKey(b)), 201);
    }
    throw new ApiError(404, "not found");
  }

  // Inbound/outbound messaging (host credentials). POST receives a message from an adapter; GET polls the
  // outbox (`message_sent` entries for the channel) from a cursor. The host token's channel must match the
  // message/channel being addressed, so one adapter token cannot impersonate another channel.
  // The `ui` channel is in-daemon (POST /v1/ui/reply, operator rank in the channel registry); no adapter may claim it.
  if (res === "ui" && id === "reply" && m === "POST" && !action) {
    operator();
    const b = obj(req.body);
    const decision = b.decision === undefined ? undefined : oneOf(b.decision, "decision", ["approve", "deny", "pass"] as const, "deny");
    // Exactly one shape: an answer ({replyTo + body | decision}) or a free-text message to an agent ({to + body}).
    const to = str(b, "to", false);
    if (to !== undefined) {
      if (b.replyTo !== undefined || decision !== undefined) throw new ApiError(400, "send either to+body or replyTo+body|decision, not both");
      if (str(b, "body")!.length > UI_MESSAGE_MAX) throw new ApiError(400, `body exceeds ${UI_MESSAGE_MAX} characters`);
      const target = await daemon.get(to);
      if (!target) throw new ApiError(404, `no such agent: ${to}`);
      if (target.state === "reaped") throw new ApiError(409, `agent ${to} is reaped`);
    } else if (b.replyTo === undefined) throw new ApiError(400, "replyTo or to must be set");
    // pass abstains and hands the ask/approval up a rung; approve/deny on an approval ride the same text parser as a chat reply.
    // TODO(multi-operator): every UI reply is the one synthetic identity ui:operator at the operator rung; current behavior: a single operator identity.
    const msg: InboundMessage = {
      channel: UI_CHANNEL,
      sender: { channel: UI_CHANNEL, sender: "operator" },
      body: decision ?? str(b, "body")!,
      ...(to === undefined ? { replyTo: str(b, "replyTo")! } : { to }),
      ...(decision === "pass" && { pass: true }),
      idempotencyKey: idemKey(b),
    };
    return ok(await daemon.receiveMessage(msg), 201);
  }

  // Host read routes for chat commands (`!ps`, `!budget`, `!report`): GET /v1/host/agents[?state=], /v1/host/agents/:id/budget,
  // /v1/host/agents/:id/report. Host scope only, and ONLY these three shapes (see host-read.ts for the safe projection). The
  // caller must name the chat sender (`sender=<id>`), who goes through the same authorizeInbound hook as POST /v1/messages
  // (route "status") when it is installed, then a per-sender/global rate limit. Unknown, reaped and "self" ids are one 404.
  if (res === "host") {
    if (p.scope !== "host") throw new ApiError(403, "host scope required");
    if (!adapterChannel(p.channel)) throw new ApiError(403, `channel ${p.channel} is not a configured adapter`);
    const shaped = seg.length === 3 || (seg.length === 5 && action !== "self" && (sub === "budget" || sub === "report"));
    if (m !== "GET" || id !== "agents" || !shaped) throw new ApiError(404, "not found");
    const sender = q.get("sender");
    if (!validHostSender(sender)) throw new ApiError(400, "sender must be a non-empty string without control characters (max 200 chars)");
    const msg: InboundMessage = { channel: p.channel, sender: { channel: p.channel, sender }, intent: "status", body: "", idempotencyKey: "host-read" };
    if (daemon.deps.authorizeInbound && !(await daemon.deps.authorizeInbound(msg, "status"))) {
      throw new ApiError(403, `sender ${p.channel}:${sender} is not authorized`);
    }
    const limiter = hostReadLimiters.get(daemon) ?? new HostReadLimiter();
    hostReadLimiters.set(daemon, limiter);
    if (limiter.limited(p.channel, sender, (daemon.deps.now ?? Date.now)())) throw new ApiError(429, "rate limit exceeded");
    if (seg.length === 3) {
      const state = q.get("state");
      if (state !== null && !STATES.includes(state as AgentState)) throw new ApiError(400, `state must be one of: ${STATES.join(", ")}`);
      const all = await daemon.list(state ? { state: state as AgentState } : undefined);
      const rows = all
        .filter((a) => state !== null || a.state !== "reaped")
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, HOST_LIST_MAX);
      const body: HostAgentsBody = { agents: await Promise.all(rows.map(async (a) => hostAgentView(a, (await daemon.deps.gateway.spend(a.id)).spentMicros))) };
      return ok(body);
    }
    const rec = action && action !== "self" ? await daemon.get(action) : undefined;
    if (!rec) throw new ApiError(404, "no such agent");
    if (sub === "budget") {
      const { spentMicros } = await daemon.deps.gateway.spend(rec.id);
      const body: HostBudgetBody = { id: rec.id, budgetMicros: rec.budgetMicros, spentMicros, remainingMicros: await daemon.remainingMicros(rec) };
      return ok(body);
    }
    const body: HostReportBody = { id: rec.id, state: rec.state, exit: rec.exit, report: hostReportText(rec.result) };
    return ok(body);
  }

  if (res === "messages") {
    if (p.scope !== "host") throw new ApiError(403, "host scope required");
    if (!adapterChannel(p.channel)) throw new ApiError(403, `channel ${p.channel} is not a configured adapter`);
    if (m === "POST" && !id) {
      const b = obj(req.body);
      const channel = str(b, "channel")!;
      if (channel !== p.channel) throw new ApiError(403, `host token is for channel ${p.channel}, not ${channel}`);
      const senderRaw = b.sender;
      let sender: MessagingSender;
      if (typeof senderRaw === "string" && senderRaw) {
        sender = { channel, sender: senderRaw, ...(typeof b.name === "string" && b.name ? { name: b.name } : {}) };
      } else if (typeof senderRaw === "object" && senderRaw !== null && !Array.isArray(senderRaw)) {
        const s = senderRaw as Record<string, unknown>;
        sender = { channel, sender: str(s, "sender")!, ...(typeof s.name === "string" ? { name: s.name } : {}) };
      } else {
        throw new ApiError(400, "sender must be a non-empty string or an object");
      }
      const intent = b.intent === undefined ? undefined : oneOf(b.intent, "intent", INBOUND_INTENTS, "answer");
      // `pass` with `replyTo` abstains and hands the ask/approval up one rung (body ignored), as `decision: "pass"` does on
      // /v1/ui/reply. It rides the same action core: the chat sender is authorized (authorizeInbound, route "answer") and rate
      // limited exactly as for an answer to that replyTo, so a pass needs no more than answering would.
      if (b.pass !== undefined && typeof b.pass !== "boolean") throw new ApiError(400, "pass must be a boolean");
      const pass = b.pass === true;
      if (pass && b.replyTo === undefined) throw new ApiError(400, "pass requires replyTo");
      // A launch names its workflow (and optional JSON input, default {}) instead of a body; the host token is never operator credentials.
      const launch = intent === "launch";
      const msg: InboundMessage = {
        channel,
        sender,
        intent,
        body: launch || pass ? (str(b, "body", false) ?? "") : reqStr(b, "body"),
        replyTo: str(b, "replyTo", false),
        to: str(b, "to", false),
        ...(pass && { pass: true }),
        idempotencyKey: idemKey(b),
        ...(launch && { workflow: reqStr(b, "workflow"), input: b.input === undefined ? {} : (b.input as JsonValue) }),
      };
      return ok(await daemon.receiveMessage(msg), 201);
    }
    // An adapter reports a dead-lettered outbound message (host token; channel must match its own).
    if (m === "POST" && id === "failed" && !action) {
      const b = obj(req.body);
      const channel = str(b, "channel")!;
      if (channel !== p.channel) throw new ApiError(403, `host token is for channel ${p.channel}, not ${channel}`);
      const attempts = num(b.attempts, "attempts");
      const purpose = str(b, "purpose")!;
      if (!["ask", "alert", "status", "report"].includes(purpose)) throw new ApiError(400, "purpose must be one of: ask, alert, status, report");
      const subject = str(b, "subject")!;
      const reason = str(b, "reason")!;
      // The wire limits (core MESSAGE_FAILED_*); the journaled reason is clipped further, to MESSAGE_FAILED_JOURNAL_REASON_MAX.
      if (subject.length > MESSAGE_FAILED_SUBJECT_MAX) throw new ApiError(400, `subject exceeds ${MESSAGE_FAILED_SUBJECT_MAX} characters`);
      if (reason.length > MESSAGE_FAILED_REASON_MAX) throw new ApiError(400, `reason exceeds ${MESSAGE_FAILED_REASON_MAX} characters`);
      await daemon.messageFailed({
        channel,
        purpose: purpose as MessageKind,
        subject,
        reason,
        ...(attempts !== undefined && { attempts }),
        idempotencyKey: idemKey(b),
      });
      return ok({ recorded: true }, 201);
    }
    if (m === "GET" && !id) {
      const channel = q.get("channel") ?? p.channel;
      if (channel !== p.channel) throw new ApiError(403, `host token is for channel ${p.channel}, not ${channel}`);
      return ok(await daemon.outbox({ channel, from: num(q.get("from"), "from") ?? 0 }));
    }
    throw new ApiError(404, "not found");
  }

  // Templates are a read-only operator view onto the configured TemplateStore (v1: operator-only;
  // spawning with a template is additionally gated by mayUseTemplate default-deny for agents).
  if (res === "templates") {
    operator();
    const t = daemon.deps.templates;
    if (!t) throw new ApiError(400, TEMPLATES_NOT_CONFIGURED);
    if (m === "GET" && !id) return ok(await templateRows(t));
    if (m === "GET" && id) {
      const tpl = await t.resolve(id);
      if (!tpl) throw new ApiError(404, unknownTemplateMessage(id), "unknown_template");
      return ok(tpl);
    }
    throw new ApiError(405, "method not allowed");
  }

  // The models Pi can use (operator-only); the New agent form and `pomtree models` read this.
  if (res === "models") {
    operator();
    if (m !== "GET" || id) throw new ApiError(405, "method not allowed");
    return ok(daemon.deps.models ? await daemon.deps.models.list() : { models: [], source: "none", reason: "no model catalog configured" });
  }

  // Operator journal view (the audit pane's source): Journal.read plus a post-read `kind` filter.
  if (res === "journal") {
    operator();
    if (m === "GET" && !id) {
      return ok(
        await daemon.journal({
          from: num(q.get("from"), "from"),
          limit: num(q.get("limit"), "limit"),
          agent: q.get("agent") ?? undefined,
          kind: q.get("kind") ?? undefined,
        }),
      );
    }
    throw new ApiError(404, "not found");
  }

  // Placement status (the hosts pane's source): a single PlacementStatus snapshot.
  if (res === "placement") {
    operator();
    if (m === "GET" && !id) return ok(await daemon.placementStatus());
    throw new ApiError(404, "not found");
  }

  // Escalations list (the escalations pane's source, operator-only), plus the answer/pass routes. A human answers at the
  // operator scope; an ancestor agent answers or passes only an ask it currently holds (403 otherwise).
  if (res === "escalations") {
    if (m === "GET" && !id) {
      operator();
      const state = q.get("state") ?? undefined;
      if (state && state !== "open" && state !== "answered") throw new ApiError(400, `unknown state: ${state}`);
      return ok(
        await daemon.deps.escalations.list({
          agent: q.get("agent") ?? undefined,
          state: state as EscalationState | undefined,
        }),
      );
    }
    if (m === "POST" && id && (action === "answer" || action === "pass") && !sub) {
      if (p.scope !== "operator" && p.scope !== "agent") throw new ApiError(403, "operator or agent scope required");
      if (p.scope === "agent") await requireRunning(p.agent);
      if (!(await daemon.deps.escalations.get(id))) throw new ApiError(404, `no such escalation: ${id}`);
      const b = obj(req.body);
      const key = idemKey(b);
      const agent = p.scope === "agent" ? p.agent : null;
      if (action === "pass")
        return ok(agent ? await daemon.passEscalation(id, agent, key) : await act({ kind: "answer", replyTo: id, body: "pass", pass: true }, key), 201);
      const body = str(b, "body")!;
      return ok(agent ? await daemon.answerEscalationAs(agent, id, body, key) : await act({ kind: "answer", replyTo: id, body }, key), 201);
    }
    throw new ApiError(404, "not found");
  }

  // Decision on a gated-action approval: an operator (same as the chat "approve"/"deny" reply) or the ancestor agent
  // holding the current rung. `pass` hands it up one rung; `grantMicros` is recorded on the journal entry.
  if (res === "approvals") {
    // Pending approvals for the Inbox (operator-only): the fields the UI needs, with agent-influenced text sanitized (toUser).
    // TODO(ui-message): no `grantable` flag; the UI reply cannot carry grantMicros, so a UI approve of a budget_raise grants the requested amount (`requestedMicros`); a different amount goes through the CLI/API route.
    if (m === "GET" && !id) {
      operator();
      const state = q.get("state") ?? "pending";
      if (state !== "pending" && state !== "approved" && state !== "denied") throw new ApiError(400, `unknown state: ${state}`);
      const list = (await daemon.deps.approvals?.list({ state: state as ApprovalState })) ?? [];
      return ok(
        list.map((ap) => {
          const rung = ap.rungs[ap.rungIndex] ?? null;
          return {
            id: ap.id,
            requester: ap.requester.id,
            kind: ap.action.kind,
            ...(ap.action.kind === BUDGET_RAISE_KIND && { requestedMicros: parseBudgetRaiseTarget(ap.action.target)?.requestedMicros }),
            summary: toUser(`${ap.action.kind} ${ap.action.target}`),
            rung,
            atOperator: rung === "operator" || rung === "owner",
            deadlineAt: ap.deadlineAt,
            createdAt: ap.createdAt,
          };
        }),
      );
    }
    if (m === "POST" && id && action === "decide" && !sub) {
      if (p.scope !== "operator" && p.scope !== "agent") throw new ApiError(403, "operator or agent scope required");
      if (p.scope === "agent") await requireRunning(p.agent);
      const b = obj(req.body);
      const decision = oneOf(b.decision, "decision", ["approve", "deny", "pass"] as const, "deny");
      if (b.decision === undefined) throw new ApiError(400, "decision must be one of: approve, deny, pass");
      const grantMicros = num(b.grantMicros, "grantMicros");
      const why = typeof b.why === "string" ? b.why : "";
      const key = idemKey(b);
      // An ancestor agent decides only the rung that names it (its own path, checks and locks); an operator goes through the action core.
      if (p.scope === "agent")
        return ok(
          await daemon.decideApproval(id, decision, `agent:${p.agent}`, why, key, { agent: p.agent, ...(grantMicros !== undefined && { grantMicros }) }),
          201,
        );
      return ok(await act({ kind: "decide", id, decision, why, ...(grantMicros !== undefined && { grantMicros }) }, key), 201);
    }
    throw new ApiError(404, "not found");
  }

  // Agent extension gateway (TODO(pi-ext)): the host-proxied extension tools an agent may call.
  // The capture broker (core wire types CaptureRequestBody, CaptureResponse, CaptureShowResponse and
  // CaptureListResponse). An agent asks with its own credential (fenced to its current generation) or the operator does; other
  // scopes are refused. Every outcome, failed and pending included, is a 200 CaptureResponse whose `message` is the model text.
  if (res === "capture") {
    if (p.scope !== "operator" && p.scope !== "agent") throw new ApiError(403, "operator or agent scope required");
    await fence();
    const broker = daemon.deps.capture;
    if (!broker) throw new ApiError(503, "the capture broker is not configured on this daemon");
    const who: CaptureRequester = p.scope === "agent" ? { kind: "agent", agent: p.agent, generation: p.generation } : { kind: "operator" };
    // ?waitMs= (pomtree capture request|wait --wait) is clamped to capture.waitMs: a request never holds a connection longer than that.
    const waitBound = daemon.deps.captureWaitMs ?? CONFIG_DEFAULTS["capture.waitMs"];
    const waitOf = (): number | undefined => {
      const raw = q.get("waitMs");
      if (raw === null) return undefined;
      if (!/^\d{1,9}$/.test(raw)) throw new ApiError(400, `waitMs must be a non-negative integer of milliseconds (at most capture.waitMs, ${waitBound})`);
      return Math.min(Number(raw), waitBound);
    };
    if (m === "POST" && !id) {
      const b = (req.body ?? {}) as Partial<CaptureRequestBody>;
      if (typeof b !== "object" || b === null || Array.isArray(b)) throw new ApiError(400, "body must be {request, idempotencyKey}");
      const key = idemKey(b as Record<string, unknown>);
      if (key.length > 200) throw new ApiError(400, "idempotencyKey must be 1-200 characters");
      const problem = captureRequestProblem(b.request);
      if (problem !== null) throw new ApiError(400, `invalid capture request: ${problem}`);
      const waitMs = waitOf();
      const scoped = p.scope === "agent" ? `agent:${p.agent}:${key}` : `operator:${key}`;
      const out: CaptureResponse = await broker.request(who, b.request as CaptureRequest, scoped, waitMs === undefined ? {} : { waitMs });
      return ok(out);
    }
    if (m === "GET" && id === "jobs" && action && !sub) {
      const out = await broker.wait(who, action, waitOf() ?? 0);
      if (out === null) throw new ApiError(404, `no such capture job: ${action}`);
      return ok(out);
    }
    if (m === "GET" && id && id !== "jobs" && !action) {
      const capture = await broker.show(id);
      if (capture === null) throw new ApiError(404, `no such capture: ${id}`);
      const body: CaptureShowResponse = { capture };
      return ok(body);
    }
    if (m === "GET" && !id) {
      const raw = q.get("limit");
      if (raw !== null && !/^\d{1,4}$/.test(raw)) throw new ApiError(400, `limit must be an integer 1-${CAPTURE_LIST_LIMIT_MAX}`);
      const body: CaptureListResponse = { captures: await broker.list(raw === null ? undefined : Number(raw)) };
      return ok(body);
    }
    throw new ApiError(404, "not found");
  }

  if (res === "ext") {
    if (p.scope !== "agent") throw new ApiError(403, "agent scope required");
    await fence(); // stale-generation tokens are rejected; extCall itself 403s a non-running agent
    const a = await exists(p.agent);
    if (m === "GET" && !id) return ok({ extensions: await daemon.extList(a) });
    if (m === "POST" && id && action === "call" && !sub) {
      const b = obj(req.body);
      return ok(await daemon.extCall(a, id, b.input, idemKey(b)));
    }
    throw new ApiError(404, "not found");
  }

  // Named workflow launch (TODO(flow-launch)): operator only, the raw action core (keys as-is, errors propagate). The chat route is
  // POST /v1/messages with intent "launch" (channel rank, default deny). The receipt is {kind:"launched", agent}.
  // Durable keyed state (SPEC workflow-store). Owner, key and prefix ride the query or body (keys contain "/"), never the path.
  if (res === "state") {
    const { state, stateGrants } = daemon.deps;
    if (!state || !stateGrants) throw new ApiError(503, "state store is not configured");
    return await handleState(
      {
        store: state,
        policy: stateGrants,
        get: (agent) => daemon.get(agent),
        root: () => daemon.root(),
        record: (rec, payload, key) => daemon.stateRecord(rec, payload, key),
        redactText: (text) => daemon.redactText(text),
      },
      { principal: p, method: m, sub: seg.slice(2), query: q, body: req.body, fence },
    );
  }

  if (res === "workflows") {
    if (m === "POST" && id === "launch" && !action) {
      operator();
      const b = obj(req.body);
      const rec = await act<AgentRecord>(
        {
          kind: "launch",
          workflow: reqStr(b, "workflow"),
          input: b.input === undefined ? {} : (b.input as JsonValue),
          budgetMicros: positiveInt(b.budgetMicros, "budgetMicros"),
          deadlineMs: num(b.deadlineMs, "deadlineMs"),
        },
        idemKey(b),
      );
      return ok({ kind: "launched", agent: rec.id }, 201);
    }
    throw new ApiError(404, "not found");
  }

  if (res !== "agents") throw new ApiError(404, "not found");

  if (!id) {
    if (m === "GET") {
      operator();
      const state = q.get("state") ?? undefined;
      if (state && !STATES.includes(state as AgentState)) throw new ApiError(400, `unknown state: ${state}`);
      return ok(
        await Promise.all(
          (await daemon.list({ parent: q.get("parent") ?? undefined, state: state as AgentState | undefined })).map(async (a) =>
            daemon.withWaiting(await daemon.withPendingReason(a)),
          ),
        ),
      );
    }
    if (m === "POST") {
      const b = obj(req.body);
      const spawnReq = {
        name: str(b, "name", false) ?? "agent",
        task: str(b, "task")!,
        idempotencyKey: idemKey(b),
        budgetMicros: positiveInt(b.budgetMicros, "budgetMicros"),
        deadlineMs: num(b.deadlineMs, "deadlineMs"),
        wrapupMs: positiveInt(b.wrapupMs, "wrapupMs"),
        template: str(b, "template", false),
        ...(b.disposition !== undefined && { disposition: dispositionBody(b.disposition) }),
      };
      // A zero deadline means no limit and is allowed for operators only; untrusted agents inherit
      // the configured/default bounded policy.
      if (spawnReq.deadlineMs === 0 && p.scope !== "operator") {
        throw new ApiError(403, "an unlimited deadline requires operator scope");
      }
      let model: { provider: string; id: string } | undefined;
      if (b.model !== undefined) {
        const mo = obj(b.model);
        model = { provider: str(mo, "provider")!, id: str(mo, "id")! };
        // Pass-through when the catalog is unavailable (source 'none'); otherwise the pick must be a listed model.
        const cat = daemon.deps.models ? await daemon.deps.models.list() : undefined;
        if (cat && cat.source !== "none" && !cat.models.some((x) => x.provider === model!.provider && x.id === model!.id)) {
          throw new ApiError(400, unknownModelMessage(model.provider, model.id), "unknown_model");
        }
      }
      if (b.fork !== undefined && typeof b.fork !== "boolean") throw new ApiError(400, "fork must be a boolean");
      const forkFields = {
        ...(b.fork !== undefined ? { fork: b.fork as boolean } : {}),
        ...(str(b, "fromCommit", false) !== undefined ? { fromCommit: str(b, "fromCommit", false) } : {}),
        ...(str(b, "sessionRef", false) !== undefined ? { sessionRef: str(b, "sessionRef", false) } : {}),
      };
      // An agent may --fork its OWN latest checkpoint (the daemon resolves it from the requester); explicit
      // fromCommit/sessionRef could read other agents' state, so they stay operator-only.
      if (p.scope !== "operator" && "sessionRef" in forkFields) {
        throw new ApiError(
          403,
          "sessionRef is operator-only (it could read other agents' state); agents can use fork to branch their own session, or describe the context in the task",
        );
      }
      // An agent may start a child from a commit inside its own subtree (its pushed work and its descendants'), validated by the merge engine.
      if (p.scope === "agent" && "fromCommit" in forkFields) {
        const full = await daemon.scopedCommit(p.agent, forkFields.fromCommit!);
        if (full === null)
          throw new ApiError(
            403,
            "fromCommit must be reachable from your own or your descendants' pushed branches (any other commit is operator-only: it could read other agents' state); agents can use fork to branch their own session",
          );
        forkFields.fromCommit = full;
      }
      if (p.scope !== "operator" && p.scope !== "agent" && Object.keys(forkFields).length) throw new ApiError(403, "fork requires operator or agent scope");
      let parent: AgentId;
      if (p.scope === "operator") parent = (await daemon.root()).id;
      else if (p.scope === "agent") {
        const caller = await exists(p.agent);
        if (caller.state !== "running") throw new ApiError(409, "only a running agent may spawn");
        parent = p.agent;
      } else throw new ApiError(403, "operator or agent scope required");
      const { idempotencyKey, ...request } = { ...spawnReq, ...forkFields, ...(model && { model }) };
      if (p.scope === "operator") return ok(await act({ kind: "spawn", parent, request }, idempotencyKey), 201);
      return ok(await daemon.spawn(parent, { ...request, idempotencyKey }), 201);
    }
    throw new ApiError(405, "method not allowed");
  }

  // Session trace for pasting into a chat (operator only; agents are 403 even for themselves). raw=1 skips redaction.
  if (action === "trace" && m === "GET" && !sub) {
    operator();
    const rec = await exists(id);
    const format = oneOf(q.get("format") ?? undefined, "format", ["md", "json"] as const, "md");
    const flag01 = (k: string) => {
      const v = q.get(k);
      if (v === null || v === "0" || v === "") return false;
      if (v === "1") return true;
      throw new ApiError(400, `${k} must be 0 or 1`);
    };
    const t = await buildTrace(daemon, rec, {
      raw: flag01("raw"),
      short: flag01("short"),
      children: q.get("include") === "children",
      maxBytes: positiveInt(q.get("maxBytes") ?? undefined, "maxBytes"),
    });
    if (format === "json")
      return ok({ agent: rec.id, markdown: t.text, bytes: t.bytes, events: t.events, omitted: t.omitted, redacted: t.redacted, raw: flag01("raw") });
    return {
      status: 200,
      body: Buffer.from(t.text, "utf8"),
      contentType: "text/markdown; charset=utf-8",
      headers: {
        "x-trace-events": String(t.events),
        "x-trace-omitted": String(t.omitted),
        "x-trace-redacted": String(t.redacted),
        "cache-control": "no-store",
      },
    };
  }

  // An ancestor (not only the direct parent) may resume its exited child, so that route checks descent itself.
  const ancestorResume = p.scope === "agent" && action === "resume" && m === "POST" && id !== undefined && id !== "self";
  if (ancestorResume) await fence();
  const agent = ancestorResume
    ? id!
    : await target(id, action === undefined || action === "events" || action === "wait" || action === "reap" || action === "transcript");
  if (!action && m === "GET") return ok(await daemon.withWaiting(await daemon.withPendingReason(await exists(agent))));

  // Session deadline: the operator (or an agent reading itself) GETs the current deadline; the operator
  // POSTs an idempotent relative extension.
  if (action === "deadline" && m === "GET" && !sub) {
    await exists(agent);
    return ok({ deadlineAt: await daemon.sessionDeadlineAt(agent) });
  }
  if (action === "deadline" && m === "POST" && !sub) {
    operator();
    await exists(agent);
    const b = obj(req.body);
    return ok(await daemon.extendDeadline(agent, num(b.deadlineMs, "deadlineMs"), idemKey(b)));
  }

  if (action === "inbox" && m === "GET") {
    if (p.scope !== "agent" || agent !== p.agent) throw new ApiError(403, "an agent may read only its own inbox");
    await requireRunning(agent);
    return ok(await daemon.inbox(agent, { waitMs: num(q.get("waitMs"), "waitMs") }));
  }

  // Ack (remove) signals by id: the mailbox extension acks what it injected; GET /inbox only peeks. Keyed-idempotent
  // and order-free (Mailbox.ack); unknown or already-gone ids are a no-op.
  if (action === "inbox" && sub === "ack" && m === "POST") {
    if (p.scope !== "agent" || agent !== p.agent) throw new ApiError(403, "an agent may ack only its own inbox");
    await requireRunning(agent);
    const b = obj(req.body);
    const key = idemKey(b);
    if (!Array.isArray(b.ids)) throw new ApiError(400, "ids must be an array of strings");
    const ids = strArray(b.ids, "ids");
    if (!ids.length) return ok({ acked: 0 });
    const got = await daemon.deps.mailbox.ack(agent, ids, `ack:${agent}:${p.generation}:${key}`);
    if (got.length) await daemon.steered(agent, got.length, key);
    return ok({ acked: got.length });
  }

  if (action === "budget" && m === "GET" && !sub) {
    if (p.scope !== "agent" || agent !== p.agent) throw new ApiError(403, "an agent may read only its own budget");
    await requireRunning(agent);
    const rec = await exists(agent);
    return ok({ budgetMicros: rec.budgetMicros, remainingMicros: await daemon.remainingMicros(rec) });
  }

  // `pomtree ask`: raise an escalation, and poll one by id until it is answered (see Daemon.ask/waitAsk).
  if (action === "ask" && m === "POST" && !sub) {
    if (p.scope !== "agent" || agent !== p.agent) throw new ApiError(403, "an agent may ask only for itself");
    const b = obj(req.body);
    const generation = num(b.generation, "generation");
    if (generation === undefined || !Number.isInteger(generation)) throw new ApiError(400, "generation must be a non-negative integer");
    await requireRunning(agent);
    return ok(
      await daemon.ask(agent, {
        question: str(b, "question")!,
        options: strArray(b.options, "options"),
        generation,
        idempotencyKey: idemKey(b),
      }),
      201,
    );
  }
  if (action === "ask" && m === "GET" && sub) {
    if (p.scope !== "agent" || agent !== p.agent) throw new ApiError(403, "an agent may wait only for its own ask");
    await requireRunning(agent);
    return ok(await daemon.waitAsk(agent, sub, num(q.get("waitMs"), "waitMs") ?? 0));
  }

  if (action === "wait" && m === "GET") {
    await exists(agent);
    return ok(await daemon.waitDone(agent, num(q.get("timeoutMs"), "timeoutMs") ?? 0, p.scope === "agent" ? p.agent : undefined));
  }

  if (action === "reap" && m === "POST") {
    // Reaping is operator-only for non-agents; an agent may reap only itself or its own child (target()).
    if (p.scope !== "operator" && p.scope !== "agent") throw new ApiError(403, "operator scope required");
    const rb = req.body === undefined || req.body === null ? {} : obj(req.body);
    return ok(await daemon.reap(agent, idemKey(rb), true));
  }

  if (action === "transcript" && m === "GET") {
    await exists(agent);
    const t = await daemon.transcript(agent, num(q.get("limit"), "limit"));
    if (!t) throw new ApiError(404, "no checkpointed session transcript");
    return ok(t);
  }

  if (action === "events" && m === "GET") {
    await exists(agent);
    return ok(
      await daemon.events({
        agent,
        from: num(q.get("from"), "from"),
        limit: num(q.get("limit"), "limit"),
        tail: num(q.get("tail"), "tail"),
        waitMs: num(q.get("waitMs"), "waitMs"),
      }),
    );
  }

  // Operator UI chat: POST a message to an agent (journal + human_message + wake).
  if (action === "message" && m === "POST" && !sub) {
    operator();
    const b = obj(req.body);
    const mode = b.mode ?? "queue";
    if (mode !== "queue" && mode !== "interrupt") throw new ApiError(400, "mode must be queue or interrupt");
    return ok(await act({ kind: "signal", to: agent, body: str(b, "body")!, mode }, idemKey(b)), 201);
  }

  if (action === "result" && m === "POST") {
    if (p.scope !== "agent") throw new ApiError(403, "agent scope required");
    const b = obj(req.body);
    const status = b.status ?? "succeeded";
    if (status !== "succeeded" && status !== "failed") throw new ApiError(400, "status must be succeeded or failed");
    const out = await daemon.submitResult(agent, status, b.result, idemKey(b), str(b, "saveUncommitted", false));
    if (out === null) throw new ApiError(404, "no such agent");
    if (out === "conflict") throw new ApiError(409, "agent is not running or already has a result");
    return ok(out);
  }

  // `pomtree publish`: the agent pushes its own branch host-side (approval-gated, allow-listed target).
  if (action === "publish" && m === "POST" && !sub) {
    if (p.scope !== "agent" || agent !== p.agent) throw new ApiError(403, "an agent may publish only for itself");
    const b = obj(req.body);
    await requireRunning(agent);
    return ok(await daemon.publish(agent, { branch: str(b, "branch")!, target: str(b, "target")!, idempotencyKey: idemKey(b) }), 201);
  }

  // `pomtree wait/inbox --wait/ask --wait` (agents): park under the hood when the wait is long; { parked: false } otherwise.
  if (action === "park" && m === "POST") {
    if (p.scope !== "agent" || agent !== p.agent) throw new ApiError(403, "an agent may park only itself");
    await fence(); // not requireRunning: a retry of a park that already landed must get its checkpoint back
    const b = obj(req.body);
    const timeoutMs = num(b.timeoutMs, "timeoutMs");
    if (timeoutMs === undefined) throw new ApiError(400, "timeoutMs must be a non-negative number");
    const on = obj(b.on);
    const kind = on.kind;
    if (kind !== "child" && kind !== "inbox" && kind !== "ask") throw new ApiError(400, "on.kind must be one of: child, inbox, ask");
    const key = idemKey(b);
    const spec: Parameters<typeof daemon.parkForWait>[1]["on"] =
      kind === "child" ? { kind, child: str(on, "child")! } : kind === "ask" ? { kind, escalation: str(on, "escalation")! } : { kind };
    return ok(await daemon.parkForWait(agent, { on: spec, timeoutMs, idempotencyKey: key }), 201);
  }

  // `pomtree await-user`: an agent declares its next settle waits for a human (accepted only after an interactive message).
  if (action === "await-user" && m === "POST") {
    if (p.scope !== "agent" || agent !== p.agent) throw new ApiError(403, "an agent may declare only for itself");
    return ok(await daemon.awaitUser(agent, idemKey(obj(req.body))), 201);
  }

  // `pomtree yield`: an agent checkpoints itself and parks until its wait condition is met.
  if (action === "yield" && m === "POST") {
    if (p.scope !== "agent") throw new ApiError(403, "agent scope required");
    const b = obj(req.body);
    return ok(await daemon.yield(agent, { wait: parseWait(b.wait), idempotencyKey: idemKey(b) }), 201);
  }

  // `pomtree merge CHILD`: the caller's own merge of a descendant; the key rides the query like `pomtree push`.
  if (action === "merge" && m === "POST" && !sub) {
    if (p.scope !== "agent" || agent !== p.agent) throw new ApiError(403, "an agent may merge only for itself");
    const key = q.get("key");
    if (!key) throw new ApiError(400, IDEMPOTENCY_QUERY_KEY_REQUIRED);
    const b = obj(req.body);
    const into = str(b, "into", false);
    const child = str(b, "child", false); // omitted = merge yourself (top-level agent, into the default branch)
    const out = await daemon.merge(agent, p.generation, key, { ...(child !== undefined && { child }), ...(into !== undefined && { into }) });
    return mergeHttp(out);
  }

  // Resume: the operator for any yielded agent; an agent for its own exited, unreaped descendant (a merge conflict to fix).
  if (action === "resume" && m === "POST" && p.scope === "agent") {
    const b = obj(req.body ?? {});
    if (b.force === true || b["--force"] === true) throw new ApiError(403, "--force is operator-only");
    idemKey(b);
    return ok(await daemon.resumeChild(p.agent, p.generation, id === "self" ? p.agent : agent));
  }
  if (action === "resume" && m === "POST") {
    operator();
    const b = obj(req.body ?? {});
    const forced = b.force === true || b["--force"] === true;
    return ok(await daemon.resumeAgent(agent, undefined, forced ? { forced: true, operator: true } : { operator: true }, idemKey(b)));
  }
  if (action === "checkpoint" && m === "GET") {
    if (p.scope === "agent" && agent !== p.agent) throw new ApiError(403, "an agent may read only its own checkpoint");
    await exists(agent);
    const cp = await daemon.deps.checkpoints.latest(agent);
    if (!cp) throw new ApiError(404, "no checkpoint");
    return ok(cp);
  }

  if ((action === "cancel" || action === "kill") && m === "POST") {
    operator();
    const r = await exists(agent);
    if (r.state === "exited" || r.state === "reaped") throw new ApiError(409, `agent already ${r.state}`);
    const cb = obj(req.body ?? {});
    const key = idemKey(cb);
    if (action === "cancel") await act({ kind: "cancel", to: agent, graceMs: num(cb.graceMs, "graceMs") }, key);
    else await daemon.kill(agent, key);
    return ok({ accepted: true }, 202);
  }

  throw new ApiError(404, "not found");
}
