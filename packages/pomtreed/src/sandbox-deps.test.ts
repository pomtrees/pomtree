import assert from "node:assert/strict";
import { test } from "node:test";
import { DOCKER_PROFILE, PODMAN_PROFILE, scriptedLocalEngine } from "@pomtree/sandbox-docker";
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
    engine: scriptedLocalEngine(),
  });
  assert.deepEqual(deps, {
    profile: DOCKER_PROFILE,
    mounts,
    egressAuditRoot: "/state/egress-audit",
    egressProxyImage: IMAGE,
    egressRelayMaxBytes: 7654321,
    warn,
  });
  assert.equal(deps.warn, warn);
});

test("dockerSandboxDeps: the selected engine's profile and resolved socket reach the adapter; no socket stays unset", () => {
  const base = { mounts: { resolve: () => [] } as never, egressAuditRoot: "/e", cfg: { "agent.egressProxyImage": IMAGE, "push.maxBytes": 1 }, warn: () => {} };
  const podman = scriptedLocalEngine({ profile: PODMAN_PROFILE, socket: { path: "/run/podman.sock", source: "config", via: "sandbox.podman.socket" } });
  const deps = dockerSandboxDeps({ ...base, engine: podman });
  assert.equal(deps.profile, PODMAN_PROFILE);
  assert.equal(deps.socket, "/run/podman.sock");
  assert.ok(!("socket" in dockerSandboxDeps({ ...base, engine: scriptedLocalEngine() })));
});
