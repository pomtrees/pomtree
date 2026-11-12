import {
  checkProbe,
  FACET_OF,
  type FacetCapability,
  type Sandbox,
  type SandboxCapability,
  SandboxCapabilityError,
  type SandboxDeclaration,
  type SandboxFacets,
} from "@pomtree/core";

// A backend provider is untrusted code behind a declaration. The guard makes the declaration binding at runtime and the tracing
// decorator makes every port call visible; both are plain delegating objects (no Proxy), so the type of the result is the type of
// the Sandbox port. protectSandbox composes them once at the composition root. Pure: no fs, no console, no clock of its own.

type FacetName = keyof SandboxFacets;

// The facets and, per facet, the methods the port defines. A method outside this table is not reachable through either wrapper.
export const FACET_METHODS = {
  terminal: ["open"],
  connect: ["open"],
  loopback: ["open"],
  files: ["put", "get"],
  snapshots: ["create", "start", "remove"],
  lease: ["extend"],
  pause: ["pause", "resume"],
  images: ["prepare"],
} as const satisfies Record<FacetName, readonly string[]>;
const FACET_NAMES = Object.keys(FACET_METHODS) as FacetName[];

// The capabilities that realise each facet (the inverse of FACET_OF); a facet is reachable while any of them is available.
const CAPS_OF: Record<FacetName, FacetCapability[]> = { terminal: [], connect: [], loopback: [], files: [], snapshots: [], lease: [], pause: [], images: [] };
for (const [cap, facet] of Object.entries(FACET_OF) as [FacetCapability, FacetName][]) CAPS_OF[facet].push(cap);

// Every method that is not a facet, in the port. `probe` is wrapped separately because it is optional and narrows the guard.
const PLAIN_METHODS = ["resultWork", "start", "attach", "stop", "kill", "inspect", "list", "reclaim", "imageIdentity"] as const;

// Compile-time exhaustiveness: the method lists above are exactly the keys of each facet interface and of the Sandbox port, so a method
// added to core fails `tsc` here instead of being silently unreachable (undefined) at runtime.
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type FacetMethodChecks = { [K in FacetName]: SameKeys<(typeof FACET_METHODS)[K][number], keyof NonNullable<SandboxFacets[K]>> };
export type FacetMethodsMatchPort = Assert<FacetMethodChecks[FacetName]>;
export type PortMethodsMatchPort = Assert<SameKeys<(typeof PLAIN_METHODS)[number] | FacetName | "declaration" | "probe", keyof Sandbox>>;

// A deep, frozen copy of the declaration taken at wrap time: a provider that mutates its own declaration afterwards (to widen a
// capability once admitted) changes nothing the wrappers read or expose.
function frozenDeclaration(d: SandboxDeclaration): SandboxDeclaration {
  let copy: SandboxDeclaration;
  try {
    copy = structuredClone(d);
  } catch (e) {
    throw new Error(
      `the sandbox declaration of backend ${String(d?.backend)} is not plain data and cannot be snapshotted (${(e as Error).message}); declare only strings, numbers, booleans, null, arrays and plain objects`,
    );
  }
  const freeze = (v: unknown): void => {
    if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (const k of Object.keys(v)) freeze((v as Record<string, unknown>)[k]);
    }
  };
  freeze(copy);
  return copy;
}

type Fn = (...args: unknown[]) => unknown;
// Late-bound: the method is looked up on each call, so the wrapper always delegates to what the provider has now.
const fnOf =
  (target: object, name: string): Fn =>
  (...args) =>
    ((target as Record<string, Fn>)[name] as Fn)(...args);

export type GuardLog = (event: string, fields: Record<string, unknown>) => void;

export interface GuardOptions {
  backend: string;
  log: GuardLog;
}

// The capabilities of which any one suffices for a facet method, given its arguments.
function methodCaps(facet: FacetName, method: string, args: readonly unknown[]): readonly FacetCapability[] {
  if (facet === "files") return [method === "put" ? "files.put" : "files.get"];
  if (facet === "snapshots" && method === "create") {
    const memory = (args[1] as { memory?: boolean } | undefined)?.memory === true;
    return [memory ? "snapshot.memory" : "snapshot.disk"];
  }
  if (facet === "snapshots" && method === "start") return ["snapshot.disk", "snapshot.memory", "fork"];
  if (facet === "snapshots" && method === "remove") return ["snapshot.disk", "snapshot.memory"];
  return CAPS_OF[facet];
}

// Wraps `inner` so that its declaration is enforced:
// - a facet whose capabilities are all denied (declared false, or withheld by a probe) is removed: reading it throws
//   SandboxCapabilityError, even when the provider object carries the facet. A provider that carries a facet its declaration denies
//   is logged once, as a conformance fault;
// - a facet method re-checks its capability on every call, so a facet reference taken before a probe withheld the capability is
//   still refused;
// - a capability declared true whose facet is missing fails here, at wrap time, so boot refuses the backend.
// The declaration is copied and frozen at wrap, and the copy is what the wrapper exposes. The probe result is validated (checkProbe)
// and its `withheld` list narrows the guard from then on; the set only grows, so a later probe cannot widen it back. Values the inner sandbox
// returns, and the errors it throws, pass through unchanged.
export function guardSandbox(inner: Sandbox, options: GuardOptions): Sandbox {
  const declaration = frozenDeclaration(inner.declaration);
  const backend = options.backend;
  const withheld = new Set<SandboxCapability>();
  const available = (c: SandboxCapability) => declaration.capabilities[c] === true && !withheld.has(c);
  const reported = new Set<string>();

  for (const facet of FACET_NAMES) {
    const declared = CAPS_OF[facet].filter((c) => declaration.capabilities[c] === true);
    if (declared.length > 0 && (inner[facet] === undefined || inner[facet] === null)) {
      throw new SandboxCapabilityError(
        backend,
        declared[0] as SandboxCapability,
        `the adapter declares ${declared.join(", ")} but provides no ${facet} facet; fix the adapter or declare ${declared.length > 1 ? "them" : "it"} false`,
      );
    }
  }

  const refusal = (facet: FacetName, caps: readonly FacetCapability[], wholeFacet: boolean): SandboxCapabilityError => {
    const cap = caps[0] as FacetCapability;
    const isWithheld = caps.some((c) => declaration.capabilities[c] === true && withheld.has(c));
    const present = inner[facet] !== undefined && inner[facet] !== null;
    if (wholeFacet && !isWithheld && present && !reported.has(facet)) {
      reported.add(facet);
      options.log("facet-undeclared", { backend, facet, capabilities: caps, action: "fix the adapter: remove the facet or declare the capability" });
    }
    return new SandboxCapabilityError(
      backend,
      cap,
      isWithheld
        ? `the backend's readiness probe withheld ${cap}; resolve what the probe reports, or choose a backend that provides it (sandbox.backend)`
        : present
          ? `the adapter provides a ${facet} facet but declares ${cap} false, so pomtree refuses to use it; fix the adapter's declaration, or remove the facet`
          : `choose a backend that declares ${cap} (sandbox.backend), or disable the feature that needs it`,
    );
  };

  const out: Record<string, unknown> = { declaration };
  for (const m of PLAIN_METHODS) out[m] = fnOf(inner, m);
  if (typeof inner.probe === "function") {
    const probe = fnOf(inner, "probe");
    out.probe = async (...args: unknown[]) => {
      const result = (await probe(...args)) as Parameters<typeof checkProbe>[1];
      checkProbe(declaration, result);
      for (const c of result.withheld) withheld.add(c);
      return result;
    };
  }

  for (const facet of FACET_NAMES) {
    const wrapped = (): object | undefined => {
      const real = inner[facet];
      if (real === undefined || real === null) return undefined;
      const view: Record<string, Fn> = {};
      for (const method of FACET_METHODS[facet]) {
        view[method] = (...args: unknown[]) => {
          const caps = methodCaps(facet, method, args);
          if (!caps.some(available)) return Promise.reject(refusal(facet, caps, false));
          return fnOf(real, method)(...args);
        };
      }
      return view;
    };
    Object.defineProperty(out, facet, {
      enumerable: false,
      configurable: false,
      get: () => {
        if (!CAPS_OF[facet].some(available)) throw refusal(facet, CAPS_OF[facet], true);
        return wrapped();
      },
    });
  }
  return out as unknown as Sandbox;
}

// One record per port call. It carries no request, response, environment, credential or file content: only the operation, the
// sandbox it concerned when known, whether it succeeded and, on failure, the error's class name (never its message).
export interface SandboxTraceRecord {
  op: string; // "start", "stop", ... or "<facet>.<method>", for example "files.put"
  backend: string;
  sandbox?: string;
  outcome: "ok" | "error";
  errorClass?: string;
  durationMs: number;
}
export type SandboxTraceSink = (record: SandboxTraceRecord) => unknown;

export interface TraceOptions {
  backend: string;
  sink: SandboxTraceSink;
  now?: () => number; // milliseconds, monotonic; default performance.now
}

// Operations whose first argument is a sandbox id (imageIdentity's is an image reference, list's an owner, so they are not here).
const ID_FIRST = new Set([
  "attach",
  "stop",
  "kill",
  "inspect",
  "resultWork",
  "terminal.open",
  "connect.open",
  "loopback.open",
  "files.put",
  "files.get",
  "snapshots.create",
  "lease.extend",
  "pause.pause",
  "pause.resume",
]);
// Operations whose result carries the id of the sandbox they created.
const ID_RESULT = new Set(["start", "snapshots.start"]);

// Wraps `inner` so every port call and facet call emits one SandboxTraceRecord through `sink`. A sink that throws or rejects never
// affects the call. Results (including streams, which are not read) and errors pass through untouched; duration ends when the call
// settles, not when a returned stream is consumed.
export function traceSandbox(inner: Sandbox, options: TraceOptions): Sandbox {
  const { backend, sink } = options;
  const declaration = frozenDeclaration(inner.declaration);
  const now = options.now ?? (() => performance.now());
  const emit = (record: SandboxTraceRecord) => {
    try {
      const r = sink(record);
      if (r !== undefined && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).then(undefined, () => {});
    } catch {
      // a failing sink must not change the outcome of the call it observed
    }
  };
  const idOf = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  // Provider-controlled values (error classes, ids, thenables) are read defensively: nothing the tracer reads may change the call.
  const read = <T>(f: () => T | undefined): T | undefined => {
    try {
      return f();
    } catch {
      return undefined;
    }
  };
  const classOf = (e: unknown): string => {
    const name = read(() => (e instanceof Error ? (e.constructor.name as unknown) : "NonError"));
    return typeof name === "string" && /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : "Error";
  };
  const traced =
    (op: string, fn: Fn): Fn =>
    (...args) => {
      const started = read(() => now());
      const settle = (outcome: "ok" | "error", sandboxOf: () => string | undefined, errorClass?: string) => {
        try {
          const sandbox = read(sandboxOf) ?? (ID_FIRST.has(op) ? idOf(args[0]) : undefined);
          const ended = read(() => now());
          emit({
            op,
            backend,
            ...(sandbox !== undefined && { sandbox }),
            outcome,
            ...(errorClass !== undefined && { errorClass }),
            durationMs: started !== undefined && ended !== undefined ? Math.max(0, ended - started) : 0,
          });
        } catch {
          // building a record must not change the outcome of the call it observed
        }
      };
      const failed = (e: unknown) => settle("error", () => (op === "start" ? idOf((e as { id?: unknown } | null)?.id) : undefined), classOf(e));
      const done = (v: unknown) => settle("ok", () => (ID_RESULT.has(op) ? idOf((v as { id?: unknown } | null)?.id) : undefined));
      let result: unknown;
      try {
        result = fn(...args);
      } catch (e) {
        failed(e);
        throw e;
      }
      let then: unknown;
      try {
        then = result !== null && typeof result === "object" ? (result as { then?: unknown }).then : undefined;
      } catch {
        return result; // a hostile `then` getter: hand the result back untouched, untraced
      }
      if (typeof then === "function") {
        return (then as Fn).call(
          result,
          (v: unknown) => {
            done(v);
            return v;
          },
          (e: unknown) => {
            failed(e);
            throw e;
          },
        );
      }
      done(result);
      return result;
    };

  const out: Record<string, unknown> = { declaration };
  for (const m of PLAIN_METHODS) out[m] = traced(m, fnOf(inner, m));
  if (typeof inner.probe === "function") out.probe = traced("probe", fnOf(inner, "probe"));
  for (const facet of FACET_NAMES) {
    Object.defineProperty(out, facet, {
      enumerable: false,
      configurable: false,
      get: () => {
        const real = inner[facet];
        if (real === undefined || real === null) return undefined;
        const view: Record<string, Fn> = {};
        for (const method of FACET_METHODS[facet]) view[method] = traced(`${facet}.${method}`, fnOf(real, method));
        return view;
      },
    });
  }
  return out as unknown as Sandbox;
}

export interface ProtectOptions {
  backend: string;
  log: GuardLog;
  sink: SandboxTraceSink;
  now?: () => number;
}

// The composition-root wrapper: tracing outside, guard inside, so a refused call is traced as an error too.
export function protectSandbox(inner: Sandbox, options: ProtectOptions): Sandbox {
  return traceSandbox(guardSandbox(inner, { backend: options.backend, log: options.log }), {
    backend: options.backend,
    sink: options.sink,
    ...(options.now !== undefined && { now: options.now }),
  });
}

export interface RateLimitOptions {
  windowMs: number;
  now: () => number;
}

// Wraps a sink so a failing call that repeats (a poll failing every second) is passed on at most once per operation and error class
// per window; the first failure is always passed. Records that succeeded always pass. Pure: the clock is injected.
export function rateLimitFailures(next: SandboxTraceSink, options: RateLimitOptions): SandboxTraceSink {
  const lastPassed = new Map<string, number>();
  return (record) => {
    if (record.outcome === "error") {
      const key = `${record.op}\u0000${record.errorClass ?? ""}`;
      const t = options.now();
      const last = lastPassed.get(key);
      if (last !== undefined && t - last < options.windowMs) return undefined;
      if (lastPassed.size >= 256) lastPassed.clear();
      lastPassed.set(key, t);
    }
    return next(record);
  };
}
