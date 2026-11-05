import { test } from "node:test";
import assert from "node:assert/strict";
import { SandboxUnavailableError } from "@pomtree/core";
import { createFakes } from "./index.ts";

test("FakeSandbox.openTerminal: records writes/resizes/closes, scripted output, ends on sandbox exit", async () => {
  const f = createFakes();
  const h = await f.sandbox.start(
    { agent: "a", image: "i", env: {}, mounts: [{ kind: "workspace", workspace: "ws-a", containerPath: "/w" }], tty: { cols: 80, rows: 24 } },
    "k-term",
  );
  assert.deepEqual(f.sandbox.started[0]!.tty, { cols: 80, rows: 24 });
  const t = await f.sandbox.openTerminal(h.id, { cols: 80, rows: 24 });
  const fake = f.sandbox.terminals.get(h.id)![0]!;
  assert.equal(fake, t);
  await t.write("ls\r");
  await t.resize(100, 30);
  await t.redraw();
  assert.equal(fake.written, "ls\r");
  assert.deepEqual(fake.resizes, [
    { cols: 80, rows: 24 },
    { cols: 100, rows: 30 },
    { cols: 101, rows: 30 },
    { cols: 100, rows: 30 },
  ]);
  fake.emit("out");
  const it = t.output()[Symbol.asyncIterator]();
  assert.equal(new TextDecoder().decode((await it.next()).value), "out");
  const next = it.next();
  f.sandbox.exit(h.id, 0);
  assert.equal((await next).done, true);
  assert.deepEqual(await t.closed, { reason: "remote" });
  await assert.rejects(t.write("x"), /closed/);
  t.close();
  t.close();
  assert.equal(fake.closes, 2);
  await assert.rejects(() => f.sandbox.openTerminal(h.id), SandboxUnavailableError);
});
