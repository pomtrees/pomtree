import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { setup } from "./test-setup.ts";

const egressKind = (a: AgentRecord | null | undefined) => (a && "egress" in a.spec ? a.spec.egress.kind : undefined);
const egressOf = async (over: Parameters<typeof setup>[1]) => {
  const t = setup(async () => {}, over);
  const a = await t.spawn();
  return egressKind(await t.daemon.get(a.id));
};

test("an untemplated spawn's persisted egress follows untemplatedEgress; absent fails closed to none", async () => {
  assert.equal(await egressOf({ untemplatedEgress: undefined }), "none");
  assert.equal(await egressOf({ untemplatedEgress: "none" }), "none");
  assert.equal(await egressOf({ untemplatedEgress: "registry" }), "registry");
});

test("the built-in code template (no egress of its own) follows the key too", async () => {
  const t = setup(async () => {}, { untemplatedEgress: "registry" });
  const a = await t.spawn("k2", { template: "code" });
  assert.equal(egressKind(await t.daemon.get(a.id)), "registry");
});
