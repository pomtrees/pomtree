import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { run } from "@pomtree/pomtree";
import type { Io } from "@pomtree/pomtree";
import { LAYOUT_LOGIC_JS } from "../../observe/src/layout.ts";
import { UI_COMMAND_JS, UI_STREAM_PATH } from "../../observe/src/uiCommand.ts";
import { UI_DRIVER_JS } from "../../observe/src/uiDriver.ts";
import { handle } from "../../pomtreed/src/api.ts";
import { issueUiCookie } from "../../pomtreed/src/auth.ts";
import { makeServer } from "../../pomtreed/src/server.ts";
import { SECRET, op, setup, until } from "../../pomtreed/src/test-setup.ts";

// Producer-to-consumer round trip for driving the web UI, offline: CLI argv -> body -> real daemon route -> journal row
// -> real /live/ui stream -> frame data -> the real in-page driver (node:vm, fake EventSource) -> fake window manager api.
// Not exercised in a real browser.

type T = ReturnType<typeof setup>;
const idle = async (c: { stopped: Promise<unknown> }) => void (await c.stopped);
const VIEWS = [
  { id: "terminal", title: "Terminal", multi: true, subject: "agent" },
  { id: "browser", title: "Browser", multi: true, subject: "agent" },
  { id: "report", title: "Report", multi: true, subject: "report" },
  { id: "tree", title: "Tree", multi: false, subject: null },
];

// The CLI's transport forwards in-process to the daemon handler, as the unix socket would.
const cli = async (t: T, argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    call: async (r) => {
      const res = await handle(t.daemon, { method: r.method, url: r.path, body: r.body, token: op });
      return { status: res.status, body: res.body };
    },
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    version: "0",
  };
  const code = await run(argv, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
};
const uiRows = async (t: T) => (await t.journal.read({})).filter((e) => e.payload.kind === "ext.observe.ui_command");
const rowCommands = async (t: T) => (await uiRows(t)).map((e) => JSON.stringify((e.payload as unknown as { command: unknown }).command));

// The real driver in a vm with a fake EventSource and a fake window manager api that records call strings.
// `naive` replaces the kit's frame validation (the deliberately wrong stub UI); everything else is identical.
function boot(naive = false) {
  const calls: string[] = [];
  const j = (v: unknown) => JSON.stringify(v);
  const rec = (s: string) => calls.push(s) > 0;
  const api = {
    views: () => VIEWS,
    notify: (_k: string, text: string) => void calls.push(`notify:${text.split(".")[0]}`),
    openView: (v: string, a?: string, r?: string) => void calls.push(`open:${j([v, a ?? null, r ?? null])}`),
    focusSubject: (v: string, p: object) => rec(`focusSubject:${j([v, p])}`),
    closeSubject: (v: string, p: object) => rec(`closeSubject:${j([v, p])}`),
    focusDirection: (d: string) => rec(`focusDirection:${d}`),
    arrange: (p: string) => rec(`arrange:${p}`),
    resetLayout: () => void calls.push("reset"),
  };
  const handlers: ((ev: { data: string }) => void)[] = [];
  const urls: string[] = [];
  class FakeES {
    constructor(url: string) {
      urls.push(url);
    }
    addEventListener(t: string, fn: (ev: { data: string }) => void) {
      if (t === "message") handlers.push(fn);
    }
  }
  const ctx = createContext({ JSON, Math, Object, Array, Set, Map, String, Number, isFinite, EventSource: FakeES, globalThis: {} });
  runInContext(LAYOUT_LOGIC_JS, ctx);
  runInContext(UI_COMMAND_JS, ctx);
  if (naive) runInContext("UiCommandKit.parseFrame = function (text) { return JSON.parse(text); };", ctx);
  runInContext(UI_DRIVER_JS, ctx);
  Object.assign(ctx, { wm: { api }, cfg: { path: UI_STREAM_PATH } });
  runInContext("createUiDriver(wm, cfg)", ctx);
  const deliver = (data: string) => {
    for (const h of handlers) h({ data });
  };
  return { calls, urls, deliver, take: () => calls.splice(0, calls.length) };
}

// --- SSE client against the real server ---
const listen0 = async (t: T) => {
  const server = makeServer(t.daemon, false, { heartbeatMs: 20, maxConnections: 200 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as { port: number }).port };
};
const open = (port: number) =>
  new Promise<{ text: () => string; close: () => void }>((resolve, reject) => {
    let s = "";
    const req = request({ host: "127.0.0.1", port, path: UI_STREAM_PATH, headers: { cookie: issueUiCookie(SECRET, 60_000) } }, (res) => {
      res.on("data", (d) => (s += d));
      resolve({ text: () => s, close: () => req.destroy() });
    });
    req.on("error", () => {});
    setTimeout(() => reject(new Error("open timeout")), 2000);
    req.end();
  });
// The `data:` text of each complete frame, exactly as an EventSource would hand it to the page.
const dataOf = (text: string) =>
  text
    .split("\n\n")
    .filter((f) => f.includes("data: "))
    .map((f) => /^data: (.*)$/m.exec(f)![1]!);
const tab = async (port: number) => {
  const s = await open(port);
  await until(() => s.text().startsWith(": connected"));
  let used = 0;
  // Feeds every not-yet-fed frame to the driver, once `n` frames in total have arrived.
  const feed = async (n: number, d: ReturnType<typeof boot>) => {
    await until(() => dataOf(s.text()).length >= n);
    const all = dataOf(s.text());
    for (const data of all.slice(used)) d.deliver(data);
    used = all.length;
  };
  return { s, feed, frames: () => dataOf(s.text()) };
};
const withServer = async (t: T, body: (port: number) => Promise<void>) => {
  const { server, port } = await listen0(t);
  try {
    await body(port);
  } finally {
    server.close();
    server.closeAllConnections();
  }
};

test("round trip: every ui verb goes CLI -> daemon -> journal -> stream -> real driver -> window manager calls", async () => {
  const t = setup(idle);
  const rootId = (await t.daemon.root()).id;
  await withServer(t, async (port) => {
    const d = boot();
    const c = await tab(port);
    const verbs: [string[], string[]][] = [
      [["ui", "open", "terminal", "a1"], ['open:["terminal","a1",null]']],
      [["ui", "focus", "--dir", "left"], ["focusDirection:left"]],
      [["ui", "arrange", "grid"], ["arrange:grid"]],
      [["ui", "follow", "on", "--views", "terminal", "--of", rootId], []],
      [["ui", "close", "terminal", "a1"], ['closeSubject:["terminal",{"agent":"a1"}]']],
      [["ui", "reset"], ["reset"]],
    ];
    let n = 0;
    for (const [argv, want] of verbs) {
      const r = await cli(t, argv);
      assert.equal(r.code, 0, `${argv.join(" ")}: ${r.err}`);
      assert.match(r.out, /^sent ui command \d+ to 1 tab$/);
      await c.feed(++n, d);
      assert.deepEqual(d.take(), want, argv.join(" "));
    }
    assert.deepEqual(await rowCommands(t), [
      '{"cmd":"open","view":"terminal","agent":"a1"}',
      '{"cmd":"focus","dir":"left"}',
      '{"cmd":"arrange","preset":"grid"}',
      `{"cmd":"follow","on":true,"views":["terminal"],"of":"${rootId}"}`,
      '{"cmd":"close","view":"terminal","agent":"a1"}',
      '{"cmd":"reset"}',
    ]);
    assert.equal((await uiRows(t))[0]!.payload.kind, "ext.observe.ui_command");
    c.s.close();
  });
});

test("follow: a spawned child opens a terminal only when --of names its parent", async () => {
  const t = setup(idle);
  const rootId = (await t.daemon.root()).id;
  await withServer(t, async (port) => {
    const d = boot();
    const c = await tab(port);
    assert.equal((await cli(t, ["ui", "follow", "on", "--views", "terminal", "--of", "nobody"])).code, 0);
    const kid1 = await t.spawn("kid1");
    await c.feed(2, d);
    assert.equal(JSON.parse(c.frames()[1]!).parent, rootId, "the spawned frame names the parent");
    assert.deepEqual(d.take(), [], "another parent: nothing opens");
    assert.equal((await cli(t, ["ui", "follow", "on", "--views", "terminal", "--of", rootId])).code, 0);
    const kid2 = await t.spawn("kid2");
    await c.feed(4, d);
    assert.deepEqual(d.take(), [`open:${JSON.stringify(["terminal", kid2.id, null])}`], "matching parent: opens for the child only");
    assert.notEqual(kid1.id, kid2.id);
    assert.equal((await cli(t, ["ui", "follow", "off"])).code, 0);
    await t.spawn("kid3");
    await c.feed(6, d);
    assert.deepEqual(d.take(), [], "follow off: nothing opens");
    c.s.close();
  });
});

test("negative: a command the kit rejects stops at 400 with the daemon message and journals nothing", async () => {
  const t = setup(idle);
  const bad = await cli(t, ["ui", "open", "Terminal", "a1"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /view/);
  const explode = await t.operator("POST", "/v1/ui/command", { idempotencyKey: "x", command: { cmd: "explode" } });
  assert.equal(explode.status, 400);
  assert.match((explode.body as { error: string }).error, /explode/);
  assert.deepEqual(await rowCommands(t), []);
  // control: the same chain does journal a valid command, so the empty list above is not a vacuous pass
  assert.equal((await cli(t, ["ui", "open", "terminal", "a1"])).code, 3, "valid: recorded (no tab connected)");
  assert.deepEqual(await rowCommands(t), ['{"cmd":"open","view":"terminal","agent":"a1"}']);
});

test("negative: the real driver applies nothing for an unknown key or a stale seq; a validation-skipping stub does", () => {
  const real = boot();
  const stub = boot(true);
  const unknownKey = JSON.stringify({ type: "command", seq: 10, ts: 1, command: { cmd: "reset", extra: 1 } });
  real.deliver(unknownKey);
  stub.deliver(unknownKey);
  assert.deepEqual(real.take(), [], "real driver rejects an unknown key");
  assert.deepEqual(stub.take(), ["reset"], "the stub applies it, so the control can fail");
  const fresh = JSON.stringify({ type: "command", seq: 11, ts: 1, command: { cmd: "arrange", preset: "rows" } });
  const stale = JSON.stringify({ type: "command", seq: 11, ts: 1, command: { cmd: "reset" } });
  real.deliver(fresh);
  real.deliver(stale);
  real.deliver(JSON.stringify({ type: "command", seq: 3, ts: 1, command: { cmd: "reset" } }));
  assert.deepEqual(real.take(), ["arrange:rows"], "a repeated or older seq is not applied");
  const wrong = JSON.stringify({ type: "command", seq: 12, ts: 1, command: { cmd: "arrange", preset: "diagonal" } });
  real.deliver(wrong);
  assert.deepEqual(real.take(), [], "bad preset rejected");
});

test("tabs: 0 connected tabs exits 3 with the recorded-but-no-tab message; 1 tab exits 0", async () => {
  const t = setup(idle);
  const none = await cli(t, ["ui", "reset"]);
  assert.equal(none.code, 3);
  assert.match(none.err, /recorded but no UI tab is connected/);
  assert.equal((await uiRows(t)).length, 1, "recorded anyway");
  await withServer(t, async (port) => {
    const c = await tab(port);
    const one = await cli(t, ["ui", "reset"]);
    assert.equal(one.code, 0);
    assert.match(one.out, /to 1 tab$/);
    c.s.close();
  });
});

test("reconnect hygiene: a stream opened after a command was posted does not deliver it", async () => {
  const t = setup(idle);
  await cli(t, ["ui", "arrange", "grid"]);
  await withServer(t, async (port) => {
    const d = boot();
    const c = await tab(port);
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(c.frames(), [], "no replay on load");
    assert.equal((await cli(t, ["ui", "reset"])).code, 0);
    await c.feed(1, d);
    assert.deepEqual(d.take(), ["reset"], "only the command posted after connecting arrives");
    c.s.close();
  });
});
