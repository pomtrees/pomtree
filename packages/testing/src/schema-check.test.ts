import assert from "node:assert/strict";
import { test } from "node:test";
import { type Schema, assertSchema, checkSchema } from "./schema-check.ts";
import { e2bSandboxCreate } from "./provider-schemas/e2b-sandbox-create.ts";
import { kubernetesPodCreate } from "./provider-schemas/kubernetes-pod-create.ts";
import { kubernetesStatus } from "./provider-schemas/kubernetes-status.ts";

const validPod = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "sbx-1", labels: { app: "pomtree" } },
  spec: { restartPolicy: "Never", containers: [{ name: "main", image: "example/agent:1", command: ["sleep", "infinity"], env: [{ name: "A", value: "b" }] }] },
};

test("a valid body passes its vendored schema", () => {
  assert.deepEqual(checkSchema(validPod, kubernetesPodCreate), []);
  assert.deepEqual(
    checkSchema(
      { kind: "Status", apiVersion: "v1", status: "Failure", code: 404, reason: "NotFound", details: { causes: [{ reason: "x" }] } },
      kubernetesStatus,
    ),
    [],
  );
  assert.deepEqual(checkSchema({ templateID: "base", timeout: 60, metadata: { a: "b" } }, e2bSandboxCreate), []);
  assert.doesNotThrow(() => assertSchema(validPod, kubernetesPodCreate, "pod create"));
});

test("an extra field fails by name, at any depth (negative)", () => {
  const f = checkSchema({ ...validPod, bogusTop: 1 }, kubernetesPodCreate);
  assert.equal(f.length, 1);
  assert.equal(f[0]?.path, "$.bogusTop");
  assert.match(f[0]?.message ?? "", /unexpected field "bogusTop"/);
  const deep = checkSchema({ ...validPod, spec: { containers: [{ name: "m", image: "i", privileged: true }] } }, kubernetesPodCreate);
  assert.deepEqual(
    deep.map((x) => x.path),
    ["$.spec.containers[0].privileged"],
  );
  assert.throws(() => assertSchema({ ...validPod, bogusTop: 1 }, kubernetesPodCreate, "pod create"), /pod create.*\$\.bogusTop.*unexpected field "bogusTop"/s);
});

test("a missing required field fails by name (negative)", () => {
  const { metadata: _m, ...noMeta } = validPod;
  const f = checkSchema(noMeta, kubernetesPodCreate);
  assert.equal(f.length, 1);
  assert.equal(f[0]?.path, "$.metadata");
  assert.match(f[0]?.message ?? "", /missing required field "metadata"/);
  const nested = checkSchema({ ...validPod, spec: { containers: [{ name: "m" }] } }, kubernetesPodCreate);
  assert.deepEqual(
    nested.map((x) => x.path),
    ["$.spec.containers[0].image"],
  );
});

test("wrong type, enum and const mismatches each fail with the path", () => {
  assert.match(checkSchema({ templateID: 5 }, e2bSandboxCreate)[0]?.message ?? "", /expected type string but got integer/);
  assert.deepEqual(
    checkSchema({ ...validPod, spec: { restartPolicy: "Sometimes", containers: [] } }, kubernetesPodCreate).map((x) => x.path),
    ["$.spec.restartPolicy"],
  );
  assert.deepEqual(
    checkSchema({ ...validPod, kind: "Deployment" }, kubernetesPodCreate).map((x) => x.path),
    ["$.kind"],
  );
  assert.match(checkSchema({ templateID: "t", timeout: 1.5 }, e2bSandboxCreate)[0]?.message ?? "", /expected type integer but got number/);
});

test("a schema keyword outside the subset is rejected by name rather than ignored (negative)", () => {
  const f = checkSchema({ a: "x" }, { type: "object", properties: { a: { type: "string", pattern: "^y$" } as Schema } });
  assert.equal(f.length, 1);
  assert.match(f[0]?.message ?? "", /schema keyword "pattern" is outside the supported subset/);
});

test("a field named like an inherited member is judged as an own field (negative)", () => {
  const strict: Schema = { type: "object", additionalProperties: false, properties: { a: { type: "string" } } };
  const extra = checkSchema(JSON.parse('{"a":"x","constructor":1,"toString":2}'), strict);
  assert.deepEqual(extra.map((x) => x.path).sort(), ["$.constructor", "$.toString"]);
  const missing = checkSchema({}, { type: "object", required: ["toString"] });
  assert.deepEqual(
    missing.map((x) => x.path),
    ["$.toString"],
  );
  assert.match(missing[0]?.message ?? "", /missing required field "toString"/);
});

test("const and enum compare objects regardless of key order, and name the action on mismatch", () => {
  assert.deepEqual(checkSchema({ b: 2, a: 1 }, { const: { a: 1, b: 2 } }), []);
  assert.deepEqual(checkSchema({ b: 2, a: 1 }, { enum: [{ a: 1, b: 2 }] }), []);
  const f = checkSchema({ a: 1 }, { const: { a: 2 } });
  assert.equal(f.length, 1);
  assert.match(f[0]?.message ?? "", /fix the body|change the schema/);
  assert.match(checkSchema("x", { enum: ["y"] })[0]?.message ?? "", /use a documented value or add this one to the schema/);
});

test("a lenient response schema accepts extra fields but still requires the fields the adapter reads", () => {
  const body = { kind: "Status", apiVersion: "v1", status: "Failure", futureField: 1, details: { extra: true } };
  assert.deepEqual(checkSchema(body, kubernetesStatus), []);
  const { status: _s, ...noStatus } = body;
  assert.deepEqual(
    checkSchema(noStatus, kubernetesStatus).map((x) => x.path),
    ["$.status"],
  );
});
