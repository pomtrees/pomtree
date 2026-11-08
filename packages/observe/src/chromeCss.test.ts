import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHROME_CSS, OVERFLOW_WIDTH_PX } from "./chromeCss.ts";
import { contrast, DARK, LIGHT } from "./themeCss.test.ts";

const CLASSES = [
  ".tile-menus",
  ".menuwrap",
  ".tile-menus .tile-btn",
  ".tile-overflow",
  ".menu-drop",
  ".right-edge",
  ".menu-item",
  ".menu-hint",
  ".menu-caution",
  ".menu-head",
  ".menu-sep",
  ".tile-foot",
  ".stat",
  ".mono",
  ".stat-dot",
  ".caution",
];

test("chromeCss: the container query is built from OVERFLOW_WIDTH_PX and the number is defined once", () => {
  assert.equal(OVERFLOW_WIDTH_PX, 420);
  assert.match(CHROME_CSS, /\.tile \{ container-type: inline-size; container-name: tile; \}/);
  const q = /@container tile \(max-width: (\d+)px\) \{([\s\S]*?\n)\}/.exec(CHROME_CSS);
  assert.ok(q, "container query on the tile");
  assert.equal(Number(q[1]), OVERFLOW_WIDTH_PX);
  assert.match(q[2] as string, /\.tile-menus \{ display: none; \}/);
  assert.match(q[2] as string, /\.tile-overflow \{ display: inline-flex; \}/);
  assert.equal(CHROME_CSS.match(/420/g)?.length, 1, "420 appears once in the output (the interpolated query)");
  assert.equal((readFileSync(new URL("./chromeCss.ts", import.meta.url), "utf8").match(/420/g) ?? []).length, 1, "source: the definition only");
  assert.match(CHROME_CSS, /\.tile-overflow \{ display: none;/, "overflow button hidden by default");
});

test("chromeCss: every class in the contract is styled, and the state selectors exist", () => {
  for (const c of CLASSES) assert.ok(CHROME_CSS.includes(c), c);
  for (const s of [
    '[aria-checked="true"]',
    '[aria-disabled="true"]',
    '[aria-expanded="true"]',
    ":hover",
    ":focus-visible",
    '[data-tone="ok"]',
    '[data-tone="warn"]',
    '[data-tone="err"]',
    '[data-tone="info"]',
    "[hidden]",
  ])
    assert.ok(CHROME_CSS.includes(s), s);
});

test("chromeCss: panels stay inside the clipped tile (positioned in it, capped to its width)", () => {
  assert.match(CHROME_CSS, /\.menuwrap \{ position: relative;/);
  assert.match(CHROME_CSS, /\.menu-drop \{ position: absolute;[^}]*max-width: calc\(100cqw/);
  assert.match(CHROME_CSS, /\.menu-drop \{[^}]*max-height: min\(/);
});

test("chromeCss: no colour literals; every token reference carries a fallback", () => {
  const outsideForced = CHROME_CSS.slice(0, CHROME_CSS.indexOf("@media (forced-colors"));
  assert.doesNotMatch(outsideForced, /#[0-9a-fA-F]{3,8}\b|rgb\(|rgba\(|hsl\(/, "no colour literals");
  assert.doesNotMatch(CHROME_CSS, /var\(--[a-z0-9-]+\)/, "every var() has a fallback");
  assert.doesNotMatch(CHROME_CSS, /(^|[;{\s])border:/m, "borders are longhands only");
});

test("chromeCss: forced-colors block uses system colours, drops opacity cues and gradients", () => {
  const i = CHROME_CSS.indexOf("@media (forced-colors: active)");
  assert.ok(i > 0);
  const f = CHROME_CSS.slice(i);
  for (const k of ["Canvas", "CanvasText", "Highlight", "HighlightText", "GrayText"]) assert.ok(f.includes(k), k);
  assert.match(f, /\.menu-item\[aria-disabled="true"\] \{[^}]*opacity: 1/);
});

for (const [name, t] of [
  ["light", LIGHT],
  ["dark", DARK],
] as const) {
  test(`chromeCss: ${name} scheme menu text, hint and footer text (caution uses a --warn marker, not warn text, since warn text is 4.3:1 on the light panel) meet 4.5:1, tone dots 3:1`, () => {
    const panel = t["--surface-2"] as string;
    for (const fg of ["--text", "--muted"]) assert.ok(contrast(t[fg] as string, panel) >= 4.5, `${fg} on the panel surface`);
    for (const dot of ["--ok", "--warn", "--err", "--info", "--muted"]) assert.ok(contrast(t[dot] as string, panel) >= 3, `${dot} dot on the footer surface`);
    assert.ok(contrast(t["--border-strong"] as string, panel) >= 1.2, "panel border is distinguishable");
  });
}

test("chromeCss: the contrast helper can fail on a deliberately bad pair", () => {
  assert.ok(contrast("#777777", "#808080") < 4.5);
});

const queryBlock = () => /@container tile \(max-width: \d+px\) \{([\s\S]*?\n)\}/.exec(CHROME_CSS)?.[1] ?? "";

test("chromeCss: pane controls are styled (toolbar, bordered button, accent primary, shrinking search)", () => {
  assert.match(CHROME_CSS, /\.tile-controls \{ display: flex; align-items: center; gap: [^;]+; flex: 0 1 auto; min-width: 0;[^}]*text-overflow: ellipsis/);
  assert.match(CHROME_CSS, /\.tile-ctl \{[^}]*padding: 0 0\.5rem[^}]*border-width: 1px/);
  assert.match(CHROME_CSS, /\.tile-ctl\.primary \{[^}]*var\(--chrome-accent/);
  assert.match(CHROME_CSS, /\.tile-search \{ flex: 1 1 4rem; min-width: 3rem; max-width: 14rem;/);
  assert.match(CHROME_CSS, /\.tile-ctl:focus-visible/);
  assert.match(CHROME_CSS, /\.tile-controls\[hidden\] \{ display: none; \}/);
});

test("chromeCss: under the narrow container query the control buttons and the view picker go, the search and title stay", () => {
  const q = queryBlock();
  assert.match(q, /\.tile-ctl \{ display: none; \}/, "buttons live in the overflow panel there");
  assert.match(q, /\.tile-view \{ display: none; \}/, "the title already names the view");
  assert.match(q, /\.tile-title \{ flex: 1 1 auto; min-width: 3rem; \}/);
  assert.ok(!/tile-search/.test(q) && !/\.tile-controls \{ display: none/.test(q), "the search never moves");
  assert.ok(!/\.tile-ctl \{ display: none; \}/.test(CHROME_CSS.replace(/@container tile[\s\S]*?\n\}/, "")), "wide: buttons shown (negative control)");
  assert.equal(CHROME_CSS.match(/420/g)?.length, 1, "still one 420, the interpolated query");
});

test("chromeCss: an open menu stops its tile clipping and raises it, keyed on the aria-expanded windowChrome sets", () => {
  assert.match(
    CHROME_CSS,
    /\.tile:has\(\.tile-menus \[aria-expanded="true"\], \.tile-overflow \[aria-expanded="true"\]\) \{ overflow: visible; z-index: 20; \}/,
  );
  const chrome = readFileSync(new URL("./windowChrome.ts", import.meta.url), "utf8");
  assert.ok(chrome.includes('"aria-expanded", o ? "true" : "false"'), "the trigger attribute the selector depends on is set by windowChrome");
  assert.ok(chrome.includes('el("div", "tile-menus")') && chrome.includes('el("span", "tile-overflow")'), "and the wrapper classes exist");
  const layout = readFileSync(new URL("./layoutCss.ts", import.meta.url), "utf8");
  assert.match(layout, /\.tile \{ position: absolute;/, "z-index applies because the tile is positioned");
  const shell = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  assert.ok(/LAYOUT_CSS\}\$\{CHROME_CSS\}/.test(shell), "composed after the layout sheet, which has the unconditional .tile rule");
});
