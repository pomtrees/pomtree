import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { IMAGE_REBUILD_ACTION, SandboxStartError, SandboxUnavailableError, validateDeclaration, type Sandbox, type SandboxOwner } from "@pomtree/core";
import { classifyDockerError, classifyStartError, egressProbeFailure, removalRace } from "./docker.ts";
import { NetSandbox } from "./test-network.ts";
import type { Exec, SpawnFn } from "./docker.ts";
import { EGRESS_PROXY_MEMORY_BYTES, EGRESS_PROXY_PATH } from "./egress.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";

const OWNER: SandboxOwner = { host: "host-1", storeId: "s1", epoch: 1 };
const spec = { agent: "a", image: "i", env: {}, mounts: [wsMount("/w")] };

function fakeProc() {
  const p = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  return p;
}
const asSpawn = (p: ReturnType<typeof fakeProc>): SpawnFn => (() => p) as unknown as SpawnFn;
const collect = async (it: AsyncIterable<{ chunk: string }>) => {
  let s = "";
  for await (const c of it) s += c.chunk;
  return s;
};

// Fake exec for tests that only exercise the run path: the idempotency existence check
// (docker inspect) finds nothing, so start() proceeds to docker run.
const runOnlyExec: Exec = async (args) => {
  if (args[0] === "inspect") throw new Error("docker inspect failed: Error: No such object: x");
  return "";
};

test("output: multibyte characters split across chunks survive", async () => {
  const p = fakeProc();
  const h = await new NetSandbox({ mounts: stubMounts(), exec: runOnlyExec, spawn: asSpawn(p) }).start(spec, "k-multibyte");
  const bytes = Buffer.from("héllo 👋");
  const done = collect(h.output());
  p.stdout.write(bytes.subarray(0, 2));
  p.stdout.write(bytes.subarray(2, 9));
  p.stdout.write(bytes.subarray(9));
  p.emit("close", 0, null);
  assert.equal(await done, "héllo 👋[pomtree: docker logs exited with code 0]\n");
});

test("output: surfaces the docker logs exit code as a final terminator", async () => {
  const p = fakeProc();
  const h = await new NetSandbox({ mounts: stubMounts(), exec: runOnlyExec, spawn: asSpawn(p) }).start(spec, "k-logs-exit");
  const done = collect(h.output());
  p.stdout.write("hi");
  p.emit("close", 1, null);
  assert.equal(await done, "hi[pomtree: docker logs exited with code 1]\n");
});

test("output: surfaces a signal-killed docker logs as a signal terminator", async () => {
  const p = fakeProc();
  const h = await new NetSandbox({ mounts: stubMounts(), exec: runOnlyExec, spawn: asSpawn(p) }).start(spec, "k-logs-signal");
  const done = collect(h.output());
  p.emit("close", null, "SIGKILL");
  assert.equal(await done, "[pomtree: docker logs killed by signal SIGKILL]\n");
});

test("output: spawn error surfaces as a stream error, not an uncaught exception", async () => {
  const p = fakeProc();
  const h = await new NetSandbox({ mounts: stubMounts(), exec: runOnlyExec, spawn: asSpawn(p) }).start(spec, "k-spawn-err");
  const done = collect(h.output());
  p.emit("error", new Error("spawn docker ENOENT"));
  await assert.rejects(done, /ENOENT/);
});

test("output: byte-budget queue drops oldest and says so", async () => {
  const p = fakeProc();
  const h = await new NetSandbox({ mounts: stubMounts(), exec: runOnlyExec, spawn: asSpawn(p), maxOutputBytes: 2 }).start(spec, "k-queue");
  const it = h.output()[Symbol.asyncIterator]();
  const first = it.next();
  // Let the generator attach listeners and park, then flood before it can drain.
  await new Promise((r) => setImmediate(r));
  for (const c of ["1", "2", "3", "4", "5"]) p.stdout.emit("data", c);
  p.emit("close", 0, null);
  let out = (await first).value.chunk as string;
  for (let r = await it.next(); !r.done; r = await it.next()) out += r.value.chunk;
  assert.match(out, /bytes of output dropped/);
  assert.equal(out, "[pomtree: 3 bytes of output dropped]\n45[pomtree: docker logs exited with code 0]\n");
});

function scripted(opts: { running?: boolean; oom?: boolean } = {}) {
  const calls: string[][] = [];
  let removed = false;
  let resolveWait: ((s: string) => void) | undefined;
  const exec: Exec = async (args) => {
    calls.push(args);
    const [cmd] = args;
    if (cmd === "run") return "cid";
    if (cmd === "wait") {
      if (removed) throw new Error("docker wait failed: Error: No such container: pomtree-x");
      if (opts.running !== false && !resolveWait) return new Promise<string>((r) => (resolveWait = r));
      return "137";
    }
    if (cmd === "kill" || cmd === "stop") {
      resolveWait?.("137");
      resolveWait = undefined;
      opts.running = false;
      return "";
    }
    if (cmd === "rm") {
      removed = true;
      return "";
    }
    if (cmd === "inspect") {
      if (removed) throw new Error("No such container");
      return `false 137 ${opts.oom === true} none`;
    }
    return "";
  };
  return { exec, calls };
}

test("kill: concurrent wait resolves with the exit code, container removed, inspect knows the code", async () => {
  const { exec, calls } = scripted();
  const sb = new NetSandbox({ mounts: stubMounts(), exec });
  const h = await sb.start(spec, "k-kill-concurrent");
  const waiting = h.wait();
  await sb.kill(h.id, `test-kill:${h.id}`);
  assert.deepEqual(await waiting, { exitCode: 137 });
  assert.deepEqual(await h.wait(), { exitCode: 137 });
  // OOMKilled must be captured by an inspect BEFORE rm -f (the flag is gone after removal).
  const cmds = calls.map((c) => c[0]).filter((c) => c !== "run");
  assert.ok(cmds.includes("kill") && cmds.includes("rm"));
  assert.ok(cmds.indexOf("inspect") < cmds.indexOf("rm"));
  assert.deepEqual(await sb.inspect(h.id), { running: false, exitCode: 137, status: "exited" });
});

test("kill captures oomKilled via inspect before rm, so wait/inspect remember it after removal", async () => {
  const { exec, calls } = scripted({ oom: true });
  const sb = new NetSandbox({ mounts: stubMounts(), exec });
  const h = await sb.start(spec, "k-kill-oom");
  await sb.kill(h.id, `test-kill:${h.id}`);
  assert.deepEqual(await h.wait(), { exitCode: 137, oomKilled: true });
  assert.deepEqual(await sb.inspect(h.id), { running: false, exitCode: 137, oomKilled: true, status: "exited" });
  const cmds = calls.map((c) => c[0]).filter((c) => c !== "run");
  assert.ok(cmds.indexOf("inspect") < cmds.indexOf("rm"));
});

test("wait surfaces oomKilled via the post-wait inspect for an already-exited container", async () => {
  const { exec } = scripted({ running: false, oom: true });
  const sb = new NetSandbox({ mounts: stubMounts(), exec });
  const h = await sb.start(spec, "k-wait-oom");
  assert.deepEqual(await h.wait(), { exitCode: 137, oomKilled: true });
  assert.deepEqual(await sb.inspect(h.id), { running: false, exitCode: 137, oomKilled: true });
});

test("inspect reports Docker's State.Status from the same inspect call; a missing or malformed status is omitted", async () => {
  const at = (line: string) => {
    const calls: string[][] = [];
    const exec: Exec = async (args) => {
      calls.push(args);
      return line;
    };
    const sb = new NetSandbox({ mounts: stubMounts(), exec });
    return { sb, calls };
  };
  const created = at("false 0 false none created");
  assert.deepEqual(await created.sb.inspect("x"), { running: false, exitCode: 0, status: "created" });
  assert.equal(created.calls.length, 1, "status rides on the existing inspect, no extra Docker call");
  assert.match(created.calls[0]?.join(" ") ?? "", /\{\{\.State\.Status\}\}/);
  assert.deepEqual(await at("true 0 false none paused").sb.inspect("x"), { running: true, exitCode: null, status: "paused" });
  assert.deepEqual(await at("false 1 false none exited").sb.inspect("x"), { running: false, exitCode: 1, status: "exited" });
  assert.deepEqual(
    await at("false 137 false  dead").sb.inspect("x"),
    { running: false, exitCode: 137, status: "dead" },
    "empty network mode keeps the field position",
  );
  // Negative: no status field, or a malformed one, is omitted rather than guessed.
  assert.deepEqual(await at("false 0 false none").sb.inspect("x"), { running: false, exitCode: 0 });
  assert.deepEqual(await at("false 0 false none <no value>").sb.inspect("x"), { running: false, exitCode: 0 });
});

test("stop: waits for exit and removes, so no stopped zombie remains; unknown container is a no-op", async () => {
  const { exec, calls } = scripted();
  const sb = new NetSandbox({ mounts: stubMounts(), exec });
  const h = await sb.start(spec, "k-stop");
  await sb.stop(h.id, 1500, `test-stop:${h.id}`);
  assert.deepEqual(calls.filter((c) => c[0] === "stop")[0], ["stop", "-t", "2", `pomtree-${h.id}`]);
  assert.ok(calls.some((c) => c[0] === "rm"));
  const ghost = new NetSandbox({
    mounts: stubMounts(),
    exec: async () => {
      throw new Error("Error: No such container: x");
    },
  });
  await ghost.kill("nope", "test-kill:nope");
  assert.equal(await ghost.inspect("nope"), null);
});

const CLASSIC = '[["Backing Filesystem","extfs"]]';
const CONTAINERD = '[["driver-type","io.containerd.snapshotter.v1"]]';
const ID = `sha256:${"a".repeat(64)}`;

test("imageIdentity: classic store reports the image id as config digest and engine id, plus the revision label", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({
    mounts: stubMounts(),
    exec: async (args) => {
      calls.push(args);
      return args[0] === "info" ? CLASSIC : `${ID}\tb3fe8f9`;
    },
  });
  assert.deepEqual(await sb.imageIdentity("alpine:3"), { engineLocalId: ID, configDigest: ID, revision: "b3fe8f9" });
  assert.deepEqual(calls[1], ["image", "inspect", "--format", '{{.Id}}\t{{index .Config.Labels "org.opencontainers.image.revision"}}', "alpine:3"]);
});

test("imageIdentity: the image store is read once per instance, and a failed read is retried", async () => {
  let infos = 0;
  let fail = true;
  const sb = new NetSandbox({
    mounts: stubMounts(),
    exec: async (args) => {
      if (args[0] !== "info") return `${ID}\t`;
      infos++;
      if (fail) throw new Error("Cannot connect");
      return CLASSIC;
    },
  });
  await assert.rejects(sb.imageIdentity("a:1"), /docker info failed/);
  fail = false;
  await sb.imageIdentity("a:1");
  await sb.imageIdentity("b:2");
  assert.equal(infos, 2, "one failed read, one successful read; the third call reuses it");
});

test("imageIdentity: an absent revision label is null", async () => {
  for (const out of [`${ID}\t`, `${ID}\t<no value>`]) {
    const sb = new NetSandbox({ mounts: stubMounts(), exec: async (args) => (args[0] === "info" ? CLASSIC : out) });
    assert.equal((await sb.imageIdentity("alpine:3")).revision, null);
  }
});

test("imageIdentity: the containerd image store reports the index digest as engine-local id and a null config digest, without throwing", async () => {
  const INDEX = `sha256:${"d".repeat(64)}`;
  const calls: string[][] = [];
  const sb = new NetSandbox({
    mounts: stubMounts(),
    exec: async (args) => {
      calls.push(args);
      return args[0] === "info" ? CONTAINERD : `${INDEX}\tb3fe8f9`;
    },
  });
  assert.deepEqual(await sb.imageIdentity("alpine:3"), { engineLocalId: INDEX, configDigest: null, revision: "b3fe8f9" });
  assert.ok(!calls.some((c) => c[0] === "save"), "no docker save on the containerd store");
});

test("imageIdentity: an unresolvable image or a non-digest id throws with cause and action", async () => {
  const missing = new NetSandbox({
    mounts: stubMounts(),
    exec: async (args) => {
      if (args[0] === "info") return CLASSIC;
      throw new Error("docker image failed: no such image");
    },
  });
  await assert.rejects(missing.imageIdentity("nope:1"), /cannot read the image identity of nope:1: .*no such image; pull or build the image locally/);
  const odd = new NetSandbox({ mounts: stubMounts(), exec: async (args) => (args[0] === "info" ? CLASSIC : "garbage\t") });
  await assert.rejects(odd.imageIdentity("x:1"), /not sha256:<64 hex>; use a Docker with the classic image store/);
  const down = new NetSandbox({
    mounts: stubMounts(),
    exec: async () => {
      throw new Error("docker info failed: Cannot connect");
    },
  });
  await assert.rejects(down.imageIdentity("x:1"), /docker info failed.*start the container engine and retry/);
});

test("declaration: validates, and snapshot, fork and pause capabilities are false (docker commit is not a sandbox snapshot)", () => {
  const { declaration } = new NetSandbox({ mounts: stubMounts() });
  assert.deepEqual(validateDeclaration(declaration), []);
  assert.equal(declaration.backend, "docker");
  for (const c of ["snapshot.disk", "snapshot.memory", "fork", "pause", "lease.extend", "image.template", "connect", "files.put", "files.get"] as const) {
    assert.equal(declaration.capabilities[c], false, c);
  }
  // A facet is present iff declared: terminal is the only one this adapter provides.
  const sb = new NetSandbox({ mounts: stubMounts() });
  assert.equal(declaration.capabilities.terminal, true);
  assert.equal(typeof sb.terminal.open, "function");
  for (const f of ["connect", "files", "snapshots", "lease", "pause", "images"] as const) assert.equal((sb as Sandbox)[f], undefined, f);
  // Negative control: validateDeclaration refuses fork without a snapshot capability, so the check can fail.
  assert.notDeepEqual(validateDeclaration({ ...declaration, capabilities: { ...declaration.capabilities, fork: true } }), []);
});

const egressSpec = { ...spec, agent: "ag-eg", egress: { allow: [{ host: "pypi.org" }, { host: "host.docker.internal", port: 4321 }] } };

test("egress enforcement stands up network + proxy before the sandbox and tears both down after", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({
    mounts: stubMounts(),
    enforceEgress: true,
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "inspect") throw new Error("No such object");
      return "";
    },
  });
  const h = await sb.start(egressSpec, "k-egress-lifecycle");
  const at = (p: (c: string[]) => boolean) => calls.findIndex(p);
  const networkCreate = at((c) => c[0] === "volume" && c[1] === "create");
  const proxyRun = at((c) => c[0] === "run" && c[3] === `pomtree-egress-proxy-${h.id}`);
  const sandboxRun = at((c) => c[0] === "run" && c[3] === `pomtree-${h.id}`);
  assert.ok(networkCreate !== -1 && proxyRun !== -1 && sandboxRun !== -1);
  assert.ok(networkCreate < proxyRun && proxyRun < sandboxRun, "egress before sandbox");
  // Both the network and the proxy are labelled with the sandbox id for label-driven reclaim.
  assert.ok(calls[networkCreate]!.includes(`pomtree.sandbox=${h.id}`));
  const proxyArgs = calls[proxyRun]!;
  assert.ok(proxyArgs.includes(`pomtree.sandbox=${h.id}`));
  assert.ok(proxyArgs.some((a) => a.startsWith("EGRESS_CONFIG_JSON=") && a.includes("pypi.org:443")));
  assert.equal(proxyArgs.includes("-v"), false, "no host source bind mount");
  assert.deepEqual(proxyArgs.slice(-2), ["i", "/opt/pomtree/egress/proxy.ts"]);
  assert.equal(proxyArgs.at(-1), EGRESS_PROXY_PATH, "the sidecar runs the exported path pomtreed's boot probe checks");
  assert.equal(proxyArgs[proxyArgs.indexOf("--entrypoint") + 1], "node");
  assert.ok(proxyArgs.includes("--read-only"));
  // The sidecar is hardened like the sandbox: all caps dropped, no new privileges, bounded memory.
  assert.ok(proxyArgs.includes("--cap-drop=ALL"));
  assert.ok(proxyArgs.includes("no-new-privileges"));
  assert.equal(proxyArgs[proxyArgs.indexOf("--memory") + 1], String(EGRESS_PROXY_MEMORY_BYTES));
  assert.equal(proxyArgs[proxyArgs.indexOf("--memory-swap") + 1], String(EGRESS_PROXY_MEMORY_BYTES));
  // No externally reachable proxy port or worker bridge network.
  assert.ok(proxyArgs.includes("EGRESS_SOCKET=/run/pomtree-egress/proxy.sock"));
  assert.equal(proxyArgs.includes("--publish"), false);
  assert.equal(proxyArgs[proxyArgs.indexOf("--user") + 1], `${process.getuid?.() || 1000}:1000`);
  // The sidecar joins the one shared ICC-off network, never the default bridge.
  assert.equal(proxyArgs[proxyArgs.indexOf("--network") + 1], "pomtree-egress");
  await sb.kill(h.id, `test-kill:${h.id}`);
  assert.ok(calls.some((c) => c[0] === "rm" && c[2] === `pomtree-egress-proxy-${h.id}`));
  assert.ok(calls.some((c) => c[0] === "volume" && c[1] === "rm" && c[2] === `pomtree-egress-socket-${h.id}`));
  // Per-sandbox teardown leaves the shared network alone (the wrapper answers only its inspect).
  assert.ok(!calls.some((c) => c[0] === "network"), "no network create/rm in the per-sandbox lifecycle");
});

test("start: omitted egress is fail-closed through an empty proxy allowlist", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({
    mounts: stubMounts(),
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "inspect") throw new Error("No such object");
      return "";
    },
  });
  await sb.start(spec, "k-egress-default-deny");
  const proxy = calls.find((c) => c[0] === "run" && c.some((v) => v.startsWith("EGRESS_CONFIG_JSON=") && v.includes('"allow":[]')));
  const sandbox = calls.find((c) => c[0] === "run" && c.includes("pomtree.agent=a"));
  assert.ok(proxy, "proxy is started even without spec.egress");
  assert.ok(sandbox?.includes("--network"), "sandbox joins the isolated egress network");
  assert.equal(sandbox?.[sandbox.indexOf("--network") + 1], "none");
});

test("egress enforcement fails closed: network create failure means no sandbox run and best-effort teardown", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({
    mounts: stubMounts(),
    enforceEgress: true,
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "inspect") throw new Error("No such object");
      if (args[0] === "volume" && args[1] === "create") throw new Error("docker volume failed: cannot create");
      return "";
    },
  });
  await assert.rejects(sb.start(egressSpec, "k-egress-fail"), /cannot create/);
  assert.equal(
    calls.some((c) => c[0] === "run"),
    false,
  );
  assert.ok(calls.some((c) => c[0] === "rm" && String(c[2]).startsWith("pomtree-egress-proxy-")));
  // Only the pre-create reclaim of a crash leftover; the volume we failed to create gets no teardown rm.
  const create = calls.findIndex((c) => c[0] === "volume" && c[1] === "create");
  assert.equal(
    calls.some((c, i) => c[0] === "volume" && c[1] === "rm" && i > create),
    false,
  );
});

test("egress enforcement reuses an existing network (already exists is not fatal)", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({
    mounts: stubMounts(),
    enforceEgress: true,
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "inspect") throw new Error("No such object");
      if (args[0] === "volume" && args[1] === "create") return "existing-owned-volume";
      return "";
    },
  });
  const h = await sb.start(egressSpec, "k-egress-reuse");
  assert.ok(calls.some((c) => c[0] === "run" && c[3] === `pomtree-${h.id}`));
});

test("egress is mandatory: deprecated enforcement flag cannot bypass the proxy", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({
    mounts: stubMounts(),
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "inspect") throw new Error("No such object");
      return "";
    },
  });
  const h = await sb.start({ ...spec, egress: { allow: [{ host: "pypi.org" }] } }, "k-egress-off");
  assert.equal(
    calls.some((c) => c[0] === "volume"),
    true,
  );
  assert.ok(calls.some((c) => c[0] === "run" && c[3] === `pomtree-${h.id}`));
});

test("attach: adopts a running container by sandbox id", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({
    mounts: stubMounts(),
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "inspect") return "true 0 false none";
      return "";
    },
  });
  const h = await sb.attach("sb-1", "ag-1");
  assert.equal(h.id, "sb-1");
  assert.equal(calls[0]?.[0], "inspect");
});

test("attach: throws SandboxUnavailableError for a missing container", async () => {
  const sb = new NetSandbox({
    mounts: stubMounts(),
    exec: async () => {
      throw new Error("docker inspect failed: Error: No such object: pomtree-sb-1");
    },
  });
  await assert.rejects(sb.attach("sb-1", "ag-1"), SandboxUnavailableError);
});

test("attach: throws SandboxUnavailableError for an exited (not running) container", async () => {
  const sb = new NetSandbox({ mounts: stubMounts(), exec: async () => "false 137 false" });
  await assert.rejects(sb.attach("sb-1", "ag-1"), SandboxUnavailableError);
});

test("start: repeating the same idempotency key returns the same handle without a second container", async () => {
  const runs: string[][] = [];
  const containers = new Map<string, string>();
  const exec: Exec = async (args) => {
    if (args[0] === "run") {
      runs.push(args);
      const container = args[3]!; // run -d --name <name> ...
      containers.set(container, "true 0 false none");
      return container;
    }
    if (args[0] === "inspect") {
      const container = args[args.length - 1]!;
      const state = containers.get(container);
      if (state === undefined) throw new Error(`docker inspect failed: Error: No such object: ${container}`);
      return state;
    }
    return "";
  };
  const sb = new NetSandbox({ mounts: stubMounts(), exec });
  const first = await sb.start(spec, "same-key");
  const second = await sb.start(spec, "same-key");
  assert.equal(second.id, first.id);
  assert.equal(runs.filter((args) => args.includes("pomtree.agent=a")).length, 1);
  const other = await sb.start(spec, "other-key");
  assert.notEqual(other.id, first.id);
  assert.equal(runs.filter((args) => args.includes("pomtree.agent=a")).length, 2);
});

test("egress-start-leak: a sandbox docker run failure after startEgress reclaims the proxy/network", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({
    mounts: stubMounts(),
    enforceEgress: true,
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "inspect") throw new Error("No such object");
      if (args[0] === "run") {
        if (String(args[3]).startsWith("pomtree-egress-proxy-")) return "proxy-cid"; // the sidecar run succeeds
        throw new Error("docker run failed: manifest for nope:latest not found"); // the sandbox run fails
      }
      return "";
    },
  });
  await assert.rejects(sb.start(egressSpec, "k-egress-leak"), SandboxStartError);
  assert.ok(calls.some((c) => c[0] === "rm" && String(c[2]).startsWith("pomtree-egress-proxy-")));
  assert.ok(calls.some((c) => c[0] === "volume" && c[1] === "rm" && String(c[2]).startsWith("pomtree-egress-socket-")));
});

test("egress cleanup derives names from the sandbox id, so a restarted instance (no in-memory map) still reclaims", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    if (args[0] === "inspect") throw new Error("No such object");
    return "";
  };
  const h = await new NetSandbox({ mounts: stubMounts(), enforceEgress: true, exec }).start(egressSpec, "k-egress-reclaim");
  // A fresh instance models a daemon restart: nothing remembers the proxy/network, but the names are
  // deterministic, so kill() still removes them.
  await new NetSandbox({ mounts: stubMounts(), enforceEgress: true, exec }).kill(h.id, `test-kill:${h.id}`);
  assert.ok(calls.some((c) => c[0] === "rm" && c[2] === `pomtree-egress-proxy-${h.id}`));
  assert.ok(calls.some((c) => c[0] === "volume" && c[1] === "rm" && c[2] === `pomtree-egress-socket-${h.id}`));
});

test("list: tab-delimited labels survive empty and spaced values", async () => {
  const mine = '{"store_id":"s1","daemon_epoch":"1"}';
  const rows: Record<string, string> = {
    "container-1": `sb-1\tag with space\t${mine}`,
    "container-2": `sb-2\t\t${mine}`,
    "container-3": `\tag-3\t${mine}`,
  };
  const sb = new NetSandbox({
    mounts: stubMounts(),
    exec: async (args) => (args[0] === "ps" ? "container-1\ncontainer-2\ncontainer-3" : rows[args.at(-1)!]!),
  });
  const base = { backend: "docker", host: null, generation: null, state: "unknown", labels: { store_id: "s1", daemon_epoch: "1" } };
  assert.deepEqual(await sb.list(OWNER), [
    { id: "sb-1", agent: "ag with space", ...base },
    { id: "sb-2", agent: "", ...base },
    { id: "", agent: "ag-3", ...base },
  ]);
});

test("list: exposes caller labels (not reserved ones) and run applies spec.labels", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({
    mounts: stubMounts(),
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "ps") return "container-1\ncontainer-2";
      return args.at(-1) === "container-1"
        ? 'sb-1\tag\t{"pomtree":"1","pomtree.sandbox":"sb-1","daemon_epoch":"1","store_id":"s1","note":"a,b"}'
        : 'sb-2\tag2\t{"pomtree":"1","daemon_epoch":"1","store_id":"s1"}';
    },
  });
  assert.deepEqual(await sb.list(OWNER), [
    { id: "sb-1", agent: "ag", backend: "docker", host: null, generation: null, state: "unknown", labels: { daemon_epoch: "1", store_id: "s1", note: "a,b" } },
    { id: "sb-2", agent: "ag2", backend: "docker", host: null, generation: null, state: "unknown", labels: { daemon_epoch: "1", store_id: "s1" } },
  ]);
  assert.deepEqual(calls[0], ["ps", "-aq", "--filter", "label=pomtree=1"]);
  assert.deepEqual(calls[1]?.slice(0, 3), [
    "inspect",
    "--format",
    '{{index .Config.Labels "pomtree.sandbox"}}\t{{index .Config.Labels "pomtree.agent"}}\t{{json .Config.Labels}}\t{{.Image}}\t{{.State.Status}}',
  ]);
  assert.equal(calls[1]?.[3], "container-1");
  assert.equal(calls[2]?.[3], "container-2");
  const run: string[][] = [];
  const sb2 = new NetSandbox({
    mounts: stubMounts(),
    exec: async (args) => {
      run.push(args);
      if (args[0] === "inspect") throw new Error("No such object");
      return "";
    },
  });
  await sb2.start({ ...spec, labels: { daemon_epoch: "e1" } }, "k-labels");
  const r = run.find((a) => a[0] === "run" && a.includes("pomtree.agent=a"))!;
  assert.ok(r.some((a, i) => a === "--label" && r[i + 1] === "daemon_epoch=e1"));
  await assert.rejects(
    new NetSandbox({
      mounts: stubMounts(),
      exec: async (a) => {
        if (a[0] === "inspect") throw new Error("No such object");
        return "";
      },
    }).start({ ...spec, labels: { "pomtree.agent": "x" } }, "k-bad"),
    /invalid sandbox label/,
  );
});

test("list: image-inherited labels are not caller labels; a caller override of an image label stays", async () => {
  const image = { "org.opencontainers.image.revision": "abc", maintainer: "img" };
  const sb = new NetSandbox({
    mounts: stubMounts(),
    exec: async (args) => {
      if (args[0] === "ps") return "c1\nc2";
      if (args[0] === "image") return JSON.stringify(image);
      const labels = { pomtree: "1", ...image, daemon_epoch: "1", store_id: "s1", ...(args.at(-1) === "c2" ? { maintainer: "caller" } : {}) };
      return `sb\tag\t${JSON.stringify(labels)}\tsha256:img`;
    },
  });
  const [a, b] = await sb.list(OWNER);
  assert.deepEqual(a?.labels, { daemon_epoch: "1", store_id: "s1" });
  assert.equal(Object.hasOwn(a?.labels ?? {}, "org.opencontainers.image.revision"), false);
  assert.deepEqual(b?.labels, { daemon_epoch: "1", store_id: "s1", maintainer: "caller" });
});

test("list: a container disappearing during inspect does not hide survivors", async () => {
  const sb = new NetSandbox({
    mounts: stubMounts(),
    exec: async (args) => {
      if (args[0] === "ps") return "gone\nsurvivor";
      if (args.at(-1) === "gone") throw new Error("docker inspect failed: Error: No such object: gone");
      return 'sb-live\tag-live\t{"pomtree":"1","daemon_epoch":"1","store_id":"s1"}\timg\trunning';
    },
  });
  assert.deepEqual(await sb.list(OWNER), [
    { id: "sb-live", agent: "ag-live", backend: "docker", host: null, generation: null, state: "running", labels: { daemon_epoch: "1", store_id: "s1" } },
  ]);
});

test("list: Docker status maps to state, and other owners' containers are dropped", async () => {
  const rows: Record<string, string> = {
    c1: 'a\tag\t{"store_id":"s1","daemon_epoch":"1"}\timg\tcreated',
    c2: 'b\tag\t{"store_id":"s1","daemon_epoch":"0"}\timg\trunning',
    c3: 'c\tag\t{"store_id":"s1","daemon_epoch":"2"}\timg\trunning',
    c4: 'd\tag\t{"store_id":"s2","daemon_epoch":"1"}\timg\trunning',
    c5: 'e\tag\t{"daemon_epoch":"1"}\timg\trunning',
    c6: "f\tag\t{}\timg\trunning",
    c7: 'g\tag\t{"store_id":"s1","daemon_epoch":"1"}\timg\tpaused',
    c8: 'h\tag\t{"store_id":"s1","daemon_epoch":"1"}\timg\tdead',
    c9: 'i\tag\t{"store_id":"s1","daemon_epoch":"1"}\timg\tremoving',
    c10: 'j\tag\t{"store_id":"s1","daemon_epoch":"1"}\timg\trestarting',
  };
  const sb = new NetSandbox({
    mounts: stubMounts(),
    exec: async (args) => (args[0] === "ps" ? Object.keys(rows).join("\n") : args[0] === "image" ? "{}" : rows[args.at(-1)!]!),
  });
  const listed = await sb.list(OWNER);
  assert.deepEqual(
    listed.map((l) => [l.id, l.state]),
    [
      ["a", "creating"],
      ["b", "running"],
      ["e", "running"],
      ["f", "running"],
      ["g", "paused"],
      ["h", "exited"],
      ["i", "stopped"],
      ["j", "unknown"],
    ],
  );
  // A different owner: only unlabelled-by-store containers (e, f) and none of the others' store s1/s2 ones remain.
  assert.deepEqual(
    (await sb.list({ ...OWNER, storeId: "s3" })).map((l) => l.id),
    ["e", "f"],
  );
  assert.deepEqual((await sb.list({ ...OWNER, epoch: 2 })).map((l) => l.id).sort(), ["a", "b", "c", "e", "f", "g", "h", "i", "j"]);
});

test("egress proxy and network carry the egress label; reclaim removes only orphaned ones", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    if (args[0] === "inspect" && args.at(-1) === "live-container") return 'live1\tag\t{"pomtree":"1"}';
    if (args[0] === "inspect") throw new Error("No such object");
    if (args[0] === "ps" && args.includes("label=pomtree=1")) return "live-container";
    // id, store_id, daemon_epoch: all owned by this instance's owner, so only liveness decides here (scope: egress-reclaim.test.ts).
    if (args[0] === "ps") return "live1\ts1\t1\norph1\ts1\t1";
    if (args[0] === "volume" && args[1] === "ls") return "orph2\ts1\t1\nlive1\ts1\t1";
    return "";
  };
  const sb = new NetSandbox({ mounts: stubMounts(), enforceEgress: true, exec });
  await sb.start(egressSpec, "k-egress-label");
  assert.ok(calls.some((c) => c[0] === "volume" && c[1] === "create" && c.includes("pomtree.egress=1")));
  assert.ok(calls.some((c) => c[0] === "run" && c[3]?.startsWith("pomtree-egress-proxy-") && c.includes("pomtree.egress=1")));
  calls.length = 0;
  assert.deepEqual((await sb.reclaim(OWNER)).sort(), ["orph1", "orph2"]);
  assert.ok(calls.some((c) => c[0] === "rm" && c[2] === "pomtree-egress-proxy-orph1"));
  assert.ok(calls.some((c) => c[0] === "volume" && c[1] === "rm" && c[2] === "pomtree-egress-socket-orph2"));
  assert.ok(!calls.some((c) => c.includes("pomtree-egress-proxy-live1")));
  assert.ok(!calls.some((c) => c[0] === "network"), "the orphan sweep never touches the shared network");
});

test("exited cache is bounded: oldest delivered-exit entries are evicted past the cap", async () => {
  const exec: Exec = async (args) => {
    if (args[0] === "inspect") throw new Error("No such object");
    if (args[0] === "run") return "cid";
    if (args[0] === "wait") return "0";
    return "";
  };
  const sb = new NetSandbox({ mounts: stubMounts(), maxExitedCache: 2, exec });
  const h1 = await sb.start(spec, "k-cache-1");
  const h2 = await sb.start(spec, "k-cache-2");
  const h3 = await sb.start(spec, "k-cache-3");
  await sb.kill(h1.id, `test-kill:${h1.id}`);
  await sb.kill(h2.id, `test-kill:${h2.id}`);
  await sb.kill(h3.id, `test-kill:${h3.id}`);
  assert.equal(await sb.inspect(h1.id), null); // evicted (oldest)
  assert.deepEqual(await sb.inspect(h2.id), { running: false, exitCode: 0, status: "exited" });
  assert.deepEqual(await sb.inspect(h3.id), { running: false, exitCode: 0, status: "exited" });
});

test("start: an egress sidecar failure is egress_start_failed (not unknown), never retryable, and no worker container is run", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({
    mounts: stubMounts(),
    enforceEgress: true,
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "inspect") throw new Error("No such object");
      if (args[0] === "run" && String(args[3]).startsWith("pomtree-egress-proxy-")) throw new Error("docker run failed: port is already allocated");
      return "";
    },
  });
  await assert.rejects(
    sb.start(egressSpec, "k-egress-fail"),
    (e: unknown) =>
      e instanceof SandboxStartError &&
      e.kind === "egress_start_failed" &&
      !e.retryable &&
      /^egress proxy start failed: .*port is already allocated/.test(e.message),
  );
  assert.ok(!calls.some((c) => c[0] === "run" && !String(c[3]).startsWith("pomtree-egress-proxy-")), "the worker never starts after a failed sidecar");
});

test("start: Docker down while standing up egress stays endpoint_unreachable (retryable), and a worker image miss stays image_unavailable", async () => {
  const down = new NetSandbox({
    mounts: stubMounts(),
    enforceEgress: true,
    exec: async (args) => {
      if (args[0] === "inspect") throw new Error("No such object");
      if (args[0] === "network" || args[0] === "volume") throw new SandboxUnavailableError();
      return "";
    },
  });
  await assert.rejects(
    down.start(egressSpec, "k-egress-down"),
    (e: unknown) => e instanceof SandboxStartError && e.kind === "endpoint_unreachable" && e.retryable,
  );
  const image = new NetSandbox({
    mounts: stubMounts(),
    enforceEgress: true,
    exec: async (args) => {
      if (args[0] === "inspect") throw new Error("No such object");
      if (args[0] === "run" && !String(args[3]).startsWith("pomtree-egress-proxy-")) throw new Error("docker run failed: manifest for nope:latest not found");
      return "";
    },
  });
  await assert.rejects(
    image.start(egressSpec, "k-worker-image"),
    (e: unknown) => e instanceof SandboxStartError && e.kind === "image_unavailable" && !e.retryable,
  );
});

test("classifyStartError: classifies start failures into the typed SandboxStartError", () => {
  const image = classifyStartError(new Error("docker run failed: Error response from daemon: manifest for nope:latest not found"));
  assert.ok(image instanceof SandboxStartError);
  assert.equal(image.kind, "image_unavailable");
  assert.equal(image.retryable, false);

  const pull = classifyStartError(new Error("docker run failed: error pulling image configuration: dial tcp: i/o timeout"));
  assert.ok(pull instanceof SandboxStartError);
  assert.equal(pull.kind, "pull_failed");
  assert.equal(pull.retryable, true);

  const endpoint = classifyStartError(new SandboxUnavailableError());
  assert.ok(endpoint instanceof SandboxStartError);
  assert.equal(endpoint.kind, "endpoint_unreachable");
  assert.equal(endpoint.retryable, true);

  const unknown = classifyStartError(new Error("docker run failed: something else"));
  assert.ok(unknown instanceof SandboxStartError);
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.retryable, false);
});

test("classifyDockerError: daemon-unreachable diagnostics map to SandboxUnavailableError", () => {
  const messages = [
    "docker info failed: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    'docker info failed: error during connect: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/info": dial unix /var/run/docker.sock: connect: connection refused',
    "docker info failed: error during connect: dial unix /var/run/docker.sock: connect: no such file or directory",
  ];
  for (const msg of messages) assert.ok(classifyDockerError(new Error(msg)) instanceof SandboxUnavailableError, msg);
});

test("classifyDockerError: other docker failures stay generic", () => {
  const e = new Error("docker run failed: Error response from daemon: manifest for nope:latest not found");
  assert.equal(classifyDockerError(e), e);
  assert.ok(!(classifyDockerError(e) instanceof SandboxUnavailableError));
});

test("exit-race: wait on a container removed before exit was observed fails with a clear error", async () => {
  const exec: Exec = async (args) => {
    if (args[0] === "wait") throw new Error("docker wait failed: Error: No such container: pomtree-x");
    if (args[0] === "inspect") throw new Error("docker inspect failed: Error: No such object: x");
    return "";
  };
  const h = await new NetSandbox({ mounts: stubMounts(), exec }).start(spec, "k-exit-race");
  await assert.rejects(h.wait(), /removed before its exit was observed/);
});

test("spawn-fail: a hung docker run times out as retryable pull_failed after bounded retries and removes the container", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    if (args[0] === "inspect") throw new Error("No such object: x");
    // Hang only the sandbox run: the egress proxy sidecar run (also `docker run`) must succeed.
    if (args[0] === "run" && !String(args[3]).startsWith("pomtree-egress-proxy-")) return new Promise<string>(() => {});
    return "";
  };
  const sb = new NetSandbox({ mounts: stubMounts(), exec, startTimeoutMs: 10, startRetries: 1, retryDelayMs: () => 0 });
  await assert.rejects(sb.start(spec, "k-hang"), (e: unknown) => e instanceof SandboxStartError && e.kind === "pull_failed" && e.retryable);
  assert.equal(calls.filter((c) => c[0] === "run" && !String(c[3]).startsWith("pomtree-egress-proxy-")).length, 2);
  assert.ok(calls.some((c) => c[0] === "rm"));
});

test("spawn-fail: a transient pull failure is retried and then succeeds; image_unavailable is not retried", async () => {
  let runs = 0;
  const exec: Exec = async (args) => {
    if (args[0] === "inspect") throw new Error("No such object: x");
    if (args[0] === "run" && !String(args[3]).startsWith("pomtree-egress-proxy-")) {
      runs++;
      if (runs === 1) throw new Error("docker run failed: error pulling image: i/o timeout");
    }
    return "";
  };
  const h = await new NetSandbox({ mounts: stubMounts(), exec, retryDelayMs: () => 0 }).start(spec, "k-retry");
  assert.ok(h.id);
  assert.equal(runs, 2);
  runs = 0;
  const bad: Exec = async (args) => {
    if (args[0] === "inspect") throw new Error("No such object: x");
    if (args[0] === "run" && !String(args[3]).startsWith("pomtree-egress-proxy-")) {
      runs++;
      throw new Error("manifest for nope not found");
    }
    return "";
  };
  await assert.rejects(
    new NetSandbox({ mounts: stubMounts(), exec: bad, retryDelayMs: () => 0 }).start(spec, "k-bad"),
    (e: unknown) => e instanceof SandboxStartError && e.kind === "image_unavailable",
  );
  assert.equal(runs, 1);
});

test("start: a transient `bind source path does not exist` is retried after rm -f; other run errors are not", async () => {
  const calls: string[][] = [];
  let runs = 0;
  const exec: Exec = async (args) => {
    calls.push(args);
    if (args[0] === "inspect") throw new Error("No such object: x");
    if (args[0] === "run" && !String(args[3]).startsWith("pomtree-egress-proxy-")) {
      runs++;
      if (runs <= 2) throw new Error('docker run failed: invalid mount config for type "bind": bind source path does not exist: /host_mnt/x');
    }
    return "";
  };
  const h = await new NetSandbox({ mounts: stubMounts(), exec }).start(spec, "k-mount-race");
  assert.equal(runs, 3);
  assert.equal(calls.filter((c) => c[0] === "rm" && c[2] === `pomtree-${h.id}`).length, 2);
  // Bounded: a persistent failure gives up after 2 extra attempts.
  runs = 0;
  const always: Exec = async (args) => {
    if (args[0] === "inspect") throw new Error("No such object: x");
    if (args[0] === "run" && !String(args[3]).startsWith("pomtree-egress-proxy-")) {
      runs++;
      throw new Error("docker run failed: bind source path does not exist: /host_mnt/x");
    }
    return "";
  };
  await assert.rejects(new NetSandbox({ mounts: stubMounts(), exec: always }).start(spec, "k-mount-race-2"), SandboxStartError);
  assert.equal(runs, 3);
});

// A fake docker for the egress readiness-probe failure: the proxy `run -d` succeeds, the probe `exec` loses the race.
function probeFailure(state: string | Error, logs: string | Error = "") {
  const calls: string[][] = [];
  const warnings: string[] = [];
  const sb = new NetSandbox({
    mounts: stubMounts(),
    enforceEgress: true,
    warn: (m) => warnings.push(m),
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "exec") throw new Error("docker exec failed: Error response from daemon: No such exec instance: abc");
      if (args[0] === "inspect" && args[1] === "-f" && args[3]?.startsWith("pomtree-egress-proxy-")) {
        if (state instanceof Error) throw state;
        return state;
      }
      if (args[0] === "inspect") throw new Error("No such object");
      if (args[0] === "logs") {
        if (logs instanceof Error) throw logs;
        return logs;
      }
      return "";
    },
  });
  return { sb, calls, warnings };
}
const exited = (extra = "") =>
  `{"Status":"exited","Running":false,"ExitCode":1,"OOMKilled":false,"Error":"${extra}","StartedAt":"2026-10-01T00:00:00Z","FinishedAt":"2026-10-01T00:00:01Z"}`;

test("start: an egress sidecar that exited during startup reports its exit code, log tail and the rebuild action, read before rm -f", async () => {
  const line = "Error: invalid immutable egress config (invalid egress limits); this proxy does not accept the config pomtreed sent";
  const { sb, calls, warnings } = probeFailure(exited(), `noise\n${line}\n`);
  await assert.rejects(
    sb.start(egressSpec, "k-probe-exited"),
    (e: unknown) =>
      e instanceof SandboxStartError &&
      e.kind === "egress_start_failed" &&
      !e.retryable &&
      e.message.includes("exit code 1") &&
      e.message.includes(line) &&
      e.message.includes("scripts/pomtree-up --rebuild") &&
      !e.message.includes("OOM") &&
      e.message.length < 900,
  );
  const at = (pred: (c: string[]) => boolean) => calls.findLastIndex(pred);
  const rm = at((c) => c[0] === "rm" && c[2]?.startsWith("pomtree-egress-proxy-") === true);
  assert.ok(at((c) => c[0] === "inspect" && c[3]?.startsWith("pomtree-egress-proxy-") === true) < rm, "inspect before rm -f");
  assert.ok(at((c) => c[0] === "logs") < rm, "logs before rm -f");
  assert.equal(warnings.length, 1, "the operator sees it through warn");
  assert.match(warnings[0]!, /exit code 1/);
});

test("start: a sidecar still running after the probe failed is a retryable egress_start_failed naming the probe error", async () => {
  const { sb } = probeFailure('{"Status":"running","Running":true,"ExitCode":0,"OOMKilled":false,"Error":""}');
  await assert.rejects(
    sb.start(egressSpec, "k-probe-running"),
    (e: unknown) =>
      e instanceof SandboxStartError &&
      e.kind === "egress_start_failed" &&
      e.retryable &&
      /No such exec instance/.test(e.message) &&
      /still running/.test(e.message) &&
      /respawn the agent/.test(e.message),
  );
});

test("start: an OOM-killed sidecar is told to get more memory, not to rebuild; no log output is said", async () => {
  const { sb } = probeFailure(exited().replace('"OOMKilled":false', '"OOMKilled":true').replace('"ExitCode":1', '"ExitCode":137'));
  await assert.rejects(
    sb.start(egressSpec, "k-probe-oom"),
    (e: unknown) =>
      e instanceof SandboxStartError &&
      !e.retryable &&
      /exit code 137, OOM-killed/.test(e.message) &&
      /more memory/.test(e.message) &&
      !/pomtree-up --rebuild/.test(e.message) &&
      /\(no log output\)/.test(e.message),
  );
});

test("start: a sidecar that cannot be inspected keeps the exec error and adds the docker events action; a failing logs call does not mask the exit state", async () => {
  const gone = probeFailure(new Error("docker inspect failed: No such object"));
  await assert.rejects(
    gone.sb.start(egressSpec, "k-probe-gone"),
    (e: unknown) =>
      e instanceof SandboxStartError &&
      e.kind === "egress_start_failed" &&
      !e.retryable &&
      /^egress proxy start failed: .*No such exec instance/.test(e.message) &&
      /docker events/.test(e.message) &&
      /scripts\/pomtree-up --rebuild/.test(e.message),
  );
  const noLogs = probeFailure(exited(), new Error("docker logs failed: boom"));
  await assert.rejects(
    noLogs.sb.start(egressSpec, "k-probe-nologs"),
    (e: unknown) => e instanceof SandboxStartError && /exit code 1.*no log output/.test(e.message),
  );
});

test("start: negative control, a proxy `run -d` that itself fails is never diagnosed (no inspect -f or logs) and keeps its classification", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({
    mounts: stubMounts(),
    enforceEgress: true,
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "inspect") throw new Error("No such object");
      if (args[0] === "run") throw new Error("docker run failed: port is already allocated");
      return "";
    },
  });
  await assert.rejects(
    sb.start(egressSpec, "k-probe-norun"),
    (e: unknown) => e instanceof SandboxStartError && /^egress proxy start failed: .*port is already allocated/.test(e.message),
  );
  assert.ok(!calls.some((c) => c[0] === "logs" || (c[0] === "inspect" && c[1] === "-f" && c[3]?.startsWith("pomtree-egress-proxy-"))));
});

test("classify: the docker socket permission error is endpoint_unreachable, not retryable, with the group action; unreachable stays retryable", async () => {
  for (const msg of [
    "docker run failed: permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get ...",
    "docker run failed: permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
  ]) {
    const err = classifyDockerError(new Error(msg));
    assert.ok(!(err instanceof SandboxUnavailableError), msg);
    const typed = classifyStartError(err);
    assert.equal(typed.kind, "endpoint_unreachable");
    assert.equal(typed.retryable, false);
    assert.ok(typed.message.startsWith("docker socket permission denied: ") && typed.message.includes(msg));
    assert.match(typed.message, /usermod -aG docker \$USER.*log out and back in/);
  }
  const down = classifyStartError(
    classifyDockerError(new Error("docker run failed: Cannot connect to the Docker daemon at unix:///x. Is the docker daemon running?")),
  );
  assert.equal(down.kind, "endpoint_unreachable");
  assert.equal(down.retryable, true);
  const sb = new NetSandbox({
    mounts: stubMounts(),
    enforceEgress: true,
    exec: async (args) => {
      if (args[0] === "inspect") throw new Error("No such object");
      if (args[0] === "volume" && args[1] === "create")
        throw new Error("docker volume failed: permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock");
      return "";
    },
  });
  await assert.rejects(sb.start(egressSpec, "k-eg-perm"), (e: unknown) => e instanceof SandboxStartError && e.kind === "endpoint_unreachable" && !e.retryable);
});

test("start: a docker socket permission failure from the real start path carries the docker-group action in the message the daemon records", async () => {
  const sb = new NetSandbox({
    mounts: stubMounts(),
    exec: async (args) => {
      if (args[0] === "inspect") throw new Error("No such object");
      throw new Error("docker run failed: permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock");
    },
  });
  await assert.rejects(
    sb.start(spec, "k-perm-start"),
    (e: unknown) => e instanceof SandboxStartError && !e.retryable && /usermod -aG docker \$USER.*log out and back in/.test(e.message),
  );
});

test("egressProbeFailure: a huge last log line, State.Error and probe error are clipped so the action survives the budget", () => {
  const huge = "x".repeat(20_000);
  const e = egressProbeFailure(exited(huge), `noise\n${"y".repeat(20_000)}\n`, "z".repeat(20_000));
  assert.equal(e.kind, "egress_start_failed");
  assert.ok(e.message.length <= 900, `message is ${e.message.length} chars`);
  assert.ok(e.message.includes(`; ${IMAGE_REBUILD_ACTION}`), "the rebuild action is kept");
  assert.match(e.message, /^egress proxy exited during startup \(exit code 1, docker: x{100,}…\): y{100,}…; rebuild/);
  const running = egressProbeFailure('{"Status":"running","Running":true}', "", "z".repeat(20_000));
  assert.ok(running.message.length < 900 && running.message.endsWith(IMAGE_REBUILD_ACTION));
  // negative control: short fields are not clipped
  assert.match(egressProbeFailure(exited("short"), "the last line\n", "p").message, /docker: short\): the last line; rebuild/);
});

test("egressProbeFailure: inspect output that is not a State object and a never-started (created) sidecar each say what they are", () => {
  for (const bad of ["not json", "[]", "null", ""]) {
    const e = egressProbeFailure(bad, "", "No such exec instance");
    assert.equal(e.kind, "egress_start_failed");
    assert.equal(e.retryable, false);
    assert.match(e.message, /^egress proxy readiness probe failed \(No such exec instance\) and `docker inspect` returned an unreadable state/, bad);
    assert.doesNotMatch(e.message, /it is gone|exited during startup/, bad);
  }
  const created = egressProbeFailure(
    '{"Status":"created","Running":false,"ExitCode":0,"OOMKilled":false,"Error":"oci runtime: boom"}',
    "",
    "No such exec instance",
  );
  assert.equal(created.retryable, false);
  assert.match(
    created.message,
    /^egress proxy container was created but never started \(No such exec instance, docker: oci runtime: boom\); check `docker events`/,
  );
  assert.doesNotMatch(created.message, /exited during startup|exit code 0|pomtree-up --rebuild/);
  // negative control: an exited sidecar keeps the exit wording
  assert.match(egressProbeFailure(exited(), "", "p").message, /^egress proxy exited during startup \(exit code 1\)/);
});

test("start: inspect output that cannot be parsed is reported as unreadable, not as a sidecar that is gone", async () => {
  const { sb, warnings } = probeFailure("<no value>");
  await assert.rejects(
    sb.start(egressSpec, "k-probe-unparsable"),
    (e: unknown) => e instanceof SandboxStartError && /unreadable state \(<no value>\)/.test(e.message) && !/it is gone/.test(e.message),
  );
  assert.equal(warnings.length, 1);
});

test("removalRace: matches Docker's removal-in-progress message from rm, and nothing else", () => {
  assert.equal(removalRace(new Error("Error response from daemon: removal of container pomtree-sb-1 is already in progress")), true);
  assert.equal(removalRace("removal of container x is already in progress"), true);
  for (const other of [
    "Error response from daemon: No such container: pomtree-sb-1",
    "Error response from daemon: driver overlay2 failed to remove root filesystem: device or resource busy",
    "container is not running",
    "pull already in progress",
    "",
  ])
    assert.equal(removalRace(new Error(other)), false, other);
});

test("list: includes own and store-unlabelled containers; excludes another store's and a newer epoch's", async () => {
  const rows: Record<string, string> = {
    c1: 'own\tag\t{"store_id":"s1","daemon_epoch":"1"}\timg\trunning',
    c2: "unlabelled\tag\t{}\timg\trunning",
    c3: 'other-store\tag\t{"store_id":"s2","daemon_epoch":"1"}\timg\trunning',
    c4: 'newer-epoch\tag\t{"store_id":"s1","daemon_epoch":"2"}\timg\trunning',
  };
  const sb = new NetSandbox({
    mounts: stubMounts(),
    exec: async (args) => (args[0] === "ps" ? Object.keys(rows).join("\n") : args[0] === "image" ? "{}" : rows[args.at(-1)!]!),
  });
  assert.deepEqual(
    (await sb.list(OWNER)).map((l) => l.id),
    ["own", "unlabelled"],
  );
});
