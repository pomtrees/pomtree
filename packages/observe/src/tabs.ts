// Three operator-facing tab panes, rendered as fully-inline fragments in the same
// style as web.ts's tree/reports panes: no build step, no framework, no external
// resources. Every value that reaches the DOM goes through textContent after
// JSON.parse or is read from a form input — agent data is never interpolated into
// HTML — and any path/label embedded in an inline <script> goes through scriptJson.
// The daemon endpoints these scripts call are wired elsewhere; this module only
// renders against their contract.

import { TERM_LOGIC_JS, TERMINAL_WS_PATH } from "./termKit.ts";
import { TRACE_LOGIC_JS } from "./traceKit.ts";
import { PANE_KIT_JS } from "./paneKit.ts";
import { scriptJson } from "./web.ts";

// A filterable journal view. GET <journalPath>?from&limit&agent&kind returns an array
// of { seq, ts, agent, kind, summary } rows; `seq` is the paging cursor for "more",
// and only ts/agent/kind/summary are painted. Reloads each time the tab is activated.
export function renderAuditPane(ctx: { journalPath?: string } = {}): string {
  const journal = scriptJson(ctx.journalPath ?? "/v1/journal");
  return `<div class="audit pane">
<div class="filters">
  <input id="agent-filter" placeholder="agent">
  <input id="kind-filter" placeholder="kind">
  <button id="more">more</button>
</div>
<div class="tablewrap"><table>
<thead><tr><th>TS</th><th>AGENT</th><th>KIND</th><th>SUMMARY</th></tr></thead>
<tbody id="audit-rows"></tbody>
</table></div>
</div>
<script>
(() => {
${PANE_KIT_JS}
const tbody = document.getElementById("audit-rows");
const agentInput = document.getElementById("agent-filter");
const kindInput = document.getElementById("kind-filter");
const more = document.getElementById("more");
const LIMIT = 100;
let from = 0;
let shown = 0;
const load = (reset) => {
  if (reset) { tbody.replaceChildren(); from = 0; shown = 0; }
  const qs = new URLSearchParams({ from: String(from), limit: String(LIMIT) });
  const agent = agentInput.value.trim();
  const kind = kindInput.value.trim();
  if (agent) qs.set("agent", agent);
  if (kind) qs.set("kind", kind);
  K.getJson(${journal} + "?" + qs.toString()).then((rows) => {
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.appendChild(K.cell("td", new Date(r.ts).toISOString()));
      tr.appendChild(K.cell("td", r.agent));
      tr.appendChild(K.cell("td", r.kind));
      tr.appendChild(K.cell("td", r.summary));
      tbody.appendChild(tr);
      shown += 1;
      if (typeof r.seq === "number") from = r.seq + 1;
    }
    if (shown === 0) tbody.replaceChildren(K.messageRow(4, "empty", "No journal entries yet."));
  }).catch((err) => tbody.replaceChildren(K.messageRow(4, "error", K.errorMessage("journal", err))));
};
agentInput.addEventListener("change", () => load(true));
kindInput.addEventListener("change", () => load(true));
more.addEventListener("click", () => load(false));
K.onActivate("audit", () => load(true));
})();
</script>`;
}

// The agent's interactive terminal, deep-linked at #/terminal/<id>: an xterm.js Terminal attached to the agent's
// pi through the pomtreed websocket (termKit.ts documents the wire protocol: binary frames are raw terminal bytes,
// client text frames resize, server text frames report close). The libraries are vendored under /ui/vendor/ and
// loaded lazily on first activation (xterm.js, addon-fit.js, addon-webgl.js; the WebGL renderer falls back to the
// DOM renderer on load failure or context loss). The pane tears everything down on deactivation and rebuilds on
// activation; the daemon replays recent output on connect, so each (re)connect starts from a reset screen.
// Lifecycle: connecting / connected / disconnected-reconnecting with backoff; a finished or unknown agent shows
// "No live terminal: agent <state>" and stops; a yielded agent is labelled "Yielded" (or "frozen" over a screen it
// left behind) and stops too (the Reconnect button retries by hand); only starting/running/unknown states retry. The header shows the agent's state
// (GET <base>/<id>, polled while active) and the session-trace buttons (traceKit.ts). All decisions (URL, resize
// dedupe, backoff, key sequences, themes) live in termKit.ts; this function is the thin DOM/WebSocket glue.
// TODO(term-mobile): the key bar is a minimal aid (Esc, Tab, Enter, Ctrl, Alt, arrows, Paste); no soft-keyboard viewport
// resize handling, long-press selection, or IME composition tuning yet. Current behavior: usable with the OS keyboard.
export function renderTerminalPane(ctx: { agentsBase?: string; terminalPath?: string; vendorPath?: string } = {}): string {
  const base = scriptJson(ctx.agentsBase ?? "/v1/agents");
  const wsPath = scriptJson(ctx.terminalPath ?? TERMINAL_WS_PATH);
  const vendor = scriptJson(ctx.vendorPath ?? "/ui/vendor");
  return `<div class="term pane">
<div class="statusbar"><strong id="term-title"></strong><span id="term-state" class="state"></span><span id="term-conn" class="conn"></span> <button type="button" id="term-reconnect" hidden>Reconnect</button> <span class="fontgrp"><button type="button" id="term-font-dec" aria-label="Smaller font" title="Smaller font">A−</button><button type="button" id="term-font-inc" aria-label="Larger font" title="Larger font">A+</button></span> <span class="tracegrp"><button type="button" id="term-trace" title="Copy a complete session trace (Markdown, secrets redacted) to paste into a chat">Copy trace</button><button type="button" id="term-trace-view" title="View the session trace in a window">View trace</button><button type="button" id="term-trace-short" title="Copy header + last 40 events + errors only">Short</button><button type="button" id="term-trace-opt" aria-expanded="false" aria-label="Trace options" title="Trace options">▾</button><span id="term-trace-chip" class="tracechip" role="status"></span></span></div>
<div id="term-trace-menu" class="tracemenu" hidden><label><input type="checkbox" id="term-trace-children"> include children (condensed)</label><label><input type="checkbox" id="term-trace-raw"> include raw tool output (no redaction)</label><span class="warn">Raw skips the secret-redaction pass: tokens or keys an agent printed will be in the text. Do not paste it anywhere public.</span><span><button type="button" id="term-trace-dl">Download .md</button></span></div>
<div id="term-trace-confirm" class="tracemenu" role="alertdialog" aria-label="Confirm raw trace" hidden><span class="warn">Raw trace skips secret redaction. Tokens or keys that an agent printed will be included. Continue?</span><span><button type="button" id="term-trace-confirm-ok">Include raw output</button> <button type="button" id="term-trace-confirm-cancel">Cancel</button></span></div>
<div id="term-note" class="termnote" role="status" aria-live="polite"></div>
<div class="termwrap"><div id="term-host" class="termhost"></div><button type="button" id="term-bottom" class="termbottom" hidden>↓ bottom</button></div>
<div class="keywrap" id="term-keywrap"><button type="button" id="term-keys-toggle" aria-expanded="false" aria-controls="term-keys">Keys</button>
<div id="term-keys" class="keybar" role="toolbar" aria-label="Terminal keys"><button type="button" data-key="Esc">Esc</button><button type="button" data-key="Tab">Tab</button><button type="button" data-key="Shift+Tab">Shift+Tab</button><button type="button" data-key="Enter">Enter</button><button type="button" data-key="Shift+Enter">Shift+Enter</button><button type="button" id="term-alt" data-key="Alt" aria-pressed="false">Alt</button><button type="button" id="term-ctrl" data-key="Ctrl" aria-pressed="false">Ctrl</button><button type="button" data-key="ArrowLeft" aria-label="Left">←</button><button type="button" data-key="ArrowDown" aria-label="Down">↓</button><button type="button" data-key="ArrowUp" aria-label="Up">↑</button><button type="button" data-key="ArrowRight" aria-label="Right">→</button><button type="button" data-key="Paste">Paste</button><button type="button" data-key="SendKey" aria-expanded="false">Send key…</button></div>
<div id="term-keymenu" class="keymenu" role="menu" aria-label="Send key" hidden><button type="button" role="menuitem" data-sendkey="Esc">Esc</button><button type="button" role="menuitem" data-sendkey="Ctrl+C">Ctrl+C</button><button type="button" role="menuitem" data-sendkey="Ctrl+D">Ctrl+D</button><button type="button" role="menuitem" data-sendkey="Ctrl+L">Ctrl+L</button><button type="button" role="menuitem" data-sendkey="Ctrl+O">Ctrl+O</button><button type="button" role="menuitem" data-sendkey="Ctrl+P">Ctrl+P</button><button type="button" role="menuitem" data-sendkey="Ctrl+Shift+P">Ctrl+Shift+P</button><button type="button" role="menuitem" data-sendkey="Ctrl+T">Ctrl+T</button><button type="button" role="menuitem" data-sendkey="Ctrl+W">Ctrl+W</button><button type="button" role="menuitem" data-sendkey="Ctrl+N">Ctrl+N</button></div></div>
</div>
<script>
(() => {
${PANE_KIT_JS}
${TERM_LOGIC_JS}
${TRACE_LOGIC_JS}
const base = ${base};
const wsPath = ${wsPath};
const vendor = ${vendor};
const $ = (id) => document.getElementById(id);
const host = $("term-host");
const titleEl = $("term-title");
const stateEl = $("term-state");
const connEl = $("term-conn");
const noteEl = $("term-note");
const reconnectBtn = $("term-reconnect");
const bottomBtn = $("term-bottom");
const keysEl = $("term-keys");
const ctrlBtn = $("term-ctrl");
const altBtn = $("term-alt");
const keysToggle = $("term-keys-toggle");
const keyMenu = $("term-keymenu");
const PREF_FONT = "pomtree.termFontSize";
const PREF_KEYS = "pomtree.termKeysOpen";
const readKeysOpen = () => {
  try { const raw = globalThis.localStorage.getItem(PREF_KEYS); if (raw === "1" || raw === "0") return raw === "1"; } catch (e) {}
  try { return !!(matchMedia && matchMedia("(pointer: coarse)").matches); } catch (e) { return false; }
};
const readFont = () => {
  try { const raw = globalThis.localStorage.getItem(PREF_FONT); return raw === null ? TermKit.FONT_DEFAULT : TermKit.clampFont(raw); } catch (e) { return TermKit.FONT_DEFAULT; }
};
const enc = new TextEncoder();
let agentId = "";
let active = false;
let gen = 0;
let term = null, fit = null, webgl = null, ro = null, mq = null, mqFn = null;
let ws = null, openedAt = 0, shown = false;
let attempt = 0, retryTimer = null, tickTimer = null;
let closedReason = "";
let lastSize = null;
let fitTimer = null;
let mods = { ctrl: false, alt: false };
let keysOpen = readKeysOpen();
let fontSize = readFont();
let loading = null;
let poller = null;

const cssVar = (name) => { try { return String(getComputedStyle(document.documentElement).getPropertyValue(name) || "").trim(); } catch (e) { return ""; } };
const isDark = () => { try { return !!(matchMedia && matchMedia("(prefers-color-scheme: dark)").matches); } catch (e) { return false; } };
const theme = () => TermKit.themeFor(isDark(), cssVar);
const setConn = (label, cls) => { connEl.textContent = label; connEl.className = label ? "conn " + cls : "conn"; paintKeys(); };
const note = (text, bad) => { noteEl.textContent = text; noteEl.className = bad ? "termnote err" : "termnote"; };
const paintAgent = (s) => {
  stateEl.textContent = s;
  stateEl.className = s ? "state s-" + String(s).split(" ")[0].replace(/[^a-z_-]/gi, "") : "state";
};

const loadScript = (src) => new Promise((resolve, reject) => {
  const s = document.createElement("script");
  s.src = src;
  s.onload = resolve;
  s.onerror = () => reject(new Error("could not load " + src));
  document.head.appendChild(s);
});
const libs = () => {
  if (globalThis.Terminal && globalThis.FitAddon) return Promise.resolve();
  if (!loading) {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = vendor + "/xterm.css";
    document.head.appendChild(css);
    loading = loadScript(vendor + "/xterm.js").then(() => loadScript(vendor + "/addon-fit.js"))
      .then(() => loadScript(vendor + "/addon-webgl.js").catch(() => {}))
      .catch((e) => { loading = null; throw e; });
  }
  return loading;
};

const sendBytes = (b) => { if (ws && ws.readyState === 1) ws.send(b); };
const send = (s) => sendBytes(enc.encode(s));
const sendResize = () => {
  if (!term || !ws || ws.readyState !== 1) return;
  const r = TermKit.nextResize(lastSize, term.cols, term.rows);
  if (!r) return;
  lastSize = r.size;
  ws.send(r.frame);
};
const doFit = () => {
  fitTimer = null;
  if (!term || !fit) return;
  try { fit.fit(); } catch (e) { return; }
  sendResize();
};
const scheduleFit = () => {
  if (fitTimer !== null) clearTimeout(fitTimer);
  fitTimer = setTimeout(doFit, TermKit.RESIZE_DEBOUNCE_MS);
};

const setMods = (m) => {
  mods = m;
  ctrlBtn.setAttribute("aria-pressed", m.ctrl ? "true" : "false");
  altBtn.setAttribute("aria-pressed", m.alt ? "true" : "false");
};
// The bar acts only while the socket is open; otherwise it is dimmed and its buttons are no-ops.
const online = () => !!(ws && ws.readyState === 1);
const paintKeys = () => {
  keysEl.className = "keybar" + (keysOpen ? " open" : "") + (online() ? "" : " off");
  keysEl.setAttribute("aria-disabled", online() ? "false" : "true");
  keysToggle.setAttribute("aria-expanded", keysOpen ? "true" : "false");
  if (!keysOpen) closeKeyMenu();
};
const closeKeyMenu = () => { keyMenu.hidden = true; };
const paintBottom = () => {
  if (!term) return;
  const b = term.buffer.active;
  bottomBtn.hidden = !(b.viewportY < b.baseY);
};
const copySelection = () => {
  const text = term.getSelection();
  try { navigator.clipboard.writeText(text).catch((e) => note("Copy failed: " + String(e && e.message ? e.message : e), true)); }
  catch (e) { note("Copy failed: " + String(e && e.message ? e.message : e), true); }
};

const mount = () => {
  const mono = cssVar("--mono") || "monospace";
  term = new globalThis.Terminal({ cursorBlink: true, scrollback: 5000, fontSize, fontFamily: mono, theme: theme(), macOptionIsMeta: true });
  fit = new globalThis.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  if (globalThis.WebglAddon) {
    try {
      const w = new globalThis.WebglAddon.WebglAddon();
      w.onContextLoss(() => { try { w.dispose(); } catch (e) {} if (webgl === w) webgl = null; });
      term.loadAddon(w);
      webgl = w;
    } catch (e) { webgl = null; }
  }
  // TODO(termkeys): optional Keyboard Lock (navigator.keyboard.lock, Chromium + https + fullscreen only) to capture Ctrl+W/T/N and Esc; documented limits: browser-reserved Ctrl+W/T/N/Tab, Esc exits fullscreen, Cmd+arrows/Cmd+W unreachable
  term.attachCustomKeyEventHandler((ev) => {
    const d = TermKit.keyDecision(ev, term.hasSelection());
    if (d.copy) copySelection();
    if (d.send) send(d.send);
    if (d.prevent && ev.preventDefault) ev.preventDefault();
    return d.pass;
  });
  term.onData((d) => { const r = TermKit.applyMods(mods, d); if (r.mods !== mods) setMods(r.mods); send(r.data); });
  term.onBinary((d) => sendBytes(Uint8Array.from(d, (c) => c.charCodeAt(0))));
  term.onScroll(paintBottom);
  if (term.onWriteParsed) term.onWriteParsed(paintBottom);
  if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(scheduleFit); ro.observe(host); }
  addEventListener("resize", scheduleFit);
  try {
    mq = matchMedia("(prefers-color-scheme: dark)");
    mqFn = () => { if (term) term.options.theme = theme(); };
    mq.addEventListener("change", mqFn);
  } catch (e) { mq = null; }
  doFit();
};

const clearRetry = () => {
  if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
  if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null; }
};
// Agent record -> { state } | { missing } | null (lookup failed; treated as unknown, so it retries).
const lookup = (id) => K.getJson(base + "/" + encodeURIComponent(id)).then((a) => {
  if (a && a.state) paintAgent(a.state);
  return { state: a && a.state };
}).catch((err) => (err && err.status === 404) ? { missing: true } : null);

const afterClose = () => {
  if (!active) return;
  setConn("disconnected", "stale");
  reconnectBtn.hidden = false;
  attempt = TermKit.nextAttempt(attempt, openedAt ? Date.now() - openedAt : 0);
  const g = gen;
  lookup(agentId).then((agent) => {
    if (g !== gen || !active || ws) return;
    const d = TermKit.decide({ attempt, agent, frozen: shown, rand: Math.random() });
    if (d.action === "stop") { setConn(d.conn, "stale"); note(d.label + (closedReason ? " [session closed: " + closedReason + "]" : ""), false); return; }
    attempt++;
    const at = Date.now() + d.delayMs;
    const say = () => note(d.label + " in " + Math.max(0, Math.ceil((at - Date.now()) / 1000)) + "s", false);
    say();
    tickTimer = setInterval(say, 1000);
    retryTimer = setTimeout(connect, d.delayMs);
  });
};
const connect = () => {
  clearRetry();
  if (!active || !agentId || !term) return;
  closedReason = "";
  openedAt = 0;
  const sock = new WebSocket(TermKit.wsUrl(location, wsPath, agentId));
  sock.binaryType = "arraybuffer";
  ws = sock;
  setConn("connecting", "stale");
  note("");
  sock.onopen = () => {
    if (ws !== sock) return;
    openedAt = Date.now();
    shown = true;
    lastSize = null;
    term.reset();
    setConn("connected", "ok");
    reconnectBtn.hidden = true;
    note("");
    doFit();
    term.focus();
  };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    if (typeof ev.data === "string") { const m = TermKit.parseServerText(ev.data); if (m) closedReason = m.reason; return; }
    term.write(new Uint8Array(ev.data));
  };
  sock.onerror = () => {};
  sock.onclose = () => { if (ws !== sock) return; ws = null; afterClose(); };
};

const teardown = () => {
  T.dismissLive();
  gen++;
  clearRetry();
  if (fitTimer !== null) { clearTimeout(fitTimer); fitTimer = null; }
  if (poller) poller.stop();
  if (ws) { const s = ws; ws = null; try { s.close(); } catch (e) {} }
  removeEventListener("resize", scheduleFit);
  if (ro) { ro.disconnect(); ro = null; }
  if (mq && mqFn) { try { mq.removeEventListener("change", mqFn); } catch (e) {} }
  mq = null; mqFn = null;
  if (webgl) { try { webgl.dispose(); } catch (e) {} webgl = null; }
  if (term) { try { term.dispose(); } catch (e) {} term = null; }
  fit = null;
  setMods({ ctrl: false, alt: false });
  bottomBtn.hidden = true;
  reconnectBtn.hidden = true;
  openedAt = 0; shown = false; attempt = 0; lastSize = null;
};
const open = () => {
  teardown();
  const g = gen;
  agentId = TermKit.routeId(location.hash);
  titleEl.textContent = agentId;
  paintAgent("");
  setConn("", "");
  if (!agentId) { note("no agent selected — open #/terminal/<id> or pick an agent in the Tree"); return; }
  note("loading terminal…");
  libs().then(() => {
    if (g !== gen || !active) return;
    note("");
    mount();
    connect();
    if (!poller) poller = K.poll(() => { if (agentId) lookup(agentId); }, 5000);
    poller.start();
  }).catch((err) => { if (g === gen) note("Failed to load the terminal: " + String(err && err.message ? err.message : err), true); });
};

reconnectBtn.addEventListener("click", () => {
  if (!active || !term || ws) return;
  clearRetry();
  attempt = 0;
  connect();
});
bottomBtn.addEventListener("click", () => { if (term) { term.scrollToBottom(); term.focus(); } });
const setFont = (n) => {
  fontSize = TermKit.clampFont(n);
  try { globalThis.localStorage.setItem(PREF_FONT, String(fontSize)); } catch (e) {}
  if (term) { term.options.fontSize = fontSize; scheduleFit(); term.focus(); }
};
$("term-font-dec").addEventListener("click", () => setFont(fontSize - 1));
$("term-font-inc").addEventListener("click", () => setFont(fontSize + 1));
// Key bar: buttons never take focus (keeps the on-screen keyboard up); Ctrl and Alt arm one-shot modifiers. The
// "Keys" toggle shows or hides the bar (collapsed on desktop, open on touch unless a stored pref says otherwise).
// Every action refocuses the terminal and is a no-op while the socket is down.
const noFocus = (ev) => { if (ev.preventDefault) ev.preventDefault(); };
$("term-keywrap").addEventListener("mousedown", noFocus);
keysToggle.addEventListener("click", () => {
  keysOpen = !keysOpen;
  try { globalThis.localStorage.setItem(PREF_KEYS, keysOpen ? "1" : "0"); } catch (e) {}
  paintKeys();
  if (term) term.focus();
});
keyMenu.addEventListener("click", (ev) => {
  const name = ev.target && ev.target.getAttribute ? ev.target.getAttribute("data-sendkey") : null;
  const seq = name ? TermKit.namedKey(name) : null;
  if (seq === null || !term) return;
  closeKeyMenu();
  if (online()) send(seq);
  term.focus();
});
keysEl.addEventListener("click", (ev) => {
  const key = ev.target && ev.target.getAttribute ? ev.target.getAttribute("data-key") : null;
  if (!key || !term || !online()) return;
  if (key === "SendKey") { keyMenu.hidden = !keyMenu.hidden; return; }
  closeKeyMenu();
  if (key === "Ctrl" || key === "Alt") { setMods(TermKit.toggleMod(mods, key.toLowerCase())); return; }
  if (key === "Paste") {
    try { navigator.clipboard.readText().then((t) => term.paste(t), (e) => note("Paste failed: " + String(e && e.message ? e.message : e), true)); }
    catch (e) { note("Paste failed: " + String(e && e.message ? e.message : e), true); }
    term.focus();
    return;
  }
  const r = TermKit.barSend(key, mods, !!(term.modes && term.modes.applicationCursorKeysMode));
  setMods(r.mods);
  if (r.data !== null) send(r.data);
  term.focus();
});
// Armed modifiers do not survive the terminal losing focus.
host.addEventListener("focusout", () => { if (mods.ctrl || mods.alt) setMods({ ctrl: false, alt: false }); });
paintKeys();

const traceChip = $("term-trace-chip");
const traceMenu = $("term-trace-menu");
const traceOpt = $("term-trace-opt");
const traceKids = $("term-trace-children");
const traceRaw = $("term-trace-raw");
const traceDeps = () => ({ fetch: (u) => fetch(u), clipboard: navigator.clipboard, doc: document, Blob, URL });
const traceOpts = (short) => ({ short, children: !!traceKids.checked, raw: !!traceRaw.checked });
const traceSay = (text, bad) => { traceChip.textContent = text; traceChip.className = bad ? "tracechip err" : "tracechip"; };
const runTrace = (short) => {
  if (!agentId) return;
  traceSay("Collecting trace…", false);
  T.copyTrace(traceDeps(), base, agentId, traceOpts(short)).then((r) => {
    if (r.ok) { traceSay(r.chip, false); return; }
    traceSay(r.error, true);
    if (typeof r.text === "string") T.modal(document, r.text, r.error);
  });
};
$("term-trace").addEventListener("click", () => runTrace(false));
$("term-trace-short").addEventListener("click", () => runTrace(true));
$("term-trace-view").addEventListener("click", () => { if (agentId) T.viewer(traceDeps(), base, agentId, traceOpts(false), $("term-trace-view")); });
traceOpt.addEventListener("click", () => { traceMenu.hidden = !traceMenu.hidden; traceOpt.setAttribute("aria-expanded", traceMenu.hidden ? "false" : "true"); });
const rawConfirm = $("term-trace-confirm");
const rawOk = $("term-trace-confirm-ok");
const rawCancel = $("term-trace-confirm-cancel");
const closeRawConfirm = () => { rawConfirm.hidden = true; traceRaw.focus(); };
traceRaw.addEventListener("change", () => {
  if (!traceRaw.checked) { rawConfirm.hidden = true; return; }
  traceRaw.checked = false; // stays off until confirmed, so a copy while the prompt is open is redacted
  rawConfirm.hidden = false;
  rawOk.focus();
});
rawOk.addEventListener("click", () => { traceRaw.checked = true; closeRawConfirm(); });
rawCancel.addEventListener("click", closeRawConfirm);
rawConfirm.addEventListener("keydown", (ev) => { if (ev && ev.key === "Escape") closeRawConfirm(); });
$("term-trace-dl").addEventListener("click", () => {
  if (!agentId) return;
  const o = traceOpts(false);
  fetch(T.url(base, agentId, o)).then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.text(); })
    .then((text) => { traceSay("Downloaded " + T.download(traceDeps(), text, T.filename(agentId, o)), false); })
    .catch((err) => traceSay("Trace failed: " + String(err && err.message ? err.message : err), true));
});

addEventListener("hashchange", () => { if (active && location.hash.startsWith("#/terminal") && TermKit.routeId(location.hash) !== agentId) open(); });
K.onActivate("terminal", () => { active = true; open(); }, () => { active = false; teardown(); });
})();
</script>`;
}

// Open escalations. GET <escalationsPath>?state=open returns escalation records
// ({ id, agent, question, options, createdAt, ... }); each answer input posts to the
// operator-scoped answer route (<answerPath>/<id>/answer) with { body, idempotencyKey }.
// The list polls every 5s while the tab is active, adding new asks and dropping answered ones
// without disturbing an answer being typed.
export function renderEscalationsPane(ctx: { escalationsPath?: string; answerPath?: string } = {}): string {
  const escalations = scriptJson(ctx.escalationsPath ?? "/v1/escalations");
  const answerPath = scriptJson(ctx.answerPath ?? "/v1/escalations");
  return `<div class="escalations pane">
<div id="escalations-status" class="meta"></div>
<ul id="escalations"></ul>
</div>
<script>
(() => {
${PANE_KIT_JS}
const list = document.getElementById("escalations");
const status = document.getElementById("escalations-status");
const items = new Map();
const answer = (id, body) => fetch(${answerPath} + "/" + encodeURIComponent(id) + "/answer", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ body, idempotencyKey: K.uuid() }),
});
const build = (e) => {
  const li = document.createElement("li");
  li.appendChild(K.cell("div", e.question));
  li.appendChild(K.cell("div", e.agent + " \u00b7 " + K.age(Date.now() - e.createdAt) + " \u00b7 " + (e.options ?? []).join(" / "), "meta"));
  const input = document.createElement("input");
  input.placeholder = "answer";
  const btn = K.cell("button", "send");
  btn.addEventListener("click", () => {
    if (!input.value) return;
    answer(e.id, input.value).then((res) => {
      K.check(res);
      li.remove();
      items.delete(e.id);
      if (items.size === 0) status.textContent = "No open escalations";
    }).catch((err) => {
      li.appendChild(K.cell("div", (err && err.status === 401) ? K.errorMessage("", err) : "Failed to answer: " + String(err), "err"));
    });
  });
  const row = document.createElement("div");
  row.appendChild(input);
  row.appendChild(btn);
  li.appendChild(row);
  return li;
};
const refresh = () => K.getJson(${escalations} + "?state=open").then((rows) => {
  const ids = new Set(rows.map((e) => e.id));
  for (const [id, li] of items) if (!ids.has(id)) { li.remove(); items.delete(id); }
  for (const e of rows) {
    if (items.has(e.id)) continue;
    const li = build(e);
    items.set(e.id, li);
    list.appendChild(li);
  }
  status.className = "meta";
  status.textContent = items.size === 0 ? "No open escalations" : "";
}).catch((err) => {
  status.className = "err";
  status.textContent = K.errorMessage("escalations", err);
});
const poller = K.poll(refresh, 5000);
K.onActivate("escalations", () => poller.start(), () => poller.stop());
})();
</script>`;
}

// Hosts/queue: reads GET <placementPath> (a single PlacementStatus object), polling every 5s while active.
export function renderHostsPane(ctx: { placementPath?: string } = {}): string {
  const placement = scriptJson(ctx.placementPath ?? "/v1/placement");
  return `<div class="hosts pane">
<pre id="hosts-status">loading\u2026</pre>
</div>
<script>
(() => {
${PANE_KIT_JS}
const status = document.getElementById("hosts-status");
const refresh = () => K.getJson(${placement}).then((p) => {
  const running = p.running ?? [];
  const queue = p.queue ?? [];
  const lines = ["host " + p.host + " \u00b7 max " + p.maxConcurrent];
  lines.push("running: " + (running.length ? running.join(", ") : "(none)"));
  lines.push("queue: " + (queue.length ? queue.map((q) => q.agent + " (p" + q.priority + ")").join(", ") : "(empty)"));
  if (!running.length && !queue.length) lines.push("", "No agents yet \u2014 start one with \`pomtree spawn --task \\"...\\"\`");
  status.className = "";
  status.textContent = lines.join("\\n");
}).catch((err) => {
  status.className = "err";
  status.textContent = K.errorMessage("placement", err);
});
const poller = K.poll(refresh, 5000);
K.onActivate("hosts", () => poller.start(), () => poller.stop());
})();
</script>`;
}

// Schedules: GET <schedulesPath> returns Schedule[]. State shows active / paused / a breaker-open note
// (failures + retryAt). The route returns no computed next-fire time, so none is shown.
export function renderSchedulesPane(ctx: { schedulesPath?: string } = {}): string {
  const schedules = scriptJson(ctx.schedulesPath ?? "/v1/schedules");
  return `<div class="schedules pane">
<div class="tablewrap"><table>
<thead><tr><th>ID</th><th>CRON</th><th>TZ</th><th>TASK</th><th>STATE</th><th>MISSED</th><th>OVERLAP</th></tr></thead>
<tbody id="schedules-rows"></tbody>
</table></div>
</div>
<script>
(() => {
${PANE_KIT_JS}
const tbody = document.getElementById("schedules-rows");
const stateOf = (s) => {
  if (s.paused) return "paused";
  if (s.failures && s.retryAt && s.retryAt > Date.now()) return "breaker open (" + s.failures + " failures, retry in " + K.age(s.retryAt - Date.now()) + ")";
  if (s.failures) return "active (" + s.failures + " recent failures)";
  return "active";
};
const load = () => K.getJson(${schedules}).then((rows) => {
  if (rows.length === 0) { tbody.replaceChildren(K.messageRow(7, "empty", "No schedules \u2014 add one with \`pomtree sched add\`")); return; }
  tbody.replaceChildren(...rows.map((s) => {
    const tr = document.createElement("tr");
    for (const v of [s.id, s.cron, s.tz ?? "UTC", s.task, stateOf(s), s.missed, s.overlap]) tr.appendChild(K.cell("td", v));
    return tr;
  }));
}).catch((err) => tbody.replaceChildren(K.messageRow(7, "error", K.errorMessage("schedules", err))));
K.onActivate("schedules", load);
})();
</script>`;
}
