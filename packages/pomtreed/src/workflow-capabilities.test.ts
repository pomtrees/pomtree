import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { AgentRecord, DeterministicRunContext, JournalEntry, JsonValue, QuotaCounters, Report } from "@pomtree/core";
import { CONFIG_DEFAULTS } from "@pomtree/core";
import { createFakes, FakeQuotaCounters } from "@pomtree/testing";
import { openStateStore, openStore } from "@pomtree/store-sqlite";
import { LifecycleError } from "./lifecycle.ts";
import { QUOTA_SCOPES } from "./quota.ts";
import { StatePolicy } from "./state-policy.ts";
import { handleState } from "./state-routes.ts";
import type { FetchFn, FetchResponse } from "./ext-gateway.ts";
import { testBroker } from "./test-capture.ts";
import {
  buildRunOps,
  FETCH_BROKER_REQUIRED,
  FETCH_KIND,
  normalizeCapabilities,
  SHARED_SCOPE,
  scopedKey,
  STATE_KIND,
  type WorkflowCapabilityServices,
} from "./workflow-capabilities.ts";

// Offline only: injected transports and resolvers, in-memory root journal, no network, no daemon.

const HOSTS = ["news.example.org"];
const CEILING = CONFIG_DEFAULTS["report.workflowMaxBytes"];
const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];
const body = (text: string): AsyncIterable<Uint8Array> =>
  (async function* () {
    yield new TextEncoder().encode(text);
  })();
const resp = (status: number, text = "", headers: Record<string, string> = {}): FetchResponse => ({
  status,
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  body: text === "" && status >= 300 ? null : body(text),
});

test("normalizeCapabilities: absent declares nothing ({}); malformed or unknown declarations throw", () => {
  assert.deepEqual(normalizeCapabilities("x/y", undefined, CEILING), {});
  assert.deepEqual(normalizeCapabilities("x/y", { state: true, reports: { maxBytes: 1000 } }, CEILING), { state: true, reports: { maxBytes: 1000 } });
  assert.throws(() => normalizeCapabilities("x/y", { unknown: true }, CEILING), /unknown capability/);
  assert.throws(() => normalizeCapabilities("x/y", { fetch: { hosts: ["Bad/Host"], maxRequests: 1, maxBytes: 10, timeoutMs: 10 } }, CEILING), /malformed/);
  assert.throws(() => normalizeCapabilities("x/y", { fetch: { hosts: HOSTS, maxRequests: 1, maxBytes: 10, timeoutMs: 20_000 } }, CEILING), /fetch limits/);
  assert.throws(() => normalizeCapabilities("x/y", { reports: { maxBytes: 300_000 } }, CEILING), /reports\.maxBytes 300000 exceeds the report ceiling 262144/);
  assert.throws(() => normalizeCapabilities("x/y", { reports: { maxBytes: 1.5 } }, CEILING), /malformed capability reports/);
  assert.throws(() => normalizeCapabilities("x/y", { ask: "yes" }, CEILING), /malformed/);
});

test("normalizeCapabilities checks declarations against the resolved ceiling, not a compiled cap (D1)", () => {
  const fetch = (maxBytes: number) => ({ fetch: { hosts: HOSTS, maxRequests: 1, maxBytes, timeoutMs: 1000 } });
  // Lowered ceiling: a 262144 declaration (the digest's) is refused at commit, not clamped at run time.
  assert.throws(() => normalizeCapabilities("x/y", fetch(262_144), 131_072), /fetch\.maxBytes 262144 exceeds the report ceiling 131072/);
  assert.throws(() => normalizeCapabilities("x/y", { reports: { maxBytes: 262_144 } }, 131_072), /reports\.maxBytes 262144 exceeds/);
  assert.deepEqual(normalizeCapabilities("x/y", { reports: { maxBytes: 131_072 } }, 131_072), { reports: { maxBytes: 131_072 } });
  // Raised ceiling: a declaration above the old compiled 256 KiB is honored up to it.
  assert.equal(normalizeCapabilities("x/y", fetch(1 << 20), 1 << 20)?.fetch?.maxBytes, 1 << 20);
  assert.equal(normalizeCapabilities("x/y", { reports: { maxBytes: 1 << 20 } }, 1 << 20)?.reports?.maxBytes, 1 << 20);
  assert.throws(() => normalizeCapabilities("x/y", fetch((1 << 20) + 1), 1 << 20), /exceeds the report ceiling/);
});

type Hop = { url: string; redirect: string; headers?: Record<string, string>; pin?: unknown };
// A scripted origin transport for the capture broker: each URL answers from `routes` (a 3xx carries its Location); a robots.txt
// nobody scripted answers 404 (allow all, RFC 9309), and any other unscripted URL throws. Every origin call (robots.txt excluded)
// is recorded in `seen`; robots.txt calls go to `robots` when given.
const scripted =
  (routes: Record<string, FetchResponse | (() => FetchResponse)>, seen: Hop[], robots: Hop[] = []) =>
  async (url: string, init: Omit<Hop, "url">): Promise<FetchResponse> => {
    const hop = { url, redirect: init.redirect, ...(init.headers && { headers: init.headers }), ...(init.pin !== undefined && { pin: init.pin }) };
    const r = routes[url];
    if (new URL(url).pathname === "/robots.txt" && r === undefined) {
      robots.push(hop);
      return resp(404, "no robots");
    }
    seen.push(hop);
    if (!r) throw new Error(`unscripted ${url}`);
    return typeof r === "function" ? r() : r;
  };
const to = (location: string, status = 302) => resp(status, "", { location });

// ---- run ops over fake services -------------------------------------------------------------------------------------------

const Q = "ext/digest";
function fakeWorld(gen = 1) {
  const journal: JournalEntry[] = [];
  let seq = 1;
  const keys = new Map<string, JsonValue>();
  const sent: { body: string; key: string }[] = [];
  const reports: { name: string; key: string }[] = [];
  const reportIds = new Map<string, Report>();
  const asks: { question: string; generation: number; idempotencyKey: string }[] = [];
  const agent = { id: "task-1", state: "running", host: "h", generation: gen } as unknown as AgentRecord;
  const svc: WorkflowCapabilityServices = {
    root: async () => ({ id: "root", generation: 7, state: "running" }) as unknown as AgentRecord,
    agent: async (id) => (id === agent.id ? agent : ({ id, state: "running", generation: 1 } as unknown as AgentRecord)),
    readRoot: async (from, limit) => journal.filter((e) => e.seq >= from).slice(0, limit),
    recordRoot: async (payload, key) => {
      if (keys.has(key)) return null; // journal dedupe by key (the store's behaviour)
      keys.set(key, payload as unknown as JsonValue);
      journal.push({ seq: seq++, ts: 0, agent: "root", host: "h", generation: 7, payload } as unknown as JournalEntry);
      return null;
    },
    publishRoot: async (req) => {
      reports.push({ name: req.name, key: req.key });
      // Root report store: a repeated key converges on the first report.
      const id = `r-${req.key}`;
      if (!reportIds.has(id)) reportIds.set(id, { id, name: req.name } as unknown as Report);
      return reportIds.get(id)!;
    },
    sendToUser: async (body, key) => {
      sent.push({ body, key });
    },
    redactText: (t) => t.replaceAll("/home/op/secret", "<state>"),
    ask: async (_a, req) => {
      asks.push(req);
      return { escalation: `es-${req.idempotencyKey}` };
    },
    now: () => 1_000,
  };
  // The capture broker the fetch capability is a client of, over fakes; `route` swaps its origin transport.
  const route = (fetch: FetchFn, quota?: QuotaCounters) => {
    const t = testBroker({ fetch, resolveDns: PUBLIC, generationOf: async (id) => (await svc.agent(id))?.generation ?? null, ...(quota && { quota }) });
    svc.capture = t.broker;
    return t;
  };
  route(async (url) => (new URL(url).pathname === "/robots.txt" ? resp(404) : resp(200, "payload")));
  return { journal, svc, sent, reports, asks, agent, route };
}
const ctxFor = (over: Partial<DeterministicRunContext> = {}, input: JsonValue = { instance: "daily" }): DeterministicRunContext =>
  ({
    agent: "task-1",
    generation: 1,
    host: "h",
    input,
    signal: new AbortController().signal,
    deadlineAt: null,
    ops: {} as never,
    ...over,
  }) as DeterministicRunContext;

const FULL = { state: true, fetch: { hosts: HOSTS, maxRequests: 2, maxBytes: 1000, timeoutMs: 1000 }, reports: { maxBytes: 4096 }, ask: true } as const;

test("fetch: a response without a Content-Type journals no contentType; the hash is the one the handler gets", async () => {
  const w = fakeWorld();
  const caps = { fetch: { hosts: HOSTS, maxRequests: 1, maxBytes: 64, timeoutMs: 1000 } } as const;
  const ops = buildRunOps({ workflow: Q, caps, ctx: ctxFor(), getServices: () => w.svc });
  const out = await ops.fetch("https://news.example.org/x");
  const [row] = w.journal.map((e) => e.payload as unknown as Record<string, unknown>).filter((p) => p.kind === FETCH_KIND);
  assert.equal("contentType" in (row ?? {}), false);
  assert.equal(row?.sha256, out.sha256);
  assert.equal(row?.maxBytes, 64);
});

test("undeclared capabilities are denied, not silently allowed", async () => {
  const w = fakeWorld();
  const ops = buildRunOps({ workflow: Q, caps: {}, ctx: ctxFor(), getServices: () => w.svc });
  await assert.rejects(ops.getState(), /not declared: state/);
  await assert.rejects(ops.fetch("https://news.example.org/"), /not declared: fetch/);
  await assert.rejects(ops.publishReport({ name: "r", content: "x" }, "k"), /not declared: reports/);
  await assert.rejects(ops.ask("q", "k"), /not declared: ask/);
});

test("state rows name the workflow task and generation that wrote them; a repaired task's replay adds no row", async () => {
  const w = fakeWorld();
  const a = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor(), getServices: () => w.svc });
  await a.setState({ n: 1 }, "s1");
  const b = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor({ agent: "task-2", generation: 2 }), getServices: () => w.svc });
  w.agent.id = "task-2" as never;
  w.agent.generation = 2;
  await b.setState({ n: 1 }, "s1"); // replay of the same logical write
  await b.setState({ n: 2 }, "s2");
  const rows = w.journal.map((e) => e.payload as unknown as Record<string, unknown>).filter((p) => p.kind === STATE_KIND);
  assert.deepEqual(rows, [
    { kind: STATE_KIND, v: 1, workflow: Q, instance: "daily", execution: "task-1", generation: 1, key: "s1", value: { n: 1 } },
    { kind: STATE_KIND, v: 1, workflow: Q, instance: "daily", execution: "task-2", generation: 2, key: "s2", value: { n: 2 } },
  ]);
  assert.deepEqual(await b.getState(), { n: 2 });
});

test("state is instance-scoped, survives a task replacement and conflicting keys are refused", async () => {
  const w = fakeWorld();
  const a = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor(), getServices: () => w.svc });
  assert.equal(a.instance, "daily");
  assert.equal(await a.getState(), null);
  await a.setState({ seen: [1, 2] }, "plan-1");
  await a.setState({ seen: [1, 2] }, "plan-1"); // exact retry is idempotent
  await assert.rejects(a.setState({ seen: [9] }, "plan-1"), /different value/);
  assert.deepEqual(await a.getState(), { seen: [1, 2] });
  // A replacement task of the same workflow + instance sees the same root state.
  const b = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor({ agent: "task-2" }), getServices: () => w.svc });
  assert.deepEqual(await b.getState(), { seen: [1, 2] });
  // Another instance is isolated.
  const other = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor({}, { instance: "weekly" }), getServices: () => w.svc });
  assert.equal(await other.getState(), null);
});

test("state cap, invalid instance and oversized state are refused before any write", async () => {
  const w = fakeWorld();
  assert.throws(() => buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor({}, { instance: "Bad Name" }), getServices: () => w.svc }), /input.instance/);
  const ops = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor(), getServices: () => w.svc });
  await assert.rejects(ops.setState("x".repeat(130 * 1024), "big"), /128 KiB/);
  assert.equal(w.journal.length, 0);
});

test("stale generation, aborted and late callbacks are fenced before effects", async () => {
  const w = fakeWorld(2);
  const stale = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor({ generation: 1 }), getServices: () => w.svc });
  await assert.rejects(stale.setState({ a: 1 }, "k"), /no longer live/);
  const ac = new AbortController();
  const aborted = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor({ generation: 2, signal: ac.signal }), getServices: () => w.svc });
  ac.abort();
  await assert.rejects(aborted.sendToUser("hi", "k"), /cancelled/);
  const late = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor({ generation: 2, deadlineAt: 500 }), getServices: () => w.svc });
  await assert.rejects(late.ask("q", "k"), /deadline/);
  assert.equal(w.sent.length, 0);
  assert.equal(w.asks.length, 0);
});

test("reports are root-owned with scoped effect keys and root provenance; sends use the scoped key", async () => {
  const w = fakeWorld();
  const ops = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor(), getServices: () => w.svc });
  const rep = await ops.publishReport({ name: "digest", content: "# digest" }, "day-1");
  assert.equal(rep.id, `r-${scopedKey(Q, "daily", "report", "day-1")}`);
  assert.ok(w.journal.some((e) => (e.payload as unknown as { kind: string }).kind === "ext.pomtreed.workflow_report"));
  await ops.sendToUser("summary", "day-1");
  assert.deepEqual(w.sent, [{ body: "summary", key: scopedKey(Q, "daily", "send", "day-1") }]);
  // A replacement task repeats the same logical effect: the same keys reach the services.
  const again = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor({ agent: "task-2" }), getServices: () => w.svc });
  await again.sendToUser("summary", "day-1");
  assert.equal(w.sent.length, 2);
  assert.equal(w.sent[0]!.key, w.sent[1]!.key);
  await assert.rejects(ops.publishReport({ name: "big", content: "x".repeat(5000) }, "day-2"), /declared size/);
});

test("fetch is bounded by the declared request count, host allowlist and the fetched record shape", async () => {
  const w = fakeWorld();
  const ops = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor(), getServices: () => w.svc });
  const f = await ops.fetch("https://news.example.org/feed");
  assert.equal(f.status, 200);
  assert.equal(f.body, "payload");
  assert.equal(f.sha256, createHash("sha256").update("payload").digest("hex"));
  assert.equal(typeof f.fetchedAt, "number");
  await ops.fetch("https://news.example.org/two");
  await assert.rejects(ops.fetch("https://news.example.org/three"), /budget exhausted/);
  const scoped = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor(), getServices: () => w.svc });
  await assert.rejects(scoped.fetch("https://other.example.net/"), (e: unknown) => e instanceof LifecycleError && e.status === 403);
});

test("fetch: the result carries the FetchMeta fields: final URL, every redirect hop, the content type and allowlisted headers", async () => {
  const w = fakeWorld();
  w.route(
    scripted(
      {
        "https://news.example.org/a": to("/a2", 301),
        "https://news.example.org/a2": resp(200, "A", { "content-type": "application/rss+xml", etag: '"v1"', "set-cookie": "sid=1" }),
      },
      [],
    ),
  );
  const caps = { fetch: { hosts: HOSTS, maxRequests: 3, maxBytes: 1000, timeoutMs: 1000 } } as const;
  const f = await buildRunOps({ workflow: Q, caps, ctx: ctxFor(), getServices: () => w.svc }).fetch("https://news.example.org/a");
  assert.equal(f.contentType, "application/rss+xml");
  assert.equal(f.url, "https://news.example.org/a2");
  assert.equal(f.finalUrl, "https://news.example.org/a2");
  assert.deepEqual(f.redirects, [{ url: "https://news.example.org/a", status: 301 }]);
  assert.equal(f.headers?.etag, '"v1"');
  assert.equal(f.headers?.["set-cookie"], undefined, "headers are allowlisted: Set-Cookie never reaches the workflow");
  assert.equal(f.body, "A");
});

test("fetch: every redirect hop is a request against maxRequests and carries the services' User-Agent; a hop outside hosts is a 403", async () => {
  const w = fakeWorld();
  const seen: Hop[] = [];
  const robots: Hop[] = [];
  w.route(
    scripted(
      {
        "https://news.example.org/a": to("/a2"),
        "https://news.example.org/a2": resp(200, "A"),
        "https://news.example.org/b": to("https://cdn.example.org/b"),
      },
      seen,
      robots,
    ),
  );
  const caps = { fetch: { hosts: HOSTS, maxRequests: 3, maxBytes: 1000, timeoutMs: 1000 } } as const;
  const ops = buildRunOps({ workflow: Q, caps, ctx: ctxFor(), getServices: () => w.svc });
  const f = await ops.fetch("https://news.example.org/a"); // two requests sent
  assert.equal(f.url, "https://news.example.org/a2");
  assert.equal(f.body, "A");
  assert.ok(
    [...seen, ...robots].every((h) => h.headers?.["user-agent"] === "pomtree-test test@example.invalid"),
    "the broker's one User-Agent",
  );
  await assert.rejects(
    ops.fetch("https://news.example.org/b"), // the cross-host hop leaves the capability's hosts: never sent
    (e: unknown) => e instanceof LifecycleError && e.status === 403 && /egress policy blocks this host/.test(e.message),
  );
  assert.deepEqual(
    seen.map((h) => h.url),
    ["https://news.example.org/a", "https://news.example.org/a2", "https://news.example.org/b"],
  );
  assert.equal(robots.length, 1, "robots.txt is read once for the origin and cached");
});

test("fetch: every call is journaled on the root, query stripped, with status, bytes, content type, hash, cap, duration, hops and the request budget", async () => {
  const w = fakeWorld();
  let clock = 1_000;
  w.svc.now = () => (clock += 5);
  w.route(
    scripted(
      {
        "https://news.example.org/a?cik=123&token=s3cret": to("/a2?page=2"),
        "https://news.example.org/a2?page=2": resp(200, "hello", { "content-type": "text/plain; charset=utf-8" }),
        "https://news.example.org/b": resp(404, "gone"),
      },
      [],
    ),
  );
  const caps = { fetch: { hosts: HOSTS, maxRequests: 2, maxBytes: 1000, timeoutMs: 1000 } } as const;
  const ops = buildRunOps({ workflow: Q, caps, ctx: ctxFor(), getServices: () => w.svc });
  await ops.fetch("https://news.example.org/a?cik=123&token=s3cret");
  await assert.rejects(ops.fetch("https://news.example.org/a"), /budget exhausted/);
  const rows = w.journal.map((e) => e.payload as unknown as Record<string, unknown>).filter((p) => p.kind === FETCH_KIND);
  const base = { kind: FETCH_KIND, workflow: Q, instance: "daily", execution: "task-1", generation: 1, maxRequests: 2, maxBytes: 1000 };
  assert.deepEqual(rows, [
    {
      ...base,
      url: "https://news.example.org/a",
      finalUrl: "https://news.example.org/a2",
      ok: true,
      status: 200,
      bytes: 5,
      contentType: "text/plain; charset=utf-8",
      sha256: createHash("sha256").update("hello").digest("hex"),
      durationMs: 5,
      requests: 2,
      redirects: 1,
      requestsUsed: 2,
    },
    {
      ...base,
      url: "https://news.example.org/a",
      ok: false,
      durationMs: 0,
      requests: 0,
      redirects: 0,
      requestsUsed: 2,
      error: "fetch request budget exhausted",
    },
  ]);
  assert.ok(!JSON.stringify(w.journal).includes("s3cret"), "the query never reaches the journal");
});

test("fetch: a failed capture is journaled with the broker's model text and maps to a status", async () => {
  const w = fakeWorld();
  w.route(scripted({ "https://news.example.org/gone": resp(404, "gone"), "https://news.example.org/no": resp(403, "no") }, []));
  const caps = { fetch: { hosts: HOSTS, maxRequests: 5, maxBytes: 1000, timeoutMs: 1000 } } as const;
  const ops = buildRunOps({ workflow: Q, caps, ctx: ctxFor(), getServices: () => w.svc });
  await assert.rejects(ops.fetch("https://news.example.org/no"), (e: unknown) => e instanceof LifecycleError && e.status === 403);
  const rows = w.journal.map((e) => e.payload as unknown as Record<string, unknown>).filter((p) => p.kind === FETCH_KIND);
  assert.deepEqual(rows.at(-1)?.error, "capture blocked: news.example.org refused the request (HTTP 403); do not retry; report the source as unavailable");
  assert.equal(rows.at(-1)?.status, 403);
});

test("fetch: calls that send nothing are journaled at most maxRequests times per task", async () => {
  const w = fakeWorld();
  const caps = { fetch: { hosts: HOSTS, maxRequests: 2, maxBytes: 1000, timeoutMs: 1000 } } as const;
  const ops = buildRunOps({ workflow: Q, caps, ctx: ctxFor(), getServices: () => w.svc });
  for (let i = 0; i < 6; i++)
    await assert.rejects(ops.fetch(`https://other.example.net/${i}`), (e: unknown) => e instanceof LifecycleError && e.status === 403);
  await ops.fetch("https://news.example.org/ok"); // a sent request is always journaled
  const rows = w.journal.map((e) => e.payload as unknown as Record<string, unknown>).filter((p) => p.kind === FETCH_KIND);
  assert.deepEqual(
    rows.map((r) => [r.url, r.ok, r.requests]),
    [
      ["https://other.example.net/0", false, 0],
      ["https://other.example.net/1", false, 0],
      ["https://news.example.org/ok", true, 1],
    ],
  );
});

test("fetch: without a capture broker every fetch refuses (503) naming the missing wiring; there is no direct path", async () => {
  const w = fakeWorld();
  delete w.svc.capture;
  const ops = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor(), getServices: () => w.svc });
  await assert.rejects(
    ops.fetch("https://news.example.org/feed"),
    (e: unknown) => e instanceof LifecycleError && e.status === 503 && e.message === FETCH_BROKER_REQUIRED,
  );
  assert.match(FETCH_BROKER_REQUIRED, /WorkflowCapabilityServices\.capture.*createCaptureBroker/);
});

test("fetch: maxRequests is counted in the store's QuotaCounters by task and generation, so a daemon restart does not refill it", async () => {
  const store = openStore(":memory:");
  const quota = store.quotaCounters();
  const caps = { fetch: { hosts: HOSTS, maxRequests: 2, maxBytes: 1000, timeoutMs: 1000 } } as const;
  const w = fakeWorld();
  w.svc.quota = quota;
  const before = buildRunOps({ workflow: Q, caps, ctx: ctxFor(), getServices: () => w.svc });
  await before.fetch("https://news.example.org/one");
  assert.equal(quota.peek(QUOTA_SCOPES.workflowFetchRequests, "task-1:1", 0), 1);
  const after = buildRunOps({ workflow: Q, caps, ctx: ctxFor(), getServices: () => w.svc }); // the same task after a restart
  await after.fetch("https://news.example.org/two");
  await assert.rejects(after.fetch("https://news.example.org/three"), (e: unknown) => e instanceof LifecycleError && e.status === 409);
  const rows = w.journal.map((e) => e.payload as unknown as Record<string, unknown>).filter((p) => p.kind === FETCH_KIND);
  assert.deepEqual(
    rows.map((r) => r.requestsUsed),
    [1, 2, 2],
    "the audit row reads the durable count",
  );
  // Negative: a new generation (or task) has its own budget.
  const next = buildRunOps({ workflow: Q, caps, ctx: ctxFor({ generation: 2 }), getServices: () => w.svc });
  w.agent.generation = 2;
  assert.equal((await next.fetch("https://news.example.org/four")).status, 200);
});

test("fetch: a redirect hop past the remaining maxRequests is refused (409) before it is sent; a cache hit or joined job costs nothing", async () => {
  const w = fakeWorld();
  const seen: Hop[] = [];
  w.route(
    scripted(
      {
        "https://news.example.org/one": resp(200, "1"),
        "https://news.example.org/a": to("/b"),
        "https://news.example.org/b": to("/c"),
        "https://news.example.org/c": resp(200, "C"),
      },
      seen,
    ),
  );
  const caps = { fetch: { hosts: HOSTS, maxRequests: 3, maxBytes: 1000, timeoutMs: 1000 } } as const;
  const ops = buildRunOps({ workflow: Q, caps, ctx: ctxFor(), getServices: () => w.svc });
  await ops.fetch("https://news.example.org/one"); // 1 of 3
  const again = await ops.fetch("https://news.example.org/one"); // the shared cache: nothing sent, nothing charged
  assert.equal(again.body, "1");
  await assert.rejects(
    ops.fetch("https://news.example.org/a"), // /a and /b fit; /c would be the fourth
    (e: unknown) => e instanceof LifecycleError && e.status === 409 && /redirect hop 2 would exceed maxRequests/.test(e.message),
  );
  assert.deepEqual(
    seen.map((h) => h.url),
    ["https://news.example.org/one", "https://news.example.org/a", "https://news.example.org/b"],
    "the excess hop is never sent",
  );
  await assert.rejects(ops.fetch("https://news.example.org/two"), (e: unknown) => e instanceof LifecycleError && e.status === 409);
  assert.equal(seen.length, 3);
  // Concurrent identical fetches share one capture job: one request is sent and only its creator is charged.
  const w2 = fakeWorld();
  const seen2: Hop[] = [];
  const quota = new FakeQuotaCounters();
  w2.svc.quota = quota;
  w2.route(scripted({ "https://news.example.org/one": resp(200, "1") }, seen2));
  const one = buildRunOps({ workflow: Q, caps: { fetch: { ...caps.fetch, maxRequests: 1 } }, ctx: ctxFor(), getServices: () => w2.svc });
  const both = await Promise.allSettled([one.fetch("https://news.example.org/one"), one.fetch("https://news.example.org/one")]);
  assert.deepEqual(
    both.map((r) => r.status),
    ["fulfilled", "fulfilled"],
  );
  assert.equal(seen2.length, 1);
  assert.equal(quota.peek(QUOTA_SCOPES.workflowFetchRequests, "task-1:1", 0), 1, "the joiner was not charged");
});

test("fetch: the capability's maxBytes stops the body read at the cap (502), and the refusal is not cached for a larger cap", async () => {
  const w = fakeWorld();
  w.route(scripted({ "https://news.example.org/big": () => resp(200, "x".repeat(200)) }, []));
  const small = buildRunOps({
    workflow: Q,
    caps: { fetch: { hosts: HOSTS, maxRequests: 5, maxBytes: 100, timeoutMs: 1000 } },
    ctx: ctxFor(),
    getServices: () => w.svc,
  });
  await assert.rejects(
    small.fetch("https://news.example.org/big"),
    (e: unknown) => e instanceof LifecycleError && e.status === 502 && /exceeds 100 bytes/.test(e.message),
  );
  // Another task (its own call ordinals, so its own idempotency key) with a larger cap reads the page: nothing was negatively cached.
  const large = buildRunOps({
    workflow: Q,
    caps: { fetch: { hosts: HOSTS, maxRequests: 5, maxBytes: 1000, timeoutMs: 1000 } },
    ctx: ctxFor({ agent: "task-2" }),
    getServices: () => w.svc,
  });
  assert.equal((await large.fetch("https://news.example.org/big")).body.length, 200);
});

test("ask routes through the services with a scoped key and the task generation", async () => {
  const w = fakeWorld(3);
  const ops = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor({ generation: 3 }), getServices: () => w.svc });
  const r = await ops.ask("Which post?", "q1");
  assert.deepEqual(w.asks, [{ question: "Which post?", generation: 3, idempotencyKey: scopedKey(Q, "daily", "ask", "q1") }]);
  assert.equal(r.escalation.startsWith("es-"), true);
});

test("instance: a provided malformed instance is denied even without state; absent is accepted for reports-only", () => {
  const w = fakeWorld();
  const reportsOnly = { reports: { maxBytes: 4096 } } as const;
  assert.throws(() => buildRunOps({ workflow: Q, caps: reportsOnly, ctx: ctxFor({}, { instance: "a:b" }), getServices: () => w.svc }), /input.instance/);
  assert.throws(() => buildRunOps({ workflow: Q, caps: reportsOnly, ctx: ctxFor({}, { instance: 7 }), getServices: () => w.svc }), /input.instance/);
  const ok = buildRunOps({ workflow: Q, caps: reportsOnly, ctx: ctxFor({}, {}), getServices: () => w.svc });
  assert.equal(ok.instance, "");
});

test("runKey is per launch: same instance, different tasks get different logical runs", () => {
  const w = fakeWorld();
  const first = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor({ agent: "task-1" }), getServices: () => w.svc });
  const fresh = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor({ agent: "task-3" }), getServices: () => w.svc });
  assert.notEqual(first.runKey, fresh.runKey);
  assert.equal(first.instance, fresh.instance);
});

test("repair: a replacement task with the handler's old key converges on the original report", async () => {
  const w = fakeWorld();
  const orig = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor({ agent: "task-1" }), getServices: () => w.svc });
  const first = await orig.publishReport({ name: "digest", content: "# d" }, "run-A:report");
  const repaired = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor({ agent: "task-2" }), getServices: () => w.svc });
  const again = await repaired.publishReport({ name: "digest", content: "# d" }, "run-A:report");
  assert.equal(again.id, first.id);
  // Provenance is keyed by the stable effect key: the original execution is audited once, the repair adds no second record.
  const prov = w.journal.map((e) => e.payload as unknown as Record<string, unknown>).filter((p) => p.kind === "ext.pomtreed.workflow_report");
  assert.equal(prov.length, 1);
  assert.equal(prov[0]?.execution, "task-1");
  assert.equal(prov[0]?.effectKey, "run-A:report");
});

test("getState is fenced like every other facade op (stale, aborted, deadline)", async () => {
  const w = fakeWorld(2);
  const stale = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor({ generation: 1 }), getServices: () => w.svc });
  await assert.rejects(stale.getState(), /no longer live/);
  const ac = new AbortController();
  const aborted = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor({ generation: 2, signal: ac.signal }), getServices: () => w.svc });
  ac.abort();
  await assert.rejects(aborted.getState(), /cancelled/);
  const late = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor({ generation: 2, deadlineAt: 500 }), getServices: () => w.svc });
  await assert.rejects(late.getState(), /deadline/);
});

test("the state journal kind is the documented root kind", () => {
  assert.equal(STATE_KIND, "ext.pomtreed.workflow_state");
});

test("state payloads are versioned v:1; missing or unknown versions fail closed on read (409)", async () => {
  const w = fakeWorld();
  const a = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor(), getServices: () => w.svc });
  await a.setState({ n: 1 }, "k1");
  const written = w.journal[0]!.payload as unknown as Record<string, unknown>;
  assert.equal(written.v, 1);
  assert.deepEqual(await a.getState(), { n: 1 });
  const cases: Record<string, unknown>[] = [
    { kind: STATE_KIND, workflow: Q, instance: "daily", key: "legacy", value: 9 },
    { kind: STATE_KIND, v: 2, workflow: Q, instance: "daily", key: "future", value: 9 },
  ];
  for (const payload of cases) {
    const w2 = fakeWorld();
    w2.journal.push({ seq: 1, ts: 0, agent: "root", host: "h", generation: 7, payload } as unknown as JournalEntry);
    const ops = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor(), getServices: () => w2.svc });
    await assert.rejects(ops.getState(), (e: unknown) => e instanceof LifecycleError && e.status === 409 && /not supported/.test(e.message));
    await assert.rejects(ops.setState({ n: 2 }, "k2"), (e: unknown) => e instanceof LifecycleError && e.status === 409);
  }
});

test("state with host paths in key, value or object key is rejected before any write", async () => {
  const w = fakeWorld();
  const ops = buildRunOps({ workflow: Q, caps: FULL, ctx: ctxFor(), getServices: () => w.svc });
  await assert.rejects(ops.setState({ p: "/home/op/secret/x" }, "k1"), /host paths/);
  await assert.rejects(ops.setState({ a: ["/home/op/secret"] }, "k1"), /host paths/);
  await assert.rejects(ops.setState({ "/home/op/secret": 1 }, "k1"), /host paths/);
  await assert.rejects(ops.setState({ ok: 1 }, "/home/op/secret/key"), /host paths/);
  assert.equal(w.journal.length, 0);
  await ops.setState({ ok: 1 }, "k1");
  await ops.setState({ ok: 1 }, "k1");
  await assert.rejects(ops.setState({ ok: 2 }, "k1"), /different value/);
  assert.equal(w.journal.length, 1);
});

test("normalizeCapabilities: store is an empty object", () => {
  assert.deepEqual(normalizeCapabilities("x/y", { store: {} }, CEILING), { store: {} });
  assert.throws(() => normalizeCapabilities("x/y", { store: { maxDocs: 1 } }, CEILING), /malformed capability store/);
  assert.throws(() => normalizeCapabilities("x/y", { store: true }, CEILING), /malformed capability store/);
});

test("ctx.workflow.store: owner is the extension, keys are workflow+instance scoped, mutations journal content-free state_ops, replays are idempotent", async () => {
  const fakes = createFakes({ host: "h" });
  const rec = await fakes.registry.create({
    id: "task-1",
    parent: null,
    name: "t",
    task: "t",
    host: "h",
    budgetMicros: 1,
    idempotencyKey: "t1",
    spec: { image: "i", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "registry" } },
  });
  const w = fakeWorld(rec.generation);
  w.svc.state = fakes.state;
  const ctx = ctxFor({ generation: rec.generation });
  const mk = (input: JsonValue) =>
    buildRunOps({ workflow: Q, caps: { store: {} }, ctx: ctxFor({ generation: rec.generation, input }), getServices: () => w.svc });
  const ops = buildRunOps({ workflow: Q, caps: { store: {} }, ctx, getServices: () => w.svc });
  const put = await ops.store?.put({ key: "seen/hn", value: { ids: [1] } }, "p1");
  assert.ok(put?.ok && put.doc.key === "seen/hn" && put.doc.rev === 1);
  assert.deepEqual((await fakes.state.get("ext", "digest/i/daily/seen/hn"))?.value, { ids: [1] }); // owner = extension, scoped key
  assert.equal(await fakes.state.get("ext", "seen/hn"), null);
  const again = await ops.store?.put({ key: "seen/hn", value: { ids: [1] } }, "p1");
  assert.ok(again?.ok && again.doc.rev === 1);
  const conflict = await ops.store?.put({ key: "seen/hn", value: 2, expectRev: 9 }, "p2");
  assert.deepEqual(conflict, { ok: false, reason: "conflict", currentRev: 1 });
  assert.deepEqual(
    (await ops.store?.list({ prefix: "seen/" }))?.map((m) => m.key),
    ["seen/hn"],
  );
  assert.deepEqual((await mk({ instance: "other" }).store?.list())?.length, 0); // another instance does not see it
  const ops2 = buildRunOps({
    workflow: Q,
    caps: { store: {} },
    ctx: ctxFor({ generation: rec.generation, input: { instance: "daily" } }),
    getServices: () => w.svc,
  });
  assert.equal((await ops2.store?.get("seen/hn"))?.rev, 1); // a replacement task sees it
  const rm = await ops.store?.rm({ key: "seen/hn" }, "r1");
  assert.ok(rm?.ok && rm.removed === 1 && rm.keys[0] === "seen/hn");
  const ops_ = w.journal.map((e) => e.payload as unknown as Record<string, unknown>).filter((p) => p.kind === "ext.pomtreed.state_op");
  assert.deepEqual(
    ops_.map((p) => p.op),
    ["put", "rm"],
  ); // the replayed put journals once (key dedupe)
  for (const p of ops_) assert.ok(!("value" in p) && p.by === "workflow" && p.workflow === Q && p.instance === "daily" && p.owner === "ext");
  assert.ok(!JSON.stringify(w.journal).includes('"ids"'));
});

test("ctx.workflow.store: undeclared is denied, a stale task is fenced, and a missing state store is 503", async () => {
  const fakes = createFakes({ host: "h" });
  const w = fakeWorld(2);
  w.svc.state = fakes.state;
  const undeclared = buildRunOps({ workflow: Q, caps: {}, ctx: ctxFor({ generation: 2 }), getServices: () => w.svc });
  await assert.rejects(undeclared.store?.get("a") ?? Promise.resolve(), /not declared: store/);
  const stale = buildRunOps({ workflow: Q, caps: { store: {} }, ctx: ctxFor({ generation: 1 }), getServices: () => w.svc });
  await assert.rejects(stale.store?.put({ key: "a", value: 1 }, "k") ?? Promise.resolve(), /no longer live/);
  const none = fakeWorld(1);
  const ops = buildRunOps({ workflow: Q, caps: { store: {} }, ctx: ctxFor(), getServices: () => none.svc });
  await assert.rejects(ops.store?.get("a") ?? Promise.resolve(), (e: unknown) => e instanceof LifecycleError && e.status === 503);
});

test("ctx.workflow.store: the scoped key must fit 128 characters; over the budget is a 400 naming the budget, not the scoped key", async () => {
  const { mk } = await sharedWorld();
  const ops = mk(Q, { store: {} });
  const budget = 128 - "digest/i/daily/".length;
  const fits = "a".repeat(budget);
  const over = "a".repeat(budget + 1);
  assert.ok((await ops.store?.put({ key: fits, value: 1 }, "p1"))?.ok);
  const tooLong = (e: unknown) =>
    e instanceof LifecycleError && e.status === 400 && e.message.includes(`budget of ${budget}`) && !e.message.includes("digest/i/daily");
  await assert.rejects(ops.store?.put({ key: over, value: 1 }, "p2") ?? Promise.resolve(), tooLong);
  await assert.rejects(ops.store?.get(over) ?? Promise.resolve(), tooLong);
  await assert.rejects(ops.store?.rm({ key: over }, "r1") ?? Promise.resolve(), tooLong);
  await assert.rejects(ops.store?.rm({ prefix: over }, "r2") ?? Promise.resolve(), tooLong);
  await assert.rejects(ops.store?.list({ prefix: over }) ?? Promise.resolve(), tooLong);
  await assert.rejects(ops.store?.list({ after: over }) ?? Promise.resolve(), tooLong);
  assert.equal((await ops.store?.get(fits))?.rev, 1);
});

// ---- ctx.workflow.shared: the extension-wide store ------------------------------------------------------------------------

async function sharedWorld() {
  const fakes = createFakes({ host: "h" });
  const rec = await fakes.registry.create({
    id: "task-1",
    parent: null,
    name: "t",
    task: "t",
    host: "h",
    budgetMicros: 1,
    idempotencyKey: "t1",
    spec: { image: "i", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "registry" } },
  });
  const w = fakeWorld(rec.generation);
  w.svc.state = fakes.state;
  const mk = (workflow: string, caps: Parameters<typeof buildRunOps>[0]["caps"], input: JsonValue = { instance: "daily" }) =>
    buildRunOps({ workflow, caps, ctx: ctxFor({ generation: rec.generation, input }), getServices: () => w.svc });
  return { fakes, rec, w, mk };
}
const RW = { sharedStore: { mode: "rw" } } as const;

test("normalizeCapabilities: sharedStore is exactly { mode: r | rw }", () => {
  assert.deepEqual(normalizeCapabilities("x/y", { sharedStore: { mode: "r" } }, CEILING), { sharedStore: { mode: "r" } });
  assert.deepEqual(normalizeCapabilities("x/y", { sharedStore: { mode: "rw" }, store: {} }, CEILING), { sharedStore: { mode: "rw" }, store: {} });
  for (const bad of [true, {}, { mode: "w" }, { mode: "RW" }, { mode: "rw", prefix: "x" }, { prefix: "x" }, []])
    assert.throws(() => normalizeCapabilities("x/y", { sharedStore: bad }, CEILING), /malformed capability sharedStore/, JSON.stringify(bad));
});

test("ctx.workflow.shared: every workflow and instance of the extension shares ext/s/, owner is the extension, CAS and journal like store", async () => {
  const { fakes, w, mk } = await sharedWorld();
  assert.equal(SHARED_SCOPE, "ext/s/");
  const a = mk("fin/board", RW);
  const b = mk("fin/scanner", RW, { instance: "other" });
  const reader = mk("fin/notes", { sharedStore: { mode: "r" } }, null);
  const put = await a.shared.put({ key: "thesis/acme", value: { text: "hi" }, expectRev: null }, "p1");
  assert.ok(put.ok && put.doc.key === "thesis/acme" && put.doc.rev === 1 && put.doc.owner === "fin");
  assert.deepEqual((await fakes.state.get("fin", "ext/s/thesis/acme"))?.value, { text: "hi" }); // owner = extension, extension-wide key
  assert.equal((await b.shared.get("thesis/acme"))?.rev, 1, "another workflow and instance read the same key");
  assert.equal((await reader.shared.get("thesis/acme"))?.key, "thesis/acme", "an instance-less r workflow reads it, prefix stripped");
  assert.deepEqual(
    (await b.shared.list({ prefix: "thesis/" })).map((m) => m.key),
    ["thesis/acme"],
  );
  // expectRev null = must not exist; a stale rev conflicts; the replayed put converges.
  assert.deepEqual(await b.shared.put({ key: "thesis/acme", value: 2, expectRev: null }, "p2"), { ok: false, reason: "conflict", currentRev: 1 });
  assert.deepEqual(await b.shared.put({ key: "thesis/acme", value: 2, expectRev: 9 }, "p3"), { ok: false, reason: "conflict", currentRev: 1 });
  const again = await a.shared.put({ key: "thesis/acme", value: { text: "hi" }, expectRev: null }, "p1");
  assert.ok(again.ok && again.doc.rev === 1);
  const upd = await b.shared.put({ key: "thesis/acme", value: 3, expectRev: 1 }, "p1"); // same caller key, other workflow: no collision
  assert.ok(upd.ok && upd.doc.rev === 2);
  // The writer is the writing workflow and instance (never the task), so a reader can attribute the author.
  assert.deepEqual((await a.shared.get("thesis/acme"))?.writer, { workflow: "fin/scanner", instance: "other" });
  const rm = await a.shared.rm({ key: "thesis/acme" }, "r1");
  assert.ok(rm.ok && rm.removed === 1 && rm.keys[0] === "thesis/acme");
  const opsJ = w.journal.map((e) => e.payload as unknown as Record<string, unknown>).filter((p) => p.kind === "ext.pomtreed.state_op");
  assert.deepEqual(
    opsJ.map((p) => [p.op, p.key]),
    [
      ["put", "ext/s/thesis/acme"],
      ["put", "ext/s/thesis/acme"],
      ["rm", "ext/s/thesis/acme"],
    ],
  ); // conflicts journal nothing; the replay journals once
  assert.deepEqual(
    opsJ.map((p) => [p.by, p.workflow, p.instance]),
    [
      ["workflow", "fin/board", "daily"],
      ["workflow", "fin/scanner", "other"],
      ["workflow", "fin/board", "daily"],
    ],
  );
  for (const p of opsJ) assert.ok(!("value" in p) && p.owner === "fin");
  assert.ok(!JSON.stringify(w.journal).includes('"text"'));
});

test("ctx.workflow.shared: a workflow named `ext` neither reaches nor collides with the shared scope", async () => {
  const { fakes, mk } = await sharedWorld();
  const both = { store: {}, sharedStore: { mode: "rw" } } as const;
  const extG = mk("fin/ext", both, null); // store scope ext/g/
  const extI = mk("fin/ext", both, { instance: "s" }); // store scope ext/i/s/
  assert.ok((await extG.store.put({ key: "k", value: "g" }, "a")).ok);
  assert.ok((await extI.store.put({ key: "k", value: "i" }, "a")).ok);
  assert.ok((await extG.shared.put({ key: "k", value: "s" }, "a")).ok);
  assert.deepEqual(
    (await fakes.state.list("fin")).map((m) => m.key),
    ["ext/g/k", "ext/i/s/k", "ext/s/k"],
  );
  assert.equal((await extG.store.get("k"))?.value, "g");
  assert.equal((await extI.store.get("k"))?.value, "i");
  assert.equal((await extG.shared.get("k"))?.value, "s");
  assert.deepEqual(
    (await extG.shared.list()).map((m) => m.key),
    ["k"],
    "shared lists only ext/s/",
  );
  assert.deepEqual(
    (await extG.store.list()).map((m) => m.key),
    ["k"],
    "store lists only its own scope",
  );
  // A store key cannot climb out of its scope into ext/s/: the scope is a literal prefix and dot segments are invalid keys.
  await assert.rejects(extG.store.get("../s/k"), /invalid-key/);
});

test("ctx.workflow.shared: mode r refuses writes (403 naming the capability) and writes nothing; undeclared, stale and no store are refused", async () => {
  const { fakes, w, rec, mk } = await sharedWorld();
  const r = mk("fin/board", { sharedStore: { mode: "r" } });
  const readOnly = (e: unknown) => e instanceof LifecycleError && e.status === 403 && /sharedStore is read-only/.test(e.message);
  await assert.rejects(r.shared.put({ key: "a", value: 1 }, "k"), readOnly);
  await assert.rejects(r.shared.rm({ key: "a" }, "k"), readOnly);
  assert.deepEqual(await fakes.state.list("fin"), []);
  assert.equal(w.journal.length, 0);
  assert.equal(await r.shared.get("a"), null);
  const storeOnly = mk("fin/board", { store: {} });
  await assert.rejects(storeOnly.shared.get("a"), /not declared: sharedStore/);
  await assert.rejects(storeOnly.shared.put({ key: "a", value: 1 }, "k"), /not declared: sharedStore/);
  const stale = buildRunOps({ workflow: "fin/board", caps: RW, ctx: ctxFor({ generation: rec.generation + 1 }), getServices: () => w.svc });
  await assert.rejects(stale.shared.put({ key: "a", value: 1 }, "k"), /no longer live/);
  const none = fakeWorld(1);
  const ops = buildRunOps({ workflow: "fin/board", caps: RW, ctx: ctxFor(), getServices: () => none.svc });
  await assert.rejects(ops.shared.get("a"), (e: unknown) => e instanceof LifecycleError && e.status === 503);
});

test("ctx.workflow.shared: host paths are refused, and the key budget is 128 minus the 6-character shared scope", async () => {
  const { mk } = await sharedWorld();
  const ops = mk("fin/board", RW);
  await assert.rejects(ops.shared.put({ key: "notes/home/op/secret/x", value: 1 }, "k"), /must not contain host paths/);
  const budget = 128 - "ext/s/".length;
  assert.ok((await ops.shared.put({ key: "a".repeat(budget), value: 1 }, "p1")).ok);
  const tooLong = (e: unknown) => e instanceof LifecycleError && e.status === 400 && e.message.includes(`budget of ${budget}`);
  await assert.rejects(ops.shared.put({ key: "a".repeat(budget + 1), value: 1 }, "p2"), tooLong);
  await assert.rejects(ops.shared.get("a".repeat(budget + 1)), tooLong);
  await assert.rejects(ops.shared.list({ prefix: "a".repeat(budget + 1) }), tooLong);
});

test("ctx.workflow.shared: a put wakes, delivers and launches nothing (data only)", async () => {
  const { fakes, w, mk } = await sharedWorld();
  const ops = mk("fin/board", RW);
  const before = fakes.calls.length;
  assert.ok((await ops.shared.put({ key: "thread/1/post/1", value: { body: "look at this" } }, "p1")).ok);
  assert.ok((await ops.shared.rm({ prefix: "thread/" }, "r1")).ok);
  const touched = new Set(fakes.calls.slice(before).map((c) => c.port));
  for (const port of touched) assert.ok(port === "StateStore" || port === "Registry", `unexpected port ${port}`);
  const registryCalls = fakes.calls.slice(before).filter((c) => c.port === "Registry");
  assert.ok(
    registryCalls.every((c) => c.method === "get"),
    "the registry is only read (writer fence)",
  );
  assert.deepEqual([w.sent.length, w.reports.length, w.asks.length], [0, 0, 0]);
  assert.deepEqual(
    w.journal.map((e) => (e.payload as unknown as { kind: string }).kind),
    ["ext.pomtreed.state_op", "ext.pomtreed.state_op"],
  );
});

test("operator write path: pomtree state put <ext> ext/s/<k> through /v1/state is read by ctx.workflow.shared with the operator as writer", async () => {
  const { fakes, w, mk } = await sharedWorld();
  const root = await fakes.registry.create({
    parent: null,
    name: "root",
    task: "t",
    host: "h",
    budgetMicros: 1,
    idempotencyKey: "root",
    spec: { image: "i", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "registry" } },
  });
  const recorded: { payload: unknown; key: string }[] = [];
  const deps = {
    store: fakes.state,
    policy: new StatePolicy(),
    get: (id: string) => fakes.registry.get(id),
    root: async () => root,
    record: async (_rec: AgentRecord, payload: unknown, key: string) => void recorded.push({ payload, key }),
    redactText: (t: string) => t,
  };
  const res = await handleState(deps as never, {
    principal: { scope: "operator" },
    method: "PUT",
    sub: ["doc"],
    query: new URLSearchParams(),
    body: { owner: "fin", key: "ext/s/thread/1/post/op-1", value: { body: "operator note" }, expectRev: null, idempotencyKey: "op-1" },
    fence: async () => {},
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(recorded.length, 1);
  const op = recorded[0]?.payload as { op: string; by: string; owner: string; key: string };
  assert.deepEqual([op.op, op.by, op.owner, op.key], ["put", "operator", "fin", "ext/s/thread/1/post/op-1"]);
  const ops = mk("fin/board", { sharedStore: { mode: "r" } });
  const doc = await ops.shared.get("thread/1/post/op-1");
  assert.deepEqual(doc?.value, { body: "operator note" });
  assert.deepEqual(doc?.writer, { operator: true }, "the extension can stamp the author on read");
  assert.deepEqual(
    (await ops.shared.list({ prefix: "thread/1/" })).map((m) => [m.key, m.writer]),
    [["thread/1/post/op-1", { operator: true }]],
  );
  assert.equal(w.journal.length, 0, "the workflow read journals nothing");
});

test("repair: a replacement task replays shared/store put and rm against the real store, and a crash before the journal write is healed exactly once", async () => {
  // A real SQLite state store: its idempotency fingerprint is what a repaired task must match (the fake's is looser).
  const db = openStateStore(":memory:", { generationOf: () => 1 });
  try {
    const w = fakeWorld(1);
    w.svc.state = db.state;
    const record = w.svc.recordRoot;
    let crash = true;
    // The first task dies between the store write and its journal entry.
    w.svc.recordRoot = async (payload, key) => {
      if (crash) throw new Error("daemon crashed");
      return record(payload, key);
    };
    const task = (agent: string) =>
      buildRunOps({ workflow: "fin/board", caps: { store: {}, sharedStore: { mode: "rw" } }, ctx: ctxFor({ agent }), getServices: () => w.svc });
    const first = task("task-1");
    await assert.rejects(first.shared.put({ key: "board/1", value: { post: 1 }, expectRev: null }, "p1"), /daemon crashed/);
    await assert.rejects(first.store.put({ key: "seen", value: [1] }, "s1"), /daemon crashed/);
    assert.equal(w.journal.length, 0);
    crash = false;
    const second = task("task-2");
    const put = await second.shared.put({ key: "board/1", value: { post: 1 }, expectRev: null }, "p1");
    assert.ok(put.ok && put.doc.rev === 1 && put.doc.key === "board/1", JSON.stringify(put));
    assert.deepEqual(put.doc.writer, { workflow: "fin/board", instance: "daily" });
    const seen = await second.store.put({ key: "seen", value: [1] }, "s1");
    assert.ok(seen.ok && seen.doc.rev === 1);
    // A third replay (another repair) converges on the same results and journals nothing new.
    assert.deepEqual(await task("task-3").shared.put({ key: "board/1", value: { post: 1 }, expectRev: null }, "p1"), put);
    // rm: crash after the store removal, replay from a new task.
    crash = true;
    await assert.rejects(second.shared.rm({ key: "board/1" }, "r1"), /daemon crashed/);
    crash = false;
    const rm = await task("task-3").shared.rm({ key: "board/1" }, "r1");
    assert.deepEqual(rm, { ok: true, removed: 1, keys: ["board/1"] });
    assert.deepEqual(await task("task-4").shared.rm({ key: "board/1" }, "r1"), rm);
    const ops = w.journal.map((e) => e.payload as unknown as Record<string, unknown>).filter((p) => p.kind === "ext.pomtreed.state_op");
    assert.deepEqual(
      ops.map((p) => [p.op, p.key, p.by, p.workflow, p.instance]),
      [
        ["put", "ext/s/board/1", "workflow", "fin/board", "daily"],
        ["put", "board/i/daily/seen", "workflow", "fin/board", "daily"],
        ["rm", "ext/s/board/1", "workflow", "fin/board", "daily"],
      ],
      "each state_op exists exactly once after crash-then-replay",
    );
    // Another workflow reusing the caller key is its own request, not a replay.
    const other = buildRunOps({ workflow: "fin/scan", caps: { sharedStore: { mode: "rw" } }, ctx: ctxFor({ agent: "task-5" }), getServices: () => w.svc });
    const o = await other.shared.put({ key: "board/2", value: 1 }, "p1");
    assert.ok(o.ok && o.doc.rev === 1);
  } finally {
    db.close();
  }
});

test("a stale-generation workflow task's write is refused by the store's own fence (past assertLive); its replacement's replay succeeds", async () => {
  const gens = new Map([["task-1", 2]]); // the registry already moved task-1 to generation 2
  const db = openStateStore(":memory:", { generationOf: (a) => gens.get(a) ?? 1 });
  try {
    const w = fakeWorld(1); // the facade's liveness view still says generation 1: only the store can catch it
    w.svc.state = db.state;
    const task = (agent: string) =>
      buildRunOps({ workflow: "fin/board", caps: { sharedStore: { mode: "rw" } }, ctx: ctxFor({ agent }), getServices: () => w.svc });
    await assert.rejects(task("task-1").shared.put({ key: "board/1", value: 1 }, "p1"), (e: unknown) => (e as Error).name === "StaleGenerationError");
    await assert.rejects(task("task-1").shared.rm({ prefix: "board/" }, "r1"), (e: unknown) => (e as Error).name === "StaleGenerationError");
    assert.deepEqual(await db.state.list("fin"), [], "nothing written");
    assert.equal(w.journal.length, 0);
    const put = await task("task-2").shared.put({ key: "board/1", value: 1 }, "p1");
    assert.ok(put.ok && put.doc.rev === 1);
    assert.deepEqual(put.doc.writer, { workflow: "fin/board", instance: "daily" }, "the fence is not stored");
  } finally {
    db.close();
  }
});
