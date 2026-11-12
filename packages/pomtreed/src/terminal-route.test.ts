import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { request } from "node:http";
import { type FakeTerminal, tmpDir } from "@pomtree/testing";
import type { AgentRecord } from "@pomtree/core";
import { vendorDir } from "@pomtree/observe";
import { issueUiCookie } from "./auth.ts";
import { makeServer } from "./server.ts";
import type { TerminalRouteOpts } from "./terminal-route.ts";
import { Opcode } from "./websocket.ts";
import { SECRET, op, setup, spawnSpec, until } from "./test-setup.ts";

const MASK = Buffer.from([1, 2, 3, 4]);
function clientFrame(opcode: number, payload: Uint8Array): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 0xff]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ MASK[i & 3]!;
  return Buffer.concat([head, MASK, body]);
}

interface Frame {
  opcode: number;
  payload: Buffer;
}
interface Ws {
  socket: Socket;
  frames: Frame[];
  head: string;
  body: string;
  closed: Promise<void>;
  send(opcode: number, p: Uint8Array | string): void;
}

function wsConnect(port: number, path: string, headers: Record<string, string>): Promise<Ws> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    const frames: Frame[] = [];
    let buf = Buffer.alloc(0);
    let head = "";
    let headDone = false;
    let ready!: () => void;
    const closed = new Promise<void>((r) => socket.once("close", () => r()));
    const ws: Ws = {
      socket,
      frames,
      get head() {
        return head;
      },
      get body() {
        return buf.toString();
      },
      closed,
      send: (opcode, p) => socket.write(clientFrame(opcode, typeof p === "string" ? Buffer.from(p) : p)),
    } as Ws;
    socket.on("error", () => {});
    socket.on("connect", () => {
      const h = {
        host: `127.0.0.1:${port}`,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      };
      socket.write(
        `GET ${path} HTTP/1.1\r\n${Object.entries(h)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n")}\r\n\r\n`,
      );
    });
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!headDone) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        head = buf.subarray(0, i).toString();
        buf = buf.subarray(i + 4);
        headDone = true;
        if (!head.startsWith("HTTP/1.1 101")) {
          socket.once("close", () => resolve(ws));
          return;
        }
        ready = () => resolve(ws);
        ready();
      }
      for (;;) {
        if (buf.length < 2) break;
        let len = buf[1]! & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          off = 4;
        }
        if (buf.length < off + len) break;
        frames.push({ opcode: buf[0]! & 0x0f, payload: Buffer.from(buf.subarray(off, off + len)) });
        buf = buf.subarray(off + len);
      }
    });
  });
}

const status = (ws: Ws) => Number(/^HTTP\/1\.1 (\d+)/.exec(ws.head)?.[1]);
const texts = (ws: Ws) => ws.frames.filter((f) => f.opcode === Opcode.text).map((f) => f.payload.toString());
const bin = (ws: Ws) => Buffer.concat(ws.frames.filter((f) => f.opcode === Opcode.binary).map((f) => f.payload)).toString();

async function fixture(terminal: TerminalRouteOpts = {}) {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const a = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: root.id,
    name: "a",
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: "k",
  });
  const running = await t.daemon.deps.registry.transition(a.id, a.generation, "running", { idempotencyKey: "k-run" });
  const h = await t.sandbox.start(
    {
      host: "host-test",
      generation: 0,
      agent: a.id,
      image: "i",
      env: {},
      mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/w" }],
      tty: { cols: 80, rows: 24 },
    },
    "k-sb",
  );
  await t.daemon.deps.registry.setSandbox(a.id, running.generation, h.id, "k-set");
  const vendor = tmpDir("vendor-");
  writeFileSync(join(vendor, "xterm.js"), "/*x*/");
  const server: Server = makeServer(t.daemon, false, { terminal, vendorDir: vendor });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const term = (n = 0): FakeTerminal => t.sandbox.terminals.get(h.id)![n]!;
  const open = (extra: Record<string, string> = {}, path = `/v1/agents/${a.id}/terminal`) =>
    wsConnect(port, path, { authorization: `Bearer ${op}`, origin: `http://127.0.0.1:${port}`, ...extra });
  return { t, a: running as AgentRecord, h, server, port, term, open, sb: t.sandbox, vendor };
}

test("terminal ws: handshake, keystroke -> write, resize frame -> resize, output -> binary frame", async () => {
  const f = await fixture();
  try {
    const ws = await f.open();
    assert.equal(status(ws), 101);
    await until(() => f.sb.terminals.get(f.h.id)?.length === 1);
    assert.deepEqual(f.term().resizes[0], { cols: 80, rows: 24 }); // default until the client sizes it
    assert.ok(f.term().redraws >= 1);
    ws.send(Opcode.text, JSON.stringify({ type: "resize", cols: 132, rows: 43 }));
    await until(() => f.term().resizes.some((r) => r.cols === 132 && r.rows === 43));
    ws.send(Opcode.text, JSON.stringify({ type: "resize", cols: 99999, rows: 0 }));
    await until(() => f.term().resizes.some((r) => r.cols === 500 && r.rows === 1)); // clamped
    ws.send(Opcode.binary, Buffer.from("ls\r"));
    await until(() => f.term().written === "ls\r");
    f.term().emit("\x1b[1mhi\x1b[0m");
    await until(() => bin(ws).includes("hi"));
    assert.equal(bin(ws), "\x1b[1mhi\x1b[0m");
    ws.socket.destroy();
  } finally {
    f.server.closeAllConnections();
    f.server.close();
  }
});

test("terminal ws: late joiner replays the ring before live output; sessions are shared; last viewer leaving closes it", async () => {
  const f = await fixture();
  try {
    const w1 = await f.open();
    await until(() => f.sb.terminals.get(f.h.id)?.length === 1);
    f.term().emit("one\ntwo\nthree");
    await until(() => bin(w1) === "one\ntwo\nthree");
    const w2 = await f.open();
    assert.equal(status(w2), 101);
    await until(() => bin(w2) === "two\nthree"); // snapshot from a safe start
    assert.equal(f.sb.terminals.get(f.h.id)!.length, 1);
    f.term().emit("!");
    await until(() => bin(w1).endsWith("!") && bin(w2).endsWith("!"));
    w2.send(Opcode.binary, "x"); // input from any viewer is accepted
    await until(() => f.term().written === "x");
    w1.socket.destroy();
    await w1.closed;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(f.term().closes, 0);
    w2.socket.destroy();
    await until(() => f.term().closes === 1);
    // reuse after close opens a fresh session
    const w3 = await f.open();
    await until(() => f.sb.terminals.get(f.h.id)!.length === 2);
    assert.equal(bin(w3), "");
    w3.socket.destroy();
  } finally {
    f.server.closeAllConnections();
    f.server.close();
  }
});

test("terminal ws: rejects before upgrade (401/403/404/409/400) and never opens a terminal", async () => {
  const f = await fixture();
  try {
    assert.equal(status(await f.open({ authorization: "" })), 401);
    assert.equal(status(await f.open({ authorization: "Bearer garbage" })), 401);
    const agentTok = f.t.daemon.agentToken(f.a.id, f.a.generation);
    assert.equal(status(await f.open({ authorization: `Bearer ${agentTok}` })), 403);
    assert.equal(status(await f.open({ origin: "http://evil.example" })), 403);
    const noOrigin = await wsConnect(f.port, `/v1/agents/${f.a.id}/terminal`, { authorization: `Bearer ${op}` });
    assert.equal(status(noOrigin), 403);
    assert.equal(status(await f.open({}, "/v1/agents/nope/terminal")), 404);
    assert.equal(status(await f.open({}, "/v1/other")), 404);
    assert.equal(status(await f.open({ "sec-websocket-version": "8" })), 426);
    // cookie auth works with a matching Origin
    const cookie = issueUiCookie(SECRET, 60_000);
    const ok = await f.open({ authorization: "", cookie });
    assert.equal(status(ok), 101);
    ok.socket.destroy();
    await until(() => f.term().closes === 1);
    // an exited agent is a 409
    const root = await f.t.daemon.root();
    const b = await f.t.daemon.deps.registry.create({
      spec: spawnSpec,
      parent: root.id,
      name: "b",
      task: "t",
      host: "h1",
      budgetMicros: 1,
      idempotencyKey: "kb",
    });
    assert.equal(status(await f.open({}, `/v1/agents/${b.id}/terminal`)), 409);
  } finally {
    f.server.closeAllConnections();
    f.server.close();
  }
});

test("terminal ws: a sandbox that is not attachable is a 409 before upgrade", async () => {
  const f = await fixture();
  try {
    f.sb.exit(f.h.id, 0);
    assert.equal(status(await f.open()), 409);
  } finally {
    f.server.closeAllConnections();
    f.server.close();
  }
});

test("terminal ws: the 409 body carries the agent state and a human message", async () => {
  const f = await fixture();
  try {
    // pending: never started
    const root = await f.t.daemon.root();
    const b = await f.t.daemon.deps.registry.create({
      spec: spawnSpec,
      parent: root.id,
      name: "b",
      task: "t",
      host: "h1",
      budgetMicros: 1,
      idempotencyKey: "kb2",
    });
    const pend = await f.open({}, `/v1/agents/${b.id}/terminal`);
    assert.equal(status(pend), 409);
    assert.deepEqual(JSON.parse(pend.body), { error: `agent ${b.id} is pending: no live terminal yet; retry once it is running`, state: "pending" });
    // yielded: waiting, not dead
    await f.t.daemon.deps.registry.transition(f.a.id, f.a.generation, "yielded", { idempotencyKey: "k-yield" });
    const y = await f.open();
    assert.equal(status(y), 409);
    const body = JSON.parse(y.body) as { error: string; state: string };
    assert.equal(body.state, "yielded");
    assert.match(body.error, /yielded: it is waiting and has no live terminal; it resumes on its wait condition/);
    assert.equal(f.sb.terminals.has(f.h.id), false); // never opened a terminal
  } finally {
    f.server.closeAllConnections();
    f.server.close();
  }
});

test("terminal ws: a running agent whose sandbox is gone is a 409 with state running; a live one still upgrades (negative control)", async () => {
  const f = await fixture();
  try {
    const live = await f.open();
    assert.equal(status(live), 101);
    live.socket.destroy();
    await until(() => f.term().closes === 1);
    f.sb.exit(f.h.id, 0);
    const gone = await f.open();
    assert.equal(status(gone), 409);
    assert.equal((JSON.parse(gone.body) as { state: string }).state, "running");
  } finally {
    f.server.closeAllConnections();
    f.server.close();
  }
});

test("terminal ws: a backend whose terminal facet is unavailable is a 409 carrying the cause and action, not a 500 (negative control: a capable one upgrades)", async () => {
  const f = await fixture();
  try {
    const live = await f.open();
    assert.equal(status(live), 101);
    live.socket.destroy();
    await until(() => f.term().closes === 1);
    f.sb.terminal = undefined; // declared but not provided: need() throws SandboxCapabilityError
    const refused = await f.open();
    assert.equal(status(refused), 409);
    const body = JSON.parse(refused.body) as { error: string; state: string };
    assert.match(body.error, /declares terminal but provides no terminal facet; fix the adapter/);
    assert.equal(body.state, "running");
  } finally {
    f.server.closeAllConnections();
    f.server.close();
  }
});

test("terminal ws: container exit sends a closed frame then closes the socket", async () => {
  const f = await fixture({ closeWaitMs: 100 });
  try {
    const ws = await f.open();
    await until(() => f.sb.terminals.get(f.h.id)?.length === 1);
    f.sb.exit(f.h.id, 0);
    await ws.closed;
    assert.deepEqual(
      texts(ws).map((s) => JSON.parse(s)),
      [{ type: "closed", reason: "remote" }],
    );
    assert.ok(ws.frames.some((fr) => fr.opcode === Opcode.close));
  } finally {
    f.server.closeAllConnections();
    f.server.close();
  }
});

test("terminal ws: daemon shutdown (closeAllConnections) closes viewers with reason local", async () => {
  const f = await fixture();
  try {
    const ws = await f.open();
    await until(() => f.sb.terminals.get(f.h.id)?.length === 1);
    f.server.closeAllConnections();
    await ws.closed;
    assert.deepEqual(
      texts(ws).map((s) => JSON.parse(s)),
      [{ type: "closed", reason: "local" }],
    );
    assert.equal(f.term().closes >= 1, true);
  } finally {
    f.server.close();
  }
});

test("terminal ws: oversized frame -> close 1009; idle viewer is dropped; pings are sent", async () => {
  const f = await fixture({ maxMessage: 64, pingMs: 20, idleMs: 100 });
  try {
    const big = await f.open();
    await until(() => f.sb.terminals.get(f.h.id)?.length === 1);
    big.send(Opcode.binary, Buffer.alloc(100, 1));
    await big.closed;
    const c = big.frames.find((fr) => fr.opcode === Opcode.close);
    assert.equal(c?.payload.readUInt16BE(0), 1009);
    assert.equal(f.term().written, "");
    await until(() => f.term().closes === 1);

    const idle = await f.open();
    await idle.closed; // never answers pings
    assert.ok(idle.frames.some((fr) => fr.opcode === Opcode.ping));
    const c2 = idle.frames.find((fr) => fr.opcode === Opcode.close);
    assert.equal(c2?.payload.readUInt16BE(0), 1001);
  } finally {
    f.server.closeAllConnections();
    f.server.close();
  }
});

test("/ui/vendor: whitelisted file with nosniff + immutable cache, operator only; /ui CSP allows self scripts", async () => {
  const f = await fixture();
  try {
    const get = (path: string, auth = true) =>
      new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: f.port, path, headers: auth ? { authorization: `Bearer ${op}` } : {} }, (res) => {
          let s = "";
          res.on("data", (d) => (s += d));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: s }));
        });
        req.on("error", reject);
        req.end();
      });
    const ok = await get("/ui/vendor/xterm.js");
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "/*x*/");
    assert.match(String(ok.headers["content-type"]), /^text\/javascript/);
    assert.equal(ok.headers["x-content-type-options"], "nosniff");
    assert.match(String(ok.headers["cache-control"]), /immutable/);
    assert.equal((await get("/ui/vendor/xterm.js", false)).status, 401);
    assert.equal((await get("/ui/vendor/xterm.css")).status, 404); // whitelisted but absent
    assert.equal((await get("/ui/vendor/SHA256SUMS")).status, 404);
    assert.equal((await get("/ui/vendor/..%2Fpackage.json")).status, 404);
    const ui = await get("/ui");
    assert.match(String(ui.headers["content-security-policy"]), /script-src 'self' 'unsafe-inline'/);
  } finally {
    f.server.closeAllConnections();
    f.server.close();
  }
});

test("/ui shell references the vendored xterm files and each is served byte-for-byte from observe/vendor", async () => {
  const t = setup(async () => {});
  const server: Server = makeServer(t.daemon, false); // default vendorDir: observe's real directory
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const get = (path: string) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { authorization: `Bearer ${op}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });
  try {
    const ui = await get("/ui");
    assert.equal(ui.status, 200);
    assert.match(String(ui.headers["content-security-policy"]), /script-src 'self' /);
    const html = ui.body.toString();
    assert.ok(html.includes("/ui/vendor"), "shell names the vendor prefix");
    const expected: Record<string, RegExp> = {
      "xterm.js": /^text\/javascript/,
      "xterm.css": /^text\/css/,
      "addon-fit.js": /^text\/javascript/,
      "addon-webgl.js": /^text\/javascript/,
    };
    for (const [name, type] of Object.entries(expected)) {
      assert.ok(html.includes(`/${name}`), `shell references ${name}`);
      const res = await get(`/ui/vendor/${name}`);
      assert.equal(res.status, 200, name);
      assert.match(String(res.headers["content-type"]), type);
      assert.ok(res.body.equals(readFileSync(join(vendorDir(), name))), `${name} bytes match observe/vendor`);
      assert.ok(res.body.length > 0);
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("terminal ws: every upgrade attempt writes one access line (status, principal), never the token or cookie", async () => {
  const f = await fixture();
  const lines: string[] = [];
  const server = makeServer(f.t.daemon, false, { accessLog: { mode: "all", sink: (l) => lines.push(l) }, vendorDir: f.vendor });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const path = `/v1/agents/${f.a.id}/terminal`;
  const cookie = issueUiCookie(SECRET, 60_000);
  const hdr = (extra: Record<string, string>) => ({ origin: `http://127.0.0.1:${port}`, ...extra });
  try {
    const none = await wsConnect(port, path, hdr({}));
    const agentTok = f.t.daemon.agentToken(f.a.id, f.a.generation);
    const agent = await wsConnect(port, path, hdr({ authorization: `Bearer ${agentTok}` }));
    const evil = await wsConnect(port, path, { authorization: `Bearer ${op}`, origin: "http://evil.example" });
    const ok = await wsConnect(port, path, hdr({ authorization: `Bearer ${op}` }));
    const okCookie = await wsConnect(port, path, hdr({ cookie }));
    const sts = [none, agent, evil, ok, okCookie].map(status);
    ok.socket.destroy();
    okCookie.socket.destroy();
    await until(() => lines.length === 5);
    assert.deepEqual(sts, [401, 403, 403, 101, 101]);
    const parts = lines.map((l) => l.split(" "));
    const row = (i: number) => ({ method: parts[i]![2], path: parts[i]![3], status: parts[i]![4], principal: parts[i]![6] });
    assert.deepEqual(row(0), { method: "GET", path: `/v1/agents/${f.a.id}/terminal`, status: "401", principal: "anon" });
    assert.match(lines[0]!, /auth=missing-credential/);
    assert.equal(row(1).status, "403");
    assert.equal(row(1).principal, `agent:${f.a.id}`);
    assert.equal(row(2).status, "403");
    assert.match(lines[2]!, /origin not allowed/);
    assert.equal(row(3).status, "101");
    assert.equal(row(3).principal, "operator");
    assert.equal(row(4).status, "101");
    assert.equal(row(4).principal, "operator");
    for (const l of lines) {
      assert.ok(!l.includes(op), "operator token must not be logged");
      assert.ok(!l.includes(cookie), "cookie value must not be logged");
      assert.ok(!l.includes(agentTok), "agent token must not be logged");
    }
  } finally {
    server.closeAllConnections();
    server.close();
    f.server.closeAllConnections();
    f.server.close();
  }
});
