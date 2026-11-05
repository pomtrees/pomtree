import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { tmpDir } from "@pomtree/testing";
import { createExtensionRegistry } from "./extensions.ts";
import { WorkflowHost } from "./workflows.ts";
import { setup, until } from "./test-setup.ts";

// Offline host and registration tests. Each fixture is a real file-loaded extension (manifest + entry) under a tmp dir.
// The daemon is the test-setup daemon (fakes); a handler may use only the fenced context the lifecycle hands it.

const ECHO = `
export default {
  manifest: { name: "fixture", entry: "entry.mjs", capabilities: {}, deps: [] },
  init(host) {
    host.workflow({
      name: "echo",
      validate(input) {
        if (typeof input === "object" && input !== null && typeof input.msg === "string") return { ok: true, value: { msg: input.msg } };
        return { ok: false, error: "msg must be a string" };
      },
      async run(ctx) {
        await ctx.ops.submitResult({ summary: "echo:" + ctx.input.msg }, ctx.agent + ":result");
      },
    });
  },
};
`;

const GATED = `
export default {
  manifest: { name: "gated", entry: "entry.mjs", capabilities: {}, deps: [] },
  init(host) {
    host.workflow({
      name: "hold",
      validate: () => ({ ok: true, value: null }),
      async run(ctx) {
        await globalThis.__wfGate;
        await ctx.ops.submitResult({ summary: "released" }, ctx.agent + ":result");
      },
    });
  },
};
`;

type Ext = { dir: string; manifest: string; entry?: string };

// Writes each fixture as <root>/<dir>/{manifest.json,entry.mjs} and returns the root.
function extRoot(exts: Ext[]): string {
  const root = tmpDir("pomtreed-wf-");
  for (const e of exts) {
    mkdirSync(join(root, e.dir), { recursive: true });
    writeFileSync(join(root, e.dir, "manifest.json"), e.manifest);
    if (e.entry !== undefined) writeFileSync(join(root, e.dir, "entry.mjs"), e.entry);
  }
  return root;
}

const manifest = (name: string) => JSON.stringify({ apiVersion: 1, name, entry: "entry.mjs", capabilities: {}, deps: [] });

// A daemon whose deterministic executors are the host's map, plus a file-loaded registry over the same fakes.
function harness(reviewed: (ext: string) => boolean) {
  let t!: ReturnType<typeof setup>;
  const host = new WorkflowHost({
    registry: () => t.fakes.registry,
    reviewed,
    startDeterministic: (requester, req) => t.daemon.startDeterministic(requester, req),
  });
  t = setup(async () => {}, { deterministicExecutors: host.executors });
  const registry = createExtensionRegistry({
    hostId: "h1",
    now: () => t.daemon.now(),
    registry: t.fakes.registry,
    journal: t.fakes.journal,
    mailbox: t.fakes.mailbox,
    root: () => t.daemon.root(),
    workflows: host,
  });
  return { t, host, registry };
}

const root = async (t: ReturnType<typeof setup>) => (await t.daemon.root()) as AgentRecord;
const childCount = async (t: ReturnType<typeof setup>) => (await t.daemon.list({ parent: (await root(t)).id })).length;
const TERMINAL = ["exited", "reaped"];

test("an unreviewed extension is loaded but admits nothing (default deny)", async () => {
  const { t, host, registry } = harness(() => false);
  await registry.load(extRoot([{ dir: "fixture", manifest: manifest("fixture"), entry: ECHO }]));
  await registry.startAll();
  assert.deepEqual(host.qualifiedNames(), []);
  await assert.rejects(
    host.start((await root(t)).id, { workflow: "fixture/echo", name: "w", task: "t", idempotencyKey: "k", input: { msg: "x" } }),
    /unknown or unavailable workflow/,
  );
  assert.equal(await childCount(t), 0);
  await registry.stopAll();
});

test("a reviewed extension registers a qualified workflow; a valid start runs to a structured result; a retry converges", async () => {
  const { t, host, registry } = harness((ext) => ext === "fixture");
  const [loaded] = await registry.load(extRoot([{ dir: "fixture", manifest: manifest("fixture"), entry: ECHO }]));
  assert.equal(loaded?.status, "ok");
  await registry.startAll();
  assert.deepEqual(host.qualifiedNames(), ["fixture/echo"]);
  const r = await root(t);
  const req = { workflow: "fixture/echo", name: "w", task: "t", idempotencyKey: "k1", input: { msg: "hi" }, budgetMicros: 500 };
  const a = await host.start(r.id, req);
  assert.equal(a.executor, "deterministic");
  await until(async () => TERMINAL.includes(((await t.daemon.get(a.id)) as AgentRecord).state), 3000);
  const done = (await t.daemon.get(a.id)) as AgentRecord;
  assert.deepEqual(done.result, { summary: "echo:hi" });
  const b = await host.start(r.id, req);
  assert.equal(b.id, a.id);
  assert.equal(await childCount(t), 1);
  await registry.stopAll();
});

test("unknown, foreign-namespace and invalid input are refused before any task or budget carve exists", async () => {
  const { t, host, registry } = harness((ext) => ext === "fixture");
  await registry.load(extRoot([{ dir: "fixture", manifest: manifest("fixture"), entry: ECHO }]));
  await registry.startAll();
  const r = (await root(t)).id;
  const base = { name: "w", task: "t", idempotencyKey: "k", budgetMicros: 500 };
  await assert.rejects(host.start(r, { ...base, workflow: "fixture/nope", input: { msg: "x" } }), /unknown or unavailable/);
  await assert.rejects(host.start(r, { ...base, workflow: "other/echo", input: { msg: "x" } }), /unknown or unavailable/);
  await assert.rejects(host.start(r, { ...base, workflow: "fixture/echo", input: { msg: 3 } }), /invalid input: msg must be a string/);
  await assert.rejects(host.start(r, { ...base, workflow: "fixture/echo", input: [1] as never }), /invalid input/);
  assert.equal(await childCount(t), 0);
  await registry.stopAll();
});

test("malformed, duplicate and failed-init definitions make only their extension unavailable", async () => {
  const bad = `export default { manifest: { name: "bad", entry: "entry.mjs", capabilities: {}, deps: [] }, init(h) { h.workflow({ name: "x", validate() { return { ok: true, value: null }; } }); } };`;
  const dup = `export default { manifest: { name: "dup", entry: "entry.mjs", capabilities: {}, deps: [] }, init(h) {
    const d = { name: "x", validate: () => ({ ok: true, value: null }), run: async () => {} };
    h.workflow(d); h.workflow(d); } };`;
  const failInit = `export default { manifest: { name: "failinit", entry: "entry.mjs", capabilities: {}, deps: [] }, init(h) {
    h.workflow({ name: "x", validate: () => ({ ok: true, value: null }), run: async () => {} }); throw new Error("boom"); } };`;
  const { host, registry } = harness(() => true);
  const loaded = await registry.load(
    extRoot([
      { dir: "bad", manifest: manifest("bad"), entry: bad },
      { dir: "dup", manifest: manifest("dup"), entry: dup },
      { dir: "failinit", manifest: manifest("failinit"), entry: failInit },
    ]),
  );
  assert.deepEqual(
    loaded.map((l) => l.status),
    ["failed", "failed", "failed"],
  );
  await registry.startAll();
  assert.deepEqual(host.qualifiedNames(), []);
  await registry.stopAll();
});

test("two extensions claiming one name cannot both commit; the second is refused as a whole", async () => {
  const { host, registry } = harness(() => true);
  const loaded = await registry.load(
    extRoot([
      { dir: "a", manifest: manifest("same"), entry: ECHO },
      { dir: "b", manifest: manifest("same"), entry: ECHO },
    ]),
  );
  assert.equal(loaded.filter((l) => l.status === "ok").length, 2);
  await registry.startAll();
  assert.deepEqual(host.qualifiedNames(), ["same/echo"]);
  await registry.stopAll();
});

test("load after startAll is refused; stopAll refuses while a deterministic task runs, then closes admission", async () => {
  let release!: () => void;
  (globalThis as { __wfGate?: Promise<void> }).__wfGate = new Promise<void>((res) => (release = res));
  const { t, host, registry } = harness(() => true);
  await registry.load(extRoot([{ dir: "gated", manifest: manifest("gated"), entry: GATED }]));
  await registry.startAll();
  await assert.rejects(registry.load(extRoot([])), /boot-only/);
  const r = (await root(t)).id;
  const a = await host.start(r, { workflow: "gated/hold", name: "w", task: "t", idempotencyKey: "g", input: null, budgetMicros: 500 });
  await until(async () => ((await t.daemon.get(a.id)) as AgentRecord).state === "running", 3000);
  await assert.rejects(registry.stopAll(), /refusing to stop: 1 deterministic task/);
  release();
  await until(async () => TERMINAL.includes(((await t.daemon.get(a.id)) as AgentRecord).state), 3000);
  await registry.stopAll();
  await assert.rejects(host.start(r, { workflow: "gated/hold", name: "w", task: "t", idempotencyKey: "g2", input: null }), /admission is closed/);
  delete (globalThis as { __wfGate?: unknown }).__wfGate;
});
