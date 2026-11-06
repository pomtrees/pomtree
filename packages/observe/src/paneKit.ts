// Shared browser-side helpers for the inline panes, shipped as source text. Each pane embeds
// PANE_KIT_JS at the top of its own IIFE; the first one to run installs globalThis.PaneKit and the rest
// reuse it, so panes stay self-contained (they also work in the standalone live/reports pages, where
// there is no UI router) and no top-level const leaks between classic <script> tags.
// Keep this plain JS with no backticks or template interpolation: it is a TS template literal.

export const PANE_KIT_JS = `
const K = globalThis.PaneKit || (globalThis.PaneKit = (() => {
  const httpError = (res) => Object.assign(new Error("HTTP " + res.status), { status: res.status });
  const check = (res) => { if (!res.ok) throw httpError(res); return res; };
  const errorMessage = (what, err) => (err && err.status === 401)
    ? "Not signed in \\u2014 reload to sign in"
    : "Failed to load " + what + ": " + String(err);
  const getJson = (url) => fetch(url).then(check).then((r) => r.json());
  const setConn = (el, ok) => {
    if (!el) return;
    el.textContent = ok ? "connected" : "stale";
    el.className = "conn " + (ok ? "ok" : "stale");
  };
  const stream = (url, handlers, badge) => {
    const es = new EventSource(url);
    setConn(badge, false);
    if (badge) badge.textContent = "connecting";
    es.onopen = () => setConn(badge, true);
    es.onerror = () => setConn(badge, false);
    for (const name of Object.keys(handlers)) {
      es.addEventListener(name, (ev) => { setConn(badge, true); handlers[name](ev); });
    }
    return es;
  };
  const onActivate = (id, activate, deactivate) => {
    if (typeof UI !== "undefined" && UI && UI.register) UI.register(id, activate, deactivate);
    else activate();
  };
  const poll = (fn, ms) => {
    let timer = null;
    return {
      start() { fn(); if (timer === null) timer = setInterval(fn, ms); },
      stop() { if (timer !== null) { clearInterval(timer); timer = null; } },
    };
  };
  const uuid = () => (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
  const age = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h";
    return Math.floor(h / 24) + "d";
  };
  const cell = (tag, value, cls) => {
    const el = document.createElement(tag);
    el.textContent = String(value == null ? "" : value);
    if (cls) el.className = cls;
    return el;
  };
  const messageRow = (cols, cls, text) => {
    const tr = document.createElement("tr");
    const td = cell("td", text, cls);
    td.colSpan = cols;
    tr.appendChild(td);
    return tr;
  };
  // Internal view registry for the tiling shell: one object registers one view type. def = { id, title, multi,
  // mount(root, { agent? }, host) -> { unmount(), fit?() } }, host = { setTitle(text), navigate(hash) }.
  const viewTypes = new Map();
  const registerView = (def) => {
    const id = def && def.id;
    if (typeof id !== "string" || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error("registerView: invalid view id " + JSON.stringify(id) + "; use a lowercase id such as terminal");
    if (viewTypes.has(id)) throw new Error("registerView: view " + id + " is already registered; register each view id once");
    if (typeof def.title !== "string" || typeof def.multi !== "boolean" || typeof def.mount !== "function") throw new Error("registerView: view " + id + " needs a string title, a boolean multi and a mount function");
    viewTypes.set(id, def);
  };
  const view = (id) => viewTypes.get(id);
  const views = () => [...viewTypes.values()];
  return { check, errorMessage, getJson, setConn, stream, onActivate, poll, uuid, age, cell, messageRow, registerView, view, views };
})());
`;

// Pane styles. Colour/spacing tokens live on :root in UI_CSS (shell.ts), which every page embeds with these.
export const PANE_CSS = `
.pane { min-width: 0; }
.pane > * + * { margin-top: var(--gap); }
.pane h3 { margin: 0; font-size: 1.125rem; }
.pane a { color: var(--accent); text-underline-offset: 0.15em; }
.pane a:hover { text-decoration-thickness: 2px; }
.pane .tablewrap { max-width: 100%; overflow-x: auto; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.pane table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 0.875rem; }
.pane th, .pane td { text-align: left; padding: 0.5rem 0.875rem; border-bottom: 1px solid var(--border); white-space: nowrap; }
.pane tbody tr:last-child td { border-bottom: 0; }
.pane th { color: var(--muted); background: var(--surface-2); font-size: 0.75rem; font-weight: 600; letter-spacing: 0.04em; }
.pane tbody tr:hover td { background: var(--hover); }
.pane .report-banner { padding: 0.5rem 0.75rem; margin: 0.5rem 0; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--muted); }
.pane .report-banner .report-actions { display: inline; }
.pane p.empty { color: var(--muted); }
.pane td.empty { color: var(--muted); white-space: normal; }
.pane td.error { color: var(--err); white-space: normal; }
.pane button, .pane a.btn { font: inherit; display: inline-flex; align-items: center; justify-content: center; gap: 0.375rem; padding: 0.375rem 0.875rem; color: var(--text); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); cursor: pointer; text-decoration: none; transition: background 0.15s, border-color 0.15s; }
.pane button:hover { background: var(--hover); }
.pane a.btn, .pane button.btn { color: var(--accent-fg); background: var(--accent); border-color: transparent; font-weight: 600; }
.pane a.btn:hover, .pane button.btn:hover { background: var(--accent-hover); }
.pane button:disabled { opacity: 0.55; cursor: default; }
.pane input, .pane textarea, .pane select { font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 0.4375rem 0.625rem; min-width: 0; transition: border-color 0.15s, box-shadow 0.15s; }
.pane input::placeholder, .pane textarea::placeholder { color: var(--muted); }
.pane input:focus-visible, .pane textarea:focus-visible, .pane select:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--focus); }
.pane .filters { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.pane .filters input { flex: 1 1 10rem; max-width: 16rem; }
.pane tr.s-running td.state { color: var(--ok); font-weight: 600; }
.pane tr.s-yielded td.state { color: var(--warn); font-weight: 600; }
.pane tr.s-exited td.state { color: var(--info); font-weight: 600; }
.pane tr.s-exited td.state.failed { color: var(--err); }
.pane tr.s-pending td, .pane tr.s-reaped td { color: var(--muted); }
.pane .conn, .pane span.state { display: inline-block; font-size: 0.75rem; line-height: 1.4; padding: 0.0625rem 0.625rem; border: 1px solid var(--border-strong); border-radius: 999px; margin-left: 0.5rem; color: var(--muted); background: var(--surface-2); vertical-align: middle; }
.pane .conn:empty, .pane span.state:empty { display: none; }
.pane .conn.ok { color: var(--ok); border-color: var(--ok); }
.pane .conn.stale { color: var(--warn); border-color: var(--warn); }
.pane .err { color: var(--err); }
.pane .meta { color: var(--muted); font-size: 0.875rem; }
.pane #escalations { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--gap); }
.pane #escalations li { padding: var(--gap); background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--warn); border-radius: var(--radius); box-shadow: var(--shadow); }
.pane #escalations li > * + * { margin-top: 0.5rem; }
.pane #escalations li > div:last-child { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.pane #escalations input { flex: 1 1 12rem; }
.pane pre#hosts-status { margin: 0; padding: var(--gap); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); overflow-x: auto; font-family: var(--mono); font-size: 0.875rem; line-height: 1.6; }
.pane.newagent { max-width: 40rem; }
.pane.newagent label { display: block; margin: 0.875rem 0 0.25rem; color: var(--muted); font-size: 0.875rem; font-weight: 600; }
.pane.newagent textarea, .pane.newagent input, .pane.newagent select { display: block; width: 100%; box-sizing: border-box; }
.pane.newagent textarea { height: 8rem; resize: vertical; }
.pane.newagent p { margin: 1rem 0 0.5rem; }
.pane.newagent input[type=checkbox] { display: inline-block; width: auto; margin-right: 0.5rem; }
.pane.newagent summary { margin-top: 1rem; cursor: pointer; color: var(--muted); font-size: 0.875rem; font-weight: 600; }
.pane span.state.s-running { color: var(--ok); border-color: var(--ok); }
.pane span.state.s-yielded { color: var(--warn); border-color: var(--warn); }
.pane span.state.s-exited { color: var(--info); border-color: var(--info); }
.pane span.state.failed { color: var(--err); border-color: var(--err); }
.pane td.state.live::before { content: ""; display: inline-block; width: 0.5rem; height: 0.5rem; margin-right: 0.375rem; border-radius: 50%; background: var(--ok); animation: livepulse 1.2s ease-in-out infinite; }
@keyframes livepulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.7); } }
@media (prefers-reduced-motion: reduce) { .pane td.state.live::before { animation: none; } }
@media (pointer: coarse) {
  .pane button, .pane a.btn, .pane input, .pane select, .pane textarea { min-height: 2.5rem; }
}
`;
