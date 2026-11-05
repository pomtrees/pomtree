import assert from "node:assert/strict";
import { test } from "node:test";
import { type createExtGateway, webFetchScope } from "./ext-gateway.ts";
import { brokeredGateway } from "./test-capture.ts";
import type { FetchFn } from "./ext-gateway.ts";

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

const scopeFetch =
  (log: string[], redirectTo?: string): FetchFn =>
  async (url) => {
    log.push(url);
    if (redirectTo && log.length === 1) return { status: 302, headers: { get: (n) => (n === "location" ? redirectTo : null) }, body: null };
    return {
      status: 200,
      headers: { get: () => "text/plain" },
      body: (async function* () {
        yield Buffer.from("ok");
      })(),
    };
  };
const fetchUrl = (gw: ReturnType<typeof createExtGateway>, url: string) =>
  gw.call("a", "web_fetch", { url }, "k") as Promise<{ ok: boolean; denied?: boolean; reason?: string }>;

test("webFetchScope: none, registry and an unknown policy are refused; allowlist yields exactly its hosts", () => {
  assert.equal(webFetchScope({ kind: "none" }), false);
  assert.equal(webFetchScope({ kind: "registry" }), false);
  assert.equal(webFetchScope({ kind: "unknown" }), false);
  assert.equal(webFetchScope(undefined), false);
  assert.deepEqual(webFetchScope({ kind: "allowlist", hosts: ["docs.example.com"] }), { hosts: ["docs.example.com"] });
});

test("web_fetch for a registry agent is refused without fetching", async () => {
  const log: string[] = [];
  const gw = brokeredGateway({ fetch: scopeFetch(log), resolveDns: publicDns, webFetchAllowed: () => webFetchScope({ kind: "registry" }) });
  const r = await fetchUrl(gw, "https://example.com/");
  assert.deepEqual([r.ok, r.denied, log.length], [false, true, 0]);
});

test("web_fetch for a none agent is refused without fetching", async () => {
  const log: string[] = [];
  const gw = brokeredGateway({ fetch: scopeFetch(log), resolveDns: publicDns, webFetchAllowed: () => webFetchScope({ kind: "none" }) });
  const r = await fetchUrl(gw, "https://example.com/");
  assert.deepEqual([r.ok, r.denied, log.length], [false, true, 0]);
});

test("web_fetch for an allowlist agent: only exact allowlisted hosts over https", async () => {
  const log: string[] = [];
  const gw = brokeredGateway({
    fetch: scopeFetch(log),
    resolveDns: publicDns,
    webFetchAllowed: () => webFetchScope({ kind: "allowlist", hosts: ["docs.example.com"] }),
  });
  assert.equal((await fetchUrl(gw, "https://docs.example.com/a")).ok, true);
  assert.equal((await fetchUrl(gw, "https://DOCS.example.com/a")).ok, true);
  for (const bad of [
    "https://other.example.com/",
    "https://docs.example.com.evil.test/",
    "https://sub.docs.example.com/",
    "http://docs.example.com/",
    "https://docs.example.com:8443/",
  ]) {
    const r = await fetchUrl(gw, bad);
    assert.deepEqual([r.ok, r.denied], [false, true], bad);
  }
  assert.equal(log.length, 1, "DOCS.example.com canonicalizes to docs.example.com: the second call is a cache hit");
});

test("web_fetch for an allowlist agent re-checks scope after each redirect", async () => {
  const log: string[] = [];
  const gw = brokeredGateway({
    fetch: scopeFetch(log, "https://evil.test/steal"),
    resolveDns: publicDns,
    webFetchAllowed: () => webFetchScope({ kind: "allowlist", hosts: ["docs.example.com"] }),
  });
  const r = await fetchUrl(gw, "https://docs.example.com/a");
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /egress policy blocks this host/);
  assert.deepEqual(log, ["https://docs.example.com/a"]);

  const log2: string[] = [];
  const same = brokeredGateway({
    fetch: scopeFetch(log2, "https://docs.example.com/b"),
    resolveDns: publicDns,
    webFetchAllowed: () => webFetchScope({ kind: "allowlist", hosts: ["docs.example.com"] }),
  });
  assert.equal((await fetchUrl(same, "https://docs.example.com/a")).ok, true);
  assert.equal(log2.length, 2);
});
