import assert from "node:assert/strict";
import { test } from "node:test";
import type { JournalEntry } from "@pomtree/core";
import { setup } from "./test-setup.ts";

test("doctor reports gitSha, imageRevision and revisionMismatch", async () => {
  const mismatch = setup(async () => {}, { gitSha: () => "abc1234", imageRevision: () => "def5678" });
  const d1 = await mismatch.daemon.doctor();
  assert.equal(d1.gitSha, "abc1234");
  assert.equal(d1.imageRevision, "def5678");
  assert.equal(d1.revisionMismatch, true);

  const match = setup(async () => {}, { gitSha: () => "abc1234", imageRevision: () => "abc1234" });
  const d2 = await match.daemon.doctor();
  assert.equal(d2.gitSha, "abc1234");
  assert.equal(d2.revisionMismatch, false);

  // An unknown image revision (undefined) is never a mismatch.
  const unknown = setup(async () => {}, { gitSha: () => "abc1234", imageRevision: () => undefined });
  const d3 = await unknown.daemon.doctor();
  assert.equal(d3.imageRevision, undefined);
  assert.equal(d3.revisionMismatch, false);
});

test("admission journals the revision mismatch once as a host_error", async () => {
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "done" } })), {
    gitSha: () => "abc1234",
    imageRevision: () => "def5678",
  });
  const a = await t.spawn("k1");
  await t.orchestrator.idle();
  assert.equal((await t.daemon.get(a.id))?.exit, "succeeded");
  const root = await t.daemon.root();
  const rows = (await t.journal.read({ agent: root.id })) as JournalEntry[];
  const mismatches = rows.filter(
    (e) => e.payload.kind === "host_error" && e.payload.component === "daemon" && String(e.payload.message).includes("revision mismatch"),
  );
  assert.equal(mismatches.length, 1);
  assert.match(
    String((mismatches[0]!.payload as { message: string }).message),
    /client\/server revision mismatch: pomtreed git abc1234 vs agent image def5678/,
  );
});

test("admission does not journal a mismatch when revisions are unknown or equal", async () => {
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "done" } })), {
    gitSha: () => undefined,
    imageRevision: () => undefined,
  });
  const a = await t.spawn("k1");
  await t.orchestrator.idle();
  assert.equal((await t.daemon.get(a.id))?.exit, "succeeded");
  const root = await t.daemon.root();
  const rows = (await t.journal.read({ agent: root.id })) as JournalEntry[];
  const mismatches = rows.filter(
    (e) => e.payload.kind === "host_error" && e.payload.component === "daemon" && String(e.payload.message).includes("revision mismatch"),
  );
  assert.equal(mismatches.length, 0);
});
