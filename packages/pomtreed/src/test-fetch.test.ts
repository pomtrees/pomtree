import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { CaptureScope } from "./capture/types.ts";
import { type TestBroker, testBroker } from "./test-capture.ts";
import { TEST_FETCH_ADDRESS, parseTestFetchHosts, testFetchSeam } from "./test-fetch.ts";

// A loopback fixture that echoes the Host header and path it was asked for.
async function fixture(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/missing" ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ host: req.headers.host, url: req.url, ua: req.headers["user-agent"] ?? null }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) };
}

const UA = "pomtree-test ops@example.org";
const only = (...hosts: string[]): CaptureScope => ({ allows: (u) => u.protocol === "https:" && hosts.includes(u.hostname) });
const ask = (t: TestBroker, url: string, hosts: string[] = ["data.sec.gov"]) =>
  t.broker.request({ kind: "operator" }, { url, purpose: "test" }, `k:${url}`, { scope: only(...hosts) });

test("a mapped host is captured from the loopback fixture with its original Host header, path and query", async () => {
  const fx = await fixture();
  try {
    const seam = testFetchSeam(parseTestFetchHosts({ "data.sec.gov": fx.port }), { resolveDns: async () => assert.fail("no real DNS for a mapped host") });
    const t = testBroker({ ...seam, userAgent: UA });
    const r = await ask(t, "https://data.sec.gov/api/xbrl/x.json?a=1");
    assert.equal(r.outcome.state, "ok", JSON.stringify(r));
    if (r.outcome.state !== "ok") return;
    assert.equal(r.outcome.capture.predicate.fetch.finalUrl, "https://data.sec.gov/api/xbrl/x.json?a=1", "the fetched URL is the one asked for");
    const raw = r.outcome.capture.artifacts.find((a) => a.role === "raw");
    assert.ok(raw);
    assert.deepEqual(JSON.parse(Buffer.from(await t.broker.read(raw)).toString("utf8")), { host: "data.sec.gov", url: "/api/xbrl/x.json?a=1", ua: UA });
    const missing = await ask(t, "https://data.sec.gov/missing");
    assert.equal(missing.outcome.state === "failed" && missing.outcome.failure.class, "not_found");
  } finally {
    await fx.close();
  }
});

test("the seam widens nothing: the scope, the URL rules and the SSRF guards still refuse, and unmapped hosts use the real transport", async () => {
  const realCalls: string[] = [];
  const seam = testFetchSeam(parseTestFetchHosts({ "data.sec.gov": 1 }), {
    resolveDns: async (h) => {
      realCalls.push(`dns ${h}`);
      return [{ address: "127.0.0.1", family: 4 }];
    },
    fetch: async (url) => {
      realCalls.push(`fetch ${url}`);
      throw new Error("unreachable");
    },
  });
  const t = testBroker({ ...seam, userAgent: UA });
  const failure = async (url: string, hosts?: string[]) => {
    const r = await ask(t, url, hosts);
    return r.outcome.state === "failed" ? `${r.outcome.failure.class}/${r.outcome.failure.reason ?? ""}` : r.outcome.state;
  };
  assert.equal(await failure("https://www.sec.gov/x"), "network/egress_denied", "not in scope");
  assert.equal(await failure("http://data.sec.gov/x"), "network/egress_denied", "http is outside an https scope");
  assert.equal(await failure("https://data.sec.gov:8443/x"), "invalid_request/", "a non-default port is refused");
  assert.equal(await failure("https://127.0.0.1/x", ["127.0.0.1"]), "invalid_request/", "a loopback literal is refused");
  assert.equal(await failure("https://example.org/x", ["example.org"]), "network/egress_denied", "an unmapped host goes through the real resolver");
  assert.deepEqual(realCalls, ["dns example.org"]);
  assert.deepEqual(await seam.resolveDns("DATA.SEC.GOV"), [{ address: TEST_FETCH_ADDRESS, family: 4 }]);
});

test("parseTestFetchHosts accepts hostname -> port only", () => {
  assert.deepEqual([...parseTestFetchHosts({})], []);
  for (const bad of [null, [], { "data.sec.gov": "1" }, { "Data.Sec.Gov": 1 }, { "data.sec.gov:443": 1 }, { "::1": 1 }, { "data.sec.gov": 70000 }])
    assert.throws(() => parseTestFetchHosts(bad), /test\.fetchHosts/);
});
