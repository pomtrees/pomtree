import { createHash } from "node:crypto";
import { IdempotencyConflictError, LOOPBACK_PORTS, SANDBOX_CAPABILITIES, SandboxOutcomeUnknownError, SandboxUnavailableError } from "@pomtree/core";
import type { ByteChannel, ByteStream, ProbeResult, Sandbox, SandboxFacets, SandboxHandle, SandboxId, SandboxListing, SandboxSpec } from "@pomtree/core";
import type { ClauseId, FakeUnderTestOptions, SandboxConformanceHooks } from "./sandbox-conformance.ts";

// Negative controls for the Sandbox conformance suite. `brokenSandbox(inner, mode)` wraps a correct sandbox and violates exactly one
// contract, so a test can show that each clause in `SANDBOX_CONFORMANCE_CLAUSES` is capable of failing. `BREAK_MODES` is keyed by
// clause id and typed `satisfies Record<ClauseId, BreakMode>`: a clause added without a mode stops this file compiling
// (`sandbox-broken-missing-mode.fixture.ts` proves that with `tsconfig.negative.json`).

// A check other than a clause that a mode can legitimately trip.
export type CollateralId = ClauseId | "declaration" | "probe";

// State a mode needs from the test world that the Sandbox port cannot carry (the simulated engine behind the api-version pin).
export interface BreakEnv {
  engine?: SimulatedEngine;
  provider?: SimulatedProvider;
}

// How to run a clause whose descriptor opt-in the shared fake does not meet: a correct reference layer over the fake, and the
// descriptor options that switch the clause on. The mode then breaks the reference layer.
export interface BreakEnable {
  reference(inner: Sandbox, env: BreakEnv): Sandbox;
  descriptor(env: BreakEnv): Pick<FakeUnderTestOptions, "startConflict" | "engineApiVersion" | "hooks">;
}

// One way to violate a clause.
export interface BreakVariant {
  // The mode's stable name, used by `brokenSandbox` and printed in test names.
  name: string;
  // Other checks that fail when this mode runs, because the broken behavior is inherently shared with them.
  collateral: readonly CollateralId[];
  // Text the named clause's failure message must contain: the assertion this mode is meant to trip, so a harness glitch that fails the
  // right clause for another reason cannot pass.
  fails: RegExp;
  wrap(inner: Sandbox, env: BreakEnv): Sandbox;
}

// The clause's primary mode. A clause whose check holds several assertions where the first one would hide the rest lists a further
// variant per hidden assertion in `also`, so each assertion is shown capable of failing.
export interface BreakMode extends BreakVariant {
  also?: readonly BreakVariant[];
  // Present for clauses the fake skips by default.
  enable?: BreakEnable;
}

// ---- helpers ----

type Override = { [K in keyof Sandbox]?: Sandbox[K] };

// The sandbox with some members replaced. Everything else stays bound to the inner sandbox so a fake's private state still works.
function decorate(inner: Sandbox, over: Override): Sandbox {
  return new Proxy(inner, {
    get(target, p) {
      if (typeof p === "string" && Object.hasOwn(over, p)) return over[p as keyof Override];
      const v = Reflect.get(target, p, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const rewrap = (h: SandboxHandle, wait: SandboxHandle["wait"]): SandboxHandle => ({ id: h.id, output: () => h.output(), wait });

// Applies `change` to the handle every start and attach returns.
function handles(inner: Sandbox, change: (h: SandboxHandle) => SandboxHandle): Override {
  return {
    start: async (spec, key) => change(await inner.start(spec, key)),
    attach: async (id, agent) => change(await inner.attach(id, agent)),
  };
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
async function* once(b: Uint8Array): AsyncGenerator<Uint8Array> {
  yield b;
}

// Reads a body to the end; `error` is what it threw, with the bytes read until then.
async function collect(body: AsyncIterable<Uint8Array>): Promise<{ data: Buffer; error?: unknown }> {
  const parts: Uint8Array[] = [];
  try {
    for await (const c of body) parts.push(c);
  } catch (error) {
    return { data: Buffer.concat(parts), error };
  }
  return { data: Buffer.concat(parts) };
}

function facetOf<K extends keyof SandboxFacets>(inner: Sandbox, name: K, mode: string): NonNullable<SandboxFacets[K]> {
  const f = inner[name];
  if (f === undefined || f === null) {
    throw new Error(
      `break mode ${mode} needs a sandbox with the ${name} facet, but this one has none; run it over a sandbox that declares it (the remote fake)`,
    );
  }
  return f as NonNullable<SandboxFacets[K]>;
}

// ---- reference layers and the engine simulator (correct behavior the shared fake lacks, for clauses it skips) ----

// A start whose key is reused for a different spec throws IdempotencyConflictError and creates nothing; the same spec replays.
export function conflictingSandbox(inner: Sandbox): Sandbox {
  const seen = new Map<string, string>();
  return decorate(inner, {
    start: async (spec, key) => {
      const fingerprint = JSON.stringify(spec);
      const prior = seen.get(key);
      if (prior !== undefined && prior !== fingerprint) throw new IdempotencyConflictError("sandbox start", key);
      const h = await inner.start(spec, key);
      seen.set(key, fingerprint); // only a start that succeeded claims the key
      return h;
    },
  });
}

// attach() of a sandbox that belongs to another backend fails naming both backends.
export function foreignRefusingSandbox(inner: Sandbox, foreign: { id: SandboxId; backend: string }): Sandbox {
  return decorate(inner, {
    attach: async (id, agent) => {
      if (id !== foreign.id) return inner.attach(id, agent);
      throw new Error(
        `sandbox ${id} belongs to backend ${foreign.backend}, but the active backend is ${inner.declaration.backend}; switch sandbox.backend to ${foreign.backend} or start a new sandbox`,
      );
    },
  });
}

// A Docker-API-family engine as the client sees it: the client's pinned API version decides which calls the engine accepts.
export class SimulatedEngine {
  static readonly NEWEST = "1.50";
  static readonly NEWER_ONLY_FROM = "1.44";
  clientVersion: string = SimulatedEngine.NEWEST;
  pin(version: string): void {
    this.clientVersion = version;
  }
  unpin(): void {
    this.clientVersion = SimulatedEngine.NEWEST;
  }
  apiVersion(): string {
    return this.clientVersion;
  }
  async newerOnlyCall(): Promise<void> {
    const minor = (v: string) => Number(v.split(".")[1]);
    if (minor(this.clientVersion) < minor(SimulatedEngine.NEWER_ONLY_FROM)) {
      throw new Error(`engine refused: API version ${this.clientVersion} predates ${SimulatedEngine.NEWER_ONLY_FROM}, which this call needs`);
    }
  }
}

// The client pins `version` on every call it makes (start and list).
export function pinnedEngineSandbox(inner: Sandbox, engine: SimulatedEngine, version: string): Sandbox {
  return decorate(inner, {
    start: async (spec, key) => {
      engine.pin(version);
      return inner.start(spec, key);
    },
    list: async (owner) => {
      engine.pin(version);
      return inner.list(owner);
    },
  });
}

// What a provider sees of an adapter, as the hooks `requests` and `secrets` report it: the User-Agent of each request and the
// environment of each create. The provider stub plays this part for a real adapter; here the reference layer below feeds it.
type ProviderHooks = Required<Pick<SandboxConformanceHooks, "requests" | "secrets">>;
export const FETCH_USER_AGENT = "pomtree";
export class SimulatedProvider {
  // The User-Agent the reference layer stamps on the next request (a mode clears it for the calls it breaks).
  userAgent: string | undefined = FETCH_USER_AGENT;
  // Whether the reference layer records the create-time environment (a mode turns it off: the provider never saw one).
  recordEnv = true;
  // Whether the reference layer puts the planted secret in the create-time environment (the sandbox.secretsInEnv behavior).
  secretsInEnv = false;
  // A mode sets this to leak the planted secret into the environment although secretsInEnv is off.
  leak = false;
  // With leak on, the secret goes in an environment variable NAME instead of a value.
  leakInKey = false;
  planted: string | undefined;
  readonly requests: (string | undefined)[] = [];
  readonly createEnv = new Map<SandboxId, Record<string, string>>();
  hooks(): ProviderHooks {
    return providerHooks(() => this);
  }
}

export function providerHooks(get: () => SimulatedProvider): ProviderHooks {
  return {
    requests: { expectedUserAgent: FETCH_USER_AGENT, observe: () => get().requests },
    secrets: {
      // Read when the clause runs, so each world reports the lane's setting.
      get secretsInEnv() {
        return get().secretsInEnv;
      },
      plant: (sentinel) => {
        get().planted = sentinel;
      },
      createEnv: (id) => get().createEnv.get(id),
    },
  };
}

// A correct adapter as the provider sees it: every request carries the configured User-Agent; the planted secret stays out of the
// create-time environment unless secretsInEnv is on; the create-time environment is the spec's.
export function providerSandbox(inner: Sandbox, provider: SimulatedProvider): Sandbox {
  const seen = <T>(call: () => Promise<T>) => {
    provider.requests.push(provider.userAgent);
    return call();
  };
  return decorate(inner, {
    start: (spec, key) =>
      seen(async () => {
        const h = await inner.start(spec, key);
        if (provider.recordEnv) {
          const planted = provider.secretsInEnv || provider.leak ? provider.planted : undefined;
          const secret = planted === undefined ? {} : provider.leakInKey ? { [`CONFORMANCE_${planted}`]: "x" } : { CONFORMANCE_SECRET: planted };
          provider.createEnv.set(h.id, { ...spec.env, ...secret });
        }
        return h;
      }),
    attach: (id, agent) => seen(() => inner.attach(id, agent)),
    list: (owner) => seen(() => inner.list(owner)),
    stop: (id, graceMs, key) => seen(() => inner.stop(id, graceMs, key)),
    kill: (id, key) => seen(() => inner.kill(id, key)),
  });
}

// Runs `call` with one provider field changed, then restores it.
async function withProvider<T>(
  provider: SimulatedProvider,
  change: Partial<Pick<SimulatedProvider, "userAgent" | "recordEnv" | "leak" | "leakInKey">>,
  call: () => Promise<T>,
) {
  const prior = { ...provider };
  Object.assign(provider, change);
  try {
    return await call();
  } finally {
    Object.assign(provider, { userAgent: prior.userAgent, recordEnv: prior.recordEnv, leak: prior.leak, leakInKey: prior.leakInKey });
  }
}

const providerOf = (env: BreakEnv, mode: string): SimulatedProvider => {
  if (env.provider === undefined)
    throw new Error(`break mode ${mode} needs the simulated provider, but none was passed; pass newBreakEnv() as the third argument`);
  return env.provider;
};

export const FOREIGN_RECORD = { id: "sandbox-of-another-backend", backend: "other-backend" } as const;
const PINNED_VERSION = "1.41";

export function newBreakEnv(): BreakEnv {
  return { engine: new SimulatedEngine(), provider: new SimulatedProvider() };
}

const engineOf = (env: BreakEnv, mode: string): SimulatedEngine => {
  if (env.engine === undefined)
    throw new Error(`break mode ${mode} needs the simulated engine, but no engine was passed; pass newBreakEnv() as the third argument`);
  return env.engine;
};

// ---- the break modes, one per clause ----

export const BREAK_MODES = {
  "lifecycle-run": {
    name: "swallow-exit-code",
    collateral: [],
    fails: /a killed sandbox exits 137/,
    // wait() reports 0 whatever the sandbox exited with.
    wrap: (inner) =>
      decorate(
        inner,
        handles(inner, (h) => rewrap(h, async () => ({ ...(await h.wait()), exitCode: 0 }))),
      ),
  },
  "attach-existing": {
    name: "attach-creates-new",
    collateral: [],
    fails: /attach must return the sandbox it was asked for/,
    // attach() of a sandbox this wrapper started starts another one from the same spec instead of adopting it.
    wrap: (inner) => {
      const specs = new Map<SandboxId, SandboxSpec>();
      let n = 0;
      return decorate(inner, {
        start: async (spec, key) => {
          const h = await inner.start(spec, key);
          specs.set(h.id, spec);
          return h;
        },
        attach: async (id, agent) => {
          const spec = specs.get(id);
          return spec === undefined ? inner.attach(id, agent) : inner.start(spec, `attach-creates-new-${++n}`);
        },
      });
    },
    also: [
      {
        name: "attach-also-creates",
        collateral: [],
        fails: /attach must not create a sandbox/,
        // attach() returns the right sandbox but starts another one from the same spec as a side effect.
        wrap: (inner) => {
          const specs = new Map<SandboxId, SandboxSpec>();
          let n = 0;
          return decorate(inner, {
            start: async (spec, key) => {
              const h = await inner.start(spec, key);
              specs.set(h.id, spec);
              return h;
            },
            attach: async (id, agent) => {
              const spec = specs.get(id);
              if (spec !== undefined) await inner.start(spec, `attach-also-creates-${++n}`);
              return inner.attach(id, agent);
            },
          });
        },
      },
    ],
  },
  "resolve-digest": {
    name: "digest-unpinned",
    collateral: [],
    fails: /one reference resolves to one identity/,
    // The engine-local id differs on every call for one reference.
    wrap: (inner) => {
      let n = 0;
      return decorate(inner, { imageIdentity: async (ref) => ({ ...(await inner.imageIdentity(ref)), engineLocalId: `unpinned-${++n}` }) });
    },
  },
  "label-rules": {
    name: "drop-labels",
    collateral: ["list-by-owner"],
    fails: /label "pomtree\.owner" must be rejected/,
    // start() discards the extra labels, so nothing is validated and list() cannot echo or filter on them.
    wrap: (inner) =>
      decorate(inner, {
        start: async (spec, key) => {
          const { labels: _dropped, ...rest } = spec;
          return inner.start(rest, key);
        },
      }),
    also: [
      {
        name: "skip-label-echo",
        collateral: [],
        fails: /list echoes the labels the sandbox was started with/,
        // Labels are validated and kept, but list() leaves them out of its listings.
        wrap: (inner) =>
          decorate(inner, {
            list: async (owner) => (await inner.list(owner)).map(({ labels: _dropped, ...rest }) => rest),
          }),
      },
    ],
  },
  "idempotent-start": {
    name: "forget-key",
    collateral: ["unknown-outcome-retry"],
    fails: /a repeated key must return the same sandbox/,
    // The second use of a key is sent under a fresh key, so a repeated start creates another sandbox.
    wrap: (inner) => {
      const seen = new Set<string>();
      let n = 0;
      return decorate(inner, {
        start: async (spec, key) => {
          const repeat = seen.has(key);
          seen.add(key);
          return inner.start(spec, repeat ? `${key}#forgotten-${++n}` : key);
        },
      });
    },
  },
  "idempotency-conflict": {
    name: "accept-conflict",
    collateral: [],
    fails: /Missing expected rejection \(IdempotencyConflictError\)/,
    // A reused key with a different spec silently returns the first sandbox instead of conflicting.
    wrap: (inner) => {
      const first = new Map<string, SandboxHandle>();
      return decorate(inner, {
        start: async (spec, key) => {
          try {
            const h = await inner.start(spec, key);
            if (!first.has(key)) first.set(key, h);
            return h;
          } catch (e) {
            const prior = first.get(key);
            if (e instanceof IdempotencyConflictError && prior !== undefined) return prior;
            throw e;
          }
        },
      });
    },
    enable: { reference: (inner) => conflictingSandbox(inner), descriptor: () => ({ startConflict: true }) },
  },
  "unknown-outcome-retry": {
    name: "double-create-on-retry",
    collateral: [],
    fails: /the retry resolves to the id the unknown-outcome error named/,
    // After a start threw an unknown outcome, the retry with that key goes out under a fresh key and creates a second sandbox.
    wrap: (inner) => {
      const unknown = new Set<string>();
      let n = 0;
      return decorate(inner, {
        start: async (spec, key) => {
          try {
            return await inner.start(spec, unknown.has(key) ? `${key}#retry-${++n}` : key);
          } catch (e) {
            if (e instanceof SandboxOutcomeUnknownError) unknown.add(key);
            throw e;
          }
        },
      });
    },
  },
  "unknown-outcome-reconcile": {
    name: "reconcile-misses-created",
    collateral: [],
    fails: /a create that took effect must be found by list\(owner\) exactly once/,
    // A sandbox whose create reported an unknown outcome is hidden from list() until a start returns it.
    wrap: (inner) => {
      const hidden = new Set<SandboxId>();
      return decorate(inner, {
        start: async (spec, key) => {
          try {
            const h = await inner.start(spec, key);
            hidden.delete(h.id);
            return h;
          } catch (e) {
            if (e instanceof SandboxOutcomeUnknownError) hidden.add(e.id);
            throw e;
          }
        },
        list: async (owner) => (await inner.list(owner)).filter((l) => !hidden.has(l.id)),
      });
    },
  },
  "list-by-owner": {
    name: "list-unfiltered",
    collateral: [],
    fails: /list\(owner\) must exclude another store's sandbox/,
    // list() adds every sandbox this wrapper started, including another owner's and a newer epoch's.
    wrap: (inner) => {
      const started = new Map<SandboxId, SandboxSpec>();
      return decorate(inner, {
        start: async (spec, key) => {
          const h = await inner.start(spec, key);
          started.set(h.id, spec);
          return h;
        },
        list: async (owner) => {
          const listed = await inner.list(owner);
          const have = new Set(listed.map((l) => l.id));
          const extra: SandboxListing[] = [...started]
            .filter(([id]) => !have.has(id))
            .map(([id, spec]) => ({
              id,
              agent: spec.agent,
              backend: inner.declaration.backend,
              host: null,
              generation: null,
              state: "running" as const,
              ...(spec.labels ? { labels: { ...spec.labels } } : {}),
            }));
          return [...listed, ...extra];
        },
      });
    },
  },
  "preemption-status": {
    name: "preempt-as-clean-exit",
    collateral: [],
    fails: /a preempted sandbox must not inspect as a clean exit/,
    // A preempted sandbox inspects as a clean exit.
    wrap: (inner) =>
      decorate(inner, {
        inspect: async (id) => {
          const st = await inner.inspect(id);
          return st?.status === "preempted" ? { running: false, exitCode: 0, status: "exited" } : st;
        },
      }),
    also: [
      {
        name: "preempt-wait-resolves",
        collateral: [],
        fails: /wait\(\) on a preempted sandbox must reject or report a non-zero exit/,
        // inspect() stays faithful, but wait() on a preempted sandbox resolves 0 instead of rejecting.
        wrap: (inner) =>
          decorate(
            inner,
            handles(inner, (h) => rewrap(h, () => h.wait().catch(() => ({ exitCode: 0 })))),
          ),
      },
    ],
  },
  "foreign-backend-record": {
    name: "foreign-record-not-found",
    collateral: [],
    fails: /a foreign sandbox must never be reported as gone/,
    // A refusal from attach() is reported as an unknown sandbox, hiding which backend owns it.
    wrap: (inner) =>
      decorate(inner, {
        attach: (id, agent) =>
          inner.attach(id, agent).catch((e: unknown) => {
            if (e instanceof SandboxUnavailableError) throw e;
            throw new SandboxUnavailableError("not-found");
          }),
      }),
    enable: {
      reference: (inner) => foreignRefusingSandbox(inner, FOREIGN_RECORD),
      descriptor: () => ({ hooks: { foreignRecord: () => ({ id: FOREIGN_RECORD.id, backend: FOREIGN_RECORD.backend }) } }),
    },
  },
  "stop-kill-keyed": {
    name: "gone-is-error",
    collateral: [],
    fails: /stop of a gone sandbox must succeed/,
    // stop() of a sandbox the backend does not know throws instead of succeeding. kill() stays correct: the runner's own cleanup kills
    // ids whose create never took effect, and a broken kill would fail unrelated clauses there.
    wrap: (inner) =>
      decorate(inner, {
        stop: async (id, graceMs, key) => {
          if ((await inner.inspect(id)) === null)
            throw new SandboxUnavailableError("not-found", `sandbox ${id} is unknown; stop of a gone sandbox must succeed`);
          return inner.stop(id, graceMs, key);
        },
      }),
  },
  "unsupported-capability-throws": {
    name: "unsupported-noop",
    fails: /the undeclared facet snapshots is present and must throw SandboxCapabilityError, not no-op/,
    // Collateral `declaration`: a facet present while its capability is undeclared also fails the facet-presence check.
    collateral: ["declaration"],
    // Every undeclared snapshot, pause, lease and image facet is present and does nothing instead of throwing.
    wrap: (inner) => {
      const noop: SandboxFacets = {
        snapshots: {
          create: async () => ({ id: "noop-snapshot", backend: inner.declaration.backend, memory: false }),
          start: async (_from, spec, key) => inner.start(spec, key),
          remove: async () => {},
        },
        pause: { pause: async () => {}, resume: async () => {} },
        lease: { extend: async (_id, untilMs) => ({ untilMs }) },
        images: { prepare: async (ref) => ({ providerImage: ref }) },
      };
      return decorate(inner, {
        snapshots: inner.snapshots ?? noop.snapshots,
        pause: inner.pause ?? noop.pause,
        lease: inner.lease ?? noop.lease,
        images: inner.images ?? noop.images,
      });
    },
  },
  "probe-subset": {
    name: "probe-widens-for-runtime",
    fails: /widens its declaration/,
    // probe-subset is redundant with probe-widening-fails: its variants (no runtime, runsc) are a strict subset of the other clause's, so no
    // probe fault is visible to this clause and hidden from that one. Tightening follow-up (clause table, not this file).
    collateral: ["probe-widening-fails"],
    // With the runsc runtime the probe withholds a capability the declaration never claimed.
    wrap: (inner) => widenFor(inner, "probe-widens-for-runtime", (rt) => rt?.ociRuntime === "runsc"),
  },
  "probe-widening-fails": {
    name: "probe-widens",
    collateral: [],
    fails: /widens its declaration/,
    // With the runc runtime, which only this clause tries, the probe withholds a capability the declaration never claimed.
    wrap: (inner) => widenFor(inner, "probe-widens", (rt) => rt?.ociRuntime === "runc"),
  },
  "api-version-pin": {
    name: "unpinned-newer-call",
    collateral: [],
    fails: /the client must pin the declared engine API version/,
    // After a start or list the client talks the newest API version, so a call only newer engines accept goes through.
    wrap: (inner, env) => {
      const engine = engineOf(env, "unpinned-newer-call");
      return decorate(inner, {
        start: async (spec, key) => {
          const h = await inner.start(spec, key);
          engine.unpin();
          return h;
        },
        list: async (owner) => {
          const l = await inner.list(owner);
          engine.unpin();
          return l;
        },
      });
    },
    enable: {
      reference: (inner, env) => pinnedEngineSandbox(inner, engineOf(env, "unpinned-newer-call"), PINNED_VERSION),
      // The hooks read the engine of the world being run when they are called, so each world has its own engine state.
      descriptor: (env) => ({
        engineApiVersion: PINNED_VERSION,
        hooks: {
          engine: {
            apiVersion: () => engineOf(env, "unpinned-newer-call").apiVersion(),
            newerOnlyCall: () => engineOf(env, "unpinned-newer-call").newerOnlyCall(),
          },
        },
      }),
    },
  },
  "channel-drop-throws": {
    name: "drop-as-eof",
    collateral: [],
    fails: /a dropped connect stream must make output\(\) throw, not end cleanly/,
    // A connect stream that breaks ends cleanly instead of throwing.
    wrap: (inner) => {
      const connect = facetOf(inner, "connect", "drop-as-eof");
      return decorate(inner, {
        connect: {
          open: async (id, channel) => {
            const c = await connect.open(id, channel);
            const eof: ByteChannel = {
              write: (data) => c.write(data),
              close: () => c.close(),
              closed: c.closed,
              output: async function* () {
                try {
                  yield* c.output();
                } catch {
                  // the break is swallowed: the reader sees a clean end
                }
              },
            };
            return eof;
          },
        },
      });
    },
  },
  "loopback-stream": {
    name: "loopback-any-port",
    collateral: [],
    fails: /a port outside LOOPBACK_PORTS must be a RangeError/,
    // The loopback facet opens whatever port it is asked for, so a port outside LOOPBACK_PORTS is accepted.
    wrap: (inner) => {
      const loopback = facetOf(inner, "loopback", "loopback-any-port");
      return decorate(inner, { loopback: { open: (id) => loopback.open(id, LOOPBACK_PORTS[0]) } });
    },
    also: [
      {
        name: "loopback-open-gone",
        collateral: [],
        fails: /an unknown sandbox must throw SandboxUnavailableError/,
        // Opening a stream on a sandbox that does not exist hands back an inert stream instead of throwing.
        wrap: (inner) => {
          const loopback = facetOf(inner, "loopback", "loopback-open-gone");
          return decorate(inner, {
            loopback: {
              open: async (id, port) => {
                if ((await inner.inspect(id)) !== null) return loopback.open(id, port);
                const inert: ByteStream = {
                  write: async () => {},
                  output: async function* () {},
                  close: () => {},
                  closed: Promise.resolve({ reason: "local" }),
                };
                return inert;
              },
            },
          });
        },
      },
      {
        name: "loopback-no-echo",
        collateral: [],
        fails: /the loopback stream must return what the port echoes/,
        // Written bytes never come back: the stream's output ends empty.
        wrap: (inner) => {
          const loopback = facetOf(inner, "loopback", "loopback-no-echo");
          return decorate(inner, {
            loopback: {
              open: async (id, port) => {
                const b = await loopback.open(id, port);
                return { write: (d) => b.write(d), output: async function* () {}, close: () => b.close(), closed: b.closed };
              },
            },
          });
        },
      },
    ],
  },
  "files-hash-mismatch": {
    name: "ignore-hash-mismatch",
    collateral: ["files-partial-upload"],
    fails: /Missing expected rejection \(SandboxTransferError\)/,
    // files-hash-mismatch and files-partial-upload overlap on the cut-stream case: an adapter sees only bytes and a hash, so a stream that
    // ends early is indistinguishable from a wrong hash. Tightening follow-up (clause table, not this file).
    // put() hashes what arrived and verifies against that, never against the caller's hash, so any bytes are accepted.
    wrap: (inner) => {
      const files = facetOf(inner, "files", "ignore-hash-mismatch");
      return decorate(inner, {
        files: {
          put: async (id, path, body, _sha256, key) => {
            const { data, error } = await collect(body);
            if (error !== undefined) throw error;
            return files.put(id, path, once(data), sha256(data), key);
          },
          get: (id, path, maxBytes) => files.get(id, path, maxBytes),
        },
      });
    },
  },
  "files-partial-upload": {
    name: "partial-reported-complete",
    collateral: [],
    fails: /Missing expected rejection \(isRealError\)/,
    // A stream that breaks mid-flight is read as finished: the bytes so far are accepted as the whole upload.
    wrap: (inner) => {
      const files = facetOf(inner, "files", "partial-reported-complete");
      return decorate(inner, {
        files: {
          put: async (id, path, body, declared, key) => {
            const { data, error } = await collect(body);
            return files.put(id, path, once(data), error === undefined ? declared : sha256(data), key);
          },
          get: (id, path, maxBytes) => files.get(id, path, maxBytes),
        },
      });
    },
  },
  "user-agent-stamped": {
    name: "drops-user-agent",
    collateral: [],
    fails: /without the configured User-Agent/,
    // Only start stamps the User-Agent; list, stop and kill go out without one.
    wrap: (inner, env) => {
      const provider = providerOf(env, "drops-user-agent");
      const bare =
        <A extends unknown[], R>(call: (...a: A) => Promise<R>) =>
        (...a: A) =>
          withProvider(provider, { userAgent: undefined }, () => call(...a));
      return decorate(inner, { list: bare(inner.list.bind(inner)), stop: bare(inner.stop.bind(inner)), kill: bare(inner.kill.bind(inner)) });
    },
    enable: {
      reference: (inner, env) => providerSandbox(inner, providerOf(env, "drops-user-agent")),
      // The hooks read the provider of the world being run when they are called.
      descriptor: (env) => ({ hooks: providerHooks(() => providerOf(env, "drops-user-agent")) }),
    },
  },
  "no-sentinel-in-env": {
    name: "sentinel-in-env",
    collateral: [],
    fails: /appears in the create-time environment variable\(s\)/,
    // The secret is put into the create-time environment although sandbox.secretsInEnv is off.
    wrap: (inner, env) => {
      const provider = providerOf(env, "sentinel-in-env");
      return decorate(inner, { start: (spec, key) => withProvider(provider, { leak: true }, () => inner.start(spec, key)) });
    },
    enable: {
      reference: (inner, env) => providerSandbox(inner, providerOf(env, "sentinel-in-env")),
      descriptor: (env) => ({ hooks: providerHooks(() => providerOf(env, "sentinel-in-env")) }),
    },
    also: [
      {
        name: "sentinel-in-env-key",
        collateral: [],
        fails: /appears in the create-time environment variable\(s\) CONFORMANCE_<secret>/,
        // The secret is in an environment variable's NAME, which a value-only scan would miss.
        wrap: (inner, env) => {
          const provider = providerOf(env, "sentinel-in-env-key");
          return decorate(inner, { start: (spec, key) => withProvider(provider, { leak: true, leakInKey: true }, () => inner.start(spec, key)) });
        },
      },
      {
        name: "env-never-set",
        collateral: [],
        fails: /could not be observed/,
        // The provider never sees a create-time environment, so a leak would be invisible: the clause must fail, not pass vacuously.
        wrap: (inner, env) => {
          const provider = providerOf(env, "env-never-set");
          return decorate(inner, { start: (spec, key) => withProvider(provider, { recordEnv: false }, () => inner.start(spec, key)) });
        },
      },
    ],
  },
} as const satisfies Record<ClauseId, BreakMode>;

// A probe that withholds a capability the declaration does not claim, for the runtimes `when` selects.
function widenFor(inner: Sandbox, mode: string, when: (runtime: Parameters<NonNullable<Sandbox["probe"]>>[0]) => boolean): Sandbox {
  const probe = inner.probe;
  if (probe === undefined) throw new Error(`break mode ${mode} needs a sandbox with a probe(), but this one has none; run it over a sandbox that has one`);
  const unclaimed = SANDBOX_CAPABILITIES.find((c) => inner.declaration.capabilities[c] !== true);
  if (unclaimed === undefined) throw new Error(`break mode ${mode} needs a declaration with one capability that is false, but every capability is declared`);
  return decorate(inner, {
    probe: async (runtime): Promise<ProbeResult> => {
      const r = await probe.call(inner, runtime);
      return when(runtime) ? { ...r, withheld: [...r.withheld, unclaimed] } : r;
    },
  });
}

type Entry = (typeof BREAK_MODES)[ClauseId];
type VariantNames<E> = E extends { also: readonly (infer V)[] } ? (V extends { name: infer N } ? N : never) : never;
export type BreakModeName = Entry["name"] | VariantNames<Entry>;

// The mode with this name and the clause it must fail.
export function breakMode(name: BreakModeName): { clause: ClauseId; mode: BreakVariant; enable?: BreakEnable } {
  for (const clause of Object.keys(BREAK_MODES) as ClauseId[]) {
    const entry: BreakMode = BREAK_MODES[clause];
    for (const mode of [entry, ...(entry.also ?? [])]) {
      if (mode.name === name) return { clause, mode, ...(entry.enable && { enable: entry.enable }) };
    }
  }
  throw new Error(`unknown break mode ${JSON.stringify(name)}; use one of ${allModes().join(", ")}`);
}

const allModes = () => Object.values(BREAK_MODES as Record<ClauseId, BreakMode>).flatMap((m) => [m.name, ...(m.also ?? []).map((v) => v.name)]);

// Wraps a correct sandbox so it violates exactly one conformance clause.
export function brokenSandbox(inner: Sandbox, name: BreakModeName, env: BreakEnv = {}): Sandbox {
  return breakMode(name).mode.wrap(inner, env);
}
