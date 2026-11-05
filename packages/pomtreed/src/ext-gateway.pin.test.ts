import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { defaultFetch } from "./ext-gateway.ts";

async function withServer<T>(handler: Parameters<typeof createServer>[1], fn: (port: number) => Promise<T>): Promise<T> {
  const srv = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    return await fn((srv.address() as AddressInfo).port);
  } finally {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
}

async function text(b: AsyncIterable<Uint8Array> | null): Promise<string> {
  let out = "";
  for await (const c of b ?? []) out += Buffer.from(c).toString();
  return out;
}

test("defaultFetch connects to the pinned address (lookup honours all) and keeps the original Host", async () => {
  await withServer(
    (req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end(`host=${req.headers.host}`);
    },
    async (port) => {
      // The hostname does not resolve anywhere: only the pin can make this connect (no DNS, no internet).
      const url = `http://pinned.invalid:${port}/x`;
      const res = await defaultFetch(url, { redirect: "manual", pin: { hostname: "pinned.invalid", address: "127.0.0.1", family: 4 } });
      assert.equal(res.status, 200);
      assert.equal(await text(res.body), `host=pinned.invalid:${port}`);
    },
  );
});

test("defaultFetch aborts a pending request on signal", async () => {
  await withServer(
    () => {}, // never responds
    async (port) => {
      const ac = new AbortController();
      const p = defaultFetch(`http://pinned.invalid:${port}/`, {
        redirect: "manual",
        signal: ac.signal,
        pin: { hostname: "pinned.invalid", address: "127.0.0.1", family: 4 },
      });
      setTimeout(() => ac.abort(), 20);
      await assert.rejects(p, /aborted/);
      const pre = new AbortController();
      pre.abort();
      await assert.rejects(
        defaultFetch(`http://pinned.invalid:${port}/`, {
          redirect: "manual",
          signal: pre.signal,
          pin: { hostname: "pinned.invalid", address: "127.0.0.1", family: 4 },
        }),
        /aborted/,
      );
    },
  );
});

test("defaultFetch destroys an in-flight body on signal", async () => {
  await withServer(
    (_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.write("part");
    },
    async (port) => {
      const ac = new AbortController();
      const res = await defaultFetch(`http://pinned.invalid:${port}/`, {
        redirect: "manual",
        signal: ac.signal,
        pin: { hostname: "pinned.invalid", address: "127.0.0.1", family: 4 },
      });
      setTimeout(() => ac.abort(), 20);
      await assert.rejects(text(res.body));
    },
  );
});

// The real transport adds no User-Agent of its own (node:http sends none): what the capture broker passes is all that goes out.
test("defaultFetch sends no User-Agent unless one is given, and the given one verbatim", async () => {
  await withServer(
    (req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end(JSON.stringify(req.headers["user-agent"] ?? null));
    },
    async (port) => {
      const pin = { hostname: "pinned.invalid", address: "127.0.0.1", family: 4 };
      const url = `http://pinned.invalid:${port}/`;
      assert.equal(await text((await defaultFetch(url, { redirect: "manual", pin })).body), "null");
      const ua = "pomtree-test ops@example.org";
      assert.equal(await text((await defaultFetch(url, { redirect: "manual", pin, headers: { "user-agent": ua } })).body), JSON.stringify(ua));
    },
  );
});
