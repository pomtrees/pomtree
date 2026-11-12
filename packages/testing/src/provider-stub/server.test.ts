import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { CLAUSE_IDS } from "../sandbox-conformance.ts";
import { tmpDir } from "../tmp.ts";
import { BREAK_FAULTS, type BreakFault, FaultPlan } from "./faults.ts";
import { assertFixtureFresh, FixtureError, loadFixture, parseFixture } from "./fixture-loader.ts";
import { bodySha256, MODEL_VERB_CLAUSES, type ResourceSpec } from "./model.ts";
import { ProviderStub } from "./server.ts";

// PROVIDER_STUB_BREAK=<mode> turns the stub into a deliberately WRONG provider (see faults.ts) so the tests that guard the matching behavior can be
// shown to fail: each mode must make this file exit non-zero. Read here only; the stub itself never reads the environment.
const rawBreak = process.env.PROVIDER_STUB_BREAK;
if (rawBreak !== undefined && !(BREAK_FAULTS as readonly string[]).includes(rawBreak)) {
  throw new Error(`PROVIDER_STUB_BREAK is "${rawBreak}", which is not a break mode; use one of ${BREAK_FAULTS.join(", ")}, or unset it`);
}
const BREAK = rawBreak as BreakFault | undefined;
const breakFaults = BREAK === undefined ? [] : [BREAK];

const HEADER = { provenance: "inferred", provider: "acme", source: "test hand-written", date: "2026-11-11", apiVersion: "v1", placeholders: [] };
const fixtureText = (entries: readonly object[], header: object = HEADER): string => [header, ...entries].map((l) => JSON.stringify(l)).join("\n");
const fixtureOf = (entries: readonly object[]) => parseFixture(fixtureText(entries), "test");
const SANDBOXES: ResourceSpec = { collection: "/sandboxes", idPrefix: "sbx" };

async function withStub(opts: Parameters<typeof ProviderStub.start>[0], body: (s: ProviderStub) => Promise<void>): Promise<void> {
  const stub = await ProviderStub.start(opts);
  try {
    await body(stub);
  } finally {
    await stub.close();
  }
}

const create = (s: ProviderStub, key: string | undefined, body: object = { template: "base", metadata: { owner: "me" } }) =>
  fetch(`${s.baseUrl}/sandboxes`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key === undefined ? {} : { "idempotency-key": key }) },
    body: JSON.stringify(body),
  });
const list = async (s: ProviderStub, filter?: string): Promise<{ id: string }[]> =>
  (await (await fetch(`${s.baseUrl}/sandboxes${filter === undefined ? "" : `?metadata=${encodeURIComponent(filter)}`}`)).json()) as { id: string }[];

// ---------------------------------------------------------------- fixture loader

test("loader: a fixture without provenance is rejected, naming the cause and the action (negative variants)", () => {
  const entry = { seq: 1, method: "GET", path: "/a", status: 200 };
  const cases: [string, string, RegExp][] = [
    ["no header line", JSON.stringify(entry), /no "provenance" field.*add a header/s],
    ["empty file", "", /file is empty.*add the provenance header/s],
    ["first line not JSON", "not json\n", /not JSON.*make it the header/s],
    ["provenance value outside the set", fixtureText([entry], { ...HEADER, provenance: "live" }), /provenance is "live".*"captured".*"inferred"/s],
    ["missing source", fixtureText([entry], { ...HEADER, source: undefined }), /"source" is missing.*add it/s],
    ["missing apiVersion", fixtureText([entry], { ...HEADER, apiVersion: undefined }), /"apiVersion" is missing.*add it/s],
    ["bad date", fixtureText([entry], { ...HEADER, date: "yesterday" }), /not YYYY-MM-DD/],
    ["missing placeholders", fixtureText([entry], { ...HEADER, placeholders: undefined }), /placeholders.*array of strings/s],
  ];
  for (const [what, text, msg] of cases)
    assert.throws(
      () => parseFixture(text, "f.jsonl"),
      (e) => e instanceof FixtureError && msg.test(e.message) && e.message.includes("f.jsonl"),
      what,
    );
  const ok = parseFixture(fixtureText([entry]), "f.jsonl");
  assert.equal(ok.header.provenance, "inferred");
  assert.equal(ok.entries.length, 1);
  assert.equal(parseFixture(fixtureText([entry], { ...HEADER, provenance: "captured" }), "f").header.provenance, "captured");
});

test("loader: malformed entries are rejected with a cause and an action", () => {
  const bad = (e: object) => () => parseFixture(fixtureText([e]), "f");
  assert.throws(bad({ seq: 1, method: "get", path: "/a", status: 200 }), /upper-case HTTP method/);
  assert.throws(bad({ seq: 1, method: "GET", path: "/a?x=1", status: 200 }), /put the query in "query"/);
  assert.throws(bad({ seq: 1, method: "GET", path: "/a", status: 99 }), /from 100 to 599/);
  assert.throws(bad({ seq: 1, method: "GET", path: "/a", status: 101 }), /needs a "stream"/);
  assert.throws(bad({ seq: 1, method: "GET", path: "/a", status: 200, stream: [{ dir: "out", data: "x" }] }), /must have status 101/);
  assert.throws(bad({ seq: 1, method: "GET", path: "/a", status: 101, stream: [{ dir: "sideways", data: "x" }] }), /stream step must be/);
  assert.throws(
    () =>
      parseFixture(
        fixtureText([
          { seq: 2, method: "GET", path: "/a", status: 200 },
          { seq: 2, method: "GET", path: "/b", status: 200 },
        ]),
        "f",
      ),
    /greater than the previous/,
  );
});

test("loader: loadFixture reads a file and reports an unreadable one with the action", () => {
  const dir = tmpDir("provider-stub-");
  const p = join(dir, "x.jsonl");
  writeFileSync(p, fixtureText([{ seq: 1, method: "GET", path: "/a", status: 200 }]));
  assert.equal(loadFixture(p).entries[0]?.path, "/a");
  assert.throws(() => loadFixture(join(dir, "missing.jsonl")), /cannot read fixture.*check the path/s);
});

test("model verbs map to real conformance clause ids", () => {
  for (const [verb, clause] of Object.entries(MODEL_VERB_CLAUSES)) assert.ok((CLAUSE_IDS as readonly string[]).includes(clause), `${verb} -> ${clause}`);
});

// ---------------------------------------------------------------- server lifecycle

test("server binds loopback on an ephemeral port and closes cleanly", async () => {
  const before = process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap").length;
  const stub = await ProviderStub.start({ resources: [SANDBOXES] });
  assert.match(stub.baseUrl, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
  assert.equal((await fetch(`${stub.baseUrl}/sandboxes`)).status, 200);
  await stub.close();
  await stub.close(); // idempotent
  await assert.rejects(fetch(`${stub.baseUrl}/sandboxes`), "connection refused after close");
  assert.equal(process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap").length, before, "listening handle released");
});

// ---------------------------------------------------------------- strict fixture matching

const REPLAY = [
  { seq: 1, method: "GET", path: "/v1/info", query: { verbose: "1" }, status: 200, responseHeaders: { "X-Provider": "acme" }, responseBody: { ok: true } },
  {
    seq: 2,
    method: "PUT",
    path: "/v1/files/a.txt",
    match: { requestHeaders: { "Idempotency-Key": "k1" }, requestBodySha256: bodySha256("hello") },
    status: 200,
    responseBody: "stored",
  },
];

test("unmatched requests fail: error response, recorded, assertNoUnmatched throws, no default response (negative variants)", async () => {
  const wrong: [string, RequestInit & { path: string }, RegExp][] = [
    ["method", { path: "/v1/info?verbose=1", method: "POST" }, /method is POST, expected GET/],
    ["path", { path: "/v1/other?verbose=1" }, /path is \/v1\/other, expected \/v1\/info/],
    ["query", { path: "/v1/info?verbose=2" }, /query is \?verbose=2, expected \?verbose=1/],
    ["missing query", { path: "/v1/info" }, /query is \?, expected \?verbose=1/],
  ];
  for (const [what, init, msg] of wrong) {
    await withStub({ fixture: fixtureOf(REPLAY) }, async (s) => {
      const { path, ...rest } = init;
      const r = await fetch(`${s.baseUrl}${path}`, rest);
      assert.equal(r.status, 501, `${what}: an unmatched request gets an error, never a default 200/404`);
      const body = (await r.json()) as { error: string; message: string };
      assert.equal(body.error, "provider-stub-unmatched");
      assert.match(body.message, msg, what);
      assert.equal(s.requests()[0]?.served, "UNMATCHED");
      assert.throws(() => s.assertNoUnmatched(), /1 unmatched request\(s\).*fix the adapter's request or add the exchange/s);
      assert.equal(s.model.remaining().length, 2, "a mismatch consumes nothing");
    });
  }
});

// fetch cannot send a body with GET, so these use node:http directly.
function httpReq(base: string, method: string, path: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const r = httpRequest(`${base}${path}`, { method, headers: body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) } }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString("utf8") }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

test("body matching: a body on a bodiless entry and a differing requestBody each fail for the body reason", async () => {
  await withStub({ fixture: fixtureOf(REPLAY) }, async (s) => {
    const r = await httpReq(s.baseUrl, "GET", "/v1/info?verbose=1", "x");
    assert.equal(r.status, 501);
    assert.match(r.text, /the request has a body but the fixture entry declares none/);
    assert.doesNotMatch(r.text, /method is|path is|query is/, "the failure is the body, nothing else");
    assert.equal(s.model.remaining().length, 2);
  });
  const withBody = [{ seq: 1, method: "POST", path: "/v1/make", requestBody: { a: 1 }, status: 200, responseBody: "ok" }];
  await withStub({ fixture: fixtureOf(withBody) }, async (s) => {
    const bad = await httpReq(s.baseUrl, "POST", "/v1/make", JSON.stringify({ a: 2 }));
    assert.equal(bad.status, 501);
    assert.match(bad.text, /request body differs from the fixture's requestBody/);
    assert.doesNotMatch(bad.text, /method is|path is|query is/);
    const good = await httpReq(s.baseUrl, "POST", "/v1/make", JSON.stringify({ a: 1 }));
    assert.equal(good.text, "ok");
  });
});

test("out-of-order requests fail even when they match a later entry", async () => {
  await withStub({ fixture: fixtureOf(REPLAY) }, async (s) => {
    const r = await fetch(`${s.baseUrl}/v1/files/a.txt`, { method: "PUT", headers: { "idempotency-key": "k1" }, body: "hello" });
    assert.equal(r.status, 501);
    assert.match(((await r.json()) as { message: string }).message, /seq 2, which is out of order/);
    assert.throws(() => s.assertNoUnmatched());
  });
});

test("replay in sequence passes, header and body matching hold, and a fresh key or changed body is unmatched", async () => {
  await withStub({ fixture: fixtureOf(REPLAY) }, async (s) => {
    const info = await fetch(`${s.baseUrl}/v1/info?verbose=1`);
    assert.deepEqual(await info.json(), { ok: true });
    assert.equal(info.headers.get("x-provider"), "acme");
    // retry with a fresh idempotency key must fail instead of replaying green
    const fresh = await fetch(`${s.baseUrl}/v1/files/a.txt`, { method: "PUT", headers: { "idempotency-key": "k2" }, body: "hello" });
    assert.equal(fresh.status, 501);
    assert.match(((await fresh.json()) as { message: string }).message, /header Idempotency-Key differs/);
    const changed = await fetch(`${s.baseUrl}/v1/files/a.txt`, { method: "PUT", headers: { "idempotency-key": "k1" }, body: "hellO" });
    assert.match(((await changed.json()) as { message: string }).message, /sha256 differs/);
    assert.equal(s.model.remaining().length, 1);
    const ok = await fetch(`${s.baseUrl}/v1/files/a.txt`, { method: "PUT", headers: { "idempotency-key": "k1" }, body: "hello" });
    assert.equal(await ok.text(), "stored");
    assert.equal(s.model.unmatched.length, 2, "the two deliberate mismatches are recorded");
    s.model.unmatched.length = 0;
    s.assertNoUnmatched();
    s.assertFixtureConsumed();
  });
});

test("assertNoUnmatched and assertFixtureConsumed pass a clean run and fail an unconsumed fixture", async () => {
  await withStub({ fixture: fixtureOf(REPLAY) }, async (s) => {
    s.assertNoUnmatched();
    assert.throws(() => s.assertFixtureConsumed(), /never requested: seq 1 GET \/v1\/info; seq 2 PUT/);
  });
});

test("recorder keeps method, path, query, header names (never values) and the idempotency key", async () => {
  await withStub({ resources: [SANDBOXES] }, async (s) => {
    await fetch(`${s.baseUrl}/sandboxes`, {
      method: "POST",
      headers: { authorization: "Bearer secret-value", "idempotency-key": "kk" },
      body: JSON.stringify({ a: 1 }),
    });
    const r = s.requests()[0]!;
    assert.deepEqual([r.method, r.path, r.idempotencyKey, r.served], ["POST", "/sandboxes", "kk", "create"]);
    assert.ok(r.headerNames.includes("authorization"));
    assert.ok(!JSON.stringify(r).includes("secret-value"));
  });
});

// ---------------------------------------------------------------- stateful model

test("stateful: create, list by tag, get and delete are consistent", async () => {
  await withStub({ resources: [SANDBOXES] }, async (s) => {
    const a = (await (await create(s, "ka", { template: "t", metadata: { owner: "alice" } })).json()) as { id: string };
    const b = (await (await create(s, "kb", { template: "t", metadata: { owner: "bob" } })).json()) as { id: string };
    assert.notEqual(a.id, b.id);
    assert.deepEqual(
      (await list(s)).map((r) => r.id),
      [a.id, b.id],
    );
    assert.deepEqual(
      (await list(s, "owner=alice")).map((r) => r.id),
      [a.id],
    );
    assert.deepEqual(await list(s, "owner=nobody"), []);
    const got = await fetch(`${s.baseUrl}/sandboxes/${b.id}`);
    assert.equal(((await got.json()) as { id: string }).id, b.id);
    assert.equal((await fetch(`${s.baseUrl}/sandboxes/${a.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await fetch(`${s.baseUrl}/sandboxes/${a.id}`)).status, 404, "deleted resource is gone");
    assert.equal((await fetch(`${s.baseUrl}/sandboxes/${a.id}`, { method: "DELETE" })).status, 404, "second delete reports not found");
    assert.deepEqual(
      (await list(s)).map((r) => r.id),
      [b.id],
    );
    s.assertNoUnmatched();
  });
});

test("stateful: bad requests are refused with a cause and an action; undeclared list parameters are unmatched", async () => {
  await withStub({ resources: [SANDBOXES] }, async (s) => {
    const noKey = await create(s, undefined);
    assert.equal(noKey.status, 400);
    assert.match(((await noKey.json()) as { message: string }).message, /needs the Idempotency-Key header; send one/);
    const notJson = await fetch(`${s.baseUrl}/sandboxes`, { method: "POST", headers: { "idempotency-key": "k" }, body: "nope" });
    assert.equal(notJson.status, 400);
    assert.equal((await fetch(`${s.baseUrl}/sandboxes?metadata=oops`)).status, 400);
    assert.equal(s.model.unmatched.length, 3, "bad create/filter requests are adapter bugs and are recorded as unmatched too");
    assert.ok(
      s
        .requests()
        .slice(0, 3)
        .every((r) => r.served === "UNMATCHED"),
    );
    s.model.unmatched.length = 0;
    const extra = await fetch(`${s.baseUrl}/sandboxes?limit=5`);
    assert.equal(extra.status, 501);
    assert.throws(() => s.assertNoUnmatched(), /not declared/);
  });
});

test("idempotent create: the same key and body replays one resource, a different body is a conflict", async () => {
  await withStub({ resources: [SANDBOXES], faults: breakFaults }, async (s) => {
    const first = await create(s, "key-1");
    const second = await create(s, "key-1");
    assert.equal(first.status, 201);
    assert.equal(second.status, 200, "the replay is not a second create");
    assert.equal(((await first.json()) as { id: string }).id, ((await second.json()) as { id: string }).id);
    assert.equal((await list(s)).length, 1, "exactly one resource exists");
    const conflict = await create(s, "key-1", { template: "other" });
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { error: string }).error, "idempotency-conflict");
  });
});

test("fresh-key retry: after an unknown outcome a retry with a NEW key is rejected, the same key adopts the resource", async () => {
  await withStub({ resources: [SANDBOXES], faults: breakFaults }, async (s) => {
    s.faults.arm("server-error-after-apply", { method: "POST" });
    const lost = await create(s, "key-1");
    assert.equal(lost.status, 503, "the caller sees an unknown outcome");
    assert.equal((await list(s)).length, 1, "but the create was applied");
    const fresh = await create(s, "key-2");
    assert.equal(fresh.status, 409, "a retry that changed the key is refused");
    assert.equal(((await fresh.json()) as { error: string }).error, "fresh-key-retry");
    assert.equal((await list(s)).length, 1, "no second resource");
    const same = await create(s, "key-1");
    assert.equal(same.status, 200, "the same key adopts the applied create");
    assert.equal((await list(s)).length, 1);
    // once adopted, a new key is no longer a retry of an unknown outcome
    assert.equal((await create(s, "key-3")).status, 201);
  });
});

test("faults: 429 carries Retry-After and applies nothing; a timeout never answers and applies nothing; 5xx applies first", async () => {
  await withStub({ resources: [SANDBOXES] }, async (s) => {
    s.faults.arm("rate-limit", { retryAfterS: 7 });
    const limited = await create(s, "k");
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "7");
    assert.equal((await list(s)).length, 0, "rate-limited create was not applied");
    s.faults.arm("timeout", { method: "POST" });
    await assert.rejects(
      fetch(`${s.baseUrl}/sandboxes`, { method: "POST", headers: { "idempotency-key": "k" }, body: "{}", signal: AbortSignal.timeout(300) }),
    );
    assert.equal((await list(s)).length, 0, "timed-out create was not applied");
    assert.equal((await create(s, "k")).status, 201, "faults are consumed; the retry succeeds");
    s.faults.arm("server-error-after-apply", { method: "DELETE", status: 502 });
    const id = (await list(s))[0]!.id;
    assert.equal((await fetch(`${s.baseUrl}/sandboxes/${id}`, { method: "DELETE" })).status, 502);
    assert.equal((await list(s)).length, 0, "delete was applied before the 5xx");
    assert.deepEqual(
      s.faults.fired.map((f) => f.name),
      ["rate-limit", "timeout", "server-error-after-apply"],
    );
    s.assertNoUnmatched();
  });
});

test("faults: arming rejects an unknown name and a non-positive count with the action", () => {
  const plan = new FaultPlan();
  assert.throws(() => plan.arm("nope" as never), /unknown provider-stub fault.*use one of/);
  assert.throws(() => plan.arm("timeout", { times: 0 }), /times=0.*1 or more/);
  assert.equal(plan.take("timeout", "GET", "/"), undefined);
});

// ---------------------------------------------------------------- websocket upgrade

const WS_FIXTURE = [
  {
    seq: 1,
    method: "GET",
    path: "/exec",
    status: 101,
    responseHeaders: { "Sec-WebSocket-Protocol": "v5.channel" },
    stream: [
      { dir: "out", data: "a" },
      { dir: "out", data: "b" },
      { dir: "in", data: "ping" },
      { dir: "out", data: "c" },
    ],
  },
];

function playWs(url: string, protocols: string[], sendAfter = 2): Promise<{ messages: string[]; code: number; protocol: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
    const messages: string[] = [];
    ws.onmessage = (e) => {
      messages.push(String(e.data));
      if (messages.length === sendAfter) ws.send("ping");
    };
    ws.onclose = (e) => resolve({ messages, code: e.code, protocol: ws.protocol });
    ws.onerror = () => reject(new Error("websocket error"));
  });
}

test("upgrade: frames arrive in sequence, the fixture's subprotocol is selected and the script ends with a normal close", async () => {
  await withStub({ fixture: fixtureOf(WS_FIXTURE), faults: breakFaults }, async (s) => {
    const r = await playWs(s.wsUrl("/exec"), ["v5.channel"]);
    assert.deepEqual(r.messages, ["a", "b", "c"], "server frames are delivered in the fixture's order");
    assert.equal(r.code, 1000);
    assert.equal(r.protocol, "v5.channel");
    s.assertNoUnmatched();
    s.assertFixtureConsumed();
  });
});

test("upgrade: a wrong client frame, an unknown path and a missing subprotocol are unmatched", async () => {
  await withStub({ fixture: fixtureOf(WS_FIXTURE) }, async (s) => {
    const wrong = await new Promise<number>((resolve) => {
      const ws = new WebSocket(s.wsUrl("/exec"), ["v5.channel"]);
      let n = 0;
      ws.onmessage = () => {
        if (++n === 2) ws.send("pong?");
      };
      ws.onclose = (e) => resolve(e.code);
    });
    assert.equal(wrong, 1008);
    assert.throws(() => s.assertNoUnmatched(), /differs from the fixture's step 2/);
  });
  await withStub({ fixture: fixtureOf(WS_FIXTURE) }, async (s) => {
    await assert.rejects(playWs(s.wsUrl("/other"), []), "handshake refused");
    assert.throws(() => s.assertNoUnmatched(), /path is \/other/);
  });
  await withStub({ fixture: fixtureOf(WS_FIXTURE) }, async (s) => {
    await assert.rejects(playWs(s.wsUrl("/exec"), []), "no subprotocol offered");
    assert.throws(() => s.assertNoUnmatched(), /selects subprotocol "v5.channel"/);
  });
});

// A raw client, so the server is held to RFC 6455 independently of any client library.
function maskedFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = randomBytes(4);
  const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
  const n = payload.length;
  const len = n < 126 ? Buffer.from([0x80 | n]) : Buffer.from([0x80 | 126, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode]), len, mask, body]);
}
const unmaskedFrame = (opcode: number, payload: Buffer): Buffer => Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);

function serverFrames(buf: Buffer): { opcode: number; payload: Buffer }[] {
  const out: { opcode: number; payload: Buffer }[] = [];
  for (let i = 0; i + 2 <= buf.length; ) {
    const len = buf[i + 1]!;
    assert.equal(len & 0x80, 0, "server frames are not masked");
    out.push({ opcode: buf[i]! & 0x0f, payload: buf.subarray(i + 2, i + 2 + len) });
    i += 2 + len;
  }
  return out;
}

async function rawUpgrade(
  s: ProviderStub,
  path: string,
  o: { extra?: Buffer; key?: string } = {},
): Promise<{ sock: Socket; head: string; key: string; read: () => Promise<Buffer>; rest: Buffer }> {
  const port = Number(new URL(s.baseUrl).port);
  const sock = connect(port, "127.0.0.1");
  const key = o.key ?? randomBytes(16).toString("base64");
  const chunks: Buffer[] = [];
  let wake: (() => void) | undefined;
  sock.on("data", (c) => {
    chunks.push(c);
    wake?.();
  });
  sock.on("error", () => {});
  await new Promise<void>((r) => sock.once("connect", r));
  sock.write(
    Buffer.concat([
      Buffer.from(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: v5.channel\r\n\r\n`,
      ),
      o.extra ?? Buffer.alloc(0),
    ]),
  );
  const read = async (): Promise<Buffer> => {
    if (chunks.length === 0) await new Promise<void>((r) => (wake = r));
    return Buffer.concat(chunks.splice(0));
  };
  let all = Buffer.alloc(0);
  while (!all.includes("\r\n\r\n")) all = Buffer.concat([all, await read()]);
  const at = all.indexOf("\r\n\r\n") + 4;
  return { sock, head: all.subarray(0, at).toString("latin1"), key, read, rest: all.subarray(at) };
}

const RAW_FIXTURE = [
  {
    seq: 1,
    method: "GET",
    path: "/exec",
    status: 101,
    responseHeaders: { "Sec-WebSocket-Protocol": "v5.channel" },
    stream: [
      { dir: "out", data: "hello" },
      { dir: "in", data: "ping" },
      { dir: "out", data: "bye" },
    ],
  },
];

test("upgrade protocol: Accept header, unmasked server frames, ping/pong, fragmented client message, close handshake", { timeout: 20_000 }, async () => {
  await withStub({ fixture: fixtureOf(RAW_FIXTURE) }, async (s) => {
    const c = await rawUpgrade(s, "/exec");
    assert.match(c.head, /^HTTP\/1\.1 101 /);
    const accept = createHash("sha1").update(`${c.key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    assert.ok(c.head.includes(`Sec-WebSocket-Accept: ${accept}`), "Accept is sha1(key+GUID)");
    let buf = c.rest;
    while (buf.length < 7) buf = Buffer.concat([buf, await c.read()]);
    assert.deepEqual(
      serverFrames(buf).map((f) => f.payload.toString()),
      ["hello"],
    );
    c.sock.write(maskedFrame(0x9, Buffer.from("are-you-there")));
    let pong = await c.read();
    assert.equal(pong[0], 0x8a, "pong opcode");
    assert.equal(pong.subarray(2, 2 + pong[1]!).toString(), "are-you-there");
    c.sock.write(maskedFrame(0x1, Buffer.from("pi"), false));
    c.sock.write(maskedFrame(0x0, Buffer.from("ng"), true));
    pong = await c.read();
    let frames = serverFrames(pong);
    let acc = pong;
    while (!frames.some((f) => f.opcode === 8)) {
      acc = Buffer.concat([acc, await c.read()]);
      frames = serverFrames(acc);
    }
    assert.equal(frames[0]?.payload.toString(), "bye", "the fragmented message was reassembled and matched");
    const close = frames.find((f) => f.opcode === 8)!;
    assert.equal(close.payload.readUInt16BE(0), 1000);
    c.sock.write(maskedFrame(0x8, close.payload.subarray(0, 2)));
    await new Promise<void>((r) => c.sock.once("close", () => r()));
    s.assertNoUnmatched();
  });
});

test("upgrade protocol: an unmasked client frame is a protocol error (close 1002)", { timeout: 20_000 }, async () => {
  await withStub({ fixture: fixtureOf(RAW_FIXTURE) }, async (s) => {
    const c = await rawUpgrade(s, "/exec");
    c.sock.write(unmaskedFrame(0x1, Buffer.from("ping")));
    let buf = c.rest;
    for (let i = 0; i < 10 && !serverFrames(buf).some((f) => f.opcode === 8); i++) buf = Buffer.concat([buf, await c.read()]);
    const close = serverFrames(buf).find((f) => f.opcode === 8);
    assert.equal(close?.payload.readUInt16BE(0), 1002);
    c.sock.destroy();
  });
});

test("upgrade protocol: a client that drops mid-script is recorded as unmatched", { timeout: 20_000 }, async () => {
  await withStub({ fixture: fixtureOf(RAW_FIXTURE) }, async (s) => {
    const c = await rawUpgrade(s, "/exec");
    c.sock.destroy();
    for (let i = 0; i < 200 && s.model.unmatched.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.throws(() => s.assertNoUnmatched(), /dropped after 1 of 3 steps/);
  });
});

/** Reads server frames until a close frame (or the socket ends). */
async function framesUntilClose(c: Awaited<ReturnType<typeof rawUpgrade>>): Promise<{ opcode: number; payload: Buffer }[]> {
  let acc = c.rest;
  for (let i = 0; i < 20 && !serverFrames(acc).some((f) => f.opcode === 8); i++) acc = Buffer.concat([acc, await c.read()]);
  return serverFrames(acc);
}
const closeCode = (frames: { opcode: number; payload: Buffer }[]): number | undefined => frames.find((f) => f.opcode === 8)?.payload.readUInt16BE(0);

test("upgrade: frame bytes sent in the same packet as the handshake are processed (the client's head)", { timeout: 20_000 }, async () => {
  await withStub({ fixture: fixtureOf(RAW_FIXTURE) }, async (s) => {
    const c = await rawUpgrade(s, "/exec", { extra: maskedFrame(0x1, Buffer.from("ping")) });
    const frames = await framesUntilClose(c);
    assert.deepEqual(
      frames.filter((f) => f.opcode === 1).map((f) => f.payload.toString()),
      ["hello", "bye"],
    );
    assert.equal(closeCode(frames), 1000);
    s.assertNoUnmatched();
    c.sock.destroy();
  });
});

test("upgrade protocol: control frames over 125 bytes or without FIN, invalid UTF-8 and oversize messages are protocol errors", {
  timeout: 20_000,
}, async () => {
  const cases: [string, Buffer, number][] = [
    ["ping payload over 125 bytes", maskedFrame(0x9, Buffer.alloc(126, 0x61)), 1002],
    ["fragmented control frame", maskedFrame(0x9, Buffer.from("x"), false), 1002],
    ["invalid UTF-8 text", maskedFrame(0x1, Buffer.from([0xff, 0xfe])), 1007],
    [
      "reassembled message over the cap",
      Buffer.concat([maskedFrame(0x1, Buffer.alloc(40, 0x61), false), maskedFrame(0x0, Buffer.alloc(40, 0x61), true)]),
      1009,
    ],
  ];
  for (const [what, bytes, code] of cases) {
    await withStub({ fixture: fixtureOf(RAW_FIXTURE), maxBodyBytes: 64 }, async (s) => {
      const c = await rawUpgrade(s, "/exec");
      c.sock.write(bytes);
      assert.equal(closeCode(await framesUntilClose(c)), code, what);
      c.sock.destroy();
    });
  }
});

test("upgrade: a Sec-WebSocket-Key that is not 16 bytes of base64 is refused with 400", { timeout: 20_000 }, async () => {
  await withStub({ fixture: fixtureOf(RAW_FIXTURE) }, async (s) => {
    const c = await rawUpgrade(s, "/exec", { key: "dGVzdA==" });
    assert.match(c.head, /^HTTP\/1\.1 400 /);
    c.sock.destroy();
  });
});

test("upgrade: rate-limit and 5xx-after-apply faults answer with their real status, Retry-After and body, not 426", { timeout: 20_000 }, async () => {
  await withStub({ fixture: fixtureOf(RAW_FIXTURE) }, async (s) => {
    s.faults.arm("rate-limit", { retryAfterS: 9 });
    const limited = await rawUpgrade(s, "/exec");
    assert.match(limited.head, /^HTTP\/1\.1 429 /);
    assert.match(limited.head, /retry-after: 9/i);
    assert.equal(s.model.remaining().length, 1, "rate-limited upgrade applied nothing");
    limited.sock.destroy();
    s.faults.arm("server-error-after-apply", { status: 502 });
    const lost = await rawUpgrade(s, "/exec");
    assert.match(lost.head, /^HTTP\/1\.1 502 /);
    assert.match(lost.head, /content-type: application\/json/i);
    assert.equal(s.model.remaining().length, 0, "the upgrade was applied before the 5xx");
    let body = lost.rest.toString();
    while (!body.includes("server-error")) body += (await lost.read()).toString();
    assert.match(body, /"error":"server-error"/);
    lost.sock.destroy();
  });
});

test("an oversize body is recorded as unmatched with a 413, and a client that aborts mid-body is recorded without an unhandled rejection", {
  timeout: 20_000,
}, async () => {
  const rejections: unknown[] = [];
  const onRej = (e: unknown) => rejections.push(e);
  process.on("unhandledRejection", onRej);
  try {
    await withStub({ resources: [SANDBOXES], maxBodyBytes: 64 }, async (s) => {
      const big = await httpReq(s.baseUrl, "POST", "/sandboxes", "x".repeat(500));
      assert.equal(big.status, 413);
      assert.equal(s.model.unmatched.length, 1);
      assert.match(s.model.unmatched[0]!.reason, /exceeds 64 bytes/);
      assert.throws(() => s.assertNoUnmatched());
      s.model.unmatched.length = 0;
      const port = Number(new URL(s.baseUrl).port);
      const sock = connect(port, "127.0.0.1");
      sock.on("error", () => {});
      await new Promise<void>((r) => sock.once("connect", r));
      sock.write('POST /sandboxes HTTP/1.1\r\nHost: x\r\nContent-Length: 50\r\nIdempotency-Key: k\r\n\r\n{"a"');
      await new Promise((r) => setTimeout(r, 50));
      sock.destroy();
      for (let i = 0; i < 200 && s.model.unmatched.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(s.model.unmatched.length, 1, "the aborted request is recorded");
      assert.match(s.model.unmatched[0]!.reason, /aborted|closed before/);
      assert.equal(s.model.resources("/sandboxes").length, 0, "an aborted create applies nothing");
      await new Promise((r) => setTimeout(r, 50));
    });
  } finally {
    process.off("unhandledRejection", onRej);
  }
  assert.deepEqual(rejections, []);
});

test("requireHeaderNames: a request that drops a required header is unmatched even when everything else matches", async () => {
  await withStub({ fixture: fixtureOf(REPLAY), resources: [SANDBOXES], requireHeaderNames: ["Authorization"] }, async (s) => {
    const r = await fetch(`${s.baseUrl}/v1/info?verbose=1`);
    assert.equal(r.status, 501);
    assert.match(((await r.json()) as { message: string }).message, /missing required header\(s\) authorization/);
    const ok = await fetch(`${s.baseUrl}/v1/info?verbose=1`, { headers: { authorization: "Bearer placeholder" } });
    assert.equal(ok.status, 200);
    assert.equal((await fetch(`${s.baseUrl}/sandboxes`)).status, 501, "resource routes are held to it too");
  });
});

test("fixture freshness: a provenance date older than 180 days fails with the action; recent passes (injected now)", () => {
  const fx = (date: string) => parseFixture(fixtureText([], { ...HEADER, date }), "f.jsonl");
  const now = new Date("2026-11-11T00:00:00Z");
  assertFixtureFresh(fx("2026-11-11"), now);
  assertFixtureFresh(fx("2026-05-15"), now); // 180 days exactly is still fresh
  assert.throws(
    () => assertFixtureFresh(fx("2026-05-14"), now),
    (e) => e instanceof FixtureError && /181 days old.*f\.jsonl.*refresh|re-?record|re-?check/s.test(e.message),
  );
  assert.throws(() => assertFixtureFresh(fx("2027-01-01"), now), /in the future/);
});

test("out-of-order-frame armed on a stream with nothing to swap fails loudly instead of passing", async () => {
  await withStub({ fixture: fixtureOf(RAW_FIXTURE), faults: ["out-of-order-frame"] }, async (s) => {
    await assert.rejects(playWs(s.wsUrl("/exec"), ["v5.channel"]));
    assert.throws(() => s.assertNoUnmatched(), /no two consecutive "out" frames/);
    assert.equal(s.requests()[0]?.served, "UNMATCHED");
    assert.equal(s.model.unmatched.length, 1, "recorded once");
  });
});

// ---------------------------------------------------------------- negative controls: each break mode makes this file fail

const execFileP = promisify(execFile);
// A nested `node --test` that inherits NODE_TEST_CONTEXT reports through the parent and exits 0 whatever happened, which would hide a failing break mode.
const childEnv = (): NodeJS.ProcessEnv => {
  const { NODE_TEST_CONTEXT: _drop, ...rest } = process.env;
  return rest;
};
const FAILS_BY: Record<BreakFault, string> = {
  "idempotent-create": "idempotent create: the same key and body replays one resource",
  "fresh-key-retry": "fresh-key retry: after an unknown outcome a retry with a NEW key is rejected",
  "out-of-order-frame": "upgrade: frames arrive in sequence",
};

interface ChildRun {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
}
const runChild = (args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ChildRun> =>
  execFileP(process.execPath, args, { env, timeout: timeoutMs }).then(
    (o) => ({ code: 0, timedOut: false, stdout: o.stdout }),
    (e: { code?: number | string | null; killed?: boolean; signal?: string | null; stdout?: string }) => ({
      code: typeof e.code === "number" ? e.code : null,
      timedOut: e.killed === true || (e.signal ?? null) !== null,
      stdout: e.stdout ?? "",
    }),
  );
/** A break-mode child counts as failing only when it exited on its own with a non-zero code AND the named guarding test is the one that failed. */
function assertBrokenRun(r: ChildRun, mode: string, guard: string): void {
  assert.equal(
    r.timedOut,
    false,
    `PROVIDER_STUB_BREAK=${mode}: the child hung or was killed, which is a harness failure and not a failing test; investigate the hang`,
  );
  assert.ok(r.code !== null && r.code !== 0, `PROVIDER_STUB_BREAK=${mode} must exit non-zero on its own`);
  assert.match(
    r.stdout,
    new RegExp(`not ok \\d+ - ${guard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    `${mode}: the guarding test "${guard}" must be the one that fails`,
  );
}

test("negative-control harness: a hung child is a harness failure, and a clean exit is not a break", async () => {
  const hung = await runChild(["-e", "setInterval(() => {}, 1000)"], childEnv(), 300);
  assert.equal(hung.timedOut, true);
  assert.equal(hung.code, null);
  assert.throws(() => assertBrokenRun(hung, "x", "t"), /hung or was killed/);
  const clean = await runChild(["-e", "console.log('ok 1 - t')"], childEnv(), 10_000);
  assert.throws(() => assertBrokenRun(clean, "x", "t"), /exit non-zero/);
  const wrongTest = await runChild(["-e", "console.log('not ok 1 - other'); process.exit(1)"], childEnv(), 10_000);
  assert.throws(() => assertBrokenRun(wrongTest, "x", "t"), /guarding test "t" must be the one/);
});

test("negative controls: each PROVIDER_STUB_BREAK mode makes this file exit non-zero, failing the test that guards it", {
  skip: BREAK !== undefined && "running as a break child",
}, async () => {
  const self = fileURLToPath(import.meta.url);
  await Promise.all(
    BREAK_FAULTS.map(async (mode) => {
      // --test-isolation=none keeps the run in one process, so killing a hung child cannot orphan a grandchild.
      const r = await runChild(
        ["--test", "--test-isolation=none", "--test-reporter=tap", "--test-timeout=60000", self],
        { ...childEnv(), PROVIDER_STUB_BREAK: mode },
        120_000,
      );
      assertBrokenRun(r, mode, FAILS_BY[mode]);
    }),
  );
});

test("an unknown PROVIDER_STUB_BREAK value is refused at load with the accepted values", async () => {
  const self = fileURLToPath(import.meta.url);
  const r = await execFileP(process.execPath, [self], { env: { ...childEnv(), PROVIDER_STUB_BREAK: "typo" }, timeout: 60_000 }).then(
    () => ({ code: 0, err: "" }),
    (e: { code?: number; stderr?: string }) => ({ code: e.code ?? -1, err: e.stderr ?? "" }),
  );
  assert.notEqual(r.code, 0);
  assert.match(r.err, /not a break mode; use one of idempotent-create, fresh-key-retry, out-of-order-frame/);
});
