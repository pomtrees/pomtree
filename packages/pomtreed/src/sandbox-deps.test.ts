import assert from "node:assert/strict";
import { test } from "node:test";
import { dockerSandboxDeps } from "./sandbox-deps.ts";

const IMAGE = `sha256:${"a".repeat(64)}`;

test("dockerSandboxDeps: every option is passed through and ownership is not one of them", () => {
  const mounts = { resolve: () => [] } as never;
  const warn = (_message: string): void => {};
  const deps = dockerSandboxDeps({
    mounts,
    egressAuditRoot: "/state/egress-audit",
    cfg: { "agent.egressProxyImage": IMAGE, "push.maxBytes": 7654321 },
    warn,
  });
  assert.deepEqual(deps, {
    mounts,
    egressAuditRoot: "/state/egress-audit",
    egressProxyImage: IMAGE,
    egressRelayMaxBytes: 7654321,
    warn,
  });
  assert.equal(deps.warn, warn);
});
