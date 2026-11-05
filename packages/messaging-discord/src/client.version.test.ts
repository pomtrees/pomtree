import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { test } from "node:test";
import { EXPECTED_MESSAGING_API, MESSAGING_API_HEADER, MessagingVersionError, pomtreedClient } from "./client.ts";

// A scripted pomtreed: every response carries `headers` (undefined = no version header) and the scripted status.
async function withPomtreed(
  script: { status: number; body: unknown; version?: string },
  fn: (client: ReturnType<typeof pomtreedClient>) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (script.version !== undefined) headers[MESSAGING_API_HEADER] = script.version;
      res.writeHead(script.status, headers);
      res.end(JSON.stringify(script.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(pomtreedClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`, "ht.discord.tok"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const post = { channel: "discord", sender: { channel: "discord", sender: "u1" }, body: "hi", idempotencyKey: "m1" } as const;
const failed = { channel: "discord", purpose: "ask", subject: "s", reason: "r", idempotencyKey: "dl:1-1" } as const;

function rejectsWith(cause: "missing" | "mismatch", got?: string) {
  return (e: unknown) => {
    assert.ok(e instanceof MessagingVersionError);
    assert.equal(e.cause, cause);
    assert.equal(e.got, got);
    assert.match(e.message, /messaging API|x-pomtree-messaging-api/);
    return true;
  };
}

const calls = {
  outbox: (c: ReturnType<typeof pomtreedClient>) => c.outbox(0),
  post: (c: ReturnType<typeof pomtreedClient>) => c.postMessage(post),
  failed: (c: ReturnType<typeof pomtreedClient>) => c.messageFailed!(failed),
  hostRead: (c: ReturnType<typeof pomtreedClient>) => c.hostRead("/agents", "u1"),
};
const okStatus = { outbox: 200, post: 201, failed: 201, hostRead: 200 } as const;

for (const name of Object.keys(calls) as (keyof typeof calls)[]) {
  test(`pomtreedClient ${name}: the matching version header is accepted`, async () => {
    await withPomtreed(
      { status: okStatus[name], body: name === "outbox" ? [] : { kind: "answered", escalation: "es-x" }, version: String(EXPECTED_MESSAGING_API) },
      async (c) => {
        await calls[name](c);
      },
    );
  });
  test(`pomtreedClient ${name}: a missing version header on success is refused (missing)`, async () => {
    await withPomtreed({ status: okStatus[name], body: name === "outbox" ? [] : {} }, async (c) => {
      await assert.rejects(calls[name](c), rejectsWith("missing"));
    });
  });
  for (const v of ["2", "0", "1.0", "", "one"]) {
    test(`pomtreedClient ${name}: version ${JSON.stringify(v)} is refused (mismatch)`, async () => {
      await withPomtreed({ status: okStatus[name], body: name === "outbox" ? [] : {}, version: v }, async (c) => {
        await assert.rejects(calls[name](c), rejectsWith("mismatch", v));
      });
    });
  }
}

test("pomtreedClient: a different version is refused on an error status too", async () => {
  await withPomtreed({ status: 409, body: { error: "x" }, version: "2" }, async (c) => {
    await assert.rejects(c.postMessage(post), rejectsWith("mismatch", "2"));
    await assert.rejects(c.hostRead("/agents", "u1"), rejectsWith("mismatch", "2"));
  });
});

test("pomtreedClient: a header-less non-2xx (pomtreed's transport layer: 401, 404) keeps the plain HTTP error, not a version error", async () => {
  await withPomtreed({ status: 401, body: { error: "missing or invalid token" } }, async (c) => {
    await assert.rejects(c.outbox(0), (e: unknown) => !(e instanceof MessagingVersionError) && /HTTP 401/.test(String(e)));
    await assert.rejects(c.postMessage(post), (e: unknown) => !(e instanceof MessagingVersionError) && /HTTP 401/.test(String(e)));
    assert.deepEqual(await c.hostRead("/agents", "u1"), { status: 401, body: { error: "missing or invalid token" } });
  });
});
