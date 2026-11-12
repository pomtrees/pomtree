import assert from "node:assert/strict";
import { test } from "node:test";
import { createBody, fingerprint, labelProblem, listPath, parseRecord, sandboxPath, toListing } from "./wire.mts";

const spec = (extra: object = {}) => ({ agent: "a1", image: "img", env: { B: "2", A: "1" }, mounts: [], ...extra });

test("labelProblem refuses a malformed name and the reserved pomtree prefix, and accepts ordinary labels", () => {
  assert.match(labelProblem({ "has space": "v" }) ?? "", /is not \[A-Za-z0-9_.-\]\+/);
  assert.match(labelProblem({ "": "v" }) ?? "", /is not/);
  assert.match(labelProblem({ "pomtree.owner": "v" }) ?? "", /reserved/);
  assert.match(labelProblem({ PomTree_x: "v" }) ?? "", /reserved/);
  assert.equal(labelProblem({ store_id: "s", daemon_epoch: "1" }), null);
  assert.equal(labelProblem(undefined), null);
});

test("createBody is deterministic: key order does not change the bytes, so a retry matches the provider's fingerprint", () => {
  const a = createBody("n", spec());
  const b = createBody("n", spec({ env: { A: "1", B: "2" } }));
  assert.equal(a, b);
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint(createBody("n", spec({ env: { A: "changed" } }))), "a different spec has a different fingerprint");
  assert.deepEqual(JSON.parse(a), { name: "n", agent: "a1", image: "img", env: { A: "1", B: "2" }, cmd: null, labels: {} });
});

test("paths encode the sandbox name and carry the owner filter", () => {
  assert.equal(sandboxPath("a/b", "wait"), "/v1/sandboxes/a%2Fb/wait");
  assert.equal(listPath({ host: "h", storeId: "s 1", epoch: 3 }), "/v1/sandboxes?storeId=s+1&maxEpoch=3");
});

test("parseRecord refuses a malformed record with the action, and toListing omits empty labels and reports no host or generation", () => {
  assert.throws(() => parseRecord({ name: "n" }), /malformed sandbox record.*sandbox\.loopback\.baseUrl/);
  const rec = parseRecord({ name: "n", agent: "a", image: "i", state: "preempted", exitCode: null, labels: {}, fingerprint: "f" });
  assert.deepEqual(toListing(rec), { id: "n", agent: "a", backend: "loopback", host: null, generation: null, state: "unknown" });
  assert.deepEqual(toListing({ ...rec, state: "running", labels: { k: "v" } }).labels, { k: "v" });
});
