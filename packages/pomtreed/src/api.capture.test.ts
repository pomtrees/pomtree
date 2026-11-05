// The /v1/capture routes end to end through handle() over the daemon with fakes and a real broker (test-capture.ts), its origin a
// FakeOrigin behind testFetchSeam: no network. Route shapes are core's wire types (CaptureRequestBody, CaptureResponse,
// CaptureShowResponse, CaptureListResponse), which `pomtree capture request|wait|show|ls` reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaptureListResponse, CaptureResponse, CaptureShowResponse } from "@pomtree/core";
import { FakeOrigin } from "@pomtree/testing";
import { handle } from "./api.ts";
import { issueToken } from "./auth.ts";
import { testBroker } from "./test-capture.ts";
import { testFetchSeam } from "./test-fetch.ts";
import { SECRET, setup } from "./test-setup.ts";

const idle = async () => {};

async function world(t: { after(fn: () => Promise<void>): void }, o: { waitBound?: number } = {}) {
  const origin = await FakeOrigin.start();
  t.after(() => origin.close());
  origin.route("docs.example.org", "/a", { status: 200, headers: { "content-type": "text/html" }, body: "<p>a</p>" });
  origin.route("docs.example.org", "/slow", { status: 200, headers: { "content-type": "text/html" }, body: "late", delayMs: 1500 });
  const seam = testFetchSeam(origin.hostsMap("docs.example.org"));
  let s!: ReturnType<typeof setup>;
  const tb = testBroker({
    ...seam,
    generationOf: async (agent) => (await s.fakes.registry.get(agent))?.generation ?? null,
    scopeFor: async (who) => ({ allows: (u) => who.kind === "operator" || u.hostname === "docs.example.org" }),
  });
  t.after(() => tb.broker.close());
  s = setup(idle, { capture: tb.broker, ...(o.waitBound !== undefined && { captureWaitMs: o.waitBound }) });
  return { s, tb, origin };
}

const post = (s: ReturnType<typeof setup>, url: string, key: string, query = "", token?: string) =>
  token === undefined
    ? s.operator("POST", `/v1/capture${query}`, { request: { url, purpose: "test" }, idempotencyKey: key })
    : handle(s.daemon, { method: "POST", url: `/v1/capture${query}`, body: { request: { url, purpose: "test" }, idempotencyKey: key }, token });

test("POST /v1/capture answers a CaptureResponse; show, ls and jobs read it back", async (t) => {
  const { s, origin } = await world(t);
  const r = await post(s, "https://docs.example.org/a", "k1");
  assert.equal(r.status, 200);
  const out = r.body as CaptureResponse;
  assert.equal(out.outcome.state, "ok", JSON.stringify(out));
  assert.equal(out.message, null);
  if (out.outcome.state !== "ok") return;
  const id = out.outcome.capture.id;
  const shown = await s.operator("GET", `/v1/capture/${id}`);
  assert.equal(shown.status, 200);
  assert.equal((shown.body as CaptureShowResponse).capture.id, id);
  const listed = await s.operator("GET", "/v1/capture?limit=1");
  assert.deepEqual(
    (listed.body as CaptureListResponse).captures.map((c) => c.id),
    [id],
  );
  // The same key converges (no new origin request); a second key is served from the shared cache.
  const before = origin.requestsFor("docs.example.org", "/a").length;
  assert.deepEqual(((await post(s, "https://docs.example.org/a", "k1")).body as CaptureResponse).outcome.state, "ok");
  const cached = (await post(s, "https://docs.example.org/a", "k2")).body as CaptureResponse;
  assert.equal(cached.outcome.state === "ok" && cached.outcome.servedFrom, "cache");
  assert.equal(origin.requestsFor("docs.example.org", "/a").length, before);
  // Unknown ids are 404s.
  assert.equal((await s.operator("GET", "/v1/capture/cap-nope")).status, 404);
  assert.equal((await s.operator("GET", "/v1/capture/jobs/cj-nope")).status, 404);
});

test("?waitMs= is clamped to capture.waitMs on POST and jobs; a malformed value is a 400 naming the bound", async (t) => {
  const { s } = await world(t, { waitBound: 50 });
  const started = Date.now();
  const r = (await post(s, "https://docs.example.org/slow", "k1", "?waitMs=100000")).body as CaptureResponse;
  assert.ok(Date.now() - started < 1000, "the wait was clamped to 50 ms, not 100 s");
  assert.equal(r.outcome.state, "pending");
  if (r.outcome.state !== "pending") return;
  assert.equal(r.message, `capture ${r.outcome.job} is still running; retry with the same key or wait on the job`);
  const waited = await s.operator("GET", `/v1/capture/jobs/${r.outcome.job}?waitMs=100000`);
  assert.equal(waited.status, 200);
  const bad = await post(s, "https://docs.example.org/slow", "k2", "?waitMs=soon");
  assert.equal(bad.status, 400);
  assert.match((bad.body as { error: string }).error, /waitMs must be a non-negative integer of milliseconds \(at most capture\.waitMs, 50\)/);
  // The job settles in the background and a later wait reads the ok outcome.
  await new Promise((res) => setTimeout(res, 1700));
  const later = (await s.operator("GET", `/v1/capture/jobs/${r.outcome.job}?waitMs=0`)).body as CaptureResponse;
  assert.equal(later.outcome.state, "ok");
});

test("POST /v1/capture refuses a malformed body (400), host and ext credentials (403); without a broker it is a 503", async (t) => {
  const { s } = await world(t);
  assert.equal((await s.operator("POST", "/v1/capture", { request: { url: "https://docs.example.org/a" }, idempotencyKey: "k" })).status, 400);
  const keyless = await s.operator("POST", "/v1/capture", { request: { url: "https://docs.example.org/a", purpose: "p" }, idempotencyKey: undefined });
  assert.equal(keyless.status, 400);
  assert.match((keyless.body as { error: string }).error, /^idempotencyKey is required/);
  for (const token of [issueToken(SECRET, { scope: "host", channel: "c" }), issueToken(SECRET, { scope: "ext", name: "x" })])
    assert.equal((await post(s, "https://docs.example.org/a", "k", "", token)).status, 403);
  const bare = setup(idle);
  assert.equal((await bare.operator("POST", "/v1/capture", { request: { url: "https://x.example/", purpose: "p" }, idempotencyKey: "k" })).status, 503);
});

test("an agent captures with its own credential inside its scope; out of scope is egress_denied; a stale generation is a 409", async (t) => {
  const { s } = await world(t);
  const rec = await s.fakes.registry.create({
    spec: { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" } },
    id: "a1",
    parent: null,
    name: "a1",
    task: "t",
    host: "h1",
    budgetMicros: 1,
    idempotencyKey: "mk-a1",
  });
  const token = issueToken(SECRET, { scope: "agent", agent: "a1", generation: rec.generation, expiry: Date.now() + 60_000 });
  const ok = (await post(s, "https://docs.example.org/a", "k1", "", token)).body as CaptureResponse;
  assert.equal(ok.outcome.state, "ok", JSON.stringify(ok));
  const out = (await post(s, "https://www.example.com/", "k2", "", token)).body as CaptureResponse;
  assert.equal(out.outcome.state === "failed" && `${out.outcome.failure.class}/${out.outcome.failure.reason}`, "network/egress_denied");
  assert.equal(out.message, "capture of www.example.com/ failed: the egress policy blocks this host; choose another source");
  await s.fakes.registry.bumpGeneration("a1", "h1", "bump-1");
  assert.equal((await post(s, "https://docs.example.org/a", "k3", "", token)).status, 409);
});
