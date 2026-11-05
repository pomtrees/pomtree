import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { cdpReady, cdpUserAgent } from "./browser-run.ts";

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}
function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

test("cdpReady is true only for an HTTP 200 from /json/version", async () => {
  const seen: string[] = [];
  const { server, port } = await listen((req, res) => {
    seen.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"Browser":"Chromium"}');
  });
  try {
    // Generous timeout: the production 200ms poll timeout is flaky for a cold first request under CPU load.
    assert.equal(await cdpReady(port, 5000), true);
    assert.deepEqual(seen, ["/json/version"]);
  } finally {
    await close(server);
  }
});

test("cdpReady is false for a non-200 status", async () => {
  const { server, port } = await listen((_req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  try {
    assert.equal(await cdpReady(port, 5000), false);
  } finally {
    await close(server);
  }
});

test("cdpReady is false when nothing is listening (connection refused)", async () => {
  const { server, port } = await listen((_req, res) => res.end());
  await close(server);
  assert.equal(await cdpReady(port), false);
});

test("cdpReady is false within about a second when the server accepts but never responds", async () => {
  // Never respond: the 200ms request timeout must fire.
  const { server, port } = await listen(() => {});
  try {
    const started = Date.now();
    assert.equal(await cdpReady(port), false);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
  } finally {
    await close(server);
  }
});

test("cdpUserAgent reads the User-Agent field of /json/version; a non-200, a missing field, bad JSON or no listener is undefined", async () => {
  const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36";
  for (const [status, body, expected] of [
    [200, JSON.stringify({ Browser: "Chrome/140.0.0.0", "User-Agent": UA }), UA],
    [500, JSON.stringify({ "User-Agent": UA }), undefined],
    [200, JSON.stringify({ Browser: "Chrome/140.0.0.0" }), undefined],
    [200, "{not json", undefined],
  ] as const) {
    const seen: string[] = [];
    const { server, port } = await listen((req, res) => {
      seen.push(req.url ?? "");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    try {
      assert.equal(await cdpUserAgent(port, 5000), expected);
      assert.deepEqual(seen, ["/json/version"]);
    } finally {
      await close(server);
    }
  }
  const { server, port } = await listen((_req, res) => res.end());
  await close(server);
  assert.equal(await cdpUserAgent(port), undefined);
});
