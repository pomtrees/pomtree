import assert from "node:assert/strict";
import { test } from "node:test";
import { issueToken } from "./auth.ts";
import { listenHost } from "./server.ts";
import { SECRET, setup } from "./test-setup.ts";

const hostTok = issueToken(SECRET, { scope: "host", channel: "discord" });
const opTok = issueToken(SECRET, { scope: "operator" });

// Drives the real host-only TCP listener (POMTREED_HOST_LISTEN), not handle() directly.
async function call(port: number, method: string, path: string, token: string): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  await r.arrayBuffer();
  return r.status;
}

test("the host listener serves exactly the three GET host read shapes to host credentials", async () => {
  const t = setup(async () => {}, { messagingChannels: ["discord"] });
  const { server, port } = await listenHost(t.daemon, "127.0.0.1", 0);
  try {
    assert.equal(await call(port, "GET", "/v1/host/agents?sender=u1", hostTok), 200);
    const root = await t.daemon.root();
    assert.equal(await call(port, "GET", `/v1/host/agents/${root.id}/budget?sender=u1`, hostTok), 200);
    assert.equal(await call(port, "GET", `/v1/host/agents/${root.id}/report?sender=u1`, hostTok), 200);
    // no other shape or method reaches a handler on this listener
    const cases: Array<[string, string]> = [
      ["GET", `/v1/host/agents/${root.id}?sender=u1`],
      ["GET", `/v1/host/agents/${root.id}/budget/junk?sender=u1`],
      ["GET", "/v1/host/other?sender=u1"],
      ["GET", "/v1/agents"],
      ["POST", "/v1/host/agents?sender=u1"],
      ["POST", `/v1/host/agents/${root.id}/budget?sender=u1`],
      ["DELETE", "/v1/host/agents?sender=u1"],
    ];
    for (const [method, path] of cases) assert.equal(await call(port, method, path, hostTok), 404, `${method} ${path}`);
    // non-host credentials are refused by the listener itself
    assert.equal(await call(port, "GET", "/v1/host/agents?sender=u1", opTok), 401);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
