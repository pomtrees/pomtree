// Token rates from Pi's own model catalog, and the charge computed from them. Pure: no fs. The shapes and the
// arithmetic mirror Pi's `calculateCost` (pi-ai dist/models.js) so a charge here equals the `cost.total` Pi reports
// for the same usage: rates are USD per million tokens, `input` excludes cache tokens, the tier with the highest
// matching `inputTokensAbove` replaces all four rates, and a 1h cache write is billed at 2x the (tier) input rate.

export interface RateCard {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelRates extends RateCard {
  tiers?: Array<RateCard & { inputTokensAbove: number }>;
}

// Pi's usage split: `input` is the uncached prompt remainder, cacheWrite1h is the part of cacheWrite billed at 1h.
export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
}

// Where the pricer and the output bound get rates. `lookup` is keyed by Pi provider and the model id the request
// carries; null means the model is unknown (the caller then fails closed).
export interface RatesSource {
  lookup(provider: string, model: string): ModelRates | null;
  // The highest input and output micros per token across every catalogued model: a conservative bound for a model
  // missing from the catalog (its real rate is unknown). Null when no rates are loaded.
  ceiling?(): RateCeiling | null;
}

export interface RateCeiling {
  inputMicrosPerToken: number;
  outputMicrosPerToken: number;
}

function rate(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseCard(v: unknown): RateCard | null {
  if (!isObject(v)) return null;
  const input = rate(v.input);
  const output = rate(v.output);
  const cacheRead = rate(v.cacheRead);
  const cacheWrite = rate(v.cacheWrite);
  return input === null || output === null || cacheRead === null || cacheWrite === null ? null : { input, output, cacheRead, cacheWrite };
}

// Parses a catalog `cost` object. Any malformed field (or tier) makes the whole entry unknown (null), never a
// partial price.
export function parseModelRates(v: unknown): ModelRates | null {
  const card = parseCard(v);
  if (!card || !isObject(v)) return null;
  if (v.tiers === undefined) return card;
  if (!Array.isArray(v.tiers)) return null;
  const tiers: NonNullable<ModelRates["tiers"]> = [];
  for (const t of v.tiers) {
    const tc = parseCard(t);
    const above = isObject(t) ? rate(t.inputTokensAbove) : null;
    if (!tc || above === null) return null;
    tiers.push({ ...tc, inputTokensAbove: above });
  }
  return { ...card, tiers };
}

// Pi `calculateCost`, operation for operation (so floating-point results match), in USD.
export function costUsd(model: ModelRates, usage: UsageTokens): number {
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  let rates: RateCard = model;
  let matchedThreshold = -1;
  for (const tier of model.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      rates = tier;
      matchedThreshold = tier.inputTokensAbove;
    }
  }
  const longWrite = usage.cacheWrite1h ?? 0;
  const shortWrite = usage.cacheWrite - longWrite;
  const input = (rates.input / 1000000) * usage.input;
  const output = (rates.output / 1000000) * usage.output;
  const cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
  const cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;
  return input + output + cacheRead + cacheWrite;
}

// Charge in whole micro-USD, rounded up so a real sub-micro remainder never under-charges. The product is first
// trimmed to 12 significant digits so float noise (50.00000000000001) does not add a spurious micro.
export function chargeMicros(model: ModelRates, usage: UsageTokens): number {
  return Math.ceil(Number((costUsd(model, usage) * 1_000_000).toPrecision(12)));
}

// The highest output rate across the base card and every tier, in micros per output token (USD per MTok equals
// micros per token). Sizes reservations conservatively whatever tier the request lands in.
export function maxOutputMicrosPerToken(model: ModelRates): number {
  return Math.max(model.output, ...(model.tiers ?? []).map((t) => t.output));
}

// The highest price of one prompt token across the base card and every tier, in micros: the larger of the plain
// input rate and the cache-write rates (a 1h write bills at 2x input). Sizes the prompt part of a reservation.
export function maxInputMicrosPerToken(model: ModelRates): number {
  const cards: RateCard[] = [model, ...(model.tiers ?? [])];
  return Math.max(...cards.map((c) => Math.max(c.input * 2, c.cacheWrite)));
}

// A request carries the model id Pi sent. Pi's catalog ids may themselves contain a slash (openrouter
// `anthropic/claude-fable-5`), so the exact id is tried first and a leading `<provider>/` is stripped only on a miss.
export function lookupRates(models: ReadonlyMap<string, ModelRates>, provider: string, model: string): ModelRates | null {
  const exact = models.get(model);
  if (exact) return exact;
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? (models.get(model.slice(prefix.length)) ?? null) : null;
}

// Builds a source over per-provider id -> rates maps.
export function ratesSourceOf(byProvider: ReadonlyMap<string, ReadonlyMap<string, ModelRates>>): RatesSource {
  let input = 0;
  let output = 0;
  let any = false;
  for (const models of byProvider.values())
    for (const model of models.values()) {
      any = true;
      input = Math.max(input, maxInputMicrosPerToken(model));
      output = Math.max(output, maxOutputMicrosPerToken(model));
    }
  const ceiling: RateCeiling | null = any ? { inputMicrosPerToken: input, outputMicrosPerToken: output } : null;
  return { lookup: (provider, model) => lookupRates(byProvider.get(provider) ?? new Map(), provider, model), ceiling: () => ceiling };
}

// A Pi catalog model entry -> its id and rates. Only chat models (type absent or "chat") carry token prices that
// Pi's chat path uses; an entry without a valid `cost` is dropped (unknown), never priced at zero.
function modelEntry(v: unknown): [string, ModelRates] | null {
  if (!isObject(v) || typeof v.id !== "string") return null;
  if (v.type !== undefined && v.type !== "chat") return null;
  const rates = parseModelRates(v.cost);
  return rates ? [v.id, rates] : null;
}

// Parses a built-in `<provider>.json` (api -> key -> model), later entries winning by id like Pi's
// flattenChatModelCatalog.
export function parseCatalogFile(json: unknown): Map<string, ModelRates> {
  const out = new Map<string, ModelRates>();
  if (!isObject(json)) return out;
  for (const group of Object.values(json)) {
    if (!isObject(group)) continue;
    for (const model of Object.values(group)) {
      if (isObject(model) && model.type !== "chat") continue;
      const e = modelEntry(model);
      if (e) out.set(e[0], e[1]);
    }
  }
  return out;
}

// Pi's persisted pi.dev overlay (`models-store.json` entry for one provider): used only when it is newer than the
// built-in data (`lastModified` > manifest `generatedAt`) and then wins by id (Pi's remoteModels/mergeModels).
export function parseStoreOverlay(entry: unknown, generatedAt: number | undefined): Map<string, ModelRates> {
  const out = new Map<string, ModelRates>();
  if (!isObject(entry) || !Array.isArray(entry.models)) return out;
  if (generatedAt !== undefined && !(typeof entry.lastModified === "number" && entry.lastModified > generatedAt)) return out;
  for (const model of entry.models) {
    const e = modelEntry(model);
    if (e) out.set(e[0], e[1]);
  }
  return out;
}
