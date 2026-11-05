// Declared capabilities of reviewed workflows: normalization at commit, and the per-run `ctx.workflow` ops. Every effect is
// fenced to the live task (generation, abort, deadline), keyed by workflow + instance (not by task) so a repaired task replays the
// same logical effect, and audited into the ROOT journal. Cooperative, not isolation: the host checks and meters, a reviewed
// handler can still reach ambient daemon code.
import { createHash } from "node:crypto";
import type {
  AgentId,
  AgentRecord,
  DeterministicRunContext,
  ExtensionJournalPayload,
  JournalEntry,
  JsonValue,
  QuotaCounters,
  Report,
  StateStore,
  WorkflowCapabilities,
  WorkflowFetchJournalPayload,
  WorkflowFetchResult,
  WorkflowRunOps,
  WorkflowStateJournalPayload,
} from "@pomtree/core";
import { auditUrl, capturePendingMessage, checkStateKey, isJsonValue, POMTREED_KINDS, STATE_KEY_MAX_LENGTH } from "@pomtree/core";
import { LifecycleError } from "./lifecycle.ts";
import { memoryQuotaCounters, QUOTA_SCOPES } from "./quota.ts";
import type { CaptureBroker, CaptureScope } from "./capture/types.ts";
import { scopeDenial, urlPolicy } from "./ext-gateway.ts";
import { redactionChangesIds, SHARED_SCOPE, stateOpPayload } from "./state-policy.ts";

export const STATE_KIND = POMTREED_KINDS.workflowState;
export const PROVENANCE_KIND = POMTREED_KINDS.workflowReport;
export const FETCH_KIND = POMTREED_KINDS.workflowFetch;

export const STATE_VERSION = 1 as const; // versioned state payload; any other or missing version is refused on read (fail closed)
export const STATE_MAX_BYTES = 128 * 1024;
export const FETCH_TIMEOUT_MAX_MS = 10_000;
export const INSTANCE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const KEYS = ["state", "store", "sharedStore", "fetch", "reports", "ask", "modelChildren"];
// The extension-wide key scope of ctx.workflow.shared (see buildRunOps); defined with the policy that reserves it.
export { SHARED_SCOPE };
const PAGE = 500;

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

// Validates and snapshots declared capabilities. Undefined declares nothing and normalizes to `{}`: no workflow ops, and no model children. Malformed declarations
// throw at commit, before anything from the extension is admitted. `ceilingBytes` is the resolved report ceiling
// (min(report.workflowMaxBytes, report.maxBytes)): a fetch or reports maxBytes above it is refused here, so the runtime never
// has to clamp a declaration.
export function normalizeCapabilities(q: string, raw: unknown, ceilingBytes: number): WorkflowCapabilities {
  if (raw === undefined) return {};
  if (!isPlain(raw)) throw new Error(`workflow ${q}: capabilities must be an object`);
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) throw new Error(`workflow ${q}: unknown capability ${JSON.stringify(k)}`);
  const out: WorkflowCapabilities = {};
  const bad = (what: string): never => {
    throw new Error(`workflow ${q}: malformed capability ${what}`);
  };
  const ceiling = (what: string, v: number): void => {
    if (v > ceilingBytes)
      throw new Error(`workflow ${q}: capability ${what} ${v} exceeds the report ceiling ${ceilingBytes} (report.workflowMaxBytes, report.maxBytes)`);
  };
  if (raw.state !== undefined) {
    if (typeof raw.state !== "boolean") bad("state");
    out.state = raw.state as boolean;
  }
  if (raw.store !== undefined) {
    if (!isPlain(raw.store) || Object.keys(raw.store).length > 0) bad("store");
    out.store = {};
  }
  if (raw.sharedStore !== undefined) {
    const m = raw.sharedStore;
    if (!isPlain(m) || Object.keys(m).join(",") !== "mode" || (m.mode !== "r" && m.mode !== "rw")) bad("sharedStore");
    out.sharedStore = { mode: (m as { mode: "r" | "rw" }).mode };
  }
  if (raw.ask !== undefined) {
    if (typeof raw.ask !== "boolean") bad("ask");
    out.ask = raw.ask as boolean;
  }
  if (raw.fetch !== undefined) {
    const f = raw.fetch;
    if (!isPlain(f) || Object.keys(f).sort().join(",") !== "hosts,maxBytes,maxRequests,timeoutMs") bad("fetch");
    const fo = f as Record<string, unknown>;
    if (!Array.isArray(fo.hosts) || fo.hosts.length < 1 || fo.hosts.length > 16) bad("fetch.hosts");
    const hosts = fo.hosts as unknown[];
    if (!hosts.every((h) => typeof h === "string" && HOST_RE.test(h)) || new Set(hosts).size !== hosts.length) bad("fetch.hosts");
    if (!int(fo.maxRequests, 1, 20) || !int(fo.maxBytes, 1, Number.MAX_SAFE_INTEGER) || !int(fo.timeoutMs, 1, FETCH_TIMEOUT_MAX_MS)) bad("fetch limits");
    ceiling("fetch.maxBytes", fo.maxBytes as number);
    out.fetch = { hosts: [...(hosts as string[])], maxRequests: fo.maxRequests as number, maxBytes: fo.maxBytes as number, timeoutMs: fo.timeoutMs as number };
  }
  if (raw.reports !== undefined) {
    const r = raw.reports;
    if (!isPlain(r) || Object.keys(r).join(",") !== "maxBytes" || !int(r.maxBytes, 1, Number.MAX_SAFE_INTEGER)) bad("reports");
    ceiling("reports.maxBytes", (r as { maxBytes: number }).maxBytes);
    out.reports = { maxBytes: (r as { maxBytes: number }).maxBytes };
  }
  if (raw.modelChildren !== undefined) {
    const m = raw.modelChildren;
    if (!isPlain(m) || Object.keys(m).join(",") !== "maxBudgetMicros" || !int(m.maxBudgetMicros, 1, Number.MAX_SAFE_INTEGER)) bad("modelChildren");
    out.modelChildren = { maxBudgetMicros: (m as { maxBudgetMicros: number }).maxBudgetMicros };
  }
  return out;
}

// Input-side admission: `instance` names the durable scope. Any provided instance must match INSTANCE_RE (even without `state`, so
// scope keys cannot be ambiguous); absent is "" for workflows that declare no state, and required when state is declared.
export function instanceOf(q: string, caps: WorkflowCapabilities, input: JsonValue): string {
  const inst = isPlain(input) ? (input as Record<string, unknown>).instance : undefined;
  if (inst === undefined) {
    if (caps.state) throw new Error(`workflow ${q}: input.instance must match ${INSTANCE_RE}`);
    return "";
  }
  if (typeof inst !== "string" || !INSTANCE_RE.test(inst)) throw new Error(`workflow ${q}: input.instance must match ${INSTANCE_RE}`);
  return inst;
}

export interface WorkflowCapabilityServices {
  root(): Promise<AgentRecord>;
  agent(id: AgentId): Promise<AgentRecord | null>;
  readRoot(from: number, limit: number): Promise<JournalEntry[]>; // root journal page, seq >= from
  recordRoot(payload: ExtensionJournalPayload, key: string): Promise<unknown>;
  publishRoot(req: { name: string; content: Uint8Array; mediaType?: string; key: string }): Promise<Report>;
  sendToUser(body: string, key: string): Promise<void>;
  state?: StateStore; // the daemon's keyed state store (ctx.workflow.store); absent = the capability answers 503
  redactText(text: string): string; // the journal's host-path redaction; state is rejected before any write if it would change
  ask(agent: AgentId, req: { question: string; generation: number; idempotencyKey: string }): Promise<{ escalation: string }>;
  // The capture broker ctx.workflow.fetch is a client of (capture/types.ts): robots.txt, the shared cache, domain pacing, redirects
  // and provenance are the broker's. Absent: every fetch refuses with FETCH_BROKER_REQUIRED (there is no direct path).
  capture?: CaptureBroker;
  // Durable counter for ctx.workflow.fetch's per-task maxRequests (QUOTA_SCOPES.workflowFetchRequests, key `<task>:<generation>`), so
  // a daemon restart mid-task does not hand the task a fresh budget. Absent: a per-run process-local counter (TODO(durable-quota)).
  quota?: QuotaCounters;
  now(): number;
}

// The refusal when the services carry no capture broker: names the missing wiring and the action.
export const FETCH_BROKER_REQUIRED =
  "workflow fetch refused: no capture broker is wired into the workflow capability services (WorkflowCapabilityServices.capture), and the fetch capability has no other path. Build one with createCaptureBroker (pomtreed capture/broker.ts) and pass it as services.capture";

// The HTTP status a failed capture maps to for the workflow handler (LifecycleError): policy refusals 403 as before, a budget or
// rate limit 429, an unconfigured broker 503, a timeout 504, everything upstream 502.
function fetchFailureStatus(cls: string, reason?: string): number {
  if (cls === "invalid_request") return 400;
  if (cls === "forbidden" || cls === "denied" || cls === "blocked" || (cls === "network" && reason === "egress_denied")) return 403;
  if (cls === "quota" || cls === "rate_limited") return 429;
  if (cls === "pending_approval") return 409;
  if (cls === "unavailable") return 503;
  if (cls === "timeout") return 504;
  return 502;
}

export const scopedKey = (workflow: string, instance: string, effect: string, key: string): string => {
  if (typeof key !== "string" || key === "" || key.length > 200) throw new LifecycleError(400, "effect idempotency key must be 1-200 characters");
  return `wf:${workflow}:${instance}:${effect}:${key}`;
};

// Live fence: the task must still be the running generation, unaborted and before its deadline. Checked before and after effects.
async function assertLive(s: WorkflowCapabilityServices, ctx: DeterministicRunContext): Promise<void> {
  const a = await s.agent(ctx.agent);
  if (a?.state !== "running" || a.generation !== ctx.generation) throw new LifecycleError(409, "workflow task is no longer live");
  if (ctx.signal.aborted) throw new LifecycleError(409, "workflow task is cancelled");
  if (ctx.deadlineAt !== null && s.now() >= ctx.deadlineAt) throw new LifecycleError(409, "workflow task deadline reached");
}

// True when journal redaction would alter any string in `v` (values and object keys): such state cannot round-trip, so it is
// refused before the write instead of being stored redacted (which would then read back as a conflict).
function redactionChanges(s: WorkflowCapabilityServices, v: unknown): boolean {
  if (typeof v === "string") return s.redactText(v) !== v;
  if (Array.isArray(v)) return v.some((x) => redactionChanges(s, x));
  if (v !== null && typeof v === "object")
    return Object.entries(v as Record<string, unknown>).some(([k, x]) => s.redactText(k) !== k || redactionChanges(s, x));
  return false;
}

// Matching state entries for one workflow instance, read from the root journal page by page.
// TODO(workflow-state-scan): correct but unindexed full-root-journal scan on every call; add a reviewed per-instance lookup when scan cost matters.
async function stateEntries(s: WorkflowCapabilityServices, q: string, instance: string): Promise<{ seq: number; key: unknown; value: JsonValue }[]> {
  const out: { seq: number; key: unknown; value: JsonValue }[] = [];
  let from = 0;
  for (;;) {
    const page = await s.readRoot(from, PAGE);
    for (const e of page) {
      const p = e.payload as unknown as Record<string, unknown>;
      if (p.kind !== STATE_KIND || p.workflow !== q || p.instance !== instance) continue;
      if (p.v !== STATE_VERSION) throw new LifecycleError(409, "workflow state version is not supported");
      out.push({ seq: e.seq, key: p.key, value: p.value as JsonValue });
    }
    if (page.length < PAGE) return out;
    const last = page[page.length - 1];
    if (!last) return out;
    from = last.seq + 1;
  }
}

// Builds the per-run `ctx.workflow` surface. `getServices` is read per call (services may be wired after the host is built).
export function buildRunOps(args: {
  workflow: string;
  caps: WorkflowCapabilities;
  ctx: DeterministicRunContext;
  getServices: () => WorkflowCapabilityServices | undefined;
  // The owning WorkflowHost joins these independently of the handler, including effects the handler did not await.
  trackEffect?: <T>(work: () => Promise<T>) => Promise<T>;
}): WorkflowRunOps {
  const { workflow: q, caps, ctx } = args;
  const instance = instanceOf(q, caps, ctx.input);
  const svc = (): WorkflowCapabilityServices => {
    const s = args.getServices();
    if (!s) throw new LifecycleError(503, "workflow services are not configured");
    return s;
  };
  const need = <K extends keyof WorkflowCapabilities>(k: K): NonNullable<WorkflowCapabilities[K]> => {
    const v = caps[k];
    if (v === undefined || v === false) throw new LifecycleError(403, `workflow capability not declared: ${k}`);
    return v as NonNullable<WorkflowCapabilities[K]>;
  };
  const owner = q.split("/")[0] as string;
  const wf = q.slice(owner.length + 1);
  const stateOf = (s: WorkflowCapabilityServices): StateStore => {
    if (!s.state) throw new LifecycleError(503, "state store is not configured");
    return s.state;
  };
  // The writer and its journal attribution name the workflow and instance, never the task: a repaired task's replay is the same
  // request to the store (same fingerprint, same stored result) and the same journal entry (same key, same payload), and a reader
  // tells a workflow-written doc from an agent's ({ agent, host, generation }) or the operator's. The task goes to the store as the
  // `fence` only, checked against the registry inside the write (outside the fingerprint), on top of assertLive.
  const writer = { workflow: q, instance };
  const fence = { agent: ctx.agent, generation: ctx.generation };
  const by = { by: "workflow" as const, workflow: q, instance };
  const localQuota = memoryQuotaCounters(); // used only when the services carry no durable counters
  const requestKey = `${ctx.agent}:${ctx.generation}`;
  const fetchQuota = (): QuotaCounters => args.getServices()?.quota ?? localQuota;
  const requestsUsed = (): number => fetchQuota().peek(QUOTA_SCOPES.workflowFetchRequests, requestKey, 0);
  let unsentRows = 0;
  const effect = <T>(fn: (s: WorkflowCapabilityServices) => Promise<T>): Promise<T> => {
    const work = async (): Promise<T> => {
      const s = svc();
      await assertLive(s, ctx);
      const r = await fn(s);
      await assertLive(s, ctx);
      return r;
    };
    return args.trackEffect ? args.trackEffect(work) : work();
  };
  // One keyed-state surface over the StateStore, parameterized by its key scope (store: workflow + instance; shared: extension-wide).
  // The scoped key must still fit STATE_KEY_MAX_LENGTH, so the caller's own key has the rest as its budget; refuse up front, naming it,
  // rather than let the store reject the (longer, scope-bearing) key.
  const keyed = (k: { need: () => void; scope: string; scopeName: string; effect: string; writable?: () => void }): WorkflowRunOps["store"] => {
    const { scope } = k;
    const budget = STATE_KEY_MAX_LENGTH - scope.length;
    const scoped = (key: string, what: string): string => {
      if (key.length > budget) {
        throw new LifecycleError(
          400,
          `state ${what} is ${key.length} characters; ${k.scopeName} a budget of ${budget} (${STATE_KEY_MAX_LENGTH} minus the ${scope.length}-character scope)`,
        );
      }
      return scope + key;
    };
    const unscope = <T extends { key: string } | null>(d: T): T => (d === null ? d : { ...d, key: d.key.slice(scope.length) });
    const mutable = (): void => {
      k.need();
      k.writable?.();
    };
    return {
      async get(key) {
        k.need();
        checkStateKey(key);
        const sk = scoped(key, "key");
        return effect(async (s) => unscope(await stateOf(s).get(owner, sk)));
      },
      async put(req, idem) {
        mutable();
        checkStateKey(req.key);
        const full = scoped(req.key, "key");
        const sk = scopedKey(q, instance, k.effect, idem);
        return effect(async (s) => {
          if (redactionChangesIds((t) => s.redactText(t), [req.key])) throw new LifecycleError(400, "state key must not contain host paths");
          const res = await stateOf(s).put(
            { owner, key: full, value: req.value, ...(req.expectRev !== undefined && { expectRev: req.expectRev }), writer, fence },
            sk,
          );
          if (!res.ok) return res;
          await s.recordRoot(stateOpPayload({ op: "put", owner, key: res.doc.key, rev: res.doc.rev, bytes: res.doc.bytes, ...by }), `state:put:${sk}`);
          return { ok: true as const, doc: unscope(res.doc) as typeof res.doc };
        });
      },
      async list(opts) {
        k.need();
        const prefix = scoped(opts?.prefix ?? "", "prefix");
        const after = opts?.after === undefined ? undefined : scoped(opts.after, "cursor");
        return effect(async (s) => {
          const rows = await stateOf(s).list(owner, {
            prefix,
            ...(after !== undefined && { after }),
            ...(opts?.limit !== undefined && { limit: opts.limit }),
          });
          return rows.map((r) => unscope(r) as typeof r);
        });
      },
      async rm(req, idem) {
        mutable();
        const key = req.key === undefined ? undefined : scoped(req.key, "key");
        const prefix = req.prefix === undefined ? undefined : scoped(req.prefix, "prefix");
        const sk = scopedKey(q, instance, k.effect, idem);
        return effect(async (s) => {
          if (redactionChangesIds((t) => s.redactText(t), [req.key, req.prefix])) throw new LifecycleError(400, "state key must not contain host paths");
          const res = await stateOf(s).remove(
            {
              owner,
              ...(key !== undefined && { key }),
              ...(prefix !== undefined && { prefix }),
              ...(req.olderThanMs !== undefined && { olderThanMs: req.olderThanMs }),
              ...(req.expectRev !== undefined && { expectRev: req.expectRev }),
              writer,
              fence,
            },
            sk,
          );
          if (!res.ok) return res;
          await s.recordRoot(
            stateOpPayload({
              op: "rm",
              owner,
              ...(key !== undefined && { key }),
              ...(prefix !== undefined && { prefix }),
              count: res.removed,
              ...by,
            }),
            `state:rm:${sk}`,
          );
          return { ok: true as const, removed: res.removed, keys: res.keys.map((x) => x.slice(scope.length)) };
        });
      },
    };
  };
  return {
    instance,
    // Per task (new agent id per launch). Handlers that need a stable logical run persist it in their own state; this is not durable.
    runKey: ctx.agent,
    // TODO(workflow-store): finish state store stages 2 and 3. Current behavior: getState/setState use root journal rows.
    // This cell lives beside the keyed StateStore below and is read by scanning those journal rows.
    // Single instance cell, intentionally unkeyed on read: getState returns the latest accepted write for this workflow + instance.
    // The `key` argument of setState is a mutation idempotency key (same key + same value is a replay; same key + other value is
    // refused), not a cell name. There is no generic key/value store. Each payload carries STATE_VERSION (v:1).
    async getState() {
      need("state");
      return effect(async (s) => {
        const entries = await stateEntries(s, q, instance);
        return entries.length === 0 ? null : entries.reduce((a, b) => (b.seq > a.seq ? b : a)).value;
      });
    },
    async setState(value, key) {
      need("state");
      if (!isJsonValue(value)) throw new LifecycleError(400, "state must be JSON data");
      if (Buffer.byteLength(canonicalJson(value)) > STATE_MAX_BYTES) throw new LifecycleError(400, "state exceeds the 128 KiB cap");
      const sk = scopedKey(q, instance, "state", key);
      await effect(async (s) => {
        if (s.redactText(key) !== key || redactionChanges(s, value)) throw new LifecycleError(400, "state key and value must not contain host paths");
        const prior = (await stateEntries(s, q, instance)).filter((e) => e.key === key);
        if (prior.some((e) => canonicalJson(e.value) !== canonicalJson(value)))
          throw new LifecycleError(409, "state key is already bound to a different value");
        if (prior.length > 0) return;
        // Journaled on the root (getState reads it back there), attributed to the writing task like the fetch row. A repaired task's
        // exact replay returns above, before this write, so the task in the payload never makes a replay look like a conflict.
        const row: WorkflowStateJournalPayload = {
          kind: STATE_KIND,
          v: STATE_VERSION,
          workflow: q,
          instance,
          execution: ctx.agent,
          generation: ctx.generation,
          key,
          value,
        };
        await s.recordRoot(row as unknown as ExtensionJournalPayload, sk);
        // Concurrent writers: an idempotency-key collision with a different value must not look successful.
        const after = (await stateEntries(s, q, instance)).filter((e) => e.key === key);
        if (after.some((e) => canonicalJson(e.value) !== canonicalJson(value)))
          throw new LifecycleError(409, "state key is already bound to a different value");
      });
    },
    // Keyed state owned by the extension (owner = the extension name). Keys are scoped to workflow + instance, `<wf>/i/<instance>/<key>`
    // (or `<wf>/g/<key>` without an instance), so two workflows or instances never share a key; the scope prefix is stripped on the way
    // out. Fenced like every effect, and each mutation journals one content-free state_op into the root journal.
    store: keyed({
      need: () => void need("store"),
      scope: instance === "" ? `${wf}/g/` : `${wf}/i/${instance}/`,
      scopeName: "this workflow and instance leave",
      effect: "store",
    }),
    // Extension-wide keyed state (same owner), shared by every workflow of the extension under SHARED_SCOPE. A workflow name never
    // contains "/" and its scope's second segment is always "g" or "i", so `ext/s/` cannot collide with a workflow named `ext`. The
    // mutation idempotency key stays scoped to workflow + instance (two workflows reusing a caller key never collide). A write is
    // data only: no signal, delivery or launch follows it.
    shared: keyed({
      need: () => void need("sharedStore"),
      scope: SHARED_SCOPE,
      scopeName: "the extension-wide shared scope leaves",
      effect: "shared",
      writable: () => {
        if (need("sharedStore").mode !== "rw") throw new LifecycleError(403, 'workflow capability sharedStore is read-only (mode "r"): writes are refused');
      },
    }),
    async fetch(url) {
      const policy = need("fetch");
      // Every call is journaled on the root (core WorkflowFetchJournalPayload), keyed by task, generation and call ordinal. The ordinal
      // is a durable counter, so a restarted task's calls never reuse an earlier call's journal key (which would drop their rows).
      const call = fetchQuota().take(QUOTA_SCOPES.workflowFetchCalls, requestKey, 0, 1, Number.MAX_SAFE_INTEGER).used - 1;
      type Row = Pick<
        WorkflowFetchJournalPayload,
        "ok" | "status" | "bytes" | "contentType" | "sha256" | "durationMs" | "requests" | "redirects" | "finalUrl" | "error"
      >;
      const journalFetch = async (s: WorkflowCapabilityServices, row: Row): Promise<void> => {
        // Calls that sent nothing are bounded to maxRequests rows per task, so a refusal loop cannot flood the journal.
        if (row.requests === 0 && unsentRows++ >= policy.maxRequests) return;
        const payload: WorkflowFetchJournalPayload = {
          kind: FETCH_KIND,
          workflow: q,
          instance,
          execution: ctx.agent,
          generation: ctx.generation,
          url: s.redactText(auditUrl(url)),
          ...row,
          ...(row.error !== undefined && { error: s.redactText(row.error).slice(0, 200) }),
          ...(row.contentType !== undefined && { contentType: s.redactText(row.contentType).slice(0, 200) }),
          maxBytes: policy.maxBytes,
          requestsUsed: requestsUsed(),
          maxRequests: policy.maxRequests,
        };
        await s.recordRoot(payload as unknown as ExtensionJournalPayload, scopedKey(q, instance, "fetch", `${ctx.agent}:${ctx.generation}:${call}`));
      };
      // maxRequests is a per-TASK budget of origin requests SENT, keyed by task and generation in QuotaCounters (a repaired task starts
      // at zero; repair does not re-fetch by design; a daemon restart does not reset it). Every redirect hop is a request (EDGAR
      // rate-limits per request): the capture broker calls takeRequest synchronously right before each origin send of a job this call
      // creates, so a hop past the budget is never sent and concurrent fetches cannot overspend. A cache hit or a joined job sends
      // nothing and is charged nothing; robots.txt reads are the broker's and are not charged.
      const broker = svc().capture;
      if (!broker) {
        await journalFetch(svc(), { ok: false, durationMs: 0, requests: 0, redirects: 0, error: "no capture broker is wired" });
        throw new LifecycleError(503, FETCH_BROKER_REQUIRED);
      }
      if (requestsUsed() >= policy.maxRequests) {
        await journalFetch(svc(), { ok: false, durationMs: 0, requests: 0, redirects: 0, error: "fetch request budget exhausted" });
        throw new LifecycleError(409, "fetch request budget exhausted");
      }
      // The capability's own refusals come first, unchanged: the URL shape, credentials and fragments, and its `hosts` scope (403, no
      // approval). The broker re-checks the scope on every redirect hop.
      const policyCheck = urlPolicy(url);
      if (!policyCheck.ok) {
        await journalFetch(svc(), { ok: false, durationMs: 0, requests: 0, redirects: 0, error: policyCheck.reason });
        throw new LifecycleError(502, policyCheck.reason);
      }
      const first = policyCheck.url;
      const shape =
        first.username !== "" || first.password !== "" || url.includes("#") ? "credentials and fragments are refused" : scopeDenial(first, policy.hosts);
      if (shape !== null) {
        await journalFetch(svc(), { ok: false, durationMs: 0, requests: 0, redirects: 0, error: shape });
        throw new LifecycleError(403, shape);
      }
      return effect(async (s) => {
        const started = s.now();
        const remainingMs = ctx.deadlineAt === null ? policy.timeoutMs : Math.min(policy.timeoutMs, ctx.deadlineAt - s.now());
        if (!(remainingMs > 0)) {
          await journalFetch(s, { ok: false, durationMs: 0, requests: 0, redirects: 0, error: "fetch deadline reached" });
          throw new LifecycleError(502, "fetch deadline reached");
        }
        const scope: CaptureScope = { allows: (u) => scopeDenial(u, policy.hosts) === null };
        let sent = 0;
        let refusedHop: number | null = null;
        const takeRequest = (): boolean => {
          if (!fetchQuota().take(QUOTA_SCOPES.workflowFetchRequests, requestKey, 0, 1, policy.maxRequests).ok) {
            refusedHop = sent;
            return false;
          }
          sent++;
          return true;
        };
        const resp = await broker.request(
          { kind: "agent", agent: ctx.agent, generation: ctx.generation },
          { url, render: "static", purpose: `workflow ${q} fetch` },
          `workflow_fetch:${ctx.agent}:${ctx.generation}:${call}`,
          // The body read stops at the capability's maxBytes (bounded by the report ceiling at commit, normalizeCapabilities).
          { waitMs: remainingMs, signal: ctx.signal, scope, takeRequest, maxBytes: policy.maxBytes },
        );
        const o = resp.outcome;
        const durationMs = Math.max(0, s.now() - started);
        if (o.state !== "ok") {
          const hop = refusedHop as number | null;
          const exhausted = o.state === "failed" && o.failure.class === "quota" && hop !== null;
          const error = exhausted
            ? hop === 0
              ? "fetch request budget exhausted"
              : `fetch request budget exhausted: redirect hop ${hop} would exceed maxRequests (every hop is a request)`
            : (resp.message ?? (o.state === "pending" ? capturePendingMessage(o.job) : o.failure.class));
          await journalFetch(s, {
            ok: false,
            durationMs,
            requests: sent,
            redirects: Math.max(0, sent - 1),
            ...(o.state === "failed" && o.failure.status !== undefined && { status: o.failure.status }),
            error,
          });
          throw new LifecycleError(exhausted ? 409 : o.state === "pending" ? 504 : fetchFailureStatus(o.failure.class, o.failure.reason), error);
        }
        const meta = o.capture.predicate.fetch;
        const facts = { durationMs, requests: sent, redirects: meta.redirects.length, status: meta.status };
        const raw = o.capture.artifacts.find((a) => a.role === "raw");
        if (raw === undefined || raw.sizeBytes > policy.maxBytes) {
          const error = raw === undefined ? `capture ${o.capture.id} has no raw body` : `response body exceeds ${policy.maxBytes} bytes`;
          await journalFetch(s, { ok: false, ...facts, error });
          throw new LifecycleError(502, error);
        }
        const bytes = await broker.read(raw);
        const finalUrl = auditUrl(meta.finalUrl);
        await journalFetch(s, {
          ok: true,
          ...facts,
          bytes: raw.sizeBytes,
          ...(meta.contentType !== null && { contentType: meta.contentType }),
          sha256: raw.sha256,
          ...(finalUrl !== auditUrl(url) && { finalUrl: s.redactText(finalUrl) }),
        });
        const out: WorkflowFetchResult = {
          url: meta.finalUrl,
          status: meta.status,
          body: Buffer.from(bytes).toString("utf8"),
          fetchedAt: meta.fetchedAt,
          sha256: raw.sha256,
          finalUrl: meta.finalUrl,
          redirects: meta.redirects.map((r) => ({ ...r })),
          contentType: meta.contentType,
          headers: { ...meta.headers },
        };
        return out;
      });
    },
    async publishReport(req, key) {
      const policy = need("reports");
      if (typeof req.name !== "string" || req.name === "" || typeof req.content !== "string")
        throw new LifecycleError(400, "report needs a name and text content");
      const bytes = new TextEncoder().encode(req.content);
      // The declared size is bounded by the report ceiling at commit (normalizeCapabilities).
      if (bytes.byteLength > policy.maxBytes) throw new LifecycleError(400, "report exceeds its declared size");
      const sk = scopedKey(q, instance, "report", key);
      return effect(async (s) => {
        const report = await s.publishRoot({ name: req.name, content: bytes, ...(req.mediaType !== undefined && { mediaType: req.mediaType }), key: sk });
        // Root-owned audit provenance: workflow, instance, logical run and the task that produced it.
        await s.recordRoot(
          // `execution` is the task that ran this effect; `effectKey` is the handler-provided key (stable across repair).
          { kind: PROVENANCE_KIND, workflow: q, instance, execution: ctx.agent, effectKey: key, report: report.id } as ExtensionJournalPayload,
          `${sk}:provenance`,
        );
        return report;
      });
    },
    async sendToUser(body, key) {
      if (typeof body !== "string" || body === "") throw new LifecycleError(400, "message body is required");
      const sk = scopedKey(q, instance, "send", key);
      await effect((s) => s.sendToUser(body, sk));
    },
    async ask(question, key) {
      need("ask");
      const sk = scopedKey(q, instance, "ask", key);
      return effect(async (s) => ({ escalation: (await s.ask(ctx.agent, { question, generation: ctx.generation, idempotencyKey: sk })).escalation }));
    },
  };
}
