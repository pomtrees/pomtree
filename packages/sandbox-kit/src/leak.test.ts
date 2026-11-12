import assert from "node:assert/strict";
import { test } from "node:test";
import { leakScan } from "./credential-channel.ts";

const TOKEN = ["POMTREE", "API", "TOKEN"].join("_");
const SENTINEL = "conformance-sentinel-abc123";

// Models what an adapter sends at create time.
const goodAdapterCreateEnv = (_secret: string) => ({ [`${TOKEN}_FILE`]: "/run/pomtree/secrets/token", CONFORMANCE_ENV_MARKER: "1" });
const wrongAdapterCreateEnv = (secret: string) => ({ [TOKEN]: secret, CONFORMANCE_ENV_MARKER: "1" });

test("a correct adapter's create-time env passes the scan", () => {
  leakScan({ createEnv: goodAdapterCreateEnv(SENTINEL), createArgs: ["run", "--rm"], labels: { "pomtree.host": "h1" }, sentinel: SENTINEL });
});

test("the scan fails against an adapter that puts the sentinel in create-time env, naming the cause and action but not the secret", () => {
  assert.throws(
    () => leakScan({ createEnv: wrongAdapterCreateEnv(SENTINEL), sentinel: SENTINEL }),
    (e: Error) => {
      assert.match(e.message, new RegExp(`create-time environment variable ${TOKEN}`));
      assert.match(e.message, /deliverCredential|proxy swap/);
      assert.equal(e.message.includes(SENTINEL), false);
      return true;
    },
  );
});

test("the scan fails when the sentinel is in an env name, an argument or a label", () => {
  assert.throws(() => leakScan({ createEnv: { [`X_${SENTINEL}`]: "1" }, sentinel: SENTINEL }), /environment variable X_<secret>/);
  assert.throws(() => leakScan({ createEnv: {}, createArgs: ["a", `--token=${SENTINEL}`], sentinel: SENTINEL }), /argument 1/);
  assert.throws(() => leakScan({ createEnv: {}, labels: { k: SENTINEL }, sentinel: SENTINEL }), /label k/);
});

test("an empty sentinel is refused rather than matching nothing", () => {
  assert.throws(() => leakScan({ createEnv: {}, sentinel: "" }), /empty sentinel/);
});
