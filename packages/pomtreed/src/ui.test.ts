import { tmpDir } from "@pomtree/testing";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { INBOX_JS } from "@pomtree/observe";
import type { AgentId, AgentRecord, PlacementStatus, Signal } from "@pomtree/core";
import { handle } from "./api.ts";
import { issueUiCookie, verifyUiCookie } from "./auth.ts";
import type { JournalRow } from "./daemon.ts";
import { listen } from "./server.ts";
import { renderLoginPage } from "./ui.ts";
import { SECRET, op, setup, spawnSpec } from "./test-setup.ts";
import { sockRequest } from "./test-http.ts";

const sock = () => join(tmpDir("pomtreed-"), "s.sock");

// A running, non-root agent created straight in the registry (no live drive handle), like the escalation tests.
async function runningAgent(t: ReturnType<typeof setup>, key: string): Promise<AgentRecord> {
  const root = await t.daemon.root();
  const a = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: root.id,
    name: "a",
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: key,
  });
  return t.daemon.deps.registry.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
}

const get = (sockPath: string, path: string, headers: Record<string, string> = {}) => sockRequest(sockPath, path, { headers });

test("POST /ui/login sets a verifiable HttpOnly UI cookie for the operator token", async () => {
  const t = setup(async () => {});
  const path = sock();
  const server = await listen(t.daemon, path);
  try {
    const login = await post(path, "/ui/login", undefined, { authorization: `Bearer ${op}` });
    assert.equal(login.status, 200);
    const setCookie = login.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
    assert.ok(cookie.startsWith("pomtreed_ui="));
    assert.ok(verifyUiCookie(SECRET, cookie), "cookie must verify against the daemon secret");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);

    // A non-operator token is refused and sets no cookie.
    const denied = await post(path, "/ui/login", undefined, { authorization: `Bearer ${t.daemon.agentToken("nobody")}` });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers["set-cookie"], undefined);
  } finally {
    server.close();
  }
});

test("GET /ui serves the shell with all tabs wired", async () => {
  const t = setup(async () => {});
  const path = sock();
  const server = await listen(t.daemon, path);
  try {
    const html = await get(path, "/ui", { cookie: issueUiCookie(SECRET, 60_000) });
    assert.match(html.body, /<title>pomtree<\/title>/);
    for (const tab of ["tree", "reports", "audit", "new", "schedules", "hosts", "terminal", "inbox"]) {
      assert.ok(html.body.includes(`data-tab="${tab}"`), `missing tab ${tab}`);
    }
    // The top nav is gone: the launcher bar replaces it, and no per-tab nav markup remains.
    assert.ok(!html.body.includes("data-nav="));
    assert.ok(html.body.includes('<header id="lb-bar" class="lb"></header>'), "missing launcher bar host");
    assert.ok(html.body.includes("createLauncherBar(wm,"), "launcher bar not started");
    assert.ok(html.body.includes('{ kind: "action", label: "Sign out", id: "sign-out" }'), "launcher lacks sign out");
    for (const id of ["export-layout", "import-layout", "reset-layout"]) assert.ok(html.body.includes(`id: "${id}"`), id);
    // The browser and report views ship their scripts inside tab sections and add no tab of their own.
    assert.ok(html.body.includes('K.registerView({ id: "browser"'));
    assert.ok(html.body.includes('K.registerView({ id: "report"'));
    assert.ok(html.body.includes('K.registerView({ id: "terminal"'));
    assert.ok(!html.body.includes('data-tab="browser"') && !html.body.includes('data-tab="report"'));
    // The tiling shell: sections wait in the stash until a tile hosts them, and the layout controls are present.
    assert.ok(html.body.includes('<div id="wm-stash" hidden><section data-tab="tree" hidden>'));
    for (const id of ["wm-root", "wm-notices"]) assert.ok(html.body.includes(`id="${id}"`), id);
    assert.ok(html.body.includes("createWindowManager("));
    assert.ok(html.body.includes('K.stream("/live/events"'));
    assert.ok(html.body.includes('"/v1/journal"'));
    assert.ok(html.body.includes('"/v1/placement"'));
    assert.ok(html.body.includes('"/v1/escalations"'));
    assert.ok(html.body.includes("+ New agent"));
    assert.ok(html.body.includes('"/v1/schedules"'));
    assert.deepEqual(
      [...html.body.matchAll(/\ssrc="([^"]*)"/g)].map((m) => m[1]),
      ["/ui/inbox.js"],
    ); // the Inbox script is the only external resource
    // Every inline script must at least parse (a syntax error would blank its pane at runtime).
    const scripts = [...html.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    assert.ok(scripts.length >= 8);
    for (const src of scripts) assert.doesNotThrow(() => new vm.Script(src));
  } finally {
    server.close();
  }
});

test("a UI cookie authenticates the operator read routes over HTTP", async () => {
  const t = setup(async () => {});
  const a = await runningAgent(t, "a");
  await t.journal.append({ agent: a.id, host: "h1", generation: a.generation, payload: { kind: "started" }, idempotencyKey: "s1" });
  const path = sock();
  const server = await listen(t.daemon, path);
  try {
    const cookie = issueUiCookie(SECRET, 60_000);
    const res = await get(path, `/v1/journal?agent=${a.id}`, { cookie });
    assert.equal(res.status, 200);
    assert.equal((JSON.parse(res.body) as JournalRow[]).length, 1);
    // Without the cookie the same route is unauthenticated.
    assert.equal((await get(path, `/v1/journal?agent=${a.id}`)).status, 401);
  } finally {
    server.close();
  }
});

test("GET /v1/journal filters by kind and agent", async () => {
  const t = setup(async () => {});
  const a = await runningAgent(t, "a");
  const b = await runningAgent(t, "b");
  await t.journal.append({ agent: a.id, host: "h1", generation: a.generation, payload: { kind: "started" }, idempotencyKey: "a1" });
  await t.journal.append({ agent: a.id, host: "h1", generation: a.generation, payload: { kind: "error", message: "boom" }, idempotencyKey: "a2" });
  await t.journal.append({ agent: b.id, host: "h1", generation: b.generation, payload: { kind: "error", message: "other" }, idempotencyKey: "b1" });

  const all = await t.operator("GET", `/v1/journal?agent=${a.id}`);
  assert.equal(all.status, 200);
  assert.equal((all.body as JournalRow[]).length, 2);

  const errors = await t.operator("GET", `/v1/journal?kind=error`);
  assert.equal((errors.body as JournalRow[]).length, 2);
  assert.ok((errors.body as JournalRow[]).every((r) => r.kind === "error"));

  const scoped = await t.operator("GET", `/v1/journal?agent=${a.id}&kind=error`);
  assert.equal((scoped.body as JournalRow[]).length, 1);
  assert.equal((scoped.body as JournalRow[])[0]!.agent, a.id);
  assert.equal((scoped.body as JournalRow[])[0]!.summary, "error: boom");

  // Operator scope only.
  assert.equal((await handle(t.daemon, { method: "GET", url: "/v1/journal", token: t.daemon.agentToken(a.id) })).status, 403);
});

test("GET /v1/placement returns running and queue", async () => {
  const t = setup(async () => {});
  for (let i = 0; i < 9; i++) await t.daemon.deps.placement.admit({ agent: `a${i}`, priority: 1 });
  const res = await t.operator("GET", "/v1/placement");
  assert.equal(res.status, 200);
  const p = res.body as PlacementStatus;
  assert.equal(p.host, "h1");
  assert.equal(p.maxConcurrent, 8);
  assert.equal(p.running.length, 8);
  assert.deepEqual(p.queue, [{ agent: "a8", priority: 1 }]);
});

test("POST /v1/agents/:id/message delivers a human_message and wakes the agent", async () => {
  let aId = "";
  const t = setup(async (c) => {
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  await t.spawn();
  await t.orchestrator.idle();

  // Spy on the orchestrator's wake so we can assert the yielded agent was woken.
  const wakes: Signal[] = [];
  const orch = t.orchestrator as unknown as { wake: (agent: AgentId, signal: Signal) => Promise<void> };
  const origWake = orch.wake.bind(orch);
  orch.wake = async (agent, signal) => {
    wakes.push(signal);
    return origWake(agent, signal);
  };

  const res = await t.operator("POST", `/v1/agents/${aId}/message`, { body: "hello", idempotencyKey: "m1" });
  assert.equal(res.status, 201);

  const box = await t.daemon.deps.mailbox.peek(aId);
  assert.equal(box.length, 1);
  assert.equal(box[0]!.kind, "human_message");
  assert.equal((box[0] as { body: string }).body, "hello");

  const entries = await t.journal.read({ agent: aId });
  const received = entries.find((e) => e.payload.kind === "message_received");
  assert.ok(received, "message_received journaled on the target");
  assert.equal((received!.payload as { channel: string }).channel, "cli");
  assert.equal((received!.payload as { to: string | null }).to, aId);

  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.kind, "human_message");

  // An unknown agent is a 404.
  assert.equal((await t.operator("POST", "/v1/agents/nobody/message", { body: "x", idempotencyKey: "m2" })).status, 404);
});

test("GET /v1/escalations filters by state and agent", async () => {
  const t = setup(async () => {});
  const a = await runningAgent(t, "a");
  const b = await runningAgent(t, "b");
  const ea = await t.daemon.ask(a.id, { question: "q1?", generation: a.generation, idempotencyKey: "k1" });
  await t.daemon.ask(b.id, { question: "q2?", generation: b.generation, idempotencyKey: "k2" });
  await t.daemon.answerEscalation(ea.escalation.id, "yes", { channel: "web", sender: "op" }, "ak");

  const open = await t.operator("GET", "/v1/escalations?state=open");
  assert.equal(open.status, 200);
  assert.equal((open.body as unknown[]).length, 1);
  assert.equal((open.body as { agent: string }[])[0]!.agent, b.id);

  const answered = await t.operator("GET", `/v1/escalations?agent=${a.id}&state=answered`);
  assert.equal((answered.body as unknown[]).length, 1);

  assert.equal((await t.operator("GET", "/v1/escalations?state=bogus")).status, 400);
});

const cookieOf = (h: Record<string, string | string[] | undefined>) => String(h["set-cookie"]).split(";")[0]!;

const post = (sockPath: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  sockRequest(sockPath, path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });

test("unauthenticated, garbage, and expired-cookie GET /ui serve the login page, not the shell", async () => {
  const t = setup(async () => {});
  const path = sock();
  const server = await listen(t.daemon, path);
  try {
    for (const headers of [{} as Record<string, string>, { cookie: "pomtreed_ui=garbage" }, { cookie: issueUiCookie(SECRET, -1000) }]) {
      const r = await get(path, "/ui", headers);
      assert.equal(r.status, 200);
      assert.ok(r.body.includes('type="password"') && r.body.includes("Paste your operator token") && r.body.includes("Sign in"));
      assert.ok(r.body.includes('"/ui/login"'));
      assert.ok(!r.body.includes("data-tab="));
      assert.ok(!r.body.includes("localStorage"));
      assert.equal(r.headers["cache-control"], "no-store");
      assert.match(String(r.headers["content-security-policy"]), /form-action 'self'/);
    }
  } finally {
    server.close();
  }
});

test("login then /ui serves shell; bad token 401; logout clears the cookie", async () => {
  const t = setup(async () => {});
  const path = sock();
  const server = await listen(t.daemon, path);
  try {
    const bad = await post(path, "/ui/login", { token: "nope" });
    assert.equal(bad.status, 401);
    assert.ok(!bad.body.includes("nope"));
    assert.ok(!(await get(path, "/ui")).body.includes("data-tab="));
    const ok = await post(path, "/ui/login", { token: op });
    assert.equal(ok.status, 200);
    const cookie = cookieOf(ok.headers);
    const shell = await get(path, "/ui", { cookie });
    assert.ok(shell.body.includes('data-tab="tree"') && shell.body.includes('id="lb-bar"') && shell.body.includes('id: "sign-out"'));
    const out = await post(path, "/ui/logout", {}, { cookie });
    assert.equal(out.status, 200);
    assert.match(String(out.headers["set-cookie"]), /^pomtreed_ui=; Max-Age=0; HttpOnly; SameSite=Strict; Path=\//);
    assert.equal((await post(path, "/ui/logout", {}, { origin: "http://evil.example" })).status, 403);
  } finally {
    server.close();
  }
});

test("login page has no token, supports #token= fragment sign-in, and is not logged specially", async () => {
  const t = setup(async () => {});
  const path = sock();
  const server = await listen(t.daemon, path);
  try {
    const r = await get(path, "/ui#token=" + op, {});
    assert.equal(r.status, 200);
    assert.ok(!r.body.includes(op) && !r.body.includes("op."));
    assert.ok(r.body.includes("location.hash") && r.body.includes("history.replaceState"));
    assert.ok(!r.body.includes("localStorage") && !r.body.includes("console."));
  } finally {
    server.close();
  }
});

test("GET /ui/inbox.js serves the Inbox script to an operator session only, same-origin and uncached", async () => {
  const t = setup(async () => {});
  const path = sock();
  const server = await listen(t.daemon, path);
  try {
    const ok = await get(path, "/ui/inbox.js", { cookie: issueUiCookie(SECRET, 60_000) });
    assert.equal(ok.status, 200);
    assert.match(String(ok.headers["content-type"]), /^application\/javascript/);
    assert.equal(ok.headers["x-content-type-options"], "nosniff");
    assert.equal(ok.headers["cache-control"], "no-store");
    assert.equal(ok.body, INBOX_JS);
    assert.doesNotThrow(() => new vm.Script(ok.body));
    assert.equal((await get(path, "/ui/inbox.js")).status, 401);
    const shell = await get(path, "/ui", { cookie: issueUiCookie(SECRET, 60_000) });
    assert.match(String(shell.headers["content-security-policy"]), /script-src 'self'/);
    assert.ok(shell.body.includes('<script src="/ui/inbox.js"></script>'));
  } finally {
    server.close();
  }
});

function runFragment(hash: string, status: number | "reject") {
  const html = renderLoginPage();
  const src = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const calls: string[] = [];
  const bodies: string[] = [];
  const el = (): Record<string, unknown> => ({ value: "", textContent: "", addEventListener() {} });
  const error = el();
  const ctx = {
    document: { getElementById: (id: string) => (id === "error" ? error : el()) },
    location: { hash, pathname: "/ui", reload: () => calls.push("reload") },
    history: { replaceState: (...a: unknown[]) => calls.push("replaceState:" + JSON.stringify(a)) },
    fetch: (u: string, o: { body: string }) => {
      calls.push("fetch:" + u);
      bodies.push(o.body);
      return status === "reject" ? Promise.reject(new Error("x")) : Promise.resolve({ status });
    },
    decodeURIComponent,
    JSON,
  };
  vm.runInNewContext(src, ctx);
  return { calls, bodies, error };
}

test("login page fragment handler: replaceState before fetch, POSTs {token}, reloads on 200", async () => {
  const r = runFragment("#token=op.abc%2B1", 200);
  assert.match(r.calls[0]!, /^replaceState:\[null,"","\/ui"\]$/);
  assert.equal(r.calls[1], "fetch:/ui/login");
  assert.deepEqual(JSON.parse(r.bodies[0]!), { token: "op.abc+1" });
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(r.calls.slice(2), ["reload"]);
});

test("login page fragment handler: failure shows 'Invalid token' without echoing it; no fragment does nothing", async () => {
  for (const st of [401, 403] as const) {
    const r = runFragment("#token=secretvalue", st);
    await new Promise((res) => setImmediate(res));
    assert.equal(r.error.textContent, "Invalid token");
    assert.ok(!r.calls.includes("reload"));
  }
  const n = runFragment("#token=secretvalue", "reject");
  await new Promise((res) => setImmediate(res));
  assert.ok(!String(n.error.textContent).includes("secretvalue"));
  assert.deepEqual(runFragment("", 200).calls, []);
  assert.deepEqual(runFragment("#other=1", 200).calls, []);
});
