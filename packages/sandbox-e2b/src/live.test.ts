import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";
import { sandboxCredentialEnv, sandboxEnvPrefix } from "@pomtree/core";
import { createRequest } from "@pomtree/sandbox-kit";
// TODO(e2b-live-gate-import): the live gate lives in @pomtree/e2e, which is not a dependency of this package; current behavior:
// imported by path, as e2e itself imports other packages' sources.
import { liveSkip } from "../../e2e/src/live-gate.ts";
import { API_KEY_CREDENTIAL } from "./api.ts";
import { e2bProvider } from "./provider.ts";

// Live tier: real E2B calls that spend money. Skipped with the gate's printed reason unless PTREE_LIVE_PROVIDERS lists e2b, the
// spend cap PTREE_LIVE_MAX_MICROS covers the ceiling below, and the API key file is present with mode 600. Never part of
// check:lite; run only with the maintainer's go-ahead.

// Worst case: one sandbox of the default template for at most 120 s (a few thousand micros at E2B's published per-second prices),
// rounded up generously.
const CEILING_MICROS = 20_000;
// The gate derives the credential's env name as POMTREED_SANDBOX_E2B_<NAME>; the daemon's name for `apiKey` is ..._APIKEY.
const credentialEnvPart = sandboxCredentialEnv("e2b", API_KEY_CREDENTIAL).slice(sandboxEnvPrefix("e2b").length);

const skip = liveSkip("e2b", CEILING_MICROS, {
  env: process.env,
  credentials: [credentialEnvPart],
  stat: (p) => {
    try {
      const s = statSync(p);
      return { mode: s.mode, size: s.size, isFile: s.isFile() };
    } catch {
      return undefined;
    }
  },
});
if (skip) console.error(`skip: ${skip}`);

test("live e2b: start, inspect, list and kill one sandbox", { skip: skip || false }, async () => {
  const file = process.env[`${sandboxCredentialEnv("e2b", API_KEY_CREDENTIAL)}_FILE`] as string;
  const sandbox = e2bProvider.create({
    fetch: globalThis.fetch,
    request: createRequest({}),
    credential: async () => readFileSync(file, "utf8").trim(),
    log: () => {},
    now: Date.now,
    config: { "sandbox.e2b.leaseMs": 120_000 },
  });
  const owner = { host: "live-host", storeId: `live-${process.pid}`, epoch: 1 };
  const h = await sandbox.start(
    { host: "host-test", generation: 0, agent: "live-e2b", image: "base", env: {}, mounts: [], labels: { store_id: owner.storeId } },
    `live-e2b-${Date.now()}`,
  );
  try {
    assert.equal((await sandbox.inspect(h.id))?.running, true);
    assert.ok((await sandbox.list(owner)).some((l) => l.id === h.id));
  } finally {
    await sandbox.kill(h.id, "live-kill");
  }
  assert.equal((await h.wait()).exitCode, 137);
});
