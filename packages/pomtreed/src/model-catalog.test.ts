import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { handle } from "./api.ts";
import { issueToken } from "./auth.ts";
import { buildModelList, parsePiModelList, piModelCatalog } from "./model-catalog.ts";
import type { ExecFn } from "./model-catalog.ts";
import { SECRET, setup, until } from "./test-setup.ts";

// Real `pi --list-models` output (Pi 1.0.2), provider/model names only.
const SAMPLE = readFileSync(new URL("./fixtures/pi-list-models.txt", import.meta.url), "utf8");

test("parser reads the real table, skipping header and notices", () => {
  const m = parsePiModelList(SAMPLE);
  assert.equal(m.length, 40);
  assert.deepEqual(m[0], { provider: "anthropic", id: "claude-fable-5", label: "claude-fable-5 (1M ctx)" });
  assert.ok(m.some((x) => x.provider === "baseten" && x.id === "zai-org/GLM-5.3"));
  assert.ok(!m.some((x) => x.provider === "provider"));
  assert.deepEqual(parsePiModelList('No models matching "zzz"\n'), []);
  assert.deepEqual(parsePiModelList(""), []);
  assert.equal(parsePiModelList("a  m  1K\na  m  1K\n").length, 1);
});

test("buildModelList: default is the first model of the provider; none when pi lists nothing", () => {
  const parsed = parsePiModelList(SAMPLE);
  const a = buildModelList({ parsed });
  assert.deepEqual(a.default, { provider: "anthropic", id: "claude-fable-5" });
  assert.equal(a.models.filter((m) => m.default).length, 1);
  const b = buildModelList({ parsed, provider: "baseten" });
  assert.equal(b.default?.provider, "baseten");
  assert.equal(b.default?.id, parsed.find((m) => m.provider === "baseten")!.id);
  assert.equal(buildModelList({ parsed, provider: "nope" }).default, undefined);
  const pi = buildModelList({ parsed, piDefault: { provider: "anthropic", id: "claude-haiku-4-5" } });
  assert.equal(pi.default?.id, "claude-haiku-4-5");
  assert.equal(pi.models.filter((m) => m.default).length, 1);
  assert.equal(buildModelList({ parsed, piDefault: { id: "nope" } }).default?.id, "claude-fable-5");
  assert.equal(buildModelList({ parsed, provider: "baseten", piDefault: { provider: "anthropic", id: "claude-haiku-4-5" } }).default?.provider, "baseten");
  assert.deepEqual(buildModelList({ parsed: null, failure: "boom", provider: "p" }), { models: [], source: "none", reason: "boom" });
  assert.deepEqual(buildModelList({ parsed: [] }), { models: [], source: "none", reason: "pi listed no models" });
});

test("catalog caches for the ttl, fails soft, and passes --list-models with limits", async () => {
  let calls = 0;
  let clock = 0;
  const seen: unknown[] = [];
  const exec: ExecFn = async (cmd, args, o) => {
    calls++;
    seen.push([cmd, args, o.maxBytes > 0 && o.timeoutMs > 0]);
    return SAMPLE;
  };
  const cat = piModelCatalog({ exec, now: () => clock, piDefault: () => ({}) });
  const [x, y] = await Promise.all([cat.list(), cat.list()]);
  assert.equal(calls, 1);
  assert.equal(x.source, "pi");
  assert.equal(y, x);
  assert.deepEqual(seen[0], ["pi", ["--list-models"], true]);
  clock = 59_000;
  await cat.list();
  assert.equal(calls, 1);
  clock = 61_000;
  await cat.list();
  assert.equal(calls, 2);

  const failing = piModelCatalog({
    exec: async () => {
      throw new Error("ENOENT: pi\nstack");
    },
    provider: "p",
  });
  const f = await failing.list();
  assert.equal(f.source, "none");
  assert.match(f.reason!, /pi --list-models failed: ENOENT/);
  assert.ok(!f.reason!.includes("stack"));
  const none = await piModelCatalog({
    exec: async () => {
      throw new Error("x");
    },
  }).list();
  assert.equal(none.source, "none");
  assert.deepEqual(none.models, []);
});

const catalog = (value: Awaited<ReturnType<ReturnType<typeof piModelCatalog>["list"]>>) => ({ list: async () => value });
const LIST = {
  models: [
    { provider: "p", id: "m1", default: true },
    { provider: "p", id: "a/b" },
  ],
  default: { provider: "p", id: "m1" },
  source: "pi" as const,
};

test("GET /v1/models is operator-only", async () => {
  const t = setup(async () => {}, { models: catalog(LIST) });
  const ok = await t.operator("GET", "/v1/models");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, LIST);
  for (const token of [issueToken(SECRET, { scope: "host", channel: "web" }), issueToken(SECRET, { scope: "ext", name: "x" }), undefined]) {
    const r = await handle(t.daemon, { method: "GET", url: "/v1/models", token });
    assert.ok(r.status === 403 || r.status === 401, String(r.status));
  }
  const bare = setup(async () => {}, { models: undefined }); // no catalog wired (library use)
  assert.equal(((await bare.operator("GET", "/v1/models")).body as { source: string }).source, "none");
});

test("POST /v1/agents validates model, persists it, passes it to the command, children inherit, resume keeps it", async () => {
  const cmds: Array<{ task: string; spec?: { provider?: string; model?: string } }> = [];
  let child: string | undefined;
  const t = setup(
    async (c) => {
      if (c.agent === child) await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
    },
    { models: catalog(LIST), command: (task, spec) => (cmds.push({ task, spec }), [task]) },
  );
  const body = (k: string, model: unknown) => ({ task: "t", idempotencyKey: k, model });
  assert.equal((await t.operator("POST", "/v1/agents", body("k0", { provider: "p", id: "nope" }))).status, 400);
  assert.equal((await t.operator("POST", "/v1/agents", body("k0", "p/m1"))).status, 400);
  assert.equal((await t.operator("POST", "/v1/agents", body("k0", { provider: "p" }))).status, 400);
  const res = await t.operator("POST", "/v1/agents", body("k1", { provider: "p", id: "a/b" }));
  assert.equal(res.status, 201);
  const rec = (await t.daemon.get((res.body as { id: string }).id))!;
  assert.ok(rec.executor === "container");
  assert.equal(rec.spec.provider, "p");
  assert.equal(rec.spec.model, "a/b");
  await until(() => cmds.length > 0);
  assert.deepEqual(cmds[0]!.spec, { provider: "p", model: "a/b" });
  // child inherits the parent's model; an explicit one overrides
  child = undefined;
  const inh = await t.daemon.spawn(rec.id, { name: "c", task: "x", idempotencyKey: "c1", budgetMicros: 100 });
  assert.ok(inh.executor === "container");
  assert.equal(inh.spec.model, "a/b");
  const ovr = await t.daemon.spawn(rec.id, { name: "c", task: "x", idempotencyKey: "c2", budgetMicros: 100, model: { provider: "p", id: "m1" } });
  assert.ok(ovr.executor === "container");
  assert.deepEqual([ovr.spec.provider, ovr.spec.model], ["p", "m1"]);
});

test("a spawn naming no model: root gets the catalog's first, a child inherits its parent's, explicit wins", async () => {
  const t = setup(async () => {}, { models: catalog(LIST), provider: "p" });
  const spec = async (r: { body: unknown }) => {
    const rec = (await t.daemon.get((r.body as { id: string }).id))!;
    assert.ok(rec.executor === "container");
    return rec.spec;
  };
  const root = await t.operator("POST", "/v1/agents", { task: "t", idempotencyKey: "k2" });
  assert.equal(root.status, 201);
  const rs = await spec(root);
  assert.deepEqual([rs.provider, rs.model], ["p", "m1"]);
  const picked = await t.operator("POST", "/v1/agents", { task: "t", idempotencyKey: "k3", model: { provider: "p", id: "a/b" } });
  const kid = await t.daemon.spawn((picked.body as { id: string }).id, { name: "c", task: "x", idempotencyKey: "c1", budgetMicros: 100 });
  assert.ok(kid.executor === "container");
  assert.equal(kid.spec.model, "a/b");
  assert.equal((await spec(picked)).model, "a/b");
});

// Model tests only spawn container agents; narrow the record union before reading its spec.
const containerSpecOf = async (t: ReturnType<typeof setup>, r: { body: unknown }) => {
  const rec = (await t.daemon.get((r.body as { id: string }).id))!;
  assert.ok(rec.executor === "container");
  return rec.spec;
};

test("a spawn naming no model uses the catalog's resolved (Pi settings) default over the first listed", async () => {
  const t = setup(async () => {}, { models: catalog({ ...LIST, default: { provider: "p", id: "a/b" } }), provider: "p" });
  const r = await t.operator("POST", "/v1/agents", { task: "t", idempotencyKey: "k" });
  assert.equal((await containerSpecOf(t, r)).model, "a/b");
});

test("a spawn naming no model with an empty catalog is a 400 naming --model and pomtree models", async () => {
  const t = setup(async () => {}, { models: catalog({ models: [], source: "none", reason: "pi listed no models" }) });
  const r = await t.operator("POST", "/v1/agents", { task: "t", idempotencyKey: "k" });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(r.body), /--model PROVIDER\/ID.*pomtree models/);
  const ok = await t.operator("POST", "/v1/agents", { task: "t", idempotencyKey: "k2", model: { provider: "q", id: "z" } });
  assert.equal(ok.status, 201);
});

test("catalog source 'none' passes any model through", async () => {
  const t = setup(async () => {}, { models: catalog({ models: [], source: "none", reason: "x" }) });
  const r = await t.operator("POST", "/v1/agents", { task: "t", idempotencyKey: "k", model: { provider: "q", id: "z" } });
  assert.equal(r.status, 201);
  assert.equal((await containerSpecOf(t, r)).model, "z");
});
