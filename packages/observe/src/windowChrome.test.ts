import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { createContext, runInContext } from "node:vm";
import { MENU_KIT_JS, type MenuKitApi, type ViewDeclaration, type WindowModel } from "./menuModel.ts";
import { MENU_NAV_JS } from "./menuNav.ts";
import { BROWSER_DECLARATION, INBOX_DECLARATION, TERMINAL_DECLARATION } from "./viewMenus.ts";
import { type Chrome, type ChromeKitApi, WINDOW_CHROME_JS } from "./windowChrome.ts";

// TODO(ui-fake-dom-duplication): layoutShell.test.ts and this file each define a fake DOM (Node_ and helpers) that duplicates Node_ and FakeDocument in launcherFakeDom.ts; the three differ in parentNode, style, rect and the document back-reference. All work. Trigger: the next change to any of the fakes, or another shell test needing one.
const kit = runInContext(
  `(() => { ${MENU_KIT_JS}; ${MENU_NAV_JS}; ${WINDOW_CHROME_JS}; return { MenuKit, ChromeKit }; })()`,
  createContext({ globalThis: {}, JSON, Object, Array, Set, Map, String, Error, WeakSet, Number, Date, console }),
) as { MenuKit: MenuKitApi; ChromeKit: ChromeKitApi };

// ---- A small fake DOM: elements, attributes, bubbling events, focus, document listeners. ----
interface Ev {
  type: string;
  key?: string;
  detail?: number;
  target?: FakeEl;
  defaultPrevented?: boolean;
  preventDefault?: () => void;
}
type Listener = (ev: Ev) => void;
type Els = [FakeEl, FakeEl, FakeEl, FakeEl, ...FakeEl[]];
class FakeEl {
  tagName: string;
  className = "";
  hidden = false;
  parentNode: FakeEl | null = null;
  children: Els = [] as unknown as Els;
  text = "";
  attrs = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  doc: FakeDoc | null;
  constructor(tag: string, doc: FakeDoc | null) {
    this.tagName = tag;
    this.doc = doc;
  }
  // Short descriptor so a failing assertion never inspects the parent/doc/listener graph (it once exhausted memory).
  [inspect.custom](): string {
    return `<FakeEl ${this.tagName} id=${this.attrs.get("id") ?? ""} class="${this.className}" children=${this.children.length}>`.slice(0, 119);
  }
  get textContent(): string {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this.text;
  }
  set textContent(v: string) {
    for (const c of this.children) c.parentNode = null;
    this.children = [] as unknown as Els;
    this.text = String(v);
  }
  appendChild(c: FakeEl) {
    c.remove();
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  replaceChildren(...cs: FakeEl[]) {
    this.textContent = "";
    for (const c of cs) this.appendChild(c);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this) as Els;
    this.parentNode = null;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(t: string, l: Listener) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), l]);
  }
  removeEventListener(t: string, l: Listener) {
    this.listeners.set(
      t,
      (this.listeners.get(t) ?? []).filter((x) => x !== l),
    );
  }
  listenerCount(t: string) {
    return (this.listeners.get(t) ?? []).length;
  }
  focus() {
    if (this.doc) this.doc.activeElement = this;
    this.fire({ type: "focus" }, false);
  }
  private fire(ev: Ev, bubble: boolean) {
    ev.target ??= this;
    for (let n: FakeEl | null = this; n; n = bubble ? n.parentNode : null) for (const l of [...(n.listeners.get(ev.type) ?? [])]) l(ev);
  }
  // The path is fixed at dispatch time, like a browser, so a handler that re-renders does not cut the event short.
  dispatch(ev: Ev, bubble = true): Ev {
    ev.defaultPrevented = false;
    ev.preventDefault = () => {
      ev.defaultPrevented = true;
    };
    ev.target = this;
    const path: FakeEl[] = [];
    for (let n: FakeEl | null = this; n; n = bubble ? n.parentNode : null) path.push(n);
    for (const n of path) for (const l of [...(n.listeners.get(ev.type) ?? [])]) l(ev);
    return ev;
  }
  all(): FakeEl[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  byClass(cls: string): Els {
    return this.all().filter((e) => e.className.split(" ").includes(cls)) as Els;
  }
  get role() {
    return this.getAttribute("role");
  }
}
class FakeDoc extends FakeEl {
  activeElement: FakeEl | null = null;
  body: FakeEl;
  constructor() {
    super("#document", null);
    this.doc = this;
    this.body = this.createElement("body");
    this.appendChild(this.body);
  }
  createElement(tag: string) {
    return new FakeEl(tag, this);
  }
}

test("FakeEl inspects as a short descriptor, not its parent/document/listener graph", () => {
  const doc = new FakeDoc();
  const parent = doc.createElement("div");
  doc.body.appendChild(parent);
  const el = doc.createElement("button");
  el.className = "x";
  parent.appendChild(el);
  el.addEventListener("click", () => {});
  const out = inspect(el, { depth: null });
  assert.ok(out.length < 500, out);
  assert.ok(out.includes("button"), out);
});

function setup(decl: ViewDeclaration, opts: { now?: () => number } = {}) {
  const model = kit.MenuKit.createWindowModel(kit.MenuKit.declareView(decl)) as WindowModel;
  const calls: Array<[string, unknown]> = [];
  model.onCommand((c, a) => {
    calls.push([c, a]);
  });
  const doc = new FakeDoc();
  const chrome = kit.ChromeKit.createChrome(model, { document: doc as unknown as Document, ...opts }) as unknown as Chrome;
  const menus = chrome.menus as unknown as FakeEl;
  const overflow = chrome.overflow as unknown as FakeEl;
  const footer = chrome.footer as unknown as FakeEl;
  doc.body.appendChild(menus);
  doc.body.appendChild(overflow);
  doc.body.appendChild(footer);
  const outside = doc.createElement("div");
  doc.body.appendChild(outside);
  const btn = (title: string) => menus.byClass("tile-btn").find((b) => b.textContent === title) as FakeEl;
  const panelOf = (b: FakeEl) => b.parentNode?.children[1] as FakeEl;
  const items = (panel: FakeEl) => panel.children.filter((c) => (c.role ?? "").startsWith("menuitem")) as Els;
  const labelOf = (it: FakeEl) => it.children[0].textContent;
  const key = (el: FakeEl, k: string) => el.dispatch({ type: "keydown", key: k });
  const click = (el: FakeEl) => el.dispatch({ type: "click", detail: 1 });
  const ovBtn = () => overflow.byClass("tile-btn")[0];
  return { model, calls, doc, chrome, menus, overflow, footer, outside, btn, panelOf, items, labelOf, key, click, ovBtn };
}
const openMenu = (s: ReturnType<typeof setup>, title: string) => {
  s.key(s.btn(title), "ArrowDown");
  return s.panelOf(s.btn(title));
};
// Identity check that never prints its operands: assert.equal on a failure inspects both sides with custom inspection off, and a
// FakeEl links to its document, parent and listeners, so printing one exhausted memory (the cause of the earlier killed run).
const same = (a: unknown, b: unknown, msg?: string) => assert.ok(a === b, msg ?? "expected the same element");
const withReconnect = (): ViewDeclaration => TERMINAL_DECLARATION;

test("wide form: menubar roles, one button per declared menu, closed panels", () => {
  const s = setup(TERMINAL_DECLARATION);
  assert.equal(s.menus.role, "menubar");
  assert.equal(s.menus.getAttribute("aria-label"), "Terminal menus");
  const titles = s.menus.byClass("tile-btn").map((b) => b.textContent);
  assert.deepEqual(titles, ["View", "Trace", "Help"], "Session is hidden until Reconnect is offered");
  for (const b of s.menus.byClass("tile-btn")) {
    assert.equal(b.getAttribute("aria-haspopup"), "menu");
    assert.equal(b.getAttribute("aria-expanded"), "false");
    assert.equal(s.panelOf(b).role, "menu");
    assert.equal(s.panelOf(b).hidden, true);
  }
  assert.deepEqual(
    s.menus.byClass("tile-btn").map((b) => b.getAttribute("tabindex")),
    ["0", "-1", "-1"],
    "roving tabindex",
  );
});

test("browser and inbox declarations render their menus; inbox radio is a heading plus menuitemradio rows", () => {
  const b = setup(BROWSER_DECLARATION);
  assert.deepEqual(
    b.menus.byClass("tile-btn").map((x) => x.textContent),
    ["View", "Help"],
  );
  assert.deepEqual(
    b.items(b.panelOf(b.btn("View"))).map((i) => i.role),
    ["menuitemcheckbox", "menuitemcheckbox", "menuitem"],
  );
  const i = setup(INBOX_DECLARATION);
  const panel = i.panelOf(i.btn("View"));
  assert.ok(panel.byClass("menu-head").some((h) => h.role === "presentation"));
  const radios = i.items(panel);
  assert.ok(radios.length >= 2);
  assert.ok(radios.every((r) => r.role === "menuitemradio"));
  assert.equal(radios.filter((r) => r.getAttribute("aria-checked") === "true").length, 1);
});

test("hidden Reconnect and the Session menu appear after setState visible, and vanish again", () => {
  const s = setup(withReconnect());
  assert.ok(s.btn("Session") === undefined, "no Session menu");
  s.model.setState("terminal.reconnect", { visible: true });
  assert.ok(s.btn("Session"));
  assert.deepEqual(s.items(s.panelOf(s.btn("Session"))).map(s.labelOf), ["Reconnect"]);
  s.model.setState("terminal.reconnect", { visible: false });
  assert.ok(s.btn("Session") === undefined, "no Session menu");
});

test("overflow lists every menu with headings, then the model's items", () => {
  const s = setup(TERMINAL_DECLARATION);
  assert.equal(s.overflow.className, "tile-overflow");
  const b = s.ovBtn();
  assert.equal(b.getAttribute("aria-label"), "Menu");
  assert.equal(b.getAttribute("aria-haspopup"), "menu");
  const panel = s.panelOf(b);
  assert.ok(panel.className.includes("right-edge"));
  const heads = panel.byClass("menu-head").map((h) => h.textContent);
  for (const t of ["View", "Trace", "Help"]) assert.ok(heads.includes(t), `heading ${t}`);
  assert.ok(heads.indexOf("View") < heads.indexOf("Trace") && heads.indexOf("Trace") < heads.indexOf("Help"));
  const labels = s.items(panel).map(s.labelOf);
  for (const it of s.model.overflow()) if ("command" in it && it.kind === "action") assert.ok(labels.includes(it.label), it.label);
  assert.ok(
    panel.byClass("menu-head").every((h) => h.role === "presentation"),
    "headings are not items",
  );
  s.model.setState("terminal.reconnect", { visible: true });
  assert.ok(
    s
      .panelOf(s.ovBtn())
      .byClass("menu-head")
      .some((h) => h.textContent === "Session"),
  );
});

test("toggle and radio rows expose aria-checked and follow the model", () => {
  const s = setup(INBOX_DECLARATION);
  const panel = openMenu(s, "View");
  const [first, second] = s.items(panel);
  assert.equal(first.getAttribute("aria-checked"), "true");
  assert.equal(second.getAttribute("aria-checked"), "false");
  s.click(second);
  assert.deepEqual(s.calls.at(-1), ["inbox.filter", "message"]);
  const after = s.items(s.panelOf(s.btn("View")));
  assert.equal(after[0].getAttribute("aria-checked"), "false");
  assert.equal(after[1].getAttribute("aria-checked"), "true");
  assert.equal(s.panelOf(s.btn("View")).hidden, false, "radio keeps the menu open");

  const t = setup(BROWSER_DECLARATION);
  const p = openMenu(t, "View");
  const fit = t.items(p)[0];
  assert.equal(fit.getAttribute("aria-checked"), "true");
  t.click(fit);
  assert.deepEqual(t.calls.at(-1), ["browser.fit", false], "toggle flips: invoked with no arg, handler sees the new boolean");
  const fit2 = t.items(t.panelOf(t.btn("View")))[0];
  assert.equal(fit2.getAttribute("aria-checked"), "false");
  assert.equal(t.panelOf(t.btn("View")).hidden, false, "toggle keeps the menu open");
});

test("an action closes the menu, returns focus to its button and dispatches the command", () => {
  const s = setup(TERMINAL_DECLARATION);
  const panel = openMenu(s, "View");
  s.key(s.items(panel)[0], "Enter");
  assert.deepEqual(s.calls.at(-1), ["terminal.font-smaller", undefined]);
  assert.equal(s.panelOf(s.btn("View")).hidden, true);
  same(s.doc.activeElement, s.btn("View"));
  assert.equal(s.btn("View").getAttribute("aria-expanded"), "false");
});

test("a disabled item is visible, aria-disabled and not activatable", () => {
  const s = setup(TERMINAL_DECLARATION);
  s.model.setState("terminal.font-larger", { enabled: false });
  const panel = openMenu(s, "View");
  const larger = s.items(panel).find((i) => s.labelOf(i) === "Larger") as FakeEl;
  assert.equal(larger.getAttribute("aria-disabled"), "true");
  const n = s.calls.length;
  s.click(larger);
  s.key(larger, "Enter");
  assert.equal(s.calls.length, n);
  assert.equal(s.panelOf(s.btn("View")).hidden, false, "menu stays open");
  // keyboard skips it: Smaller -> (Larger disabled) -> Reset size
  const items = s.items(s.panelOf(s.btn("View")));
  s.key(items[0], "ArrowDown");
  assert.equal(s.labelOf(s.doc.activeElement as FakeEl), "Reset size");
});

test("keyboard in the bar: Down opens and focuses first, Up opens and focuses last, Right/Left/Home/End move", () => {
  const s = setup(TERMINAL_DECLARATION);
  s.key(s.btn("View"), "ArrowDown");
  same(s.doc.activeElement, s.items(s.panelOf(s.btn("View")))[0]);
  assert.equal(s.btn("View").getAttribute("aria-expanded"), "true");
  s.key(s.btn("Help"), "ArrowUp");
  assert.equal(s.panelOf(s.btn("View")).hidden, true, "only one menu open");
  same(s.doc.activeElement, s.items(s.panelOf(s.btn("Help"))).at(-1));
  s.key(s.btn("Help"), "Escape");
  s.key(s.btn("Help"), "ArrowRight");
  same(s.doc.activeElement, s.btn("View"), "wraps; closed bar only moves focus");
  assert.equal(s.btn("View").getAttribute("tabindex"), "0");
  assert.equal(s.btn("Help").getAttribute("tabindex"), "-1");
  s.key(s.btn("View"), "ArrowLeft");
  same(s.doc.activeElement, s.btn("Help"));
  s.key(s.btn("Help"), "Home");
  same(s.doc.activeElement, s.btn("View"));
  s.key(s.btn("View"), "End");
  same(s.doc.activeElement, s.btn("Help"));
  s.key(s.btn("Help"), "Enter");
  assert.equal(s.panelOf(s.btn("Help")).hidden, false);
  s.key(s.btn("Help"), "Escape");
  s.key(s.btn("Help"), " ");
  assert.equal(s.panelOf(s.btn("Help")).hidden, false, "Space opens");
});

test("keyboard in a menu: arrows wrap, Home/End, typeahead, Left/Right open the neighbour", () => {
  let t = 0;
  const s = setup(TERMINAL_DECLARATION, { now: () => t });
  const panel = openMenu(s, "Trace");
  const items = () => s.items(s.panelOf(s.btn("Trace")));
  const active = () => s.labelOf(s.doc.activeElement as FakeEl);
  assert.equal(active(), "Copy trace");
  s.key(items()[0], "ArrowUp");
  assert.equal(active(), "Download .md", "wraps to the last item");
  s.key(s.doc.activeElement as FakeEl, "ArrowDown");
  assert.equal(active(), "Copy trace");
  s.key(s.doc.activeElement as FakeEl, "End");
  assert.equal(active(), "Download .md");
  s.key(s.doc.activeElement as FakeEl, "Home");
  assert.equal(active(), "Copy trace");
  s.key(s.doc.activeElement as FakeEl, "i");
  assert.equal(active(), "Include children (condensed)");
  t = 5000;
  s.key(s.doc.activeElement as FakeEl, "i");
  assert.match(active(), /^Include raw/, "after the buffer times out the letter cycles to the next match");
  t = 9000;
  s.key(s.doc.activeElement as FakeEl, "d");
  assert.equal(active(), "Download .md");
  assert.equal(panel.byClass("menu-sep").length > 0, true);
  s.key(s.doc.activeElement as FakeEl, "ArrowRight");
  assert.equal(s.panelOf(s.btn("Trace")).hidden, true);
  assert.equal(s.panelOf(s.btn("Help")).hidden, false, "Right opens the next menu");
  same(s.doc.activeElement, s.items(s.panelOf(s.btn("Help")))[0]);
  s.key(s.doc.activeElement as FakeEl, "ArrowLeft");
  assert.equal(s.panelOf(s.btn("Trace")).hidden, false);
  assert.equal(s.panelOf(s.btn("Help")).hidden, true);
});

test("Escape closes and returns focus to the invoking button; Tab closes without cancelling the key", () => {
  const s = setup(TERMINAL_DECLARATION);
  openMenu(s, "Trace");
  const e = s.key(s.doc.activeElement as FakeEl, "Escape");
  assert.equal(e.defaultPrevented, true);
  assert.equal(s.panelOf(s.btn("Trace")).hidden, true);
  same(s.doc.activeElement, s.btn("Trace"));
  openMenu(s, "Trace");
  const tab = s.key(s.doc.activeElement as FakeEl, "Tab");
  assert.equal(tab.defaultPrevented, false, "the browser still moves focus on");
  assert.equal(s.panelOf(s.btn("Trace")).hidden, true);
  same(s.doc.activeElement, s.btn("Trace"));
});

test("click on a button toggles its menu; click outside closes; click inside does not", () => {
  const s = setup(TERMINAL_DECLARATION);
  s.click(s.btn("View"));
  assert.equal(s.panelOf(s.btn("View")).hidden, false);
  s.click(s.btn("Trace"));
  assert.equal(s.panelOf(s.btn("View")).hidden, true, "opening one closes the other");
  assert.equal(s.panelOf(s.btn("Trace")).hidden, false);
  s.click(s.panelOf(s.btn("Trace")));
  assert.equal(s.panelOf(s.btn("Trace")).hidden, false, "click in the panel keeps it open");
  s.click(s.outside);
  assert.equal(s.panelOf(s.btn("Trace")).hidden, true);
  s.click(s.btn("Trace"));
  s.click(s.btn("Trace"));
  assert.equal(s.panelOf(s.btn("Trace")).hidden, true, "second click closes");
});

test("a toggle click keeps the menu open even though the clicked row is re-rendered", () => {
  const s = setup(BROWSER_DECLARATION);
  s.click(s.btn("View"));
  s.click(s.items(s.panelOf(s.btn("View")))[1]);
  assert.equal(s.panelOf(s.btn("View")).hidden, false);
});

test("hovering another menu button while one is open switches menus; not when none is open", () => {
  const s = setup(TERMINAL_DECLARATION);
  s.btn("Trace").dispatch({ type: "mouseenter" }, false);
  assert.equal(s.panelOf(s.btn("Trace")).hidden, true);
  s.click(s.btn("View"));
  s.btn("Trace").dispatch({ type: "mouseenter" }, false);
  assert.equal(s.panelOf(s.btn("View")).hidden, true);
  assert.equal(s.panelOf(s.btn("Trace")).hidden, false);
});

test("open menu and focus survive a re-render while the command still exists", () => {
  const s = setup(TERMINAL_DECLARATION);
  openMenu(s, "Trace");
  s.key(s.doc.activeElement as FakeEl, "ArrowDown");
  const before = s.labelOf(s.doc.activeElement as FakeEl);
  s.model.setStatus("state", { text: "busy" });
  s.model.setState("terminal.trace-short", { enabled: true });
  assert.equal(s.panelOf(s.btn("Trace")).hidden, false);
  assert.equal(s.labelOf(s.doc.activeElement as FakeEl), before);
  s.model.setState("terminal.reconnect", { visible: true });
  assert.equal(s.panelOf(s.btn("Trace")).hidden, false, "adding a menu does not close the open one");
});

test("an open menu that disappears closes and focus falls back to the bar", () => {
  const s = setup(TERMINAL_DECLARATION);
  s.model.setState("terminal.reconnect", { visible: true });
  openMenu(s, "Session");
  s.model.setState("terminal.reconnect", { visible: false });
  assert.equal(
    s.menus.byClass("menu-drop").every((p) => p.hidden),
    true,
  );
  same(s.doc.activeElement, s.btn("View"));
});

test("overflow button opens its panel with the same keys; Left/Right do nothing there", () => {
  const s = setup(TERMINAL_DECLARATION);
  s.key(s.ovBtn(), "ArrowDown");
  const panel = s.panelOf(s.ovBtn());
  assert.equal(panel.hidden, false);
  assert.equal(s.ovBtn().getAttribute("aria-expanded"), "true");
  const first = s.doc.activeElement as FakeEl;
  assert.equal(first.role, "menuitem");
  s.key(first, "ArrowRight");
  assert.equal(panel.hidden, false);
  s.key(first, "Enter");
  assert.deepEqual(s.calls.at(-1), ["terminal.font-smaller", undefined]);
  assert.equal(panel.hidden, true);
  same(s.doc.activeElement, s.ovBtn());
});

test("status footer: hidden while no slot has text, shown with text and tone, hidden again", () => {
  const s = setup(TERMINAL_DECLARATION);
  assert.equal(s.footer.className, "tile-foot");
  assert.equal(s.footer.hidden, true);
  assert.equal(s.footer.children.length, 0);
  s.model.setStatus("connection", { text: "connected", tone: "ok" });
  assert.equal(s.footer.hidden, false);
  const stat = s.footer.byClass("stat")[0];
  assert.equal(stat.textContent, "connected");
  assert.equal(stat.getAttribute("data-tone"), "ok");
  assert.equal(stat.byClass("stat-dot").length, 1);
  s.model.setStatus("connection", { tone: "err" });
  assert.equal(s.footer.byClass("stat")[0].getAttribute("data-tone"), "err");
  s.model.setStatus("connection", { text: "" });
  assert.equal(s.footer.hidden, true);
  const b = setup(BROWSER_DECLARATION);
  assert.equal(b.footer.hidden, false, "declared text shows at once");
  b.model.setStatus("url", { text: "https://example.test/" });
  const url = b.footer.byClass("stat").find((e) => e.textContent === "https://example.test/") as FakeEl;
  assert.ok(url.className.includes("mono"));
  assert.equal(url.getAttribute("data-tone"), null, "no tone, no dot");
});

test("a label containing markup stays text", () => {
  const evil = "<script>alert(1)</script>";
  const s = setup({
    id: "evil",
    title: "Evil",
    multi: true,
    menus: [{ id: "view", items: [{ kind: "action", command: "evil.go", label: evil, hint: "<b>x</b>", caution: "<img>" }] }],
    status: [{ id: "s", title: "S", text: evil }],
  });
  const panel = openMenu(s, "View");
  const item = s.items(panel)[0];
  assert.equal(s.labelOf(item), evil);
  assert.equal(item.byClass("menu-hint")[0].textContent, "<b>x</b>");
  assert.equal(item.byClass("menu-caution")[0].textContent, "<img>");
  assert.equal(s.footer.byClass("stat")[0].textContent, evil);
  assert.equal(
    s.menus
      .all()
      .concat(s.footer.all())
      .some((e) => e.tagName === "script" || e.tagName === "b" || e.tagName === "img"),
    false,
  );
  assert.ok(item.className.includes("caution"));
});

test("destroy unsubscribes from the model and removes the document listener", () => {
  const s = setup(TERMINAL_DECLARATION);
  assert.equal(s.doc.listenerCount("click"), 1);
  s.chrome.destroy();
  assert.equal(s.doc.listenerCount("click"), 0);
  s.model.setStatus("connection", { text: "late" });
  assert.equal(s.footer.children.length, 0, "no re-render after destroy");
  assert.equal(s.menus.children.length, 0);
  s.chrome.destroy(); // idempotent
});

test("a handler that throws leaves the menu usable and tells the operator", () => {
  const s = setup(BROWSER_DECLARATION);
  let boom = true;
  s.model.onCommand((c, a) => {
    if (boom) throw new Error("kaboom");
    s.calls.push([c, a]);
  });
  const panel = openMenu(s, "View");
  s.click(s.items(panel)[0]);
  assert.equal(s.footer.hidden, false);
  const alert = s.footer.byClass("stat").find((e) => e.role === "alert") as FakeEl;
  assert.match(alert.textContent, /kaboom/);
  assert.equal(s.items(s.panelOf(s.btn("View")))[0].getAttribute("aria-checked"), "true", "toggle state restored");
  assert.equal(s.panelOf(s.btn("View")).hidden, false);
  boom = false;
  s.click(s.items(s.panelOf(s.btn("View")))[0]);
  assert.deepEqual(s.calls.at(-1), ["browser.fit", false]);
  assert.equal(
    s.footer.byClass("stat").some((e) => e.role === "alert"),
    false,
    "the next successful action clears the failure",
  );
});

test("unusual input fails loudly with cause and action", () => {
  const doc = new FakeDoc() as unknown as Document;
  assert.throws(() => kit.ChromeKit.createChrome({} as never, { document: doc }), /must be a MenuKit window model.*pass the model/);
  assert.throws(() => kit.ChromeKit.createChrome(null as never, { document: doc }), /must be a MenuKit window model/);
  const model = kit.MenuKit.createWindowModel(kit.MenuKit.declareView(BROWSER_DECLARATION));
  assert.throws(() => kit.ChromeKit.createChrome(model, {} as never), /deps\.document must be a Document.*createChrome\(model, \{document\}\)/);
  assert.throws(() => kit.ChromeKit.createChrome(model, undefined as never), /deps\.document must be a Document/);
});
