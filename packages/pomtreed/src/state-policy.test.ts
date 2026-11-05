import { STATE_DOC_BYTES_CEILING, STATE_DOC_BYTES_CONFIG_MAX, STATE_LIMITS_DEFAULT, STATE_TOMBSTONES_CEILING } from "@pomtree/core";
import type { AgentId, AgentRecord } from "@pomtree/core";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type StateGrant,
  type StateGrants,
  type StatePrincipal,
  type StateVerb,
  effectiveGrants,
  grantKeyOf,
  grantSubset,
  grantedOwners,
  intersectGrants,
  mayState,
  parseStateGrants,
  parseStateLimits,
  StatePolicy,
  stateOpPayload,
} from "./state-policy.ts";

const rec = (fields: Record<string, unknown>): AgentRecord => fields as unknown as AgentRecord;

test("parseStateGrants accepts driver and template keys and defaults to an empty map", () => {
  assert.equal(parseStateGrants().size, 0);
  const m = parseStateGrants('{"ext/wf":[{"owner":"a","prefix":"memo/","mode":"rw"}],"tmpl":[{"owner":"a","mode":"r"}]}');
  assert.deepEqual(m.get("ext/wf"), [{ owner: "a", prefix: "memo/", mode: "rw" }]);
  assert.deepEqual(m.get("tmpl"), [{ owner: "a", mode: "r" }]);
});

test("parseStateGrants rejects malformed configuration", () => {
  const bad = [
    "{not json",
    "[]",
    "null",
    '"x"',
    '{"BAD KEY!":[]}',
    '{"ext/wf":{}}',
    '{"ext/wf":[{"owner":"a","mode":"r","extra":1}]}',
    '{"ext/wf":["a"]}',
    '{"ext/wf":[{"owner":"A","mode":"r"}]}',
    '{"ext/wf":[{"owner":"a/b","mode":"r"}]}',
    '{"ext/wf":[{"owner":"a","mode":"x"}]}',
    '{"ext/wf":[{"owner":"a"}]}',
    '{"tmpl":[{"owner":"a","mode":"rw"}]}',
    '{"ext/wf":[{"owner":"a","prefix":"../x","mode":"r"}]}',
    '{"ext/wf":[{"owner":"a","prefix":"","mode":"r"}]}',
    '{"ext/wf":[{"owner":"a","prefix":5,"mode":"r"}]}',
  ];
  for (const raw of bad) assert.throws(() => parseStateGrants(raw), `expected rejection: ${raw}`);
});

test("parseStateLimits merges defaults, per-owner overrides and clamps maxDocBytes and maxTombstones to their ceilings", () => {
  const none = parseStateLimits();
  assert.deepEqual(none.limitsFor("anyone"), STATE_LIMITS_DEFAULT);
  assert.deepEqual(none.owners, []);

  const l = parseStateLimits(
    JSON.stringify({ default: { maxDocs: 5 }, owners: { a: { maxOwnerBytes: 99 }, b: { maxDocBytes: STATE_DOC_BYTES_CEILING * 4 } } }),
  );
  assert.deepEqual(l.limitsFor("a"), { ...STATE_LIMITS_DEFAULT, maxDocs: 5, maxOwnerBytes: 99 });
  assert.equal(l.limitsFor("b").maxDocBytes, STATE_DOC_BYTES_CONFIG_MAX);
  assert.ok(STATE_DOC_BYTES_CONFIG_MAX < STATE_DOC_BYTES_CEILING);
  assert.equal(parseStateLimits('{"default":{"maxTombstones":0}}').limitsFor("x").maxTombstones, 0);
  assert.equal(parseStateLimits('{"default":{"maxTombstones":99999999}}').limitsFor("x").maxTombstones, STATE_TOMBSTONES_CEILING);
  assert.equal(l.limitsFor("b").maxDocs, 5);
  assert.deepEqual(l.limitsFor("c"), { ...STATE_LIMITS_DEFAULT, maxDocs: 5 });
  assert.deepEqual(l.owners.sort(), ["a", "b"]);

  const low = parseStateLimits('{"default":{"maxDocBytes":10}}');
  assert.equal(low.limitsFor("x").maxDocBytes, 10);
});

test("parseStateLimits rejects non-positive, non-integer, unknown and malformed entries", () => {
  const bad = [
    "[]",
    "{nope",
    '{"extra":{}}',
    '{"default":{"maxDocs":0}}',
    '{"default":{"maxDocs":-1}}',
    '{"default":{"maxDocs":1.5}}',
    '{"default":{"maxDocs":"3"}}',
    '{"default":{"unknown":3}}',
    '{"default":[]}',
    '{"owners":[]}',
    '{"owners":{"Bad Name":{"maxDocs":2}}}',
    '{"owners":{"a":{"maxOwnerBytes":0}}}',
  ];
  for (const raw of bad) assert.throws(() => parseStateLimits(raw), `expected rejection: ${raw}`);
});

test("parseStateGrants refuses an rw grant whose prefix overlaps the workflow-shared scope ext/s/, naming the key and the fix", () => {
  for (const prefix of ["ext/s/", "ext/s/board/", "ext/s", "ext/", "e"]) {
    const raw = JSON.stringify({ "fin/desk": [{ owner: "fin", prefix, mode: "rw" }] });
    assert.throws(
      () => parseStateGrants(raw),
      (e: unknown) =>
        e instanceof Error &&
        e.message.includes("POMTREED_STATE_GRANTS: fin/desk holds rw on fin") &&
        e.message.includes("ext/s/") &&
        e.message.includes('grant "r" or a prefix outside ext/s/'),
      prefix,
    );
  }
  // Reads there stay allowed (they forge nothing), as do rw grants beside the scope and a whole-owner rw grant (the route still
  // refuses every agent write under ext/s/, state-routes.test.ts).
  const ok = parseStateGrants(
    JSON.stringify({
      "fin/desk": [
        { owner: "fin", prefix: "ext/s/", mode: "r" },
        { owner: "fin", prefix: "ext/sx", mode: "rw" },
        { owner: "fin", prefix: "memo/", mode: "rw" },
        { owner: "fin", mode: "rw" },
      ],
      tmpl: [{ owner: "fin", prefix: "ext/s/board/", mode: "r" }],
    }),
  );
  assert.equal(ok.get("fin/desk")?.length, 4);
  assert.equal(ok.get("tmpl")?.length, 1);
});

test("grant algebra: owner mismatch, prefix narrowing and mode ordering", () => {
  const a: StateGrants = [{ owner: "a", prefix: "memo", mode: "rw" }];
  assert.equal(grantSubset([{ owner: "b", mode: "r" }], a), false, "owner mismatch");
  assert.equal(grantSubset([{ owner: "a", prefix: "memo/x", mode: "rw" }], a), true, "narrower prefix");
  assert.equal(grantSubset([{ owner: "a", prefix: "memory/", mode: "r" }], a), true, "memo covers memory/");
  assert.equal(grantSubset([{ owner: "a", mode: "r" }], a), false, "whole owner is wider than prefix");
  assert.equal(grantSubset([{ owner: "a", prefix: "x", mode: "r" }], a), false, "disjoint prefix");
  assert.equal(grantSubset([{ owner: "a", prefix: "memo", mode: "r" }], [{ owner: "a", prefix: "memo", mode: "r" }]), true);
  assert.equal(grantSubset([{ owner: "a", prefix: "memo", mode: "rw" }], [{ owner: "a", prefix: "memo", mode: "r" }]), false, "rw exceeds r");
  assert.equal(grantSubset([], a), true, "empty child is a subset of anything");
  assert.equal(grantSubset([], []), true);
  assert.equal(grantSubset([{ owner: "a", mode: "r" }], []), false, "empty parent covers nothing");
});

test("intersectGrants keeps the narrower prefix and lower mode, drops disjoint prefixes and other owners", () => {
  const out = intersectGrants(
    [
      { owner: "a", prefix: "memo", mode: "rw" },
      { owner: "a", prefix: "x", mode: "rw" },
      { owner: "b", mode: "rw" },
    ],
    [{ owner: "a", prefix: "memo/x", mode: "r" }],
  );
  assert.deepEqual(out, [{ owner: "a", prefix: "memo/x", mode: "r" }]);
  assert.deepEqual(intersectGrants([{ owner: "a", mode: "rw" }], [{ owner: "a", prefix: "k", mode: "rw" }]), [{ owner: "a", prefix: "k", mode: "rw" }]);
  assert.deepEqual(intersectGrants([{ owner: "a", mode: "rw" }], []), []);
});

test("mayState: operator allows everything, verbs and prefixes are checked against grants", () => {
  assert.equal(mayState({ operator: true }, "write", "anyone", "any/key"), true);
  const p: StatePrincipal = { grants: [{ owner: "a", prefix: "memo/", mode: "r" }] };
  assert.equal(mayState(p, "read", "a", "memo/x"), true, "read verb allowed by r");
  assert.equal(mayState(p, "write", "a", "memo/x"), false, "write needs rw");
  assert.equal(mayState(p, "read", "a", "other"), false, "key outside prefix");
  assert.equal(mayState(p, "read", "a", "memo"), false, "prefix argument wider than the grant");
  assert.equal(mayState(p, "read", "a", "memo/"), true, "prefix argument wholly inside the grant");
  assert.equal(mayState(p, "read", "b", "memo/x"), false, "owner mismatch");
  assert.equal(mayState({ grants: [] }, "read", "a", ""), false, "default deny");
  assert.equal(mayState({ grants: [{ owner: "a", mode: "rw" }] }, "write", "a", ""), true);
});

test("grantedOwners lists owners with grants, or all for the operator", () => {
  assert.equal(grantedOwners({ operator: true }), "all");
  assert.deepEqual(
    grantedOwners({
      grants: [
        { owner: "b", mode: "r" },
        { owner: "a", mode: "r" },
        { owner: "b", prefix: "x", mode: "rw" },
      ],
    }),
    ["a", "b"],
  );
  assert.deepEqual(grantedOwners({ grants: [] }), []);
});

// Deterministic PRNG (mulberry32) so the property run is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("grant algebra properties hold over seeded random grants", () => {
  const rnd = mulberry32(0xc0ffee);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const owners = ["a", "b"];
  const prefixes = ["", "m", "me", "memo/", "x/"];
  const modes: StateGrant["mode"][] = ["r", "rw"];
  const verbs: StateVerb[] = ["read", "write"];
  const keys = ["", "m", "memo", "memo/x", "memory/y", "x/z", "x/", "q"];
  const randGrants = (): StateGrant[] => {
    const n = Math.floor(rnd() * 4);
    return Array.from({ length: n }, () => {
      const prefix = pick(prefixes);
      return { owner: pick(owners), ...(prefix !== "" && { prefix }), mode: pick(modes) };
    });
  };

  for (let i = 0; i < 500; i++) {
    const a = randGrants();
    const b = randGrants();
    const c = randGrants();
    assert.equal(grantSubset(a, a), true, `reflexive ${JSON.stringify(a)}`);
    const meet = intersectGrants(a, b);
    assert.equal(grantSubset(meet, a), true, `meet <= a ${JSON.stringify([a, b])}`);
    assert.equal(grantSubset(meet, b), true, `meet <= b ${JSON.stringify([a, b])}`);
    if (grantSubset(a, b) && grantSubset(b, c)) {
      assert.equal(grantSubset(a, c), true, `transitive ${JSON.stringify([a, b, c])}`);
    }
    if (grantSubset(c, a)) {
      for (const v of verbs)
        for (const o of [...owners, "operator"])
          for (const k of keys) {
            if (mayState({ grants: c }, v, o, k)) assert.equal(mayState({ grants: a }, v, o, k), true, `monotone ${JSON.stringify([c, a, v, o, k])}`);
          }
    }
  }
});

const root = rec({ id: "root", parent: null, executor: "container", spec: { template: "t0" } });
const mk = (id: string, parent: AgentId | null, executor: string, spec: unknown): AgentRecord => rec({ id, parent, executor, spec });

test("grantKeyOf keys deterministic agents by driver and container agents by template or code", () => {
  assert.equal(grantKeyOf(mk("d", "x", "deterministic", { driver: "ext/wf", input: {} })), "ext/wf");
  assert.equal(grantKeyOf(mk("c", "x", "container", { template: "t1" })), "t1");
  assert.equal(grantKeyOf(mk("c2", "x", "container", {})), "code");
});

test("effectiveGrants intersects a delegate's grants with its non-root ancestors", async () => {
  const grantsFor = (key: string): StateGrants => {
    if (key === "ext/wf") return [{ owner: "a", prefix: "memo/", mode: "rw" }];
    if (key === "t1")
      return [
        { owner: "a", mode: "rw" },
        { owner: "b", mode: "r" },
      ];
    return [];
  };
  const child = mk("child", "par", "container", { template: "t1" });
  const parent = mk("par", "root", "deterministic", { driver: "ext/wf", input: {} });
  const records = new Map<AgentId, AgentRecord>([
    ["root", root],
    ["par", parent],
    ["child", child],
  ]);
  const get = async (id: AgentId) => records.get(id) ?? null;

  const rootOwn = (key: string): StateGrants => (key === "t0" ? [{ owner: "r", mode: "rw" }] : grantsFor(key));
  assert.deepEqual(await effectiveGrants(rootOwn, root, get), [{ owner: "r", mode: "rw" }], "root does not narrow its own grants");

  const eff = await effectiveGrants(grantsFor, child, get);
  assert.deepEqual(eff, [{ owner: "a", prefix: "memo/", mode: "rw" }]);

  const direct = mk("direct", "root", "container", { template: "t1" });
  assert.deepEqual(
    await effectiveGrants(grantsFor, direct, get),
    [
      { owner: "a", mode: "rw" },
      { owner: "b", mode: "r" },
    ],
    "root parent does not narrow",
  );
});

test("effectiveGrants fails closed on a missing ancestor and on a runaway chain", async () => {
  const grantsFor = (): StateGrants => [{ owner: "a", mode: "rw" }];
  const orphan = mk("orphan", "ghost", "container", { template: "t1" });
  assert.deepEqual(await effectiveGrants(grantsFor, orphan, async () => null), []);

  const records = new Map<AgentId, AgentRecord>();
  for (let i = 0; i < 70; i++) {
    const parent = i === 69 ? null : `n${i + 1}`;
    records.set(`n${i}`, mk(`n${i}`, parent, "deterministic", { driver: "ext/wf", input: {} }));
  }
  const deep = records.get("n0") as AgentRecord;
  assert.deepEqual(await effectiveGrants(grantsFor, deep, async (id) => records.get(id) ?? null), []);
});

test("StatePolicy.validate rejects unknown owners, drivers, templates and limit owners", async () => {
  const known = {
    owners: ["a"],
    drivers: ["ext/wf"],
    template: async (id: string) => (id === "tmpl" ? { id } : null),
  };
  const ok = async (grants: string, limits?: string) => new StatePolicy(grants, limits).validate(known);

  await ok('{"ext/wf":[{"owner":"a","mode":"rw"}],"tmpl":[{"owner":"operator","mode":"r"}]}');
  await ok("{}", '{"owners":{"a":{"maxDocs":2}}}');

  await assert.rejects(ok('{"ext/wf":[{"owner":"ghost","mode":"r"}]}'), /unknown owner/);
  await assert.rejects(ok('{"other/wf":[{"owner":"a","mode":"r"}]}'), /unregistered driver/);
  await assert.rejects(ok('{"nope":[{"owner":"a","mode":"r"}]}'), /unknown template/);
  await assert.rejects(ok("{}", '{"owners":{"ghost":{"maxDocs":2}}}'), /unknown owner/);
});

test("StatePolicy exposes grants by key and limits by owner", () => {
  const p = new StatePolicy('{"ext/wf":[{"owner":"a","mode":"r"}]}', '{"owners":{"a":{"maxDocs":7}}}');
  assert.deepEqual(p.grantsFor("ext/wf"), [{ owner: "a", mode: "r" }]);
  assert.deepEqual(p.grantsFor("missing"), []);
  assert.equal(p.limitsFor("a").maxDocs, 7);
  assert.equal(p.limitsFor("b").maxDocs, STATE_LIMITS_DEFAULT.maxDocs);
});

test("stateOpPayload carries only the named fields and the state-op kind", () => {
  const out = stateOpPayload({ op: "put", owner: "a", key: "memo/x", rev: 3, bytes: 12, by: "agent" });
  assert.deepEqual(out, { kind: "ext.pomtreed.state_op", op: "put", owner: "a", key: "memo/x", rev: 3, bytes: 12, by: "agent" });

  const leaky = { op: "export", owner: "a", prefix: "memo/", count: 2, by: "operator", value: "secret", body: "x", extra: 1 } as unknown as Parameters<
    typeof stateOpPayload
  >[0];
  const allowed = new Set(["kind", "op", "owner", "key", "prefix", "rev", "bytes", "count", "by"]);
  const leakedOut = stateOpPayload(leaky) as unknown as Record<string, unknown>;
  for (const k of Object.keys(leakedOut)) assert.ok(allowed.has(k), `unexpected payload key ${k}`);
  assert.equal(leakedOut.kind, "ext.pomtreed.state_op");
  assert.deepEqual(leakedOut, { kind: "ext.pomtreed.state_op", op: "export", owner: "a", prefix: "memo/", count: 2, by: "operator" });
  // A workflow write names the qualified workflow and its instance.
  assert.deepEqual(stateOpPayload({ op: "rm", owner: "fin", key: "ext/s/k", count: 1, by: "workflow", workflow: "fin/desk", instance: "" }), {
    kind: "ext.pomtreed.state_op",
    op: "rm",
    owner: "fin",
    key: "ext/s/k",
    count: 1,
    by: "workflow",
    workflow: "fin/desk",
    instance: "",
  });
});
