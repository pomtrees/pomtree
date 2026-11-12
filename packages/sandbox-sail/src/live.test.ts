import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";
import { createRequest } from "@pomtree/sandbox-kit";
// TODO(live-gate-home): the live gate lives in the e2e package, which adapters cannot depend on, so it is imported by path. Current
// behavior: this relative import is the only cross-package one in sandbox-sail; move liveSkip into @pomtree/testing and import it there.
import { liveSkip } from "../../e2e/src/live-gate.ts";
import { sailProvider } from "./provider.ts";

// The live tier: real Sailboxes API calls. It runs only when the operator opts in through the live gate (PTREE_LIVE_PROVIDERS lists
// sail, PTREE_LIVE_MAX_MICROS covers the ceiling, and the apiToken credential file exists with mode 600); otherwise it is skipped with
// the gate's reason printed. It creates nothing: it probes and lists, which the pricing page does not bill, so its ceiling is 0.
const CEILING_MICROS = 0;

const stat = (p: string) => {
  try {
    const s = statSync(p);
    return { mode: s.mode, size: s.size, isFile: s.isFile() };
  } catch {
    return undefined;
  }
};

const skip = liveSkip("sail", CEILING_MICROS, { env: process.env, credentials: sailProvider.credentials, stat });
if (skip) console.error(`skip: ${skip}`);

test("live: the Sailboxes API accepts the key and lists without error", { skip: skip || false }, async () => {
  const file = process.env[`POMTREED_SANDBOX_SAIL_${sailProvider.credentials[0]}_FILE`] as string;
  const s = sailProvider.create({
    fetch,
    // The default fetch identity (workflow.fetch.userAgent's default).
    request: createRequest(),
    credential: async () => readFileSync(file, "utf8").trim(),
    log: () => {},
    now: Date.now,
    config: {},
  });
  const probe = await s.probe!();
  assert.deepEqual(probe.problems, [], "the probe reports no problem with a valid key");
  assert.ok(Array.isArray(await s.list({ host: "live", storeId: "live", epoch: 0 })));
});
