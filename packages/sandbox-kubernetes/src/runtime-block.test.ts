import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeBlockError, parseRuntimeBlock } from "./runtime-block.ts";

const known = ["gvisor", "kata-qemu"];

test("runtime block: absent or empty means no placement policy", () => {
  assert.deepEqual(parseRuntimeBlock(undefined), {});
  assert.deepEqual(parseRuntimeBlock(null), {});
  assert.deepEqual(parseRuntimeBlock({}), {});
});

test("runtime block: a declared class that the cluster has is selected", () => {
  assert.deepEqual(parseRuntimeBlock({ runtimeClassName: "gvisor" }, { knownRuntimeClasses: known }), { runtimeClassName: "gvisor" });
  assert.deepEqual(parseRuntimeBlock({ runtimeClassName: "kata-qemu" }, { knownRuntimeClasses: known }), { runtimeClassName: "kata-qemu" });
});

test("runtime block: an unknown class is refused with cause and action", () => {
  assert.throws(
    () => parseRuntimeBlock({ runtimeClassName: "firecracker" }, { knownRuntimeClasses: known }),
    (e: Error) =>
      e instanceof RuntimeBlockError &&
      /"firecracker" was not found/.test(e.message) &&
      /gvisor, kata-qemu/.test(e.message) &&
      /install the RuntimeClass or fix/.test(e.message),
  );
});

test("runtime block: with no known classes every class is refused (fail closed)", () => {
  assert.throws(() => parseRuntimeBlock({ runtimeClassName: "gvisor" }), RuntimeBlockError);
  assert.throws(() => parseRuntimeBlock({ runtimeClassName: "gvisor" }, { knownRuntimeClasses: [] }), /known: none/);
});

test("runtime block: a malformed class name is refused before the lookup", () => {
  for (const bad of ["Gvisor", "has space", "", 5, "a".repeat(254)]) {
    assert.throws(() => parseRuntimeBlock({ runtimeClassName: bad }, { knownRuntimeClasses: [String(bad)] }), RuntimeBlockError, String(bad));
  }
});

test("runtime block: unknown keys are refused, including pod-spec keys that would weaken the floor", () => {
  for (const key of ["privileged", "hostNetwork", "securityContext", "volumes", "containers", "serviceAccountName"]) {
    assert.throws(
      () => parseRuntimeBlock({ [key]: true }),
      (e: Error) => e instanceof RuntimeBlockError && e.message.includes(`"${key}"`) && /allowed: runtimeClassName/.test(e.message),
      key,
    );
  }
});

test("runtime block: nodeSelector, tolerations and priorityClassName are validated and normalized", () => {
  const out = parseRuntimeBlock({
    nodeSelector: { "topology.kubernetes.io/zone": "a", pool: "sandbox" },
    tolerations: [{ key: "sandbox", operator: "Equal", value: "true", effect: "NoSchedule" }, { operator: "Exists" }],
    priorityClassName: "pomtree-low",
  });
  assert.deepEqual(Object.keys(out.nodeSelector ?? {}), ["pool", "topology.kubernetes.io/zone"]);
  assert.equal(out.tolerations?.length, 2);
  assert.equal(out.priorityClassName, "pomtree-low");
});

test("runtime block: bad placement values are refused", () => {
  const bad: unknown[] = [
    { nodeSelector: "pool=sandbox" },
    { nodeSelector: { "bad key!": "v" } },
    { nodeSelector: { pool: 3 } },
    { nodeSelector: { pool: "x".repeat(64) } },
    { tolerations: {} },
    { tolerations: [{ key: "k", effect: "Evict" }] },
    { tolerations: [{ key: "k", operator: "Exists", value: "v" }] },
    { tolerations: [{ operator: "Equal" }] },
    { tolerations: [{ key: "k", tolerationSeconds: -1 }] },
    { tolerations: [{ key: "k", extra: 1 }] },
    { priorityClassName: "Not Valid" },
  ];
  for (const b of bad) assert.throws(() => parseRuntimeBlock(b), RuntimeBlockError, JSON.stringify(b));
  assert.throws(() => parseRuntimeBlock("gvisor"), RuntimeBlockError);
  assert.throws(() => parseRuntimeBlock([]), RuntimeBlockError);
});
