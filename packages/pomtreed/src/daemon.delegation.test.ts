// Delegation only narrows: a non-root container parent's spawn is refused when the child's egress or resource limits exceed the parent's.
// The operator (root) is unbounded; a deterministic parent is bounded by the operator's template grant (mayUseTemplate), not by this check.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, EgressPolicy, SpawnSpec, Template } from "@pomtree/core";
import { LifecycleError } from "./lifecycle.ts";
import { setup } from "./test-setup.ts";

type T = ReturnType<typeof setup>;
const tpl = (id: string, over: Partial<Template> = {}): Template => ({ id, ...over });
const parentOf = (t: T, over: Partial<SpawnSpec> = {}, key = "parent"): Promise<AgentRecord> =>
  t.daemon.deps.registry.create({
    id: `ag-${key}`,
    parent: null,
    name: "p",
    task: "t",
    host: "h1",
    budgetMicros: 100_000,
    idempotencyKey: key,
    spec: { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "registry" }, ...over },
  });
const grantAll = { mayUseTemplate: () => true };
const withTemplates = (over: Record<string, Template>, extra: Parameters<typeof setup>[1] = grantAll) => {
  const t = setup(async () => {}, extra);
  for (const [k, v] of Object.entries(over)) t.fakes.hooks.raw.templates.templates.set(k, v);
  return t;
};
const spawnFrom = (t: T, parent: AgentRecord, key: string, template?: string) =>
  t.daemon.spawn(parent.id, { name: "x", task: "y", idempotencyKey: key, ...(template !== undefined && { template }) });
const refused = async (p: Promise<unknown>, re: RegExp) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  assert.ok(e instanceof LifecycleError, `expected a LifecycleError, got ${String(e)}`);
  assert.equal(e.status, 403);
  assert.equal(e.extra?.code, "delegation_exceeds_parent");
  assert.match(e.message, re);
};
const egress = (e: EgressPolicy): Partial<SpawnSpec> => ({ egress: e });

test("untemplated child (registry) under a none parent is refused with the cause and the fix", async () => {
  const t = setup(async () => {}, { untemplatedEgress: "registry" });
  const p = await parentOf(t, egress({ kind: "none" }));
  await refused(
    spawnFrom(t, p, "k1"),
    /^spawn refused: the child's egress registry exceeds the parent's egress none \(a child may only narrow its parent's network reach\); spawn it from the operator, or have the operator set agent\.untemplatedEgress=none$/,
  );
  assert.equal((await t.daemon.deps.registry.list({ parent: p.id })).length, 0, "no child row is created");
});

test("negative control: the same untemplated spawn from the operator (root) succeeds", async () => {
  const t = setup(async () => {}, { untemplatedEgress: "registry" });
  const a = await t.spawn("k1");
  assert.ok(a.id);
  await t.orchestrator.idle();
});

test("none child under a none parent is allowed (untemplatedEgress=none)", async () => {
  const t = setup(async () => {}, { untemplatedEgress: "none" });
  const p = await parentOf(t, egress({ kind: "none" }));
  const c = await spawnFrom(t, p, "k1");
  assert.equal(c.parent, p.id);
  await t.orchestrator.idle();
});

test("untemplated registry child under a registry or an audited-public parent is allowed", async () => {
  const t = setup(async () => {}, { untemplatedEgress: "registry" });
  await spawnFrom(t, await parentOf(t, egress({ kind: "registry" }), "a"), "k1");
  await spawnFrom(t, await parentOf(t, egress({ kind: "audited-public" }), "b"), "k2");
  await t.orchestrator.idle();
});

test("allowlist templates: narrower and equal are allowed; wider and unrelated hosts are refused", async () => {
  const t = withTemplates({
    narrow: tpl("narrow", { egress: { kind: "allowlist", hosts: ["a.example"] } }),
    equal: tpl("equal", { egress: { kind: "allowlist", hosts: ["b.example", "a.example"] } }),
    wide: tpl("wide", { egress: { kind: "allowlist", hosts: ["a.example", "b.example", "c.example"] } }),
    other: tpl("other", { egress: { kind: "allowlist", hosts: ["z.example"] } }),
  });
  const p = await parentOf(t, egress({ kind: "allowlist", hosts: ["a.example", "b.example"] }));
  assert.ok((await spawnFrom(t, p, "k1", "narrow")).id);
  assert.ok((await spawnFrom(t, p, "k2", "equal")).id);
  await refused(
    spawnFrom(t, p, "k3", "wide"),
    /egress allowlist \[a\.example, b\.example, c\.example\] exceeds the parent's egress allowlist \[a\.example, b\.example\].*the operator must spawn template wide itself, or choose a template whose egress is within the parent's$/,
  );
  await refused(spawnFrom(t, p, "k4", "other"), /template other itself/);
  await t.orchestrator.idle();
});

test("registry vs allowlist: a manifest-free registry child fits an allowlist parent; a manifest registry child does not; an allowlist child fits a registry parent only when empty", async () => {
  const t = withTemplates({
    reg: tpl("reg", { egress: { kind: "registry" } }),
    regEnv: tpl("regEnv", { egress: { kind: "registry" }, env: { FOO: "bar" } }),
    hosts: tpl("hosts", { egress: { kind: "allowlist", hosts: ["a.example"] } }),
    empty: tpl("empty", { egress: { kind: "allowlist", hosts: [] } }),
  });
  const allow = await parentOf(t, egress({ kind: "allowlist", hosts: ["a.example"] }), "allow");
  assert.ok((await spawnFrom(t, allow, "k1", "reg")).id);
  await refused(spawnFrom(t, allow, "k2", "regEnv"), /egress registry exceeds the parent's egress allowlist \[a\.example\]/);
  const registry = await parentOf(t, egress({ kind: "registry" }), "registry");
  assert.ok((await spawnFrom(t, registry, "k3", "empty")).id);
  await refused(spawnFrom(t, registry, "k4", "hosts"), /egress allowlist \[a\.example\] exceeds the parent's egress registry/);
  await t.orchestrator.idle();
});

test("audited-public template: refused under every narrower parent, allowed under an audited-public parent and the operator", async () => {
  const t = withTemplates({ pub: tpl("pub", { egress: { kind: "audited-public" } }) });
  for (const [i, e] of ([{ kind: "none" }, { kind: "registry" }, { kind: "allowlist", hosts: ["a.example"] }] as EgressPolicy[]).entries())
    await refused(spawnFrom(t, await parentOf(t, egress(e), `n${i}`), `k${i}`, "pub"), /egress audited-public exceeds the parent's egress/);
  assert.ok((await spawnFrom(t, await parentOf(t, egress({ kind: "audited-public" }), "pp"), "kp", "pub")).id);
  assert.ok((await t.spawn("ko", { template: "pub" })).id, "the operator spawns a wide template unchanged");
  await t.orchestrator.idle();
});

test("resources: narrower and equal are allowed; wider, unset-under-a-limit are refused with the field named", async () => {
  const t = withTemplates({
    small: tpl("small", { memoryBytes: 500, cpus: 1, shmBytes: 5, diskBytes: 5 }),
    same: tpl("same", { memoryBytes: 1000, cpus: 2, shmBytes: 10, diskBytes: 10 }),
    bigMem: tpl("bigMem", { memoryBytes: 1001, cpus: 2, shmBytes: 10, diskBytes: 10 }),
    bigCpu: tpl("bigCpu", { memoryBytes: 1000, cpus: 3, shmBytes: 10, diskBytes: 10 }),
    bigShm: tpl("bigShm", { memoryBytes: 1000, cpus: 2, shmBytes: 11, diskBytes: 10 }),
    bigDisk: tpl("bigDisk", { memoryBytes: 1000, cpus: 2, shmBytes: 10, diskBytes: 11 }),
    unsetCpu: tpl("unsetCpu", { memoryBytes: 1000, shmBytes: 10, diskBytes: 10 }),
  });
  const p = await parentOf(t, { memoryBytes: 1000, cpus: 2, shmBytes: 10, diskBytes: 10 });
  assert.ok((await spawnFrom(t, p, "k1", "small")).id);
  assert.ok((await spawnFrom(t, p, "k2", "same")).id);
  await refused(
    spawnFrom(t, p, "k3", "bigMem"),
    /child's memoryBytes 1001 exceeds the parent's memoryBytes 1000.*template bigMem itself, or choose a template that sets memoryBytes at or below the parent's$/,
  );
  await refused(spawnFrom(t, p, "k4", "bigCpu"), /child's cpus 3 exceeds the parent's cpus 2/);
  await refused(spawnFrom(t, p, "k5", "bigShm"), /child's shmBytes 11 exceeds the parent's shmBytes 10/);
  await refused(spawnFrom(t, p, "k6", "bigDisk"), /child's diskBytes 11 exceeds the parent's diskBytes 10/);
  await refused(spawnFrom(t, p, "k7", "unsetCpu"), /child's cpus unset \(unbounded or a default this daemon cannot compare\) exceeds the parent's cpus 2/);
  await t.orchestrator.idle();
});

test("resources: an untemplated child (all unset) under a parent with a cpu limit is refused with the untemplated fix; the operator is unbounded", async () => {
  const t = setup(async () => {}, { untemplatedEgress: "registry" });
  const p = await parentOf(t, { cpus: 1 });
  await refused(spawnFrom(t, p, "k1"), /child's cpus unset .* exceeds the parent's cpus 1 .*; spawn it from the operator, or use a template that sets it/);
  const wide = tpl("wide", { memoryBytes: 1e12, cpus: 64 });
  t.fakes.hooks.raw.templates.templates.set("wide", wide);
  assert.ok((await t.spawn("ko", { template: "wide" })).id);
  await t.orchestrator.idle();
});

test("memory: an unset child is compared against the daemon default (containerMemoryBytes), on both sides", async () => {
  const t = withTemplates({ big: tpl("big", { memoryBytes: 4000 }), small: tpl("small", { memoryBytes: 1000 }) }, { ...grantAll, containerMemoryBytes: 2000 });
  const p = await parentOf(t, {});
  assert.ok((await spawnFrom(t, p, "k1", "small")).id);
  await refused(spawnFrom(t, p, "k2", "big"), /child's memoryBytes 4000 exceeds the parent's memoryBytes 2000/);
  await t.orchestrator.idle();
});

test("a deterministic parent is not bounded: its wide-template child is allowed when mayUseTemplate grants it", async () => {
  const t = withTemplates({ pub: tpl("pub", { egress: { kind: "audited-public" }, memoryBytes: 1e12 }) });
  const rec = await t.daemon.deps.registry.create({
    id: "ag-det",
    parent: null,
    executor: "deterministic",
    name: "d",
    task: "t",
    host: "h1",
    budgetMicros: 100_000,
    idempotencyKey: "det",
    spec: { driver: "d", input: null },
  });
  assert.ok((await spawnFrom(t, rec, "k1", "pub")).id);
  await t.orchestrator.idle();
});

test("a granted agent spawning a template with no egress of its own (code default) follows the same rule", async () => {
  const t = setup(async () => {}, { ...grantAll, untemplatedEgress: "registry" });
  const none = await parentOf(t, egress({ kind: "none" }), "n");
  await refused(spawnFrom(t, none, "k1", "code"), /template code itself/);
  const reg = await parentOf(t, egress({ kind: "registry" }), "r");
  assert.ok((await spawnFrom(t, reg, "k2", "code")).id);
  await t.orchestrator.idle();
});
