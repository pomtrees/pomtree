// Pure helpers for budget-raise escalation (docs/economy.md section 13): the approval target codec, the requested
// amount, the proxy-refusal matcher and the texts. No fs, store or clock coupling; the daemon wires them.
import { modelRefusalCodeIn } from "@pomtree/core";
import { usd } from "./daemon-util.ts";

export const BUDGET_RAISE_KIND = "budget_raise" as const;
export const DEFAULT_BUDGET_RAISE_PCT = 50;
export const DEFAULT_BUDGET_RAISE_MS = 86_400_000; // human rungs wait 24 h; a parked agent spends nothing

// Approval target: `<asker>:<generation>:<n>:<requestedMicros>`. The target is hashed into the approval id, so the
// generation in it keeps one budget approval per agent per generation and a late decision aimed at an old generation inert.
export const budgetRaiseTarget = (asker: string, generation: number, requestedMicros: number): string =>
  `${asker}:${generation}:${generation}:${requestedMicros}`;

export function parseBudgetRaiseTarget(target: string): { asker: string; generation: number; n: number; requestedMicros: number } | null {
  const m = /^(.+):(\d+):(\d+):(\d+)$/.exec(target);
  if (!m) return null;
  const [generation, n, requestedMicros] = [Number(m[2]), Number(m[3]), Number(m[4])];
  return Number.isSafeInteger(requestedMicros) && requestedMicros > 0 ? { asker: m[1]!, generation, n, requestedMicros } : null;
}

// What the agent asks for (budget-raise-headroom): the overshoot it already spent past its budget plus pct of its ORIGINAL
// budget (current minus earlier grants) as headroom, so a granted agent always resumes with pct left to spend. In the
// hierarchical ledger the overshoot is already booked against the payer, so the grant costs the payer only the headroom.
export const requestedRaise = (pct: number, originalMicros: number, overshootMicros: number): number =>
  Math.max(1, Math.ceil(overshootMicros) + Math.ceil((pct / 100) * originalMicros));

// The proxy refused a request for lack of budget (model-proxy/service.ts 402, tagged model_budget_exhausted). Pi surfaces the body
// text in an error event; the tag, not the phrase, is what is matched.
export const isBudgetRefusal = (message: string): boolean => modelRefusalCodeIn(message) === "model_budget_exhausted";

export const budgetRaiseBody = (asker: string, requestedMicros: number): string => `${asker} out of budget; approve +${usd(requestedMicros)}?`;

export function budgetWakeText(o: { spent: number; budget: number; holder: string; amount: number; newBudget: number }): string {
  return `Resumed: your budget (${usd(o.spent)} of ${usd(o.budget)}) was exhausted and you were parked. ${o.holder} granted +${usd(o.amount)}; budget is now ${usd(o.newBudget)} (${usd(Math.max(0, o.newBudget - o.spent))} left). Tool calls in flight when you stopped were aborted and may have partly run; re-check workspace state before continuing.`;
}
