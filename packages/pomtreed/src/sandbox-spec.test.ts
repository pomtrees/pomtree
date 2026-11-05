import assert from "node:assert/strict";
import { test } from "node:test";
import type { SandboxSpec } from "@pomtree/core";
import { defaultDenyEgress, describeRunHardening, type RunHardening } from "@pomtree/sandbox-docker";
import { describeSandboxSpec, type SandboxSpecSummary } from "./sandbox-spec.ts";
import { setup } from "./test-setup.ts";
import { SANDBOX_LIFECYCLE_KIND } from "./daemon-util.ts";

const spec: SandboxSpec = {
  agent: "a1" as never,
  image: "img@sha256:abc",
  cmd: ["pi", "SECRET PROMPT"],
  env: { POMTREE_TOKEN: "tok-secret-value", B: "x" },
  mounts: [
    { kind: "bind", hostPath: "/host/secret/path", containerPath: "/sock" },
    { kind: "bind", hostPath: "/host/other/path", containerPath: "/run/s", readOnly: true },
  ],
  resources: { cpus: 2, memoryBytes: 1024, accelerators: ["gpu0"] },
  egress: { allow: [{ host: "h" }], relay: [{ host: "r" }, { host: "r2" }], auditedPublic: { host: "h1" as never, generation: 1 } },
  labels: { daemon_epoch: "e" },
};

test("describeSandboxSpec keeps names, kinds and counts, never values or host paths", () => {
  const s = describeSandboxSpec(spec);
  assert.deepEqual(s, {
    image: "img@sha256:abc",
    tty: false,
    resources: { cpus: 2, memoryBytes: 1024, accelerators: 1 },
    egress: { mode: "default-deny", allow: 1, relay: 2, auditedPublic: true },
    mounts: [
      { kind: "bind", containerPath: "/sock", readOnly: false },
      { kind: "bind", containerPath: "/run/s", readOnly: true },
    ],
    envKeys: ["B", "POMTREE_TOKEN"],
    runtimeKeys: [],
  });
  const json = JSON.stringify(s);
  for (const leak of ["tok-secret-value", "/host/secret/path", "/host/other/path", "SECRET PROMPT"]) assert.ok(!json.includes(leak), leak);
});

test("no egress block and no resources are summarized as such", () => {
  const s = describeSandboxSpec({ agent: "a" as never, image: "i", env: {}, mounts: [] });
  assert.deepEqual(s.egress, { mode: "none" });
  assert.equal("resources" in s, false);
});

test("the daemon journals the requested spec on the started entry only", async () => {
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "done" } })));
  const a = await t.spawn();
  await t.orchestrator.idle();
  const rows = (await t.journal.read({ agent: a.id }))
    .map((e) => e.payload as unknown as Record<string, unknown>)
    .filter((p) => p.kind === SANDBOX_LIFECYCLE_KIND);
  const started = rows.find((p) => p.phase === "started")!;
  const sum = started.spec as SandboxSpecSummary;
  assert.ok(sum && typeof sum.image === "string" && Array.isArray(sum.mounts) && sum.envKeys.includes("POMTREE_AGENT_ID"));
  assert.ok(!JSON.stringify(started).includes('POMTREE_TOKEN":"'));
  const realized = started.realized as RunHardening;
  assert.equal(realized.networkMode, "none");
  assert.ok(realized.capDrop.includes("ALL"));
  assert.equal("realized" in rows.find((p) => p.phase === "exited")!, false);
  assert.equal("spec" in rows.find((p) => p.phase === "exited")!, false);
});

test("the realized hardening is content-free and is network none with cap-drop ALL even without a requested egress block", () => {
  for (const sp of [spec, { agent: "a" as never, image: "i", env: { K: "tok-secret-value" }, mounts: [], cmd: ["SECRET PROMPT"] } as SandboxSpec]) {
    const h = describeRunHardening(defaultDenyEgress(sp));
    assert.equal(h.networkMode, "none");
    assert.ok(h.capDrop.includes("ALL"));
    const json = JSON.stringify(h);
    for (const leak of ["tok-secret-value", "/host/secret/path", "sec-id", "SECRET PROMPT"]) assert.ok(!json.includes(leak), leak);
  }
});
