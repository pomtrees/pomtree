import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { CONTEXT_MENU_CSS, CONTEXT_MENU_JS, type ContextMenu, type ContextMenuItem, type ContextMenuKitApi } from "./contextMenu.ts";
import { FakeDocument, type Listener, Node_ } from "./launcherFakeDom.ts";
import { MENU_NAV_JS } from "./menuNav.ts";

// ---- Fake DOM extensions local to this file: style, size, focus log, removeEventListener, viewport, window. ----
class El extends Node_ {
  style: Record<string, string> = {};
  offsetWidth = 0;
  offsetHeight = 0;
  rect = { left: 0, top: 0, right: 0, bottom: 0 };
  log: string[];
  constructor(tag: string, log: string[]) {
    super(tag);
    this.log = log;
  }
  override focus() {
    super.focus();
    this.log.push(this.attrs.get("role") === "menuitem" ? this.textContent : this.attrs.get("role") === "menu" ? "popup" : this.id || "el");
  }
  getBoundingClientRect() {
    return this.rect;
  }
  removeEventListener(t: string, fn: Listener) {
    const l = this.listeners.get(t) ?? [];
    this.listeners.set(
      t,
      l.filter((r) => r.fn !== fn),
    );
  }
  count(t: string) {
    return (this.listeners.get(t) ?? []).length;
  }
}
type WinReg = { fn: Listener; capture: boolean };
class Win {
  innerWidth = 800;
  innerHeight = 600;
  listeners = new Map<string, WinReg[]>();
  addEventListener(t: string, fn: Listener, capture?: boolean) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), { fn, capture: !!capture }]);
  }
  removeEventListener(t: string, fn: Listener, capture?: boolean) {
    this.listeners.set(
      t,
      (this.listeners.get(t) ?? []).filter((r) => !(r.fn === fn && r.capture === !!capture)),
    );
  }
  count(t: string) {
    return (this.listeners.get(t) ?? []).length;
  }
  // A window-targeted event reaches every listener. A document-targeted scroll bubbles to the window.
  fire(t: string) {
    for (const r of [...(this.listeners.get(t) ?? [])]) r.fn({ type: t });
  }
  // An event aimed at an element: capture listeners on the window see it; blur, focus and scroll do not bubble, so non-capture ones do not.
  fireAtElement(t: string) {
    const bubbles = !["blur", "focus", "scroll"].includes(t);
    for (const r of [...(this.listeners.get(t) ?? [])]) if (r.capture || bubbles) r.fn({ type: t });
  }
}
class Doc extends FakeDocument {
  log: string[] = [];
  win = new Win();
  defaultView = this.win;
  documentElement = { clientWidth: 800, clientHeight: 600 };
  constructor() {
    super();
    this.createElement = (tag: string) => {
      const e = new El(tag, this.log);
      if (tag === "div") {
        e.offsetWidth = 100;
        e.offsetHeight = 200;
      }
      return e;
    };
  }
  removeEventListener(t: string, fn: Listener) {
    const l = this.listeners.get(t) ?? [];
    this.listeners.set(
      t,
      l.filter((r) => r.fn !== fn),
    );
  }
  count(t: string) {
    return (this.listeners.get(t) ?? []).length;
  }
}

const clock = { t: 1000 };
function load() {
  const errors: string[] = [];
  const sandbox = {
    globalThis: {},
    JSON,
    Object,
    Array,
    Set,
    Map,
    String,
    Error,
    Number,
    Math,
    Date: { now: () => clock.t },
    console: { error: (m: string) => errors.push(String(m)) },
  };
  const Kit = runInContext(`(() => { ${MENU_NAV_JS}; ${CONTEXT_MENU_JS}; return ContextMenuKit; })()`, createContext(sandbox)) as ContextMenuKitApi;
  return { Kit, errors };
}

const act = (command: string, label: string, enabled = true, visible?: boolean): ContextMenuItem =>
  visible === undefined ? { kind: "action", command, label, enabled } : { kind: "action", command, label, enabled, visible };
const sep = (): ContextMenuItem => ({ kind: "separator" });
const ITEMS: ContextMenuItem[] = [
  act("window.maximize", "Maximize"),
  act("window.minimize", "Minimize", false),
  sep(),
  act("window.close", "Close"),
  act("window.close-others", "Close others"),
  act("window.close-all", "Close all", false, false),
];

function setup() {
  const { Kit, errors } = load();
  const doc = new Doc();
  const opener = doc.createElement("button") as El;
  opener.id = "opener";
  const menu: ContextMenu = Kit.create({ document: doc });
  const picks: string[] = [];
  const open = (items = ITEMS, x = 10, y = 20) => menu.open({ items, x, y, label: "Window actions", opener, onPick: (c) => picks.push(c) });
  const popup = () => doc.body.byClass("ctx-menu")[0] as El | undefined;
  const items = () => (popup()?.byClass("ctx-item") ?? []) as El[];
  const item = (label: string) => items().find((e) => e.textContent === label) as El;
  const key = (label: string, k: string, init: Record<string, unknown> = {}) => item(label).fire("keydown", { key: k, ...init });
  return { Kit, errors, doc, opener, menu, picks, open, popup, items, item, key };
}

test("DOM shape: popup role=menu with aria-label in body, buttons role=menuitem, separator, structural classes only", () => {
  const t = setup();
  assert.equal(t.open(), true);
  const p = t.popup() as El;
  assert.equal(p.parent === t.doc.body, true);
  assert.equal(p.className, "ctx-menu");
  assert.equal(p.getAttribute("role"), "menu");
  assert.equal(p.getAttribute("aria-label"), "Window actions");
  assert.deepEqual(
    t.items().map((e) => [e.tagName, e.getAttribute("role"), e.className, e.getAttribute("type"), e.textContent].join("|")),
    [
      "button|menuitem|ctx-item|button|Maximize",
      "button|menuitem|ctx-item|button|Minimize",
      "button|menuitem|ctx-item|button|Close",
      "button|menuitem|ctx-item|button|Close others",
    ],
  );
  const seps = p.byClass("ctx-sep");
  assert.equal(seps.length, 1);
  assert.equal(seps[0]?.getAttribute("role"), "separator");
  assert.equal(
    p.all().every((n) => Object.keys((n as El).style).every((k) => k === "left" || k === "top")),
    true,
    "inline style is position only, no colours",
  );
  // negative control: nothing is in the body before open
  assert.equal(setup().popup(), undefined);
});

test("labels go through textContent only (markup in a label stays text)", () => {
  const t = setup();
  t.open([act("x", "<img src=x onerror=boom()>")]);
  assert.equal(t.items()[0]?.textContent, "<img src=x onerror=boom()>");
  assert.equal(t.items()[0]?.children.length, 0);
});

test("visible:false items are not rendered; the rest are; separators are tidied", () => {
  const t = setup();
  t.open([sep(), act("a", "Alpha", true, false), act("b", "Beta"), sep(), sep(), act("c", "Gamma"), sep()]);
  assert.deepEqual(
    t.items().map((e) => e.textContent),
    ["Beta", "Gamma"],
  );
  assert.equal((t.popup() as El).byClass("ctx-sep").length, 1, "doubled and edge separators dropped");
  assert.equal(t.item("Alpha"), undefined);
});

test("an empty or all-invisible list does not open (negative: one visible row does)", () => {
  const t = setup();
  assert.equal(t.open([]), false);
  assert.equal(t.open([act("a", "A", true, false), sep(), act("b", "B", true, false)]), false);
  assert.equal(t.popup(), undefined);
  assert.equal(t.menu.isOpen(), false);
  assert.equal(t.open([act("a", "A")]), true);
  assert.equal(t.menu.isOpen(), true);
});

test("bad items name the cause and the action on console.error and do not throw", () => {
  const t = setup();
  assert.equal(t.menu.open({ items: "nope" as unknown as ContextMenuItem[], x: 0, y: 0, label: "m" }), false);
  assert.match(t.errors[0] ?? "", /ContextMenuKit\.open: items must be an array.*pass the output/);
});

test("disabled item: aria-disabled=true, click and Enter do nothing and keep the menu open; enabled items lack the attribute", () => {
  const t = setup();
  t.open();
  assert.equal(t.item("Minimize").getAttribute("aria-disabled"), "true");
  assert.equal(t.item("Maximize").getAttribute("aria-disabled"), null);
  t.item("Minimize").fire("click");
  t.key("Minimize", "Enter");
  t.key("Minimize", " ");
  assert.deepEqual(t.picks, []);
  assert.equal(t.menu.isOpen(), true);
  t.item("Maximize").fire("click");
  assert.deepEqual(t.picks, ["window.maximize"]);
});

test("focus moves to the first enabled item on open (skipping a disabled first row); opener is not focused", () => {
  const t = setup();
  t.open([act("a", "Alpha", false), act("b", "Beta"), act("c", "Gamma")]);
  assert.deepEqual(t.doc.log, ["Beta"]);
  const u = setup();
  u.open();
  assert.deepEqual(u.doc.log, ["Maximize"]);
});

test("all rows disabled: popup itself takes focus so Escape still works", () => {
  const t = setup();
  t.open([act("a", "Alpha", false)]);
  assert.deepEqual(t.doc.log, ["popup"]);
  (t.popup() as El).fire("keydown", { key: "Escape", target: t.popup() });
  assert.equal(t.menu.isOpen(), false);
  assert.deepEqual(t.doc.log, ["popup", "opener"]);
});

test("ArrowDown/ArrowUp wrap and skip the disabled row; Home/End jump", () => {
  const t = setup();
  t.open();
  t.doc.log.length = 0;
  t.key("Maximize", "ArrowDown"); // Minimize is disabled -> Close
  t.key("Close", "ArrowDown");
  t.key("Close others", "ArrowDown"); // wraps
  t.key("Maximize", "ArrowUp"); // wraps backwards
  t.key("Close", "ArrowUp"); // skips disabled Minimize
  t.key("Close others", "Home");
  t.key("Maximize", "End");
  assert.deepEqual(t.doc.log, ["Close", "Close others", "Maximize", "Close others", "Maximize", "Maximize", "Close others"]);
  const ev = t.key("Maximize", "ArrowDown");
  assert.equal(ev.defaultPrevented, true);
});

test("typeahead by first letter moves to the next enabled match; none leaves focus", () => {
  const t = setup();
  t.open();
  t.doc.log.length = 0;
  t.key("Maximize", "c");
  assert.deepEqual(t.doc.log, ["Close"]);
  t.key("Close", "c"); // repeated letter cycles to the next match
  assert.deepEqual(t.doc.log, ["Close", "Close others"]);
  clock.t += 5000; // buffer expired: a new letter starts a fresh search; Minimize is disabled so it wraps to Maximize
  t.key("Close others", "m");
  assert.deepEqual(t.doc.log, ["Close", "Close others", "Maximize"]);
  t.key("Maximize", "z");
  assert.deepEqual(t.doc.log, ["Close", "Close others", "Maximize"]);
});

test("Enter and Space activate: close, refocus opener, onPick once with the command", () => {
  for (const k of ["Enter", " "]) {
    const t = setup();
    t.open();
    t.doc.log.length = 0;
    const ev = t.key("Close", k);
    assert.equal(ev.defaultPrevented, true);
    assert.deepEqual(t.picks, ["window.close"]);
    assert.equal(t.menu.isOpen(), false);
    assert.equal(t.popup(), undefined);
    assert.deepEqual(t.doc.log, ["opener"]);
  }
});

test("Escape closes and refocuses the opener without picking; other keys leave it open", () => {
  const t = setup();
  t.open();
  t.doc.log.length = 0;
  const other = t.key("Close", "F2");
  assert.equal(other.defaultPrevented, false);
  assert.equal(t.menu.isOpen(), true);
  t.key("Close", "Escape");
  assert.equal(t.menu.isOpen(), false);
  assert.deepEqual(t.picks, []);
  assert.deepEqual(t.doc.log, ["opener"]);
});

test("Tab closes without refocusing or preventing the browser move; Ctrl+Enter does nothing", () => {
  const t = setup();
  t.open();
  t.doc.log.length = 0;
  t.key("Close", "Enter", { ctrlKey: true });
  assert.equal(t.menu.isOpen(), true);
  const ev = t.key("Close", "Tab");
  assert.equal(t.menu.isOpen(), false);
  assert.equal(ev.defaultPrevented, false);
  assert.deepEqual(t.doc.log, []);
  assert.deepEqual(t.picks, []);
});

test("click on an enabled item closes, then calls onPick exactly once even when activated twice", () => {
  const t = setup();
  let openAtPick: boolean | null = null;
  t.menu.open({
    items: ITEMS,
    x: 0,
    y: 0,
    label: "m",
    opener: t.opener,
    onPick: (c) => {
      openAtPick = t.menu.isOpen();
      t.picks.push(c);
    },
  });
  const close = t.item("Close");
  close.fire("click");
  close.fire("click");
  close.fire("keydown", { key: "Enter" });
  assert.deepEqual(t.picks, ["window.close"]);
  assert.equal(openAtPick, false, "menu already closed when onPick runs");
});

test("onPick that throws is caught: no throw, console.error names the command id, the cause and the action", () => {
  const t = setup();
  t.menu.open({
    items: ITEMS,
    x: 0,
    y: 0,
    label: "m",
    opener: t.opener,
    onPick: () => {
      throw new Error("boom");
    },
  });
  assert.doesNotThrow(() => t.item("Close").fire("click"));
  assert.equal(t.menu.isOpen(), false);
  assert.match(t.errors[0] ?? "", /handler for window\.close failed: boom; .*retry/);
  // negative control: a healthy handler reports nothing
  const u = setup();
  u.open();
  u.item("Close").fire("click");
  assert.deepEqual(u.errors, []);
});

test("pointerdown outside closes; inside does not; window blur, resize and scroll close", () => {
  const t = setup();
  t.open();
  t.doc.dispatch(t.item("Close"), "pointerdown");
  assert.equal(t.menu.isOpen(), true, "inside press keeps it open");
  t.doc.dispatch(t.opener, "pointerdown");
  assert.equal(t.menu.isOpen(), false);
  for (const ev of ["blur", "resize", "scroll"]) {
    const u = setup();
    u.open();
    assert.equal(u.menu.isOpen(), true);
    u.doc.win.fire(ev);
    assert.equal(u.menu.isOpen(), false, ev);
  }
  const v = setup();
  v.open();
  v.doc.win.fire("focus");
  assert.equal(v.menu.isOpen(), true, "unrelated window event keeps it open");
});

test("element blur (focus moving between items, opener blur) and element scroll do not close; window blur, resize and document scroll do", () => {
  const t = setup();
  t.open();
  t.doc.win.fireAtElement("blur");
  t.doc.win.fireAtElement("scroll");
  assert.equal(t.menu.isOpen(), true, "element blur/scroll must not close");
  t.key("Maximize", "ArrowDown");
  t.key("Close", "ArrowDown");
  assert.equal(t.menu.isOpen(), true, "arrow navigation keeps it open");
  // the arrows visited Close then Close others (the disabled Minimize is skipped), and the menu is still open
  assert.equal(t.item("Close").focused > 0, true, "Close was focused");
  assert.equal(t.item("Close others").focused > 0, true, "Close others was focused");
  assert.equal(t.item("Minimize").focused, 0, "disabled Minimize is never focused");
  for (const ev of ["blur", "resize", "scroll"]) {
    const u = setup();
    u.open();
    u.doc.win.fire(ev);
    assert.equal(u.menu.isOpen(), false, `window-level ${ev}`);
  }
});

test("close removes the popup and every document and window listener (no leak across open/close cycles)", () => {
  const t = setup();
  t.open();
  assert.equal(t.doc.count("pointerdown"), 1);
  assert.equal(t.doc.win.count("blur"), 1);
  for (let i = 0; i < 3; i++) {
    t.menu.close();
    t.open();
  }
  t.menu.close();
  assert.equal(t.doc.count("pointerdown"), 0);
  for (const ev of ["blur", "resize", "scroll"]) assert.equal(t.doc.win.count(ev), 0);
  assert.equal(t.doc.body.children.length, 0);
  t.menu.close(); // closing a closed menu is a no-op
});

test("position: placed at x,y; clamped inside the viewport on every edge", () => {
  const at = (x: number, y: number) => {
    const t = setup();
    t.open(ITEMS, x, y);
    const s = (t.popup() as El).style;
    return `${s.left},${s.top}`;
  };
  assert.equal(at(10, 20), "10px,20px");
  assert.equal(at(790, 590), "700px,400px"); // 800-100, 600-200
  assert.equal(at(-5, -9), "0px,0px");
  assert.equal(at(Number.NaN, 30), "0px,30px");
  const t = setup();
  t.doc.documentElement = { clientWidth: 0, clientHeight: 0 };
  t.doc.win.innerWidth = 300;
  t.doc.win.innerHeight = 250;
  t.open(ITEMS, 290, 240);
  assert.equal((t.popup() as El).style.left, "200px", "falls back to window.innerWidth");
  assert.equal((t.popup() as El).style.top, "50px");
});

test("opening a second menu closes the first (also across create() calls); reopening replaces the popup", () => {
  const { Kit } = load();
  const doc = new Doc();
  const a = Kit.create({ document: doc });
  const b = Kit.create({ document: doc });
  a.open({ items: ITEMS, x: 1, y: 1, label: "A" });
  b.open({ items: ITEMS, x: 2, y: 2, label: "B" });
  assert.equal(a.isOpen(), false);
  assert.equal(b.isOpen(), true);
  assert.equal(doc.body.byClass("ctx-menu").length, 1);
  assert.equal(doc.body.byClass("ctx-menu")[0]?.getAttribute("aria-label"), "B");
  b.open({ items: ITEMS, x: 3, y: 3, label: "B2" });
  assert.equal(doc.body.byClass("ctx-menu").length, 1);
  assert.equal(doc.count("pointerdown"), 1);
});

test("create without a usable document throws naming cause and action", () => {
  const { Kit } = load();
  assert.throws(() => Kit.create({ document: null }), /needs \{document\}.*pass the page document/);
});

// ---- attach ----
function attached() {
  const t = setup();
  const el = t.doc.createElement("button") as El;
  el.id = "entry";
  el.rect = { left: 40, top: 10, right: 120, bottom: 38 };
  const seen: string[] = [];
  const detach = t.Kit.attach(el, { menu: t.menu, items: () => ITEMS, onPick: (c) => seen.push(c), label: "Entry actions" });
  return { ...t, el, seen, detach };
}

test("attach opener option: Escape and a pick focus the opener, not el; default is el", () => {
  const t = setup();
  const bar = t.doc.createElement("div") as El;
  const root = t.doc.createElement("div") as El;
  root.id = "root";
  t.Kit.attach(bar, { menu: t.menu, items: () => ITEMS, label: "Bar", opener: root });
  bar.fire("contextmenu", { clientX: 1, clientY: 1 });
  t.key("Maximize", "Escape");
  assert.deepEqual([root.focused, bar.focused, t.menu.isOpen()], [1, 0, false]);
  bar.fire("contextmenu", { clientX: 1, clientY: 1 });
  t.item("Close").fire("click");
  assert.deepEqual([root.focused, bar.focused], [2, 0]);
  const e = attached();
  e.el.fire("contextmenu", { clientX: 1, clientY: 1 });
  e.key("Maximize", "Escape");
  assert.equal(e.el.focused, 1, "default opener is el");
});

test("attach: contextmenu prevents default and opens at the pointer; pick runs onPick and refocuses the element", () => {
  const t = attached();
  const ev = t.el.fire("contextmenu", { clientX: 55, clientY: 66 });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(t.menu.isOpen(), true);
  const s = (t.popup() as El).style;
  assert.equal(`${s.left},${s.top}`, "55px,66px");
  assert.equal(t.popup()?.getAttribute("aria-label"), "Entry actions");
  t.doc.log.length = 0;
  t.item("Close others").fire("click");
  assert.deepEqual(t.seen, ["window.close-others"]);
  assert.deepEqual(t.doc.log, ["entry"]);
});

test("attach: ContextMenu key and Shift+F10 open at the bottom-left of the element and prevent default", () => {
  for (const init of [{ key: "ContextMenu" }, { key: "F10", shiftKey: true }]) {
    const t = attached();
    const ev = t.el.fire("keydown", init);
    assert.equal(ev.defaultPrevented, true, JSON.stringify(init));
    assert.equal(t.menu.isOpen(), true);
    const s = (t.popup() as El).style;
    assert.equal(`${s.left},${s.top}`, "40px,38px");
  }
});

test("attach negative controls: plain F10, Ctrl+Shift+F10, Enter, ArrowDown do nothing and are not prevented", () => {
  const t = attached();
  for (const init of [
    { key: "F10" },
    { key: "F10", shiftKey: true, ctrlKey: true },
    { key: "Enter" },
    { key: "ArrowDown" },
    { key: "Shift", shiftKey: true },
  ]) {
    const ev = t.el.fire("keydown", init);
    assert.equal(ev.defaultPrevented, false, JSON.stringify(init));
    assert.equal(t.menu.isOpen(), false, JSON.stringify(init));
  }
});

test("attach: an all-invisible list still prevents the native menu but opens nothing; items() throwing is reported", () => {
  const { Kit, errors } = load();
  const doc = new Doc();
  const menu = Kit.create({ document: doc });
  const el = doc.createElement("div") as El;
  Kit.attach(el, { menu, items: () => [act("a", "A", true, false)], label: "x" });
  const ev = el.fire("contextmenu", { clientX: 1, clientY: 1 });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(menu.isOpen(), false);
  const el2 = doc.createElement("div") as El;
  Kit.attach(el2, {
    menu,
    items: () => {
      throw new Error("bad model");
    },
    label: "x",
  });
  assert.doesNotThrow(() => el2.fire("contextmenu", { clientX: 1, clientY: 1 }));
  assert.match(errors[0] ?? "", /could not build the menu items: bad model; reload/);
});

// ---- touch: long-press opens the menu (synthetic pointer events; a real touch screen is the manual check) ----
function touchSetup() {
  const t = attached();
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const timers = {
    setTimeout: (fn: () => void, ms: number) => {
      pending.set(next, { fn, ms });
      return next++;
    },
    clearTimeout: (h: unknown) => {
      pending.delete(h as number);
    },
  };
  const el = t.doc.createElement("div") as El;
  const seen: string[] = [];
  const detach = t.Kit.attach(el, { menu: t.menu, items: () => ITEMS, onPick: (c) => seen.push(c), label: "Entry actions", timers });
  const elapse = () => {
    for (const [h, r] of [...pending]) {
      pending.delete(h);
      r.fn();
    }
  };
  const down = (init: Record<string, unknown> = {}) => el.fire("pointerdown", { pointerType: "touch", isPrimary: true, clientX: 30, clientY: 40, ...init });
  return { ...t, el, seen, detach, timers, pending, elapse, down };
}

test("touch: a long press opens the menu at the finger after the delay, and lifting the finger keeps it open", () => {
  const t = touchSetup();
  t.down();
  assert.equal(t.menu.isOpen(), false, "nothing before the delay");
  assert.equal(t.pending.size, 1);
  assert.equal([...t.pending.values()][0]?.ms, 500);
  t.elapse();
  assert.equal(t.menu.isOpen(), true);
  const s = (t.popup() as El).style;
  assert.equal(`${s.left},${s.top}`, "30px,40px");
  const up = t.el.fire("pointerup", { pointerType: "touch", isPrimary: true });
  assert.equal(t.menu.isOpen(), true, "lifting the finger keeps the menu open");
  assert.equal(up.defaultPrevented, false);
  t.item("Close others").fire("click");
  assert.deepEqual(t.seen, ["window.close-others"]);
});

test("touch: release, cancel, movement past the slop, a second pointer or a non-touch pointer cancel the press (negative controls)", () => {
  const cases: Array<[string, (t: ReturnType<typeof touchSetup>) => void]> = [
    ["pointerup", (t) => t.el.fire("pointerup", { pointerType: "touch", isPrimary: true })],
    ["pointercancel", (t) => t.el.fire("pointercancel", { pointerType: "touch", isPrimary: true })],
    ["pointermove far", (t) => t.el.fire("pointermove", { pointerType: "touch", isPrimary: true, clientX: 30, clientY: 60 })],
    ["second pointer", (t) => t.el.fire("pointerdown", { pointerType: "touch", isPrimary: false, clientX: 90, clientY: 90 })],
  ];
  for (const [name, cancel] of cases) {
    const t = touchSetup();
    t.down();
    cancel(t);
    assert.equal(t.pending.size, 0, name);
    t.elapse();
    assert.equal(t.menu.isOpen(), false, name);
  }
  const mouse = touchSetup();
  mouse.down({ pointerType: "mouse" });
  assert.equal(mouse.pending.size, 0, "a mouse press is not a long-press");
  const small = touchSetup();
  small.down();
  small.el.fire("pointermove", { pointerType: "touch", isPrimary: true, clientX: 33, clientY: 43 });
  small.elapse();
  assert.equal(small.menu.isOpen(), true, "finger jitter inside the slop keeps the press");
});

test("touch: a native contextmenu in the same gesture does not reopen the menu, and one after the press is cancelled still does", () => {
  const t = touchSetup();
  t.down();
  t.elapse();
  const first = t.popup();
  const ev = t.el.fire("contextmenu", { clientX: 30, clientY: 40 });
  assert.equal(ev.defaultPrevented, true, "the native menu is still suppressed");
  assert.equal(t.popup(), first, "the open menu is kept, not rebuilt");
  const early = touchSetup();
  early.down();
  early.el.fire("contextmenu", { clientX: 30, clientY: 40 });
  assert.equal(early.menu.isOpen(), true, "a browser that fires contextmenu first opens it once");
  assert.equal(early.pending.size, 0, "and the timer is gone");
  early.elapse();
  assert.equal(early.doc.body.byClass("ctx-menu").length, 1);
});

test("touch: after a long press, a later mouse right-click still opens the menu", () => {
  const t = touchSetup();
  t.down();
  t.elapse();
  t.menu.close();
  t.el.fire("pointerdown", { pointerType: "mouse", isPrimary: true });
  t.el.fire("contextmenu", { clientX: 5, clientY: 6 });
  assert.equal(t.menu.isOpen(), true);
});

test("touch: detach removes the pointer listeners and cancels a pending press; no timer facility means no long-press", () => {
  const t = touchSetup();
  t.down();
  t.detach();
  assert.equal(t.pending.size, 0);
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) assert.equal(t.el.count(type), 0, type);
  t.elapse();
  assert.equal(t.menu.isOpen(), false);
  const bare = attached();
  bare.el.fire("pointerdown", { pointerType: "touch", isPrimary: true, clientX: 1, clientY: 1 });
  assert.equal(bare.menu.isOpen(), false, "the vm sandbox has no setTimeout and no injected timers");
});

test("attach: the detach function removes both listeners (negative: before detach they are present)", () => {
  const t = attached();
  assert.equal(t.el.count("contextmenu"), 1);
  assert.equal(t.el.count("keydown"), 1);
  t.detach();
  assert.equal(t.el.count("contextmenu"), 0);
  assert.equal(t.el.count("keydown"), 0);
  const ev = t.el.fire("contextmenu", { clientX: 1, clientY: 1 });
  assert.equal(ev.defaultPrevented, false);
  assert.equal(t.menu.isOpen(), false);
});

test("attach keyTarget: keys aimed at it open below el; a descendant of keyTarget as target does not; detach removes its listener", () => {
  const t = setup();
  const el = t.doc.createElement("div") as El;
  el.rect = { left: 5, top: 5, right: 50, bottom: 30 };
  const root = t.doc.createElement("div") as El;
  const inner = t.doc.createElement("div") as El;
  root.appendChild(inner);
  const detach = t.Kit.attach(el, { menu: t.menu, items: () => ITEMS, label: "Tile", keyTarget: root });
  assert.equal(root.count("keydown"), 1);
  const neg = root.fire("keydown", { key: "ContextMenu", target: inner });
  assert.equal(neg.defaultPrevented, false);
  assert.equal(t.menu.isOpen(), false);
  const plainKey = root.fire("keydown", { key: "F10" });
  assert.equal(plainKey.defaultPrevented, false);
  assert.equal(t.menu.isOpen(), false);
  const ev = root.fire("keydown", { key: "F10", shiftKey: true });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(t.menu.isOpen(), true);
  const s = (t.popup() as El).style;
  assert.equal(`${s.left},${s.top}`, "5px,30px");
  t.menu.close();
  el.fire("keydown", { key: "ContextMenu" });
  assert.equal(t.menu.isOpen(), true, "keys inside el still open it");
  t.menu.close();
  detach();
  assert.equal(root.count("keydown"), 0);
  assert.equal(el.count("keydown"), 0);
  assert.equal(root.fire("keydown", { key: "ContextMenu" }).defaultPrevented, false);
  assert.equal(t.menu.isOpen(), false);
});

test("attach rejects a bad element or options naming cause and action", () => {
  const t = setup();
  assert.throws(() => t.Kit.attach(null, { menu: t.menu, items: () => [], label: "x" }), /el must be an element.*pass the bar entry/);
  assert.throws(() => t.Kit.attach(t.opener, { menu: t.menu } as never), /opts needs \{menu, items/);
});

test("the source has no backticks, interpolation or backslashes (it is a template literal)", () => {
  assert.equal(CONTEXT_MENU_JS.includes("`"), false);
  assert.equal(CONTEXT_MENU_JS.includes("${"), false);
  assert.equal(CONTEXT_MENU_JS.includes("\\"), false);
  assert.doesNotMatch(CONTEXT_MENU_JS + CONTEXT_MENU_CSS, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test("CONTEXT_MENU_CSS: tokens with fallbacks, no colour literals, no // comments, forced-colors, reduced-motion, coarse pointer", () => {
  assert.doesNotMatch(CONTEXT_MENU_CSS, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(CONTEXT_MENU_CSS, /\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/);
  assert.doesNotMatch(CONTEXT_MENU_CSS, /\/\//);
  assert.match(CONTEXT_MENU_CSS, /var\(--surface-2, var\(--surface, Canvas\)\)/);
  assert.match(CONTEXT_MENU_CSS, /var\(--text, CanvasText\)/);
  assert.match(CONTEXT_MENU_CSS, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(CONTEXT_MENU_CSS, /@media \(pointer: coarse\)[^}]*min-height: 2\.75rem/);
  const forced = CONTEXT_MENU_CSS.slice(CONTEXT_MENU_CSS.indexOf("@media (forced-colors: active)"));
  assert.match(forced, /\.ctx-item:hover, \.ctx-item:focus-visible \{ background-color: Highlight; color: HighlightText/);
  assert.match(forced, /GrayText/);
  assert.doesNotMatch(forced, /var\(--/, "forced-colors uses system colours only");
  for (const c of ["ctx-menu", "ctx-item", "ctx-sep"]) assert.match(CONTEXT_MENU_CSS, new RegExp(`\\.${c}\\b`));
  assert.match(CONTEXT_MENU_CSS, /\.ctx-item\[aria-disabled="true"\]/);
});
