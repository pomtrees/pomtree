import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecOutputCapError } from "@pomtree/sandbox-kit/result-work-exec";
import type { WsMessage } from "@pomtree/sandbox-kit/ws-client";
import { WsError } from "@pomtree/sandbox-kit/ws-client";
import {
  Channel,
  type ConnectFn,
  EXEC_SUBPROTOCOL,
  type ExecTarget,
  ExecStatusError,
  ExecStreamError,
  decodeFrame,
  encodeFrame,
  exec,
  execUrl,
  openExec,
  openExecMux,
  parseStatus,
} from "./exec.ts";
import { createMux } from "@pomtree/sandbox-kit/mux";

const target: ExecTarget = { server: "https://10.0.0.1:6443", namespace: "pomtree", pod: "pomtree-abc", container: "worker" };
const enc = new TextEncoder();
const frame = (channel: number, payload: string | Uint8Array = ""): WsMessage => ({
  type: "binary",
  data: encodeFrame(channel, typeof payload === "string" ? enc.encode(payload) : payload),
});
const success = frame(Channel.status, JSON.stringify({ metadata: {}, status: "Success" }));
const exitWith = (n: number): WsMessage =>
  frame(
    Channel.status,
    JSON.stringify({
      metadata: {},
      status: "Failure",
      message: `command terminated with non-zero exit code: Error executing in Docker Container: ${n}`,
      reason: "NonZeroExitCode",
      details: { causes: [{ reason: "ExitCode", message: String(n) }] },
    }),
  );

// A scripted websocket. `inbound` is what the server sends; an `end` marker ends the stream without a close handshake and
// `fail` makes the reader throw like the kit client does after a dropped socket.
type Step = WsMessage | { end: true } | { fail: string };
class FakeWs {
  protocol: string;
  sent: Uint8Array[] = [];
  closed = false;
  #queue: Step[];
  #waiters: ((s: Step) => void)[] = [];
  onSend: ((data: Uint8Array) => void) | undefined;
  sendGate: Promise<void> | undefined;
  // A real server closes the socket after the status frame; `hang` scripts the one that does not.
  constructor(inbound: Step[], protocol = EXEC_SUBPROTOCOL, hang = false) {
    this.#queue = [...inbound];
    const hasStatus = inbound.some((m) => "type" in m && m.type === "binary" && m.data[0] === Channel.status);
    if (hasStatus && !hang && !inbound.some((m) => "end" in m || "fail" in m)) this.#queue.push({ end: true });
    this.protocol = protocol;
  }
  push(step: Step): void {
    const w = this.#waiters.shift();
    if (w) w(step);
    else this.#queue.push(step);
  }
  async send(data: string | Uint8Array): Promise<void> {
    if (this.closed) throw new WsError("cannot send on a closed websocket; reconnect first");
    await this.sendGate;
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    this.sent.push(bytes);
    this.onSend?.(bytes);
  }
  async close(): Promise<{ code: number; reason: string; clean: boolean }> {
    if (!this.closed) {
      this.closed = true;
      this.push({ end: true });
    }
    return { code: 1000, reason: "", clean: true };
  }
  [Symbol.asyncIterator](): AsyncIterator<WsMessage> {
    return {
      next: async () => {
        const s = this.#queue.shift() ?? (await new Promise<Step>((r) => this.#waiters.push(r)));
        if ("end" in s) return { value: undefined, done: true };
        if ("fail" in s) throw new WsError(s.fail);
        return { value: s, done: false };
      },
    };
  }
}

const connectTo =
  (ws: FakeWs, urls: string[] = []): ConnectFn =>
  async (url, opts) => {
    urls.push(url);
    assert.deepEqual(opts.protocols, [EXEC_SUBPROTOCOL]);
    return ws;
  };

// ---- codec ----

test("frame codec: round-trips a channel byte and payload, and refuses an empty message", () => {
  const f = decodeFrame(encodeFrame(Channel.stdout, enc.encode("hi")));
  assert.equal(f.channel, 1);
  assert.equal(Buffer.from(f.payload).toString(), "hi");
  assert.throws(
    () => decodeFrame(new Uint8Array(0)),
    (e: unknown) => e instanceof ExecStreamError && e.kind === "protocol" && /check the API server version/.test(e.message),
  );
});

test("status: Success is 0, NonZeroExitCode carries the code, other failures are typed with cause and action", () => {
  assert.equal(parseStatus(enc.encode('{"status":"Success"}')), 0);
  assert.equal(
    parseStatus(enc.encode(JSON.stringify({ status: "Failure", reason: "NonZeroExitCode", details: { causes: [{ reason: "ExitCode", message: "137" }] } }))),
    137,
  );
  assert.throws(
    () => parseStatus(enc.encode(JSON.stringify({ status: "Failure", reason: "Forbidden", message: "pods/exec is forbidden" }))),
    (e: unknown) => e instanceof ExecStatusError && e.reason === "Forbidden" && /create. on pods\/exec/.test(e.message),
  );
  for (const bad of [
    "not json",
    '"str"',
    '{"status":"Weird"}',
    '{"status":"Failure","reason":"NonZeroExitCode"}',
    '{"status":"Failure","reason":"NonZeroExitCode","details":{"causes":[{"reason":"ExitCode","message":"999"}]}}',
  ]) {
    assert.throws(() => parseStatus(enc.encode(bad)), ExecStreamError, bad);
  }
});

// ---- url / argv ----

test("execUrl: argv becomes repeated command parameters, never one shell string", () => {
  const argv = ["node", "-e", "console.log('a b; rm -rf /')", "--", "/work/with space/$HOME"];
  const u = new URL(execUrl(target, argv, { stdin: false }));
  assert.equal(u.protocol, "wss:");
  assert.equal(u.pathname, "/api/v1/namespaces/pomtree/pods/pomtree-abc/exec");
  assert.deepEqual(u.searchParams.getAll("command"), argv);
  assert.equal(u.searchParams.get("container"), "worker");
  assert.equal(u.searchParams.get("stdin"), "false");
  assert.equal(u.searchParams.get("tty"), "false");
  assert.equal(
    new URL(execUrl({ ...target, server: "http://localhost:8001/prefix/" }, ["a"], { stdin: true, tty: true })).pathname,
    "/prefix/api/v1/namespaces/pomtree/pods/pomtree-abc/exec",
  );
  assert.throws(() => execUrl(target, [], { stdin: false }), ExecStreamError);
  assert.throws(() => execUrl(target, ["a\0b"], { stdin: false }), ExecStreamError);
});

// ---- exec ----

test("exec: interleaved stdout and stderr frames are collected per stream and exit 0 comes from the status channel", async () => {
  const ws = new FakeWs([
    frame(1, "he"),
    frame(2, "warn1 "),
    frame(1, "llo "),
    frame(2, "warn2"),
    frame(1, "world"),
    frame(Channel.close, Uint8Array.of(1)),
    success,
  ]);
  const urls: string[] = [];
  const r = await exec(connectTo(ws, urls), target, ["echo", "a b"], { maxStdoutBytes: 100 });
  assert.equal(r.exitCode, 0);
  assert.equal(Buffer.from(r.stdout).toString(), "hello world");
  assert.equal(r.stderr, "warn1 warn2");
  assert.deepEqual(new URL(urls[0] as string).searchParams.getAll("command"), ["echo", "a b"]);
  assert.equal(ws.closed, true);
});

test("exec: a Failure status with NonZeroExitCode returns that exit code with the output", async () => {
  const ws = new FakeWs([frame(1, "partial out"), frame(2, "boom"), exitWith(42)]);
  const r = await exec(connectTo(ws), target, ["false"], { maxStdoutBytes: 100 });
  assert.equal(r.exitCode, 42);
  assert.equal(Buffer.from(r.stdout).toString(), "partial out");
  assert.equal(r.stderr, "boom");
});

test("exec: a non-exit Failure status raises ExecStatusError", async () => {
  const ws = new FakeWs([frame(3, JSON.stringify({ status: "Failure", reason: "InternalError", message: "container not found" }))]);
  await assert.rejects(exec(connectTo(ws), target, ["x"], { maxStdoutBytes: 10 }), ExecStatusError);
});

test("exec: stdout past the cap raises ExecOutputCapError, exactly the cap is allowed, and the stream is closed", async () => {
  const over = new FakeWs([frame(1, "12345"), frame(1, "6"), success]);
  await assert.rejects(exec(connectTo(over), target, ["x"], { maxStdoutBytes: 5 }), ExecOutputCapError);
  assert.equal(over.closed, true);
  const exact = new FakeWs([frame(1, "12345"), success]);
  assert.equal((await exec(connectTo(exact), target, ["x"], { maxStdoutBytes: 5 })).stdout.length, 5);
});

test("exec: stderr keeps only its tail past maxStderrBytes", async () => {
  const ws = new FakeWs([frame(2, "aaaa"), frame(2, "bbbb"), frame(2, "cc"), success]);
  const r = await exec(connectTo(ws), target, ["x"], { maxStdoutBytes: 1, maxStderrBytes: 6 });
  assert.equal(r.stderr, "bbbbcc");
});

// NEG: the dropped-stream rule. Each shape must raise and must not look like EOF or exit 0.
test("NEG exec: a socket that closes without a status frame raises dropped, never exit 0", async () => {
  for (const ending of [[{ end: true }], [{ fail: "socket hang up" }], [frame(Channel.close, Uint8Array.of(1)), { end: true }]] as Step[][]) {
    const ws = new FakeWs([frame(1, "some output"), ...ending]);
    await assert.rejects(
      exec(connectTo(ws), target, ["x"], { maxStdoutBytes: 100 }),
      (e: unknown) => e instanceof ExecStreamError && e.kind === "dropped" && /outcome is unknown/.test(e.message) && /rerun the command/.test(e.message),
    );
  }
});

test("NEG exec: a clean WebSocket close frame still raises when no status arrived (the close is not an exit)", async () => {
  const ws = new FakeWs([frame(1, "x")]);
  const p = exec(connectTo(ws), target, ["x"], { maxStdoutBytes: 100 });
  await ws.close(); // the server's close handshake, 1000 and clean, but no channel-3 frame was ever sent
  await assert.rejects(p, (e: unknown) => e instanceof ExecStreamError && e.kind === "dropped");
});

test("NEG exec: text messages and unknown channels are protocol errors", async () => {
  await assert.rejects(
    exec(connectTo(new FakeWs([{ type: "text", text: "hello" }])), target, ["x"], { maxStdoutBytes: 9 }),
    (e: unknown) => e instanceof ExecStreamError && e.kind === "protocol",
  );
  await assert.rejects(
    exec(connectTo(new FakeWs([frame(9, "?")])), target, ["x"], { maxStdoutBytes: 9 }),
    (e: unknown) => e instanceof ExecStreamError && e.kind === "protocol" && /channel 9/.test(e.message),
  );
});

test("subprotocol: a server that picks another protocol, or none, is refused with cause and action", async () => {
  for (const proto of ["v4.channel.k8s.io", "channel.k8s.io", ""]) {
    const ws = new FakeWs([success], proto);
    await assert.rejects(
      exec(connectTo(ws), target, ["x"], { maxStdoutBytes: 9 }),
      (e: unknown) => e instanceof ExecStreamError && e.kind === "subprotocol" && e.message.includes(EXEC_SUBPROTOCOL) && /upgrade the cluster/.test(e.message),
      proto,
    );
    assert.equal(ws.closed, true, "the refused socket is closed");
  }
});

// ---- stdin, half-close, resize ----

test("exec: stdin is sent in order on channel 0, then half-closed with [255, 0]", async () => {
  const ws = new FakeWs([]);
  ws.onSend = (data) => {
    if (data[0] === Channel.close) ws.push(frame(1, "got it"));
    if (data[0] === Channel.close) {
      ws.push(success);
      ws.push({ end: true });
    }
  };
  const body = Buffer.alloc(70 * 1024, 7);
  const r = await exec(connectTo(ws), target, ["cat"], { maxStdoutBytes: 100, stdin: body });
  assert.equal(Buffer.from(r.stdout).toString(), "got it");
  const last = ws.sent[ws.sent.length - 1] as Uint8Array;
  assert.deepEqual([...last], [255, 0]);
  const data = ws.sent.slice(0, -1);
  assert.ok(data.length >= 3, "70 KiB is split into bounded chunks");
  assert.ok(data.every((d) => d[0] === Channel.stdin && d.length <= 1 + 32 * 1024));
  assert.equal(Buffer.concat(data.map((d) => d.subarray(1))).equals(body), true);
});

test("stdin backpressure: a write does not return while the socket has not accepted the frame", async () => {
  const ws = new FakeWs([]);
  let release!: () => void;
  ws.sendGate = new Promise<void>((r) => {
    release = r;
  });
  const s = await openExec(connectTo(ws), target, ["cat"], { stdin: true });
  let done = false;
  const w = s.write(Buffer.alloc(1000)).then(() => {
    done = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, false, "write must wait for the socket");
  release();
  await w;
  assert.equal(done, true);
  await s.close();
});

test("half-close: closing stdin twice sends one frame, writing after it is refused, and stdin on a no-stdin exec is refused", async () => {
  const ws = new FakeWs([]);
  const s = await openExec(connectTo(ws), target, ["cat"], { stdin: true });
  await s.closeStdin();
  await s.closeStdin();
  assert.equal(ws.sent.length, 1);
  await assert.rejects(s.write(Buffer.from("late")), (e: unknown) => e instanceof ExecStreamError && e.kind === "usage" && /open a new exec/.test(e.message));
  await s.close();
  const noStdin = await openExec(connectTo(new FakeWs([])), target, ["ls"]);
  await assert.rejects(noStdin.write(Buffer.from("x")), (e: unknown) => e instanceof ExecStreamError && e.kind === "usage");
  await noStdin.close();
});

test("resize: sends a channel-4 JSON frame and refuses invalid sizes", async () => {
  const ws = new FakeWs([]);
  const s = await openExec(connectTo(ws), target, ["sh"], { stdin: true, tty: true });
  await s.resize(120, 40);
  const f = ws.sent[0] as Uint8Array;
  assert.equal(f[0], Channel.resize);
  assert.deepEqual(JSON.parse(Buffer.from(f.subarray(1)).toString()), { Width: 120, Height: 40 });
  await assert.rejects(s.resize(0, 10), (e: unknown) => e instanceof ExecStreamError && e.kind === "usage");
  await assert.rejects(s.resize(10.5, 10), ExecStreamError);
  await s.close();
});

test("NEG stdin: a write on a socket that already died raises dropped", async () => {
  const ws = new FakeWs([]);
  const s = await openExec(connectTo(ws), target, ["cat"], { stdin: true });
  await ws.close();
  await assert.rejects(s.write(Buffer.from("x")), (e: unknown) => e instanceof ExecStreamError && e.kind === "dropped" && /reopen the exec/.test(e.message));
});

// ---- mux carrier ----

// Plays the relay: a mux acceptor whose pair is the far end of the exec stream.
function fakeRelay(ws: FakeWs) {
  const inbox: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  ws.onSend = (data) => {
    if (data[0] === Channel.stdin) {
      inbox.push(data.subarray(1));
      wake?.();
    }
  };
  const pair = {
    write: async (d: Uint8Array) => {
      ws.push(frame(Channel.stdout, d));
    },
    output: () =>
      (async function* () {
        while (!ended) {
          const c = inbox.shift();
          if (c) yield c;
          else await new Promise<void>((r) => (wake = r));
        }
      })(),
    close: () => {
      ended = true;
      wake?.();
    },
  };
  return pair;
}

test("mux carrier: createMux over the exec relay round-trips a named channel in both directions", async () => {
  const ws = new FakeWs([]);
  const relay = createMux(fakeRelay(ws), { role: "acceptor", accept: ["daemon-api"] });
  const urls: string[] = [];
  const mux = await openExecMux(connectTo(ws, urls), target, ["/usr/local/bin/pomtree-relay"], { role: "initiator" });
  assert.deepEqual(new URL(urls[0] as string).searchParams.getAll("command"), ["/usr/local/bin/pomtree-relay"]);
  assert.equal(new URL(urls[0] as string).searchParams.get("stdin"), "true");
  const incoming = relay.incoming();
  const [client, accepted] = await Promise.all([mux.open("daemon-api"), incoming.next()]);
  const server = accepted.value as NonNullable<typeof accepted.value>;
  assert.equal(server.name, "daemon-api");
  await client.write("ping");
  const got: string[] = [];
  for await (const c of server.output()) {
    got.push(Buffer.from(c).toString());
    break;
  }
  assert.deepEqual(got, ["ping"]);
  await server.write("pong");
  for await (const c of client.output()) {
    assert.equal(Buffer.from(c).toString(), "pong");
    break;
  }
  mux.close();
  relay.close();
});

test("NEG mux carrier: a dropped exec stream fails the mux with an error, it does not end quietly", async () => {
  const ws = new FakeWs([]);
  const mux = await openExecMux(connectTo(ws), target, ["relay"], { role: "initiator" });
  ws.push({ fail: "socket hang up" });
  const closed = await mux.closed;
  assert.ok(closed.error, "the mux must report an error, not a clean end");
});

test("mux carrier: closing the mux ends the exec locally without raising dropped", async () => {
  const ws = new FakeWs([]);
  const mux = await openExecMux(connectTo(ws), target, ["relay"], { role: "initiator" });
  mux.close();
  const closed = await mux.closed;
  assert.equal(closed.error, undefined);
  assert.equal(ws.closed, true);
});

test("mux carrier: a relay that exits non-zero fails the mux and names the exit code", async () => {
  const ws = new FakeWs([]);
  const mux = await openExecMux(connectTo(ws), target, ["relay"], { role: "initiator" });
  ws.push(exitWith(3));
  ws.push({ end: true });
  const closed = await mux.closed;
  assert.match(closed.error?.message ?? "", /exited with code 3/);
});

// ---- review fixes ----

test("NEG execUrl: namespace, pod and container must be DNS-1123 names; dot segments, slashes, queries and encodings are refused", () => {
  for (const bad of ["..", ".", "a/b", "a?b", "a#b", "%2e%2e", "%2E", "..%2fx", "A", "-a", "a-", "", "a b", "a\\b"]) {
    for (const field of ["namespace", "pod", "container"] as const) {
      assert.throws(
        () => execUrl({ ...target, [field]: bad }, ["x"], { stdin: false }),
        (e: unknown) =>
          e instanceof ExecStreamError &&
          e.kind === "usage" &&
          e.message.includes(field) &&
          /DNS-1123/.test(e.message) &&
          /pass the name exactly/.test(e.message),
        `${field}=${JSON.stringify(bad)}`,
      );
    }
  }
  for (const field of ["namespace", "container"] as const)
    assert.throws(() => execUrl({ ...target, [field]: "x".repeat(64) }, ["x"], { stdin: false }), ExecStreamError);
  assert.throws(() => execUrl({ ...target, pod: `${"a".repeat(251)}.bb` }, ["x"], { stdin: false }), ExecStreamError);
  assert.throws(() => execUrl({ ...target, pod: "a..b" }, ["x"], { stdin: false }), ExecStreamError);
  // valid: pods may be subdomains, 253 long
  assert.equal(new URL(execUrl({ ...target, pod: "web-0.svc.x1" }, ["x"], { stdin: false })).pathname, "/api/v1/namespaces/pomtree/pods/web-0.svc.x1/exec");
  assert.doesNotThrow(() => execUrl({ ...target, pod: `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}` }, ["x"], { stdin: false }));
});

test("exec: stdout and stderr frames that arrive AFTER the status frame are kept (the status does not end the read)", async () => {
  const ws = new FakeWs([frame(1, "one "), success, frame(1, "two "), frame(2, "late-err"), frame(1, "three"), { end: true }]);
  const r = await exec(connectTo(ws), target, ["x"], { maxStdoutBytes: 100 });
  assert.equal(r.exitCode, 0);
  assert.equal(Buffer.from(r.stdout).toString(), "one two three");
  assert.equal(r.stderr, "late-err");
});

test("exec: a stream that never closes after the status frame resolves after the bounded drain wait", async () => {
  const ws = new FakeWs([frame(1, "out"), exitWith(7)], EXEC_SUBPROTOCOL, true);
  const t0 = Date.now();
  const r = await exec(connectTo(ws), target, ["x"], { maxStdoutBytes: 100, drainMs: 40 });
  const took = Date.now() - t0;
  assert.equal(r.exitCode, 7);
  assert.equal(Buffer.from(r.stdout).toString(), "out");
  assert.ok(took >= 30 && took < 1500, `drain waited ${took}ms`);
  assert.equal(ws.closed, true);
});

test("exec: a socket error after the status frame does not discard the exit status", async () => {
  const ws = new FakeWs([frame(1, "out"), success, { fail: "reset by peer" }]);
  const r = await exec(connectTo(ws), target, ["x"], { maxStdoutBytes: 100 });
  assert.equal(r.exitCode, 0);
});

test("NEG exec: a second status frame is a protocol error", async () => {
  const ws = new FakeWs([success, success]);
  await assert.rejects(exec(connectTo(ws), target, ["x"], { maxStdoutBytes: 100 }), (e: unknown) => e instanceof ExecStreamError && e.kind === "protocol");
});

test("abort: an aborted signal ends the exec with kind aborted, not dropped, and the text says it was cancelled", async () => {
  const ws = new FakeWs([frame(1, "x")]);
  const ac = new AbortController();
  const p = exec(connectTo(ws), target, ["sleep", "9"], { maxStdoutBytes: 100, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 10));
  ac.abort();
  ws.push({ fail: "aborted" });
  await assert.rejects(
    p,
    (e: unknown) => e instanceof ExecStreamError && e.kind === "aborted" && /cancelled by the caller/.test(e.message) && !/rerun the command/.test(e.message),
  );
});

test("NEG session: events() can be consumed once; a second call throws with cause and action", async () => {
  const s = await openExec(connectTo(new FakeWs([success, { end: true }])), target, ["x"]);
  for await (const _ of s.events()) {
    // drain
  }
  await assert.rejects(
    s.events().next(),
    (e: unknown) => e instanceof ExecStreamError && e.kind === "usage" && /consumed once/.test(e.message) && /open a new exec/.test(e.message),
  );
});

test("exec: the stderr tail never starts inside a multibyte character", async () => {
  const ws = new FakeWs([frame(2, "\u20ac\u20ac\u20ac"), success, { end: true }]); // 3 x 3 bytes
  const r = await exec(connectTo(ws), target, ["x"], { maxStdoutBytes: 1, maxStderrBytes: 7 });
  assert.equal(r.stderr, "\u20ac\u20ac");
  assert.ok(!r.stderr.includes("\ufffd"));
});

test("exec: a failed stdin write is reported as the cause, not as a generic drop", async () => {
  const ws = new FakeWs([]);
  ws.onSend = () => {
    ws.closed = true;
    ws.push({ end: true });
  };
  // the first send succeeds then the socket dies; the second send fails
  await assert.rejects(
    exec(connectTo(ws), target, ["cat"], { maxStdoutBytes: 10, stdin: Buffer.alloc(100 * 1024) }),
    (e: unknown) => e instanceof ExecStreamError && e.kind === "dropped" && /writing to the exec stream failed/.test(e.message),
  );
});
