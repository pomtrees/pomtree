import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { captureJobIdOf } from "@pomtree/core";
import { createFakes, FakeQuotaCounters } from "./fakes.ts";
import { FakeCaptureIndex, FakeCaptureParser } from "./capture-fakes.ts";
import { FakeOrigin } from "./fake-origin.ts";
import { captureIndexContractBody, quotaCountersOpIdContractBody } from "./port-contracts.ts";

const enc = (s: string) => new TextEncoder().encode(s);

test("FakeCaptureParser: answers with core's pure functions and records every call", async () => {
  const p = new FakeCaptureParser();
  const doc = "User-agent: Claude-User\nDisallow: /private\n\nUser-agent: ClaudeBot\nDisallow: /\n";
  assert.deepEqual(await p.robots({ body: enc(doc), tokens: ["pomtree", "Claude-User"], path: "/private/x" }), {
    verdict: "disallow",
    rule: "Disallow: /private",
  });
  assert.deepEqual(await p.robots({ body: enc(doc), tokens: ["pomtree", "Claude-User"], path: "/public" }), { verdict: "allow", rule: null });
  const snap = JSON.stringify({
    archived_snapshots: {
      closest: { status: "200", available: true, url: "http://web.archive.org/web/20240102030405/https://e.com/", timestamp: "20240102030405" },
    },
  });
  assert.deepEqual(await p.waybackAvailability({ body: enc(snap) }), {
    url: "https://e.com/",
    timestamp: "20240102030405",
    archivedAt: Date.UTC(2024, 0, 2, 3, 4, 5),
  });
  assert.equal(await p.waybackAvailability({ body: enc("{}") }), null);
  assert.deepEqual(
    p.calls.map((c) => c.method),
    ["robots", "robots", "waybackAvailability", "waybackAvailability"],
  );
  assert.deepEqual(p.calls[0], { method: "robots", body: doc, tokens: ["pomtree", "Claude-User"], path: "/private/x" });
});

test("FakeCaptureParser: a scripted rejection rejects; a scripted hang stays pending until released", async () => {
  const p = new FakeCaptureParser();
  p.script = [{ reject: new Error("parser crashed") }, { hang: true }, null];
  await assert.rejects(() => p.robots({ body: enc(""), tokens: ["x"], path: "/" }), /parser crashed/);
  let settled = false;
  const hung = p.waybackAvailability({ body: enc("{}") }).finally(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false, "a hung call does not settle");
  assert.equal(await p.waybackAvailability({ body: enc("{}") }), null, "the next scripted entry answers normally");
  assert.equal(p.releaseHung(new Error("killed")), 1);
  await assert.rejects(hung, /killed/);
  assert.equal(p.releaseHung(), 0);
});

test("createFakes wires the capture fakes as call-logged ports", async () => {
  const f = createFakes();
  await f.captureParser.robots({ body: enc(""), tokens: ["x"], path: "/" });
  assert.equal(await f.captures.latest("k"), null);
  assert.deepEqual(
    f.calls.filter((c) => c.port === "CaptureParser" || c.port === "CaptureIndex").map((c) => `${c.port}.${c.method}`),
    ["CaptureParser.robots", "CaptureIndex.latest"],
  );
  f.hooks.raw.captures.errors = [new Error("index down")];
  await assert.rejects(() => f.captures.pauseDomain("e.com", 1, "k"), /index down/);
});

// Negative variants: a stub that mirrors a bug must fail the contract, or the contract proves nothing.
test("the CaptureIndex contract rejects broken adapters", async () => {
  class ShortensPause extends FakeCaptureIndex {
    override async pauseDomain(domain: string, until: number): Promise<void> {
      this.pauses.set(domain, until);
    }
  }
  class LastSettleWins extends FakeCaptureIndex {
    override async settle(...a: Parameters<FakeCaptureIndex["settle"]>) {
      const j = this.jobs.get(a[0]);
      if (j) j.state = "open";
      return super.settle(a[0], a[1], `${a[2]}:${Math.random()}`);
    }
  }
  class NeverJoins extends FakeCaptureIndex {
    override async begin(...a: Parameters<FakeCaptureIndex["begin"]>) {
      for (const j of this.jobs.values()) j.state = "settled";
      return super.begin(...a);
    }
  }
  class NoConflict extends FakeCaptureIndex {
    override async begin(n: Parameters<FakeCaptureIndex["begin"]>[0], key: string) {
      return super.begin(n, `${key}:${JSON.stringify(n.request)}:${n.key}`);
    }
  }
  for (const Broken of [ShortensPause, LastSettleWins, NeverJoins, NoConflict])
    await assert.rejects(() => captureIndexContractBody({ captures: new Broken() }), Broken.name);
  await captureIndexContractBody({ captures: new FakeCaptureIndex() });
});

test("FakeCaptureIndex.open lists jobs oldest first, breaking createdAt ties by id, whatever the creation or id order", async () => {
  const at = { early: 1_000, tie: 2_000, late: 3_000 };
  // Keys are searched so the ids oppose the expected order: the early job's id sorts last, the late job's first, and the
  // tie pair's earlier-inserted job has the larger id. Sorting by id alone, by insertion order or by the wrong tie-break all differ.
  const keyFor = (n: number) => `key-${n}`;
  const idOf = (n: number, t: number) => captureJobIdOf(keyFor(n), t);
  const pick = (ok: (n: number) => boolean) => {
    for (let n = 0; n < 10_000; n++) if (ok(n)) return n;
    throw new Error("no key found; widen the search in the test");
  };
  const tieA = pick((n) => idOf(n, at.tie) > idOf(n + 1, at.tie));
  const tieB = tieA + 1;
  const late = pick((n) => n !== tieA && n !== tieB && idOf(n, at.late) < idOf(tieB, at.tie));
  const early = pick((n) => n !== late && n !== tieA && n !== tieB && idOf(n, at.early) > idOf(tieA, at.tie));
  const lateId = idOf(late, at.late);
  assert.ok(
    lateId < idOf(tieB, at.tie) && idOf(tieB, at.tie) < idOf(tieA, at.tie) && idOf(tieA, at.tie) < idOf(early, at.early),
    "fixture ids oppose time order",
  );

  const idx = new FakeCaptureIndex();
  const job = (n: number, createdAt: number) => ({
    key: keyFor(n),
    request: { url: "https://www.example.com/a", render: "static" as const, purpose: "test" },
    acquirer: "web" as const,
    render: "static" as const,
    requester: "ag-1",
    generation: 1,
    host: "host-1",
    createdAt,
  });
  // Insertion order: late, tie (larger id), tie (smaller id), early.
  await idx.begin(job(late, at.late), "b-late");
  await idx.begin(job(tieA, at.tie), "b-tie-a");
  await idx.begin(job(tieB, at.tie), "b-tie-b");
  await idx.begin(job(early, at.early), "b-early");
  const listed = (await idx.open()).map((j) => j.id);
  assert.deepEqual(listed, [idOf(early, at.early), idOf(tieB, at.tie), idOf(tieA, at.tie), lateId]);
});

test("the QuotaCounters opId contract rejects an adapter that ignores opId", async () => {
  class IgnoresOpId extends FakeQuotaCounters {
    override take(scope: string, key: string, w: number, amount: number, limit: number) {
      return super.take(scope, key, w, amount, limit);
    }
  }
  class RecordsRefusals extends FakeQuotaCounters {
    override take(scope: string, key: string, w: number, amount: number, limit: number, opId?: string) {
      const r = super.take(scope, key, w, amount, limit, opId);
      if (!r.ok && opId !== undefined) this.ops.set(JSON.stringify([scope, key, w, opId]), r.used);
      return r;
    }
  }
  await assert.rejects(() => quotaCountersOpIdContractBody({ quota: new IgnoresOpId() }));
  await assert.rejects(() => quotaCountersOpIdContractBody({ quota: new RecordsRefusals() }));
  await quotaCountersOpIdContractBody({ quota: new FakeQuotaCounters() });
});

// A raw client, so the test sets the Host header itself (as pomtreed's testFetchSeam does).
function get(port: number, host: string, path: string, timeoutMs = 2000): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { host, "user-agent": "pomtree-test ops@example.org" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("client timeout")));
    req.on("error", reject);
    req.end();
  });
}

test("FakeOrigin: routes by Host header and path, records every request, scripts sequences and 404s the rest", async () => {
  const o = await FakeOrigin.start();
  try {
    assert.ok(o.port > 0);
    assert.deepEqual(
      [...o.hostsMap("Data.SEC.gov", "www.sec.gov")],
      [
        ["data.sec.gov", o.port],
        ["www.sec.gov", o.port],
      ],
    );
    o.route("data.sec.gov", "/a", { status: 200, headers: { "content-type": "application/json", "set-cookie": "x=1" }, body: "{}" });
    o.route("www.sec.gov", "/a", [
      { status: 503, headers: { "retry-after": "5" } },
      { status: 200, body: "second" },
    ]);
    o.route("www.sec.gov", "/q?x=1", { status: 201, body: "exact" });
    o.route("www.sec.gov", "/fn", (r) => ({ status: 200, body: r.headers["user-agent"] ?? "" }));
    const a = await get(o.port, "data.sec.gov", "/a");
    assert.equal(a.status, 200);
    assert.equal(a.body, "{}");
    assert.equal(a.headers["content-type"], "application/json");
    assert.equal((await get(o.port, "www.sec.gov:443", "/a")).status, 503, "the Host port is ignored");
    assert.equal((await get(o.port, "www.sec.gov", "/a")).body, "second");
    assert.equal((await get(o.port, "www.sec.gov", "/a")).body, "second", "the last response repeats");
    assert.equal((await get(o.port, "www.sec.gov", "/q?x=1")).body, "exact");
    assert.equal((await get(o.port, "www.sec.gov", "/q?x=2")).status, 404, "an exact path+query route does not match another query");
    assert.equal((await get(o.port, "www.sec.gov", "/fn")).body, "pomtree-test ops@example.org");
    const miss = await get(o.port, "other.example", "/a");
    assert.equal(miss.status, 404);
    assert.equal(miss.body, "no route");
    assert.equal(o.requestsFor("www.sec.gov", "/a").length, 3);
    assert.equal(o.requestsFor("www.sec.gov", "/q").length, 2, "a bare path matches requests with any query");
    assert.deepEqual(
      { host: o.requests[0]?.host, path: o.requests[0]?.path, method: o.requests[0]?.method, ua: o.requests[0]?.headers["user-agent"] },
      { host: "data.sec.gov", path: "/a", method: "GET", ua: "pomtree-test ops@example.org" },
    );
  } finally {
    await o.close();
  }
});

test("FakeOrigin: delay, hang and connection reset; close() ends hung sockets", async () => {
  const o = await FakeOrigin.start();
  o.route("slow.example", "/", { delayMs: 50, body: "late" });
  o.route("hang.example", "/", { hang: true });
  o.route("reset.example", "/", { reset: true });
  const t0 = Date.now();
  assert.equal((await get(o.port, "slow.example", "/")).body, "late");
  assert.ok(Date.now() - t0 >= 45);
  await assert.rejects(() => get(o.port, "hang.example", "/", 200), /client timeout/);
  await assert.rejects(() => get(o.port, "reset.example", "/"), /ECONNRESET|socket hang up/);
  assert.equal(o.requestsFor("hang.example").length, 1, "a hung request is recorded");
  assert.equal(o.requestsFor("reset.example").length, 1, "a reset request is recorded");
  const pending = get(o.port, "hang.example", "/", 10_000);
  await new Promise((r) => setTimeout(r, 30));
  await o.close();
  await assert.rejects(pending, "close() destroys the hung socket instead of waiting");
});

test("FakeOrigin: robots.txt, Wayback availability and raw snapshot helpers", async () => {
  const o = await FakeOrigin.start();
  try {
    o.robots("www.example.com", "User-agent: *\nDisallow: /private\n");
    o.robots("dead.example", { status: 503 });
    o.waybackAvailability({ url: "https://dead.example/a", timestamp: "20240102030405" });
    o.waybackSnapshot("20240102030405", "https://dead.example/a", "<p>archived</p>");
    const r = await get(o.port, "www.example.com", "/robots.txt");
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "text/plain");
    assert.match(r.body, /Disallow: \/private/);
    assert.equal((await get(o.port, "dead.example", "/robots.txt")).status, 503);
    assert.equal((await get(o.port, "web.archive.org", "/robots.txt")).status, 200, "the archive's own robots.txt is routed");
    const avail = await get(o.port, "archive.org", "/wayback/available?url=https%3A%2F%2Fdead.example%2Fa&timestamp=20261024000000");
    const doc = JSON.parse(avail.body);
    assert.equal(doc.archived_snapshots.closest.timestamp, "20240102030405");
    assert.equal(doc.archived_snapshots.closest.url, "http://web.archive.org/web/20240102030405/https://dead.example/a");
    const snap = await get(o.port, "web.archive.org", "/web/20240102030405id_/https://dead.example/a");
    assert.equal(snap.body, "<p>archived</p>");
    o.waybackAvailability(null);
    assert.deepEqual(JSON.parse((await get(o.port, "archive.org", "/wayback/available?url=x")).body).archived_snapshots, {});
  } finally {
    await o.close();
  }
});
