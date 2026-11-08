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
  click(): void;
  toString(): string;
}
const clicked: string[] = [];
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
    click() {
      clicked.push(n.href);
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
  const statuses: { slot: string; text: string; tone?: string }[] = [];
  const menuStates: { command: string; state: string }[] = [];
  let onCommand: (c: string, a?: unknown) => void = () => {};
  const host = {
    setTitle: (t: string) => titles.push(t),
    navigate: () => {},
    setStatus: (slot: string, v: { text: string; tone?: string }) => statuses.push({ slot, ...v }),
    setMenuState: (command: string, st: Record<string, unknown>) => menuStates.push({ command, state: JSON.stringify(st) }),
    onCommand: (f: typeof onCommand) => {
      onCommand = f;
    },
  };
  const mount = () => def.mount(root, params, host);
  return {
    def,
    kit,
    root,
    titles,
    statuses,
    menuStates,
    command: (c: string) => onCommand(c),
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
  assert.equal(frames[0]!.className, "report-frame");
  assert.deepEqual(frames[0]!.style, {}, "sizing comes from the shared CSS class, not inline style");
  assert.ok(!nodes.some((n) => n.className === "report-banner"), "the banner row is gone: the footer carries it");
  assert.deepEqual({ ...s.statuses.at(-1) }, { slot: "sandbox", text: "sandboxed", tone: "info" });
  assert.ok(!s.text().includes("scripts-enabled"));
});

test("View source fetches the raw text into a <pre> via textContent", async () => {
  const s = setup({ [BASE]: { body: { name: "x.html", mediaType: "text/html" } }, [`${BASE}?raw=1`]: { text: "<b>hi</b>" } });
  s.mount();
  await flush();
  assert.equal(s.menuStates.at(-1)!.state, '{"visible":true}', "View source shows for sandboxed types");
  s.command("report.view-source");
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
  assert.equal(img.className, "report-img");
  assert.deepEqual(img.style, {});
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
  assert.ok(!walk(txt.root).some((n) => n.tagName === "a"), "no in-pane Download link: it is a View menu command");
  assert.ok(!walk(txt.root).some((n) => n.tagName === "strong"));
  assert.equal(txt.statuses.length, 0, "no sandbox status for text");
});

test("unknown types are download-only with the cannot-be-previewed note", async () => {
  const s = setup({ [BASE]: { body: { name: "p.pdf", mediaType: "application/pdf" } } });
  s.mount();
  await flush();
  const nodes = walk(s.root);
  assert.ok(!nodes.some((n) => n.tagName === "iframe" || n.tagName === "img"));
  assert.ok(s.text().includes("This report type (application/pdf) cannot be previewed; use Download."));
});

test("the report name is rendered as text, never as markup", async () => {
  const s = setup({ [BASE]: { body: { name: "<img src=x onerror=1>", mediaType: "application/pdf" } } });
  s.mount();
  await flush();
  assert.equal(s.titles.at(-1), "Report \u00b7 <img src=x onerror=1>", "the name reaches only the tile title (the host sets it as text)");
  assert.ok(!walk(s.root).some((n) => n.textContent.includes("onerror")));
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
  const kit = (context as { PaneKit: { sectionModel(id: string): { status(): { id: string; text: string }[] } } }).PaneKit;
  const count =
    kit
      .sectionModel("reports")
      .status()
      .find((x) => x.id === "count")?.text ?? "";
  return { hrefs, html, count };
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

test("the index reports its row count in the window's count slot and fills the pane body", async () => {
  assert.equal((await index([row])).count, "1 report");
  assert.equal((await index([row, row])).count, "2 reports");
  assert.equal((await index([])).count, "0 reports");
  const { html } = await index([]);
  assert.ok(html.startsWith('<div class="reports pane">\n<div class="tablewrap pane-body">'));
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

test("the report pane has no title row, no banner and no report-head; the body fills the window", async () => {
  const s = setup({ [BASE]: { body: { name: "x.html", mediaType: "text/html" } } });
  s.mount();
  await flush();
  const nodes = walk(s.root);
  assert.ok(!nodes.some((n) => ["report-head", "report-name", "report-banner", "report-actions"].includes(n.className)));
  const wrap = s.root.children[0]!;
  assert.deepEqual(
    wrap.children.map((n) => n.className),
    ["report-body"],
  );
  assert.ok(!nodes.some((n) => Object.keys(n.style).length > 0), "no inline style anywhere");
});

test("markdown and text content get a token inset on the inner content only, not the body", async () => {
  const md = setup({ [BASE]: { body: { name: "n.md", mediaType: "text/markdown" } }, [`${BASE}?raw=1`]: { text: "# T" } });
  md.mount();
  await flush();
  const nodes = walk(md.root);
  assert.deepEqual(nodes.find((n) => n.className === "md")!.style, {}, "the inset is the shared .report-body .md rule");
  assert.deepEqual(nodes.find((n) => n.className === "report-body")!.style, {});
});

test("the report declaration's commands each have a handler; Download opens the raw file, unknown commands do nothing", async () => {
  const { REPORT_DECLARATION } = await import("./viewMenus.ts");
  const s = setup({ [BASE]: { body: { name: "x.html", mediaType: "text/html" } }, [`${BASE}?raw=1`]: { text: "src" } });
  s.mount();
  await flush();
  const cmds = (REPORT_DECLARATION.menus ?? []).flatMap((m) => m.items.filter((i) => i.kind !== "separator").map((i) => (i as { command: string }).command));
  const reg = s.kit as unknown as { declaration(id: string): { menus: { items: { command?: string }[] }[]; status: { id: string }[] } };
  assert.equal(JSON.stringify(reg.declaration("report").status.map((x) => x.id)), '["sandbox"]');
  assert.equal(
    JSON.stringify(
      reg
        .declaration("report")
        .menus.flatMap((m) => m.items.map((i) => i.command ?? ""))
        .filter(Boolean),
    ),
    JSON.stringify(cmds),
    "the registered declaration is REPORT_DECLARATION",
  );
  for (const c of cmds) assert.doesNotThrow(() => s.command(c), c);
  clicked.length = 0;
  s.command("report.download");
  assert.deepEqual(clicked, [`${BASE}?raw=1`]);
  clicked.length = 0;
  assert.doesNotThrow(() => s.command("report.nope"));
  assert.deepEqual(clicked, []);
});

const enabledOf = (s: ReturnType<typeof setup>, command: string) => {
  const last = s.menuStates.filter((m) => m.command === command && m.state.includes("enabled")).at(-1);
  return last ? (JSON.parse(last.state) as { enabled: boolean }).enabled : undefined;
};

test("Download and View source are disabled before the report loads and enabled after it loads", async () => {
  const s = setup({ [BASE]: { body: { name: "x.html", mediaType: "text/html" } }, [`${BASE}?raw=1`]: { text: "src" } });
  s.mount();
  assert.equal(enabledOf(s, "report.download"), false);
  assert.equal(enabledOf(s, "report.view-source"), false);
  clicked.length = 0;
  s.command("report.download");
  s.command("report.view-source");
  await Promise.resolve();
  assert.deepEqual(clicked, [], "a disabled Download downloads nothing");
  assert.ok(!s.fetches.includes(`${BASE}?raw=1`), "a disabled View source fetches nothing");
  await flush();
  assert.equal(enabledOf(s, "report.download"), true);
  assert.equal(enabledOf(s, "report.view-source"), true);
  s.command("report.download");
  assert.deepEqual(clicked, [`${BASE}?raw=1`]);
});

test("Download and View source stay disabled when the report failed to load, and downloading does nothing", async () => {
  for (const status of [404, 500]) {
    const s = setup({ [BASE]: { status } });
    s.mount();
    await flush();
    assert.equal(enabledOf(s, "report.download"), false, String(status));
    assert.equal(enabledOf(s, "report.view-source"), false, String(status));
    clicked.length = 0;
    s.command("report.download");
    assert.deepEqual(clicked, []);
  }
});
