import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT, run } from "./cli.ts";
import { buildUiCommand, formatUiResult } from "./uiCmd.ts";
import { harness } from "./test-kit.ts";

const ok = (args: string[], flags: Record<string, string | undefined> = {}) => {
  const r = buildUiCommand(args, flags);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.ok ? JSON.stringify(r.command) : "";
};
const bad = (args: string[], flags: Record<string, string | undefined> = {}) => {
  const r = buildUiCommand(args, flags);
  assert.equal(r.ok, false, JSON.stringify(r));
  return r.ok ? "" : r.error;
};

test("open/focus/close build the exact command and omit absent optional fields", () => {
  assert.equal(ok(["open", "tree"]), '{"cmd":"open","view":"tree"}');
  assert.equal(ok(["open", "terminal", "a1"]), '{"cmd":"open","view":"terminal","agent":"a1"}');
  assert.equal(ok(["open", "report", "a1", "r1"]), '{"cmd":"open","view":"report","agent":"a1","report":"r1"}');
  assert.equal(ok(["focus", "browser", "a1"]), '{"cmd":"focus","view":"browser","agent":"a1"}');
  assert.equal(ok(["focus", "report", "a1", "r1"]), '{"cmd":"focus","view":"report","agent":"a1","report":"r1"}');
  assert.equal(ok(["close", "terminal", "a1"]), '{"cmd":"close","view":"terminal","agent":"a1"}');
  assert.equal(ok(["close", "tree"]), '{"cmd":"close","view":"tree"}');
});

test("focus --dir builds a direction command", () => {
  for (const d of ["left", "right", "up", "down"]) assert.equal(ok(["focus"], { dir: d }), `{"cmd":"focus","dir":"${d}"}`);
});

test("arrange, reset and follow build the exact command", () => {
  for (const p of ["single", "columns", "rows", "grid"]) assert.equal(ok(["arrange", p]), `{"cmd":"arrange","preset":"${p}"}`);
  assert.equal(ok(["reset"]), '{"cmd":"reset"}');
  assert.equal(ok(["follow", "on"]), '{"cmd":"follow","on":true}');
  assert.equal(ok(["follow", "off"]), '{"cmd":"follow","on":false}');
  assert.equal(ok(["follow", "on"], { views: "terminal,browser", of: "a1" }), '{"cmd":"follow","on":true,"views":["terminal","browser"],"of":"a1"}');
  assert.equal(ok(["follow", "on"], { views: "terminal" }), '{"cmd":"follow","on":true,"views":["terminal"]}');
  assert.equal(ok(["follow", "on"], { of: "a1" }), '{"cmd":"follow","on":true,"of":"a1"}');
});

test("usage error: unknown or missing verb names the verbs and gives an example", () => {
  for (const args of [[], ["bogus"]]) {
    const e = bad(args);
    assert.match(e, /open\|focus\|close\|arrange\|reset\|follow/);
    assert.match(e, /for example: pomtree ui open terminal a1/);
  }
});

test("usage error: missing view or argument says what to add", () => {
  assert.match(bad(["open"]), /open needs a view.*for example: pomtree ui open terminal a1/);
  assert.match(bad(["close"]), /close needs a view.*for example: pomtree ui close terminal a1/);
  assert.match(bad(["focus"]), /focus needs a view or --dir.*for example: pomtree ui focus --dir left/);
  assert.match(bad(["arrange"]), /arrange needs a preset.*for example: pomtree ui arrange grid/);
  assert.match(bad(["follow"]), /follow needs on or off.*for example: pomtree ui follow on/);
});

test("usage error: bad preset lists the presets", () => {
  const e = bad(["arrange", "diagonal"]);
  assert.match(e, /"diagonal"/);
  assert.match(e, /single, columns, rows or grid/);
  assert.match(e, /for example: pomtree ui arrange grid/);
});

test("usage error: bad --dir lists the directions", () => {
  const e = bad(["focus"], { dir: "sideways" });
  assert.match(e, /"sideways"/);
  assert.match(e, /left, right, up or down/);
  assert.match(e, /for example: pomtree ui focus --dir left/);
});

test("usage error: --dir cannot be combined with a view", () => {
  assert.match(bad(["focus", "terminal", "a1"], { dir: "left" }), /either a view or --dir, not both.*for example/);
});

test("usage error: follow needs on or off", () => {
  const e = bad(["follow", "maybe"]);
  assert.match(e, /"maybe"/);
  assert.match(e, /on or off.*for example: pomtree ui follow on/);
});

test("usage error: --views must be 1 to 4 non-empty names", () => {
  assert.match(bad(["follow", "on"], { views: "" }), /--views needs 1 to 4 view names.*for example: pomtree ui follow on --views terminal,browser/);
  assert.match(bad(["follow", "on"], { views: "terminal,,browser" }), /--views needs 1 to 4 view names/);
  assert.match(bad(["follow", "on"], { views: "a,b,c,d,e" }), /--views needs 1 to 4 view names/);
});

test("usage error: extra arguments are named", () => {
  assert.match(bad(["open", "report", "a1", "r1", "x"]), /unexpected extra argument "x".*for example: pomtree ui open report a1 r1/);
  assert.match(bad(["arrange", "grid", "x"]), /unexpected extra argument "x"/);
  assert.match(bad(["reset", "x"]), /unexpected extra argument "x"/);
  assert.match(bad(["follow", "on", "x"]), /unexpected extra argument "x"/);
});

test("usage error: a flag that does not belong to the verb is refused, not ignored", () => {
  assert.match(bad(["open", "tree"], { views: "terminal" }), /--views only applies to ui follow/);
  assert.match(bad(["open", "tree"], { of: "a1" }), /--of only applies to ui follow/);
  assert.match(bad(["open", "tree"], { dir: "left" }), /--dir only applies to ui focus/);
});

test("formatUiResult: tabs 1 and 3 are sent, pluralised, exit 0", () => {
  assert.deepEqual(formatUiResult({ seq: 7, tabs: 1 }, EXIT), { out: "sent ui command 7 to 1 tab", err: "", code: EXIT.ok });
  assert.deepEqual(formatUiResult({ seq: 8, tabs: 3 }, EXIT), { out: "sent ui command 8 to 3 tabs", err: "", code: EXIT.ok });
});

test("formatUiResult: 0 tabs is an honest warning with exit 3 (not found)", () => {
  const r = formatUiResult({ seq: 7, tabs: 0 }, EXIT);
  assert.equal(r.out, "");
  assert.equal(r.code, EXIT.notFound);
  assert.equal(
    r.err,
    "ui command 7 was recorded but no UI tab is connected, so nothing applied and a tab that connects later will not replay it; open the operator UI (/ui) and run it again",
  );
});

test("formatUiResult: a daemon 400 shows its text with exit 2; a malformed reply is an error", () => {
  assert.deepEqual(formatUiResult({ error: "unknown view" }, EXIT), { out: "", err: "unknown view", code: EXIT.usage });
  const m = formatUiResult({ nope: 1 } as never, EXIT);
  assert.equal(m.code, EXIT.error);
  assert.match(m.err, /unexpected reply/);
});

test("pomtree ui open terminal a1 posts the exact body and exits 3 (not found) with the message on stderr when no tab is connected", async () => {
  const h = harness(() => ({ status: 200, body: { seq: 7, tabs: 0 } }));
  assert.equal(await run(["ui", "open", "terminal", "a1", "--key", "k1"], h.io), EXIT.notFound);
  assert.deepEqual(h.calls, [
    { method: "POST", path: "/v1/ui/command", body: { idempotencyKey: "k1", command: { cmd: "open", view: "terminal", agent: "a1" } } },
  ]);
  assert.deepEqual(h.out, []);
  assert.match(h.err.join("\n"), /ui command 7 was recorded but no UI tab is connected/);
});

test("pomtree ui reaching a tab prints sent and exits 0; a random key is issued without --key", async () => {
  const h = harness(() => ({ status: 200, body: { seq: 9, tabs: 2 } }));
  assert.equal(await run(["ui", "follow", "on", "--views", "terminal,browser", "--of", "a1"], h.io), EXIT.ok);
  assert.deepEqual(h.out, ["sent ui command 9 to 2 tabs"]);
  const b = h.calls[0]!.body as { idempotencyKey: string; command: unknown };
  assert.match(b.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.deepEqual(b.command, { cmd: "follow", on: true, views: ["terminal", "browser"], of: "a1" });
});

test("pomtree ui: a usage error exits 2 without calling the daemon", async () => {
  const h = harness(() => ({ status: 200, body: { seq: 1, tabs: 1 } }));
  assert.equal(await run(["ui", "arrange", "diagonal"], h.io), EXIT.usage);
  assert.equal(h.calls.length, 0);
  assert.match(h.err.join("\n"), /single, columns, rows or grid/);
});

test("pomtree ui: a daemon 400 shows the daemon's error and exits 2", async () => {
  const h = harness(() => ({ status: 400, body: { error: "unknown view nope; use one of tree, terminal" } }));
  assert.equal(await run(["ui", "open", "nope"], h.io), EXIT.usage);
  assert.match(h.err.join("\n"), /unknown view nope; use one of tree, terminal/);
  assert.deepEqual(h.out, []);
});
