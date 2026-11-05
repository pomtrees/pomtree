import assert from "node:assert/strict";
import { request } from "node:http";
import type { Server } from "node:http";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { fakeBundle } from "@pomtree/testing";
import { op, setup, spawnSpec } from "./test-setup.ts";
import { makeServer } from "./server.ts";

type T = ReturnType<typeof setup>;

async function mkAgent(t: T, key: string, parent?: string): Promise<AgentRecord> {
  const root = await t.daemon.root();
  const a = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: parent ?? root.id,
    name: key,
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: key,
  });
  const r = await t.daemon.deps.registry.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
  await t.daemon.deps.workspace.create(r.id, {});
  return r;
}
const tok = (t: T, a: AgentRecord) => t.daemon.agentToken(a.id, a.generation);

async function serve(t: T): Promise<{ server: Server; port: number }> {
  const server = makeServer(t.daemon, false);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  return { server, port: (server.address() as { port: number }).port };
}

function call(port: number, o: { method: string; path: string; token: string; body?: Uint8Array | Uint8Array[]; chunked?: boolean }) {
  return new Promise<{ status: number; type: string | undefined; bytes: Buffer; json: () => Record<string, unknown> }>((resolve, reject) => {
    const parts = o.body === undefined ? [] : Array.isArray(o.body) ? o.body : [o.body];
    const len = parts.reduce((n, p) => n + p.byteLength, 0);
    const headers: Record<string, string> = { authorization: `Bearer ${o.token}`, ...(o.body !== undefined && { "content-type": "application/octet-stream" }) };
    if (o.body !== undefined && !o.chunked) headers["content-length"] = String(len);
    const req = request({ host: "127.0.0.1", port, path: o.path, method: o.method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        resolve({
          status: res.statusCode!,
          type: res.headers["content-type"],
          bytes,
          json: () => JSON.parse(bytes.toString("utf8")) as Record<string, unknown>,
        });
      });
    });
    req.on("error", reject);
    for (const p of parts) req.write(p);
    req.end();
  });
}

const withServer = async (t: T, fn: (port: number) => Promise<void>) => {
  const { server, port } = await serve(t);
  try {
    await fn(port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections?.();
  }
};

test("ingest route: pushes a bundle through Workspace.ingest, journals ingested, answers {ok, refs}; idempotent by key", async () => {
  const t = setup(async () => {});
  const a = await mkAgent(t, "a");
  const bundle = fakeBundle([{ name: `agent/${a.id}`, commit: "c1" }]);
  await withServer(t, async (port) => {
    const r1 = await call(port, { method: "POST", path: `/v1/agents/self/push?key=k1`, token: tok(t, a), body: bundle });
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.json(), { ok: true, refs: [{ ref: `refs/agents/${a.id}/heads/agent/${a.id}`, commit: "c1" }] });
    const r2 = await call(port, { method: "POST", path: `/v1/agents/${a.id}/push?key=k1`, token: tok(t, a), body: bundle });
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.json(), r1.json());
  });
  assert.equal(t.fakes.calls.filter((c) => c.port === "Workspace" && c.method === "ingest").length, 1, "the replay did not ingest again");
  const ing = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "ingested");
  assert.equal(ing.length, 1);
  assert.deepEqual((await t.daemon.deps.workspace.ingested(a.id))?.commit, "c1");
});

test("ingest route: agent token for :id only (operator, another agent, a missing key are refused)", async () => {
  const t = setup(async () => {});
  const a = await mkAgent(t, "a");
  const b = await mkAgent(t, "b");
  const bundle = fakeBundle([{ name: "x", commit: "c1" }]);
  await withServer(t, async (port) => {
    assert.equal((await call(port, { method: "POST", path: `/v1/agents/${a.id}/push?key=k`, token: op, body: bundle })).status, 403);
    assert.equal((await call(port, { method: "POST", path: `/v1/agents/${a.id}/push?key=k`, token: tok(t, b), body: bundle })).status, 403);
    assert.equal((await call(port, { method: "POST", path: `/v1/agents/self/push`, token: tok(t, a), body: bundle })).status, 400);
    assert.equal((await call(port, { method: "POST", path: `/v1/agents/self/push?key=k`, token: "garbage", body: bundle })).status, 401);
  });
  assert.equal(t.fakes.calls.filter((c) => c.port === "Workspace" && c.method === "ingest").length, 0);
});

test("ingest route: a stale generation is 409 and nothing is ingested", async () => {
  const t = setup(async () => {});
  const a = await mkAgent(t, "a");
  const stale = tok(t, a);
  await t.daemon.deps.registry.bumpGeneration(a.id, "h1", "bump");
  await withServer(t, async (port) => {
    const r = await call(port, { method: "POST", path: `/v1/agents/self/push?key=k`, token: stale, body: fakeBundle([{ name: "x", commit: "c1" }]) });
    assert.equal(r.status, 409);
  });
  assert.equal(t.fakes.calls.filter((c) => c.port === "Workspace" && c.method === "ingest").length, 0);
});

test("ingest route: a bundle over POMTREED_PUSH_MAX_BYTES is 413 too_large (declared length and streamed)", async () => {
  const t = setup(async () => {}, { pushMaxBytes: 16 });
  const a = await mkAgent(t, "a");
  await withServer(t, async (port) => {
    const big = new Uint8Array(64);
    const declared = await call(port, { method: "POST", path: `/v1/agents/self/push?key=k1`, token: tok(t, a), body: big });
    assert.equal(declared.status, 413);
    assert.equal(declared.json().code, "too_large");
    // no content-length: the cap is enforced while streaming, by the workspace
    const streamed = await call(port, {
      method: "POST",
      path: `/v1/agents/self/push?key=k2`,
      token: tok(t, a),
      body: [new Uint8Array(10), new Uint8Array(10)],
      chunked: true,
    });
    assert.equal(streamed.status, 413);
    assert.equal(streamed.json().code, "too_large");
  });
  assert.equal((await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "ingested").length, 0);
  assert.equal((await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "ingest_failed").length, 1, "the streamed refusal is journaled");
});

test("ingest route: verification failures map to 422 with their code; a not-running agent is 409", async () => {
  const t = setup(async () => {});
  const a = await mkAgent(t, "a");
  t.fakes.hooks.raw.workspace.ingestResults.push({
    ok: false,
    code: "prerequisite",
    message: "bundle requires commit deadbeef which the mirror does not hold",
  });
  await withServer(t, async (port) => {
    const r = await call(port, { method: "POST", path: `/v1/agents/self/push?key=k`, token: tok(t, a), body: fakeBundle([{ name: "x", commit: "c1" }]) });
    assert.equal(r.status, 422);
    assert.equal(r.json().code, "prerequisite");
    await t.daemon.deps.registry.transition(a.id, a.generation, "exited", { exit: "succeeded", idempotencyKey: "a-x" });
    assert.equal(
      (await call(port, { method: "POST", path: `/v1/agents/self/push?key=k9`, token: tok(t, a), body: fakeBundle([{ name: "x", commit: "c1" }]) })).status,
      409,
    );
  });
});

test("pull route: self by default; a descendant (child, grandchild) is allowed; a sibling or an ancestor is 403; unknown is 404", async () => {
  const t = setup(async () => {});
  const p = await mkAgent(t, "p");
  const c = await mkAgent(t, "c", p.id);
  const g = await mkAgent(t, "g", c.id);
  const s = await mkAgent(t, "s");
  const ws = t.daemon.deps.workspace;
  for (const x of [p, c, g, s])
    await ws.ingest(
      x.id,
      (async function* () {
        yield fakeBundle([{ name: `agent/${x.id}`, commit: `c-${x.id}` }]);
      })(),
      { maxBytes: 1 << 20 },
    );
  await withServer(t, async (port) => {
    const self = await call(port, { method: "GET", path: `/v1/agents/self/pull`, token: tok(t, p) });
    assert.equal(self.status, 200);
    assert.equal(self.type, "application/octet-stream");
    assert.match(self.bytes.toString("utf8"), new RegExp(`refs/agents/${p.id}/heads`));
    const kid = await call(port, { method: "GET", path: `/v1/agents/self/pull?from=${c.id}`, token: tok(t, p) });
    assert.equal(kid.status, 200);
    assert.match(kid.bytes.toString("utf8"), new RegExp(`refs/agents/${c.id}/heads`));
    assert.equal(
      (await call(port, { method: "GET", path: `/v1/agents/${p.id}/pull?from=${g.id}`, token: tok(t, p) })).status,
      200,
      "a grandchild is a descendant",
    );
    assert.equal((await call(port, { method: "GET", path: `/v1/agents/self/pull?from=${s.id}`, token: tok(t, p) })).status, 403, "a sibling tree");
    assert.equal((await call(port, { method: "GET", path: `/v1/agents/self/pull?from=${p.id}`, token: tok(t, c) })).status, 403, "an ancestor");
    assert.equal((await call(port, { method: "GET", path: `/v1/agents/self/pull?from=nope`, token: tok(t, p) })).status, 404);
    assert.equal((await call(port, { method: "GET", path: `/v1/agents/${c.id}/pull`, token: tok(t, p) })).status, 403, "pulling through another agent's id");
    assert.equal((await call(port, { method: "GET", path: `/v1/agents/${p.id}/pull`, token: op })).status, 403, "operator scope is not an agent");
  });
});

test("pull route: a stale generation is 409", async () => {
  const t = setup(async () => {});
  const a = await mkAgent(t, "a");
  const stale = tok(t, a);
  await t.daemon.deps.registry.bumpGeneration(a.id, "h1", "bump");
  await withServer(t, async (port) => {
    assert.equal((await call(port, { method: "GET", path: `/v1/agents/self/pull`, token: stale })).status, 409);
  });
});

test("ingest route: a chunked over-cap push still gets its 413 reply (request not destroyed)", async () => {
  const t = setup(async () => {}, { pushMaxBytes: 16 });
  const a = await mkAgent(t, "a");
  await withServer(t, async (port) => {
    const parts = Array.from({ length: 50 }, () => new Uint8Array(1024));
    const r = await call(port, { method: "POST", path: `/v1/agents/self/push?key=big`, token: tok(t, a), body: parts, chunked: true });
    assert.equal(r.status, 413);
    assert.equal(r.json().code, "too_large");
  });
});

// force=1 is refused for an agent credential (Daemon.push: operator-only), so an agent can never overwrite a tip the
// controller wrote. The allowed operator-scope force and its `forcedFrom` record live in daemon.push-force.test.ts.
test("ingest route: a non-fast-forward push is 409 non_fast_forward and leaves the ref; force=1 is 403 and leaves it too", async () => {
  const t = setup(async () => {});
  const a = await mkAgent(t, "a");
  const name = `agent/${a.id}`;
  await withServer(t, async (port) => {
    const push = (key: string, body: Uint8Array, q = "") => call(port, { method: "POST", path: `/v1/agents/self/push?key=${key}${q}`, token: tok(t, a), body });
    assert.equal((await push("k1", fakeBundle([{ name, commit: "c1" }]))).status, 200);
    const stale = fakeBundle([{ name, commit: "other" }]); // unrelated to c1
    const refused = await push("k2", stale);
    assert.equal(refused.status, 409);
    assert.equal(refused.json().code, "non_fast_forward");
    assert.equal((await t.daemon.deps.workspace.ingested(a.id))?.commit, "c1");
    const forced = await push("k3", stale, "&force=1");
    assert.equal(forced.status, 403);
    assert.match(String(forced.json().error), /operator-only/);
    assert.equal((await t.daemon.deps.workspace.ingested(a.id))?.commit, "c1");
  });
  const rows = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "ingested");
  assert.deepEqual(
    rows.map((e) => (e.payload as { forced?: true }).forced),
    [undefined],
  );
});
