import assert from "node:assert/strict";
import { test } from "node:test";
import type { Template } from "@pomtree/core";
import { setup } from "./test-setup.ts";

// The sandbox egress is the controller's relay and registry targets only: model calls go through the model proxy, so
// no staged provider (named, spec model prefix, or several staged) grants a raw provider host.
const tpl = (id: string, over: Partial<Template> = {}): Template => ({ id, ...over });
const finish = async (c: { api: (m: string, u: string, b?: unknown) => Promise<unknown> }) => {
  await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
};
const creds = (providers: string[]) => ({ stage: () => [], unstage: () => {}, providerIds: () => providers });
const allowOf = (t: ReturnType<typeof setup>, i = 0) => t.fakes.hooks.raw.sandbox.started[i]!.egress?.allow.map((x) => x.host) ?? [];

test("several staged providers with no named provider grant no provider host and journal no fallback", async () => {
  const t = setup(finish, { credentials: creds(["baseten", "google"]) });
  t.fakes.hooks.raw.templates.templates.set("np", tpl("np", {}));
  const a = await t.spawn("kf1", { template: "np" });
  await t.orchestrator.idle();
  const allow = allowOf(t);
  assert.ok(!allow.includes("inference.baseten.co") && !allow.includes("generativelanguage.googleapis.com"));
  const rows = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "ext.pomtreed.provider_fallback");
  assert.equal(rows.length, 0);
});

test("a named spec provider grants no provider host; the model proxy is the only model path", async () => {
  const t = setup(finish, { credentials: creds(["baseten", "google"]) });
  t.fakes.hooks.raw.templates.templates.set("named", tpl("named", { provider: "google", model: "gemini-2.5-flash" }));
  await t.spawn("kf2", { template: "named" });
  await t.orchestrator.idle();
  assert.ok(!allowOf(t).includes("generativelanguage.googleapis.com"));
});

test("a spec model naming a staged provider grants no provider host", async () => {
  const t = setup(finish, { credentials: creds(["baseten", "google"]) });
  t.fakes.hooks.raw.templates.templates.set("m", tpl("m", { model: "google/gemini-2.5-flash" }));
  await t.spawn("kf4", { template: "m" });
  await t.orchestrator.idle();
  const allow = allowOf(t);
  assert.ok(!allow.includes("generativelanguage.googleapis.com") && !allow.includes("inference.baseten.co"));
});
