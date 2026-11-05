import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { TransportError, httpTransport, socketTransport } from "./client.ts";

// Socket dirs are removed when the file's tests finish (pomtree does not depend on @pomtree/testing's tmpDir).
const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

async function serve(h: (req: IncomingMessage, res: ServerResponse) => void) {
  const dir = mkdtempSync(join(tmpdir(), "pomtree-"));
  made.push(dir);
  const path = join(dir, "s.sock");
  const server: Server = createServer(h);
  await new Promise<void>((r) => server.listen(path, r));
  return { path, close: () => (server.closeAllConnections(), server.close()) };
}

test("multibyte text split across chunks survives", async () => {
  const s = await serve((_, res) => {
    const bytes = Buffer.from(JSON.stringify({ t: "héllo 🙂 世界" }));
    const cut = bytes.indexOf(0xf0) + 2; // inside the emoji
    res.writeHead(200, { "content-type": "application/json" });
    res.write(bytes.subarray(0, cut));
    setTimeout(() => res.end(bytes.subarray(cut)), 20);
  });
  try {
    const r = await socketTransport(s.path, "t")({ method: "GET", path: "/" });
    assert.equal(r.body.t, "héllo 🙂 世界");
  } finally {
    s.close();
  }
});

test("a body truncated mid-stream rejects as unreachable instead of hanging", async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-length": "100" });
    res.write('{"a":');
    setTimeout(() => req.socket.destroy(), 20);
  });
  try {
    await assert.rejects(socketTransport(s.path, "t")({ method: "GET", path: "/" }), TransportError);
  } finally {
    s.close();
  }
});

test("a silent daemon times out, but timeoutMs 0 waits as long as the call blocks", async () => {
  const s = await serve((_, res) => void setTimeout(() => res.end('{"ok":1}'), 150));
  try {
    const t = socketTransport(s.path, "t", 50);
    await assert.rejects(t({ method: "GET", path: "/" }), (e) => e instanceof TransportError && /no response within 50ms/.test(e.message));
    assert.deepEqual((await t({ method: "GET", path: "/", timeoutMs: 0 })).body, { ok: 1 });
    assert.deepEqual((await t({ method: "GET", path: "/", timeoutMs: 1000 })).body, { ok: 1 });
  } finally {
    s.close();
  }
});

test("httpTransport talks TCP with the bearer token and decodes UTF-8", async () => {
  let auth: string | undefined;
  const server = createServer((req, res) => {
    auth = req.headers.authorization;
    res.writeHead(200);
    res.end(JSON.stringify({ t: "héllo 🙂" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const r = await httpTransport(`http://127.0.0.1:${port}`, "tok")({ method: "GET", path: "/" });
    assert.equal(r.body.t, "héllo 🙂");
    assert.equal(auth, "Bearer tok");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("httpTransport reports an unreachable daemon and rejects non-http URLs", async () => {
  await assert.rejects(httpTransport("http://127.0.0.1:1", "t")({ method: "GET", path: "/" }), TransportError);
  assert.throws(() => httpTransport("https://x", "t"), TransportError);
});

test("a Buffer body is sent as octet-stream and a raw reply comes back as bytes", async () => {
  let seen: { type?: string; len?: number; bytes?: Buffer } = {};
  const s = await serve((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      seen = { type: req.headers["content-type"], len: Number(req.headers["content-length"]), bytes: Buffer.concat(chunks) };
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([0x00, 0x01, 0xff]));
    });
  });
  try {
    const r = await socketTransport(s.path, "t")({ method: "POST", path: "/x", body: Buffer.from("hello"), raw: true });
    assert.equal(seen.type, "application/octet-stream");
    assert.equal(seen.len, 5);
    assert.deepEqual(seen.bytes, Buffer.from("hello"));
    assert.deepEqual(r.body, Buffer.from([0x00, 0x01, 0xff]));
  } finally {
    s.close();
  }
});

test("a JSON body keeps its content-type and a non-raw reply is parsed", async () => {
  let ct: string | undefined;
  const s = await serve((req, res) => {
    ct = req.headers["content-type"];
    req.resume();
    res.end('{"ok":1}');
  });
  try {
    const r = await socketTransport(s.path, "t")({ method: "POST", path: "/x", body: { ok: 1 } });
    assert.equal(ct, "application/json");
    assert.deepEqual(r.body, { ok: 1 });
  } finally {
    s.close();
  }
});
