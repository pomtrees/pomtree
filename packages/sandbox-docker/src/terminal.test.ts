import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Duplex, PassThrough } from "node:stream";
import { SandboxUnavailableError } from "@pomtree/core";
import { buildRunArgs } from "./args.ts";
import { resolvedWs, stubMounts, wsMount } from "./test-mounts.ts";
import { DockerSandbox, type Exec } from "./docker.ts";
import { NetSandbox } from "./test-network.ts";
import {
  buildAttachRequest,
  buildResizeRequest,
  createTerminalSession,
  engineSocketPath,
  type EngineApi,
  type EngineRequest,
  type TerminalSocket,
} from "./terminal.ts";

// A duplex socket: push() is server -> us output; our writes land in `sent`.
function fakeSocket() {
  const sent: Buffer[] = [];
  let destroyed = 0;
  const sock = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      sent.push(Buffer.from(chunk));
      cb();
    },
    destroy(err, cb) {
      destroyed++;
      cb(err);
    },
  });
  return { sock, sent, destroyed: () => destroyed, push: (b: string | Buffer) => sock.push(b), end: () => sock.push(null) };
}

test("attach/resize request building", () => {
  const a = buildAttachRequest("pomtree-x");
  assert.equal(a.method, "POST");
  assert.equal(a.path, "/containers/pomtree-x/attach?stream=1&stdin=1&stdout=1&stderr=1&detachKeys=ctrl-%5E");
  assert.deepEqual(a.headers, { Connection: "Upgrade", Upgrade: "tcp" });
  assert.equal(buildResizeRequest("pomtree-x", 120, 40).path, "/containers/pomtree-x/resize?h=40&w=120");
  assert.throws(() => buildResizeRequest("c", 0, 24), RangeError);
  assert.throws(() => buildResizeRequest("c", 80, 1.5), RangeError);
});

test("engineSocketPath: default, unix:// DOCKER_HOST, tcp rejected", () => {
  assert.equal(engineSocketPath(undefined), "/var/run/docker.sock");
  assert.equal(engineSocketPath("unix:///run/user/1000/docker.sock"), "/run/user/1000/docker.sock");
  assert.throws(() => engineSocketPath("tcp://1.2.3.4:2375"), SandboxUnavailableError);
});

test("buildRunArgs: tty adds -i -t; absent keeps the non-tty run; hardening stays", () => {
  const spec = { agent: "a", image: "i", env: {}, mounts: [wsMount("/w")] };
  const plain = buildRunArgs("id", spec, { mounts: [resolvedWs("/w")] });
  assert.ok(!plain.includes("-t") && !plain.includes("-i"));
  const tty = buildRunArgs("id", { ...spec, tty: { cols: 100, rows: 30 } }, { mounts: [resolvedWs("/w")] });
  assert.deepEqual(tty.slice(0, 4), ["run", "-d", "-i", "-t"]);
  for (const f of ["--read-only", "--cap-drop=ALL", "--init"]) assert.ok(tty.includes(f));
});

test("session: head bytes first, then data; end ends output and settles closed", async () => {
  const f = fakeSocket();
  const s = createTerminalSession(f.sock as TerminalSocket, Buffer.from("head"), async () => {});
  f.push("body");
  f.end();
  const got: string[] = [];
  for await (const b of s.output()) got.push(Buffer.from(b).toString());
  assert.equal(got.join(""), "headbody");
  assert.deepEqual(await s.closed, { reason: "remote" });
  await assert.rejects(s.write("x"), /closed/);
});

test("session: write waits for drain under backpressure", async () => {
  const ee = new PassThrough();
  let done = false;
  const fake = Object.assign(ee, { write: () => false }) as unknown as TerminalSocket;
  const s = createTerminalSession(fake, new Uint8Array(), async () => {});
  const w = s.write("abc").then(() => (done = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  ee.emit("drain");
  await w;
  assert.equal(done, true);
  s.close();
});

test("session: pending write rejects when the session closes", async () => {
  const ee = new PassThrough();
  const fake = Object.assign(ee, { write: () => false }) as unknown as TerminalSocket;
  const s = createTerminalSession(fake, new Uint8Array(), async () => {});
  const w = s.write("abc");
  s.close();
  await assert.rejects(w, /closed/);
});

test("session: pauses the socket past high water and resumes once drained", async () => {
  const calls: string[] = [];
  const ee = new EventEmitter();
  const fake = Object.assign(ee, {
    destroy: () => ee,
    pause: () => {
      calls.push("pause");
      return ee;
    },
    resume: () => {
      calls.push("resume");
      return ee;
    },
  }) as unknown as TerminalSocket;
  const s = createTerminalSession(fake, new Uint8Array(), async () => {}, undefined, { highWater: 10, lowWater: 4 });
  ee.emit("data", Buffer.alloc(12));
  assert.deepEqual(calls, ["pause"]);
  await s.output()[Symbol.asyncIterator]().next();
  assert.deepEqual(calls, ["pause", "resume"]);
  s.close();
});

test("session: close is idempotent, destroys once, reason local, ends output", async () => {
  const f = fakeSocket();
  const s = createTerminalSession(f.sock as TerminalSocket, Buffer.from("x"), async () => {});
  s.close();
  s.close();
  assert.equal(f.destroyed(), 1);
  assert.deepEqual(await s.closed, { reason: "local" });
  const got: Uint8Array[] = [];
  for await (const b of s.output()) got.push(b);
  assert.equal(got.length, 0);
  await s.resize(10, 10); // no-op after close
});

test("session: socket error mid-stream rejects output and settles closed with the error", async () => {
  const f = fakeSocket();
  const s = createTerminalSession(f.sock as TerminalSocket, new Uint8Array(), async () => {});
  const pending = s.output()[Symbol.asyncIterator]().next();
  f.sock.destroy(new Error("ECONNRESET"));
  await assert.rejects(pending, /ECONNRESET/);
  assert.equal((await s.closed).reason, "error");
});

test("session: redraw nudges cols+1 then back; without a known size it rejects", async () => {
  const f = fakeSocket();
  const sizes: [number, number][] = [];
  const s = createTerminalSession(f.sock as TerminalSocket, new Uint8Array(), async (c, r) => {
    sizes.push([c, r]);
  });
  await assert.rejects(s.redraw(), /size unknown/);
  await s.resize(80, 24);
  await s.redraw();
  assert.deepEqual(sizes, [
    [80, 24],
    [81, 24],
    [80, 24],
  ]);
  s.close();
});

// --- DockerSandbox.openTerminal over an injected engine ---
function fakeEngine(opts: { fail?: Error; resizeStatus?: number } = {}) {
  const f = fakeSocket();
  const requests: EngineRequest[] = [];
  const upgrades: EngineRequest[] = [];
  const api: EngineApi = {
    request: async (r) => {
      requests.push(r);
      return { status: opts.resizeStatus ?? 200, body: "" };
    },
    upgrade: async (r) => {
      upgrades.push(r);
      if (opts.fail) throw opts.fail;
      return { socket: f.sock as TerminalSocket, head: Buffer.from("hi") };
    },
  };
  return { api, f, requests, upgrades };
}
const inspectExec =
  (running: boolean): Exec =>
  async (args) =>
    args[0] === "inspect" ? `${running} 0 false` : "";

test("openTerminal: attaches by container name, applies initial size, streams head and writes", async () => {
  const e = fakeEngine();
  const s = await new DockerSandbox({ mounts: stubMounts(), exec: inspectExec(true), engine: e.api }).openTerminal("sid", { cols: 90, rows: 30 });
  assert.ok(e.upgrades[0]!.path.startsWith("/containers/pomtree-sid/attach?"));
  assert.equal(e.requests[0]!.path, "/containers/pomtree-sid/resize?h=30&w=90");
  assert.equal(Buffer.from((await s.output()[Symbol.asyncIterator]().next()).value).toString(), "hi");
  await s.write("ls\r");
  assert.equal(Buffer.concat(e.f.sent).toString(), "ls\r");
  s.close();
  assert.ok(e.f.destroyed() >= 1);
});

test("openTerminal: stopped or missing container -> SandboxUnavailableError, no attach", async () => {
  const e = fakeEngine();
  await assert.rejects(new DockerSandbox({ mounts: stubMounts(), exec: inspectExec(false), engine: e.api }).openTerminal("sid"), SandboxUnavailableError);
  const gone: Exec = async () => {
    throw new Error("docker inspect failed: Error: No such object: x");
  };
  await assert.rejects(new DockerSandbox({ mounts: stubMounts(), exec: gone, engine: e.api }).openTerminal("sid"), SandboxUnavailableError);
  assert.equal(e.upgrades.length, 0);
});

test("openTerminal: attach failure propagates; failed initial resize closes the session", async () => {
  await assert.rejects(
    new DockerSandbox({ mounts: stubMounts(), exec: inspectExec(true), engine: fakeEngine({ fail: new Error("409") }).api }).openTerminal("sid"),
    /409/,
  );
  const e = fakeEngine({ resizeStatus: 500 });
  await assert.rejects(new DockerSandbox({ mounts: stubMounts(), exec: inspectExec(true), engine: e.api }).openTerminal("sid", { cols: 80, rows: 24 }), /500/);
  assert.ok(e.f.destroyed() >= 1);
});

test("openTerminal: multiple sessions allowed", async () => {
  const e = fakeEngine();
  const d = new DockerSandbox({ mounts: stubMounts(), exec: inspectExec(true), engine: e.api });
  await d.openTerminal("sid");
  await d.openTerminal("sid");
  assert.equal(e.upgrades.length, 2);
});

test("start with tty: runs -i -t and sizes the pty; a resize failure does not fail start", async () => {
  const e = fakeEngine({ resizeStatus: 500 });
  const ran: string[][] = [];
  const exec: Exec = async (args) => {
    if (args[0] === "inspect") throw new Error("docker inspect failed: No such object");
    ran.push(args);
    return "";
  };
  const spec = { agent: "a", image: "i", env: {}, mounts: [wsMount("/w")], tty: { cols: 100, rows: 30 } };
  await new NetSandbox({ mounts: stubMounts(), exec, engine: e.api }).start(spec, "k-tty");
  // ran[0] is the egress proxy sidecar's run; the sandbox run is the one that is not the proxy.
  const sandboxRun = ran.find((c) => c[0] === "run" && !String(c[3]).startsWith("pomtree-egress-proxy-"));
  assert.ok(sandboxRun?.includes("-t"));
  assert.match(e.requests[0]!.path, /resize\?h=30&w=100/);
});

// --- DockerSandbox.openLoopbackStream over an injected engine ---
function loopbackEngine() {
  const f = fakeSocket();
  const requests: EngineRequest[] = [];
  const upgrades: EngineRequest[] = [];
  const api: EngineApi = {
    request: async (r) => (requests.push(r), { status: 201, body: '{"Id":"ex1"}' }),
    upgrade: async (r) => (upgrades.push(r), { socket: f.sock as TerminalSocket, head: Buffer.from([1, 0, 0, 0, 0, 0, 0, 2, 0x68, 0x69]) }),
  };
  return { api, f, requests, upgrades };
}

test("openLoopbackStream: execs the bridge on the CDP port by container name and streams demuxed bytes", async () => {
  const e = loopbackEngine();
  const s = await new DockerSandbox({ mounts: stubMounts(), exec: inspectExec(true), engine: e.api }).openLoopbackStream("sid", 9222);
  assert.match(e.requests[0]!.path, /^\/containers\/pomtree-[^/]*\/exec$/);
  assert.deepEqual(JSON.parse(e.requests[0]!.body!).Cmd, ["/usr/local/bin/node", "/opt/pomtree/loopback-bridge.ts", "9222"]);
  assert.equal(e.upgrades[0]!.path, "/exec/ex1/start");
  assert.equal(Buffer.from((await s.output()[Symbol.asyncIterator]().next()).value).toString(), "hi");
  await s.write(Buffer.from("x"));
  assert.equal(Buffer.concat(e.f.sent).toString(), "x");
  s.close();
});

test("openLoopbackStream: a port outside LOOPBACK_PORTS is a RangeError and touches nothing; a stopped container is unavailable", async () => {
  const e = loopbackEngine();
  const d = new DockerSandbox({ mounts: stubMounts(), exec: inspectExec(true), engine: e.api });
  await assert.rejects(d.openLoopbackStream("sid", 22 as 9222), RangeError);
  assert.equal(e.requests.length, 0);
  const stopped = new DockerSandbox({ mounts: stubMounts(), exec: inspectExec(false), engine: e.api });
  await assert.rejects(stopped.openLoopbackStream("sid", 9222), SandboxUnavailableError);
  assert.equal(e.requests.length, 0);
});
