// The analysis step may start only from a template carrying the analyst allowlist profile (TODO(analyst-allowlist-binding)); harness: content-harness.mts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setup, until } from "./content-harness.mts";

const analysisChild = async (e: Awaited<ReturnType<typeof setup>>) => (await e.rt.stores.registry.list()).find((a) => a.name === "analysis-101");

test("analysis spawns from the template with the analyst profile, and the child's spec carries it", { timeout: 20000 }, async () => {
  const e = await setup();
  try {
    e.releaseCapture.resolve();
    e.releaseComment.resolve();
    const child = await until(analysisChild.bind(null, e), "analysis child spawned");
    assert.ok(child.executor === "container");
    assert.equal(child.spec.allowlist, "analyst");
  } finally {
    await e.cleanup();
  }
});

test("a grounded-model template without the profile: the host refuses the analysis spawn, so no analyst (and no shell) ever starts", {
  timeout: 20000,
}, async () => {
  const e = await setup({ modelTemplateWithoutProfile: true });
  try {
    e.releaseCapture.resolve();
    e.releaseComment.resolve();
    await until(
      async () => (await e.rt.stores.registry.list()).some((a) => a.name === "story-101" && ["exited", "reaped"].includes(a.state)),
      "story child ended",
    );
    assert.equal(await analysisChild(e), undefined, "no analysis child row exists");
    assert.ok(!e.starts.some((s) => s.startsWith("analysis-")), "no analysis container started");
  } finally {
    await e.cleanup();
  }
});
