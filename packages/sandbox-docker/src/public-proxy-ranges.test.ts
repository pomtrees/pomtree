import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type RequestOptions } from "node:http";
import { attachProxy, classifyAddress, resolveAllowed } from "./proxy.ts";
import type { EgressAuditEvent } from "./audit.ts";

// Private-space IPv4 targets, each embedded in an IPv6 form that a v6-only deny list would miss.
const PRIVATE_V4 = ["127.0.0.1", "169.254.169.254", "192.168.1.1", "172.16.0.1", "100.64.0.1", "10.0.0.1"];

// Hex spelling of the low 32 bits of each entry above (the form a resolver returns for ::ffff:a.b.c.d).
const PRIVATE_V4_HEX = ["7f00:1", "a9fe:a9fe", "c0a8:101", "ac10:1", "6440:1", "a00:1"];

test("classifyAddress: IPv4-mapped (dotted and hex) embeddings of private space are not public", () => {
  for (const v4 of PRIVATE_V4) {
    assert.notEqual(classifyAddress(`::ffff:${v4}`), "public", `::ffff:${v4}`);
  }
  for (const hex of PRIVATE_V4_HEX) {
    assert.notEqual(classifyAddress(`::ffff:${hex}`), "public", `::ffff:${hex}`);
    assert.notEqual(classifyAddress(`::${hex}`), "public", `::${hex} (v4-compatible)`);
  }
});

test("classifyAddress: NAT64 64:ff9b::/96 embeddings of private space are not public", () => {
  for (const hex of PRIVATE_V4_HEX) assert.notEqual(classifyAddress(`64:ff9b::${hex}`), "public", `64:ff9b::${hex}`);
  for (const v4 of PRIVATE_V4) assert.notEqual(classifyAddress(`64:ff9b::${v4}`), "public", `64:ff9b::${v4}`);
});

test("classifyAddress: 6to4 2002::/16 embeddings of private space are not public", () => {
  // 2002:AABB:CCDD:: embeds the IPv4 address AA.BB.CC.DD in bits 16-47.
  const sixToFour = ["2002:7f00:1::", "2002:a9fe:a9fe::", "2002:c0a8:101::", "2002:ac10:1::", "2002:6440:1::", "2002:a00:1::"];
  for (const ip of sixToFour) assert.notEqual(classifyAddress(ip), "public", ip);
  assert.equal(classifyAddress("2002:7f00:1::"), "hard");
  assert.equal(classifyAddress("2002:a9fe:a9fe::"), "hard");
  assert.equal(classifyAddress("2002:c0a8:101::"), "private");
  assert.equal(classifyAddress("2002:ac10:1::"), "private");
  assert.equal(classifyAddress("2002:6440:1::"), "private");
  assert.equal(classifyAddress("2002:a00:1::"), "private");
});

test("classifyAddress: genuinely public IPv4 in v6 spellings stays public (no over-denial)", () => {
  // Intended: the embedded IPv4 decides the class, so public v4 under any v6 wrapper is public.
  for (const ip of ["8.8.8.8", "::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "64:ff9b::8.8.8.8", "2002:0808:0808::"]) {
    assert.equal(classifyAddress(ip), "public", ip);
  }
});

test("resolveAllowed: a public hostname whose only answer is a private-space v6 embedding is denied", async () => {
  for (const answer of ["::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "2002:c0a8:101::", "::c0a8:101"]) {
    assert.equal(await resolveAllowed("embed.test", async () => [answer], new Set()), undefined, answer);
  }
  assert.equal(await resolveAllowed("embed.test", async () => ["2002:0808:0808::"], new Set()), "2002:0808:0808::");
});

// End-to-end through attachProxy: the fake resolver supplies the encoded address, and the dial seam
// records every upstream dial so a denied answer proves no connection was attempted.
test("absolute-form request to a host resolving to a private-space v6 embedding is refused before any dial", async () => {
  const events: EgressAuditEvent[] = [];
  const dialed: string[] = [];
  const proxy = createServer();
  const answers: Record<string, string> = { "nat64.test": "64:ff9b::a9fe:a9fe", "sixtofour.test": "2002:7f00:1::", "mapped.test": "::ffff:192.168.1.1" };
  const control = attachProxy(proxy, new Set(), {
    hostAddresses: new Set<string>(),
    auditedPublic: {
      append: (e) => {
        events.push(e);
      },
    },
    resolve: async (host) => [answers[host] ?? "8.8.8.8"],
    request: ((options: RequestOptions) => {
      dialed.push(String(options.host));
      throw Error("must not dial");
    }) as typeof request,
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const port = (proxy.address() as { port: number }).port;
  try {
    for (const host of Object.keys(answers)) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: `http://${host}/`, agent: false }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      assert.equal(status, 403, host);
    }
    assert.deepEqual(dialed, []);
    assert.equal(events.filter((e) => e.phase === "admission" && e.outcome === "denied").length, Object.keys(answers).length);
    assert.equal(
      events.some((e) => e.outcome === "allowed"),
      false,
    );
  } finally {
    control.close();
    proxy.close();
  }
});
