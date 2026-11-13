import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext, type Context } from "node:vm";
import { renderAuditPane, renderEscalationsPane, renderHostsPane, renderSchedulesPane, renderTerminalPane } from "./tabs.ts";
import { NEW_AGENT_LOGIC_JS, renderNewAgentPane } from "./newAgent.ts";
import { PANE_KIT_JS } from "./paneKit.ts";
import { renderShell } from "./shell.ts";
import { MENU_KIT_JS, type MenuKitApi } from "./menuModel.ts";
import { TERMINAL_DECLARATION } from "./viewMenus.ts";
import { renderReportsPane, renderTreePane } from "./web.ts";

// The reconnect jitter (+-25%, Math.random) can land a retry delay on exactly 800 ms, the overlay grace delay these tests tell
// timers apart by. A pinned midpoint makes every backoff the exact base step (500, 1000, ...), never 800.
const unjitteredMath = Object.assign(Object.create(Math) as Math, { random: () => 0.5 });

test("audit pane is fully inline, fetches the journal path, and has filter and more controls", () => {
  const html = renderAuditPane();
  assert.ok(html.includes('K.getJson("/v1/journal"'));
  assert.ok(html.includes('"audit.agent"') && html.includes('"audit.kind"') && html.includes('"audit.more"'));
  assert.ok(!html.includes('id="agent-filter"') && !html.includes('id="more"'));
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

// Shared skeleton: the four browsing panes share one root shape and one pane-body, with no row of their own above it.
test("audit, hosts, schedules and escalations follow the shared pane skeleton", () => {
  const panes: [string, string, string, string][] = [
    ["audit", renderAuditPane(), 'class="audit pane"', '<div class="tablewrap pane-body">'],
    ["hosts", renderHostsPane(), 'class="hosts pane"', '<div class="tablewrap pane-body">'],
    ["schedules", renderSchedulesPane(), 'class="schedules pane"', '<div class="tablewrap pane-body">'],
    ["escalations", renderEscalationsPane(), 'class="escalations pane"', '<ul id="escalations" class="card-list pane-body">'],
  ];
  for (const [name, html, root, body] of panes) {
    assert.ok(html.startsWith("<div " + root.slice(0, -1) + '">') || html.startsWith("<div " + root + ">"), name + " root");
    assert.equal(html.split("pane-body").length - 1, 1, name + " has exactly one pane-body");
    assert.ok(html.includes(body), name + " body kind");
    const markup = html.slice(0, html.indexOf("<script>"));
    assert.ok(!/<h[1-6]/.test(markup), name + " has no heading");
    assert.ok(!markup.includes("filters") && !markup.includes("<pre") && !markup.includes("<style"), name + " has no filters row, pre or style");
    assert.ok(!html.includes("hosts-status") || name === "none", name + " no pre#hosts-status");
  }
  assert.ok(!renderHostsPane().includes("hosts-status"));
});

test("audit declares its filters and More in the window chrome, with a count slot", () => {
  const { context } = runShell("#/audit");
  const decl = JSON.parse(runInContext('JSON.stringify(PaneKit.sectionModel("audit").declaration)', context) as string) as {
    controls: { kind: string; command: string; placeholder?: string; label: string }[];
    status: { id: string }[];
  };
  assert.deepEqual(
    decl.controls.map((c) => c.kind + ":" + c.command + ":" + (c.placeholder ?? "")),
    ["search:audit.agent:agent", "search:audit.kind:kind", "button:audit.more:"],
  );
  assert.deepEqual(
    decl.status.map((x) => x.id),
    ["count"],
  );
});

test("audit: a typed filter reloads from the start with the filter, More pages on from the cursor, count tracks rows", async () => {
  const responses: Record<string, { body: Json }> = {
    "/v1/journal": {
      body: [
        { seq: 4, ts: 0, agent: "a1", kind: "spawn", summary: "s" },
        { seq: 5, ts: 1, agent: "a1", kind: "spawn", summary: "t" },
      ],
    },
  };
  const { doc, fetches, context } = runShell("#/audit", responses);
  await flush();
  const run = (cmd: string, arg?: string) =>
    runInContext(`PaneKit.sectionModel("audit").invoke(${JSON.stringify(cmd)}, ${JSON.stringify(arg)}).ok`, context) as boolean;
  const count = () => runInContext('PaneKit.sectionModel("audit").status().map((x) => x.id + "=" + x.text).join()', context) as string;
  assert.equal(doc.getElementById("audit-rows")!.children.length, 2);
  assert.equal(count(), "count=2 events");
  assert.ok(run("audit.agent", "  a1 "));
  await flush();
  assert.ok(fetches.at(-1)!.url.includes("agent=a1") && fetches.at(-1)!.url.includes("from=0"), fetches.at(-1)!.url);
  assert.ok(run("audit.kind", "spawn"));
  await flush();
  assert.ok(fetches.at(-1)!.url.includes("agent=a1") && fetches.at(-1)!.url.includes("kind=spawn"));
  assert.ok(run("audit.more"));
  await flush();
  assert.ok(fetches.at(-1)!.url.includes("from=6"), fetches.at(-1)!.url);
  assert.equal(doc.getElementById("audit-rows")!.children.length, 4);
  assert.ok(run("audit.agent", ""));
  await flush();
  assert.ok(!fetches.at(-1)!.url.includes("agent="), "an emptied filter is dropped");
});

// Gated audit fetches: each journal request waits until the test settles it, so responses can arrive out of order.
function gatedAudit() {
  const pending: { url: string; ok: (rows: Json) => void; fail: () => void }[] = [];
  const respond = (url: string) =>
    new Promise<unknown>((resolve, reject) => {
      pending.push({
        url,
        ok: (rows) => resolve({ ok: true, status: 200, json: async () => rows, text: async () => "", headers: { get: () => null } }),
        fail: () => reject(new TypeError("fetch failed: ECONNREFUSED")),
      });
    });
  const o = runShell("#/audit", { "/v1/journal": { body: [], respond } });
  const run = (cmd: string, arg?: string) =>
    runInContext(`PaneKit.sectionModel("audit").invoke(${JSON.stringify(cmd)}, ${JSON.stringify(arg)}).ok`, o.context) as boolean;
  const count = () => runInContext('PaneKit.sectionModel("audit").status().map((x) => x.text).join()', o.context) as string;
  const cells = () => o.doc.getElementById("audit-rows")!.children.map((tr) => tr.children.map((c) => c.textContent).join("|"));
  const row = (seq: number, agent: string) => ({ seq, ts: 0, agent, kind: "k", summary: "s" + seq });
  return { ...o, pending, run, count, cells, row };
}

test("audit: overlapping loads resolved out of order keep only the newest filter's rows", async () => {
  const g = gatedAudit();
  await flush();
  g.pending[0]!.ok([]); // the activation load
  await flush();
  g.run("audit.agent", "a1");
  g.run("audit.agent", "b2");
  assert.equal(g.pending.length, 3);
  g.pending[2]!.ok([g.row(1, "b2")]);
  await flush();
  g.pending[1]!.ok([g.row(1, "a1"), g.row(2, "a1")]); // the older request resolves last
  await flush();
  assert.deepEqual(
    g.cells().map((c) => c.split("|")[1]),
    ["b2"],
  );
  assert.equal(g.count(), "1 events");
});

test("audit: a More page that resolves after a filter change is dropped", async () => {
  const g = gatedAudit();
  await flush();
  g.pending[0]!.ok([g.row(1, "x")]);
  await flush();
  g.run("audit.more");
  g.run("audit.agent", "b2");
  assert.equal(g.pending.length, 3);
  g.pending[2]!.ok([g.row(1, "b2")]);
  await flush();
  g.pending[1]!.ok([g.row(2, "x"), g.row(3, "x")]);
  await flush();
  assert.deepEqual(
    g.cells().map((c) => c.split("|")[1]),
    ["b2"],
  );
  assert.ok(g.pending[2]!.url.includes("agent=b2") && g.pending[2]!.url.includes("from=0"));
});

test("audit: More clicked twice before the first page arrives requests one page; it works again after settling or failing", async () => {
  const g = gatedAudit();
  await flush();
  g.pending[0]!.ok([g.row(1, "x")]);
  await flush();
  g.run("audit.more");
  g.run("audit.more");
  assert.equal(g.pending.length, 2, "the second More while one is pending sends nothing");
  g.pending[1]!.ok([g.row(2, "x")]);
  await flush();
  assert.equal(g.cells().length, 2, "one page appended, not two");
  g.run("audit.more");
  assert.equal(g.pending.length, 3, "More works again once the page settled (negative control)");
  g.pending[2]!.fail();
  await flush();
  g.run("audit.more");
  assert.equal(g.pending.length, 4, "More works again after a failed page");
  g.run("audit.agent", "b2");
  assert.equal(g.pending.length, 5, "a filter change is never blocked by a pending More");
});

test("audit: a failed stale request shows no error over newer rows; the newest failing does", async () => {
  const g = gatedAudit();
  await flush();
  g.pending[0]!.ok([]);
  await flush();
  g.run("audit.agent", "a1");
  g.run("audit.agent", "b2");
  g.pending[2]!.ok([g.row(1, "b2")]);
  await flush();
  g.pending[1]!.fail();
  await flush();
  assert.deepEqual(
    g.cells().map((c) => c.split("|")[1]),
    ["b2"],
  );
  assert.equal(g.count(), "1 events");
  // negative control: the newest request failing shows the error and keeps the last count
  g.run("audit.agent", "c3");
  g.pending[3]!.fail();
  await flush();
  assert.ok(g.cells()[0]!.includes("Failed to load journal"), g.cells().join());
  assert.equal(g.count(), "1 events");
});

test("hosts renders one table row per host with its cells, and the empty hint", async () => {
  const body = { host: "h1", maxConcurrent: 2, running: ["a1", "a2"], queue: [{ agent: "q1", priority: 3 }] };
  const { doc } = runShell("#/hosts", { "/v1/placement": { body } });
  await flush();
  const rows = doc.getElementById("hosts-rows")!.children;
  assert.equal(rows.length, 1);
  assert.deepEqual(
    rows[0]!.children.map((c) => c.textContent),
    ["h1", "2", "2", "1", "a1, a2", "q1 (p3)"],
  );
  const none = runShell("#/hosts", { "/v1/placement": { body: { host: "h1", maxConcurrent: 2, running: [], queue: [] } } });
  await flush();
  const hint = none.doc.getElementById("hosts-rows")!.children[1]!.children[0]!.textContent;
  assert.ok(hint.startsWith("No agents yet") && hint.includes('pomtree spawn --task "..."'), hint);
  assert.equal(runInContext('PaneKit.sectionModel("hosts").status().map((x) => x.text).join()', none.context), "0 running, 0 queued");
  assert.equal(runInContext('PaneKit.sectionModel("hosts").status().map((x) => x.text).join()', runShell("#/hosts").context), "");
});

test("escalations: open cards are warn-toned and the empty state is a pane-empty row", async () => {
  const responses: Record<string, { body: Json }> = {
    "/v1/escalations": { body: [{ id: "e1", agent: "a", question: "q?", options: [], createdAt: Date.now() }] },
  };
  const { doc, context } = runShell("#/escalations", responses);
  await flush();
  const list = doc.getElementById("escalations")!;
  assert.deepEqual(
    list.children.map((c) => c.className),
    ["tone-warn"],
  );
  assert.equal(doc.getElementById("escalations-status")!.hidden, true);
  assert.equal(runInContext('PaneKit.sectionModel("escalations").status().map((x) => x.text).join()', context), "1 open");
  const empty = runShell("#/escalations", { "/v1/escalations": { body: [] } });
  await flush();
  const li = empty.doc.getElementById("escalations")!.children;
  assert.deepEqual(
    li.map((c) => c.className + ":" + c.textContent),
    ["pane-empty:No open escalations"],
  );
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

// The window host the terminal drives: records every menu-state and status push (merged per key, as the model does)
// and keeps the command handler so a test can invoke a menu command the way the chrome would.
interface FakeHost {
  api: {
    setMenuState(c: string, s: Record<string, unknown>): void;
    setStatus(id: string, s: Record<string, unknown>): void;
    onCommand(fn: (c: string, a?: unknown) => void): void;
  };
  menu: Record<string, Record<string, unknown>>;
  menuCalls: [string, Record<string, unknown>][];
  status: Record<string, { text: string; tone?: string | null }>;
  titles: string[];
  run(command: string, arg?: unknown): void;
}
function fakeHost(): FakeHost {
  // The REAL status validator: a bad tone throws as it does in the browser.
  const kit = runInContext(
    `(() => { ${MENU_KIT_JS}; return MenuKit; })()`,
    createContext({ globalThis: {}, JSON, Object, Array, Set, Map, String, Error, WeakSet }),
  ) as MenuKitApi;
  const model = kit.createWindowModel(kit.declareView(TERMINAL_DECLARATION));
  let handler: ((c: string, a?: unknown) => void) | undefined;
  const h: FakeHost = {
    api: {
      setMenuState: (c, s) => {
        h.menuCalls.push([c, { ...s }]);
        h.menu[c] = { ...h.menu[c], ...s };
      },
      setStatus: (id, s) => {
        model.setStatus(id, s as never);
        h.status[id] = { ...h.status[id], ...s } as { text: string; tone?: string | null };
      },
      onCommand: (fn) => {
        handler = fn;
      },
    },
    menu: {},
    menuCalls: [],
    status: {},
    titles: [],
    run: (c, a) => handler!(c, a),
  };
  return h;
}

function runShell(
  hash: string,
  responses: Record<string, { ok?: boolean; status?: number; body: Json; fail?: boolean; respond?: (url: string) => Promise<unknown> }> = {},
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
      activeElement: null,
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
      if (r.respond) return r.respond(url) as Promise<never>;
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
    Math: unjitteredMath,
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
  // Every terminal mounted (by the shell or by hand) gets a recording fake of the window host's menu and status hooks:
  // the wrapper goes in right after the terminal script registers the view, before the shell script mounts anything.
  const hosts: FakeHost[] = [];
  const wrapTerminalMount = () => {
    const termDef = runInContext('PaneKit.view("terminal")', context) as { mount: (root: unknown, params: unknown, base: object) => unknown };
    const realMount = termDef.mount;
    termDef.mount = (root: unknown, params: unknown, base: object) => {
      const h = fakeHost();
      hosts.push(h);
      const baseTitle = (base as { setTitle?(t: string): void }).setTitle;
      const setTitle = (t: string) => {
        h.titles.push(t);
        baseTitle?.(t);
      };
      // A host without setTitle stays without it (one test relies on the mount failing on that).
      return realMount(root, params, Object.assign(base, h.api, baseTitle ? { setTitle } : {}));
    };
  };
  for (const src of scripts) {
    // The launcher bar script polls the API and has its own DOM fake tests (launcherShell); the pane harness leaves it out.
    if (src.includes("createLauncherBar(")) continue;
    runInContext(src, context, { filename: "inline.js" });
    if (src.includes('K.registerView({ id: "terminal"')) wrapTerminalMount();
  }
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
    hosts,
    // The first terminal's host, resolved on use: the shell mounts the terminal after runShell returns.
    host: new Proxy({} as FakeHost, { get: (_t, k) => hosts[0]![k as keyof FakeHost] }),
  };
}

// A terminal-view element by data-role, inside the first terminal mounted in a tile of the tiling shell.
const statusText = (h: FakeHost, slot: string): string => h.status[slot]?.text ?? "";
const reconnectOffered = (h: FakeHost): boolean => h.menu["terminal.reconnect"]?.visible === true;
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
  const { doc, host } = runShell("#/terminal/agent-7");
  assert.deepEqual(shownTab(doc), []);
  assert.equal(countMounts(doc.getElementById("wm-root")!), 1);
  assert.equal(host.titles.at(-1), "Terminal \u00b7 agent-7");
  const tree = runShell("#/tree");
  assert.deepEqual(shownTab(tree.doc), ["tree"]);
});

const running = { "/v1/agents/a1": { body: { state: "running" } } };
const text = (b: unknown) => new TextDecoder().decode(b as Uint8Array);
const termOverlay = (doc: FakeDoc) => {
  const n = role(doc, "wrap").children.find((c) => c.className.split(" ").includes("stale-overlay"))!;
  return {
    hidden: n.hidden === true,
    kind: (n.className.split(" ")[1] ?? "stale-none").slice(6),
    label: n.children[1]!.textContent,
    icon: n.children[0]!.className,
    role: n.getAttribute("role"),
    live: n.getAttribute("aria-live"),
  };
};
const clickEl = (n: { listeners: Map<string, ((ev: unknown) => void)[]> }, ev: unknown = {}) => {
  for (const fn of n.listeners.get("click") ?? []) fn(ev);
};
const keyBtn = (key: string) => {
  const b = fakeNode();
  b.setAttribute("data-key", key);
  return { target: b };
};

test("terminal: connects to the per-agent websocket, resets, sends the fitted size, relays bytes both ways", async () => {
  const { sockets, terms, host } = runShell("#/terminal/a1", running);
  await flush();
  assert.equal(sockets.length, 1);
  const ws = sockets[0]!;
  assert.equal(ws.url, "ws://ui.test/v1/agents/a1/terminal");
  assert.equal(ws.binaryType, "arraybuffer");
  assert.equal(statusText(host, "connection"), "connecting");
  assert.equal(host.titles.at(-1), "Terminal \u00b7 a1");
  ws.open();
  const t = terms[0]!;
  assert.equal(t.resets, 1);
  assert.ok(t.focused >= 1);
  assert.equal(statusText(host, "connection"), "connected");
  assert.deepEqual(ws.sent.map(String), ['{"type":"resize","cols":100,"rows":30}']); // fit on open -> one control frame
  ws.onmessage!({ data: new Uint8Array([104, 105]).buffer });
  assert.equal(text(t.writes[0]), "hi");
  t.handlers.data!("ls\r");
  assert.ok(ws.sent[1] instanceof Uint8Array);
  assert.equal(text(ws.sent[1]), "ls\r");
  t.handlers.binary!("\u00ff\u0001");
  assert.deepEqual([...(ws.sent[2] as Uint8Array)], [255, 1]);
});

test("terminal overlay: first connect shows a spinner at once; the first open clears it and resets nothing stale", async () => {
  const { doc, sockets, terms, timeouts } = runShell("#/terminal/a1", running);
  await flush();
  assert.deepEqual(termOverlay(doc), {
    hidden: false,
    kind: "busy",
    label: "Connecting\u2026",
    icon: "stale-icon stale-spinner",
    role: "status",
    live: "polite",
  });
  assert.equal(timeouts.filter((x) => x.ms === 800).length, 0, "nothing to keep, so no grace delay");
  sockets[0]!.open();
  assert.equal(termOverlay(doc).hidden, true);
  assert.equal(terms[0]!.resets, 1);
});

test("terminal overlay: a drop keeps the screen (no dispose, no reset) and shows the spinner after the grace delay", async () => {
  const { doc, sockets, terms, timeouts, host } = runShell("#/terminal/a1", running);
  await flush();
  sockets[0]!.open();
  sockets[0]!.onmessage!({ data: new Uint8Array([104]).buffer });
  sockets[0]!.drop();
  await flush();
  assert.equal(termOverlay(doc).hidden, true, "inside the grace delay");
  const grace = timeouts.filter((x) => x.ms === 800 && !x.cleared).pop()!;
  assert.ok(grace, "grace timer armed");
  grace.fn();
  assert.deepEqual(termOverlay(doc), {
    hidden: false,
    kind: "busy",
    label: "Reconnecting\u2026",
    icon: "stale-icon stale-spinner",
    role: "status",
    live: "polite",
  });
  assert.equal(terms[0]!.disposed, false);
  assert.equal(terms[0]!.resets, 1, "the screen was not wiped");
  assert.notEqual(role(doc, "wrap")!.style.display, "none");
  assert.equal(statusText(host, "connection"), "disconnected", "footer keeps the state text");
});

test("terminal overlay: a quick reconnect cancels the grace timer and never paints the spinner", async () => {
  const { doc, sockets, timeouts } = runShell("#/terminal/a1", running);
  await flush();
  sockets[0]!.open();
  sockets[0]!.drop();
  await flush();
  const grace = timeouts.filter((x) => x.ms === 800 && !x.cleared).pop()!;
  assert.ok(grace);
  timeouts
    .filter((x) => !x.cleared && x.ms !== 120 && x.ms !== 800)
    .pop()!
    .fn();
  assert.equal(termOverlay(doc).hidden, true, "still inside the grace delay while the new socket connects");
  sockets[1]!.open();
  sockets[1]!.onmessage!({ data: new Uint8Array([1]).buffer });
  assert.equal(timeouts.filter((x) => x.ms === 800 && !x.cleared).length, 0, "no grace timer left that could paint the spinner");
  assert.equal(termOverlay(doc).hidden, true);
});

test("terminal overlay: after a reopen the old screen stays under the spinner until the replay's first bytes; the replay then renders from a reset screen", async () => {
  const { doc, sockets, terms, timeouts } = runShell("#/terminal/a1", running);
  await flush();
  sockets[0]!.open();
  sockets[0]!.onmessage!({ data: new Uint8Array([111]).buffer }); // old screen content
  sockets[0]!.drop();
  await flush();
  timeouts
    .filter((x) => !x.cleared && x.ms !== 120 && x.ms !== 800)
    .pop()!
    .fn();
  sockets[1]!.open();
  const t = terms[0]!;
  assert.equal(t.resets, 1, "no wipe on open");
  assert.equal(t.writes.length, 1);
  timeouts
    .filter((x) => x.ms === 800 && !x.cleared)
    .pop()!
    .fn();
  assert.equal(termOverlay(doc).kind, "busy");
  assert.equal(termOverlay(doc).label, "Restoring screen\u2026");
  sockets[1]!.onmessage!({ data: new Uint8Array([114]).buffer });
  assert.equal(t.resets, 2, "reset happens before the first replay byte is written");
  assert.equal(t.writes.length, 2);
  assert.equal(text(t.writes[1]), "r");
  assert.equal(termOverlay(doc).hidden, true);
  sockets[1]!.onmessage!({ data: new Uint8Array([115]).buffer });
  assert.equal(t.resets, 2, "later frames do not reset again");
});

test("terminal overlay: an empty replay resets and clears the overlay after the wait; a drop before any byte keeps the screen", async () => {
  const a = runShell("#/terminal/a1", running);
  await flush();
  a.sockets[0]!.open();
  a.sockets[0]!.drop();
  await flush();
  a.timeouts
    .filter((x) => !x.cleared && x.ms !== 120 && x.ms !== 800)
    .pop()!
    .fn();
  a.sockets[1]!.open();
  const wait = a.timeouts.filter((x) => !x.cleared && x.ms === 1500).pop()!;
  assert.ok(wait, "replay wait timer armed");
  wait.fn();
  assert.equal(a.terms[0]!.resets, 2);
  assert.equal(termOverlay(a.doc).hidden, true);
  // the socket dies before any replay byte: nothing is wiped and the timer is cancelled
  const b = runShell("#/terminal/a1", running);
  await flush();
  b.sockets[0]!.open();
  b.sockets[0]!.drop();
  await flush();
  b.timeouts
    .filter((x) => !x.cleared && x.ms !== 120 && x.ms !== 800)
    .pop()!
    .fn();
  b.sockets[1]!.open();
  const w = b.timeouts.filter((x) => !x.cleared && x.ms === 1500).pop()!;
  b.sockets[1]!.drop();
  await flush();
  assert.equal(w.cleared, true);
  assert.equal(b.terms[0]!.resets, 1, "negative control: the screen was never wiped");
});

test("terminal overlay: a finished agent is a danger overlay with the cause, a yielded one a pause; the screen stays", async () => {
  const done = runShell("#/terminal/a1", { "/v1/agents/a1": { body: { state: "exited" } } });
  await flush();
  done.sockets[0]!.open();
  done.sockets[0]!.drop();
  await flush();
  const o = termOverlay(done.doc);
  assert.equal(o.kind, "dead");
  assert.match(o.label, /^Disconnected: no live terminal: agent exited/);
  assert.notEqual(role(done.doc, "wrap")!.style.display, "none");
  assert.equal(done.terms[0]!.disposed, false);
  const y = runShell("#/terminal/a1", { "/v1/agents/a1": { body: { state: "yielded" } } });
  await flush();
  y.sockets[0]!.open();
  y.sockets[0]!.drop();
  await flush();
  assert.equal(termOverlay(y.doc).kind, "idle");
  const gaveUp = runShell("#/terminal/a1", running);
  await flush();
  const pendingRetries = () => gaveUp.timeouts.filter((x) => !x.cleared && x.ms !== 120 && x.ms !== 800);
  // MAX_ATTEMPTS (12) drops each arm a retry; the next drop arms none and gives up.
  for (let i = 0; i < 12; i++) {
    gaveUp.sockets[gaveUp.sockets.length - 1]!.drop();
    await flush();
    const retry = pendingRetries().pop();
    assert.ok(retry, `drop ${i + 1} armed no retry timer (timers: ${JSON.stringify(gaveUp.timeouts.map((x) => [x.ms, x.cleared]))})`);
    retry.fn();
  }
  gaveUp.sockets[gaveUp.sockets.length - 1]!.drop();
  await flush();
  assert.equal(pendingRetries().length, 0, "the drop past the budget arms no retry");
  assert.deepEqual(termOverlay(gaveUp.doc), {
    hidden: false,
    kind: "dead",
    label: "Disconnected: gave up reconnecting",
    icon: "stale-icon",
    role: "status",
    live: "polite",
  });
});

test("terminal overlay: unmount cancels the grace and replay timers", async () => {
  const r = runShell("#/terminal/a1", running);
  await flush();
  r.sockets[0]!.open();
  r.sockets[0]!.drop();
  await flush();
  const grace = r.timeouts.filter((x) => x.ms === 800 && !x.cleared).pop()!;
  r.navigate("#/tree");
  await flush();
  assert.equal(grace.cleared, true);
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

test("terminal: a server 'closed' frame then a socket drop reconnects with backoff and resets the screen at the replay's first bytes", async () => {
  const { doc, sockets, terms, timeouts, intervals, host } = runShell("#/terminal/a1", running);
  await flush();
  sockets[0]!.open();
  sockets[0]!.onmessage!({ data: '{"type":"closed","reason":"remote"}' });
  sockets[0]!.drop();
  assert.equal(statusText(host, "connection"), "disconnected");
  assert.equal(reconnectOffered(host), true);
  await flush();
  assert.match(role(doc, "note")!.textContent, /disconnected \u2014 reconnecting \(attempt 1\) in \d+s/);
  const retry = timeouts.filter((x) => !x.cleared && x.ms !== 120).pop()!;
  assert.ok(retry.ms >= 375 && retry.ms <= 625, String(retry.ms));
  assert.ok(intervals.some((i) => !i.cleared)); // countdown ticker
  retry.fn();
  assert.equal(sockets.length, 2);
  sockets[1]!.open();
  assert.equal(terms[0]!.resets, 1, "the old screen stays until the replay starts");
  sockets[1]!.onmessage!({ data: new Uint8Array([104]).buffer });
  assert.equal(terms[0]!.resets, 2); // the daemon replays on connect, so the screen restarts clean
  assert.equal(statusText(host, "connection"), "connected");
  assert.equal(role(doc, "note")!.textContent, "");
  assert.equal(reconnectOffered(host), false);
});

test("terminal: a finished agent shows 'No live terminal: agent <state>' and does not loop; Reconnect retries by hand", async () => {
  const { doc, sockets, timeouts, host } = runShell("#/terminal/a1", { "/v1/agents/a1": { body: { state: "exited" } } });
  await flush();
  sockets[0]!.open();
  sockets[0]!.drop();
  await flush();
  assert.match(role(doc, "note")!.textContent, /^No live terminal: agent exited \(the screen above is its last output\)$/);
  assert.equal(statusText(host, "connection"), "frozen");
  assert.equal(statusText(host, "state"), "exited");
  assert.equal(timeouts.filter((x) => !x.cleared && x.ms !== 120).length, 0);
  assert.equal(sockets.length, 1);
  assert.equal(reconnectOffered(host), true);
  host.run("terminal.reconnect");
  assert.equal(sockets.length, 2);
});

test("terminal: a yielded agent that was never connected (409) is labelled Yielded and is not retried", async () => {
  const { doc, sockets, timeouts, intervals, host } = runShell("#/terminal/a1", { "/v1/agents/a1": { body: { state: "yielded" } } });
  await flush();
  sockets[0]!.drop(); // the handshake was refused with 409: no open
  await flush();
  assert.equal(role(doc, "note")!.textContent, "Yielded: this agent is waiting and has no live terminal; it resumes on its wait condition");
  assert.equal(statusText(host, "connection"), "yielded");
  assert.equal(statusText(host, "state"), "yielded");
  assert.equal(timeouts.filter((x) => !x.cleared && x.ms !== 120).length, 0);
  assert.ok(intervals.every((i) => i.cleared || i.ms !== 1000)); // no countdown ticker (the 5s state poll stays)
  assert.equal(sockets.length, 1);
  assert.equal(reconnectOffered(host), true); // manual retry stays available
});

test("terminal: a screen left by a connection that then yielded is kept and labelled frozen, never live", async () => {
  const { doc, sockets, terms, timeouts, host } = runShell("#/terminal/a1", { "/v1/agents/a1": { body: { state: "yielded" } } });
  await flush();
  sockets[0]!.open();
  sockets[0]!.drop();
  await flush();
  assert.match(role(doc, "note")!.textContent, /^frozen: agent yielded/);
  assert.equal(statusText(host, "connection"), "frozen");
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

test("terminal: an unknown agent (404) shows the 'no longer available' placeholder and stops dialling", async () => {
  const { doc, sockets, timeouts, intervals, host } = runShell("#/terminal/zz", { "/v1/agents/zz": { status: 404, body: {} } });
  await flush();
  sockets[0]!.drop();
  await flush();
  assert.equal(role(doc, "note")!.textContent, "This agent is no longer available.");
  assert.notEqual(role(doc, "wrap")!.style.display, "none", "the last screen stays visible");
  assert.deepEqual(termOverlay(doc), {
    hidden: false,
    kind: "dead",
    label: "This agent is no longer available",
    icon: "stale-icon",
    role: "status",
    live: "polite",
  });
  assert.equal(sockets.length, 1, "no reconnect");
  assert.equal(timeouts.filter((t) => !t.cleared && t.ms >= 375).length, 0, "no reconnect timer left armed");
  assert.ok(
    intervals.every((i) => i.cleared),
    "polling and countdown timers stopped",
  );
  assert.equal(reconnectOffered(host), false);
});

test("terminal: an agent that disappears while connected is caught by the poll and stops everything", async () => {
  const responses: Record<string, { status?: number; body: unknown }> = { "/v1/agents/a1": { body: { state: "running" } } };
  const r = runShell("#/terminal/a1", responses);
  await flush();
  r.sockets[0]!.open();
  const pollTimer = r.intervals.find((i) => i.ms === 5000);
  assert.ok(pollTimer, "the lookup poll is running");
  // negative control: a present agent keeps its terminal
  pollTimer.fn();
  await flush();
  assert.notEqual(role(r.doc, "note")!.textContent, "This agent is no longer available.");
  assert.equal(r.sockets[0]!.closed, false);
  // the agent is removed: the next poll sees 404
  responses["/v1/agents/a1"] = { status: 404, body: {} };
  pollTimer.fn();
  await flush();
  assert.equal(role(r.doc, "note")!.textContent, "This agent is no longer available.");
  assert.notEqual(role(r.doc, "wrap")!.style.display, "none");
  assert.equal(termOverlay(r.doc).kind, "dead");
  assert.equal(r.sockets[0]!.closed, true, "the socket is closed");
  r.sockets[0]!.drop(); // the late close must not schedule a reconnect
  await flush();
  assert.equal(r.sockets.length, 1);
  assert.ok(r.intervals.every((i) => i.cleared));
});

test("terminal: mounting without an agent throws a cause-and-action error and leaves the root empty", () => {
  const { doc, context, sockets } = runShell("#/tree");
  const def = runInContext('PaneKit.view("terminal")', context) as { mount: (root: unknown, params: unknown, base: object) => unknown };
  for (const params of [{}, undefined, { agent: "" }]) {
    const root = doc.createElement("div");
    assert.throws(
      () => def.mount(root, params, {}),
      (e: Error) => e.message === "terminal needs an agent id; open it from the Tree or the top bar",
    );
    assert.equal(root.firstChild, null, "root holds no half-built markup");
  }
  assert.equal(sockets.length, 0);
});

test("terminal pane: its template root is pane-fill so the item window fills edge to edge", () => {
  assert.ok(renderTerminalPane().includes('<div class="term pane pane-fill">'));
  assert.ok(renderTerminalPane().includes('data-role="wrap" class="termwrap"'));
});

test("terminal: an agent-less hash opens nothing, and leaving the tab closes the socket and disposes the terminal", async () => {
  // an agent-less terminal hash is ignored by the shell (no terminal tile exists without its agent)
  const none = runShell("#/terminal/");
  await flush();
  assert.equal(none.hosts.length, 0);
  assert.equal(none.sockets.length, 0);

  const { sockets, terms, navigate, intervals, host } = runShell("#/terminal/a1", running);
  await flush();
  sockets[0]!.open();
  navigate("#/audit");
  assert.equal(sockets[0]!.closed, true);
  assert.equal(terms[0]!.disposed, true);
  assert.ok(intervals.every((i) => i.cleared));
  sockets[0]!.drop(); // a late close from the old socket must not schedule a reconnect
  await flush();
  assert.equal(sockets.length, 1);
  assert.equal(
    host.menuCalls.filter(([c, st]) => c === "terminal.reconnect" && st.visible === true).length,
    0,
    "a late close from an unmounted view does not offer Reconnect",
  );
});

test("terminal: another agent's hash opens a second terminal and leaves the first connected", async () => {
  const { sockets, navigate, hosts } = runShell("#/terminal/a1", running);
  await flush();
  sockets[0]!.open();
  navigate("#/terminal/b2");
  await flush();
  assert.equal(sockets[0]!.closed, false, "the first terminal is untouched");
  assert.equal(sockets[1]!.url, "ws://ui.test/v1/agents/b2/terminal");
  assert.equal(hosts.at(-1)!.titles.at(-1), "Terminal \u00b7 b2");
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
  const { doc, host, terms } = runShell("#/terminal/a1", running);
  await flush();
  const prompt = role(doc, "trace-confirm")!;
  const fire = (n: FakeNode, type: string, ev: unknown = {}) => {
    for (const fn of n.listeners.get(type) ?? []) fn(ev);
  };
  const raw = () => host.menu["terminal.trace-raw"]?.checked;
  const request = () => host.run("terminal.trace-raw", true);
  request();
  assert.equal(raw(), false); // off until confirmed
  assert.equal(prompt.hidden, false);
  assert.equal(role(doc, "trace-confirm-ok")!.focused, 1);
  const focusedBefore = terms[0]!.focused;
  clickEl(role(doc, "trace-confirm-cancel")!);
  assert.equal(prompt.hidden, true);
  assert.equal(raw(), false);
  assert.equal(terms[0]!.focused, focusedBefore + 1, "focus returns to the terminal");
  request();
  fire(prompt, "keydown", { key: "Enter" }); // Enter is the focused button's native click, not a cancel
  assert.equal(prompt.hidden, false);
  fire(prompt, "keydown", { key: "Escape" });
  assert.equal(prompt.hidden, true);
  assert.equal(raw(), false);
  request();
  clickEl(role(doc, "trace-confirm-ok")!);
  assert.equal(prompt.hidden, true);
  assert.equal(raw(), true);
  host.run("terminal.trace-raw", false); // unchecking never prompts
  assert.equal(prompt.hidden, true);
});

test("terminal: View trace opens an in-app viewer with the checked options, closes on Escape and returns focus; no terminal without an agent", async () => {
  const { doc, pageBody, docKeys, fetches, host } = runShell("#/terminal/a1", { ...running, "/v1/agents/a1/trace": { body: "# Trace text" } });
  await flush();
  const btn = role(doc, "trace-chip")!; // the viewer returns focus to the trace status line
  host.run("terminal.trace-children", true);
  const before = fetches.length;
  host.run("terminal.trace-view");
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
  // negative control: an agent-less hash opens no terminal, so there is no host to run the command on
  const none = runShell("#/terminal");
  await flush();
  assert.equal(none.hosts.length, 0);
});

test("terminal: View trace twice keeps one viewer; opening another agent's terminal leaves it with its own terminal", async () => {
  const r = runShell("#/terminal/a1", { ...running, "/v1/agents/a2": { body: { state: "running" } } });
  await flush();
  r.host.run("terminal.trace-view");
  r.host.run("terminal.trace-view");
  await flush();
  assert.equal(r.pageBody.children.length, 1);
  r.navigate("#/terminal/a2");
  await flush();
  assert.equal(r.pageBody.children.length, 1, "the first terminal keeps its trace viewer");
  assert.equal(r.docKeys.length > 0, true);
});

test("terminal: View trace never fetches raw unless the raw opt-in was confirmed", async () => {
  const r = runShell("#/terminal/a1", { ...running, "/v1/agents/a1/trace": { body: "t" } });
  await flush();
  const view = async () => {
    const n = r.fetches.length;
    r.host.run("terminal.trace-view");
    await flush();
    const url = r.fetches[n]!.url;
    for (const fn of [...r.docKeys]) fn({ key: "Escape" });
    return url;
  };
  r.host.run("terminal.trace-raw", true); // checking opens the in-page prompt and keeps raw off
  assert.doesNotMatch(await view(), /raw=1/, "prompt open, unconfirmed");
  clickEl(role(r.doc, "trace-confirm-cancel")!);
  assert.doesNotMatch(await view(), /raw=1/, "cancelled");
  r.host.run("terminal.trace-raw", true);
  clickEl(role(r.doc, "trace-confirm-ok")!);
  assert.match(await view(), /raw=1/, "confirmed");
});

test("terminal: key bar toggle, Alt one-shot, named keys, Send key menu, and offline no-ops", async () => {
  const store: Record<string, string> = {};
  const { doc, sockets, terms, host } = runShell("#/terminal/a1", running, undefined, store);
  await flush();
  const keys = role(doc, "keys")!;
  const menu = role(doc, "keymenu")!;
  const ws = sockets[0]!;
  clickEl(keys, keyBtn("Esc")); // connecting: no-op, no throw
  assert.equal(ws.sent.length, 0);
  assert.match(keys.className, /\boff\b/);
  assert.doesNotMatch(keys.className, /\bopen\b/); // desktop default: collapsed
  host.run("terminal.keys");
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
  const { terms, sockets, host } = runShell("#/terminal/a1", running, undefined, store);
  await flush();
  sockets[0]!.open();
  assert.equal(terms[0]!.options.fontSize, 20);
  host.run("terminal.font-larger");
  assert.equal(terms[0]!.options.fontSize, 21);
  assert.equal(store["pomtree.termFontSize"], "21");
  for (let i = 0; i < 40; i++) host.run("terminal.font-smaller");
  assert.equal(terms[0]!.options.fontSize, 8);
  host.run("terminal.font-reset");
  assert.equal(terms[0]!.options.fontSize, 14, "reset returns to the default size");
  assert.equal(store["pomtree.termFontSize"], "14");
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
  const hostRows = doc.getElementById("hosts-rows")!.children;
  assert.equal(hostRows[0]!.children[0]!.textContent, "h1");
  assert.ok(hostRows[1]!.children[0]!.textContent.startsWith("No agents yet"));
  assert.equal(intervals.length, 1); // polls while active
});

test("401 maps to the not-signed-in message on every pane", async () => {
  const { doc } = runShell("#/reports", { "/v1/reports": { status: 401, body: {} } });
  await flush();
  assert.equal(doc.getElementById("reports-rows")!.children[0]!.children[0]!.textContent, "Not signed in \u2014 reload to sign in");
  const e = runShell("#/escalations", { "/v1/escalations": { status: 401, body: {} } });
  await flush();
  assert.equal(e.doc.getElementById("escalations-status")!.textContent, "Not signed in \u2014 reload to sign in");
  assert.equal(e.doc.getElementById("escalations-status")!.className, "pane-notice err");
  const h = runShell("#/hosts", { "/v1/placement": { status: 401, body: {} } });
  await flush();
  assert.equal(h.doc.getElementById("hosts-rows")!.children[0]!.children[0]!.textContent, "Not signed in \u2014 reload to sign in");
  const o = runShell("#/audit", { "/v1/journal": { status: 500, body: {} } });
  await flush();
  assert.equal(o.doc.getElementById("audit-rows")!.children[0]!.children[0]!.textContent, "Failed to load journal: Error: HTTP 500");
});

test("escalations: empty state, polling, refresh adds new asks and drops answered ones", async () => {
  const responses: Record<string, { body: Json }> = { "/v1/escalations": { body: [] } };
  const { doc, intervals } = runShell("#/escalations", responses);
  await flush();
  const status = doc.getElementById("escalations-status")!;
  assert.equal(status.textContent, "");
  assert.equal(doc.getElementById("escalations")!.children[0]!.textContent, "No open escalations");
  assert.equal(intervals.length, 1);
  responses["/v1/escalations"] = { body: [{ id: "e1", agent: "a", question: "q?", options: [], createdAt: Date.now() }] };
  intervals[0]!.fn();
  await flush();
  assert.equal(doc.getElementById("escalations")!.children.length, 1);
  assert.equal(doc.getElementById("escalations")!.children[0]!.className, "tone-warn", "the empty row is replaced by the card");
  assert.equal(status.textContent, "");
});

test("tree: rows link to #/terminal/<fullId>, empty state guides and links to #/new, SSE badge tracks errors", () => {
  const { doc, es, context } = runShell("#/tree");
  const stream = es[0]!;
  // The shell pane has no #tree-conn: the badge is the window's connection status slot (ok -> ok tone, stale -> warn tone).
  assert.equal(doc.getElementById("tree-conn")?.textContent ?? "", "");
  const model = (
    context as {
      PaneKit: {
        sectionModel(id: string): {
          status(): { id: string; text: string; tone?: string | null }[];
          invoke(c: string): { ok: boolean };
          controls(): { command: string; label: string; primary?: boolean }[];
        };
      };
    }
  ).PaneKit.sectionModel("tree");
  const slot = (id: string) => {
    const s = model.status().find((x) => x.id === id);
    return s ? `${s.text}|${s.tone ?? ""}` : "";
  };
  assert.equal(slot("connection"), "connecting|warn");
  const rows = stream.handlers.get("rows")!;
  rows({ data: "[]" });
  assert.equal(slot("connection"), "connected|ok");
  assert.equal(slot("count"), "0 agents|");
  const empty = doc.getElementById("tree-rows")!.children[0]!.children[0]!;
  assert.ok(empty.textContent.includes("No agents yet"));
  assert.equal(empty.children[0]!.href, "#/new");
  stream.onerror!();
  assert.equal(slot("connection"), "stale|warn");
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
  // the depth indent adds to the cell padding token; a bare em value would pull a depth-0 name flush against the tile border
  assert.equal(tr.children[0]!.style.paddingLeft, "calc(var(--cell-x) + 1.5em)");
  assert.equal(slot("count"), "1 agent|");
});

test("the tree pane declares a primary 'New agent' control that navigates to #/new; the pane itself has no button row", () => {
  const html = renderTreePane();
  const markup = html.slice(0, html.indexOf("<script>"));
  assert.ok(!markup.includes("New agent"));
  assert.ok(!markup.includes('class="btn"'));
  assert.ok(!markup.includes("tree-conn"));
  const { context, location } = runShell("#/tree");
  const model = (
    context as {
      PaneKit: {
        sectionModel(id: string): {
          controls(): { kind: string; command: string; label: string; primary?: boolean }[];
          invoke(c: string): { ok: boolean };
        };
      };
    }
  ).PaneKit.sectionModel("tree");
  assert.equal(
    model
      .controls()
      .map((c) => `${c.kind}|${c.command}|${c.label}|${c.primary === true}`)
      .join(","),
    "button|tree.new|New agent|true",
  );
  assert.equal(model.invoke("tree.new").ok, true);
  assert.equal(location.hash, "#/new");
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
  assert.equal(st.className, "pane-notice err");
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

test("new-agent pane: shared pane skeleton (root classes, no heading, notice then one body, no max-width or style)", () => {
  const html = renderNewAgentPane();
  const markup = html.slice(0, html.indexOf("<script>"));
  assert.ok(markup.startsWith('<div class="newagent pane">'));
  assert.doesNotMatch(markup, /<h[1-6][\s>]/);
  assert.equal(markup.split("pane-body").length - 1, 1);
  assert.match(markup, /<div id="new-status" class="pane-notice" role="status"><\/div>\s*<div class="pane-form pane-body">/);
  assert.equal(markup.indexOf('id="new-status"'), markup.indexOf("<div", 10) + 5, "the notice is the first child");
  assert.doesNotMatch(markup, /max-width|<style|style=/);
  assert.match(markup, /<div class="row">/);
  assert.ok(markup.indexOf('id="new-task"') > markup.indexOf('class="pane-form pane-body"'));
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

// --- multi-instance terminal views ----------------------------------------------------------------

interface ViewHost {
  setTitle(text: string): void;
  navigate(hash: string): void;
  isFocused(): boolean;
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
  const hostFor = (tag: string): ViewHost => ({ setTitle: (t) => titles.push(`${tag}:${t}`), navigate: (h) => navs.push(h), isFocused: () => true });
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

test("view registry: the shell page registers the multi-instance item views (report, terminal) once and refuses a second one", () => {
  const { context } = runShell("#/tree");
  const ids = runInContext("PaneKit.views().map((v) => v.id + ':' + v.multi)", context) as string[];
  assert.deepEqual([...ids], ["report:true", "terminal:true"]);
  assert.throws(
    () => runInContext('PaneKit.registerView({ id: "terminal", title: "T", multi: true, mount() {} })', context),
    /view terminal is already registered/,
  );
});

test("terminal views: two instances for different agents mount into two roots without colliding", async () => {
  const { sockets, terms, observers, doc, rootA, rootB, inRoot, titles, hosts } = mountTwo();
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
  assert.deepEqual(titles, ["A:Terminal \u00b7 a1", "B:Terminal \u00b7 b2"]);
  sockets[0]!.open();
  assert.equal(statusText(hosts[0]!, "connection"), "connected");
  assert.equal(statusText(hosts[1]!, "connection"), "connecting", "B is not touched by A's socket");
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
  const { sockets, terms, observers, intervals, timeouts, resize, resizeListeners, rootA, rootB, a, inRoot, hosts } = mountTwo();
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
  assert.equal(statusText(hosts[1]!, "connection"), "connected");
  a.unmount(); // idempotent
});

test("terminal views: unmounting one instance leaves another instance's trace viewer open", async () => {
  const r = mountTwo();
  await flush();
  r.hosts[1]!.run("terminal.trace-view");
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
  r.hosts[0]!.run("terminal.reconnect");
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
  r.def.mount(normal, { agent: "a1" }, { setTitle() {}, navigate() {}, isFocused: () => true }).unmount();
  assert.equal(normal.children.length, 0, "a normal unmount still clears the root");
});

// Changed from the legacy single-section adapter test: the tiling shell mounts the terminal per tile, remounts when the
// focused tile's agent changes, and unmounts when the tile's view changes.
test("terminal views: the tiling shell mounts one terminal per tile, adds a tile per agent and cleans up", async () => {
  const { doc, sockets, navigate, observers } = runShell("#/terminal/a1", running);
  await flush();
  const wm = doc.getElementById("wm-root")!;
  assert.equal(countMounts(wm), 1, "one mount root in the tile");
  navigate("#/terminal/b2");
  await flush();
  assert.equal(countMounts(wm), 2, "the second agent gets its own tile; the first mount stays");
  assert.equal(sockets[0]!.closed, false);
  assert.equal(observers[0]!.disconnected, false);
  navigate("#/audit"); // a browsing view retargets the focused (second) tile
  assert.equal(countMounts(wm), 1);
  assert.equal(observers[1]!.disconnected, true);
  assert.equal(observers[0]!.disconnected, false);
});

test("terminal views: the vendored xterm libraries load once per page across instances", async () => {
  const r = runShell("#/tree", twoAgents);
  const { Terminal, FitAddon } = r.context as { Terminal: unknown; FitAddon: unknown };
  runInContext("delete globalThis.Terminal; delete globalThis.FitAddon;", r.context);
  const def = runInContext('PaneKit.view("terminal")', r.context) as ViewDef;
  const host: ViewHost = { setTitle() {}, navigate() {}, isFocused: () => true };
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

test("terminal: an opening socket focuses the terminal only when its tile is the focused one", async () => {
  const r = runShell("#/tree", twoAgents);
  const def = runInContext('PaneKit.view("terminal")', r.context) as ViewDef;
  const host = (focused: boolean): ViewHost => ({ setTitle() {}, navigate() {}, isFocused: () => focused });
  def.mount(fakeNode(), { agent: "a1" }, host(false));
  def.mount(fakeNode(), { agent: "b2" }, host(true));
  await flush();
  assert.equal(r.sockets.length, 2);
  for (const ws of r.sockets) ws.open();
  const focusedOf = (agent: string) => r.terms[r.sockets.findIndex((w) => w.url.includes("/" + agent + "/"))]!.focused;
  assert.equal(focusedOf("a1"), 0, "a terminal in another tile does not take focus");
  assert.ok(focusedOf("b2") >= 1, "negative control: the focused tile's terminal does");
});

test("terminal: a reconnect while its tile is unfocused does not take focus", async () => {
  const r = runShell("#/tree", twoAgents);
  const def = runInContext('PaneKit.view("terminal")', r.context) as ViewDef;
  let focused = true;
  def.mount(fakeNode(), { agent: "a1" }, { setTitle() {}, navigate() {}, isFocused: () => focused });
  await flush();
  r.sockets[0]!.open();
  assert.equal(r.terms[0]!.focused, 1, "the first open in the focused tile focuses");
  focused = false;
  r.sockets[0]!.open(); // a reconnect's open while the operator moved to another tile
  assert.equal(r.terms[0]!.focused, 1, "no second focus");
});

test("terminal: an opening socket does not take focus from an input the operator is typing in", async () => {
  const r = runShell("#/tree", twoAgents);
  const def = runInContext('PaneKit.view("terminal")', r.context) as ViewDef;
  def.mount(fakeNode(), { agent: "a1" }, { setTitle() {}, navigate() {}, isFocused: () => true });
  await flush();
  const doc = (r.context as { document: { activeElement: unknown } }).document;
  const input = fakeNode();
  input.tagName = "input";
  doc.activeElement = input;
  r.sockets[0]!.open();
  assert.equal(r.terms[0]!.focused, 0, "an input elsewhere keeps focus");
  doc.activeElement = fakeNode(); // negative control: a non-editable active element does not block
  r.sockets[0]!.open();
  assert.equal(r.terms[0]!.focused, 1);
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
  r.hosts[0]!.run("terminal.trace-view");
  await flush();
  assert.equal(r.pageBody.children.length, 1);
  r.hosts[1]!.run("terminal.trace-view"); // reuses A's viewer and must not take it over
  assert.equal(r.pageBody.children.length, 1);
  r.a.unmount();
  assert.equal(r.pageBody.children.length, 0, "A's unmount dismissed the viewer it created");
  r.hosts[1]!.run("terminal.trace-view"); // B opens a fresh one and owns it
  await flush();
  assert.equal(r.pageBody.children.length, 1);
  r.b.unmount();
  assert.equal(r.pageBody.children.length, 0);
});

test("terminal: a missing template fails with a cause and an action instead of a TypeError", () => {
  const r = mountTwo();
  (r.context as { document: { querySelector: unknown } }).document.querySelector = () => null;
  assert.throws(
    () => r.def.mount(fakeNode(), { agent: "a1" }, { setTitle() {}, navigate() {}, isFocused: () => true }),
    /template is missing from the page.*reload the page/,
  );
});

test("terminal: a copy still in flight when the view unmounts opens no manual-copy modal", async () => {
  const r = mountTwo();
  await flush();
  Object.assign(r.context, { navigator: { clipboard: { writeText: () => Promise.reject(new Error("denied")) } } });
  r.hosts[0]!.run("terminal.trace-copy");
  r.a.unmount(); // before the fetch and clipboard promises settle
  await flush();
  await flush();
  assert.equal(r.pageBody.children.length, 0);
  // negative control: the same click on a mounted view does open the modal
  r.hosts[1]!.run("terminal.trace-copy");
  await flush();
  await flush();
  assert.equal(r.pageBody.children.length, 1, "the modal opens when the view is still mounted");
});

test("terminal: a failed library load then a retry appends the stylesheet link once", async () => {
  const r = runShell("#/tree", twoAgents);
  runInContext("delete globalThis.Terminal; delete globalThis.FitAddon;", r.context);
  const def = runInContext('PaneKit.view("terminal")', r.context) as ViewDef;
  def.mount(fakeNode(), { agent: "a1" }, { setTitle() {}, navigate() {}, isFocused: () => true });
  await flush();
  const first = r.headNodes.filter((n) => n.tagName === "script").at(-1) as unknown as { onerror(): void };
  first.onerror();
  await flush();
  def.mount(fakeNode(), { agent: "b2" }, { setTitle() {}, navigate() {}, isFocused: () => true });
  await flush();
  assert.equal(r.headNodes.filter((n) => n.tagName === "link").length, 1, "one stylesheet across the retry");
});

// --- terminal toolbar in window chrome: the view drives the declared menus and status through its host ---------

test("terminal chrome: the pane markup no longer carries the toolbar; the view registers the terminal declaration's menus and status", () => {
  const html = renderTerminalPane();
  for (const gone of ["statusbar", "fontgrp", "tracegrp", "trace-menu", 'data-role="reconnect"', "keys-toggle", 'data-role="font-', 'data-role="conn"']) {
    assert.ok(!html.includes(gone), `${gone} left the pane`);
  }
  assert.ok(html.includes('data-role="trace-chip" class="tracechip" role="status" tabindex="-1"'), "the trace chip stays in the pane as a status line");
  assert.ok(html.includes('aria-label="Terminal keys"'), "the key bar stays in the pane");
  const { context } = runShell("#/tree");
  const def = runInContext("PaneKit.declaration('terminal')", context) as { menus: { id: string }[]; status: { id: string }[] };
  assert.deepEqual(
    [...def.menus].map((m) => m.id),
    (TERMINAL_DECLARATION.menus ?? []).map((m) => m.id),
  );
  assert.deepEqual(
    [...def.status].map((m) => m.id),
    ["state", "connection"],
  );
});

test("terminal chrome: every declared command has a handler in the view, and running them all (plus an undeclared one) does not throw", async () => {
  const { host, sockets } = runShell("#/terminal/a1", running);
  await flush();
  sockets[0]!.open();
  const commands = (TERMINAL_DECLARATION.menus ?? []).flatMap((m) => m.items.flatMap((i) => ("command" in i ? [i.command] : [])));
  assert.ok(commands.length >= 11, "the declaration lists the toolbar's commands");
  const html = renderTerminalPane();
  for (const c of commands) assert.ok(html.includes(`"${c}":`), `${c} is handled`);
  for (const c of commands) host.run(c, c.endsWith("trace-children") || c.endsWith("trace-raw") ? false : undefined);
  host.run("terminal.not-declared");
});

test("terminal chrome: Reconnect is offered only after a disconnect and withdrawn on connect", async () => {
  const { host, sockets } = runShell("#/terminal/a1", running);
  await flush();
  assert.equal(reconnectOffered(host), false, "not offered while connecting");
  sockets[0]!.open();
  assert.equal(reconnectOffered(host), false, "not offered while connected");
  sockets[0]!.drop();
  assert.equal(reconnectOffered(host), true);
  await flush();
  host.run("terminal.reconnect");
  assert.equal(sockets.length, 2, "the command redials like the old button");
  sockets[1]!.open();
  assert.equal(reconnectOffered(host), false);
});

test("terminal chrome: reconnect while a socket is live does nothing (as the old button)", async () => {
  const { host, sockets } = runShell("#/terminal/a1", running);
  await flush();
  sockets[0]!.open();
  host.run("terminal.reconnect");
  assert.equal(sockets.length, 1);
});

test("terminal chrome: state and connection map to status tones", async () => {
  const { host, sockets } = runShell("#/terminal/a1", running);
  await flush();
  assert.deepEqual(host.status.connection, { text: "connecting", tone: "warn" });
  assert.equal(host.status.state?.text, "running");
  assert.equal(host.status.state?.tone, "ok");
  sockets[0]!.open();
  assert.deepEqual(host.status.connection, { text: "connected", tone: "ok" });
  sockets[0]!.drop();
  assert.deepEqual(host.status.connection, { text: "disconnected", tone: "warn" });
  const y = runShell("#/terminal/a1", { "/v1/agents/a1": { body: { state: "yielded" } } });
  await flush();
  assert.equal(y.host.status.state?.tone, "warn");
  const e = runShell("#/terminal/a1", { "/v1/agents/a1": { body: { state: "exited" } } });
  await flush();
  assert.equal(e.host.status.state?.tone, "info");
  const f = runShell("#/terminal/a1", { "/v1/agents/a1": { body: { state: "failed" } } });
  await flush();
  assert.equal(f.host.status.state?.tone, "err");
  const m = runShell("#/terminal/a1", { "/v1/agents/a1": { body: { state: "mystery" } } });
  await flush();
  assert.equal(m.host.status.state?.tone, null, "an unknown state shows text without a tone");
});

test("terminal chrome: trace commands fetch the same URLs the old buttons did, honouring the two options", async () => {
  const { host, fetches } = runShell("#/terminal/a1", { ...running, "/v1/agents/a1/trace": { body: "t" } });
  await flush();
  const last = async (command: string) => {
    const n = fetches.length;
    host.run(command);
    await flush();
    return fetches[n]?.url;
  };
  assert.equal(await last("terminal.trace-copy"), "/v1/agents/a1/trace?format=md");
  assert.equal(await last("terminal.trace-short"), "/v1/agents/a1/trace?format=md&short=1");
  host.run("terminal.trace-children", true);
  assert.equal(await last("terminal.trace-copy"), "/v1/agents/a1/trace?format=md&include=children");
  assert.equal(await last("terminal.trace-download"), "/v1/agents/a1/trace?format=md&include=children");
  host.run("terminal.trace-children", false);
  assert.equal(await last("terminal.trace-copy"), "/v1/agents/a1/trace?format=md");
});

test("terminal chrome: the Keys command toggles the bar and the stored pref; the bar keeps an id for aria-controls", async () => {
  const store: Record<string, string> = {};
  const { doc, host } = runShell("#/terminal/a1", running, undefined, store);
  await flush();
  const keys = role(doc, "keys")!;
  assert.ok(keys.id.startsWith("term-keys-"));
  assert.doesNotMatch(keys.className, /\bopen\b/);
  host.run("terminal.keys");
  assert.match(keys.className, /\bopen\b/);
  assert.equal(store["pomtree.termKeysOpen"], "1");
  host.run("terminal.keys");
  assert.doesNotMatch(keys.className, /\bopen\b/);
  assert.equal(store["pomtree.termKeysOpen"], "0");
});

test("terminal chrome: a raw toggle request never turns raw on before the confirm (checked is pushed false, then true)", async () => {
  const { host, doc } = runShell("#/terminal/a1", { ...running, "/v1/agents/a1/trace": { body: "t" } });
  await flush();
  host.run("terminal.trace-raw", true);
  const raws = host.menuCalls.filter(([c]) => c === "terminal.trace-raw").map(([, s]) => s.checked);
  assert.deepEqual(raws, [false]);
  clickEl(role(doc, "trace-confirm-cancel")!);
  assert.deepEqual(
    host.menuCalls.filter(([c]) => c === "terminal.trace-raw").map(([, s]) => s.checked),
    [false],
    "cancel pushes nothing more",
  );
  host.run("terminal.trace-raw", true);
  clickEl(role(doc, "trace-confirm-ok")!);
  assert.deepEqual(
    host.menuCalls.filter(([c]) => c === "terminal.trace-raw").map(([, s]) => s.checked),
    [false, false, true],
  );
});
