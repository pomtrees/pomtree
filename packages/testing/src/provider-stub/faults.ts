// Named faults of the provider stub. Pure: no sockets, no fs. A fault is armed on a `FaultPlan` and consumed by the model when a matching request arrives.
//
// Three faults are deliberate server BUGS (the "break" modes): the stub, normally a correct provider, misbehaves so a test that checks the
// behavior can be shown to fail. The other three are provider FAILURES an adapter must survive.
//
//   idempotent-create        break: a create ignores the idempotency key, so a retry makes a second resource
//   fresh-key-retry          break: the server accepts a retry of an unknown-outcome create that carries a new key (a correct one rejects it with 409)
//   out-of-order-frame       break: an upgrade stream delivers two consecutive frames in the wrong order
//   timeout                  the request is never answered and nothing is applied
//   rate-limit               429 with Retry-After, nothing applied
//   server-error-after-apply the request is applied, then answered with a 5xx: the caller cannot tell whether it took effect

export const FAULT_NAMES = ["idempotent-create", "fresh-key-retry", "out-of-order-frame", "timeout", "rate-limit", "server-error-after-apply"] as const;
export type FaultName = (typeof FAULT_NAMES)[number];

/** The faults that make the server deliberately wrong (selected by the test-only `PROVIDER_STUB_BREAK` switch). */
export const BREAK_FAULTS = ["idempotent-create", "fresh-key-retry", "out-of-order-frame"] as const satisfies readonly FaultName[];
export type BreakFault = (typeof BREAK_FAULTS)[number];

export interface FaultArm {
  /** Uses left; `Number.POSITIVE_INFINITY` keeps the fault armed for the whole run. */
  times?: number;
  /** Only requests with this method (upper case) consume the fault. */
  method?: string;
  /** Only requests with exactly this path consume the fault. */
  path?: string;
  /** `rate-limit`: seconds in Retry-After (default 1). */
  retryAfterS?: number;
  /** `server-error-after-apply`: the 5xx status (default 503). */
  status?: number;
}

export interface FiredFault {
  readonly name: FaultName;
  readonly method: string;
  readonly path: string;
}

interface Armed extends FaultArm {
  left: number;
}

export function isFaultName(v: string): v is FaultName {
  return (FAULT_NAMES as readonly string[]).includes(v);
}

export class FaultPlan {
  readonly #armed = new Map<FaultName, Armed[]>();
  readonly fired: FiredFault[] = [];

  arm(name: FaultName, opts: FaultArm = {}): void {
    if (!isFaultName(name)) throw new Error(`unknown provider-stub fault "${String(name)}"; use one of ${FAULT_NAMES.join(", ")}`);
    const times = opts.times ?? 1;
    if (!(times >= 1)) throw new Error(`fault "${name}" armed with times=${times}; use a count of 1 or more, or Number.POSITIVE_INFINITY to keep it armed`);
    const list = this.#armed.get(name) ?? [];
    list.push({ ...opts, left: times });
    this.#armed.set(name, list);
  }

  /** Consumes one use of `name` for this request, or returns undefined when none is armed for it. */
  take(name: FaultName, method: string, path: string): FaultArm | undefined {
    const list = this.#armed.get(name);
    const hit = list?.find((a) => a.left > 0 && (a.method === undefined || a.method === method) && (a.path === undefined || a.path === path));
    if (hit === undefined) return undefined;
    hit.left -= 1;
    this.fired.push({ name, method, path });
    return hit;
  }

  /** How many times `name` has fired. */
  count(name: FaultName): number {
    return this.fired.filter((f) => f.name === name).length;
  }
}
