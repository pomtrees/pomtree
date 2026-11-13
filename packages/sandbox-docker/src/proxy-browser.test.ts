import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EgressAuditEvent, EgressProxyConfig } from "./audit.ts";
import { createSidecarProxies } from "./proxy.ts";

const identity = { sandbox: "s1", agent: "a1", host: "h1", generation: 1 };

function connectVia(socketPath: string, authority: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method: "CONNECT", path: authority });
    req.once("connect", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.once("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.once("error", reject);
    req.end();
  });
}

// A relay authority (private address, in the sidecar's relay list) is reachable through the main listener and denied and
// audited through the browser listener; a public destination is reachable through both.
test("browser listener has no relay authorities; the main listener keeps them", { timeout: 15000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-browser-proxy-")));
  const fixture = createServer((s) => s.end());
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixturePort = (fixture.address() as AddressInfo).port;
  const events: EgressAuditEvent[] = [];
  const config: EgressProxyConfig = { allow: [], relay: [`relay.test:${fixturePort}`], identity, auditedPublic: true };
  const proxies = createSidecarProxies(
    config,
    new Set<string>(),
    { append: (e) => void events.push(e) },
    {
      publicPorts: new Set([fixturePort]),
      resolve: async (host) => [host === "relay.test" ? "10.0.0.5" : "8.8.8.8"],
      connect: () => connect(fixturePort, "127.0.0.1"),
    },
  );
  const mainPath = join(root, "main.sock");
  const browserPath = join(root, "browser.sock");
  await Promise.all([
    new Promise<void>((resolve) => proxies.main.server.listen(mainPath, resolve)),
    new Promise<void>((resolve) => proxies.browser.server.listen(browserPath, resolve)),
  ]);
  try {
    assert.equal(await connectVia(mainPath, `relay.test:${fixturePort}`), 200, "main listener reaches the relay");
    assert.equal(await connectVia(browserPath, `relay.test:${fixturePort}`), 403, "browser listener refuses the relay");
    assert.equal(await connectVia(browserPath, "public.test:443"), 200, "browser listener still reaches public hosts");
    assert.equal(await connectVia(mainPath, "public.test:443"), 200);
    const denied = events.filter((e) => e.phase === "admission" && e.outcome === "denied" && e.authority === `relay.test:${fixturePort}`);
    assert.equal(denied.length, 1, "exactly the browser attempt is a denied, audited row");
    assert.equal(denied[0]?.denyReason, "private");
    const allowedRelay = events.filter((e) => e.phase === "admission" && e.outcome === "allowed" && e.authority === `relay.test:${fixturePort}`);
    assert.equal(allowedRelay.length, 1);
  } finally {
    for (const p of [proxies.main, proxies.browser]) {
      p.control.close();
      p.server.close();
      p.server.closeAllConnections();
    }
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});
