import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT, describe, failureHint, run } from "./cli.ts";
import type { Io } from "./cli.ts";
import type { JournalEntry } from "@pomtree/core";
import { DOCKER_GROUP_ACTION } from "@pomtree/core";
import { TransportError } from "./client.ts";
import { CONTAINER_CONFIG_ENV, CONTAINER_CONTRACT, CONTAINER_DEFAULTS, canonicalContainerDoc } from "./container-contract.gen.ts";
import type { Call, Reply } from "./client.ts";
import { renderReport } from "./reports.ts";
import { harness } from "./test-kit.ts";

const agent = {
  id: "a1",
  name: "w",
  parent: "r",
  state: "exited",
  exit: "succeeded",
  result: { n: 1 },
  host: "h",
  generation: 1,
  budgetMicros: 5,
  task: "t",
  sandbox: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
// A request body without its issued idempotencyKey (asserted separately), for exact-shape comparisons.
const unkeyed = (body: unknown) => {
  const { idempotencyKey: _k, ...rest } = body as Record<string, unknown>;
  return rest;
};
const ev = (seq: number, payload: object) => ({ seq, ts: 0, agent: "a1", host: "h", generation: 1, payload });
const jv = (payload: object) => ({ seq: 1, ts: 0, agent: "a1", host: "h", generation: 1, payload }) as JournalEntry;

test("spawn sends task, name, budget, key and prints the id", async () => {
  const h = harness(() => ({ status: 201, body: agent }));
  assert.equal(await run(["spawn", "--task", "do it", "--name", "w", "--budget", "7", "--key", "k"], h.io), EXIT.ok);
  assert.deepEqual(h.calls[0], { method: "POST", path: "/v1/agents", body: { name: "w", task: "do it", budgetMicros: 7, idempotencyKey: "k" } });
  assert.deepEqual(h.out, ["a1"]);
});

test("--json prints machine output", async () => {
  const h = harness(() => ({ status: 200, body: [agent] }));
  assert.equal(await run(["ps", "--json", "--state", "exited"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.path, "/v1/agents?state=exited");
  assert.deepEqual(JSON.parse(h.out[0]!), [agent]);
});

test("result parses JSON and defaults to succeeded", async () => {
  const h = harness(() => ({ status: 200, body: agent }));
  assert.equal(await run(["result", '{"n":1}'], h.io), EXIT.ok);
  const body = h.calls[0]!.body as { status: string; result: unknown; idempotencyKey: string };
  assert.equal(body.status, "succeeded");
  assert.deepEqual(body.result, { n: 1 });
  assert.match(body.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.equal(await run(["result", "{nope"], harness(() => ({ status: 200, body: agent })).io), EXIT.usage);
});

test("describe shows the exit cause and strips control characters", () => {
  assert.equal(describe(jv({ kind: "exited", exit: "failed", cause: "provider_error" })), "exited failed (provider_error)");
  assert.equal(describe(jv({ kind: "exited", exit: "failed", cause: "host_stopped\u001b[31m" })), "exited failed (host_stopped)");
  assert.equal(describe(jv({ kind: "exited", exit: "failed", cause: "restart_exhausted" })), "exited failed (restart_exhausted)");
  assert.equal(describe(jv({ kind: "exited", exit: "failed", cause: "quarantined" })), "exited failed (quarantined)");
  assert.equal(describe(jv({ kind: "exited", exit: "succeeded" })), "exited succeeded");
  assert.equal(describe(jv({ kind: "usage", inputTokens: 3, outputTokens: 1, costMicros: 12 })), "usage in=3 out=1 cost=12");
  assert.equal(describe(jv({ kind: "usage", inputTokens: 3, outputTokens: 1, costMicros: null })), "usage in=3 out=1 cost=unknown");
});

test("describe strips terminal controls from every payload text field before clipping", () => {
  const esc = "\u001b[2J\u001b[H\u001b]0;pwned\u0007";
  const lines = [
    describe(jv({ kind: "message", role: "assistant", text: `${esc}hello\u001b[31m world` })),
    describe(jv({ kind: "tool_call", tool: `bash${esc}`, input: { cmd: "ls" } })),
    describe(jv({ kind: "tool_result", ok: false, output: `${esc}boom` })),
    describe(jv({ kind: "error", message: `${esc}provider failed` })),
    describe(jv({ kind: `odd${esc}` })),
  ];
  const isControl = (c: string) => {
    const n = c.charCodeAt(0);
    return (n < 0x20 && c !== "\t" && c !== "\n") || (n >= 0x7f && n <= 0x9f);
  };
  for (const l of lines) assert.ok(![...l].some(isControl), JSON.stringify(l));
  assert.equal(lines[0], "message(assistant) hello world");
  assert.equal(lines[2], "tool_result error boom");
  assert.equal(lines[3], "error provider failed");
  // The clip counts printable text: 79 visible characters survive even behind a long escape run.
  const long = describe(jv({ kind: "message", role: "assistant", text: `${"\u001b[0m".repeat(50)}${"x".repeat(200)}` }));
  assert.equal(long, `message(assistant) ${"x".repeat(79)}…`);
  // Negative: plain text, tabs and newlines pass through unchanged.
  assert.equal(describe(jv({ kind: "message", role: "user", text: "a\tb\nc" })), "message(user) a\tb\nc");
});

test("logs prints events without the escapes an agent embedded", async () => {
  const h = harness((c) =>
    c.path.includes("events") ? { status: 200, body: [ev(1, { kind: "message", role: "assistant", text: "\u001b[2Jcleared" })] } : { status: 200, body: agent },
  );
  assert.equal(await run(["logs", "a1"], h.io), EXIT.ok);
  assert.ok(h.out.length > 0);
  for (const l of h.out) assert.ok(!l.includes("\u001b"), l);
  assert.match(h.out.join("\n"), /message\(assistant\) cleared/);
});

test("show appends the exit cause to the state line", async () => {
  const failed = { ...agent, exit: "failed", exitCause: "oom_killed" };
  const h = harness((c) =>
    c.path.includes("checkpoint")
      ? { status: 404, body: { error: "no checkpoint" } }
      : c.path.includes("deadline")
        ? { status: 404, body: { error: "no deadline" } }
        : { status: 200, body: c.path.includes("events") ? [] : failed },
  );
  assert.equal(await run(["show", "a1"], h.io), EXIT.ok);
  assert.match(h.out[0]!, /state:\s+exited \(failed\) \(oom_killed\)/);
});

test("exit codes map HTTP and transport failures", async () => {
  const code = async (status: number) => run(["show", "x"], harness(() => ({ status, body: { error: "e" } })).io);
  assert.equal(await code(404), EXIT.notFound);
  assert.equal(await code(403), EXIT.denied);
  assert.equal(await code(401), EXIT.denied);
  assert.equal(await code(409), EXIT.conflict);
  assert.equal(await code(500), EXIT.error);
  for (const s of [400, 405, 413]) assert.equal(await code(s), EXIT.usage, String(s));
  for (const s of [422, 429, 502]) assert.equal(await code(s), EXIT.error, String(s));
  for (const s of [401, 403]) {
    const h = harness(() => ({ status: s, body: { error: `daemon text ${s}` } }));
    assert.equal(await run(["show", "x"], h.io), EXIT.denied);
    assert.match(h.err[0]!, new RegExp(`^pomtree: daemon text ${s}`), "the daemon's message is kept verbatim");
  }
  // A 409 on result (e.g. already reported) is a conflict, not a retry: one call, exit 5.
  const r409 = harness(() => ({ status: 409, body: { error: "result already recorded" } }));
  assert.equal(await run(["result", "--summary", "s"], r409.io), EXIT.conflict);
  assert.equal(r409.calls.length, 1);
  assert.match(r409.err[0]!, /result already recorded/);
  const down = harness(() => {
    throw new TransportError("cannot reach pomtreed");
  });
  assert.equal(await run(["doctor"], down.io), EXIT.unreachable);
  assert.match(down.err[0]!, /cannot reach/);
});

test("help, version and bare invocation print without calling the daemon", async () => {
  for (const argv of [[], ["--help"], ["-h"]]) {
    const h = harness(() => {
      throw new Error("must not call");
    });
    assert.equal(await run(argv, h.io), EXIT.ok, argv.join(" ") || "<none>");
    assert.equal(h.calls.length, 0);
    assert.match(h.out[0]!, /^usage: pomtree/);
    assert.equal(h.err.length, 0);
  }
  for (const argv of [["--version"], ["-V"]]) {
    const h = harness(() => {
      throw new Error("must not call");
    });
    assert.equal(await run(argv, h.io), EXIT.ok, argv.join(" "));
    assert.deepEqual(h.out, ["0.0.0-test"]);
  }
});

test("--help lists the exit codes", async () => {
  const h = harness(() => ({ status: 200, body: null }));
  assert.equal(await run(["--help"], h.io), EXIT.ok);
  const u = h.out.join("\n");
  for (const re of [/exit codes: 0 ok; 1 other error/, /2 usage/, /3 not found/, /4 denied/, /5 conflict/, /6 daemon unreachable/, /7 wait timed out/])
    assert.match(u, re);
  for (const [k, v] of Object.entries(EXIT)) assert.match(u, new RegExp(`\\b${v} `), k);
});

test("a malformed --wrapup names --wrapup, a malformed --deadline names --deadline", async () => {
  const w = harness(() => ({ status: 201, body: agent }));
  assert.equal(await run(["spawn", "--task", "t", "--wrapup", "abc"], w.io), EXIT.usage);
  assert.match(w.err[0]!, /--wrapup must be a duration such as 4h or 90m, got "abc"/);
  assert.doesNotMatch(w.err[0]!.split("\n")[0]!, /--deadline|0 = unlimited/);
  assert.equal(w.calls.length, 0);
  const d = harness(() => ({ status: 201, body: agent }));
  assert.equal(await run(["spawn", "--task", "t", "--deadline", "abc"], d.io), EXIT.usage);
  assert.match(d.err[0]!, /--deadline must be a duration such as 4h or 90m \(0 = unlimited\), got "abc"/);
  assert.doesNotMatch(d.err[0]!.split("\n")[0]!, /--wrapup/);
});

test("a 401 hint matches the caller: an agent's POMTREE_TOKEN vs the operator token file", async () => {
  const op = harness(() => ({ status: 401, body: { error: "missing or invalid token" } }));
  op.io.env = { POMTREED_STATE_DIR: "/s" };
  assert.equal(await run(["ps"], op.io), EXIT.denied);
  assert.match(op.err.join("\n"), /hint: token missing\/invalid: check POMTREED_STATE_DIR and operator\.token/);
  const ag = harness(() => ({ status: 401, body: { error: "missing or invalid token" } }));
  ag.io.env = { POMTREE_TOKEN: "secret-agent-token", POMTREE_AGENT_GENERATION: "1" };
  assert.equal(await run(["inbox"], ag.io), EXIT.denied);
  const e = ag.err.join("\n");
  assert.match(e, /hint: this agent's POMTREE_TOKEN was not accepted/);
  assert.doesNotMatch(e, /operator\.token|POMTREED_STATE_DIR/, "an agent is not told to look for the operator token");
  assert.ok(!e.includes("secret-agent-token"), "the token is never echoed");
  // A POMTREE_TOKEN set outside a container is the caller's own choice: name it, not the agent lifecycle.
  const own = failureHint(401, { error: "x" }, { POMTREE_TOKEN: "t" })!;
  assert.match(own, /the POMTREE_TOKEN in your environment was not accepted: unset it/);
  assert.doesNotMatch(own, /this agent/);
  // A machine code refines the advice; an empty POMTREE_TOKEN is not a choice of token.
  assert.match(failureHint(401, { error: "x", code: "token_revoked" }, { POMTREE_TOKEN: "t", POMTREE_AGENT_GENERATION: "2" })!, /revoked .*stop/);
  assert.match(failureHint(401, { error: "x", code: "token_revoked" }, {})!, /token revoked: check POMTREED_STATE_DIR/);
  assert.match(failureHint(401, { error: "x" }, { POMTREE_TOKEN: "" })!, /^token missing\/invalid: check POMTREED_STATE_DIR and operator\.token$/);
  assert.equal(failureHint(403, { error: "x" }, { POMTREE_AGENT_GENERATION: "1" }), undefined);
});

test("a 409 hint follows the daemon's optional machine code; the exit stays 5", async () => {
  assert.match(failureHint(409, { error: "x", code: "uncommitted_work", fingerprint: "f" }, {})!, /commit them and run pomtree push/);
  // An older daemon without `code` still sends the fingerprint on the uncommitted 409.
  assert.match(failureHint(409, { error: "x", uncommitted: true, fingerprint: "f" }, {})!, /--save-uncommitted/);
  assert.match(failureHint(409, { error: "x", code: "stale_generation" }, {})!, /superseded generation/);
  assert.match(failureHint(409, { error: "x", code: "idempotency_conflict" }, {})!, /new --key/);
  // For `pomtree result` the same key with another value means a result was already recorded, so "pass a new --key" would mislead.
  const rh = failureHint(409, { error: "x", code: "idempotency_conflict" }, {}, "result")!;
  assert.match(rh, /result was already recorded/);
  assert.doesNotMatch(rh, /new --key/);
  const rr = harness(() => ({ status: 409, body: { error: "key reused", code: "idempotency_conflict" } }));
  assert.equal(await run(["result", "--summary", "s"], rr.io), EXIT.conflict);
  assert.match(rr.err.join("\n"), /hint: a result was already recorded/);
  // Negative: an unknown code, no code, or a non-object body gives no invented advice.
  assert.equal(failureHint(409, { error: "x", code: "something_new" }, {}), undefined);
  assert.equal(failureHint(409, { error: "already decided" }, {}), undefined);
  assert.equal(failureHint(409, null, {}), undefined);
  assert.equal(failureHint(500, { code: "uncommitted_work", fingerprint: "f" }, {}), undefined);
  const msg =
    "uncommitted work: commit and pomtree push it, or approve daemon commit and local collection by retrying pomtree result with --save-uncommitted fp1";
  const h = harness(() => ({ status: 409, body: { error: msg, uncommitted: true, fingerprint: "fp1" } }));
  assert.equal(await run(["result", "--summary", "s"], h.io), EXIT.conflict);
  assert.match(h.err.join("\n"), /--save-uncommitted fp1\nhint: the workspace has uncommitted changes/);
});

test("usage errors", async () => {
  for (const argv of [["bogus"], ["spawn"], ["show"], ["spawn", "--task"], ["cancel", "x", "--grace", "soon"]]) {
    const h = harness(() => ({ status: 200, body: null }));
    assert.equal(await run(argv, h.io), EXIT.usage, argv.join(" "));
    assert.equal(h.calls.length, 0);
  }
});

test("logs -f follows from the last seq and stops once the agent exited", async () => {
  const pages = [[ev(1, { kind: "spawned" }), ev(2, { kind: "message", role: "assistant", text: "hi" })], [ev(3, { kind: "exited", exit: "succeeded" })], []];
  const h = harness((c) => {
    if (c.path.startsWith("/v1/agents/a1/events")) return { status: 200, body: pages.shift() ?? [] };
    return { status: 200, body: pages.length > 1 ? { ...agent, state: "running" } : agent };
  });
  assert.equal(await run(["logs", "a1", "-f"], h.io), EXIT.ok);
  assert.deepEqual(
    h.calls.filter((c) => c.path.includes("events")).map((c) => c.path),
    ["/v1/agents/a1/events?from=1&waitMs=25000", "/v1/agents/a1/events?from=3&waitMs=25000", "/v1/agents/a1/events?from=4"],
  );
  assert.equal(h.out.length, 3);
  assert.match(h.out[1]!, /message\(assistant\) hi/);
});

test("logs -f on an already-exited agent prints existing events and returns without long-polling", async () => {
  const pages = [[ev(1, { kind: "spawned" })], []];
  const h = harness((c) => (c.path.includes("/events") ? { status: 200, body: pages.shift() ?? [] } : { status: 200, body: { ...agent, state: "exited" } }));
  assert.equal(await run(["logs", "a1", "-f"], h.io), EXIT.ok);
  assert.equal(h.out.length, 1);
  assert.ok(h.calls.filter((c) => c.path.includes("events")).every((c) => !c.path.includes("waitMs")));
});

test("report list renders the real /v1/reports shape ({report, agent}) and the per-agent Report[] shape", async () => {
  const r = { id: "r1", agent: "a1", generation: 1, host: "h", name: "n", mediaType: "text/plain", sizeBytes: 5, sha256: "x", createdAt: Date.now() };
  for (const [argv, body] of [
    [["report", "list"], [{ report: r, agent: "a1" }]],
    [["report", "list", "a1"], [r]],
  ] as const) {
    const h = harness(() => ({ status: 200, body }));
    assert.equal(await run([...argv], h.io), EXIT.ok);
    assert.match(h.out.join("\n"), /r1\s+a1\s+n\s+text\/plain\s+5/);
  }
});

test("show, cancel, kill, doctor", async () => {
  const h = harness((c) =>
    c.path.includes("checkpoint")
      ? { status: 404, body: { error: "no checkpoint" } }
      : c.path.includes("deadline")
        ? { status: 404, body: { error: "no deadline" } }
        : { status: 200, body: c.path.includes("events") ? [] : c.path === "/v1/doctor" ? { ok: true, host: "h", agents: {}, sandboxes: 0, live: 0 } : agent },
  );
  assert.equal(await run(["show", "a1"], h.io), EXIT.ok);
  assert.equal(await run(["cancel", "a1", "--grace", "50"], h.io), EXIT.ok);
  assert.equal(await run(["kill", "a1"], h.io), EXIT.ok);
  assert.equal(await run(["doctor"], h.io), EXIT.ok);
  assert.deepEqual(
    h.calls.map((c) => `${c.method} ${c.path}`),
    [
      "GET /v1/agents/a1",
      "GET /v1/agents/a1/events?tail=10",
      "GET /v1/agents/a1/checkpoint",
      "GET /v1/agents/a1/deadline",
      "POST /v1/agents/a1/cancel",
      "POST /v1/agents/a1/kill",
      "GET /v1/doctor",
    ],
  );
  const cancelBody = h.calls[4]!.body as { graceMs: number; idempotencyKey: string };
  assert.equal(cancelBody.graceMs, 50);
  assert.match(cancelBody.idempotencyKey, /^[0-9a-f-]{36}$/);
});

test("spawn --template NAME is forwarded", async () => {
  const h = harness(() => ({ status: 201, body: agent }));
  await run(["spawn", "--task", "t", "--key", "k", "--template", "researcher"], h.io);
  assert.equal((h.calls[0]!.body as { template?: string }).template, "researcher");
});

test("spawn --deadline accepts positive durations and forwards milliseconds", async () => {
  const h = harness(() => ({ status: 201, body: agent }));
  assert.equal(await run(["spawn", "--task", "t", "--deadline", "4h", "--key", "k"], h.io), EXIT.ok);
  assert.equal((h.calls[0]!.body as { deadlineMs?: number }).deadlineMs, 14_400_000);

  const minutes = harness(() => ({ status: 201, body: agent }));
  assert.equal(await run(["spawn", "--task", "t", "--deadline", "90m"], minutes.io), EXIT.ok);
  assert.equal((minutes.calls[0]!.body as { deadlineMs?: number }).deadlineMs, 5_400_000);

  const milliseconds = harness(() => ({ status: 201, body: agent }));
  assert.equal(await run(["spawn", "--task", "t", "--deadline", "60000"], milliseconds.io), EXIT.ok);
  assert.equal((milliseconds.calls[0]!.body as { deadlineMs?: number }).deadlineMs, 60_000);
});

test("spawn --deadline 0 (and 0s/0m) is forwarded as explicit unlimited", async () => {
  for (const value of ["0", "0s", "0m", "0h", "0ms"]) {
    const h = harness(() => ({ status: 201, body: agent }));
    assert.equal(await run(["spawn", "--task", "t", "--deadline", value], h.io), EXIT.ok, value);
    assert.equal((h.calls[0]!.body as { deadlineMs?: number }).deadlineMs, 0, value);
  }
});

test("spawn --deadline rejects malformed durations", async () => {
  for (const value of ["", "-1", "1.5h", "4d", "Infinity", "NaN", "-0"]) {
    const h = harness(() => ({ status: 201, body: agent }));
    assert.equal(await run(["spawn", "--task", "t", "--deadline", value], h.io), EXIT.usage, value || "empty");
    assert.equal(h.calls.length, 0);
    assert.match(h.err[0]!, /--deadline/);
  }
});

test("template ls lists templates and --json prints machine output", async () => {
  const tpl = { id: "researcher", image: "img", provider: "p", model: "m" };
  const h = harness(() => ({ status: 200, body: [tpl] }));
  assert.equal(await run(["template", "ls"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.path, "/v1/templates");
  assert.match(h.out[0]!, /researcher/);
  const j = harness(() => ({ status: 200, body: [tpl] }));
  await run(["template", "ls", "--json"], j.io);
  assert.deepEqual(JSON.parse(j.out[0]!), [tpl]);
});

test("template show resolves by name and requires a name", async () => {
  const tpl = { id: "researcher", image: "img" };
  const h = harness(() => ({ status: 200, body: tpl }));
  assert.equal(await run(["template", "show", "researcher"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.path, "/v1/templates/researcher");
  assert.match(h.out[0]!, /researcher/);
  assert.equal(await run(["template", "show"], harness(() => ({ status: 200, body: null })).io), EXIT.usage);
  assert.equal(await run(["template", "bogus"], harness(() => ({ status: 200, body: null })).io), EXIT.usage);
});

test("ext list lists this agent's extensions and --json prints the machine body", async () => {
  const specs = [{ name: "web_fetch", description: "fetch a url", inputSchema: { type: "object" }, streaming: false }];
  const h = harness(() => ({ status: 200, body: { extensions: specs } }));
  assert.equal(await run(["ext", "list"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.path, "/v1/ext");
  assert.match(h.out[0]!, /^NAME\s+DESCRIPTION/);
  assert.match(h.out[0]!, /web_fetch\s+fetch a url/);
  const j = harness(() => ({ status: 200, body: { extensions: specs } }));
  await run(["ext", "list", "--json"], j.io);
  assert.deepEqual(JSON.parse(j.out[0]!), { extensions: specs });
});

test("ext call posts the input with a deterministic key and prints result or denied reason", async () => {
  const res = { callId: "c", ok: true, result: { n: 1 } };
  const h = harness(() => ({ status: 200, body: res }));
  assert.equal(await run(["ext", "call", "web_fetch", "--input", '{"url":"https://x"}'], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.path, "/v1/ext/web_fetch/call");
  const callBody = h.calls[0]!.body as { input: unknown; idempotencyKey: string };
  assert.deepEqual(callBody.input, { url: "https://x" });
  assert.match(callBody.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.match(h.out[0]!, /"n": 1/);

  const denied = harness(() => ({ status: 200, body: { callId: "c", ok: false, denied: true, reason: "no provider" } }));
  assert.equal(await run(["ext", "call", "web_search", "--input", '{"query":"x"}', "--key", "k"], denied.io), EXIT.ok);
  assert.deepEqual(denied.calls[0]!.body, { input: { query: "x" }, idempotencyKey: "k" });
  assert.equal(denied.out[0]!, "no provider");

  const j = harness(() => ({ status: 200, body: res }));
  await run(["ext", "call", "web_fetch", "--input", '{"url":"https://x"}', "--json"], j.io);
  assert.deepEqual(JSON.parse(j.out[0]!), res);
});

test("ext call accepts the input JSON positionally (the shim form) and rejects invalid JSON", async () => {
  const h = harness(() => ({ status: 200, body: { callId: "c", ok: true, result: { x: 1 } } }));
  assert.equal(await run(["ext", "call", "web_fetch", '{"url":"https://x"}'], h.io), EXIT.ok);
  const posBody = h.calls[0]!.body as { input: unknown; idempotencyKey: string };
  assert.deepEqual(posBody.input, { url: "https://x" });
  assert.match(posBody.idempotencyKey, /^[0-9a-f-]{36}$/);
  const bad = harness(() => ({ status: 200, body: null }));
  assert.equal(await run(["ext", "call", "web_fetch", "--input", "{nope"], bad.io), EXIT.usage);
  assert.match(bad.err[0]!, /input must be valid JSON/);
  assert.equal(bad.calls.length, 0);
});

test("ext search and fetch wrap web_search/web_fetch and print items/text", async () => {
  const search = harness(() => ({ status: 200, body: { callId: "c", ok: true, result: { items: [{ title: "T", url: "https://x", snippet: "S" }] } } }));
  assert.equal(await run(["ext", "search", "--query", "cats"], search.io), EXIT.ok);
  assert.equal(search.calls[0]!.path, "/v1/ext/web_search/call");
  const searchBody = search.calls[0]!.body as { input: unknown; idempotencyKey: string };
  assert.deepEqual(searchBody.input, { query: "cats" });
  assert.match(searchBody.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.match(search.out[0]!, /1\. T/);

  const fetch = harness(() => ({ status: 200, body: { callId: "c", ok: true, result: { body: "hello" } } }));
  assert.equal(await run(["ext", "fetch", "https://example.com", "--key", "k"], fetch.io), EXIT.ok);
  assert.equal(fetch.calls[0]!.path, "/v1/ext/web_fetch/call");
  assert.deepEqual(fetch.calls[0]!.body, { input: { url: "https://example.com" }, idempotencyKey: "k" });
  assert.equal(fetch.out[0]!, "hello");
});

test("ext usage errors", async () => {
  for (const argv of [["ext"], ["ext", "call"], ["ext", "search"], ["ext", "fetch"], ["ext", "bogus"]]) {
    const h = harness(() => ({ status: 200, body: null }));
    assert.equal(await run(argv, h.io), EXIT.usage, argv.join(" "));
    assert.equal(h.calls.length, 0);
  }
});

test("wait exits 0 when done and 7 on timeout", async () => {
  const done = harness(() => ({ status: 200, body: { done: true, record: agent } }));
  assert.equal(await run(["wait", "a1", "--timeout", "50"], done.io), EXIT.ok);
  assert.equal(done.calls[0]!.path, "/v1/agents/a1/wait?timeoutMs=50");
  const slow = harness(() => ({ status: 200, body: { done: false, record: { ...agent, state: "running" } } }));
  assert.equal(await run(["wait", "a1"], slow.io), EXIT.timeout);
  assert.equal(slow.calls[0]!.path, "/v1/agents/a1/wait?timeoutMs=30000");
  assert.match(slow.out[0]!, /still running/);
});

test("reap posts and reports the returned budget; conflict maps to exit 5", async () => {
  const ok = harness(() => ({ status: 200, body: { record: { ...agent, state: "reaped" }, unusedMicros: 42 } }));
  assert.equal(await run(["reap", "a1"], ok.io), EXIT.ok);
  assert.equal(ok.calls[0]!.method, "POST");
  assert.equal(ok.calls[0]!.path, "/v1/agents/a1/reap");
  assert.match((ok.calls[0]!.body as { idempotencyKey: string }).idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.match(ok.out[0]!, /42 µ\$/);
  assert.equal(await run(["reap", "a1"], harness(() => ({ status: 409, body: { error: "not exited" } })).io), EXIT.conflict);
});

test("inbox prints signals with a short id, then acks the printed ids; --peek does not ack", async () => {
  const sigs = [
    { id: "0123456789abcdef", kind: "child_exited", child: "c", exit: "failed" },
    { id: "fedcba9876543210", kind: "message", from: "p", body: "hi" },
  ];
  const h = harness((c) => (c.method === "GET" ? { status: 200, body: sigs } : { status: 200, body: { acked: 2 } }));
  assert.equal(await run(["inbox", "--wait", "100", "--key", "k"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.path, "/v1/agents/self/inbox?waitMs=100");
  assert.match(h.out[0]!, /^\[01234567\] \{"kind":"child_exited"/m);
  assert.match(h.out[0]!, /^\[fedcba98\] \{"kind":"message"/m);
  assert.doesNotMatch(h.out[0]!, /0123456789abcdef/);
  assert.deepEqual(h.calls[1], { method: "POST", path: "/v1/agents/self/inbox/ack", body: { ids: sigs.map((x) => x.id), idempotencyKey: "k" } });
  const j = harness((c) => (c.method === "GET" ? { status: 200, body: sigs } : { status: 200, body: { acked: 2 } }));
  assert.equal(await run(["inbox", "--json"], j.io), EXIT.ok);
  assert.deepEqual(JSON.parse(j.out[0]!), sigs);
  assert.match((j.calls[1]!.body as { idempotencyKey: string }).idempotencyKey, /^[0-9a-f-]{36}$/);
  const p = harness(() => ({ status: 200, body: sigs }));
  assert.equal(await run(["inbox", "--peek"], p.io), EXIT.ok);
  assert.equal(p.calls.length, 1);
  const none = harness(() => ({ status: 200, body: [] }));
  assert.equal(await run(["inbox"], none.io), EXIT.ok);
  assert.equal(none.calls.length, 1);
  assert.equal(await run(["inbox", "--wait", "soon"], harness(() => ({ status: 200, body: [] })).io), EXIT.usage);
  assert.equal(await run(["wait"], harness(() => ({ status: 200, body: null })).io), EXIT.usage);
});

test("decide posts the decision, grant (money-parsed), why and key", async () => {
  const h = harness(() => ({ status: 201, body: { ok: true } }));
  assert.equal(await run(["decide", "ap/1", "approve", "--grant", "$0.50", "--why", "ok then", "--key", "k"], h.io), EXIT.ok);
  assert.deepEqual(h.calls[0], {
    method: "POST",
    path: "/v1/approvals/ap%2F1/decide",
    body: { decision: "approve", grantMicros: 500000, why: "ok then", idempotencyKey: "k" },
  });
  assert.deepEqual(h.out, ["approved ap/1"]);
  const g = harness(() => ({ status: 201, body: {} }));
  assert.equal(await run(["decide", "ap", "approve", "--grant", "250"], g.io), EXIT.ok);
  assert.equal((g.calls[0]!.body as { grantMicros: number }).grantMicros, 250);
  assert.match((g.calls[0]!.body as { idempotencyKey: string }).idempotencyKey, /^[0-9a-f-]{36}$/);
  const d = harness(() => ({ status: 201, body: {} }));
  assert.equal(await run(["decide", "ap", "deny"], d.io), EXIT.ok);
  assert.deepEqual(Object.keys(d.calls[0]!.body as object).sort(), ["decision", "idempotencyKey"]);
  const p = harness(() => ({ status: 201, body: {} }));
  assert.equal(await run(["decide", "ap", "pass", "--json"], p.io), EXIT.ok);
  assert.equal((p.calls[0]!.body as { decision: string }).decision, "pass");
  for (const argv of [
    ["decide"],
    ["decide", "ap"],
    ["decide", "ap", "maybe"],
    ["decide", "ap", "approve", "--grant", "x"],
    ["decide", "ap", "deny", "--grant", "$1"],
  ]) {
    const u = harness(() => ({ status: 201, body: {} }));
    assert.equal(await run(argv, u.io), EXIT.usage, argv.join(" "));
    assert.equal(u.calls.length, 0);
  }
});

test("decide/answer/pass surface 403, 404 and 409 (insufficient_budget) as typed errors", async () => {
  for (const [argv, status, code, msg] of [
    [["decide", "ap", "approve", "--grant", "$9"], 409, EXIT.conflict, "insufficient_budget: parent has $1 unreserved"],
    [["decide", "ap", "approve"], 404, EXIT.notFound, "no such approval: ap"],
    [["answer", "e1", "x"], 403, EXIT.denied, "not the holder of this escalation"],
    [["pass", "e1"], 409, EXIT.conflict, "already answered"],
  ] as const) {
    const h = harness(() => ({ status, body: { error: msg } }));
    assert.equal(await run([...argv], h.io), code, argv.join(" "));
    assert.match(h.err.join("\n"), new RegExp(msg.slice(0, 12)));
  }
});

test("answer joins the text into body; pass posts the key; both need an id", async () => {
  const h = harness(() => ({ status: 201, body: { id: "e1" } }));
  assert.equal(await run(["answer", "e1", "go", "ahead", "--key", "k"], h.io), EXIT.ok);
  assert.deepEqual(h.calls[0], { method: "POST", path: "/v1/escalations/e1/answer", body: { body: "go ahead", idempotencyKey: "k" } });
  assert.deepEqual(h.out, ["answered e1"]);
  const p = harness(() => ({ status: 201, body: { id: "e1" } }));
  assert.equal(await run(["pass", "e1", "--key", "k2"], p.io), EXIT.ok);
  assert.deepEqual(p.calls[0], { method: "POST", path: "/v1/escalations/e1/pass", body: { idempotencyKey: "k2" } });
  assert.deepEqual(p.out, ["passed e1"]);
  for (const argv of [["answer"], ["answer", "e1"], ["pass"]]) {
    const u = harness(() => ({ status: 201, body: {} }));
    assert.equal(await run(argv, u.io), EXIT.usage, argv.join(" "));
    assert.equal(u.calls.length, 0);
  }
});

test("peers lists addressable agents as a table or JSON", async () => {
  const peer = { ...agent, id: "p2", name: "bob", parent: "r", state: "running" };
  const h = harness(() => ({ status: 200, body: [peer] }));
  assert.equal(await run(["peers"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.path, "/v1/peers");
  assert.match(h.out[0]!, /bob/);
  assert.match(h.out[0]!, /running/);
  const hj = harness(() => ({ status: 200, body: [peer] }));
  assert.equal(await run(["peers", "--json"], hj.io), EXIT.ok);
  assert.deepEqual(JSON.parse(hj.out[0]!), [peer]);
});

test("send posts body, a deterministic key and the fencing generation, and maps failures", async () => {
  const prev = process.env.POMTREE_AGENT_GENERATION;
  process.env.POMTREE_AGENT_GENERATION = "3";
  try {
    const h = harness(() => ({ status: 201, body: { kind: "message", from: "me", body: "hello world" } }));
    assert.equal(await run(["send", "p2", "hello", "world"], h.io), EXIT.ok);
    assert.equal(h.calls[0]!.path, "/v1/peers/p2/send");
    const first = h.calls[0]!.body as { body: string; generation: number; idempotencyKey: string };
    assert.equal(first.body, "hello world");
    assert.equal(first.generation, 3);
    assert.match(first.idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.match(h.out[0]!, /p2/);

    const h2 = harness(() => ({ status: 201, body: {} }));
    assert.equal(await run(["send", "p2", "x", "--key", "k"], h2.io), EXIT.ok);
    assert.deepEqual(h2.calls[0]!.body, { body: "x", generation: 3, idempotencyKey: "k" });

    assert.equal(
      await run(["send", "p2", "x"], harness(() => ({ status: 409, body: { error: "stale generation for p2: got 0, current 1" } })).io),
      EXIT.conflict,
    );
    assert.equal(await run(["send", "ghost", "x"], harness(() => ({ status: 404, body: { error: "no such peer: ghost" } })).io), EXIT.notFound);
  } finally {
    if (prev === undefined) delete process.env.POMTREE_AGENT_GENERATION;
    else process.env.POMTREE_AGENT_GENERATION = prev;
  }
  assert.equal(await run(["send"], harness(() => ({ status: 200, body: null })).io), EXIT.usage);
  assert.equal(await run(["send", "p2"], harness(() => ({ status: 200, body: null })).io), EXIT.usage);
});

test("send with an invalid POMTREE_AGENT_GENERATION exits usage before calling", async () => {
  const prev = process.env.POMTREE_AGENT_GENERATION;
  delete process.env.POMTREE_AGENT_GENERATION;
  try {
    const h = harness(() => ({ status: 201, body: {} }));
    // unset = the operator: posts to the agent's /message route (queue by default), no generation needed
    assert.equal(await run(["send", "p2", "x", "--key", "k"], h.io), EXIT.ok);
    assert.equal(h.calls[0]!.path, "/v1/agents/p2/message");
    assert.deepEqual(h.calls[0]!.body, { body: "x", mode: "queue", idempotencyKey: "k" });

    process.env.POMTREE_AGENT_GENERATION = "soon";
    const h2 = harness(() => ({ status: 200, body: null }));
    assert.equal(await run(["send", "p2", "x"], h2.io), EXIT.usage);
    assert.equal(h2.calls.length, 0);
  } finally {
    if (prev === undefined) delete process.env.POMTREE_AGENT_GENERATION;
    else process.env.POMTREE_AGENT_GENERATION = prev;
  }
});

test("numeric flags reject empty, non-finite, negative and (budget) fractional values", async () => {
  const bad = [
    ["spawn", "--task", "t", "--budget", ""],
    ["spawn", "--task", "t", "--budget", "-5"],
    ["spawn", "--task", "t", "--budget", "1.5"],
    ["spawn", "--task", "t", "--budget", "Infinity"],
    ["wait", "a1", "--timeout", ""],
    ["wait", "a1", "--timeout", "-1"],
    ["cancel", "a1", "--grace", "-1"],
    ["cancel", "a1", "--grace", " "],
    ["inbox", "--wait", ""],
    ["inbox", "--wait", "-3"],
  ];
  for (const argv of bad) {
    const h = harness(() => ({ status: 200, body: null }));
    assert.equal(await run(argv, h.io), EXIT.usage, argv.join(" "));
    assert.equal(h.calls.length, 0);
    assert.match(h.err[0]!, /--(budget|timeout|grace|wait) must be a (non-negative|positive)/);
  }
  assert.equal(await run(["spawn", "--task", "t", "--budget", "1000"], harness(() => ({ status: 201, body: agent })).io), EXIT.ok);
});

test("only calls that block by design disable the client timeout", async () => {
  const h = harness((c) => ({
    status: c.path.includes("deadline") ? 404 : 200,
    body: c.path.includes("/wait")
      ? { done: true, record: agent }
      : c.path.includes("inbox")
        ? []
        : c.path.includes("events")
          ? []
          : c.path.includes("deadline")
            ? { error: "no deadline" }
            : agent,
  }));
  await run(["wait", "a1"], h.io);
  await run(["inbox", "--wait", "10"], h.io);
  await run(["inbox"], h.io);
  await run(["logs", "a1", "-f"], h.io);
  await run(["logs", "a1"], h.io);
  await run(["show", "a1"], h.io);
  assert.deepEqual(
    h.calls.map((c) => `${c.path.split("?")[0]!.replace("/v1/agents/", "")} ${c.timeoutMs}`),
    [
      "a1/wait 0",
      "self/inbox 0",
      "self/inbox undefined",
      "a1 undefined",
      "a1/events 0",
      "a1/events undefined",
      "a1 undefined",
      "a1/events undefined",
      "a1/checkpoint undefined",
      "a1/deadline undefined",
    ],
  );
});

const topRow = {
  name: "w",
  id: "a1",
  depth: 0,
  state: "exited:succeeded",
  age: "0s",
  activity: "tool bash",
  tokens: 0,
  cost: "$0.0000",
  left: "$0.0000",
  wait: "",
  host: "h",
};

test("top renders once and exits when stdout is not a tty", async () => {
  const h = harness(() => ({ status: 200, body: [topRow] }));
  assert.equal(await run(["top"], h.io), EXIT.ok);
  assert.deepEqual(
    h.calls.map((c) => `${c.method} ${c.path}`),
    ["GET /v1/tree", "GET /v1/summary"],
  );
  assert.match(h.out[0]!, /^AGENT\s+ID\s+STATE/);
  assert.match(h.out[0]!, /tool bash/);
  assert.ok(!h.out[0]!.includes("\x1b["));
});

test("top --once --json prints the display rows", async () => {
  const h = harness(() => ({ status: 200, body: [topRow] }));
  assert.equal(await run(["top", "--once", "--json"], h.io), EXIT.ok);
  const rows = JSON.parse(h.out[0]!);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "a1");
  assert.equal(rows[0].state, "exited:succeeded");
});

test("top --interval validates as a non-negative integer", async () => {
  const h = harness(() => ({ status: 200, body: [topRow] }));
  assert.equal(await run(["top", "--once", "--interval", "soon"], h.io), EXIT.usage);
  assert.equal(await run(["top", "--once", "--interval", "-1"], h.io), EXIT.usage);
  assert.equal(h.calls.length, 0);
});

test("top reports an unreachable daemon", async () => {
  const down = harness(() => {
    throw new TransportError("cannot reach pomtreed");
  });
  assert.equal(await run(["top"], down.io), EXIT.unreachable);
  assert.match(down.err[0]!, /cannot reach/);
});

test("top with no agents renders the empty table", async () => {
  const h = harness(() => ({ status: 200, body: [] }));
  assert.equal(await run(["top", "--once"], h.io), EXIT.ok);
  assert.equal(h.out[0]!, "(no agents)");
});

test("top on a tty follows live until the daemon goes away", async () => {
  let polls = 0;
  const h = harness(
    () => {
      polls++;
      if (polls > 1) throw new TransportError("cannot reach pomtreed");
      return { status: 200, body: [topRow] };
    },
    { isTTY: true },
  );
  assert.equal(await run(["top"], h.io), EXIT.unreachable);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
  assert.match(h.out[0]!, /^\x1b\[H\x1b\[2J/);
  assert.match(h.out[0]!, /AGENT\s+ID\s+STATE/);
});

const rep = { id: "r1", agent: "a1", generation: 1, host: "h", name: "n", mediaType: "text/plain", sizeBytes: 5, sha256: "s", createdAt: 0 };

test("report publish posts octet-stream bytes with a derived key and prints the id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pomtree-report-"));
  const file = join(dir, "r.html");
  writeFileSync(file, "<h1>hi</h1>");
  const report = { ...rep, mediaType: "text/html" };
  const h = harness(() => ({ status: 201, body: { report, replayed: false } }));
  try {
    assert.equal(await run(["report", "publish", file, "--name", "r", "--media-type", "text/html"], h.io), EXIT.ok);
    assert.equal(h.calls.length, 1);
    const c = h.calls[0]!;
    assert.equal(c.method, "POST");
    const [p, qs] = c.path.split("?") as [string, string];
    assert.equal(p, "/v1/agents/self/reports");
    const q = new URLSearchParams(qs);
    assert.equal(q.get("name"), "r");
    assert.equal(q.get("mediaType"), "text/html");
    assert.match(q.get("key")!, /^[0-9a-f-]{36}$/);
    assert.deepEqual(c.body, Buffer.from("<h1>hi</h1>"));
    assert.match(h.out[0]!, /published r1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report publish forwards --key and generation and reports a replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pomtree-report-"));
  const file = join(dir, "x.txt");
  writeFileSync(file, "data");
  const prev = process.env.POMTREE_AGENT_GENERATION;
  process.env.POMTREE_AGENT_GENERATION = "7";
  const report = { ...rep, generation: 7 };
  const h = harness(() => ({ status: 200, body: { report, replayed: true } }));
  try {
    assert.equal(await run(["report", "publish", file, "--key", "k", "--json"], h.io), EXIT.ok);
    const q = new URLSearchParams(h.calls[0]!.path.split("?")[1]!);
    assert.equal(q.get("key"), "k");
    assert.equal(q.get("generation"), "7");
    assert.deepEqual(JSON.parse(h.out[0]!), report);
  } finally {
    if (prev === undefined) delete process.env.POMTREE_AGENT_GENERATION;
    else process.env.POMTREE_AGENT_GENERATION = prev;
    rmSync(dir, { recursive: true, force: true });
  }
  const h2 = harness(() => ({ status: 200, body: { report, replayed: true } }));
  assert.equal(await run(["report", "publish", file], h2.io), EXIT.usage); // file already removed → usage, no call
  assert.equal(h2.calls.length, 0);
});

test("report publish on a missing path exits usage before any network call", async () => {
  const h = harness(() => ({ status: 200, body: null }));
  assert.equal(await run(["report", "publish", "/nonexistent/path/file.txt"], h.io), EXIT.usage);
  assert.equal(h.calls.length, 0);
  assert.match(h.err[0]!, /cannot read/);
});

test("report list hits the global or agent-scoped path and renders", async () => {
  const h = harness(() => ({ status: 200, body: [rep] }));
  assert.equal(await run(["report", "list"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.path, "/v1/reports");
  assert.match(h.out[0]!, /r1/);
  assert.match(h.out[0]!, /text\/plain/);
  const h2 = harness(() => ({ status: 200, body: [rep] }));
  assert.equal(await run(["report", "list", "a1"], h2.io), EXIT.ok);
  assert.equal(h2.calls[0]!.path, "/v1/agents/a1/reports");
  const h3 = harness(() => ({ status: 200, body: [rep] }));
  assert.equal(await run(["report", "list", "--json"], h3.io), EXIT.ok);
  assert.deepEqual(JSON.parse(h3.out[0]!), [rep]);
  const empty = harness(() => ({ status: 200, body: [] }));
  assert.equal(await run(["report", "list"], empty.io), EXIT.ok);
  assert.equal(empty.out[0]!, "no reports");
});

test("report show dumps text content to stdout after metadata", async () => {
  const h = harness((c) => (c.path.includes("raw=1") ? { status: 200, body: Buffer.from("hello") } : { status: 200, body: rep }));
  assert.equal(await run(["report", "show", "a1", "r1"], h.io), EXIT.ok);
  assert.deepEqual(
    h.calls.map((c) => c.path),
    ["/v1/agents/a1/reports/r1", "/v1/agents/a1/reports/r1?raw=1"],
  );
  assert.equal(h.out[0], renderReport(rep));
  assert.equal(h.out[1], "hello");
});

test("report show strips terminal control sequences from metadata and content", async () => {
  const evil = { ...rep, name: "r\x1b[31m", mediaType: "text/plain" };
  const content = Buffer.from("hel\x1b]0;pwned\x07lo\x1b[2J");
  const h = harness((c) => (c.path.includes("raw=1") ? { status: 200, body: content } : { status: 200, body: evil }));
  assert.equal(await run(["report", "show", "a1", "r1"], h.io), EXIT.ok);
  assert.ok(!h.out[0]!.includes("\x1b"));
  assert.match(h.out[0]!, /name:       r/);
  assert.equal(h.out[1], "hello");
});

test("report show on binary media prints metadata and requires --out to save bytes", async () => {
  const bin = { ...rep, mediaType: "image/png" };
  const h = harness((c) => (c.path.includes("raw=1") ? { status: 200, body: Buffer.from([0, 1, 2, 255]) } : { status: 200, body: bin }));
  assert.equal(await run(["report", "show", "a1", "r1"], h.io), EXIT.ok);
  assert.equal(h.calls.length, 1);
  assert.equal(h.out[0], renderReport(bin));
  const dir = mkdtempSync(join(tmpdir(), "pomtree-report-"));
  const outFile = join(dir, "out.bin");
  const h2 = harness((c) => (c.path.includes("raw=1") ? { status: 200, body: Buffer.from([0, 1, 2, 255]) } : { status: 200, body: bin }));
  try {
    assert.equal(await run(["report", "show", "a1", "r1", "--out", outFile], h2.io), EXIT.ok);
    assert.deepEqual(readFileSync(outFile), Buffer.from([0, 1, 2, 255]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report show --json prints metadata and does not dump content", async () => {
  const h = harness((c) => (c.path.includes("raw=1") ? { status: 200, body: Buffer.from("hello") } : { status: 200, body: rep }));
  assert.equal(await run(["report", "show", "a1", "r1", "--json"], h.io), EXIT.ok);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(h.out[0]!), rep);
});

test("report rm deletes the report and maps failures to exit codes", async () => {
  const h = harness(() => ({ status: 204, body: null }));
  assert.equal(await run(["report", "rm", "a1", "r1"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.method, "DELETE");
  assert.equal(h.calls[0]!.path.split("?")[0], "/v1/agents/a1/reports/r1");
  assert.match(new URLSearchParams(h.calls[0]!.path.split("?")[1]!).get("key")!, /^[0-9a-f-]{36}$/);
  assert.match(h.out[0]!, /removed r1/);
  assert.equal(await run(["report", "rm", "a1", "r1"], harness(() => ({ status: 403, body: { error: "e" } })).io), EXIT.denied);
  assert.equal(await run(["report", "show", "a1", "r1"], harness(() => ({ status: 404, body: { error: "e" } })).io), EXIT.notFound);
});

test("report usage errors", async () => {
  for (const argv of [
    ["report"],
    ["report", "publish"],
    ["report", "show"],
    ["report", "show", "a1"],
    ["report", "rm"],
    ["report", "rm", "a1"],
    ["report", "bogus"],
  ]) {
    const h = harness(() => ({ status: 200, body: null }));
    assert.equal(await run(argv, h.io), EXIT.usage, argv.join(" "));
    assert.equal(h.calls.length, 0);
  }
});

const sched = { id: "s1", cron: "*/5 * * * *", tz: "UTC", task: "do work", missed: "skip", overlap: "skip", jitterMs: 0, createdAt: 0 };

test("sched ls GETs schedules and renders a table or JSON", async () => {
  const h = harness(() => ({ status: 200, body: [sched] }));
  assert.equal(await run(["sched", "ls"], h.io), EXIT.ok);
  assert.deepEqual(h.calls[0], { method: "GET", path: "/v1/schedules", body: undefined });
  assert.match(h.out[0]!, /^ID\s+CRON/);
  assert.match(h.out[0]!, /s1/);
  const hj = harness(() => ({ status: 200, body: [sched] }));
  assert.equal(await run(["sched", "ls", "--json"], hj.io), EXIT.ok);
  assert.deepEqual(JSON.parse(hj.out[0]!), [sched]);
  const empty = harness(() => ({ status: 200, body: [] }));
  assert.equal(await run(["sched", "ls"], empty.io), EXIT.ok);
  assert.equal(empty.out[0]!, "no schedules");
});

test("sched add PUTs the schedule with defaults", async () => {
  const h = harness(() => ({ status: 200, body: sched }));
  assert.equal(await run(["sched", "add", "s1", "*/5 * * * *", "do work"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.method, "PUT");
  assert.equal(h.calls[0]!.path, "/v1/schedules/s1");
  const { idempotencyKey, ...rest } = h.calls[0]!.body as { idempotencyKey: string };
  assert.match(idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.deepEqual(rest, { cron: "*/5 * * * *", task: "do work", missed: "skip", overlap: "skip", jitterMs: 0 });
  assert.match(h.out[0]!, /added s1/);
  const named = harness(() => ({ status: 200, body: sched }));
  await run(["sched", "add", "s1", "*/5 * * * *", "do work", "--key", "mine"], named.io);
  assert.equal((named.calls[0]!.body as { idempotencyKey: string }).idempotencyKey, "mine");
});

test("sched add forwards tz, missed, overlap and jitter", async () => {
  const h = harness(() => ({ status: 200, body: sched }));
  assert.equal(
    await run(["sched", "add", "s2", "0 9 * * 1", "task", "--tz", "America/New_York", "--missed", "run-one", "--overlap", "queue", "--jitter", "1500"], h.io),
    EXIT.ok,
  );
  assert.deepEqual(unkeyed(h.calls[0]!.body), { cron: "0 9 * * 1", tz: "America/New_York", task: "task", missed: "run-one", overlap: "queue", jitterMs: 1500 });
  const hj = harness(() => ({ status: 200, body: sched }));
  assert.equal(await run(["sched", "add", "s1", "* * * * *", "t", "--json"], hj.io), EXIT.ok);
  assert.deepEqual(JSON.parse(hj.out[0]!), sched);
});

test("sched add validates cron, policies and jitter before calling", async () => {
  const h = harness(() => ({ status: 200, body: sched }));
  assert.equal(await run(["sched", "add", "s1", "* * * *", "t"], h.io), EXIT.usage);
  assert.match(h.err[0]!, /cron needs 5 fields/);
  const badMissed = harness(() => ({ status: 200, body: sched }));
  assert.equal(await run(["sched", "add", "s1", "* * * * *", "t", "--missed", "nope"], badMissed.io), EXIT.usage);
  assert.match(badMissed.err[0]!, /--missed must be skip, run-one or catch-up/);
  const badOverlap = harness(() => ({ status: 200, body: sched }));
  assert.equal(await run(["sched", "add", "s1", "* * * * *", "t", "--overlap", "nope"], badOverlap.io), EXIT.usage);
  assert.match(badOverlap.err[0]!, /--overlap must be skip or queue/);
  assert.equal(await run(["sched", "add", "s1", "* * * * *", "t", "--jitter", "1.5"], harness(() => ({ status: 200, body: sched })).io), EXIT.usage);
  assert.equal(await run(["sched", "add", "s1", "* * * * *", "t", "--jitter", "-1"], harness(() => ({ status: 200, body: sched })).io), EXIT.usage);
  assert.equal(h.calls.length, 0);
  assert.equal(badMissed.calls.length, 0);
  assert.equal(badOverlap.calls.length, 0);
});

test("sched rm deletes and maps failures", async () => {
  const h = harness(() => ({ status: 200, body: { removed: true } }));
  assert.equal(await run(["sched", "rm", "s1"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.method, "DELETE");
  assert.equal(h.calls[0]!.path.split("?")[0], "/v1/schedules/s1");
  assert.match(new URLSearchParams(h.calls[0]!.path.split("?")[1]!).get("key")!, /^[0-9a-f-]{36}$/);
  assert.match(h.out[0]!, /removed s1/);
  const hj = harness(() => ({ status: 200, body: { removed: true } }));
  assert.equal(await run(["sched", "rm", "s1", "--json"], hj.io), EXIT.ok);
  assert.deepEqual(JSON.parse(hj.out[0]!), { removed: true });
  assert.equal(await run(["sched", "rm", "s1"], harness(() => ({ status: 404, body: { error: "e" } })).io), EXIT.notFound);
});

test("sched usage errors", async () => {
  for (const argv of [
    ["sched"],
    ["sched", "bogus"],
    ["sched", "add"],
    ["sched", "add", "s1"],
    ["sched", "add", "s1", "* * * * *"],
    ["sched", "rm"],
    ["sched", "pause"],
    ["sched", "resume"],
    ["sched", "add", "s1", "* * * * *", "t", "--jitter"],
  ]) {
    const h = harness(() => ({ status: 200, body: null }));
    assert.equal(await run(argv, h.io), EXIT.usage, argv.join(" "));
    assert.equal(h.calls.length, 0);
  }
});

const escalation = {
  id: "es-abc",
  agent: "a1",
  host: "h",
  generation: 1,
  question: "approve?",
  options: ["yes", "no"],
  state: "open",
  answer: null,
  answeredBy: null,
  createdAt: 0,
  answeredAt: null,
};

const withGeneration = async (value: string | undefined, fn: () => Promise<void>) => {
  const prev = process.env.POMTREE_AGENT_GENERATION;
  if (value === undefined) delete process.env.POMTREE_AGENT_GENERATION;
  else process.env.POMTREE_AGENT_GENERATION = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.POMTREE_AGENT_GENERATION;
    else process.env.POMTREE_AGENT_GENERATION = prev;
  }
};

test("ask raises an escalation and prints its id", async () => {
  await withGeneration("1", async () => {
    const h = harness(() => ({ status: 201, body: { escalation, delivered: true } }));
    assert.equal(await run(["ask", "approve?", "--options", "yes,no"], h.io), EXIT.ok);
    assert.equal(h.calls[0]!.method, "POST");
    assert.equal(h.calls[0]!.path, "/v1/agents/self/ask");
    const body = h.calls[0]!.body as { question: string; options: string[]; generation: number; idempotencyKey: string };
    assert.equal(body.question, "approve?");
    assert.deepEqual(body.options, ["yes", "no"]);
    assert.equal(body.generation, 1);
    assert.match(body.idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.deepEqual(h.out, ["es-abc"]);
  });
});

test("ask omits empty options, forwards --key and prints JSON", async () => {
  await withGeneration("0", async () => {
    const h = harness(() => ({ status: 201, body: { escalation, delivered: true } }));
    assert.equal(await run(["ask", "q?", "--key", "K", "--json"], h.io), EXIT.ok);
    const body = h.calls[0]!.body as { question: string; options?: string[]; generation: number; idempotencyKey: string };
    assert.deepEqual(body, { question: "q?", generation: 0, idempotencyKey: "K" });
    assert.ok(!("options" in body));
    assert.deepEqual(JSON.parse(h.out[0]!), escalation);
  });
});

test("ask warns to stderr when not delivered but still prints the id", async () => {
  await withGeneration("1", async () => {
    const h = harness(() => ({ status: 201, body: { escalation, delivered: false } }));
    assert.equal(await run(["ask", "approve?"], h.io), EXIT.ok);
    assert.deepEqual(h.out, ["es-abc"]);
    assert.match(h.err[0]!, /not delivered/);
  });
});

test("ask --wait polls until answered and prints the answer text", async () => {
  await withGeneration("1", async () => {
    const answered = { ...escalation, state: "answered", answer: "yes", answeredAt: 1 };
    const h = harness((c) => (c.method === "POST" ? { status: 201, body: { escalation, delivered: true } } : { status: 200, body: answered }));
    assert.equal(await run(["ask", "approve?", "--wait", "100"], h.io), EXIT.ok);
    assert.deepEqual(h.out, ["yes"]);
    assert.match(h.calls[1]!.path, /^\/v1\/agents\/self\/ask\/es-abc\?waitMs=100$/);
    assert.equal(h.calls[1]!.timeoutMs, 0);
  });
});

test("ask --wait --json prints the answered escalation", async () => {
  await withGeneration("1", async () => {
    const answered = { ...escalation, state: "answered", answer: "yes", answeredAt: 1 };
    const h = harness((c) => (c.method === "POST" ? { status: 201, body: { escalation, delivered: true } } : { status: 200, body: answered }));
    assert.equal(await run(["ask", "approve?", "--wait", "100", "--json"], h.io), EXIT.ok);
    assert.deepEqual(JSON.parse(h.out[0]!), answered);
  });
});

test("ask --wait times out with exit 7 and notes the escalation is still open", async () => {
  await withGeneration("1", async () => {
    const h = harness((c) => (c.method === "POST" ? { status: 201, body: { escalation, delivered: true } } : { status: 200, body: escalation }));
    assert.equal(await run(["ask", "approve?", "--wait", "1"], h.io), EXIT.timeout);
    assert.match(h.out[0]!, /es-abc still open/);
    assert.match(h.err[0]!, /late answer/);
    assert.ok(h.calls.some((c) => c.method === "GET"));
  });
});

test("ask usage and generation errors", async () => {
  await withGeneration("1", async () => {
    for (const argv of [["ask"], ["ask", "q", "--options"], ["ask", "q", "--wait", "soon"], ["ask", "q", "--wait", "-1"]]) {
      const h = harness(() => ({ status: 200, body: null }));
      assert.equal(await run(argv, h.io), EXIT.usage, argv.join(" "));
      assert.equal(h.calls.length, 0);
    }
  });
  await withGeneration(undefined, async () => {
    const h = harness(() => ({ status: 200, body: null }));
    assert.equal(await run(["ask", "q"], h.io), EXIT.usage);
    assert.match(h.err[0]!, /POMTREE_AGENT_GENERATION/);
    assert.equal(h.calls.length, 0);
  });
});

test("budget GETs and renders remaining against budget", async () => {
  const h = harness(() => ({ status: 200, body: { budgetMicros: 1000, remainingMicros: 250 } }));
  assert.equal(await run(["budget"], h.io), EXIT.ok);
  assert.deepEqual(h.calls[0], { method: "GET", path: "/v1/agents/self/budget", body: undefined });
  assert.deepEqual(h.out, ["budget: $0.00 (1000 µ$)\nremaining: $0.00 (250 µ$)"]);
  const hj = harness(() => ({ status: 200, body: { budgetMicros: 1000, remainingMicros: 250 } }));
  assert.equal(await run(["budget", "--json"], hj.io), EXIT.ok);
  assert.deepEqual(JSON.parse(hj.out[0]!), { budgetMicros: 1000, remainingMicros: 250 });
});

const checkpoint = {
  id: "cp1",
  agent: "a1",
  generation: 1,
  sessionRef: "s",
  workspace: "w1",
  node: "h",
  ingested: { ref: "refs/agents/a1/heads/agent/a1", commit: "c" },
  wait: { kind: "timer", at: 5 },
  remainingBudgetMicros: 10,
  imageDigest: "img",
  envManifestHash: null,
  createdAt: 0,
};

test("yield posts the parsed wait and derived key and prints the checkpoint id", async () => {
  const h = harness(() => ({ status: 201, body: checkpoint }));
  assert.equal(await run(["yield", "--until", "message"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.method, "POST");
  assert.equal(h.calls[0]!.path, "/v1/agents/self/yield");
  const body = h.calls[0]!.body as { wait: { kind: string }; idempotencyKey: string };
  assert.deepEqual(body.wait, { kind: "message" });
  assert.match(body.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.deepEqual(h.out, ["yielded cp1"]);
});

test("yield forwards --key, a child_exited wait and --json", async () => {
  const h = harness(() => ({ status: 201, body: checkpoint }));
  assert.equal(await run(["yield", "--until", "child_exited:all:a,b", "--key", "K", "--json"], h.io), EXIT.ok);
  assert.deepEqual(h.calls[0]!.body, { wait: { kind: "child_exited", children: ["a", "b"], mode: "all" }, idempotencyKey: "K" });
  assert.deepEqual(JSON.parse(h.out[0]!), checkpoint);
});

test("yield usage errors", async () => {
  for (const argv of [
    ["yield"],
    ["yield", "--until"],
    ["yield", "--until", "bogus"],
    ["yield", "--until", "timer:soon"],
    ["yield", "--until", "child_exited"],
  ]) {
    const h = harness(() => ({ status: 200, body: null }));
    assert.equal(await run(argv, h.io), EXIT.usage, argv.join(" "));
    assert.equal(h.calls.length, 0);
  }
});

test("resume posts and prints the resumed agent", async () => {
  const h = harness(() => ({ status: 200, body: { ...agent, state: "running" } }));
  assert.equal(await run(["resume", "a1"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.method, "POST");
  assert.equal(h.calls[0]!.path, "/v1/agents/a1/resume");
  assert.match((h.calls[0]!.body as { idempotencyKey: string }).idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.match(h.out[0]!, /resumed a1/);
  assert.equal(await run(["resume"], harness(() => ({ status: 200, body: null })).io), EXIT.usage);
});

test("show prints the latest checkpoint and includes it in JSON", async () => {
  const h = harness((c) =>
    c.path.includes("checkpoint")
      ? { status: 200, body: checkpoint }
      : c.path.includes("deadline")
        ? { status: 404, body: { error: "no deadline" } }
        : { status: 200, body: c.path.includes("events") ? [] : agent },
  );
  assert.equal(await run(["show", "a1"], h.io), EXIT.ok);
  assert.match(h.out[0]!, /checkpoint: cp1/);
  assert.match(h.out[0]!, /wait:       \{"kind":"timer","at":5\}/);
  assert.match(h.out[0]!, /ingested:   refs\/agents\/a1\/heads\/agent\/a1 c/);
  assert.match(h.out[0]!, /remaining:  \$0.00 \(10 µ\$\)/);
  assert.match(h.out[0]!, /image:      img/);
  const hj = harness((c) =>
    c.path.includes("checkpoint")
      ? { status: 200, body: checkpoint }
      : c.path.includes("deadline")
        ? { status: 404, body: { error: "no deadline" } }
        : { status: 200, body: c.path.includes("events") ? [] : agent },
  );
  assert.equal(await run(["show", "a1", "--json"], hj.io), EXIT.ok);
  assert.deepEqual(JSON.parse(hj.out[0]!).checkpoint, checkpoint);
});

test("show tolerates a missing checkpoint (404)", async () => {
  const h = harness((c) =>
    c.path.includes("checkpoint")
      ? { status: 404, body: { error: "no checkpoint" } }
      : c.path.includes("deadline")
        ? { status: 404, body: { error: "no deadline" } }
        : { status: 200, body: c.path.includes("events") ? [] : agent },
  );
  assert.equal(await run(["show", "a1"], h.io), EXIT.ok);
  assert.ok(!h.out[0]!.includes("checkpoint:"));
});

test("show prints the current session deadline and tolerates a missing deadline route", async () => {
  const dl = { deadlineAt: Date.now() + 3_600_000 };
  const show = (deadline: { deadlineAt: number | null } | null) =>
    harness((c) =>
      c.path.includes("checkpoint")
        ? { status: 404, body: { error: "no checkpoint" } }
        : c.path.includes("deadline")
          ? deadline
            ? { status: 200, body: deadline }
            : { status: 404, body: { error: "no deadline" } }
          : { status: 200, body: c.path.includes("events") ? [] : agent },
    );
  const h = show(dl);
  assert.equal(await run(["show", "a1"], h.io), EXIT.ok);
  assert.match(h.out[0]!, /deadline:\s+\S+ \(in \d+[smh]\)/);
  const hj = show(dl);
  assert.equal(await run(["show", "a1", "--json"], hj.io), EXIT.ok);
  assert.deepEqual(JSON.parse(hj.out[0]!).deadline, dl);
  const missing = show(null);
  assert.equal(await run(["show", "a1"], missing.io), EXIT.ok);
  assert.ok(!missing.out[0]!.includes("deadline:"));
});

test("extend posts a relative deadline with an idempotency key; omitting --deadline defers to the server", async () => {
  const h = harness(() => ({ status: 200, body: { deadlineAt: Date.now() + 1_800_000, previousDeadlineAt: Date.now() } }));
  assert.equal(await run(["extend", "a1", "--deadline", "30m", "--key", "k"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.method, "POST");
  assert.equal(h.calls[0]!.path, "/v1/agents/a1/deadline");
  assert.deepEqual(h.calls[0]!.body, { deadlineMs: 1_800_000, idempotencyKey: "k" });
  assert.match(h.out[0]!, /deadline extended to .+\(in \d+[smh]\)/);

  const d = harness(() => ({ status: 200, body: { deadlineAt: Date.now() + 1_800_000, previousDeadlineAt: null } }));
  assert.equal(await run(["extend", "a1", "--key", "k2"], d.io), EXIT.ok);
  assert.deepEqual(d.calls[0]!.body, { idempotencyKey: "k2" });
});

test("extend rejects zero and malformed deadlines; requires an agent id", async () => {
  for (const value of ["0", "0m", "bogus", "-5", "1.5"]) {
    const h = harness(() => ({ status: 200, body: {} }));
    assert.equal(await run(["extend", "a1", "--deadline", value], h.io), EXIT.usage, value);
    assert.equal(h.calls.length, 0);
    assert.match(h.err[0]!, /--deadline/);
  }
  const noid = harness(() => ({ status: 200, body: {} }));
  assert.equal(await run(["extend"], noid.io), EXIT.usage);
  assert.equal(noid.calls.length, 0);
});

test("send without --key issues a fresh key per invocation", async () => {
  const prev = process.env.POMTREE_AGENT_GENERATION;
  process.env.POMTREE_AGENT_GENERATION = "1";
  try {
    const h = harness(() => ({ status: 201, body: { kind: "message" } }));
    assert.equal(await run(["send", "p2", "same"], h.io), EXIT.ok);
    assert.equal(await run(["send", "p2", "same"], h.io), EXIT.ok);
    const keys = h.calls.map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    assert.notEqual(keys[0], keys[1]); // two intentional identical messages are not deduplicated
    assert.match(keys[0]!, /^[0-9a-f-]{36}$/);
  } finally {
    if (prev === undefined) delete process.env.POMTREE_AGENT_GENERATION;
    else process.env.POMTREE_AGENT_GENERATION = prev;
  }
});

test("--help after the command word is not a help request", async () => {
  const h = harness(() => ({ status: 200, body: null }));
  assert.equal(await run(["send", "p2", "--help"], h.io), EXIT.usage);
  assert.equal(h.calls.length, 0);
  assert.ok(!h.out.some((s) => s.startsWith("usage: pomtree")));
  assert.match(h.err[0]!, /send needs a message body/);
});

test("-- terminates flag parsing so a body may start with dashes", async () => {
  const prev = process.env.POMTREE_AGENT_GENERATION;
  process.env.POMTREE_AGENT_GENERATION = "1";
  try {
    const h = harness(() => ({ status: 201, body: { kind: "message" } }));
    assert.equal(await run(["send", "p2", "--", "--help", "-h"], h.io), EXIT.ok);
    const body = h.calls[0]!.body as { body: string; generation: number };
    assert.equal(body.body, "--help -h");
    assert.equal(body.generation, 1);
  } finally {
    if (prev === undefined) delete process.env.POMTREE_AGENT_GENERATION;
    else process.env.POMTREE_AGENT_GENERATION = prev;
  }
});

test("logs --from must be a non-negative integer", async () => {
  const h = harness(() => ({ status: 200, body: [] }));
  assert.equal(await run(["logs", "a1", "--from", "soon"], h.io), EXIT.usage);
  assert.equal(h.calls.length, 0);
  assert.match(h.err[0]!, /--from must be a non-negative integer/);
});

test("top --interval 0 is rejected in live mode to avoid a busy loop", async () => {
  const live = harness(() => ({ status: 200, body: [topRow] }), { isTTY: true });
  assert.equal(await run(["top", "--interval", "0"], live.io), EXIT.usage);
  assert.equal(live.calls.length, 0);
  const once = harness(() => ({ status: 200, body: [topRow] }));
  assert.equal(await run(["top", "--once", "--interval", "0"], once.io), EXIT.ok); // --once ignores the interval
});

test("errors are JSON when --json is requested", async () => {
  const h = harness(() => ({ status: 404, body: { error: "no such agent: x" } }));
  assert.equal(await run(["show", "x", "--json"], h.io), EXIT.notFound);
  assert.deepEqual(JSON.parse(h.out[0]!), { error: "no such agent: x" });
  assert.equal(h.err.length, 0);

  const u = harness(() => ({ status: 200, body: null }));
  assert.equal(await run(["bogus", "--json"], u.io), EXIT.usage);
  assert.deepEqual(JSON.parse(u.out[0]!), { error: "unknown command: bogus" });
  assert.equal(u.err.length, 0);
});

test("tree fetches the operator tree and renders it (or JSON)", async () => {
  const h = harness(() => ({ status: 200, body: [topRow] }));
  assert.equal(await run(["tree"], h.io), EXIT.ok);
  assert.deepEqual(
    h.calls.map((c) => `${c.method} ${c.path}`),
    ["GET /v1/tree", "GET /v1/summary"],
  );
  assert.match(h.out[0]!, /^AGENT\s+ID\s+STATE/);
  const hj = harness(() => ({ status: 200, body: [topRow] }));
  assert.equal(await run(["tree", "--json"], hj.io), EXIT.ok);
  assert.deepEqual(JSON.parse(hj.out[0]!), [topRow]);
});

test("spawn forwards --fork, --from-commit and --session", async () => {
  const h = harness(() => ({ status: 201, body: agent }));
  assert.equal(await run(["spawn", "--task", "t", "--fork", "--from-commit", "abc", "--session", "s1", "--key", "k"], h.io), EXIT.ok);
  const body = h.calls[0]!.body as Record<string, unknown>;
  assert.equal(body.fork, true);
  assert.equal(body.fromCommit, "abc");
  assert.equal(body.sessionRef, "s1");
  assert.equal(body.idempotencyKey, "k");
});

test("result, reap, cancel, kill, resume, sched rm and report rm send idempotency keys", async () => {
  const result = harness(() => ({ status: 200, body: agent }));
  assert.equal(await run(["result", "--key", "rk"], result.io), EXIT.ok);
  assert.deepEqual(result.calls[0]!.body, { status: "succeeded", result: null, idempotencyKey: "rk" });

  const reap = harness(() => ({ status: 200, body: { record: { ...agent, state: "reaped" }, unusedMicros: 1 } }));
  assert.equal(await run(["reap", "a1"], reap.io), EXIT.ok);
  assert.match((reap.calls[0]!.body as { idempotencyKey: string }).idempotencyKey, /^[0-9a-f-]{36}$/);

  const cancel = harness(() => ({ status: 202, body: { accepted: true } }));
  assert.equal(await run(["cancel", "a1", "--grace", "10", "--key", "ck"], cancel.io), EXIT.ok);
  assert.deepEqual(cancel.calls[0]!.body, { graceMs: 10, idempotencyKey: "ck" });

  const kill = harness(() => ({ status: 202, body: { accepted: true } }));
  assert.equal(await run(["kill", "a1"], kill.io), EXIT.ok);
  assert.match((kill.calls[0]!.body as { idempotencyKey: string }).idempotencyKey, /^[0-9a-f-]{36}$/);

  const resume = harness(() => ({ status: 200, body: { ...agent, state: "running" } }));
  assert.equal(await run(["resume", "a1", "--key", "rk2"], resume.io), EXIT.ok);
  assert.deepEqual(resume.calls[0]!.body, { idempotencyKey: "rk2" });

  const schedRm = harness(() => ({ status: 200, body: { removed: true } }));
  assert.equal(await run(["sched", "rm", "s1"], schedRm.io), EXIT.ok);
  assert.match(new URLSearchParams(schedRm.calls[0]!.path.split("?")[1]!).get("key")!, /^[0-9a-f-]{36}$/);

  const reportRm = harness(() => ({ status: 200, body: { removed: "r1" } }));
  assert.equal(await run(["report", "rm", "a1", "r1", "--key", "rk3"], reportRm.io), EXIT.ok);
  assert.equal(new URLSearchParams(reportRm.calls[0]!.path.split("?")[1]!).get("key"), "rk3");
});

test("resume --force sends force; drain sends an absolute deadline; whoami reads self", async () => {
  const h = harness((c) => ({ status: 200, body: c.path === "/v1/drain" ? { draining: true } : agent }));
  h.io.now = () => 1000;
  assert.equal(await run(["resume", "a1", "--force"], h.io), EXIT.ok);
  assert.equal(await run(["resume", "a1"], h.io), EXIT.ok);
  assert.equal(await run(["drain", "--deadline", "500"], h.io), EXIT.ok);
  assert.equal(await run(["whoami"], h.io), EXIT.ok);
  assert.equal((h.calls[0]!.body as any).force, true);
  assert.equal((h.calls[1]!.body as any).force, undefined);
  assert.equal(h.calls[2]!.path, "/v1/drain");
  assert.equal((h.calls[2]!.body as any).deadline, 1500);
  assert.equal(h.calls[3]!.path, "/v1/agents/self");
});

test("result retries an unreachable daemon with backoff, reusing one key", async () => {
  let n = 0;
  const h = harness(() => {
    if (++n < 3) throw new TransportError("down");
    return { status: 200, body: agent };
  });
  const sleeps: number[] = [];
  h.io.sleep = async (ms: number) => void sleeps.push(ms);
  assert.equal(await run(["result", "{}"], h.io), EXIT.ok);
  assert.deepEqual(sleeps, [500, 1000]);
  assert.equal(new Set(h.calls.map((c) => (c.body as any).idempotencyKey)).size, 1);
  const dead = harness(() => {
    throw new TransportError("down");
  });
  dead.io.sleep = async () => {};
  assert.equal(await run(["result", "{}"], dead.io), EXIT.unreachable);
  assert.equal(dead.calls.length, 6);
});

test("sched pause|resume POST the keyed transition and map failures", async () => {
  for (const [verb, word] of [
    ["pause", "paused"],
    ["resume", "resumed"],
  ] as const) {
    const h = harness(() => ({ status: 200, body: sched }));
    assert.equal(await run(["sched", verb, "s1", "--key", "k9"], h.io), EXIT.ok);
    assert.deepEqual(h.calls[0], { method: "POST", path: `/v1/schedules/s1/${verb}`, body: { idempotencyKey: "k9" } });
    assert.match(h.out[0]!, new RegExp(`${word} s1`));
    const auto = harness(() => ({ status: 200, body: sched }));
    await run(["sched", verb, "s1"], auto.io);
    assert.match((auto.calls[0]!.body as { idempotencyKey: string }).idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.equal(await run(["sched", verb, "nope"], harness(() => ({ status: 404, body: { error: "e" } })).io), EXIT.notFound);
  }
});

const summary = {
  agentsByState: { running: 2, exited: 1 },
  totalSpendMicros: 1_500_000,
  openEscalations: 3,
  hosts: { host: "h", maxConcurrent: 4, running: ["a"], queue: [] },
};
const route =
  (m: Record<string, unknown>) =>
  (c: Call): Reply =>
    c.path in m ? { status: 200, body: m[c.path] } : { status: 404, body: { error: "nope" } };

test("tree/ps/top print a totals footer; --json and a failing summary stay clean", async () => {
  const h = harness(route({ "/v1/tree": [topRow], "/v1/agents": [agent], "/v1/summary": summary }));
  assert.equal(await run(["tree"], h.io), EXIT.ok);
  assert.equal(h.out.at(-1), "agents: 2 running, 1 exited | spend: $1.5000 | escalations: 3 open");
  const ps = harness(route({ "/v1/agents": [agent], "/v1/summary": summary }));
  await run(["ps"], ps.io);
  assert.match(ps.out.at(-1)!, /spend: \$1\.5000/);
  const j = harness(route({ "/v1/tree": [topRow], "/v1/summary": summary }));
  await run(["tree", "--json"], j.io);
  assert.equal(j.out.length, 1);
  assert.deepEqual(
    j.calls.map((c) => c.path),
    ["/v1/tree"],
  );
  const bad = harness(route({ "/v1/tree": [topRow] }));
  assert.equal(await run(["tree"], bad.io), EXIT.ok);
  assert.equal(bad.out.length, 1);
});

test("spend prints the summary", async () => {
  const h = harness(route({ "/v1/summary": summary }));
  assert.equal(await run(["spend"], h.io), EXIT.ok);
  assert.match(h.out[0]!, /spend: \$1\.5000/);
  assert.match(h.out[0]!, /running 1\/4/);
});

test("show prints the budget in dollars", async () => {
  const h = harness((c) =>
    c.path.includes("checkpoint")
      ? { status: 404, body: { error: "x" } }
      : c.path.includes("deadline")
        ? { status: 404, body: { error: "no deadline" } }
        : { status: 200, body: c.path.includes("events") ? [] : agent },
  );
  await run(["show", "a1"], h.io);
  assert.match(h.out[0]!, /budget:     \$0\.00 \(/);
});

test("doctor prints ok, or FAIL with the reason and exits 1", async () => {
  const good = harness(route({ "/v1/doctor": { ok: true, host: "h", agents: { running: 2 }, sandboxes: 1, live: 2 } }));
  assert.equal(await run(["doctor"], good.io), EXIT.ok);
  assert.equal(good.out[0]!.split("\n")[0], "ok");
  assert.match(good.out[0]!, /agents:     2 running/);
  const bad = harness(route({ "/v1/doctor": { ok: false, host: "h", agents: {}, sandboxes: 0, live: 0, sandboxUp: false, journalFailed: true } }));
  assert.equal(await run(["doctor"], bad.io), EXIT.error);
  assert.equal(bad.out[0]!.split("\n")[0], "FAIL: sandbox unavailable; journal writes failing");
});

test("doctor prints the daemon's build identity when the daemon reports one", async () => {
  const h = harness(route({ "/v1/doctor": { ok: true, host: "h", agents: {}, sandboxes: 0, live: 0, version: "v0.1.0* (abc1234)" } }));
  assert.equal(await run(["doctor"], h.io), EXIT.ok);
  assert.deepEqual(h.out[0]!.split("\n").slice(0, 4), ["ok", "  host:       h", "  pomtree:       0.0.0-test", "  pomtreed:      v0.1.0* (abc1234)"]);
  // A daemon that does not report one prints no version line.
  const old = harness(route({ "/v1/doctor": { ok: true, host: "h", agents: {}, sandboxes: 0, live: 0 } }));
  await run(["doctor"], old.io);
  assert.doesNotMatch(old.out[0]!, /pomtreed:/);
});

test("doctor prints the client's build identity before the daemon's, whether or not the daemon reports one", async () => {
  const both = harness(route({ "/v1/doctor": { ok: true, host: "h", agents: {}, sandboxes: 0, live: 0, version: "v0.1.0* (abc1234)" } }));
  both.io.version = "v0.1.0 (def5678)";
  assert.equal(await run(["doctor"], both.io), EXIT.ok);
  const lines = both.out[0]!.split("\n");
  assert.equal(lines[2], "  pomtree:       v0.1.0 (def5678)");
  assert.equal(lines[3], "  pomtreed:      v0.1.0* (abc1234)");
  const old = harness(route({ "/v1/doctor": { ok: true, host: "h", agents: {}, sandboxes: 0, live: 0 } }));
  old.io.version = "v0.1.0 (def5678)";
  await run(["doctor"], old.io);
  assert.equal(old.out[0]!.split("\n")[2], "  pomtree:       v0.1.0 (def5678)");
  assert.doesNotMatch(old.out[0]!, /pomtreed:/);
});

test("doctor prints the max-sessions line with its mode, and none when the daemon reports no capacity", async () => {
  for (const [mode, value] of [
    ["auto", 7],
    ["manual", 3],
  ] as const) {
    const h = harness(route({ "/v1/doctor": { ok: true, host: "h", agents: {}, sandboxes: 0, live: 0, maxSessions: { value, mode } } }));
    assert.equal(await run(["doctor"], h.io), EXIT.ok);
    assert.ok(h.out[0]!.split("\n").includes(`  max sessions: ${value} (${mode})`), h.out[0]);
  }
  const none = harness(route({ "/v1/doctor": { ok: true, host: "h", agents: {}, sandboxes: 0, live: 0 } }));
  await run(["doctor"], none.io);
  assert.doesNotMatch(none.out[0]!, /max sessions/);
});

test("doctor warns loudly (but stays ok) on a client/server revision mismatch", async () => {
  const h = harness(
    route({ "/v1/doctor": { ok: true, host: "h", agents: {}, sandboxes: 0, live: 0, gitSha: "abc1234", imageRevision: "def5678", revisionMismatch: true } }),
  );
  assert.equal(await run(["doctor"], h.io), EXIT.ok);
  const lines = h.out[0]!.split("\n");
  assert.equal(lines[0], "WARNING: client/server revision mismatch: pomtreed git abc1234 vs agent image def5678 (run scripts/pomtree-up --rebuild)");
  assert.equal(lines[1], "ok");
});

test("escalations ls and answer (with key)", async () => {
  const esc = {
    id: "e1",
    agent: "a1",
    host: "h",
    generation: 1,
    question: "ship it?",
    options: [],
    state: "open",
    answer: null,
    answeredBy: null,
    createdAt: Date.now(),
    answeredAt: null,
  };
  const h = harness((c) => (c.method === "POST" ? { status: 201, body: { ...esc, state: "answered" } } : { status: 200, body: [esc] }));
  assert.equal(await run(["escalations", "ls", "--state", "open", "--agent", "a1"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.path, "/v1/escalations?state=open&agent=a1");
  assert.match(h.out[0]!, /e1\s+a1\s+open.*ship it\?/);
  assert.equal(await run(["escalations", "answer", "e1", "yes", "please", "--key", "K"], h.io), EXIT.ok);
  assert.deepEqual(h.calls[1], { method: "POST", path: "/v1/escalations/e1/answer", body: { body: "yes please", idempotencyKey: "K" } });
  assert.equal(await run(["escalations", "answer", "e1"], h.io), EXIT.usage);
  assert.equal(await run(["escalations"], h.io), EXIT.usage);
});

test("colour: only on a TTY, off with --no-color or NO_COLOR", async () => {
  const on = harness(route({ "/v1/tree": [topRow], "/v1/summary": summary }), { isTTY: true });
  await run(["top", "--once"], on.io);
  assert.ok(on.out[0]!.includes("\x1b["));
  const flag = harness(route({ "/v1/tree": [topRow], "/v1/summary": summary }), { isTTY: true });
  await run(["top", "--once", "--no-color"], flag.io);
  assert.ok(!flag.out[0]!.includes("\x1b["));
  const env = harness(route({ "/v1/tree": [topRow], "/v1/summary": summary }), { isTTY: true });
  env.io.env = { NO_COLOR: "1" };
  await run(["tree"], env.io);
  assert.ok(!env.out[0]!.includes("\x1b["));
});

test("usage errors print only the command's usage; failures carry hints", async () => {
  const h = harness(() => ({ status: 200, body: {} }));
  assert.equal(await run(["wait"], h.io), EXIT.usage);
  const e = h.err.join("\n");
  assert.match(e, /usage: pomtree wait ID/);
  assert.match(e, /pomtree --help/);
  assert.ok(!e.includes("spawn --task"));
  const u = harness(() => ({ status: 401, body: { error: "missing or invalid token" } }));
  assert.equal(await run(["ps"], u.io), EXIT.denied);
  assert.match(u.err.join("\n"), /missing or invalid token\nhint: token missing\/invalid: check POMTREED_STATE_DIR and operator\.token/);
  const down = harness(() => {
    throw new TransportError("cannot reach pomtreed at /s: ECONNREFUSED");
  });
  down.io.env = { POMTREED_STATE_DIR: "/x" };
  assert.equal(await run(["ps"], down.io), EXIT.unreachable);
  assert.match(down.err.join("\n"), /is pomtreed running\? POMTREED_STATE_DIR=\/x/);
});

test("report --out surfaces the server's error message instead of HTTP n", async () => {
  const h = harness((c) =>
    c.raw
      ? { status: 404, body: Buffer.from(JSON.stringify({ error: "no such report" })) }
      : { status: 200, body: { id: "r", mediaType: "text/plain", agent: "a1", name: "n", sizeBytes: 1, createdAt: 0 } },
  );
  assert.equal(await run(["report", "show", "a1", "r", "--out", join(tmpdir(), "nope-out")], h.io), EXIT.notFound);
  assert.match(h.err.join("\n"), /no such report/);
});

test("logs --transcript prints one human line per entry; --json stays raw", async () => {
  const t = {
    entries: [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello\nworld" }] } }, { type: "compaction" }],
    skipped: 0,
    total: 2,
    commit: "c",
  };
  const h = harness(() => ({ status: 200, body: t }));
  assert.equal(await run(["logs", "a1", "--transcript"], h.io), EXIT.ok);
  assert.deepEqual(h.out, ["message(assistant) hello world", "compaction"]);
  const j = harness(() => ({ status: 200, body: t }));
  await run(["logs", "a1", "--transcript", "--json"], j.io);
  assert.deepEqual(JSON.parse(j.out[0]!), t);
});

test("spawn --model splits provider/id (id may contain slashes) and rejects malformed values", async () => {
  const h = harness(() => ({ status: 201, body: agent }));
  assert.equal(await run(["spawn", "--task", "t", "--model", "baseten/zai-org/GLM-5", "--key", "k"], h.io), EXIT.ok);
  assert.deepEqual((h.calls[0]!.body as { model: unknown }).model, { provider: "baseten", id: "zai-org/GLM-5" });
  const bad = harness(() => ({ status: 201, body: agent }));
  assert.notEqual(await run(["spawn", "--task", "t", "--model", "nope"], bad.io), EXIT.ok);
  assert.equal(bad.calls.length, 0);
});

test("models lists with the default marked and notes a fallback source", async () => {
  const h = harness(() => ({
    status: 200,
    body: {
      models: [
        { provider: "p", id: "a", default: true },
        { provider: "p", id: "b" },
      ],
      source: "pi",
    },
  }));
  assert.equal(await run(["models"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.path, "/v1/models");
  assert.deepEqual(h.out, ["* p/a\n  p/b"]);
  const e = harness(() => ({ status: 200, body: { models: [], source: "none", reason: "no pi" } }));
  await run(["models"], e.io);
  assert.match(e.out[0]!, /source: none.*no pi/);
});

test("peers renders the real daemon shape {id,name,state} without crashing", async () => {
  const h = harness(() => ({
    status: 200,
    body: [
      { id: "p2", name: "bob", state: "running" },
      { id: "p3", name: "amy" },
    ],
  }));
  assert.equal(await run(["peers"], h.io), EXIT.ok);
  assert.match(h.out[0]!, /bob\s+running/);
});

test("list commands tolerate ragged rows (missing fields) without a TypeError", async () => {
  for (const [argv, body] of [
    [["ps"], [{ id: "x" }]],
    [["escalations", "ls"], [{ id: "e" }]],
    [["template", "ls"], [{ id: "t" }]],
    [["report", "list"], [{ id: "r" }]],
    [["tree"], [{ id: "x" }]],
  ] as [string[], unknown][]) {
    const h = harness(() => ({ status: 200, body }));
    const code = await run(argv, h.io);
    assert.ok(!h.err.some((e) => /internal error/.test(e)), `${argv.join(" ")}: ${h.err.join("|")}`);
    assert.ok(code === EXIT.ok || code === EXIT.usage, argv.join(" "));
  }
});

test("unexpected exceptions print one internal-error line, not a stack", async () => {
  const h = harness(() => {
    throw new TypeError("boom");
  });
  assert.equal(await run(["peers"], h.io), 1);
  assert.deepEqual(h.err, ["pomtree: internal error: boom"]);
});

test("operator-only 403 tells agents what they can use", async () => {
  const h = harness(() => ({ status: 403, body: { error: "operator scope required" } }));
  await run(["ps"], h.io);
  assert.match(h.err[0]!, /operator scope required \(this command is for the host operator; agents can use: .*peers/);
});

test("operator send --interrupt posts mode interrupt and shows how it was delivered", async () => {
  await withGeneration(undefined, async () => {
    const h = harness(() => ({ status: 201, body: { kind: "human_message", mode: "interrupt", delivered: "woke" } }));
    assert.equal(await run(["send", "a1", "stop", "now", "--interrupt", "--key", "k"], h.io), EXIT.ok);
    assert.equal(h.calls[0]!.path, "/v1/agents/a1/message");
    assert.deepEqual(h.calls[0]!.body, { body: "stop now", mode: "interrupt", idempotencyKey: "k" });
    assert.match(h.out[0]!, /woke/);
  });
});

test("agent send --interrupt is forwarded so the daemon can refuse it (403 -> denied)", async () => {
  await withGeneration("2", async () => {
    const h = harness(() => ({ status: 403, body: { error: "only the operator may interrupt an agent" } }));
    assert.equal(await run(["send", "p2", "x", "--interrupt"], h.io), EXIT.denied);
    assert.equal((h.calls[0]!.body as { interrupt?: boolean }).interrupt, true);
  });
});

test("an agent's long wait parks under the hood with one key; short waits and operators long-poll", async () => {
  await withGeneration("1", async () => {
    const h = harness(() => ({ status: 201, body: { parked: true, checkpoint: { id: "cp1" } } }));
    assert.equal(await run(["wait", "c1", "--timeout", "60000"], h.io), EXIT.ok);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.path, "/v1/agents/self/park");
    const b = h.calls[0]!.body as { on: unknown; timeoutMs: number; idempotencyKey: string };
    assert.deepEqual(b.on, { kind: "child", child: "c1" });
    assert.equal(b.timeoutMs, 60000);
    assert.match(b.idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.match(h.out[0]!, /yielded/);

    const hi = harness(() => ({ status: 201, body: { parked: true } }));
    assert.equal(await run(["inbox", "--wait", "90000"], hi.io), EXIT.ok);
    assert.deepEqual((hi.calls[0]!.body as { on: unknown }).on, { kind: "inbox" });

    // not parked (daemon says the wait is already satisfied): falls back to the blocking long-poll
    const hn = harness((c) => (c.method === "POST" ? { status: 201, body: { parked: false } } : { status: 200, body: { done: true, record: agent } }));
    assert.equal(await run(["wait", "c1", "--timeout", "60000"], hn.io), EXIT.ok);
    assert.equal(hn.calls[1]!.path, "/v1/agents/c1/wait?timeoutMs=60000");

    const hs = harness(() => ({ status: 200, body: { done: true, record: agent } }));
    assert.equal(await run(["wait", "c1", "--timeout", "5000"], hs.io), EXIT.ok);
    assert.equal(hs.calls.length, 1);
    assert.match(hs.calls[0]!.path, /^\/v1\/agents\/c1\/wait/);
  });
  await withGeneration(undefined, async () => {
    const h = harness(() => ({ status: 200, body: { done: true, record: agent } }));
    assert.equal(await run(["wait", "c1", "--timeout", "60000"], h.io), EXIT.ok);
    assert.match(h.calls[0]!.path, /^\/v1\/agents\/c1\/wait/);
  });
});

test("ask --wait over the threshold parks on the escalation", async () => {
  await withGeneration("1", async () => {
    const h = harness((c) => (c.path.endsWith("/park") ? { status: 201, body: { parked: true } } : { status: 201, body: { escalation, delivered: true } }));
    assert.equal(await run(["ask", "approve?", "--wait", "60000"], h.io), EXIT.ok);
    assert.equal(h.calls[1]!.path, "/v1/agents/self/park");
    assert.deepEqual((h.calls[1]!.body as { on: unknown }).on, { kind: "ask", escalation: "es-abc" });
  });
});

test("a bare 'forbidden' 403 also gets the agent-commands hint", async () => {
  const h = harness(() => ({ status: 403, body: { error: "forbidden" } }));
  await run(["tree"], h.io);
  assert.match(h.err[0]!, /forbidden \(this command is for the host operator; agents can use: .*peers/);
});

test("agent help hides operator-only spawn flags; operator help keeps them", async () => {
  const prev = process.env.POMTREE_AGENT_GENERATION;
  try {
    delete process.env.POMTREE_AGENT_GENERATION;
    const a = harness(() => ({ status: 200, body: {} }));
    await run(["--help"], a.io);
    assert.match(a.out.join("\n"), /--from-commit/);
    process.env.POMTREE_AGENT_GENERATION = "1";
    const b = harness(() => ({ status: 200, body: {} }));
    await run(["--help"], b.io);
    assert.doesNotMatch(b.out.join("\n"), /--from-commit|--session S/);
    assert.match(b.out.join("\n"), /spawn --task T/);
  } finally {
    if (prev === undefined) delete process.env.POMTREE_AGENT_GENERATION;
    else process.env.POMTREE_AGENT_GENERATION = prev;
  }
});

test("spawn --budget accepts $dollars and raw micros; small budgets warn on stderr; junk is a usage error", async () => {
  const h = harness(() => ({ status: 201, body: agent }));
  assert.equal(await run(["spawn", "--task", "t", "--budget", "$5", "--key", "k"], h.io), EXIT.ok);
  assert.equal((h.calls[0]!.body as { budgetMicros: number }).budgetMicros, 5_000_000);
  assert.equal(h.err.length, 0);
  const h2 = harness(() => ({ status: 201, body: agent }));
  assert.equal(await run(["spawn", "--task", "t", "--budget", "$0.10", "--key", "k"], h2.io), EXIT.ok);
  assert.equal((h2.calls[0]!.body as { budgetMicros: number }).budgetMicros, 100_000);
  assert.match(h2.err.join("\n"), /budget \$0\.10 is small for non-trivial work; children are stopped immediately when they exceed it/);
  for (const bad of ["$", "$-1", "$0", "0", "abc", "$1x"]) {
    assert.equal(await run(["spawn", "--task", "t", "--budget", bad], harness(() => ({ status: 201, body: agent })).io), EXIT.usage, bad);
  }
});

test("formatMoney prints dollars alongside micros", async () => {
  const { formatMoney, parseBudgetFlag } = await import("./ux.ts");
  assert.equal(formatMoney(993_706), "$0.99 (993706 µ$)");
  assert.equal(parseBudgetFlag("$.5"), 500_000);
  assert.equal(parseBudgetFlag(undefined), undefined);
});

test("trace prints the daemon's markdown (control chars stripped) with flags mapped to the query", async () => {
  const md = "# Trace: w (a1)\n\x1b[31mred\x1b[0m\n";
  const h = harness(() => ({ status: 200, body: Buffer.from(md) }));
  assert.equal(await run(["trace", "a1", "--children", "--short", "--raw"], h.io), EXIT.ok);
  assert.deepEqual(h.calls[0], { method: "GET", path: "/v1/agents/a1/trace?format=md&short=1&include=children&raw=1", raw: true });
  assert.deepEqual(h.out, ["# Trace: w (a1)\nred"]);
  const d = harness(() => ({ status: 200, body: Buffer.from("x") }));
  await run(["trace", "a1"], d.io);
  assert.equal(d.calls[0]!.path, "/v1/agents/a1/trace?format=md");
});

test("trace --out writes the file; --json asks for json; errors map to exit codes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pomtree-trace-"));
  try {
    const f = join(dir, "t.md");
    const h = harness(() => ({ status: 200, body: Buffer.from("# T\n") }));
    assert.equal(await run(["trace", "a1", "--out", f], h.io), EXIT.ok);
    assert.equal(readFileSync(f, "utf8"), "# T\n");
    assert.deepEqual(h.out, [`wrote 4 bytes to ${f}`]);
    const j = harness(() => ({ status: 200, body: { markdown: "# T", events: 1 } }));
    assert.equal(await run(["trace", "a1", "--json"], j.io), EXIT.ok);
    assert.equal(j.calls[0]!.path, "/v1/agents/a1/trace?format=json");
    assert.deepEqual(JSON.parse(j.out[0]!), { markdown: "# T", events: 1 });
    const nf = harness(() => ({ status: 404, body: Buffer.from(JSON.stringify({ error: "no such agent: zz" })) }));
    assert.equal(await run(["trace", "zz"], nf.io), EXIT.notFound);
    const forbidden = harness(() => ({ status: 403, body: Buffer.from(JSON.stringify({ error: "operator scope required" })) }));
    assert.equal(await run(["trace", "a1"], forbidden.io), EXIT.denied);
    assert.equal(await run(["trace"], harness(() => ({ status: 200, body: Buffer.from("") })).io), EXIT.usage);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ps shows a WHY column for queued agents, and show prints the pending reason", async () => {
  const pend = { ...agent, id: "p1", state: "pending", exit: null, pendingReason: "waiting for a session slot (4 of 4 in use)" };
  const h = harness(() => ({ status: 200, body: [pend] }));
  assert.equal(await run(["ps"], h.io), EXIT.ok);
  assert.match(h.out[0]!, /WHY/);
  assert.match(h.out[0]!, /queued \u2014 waiting for a session slot \(4 of 4 in use\)/);
  const plain = harness(() => ({ status: 200, body: [agent] }));
  await run(["ps"], plain.io);
  assert.doesNotMatch(plain.out[0]!, /WHY/);
});

test("ps and show surface a waiting agent (state stays running); the summary line counts waiting", async () => {
  const w = { ...agent, id: "w1", state: "running", exit: null, waitingSince: Date.now() - 5 * 60_000 };
  const h = harness(() => ({ status: 200, body: [w] }));
  assert.equal(await run(["ps"], h.io), EXIT.ok);
  assert.match(h.out[0]!, /WHY/);
  assert.match(h.out[0]!, /running.*waiting 5m/);
  const s = harness((c) => ({ status: c.path.endsWith("/w1") ? 200 : c.path.includes("/events") ? 200 : 404, body: c.path.endsWith("/w1") ? w : [] }));
  await run(["show", "w1"], s.io);
  assert.match(s.out[0]!, /waiting:\s+5m/);
  const { renderSummaryLine } = await import("./ux.ts");
  assert.match(renderSummaryLine({ agentsByState: { running: 3 }, waiting: 2, totalSpendMicros: 0, openEscalations: 0 }), /3 running \(2 waiting\)/);
});

test("result --summary / --summary-file merge into the JSON; a missing-summary rejection exits non-zero with the daemon's message", async () => {
  const h = harness(() => ({ status: 200, body: agent }));
  assert.equal(await run(["result", "--summary", "did it", '{"files":["a"]}'], h.io), EXIT.ok);
  assert.deepEqual((h.calls[0]!.body as { result: unknown }).result, { files: ["a"], summary: "did it" });
  const dir = mkdtempSync(join(tmpdir(), "pomtree-sum-"));
  const f = join(dir, "h.md");
  writeFileSync(f, "from file\nline 2");
  const h2 = harness(() => ({ status: 200, body: agent }));
  assert.equal(await run(["result", "--status", "failed", "--summary-file", f], h2.io), EXIT.ok);
  assert.deepEqual((h2.calls[0]!.body as { result: unknown }).result, { summary: "from file\nline 2" });
  assert.equal(await run(["result", "--summary", "a", "--summary-file", f], harness(() => ({ status: 200, body: agent })).io), EXIT.usage);
  assert.equal(await run(["result", "--summary-file", join(dir, "nope")], harness(() => ({ status: 200, body: agent })).io), EXIT.usage);
  rmSync(dir, { recursive: true });
  const msg = 'A handoff is required: pass --summary "what you did"';
  const bad = harness(() => ({ status: 400, body: { error: msg } }));
  assert.notEqual(await run(["result"], bad.io), EXIT.ok);
  assert.ok(bad.err.join("\n").includes(msg), bad.err.join("\n"));
});

test("inbox, wait and reap show the child's handoff, branch and merge outcome", async () => {
  const sig = {
    kind: "child_exited",
    child: "c1",
    exit: "succeeded",
    handoff: "built X\nsee out/",
    branch: "agent/c1",
    spentMicros: 500_000,
    budgetMicros: 2_000_000,
    files: ["out/x"],
  };
  const inbox = harness(() => ({ status: 200, body: [sig] }));
  assert.equal(await run(["inbox"], inbox.io), EXIT.ok);
  const o = inbox.out.join("\n");
  assert.match(o, /child_exited c1 succeeded.*branch agent\/c1/);
  assert.match(o, /handoff:\n {2}built X\n {2}see out\//);
  const rec = { ...agent, result: { summary: "all good", files: ["f1"] } };
  const w = harness(() => ({ status: 200, body: { done: true, record: rec } }));
  assert.equal(await run(["wait", "a1"], w.io), EXIT.ok);
  assert.match(w.out.join("\n"), /handoff:\n {2}all good\nfiles: f1/);
  const r = harness(() => ({ status: 200, body: { record: rec, unusedMicros: 1, merge: { status: "conflict", detail: "CONFLICT in a.txt" } } }));
  assert.equal(await run(["reap", "a1"], r.io), EXIT.ok);
  assert.match(r.out.join("\n"), /handoff:\n {2}all good[\s\S]*branch: agent\/a1\nmerge: conflict \(CONFLICT in a.txt\)/);
});

test("await-user posts a keyed call to self; a daemon refusal is exit 5 with the daemon's error text", async () => {
  const ok = harness(() => ({ status: 201, body: { accepted: true } }));
  assert.equal(await run(["await-user", "--key", "k1"], ok.io), EXIT.ok);
  assert.deepEqual(ok.calls[0], { method: "POST", path: "/v1/agents/self/await-user", body: { idempotencyKey: "k1" } });
  const auto = harness(() => ({ status: 201, body: { accepted: true } }));
  await run(["await-user"], auto.io);
  assert.match((auto.calls[0]!.body as { idempotencyKey: string }).idempotencyKey, /^[0-9a-f-]{36}$/);
  const no = harness(() => ({ status: 409, body: { error: "await-user refused: valid exits are `pomtree result`, `pomtree yield`" } }));
  assert.equal(await run(["await-user"], no.io), EXIT.conflict);
  assert.match(no.err.join("\n"), /await-user refused/);
});

test("sched add forwards the spawn flags (budget, deadline, template, model) like pomtree spawn", async () => {
  const h = harness(() => ({ status: 200, body: sched }));
  assert.equal(
    await run(["sched", "add", "s3", "0 9 * * 1", "task", "--budget", "$2", "--deadline", "60000", "--template", "researcher", "--model", "p/m1"], h.io),
    EXIT.ok,
  );
  assert.deepEqual(unkeyed(h.calls[0]!.body), {
    cron: "0 9 * * 1",
    task: "task",
    missed: "skip",
    overlap: "skip",
    jitterMs: 0,
    budgetMicros: 2_000_000,
    deadlineMs: 60000,
    template: "researcher",
    model: { provider: "p", id: "m1" },
  });
  assert.equal(await run(["sched", "add", "s3", "* * * * *", "t", "--model", "nope"], harness(() => ({ status: 200, body: sched })).io), EXIT.usage);
  assert.equal(await run(["sched", "add", "s3", "* * * * *", "t", "--budget", "abc"], harness(() => ({ status: 200, body: sched })).io), EXIT.usage);
});

test("sched add --agent wakes an agent and refuses spawn flags alongside it", async () => {
  const h = harness(() => ({ status: 200, body: sched }));
  assert.equal(await run(["sched", "add", "s4", "0 9 * * 1", "task", "--agent", "a1"], h.io), EXIT.ok);
  assert.deepEqual(unkeyed(h.calls[0]!.body), { cron: "0 9 * * 1", task: "task", missed: "skip", overlap: "skip", jitterMs: 0, agent: "a1" });
  const bad = harness(() => ({ status: 200, body: sched }));
  assert.equal(await run(["sched", "add", "s4", "* * * * *", "t", "--agent", "a1", "--budget", "5"], bad.io), EXIT.usage);
  assert.equal(bad.calls.length, 0);
});

test("spawn forwards a wrap-up duration and refuses zero", async () => {
  const h = harness(() => ({ status: 201, body: agent }));
  assert.equal(await run(["spawn", "--task", "x", "--wrapup", "45s"], h.io), EXIT.ok);
  assert.equal((h.calls[0]!.body as { wrapupMs: number }).wrapupMs, 45_000);
  assert.equal(await run(["spawn", "--task", "x", "--wrapup", "0"], h.io), EXIT.usage);
});

test("spawn forwards --disposition and --ttl as a disposition body; --ttl alone means hold with that TTL", async () => {
  const body = async (args: string[]) => {
    const h = harness(() => ({ status: 201, body: agent }));
    assert.equal(await run(["spawn", "--task", "x", ...args], h.io), EXIT.ok);
    return h.calls[0]!.body as { disposition?: unknown };
  };
  assert.deepEqual((await body(["--disposition", "reap-on-exit"])).disposition, { mode: "reap-on-exit" });
  assert.deepEqual((await body(["--disposition", "hold", "--ttl", "2m"])).disposition, { mode: "hold", ttlMs: 120_000 });
  assert.deepEqual((await body(["--ttl", "30s"])).disposition, { mode: "hold", ttlMs: 30_000 });
  assert.equal("disposition" in (await body([])), false);
});

test("spawn refuses an unknown --disposition, --ttl with reap-on-exit, and a zero or malformed --ttl before any request", async () => {
  for (const args of [
    ["--disposition", "keep"],
    ["--disposition", "reap-on-exit", "--ttl", "5s"],
    ["--ttl", "0"],
    ["--ttl", "abc"],
  ]) {
    const h = harness(() => ({ status: 201, body: agent }));
    assert.equal(await run(["spawn", "--task", "x", ...args], h.io), EXIT.usage, args.join(" "));
    assert.equal(h.calls.length, 0);
  }
  const w = harness(() => ({ status: 201, body: agent }));
  await run(["spawn", "--task", "x", "--disposition", "keep"], w.io);
  assert.match(w.err[0]!, /--disposition must be "hold" or "reap-on-exit"/);
  const z = harness(() => ({ status: 201, body: agent }));
  await run(["spawn", "--task", "x", "--ttl", "0"], z.io);
  assert.match(z.err[0]!, /--ttl 0 is not a valid TTL; pass a positive duration such as 30m or 2h, or omit --ttl/);
});

test("result forwards explicit approval to save an uncommitted snapshot", async () => {
  const h = harness(() => ({ status: 200, body: agent }));
  assert.equal(await run(["result", "--summary", "done", "--save-uncommitted", "snapshot"], h.io), EXIT.ok);
  assert.equal((h.calls[0]!.body as { saveUncommitted: string }).saveUncommitted, "snapshot");
  assert.equal(h.calls[0]!.timeoutMs, 0);
});

test("workflow launch posts the qualified name, input, key and prints the agent", async () => {
  const h = harness(() => ({ status: 201, body: { kind: "launched", agent: "a7" } }));
  assert.equal(await run(["workflow", "launch", "hn/digest", "--input", '{"instance":"daily"}', "--key", "k1"], h.io), EXIT.ok);
  assert.deepEqual(h.calls[0], {
    method: "POST",
    path: "/v1/workflows/launch",
    body: { workflow: "hn/digest", input: { instance: "daily" }, idempotencyKey: "k1" },
  });
  assert.deepEqual(h.out, ["a7"]);
});

test("workflow launch defaults input to {} and forwards budget and deadline", async () => {
  const h = harness(() => ({ status: 201, body: { kind: "launched", agent: "a8" } }));
  assert.equal(await run(["workflow", "launch", "hn/digest", "--key", "k2", "--budget", "$2", "--deadline", "30m"], h.io), EXIT.ok);
  assert.deepEqual(h.calls[0]!.body, { workflow: "hn/digest", input: {}, idempotencyKey: "k2", budgetMicros: 2_000_000, deadlineMs: 1_800_000 });
});

test("workflow launch rejects bad names, malformed JSON and bad flags before any call", async () => {
  const cases: string[][] = [
    ["workflow"],
    ["workflow", "launch"],
    ["workflow", "launch", "digest"],
    ["workflow", "launch", "Hn/digest"],
    ["workflow", "launch", "hn/digest/extra"],
    ["workflow", "run", "hn/digest"],
    ["workflow", "launch", "hn/digest", "--input", "{nope"],
    ["workflow", "launch", "hn/digest", "--budget", "-5"],
    ["workflow", "launch", "hn/digest", "--deadline", "soon"],
  ];
  for (const argv of cases) {
    const h = harness(() => ({ status: 201, body: {} }));
    assert.equal(await run(argv, h.io), EXIT.usage, argv.join(" "));
    assert.equal(h.calls.length, 0, argv.join(" "));
  }
});

test("workflow launch maps a server refusal to its exit code", async () => {
  const h = harness(() => ({ status: 403, body: { error: "forbidden" } }));
  assert.equal(await run(["workflow", "launch", "hn/digest"], h.io), EXIT.denied);
});

const withConfigDoc = async (doc: string | undefined, fn: () => Promise<void>) => {
  const prev = process.env[CONTAINER_CONFIG_ENV];
  if (doc === undefined) delete process.env[CONTAINER_CONFIG_ENV];
  else process.env[CONTAINER_CONFIG_ENV] = doc;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env[CONTAINER_CONFIG_ENV];
    else process.env[CONTAINER_CONFIG_ENV] = prev;
  }
};
const configDoc = (patch: Record<string, unknown>, contract = CONTAINER_CONTRACT) =>
  canonicalContainerDoc(contract, { ...CONTAINER_DEFAULTS, ...patch } as Record<string, number | boolean>);

test("the wait-yield threshold is the generated default when no config document exists, and the document's value when present", async () => {
  await withGeneration("1", async () => {
    const parkWait = async (timeoutMs: number) => {
      const h = harness(() => ({ status: 201, body: { parked: true } }));
      await run(["wait", "c1", "--timeout", String(timeoutMs)], h.io);
      return h.calls[0]!.path === "/v1/agents/self/park";
    };
    const dflt = CONTAINER_DEFAULTS["wait.yieldMs"];
    await withConfigDoc(undefined, async () => {
      assert.equal(await parkWait(dflt), false);
      assert.equal(await parkWait(dflt + 1), true);
    });
    await withConfigDoc(configDoc({ "wait.yieldMs": 5000 }), async () => {
      assert.equal(await parkWait(5000), false);
      assert.equal(await parkWait(5001), true);
    });
  });
});

test("an invalid or mismatched config document fails closed with exit 2 and leaks no contents", async () => {
  const SECRET = 424242123;
  const bad: Record<string, string> = {
    "tampered digest": configDoc({}, "0000000000000000"),
    "extra key": configDoc({ "x.secretKey": SECRET }),
    "wrong type": configDoc({ "wait.yieldMs": `s${SECRET}` }),
    "below minimum": configDoc({ "browser.capture.textMaxBytes": 0 }),
    "violated relation": configDoc({ "browser.capture.maxBytesCeiling": CONTAINER_DEFAULTS["browser.capture.rawAllocationMaxBytes"] + 1 }),
    "not json": `{${SECRET}`,
  };
  await withGeneration("1", async () => {
    for (const [name, doc] of Object.entries(bad)) {
      await withConfigDoc(doc, async () => {
        const h = harness(() => ({ status: 201, body: { parked: true } }));
        assert.equal(await run(["wait", "c1", "--timeout", "60000"], h.io), EXIT.usage, name);
        assert.equal(h.calls.length, 0, name);
        assert.match(h.err.join("\n"), new RegExp(CONTAINER_CONFIG_ENV), name);
        assert.doesNotMatch(h.err.join("\n"), new RegExp(String(SECRET)), name);
      });
    }
  });
});

// SPEC design rule 4: the daemon refuses a mutating call without idempotencyKey, so the CLI issues one per invocation and --key wins.
test("drain, extend, workflow launch, operator send and escalations answer issue a key by default; --key wins", async () => {
  const cases: { argv: string[]; path: string; reply: Reply }[] = [
    { argv: ["drain", "--deadline", "100"], path: "/v1/drain", reply: { status: 202, body: { draining: true } } },
    { argv: ["extend", "a1"], path: "/v1/agents/a1/deadline", reply: { status: 200, body: { deadlineAt: 1 } } },
    { argv: ["workflow", "launch", "o/w", "--input", "{}"], path: "/v1/workflows/launch", reply: { status: 201, body: { kind: "launched", agent: "a1" } } },
    { argv: ["send", "a1", "hi"], path: "/v1/agents/a1/message", reply: { status: 201, body: { id: "s1" } } },
    { argv: ["escalations", "answer", "e1", "yes"], path: "/v1/escalations/e1/answer", reply: { status: 201, body: { id: "e1" } } },
  ];
  for (const c of cases) {
    const bare = harness(() => c.reply);
    await run(c.argv, bare.io);
    const call = bare.calls.find((x) => x.path === c.path);
    assert.ok(call, `${c.argv.join(" ")} called ${c.path}: ${bare.err.join("")}`);
    assert.match((call.body as { idempotencyKey: string }).idempotencyKey, /^[0-9a-f-]{36}$/, c.argv.join(" "));
    const named = harness(() => c.reply);
    await run([...c.argv, "--key", "mine"], named.io);
    assert.equal((named.calls.find((x) => x.path === c.path)!.body as { idempotencyKey: string }).idempotencyKey, "mine", c.argv.join(" "));
  }
});

test("a transport failure's hint names the cause and the pomtree-up actions; invalid JSON and bad POMTREE_API keep their own actions", async () => {
  const hintFor = async (msg: string) => {
    const h = harness(() => {
      throw new TransportError(msg);
    });
    h.io.env = { POMTREED_STATE_DIR: "/x" };
    assert.equal(await run(["ps"], h.io), EXIT.unreachable);
    return h.err.join("\n");
  };
  const down = await hintFor("cannot reach pomtreed at /x/pomtreed.sock: ECONNREFUSED");
  assert.match(down, /nothing is listening on that socket\/URL, or this shell points at the wrong state dir/);
  assert.match(down, /scripts\/pomtree-up REPO,/);
  assert.match(down, /eval "\$\(scripts\/pomtree-up REPO --print-env\)"/);
  const badApi = await hintFor("POMTREE_API must be an http:// URL, got ftp://x");
  assert.match(badApi, /set POMTREE_API to an http:\/\/ URL/);
  assert.doesNotMatch(badApi, /pomtree-up/);
  const json = await hintFor("daemon sent invalid JSON");
  assert.match(json, /different versions/);
  assert.match(json, /scripts\/pomtree-up REPO --rebuild/);
  assert.doesNotMatch(json, /print-env/);
  // Negative control: a non-transport failure (HTTP 401) gets no pomtree-up hint.
  const denied = harness(() => ({ status: 401, body: { error: "missing or invalid token" } }));
  await run(["ps"], denied.io);
  assert.doesNotMatch(denied.err.join("\n"), /pomtree-up/);
});

test("doctor gives each problem a next step; a healthy report has none", async () => {
  const h = harness(
    route({
      "/v1/doctor": {
        ok: false,
        host: "h",
        agents: {},
        sandboxes: 0,
        live: 0,
        sandboxUp: false,
        journalFailed: true,
        degraded: true,
        sweepsStale: true,
        agentEndpoint: { bind: ["172.17.0.1:9"], containerReachable: false },
      },
    }),
  );
  await run(["doctor"], h.io);
  const o = h.out[0]!;
  // Reason labels are unchanged (first line).
  assert.equal(
    o.split("\n")[0],
    "FAIL: sandbox unavailable; journal writes failing; daemon degraded; background sweeps stale; agent endpoint 172.17.0.1:9 not reachable from containers",
  );
  assert.match(o, /next: sandbox unavailable: start Docker.*permission denied.*usermod -aG docker \$USER.*log out and back in/);
  assert.ok(o.includes(`permission denied, ${DOCKER_GROUP_ACTION}\n`), "the one docker-group sentence from core");
  assert.match(o, /next: journal writes failing: check free disk space and write permissions on the pomtreed state dir/);
  assert.match(o, /next: daemon degraded: read pomtreed\.log in the pomtreed state dir/);
  assert.match(o, /next: background sweeps stale: read pomtreed\.log.*restart pomtreed if it persists/);
  assert.match(o, /next: agent api not reachable from containers.*sudo ufw allow in on docker0.*sudo ufw allow in on br-\+/);
  const good = harness(route({ "/v1/doctor": { ok: true, host: "h", agents: {}, sandboxes: 0, live: 0 } }));
  await run(["doctor"], good.io);
  assert.doesNotMatch(good.out[0]!, /next:/);
  // One problem yields exactly its own step.
  const one = harness(route({ "/v1/doctor": { ok: false, host: "h", agents: {}, sandboxes: 0, live: 0, journalFailed: true } }));
  await run(["doctor"], one.io);
  assert.equal(one.out[0]!.match(/next:/g)?.length, 1);
});

test("reap help warns that the clone is deleted and names pomtree pull --from", async () => {
  const h = harness(() => ({ status: 200, body: {} }));
  await run(["--help"], h.io);
  assert.match(h.out.join("\n"), /reap ID .*DELETES the child's clone: unpushed work\s+in it is lost; run pomtree pull --from ID first/);
  // Negative control: other commands' help does not carry the warning.
  assert.doesNotMatch(h.out.join("\n").split("wait ID")[1]!.split("reap ID")[0]!, /DELETES/);
});
