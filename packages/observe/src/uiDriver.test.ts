import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { LAYOUT_LOGIC_JS } from "./layout.ts";
import { UI_COMMAND_JS, UI_STREAM_PATH } from "./uiCommand.ts";
import { UI_DRIVER_JS } from "./uiDriver.ts";

const VIEWS = [
  { id: "terminal", title: "Terminal", multi: true, subject: "agent" },
  { id: "browser", title: "Browser", multi: true, subject: "agent" },
  { id: "report", title: "Report", multi: true, subject: "report" },
  { id: "tree", title: "Tree", multi: false, subject: null },
];

interface Opts {
  focusSubject?: boolean;
  closeSubject?: boolean;
  focusDirection?: boolean;
  throwOn?: string;
}

function boot(o: Opts = {}) {
  const calls: string[] = [];
  const j = (v: unknown) => JSON.stringify(v);
  const maybeThrow = (name: string) => {
    if (o.throwOn === name) throw new Error("boom in " + name);
  };
  const api = {
    views: () => VIEWS,
    notify: (key: string, text: string) => void calls.push("notify:" + key + ":" + text),
    openView: (v: string, a?: string, r?: string) => {
      calls.push("open:" + j([v, a ?? null, r ?? null]));
      maybeThrow("openView");
    },
    focusSubject: (v: string, p: object) => {
      calls.push("focusSubject:" + j([v, p]));
      return o.focusSubject ?? true;
    },
    closeSubject: (v: string, p: object) => {
      calls.push("closeSubject:" + j([v, p]));
      return o.closeSubject ?? true;
    },
    focusDirection: (d: string) => {
      calls.push("focusDirection:" + d);
      return o.focusDirection ?? true;
    },
    arrange: (p: string) => {
      calls.push("arrange:" + p);
      return true;
    },
    resetLayout: () => void calls.push("reset"),
    dismiss: (key: string) => void calls.push(`dismiss:${key}`),
  };
  const sources: FakeES[] = [];
  class FakeES {
    url: string;
    handlers: ((ev: { data: string }) => void)[] = [];
    others: Record<string, (() => void)[]> = {};
    readyState = 1;
    constructor(url: string) {
      this.url = url;
      sources.push(this);
    }
    addEventListener(t: string, fn: (ev: { data: string }) => void) {
      if (t === "message") this.handlers.push(fn);
      else this.others[t] = [...(this.others[t] ?? []), fn as () => void];
    }
    fire(t: string) {
      for (const f of this.others[t] ?? []) f();
    }
  }
  const ctx = createContext({ JSON, Math, Object, Array, Set, Map, String, Number, isFinite, EventSource: FakeES, globalThis: {} });
  runInContext(LAYOUT_LOGIC_JS, ctx);
  runInContext(UI_COMMAND_JS, ctx);
  runInContext(UI_DRIVER_JS, ctx);
  Object.assign(ctx, { wm: { api }, cfg: { path: UI_STREAM_PATH } });
  runInContext("createUiDriver(wm, cfg)", ctx);
  const push = (data: string) => {
    for (const h of sources[0]!.handlers) h({ data });
  };
  const cmd = (seq: number, command: object) => push(JSON.stringify({ type: "command", seq, ts: 1, command }));
  const spawned = (seq: number, agent: string, parent: string) => push(JSON.stringify({ type: "spawned", seq, agent, parent }));
  const take = () => calls.splice(0, calls.length);
  return { calls, sources, push, cmd, spawned, take };
}

test("the driver opens one EventSource on the configured path", () => {
  const s = boot();
  assert.equal(sources(s), 1);
  assert.equal(s.sources[0]!.url, "/live/ui");
});
const sources = (s: ReturnType<typeof boot>) => s.sources.length;

test("each command routes to the right api call with the right arguments", () => {
  const s = boot();
  s.cmd(1, { cmd: "open", view: "terminal", agent: "a1" });
  s.cmd(2, { cmd: "open", view: "report", agent: "a1", report: "r1" });
  s.cmd(3, { cmd: "open", view: "tree" });
  s.cmd(4, { cmd: "focus", view: "terminal", agent: "a1" });
  s.cmd(5, { cmd: "focus", dir: "left" });
  s.cmd(6, { cmd: "close", view: "report", agent: "a1", report: "r1" });
  s.cmd(7, { cmd: "arrange", preset: "grid" });
  s.cmd(8, { cmd: "reset" });
  assert.deepEqual(s.take(), [
    'open:["terminal","a1",null]',
    'open:["report","a1","r1"]',
    'open:["tree",null,null]',
    'focusSubject:["terminal",{"agent":"a1"}]',
    "focusDirection:left",
    'closeSubject:["report",{"agent":"a1","report":"r1"}]',
    "arrange:grid",
    "reset",
  ]);
});

test("open of a view that is not registered shows a notice and makes no api call", () => {
  const s = boot();
  s.cmd(1, { cmd: "open", view: "nope", agent: "a1" });
  const c = s.take();
  assert.equal(c.length, 1);
  assert.match(c[0]!, /^notify:[^:]+:View not available: nope/);
});

test("focus and close of a window that is not open show a notice", () => {
  const s = boot({ focusSubject: false, closeSubject: false, focusDirection: false });
  s.cmd(1, { cmd: "focus", view: "terminal", agent: "a1" });
  s.cmd(2, { cmd: "close", view: "terminal", agent: "a1" });
  s.cmd(3, { cmd: "focus", dir: "up" });
  const c = s.take();
  assert.equal(c.filter((x) => x.startsWith("notify:")).length, 2, "the window manager owns the focus-direction notice");
  assert.match(c[1]!, /not open/);
  assert.match(c[3]!, /not open/);
  assert.equal(c[4], "focusDirection:up");
});

test("a stale or duplicate seq is ignored, a newer one applies", () => {
  const s = boot();
  s.cmd(5, { cmd: "reset" });
  s.cmd(5, { cmd: "reset" });
  s.cmd(4, { cmd: "reset" });
  assert.deepEqual(s.take(), ["reset"]);
  s.cmd(6, { cmd: "reset" });
  assert.deepEqual(s.take(), ["reset"]);
});

test("malformed JSON and invalid command frames are ignored without throwing", () => {
  const s = boot();
  assert.doesNotThrow(() => s.push("not json"));
  assert.doesNotThrow(() => s.push(""));
  assert.doesNotThrow(() => s.push("null"));
  assert.doesNotThrow(() => s.cmd(1, { cmd: "explode" }));
  assert.doesNotThrow(() => s.cmd(2, { cmd: "open", view: "terminal", agent: "a1", extra: 1 }));
  assert.doesNotThrow(() => s.push(JSON.stringify({ type: "command", seq: "x", ts: 1, command: { cmd: "reset" } })));
  assert.deepEqual(s.take(), []);
  // an ignored frame does not advance the high-water mark
  s.cmd(1, { cmd: "reset" });
  assert.deepEqual(s.take(), ["reset"]);
});

test("follow on uses terminal by default and opens a window per spawned agent", () => {
  const s = boot();
  s.spawned(1, "a9", "a1");
  assert.deepEqual(s.take(), [], "follow is off by default");
  s.cmd(2, { cmd: "follow", on: true });
  s.spawned(3, "a2", "a1");
  assert.deepEqual(s.take(), ['open:["terminal","a2",null]']);
  s.cmd(4, { cmd: "follow", on: false });
  s.spawned(5, "a3", "a1");
  assert.deepEqual(s.take(), []);
});

test("follow opens every listed view in order", () => {
  const s = boot();
  s.cmd(1, { cmd: "follow", on: true, views: ["terminal", "browser"] });
  s.spawned(2, "a2", "a1");
  assert.deepEqual(s.take(), ['open:["terminal","a2",null]', 'open:["browser","a2",null]']);
});

test("follow with of opens only for that parent", () => {
  const s = boot();
  s.cmd(1, { cmd: "follow", on: true, of: "a1" });
  s.spawned(2, "a2", "a1");
  s.spawned(3, "a3", "other");
  assert.deepEqual(s.take(), ['open:["terminal","a2",null]']);
});

test("follow with an invalid view keeps the old flag and notifies", () => {
  const s = boot();
  s.cmd(1, { cmd: "follow", on: true, views: ["terminal"] });
  s.cmd(2, { cmd: "follow", on: true, views: ["tree", "report", "nope"] });
  const c = s.take();
  assert.equal(c.length, 1);
  assert.match(c[0]!, /^notify:.*tree.*report.*nope/);
  s.spawned(3, "a2", "a1");
  assert.deepEqual(s.take(), ['open:["terminal","a2",null]'], "the old flag still applies");
});

test("an api call that throws becomes a notice with cause and action", () => {
  const s = boot({ throwOn: "openView" });
  assert.doesNotThrow(() => s.cmd(1, { cmd: "open", view: "terminal", agent: "a1" }));
  const c = s.take();
  assert.equal(c.length, 2);
  assert.match(c[1]!, /^notify:.*boom in openView.*(Reload|resend|retry)/i);
});

test("the driver source never uses innerHTML and is template-literal safe", () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(UI_DRIVER_JS));
  assert.ok(!UI_DRIVER_JS.includes("`"));
  assert.ok(!UI_DRIVER_JS.includes("${"));
  assert.ok(!UI_DRIVER_JS.includes("\\"));
});

const STREAM_TEXT =
  /^notify:ui-stream:Live UI control stopped: the connection to \/live\/ui was closed by the browser or refused by the daemon\. Reload the page; if it keeps failing, check that you are signed in and that pomtreed is running\.$/;

test("a closed stream after an error shows one notice naming cause and action", () => {
  const s = boot();
  s.sources[0]!.readyState = 2;
  s.sources[0]!.fire("error");
  s.sources[0]!.fire("error");
  const c = s.take();
  assert.equal(c.length, 1);
  assert.match(c[0]!, STREAM_TEXT);
});

test("an error while the browser is retrying (CONNECTING) shows nothing", () => {
  const s = boot();
  s.sources[0]!.readyState = 0;
  s.sources[0]!.fire("error");
  assert.deepEqual(s.take(), []);
});

test("a later frame or open event dismisses the stream notice", () => {
  const s = boot();
  s.sources[0]!.readyState = 2;
  s.sources[0]!.fire("error");
  s.take();
  s.cmd(1, { cmd: "reset" });
  assert.deepEqual(s.take(), ["dismiss:ui-stream", "reset"]);
  s.sources[0]!.fire("error");
  s.take();
  s.sources[0]!.fire("open");
  assert.deepEqual(s.take(), ["dismiss:ui-stream"]);
  s.sources[0]!.fire("open");
  assert.deepEqual(s.take(), [], "nothing to dismiss when no notice is shown");
});
