import assert from "node:assert/strict";
import test from "node:test";
import {
  checkAgentSandboxBackend,
  checkStateExpectRev,
  checkStateKey,
  checkStateListPrefix,
  checkStateOwner,
  checkStatePrefix,
  checkStateRemove,
  checkStateWriter,
  clampStateLimits,
  clampStateListLimit,
  encodeStateValue,
  fenceSandboxBackend,
  sandboxBackendAfter,
  parseStateLimits,
  STATE_DOC_BYTES_CONFIG_MAX,
  STATE_LIMITS_DEFAULT,
  STATE_LIST_LIMIT_MAX,
  STATE_TOMBSTONES_CEILING,
  STATE_VALUE_MAX_DEPTH,
  SandboxBackendMismatchError,
  StateError,
} from "./index.ts";

const kind = (fn: () => void): string => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof StateError, String(e));
    return e.kind;
  }
  return "none";
};
const nest = (depth: number): unknown => {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
};

test("owner, key and prefix checks accept the documented shapes and refuse the rest, including prototype-pollution names", () => {
  for (const o of ["operator", "hn-digest", "a_b", "0x"])
    assert.equal(
      kind(() => checkStateOwner(o)),
      "none",
      o,
    );
  for (const o of ["", "Bad", "-x", "a/b", "__proto__", "a".repeat(129), 5, null, undefined])
    assert.equal(
      kind(() => checkStateOwner(o)),
      "invalid-key",
      String(o),
    );
  for (const k of ["a", "a.b-c_d/e", "x".repeat(128)])
    assert.equal(
      kind(() => checkStateKey(k)),
      "none",
      k,
    );
  for (const k of ["", "__proto__", "constructor/__proto__", "a/../b", "a..b", "A", "/a", "a/", "x".repeat(129), 1, undefined]) {
    assert.equal(
      kind(() => checkStateKey(k)),
      "invalid-key",
      String(k),
    );
  }
  for (const p of ["a", "memo/", "a/b.c", "-x", "x".repeat(128)])
    assert.equal(
      kind(() => checkStatePrefix(p)),
      "none",
      p,
    );
  for (const p of ["", "..", "a/..", "A", "a b", "x".repeat(129), null, undefined])
    assert.equal(
      kind(() => checkStatePrefix(p)),
      "invalid-key",
      String(p),
    );
  assert.equal(
    kind(() => checkStateListPrefix(undefined)),
    "none",
  );
  assert.equal(
    kind(() => checkStateListPrefix("")),
    "none",
  );
  assert.equal(
    kind(() => checkStateListPrefix("A")),
    "invalid-key",
  );
});

test("expectRev is null, undefined or a non-negative safe integer", () => {
  for (const e of [undefined, null, 0, 1, 99])
    assert.equal(
      kind(() => checkStateExpectRev(e)),
      "none",
    );
  for (const e of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", 2 ** 60])
    assert.equal(
      kind(() => checkStateExpectRev(e)),
      "invalid-value",
      String(e),
    );
});

test("remove mode rules: exactly one of key/prefix, expectRev only with key, olderThanMs only with prefix", () => {
  const o = "o";
  for (const r of [{ key: "a" }, { key: "a", expectRev: 2 }, { prefix: "m/" }, { prefix: "m/", olderThanMs: 0 }])
    assert.equal(
      kind(() => checkStateRemove({ owner: o, ...r })),
      "none",
    );
  for (const r of [{}, { key: "a", prefix: "a" }, { prefix: "a/", expectRev: 1 }, { key: "a", olderThanMs: 1 }, { prefix: "" }, { key: "A" }]) {
    assert.equal(
      kind(() => checkStateRemove({ owner: o, ...r })),
      "invalid-key",
      JSON.stringify(r),
    );
  }
  for (const r of [
    { key: "a", expectRev: -1 },
    { key: "a", expectRev: null as never }, // a removal has no create reading: null could never match
    { prefix: "a", olderThanMs: -1 },
    { prefix: "a", olderThanMs: Number.NaN },
  ]) {
    assert.equal(
      kind(() => checkStateRemove({ owner: o, ...r })),
      "invalid-value",
      JSON.stringify(r),
    );
  }
  assert.equal(
    kind(() => checkStateRemove({ owner: "Bad", key: "a" })),
    "invalid-key",
  );
});

test("list limit clamps to 1..max and defaults to max", () => {
  assert.equal(clampStateListLimit(undefined), STATE_LIST_LIMIT_MAX);
  assert.equal(clampStateListLimit(Number.NaN), STATE_LIST_LIMIT_MAX);
  assert.equal(clampStateListLimit(0), 1);
  assert.equal(clampStateListLimit(-5), 1);
  assert.equal(clampStateListLimit(7.9), 7);
  assert.equal(clampStateListLimit(10_000), STATE_LIST_LIMIT_MAX);
});

test("encodeStateValue: canonical key order, UTF-8 byte length, strict JSON only", () => {
  const { json, bytes } = encodeStateValue({ b: 1, a: { d: 1, c: "é" } });
  assert.equal(json, '{"a":{"c":"é","d":1},"b":1}');
  assert.equal(bytes, Buffer.byteLength(json));
  assert.ok(bytes > json.length, "multi-byte characters count by bytes");
  for (const v of [null, true, 0, "s", [], {}, [1, { x: [null] }]])
    assert.equal(
      kind(() => void encodeStateValue(v)),
      "none",
    );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const cyclicArray: unknown[] = [];
  cyclicArray.push(cyclicArray);
  for (const v of [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    () => 1,
    Symbol("s"),
    1n,
    cyclic,
    cyclicArray,
    { u: undefined },
    [undefined],
    new Date(),
    new Map(),
    Object.create({ inherited: 1 }),
  ]) {
    assert.equal(
      kind(() => void encodeStateValue(v)),
      "invalid-value",
      String(typeof v),
    );
  }
});

test("encodeStateValue depth: 64 levels pass, 65 fail", () => {
  assert.equal(
    kind(() => void encodeStateValue(nest(STATE_VALUE_MAX_DEPTH))),
    "none",
  );
  assert.equal(
    kind(() => void encodeStateValue(nest(STATE_VALUE_MAX_DEPTH + 1))),
    "invalid-value",
  );
});

test("encodeStateValue: a __proto__ own key is data, never a prototype change", () => {
  const v = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
  const { json } = encodeStateValue(v);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const back = JSON.parse(json) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(back), Object.prototype);
  assert.deepEqual(Object.keys(back).sort(), ["__proto__", "a"]);
});

test("writer is exactly the operator, a full agent shape or a workflow shape", () => {
  for (const w of [
    { operator: true },
    { agent: "a1", host: "h", generation: 0 },
    { agent: "a1", host: "h", generation: 7 },
    { workflow: "fin/desk", instance: "daily" },
    { workflow: "fin/desk", instance: "" },
  ])
    assert.equal(
      kind(() => checkStateWriter(w)),
      "none",
      JSON.stringify(w),
    );
  for (const w of [
    undefined,
    null,
    "operator",
    [],
    {},
    { operator: false },
    { operator: 1 },
    { operator: true, agent: "a" },
    { agent: "a", host: "h" },
    { agent: "", host: "h", generation: 1 },
    { agent: "a", host: "h", generation: -1 },
    { agent: "a", host: "h", generation: 1.5 },
    { agent: "a", host: "h", generation: "1" },
    { agent: "a", host: "h", generation: 1, extra: 1 },
    { workflow: "fin/desk" },
    { workflow: "desk", instance: "" },
    { workflow: "fin/desk/x", instance: "" },
    { workflow: "fin/desk", instance: "Bad" },
    { workflow: "fin/desk", instance: 1 },
    { workflow: "fin/desk", instance: "", agent: "a1" },
    { workflow: "fin/desk", instance: "", operator: true },
  ]) {
    assert.equal(
      kind(() => checkStateWriter(w)),
      "invalid-value",
      JSON.stringify(w),
    );
  }
});

test("limit clamps: maxDocBytes and maxTombstones may only be lower than their ceilings", () => {
  const big = { ...STATE_LIMITS_DEFAULT, maxDocBytes: 2 ** 40, maxTombstones: 2 ** 40 };
  assert.equal(clampStateLimits(big).maxDocBytes, STATE_DOC_BYTES_CONFIG_MAX);
  assert.equal(clampStateLimits(big).maxTombstones, STATE_TOMBSTONES_CEILING);
  assert.deepEqual(clampStateLimits(STATE_LIMITS_DEFAULT), STATE_LIMITS_DEFAULT);
});

test("parseStateLimits (shared by pomtreed and standalone tools): defaults, owner overrides, clamps and refusals", () => {
  assert.deepEqual(parseStateLimits().limitsFor("any"), STATE_LIMITS_DEFAULT);
  const p = parseStateLimits('{"default":{"maxDocs":5},"owners":{"hn":{"maxTombstones":0,"maxDocBytes":99999999999}}}');
  assert.equal(p.limitsFor("x").maxDocs, 5);
  assert.deepEqual(p.owners, ["hn"]);
  assert.deepEqual(p.limitsFor("hn"), { ...STATE_LIMITS_DEFAULT, maxDocs: 5, maxTombstones: 0, maxDocBytes: STATE_DOC_BYTES_CONFIG_MAX });
  for (const bad of [
    "{",
    "[]",
    '{"x":1}',
    '{"default":{"maxDocs":0}}',
    '{"default":{"maxTombstones":-1}}',
    '{"default":{"nope":1}}',
    '{"owners":{"Bad Owner":{}}}',
  ])
    assert.throws(() => parseStateLimits(bad), /POMTREED_STATE_LIMITS/, bad);
});

test("checkAgentSandboxBackend accepts null and a backend id, and rejects missing, empty and malformed values", () => {
  assert.equal(checkAgentSandboxBackend("a", null), null);
  assert.equal(checkAgentSandboxBackend("a", "docker"), "docker");
  for (const bad of [undefined, "", "Docker", "e2b:prod", "-x", 7, {}]) {
    assert.throws(() => checkAgentSandboxBackend("a1", bad), /agent a1 has an invalid sandbox backend.*move the database file aside and restart/, String(bad));
  }
});

test("fenceSandboxBackend keeps the first backend and refuses a different one with the exact message", () => {
  assert.equal(fenceSandboxBackend({ sandbox: null, sandboxBackend: null }, "docker"), "docker");
  assert.equal(fenceSandboxBackend({ sandbox: "s1", sandboxBackend: "docker" }, "docker"), "docker");
  assert.throws(
    () => fenceSandboxBackend({ sandbox: "s1", sandboxBackend: "docker" }, "podman"),
    (e: unknown) =>
      e instanceof SandboxBackendMismatchError &&
      e.recorded === "docker" &&
      e.selected === "podman" &&
      e.sandbox === "s1" &&
      e.message ===
        "agent record (sandbox s1) was created under backend docker; the selected backend is podman; the agent is held: select docker again (sandbox.backend), or run `pomtree abandon <agent>`",
  );
  assert.throws(
    () => fenceSandboxBackend({ sandbox: null, sandboxBackend: null }, null as unknown as string),
    (e: unknown) => e instanceof Error && /the selected sandbox backend null is not a backend id/.test(e.message) && !/database/.test(e.message),
  );
});

test("sandboxBackendAfter pins the backend while a sandbox is held and clears it with the sandbox", () => {
  const none = { sandbox: null, sandboxBackend: null };
  const held = { sandbox: "s1", sandboxBackend: "docker" };
  assert.equal(sandboxBackendAfter(none, "s1", "docker"), "docker", "the first start records it");
  assert.equal(sandboxBackendAfter(held, "s1", "docker"), "docker", "the same backend is idempotent");
  assert.equal(sandboxBackendAfter(held, "s2", undefined), "docker", "a sandbox set without a backend keeps the pin");
  assert.equal(sandboxBackendAfter(held, null, undefined), null, "clearing the sandbox clears the pin");
  assert.equal(
    sandboxBackendAfter(sandboxBackendAfter(held, null, undefined) === null ? none : held, "s3", "podman"),
    "podman",
    "a cleared run can start under another backend",
  );
  assert.throws(() => sandboxBackendAfter(held, "s2", "podman"), SandboxBackendMismatchError);
  assert.throws(() => sandboxBackendAfter(held, null, "docker"), /pass the sandbox id too, or omit the backend/);
});
