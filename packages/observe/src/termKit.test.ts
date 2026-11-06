import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { UI_CSS } from "./shell.ts";
import { TERM_LOGIC_JS, TERMINAL_WS_PATH } from "./termKit.ts";
import { THEME_CSS } from "./themeCss.ts";

interface Mods {
  ctrl: boolean;
  alt: boolean;
}
interface Decision {
  action: "stop" | "retry";
  label: string;
  delayMs?: number;
  conn?: string;
}
const K = runInContext(
  `(() => { ${TERM_LOGIC_JS}; return TermKit; })()`,
  createContext({ globalThis: {}, encodeURIComponent, decodeURIComponent, JSON, Math, Number, String, isFinite }),
) as {
  isTerminalState(s: unknown): boolean;
  wsUrl(loc: { protocol: string; host: string }, path: string, id: string): string;
  RESIZE_DEBOUNCE_MS: number;
  resizeFrame(c: number, r: number): string;
  nextResize(last: { cols: number; rows: number } | null, c: number, r: number): { size: { cols: number; rows: number }; frame: string } | null;
  parseServerText(s: string): { type: string; reason: string } | null;
  backoffMs(attempt: number, rand?: number): number;
  MAX_ATTEMPTS: number;
  nextAttempt(attempt: number, upMs: number): number;
  decide(o: { attempt: number; agent: unknown; frozen?: boolean; rand?: number }): Decision;
  describe(state: unknown, frozen?: boolean): { kind: string; label: string };
  keyBarSeq(key: string, o?: { ctrl?: boolean; alt?: boolean; appCursor?: boolean }): string | null;
  NAMED_KEYS: Record<string, string>;
  namedKey(n: string): string | null;
  ctrlify(d: string): string;
  altify(d: string): string;
  toggleMod(m: Mods, name: string): Mods;
  applyMods(m: Mods, d: string): { data: string; mods: Mods };
  barSend(key: string, m: Mods, app?: boolean): { data: string | null; mods: Mods };
  keyDecision(ev: unknown, hasSelection: boolean): { pass: boolean; send: string | null; copy: boolean; prevent: boolean };
  isPasteChord(ev: unknown): boolean;
  clampFont(n: unknown): number;
  isCopyChord(ev: unknown, hasSelection: boolean): boolean;
  themeFor(dark: boolean, read: (n: string) => string): Record<string, string>;
};

test("the websocket path is the locked route template", () => {
  assert.equal(TERMINAL_WS_PATH, "/v1/agents/:id/terminal");
});

test("wsUrl: same-origin, ws/wss matches the page protocol, id is encoded", () => {
  assert.equal(K.wsUrl({ protocol: "http:", host: "h:8080" }, TERMINAL_WS_PATH, "a1"), "ws://h:8080/v1/agents/a1/terminal");
  assert.equal(K.wsUrl({ protocol: "https:", host: "h" }, TERMINAL_WS_PATH, "a/b c"), "wss://h/v1/agents/a%2Fb%20c/terminal");
});

test("control frames: resize encoding, dedupe, and rejection of unusable sizes", () => {
  assert.deepEqual(JSON.parse(K.resizeFrame(100, 30)), { type: "resize", cols: 100, rows: 30 });
  const first = K.nextResize(null, 100, 30)!;
  assert.deepEqual(JSON.parse(first.frame), { type: "resize", cols: 100, rows: 30 });
  assert.equal(K.nextResize(first.size, 100, 30), null);
  assert.deepEqual(JSON.parse(K.nextResize(first.size, 101, 30)!.frame), { type: "resize", cols: 101, rows: 30 });
  for (const [c, r] of [
    [0, 24],
    [80, 0],
    [NaN, 24],
    [80, Infinity],
    [80.5, 24],
    [-1, 24],
    [5000, 24],
  ] as const)
    assert.equal(K.nextResize(null, c, r), null, `${c}x${r}`);
  assert.ok(K.RESIZE_DEBOUNCE_MS > 0 && K.RESIZE_DEBOUNCE_MS < 1000);
});

test("server text frames: closed with a known reason; unknown reasons map to error; junk is ignored", () => {
  for (const reason of ["local", "remote", "error"])
    assert.deepEqual(JSON.parse(JSON.stringify(K.parseServerText(JSON.stringify({ type: "closed", reason })))), { type: "closed", reason });
  assert.equal(K.parseServerText('{"type":"closed","reason":"weird"}')!.reason, "error");
  for (const bad of ["", "nope", "null", "[]", '{"type":"other"}', "42"]) assert.equal(K.parseServerText(bad), null, bad);
});

test("backoff: doubles from 500ms to a 15s ceiling with +-25% jitter", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 20].map((n) => K.backoffMs(n, 0.5)),
    [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000],
  );
  assert.equal(K.backoffMs(0, 0), 375);
  assert.equal(K.backoffMs(0, 1), 625);
  assert.equal(K.backoffMs(-3, 0.5), 500);
});

test("decide: a finished or missing agent stops; others retry up to the cap; queued agents say so", () => {
  for (const state of ["exited", "reaped", "failed", "killed", "cancelled", "Exited"]) {
    const d = K.decide({ attempt: 0, agent: { state } });
    assert.equal(d.action, "stop", state);
    assert.match(d.label, /^No live terminal: agent \w+$/);
  }
  assert.match(K.decide({ attempt: 0, agent: { missing: true } }).label, /not found/);
  const run = K.decide({ attempt: 2, agent: { state: "running" }, rand: 0.5 });
  assert.deepEqual([run.action, run.delayMs], ["retry", 2000]);
  assert.match(run.label, /reconnecting \(attempt 3\)/);
  assert.equal(K.decide({ attempt: 0, agent: null }).action, "retry"); // lookup failed: keep trying
  assert.match(K.decide({ attempt: 0, agent: { state: "pending" } }).label, /queued/);
  const gaveUp = K.decide({ attempt: K.MAX_ATTEMPTS, agent: { state: "running" } });
  assert.equal(gaveUp.action, "stop");
  assert.match(gaveUp.label, /gave up/);
});

test("describe: state labelling for running, pending, yielded, exited, reaped and unknown", () => {
  assert.equal(K.describe("running").kind, "live");
  assert.equal(K.describe("pending").kind, "starting");
  assert.equal(K.describe("yielded").kind, "yielded");
  assert.equal(K.describe("yielded").label, "Yielded: this agent is waiting and has no live terminal; it resumes on its wait condition");
  assert.match(K.describe("yielded", true).label, /^frozen: agent yielded/);
  assert.equal(K.describe("exited").label, "No live terminal: agent exited");
  assert.equal(K.describe("reaped").label, "No live terminal: agent reaped");
  assert.equal(K.describe("failed").label, "No live terminal: agent failed");
  assert.equal(K.describe("exited", true).label, "No live terminal: agent exited (the screen above is its last output)");
  for (const u of [undefined, null, "", "mystery", 7]) assert.equal(K.describe(u).kind, "unknown", String(u));
});

test("decide: a yielded agent stops without retrying (labelled Yielded, or frozen over an old screen); running still retries", () => {
  const y = K.decide({ attempt: 0, agent: { state: "yielded" } });
  assert.deepEqual([y.action, y.conn], ["stop", "yielded"]);
  assert.match(y.label, /^Yielded: .*no live terminal/);
  assert.equal("delayMs" in y, false);
  const fz = K.decide({ attempt: 3, agent: { state: "yielded" }, frozen: true });
  assert.deepEqual([fz.action, fz.conn], ["stop", "frozen"]);
  assert.match(fz.label, /^frozen: agent yielded/);
  assert.doesNotMatch(fz.label, /disconnected/);
  const ex = K.decide({ attempt: 0, agent: { state: "reaped" } });
  assert.deepEqual([ex.action, ex.conn, ex.label], ["stop", "no terminal", "No live terminal: agent reaped"]);
  // negative controls: running and unknown/failed lookups keep retrying, frozen or not
  for (const agent of [{ state: "running" }, { state: "pending" }, null, { state: "mystery" }]) {
    assert.equal(K.decide({ attempt: 0, agent, frozen: true, rand: 0.5 }).action, "retry", JSON.stringify(agent));
  }
  assert.match(K.decide({ attempt: 0, agent: { state: "running" } }).label, /^disconnected/);
});

test("nextAttempt: a stable connection resets the counter, a flapping one keeps counting", () => {
  assert.equal(K.nextAttempt(4, 60_000), 0);
  assert.equal(K.nextAttempt(4, 100), 4);
  assert.equal(K.nextAttempt(4, 0), 4);
});

test("key bar sequences: Esc, Tab, arrows (normal/application/ctrl)", () => {
  assert.equal(K.keyBarSeq("Esc"), "\u001b");
  assert.equal(K.keyBarSeq("Tab"), "\t");
  assert.equal(K.keyBarSeq("ArrowUp"), "\u001b[A");
  assert.equal(K.keyBarSeq("ArrowLeft", { appCursor: true }), "\u001bOD");
  assert.equal(K.keyBarSeq("ArrowRight", { ctrl: true, appCursor: true }), "\u001b[1;5C");
  assert.equal(K.keyBarSeq("ArrowDown", {}), "\u001b[B");
  assert.equal(K.keyBarSeq("Nope"), null);
});

test("ctrlify: letters and punctuation become control codes, others pass through", () => {
  assert.equal(K.ctrlify("c"), "\u0003");
  assert.equal(K.ctrlify("C"), "\u0003");
  assert.equal(K.ctrlify("["), "\u001b");
  assert.equal(K.ctrlify(" "), "\u0000");
  assert.equal(K.ctrlify("?"), "\u007f");
  assert.equal(K.ctrlify("1"), "1");
  assert.equal(K.ctrlify("\u001b[A"), "\u001b[A"); // multi-char chunks (escape sequences, pastes) are untouched
});

test("clampFont: bounds, rounding, junk falls back to the default", () => {
  assert.equal(K.clampFont(2), 8);
  assert.equal(K.clampFont(99), 28);
  assert.equal(K.clampFont("16"), 16);
  assert.equal(K.clampFont(13.6), 14);
  assert.equal(K.clampFont("x"), 14);
});

test("isCopyChord: only keydown Ctrl/Cmd+C with a selection (plain Ctrl+C still reaches the program)", () => {
  const ev = (o: object) => ({ type: "keydown", key: "c", ...o });
  assert.equal(K.isCopyChord(ev({ ctrlKey: true }), true), true);
  assert.equal(K.isCopyChord(ev({ metaKey: true }), true), true);
  assert.equal(K.isCopyChord(ev({ ctrlKey: true, shiftKey: true, key: "C" }), true), true);
  assert.equal(K.isCopyChord(ev({ ctrlKey: true }), false), false);
  assert.equal(K.isCopyChord(ev({}), true), false);
  assert.equal(K.isCopyChord(ev({ ctrlKey: true, type: "keyup" }), true), false);
  assert.equal(K.isCopyChord(ev({ ctrlKey: true, key: "v" }), true), false);
});

test("themeFor follows the page tokens and falls back per scheme", () => {
  const tokens: Record<string, string> = { "--surface": "#0e0e0e", "--text": "#f2f2f2", "--accent": "#ff8c1a" };
  const t = K.themeFor(true, (n) => tokens[n] ?? "");
  assert.equal(t.background, "#0e0e0e");
  assert.equal(t.foreground, "#f2f2f2");
  assert.equal(t.cursor, "#ff8c1a");
  assert.equal(t.selectionBackground, "#ff8c1a55");
  const light = K.themeFor(false, () => "");
  assert.equal(light.background, "#ffffff");
  assert.notEqual(light.red, t.red);
  assert.equal(K.themeFor(false, () => "rgb(1,2,3)").background, "#ffffff"); // non-hex tokens are not trusted
});

test("named key table: exact bytes", () => {
  assert.deepEqual(
    { ...K.NAMED_KEYS },
    {
      Esc: "\x1b",
      Tab: "\x09",
      "Shift+Tab": "\x1b[Z",
      Enter: "\x0d",
      "Shift+Enter": "\x0a",
      "Ctrl+Enter": "\x1b[13;5u",
      "Ctrl+C": "\x03",
      "Ctrl+D": "\x04",
      "Ctrl+L": "\x0c",
      "Ctrl+O": "\x0f",
      "Ctrl+P": "\x10",
      "Ctrl+Shift+P": "\x1b[112;6u",
      "Ctrl+T": "\x14",
      "Ctrl+W": "\x17",
      "Ctrl+N": "\x0e",
    },
  );
  for (const [name, bytes] of Object.entries(K.NAMED_KEYS)) {
    const m = /^Ctrl\+([A-Z])$/.exec(name);
    if (m) assert.equal(bytes.charCodeAt(0), m[1]!.charCodeAt(0) & 0x1f, name);
    assert.equal(K.keyBarSeq(name), bytes);
  }
  assert.equal(K.namedKey("toString"), null);
  assert.equal(K.namedKey("Ctrl+Q"), null);
});

test("sticky modifiers: one-shot Ctrl/Alt, both combine, any data clears, multi-char chunks pass through", () => {
  const none = { ctrl: false, alt: false };
  assert.deepEqual({ ...K.toggleMod(none, "alt") }, { ctrl: false, alt: true });
  assert.deepEqual({ ...K.toggleMod(K.toggleMod(none, "ctrl"), "ctrl") }, none);
  const idle = K.applyMods(none, "a");
  assert.equal(idle.data, "a");
  assert.equal(idle.mods, none);
  const alt = K.applyMods({ ctrl: false, alt: true }, "b");
  assert.equal(alt.data, "\x1bb");
  assert.deepEqual({ ...alt.mods }, none);
  assert.equal(K.applyMods({ ctrl: true, alt: true }, "c").data, "\x1b\x03");
  const multi = K.applyMods({ ctrl: false, alt: true }, "\x1b[A");
  assert.equal(multi.data, "\x1b[A");
  assert.deepEqual({ ...multi.mods }, none);
  assert.equal(K.altify("ab"), "ab");
});

test("barSend: arrows encode armed modifiers, other keys go through applyMods, unknown keys keep the state", () => {
  const none = { ctrl: false, alt: false };
  assert.equal(K.barSend("ArrowUp", { ctrl: false, alt: true }).data, "\x1b[1;3A");
  assert.equal(K.barSend("ArrowUp", { ctrl: true, alt: true }).data, "\x1b[1;7A");
  assert.equal(K.barSend("ArrowUp", { ctrl: true, alt: false }).data, "\x1b[1;5A");
  assert.deepEqual({ ...K.barSend("ArrowUp", { ctrl: true, alt: false }).mods }, none);
  assert.equal(K.barSend("Tab", { ctrl: false, alt: true }).data, "\x1b\t");
  const armed = { ctrl: true, alt: false };
  const bad = K.barSend("Nope", armed);
  assert.equal(bad.data, null);
  assert.equal(bad.mods, armed);
});

const kd = (o: object) => ({ type: "keydown", ...o });
const PASS = { pass: true, send: null, copy: false, prevent: false };

test("keyDecision: Shift+Enter is LF, Ctrl+Enter is CSI-u, Alt/plain/other combos stay with xterm", () => {
  assert.deepEqual({ ...K.keyDecision(kd({ key: "Enter", shiftKey: true }), false) }, { pass: false, send: "\n", copy: false, prevent: true });
  assert.deepEqual({ ...K.keyDecision(kd({ key: "Enter", ctrlKey: true }), false) }, { pass: false, send: "\x1b[13;5u", copy: false, prevent: true });
  for (const o of [
    {},
    { altKey: true },
    { metaKey: true },
    { shiftKey: true, altKey: true },
    { ctrlKey: true, shiftKey: true },
    { ctrlKey: true, altKey: true },
  ]) {
    assert.deepEqual({ ...K.keyDecision(kd({ key: "Enter", ...o }), false) }, PASS, JSON.stringify(o));
  }
});

test("keyDecision: Ctrl+Shift+<letter> maps to CSI-u modifier 6, with exclusions", () => {
  for (const l of "abdeghijklmnopqrstuwxyz") {
    assert.equal(K.keyDecision(kd({ key: l.toUpperCase(), ctrlKey: true, shiftKey: true }), false).send, "\x1b[" + l.charCodeAt(0) + ";6u", l);
  }
  assert.equal(K.keyDecision(kd({ key: "p", ctrlKey: true, shiftKey: true }), false).send, K.NAMED_KEYS["Ctrl+Shift+P"]);
  assert.equal(K.keyDecision(kd({ key: "Dead", code: "KeyF", ctrlKey: true, shiftKey: true }), false).send, "\x1b[102;6u"); // code fallback
  for (const o of [{ altKey: true }, { metaKey: true }])
    assert.deepEqual({ ...K.keyDecision(kd({ key: "P", ctrlKey: true, shiftKey: true, ...o }), false) }, PASS);
  assert.deepEqual({ ...K.keyDecision(kd({ key: "P", ctrlKey: true }), false) }, PASS); // plain Ctrl+letter is xterm's
  assert.deepEqual({ ...K.keyDecision(kd({ key: "P", shiftKey: true }), false) }, PASS);
  assert.deepEqual({ ...K.keyDecision(kd({ key: "1", ctrlKey: true, shiftKey: true }), false) }, PASS);
  assert.deepEqual({ ...K.keyDecision(kd({ key: "ArrowUp", ctrlKey: true, shiftKey: true }), false) }, PASS);
});

test("keyDecision: composing, keyup and keypress are ignored", () => {
  for (const o of [{ isComposing: true }, { keyCode: 229 }, { type: "keyup" }, { type: "keypress" }]) {
    assert.deepEqual({ ...K.keyDecision(kd({ key: "Enter", shiftKey: true, ...o }), true) }, PASS, JSON.stringify(o));
    assert.deepEqual({ ...K.keyDecision(kd({ key: "C", ctrlKey: true, shiftKey: true, ...o }), true) }, PASS, JSON.stringify(o));
  }
  assert.deepEqual({ ...K.keyDecision(null, false) }, PASS);
});

test("keyDecision: copy chords copy with a selection; Ctrl+Shift+C without one is swallowed, plain Ctrl+C reaches pi", () => {
  const copy = { pass: false, send: null, copy: true, prevent: true };
  assert.deepEqual({ ...K.keyDecision(kd({ key: "C", ctrlKey: true, shiftKey: true }), true) }, copy);
  assert.deepEqual({ ...K.keyDecision(kd({ key: "c", metaKey: true }), true) }, copy);
  assert.deepEqual({ ...K.keyDecision(kd({ key: "c", ctrlKey: true }), true) }, copy);
  assert.deepEqual({ ...K.keyDecision(kd({ key: "C", ctrlKey: true, shiftKey: true }), false) }, { pass: false, send: null, copy: false, prevent: true });
  assert.deepEqual({ ...K.keyDecision(kd({ key: "c", ctrlKey: true }), false) }, PASS);
  assert.deepEqual({ ...K.keyDecision(kd({ key: "c", metaKey: true }), false) }, PASS);
});

test("keyDecision: Ctrl+V, Ctrl+Shift+V and Cmd+V defer to the native paste event (no bytes, no preventDefault)", () => {
  const native = { pass: false, send: null, copy: false, prevent: false };
  for (const o of [{ ctrlKey: true }, { ctrlKey: true, shiftKey: true }, { metaKey: true }]) {
    assert.deepEqual({ ...K.keyDecision(kd({ key: "v", ...o }), false) }, native, JSON.stringify(o));
    assert.equal(K.isPasteChord(kd({ key: "V", ...o })), true);
  }
  assert.equal(K.isPasteChord(kd({ key: "v" })), false);
  assert.equal(K.isPasteChord(kd({ key: "v", ctrlKey: true, altKey: true })), false);
});

test("terminal states match the daemon's finished states", () => {
  assert.equal(K.isTerminalState("running"), false);
  assert.equal(K.isTerminalState("pending"), false);
  assert.equal(K.isTerminalState("exited"), true);
  assert.equal(K.isTerminalState(undefined), false);
});

// The dark ANSI palette, read through themeFor like the page does. The terminal paints on --surface (termhost).
const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const ANSI_KEYS = [...ANSI_NAMES, ...ANSI_NAMES.map((n) => `bright${n[0]?.toUpperCase()}${n.slice(1)}`)];
const darkTheme = (K as unknown as { themeFor(dark: boolean, read: (n: string) => string): Record<string, string> }).themeFor(true, () => "");
const ansiDark = ANSI_KEYS.map((k) => darkTheme[k] as string);
// Dark token values: the dark :root block of the shipped stylesheets (THEME_CSS overrides UI_CSS).
const darkToken = (name: string): string => {
  let found = "";
  for (const css of [UI_CSS, THEME_CSS]) {
    const i = css.indexOf("@media (prefers-color-scheme: dark) {");
    const block = css.slice(css.indexOf("{", css.indexOf(":root", i)) + 1, css.indexOf("}", css.indexOf(":root", i)));
    found = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(block)?.[1] ?? found;
  }
  assert.ok(found, `${name} has a dark value`);
  return found;
};
const rgbOf = (h: string): number[] => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
const lum = (h: string): number => {
  const [r, g, b] = rgbOf(h).map((v) => {
    const c = (v as number) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const wcag = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

test("dark ANSI palette is readable on the dark --surface: 1-15 >= 4.5:1, black >= 1.3:1", () => {
  const bg = darkToken("--surface");
  assert.equal(darkTheme.background, bg, "themeFor's dark fallback background is the real dark --surface");
  ansiDark.forEach((c, i) => {
    // Index 0 is a fill colour (dark-on-dark by design), so it only has to stay visible against the surface.
    const min = i === 0 ? 1.3 : 4.5;
    assert.ok(wcag(c, bg) >= min, `ANSI ${i} ${c} on ${bg} is ${wcag(c, bg).toFixed(2)}:1, needs >= ${min}`);
  });
});

test("dark ANSI yellow follows the dark --warn token; bright yellow is a lighter tint of it", () => {
  const warn = darkToken("--warn");
  assert.equal(ansiDark[3], warn);
  assert.ok(lum(ansiDark[11] as string) > lum(warn));
});

test("dark ANSI blue is blue and red is red (hue semantics survive the retheme)", () => {
  const [r, g, b] = rgbOf(ansiDark[4] as string) as [number, number, number];
  assert.ok(b > r && b > g, "blue channel dominates");
  const [r1, g1, b1] = rgbOf(ansiDark[1] as string) as [number, number, number];
  assert.ok(r1 > g1 && r1 > b1, "red channel dominates");
});

test("the 16 dark ANSI colours are pairwise distinct (RGB distance >= 40 of 441)", () => {
  for (let i = 0; i < 16; i++)
    for (let j = i + 1; j < 16; j++) {
      const a = rgbOf(ansiDark[i] as string);
      const b = rgbOf(ansiDark[j] as string);
      const d = Math.hypot(...a.map((v, k) => v - (b[k] as number)));
      assert.ok(d >= 40, `ANSI ${i} ${ansiDark[i]} and ${j} ${ansiDark[j]} are ${d.toFixed(1)} apart`);
    }
});
