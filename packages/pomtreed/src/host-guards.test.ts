import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeSandbox, tmpDir } from "@pomtree/testing";
import { memoryGate, memoryHolders, looseMode, writeSecretFile, pinnedAgentPort } from "./host-guards.ts";

test("memoryGate refuses a container that would exceed the reservation", () => {
  const G = 1024 ** 3;
  assert.equal(memoryGate({ running: 1, perContainerBytes: 2 * G, totalBytes: 8 * G, fraction: 0.9 }).ok, true);
  assert.equal(memoryGate({ running: 3, perContainerBytes: 2 * G, totalBytes: 8 * G, fraction: 0.9 }).ok, false);
});

const spec = (agent: string) => ({ agent, image: "i", env: {}, mounts: [] });
const holders = async (sb: FakeSandbox) => memoryHolders(await sb.list(), (id) => sb.inspect(id));

test("memoryHolders: a held exited child does not reserve memory, so it does not block admission", async () => {
  const G = 1024 ** 3;
  const sb = new FakeSandbox();
  const parent = await sb.start(spec("parent"), "k1");
  for (const [i, kid] of ["kid-1", "kid-2", "kid-3"].entries()) sb.exit((await sb.start(spec(kid), `k-kid${i}`)).id, 0);
  assert.equal((await sb.list()).length, 4, "docker ps -a still lists the exited, unreaped children");
  assert.equal(await holders(sb), 1);
  assert.ok((await sb.inspect(parent.id))?.running);
  // The hosted runner's limit: four listed containers would be refused, one running container is admitted.
  const limit = { perContainerBytes: 2 * G, totalBytes: 7485331046 / 0.9, fraction: 0.9 };
  assert.equal(memoryGate({ running: (await sb.list()).length, ...limit }).ok, false);
  assert.equal(memoryGate({ running: await holders(sb), ...limit }).ok, true);
});

test("memoryHolders: running containers reserve memory and block admission at the limit", async () => {
  const G = 1024 ** 3;
  const sb = new FakeSandbox();
  for (const a of ["a", "b", "c", "d"]) await sb.start(spec(a), `k-${a}`);
  assert.equal(await holders(sb), 4);
  const r = memoryGate({ running: await holders(sb), perContainerBytes: 2 * G, totalBytes: 8 * G, fraction: 0.9 });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /memory reservation exceeded \(5 x /);
});

test("memoryHolders: a container whose state cannot be read counts; one already removed does not", async () => {
  const sb = new FakeSandbox();
  const h = await sb.start(spec("a"), "k-a");
  sb.exit(h.id, 0);
  assert.equal(await holders(sb), 0);
  sb.inspectErrors.set(h.id, new Error("docker inspect: timed out"));
  assert.equal(await holders(sb), 1, "an unreadable exited container still counts (fail closed)");
  assert.equal(await memoryHolders([{ id: "sbx-gone" }], (id) => sb.inspect(id)), 0, "inspect null: removed between list and inspect");
});

test("memoryHolders: only exited, dead and removed containers are free; created, paused, restarting and unknown count", async () => {
  const sb = new FakeSandbox();
  const cases: [string | null, boolean][] = [
    ["created", true],
    ["running", true],
    ["paused", true],
    ["restarting", true],
    ["removing", true],
    ["frobbing", true], // unrecognized
    [null, true], // no status reported: running false/true alone is not proof
    ["exited", false],
    ["dead", false],
  ];
  for (const [status, held] of cases) {
    const h = await sb.start(spec(`a-${status}`), `k-${status}`);
    if (status === null) sb.exit(h.id, 0); // not running and no status: indistinguishable from created, so it counts
    sb.statuses.set(h.id, status);
    assert.equal(await memoryHolders([{ id: h.id }], (id) => sb.inspect(id)), held ? 1 : 0, `status ${status}`);
  }
  assert.equal(await holders(sb), cases.filter(([, held]) => held).length);
});

test("memoryHolders negative control: a created container that a running-only count would miss closes the gate", async () => {
  const G = 1024 ** 3;
  const sb = new FakeSandbox();
  for (const a of ["a", "b"]) await sb.start(spec(a), `k-${a}`);
  const starting = await sb.start(spec("c"), "k-c");
  sb.statuses.set(starting.id, "created");
  assert.equal((await sb.inspect(starting.id))?.running, false, "the created container reads as not running");
  const limit = { perContainerBytes: 2 * G, totalBytes: 7485331046 / 0.9, fraction: 0.9 }; // 3 containers fit
  const runningOnly = (await Promise.all((await sb.list()).map(async (c) => (await sb.inspect(c.id))?.running))).filter(Boolean).length;
  assert.equal(memoryGate({ running: runningOnly, ...limit }).ok, true, "a running-only count would admit a 4th container");
  assert.equal(memoryGate({ running: await holders(sb), ...limit }).ok, false, "memoryHolders counts the created one and refuses");
});

test("writeSecretFile tightens a loose existing file", () => {
  const f = join(tmpDir("hg-"), "t");
  writeFileSync(f, "x");
  chmodSync(f, 0o644);
  assert.notEqual(looseMode(f), null);
  writeSecretFile(f, "tok");
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(readFileSync(f, "utf8"), "tok");
});

test("pinnedAgentPort reuses the remembered port only for :0", () => {
  const f = join(tmpDir("hg-"), "p");
  const a = pinnedAgentPort("127.0.0.1:0", f);
  assert.equal(a.listen, "127.0.0.1:0");
  a.remember(4321);
  assert.equal(pinnedAgentPort("127.0.0.1:0", f).listen, "127.0.0.1:4321");
  assert.equal(pinnedAgentPort("127.0.0.1:99", f).listen, "127.0.0.1:99");
});
