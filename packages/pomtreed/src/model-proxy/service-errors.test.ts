// Failure messages on the model proxy path: each names its cause class, says what to do, leaks no key, and reaches the
// caller (Pi), the settlement event (journal) and the access line (operator).
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { encodeGatewayCredential } from "../gateway.ts";
import { RequestBudget } from "./request-budget.ts";
import { createModelProxyServer, MISSING_PROXY_CREDENTIAL, MISSING_REQUEST_ID, ModelProxy, proxyMetaOf } from "./service.ts";
import type { ModelProxyOptions, ProxySettlement } from "./service.ts";
import { OPENROUTER_BASE_HINT } from "./upstream.ts";

// Every model id these tests send: the credential allows them all (model_not_allowed has its own tests).
const TEST_MODELS = ["m", "ds", "nope", "big", "deepseek/deepseek-v4-pro", "DS", " ds", "ds:free", "p/ds", "ds\u0000"];
const secret = "controller-secret";
const UPSTREAM_KEY = "sk-or-v1-UPSTREAMKEY0123456789abcdef";
const now = () => 1_000;
const key = () =>
  encodeGatewayCredential(secret, { agent: "agent-1", id: "a".repeat(32), budgetMicros: 1000, expiresAt: 2_000, issuedAt: 1_000, models: TEST_MODELS });
const enc = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");

function make(over: Partial<ModelProxyOptions> = {}) {
  const budget = new RequestBudget({ secret, now });
  const events: ProxySettlement[] = [];
  const warnings: string[] = [];
  const proxy = new ModelProxy({
    upstream: { baseUrl: "https://openrouter.ai/api/v1", key: UPSTREAM_KEY },
    budget,
    maximumRequestMicros: 50,
    price: () => ({ micros: 5, basis: "catalog" }),
    fetch: async () => new Response("{}"),
    onSettlement: (e) => events.push(e),
    warn: (m) => warnings.push(m),
    baseUrlName: "POMTREED_MODEL_BASE_URL",
    ...over,
  });
  return { proxy, budget, events, warnings };
}
const fwd = (proxy: ModelProxy, path = "/chat/completions", requestId = "r1") =>
  proxy.forward({ credential: key(), requestId, path: `${path}?trace=q-secret`, body: enc('{"model":"m"}') });
const noLeak = (s: string) => {
  assert.doesNotMatch(s, /UPSTREAMKEY|q-secret|controller-secret|pg1\./);
};

test("the proxy refuses a malformed base URL at construction, naming the variable", () => {
  for (const [baseUrl, reason] of [
    ["https://openrouter.ai/api?key=abc", "it has a query string"],
    ["not a url", "not a parseable URL"],
    ["https://u:p@openrouter.ai/api", "it carries credentials"],
  ]) {
    assert.throws(
      () => make({ upstream: { baseUrl: baseUrl as string, key: UPSTREAM_KEY } }),
      (e: Error) => {
        assert.ok(e.message.startsWith(`invalid POMTREED_MODEL_BASE_URL: ${reason}`), e.message);
        assert.doesNotMatch(e.message, /key=abc|u:p@/);
        return true;
      },
    );
  }
  assert.doesNotThrow(() => make());
});

test("a 401 that echoes the upstream key reaches Pi, the event and the access meta scrubbed, classed auth_rejected", async () => {
  const echoed = JSON.stringify({ error: { message: `Invalid API key ${UPSTREAM_KEY} (sk-or-v1-abc***wxyz)`, code: 401 } });
  const { proxy, events } = make({ fetch: async () => new Response(echoed, { status: 401, headers: { "content-type": "application/json" } }) });
  const r = await fwd(proxy);
  assert.ok("body" in r);
  assert.equal(r.status, 401);
  assert.equal(text(r.body), JSON.stringify({ error: { message: "Invalid API key [redacted] ([redacted])", code: 401 } }));
  const [e] = events;
  assert.equal(e?.errorClass, "auth_rejected");
  assert.equal(e?.upstreamMessage, "Invalid API key [redacted] ([redacted])");
  assert.equal(proxyMetaOf(r)?.upstreamMessage, "Invalid API key [redacted] ([redacted])");
  noLeak(JSON.stringify(events));
  noLeak(text(r.body));
  noLeak(JSON.stringify(proxyMetaOf(r)));
});

test("an innocuous upstream error body is forwarded byte-identical", async () => {
  const body = '{"error":{"message":"max_tokens must be positive","type":"invalid_request_error"}}';
  const { proxy, events } = make({ fetch: async () => new Response(body, { status: 400 }) });
  const r = await fwd(proxy);
  assert.ok("body" in r);
  assert.equal(text(r.body), body);
  assert.equal(events[0]?.errorClass, "bad_request");
  assert.equal(events[0]?.upstreamMessage, "max_tokens must be positive");
});

test("each status class reaches the failed event with the upstream host and final path, never the query", async () => {
  for (const [status, cls] of [
    [402, "insufficient_funds"],
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "upstream_5xx"],
  ] as const) {
    const { proxy, events } = make({ fetch: async () => new Response('{"message":"x"}', { status }) });
    await fwd(proxy);
    assert.deepEqual(
      { kind: events[0]?.kind, cls: events[0]?.errorClass, host: events[0]?.upstreamHost, path: events[0]?.upstreamPath, st: events[0]?.upstreamStatus },
      { kind: "failed", cls, host: "openrouter.ai", path: "/api/v1/chat/completions", st: status },
    );
    noLeak(JSON.stringify(events));
  }
});

test("a thrown fetch is classed by its cause code and answered with a message that names the cause and the host", async () => {
  const cases: [string, string, string][] = [
    ["ENOTFOUND", "dns", "model upstream unreachable (dns): openrouter.ai did not resolve; check POMTREED_MODEL_BASE_URL and the host's DNS"],
    [
      "ECONNREFUSED",
      "connect",
      "model upstream unreachable (connect): openrouter.ai refused or reset the connection; check POMTREED_MODEL_BASE_URL and that the upstream is up",
    ],
    [
      "CERT_HAS_EXPIRED",
      "tls",
      "model upstream unreachable (tls): the TLS handshake with openrouter.ai failed; check POMTREED_MODEL_BASE_URL's scheme and the host's certificate",
    ],
    [
      "EOTHER",
      "transport",
      "model upstream unavailable (transport): the call to openrouter.ai/api/v1/chat/completions failed before a response; retry later, and check POMTREED_MODEL_BASE_URL if it persists",
    ],
  ];
  for (const [code, cls, error] of cases) {
    const { proxy, events, budget } = make({
      fetch: async () => {
        throw new TypeError(`fetch failed ${UPSTREAM_KEY}`, { cause: Object.assign(new Error(`connect ${code} q-secret`), { code }) });
      },
    });
    const r = await fwd(proxy);
    assert.deepEqual(r, { status: 502, error });
    assert.equal(events[0]?.errorClass, cls);
    assert.equal(events[0]?.upstreamHost, "openrouter.ai");
    assert.equal(proxyMetaOf(r)?.errorClass, cls);
    noLeak(JSON.stringify(events));
    assert.equal(budget.reserve(key(), "r2", 1000).ok, true, "the reservation was released");
  }
  // An abort that is not the proxy's own deadline.
  const { proxy, events } = make({
    fetch: async () => {
      throw new DOMException("cancelled", "AbortError");
    },
  });
  assert.deepEqual(await fwd(proxy), {
    status: 502,
    error: "model upstream call aborted (aborted): the call to openrouter.ai/api/v1/chat/completions was cancelled before it completed; retry",
  });
  assert.equal(events[0]?.errorClass, "aborted");
});

test("a redirect is classed redirect with its status", async () => {
  const { proxy, events } = make({ fetch: async () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/?k=v" } }) });
  const r = await fwd(proxy);
  assert.equal(r.status, 502);
  assert.ok("error" in r && r.error.startsWith("model upstream redirected (redirect, 307 from openrouter.ai/api/v1/chat/completions)"));
  assert.deepEqual([events[0]?.kind, events[0]?.errorClass, events[0]?.upstreamStatus], ["failed", "redirect", 307]);
  assert.doesNotMatch(JSON.stringify(events), /elsewhere|k=v/);
});

test("a 2xx with an empty body or no usable usage journals reserve with malformed_response", async () => {
  for (const [body, why] of [
    ["", "the body was empty"],
    ['{"choices":[]}', "no usage the proxy can price"],
  ]) {
    const { proxy, events } = make({ price: () => null, fetch: async () => new Response(body) });
    const r = await fwd(proxy);
    assert.deepEqual(r, { status: 502, error: `upstream 2xx response had no usable usage (malformed_response): ${why}; the whole reservation was charged` });
    assert.deepEqual([events[0]?.kind, events[0]?.errorClass, events[0]?.upstreamPath], ["reserve", "malformed_response", "/api/v1/chat/completions"]);
    assert.equal(events[0]?.upstreamMessage, undefined);
  }
  // Negative: a priced 2xx has no errorClass.
  const { proxy, events } = make();
  assert.equal((await fwd(proxy)).status, 200);
  assert.deepEqual([events[0]?.kind, events[0]?.errorClass, events[0]?.upstreamHost], ["priced", undefined, "openrouter.ai"]);
});

test("a 2xx over the body cap journals reserve with response_too_large", async () => {
  const { proxy, events } = make({ maxBodyBytes: 64, fetch: async () => new Response("x".repeat(65)) });
  assert.deepEqual(await fwd(proxy), {
    status: 502,
    error: "model upstream response too large (response_too_large): over 64 bytes; the whole reservation was charged",
  });
  assert.deepEqual([events[0]?.kind, events[0]?.errorClass], ["reserve", "response_too_large"]);
});

test("a 2xx SSE stream with an error event is priced as before and carries stream_error", async () => {
  const sse = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n';
  const { proxy, events } = make({ fetch: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }) });
  assert.equal((await fwd(proxy)).status, 200);
  assert.deepEqual([events[0]?.kind, events[0]?.errorClass], ["priced", "stream_error"]);
});

function post(port: number, headers: Record<string, string>, body: string, path = "/chat/completions"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

test("a request without a credential or request id is refused with a 401 that says which is missing, and is access-logged", async () => {
  const lines: string[] = [];
  const { proxy } = make();
  const server = createModelProxyServer(proxy, { mode: "errors", sink: (l) => lines.push(l) });
  const port = await listen(server);
  try {
    const noKey = await post(port, { "x-pomtree-request-id": "r1" }, "{}");
    assert.deepEqual(noKey, { status: 401, body: JSON.stringify({ error: MISSING_PROXY_CREDENTIAL }) });
    const noId = await post(port, { authorization: `Bearer ${key()}` }, "{}");
    assert.deepEqual(noId, { status: 401, body: JSON.stringify({ error: MISSING_REQUEST_ID }) });
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, / 401 \d+ms anon auth=missing-credential error="missing proxy credential: /);
    assert.match(lines[1]!, / 401 \d+ms anon auth=missing-request-id error="missing x-pomtree-request-id header: /);
    for (const l of lines) assert.doesNotMatch(l, /pg1\.|Bearer [A-Za-z0-9]/);
  } finally {
    server.close();
  }
});

test("end to end: a wrong base path 404s upstream; the event, access line and operator warning name host and path and hint the fix", async () => {
  const seen: string[] = [];
  const upstream = createServer((req, res) => {
    seen.push(req.url ?? "");
    assert.equal(req.headers.authorization, `Bearer ${UPSTREAM_KEY}`);
    if ((req.url ?? "").split("?")[0] === "/api/v1/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"usage":{"prompt_tokens":1,"completion_tokens":1}}');
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"message":"Not Found","code":404}');
  });
  const upPort = await listen(upstream);
  const host = `127.0.0.1:${upPort}`;
  const run = async (base: string) => {
    const lines: string[] = [];
    const { proxy, events, warnings } = make({ upstream: { baseUrl: `http://${host}${base}`, key: UPSTREAM_KEY }, fetch: undefined });
    const server = createModelProxyServer(proxy, { mode: "all", sink: (l) => lines.push(l) });
    const port = await listen(server);
    try {
      const headers = { authorization: `Bearer ${key()}`, "content-type": "application/json" };
      const first = await post(port, { ...headers, "x-pomtree-request-id": "r1" }, '{"model":"m"}', "/chat/completions?trace=q-secret");
      const second = await post(port, { ...headers, "x-pomtree-request-id": "r2" }, '{"model":"m"}');
      return { first, second, lines, events, warnings };
    } finally {
      server.close();
    }
  };
  try {
    const wrong = await run("/api");
    assert.deepEqual(wrong.first, { status: 404, body: '{"message":"Not Found","code":404}' }, "Pi gets the upstream's body unchanged");
    assert.equal(seen[0], "/api/chat/completions?trace=q-secret", "the query is forwarded upstream, but never journaled or logged");
    const e = wrong.events[0];
    assert.deepEqual(
      { kind: e?.kind, st: e?.upstreamStatus, cls: e?.errorClass, route: e?.route, host: e?.upstreamHost, path: e?.upstreamPath, msg: e?.upstreamMessage },
      { kind: "failed", st: 404, cls: "not_found", route: "chat_completions", host, path: "/api/chat/completions", msg: "Not Found" },
    );
    assert.match(
      wrong.lines[0]!,
      new RegExp(
        ` 404 \\d+ms agent:agent-1 model="m" upstream=404 upstreamHost=${host.replace(".", "\\.")} upstreamPath=/api/chat/completions charged=0 class=not_found upstreamMessage="Not Found"$`,
      ),
    );
    // One warning per route, however many 404s.
    assert.deepEqual(wrong.warnings, [
      `pomtreed: WARNING: model upstream answered 404 (not_found) for ${host}/api/chat/completions (route chat_completions): "Not Found"; check POMTREED_MODEL_BASE_URL: ${OPENROUTER_BASE_HINT}`,
    ]);
    assert.equal(wrong.second.status, 404);
    for (const s of [...wrong.lines, ...wrong.warnings, JSON.stringify(wrong.events)]) noLeak(s);

    // Negative: the right base answers 200 and warns nothing.
    const right = await run("/api/v1");
    assert.equal(right.first.status, 200);
    assert.deepEqual(right.warnings, []);
    assert.deepEqual([right.events[0]?.kind, right.events[0]?.upstreamPath, right.events[0]?.errorClass], ["priced", "/api/v1/chat/completions", undefined]);
  } finally {
    upstream.close();
  }
});
