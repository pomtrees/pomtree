// Generic workflow host: reviewed, in-process deterministic definitions registered by extensions and admitted through one
// validated internal start seam. A definition is qualified as `<extension>/<name>` (the extension owns the namespace; the
// caller cannot choose it) and runs as a deterministic task, so identity, generation, inbox, budget, results, cancel and
// default restart failure are the existing lifecycle's; continuation is an explicit reviewed opt-in. Trust is cooperative, not isolation: a handler can use ambient daemon
// privileges, so admission is gated by the host's explicit reviewed-extension policy (default deny), not by the manifest.
import type {
  AgentId,
  AgentRecord,
  DeterministicExecutor,
  DeterministicOps,
  DeterministicRunContext,
  ExecutorSpawnRequest,
  JsonValue,
  Registry,
  WorkflowCapabilities,
  WorkflowDef,
} from "@pomtree/core";
import { CONFIG_DEFAULTS, isJsonValue } from "@pomtree/core";
import type { DeterministicStartRequest } from "./daemon-types.ts";
import { agentIdFor, LifecycleError } from "./lifecycle.ts";
import { buildRunOps, canonicalJson, instanceOf, normalizeCapabilities, type WorkflowCapabilityServices } from "./workflow-capabilities.ts";

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

// Unforgeable within the cooperative driver API: arbitrary deterministic executors cannot opt into replay.
const continuations = new WeakMap<DeterministicExecutor, (agent: AgentId) => Promise<void>>();
export const continuationBarrier = (driver: DeterministicExecutor | undefined) => driver && continuations.get(driver);

export const qualifyWorkflow = (extension: string, name: string): string => `${extension}/${name}`;

// Typed admission failure, thrown at its origin. Only these keep their class through `launch`; their message is internal detail
// (tests and logs), and the public launch error is the fixed text in `publicLaunchError`.
export type AdmissionKind = "unknown" | "invalid" | "conflict" | "closed";
export class WorkflowAdmissionError extends Error {
  kind: AdmissionKind;
  constructor(kind: AdmissionKind, message: string) {
    super(message);
    this.name = "WorkflowAdmissionError";
    this.kind = kind;
  }
}

// The public launch error: a fixed message per status. Only typed admission errors and LifecycleErrors with an allowlisted status
// keep their class; any other failure (registry, store, daemon, validator, handler text) is a generic 500 and never echoes raw text,
// so local paths and secrets cannot reach the caller or chat.
const PUBLIC_MESSAGE: Record<number, string> = {
  400: "invalid workflow request",
  403: "workflow capability not declared",
  404: "unknown or unavailable workflow",
  409: "workflow conflict",
  503: "workflow admission is closed",
};
export function publicLaunchError(e: unknown): LifecycleError {
  if (e instanceof WorkflowAdmissionError) {
    if (e.kind === "unknown") return new LifecycleError(404, "unknown or unavailable workflow");
    if (e.kind === "invalid") return new LifecycleError(400, "invalid workflow input");
    if (e.kind === "conflict") return new LifecycleError(409, "idempotency key is already bound");
    return new LifecycleError(503, "workflow admission is closed");
  }
  if (e instanceof LifecycleError && Object.hasOwn(PUBLIC_MESSAGE, e.status))
    return new LifecycleError(e.status, PUBLIC_MESSAGE[e.status] ?? "workflow start failed");
  return new LifecycleError(500, "workflow start failed");
}

// Marks a wait that outlived its deadline (see raceUntil). Never a real value.
export const EXPIRED: unique symbol = Symbol("expired");

// A validated request to start one registered workflow. `workflow` is the qualified `<extension>/<name>`.
export interface WorkflowStartRequest {
  workflow: string;
  name: string;
  task: string;
  idempotencyKey: string;
  input: JsonValue;
  budgetMicros?: number;
  deadlineMs?: number;
}

export interface WorkflowHostOptions {
  // Read lazily (teardown only), so the host can be built before the daemon and its registry exist.
  registry: () => Registry;
  // Host-supplied reviewed-extension policy. DEFAULT DENY: an extension's workflows are admitted only when this returns true.
  // The manifest and the directory are not proof of review.
  reviewed: (extension: string) => boolean;
  // The daemon's internal deterministic start (Daemon.startDeterministic). Called only after validation succeeds.
  startDeterministic: (requester: AgentId, req: DeterministicStartRequest) => Promise<AgentRecord>;
  log?: (line: string) => void;
  // Capability services (root journal, reports, outbox, ask, fetch transport). Read per effect; absent = capability effects refuse.
  services?: () => WorkflowCapabilityServices | undefined;
  // The resolved workflow report ceiling, min(report.workflowMaxBytes, report.maxBytes) (main.ts): a definition declaring a
  // fetch or reports maxBytes above it is refused at commit. Absent = the report.workflowMaxBytes registry default.
  reportCeilingBytes?: number;
}

// Shutdown inputs. Every wait goes through `race`, so no step can outlive the absolute drain deadline.
export interface DrainOptions {
  deadlineAt: number;
  now: () => number;
  cancel: (id: AgentId, graceMs: number) => Promise<void>;
  tick: () => Promise<void>;
  race: <T>(p: Promise<T>) => Promise<T | typeof EXPIRED>;
}

export interface DrainResult {
  complete: boolean;
  // Owners (extension names) that still hold a live task/body/effect, an unsettled admission, or a failed cancel. Their handlers stay live.
  retained: string[];
  live: AgentId[];
  errors: string[];
}

interface Snapshot {
  name: string;
  continuation: boolean;
  validate: WorkflowDef["validate"];
  run: WorkflowDef["run"];
  caps: WorkflowCapabilities;
}

// The owner of a qualified driver is the extension before the first `/` (extension names cannot contain `/`).
const ownerPart = (qualified: string): string | null => {
  const i = qualified.indexOf("/");
  return i > 0 ? qualified.slice(0, i) : null;
};

// The one normalization point (admission and child spawn). Strict on the verdict shape: a validator that returns anything
// other than { ok: boolean, value (JSON) } or { ok: false, error (non-empty string) } is refused before any row exists.
function normalizeInput(qualified: string, validate: WorkflowDef["validate"], input: JsonValue): JsonValue {
  let verdict: unknown;
  try {
    verdict = validate(input);
  } catch {
    throw new Error(`workflow ${qualified}: validation failed`);
  }
  if (typeof verdict !== "object" || verdict === null || Array.isArray(verdict)) throw new Error(`workflow ${qualified}: malformed validator verdict`);
  const v = verdict as Record<string, unknown>;
  if (typeof v.ok !== "boolean") throw new Error(`workflow ${qualified}: malformed validator verdict (ok is not boolean)`);
  if (v.ok === false) {
    if (typeof v.error !== "string" || v.error === "") throw new Error(`workflow ${qualified}: malformed validator verdict (error)`);
    throw new WorkflowAdmissionError("invalid", `workflow ${qualified}: invalid input: ${v.error}`);
  }
  if (!("value" in v) || !isJsonValue(v.value)) throw new Error(`workflow ${qualified}: validator returned a missing or non-JSON value`);
  return v.value;
}

// Read-only view of the executor map handed to the Daemon. Private storage (#map) and no mutators: a caller cannot reach the
// Map to set, delete or clear a driver. This is a source-level boundary, not isolation.
class ExecutorView implements ReadonlyMap<string, DeterministicExecutor> {
  readonly #map: Map<string, DeterministicExecutor>;
  constructor(map: Map<string, DeterministicExecutor>) {
    this.#map = map;
    Object.freeze(this);
  }
  get size(): number {
    return this.#map.size;
  }
  get(key: string): DeterministicExecutor | undefined {
    return this.#map.get(key);
  }
  has(key: string): boolean {
    return this.#map.has(key);
  }
  forEach(cb: (value: DeterministicExecutor, key: string, map: ReadonlyMap<string, DeterministicExecutor>) => void, thisArg?: unknown): void {
    for (const [k, v] of this.#map) cb.call(thisArg, v, k, this);
  }
  keys(): MapIterator<string> {
    return this.#map.keys();
  }
  values(): MapIterator<DeterministicExecutor> {
    return this.#map.values();
  }
  entries(): MapIterator<[string, DeterministicExecutor]> {
    return this.#map.entries();
  }
  [Symbol.iterator](): MapIterator<[string, DeterministicExecutor]> {
    return this.#map.entries();
  }
}

// Resolves to the promise's value, or EXPIRED once the absolute deadline is reached. A deadline already reached yields EXPIRED
// at once (even if `p` is settled), and the timer is cleared as soon as `p` settles. A late rejection is swallowed, not unhandled.
export function raceUntil<T>(p: Promise<T>, deadlineAt: number, now: () => number = Date.now): Promise<T | typeof EXPIRED> {
  return new Promise<T | typeof EXPIRED>((resolve, reject) => {
    if (now() >= deadlineAt) {
      p.catch(() => {});
      resolve(EXPIRED);
      return;
    }
    const timer = setTimeout(() => resolve(EXPIRED), deadlineAt - now());
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export const sleepTick = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

export class WorkflowHost {
  readonly executors: ReadonlyMap<string, DeterministicExecutor>;
  // Mutable storage behind the read-only view; written only by commit/withdraw.
  private readonly driverMap = new Map<string, DeterministicExecutor>();
  private readonly committed = new Map<string, Snapshot>();
  private readonly byExtension = new Map<string, string[]>();
  // Every extension that ever committed here (admission accounting and child guard).
  private readonly owners = new Set<string>();
  // Exact qualified driver -> owner, for every driver ever committed. Survives withdraw, so a withdrawn driver's live task
  // still blocks close. Only these exact drivers are owned; a same-prefix driver (`owner/ghost`) is foreign.
  private readonly driverOwner = new Map<string, string>();
  // Actual handler bodies and effects, independent of the lifecycle drive promise (cancel deliberately detaches that promise).
  private readonly executions = new Map<Promise<void>, { owner: string; agent: AgentId }>();
  // One chain serializes admission, child admission and teardown.
  private gate: Promise<unknown> = Promise.resolve();
  // Terminal for admission: set by a successful close() or by the start of a drain.
  private draining = false;
  private readonly opts: WorkflowHostOptions;

  constructor(opts: WorkflowHostOptions) {
    this.opts = opts;
    this.executors = new ExecutorView(this.driverMap);
  }

  // Boot-only: called by the extension registry after the owning extension started. All-or-nothing per extension: a malformed
  // or duplicate definition throws and nothing from that extension is committed. Definitions are snapshotted here: later
  // mutation of the definition object cannot change the code that runs.
  commit(extension: string, defs: readonly WorkflowDef[]): void {
    if (defs.length === 0) return;
    if (this.draining) throw new Error(`workflows: admission is closed; cannot commit ${extension}`);
    if (!this.opts.reviewed(extension)) {
      this.opts.log?.(`workflows of extension ${extension} are not reviewed by the host; ${defs.length} definition(s) not admitted`);
      return;
    }
    const names = new Set<string>();
    const snaps: Snapshot[] = [];
    for (const d of defs) {
      if (typeof d !== "object" || d === null) throw new Error(`workflow in ${extension}: definition must be an object`);
      if (typeof d.name !== "string" || !NAME_RE.test(d.name)) throw new Error(`workflow in ${extension}: invalid name ${JSON.stringify(d.name)}`);
      if (typeof d.validate !== "function" || typeof d.run !== "function") throw new Error(`workflow ${extension}/${d.name}: validate and run are required`);
      const q = qualifyWorkflow(extension, d.name);
      if (names.has(q) || this.committed.has(q)) throw new Error(`duplicate workflow ${q}`);
      names.add(q);
      // Bound to the reviewed receiver at commit: the captured functions cannot be replaced by later assignment to `d`.
      // The receiver's own state is NOT frozen: later mutation of fields it reads still affects behaviour.
      const caps = normalizeCapabilities(q, d.capabilities, this.opts.reportCeilingBytes ?? CONFIG_DEFAULTS["report.workflowMaxBytes"]);
      if (d.continuation !== undefined && typeof d.continuation !== "boolean") throw new Error(`workflow ${q}: continuation must be boolean`);
      snaps.push({ name: d.name, continuation: d.continuation === true, validate: d.validate.bind(d), run: d.run.bind(d), caps });
    }
    const keys: string[] = [];
    for (const s of snaps) {
      const q = qualifyWorkflow(extension, s.name);
      this.committed.set(q, s);
      this.driverOwner.set(q, extension);
      this.driverMap.set(q, Object.freeze(this.adapt(q, s)));
      keys.push(q);
    }
    this.byExtension.set(extension, keys);
    this.owners.add(extension);
  }

  // Makes an extension's committed workflows unavailable for new admissions (its start failed, or it stopped at shutdown).
  withdraw(extension: string): void {
    for (const q of this.byExtension.get(extension) ?? []) {
      this.committed.delete(q);
      this.driverMap.delete(q);
    }
    this.byExtension.delete(extension);
  }

  qualifiedNames(): string[] {
    return [...this.committed.keys()].sort();
  }

  // The executor the daemon runs. The input is the admission-time normalized value, so run never validates again.
  private adapt(q: string, s: Snapshot): DeterministicExecutor {
    const driver: DeterministicExecutor = {
      driver: q,
      run: (ctx: DeterministicRunContext): Promise<void> =>
        this.trackExecution(q, ctx.agent, async () => {
          if (ctx.signal.aborted) return;
          const workflow = buildRunOps({
            workflow: q,
            caps: s.caps,
            ctx,
            getServices: () => this.opts.services?.(),
            trackEffect: (work) => this.trackExecution(q, ctx.agent, work),
          });
          await s.run({ ...ctx, workflow, ops: this.trackOps(q, ctx.agent, this.guardOps(ctx.ops, ctx.agent, s.caps)) } as Parameters<typeof s.run>[0]);
        }),
    };
    if (s.continuation)
      continuations.set(driver, async (agent) => {
        for (;;) {
          const active = [...this.executions].filter(([, info]) => info.agent === agent).map(([promise]) => promise);
          if (active.length === 0) return;
          await Promise.all(active);
        }
      });
    return driver;
  }

  // Track before invoking work, absorb late rejection for shutdown accounting, and keep the original result for its caller.
  // Effects are tracked separately: a handler can return without awaiting a publish already inside the root store.
  private trackExecution<T>(qualified: string, agent: AgentId, work: () => Promise<T>): Promise<T> {
    const owner = this.driverOwner.get(qualified);
    if (owner === undefined) throw new Error("workflow execution has no registered owner");
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    this.executions.set(done, { owner, agent });
    const finish = () => {
      this.executions.delete(done);
      resolve();
    };
    try {
      // Preserve the handler/operation's invocation timing; tracking must not insert a new microtask before it starts.
      const run = work();
      void run.then(finish, finish);
      return run;
    } catch (e) {
      finish();
      return Promise.reject(e);
    }
  }

  private trackOps(q: string, agent: AgentId, ops: DeterministicOps): DeterministicOps {
    return {
      peek: () => this.trackExecution(q, agent, () => ops.peek()),
      findChild: (key) => this.trackExecution(q, agent, () => ops.findChild(key)),
      suspend: (state, wait, key) => this.trackExecution(q, agent, () => ops.suspend(state, wait, key)),
      answerEscalation: (id, answer, key) => this.trackExecution(q, agent, () => ops.answerEscalation(id, answer, key)),
      passEscalation: (id, key) => this.trackExecution(q, agent, () => ops.passEscalation(id, key)),
      openApproval: (kind, target, key) => this.trackExecution(q, agent, () => ops.openApproval(kind, target, key)),
      getApproval: (id) => this.trackExecution(q, agent, () => ops.getApproval(id)),
      ack: (ids, key) => this.trackExecution(q, agent, () => ops.ack(ids, key)),
      message: (to, body, key) => this.trackExecution(q, agent, () => ops.message(to, body, key)),
      reap: (child, key) => this.trackExecution(q, agent, () => ops.reap(child, key)),
      submitResult: (result, key) => this.trackExecution(q, agent, () => ops.submitResult(result, key)),
      spawn: (child) => this.trackExecution(q, agent, () => ops.spawn(child)),
    };
  }

  // Shutdown-only barrier. Does not change normal cancel/terminal semantics; drain calls it only after admission and rows settle.
  async idle(): Promise<void> {
    while (this.executions.size > 0) await Promise.all([...this.executions.keys()]);
  }

  // Child admission from a handler: a deterministic child must name a committed workflow and pass the same normalization, the
  // same keyed-replay check and the same drain gate, then the ORIGINAL fenced ops.spawn creates it. Container children pass
  // through unchanged. The spawn arrow is async, so every failure (including a malformed request) is a rejection, never a throw.
  private guardOps(ops: DeterministicOps, agent: AgentId, caps: WorkflowCapabilities): DeterministicOps {
    return {
      peek: () => ops.peek(),
      findChild: (key) => ops.findChild(key),
      suspend: (state, wait, key) => ops.suspend(state, wait, key),
      answerEscalation: (id, answer, key) => ops.answerEscalation(id, answer, key),
      passEscalation: (id, key) => ops.passEscalation(id, key),
      openApproval: (kind, target, key) => ops.openApproval(kind, target, key),
      getApproval: (id) => ops.getApproval(id),
      ack: (ids, key) => ops.ack(ids, key),
      message: (to, body, key) => ops.message(to, body, key),
      reap: (child, key) => ops.reap(child, key),
      submitResult: (result, key) => ops.submitResult(result, key),
      spawn: async (child: ExecutorSpawnRequest): Promise<AgentId> => {
        if (child.executor !== "deterministic") {
          // A workflow may spawn a container (model) child only within its declared model budget ceiling.
          const max = caps.modelChildren?.maxBudgetMicros;
          if (max === undefined) throw new LifecycleError(403, "workflow capability not declared: modelChildren");
          if (child.budgetMicros === undefined || child.budgetMicros > max) throw new LifecycleError(403, "model child budget exceeds the declared ceiling");
          return ops.spawn(child);
        }
        const driver = child.spec.driver;
        const owner = ownerPart(driver);
        if (owner === null || !this.owners.has(owner)) throw new WorkflowAdmissionError("unknown", `unknown or unavailable workflow ${JSON.stringify(driver)}`);
        return this.track(async () => {
          if (this.draining) throw new WorkflowAdmissionError("closed", "workflow admission is closed (daemon is stopping)");
          const input = this.admitSpec(driver, child.spec.input);
          await this.checkReplay(agent, child.idempotencyKey, driver, input);
          const other = await this.activeInstance(driver, input, agentIdFor(agent, child.idempotencyKey));
          // One active run per instance: a different active task is a conflict (its id is never handed back to this caller).
          if (other !== null) throw new WorkflowAdmissionError("conflict", `workflow ${JSON.stringify(driver)} already has an active run for this instance`);
          // Re-check after the awaits: a withdraw during child admission makes the workflow unavailable, so no child is created.
          if (!this.committed.has(driver)) throw new WorkflowAdmissionError("unknown", `unknown or unavailable workflow ${JSON.stringify(driver)}`);
          return ops.spawn({ ...child, spec: { driver, input } });
        });
      },
    };
  }

  // Keyed replay (same as lifecycle's id derivation): the id is agentIdFor(requester, key). An existing row must be a deterministic
  // row of the SAME qualified workflow with the SAME normalized input; anything else is a conflict and nothing is created or carved.
  // An exact retry falls through to the existing fenced path, which returns the original row.
  private async checkReplay(requester: AgentId, key: string, qualified: string, input: JsonValue): Promise<void> {
    const existing = await this.opts.registry().get(agentIdFor(requester, key));
    if (existing === null) return;
    if (existing.executor !== "deterministic")
      throw new WorkflowAdmissionError("conflict", `idempotency key ${JSON.stringify(key)} is already used by a container task`);
    const bound = (existing.spec as { driver?: unknown; input?: unknown }).driver;
    if (bound !== qualified)
      throw new WorkflowAdmissionError("conflict", `idempotency key ${JSON.stringify(key)} is already bound to workflow ${JSON.stringify(bound)}`);
    if (canonicalJson((existing.spec as { input?: unknown }).input) !== canonicalJson(input))
      throw new WorkflowAdmissionError("conflict", `idempotency key ${JSON.stringify(key)} is already bound to a different input`);
  }

  // One active run per qualified workflow + instance (state-declaring workflows only). Returns the other pending/running row, if any.
  private async activeInstance(q: string, input: JsonValue, selfId: AgentId): Promise<AgentRecord | null> {
    const caps = this.committed.get(q)?.caps;
    if (!caps?.state) return null;
    const instance = instanceOf(q, caps, input);
    const rows = await this.ownedActive();
    return (
      rows.find(
        (r) =>
          r.id !== selfId && (r.spec as { driver?: unknown }).driver === q && instanceOf(q, caps, (r.spec as { input?: JsonValue }).input ?? null) === instance,
      ) ?? null
    );
  }

  // Validated internal launch (the one capability-aware entry point). Unknown workflow 404; invalid input and bad keys 400; keyed
  // conflicts 409; closed admission 503; anything else a generic 500. Public messages are fixed (see publicLaunchError).
  // Returns the existing row for an exact replay or an active instance run.
  async launch(
    requester: AgentId,
    req: { workflow: string; input: JsonValue; idempotencyKey: string; budgetMicros?: number; deadlineMs?: number },
  ): Promise<AgentRecord> {
    const q = req.workflow;
    if (!this.committed.has(q)) throw new LifecycleError(404, "unknown or unavailable workflow");
    if (typeof req.idempotencyKey !== "string" || req.idempotencyKey === "") throw new LifecycleError(400, "idempotencyKey is required");
    const name = q.slice(q.indexOf("/") + 1);
    try {
      return await this.start(requester, {
        workflow: q,
        name,
        task: `workflow ${q}`,
        idempotencyKey: req.idempotencyKey,
        input: req.input,
        ...(req.budgetMicros !== undefined && { budgetMicros: req.budgetMicros }),
        ...(req.deadlineMs !== undefined && { deadlineMs: req.deadlineMs }),
      });
    } catch (e) {
      throw publicLaunchError(e);
    }
  }

  // Validated internal start. Unknown, unavailable, invalid or non-JSON input is refused before the daemon creates any task.
  start(requester: AgentId, req: WorkflowStartRequest): Promise<AgentRecord> {
    return this.track(async () => {
      if (this.draining) throw new WorkflowAdmissionError("closed", "workflow admission is closed (daemon is stopping)");
      const input = this.admitSpec(req.workflow, req.input);
      await this.checkReplay(requester, req.idempotencyKey, req.workflow, input);
      const other = await this.activeInstance(req.workflow, input, agentIdFor(requester, req.idempotencyKey));
      if (other !== null) return other;
      // Re-check after the awaits: a withdraw during admission makes the workflow unavailable (404), never a started task.
      if (!this.committed.has(req.workflow)) throw new WorkflowAdmissionError("unknown", `unknown or unavailable workflow ${JSON.stringify(req.workflow)}`);
      return this.opts.startDeterministic(requester, {
        executor: "deterministic",
        name: req.name,
        task: req.task,
        idempotencyKey: req.idempotencyKey,
        ...(req.budgetMicros !== undefined && { budgetMicros: req.budgetMicros }),
        ...(req.deadlineMs !== undefined && { deadlineMs: req.deadlineMs }),
        spec: { driver: req.workflow, input },
      });
    });
  }

  // The single admission check for named start and child spawn. Throws before any row or carve exists.
  private admitSpec(qualified: string, input: JsonValue): JsonValue {
    const s = this.committed.get(qualified);
    if (!s || !this.driverMap.has(qualified)) throw new WorkflowAdmissionError("unknown", `unknown or unavailable workflow ${JSON.stringify(qualified)}`);
    if (!isJsonValue(input)) throw new WorkflowAdmissionError("invalid", `workflow ${qualified}: input is not JSON`);
    const value = normalizeInput(qualified, s.validate, input);
    try {
      instanceOf(qualified, s.caps, value); // state-declaring workflows need a valid input.instance
    } catch (e) {
      throw new WorkflowAdmissionError("invalid", e instanceof Error ? e.message : String(e));
    }
    return value;
  }

  // Runs `fn` in the serialized gate. The gate is the one admission/teardown serialization authority.
  private track<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.gate.then(() => fn());
    this.gate = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  // Owned rows: deterministic, pending or running, whose exact driver this host ever committed.
  private async ownedActive(): Promise<AgentRecord[]> {
    const reg = this.opts.registry();
    const rows = [...(await reg.list({ state: "pending" })), ...(await reg.list({ state: "running" })), ...(await reg.list({ state: "yielded" }))];
    return rows.filter((a) => this.ownerOfRow(a) !== null);
  }

  // The owner of a deterministic row whose exact driver this host ever committed; null otherwise (containers, foreign drivers,
  // and unknown drivers under an owner's prefix).
  private ownerOfRow(a: AgentRecord): string | null {
    if (a.executor !== "deterministic") return null;
    const driver = (a.spec as { driver?: unknown }).driver;
    if (typeof driver !== "string") return null;
    return this.driverOwner.get(driver) ?? null;
  }

  private retainOwner(retained: Set<string>, a: AgentRecord): void {
    const owner = this.ownerOfRow(a);
    if (owner !== null) retained.add(owner);
  }

  // Management teardown: refuses (throws, changes nothing) while an owned task is pending or running; otherwise closes
  // admission for good. Serialized with admission, so an admit cannot slip between the check and the close.
  close(): Promise<void> {
    const run = this.gate.then(async () => {
      const live = await this.ownedActive();
      if (live.length > 0) throw new Error(`refusing to stop: ${live.length} deterministic task(s) pending or running`);
      if (this.executions.size > 0) throw new Error(`refusing to stop: ${this.executions.size} workflow executor/effect(s) still unsettled`);
      this.draining = true;
    });
    this.gate = run.catch(() => {});
    return run;
  }

  // Runs one wait under the absolute deadline. Any expiry, rejection or throw yields ok:false and records why; a late rejection of
  // an abandoned wait is swallowed. Nothing here can await past the deadline.
  private async bounded<T>(o: DrainOptions, label: string, work: () => Promise<T>, errors: string[]): Promise<{ ok: true; value: T } | { ok: false }> {
    if (o.now() >= o.deadlineAt) {
      errors.push(`${label} exceeded the drain deadline`);
      return { ok: false };
    }
    let p: Promise<T>;
    try {
      p = work();
    } catch (e) {
      errors.push(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false };
    }
    p.catch(() => {});
    try {
      const r = await o.race(p);
      if (r === EXPIRED) {
        errors.push(`${label} exceeded the drain deadline`);
        return { ok: false };
      }
      return { ok: true, value: r };
    } catch (e) {
      errors.push(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false };
    }
  }

  // The drain as shutdown calls it: never rejects. An unexpected failure retains EVERY owner ever committed (fail closed).
  async drainSafe(o: DrainOptions): Promise<DrainResult> {
    try {
      return await this.drain(o);
    } catch (e) {
      this.draining = true;
      return {
        complete: false,
        retained: [...this.owners].sort(),
        live: [],
        errors: [`drain failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`],
      };
    }
  }

  // Shutdown drain (owner-approved). Closes admission at once, waits for accepted admissions to settle, cancels each owned live
  // task through the existing cancel path and re-reads until none is live. EVERY wait (gate, snapshot, cancel, tick) is bounded
  // by the same absolute deadline and fails closed:
  // - no successful snapshot before a failure: every owner is retained (nothing is known about live work);
  // - a successful snapshot before a failure: the owners of its live rows are retained (admission is closed and the gate has
  //   settled, so no owned row can appear after that snapshot; the snapshot is a superset of what is still live);
  // - a cancel that fails or is unresolved: its owner is retained.
  // `complete` is true only after no owned row is pending/running AND actual bodies/effects joined, with no failures.
  async drain(o: DrainOptions): Promise<DrainResult> {
    this.draining = true;
    // No extension ever committed a workflow: no owned row can exist, so nothing is read from the registry.
    if (this.owners.size === 0) return { complete: true, retained: [], live: [], errors: [] };
    const retained = new Set<string>();
    const errors: string[] = [];
    const cancelled = new Set<string>();
    let known: AgentRecord[] | null = null; // last successful owned snapshot
    let proven = false; // the last successful snapshot was empty
    const retainKnown = (): void => {
      if (known === null) for (const owner of this.owners) retained.add(owner);
      else for (const r of known) this.retainOwner(retained, r);
      for (const e of this.executions.values()) retained.add(e.owner);
    };
    const out = (): DrainResult => ({
      complete: proven && retained.size === 0 && errors.length === 0,
      retained: [...retained].sort(),
      live: proven ? [] : [...new Set([...(known ?? []).map((r) => r.id), ...[...this.executions.values()].map((e) => e.agent)])],
      errors,
    });
    const gate = await this.bounded(o, "admission gate", () => this.gate.then(() => undefined), errors);
    if (!gate.ok) {
      retainKnown();
      return out();
    }
    for (;;) {
      const snap = await this.bounded(o, "owned snapshot", () => this.ownedActive(), errors);
      if (!snap.ok) {
        retainKnown();
        return out();
      }
      known = snap.value;
      if (known.length === 0) {
        // Abort can finish the registry row and drive while the actual body or a root-owned effect is still pending.
        const executing = [...this.executions.values()];
        const settled = await this.bounded(o, "workflow executor/effect settlement", () => this.idle(), errors);
        if (!settled.ok) {
          const unresolved = [...executing, ...this.executions.values()];
          for (const e of unresolved) retained.add(e.owner);
          if (unresolved.length === 0) for (const owner of this.owners) retained.add(owner); // failed join, no ownership proof
          return out();
        }
        proven = true;
        return out();
      }
      for (const r of known) {
        if (cancelled.has(r.id)) continue;
        cancelled.add(r.id);
        const c = await this.bounded(o, `cancel ${r.id}`, () => o.cancel(r.id, Math.max(0, o.deadlineAt - o.now())), errors);
        if (!c.ok) this.retainOwner(retained, r);
      }
      if (o.now() >= o.deadlineAt) {
        errors.push("drain deadline reached with owned task(s) still pending or running");
        retainKnown();
        return out();
      }
      const t = await this.bounded(o, "drain tick", o.tick, errors);
      if (!t.ok) {
        retainKnown();
        return out();
      }
    }
  }
}
