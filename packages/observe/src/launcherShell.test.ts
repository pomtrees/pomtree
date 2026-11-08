import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { LAUNCHER_LOGIC_JS } from "./launcherModel.ts";
import { LAUNCHER_CSS, LAUNCHER_PATHS, LAUNCHER_POLL_MS, LAUNCHER_SHELL_JS } from "./launcherShell.ts";
import { inspect } from "node:util";
import { FakeDocument, Node_ } from "./launcherFakeDom.ts";

interface Leaf {
  id: string;
  view: string;
  params: { agent?: string };
}
type Reply = { status: number; body?: unknown } | Error;

const VIEWS = [
  { id: "terminal", title: "Terminal", multi: true, subject: "agent" },
  { id: "tree", title: "Tree", multi: false },
  { id: "inbox", title: "Inbox", multi: false },
  { id: "reports", title: "Reports", multi: false },
  { id: "report", title: "Report", multi: true, subject: "report" },
];
const REPORT_ROWS = [
  { agent: "alpha", report: { id: "r-9", agent: "a1", name: "notes", mediaType: "text/html" } },
  { agent: "bob", report: { id: "r-8", agent: "a2", name: "plan", mediaType: "text/html" } },
  { agent: "x", report: { id: "", agent: "a1" } },
];
const A1 = { id: "a1", name: "alpha", state: "running", exit: null };
const A2 = { id: "a2", name: "bob", state: "pending", exit: null };

interface Opts {
  noBar?: boolean;
  leaves?: Leaf[];
  views?: typeof VIEWS;
  narrow?: boolean;
  exportThrows?: boolean;
  importThrows?: boolean;
  noFocusDom?: boolean;
}

function boot(o: Opts = {}) {
  const doc = new FakeDocument();
  const bar = new Node_("header");
  if (!o.noBar) doc.byId.set("lb-bar", bar);
  const calls: string[] = [];
  const changeFns: (() => void)[] = [];
  const wm = {
    leaves: o.leaves ?? [
      { id: "l1", view: "terminal", params: { agent: "a1" } },
      { id: "l2", view: "tree", params: {} },
    ],
    focus: "l1",
    narrow: !!o.narrow,
    views: o.views ?? VIEWS,
  };
  const focusDoms: number[] = [];
  const api = {
    ...(o.noFocusDom ? {} : { focusDom: () => void focusDoms.push(1) }),
    state: () => ({ leaves: wm.leaves, focus: wm.focus, narrow: wm.narrow, maxLeaves: 16 }),
    views: () => wm.views,
    focus: (id: string) => void calls.push(`focus:${id}`),
    openView: (v: string, a?: string, r?: string) => void calls.push(`open:${v}:${a ?? ""}${r ? `:${r}` : ""}`),
    splitFocused: (d: string) => void calls.push(`split:${d}`),
    closeFocused: () => void calls.push("close"),
    exportLayout: () => {
      calls.push("export");
      if (o.exportThrows) throw new Error("storage denied");
    },
    importFile: (f: unknown) => {
      calls.push(`import:${(f as { name: string }).name}`);
      if (o.importThrows) throw new Error("not valid layout JSON");
    },
    resetLayout: () => void calls.push("reset"),
    onChange: (fn: () => void) => {
      changeFns.push(fn);
      return () => void changeFns.splice(changeFns.indexOf(fn), 1);
    },
  };
  const net = new Map<string, Reply>();
  const fetched: { url: string; method: string }[] = [];
  const reloads: number[] = [];
  const intervals: { fn: () => void; ms: number }[] = [];
  const fakeFetch = async (url: string, init?: { method?: string }) => {
    fetched.push({ url, method: init?.method ?? "GET" });
    const r = net.get(url) ?? { status: 200, body: [] };
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  const sandbox: Record<string, unknown> = {
    document: doc,
    fetch: fakeFetch,
    location: { reload: () => reloads.push(1) },
    setInterval: (fn: () => void, ms: number) => intervals.push({ fn, ms }),
    clearInterval: () => {},
    wm: { api },
    cfg: { paths: LAUNCHER_PATHS, pollMs: LAUNCHER_POLL_MS },
  };
  Object.defineProperty(sandbox, "globalThis", { get: () => ctx });
  const ctx = createContext(sandbox);
  runInContext(LAUNCHER_LOGIC_JS, ctx);
  runInContext(LAUNCHER_SHELL_JS, ctx);
  const mount = () => runInContext("createLauncherBar(wm, cfg)", ctx);
  return { doc, bar, wm, focusDoms, calls, changeFns, net, fetched, reloads, intervals, mount, ctx };
}

const settle = () => new Promise<void>((r) => setImmediate(r));

// Boots with a working daemon and lets the first poll finish.
async function up(o: Opts = {}) {
  const t = boot(o);
  t.net.set(LAUNCHER_PATHS.agents, { status: 200, body: [A1, A2] });
  t.mount();
  await settle();
  const q = (c: string) => t.bar.byClass(c)[0]!;
  const h = {
    ...t,
    start: q("lb-start"),
    launcher: q("lb-launcher"),
    input: q("lb-omni"),
    list: q("lb-list"),
    conn: q("lb-conn"),
    badge: q("lb-badge"),
    menuBtn: q("lb-menubtn"),
    menu: q("lb-menu"),
    notice: q("lb-notice"),
    winlist: q("lb-winlist"),
    fileInput: t.bar.byTag("input").find((n) => n.type === "file")!,
    async tick() {
      t.intervals[0]!.fn();
      await settle();
    },
    labels: () => q("lb-list").children.map((li) => li.children.filter((c) => !c.className.startsWith("lb-dot"))[0]!.textContent),
    type(text: string) {
      h.input.value = text;
      h.input.fire("input");
    },
    key(k: string) {
      return h.input.fire("keydown", { key: k });
    },
    connLabel: () => q("lb-conn").children[1]!.textContent,
    wins: () => q("lb-winlist").byClass("lb-win"),
  };
  return h;
}
type H = Awaited<ReturnType<typeof up>>;

const openStart = (h: H) => h.start.click();

test("launcher Node_ inspects as a short descriptor, not its parent/document/listener graph", () => {
  const doc = new FakeDocument();
  const parent = doc.createElement("div");
  doc.body.appendChild(parent);
  const el = doc.createElement("button");
  el.id = "b";
  parent.appendChild(el);
  doc.byId.set("b", el);
  el.listeners.set("click", [{ fn: () => doc, capture: false }]);
  doc.addEventListener("click", () => el);
  const out = inspect(el, { depth: null });
  assert.ok(out.length < 500, out);
  assert.ok(out.includes("button"), out);
});

test("a missing #lb-bar throws an error naming the element and the fix", () => {
  const t = boot({ noBar: true });
  assert.throws(() => t.mount(), /#lb-bar.*missing.*emit/);
});

test("boot: polls the three paths once, then every pollMs", async () => {
  const h = await up();
  assert.deepEqual(h.fetched.map((f) => f.url).sort(), [LAUNCHER_PATHS.agents, LAUNCHER_PATHS.approvals, LAUNCHER_PATHS.escalations].sort());
  assert.equal(h.intervals.length, 1);
  assert.equal(h.intervals[0]!.ms, LAUNCHER_POLL_MS);
  await h.tick();
  assert.equal(h.fetched.length, 6);
});

test("polling is skipped while the page is hidden", async () => {
  const h = await up();
  h.doc.hidden = true;
  await h.tick();
  assert.equal(h.fetched.length, 3);
  h.doc.hidden = false;
  await h.tick();
  assert.equal(h.fetched.length, 6);
});

test("Start opens the launcher, focuses the omnibar and wires the ARIA attributes", async () => {
  const h = await up();
  assert.equal(h.launcher.hidden, true);
  assert.equal(h.start.getAttribute("aria-haspopup"), "dialog");
  assert.equal(h.start.getAttribute("aria-expanded"), "false");
  openStart(h);
  assert.equal(h.launcher.hidden, false);
  assert.equal(h.start.getAttribute("aria-expanded"), "true");
  assert.equal(h.start.getAttribute("aria-controls"), h.launcher.id);
  assert.ok(h.input.focused > 0);
  assert.equal(h.input.getAttribute("aria-label"), "Omnibar");
  assert.equal(h.input.getAttribute("role"), "combobox");
  assert.equal(h.input.getAttribute("aria-controls"), h.list.id);
  assert.equal(h.list.getAttribute("role"), "listbox");
  const first = h.list.children[0]!;
  assert.equal(first.getAttribute("role"), "option");
  assert.equal(h.input.getAttribute("aria-activedescendant"), first.id);
  assert.equal(first.getAttribute("aria-selected"), "true");
  assert.deepEqual(h.labels().slice(0, 5), ["Terminal: alpha", "Tree", "Open terminal for bob", "Inbox", "Reports"]);
  openStart(h);
  assert.equal(h.launcher.hidden, true);
  assert.equal(h.start.getAttribute("aria-expanded"), "false");
});

test("Alt+Shift+P opens the launcher even while a terminal-like element has focus; a plain key does not", async () => {
  const h = await up();
  const term = new Node_("div");
  let termKeys = 0;
  term.addEventListener("keydown", () => termKeys++);
  const ev = h.doc.dispatch(term, "keydown", { altKey: true, shiftKey: true, code: "KeyP", key: "P" });
  assert.equal(h.launcher.hidden, false);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(ev.propagationStopped, true);
  assert.equal(termKeys, 0, "the capture listener hides the key from the terminal");
  assert.ok(h.input.focused > 0);
  assert.ok(
    h.doc.listeners.get("keydown")!.some((l) => l.capture),
    "registered in the capture phase",
  );
  // negative: Alt+P without Shift
  const h2 = await up();
  const term2 = new Node_("div");
  let keys2 = 0;
  term2.addEventListener("keydown", () => keys2++);
  const ev2 = h2.doc.dispatch(term2, "keydown", { altKey: true, code: "KeyP", key: "p" });
  assert.equal(h2.launcher.hidden, true);
  assert.equal(ev2.defaultPrevented, false);
  assert.equal(keys2, 1);
});

test("typing filters the list through the model; no match shows a message and no activedescendant", async () => {
  const h = await up();
  openStart(h);
  h.type("split");
  assert.deepEqual(h.labels(), ["Split right", "Split down"]);
  h.type("zzzz");
  assert.equal(h.list.children.length, 0);
  assert.equal(h.list.hidden, true);
  const empty = h.launcher.byClass("lb-empty")[0]!;
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /Nothing matches.*zzzz/);
  assert.equal(h.input.getAttribute("aria-activedescendant"), null);
});

test("arrows, Home, End and Enter move the selection and focus a window", async () => {
  const h = await up();
  openStart(h);
  const down = h.key("ArrowDown");
  assert.equal(down.defaultPrevented, true);
  assert.equal(h.list.children[1]!.getAttribute("aria-selected"), "true");
  assert.equal(h.input.getAttribute("aria-activedescendant"), h.list.children[1]!.id);
  h.key("End");
  assert.equal(h.list.children.at(-1)!.getAttribute("aria-selected"), "true");
  h.key("Home");
  h.key("ArrowUp");
  assert.equal(h.list.children.at(-1)!.getAttribute("aria-selected"), "true", "ArrowUp wraps");
  h.key("Home");
  h.key("ArrowDown");
  h.key("Enter");
  assert.deepEqual(h.calls, ["focus:l2"]);
  assert.equal(h.launcher.hidden, true, "running an item closes the launcher");
});

test("Enter on a view type opens it; on an agent entry opens the view for that agent", async () => {
  const h = await up();
  openStart(h);
  h.type("reports");
  h.key("Enter");
  openStart(h);
  h.type("bob");
  h.key("Enter");
  assert.deepEqual(h.calls, ["open:reports:", "open:terminal:a2"]);
});

test("every action runs through the omnibar", async () => {
  const cases: [string, string][] = [
    ["Split right", "split:row"],
    ["Split down", "split:col"],
    ["Close tile", "close"],
    ["Reset layout", "reset"],
    ["Export layout", "export"],
  ];
  for (const [label, call] of cases) {
    const h = await up();
    openStart(h);
    h.type(label);
    h.key("Enter");
    assert.deepEqual(h.calls, [call], label);
  }
  const imp = await up();
  openStart(imp);
  imp.type("Import layout");
  imp.key("Enter");
  assert.equal(imp.fileInput.clicks, 1);
  const out = await up();
  openStart(out);
  out.type("Sign out");
  out.key("Enter");
  assert.deepEqual(out.fetched.at(-1), { url: LAUNCHER_PATHS.logout, method: "POST" });
});

test("a click or hover on a list item goes through the model", async () => {
  const h = await up();
  openStart(h);
  h.list.children[1]!.fire("mouseenter");
  assert.equal(h.list.children[1]!.getAttribute("aria-selected"), "true");
  h.list.children[1]!.click();
  assert.deepEqual(h.calls, ["focus:l2"]);
  assert.equal(h.launcher.hidden, true);
});

test("Escape closes and refocuses Start; clicking outside closes without moving focus", async () => {
  const h = await up();
  openStart(h);
  const before = h.start.focused;
  const esc = h.key("Escape");
  assert.equal(esc.defaultPrevented, true);
  assert.equal(h.launcher.hidden, true);
  assert.equal(h.start.focused, before + 1);
  openStart(h);
  const elsewhere = new Node_("div");
  h.doc.dispatch(elsewhere, "pointerdown");
  assert.equal(h.launcher.hidden, true);
  assert.equal(h.start.focused, before + 1, "no focus steal");
  // negative: a press inside the launcher keeps it open
  openStart(h);
  h.doc.dispatch(h.input, "pointerdown");
  assert.equal(h.launcher.hidden, false);
});

test("the window list is rebuilt on layout change and clicking an entry focuses its tile", async () => {
  const h = await up();
  assert.deepEqual(
    h.wins().map((b) => b.textContent),
    ["Terminal: alpha", "Tree"],
  );
  assert.equal(h.winlist.getAttribute("aria-label"), "Open windows");
  assert.equal(h.winlist.tagName, "nav");
  const [w1, w2] = h.wins();
  assert.equal(w1!.getAttribute("aria-pressed"), "true");
  assert.ok(w1!.className.split(" ").includes("on"));
  assert.ok(w1!.scrolled > 0, "focused entry is scrolled into view");
  assert.match(w1!.getAttribute("title")!, /Terminal: alpha.*running/);
  const dot = w1!.byClass("lb-dot")[0]!;
  assert.equal(dot.getAttribute("aria-hidden"), "true");
  assert.ok(dot.className.split(" ").includes("ok"));
  w2!.click();
  assert.deepEqual(h.calls, ["focus:l2"]);
  h.wm.leaves = [...h.wm.leaves, { id: "l3", view: "reports", params: {} }];
  h.wm.focus = "l3";
  for (const f of h.changeFns) f();
  assert.equal(h.wins().length, 3);
  assert.equal(h.wins()[2]!.getAttribute("aria-pressed"), "true");
  assert.equal(h.wins()[0]!.getAttribute("aria-pressed"), "false");
});

test("an unchanged window list keeps its buttons across polls (focus is not lost)", async () => {
  const h = await up();
  const before = h.wins()[0]!;
  await h.tick();
  assert.equal(h.wins()[0], before);
});

test("more than the compact threshold marks the list compact", async () => {
  const leaves = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, view: "tree", params: {} }));
  const h = await up({ leaves });
  assert.ok(h.winlist.className.split(" ").includes("compact"));
  const few = await up();
  assert.ok(!few.winlist.className.split(" ").includes("compact"));
});

test("agent names are shown as text, never markup", async () => {
  const t = boot();
  t.net.set(LAUNCHER_PATHS.agents, { status: 200, body: [{ id: "a1", name: "<img src=x onerror=1>", state: "running", exit: null }] });
  t.mount();
  await settle();
  assert.equal(t.bar.byClass("lb-win")[0]!.textContent, "Terminal: <img src=x onerror=1>");
});

test("the connection pill goes connecting, connected, reconnecting, offline, connected with the cause in the title", async () => {
  const t = boot();
  t.net.set(LAUNCHER_PATHS.agents, { status: 200, body: [A1] });
  t.mount();
  const conn = t.bar.byClass("lb-conn")[0]!;
  const label = () => conn.children[1]!.textContent;
  assert.equal(label(), "connecting");
  assert.equal(conn.getAttribute("role"), "status");
  await settle();
  assert.equal(label(), "connected");
  assert.ok(conn.children[0]!.className.split(" ").includes("ok"));
  const tick = async () => {
    t.intervals[0]!.fn();
    await settle();
  };
  t.net.set(LAUNCHER_PATHS.agents, { status: 503 });
  await tick();
  assert.equal(label(), "reconnecting");
  assert.match(conn.getAttribute("title")!, new RegExp(`${LAUNCHER_PATHS.agents}.*503`));
  await tick();
  assert.equal(label(), "reconnecting");
  t.net.set(LAUNCHER_PATHS.agents, new Error("connection refused"));
  await tick();
  assert.equal(label(), "offline");
  assert.match(conn.getAttribute("title")!, /connection refused/);
  assert.match(conn.getAttribute("title")!, /retr/);
  assert.ok(conn.children[0]!.className.split(" ").includes("err"));
  t.net.set(LAUNCHER_PATHS.agents, { status: 200, body: [A1] });
  await tick();
  assert.equal(label(), "connected");
});

test("an unreadable JSON body is a failed poll naming the URL", async () => {
  const t = boot();
  t.net.set(LAUNCHER_PATHS.agents, { status: 200, body: [A1] });
  t.mount();
  await settle();
  const realFetch = (t.ctx as { fetch: unknown }).fetch as (u: string) => Promise<unknown>;
  (t.ctx as { fetch: unknown }).fetch = async (u: string) =>
    u === LAUNCHER_PATHS.agents ? { ok: true, status: 200, json: async () => Promise.reject(new Error("bad json")) } : realFetch(u);
  t.intervals[0]!.fn();
  await settle();
  const conn = t.bar.byClass("lb-conn")[0]!;
  assert.match(conn.getAttribute("title")!, /\/v1\/agents.*bad json/);
});

test("the Inbox badge shows 3, 99+, ? and hides at zero", async () => {
  const h = await up();
  const count = () => h.badge.children[1]!;
  assert.equal(count().hidden, true, "zero is hidden");
  assert.equal(h.badge.children[0]!.textContent, "Inbox");
  h.net.set(LAUNCHER_PATHS.approvals, { status: 200, body: [1, 2] });
  h.net.set(LAUNCHER_PATHS.escalations, { status: 200, body: [1] });
  await h.tick();
  assert.equal(count().textContent, "3");
  assert.equal(count().hidden, false);
  assert.match(h.badge.getAttribute("aria-label")!, /3 waiting/);
  h.net.set(LAUNCHER_PATHS.approvals, { status: 200, body: Array.from({ length: 120 }, (_, i) => i) });
  await h.tick();
  assert.equal(count().textContent, "99+");
  const u = boot();
  u.net.set(LAUNCHER_PATHS.approvals, { status: 500 });
  u.net.set(LAUNCHER_PATHS.escalations, { status: 500 });
  u.mount();
  await settle();
  assert.equal(u.bar.byClass("lb-badge")[0]!.children[1]!.textContent, "?");
});

test("a failed poll keeps the last good agents and counts", async () => {
  const h = await up();
  h.net.set(LAUNCHER_PATHS.approvals, { status: 200, body: [1, 2, 3] });
  await h.tick();
  assert.equal(h.badge.children[1]!.textContent, "3");
  h.net.set(LAUNCHER_PATHS.agents, { status: 500 });
  h.net.set(LAUNCHER_PATHS.approvals, new Error("boom"));
  await h.tick();
  assert.equal(h.badge.children[1]!.textContent, "3");
  assert.equal(h.wins()[0]!.textContent, "Terminal: alpha");
  assert.notEqual(h.connLabel(), "connected");
});

test("the Inbox badge opens the inbox view; without that view it does nothing", async () => {
  const h = await up();
  h.badge.click();
  assert.deepEqual(h.calls, ["open:inbox:"]);
  const g = await up({ views: VIEWS.filter((v) => v.id !== "inbox") });
  g.badge.click();
  assert.deepEqual(g.calls, []);
});

test("the bar menu lists the fixed entries with menu roles and runs the right api call", async () => {
  const cases: [string, string][] = [
    ["Export layout", "export"],
    ["Reset layout", "reset"],
  ];
  for (const [label, call] of cases) {
    const h = await up();
    assert.equal(h.menuBtn.getAttribute("aria-haspopup"), "menu");
    assert.equal(h.menuBtn.getAttribute("aria-expanded"), "false");
    assert.equal(h.menu.hidden, true);
    h.menuBtn.click();
    assert.equal(h.menuBtn.getAttribute("aria-expanded"), "true");
    assert.equal(h.menu.getAttribute("role"), "menu");
    const items = h.menu.byClass("lb-menu-item");
    assert.deepEqual(
      items.map((i) => i.textContent),
      ["Export layout", "Import layout", "Reset layout", "Sign out"],
    );
    assert.ok(items.every((i) => i.getAttribute("role") === "menuitem"));
    assert.ok(items[0]!.focused > 0, "first item takes focus");
    assert.ok(h.menu.byClass("lb-menu-head").length > 0 && h.menu.byClass("lb-sep").length > 0);
    items.find((i) => i.textContent === label)!.click();
    assert.deepEqual(h.calls, [call]);
    assert.equal(h.menu.hidden, true);
  }
});

test("menu keyboard: ArrowDown opens from the closed button, arrows move, Enter runs, Escape refocuses the button", async () => {
  const h = await up();
  const closedKey = h.menuBtn.fire("keydown", { key: "ArrowDown" });
  assert.equal(closedKey.defaultPrevented, true);
  assert.equal(h.menu.hidden, false);
  const items = () => h.menu.byClass("lb-menu-item");
  const f = items()[1]!.focused;
  h.menu.fire("keydown", { key: "ArrowDown" });
  assert.equal(items()[1]!.focused, f + 1);
  h.menu.fire("keydown", { key: "Enter" });
  assert.deepEqual(h.calls, []);
  assert.equal(h.fileInput.clicks, 1);
  h.menuBtn.fire("keydown", { key: "ArrowDown" });
  const before = h.menuBtn.focused;
  h.menu.fire("keydown", { key: "Escape" });
  assert.equal(h.menu.hidden, true);
  assert.equal(h.menuBtn.focused, before + 1);
  // negative: another key on the closed button does not open it
  h.menuBtn.fire("keydown", { key: "x" });
  assert.equal(h.menu.hidden, true);
});

test("opening one panel closes the other; a click outside closes the menu", async () => {
  const h = await up();
  openStart(h);
  h.menuBtn.click();
  assert.equal(h.launcher.hidden, true);
  assert.equal(h.menu.hidden, false);
  openStart(h);
  assert.equal(h.menu.hidden, true);
  assert.equal(h.launcher.hidden, false);
  h.menuBtn.click();
  h.doc.dispatch(new Node_("div"), "pointerdown");
  assert.equal(h.menu.hidden, true);
});

test("import: the hidden file input feeds importFile and is cleared; no file means no call", async () => {
  const h = await up();
  assert.equal(h.fileInput.hidden, true);
  assert.equal(h.fileInput.getAttribute("accept"), "application/json,.json");
  h.menuBtn.click();
  h.menu.byClass("lb-menu-item")[1]!.click();
  assert.equal(h.fileInput.clicks, 1);
  h.fileInput.value = "C:/x.json";
  h.fileInput.files = [{ name: "layout.json" }];
  h.fileInput.fire("change");
  assert.deepEqual(h.calls, ["import:layout.json"]);
  assert.equal(h.fileInput.value, "");
  h.fileInput.files = [];
  h.fileInput.fire("change");
  assert.deepEqual(h.calls, ["import:layout.json"]);
});

test("a failing import shows a notice with the cause and the action", async () => {
  const h = await up({ importThrows: true });
  h.fileInput.files = [{ name: "bad.json" }];
  h.fileInput.fire("change");
  assert.equal(h.notice.hidden, false);
  assert.match(h.notice.textContent, /Import layout failed: not valid layout JSON\..*try again/);
});

test("a failing export shows a notice, which the next action clears", async () => {
  const h = await up({ exportThrows: true });
  h.menuBtn.click();
  h.menu.byClass("lb-menu-item")[0]!.click();
  assert.equal(h.notice.hidden, false);
  assert.match(h.notice.textContent, /Export layout failed: storage denied\..*(Reload|try again)/);
  assert.equal(h.notice.getAttribute("role"), "alert");
  openStart(h);
  h.type("reset");
  h.key("Enter");
  assert.equal(h.notice.hidden, true);
});

test("sign out POSTs the logout path and reloads the page afterwards", async () => {
  const h = await up();
  h.menuBtn.click();
  h.menu.byClass("lb-menu-item")[3]!.click();
  assert.deepEqual(h.fetched.at(-1), { url: LAUNCHER_PATHS.logout, method: "POST" });
  assert.equal(h.reloads.length, 0, "not before the request finishes");
  await settle();
  assert.equal(h.reloads.length, 1);
  assert.equal(h.notice.hidden, true);
});

test("a failed sign out shows a notice with the cause and does not reload", async () => {
  const h = await up();
  h.net.set(LAUNCHER_PATHS.logout, { status: 500 });
  h.menuBtn.click();
  h.menu.byClass("lb-menu-item")[3]!.click();
  await settle();
  assert.equal(h.reloads.length, 0);
  assert.match(h.notice.textContent, /Sign out failed: \/ui\/logout returned HTTP 500\..*again/);
  const g = await up();
  g.net.set(LAUNCHER_PATHS.logout, new Error("network down"));
  g.menuBtn.click();
  g.menu.byClass("lb-menu-item")[3]!.click();
  await settle();
  assert.equal(g.reloads.length, 0);
  assert.match(g.notice.textContent, /network down/);
});

test("the shell source never uses innerHTML-style APIs and is template-literal safe", () => {
  assert.doesNotMatch(LAUNCHER_SHELL_JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.ok(!LAUNCHER_SHELL_JS.includes("`"));
  assert.ok(!LAUNCHER_SHELL_JS.includes("${"));
  assert.ok(!LAUNCHER_SHELL_JS.includes("\\"));
  assert.ok(!LAUNCHER_CSS.includes("\\"));
  const n = new Node_("div");
  assert.throws(() => (n.innerHTML = "<b>x</b>"), /innerHTML is forbidden/);
  assert.throws(() => n.insertAdjacentHTML(), /forbidden/);
  assert.throws(() => n.outerHTML, /forbidden/);
});

test("LAUNCHER_CSS: colours come only from tokens, narrow and forced-colors blocks exist", () => {
  assert.doesNotMatch(LAUNCHER_CSS, /#[0-9a-fA-F]{3,8}\b/, "no hex colours");
  assert.doesNotMatch(LAUNCHER_CSS, /\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/, "no colour functions with literals");
  assert.match(LAUNCHER_CSS, /var\(--chrome-accent,/);
  assert.match(LAUNCHER_CSS, /var\(--chrome-accent-fg,/);
  assert.match(LAUNCHER_CSS, /@media \(max-width: 640px\)/);
  assert.match(LAUNCHER_CSS, /@media \(forced-colors: active\)/);
  assert.match(LAUNCHER_CSS, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(LAUNCHER_CSS, /@media \(pointer: coarse\)[^}]*min-height: 2\.5rem/);
  const from = LAUNCHER_CSS.indexOf("@media (max-width: 640px)");
  const narrow = LAUNCHER_CSS.slice(from, LAUNCHER_CSS.indexOf("@media (pointer: coarse)"));
  assert.doesNotMatch(narrow, /display: none/, "the status text stays available to screen readers");
  assert.match(narrow, /\.lb-conn-label \{[^}]*clip-path: inset\(50%\)/);
  assert.match(narrow, /\.lb-launcher \{ left: 0; right: 0/);
  for (const c of [
    "lb",
    "lb-start",
    "lb-winlist",
    "lb-win",
    "lb-dot",
    "lb-right",
    "lb-conn",
    "lb-badge",
    "lb-menubtn",
    "lb-drop",
    "lb-launcher",
    "lb-omni",
    "lb-list",
    "lb-item",
    "lb-kind",
    "lb-empty",
    "lb-menu-item",
    "lb-menu-head",
    "lb-sep",
    "lb-notice",
  ]) {
    assert.match(LAUNCHER_CSS, new RegExp(`\\.${c}[ ,.{:\\[]`), c);
  }
});

test("after choosing a window or view, focus goes through focusDom; without focusDom nothing throws", async () => {
  const h = await up();
  openStart(h);
  h.key("ArrowDown");
  h.key("Enter");
  assert.equal(h.focusDoms.length, 1);
  openStart(h);
  h.type("reports");
  h.key("Enter");
  assert.equal(h.focusDoms.length, 2);
  const g = await up({ noFocusDom: true });
  openStart(g);
  g.key("ArrowDown");
  g.key("Enter");
  assert.deepEqual(g.calls, ["focus:l2"]);
});

test("after an omnibar action focus returns to Start, except import and sign out", async () => {
  const h = await up();
  openStart(h);
  const before = h.start.focused;
  h.type("Reset layout");
  h.key("Enter");
  assert.equal(h.start.focused, before + 1);
  assert.equal(h.focusDoms.length, 0);
  openStart(h);
  const b2 = h.start.focused;
  h.type("Import layout");
  h.key("Enter");
  assert.equal(h.start.focused, b2, "the file dialog keeps focus");
  openStart(h);
  h.type("Sign out");
  h.key("Enter");
  assert.equal(h.start.focused, b2);
});

test("after a menu action focus returns to the menu button, except import and sign out", async () => {
  const h = await up();
  h.menuBtn.click();
  const before = h.menuBtn.focused;
  h.menu.byClass("lb-menu-item")[2]!.click();
  assert.equal(h.menuBtn.focused, before + 1);
  h.menuBtn.click();
  const b2 = h.menuBtn.focused;
  h.menu.byClass("lb-menu-item")[1]!.click();
  h.menuBtn.click();
  h.menu.byClass("lb-menu-item")[3]!.click();
  assert.equal(h.menuBtn.focused, b2);
});

test("a hover on the selected item and a poll with the same data keep the list nodes", async () => {
  const h = await up();
  openStart(h);
  const lis = [...h.list.children];
  h.list.children[0]!.fire("mouseenter");
  assert.deepEqual(h.list.children, lis);
  await h.tick();
  assert.deepEqual(h.list.children, lis);
  assert.ok(h.list.children.every((li, i) => li === lis[i]));
  // selection change updates in place
  h.list.children[2]!.fire("mouseenter");
  assert.ok(h.list.children.every((li, i) => li === lis[i]));
  assert.equal(lis[2]!.getAttribute("aria-selected"), "true");
  assert.equal(lis[0]!.getAttribute("aria-selected"), "false");
  assert.ok(lis[2]!.className.split(" ").includes("sel"));
  assert.ok(!lis[0]!.className.split(" ").includes("sel"));
  // negative: changed data rebuilds the list
  h.net.set(LAUNCHER_PATHS.agents, { status: 200, body: [A1] });
  await h.tick();
  assert.ok(h.list.children[0] !== lis[0]);
});

test("a hover on the selected menu item keeps the menu nodes", async () => {
  const h = await up();
  h.menuBtn.click();
  const items = h.menu.byClass("lb-menu-item");
  items[0]!.fire("mouseenter");
  assert.ok(h.menu.byClass("lb-menu-item").every((n, i) => n === items[i]));
  items[2]!.fire("mouseenter");
  assert.ok(h.menu.byClass("lb-menu-item").every((n, i) => n === items[i]));
  assert.equal(items[2]!.getAttribute("tabindex"), "0");
  assert.equal(items[0]!.getAttribute("tabindex"), "-1");
});

test("focus leaving the launcher closes it; a press on a non-focusable part of it does not", async () => {
  const h = await up();
  openStart(h);
  h.bar.fire("focusout", { relatedTarget: h.input });
  assert.equal(h.launcher.hidden, false, "focus stays inside");
  h.bar.fire("focusout", { relatedTarget: new Node_("div") });
  assert.equal(h.launcher.hidden, true);
  openStart(h);
  h.doc.dispatch(h.list.children[0]!, "pointerdown");
  h.bar.fire("focusout", { relatedTarget: null });
  assert.equal(h.launcher.hidden, false, "null relatedTarget after a press inside is not a leave");
  h.key("Tab");
  h.doc.dispatch(h.input, "keydown", { key: "Tab" });
  h.bar.fire("focusout", { relatedTarget: null });
  assert.equal(h.launcher.hidden, true, "null relatedTarget with no inside press is a leave");
});

test("focus leaving the menu closes it", async () => {
  const h = await up();
  h.menuBtn.click();
  h.bar.fire("focusout", { relatedTarget: h.menu.byClass("lb-menu-item")[1] });
  assert.equal(h.menu.hidden, false);
  h.bar.fire("focusout", { relatedTarget: new Node_("div") });
  assert.equal(h.menu.hidden, true);
});

test("a 401 or 403 poll is described as an expired session, other errors keep naming the status", async () => {
  for (const status of [401, 403]) {
    const t = boot();
    t.net.set(LAUNCHER_PATHS.agents, { status });
    t.mount();
    await settle();
    const title = t.bar.byClass("lb-conn")[0]!.getAttribute("title")!;
    assert.match(title, new RegExp(`/v1/agents returned HTTP ${status}.*session probably expired.*reload`));
    assert.doesNotMatch(title, /daemon is running/);
  }
  const t = boot();
  t.net.set(LAUNCHER_PATHS.agents, { status: 500 });
  t.mount();
  await settle();
  assert.doesNotMatch(t.bar.byClass("lb-conn")[0]!.getAttribute("title")!, /session/);
});

test("press outside closes the launcher in the capture phase, even when the target stops propagation", async () => {
  const h = await up();
  openStart(h);
  const stopper = new Node_("div");
  stopper.addEventListener("pointerdown", (ev) => ev.stopPropagation?.());
  h.doc.dispatch(stopper, "pointerdown");
  assert.equal(h.launcher.hidden, true);
});

const reportFetches = (h: { fetched: { url: string }[] }) => h.fetched.filter((f) => f.url === LAUNCHER_PATHS.reports).length;

test("reports are fetched when the panel opens, once per open, never by the poll", async () => {
  const h = await up();
  h.net.set(LAUNCHER_PATHS.reports, { status: 200, body: REPORT_ROWS });
  assert.equal(reportFetches(h), 0, "not at mount");
  await h.tick();
  assert.equal(reportFetches(h), 0, "not from the poll");
  openStart(h);
  assert.equal(reportFetches(h), 1);
  await settle();
  assert.ok(h.labels().includes("Open report notes (alpha)"));
  assert.ok(h.labels().includes("Open report plan (bob)"));
  assert.equal(h.labels().filter((l) => l.startsWith("Open report")).length, 2, "the malformed row is ignored");
  await h.tick();
  h.type("note");
  h.key("ArrowDown");
  assert.equal(reportFetches(h), 1, "typing, keys and the poll while open do not refetch");
  openStart(h);
  assert.equal(h.launcher.hidden, true);
  assert.equal(reportFetches(h), 1, "closing does not fetch");
  openStart(h);
  assert.equal(reportFetches(h), 2, "each open reads once");
});

test("choosing a report entry opens the view with the agent and the report id", async () => {
  const h = await up();
  h.net.set(LAUNCHER_PATHS.reports, { status: 200, body: REPORT_ROWS });
  openStart(h);
  await settle();
  h.type("r-8");
  h.key("Enter");
  assert.deepEqual(h.calls, ["open:report:a2:r-8"]);
});

test("a failed report fetch shows no report entries, no banner, and leaves agent entries usable", async () => {
  for (const reply of [{ status: 500 }, new Error("refused")] as Reply[]) {
    const h = await up();
    h.net.set(LAUNCHER_PATHS.reports, reply);
    openStart(h);
    await settle();
    assert.equal(h.notice.hidden, true);
    assert.equal(
      h.labels().some((l) => l.startsWith("Open report")),
      false,
    );
    assert.ok(h.labels().includes("Open terminal for bob"));
    h.type("bob");
    h.key("Enter");
    assert.deepEqual(h.calls, ["open:terminal:a2"]);
  }
});

test("report entries recover on the next open after a failed fetch", async () => {
  const h = await up();
  h.net.set(LAUNCHER_PATHS.reports, { status: 500 });
  openStart(h);
  await settle();
  assert.equal(
    h.labels().some((l) => l.startsWith("Open report")),
    false,
  );
  openStart(h);
  h.net.set(LAUNCHER_PATHS.reports, { status: 200, body: REPORT_ROWS });
  openStart(h);
  await settle();
  assert.ok(h.labels().includes("Open report notes (alpha)"), "recovered on the next open");
});
