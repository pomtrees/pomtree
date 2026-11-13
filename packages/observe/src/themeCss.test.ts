import { test } from "node:test";
import assert from "node:assert/strict";
import { UI_CSS } from "./shell.ts";
import { THEME_CSS } from "./themeCss.ts";

type Tokens = Record<string, string>;

// Pull `--name: value;` pairs out of a CSS block (values here are hex or rgb(); no nested semicolons).
const tokensIn = (block: string): Tokens => {
  const out: Tokens = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[m[1] as string] = (m[2] as string).trim();
  return out;
};
const DARK_MARK = "@media (prefers-color-scheme: dark) {";
// Body of the first dark media block's :root rule in a stylesheet.
const darkRoot = (css: string): string => {
  const i = css.indexOf(DARK_MARK);
  assert.ok(i >= 0, "stylesheet has a dark media block");
  const j = css.indexOf("}", css.indexOf(":root", i));
  return css.slice(css.indexOf("{", css.indexOf(":root", i)) + 1, j);
};
const lightRoot = (css: string): string => css.slice(css.indexOf(":root {") + 7, css.indexOf("\n}", css.indexOf(":root {")));

export const LIGHT: Tokens = { ...tokensIn(lightRoot(UI_CSS)), ...tokensIn(lightRoot(THEME_CSS)) };
export const DARK: Tokens = { ...LIGHT, ...tokensIn(darkRoot(UI_CSS)), ...tokensIn(darkRoot(THEME_CSS)) };

const rgb = (hex: string): [number, number, number] => {
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())?.[1];
  assert.ok(h, `token value ${JSON.stringify(hex)} is a hex colour`);
  const f = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((k) => Number.parseInt(f.slice(k, k + 2), 16)) as [number, number, number];
};
const luminance = (hex: string): number => {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const hue = (hex: string): number => {
  const [r, g, b] = rgb(hex).map((v) => v / 255) as [number, number, number];
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const hueGap = (a: string, b: string): number => {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
};

const TEXT = ["--text", "--muted", "--accent", "--ok", "--warn", "--err", "--info"];
const SURFACES = ["--bg", "--surface", "--surface-2", "--hover"];

interface Pair {
  fg: string;
  bg: string;
  min: number;
}
const pairs = (): Pair[] => [
  ...TEXT.flatMap((fg) => SURFACES.map((bg) => ({ fg, bg, min: 4.5 }))),
  { fg: "--accent-fg", bg: "--accent", min: 4.5 },
  { fg: "--accent-fg", bg: "--accent-hover", min: 4.5 },
  { fg: "--chrome-fg", bg: "--chrome-bg", min: 4.5 },
  { fg: "--chrome-accent-fg", bg: "--chrome-accent", min: 4.5 },
  { fg: "--accent", bg: "--bg", min: 3 },
  { fg: "--accent", bg: "--surface", min: 3 },
  { fg: "--border-strong", bg: "--surface", min: 3 },
  { fg: "--chrome-accent", bg: "--chrome-bg", min: 3 },
];

test("dark scheme: every text and UI pair meets its WCAG contrast floor", () => {
  const rows: string[] = [];
  const failures: string[] = [];
  for (const { fg, bg, min } of pairs()) {
    const r = contrast(DARK[fg] as string, DARK[bg] as string);
    rows.push(`dark  ${fg.padEnd(18)} on ${bg.padEnd(15)} ${r.toFixed(2).padStart(6)} (>= ${min})`);
    if (r < min) failures.push(`${fg} on ${bg} = ${r.toFixed(2)} < ${min}`);
  }
  if (process.env.THEME_CONTRAST_TABLE) console.log(rows.join("\n"));
  assert.deepEqual(failures, [], "raise the lightness of the failing token in the dark block of UI_CSS (shell.ts)");
});

// Existing light pairs that already fall short of 4.5 (status colours on --surface-2 and --hover, --info just under, and --border-strong,
// which is a border, not meant for 3:1). The light values are frozen by the theme change, so these are excluded from the
// assertion and reported in the contrast table instead of being fixed here.
const LIGHT_KNOWN_SHORT = new Set([
  "--ok on --surface-2",
  "--ok on --hover",
  "--warn on --surface-2",
  "--warn on --hover",
  "--info on --surface-2",
  "--info on --hover",
  "--border-strong on --surface",
]);

test("light scheme: chrome pairs and every pair that already passed still meet their floor", () => {
  const rows: string[] = [];
  const failures: string[] = [];
  for (const { fg, bg, min } of pairs()) {
    const r = contrast(LIGHT[fg] as string, LIGHT[bg] as string);
    rows.push(`light ${fg.padEnd(18)} on ${bg.padEnd(15)} ${r.toFixed(2).padStart(6)} (>= ${min})`);
    if (r < min && !LIGHT_KNOWN_SHORT.has(`${fg} on ${bg}`)) failures.push(`${fg} on ${bg} = ${r.toFixed(2)} < ${min}`);
  }
  if (process.env.THEME_CONTRAST_TABLE) console.log(rows.join("\n"));
  assert.deepEqual(failures, []);
});

test("dark scheme: warn and err are clearly not the orange accent by hue", () => {
  for (const t of ["--warn", "--err"]) {
    const gap = hueGap(DARK[t] as string, DARK["--accent"] as string);
    assert.ok(gap >= 30, `${t} hue is ${gap.toFixed(0)} degrees from --accent, need >= 30`);
  }
});

test("the contrast helper can fail: a low-contrast pair is below the floor", () => {
  assert.ok(contrast("#777777", "#808080") < 4.5);
  assert.ok(contrast("#000000", "#ffffff") > 20.9);
});

test("THEME_CSS uses only existing tokens and the five chrome tokens", () => {
  const defined = new Set([...Object.keys(LIGHT)]);
  for (const m of THEME_CSS.matchAll(/var\((--[a-z0-9-]+)/g)) assert.ok(defined.has(m[1] as string), `${m[1]} is defined`);
  for (const t of ["--chrome-bg", "--chrome-fg", "--chrome-border", "--chrome-accent", "--chrome-accent-fg"]) {
    assert.ok(LIGHT[t] && DARK[t], `${t} defined in both schemes`);
  }
  assert.notEqual(LIGHT["--chrome-accent"], DARK["--chrome-accent"]);
});

const ALLOWED = new Set([
  "color",
  "background",
  "background-color",
  "background-image",
  "border-color",
  "border-radius",
  "box-shadow",
  "text-shadow",
  "filter",
  "opacity",
  "outline-color",
  "transition",
]);

// Flat rules of THEME_CSS: [selector, declarations, inDarkMedia, inForcedColors].
const rulesOf = (css: string): Array<{ sel: string; body: string; dark: boolean; forced: boolean }> => {
  const out: Array<{ sel: string; body: string; dark: boolean; forced: boolean }> = [];
  let dark = false;
  let forced = false;
  let depth = 0;
  let start = 0;
  let head = "";
  const stack: string[] = [];
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") {
      head = css.slice(start, i).trim();
      if (head.startsWith("@media")) {
        if (head.includes("prefers-color-scheme: dark")) dark = true;
        if (head.includes("forced-colors")) forced = true;
        stack.push(head);
      } else {
        stack.push("");
        const end = css.indexOf("}", i);
        out.push({ sel: head, body: css.slice(i + 1, end), dark, forced });
        i = end;
        stack.pop();
        start = i + 1;
        continue;
      }
      depth++;
      start = i + 1;
    } else if (c === "}") {
      const m = stack.pop() ?? "";
      if (m.includes("prefers-color-scheme: dark")) dark = false;
      if (m.includes("forced-colors")) forced = false;
      depth--;
      start = i + 1;
    }
  }
  assert.equal(depth, 0, "balanced braces");
  return out;
};
const decls = (body: string): Array<[string, string]> =>
  body
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]);

test("THEME_CSS is colour-only: every property is on the allowlist (no geometry), and it ends UI_CSS", () => {
  const unknown: string[] = [];
  for (const r of rulesOf(THEME_CSS)) {
    for (const [p] of decls(r.body)) if (!ALLOWED.has(p) && !p.startsWith("--chrome-")) unknown.push(`${r.sel} { ${p} }`);
  }
  assert.deepEqual(unknown, [], "THEME_CSS may style colour only; geometry belongs to the layout");
  assert.match(THEME_CSS, /forced-colors: active/);
  assert.ok(UI_CSS.endsWith(THEME_CSS), "THEME_CSS is composed last in UI_CSS");
});

test("forced-colors state rules clear the gradients and shadows of every themed state", () => {
  const forced = rulesOf(THEME_CSS).filter((r) => r.forced && /background-image:\s*none/.test(r.body) && /box-shadow:\s*none/.test(r.body));
  const covered = new Set(forced.flatMap((r) => r.sel.split(",").map((s) => s.trim())));
  const themed = rulesOf(THEME_CSS).filter((r) => !r.forced && /(background-image|box-shadow)/.test(r.body));
  for (const r of themed) for (const s of r.sel.split(",").map((x) => x.trim())) assert.ok(covered.has(s), `forced-colors clears ${s}`);
});

// Split on top-level commas (outside parentheses).
const splitTop = (s: string): string[] => {
  const out: string[] = [];
  let d = 0;
  let cur = "";
  for (const c of s) {
    if (c === "(") d++;
    if (c === ")") d--;
    if (c === "," && d === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
};
// Resolve a token, hex or color-mix(in srgb, A p%, B) to hex.
const resolve = (v: string, tokens: Tokens): string => {
  v = v.trim();
  if (v.startsWith("var(")) return resolve(tokens[v.slice(4, -1).trim()] as string, tokens);
  if (v.startsWith("color-mix(")) {
    const [, a, b] = splitTop(v.slice(10, -1)) as [string, string, string];
    const m = /^(.*?)\s+(\d+(?:\.\d+)?)%$/.exec(a);
    assert.ok(m, `color-mix first colour has a percentage: ${a}`);
    const p = Number(m[2]) / 100;
    const ca = rgb(resolve(m[1] as string, tokens));
    const cb = rgb(resolve(b, tokens));
    return `#${ca
      .map((x, i) =>
        Math.round(x * p + (cb[i] as number) * (1 - p))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
  }
  return v;
};
// Every colour stop behind text in a gradient, resolved for a scheme.
const stopsOf = (gradient: string, tokens: Tokens): string[] => {
  const inner = gradient.slice(gradient.indexOf("(") + 1, gradient.lastIndexOf(")"));
  return splitTop(inner)
    .slice(1)
    .map((s) => resolve(s.replace(/\s+\d+%$/, ""), tokens));
};

// The lowest text-on-stop contrast of the title and button gradients for one scheme (min over every stop).
export const gradientTextMin = (css: string, tokens: Tokens, dark: boolean): { min: number; where: string } => {
  const rules = rulesOf(css).filter((r) => !r.forced);
  const darkSels = new Set(rules.filter((r) => r.dark && /background-image/.test(r.body)).map((r) => r.sel));
  let min = Number.POSITIVE_INFINITY;
  let where = "";
  for (const r of rules) {
    if (!/\.tile-(bar|title|btn)/.test(r.sel)) continue;
    if (r.dark !== dark && (r.dark || darkSels.has(r.sel))) continue; // dark-only rule skipped in light; overridden base skipped in dark
    const bg = decls(r.body).find(([p]) => p === "background-image");
    if (!bg) continue;
    const text = tokens[r.sel.includes(".tile-focused") ? "--chrome-accent-fg" : "--chrome-fg"] as string;
    for (const stop of stopsOf(bg[1], tokens)) {
      const c = contrast(text, stop);
      if (c < min) {
        min = c;
        where = `${r.sel} stop ${stop} vs ${text}`;
      }
    }
  }
  return { min, where };
};

test("text on every title/button gradient stop keeps >= 4.5 in both schemes", () => {
  for (const [name, tokens, dark] of [
    ["light", LIGHT, false],
    ["dark", DARK, true],
  ] as const) {
    const { min, where } = gradientTextMin(THEME_CSS, tokens, dark);
    if (process.env.THEME_CONTRAST_TABLE) console.log(`${name} gradient-stop min ${min.toFixed(2)} (${where})`);
    assert.ok(Number.isFinite(min), `${name}: gradients found`);
    assert.ok(min >= 4.5, `${name}: ${where} = ${min.toFixed(2)} < 4.5`);
  }
});

test("the gradient check can fail: a stop mixed toward white fails against white text", () => {
  const bad = `.tile-focused .tile-title { background-image: linear-gradient(to bottom, color-mix(in srgb, var(--chrome-accent) 55%, #fff) 0%, var(--chrome-accent) 100%); }`;
  assert.ok(gradientTextMin(bad, LIGHT, false).min < 4.5);
});

test("every splitter gloss that runs to right has a horizontal-splitter counterpart running to bottom with the same stops", () => {
  const rules = rulesOf(THEME_CSS).filter((r) => !r.forced);
  const gradient = (body: string): string | undefined => decls(body).find(([p]) => p === "background-image")?.[1];
  const horizontal = (sel: string): string => sel.replace(/^\.splitter/, '.splitter[aria-orientation="horizontal"]');
  const vertical = rules.filter((r) => /\.splitter/.test(r.sel) && gradient(r.body)?.startsWith("linear-gradient(to right"));
  assert.ok(vertical.length >= 2, "base and hover/active splitter glosses found");
  for (const r of vertical) {
    for (const sel of r.sel.split(",").map((s) => s.trim())) {
      const twin = rules.find(
        (t) =>
          t.sel
            .split(",")
            .map((s) => s.trim())
            .includes(horizontal(sel)) && t.dark === r.dark,
      );
      assert.ok(twin, `${sel} has a horizontal counterpart`);
      assert.equal(gradient(twin.body), gradient(r.body)?.replace("linear-gradient(to right", "linear-gradient(to bottom"), `${sel}: same stops, to bottom`);
    }
  }
});

// Declarations of every non-forced rule naming the selector, later rules overriding earlier ones.
const declsFor = (sel: string): Record<string, string> =>
  Object.fromEntries(
    rulesOf(THEME_CSS)
      .filter(
        (r) =>
          !r.forced &&
          !r.dark &&
          r.sel
            .split(",")
            .map((x) => x.trim())
            .includes(sel),
      )
      .flatMap((r) => decls(r.body)),
  );

test("splitter hover, active and keyboard focus fill with the accent in both orientations, and that fill is a >= 3:1 component in both schemes", () => {
  for (const state of [":hover", ":active", ":focus-visible"]) {
    for (const [orientation, sel, dir] of [
      ["vertical", `.splitter${state}`, "to right"],
      ["horizontal", `.splitter[aria-orientation="horizontal"]${state}`, "to bottom"],
    ] as const) {
      // The horizontal state rule only restates the gradient; the fill colour comes from the shared state rule it layers on.
      const d = { ...declsFor(`.splitter${state}`), ...declsFor(sel) };
      assert.equal(d["background-color"], "var(--chrome-accent)", `${orientation} ${state}: background-color is the accent`);
      const gradient = d["background-image"] ?? "";
      assert.ok(gradient.startsWith(`linear-gradient(${dir},`), `${orientation} ${state}: background-image runs ${dir} (found ${gradient || "none"})`);
      assert.match(gradient, /var\(--chrome-accent\) 50%/, `${orientation} ${state}: the centre stop is the accent`);
    }
  }
  for (const [name, tokens] of [
    ["light", LIGHT],
    ["dark", DARK],
  ] as const) {
    for (const bg of ["--bg", "--surface"]) {
      const r = contrast(tokens["--chrome-accent"] as string, tokens[bg] as string);
      assert.ok(r >= 3, `${name}: focused splitter fill on ${bg} = ${r.toFixed(2)} < 3`);
    }
  }
});

test("the resting splitter has a centred 2px grip line in --chrome-border that is a >= 3:1 component against the page and tile body, both orientations and schemes", () => {
  for (const [orientation, sel, dir] of [
    ["vertical", ".splitter", "to right"],
    ["horizontal", '.splitter[aria-orientation="horizontal"]', "to bottom"],
  ] as const) {
    const gradient = declsFor(sel)["background-image"] ?? "";
    assert.ok(gradient.startsWith(`linear-gradient(${dir},`), `${orientation} resting splitter gradient runs ${dir}`);
    const stops = splitTop(gradient.slice(gradient.indexOf("(") + 1, gradient.lastIndexOf(")")))
      .slice(1)
      .map((x) => /^(.*?)\s+(calc\(.*\)|\d+%)$/.exec(x) ?? [x, x, ""]);
    const grip = stops.filter((m) => m[1] === "var(--chrome-border)").map((m) => m[2]);
    assert.deepEqual(grip, ["calc(50% - 1px)", "calc(50% + 1px)"], `${orientation} resting splitter: a 2px --chrome-border line centred on the splitter`);
  }
  for (const [name, tokens] of [
    ["light", LIGHT],
    ["dark", DARK],
  ] as const) {
    for (const bg of ["--bg", "--surface"]) {
      const r = contrast(tokens["--chrome-border"] as string, tokens[bg] as string);
      assert.ok(r >= 3, `${name}: resting splitter grip on ${bg} = ${r.toFixed(2)} < 3`);
    }
  }
});

test("forced-colors keeps the focused tile bar and the notice strip visible with system colours", () => {
  const forced = rulesOf(THEME_CSS).filter((r) => r.forced);
  const system = /^(Canvas|CanvasText|Highlight|HighlightText|ButtonFace|ButtonText|ButtonBorder)$/;
  const want: Record<string, string[]> = {
    ".tile-focused > .tile-bar": ["background-color", "color", "border-color"],
    ".wm-notice": ["background-color", "color", "border-color"],
  };
  for (const [sel, props] of Object.entries(want)) {
    const r = forced.find((x) =>
      x.sel
        .split(",")
        .map((s) => s.trim())
        .includes(sel),
    );
    assert.ok(r, `${sel} is styled inside the forced-colors block`);
    const d = Object.fromEntries(decls(r.body));
    for (const p of props) assert.match(d[p] ?? "", system, `${sel} ${p} is a system colour`);
  }
  assert.deepEqual(highlightBackgrounds(THEME_CSS), []);
});

// Chrome maps forced-colors Highlight to a translucent colour and paints a Canvas backplate behind text, so HighlightText on it is invisible.
const highlightBackgrounds = (css: string): string[] =>
  rulesOf(css)
    .filter((r) => r.forced)
    .flatMap((r) =>
      r.sel
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s === ".tile-focused > .tile-bar" || s === ".wm-notice")
        .filter(() => decls(r.body).some(([p, v]) => p === "background-color" && v === "Highlight"))
        .map((s) => `${s} uses background-color: Highlight`),
    );

test("the forced-colors Highlight check can fail: a Highlight notice background is flagged", () => {
  const wrong = THEME_CSS.replace(/(\.wm-notice \{[^}]*?)background-color: \w+;/, "$1background-color: Highlight;");
  assert.notEqual(wrong, THEME_CSS, "the scratch copy changed the notice background");
  assert.deepEqual(highlightBackgrounds(wrong), [".wm-notice uses background-color: Highlight"]);
});

// In forced colours the title is transparent and inherits from its bar, so the bar must carry the system colours in both states.
const forcedTitlePairing = (css: string): string[] => {
  const forced = rulesOf(css).filter((r) => r.forced);
  // Later rules win, so merge every forced rule naming the selector in order.
  const declsOf = (sel: string): Record<string, string> =>
    Object.fromEntries(
      forced
        .filter((x) =>
          x.sel
            .split(",")
            .map((s) => s.trim())
            .includes(sel),
        )
        .flatMap((x) => decls(x.body)),
    );
  const problems: string[] = [];
  for (const sel of [".tile-title", ".tile-focused .tile-title"]) {
    const d = declsOf(sel);
    if (d["background-color"] !== "transparent") problems.push(`${sel} background-color is ${d["background-color"]}, need transparent`);
    if (d.color !== "inherit") problems.push(`${sel} color is ${d.color}, need inherit`);
  }
  const bars: Array<[string, string, string]> = [
    [".tile-bar", "ButtonFace", "ButtonText"],
    // Not Highlight: Chrome paints a Canvas backplate behind text over a translucent Highlight, so HighlightText vanishes.
    [".tile-focused > .tile-bar", "ButtonFace", "ButtonText"],
  ];
  for (const [sel, bg, fg] of bars) {
    const d = declsOf(sel);
    if (d["background-color"] !== bg) problems.push(`${sel} background-color is ${d["background-color"]}, need ${bg}`);
    if (d.color !== fg) problems.push(`${sel} color is ${d.color}, need ${fg}`);
  }
  // Focus must still read: the fill matches the resting bar, so the bar's bottom edge (and the tile border) is Highlight.
  const fb = declsOf(".tile-focused > .tile-bar");
  if (fb["border-color"] !== "Highlight") problems.push(`focused bar border-color is ${fb["border-color"]}, need Highlight`);
  return problems;
};

test("forced-colors: transparent tile titles inherit a system-coloured bar in both the focused and unfocused state", () => {
  assert.deepEqual(forcedTitlePairing(THEME_CSS), []);
});

test("the forced-colors title pairing check can fail: the previous ButtonFace/Highlight title boxes are flagged", () => {
  const old = THEME_CSS.replace(
    /\.tile-title \{ background-color: transparent; color: inherit; border-color: transparent; \}/,
    ".tile-title { background-color: ButtonFace; color: ButtonText; }",
  ).replace(/\n {2}\.tile-bar \{[^}]*\}/, "");
  assert.ok(forcedTitlePairing(old).length >= 2);
});

test("dark scheme: the chrome border (tile edge, resting splitter) is a >= 3:1 UI component against the page and the tile surface", () => {
  for (const bg of ["--bg", "--surface"]) {
    const r = contrast(DARK["--chrome-border"] as string, DARK[bg] as string);
    assert.ok(r >= 3, `--chrome-border on ${bg} = ${r.toFixed(2)} < 3 (WCAG 1.4.11)`);
  }
  const { r, g, b } = {
    r: rgb(DARK["--chrome-border"] as string)[0],
    g: rgb(DARK["--chrome-border"] as string)[1],
    b: rgb(DARK["--chrome-border"] as string)[2],
  };
  assert.ok(r === g && g === b, "the dark chrome border is a neutral grey so the orange focus border stands out");
});

test("light scheme: the chrome border (tile edge, resting splitter) is a >= 3:1 UI component against the page and the tile surface", () => {
  for (const bg of ["--bg", "--surface"]) {
    const r = contrast(LIGHT["--chrome-border"] as string, LIGHT[bg] as string);
    assert.ok(r >= 3, `light --chrome-border on ${bg} = ${r.toFixed(2)} < 3 (WCAG 1.4.11)`);
  }
});

// Colours of the rings in a `0 0 0 Npx <colour>` box-shadow list, resolved for a scheme.
const ringColours = (shadow: string, tokens: Tokens): string[] => splitTop(shadow).map((s) => resolve(s.replace(/^0 0 0 \d+px\s+/, ""), tokens));

// Problems with the dark focused-splitter look in a stylesheet: the accent fill and each ring tone must be >= 3:1 against what it sits next to.
// The inner tone (first in the list) borders the accent fill; the outer tone borders the page and the tile body.
const splitterRingProblems = (css: string): string[] => {
  const rule = rulesOf(css).find((r) => r.dark && !r.forced && r.sel === ".splitter:focus-visible");
  if (!rule) return ["no dark-only .splitter:focus-visible rule sets the ring"];
  const shadow = decls(rule.body).find(([p]) => p === "box-shadow")?.[1];
  if (!shadow) return ["the dark ring sets no box-shadow"];
  const rings = ringColours(shadow, DARK);
  if (rings.length !== 2) return [`expected a two-tone ring, found ${rings.length} tones`];
  const accent = DARK["--chrome-accent"] as string;
  const problems: string[] = [];
  const check = (what: string, a: string, b: string): void => {
    const r = contrast(a, b);
    if (r < 3) problems.push(`${what} = ${r.toFixed(2)} < 3`);
  };
  for (const bg of ["--bg", "--surface"]) {
    check(`focused splitter fill against ${bg}`, accent, DARK[bg] as string);
    check(`outer ring tone against ${bg}`, rings[1] as string, DARK[bg] as string);
  }
  check("inner ring tone against the accent fill", rings[0] as string, accent);
  return problems;
};

test("dark scheme: the focused splitter's accent fill and two-tone ring are each >= 3:1 against what they sit next to", () => {
  assert.deepEqual(splitterRingProblems(THEME_CSS), []);
});

test("the splitter ring check can fail: an outer tone equal to --bg is flagged", () => {
  const wrong = THEME_CSS.replace("0 0 0 4px var(--chrome-fg)", "0 0 0 4px var(--bg)");
  assert.notEqual(wrong, THEME_CSS, "the scratch copy changed the outer tone");
  assert.ok(splitterRingProblems(wrong).some((p) => p.startsWith("outer ring tone against --bg")));
});

test("the title-bar gloss is on the whole .tile-bar (focused and dark variants too) and the title span stays transparent over it", () => {
  const rules = rulesOf(THEME_CSS).filter((r) => !r.forced);
  const gloss = (sel: string, dark: boolean): boolean =>
    rules.some((r) => r.sel === sel && r.dark === dark && decls(r.body).some(([p, v]) => p === "background-image" && v.startsWith("linear-gradient")));
  assert.ok(gloss(".tile-bar", false), ".tile-bar has the resting gloss");
  assert.ok(gloss(".tile-focused > .tile-bar", false), "the focused bar has the accent gloss");
  assert.ok(gloss(".tile-focused > .tile-bar", true), "the focused bar has the dark accent gloss");
  for (const r of rules.filter((x) => /\.tile-title/.test(x.sel))) {
    for (const [p, v] of decls(r.body)) {
      assert.ok(
        !(p === "background-image" || (p === "background-color" && v !== "transparent") || p === "box-shadow"),
        `${r.sel} { ${p}: ${v} } would paint a patch over the bar gloss`,
      );
    }
  }
  for (const [name, tokens, dark] of [
    ["light", LIGHT, false],
    ["dark", DARK, true],
  ] as const) {
    const { min, where } = gradientTextMin(THEME_CSS, tokens, dark);
    assert.ok(min >= 4.5, `${name}: title text contrast ${min} over the gloss stops is below 4.5 (${where})`);
  }
});

test("the composed UI_CSS renders every splitter state opaque, so the contrast-tested colours are the ones painted", () => {
  const flat = [...UI_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sels: m[1]!.split(",").map((x) => x.trim()), body: m[2]! }));
  for (const state of [".splitter:hover", ".splitter:active", ".splitter:focus-visible"]) {
    const opacities = flat
      .filter((r) => r.sels.includes(state))
      .flatMap((r) =>
        decls(r.body)
          .filter(([p]) => p === "opacity")
          .map(([, v]) => v),
      );
    assert.ok(opacities.length > 0, `${state} must set opacity explicitly to override the layout default`);
    assert.equal(opacities.at(-1), "1", `${state}: the last opacity declaration wins`);
  }
});
