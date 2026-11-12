import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONFIG_REGISTRY,
  CONTAINER_READER_SOURCE_PATH,
  EGRESS_PROXY_PORT,
  EGRESS_SOCKET_DIR,
  EGRESS_SOCKET_NAME,
  PROXY_ENV_NAMES,
  containerContractText,
} from "@pomtree/core";
import * as shipped from "./container-contract.gen.ts";
import { EGRESS_SOCKET_PATH, proxyEnv } from "./egress.ts";
import { containerConfigTestEnv, wsMount } from "./test-mounts.ts";

// The egress COPY ships this copy flat into the image (worker.ts, proxy.ts import it); the host imports the same facts from core.
const COPY = new URL("./container-contract.gen.ts", import.meta.url);

test("the shipped container contract copy is the generator's output (run pnpm gen:config)", () => {
  const want = containerContractText(CONFIG_REGISTRY, readFileSync(CONTAINER_READER_SOURCE_PATH, "utf8"));
  assert.equal(readFileSync(COPY, "utf8"), want, "packages/sandbox-docker/src/container-contract.gen.ts is stale: run pnpm gen:config");
});

test("the in-image egress facts and the host's agree: bridge port, socket path and proxy env names", () => {
  assert.equal(shipped.EGRESS_PROXY_PORT, EGRESS_PROXY_PORT);
  assert.equal(`${shipped.EGRESS_SOCKET_DIR}/${shipped.EGRESS_SOCKET_NAME}`, EGRESS_SOCKET_PATH);
  assert.equal(EGRESS_SOCKET_PATH, `${EGRESS_SOCKET_DIR}/${EGRESS_SOCKET_NAME}`);
  assert.deepEqual(shipped.PROXY_ENV_NAMES, PROXY_ENV_NAMES);
  // proxyEnv points the clients at the port the in-image byte bridge listens on.
  const env = proxyEnv("sb-1", { host: "host-test", generation: 0, agent: "a1", image: "img", env: {}, mounts: [wsMount("/w")], egress: { allow: [] } });
  assert.equal(env.HTTP_PROXY, `http://127.0.0.1:${shipped.EGRESS_PROXY_PORT}`);
});

test("producer to reader: the gated tests' config env validates with the shipped reader", () => {
  const env = containerConfigTestEnv();
  assert.deepEqual(Object.keys(env), [shipped.CONTAINER_CONFIG_ENV]);
  assert.deepEqual(shipped.readContainerConfig(env, { required: true }), shipped.CONTAINER_DEFAULTS);
  // Negative: the worker fails closed without the document, and on a document from another contract.
  assert.throws(() => shipped.readContainerConfig({}, { required: true }));
  const doc = JSON.parse(env[shipped.CONTAINER_CONFIG_ENV]) as { contract: string };
  const foreign = JSON.stringify({ ...doc, contract: "0".repeat(16) });
  assert.throws(() => shipped.readContainerConfig({ [shipped.CONTAINER_CONFIG_ENV]: foreign }, { required: true }), /contract/);
});
