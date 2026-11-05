import assert from "node:assert/strict";
import { test } from "node:test";
import { kinds, setup, until } from "./test-setup.ts";

// provider-attempts-durable: the retry ladder's count lives in the store (Registry.bumpProviderAttempts), so it survives a
// daemon restart and the backoff resumes, and a replayed error of one generation is counted once.

const outage = { kind: "provider_error" as const, code: "outage" as const, message: "down", retryable: true };
// Real Pi output carries a zero usage event (stopReason "error") before every provider_error; the fakes emit it too.
const failedUsage = { kind: "usage" as const, inputTokens: 0, outputTokens: 0, costMicros: 0, stopReason: "error" };
const emitOutage = (c: { emit: (e: never) => void }) => {
  c.emit(failedUsage as never);
  c.emit(outage as never);
};

test("provider attempts: a count left in the store by an earlier daemon continues the ladder instead of restarting it", async () => {
  let aId = "";
  const t = setup(
    async (c) => {
      aId = c.agent;
      // What a daemon that crashed mid-ladder leaves behind: two attempts already counted in earlier generations.
      if (!c.wake) {
        await t.daemon.deps.registry.bumpProviderAttempts(c.agent, `${c.agent}:earlier-a:provider-attempt`);
        await t.daemon.deps.registry.bumpProviderAttempts(c.agent, `${c.agent}:earlier-b:provider-attempt`);
      }
      emitOutage(c);
    },
    { limits: { providerBackoffMs: 5, maxProviderBackoffMs: 20, maxProviderRetries: 2 }, random: () => 0.5 },
  );
  await t.spawn();
  await until(async () => aId !== "" && kinds(await t.journal.read({ agent: aId })).includes("exited:failed"));
  const seen = kinds(await t.journal.read({ agent: aId }));
  // An in-memory ladder would start at zero and yield twice more; the durable one is already at its cap.
  assert.equal(seen.filter((k) => k === "yielded").length, 0);
  const exited = (await t.journal.read({ agent: aId })).find((e) => e.payload.kind === "exited");
  assert.equal((exited!.payload as { cause?: string }).cause, "provider_error");
  assert.equal(t.fakes.hooks.raw.registry.providerAttempts.has(aId), false, "finish clears the ladder");
  await t.orchestrator.idle();
});

test("provider attempts: an error of the same generation counted before a crash is not counted again", async () => {
  let aId = "";
  const t = setup(
    async (c) => {
      if (c.wake) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "recovered" } }));
      aId = c.agent;
      const gen = (await t.daemon.get(c.agent))!.generation;
      // The crashed daemon counted this generation's error under the same key the daemon now uses.
      await t.daemon.deps.registry.bumpProviderAttempts(c.agent, `${c.agent}:${gen}:provider-attempt`);
      emitOutage(c);
    },
    { limits: { providerBackoffMs: 5, maxProviderBackoffMs: 20, maxProviderRetries: 1 }, random: () => 0.5 },
  );
  await t.spawn();
  await until(async () => aId !== "" && kinds(await t.journal.read({ agent: aId })).some((k) => k.startsWith("exited:")));
  const seen = kinds(await t.journal.read({ agent: aId }));
  // Counted twice it would be at the cap (1) and fail at once; counted once it backs off, resumes and succeeds.
  assert.equal(seen.filter((k) => k === "yielded").length, 1);
  assert.ok(seen.includes("exited:succeeded"), seen.join(","));
  await t.orchestrator.idle();
});

test("provider attempts: a successful call resets the durable count, so a second ladder backs off again from attempt 1", async () => {
  let aId = "";
  let calls = 0;
  const t = setup(
    async (c) => {
      aId = c.agent;
      calls++;
      // Error, recover with usage (reset), error again: both ladders are at attempt 1, in different generations.
      if (calls === 1) return emitOutage(c);
      if (calls === 2) {
        c.emit({ kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 1, stopReason: "stop" });
        return emitOutage(c);
      }
      await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "done" } });
    },
    { limits: { providerBackoffMs: 5, maxProviderBackoffMs: 20, maxProviderRetries: 1 }, random: () => 0.5 },
  );
  await t.spawn();
  await until(async () => aId !== "" && kinds(await t.journal.read({ agent: aId })).some((k) => k.startsWith("exited:")));
  const seen = kinds(await t.journal.read({ agent: aId }));
  assert.equal(seen.filter((k) => k === "yielded").length, 2, seen.join(","));
  assert.ok(seen.includes("exited:succeeded"), seen.join(","));
  await t.orchestrator.idle();
});

// orphan-cancel-exit: aborting the in-flight model turn of a cancelled agent surfaces as a provider outage; the cancel still decides the exit.
test("provider attempts: an outage that lands after a cancel does not turn the cancelled exit into failed/provider_error", async () => {
  let aId = "";
  const t = setup(
    async (c) => {
      aId = c.agent;
      await c.stopped;
      emitOutage(c);
    },
    { limits: { providerBackoffMs: 5, maxProviderBackoffMs: 20, maxProviderRetries: 0 }, random: () => 0.5 },
  );
  const a = await t.spawn("oc");
  await until(async () => aId !== "");
  assert.equal((await t.operator("POST", `/v1/agents/${a.id}/cancel`, {})).status, 202);
  await t.orchestrator.idle();
  const exited = (await t.journal.read({ agent: a.id })).find((e) => e.payload.kind === "exited");
  assert.equal(((await t.daemon.get(a.id)) as { exit?: string }).exit, "cancelled");
  assert.notEqual((exited!.payload as { cause?: string }).cause, "provider_error");
});

test("provider attempts: with no cancel, the same outage at the cap still ends failed/provider_error", async () => {
  let aId = "";
  const t = setup(
    async (c) => {
      aId = c.agent;
      emitOutage(c);
    },
    { limits: { providerBackoffMs: 5, maxProviderBackoffMs: 20, maxProviderRetries: 0 }, random: () => 0.5 },
  );
  await t.spawn();
  await until(async () => aId !== "" && kinds(await t.journal.read({ agent: aId })).includes("exited:failed"));
  const exited = (await t.journal.read({ agent: aId })).find((e) => e.payload.kind === "exited");
  assert.equal((exited!.payload as { cause?: string }).cause, "provider_error");
  await t.orchestrator.idle();
});
