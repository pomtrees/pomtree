import { SandboxUnavailableError, StaleGenerationError } from "@pomtree/core";
import type {
  AgentId,
  AgentRecord,
  Extension,
  ExtensionHost,
  ExtensionRequest,
  ExtensionResponse,
  Schedule,
  ScheduleId,
  ScheduleStore,
  Signal,
  SpawnIntent,
} from "@pomtree/core";
import { CronSchedule, DEFAULT_MAX_CATCH_UP, jitterFor, onFire, parseCron, taskKey } from "@pomtree/sched";
import { IDEMPOTENCY_KEY_REQUIRED } from "../error-codes.ts";
import { LifecycleError, agentIdFor } from "../lifecycle.ts";
import { principalOf } from "../route-match.ts";

// The built-in cron extension: owns the schedule store, the `GET/PUT/DELETE /v1/schedules` routes, and the
// schedule sweep; its start()/stop() own the cron interval. Spawning a schedule's root child stays a daemon capability, reached through the narrow
// `spawnRootChild` facade (plus `rootId` for the deterministic overlap check), supplied by the host.
// A schedule with an `agent` target is a periodic wakeup of that agent instead of a spawn: the fire is delivered
// through the injected `steerAgent` (pending/running/waiting target) or `wakeAgent` (yielded target).

const MAX_SPAWNS_PER_TICK = 20; // bounds work per sweep across all schedules; the cursor keeps the rest for next tick
const MAX_CLOCK_SKEW_MS = 5 * 60_000; // a cursor further than this ahead of now is a bad-clock artifact and is rewound
const BREAKER_ALERT_AFTER = 5;
const BREAKER_PAUSE_AFTER = 20; // consecutive failed fires before the schedule is auto-paused (one alert)
const BREAKER_MAX_BACKOFF_MS = 3_600_000;
// Self-DoS guards for agent-created schedules (operators are exempt): at most this many live schedules per
// agent, with an explicit wake-rate floor matching the current minute-resolution cron format. Keeping this as
// policy makes any future seconds-resolution support opt-in for autonomous wakeups; it is not a capacity limit.
export const MAX_AGENT_SCHEDULES = 5;
export const MIN_AGENT_INTERVAL_MS = 60_000;
const INTERVAL_PROBE_FIRES = 24; // consecutive upcoming fires inspected for the minimum gap

export interface CronExtensionOptions {
  schedules: ScheduleStore;
  cronTickMs: number; // the tick interval, still Limits.cronTickMs (passed through the constructor)
  rootId(): Promise<AgentId>; // the root supervisor id (creates it lazily, like Daemon.root())
  // Carried spawn parameters ride on the intent; the host maps them onto SpawnRequest (daemon's spawn path, root as requester).
  spawnRootChild(
    intent: SpawnIntent & { deadlineMs?: number; template?: string; model?: { provider: string; id: string } },
    idempotencyKey: string,
  ): Promise<AgentRecord>;
  // Targeted fires. steerAgent queues `body` as an operator-style message (Daemon.messageAgent, mode queue: a
  // running or waiting agent picks it up as a steer); wakeAgent resumes a yielded agent with `body` as the wake
  // message (Daemon.resumeAgent, admission applies). Both are idempotent by key. pendingSignals peeks the target's
  // mailbox (the unconsumed check for overlap).
  steerAgent(agent: AgentId, body: string, idempotencyKey: string): Promise<unknown>;
  wakeAgent(agent: AgentId, body: string, idempotencyKey: string): Promise<unknown>;
  pendingSignals(agent: AgentId): Promise<Signal[]>;
  models?: { list(): Promise<{ source: string; models: { provider: string; id: string }[] }> }; // validates `model` like the spawn route
}

function err(e: unknown): ExtensionResponse {
  if (e instanceof LifecycleError) return { status: e.status, body: { error: e.message, ...e.extra } };
  if (e instanceof StaleGenerationError) return { status: 409, body: { error: e.message } };
  console.error(`pomtreed: cron internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  return { status: 500, body: { error: "internal error" } };
}

// Host conditions that clear on their own (drain, degraded store, resource gate, rate/budget holds): a
// fire that hits one stays due and is retried next tick; it must not feed the spawn-failure breaker.
const isTransient = (e: unknown): boolean =>
  e instanceof SandboxUnavailableError || (e instanceof LifecycleError && (e.status === 503 || e.status === 429 || e.status === 402));

// Small validators kept local so the extension owns its route logic.
const obj = (body: unknown): Record<string, unknown> => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new LifecycleError(400, "body must be a JSON object");
  return body as Record<string, unknown>;
};
// Every mutating route carries an idempotency key (SPEC design rule 4): in the body, or in `?key=` for a bodyless DELETE.
const idemKey = (o: Record<string, unknown>): string => {
  const v = o.idempotencyKey;
  if (typeof v !== "string" || !v) throw new LifecycleError(400, IDEMPOTENCY_KEY_REQUIRED);
  return v;
};

const str = (o: Record<string, unknown>, k: string, required = true): string | undefined => {
  const v = o[k];
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || !v) throw new LifecycleError(400, `${k} must be a non-empty string`);
  return v;
};
const num = (v: unknown, what: string): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new LifecycleError(400, `${what} must be a non-negative number`);
  return n;
};
const oneOf = <T extends string>(v: unknown, what: string, allowed: readonly T[], fallback: T): T => {
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new LifecycleError(400, `${what} must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
};

const steerBody = (s: Schedule): string => `Scheduled wakeup (schedule ${s.id}): ${s.task}`;
// Throws a 400 for a tz Intl cannot resolve (an invalid zone would otherwise throw a RangeError on every sweep).
const checkTz = (tz: string | undefined): void => {
  if (tz === undefined) return;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new LifecycleError(400, `invalid tz: ${tz} is not a known IANA time zone`);
  }
};
const posInt = (v: unknown, what: string): number | undefined => {
  const n = num(v, what);
  if (n !== undefined && (!Number.isInteger(n) || n <= 0)) throw new LifecycleError(400, `${what} must be a positive integer`);
  return n;
};

export function createCronExtension(opts: CronExtensionOptions): Extension & { sweep(): Promise<void> } {
  let host: ExtensionHost | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const deps = () => {
    if (!host) throw new Error("cron extension used before init");
    return host.deps;
  };

  // Derivable cache (not schedule state): one CronSchedule per id, rebuilt when cron/tz change.
  const cache = new Map<ScheduleId, CronSchedule>();
  const cronFor = (s: Schedule): CronSchedule => {
    const c = cache.get(s.id);
    if (c && c.expr === s.cron && c.tz === (s.tz ?? "UTC")) return c;
    const n = new CronSchedule(s.cron, s.tz !== undefined ? { tz: s.tz } : {});
    cache.set(s.id, n);
    return n;
  };

  // A targeted schedule whose agent is gone. A schedule the agent made for itself is simply removed; anything
  // else is kept (flagged `orphaned`, so it stops firing until retargeted or removed) and alerted exactly once.
  const orphan = async (s: Schedule, state: string): Promise<void> => {
    if (s.createdBy !== undefined && s.createdBy === s.agent) {
      await opts.schedules.remove(s.id);
      return;
    }
    await opts.schedules.setOrphaned(s.id, `cron:${s.id}:orphaned:${s.agent}`);
    await deps().record(
      null,
      "error",
      {
        message: `cron schedule ${s.id} orphaned: target agent ${s.agent} is ${state}; it will not fire until retargeted (pomtree sched add --agent ID) or removed`,
      },
      `cron:${s.id}:orphaned:${s.agent}`,
    );
  };

  // Circuit breaker: the failure counter and retryAt live in the ScheduleStore (durable across restarts);
  // after BREAKER_PAUSE_AFTER consecutive failures the schedule is auto-paused with one alert.
  // TODO(cron-breaker): per-day root budget windows are not implemented (needs daemon spend data).
  // One schedule's due-fire enumeration, isolated so sweep can catch per-schedule failures. The cursor is
  // the store's lastFired (or the schedule's createdAt for a never-fired schedule), advanced only AFTER a
  // fire's spawn succeeds (or is deliberately skipped), so a failed spawn is retried on the next tick; the
  // deterministic taskKey makes a crash between spawn and cursor write converge to one root child.
  // Jitter is a durable due-gate (a fire is due at t + jitter), so no timer is held on the sweep loop.
  const sweepSchedule = async (s: Schedule, rootId: AgentId, now: number, counter: { spawns: number }): Promise<void> => {
    const d = deps();
    if (s.paused || s.orphaned) return;
    if (s.retryAt !== undefined && now < s.retryAt) return;
    const cursor = (await opts.schedules.lastFired(s.id)) ?? s.createdAt;
    if (cursor > now + MAX_CLOCK_SKEW_MS) {
      // The cursor was advanced by a clock that was far ahead (bad RTC at boot). Rewind it to now and say so once.
      // No re-fire risk: everything up to the old cursor was settled under the bad clock, and the rewound cursor
      // only makes occurrences after `now` due, which have not fired. Occurrences between the true last fire and
      // `now` are skipped (never replayed), stricter than the missed policy.
      await opts.schedules.setLastFired(s.id, now, `cron:${s.id}:${cursor}:rewind:${now}`);
      await d.record(
        null,
        "error",
        { message: `cron schedule ${s.id}: last fire was ${cursor - now}ms in the future (clock stepped back); cursor rewound to now` },
        `cron:${s.id}:${cursor}:clock-rewind:${now}`,
      );
      return;
    }
    if (cursor > now) {
      // Small backward clock step: nothing is due until time catches up. Say so once per cursor value.
      await d.record(
        null,
        "error",
        {
          message: `cron schedule ${s.id}: clock is ${cursor - now}ms behind its last fire; no fires until it catches up`,
        },
        `cron:${s.id}:${cursor}:clock-back`,
      );
      return;
    }
    try {
      checkTz(s.tz);
    } catch (e) {
      // A persisted bad tz can never fire: pause once (durable) and alert once instead of failing every tick.
      await opts.schedules.setPaused(s.id, true, `cron:${s.id}:badtz:${s.tz}:${now}`);
      await d.record(null, "error", { message: `cron schedule ${s.id} auto-paused: ${(e as Error).message}` }, `cron:${s.id}:badtz:${s.tz}:${now}`);
      return;
    }
    const jitterMs = jitterFor(s.id, s.jitterMs);
    const sched = cronFor(s);
    const effNow = now - jitterMs;
    // The newest due fire is always on-time; older fires are "missed". Enumerate from the newest due
    // fire (never the oldest) so DEFAULT_MAX_CATCH_UP bounds how many MISSED fires we catch up without
    // ever demoting a stale fire to "on-time" after an outage longer than the cap.
    const newest = sched.prevFire(effNow + 1);
    if (newest === null || newest <= cursor) return;
    const all: number[] = [newest];
    for (let t = newest; all.length < DEFAULT_MAX_CATCH_UP; ) {
      const p = sched.prevFire(t);
      if (p === null || p <= cursor) break;
      all.unshift(p);
      t = p;
    }
    const onTime = all.slice(-1);
    const missed = all.slice(0, -1);
    const keptMissed = s.missed === "skip" ? [] : s.missed === "run-one" ? missed.slice(-1) : missed;
    const fires = [...keptMissed, ...onTime]; // ascending
    // Overlap: skip when ANY non-terminal child of the root is named for this schedule.
    const running = async (): Promise<boolean> =>
      (await d.listAgents()).some((a) => a.parent === rootId && a.name === s.id && (a.state === "pending" || a.state === "running" || a.state === "yielded"));
    for (const t of fires) {
      let target: AgentRecord | null = null;
      let busy: boolean;
      if (s.agent !== undefined) {
        target = await d.getAgent(s.agent);
        if (!target || target.state === "exited" || target.state === "reaped") {
          await orphan(s, target?.state ?? "unknown");
          return;
        }
        // A yielded target is woken at once; otherwise the previous steer is still in flight while it sits in the mailbox.
        busy = target.state !== "yielded" && (await opts.pendingSignals(target.id)).some((x) => x.kind === "human_message" && x.body === steerBody(s));
      } else busy = await running();
      // overlap "queue": hold the cursor (the fire stays due, durably) until the previous run is terminal,
      // then fire one at a time. Fires older than the catch-up cap or `missed` policy are dropped as usual.
      if (s.overlap === "queue" && busy) return;
      if (onFire(s.overlap, busy) !== "skip") {
        if (counter.spawns >= MAX_SPAWNS_PER_TICK) return; // cursor stays; the rest is picked up next tick
        try {
          if (target) {
            // The key is the fire's task key, so a retried fire is a recognized duplicate and never double-steers.
            if (target.state === "yielded") await opts.wakeAgent(target.id, steerBody(s), taskKey(s.id, t));
            else await opts.steerAgent(target.id, steerBody(s), taskKey(s.id, t));
          } else {
            await opts.spawnRootChild(
              {
                name: s.id,
                task: s.task,
                ...(s.budgetMicros !== undefined && { budgetMicros: s.budgetMicros }),
                ...(s.deadlineMs !== undefined && { deadlineMs: s.deadlineMs }),
                ...(s.template !== undefined && { template: s.template }),
                ...(s.model !== undefined && { model: s.model }),
              },
              taskKey(s.id, t),
            );
          }
        } catch (e) {
          if (isTransient(e)) return; // cursor and breaker untouched; retried next tick
          // The target changed state under the fire (resumed, exited): re-evaluated next tick, not a breaker failure.
          if (target && e instanceof LifecycleError && (e.status === 404 || e.status === 409)) return;
          const failures = (s.failures ?? 0) + 1;
          const backoff = Math.min(opts.cronTickMs * 2 ** failures, BREAKER_MAX_BACKOFF_MS);
          await opts.schedules.recordFailure(s.id, now + backoff, `cron:${s.id}:${now}:fail`);
          const msg = e instanceof LifecycleError ? e.message : "internal error";
          if (failures >= BREAKER_PAUSE_AFTER) {
            await opts.schedules.setPaused(s.id, true, `cron:${s.id}:${now}:autopause`);
            await d.record(
              null,
              "error",
              {
                message: `cron schedule ${s.id} auto-paused after ${failures} consecutive spawn failures (last: ${msg}); resume with pomtree sched resume ID`,
              },
              `cron:${s.id}:autopause:${failures}`,
            );
          } else if (failures <= BREAKER_ALERT_AFTER) {
            const open = failures === BREAKER_ALERT_AFTER ? `; circuit open, probing every ${BREAKER_MAX_BACKOFF_MS}ms` : "";
            await d.record(
              null,
              "error",
              {
                message: `cron schedule ${s.id} spawn failed (${failures}): ${msg}${open}`,
              },
              `cron:${s.id}:${now}:spawn-fail`,
            );
          }
          return; // not a thrown error: already reported once, and the sweep must not report it again
        }
        counter.spawns++;
        if (s.failures) await opts.schedules.clearFailures(s.id, `cron:${s.id}:${t}:ok`);
      }
      // Spawned or overlap-skipped: this fire is settled. Never move the cursor backward.
      await opts.schedules.setLastFired(s.id, t, taskKey(s.id, t));
    }
  };

  // Sweeps are chained: overlapping ticks would both see "not busy" and double-spawn under overlap "queue".
  let chain: Promise<void> = Promise.resolve();
  function sweep(): Promise<void> {
    const run = chain.then(sweepOnce, sweepOnce);
    chain = run.catch(() => {});
    return run;
  }
  async function sweepOnce(): Promise<void> {
    const d = deps();
    const rootId = await opts.rootId();
    const now = d.now();
    const counter = { spawns: 0 };
    for (const s of await opts.schedules.list()) {
      // One throwing schedule must not starve the rest: record the failure and keep sweeping.
      try {
        await sweepSchedule(s, rootId, now, counter);
      } catch (e) {
        await d.record(
          null,
          "error",
          {
            message: `cron schedule ${s.id} failed: ${e instanceof Error ? e.message : String(e)}`,
          },
          `cron:${s.id}:error:${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  return {
    manifest: {
      name: "cron",
      entry: "builtin",
      store: { name: "schedules" },
      capabilities: { routes: true, journalKinds: true, hooks: { journal: true } },
      deps: ["registry", "record"],
    },
    init(h) {
      host = h;
      h.journalKind({
        kind: "error",
        validate: (d) => {
          if (typeof d !== "object" || d === null || Array.isArray(d)) return "error data must be an object";
          if (typeof (d as Record<string, unknown>).message !== "string") return "error.message must be a string";
          return true;
        },
      });

      // Authority: an operator manages any schedule; an agent (live, current generation) manages only schedules
      // targeting itself, and the target comes from its credential, never the body. Pause/resume stay operator-only.
      type Caller = { agent?: undefined } | { agent: AgentId };
      const callerOf = async (req: ExtensionRequest): Promise<Caller> => {
        const p = principalOf(req);
        if (p?.scope === "operator") return {};
        if (p?.scope !== "agent") throw new LifecycleError(403, "operator or agent scope required");
        const me = await deps().getAgent(p.agent);
        if (!me || me.generation !== p.generation) throw new LifecycleError(409, "stale agent credential");
        if (me.state !== "running") throw new LifecycleError(409, `agent is ${me.state}, not running`);
        return { agent: p.agent };
      };
      const ownedBy = (s: Schedule, agent: AgentId): boolean => s.agent === agent && s.createdBy === agent;
      // No two of the next INTERVAL_PROBE_FIRES fires may be closer than MIN_AGENT_INTERVAL_MS.
      const checkMinInterval = (cron: string, tz: string | undefined): void => {
        const c = new CronSchedule(cron, tz !== undefined ? { tz } : {});
        let t = deps().now();
        let prev: number | null = null;
        for (let i = 0; i < INTERVAL_PROBE_FIRES; i++) {
          const n = c.nextFire(t);
          if (n === null) return;
          if (prev !== null && n - prev < MIN_AGENT_INTERVAL_MS) {
            const minutes = MIN_AGENT_INTERVAL_MS / 60_000;
            throw new LifecycleError(400, `agent self-wake schedules must fire at least ${minutes} minute${minutes === 1 ? "" : "s"} apart`);
          }
          prev = t = n;
        }
      };

      for (const scope of [{ kind: "operator" }, { kind: "agent" }] as const) {
        h.route({
          method: "GET",
          path: "/v1/schedules",
          scope,
          handler: async (req) => {
            try {
              const c = await callerOf(req);
              const all = await opts.schedules.list();
              return { status: 200, body: c.agent === undefined ? all : all.filter((s) => s.agent === c.agent) };
            } catch (e) {
              return err(e);
            }
          },
        });

        // PUT is a full replace, so the client issues a fresh idempotency key per invocation (never one derived from the
        // content, which would let A→B→A silently replay A and leave B); a retry with the same key replays the first result.
        h.route({
          method: "PUT",
          path: "/v1/schedules/:id",
          scope,
          handler: async (req) => {
            try {
              const c = await callerOf(req);
              const id = req.params.id!;
              const b = obj(req.body);
              const key = idemKey(b);
              const cron = str(b, "cron")!;
              try {
                parseCron(cron);
              } catch (e) {
                throw new LifecycleError(400, `invalid cron: ${e instanceof Error ? e.message : String(e)}`);
              }
              const tz = str(b, "tz", false);
              checkTz(tz);
              const task = str(b, "task")!;
              const missed = oneOf(b.missed, "missed", ["skip", "run-one", "catch-up"] as const, "skip");
              const overlap = oneOf(b.overlap, "overlap", ["skip", "queue"] as const, "skip");
              const jitterMs = num(b.jitterMs, "jitterMs") ?? 0;
              let agent = str(b, "agent", false);
              const budgetMicros = posInt(b.budgetMicros, "budgetMicros");
              const deadlineMs = posInt(b.deadlineMs, "deadlineMs");
              const template = str(b, "template", false);
              let model: { provider: string; id: string } | undefined;
              if (b.model !== undefined) {
                const mo = obj(b.model);
                model = { provider: str(mo, "provider")!, id: str(mo, "id")! };
                const cat = opts.models ? await opts.models.list() : undefined;
                if (cat && cat.source !== "none" && !cat.models.some((x) => x.provider === model!.provider && x.id === model!.id)) {
                  throw new LifecycleError(400, `unknown model: ${model.provider}/${model.id}`);
                }
              }
              if (c.agent !== undefined) {
                if (agent !== undefined && agent !== c.agent) throw new LifecycleError(403, "an agent may schedule only itself");
                agent = c.agent;
                const existing = await opts.schedules.get(id);
                if (existing && !ownedBy(existing, c.agent)) throw new LifecycleError(403, "an agent may change only its own schedules");
                const mine = (await opts.schedules.list()).filter((s) => s.createdBy === c.agent && s.id !== id).length;
                if (mine >= MAX_AGENT_SCHEDULES) throw new LifecycleError(429, `an agent may have at most ${MAX_AGENT_SCHEDULES} schedules`);
                checkMinInterval(cron, tz);
              } else if (agent !== undefined) {
                const target = await deps().getAgent(agent);
                if (!target) throw new LifecycleError(404, `no such agent: ${agent}`);
                if (target.state === "exited" || target.state === "reaped") throw new LifecycleError(409, `agent ${agent} is ${target.state}`);
              }
              if (agent !== undefined && (budgetMicros !== undefined || deadlineMs !== undefined || template !== undefined || model !== undefined)) {
                throw new LifecycleError(400, "budgetMicros, deadlineMs, template and model apply only to spawning schedules (no agent target)");
              }
              const fields = {
                cron,
                ...(tz !== undefined && { tz }),
                task,
                missed,
                overlap,
                jitterMs,
                ...(agent !== undefined && { agent }),
                ...(c.agent !== undefined && { createdBy: c.agent }),
                ...(budgetMicros !== undefined && { budgetMicros }),
                ...(deadlineMs !== undefined && { deadlineMs }),
                ...(template !== undefined && { template }),
                ...(model !== undefined && { model }),
              };
              return { status: 200, body: await opts.schedules.upsert({ id, ...fields }, key) };
            } catch (e) {
              return err(e);
            }
          },
        });

        h.route({
          method: "DELETE",
          path: "/v1/schedules/:id",
          scope,
          handler: async (req) => {
            try {
              const c = await callerOf(req);
              if (c.agent !== undefined) {
                const existing = await opts.schedules.get(req.params.id!);
                if (existing && !ownedBy(existing, c.agent)) throw new LifecycleError(403, "an agent may remove only its own schedules");
              }
              return { status: 200, body: { removed: await opts.schedules.remove(req.params.id!) } };
            } catch (e) {
              return err(e);
            }
          },
        });
      }

      // An agent's own schedules die with it. Must not throw (a throwing hook is disabled); the sweep's
      // orphan check is the backstop if an exit entry is missed.
      h.onJournal(async (e) => {
        if (e.agent === null || e.payload.kind !== "exited") return;
        try {
          for (const s of await opts.schedules.list()) if (ownedBy(s, e.agent)) await opts.schedules.remove(s.id);
        } catch (er) {
          h.log(`cron: removing schedules of exited agent ${e.agent} failed: ${er instanceof Error ? er.message : String(er)}`);
        }
      });

      // Pause/resume: the idempotency key comes from the body (a retry replays the same transition); resume
      // also clears the breaker (ScheduleStore.setPaused contract). 404 for an unknown schedule.
      for (const [action, paused] of [
        ["pause", true],
        ["resume", false],
      ] as const) {
        h.route({
          method: "POST",
          path: `/v1/schedules/:id/${action}`,
          scope: { kind: "operator" },
          handler: async (req) => {
            try {
              const key = idemKey(obj(req.body));
              const s = await opts.schedules.setPaused(req.params.id!, paused, key);
              if (!s) throw new LifecycleError(404, `no such schedule: ${req.params.id}`);
              return { status: 200, body: s };
            } catch (e) {
              return err(e);
            }
          },
        });
      }
    },
    async start() {
      if (timer) return;
      timer = setInterval(() => {
        void sweep().catch((e) => host?.log(`cron sweep failed: ${e instanceof Error ? e.message : String(e)}`));
      }, opts.cronTickMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    sweep,
  };
}
