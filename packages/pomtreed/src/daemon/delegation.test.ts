import assert from "node:assert/strict";
import { test } from "node:test";
import type { EgressPolicy, SpawnSpec } from "@pomtree/core";
import { delegationProblem, egressWithin, resourcesExceeded } from "./delegation.ts";

const none: EgressPolicy = { kind: "none" };
const reg: EgressPolicy = { kind: "registry" };
const pub: EgressPolicy = { kind: "audited-public" };
const al = (...hosts: string[]): EgressPolicy => ({ kind: "allowlist", hosts });
const g = (egress: EgressPolicy, envManifestHash: string | null = null) => ({ egress, envManifestHash });
const spec = (over: Partial<SpawnSpec> = {}): SpawnSpec => ({ image: "i", envManifestHash: null, extensions: [], systemPrompt: null, egress: reg, ...over });

// [child, parent, within]
const TABLE: Array<[string, ReturnType<typeof g>, ReturnType<typeof g>, boolean]> = [
  ["none within none", g(none), g(none), true],
  ["none within registry", g(none), g(reg), true],
  ["none within allowlist", g(none), g(al("a")), true],
  ["none within public", g(none), g(pub), true],
  ["registry exceeds none", g(reg), g(none), false],
  ["empty allowlist exceeds none (relay)", g(al()), g(none), false],
  ["public exceeds none", g(pub), g(none), false],
  ["registry within registry (child no manifest)", g(reg), g(reg, "h1"), true],
  ["registry within registry (same manifest)", g(reg, "h1"), g(reg, "h1"), true],
  ["registry exceeds registry (different manifest)", g(reg, "h2"), g(reg, "h1"), false],
  ["registry with manifest exceeds registry without", g(reg, "h2"), g(reg), false],
  ["registry (no manifest) within allowlist", g(reg), g(al("a")), true],
  ["registry (manifest) exceeds allowlist", g(reg, "h1"), g(al("a")), false],
  ["narrower allowlist within allowlist", g(al("a")), g(al("a", "b")), true],
  ["equal allowlist within allowlist", g(al("a", "b")), g(al("b", "a")), true],
  ["wider allowlist exceeds allowlist", g(al("a", "b")), g(al("a")), false],
  ["unrelated hosts exceed allowlist", g(al("c")), g(al("a")), false],
  ["empty allowlist within allowlist", g(al()), g(al("a")), true],
  ["empty allowlist within registry", g(al()), g(reg), true],
  ["host allowlist exceeds registry", g(al("a")), g(reg), false],
  ["registry within public", g(reg, "h1"), g(pub), true],
  ["allowlist within public", g(al("a")), g(pub), true],
  ["public within public", g(pub), g(pub), true],
  ["public exceeds registry", g(pub), g(reg), false],
  ["public exceeds allowlist", g(pub), g(al("a")), false],
];
for (const [name, c, p, ok] of TABLE) test(`egressWithin: ${name}`, () => assert.equal(egressWithin(c, p), ok));

test("resourcesExceeded: narrower, equal, wider, unset child, unset parent", () => {
  const parent = spec({ memoryBytes: 100, cpus: 2, shmBytes: 10, diskBytes: 50 });
  assert.equal(resourcesExceeded(spec({ memoryBytes: 50, cpus: 1, shmBytes: 5, diskBytes: 25 }), parent), null);
  assert.equal(resourcesExceeded(spec({ memoryBytes: 100, cpus: 2, shmBytes: 10, diskBytes: 50 }), parent), null);
  assert.equal(resourcesExceeded(spec({ memoryBytes: 101, cpus: 2, shmBytes: 10, diskBytes: 50 }), parent), "memoryBytes");
  assert.equal(resourcesExceeded(spec({ memoryBytes: 100, cpus: 3, shmBytes: 10, diskBytes: 50 }), parent), "cpus");
  assert.equal(resourcesExceeded(spec({ memoryBytes: 100, cpus: 2, shmBytes: 11, diskBytes: 50 }), parent), "shmBytes");
  assert.equal(resourcesExceeded(spec({ memoryBytes: 100, cpus: 2, shmBytes: 10, diskBytes: 51 }), parent), "diskBytes");
  assert.equal(resourcesExceeded(spec({ memoryBytes: 100, cpus: 2, shmBytes: 10 }), parent), "diskBytes", "unset child field under a set parent limit");
  assert.equal(resourcesExceeded(spec({ memoryBytes: 1e12, cpus: 64, shmBytes: 1e9, diskBytes: 1e12 }), spec()), null, "parent without limits bounds nothing");
});

test("resourcesExceeded: unset memory means the daemon default on both sides", () => {
  const d = { memoryBytes: 2000 };
  assert.equal(resourcesExceeded(spec(), spec(), d), null);
  assert.equal(resourcesExceeded(spec({ memoryBytes: 1000 }), spec(), d), null);
  assert.equal(resourcesExceeded(spec({ memoryBytes: 4000 }), spec(), d), "memoryBytes");
  assert.equal(resourcesExceeded(spec(), spec({ memoryBytes: 1000 }), d), "memoryBytes");
});

test("delegationProblem: messages name child, parent and the fix; null when within", () => {
  assert.equal(delegationProblem(spec({ egress: none }), spec({ egress: none }), null), null);
  assert.equal(
    delegationProblem(spec({ egress: reg }), spec({ egress: none }), null),
    "spawn refused: the child's egress registry exceeds the parent's egress none (a child may only narrow its parent's network reach); spawn it from the operator, or have the operator set agent.untemplatedEgress=none",
  );
  assert.match(
    delegationProblem(spec({ egress: al("a", "b") }), spec({ egress: al("a") }), "wide")!,
    /egress allowlist \[a, b\] exceeds the parent's egress allowlist \[a\].*template wide itself, or choose a template whose egress is within the parent's/,
  );
  assert.match(
    delegationProblem(spec({ memoryBytes: 9 }), spec({ memoryBytes: 5 }), "big")!,
    /child's memoryBytes 9 exceeds the parent's memoryBytes 5.*template big itself.*at or below the parent's/,
  );
  assert.match(delegationProblem(spec(), spec({ cpus: 1 }), null)!, /child's cpus unset .* exceeds the parent's cpus 1.*operator/);
});

test("delegationProblem: a parent spec with no egress reads as none (fail closed)", () => {
  assert.match(delegationProblem(spec({ egress: reg }), {} as SpawnSpec, null)!, /parent's egress none/);
  assert.equal(delegationProblem(spec({ egress: none }), {} as SpawnSpec, null), null);
});
