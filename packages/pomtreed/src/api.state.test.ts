import { buildChannelRegistry } from "./channels.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRecord, JournalEntry, StateLimits, StateOpJournalPayload, StateStore } from "@pomtree/core";
import { POMTREED_KINDS } from "@pomtree/core";
import { openStateStore, openStore } from "@pomtree/store-sqlite";
import { createFakes, FakeStateStore, ScriptHarness } from "@pomtree/testing";
import { handle } from "./api.ts";
import type { ApiResponse } from "./api.ts";
import { issueToken } from "./auth.ts";
import { Daemon } from "./daemon.ts";
import { ProxyCredentialGateway } from "./gateway.ts";
import { LocalNode } from "./local-node.ts";
import { LocalOrchestrator } from "./orchestrator.ts";
import { HostPlacement } from "./placement.ts";
import { journalSummary } from "./daemon-util.ts";
import { StatePolicy } from "./state-policy.ts";
import { op, SECRET, setup, spawnSpec } from "./test-setup.ts";

// /v1/state routes end to end through handle(): the same scenarios run over the fake StateStore (setup harness) and over a real
// store-sqlite store behind a real-store Daemon.

const GRANTS = JSON.stringify({
  reader: [{ owner: "hn-digest", prefix: "memo/", mode: "r" }],
  "hn-digest/flow": [{ owner: "hn-digest", prefix: "memo/", mode: "rw" }],
});
const SECRET_TEXT = "planted-secret-do-not-journal";

interface World {
  daemon: Daemon;
  state: StateStore;
  limits: StateLimits | null;
  close(): void;
}

const limitsFn = (l?: Partial<StateLimits>) =>
  l ? () => ({ maxDocs: 1000, maxDocBytes: 128 * 1024, maxOwnerBytes: 16 << 20, maxTombstones: 1000, ...l }) : undefined;

function fakeWorld(l?: Partial<StateLimits>): World {
  const t = setup(async () => {});
  const state = new FakeStateStore(() => Date.now(), t.fakes.hooks.raw.registry, limitsFn(l));
  t.daemon.deps.state = state;
  t.daemon.deps.stateGrants = new StatePolicy(GRANTS, l ? JSON.stringify({ default: l }) : undefined);
  return { daemon: t.daemon, state, limits: null, close() {} };
}

function realWorld(l?: Partial<StateLimits>): World {
  const dir = mkdtempSync(join(tmpdir(), "pomtreed-state-"));
  const store = openStore(join(dir, "pomtreed.sqlite"));
  const stateDb = openStateStore(join(dir, "state.sqlite"), { ...(l && { stateLimits: limitsFn(l) }), generationOf: store.generationOf });
  const fakes = createFakes({ host: "h1" });
  const node = new LocalNode({
    hostId: "h1",
    sandbox: fakes.sandbox,
    workspace: fakes.workspace,
    capacity: { maxSessions: 2 },
    bootEpoch: "1",
    workspacePath: (id) => `/fake/${id}`,
    sessionDir: (a) => join(dir, "sess", a),
  });
  const placement = new HostPlacement({ hosts: store.hosts, host: "h1" });
  const daemon = new Daemon({
    hostId: "h1",
    secret: SECRET,
    image: "img@sha256:x",
    sandboxSocketPath: "/run/pomtreed.sock",
    socketHostPath: "/host/pomtreed.sock",
    rootBudgetMicros: 10_000,
    defaultBudgetMicros: 1_000,
    graceMs: 20,
    admitRetryMs: 5,
    epoch: "1",
    registry: store.registry,
    journal: store.journal,
    mailbox: store.mailbox,
    sandbox: fakes.hooks.raw.sandbox,
    workspace: fakes.hooks.raw.workspace,
    harness: new ScriptHarness(async (c) => {
      await c.stopped;
    }),
    gateway: new ProxyCredentialGateway({ journal: store.journal, registry: store.registry, secret: SECRET, proxyBaseUrl: "http://m", tokenTtlMs: 3_600_000 }),
    checkpoints: store.checkpoints,
    sessions: store.sessions,
    sessionRoot: join(dir, "sessions"),
    escalations: store.escalations,
    channels: buildChannelRegistry([], []),
    watchdogs: store.watchdogs,
    schedules: store.schedules,
    reportStore: fakes.reportStore,
    reportMaxBytes: 1 << 20,
    placement,
    orchestrator: new LocalOrchestrator(),
    state: stateDb.state,
    stateGrants: new StatePolicy(GRANTS, l ? JSON.stringify({ default: l }) : undefined),
  });
  placement.onAdmit((agent) => daemon.admitted(agent));
  void node;
  return {
    daemon,
    state: stateDb.state,
    limits: null,
    close() {
      stateDb.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const api = (w: World, method: string, url: string, body?: unknown, token = op): Promise<ApiResponse> => handle(w.daemon, { method, url, body, token });
const put = (w: World, key: string, value: unknown, extra: object = {}, token = op, owner = "hn-digest") =>
  api(w, "PUT", "/v1/state/doc", { owner, key, value, idempotencyKey: `k-${key}-${JSON.stringify(value).length}`, ...extra }, token);

async function agent(w: World, name: string, spec: object, executor: "container" | "deterministic" = "container"): Promise<AgentRecord> {
  const root = await w.daemon.root();
  const a = await w.daemon.deps.registry.create({
    ...(executor === "deterministic" ? { executor, spec: spec as never } : { spec: spec as never }),
    parent: root.id,
    name,
    task: "t",
    host: "h1",
    budgetMicros: 100,
    idempotencyKey: name,
  } as never);
  return w.daemon.deps.registry.transition(a.id, a.generation, "running", { idempotencyKey: `${name}-run` });
}
const tok = (w: World, a: AgentRecord, gen = a.generation) => w.daemon.agentToken(a.id, gen);

async function stateOps(w: World): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for (const a of await w.daemon.list())
    out.push(...(await w.daemon.deps.journal.read({ agent: a.id })).filter((e) => e.payload.kind === POMTREED_KINDS.stateOp));
  return out;
}

for (const [label, make] of [
  ["fake store", fakeWorld],
  ["real store-sqlite", realWorld],
] as const) {
  test(`state routes (${label}): operator put/get/list/rm/export/import and status mapping`, async () => {
    const w = make({ maxDocs: 3 });
    try {
      const a = await put(w, "memo/a", { n: 1 });
      assert.equal(a.status, 200);
      const rev = (a.body as { doc: { rev: number } }).doc.rev;
      assert.equal(rev, 1);
      // keyed replay returns the same doc; a different value under the same key is an idempotency mismatch (409)
      const replay = await api(w, "PUT", "/v1/state/doc", { owner: "hn-digest", key: "memo/a", value: { n: 1 }, idempotencyKey: "k-memo/a-7" });
      assert.deepEqual((replay.body as { doc: unknown }).doc, (a.body as { doc: unknown }).doc);
      const mismatch = await api(w, "PUT", "/v1/state/doc", { owner: "hn-digest", key: "memo/zz", value: 1, idempotencyKey: "k-memo/a-7" });
      assert.equal(mismatch.status, 409);
      assert.equal((mismatch.body as { kind: string }).kind, "idempotency-mismatch");
      // CAS conflict carries currentRev
      const c = await put(w, "memo/a", { n: 2 }, { expectRev: 5, idempotencyKey: "c1" });
      assert.equal(c.status, 409);
      assert.equal((c.body as { currentRev: number }).currentRev, 1);
      assert.equal((await put(w, "memo/a", { n: 2 }, { expectRev: 1, idempotencyKey: "c2" })).status, 200);
      // validation, size, quota
      assert.equal((await put(w, "Bad Key", 1)).status, 400);
      assert.equal((await put(w, "memo/big", "x".repeat(200 * 1024))).status, 413);
      assert.equal((await put(w, "memo/b", 1)).status, 200);
      assert.equal((await put(w, "memo/c", 1)).status, 200);
      const q = await put(w, "memo/d", 1);
      assert.equal(q.status, 409);
      assert.equal((q.body as { kind: string }).kind, "quota-docs");
      assert.equal((await api(w, "PUT", "/v1/state/doc", { owner: "hn-digest", key: "memo/e", value: 1 })).status, 400); // no idempotencyKey
      // reads
      assert.equal((await api(w, "GET", "/v1/state/doc?owner=hn-digest&key=memo/a")).status, 200);
      assert.equal((await api(w, "GET", "/v1/state/doc?owner=hn-digest&key=memo/none")).status, 404);
      const list = await api(w, "GET", "/v1/state?owner=hn-digest&prefix=memo/");
      assert.deepEqual(
        (list.body as { docs: { key: string }[] }).docs.map((d) => d.key),
        ["memo/a", "memo/b", "memo/c"],
      );
      assert.equal((await api(w, "GET", "/v1/state")).status, 400); // operator must name an owner
      const exp = await api(w, "GET", "/v1/state/export?owner=hn-digest");
      assert.equal(exp.status, 200);
      assert.equal((exp.body as { docs: unknown[] }).docs.length, 3);
      // rm then import into another owner round-trips (export -> import -> export)
      const rm = await api(w, "POST", "/v1/state/rm", { owner: "hn-digest", prefix: "memo/", idempotencyKey: "rm1" });
      assert.equal(rm.status, 200);
      assert.equal((rm.body as { removed: number }).removed, 3);
      const docs = (exp.body as { docs: { key: string; value: unknown }[] }).docs.map(({ key, value }) => ({ key, value }));
      const imp = await api(w, "POST", "/v1/state/import", { owner: "hn-digest", docs, idempotencyKey: "imp1" });
      assert.equal(imp.status, 200);
      const exp2 = await api(w, "GET", "/v1/state/export?owner=hn-digest");
      assert.deepEqual(
        (exp2.body as { docs: { key: string; value: unknown }[] }).docs.map((d) => ({ key: d.key, value: d.value })),
        docs,
      );
      assert.equal((await api(w, "POST", "/v1/state/rm", { owner: "hn-digest", key: "memo/a", prefix: "memo/", idempotencyKey: "bad" })).status, 400);
      assert.equal((await api(w, "GET", "/v1/state/nope")).status, 404);
    } finally {
      w.close();
    }
  });

  test(`state routes (${label}): import over quota or size is rejected whole, writing nothing`, async () => {
    const w = make({ maxDocs: 3, maxDocBytes: 64 });
    try {
      await put(w, "memo/a", 1);
      const over = await api(w, "POST", "/v1/state/import", {
        owner: "hn-digest",
        docs: [
          { key: "memo/b", value: 1 },
          { key: "memo/c", value: 1 },
          { key: "memo/d", value: 1 },
        ],
        idempotencyKey: "imp-q",
      });
      assert.equal(over.status, 409);
      assert.equal((over.body as { kind: string }).kind, "quota-docs");
      const big = await api(w, "POST", "/v1/state/import", {
        owner: "hn-digest",
        docs: [
          { key: "memo/b", value: 1 },
          { key: "memo/c", value: "x".repeat(100) },
        ],
        idempotencyKey: "imp-s",
      });
      assert.equal(big.status, 413);
      const list = await api(w, "GET", "/v1/state?owner=hn-digest&prefix=memo/");
      assert.deepEqual(
        (list.body as { docs: { key: string }[] }).docs.map((d) => d.key),
        ["memo/a"],
      );
      // overwriting a live key takes no new slot, so a batch that fits only by replacement is accepted
      const ok = await api(w, "POST", "/v1/state/import", {
        owner: "hn-digest",
        docs: [
          { key: "memo/a", value: 2 },
          { key: "memo/b", value: 1 },
          { key: "memo/c", value: 1 },
        ],
        idempotencyKey: "imp-ok",
      });
      assert.equal(ok.status, 200);
    } finally {
      w.close();
    }
  });

  test(`state routes (${label}): agents are default-deny; r vs rw grants; stale generation; host and ext scopes`, async () => {
    const w = make();
    try {
      await put(w, "memo/a", { n: 1 });
      await put(w, "other/a", { n: 1 });
      const none = await agent(w, "none", { ...spawnSpec, template: "nogrants" });
      const reader = await agent(w, "reader", { ...spawnSpec, template: "reader" });
      const flow = await agent(w, "flow", { driver: "hn-digest/flow", input: null }, "deterministic");
      const read = (a: AgentRecord, path: string) => api(w, "GET", path, undefined, tok(w, a));
      // no grant: every verb 403, owner listing is empty
      assert.equal((await read(none, "/v1/state/doc?owner=hn-digest&key=memo/a")).status, 403);
      assert.equal((await read(none, "/v1/state?owner=hn-digest&prefix=memo/")).status, 403);
      assert.equal((await read(none, "/v1/state/export?owner=hn-digest")).status, 403);
      assert.equal((await put(w, "memo/x", 1, {}, tok(w, none))).status, 403);
      assert.equal((await api(w, "POST", "/v1/state/rm", { owner: "hn-digest", key: "memo/a", idempotencyKey: "r" }, tok(w, none))).status, 403);
      assert.equal(
        (await api(w, "POST", "/v1/state/import", { owner: "hn-digest", docs: [{ key: "memo/q", value: 1 }], idempotencyKey: "i" }, tok(w, none))).status,
        403,
      );
      assert.deepEqual((await read(none, "/v1/state")).body, { owners: [] });
      // r: reads inside the prefix, no writes, nothing outside the prefix, no whole-owner listing
      assert.equal((await read(reader, "/v1/state/doc?owner=hn-digest&key=memo/a")).status, 200);
      assert.equal((await read(reader, "/v1/state/doc?owner=hn-digest&key=other/a")).status, 403);
      assert.equal((await read(reader, "/v1/state?owner=hn-digest")).status, 403);
      assert.equal((await read(reader, "/v1/state?owner=hn-digest&prefix=memo/")).status, 200);
      assert.deepEqual((await read(reader, "/v1/state")).body, { owners: ["hn-digest"] });
      assert.equal((await put(w, "memo/x", 1, {}, tok(w, reader))).status, 403);
      // rw (workflow driver): writes inside the prefix only; the write is attributed to the agent
      const wrote = await put(w, "memo/y", { n: 2 }, {}, tok(w, flow));
      assert.equal(wrote.status, 200);
      assert.deepEqual((wrote.body as { doc: { writer: unknown } }).doc.writer, { agent: flow.id, host: "h1", generation: flow.generation });
      assert.equal((await put(w, "other/y", 1, {}, tok(w, flow))).status, 403);
      // stale generation, expired/unknown principals
      const stale = await api(w, "GET", "/v1/state/doc?owner=hn-digest&key=memo/a", undefined, tok(w, reader, reader.generation + 1));
      assert.equal(stale.status, 403);
      assert.equal((await api(w, "GET", "/v1/state?owner=hn-digest", undefined, issueToken(SECRET, { scope: "host", channel: "c" }))).status, 403);
      assert.equal((await api(w, "GET", "/v1/state?owner=hn-digest", undefined, issueToken(SECRET, { scope: "ext", name: "x" }))).status, 403);
      assert.equal((await handle(w.daemon, { method: "GET", url: "/v1/state?owner=hn-digest" })).status, 401);
    } finally {
      w.close();
    }
  });

  test(`state routes (${label}): journal is content-free, keyed, and replayed once`, async () => {
    const w = make();
    try {
      const flow = await agent(w, "flow", { driver: "hn-digest/flow", input: null }, "deterministic");
      const root = await w.daemon.root();
      const body = { owner: "hn-digest", key: "memo/s", value: { token: SECRET_TEXT }, idempotencyKey: "same" };
      const r1 = await api(w, "PUT", "/v1/state/doc", body);
      const r2 = await api(w, "PUT", "/v1/state/doc", body);
      assert.equal(r1.status, 200);
      assert.deepEqual(r2.body, r1.body);
      await api(w, "PUT", "/v1/state/doc", { ...body, key: "memo/t", idempotencyKey: "agent-put" }, tok(w, flow));
      await api(w, "POST", "/v1/state/rm", { owner: "hn-digest", key: "memo/s", idempotencyKey: "rm-s" });
      await api(w, "GET", "/v1/state/export?owner=hn-digest&idempotencyKey=exp-1");
      await api(w, "POST", "/v1/state/import", { owner: "hn-digest", docs: [{ key: "memo/i", value: SECRET_TEXT }], idempotencyKey: "imp" });
      const ops = await stateOps(w);
      assert.deepEqual(ops.map((e) => (e.payload as unknown as StateOpJournalPayload).op).sort(), ["export", "import", "put", "put", "rm"]);
      assert.equal(
        ops.filter((e) => (e.payload as unknown as StateOpJournalPayload).key === "memo/s" && (e.payload as unknown as StateOpJournalPayload).op === "put")
          .length,
        1,
      );
      for (const e of ops) {
        const p = e.payload as unknown as StateOpJournalPayload;
        assert.ok(!("value" in p) && !("docs" in p));
        assert.equal(e.host, "h1");
        assert.equal(e.agent, p.by === "agent" ? flow.id : root.id);
        assert.equal(e.generation, p.by === "agent" ? flow.generation : root.generation);
      }
      // a planted secret never reaches any journal row of any agent
      for (const a of await w.daemon.list()) assert.ok(!JSON.stringify(await w.daemon.deps.journal.read({ agent: a.id })).includes(SECRET_TEXT));
      const before = (await stateOps(w)).length;
      // a conflict is not a mutation: no journal row
      await api(w, "PUT", "/v1/state/doc", { owner: "hn-digest", key: "memo/t", value: 1, expectRev: 99, idempotencyKey: "conf" });
      assert.equal((await stateOps(w)).length, before);
    } finally {
      w.close();
    }
  });
}

test("state routes: unconfigured daemon answers 503", async () => {
  const t = setup(async () => {});
  assert.equal((await t.operator("GET", "/v1/state?owner=hn-digest")).status, 503);
});

test("spawn refuses a child whose state grants exceed the requester's; the operator and a covered child pass", async () => {
  const t = setup(async () => {}, { mayUseTemplate: () => true });
  t.daemon.deps.stateGrants = new StatePolicy(
    JSON.stringify({
      parent: [{ owner: "hn-digest", prefix: "memo/", mode: "r" }],
      narrower: [{ owner: "hn-digest", prefix: "memo/x/", mode: "r" }],
      wider: [{ owner: "hn-digest", mode: "r" }],
    }),
  );
  const tpl = t.fakes.hooks.raw.templates.templates;
  for (const id of ["parent", "narrower", "wider"]) tpl.set(id, { id });
  const root = await t.daemon.root();
  const p = await t.daemon.spawn(root.id, { name: "p", task: "t", idempotencyKey: "p", template: "parent" });
  await t.orchestrator.idle();
  await assert.rejects(t.daemon.spawn(p.id, { name: "w", task: "t", idempotencyKey: "w", template: "wider" }), /exceed/);
  const ok = await t.daemon.spawn(p.id, { name: "n", task: "t", idempotencyKey: "n", template: "narrower" });
  assert.ok(ok.id);
  const viaOperator = await t.daemon.spawn(root.id, { name: "w2", task: "t", idempotencyKey: "w2", template: "wider" });
  assert.ok(viaOperator.id);
  await t.orchestrator.idle();
});

test("journalSummary renders a state_op as one metadata line", () => {
  const p = { kind: POMTREED_KINDS.stateOp, op: "rm", owner: "hn-digest", prefix: "memo/", count: 3, by: "operator" } as never;
  assert.equal(journalSummary(p), "state rm hn-digest/memo/* x3 by operator");
});
