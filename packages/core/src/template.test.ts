import assert from "node:assert/strict";
import test from "node:test";
import { dispositionError, templateDigest } from "./template.ts";
import { CODE_TEMPLATE } from "./types.ts";

test("templateDigest is stable under key order and ignores undefined", () => {
  const a = templateDigest({ id: "t", cpus: 2, runtime: { a: 1, b: 2 } });
  const b = templateDigest({ runtime: { b: 2, a: 1 }, cpus: 2, id: "t", model: undefined });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("templateDigest changes with content", () => {
  assert.notEqual(templateDigest(CODE_TEMPLATE), templateDigest({ ...CODE_TEMPLATE, resume: "task" }));
});

test("templateDigest binds the workspace disk quota", () => {
  const base = { id: "t", diskBytes: 1024 } as const;
  assert.notEqual(templateDigest(base), templateDigest({ ...base, diskBytes: 2048 }));
});

test("templateDigest binds browser limits", () => {
  const base = { id: "t", browser: { maxSteps: 10, maxMs: 5000 } } as const;
  assert.notEqual(templateDigest(base), templateDigest({ ...base, browser: { maxSteps: 11, maxMs: 5000 } }));
  assert.notEqual(templateDigest(base), templateDigest({ id: "t" }));
});

test("dispositionError accepts hold, hold with a ttl, and reap-on-exit", () => {
  assert.equal(dispositionError({ mode: "hold" }), null);
  assert.equal(dispositionError({ mode: "hold", ttlMs: 60_000 }), null);
  assert.equal(dispositionError({ mode: "reap-on-exit" }), null);
});

test("dispositionError refuses a bad shape, an unknown mode, a bad ttlMs, and ttlMs with reap-on-exit", () => {
  assert.match(dispositionError("hold") ?? "", /must be an object/);
  assert.match(dispositionError(null) ?? "", /must be an object/);
  assert.match(dispositionError({ mode: "keep" }) ?? "", /disposition\.mode must be "hold" or "reap-on-exit"/);
  assert.match(dispositionError({}) ?? "", /disposition\.mode/);
  for (const ttlMs of [0, -1, 1.5, Number.NaN, "5", Number.MAX_SAFE_INTEGER + 1])
    assert.match(dispositionError({ mode: "hold", ttlMs }) ?? "", /ttlMs must be a positive safe integer/, String(ttlMs));
  assert.match(dispositionError({ mode: "reap-on-exit", ttlMs: 1000 }) ?? "", /ttlMs applies only to mode hold/);
});
