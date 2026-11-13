import { test } from "node:test";
import assert from "node:assert/strict";
import { Script, createContext, runInContext } from "node:vm";
import { BROWSER_LOGIC_JS, BROWSER_WS_PATH, renderBrowserView } from "./browserView.ts";
import { PANE_KIT_JS } from "./paneKit.ts";
import { renderTerminalPane } from "./tabs.ts";
import { renderShell } from "./shell.ts";
import { MENU_KIT_JS, type MenuKitApi } from "./menuModel.ts";
import { BROWSER_DECLARATION } from "./viewMenus.ts";
import { TERM_LOGIC_JS } from "./termKit.ts";

// The reconnect jitter (+-25%, Math.random) can land a retry delay on exactly 800 ms, the overlay grace delay these tests tell
// timers apart by. A pinned midpoint makes every backoff the exact base step (500, 1000, ...), never 800.
const unjitteredMath = Object.assign(Object.create(Math) as Math, { random: () => 0.5 });

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
  return { ...raw, parseServerText: plain(raw.parseServerText!), fitRect: plain(raw.fitRect!), drawPlan: plain(raw.drawPlan!) } as unknown as {
    parseServerText(s: unknown): unknown;
    fitRect(a: unknown, b: unknown, c: unknown, d: unknown): { x: number; y: number; w: number; h: number } | null;
    drawPlan(
      mode: unknown,
      a: unknown,
      b: unknown,
      c: unknown,
      d: unknown,
    ): { canvasW: number; canvasH: number; rect: { x: number; y: number; w: number; h: number } } | null;
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

test("drawPlan: fit keeps today's aspect-preserving plan; actual size is natural pixels at the origin; bad sizes give null", () => {
  assert.deepEqual(kit.drawPlan("fit", 1280, 720, 640, 640), { canvasW: 640, canvasH: 640, rect: { x: 0, y: 140, w: 640, h: 360 } });
  assert.deepEqual(kit.drawPlan("actual", 1280, 720, 640, 640), { canvasW: 1280, canvasH: 720, rect: { x: 0, y: 0, w: 1280, h: 720 } });
  assert.equal(kit.drawPlan("fit", 0, 720, 640, 640), null);
  assert.equal(kit.drawPlan("actual", 1280, NaN, 640, 640), null);
  assert.equal(kit.drawPlan("fit", 1280, 720, 0, 640), null);
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
  hidden?: boolean;
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

function setup(
  opts: { agent?: string; params?: { agent?: string }; clipboardFails?: boolean; responses?: Record<string, { status?: number; body: unknown }> } = {},
) {
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
  const clipboard: string[] = [];
  const statuses: { slot: string; text: string; tone?: string | null }[] = [];
  const menuStates: { command: string; state: Record<string, unknown> }[] = [];
  let onCommand: (command: string, arg?: unknown) => void = () => {};
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
    navigator: {
      clipboard: {
        writeText: (text: string) => {
          if (opts.clipboardFails) return Promise.reject(new Error("denied"));
          clipboard.push(text);
          return Promise.resolve();
        },
      },
    },
    location: { protocol: "http:", host: "ui.test" },
    WebSocket: FakeSocket,
    createImageBitmap,
    Blob,
    Uint8Array,
    JSON,
    Math: unjitteredMath,
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
  const menuKit = runInContext(
    `(() => { ${MENU_KIT_JS}; return MenuKit; })()`,
    createContext({ globalThis: {}, JSON, Object, Array, Set, Map, String, Error, WeakSet }),
  ) as MenuKitApi;
  const windowModel = menuKit.createWindowModel(menuKit.declareView(BROWSER_DECLARATION));
  const root = makeNode("div");
  const def = kitK.view("browser")!;
  const mount = () =>
    def.mount(root, ("params" in opts ? opts.params : { agent: opts.agent ?? "agent-1" }) as { agent: string }, {
      setTitle: (t: string) => titles.push(t),
      navigate: () => {},
      // The REAL status validator (the window model the chrome gives a view), so a bad tone fails the mount like in the browser.
      setStatus: (slot: string, v: { text: string; tone?: string | null }) => {
        windowModel.setStatus(slot, v as never);
        statuses.push({ slot, ...v });
      },
      setMenuState: (command: string, state: Record<string, unknown>) => menuStates.push({ command, state }),
      onCommand: (f: typeof onCommand) => {
        onCommand = f;
      },
    });
  let handle: ReturnType<typeof mount>;
  try {
    handle = mount();
  } catch (e) {
    (e as { root?: Node_ }).root = root;
    throw e;
  }
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
  const last = (slot: string) => [...statuses].reverse().find((x) => x.slot === slot);
  const lastState = (command: string) => {
    const st = [...menuStates].reverse().find((x) => x.command === command)?.state;
    return st && JSON.parse(JSON.stringify(st));
  };
  return {
    statuses,
    menuStates,
    last,
    lastState,
    clipboard,
    command: (c: string, a?: unknown) => onCommand(c, a),
    kitK,
    def,
    handle,
    root,
    sockets,
    decodes,
    bitmap,
    ctx2d,
    titles,
    timeouts,
    intervals,
    fetches,
    find,
    flush,
  };
}

const live = { type: "status", state: "live", url: "https://example.test/page", title: "Example page", width: 1280, height: 720 };
// The "stream" footer slot: the state, optionally followed by " — detail".
const streamText = (t: ReturnType<typeof setup>) => t.last("stream")!.text;
const stateText = (t: ReturnType<typeof setup>) => streamText(t).split(" \u2014 ")[0]!;

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
  assert.equal(
    t.find((n) => n.textContent === "Content controlled by the agent"),
    undefined,
    "no permanent note row: the footer and Help menu carry it",
  );
  assert.equal(stateText(t), "connecting");
  assert.equal(
    t.find((n) => n.className.startsWith("state")),
    undefined,
    "no in-pane status text: the footer owns it",
  );
  assert.equal(
    t.find((n) => n.tagName === "strong"),
    undefined,
    "no in-pane title bar either",
  );
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
  assert.equal(t.last("url")!.text, '<img src=x onerror="alert(1)">', "the footer gets the raw string for textContent");
  assert.equal(
    t.find((n) => n.textContent.includes("alert")),
    undefined,
    "nothing agent-controlled is painted inside the pane",
  );
  ws.text({ type: "status", state: "no-browser" });
  assert.equal(stateText(t), "no browser running");
  assert.equal(t.last("url")!.text, "", "page url cleared");
  ws.text({ type: "status", state: "connecting" });
  assert.equal(stateText(t), "connecting");
});

test("no-browser keeps the last frame (bitmap held, canvas not cleared) under a danger overlay", async () => {
  const t = setup();
  const ws = t.sockets[0]!;
  ws.open();
  ws.frame();
  t.decodes[0]!.resolve(t.bitmap(t.decodes[0]!.blob));
  await t.flush();
  const bmp = t.ctx2d.draws[0]!.bmp;
  const clears = t.ctx2d.clears;
  ws.text({ type: "status", state: "no-browser" });
  assert.equal(bmp.closed, false);
  assert.equal(t.ctx2d.clears, clears);
  assert.deepEqual(overlay(t), { hidden: false, kind: "dead", label: "No browser running", icon: "stale-icon", role: "status", live: "polite" });
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
  const before = JSON.stringify([stateText(t), t.last("url")]);
  for (const junk of ["garbage", { type: "navigate", url: "https://evil.test" }, { type: "status", state: "bogus" }, { type: "closed", reason: "weird" }, "[]"])
    ws.text(junk);
  assert.equal(JSON.stringify([stateText(t), t.last("url")]), before);
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
  t.timeouts.find((x) => x.ms !== 800)!.fn(); // the backoff timer fires (not the overlay grace timer): second socket
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
  assert.ok(/reconnecting \(attempt 1\) in \d+s/.test(streamText(t)));
  t.timeouts[0]!.fn();
  assert.equal(t.sockets.length, 2);

  const done = setup({ responses: { "/v1/agents/agent-1": { body: { state: "exited" } } } });
  done.sockets[0]!.text({ type: "closed", reason: "ended" });
  done.sockets[0]!.drop();
  await done.flush();
  assert.equal(stateText(done), "ended");
  assert.equal(done.timeouts.length, 0, "no retry for a finished agent");
  assert.equal(streamText(done), "ended \u2014 Stream closed: ended");
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

test("mounting without an agent throws a cause-and-action error and leaves the root empty", () => {
  for (const params of [{}, undefined, { agent: "" }]) {
    let thrown: unknown;
    try {
      setup({ agent: "", params });
    } catch (e) {
      thrown = e;
    }
    assert.equal((thrown as Error).message, "browser needs an agent id; open it from the Tree or the top bar");
    assert.equal((thrown as { root?: Node_ }).root!.children.length, 0, "root holds no half-built markup");
  }
  const probe = setup({ agent: "agent-1" }); // negative control: with an agent the same harness mounts fine
  assert.equal(probe.sockets.length, 1);
});

test("the pane root is pane-fill and the canvas has no padding wrapper", () => {
  const t = setup();
  assert.equal(t.root.children[0]!.className, "browser pane pane-fill stale-host");
});

test("no note row sits above the canvas: the first visible child is the canvas, and the footer carries the agent-controlled note", () => {
  const t = setup();
  const kids = t.root.children[0]!.children;
  const firstVisible = kids.find((n) => !n.hidden)!;
  assert.equal(firstVisible.tagName, "canvas");
  assert.ok(!kids.some((n) => n.tagName === "p" && !n.hidden));
  const decl = t.kitK as unknown as { declaration(id: string): { status: { id: string; text?: string }[] } };
  const slot = decl.declaration("browser").status.find((x) => x.id === "view-only")!;
  assert.ok(/view-only/.test(slot.text ?? "") && /agent/.test(slot.text ?? ""), "the view-only slot text names the agent-controlled content");
});

test("a page title from the stream titles the tile as text; none keeps the id title, and no-browser restores it", () => {
  const t = setup({ agent: "agent-12345678-abcd" });
  const ws = t.sockets[0]!;
  ws.open();
  ws.text({ type: "status", state: "connecting" });
  assert.deepEqual(t.titles, ["Browser · agent-12"], "no title yet: nothing invented");
  ws.text(live);
  assert.equal(t.titles.at(-1), "Browser · Example page");
  assert.equal(t.last("url")!.text, "https://example.test/page", "the URL stays in the footer");
  ws.text({ type: "status", state: "no-browser" });
  assert.equal(t.titles.at(-1), "Browser · agent-12");
});

test("a long page title is capped in the tile title, with an ellipsis; a short one is untouched", () => {
  const t = setup();
  const ws = t.sockets[0]!;
  ws.open();
  ws.text({ ...live, title: "T".repeat(500) });
  const named = t.titles.at(-1)!;
  assert.equal(named, "Browser \u00b7 " + "T".repeat(79) + "\u2026", "capped at 80 characters of title, last one an ellipsis");
  ws.text({ ...live, title: "T".repeat(80) });
  assert.equal(t.titles.at(-1), "Browser \u00b7 " + "T".repeat(80), "exactly at the cap is not truncated");
});

test("an agent that no longer exists keeps the last frame under a danger overlay and stops reconnecting", async () => {
  const gone = setup({ responses: { "/v1/agents/agent-1": { status: 404, body: {} } } });
  const ws = gone.sockets[0]!;
  await frameShown(gone, ws);
  const bmp = gone.ctx2d.draws[0]!.bmp;
  ws.drop();
  await gone.flush();
  assert.deepEqual(overlay(gone), {
    hidden: false,
    kind: "dead",
    label: "This agent is no longer available",
    icon: "stale-icon",
    role: "status",
    live: "polite",
  });
  assert.equal(gone.find((n) => n.tagName === "canvas")!.style.display, "block", "the canvas stays visible");
  assert.equal(bmp.closed, false, "the last frame is still held");
  assert.equal(gone.timeouts.filter((x) => x.ms !== 800).length, 0);
  assert.equal(gone.sockets.length, 1);
  // negative control: a present agent shows the spinner (after the grace delay), not the danger overlay
  const here = setup({ responses: { "/v1/agents/agent-1": { body: { state: "pending" } } } });
  await frameShown(here, here.sockets[0]!);
  here.sockets[0]!.drop();
  await here.flush();
  assert.notEqual(overlay(here).kind, "dead");
});

// ---- stale overlay -----------------------------------------------------------------------------------------------

const overlay = (t: ReturnType<typeof setup>) => {
  const n = t.find((x) => x.className.split(" ").includes("stale-overlay"))!;
  return {
    hidden: n.hidden === true,
    kind: (n.className.split(" ")[1] ?? "stale-none").slice(6),
    label: n.children[1]!.textContent,
    icon: n.children[0]!.className,
    role: n.attrs.get("role"),
    live: n.attrs.get("aria-live"),
  };
};
const frameShown = async (t: ReturnType<typeof setup>, ws: ReturnType<typeof setup>["sockets"][number]) => {
  ws.open();
  ws.text(live);
  ws.frame();
  t.decodes[t.decodes.length - 1]!.resolve(t.bitmap(t.decodes[t.decodes.length - 1]!.blob));
  await t.flush();
};
const graceTimer = (t: ReturnType<typeof setup>) => t.timeouts.filter((x) => x.ms === 800 && !x.cleared).pop();

test("overlay: the first connect with no frame yet shows a spinner at once; live removes it", () => {
  const t = setup();
  assert.deepEqual(overlay(t), { hidden: false, kind: "busy", label: "Connecting\u2026", icon: "stale-icon stale-spinner", role: "status", live: "polite" });
  assert.equal(graceTimer(t), undefined, "no grace delay when there is nothing to keep");
  t.sockets[0]!.open();
  t.sockets[0]!.text(live);
  assert.equal(overlay(t).hidden, true);
  assert.equal(t.last("stream")!.text, "live", "footer keeps the state text");
});

test("overlay: a drop keeps the frame and shows the spinner only after the grace delay; a quick reconnect never shows it", async () => {
  const t = setup();
  const ws = t.sockets[0]!;
  await frameShown(t, ws);
  const bmp = t.ctx2d.draws[0]!.bmp;
  const clears = t.ctx2d.clears;
  ws.drop();
  await t.flush();
  assert.equal(overlay(t).hidden, true, "not yet: inside the grace delay");
  const timer = graceTimer(t)!;
  assert.ok(timer, "a grace timer is armed");
  timer.fn();
  assert.deepEqual(overlay(t), { hidden: false, kind: "busy", label: "Reconnecting\u2026", icon: "stale-icon stale-spinner", role: "status", live: "polite" });
  assert.equal(bmp.closed, false, "the last frame is still held");
  assert.equal(t.ctx2d.clears, clears, "the canvas was not cleared");
  assert.equal(t.find((n) => n.tagName === "canvas")!.style.display, "block");
  assert.equal(stateText(t), "reconnecting", "footer keeps the state text");
  // quick reconnect: live before the grace timer fires
  t.timeouts.find((x) => x.ms !== 800)!.fn();
  const ws2 = t.sockets[1]!;
  ws2.open();
  ws2.text(live);
  assert.equal(overlay(t).hidden, true);
  // negative control: a drop followed by a live socket before the timer never paints it
  ws2.drop();
  await t.flush();
  const pending = graceTimer(t)!;
  t.timeouts
    .filter((x) => x.ms !== 800 && !x.cleared)
    .pop()!
    .fn();
  t.sockets[2]!.open();
  t.sockets[2]!.text(live);
  assert.equal(pending.cleared, true, "the grace timer was cancelled");
  assert.equal(overlay(t).hidden, true);
});

test("overlay: a finished agent shows a danger icon and the cause over the kept frame, not the waiting pause", async () => {
  const t = setup({ responses: { "/v1/agents/agent-1": { body: { state: "exited" } } } });
  const ws = t.sockets[0]!;
  await frameShown(t, ws);
  ws.text({ type: "closed", reason: "local" });
  ws.drop();
  await t.flush();
  assert.deepEqual(overlay(t), {
    hidden: false,
    kind: "dead",
    label: "Disconnected: ended (stream daemon shut down)",
    icon: "stale-icon",
    role: "status",
    live: "polite",
  });
  assert.equal(stateText(t), "ended", "footer says the same");
  assert.equal(t.ctx2d.draws[0]!.bmp.closed, false);
  // a yielded agent is not a fault: pause icon, no danger
  const y = setup({ responses: { "/v1/agents/agent-1": { body: { state: "yielded" } } } });
  await frameShown(y, y.sockets[0]!);
  y.sockets[0]!.drop();
  await y.flush();
  assert.deepEqual(overlay(y), { hidden: false, kind: "idle", label: "no browser: agent is waiting", icon: "stale-icon", role: "status", live: "polite" });
});

test("overlay: giving up after repeated drops is a danger overlay with the cause", async () => {
  const t = setup();
  const pendingRetries = () => t.timeouts.filter((x) => x.ms !== 800 && !x.cleared);
  // MAX_ATTEMPTS (12) drops each arm a retry; the next drop arms none and gives up.
  for (let i = 0; i < 12; i++) {
    t.sockets[t.sockets.length - 1]!.drop();
    await t.flush();
    const retry = pendingRetries().pop();
    assert.ok(retry, `drop ${i + 1} armed no retry timer (timers: ${JSON.stringify(t.timeouts.map((x) => [x.ms, x.cleared]))}, fetches: ${t.fetches.length})`);
    retry.fn();
  }
  t.sockets[t.sockets.length - 1]!.drop();
  await t.flush();
  assert.equal(pendingRetries().length, 0, "the drop past the budget arms no retry");
  assert.deepEqual(overlay(t), {
    hidden: false,
    kind: "dead",
    label: "Disconnected: gave up reconnecting",
    icon: "stale-icon",
    role: "status",
    live: "polite",
  });
});

test("overlay: unmount hides it and arms nothing", async () => {
  const t = setup();
  await frameShown(t, t.sockets[0]!);
  t.sockets[0]!.drop();
  await t.flush();
  const pending = graceTimer(t)!;
  t.handle.unmount();
  assert.equal(pending.cleared, true);
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

// ---- window chrome: menus, status slots, commands -----------------------------------------------------------------

test("registers the declared menus and status slots, and tones the stream slot", () => {
  const t = setup();
  const decl = t.kitK as unknown as { declaration(id: string): { menus: { id: string }[]; status: { id: string }[] } };
  assert.deepEqual([...decl.declaration("browser").menus.map((m) => m.id)], ["view", "help"]);
  assert.deepEqual([...decl.declaration("browser").status.map((x) => x.id)], ["stream", "view-only", "url"]);
  assert.deepEqual({ ...t.last("stream") }, { slot: "stream", text: "connecting", tone: "warn" });
  t.sockets[0]!.open();
  t.sockets[0]!.text(live);
  assert.deepEqual({ ...t.last("stream") }, { slot: "stream", text: "live", tone: "ok" });
  assert.equal(t.last("url")!.text, "https://example.test/page");
  assert.deepEqual(t.lastState("browser.copy-url"), { enabled: true });
});

test("fit and actual size are mutually exclusive; actual draws at natural pixels in a scrollable pane", async () => {
  const t = setup();
  const ws = t.sockets[0]!;
  ws.open();
  ws.frame();
  t.decodes[0]!.resolve(t.bitmap(t.decodes[0]!.blob, 1280, 720));
  await t.flush();
  const canvas = t.find((n) => n.tagName === "canvas")!;
  assert.deepEqual([canvas.width, canvas.height], [800, 450]);
  t.command("browser.actual-size", true);
  assert.deepEqual(t.lastState("browser.actual-size"), { checked: true });
  assert.deepEqual(t.lastState("browser.fit"), { checked: false });
  assert.deepEqual([canvas.width, canvas.height], [1280, 720]);
  assert.deepEqual([canvas.style.width, canvas.style.height], ["1280px", "720px"]);
  const d = t.ctx2d.draws.at(-1)!;
  assert.deepEqual([d.x, d.y, d.w, d.h], [0, 0, 1280, 720]);
  assert.equal(t.root.children[0]!.style.overflow, "auto");
  t.command("browser.fit", true);
  assert.deepEqual(t.lastState("browser.fit"), { checked: true });
  assert.deepEqual(t.lastState("browser.actual-size"), { checked: false });
  assert.deepEqual([canvas.style.width, canvas.style.height], ["100%", "100%"]);
  assert.deepEqual([canvas.width, canvas.height], [800, 450]);
});

test("copy URL writes the page URL; a blocked clipboard or no URL is reported in the stream slot with cause and action", async () => {
  const t = setup();
  t.sockets[0]!.text(live);
  t.command("browser.copy-url");
  assert.deepEqual(t.clipboard, ["https://example.test/page"]);

  const none = setup();
  none.command("browser.copy-url");
  assert.deepEqual(none.clipboard, []);
  assert.match(none.last("stream")!.text, /^Copy failed: no page URL yet; wait for the page to load/);
  assert.equal(none.last("stream")!.tone, "err");

  const blocked = setup({ clipboardFails: true });
  blocked.sockets[0]!.text(live);
  blocked.command("browser.copy-url");
  await blocked.flush();
  assert.match(blocked.last("stream")!.text, /^Copy failed: the clipboard is unavailable or blocked; select the URL/);
  assert.equal(blocked.last("stream")!.tone, "err");
  blocked.sockets[0]!.text({ type: "status", state: "live" });
  assert.equal(stateText(blocked), "live", "the next state change replaces the failure note");
});

test("about toggles a textContent-only view-only note; the view still adds no input handling", () => {
  const t = setup();
  const about = t.find((n) => n.textContent.startsWith("This view is view-only"))!;
  assert.equal(about.hidden, true);
  assert.equal(about.children.length, 0);
  t.command("browser.about");
  assert.equal(about.hidden, false);
  t.command("browser.about");
  assert.equal(about.hidden, true);
  assert.ok(
    !/addEventListener|onkeydown|onclick|onmouse|onpointer/.test(renderBrowserView().split("const mountBrowserInstance")[1]!),
    "view-only: no input handlers",
  );
});

test("status path: every connection state pushes a validator-accepted tone and the view loads", async () => {
  const t = setup();
  const tones = () => t.statuses.filter((x) => x.slot === "stream").map((x) => x.tone ?? "none");
  assert.equal(
    t.statuses.some((x) => x.tone === ""),
    false,
    "no empty-string tone on mount",
  );
  t.sockets[0]!.open();
  t.sockets[0]!.text(live);
  await t.flush();
  t.sockets[0]!.drop();
  await t.flush();
  for (const tone of tones()) assert.ok(["ok", "warn", "err", "info", "none"].includes(tone), "tone " + tone);
  assert.equal(tones().includes("ok"), true);
  assert.equal(tones().includes("warn"), true);
});

test("status path negative control: the real validator rejects an empty-string tone", () => {
  const menuKit = runInContext(
    `(() => { ${MENU_KIT_JS}; return MenuKit; })()`,
    createContext({ globalThis: {}, JSON, Object, Array, Set, Map, String, Error, WeakSet }),
  ) as MenuKitApi;
  const w = menuKit.createWindowModel(menuKit.declareView(BROWSER_DECLARATION));
  assert.throws(() => w.setStatus("stream", { text: "", tone: "" as never }), /tone "" is not one of ok, warn, err, info; use one of those or null to clear/);
});
