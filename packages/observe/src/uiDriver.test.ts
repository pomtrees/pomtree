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
  noMenu?: boolean;
  leafOf?: string | null;
  windowCommand?: boolean;
  throwOn?: string;
  fetch?: (url: string, init: { signal?: unknown }) => Promise<{ status: number }>;
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
    leafOf: (v: string, p: object) => {
      calls.push("leafOf:" + j([v, p]));
      return o.leafOf === undefined ? "l1" : o.leafOf;
    },
    windowCommand: (c: string, leaf: string | null) => {
      calls.push("windowCommand:" + j([c, leaf]));
      return o.windowCommand ?? true;
    },
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
  const ctx = createContext({
    JSON,
    Math,
    Object,
    Array,
    Set,
    Map,
    String,
    Number,
    isFinite,
    EventSource: FakeES,
    globalThis: {},
    ...(o.fetch && { fetch: o.fetch, AbortController }),
  });
  runInContext(LAYOUT_LOGIC_JS, ctx);
  runInContext(UI_COMMAND_JS, ctx);
  // The declared WindowMenuKit.fromUiCommand (S1 writes the real one): a scripted fake with the same signature.
  runInContext(
    'globalThis.WindowMenuKit = { fromUiCommand: function (c) { return c.cmd === "close" ? (c.scope ? "window.close-" + c.scope : "window.close") : "window." + c.cmd; } }; var WindowMenuKit = globalThis.WindowMenuKit;' +
      (o.noMenu ? " WindowMenuKit.fromUiCommand = function () { return null; };" : ""),
    ctx,
  );
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
    'leafOf:["report",{"agent":"a1","report":"r1"}]',
    'windowCommand:["window.close","l1"]',
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
  const s = boot({ focusSubject: false, leafOf: null, focusDirection: false });
  s.cmd(1, { cmd: "focus", view: "terminal", agent: "a1" });
  s.cmd(2, { cmd: "close", view: "terminal", agent: "a1" });
  s.cmd(3, { cmd: "focus", dir: "up" });
  const c = s.take();
  assert.equal(c.filter((x) => x.startsWith("notify:")).length, 2, "the window manager owns the focus-direction notice");
  assert.match(c[1]!, /not open/);
  assert.equal(c[2], 'leafOf:["terminal",{"agent":"a1"}]');
  assert.match(c[3]!, /Cannot close terminal for a1: that window is not open\./);
  assert.equal(
    c.some((x) => x.startsWith("windowCommand:")),
    false,
  );
  assert.equal(c[4], "focusDirection:up");
});

test("window commands map through WindowMenuKit and call api.leafOf then api.windowCommand", () => {
  const s = boot();
  s.cmd(1, { cmd: "close", view: "terminal", agent: "a1", scope: "others" });
  s.cmd(2, { cmd: "close", view: "tree", scope: "left" });
  s.cmd(3, { cmd: "close", view: "tree", scope: "right" });
  s.cmd(4, { cmd: "maximize", view: "report", agent: "a1", report: "r1" });
  s.cmd(5, { cmd: "minimize", view: "tree" });
  s.cmd(6, { cmd: "restore", view: "terminal", agent: "a1" });
  assert.deepEqual(s.take(), [
    'leafOf:["terminal",{"agent":"a1"}]',
    'windowCommand:["window.close-others","l1"]',
    'leafOf:["tree",{}]',
    'windowCommand:["window.close-left","l1"]',
    'leafOf:["tree",{}]',
    'windowCommand:["window.close-right","l1"]',
    'leafOf:["report",{"agent":"a1","report":"r1"}]',
    'windowCommand:["window.maximize","l1"]',
    'leafOf:["tree",{}]',
    'windowCommand:["window.minimize","l1"]',
    'leafOf:["terminal",{"agent":"a1"}]',
    'windowCommand:["window.restore","l1"]',
  ]);
});

test("restore without a view and close all pass a null leaf and never look one up", () => {
  const s = boot();
  s.cmd(1, { cmd: "restore" });
  s.cmd(2, { cmd: "close", scope: "all" });
  assert.deepEqual(s.take(), ['windowCommand:["window.restore",null]', 'windowCommand:["window.close-all",null]']);
});

test("plain close goes through leafOf and window.close, never api.closeSubject", () => {
  const s = boot();
  s.cmd(1, { cmd: "close", view: "tree" });
  assert.deepEqual(s.take(), ['leafOf:["tree",{}]', 'windowCommand:["window.close","l1"]']);
});

test("a window command on a window that is not open says so and does not run the command", () => {
  const s = boot({ leafOf: null });
  s.cmd(1, { cmd: "maximize", view: "terminal", agent: "a1" });
  s.cmd(2, { cmd: "close", view: "tree", scope: "others" });
  s.cmd(3, { cmd: "restore", view: "tree" });
  const c = s.take();
  assert.equal(
    c.some((x) => x.startsWith("windowCommand:")),
    false,
  );
  assert.match(c[1]!, /^notify:[^:]+:Cannot maximize terminal for a1: that window is not open\./);
  assert.match(c[3]!, /Cannot close tree: that window is not open\./);
  assert.match(c[5]!, /Cannot restore tree: that window is not open\./);
});

test("a refused window command adds no driver notice (the window manager owns it)", () => {
  const s = boot({ windowCommand: false });
  s.cmd(1, { cmd: "minimize", view: "tree" });
  assert.equal(
    s.take().some((x) => x.startsWith("notify:")),
    false,
  );
});

test("a command the window menu cannot map becomes a notice with an action and no api call", () => {
  const s = boot({ noMenu: true });
  s.cmd(1, { cmd: "restore" });
  const c = s.take();
  assert.equal(c.length, 1);
  assert.match(c[0]!, /^notify:[^:]+:Cannot restore: the window menu has no such command\. Reload/);
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
  /^notify:ui-stream:Live UI control stopped: the connection to \/live\/ui was closed\. The daemon could not be reached; check that pomtreed is running\. If it keeps failing, reload the page and check that you are signed in and that pomtreed is running\.$/;

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

const settle = () => new Promise((r) => setTimeout(r, 0));
const closed = async (status: number | Error) => {
  const aborted: boolean[] = [];
  const urls: string[] = [];
  const s = boot({
    fetch: (url, init) => {
      urls.push(url);
      aborted.push(init.signal !== undefined);
      return status instanceof Error ? Promise.reject(status) : Promise.resolve({ status });
    },
  });
  s.sources[0]!.readyState = 2;
  s.sources[0]!.fire("error");
  s.sources[0]!.fire("error");
  await settle();
  return { notices: s.take(), urls, aborted };
};

test("a closed stream probes the same path once and names the HTTP status with its action", async () => {
  const want: [number, RegExp][] = [
    [401, /HTTP 401: sign in again/],
    [403, /HTTP 403: sign in again/],
    [404, /HTTP 404: this pomtreed does not serve \/live\/ui/],
    [503, /HTTP 503: too many open streams/],
    [200, /HTTP 200\), so the browser or a proxy rejected it/],
    [500, /HTTP 500; check the pomtreed log/],
  ];
  for (const [status, re] of want) {
    const r = await closed(status);
    assert.equal(r.notices.length, 1, String(status));
    assert.match(r.notices[0]!, re);
    assert.deepEqual(r.urls, ["/live/ui"]);
    assert.deepEqual(r.aborted, [true], "the probe stream is aborted");
  }
});

test("a probe that cannot reach the daemon says so; a retrying stream never probes", async () => {
  const r = await closed(new Error("net"));
  assert.match(r.notices[0]!, /The daemon could not be reached/);
  let probes = 0;
  const s = boot({ fetch: () => (probes++, Promise.resolve({ status: 200 })) });
  s.sources[0]!.readyState = 0;
  s.sources[0]!.fire("error");
  await settle();
  assert.equal(probes, 0);
  assert.deepEqual(s.take(), []);
});

test("a frame arriving while the probe is pending cancels the notice", async () => {
  const s = boot({ fetch: () => Promise.resolve({ status: 200 }) });
  s.sources[0]!.readyState = 2;
  s.sources[0]!.fire("error");
  s.cmd(1, { cmd: "reset" });
  await settle();
  assert.deepEqual(s.take(), ["dismiss:ui-stream", "reset"]);
});
