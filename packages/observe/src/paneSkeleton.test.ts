import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTreePane, renderReportsPane } from "./web.ts";
import { renderAuditPane, renderHostsPane, renderSchedulesPane, renderEscalationsPane } from "./tabs.ts";
import { renderNewAgentPane } from "./newAgent.ts";
import { renderInboxPane } from "./inbox.ts";
import { PANE_CSS } from "./paneKit.ts";
import { LAYOUT_CSS } from "./layoutCss.ts";

// TODO(pane-skeleton-drift-scope): the script checks read the pane scripts as text (strings and createElement calls); they never run them, so a toolbar assembled at runtime from computed class names or tags still passes unnoticed.
// Conformance (drift) test for the pane skeleton in docs/ui-vision.md "Pane consistency rules (decided)".
// Pure string checkers first; the tests below run them on every pane and on a deliberately wrong sample.

interface El {
  tag: string;
  classes: string[];
  attrs: string;
  depth: number;
  parent: number;
}

const VOID = new Set(["input", "br", "img", "hr", "meta", "link", "col", "wbr"]);

export function scanElements(html: string): El[] {
  const src = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const els: El[] = [];
  const stack: number[] = [];
  for (const m of src.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const tag = m[2]!.toLowerCase();
    if (m[1] === "/") {
      while (stack.length) {
        const top = els[stack.pop()!]!;
        if (top.tag === tag) break;
      }
      continue;
    }
    const attrs = m[3] ?? "";
    const cls = /\sclass="([^"]*)"/.exec(attrs);
    const parent = stack.length ? stack[stack.length - 1]! : -1;
    els.push({ tag, classes: cls ? cls[1]!.split(/\s+/).filter(Boolean) : [], attrs, depth: stack.length, parent });
    if (!VOID.has(tag) && !attrs.trimEnd().endsWith("/")) stack.push(els.length - 1);
  }
  return els;
}

export const KINDS = ["tablewrap", "card-list", "pane-form"];

// Each violation starts with its invariant id, then the detail.
export function checkPaneMarkup(html: string): string[] {
  const out: string[] = [];
  const els = scanElements(html);
  const root = els[0];
  if (!root?.classes.includes("pane"))
    out.push(`root-class: first element is <${root?.tag ?? "none"} class="${root?.classes.join(" ") ?? ""}">, not a .pane root`);
  const kids = els.map((e, i) => ({ e, i })).filter((x) => x.e.parent === 0 && x.e.depth === 1);
  const bodies = els.filter((e) => e.classes.includes("pane-body"));
  if (bodies.length !== 1) out.push(`one-body: ${bodies.length} .pane-body elements, expected exactly 1`);
  const bi = kids.findIndex((k) => k.e.classes.includes("pane-body"));
  if (bi < 0) out.push("body-first: no .pane-body child of the root");
  else {
    const stray = kids.slice(0, bi).filter((k) => !k.e.classes.includes("pane-notice"));
    if (stray.length)
      out.push(`body-first: ${stray.map((k) => `<${k.e.tag}${k.e.classes.length ? `.${k.e.classes.join(".")}` : ""}>`).join(",")} precedes .pane-body`);
  }
  for (const e of els) {
    if (/^h[1-6]$/.test(e.tag)) out.push(`no-forbidden: <${e.tag}> heading inside the pane`);
    if (e.tag === "pre") out.push("no-forbidden: <pre> inside the pane");
    if (e.tag === "style") out.push("no-forbidden: inline <style> block");
    if (e.classes.includes("filters")) out.push("no-forbidden: .filters row");
  }
  for (const e of els) {
    const st = /\sstyle="([^"]*)"/.exec(e.attrs);
    if (st && /(^|;)\s*(padding|margin|max-width|width|height)(-[a-z]+)?\s*:/.test(st[1]!))
      out.push(`no-forbidden: <${e.tag}> style attribute sets padding/margin/width/height ("${st[1]!.trim()}")`);
  }
  const within = (i: number, cls: string): boolean => {
    for (let j = i; j >= 0; j = els[j]!.parent) if (els[j]!.classes.includes(cls)) return true;
    return false;
  };
  const withinTag = (i: number, tag: string): boolean => {
    for (let j = i; j >= 0; j = els[j]!.parent) if (els[j]!.tag === tag) return true;
    return false;
  };
  els.forEach((e, i) => {
    const isControl = e.tag === "button" || e.tag === "select" || (e.tag === "input" && /\stype=("search"|search)/.test(e.attrs));
    if (isControl && !within(i, "pane-body") && !within(i, "pane-notice"))
      out.push(`controls-in-chrome: <${e.tag}> outside .pane-body and .pane-notice (controls belong to the window chrome)`);
  });
  if (bi >= 0) {
    const after = kids.slice(bi + 1).filter((k) => !k.e.classes.includes("pane-notice"));
    if (after.length) out.push(`controls-in-chrome: <${after.map((k) => k.e.tag).join(",")}> follows .pane-body (no toolbar after the body)`);
  }
  // A row of two or more controls that sits directly in the body, not in a form or a card: a toolbar by another name.
  const ROWLESS = new Set(["form", "li", "td", "th", "label", "fieldset", "details", "summary", "table", "tr"]);
  els.forEach((e, i) => {
    if (ROWLESS.has(e.tag) || !within(i, "pane-body")) return;
    const direct = els.filter(
      (c) => c.parent === i && (c.tag === "button" || c.tag === "select" || (c.tag === "input" && /\stype=("search"|search)/.test(c.attrs))),
    );
    if (direct.length >= 2 && !e.classes.includes("pane-form") && !withinTag(i, "form") && !withinTag(i, "li"))
      out.push(
        `toolbar-in-body: <${e.tag}${e.classes.length ? `.${e.classes.join(".")}` : ""}> holds ${direct.length} controls in a row inside .pane-body (controls belong to the window chrome)`,
      );
  });
  if (!bodies.some((b) => KINDS.some((k) => b.classes.includes(k)))) out.push(`body-kind: .pane-body has none of ${KINDS.join(", ")}`);
  out.push(...checkPaneScript(html));
  return out;
}

// The script text of the pane, read as source (never run): forbidden elements and toolbar classes the markup check cannot see.
export function checkPaneScript(html: string): string[] {
  const out: string[] = [];
  const js = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]!).join("\n");
  for (const m of js.matchAll(/createElement\(\s*["'](h[1-6]|style)["']\s*\)/g)) out.push(`script-forbidden: script creates <${m[1]}>`);
  for (const m of js.matchAll(/(?:class=\\?["']|className\s*=\s*["'])([^"'\\]*)/g)) {
    for (const c of m[1]!.split(/\s+/))
      if (c === "filters" || c === "toolbar") out.push(`script-forbidden: script builds a .${c} row (controls belong to the window chrome)`);
  }
  return out;
}

export function violationsOf(html: string, invariant: string): string[] {
  return checkPaneMarkup(html).filter((v) => v.startsWith(`${invariant}:`));
}

interface Rule {
  selectors: string[];
  body: string;
}

export function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ selectors: m[1]!.split(",").map((s) => s.trim().replace(/\s+/g, " ")), body: m[2]! });
  }
  return rules;
}

const decl = (r: Rule, prop: string): string | null => {
  const m = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(r.body);
  return m ? m[1]!.trim() : null;
};
const isOverride = (s: string): boolean => s.includes("body:not(.wm)");
const isPaneRoot = (s: string, roots: string[] = ROOTS): boolean => {
  const last = s.split(/[\s>]+/).pop() ?? "";
  return /(^|\.)pane(?![\w-])/.test(last) || roots.some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(last));
};

export function checkTilePadding(css: string): string[] {
  const hits = parseRules(css).filter((r) => r.selectors.includes(".tile-body > section"));
  if (!hits.length) return ["tile-padding: no `.tile-body > section` rule"];
  return hits.flatMap((r) => {
    const p = decl(r, "padding");
    return p !== null && /^0(\s+0){0,3}(px|rem)?$/.test(p) ? [] : [`tile-padding: .tile-body > section padding is ${p}, expected 0`];
  });
}

export function checkRootMaxWidth(css: string, roots: string[] = ROOTS): string[] {
  return parseRules(css).flatMap((r) =>
    r.selectors
      .filter((s) => isPaneRoot(s, roots))
      .filter(() => decl(r, "max-width") !== null)
      .map((s) => `root-max-width: "${s}" sets max-width`),
  );
}

export function checkRootPadding(css: string, roots: string[] = ROOTS): string[] {
  return parseRules(css).flatMap((r) =>
    r.selectors
      .filter((s) => isPaneRoot(s, roots))
      .filter(() => {
        const p = decl(r, "padding");
        return p !== null && !/^0(\s+0){0,3}(px|rem)?$/.test(p);
      })
      .map((s) => `root-padding: "${s}" sets padding ${decl(r, "padding")}`),
  );
}

export function checkRootMargin(css: string, roots: string[] = ROOTS): string[] {
  return parseRules(css).flatMap((r) =>
    r.selectors
      .filter((s) => isPaneRoot(s, roots))
      .filter(() => {
        const m = decl(r, "margin");
        return m !== null && !/^0(\s+0){0,3}(px|rem)?$/.test(m);
      })
      .map((s) => `root-margin: "${s}" sets margin ${decl(r, "margin")}`),
  );
}

export function checkTablewrapFlat(css: string): string[] {
  return parseRules(css).flatMap((r) =>
    r.selectors
      .filter((s) => s.includes(".tablewrap") && !isOverride(s))
      .flatMap((s) =>
        ["box-shadow", "border-radius"].filter((p) => decl(r, p) !== null).map((p) => `tablewrap-flat: "${s}" sets ${p} outside the body:not(.wm) override`),
      ),
  );
}

export function checkStickyHeader(css: string): string[] {
  const ok = parseRules(css).some((r) => r.selectors.some((s) => /(^|[\s>])th$/.test(s)) && /position\s*:\s*sticky/.test(r.body));
  return ok ? [] : ["sticky-header: no th rule with position: sticky"];
}

export function checkNoSpanState(css: string): string[] {
  return /span\.state/.test(css) ? ["span-state: span.state rules still present"] : [];
}

export function checkSkeletonClasses(css: string, names: string[]): string[] {
  return names.filter((n) => !new RegExp(`\\.${n}(?![\\w-])`).test(css)).map((n) => `skeleton-class: .${n} missing`);
}

const PANES: [string, () => string][] = [
  ["tree", () => renderTreePane()],
  ["reports", () => renderReportsPane()],
  ["audit", () => renderAuditPane()],
  ["hosts", () => renderHostsPane()],
  ["schedules", () => renderSchedulesPane()],
  ["escalations", () => renderEscalationsPane()],
  ["newagent", () => renderNewAgentPane()],
  ["inbox", () => renderInboxPane()],
];

// Root classes the renderers actually emit on the pane root (derived from the markup, minus the shared skeleton classes).
const ROOTS = [...new Set(PANES.flatMap(([, f]) => scanElements(f())[0]?.classes ?? []))].filter((c) => c !== "pane" && c !== "pane-fill");

const INVARIANTS: [string, string][] = [
  ["root-class", "root element has class pane"],
  ["one-body", "exactly one .pane-body"],
  ["body-first", ".pane-body first child (or after .pane-notice only)"],
  ["no-forbidden", "no heading, .filters, <pre>, <style>, inline spacing/size style"],
  ["controls-in-chrome", "no button/search/select outside .pane-body and .pane-notice, nothing after the body"],
  ["body-kind", ".pane-body is tablewrap, card-list or pane-form"],
  ["toolbar-in-body", "no row of two or more controls directly in .pane-body outside a form or card"],
  ["script-forbidden", "pane script builds no heading, <style> or .filters/.toolbar row"],
];

for (const [pane, render] of PANES) {
  for (const [inv, what] of INVARIANTS) {
    test(`pane ${pane}: ${inv} (${what})`, () => {
      assert.deepEqual(violationsOf(render(), inv), []);
    });
  }
}

const GOOD = `<div class="x pane"><div class="pane-notice" role="status"></div><div class="tablewrap pane-body"><table></table></div></div><script>var a = "<h3>";</script>`;
const BAD = `<div class="x" style="max-width: 40rem"><h3>T</h3><div class="filters"></div><pre id="p"></pre><style>a{}</style><div class="pane-body"><div class="bar"><button>a</button><select></select></div></div><div class="pane-body"></div><script>const h = document.createElement("h3"); d.className = "filters toolbar";</script></div>`;

test("negative control: checker accepts a conforming sample (scripts ignored)", () => {
  assert.deepEqual(checkPaneMarkup(GOOD), []);
});

for (const [inv] of INVARIANTS) {
  test(`negative control: checker reports ${inv} on a wrong sample`, () => {
    assert.ok(violationsOf(BAD, inv).length > 0, `${inv} not detected`);
  });
}

test("negative control: root-class/body-first on a pane with a toolbar row first", () => {
  const html = `<div class="tree pane"><div><a class="btn">New</a></div><div class="tablewrap pane-body"></div></div>`;
  assert.ok(violationsOf(html, "body-first").length > 0);
  assert.deepEqual(violationsOf(html, "root-class"), []);
});

test("negative control: a control row in the body and script-built headings or toolbars are flagged; forms, cards and plain script pass", () => {
  const pane = (inner: string, js = "") => `<div class="x pane"><div class="tablewrap pane-body">${inner}</div>${js ? `<script>${js}</script>` : ""}</div>`;
  for (const row of [`<div class="bar"><button>a</button><button>b</button></div>`, `<p><select></select><input type="search"></p>`]) {
    assert.ok(violationsOf(pane(row), "toolbar-in-body").length > 0, row);
  }
  for (const ok of [
    `<form><button>a</button><button>b</button></form>`,
    `<ul><li><button>a</button><button>b</button></li></ul>`,
    `<div class="one"><button>a</button></div>`,
  ]) {
    assert.deepEqual(violationsOf(pane(ok), "toolbar-in-body"), [], ok);
  }
  for (const js of [
    `document.createElement("h2")`,
    `document.createElement('style')`,
    `bar.className = "filters"`,
    `h = '<div class="toolbar">'`,
    `n.className = "a toolbar"`,
  ]) {
    assert.ok(violationsOf(pane("", js), "script-forbidden").length > 0, js);
  }
  for (const js of [`document.createElement("tr"); li.className = "pane-empty"`, `var s = "filter"; const x = "<h3>";`]) {
    assert.deepEqual(violationsOf(pane("", js), "script-forbidden"), [], js);
  }
});

test("negative control: inline style on a non-root element is flagged (each property)", () => {
  for (const st of ["padding: 1rem", "margin-top:2px", "max-width: 9rem", "width: 50%", "height:3rem", "color:red;width:1px"]) {
    const html = `<div class="x pane"><div class="tablewrap pane-body"><table><tr><td style="${st}"></td></tr></table></div></div>`;
    assert.ok(violationsOf(html, "no-forbidden").length > 0, st);
  }
  const ok = `<div class="x pane"><div class="tablewrap pane-body"><table><tr><td style="color:red;line-height:1;min-height:1px"></td></tr></table></div></div>`;
  assert.deepEqual(violationsOf(ok, "no-forbidden"), []);
});

test("negative control: controls outside the body or a toolbar after the body are flagged", () => {
  const body = `<div class="tablewrap pane-body"><table></table></div>`;
  const bad = [
    `<div class="x pane"><button>New</button>${body}</div>`,
    `<div class="x pane"><div class="bar"><input type="search"></div>${body}</div>`,
    `<div class="x pane">${body}<div class="bar"></div></div>`,
    `<div class="x pane"><select></select>${body}</div>`,
    `<div class="x pane"><div class="pane-notice"><button>x</button></div><span><button>y</button></span>${body}</div>`,
  ];
  for (const h of bad) assert.ok(violationsOf(h, "controls-in-chrome").length > 0, h);
  const good = `<div class="x pane"><div class="pane-notice" role="status"><button>Retry</button></div><form class="pane-form pane-body"><button>Go</button><input type="search"><select></select></form></div>`;
  assert.deepEqual(violationsOf(good, "controls-in-chrome"), []);
});

const CSS = `${PANE_CSS}\n${LAYOUT_CSS}`;

test("css: .tile-body > section padding is 0", () => {
  assert.deepEqual(checkTilePadding(LAYOUT_CSS), []);
});
test("css: .pane root has no max-width (incl. .pane.newagent)", () => {
  assert.deepEqual(checkRootMaxWidth(CSS), []);
});
test("css: roots derived from the rendered markup", () => {
  assert.equal(ROOTS.includes("inbox") && ROOTS.includes("tree") && ROOTS.includes("hosts") && !ROOTS.includes("pane"), true, ROOTS.join(","));
});
test("css: pane root has no non-zero margin", () => {
  assert.deepEqual(checkRootMargin(CSS), []);
});
test("css: .pane root has no non-zero padding", () => {
  assert.deepEqual(checkRootPadding(CSS), []);
});
test("css: .tablewrap has no box-shadow or border-radius outside body:not(.wm)", () => {
  assert.deepEqual(checkTablewrapFlat(CSS), []);
});
test("css: thead header cell is position: sticky", () => {
  assert.deepEqual(checkStickyHeader(CSS), []);
});
test("css: span.state rules are gone", () => {
  assert.deepEqual(checkNoSpanState(CSS), []);
});
test("css: PANE_CSS defines every skeleton class", () => {
  assert.deepEqual(checkSkeletonClasses(PANE_CSS, ["pane-body", "pane-notice", "card-list", "pane-form", "pane-empty"]), []);
});

test("negative control: css checkers report violations on wrong samples", () => {
  assert.ok(checkTilePadding(".tile-body > section { padding: 0.75rem; }").length > 0);
  assert.ok(checkTilePadding(".x { color: red; }").length > 0);
  assert.deepEqual(checkTilePadding(".tile-body > section { padding: 0; }"), []);
  assert.ok(checkRootMaxWidth(".pane.newagent { max-width: 40rem; }").length > 0);
  assert.deepEqual(checkRootMaxWidth(".pane .filters input { max-width: 16rem; } .pane-body { max-width: 9rem; }"), []);
  assert.ok(checkRootPadding(".tile-body .wm-mount .pane:not(.pane-fill) { padding: 0.75rem; }").length > 0);
  for (const root of ["inbox", "tree", "audit", "hosts", "schedules", "escalations", "newagent", "reports"]) {
    assert.ok(checkRootPadding(`.${root} { padding: 1rem; }`, ROOTS.concat(root)).length > 0, `padding ${root}`);
    assert.ok(checkRootMargin(`.tile-body .${root} { margin: 0 auto; margin: 1rem; }`, ROOTS.concat(root)).length > 0, `margin ${root}`);
    assert.ok(checkRootMaxWidth(`.${root} { max-width: 40rem; }`, ROOTS.concat(root)).length > 0, `max-width ${root}`);
    assert.deepEqual(checkRootPadding(`.${root} li.compose { padding: 1rem; } .${root} .x { margin: 1rem; max-width: 1px; }`, ROOTS.concat(root)), []);
    assert.deepEqual(checkRootMargin(`.${root} li.compose { margin: 1rem; }`, ROOTS.concat(root)), []);
  }
  assert.ok(checkTablewrapFlat(".pane .tablewrap { box-shadow: 0 0 2px red; }").length > 0);
  assert.ok(checkTablewrapFlat(".tablewrap { border-radius: 4px; }").length > 0);
  assert.deepEqual(checkTablewrapFlat("body:not(.wm) .pane .tablewrap { border-radius: 4px; box-shadow: none; }"), []);
  assert.ok(checkStickyHeader(".pane th { color: red; }").length > 0);
  assert.deepEqual(checkStickyHeader(".pane thead th { position: sticky; top: 0; }"), []);
  assert.ok(checkNoSpanState(".pane span.state { color: red; }").length > 0);
  assert.ok(checkSkeletonClasses(".pane-body { }", ["pane-body", "pane-form"]).length === 1);
});
