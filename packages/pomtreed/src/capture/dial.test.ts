// The broker's guarded GET (dial.ts): the SSRF guard, connect pinning, scope and redirect rules, the shared deadline, the body cap
// and redirect-body release, against a scripted in-memory transport (no sockets) unless a test needs a real one.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchFn, FetchInit, FetchResponse } from "../ext-gateway.ts";
import { type DialOptions, dial } from "./dial.ts";

type Answer = { status: number; headers?: Record<string, string>; body?: AsyncIterable<Uint8Array> | null; cancel?: () => void } | "hang" | Error;

function transport(answers: Record<string, Answer | Answer[]>) {
  const calls: { url: string; init: FetchInit }[] = [];
  const hits = new Map<string, number>();
  const fetch: FetchFn = (url, init) => {
    calls.push({ url, init });
    const a = answers[url];
    if (a === undefined) return Promise.resolve(resp({ status: 404 }));
    const n = hits.get(url) ?? 0;
    hits.set(url, n + 1);
    const one = Array.isArray(a) ? (a[Math.min(n, a.length - 1)] as Answer) : a;
    if (one === "hang") return new Promise<FetchResponse>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    if (one instanceof Error) return Promise.reject(one);
    return Promise.resolve(resp(one));
  };
  return { fetch, calls };
}

function resp(a: Exclude<Answer, "hang" | Error>): FetchResponse {
  const headers = Object.fromEntries(Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status: a.status,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    body: a.body === undefined ? bytes("ok") : a.body,
    ...(a.cancel && { cancel: a.cancel }),
  };
}

async function* bytes(s: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(s);
}

const dns: Record<string, string> = { "a.example.com": "93.184.216.34", "b.example.com": "93.184.216.35", "evil.example.com": "10.1.2.3" };
const resolveDns = async (h: string) => {
  const a = dns[h];
  if (a === undefined) throw Object.assign(new Error(`ENOTFOUND ${h}`), { code: "ENOTFOUND" });
  return [{ address: a, family: 4 }];
};
const hostsScope = (hosts: string[]) => (u: URL) => u.protocol === "https:" && (u.port === "" || u.port === "443") && hosts.includes(u.hostname);

const base = (o: Partial<DialOptions> & { fetch: FetchFn }): DialOptions => ({
  url: "https://a.example.com/start",
  userAgent: "pomtree-test/1.0 ops@example.org",
  maxBytes: 1024,
  overflow: "fail",
  timeoutMs: 1000,
  opIdBase: "job:static:0",
  resolveDns,
  ...o,
});

const redirect = (location: string, status = 302) => ({ status, headers: { location } });

test("a redirect, relative Location included, is re-pinned per hop to the resolved address, and the final URL reported", async () => {
  const t = transport({
    "https://a.example.com/start": redirect("https://b.example.com/next"),
    "https://b.example.com/next": redirect("../final?x=1#frag", 301),
    "https://b.example.com/final?x=1": { status: 200, headers: { "content-type": "text/plain" } },
  });
  const r = await dial(base({ fetch: t.fetch }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.meta.finalUrl, "https://b.example.com/final?x=1", "a Location fragment is dropped");
  assert.deepEqual(r.meta.redirects, [
    { url: "https://a.example.com/start", status: 302 },
    { url: "https://b.example.com/next", status: 301 },
  ]);
  assert.deepEqual(
    t.calls.map((c) => c.init.pin),
    [
      { hostname: "a.example.com", address: "93.184.216.34", family: 4 },
      { hostname: "b.example.com", address: "93.184.216.35", family: 4 },
      { hostname: "b.example.com", address: "93.184.216.35", family: 4 },
    ],
  );
  assert.ok(
    t.calls.every((c) => c.init.headers?.["user-agent"] === "pomtree-test/1.0 ops@example.org"),
    "the User-Agent goes on every hop",
  );
  assert.equal(r.meta.contentType, "text/plain");
});

for (const [name, location] of [
  ["an http hop", "http://a.example.com/x"],
  ["another port", "https://a.example.com:8443/x"],
  ["another host", "https://b.example.com/x"],
] as const)
  test(`under a hosts scope ${name} is refused before it is dialed (network/egress_denied)`, async () => {
    const t = transport({ "https://a.example.com/start": redirect(location) });
    const r = await dial(base({ fetch: t.fetch, allows: hostsScope(["a.example.com"]) }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual([r.failure.class, r.failure.reason], ["network", "egress_denied"]);
    assert.equal(t.calls.length, 1);
  });

for (const [name, location] of [
  ["credentials in the Location", "https://user:pw@b.example.com/x"],
  ["a blocked literal", "https://127.0.0.1/x"],
  ["a metadata literal", "http://169.254.169.254/latest"],
] as const)
  test(`a hop with ${name} is refused (network/egress_denied)`, async () => {
    const t = transport({ "https://a.example.com/start": redirect(location) });
    const r = await dial(base({ fetch: t.fetch }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual([r.failure.class, r.failure.reason], ["network", "egress_denied"]);
    assert.equal(t.calls.length, 1);
  });

test("a host, or a hop, whose DNS resolves to a blocked address is refused before it is dialed", async () => {
  const t = transport({ "https://a.example.com/start": redirect("https://evil.example.com/x") });
  const first = await dial(base({ fetch: t.fetch, url: "https://evil.example.com/x" }));
  assert.equal(!first.ok && `${first.failure.class}/${first.failure.reason}`, "network/egress_denied");
  assert.equal(t.calls.length, 0);
  const hop = await dial(base({ fetch: t.fetch }));
  assert.equal(!hop.ok && `${hop.failure.class}/${hop.failure.reason}`, "network/egress_denied");
  assert.deepEqual(
    t.calls.map((c) => c.url),
    ["https://a.example.com/start"],
  );
});

test("a name that does not resolve is network/dns", async () => {
  const t = transport({});
  const r = await dial(base({ fetch: t.fetch, url: "https://nx.example.com/" }));
  assert.equal(!r.ok && `${r.failure.class}/${r.failure.reason}`, "network/dns");
});

test("too many hops, a missing Location and an unparseable Location are upstream errors", async () => {
  const loop = transport(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`https://a.example.com/${i === 0 ? "start" : i}`, redirect(`/${i + 1}`)])));
  const many = await dial(base({ fetch: loop.fetch }));
  assert.equal(!many.ok && `${many.failure.class}/${many.failure.reason}`, "upstream_error/http");
  assert.equal(loop.calls.length, 6, "five redirects are followed, the sixth is refused");
  const missing = await dial(base({ fetch: transport({ "https://a.example.com/start": { status: 302 } }).fetch }));
  assert.equal(!missing.ok && `${missing.failure.class}/${missing.failure.reason}`, "upstream_error/malformed");
  const bad = await dial(base({ fetch: transport({ "https://a.example.com/start": redirect("http://[::1") }).fetch }));
  assert.equal(!bad.ok && `${bad.failure.class}/${bad.failure.reason}`, "upstream_error/malformed");
});

test("every hop shares one deadline", async () => {
  const slow: FetchFn = (url, init) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(resp(redirect(`${url}x`))), 60);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      });
    });
  const r = await dial(base({ fetch: slow, timeoutMs: 150, maxRedirects: 10 }));
  assert.equal(!r.ok && `${r.failure.class}/${r.failure.reason}`, "timeout/first_byte");
  assert.equal(!r.ok && r.ctx.ms, 150);
});

test("a hung transport is bounded by the deadline", async () => {
  const t0 = Date.now();
  const r = await dial(base({ fetch: transport({ "https://a.example.com/start": "hang" }).fetch, timeoutMs: 100 }));
  assert.equal(!r.ok && r.failure.class, "timeout");
  assert.ok(Date.now() - t0 < 1000);
});

test("each redirect hop's body is released before the next hop: cancel(), or the iterator's return()", async () => {
  const events: string[] = [];
  let returned = false;
  const iterBody: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: false, value: new Uint8Array(1) }),
      return: async () => {
        returned = true;
        events.push("return");
        return { done: true, value: undefined };
      },
    }),
  };
  const t = transport({
    "https://a.example.com/start": { ...redirect("/two"), cancel: () => events.push("cancel") },
    "https://a.example.com/two": { ...redirect("/three"), body: iterBody },
    "https://a.example.com/three": { status: 200 },
  });
  const fetch: FetchFn = (url, init) => {
    events.push(`fetch ${new URL(url).pathname}`);
    return t.fetch(url, init);
  };
  const r = await dial(base({ fetch }));
  assert.equal(r.ok, true);
  assert.equal(returned, true);
  assert.deepEqual(events, ["fetch /start", "cancel", "fetch /two", "return", "fetch /three"]);
});

test("a streamed body without content-length is capped while streaming and the transport aborted", async () => {
  let finished = false;
  async function* endless(): AsyncIterable<Uint8Array> {
    try {
      for (;;) yield new Uint8Array(64);
    } finally {
      finished = true;
    }
  }
  const r = await dial(base({ fetch: transport({ "https://a.example.com/start": { status: 200, body: endless() } }).fetch, maxBytes: 200 }));
  assert.equal(!r.ok && r.failure.class, "too_large");
  assert.equal(!r.ok && r.ctx.cap, 200);
  assert.equal(finished, true, "the body iterator is closed");
});

test("truncate mode keeps the first maxBytes (robots.txt reads at most its parse limit)", async () => {
  const r = await dial(
    base({ fetch: transport({ "https://a.example.com/start": { status: 200, body: bytes("x".repeat(300)) } }).fetch, maxBytes: 100, overflow: "truncate" }),
  );
  assert.equal(r.ok && r.bytes.byteLength, 100);
  assert.equal(r.ok && r.truncated, true);
});

test("headers are allowlisted: Set-Cookie and proxy headers are dropped", async () => {
  const r = await dial(
    base({
      fetch: transport({
        "https://a.example.com/start": {
          status: 200,
          headers: { "content-type": "text/html", "set-cookie": "s=1", "x-forwarded-for": "1.2.3.4", etag: '"e"' },
        },
      }).fetch,
    }),
  );
  assert.deepEqual(r.ok && r.meta.headers, { "content-type": "text/html", etag: '"e"' });
});

test("a TLS error and a reset map to network/tls and upstream_error/reset", async () => {
  const tls = await dial(base({ fetch: transport({ "https://a.example.com/start": Object.assign(new Error("cert"), { code: "CERT_HAS_EXPIRED" }) }).fetch }));
  assert.equal(!tls.ok && `${tls.failure.class}/${tls.failure.reason}`, "network/tls");
  const reset = await dial(
    base({ fetch: transport({ "https://a.example.com/start": Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }).fetch }),
  );
  assert.equal(!reset.ok && `${reset.failure.class}/${reset.failure.reason}`, "upstream_error/reset");
});

test("the shutdown signal aborts without blaming the URL; pacing gets a per-hop opId", async () => {
  const ac = new AbortController();
  const paced: string[] = [];
  const p = dial(
    base({
      fetch: transport({ "https://a.example.com/start": "hang" }).fetch,
      signal: ac.signal,
      pace: async (host, _s, opId) => void paced.push(`${host} ${opId}`),
    }),
  );
  setTimeout(() => ac.abort(), 20);
  const r = await p;
  assert.equal(!r.ok && r.aborted, true);
  assert.deepEqual(paced, ["a.example.com job:static:0:0"]);
});
