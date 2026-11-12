import assert from "node:assert/strict";
import { test } from "node:test";
import { abandonBody, renderAbandon } from "./abandon.ts";
import { EXIT, run } from "./cli.ts";
import { harness } from "./test-kit.ts";

test("abandonBody sends the reason only when given", () => {
  assert.deepEqual(abandonBody(undefined, "k"), { idempotencyKey: "k" });
  assert.deepEqual(abandonBody("", "k"), { idempotencyKey: "k" });
  assert.deepEqual(abandonBody("backend gone", "k"), { reason: "backend gone", idempotencyKey: "k" });
});

test("renderAbandon prints the daemon's message for each outcome and rejects an unknown shape", () => {
  for (const outcome of ["released", "left", "no_sandbox", "already_abandoned"]) {
    assert.equal(renderAbandon({ agent: "a1", outcome, message: `text for ${outcome}` }), `text for ${outcome}`);
  }
  assert.throws(() => renderAbandon({ agent: "a1", outcome: "exploded", message: "x" }), /unexpected shape.*pomtree show/);
  assert.throws(() => renderAbandon(null), /unexpected shape/);
  assert.throws(() => renderAbandon({ outcome: "left" }), /unexpected shape/);
});

test("pomtree abandon posts the reason to the abandon route and prints the daemon's text", async () => {
  const h = harness(() => ({
    status: 200,
    body: { agent: "a1", outcome: "left", backend: "docker", sandbox: "s1", cause: "c", message: "agent a1 abandoned; sandbox s1 left on docker: c" },
  }));
  assert.equal(await run(["abandon", "a1", "--reason", "docker removed", "--key", "k1"], h.io), EXIT.partial, "left on a backend exits 13");
  assert.equal(EXIT.partial, 13);
  assert.deepEqual(
    h.calls.map((c) => `${c.method} ${c.path}`),
    ["POST /v1/agents/a1/abandon"],
  );
  assert.deepEqual(h.calls[0]!.body, { reason: "docker removed", idempotencyKey: "k1" });
  assert.match(h.out.join("\n"), /left on docker/);
});

test("pomtree abandon without an agent id is a usage error, and a daemon refusal exits non-zero", async () => {
  const h = harness(() => ({ status: 404, body: { error: "no such agent: nope" } }));
  assert.equal(await run(["abandon"], h.io), EXIT.usage);
  assert.notEqual(await run(["abandon", "nope"], h.io), EXIT.ok);
});

test("pomtree abandon exits 0 when the sandbox was released, or there was none, or the run was already abandoned (negative control for the left code)", async () => {
  for (const outcome of ["released", "no_sandbox", "already_abandoned"]) {
    const h = harness(() => ({ status: 200, body: { agent: "a1", outcome, message: `m ${outcome}` } }));
    assert.equal(await run(["abandon", "a1"], h.io), EXIT.ok, outcome);
  }
});
