import assert from "node:assert/strict";
import { test } from "node:test";
import { dockerSandboxDeps } from "./sandbox-deps.ts";

const IMAGE = `sha256:${"a".repeat(64)}`;

test("dockerSandboxDeps: the owner is the daemon's storeId and boot epoch, and every other option is passed through", () => {
  const mounts = { resolve: () => [] } as never;
  const warn = (_message: string): void => {};
  const deps = dockerSandboxDeps({
    mounts,
    egressAuditRoot: "/state/egress-audit",
    storeId: "store-ab12cd34",
    bootEpoch: "1700000000123",
    cfg: { "agent.egressProxyImage": IMAGE, "push.maxBytes": 7654321 },
    warn,
  });
  assert.deepEqual(deps.owner, { storeId: "store-ab12cd34", epoch: "1700000000123" });
  assert.deepEqual(deps, {
    mounts,
    egressAuditRoot: "/state/egress-audit",
    egressProxyImage: IMAGE,
    egressRelayMaxBytes: 7654321,
    owner: { storeId: "store-ab12cd34", epoch: "1700000000123" },
    warn,
  });
  assert.equal(deps.warn, warn);
});
