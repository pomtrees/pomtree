import { tmpDir } from "@pomtree/testing";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { redactPath } from "@pomtree/core";
import { accessLogMode, formatAccessLine, shouldLog } from "./accesslog.ts";
import { listen } from "./server.ts";
import { configureAccessLog } from "./server.ts";
import { op, setup } from "./test-setup.ts";
import { sockRequest } from "./test-http.ts";

test("accessLogMode: auto follows the TTY, an explicit mode wins", () => {
  assert.equal(accessLogMode("auto", true), "all");
  assert.equal(accessLogMode("auto", false), "errors");
  assert.equal(accessLogMode("off", true), "off");
  assert.equal(accessLogMode("all", false), "all");
});

test("redactPath drops query strings and token-shaped segments", () => {
  assert.equal(redactPath("/v1/agents/a1?key=SECRET&token=x"), "/v1/agents/a1");
  assert.equal(redactPath("/x/op.0123456789abcdef0123/y#frag"), "/x/[redacted]/y");
  assert.equal(redactPath("/a\nb"), "/a_b");
});

test("formatAccessLine: model-proxy upstream facts are bounded and sanitized, and an explicit auth reason wins", () => {
  const base = { at: new Date(0), listener: "model-proxy" as const, method: "POST", url: "/chat/completions?k=v", durationMs: 1, principal: null };
  const line = formatAccessLine({
    ...base,
    status: 404,
    upstreamStatus: 404,
    upstreamHost: "openrouter.ai bad\nhost",
    upstreamPath: "/api/chat/completions?key=sk-x",
    errorClass: "not_found",
    upstreamMessage: "Not\nFound",
  });
  assert.match(line, / upstream=404 upstreamHost=openrouter\.ai_bad_host upstreamPath=\/api\/chat\/completions class=not_found upstreamMessage="Not Found"$/);
  assert.doesNotMatch(line, /key=|sk-x|k=v/);
  assert.match(formatAccessLine({ ...base, status: 401, hadCredential: true, authReason: "missing-request-id", error: "e" }), / auth=missing-request-id /);
  // Negative: without the override a credentialed 401 stays invalid-credential, and no upstream facts appear unasked.
  const plain = formatAccessLine({ ...base, status: 401, hadCredential: true, error: "e" });
  assert.match(plain, / auth=invalid-credential /);
  assert.doesNotMatch(plain, /upstreamHost|class=/);
});

test("shouldLog by mode and status class", () => {
  assert.equal(shouldLog("off", 500), false);
  assert.equal(shouldLog("errors", 200), false);
  assert.equal(shouldLog("errors", 404), true);
  assert.equal(shouldLog("all", 200), true);
});

test("formatAccessLine: ok, auth failure, 5xx detail", () => {
  const at = new Date("2026-01-02T03:04:05.000Z");
  const base = {
    at,
    listener: "unix" as const,
    method: "GET",
    url: "/v1/agents/a1?key=s",
    durationMs: 3.4,
    principal: { scope: "agent" as const, agent: "a1" },
  };
  assert.equal(formatAccessLine({ ...base, status: 200 }), "2026-01-02T03:04:05.000Z unix GET /v1/agents/a1 200 3ms agent:a1");
  assert.match(
    formatAccessLine({ ...base, status: 401, principal: null, error: "missing or invalid token", hadCredential: false }),
    /anon auth=missing-credential error="missing or invalid token"$/,
  );
  assert.match(formatAccessLine({ ...base, status: 403, error: "forbidden" }), /auth=forbidden-scope/);
  const l = formatAccessLine({ ...base, status: 500, error: "internal error", detail: "boom\nx" });
  assert.match(l, /detail="boom x"/);
  assert.ok(!l.includes("key=") && !l.includes("\n"));
});

const call = async (sock: string, method: string, path: string, headers: Record<string, string> = {}) =>
  (await sockRequest(sock, path, { method, headers })).status;

test("server logs 200/401/403/404/500 lines without secrets", async () => {
  const t = setup(async () => {});
  const lines: string[] = [];
  configureAccessLog("all", (l) => lines.push(l));
  const sock = join(tmpDir("pomtreed-"), "s.sock");
  const server = await listen(t.daemon, sock);
  const agentTok = t.daemon.agentToken("someagent", 0);
  const origErr = console.error;
  console.error = () => {};
  try {
    assert.equal(await call(sock, "GET", "/v1/agents?key=TOPSECRET", { authorization: `Bearer ${op}` }), 200);
    assert.equal(await call(sock, "GET", "/v1/agents", {}), 401);
    assert.equal(await call(sock, "GET", "/v1/ext/commands", { authorization: `Bearer ${agentTok}` }), 403);
    assert.equal(await call(sock, "GET", "/v1/nope", { authorization: `Bearer ${op}`, cookie: "pomtreed_ui=COOKIESECRET" }), 404);
    (t.daemon as { get: unknown }).get = async () => {
      throw new Error("db exploded at /home/x");
    };
    assert.equal(await call(sock, "GET", "/v1/agents/zz", { authorization: `Bearer ${op}` }), 500);
  } finally {
    console.error = origErr;
    configureAccessLog("off");
    await new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  }
  const all = lines.join("\n");
  assert.equal(lines.length, 5, all);
  assert.match(lines[0]!, / unix GET \/v1\/agents 200 \d+ms operator$/);
  assert.match(lines[1]!, / 401 \d+ms anon auth=missing-credential error="missing or invalid token"/);
  assert.match(lines[2]!, / 403 .*agent:someagent auth=forbidden-scope/);
  assert.match(lines[3]!, / 404 /);
  assert.match(lines[4]!, / 500 .*error="internal error" detail="db exploded/);
  for (const secret of ["TOPSECRET", "COOKIESECRET", op, agentTok]) assert.ok(!all.includes(secret), `leaked ${secret}`);
});
