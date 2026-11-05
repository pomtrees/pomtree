import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setup, spawnSpec } from "./test-setup.ts";

const asker = async (t: ReturnType<typeof setup>, key: string) => {
  const reg = t.daemon.deps.registry;
  const a = await reg.create({
    spec: spawnSpec,
    parent: (await t.daemon.root()).id,
    name: key,
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: key,
  });
  return reg.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
};
const ask = async (question: string, options?: string[]) => {
  const t = setup(async (c) => void (await c.stopped), { escalationChannels: ["discord"] });
  const a = await asker(t, "a");
  const { escalation } = await t.daemon.ask(a.id, { question, ...(options && { options }), generation: a.generation, idempotencyKey: "k" });
  const sent = (await t.daemon.outbox({ channel: "discord" }))[0]!.payload as { subject: string };
  return { escalation, subject: sent.subject };
};

test("ask: mentions are defused, and the persisted question equals the outbox subject", async () => {
  const { escalation, subject } = await ask("ping @everyone and <@123> please", ["@here yes", "no"]);
  assert.ok(!escalation.question.includes("@everyone") && !escalation.question.includes("<@"));
  assert.equal(subject, escalation.question);
  assert.ok(!escalation.options[0]!.includes("@here"));
});

test("ask: bidi and zero-width characters are stripped", async () => {
  const { escalation, subject } = await ask("approve ‮txet‬ ​now⁦");
  assert.equal(escalation.question, "approve txet now");
  assert.equal(subject, escalation.question);
});

test("ask: a 100 KB question is capped with a visible marker", async () => {
  const { escalation, subject } = await ask("x".repeat(100_000));
  assert.ok(escalation.question.length <= 2000);
  assert.match(escalation.question, /truncated/);
  assert.equal(subject, escalation.question);
});

test("guard: daemon.ts writes user-bound message_sent only through sendToUser", () => {
  const src = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
  const writers = src.split("\n").filter((l) => /kind:\s*"message_sent"/.test(l) && !/p\.kind ===/.test(l));
  assert.equal(writers.length, 1, writers.join("\n"));
  assert.match(writers[0]!, /subject: toUser\(subject\)/);
});
