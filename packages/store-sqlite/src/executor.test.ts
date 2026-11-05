import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StaleGenerationError } from "@pomtree/core";
import type { NewAgent, SpawnSpec } from "@pomtree/core";
import { openStore } from "./store.ts";
import { tmpDir } from "@pomtree/testing";

const spec = { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" } } as unknown as SpawnSpec;
const base = { parent: null, name: "n", task: "t", host: "h", budgetMicros: 100 };

test("a create without an executor is a container agent with its SpawnSpec intact", async () => {
  const s = openStore();
  const a = await s.registry.create({ ...base, idempotencyKey: "c", spec } as NewAgent);
  assert.equal(a.executor, "container");
  assert.deepEqual(a.spec, spec);
  s.close();
});

test("a deterministic spec round-trips through the spec column, with no container fields", async () => {
  const s = openStore();
  const input = { urls: ["https://a.example/x"], limit: 5, nested: { ok: true, none: null } };
  const a = await s.registry.create({ ...base, executor: "deterministic", spec: { driver: "fetch-diff", input }, idempotencyKey: "d" });
  assert.equal(a.executor, "deterministic");
  assert.deepEqual(a.spec, { driver: "fetch-diff", input });
  assert.equal("image" in a.spec, false);
  const got = await s.registry.get(a.id);
  assert.equal(got?.executor, "deterministic");
  assert.deepEqual(got?.spec, { driver: "fetch-diff", input });
  s.close();
});

test("an unknown executor or a malformed deterministic spec is rejected and nothing is stored", async () => {
  const s = openStore();
  await assert.rejects(s.registry.create({ ...base, executor: "task", spec, idempotencyKey: "k1" } as unknown as NewAgent), /unknown executor/);
  await assert.rejects(
    s.registry.create({
      ...base,
      executor: "deterministic",
      spec: { driver: "d", input: null, executor: "deterministic" },
      idempotencyKey: "k2",
    } as unknown as NewAgent),
    /exactly driver and input/,
  );
  await assert.rejects(
    s.registry.create({ ...base, executor: "deterministic", spec: { driver: "", input: null }, idempotencyKey: "k3" } as unknown as NewAgent),
    /non-empty string/,
  );
  await assert.rejects(
    s.registry.create({ ...base, executor: "deterministic", spec: { driver: "d", input: undefined }, idempotencyKey: "k4" } as unknown as NewAgent),
    /JSON data/,
  );
  assert.deepEqual(await s.registry.list(), []);
  s.close();
});

test("the executor CHECK rejects a raw row with an unknown kind", async () => {
  const dir = tmpDir("store-check-");
  const file = join(dir, "s.sqlite");
  openStore(file).close();
  const d = new DatabaseSync(file);
  assert.throws(
    () =>
      d.exec(
        "INSERT INTO agents (id,name,task,state,host,generation,budget_micros,created_at,updated_at,seq,spec,executor) VALUES ('x','n','t','pending','h',0,1,0,0,0,'{}','task')",
      ),
    /CHECK constraint/,
  );
  d.close();
});

test("a repeated keyed create yields one row and the same record", async () => {
  const s = openStore();
  const d = { ...base, executor: "deterministic" as const, spec: { driver: "d", input: 1 }, idempotencyKey: "same", id: "fixed" };
  const first = await s.registry.create(d);
  const again = await s.registry.create(d);
  assert.deepEqual(again, first);
  assert.equal((await s.registry.list()).length, 1);
  s.close();
});

test("stale-generation transitions and bumps on a deterministic agent are still rejected", async () => {
  const s = openStore();
  const a = await s.registry.create({ ...base, executor: "deterministic", spec: { driver: "d", input: null }, idempotencyKey: "g" });
  await assert.rejects(s.registry.transition(a.id, 7, "running", { idempotencyKey: "t7" }), StaleGenerationError);
  await s.registry.bumpGeneration(a.id, "h2", "bump");
  await assert.rejects(s.registry.transition(a.id, 0, "running", { idempotencyKey: "t0" }), StaleGenerationError);
  assert.equal((await s.registry.get(a.id))?.executor, "deterministic");
  s.close();
});
