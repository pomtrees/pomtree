import { test } from "node:test";
import { inspect } from "node:util";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { renderShell } from "./shell.ts";
import { LAYOUT_CSS } from "./layoutCss.ts";
import { PANE_CSS } from "./paneKit.ts";
import { LAYOUT_SHELL_JS } from "./layoutShell.ts";
import { MENU_NAV_JS } from "./menuNav.ts";
import { WINDOW_CHROME_JS } from "./windowChrome.ts";
import { CHROME_CSS } from "./chromeCss.ts";
import { Node_ } from "./launcherFakeDom.ts";
import { UI_DRIVER_JS } from "./uiDriver.ts";

// Listeners of the document, window and media query in the sandbox take plain event-like objects.
type Listener = (ev: Record<string, unknown>) => void;

interface Opts {
  hash?: string;
  store?: Record<string, string>;
  setItemThrows?: boolean;
  getItemThrows?: boolean;
  narrow?: boolean;
  tabs?: string[];
  registry?: boolean;
  throwingView?: boolean;
  menus?: boolean; // the terminal view (and the inbox section) declare menus and status
  controlsOnly?: boolean; // the hosts section declares only controls (no menus, no status)
  noChromeKit?: boolean; // ChromeKit is not loaded
  badChrome?: "destroy-missing"; // deliberately wrong fake used to prove a check can fail
}

interface WmApi {
  state(): {
    leaves: { id: string; view: string; params: { agent?: string; report?: string }; hidden: boolean }[];
    focus: string;
    maximized: string;
    narrow: boolean;
    maxLeaves: number;
  };
  views(): { id: string; title: string; multi: boolean }[];
  focus(id: string): void;
  focusDom(): void;
  openView(view: string, agent?: string, report?: string): void;
  splitFocused(dir: "row" | "col"): void;
  closeFocused(): void;
  exportLayout(): void;
  importFile(file: { text(): Promise<string> } | undefined): void;
  resetLayout(): void;
  notify(key: string, text: string): void;
  dismiss(key: string): void;
  focusSubject(view: string, params: { agent?: string; report?: string }): boolean;
  leafOf(view: string, params: { agent?: string; report?: string }): string | null;
  focusedLeaf(): string | null;
  windowCommand(command: string, leafId: string | null): boolean;
  windowMenuItems(leafId: string): { kind: string; command?: string; label?: string; enabled?: boolean; visible?: boolean }[];
  focusDirection(dir: "left" | "right" | "up" | "down"): boolean;
  arrange(preset: "single" | "columns" | "rows" | "grid"): boolean;
  onChange(fn: () => void): () => void;
}

function boot(o: Opts = {}) {
  const tabIds = o.tabs ?? ["tree", "reports", "hosts", "terminal"];
  const html = renderShell({ tabs: tabIds.map((id) => ({ id, title: id.toUpperCase(), render: () => "" })) });
  // the real ChromeKit (windowChrome.ts) is replaced by a fake in the sandbox so these tests do not depend on it
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!.replace(WINDOW_CHROME_JS, ""));
  const chromes: { model: any; controls: Node_; menus: Node_; overflow: Node_; footer: Node_; destroyed: number }[] = [];
  const models: any[] = [];
  const ids = ["wm-root", "wm-notices", "wm-stash"];
  const byId = new Map(ids.map((i) => [i, new Node_("div")]));
  const sections = tabIds.map((id) => {
    const s = new Node_("section");
    s.setAttribute("data-tab", id);
    s.hidden = true;
    byId.get("wm-stash")!.appendChild(s);
    return s;
  });
  const log: string[] = [];
  const mounts: {
    root: Node_;
    view: string;
    params: { agent?: string; report?: string };
    unmounted: boolean;
    fits: number;
    host: { setTitle(t: string): void };
  }[] = [];
  const store = o.store ?? {};
  const writes: string[] = [];
  const docListeners = new Map<string, { fn: Listener; capture: boolean }[]>();
  const winListeners = new Map<string, Listener[]>();
  const rafs: (() => void)[] = [];
  const mqListeners: Listener[] = [];
  const eventSources: { handlers: Map<string, (ev: { data?: string }) => void> }[] = [];
  const mq = { matches: !!o.narrow, addEventListener: (_t: string, fn: Listener) => mqListeners.push(fn) };
  // hash assignments (location.hash = ...) each add a history entry; replaceState swaps the current one in place.
  const assigns: string[] = [];
  const hist = { length: 1 };
  let curHash = o.hash ?? "";
  const location = {
    pathname: "/ui/",
    search: "",
    get hash() {
      return curHash;
    },
    set hash(v: string) {
      assigns.push(v);
      hist.length++;
      curHash = v;
    },
  };
  const replaced: string[] = [];
  const blobs: { parts: unknown[] }[] = [];
  const downloads: Node_[] = [];
  const registry = new Map<string, any>();
  if (o.registry !== false) {
    registry.set("terminal", {
      id: "terminal",
      title: "Terminal",
      multi: true,
      subject: "agent",
      mount(root: Node_, params: { agent?: string }, host: { setTitle(t: string): void }) {
        const rec = { root, view: "terminal", params, unmounted: false, fits: 0, host };
        mounts.push(rec);
        host.setTitle(params.agent ? `Terminal · ${params.agent}` : "Terminal");
        return { unmount: () => (rec.unmounted = true), fit: () => rec.fits++ };
      },
    });
    registry.set("report", {
      id: "report",
      title: "Report",
      multi: true,
      subject: "report",
      mount(root: Node_, params: { agent?: string; report?: string }, host: { setTitle(t: string): void }) {
        const rec = { root, view: "report", params, unmounted: false, fits: 0, host };
        mounts.push(rec);
        host.setTitle(`Report · ${params.report}`);
        return { unmount: () => (rec.unmounted = true), fit: () => rec.fits++ };
      },
    });
  }
  if (o.throwingView) {
    registry.set("boom", {
      id: "boom",
      title: "Boom",
      multi: false,
      mount(root: Node_) {
        const half = new Node_("div");
        root.appendChild(half);
        throw new Error("half-built");
      },
    });
  }
  let sectionModelOf: any;
  const body = new Node_("body");
  const sandbox: Record<string, unknown> = {
    fetch: async () => ({ status: 200 }),
    location: Object.assign(location, { reload() {} }),
    history: {
      replaceState: (_s: unknown, _t: string, url: string) => {
        replaced.push(url);
        curHash = url.startsWith("#") ? url : ""; // a URL without a fragment clears the hash, as in a browser
      },
    },
    document: {
      body,
      getElementById: (i: string) => byId.get(i) ?? null,
      createElement: (t: string) => new Node_(t),
      querySelectorAll: (sel: string) => (sel === "section[data-tab]" ? sections : []),
      addEventListener: (t: string, fn: Listener, capture?: boolean) => {
        const l = docListeners.get(t) ?? [];
        l.push({ fn, capture: !!capture });
        docListeners.set(t, l);
      },
    },
    addEventListener: (t: string, fn: Listener) => winListeners.set(t, [...(winListeners.get(t) ?? []), fn]),
    matchMedia: () => mq,
    requestAnimationFrame: (fn: () => void) => rafs.push(fn),
    EventSource: class {
      handlers = new Map<string, (ev: { data?: string }) => void>();
      readyState = 1;
      constructor() {
        eventSources.push(this);
      }
      addEventListener(t: string, fn: (ev: { data?: string }) => void) {
        this.handlers.set(t, fn);
      }
      close() {}
    },
    setTimeout: () => 0,
    localStorage: {
      getItem: (k: string) => {
        if (o.getItemThrows) throw new Error("storage denied");
        return store[k] ?? null;
      },
      setItem: (k: string, v: string) => {
        if (o.setItemThrows) throw new Error("quota exceeded");
        store[k] = v;
        writes.push(v);
      },
    },
    Blob: class {
      parts: unknown[];
      constructor(parts: unknown[]) {
        this.parts = parts;
        blobs.push(this);
      }
    },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
    Promise,
    JSON,
    Math,
    Object,
    Set,
    Map,
    String,
    Number,
    isFinite,
    decodeURIComponent,
    encodeURIComponent,
    PaneKit:
      o.registry === false
        ? undefined
        : {
            view: (id: string) => registry.get(id),
            views: () => [...registry.values()],
            windowModel: (id: string) => {
              const m = {
                id,
                declaration: {
                  menus: o.menus && id === "terminal" ? [{ id: "view", items: [] }] : [],
                  status: o.menus && id === "terminal" ? [{ id: "connection" }] : [],
                  controls: [],
                },
              };
              models.push(m);
              return m;
            },
            windowHost: (m: any, base: object) => ({ ...base, model: m, setMenuState() {}, setStatus() {}, onCommand() {} }),
            sectionModel: (id: string) => {
              if (!(o.menus || o.controlsOnly) || id !== "hosts") return undefined;
              if (!sectionModelOf)
                sectionModelOf = {
                  id,
                  declaration: o.controlsOnly
                    ? { menus: [], status: [], controls: [{ kind: "button", command: "x.go", label: "Go" }] }
                    : { menus: [{ id: "view", items: [] }], status: [], controls: [] },
                };
              return sectionModelOf;
            },
          },
    ChromeKit: o.noChromeKit
      ? undefined
      : {
          createChrome: (model: any, deps: { document: { createElement(t: string): Node_ } }) => {
            const mk = (tag: string, cls: string) => {
              const n = deps.document.createElement(tag);
              n.className = cls;
              return n;
            };
            const c = {
              model,
              controls: mk("div", "tile-controls"),
              menus: mk("div", "tile-menus"),
              overflow: mk("span", "tile-overflow"),
              footer: mk("div", "tile-foot"),
              destroyed: 0,
              destroy: () => {},
            };
            c.destroy = o.badChrome === "destroy-missing" ? () => {} : () => c.destroyed++;
            chromes.push(c);
            return c;
          },
        },
  };
  // Capture anchors created for downloads.
  const origCreate = (sandbox.document as any).createElement;
  (sandbox.document as any).createElement = (t: string) => {
    const n = origCreate(t);
    if (t === "a") downloads.push(n);
    return n;
  };
  Object.defineProperty(sandbox, "globalThis", { get: () => ctx });
  const ctx = createContext(sandbox);
  runInContext(scripts[0]!, ctx); // head: auth guard + UI
  for (const id of tabIds) runInContext(`UI.register(${JSON.stringify(id)}, () => log.push("+${id}"), () => log.push("-${id}"))`, Object.assign(ctx, { log }));
  runInContext(scripts[1]!, ctx);
  // Results come from the vm realm: copy them so deepEqual compares plain prototypes.
  const rawApi = runInContext("wm.api", ctx) as WmApi;
  const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  const api: WmApi = {
    ...rawApi,
    state: () => plain(rawApi.state()),
    views: () => plain(rawApi.views()),
    windowMenuItems: (id) => plain(rawApi.windowMenuItems(id)),
  };
  const root = byId.get("wm-root")!;
  const notices = byId.get("wm-notices")!;
  const tiles = () => root.byClass("tile");
  const tileOf = (leaf: string) => tiles().find((t) => t.getAttribute("data-tile") === leaf)!;
  const btn = (tile: Node_, label: string) => tile.all().find((n) => n.tagName === "button" && n.getAttribute("aria-label") === label)!;
  const noticeTexts = () => notices.children.map((c) => c.textContent);
  const hashchange = (h: string) => {
    curHash = h;
    hist.length++;
    for (const fn of winListeners.get("hashchange") ?? []) fn({});
  };
  // The live UI driver against this window manager: send() delivers one command frame as the daemon's stream would.
  let seq = 0;
  const startDriver = () => {
    runInContext('createUiDriver(wm, { path: "/live/ui" })', ctx);
    return (command: object) => eventSources[0]!.handlers.get("message")!({ data: JSON.stringify({ type: "command", seq: ++seq, ts: 1, command }) });
  };
  return {
    startDriver,
    html,
    ctx,
    root,
    notices,
    tiles,
    tileOf,
    btn,
    noticeTexts,
    hashchange,
    log,
    mounts,
    store,
    writes,
    sections,
    stash: byId.get("wm-stash")!,
    byId,
    docListeners,
    winListeners,
    rafs,
    mq,
    mqListeners,
    location,
    assigns,
    hist,
    replaced,
    blobs,
    downloads,
    api,
    body,
    chromes,
    models,
  };
}

const stored = (store: Record<string, string>) => JSON.parse(store["pomtree.layout"]!);
const visibleSections = (s: ReturnType<typeof boot>) => s.sections.filter((x) => !x.hidden && x.parent !== s.stash).map((x) => x.getAttribute("data-tab"));

test("Node_ inspects as a short descriptor, not its parent/listener graph", () => {
  const parent = new Node_("section");
  const el = new Node_("button");
  el.className = "x";
  parent.appendChild(el);
  el.listeners.set("click", [{ fn: () => parent, capture: false }]);
  const out = inspect(el, { depth: null });
  assert.ok(out.length < 500, out);
  assert.ok(out.includes("button"), out);
});

test("default layout is one tile of the view named by the hash, else tree, like today's one-tab shell", () => {
  const a = boot({ hash: "#/hosts" });
  assert.equal(a.tiles().length, 1);
  assert.deepEqual(visibleSections(a), ["hosts"]);
  assert.deepEqual(a.log, ["+hosts"]);
  const b = boot();
  assert.deepEqual(visibleSections(b), ["tree"]);
  assert.deepEqual(b.log, ["+tree"]);
  assert.equal(b.writes.length, 0, "first load writes nothing");
  assert.equal(b.location.hash, "#/tree");
});

test("split creates two visible tiles with both singletons active; close deactivates and returns the section", () => {
  const s = boot();
  s.btn(s.tiles()[0]!, "Split right").click();
  assert.equal(s.tiles().length, 2);
  assert.deepEqual(visibleSections(s).sort(), ["reports", "tree"]);
  assert.deepEqual(s.log, ["+tree", "+reports"]);
  assert.equal(s.root.byClass("splitter").length, 1);
  assert.equal(s.root.byClass("splitter")[0]!.getAttribute("aria-orientation"), "vertical");
  assert.equal(stored(s.store).root.kind, "split");
  s.btn(s.tileOf("t2"), "Close tile").click();
  assert.deepEqual(s.log, ["+tree", "+reports", "-reports"]);
  assert.equal(s.tiles().length, 1);
  assert.equal(s.sections[1]!.parent, s.stash);
  assert.equal(s.sections[1]!.hidden, true);
  assert.equal(s.btn(s.tiles()[0]!, "Close tile").disabled, false, "the last tile can be closed too");
});

const EMPTY_TEXT = "No windows open: use the launcher (Alt+Shift+P) to open one.";

test("closing the last window leaves an empty workspace with a visible empty state, an empty saved layout and no hash", () => {
  const s = boot();
  s.btn(s.tiles()[0]!, "Close tile").click();
  assert.equal(s.tiles().length, 0);
  assert.deepEqual(
    s.root.byClass("wm-empty").map((n) => n.textContent),
    [EMPTY_TEXT],
  );
  assert.deepEqual(s.log, ["+tree", "-tree"], "the closed view is deactivated");
  assert.equal(s.sections[0]!.parent, s.stash);
  assert.deepEqual(stored(s.store), { version: 1, next: 2, focus: "", root: null });
  assert.equal(s.location.hash, "", "no window, so no window in the hash");
  assert.deepEqual(s.api.state().leaves, []);
  assert.equal(s.api.state().focus, "");
  assert.deepEqual(s.noticeTexts(), []);
});

test("an empty workspace tolerates every window action and the launcher api reopens a window", () => {
  const s = boot();
  s.api.closeFocused();
  assert.equal(s.tiles().length, 0);
  s.api.closeFocused();
  s.api.splitFocused("row");
  s.api.focusDom();
  assert.equal(s.tiles().length, 0);
  s.api.openView("hosts");
  assert.equal(s.tiles().length, 1);
  assert.deepEqual(s.root.byClass("wm-empty"), [], "the empty state goes away when a window opens");
  assert.deepEqual(
    s.api.state().leaves.map((l) => l.view),
    ["hosts"],
  );
  assert.equal(stored(s.store).root.view, "hosts");
  assert.equal(s.location.hash, "#/hosts");
  s.api.closeFocused();
  s.api.openView("terminal", "a1");
  assert.deepEqual(
    s.api.state().leaves.map((l) => `${l.view}:${l.params.agent}`),
    ["terminal:a1"],
  );
});

test("a stored empty layout is restored as empty, not rejected, and an explicit hash then opens that window", () => {
  const empty = JSON.stringify({ version: 1, next: 5, focus: "", root: null });
  const a = boot({ store: { "pomtree.layout": empty } });
  assert.equal(a.tiles().length, 0);
  assert.deepEqual(a.root.byClass("wm-empty").length, 1);
  assert.deepEqual(a.noticeTexts(), [], "an empty layout is valid, so no stale-layout message");
  assert.equal(a.writes.length, 0);
  const b = boot({ store: { "pomtree.layout": empty }, hash: "#/hosts" });
  assert.deepEqual(
    b.api.state().leaves.map((l) => l.view),
    ["hosts"],
  );
  const c = boot({ store: { "pomtree.layout": empty }, hash: "#/terminal/a1" });
  assert.deepEqual(
    c.api.state().leaves.map((l) => `${l.view}:${l.params.agent}`),
    ["terminal:a1"],
  );
});

test("narrow mode never shows an empty workspace: it falls back to the default view, and its close button is enabled by the window model (it closes the desktop window, D11)", () => {
  const empty = JSON.stringify({ version: 1, next: 5, focus: "", root: null });
  const n = boot({ narrow: true, store: { "pomtree.layout": empty } });
  assert.deepEqual(
    n.api.state().leaves.map((l) => l.view),
    ["tree"],
  );
  assert.equal(n.btn(n.tiles()[0]!, "Close tile").disabled, false);
  n.api.closeFocused();
  assert.equal(n.tiles().length, 1);
  const w = boot({ store: { "pomtree.layout": empty } });
  w.mq.matches = true;
  for (const fn of w.mqListeners) fn({ matches: true });
  assert.deepEqual(
    w.api.state().leaves.map((l) => l.view),
    ["tree"],
  );
  for (const fn of w.mqListeners) fn({ matches: false });
  assert.equal(w.tiles().length, 0);
  assert.equal(w.root.byClass("wm-empty").length, 1);
});

test("the empty state has a CSS rule that fills the workspace in normal flow, without colour literals", () => {
  const rule = /\.wm-empty \{([^}]*)\}/.exec(LAYOUT_CSS)![1]!;
  assert.match(rule, /padding:/);
  assert.match(rule, /color: var\(--muted/);
  assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,8}\b|rgb\(/);
});

test("split down makes a horizontal splitter and changing a tile's view deactivates the old singleton", () => {
  const s = boot();
  s.btn(s.tiles()[0]!, "Split down").click();
  assert.equal(s.root.byClass("splitter")[0]!.getAttribute("aria-orientation"), "horizontal");
  const sel = s
    .tileOf("t2")
    .all()
    .find((n) => n.tagName === "select")!;
  sel.value = "hosts";
  sel.fire("change");
  assert.deepEqual(s.log, ["+tree", "+reports", "-reports", "+hosts"]);
  // choosing a singleton that is already shown elsewhere focuses its tile instead of duplicating it
  const sel2 = s
    .tileOf("t2")
    .all()
    .find((n) => n.tagName === "select")!;
  sel2.value = "tree";
  sel2.fire("change");
  assert.equal(s.tileOf("t1").className, "tile tile-focused");
  assert.equal(
    s
      .tileOf("t2")
      .all()
      .find((n) => n.tagName === "select")!.value,
    "hosts",
  );
});

test("a terminal view mounts per tile with its agent and unmounts on close; hash opens it with the agent", () => {
  const s = boot({ hash: "#/terminal/agent-1" });
  assert.equal(s.mounts.length, 1);
  assert.equal(s.mounts[0]!.params.agent, "agent-1");
  assert.equal(s.tiles()[0]!.byClass("tile-title")[0]!.textContent, "Terminal · agent-1", "host.setTitle drives the title");
  s.btn(s.tiles()[0]!, "Split right").click();
  s.hashchange("#/terminal/agent-2");
  assert.equal(s.mounts.length, 2, "agent-2 gets its own tile, agent-1 stays mounted");
  assert.equal(s.tiles().length, 3, "the focused tile was split, not replaced");
  assert.equal(s.mounts[0]!.unmounted, false);
  s.btn(s.tileOf("t4"), "Close tile").click();
  assert.equal(s.mounts[1]!.unmounted, true);
  assert.equal(s.mounts[0]!.unmounted, false);
});

test("hash navigation focuses the tile that already shows the view instead of replacing one", () => {
  const s = boot();
  s.btn(s.tiles()[0]!, "Split right").click(); // t2 = reports, focused
  assert.equal(s.tileOf("t2").className, "tile tile-focused");
  s.hashchange("#/tree");
  assert.equal(s.tileOf("t1").className, "tile tile-focused");
  assert.equal(s.tiles().length, 2);
  assert.deepEqual(s.log, ["+tree", "+reports"], "nothing was torn down");
  // the same agent terminal is never opened twice
  s.hashchange("#/terminal/a1");
  assert.equal(s.mounts.length, 1);
  s.hashchange("#/terminal/a1");
  assert.equal(s.mounts.length, 1);
  // focus changes rewrite the hash without a hashchange (replaceState)
  s.tileOf("t2").fire("pointerdown");
  assert.equal(s.location.hash, "#/reports");
});

test("a terminal link without an agent is ignored; the escalations hash maps to inbox", () => {
  const s = boot({ tabs: ["tree", "inbox", "terminal"], hash: "#/terminal/a1" });
  s.btn(s.tiles()[0]!, "Split right").click();
  s.hashchange("#/terminal");
  assert.equal(s.tileOf("t2").className, "tile tile-focused", "nothing was focused or opened");
  assert.equal(s.tiles().length, 2);
  assert.equal(s.mounts.length, 1);
  s.hashchange("#/escalations/e1");
  assert.deepEqual(visibleSections(s), ["inbox"], "a browsing target retargets the focused (tree) tile");
  assert.equal(s.mounts[0]!.unmounted, false, "the terminal window stays");
});

test("#/escalations opens the inbox only when no separate escalations tab exists", () => {
  const without = boot({ tabs: ["tree", "inbox"], hash: "#/escalations/e1" });
  assert.deepEqual(visibleSections(without), ["inbox"]);
  const withTab = boot({ tabs: ["tree", "inbox", "escalations"], hash: "#/escalations/e1" });
  assert.deepEqual(visibleSections(withTab), ["escalations"]);
});

test("UI.activate runs each activator once, a late registration of a live view activates, and deactivate is idempotent", () => {
  const s = boot();
  runInContext('UI.register("late", () => log.push("+late"), () => log.push("-late"))', s.ctx);
  assert.deepEqual(s.log, ["+tree"]);
  runInContext('UI.activate("late"); UI.activate("late"); UI.deactivate("late"); UI.deactivate("late")', s.ctx);
  assert.deepEqual(s.log, ["+tree", "+late", "-late"]);
  runInContext('UI.activate("nope"); UI.register("nope", () => log.push("+nope"))', s.ctx);
  assert.deepEqual(s.log.slice(3), ["+nope"]);
});

test("a view with no registration renders a placeholder with close and change-view controls", () => {
  const s = boot({
    store: { "pomtree.layout": JSON.stringify({ version: 1, next: 2, focus: "t1", root: { kind: "leaf", id: "t1", view: "nonesuch", params: {} } }) },
  });
  const t = s.tiles()[0]!;
  assert.match(t.byClass("tile-note")[0]!.textContent, /nonesuch: view not available/);
  assert.ok(s.btn(t, "Close tile"));
  assert.ok(t.all().some((n) => n.tagName === "select"));
  assert.deepEqual(s.log, []);
  const sel = t.all().find((n) => n.tagName === "select")!;
  sel.value = "hosts";
  sel.fire("change");
  assert.deepEqual(visibleSections(s), ["hosts"]);
});

test("a stored layout that repeats a singleton or an agent terminal shows a placeholder for the repeat", () => {
  const leaf = (id: string, view: string, agent?: string) => ({ kind: "leaf", id, view, params: agent ? { agent } : {} });
  const two = (a: unknown, b: unknown) =>
    JSON.stringify({ version: 1, next: 4, focus: "t1", root: { kind: "split", id: "s3", dir: "row", ratio: 0.5, children: [a, b] } });
  const dupSingle = boot({ store: { "pomtree.layout": two(leaf("t1", "tree"), leaf("t2", "tree")) } });
  assert.match(dupSingle.tileOf("t2").byClass("tile-note")[0]!.textContent, /already shown in another tile/);
  assert.deepEqual(dupSingle.log, ["+tree"]);
  const dupTerm = boot({ store: { "pomtree.layout": two(leaf("t1", "terminal", "a1"), leaf("t2", "terminal", "a1")) } });
  assert.equal(dupTerm.mounts.length, 1);
  const twoTerms = boot({ store: { "pomtree.layout": two(leaf("t1", "terminal", "a1"), leaf("t2", "terminal", "a2")) } });
  assert.equal(twoTerms.mounts.length, 2);
});

test("a stored layout is restored; unparseable, invalid or other-version storage shows a message and the default", () => {
  const good = boot();
  good.btn(good.tiles()[0]!, "Split right").click();
  const saved = good.store["pomtree.layout"]!;
  const again = boot({ store: { "pomtree.layout": saved } });
  assert.equal(again.tiles().length, 2);
  assert.deepEqual(again.noticeTexts(), []);
  assert.equal(again.writes.length, 0);
  const cases: Record<string, RegExp> = {
    "{not json": /not valid JSON/,
    '{"version":2}': /version 2 is not supported/,
    [JSON.stringify({ version: 1, next: 2, focus: "t1", root: { kind: "leaf", id: "t1", view: "Bad View", params: {} } })]: /invalid view id/,
  };
  for (const [text, re] of Object.entries(cases)) {
    const s = boot({ store: { "pomtree.layout": text } });
    assert.equal(s.tiles().length, 1, text);
    assert.deepEqual(visibleSections(s), ["tree"]);
    assert.equal(s.noticeTexts().length, 1, text);
    assert.match(s.noticeTexts()[0]!, re);
    assert.match(s.noticeTexts()[0]!, /not used/);
    // dismissible
    s.notices.children[0]!.all()
      .find((n) => n.getAttribute("aria-label") === "Dismiss message")!
      .click();
    assert.equal(s.notices.children.length, 0);
  }
  const denied = boot({ getItemThrows: true });
  assert.match(denied.noticeTexts()[0]!, /could not be read \(storage denied\)/);
  assert.equal(denied.tiles().length, 1);
});

test("a failed write shows a visible message with an Export action, and later success clears it", () => {
  const s = boot({ setItemThrows: true });
  s.btn(s.tiles()[0]!, "Split right").click();
  assert.equal(s.tiles().length, 2, "the layout still changes in memory");
  assert.match(s.noticeTexts()[0]!, /could not be saved \(quota exceeded\).*Export/);
  const exportBtn = s.notices.children[0]!.all().find((n) => n.tagName === "button" && n.textContent === "Export layout")!;
  exportBtn.click();
  assert.equal(s.blobs.length, 1);
  assert.equal(s.downloads[0]!.download, "pomtree-layout.json");
  assert.equal(JSON.parse(String(s.blobs[0]!.parts[0])).version, 1);
});

test("Export, Import and Reset: import errors are shown; a valid import replaces and saves; reset restores the default", async () => {
  const s = boot();
  s.btn(s.tiles()[0]!, "Split right").click();
  const file = (text: string) => ({ text: async () => text });
  const flush = () => new Promise((r) => setImmediate(r));
  s.api.importFile(file("{broken"));
  await flush();
  assert.match(s.noticeTexts().join("|"), /Import failed.*not valid JSON/);
  assert.equal(s.tiles().length, 2, "a failed import keeps the layout");
  const single = JSON.stringify({ version: 1, next: 2, focus: "t1", root: { kind: "leaf", id: "t1", view: "hosts", params: {} } });
  s.api.importFile(file(single));
  await flush();
  assert.equal(s.tiles().length, 1);
  assert.deepEqual(visibleSections(s), ["hosts"]);
  assert.equal(stored(s.store).root.view, "hosts");
  s.api.resetLayout();
  assert.deepEqual(visibleSections(s), ["tree"]);
  assert.equal(stored(s.store).root.view, "tree");
  s.api.importFile(undefined); // no file chosen: nothing happens
  assert.equal(s.tiles().length, 1);
});

test("narrow: Import and Reset show the result on the visible single window as well as saving the desktop layout", async () => {
  const n = boot({ narrow: true, store: { ...three().store } });
  const flush = () => new Promise((r) => setImmediate(r));
  const single = JSON.stringify({ version: 1, next: 2, focus: "t1", root: { kind: "leaf", id: "t1", view: "hosts", params: {} } });
  n.api.importFile({ text: async () => single });
  await flush();
  assert.deepEqual(
    n.api.state().leaves.map((l) => l.view),
    ["hosts"],
    "the imported layout's focused window is on screen",
  );
  assert.equal(stored(n.store).root.view, "hosts", "the desktop layout is saved");
  n.api.resetLayout();
  assert.deepEqual(
    n.api.state().leaves.map((l) => l.view),
    ["tree"],
    "reset shows the default view",
  );
  assert.equal(stored(n.store).root.view, "tree");
  assert.equal(n.api.state().narrow, true);
  const w = boot({ store: { ...three().store } });
  w.api.resetLayout();
  assert.equal(w.api.state().narrow, false, "negative control: a wide screen is unaffected");
  assert.equal(w.tiles().length, 1);
});

test("api.exportLayout downloads the stored layout as pomtree-layout.json", () => {
  const s = boot();
  s.api.exportLayout();
  assert.equal(s.downloads[0]!.download, "pomtree-layout.json");
  assert.equal(JSON.parse(String(s.blobs[0]!.parts[0])).version, 1);
});

test("narrow mode shows one tile with no chrome class, switches views in memory, and never writes storage", () => {
  const s = boot({ narrow: true });
  assert.equal(s.root.className, "wm-root wm-narrow");
  assert.equal(s.root.byClass("splitter").length, 0);
  s.hashchange("#/hosts");
  assert.deepEqual(visibleSections(s), ["hosts"]);
  s.hashchange("#/terminal/a9");
  assert.equal(s.mounts.length, 1);
  assert.equal(s.writes.length, 0);
  assert.deepEqual(s.docListeners.get("keydown")!.length, 1);
  // a stored desktop layout survives a narrow visit and is restored when the viewport widens
  const wide = boot();
  wide.btn(wide.tiles()[0]!, "Split right").click();
  const saved = wide.store["pomtree.layout"]!;
  const n = boot({ narrow: true, store: { "pomtree.layout": saved } });
  assert.equal(n.tiles().length, 1);
  n.hashchange("#/hosts");
  assert.equal(n.store["pomtree.layout"], saved);
  assert.equal(n.writes.length, 0);
  n.mqListeners[0]!({ matches: false });
  assert.equal(n.tiles().length, 2);
});

test("Alt+Shift+Arrow moves focus in capture phase and stops propagation; plain arrows are ignored", () => {
  const s = boot();
  s.btn(s.tiles()[0]!, "Split right").click(); // t2 right, focused
  const key = s.docListeners.get("keydown")![0]!;
  assert.equal(key.capture, true);
  const ev = (k: string, extra = {}) => {
    const r = {
      key: k,
      altKey: true,
      shiftKey: true,
      stopped: false,
      prevented: false,
      stopPropagation() {
        r.stopped = true;
      },
      preventDefault() {
        r.prevented = true;
      },
      ...extra,
    };
    return r;
  };
  const left = ev("ArrowLeft");
  key.fn(left);
  assert.equal(left.stopped, true);
  assert.equal(left.prevented, true);
  assert.equal(s.tileOf("t1").className, "tile tile-focused");
  assert.ok(s.tileOf("t1").focused >= 1);
  const plain = ev("ArrowRight", { shiftKey: false });
  key.fn(plain);
  assert.equal(plain.stopped, false);
  assert.equal(s.tileOf("t1").className, "tile tile-focused");
});

test("splitters resize with pointer capture, clamp to a 160px minimum, persist on pointerup only, and nudge by keyboard", () => {
  const s = boot();
  s.btn(s.tiles()[0]!, "Split right").click();
  const writesBefore = s.writes.length;
  const sp = s.root.byClass("splitter")[0]!;
  assert.equal(sp.getAttribute("role"), "separator");
  assert.equal(sp.getAttribute("aria-valuenow"), "50");
  sp.fire("pointerdown", { pointerId: 7 });
  assert.deepEqual(sp.captured, [7]);
  sp.fire("pointermove", { clientX: 300 });
  assert.equal(sp.getAttribute("aria-valuenow"), "30");
  assert.equal(s.writes.length, writesBefore, "no write while dragging");
  sp.fire("pointermove", { clientX: 10 }); // below the minimum: 160 of 1000px = 16%
  assert.equal(sp.getAttribute("aria-valuenow"), "16");
  sp.fire("pointerup", { pointerId: 7 });
  assert.equal(s.writes.length, writesBefore + 1);
  assert.equal(stored(s.store).root.ratio, 0.16);
  sp.fire("keydown", { key: "ArrowRight" });
  assert.equal(sp.getAttribute("aria-valuenow"), "21");
  sp.fire("keydown", { key: "ArrowUp" }); // wrong axis for a vertical bar
  assert.equal(sp.getAttribute("aria-valuenow"), "21");
  sp.fire("dblclick");
  assert.equal(sp.getAttribute("aria-valuenow"), "50");
});

test("mounted views are fitted on the next animation frame after a layout change", () => {
  const s = boot({ hash: "#/terminal/a1" });
  for (const f of s.rafs.splice(0)) f();
  const before = s.mounts[0]!.fits;
  s.btn(s.tiles()[0]!, "Split right").click();
  assert.equal(s.mounts[0]!.fits, before, "not synchronous");
  for (const f of s.rafs.splice(0)) f();
  assert.equal(s.mounts[0]!.fits, before + 1);
});

test("layoutCss: the six tile classes, the chrome tokens with fallbacks, longhand borders, overflow and the narrow fallback", () => {
  for (const c of [".tile ", ".tile-title", ".tile-body", ".tile-btn", ".splitter", ".tile-focused"]) assert.ok(LAYOUT_CSS.includes(c), c);
  for (const t of ["--chrome-bg", "--chrome-fg", "--chrome-border", "--chrome-accent", "--chrome-accent-fg"]) {
    assert.match(LAYOUT_CSS, new RegExp(`var\\(${t}, `), `${t} needs a fallback`);
    assert.doesNotMatch(LAYOUT_CSS, new RegExp(`var\\(${t}\\)`));
  }
  assert.doesNotMatch(LAYOUT_CSS, /(^|[;{\s])border:/m, "borders are longhands only");
  assert.doesNotMatch(LAYOUT_CSS, /#[0-9a-fA-F]{3,8}\b|rgb\(|gradient|box-shadow/, "no colour literals, gradients or shadows");
  const tileRule = /\.tile \{([^}]*)\}/.exec(LAYOUT_CSS)![1]!;
  assert.match(tileRule, /overflow: hidden/);
  assert.match(tileRule, /border-width: 1px; border-style: solid;/);
  assert.match(LAYOUT_CSS, /@media \(max-width: 640px\)/);
  assert.match(LAYOUT_CSS, /\.splitter\[aria-orientation="vertical"\]/);
  assert.match(LAYOUT_CSS, /\.splitter\[aria-orientation="horizontal"\]/);
  assert.ok(renderShell({ tabs: [] }).includes(".tile-focused"), "composed into UI_CSS");
});

test("layoutCss: narrow modes hide the tile bar's other children but keep the window menus and overflow button", () => {
  assert.doesNotMatch(LAYOUT_CSS, /\.tracegrp/);
  assert.doesNotMatch(LAYOUT_CSS, /\.tile-bar(, \.splitter)? \{ display: none; \}/, "the whole bar must not be hidden");
  assert.doesNotMatch(LAYOUT_CSS, /\.wm-narrow \.tile-bar, /);
  const hideKids = LAYOUT_CSS.match(/\.tile-bar > :not\(\.tile-menus\):not\(\.tile-overflow\):not\(\.tile-controls\) \{ display: none; \}/g) ?? [];
  assert.equal(hideKids.length, 2, "once under .wm-narrow and once in the 640px media query");
  const hideEmpty = LAYOUT_CSS.match(/\.tile-bar:not\(:has\(\.tile-menus, \.tile-overflow, \.tile-controls\)\) \{ display: none; \}/g) ?? [];
  assert.equal(hideEmpty.length, 2);
  assert.match(LAYOUT_CSS, /\.wm-narrow \.splitter \{ display: none; \}/);
  const pushRight = LAYOUT_CSS.match(/\.tile-bar > \.tile-overflow \{ margin-left: auto; \}/g) ?? [];
  assert.equal(pushRight.length, 2, "with the title hidden the overflow button sits at the right so its right-anchored panel stays inside the tile");
  for (const m of LAYOUT_CSS.matchAll(/^\s*([^{}\n@][^{}\n]*)\{([^}]*)\}/gm)) {
    if (/display: none/.test(m[2]!)) assert.doesNotMatch(m[1]!, /^\s*[^:]*\.tile-(menus|overflow)\s*$/, "layout css never hides the chrome itself");
  }
});

test("layoutCss: an empty terminal note takes no space inside a tile", () => {
  const rule = /\.tile-body \.termnote:empty \{([^}]*)\}/.exec(LAYOUT_CSS);
  assert.ok(rule, "a .tile-body .termnote:empty rule");
  assert.doesNotMatch(rule[1]!, /display\s*:\s*none/, "display:none would drop the role=status live region from the accessibility tree");
  assert.match(rule[1]!, /min-height: 0/);
  assert.match(rule[1]!, /margin: 0/);
  assert.match(rule[1]!, /padding: 0/);
  assert.doesNotMatch(LAYOUT_CSS, /(^|\n)\.termnote:empty/, "scoped to tiles; standalone pages are unchanged");
});

test("layoutCss: panes fill their tile with no outer padding (the tile border is the only bezel), compact controls live in PANE_CSS, with no colour", () => {
  const section = /\.tile-body > section \{([^}]*)\}/.exec(LAYOUT_CSS);
  assert.ok(section, "a .tile-body > section rule");
  assert.match(section[1]!, /padding: 0[;\s]/, "sections carry no bezel; text content insets itself with --pane-inset");
  assert.match(section[1]!, /height: 100%/, "a section fills the tile body, so a pane's own scroller and its scrollbar sit at the tile bottom");
  const title = /\.tile-title \{([^}]*)\}/.exec(LAYOUT_CSS);
  assert.ok(title);
  assert.match(title[1]!, /min-width: 3\.5rem/, "a controls-heavy bar squeezes the title last: the label stays readable in a half-width tile");
  assert.doesNotMatch(LAYOUT_CSS, /\.wm-mount \.pane:not\(\.pane-fill\)/, "no generic mounted-pane padding any more");
  assert.doesNotMatch(LAYOUT_CSS, /\.wm-mount \.pane button/, "compact controls are one rule in PANE_CSS, for every pane");
  assert.match(PANE_CSS, /\.pane button, \.pane a\.btn \{[^}]*padding: 0\.125rem 0\.5rem/);
  assert.match(PANE_CSS, /\.pane button, \.pane a\.btn \{[^}]*font-size: var\(--fs-sm\)/);
  assert.match(PANE_CSS, /--fs-sm: 0\.8125rem/);
  const fill = /(?:^|\n)\.pane \{([^}]*)\}/.exec(PANE_CSS);
  assert.ok(fill, "the .pane root rule in PANE_CSS fills the tile");
  assert.match(fill[1]!, /flex-direction: column/);
  assert.match(fill[1]!, /height: 100%/);
  assert.match(fill[1]!, /min-height: 0/);
  assert.doesNotMatch(fill[1]! + section[1]!, /color|background/, "colours stay with the theme tokens");
});

test("layoutCss: a browser pane fills its tile and its canvas holder takes the remaining height, with no colour", () => {
  const pane = /\.tile-body \.wm-mount \.pane\.pane-fill \{([^}]*)\}/.exec(LAYOUT_CSS);
  assert.ok(pane, "a .tile-body .wm-mount .pane.pane-fill rule");
  assert.match(pane[1]!, /display: flex/);
  assert.match(pane[1]!, /flex-direction: column/);
  assert.match(pane[1]!, /height: 100%/);
  assert.match(pane[1]!, /min-height: 0/);
  const canvas = /\.tile-body \.pane\.browser canvas \{([^}]*)\}/.exec(LAYOUT_CSS);
  assert.ok(canvas, "a .tile-body .pane.browser canvas rule");
  const holder = /\.tile-body \.pane\.browser \.browser-holder \{([^}]*)\}/.exec(LAYOUT_CSS);
  assert.ok(holder, "the canvas holder is the pane's flex child");
  assert.match(holder[1]!, /flex: 1 1 auto/);
  assert.match(holder[1]!, /min-height: 0/);
  assert.doesNotMatch(canvas[1]!, /flex:/, "the canvas itself is not a flex child");
  assert.match(canvas[1]!, /width: 100%/);
  assert.match(canvas[1]!, /height: 100%/);
  assert.match(canvas[1]!, /object-fit: contain/, "the frame keeps its aspect ratio instead of stretching");
  assert.match(canvas[1]!, /display: block/);
  assert.doesNotMatch(pane[1]! + canvas[1]!, /color|background|border-(width|style|color)/, "geometry only");
});

test("layoutCss: pane-fill (the root of an item view) has zero padding and fills the tile body; the generic padding rule excludes it", () => {
  const fill = /\.tile-body \.wm-mount \.pane\.pane-fill \{([^}]*)\}/.exec(LAYOUT_CSS);
  assert.ok(fill, "a .tile-body .wm-mount .pane.pane-fill rule");
  assert.match(fill[1]!, /padding: 0;/);
  assert.match(fill[1]!, /box-sizing: border-box/);
  assert.match(fill[1]!, /display: flex/);
  assert.match(fill[1]!, /flex-direction: column/);
  assert.match(fill[1]!, /height: 100%/);
  assert.match(fill[1]!, /min-height: 0/);
  assert.doesNotMatch(fill[1]!, /color|background|border-(width|style)/, "geometry only");
  // negative control: a bare generic padding rule (no :not) would also pad item views
  assert.doesNotMatch(LAYOUT_CSS, /\.tile-body \.wm-mount \.pane \{[^}]*padding/);
  const termhost = /\.tile-body \.pane-fill \.termhost \{([^}]*)\}/.exec(LAYOUT_CSS);
  assert.ok(termhost, "the terminal host loses its own padding and frame inside an item window");
  assert.match(termhost[1]!, /padding: 0/);
  const note = /\.tile-body \.pane-fill \.termnote, \.tile-body \.pane-fill \.pane-note \{([^}]*)\}/.exec(LAYOUT_CSS);
  assert.ok(note, "note elements keep a small padding of their own so text is not glued to the edge");
  assert.match(note[1]!, /padding: 0\.25rem 0\.5rem/);
  assert.ok(LAYOUT_CSS.indexOf(".pane-fill .termnote,") < LAYOUT_CSS.indexOf(".termnote:empty"), "the empty-note rule comes later and wins the tie");
});

test("tiles put .tile-focused on the .tile element and splitters carry aria-orientation by split direction", () => {
  const s = boot();
  s.btn(s.tiles()[0]!, "Split right").click();
  s.btn(s.tileOf("t2"), "Split down").click();
  const focused = s.root.all().filter((n) => n.className.split(" ").includes("tile-focused"));
  assert.equal(focused.length, 1);
  assert.ok(focused[0]!.className.split(" ").includes("tile"));
  const orient = s.root
    .byClass("splitter")
    .map((n) => n.getAttribute("aria-orientation"))
    .sort();
  assert.deepEqual(orient, ["horizontal", "vertical"]);
});

test("the window manager never uses innerHTML, and agent text only reaches the DOM through textContent", () => {
  assert.ok(!LAYOUT_SHELL_JS.includes("innerHTML"));
  assert.ok(!LAYOUT_SHELL_JS.includes("outerHTML"));
  assert.ok(!LAYOUT_SHELL_JS.includes("insertAdjacentHTML"));
  const evil = '<img src=x onerror="alert(1)">';
  const s = boot({ hash: `#/terminal/${encodeURIComponent(evil)}` });
  assert.equal(s.mounts[0]!.params.agent, evil);
  assert.equal(s.tiles()[0]!.byClass("tile-title")[0]!.textContent, `Terminal · ${evil}`);
  const bad = boot({ hash: "#/x" });
  assert.ok(bad.tiles().length === 1);
});

test("focusing another tile rewrites the hash with replaceState: no location.hash assignment and no new history entry", () => {
  const s = boot();
  s.btn(s.tiles()[0]!, "Split right").click(); // t2 shows reports and is focused
  assert.equal(s.location.hash, "#/reports");
  const len = s.hist.length;
  const replacedBefore = s.replaced.length;
  s.tileOf("t1").fire("pointerdown");
  assert.equal(s.replaced.length, replacedBefore + 1);
  assert.equal(s.replaced.at(-1), "#/tree", "the focused tile's hash");
  assert.equal(s.location.hash, "#/tree");
  assert.deepEqual(s.assigns, [], "location.hash is never assigned by focus changes");
  assert.equal(s.hist.length, len, "history did not grow");
});

test("a hash naming an unregistered view is ignored: no layout change and no save", () => {
  const s = boot();
  s.btn(s.tiles()[0]!, "Split right").click();
  const writes = s.writes.length;
  const before = JSON.stringify(stored(s.store));
  s.hashchange("#/typo");
  assert.equal(JSON.stringify(stored(s.store)), before);
  assert.equal(s.writes.length, writes);
  assert.deepEqual(
    s.tiles().map((t) => t.byClass("tile-note").length),
    [0, 0],
    "no placeholder tile appears",
  );
  const start = boot({ hash: "#/typo" });
  assert.deepEqual(visibleSections(start), ["tree"], "a startup hash for an unknown view falls back to the default view");
  assert.equal(start.tiles()[0]!.byClass("tile-note").length, 0);
  s.hashchange("#/hosts"); // a registered view still routes
  assert.ok(visibleSections(s).includes("hosts"));
});

test("a rejected stored layout stays in storage until the layout is changed, and the notice says it will be replaced", () => {
  const newer = '{"version":2,"future":true}';
  const s = boot({ store: { "pomtree.layout": newer } });
  assert.match(s.noticeTexts()[0]!, /will be replaced when the layout is next changed/);
  assert.equal(s.store["pomtree.layout"], newer);
  s.hashchange("#/tree"); // already shown: not a layout change
  s.tileOf("t1").fire("pointerdown"); // focus on the focused tile: not a change
  s.api.exportLayout();
  assert.equal(s.writes.length, 0);
  assert.equal(s.store["pomtree.layout"], newer);
  s.btn(s.tiles()[0]!, "Split right").click(); // first real change
  assert.equal(s.writes.length, 1);
  assert.equal(stored(s.store).version, 1);
  const r = boot({ store: { "pomtree.layout": newer } });
  r.api.resetLayout();
  assert.equal(r.writes.length, 1, "Reset also replaces the stored text");
});

test("a view whose mount throws shows the failed-load placeholder and leaves nothing of it in the shell", () => {
  const s = boot({ throwingView: true, hash: "#/boom" });
  const t = s.tiles()[0]!;
  assert.match(t.byClass("tile-note")[0]!.textContent, /boom: the view failed to load \(half-built\)/);
  assert.equal(t.byClass("wm-mount").length, 0, "the mount host and anything the view put in it are removed");
  assert.equal(t.byClass("tile-body")[0]!.children.length, 1, "only the note remains");
  assert.ok(s.btn(t, "Close tile"));
  s.btn(t, "Split right").click();
  s.btn(s.tileOf("t2"), "Close tile").click();
  assert.equal(s.tiles().length, 1, "the failed tile closes like any other");
});

test("changing a tile's view to one shown elsewhere renders once when focus changes, and resets the select when nothing changes", () => {
  const s = boot();
  s.btn(s.tiles()[0]!, "Split right").click(); // t2 (reports) focused
  const sel = s
    .tileOf("t2")
    .all()
    .find((n) => n.tagName === "select")!;
  let sets = 0;
  let val = sel.value;
  Object.defineProperty(sel, "value", {
    get: () => val,
    set: (v: string) => {
      val = v;
      sets++;
    },
  });
  val = "tree"; // the user picks the view t1 shows (a plain assignment of the backing value)
  sets = 0;
  sel.fire("change");
  assert.match(s.tileOf("t1").className, /tile-focused/);
  assert.equal(sets, 1, "one render for the focus change");
  assert.equal(val, "reports", "the select shows the tile's own view again");
  // now t1 is focused already: picking tree again changes nothing, yet the select must still be reset
  val = "tree";
  sets = 0;
  sel.fire("change");
  assert.equal(sets, 1, "render runs because commit reported no change");
  assert.equal(val, "reports");
});

test("a mounted view can ask whether its tile is the focused one, so a terminal skips grabbing focus from another tile", () => {
  const s = boot();
  s.api.openView("terminal", "a1"); // splits the tree tile; the terminal tile is focused
  const host = s.mounts[0]!.host as unknown as { isFocused(): boolean };
  assert.equal(host.isFocused(), true, "the terminal's tile is the focused one");
  s.tileOf("t1").fire("pointerdown"); // operator puts focus on t1
  assert.equal(host.isFocused(), false, "negative control: the terminal's tile is no longer focused");
  s.tileOf("t2").fire("pointerdown");
  assert.equal(host.isFocused(), true, "a click focuses it again");
});

test("focus that reaches a tile moves the tile focus with no key or pointer press, so a screen reader or voice control is followed", () => {
  const s = boot();
  s.btn(s.tiles()[0]!, "Split right").click(); // t2 = second tile, focused
  s.tileOf("t1").fire("pointerdown");
  assert.equal(s.tileOf("t1").className, "tile tile-focused");
  s.tileOf("t2").fire("focusin"); // assistive focus move: no keydown, no pointerdown
  assert.equal(s.tileOf("t2").className, "tile tile-focused");
  assert.equal(s.tileOf("t1").className, "tile");
});

test("api.state and api.views report the layout and the openable views as plain data", () => {
  const s = boot();
  assert.deepEqual(s.api.state(), {
    leaves: [{ id: "t1", view: "tree", params: {}, hidden: false }],
    focus: "t1",
    maximized: "",
    narrow: false,
    maxLeaves: 16,
  });
  assert.deepEqual(
    s.api.views().map((v) => [v.id, v.title, v.multi]),
    [
      ["tree", "TREE", false],
      ["reports", "REPORTS", false],
      ["hosts", "HOSTS", false],
      ["terminal", "TERMINAL", true],
      ["report", "Report", true],
    ],
  );
  assert.equal(boot({ narrow: true }).api.state().narrow, true);
});

test("api.openView splits a tile with the view, focuses an already shown one, and names an unavailable view", () => {
  const s = boot();
  s.api.openView("hosts");
  assert.equal(s.tiles().length, 2);
  assert.deepEqual(
    s.api.state().leaves.map((l) => l.view),
    ["tree", "hosts"],
  );
  assert.equal(s.api.state().focus, "t2");
  s.api.openView("tree");
  assert.equal(s.tiles().length, 2, "already shown: no new tile");
  assert.equal(s.api.state().focus, "t1");
  s.api.openView("terminal", "a9");
  assert.equal(s.api.state().leaves.find((l) => l.view === "terminal")!.params.agent, "a9");
  s.api.openView("terminal", "a9");
  assert.equal(s.tiles().length, 3, "same agent terminal is deduped");
  s.api.openView("terminal", "b1");
  assert.equal(s.tiles().length, 4, "another agent opens another terminal");
  s.api.openView("nope");
  assert.equal(s.tiles().length, 4);
  assert.match(s.noticeTexts().join("|"), /View not available: nope/);
});

test("api.openView at the tile limit shows the existing limit notice and adds nothing", () => {
  const s = boot();
  for (let i = 0; i < 20; i++) s.api.openView("terminal", `a${i}`);
  assert.equal(s.api.state().leaves.length <= 16, true);
  const n = s.api.state().leaves.length;
  s.api.openView("terminal", "zzz");
  assert.equal(s.api.state().leaves.length, n);
  assert.match(s.noticeTexts().join("|"), /Cannot open another window: a layout holds at most 16 tiles\. Close a tile first\./);
});

test("api.openView in narrow mode replaces the single view and never persists", () => {
  const s = boot({ narrow: true });
  s.api.openView("hosts");
  assert.deepEqual(
    s.api.state().leaves.map((l) => l.view),
    ["hosts"],
  );
  assert.deepEqual(visibleSections(s), ["hosts"]);
  assert.equal(s.writes.length, 0);
});

test("api.splitFocused and api.closeFocused act on the focused tile and are no-ops when narrow", () => {
  const s = boot();
  s.api.splitFocused("col");
  assert.equal(s.tiles().length, 2);
  s.api.closeFocused();
  assert.equal(s.tiles().length, 1);
  s.api.closeFocused(); // the last tile closes too, leaving an empty workspace
  assert.equal(s.tiles().length, 0);
  const n = boot({ narrow: true });
  n.api.splitFocused("row");
  n.api.closeFocused();
  assert.equal(n.api.state().leaves.length, 1);
  assert.equal(n.writes.length, 0);
});

test("api.focus focuses a tile", () => {
  const s = boot();
  s.api.splitFocused("row");
  s.api.focus("t1");
  assert.equal(s.api.state().focus, "t1");
});

test("api.onChange fires after render, stops after unsubscribe, and a throwing listener cannot break rendering", () => {
  const s = boot();
  const seen: number[] = [];
  const off = s.api.onChange(() => seen.push(s.tiles().length));
  s.api.onChange(() => {
    throw new Error("bad listener");
  });
  s.api.splitFocused("row");
  assert.deepEqual(seen, [2], "called after the new tile was rendered");
  assert.equal(s.tiles().length, 2);
  off();
  s.api.splitFocused("row");
  assert.equal(s.tiles().length, 3);
  assert.deepEqual(seen, [2]);
  const n = boot({ narrow: false });
  const calls: boolean[] = [];
  n.api.onChange(() => calls.push(n.api.state().narrow));
  for (const fn of n.mqListeners) fn({ matches: true });
  assert.deepEqual(calls, [true], "fires after a narrow switch");
});

test("api.focusDom focuses the focused tile element once, and does not throw when there is no tile", () => {
  const s = boot();
  s.api.splitFocused("row"); // t2 focused
  const before = s.tileOf("t2").focused;
  s.api.focusDom();
  assert.equal(s.tileOf("t2").focused, before + 1);
  assert.equal(s.tileOf("t1").focused, 0);
  const n = boot({ narrow: true });
  n.api.focusDom();
  assert.equal(n.tiles()[0]!.focused, 1, "narrow: the single tile");
  for (const t of n.tiles()) t.remove();
  (runInContext("wm.tiles", n.ctx) as Map<string, unknown>).clear();
  assert.doesNotThrow(() => n.api.focusDom());
});

test("a throwing onChange listener shows one notice naming the cause and the action, and does not re-enter", () => {
  const s = boot();
  let calls = 0;
  s.api.onChange(() => {
    calls++;
    throw new Error("boom");
  });
  s.api.splitFocused("row");
  s.api.splitFocused("row");
  assert.equal(calls, 2);
  const texts = s.noticeTexts().filter((t) => /top bar failed to update/.test(t));
  assert.equal(texts.length, 1, "one notice per key");
  assert.match(texts[0]!, /\(boom\)\. Reload the page; the layout is unaffected\./);
  assert.equal(s.tiles().length, 3);
});

// ---- tile chrome ----

const barKinds = (t: Node_) => t.children.find((c) => c.className === "tile-bar")!.children.map((c) => c.className);

test("shell page inlines MENU_NAV_JS, then WINDOW_CHROME_JS, then LAYOUT_SHELL_JS, and CHROME_CSS between LAYOUT_CSS and the theme", () => {
  const html = renderShell({ tabs: [{ id: "tree", title: "Tree", render: () => "" }] });
  const a = html.indexOf(MENU_NAV_JS);
  const b = html.indexOf(WINDOW_CHROME_JS);
  const c = html.indexOf(LAYOUT_SHELL_JS);
  assert.ok(a > 0 && b > a && c > b, `order nav=${a} chrome=${b} shell=${c}`);
  const css = html.indexOf(CHROME_CSS);
  assert.ok(css > html.indexOf(LAYOUT_CSS) && css > 0);
});

test("a registry view with declared menus gets a per-tile model; menus and overflow sit between title and buttons (an item tile has no selector), the footer after the body", () => {
  const s = boot({ hash: "#/terminal/a1", menus: true });
  const t = s.tiles()[0]!;
  assert.deepEqual(barKinds(t), ["tile-title", "tile-menus", "tile-overflow", "tile-btn", "tile-btn", "tile-btn", "tile-btn", "tile-btn"]);
  assert.deepEqual(
    t.children.map((c) => c.className),
    ["tile-bar", "tile-body", "tile-foot"],
  );
  assert.equal(s.chromes.length, 1);
  assert.equal((s.mounts[0]!.host as any).model, s.models[0]);
  assert.equal(s.mounts[0]!.host.setTitle.length, 1); // setTitle stays
});

test("a view with no declared menus or status renders no menu strips and no footer", () => {
  const s = boot({ hash: "#/terminal/a1" });
  const t = s.tiles()[0]!;
  assert.deepEqual(barKinds(t), ["tile-title", "tile-btn", "tile-btn", "tile-btn", "tile-btn", "tile-btn"]);
  assert.deepEqual(
    t.children.map((c) => c.className),
    ["tile-bar", "tile-body"],
  );
  assert.equal(s.chromes.length, 0);
});

test("closing a terminal tile destroys its chrome; a second terminal tile gets its own model", () => {
  const s = boot({ hash: "#/terminal/a1", menus: true });
  s.btn(s.tiles()[0]!, "Split right").click();
  s.api.openView("terminal", "a2");
  assert.equal(s.chromes.length, 2);
  assert.notEqual(s.models[1], s.models[0]);
  assert.deepEqual(
    s.chromes.map((c) => c.destroyed),
    [0, 0],
  );
  s.btn(s.tiles()[0]!, "Close tile").click();
  assert.deepEqual(
    s.chromes.map((c) => c.destroyed),
    [1, 0],
  );
});

test("a section declaring only controls still gets chrome: controls and the overflow button sit between title and selector, no menus, no footer", () => {
  const s = boot({ hash: "#/hosts", controlsOnly: true });
  const t = s.tiles()[0]!;
  assert.deepEqual(barKinds(t), ["tile-title", "tile-controls", "tile-overflow", "tile-view", "tile-btn", "tile-btn", "tile-btn", "tile-btn", "tile-btn"]);
  assert.deepEqual(
    t.children.map((c) => c.className),
    ["tile-bar", "tile-body"],
  );
  assert.equal(s.chromes.length, 1);
});

test("a view whose declaration has menus but no controls adds no empty controls strip", () => {
  const s = boot({ hash: "#/hosts", menus: true });
  assert.equal(s.tiles()[0]!.byClass("tile-controls").length, 0);
  assert.equal(s.tiles()[0]!.byClass("tile-menus").length, 1);
});

test("a section view with a section model gets chrome, the model persists across rebuilds and the chrome is destroyed on release", () => {
  const s = boot({ hash: "#/hosts", menus: true });
  assert.equal(s.tiles()[0]!.byClass("tile-menus").length, 1);
  s.hashchange("#/tree");
  assert.equal(s.chromes[0]!.destroyed, 1);
  s.hashchange("#/hosts");
  assert.equal(s.chromes.length, 2);
  assert.equal(s.chromes[1]!.model, s.chromes[0]!.model);
});

test("missing ChromeKit shows a visible tile note naming cause and action, and the view still mounts", () => {
  const s = boot({ hash: "#/terminal/a1", menus: true, noChromeKit: true });
  const t = s.tiles()[0]!;
  const note = t.byClass("tile-note")[0]!;
  assert.match(note.textContent, /window menus could not be built \(ChromeKit is not loaded\)\. Reload the page/);
  assert.equal(s.mounts.length, 1);
  assert.equal(t.byClass("tile-menus").length, 0);
});

test("a ChromeKit that does not destroy is detected by the close check (negative control)", () => {
  const run = (badChrome?: "destroy-missing") => {
    const s = boot({ hash: "#/terminal/a1", menus: true, badChrome });
    s.btn(s.tiles()[0]!, "Split right").click();
    s.btn(s.tiles()[0]!, "Close tile").click();
    return s.chromes[0]!.destroyed;
  };
  assert.equal(run(), 1);
  assert.equal(run("destroy-missing"), 0);
});

test("narrow fallback still renders chrome for the one visible tile", () => {
  const s = boot({ narrow: true, hash: "#/terminal/a1", menus: true });
  assert.equal(s.tiles().length, 1);
  assert.equal(s.tiles()[0]!.byClass("tile-menus").length, 1);
});

// ---- item windows: one subject per window, required, opened by focusing or splitting ----
const selectOf = (tile: Node_) => tile.all().find((n) => n.tagName === "select");
const optionValues = (tile: Node_) =>
  selectOf(tile)!
    .children.map((o) => o.value)
    .join(",");
const subjectsOf = (s: ReturnType<typeof boot>) =>
  s.api
    .state()
    .leaves.map((l) => `${l.view}:${l.params.agent ?? ""}:${l.params.report ?? ""}`)
    .join(" ");
const twoLeaves = (a: unknown, b: unknown) =>
  JSON.stringify({ version: 1, next: 4, focus: "t1", root: { kind: "split", id: "s3", dir: "row", ratio: 0.5, children: [a, b] } });
const lf = (id: string, view: string, params: object = {}) => ({ kind: "leaf", id, view, params });

test("a report hash opens a report window with agent and report; ids with slash, percent and unicode round-trip without clobbering the hash", () => {
  const agent = "a/1";
  const report = "r%x/y\u00e9 z";
  const hash = `#/report/${encodeURIComponent(agent)}/${encodeURIComponent(report)}`;
  const s = boot({ hash });
  assert.equal(s.mounts.length, 1);
  assert.equal(s.mounts[0]!.view, "report");
  assert.equal(s.mounts[0]!.params.agent, agent);
  assert.equal(s.mounts[0]!.params.report, report);
  assert.equal(s.location.hash, hash, "start-up leaves the canonical hash as it is");
  assert.deepEqual(s.replaced, [], "no replaceState: syncHash does not clobber");
  s.btn(s.tiles()[0]!, "Split right").click();
  s.tileOf("t1").fire("pointerdown"); // focusing the report tile writes its hash back
  assert.equal(s.location.hash, hash, "round trip: the written hash is the same one");
  s.hashchange(hash);
  assert.equal(s.mounts.length, 1, "the same subject is focused, never duplicated");
  assert.equal(s.tiles().length, 2);
  assert.equal(s.assigns.length, 0);
});

test("a malformed or incomplete item hash is ignored at start-up and on hashchange", () => {
  const bad = [
    "#/terminal",
    "#/terminal/",
    "#/terminal//x",
    "#/report",
    "#/report/a1",
    "#/report/a1/",
    "#/report//r1",
    "#/terminal/%E0%A4%A",
    "#/report/a1/%E0%A4%A",
    `#/terminal/${"a".repeat(257)}`,
    `#/report/a1/${"r".repeat(257)}`,
    `#/report/${"a".repeat(257)}/r1`,
  ];
  for (const h of bad) {
    const start = boot({ hash: h });
    assert.equal(subjectsOf(start), "tree::", `start-up ${h.slice(0, 30)}`);
    assert.equal(start.mounts.length, 0);
    const s = boot();
    s.hashchange(h);
    assert.equal(subjectsOf(s), "tree::", `hashchange ${h.slice(0, 30)}`);
    assert.equal(s.mounts.length, 0);
    assert.equal(s.writes.length, 0);
  }
  const ok = boot();
  ok.hashchange("#/report/a1/r1"); // negative control: the complete form is opened
  assert.equal(ok.mounts.length, 1);
});

test("an item hash splits the largest tile that can be split and leaves the others as they were, instead of retargeting", () => {
  const s = boot();
  s.hashchange("#/terminal/a1");
  assert.equal(subjectsOf(s), "tree:: terminal:a1:");
  assert.equal(s.api.state().focus, "t2");
  assert.deepEqual(s.log, ["+tree"], "the tree stayed active and mounted");
  s.hashchange("#/report/a1/r1");
  assert.equal(subjectsOf(s), "tree:: terminal:a1: report:a1:r1", "split the focused terminal tile (tied for largest), which stays");
  assert.equal(s.mounts[0]!.unmounted, false);
  assert.equal(stored(s.store).root.children.length, 2, "the new layout is saved");
  // a browsing view still retargets or focuses as before
  s.hashchange("#/hosts");
  assert.equal(subjectsOf(s), "tree:: terminal:a1: hosts::");
});

test("an item hash against a stored layout splits it, saves it, and focuses an existing subject without a save", () => {
  const stored1 = JSON.stringify({ version: 1, next: 2, focus: "t1", root: lf("t1", "tree") });
  const s = boot({ store: { "pomtree.layout": stored1 }, hash: "#/terminal/a1" });
  assert.equal(subjectsOf(s), "tree:: terminal:a1:");
  assert.equal(s.mounts.length, 1);
  assert.equal(stored(s.store).root.children[1].params.agent, "a1");
  const writes = s.writes.length;
  const again = boot({ store: { "pomtree.layout": s.store["pomtree.layout"]! }, hash: "#/terminal/a1" });
  assert.equal(subjectsOf(again), "tree:: terminal:a1:");
  assert.equal(again.writes.length, 0, "already shown: only focus, nothing to save");
  assert.equal(writes > 0, true);
});

test("in narrow mode an item hash replaces the single window and never persists", () => {
  const s = boot({ narrow: true });
  s.hashchange("#/report/a1/r1");
  assert.equal(subjectsOf(s), "report:a1:r1");
  assert.equal(s.writes.length, 0);
  const start = boot({
    narrow: true,
    hash: "#/terminal/a1",
    store: { "pomtree.layout": JSON.stringify({ version: 1, next: 2, focus: "t1", root: lf("t1", "tree") }) },
  });
  assert.equal(subjectsOf(start), "terminal:a1:");
  assert.equal(start.writes.length, 0, "the stored desktop layout is left alone");
});

// A balanced 16-tile layout of terminals (each its own agent) or reports, at the tile limit but inside the depth limit.
const full16 = (view: "terminal" | "report") => {
  let n = 0;
  const go = (k: number): unknown => {
    if (k === 1) {
      const i = ++n;
      return lf(`t${i}`, view, view === "terminal" ? { agent: `a${i}` } : { agent: "a", report: `r${i}` });
    }
    const a = go(k / 2);
    const b = go(k / 2);
    return { kind: "split", id: `s${100 + ++n}`, dir: n % 2 ? "row" : "col", ratio: 0.5, children: [a, b] };
  };
  const root = go(16);
  return JSON.stringify({ version: 1, next: 200, focus: "t1", root });
};

test("a hash opening at 16 tiles shows the limit notice and adds nothing", () => {
  const s = boot({ store: { "pomtree.layout": full16("terminal") } });
  assert.equal(s.api.state().leaves.length, 16);
  s.hashchange("#/terminal/zzz");
  assert.equal(s.api.state().leaves.length, 16);
  assert.equal(
    s.api.state().leaves.some((l) => l.params.agent === "zzz"),
    false,
  );
  assert.match(s.noticeTexts().join("|"), /Cannot open another window: a layout holds at most 16 tiles\. Close a tile first\./);
  const r = boot({ store: { "pomtree.layout": full16("report") } });
  r.api.openView("report", "a", "last");
  assert.equal(r.api.state().leaves.length, 16);
  assert.match(r.noticeTexts().join("|"), /Cannot open another window: a layout holds at most 16 tiles/);
  const third = r.api.state().leaves[2]!; // negative control: an open subject is still focused at the limit
  r.api.openView("report", "a", third.params.report);
  assert.equal(r.api.state().focus, third.id);
});

test("repeated item hashes from a Tree-only layout split the largest tile: none is refused before 16 tiles, the Tree stays, the 17th shows the notice", () => {
  for (const zero of [false, true]) {
    const s = boot();
    if (zero) s.root.rect = { left: 0, top: 0, width: 0, height: 0 };
    for (let i = 1; i <= 15; i++) {
      s.hashchange(`#/terminal/n${i}`);
      assert.equal(s.api.state().leaves.length, i + 1, `zero=${zero} open ${i}`);
      assert.equal(
        s.api.state().leaves.some((l) => l.params.agent === `n${i}`),
        true,
        `zero=${zero} open ${i} shown`,
      );
      assert.equal(s.noticeTexts().length, 0, `zero=${zero} no notice at ${i}`);
    }
    assert.equal(
      s.api.state().leaves.some((l) => l.view === "tree"),
      true,
      "the Tree tile still exists",
    );
    s.hashchange("#/terminal/n16");
    assert.equal(s.api.state().leaves.length, 16);
    assert.equal(
      s.api.state().leaves.some((l) => l.params.agent === "n16"),
      false,
    );
    assert.match(s.noticeTexts().join("|"), /Cannot open another window: a layout holds at most 16 tiles\. Close a tile first\./);
  }
});

test("a leaf at the depth limit is skipped when it is the largest and focused: the next largest is split instead", () => {
  let n = 0;
  const chain = (k: number): unknown => {
    if (k === 8) return { kind: "split", id: `s${100 + k}`, dir: "row", ratio: 0.15, children: [lf("t8", "tree"), lf("t9", "hosts")] };
    return { kind: "split", id: `s${100 + k}`, dir: "row", ratio: 0.15, children: [lf(`t${++n}`, "reports"), chain(k + 1)] };
  };
  const layout = JSON.stringify({ version: 1, next: 200, focus: "t9", root: chain(1) });
  const s = boot({ store: { "pomtree.layout": layout } });
  assert.equal(s.api.state().leaves.length, 9);
  assert.equal(s.api.state().focus, "t9");
  s.hashchange("#/terminal/deep");
  assert.equal(s.api.state().leaves.length, 10, "opened although the largest, focused leaf is at the depth limit");
  assert.equal(s.noticeTexts().length, 0);
  assert.equal(
    s.api.state().leaves.some((l) => l.params.agent === "deep"),
    true,
  );
});

test("a hash opening that fails at the limit restores the focused tile's hash so the same link fires again and shows the notice again", () => {
  const s = boot({ store: { "pomtree.layout": full16("terminal") } });
  assert.equal(s.location.hash, "#/terminal/a1");
  s.hashchange("#/terminal/zzz");
  assert.equal(s.location.hash, "#/terminal/a1", "the refused link's hash is replaced");
  assert.equal(s.noticeTexts().length, 1);
  s.hashchange("#/terminal/zzz");
  assert.equal(s.location.hash, "#/terminal/a1");
  assert.match(s.noticeTexts().join("|"), /Cannot open another window/);
});

test("api.openView opens and focuses an item per subject and refuses an item view without its subject", () => {
  const s = boot();
  s.api.openView("report", "a1", "r1");
  s.api.openView("report", "a1", "r2");
  assert.equal(subjectsOf(s), "tree:: report:a1:r1 report:a1:r2");
  s.api.openView("report", "a1", "r1");
  assert.equal(s.tiles().length, 3, "the same report is focused, not duplicated");
  assert.equal(s.api.state().focus, "t2");
  s.api.openView("report", "a2", "r1");
  assert.equal(s.tiles().length, 4, "another agent's report of the same id is another subject");
  for (const [view, agent, report] of [
    ["terminal", undefined, undefined],
    ["terminal", "", undefined],
    ["report", "a1", undefined],
    ["report", undefined, "r1"],
    ["report", undefined, undefined],
  ] as const) {
    const n = s.tiles().length;
    s.api.openView(view, agent, report);
    assert.equal(s.tiles().length, n, `${view} ${agent} ${report}`);
  }
  assert.match(s.noticeTexts().join("|"), /Cannot open Report without an agent and a report id/);
  const t = boot();
  t.api.openView("terminal");
  assert.equal(t.tiles().length, 1);
  assert.match(t.noticeTexts().join("|"), /Cannot open TERMINAL without an agent/);
  t.api.openView("terminal", "a1", "ignored");
  assert.equal(subjectsOf(t), "tree:: terminal:a1:", "a terminal ignores a report id");
});

test("item tiles show no view selector; browsing tiles list only browsing views", () => {
  const s = boot();
  s.api.openView("terminal", "a1");
  s.api.openView("report", "a1", "r1");
  const t = s.tileOf("t2");
  assert.equal(selectOf(t), undefined, "terminal tile: no selector");
  assert.equal(selectOf(s.tileOf("t4")), undefined, "report tile: no selector");
  assert.ok(s.btn(t, "Split right") && s.btn(t, "Split down") && s.btn(t, "Close tile"), "split and close stay");
  assert.equal(t.byClass("tile-title")[0]!.textContent, "Terminal · a1");
  assert.equal(optionValues(s.tileOf("t1")), "tree,reports,hosts");
  // negative control: the selector still exists and works on a browsing tile
  const sel = selectOf(s.tileOf("t1"))!;
  sel.value = "hosts";
  sel.fire("change");
  assert.equal(subjectsOf(s), "hosts:: terminal:a1: report:a1:r1");
  // a forced change to an item view is ignored, never producing an agent-less tile
  sel.value = "terminal";
  sel.fire("change");
  assert.equal(subjectsOf(s), "hosts:: terminal:a1: report:a1:r1");
  assert.equal(selectOf(s.tileOf("t1"))!.value, "hosts");
});

test("the split buttons add a browsing view not yet shown, and a notice instead of a tile once all are shown", () => {
  const s = boot({ tabs: ["tree", "reports", "terminal"] });
  s.api.openView("terminal", "a1"); // t2, focused
  s.btn(s.tileOf("t2"), "Split right").click();
  assert.equal(subjectsOf(s), "tree:: terminal:a1: reports::", "an item view is never picked");
  const n = s.tiles().length;
  s.btn(s.tileOf("t1"), "Split down").click();
  assert.equal(s.tiles().length, n, "every browsing view is shown: nothing is split");
  assert.match(s.noticeTexts().join("|"), /Every browsing window is already open/);
  assert.equal(s.mounts.filter((m) => !m.params.agent).length, 0, "no agent-less tile was mounted");
  s.api.splitFocused("row");
  assert.equal(s.tiles().length, n);
});

test("a stored layout with an item tile that lacks its subject is not used, with a visible message naming tile and view", () => {
  for (const [view, params, needle] of [
    ["terminal", {}, "tile t2 shows terminal without an agent"],
    ["report", { agent: "a1" }, "tile t2 shows report without a report id"],
    ["report", {}, "tile t2 shows report without an agent"],
  ] as const) {
    const s = boot({ store: { "pomtree.layout": twoLeaves(lf("t1", "tree"), lf("t2", view, params)) } });
    assert.equal(subjectsOf(s), "tree::", "the default layout is shown");
    assert.equal(s.mounts.length, 0);
    assert.match(s.noticeTexts().join("|"), /saved layout was not used/);
    assert.ok(s.noticeTexts().join("|").includes(needle), needle);
    assert.equal(s.writes.length, 0, "the rejected layout stays in storage");
  }
  const ok = boot({ store: { "pomtree.layout": twoLeaves(lf("t1", "tree"), lf("t2", "report", { agent: "a1", report: "r1" })) } });
  assert.equal(subjectsOf(ok), "tree:: report:a1:r1");
  assert.equal(ok.noticeTexts().length, 0);
});

test("Import refuses a layout with a subject-less item tile and keeps the current layout", async () => {
  const s = boot();
  s.api.importFile({ text: async () => twoLeaves(lf("t1", "tree"), lf("t2", "terminal")) });
  await new Promise((r) => setImmediate(r));
  assert.match(s.noticeTexts().join("|"), /Import failed\. .*tile t2 shows terminal without an agent/);
  assert.equal(subjectsOf(s), "tree::");
  s.api.importFile({ text: async () => twoLeaves(lf("t1", "tree"), lf("t2", "report", { agent: "a1", report: "r1" })) });
  await new Promise((r) => setImmediate(r));
  assert.equal(subjectsOf(s), "tree:: report:a1:r1");
});

test("imported repeats of one subject get the defensive note; another report of the same agent mounts; the tile signature includes the report", async () => {
  const dup = boot({
    store: { "pomtree.layout": twoLeaves(lf("t1", "report", { agent: "a", report: "r1" }), lf("t2", "report", { agent: "a", report: "r1" })) },
  });
  assert.equal(dup.mounts.length, 1);
  assert.match(dup.tileOf("t2").byClass("tile-note")[0]!.textContent, /already shown in another tile/);
  assert.equal(selectOf(dup.tileOf("t2")), undefined, "the note tile of an item view has no selector either");
  const other = boot({
    store: { "pomtree.layout": twoLeaves(lf("t1", "report", { agent: "a", report: "r1" }), lf("t2", "report", { agent: "a", report: "r2" })) },
  });
  assert.equal(other.mounts.length, 2);
  // same tile id and view and agent, other report: the tile is rebuilt, the old window unmounted
  const s = boot({ store: { "pomtree.layout": JSON.stringify({ version: 1, next: 2, focus: "t1", root: lf("t1", "report", { agent: "a", report: "r1" }) }) } });
  s.api.importFile({ text: async () => JSON.stringify({ version: 1, next: 2, focus: "t1", root: lf("t1", "report", { agent: "a", report: "r2" }) }) });
  await new Promise((r) => setImmediate(r));
  assert.equal(s.mounts.length, 2);
  assert.equal(s.mounts[0]!.unmounted, true);
  assert.equal(s.mounts[1]!.params.report, "r2");
});

// The driver tests use a fake api, so a member the driver calls that the real shell lacks would pass them and fail only in the page.
test("the real shell api has every member the ui driver calls (negative control: a made-up member is absent)", () => {
  const s = boot();
  const real = s.api as unknown as Record<string, unknown>;
  const used = new Set([...UI_DRIVER_JS.matchAll(/\bapi\.(\w+)\(/g)].map((m) => m[1]!));
  assert.ok(used.has("openView") && used.has("notify"), "the scan finds the driver's calls");
  const missing = [...used].filter((name) => typeof real[name] !== "function");
  assert.deepEqual(missing, []);
  assert.equal(typeof real.noSuchMember, "undefined");
});

test("api.notify shows a notice through textContent", () => {
  const s = boot();
  s.api.notify("ui-command", "<b>hi</b>");
  assert.ok(s.noticeTexts().some((t) => t.startsWith("<b>hi</b>")));
});

test("api.focusSubject focuses the tile showing that subject and returns false when none shows it", () => {
  const s = boot();
  s.api.openView("terminal", "a1");
  s.api.openView("terminal", "a2");
  const a2 = s.api.state().leaves.find((l) => l.params.agent === "a2")!;
  assert.equal(s.api.state().focus, a2.id);
  assert.equal(s.api.focusSubject("terminal", { agent: "a1" }), true);
  const a1 = s.api.state().leaves.find((l) => l.params.agent === "a1")!;
  assert.equal(s.api.state().focus, a1.id);
  assert.equal(s.api.focusSubject("terminal", { agent: "zz" }), false);
  assert.equal(s.api.state().focus, a1.id);
  assert.equal(s.api.focusSubject("report", { agent: "a1", report: "r1" }), false);
});

// What the drive does for a close: leafOf (params normalised like focusSubject), then window.close.
const closeBySubject = (s: ReturnType<typeof boot>, view: string, params: { agent?: string; report?: string }) => {
  const at = s.api.leafOf(view, params);
  return at !== null && s.api.windowCommand("window.close", at);
};

test("api.focusedLeaf names the focused tile and is null when no window is open", () => {
  const s = boot();
  s.api.openView("terminal", "a1");
  assert.equal(s.api.focusedLeaf(), s.api.state().focus);
  assert.equal(s.api.focusSubject("tree", {}), true);
  assert.equal(s.api.focusedLeaf(), s.api.leafOf("tree", {}));
  s.api.windowCommand("window.close-all", null);
  assert.equal(s.api.focusedLeaf(), null);
});

test("leafOf + window.close closes that tile once, then returns false", () => {
  const s = boot();
  s.api.openView("terminal", "a1");
  const before = s.api.state().leaves.length;
  assert.equal(closeBySubject(s, "terminal", { agent: "a1" }), true);
  assert.equal(s.api.state().leaves.length, before - 1);
  assert.equal(
    s.api.state().leaves.some((l) => l.params.agent === "a1"),
    false,
  );
  assert.equal(closeBySubject(s, "terminal", { agent: "a1" }), false);
});

test("leafOf + window.close may close the last tile into the empty state", () => {
  const s = boot({ store: { "pomtree.layout": JSON.stringify({ version: 1, next: 2, focus: "t1", root: lf("t1", "terminal", { agent: "a1" }) }) } });
  assert.equal(closeBySubject(s, "terminal", { agent: "a1" }), true);
  assert.equal(s.api.state().leaves.length, 0);
});

test("api.focusDirection moves focus to the neighbour and returns false at the edge", () => {
  const s = boot({
    store: {
      "pomtree.layout": JSON.stringify({
        version: 1,
        next: 4,
        focus: "t1",
        root: { kind: "split", id: "s1", dir: "row", ratio: 0.5, children: [lf("t1", "tree"), lf("t2", "terminal", { agent: "a1" })] },
      }),
    },
  });
  assert.equal(s.api.focusDirection("right"), true);
  assert.equal(s.api.state().focus, "t2");
  assert.equal(s.api.focusDirection("right"), false);
  assert.equal(s.api.focusDirection("left"), true);
  assert.equal(s.api.state().focus, "t1");
});

test("api.arrange grid keeps four tiles and a narrow screen shows a notice and changes nothing", () => {
  const s = boot();
  for (const a of ["a1", "a2", "a3"]) s.api.openView("terminal", a);
  const n = s.api.state().leaves.length;
  assert.ok(n >= 3);
  while (s.api.state().leaves.length < 4) s.api.openView("report", "a1", `r${s.api.state().leaves.length}`);
  assert.equal(s.api.arrange("grid"), true);
  assert.equal(s.api.state().leaves.length, 4);
  assert.equal(s.tiles().length, 4);
  const narrow = boot({ narrow: true });
  const before = narrow.api
    .state()
    .leaves.map((l) => l.id)
    .join();
  assert.equal(narrow.api.arrange("grid"), false);
  assert.match(narrow.noticeTexts().join("|"), /arrange is ignored on narrow screens.*wider/i);
  assert.equal(
    narrow.api
      .state()
      .leaves.map((l) => l.id)
      .join(),
    before,
  );
});

test("api.dismiss removes a notice by key", () => {
  const s = boot();
  s.api.notify("k", "hello");
  assert.equal(s.noticeTexts().length, 1);
  s.api.dismiss("k");
  assert.equal(s.noticeTexts().length, 0);
});

test("api.arrange on an empty layout shows a nothing-to-arrange notice", () => {
  const s = boot({ store: { "pomtree.layout": JSON.stringify({ version: 1, next: 2, focus: "", root: null }) } });
  assert.equal(s.api.state().leaves.length, 0);
  assert.equal(s.api.arrange("grid"), false);
  assert.match(s.noticeTexts().join("|"), /Nothing to arrange: no windows are open\. Open a window first\./);
});

test("api.focusDirection on a narrow screen shows the narrow notice, not a no-window one", () => {
  const s = boot({ narrow: true });
  assert.equal(s.api.focusDirection("left"), false);
  const t = s.noticeTexts().join("|");
  assert.match(t, /ignored on narrow screens.*wider/i);
  assert.doesNotMatch(t, /No window to focus/);
});

test("api.focusDirection at the edge says there is no window that way", () => {
  const s = boot();
  assert.equal(s.api.focusDirection("left"), false);
  assert.match(s.noticeTexts().join("|"), /No window to focus left/);
});

test("focus and close normalise params like open: a browsing view with an agent, a terminal with a stray report", () => {
  const s = boot();
  s.api.openView("tree", "a1");
  s.api.openView("terminal", "a1", "r9");
  assert.equal(s.api.focusSubject("tree", { agent: "a1" }), true);
  assert.equal(s.api.focusSubject("terminal", { agent: "a1", report: "r9" }), true);
  assert.equal(closeBySubject(s, "terminal", { agent: "a1", report: "r9" }), true);
  assert.equal(closeBySubject(s, "terminal", { agent: "a1" }), false);
  assert.equal(closeBySubject(s, "tree", { agent: "a1" }), true);
});

// ---- window menu, maximize and minimize ----
const geomOf = (t: Node_) => [t.style.left, t.style.top, t.style.width, t.style.height].join(",");
// geometry by leaf id: the DOM order of tiles changes when a tile is rebuilt, the geometry per window must not
const geomById = (s: ReturnType<typeof boot>) =>
  s
    .tiles()
    .map((t) => `${t.getAttribute("data-tile")}=${geomOf(t)}`)
    .sort();
const idOf = (s: ReturnType<typeof boot>, view: string, agent?: string) => s.api.state().leaves.find((l) => l.view === view && l.params.agent === agent)!.id;
const splitters = (s: ReturnType<typeof boot>) => s.root.byClass("splitter");
const hiddenOf = (s: ReturnType<typeof boot>) =>
  s.api
    .state()
    .leaves.filter((l) => l.hidden)
    .map((l) => l.view);
// tree, hosts and terminal a1 in reading order
const three = () => {
  const s = boot();
  s.api.openView("hosts");
  s.api.openView("terminal", "a1");
  return s;
};
const ctxItemsOf = (s: ReturnType<typeof boot>) => s.body.byClass("ctx-item");
const ctxLabels = (s: ReturnType<typeof boot>) => ctxItemsOf(s).map((i) => i.textContent);
const ctxDisabled = (s: ReturnType<typeof boot>) =>
  ctxItemsOf(s)
    .filter((i) => i.getAttribute("aria-disabled") === "true")
    .map((i) => i.textContent);
const barOf = (t: Node_) => t.byClass("tile-bar")[0]!;
const closeMenu = (s: ReturnType<typeof boot>) => {
  for (const m of s.body.byClass("ctx-menu")) m.remove();
};

test("maximize leaves one tile at full geometry with no splitters; restore returns the same geometry and splitters", () => {
  const s = three();
  const hosts = idOf(s, "hosts");
  const before = geomById(s);
  assert.equal(s.tiles().length, 3);
  assert.equal(splitters(s).length, 2);
  assert.equal(s.api.windowCommand("window.maximize", hosts), true);
  assert.equal(s.tiles().length, 1);
  assert.equal(s.tiles()[0]!.getAttribute("data-tile"), hosts);
  assert.equal(geomOf(s.tiles()[0]!), "0%,0%,100%,100%");
  assert.equal(splitters(s).length, 0);
  assert.equal(s.api.state().maximized, hosts);
  assert.equal(stored(s.store).max, hosts, "the maximized state is persisted");
  assert.equal(s.api.windowCommand("window.restore", null), true);
  assert.equal(s.tiles().length, 3);
  assert.deepEqual(geomById(s), before);
  assert.equal(splitters(s).length, 2);
  assert.equal(s.api.state().maximized, "");
  assert.equal(stored(s.store).max, undefined, "negative control: the key is gone after restore");
});

test("tiles that are not shown are released: a maximized terminal hides the others and its mount survives; restoring remounts them", () => {
  const s = three();
  const mounted = s.mounts.length;
  s.api.windowCommand("window.maximize", idOf(s, "hosts"));
  assert.equal(s.mounts[mounted - 1]!.unmounted, true, "the terminal behind the zoom is unmounted (wm-restore-remount)");
  assert.deepEqual(visibleSections(s), ["hosts"]);
  s.api.windowCommand("window.restore", null);
  assert.equal(s.mounts.length, mounted + 1, "the terminal is mounted again on restore");
  assert.deepEqual(visibleSections(s).sort(), ["hosts", "tree"]);
});

test("closing the maximized window restores the tiling around it", () => {
  const s = three();
  const hosts = idOf(s, "hosts");
  s.api.windowCommand("window.maximize", hosts);
  assert.equal(s.api.windowCommand("window.close", hosts), true);
  assert.equal(s.api.state().maximized, "");
  assert.equal(s.tiles().length, 2);
  assert.deepEqual(
    s.api.state().leaves.map((l) => l.view),
    ["tree", "terminal"],
  );
  const t = three();
  t.api.windowCommand("window.maximize", idOf(t, "hosts"));
  t.api.windowCommand("window.close", idOf(t, "tree"));
  assert.equal(t.api.state().maximized, idOf(t, "hosts"), "negative control: closing another window keeps the zoom");
});

test("minimize removes the tile and keeps the window in the state as hidden; the others re-tile over the freed area", () => {
  const s = three();
  const hosts = idOf(s, "hosts");
  assert.equal(s.api.windowCommand("window.minimize", hosts), true);
  assert.equal(s.tiles().length, 2);
  assert.deepEqual(hiddenOf(s), ["hosts"]);
  assert.equal(s.api.state().leaves.length, 3, "still listed");
  assert.equal(splitters(s).length, 1);
  assert.equal(
    s.tiles().reduce((a, t) => a + parseFloat(t.style.width!) * parseFloat(t.style.height!), 0),
    10000,
    "two tiles fill the whole area (percent of width times percent of height)",
  );
  assert.equal(
    stored(s.store).root.children.some((c: any) => c.hidden === true || (c.children ?? []).some((d: any) => d.hidden === true)),
    true,
  );
  assert.notEqual(s.api.state().focus, hosts, "focus left the minimized window");
});

test("focusing a minimized window (the bar entry's click) restores it into the layout and focuses it", () => {
  const s = three();
  const hosts = idOf(s, "hosts");
  s.api.windowCommand("window.minimize", hosts);
  s.api.focus(hosts);
  assert.deepEqual(hiddenOf(s), []);
  assert.equal(s.tiles().length, 3);
  assert.equal(s.api.state().focus, hosts);
  assert.equal(s.tileOf(hosts).className, "tile tile-focused");
});

test("minimizing every window shows the all-minimized hint and clears the hash; a reload keeps them minimized", () => {
  const s = boot({ hash: "#/tree" });
  assert.equal(s.root.byClass("wm-empty").length, 0);
  assert.equal(s.api.windowCommand("window.minimize", "t1"), true);
  assert.equal(s.tiles().length, 0);
  assert.equal(s.root.byClass("wm-empty")[0]!.textContent, "All windows are minimized: click one in the bar to restore it.");
  assert.equal(s.location.hash, "", "the hash is cleared: a reload must not reopen the last window");
  assert.equal(s.api.state().focus, "");
  const writesBefore = JSON.stringify(s.store);
  const r = boot({ store: s.store });
  assert.equal(r.tiles().length, 0);
  assert.deepEqual(hiddenOf(r), ["tree"]);
  assert.match(r.root.byClass("wm-empty")[0]!.textContent, /All windows are minimized/);
  assert.equal(JSON.stringify(r.store), writesBefore, "reload does not rewrite or unhide the stored layout");
  assert.equal(r.location.hash, "");
  s.api.windowCommand("window.close-all", null);
  assert.match(s.root.byClass("wm-empty")[0]!.textContent, /^No windows open/, "negative control: with no windows the other hint shows");
});

test("showView while a window is maximized restores the tiling, then places the new window on it", () => {
  const s = three();
  const hosts = idOf(s, "hosts");
  s.api.windowCommand("window.maximize", hosts);
  s.api.openView("reports");
  assert.equal(s.api.state().maximized, "");
  assert.equal(s.tiles().length, 4);
  assert.deepEqual(
    s.api
      .state()
      .leaves.map((l) => l.view)
      .sort(),
    ["hosts", "reports", "terminal", "tree"],
  );
  assert.equal(s.api.state().focus, idOf(s, "reports"));
  assert.equal(stored(s.store).max, undefined);
});

test("a follow-style open of an agent terminal while maximized restores first and shows the new window", () => {
  const s = three();
  s.api.windowCommand("window.maximize", idOf(s, "tree"));
  s.api.openView("terminal", "a2");
  assert.equal(s.api.state().maximized, "");
  assert.equal(s.tiles().length, 4);
  assert.equal(s.api.state().focus, idOf(s, "terminal", "a2"));
  assert.equal(s.location.hash, "#/terminal/a2");
});

test("a hash link to a new item while maximized restores first; one to a shown window moves the zoom to it", () => {
  const s = three();
  s.api.windowCommand("window.maximize", idOf(s, "hosts"));
  s.hashchange("#/terminal/a9");
  assert.equal(s.api.state().maximized, "");
  assert.equal(s.tiles().length, 4);
  const t = three();
  const hosts = idOf(t, "hosts");
  t.api.windowCommand("window.maximize", hosts);
  t.hashchange("#/terminal/a1");
  assert.equal(t.api.state().maximized, idOf(t, "terminal", "a1"), "an already open subject is focused, so the zoom follows it");
  assert.equal(t.tiles().length, 1);
  const u = three();
  u.api.windowCommand("window.maximize", idOf(u, "terminal", "a1"));
  u.hashchange("#/reports");
  assert.equal(u.api.state().maximized, "", "a browsing view not yet shown also restores first");
  assert.ok(u.api.state().leaves.some((l) => l.view === "reports"));
});

test("showView refused at the tile limit while maximized leaves the zoom as it was", () => {
  const s = boot();
  for (let i = 1; i < 16; i++) s.api.openView("terminal", `a${i}`);
  assert.equal(s.api.state().leaves.length, 16);
  const id = idOf(s, "terminal", "a3");
  s.api.windowCommand("window.maximize", id);
  s.api.openView("terminal", "a99");
  assert.equal(s.api.state().maximized, id, "the failed open did not commit the restore");
  assert.equal(s.api.state().leaves.length, 16);
  assert.match(s.noticeTexts().join("|"), /at most 16 tiles/);
});

test("showView on an all-minimized layout splits in beside the first window and keeps it minimized", () => {
  const s = boot();
  s.api.windowCommand("window.minimize", "t1");
  s.api.openView("hosts");
  assert.equal(s.tiles().length, 1);
  assert.equal(s.tiles()[0]!.getAttribute("data-tile") === "t1", false);
  assert.deepEqual(hiddenOf(s), ["tree"]);
  assert.equal(s.api.state().leaves.length, 2);
  assert.equal(s.api.state().focus, idOf(s, "hosts"));
  assert.equal(s.location.hash, "#/hosts");
  assert.equal(s.root.byClass("wm-empty").length, 0);
});

test("opening a minimized subject focuses and unhides it instead of adding a window", () => {
  const s = three();
  const t = idOf(s, "terminal", "a1");
  s.api.windowCommand("window.minimize", t);
  assert.deepEqual(hiddenOf(s), ["terminal"]);
  s.api.openView("terminal", "a1");
  assert.deepEqual(hiddenOf(s), []);
  assert.equal(s.api.state().leaves.length, 3);
  assert.equal(s.api.state().focus, t);
});

test("api.leafOf finds any window, minimized ones included, normalising params; unknown is null", () => {
  const s = three();
  const t = idOf(s, "terminal", "a1");
  s.api.windowCommand("window.minimize", t);
  assert.equal(s.api.leafOf("terminal", { agent: "a1" }), t);
  assert.equal(s.api.leafOf("terminal", { agent: "a1", report: "stray" }), t);
  assert.equal(s.api.leafOf("hosts", { agent: "zzz" }), idOf(s, "hosts"));
  assert.equal(s.api.leafOf("terminal", { agent: "other" }), null);
});

test("a window command that changes nothing returns false with a notice naming the command and the reason", () => {
  const s = boot();
  assert.equal(s.api.windowCommand("window.close-others", "t1"), false);
  assert.match(s.noticeTexts().join("|"), /Close others does nothing here: there is no other window\./);
  assert.equal(s.api.windowCommand("window.close-left", "t1"), false);
  assert.match(s.noticeTexts().join("|"), /Close to the left does nothing here: it is the first window in the bar\./);
  assert.equal(s.api.windowCommand("window.maximize", "t1"), false);
  assert.match(s.noticeTexts().join("|"), /Maximize does nothing here: it is the only window shown\./);
  assert.equal(s.api.windowCommand("window.restore", null), false);
  assert.equal(s.api.windowCommand("window.close", "nope"), false);
  assert.match(s.noticeTexts().join("|"), /Close does nothing here: that window is not open\./);
  assert.equal(s.tiles().length, 1, "nothing changed");
  const w = three();
  assert.equal(w.api.windowCommand("window.close-right", idOf(w, "hosts")), true);
  assert.deepEqual(w.noticeTexts(), [], "negative control: a working command shows no notice");
});

test("the tile bar has Minimize and Maximize buttons before Close; Maximize toggles to Restore; enabled state comes from the window model", () => {
  const s = boot();
  const t = s.tileOf("t1");
  assert.deepEqual(barKinds(t).slice(-3), ["tile-btn", "tile-btn", "tile-btn"], "split buttons are not counted: three controls at the end");
  const labels = barOf(t)
    .children.filter((c) => c.tagName === "button")
    .map((b) => b.getAttribute("aria-label"));
  assert.deepEqual(labels.slice(-3), ["Minimize", "Maximize", "Close tile"]);
  assert.equal(s.btn(t, "Maximize").disabled, true, "a single window cannot be maximized");
  assert.equal(s.btn(t, "Minimize").disabled, false);
  s.api.openView("hosts");
  const tree = s.tileOf("t1");
  assert.equal(s.btn(tree, "Maximize").disabled, false);
  s.btn(tree, "Maximize").click();
  assert.equal(s.api.state().maximized, "t1");
  assert.equal(s.btn(s.tileOf("t1"), "Maximize"), undefined, "the label changed");
  const restore = s.btn(s.tileOf("t1"), "Restore");
  assert.equal(restore.getAttribute("title"), "Restore");
  restore.click();
  assert.equal(s.api.state().maximized, "");
  assert.equal(s.btn(s.tileOf("t1"), "Maximize").getAttribute("title"), "Maximize");
  s.btn(s.tileOf("t1"), "Minimize").click();
  assert.deepEqual(hiddenOf(s), ["tree"]);
  assert.equal(s.tiles().length, 1);
  s.btn(s.tiles()[0]!, "Close tile").click();
  assert.equal(s.api.state().leaves.length, 1, "Close still closes the window");
});

test("double-clicking the tile title toggles maximize and restore; with one window it does nothing and shows no notice", () => {
  const s = three();
  const hosts = idOf(s, "hosts");
  s.tileOf(hosts).byClass("tile-title")[0]!.fire("dblclick");
  assert.equal(s.api.state().maximized, hosts);
  s.tileOf(hosts).byClass("tile-title")[0]!.fire("dblclick");
  assert.equal(s.api.state().maximized, "");
  const one = boot();
  one.tileOf("t1").byClass("tile-title")[0]!.fire("dblclick");
  assert.equal(one.api.state().maximized, "");
  assert.deepEqual(one.noticeTexts(), []);
});

test("right-click on a tile bar opens the window menu for that tile; items are disabled per window", () => {
  const s = three();
  const tree = idOf(s, "tree");
  assert.equal(ctxItemsOf(s).length, 0);
  barOf(s.tileOf(tree)).fire("contextmenu", { clientX: 4, clientY: 5 });
  assert.equal(s.body.byClass("ctx-menu")[0]!.getAttribute("role"), "menu");
  assert.deepEqual(ctxLabels(s), ["Maximize", "Minimize", "Close", "Close others", "Close to the left", "Close to the right", "Close all"]);
  assert.deepEqual(ctxDisabled(s), ["Close to the left"], "the first window in the bar has nothing to its left");
  closeMenu(s);
  barOf(s.tileOf(idOf(s, "terminal", "a1"))).fire("contextmenu", { clientX: 4, clientY: 5 });
  assert.deepEqual(ctxDisabled(s), ["Close to the right"]);
});

test("a maximized window's menu offers Restore first and disables Maximize; api.windowMenuItems lists the enabled commands", () => {
  const s = three();
  const hosts = idOf(s, "hosts");
  s.api.windowCommand("window.maximize", hosts);
  barOf(s.tileOf(hosts)).fire("contextmenu", { clientX: 0, clientY: 0 });
  assert.deepEqual(ctxLabels(s).slice(0, 3), ["Restore", "Maximize", "Minimize"]);
  assert.deepEqual(ctxDisabled(s), ["Maximize"], "an already maximized window cannot be maximized again; Restore is enabled");
  assert.deepEqual(
    s.api
      .windowMenuItems(hosts)
      .filter((i) => i.kind === "action" && i.visible && i.enabled)
      .map((i) => i.label),
    ["Restore", "Minimize", "Close", "Close others", "Close to the left", "Close to the right", "Close all"],
  );
});

test("picking Close others from the tile-bar menu closes the others; picking Maximize zooms", () => {
  const s = three();
  const hosts = idOf(s, "hosts");
  barOf(s.tileOf(hosts)).fire("contextmenu", { clientX: 0, clientY: 0 });
  ctxItemsOf(s)
    .find((i) => i.textContent === "Maximize")!
    .click();
  assert.equal(s.api.state().maximized, hosts);
  assert.equal(s.body.byClass("ctx-menu").length, 0, "the menu closed after the pick");
  s.api.windowCommand("window.restore", null);
  barOf(s.tileOf(hosts)).fire("contextmenu", { clientX: 0, clientY: 0 });
  ctxItemsOf(s)
    .find((i) => i.textContent === "Close others")!
    .click();
  assert.deepEqual(
    s.api.state().leaves.map((l) => l.view),
    ["hosts"],
  );
  assert.equal(s.tiles().length, 1);
});

test("the menu opens from the keyboard: the ContextMenu key and Shift+F10 on the bar, the keys on the focused tile itself but not on a view inside it", () => {
  const s = three();
  const hosts = idOf(s, "hosts");
  const tile = s.tileOf(hosts);
  const bar = barOf(tile);
  bar.fire("keydown", { key: "ContextMenu" });
  assert.equal(ctxItemsOf(s).length > 0, true);
  closeMenu(s);
  bar.fire("keydown", { key: "F10", shiftKey: true });
  assert.equal(ctxItemsOf(s).length > 0, true);
  closeMenu(s);
  tile.fire("keydown", { key: "ContextMenu", target: tile });
  assert.equal(ctxItemsOf(s).length > 0, true, "the focused tile root opens the menu");
  closeMenu(s);
  tile.fire("keydown", { key: "ContextMenu", target: tile.children[1] });
  tile.fire("keydown", { key: "F10", target: tile });
  assert.equal(ctxItemsOf(s).length, 0, "negative control: a key aimed at a view inside the tile, or plain F10, opens nothing");
});

test("Escape closes the window menu and returns focus to the focusable tile root (the bar is not focusable), running nothing", () => {
  const s = three();
  const hosts = idOf(s, "hosts");
  const bar = barOf(s.tileOf(hosts));
  const root = s.tileOf(hosts);
  bar.fire("contextmenu", { clientX: 1, clientY: 1 });
  const before = root.focused;
  const barBefore = bar.focused;
  ctxItemsOf(s)[0]!.fire("keydown", { key: "Escape" });
  assert.equal(s.body.byClass("ctx-menu").length, 0);
  assert.equal(root.focused, before + 1, "focus returns to the tile root");
  assert.equal(bar.focused, barBefore, "negative control: never the non-focusable bar");
  assert.equal(s.api.state().leaves.length, 3);
  assert.equal(s.api.state().maximized, "");
});

test("narrow: the menu offers Close and Close all only; Close replaces the visible window and leaves the saved desktop layout alone", () => {
  const desktop = (() => {
    const s = three();
    return s.store;
  })();
  const n = boot({ narrow: true, store: { ...desktop }, hash: "#/hosts" });
  assert.equal(n.tiles().length, 1);
  const leaf = n.api.state().leaves[0]!;
  assert.equal(leaf.view, "hosts");
  const before = JSON.stringify(n.store);
  barOf(n.tiles()[0]!).fire("contextmenu", { clientX: 0, clientY: 0 });
  assert.deepEqual(ctxLabels(n), ["Close", "Close others", "Close to the left", "Close to the right", "Close all"], "the zoom items are hidden");
  assert.deepEqual(ctxDisabled(n), ["Close others", "Close to the left", "Close to the right"]);
  ctxItemsOf(n)
    .find((i) => i.textContent === "Close")!
    .click();
  assert.equal(n.tiles().length, 1, "still one window shown");
  assert.equal(n.api.state().leaves[0]!.view, "tree", "the visible window is replaced by the default view");
  assert.equal(JSON.stringify(n.store), before, "the saved desktop layout was not touched");
  for (const fn of n.mqListeners) fn({ matches: false });
  assert.equal(n.tiles().length, 3, "widening shows the whole desktop layout, hosts included");
});

test("narrow: the tile Close button is enabled and closes the visible window, not a desktop window with the same subject", () => {
  const n = boot({ narrow: true, store: { ...three().store }, hash: "#/hosts" });
  const t = n.tiles()[0]!;
  assert.equal(n.api.state().leaves[0]!.view, "hosts");
  assert.equal(n.btn(t, "Close tile").disabled, false);
  const before = JSON.stringify(n.store);
  n.btn(t, "Close tile").click();
  assert.notEqual(n.api.state().leaves[0]!.view, "hosts");
  assert.equal(JSON.stringify(n.store), before, "the desktop layout still holds hosts, terminal and tree");
});

test("narrow: Close all shows the default view and keeps the saved desktop layout", () => {
  const n = boot({ narrow: true, store: { ...three().store }, hash: "#/hosts" });
  const before = JSON.stringify(n.store);
  assert.equal(n.api.windowCommand("window.close-all", null), true);
  assert.deepEqual(
    n.api.state().leaves.map((l) => l.view),
    ["tree"],
  );
  assert.equal(JSON.stringify(n.store), before, "nothing was closed on the desktop");
  for (const fn of n.mqListeners) fn({ matches: false });
  assert.equal(n.tiles().length, 3, "widening shows the intact desktop layout");
});

test("narrow: closing the default view, which is all there is to show, does nothing with a notice", () => {
  const n = boot({ narrow: true, store: { ...three().store }, hash: "#/tree" });
  assert.equal(n.api.state().leaves[0]!.view, "tree");
  const before = JSON.stringify(n.store);
  assert.equal(n.api.windowCommand("window.close", n.api.state().leaves[0]!.id), false);
  assert.match(n.noticeTexts().join("|"), /Close does nothing here: the default view is the only window narrow screens can show/);
  assert.equal(n.api.state().leaves[0]!.view, "tree");
  assert.equal(JSON.stringify(n.store), before);
});

test("narrow: the other window commands do nothing with a notice, the zoom buttons are hidden, the title double-click is ignored", () => {
  const n = boot({ narrow: true, store: { ...three().store } });
  const leaf = n.api.state().leaves[0]!.id;
  const before = JSON.stringify(n.store);
  for (const c of ["window.minimize", "window.maximize", "window.close-others", "window.close-left", "window.close-right"]) {
    assert.equal(n.api.windowCommand(c, leaf), false, c);
  }
  assert.match(n.noticeTexts().join("|"), /does nothing here: narrow screens show one window at a time\. Make the window wider than 640px\./);
  const t = n.tiles()[0]!;
  assert.equal(n.btn(t, "Minimize").hidden, true);
  assert.equal(n.btn(t, "Maximize").hidden, true);
  assert.equal(n.btn(t, "Close tile").disabled, false);
  t.byClass("tile-title")[0]!.fire("dblclick");
  assert.equal(n.api.state().maximized, "");
  assert.equal(JSON.stringify(n.store), before, "nothing was written");
  const w = boot();
  w.api.openView("hosts");
  assert.equal(w.btn(w.tileOf("t1"), "Minimize").hidden, false, "negative control: wide screens show the buttons");
});

test("narrow: closing a window that is not in the saved desktop layout still replaces it in memory and writes nothing", () => {
  const n = boot({ narrow: true });
  n.api.openView("hosts");
  const before = JSON.stringify(n.store);
  assert.equal(n.api.windowCommand("window.close", n.api.state().leaves[0]!.id), true);
  assert.equal(n.api.state().leaves[0]!.view, "tree");
  assert.equal(JSON.stringify(n.store), before);
});

test("the ui driver applies close-others, maximize, minimize and restore through the real window manager", () => {
  const s = three();
  const send = s.startDriver();
  const hosts = idOf(s, "hosts");
  send({ cmd: "maximize", view: "hosts" });
  assert.equal(s.api.state().maximized, hosts);
  send({ cmd: "restore" });
  assert.equal(s.api.state().maximized, "");
  send({ cmd: "minimize", view: "terminal", agent: "a1" });
  assert.deepEqual(hiddenOf(s), ["terminal"]);
  send({ cmd: "restore", view: "terminal", agent: "a1" });
  assert.deepEqual(hiddenOf(s), []);
  send({ cmd: "close", view: "hosts", scope: "others" });
  assert.deepEqual(
    s.api.state().leaves.map((l) => l.view),
    ["hosts"],
  );
  send({ cmd: "close", scope: "all" });
  assert.equal(s.api.state().leaves.length, 0);
  assert.deepEqual(s.noticeTexts(), []);
  const t = three();
  const sendT = t.startDriver();
  sendT({ cmd: "close", view: "reports", scope: "others" });
  assert.match(t.noticeTexts().join("|"), /Cannot close reports: that window is not open\./);
  assert.equal(t.api.state().leaves.length, 3, "negative control: an unknown window changes nothing");
});

test("maximize and restore (and un-minimize through Restore) move DOM focus into the focused tile; minimize and a refused command do not", () => {
  const s = three();
  const hosts = idOf(s, "hosts");
  s.api.windowCommand("window.maximize", hosts);
  assert.equal(s.tileOf(hosts).focused, 1);
  s.api.windowCommand("window.restore", null);
  assert.equal(s.tileOf(hosts).focused, 2);
  s.api.windowCommand("window.minimize", hosts);
  s.api.windowCommand("window.restore", hosts);
  assert.equal(s.tileOf(hosts).focused, 1, "un-minimizing mounts a fresh tile and focuses it");
  const before = s.tileOf(hosts).focused;
  s.api.windowCommand("window.maximize", "nope");
  s.api.windowCommand("window.minimize", idOf(s, "tree"));
  assert.equal(s.tileOf(hosts).focused, before, "negative control");
});
