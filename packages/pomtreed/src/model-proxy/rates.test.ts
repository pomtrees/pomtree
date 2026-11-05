import assert from "node:assert/strict";
import { test } from "node:test";
import { chargeMicros, costUsd, lookupRates, maxOutputMicrosPerToken, parseCatalogFile, parseModelRates, parseStoreOverlay, ratesSourceOf } from "./rates.ts";
import type { ModelRates, UsageTokens } from "./rates.ts";

// Verbatim port of Pi's calculateCost (pi-ai dist/models.js) as the parity oracle.
function piCalculateCost(model: { cost: ModelRates }, usage: UsageTokens & { cacheWrite1h?: number }): number {
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  let rates: ModelRates | NonNullable<ModelRates["tiers"]>[number] = model.cost;
  let matchedThreshold = -1;
  for (const tier of model.cost.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      rates = tier;
      matchedThreshold = tier.inputTokensAbove;
    }
  }
  const longWrite = usage.cacheWrite1h ?? 0;
  const shortWrite = usage.cacheWrite - longWrite;
  const cost = {
    input: (rates.input / 1000000) * usage.input,
    output: (rates.output / 1000000) * usage.output,
    cacheRead: (rates.cacheRead / 1000000) * usage.cacheRead,
    cacheWrite: (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000,
  };
  return cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
}

// Excerpts of the installed catalog (openrouter / deepseek `cost` objects).
const fable: ModelRates = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
const haiku: ModelRates = {
  input: 0.1,
  output: 0.5,
  cacheRead: 0.01,
  cacheWrite: 0.125,
  tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
};
const flash: ModelRates = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 };

test("charge reproduces Pi calculateCost exactly across plain, cache, tier-boundary and 1h cases", () => {
  const cases: Array<[string, ModelRates, UsageTokens]> = [
    ["plain", fable, { input: 1234, output: 567, cacheRead: 0, cacheWrite: 0 }],
    ["cache read", flash, { input: 800, output: 90, cacheRead: 12000, cacheWrite: 0 }],
    ["cache write", fable, { input: 100, output: 10, cacheRead: 50, cacheWrite: 7000 }],
    ["tier: at boundary stays base", haiku, { input: 100000, output: 1000, cacheRead: 0, cacheWrite: 0 }],
    ["tier: one above boundary", haiku, { input: 100001, output: 1000, cacheRead: 0, cacheWrite: 0 }],
    ["tier: boundary counts cache tokens", haiku, { input: 40000, output: 1000, cacheRead: 40000, cacheWrite: 20001 }],
    ["1h cache write", fable, { input: 10, output: 5, cacheRead: 0, cacheWrite: 3000, cacheWrite1h: 1000 }],
    ["zero usage", fable, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
  ];
  for (const [name, rates, usage] of cases) {
    const oracle = piCalculateCost({ cost: rates }, usage);
    assert.equal(costUsd(rates, usage), oracle, name);
    assert.equal(chargeMicros(rates, usage), Math.ceil(Number((oracle * 1e6).toPrecision(12))), name);
  }
  assert.notEqual(
    costUsd(haiku, { input: 100001, output: 1000, cacheRead: 0, cacheWrite: 0 }),
    costUsd(haiku, { input: 100000, output: 1000, cacheRead: 0, cacheWrite: 0 }) + 0.5 / 1e6,
    "the tier replaces all rates, not just the marginal token",
  );
});

test("charge rounds a real sub-micro remainder up but not float noise", () => {
  const r: ModelRates = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
  assert.equal(chargeMicros(r, { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }), 50); // 5.0000000000000004e-5 USD
  assert.equal(chargeMicros(r, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }), 1);
  assert.equal(chargeMicros({ input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0 }, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }), 1); // 0.5 -> 1
});

test("maxOutputMicrosPerToken takes the highest tier", () => {
  assert.equal(maxOutputMicrosPerToken(haiku), 2.5);
  assert.equal(maxOutputMicrosPerToken(fable), 50);
});

test("parseModelRates accepts a valid cost and rejects any malformed field or tier", () => {
  assert.deepEqual(parseModelRates(haiku), haiku);
  assert.deepEqual(parseModelRates(flash), flash);
  assert.equal(parseModelRates({ input: 1, output: 2, cacheRead: 0 }), null);
  assert.equal(parseModelRates({ input: -1, output: 2, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(parseModelRates({ input: "1", output: 2, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(parseModelRates({ ...flash, tiers: [{ inputTokensAbove: 5, input: 1 }] }), null);
  assert.equal(parseModelRates({ ...flash, tiers: "x" }), null);
  assert.equal(parseModelRates(null), null);
});

test("lookupRates tries the exact id first and strips a leading provider prefix only on a miss", () => {
  const models = new Map<string, ModelRates>([
    ["anthropic/claude-fable-5", fable],
    ["deepseek-flash", flash],
  ]);
  assert.equal(lookupRates(models, "openrouter", "anthropic/claude-fable-5"), fable); // slash is part of the id
  assert.equal(lookupRates(models, "deepseek", "deepseek-flash"), flash);
  assert.equal(lookupRates(models, "deepseek", "deepseek/deepseek-flash"), flash);
  assert.equal(lookupRates(models, "openrouter", "openrouter/anthropic/claude-fable-5"), fable);
  assert.equal(lookupRates(models, "deepseek", "other/deepseek-flash"), null);
  assert.equal(lookupRates(models, "deepseek", "nope"), null);
  assert.equal(ratesSourceOf(new Map([["deepseek", models]])).lookup("deepseek", "deepseek-flash"), flash);
  assert.equal(ratesSourceOf(new Map()).lookup("deepseek", "deepseek-flash"), null);
});

test("parseCatalogFile flattens api groups to chat models and drops non-chat and cost-less entries", () => {
  const file = {
    "anthropic-messages": { "chat:a/fable": { type: "chat", id: "a/fable", cost: fable } },
    "openai-completions": {
      "chat:flash": { type: "chat", id: "flash", cost: flash },
      "chat:nocost": { type: "chat", id: "nocost" },
      "image:img": { type: "image", id: "img", cost: flash },
    },
  };
  assert.deepEqual(
    [...parseCatalogFile(file)],
    [
      ["a/fable", fable],
      ["flash", flash],
    ],
  );
  assert.equal(parseCatalogFile("x").size, 0);
});

test("parseStoreOverlay applies only when newer than the built-in data, like Pi's remoteModels", () => {
  const entry = {
    models: [
      { id: "flash", cost: { ...flash, input: 9 } },
      { id: "bad", cost: {} },
    ],
    lastModified: 2000,
  };
  assert.equal(parseStoreOverlay(entry, 1000).get("flash")?.input, 9);
  assert.equal(parseStoreOverlay(entry, 1000).has("bad"), false);
  assert.equal(parseStoreOverlay(entry, 2000).size, 0); // not newer
  assert.equal(parseStoreOverlay({ models: entry.models }, 1000).size, 0); // no lastModified
  assert.equal(parseStoreOverlay({ models: entry.models }, undefined).size, 1); // no manifest date: Pi takes it
  assert.equal(parseStoreOverlay(undefined, 1).size, 0);
});

test("the catalog ceiling is the highest input and output micros per token across every model", () => {
  const models = new Map([
    ["a", { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }],
    ["b", { input: 0.5, output: 9, cacheRead: 0, cacheWrite: 3, tiers: [{ input: 1, output: 20, cacheRead: 0, cacheWrite: 0, inputTokensAbove: 100 }] }],
  ]);
  assert.deepEqual(ratesSourceOf(new Map([["p", models]])).ceiling?.(), { inputMicrosPerToken: 3, outputMicrosPerToken: 20 });
  assert.equal(ratesSourceOf(new Map()).ceiling?.(), null);
});
