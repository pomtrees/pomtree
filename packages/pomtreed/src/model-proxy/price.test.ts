import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeRatesSource } from "@pomtree/testing";
import { createPrice, createRequestEstimate } from "./price.ts";
import { chargeMicros, ratesSourceOf } from "./rates.ts";
import type { ModelRates } from "./rates.ts";

// USD per MTok; 1 / 2 makes micros equal input + 2 * output tokens for the plain cases.
const plain: ModelRates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
const tiered: ModelRates = {
  input: 0.1,
  output: 0.5,
  cacheRead: 0.01,
  cacheWrite: 0.125,
  tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
};
const fake = () => new FakeRatesSource({ p: { m: plain, t: tiered, "a/b": plain } });
const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
const req = enc({ model: "m" });
const charge = createPrice(fake(), "p");
// The charge's micros (null when unpriceable); the basis is asserted on `charge` itself, below.
const price = (...args: Parameters<typeof charge>) => charge(...args)?.micros ?? null;
const priceOf = (usage: unknown, request = req) => price(enc({ usage }), new Headers(), request);

test("prices Anthropic usage (input_tokens/output_tokens) from the catalog", () => {
  assert.equal(priceOf({ input_tokens: 3, output_tokens: 4 }), 11);
});

test("prices OpenAI usage (prompt_tokens/completion_tokens) from the catalog", () => {
  assert.equal(priceOf({ prompt_tokens: 10, completion_tokens: 20 }), 50);
});

test("looks up (provider, request model) and records it", () => {
  const rates = fake();
  createPrice(rates, "p")(enc({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), new Headers(), enc({ model: "m" }));
  assert.deepEqual(rates.lookups, [{ provider: "p", model: "m" }]);
});

test("cache-aware OpenAI fields: prompt_tokens includes cached and written tokens", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["prompt_tokens_details.cached_tokens", { prompt_tokens_details: { cached_tokens: 600 } }],
    ["prompt_cache_hit_tokens", { prompt_cache_hit_tokens: 600 }],
    ["top-level cached_tokens", { cached_tokens: 600 }],
  ];
  for (const [name, extra] of cases)
    assert.equal(
      priceOf({ prompt_tokens: 1000, completion_tokens: 100, ...extra }),
      chargeMicros(plain, { input: 400, output: 100, cacheRead: 600, cacheWrite: 0 }),
      name,
    );
  assert.equal(
    priceOf({ prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 500 } }),
    chargeMicros(plain, { input: 200, output: 100, cacheRead: 300, cacheWrite: 500 }),
  );
  // cached + written above the prompt cannot go negative (Pi clamps the uncached remainder at 0)
  assert.equal(
    priceOf({ prompt_tokens: 10, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 8, cache_write_tokens: 8 } }),
    chargeMicros(plain, { input: 0, output: 0, cacheRead: 8, cacheWrite: 8 }),
  );
});

test("cache-aware Anthropic fields, including the 1h share", () => {
  assert.equal(
    priceOf({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 3000 }),
    chargeMicros(plain, { input: 100, output: 50, cacheRead: 2000, cacheWrite: 3000, cacheWrite1h: 0 }),
  );
  assert.equal(
    priceOf({ input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_1h_input_tokens: 1000 } }),
    chargeMicros(plain, { input: 100, output: 50, cacheRead: 0, cacheWrite: 3000, cacheWrite1h: 1000 }),
  );
  assert.equal(priceOf({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 6 } }), null); // 1h > write
  assert.equal(priceOf({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: "x" }), null);
});

test("tier boundary picks the tier by input + cache tokens", () => {
  const t = enc({ model: "t" });
  assert.equal(
    priceOf({ prompt_tokens: 100000, completion_tokens: 1000 }, t),
    chargeMicros(tiered, { input: 100000, output: 1000, cacheRead: 0, cacheWrite: 0 }),
  );
  const above = priceOf({ prompt_tokens: 100001, completion_tokens: 1000 }, t);
  assert.equal(above, chargeMicros(tiered, { input: 100001, output: 1000, cacheRead: 0, cacheWrite: 0 }));
  assert.ok(above !== null && above > 100001 * 0.5 && above < 100001 * 0.5 + 1000 * 2.5 + 1);
});

test("provider usage.cost takes precedence over the catalog, without any lookup", () => {
  const rates = fake();
  const p = (...args: Parameters<typeof charge>) => createPrice(rates, "p")(...args)?.micros ?? null;
  assert.equal(p(enc({ usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.0000105 } }), new Headers(), req), 11);
  assert.equal(p(enc({ usage: { cost: 0.5 } }), new Headers(), enc({ model: "unknown" })), 500_000);
  assert.deepEqual(rates.lookups, []);
});

test("an unknown or missing request model prices to null (the proxy settles the per-request maximum)", () => {
  assert.equal(priceOf({ prompt_tokens: 10, completion_tokens: 20 }, enc({ model: "unknown" })), null);
  assert.equal(priceOf({ prompt_tokens: 10, completion_tokens: 20 }, enc({})), null);
  assert.equal(priceOf({ prompt_tokens: 10, completion_tokens: 20 }, enc("not json")), null);
  assert.equal(priceOf({ prompt_tokens: 10, completion_tokens: 20 }, enc({ model: 5 })), null);
});

test("the request model id is normalised through the real rates source", () => {
  const src = ratesSourceOf(
    new Map([
      [
        "p",
        new Map([
          ["m", plain],
          ["a/b", plain],
        ]),
      ],
    ]),
  );
  const p = (...args: Parameters<typeof charge>) => createPrice(src, "p")(...args)?.micros ?? null;
  const body = enc({ usage: { prompt_tokens: 10, completion_tokens: 20 } });
  assert.equal(p(body, new Headers(), enc({ model: "m" })), 50);
  assert.equal(p(body, new Headers(), enc({ model: "p/m" })), 50);
  assert.equal(p(body, new Headers(), enc({ model: "a/b" })), 50);
  assert.equal(p(body, new Headers(), enc({ model: "x/m" })), null);
});

test("fails closed for unparseable, unknown, and partial usage", () => {
  assert.equal(price(enc("not json"), new Headers(), req), null);
  assert.equal(price(enc("null"), new Headers(), req), null);
  assert.equal(price(enc("[]"), new Headers(), req), null);
  assert.equal(price(enc("{}"), new Headers(), req), null);
  assert.equal(priceOf({}), null);
  assert.equal(priceOf({ input_tokens: 1 }), null); // partial Anthropic
  assert.equal(priceOf({ prompt_tokens: 1, completion_tokens: "x" }), null); // invalid OpenAI
  assert.equal(priceOf({ input_tokens: -1, output_tokens: 2 }), null); // negative
});

const sse = () => new Headers({ "content-type": "text/event-stream" });
const chunk = (delta: unknown, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ choices: [{ delta }], ...extra })}\n\n`;

test("prices a streaming (SSE) OpenAI response from the final usage chunk", () => {
  const body = new TextEncoder().encode(
    `${chunk({ role: "assistant", content: "hi" })}${chunk({}, { finish_reason: "stop", usage: { prompt_tokens: 10, completion_tokens: 20 } })}data: [DONE]\n\n`,
  );
  assert.equal(price(body, sse(), req), 50);
});

test("prices a streaming (SSE) Anthropic usage shape", () => {
  const body = new TextEncoder().encode(
    `${chunk({ role: "assistant" })}${chunk({}, { finish_reason: "stop", usage: { input_tokens: 3, output_tokens: 4 } })}data: [DONE]\n\n`,
  );
  assert.equal(price(body, sse(), req), 11);
});

test("detects SSE by leading data: even without an event-stream content type", () => {
  const body = new TextEncoder().encode(`${chunk({}, { finish_reason: "stop", usage: { prompt_tokens: 1, completion_tokens: 2 } })}data: [DONE]\n\n`);
  assert.equal(price(body, new Headers({ "content-type": "application/json" }), req), 5);
});

const CHAT = "/chat/completions";
type Outcome = ReturnType<ReturnType<typeof createRequestEstimate>>;
// The two amounts only (the output term capOutputTokens reads is tested on its own).
const estOf = (o: Outcome): { reserveMicros: number; floorMicros: number } | null => {
  if (!("estimate" in o)) return assert.fail(`refused: ${o.refuse}`);
  return o.estimate && { reserveMicros: o.estimate.reserveMicros, floorMicros: o.estimate.floorMicros };
};
const refusal = (o: Outcome): string => ("refuse" in o ? o.refuse : assert.fail("not refused"));

test("request estimate adds the prompt to the largest requested limit at the model's highest rates, null when the model is unknown", () => {
  const est = createRequestEstimate(fake(), "p");
  const at = (v: unknown, path = CHAT) => estOf(est(enc(v), path));
  // The prompt is priced from the canonical re-serialisation that is forwarded.
  const promptOf = (v: unknown, perToken: number) => Math.ceil((enc(v).length / 4) * perToken);
  const a = { model: "m", max_tokens: 10 };
  // plain: input 1 -> 2 (1h cache-write cost) vs cacheWrite 1.25, so 2 micros per prompt token; output 2.
  assert.deepEqual(at(a), { reserveMicros: promptOf(a, 2) + 20, floorMicros: promptOf(a, 2) + 20 });
  const b = { model: "m", max_tokens: 10, max_completion_tokens: 30 };
  assert.deepEqual(at(b), { reserveMicros: promptOf(b, 2) + 60, floorMicros: promptOf(b, 2) + 60 });
  const c = { model: "m", max_tokens: 1000 };
  assert.deepEqual(at(c), { reserveMicros: promptOf(c, 2) + 2000, floorMicros: promptOf(c, 2) + 512 }); // floor: MIN_OUTPUT_TOKENS of output
  const d = { model: "t", max_tokens: 100 };
  assert.deepEqual(at(d), { reserveMicros: promptOf(d, 1) + 250, floorMicros: promptOf(d, 1) + 250 }); // highest tier: output 2.5, input 0.5 x 2
  assert.equal(at({ model: "unknown", max_tokens: 10 }), null); // the proxy reserves its fixed amount instead
  assert.equal(at({ max_tokens: 10 }), null);
});

test("request estimate refuses a body with no valid output limit for the endpoint, for known and unknown models alike", () => {
  const est = createRequestEstimate(fake(), "p");
  const at = (v: unknown, path = CHAT) => est(enc(v), path);
  for (const model of ["m", "t", "unknown", undefined]) {
    assert.match(refusal(at({ model })), /output token limit required for \/chat\/completions: set max_tokens or max_completion_tokens$/, String(model));
  }
  assert.match(refusal(at({ model: "m", messages: [{ role: "user", content: "x".repeat(100_000) }] })), /limit required/);
  assert.match(refusal(at({ model: "t", stream: true })), /limit required/);
});

test("request estimate accepts only the limit fields the endpoint honours", () => {
  const est = createRequestEstimate(fake(), "p");
  const ok = (field: string, path: string) => assert.ok("estimate" in est(enc({ model: "m", [field]: 5 }), path), `${field} on ${path}`);
  const bad = (field: string, path: string) => assert.match(refusal(est(enc({ model: "m", [field]: 5 }), path)), /limit required/, `${field} on ${path}`);
  for (const prefix of ["", "/v1"]) {
    ok("max_tokens", `${prefix}/messages`);
    bad("max_output_tokens", `${prefix}/messages`);
    bad("max_completion_tokens", `${prefix}/messages`);
    ok("max_output_tokens", `${prefix}/responses`);
    bad("max_tokens", `${prefix}/responses`);
    bad("max_completion_tokens", `${prefix}/responses`);
    for (const path of [`${prefix}/chat/completions`, `${prefix}/completions`, `${prefix}/chat/completions/`]) {
      ok("max_tokens", path);
      ok("max_completion_tokens", path);
      bad("max_output_tokens", path);
    }
  }
  assert.match(refusal(est(enc({ model: "m", max_tokens: 5 }), "/responses")), /set max_output_tokens/);
  assert.match(refusal(est(enc({ model: "m" }), "/messages")), /set max_tokens$/);
  assert.match(refusal(est(enc({ model: "m" }), "/responses")), /supportsMaxOutputTokens=false omits it\)$/);
  ok("max_output_tokens", "/custom/endpoint"); // a custom allowed path accepts the union
});

test("request estimate refuses a limit that is not a positive safe integer, and a body that is not a JSON object", () => {
  const est = createRequestEstimate(fake(), "p");
  for (const model of ["m", "unknown"])
    for (const v of [0, -1, 1.5, 5e-324, "9", null, true, [5], { a: 1 }, 2 ** 53, 1e300])
      assert.match(
        refusal(est(enc({ model, max_tokens: v }), CHAT)),
        /invalid output token limit: max_tokens must be a positive integer/,
        `${model} ${JSON.stringify(v)}`,
      );
  assert.ok("estimate" in est(enc({ model: "m", max_tokens: 2 ** 53 - 1 }), CHAT));
  for (const body of [
    "not json",
    "",
    "[]",
    "5",
    "null",
    '"s"',
    '{"model":"m","max_tokens":NaN}',
    '{"model":"m","max_tokens":Infinity}',
    "{",
    '[{"max_tokens":5}]',
  ])
    assert.equal(refusal(est(enc(body), CHAT)), "request body must be a JSON object", body);
});

test("request estimate multiplies the output by n and best_of, and refuses malformed ones", () => {
  const est = createRequestEstimate(fake(), "p");
  const reserve = (extra: object) => estOf(est(enc({ model: "m", max_tokens: 100, ...extra }), "/completions"))!.reserveMicros;
  const base = reserve({});
  const prompt = (extra: object) => Math.ceil((enc({ model: "m", max_tokens: 100, ...extra }).length / 4) * 2);
  assert.equal(base, prompt({}) + 200);
  assert.equal(reserve({ n: 3 }), prompt({ n: 3 }) + 600);
  assert.equal(reserve({ best_of: 4 }), prompt({ best_of: 4 }) + 800);
  assert.equal(reserve({ n: 2, best_of: 5 }), prompt({ n: 2, best_of: 5 }) + 2000);
  for (const name of ["n", "best_of"])
    for (const v of [0, -1, 1.5, "2", null, 2 ** 53])
      assert.match(
        refusal(est(enc({ model: "m", max_tokens: 5, [name]: v }), CHAT)),
        new RegExp(`invalid ${name}: must be a positive integer`),
        `${name} ${JSON.stringify(v)}`,
      );
  assert.equal(estOf(est(enc({ model: "unknown", max_tokens: 5, n: 2 }), CHAT)), null);
  const huge = estOf(est(enc({ model: "m", max_tokens: 2 ** 53 - 1, n: 2 ** 53 - 1, best_of: 2 ** 53 - 1 }), CHAT))!;
  assert.equal(huge.reserveMicros, Number.MAX_SAFE_INTEGER);
});

test("request estimate refuses a case-variant of a limit key and canonicalises the body it forwards (duplicate keys: last wins, as parsed)", () => {
  const est = createRequestEstimate(fake(), "p");
  for (const key of ["MAX_TOKENS", "Max_Tokens", "N", "Best_Of", "Max_Output_Tokens"])
    assert.match(refusal(est(enc(`{"model":"m","max_tokens":5,"${key}":9}`), CHAT)), /ambiguous key/, key);
  const out = est(enc('{"model":"m","max_tokens":999999,"max_tokens":5}'), CHAT);
  assert.ok("body" in out);
  assert.equal(new TextDecoder().decode(out.body), '{"model":"m","max_tokens":5}'); // the upstream can only see the limit that was priced
  assert.equal(estOf(out)!.reserveMicros < 100, true);
});

test("request estimate prices the prompt from UTF-8 bytes at the highest input rate, and clamps an absurd limit to a safe integer", () => {
  const est = createRequestEstimate(fake(), "p");
  const body = (content: string) => enc({ model: "m", max_tokens: 1, messages: [{ role: "user", content }] });
  const ascii = body("a".repeat(400));
  const cjk = body("日".repeat(400)); // 3 bytes per character: three times the prompt, not the same
  const priceOf = (b: Uint8Array) => estOf(est(b, CHAT))!.reserveMicros;
  assert.equal(priceOf(ascii), Math.ceil((ascii.length / 4) * 2) + 2);
  assert.equal(priceOf(cjk), Math.ceil((cjk.length / 4) * 2) + 2);
  assert.ok(cjk.length - ascii.length === 800 && priceOf(cjk) - priceOf(ascii) === 400);
  const huge = estOf(est(enc({ model: "m", max_tokens: Number.MAX_SAFE_INTEGER }), CHAT))!;
  assert.equal(huge.reserveMicros, Number.MAX_SAFE_INTEGER);
  assert.ok(Number.isSafeInteger(huge.floorMicros) && huge.floorMicros < 1_000);
});

test("fails closed for SSE with no usage chunk", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  assert.equal(price(enc(`${chunk({ role: "assistant", content: "hi" })}data: [DONE]\n\n`), sse(), req), null);
  assert.equal(price(enc("data: not json\n\ndata: [DONE]\n\n"), sse(), req), null);
});

test("charges provider-reported usage.cost (JSON), even below the catalog price", () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  // The catalog would be 50 micros; the provider reports $0.0000105 = 10.5 -> ceil 11 micros.
  assert.equal(price(enc({ usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.0000105 } }), new Headers(), req), 11);
  assert.equal(price(enc({ usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.5 } }), new Headers(), req), 500_000);
  assert.equal(price(enc({ usage: { cost: 0.000002 } }), new Headers(), req), 2);
});

test("charges provider-reported usage.cost from the final SSE chunk", () => {
  const body = new TextEncoder().encode(
    `${chunk({ content: "hi" })}${chunk({}, { finish_reason: "stop", usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.000007 } })}data: [DONE]\n\n`,
  );
  assert.equal(price(body, sse(), req), 7);
});

test("reported zero cost is free only when tokens are zero or absent", () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  assert.equal(price(enc({ usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0 } }), new Headers(), req), 50); // catalog
  assert.equal(price(enc({ usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 } }), new Headers(), req), 0);
  assert.equal(price(enc({ usage: { cost: 0 } }), new Headers(), req), 0);
});

test("missing, negative, non-finite, and string cost fall back to catalog pricing", () => {
  const tokens = { prompt_tokens: 10, completion_tokens: 20 };
  const enc = (s: string) => new TextEncoder().encode(s);
  for (const cost of ["-1", '"0.001"', "null", "true"])
    assert.equal(price(enc(`{"usage":{"prompt_tokens":10,"completion_tokens":20,"cost":${cost}}}`), new Headers(), req), 50, cost);
  assert.equal(price(enc(`{"usage":{"prompt_tokens":10,"completion_tokens":20,"cost":1e999}}`), new Headers(), req), 50); // Infinity
  assert.equal(price(enc(JSON.stringify({ usage: tokens })), new Headers(), req), 50);
  assert.equal(price(enc(JSON.stringify({ usage: { cost: -1 } })), new Headers(), req), null); // no tokens either: unchanged fail-closed
  assert.equal(price(enc('{"usage":{"cost":"x"}}'), new Headers(), req), null);
});

test("unparsable body with cost-like text still fails closed", () => {
  assert.equal(price(new TextEncoder().encode('{"usage":{"cost":0.1'), new Headers(), req), null);
});

// The pricer makes the reported-vs-catalog choice once and carries it: the charge and its basis are asserted as a pair.
const chargeOf = (usage: unknown) => charge(enc({ usage }), new Headers(), req);

test("a positive provider cost is charged as reported, with basis reported", () => {
  assert.deepEqual(chargeOf({ prompt_tokens: 10, completion_tokens: 20, cost: 0.0000105 }), { micros: 11, basis: "reported" });
  assert.deepEqual(chargeOf({ cost: 0.5 }), { micros: 500_000, basis: "reported" });
});

test("the same body without a cost is priced from the catalog, with basis catalog (negative control)", () => {
  assert.deepEqual(chargeOf({ prompt_tokens: 10, completion_tokens: 20 }), { micros: 50, basis: "catalog" });
});

test("a zero cost with nonzero tokens, and a malformed cost, fall to the catalog basis", () => {
  assert.deepEqual(chargeOf({ prompt_tokens: 10, completion_tokens: 20, cost: 0 }), { micros: 50, basis: "catalog" });
  assert.deepEqual(chargeOf({ prompt_tokens: 10, completion_tokens: 20, cost: "0.5" }), { micros: 50, basis: "catalog" });
  assert.deepEqual(chargeOf({ prompt_tokens: 10, completion_tokens: 20, cost: -1 }), { micros: 50, basis: "catalog" });
});

test("a genuine free call (zero cost, zero tokens) is reported at 0 micros", () => {
  assert.deepEqual(chargeOf({ prompt_tokens: 0, completion_tokens: 0, cost: 0 }), { micros: 0, basis: "reported" });
});

test("an unpriceable body is still null, with no basis", () => {
  assert.equal(chargeOf({ cost: "x" }), null);
  assert.equal(charge(enc("{}"), new Headers(), req), null);
});
