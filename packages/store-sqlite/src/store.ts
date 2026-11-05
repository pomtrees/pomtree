import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  applyDecision,
  budgetLedger,
  canonical,
  ledgerFits,
  POMTREED_KINDS,
  RootWithdrawalError,
  CHECKPOINT_FORMAT,
  checkpointOf,
  checkExecutorSpec,
  decodeGatewayCredential,
  newAgentExecutor,
  JOURNAL_PRUNABLE_KINDS,
  IllegalTransitionError,
  LEGAL_TRANSITIONS,
  isLevelKind,
  rankOfRung,
  rungsAbove,
  StaleGenerationError,
  validDebitMicros,
  validDebitRequestId,
  verifyGatewayCredential,
} from "@pomtree/core";
import { openVersionedDb } from "./db.ts";
import { CAPTURE_SCHEMA, sqliteCaptureIndex } from "./capture-index.ts";
import type { BackupPruneReport, Migration, Row } from "./db.ts";
import type {
  AgentId,
  AgentRecord,
  AgentState,
  Approval,
  ApprovalDecision,
  ApprovalJournalEntry,
  ApprovalRank,
  ApprovalRung,
  ApprovalState,
  ApprovalStore,
  Checkpoint,
  CheckpointStore,
  CredentialCheck,
  Delivered,
  AgentLedger,
  DurableModelDebitStore,
  LedgerNode,
  LedgerView,
  QuotaCounters,
  CaptureIndex,
  Escalation,
  EscalationId,
  EscalationState,
  EscalationStore,
  ExitCause,
  ExitStatus,
  GatewayCredential,
  HostId,
  HostRecord,
  HostState,
  HostStore,
  MergeRecord,
  MergeResult,
  MergeStatus,
  MergeStatusState,
  MergeStore,
  ModelDebitStore,
  NewHost,
  NewMergeRecord,
  NewReservation,
  RequestReservation,
  Reservation,
  ReserveResult,
  SettleResult,
  Journal,
  JournalEntry,
  Mailbox,
  MessagingSender,
  MissedPolicy,
  NewApproval,
  NewEscalation,
  NewJournalEntry,
  OverlapPolicy,
  Registry,
  Schedule,
  ScheduleStore,
  SessionStore,
  Signal,
  SignalId,
  Subscription,
  WatchdogRung,
  WatchdogState,
  WatchdogStore,
} from "@pomtree/core";

export interface WorkspaceCleanupStore {
  /** Records that the reaped agent's branch was pruned (its refs are gone). Idempotent; the report GC is still owed until markCleaned. */
  markPruned(agent: AgentId, at: number): void;
  /** Records that the report GC finished too: the agent is done. Idempotent. */
  markCleaned(agent: AgentId, at: number): void;
  /** Agents pruned whose report GC is still owed (pruned, not yet cleaned). */
  prunedAgents(): Set<AgentId>;
  /** Agents fully cleaned up. */
  cleanedAgents(): Set<AgentId>;
}

export interface Store {
  journal: Journal;
  registry: Registry;
  mailbox: Mailbox;
  checkpoints: CheckpointStore;
  escalations: EscalationStore;
  approvals: ApprovalStore;
  schedules: ScheduleStore;
  watchdogs: WatchdogStore;
  hosts: HostStore;
  merges: MergeStore;
  sessions: SessionStore;
  // Reaped agents whose workspace folder was cleaned up (remove/prune succeeded). Durable, so a sweep skips them after a restart.
  workspaceCleanup: WorkspaceCleanupStore;
  // Durable debit/revocation store behind the model proxy (see DurableModelDebitStore). `secret` is the
  // gateway's signing secret; `now` defaults to Date.now.
  modelDebit(options: { secret: string; now?: () => number }): SqliteModelDebitStore;
  /** Current generation of an agent, or undefined when unknown (the fence the separate state database cannot read itself). */
  generationOf(agent: AgentId): number | undefined;
  // The capture broker's durable jobs, positive and negative caches and domain pauses (core CaptureIndex).
  captures: CaptureIndex;
  // Durable fixed-window counters (core QuotaCounters) for quotas and pacing that must survive a restart.
  quotaCounters(): QuotaCounters;
  /** Deletes quota windows that started before `beforeMs`, and lifetime (window 0) counters last changed before
   * `lifetimeBeforeMs` (default `beforeMs`); returns how many went. The daemon's retention sweep calls it. */
  pruneQuotaCounters(beforeMs: number, lifetimeBeforeMs?: number): number;
  close(): void;
  /** Deletes idempotency rows older than `olderThanMs`, except the identity-bearing scopes (IDEMPOTENCY_KEPT_SCOPES). */
  pruneIdempotency(olderThanMs: number): number;
}

// The durable debit store with every optional ledger method implemented (hierarchical ledger, response-id join, touch).
export type SqliteModelDebitStore = DurableModelDebitStore & Required<Pick<DurableModelDebitStore, "ledgerFor" | "settledCall" | "touch">>;

// Idempotency scopes whose rows are never pruned: replaying one of these keys after the retention window must return the original
// result, never re-execute (a second agent for one spawn, a second budget raise for one grant, a second usage charge for one
// joined model call). Joined usage identities outlive journal pruning, like the debit ledger's per-request records.
const JOURNAL_USAGE_SCOPE = "journal.usage";
export const IDEMPOTENCY_KEPT_SCOPES = ["registry.create", "registry.raiseBudget", JOURNAL_USAGE_SCOPE] as const;

// SQLite `PRAGMA application_id` of a store database: big-endian ASCII "POMS". Stamped by the baseline; a database without it
// (a pre-release build) or with another id is refused (db.ts).
export const STORE_APPLICATION_ID = 0x504f4d53;

// Baseline schema (user_version 1): the full schema as created on every open (CREATE IF NOT EXISTS). Every post-release change
// is an ordered, forward-only entry in MIGRATIONS (version 2, 3, ...); security-relevant state is always a migration, never a
// baseline table.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, fingerprint TEXT, PRIMARY KEY (scope, key));
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, parent TEXT, name TEXT NOT NULL, task TEXT NOT NULL, state TEXT NOT NULL,
  exit TEXT, result TEXT, host TEXT NOT NULL, generation INTEGER NOT NULL, sandbox TEXT, budget_micros INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, seq INTEGER NOT NULL,
  spec TEXT NOT NULL DEFAULT '{}', exit_cause TEXT,
  executor TEXT NOT NULL DEFAULT 'container' CHECK (executor IN ('container','deterministic'))
);
CREATE INDEX IF NOT EXISTS agents_parent ON agents(parent);
CREATE TABLE IF NOT EXISTS journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL, host TEXT NOT NULL,
  generation INTEGER NOT NULL, traceparent TEXT, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS journal_agent ON journal(agent, seq);
CREATE TABLE IF NOT EXISTS journal_spend (
  agent TEXT PRIMARY KEY, cost_micros INTEGER NOT NULL, unpriced_in INTEGER NOT NULL, unpriced_out INTEGER NOT NULL, events INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mailbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, signal TEXT NOT NULL, key TEXT, kind TEXT
);
CREATE INDEX IF NOT EXISTS mailbox_agent ON mailbox(agent, id);
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, agent TEXT NOT NULL, body TEXT NOT NULL,
  env_manifest_hash TEXT, host TEXT, template TEXT NOT NULL DEFAULT 'code', template_digest TEXT,
  resume_level TEXT NOT NULL DEFAULT 'session'
);
CREATE INDEX IF NOT EXISTS checkpoints_agent ON checkpoints(agent, seq);
CREATE TABLE IF NOT EXISTS sessions (
  ref TEXT PRIMARY KEY, body BLOB
);
CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, host TEXT NOT NULL, generation INTEGER NOT NULL,
  question TEXT NOT NULL, options TEXT NOT NULL, state TEXT NOT NULL, answer TEXT,
  answered_by TEXT, created_at INTEGER NOT NULL, answered_at INTEGER, holder TEXT, hop_deadline_at INTEGER
);
CREATE INDEX IF NOT EXISTS escalations_agent ON escalations(agent, state);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, requester_id TEXT NOT NULL, requester_rank TEXT NOT NULL,
  requester_generation INTEGER, action_kind TEXT NOT NULL, action_target TEXT NOT NULL,
  rungs TEXT NOT NULL, rung_index INTEGER NOT NULL, state TEXT NOT NULL, host TEXT NOT NULL,
  journal TEXT NOT NULL, deadline_at INTEGER NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER, rung_ms INTEGER, rung_windows TEXT, notified_at INTEGER
);
CREATE INDEX IF NOT EXISTS approvals_requester ON approvals(requester_id, state);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, cron TEXT NOT NULL, tz TEXT, task TEXT NOT NULL, missed TEXT NOT NULL,
  overlap TEXT NOT NULL, jitter_ms INTEGER NOT NULL, created_at INTEGER NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, retry_at INTEGER,
  agent TEXT, created_by TEXT, orphaned INTEGER NOT NULL DEFAULT 0, budget_micros INTEGER, deadline_ms INTEGER,
  template TEXT, model_provider TEXT, model_id TEXT
);
CREATE TABLE IF NOT EXISTS schedule_last_fired (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS watchdog_state (
  agent TEXT PRIMARY KEY, rung TEXT NOT NULL, last_action_at INTEGER, retries INTEGER NOT NULL,
  restarts TEXT, quarantined INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY, labels TEXT NOT NULL, capacity TEXT NOT NULL, images TEXT NOT NULL, state TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL UNIQUE, host TEXT, state TEXT NOT NULL,
  priority INTEGER NOT NULL, resources TEXT NOT NULL, template TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reservations_order ON reservations(priority, seq);
CREATE TABLE IF NOT EXISTS merges (
  id TEXT PRIMARY KEY, idem_key TEXT NOT NULL UNIQUE, repo TEXT NOT NULL, host TEXT NOT NULL, generation INTEGER NOT NULL,
  caller TEXT NOT NULL, child TEXT NOT NULL, request TEXT NOT NULL, phase TEXT NOT NULL, attempts INTEGER NOT NULL,
  base TEXT, source TEXT, candidate TEXT, started_at INTEGER NOT NULL, result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS merges_tips ON merges(repo, caller, child, base, source);
CREATE INDEX IF NOT EXISTS merges_open ON merges(phase);
CREATE TABLE IF NOT EXISTS merge_status (
  repo TEXT NOT NULL, child TEXT NOT NULL, state TEXT NOT NULL, failed_rounds INTEGER NOT NULL, last_merge TEXT,
  host TEXT, generation INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (repo, child)
);
CREATE TABLE IF NOT EXISTS model_debit_agents (
  agent TEXT PRIMARY KEY, budget_micros INTEGER NOT NULL, spent_micros INTEGER NOT NULL, reserved_micros INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS model_debit_requests (
  agent TEXT NOT NULL, request_id TEXT NOT NULL, credential_id TEXT NOT NULL, maximum_micros INTEGER NOT NULL,
  status TEXT NOT NULL, charged_micros INTEGER, created_at INTEGER NOT NULL DEFAULT 0,
  model TEXT, tokens_in INTEGER, tokens_out INTEGER, settled_at INTEGER, upstream_status INTEGER, latency_ms INTEGER,
  finish_reason TEXT, cache_read_tokens INTEGER, cache_write_tokens INTEGER, route TEXT, error_class TEXT, response_id TEXT, basis TEXT,
  touched_at INTEGER, PRIMARY KEY (agent, request_id)
);
-- Call metadata only, never bodies. route, error_class and basis hold ModelCallMeta's closed classes as plain TEXT with no CHECK, so
-- a later class needs no schema change; the classes are closed in core's types. The response id lets a harness usage event find
-- its settled call (exact, indexed).
CREATE INDEX IF NOT EXISTS model_debit_requests_response ON model_debit_requests(agent, response_id);
CREATE TABLE IF NOT EXISTS model_debit_revocations (
  agent TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL
);
-- The credential issuance high-water that issue persists and revoke covers.
CREATE TABLE IF NOT EXISTS model_debit_issuance (agent TEXT PRIMARY KEY, issued_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_cleanup (agent TEXT PRIMARY KEY, pruned_at INTEGER, cleaned_at INTEGER);
-- Durable fixed-window quota counters (QuotaCounters).
CREATE TABLE IF NOT EXISTS quota_counters (scope TEXT NOT NULL, key TEXT NOT NULL, window_start INTEGER NOT NULL, used INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (scope, key, window_start));
-- The successful takes recorded under an opId (QuotaCounters.take), so a replayed
-- take returns its first result and adds nothing, across a restart. Pruned with the counter it charged.
CREATE TABLE IF NOT EXISTS quota_ops (scope TEXT NOT NULL, key TEXT NOT NULL, window_start INTEGER NOT NULL, op_id TEXT NOT NULL, used INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (scope, key, window_start, op_id));
-- The provider retry ladder's durable count per agent (Registry.bumpProviderAttempts).
CREATE TABLE IF NOT EXISTS provider_attempts (agent TEXT PRIMARY KEY, attempts INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`;

export type { Migration };

// Ordered forward-only migrations beyond the v1 baseline; none yet. Each runs in its own transaction and bumps user_version atomically.
const MIGRATIONS: Migration[] = [];

// The version a binary built from this source opens and writes: the baseline plus every built-in migration.
export const SCHEMA_VERSION = 1 + MIGRATIONS.length;

export interface OpenOptions {
  /** Extra migrations appended after the built-in ones (tests only). */
  migrations?: Migration[];
  busyTimeoutMs?: number;
  subscribePollMs?: number; // fallback poll for journal subscribers (cross-process writers); default 250
  /** Backup-retention outcome after an open that migrated (db.ts BackupPruneReport); absent = errors become a process warning. */
  onBackupPrune?(report: BackupPruneReport): void;
}

export function openStore(path: string = ":memory:", opts: OpenOptions = {}): Store {
  const {
    db,
    onDisk,
    tx,
    once,
    pruneIdempotency: pruneIdempotencyRows,
  } = openVersionedDb({
    path,
    label: "store",
    applicationId: STORE_APPLICATION_ID,
    migrations: [...MIGRATIONS, ...(opts.migrations ?? [])],
    busyTimeoutMs: opts.busyTimeoutMs,
    onBackupPrune: opts.onBackupPrune,
    baseline(db) {
      db.exec(SCHEMA);
      db.exec(CAPTURE_SCHEMA);
    },
  });
  const pollMs = Math.max(10, Math.trunc(opts.subscribePollMs ?? 250));
  // The request fingerprint once() stores beside a key (idem-fingerprint): sha256 of the canonical JSON (keys sorted) of the
  // request, so a replay of the same request matches whatever order its fields were built in.
  const fingerprintOf = (...parts: unknown[]): string =>
    createHash("sha256")
      .update(JSON.stringify(canonical(parts)))
      .digest("hex");

  const agentOf = (r: Row): AgentRecord => {
    // Fails closed on an unknown executor or a spec that does not match it (the CHECK already limits the column).
    const { executor, spec } = checkExecutorSpec(r.executor, JSON.parse(r.spec));
    return {
      id: r.id,
      parent: r.parent,
      name: r.name,
      task: r.task,
      state: r.state,
      exit: r.exit,
      ...(r.exit_cause != null ? { exitCause: r.exit_cause as ExitCause } : {}),
      result: r.result == null ? null : JSON.parse(r.result),
      host: r.host,
      generation: r.generation,
      sandbox: r.sandbox ?? null,
      budgetMicros: r.budget_micros,
      executor,
      spec,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    } as AgentRecord;
  };
  const getAgent = (id: string): AgentRecord | null => {
    const r = db.prepare("SELECT * FROM agents WHERE id=?").get(id) as Row | undefined;
    return r ? agentOf(r) : null;
  };
  const mustAgent = (id: string): AgentRecord => {
    const a = getAgent(id);
    if (!a) throw new Error(`unknown agent ${id}`);
    return a;
  };

  const entryOf = (r: Row): JournalEntry => ({
    seq: r.seq,
    ts: r.ts,
    agent: r.agent,
    host: r.host,
    generation: r.generation,
    ...(r.traceparent ? { traceparent: r.traceparent } : {}),
    payload: JSON.parse(r.payload),
  });

  const listeners = new Set<() => void>();
  const subs = new Set<Subscription>();
  const notify = () =>
    listeners.forEach((l) => {
      l();
    });

  const readJournal = (o: { from?: number; agent?: string; limit?: number }): JournalEntry[] => {
    const rows = db
      .prepare("SELECT * FROM journal WHERE seq >= ? AND (? IS NULL OR agent = ?) ORDER BY seq LIMIT ?")
      .all(o.from ?? 0, o.agent ?? null, o.agent ?? null, o.limit ?? -1) as Row[];
    return rows.map(entryOf);
  };

  // The journal row write, run inside the caller's transaction: by `journal.append` under its key, and by a registry write
  // that must journal atomically with its own change (setRootPool).
  const insertJournal = (e: NewJournalEntry): JournalEntry => {
    const a = mustAgent(e.agent);
    if (a.generation !== e.generation) throw new StaleGenerationError(e.agent, e.generation, a.generation);
    const p = e.payload;
    const usageKey = p.kind === "usage" && p.requestId !== undefined ? JSON.stringify([e.agent, p.requestId]) : undefined;
    if (usageKey !== undefined) {
      const prior = db.prepare("SELECT result FROM idempotency WHERE scope=? AND key=?").get(JOURNAL_USAGE_SCOPE, usageKey) as Row | undefined;
      if (prior) return JSON.parse(prior.result) as JournalEntry;
    }
    const res = db
      .prepare("INSERT INTO journal (ts,agent,host,generation,traceparent,payload) VALUES (?,?,?,?,?,?)")
      .run(Date.now(), e.agent, e.host, e.generation, e.traceparent ?? null, JSON.stringify(e.payload));
    if (p.kind === "usage") {
      // A null cost (the harness reported none) is unpriced like a zero cost with tokens: the fallback rate table prices it.
      const unpriced = (p.costMicros === null || p.costMicros === 0) && (p.inputTokens > 0 || p.outputTokens > 0);
      db.prepare(
        "INSERT INTO journal_spend (agent,cost_micros,unpriced_in,unpriced_out,events) VALUES (?,?,?,?,1) ON CONFLICT(agent) DO UPDATE SET cost_micros=cost_micros+excluded.cost_micros, unpriced_in=unpriced_in+excluded.unpriced_in, unpriced_out=unpriced_out+excluded.unpriced_out, events=events+1",
      ).run(e.agent, unpriced ? 0 : (p.costMicros ?? 0), unpriced ? p.inputTokens : 0, unpriced ? p.outputTokens : 0);
    }
    const entry = entryOf(db.prepare("SELECT * FROM journal WHERE seq=?").get(res.lastInsertRowid) as Row);
    if (usageKey !== undefined)
      db.prepare("INSERT INTO idempotency (scope,key,result,created_at) VALUES (?,?,?,?)").run(
        JOURNAL_USAGE_SCOPE,
        usageKey,
        JSON.stringify(entry),
        Date.now(),
      );
    return entry;
  };

  // TODO(ledger-audit): add a startup and doctor replay of settled totals. Current behavior: neither startup nor pomtree doctor
  // checks them. Only the seeded test in budget-nest.test.ts asserts the conservation identity; a replay mismatch should
  // block reservations.
  // The hierarchical ledger (core budget-ledger.ts) over the registry and the debit buckets, read inside the caller's transaction.
  // A registered agent's budget is its registry carve (the root's is the operator pool); a bucket the registry does not know
  // (library use) is its own root with the cap setBudget gave it. Own use is settled spend plus in-flight reservations.
  // TODO(budget-nest): a full scan of agents and buckets per call; fine for a single-node tree of thousands of agents, an
  // incrementally maintained per-node aggregate (like cgroups) is the next step if reserve latency shows up.
  const ledgerView = (): LedgerView => {
    const buckets = new Map<string, Row>();
    for (const b of db.prepare("SELECT agent, budget_micros, spent_micros, reserved_micros FROM model_debit_agents").all() as Row[]) buckets.set(b.agent, b);
    const nodes: LedgerNode[] = [];
    for (const a of db.prepare("SELECT id, parent, state, budget_micros FROM agents").all() as Row[]) {
      const b = buckets.get(a.id);
      buckets.delete(a.id);
      nodes.push({
        id: a.id,
        parent: a.parent ?? null,
        budgetMicros: a.budget_micros,
        live: a.state !== "reaped",
        usedMicros: b ? b.spent_micros + b.reserved_micros : 0,
      });
    }
    for (const b of buckets.values())
      nodes.push({ id: b.agent, parent: null, budgetMicros: b.budget_micros, live: true, usedMicros: b.spent_micros + b.reserved_micros });
    return budgetLedger(nodes);
  };

  const journal: Journal = {
    async append(e: NewJournalEntry) {
      const r = once("journal", e.idempotencyKey, () => insertJournal(e));
      notify();
      return r;
    },
    async read(o) {
      return readJournal(o);
    },
    async spendFor(agent) {
      const r = db.prepare("SELECT * FROM journal_spend WHERE agent=?").get(agent) as Row | undefined;
      return {
        costMicros: r?.cost_micros ?? 0,
        unpricedInputTokens: r?.unpriced_in ?? 0,
        unpricedOutputTokens: r?.unpriced_out ?? 0,
        events: r?.events ?? 0,
      };
    },
    async pruneJournal(o) {
      const protect = new Set(o.protectKinds ?? []);
      const kinds = (o.kinds ?? [...JOURNAL_PRUNABLE_KINDS]).filter((k) => !protect.has(k));
      if (kinds.length === 0) return { deleted: 0 };
      const cutoff = Date.now() - Math.max(0, o.olderThanMs);
      const keep = Math.max(0, Math.floor(o.keepPerAgent));
      const marks = kinds.map(() => "?").join(",");
      const res = db
        .prepare(
          `DELETE FROM journal WHERE ts < ? AND json_extract(payload,'$.kind') IN (${marks})
         AND seq NOT IN (SELECT seq FROM (SELECT seq, ROW_NUMBER() OVER (PARTITION BY agent ORDER BY seq DESC) AS rn FROM journal) WHERE rn <= ?)
         AND ts < COALESCE((SELECT MAX(json_extract(body,'$.createdAt')) FROM checkpoints c WHERE c.agent = journal.agent), 9223372036854775807)`,
        )
        .run(cutoff, ...kinds, keep);
      return { deleted: Number(res.changes) };
    },
    subscribe(o) {
      let next = o.from ?? 0;
      let closed = false;
      let wake: (() => void) | null = null;
      const poke = () => {
        wake?.();
        wake = null;
      };
      listeners.add(poke);
      const sub: Subscription = {
        close() {
          closed = true;
          listeners.delete(poke);
          subs.delete(sub);
          poke();
        },
        async *[Symbol.asyncIterator]() {
          try {
            while (!closed) {
              const batch = readJournal({ from: next, agent: o.agent, limit: 100 });
              if (batch.length) {
                for (const e of batch) {
                  if (closed) return;
                  next = e.seq + 1;
                  yield e;
                }
                continue;
              }
              // The timer is a fallback for writes from another process/connection, which never call
              // this process's notify().
              await new Promise<void>((res) => {
                const timer = setTimeout(() => poke(), pollMs);
                timer.unref();
                wake = () => {
                  clearTimeout(timer);
                  res();
                };
                // re-check after registering to avoid a lost wakeup
                if (closed || readJournal({ from: next, agent: o.agent, limit: 1 }).length) poke();
              });
            }
          } finally {
            sub.close();
          }
        },
      };
      subs.add(sub);
      return sub;
    },
  };

  const registry: Registry = {
    async create(a) {
      const { idempotencyKey: _key, ...request } = a;
      return once(
        "registry.create",
        a.idempotencyKey,
        () => {
          // A caller-chosen id is an identity, not a fresh row: creating it again (after its key was pruned, or under another key)
          // returns the existing agent when the parent and host match, and refuses otherwise.
          const existing = a.id !== undefined ? getAgent(a.id) : null;
          if (existing) {
            if (existing.parent !== a.parent || existing.host !== a.host)
              throw new Error(`agent id ${a.id} already exists with parent ${existing.parent ?? "none"} on host ${existing.host}`);
            return existing;
          }
          const id = a.id ?? randomUUID();
          const now = Date.now();
          const { executor, spec } = newAgentExecutor(a);
          db.prepare(
            "INSERT INTO agents (id,parent,name,task,state,exit,exit_cause,result,host,generation,sandbox,budget_micros,spec,created_at,updated_at,seq,executor) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          ).run(id, a.parent, a.name, a.task, "pending", null, null, null, a.host, 0, null, a.budgetMicros, JSON.stringify(spec), now, now, 0, executor);
          return mustAgent(id);
        },
        fingerprintOf(request),
      );
    },
    async get(id) {
      return getAgent(id);
    },
    async list(o = {}) {
      const rows = db
        .prepare("SELECT * FROM agents WHERE (? IS NULL OR parent=?) AND (? IS NULL OR state=?) AND (? IS NULL OR state<>?) ORDER BY created_at, rowid")
        .all(o.parent ?? null, o.parent ?? null, o.state ?? null, o.state ?? null, o.excludeState ?? null, o.excludeState ?? null) as Row[];
      return rows.map(agentOf);
    },
    async transition(id, generation, to, o) {
      return once("registry.transition", o.idempotencyKey, () => {
        const a = mustAgent(id);
        if (a.generation !== generation) throw new StaleGenerationError(id, generation, a.generation);
        const resume = o.resume === true && a.state === "exited" && to === "running";
        if (!resume && !LEGAL_TRANSITIONS[a.state].includes(to)) throw new IllegalTransitionError(id, a.state, to);
        db.prepare("UPDATE agents SET state=?, exit=?, exit_cause=?, result=?, updated_at=? WHERE id=?").run(
          to,
          resume ? null : (o.exit ?? a.exit),
          to === "exited" ? (o.exitCause ?? null) : to === "reaped" ? (a.exitCause ?? null) : null,
          resume ? null : o.result === undefined ? (a.result == null ? null : JSON.stringify(a.result)) : JSON.stringify(o.result),
          Date.now(),
          id,
        );
        return mustAgent(id);
      });
    },
    async bumpGeneration(id, host, idempotencyKey) {
      return once("registry.bumpGeneration", idempotencyKey, () => {
        mustAgent(id);
        db.prepare("UPDATE agents SET generation=generation+1, host=?, exit_cause=NULL, updated_at=? WHERE id=?").run(host, Date.now(), id);
        return mustAgent(id);
      });
    },
    async setSandbox(id, generation, sandbox, idempotencyKey) {
      return once("registry.setSandbox", idempotencyKey, () => {
        const a = mustAgent(id);
        if (a.generation !== generation) throw new StaleGenerationError(id, generation, a.generation);
        db.prepare("UPDATE agents SET sandbox=?, updated_at=? WHERE id=?").run(sandbox, Date.now(), id);
        return mustAgent(id);
      });
    },
    async raiseBudget(id, deltaMicros, idempotencyKey) {
      if (!Number.isSafeInteger(deltaMicros) || deltaMicros <= 0) throw new Error("budget raise micros must be a positive safe integer");
      return once(
        "registry.raiseBudget",
        idempotencyKey,
        () => {
          mustAgent(id);
          db.prepare("UPDATE agents SET budget_micros=budget_micros+?, updated_at=? WHERE id=?").run(deltaMicros, Date.now(), id);
          return mustAgent(id);
        },
        fingerprintOf(id, deltaMicros),
      );
    },
    async setRootPool(id, toMicros, idempotencyKey) {
      if (!Number.isSafeInteger(toMicros) || toMicros < 0) throw new Error("root pool micros must be a non-negative safe integer");
      const out = tx(() => {
        const root = mustAgent(id);
        if (root.parent !== null) throw new Error(`agent ${id} is not a root; only a root's pool is set by the operator`);
        const from = root.budgetMicros;
        if (toMicros === from) return { record: root, entry: null };
        if (toMicros < from) {
          // At most the unheld remainder: the ledger's remaining of the root (its pool minus what its children hold and its own
          // settled and in-flight use), read in this same transaction so no carve or reservation can slip in between.
          const available = Math.max(0, ledgerView().remaining(id));
          if (from - toMicros > available) throw new RootWithdrawalError(id, from, toMicros, from - available);
        }
        db.prepare("UPDATE agents SET budget_micros=?, updated_at=? WHERE id=?").run(toMicros, Date.now(), id);
        const record = mustAgent(id);
        const kind = toMicros > from ? POMTREED_KINDS.budgetTopUp : POMTREED_KINDS.budgetWithdrawal;
        const entry = insertJournal({
          agent: id,
          host: record.host,
          generation: record.generation,
          payload: { kind, from, to: toMicros, by: "operator" },
          idempotencyKey,
        });
        return { record, entry };
      });
      if (out.entry) notify();
      return out;
    },
    async bumpProviderAttempts(id, idempotencyKey) {
      return once("registry.providerAttempts", idempotencyKey, () => {
        mustAgent(id);
        db.prepare(
          "INSERT INTO provider_attempts (agent,attempts,updated_at) VALUES (?,1,?) ON CONFLICT(agent) DO UPDATE SET attempts=attempts+1, updated_at=excluded.updated_at",
        ).run(id, Date.now());
        return (db.prepare("SELECT attempts FROM provider_attempts WHERE agent=?").get(id) as Row).attempts as number;
      });
    },
    async resetProviderAttempts(id) {
      tx(() => {
        mustAgent(id);
        db.prepare("DELETE FROM provider_attempts WHERE agent=?").run(id);
      });
    },
  };

  const deliveredOf = (r: Row): Delivered => ({ ...(JSON.parse(r.signal) as Signal), id: r.key as SignalId });

  const mailbox: Mailbox = {
    // A repeated key replays first, before the target and fence checks, so a retry after the target was
    // reaped or the sender's generation moved still returns the original. The target must exist and not
    // be reaped (a signal to a dead agent must not pile up in its mailbox). An agent-originated message
    // (senderGeneration given) also needs a registry row and is fenced against the sender's current
    // generation; daemon-originated signals skip the sender check.
    async send(to, signal, key, senderGeneration) {
      once(
        "mailbox",
        key,
        () => {
          const target = mustAgent(to);
          if (target.state === "reaped") throw new Error(`cannot signal reaped agent ${to}`);
          if (senderGeneration !== undefined && signal.kind === "message") {
            const sender = mustAgent(signal.from);
            if (sender.generation !== senderGeneration) throw new StaleGenerationError(signal.from, senderGeneration, sender.generation);
          }
          // A level kind supersedes the agent's unconsumed signal of that kind (latest wins, the survivor carries this key).
          if (isLevelKind(signal.kind)) db.prepare("DELETE FROM mailbox WHERE agent=? AND kind=?").run(to, signal.kind);
          db.prepare("INSERT INTO mailbox (agent,signal,key,kind) VALUES (?,?,?,?)").run(to, JSON.stringify(signal), key, signal.kind);
          return null;
        },
        fingerprintOf(to, signal),
      );
    },
    async receive(agent, idempotencyKey, o = {}) {
      return once("mailbox.receive", idempotencyKey, () => {
        const rows = db
          .prepare("SELECT id, signal, key FROM mailbox WHERE agent=? ORDER BY (json_extract(signal,'$.interrupt') IS NOT 1), id LIMIT ?")
          .all(agent, o.limit ?? -1) as Row[];
        const del = db.prepare("DELETE FROM mailbox WHERE id=?");
        for (const r of rows) del.run(r.id);
        return rows.map(deliveredOf);
      });
    },
    async peek(agent) {
      const rows = db.prepare("SELECT signal, key FROM mailbox WHERE agent=? ORDER BY (json_extract(signal,'$.interrupt') IS NOT 1), id").all(agent) as Row[];
      return rows.map(deliveredOf);
    },
    async ack(agent, ids, idempotencyKey) {
      return once("mailbox.ack", idempotencyKey, () => {
        const del = db.prepare("DELETE FROM mailbox WHERE agent=? AND key=?");
        return ids.filter((id) => Number(del.run(agent, id).changes) > 0);
      });
    },
  };

  const checkpoints: CheckpointStore = {
    async write(c, key) {
      return once("checkpoint", key, () => {
        const a = mustAgent(c.agent);
        if (a.generation !== c.generation) throw new StaleGenerationError(c.agent, c.generation, a.generation);
        const full: Checkpoint = { ...c, version: CHECKPOINT_FORMAT, id: randomUUID(), createdAt: Date.now() };
        const seq = (db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM checkpoints").get() as Row).n;
        db.prepare("INSERT INTO checkpoints (id,seq,agent,body,env_manifest_hash,host,template,template_digest,resume_level) VALUES (?,?,?,?,?,?,?,?,?)").run(
          full.id,
          seq,
          c.agent,
          JSON.stringify(full),
          c.envManifestHash ?? null,
          c.host,
          c.template,
          c.templateDigest,
          c.resumeLevel,
        );
        return full;
      });
    },
    async latest(agent) {
      const r = db.prepare("SELECT body FROM checkpoints WHERE agent=? ORDER BY seq DESC LIMIT 1").get(agent) as Row | undefined;
      return r ? checkpointOf(JSON.parse(r.body)) : null;
    },
    async read(id) {
      const r = db.prepare("SELECT body FROM checkpoints WHERE id=?").get(id) as Row | undefined;
      return r ? checkpointOf(JSON.parse(r.body)) : null;
    },
  };

  const escalationOf = (r: Row): Escalation => ({
    id: r.id,
    agent: r.agent,
    host: r.host,
    generation: r.generation,
    question: r.question,
    options: JSON.parse(r.options) as string[],
    state: r.state as EscalationState,
    answer: r.answer ?? null,
    answeredBy: r.answered_by == null ? null : (JSON.parse(r.answered_by) as MessagingSender),
    createdAt: r.created_at,
    answeredAt: r.answered_at ?? null,
    holder: r.holder ?? null,
    ...(r.hop_deadline_at != null ? { hopDeadlineAt: r.hop_deadline_at } : {}),
  });

  const escalations: EscalationStore = {
    async create(e, key) {
      return once("escalation", key, () => {
        const existing = db.prepare("SELECT * FROM escalations WHERE id=?").get(e.id) as Row | undefined;
        if (existing) return escalationOf(existing);
        const a = mustAgent(e.agent);
        if (a.generation !== e.generation) throw new StaleGenerationError(e.agent, e.generation, a.generation);
        db.prepare(
          "INSERT INTO escalations (id,agent,host,generation,question,options,state,answer,answered_by,created_at,answered_at,holder,hop_deadline_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          e.id,
          e.agent,
          e.host,
          e.generation,
          e.question,
          JSON.stringify(e.options),
          "open",
          null,
          null,
          Date.now(),
          null,
          e.holder ?? null,
          e.hopDeadlineAt ?? null,
        );
        return escalationOf(db.prepare("SELECT * FROM escalations WHERE id=?").get(e.id) as Row);
      });
    },
    async get(id) {
      const r = db.prepare("SELECT * FROM escalations WHERE id=?").get(id) as Row | undefined;
      return r ? escalationOf(r) : null;
    },
    async list(o = {}) {
      const rows = db
        .prepare("SELECT * FROM escalations WHERE (? IS NULL OR agent=?) AND (? IS NULL OR state=?) ORDER BY created_at, rowid")
        .all(o.agent ?? null, o.agent ?? null, o.state ?? null, o.state ?? null) as Row[];
      return rows.map(escalationOf);
    },
    async answer(id, answer, by, key) {
      return once(
        "escalation.answer",
        key,
        () => {
          const r = db.prepare("SELECT * FROM escalations WHERE id=?").get(id) as Row | undefined;
          if (!r) throw new Error(`unknown escalation ${id}`);
          const cur = escalationOf(r);
          if (cur.state !== "open") return cur; // first answer wins
          db.prepare("UPDATE escalations SET state='answered', answer=?, answered_by=?, answered_at=? WHERE id=?").run(
            answer,
            JSON.stringify(by),
            Date.now(),
            id,
          );
          return escalationOf(db.prepare("SELECT * FROM escalations WHERE id=?").get(id) as Row);
        },
        fingerprintOf(id, answer, by),
      );
    },
    async advance(id, holder, hopDeadlineAt, key) {
      return once("escalation.advance", key, () => {
        const r = db.prepare("SELECT * FROM escalations WHERE id=?").get(id) as Row | undefined;
        if (!r) throw new Error(`unknown escalation ${id}`);
        if (r.state !== "open") return escalationOf(r);
        db.prepare("UPDATE escalations SET holder=?, hop_deadline_at=? WHERE id=?").run(holder, hopDeadlineAt ?? null, id);
        return escalationOf(db.prepare("SELECT * FROM escalations WHERE id=?").get(id) as Row);
      });
    },
  };

  const approvalOf = (r: Row): Approval => ({
    id: r.id,
    requester: {
      id: r.requester_id,
      rank: r.requester_rank as ApprovalRank,
      ...(r.requester_generation != null ? { generation: r.requester_generation } : {}),
    },
    action: { kind: r.action_kind, target: r.action_target },
    rungs: JSON.parse(r.rungs) as ApprovalRung[],
    rungIndex: r.rung_index,
    state: r.state as ApprovalState,
    host: r.host,
    journal: JSON.parse(r.journal) as ApprovalJournalEntry[],
    deadlineAt: r.deadline_at,
    ...(r.rung_ms != null ? { rungMs: r.rung_ms } : {}),
    ...(r.rung_windows != null ? { rungWindowsMs: JSON.parse(r.rung_windows) as number[] } : {}),
    createdAt: r.created_at,
    decidedAt: r.decided_at ?? null,
    ...(r.notified_at != null ? { notifiedAt: r.notified_at } : {}),
  });

  // Settle a pending record that has no rung left to await (an owner requester's empty ladder):
  // deny, fail closed.
  const failClosed = (cur: Approval): Approval => {
    db.prepare("UPDATE approvals SET state='denied', rung_index=?, decided_at=? WHERE id=?").run(cur.rungs.length, Date.now(), cur.id);
    return approvalOf(db.prepare("SELECT * FROM approvals WHERE id=?").get(cur.id) as Row);
  };

  // Apply one decision (approver or timeout) at the current rung and persist it. Deny is
  // final; abstain/escalate/timeout advance a rung; past the top rung denies (fail closed).
  const applyApprovalDecision = (
    id: string,
    decision: ApprovalDecision,
    who: string | null,
    rank: ApprovalRank,
    why: string,
    grantMicros?: number,
  ): Approval => {
    const r = db.prepare("SELECT * FROM approvals WHERE id=?").get(id) as Row | undefined;
    if (!r) throw new Error(`unknown approval ${id}`);
    const cur = approvalOf(r);
    if (cur.state !== "pending") return cur; // settled: replay
    if (cur.rungIndex >= cur.rungs.length) return failClosed(cur); // no rung left to decide: deny
    const rung = cur.rungs[cur.rungIndex]!;
    const res = applyDecision(cur.requester.rank, rank, cur.rungs, cur.rungIndex, decision);
    if (!res.ok) throw new Error(res.reason);
    const journal = [...cur.journal, { rung, rank, who, decision, why, ...(grantMicros !== undefined ? { grantMicros } : {}), at: Date.now() }];
    const state = res.outcome.state;
    const rungIndex = state === "pending" ? cur.rungIndex + 1 : res.outcome.failClosed ? cur.rungs.length : cur.rungIndex;
    const decidedAt = state === "pending" ? null : Date.now();
    // Re-base the deadline on the next rung so a restarting timeout driver can reconstruct it.
    const window = cur.rungWindowsMs?.[rungIndex] ?? cur.rungMs;
    const deadlineAt = state === "pending" && window != null ? Date.now() + window : cur.deadlineAt;
    db.prepare("UPDATE approvals SET rung_index=?, state=?, journal=?, decided_at=?, deadline_at=? WHERE id=?").run(
      rungIndex,
      state,
      JSON.stringify(journal),
      decidedAt,
      deadlineAt,
      id,
    );
    return approvalOf(db.prepare("SELECT * FROM approvals WHERE id=?").get(id) as Row);
  };

  const approvals: ApprovalStore = {
    async create(a, key) {
      return once("approval", key, () => {
        const existing = db.prepare("SELECT * FROM approvals WHERE id=?").get(a.id) as Row | undefined;
        if (existing) return approvalOf(existing);
        if (a.requester.generation !== undefined) {
          const req = mustAgent(a.requester.id);
          if (req.generation !== a.requester.generation) throw new StaleGenerationError(a.requester.id, a.requester.generation, req.generation);
        }
        const now = Date.now();
        const rungs = a.rungs ?? rungsAbove(a.requester.rank);
        // An owner requester has no approver above it: deny at create (fail closed) rather than
        // leave a record that can never settle.
        const empty = rungs.length === 0;
        db.prepare(
          "INSERT INTO approvals (id,requester_id,requester_rank,requester_generation,action_kind,action_target,rungs,rung_index,state,host,journal,deadline_at,rung_ms,rung_windows,created_at,decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          a.id,
          a.requester.id,
          a.requester.rank,
          a.requester.generation ?? null,
          a.action.kind,
          a.action.target,
          JSON.stringify(rungs),
          0,
          empty ? "denied" : "pending",
          a.host,
          "[]",
          a.deadlineAt,
          Math.max(0, a.deadlineAt - now),
          a.rungWindowsMs ? JSON.stringify(a.rungWindowsMs) : null,
          now,
          empty ? now : null,
        );
        return approvalOf(db.prepare("SELECT * FROM approvals WHERE id=?").get(a.id) as Row);
      });
    },
    async get(id) {
      const r = db.prepare("SELECT * FROM approvals WHERE id=?").get(id) as Row | undefined;
      return r ? approvalOf(r) : null;
    },
    async list(o = {}) {
      const rows = db
        .prepare(
          "SELECT * FROM approvals WHERE (? IS NULL OR requester_id=?) AND (? IS NULL OR state=?) AND (? IS NULL OR (state != 'pending' AND notified_at IS NULL)) ORDER BY created_at, rowid",
        )
        .all(o.requester ?? null, o.requester ?? null, o.state ?? null, o.state ?? null, o.unnotified ? 1 : null) as Row[];
      return rows.map(approvalOf);
    },
    async decide(id, d, key) {
      return once("approval.decide", key, () => applyApprovalDecision(id, d.decision, d.who, d.rank, d.why, d.grantMicros), fingerprintOf(id, d));
    },
    async markNotified(id, key) {
      return once("approval.notified", key, () => {
        const r = db.prepare("SELECT * FROM approvals WHERE id=?").get(id) as Row | undefined;
        if (!r) throw new Error(`unknown approval ${id}`);
        if (r.state === "pending") throw new Error(`approval ${id} is pending: no decision to mark delivered`);
        db.prepare("UPDATE approvals SET notified_at=COALESCE(notified_at, ?) WHERE id=?").run(Date.now(), id);
        return approvalOf(db.prepare("SELECT * FROM approvals WHERE id=?").get(id) as Row);
      });
    },
    async timeout(id, key) {
      return once("approval.timeout", key, () => {
        const r = db.prepare("SELECT * FROM approvals WHERE id=?").get(id) as Row | undefined;
        if (!r) throw new Error(`unknown approval ${id}`);
        const cur = approvalOf(r);
        if (cur.state !== "pending") return cur;
        if (cur.rungIndex >= cur.rungs.length) return failClosed(cur);
        return applyApprovalDecision(id, "timeout", null, rankOfRung(cur.rungs[cur.rungIndex]!), "rung deadline passed");
      });
    },
  };

  const scheduleOf = (r: Row): Schedule => ({
    id: r.id,
    cron: r.cron,
    ...(r.tz ? { tz: r.tz } : {}),
    task: r.task,
    missed: r.missed as MissedPolicy,
    overlap: r.overlap as OverlapPolicy,
    jitterMs: r.jitter_ms,
    ...(r.paused ? { paused: true } : {}),
    ...(r.failures ? { failures: r.failures } : {}),
    ...(r.retry_at != null ? { retryAt: r.retry_at } : {}),
    ...(r.agent ? { agent: r.agent } : {}),
    ...(r.created_by ? { createdBy: r.created_by } : {}),
    ...(r.orphaned ? { orphaned: true } : {}),
    ...(r.budget_micros != null ? { budgetMicros: r.budget_micros } : {}),
    ...(r.deadline_ms != null ? { deadlineMs: r.deadline_ms } : {}),
    ...(r.template ? { template: r.template } : {}),
    ...(r.model_provider ? { model: { provider: r.model_provider, id: r.model_id } } : {}),
    createdAt: r.created_at,
  });

  const schedules: ScheduleStore = {
    async upsert(s, key) {
      return once("schedule.upsert", key, () => {
        const existing = db.prepare("SELECT created_at FROM schedules WHERE id=?").get(s.id) as Row | undefined;
        const createdAt = existing ? existing.created_at : Date.now();
        // An upsert is a full replace of the config (targeting and spawn parameters included) and clears `orphaned`.
        const extra = [
          s.agent ?? null,
          s.createdBy ?? null,
          s.budgetMicros ?? null,
          s.deadlineMs ?? null,
          s.template ?? null,
          s.model?.provider ?? null,
          s.model?.id ?? null,
        ];
        if (existing) {
          db.prepare(
            "UPDATE schedules SET cron=?, tz=?, task=?, missed=?, overlap=?, jitter_ms=?, paused=COALESCE(?, paused), agent=?, created_by=?, budget_micros=?, deadline_ms=?, template=?, model_provider=?, model_id=?, orphaned=0 WHERE id=?",
          ).run(s.cron, s.tz ?? null, s.task, s.missed, s.overlap, s.jitterMs, s.paused === undefined ? null : s.paused ? 1 : 0, ...extra, s.id);
        } else {
          db.prepare(
            "INSERT INTO schedules (id,cron,tz,task,missed,overlap,jitter_ms,paused,created_at,agent,created_by,budget_micros,deadline_ms,template,model_provider,model_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          ).run(s.id, s.cron, s.tz ?? null, s.task, s.missed, s.overlap, s.jitterMs, s.paused ? 1 : 0, createdAt, ...extra);
        }
        return scheduleOf(db.prepare("SELECT * FROM schedules WHERE id=?").get(s.id) as Row);
      });
    },
    async setPaused(id, paused, key) {
      return once("schedule.setPaused", key, () => {
        // Resuming also closes the breaker so the schedule probes immediately.
        const res = paused
          ? db.prepare("UPDATE schedules SET paused=1 WHERE id=?").run(id)
          : db.prepare("UPDATE schedules SET paused=0, failures=0, retry_at=NULL WHERE id=?").run(id);
        if (res.changes === 0) return null;
        return scheduleOf(db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as Row);
      });
    },
    async recordFailure(id, retryAt, key) {
      return once("schedule.recordFailure", key, () => {
        const res = db.prepare("UPDATE schedules SET failures=failures+1, retry_at=? WHERE id=?").run(retryAt, id);
        if (res.changes === 0) return null;
        return scheduleOf(db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as Row);
      });
    },
    async clearFailures(id, key) {
      once("schedule.clearFailures", key, () => {
        db.prepare("UPDATE schedules SET failures=0, retry_at=NULL WHERE id=?").run(id);
        return null;
      });
    },
    async setOrphaned(id, key) {
      return once("schedule.setOrphaned", key, () => {
        const res = db.prepare("UPDATE schedules SET orphaned=1 WHERE id=?").run(id);
        if (res.changes === 0) return null;
        return scheduleOf(db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as Row);
      });
    },
    async remove(id) {
      return tx(() => {
        const res = db.prepare("DELETE FROM schedules WHERE id=?").run(id);
        db.prepare("DELETE FROM schedule_last_fired WHERE id=?").run(id);
        return res.changes > 0;
      });
    },
    async get(id) {
      const r = db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as Row | undefined;
      return r ? scheduleOf(r) : null;
    },
    async list() {
      const rows = db.prepare("SELECT * FROM schedules ORDER BY created_at, rowid").all() as Row[];
      return rows.map(scheduleOf);
    },
    async lastFired(id) {
      const r = db.prepare("SELECT at FROM schedule_last_fired WHERE id=?").get(id) as Row | undefined;
      return r ? r.at : null;
    },
    async setLastFired(id, at, key) {
      once("schedule.setLastFired", key, () => {
        db.prepare("INSERT OR REPLACE INTO schedule_last_fired (id, at) VALUES (?,?)").run(id, at);
        return null;
      });
    },
  };

  const watchdogOf = (r: Row): WatchdogState => ({
    rung: r.rung as WatchdogRung,
    lastActionAt: r.last_action_at ?? null,
    retries: r.retries,
    ...(r.restarts != null ? { restarts: JSON.parse(r.restarts) as number[] } : {}),
    ...(r.quarantined ? { quarantined: true } : {}),
  });

  const watchdogs: WatchdogStore = {
    async get(agent) {
      const r = db.prepare("SELECT * FROM watchdog_state WHERE agent=?").get(agent) as Row | undefined;
      return r ? watchdogOf(r) : null;
    },
    async set(agent, state, key) {
      return once("watchdog", key, () => {
        const existing = db.prepare("SELECT 1 FROM watchdog_state WHERE agent=?").get(agent) as Row | undefined;
        if (existing) {
          db.prepare("UPDATE watchdog_state SET rung=?, last_action_at=?, retries=?, restarts=?, quarantined=? WHERE agent=?").run(
            state.rung,
            state.lastActionAt,
            state.retries,
            state.restarts ? JSON.stringify(state.restarts) : null,
            state.quarantined ? 1 : 0,
            agent,
          );
        } else {
          db.prepare("INSERT INTO watchdog_state (agent, rung, last_action_at, retries, restarts, quarantined) VALUES (?,?,?,?,?,?)").run(
            agent,
            state.rung,
            state.lastActionAt,
            state.retries,
            state.restarts ? JSON.stringify(state.restarts) : null,
            state.quarantined ? 1 : 0,
          );
        }
        return watchdogOf(db.prepare("SELECT * FROM watchdog_state WHERE agent=?").get(agent) as Row);
      });
    },
    async clear(agent) {
      db.prepare("DELETE FROM watchdog_state WHERE agent=?").run(agent);
    },
  };

  const hostOf = (r: Row): HostRecord => ({
    id: r.id,
    labels: JSON.parse(r.labels),
    capacity: JSON.parse(r.capacity),
    images: JSON.parse(r.images),
    state: r.state as HostState,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  const reservationOf = (r: Row): Reservation => ({
    agent: r.agent,
    host: r.host ?? null,
    state: r.state as Reservation["state"],
    priority: r.priority,
    seq: r.seq,
    resources: JSON.parse(r.resources),
    template: r.template ?? null,
    createdAt: r.created_at,
  });
  const getHostRow = (id: HostId): HostRecord | null => {
    const r = db.prepare("SELECT * FROM hosts WHERE id=?").get(id) as Row | undefined;
    return r ? hostOf(r) : null;
  };
  const getReservationRow = (agent: string): Reservation | null => {
    const r = db.prepare("SELECT * FROM reservations WHERE agent=?").get(agent) as Row | undefined;
    return r ? reservationOf(r) : null;
  };

  const hosts: HostStore = {
    async upsertHost(h: NewHost, key) {
      return once("host.upsert", key, () => {
        const now = Date.now();
        const existing = db.prepare("SELECT 1 FROM hosts WHERE id=?").get(h.id);
        if (existing) {
          db.prepare("UPDATE hosts SET labels=?, capacity=?, images=?, state=?, updated_at=? WHERE id=?").run(
            JSON.stringify(h.labels),
            JSON.stringify(h.capacity),
            JSON.stringify(h.images),
            h.state,
            now,
            h.id,
          );
        } else {
          db.prepare("INSERT INTO hosts (id,labels,capacity,images,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(
            h.id,
            JSON.stringify(h.labels),
            JSON.stringify(h.capacity),
            JSON.stringify(h.images),
            h.state,
            now,
            now,
          );
        }
        return getHostRow(h.id)!;
      });
    },
    async getHost(id) {
      return getHostRow(id);
    },
    async listHosts() {
      return (db.prepare("SELECT * FROM hosts ORDER BY created_at, rowid").all() as Row[]).map(hostOf);
    },
    async setHostState(id, state, key) {
      return once("host.setState", key, () => {
        const res = db.prepare("UPDATE hosts SET state=?, updated_at=? WHERE id=?").run(state, Date.now(), id);
        return res.changes === 0 ? null : getHostRow(id);
      });
    },
    async reserve(r: NewReservation, key) {
      return once("reservation.reserve", key, () => {
        const existing = db.prepare("SELECT 1 FROM reservations WHERE agent=?").get(r.agent);
        if (existing) {
          db.prepare("UPDATE reservations SET host=?, state=?, priority=?, resources=?, template=? WHERE agent=?").run(
            r.host,
            r.state,
            r.priority,
            JSON.stringify(r.resources),
            r.template,
            r.agent,
          );
        } else {
          db.prepare("INSERT INTO reservations (agent,host,state,priority,resources,template,created_at) VALUES (?,?,?,?,?,?,?)").run(
            r.agent,
            r.host,
            r.state,
            r.priority,
            JSON.stringify(r.resources),
            r.template,
            Date.now(),
          );
        }
        return getReservationRow(r.agent)!;
      });
    },
    async getReservation(agent) {
      return getReservationRow(agent);
    },
    async listReservations(o = {}) {
      const rows = db
        .prepare("SELECT * FROM reservations WHERE (? IS NULL OR host=?) AND (? IS NULL OR state=?) ORDER BY priority, seq")
        .all(o.host ?? null, o.host ?? null, o.state ?? null, o.state ?? null) as Row[];
      return rows.map(reservationOf);
    },
    async releaseReservation(agent, key) {
      return once("reservation.release", key, () => db.prepare("DELETE FROM reservations WHERE agent=?").run(agent).changes > 0);
    },
  };

  const mergeOf = (r: Row): MergeRecord => ({
    id: r.id,
    repo: r.repo,
    host: r.host,
    generation: r.generation,
    caller: r.caller,
    child: r.child,
    request: JSON.parse(r.request),
    idempotencyKey: r.idem_key,
    phase: r.phase,
    attempts: r.attempts,
    base: r.base ?? null,
    source: r.source ?? null,
    candidate: r.candidate ?? null,
    startedAt: r.started_at,
    result: r.result == null ? null : (JSON.parse(r.result) as MergeResult),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  const mustMerge = (id: string): MergeRecord => {
    const r = db.prepare("SELECT * FROM merges WHERE id=?").get(id) as Row | undefined;
    if (!r) throw new Error(`unknown merge ${id}`);
    return mergeOf(r);
  };
  const mergeStatusOf = (repo: string, child: string): MergeStatus => {
    const r = db.prepare("SELECT * FROM merge_status WHERE repo=? AND child=?").get(repo, child) as Row | undefined;
    return r
      ? {
          repo,
          child,
          state: r.state as MergeStatusState,
          failedRounds: r.failed_rounds,
          lastMerge: r.last_merge ?? null,
          host: r.host ?? null,
          generation: r.generation ?? null,
          updatedAt: r.updated_at,
        }
      : { repo, child, state: "none", failedRounds: 0, lastMerge: null, host: null, generation: null, updatedAt: null };
  };

  const merges: MergeStore = {
    async begin(n: NewMergeRecord, key) {
      return tx(() => {
        const hit = db.prepare("SELECT * FROM merges WHERE idem_key=?").get(key) as Row | undefined;
        if (hit) return mergeOf(hit);
        const q = n.request;
        const a = mustAgent(q.caller);
        if (a.generation !== q.callerGeneration) throw new StaleGenerationError(q.caller, q.callerGeneration, a.generation);
        const now = Date.now();
        const id = randomUUID();
        db.prepare(
          "INSERT INTO merges (id,idem_key,repo,host,generation,caller,child,request,phase,attempts,started_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(id, key, n.repo, n.host, q.callerGeneration, q.caller, q.child, JSON.stringify(q), "begun", 0, n.startedAt, now, now);
        return mustMerge(id);
      });
    },
    async advance(id, step, key) {
      return once("merge.advance", key, () => {
        const cur = mustMerge(id);
        if (cur.phase === "done") return cur;
        db.prepare("UPDATE merges SET phase=?, attempts=?, base=?, source=?, candidate=?, updated_at=? WHERE id=?").run(
          step.phase,
          step.attempts ?? cur.attempts,
          step.base === undefined ? cur.base : step.base,
          step.source === undefined ? cur.source : step.source,
          step.candidate === undefined ? cur.candidate : step.candidate,
          Date.now(),
          id,
        );
        return mustMerge(id);
      });
    },
    async settle(id, result, key) {
      return once("merge.settle", key, () => {
        const cur = mustMerge(id);
        if (cur.phase === "done") return cur;
        const now = Date.now();
        db.prepare("UPDATE merges SET phase='done', result=?, updated_at=? WHERE id=?").run(JSON.stringify(result), now, id);
        const state: MergeStatusState | null =
          result.status === "merged"
            ? "merged"
            : result.status === "conflict"
              ? "conflict"
              : result.status === "check_failed"
                ? "check_failed"
                : result.status === "escalate"
                  ? "escalated"
                  : null;
        if (state) {
          const failed =
            result.status === "merged"
              ? 0
              : result.status === "escalate"
                ? result.rounds
                : result.status === "conflict" || result.status === "check_failed"
                  ? result.round
                  : 0;
          db.prepare(
            "INSERT INTO merge_status (repo,child,state,failed_rounds,last_merge,host,generation,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(repo,child) DO UPDATE SET state=excluded.state, failed_rounds=excluded.failed_rounds, last_merge=excluded.last_merge, host=excluded.host, generation=excluded.generation, updated_at=excluded.updated_at",
          ).run(cur.repo, cur.child, state, failed, id, cur.host, cur.generation, now);
        }
        return mustMerge(id);
      });
    },
    async get(id) {
      const r = db.prepare("SELECT * FROM merges WHERE id=?").get(id) as Row | undefined;
      return r ? mergeOf(r) : null;
    },
    async status(repo, child) {
      return mergeStatusOf(repo, child);
    },
    async findConflict(q) {
      const r = db
        .prepare(
          "SELECT * FROM merges WHERE repo=? AND caller=? AND child=? AND base=? AND source=? AND phase='done' AND json_extract(result,'$.status')='conflict' ORDER BY rowid DESC LIMIT 1",
        )
        .get(q.repo, q.caller, q.child, q.base, q.source) as Row | undefined;
      return r ? mergeOf(r) : null;
    },
    async list(o = {}) {
      const rows = db
        .prepare("SELECT * FROM merges WHERE (? IS NULL OR phase != 'done') AND (? IS NULL OR caller=?) AND (? IS NULL OR child=?) ORDER BY rowid")
        .all(o.open ? 1 : null, o.caller ?? null, o.caller ?? null, o.child ?? null, o.child ?? null) as Row[];
      return rows.map(mergeOf);
    },
  };

  const sessions: SessionStore = {
    async put(session) {
      const ref = createHash("sha256").update(session).digest("hex");
      db.prepare("INSERT OR IGNORE INTO sessions (ref, body) VALUES (?,?)").run(ref, session);
      return ref;
    },
    async get(ref) {
      const r = db.prepare("SELECT body FROM sessions WHERE ref=?").get(ref) as Row | undefined;
      return r ? (r.body as Uint8Array) : null;
    },
  };

  // Durable single-owner model debit/revocation store. `reserve`, `settle` and `cancel` each run in
  // one IMMEDIATE transaction so the credential verification, revocation check, and per-agent budget
  // arithmetic cannot interleave across proxy processes or a restart.
  const modelDebit = (options: { secret: string; now?: () => number }): SqliteModelDebitStore => {
    if (!options.secret) throw new Error("model debit store secret is required");
    const now = options.now ?? Date.now;

    const verify = (key: string): GatewayCredential | null => decodeGatewayCredential(options.secret, key, now());
    const reservation = (credential: GatewayCredential, requestId: string): RequestReservation => ({
      agent: credential.agent,
      credentialId: credential.id,
      requestId,
    });
    const remaining = (r: Row): number => ledgerView().remaining(r.agent);
    // A revocation kills credentials issued at or before it; a later-issued one (resume) is valid.
    const revokedAt = (c: GatewayCredential): number | null => {
      const row = db.prepare("SELECT revoked_at FROM model_debit_revocations WHERE agent=?").get(c.agent) as Row | undefined;
      return row && c.issuedAt <= row.revoked_at ? row.revoked_at : null;
    };

    const debits: ModelDebitStore = {
      reserve(key, requestId, maximumMicros): ReserveResult {
        return tx(() => {
          const credential = verify(key);
          if (!credential) return { ok: false as const, reason: "invalid-credential" as const };
          if (revokedAt(credential) !== null) return { ok: false as const, reason: "invalid-credential" as const };
          if (!validDebitRequestId(requestId) || !validDebitMicros(maximumMicros)) return { ok: false as const, reason: "invalid-request" as const };

          // Per-agent bucket: an established cap is changed only by setBudget (the gateway's issue), never by
          // a credential's own budget, so refreshing or concurrently using credentials cannot multiply spend authority.
          const existing = db.prepare("SELECT * FROM model_debit_agents WHERE agent=?").get(credential.agent) as Row | undefined;
          if (!existing) {
            db.prepare("INSERT INTO model_debit_agents (agent,budget_micros,spent_micros,reserved_micros) VALUES (?,?,0,0)").run(
              credential.agent,
              credential.budgetMicros,
            );
          }
          const ag = db.prepare("SELECT * FROM model_debit_agents WHERE agent=?").get(credential.agent) as Row;

          const req = db.prepare("SELECT * FROM model_debit_requests WHERE agent=? AND request_id=?").get(credential.agent, requestId) as Row | undefined;
          // A request id is single-use: replaying a reserved (in-flight) or settled id must not authorize
          // a second upstream call, since settle is idempotent and would debit nothing for it.
          if (req) return { ok: false as const, reason: "idempotency-conflict" as const };
          // Hierarchical: the reservation must fit the agent's remaining, and any spill past its carve must fit each ancestor's.
          const view = ledgerView();
          // TODO(ledger-broken): report a corrupt budget tree distinctly. Current behavior: all refusals map to budget-exhausted.
          // Cycle, unknown node and too-deep refusals all collapse here; the cause ledgerFits returns is dropped.
          if (!ledgerFits(view, credential.agent, maximumMicros).ok) return { ok: false as const, reason: "budget-exhausted" as const };

          db.prepare(
            "INSERT INTO model_debit_requests (agent,request_id,credential_id,maximum_micros,status,charged_micros,created_at) VALUES (?,?,?,?,?,NULL,?)",
          ).run(credential.agent, requestId, credential.id, maximumMicros, "reserved", now());
          db.prepare("UPDATE model_debit_agents SET reserved_micros=reserved_micros+? WHERE agent=?").run(maximumMicros, credential.agent);
          return { ok: true as const, reservation: reservation(credential, requestId), remainingMicros: view.remaining(credential.agent) - maximumMicros };
        });
      },

      settle(reservation: RequestReservation, chargedMicros: number): SettleResult {
        return tx(() => {
          if (!validDebitMicros(chargedMicros)) return { ok: false as const, reason: "invalid-charge" as const };
          const ag = db.prepare("SELECT * FROM model_debit_agents WHERE agent=?").get(reservation.agent) as Row | undefined;
          const req = ag
            ? (db.prepare("SELECT * FROM model_debit_requests WHERE agent=? AND request_id=?").get(reservation.agent, reservation.requestId) as Row | undefined)
            : undefined;
          if (!ag || !req || req.credential_id !== reservation.credentialId) return { ok: false as const, reason: "unknown-reservation" as const };
          if (req.status === "settled") return { ok: true as const, chargedMicros: req.charged_micros as number, remainingMicros: remaining(ag) };
          if (req.status === "expired-charged") {
            // The reservation expired and its full maximum was already charged (fail-closed). A late settle never charges that
            // again; only a true overage beyond the maximum is topped up. The ok result carries `expiredCharged: true` and the
            // amount charged in total, so the proxy can tell a late settle from a normal one.
            const extra = Math.max(0, chargedMicros - (req.charged_micros as number));
            if (extra > 0) {
              db.prepare("UPDATE model_debit_agents SET spent_micros=spent_micros+? WHERE agent=?").run(extra, reservation.agent);
              db.prepare("UPDATE model_debit_requests SET charged_micros=charged_micros+? WHERE agent=? AND request_id=?").run(
                extra,
                reservation.agent,
                reservation.requestId,
              );
            }
            const ag3 = db.prepare("SELECT * FROM model_debit_agents WHERE agent=?").get(reservation.agent) as Row;
            return { ok: true as const, chargedMicros: (req.charged_micros as number) + extra, remainingMicros: remaining(ag3), expiredCharged: true as const };
          }
          if (req.status !== "reserved") return { ok: false as const, reason: "unknown-reservation" as const };

          // True overage is recorded in full (the provider billed it): remaining may go negative, which
          // makes every later reserve for this agent fail with budget-exhausted.
          db.prepare("UPDATE model_debit_agents SET reserved_micros=reserved_micros-?, spent_micros=spent_micros+? WHERE agent=?").run(
            req.maximum_micros,
            chargedMicros,
            reservation.agent,
          );
          db.prepare("UPDATE model_debit_requests SET status='settled', charged_micros=?, settled_at=? WHERE agent=? AND request_id=?").run(
            chargedMicros,
            now(),
            reservation.agent,
            reservation.requestId,
          );
          const ag2 = db.prepare("SELECT * FROM model_debit_agents WHERE agent=?").get(reservation.agent) as Row;
          return { ok: true as const, chargedMicros, remainingMicros: remaining(ag2) };
        });
      },

      cancel(reservation: RequestReservation): boolean {
        return tx(() => {
          const req = db.prepare("SELECT * FROM model_debit_requests WHERE agent=? AND request_id=?").get(reservation.agent, reservation.requestId) as
            | Row
            | undefined;
          if (!req || req.credential_id !== reservation.credentialId || req.status !== "reserved") return false;
          // settled_at is when the row reached its terminal state (settled, cancelled or expired-charged), so a cancelled or
          // failed call's row is timestamped too.
          db.prepare("UPDATE model_debit_requests SET status='cancelled', settled_at=? WHERE agent=? AND request_id=?").run(
            now(),
            reservation.agent,
            reservation.requestId,
          );
          db.prepare("UPDATE model_debit_agents SET reserved_micros=reserved_micros-? WHERE agent=?").run(req.maximum_micros, reservation.agent);
          return true;
        });
      },
    };

    return {
      ...debits,
      recordCall(agent, requestId, meta): boolean {
        const r = db
          .prepare(
            "UPDATE model_debit_requests SET model=?, tokens_in=?, tokens_out=?, upstream_status=?, latency_ms=?, finish_reason=?, cache_read_tokens=?, cache_write_tokens=?, route=?, error_class=?, response_id=?, basis=? WHERE agent=? AND request_id=?",
          )
          .run(
            meta.model ?? null,
            meta.tokensIn ?? null,
            meta.tokensOut ?? null,
            meta.upstreamStatus ?? null,
            meta.latencyMs ?? null,
            meta.finishReason ?? null,
            meta.cacheReadTokens ?? null,
            meta.cacheWriteTokens ?? null,
            meta.route ?? null,
            meta.errorClass ?? null,
            meta.responseId ?? null,
            meta.basis ?? null,
            agent,
            requestId,
          );
        return Number(r.changes) > 0;
      },
      authorize(key): GatewayCredential | null {
        const credential = verify(key);
        if (!credential) return null;
        return revokedAt(credential) !== null ? null : credential;
      },
      checkCredential(key): CredentialCheck {
        const r = verifyGatewayCredential(options.secret, key, now());
        if (!r.ok) return r;
        return revokedAt(r.credential) !== null ? { ok: false, reason: "revoked" } : r;
      },
      touch(r: RequestReservation): boolean {
        const res = db
          .prepare("UPDATE model_debit_requests SET touched_at=? WHERE agent=? AND request_id=? AND credential_id=? AND status='reserved'")
          .run(now(), r.agent, r.requestId, r.credentialId);
        return Number(res.changes) > 0;
      },
      settledCall(agent, responseId) {
        const r = db
          .prepare(
            "SELECT request_id, charged_micros FROM model_debit_requests WHERE agent=? AND response_id=? AND status IN ('settled','expired-charged') AND charged_micros IS NOT NULL ORDER BY created_at LIMIT 1",
          )
          .get(agent, responseId) as Row | undefined;
        return r ? { requestId: r.request_id as string, chargedMicros: r.charged_micros as number } : null;
      },
      ledgerFor(agent): AgentLedger {
        const view = ledgerView();
        const budgetMicros = view.node(agent)?.budgetMicros ?? 0;
        const committedMicros = view.committed(agent);
        return { budgetMicros, committedMicros, remainingMicros: budgetMicros - committedMicros, overageMicros: view.overage(agent) };
      },
      spentFor(agent): number {
        const r = db.prepare("SELECT spent_micros FROM model_debit_agents WHERE agent=?").get(agent) as Row | undefined;
        return (r?.spent_micros as number | undefined) ?? 0;
      },
      setBudget(agent, micros): void {
        if (!validDebitMicros(micros)) throw new Error("budget micros must be a non-negative safe integer");
        db.prepare(
          "INSERT INTO model_debit_agents (agent,budget_micros,spent_micros,reserved_micros) VALUES (?,?,0,0) ON CONFLICT(agent) DO UPDATE SET budget_micros=excluded.budget_micros",
        ).run(agent, micros);
      },
      expireReservations(olderThanMs): number {
        return tx(() => {
          const stale = db
            // Idle since the last sign of life (touch), not since creation, so a long healthy stream is never expire-charged.
            .prepare("SELECT agent, request_id, maximum_micros FROM model_debit_requests WHERE status='reserved' AND COALESCE(touched_at, created_at)<=?")
            .all(now() - olderThanMs) as Row[];
          for (const r of stale) {
            // Fail-closed: the upstream call may have completed and been billed, so expiry charges the whole reservation.
            db.prepare("UPDATE model_debit_requests SET status='expired-charged', charged_micros=?, settled_at=? WHERE agent=? AND request_id=?").run(
              r.maximum_micros,
              now(),
              r.agent,
              r.request_id,
            );
            db.prepare("UPDATE model_debit_agents SET reserved_micros=reserved_micros-?, spent_micros=spent_micros+? WHERE agent=?").run(
              r.maximum_micros,
              r.maximum_micros,
              r.agent,
            );
          }
          return stale.length;
        });
      },
      issue(agent, clockMs): number {
        if (!Number.isSafeInteger(clockMs)) throw new Error("issue clock must be a safe integer");
        return tx(() => {
          // Strictly after any revocation (resume), and never below the latest stamp handed out (a backward clock).
          const rev = db.prepare("SELECT revoked_at FROM model_debit_revocations WHERE agent=?").get(agent) as Row | undefined;
          const high = db.prepare("SELECT issued_at FROM model_debit_issuance WHERE agent=?").get(agent) as Row | undefined;
          const issuedAt = Math.max(clockMs, rev ? (rev.revoked_at as number) + 1 : clockMs, high ? (high.issued_at as number) : clockMs);
          // Checked before the write: a throw rolls the transaction back, so no unsafe stamp reaches the high-water.
          if (!Number.isSafeInteger(issuedAt)) throw new Error("issued stamp is not a safe integer");
          db.prepare("INSERT INTO model_debit_issuance (agent,issued_at) VALUES (?,?) ON CONFLICT(agent) DO UPDATE SET issued_at=excluded.issued_at").run(
            agent,
            issuedAt,
          );
          return issuedAt;
        });
      },
      revoke(agent): void {
        tx(() => {
          // The cutoff covers the clock and every stamp already issued, so a backward clock cannot leave a live credential.
          const high = db.prepare("SELECT issued_at FROM model_debit_issuance WHERE agent=?").get(agent) as Row | undefined;
          const cutoff = Math.max(now(), high ? (high.issued_at as number) : now());
          db.prepare(
            "INSERT INTO model_debit_revocations (agent,revoked_at) VALUES (?,?) ON CONFLICT(agent) DO UPDATE SET revoked_at=max(revoked_at, excluded.revoked_at)",
          ).run(agent, cutoff);
        });
      },
    };
  };

  const quotaArg = (name: string, v: number): void => {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`quota ${name} must be a non-negative safe integer, got ${v}`);
  };
  const quotaUsed = (scope: string, key: string, windowStartMs: number): number =>
    ((db.prepare("SELECT used FROM quota_counters WHERE scope=? AND key=? AND window_start=?").get(scope, key, windowStartMs) as Row | undefined)?.used as
      | number
      | undefined) ?? 0;
  const quotaCounters: QuotaCounters = {
    take(scope, key, windowStartMs, amount, limit, opId) {
      quotaArg("window start", windowStartMs);
      quotaArg("amount", amount);
      quotaArg("limit", limit);
      if (opId !== undefined && (typeof opId !== "string" || opId === "")) throw new Error("quota opId must be a non-empty string when given");
      return tx(() => {
        if (opId !== undefined) {
          const prior = db.prepare("SELECT used FROM quota_ops WHERE scope=? AND key=? AND window_start=? AND op_id=?").get(scope, key, windowStartMs, opId) as
            | Row
            | undefined;
          if (prior) return { ok: true, used: prior.used as number };
        }
        const used = quotaUsed(scope, key, windowStartMs);
        if (used + amount > limit) return { ok: false, used };
        const t = Date.now();
        db.prepare(
          "INSERT INTO quota_counters (scope,key,window_start,used,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(scope,key,window_start) DO UPDATE SET used=excluded.used, updated_at=excluded.updated_at",
        ).run(scope, key, windowStartMs, used + amount, t);
        if (opId !== undefined)
          db.prepare("INSERT INTO quota_ops (scope,key,window_start,op_id,used,created_at) VALUES (?,?,?,?,?,?)").run(
            scope,
            key,
            windowStartMs,
            opId,
            used + amount,
            t,
          );
        return { ok: true, used: used + amount };
      });
    },
    give(scope, key, windowStartMs, amount) {
      quotaArg("window start", windowStartMs);
      quotaArg("amount", amount);
      return tx(() => {
        const used = quotaUsed(scope, key, windowStartMs);
        const next = Math.max(0, used - amount);
        if (used > 0)
          db.prepare("UPDATE quota_counters SET used=?, updated_at=? WHERE scope=? AND key=? AND window_start=?").run(
            next,
            Date.now(),
            scope,
            key,
            windowStartMs,
          );
        return next;
      });
    },
    peek(scope, key, windowStartMs) {
      quotaArg("window start", windowStartMs);
      return quotaUsed(scope, key, windowStartMs);
    },
  };

  const workspaceCleanup: WorkspaceCleanupStore = {
    markPruned(agent, at) {
      db.prepare("INSERT OR IGNORE INTO workspace_cleanup (agent, pruned_at) VALUES (?, ?)").run(agent, at);
    },
    markCleaned(agent, at) {
      db.prepare(
        "INSERT INTO workspace_cleanup (agent, pruned_at, cleaned_at) VALUES (?, ?, ?) ON CONFLICT(agent) DO UPDATE SET cleaned_at = excluded.cleaned_at",
      ).run(agent, at, at);
    },
    prunedAgents() {
      const rows = db.prepare("SELECT agent FROM workspace_cleanup WHERE pruned_at IS NOT NULL AND cleaned_at IS NULL").all() as Row[];
      return new Set(rows.map((r) => r.agent as string));
    },
    cleanedAgents() {
      const rows = db.prepare("SELECT agent FROM workspace_cleanup WHERE cleaned_at IS NOT NULL").all() as Row[];
      return new Set(rows.map((r) => r.agent as string));
    },
  };

  return {
    journal,
    registry,
    mailbox,
    checkpoints,
    escalations,
    approvals,
    schedules,
    watchdogs,
    hosts,
    merges,
    sessions,
    workspaceCleanup,
    modelDebit,
    close: () => {
      for (const s of [...subs]) s.close();
      db.close();
    },
    generationOf: (agent) => getAgent(agent)?.generation,
    captures: sqliteCaptureIndex({ db, once, fingerprintOf, now: () => Date.now() }),
    quotaCounters: () => quotaCounters,
    // A windowed row goes once its window started before the cutoff; a lifetime row (window 0) only once it has not been
    // touched since the cutoff, so a live agent's or task's lifetime cap is never reset by the sweep.
    // An opId record goes with the counter it charged.
    pruneQuotaCounters: (beforeMs, lifetimeBeforeMs = beforeMs) =>
      tx(() => {
        const n = Number(
          db
            .prepare("DELETE FROM quota_counters WHERE (window_start > 0 AND window_start < ?) OR (window_start = 0 AND updated_at < ?)")
            .run(beforeMs, lifetimeBeforeMs).changes,
        );
        db.exec(
          "DELETE FROM quota_ops WHERE NOT EXISTS (SELECT 1 FROM quota_counters c WHERE c.scope=quota_ops.scope AND c.key=quota_ops.key AND c.window_start=quota_ops.window_start)",
        );
        return n;
      }),
    pruneIdempotency: (olderThanMs) => pruneIdempotencyRows(olderThanMs, IDEMPOTENCY_KEPT_SCOPES),
  };
}
