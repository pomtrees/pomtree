import assert from "node:assert/strict";
import { test } from "node:test";
import { openStore } from "@pomtree/store-sqlite";
import { createExtGateway, isBlockedAddress, urlPolicy, WEB_FETCH_UNWIRED } from "./ext-gateway.ts";
import { memoryQuotaCounters, QUOTA_SCOPES } from "./quota.ts";
import type { FetchFn } from "./ext-gateway.ts";
import { brokeredGateway } from "./test-capture.ts";

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];
const brokered = brokeredGateway; // web_fetch is a capture broker client: a real broker over fakes (test-capture.ts)
const EGRESS = /egress policy blocks this host; choose another source/;

test("urlPolicy allows http/https and a public host", () => {
  for (const u of ["https://example.com/x", "http://example.com"]) {
    const r = urlPolicy(u);
    assert.ok(r.ok, u);
    assert.equal((r as { url: URL }).url.hostname, "example.com");
  }
  const r = urlPolicy("ftp://example.com/x");
  assert.equal(r.ok, false);
});

// SSRF safety: every literal in every named group must be refused by urlPolicy.
const BLOCKED_LITERALS: { title: string; urls: string[] }[] = [
  {
    title: "urlPolicy rejects loopback hosts and literals",
    urls: ["http://127.0.0.1/", "http://127.1.2.3/", "http://localhost/", "http://sub.localhost/", "http://[::1]/"],
  },
  { title: "urlPolicy rejects RFC1918 private ranges", urls: ["http://10.0.0.1/", "http://172.16.0.1/", "http://172.31.255.255/", "http://192.168.1.1/"] },
  {
    title: "urlPolicy rejects link-local and metadata addresses",
    urls: ["http://169.254.169.254/latest/meta-data/", "http://169.254.0.1/", "http://[fe80::1]/", "http://[fc00::1]/"],
  },
  {
    title: "urlPolicy rejects the newly-blocked literal ranges",
    urls: [
      "http://0.0.0.0/",
      "http://100.64.0.1/",
      "http://198.18.0.1/",
      "http://224.0.0.1/",
      "http://[64:ff9b::7f00:1]/",
      "http://[2002:7f00:1::]/",
      "http://[::7f00:1]/",
    ],
  },
  {
    title: "urlPolicy rejects reserved documentation/protocol ranges and Teredo",
    urls: ["http://192.0.0.1/", "http://192.0.2.5/", "http://198.51.100.7/", "http://203.0.113.9/", "http://[2001::1]/"],
  },
];
for (const g of BLOCKED_LITERALS) {
  test(g.title, () => {
    for (const u of g.urls) assert.equal(urlPolicy(u).ok, false, u);
  });
}

test("isBlockedAddress classifies IPv4-mapped loopback and public addresses", () => {
  assert.equal(isBlockedAddress("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedAddress("::ffff:10.0.0.1"), true);
  assert.equal(isBlockedAddress("8.8.8.8"), false);
  assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
});

test("web_fetch follows the injected fetch and returns the text body", async () => {
  let seenUrl = "";
  const fetch: FetchFn = async (url, init) => {
    seenUrl = url;
    assert.equal(init.redirect, "manual");
    return {
      status: 200,
      headers: { get: (n) => (n === "content-type" ? "text/html" : null) },
      body: (async function* () {
        yield Buffer.from("hello world");
      })(),
    };
  };
  const gw = brokered({ fetch, resolveDns: publicDns });
  const res = await gw.call("a", "web_fetch", { url: "https://example.com/page" }, "k");
  assert.equal(res.ok, true);
  assert.equal(seenUrl, "https://example.com/page");
  const body = (res.result as { body: string }).body;
  assert.match(
    body,
    /^<<untrusted-page nonce=[0-9a-f]{12} capture=cap-[0-9a-f]{64} url=example\.com\/page>>\nhello world\n<<end-untrusted-page nonce=[0-9a-f]{12}>>$/,
    "the body is spotlit",
  );
  assert.equal((res.summary as { sha256: string }).sha256.length, 64);
});

test("web_fetch enforces the size cap", async () => {
  const fetch: FetchFn = async () => ({
    status: 200,
    headers: { get: () => "text/plain" },
    body: (async function* () {
      yield Buffer.from("x".repeat(100));
    })(),
  });
  const gw = brokered({ fetch, resolveDns: publicDns, maxBodyBytes: 10 });
  const res = await gw.call("a", "web_fetch", { url: "https://example.com/x" }, "k");
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /exceeds 10 bytes/);
});

test("web_fetch rejects a hostname that resolves to a blocked address", async () => {
  const gw = brokered({
    fetch: async () => {
      throw new Error("fetch must not run");
    },
    resolveDns: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  const res = await gw.call("a", "web_fetch", { url: "https://evil.example/" }, "k");
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", EGRESS);
});

test("web_fetch rejects non-text media types", async () => {
  const fetch: FetchFn = async () => ({
    status: 200,
    headers: { get: () => "application/octet-stream" },
    body: (async function* () {
      yield Buffer.from("binary");
    })(),
  });
  const gw = brokered({ fetch, resolveDns: publicDns });
  const res = await gw.call("a", "web_fetch", { url: "https://example.com/x" }, "k");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "capture of example.com/x returned application/octet-stream, which is not supported; choose another source");
});

test("web_search is an offline deny when no provider is configured", async () => {
  const res = await brokered().call("a", "web_search", { query: "x" }, "k");
  assert.deepEqual(res, { ok: false, denied: true, reason: "search provider not configured" });
});

test("web_search calls the configured provider with a bearer key and returns items", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> | undefined;
  const fetch: FetchFn = async (url, init) => {
    seenUrl = url;
    seenHeaders = init.headers;
    assert.equal(init.redirect, "manual");
    return {
      status: 200,
      headers: { get: (n) => (n === "content-type" ? "application/json" : null) },
      body: (async function* () {
        yield Buffer.from(JSON.stringify({ items: [{ title: "t", url: "https://x", snippet: "s" }] }));
      })(),
    };
  };
  const gw = brokered({ fetch, resolveDns: publicDns, searchProvider: "https://search.example/q?q={q}", searchKey: "sekret" });
  const res = await gw.call("a", "web_search", { query: "hello world" }, "k");
  assert.equal(res.ok, true);
  assert.equal(seenUrl, "https://search.example/q?q=hello%20world");
  assert.deepEqual(seenHeaders, { authorization: "Bearer sekret" });
  assert.deepEqual((res.result as { items: unknown }).items, [{ title: "t", url: "https://x", snippet: "s" }]);
});

test("web_search normalizes a results array and omits auth when no key is set", async () => {
  const fetch: FetchFn = async (_url, init) => {
    assert.equal(init.headers, undefined);
    return {
      status: 200,
      headers: { get: () => "application/json" },
      body: (async function* () {
        yield Buffer.from(
          JSON.stringify({
            results: [
              { title: "a", link: "https://a", description: "d" },
              { name: "b", url: "https://b" },
            ],
          }),
        );
      })(),
    };
  };
  const gw = brokered({ fetch, resolveDns: publicDns, searchProvider: "https://s.example/?q={q}" });
  const res = await gw.call("a", "web_search", "cats", "k");
  assert.equal(res.ok, true);
  assert.deepEqual((res.result as { items: unknown }).items, [
    { title: "a", url: "https://a", snippet: "d" },
    { title: "b", url: "https://b", snippet: "" },
  ]);
});

test("web_search rejects a blocked provider URL and a non-JSON body", async () => {
  const blocked = brokered({
    fetch: async () => {
      throw new Error("must not run");
    },
    resolveDns: publicDns,
    searchProvider: "http://127.0.0.1/?q={q}",
  });
  assert.equal((await blocked.call("a", "web_search", { query: "x" }, "k")).ok, false);
  const nonJson = brokered({
    fetch: async () => ({
      status: 200,
      headers: { get: () => "application/json" },
      body: (async function* () {
        yield Buffer.from("not json");
      })(),
    }),
    resolveDns: publicDns,
    searchProvider: "https://s.example/?q={q}",
  });
  const res = await nonJson.call("a", "web_search", { query: "x" }, "k");
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /no results/);
});

test("list returns the two specs and rejects an unknown extension", async () => {
  const gw = brokered();
  assert.deepEqual((await gw.list()).map((s) => s.name).sort(), ["web_fetch", "web_search"]);
  const res = await gw.call("a", "nope", {}, "k");
  assert.deepEqual(res, { ok: false, reason: "unknown extension nope" });
});

test("isBlockedAddress covers 0.0.0.0/8, CGNAT, benchmarking, multicast, and IPv6-embedded forms", () => {
  for (const ip of [
    "0.0.0.0",
    "0.255.255.255",
    "100.64.0.1",
    "100.127.255.255",
    "198.18.0.0",
    "198.19.255.255",
    "224.0.0.1",
    "239.255.255.255",
    "255.255.255.255",
  ]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ["64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::", "2002:0a00:1::", "::7f00:1", "::ffff:7f00:1"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test("web_fetch pins the connect-time address it resolved (DNS rebinding)", async () => {
  let seenUrl = "";
  let seenInit: { pin?: unknown } | undefined;
  const fetch: FetchFn = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return {
      status: 200,
      headers: { get: () => "text/plain" },
      body: (async function* () {
        yield Buffer.from("ok");
      })(),
    };
  };
  const gw = brokered({ fetch, resolveDns: async () => [{ address: "93.184.216.34", family: 4 }] });
  const res = await gw.call("a", "web_fetch", { url: "https://example.com/x" }, "k");
  assert.equal(res.ok, true);
  assert.equal(seenUrl, "https://example.com/x"); // the URL is unchanged; the pin rides alongside it
  assert.deepEqual(seenInit!.pin, { hostname: "example.com", address: "93.184.216.34", family: 4 });
});

const okFetch: FetchFn = async () => ({
  status: 200,
  headers: { get: () => "text/plain" },
  body: (async function* () {
    yield Buffer.from("0123456789");
  })(),
});
const callFetch = (gw: ReturnType<typeof createExtGateway>, a = "a") => gw.call(a, "web_fetch", { url: "https://example.com/" }, "k");

test("web_fetch global and per-agent opt-out deny with a reason", async () => {
  const off = brokered({ fetch: okFetch, resolveDns: publicDns, webFetchEnabled: false });
  const r = await callFetch(off);
  assert.deepEqual([r.ok, (r as { denied?: boolean }).denied], [false, true]);
  const per = brokered({ fetch: okFetch, resolveDns: publicDns, webFetchAllowed: (a) => a === "yes" });
  assert.equal((await callFetch(per, "yes")).ok, true);
  assert.match(String(((await callFetch(per, "no")) as { reason: string }).reason), EGRESS);
});

test("web_fetch awaits an async per-agent predicate before allowing", async () => {
  let fetchRan = false;
  const fetch: FetchFn = async () => {
    fetchRan = true;
    return {
      status: 200,
      headers: { get: () => "text/plain" },
      body: (async function* () {
        yield Buffer.from("ok");
      })(),
    };
  };
  let sawAgent = "";
  const gw = brokered({
    fetch,
    resolveDns: publicDns,
    webFetchAllowed: async (a) => {
      await new Promise((r) => setTimeout(r, 0)); // async lookup; must be awaited before the fetch
      sawAgent = a;
      return true;
    },
  });
  const res = await callFetch(gw);
  assert.equal(res.ok, true);
  assert.equal(sawAgent, "a");
  assert.equal(fetchRan, true);
});

test("web_fetch async predicate false denies with the journal-safe shape", async () => {
  let fetchRan = false;
  const gw = brokered({
    fetch: async () => {
      fetchRan = true;
      throw new Error("must not run");
    },
    resolveDns: publicDns,
    webFetchAllowed: async () => false,
  });
  const r = await callFetch(gw);
  assert.deepEqual(r, { ok: false, denied: true, reason: "capture of example.com/ failed: the egress policy blocks this host; choose another source" });
  assert.equal(fetchRan, false);
});

test("web_fetch predicate rejection fails closed and never fetches", async () => {
  let fetchRan = false;
  const gw = brokered({
    fetch: async () => {
      fetchRan = true;
      throw new Error("must not run");
    },
    resolveDns: publicDns,
    webFetchAllowed: async () => {
      throw new Error("template lookup failed");
    },
  });
  const r = (await callFetch(gw)) as { ok: boolean; denied?: boolean; reason: string };
  assert.equal(r.ok, false);
  assert.equal(r.denied, true);
  assert.match(r.reason, EGRESS);
  assert.equal(fetchRan, false);
});

test("web_fetch rate cap is per agent and resets with the next fixed window", async () => {
  let t = 0;
  const gw = brokered({ fetch: okFetch, resolveDns: publicDns, maxCallsPerWindow: 2, rateWindowMs: 1000, now: () => t });
  assert.equal((await callFetch(gw)).ok, true);
  assert.equal((await callFetch(gw)).ok, true);
  const r = (await callFetch(gw)) as { ok: boolean; denied?: boolean; reason: string };
  assert.equal(r.ok, false);
  assert.equal(r.denied, true);
  assert.match(r.reason, /rate limit/);
  assert.equal((await callFetch(gw, "other")).ok, true);
  t = 1001;
  assert.equal((await callFetch(gw)).ok, true);
});

test("web_fetch total-byte cap denies once exhausted", async () => {
  const gw = brokered({ fetch: okFetch, resolveDns: publicDns, maxTotalBytes: 15 });
  assert.equal((await callFetch(gw)).ok, true);
  assert.equal((await callFetch(gw)).ok, true); // 20 >= 15 after this
  const r = (await callFetch(gw)) as { denied?: boolean; reason: string };
  assert.equal(r.denied, true);
  assert.match(r.reason, /byte quota/);
});

test("byte quota: concurrent calls cannot overshoot and over-cap responses are charged", async () => {
  const big: FetchFn = (async () => new Response("x".repeat(100), { status: 200, headers: { "content-type": "text/plain" } })) as unknown as FetchFn;
  const gw = brokered({ fetch: big, resolveDns: publicDns, maxBodyBytes: 10, maxTotalBytes: 25, maxCallsPerWindow: 100 });
  const rs = await Promise.all([1, 2, 3, 4].map(() => gw.call("a", "web_fetch", { url: "https://example.com/" }, "k")));
  assert.equal(rs.filter((r) => !r.ok && (r as { denied?: boolean }).denied).length, 1); // 3 reservations of 10 fit before 25 is hit
  const next = await gw.call("a", "web_fetch", { url: "https://example.com/" }, "k");
  assert.equal(next.ok, false);
  assert.equal((next as { denied?: boolean }).denied, true); // over-cap responses were charged
});

test("isBlockedAddress fails closed on IPv6 text isIP accepts but the guard cannot parse (e.g. ::127.0.0.1)", () => {
  for (const ip of ["::127.0.0.1", "::10.0.0.1", "64:ff9b::8.8.8.8"]) assert.equal(isBlockedAddress(ip), true, ip);
  assert.equal(urlPolicy("http://[::127.0.0.1]/").ok, false);
  // Negative: canonical public IPv6 and IPv4-mapped public addresses still pass.
  assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
  assert.equal(isBlockedAddress("::ffff:8.8.8.8"), false);
});

const text200 = (body: string) => ({
  status: 200,
  headers: { get: (n: string) => (n === "content-type" ? "text/plain" : null) },
  body: (async function* () {
    yield Buffer.from(body);
  })(),
});

test("web_fetch waits webfetch.timeoutMs on a stalled capture and answers pending; the rung's own deadline aborts the transport", async () => {
  const signals: AbortSignal[] = [];
  const stallHeaders: FetchFn = (_url, init) => {
    signals.push(init.signal!);
    return new Promise(() => {}); // never answers
  };
  const g = brokered({ fetch: stallHeaders, resolveDns: publicDns, fetchTimeoutMs: 30, searchProvider: "https://search.example/?q={q}" }, 200);
  const r = (await g.call("a", "web_fetch", { url: "https://example.com/" }, "k")) as { ok: boolean; reason: string };
  assert.equal(r.ok, false);
  assert.match(r.reason, /^capture cj-[0-9a-f]{64} is still running; retry with the same key or wait on the job$/);
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(signals[0]?.aborted, true, "the capture rung's deadline aborted the transport");
  const s = (await g.call("a", "web_search", { query: "x" }, "k")) as { ok: boolean; reason: string };
  assert.match(s.reason, /^web_search timed out after 30ms/);
  // Negative: a prompt upstream is unaffected, and only the bytes delivered are charged.
  const quota = memoryQuotaCounters();
  const g3 = brokered({ fetch: async () => text200("ok"), resolveDns: publicDns, fetchTimeoutMs: 1000, quota });
  assert.equal((await g3.call("a", "web_fetch", { url: "https://example.com/" }, "k")).ok, true);
  assert.equal(quota.peek(QUOTA_SCOPES.webBytes, "a", 0), 2);
});

test("web_fetch without an allowlist follows a cross-host redirect that passes every check, recording each hop", async () => {
  const seen: string[] = [];
  const fetch: FetchFn = async (url) => {
    seen.push(url);
    if (url === "https://example.com/a") return { status: 301, headers: { get: (n) => (n === "location" ? "/b" : null) }, body: null };
    if (url === "https://example.com/b")
      return { status: 302, headers: { get: (n) => (n === "location" ? "https://other.example.net/c?t=1" : null) }, body: null };
    return text200("ok");
  };
  const g = brokered({ fetch, resolveDns: publicDns });
  const r = (await g.call("a", "web_fetch", { url: "https://example.com/a" }, "k")) as { ok: boolean; result: { url: string } };
  assert.equal(r.ok, true);
  assert.equal(r.result.url, "https://other.example.net/c?t=1");
  assert.deepEqual(seen, ["https://example.com/a", "https://example.com/b", "https://other.example.net/c?t=1"]);
  // Negative: under an allowlist the cross-host hop leaves the scope and is never requested.
  seen.length = 0;
  const scoped = brokered({ fetch, resolveDns: publicDns, webFetchAllowed: () => ({ hosts: ["example.com"] }) });
  const d = (await scoped.call("a", "web_fetch", { url: "https://example.com/a" }, "k")) as { ok: boolean; denied?: boolean; reason: string };
  assert.deepEqual([d.ok, d.denied], [false, true]);
  assert.match(d.reason, EGRESS);
  assert.deepEqual(seen, ["https://example.com/a", "https://example.com/b"]);
});

test("web_fetch without a capture broker refuses naming the missing wiring; there is no direct path", async () => {
  let ran = false;
  const g = createExtGateway({
    fetch: async () => {
      ran = true;
      throw new Error("must not run");
    },
  });
  const r = (await g.call("a", "web_fetch", { url: "https://example.com/" }, "k")) as { ok: boolean; reason: string };
  assert.equal(r.ok, false);
  assert.equal(r.reason, WEB_FETCH_UNWIRED);
  assert.equal(ran, false);
});

test("web_fetch quotas live in QuotaCounters: a restarted gateway over the same counters keeps the call and byte counts", async () => {
  const quota = openStore(":memory:").quotaCounters(); // the durable store, shared across the restart
  let t = 5_000;
  const opts = {
    fetch: (async () => text200("12345")) as FetchFn,
    resolveDns: publicDns,
    maxCallsPerWindow: 2,
    rateWindowMs: 1000,
    maxTotalBytes: 12,
    now: () => t,
    quota,
  };
  const before = brokered(opts);
  assert.equal((await before.call("a", "web_fetch", { url: "https://example.com/" }, "k")).ok, true);
  assert.equal((await before.call("a", "web_search", { query: "q" }, "k")).ok, false); // denied (no provider) but still a counted call
  const after = brokered(opts); // the restart
  const r = (await after.call("a", "web_fetch", { url: "https://example.com/" }, "k")) as { denied?: boolean; reason: string };
  assert.equal(r.denied, true);
  assert.match(r.reason, /rate limit exceeded \(2 calls per 1000ms\)/);
  assert.equal(quota.peek(QUOTA_SCOPES.webCalls, "a", 5_000), 2);
  t = 6_000; // next window: calls admitted again, bytes are lifetime
  assert.equal((await after.call("a", "web_fetch", { url: "https://example.com/" }, "k")).ok, true);
  assert.equal(quota.peek(QUOTA_SCOPES.webBytes, "a", 0), 10);
  assert.equal((await after.call("a", "web_fetch", { url: "https://example.com/" }, "k")).ok, true); // 10 < 12: admitted
  const over = (await brokered(opts).call("a", "web_fetch", { url: "https://example.com/" }, "k")) as { reason: string };
  assert.match(over.reason, /byte quota exceeded \(12 bytes\)/);
  // Negative: another agent has its own counters.
  assert.equal((await after.call("b", "web_fetch", { url: "https://example.com/" }, "k")).ok, true);
});
