import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { FakeHostStore, FakeSandbox, FakeWorkspace, createFakes, tmpDir } from "@pomtree/testing";
import { LocalNode } from "./local-node.ts";

function rig(over: { bootEpoch?: string } = {}) {
  const root = tmpDir("lnode-");
  const real = realpathSync(root);
  const link = join(root, "link");
  mkdirSync(join(real, "ws", "ws-1"), { recursive: true });
  symlinkSync(join(real, "ws"), link);
  const fakes = createFakes({ host: "h1" });
  const node = new LocalNode({
    hostId: "h1",
    labels: { os: "linux" },
    capacity: { maxSessions: 3, cpus: 4, memoryBytes: 8e9 },
    sandbox: fakes.sandbox,
    workspace: fakes.workspace,
    image: "img@sha256:x",
    ...over,
    // The workspace path goes through a symlink so realpath resolution is observable.
    workspacePath: (id) => {
      if (id !== "ws-1") throw new Error(`no such dir ${join(root, "secret-state-dir")}`);
      return join(link, "ws-1");
    },
    sessionDir: (agent) => join(root, "sessions", agent),
  });
  return { node, real, root, fakes };
}

test("workspace mounts bind the realpath of the injected workspace path, read-write by default", async () => {
  const { node, real } = rig();
  const m = await node.resolve("a", { kind: "workspace", workspace: "ws-1", containerPath: "/workspace" });
  assert.deepEqual(m, { type: "bind", hostPath: join(real, "ws", "ws-1"), containerPath: "/workspace", readOnly: false });
  const ro = await node.resolve("a", { kind: "workspace", workspace: "ws-1", containerPath: "/w", readOnly: true });
  assert.equal(ro.type === "bind" && ro.readOnly, true);
});

test("an unknown workspace id fails without leaking any host path", async () => {
  const { node, root } = rig();
  await assert.rejects(node.resolve("a", { kind: "workspace", workspace: "ws-nope", containerPath: "/workspace" }), (e: Error) => {
    assert.match(e.message, /ws-nope/);
    assert.ok(!e.message.includes(root), e.message);
    return true;
  });
  // A path that resolves but no longer exists on disk fails the same way.
  const gone = new LocalNode({
    hostId: "h1",
    capacity: { maxSessions: 1 },
    sandbox: new FakeSandbox(),
    workspace: new FakeWorkspace(),
    workspacePath: () => join(root, "vanished"),
    sessionDir: () => root,
  });
  await assert.rejects(gone.resolve("a", { kind: "workspace", workspace: "ws-x", containerPath: "/w" }), (e: Error) => !e.message.includes(root));
});

test("session mounts create and bind the agent's session directory", async () => {
  const { node, real } = rig();
  const m = await node.resolve("agent-7", { kind: "session", agent: "agent-7", containerPath: "/workspace/.pi-session" });
  assert.deepEqual(m, { type: "bind", hostPath: join(real, "sessions", "agent-7"), containerPath: "/workspace/.pi-session", readOnly: false });
  assert.ok(existsSync(join(real, "sessions", "agent-7")));
});

test("scratch mounts are tmpfs, with the requested size only when given", async () => {
  const { node } = rig();
  assert.deepEqual(await node.resolve("a", { kind: "scratch", containerPath: "/tmp" }), { type: "tmpfs", containerPath: "/tmp" });
  assert.deepEqual(await node.resolve("a", { kind: "scratch", containerPath: "/tmp", sizeBytes: 64 }), { type: "tmpfs", containerPath: "/tmp", sizeBytes: 64 });
});

test("bind mounts pass through (realpathed when present, unchanged when not yet created) with the read-only flag", async () => {
  const { node, real, root } = rig();
  const viaLink = join(root, "link", "ws-1");
  assert.deepEqual(await node.resolve("a", { kind: "bind", hostPath: viaLink, containerPath: "/x", readOnly: true }), {
    type: "bind",
    hostPath: join(real, "ws", "ws-1"),
    containerPath: "/x",
    readOnly: true,
  });
  assert.deepEqual(await node.resolve("a", { kind: "bind", hostPath: "/not/yet/there", containerPath: "/y" }), {
    type: "bind",
    hostPath: "/not/yet/there",
    containerPath: "/y",
    readOnly: false,
  });
});

test("register upserts the host ready with config capacity and the daemon image; same boot is idempotent, a new boot re-applies", async () => {
  const hosts = new FakeHostStore(Date.now);
  const a = rig({ bootEpoch: "e1" }).node;
  const rec = await a.register(hosts);
  assert.equal(rec.state, "ready");
  assert.deepEqual(rec.capacity, { maxSessions: 3, cpus: 4, memoryBytes: 8e9 });
  assert.deepEqual(rec.images, ["img@sha256:x"]);
  assert.deepEqual(rec.labels, { os: "linux" });
  await hosts.setHostState("h1", "draining", "drain");
  await a.register(hosts); // same boot epoch: the original result replays, state untouched
  assert.equal((await hosts.getHost("h1"))!.state, "draining");
  await rig({ bootEpoch: "e2" }).node.register(hosts); // next boot: ready again, createdAt kept
  const again = (await hosts.getHost("h1"))!;
  assert.equal(again.state, "ready");
  assert.equal(again.createdAt, rec.createdAt);
});
