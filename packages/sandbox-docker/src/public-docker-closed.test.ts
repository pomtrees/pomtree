import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetSandbox } from "./test-network.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";

const spec = {
  host: "host-test",
  generation: 0,
  agent: "worker",
  image: "pinned-agent-image",
  env: {},
  mounts: [wsMount("/w")],
  egress: { allow: [], relay: [], auditedPublic: { host: "captured-host", generation: 3 } },
};
const skip = process.getuid?.() === 0 && "public spool intentionally requires unprivileged host uid";

function sandbox(root: string, failProxyRm: () => boolean) {
  mkdirSync(join(root, "work"), { recursive: true });
  const auditRoot = join(root, "audit");
  return {
    auditRoot,
    sb: new NetSandbox({
      mounts: stubMounts(() => join(root, "work")),
      egressAuditRoot: auditRoot,
      exec: async (a) => {
        if (a[0] === "inspect") throw Error("No such object");
        if (a[0] === "rm" && a[2]?.startsWith("pomtree-egress-proxy-") && failProxyRm()) throw Error("docker rm failed");
        return "0";
      },
    }),
  };
}

test("closing a sandbox marks its spool closed only once the proxy is confirmed gone; a restart of the same key reopens it", { skip }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-public-closed-")));
  try {
    let fail = true;
    const { sb, auditRoot } = sandbox(root, () => fail);
    const handle = await sb.start(spec, "closed-marker");
    const marker = join(auditRoot, handle.id, "closed.json");
    assert.equal(existsSync(marker), false, "a running sandbox's spool is open");
    await sb.kill(handle.id, `${handle.id}:kill-fails`);
    assert.equal(existsSync(marker), false, "the proxy could not be removed: it may still append, so the spool stays open");
    fail = false;
    await sb.kill(handle.id, `${handle.id}:kill-retry`); // a distinct key: a backend that dedupes keys must still act on the retry
    const { closedAt } = JSON.parse(readFileSync(marker, "utf8")) as { closedAt: number };
    assert.ok(Number.isSafeInteger(closedAt) && closedAt > 0);
    await sb.start(spec, "closed-marker");
    assert.equal(existsSync(marker), false, "reusing the spool reopens it, so it cannot be vacuumed under a live proxy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
