import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { STATE_LIMITS_DEFAULT } from "@pomtree/core";
import { statePolicyFromEnv } from "../../pomtreed/src/config.ts";
import { openSeenState } from "../../../examples/hn-digest/content-live.mts";
import { SeenFileError, SEEN_OWNER } from "../../../examples/hn-digest/content-seen.mts";

// The standalone hn-digest tool and pomtreed must apply the same POMTREED_STATE_LIMITS to the same state.sqlite: both parse it with core's
// parseStateLimits. Observed here by behavior, not by sharing the import: a doc limit set in the env refuses the tool's own write.

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "state-limits-drift-")));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("the tool applies POMTREED_STATE_LIMITS exactly as pomtreed does for the seen-state owner", async () =>
  withDir(async (dir) => {
    const raw = JSON.stringify({ owners: { [SEEN_OWNER]: { maxDocBytes: 60 } } });
    assert.equal(statePolicyFromEnv({ POMTREED_STATE_LIMITS: raw }).limitsFor(SEEN_OWNER).maxDocBytes, 60, "pomtreed's reading");
    // 30 ids serialize well over 60 bytes: refused under the env limit, accepted under the default.
    const ids = Array.from({ length: 30 }, (_, i) => 1000 + i);
    const limited = await openSeenState({ stateDir: dir, limits: raw });
    await assert.rejects(limited.store.save(ids), /too-large|byte document limit/);
    limited.close();
    assert.ok(STATE_LIMITS_DEFAULT.maxDocBytes > 60);
    const unlimited = await openSeenState({ stateDir: dir });
    await unlimited.store.save(ids);
    unlimited.close();
  }));

test("a malformed POMTREED_STATE_LIMITS refuses the tool before it opens the store (the daemon refuses to start on the same value)", async () =>
  withDir(async (dir) => {
    for (const bad of ["{", '{"default":{"maxDocs":0}}']) {
      assert.throws(() => statePolicyFromEnv({ POMTREED_STATE_LIMITS: bad }), /POMTREED_STATE_LIMITS/);
      await assert.rejects(openSeenState({ stateDir: dir, limits: bad }), (e) => e instanceof SeenFileError && /POMTREED_STATE_LIMITS/.test(e.message));
    }
  }));
