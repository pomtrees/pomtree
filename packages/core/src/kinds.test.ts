import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isPassiveForWaiting, POMTREED_KIND_PREFIX, POMTREED_KINDS, STEERED_KIND, WAITING_KIND } from "./index.ts";
import type { JournalPayload, ModelSettlementJournalPayload } from "./index.ts";

const dir = dirname(fileURLToPath(import.meta.url));

test("every registry kind is unique and under the ext.pomtreed. prefix", () => {
  const values = Object.values(POMTREED_KINDS);
  assert.equal(new Set(values).size, values.length);
  for (const v of values) assert.ok(v.startsWith(POMTREED_KIND_PREFIX), v);
});

test("core's prefix match covers every registry kind except the steered and waiting markers", () => {
  for (const v of Object.values(POMTREED_KINDS)) {
    assert.equal(isPassiveForWaiting(v), v !== STEERED_KIND && v !== WAITING_KIND, v);
  }
  assert.equal(isPassiveForWaiting("tool_call"), false);
});

test("no ext.pomtreed. literal is written in core outside the registry", () => {
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f === "kinds.ts") continue;
    const code = readFileSync(join(dir, f), "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"));
    assert.deepEqual(
      code.filter((l) => l.includes("ext.pomtreed.")),
      [],
      f,
    );
  }
});

// Compile-time contract: the typed pomtreed payloads are JournalPayload members, so a producer's interface (no index signature)
// journals without a cast. A wrong field type or an unknown settlement/errorClass must not compile.
test("typed ext.pomtreed payloads are assignable to JournalPayload without a cast", () => {
  interface ProducerSettlement {
    kind: typeof POMTREED_KINDS.modelSettlement;
    settlement: "failed";
    micros: number;
    requestId: string;
    route?: "messages";
    errorClass?: "upstream_5xx";
  }
  const settlement: ProducerSettlement = {
    kind: POMTREED_KINDS.modelSettlement,
    settlement: "failed",
    micros: 0,
    requestId: "r1",
    route: "messages",
    errorClass: "upstream_5xx",
  };
  const requested: number | undefined = undefined;
  const payloads: JournalPayload[] = [
    settlement,
    { kind: POMTREED_KINDS.budgetEscalated, approval: "ap1", requested, spent: 5, budget: 4 },
    { kind: POMTREED_KINDS.budgetGranted, approval: "ap1", amount: 2, payer: "root", newBudget: 6 },
    { kind: POMTREED_KINDS.budgetDenied, approval: "ap1", reason: "asker exited" },
  ];
  // @ts-expect-error micros is a number
  const bad: ModelSettlementJournalPayload = { kind: POMTREED_KINDS.modelSettlement, settlement: "priced", micros: "1", requestId: "r" };
  // @ts-expect-error errorClass is a closed class
  const badClass: ModelSettlementJournalPayload = { kind: POMTREED_KINDS.modelSettlement, settlement: "failed", micros: 0, requestId: "r", errorClass: "boom" };
  assert.deepEqual(
    payloads.map((p) => p.kind),
    [POMTREED_KINDS.modelSettlement, POMTREED_KINDS.budgetEscalated, POMTREED_KINDS.budgetGranted, POMTREED_KINDS.budgetDenied],
  );
  assert.ok(bad && badClass);
});
