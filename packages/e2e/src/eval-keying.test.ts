// EVL-1 (S0, in-process, no Docker): every spawn records what it ran, so runs can be keyed by prompt, template and model.
// Run: node --test packages/e2e/src/eval-keying.test.ts
// Today the `spawned` journal row carries only its kind and the template id the agent resolved to (spawnedPayload in pomtreed's daemon-util.ts);
// there is no prompt hash, no template digest and no model on it. The first test pins that, so a change to the row is visible; the second asserts the
// target behavior and is expected to fail until the evals baseline lands.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { rig } from "./harness.ts";

type Row = { kind: string; [k: string]: unknown };

async function spawnRows(): Promise<{ identicalA: Row; identicalB: Row; different: Row }> {
  const r = rig();
  try {
    const root = await r.daemon.root();
    const row = async (name: string, task: string): Promise<Row> => {
      const a = await r.daemon.spawn(root.id, { name, task, idempotencyKey: name });
      await r.orchestrator.idle();
      const spawned = (await r.daemon.events({ agent: a.id })).filter((e) => e.payload.kind === "spawned");
      assert.equal(spawned.length, 1, `${name}: exactly one spawned row`);
      return spawned[0]?.payload as unknown as Row;
    };
    return {
      identicalA: await row("same-a", "Summarize the quarterly report."),
      identicalB: await row("same-b", "Summarize the quarterly report."),
      different: await row("other", "Translate the quarterly report."),
    };
  } finally {
    r.store.close();
    rmSync(r.stateDir, { recursive: true, force: true });
    rmSync(r.repo, { recursive: true, force: true });
  }
}

test("EVL-1 today: the spawned row is exactly {kind, template} (no template digest, model or prompt hash)", async () => {
  const rows = await spawnRows();
  for (const [label, row] of Object.entries(rows)) assert.deepEqual(row, { kind: "spawned", template: "code" }, `${label}: the spawned row`);
});

test("EVL-1: the spawned row carries a prompt hash beside the template digest and the model; the hash is stable per prompt", {
  todo: "seed(evals)",
}, async () => {
  const { identicalA, identicalB, different } = await spawnRows();
  for (const [label, row] of Object.entries({ identicalA, identicalB, different })) {
    assert.equal(typeof row.promptHash, "string", `${label}: row must carry a promptHash`);
    assert.match(String(row.promptHash), /^[0-9a-f]{64}$/, `${label}: promptHash is a sha256 hex digest`);
    assert.ok("templateDigest" in row, `${label}: row must carry the template digest`);
    assert.equal(typeof row.model, "string", `${label}: row must carry the model`);
  }
  assert.equal(identicalA.promptHash, identicalB.promptHash, "identical prompts hash equal");
  assert.notEqual(identicalA.promptHash, different.promptHash, "a different prompt hashes differently");
});
