import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExecutorSpec, isJsonValue, newAgentExecutor, parseDeterministicSpec } from "./executor.ts";
import type { NewAgent } from "./ports.ts";
import type { SpawnSpec } from "./types.ts";

const container = { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" } } as unknown as SpawnSpec;

test("isJsonValue accepts nested JSON and rejects non-JSON data", () => {
  assert.equal(isJsonValue({ a: [1, "x", null, true, { b: [] }] }), true);
  assert.equal(isJsonValue(undefined), false);
  assert.equal(isJsonValue(Number.NaN), false);
  assert.equal(isJsonValue(Number.POSITIVE_INFINITY), false);
  assert.equal(
    isJsonValue(() => 1),
    false,
  );
  assert.equal(isJsonValue(new Date(0)), false);
  const holey = [1, 2, 3];
  delete holey[1];
  assert.equal(isJsonValue(holey), false); // hole
  assert.equal(isJsonValue({ a: undefined }), false);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(isJsonValue(cyclic), false);
});

test("parseDeterministicSpec round-trips exactly { driver, input }", () => {
  const spec = { driver: "fetch-diff", input: { urls: ["https://a.example"], n: 3 } };
  assert.deepEqual(parseDeterministicSpec(JSON.parse(JSON.stringify(spec))), spec);
});

test("parseDeterministicSpec fails closed on extra keys, missing input, empty driver and non-object", () => {
  assert.throws(() => parseDeterministicSpec({ driver: "d", input: null, kind: "deterministic" }), /exactly driver and input/);
  assert.throws(() => parseDeterministicSpec({ driver: "d" }), /exactly driver and input/);
  assert.throws(() => parseDeterministicSpec({ driver: "  ", input: null }), /non-empty string/);
  assert.throws(() => parseDeterministicSpec({ driver: "d", input: undefined }), /JSON data/);
  assert.throws(() => parseDeterministicSpec(["d"]), /must be an object/);
  assert.throws(() => parseDeterministicSpec(null), /must be an object/);
});

test("checkExecutorSpec pairs each executor with its spec and rejects unknown kinds", () => {
  assert.deepEqual(checkExecutorSpec("container", container), { executor: "container", spec: container });
  assert.deepEqual(checkExecutorSpec("deterministic", { driver: "d", input: 1 }), { executor: "deterministic", spec: { driver: "d", input: 1 } });
  assert.throws(() => checkExecutorSpec("task", container), /unknown executor/);
  assert.throws(() => checkExecutorSpec(undefined, container), /unknown executor/);
  assert.throws(() => checkExecutorSpec("container", "not-an-object"), /container spec must be an object/);
  assert.throws(() => checkExecutorSpec("deterministic", container), /exactly driver and input/);
});

test("a NewAgent without an executor is a container agent", () => {
  const a = { parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, idempotencyKey: "k", spec: container } as NewAgent;
  assert.deepEqual(newAgentExecutor(a), { executor: "container", spec: container });
});

test("an explicit null or other non-undefined executor fails closed and does not mutate the spec", () => {
  const spec = { driver: "d", input: 1 };
  for (const executor of [null, "", "Container", 0, false]) {
    const a = { parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, idempotencyKey: "k", executor, spec } as unknown as NewAgent;
    assert.throws(() => newAgentExecutor(a), /unknown executor/);
  }
  assert.deepEqual(spec, { driver: "d", input: 1 });
});
