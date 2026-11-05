// 5-field cron: minute hour day-of-month month day-of-week. Supports *, lists, ranges, steps.
// Day-of-week is 0-7 (0 and 7 are Sunday). When both day-of-month and day-of-week are
// restricted, a time matches if EITHER does (standard cron semantics).
// Time zones: wall-clock fields are evaluated in `tz` (IANA name, default "UTC") at every UTC
// minute instant. A local time skipped by a DST jump never fires; a local time repeated by a
// fall-back fires once, at the first of the two instants.

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
] as const;

function parseField(text: string, f: (typeof FIELDS)[number]): { values: Set<number>; star: boolean } {
  const values = new Set<number>();
  let star = false;
  for (const part of text.split(",")) {
    const [rangeText = "", stepText, extra] = part.split("/");
    if (extra !== undefined || part === "") throw new Error(`invalid ${f.name} field: "${text}"`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step in ${f.name} field: "${text}"`);
    let lo: number;
    let hi: number;
    if (rangeText === "*") {
      lo = f.min;
      hi = f.max;
      star = true; // vixie treats `*` and `*/n` as star (unrestricted) for the dom/dow rule
    } else {
      const [a, b, more] = rangeText.split("-");
      if (more !== undefined || a === undefined || !/^\d+$/.test(a) || (b !== undefined && !/^\d+$/.test(b))) {
        throw new Error(`invalid ${f.name} field: "${text}"`);
      }
      lo = Number(a);
      hi = b === undefined ? (stepText === undefined ? lo : f.max) : Number(b);
    }
    if (lo < f.min || hi > f.max || lo > hi) throw new Error(`${f.name} out of range: "${text}"`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, star };
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields, got ${parts.length}: "${expr}"`);
  const [m, h, dom, mon, dow] = parts.map((p, i) => parseField(p, FIELDS[i]!)) as ReturnType<typeof parseField>[];
  const dows = new Set([...dow!.values].map((d) => d % 7));
  return {
    minutes: m!.values,
    hours: h!.values,
    doms: dom!.values,
    months: mon!.values,
    dows,
    domRestricted: !dom!.star,
    dowRestricted: !dow!.star,
  };
}

interface Local {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number;
  offset: number; // minutes east of UTC at this instant
}

function sameLocal(a: Local, b: Local): boolean {
  return a.minute === b.minute && a.hour === b.hour && a.dom === b.dom && a.month === b.month && a.dow === b.dow;
}

// Parse a `timeZoneName: "longOffset"` part like "GMT+10:30" (or "GMT" for zero) into
// minutes east of UTC.
function offsetMinutes(name: string): number {
  const m = /^GMT([+-])(\d{1,2}):(\d{2})$/.exec(name);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

function localFields(tz: string): (t: number) => Local {
  if (tz === "UTC") {
    return (t) => {
      const d = new Date(t);
      return { minute: d.getUTCMinutes(), hour: d.getUTCHours(), dom: d.getUTCDate(), month: d.getUTCMonth() + 1, dow: d.getUTCDay(), offset: 0 };
    };
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    timeZoneName: "longOffset",
  });
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (t) => {
    const p: Record<string, string> = {};
    for (const part of fmt.formatToParts(new Date(t))) p[part.type] = part.value;
    return {
      minute: Number(p.minute),
      hour: Number(p.hour) % 24,
      dom: Number(p.day),
      month: Number(p.month),
      dow: days.indexOf(p.weekday!),
      offset: offsetMinutes(p.timeZoneName!),
    };
  };
}

const MIN = 60_000;
const MAX_SEARCH_MIN = 366 * 5 * 24 * 60;
const MAX_FALLBACK_MIN = 180; // exceeds every real DST fall-back shift (30m Lord Howe, 60m most zones, 2h Troll)

// True when `t` is the second instant of a wall-clock minute repeated by a fall-back. The
// repeated range can be 30/60/120 minutes long, so the shift is read from the offset rather
// than assumed to be 60.
function isRepeatedSecond(at: (t: number) => Local, l: Local, t: number): boolean {
  // No offset change within the window: this wall-clock minute occurs exactly once.
  if (l.offset === at(t - MAX_FALLBACK_MIN * MIN).offset) return false;
  for (let k = 1; k <= MAX_FALLBACK_MIN; k++) {
    const prev = at(t - k * MIN);
    if (prev.offset > l.offset && sameLocal(l, prev)) return true;
    if (prev.offset < l.offset) return false; // crossed a spring-forward going back: no repeat
  }
  return false;
}

// Next fire strictly after `after` (epoch ms), or null if none within five years.
export function nextFire(expr: string | CronSpec, after: number, tz = "UTC"): number | null {
  const spec = typeof expr === "string" ? parseCron(expr) : expr;
  const at = localFields(tz);
  let t = (Math.floor(after / MIN) + 1) * MIN;
  const limit = t + MAX_SEARCH_MIN * MIN;
  while (t <= limit) {
    const l = at(t);
    const dayOk = spec.domRestricted && spec.dowRestricted ? spec.doms.has(l.dom) || spec.dows.has(l.dow) : spec.doms.has(l.dom) && spec.dows.has(l.dow);
    if (!spec.months.has(l.month) || !dayOk) {
      // Skip toward the next local midnight, minus an hour of margin for DST shifts.
      t += Math.max(1, 24 * 60 - l.hour * 60 - l.minute - 60) * MIN;
    } else if (!spec.hours.has(l.hour)) {
      t += Math.max(1, 60 - l.minute) * MIN;
    } else if (!spec.minutes.has(l.minute)) {
      t += MIN;
    } else if (isRepeatedSecond(at, l, t)) {
      // `t` is the second instant of a fall-back-repeated local minute: skip it so the time
      // fires once, at the first instant.
      t += MIN;
    } else {
      return t;
    }
  }
  return null;
}

// Largest fire strictly before `before` (epoch ms), or null if none within the five-year
// search horizon. nextFire is forward-only, so this binary-searches the boundary where the
// first fire strictly after `x` is still before `before`.
export function prevFire(expr: string | CronSpec, before: number, tz = "UTC"): number | null {
  const spec = typeof expr === "string" ? parseCron(expr) : expr;
  const horizon = before - MAX_SEARCH_MIN * MIN;
  let lo = horizon;
  let hi = before;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const n = nextFire(spec, mid, tz);
    if (n !== null && n < before) lo = mid + 1;
    else hi = mid;
  }
  const n = nextFire(spec, lo - 1, tz);
  return n !== null && n < before ? n : null;
}

export interface CronScheduleOptions {
  tz?: string;
  // Injectable search primitives (bound to the schedule's tz) for fakes/tests; default to
  // the module's nextFire/prevFire.
  nextFire?: (spec: CronSpec, after: number) => number | null;
  prevFire?: (spec: CronSpec, before: number) => number | null;
}

// A cached view of one cron schedule: fire times are memoized as they are asked for, so the
// daemon's per-tick `prevFire(now)` on an unchanged schedule is amortized O(1) instead of
// re-running the five-year search every tick.
export class CronSchedule {
  readonly expr: string;
  readonly tz: string;
  private readonly spec: CronSpec;
  private readonly scanNext: (after: number) => number | null;
  private readonly scanPrev: (before: number) => number | null;
  private nextCache: { after: number; result: number | null } | null = null;
  private chain: { last: number | null; next: number | null } | null = null;

  constructor(expr: string, opts: CronScheduleOptions = {}) {
    this.expr = expr;
    this.tz = opts.tz ?? "UTC";
    this.spec = parseCron(expr);
    const next = opts.nextFire ?? ((spec: CronSpec, after: number) => nextFire(spec, after, this.tz));
    const prev = opts.prevFire ?? ((spec: CronSpec, before: number) => prevFire(spec, before, this.tz));
    this.scanNext = (after) => next(this.spec, after);
    this.scanPrev = (before) => prev(this.spec, before);
  }

  // First fire strictly after `after`, cached for repeated monotonic queries within one gap.
  nextFire(after: number): number | null {
    const c = this.nextCache;
    if (c && (after === c.after || (c.result !== null && after >= c.after && after < c.result))) return c.result;
    const result = this.scanNext(after);
    this.nextCache = { after, result };
    return result;
  }

  // Largest fire strictly before `before`, cached across monotonic ticks. A `last` of null
  // means no fire is known before the cached window yet (the answer is null until `next`).
  prevFire(before: number): number | null {
    let chain = this.chain;
    while (chain) {
      const { last, next } = chain;
      if (next !== null) {
        if (last === null) {
          if (before <= next) return null;
          chain = this.chain = { last: next, next: this.scanNext(next) };
          continue;
        }
        if (before > last && before <= next) return last;
        if (before > next) {
          chain = this.chain = { last: next, next: this.scanNext(next) };
          continue;
        }
      } else if (last !== null && before > last && before <= last + MAX_SEARCH_MIN * MIN) {
        return last;
      }
      break;
    }
    const result = this.scanPrev(before);
    if (this.chain === null) {
      if (result === null) {
        const first = this.scanNext(before - 1);
        this.chain = first === null ? null : { last: null, next: first };
      } else {
        this.chain = { last: result, next: this.scanNext(result) };
      }
    }
    return result;
  }
}
