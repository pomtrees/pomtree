import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "@pomtree/testing";
import { DirTemplateStore } from "@pomtree/template-dir";
import { specResources } from "./daemon-util.ts";
import { setup } from "./test-setup.ts";

const finish = async (c: { api: (m: string, u: string, b?: unknown) => Promise<unknown> }) =>
  void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } }));

// Template JSON on disk -> template-dir validate -> resolvedSpec -> specResources -> the sandbox start: every hop must keep diskBytes,
// so the adapter's fail-closed DISK_QUOTA_UNSUPPORTED guard (sandbox-docker args.ts) can fire instead of the field vanishing.
test("template diskBytes survives template-dir, the persisted spec and specResources to the sandbox start", async () => {
  const root = tmpDir("disk-bytes-");
  writeFileSync(join(root, "disk.json"), JSON.stringify({ diskBytes: 123456, memoryBytes: 777 }));
  const tpl = await new DirTemplateStore({ root }).resolve("disk");
  assert.ok(tpl);
  const t = setup(finish);
  t.fakes.hooks.raw.templates.templates.set("disk", tpl);
  const rec = (await t.daemon.get((await t.spawn("k1", { template: "disk" })).id)) as { spec: Parameters<typeof specResources>[0] };
  await t.orchestrator.idle();
  assert.equal(rec.spec.diskBytes, 123456);
  assert.deepEqual(specResources(rec.spec), { memoryBytes: 777, diskBytes: 123456 });
  assert.equal(t.sandbox.started[0]?.resources?.diskBytes, 123456);
});
