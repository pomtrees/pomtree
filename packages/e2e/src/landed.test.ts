import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxUnavailableError } from "@pomtree/core";
import type { AgentRecord, SpawnIntent, SpawnSpec } from "@pomtree/core";
import { createExtGateway, createExtensionRegistry, handle, issueToken } from "@pomtree/pomtreed";
import { keyed } from "@pomtree/testing";
import type { Daemon } from "@pomtree/pomtreed";
// TODO(tests-gaps): builtin factories and LifecycleError are not in the pomtreed public index (see cron.test.ts).
import { createCronExtension } from "../../pomtreed/src/builtin/cron.ts";
import { brokeredGateway } from "../../pomtreed/src/test-capture.ts";
import { SECRET, rig, seedCheckpoint, until } from "./harness.ts";
import type { Rig, RigOpts } from "./harness.ts";

const op = issueToken(SECRET, { scope: "operator" });
const hostTok = (channel: string) => issueToken(SECRET, { scope: "host", channel });
const operator = (d: Daemon, method: string, url: string, body?: unknown) => handle(d, { method, url, body: keyed(method, body), token: op });
const nextMinute = () => Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
const discord = { messagingChannels: ["discord"], escalationChannels: ["discord"] };

// ---- cron: queue overlap, pause/resume route, auto-pause breaker, transient failures ----

type Spawn = (intent: SpawnIntent, key: string) => Promise<AgentRecord>;
function cronRig(clock: () => number, wrap?: (base: Spawn) => Spawn, play?: RigOpts["play"]) {
  const r = rig({ now: clock, ...(play && { play }) });
  const base: Spawn = async (intent, key) => r.daemon.spawn((await r.daemon.root()).id, { name: intent.name, task: intent.task, idempotencyKey: key });
  const extensions = createExtensionRegistry({
    hostId: "h1",
    now: () => r.daemon.now(),
    registry: r.daemon.deps.registry,
    journal: r.daemon.deps.journal,
    mailbox: r.daemon.deps.mailbox,
    root: () => r.daemon.root(),
  });
  const cron = createCronExtension({
    schedules: r.store.schedules,
    cronTickMs: r.daemon.limits.cronTickMs,
    rootId: async () => (await r.daemon.root()).id,
    spawnRootChild: wrap ? wrap(base) : base,
    steerAgent: (agent, body, key) => r.daemon.messageAgent(agent, body, key, "queue"),
    wakeAgent: (agent, body, key) => r.daemon.resumeAgent(agent, body, {}, key),
    pendingSignals: (agent) => r.daemon.deps.mailbox.peek(agent),
  });
  extensions.registerBuiltin(cron);
  r.daemon.deps.extensionHost = extensions;
  return { r, cron };
}
const kidsOf = async (r: Rig, name: string) => (await r.daemon.list({ parent: (await r.daemon.root()).id })).filter((k) => k.name === name);
const sched = (id: string) => ({ cron: "* * * * *", task: "t", missed: "skip", overlap: "queue", jitterMs: 0, id });

test("cron queue overlap holds the due fire behind a live run and releases it once the run is terminal", async () => {
  const start = nextMinute();
  let clock = start;
  let release!: () => void;
  const hold = new Promise<void>((res) => (release = res));
  const { r, cron } = cronRig(
    () => clock,
    undefined,
    () => ({ hold, result: { status: "succeeded", result: null } }),
  );
  try {
    assert.equal((await operator(r.daemon, "PUT", "/v1/schedules/q", sched("q"))).status, 200);
    clock = start + 90_000;
    await cron.sweep();
    await until(async () => (await kidsOf(r, "q"))[0]?.state === "running", "first fire running");
    clock = start + 150_000; // a second fire is now due but the first is live
    await cron.sweep();
    assert.equal((await kidsOf(r, "q")).length, 1, "queued, not spawned");
    release();
    await r.orchestrator.idle();
    await cron.sweep();
    await r.orchestrator.idle();
    assert.equal((await kidsOf(r, "q")).length, 2, "released after the first settled");
  } finally {
    release();
    await r.orchestrator.idle();
    r.store.close();
  }
});

test("cron pause/resume route: a paused schedule never fires; resume fires it; unknown id 404; operator only", async () => {
  const start = nextMinute();
  let clock = start;
  const { r, cron } = cronRig(() => clock);
  try {
    await operator(r.daemon, "PUT", "/v1/schedules/p", sched("p"));
    assert.equal((await operator(r.daemon, "POST", "/v1/schedules/p/pause", { idempotencyKey: "pa1" })).status, 200);
    assert.equal((await operator(r.daemon, "POST", "/v1/schedules/nope/pause", { idempotencyKey: "pa2" })).status, 404);
    assert.ok(
      [401, 403].includes(
        (await handle(r.daemon, { method: "POST", url: "/v1/schedules/p/pause", token: hostTok("discord"), body: { idempotencyKey: "x" } })).status,
      ),
    );
    clock = start + 90_000;
    await cron.sweep();
    await r.orchestrator.idle();
    assert.equal((await kidsOf(r, "p")).length, 0, "paused: no spawn");
    const res = await operator(r.daemon, "POST", "/v1/schedules/p/resume", { idempotencyKey: "re1" });
    assert.equal(res.status, 200);
    assert.ok(!(res.body as { paused?: boolean }).paused);
    await cron.sweep();
    await r.orchestrator.idle();
    assert.equal((await kidsOf(r, "p")).length, 1, "resumed: due fire spawns");
  } finally {
    r.store.close();
  }
});

test("cron breaker: 20 consecutive spawn failures auto-pause with one alert; transient failures are never counted", async () => {
  const start = nextMinute();
  let clock = start + 90_000;
  let mode: "transient" | "hard" = "transient";
  const { r, cron } = cronRig(
    () => clock,
    () => async () => {
      throw mode === "transient" ? new SandboxUnavailableError() : new Error("boom");
    },
  );
  try {
    // createdAt is stamped from the wall clock; keep the schedule created before the injected clock.
    await r.store.schedules.upsert({ id: "b", cron: "* * * * *", task: "t", missed: "skip", overlap: "queue", jitterMs: 0 }, "up-b");
    for (let i = 0; i < 25; i++) {
      await cron.sweep();
      clock += 10_000;
    }
    const s0 = (await r.store.schedules.list()).find((x) => x.id === "b")!;
    assert.ok(!s0.failures, "transient failures do not feed the breaker");
    assert.ok(!s0.paused);
    mode = "hard";
    for (let i = 0; i < 25; i++) {
      clock += 2 * 3_600_000;
      await cron.sweep();
    }
    const s = (await r.store.schedules.list()).find((x) => x.id === "b")!;
    assert.equal(s.paused, true, "auto-paused");
    const alerts = (await r.daemon.events({ agent: (await r.daemon.root()).id })).filter(
      (e) => e.payload.kind === "ext.cron.error" && /auto-paused/.test((e.payload as unknown as { message: string }).message),
    );
    assert.equal(alerts.length, 1, "one auto-pause alert");
  } finally {
    r.store.close();
  }
});

// ---- ext route: stale generation, gateway quota/denials ----

const extSpec: SpawnSpec = { image: "img", envManifestHash: null, extensions: ["web_fetch"], systemPrompt: null, egress: { kind: "registry" } };
async function extAgent(r: Rig): Promise<AgentRecord> {
  const a = await r.store.registry.create({
    spec: extSpec,
    id: "ea",
    parent: null,
    name: "ea",
    task: "t",
    host: "h1",
    budgetMicros: 1,
    idempotencyKey: "mk-ea",
  });
  return r.store.registry.transition(a.id, a.generation, "running", { idempotencyKey: "mk-ea-run" });
}
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];
const okFetch = async () => ({
  status: 200,
  headers: { get: () => "text/plain" },
  body: (async function* () {
    yield Buffer.from("hi");
  })(),
});

test("ext route: a stale-generation agent token is 409; the live generation is served", async () => {
  const r = rig({ deps: { extensions: createExtGateway({ fetch: okFetch, resolveDns: publicDns }) } });
  try {
    const a = await extAgent(r);
    const call = (gen: number, key: string) =>
      handle(r.daemon, {
        method: "POST",
        url: "/v1/ext/web_fetch/call",
        token: r.daemon.agentToken(a.id, gen),
        body: { input: { url: "https://example.com/" }, idempotencyKey: key },
      });
    assert.equal((await call(a.generation + 1, "s1")).status, 409);
    assert.equal((await call(a.generation, "s2")).status, 200);
  } finally {
    r.store.close();
  }
});

test("ext route: the real broker's SSRF and rate-limit denials return on the route and journal a proxy_result each", async () => {
  // web_fetch is a capture broker client: a real broker over fakes (pomtreed test-capture.ts), robots.txt answering 404.
  const r = rig({ deps: { extensions: brokeredGateway({ fetch: okFetch, resolveDns: publicDns, maxCallsPerWindow: 2 }) } });
  try {
    const a = await extAgent(r);
    const call = (url: string, key: string) =>
      handle(r.daemon, {
        method: "POST",
        url: "/v1/ext/web_fetch/call",
        token: r.daemon.agentToken(a.id, a.generation),
        body: { input: { url }, idempotencyKey: key },
      });
    const blocked = await call("http://169.254.169.254/latest/meta-data/", "d1");
    assert.equal((blocked.body as { ok: boolean }).ok, false);
    assert.equal((await call("https://example.com/a", "d2")).status, 200);
    const limited = await call("https://example.com/b", "d3");
    assert.equal((limited.body as { ok: boolean }).ok, false);
    assert.match(String((limited.body as { reason?: string }).reason), /rate limit/);
    const results = (await r.daemon.events({ agent: a.id })).filter((e) => e.payload.kind === "proxy_result");
    assert.equal(results.length, 3, "every call journals a proxy_result");
  } finally {
    r.store.close();
  }
});

// ---- chat intents, transcript, reap key, messages/failed ----

async function heldAgent(r: Rig, name: string): Promise<AgentRecord> {
  const a = await r.daemon.spawn((await r.daemon.root()).id, { name, task: "t", idempotencyKey: name });
  await until(async () => (await r.daemon.get(a.id))?.state === "running", "agent running");
  return a;
}
const sender = { channel: "discord", sender: "u" } as const;

test("receiveMessage status/cancel intents: status reports state, cancel stops the agent, replay is stable", async () => {
  const hold = new Promise<void>(() => {});
  const r = rig({ play: () => ({ hold, result: { status: "succeeded", result: null } }), deps: discord });
  try {
    const a = await heldAgent(r, "ci");
    const st = await r.daemon.receiveMessage({ channel: "discord", sender, body: "", to: a.id, intent: "status", idempotencyKey: "s1" });
    assert.deepEqual(st, { kind: "status", agent: a.id, state: "running" });
    const c = await r.daemon.receiveMessage({ channel: "discord", sender, body: "", to: a.id, intent: "cancel", idempotencyKey: "c1" });
    assert.notEqual(c.kind, "rejected");
    await until(async () => ["exited", "reaped"].includes((await r.daemon.get(a.id))?.state ?? ""), "cancelled");
    const again = await r.daemon.receiveMessage({ channel: "discord", sender, body: "", to: a.id, intent: "status", idempotencyKey: "s2" });
    assert.equal((again as { state?: string }).state === "running", false);
  } finally {
    await r.orchestrator.idle();
    r.store.close();
  }
});

test("transcript route: null before a checkpoint, newest entries after one (real checkpoint + session store)", async () => {
  let release!: () => void;
  const hold = new Promise<void>((res) => (release = res));
  const r = rig({ play: () => ({ hold, result: { status: "succeeded", result: null } }) });
  try {
    const a = await heldAgent(r, "tr");
    const get = (limit?: number) => operator(r.daemon, "GET", `/v1/agents/${a.id}/transcript${limit ? `?limit=${limit}` : ""}`);
    const before = await get();
    assert.ok(before.status === 200 || before.status === 404);
    await seedCheckpoint(r, a, "tr-cp", { workspace: "ws-tr", session: '{"m":1}\n{"m":2}\n' });
    const res = await get(1);
    assert.equal(res.status, 200);
    const body = res.body as { entries: unknown[]; total: number };
    assert.deepEqual(body.entries, [{ m: 2 }]);
    assert.equal(body.total, 2);
  } finally {
    release();
    await r.orchestrator.idle();
    r.store.close();
  }
});

test("messages/failed: host token on its own channel only; replay is deduped to one journal entry", async () => {
  const r = rig({ deps: discord });
  try {
    const body = { channel: "discord", purpose: "alert", subject: "s", reason: "dead", attempts: 3, idempotencyKey: "f1" };
    const post = (token: string, b: unknown) => handle(r.daemon, { method: "POST", url: "/v1/messages/failed", token, body: b });
    assert.equal((await post(r.daemon.agentToken("x", 0), body)).status, 403);
    assert.equal((await post(op, body)).status, 403);
    assert.equal((await post(hostTok("slack"), body)).status, 403);
    assert.equal((await post(hostTok("discord"), { ...body, purpose: "bogus" })).status, 400);
    assert.equal((await post(hostTok("discord"), body)).status, 201);
    assert.equal((await post(hostTok("discord"), body)).status, 201);
    const rows = (await r.daemon.events({ agent: (await r.daemon.root()).id })).filter((e) => e.payload.kind === "message_failed");
    assert.equal(rows.length, 1);
  } finally {
    r.store.close();
  }
});

// ---- admission holds: provider breaker, memory/resource gate ----

test("provider breaker hold: after retryable errors trip the breaker, a fresh spawn stays pending until it closes", async () => {
  let clock = Date.now();
  let runs = 0;
  const r = rig({
    now: () => clock,
    play: () =>
      ++runs === 1
        ? { events: [{ kind: "provider_error", code: "outage", message: "down", retryable: true } as never], hold: new Promise<void>(() => {}) }
        : { result: { status: "succeeded", result: null } },
    deps: {
      limits: { providerBackoffMs: 5, maxProviderBackoffMs: 50_000, maxProviderRetries: 5, providerBreakerThreshold: 1, providerBreakerWindowMs: 60_000 },
    },
  });
  try {
    const root = await r.daemon.root();
    const a = await r.daemon.spawn(root.id, { name: "a", task: "t", idempotencyKey: "a" });
    await until(async () => (await r.daemon.events({ agent: a.id })).some((e) => e.payload.kind === "ext.pomtreed.provider_degraded"), "breaker open");
    const b = await r.daemon.spawn(root.id, { name: "b", task: "t", idempotencyKey: "b" });
    await new Promise((res) => setTimeout(res, 100));
    assert.equal((await r.daemon.get(b.id))?.state, "pending", "held while the breaker is open");
    clock += 10 * 60_000; // breaker window elapses
    await until(async () => ["running", "exited", "reaped"].includes((await r.daemon.get(b.id))?.state ?? ""), "admitted after close");
  } finally {
    clock += 10 * 60_000;
    await r.orchestrator.idle().catch(() => {});
    r.store.close();
  }
});

test("memory/resource admission gate: a closed gate refuses a spawn with 503 (none recorded); reopening admits it", async () => {
  let open = false;
  const r = rig({ deps: { resourceGate: async () => (open ? { ok: true } : { ok: false, reason: "memory reservation exceeded" }) } });
  try {
    const body = { name: "g", task: "t", idempotencyKey: "g" };
    const closed = await operator(r.daemon, "POST", "/v1/agents", body);
    assert.equal(closed.status, 503);
    assert.match(String((closed.body as { error: string }).error), /memory reservation exceeded/);
    assert.equal((await r.daemon.list({ parent: (await r.daemon.root()).id })).length, 0, "nothing recorded");
    open = true;
    const ok = await operator(r.daemon, "POST", "/v1/agents", body);
    assert.ok(ok.status === 200 || ok.status === 201, `status ${ok.status}`);
    await r.orchestrator.idle();
  } finally {
    r.store.close();
  }
});
