import { test } from "node:test";
import assert from "node:assert/strict";
import { Script, createContext, runInContext } from "node:vm";
import { BROWSER_LOGIC_JS, BROWSER_WS_PATH, renderBrowserView } from "./browserView.ts";
import { PANE_KIT_JS } from "./paneKit.ts";
import { renderTerminalPane } from "./tabs.ts";
import { renderShell } from "./shell.ts";
import { TERM_LOGIC_JS } from "./termKit.ts";

// ---- BrowserKit: the pure logic ----------------------------------------------------------------------------------

const kit = (() => {
  const ctx = createContext({ JSON, Math });
  runInContext(`${BROWSER_LOGIC_JS}\nglobalThis.out = BrowserKit;`, ctx);
  const raw = (ctx as { out: Record<string, (...a: unknown[]) => unknown> }).out;
  // Results are copied into this realm so deepStrictEqual compares structure, not the vm realm's prototypes.
  const plain =
    (f: (...a: unknown[]) => unknown) =>
    (...a: unknown[]) => {
      const r = f(...a);
      return r === undefined ? r : JSON.parse(JSON.stringify(r));
    };
  return { ...raw, parseServerText: plain(raw.parseServerText!), fitRect: plain(raw.fitRect!) } as unknown as {
    parseServerText(s: unknown): unknown;
    fitRect(a: unknown, b: unknown, c: unknown, d: unknown): { x: number; y: number; w: number; h: number } | null;
    frameGate(): { offer(f: unknown): unknown; done(): unknown; reset(): void };
    stopLabel(d: unknown): string;
  };
})();

test("parseServerText accepts exactly the documented status and closed shapes", () => {
  assert.deepEqual(kit.parseServerText('{"type":"status","state":"live","url":"https://x.test/","title":"T","width":1280,"height":720}'), {
    type: "status",
    state: "live",
    url: "https://x.test/",
    title: "T",
    width: 1280,
    height: 720,
  });
  assert.deepEqual(kit.parseServerText('{"type":"status","state":"no-browser"}'), { type: "status", state: "no-browser" });
  assert.deepEqual(kit.parseServerText('{"type":"closed","reason":"ended"}'), { type: "closed", reason: "ended" });
});

test("parseServerText ignores everything else and drops mistyped optional fields", () => {
  for (const bad of [
    "not json",
    "null",
    "[]",
    '"status"',
    '{"type":"status"}',
    '{"type":"status","state":"exploding"}',
    '{"type":"closed","reason":"because"}',
    '{"type":"resize","cols":1,"rows":1}',
    '{"type":"navigate","url":"https://evil.test"}',
    `{"type":"status","state":"live","pad":"${"x".repeat(5000)}"}`,
  ]) {
    assert.equal(kit.parseServerText(bad), null, bad);
  }
  assert.equal(kit.parseServerText(42), null);
  // wrong-typed or out-of-range optionals are dropped; control characters are removed; fields are capped at 512
  assert.deepEqual(kit.parseServerText('{"type":"status","state":"live","url":7,"title":"a\\u0000b\\u001b[31m","width":0,"height":9}'), {
    type: "status",
    state: "live",
    title: "ab[31m",
  });
  assert.deepEqual(kit.parseServerText('{"type":"status","state":"live","width":1.5,"height":99999}'), { type: "status", state: "live" });
  const long = kit.parseServerText(`{"type":"status","state":"live","url":"${"u".repeat(900)}"}`) as { url: string };
  assert.equal(long.url.length, 512);
});

test("fitRect scales to fit preserving aspect, centred; unusable sizes give null", () => {
  assert.deepEqual(kit.fitRect(1280, 720, 640, 640), { x: 0, y: 140, w: 640, h: 360 }); // wide frame, square box: letterbox
  assert.deepEqual(kit.fitRect(720, 1280, 640, 360), { x: 218.75, y: 0, w: 202.5, h: 360 }); // tall frame: pillarbox
  assert.deepEqual(kit.fitRect(100, 100, 200, 200), { x: 0, y: 0, w: 200, h: 200 }); // upscales
  for (const bad of [
    [0, 1, 1, 1],
    [1, 0, 1, 1],
    [1, 1, 0, 1],
    [1, 1, 1, NaN],
    [-1, 1, 1, 1],
    ["1", 1, 1, 1],
  ]) {
    assert.equal(kit.fitRect(...(bad as [unknown, unknown, unknown, unknown])), null, JSON.stringify(bad));
  }
});

test("frameGate decodes one frame at a time and keeps only the newest pending frame", () => {
  const g = kit.frameGate();
  assert.equal(g.offer("a"), "a");
  assert.equal(g.offer("b"), null);
  assert.equal(g.offer("c"), null); // replaces b
  assert.equal(g.done(), "c");
  assert.equal(g.done(), null);
  assert.equal(g.offer("d"), "d"); // idle again
  g.reset();
  assert.equal(g.offer("e"), "e"); // reset forgets a decode that never finished
});

test("stopLabel words TermKit's terminal-flavoured stops for the browser", () => {
  assert.equal(kit.stopLabel({ conn: "no terminal", label: "No live terminal: agent exited" }), "ended");
  assert.equal(kit.stopLabel({ conn: "no agent", label: "agent not found" }), "agent not found");
  assert.equal(kit.stopLabel({ conn: "yielded", label: "Yielded: ..." }), "no browser: agent is waiting");
  assert.equal(kit.stopLabel({ conn: "disconnected", label: "disconnected — gave up reconnecting" }), "disconnected — gave up reconnecting");
});

// ---- the mounted view, in a fake DOM -----------------------------------------------------------------------------

interface Node_ {
  tagName: string;
  className: string;
  textContent: string;
  style: Record<string, string>;
  children: Node_[];
  attrs: Map<string, string>;
  clientWidth: number;
  clientHeight: number;
  width: number;
  height: number;
  appendChild(c: Node_): void;
  replaceChildren(...n: Node_[]): void;
  setAttribute(k: string, v: string): void;
  getContext(kind: string): Ctx2d | null;
}
interface Ctx2d {
  draws: { bmp: Bitmap; x: number; y: number; w: number; h: number }[];
  clears: number;
  clearRect(): void;
  drawImage(bmp: Bitmap, x: number, y: number, w: number, h: number): void;
}
interface Bitmap {
  width: number;
  height: number;
  closed: boolean;
  blob: Blob;
  close(): void;
}

function walk(n: Node_, fn: (x: Node_) => void): void {
  fn(n);
  for (const c of n.children) walk(c, fn);
}

function setup(opts: { agent?: string; responses?: Record<string, { status?: number; body: unknown }> } = {}) {
  const ctx2d: Ctx2d = {
    draws: [],
    clears: 0,
    clearRect() {
      this.clears++;
    },
    drawImage(bmp, x, y, w, h) {
      this.draws.push({ bmp, x, y, w, h });
    },
  };
  const makeNode = (tag: string): Node_ => {
    const n: Node_ = {
      tagName: tag,
      className: "",
      textContent: "",
      style: {},
      children: [],
      attrs: new Map(),
      clientWidth: 800,
      clientHeight: 450,
      width: 300,
      height: 150,
      appendChild(c) {
        n.children.push(c);
      },
      replaceChildren(...k) {
        n.children = k;
      },
      setAttribute(k, v) {
        n.attrs.set(k, v);
      },
      getContext: (kind) => (kind === "2d" ? ctx2d : null),
    };
    return n;
  };
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    url: string;
    readyState = 0;
    binaryType = "";
    sent: unknown[] = [];
    closed = false;
    onopen?: () => void;
    onmessage?: (ev: { data: unknown }) => void;
    onclose?: () => void;
    onerror?: () => void;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
    send(x: unknown) {
      this.sent.push(x);
    }
    close() {
      this.closed = true;
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    drop() {
      this.readyState = 3;
      this.onclose?.();
    }
    text(o: unknown) {
      this.onmessage?.({ data: typeof o === "string" ? o : JSON.stringify(o) });
    }
    frame(bytes: number[] = [0xff, 0xd8, 0xff, 1]) {
      this.onmessage?.({ data: new Uint8Array(bytes).buffer });
    }
  }
  // createImageBitmap: every call parks until the test resolves it, so a frame can arrive mid-decode.
  const decodes: { blob: Blob; resolve(b: Bitmap): void; reject(e: Error): void }[] = [];
  const createImageBitmap = (blob: Blob) =>
    new Promise<Bitmap>((resolve, reject) => {
      decodes.push({ blob, resolve, reject });
    });
  const bitmap = (blob: Blob, w = 1280, h = 720): Bitmap => ({
    width: w,
    height: h,
    closed: false,
    blob,
    close() {
      this.closed = true;
    },
  });
  const timeouts: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const intervals: { fn: () => void; cleared: boolean }[] = [];
  const fetches: string[] = [];
  const responses = opts.responses ?? {};
  const sandbox = {
    document: { createElement: makeNode },
    location: { protocol: "http:", host: "ui.test" },
    WebSocket: FakeSocket,
    createImageBitmap,
    Blob,
    Uint8Array,
    JSON,
    Math,
    Date,
    Object,
    Promise,
    encodeURIComponent,
    fetch: (url: string) => {
      fetches.push(url);
      const r = responses[url] ?? { body: { state: "running" } };
      const status = r.status ?? 200;
      return Promise.resolve({ ok: status < 400, status, json: async () => r.body });
    },
    setTimeout: (fn: () => void, ms: number) => timeouts.push({ fn, ms, cleared: false }),
    clearTimeout: (n: number) => {
      if (timeouts[n - 1]) timeouts[n - 1]!.cleared = true;
    },
    setInterval: (fn: () => void) => intervals.push({ fn, cleared: false }),
    clearInterval: (n: number) => {
      if (intervals[n - 1]) intervals[n - 1]!.cleared = true;
    },
  };
  const context = createContext(sandbox);
  const script = /<script>([\s\S]*?)<\/script>/.exec(renderBrowserView())![1]!;
  runInContext(script, context, { filename: "browser-view.js" });
  const kitK = runInContext("PaneKit", context) as {
    view(
      id: string,
    ): { id: string; title: string; multi: boolean; mount(root: Node_, p: { agent: string }, h: unknown): { unmount(): void; fit?(): void } } | undefined;
    views(): { id: string }[];
  };
  const titles: string[] = [];
  const root = makeNode("div");
  const def = kitK.view("browser")!;
  const handle = def.mount(root, { agent: opts.agent ?? "agent-1" }, { setTitle: (t: string) => titles.push(t), navigate: () => {} });
  const find = (pred: (n: Node_) => boolean): Node_ | undefined => {
    let hit: Node_ | undefined;
    walk(root, (n) => {
      if (!hit && pred(n)) hit = n;
    });
    return hit;
  };
  const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  return { kitK, def, handle, root, sockets, decodes, bitmap, ctx2d, titles, timeouts, intervals, fetches, find, flush };
}

const live = { type: "status", state: "live", url: "https://example.test/page", title: "Example page", width: 1280, height: 720 };
const stateText = (t: ReturnType<typeof setup>) => t.find((n) => n.className.startsWith("state"))!.textContent;

test("the view registers as 'browser' (multi), dials the browser route and titles the tile", () => {
  const t = setup({ agent: "agent-12345678-abcd" });
  assert.equal(t.def.id, "browser");
  assert.equal(t.def.title, "Browser");
  assert.equal(t.def.multi, true);
  assert.equal(
    t.kitK
      .views()
      .map((v) => v.id)
      .join(),
    "browser",
  );
  assert.equal(BROWSER_WS_PATH, "/v1/agents/:id/browser");
  assert.equal(t.sockets.length, 1);
  assert.equal(t.sockets[0]!.url, "ws://ui.test/v1/agents/agent-12345678-abcd/browser");
  assert.equal(t.sockets[0]!.binaryType, "arraybuffer");
  assert.deepEqual(t.titles, ["Browser · agent-12"]);
  assert.ok(
    t.find((n) => n.textContent === "Content controlled by the agent"),
    "fixed agent-controlled note",
  );
  assert.equal(stateText(t), "connecting");
});

test("a binary frame is decoded as image/jpeg and drawn scaled to fit the canvas", async () => {
  const t = setup();
  const ws = t.sockets[0]!;
  ws.open();
  ws.frame([0xff, 0xd8, 0xff, 9]);
  assert.equal(t.decodes.length, 1);
  assert.equal(t.decodes[0]!.blob.type, "image/jpeg");
  assert.deepEqual([...new Uint8Array(await t.decodes[0]!.blob.arrayBuffer())], [0xff, 0xd8, 0xff, 9]);
  t.decodes[0]!.resolve(t.bitmap(t.decodes[0]!.blob, 1280, 720));
  await t.flush();
  assert.equal(t.ctx2d.draws.length, 1);
  // 1280x720 into the fake 800x450 canvas: fills it exactly
  assert.deepEqual({ ...t.ctx2d.draws[0]!, bmp: undefined }, { bmp: undefined, x: 0, y: 0, w: 800, h: 450 });
  const canvas = t.find((n) => n.tagName === "canvas")!;
  assert.deepEqual([canvas.width, canvas.height], [800, 450]);
});

test("a frame arriving mid-decode replaces the pending one; the stale bitmap is closed", async () => {
  const t = setup();
  const ws = t.sockets[0]!;
  ws.open();
  ws.frame([0xff, 0xd8, 0xff, 1]);
  ws.frame([0xff, 0xd8, 0xff, 2]); // pending
  ws.frame([0xff, 0xd8, 0xff, 3]); // replaces the pending one
  assert.equal(t.decodes.length, 1, "only one decode in flight");
  t.decodes[0]!.resolve(t.bitmap(t.decodes[0]!.blob));
  await t.flush();
  assert.equal(t.decodes.length, 2, "exactly one follow-up decode, for the newest frame");
  assert.deepEqual([...new Uint8Array(await t.decodes[1]!.blob.arrayBuffer())], [0xff, 0xd8, 0xff, 3]);
  const first = t.ctx2d.draws[0]!.bmp;
  t.decodes[1]!.resolve(t.bitmap(t.decodes[1]!.blob));
  await t.flush();
  assert.equal(t.ctx2d.draws.length, 2);
  assert.equal(first.closed, true, "the replaced bitmap is closed");
  assert.equal(t.ctx2d.draws[1]!.bmp.closed, false);
});

test("a failed decode is skipped and the next pending frame still decodes", async () => {
  const t = setup();
  const ws = t.sockets[0]!;
  ws.open();
  ws.frame();
  ws.frame([0xff, 0xd8, 0xff, 5]);
  t.decodes[0]!.reject(new Error("bad jpeg"));
  await t.flush();
  assert.equal(t.decodes.length, 2);
  t.decodes[1]!.resolve(t.bitmap(t.decodes[1]!.blob));
  await t.flush();
  assert.equal(t.ctx2d.draws.length, 1);
});

test("status messages set the status line; url and title go in as textContent only", () => {
  const t = setup();
  const ws = t.sockets[0]!;
  ws.open();
  const evil = { ...live, url: '<img src=x onerror="alert(1)">', title: "<script>alert(2)</script>" };
  ws.text(evil);
  assert.equal(stateText(t), "live");
  const page = t.find((n) => n.textContent.includes("<script>alert(2)</script>"))!;
  assert.equal(page.textContent, '<script>alert(2)</script> — <img src=x onerror="alert(1)">');
  assert.equal(page.children.length, 0, "no element was parsed out of the text");
  ws.text({ type: "status", state: "no-browser" });
  assert.equal(stateText(t), "no browser running");
  assert.equal(t.find((n) => n.className === "meta" && n.textContent.includes("alert"))?.textContent ?? "", "", "page url/title cleared");
  ws.text({ type: "status", state: "connecting" });
  assert.equal(stateText(t), "connecting");
});

test("no-browser clears the canvas and closes the held bitmap", async () => {
  const t = setup();
  const ws = t.sockets[0]!;
  ws.open();
  ws.frame();
  t.decodes[0]!.resolve(t.bitmap(t.decodes[0]!.blob));
  await t.flush();
  const bmp = t.ctx2d.draws[0]!.bmp;
  const clears = t.ctx2d.clears;
  ws.text({ type: "status", state: "no-browser" });
  assert.equal(bmp.closed, true);
  assert.ok(t.ctx2d.clears > clears);
});

test("a decode in flight when no-browser arrives draws nothing and closes its bitmap", async () => {
  const t = setup();
  const ws = t.sockets[0]!;
  ws.open();
  ws.frame();
  assert.equal(t.decodes.length, 1);
  ws.text({ type: "status", state: "no-browser" });
  const bmp = t.bitmap(t.decodes[0]!.blob);
  t.decodes[0]!.resolve(bmp);
  await t.flush();
  assert.equal(t.ctx2d.draws.length, 0, "the stale frame is not drawn over the cleared canvas");
  assert.equal(bmp.closed, true);
});

test("a decode in flight across a reconnect draws nothing and closes its bitmap", async () => {
  const t = setup();
  const ws = t.sockets[0]!;
  ws.open();
  ws.frame();
  ws.text({ type: "closed", reason: "error" });
  ws.drop();
  await t.flush();
  t.timeouts[0]!.fn();
  assert.equal(t.sockets.length, 2);
  const bmp = t.bitmap(t.decodes[0]!.blob);
  t.decodes[0]!.resolve(bmp);
  await t.flush();
  assert.equal(t.ctx2d.draws.length, 0);
  assert.equal(bmp.closed, true);
});

test("a stale decode finishing after a gate reset does not clear the new decode's busy flag", async () => {
  const t = setup();
  const ws = t.sockets[0]!;
  ws.open();
  ws.frame();
  ws.text({ type: "status", state: "no-browser" });
  ws.frame([0xff, 0xd8, 0xff, 2]);
  assert.equal(t.decodes.length, 2, "the new frame starts a decode after the reset");
  t.decodes[0]!.resolve(t.bitmap(t.decodes[0]!.blob));
  await t.flush();
  ws.frame([0xff, 0xd8, 0xff, 3]);
  assert.equal(t.decodes.length, 2, "still one decode in flight: the third frame waits");
  t.decodes[1]!.resolve(t.bitmap(t.decodes[1]!.blob));
  await t.flush();
  assert.equal(t.decodes.length, 3);
});

test("unknown and malformed text messages are ignored", () => {
  const t = setup();
  const ws = t.sockets[0]!;
  ws.open();
  ws.text(live);
  const before = JSON.stringify([stateText(t), t.find((n) => n.textContent.includes("Example page"))?.textContent]);
  for (const junk of ["garbage", { type: "navigate", url: "https://evil.test" }, { type: "status", state: "bogus" }, { type: "closed", reason: "weird" }, "[]"])
    ws.text(junk);
  assert.equal(JSON.stringify([stateText(t), t.find((n) => n.textContent.includes("Example page"))?.textContent]), before);
  assert.equal(t.sockets.length, 1);
});

test("the view never sends on the socket, whatever it receives or however it reconnects", async () => {
  const t = setup();
  const ws = t.sockets[0]!;
  ws.open();
  ws.text(live);
  ws.frame();
  t.decodes[0]!.resolve(t.bitmap(t.decodes[0]!.blob));
  await t.flush();
  t.handle.fit?.();
  ws.text({ type: "closed", reason: "local" });
  ws.drop();
  await t.flush();
  t.timeouts[0]!.fn(); // the backoff timer fires: second socket
  const ws2 = t.sockets[1]!;
  ws2.open();
  ws2.text(live);
  t.handle.unmount();
  assert.deepEqual(ws.sent, []);
  assert.deepEqual(ws2.sent, []);
  assert.ok(!/\.send\(/.test(renderBrowserView()), "the shipped script contains no send call");
});

test("a dropped socket for a running agent reconnects with backoff; a finished agent stops as 'ended'", async () => {
  const t = setup();
  const ws = t.sockets[0]!;
  ws.open();
  ws.text(live);
  ws.text({ type: "closed", reason: "local" });
  ws.drop();
  await t.flush();
  assert.equal(stateText(t), "reconnecting");
  assert.equal(t.timeouts.length, 1);
  assert.ok(t.timeouts[0]!.ms >= 375 && t.timeouts[0]!.ms <= 625, "first backoff step 0.5s +-25%");
  assert.ok(t.find((n) => /reconnecting \(attempt 1\) in \d+s/.test(n.textContent)));
  t.timeouts[0]!.fn();
  assert.equal(t.sockets.length, 2);

  const done = setup({ responses: { "/v1/agents/agent-1": { body: { state: "exited" } } } });
  done.sockets[0]!.text({ type: "closed", reason: "ended" });
  done.sockets[0]!.drop();
  await done.flush();
  assert.equal(stateText(done), "ended");
  assert.equal(done.timeouts.length, 0, "no retry for a finished agent");
  assert.ok(done.find((n) => n.textContent === "Stream closed: ended"));
});

test("an agent that is not running (socket closed before upgrade) takes the lookup-and-decide path", async () => {
  const missing = setup({ responses: { "/v1/agents/agent-1": { status: 404, body: {} } } });
  missing.sockets[0]!.drop(); // never opened: the daemon refused the upgrade (409/404)
  await missing.flush();
  assert.deepEqual(missing.fetches, ["/v1/agents/agent-1"]);
  assert.equal(stateText(missing), "agent not found");
  assert.equal(missing.timeouts.length, 0);

  const yielded = setup({ responses: { "/v1/agents/agent-1": { body: { state: "yielded" } } } });
  yielded.sockets[0]!.drop();
  await yielded.flush();
  assert.equal(stateText(yielded), "no browser: agent is waiting");
  assert.equal(yielded.timeouts.length, 0);

  const pending = setup({ responses: { "/v1/agents/agent-1": { body: { state: "pending" } } } }); // negative control: retries
  pending.sockets[0]!.drop();
  await pending.flush();
  assert.equal(pending.timeouts.length, 1);
  assert.equal(stateText(pending), "reconnecting");
});

test("unmount closes the socket, cancels the backoff timers, closes the bitmap and ignores late events", async () => {
  const t = setup();
  const ws = t.sockets[0]!;
  ws.open();
  ws.frame();
  t.decodes[0]!.resolve(t.bitmap(t.decodes[0]!.blob));
  await t.flush();
  const bmp = t.ctx2d.draws[0]!.bmp;
  t.handle.unmount();
  assert.equal(ws.closed, true);
  assert.equal(bmp.closed, true);
  assert.equal(t.root.children.length, 0);
  // a decode finishing after unmount draws nothing and is closed
  ws.frame();
  ws.drop();
  await t.flush();
  assert.equal(t.sockets.length, 1);

  // unmount during a backoff wait cancels the timer and the countdown
  const u = setup();
  u.sockets[0]!.open();
  u.sockets[0]!.drop();
  await u.flush();
  assert.equal(u.timeouts.length, 1);
  u.handle.unmount();
  assert.equal(u.timeouts[0]!.cleared, true);
  assert.ok(u.intervals.length > 0 && u.intervals.every((i) => i.cleared));
  u.handle.unmount(); // idempotent
});

test("a decode that finishes after unmount is closed, never drawn", async () => {
  const t = setup();
  t.sockets[0]!.open();
  t.sockets[0]!.frame();
  t.handle.unmount();
  const late = t.bitmap(t.decodes[0]!.blob);
  t.decodes[0]!.resolve(late);
  await t.flush();
  assert.equal(late.closed, true);
  assert.equal(t.ctx2d.draws.length, 0);
});

test("no agent selected: no socket, a hint, and the plain title", () => {
  const t = setup({ agent: "" });
  assert.equal(t.sockets.length, 0);
  assert.equal(t.titles.join("|"), "Browser");
  assert.ok(t.find((n) => n.textContent.startsWith("no agent selected")));
  t.handle.unmount();
});

// ---- shipping --------------------------------------------------------------------------------------------------

test("the view script ships inside a rendered shell next to the terminal tab and registers with the real PaneKit", () => {
  const html = renderShell({
    tabs: [{ id: "terminal", title: "Terminal", render: () => renderTerminalPane() + renderBrowserView() }],
    prefix: "/",
  });
  assert.ok(html.includes('K.registerView({ id: "browser", title: "Browser", multi: true'));
  assert.ok(!html.includes('data-nav="browser"'), "no top-level nav entry");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  for (const s of scripts) assert.doesNotThrow(() => new Script(s));
  assert.ok(!/innerHTML/.test(renderBrowserView()), "no innerHTML anywhere in the view");
  assert.ok(renderBrowserView().includes(PANE_KIT_JS.slice(0, 40)) && renderBrowserView().includes(TERM_LOGIC_JS.slice(0, 40)));
});

test("agentsBase and browserPath are script-escaped and cannot close the script", () => {
  const html = renderBrowserView({ agentsBase: "</script><script>alert(1)</script>", browserPath: "/x/:id/b" });
  assert.equal(html.match(/<\/script>/g)!.length, 1);
  assert.ok(html.includes('"/x/:id/b"'));
});
