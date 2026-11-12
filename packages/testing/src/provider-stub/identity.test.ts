import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { test } from "node:test";
import { assertAllRequestsCarry, identityCollector } from "./identity.ts";
import { ProviderStub } from "./server.ts";

// IDENTITY_BREAK=1 makes this file's own clients drop the User-Agent, so the whole file must then exit non-zero: proof the helper catches a missing
// identity. Read here only.
const BREAK = process.env.IDENTITY_BREAK === "1";
const UA = "pomtree";

async function withStub(run: (stub: ProviderStub, c: ReturnType<typeof identityCollector>) => Promise<void>): Promise<void> {
  const c = identityCollector();
  const stub = await ProviderStub.start({ observeUserAgent: c.observe });
  try {
    await run(stub, c);
  } finally {
    await stub.close();
  }
}

// Stands in for the kit's `createRequest({ userAgent })` (packages/sandbox-kit/src/request.ts): @pomtree/testing must not depend on the kit, so this
// minimal requester only stamps a User-Agent. The real kit and the pomtreed facade are exercised by the adapter tests, which use this helper.
const stampingRequest =
  (userAgent: string) =>
  (url: string, init: RequestInit = {}): Promise<Response> =>
    fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(BREAK ? {} : { "user-agent": userAgent }) } });

/** Raw websocket handshake; resolves with the first response line. The stub answers 501 (no fixture) but still observes the upgrade. */
function upgrade(stub: ProviderStub, path: string, userAgent: string | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(Number(new URL(stub.baseUrl).port), "127.0.0.1");
    const ua = userAgent === undefined || BREAK ? "" : `User-Agent: ${userAgent}\r\n`;
    s.on("connect", () =>
      s.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n${ua}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`,
      ),
    );
    s.once("data", (d) => {
      s.destroy();
      resolve(d.toString("utf8").split("\r\n")[0] ?? "");
    });
    s.on("error", reject);
  });
}

test("a plain fetch with the right User-Agent passes", async () => {
  await withStub(async (stub, c) => {
    await stampingRequest(UA)(`${stub.baseUrl}/sandboxes`);
    assertAllRequestsCarry(c, UA);
    assert.deepEqual(
      c.seen().map((s) => [s.method, s.path, s.userAgent]),
      [["GET", "/sandboxes", UA]],
    );
  });
});

test("a missing or wrong User-Agent fails, naming the count and method/path and no header value", async () => {
  await withStub(async (stub, c) => {
    await stampingRequest(UA)(`${stub.baseUrl}/ok`);
    await fetch(`${stub.baseUrl}/wrong`, { headers: { "user-agent": "curl/8 secret-ish" } });
    await fetch(`${stub.baseUrl}/missing`, { method: "POST", headers: { "user-agent": "" } });
    assert.throws(
      () => assertAllRequestsCarry(c, UA),
      (e: Error) => {
        assert.match(e.message, /2 of 3 request\(s\)/);
        assert.match(e.message, /GET \/wrong/);
        assert.match(e.message, /POST \/missing/);
        assert.doesNotMatch(e.message, /curl|secret-ish/);
        assert.match(e.message, /createRequest/);
        return true;
      },
    );
  });
});

test("the vacuity guard fails when zero requests were observed", async () => {
  await withStub(async (_stub, c) => {
    assert.throws(() => assertAllRequestsCarry(c, UA), /observed no requests/);
  });
});

test("a websocket upgrade is observed: the right User-Agent passes", async () => {
  await withStub(async (stub, c) => {
    const line = await upgrade(stub, "/stream", UA);
    assert.match(line, /^HTTP\/1\.1 /);
    assert.equal(c.seen().length, 1);
    assert.equal(c.seen()[0]?.upgrade, true);
    assertAllRequestsCarry(c, UA);
  });
});

test("a websocket upgrade with a wrong or missing User-Agent fails", async () => {
  await withStub(async (stub, c) => {
    await upgrade(stub, "/wrong", "ws-client/1");
    await upgrade(stub, "/missing", undefined);
    assert.throws(
      () => assertAllRequestsCarry(c, UA),
      (e: Error) => /2 of 2/.test(e.message) && /UPGRADE \/wrong/.test(e.message) && /UPGRADE \/missing/.test(e.message) && !/ws-client/.test(e.message),
    );
  });
});

test("the recorder still keeps header names only", async () => {
  await withStub(async (stub) => {
    await fetch(`${stub.baseUrl}/x`, { headers: { "user-agent": "pomtree", authorization: "Bearer sekrit" } });
    assert.ok(!JSON.stringify(stub.requests()).includes("sekrit"));
  });
});

test("the User-Agent is compared exactly: a different case or a suffix fails", async () => {
  await withStub(async (stub, c) => {
    await fetch(`${stub.baseUrl}/upper`, { headers: { "user-agent": "POMTREE" } });
    await fetch(`${stub.baseUrl}/suffix`, { headers: { "user-agent": "pomtree/1" } });
    assert.throws(() => assertAllRequestsCarry(c, UA), /2 of 2 request\(s\).*GET \/upper; GET \/suffix/);
  });
});
