import { test } from "node:test";
import { inspect } from "node:util";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { renderShell } from "./shell.ts";
import { LAYOUT_CSS } from "./layoutCss.ts";
import { LAYOUT_SHELL_JS } from "./layoutShell.ts";
import { MENU_NAV_JS } from "./menuNav.ts";
import { WINDOW_CHROME_JS } from "./windowChrome.ts";
import { CHROME_CSS } from "./chromeCss.ts";

// A small fake DOM: just what the window manager touches. innerHTML/outerHTML/insertAdjacentHTML throw so any use
// of them on agent data fails a test.
type L = (ev: any) => void;
class Node_ {
  tagName: string;
  className = "";
  hidden = false;
  disabled = false;
  value = "";
  href = "";
  download = "";
  type = "";
  children: Node_[] = [];
  parent: Node_ | null = null;
  style: Record<string, string> = {};
  attrs = new Map<string, string>();
  listeners = new Map<string, { fn: L; capture: boolean }[]>();
  private text = "";
  files: unknown[] | null = null;
  focused = 0;
  clicks = 0;
  captured: number[] = [];
  rect = { left: 0, top: 0, width: 1000, height: 600 };
  constructor(tag: string) {
    this.tagName = tag;
  }
  // Short descriptor so a failing assertion never inspects the parent/listener graph (it once exhausted memory).
  [inspect.custom](): string {
    return `<Node_ ${this.tagName} id=${this.attrs.get("id") ?? ""} class="${this.className}" children=${this.children.length}>`.slice(0, 119);
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.text = String(v);
    this.children = [];
  }
  set innerHTML(_v: string) {
    throw new Error("innerHTML is forbidden");
  }
  appendChild(c: Node_) {
    c.remove();
    c.parent = this;
    this.children.push(c);
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  replaceChildren() {
    for (const c of [...this.children]) c.remove();
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(t: string, fn: L, capture?: boolean) {
    const l = this.listeners.get(t) ?? [];
    l.push({ fn, capture: !!capture });
    this.listeners.set(t, l);
  }
  fire(t: string, ev: Record<string, unknown> = {}) {
    for (const { fn } of this.listeners.get(t) ?? []) fn({ preventDefault() {}, ...ev });
  }
  click() {
    this.clicks++;
    this.fire("click");
  }
  focus() {
    this.focused++;
  }
  setPointerCapture(id: number) {
    this.captured.push(id);
  }
  releasePointerCapture() {}
  getBoundingClientRect() {
    return this.rect;
  }
  get classList() {
    return {
      toggle: (name: string, force: boolean) => {
        const set = new Set(this.className.split(" ").filter(Boolean));
        if (force) set.add(name);
        else set.delete(name);
        this.className = [...set].join(" ");
      },
    };
  }
  all(): Node_[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  byClass(c: string): Node_[] {
    return this.all().filter((n) => n.className.split(" ").includes(c));
  }
}

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
  noChromeKit?: boolean; // ChromeKit is not loaded
  badChrome?: "destroy-missing"; // deliberately wrong fake used to prove a check can fail
}

interface WmApi {
  state(): { leaves: { id: string; view: string; params: { agent?: string; report?: string } }[]; focus: string; narrow: boolean; maxLeaves: number };
  views(): { id: string; title: string; multi: boolean }[];
  focus(id: string): void;
  focusDom(): void;
  openView(view: string, agent?: string, report?: string): void;
  splitFocused(dir: "row" | "col"): void;
  closeFocused(): void;
  exportLayout(): void;
  importFile(file: { text(): Promise<string> } | undefined): void;
  resetLayout(): void;
  onChange(fn: () => void): () => void;
}

function boot(o: Opts = {}) {
  const tabIds = o.tabs ?? ["tree", "reports", "hosts", "terminal"];
  const html = renderShell({ tabs: tabIds.map((id) => ({ id, title: id.toUpperCase(), render: () => "" })) });
  // the real ChromeKit (windowChrome.ts) is replaced by a fake in the sandbox so these tests do not depend on it
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!.replace(WINDOW_CHROME_JS, ""));
  const chromes: { model: any; menus: Node_; overflow: Node_; footer: Node_; destroyed: number }[] = [];
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
  const docListeners = new Map<string, { fn: L; capture: boolean }[]>();
  const winListeners = new Map<string, L[]>();
  const rafs: (() => void)[] = [];
  const mqListeners: L[] = [];
  const mq = { matches: !!o.narrow, addEventListener: (_t: string, fn: L) => mqListeners.push(fn) };
  // hash assignments (location.hash = ...) each add a history entry; replaceState swaps the current one in place.
  const assigns: string[] = [];
  const hist = { length: 1 };
  let curHash = o.hash ?? "";
  const location = {
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
        host.setTitle(params.agent ? "Terminal · " + params.agent : "Terminal");
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
        host.setTitle("Report · " + params.report);
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
        curHash = url;
      },
    },
    document: {
      body,
      getElementById: (i: string) => byId.get(i) ?? null,
      createElement: (t: string) => new Node_(t),
      querySelectorAll: (sel: string) => (sel === "section[data-tab]" ? sections : []),
      addEventListener: (t: string, fn: L, capture?: boolean) => {
        const l = docListeners.get(t) ?? [];
        l.push({ fn, capture: !!capture });
        docListeners.set(t, l);
      },
    },
    addEventListener: (t: string, fn: L) => winListeners.set(t, [...(winListeners.get(t) ?? []), fn]),
    matchMedia: () => mq,
    requestAnimationFrame: (fn: () => void) => rafs.push(fn),
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
                },
              };
              models.push(m);
              return m;
            },
            windowHost: (m: any, base: object) => ({ ...base, model: m, setMenuState() {}, setStatus() {}, onCommand() {} }),
            sectionModel: (id: string) => {
              if (!o.menus || id !== "hosts") return undefined;
              if (!sectionModelOf) sectionModelOf = { id, declaration: { menus: [{ id: "view", items: [] }], status: [] } };
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
  const api: WmApi = { ...rawApi, state: () => plain(rawApi.state()), views: () => plain(rawApi.views()) };
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
  return {
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
  assert.equal(s.btn(s.tiles()[0]!, "Close tile").disabled, true, "the last tile cannot be closed");
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
  const hideKids = LAYOUT_CSS.match(/\.tile-bar > :not\(\.tile-menus\):not\(\.tile-overflow\) \{ display: none; \}/g) ?? [];
  assert.equal(hideKids.length, 2, "once under .wm-narrow and once in the 640px media query");
  const hideEmpty = LAYOUT_CSS.match(/\.tile-bar:not\(:has\(\.tile-menus, \.tile-overflow\)\) \{ display: none; \}/g) ?? [];
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

test("layoutCss: mounted panes inside a tile get the section padding and compact controls, with no colour", () => {
  assert.doesNotMatch(LAYOUT_CSS, /(^|\n)\.tile-body \.pane[ ,{]/, "tab sections already pad themselves, so an unscoped rule would pad them twice");
  const pad = /\.tile-body \.wm-mount \.pane \{([^}]*)\}/.exec(LAYOUT_CSS);
  assert.ok(pad, "a .tile-body .wm-mount .pane rule");
  assert.match(pad[1]!, /box-sizing: border-box/);
  assert.match(pad[1]!, /padding: 0\.75rem/);
  const btn = /\.tile-body \.wm-mount \.pane button, \.tile-body \.wm-mount \.pane a\.btn \{([^}]*)\}/.exec(LAYOUT_CSS);
  assert.ok(btn, "a compact .tile-body .wm-mount .pane button rule");
  assert.match(btn[1]!, /padding: 0\.125rem 0\.5rem/);
  assert.match(btn[1]!, /font-size: 0\.8125rem/);
  assert.doesNotMatch(pad[1]! + btn[1]!, /color|background/, "colours stay with the theme tokens");
});

test("layoutCss: a browser pane fills its tile and its canvas takes the remaining height, with no colour", () => {
  const pane = /\.tile-body \.pane\.browser \{([^}]*)\}/.exec(LAYOUT_CSS);
  assert.ok(pane, "a .tile-body .pane.browser rule");
  assert.match(pane[1]!, /display: flex/);
  assert.match(pane[1]!, /flex-direction: column/);
  assert.match(pane[1]!, /height: 100%/);
  assert.match(pane[1]!, /min-height: 0/);
  const canvas = /\.tile-body \.pane\.browser canvas \{([^}]*)\}/.exec(LAYOUT_CSS);
  assert.ok(canvas, "a .tile-body .pane.browser canvas rule");
  assert.match(canvas[1]!, /flex: 1 1 auto/);
  assert.match(canvas[1]!, /min-height: 0/);
  assert.match(canvas[1]!, /width: 100%/);
  assert.match(canvas[1]!, /height: 100%/);
  assert.match(canvas[1]!, /object-fit: contain/, "the frame keeps its aspect ratio instead of stretching");
  assert.match(canvas[1]!, /display: block/);
  assert.doesNotMatch(pane[1]! + canvas[1]!, /color|background|border/, "geometry only");
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
  const s = boot({ hash: "#/terminal/" + encodeURIComponent(evil) });
  assert.equal(s.mounts[0]!.params.agent, evil);
  assert.equal(s.tiles()[0]!.byClass("tile-title")[0]!.textContent, "Terminal · " + evil);
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

test("a view focusing itself (xterm's hidden textarea after a socket opens) does not steal the tile focus; tabbing in and clicking do", () => {
  const s = boot();
  s.btn(s.tiles()[0]!, "Split right").click(); // t2 = second tile, focused
  const sel = s
    .tileOf("t2")
    .all()
    .find((n) => n.tagName === "select")!;
  sel.value = "terminal";
  sel.fire("change");
  s.tileOf("t1").fire("pointerdown"); // operator puts focus on t1
  assert.equal(s.tileOf("t1").className, "tile tile-focused");
  s.tileOf("t2").fire("focusin"); // programmatic focus inside the terminal tile, no operator input
  assert.equal(s.tileOf("t1").className, "tile tile-focused", "a view's own focus() leaves the recorded focus alone");
  assert.equal(s.tileOf("t2").className, "tile");
  const key = s.docListeners.get("keydown")![0]!;
  key.fn({ key: "Tab" }); // tabbing: keydown, then focusin on the next tile
  s.tileOf("t2").fire("focusin");
  assert.equal(s.tileOf("t2").className, "tile tile-focused", "keyboard focus moves the tile focus");
  s.tileOf("t1").fire("pointerdown");
  assert.equal(s.tileOf("t1").className, "tile tile-focused", "a click focuses the tile");
  s.docListeners.get("keyup")![0]!.fn({ key: "Tab" });
  s.tileOf("t2").fire("focusin");
  assert.equal(s.tileOf("t1").className, "tile tile-focused", "after the key is released, programmatic focus is ignored again");
});

test("window blur clears the held-key flag, so a keyup lost to Alt+Tab does not let a view steal the tile focus", () => {
  const s = boot();
  s.btn(s.tiles()[0]!, "Split right").click(); // t2 = second tile, focused
  s.tileOf("t1").fire("pointerdown"); // operator puts focus on t1
  s.docListeners.get("keydown")![0]!.fn({ key: "Alt" }); // Alt+Tab: keydown seen, keyup goes to the other window
  for (const fn of s.winListeners.get("blur") ?? []) fn({});
  s.tileOf("t2").fire("focusin"); // programmatic focus after the window regains focus
  assert.equal(s.tileOf("t1").className, "tile tile-focused", "blur released the held key");
  assert.equal(s.tileOf("t2").className, "tile");
});

test("api.state and api.views report the layout and the openable views as plain data", () => {
  const s = boot();
  assert.deepEqual(s.api.state(), { leaves: [{ id: "t1", view: "tree", params: {} }], focus: "t1", narrow: false, maxLeaves: 16 });
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

test("api.openView splits the focused tile with the view, focuses an already shown one, and names an unavailable view", () => {
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
  assert.match(s.noticeTexts().join("|"), /Cannot split further/);
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
  s.api.closeFocused(); // last tile cannot close
  assert.equal(s.tiles().length, 1);
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
  assert.deepEqual(barKinds(t), ["tile-title", "tile-menus", "tile-overflow", "tile-btn", "tile-btn", "tile-btn"]);
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
  assert.deepEqual(barKinds(t), ["tile-title", "tile-btn", "tile-btn", "tile-btn"]);
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
  const hash = "#/report/" + encodeURIComponent(agent) + "/" + encodeURIComponent(report);
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
    "#/terminal/" + "a".repeat(257),
    "#/report/a1/" + "r".repeat(257),
    "#/report/" + "a".repeat(257) + "/r1",
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

test("an item hash splits the focused tile to the right and leaves it as it was, instead of retargeting it", () => {
  const s = boot();
  s.hashchange("#/terminal/a1");
  assert.equal(subjectsOf(s), "tree:: terminal:a1:");
  assert.equal(s.api.state().focus, "t2");
  assert.deepEqual(s.log, ["+tree"], "the tree stayed active and mounted");
  s.hashchange("#/report/a1/r1");
  assert.equal(subjectsOf(s), "tree:: terminal:a1: report:a1:r1", "split the focused terminal tile, which stays");
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
  assert.match(s.noticeTexts().join("|"), /Cannot split further/);
  const r = boot({ store: { "pomtree.layout": full16("report") } });
  r.api.openView("report", "a", "last");
  assert.equal(r.api.state().leaves.length, 16);
  assert.match(r.noticeTexts().join("|"), /Cannot split further/);
  const third = r.api.state().leaves[2]!; // negative control: an open subject is still focused at the limit
  r.api.openView("report", "a", third.params.report);
  assert.equal(r.api.state().focus, third.id);
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
