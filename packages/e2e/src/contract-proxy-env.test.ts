import assert from "node:assert/strict";
import test from "node:test";
import { CONFIG_DEFAULTS, CONFIG_REGISTRY, CONTAINER_CONFIG_ENV, PROXY_ENV_NAMES, containerConfigEnv, type SandboxSpec } from "@pomtree/core";
import { proxyEnv } from "@pomtree/sandbox-docker";
import { createFinish, finishEnv, type RunFinish } from "../../agent-image/ext/pomtree-browser/finish.ts";
import { pomtree, pomtreeEnv } from "../../agent-image/src/browser-capture.ts";

// Producer to consumer: sandbox-docker's proxyEnv sets the egress proxy selectors in a --network none sandbox, and the browser
// worker's scrubbed `pomtree` envs (report publish in browser-capture.ts, `pomtree result` in capture_finish) must keep every one of them,
// or `pomtree` cannot reach the daemon. Expectations come from proxyEnv's actual output, never from a copy of the name list.

const spec: SandboxSpec = { agent: "a1" as SandboxSpec["agent"], image: "img@sha256:0", env: {}, mounts: [], egress: { allow: [] } };
const produced = proxyEnv("sb-1" as Parameters<typeof proxyEnv>[0], spec);
const CANARY = "PTREE_CANARY_SECRET";
// What the worker process holds: the proxy vars, POMTREE_* and secrets the scrubbed child must not see.
const workerEnv = {
  ...produced,
  POMTREE_TOKEN: "tok",
  POMTREE_API: "http://pomtreed.internal:7700",
  [CANARY]: "canary-value",
  OPENAI_API_KEY: "sk-x",
  POMTREED_STATE_DIR: "/s",
  ...containerConfigEnv(CONFIG_REGISTRY, CONFIG_DEFAULTS),
};

test("proxyEnv produces proxy selectors for an egress sandbox (the premise of the round trip)", () => {
  assert.ok(Object.keys(produced).length > 0);
  assert.ok(produced.HTTP_PROXY);
});

test("proxyEnv's key set is exactly core's PROXY_ENV_NAMES (the list the generated copies ship)", () => {
  assert.deepEqual(Object.keys(produced).sort(), [...PROXY_ENV_NAMES].sort());
});

test("the container config document survives pomtreeEnv and finishEnv unchanged, so pomtree's wait path reads the operator's values", () => {
  const doc = workerEnv[CONTAINER_CONFIG_ENV];
  assert.equal(pomtreeEnv(workerEnv)[CONTAINER_CONFIG_ENV], doc);
  assert.equal(finishEnv(workerEnv)[CONTAINER_CONFIG_ENV], doc);
});

test("every key proxyEnv produces survives pomtreeEnv with its value; the canary secret and non-POMTREE vars are dropped", () => {
  const out = pomtreeEnv(workerEnv);
  for (const [k, v] of Object.entries(produced)) assert.equal(out[k], v, k);
  assert.equal(CANARY in out, false);
  assert.equal("OPENAI_API_KEY" in out, false);
  assert.equal("POMTREED_STATE_DIR" in out, false);
});

test("every key proxyEnv produces survives finishEnv with its value; the canary secret and non-POMTREE vars are dropped", () => {
  const out = finishEnv(workerEnv);
  for (const [k, v] of Object.entries(produced)) assert.equal(out[k], v, k);
  assert.equal(CANARY in out, false);
  assert.equal("OPENAI_API_KEY" in out, false);
  assert.equal("POMTREED_STATE_DIR" in out, false);
});

test("the real children see the proxy env: pomtree's spawned child and capture_finish's runner", async () => {
  const shown = await pomtree([], { file: "/usr/bin/env", argv: [] }, workerEnv);
  const childEnv = Object.fromEntries(
    shown
      .trim()
      .split("\n")
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  for (const [k, v] of Object.entries(produced)) assert.equal(childEnv[k], v, k);
  assert.equal(CANARY in childEnv, false);
  let seen: Record<string, string> = {};
  const run: RunFinish = async (_file, _argv, env) => {
    seen = env;
    return { ok: true };
  };
  assert.equal((await createFinish({ run, env: workerEnv })("succeeded", "s")).ok, true);
  for (const [k, v] of Object.entries(produced)) assert.equal(seen[k], v, k);
  assert.equal(CANARY in seen, false);
});
