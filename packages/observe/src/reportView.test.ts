import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { renderReportView } from "./reportView.ts";
import { renderReportsPane, renderReportsPage } from "./web.ts";
import { renderShell } from "./shell.ts";

// Fake DOM whose assertions are on strings and booleans only (a failing assert on a node would print a graph).
interface N {
  tagName: string;
  className: string;
  textContent: string;
  href: string;
  hidden: boolean;
  style: Record<string, string> & { cssText?: string };
  children: N[];
  attrs: Map<string, string>;
  listeners: Map<string, (ev: unknown) => void>;
  appendChild(c: N): void;
  insertBefore(c: N, ref: N): void;
  replaceChildren(...k: N[]): void;
  setAttribute(k: string, v: string): void;
  addEventListener(t: string, f: (ev: unknown) => void): void;
  querySelector(sel: string): N | null;
  toString(): string;
}
const makeNode = (tag: string): N => {
  const n: N = {
    tagName: tag,
    className: "",
    textContent: "",
    href: "",
    hidden: false,
    style: {},
    children: [],
    attrs: new Map(),
    listeners: new Map(),
    appendChild(c) {
      n.children.push(c);
    },
    insertBefore(c, ref) {
      const i = n.children.indexOf(ref);
      if (i < 0) n.children.push(c);
      else n.children.splice(i, 0, c);
    },
    replaceChildren(...k) {
      n.children = k;
    },
    setAttribute(k, v) {
      n.attrs.set(k, v);
    },
    addEventListener(t, f) {
      n.listeners.set(t, f);
    },
    querySelector(sel) {
      return walk(n).find((x) => x !== n && x.tagName === sel) ?? null;
    },
    toString: () => `<${tag}>`,
  };
  return n;
};
const walk = (n: N): N[] => [n, ...n.children.flatMap(walk)];

interface Def {
  id: string;
  title: string;
  multi: boolean;
  subject?: string;
  mount(root: N, p: { agent?: string; report?: string }, h: unknown): { unmount(): void };
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function setup(
  responses: Record<string, { status?: number; body?: unknown; text?: string }> = {},
  params: { agent?: string; report?: string } = { agent: "agent-1", report: "r1" },
) {
  const fetches: string[] = [];
  const sandbox = {
    document: { createElement: makeNode, createTextNode: (t: string) => Object.assign(makeNode("#text"), { textContent: t }) },
    JSON,
    Math,
    Date,
    Object,
    Promise,
    Error,
    String,
    encodeURIComponent,
    fetch: (url: string) => {
      fetches.push(url);
      const r = responses[url] ?? { status: 404 };
      const status = r.status ?? 200;
      return Promise.resolve({ ok: status < 400, status, json: async () => r.body, text: async () => r.text ?? "" });
    },
  };
  const context = createContext(sandbox);
  const script = /<script>([\s\S]*?)<\/script>/.exec(renderReportView())![1]!;
  runInContext(script, context, { filename: "report-view.js" });
  const kit = runInContext("PaneKit", context) as { view(id: string): Def | undefined; views(): { id: string }[] };
  const def = kit.view("report")!;
  const titles: string[] = [];
  const root = makeNode("div");
  const host = { setTitle: (t: string) => titles.push(t), navigate: () => {} };
  const mount = () => def.mount(root, params, host);
  return {
    def,
    kit,
    root,
    titles,
    fetches,
    mount,
    text: () =>
      walk(root)
        .map((n) => n.textContent)
        .join("|"),
  };
}

const BASE = "/v1/agents/agent-1/reports/r1";

test("registers one multi-instance report view with subject report", () => {
  const s = setup();
  assert.equal(s.def.id, "report");
  assert.equal(s.def.multi, true);
  assert.equal(s.def.subject, "report");
  assert.equal(s.kit.views().filter((v) => v.id === "report").length, 1);
});

test("mount fetches the metadata, fills the window as pane pane-fill, and unmount clears the root", async () => {
  const s = setup({ [BASE]: { body: { name: "x.html", mediaType: "text/html" } } });
  const h = s.mount();
  assert.deepEqual(s.fetches, [BASE]);
  assert.equal(s.root.children.length, 1);
  assert.equal(s.root.children[0]!.className, "report pane pane-fill");
  assert.equal(s.titles[0], "Report \u00b7 r1");
  await flush();
  assert.equal(s.titles.at(-1), "Report \u00b7 x.html");
  h.unmount();
  assert.equal(s.root.children.length, 0);
});

test("the title before the name is known uses the first 8 characters of the id", () => {
  const s = setup({}, { agent: "agent-1", report: "0123456789abcdef" });
  s.mount();
  assert.equal(s.titles[0], "Report \u00b7 01234567");
});

test("html renders in an iframe with an EMPTY sandbox that fills the window, a locked-sandbox banner, Download and View source", async () => {
  const s = setup({ [BASE]: { body: { name: "x.html", mediaType: "text/html" } } });
  s.mount();
  await flush();
  const nodes = walk(s.root);
  const frames = nodes.filter((n) => n.tagName === "iframe");
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.attrs.get("sandbox"), "");
  assert.ok(![...frames[0]!.attrs.values()].some((v) => v.includes("allow-")));
  assert.equal(frames[0]!.attrs.get("src"), `${BASE}/render`);
  assert.ok(frames[0]!.style.cssText!.includes("height:100%"));
  assert.ok(!frames[0]!.style.cssText!.includes("70vh"));
  assert.ok(s.text().includes("Rendered in a locked sandbox: scripts and network are disabled."));
  assert.ok(s.text().includes("Download") && s.text().includes("View source"));
  assert.ok(nodes.some((n) => n.tagName === "a" && n.href === `${BASE}?raw=1`));
  assert.ok(!s.text().includes("scripts-enabled"));
});

test("View source fetches the raw text into a <pre> via textContent", async () => {
  const s = setup({ [BASE]: { body: { name: "x.html", mediaType: "text/html" } }, [`${BASE}?raw=1`]: { text: "<b>hi</b>" } });
  s.mount();
  await flush();
  const src = walk(s.root).find((n) => n.tagName === "a" && n.textContent === "View source")!;
  src.listeners.get("click")!({ preventDefault() {} });
  await flush();
  const pre = walk(s.root).find((n) => n.tagName === "pre")!;
  assert.equal(pre.textContent, "<b>hi</b>");
});

test("images use <img> via /render, filling the window", async () => {
  const s = setup({ [BASE]: { body: { name: "p.png", mediaType: "image/png" } } });
  s.mount();
  await flush();
  const nodes = walk(s.root);
  const img = nodes.find((n) => n.tagName === "img")!;
  assert.equal(img.attrs.get("src"), `${BASE}/render`);
  assert.ok(img.style.cssText!.includes("height:100%"));
  assert.ok(!nodes.some((n) => n.tagName === "iframe"));
});

test("markdown is fetched raw and rendered through MdKit; plain text and json go in a <pre>", async () => {
  const md = setup({ [BASE]: { body: { name: "n.md", mediaType: "text/markdown; charset=utf-8" } }, [`${BASE}?raw=1`]: { text: "# Title\n\nbody" } });
  md.mount();
  await flush();
  assert.ok(md.fetches.includes(`${BASE}?raw=1`));
  const nodes = walk(md.root);
  assert.ok(nodes.some((n) => n.className === "md"));
  assert.ok(!nodes.some((n) => n.tagName === "iframe" || n.tagName === "img"));
  assert.ok(md.text().includes("Title"));
  const txt = setup({ [BASE]: { body: { name: "n.txt", mediaType: "text/plain" } }, [`${BASE}?raw=1`]: { text: "<script>x</script>" } });
  txt.mount();
  await flush();
  assert.equal(walk(txt.root).find((n) => n.tagName === "pre")!.textContent, "<script>x</script>");
  assert.ok(walk(txt.root).some((n) => n.tagName === "a" && n.textContent === "Download"));
});

test("unknown types are download-only with the cannot-be-previewed note", async () => {
  const s = setup({ [BASE]: { body: { name: "p.pdf", mediaType: "application/pdf" } } });
  s.mount();
  await flush();
  const nodes = walk(s.root);
  assert.ok(!nodes.some((n) => n.tagName === "iframe" || n.tagName === "img"));
  assert.ok(s.text().includes("This report type (application/pdf) cannot be previewed; use Download."));
  assert.ok(nodes.some((n) => n.tagName === "a" && n.href === `${BASE}?raw=1`));
});

test("the report name is rendered as text, never as markup", async () => {
  const s = setup({ [BASE]: { body: { name: "<img src=x onerror=1>", mediaType: "application/pdf" } } });
  s.mount();
  await flush();
  assert.ok(walk(s.root).some((n) => n.tagName === "strong" && n.textContent === "<img src=x onerror=1>"));
  assert.ok(!walk(s.root).some((n) => n.tagName === "img"));
});

test("a missing report shows the short placeholder, other errors keep the error message", async () => {
  const gone = setup({ [BASE]: { status: 404 } });
  gone.mount();
  await flush();
  assert.ok(gone.text().includes("This report is no longer available."));
  assert.ok(!gone.text().includes("HTTP 404"));
  const bad = setup({ [BASE]: { status: 500 } });
  bad.mount();
  await flush();
  assert.ok(!bad.text().includes("This report is no longer available."));
  assert.ok(bad.text().includes("report"));
});

test("a mount without its subject throws naming cause and action, and leaves the root empty", () => {
  for (const p of [{}, { agent: "a" }, { report: "r" }]) {
    const s = setup({}, p);
    assert.throws(() => s.mount(), /needs an agent id and a report id; open it from the Reports index/);
    assert.equal(s.root.children.length, 0);
    assert.equal(s.fetches.length, 0);
  }
});

test("results arriving after unmount do not touch the root", async () => {
  const s = setup({ [BASE]: { body: { name: "x.html", mediaType: "text/html" } } });
  const h = s.mount();
  h.unmount();
  await flush();
  assert.equal(s.root.children.length, 0);
});

test("the shipped script has no innerHTML, no 70vh and no scripts-enabled sandbox, and escapes the base path", () => {
  const src = renderReportView();
  assert.ok(!/innerHTML/.test(src));
  assert.ok(!src.includes("70vh"));
  assert.ok(!src.includes("allow-scripts"));
  const evil = renderReportView({ agentsBase: "</script><script>alert(1)</script>" });
  assert.equal(evil.match(/<\/script>/g)!.length, 1);
});

// ---- the Reports index and shipping ------------------------------------------------------------------------------

async function index(rows: unknown[], standalone = false) {
  const html = standalone ? renderReportsPage() : renderReportsPane();
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const tbody = makeNode("tbody");
  const context = createContext({
    document: { createElement: makeNode, getElementById: () => tbody },
    JSON,
    Math,
    Date,
    Object,
    Promise,
    String,
    Number,
    encodeURIComponent,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => rows }),
  });
  runInContext(script, context); // no UI registry here: K.onActivate runs the load at once
  await flush();
  const hrefs = walk(tbody)
    .filter((n) => n.tagName === "a")
    .map((n) => n.href);
  return { hrefs, html };
}

const row = { agent: "a b", report: { id: "r/1", agent: "a b", name: "x", mediaType: "text/html", sizeBytes: 3, createdAt: 0 } };

test("index links open the item window at #/report/<agent>/<id> with each segment encoded, plus a raw download", async () => {
  const r = await index([row]);
  assert.deepEqual(r.hrefs, ["#/report/a%20b/r%2F1", "/v1/agents/a%20b/reports/r%2F1?raw=1"]);
});

test("the index has no in-pane viewer, no hash route parsing and no hashchange listener", async () => {
  const { html } = await index([]);
  assert.ok(!html.includes("#/reports/"));
  assert.ok(!html.includes("reports-viewer"));
  assert.ok(!html.includes("hashchange"));
  assert.ok(!html.includes("location.hash"));
  assert.ok(!html.includes("70vh"));
  assert.ok(html.includes('id="reports-rows"'));
});

test("the standalone page has no window manager: its names link to the raw download and it ships no viewer", async () => {
  const r = await index([row], true);
  assert.deepEqual(r.hrefs, ["/v1/agents/a%20b/reports/r%2F1?raw=1", "/v1/agents/a%20b/reports/r%2F1?raw=1"]);
  assert.ok(!r.html.includes('K.registerView({ id: "report"'));
});

test("the Reports tab ships the report view once, and the shell finds it with the index", () => {
  const html = renderShell({ tabs: [{ id: "reports", title: "Reports", render: () => renderReportsPane() }] });
  assert.equal(html.split('K.registerView({ id: "report"').length - 1, 1);
  assert.ok(html.includes('data-tab="reports"'));
  assert.ok(!html.includes('data-tab="report"') && !html.includes('data-nav="report"'));
});
