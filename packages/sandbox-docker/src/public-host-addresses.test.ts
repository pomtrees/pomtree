// Host-owned addresses are a per-start input to the proxy (EGRESS_HOST_ADDRESSES, computed daemon-side), never part
// of the immutable config: the proxy container's own interfaces are not the daemon host's.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type RequestOptions } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachProxy, parseAllow, parseHostAddresses } from "./proxy.ts";
import type { EgressAuditEvent } from "./audit.ts";
import { hostAddressList } from "./docker.ts";
import { NetSandbox } from "./test-network.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";

function get(port: number, target: string): Promise<number> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: target, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", () => resolve(0)); // the fake dial target refuses; a hang-up still shows the dial happened
    req.end();
  });
}
async function viaProxy(env: string | undefined, relay: string[]): Promise<{ status: number; dials: number; events: EgressAuditEvent[] }> {
  const events: EgressAuditEvent[] = [];
  let dials = 0;
  const proxy = createServer();
  const control = attachProxy(proxy, new Set(), {
    relay: parseAllow(relay.join(",")),
    hostAddresses: new Set(parseHostAddresses(env)),
    auditedPublic: { append: (e) => void events.push(e) },
    resolve: async () => ["8.8.8.8"],
    request: ((options: RequestOptions, cb: never) => {
      dials++;
      return request({ ...options, host: "127.0.0.1", port: 1 }, cb);
    }) as unknown as typeof request,
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    return { status: await get((proxy.address() as AddressInfo).port, "http://host-name.test/"), dials, events };
  } finally {
    control.close();
    proxy.closeAllConnections();
    proxy.close();
  }
}

test("a resolved address equal to a host-owned PUBLIC address is denied through the real proxy path", async () => {
  const r = await viaProxy(JSON.stringify(["8.8.8.8"]), []);
  assert.equal(r.status, 403);
  assert.equal(r.dials, 0);
  assert.ok(r.events.some((e) => e.outcome === "denied"));
});
test("the same public address is admitted when it is not host-owned, which shows the denial comes from the per-start input", async () => {
  const r = await viaProxy(JSON.stringify(["9.9.9.9"]), []);
  assert.equal(r.dials, 1);
});
test("an exact relay grant still reaches a host-owned address", async () => {
  const r = await viaProxy(JSON.stringify(["8.8.8.8"]), ["host-name.test:80"]);
  assert.equal(r.dials, 1);
});
test("parseHostAddresses fails closed: absent, malformed, non-string and oversized inputs throw", () => {
  assert.deepEqual(parseHostAddresses("[]"), []);
  assert.deepEqual(parseHostAddresses('["8.8.8.8","2001:4860::1"]'), ["8.8.8.8", "2001:4860::1"]);
  for (const bad of [undefined, "", "not json", "{}", "[1]", JSON.stringify(Array(1025).fill("1.1.1.1")), JSON.stringify(["x".repeat(513)])])
    assert.throws(() => parseHostAddresses(bad), /EGRESS_HOST_ADDRESSES/, String(bad));
});
test("hostAddressList lists every daemon-side interface address, scope id stripped, deduplicated", () => {
  const list = hostAddressList({ en0: [{ address: "8.8.4.4" }, { address: "fe80::1%en0" }], lo: [{ address: "8.8.4.4" }, { address: "::1" }] } as never);
  assert.deepEqual(list.sort(), ["8.8.4.4", "::1", "fe80::1"]);
});

const spec = {
  agent: "worker",
  image: "pinned-agent-image",
  env: {},
  mounts: [wsMount("/w")],
  egress: { allow: [], relay: [{ host: "host.docker.internal", port: 9876 }], auditedPublic: { host: "captured-host", generation: 3 } },
};
test("startEgress passes the daemon-side address list as a per-start env var; a restart after a NIC change still succeeds", {
  skip: process.getuid?.() === 0 && "public spool intentionally requires unprivileged host uid",
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-public-hostaddr-")));
  mkdirSync(join(root, "work"));
  const sandbox = (addresses: string[], calls: string[][]) =>
    new NetSandbox({
      mounts: stubMounts(() => join(root, "work")),
      egressAuditRoot: join(root, "audit"),
      hostAddresses: () => addresses,
      exec: async (a) => {
        calls.push(a);
        if (a[0] === "inspect") throw Error("No such object");
        return "0";
      },
    });
  try {
    const first: string[][] = [];
    const h = await sandbox(["8.8.8.8"], first).start(spec, "nic-change");
    const run = first.find((a) => a[0] === "run" && a[3] === `pomtree-egress-proxy-${h.id}`)!;
    assert.ok(run.includes(`EGRESS_HOST_ADDRESSES=${JSON.stringify(["8.8.8.8"])}`));
    const second: string[][] = [];
    const again = await sandbox(["8.8.8.8", "9.9.9.9"], second).start(spec, "nic-change");
    assert.equal(again.id, h.id);
    assert.ok(second.some((a) => a.includes(`EGRESS_HOST_ADDRESSES=${JSON.stringify(["8.8.8.8", "9.9.9.9"])}`)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
