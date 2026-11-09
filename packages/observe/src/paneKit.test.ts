import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { PANE_CSS, PANE_KIT_JS } from "./paneKit.ts";
import { LAYOUT_CSS } from "./layoutCss.ts";
import type { WindowModel } from "./menuModel.ts";

type El = {
  textContent: string;
  className: string;
  hidden: boolean;
  title?: string;
  attrs?: Record<string, string>;
  setAttribute?: (k: string, v: string) => void;
  removeAttribute?: (k: string) => void;
};
type Es = { onopen: (() => void) | null; onerror: (() => void) | null; listeners: Record<string, (ev: unknown) => void> };
const sources: Es[] = [];
class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners: Record<string, (ev: unknown) => void> = {};
  url: string;
  constructor(url: string) {
    this.url = url;
    sources.push(this);
  }
  addEventListener(name: string, fn: (ev: unknown) => void) {
    this.listeners[name] = fn;
  }
}
const load = () => {
  const ctx = createContext({ EventSource: FakeEventSource, JSON, Object, Array, Set, Map, String, Error, RegExp, Date, Math, Number, WeakSet });
  return runInContext(`(() => { ${PANE_KIT_JS}; return K; })()`, ctx) as {
    notice(el: El, kind: string, text: string): void;
    setConn(badge: El | ((ok: boolean, text: string) => void) | null, ok: boolean): void;
    stream(url: string, handlers: Record<string, (ev: unknown) => void>, badge: El | ((ok: boolean, text: string) => void) | null): unknown;
    registerView(d: Record<string, unknown>): void;
    view(id: string): { id: string; subject?: string; mount: unknown } | undefined;
    views(): { id: string; subject?: string }[];
    declareSection(d: Record<string, unknown>): void;
    sectionModel(id: string): WindowModel | undefined;
    sectionHost(id: string): { setMenuState: unknown; setStatus: unknown; onCommand(h: (c: string, a: unknown) => void): void };
  };
};
const decl = {
  id: "inbox",
  title: "Inbox",
  menus: [{ id: "view", items: [{ kind: "action", command: "inbox.refresh", label: "Refresh" }] }],
  status: [{ id: "count", title: "Count" }],
};

test("declareSection creates one persistent model; sectionModel is undefined for an undeclared id", () => {
  const P = load();
  assert.equal(P.sectionModel("inbox"), undefined);
  P.declareSection(decl);
  const m = P.sectionModel("inbox")!;
  assert.equal(m.declaration.id, "inbox");
  assert.equal(m.declaration.multi, false);
  assert.equal(P.sectionModel("inbox"), m);
});

test("declareSection and registerView keep the declared controls (a toolbar button and a search reach the model)", () => {
  const P = load();
  const controls = [
    { kind: "button", command: "tree.new", label: "New agent", primary: true },
    { kind: "search", command: "audit.agent", label: "Filter by agent", placeholder: "agent" },
  ];
  P.declareSection({ ...decl, id: "tree", title: "Tree", menus: [], status: [], controls });
  const d = P.sectionModel("tree")!.declaration as unknown as { controls: { command: string }[] };
  assert.deepEqual(
    d.controls.map((c) => c.command),
    ["tree.new", "audit.agent"],
  );
  P.registerView({ id: "thing", title: "Thing", multi: false, mount: () => ({ unmount() {} }), controls });
  const vd = (P as unknown as { declaration(id: string): { controls: { command: string }[] } }).declaration("thing");
  assert.deepEqual(
    vd.controls.map((c) => c.command),
    ["tree.new", "audit.agent"],
  );
  const none = load();
  none.declareSection(decl);
  assert.equal(
    (none.sectionModel("inbox")!.declaration as unknown as { controls: unknown[] }).controls.length,
    0,
    "no controls declared means an empty list, so layoutShell reads controls.length safely",
  );
});

test("sectionHost drives the section model: state, status and commands", () => {
  const P = load();
  P.declareSection(decl);
  const h = P.sectionHost("inbox");
  const seen: string[] = [];
  h.onCommand((c) => seen.push(c));
  P.sectionModel("inbox")!.invoke("inbox.refresh");
  assert.deepEqual(seen, ["inbox.refresh"]);
  (h.setStatus as (i: string, p: object) => void)("count", { text: "3" });
  assert.equal(P.sectionModel("inbox")!.status()[0]!.text, "3");
});

test("declareSection and sectionHost errors name cause and action", () => {
  const P = load();
  assert.throws(() => P.declareSection({ ...decl, id: "Bad Id" }), /invalid section id.*lowercase data-tab id/);
  P.declareSection(decl);
  assert.throws(() => P.declareSection(decl), /already declared; declare each section once/);
  assert.throws(() => P.declareSection({ ...decl, id: "x", menus: [{ id: "nope", items: [] }] }), /declareView/);
  assert.throws(() => P.sectionHost("zzz"), /not declared; call declareSection first/);
});

const view = (over: Record<string, unknown> = {}) => ({ id: "terminal", title: "Terminal", multi: true, mount: () => ({ unmount() {} }), ...over });

test("registerView subject: multi without subject means agent, an explicit subject is kept, a browsing view has none", () => {
  const P = load();
  P.registerView(view());
  P.registerView(view({ id: "report", title: "Report", subject: "report" }));
  P.registerView(view({ id: "browser", title: "Browser", subject: "agent" }));
  P.registerView(view({ id: "audit", title: "Audit", multi: false }));
  assert.equal(P.view("terminal")!.subject, "agent");
  assert.equal(P.view("report")!.subject, "report");
  assert.equal(P.view("browser")!.subject, "agent");
  assert.equal(P.view("audit")!.subject, undefined);
  assert.equal(
    P.views()
      .map((v) => v.subject ?? "none")
      .join(","),
    "agent,report,agent,none",
  );
  assert.equal(typeof P.view("terminal")!.mount, "function", "mount survives the normalised copy");
});

test("registerView refuses an unknown subject and a subject on a browsing view, naming cause and action", () => {
  const P = load();
  assert.throws(() => P.registerView(view({ subject: "file" })), /subject "file"; use agent or report/);
  assert.throws(() => P.registerView(view({ multi: false, subject: "agent" })), /has a subject but multi is false; an item view needs multi: true/);
  assert.equal(P.view("terminal"), undefined, "nothing was registered");
});

const rule = (css: string, selector: string) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n|, )${esc}(?:, [^{]+)? \\{([^}]*)\\}`).exec(css)?.[1];
};

test("K.notice sets text and class, and hides when the text is empty", () => {
  const P = load();
  const el: El = { textContent: "", className: "", hidden: false };
  P.notice(el, "err", "boom");
  assert.equal(`${el.className}|${el.textContent}|${el.hidden}`, "pane-notice err|boom|false");
  P.notice(el, "meta", "fine");
  assert.equal(`${el.className}|${el.textContent}|${el.hidden}`, "pane-notice meta|fine|false");
  P.notice(el, "err", "");
  assert.equal(`${el.className}|${el.textContent}|${el.hidden}`, "pane-notice err||true");
  P.notice(el, "meta", "back");
  assert.equal(el.hidden, false, "text unhides it again");
});

test("K.notice mirrors the full text into the title attribute and clears it when empty", () => {
  const P = load();
  const attrs: Record<string, string> = {};
  const el: El = {
    textContent: "",
    className: "",
    hidden: false,
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    removeAttribute: (k) => {
      delete attrs[k];
    },
  };
  const long = "x".repeat(400);
  P.notice(el, "err", long);
  assert.equal(`${attrs.title === long}|${el.textContent === long}|${el.hidden}`, "true|true|false");
  P.notice(el, "err", "");
  assert.equal(`${"title" in attrs}|${el.hidden}`, "false|true");
});

test("setConn and stream: an element badge keeps its text and class; a function badge gets (ok, text)", () => {
  const P = load();
  const el = { textContent: "", className: "" };
  P.setConn(el as El, true);
  assert.equal(`${el.className}|${el.textContent}`, "conn ok|connected");
  P.setConn(el as El, false);
  assert.equal(`${el.className}|${el.textContent}`, "conn stale|stale");
  const calls: string[] = [];
  P.setConn((ok, text) => calls.push(`${ok}:${text}`), true);
  assert.deepEqual(calls, ["true:connected"]);
  const seen: string[] = [];
  const hits: string[] = [];
  P.stream("/x", { ping: () => hits.push("ping") }, (ok, text) => seen.push(`${ok}:${text}`));
  const es = sources[sources.length - 1]!;
  assert.deepEqual(seen, ["false:connecting"]);
  es.onopen?.();
  es.onerror?.();
  es.listeners.ping!({});
  assert.deepEqual(seen, ["false:connecting", "true:connected", "false:stale", "true:connected"]);
  assert.deepEqual(hits, ["ping"]);
  const el2 = { textContent: "", className: "" };
  P.stream("/y", {}, el2 as El);
  assert.equal(el2.textContent, "connecting", "element badge still shows connecting first");
  assert.equal(el2.className, "conn stale");
});

test("PANE_CSS tokens are scoped on .pane with the contract values", () => {
  const t = rule(PANE_CSS, ".pane")!;
  for (const d of ["--pane-inset: 0.75rem", "--pane-gap: 0.5rem", "--cell-y: 0.3125rem", "--cell-x: 0.75rem"]) assert.ok(t.includes(d), d);
});

test("PANE_CSS: a tile pane fills, has no padding and no child margin rule; the one scroller is .pane-body", () => {
  const p = rule(PANE_CSS, ".pane")!;
  for (const d of ["display: flex", "flex-direction: column", "height: 100%", "min-height: 0", "padding: 0"]) assert.ok(p.includes(d), d);
  assert.doesNotMatch(PANE_CSS, /^\.pane > \* \+ \*/m);
  const b = rule(PANE_CSS, ".pane-body")!;
  for (const d of ["flex: 1 1 auto", "min-height: 0", "overflow: auto"]) assert.ok(b.includes(d), d);
});

test("PANE_CSS: tablewrap.pane-body is bezel-less with a sticky header; only one body:not(.wm) override restores the card", () => {
  const w = rule(PANE_CSS, ".pane .tablewrap.pane-body")!;
  assert.ok(w, "tablewrap.pane-body rule");
  assert.doesNotMatch(w, /border:|border-radius|box-shadow/);
  const th = rule(PANE_CSS, ".pane .tablewrap th")!;
  for (const d of ["position: sticky", "top: 0", "background: var(--surface-2)", "border-bottom"]) assert.ok(th.includes(d), d);
  const base = rule(PANE_CSS, ".pane .tablewrap")!;
  assert.doesNotMatch(base, /border:|border-radius|box-shadow/, "the card look is not the default");
  assert.equal(PANE_CSS.split("body:not(.wm) .pane .tablewrap").length - 1, 1, "single override block");
  const card = rule(PANE_CSS, "body:not(.wm) .pane .tablewrap")!;
  for (const d of ["border: 1px solid", "border-radius", "box-shadow"]) assert.ok(card.includes(d), d);
});

test("PANE_CSS: notice, empty paragraph, card list with tones, form and row grid", () => {
  const n = rule(PANE_CSS, ".pane-notice")!;
  assert.ok(!n.includes("nowrap") && !n.includes("ellipsis"), "wraps");
  assert.ok(n.includes("overflow-wrap: anywhere") && n.includes("max-height: 4.5rem") && n.includes("overflow: auto"), "bounded height, scrolls");
  assert.ok(rule(PANE_CSS, ".pane-notice:empty")!.includes("display: none"));
  assert.ok(rule(PANE_CSS, ".pane-notice.err")!.includes("var(--err)"));
  assert.ok(rule(PANE_CSS, ".pane-notice.meta")!.includes("var(--muted)"));
  assert.ok(rule(PANE_CSS, ".pane-empty")!.includes("var(--muted)"));
  const l = rule(PANE_CSS, "ul.card-list.pane-body")!;
  for (const d of ["display: grid", "gap: var(--pane-gap)", "padding: var(--pane-inset)"]) assert.ok(l.includes(d), d);
  assert.ok(rule(PANE_CSS, "ul.card-list > li")!.includes("border-left"), "card style");
  for (const [tone, v] of [
    ["warn", "--warn"],
    ["err", "--err"],
    ["info", "--info"],
  ]) {
    const r = rule(PANE_CSS, `ul.card-list > li.tone-${tone}`)!;
    assert.ok(r.includes("3px solid") && r.includes(`var(${v})`), tone);
  }
  assert.ok(rule(PANE_CSS, ".pane-form")!.includes("padding: var(--pane-inset)"));
  assert.match(PANE_CSS, /@container tile \(min-width: 40rem\) \{[^}]*\.pane-form \.row[^}]*grid-template-columns: 1fr 1fr/);
  assert.match(PANE_CSS, /\.pane-form textarea \{[^}]*flex: 1 1 auto/);
  assert.match(PANE_CSS, /\.pane button, \.pane a\.btn \{[^}]*padding: 0\.125rem 0\.5rem/);
  assert.match(PANE_CSS, /@media \(pointer: coarse\) \{[^}]*min-height: 2\.5rem/);
});

test("PANE_CSS: orphan span.state rules are gone; .conn and the s-* rules stay; no legacy block remains", () => {
  assert.doesNotMatch(PANE_CSS, /span\.state/);
  for (const k of [".pane .conn.ok", ".pane .conn.stale", ".pane tr.s-running td.state", ".pane td.state.live::before"]) assert.ok(PANE_CSS.includes(k), k);
  assert.ok(!PANE_CSS.includes("legacy"));
  for (const k of ["#escalations", "hosts-status", ".pane.newagent", ".filters", ".report-banner", ".report-actions", ".pane h3", "p.empty"])
    assert.ok(!PANE_CSS.includes(k), `removed: ${k}`);
});

test("PANE_CSS: the generic form rules absorb the new-agent form (inline checkbox, summary, buttons paragraph)", () => {
  assert.match(PANE_CSS, /\.pane-form input\[type=checkbox\] \{[^}]*display: inline-block; width: auto/);
  assert.match(PANE_CSS, /\.pane-form summary \{[^}]*cursor: pointer/);
  assert.match(PANE_CSS, /\.pane-form p \{[^}]*margin: 0/);
});

test("PANE_CSS: inbox rules (badge, highlight, actions, sticky compose) live in the shared CSS", () => {
  assert.ok(rule(PANE_CSS, ".inbox li.hl")!.includes("outline: 2px solid var(--accent)"));
  const badge = rule(PANE_CSS, ".inbox .badge")!;
  for (const d of ["border-radius: 999px", "text-transform: uppercase"]) assert.ok(badge.includes(d), d);
  assert.ok(rule(PANE_CSS, ".inbox .subject")!.includes("white-space: pre-wrap"));
  assert.ok(rule(PANE_CSS, ".inbox .actions.big button")!.includes("min-height: 3rem"));
  const compose = rule(PANE_CSS, ".inbox li.compose")!;
  assert.ok(compose.includes("position: sticky") && compose.includes("top: 0"));
  assert.match(PANE_CSS, /\.inbox \.compose form \{[^}]*display: flex; flex-wrap: wrap/);
  assert.ok(rule(PANE_CSS, ".inbox .compose textarea")!.includes("flex: 3 1 14rem"));
  assert.ok(rule(PANE_CSS, ".pane-notice[hidden]")!.includes("display: none"));
});

test("PANE_CSS: the answer row of any card is generic (.card-list .actions), not tied to one pane id", () => {
  assert.ok(rule(PANE_CSS, "ul.card-list .actions")!.includes("display: flex"));
  assert.ok(rule(PANE_CSS, "ul.card-list .actions input")!.includes("flex: 1 1 12rem"));
});

test("PANE_CSS: report item window classes fill and scroll the body, inset only the inner content", () => {
  const body = rule(PANE_CSS, ".report-body")!;
  for (const d of ["flex: 1", "min-height: 0", "display: flex", "flex-direction: column", "overflow: auto"]) assert.ok(body.includes(d), d);
  assert.doesNotMatch(body, /padding/);
  assert.ok(rule(PANE_CSS, ".report-body .md, .report-body pre")!.includes("padding: var(--pane-inset)"));
  const frame = rule(PANE_CSS, ".report-frame")!;
  for (const d of ["flex: 0 0 100%", "width: 100%", "height: 100%", "border: 0", "background: #fff"]) assert.ok(frame.includes(d), d);
  const img = rule(PANE_CSS, ".report-img")!;
  for (const d of ["flex: 0 0 100%", "min-height: 0", "object-fit: contain"]) assert.ok(img.includes(d), d);
});

test("LAYOUT_CSS: section padding is zero, no generic pane padding, controls survive the narrow hide-lists", () => {
  assert.ok(rule(LAYOUT_CSS, ".tile-body > section")!.includes("padding: 0"));
  assert.doesNotMatch(LAYOUT_CSS, /\.wm-mount \.pane:not\(\.pane-fill\)/);
  assert.doesNotMatch(LAYOUT_CSS, /\.wm-mount \.pane button/);
  assert.doesNotMatch(LAYOUT_CSS, /\.pane-fill[^{]*> \* \+ \*/);
  const hides = LAYOUT_CSS.match(/:not\(\.tile-menus\)[^{]*/g) ?? [];
  assert.equal(hides.length, 2);
  for (const h of hides) assert.ok(h.includes(":not(.tile-controls)"), h);
  const has = LAYOUT_CSS.match(/:has\([^)]*\)/g) ?? [];
  assert.equal(has.length, 2);
  for (const h of has) assert.ok(h.includes(".tile-controls"), h);
  assert.equal(LAYOUT_CSS.split(".tile-bar > .tile-overflow { margin-left: auto; }").length - 1, 2);
});

test("PANE_CSS: header cells are uppercase by CSS (one look for every table), and a lone field in a form row spans the full width", () => {
  assert.match(PANE_CSS, /\n\.pane th \{[^}]*text-transform: uppercase/);
  assert.match(PANE_CSS, /\.pane-form \.row > :only-child \{[^}]*grid-column: 1 \/ -1/);
});

test("emitted CSS has no // comment lines and the inbox highlight rule parses as its own rule", async () => {
  const mods = await Promise.all([
    import("./traceKit.ts"),
    import("./layoutCss.ts"),
    import("./themeCss.ts"),
    import("./chromeCss.ts"),
    import("./launcherShell.ts"),
    import("./termKit.ts"),
    import("./mdKit.ts"),
    import("./shell.ts"),
  ]);
  const sheets: [string, string][] = [["PANE_CSS", PANE_CSS]];
  for (const m of mods) for (const [k, v] of Object.entries(m)) if (/(CSS|Css)$/.test(k) && typeof v === "string") sheets.push([k, v]);
  assert.ok(sheets.length >= 9, "found the CSS constants: " + sheets.map((s) => s[0]).join());
  for (const [name, css] of sheets) {
    const bad = css.split("\n").filter((l) => l.trim().startsWith("//"));
    assert.deepEqual(bad, [], name + " has // lines, which CSS treats as part of the next selector");
  }
  // Same rule split as paneSkeleton.test.ts parseRules: strip /* */ comments, then prelude { body }.
  const rules = [...PANE_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]!.split(",").map((x) => x.trim().replace(/\s+/g, " ")),
    body: m[2]!,
  }));
  const hl = rules.filter((r) => r.selectors.includes(".inbox li.hl"));
  assert.equal(hl.length, 1);
  assert.ok(hl[0]!.body.includes("outline"));
});

// ---- stale-content overlay (K.staleOverlay) ----------------------------------------------------------------------

type OvNode = {
  tagName: string;
  className: string;
  textContent: string;
  hidden: boolean;
  attrs: Map<string, string>;
  children: OvNode[];
  setAttribute(k: string, v: string): void;
  appendChild(c: OvNode): void;
};
const ovNode = (tagName: string): OvNode => {
  const n: OvNode = {
    tagName,
    className: "",
    textContent: "",
    hidden: false,
    attrs: new Map(),
    children: [],
    setAttribute: (k, v) => void n.attrs.set(k, v),
    appendChild: (c) => void n.children.push(c),
  };
  return n;
};
const loadOverlay = () => {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const ctx = createContext({
    document: { createElement: ovNode },
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms, cleared: false }),
    clearTimeout: (n: number) => {
      timers[n - 1]!.cleared = true;
    },
    JSON,
    Object,
    Array,
    Set,
    Map,
    String,
    Error,
    RegExp,
    Date,
    Math,
    Number,
    WeakSet,
  });
  const K = runInContext(`(() => { ${PANE_KIT_JS}; return K; })()`, ctx) as {
    STALE_GRACE_MS: number;
    overlayPlan(painted: string, kind: string, hasContent: boolean): string;
    staleOverlay(parent: OvNode, hasContent: () => boolean): { set(kind: string, text: string): void; kind(): string; destroy(): void };
  };
  return { K, timers };
};
const shape = (parent: OvNode) => {
  const box = parent.children[0]!;
  return {
    hidden: box.hidden,
    cls: box.className,
    icon: box.children[0]!.className,
    glyph: box.children[0]!.textContent,
    label: box.children[1]!.textContent,
    role: box.attrs.get("role"),
    live: box.attrs.get("aria-live"),
  };
};

test("overlayPlan: busy over existing content waits the grace delay; everything else is immediate; none hides", () => {
  const { K } = loadOverlay();
  assert.equal(K.STALE_GRACE_MS, 800);
  assert.equal(K.overlayPlan("none", "busy", true), "later");
  assert.equal(K.overlayPlan("none", "busy", false), "now");
  assert.equal(K.overlayPlan("busy", "busy", true), "now");
  assert.equal(K.overlayPlan("dead", "busy", true), "now");
  assert.equal(K.overlayPlan("none", "dead", true), "now");
  assert.equal(K.overlayPlan("none", "idle", true), "now");
  assert.equal(K.overlayPlan("busy", "none", true), "hide");
});

test("staleOverlay: one persistent status element; spinner for busy, danger icon for dead, pause for idle; hidden for none", () => {
  const { K, timers } = loadOverlay();
  const parent = ovNode("div");
  parent.className = "pane";
  let content = false;
  const ov = K.staleOverlay(parent, () => content);
  assert.equal(parent.className, "pane stale-host");
  assert.deepEqual(shape(parent), { hidden: true, cls: "stale-overlay", icon: "", glyph: "", label: "", role: "status", live: "polite" });
  ov.set("busy", "Connecting\u2026");
  assert.deepEqual(shape(parent), {
    hidden: false,
    cls: "stale-overlay stale-busy",
    icon: "stale-icon stale-spinner",
    glyph: "",
    label: "Connecting\u2026",
    role: "status",
    live: "polite",
  });
  assert.equal(timers.length, 0, "no content to keep: no grace timer");
  ov.set("dead", "Disconnected: ended");
  assert.deepEqual(shape(parent), {
    hidden: false,
    cls: "stale-overlay stale-dead",
    icon: "stale-icon",
    glyph: "\u26a0",
    label: "Disconnected: ended",
    role: "status",
    live: "polite",
  });
  ov.set("idle", "waiting");
  assert.equal(shape(parent).cls, "stale-overlay stale-idle");
  ov.set("none", "");
  assert.equal(shape(parent).hidden, true);
  assert.equal(parent.children.length, 1, "the same element is reused");
  content = true;
  assert.throws(() => ov.set("sad", "x"), /unknown kind "sad".*use one of/);
});

test("staleOverlay: with content, busy appears only after the grace delay and a quick none cancels it (negative control: it fires if left alone)", () => {
  const { K, timers } = loadOverlay();
  const parent = ovNode("div");
  const ov = K.staleOverlay(parent, () => true);
  ov.set("busy", "Reconnecting\u2026");
  assert.equal(shape(parent).hidden, true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.ms, 800);
  ov.set("none", "");
  assert.equal(timers[0]!.cleared, true);
  ov.set("busy", "Reconnecting\u2026");
  timers[1]!.fn();
  assert.equal(shape(parent).hidden, false);
  assert.equal(shape(parent).label, "Reconnecting\u2026");
  // already painted: a relabel is immediate (no flicker back to hidden)
  ov.set("busy", "Restoring screen\u2026");
  assert.equal(shape(parent).label, "Restoring screen\u2026");
  ov.set("none", "");
  ov.set("busy", "again");
  ov.destroy();
  assert.equal(timers[timers.length - 1]!.cleared, true);
  assert.equal(shape(parent).hidden, true);
});

test("overlay CSS: semi-transparent, never takes the pointer, spinner honours prefers-reduced-motion, and the helper uses no innerHTML", () => {
  const rule = (sel: string) => new RegExp("\\n" + sel.replace(/[.[\]]/g, "\\$&") + " \\{([^}]*)\\}").exec(PANE_CSS)?.[1] ?? "";
  assert.match(rule(".stale-overlay"), /pointer-events: none/);
  assert.match(rule(".stale-overlay"), /color-mix\(in srgb, var\(--surface\) 72%, transparent\)/);
  assert.match(rule(".stale-overlay"), /position: absolute/);
  assert.match(rule(".stale-overlay[hidden]"), /display: none/);
  assert.match(rule(".stale-spinner"), /animation: stalespin/);
  assert.match(PANE_CSS, /@media \(prefers-reduced-motion: reduce\) \{ \.stale-spinner \{ animation: none; \} \}/);
  assert.ok(!/innerHTML/.test(PANE_KIT_JS));
});
