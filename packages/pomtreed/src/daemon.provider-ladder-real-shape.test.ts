import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalize } from "@pomtree/harness-pi";
import { kinds, setup, until } from "./test-setup.ts";

// The retry ladder must trip on the event sequence real Pi emits for a failed model message (harness-pi fixtures/error.jsonl):
// a zero usage event with stopReason "error", then provider_error. The usage event must not count as progress.

const fixture = new URL("../../harness-pi/src/fixtures/error.jsonl", import.meta.url);
const failedMessage = readFileSync(fixture, "utf8")
  .split("\n")
  .filter((l) => l.includes('"message_end"') && l.includes('"assistant"'))
  .flatMap((l) => normalize(l));

test("fixture shape: error.jsonl yields a failed usage event before provider_error", () => {
  const ks = failedMessage.map((e) => e.kind);
  assert.deepEqual(ks.slice(0, 2), ["usage", "provider_error"]);
  assert.equal((failedMessage[0] as { stopReason?: string }).stopReason, "error");
});

test("provider ladder: usage-then-provider_error from real Pi output still reaches maxProviderRetries and fails", async () => {
  let aId = "";
  let calls = 0;
  const t = setup(
    async (c) => {
      aId = c.agent;
      calls++;
      // Retryable regardless of what the fixture's 400 classifies as: the shape under test is the event order.
      for (const e of failedMessage) c.emit(e.kind === "provider_error" ? { ...e, code: "outage", retryable: true } : e);
    },
    { limits: { providerBackoffMs: 2, maxProviderBackoffMs: 5, maxProviderRetries: 2 }, random: () => 0.5 },
  );
  await t.spawn();
  await until(async () => aId !== "" && kinds(await t.journal.read({ agent: aId })).some((k) => k.startsWith("exited:")));
  const seen = kinds(await t.journal.read({ agent: aId }));
  assert.equal(seen.filter((k) => k === "yielded").length, 2, seen.join(","));
  assert.ok(seen.includes("exited:failed"), seen.join(","));
  assert.equal(calls, 3);
  await t.orchestrator.idle();
});
