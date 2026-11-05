import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { FetchFn } from "../../packages/pomtreed/src/ext-gateway.ts";
import {
  type AuditSink,
  type AuditedFetch,
  auditedModelFetch,
  classifyError,
  createAuditedFetch,
  denyReasonOf,
  type HostAuditRecord,
  type ModelFetchCtx,
  type ModelFetchInner,
} from "./content-live-fetch.mts";

const enc = new TextEncoder();
const INIT = { redirect: "manual" as const };

async function* bodyOf(parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield enc.encode(p);
}

// Scripted inner transport: every call is recorded; the response is fixed per test.
function scripted(parts: string[] = ["hello", "world"], status = 200) {
  const calls: string[] = [];
  const fetch: FetchFn = async (url) => {
    calls.push(url);
    return { status, headers: { get: () => null }, body: bodyOf(parts) };
  };
  return { fetch, calls };
}

async function drain(body: AsyncIterable<Uint8Array> | null): Promise<number> {
  let n = 0;
  if (body) for await (const chunk of body) n += chunk.byteLength;
  return n;
}

describe("createAuditedFetch", () => {
  it("counts consumed bytes and numbers records contiguously from 1", async () => {
    const inner = scripted(["hello", "world"]);
    const audited = createAuditedFetch(inner.fetch);
    for (const url of ["https://a.example.com/1", "https://b.example.com/2", "https://c.example.com/3"]) {
      const res = await audited.fetch(url, INIT);
      assert.equal(res.status, 200);
      assert.equal(await drain(res.body), 10);
    }
    const records = audited.records();
    assert.equal(audited.count(), 3);
    assert.deepEqual(
      records.map((r) => r.sequence),
      [1, 2, 3],
    );
    assert.deepEqual(
      records.map((r) => [r.stream, r.authority, r.port, r.outcome, r.bytes, r.status]),
      [
        ["host", "a.example.com", 443, "complete", 10, 200],
        ["host", "b.example.com", 443, "complete", 10, 200],
        ["host", "c.example.com", 443, "complete", 10, 200],
      ],
    );
    assert.equal(inner.calls.length, 3);
  });

  it("records the default port 80 for http URLs", async () => {
    const inner = scripted();
    const audited = createAuditedFetch(inner.fetch);
    const res = await audited.fetch("http://news.example.org/x", INIT);
    await drain(res.body);
    assert.equal(audited.records()[0]?.port, 80);
  });

  it("denies disallowed URLs before the inner fetch and records each as denied", async () => {
    const inner = scripted();
    const audited = createAuditedFetch(inner.fetch);
    const cases: [string, string, number][] = [
      ["http://127.0.0.1/", "127.0.0.1", 80],
      ["http://localhost/", "localhost", 80],
      ["http://10.0.0.1/", "10.0.0.1", 80],
      ["https://user:pw@example.com/", "example.com", 443],
      ["ftp://example.com/file", "example.com", 0],
      ["https://example.com:8080/", "example.com", 8080],
    ];
    for (const [url] of cases) {
      await assert.rejects(audited.fetch(url, INIT), (e: unknown) => e instanceof Error && e.message.startsWith("audited fetch denied:"));
    }
    assert.equal(inner.calls.length, 0);
    const records = audited.records();
    assert.deepEqual(
      records.map((r) => [r.sequence, r.authority, r.port, r.outcome, r.bytes]),
      cases.map(([, authority, port], i) => [i + 1, authority, port, "denied", 0]),
    );
  });

  it("records a thrown inner call as error and rethrows it", async () => {
    const boom = new Error("socket reset");
    const audited = createAuditedFetch(async () => {
      throw boom;
    });
    await assert.rejects(audited.fetch("https://example.com/", INIT), boom);
    const [rec] = audited.records();
    assert.equal(rec?.outcome, "error");
    assert.equal(rec?.status, undefined);
    assert.equal(rec?.bytes, 0);
  });

  it("records an inner throw after abort as cancelled", async () => {
    const controller = new AbortController();
    const audited = createAuditedFetch(async () => {
      controller.abort();
      throw new Error("aborted");
    });
    await assert.rejects(audited.fetch("https://example.com/", { redirect: "manual", signal: controller.signal }));
    assert.equal(audited.records()[0]?.outcome, "cancelled");
  });

  it("records a pre-aborted signal as cancelled without calling the inner fetch", async () => {
    const inner = scripted();
    const audited = createAuditedFetch(inner.fetch);
    const signal = AbortSignal.abort();
    await assert.rejects(audited.fetch("https://example.com/", { redirect: "manual", signal }));
    assert.equal(inner.calls.length, 0);
    assert.equal(audited.records()[0]?.outcome, "cancelled");
  });

  it("keeps a pending record for a body that is never consumed", async () => {
    const audited = createAuditedFetch(scripted().fetch);
    const res = await audited.fetch("https://example.com/", INIT);
    assert.equal(res.status, 200);
    const records = audited.records();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.outcome, "pending");
    assert.equal(records[0]?.status, 200);
    assert.equal(records[0]?.bytes, 0);
  });

  it("fails an oversize body with error and counts the bytes it saw", async () => {
    const audited = createAuditedFetch(scripted(["12345", "67890"]).fetch, { maxBodyBytes: 8 });
    const res = await audited.fetch("https://example.com/", INIT);
    await assert.rejects(drain(res.body), /audited fetch: body exceeds 8 bytes/);
    const rec = audited.records()[0];
    assert.equal(rec?.outcome, "error");
    assert.equal(rec?.bytes, 10);
  });

  it("returns snapshot copies from records()", async () => {
    const audited = createAuditedFetch(scripted().fetch);
    const res = await audited.fetch("https://example.com/", INIT);
    await drain(res.body);
    const copy = [...audited.records()];
    (copy[0] as { outcome: string }).outcome = "denied";
    assert.equal(audited.records()[0]?.outcome, "complete");
  });
});

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// Fake clock: tests move `t` to simulate elapsed time.
function clock(start = 1_000) {
  const c = { t: start };
  return { ...c, now: () => c.t, set: (t: number) => (c.t = t) };
}

type Seen = [phase: string, rec: Readonly<HostAuditRecord>];

function recordingSink(): { sink: AuditSink; seen: Seen[] } {
  const seen: Seen[] = [];
  return { sink: (rec, phase) => seen.push([phase, rec]), seen };
}

describe("createAuditedFetch metadata", () => {
  it("sets sandbox null, method GET, ISO at and urlSha256 when the record opens", async () => {
    const clk = clock(Date.UTC(2026, 9, 20, 12, 0, 0));
    const { sink, seen } = recordingSink();
    const audited = createAuditedFetch(scripted().fetch, { now: clk.now, sink });
    const url = "https://news.example.com/item/42?id=42";
    await audited.fetch(url, INIT);
    const [phase, rec] = seen[0] ?? [];
    assert.equal(phase, "open");
    assert.equal(rec?.sandbox, null);
    assert.equal(rec?.method, "GET");
    assert.equal(rec?.at, "2026-10-20T12:00:00.000Z");
    assert.equal(rec?.urlSha256, sha256(url));
  });

  it("JSON of every record carries neither the path nor the query of the request URL", async () => {
    const audited = createAuditedFetch(scripted().fetch);
    const res = await audited.fetch("https://news.example.com/private-path-marker/x?token=query-marker-9", INIT);
    await drain(res.body);
    await assert.rejects(audited.fetch("https://user:hunter2@example.com/denied-path-marker?q=denied-query-marker", INIT));
    const json = JSON.stringify(audited.records());
    for (const marker of ["private-path-marker", "query-marker-9", "denied-path-marker", "denied-query-marker", "hunter2", "token="]) {
      assert.equal(json.includes(marker), false, `record JSON leaked ${marker}`);
    }
  });

  it("sets peer and pinnedPeer from the pin address once a response arrives, and omits all three when unpinned", async () => {
    const audited = createAuditedFetch(scripted().fetch);
    const pinned = { hostname: "news.example.com", address: "203.0.113.7", family: 4 };
    const a = await audited.fetch("https://news.example.com/", { ...INIT, pin: pinned });
    await drain(a.body);
    const b = await audited.fetch("https://news.example.com/", INIT);
    await drain(b.body);
    const [withPin, withoutPin] = audited.records();
    assert.equal(withPin?.dialled, "203.0.113.7");
    assert.equal(withPin?.peer, "203.0.113.7");
    assert.equal(withPin?.pinnedPeer, "203.0.113.7");
    assert.equal(withoutPin?.dialled, undefined);
    assert.equal(withoutPin?.peer, undefined);
    assert.equal(withoutPin?.pinnedPeer, undefined);
  });

  it("records dialled but no peer or pinnedPeer when the dial fails before a response", async () => {
    const audited = createAuditedFetch(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    });
    const pinned = { hostname: "news.example.com", address: "203.0.113.7", family: 4 };
    await assert.rejects(audited.fetch("https://news.example.com/", { ...INIT, pin: pinned }));
    const [rec] = audited.records();
    assert.equal(rec?.outcome, "error");
    assert.equal(rec?.dialled, "203.0.113.7");
    assert.equal(rec?.peer, undefined);
    assert.equal(rec?.pinnedPeer, undefined);
  });
});

describe("createAuditedFetch sink and clock", () => {
  it("emits open then final for a consumed body, with the final snapshot holding the terminal state", async () => {
    const { sink, seen } = recordingSink();
    const audited = createAuditedFetch(scripted(["hello", "world"]).fetch, { sink });
    const res = await audited.fetch("https://example.com/", INIT);
    assert.deepEqual(
      seen.map(([phase, rec]) => [phase, rec.outcome]),
      [["open", "pending"]],
    );
    await drain(res.body);
    assert.deepEqual(
      seen.map(([phase, rec]) => [phase, rec.outcome, rec.bytes]),
      [
        ["open", "pending", 0],
        ["final", "complete", 10],
      ],
    );
  });

  it("emits open then final for a denied URL", async () => {
    const { sink, seen } = recordingSink();
    const audited = createAuditedFetch(scripted().fetch, { sink });
    await assert.rejects(audited.fetch("http://127.0.0.1/", INIT));
    assert.deepEqual(
      seen.map(([phase, rec]) => [phase, rec.outcome, rec.denyReason]),
      [
        ["open", "denied", "private"],
        ["final", "denied", "private"],
      ],
    );
  });

  it("a throwing sink neither breaks the fetch nor drops the record", async () => {
    const sink: AuditSink = () => {
      throw new Error("sink down");
    };
    const audited = createAuditedFetch(scripted(["hello", "world"]).fetch, { sink });
    const res = await audited.fetch("https://example.com/", INIT);
    assert.equal(await drain(res.body), 10);
    assert.equal(audited.count(), 1);
    assert.equal(audited.records()[0]?.outcome, "complete");
  });

  it("hands the sink a snapshot copy that cannot alter the log", async () => {
    const sink: AuditSink = (rec) => {
      (rec as { outcome: string }).outcome = "denied";
    };
    const audited = createAuditedFetch(scripted().fetch, { sink });
    const res = await audited.fetch("https://example.com/", INIT);
    await drain(res.body);
    assert.equal(audited.records()[0]?.outcome, "complete");
  });

  it("measures durationMs on the injected clock from dispatch to body completion", async () => {
    const clk = clock(1_000);
    const { sink, seen } = recordingSink();
    const audited = createAuditedFetch(scripted().fetch, { now: clk.now, sink });
    const res = await audited.fetch("https://example.com/", INIT);
    assert.equal(seen[0]?.[1].durationMs, 0);
    assert.equal(seen[0]?.[1].at, new Date(1_000).toISOString());
    clk.set(1_500);
    await drain(res.body);
    assert.equal(audited.records()[0]?.durationMs, 500);
    assert.equal(seen[1]?.[1].durationMs, 500);
  });

  it("keeps durationMs at 0 while a body is unconsumed", async () => {
    const clk = clock(1_000);
    const audited = createAuditedFetch(scripted().fetch, { now: clk.now });
    await audited.fetch("https://example.com/", INIT);
    clk.set(9_000);
    assert.equal(audited.records()[0]?.durationMs, 0);
  });
});

describe("denial and error classification", () => {
  it("maps checkPublicUrl denials to closed deny reasons", async () => {
    const audited = createAuditedFetch(scripted().fetch);
    const cases: [string, string][] = [
      ["http://127.0.0.1/", "private"],
      ["http://localhost/", "private"],
      ["https://user:hunter2@example.com/", "reserved"],
      ["ftp://example.com/file", "reserved"],
      ["https://example.com:8080/", "reserved"],
      ["https://ex ample.com/", "reserved"],
      [`https://${"a".repeat(2100)}.com/`, "reserved"],
    ];
    for (const [url] of cases) await assert.rejects(audited.fetch(url, INIT));
    assert.deepEqual(
      audited.records().map((r) => r.denyReason),
      cases.map(([, reason]) => reason),
    );
  });

  it("denyReasonOf maps the loopback/private message to private and anything unknown to reserved", () => {
    assert.equal(denyReasonOf("url: host is loopback, private, local, literal IP or single-label"), "private");
    assert.equal(denyReasonOf("url: port not allowed"), "reserved");
    assert.equal(denyReasonOf("url: only http(s) is allowed"), "reserved");
    assert.equal(denyReasonOf("url: credentials are not allowed"), "reserved");
    assert.equal(denyReasonOf("url: unparseable"), "reserved");
    assert.equal(denyReasonOf("url: empty or longer than URL_MAX"), "reserved");
    assert.equal(denyReasonOf("something entirely new"), "reserved");
  });

  it("classifyError maps timeout, reset, dial and otherwise internal", () => {
    assert.equal(classifyError(new Error("request timed out")), "timeout");
    assert.equal(classifyError(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })), "timeout");
    assert.equal(classifyError(new Error("read ECONNRESET")), "reset");
    assert.equal(classifyError(new Error("socket hang up")), "reset");
    assert.equal(classifyError(new Error("connect ECONNREFUSED 203.0.113.7:443")), "dial");
    assert.equal(classifyError(new Error("getaddrinfo ENOTFOUND x.example")), "dial");
    assert.equal(classifyError(new Error("boom")), "internal");
    assert.equal(classifyError("not an error"), "internal");
  });

  it("records an inner throw with its errorClass", async () => {
    const audited = createAuditedFetch(async () => {
      throw new Error("read ECONNRESET");
    });
    await assert.rejects(audited.fetch("https://example.com/", INIT));
    assert.equal(audited.records()[0]?.errorClass, "reset");
  });

  it("classifies an oversize body as bound and a mid-stream source error by its message", async () => {
    const over = createAuditedFetch(scripted(["12345", "67890"]).fetch, { maxBodyBytes: 8 });
    const r1 = await over.fetch("https://example.com/", INIT);
    await assert.rejects(drain(r1.body));
    assert.equal(over.records()[0]?.errorClass, "bound");

    const midStream = async function* (): AsyncGenerator<Uint8Array> {
      yield enc.encode("ok");
      throw new Error("read ECONNRESET");
    };
    const reset = createAuditedFetch(async () => ({ status: 200, headers: { get: () => null }, body: midStream() }));
    const r2 = await reset.fetch("https://example.com/", INIT);
    await assert.rejects(drain(r2.body));
    assert.equal(reset.records()[0]?.outcome, "error");
    assert.equal(reset.records()[0]?.errorClass, "reset");
  });

  it("a consumer stopping early at its cap (bytes read, not aborted) is complete and truncated, keeping the bytes read; not an error", async () => {
    const audited = createAuditedFetch(scripted(["hello", "world"]).fetch);
    const res = await audited.fetch("https://example.com/", INIT);
    for await (const _chunk of res.body ?? []) break;
    const [rec] = audited.records();
    assert.equal(rec?.outcome, "complete");
    assert.equal(rec?.truncated, true);
    assert.equal(rec?.bytes, 5);
    assert.equal(rec?.errorClass, undefined);
  });

  it("a fully drained body is complete without a truncated flag", async () => {
    const audited = createAuditedFetch(scripted(["hello", "world"]).fetch);
    await drain((await audited.fetch("https://example.com/", INIT)).body);
    assert.equal(audited.records()[0]?.outcome, "complete");
    assert.equal(audited.records()[0]?.truncated, undefined);
  });

  it("a consumer that aborts after reading is cancelled, never truncated", async () => {
    const audited = createAuditedFetch(scripted(["hello", "world"]).fetch);
    const ac = new AbortController();
    const res = await audited.fetch("https://example.com/", { redirect: "manual", signal: ac.signal });
    for await (const _chunk of res.body ?? []) {
      ac.abort();
      break;
    }
    assert.equal(audited.records()[0]?.outcome, "cancelled");
    assert.equal(audited.records()[0]?.truncated, undefined);
  });

  it("a consumer that stops before reading any byte leaves the record pending (the body never started)", async () => {
    const audited = createAuditedFetch(scripted(["hello"]).fetch);
    const res = await audited.fetch("https://example.com/", INIT);
    await res.body?.[Symbol.asyncIterator]().return?.();
    assert.equal(audited.records()[0]?.outcome, "pending");
    assert.equal(audited.records()[0]?.truncated, undefined);
  });

  it("cancelled outcomes carry no errorClass", async () => {
    const controller = new AbortController();
    const audited = createAuditedFetch(async () => {
      controller.abort();
      throw new Error("socket hang up");
    });
    await assert.rejects(audited.fetch("https://example.com/", { redirect: "manual", signal: controller.signal }));
    assert.equal(audited.records()[0]?.outcome, "cancelled");
    assert.equal(audited.records()[0]?.errorClass, undefined);
  });
});

describe("attribution and recordCall", () => {
  it("attributed records carry story and agent, and unattributed records omit the keys", async () => {
    const audited = createAuditedFetch(scripted().fetch);
    const res = await audited.attributed({ story: "story-7" })("https://example.com/", INIT);
    await drain(res.body);
    await drain((await audited.fetch("https://example.com/", INIT)).body);
    const [attributed, plain] = audited.records();
    assert.equal(attributed?.story, "story-7");
    assert.equal("agent" in (attributed ?? {}), false);
    assert.equal("story" in (plain ?? {}), false);
    assert.equal("agent" in (plain ?? {}), false);
  });

  it("recordCall opens a pending record and settles it once, ignoring a second finish", async () => {
    const clk = clock(1_000);
    const { sink, seen } = recordingSink();
    const audited: AuditedFetch = createAuditedFetch(scripted().fetch, { now: clk.now, sink });
    const call = audited.recordCall({ url: "https://api.example.com/v1/messages?key=x", method: "post", attribution: { agent: "writer" } });
    assert.equal(audited.count(), 1);
    assert.equal(audited.records()[0]?.outcome, "pending");
    assert.equal(audited.records()[0]?.method, "POST");
    assert.equal(audited.records()[0]?.agent, "writer");
    clk.set(1_250);
    call.finish({ outcome: "complete", status: 200, bytes: 42, requestId: "r1", denyReason: "reserved" });
    clk.set(9_999);
    call.finish({ outcome: "error", status: 500, bytes: 0 });
    const rec = audited.records()[0];
    assert.equal(rec?.outcome, "complete");
    assert.equal(rec?.status, 200);
    assert.equal(rec?.bytes, 42);
    assert.equal(rec?.requestId, "r1");
    assert.equal(rec?.denyReason, "reserved");
    assert.equal(rec?.durationMs, 250);
    assert.deepEqual(
      seen.map(([phase]) => phase),
      ["open", "final"],
    );
  });

  it("an unsettled request stays pending in records() and its jsonl open line says pending", () => {
    const lines: string[] = [];
    const audited = createAuditedFetch(scripted().fetch, {
      sink: (rec, phase) => lines.push(JSON.stringify({ ...rec, phase })),
    });
    audited.recordCall({ url: "https://api.example.com/v1/messages", method: "POST" });
    assert.equal(audited.records()[0]?.outcome, "pending");
    const [open] = lines.map((l) => JSON.parse(l) as { phase: string; outcome: string });
    assert.equal(open?.phase, "open");
    assert.equal(open?.outcome, "pending");
  });

  it("recordCall finish sets errorClass but a cancelled finish carries none", () => {
    const audited = createAuditedFetch(scripted().fetch);
    const failed = audited.recordCall({ url: "https://example.com/", method: "GET" });
    failed.finish({ outcome: "error", errorClass: "timeout" });
    const cancelled = audited.recordCall({ url: "https://example.com/", method: "GET" });
    cancelled.finish({ outcome: "cancelled", errorClass: "timeout" });
    assert.equal(audited.records()[0]?.errorClass, "timeout");
    assert.equal(audited.records()[1]?.errorClass, undefined);
  });
});

describe("auditedModelFetch", () => {
  const modelInner = (impl: (input: unknown, init?: RequestInit) => Promise<Response>): typeof globalThis.fetch => impl as unknown as typeof globalThis.fetch;

  it("records a 2xx response's status, content-length bytes and request id, and returns it unread", async () => {
    const audit = createAuditedFetch(scripted().fetch);
    const response = new Response("ok", {
      status: 200,
      headers: { "content-length": "2", "x-request-id": "req-1", "set-cookie": "session-secret" },
    });
    const fetch = auditedModelFetch(
      audit,
      modelInner(async () => response),
    );
    const out = await fetch("https://api.example.com/v1/messages?key=abc", { method: "post" });
    assert.equal(out, response);
    assert.equal(out.bodyUsed, false);
    const [rec] = audit.records();
    assert.equal(rec?.outcome, "complete");
    assert.equal(rec?.status, 200);
    assert.equal(rec?.bytes, 2);
    assert.equal(rec?.requestId, "req-1");
    assert.equal(rec?.method, "POST");
    assert.equal(rec?.errorClass, undefined);
    assert.equal(JSON.stringify(audit.records()).includes("session-secret"), false);
    assert.equal(JSON.stringify(audit.records()).includes("key=abc"), false);
  });

  it("model rows carry the upstream route (path only, no query) and upstreamStatus; article/HN rows carry neither", async () => {
    const audit = createAuditedFetch(scripted().fetch);
    const ok = auditedModelFetch(
      audit,
      modelInner(async () => new Response("ok", { status: 200 })),
    );
    await ok("https://openrouter.ai/api/v1/messages?beta=true&key=abc", { method: "POST" });
    const bad = auditedModelFetch(
      audit,
      modelInner(async () => new Response("no", { status: 404 })),
    );
    await bad("https://openrouter.ai/api/v1/v1/messages?beta=true", { method: "POST" });
    await drain((await audit.fetch("https://example.com/article/secret-path?q=1", INIT)).body);
    const [a, b, c] = audit.records();
    assert.equal(a?.route, "/api/v1/messages");
    assert.equal(a?.upstreamStatus, 200);
    assert.equal(b?.route, "/api/v1/v1/messages");
    assert.equal(b?.upstreamStatus, 404);
    assert.equal(a?.urlSha256.length, 64);
    assert.equal(c?.route, undefined);
    assert.equal(c?.upstreamStatus, undefined);
    assert.equal(JSON.stringify(audit.records()).includes("secret-path"), false);
    assert.equal(JSON.stringify(audit.records()).includes("key=abc"), false);
  });

  it("a model call that throws or is cancelled still records its route", async () => {
    const audit = createAuditedFetch(scripted().fetch);
    const fetch = auditedModelFetch(
      audit,
      modelInner(async () => {
        throw new Error("connect ECONNREFUSED 203.0.113.7:443");
      }),
    );
    await assert.rejects(fetch("https://openrouter.ai/api/v1/messages?x=1", { method: "POST" }));
    assert.equal(audit.records()[0]?.route, "/api/v1/messages");
    assert.equal(audit.records()[0]?.upstreamStatus, undefined);
  });

  it("records a non-2xx response as error with protocol class and its status", async () => {
    const audit = createAuditedFetch(scripted().fetch);
    const fetch = auditedModelFetch(
      audit,
      modelInner(async () => new Response("no", { status: 503 })),
    );
    await fetch("https://api.example.com/v1/messages");
    const [rec] = audit.records();
    assert.equal(rec?.outcome, "error");
    assert.equal(rec?.status, 503);
    assert.equal(rec?.errorClass, "protocol");
    assert.equal(rec?.bytes, 0);
  });

  it("records a thrown call as error with its classified errorClass and rethrows it", async () => {
    const audit = createAuditedFetch(scripted().fetch);
    const boom = new Error("connect ECONNREFUSED 203.0.113.7:443");
    const fetch = auditedModelFetch(
      audit,
      modelInner(async () => {
        throw boom;
      }),
    );
    await assert.rejects(fetch("https://api.example.com/v1/messages"), boom);
    const [rec] = audit.records();
    assert.equal(rec?.outcome, "error");
    assert.equal(rec?.errorClass, "dial");
    assert.equal(rec?.status, undefined);
  });

  it("records a guard refusal thrown by the inner fetch as error", async () => {
    const audit = createAuditedFetch(scripted().fetch);
    const fetch = auditedModelFetch(
      audit,
      modelInner(async () => {
        throw new Error("model egress refused: host not allowed");
      }),
    );
    await assert.rejects(fetch("https://api.example.com/v1/messages"));
    assert.equal(audit.records()[0]?.outcome, "error");
    assert.equal(audit.records()[0]?.errorClass, "internal");
  });

  it("passes ctx through unchanged and calls the inner fetch with two arguments when ctx is absent", async () => {
    const seen: unknown[][] = [];
    const inner: ModelFetchInner = async (...args) => {
      seen.push(args);
      return new Response("ok");
    };
    const audit = createAuditedFetch(scripted().fetch);
    const fetch = auditedModelFetch(audit, inner);
    const ctx: ModelFetchCtx = { agent: "writer", requestId: "req-ctx" };
    await fetch("https://api.example.com/v1/messages", { method: "POST" }, ctx);
    await fetch("https://api.example.com/v1/messages", { method: "POST" });
    assert.equal(seen[0]?.length, 3);
    assert.equal(seen[0]?.[2], ctx);
    assert.equal(seen[1]?.length, 2);
  });

  it("with ctx, the row carries agent and requestId from the open snapshot on, and the header does not overwrite the ctx id", async () => {
    const { sink, seen } = recordingSink();
    const audit = createAuditedFetch(scripted().fetch, { sink });
    const response = new Response("ok", { status: 200, headers: { "x-request-id": "req-header" } });
    const fetch = auditedModelFetch(audit, async () => response);
    await fetch("https://api.example.com/v1/messages", { method: "POST" }, { agent: "writer", requestId: "req-ctx" });
    assert.equal(seen[0]?.[0], "open");
    assert.equal(seen[0]?.[1].agent, "writer");
    assert.equal(seen[0]?.[1].requestId, "req-ctx");
    const [rec] = audit.records();
    assert.equal(rec?.agent, "writer");
    assert.equal(rec?.requestId, "req-ctx");
    assert.equal(rec?.outcome, "complete");
  });

  it("bounds a ctx request id to the request id maximum", async () => {
    const audit = createAuditedFetch(scripted().fetch);
    const fetch = auditedModelFetch(audit, async () => new Response("ok"));
    await fetch("https://api.example.com/v1/messages", undefined, { agent: "writer", requestId: "r".repeat(300) });
    assert.equal(audit.records()[0]?.requestId?.length, 200);
  });

  it("takes the story from the attribution when it has one, else from the resolver keyed by ctx.agent", async () => {
    const audit = createAuditedFetch(scripted().fetch);
    const resolved: string[] = [];
    const resolveStory = (agent: string) => {
      resolved.push(agent);
      return agent === "writer" ? "7" : undefined;
    };
    const fetch = auditedModelFetch(
      audit,
      async () => new Response("ok"),
      () => undefined,
      resolveStory,
    );
    await fetch("https://api.example.com/v1/messages", undefined, { agent: "writer", requestId: "r1" });
    await fetch("https://api.example.com/v1/messages", undefined, { agent: "judge", requestId: "r2" });
    const withAttribution = auditedModelFetch(
      audit,
      async () => new Response("ok"),
      () => ({ story: "3" }),
      resolveStory,
    );
    await withAttribution("https://api.example.com/v1/messages", undefined, { agent: "writer", requestId: "r3" });
    const [writer, judge, attributed] = audit.records();
    assert.equal(writer?.story, "7");
    assert.equal("story" in (judge ?? {}), false);
    assert.equal(attributed?.story, "3");
    assert.deepEqual(resolved, ["writer", "judge"]);
  });

  it("without ctx, a row has no agent, requestId or story key and the resolver is not consulted", async () => {
    const audit = createAuditedFetch(scripted().fetch);
    let resolverCalls = 0;
    const fetch = auditedModelFetch(
      audit,
      async () => new Response("ok", { headers: { "x-request-id": "req-header" } }),
      () => undefined,
      () => {
        resolverCalls += 1;
        return "7";
      },
    );
    await fetch("https://api.example.com/v1/messages", { method: "POST" });
    const [rec] = audit.records();
    assert.equal(rec?.requestId, "req-header");
    for (const key of ["agent", "story"]) assert.equal(key in (rec ?? {}), false, key);
    assert.equal(resolverCalls, 0);
  });

  it("records an already-aborted signal as cancelled without dispatching", async () => {
    const audit = createAuditedFetch(scripted().fetch);
    let calls = 0;
    const fetch = auditedModelFetch(
      audit,
      modelInner(async () => {
        calls += 1;
        return new Response("x");
      }),
    );
    await assert.rejects(fetch("https://api.example.com/v1/messages", { signal: AbortSignal.abort() }));
    assert.equal(calls, 0);
    assert.equal(audit.records()[0]?.outcome, "cancelled");
    assert.equal(audit.records()[0]?.errorClass, undefined);
  });

  it("records a signal aborted during the call as cancelled", async () => {
    const audit = createAuditedFetch(scripted().fetch);
    const controller = new AbortController();
    const fetch = auditedModelFetch(
      audit,
      modelInner(async () => {
        controller.abort();
        throw new Error("aborted");
      }),
    );
    await assert.rejects(fetch("https://api.example.com/v1/messages", { signal: controller.signal }));
    assert.equal(audit.records()[0]?.outcome, "cancelled");
    assert.equal(audit.records()[0]?.errorClass, undefined);
  });

  it("treats a missing or non-integer content-length as 0 bytes", async () => {
    for (const cl of [null, "", "12abc", "-5", "1.5"]) {
      const audit = createAuditedFetch(scripted().fetch);
      const headers: Record<string, string> = cl === null ? {} : { "content-length": cl };
      const fetch = auditedModelFetch(
        audit,
        modelInner(async () => new Response("abc", { status: 200, headers })),
      );
      await fetch("https://api.example.com/v1/messages");
      assert.equal(audit.records()[0]?.bytes, 0, `content-length ${JSON.stringify(cl)}`);
    }
  });

  it("reads the method and URL from Request and URL inputs and calls the attribution callback at call time", async () => {
    const audit = createAuditedFetch(scripted().fetch);
    let who = "writer";
    const fetch = auditedModelFetch(
      audit,
      modelInner(async () => new Response("x")),
      () => ({ agent: who }),
    );
    await fetch(new Request("https://api.example.com/v1/a", { method: "put" }));
    who = "judge";
    await fetch(new URL("https://api.example.com/v1/b"));
    const [put, get] = audit.records();
    assert.equal(put?.method, "PUT");
    assert.equal(put?.authority, "api.example.com");
    assert.equal(put?.agent, "writer");
    assert.equal(get?.method, "GET");
    assert.equal(get?.agent, "judge");
    assert.equal(sha256("https://api.example.com/v1/b"), get?.urlSha256);
  });
});

describe("classifyError by structured code", () => {
  const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

  it("maps dial codes to dial regardless of message wording", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]) {
      assert.equal(classifyError(withCode("connect failed", code)), "dial", code);
    }
  });

  it("maps reset codes to reset", () => {
    for (const code of ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]) {
      assert.equal(classifyError(withCode("other", code)), "reset", code);
    }
  });

  it("maps timeout codes and TimeoutError names to timeout", () => {
    for (const code of ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]) {
      assert.equal(classifyError(withCode("other", code)), "timeout", code);
    }
    assert.equal(classifyError(Object.assign(new Error("slow"), { name: "TimeoutError" })), "timeout");
  });

  it("maps TLS and HTTP-parse codes to protocol", () => {
    for (const code of [
      "HPE_INVALID_HEADER_TOKEN",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "ERR_SSL_WRONG_VERSION_NUMBER",
      "CERT_HAS_EXPIRED",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
    ]) {
      assert.equal(classifyError(withCode("other", code)), "protocol", code);
    }
  });

  it("maps the byte-bound marker code to bound", () => {
    assert.equal(classifyError(withCode("audited fetch: body exceeds 8 bytes", "AUDIT_BODY_BOUND")), "bound");
  });

  it("maps an AbortError by name to internal, since a non-timeout abort is a cancel", () => {
    assert.equal(classifyError(Object.assign(new Error("aborted"), { name: "AbortError" })), "internal");
  });

  it("prefers a structured code over a misleading message", () => {
    assert.equal(classifyError(withCode("request timed out", "ECONNRESET")), "reset");
    assert.equal(classifyError(withCode("connect ECONNREFUSED", "ETIMEDOUT")), "timeout");
  });

  it("walks cause chains and finds the code on a wrapped error", () => {
    const undiciStyle = new TypeError("fetch failed", { cause: withCode("connect failed", "UND_ERR_CONNECT_TIMEOUT") });
    assert.equal(classifyError(undiciStyle), "timeout");
    const dialWrapped = new TypeError("fetch failed", { cause: withCode("x", "ECONNREFUSED") });
    assert.equal(classifyError(dialWrapped), "dial");
  });

  it("inspects at most four errors in a cause chain", () => {
    const at = (depth: number, code: string) => {
      let e: Error = withCode("leaf", code);
      for (let i = 1; i < depth; i += 1) e = new Error(`wrap ${i}`, { cause: e });
      return e;
    };
    assert.equal(classifyError(at(4, "ECONNRESET")), "reset");
    assert.equal(classifyError(at(5, "ECONNRESET")), "internal");
  });

  it("classifies a DOMException TimeoutError from AbortSignal.timeout as timeout", async () => {
    const signal = AbortSignal.timeout(1);
    const reason = await new Promise<unknown>((resolve) => signal.addEventListener("abort", () => resolve(signal.reason), { once: true }));
    assert.equal(classifyError(reason), "timeout");
  });

  it("classifies the real rejection of fetch to a closed loopback port as dial", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    const err = await fetch(`http://127.0.0.1:${port}/`).then(
      () => assert.fail("fetch to a closed port resolved"),
      (e: unknown) => e,
    );
    assert.equal(classifyError(err), "dial");
  });
});

describe("classifyError by message token", () => {
  it("does not treat the bare words connect or reset as a class", () => {
    assert.equal(classifyError(new Error("cannot connect the dots")), "internal");
    assert.equal(classifyError(new Error("connection pool exhausted")), "internal");
    assert.equal(classifyError(new Error("connect")), "internal");
    assert.equal(classifyError(new Error("reset the form")), "internal");
    assert.equal(classifyError(new Error("password reset email sent")), "internal");
  });

  it("matches the code tokens as whole words", () => {
    assert.equal(classifyError(new Error("upstream ETIMEDOUT while reading")), "timeout");
    assert.equal(classifyError(new Error("write EPIPE")), "reset");
    assert.equal(classifyError(new Error("ECONNRESETX happened")), "internal");
  });
});
