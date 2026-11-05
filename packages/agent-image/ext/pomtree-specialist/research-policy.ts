// The research policy and the registered-test schemas a runner-kind hypothesis is checked against: the one definition of the policy's
// shape (validatePolicy), the backtest and event-study spec parsers, and the refusals built on them (registeredSpecRefusal,
// hypothesisSpecRefusal). Pure and dependency-free, so it runs in the specialist's container: the host publishes the board's validated
// policy on the task page (draft-rules.ts DraftRules.policy) and `post_draft` refuses a spec the board would refuse, with the board's path
// and message. A domain example's board (its post validator) and runner import these same functions
// through its own registered-test module, which keeps only the policy VALUES (POLICY_1, DEFAULT_POLICY).
// Layering: this is research-domain-specific schema (the "trend" strategy, the "car" event study) inside the specialist extension. The extension
// is already that research domain's (its task page kind, board roles and draft rules are the board's), and the container cannot import the
// example, so the alternative (a generic rule language serialized on the page with one interpreter) would carry the same schema as data
// plus an interpreter to keep in step. Reopen: when a specialist board for a second domain needs post_draft.

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const CALENDAR = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;

// ---- the research policy ----

// The asset classes a policy universe enumerates; each binds a cost model and an event-study benchmark.
export type UniverseClass = "equity" | "etf";

// The floors and defaults every registered test is held to. `version` is hashed into the registered-test hash, so a test registered
// under one policy is never judged under another. `universe`, `eventBenchmark` and `refuteAlpha` are all present (fin-policy-2 and
// later) or all absent (a legacy fin-policy-1-shaped policy, which declares no universe and refutes at its eventPValueCeiling).
export type ResearchPolicy = {
  version: string;
  sharpeFloor: number; // a spec's sharpeMin must be at or above this
  dsrFloor: number; // a spec's dsrMin must be at or above this (> 0, so the deflated-Sharpe guard cannot be switched off)
  refuteBelowFloor: number; // a spec's refuteBelow must be at or above this, so a hypothesis can actually be refuted
  costBps: number; // the per-trade cost every run pays (never 0)
  // The criterion is on excess over buy-and-hold of the same asset over the same window: the runner builds that benchmark from the spec's
  // own symbol and window (workflow/backtest-runner.mts), so the trend backtest's benchmark is policy-fixed, never chosen by the author.
  benchmark: "buy-and-hold" | "none";
  minBars: number; // an in-sample run judged on fewer daily returns than this is inconclusive
  maxPriceAgeTradingDays: number;
  eventPValueCeiling: number; // an event-study spec's pMax must be at or below this
  minEvents: number; // an event study with fewer usable events than this is inconclusive
  // The declared tradable universe: an explicit, dated, enumerated ticker list (exact uppercase match), ticker -> class. It binds the cost
  // model above, so it scopes runner-kind specs (backtest, event-study) and equity/etf order tickets only.
  universe?: { name: string; symbols: Record<string, UniverseClass> };
  eventBenchmark?: Record<UniverseClass, string>; // the event-study benchmark per asset class, fixed by policy (registeredSpecRefusal)
  refuteAlpha?: number; // the one-sided significance a Sharpe-path refutation is held to (refuteAlphaOf), in (0, 0.1]
};

// Every key of ResearchPolicy, exactly (the Record type makes a missing or extra key a type error).
const POLICY_KEY_SET: Record<keyof ResearchPolicy, true> = {
  version: true,
  sharpeFloor: true,
  dsrFloor: true,
  refuteBelowFloor: true,
  costBps: true,
  benchmark: true,
  minBars: true,
  maxPriceAgeTradingDays: true,
  eventPValueCeiling: true,
  minEvents: true,
  universe: true,
  eventBenchmark: true,
  refuteAlpha: true,
};
const POLICY_KEYS = Object.keys(POLICY_KEY_SET);
const UNIVERSE_KEYS = ["universe", "eventBenchmark", "refuteAlpha"];
const CLASSES: UniverseClass[] = ["equity", "etf"];

// A hypothesis asset as the trial ledger keys it and the universe matches it (the board stores it as posted).
export const normalAsset = (asset: string): string => asset.trim().toUpperCase();

// Null when the policy declares no universe (legacy) or `ticker` is a member; otherwise the refusal, naming the ticker, the universe, the
// policy version and the fix.
export function universeRefusal(policy: ResearchPolicy, ticker: string, what: string): string | null {
  const u = policy.universe;
  if (u === undefined || Object.hasOwn(u.symbols, ticker)) return null;
  return `${what} ticker ${ticker} is outside universe ${u.name} of research policy ${policy.version}; use a member of that universe, or have the operator add ${ticker} under a new policy version`;
}

export function validatePolicy(raw: unknown): { ok: true; value: ResearchPolicy } | { ok: false; error: string } {
  if (!record(raw)) return { ok: false, error: "research policy must be an object" };
  for (const k of Object.keys(raw)) if (!POLICY_KEYS.includes(k)) return { ok: false, error: `research policy: unknown key ${k}` };
  if (typeof raw.version !== "string" || raw.version.trim() === "") return { ok: false, error: "research policy: version must be a non-empty string" };
  for (const k of ["sharpeFloor", "dsrFloor", "refuteBelowFloor", "costBps"])
    if (typeof raw[k] !== "number" || !Number.isFinite(raw[k])) return { ok: false, error: `research policy: ${k} must be a finite number` };
  const p = raw as unknown as ResearchPolicy;
  if (!(p.dsrFloor > 0 && p.dsrFloor < 1)) return { ok: false, error: `research policy: dsrFloor ${p.dsrFloor} must be in (0, 1)` };
  if (!(p.costBps > 0 && p.costBps <= 1000)) return { ok: false, error: `research policy: costBps ${p.costBps} must be in (0, 1000]` };
  if (p.refuteBelowFloor > p.sharpeFloor)
    return { ok: false, error: `research policy: refuteBelowFloor ${p.refuteBelowFloor} is above sharpeFloor ${p.sharpeFloor}` };
  if (p.benchmark !== "buy-and-hold" && p.benchmark !== "none") return { ok: false, error: 'research policy: benchmark must be "buy-and-hold" or "none"' };
  if (typeof raw.eventPValueCeiling !== "number" || !(raw.eventPValueCeiling > 0 && raw.eventPValueCeiling <= 0.1))
    return { ok: false, error: `research policy: eventPValueCeiling ${String(raw.eventPValueCeiling)} must be in (0, 0.1]` };
  if (!Number.isSafeInteger(raw.minEvents) || (raw.minEvents as number) < 2) return { ok: false, error: "research policy: minEvents must be an integer >= 2" };
  for (const k of ["minBars", "maxPriceAgeTradingDays"])
    if (!Number.isSafeInteger(raw[k]) || (raw[k] as number) < 1) return { ok: false, error: `research policy: ${k} must be a positive integer` };
  const present = UNIVERSE_KEYS.filter((k) => k in raw);
  if (present.length === 0) return { ok: true, value: { ...p } };
  if (present.length !== UNIVERSE_KEYS.length)
    return { ok: false, error: `research policy: ${UNIVERSE_KEYS.join(", ")} must all be present or all absent (found only ${present.join(", ")})` };
  const u = raw.universe;
  if (!record(u) || typeof u.name !== "string" || u.name.trim() === "" || !record(u.symbols) || Object.keys(u).some((k) => k !== "name" && k !== "symbols"))
    return { ok: false, error: "research policy: universe must be { name: non-empty string, symbols: { TICKER: class } }" };
  const entries = Object.entries(u.symbols);
  if (entries.length === 0) return { ok: false, error: `research policy: universe ${u.name} is empty` };
  for (const [t, c] of entries) {
    if (!SYMBOL.test(t)) return { ok: false, error: `research policy: universe ticker ${t} is not an uppercase ticker` };
    if (!CLASSES.includes(c as UniverseClass))
      return { ok: false, error: `research policy: universe ticker ${t} has class ${String(c)} (expected equity or etf)` };
  }
  const eb = raw.eventBenchmark;
  if (!record(eb) || Object.keys(eb).some((k) => !CLASSES.includes(k as UniverseClass)))
    return { ok: false, error: "research policy: eventBenchmark must map equity and etf to a universe ticker" };
  for (const c of CLASSES) {
    const b = eb[c];
    if (typeof b !== "string" || !Object.hasOwn(u.symbols, b))
      return { ok: false, error: `research policy: eventBenchmark.${c} ${String(b)} is not a member of universe ${u.name}` };
  }
  if (typeof raw.refuteAlpha !== "number" || !(raw.refuteAlpha > 0 && raw.refuteAlpha <= 0.1))
    return { ok: false, error: `research policy: refuteAlpha ${String(raw.refuteAlpha)} must be in (0, 0.1]` };
  return {
    ok: true,
    value: {
      ...p,
      universe: { name: u.name, symbols: { ...(u.symbols as Record<string, UniverseClass>) } },
      eventBenchmark: { ...p.eventBenchmark } as Record<UniverseClass, string>,
    },
  };
}

// ---- the registered backtest test ----

// The pre-registered specification a backtest hypothesis carries in `hypothesis.test.spec` (JSON). One closed strategy so far: "trend",
// long while the close is above its `lookback`-day mean, flat otherwise. The family, asset and declared cost are the hypothesis post's own
// fields (board.mts Hypothesis), which key the trial ledger.
export type RegisteredTest = {
  strategy: "trend";
  symbol: string;
  lookback: number;
  warmupFrom: string;
  from: string;
  to: string;
  // The judged statistic is the annualized Ledoit-Wolf Sharpe-ratio DIFFERENCE: the strategy's Sharpe minus buy-and-hold's on the
  // same asset (under a policy benchmark of "none", the strategy's own Sharpe), with its HAC standard error SE. It is not the
  // strategy's own Sharpe: a strategy that only rides the asset's drift scores near 0, whatever its own Sharpe.
  sharpeMin: number; // validated when the difference is at or above this AND the deflated guard Phi(difference / SE - E[max of N standard normals]) is at or above dsrMin, N the trial count
  dsrMin: number;
  refuteBelow: number; // refuted when the difference's upper one-sided confidence bound (difference + z SE, z at the policy's one-sided refutation significance, refuteAlphaOf) is below this
};
export function parseRegisteredTest(spec: string): { ok: true; value: RegisteredTest } | { ok: false; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(spec);
  } catch {
    return { ok: false, error: "spec is not JSON" };
  }
  if (!record(v) || v.strategy !== "trend") return { ok: false, error: "unknown strategy" };
  const keys = ["strategy", "symbol", "lookback", "warmupFrom", "from", "to", "sharpeMin", "dsrMin", "refuteBelow"];
  for (const k of Object.keys(v)) if (!keys.includes(k)) return { ok: false, error: `unknown spec key: ${k}` };
  const dates = [v.warmupFrom, v.from, v.to];
  if (typeof v.symbol !== "string" || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(v.symbol)) return { ok: false, error: "bad symbol" };
  if (!Number.isSafeInteger(v.lookback) || (v.lookback as number) < 2 || (v.lookback as number) > 250) return { ok: false, error: "bad lookback" };
  if (
    !dates.every((d) => typeof d === "string" && CALENDAR.test(d)) ||
    !((v.warmupFrom as string) <= (v.from as string) && (v.from as string) < (v.to as string))
  )
    return { ok: false, error: "bad window" };
  for (const k of ["sharpeMin", "dsrMin", "refuteBelow"]) if (typeof v[k] !== "number" || !Number.isFinite(v[k])) return { ok: false, error: `bad ${k}` };
  if ((v.refuteBelow as number) > (v.sharpeMin as number)) return { ok: false, error: "refuteBelow above sharpeMin" };
  return { ok: true, value: v as unknown as RegisteredTest };
}

// ---- the registered event study ----

// The pre-registered specification an event-study hypothesis carries: the cumulative abnormal return (CAR) of `symbol` against
// `benchmark` over `eventWindow` trading days around each registered event date (backtest/event-study.mts), reading no bar after `to`
// (every event is on or before it). Validated when the mean CAR
// has the registered `direction` and its trial-adjusted p-value is at or below `pMax`; refuted only when the mean CAR is significantly on
// the other side of zero (the one-sided wrong-direction p-value, adjusted the same way, at or below `pMax`). A wrong sign that is not
// significant is inconclusive: under no effect the sign is a coin flip, so refuting on it alone would refute half of all null claims.
// Under a policy with a universe, `symbol` must be a member and `benchmark` is the policy's eventBenchmark for its class.
export type EventStudyTest = {
  study: "car";
  symbol: string;
  benchmark: string;
  events: string[];
  to: string;
  model: "market" | "benchmark-adjusted";
  estimationWindow?: [number, number];
  eventWindow: [number, number];
  direction: "positive" | "negative";
  pMax: number;
};
export const EVENTS_MAX = 500;
const offsets = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every((x) => Number.isSafeInteger(x) && Math.abs(x as number) <= 1000) && (v[0] as number) <= (v[1] as number);
export function parseEventStudyTest(spec: string): { ok: true; value: EventStudyTest } | { ok: false; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(spec);
  } catch {
    return { ok: false, error: "spec is not JSON" };
  }
  if (!record(v) || v.study !== "car") return { ok: false, error: 'unknown study (expected "car")' };
  const keys = ["study", "symbol", "benchmark", "events", "to", "model", "estimationWindow", "eventWindow", "direction", "pMax"];
  for (const k of Object.keys(v)) if (!keys.includes(k)) return { ok: false, error: `unknown spec key: ${k}` };
  if (typeof v.symbol !== "string" || !SYMBOL.test(v.symbol)) return { ok: false, error: "bad symbol" };
  if (typeof v.benchmark !== "string" || !SYMBOL.test(v.benchmark) || v.benchmark === v.symbol) return { ok: false, error: "bad benchmark" };
  if (!Array.isArray(v.events) || v.events.length === 0 || v.events.length > EVENTS_MAX || !v.events.every((d) => typeof d === "string" && CALENDAR.test(d)))
    return { ok: false, error: `bad events (1 to ${EVENTS_MAX} YYYY-MM-DD dates)` };
  if (new Set(v.events).size !== v.events.length) return { ok: false, error: "duplicate event dates" };
  if (typeof v.to !== "string" || !CALENDAR.test(v.to) || !v.events.every((d) => d <= (v.to as string)))
    return { ok: false, error: "bad to (every event on or before it)" };
  if (v.model !== "market" && v.model !== "benchmark-adjusted") return { ok: false, error: "bad model" };
  if (!offsets(v.eventWindow)) return { ok: false, error: "bad eventWindow" };
  if (v.estimationWindow !== undefined && !offsets(v.estimationWindow)) return { ok: false, error: "bad estimationWindow" };
  if (v.model === "market" && ((v.estimationWindow as [number, number] | undefined)?.[1] ?? -11) >= v.eventWindow[0])
    return { ok: false, error: "estimationWindow must end before eventWindow starts" };
  if (v.direction !== "positive" && v.direction !== "negative") return { ok: false, error: "bad direction" };
  if (typeof v.pMax !== "number" || !(v.pMax > 0 && v.pMax < 1)) return { ok: false, error: "bad pMax" };
  return { ok: true, value: v as unknown as EventStudyTest };
}

// ---- the policy check ----

// Parse plus floor check for a runner-kind spec: null when the spec may be registered, otherwise a message naming the field, its value,
// the floor and the policy version. Under a policy with a universe it also refuses a symbol outside it and an event-study benchmark other
// than the policy's for the symbol's class. The board refuses with it at registration and the runner re-checks before it runs.
export function registeredSpecRefusal(kind: "backtest" | "event-study", spec: string, policy: ResearchPolicy): string | null {
  const floors = (k: string, v: number, floor: number, name: string): string | null =>
    v < floor ? `registered ${kind} spec: ${k} ${v} is below the ${name} ${floor} of research policy ${policy.version}; raise ${k} to at least ${floor}` : null;
  if (kind === "backtest") {
    const t = parseRegisteredTest(spec);
    if (!t.ok) return `registered backtest spec invalid: ${t.error}`;
    return (
      universeRefusal(policy, t.value.symbol, "registered backtest spec") ??
      floors("sharpeMin", t.value.sharpeMin, policy.sharpeFloor, "sharpeFloor") ??
      floors("dsrMin", t.value.dsrMin, policy.dsrFloor, "dsrFloor") ??
      floors("refuteBelow", t.value.refuteBelow, policy.refuteBelowFloor, "refuteBelowFloor")
    );
  }
  const t = parseEventStudyTest(spec);
  if (!t.ok) return `registered event-study spec invalid: ${t.error}`;
  if (t.value.pMax > policy.eventPValueCeiling)
    return `registered event-study spec: pMax ${t.value.pMax} is above the eventPValueCeiling ${policy.eventPValueCeiling} of research policy ${policy.version}; lower pMax to at most ${policy.eventPValueCeiling}`;
  const outside = universeRefusal(policy, t.value.symbol, "registered event-study spec");
  if (outside !== null) return outside;
  if (policy.universe !== undefined && policy.eventBenchmark !== undefined) {
    const cls = policy.universe.symbols[t.value.symbol] as UniverseClass;
    const want = policy.eventBenchmark[cls];
    if (t.value.benchmark !== want)
      return `registered event-study spec: benchmark ${t.value.benchmark} is not the ${cls} benchmark ${want} of research policy ${policy.version} (the benchmark is fixed per asset class, never chosen by the author); set benchmark to ${want}`;
  }
  return null;
}

// The refusal of a hypothesis's registered test, as the board's validatePost refuses it (spec_refused): first a runner test's asset outside
// the policy universe (at hypothesis/asset), then a spec that does not parse or is below the policy floors (at hypothesis/test/spec). Null
// for a non-runner test (a filings-check or reproduction may concern any asset) or an acceptable one. The board calls it on the validated
// fields; post_draft's check (draft-rules.ts) on the draft's own strings, before the board sees them.
export function hypothesisSpecRefusal(policy: ResearchPolicy, testKind: string, asset: string, spec: string): { path: string; message: string } | null {
  if (testKind !== "backtest" && testKind !== "event-study") return null;
  const outside = universeRefusal(policy, normalAsset(asset), "hypothesis asset");
  if (outside !== null) return { path: "hypothesis/asset", message: outside };
  const refusal = registeredSpecRefusal(testKind, spec, policy);
  return refusal === null ? null : { path: "hypothesis/test/spec", message: refusal };
}
