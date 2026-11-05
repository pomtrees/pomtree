// Structural twin of pomtreed's RatesSource / ModelRates (testing depends on core only, so it cannot import pomtreed).
export interface FakeRateCard {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface FakeModelRates extends FakeRateCard {
  tiers?: Array<FakeRateCard & { inputTokensAbove: number }>;
}

// Scripts a pricing catalog (provider -> model id -> rates, USD per MTok) and records every lookup, so tests can
// assert which (provider, model) the pricer asked for. Matching is exact: unscripted ids are unknown (null); model-id normalisation is the real source's job.
export class FakeRatesSource {
  readonly lookups: Array<{ provider: string; model: string }> = [];
  private readonly catalog: Map<string, Map<string, FakeModelRates>>;

  constructor(catalog: Record<string, Record<string, FakeModelRates>> = {}) {
    this.catalog = new Map(Object.entries(catalog).map(([provider, models]) => [provider, new Map(Object.entries(models))]));
  }

  lookup(provider: string, model: string): FakeModelRates | null {
    this.lookups.push({ provider, model });
    return this.catalog.get(provider)?.get(model) ?? null;
  }
}
