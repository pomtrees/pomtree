import test from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { SandboxUnavailableError } from "@pomtree/core";
import { createExecDemuxer, MAX_FRAME_BYTES } from "./exec-demux.ts";
import { buildExecCreateRequest, buildExecStartRequest, createExecStream, openExecStream } from "./exec-stream.ts";
import type { EngineApi, EngineRequest, TerminalSocket } from "./terminal.ts";

const frame = (type: number, payload: string | Buffer) => {
  const p = Buffer.from(payload);
  const h = Buffer.alloc(8);
  h[0] = type;
  h.writeUInt32BE(p.length, 4);
  return Buffer.concat([h, p]);
};
const text = (parts: Uint8Array[]) => Buffer.concat(parts).toString();

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
  return { sock, sent, destroyed: () => destroyed, push: (b: Buffer) => sock.push(b), end: () => sock.push(null) };
}

test("demux: stdout and stderr frames are separated in order", () => {
  const d = createExecDemuxer();
  const r = d.push(Buffer.concat([frame(1, "out1"), frame(2, "err1"), frame(1, "out2")]));
  assert.equal(text(r.stdout), "out1out2");
  assert.equal(text(r.stderr), "err1");
});

test("demux: header and payload split at every byte boundary", () => {
  const all = Buffer.concat([frame(1, "hello"), frame(2, "oops"), frame(1, "world")]);
  const d = createExecDemuxer();
  let out = "";
  let err = "";
  for (let i = 0; i < all.length; i++) {
    const r = d.push(all.subarray(i, i + 1));
    out += text(r.stdout);
    err += text(r.stderr);
  }
  assert.equal(out, "helloworld");
  assert.equal(err, "oops");
});

test("demux: zero-length frame yields nothing; stdin-type frame is dropped", () => {
  const r = createExecDemuxer().push(Buffer.concat([frame(1, ""), frame(0, "echo"), frame(1, "x")]));
  assert.equal(text(r.stdout), "x");
  assert.equal(r.stderr.length, 0);
});

test("demux: oversized frame errors; header with a nonzero pad or unknown type errors; later pushes keep failing", () => {
  const big = Buffer.alloc(8);
  big[0] = 1;
  big.writeUInt32BE(MAX_FRAME_BYTES + 1, 4);
  assert.throws(() => createExecDemuxer().push(big), /exceeds the 4194304-byte cap/);

  const pad = frame(1, "a");
  pad[2] = 7;
  assert.throws(() => createExecDemuxer().push(pad), /invalid docker stream header/);
  const kind = frame(3, "a");
  const d = createExecDemuxer(16);
  assert.throws(() => d.push(kind), /invalid docker stream header/);
  assert.throws(() => d.push(frame(1, "ok")), /corrupt/);
});

test("exec requests: create is non-TTY with all three streams; start hijacks without detaching", () => {
  const c = buildExecCreateRequest("pomtree-x", ["node", "/b.ts", "9222"]);
  assert.equal(c.path, "/containers/pomtree-x/exec");
  assert.deepEqual(JSON.parse(c.body!), { AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, Cmd: ["node", "/b.ts", "9222"] });
  const s = buildExecStartRequest("abc");
  assert.equal(s.path, "/exec/abc/start");
  assert.equal(s.headers.Upgrade, "tcp");
  assert.deepEqual(JSON.parse(s.body!), { Detach: false, Tty: false });
  assert.throws(() => buildExecCreateRequest("c", []), RangeError);
});

test("createExecStream: head and later data demuxed, writes reach the socket, stderr tail kept, EOF is remote", async () => {
  const f = fakeSocket();
  const s = createExecStream(f.sock as TerminalSocket, frame(1, "head"));
  f.push(Buffer.concat([frame(2, "bad thing\n"), frame(1, "body")]));
  await s.write(Buffer.from("req"));
  assert.equal(Buffer.concat(f.sent).toString(), "req");
  const it = s.output()[Symbol.asyncIterator]();
  assert.equal(Buffer.from((await it.next()).value).toString(), "head");
  assert.equal(Buffer.from((await it.next()).value).toString(), "body");
  const next = it.next();
  f.end();
  await assert.rejects(next, /loopback bridge in the container ended with: bad thing/);
  const c = await s.closed;
  assert.equal(c.reason, "remote");
  assert.match(c.error!.message, /loopback bridge in the container ended with: bad thing/);
  assert.equal(s.stderrTail(), "bad thing\n");
  await assert.rejects(s.write(Buffer.from("x")), /closed/);
});

test("createExecStream: stderr tail is bounded to the most recent bytes", async () => {
  const f = fakeSocket();
  const s = createExecStream(f.sock as TerminalSocket, new Uint8Array());
  f.push(frame(2, `${"a".repeat(5000)}END`));
  f.end();
  await s.closed;
  assert.equal(s.stderrTail().length, 2048);
  assert.ok(s.stderrTail().endsWith("END"));
});

test("createExecStream: remote close with stderr resolves error naming the bridge's stderr and an action", async () => {
  const f = fakeSocket();
  const s = createExecStream(f.sock as TerminalSocket, new Uint8Array());
  f.push(frame(2, "connect ECONNREFUSED 127.0.0.1:9222\n"));
  f.end();
  const c = await s.closed;
  assert.equal(c.reason, "remote");
  assert.equal(
    c.error?.message,
    "loopback bridge in the container ended with: connect ECONNREFUSED 127.0.0.1:9222; check that the target port is listening inside the sandbox",
  );
});

test("createExecStream: close() destroys the socket, resolves local, is idempotent", async () => {
  const f = fakeSocket();
  const s = createExecStream(f.sock as TerminalSocket, new Uint8Array());
  s.close();
  s.close();
  assert.deepEqual(await s.closed, { reason: "local" });
  assert.equal(f.destroyed(), 1);
  assert.equal((await s.output()[Symbol.asyncIterator]().next()).done, true);
});

test("createExecStream: socket error and a corrupt frame both resolve error and throw from output", async () => {
  const a = fakeSocket();
  const sa = createExecStream(a.sock as TerminalSocket, new Uint8Array());
  a.sock.destroy(new Error("boom"));
  const ca = await sa.closed;
  assert.equal(ca.reason, "error");
  await assert.rejects(sa.output()[Symbol.asyncIterator]().next(), /boom/);

  const b = fakeSocket();
  const sb = createExecStream(b.sock as TerminalSocket, new Uint8Array(), { maxFrame: 4 });
  b.push(frame(1, "toolong"));
  const cb = await sb.closed;
  assert.equal(cb.reason, "error");
  assert.match(cb.error!.message, /exceeds the 4-byte cap/);
  assert.equal(b.destroyed(), 1);
  await assert.rejects(sb.output()[Symbol.asyncIterator]().next(), /cap/);
});

test("createExecStream: output past the high-water mark pauses the socket and resumes below low water", async () => {
  const f = fakeSocket();
  let paused = 0;
  let resumed = 0;
  const realPause = f.sock.pause.bind(f.sock);
  const realResume = f.sock.resume.bind(f.sock);
  const sock = Object.assign(f.sock, {
    pause: () => (paused++, realPause()),
    resume: () => (resumed++, realResume()),
  });
  const s = createExecStream(sock as TerminalSocket, new Uint8Array(), { highWater: 10, lowWater: 4 });
  f.push(frame(1, "0123456789ab"));
  const it = s.output()[Symbol.asyncIterator]();
  const resumedBefore = resumed;
  await it.next();
  assert.equal(paused, 1);
  assert.equal(resumed, resumedBefore + 1);
  s.close();
});

function fakeApi(opts: { createStatus?: number; createBody?: string; upgradeFail?: Error } = {}) {
  const f = fakeSocket();
  const requests: EngineRequest[] = [];
  const upgrades: EngineRequest[] = [];
  const api: EngineApi = {
    request: async (r) => {
      requests.push(r);
      return { status: opts.createStatus ?? 201, body: opts.createBody ?? '{"Id":"exec1"}' };
    },
    upgrade: async (r) => {
      upgrades.push(r);
      if (opts.upgradeFail) throw opts.upgradeFail;
      return { socket: f.sock as TerminalSocket, head: frame(1, "h") };
    },
  };
  return { api, f, requests, upgrades };
}

test("openExecStream: creates then starts the exec and streams its stdout", async () => {
  const e = fakeApi();
  const s = await openExecStream(e.api, "pomtree-x", ["node", "/b.ts", "9222"]);
  assert.equal(e.requests[0]!.path, "/containers/pomtree-x/exec");
  assert.equal(e.upgrades[0]!.path, "/exec/exec1/start");
  assert.equal(Buffer.from((await s.output()[Symbol.asyncIterator]().next()).value).toString(), "h");
  s.close();
});

test("openExecStream: refused create, missing id and failed start each reject and start nothing", async () => {
  for (const status of [404, 409]) {
    const e = fakeApi({ createStatus: status, createBody: "no" });
    await assert.rejects(openExecStream(e.api, "c", ["x"]), SandboxUnavailableError);
    assert.equal(e.upgrades.length, 0);
  }
  const bad = fakeApi({ createStatus: 500, createBody: "engine down" });
  await assert.rejects(openExecStream(bad.api, "c", ["x"]), /exec create -> 500: engine down.*retry/);
  const noId = fakeApi({ createBody: "{}" });
  await assert.rejects(openExecStream(noId.api, "c", ["x"]), /no exec id/);
  assert.equal(noId.upgrades.length, 0);
  const up = fakeApi({ upgradeFail: new Error("101 expected") });
  await assert.rejects(openExecStream(up.api, "c", ["x"]), /101 expected/);
});
