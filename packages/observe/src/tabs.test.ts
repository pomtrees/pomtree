import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext, type Context } from "node:vm";
import { renderAuditPane, renderEscalationsPane, renderHostsPane, renderSchedulesPane, renderTerminalPane } from "./tabs.ts";
import { NEW_AGENT_LOGIC_JS, renderNewAgentPane } from "./newAgent.ts";
import { PANE_KIT_JS } from "./paneKit.ts";
import { renderShell } from "./shell.ts";
import { renderReportsPane, renderTreePane } from "./web.ts";

test("audit pane is fully inline, fetches the journal path, and has filter and more controls", () => {
  const html = renderAuditPane();
  assert.ok(html.includes('K.getJson("/v1/journal"'));
  assert.ok(html.includes('id="agent-filter"'));
  assert.ok(html.includes('id="kind-filter"'));
  assert.ok(html.includes('id="more"'));
  assert.ok(html.includes("<th>TS</th><th>AGENT</th><th>KIND</th><th>SUMMARY</th>"));
  assert.ok(html.includes('id="audit-rows"'));
  assert.ok(html.includes("textContent")); // rows render via textContent, never innerHTML
  assert.ok(!html.includes("innerHTML"));
  assert.ok(!html.includes("src=")); // no external script or stylesheet, no build step
  const custom = renderAuditPane({ journalPath: "/journal/audit" });
  assert.ok(custom.includes('K.getJson("/journal/audit"'));
});

test("audit pane journal path is JSON-escaped and cannot close the script", () => {
  const html = renderAuditPane({ journalPath: "</script><script>alert(1)</script>\u2028" });
  assert.equal(html.match(/<\/script>/g)!.length, 1);
  assert.ok(!html.includes("\u2028"));
  assert.ok(html.includes('K.getJson("\\u003c/script>'));
});

test("escalations pane is fully inline, fetches open escalations, and answers via the operator route", () => {
  const html = renderEscalationsPane();
  assert.ok(html.includes('K.getJson("/v1/escalations"'));
  assert.ok(html.includes("?state=open"));
  assert.ok(html.includes('"/answer"'));
  assert.ok(html.includes("encodeURIComponent(id)"));
  assert.ok(html.includes("JSON.stringify({ body, idempotencyKey"));
  assert.ok(!html.includes("{ answer:"));
  assert.ok(!html.includes("replyTo"));
  assert.ok(!html.includes('"/v1/messages"'));
  assert.ok(html.includes('id="escalations"'));
  assert.ok(html.includes("question"));
  assert.ok(html.includes("options"));
  assert.ok(html.includes("createdAt"));
  assert.ok(html.includes("textContent")); // question/options/age render via textContent, never innerHTML
  assert.ok(!html.includes("innerHTML"));
  assert.ok(!html.includes("src="));
  const custom = renderEscalationsPane({ escalationsPath: "/v2/escalations", answerPath: "/v2/escalations" });
  assert.ok(custom.includes('K.getJson("/v2/escalations"'));
  assert.ok(custom.includes('"/answer"'));
});

test("escalations pane paths are JSON-escaped and cannot close the script", () => {
  const html = renderEscalationsPane({
    escalationsPath: "</script><script>alert(1)</script>\u2028",
    answerPath: "</script><script>alert(2)</script>\u2029",
  });
  assert.equal(html.match(/<\/script>/g)!.length, 1);
  assert.ok(!html.includes("\u2028"));
  assert.ok(!html.includes("\u2029"));
  assert.ok(html.includes("\\u003c/script>"));
});

// --- vm execution regression --------------------------------------------------
// The panes ship as classic browser <script> tags: a top-level `const` in one
// script is visible to (and collides with) the next in the same document.
// node:vm reproduces that scoping, so we render a real shell and run every pane's
// script in one shared context; a duplicate top-level `const` throws SyntaxError.

type Listener = (ev: unknown) => void;

interface FakeNode {
  tagName: string;
  id: string;
  children: FakeNode[];
  textContent: string;
  className: string;
  hidden: boolean;
  colSpan: number;
  href: string;
  placeholder: string;
  value: string;
  style: Record<string, string>;
  attrs: Map<string, string>;
  listeners: Map<string, Listener[]>;
  appendChild(child: FakeNode): void;
  insertBefore(child: FakeNode, ref: FakeNode | null): void;
  remove(): void;
  parent: FakeNode | null;
  nextSibling: FakeNode | null;
  firstChild: FakeNode | null;
  open: boolean;
  readyState: number;
  replaceChildren(...nodes: FakeNode[]): void;
  addEventListener(type: string, fn: Listener): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  disabled: boolean;
  checked?: boolean;
  focused?: number;
  focus(): void;
  scrollTop: number;
  classList: { toggle(name: string, force?: boolean): void };
  fragment?: boolean;
  querySelector(selector: string): FakeNode | null;
}

// Selectors the panes use: tag?[attr="value"].
function matches(node: FakeNode, selector: string): boolean {
  const m = /^([a-z]+)?\[([\w-]+)="([^"]*)"\]$/.exec(selector);
  if (!m) throw new Error(`fake DOM: unsupported selector ${selector}`);
  return (!m[1] || node.tagName === m[1]) && node.attrs.get(m[2]!) === m[3];
}

const VOID_TAGS = new Set(["input", "br", "img"]);
// Parses the terminal template markup (tags, quoted or boolean attributes, text) into a fragment of fake nodes.
function parseHtml(html: string): FakeNode {
  const frag = fakeNode();
  frag.fragment = true;
  const stack: FakeNode[] = [frag];
  const re = /<(\/?)([a-zA-Z0-9]+)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*>|([^<]+)/g;
  for (const m of html.matchAll(re)) {
    const top = stack[stack.length - 1]!;
    if (m[4] !== undefined) {
      if (m[4].trim() !== "") top.textContent += m[4];
    } else if (m[1]) {
      stack.pop();
    } else {
      const el = fakeNode();
      el.tagName = m[2]!;
      for (const a of m[3]!.matchAll(/([^\s=>]+)(?:="([^"]*)")?/g)) {
        const [, name, value] = a;
        if (name === "id") el.id = value ?? "";
        else if (name === "class") el.className = value ?? "";
        else if (name === "hidden") el.hidden = true;
        else el.setAttribute(name!, value ?? "");
      }
      top.appendChild(el);
      if (!VOID_TAGS.has(el.tagName)) stack.push(el);
    }
  }
  return frag;
}

function fakeNode(id = ""): FakeNode {
  const node: FakeNode = {
    tagName: "div",
    id,
    children: [],
    textContent: "",
    className: "",
    hidden: false,
    colSpan: 0,
    href: "",
    placeholder: "",
    value: "",
    style: {},
    disabled: false,
    scrollTop: 0,
    focus() {
      node.focused = (node.focused ?? 0) + 1;
    },
    attrs: new Map(),
    listeners: new Map(),
    parent: null,
    open: false,
    readyState: 1,
    get nextSibling() {
      const p = node.parent;
      return p ? (p.children[p.children.indexOf(node) + 1] ?? null) : null;
    },
    get firstChild() {
      return node.children[0] ?? null;
    },
    appendChild(child) {
      if (child.fragment) {
        for (const c of child.children.splice(0)) node.appendChild(c);
        return;
      }
      child.parent = node;
      node.children.push(child);
    },
    querySelector(selector) {
      for (const c of node.children) {
        if (matches(c, selector)) return c;
        const deep = c.querySelector(selector);
        if (deep) return deep;
      }
      return null;
    },
    insertBefore(child, ref) {
      child.parent = node;
      const i = ref ? node.children.indexOf(ref) : -1;
      if (i < 0) node.children.push(child);
      else node.children.splice(i, 0, child);
    },
    remove() {
      const p = node.parent;
      if (p) p.children.splice(p.children.indexOf(node), 1);
      node.parent = null;
    },
    replaceChildren(...nodes) {
      node.children = nodes;
      for (const n of nodes) n.parent = node;
    },
    addEventListener(type, fn) {
      const list = node.listeners.get(type) ?? [];
      list.push(fn);
      node.listeners.set(type, list);
    },
    getAttribute(name) {
      return node.attrs.get(name) ?? null;
    },
    setAttribute(name, value) {
      node.attrs.set(name, value);
    },
    classList: {
      toggle(name, force) {
        node.className = force === undefined ? (node.className === name ? "" : name) : force ? name : "";
      },
    },
  };
  return node;
}

interface FakeDoc {
  byId: Map<string, FakeNode>;
  sections: FakeNode[];
  navs: FakeNode[];
  getElementById(id: string): FakeNode | null;
  createElement(tag: string): FakeNode;
  createTextNode(text: string): FakeNode;
  querySelectorAll(selector: string): FakeNode[];
}

function fakeDocument(tabIds: readonly string[]): FakeDoc {
  const byId = new Map<string, FakeNode>();
  const getElementById = (id: string): FakeNode | null => {
    let node = byId.get(id);
    if (!node) {
      node = fakeNode(id);
      byId.set(id, node);
    }
    return node;
  };
  const createTextNode = (text: string): FakeNode => {
    const n = fakeNode();
    n.tagName = "#text";
    n.textContent = text;
    return n;
  };
  const createElement = (tag: string): FakeNode => {
    const node = fakeNode();
    node.tagName = tag;
    return node;
  };
  const sections = tabIds.map((id) => {
    const s = fakeNode();
    s.tagName = "section";
    s.hidden = true; // the markup ships every section hidden; the tiling shell un-hides the ones it hosts
    s.setAttribute("data-tab", id);
    return s;
  });
  const navs = tabIds.map((id) => {
    const a = fakeNode();
    a.setAttribute("data-nav", id);
    return a;
  });
  const querySelectorAll = (selector: string): FakeNode[] => {
    if (selector === "section[data-tab]") return sections;
    if (selector === "nav a[data-nav]") return navs;
    return [];
  };
  return { byId, sections, navs, getElementById, createElement, createTextNode, querySelectorAll };
}

type Json = unknown;
interface FakeSocket {
  url: string;
  readyState: number;
  binaryType: string;
  sent: unknown[];
  closed: boolean;
  open(): void;
  drop(): void;
  onmessage?: (ev: { data: unknown }) => void;
}
interface FakeTerm {
  cols: number;
  rows: number;
  options: Record<string, unknown>;
  writes: Uint8Array[];
  resets: number;
  focused: number;
  disposed: boolean;
  handlers: Record<string, (x: unknown) => void>;
  keyHandler?: (ev: unknown) => boolean;
  selection: string;
  host?: FakeNode;
}
interface Es {
  url: string;
  closed: boolean;
  readyState?: number;
  handlers: Map<string, Listener>;
  onerror?: () => void;
  onopen?: () => void;
}

function runShell(
  hash: string,
  responses: Record<string, { ok?: boolean; status?: number; body: Json; fail?: boolean }> = {},
  clock?: () => number,
  store: Record<string, string> = {},
) {
  const tabIds = ["tree", "reports", "audit", "hosts", "schedules", "terminal", "escalations", "new"];
  const tabs = [
    { id: "tree", title: "Tree", render: () => renderTreePane({ eventsPath: "/live/events" }) },
    { id: "reports", title: "Reports", render: () => renderReportsPane() },
    { id: "audit", title: "Audit", render: () => renderAuditPane() },
    { id: "hosts", title: "Hosts", render: () => renderHostsPane() },
    { id: "schedules", title: "Schedules", render: () => renderSchedulesPane() },
    { id: "terminal", title: "Terminal", render: () => renderTerminalPane() },
    { id: "escalations", title: "Escalations", render: () => renderEscalationsPane() },
    { id: "new", title: "New agent", render: () => renderNewAgentPane() },
  ];
  const html = renderShell({ tabs, prefix: "/", title: "observe" });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);

  const doc = fakeDocument(tabIds);
  const pageBody = fakeNode();
  const docKeys: Listener[] = [];
  const es: Es[] = [];
  const fetches: { url: string; init?: { method?: string; body?: string } }[] = [];
  const intervals: { fn: () => void; cleared: boolean; ms?: number }[] = [];
  const hashListeners: Listener[] = [];
  const resizeListeners: Listener[] = [];
  class EventSource {
    url: string;
    closed = false;
    handlers = new Map<string, Listener>();
    onerror?: () => void;
    onopen?: () => void;
    constructor(url: string) {
      this.url = url;
      es.push(this);
    }
    addEventListener(name: string, fn: Listener) {
      this.handlers.set(name, fn);
    }
    close() {
      this.closed = true;
    }
  }
  const reloads = { count: 0 };
  const location = {
    hash,
    protocol: "http:",
    host: "ui.test",
    reload() {
      reloads.count++;
    },
  };
  const sockets: FakeSocket[] = [];
  class WebSocket {
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
  }
  const terms: FakeTerm[] = [];
  class Terminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    writes: Uint8Array[] = [];
    resets = 0;
    focused = 0;
    disposed = false;
    handlers: Record<string, (x: unknown) => void> = {};
    keyHandler?: (ev: unknown) => boolean;
    selection = "";
    constructor(opts: Record<string, unknown>) {
      this.options = opts;
      terms.push(this);
    }
    loadAddon(addon: { term?: unknown }) {
      addon.term = this;
    }
    host?: FakeNode;
    open(el: FakeNode) {
      this.host = el;
    }
    reset() {
      this.resets++;
    }
    focus() {
      this.focused++;
    }
    dispose() {
      this.disposed = true;
    }
    write(b: Uint8Array) {
      this.writes.push(b);
    }
    resize(c: number, r: number) {
      this.cols = c;
      this.rows = r;
    }
    hasSelection() {
      return this.selection !== "";
    }
    getSelection() {
      return this.selection;
    }
    attachCustomKeyEventHandler(fn: (ev: unknown) => boolean) {
      this.keyHandler = fn;
    }
    onData(fn: (x: unknown) => void) {
      this.handlers.data = fn;
    }
    onBinary(fn: (x: unknown) => void) {
      this.handlers.binary = fn;
    }
    onScroll(fn: (x: unknown) => void) {
      this.handlers.scroll = fn;
    }
    buffer = { active: { viewportY: 0, baseY: 0 } };
    modes = { applicationCursorKeysMode: false };
    paste() {}
    scrollToBottom() {}
  }
  const fitDims = { cols: 100, rows: 30 };
  const FitAddon = {
    FitAddon: class {
      term?: FakeTerm;
      fit() {
        const t = this.term ?? terms[terms.length - 1]!;
        t.cols = fitDims.cols;
        t.rows = fitDims.rows;
      }
    },
  };
  const timeouts: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const headNodes: FakeNode[] = [];
  const observers: { cb: () => void; observed: unknown[]; disconnected: boolean }[] = [];
  class ResizeObserver {
    rec: (typeof observers)[number];
    constructor(cb: () => void) {
      this.rec = { cb, observed: [], disconnected: false };
      observers.push(this.rec);
    }
    observe(el: unknown) {
      this.rec.observed.push(el);
    }
    disconnect() {
      this.rec.disconnected = true;
    }
  }
  // The terminal pane ships its markup as a <template>; document.querySelector hands out a clone source for it.
  const templateHtml = /<template data-view-template="terminal">([\s\S]*?)<\/template>/.exec(html)![1]!;
  const templateNode = Object.assign(fakeNode(), { tagName: "template", content: { cloneNode: () => parseHtml(templateHtml) } });
  templateNode.setAttribute("data-view-template", "terminal");
  // matchMedia fake: change listeners per query, so tests can assert a view removed the ones it added.
  const mqListeners = new Map<string, Set<Listener>>();
  const matchMedia = (query: string) => {
    const set = mqListeners.get(query) ?? new Set<Listener>();
    mqListeners.set(query, set);
    return { matches: false, addEventListener: (_t: string, fn: Listener) => set.add(fn), removeEventListener: (_t: string, fn: Listener) => set.delete(fn) };
  };
  const sandbox: Context = {
    matchMedia,
    document: {
      body: pageBody,
      head: { appendChild: (n: FakeNode) => headNodes.push(n) },
      addEventListener: (type: string, fn: Listener, capture?: boolean) => {
        if (type === "keydown" && !capture) docKeys.push(fn); // docKeys tracks the views' listeners, not the shell's capture-phase focus chord
      },
      removeEventListener: (type: string, fn: Listener) => {
        const i = docKeys.indexOf(fn);
        if (type === "keydown" && i >= 0) docKeys.splice(i, 1);
      },
      getElementById: doc.getElementById,
      querySelector: (selector: string): unknown => {
        if (matches(templateNode, selector)) return templateNode;
        const sec = doc.sections.find((s) => matches(s, selector));
        return sec ?? null;
      },
      createElement: doc.createElement,
      createTextNode: doc.createTextNode,
      querySelectorAll: doc.querySelectorAll,
    },
    location,
    history: {
      replaceState: (_s: unknown, _t: string, url: string) => {
        location.hash = url;
      },
    },
    navigator: { clipboard: { writeText: async () => {} } },
    Blob,
    URL,
    localStorage: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    },
    EventSource,
    WebSocket,
    ResizeObserver,
    Terminal,
    FitAddon,
    TextEncoder,
    Uint8Array,
    requestAnimationFrame: () => 1, // the shell's post-layout fit is covered in layoutShell.test.ts; here it must not add timers
    setTimeout: (fn: () => void, ms: number) => {
      timeouts.push({ fn, ms, cleared: false });
      return timeouts.length;
    },
    clearTimeout: (n: number) => {
      if (timeouts[n - 1]) timeouts[n - 1]!.cleared = true;
    },
    fetch: (url: string, init?: { method?: string; body?: string }) => {
      fetches.push({ url, init });
      const r = responses[url.split("?")[0]!] ?? { body: [] };
      if (r.fail) return Promise.reject(new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:1"));
      const status = r.status ?? 200;
      return Promise.resolve({ ok: r.ok ?? status < 400, status, json: async () => r.body, text: async () => String(r.body), headers: { get: () => null } });
    },
    URLSearchParams,
    decodeURIComponent,
    encodeURIComponent,
    JSON,
    Date: clock
      ? class extends Date {
          static override now() {
            return clock();
          }
        }
      : Date,
    Object,
    Set,
    Promise,
    Math,
    setInterval: (fn: () => void, ms?: number) => {
      intervals.push({ fn, cleared: false, ms });
      return intervals.length;
    },
    clearInterval: (n: number) => {
      intervals[n - 1]!.cleared = true;
    },
    addEventListener: (type: string, fn: Listener) => {
      if (type === "hashchange") hashListeners.push(fn);
      else if (type === "resize") resizeListeners.push(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      if (type === "resize") {
        const i = resizeListeners.indexOf(fn);
        if (i >= 0) resizeListeners.splice(i, 1);
      }
    },
  };
  const context = createContext(sandbox);
  // The launcher bar script polls the API and has its own DOM fake tests (launcherShell); the pane harness leaves it out.
  for (const src of scripts) if (!src.includes("createLauncherBar(")) runInContext(src, context, { filename: "inline.js" });
  const resize = () => {
    for (const fn of [...resizeListeners]) fn({});
  };
  const navigate = (h: string) => {
    location.hash = h;
    for (const fn of hashListeners) fn({});
  };
  return {
    doc,
    pageBody,
    docKeys,
    es,
    fetches,
    intervals,
    timeouts,
    sockets,
    terms,
    fitDims,
    resize,
    navigate,
    location,
    reloads,
    observers,
    headNodes,
    context,
    resizeListeners,
    hashListeners,
    mqListeners,
  };
}

// A terminal-view element by data-role, inside the first terminal mounted in a tile of the tiling shell.
const role = (doc: FakeDoc, r: string): FakeNode => doc.getElementById("wm-root")!.querySelector(`[data-role="${r}"]`)!;
const countMounts = (n: FakeNode): number => (n.className === "wm-mount" ? 1 : 0) + n.children.reduce((a, c) => a + countMounts(c), 0);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const shownTab = (doc: FakeDoc) => doc.sections.filter((s) => !s.hidden).map((s) => s.getAttribute("data-tab"));

test("every pane's script executes together without a top-level const redeclaration", async () => {
  const { doc, fetches, sockets } = runShell("#/terminal/agent-7");
  // Only the active tab loads: panes defer to UI.register activation (the terminal looks up the agent and dials the socket).
  await flush();
  assert.deepEqual(
    fetches.map((f) => f.url),
    ["/v1/agents/agent-7"],
  );
  assert.deepEqual(
    sockets.map((s) => s.url),
    ["ws://ui.test/v1/agents/agent-7/terminal"],
  );
  assert.equal(doc.getElementById("tree-rows")!.children.length, 0);
});

// Changed: the terminal is a registry view mounted in a tile, so its section is no longer shown; the tile is the proof.
test("the hash router mounts a terminal tile for #/terminal/<id> and does not blank the page", () => {
  const { doc } = runShell("#/terminal/agent-7");
  assert.deepEqual(shownTab(doc), []);
  assert.equal(countMounts(doc.getElementById("wm-root")!), 1);
  assert.equal(role(doc, "title").textContent, "agent-7");
  const tree = runShell("#/tree");
  assert.deepEqual(shownTab(tree.doc), ["tree"]);
});

const running = { "/v1/agents/a1": { body: { state: "running" } } };
const text = (b: unknown) => new TextDecoder().decode(b as Uint8Array);
const clickEl = (n: { listeners: Map<string, ((ev: unknown) => void)[]> }, ev: unknown = {}) => {
  for (const fn of n.listeners.get("click") ?? []) fn(ev);
};
const keyBtn = (key: string) => {
  const b = fakeNode();
  b.setAttribute("data-key", key);
  return { target: b };
};

test("terminal: connects to the per-agent websocket, resets, sends the fitted size, relays bytes both ways", async () => {
  const { doc, sockets, terms } = runShell("#/terminal/a1", running);
  await flush();
  assert.equal(sockets.length, 1);
  const ws = sockets[0]!;
  assert.equal(ws.url, "ws://ui.test/v1/agents/a1/terminal");
  assert.equal(ws.binaryType, "arraybuffer");
  assert.equal(role(doc, "conn")!.textContent, "connecting");
  assert.equal(role(doc, "title")!.textContent, "a1");
  ws.open();
  const t = terms[0]!;
  assert.equal(t.resets, 1);
  assert.ok(t.focused >= 1);
  assert.equal(role(doc, "conn")!.textContent, "connected");
  assert.deepEqual(ws.sent.map(String), ['{"type":"resize","cols":100,"rows":30}']); // fit on open -> one control frame
  ws.onmessage!({ data: new Uint8Array([104, 105]).buffer });
  assert.equal(text(t.writes[0]), "hi");
  t.handlers.data!("ls\r");
  assert.ok(ws.sent[1] instanceof Uint8Array);
  assert.equal(text(ws.sent[1]), "ls\r");
  t.handlers.binary!("\u00ff\u0001");
  assert.deepEqual([...(ws.sent[2] as Uint8Array)], [255, 1]);
});

test("terminal: a resize storm re-arms one debounce timer and sends a single deduped frame", async () => {
  const { sockets, timeouts, fitDims, resize } = runShell("#/terminal/a1", running);
  await flush();
  const ws = sockets[0]!;
  ws.open();
  const before = ws.sent.length;
  fitDims.cols = 120;
  for (let i = 0; i < 5; i++) resize();
  const live = timeouts.filter((x) => !x.cleared && x.ms === 120);
  assert.equal(live.length, 1);
  live[0]!.fn();
  assert.equal(ws.sent.length, before + 1);
  assert.equal(String(ws.sent[before]), '{"type":"resize","cols":120,"rows":30}');
  resize();
  timeouts.filter((x) => !x.cleared && x.ms === 120)[0]!.fn();
  assert.equal(ws.sent.length, before + 1); // same size again: deduped
});

test("terminal: a server 'closed' frame then a socket drop reconnects with backoff and resets the screen", async () => {
  const { doc, sockets, terms, timeouts, intervals } = runShell("#/terminal/a1", running);
  await flush();
  sockets[0]!.open();
  sockets[0]!.onmessage!({ data: '{"type":"closed","reason":"remote"}' });
  sockets[0]!.drop();
  assert.equal(role(doc, "conn")!.textContent, "disconnected");
  assert.equal(role(doc, "reconnect")!.hidden, false);
  await flush();
  assert.match(role(doc, "note")!.textContent, /disconnected \u2014 reconnecting \(attempt 1\) in \d+s/);
  const retry = timeouts.filter((x) => !x.cleared && x.ms !== 120).pop()!;
  assert.ok(retry.ms >= 375 && retry.ms <= 625, String(retry.ms));
  assert.ok(intervals.some((i) => !i.cleared)); // countdown ticker
  retry.fn();
  assert.equal(sockets.length, 2);
  sockets[1]!.open();
  assert.equal(terms[0]!.resets, 2); // the daemon replays on connect, so the screen restarts clean
  assert.equal(role(doc, "conn")!.textContent, "connected");
  assert.equal(role(doc, "note")!.textContent, "");
  assert.equal(role(doc, "reconnect")!.hidden, true);
});

test("terminal: a finished agent shows 'No live terminal: agent <state>' and does not loop; Reconnect retries by hand", async () => {
  const { doc, sockets, timeouts } = runShell("#/terminal/a1", { "/v1/agents/a1": { body: { state: "exited" } } });
  await flush();
  sockets[0]!.open();
  sockets[0]!.drop();
  await flush();
  assert.match(role(doc, "note")!.textContent, /^No live terminal: agent exited \(the screen above is its last output\)$/);
  assert.equal(role(doc, "conn")!.textContent, "frozen");
  assert.equal(role(doc, "state")!.textContent, "exited");
  assert.equal(timeouts.filter((x) => !x.cleared && x.ms !== 120).length, 0);
  assert.equal(sockets.length, 1);
  assert.equal(role(doc, "reconnect")!.hidden, false);
  clickEl(role(doc, "reconnect")!);
  assert.equal(sockets.length, 2);
});

test("terminal: a yielded agent that was never connected (409) is labelled Yielded and is not retried", async () => {
  const { doc, sockets, timeouts, intervals } = runShell("#/terminal/a1", { "/v1/agents/a1": { body: { state: "yielded" } } });
  await flush();
  sockets[0]!.drop(); // the handshake was refused with 409: no open
  await flush();
  assert.equal(role(doc, "note")!.textContent, "Yielded: this agent is waiting and has no live terminal; it resumes on its wait condition");
  assert.equal(role(doc, "conn")!.textContent, "yielded");
  assert.equal(role(doc, "state")!.textContent, "yielded");
  assert.equal(timeouts.filter((x) => !x.cleared && x.ms !== 120).length, 0);
  assert.ok(intervals.every((i) => i.cleared || i.ms !== 1000)); // no countdown ticker (the 5s state poll stays)
  assert.equal(sockets.length, 1);
  assert.equal(role(doc, "reconnect")!.hidden, false); // manual retry stays available
});

test("terminal: a screen left by a connection that then yielded is kept and labelled frozen, never live", async () => {
  const { doc, sockets, terms, timeouts } = runShell("#/terminal/a1", { "/v1/agents/a1": { body: { state: "yielded" } } });
  await flush();
  sockets[0]!.open();
  sockets[0]!.drop();
  await flush();
  assert.match(role(doc, "note")!.textContent, /^frozen: agent yielded/);
  assert.equal(role(doc, "conn")!.textContent, "frozen");
  assert.equal(terms[0]!.disposed, false);
  assert.equal(terms[0]!.resets, 1); // not cleared
  assert.equal(timeouts.filter((x) => !x.cleared && x.ms !== 120).length, 0);
});

test("terminal: a reaped agent says no live terminal; an unknown state still retries (negative control)", async () => {
  const reaped = runShell("#/terminal/a1", { "/v1/agents/a1": { body: { state: "reaped" } } });
  await flush();
  reaped.sockets[0]!.drop();
  await flush();
  assert.equal(role(reaped.doc, "note")!.textContent, "No live terminal: agent reaped");
  const odd = runShell("#/terminal/a1", { "/v1/agents/a1": { body: { state: "mystery" } } });
  await flush();
  odd.sockets[0]!.drop();
  await flush();
  assert.match(role(odd.doc, "note")!.textContent, /disconnected \u2014 reconnecting \(attempt 1\)/);
});

test("terminal: an unknown agent (404) stops with 'agent not found'", async () => {
  const { doc, sockets } = runShell("#/terminal/zz", { "/v1/agents/zz": { status: 404, body: {} } });
  await flush();
  sockets[0]!.drop();
  await flush();
  assert.match(role(doc, "note")!.textContent, /agent not found/);
});

test("terminal: no agent selected, and leaving the tab closes the socket and disposes the terminal", async () => {
  const none = runShell("#/terminal/");
  await flush();
  assert.match(role(none.doc, "note")!.textContent, /no agent selected/);
  assert.equal(none.sockets.length, 0);

  const { sockets, terms, navigate, intervals, doc } = runShell("#/terminal/a1", running);
  await flush();
  sockets[0]!.open();
  const reconnect = role(doc, "reconnect"); // the elements leave the page on unmount, so hold the node
  navigate("#/audit");
  assert.equal(sockets[0]!.closed, true);
  assert.equal(terms[0]!.disposed, true);
  assert.ok(intervals.every((i) => i.cleared));
  sockets[0]!.drop(); // a late close from the old socket must not schedule a reconnect
  await flush();
  assert.equal(sockets.length, 1);
  assert.equal(reconnect.hidden, true);
});

test("terminal: switching agents by hash reconnects to the new id", async () => {
  const { sockets, navigate, doc } = runShell("#/terminal/a1", running);
  await flush();
  sockets[0]!.open();
  navigate("#/terminal/b2");
  await flush();
  assert.equal(sockets[0]!.closed, true);
  assert.equal(sockets[1]!.url, "ws://ui.test/v1/agents/b2/terminal");
  assert.equal(role(doc, "title")!.textContent, "b2");
});

test("terminal: copy chord copies a selection instead of sending ^C; key bar sends escape sequences with one-shot Ctrl", async () => {
  const { doc, sockets, terms } = runShell("#/terminal/a1", running);
  await flush();
  const ws = sockets[0]!;
  ws.open();
  const t = terms[0]!;
  assert.equal(t.keyHandler!({ type: "keydown", key: "c", ctrlKey: true }), true); // no selection: reaches the program
  t.selection = "picked";
  assert.equal(t.keyHandler!({ type: "keydown", key: "c", ctrlKey: true }), false);
  const keys = role(doc, "keys")!;
  const before = ws.sent.length;
  clickEl(keys, keyBtn("Esc"));
  clickEl(keys, keyBtn("ArrowUp"));
  assert.deepEqual(
    ws.sent.slice(before).map((b) => text(b)),
    ["\u001b", "\u001b[A"],
  );
  clickEl(keys, keyBtn("Ctrl"));
  assert.equal(role(doc, "ctrl")!.getAttribute("aria-pressed"), "true");
  t.handlers.data!("c");
  assert.equal(text(ws.sent[ws.sent.length - 1]), "\u0003");
  assert.equal(role(doc, "ctrl")!.getAttribute("aria-pressed"), "false");
  t.handlers.data!("c"); // Ctrl was one-shot
  assert.equal(text(ws.sent[ws.sent.length - 1]), "c");
});

test("terminal: Shift+Enter/Ctrl+Enter/Ctrl+Shift+letter reach the socket as bytes; composing and keyup are ignored; paste passes through", async () => {
  const { sockets, terms } = runShell("#/terminal/a1", running);
  await flush();
  const ws = sockets[0]!;
  ws.open();
  const t = terms[0]!;
  const key = (o: object) => {
    const calls = { prevented: 0 };
    const ret = t.keyHandler!({
      type: "keydown",
      preventDefault() {
        calls.prevented++;
      },
      ...o,
    });
    return { ret, calls };
  };
  const before = ws.sent.length;
  const sh = key({ key: "Enter", shiftKey: true });
  assert.equal(sh.ret, false);
  assert.equal(sh.calls.prevented, 1);
  assert.deepEqual(ws.sent.slice(before).map(text), ["\n"]);
  assert.equal(key({ key: "Enter", ctrlKey: true }).ret, false);
  assert.equal(text(ws.sent[ws.sent.length - 1]), "\u001b[13;5u");
  assert.equal(key({ key: "P", ctrlKey: true, shiftKey: true }).ret, false);
  assert.equal(text(ws.sent[ws.sent.length - 1]), "\u001b[112;6u");
  const n = ws.sent.length;
  assert.equal(key({ key: "Enter" }).ret, true); // plain Enter and Alt+Enter stay xterm's
  assert.equal(key({ key: "Enter", altKey: true }).ret, true);
  assert.equal(key({ key: "Enter", shiftKey: true, isComposing: true }).ret, true);
  assert.equal(key({ type: "keyup", key: "Enter", shiftKey: true }).ret, true);
  assert.equal(key({ key: "C", ctrlKey: true, shiftKey: true }).ret, false); // no selection: nothing copied, nothing sent
  const v = key({ key: "v", ctrlKey: true });
  assert.equal(v.ret, false);
  assert.equal(v.calls.prevented, 0); // native paste event must fire
  assert.equal(ws.sent.length, n);
});

test("terminal: raw trace opt-in uses an in-page prompt (no native confirm): cancel and Escape keep it off, confirm turns it on", async () => {
  const { doc } = runShell("#/terminal/a1", running);
  await flush();
  const raw = role(doc, "trace-raw")!;
  const prompt = role(doc, "trace-confirm")!;
  const fire = (n: FakeNode, type: string, ev: unknown = {}) => {
    for (const fn of n.listeners.get(type) ?? []) fn(ev);
  };
  const check = () => {
    raw.checked = true;
    fire(raw, "change");
  };
  check();
  assert.equal(raw.checked, false); // off until confirmed
  assert.equal(prompt.hidden, false);
  assert.equal(role(doc, "trace-confirm-ok")!.focused, 1);
  clickEl(role(doc, "trace-confirm-cancel")!);
  assert.equal(prompt.hidden, true);
  assert.equal(raw.checked, false);
  assert.equal(raw.focused, 1);
  check();
  fire(prompt, "keydown", { key: "Enter" }); // Enter is the focused button's native click, not a cancel
  assert.equal(prompt.hidden, false);
  fire(prompt, "keydown", { key: "Escape" });
  assert.equal(prompt.hidden, true);
  assert.equal(raw.checked, false);
  assert.equal(raw.focused, 2);
  check();
  clickEl(role(doc, "trace-confirm-ok")!);
  assert.equal(prompt.hidden, true);
  assert.equal(raw.checked, true);
  assert.equal(raw.focused, 3);
  raw.checked = false; // unchecking never prompts
  fire(raw, "change");
  assert.equal(prompt.hidden, true);
});

test("terminal: View trace opens an in-app viewer with the checked options, closes on Escape and returns focus; no agent means no fetch", async () => {
  const { doc, pageBody, docKeys, fetches } = runShell("#/terminal/a1", { ...running, "/v1/agents/a1/trace": { body: "# Trace text" } });
  await flush();
  const btn = role(doc, "trace-view")!;
  role(doc, "trace-children")!.checked = true;
  const before = fetches.length;
  clickEl(btn);
  await flush();
  assert.equal(fetches.length, before + 1);
  assert.equal(fetches[fetches.length - 1]!.url, "/v1/agents/a1/trace?format=md&include=children");
  const dialog = pageBody.children[0]!;
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  const pre = dialog.children[0]!.children.find((c) => c.tagName === "pre")!;
  assert.equal(pre.textContent, "# Trace text");
  assert.equal(btn.focused, undefined);
  for (const fn of [...docKeys]) fn({ key: "Escape" });
  assert.equal(pageBody.children.length, 0);
  assert.equal(btn.focused, 1);
  // negative control: without an open agent the button does nothing
  const none = runShell("#/terminal");
  await flush();
  clickEl(role(none.doc, "trace-view")!);
  assert.equal(none.pageBody.children.length, 0);
});

test("terminal: View trace twice keeps one viewer; navigating to another agent dismisses it", async () => {
  const r = runShell("#/terminal/a1", { ...running, "/v1/agents/a2": { body: { state: "running" } } });
  await flush();
  const btn = role(r.doc, "trace-view")!;
  clickEl(btn);
  clickEl(btn);
  await flush();
  assert.equal(r.pageBody.children.length, 1);
  r.navigate("#/terminal/a2");
  await flush();
  assert.equal(r.pageBody.children.length, 0, "old agent's trace is gone");
  assert.equal(r.docKeys.length, 0);
});

test("terminal: View trace never fetches raw unless the raw opt-in was confirmed", async () => {
  const r = runShell("#/terminal/a1", { ...running, "/v1/agents/a1/trace": { body: "t" } });
  await flush();
  const raw = role(r.doc, "trace-raw")!;
  const fire = (n: FakeNode, type: string) => {
    for (const fn of n.listeners.get(type) ?? []) fn({});
  };
  const view = async () => {
    const n = r.fetches.length;
    clickEl(role(r.doc, "trace-view")!);
    await flush();
    const url = r.fetches[n]!.url;
    for (const fn of [...r.docKeys]) fn({ key: "Escape" });
    return url;
  };
  raw.checked = true; // checking opens the in-page prompt and keeps raw off
  fire(raw, "change");
  assert.doesNotMatch(await view(), /raw=1/, "prompt open, unconfirmed");
  clickEl(role(r.doc, "trace-confirm-cancel")!);
  assert.doesNotMatch(await view(), /raw=1/, "cancelled");
  raw.checked = true;
  fire(raw, "change");
  clickEl(role(r.doc, "trace-confirm-ok")!);
  assert.match(await view(), /raw=1/, "confirmed");
});

test("terminal: key bar toggle, Alt one-shot, named keys, Send key menu, and offline no-ops", async () => {
  const store: Record<string, string> = {};
  const { doc, sockets, terms } = runShell("#/terminal/a1", running, undefined, store);
  await flush();
  const keys = role(doc, "keys")!;
  const menu = role(doc, "keymenu")!;
  const ws = sockets[0]!;
  clickEl(keys, keyBtn("Esc")); // connecting: no-op, no throw
  assert.equal(ws.sent.length, 0);
  assert.match(keys.className, /\boff\b/);
  assert.doesNotMatch(keys.className, /\bopen\b/); // desktop default: collapsed
  clickEl(role(doc, "keys-toggle")!);
  assert.match(keys.className, /\bopen\b/);
  assert.equal(store["pomtree.termKeysOpen"], "1");
  ws.open();
  const t = terms[0]!;
  assert.doesNotMatch(keys.className, /\boff\b/);
  const before = ws.sent.length;
  for (const k of ["Tab", "Shift+Tab", "Enter", "Shift+Enter"]) clickEl(keys, keyBtn(k));
  assert.deepEqual(ws.sent.slice(before).map(text), ["\t", "\u001b[Z", "\r", "\n"]);
  clickEl(keys, keyBtn("Alt"));
  assert.equal(role(doc, "alt")!.getAttribute("aria-pressed"), "true");
  t.handlers.data!("b");
  assert.equal(text(ws.sent[ws.sent.length - 1]), "\u001bb");
  assert.equal(role(doc, "alt")!.getAttribute("aria-pressed"), "false");
  clickEl(keys, keyBtn("Alt"));
  role(doc, "host")!.listeners.get("focusout")![0]!({}); // blur clears armed modifiers
  assert.equal(role(doc, "alt")!.getAttribute("aria-pressed"), "false");
  clickEl(keys, keyBtn("SendKey"));
  assert.equal(menu.hidden, false);
  const item = fakeNode();
  item.setAttribute("data-sendkey", "Ctrl+W");
  clickEl(menu, { target: item });
  assert.equal(text(ws.sent[ws.sent.length - 1]), "\u0017");
  assert.equal(menu.hidden, true);
  ws.drop();
  const n = ws.sent.length;
  clickEl(keys, keyBtn("Esc"));
  assert.equal(ws.sent.length, n);
});

test("terminal: font size buttons clamp, persist as a benign pref, and apply to the live terminal", async () => {
  const store: Record<string, string> = { "pomtree.termFontSize": "20" };
  const { doc, terms, sockets } = runShell("#/terminal/a1", running, undefined, store);
  await flush();
  sockets[0]!.open();
  assert.equal(terms[0]!.options.fontSize, 20);
  clickEl(role(doc, "font-inc")!);
  assert.equal(terms[0]!.options.fontSize, 21);
  assert.equal(store["pomtree.termFontSize"], "21");
  for (let i = 0; i < 40; i++) clickEl(role(doc, "font-dec")!);
  assert.equal(terms[0]!.options.fontSize, 8);
});

test("terminal pane: paths are JSON-escaped, vendor path is configurable, only the benign UI prefs touch storage", () => {
  const html = renderTerminalPane({ agentsBase: "</script><script>alert(1)</script>\u2028", terminalPath: "/x/:id/t" });
  assert.equal(html.match(/<\/script>/g)!.length, 1);
  assert.ok(!html.includes("\u2028"));
  assert.ok(html.includes("\\u003c/script>"));
  assert.ok(renderTerminalPane().includes('"/ui/vendor"'));
  assert.ok(renderTerminalPane().includes('"/v1/agents/:id/terminal"'));
  assert.ok(renderTerminalPane({ vendorPath: "/p/ui/vendor" }).includes('"/p/ui/vendor"'));
  assert.ok(!/innerHTML|sessionStorage|indexedDB/.test(renderTerminalPane()));
  assert.deepEqual(
    [...renderTerminalPane().matchAll(/localStorage\.(?:get|set)Item\(([A-Za-z_]+)/g)].map((m) => m[1]),
    ["PREF_KEYS", "PREF_FONT", "PREF_FONT", "PREF_KEYS"],
  );
});

test("tabs load on activation (reports empty state, audit empty state, hosts, schedules)", async () => {
  for (const [hash, rowsId, text] of [
    ["#/reports", "reports-rows", "No reports published yet."],
    ["#/audit", "audit-rows", "No journal entries yet."],
    ["#/schedules", "schedules-rows", "No schedules"],
  ] as const) {
    const { doc, fetches } = runShell(hash);
    assert.equal(fetches.length, 1, hash);
    await flush();
    assert.ok(doc.getElementById(rowsId)!.children[0]!.children[0]!.textContent.startsWith(text), hash);
  }
  const { doc, intervals } = runShell("#/hosts", { "/v1/placement": { body: { host: "h1", maxConcurrent: 2, running: [], queue: [] } } });
  await flush();
  const text = doc.getElementById("hosts-status")!.textContent;
  assert.ok(text.includes("host h1") && text.includes("No agents yet"));
  assert.equal(intervals.length, 1); // polls while active
});

test("401 maps to the not-signed-in message on every pane", async () => {
  const { doc } = runShell("#/reports", { "/v1/reports": { status: 401, body: {} } });
  await flush();
  assert.equal(doc.getElementById("reports-rows")!.children[0]!.children[0]!.textContent, "Not signed in \u2014 reload to sign in");
  const e = runShell("#/escalations", { "/v1/escalations": { status: 401, body: {} } });
  await flush();
  assert.equal(e.doc.getElementById("escalations-status")!.textContent, "Not signed in \u2014 reload to sign in");
  const o = runShell("#/audit", { "/v1/journal": { status: 500, body: {} } });
  await flush();
  assert.equal(o.doc.getElementById("audit-rows")!.children[0]!.children[0]!.textContent, "Failed to load journal: Error: HTTP 500");
});

test("escalations: empty state, polling, refresh adds new asks and drops answered ones", async () => {
  const responses: Record<string, { body: Json }> = { "/v1/escalations": { body: [] } };
  const { doc, intervals } = runShell("#/escalations", responses);
  await flush();
  const status = doc.getElementById("escalations-status")!;
  assert.equal(status.textContent, "No open escalations");
  assert.equal(intervals.length, 1);
  responses["/v1/escalations"] = { body: [{ id: "e1", agent: "a", question: "q?", options: [], createdAt: Date.now() }] };
  intervals[0]!.fn();
  await flush();
  assert.equal(doc.getElementById("escalations")!.children.length, 1);
  assert.equal(status.textContent, "");
});

test("tree: rows link to #/terminal/<fullId>, empty state guides and links to #/new, SSE badge tracks errors", () => {
  const { doc, es } = runShell("#/tree");
  const stream = es[0]!;
  const conn = doc.getElementById("tree-conn")!;
  assert.equal(conn.textContent, "connecting");
  const rows = stream.handlers.get("rows")!;
  rows({ data: "[]" });
  assert.equal(conn.textContent, "connected");
  const empty = doc.getElementById("tree-rows")!.children[0]!.children[0]!;
  assert.ok(empty.textContent.includes("No agents yet"));
  assert.equal(empty.children[0]!.href, "#/new");
  stream.onerror!();
  assert.equal(conn.textContent, "stale");
  rows({
    data: JSON.stringify([
      {
        name: "kid",
        id: "abcd1234",
        fullId: "abcd1234-full/x",
        depth: 1,
        state: "running",
        age: "1m",
        activity: "",
        tokens: 0,
        cost: "$0",
        left: "$1",
        wait: "",
        host: "h",
      },
    ]),
  });
  const tr = doc.getElementById("tree-rows")!.children[0]!;
  assert.equal(tr.className, "s-running");
  assert.equal(tr.children[0]!.children[0]!.href, "#/terminal/abcd1234-full%2Fx");
});

test("the tree pane has a '+ New agent' button", () => {
  assert.ok(renderTreePane().includes('href="#/new">+ New agent'));
});

// --- New agent form ---------------------------------------------------------

function logic() {
  const ctx = createContext({});
  return runInContext(`(() => { ${NEW_AGENT_LOGIC_JS}; return N; })()`, ctx) as {
    templateLines(t: unknown): string[];
    validate(f: Record<string, string | boolean>): { ok: boolean; errors: Record<string, string> };
    body(f: Record<string, string | boolean>, key: string): Record<string, unknown>;
    signature(f: Record<string, string | boolean>): string;
    pickModel(data: unknown, stored: string): string;
    modelHint(data: unknown): string;
    errorText(status: number, payload: unknown): string;
    templatesNotice(status: number, payload: unknown): { cls: string; text: string };
    modelLead(t: unknown): string | null;
    modelDefault(data: unknown, stored: string, hasTemplate: boolean): string;
    overrideHint(t: unknown, key: string): string;
    NO_DAEMON: string;
  };
}

test("new-agent logic: validation, body building (dollars to micros), signature, error text", () => {
  const N = logic();
  assert.equal(JSON.stringify(N.validate({ task: "  " }).errors), JSON.stringify({ task: "task is required" }));
  assert.equal(N.validate({ task: "t", budget: "0" }).ok, false);
  assert.equal(N.validate({ task: "t", budget: "-1" }).ok, false);
  assert.equal(N.validate({ task: "t", budget: "abc" }).ok, false);
  assert.equal(N.validate({ task: "t", budget: "0.0000001" }).ok, false);
  assert.equal(N.validate({ task: "t", budget: "" }).ok, true);
  assert.deepEqual({ ...N.body({ task: " do it ", name: "", template: "", budget: "" }, "k") }, { task: "do it", idempotencyKey: "k" });
  assert.deepEqual(
    { ...N.body({ task: "t", name: " n ", template: "tpl", budget: "2.5" }, "k") },
    {
      task: "t",
      idempotencyKey: "k",
      name: "n",
      template: "tpl",
      budgetMicros: 2_500_000,
    },
  );
  assert.equal(N.body({ task: "t", budget: "0.1" }, "k").budgetMicros, 100000); // rounded, integer
  assert.equal(N.signature({ task: "t" }), N.signature({ task: " t " }));
  assert.notEqual(N.signature({ task: "t" }), N.signature({ task: "u" }));
  assert.equal(N.errorText(409, { error: "busy" }), "HTTP 409: busy");
  assert.equal(N.errorText(503, null), "HTTP 503");
  assert.equal(N.errorText(401, {}), "Not signed in \u2014 reload to sign in");
});

test("new-agent pane: template select hidden on 400/empty, shown when listed", async () => {
  const bad = runShell("#/new", { "/v1/templates": { status: 400, body: { error: "templates are not configured" } } });
  await flush();
  assert.equal(bad.doc.getElementById("new-template-wrap")!.hidden, true);
  const good = runShell("#/new", { "/v1/templates": { body: [{ id: "py", name: "Python" }] } });
  await flush();
  const wrap = good.doc.getElementById("new-template-wrap")!;
  assert.equal(wrap.hidden, false);
  assert.equal(good.doc.getElementById("new-template")!.children.length, 2);
});

test("new-agent pane: invalid form does not post; submit posts the spawn body and navigates to the terminal", async () => {
  const r = runShell("#/new", { "/v1/agents": { status: 201, body: { id: "new-1" } } });
  await flush();
  const click = () => {
    for (const fn of r.doc.getElementById("new-submit")!.listeners.get("click")!) fn({});
  };
  click();
  assert.equal(r.doc.getElementById("new-task-err")!.textContent, "task is required");
  assert.equal(r.fetches.filter((f) => f.init?.method === "POST").length, 0);
  r.doc.getElementById("new-task")!.value = "build it";
  r.doc.getElementById("new-budget")!.value = "1";
  click();
  assert.equal(r.doc.getElementById("new-submit")!.disabled, true);
  click(); // in flight: ignored
  await flush();
  const posts = r.fetches.filter((f) => f.init?.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.url, "/v1/agents");
  const body = JSON.parse(posts[0]!.init!.body!);
  assert.equal(body.task, "build it");
  assert.equal(body.budgetMicros, 1_000_000);
  assert.equal(typeof body.idempotencyKey, "string");
  assert.equal(r.location.hash, "#/terminal/new-1");
  assert.equal(r.doc.getElementById("new-submit")!.disabled, false);
});

test("new-agent pane: server error shown inline, form kept, retry reuses the idempotency key", async () => {
  const responses: Record<string, { status: number; body: Json }> = { "/v1/agents": { status: 503, body: { error: "no capacity" } } };
  const r = runShell("#/new", responses);
  await flush();
  r.doc.getElementById("new-task")!.value = "t";
  const click = () => {
    for (const fn of r.doc.getElementById("new-submit")!.listeners.get("click")!) fn({});
  };
  click();
  await flush();
  assert.equal(r.doc.getElementById("new-status")!.textContent, "HTTP 503: no capacity");
  assert.equal(r.doc.getElementById("new-task")!.value, "t");
  assert.equal(r.doc.getElementById("new-submit")!.disabled, false);
  click();
  await flush();
  const keys = r.fetches.filter((f) => f.init?.method === "POST").map((f) => JSON.parse(f.init!.body!).idempotencyKey);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  r.doc.getElementById("new-task")!.value = "other";
  click();
  await flush();
  const keys3 = r.fetches.filter((f) => f.init?.method === "POST").map((f) => JSON.parse(f.init!.body!).idempotencyKey);
  assert.notEqual(keys3[2], keys3[0]);
});

test("new-agent logic: model body and default selection (last-chosen > catalog default > first)", () => {
  const N = logic();
  const data = {
    models: [
      { provider: "a", id: "x" },
      { provider: "b", id: "y/z" },
      { provider: "c", id: "w" },
    ],
    default: { provider: "b", id: "y/z" },
    source: "pi",
  };
  assert.equal(N.pickModel(data, "c/w"), "c/w");
  assert.equal(N.pickModel(data, "gone/model"), "b/y/z"); // stale pref falls back to the default
  assert.equal(N.pickModel(data, ""), "b/y/z");
  assert.equal(N.pickModel({ ...data, default: undefined }, ""), "a/x");
  assert.equal(N.pickModel({ models: [], source: "none" }, "a/x"), "");
  assert.deepEqual({ ...(N.body({ task: "t", model: "b/y/z" }, "k").model as object) }, { provider: "b", id: "y/z" });
  assert.equal("model" in N.body({ task: "t", model: "" }, "k"), false);
  assert.notEqual(N.signature({ task: "t", model: "a/x" }), N.signature({ task: "t", model: "c/w" }));
  assert.equal(N.modelHint({ source: "pi" }), "");
  assert.match(N.modelHint({ source: "env", reason: "boom" }), /boom/);
});

test("new-agent pane: model select hidden when the list is empty, shown with options otherwise", async () => {
  const none = runShell("#/new", { "/v1/models": { body: { models: [], source: "none", reason: "x" } } });
  await flush();
  assert.equal(none.doc.getElementById("new-model-wrap")!.hidden, true);
  const some = runShell("#/new", {
    "/v1/models": {
      body: {
        models: [
          { provider: "a", id: "x" },
          { provider: "b", id: "y", default: true },
        ],
        default: { provider: "b", id: "y" },
        source: "pi",
      },
    },
  });
  await flush();
  assert.equal(some.doc.getElementById("new-model-wrap")!.hidden, false);
  assert.equal(some.doc.getElementById("new-model")!.children.length, 2);
  assert.equal(some.doc.getElementById("new-model")!.value, "b/y");
});

const MODELS = {
  models: [
    { provider: "a", id: "x" },
    { provider: "b", id: "y" },
  ],
  default: { provider: "a", id: "x" },
  source: "pi",
};
const tplResponse = (rows: Json) => ({ "/v1/templates": { body: rows }, "/v1/models": { body: MODELS } });
const fireChange = (n: FakeNode) => {
  for (const fn of n.listeners.get("change") ?? []) fn({});
};

test("new-agent logic: a selected template's model is not overridden by default; hint only on a differing explicit pick", () => {
  const N = logic();
  const tpl = { id: "h", provider: "b", model: "y" };
  assert.equal(N.modelLead(tpl), "(template's model: b/y)");
  assert.equal(N.modelLead({ id: "h" }), "(default)");
  assert.equal(N.modelLead(undefined), null);
  assert.equal(N.modelDefault(MODELS, "b/y", true), ""); // remembered model does not override a template
  assert.equal(N.modelDefault(MODELS, "b/y", false), "b/y"); // negative: no template, remembered model applies
  assert.equal("model" in N.body({ task: "t", template: "h", model: "" }, "k"), false);
  assert.deepEqual({ ...(N.body({ task: "t", template: "h", model: "a/x" }, "k").model as object) }, { provider: "a", id: "x" });
  assert.equal(N.overrideHint(tpl, "a/x"), "overrides the template's model");
  assert.equal(N.overrideHint(tpl, "b/y"), ""); // same as the template's
  assert.equal(N.overrideHint(tpl, ""), ""); // default option
  assert.equal(N.overrideHint({ id: "h" }, "a/x"), ""); // template names none: nothing to override
  assert.equal(N.overrideHint(undefined, "a/x"), "");
});

test("new-agent pane: with a template the model select defaults to a no-model option despite the remembered model", async () => {
  const store = { "pomtree.lastModel": "b/y" };
  const r = runShell("#/new", tplResponse([{ id: "h", provider: "a", model: "x" }]), undefined, store);
  await flush();
  const modelEl = r.doc.getElementById("new-model")!;
  assert.equal(modelEl.value, "b/y"); // no template selected yet: remembered model applies
  const tplEl = r.doc.getElementById("new-template")!;
  tplEl.value = "h";
  fireChange(tplEl);
  assert.equal(modelEl.value, "");
  assert.equal(modelEl.children[0]!.textContent, "(template's model: a/x)");
  assert.equal(modelEl.children.length, 3);
  assert.equal(r.doc.getElementById("new-model-override")!.textContent, "");
  r.doc.getElementById("new-task")!.value = "t";
  for (const fn of r.doc.getElementById("new-submit")!.listeners.get("click")!) fn({});
  await flush();
  const sent = JSON.parse(r.fetches.find((f) => f.init?.method === "POST")!.init!.body!);
  assert.equal("model" in sent, false);
  assert.equal(sent.template, "h");
  assert.equal(store["pomtree.lastModel"], "b/y"); // the default option does not clobber the remembered model
  modelEl.value = "b/y"; // explicit pick differing from the template's
  fireChange(modelEl);
  assert.equal(r.doc.getElementById("new-model-override")!.textContent, "overrides the template's model");
  modelEl.value = "a/x"; // explicit pick equal to the template's
  fireChange(modelEl);
  assert.equal(r.doc.getElementById("new-model-override")!.textContent, "");
  tplEl.value = ""; // back to no template: remembered model returns
  fireChange(tplEl);
  assert.equal(modelEl.value, "b/y");
  assert.equal(modelEl.children.length, 2);
});

test("new-agent pane: a template that names no model gets a (default) option", async () => {
  const r = runShell("#/new", tplResponse([{ id: "h" }]));
  await flush();
  const tplEl = r.doc.getElementById("new-template")!;
  tplEl.value = "h";
  fireChange(tplEl);
  assert.equal(r.doc.getElementById("new-model")!.children[0]!.textContent, "(default)");
  assert.equal(r.doc.getElementById("new-model")!.value, "");
});

test("new-agent logic: template load failures are distinct (400 not configured, 500 shows status and text, escaped)", () => {
  const N = logic();
  const nc = N.templatesNotice(400, { error: "templates are not configured" });
  assert.equal(nc.cls, "meta");
  assert.match(nc.text, /not configured on this daemon.*POMTREED_TEMPLATES_DIR.*<state>\/templates/);
  const bad = N.templatesNotice(500, { error: "template error: a.json: model bad" });
  assert.equal(bad.cls, "err");
  assert.equal(bad.text, "could not load templates: HTTP 500: template error: a.json: model bad");
  assert.equal(N.templatesNotice(502, null).text, "could not load templates: HTTP 502");
  assert.doesNotMatch(bad.text, /not configured/); // negative: 500 is not reported as unconfigured
});

test("new-agent pane: template load 400 / 500 / network show distinct notices; the form stays usable", async () => {
  const notice = async (resp: { status?: number; body: Json; fail?: boolean }) => {
    const r = runShell("#/new", { "/v1/templates": resp, "/v1/models": { body: MODELS } });
    await flush();
    assert.equal(r.doc.getElementById("new-template-wrap")!.hidden, true);
    assert.equal(r.doc.getElementById("new-model-wrap")!.hidden, false); // rest of the form works
    return r.doc.getElementById("new-template-notice")!;
  };
  const a = await notice({ status: 400, body: { error: "templates are not configured" } });
  assert.match(a.textContent, /POMTREED_TEMPLATES_DIR/);
  const b = await notice({ status: 500, body: { error: "template error: x.json: bad" } });
  assert.equal(b.textContent, "could not load templates: HTTP 500: template error: x.json: bad");
  assert.equal(b.className, "err");
  const c = await notice({ body: null, fail: true });
  assert.match(c.textContent, /could not load templates: could not reach the daemon/);
  assert.doesNotMatch(c.textContent, /ECONNREFUSED|TypeError/);
});

test("new-agent pane: invalid template rows are listed disabled with their error; valid rows work", async () => {
  const r = runShell(
    "#/new",
    tplResponse([
      { id: "ok", name: "Fine" },
      { id: "bad", error: "template error: bad.json: model: not a string" },
    ]),
  );
  await flush();
  const opts = r.doc.getElementById("new-template")!.children;
  assert.equal(opts.length, 3);
  assert.equal(opts[1]!.disabled, false);
  assert.equal(opts[2]!.textContent, "bad (invalid: see message)");
  assert.equal(opts[2]!.disabled, true);
  assert.equal(r.doc.getElementById("new-template-errors")!.children[0]!.textContent, "bad: template error: bad.json: model: not a string");
  assert.equal(r.doc.getElementById("new-template-wrap")!.hidden, false);
});

test("new-agent logic: server error text is verbatim, trimmed, control-stripped; markup stays inert text", async () => {
  const N = logic();
  assert.equal(N.errorText(400, { error: "unknown model: p/id" }), "HTTP 400: unknown model: p/id");
  assert.equal(N.errorText(404, { error: "  no such template: X\n\u0007 " }), "HTTP 404: no such template: X");
  assert.equal(N.errorText(403, { error: "a\r\nb" }), "HTTP 403: a  b");
  assert.equal(N.errorText(409, { error: 5 }), "HTTP 409"); // negative: non-string error ignored
  assert.match(N.NO_DAEMON, /could not reach the daemon/);
  const xss = '<img src=x onerror="alert(1)">';
  const resp = { "/v1/agents": { status: 400, body: { error: xss } } };
  const r = runShell("#/new", resp);
  await flush();
  r.doc.getElementById("new-task")!.value = "t";
  for (const fn of r.doc.getElementById("new-submit")!.listeners.get("click")!) fn({});
  await flush();
  const st = r.doc.getElementById("new-status")!;
  assert.equal(st.textContent, "HTTP 400: " + xss); // set as text, never parsed as HTML
  assert.equal(st.children.length, 0);
  assert.equal(st.className, "err");
  const net = runShell("#/new", { "/v1/agents": { body: null, fail: true } });
  await flush();
  net.doc.getElementById("new-task")!.value = "t";
  for (const fn of net.doc.getElementById("new-submit")!.listeners.get("click")!) fn({});
  await flush();
  assert.match(net.doc.getElementById("new-status")!.textContent, /could not reach the daemon/);
  assert.doesNotMatch(net.doc.getElementById("new-status")!.textContent, /TypeError|ECONNREFUSED/);
});

const long = (n: number) => Array.from({ length: n }, (_, i) => "line " + i).join("\n");
const findBtn = (n: FakeNode, text: string): FakeNode | undefined => {
  if (n.tagName === "button" && n.textContent === text) return n;
  for (const c of n.children) {
    const r = findBtn(c, text);
    if (r) return r;
  }
  return undefined;
};
const click = (n: FakeNode) => n.listeners.get("click")![0]!({});

test("new agent pane leaves the budget blank (template/default budget applies) and explains it", () => {
  const html = renderNewAgentPane();
  assert.doesNotMatch(html, /id="new-budget" value=/);
  assert.match(html, /USD; the agent is stopped when spend exceeds this/);
  assert.match(html, /<details id="new-advanced">/);
  for (const id of ["new-wrapup", "new-fork", "new-fromcommit", "new-sessionref"]) {
    assert.ok(html.indexOf(`id="${id}"`) > html.indexOf('id="new-advanced"'), `${id} is under Advanced`);
  }
  assert.ok(html.indexOf('id="new-deadline"') < html.indexOf('id="new-advanced"'), "deadline stays visible");
});

test("new-agent logic: deadline/wrapup/fork/fromCommit/sessionRef appear in the body only when set", () => {
  const N = logic();
  const base = { task: "t", name: "", template: "", budget: "", model: "", deadline: "", wrapup: "", fork: false, fromCommit: "", sessionRef: "" };
  assert.deepEqual({ ...N.body(base, "k") }, { task: "t", idempotencyKey: "k" }); // blank budget omitted: template/default applies
  assert.equal(N.body({ ...base, deadline: "0" }, "k").deadlineMs, 0);
  assert.equal(N.body({ ...base, deadline: "4h" }, "k").deadlineMs, 14_400_000);
  assert.equal(N.body({ ...base, deadline: " 90m " }, "k").deadlineMs, 5_400_000);
  assert.equal(N.body({ ...base, deadline: "60000" }, "k").deadlineMs, 60_000);
  assert.equal(N.body({ ...base, wrapup: "45s" }, "k").wrapupMs, 45_000);
  assert.deepEqual(
    { ...N.body({ ...base, budget: "$2", deadline: "30m", wrapup: "1m", fork: true, fromCommit: " abc ", sessionRef: " s1 " }, "k") },
    { task: "t", idempotencyKey: "k", budgetMicros: 2_000_000, deadlineMs: 1_800_000, wrapupMs: 60_000, fork: true, fromCommit: "abc", sessionRef: "s1" },
  );
  const all = N.body({ ...base, template: "tpl", model: "a/b" }, "k");
  for (const k of ["deadlineMs", "wrapupMs", "fork", "fromCommit", "sessionRef", "budgetMicros"]) assert.equal(k in all, false, k);
  assert.notEqual(N.signature({ ...base, fork: true }), N.signature(base));
  assert.notEqual(N.signature({ ...base, deadline: "0" }), N.signature(base));
});

// Copied from packages/pomtree/src/cli.test.ts ("spawn --deadline ..." and "--wrapup" cases) and ux.ts parseBudgetFlag; pins this copy of the grammar.
test("new-agent logic: duration and budget grammar match the CLI's accepted and rejected examples", () => {
  const N = logic();
  const f = (o: Record<string, string>) => ({ task: "t", ...o });
  for (const [v, ms] of [
    ["4h", 14_400_000],
    ["90m", 5_400_000],
    ["60000", 60_000],
    ["0", 0],
    ["0s", 0],
    ["0m", 0],
    ["0h", 0],
    ["0ms", 0],
  ] as const) {
    assert.equal(N.validate(f({ deadline: v })).ok, true, v);
    assert.equal(N.body(f({ deadline: v }), "k").deadlineMs, ms, v);
  }
  for (const v of ["-1", "1.5h", "4d", "Infinity", "NaN", "-0", "h", "1 h", "99999999999999999999"]) {
    assert.match(N.validate(f({ deadline: v })).errors.deadline ?? "", /deadline/, v);
  }
  assert.equal(N.validate(f({ wrapup: "45s" })).ok, true);
  assert.match(N.validate(f({ wrapup: "0" })).errors.wrapup ?? "", /positive/); // CLI: "--wrapup must be positive"
  assert.match(N.validate(f({ wrapup: "0s" })).errors.wrapup ?? "", /positive/);
  for (const v of ["-1", "1.5h", "4d", "soon"]) assert.match(N.validate(f({ wrapup: v })).errors.wrapup ?? "", /wrapup/, v);
  // budget: the CLI's "$5"/"$.5" dollar forms are accepted (a bare number is dollars here, micros in the CLI)
  assert.equal(N.body(f({ budget: "$.5" }), "k").budgetMicros, 500_000);
  assert.equal(N.body(f({ budget: "$5" }), "k").budgetMicros, 5_000_000);
  for (const v of ["$", "$-1", "1e3", "0x10", "$0", "1,5", "9999999999999999999"]) assert.match(N.validate(f({ budget: v })).errors.budget ?? "", /budget/, v);
});

test("new-agent logic: validate refuses what POST /v1/agents would 400 (negative variants)", () => {
  const N = logic();
  const ok = { task: "t" };
  assert.equal(N.validate(ok).ok, true);
  assert.equal(N.validate({ ...ok, deadline: "0", wrapup: "1" }).ok, true);
  const bad = N.validate({ task: "", budget: "0", deadline: "-5", wrapup: "0" });
  assert.deepEqual(Object.keys(bad.errors).sort(), ["budget", "deadline", "task", "wrapup"]);
  // fork/fromCommit/sessionRef have nothing the form can get wrong: blank is omitted, anything else is a non-empty string
  assert.equal(N.validate({ ...ok, fork: true, fromCommit: "x", sessionRef: "y" }).ok, true);
});

test("new-agent logic: template detail lines show only the fields present", () => {
  const N = logic();
  assert.deepEqual([...N.templateLines(undefined)], []);
  assert.deepEqual([...N.templateLines({ id: "x" })], []);
  assert.deepEqual(
    [
      ...N.templateLines({
        id: "t",
        provider: "anthropic",
        model: "m1",
        egress: { kind: "allowlist", hosts: ["a.com", "b.org"] },
        allowlist: "analyst",
        browser: { maxSteps: 20, maxMs: 60000 },
        budgetMicros: 1_500_000,
      }),
    ],
    [
      "model: anthropic/m1",
      "egress: allowlist (a.com, b.org)",
      "allowlist profile: analyst",
      "browser: 20 steps, 60000 ms",
      "budget: $1.50 (used when the budget field is blank)",
    ],
  );
  assert.deepEqual([...N.templateLines({ id: "t", egress: { kind: "audited-public" } })], ["egress: audited-public"]);
});

test("new-agent pane: selecting a template shows its details; unconfigured templates leave the form usable", async () => {
  const r = runShell("#/new", {
    "/v1/templates": { body: [{ id: "py", egress: { kind: "registry" }, budgetMicros: 2_000_000 }, { id: "plain" }] },
  });
  await flush();
  const sel = r.doc.getElementById("new-template")!;
  const detail = r.doc.getElementById("new-template-detail")!;
  assert.equal(detail.children.length, 0); // "(default)" selected: nothing to show
  sel.value = "py";
  for (const fn of sel.listeners.get("change")!) fn({});
  assert.deepEqual(
    detail.children.map((c) => c.textContent),
    ["egress: registry", "budget: $2.00 (used when the budget field is blank)"],
  );
  sel.value = "plain";
  for (const fn of sel.listeners.get("change")!) fn({});
  assert.equal(detail.children.length, 0);

  const bad = runShell("#/new", {
    "/v1/templates": { status: 400, body: { error: "templates are not configured" } },
    "/v1/agents": { status: 201, body: { id: "n2" } },
  });
  await flush();
  assert.equal(bad.doc.getElementById("new-template-wrap")!.hidden, true);
  bad.doc.getElementById("new-task")!.value = "go";
  for (const fn of bad.doc.getElementById("new-submit")!.listeners.get("click")!) fn({});
  await flush();
  const posts = bad.fetches.filter((x) => x.init?.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal("template" in JSON.parse(posts[0]!.init!.body!), false);
});

test("new-agent pane: advanced and deadline fields are posted; invalid ones block the post and open Advanced", async () => {
  const r = runShell("#/new", { "/v1/agents": { status: 201, body: { id: "n3" } } });
  await flush();
  const el = (id: string) => r.doc.getElementById(id)!;
  const click = () => {
    for (const fn of el("new-submit").listeners.get("click")!) fn({});
  };
  el("new-task").value = "t";
  el("new-deadline").value = "nope";
  el("new-wrapup").value = "0";
  click();
  assert.match(el("new-deadline-err").textContent, /deadline/);
  assert.match(el("new-wrapup-err").textContent, /positive/);
  assert.equal(el("new-advanced").open, true);
  assert.equal(r.fetches.filter((x) => x.init?.method === "POST").length, 0);
  el("new-deadline").value = "0";
  el("new-wrapup").value = "30s";
  el("new-fork").checked = true;
  el("new-fromcommit").value = "abc123";
  el("new-sessionref").value = "sess";
  click();
  await flush();
  const posts = r.fetches.filter((x) => x.init?.method === "POST");
  assert.equal(posts.length, 1);
  const b = JSON.parse(posts[0]!.init!.body!);
  assert.deepEqual(
    { ...b, idempotencyKey: "k" },
    { task: "t", idempotencyKey: "k", deadlineMs: 0, wrapupMs: 30_000, fork: true, fromCommit: "abc123", sessionRef: "sess" },
  );
});

const walk = (n: FakeNode): FakeNode[] => [n, ...n.children.flatMap(walk)];

test("report viewer: html renders in an iframe with an EMPTY sandbox, a locked-sandbox banner, and Download/View source", async () => {
  const { doc } = runShell("#/reports/agent-1/r1", {
    "/v1/agents/agent-1/reports/r1": { body: { name: "x.html", mediaType: "text/html", id: "r1", agent: "agent-1" } },
  });
  await flush();
  const viewer = doc.getElementById("reports-viewer")!;
  assert.equal(viewer.hidden, false);
  assert.equal(doc.getElementById("reports-list")!.hidden, true);
  const nodes = walk(viewer);
  const frames = nodes.filter((n) => n.tagName === "iframe");
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.attrs.get("sandbox"), ""); // present and empty: no scripts, opaque origin
  assert.ok(![...frames[0]!.attrs.values()].some((v) => v.includes("allow-")));
  assert.equal(frames[0]!.attrs.get("src"), "/v1/agents/agent-1/reports/r1/render");
  const texts = nodes.map((n) => n.textContent).join("|");
  assert.ok(texts.includes("Rendered in a locked sandbox: scripts and network are disabled."));
  assert.ok(texts.includes("Download") && texts.includes("View source"));
  assert.ok(nodes.some((n) => n.tagName === "a" && n.href === "/v1/agents/agent-1/reports/r1?raw=1"));
  assert.ok(!texts.includes("scripts-enabled"));
});

test("report viewer: images use <img> via /render; unknown types are download-only; the list links to the viewer", async () => {
  const img = runShell("#/reports/a/r2", { "/v1/agents/a/reports/r2": { body: { name: "p.png", mediaType: "image/png" } } });
  await flush();
  const nodes = walk(img.doc.getElementById("reports-viewer")!);
  assert.ok(nodes.some((n) => n.tagName === "img" && n.attrs.get("src") === "/v1/agents/a/reports/r2/render"));
  assert.ok(!nodes.some((n) => n.tagName === "iframe"));
  const pdf = runShell("#/reports/a/r3", { "/v1/agents/a/reports/r3": { body: { name: "p.pdf", mediaType: "application/pdf" } } });
  await flush();
  const pn = walk(pdf.doc.getElementById("reports-viewer")!);
  assert.ok(!pn.some((n) => n.tagName === "iframe" || n.tagName === "img"));
  assert.ok(pn.some((n) => n.textContent.includes("cannot be previewed")));
  const list = runShell("#/reports", {
    "/v1/reports": { body: [{ agent: "a", report: { id: "r1", agent: "a", name: "x.html", mediaType: "text/html", sizeBytes: 3, createdAt: 0 } }] },
  });
  await flush();
  const links = walk(list.doc.getElementById("reports-rows")!)
    .filter((n) => n.tagName === "a")
    .map((n) => n.href);
  assert.deepEqual(links, ["#/reports/a/r1", "/v1/agents/a/reports/r1?raw=1"]);
});

// --- multi-instance terminal views ----------------------------------------------------------------

interface ViewHost {
  setTitle(text: string): void;
  navigate(hash: string): void;
}
interface ViewDef {
  id: string;
  title: string;
  multi: boolean;
  mount(root: FakeNode, params: { agent?: string }, host: ViewHost): { unmount(): void; fit?(): void };
}
const twoAgents = {
  "/v1/agents/a1": { body: { state: "running" } },
  "/v1/agents/b2": { body: { state: "running" } },
};
// A page whose single tile shows the tree (so no terminal is mounted by the shell), with the registered view mounted twice by hand.
function mountTwo() {
  const r = runShell("#/tree", twoAgents);
  const def = runInContext('PaneKit.view("terminal")', r.context) as ViewDef;
  const titles: string[] = [];
  const navs: string[] = [];
  const hostFor = (tag: string): ViewHost => ({ setTitle: (t) => titles.push(`${tag}:${t}`), navigate: (h) => navs.push(h) });
  const rootA = fakeNode();
  const rootB = fakeNode();
  const a = def.mount(rootA, { agent: "a1" }, hostFor("A"));
  const b = def.mount(rootB, { agent: "b2" }, hostFor("B"));
  const inRoot = (root: FakeNode, name: string) => root.querySelector(`[data-role="${name}"]`)!;
  return { ...r, def, titles, navs, rootA, rootB, a, b, inRoot };
}

test("view registry: registers one view per id, lists them, and rejects duplicate or malformed ids by naming the id", () => {
  const kit = runInContext(`(() => { ${PANE_KIT_JS}; return K; })()`, createContext({ globalThis: {}, JSON, Date, Math, Object, fetch: () => {} })) as {
    registerView(d: unknown): void;
    view(id: string): ViewDef | undefined;
    views(): ViewDef[];
  };
  const mount = () => ({ unmount() {} });
  const def = { id: "notes", title: "Notes", multi: false, mount };
  assert.equal(kit.view("notes"), undefined);
  kit.registerView(def);
  assert.equal(kit.view("notes")!.title, "Notes");
  assert.deepEqual(
    Array.from(kit.views(), (v) => v.id),
    ["notes"],
  );
  assert.throws(() => kit.registerView({ ...def, title: "Other" }), /view notes is already registered/);
  assert.equal(kit.view("notes")!.title, "Notes", "a rejected duplicate leaves the first registration");
  for (const bad of ["", "Has Space", "UP", 7, undefined]) {
    assert.throws(
      () => kit.registerView({ ...def, id: bad }),
      (e: Error) => /invalid view id/.test(e.message) && e.message.includes(JSON.stringify(bad) ?? "undefined"),
      `id ${String(bad)}`,
    );
  }
  assert.throws(() => kit.registerView({ id: "half", title: "Half" }), /view half needs a string title, a boolean multi and a mount function/);
  assert.equal(kit.view("half"), undefined);
});

test("view registry: the shell page registers the multi-instance terminal view once and refuses a second one", () => {
  const { context } = runShell("#/tree");
  const ids = runInContext("PaneKit.views().map((v) => v.id + ':' + v.multi)", context) as string[];
  assert.deepEqual([...ids], ["terminal:true"]);
  assert.throws(
    () => runInContext('PaneKit.registerView({ id: "terminal", title: "T", multi: true, mount() {} })', context),
    /view terminal is already registered/,
  );
});

test("terminal views: two instances for different agents mount into two roots without colliding", async () => {
  const { sockets, terms, observers, doc, rootA, rootB, inRoot, titles } = mountTwo();
  await flush();
  assert.deepEqual(
    sockets.map((s) => s.url),
    ["ws://ui.test/v1/agents/a1/terminal", "ws://ui.test/v1/agents/b2/terminal"],
  );
  assert.equal(terms.length, 2);
  // Identity checks via ok(): a failing equal() would try to diff two cyclic fake DOM trees.
  assert.ok(terms[0]!.host === inRoot(rootA, "host"), "A's xterm opens in A's root");
  assert.ok(terms[1]!.host === inRoot(rootB, "host"), "B's xterm opens in B's root");
  assert.ok(inRoot(rootA, "host") !== inRoot(rootB, "host"));
  assert.ok(observers[0]!.observed.length === 1 && observers[0]!.observed[0] === inRoot(rootA, "host"), "A's observer watches A's host");
  assert.ok(observers[1]!.observed.length === 1 && observers[1]!.observed[0] === inRoot(rootB, "host"), "B's observer watches B's host");
  assert.equal(inRoot(rootA, "title").textContent, "a1");
  assert.equal(inRoot(rootB, "title").textContent, "b2");
  assert.deepEqual(titles, ["A:Terminal \u00b7 a1", "B:Terminal \u00b7 b2"]);
  sockets[0]!.open();
  assert.equal(inRoot(rootA, "conn").textContent, "connected");
  assert.equal(inRoot(rootB, "conn").textContent, "connecting", "B is not touched by A's socket");
  const sentA = sockets[0]!.sent.length;
  terms[1]!.handlers.data!("x");
  assert.equal(sockets[0]!.sent.length, sentA, "input typed in B never reaches A's socket");
  assert.deepEqual(
    [...doc.byId.keys()].filter((k) => k.startsWith("term-")),
    [],
    "no document-level term-* id lookups",
  );
  assert.equal(inRoot(rootA, "keys").id !== inRoot(rootB, "keys").id, true, "generated ids differ between instances");
});

test("terminal views: unmounting one instance releases its resources and leaves the other running", async () => {
  const { sockets, terms, observers, intervals, timeouts, resize, resizeListeners, rootA, rootB, a, inRoot } = mountTwo();
  await flush();
  sockets[0]!.open();
  sockets[1]!.open();
  assert.equal(resizeListeners.length, 2);
  const before = timeouts.length;
  resize();
  const [fitA, fitB] = timeouts.slice(before) as [(typeof timeouts)[number], (typeof timeouts)[number]];
  const pollers = intervals.filter((i) => i.ms === 5000);
  assert.equal(pollers.length, 2);
  a.unmount();
  assert.equal(sockets[0]!.closed, true);
  assert.equal(terms[0]!.disposed, true);
  assert.equal(observers[0]!.disconnected, true);
  assert.equal(resizeListeners.length, 1, "only B's window resize listener remains");
  assert.equal(fitA.cleared, true);
  assert.equal(pollers[0]!.cleared, true);
  assert.equal(rootA.children.length, 0);
  assert.equal(sockets[1]!.closed, false);
  assert.equal(terms[1]!.disposed, false);
  assert.equal(observers[1]!.disconnected, false);
  assert.equal(fitB.cleared, false);
  assert.equal(pollers[1]!.cleared, false);
  assert.ok(rootB.children.length > 0);
  sockets[0]!.drop(); // a late close from the unmounted instance must not schedule a reconnect
  await flush();
  assert.equal(sockets.length, 2);
  terms[1]!.handlers.data!("y");
  assert.equal(text(sockets[1]!.sent.at(-1)), "y", "B still relays input");
  assert.equal(inRoot(rootB, "conn").textContent, "connected");
  a.unmount(); // idempotent
});

test("terminal views: unmounting one instance leaves another instance's trace viewer open", async () => {
  const r = mountTwo();
  await flush();
  clickEl(r.inRoot(r.rootB, "trace-view"));
  await flush();
  assert.equal(r.pageBody.children.length, 1);
  r.a.unmount();
  assert.equal(r.pageBody.children.length, 1, "A did not open the viewer, so unmounting A keeps it");
  r.b.unmount();
  assert.equal(r.pageBody.children.length, 0, "the owner's unmount dismisses it");
});

test("terminal views: the view never writes location.hash; navigation is the host's job", async () => {
  const r = mountTwo();
  await flush();
  r.sockets[0]!.open();
  clickEl(r.inRoot(r.rootA, "reconnect"));
  r.a.unmount();
  r.b.unmount();
  assert.equal(r.location.hash, "#/tree");
  assert.deepEqual(r.navs, []);
  const viewBody = renderTerminalPane().split("const mountTerminal")[1]!.split("K.registerView")[0]!;
  assert.ok(viewBody.length > 1000, "extracted the view body");
  assert.ok(!/location\.hash\s*=[^=]/.test(viewBody), "no location.hash assignment in the view");
  assert.ok(!viewBody.includes("hashchange"), "no hashchange listener in the view");
});

test("terminal views: a mount that throws during setup clears what it put in the root and rethrows", () => {
  const r = mountTwo();
  const root = fakeNode();
  // A host without setTitle makes the mount throw after the template was cloned into root.
  assert.throws(() => r.def.mount(root, { agent: "a1" }, {} as ViewHost), /setTitle/);
  assert.equal(root.children.length, 0, "the cloned template is removed again");
  const normal = fakeNode();
  r.def.mount(normal, { agent: "a1" }, { setTitle() {}, navigate() {} }).unmount();
  assert.equal(normal.children.length, 0, "a normal unmount still clears the root");
});

// Changed from the legacy single-section adapter test: the tiling shell mounts the terminal per tile, remounts when the
// focused tile's agent changes, and unmounts when the tile's view changes.
test("terminal views: the tiling shell mounts one terminal per tile, remounts on agent change and cleans up", async () => {
  const { doc, sockets, navigate, observers } = runShell("#/terminal/a1", running);
  await flush();
  const wm = doc.getElementById("wm-root")!;
  assert.equal(countMounts(wm), 1, "one mount root in the tile");
  navigate("#/terminal/b2");
  await flush();
  assert.equal(countMounts(wm), 1, "the old root is removed on remount");
  assert.equal(sockets[0]!.closed, true);
  assert.equal(observers[0]!.disconnected, true);
  navigate("#/audit");
  assert.equal(countMounts(wm), 0);
  assert.equal(observers[1]!.disconnected, true);
});

test("terminal views: the vendored xterm libraries load once per page across instances", async () => {
  const r = runShell("#/tree", twoAgents);
  const { Terminal, FitAddon } = r.context as { Terminal: unknown; FitAddon: unknown };
  runInContext("delete globalThis.Terminal; delete globalThis.FitAddon;", r.context);
  const def = runInContext('PaneKit.view("terminal")', r.context) as ViewDef;
  const host: ViewHost = { setTitle() {}, navigate() {} };
  def.mount(fakeNode(), { agent: "a1" }, host);
  def.mount(fakeNode(), { agent: "b2" }, host);
  const loaded = () => r.headNodes.filter((n) => n.tagName === "script").map((n) => (n as unknown as { src: string }).src);
  assert.deepEqual(loaded(), ["/ui/vendor/xterm.js"]);
  assert.equal(r.headNodes.filter((n) => n.tagName === "link").length, 1, "one stylesheet");
  for (const name of ["xterm.js", "addon-fit.js", "addon-webgl.js"]) {
    await flush();
    const el = r.headNodes.filter((n) => n.tagName === "script").at(-1) as unknown as { src: string; onload(): void };
    assert.equal(el.src, "/ui/vendor/" + name);
    if (name === "xterm.js") Object.assign(r.context, { Terminal });
    if (name === "addon-fit.js") Object.assign(r.context, { FitAddon });
    el.onload();
  }
  await flush();
  assert.equal(r.terms.length, 2, "both instances mounted xterm once the shared load finished");
  assert.equal(loaded().length, 3);
});

// Terminal review follow-ups.
test("terminal: unmounting removes its colour-scheme change listener and clears retry and tick timers mid-backoff", async () => {
  const r = runShell("#/terminal/a1", running);
  await flush();
  const dark = "(prefers-color-scheme: dark)";
  assert.equal(r.mqListeners.get(dark)!.size, 1, "the view listens while mounted");
  r.sockets[0]!.open();
  r.sockets[0]!.drop();
  await flush();
  assert.ok(
    r.timeouts.some((x) => !x.cleared && x.ms !== 120),
    "a retry timer is pending during backoff",
  );
  assert.ok(
    r.intervals.some((i) => !i.cleared),
    "the countdown tick is running during backoff",
  );
  r.navigate("#/audit");
  assert.equal(r.mqListeners.get(dark)!.size, 0, "the listener is removed on unmount");
  assert.ok(
    r.timeouts.filter((x) => x.ms !== 120).every((x) => x.cleared),
    "retry timer cleared",
  );
  assert.ok(
    r.intervals.every((i) => i.cleared),
    "tick cleared",
  );
});

test("terminal: the trace viewer belongs to the instance that opened it; A opens, B clicks, A unmounts", async () => {
  const r = mountTwo();
  await flush();
  clickEl(r.inRoot(r.rootA, "trace-view"));
  await flush();
  assert.equal(r.pageBody.children.length, 1);
  clickEl(r.inRoot(r.rootB, "trace-view")); // reuses A's viewer and must not take it over
  assert.equal(r.pageBody.children.length, 1);
  r.a.unmount();
  assert.equal(r.pageBody.children.length, 0, "A's unmount dismissed the viewer it created");
  clickEl(r.inRoot(r.rootB, "trace-view")); // B opens a fresh one and owns it
  await flush();
  assert.equal(r.pageBody.children.length, 1);
  r.b.unmount();
  assert.equal(r.pageBody.children.length, 0);
});

test("terminal: a missing template fails with a cause and an action instead of a TypeError", () => {
  const r = mountTwo();
  (r.context as { document: { querySelector: unknown } }).document.querySelector = () => null;
  assert.throws(() => r.def.mount(fakeNode(), { agent: "a1" }, { setTitle() {}, navigate() {} }), /template is missing from the page.*reload the page/);
});

test("terminal: a copy still in flight when the view unmounts opens no manual-copy modal", async () => {
  const r = mountTwo();
  await flush();
  Object.assign(r.context, { navigator: { clipboard: { writeText: () => Promise.reject(new Error("denied")) } } });
  clickEl(r.inRoot(r.rootA, "trace"));
  r.a.unmount(); // before the fetch and clipboard promises settle
  await flush();
  await flush();
  assert.equal(r.pageBody.children.length, 0);
  // negative control: the same click on a mounted view does open the modal
  clickEl(r.inRoot(r.rootB, "trace"));
  await flush();
  await flush();
  assert.equal(r.pageBody.children.length, 1, "the modal opens when the view is still mounted");
});

test("terminal: a failed library load then a retry appends the stylesheet link once", async () => {
  const r = runShell("#/tree", twoAgents);
  runInContext("delete globalThis.Terminal; delete globalThis.FitAddon;", r.context);
  const def = runInContext('PaneKit.view("terminal")', r.context) as ViewDef;
  def.mount(fakeNode(), { agent: "a1" }, { setTitle() {}, navigate() {} });
  await flush();
  const first = r.headNodes.filter((n) => n.tagName === "script").at(-1) as unknown as { onerror(): void };
  first.onerror();
  await flush();
  def.mount(fakeNode(), { agent: "b2" }, { setTitle() {}, navigate() {} });
  await flush();
  assert.equal(r.headNodes.filter((n) => n.tagName === "link").length, 1, "one stylesheet across the retry");
});
