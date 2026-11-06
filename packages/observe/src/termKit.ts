// Pure terminal-pane logic, shipped as source text (like paneKit.ts) and inlined into the terminal pane as global
// `TermKit`: websocket URL building, resize-frame encoding and dedupe, reconnect backoff and the stop/retry
// decision, key-bar sequences, font clamping, theme derivation. No DOM here; tested in termKit.test.ts.
// Wire protocol (daemon: pomtreed /v1/agents/:id/terminal): binary frames both ways are raw terminal bytes; client
// text frames are JSON {"type":"resize","cols","rows"}; server text frames are JSON {"type":"closed","reason"}.
// Plain JS, no backticks and no template interpolation (it is a String.raw literal).

// Route template of the terminal websocket; ":id" is the agent id. Same-origin, ws:/wss: matching the page.
export const TERMINAL_WS_PATH = "/v1/agents/:id/terminal";

export const TERM_LOGIC_JS = String.raw`
const TermKit = globalThis.TermKit || (globalThis.TermKit = (() => {
  const TERMINAL_STATES = ["exited", "reaped", "failed", "killed", "cancelled"];
  const baseState = (state) => typeof state === "string" ? state.trim().split(/\s+/)[0].toLowerCase() : "";
  const isTerminalState = (state) => TERMINAL_STATES.indexOf(baseState(state)) >= 0;

  // ws://host/v1/agents/<id>/terminal (wss: when the page is https:). loc is { protocol, host }.
  const wsUrl = (loc, path, id) => (loc.protocol === "https:" ? "wss:" : "ws:") + "//" + loc.host + path.replace(":id", encodeURIComponent(id));

  const RESIZE_DEBOUNCE_MS = 120;
  const validDim = (n) => typeof n === "number" && isFinite(n) && n >= 1 && n <= 1000 && Math.floor(n) === n;
  const resizeFrame = (cols, rows) => JSON.stringify({ type: "resize", cols, rows });
  // The control frame to send for a fitted size, or null when the size is unusable (hidden container, NaN) or
  // equal to the last size sent. Pass last = null after a (re)connect so the first frame always goes out.
  const nextResize = (last, cols, rows) => {
    if (!validDim(cols) || !validDim(rows)) return null;
    if (last && last.cols === cols && last.rows === rows) return null;
    return { size: { cols, rows }, frame: resizeFrame(cols, rows) };
  };

  // Server text frame -> { type: "closed", reason } or null (unknown / malformed frames are ignored).
  const parseServerText = (s) => {
    let o;
    try { o = JSON.parse(s); } catch (e) { return null; }
    if (!o || typeof o !== "object" || o.type !== "closed") return null;
    const reason = o.reason === "local" || o.reason === "remote" || o.reason === "error" ? o.reason : "error";
    return { type: "closed", reason };
  };

  // Reconnect schedule: 0.5s doubling to a 15s ceiling, +-25% jitter (rand in [0,1)); give up after MAX_ATTEMPTS.
  const BACKOFF_BASE_MS = 500;
  const BACKOFF_MAX_MS = 15000;
  const MAX_ATTEMPTS = 12;
  const backoffMs = (attempt, rand) => {
    const n = Math.max(0, Math.floor(attempt));
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, n));
    const r = typeof rand === "number" ? rand : 0.5;
    return Math.round(base * (0.75 + 0.5 * r));
  };

  // A connection that stayed up STABLE_MS counts as a success (the attempt counter restarts); one that dropped
  // sooner keeps counting, so a server that accepts and immediately closes backs off instead of looping hot.
  const STABLE_MS = 5000;
  const nextAttempt = (attempt, upMs) => upMs >= STABLE_MS ? 0 : attempt;

  // What the operator is told about an agent's terminal, from its state: kind is "live" (running), "starting"
  // (pending), "yielded" (waiting, no terminal, no retry), "ended" (finished states) or "unknown" (state missing or
  // not recognised; treated as retryable). frozen = the pane still shows the last screen of an earlier connection.
  // The agent record carries no wait condition (it lives on the checkpoint), so the yielded text names no condition.
  const YIELDED_LABEL = "Yielded: this agent is waiting and has no live terminal; it resumes on its wait condition";
  const FROZEN_LABEL = "frozen: agent yielded \u2014 the screen above is its last output, not live; it resumes on its wait condition";
  const describe = (state, frozen) => {
    const s = baseState(state);
    if (s === "running") return { kind: "live", label: "" };
    if (s === "pending") return { kind: "starting", label: "agent is queued \u2014 waiting to start" };
    if (s === "yielded") return { kind: "yielded", label: frozen ? FROZEN_LABEL : YIELDED_LABEL };
    if (isTerminalState(s)) return { kind: "ended", label: "No live terminal: agent " + s + (frozen ? " (the screen above is its last output)" : "") };
    return { kind: "unknown", label: "" };
  };

  // After the socket closed: stop (with a reason) or retry after delayMs. agent = { state } | { missing: true } |
  // null (state lookup failed); frozen = a screen from an earlier connection is still shown. A yielded or finished
  // agent never loops (a terminal cannot appear until it resumes; the Reconnect button retries by hand); starting,
  // running and unknown states retry up to the cap, after which the Reconnect button takes over. conn is the short
  // connection badge for a stop.
  const decide = (o) => {
    const a = o.agent;
    if (a && a.missing) return { action: "stop", conn: "no agent", label: "agent not found" };
    const d = describe(a && a.state, !!o.frozen);
    if (d.kind === "yielded") return { action: "stop", conn: o.frozen ? "frozen" : "yielded", label: d.label };
    if (d.kind === "ended") return { action: "stop", conn: o.frozen ? "frozen" : "no terminal", label: d.label };
    if (o.attempt >= MAX_ATTEMPTS) return { action: "stop", conn: "disconnected", label: "disconnected \u2014 gave up reconnecting" };
    const delayMs = backoffMs(o.attempt, o.rand);
    const queued = d.kind === "starting";
    return { action: "retry", delayMs, label: (queued ? d.label : "disconnected") + " \u2014 reconnecting (attempt " + (o.attempt + 1) + ")" };
  };

  // Key bar. Ctrl and Alt are one-shot modifiers armed from the bar and applied to the next key, whether it comes
  // from the bar or the keyboard (mods = { ctrl, alt }; any data clears both, see applyMods).
  const ARROWS = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D" };
  // Named keys and chords the browser/xterm cannot (or must not) send themselves -> exact bytes. Control codes are
  // letter & 0x1f; CSI-u is ESC [ <codepoint> ; <modifier> u with modifier 1+shift(1)+alt(2)+ctrl(4) (pi-tui parses it).
  const NAMED_KEYS = {
    "Esc": "\u001b", "Tab": "\t", "Shift+Tab": "\u001b[Z", "Enter": "\r", "Shift+Enter": "\n", "Ctrl+Enter": "\u001b[13;5u",
    "Ctrl+C": "\u0003", "Ctrl+D": "\u0004", "Ctrl+L": "\u000c", "Ctrl+O": "\u000f", "Ctrl+P": "\u0010",
    "Ctrl+Shift+P": "\u001b[112;6u", "Ctrl+T": "\u0014", "Ctrl+W": "\u0017", "Ctrl+N": "\u000e",
  };
  const namedKey = (name) => Object.prototype.hasOwnProperty.call(NAMED_KEYS, name) ? NAMED_KEYS[name] : null;
  const keyBarSeq = (key, o) => {
    const ctrl = !!(o && o.ctrl);
    const alt = !!(o && o.alt);
    const app = !!(o && o.appCursor);
    const named = namedKey(key);
    if (named !== null) return named;
    const f = ARROWS[key];
    if (!f) return null;
    if (ctrl || alt) return "\u001b[1;" + (1 + (alt ? 2 : 0) + (ctrl ? 4 : 0)) + f;
    return (app ? "\u001bO" : "\u001b[") + f;
  };
  // One typed chunk with Ctrl applied: a-z / @[\]^_ become control codes, space NUL, ? DEL; others pass through.
  const ctrlify = (data) => {
    if (typeof data !== "string" || data.length !== 1) return data;
    const c = data.charCodeAt(0);
    if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
    if (c >= 64 && c <= 95) return String.fromCharCode(c - 64);
    if (c === 32) return "\u0000";
    if (c === 63) return "\u007f";
    return data;
  };
  // One typed chunk with Alt applied: a single character becomes ESC + character; longer chunks pass through.
  const altify = (data) => typeof data === "string" && data.length === 1 ? "\u001b" + data : data;
  const NO_MODS = { ctrl: false, alt: false };
  const toggleMod = (mods, name) => ({ ctrl: name === "ctrl" ? !mods.ctrl : mods.ctrl, alt: name === "alt" ? !mods.alt : mods.alt });
  // Sticky one-shot state machine: data typed while a modifier is armed gets it (Ctrl first, then Alt, so both give
  // ESC + control code) and every armed modifier clears, even when the chunk could not take it.
  const applyMods = (mods, data) => {
    if (!mods.ctrl && !mods.alt) return { data, mods };
    let d = data;
    if (mods.ctrl) d = ctrlify(d);
    if (mods.alt) d = altify(d);
    return { data: d, mods: NO_MODS };
  };
  // A key-bar button -> { data, mods } (data null for an unknown key, mods untouched). Arrows encode the modifiers
  // themselves; other keys go through applyMods.
  const barSend = (key, mods, appCursor) => {
    const seq = keyBarSeq(key, { ctrl: mods.ctrl, alt: mods.alt, appCursor });
    if (seq === null) return { data: null, mods };
    if (ARROWS[key]) return { data: seq, mods: NO_MODS };
    return applyMods(mods, seq);
  };

  // Keyboard passthrough for xterm's custom key handler. xterm 6 has no Kitty/modifyOtherKeys, so chords it would
  // collapse (Shift+Enter, Ctrl+Enter, Ctrl+Shift+<letter>) are sent as bytes pi understands. Returns
  // { pass, send, copy, prevent }: pass true lets xterm handle the event; false means xterm must not (send is the
  // text for the socket, copy asks to copy the selection, prevent asks for preventDefault). keydown only, never
  // while composing (IME), and Alt+Enter stays xterm's ESC CR.
  const PASS = { pass: true, send: null, copy: false, prevent: false };
  const SWALLOW = { pass: false, send: null, copy: false, prevent: false };
  const letterOf = (ev) => {
    const k = String(ev.key);
    if (k.length === 1 && /[a-zA-Z]/.test(k)) return k.toLowerCase();
    const m = /^Key([A-Z])$/.exec(String(ev.code));
    return m ? m[1].toLowerCase() : "";
  };
  // Native paste: Ctrl+V, Ctrl+Shift+V, Cmd+V are not sent as bytes (no 0x16); xterm is told to skip them so the
  // browser fires its paste event and xterm's bracketed-paste path delivers the text.
  // TODO(termkeys): verify Ctrl+V native paste in real browsers (untested outside the node:vm fakes)
  const isPasteChord = (ev) => letterOf(ev) === "v" && !!(ev.ctrlKey || ev.metaKey) && !ev.altKey;
  const keyDecision = (ev, hasSelection) => {
    if (!ev || ev.type !== "keydown" || ev.isComposing || ev.keyCode === 229) return PASS;
    const letter = letterOf(ev);
    const send = (s) => ({ pass: false, send: s, copy: false, prevent: true });
    if (letter === "c" && (ev.ctrlKey || ev.metaKey) && !ev.altKey) {
      if (ev.ctrlKey && ev.shiftKey && !ev.metaKey) return { pass: false, send: null, copy: !!hasSelection, prevent: true };
      return isCopyChord(ev, hasSelection) ? { pass: false, send: null, copy: true, prevent: true } : PASS;
    }
    if (isPasteChord(ev)) return SWALLOW;
    if (ev.key === "Enter" && !ev.altKey && !ev.metaKey) {
      if (ev.shiftKey && !ev.ctrlKey) return send(NAMED_KEYS["Shift+Enter"]);
      if (ev.ctrlKey && !ev.shiftKey) return send(NAMED_KEYS["Ctrl+Enter"]);
      return PASS;
    }
    if (letter && ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey) return send("\u001b[" + letter.charCodeAt(0) + ";6u");
    return PASS;
  };

  const FONT_MIN = 8;
  const FONT_MAX = 28;
  const FONT_DEFAULT = 14;
  const clampFont = (n) => {
    const v = Math.round(Number(n));
    return isFinite(v) ? Math.min(FONT_MAX, Math.max(FONT_MIN, v)) : FONT_DEFAULT;
  };

  // Ctrl/Cmd+C or Ctrl+Shift+C with a selection copies instead of sending SIGINT; plain Ctrl+C without a
  // selection still reaches the program, and Ctrl+Shift+C without one does nothing (keyDecision swallows it).
  const isCopyChord = (ev, hasSelection) => {
    if (!ev || ev.type !== "keydown" || !(ev.ctrlKey || ev.metaKey) || ev.altKey) return false;
    if (String(ev.key).toLowerCase() !== "c") return false;
    return !!hasSelection;
  };

  // Dark ANSI palette for the black-and-orange scheme (terminal paints on dark --surface #0e0e0e). Yellow is dark --warn;
  // green, cyan are --ok, --info; red keeps its coral (the rose --err reads pink); blue stays blue, apart from the orange accent and cyan.
  const ANSI_DARK = ["#2e2e2e", "#ff7b72", "#4ade80", "#d6e84a", "#5c9cff", "#d2a8ff", "#4cc9d9", "#d4d4d4",
    "#8a8a8a", "#ffa198", "#7ee787", "#e6f27c", "#92bcff", "#e6ccff", "#7ddde8", "#ffffff"];
  const ANSI_LIGHT = ["#1c2025", "#c62828", "#17803d", "#a76100", "#2557d6", "#8250df", "#0b7a8a", "#626b78",
    "#4b5563", "#e5484d", "#2da44e", "#bf8700", "#4a78e8", "#a475f9", "#1b9aa8", "#8a94a3"];
  const hex = (v) => /^#[0-9a-f]{6}$/i.test(String(v).trim()) ? String(v).trim() : null;
  // xterm theme from the page's CSS tokens (--surface, --text, --accent; read with read("--name")) plus a fixed
  // ANSI palette per colour scheme, so the terminal follows the page's light/dark mode.
  const themeFor = (dark, read) => {
    const pick = (name, fallback) => hex(read(name)) || fallback;
    const bg = pick("--surface", dark ? "#0e0e0e" : "#ffffff");
    const fg = pick("--text", dark ? "#f2f2f2" : "#1c2025");
    const accent = pick("--accent", dark ? "#ff8c1a" : "#2557d6");
    const p = dark ? ANSI_DARK : ANSI_LIGHT;
    return {
      background: bg, foreground: fg, cursor: accent, cursorAccent: bg, selectionBackground: accent + "55",
      black: p[0], red: p[1], green: p[2], yellow: p[3], blue: p[4], magenta: p[5], cyan: p[6], white: p[7],
      brightBlack: p[8], brightRed: p[9], brightGreen: p[10], brightYellow: p[11], brightBlue: p[12], brightMagenta: p[13], brightCyan: p[14], brightWhite: p[15],
    };
  };

  return { TERMINAL_STATES, isTerminalState, wsUrl, RESIZE_DEBOUNCE_MS, resizeFrame, nextResize, parseServerText,
    BACKOFF_BASE_MS, BACKOFF_MAX_MS, MAX_ATTEMPTS, STABLE_MS, backoffMs, nextAttempt, describe, decide, keyBarSeq, NAMED_KEYS, namedKey, ctrlify, altify, toggleMod, applyMods, barSend, keyDecision, isPasteChord, FONT_MIN, FONT_MAX, FONT_DEFAULT,
    clampFont, isCopyChord, themeFor };
})());
`;

export const TERM_CSS = `
.pane .statusbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.5rem; }
.pane .termhost { box-sizing: border-box; height: min(70vh, 48rem); min-height: 12rem; padding: 0.375rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; position: relative; }
.pane .termhost .xterm { height: 100%; }
.pane .termhost .xterm-viewport { background-color: transparent !important; }
.pane .termnote { color: var(--muted); font-size: 0.875rem; min-height: 1.25rem; }
.pane .termnote.err { color: var(--err); }
.pane .termwrap { position: relative; }
.pane .termbottom { position: absolute; right: 1.25rem; bottom: 0.75rem; z-index: 5; }
.pane .keywrap { display: flex; flex-direction: column; gap: 0.375rem; align-items: flex-start; }
.pane .keybar { display: none; flex-wrap: wrap; gap: 0.375rem; }
.pane .keybar.open { display: flex; }
.pane .keybar.off button { opacity: 0.5; }
.pane .keymenu { display: flex; flex-wrap: wrap; gap: 0.375rem; padding: 0.5rem; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); }
.pane .keymenu[hidden] { display: none; }
.pane .keybar button[aria-pressed="true"] { color: var(--accent-fg); background: var(--accent); border-color: transparent; }
@media (max-width: 640px) { .pane .termhost { height: 50vh; } }
.pane .state.s-pending, .pane .state.s-unknown { color: var(--muted); }
`;
