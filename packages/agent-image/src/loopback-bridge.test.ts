import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { type AddressInfo, createServer, connect as netConnect, type Server } from "node:net";
import { PassThrough } from "node:stream";
import test from "node:test";
import { join } from "node:path";
import { LOOPBACK_PORTS } from "./container-contract.gen.ts";
import { BRIDGE_EXIT_OK, BRIDGE_EXIT_STREAM, BRIDGE_EXIT_UNAVAILABLE, BRIDGE_EXIT_USAGE, parseBridgeArgs, runBridge } from "./loopback-bridge-core.ts";

const shell = join(import.meta.dirname, "loopback-bridge.ts");

function collect(stream: PassThrough): () => Buffer {
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return () => Buffer.concat(chunks);
}

async function echoServer(onData: (socket: import("node:net").Socket) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(onData);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

function harness(port: number) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const read = collect(stdout);
  const errs: string[] = [];
  const connect = (p: number, host: string) => netConnect({ port: p, host });
  const run = runBridge([String(port)], [port], { stdin, stdout, stderr: { write: (l) => errs.push(l) }, connect });
  return { stdin, stdout, read, errs, run };
}

test("argv is strictly one allowed port; anything else is a usage error that names the allowed ports", () => {
  assert.deepEqual(parseBridgeArgs(["9222"], [9222]), { port: 9222 });
  for (const argv of [[], ["9222", "x"], ["9223"], ["0x2406"], ["09222"], ["9222.0"], ["-9222"], [""], ["localhost:9222"], ["99999"]]) {
    const r = parseBridgeArgs(argv, [9222]);
    assert.ok("exit" in r, JSON.stringify(argv));
    assert.equal(r.exit, BRIDGE_EXIT_USAGE);
    assert.match(r.reason, /9222/);
  }
});

test("the shell exits 64 with one stderr line on bad usage and on a port outside LOOPBACK_PORTS", () => {
  for (const args of [[], ["1"], ["9222", "9222"], ["abc"]]) {
    const r = spawnSync(process.execPath, [shell, ...args], { encoding: "utf8", input: "" });
    assert.equal(r.status, BRIDGE_EXIT_USAGE, JSON.stringify(args));
    assert.equal(r.stdout, "");
    assert.equal(r.stderr.trim().split("\n").length, 1);
  }
});

test("the shell exits 69 with one stderr line when nothing listens on the allowed port", async (t) => {
  const port = LOOPBACK_PORTS[0];
  const busy = await new Promise<boolean>((resolve) => {
    const s = netConnect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
  if (busy) return t.skip(`something already listens on 127.0.0.1:${port}; cannot test connect failure`);
  const r = spawnSync(process.execPath, [shell, String(port)], { encoding: "utf8", input: "", timeout: 20000 });
  assert.equal(r.status, BRIDGE_EXIT_UNAVAILABLE);
  assert.match(r.stderr, /cannot reach 127\.0\.0\.1:\d+/);
  assert.equal(r.stderr.trim().split("\n").length, 1);
});

test("runBridge reports 69 on connect failure through the injected connect", async () => {
  const errs: string[] = [];
  const refused = () => {
    const s = new PassThrough() as unknown as ReturnType<import("./loopback-bridge-core.ts").BridgeConnect>;
    queueMicrotask(() => s.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" })));
    return s;
  };
  const code = await runBridge(["9222"], [9222], {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: { write: (l) => errs.push(l) },
    connect: refused,
  });
  assert.equal(code, BRIDGE_EXIT_UNAVAILABLE);
  assert.match(errs.join(""), /ECONNREFUSED/);
});

test("bytes flow both ways unchanged, including every byte value, and the bridge exits 0 after the socket ends", async () => {
  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const { server, port } = await echoServer((s) => s.pipe(s));
  try {
    const h = harness(port);
    h.stdin.write(all);
    h.stdin.end(all);
    assert.equal(await h.run, BRIDGE_EXIT_OK);
    assert.deepEqual(h.read(), Buffer.concat([all, all]));
    assert.deepEqual(h.errs, []);
  } finally {
    server.close();
  }
});

test("half-close: stdin ending ends the socket write side and the server's late reply still reaches stdout", async () => {
  const { server, port } = await echoServer((s) => {
    const seen: Buffer[] = [];
    s.on("data", (c) => seen.push(c));
    s.on("end", () => s.end(Buffer.concat([Buffer.from("got:"), ...seen])));
  });
  try {
    const h = harness(port);
    h.stdin.end("hello");
    assert.equal(await h.run, BRIDGE_EXIT_OK);
    assert.equal(h.read().toString(), "got:hello");
  } finally {
    server.close();
  }
});

test("stdin ending with a peer that never closes ends the bridge after the grace period instead of leaving it running", async () => {
  // allowHalfOpen server: the peer ignores the half-close and keeps its side open, as a service that does not end on EOF would.
  const open: import("node:net").Socket[] = [];
  const server = createServer({ allowHalfOpen: true }, (s) => {
    open.push(s);
    s.on("data", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const errs: string[] = [];
    const run = runBridge([String(port)], [port], {
      stdin,
      stdout,
      stderr: { write: (l) => errs.push(l) },
      connect: (p, host) => netConnect({ port: p, host }),
      stdinEndGraceMs: 50,
    });
    stdin.end("hello");
    const code = await Promise.race([run, new Promise<string>((r) => setTimeout(() => r("still running"), 5000))]);
    assert.equal(code, BRIDGE_EXIT_OK, "the bridge must exit once stdin has ended and the peer stays silent past the grace period");
    assert.equal(errs.length, 1, "one stderr note says the bridge cut an idle peer");
    assert.match(errs[0]!, /peer idle for 50 ms after stdin ended; closing the bridge/);
  } finally {
    for (const s of open) s.destroy();
    server.close();
  }
});

test("the grace period does not cut a late reply that arrives within it", async () => {
  const server = createServer({ allowHalfOpen: true }, (s) => {
    s.on("data", () => {});
    s.on("end", () => setTimeout(() => s.end("late"), 100));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const read = collect(stdout);
    const run = runBridge([String(port)], [port], {
      stdin,
      stdout,
      stderr: { write: () => {} },
      connect: (p, host) => netConnect({ port: p, host }),
      stdinEndGraceMs: 2000,
    });
    stdin.end("x");
    assert.equal(await run, BRIDGE_EXIT_OK);
    assert.equal(read().toString(), "late");
  } finally {
    server.close();
  }
});

test("a peer still streaming its reply past the grace period is not cut: the grace period is idle time, not total time", async () => {
  // Ten chunks 40 ms apart (400 ms in all) after the peer sees stdin end, with a 100 ms grace period: only an idle timer delivers all of it.
  const server = createServer({ allowHalfOpen: true }, (s) => {
    s.on("data", () => {});
    s.on("end", () => {
      let n = 0;
      const t = setInterval(() => {
        s.write(`c${n};`);
        if (++n === 10) {
          clearInterval(t);
          s.end();
        }
      }, 40);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const read = collect(stdout);
    const errs: string[] = [];
    const run = runBridge([String(port)], [port], {
      stdin,
      stdout,
      stderr: { write: (l) => errs.push(l) },
      connect: (p, host) => netConnect({ port: p, host }),
      stdinEndGraceMs: 100,
    });
    stdin.end("x");
    assert.equal(await run, BRIDGE_EXIT_OK);
    assert.equal(read().toString(), "c0;c1;c2;c3;c4;c5;c6;c7;c8;c9;", "the whole reply arrives");
    assert.deepEqual(errs, [], "no cut, so no note");
  } finally {
    server.close();
  }
});

test("the socket ending first exits 0 even though stdin never ends", async () => {
  const { server, port } = await echoServer((s) => s.end("bye"));
  try {
    const h = harness(port);
    assert.equal(await h.run, BRIDGE_EXIT_OK);
    assert.equal(h.read().toString(), "bye");
  } finally {
    server.close();
  }
});

test("the real shell exits 0 with the peer's bytes while its stdin stays open", async (t) => {
  // The shell binds only LOOPBACK_PORTS; run it only when that port is free to take, so the check cannot hit another service.
  const port = LOOPBACK_PORTS[0];
  const server = createServer((s) => s.end("pong"));
  const bound = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (!bound) return t.skip(`127.0.0.1:${port} is in use; cannot run the shell end to end`);
  try {
    const child = spawn(process.execPath, [shell, String(port)], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    assert.equal(code, 0);
    assert.equal(Buffer.concat(out).toString(), "pong");
  } finally {
    server.close();
  }
});

// An injected socket that connects at once; the test then fails one of the three streams.
function fakeIo() {
  const socket = new PassThrough();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const errs: string[] = [];
  const connect = () => {
    queueMicrotask(() => socket.emit("connect"));
    return socket as unknown as ReturnType<import("./loopback-bridge-core.ts").BridgeConnect>;
  };
  const run = runBridge(["9222"], [9222], { stdin, stdout, stderr: { write: (l) => errs.push(l) }, connect });
  return { socket, stdin, stdout, errs, run };
}
const errno = (code: string) => Object.assign(new Error(code), { code });

test("a socket error after connect exits 70 with one reason line, not 0", async () => {
  const h = fakeIo();
  await new Promise((r) => setImmediate(r));
  h.socket.emit("error", errno("ECONNRESET"));
  assert.equal(await h.run, BRIDGE_EXIT_STREAM);
  assert.equal(BRIDGE_EXIT_STREAM, 70);
  assert.equal(h.errs.length, 1);
  assert.match(h.errs[0]!, /ECONNRESET/);
});

test("EPIPE on stdout or stdin is a clean exit 0 with no stderr", async () => {
  for (const which of ["stdout", "stdin"] as const) {
    const h = fakeIo();
    await new Promise((r) => setImmediate(r));
    h[which].emit("error", errno("EPIPE"));
    assert.equal(await h.run, BRIDGE_EXIT_OK, which);
    assert.deepEqual(h.errs, [], which);
  }
});

test("another stdout or stdin error exits 70 with one reason line and no uncaught exception", async () => {
  for (const which of ["stdout", "stdin"] as const) {
    const h = fakeIo();
    await new Promise((r) => setImmediate(r));
    h[which].emit("error", errno("EIO"));
    assert.equal(await h.run, BRIDGE_EXIT_STREAM, which);
    assert.equal(h.errs.length, 1, which);
    assert.match(h.errs[0]!, new RegExp(`${which} failed \\(EIO\\)`));
  }
});
