// Shared browser-side helpers for the inline panes, shipped as source text. Each pane embeds
// PANE_KIT_JS at the top of its own IIFE; the first one to run installs globalThis.PaneKit and the rest
// reuse it, so panes stay self-contained (they also work in the standalone live/reports pages, where
// there is no UI router) and no top-level const leaks between classic <script> tags.
// Keep this plain JS with no backticks or template interpolation: it is a TS template literal.

import { MENU_KIT_JS } from "./menuModel.ts";

export const PANE_KIT_JS = `
${MENU_KIT_JS}
const K = globalThis.PaneKit || (globalThis.PaneKit = (() => {
  const httpError = (res) => Object.assign(new Error("HTTP " + res.status), { status: res.status });
  const check = (res) => { if (!res.ok) throw httpError(res); return res; };
  const errorMessage = (what, err) => (err && err.status === 401)
    ? "Not signed in \\u2014 reload to sign in"
    : "Failed to load " + what + ": " + String(err);
  const getJson = (url) => fetch(url).then(check).then((r) => r.json());
  // badge is an element (text and class set here) or a function called as (ok, text) with text connecting, connected or stale.
  const setConn = (badge, ok, text) => {
    if (!badge) return;
    const label = text || (ok ? "connected" : "stale");
    if (typeof badge === "function") { badge(ok, label); return; }
    badge.textContent = label;
    badge.className = "conn " + (ok ? "ok" : "stale");
  };
  const notice = (el, kind, text) => {
    if (!el) return;
    el.textContent = text || "";
    el.className = "pane-notice " + (kind === "err" ? "err" : "meta");
    el.hidden = !text;
    // The notice scrolls (max-height), so a shown one is a Tab stop and a keyboard user can read all of it.
    if (text) { if (el.setAttribute) { el.setAttribute("title", text); el.setAttribute("tabindex", "0"); } } else if (el.removeAttribute) { el.removeAttribute("title"); el.removeAttribute("tabindex"); }
  };
  const stream = (url, handlers, badge) => {
    const es = new EventSource(url);
    setConn(badge, false, "connecting");
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
  // Internal view registry for the tiling shell: one object registers one view type. def = { id, title, multi, subject?, menus?, status?,
  // mount(root, { agent?, report? }, host) -> { unmount(), fit?() } }, host = { setTitle(text), navigate(hash) }.
  // An item view shows exactly one subject (subject "agent": one window per agent id; "report": one per agent id and report id).
  // multi without subject means "agent"; a view without multi is a browsing view and has no subject. view(id).subject is the result.
  // TODO(ui-extension-view-types): the registry is internal; extensions cannot declare view types. Trigger: the first public view-type API (docs/ui-vision.md, Open questions).
  const viewTypes = new Map();
  const declarations = new Map();
  const registerView = (def) => {
    const id = def && def.id;
    if (typeof id !== "string" || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error("registerView: invalid view id " + JSON.stringify(id) + "; use a lowercase id such as terminal");
    if (viewTypes.has(id)) throw new Error("registerView: view " + id + " is already registered; register each view id once");
    if (typeof def.title !== "string" || typeof def.multi !== "boolean" || typeof def.mount !== "function") throw new Error("registerView: view " + id + " needs a string title, a boolean multi and a mount function");
    if (def.subject !== undefined && def.subject !== "agent" && def.subject !== "report") throw new Error("registerView: view " + id + " has subject " + JSON.stringify(def.subject) + "; use agent or report");
    if (def.subject !== undefined && !def.multi) throw new Error("registerView: view " + id + " has a subject but multi is false; an item view needs multi: true");
    const decl = MenuKit.declareView({ id, title: def.title, multi: def.multi, menus: def.menus, status: def.status, controls: def.controls });
    viewTypes.set(id, { ...def, subject: def.multi ? def.subject || "agent" : undefined });
    declarations.set(id, decl);
  };
  // Stale-content overlay shared by the streaming views (terminal, browser): a semi-transparent veil over the kept
  // last content with a spinner (kind "busy": connecting or reconnecting), a pause icon ("idle": nothing to retry,
  // not a fault) or a danger icon ("dead": ended, failed, denied or gone), plus a text label. One persistent
  // role=status element, toggled with hidden so a screen reader announces each change; it never takes the pointer, so
  // the content under it stays selectable. A busy veil over existing content waits STALE_GRACE_MS so a brief
  // reconnect does not flicker; idle and dead show at once, and so does busy when nothing is shown yet.
  const STALE_GRACE_MS = 800;
  const STALE_KINDS = ["none", "busy", "idle", "dead"];
  // When to paint a request, given the kind now painted: "hide", "now" or "later" (after the grace delay).
  const overlayPlan = (painted, kind, hasContent) => {
    if (kind === "none") return "hide";
    if (kind === "busy" && painted === "none" && hasContent) return "later";
    return "now";
  };
  const staleOverlay = (parent, hasContent) => {
    const box = document.createElement("div");
    const icon = document.createElement("span");
    const label = document.createElement("span");
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    icon.setAttribute("aria-hidden", "true");
    label.className = "stale-label";
    box.appendChild(icon);
    box.appendChild(label);
    box.hidden = true;
    box.className = "stale-overlay";
    parent.className = (parent.className ? parent.className + " " : "") + "stale-host";
    parent.appendChild(box);
    let painted = "none";
    let timer = null;
    const cancel = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
    const paint = (kind, text) => {
      painted = kind;
      box.className = "stale-overlay stale-" + kind;
      icon.className = "stale-icon" + (kind === "busy" ? " stale-spinner" : "");
      icon.textContent = kind === "dead" ? "\u26a0" : kind === "idle" ? "\u23f8" : "";
      label.textContent = text;
      box.hidden = false;
    };
    const set = (kind, text) => {
      if (STALE_KINDS.indexOf(kind) < 0) throw new Error("staleOverlay: unknown kind " + JSON.stringify(kind) + "; use one of " + STALE_KINDS.join(", "));
      cancel();
      const plan = overlayPlan(painted, kind, !!hasContent());
      if (plan === "hide") { painted = "none"; box.hidden = true; box.className = "stale-overlay"; return; }
      if (plan === "now") { paint(kind, String(text || "")); return; }
      timer = setTimeout(() => { timer = null; paint(kind, String(text || "")); }, STALE_GRACE_MS);
    };
    return { set, kind: () => painted, destroy: () => { cancel(); box.hidden = true; painted = "none"; } };
  };
  const view = (id) => viewTypes.get(id);
  // The validated menu and status declaration of a registered view, and a fresh per-tile window model over it.
  const declaration = (id) => declarations.get(id);
  const windowModel = (id) => {
    const decl = declarations.get(id);
    if (!decl) throw new Error("windowModel: view " + JSON.stringify(id) + " is not registered; register it with registerView first");
    return MenuKit.createWindowModel(decl);
  };
  const views = () => [...viewTypes.values()];
  // The host argument for a view's mount: the chrome's own host plus the window model's menu and status hooks.
  const windowHost = (model, base) => {
    if (!model || typeof model.setState !== "function" || typeof model.setStatus !== "function" || typeof model.onCommand !== "function") throw new Error("windowHost: model must be a window model from windowModel(id) with setState, setStatus and onCommand; pass the result of windowModel");
    if (base === null || typeof base !== "object" || Array.isArray(base)) throw new Error("windowHost: base must be the host object the chrome gives a view; pass an object");
    return { ...base, setMenuState: model.setState, setStatus: model.setStatus, onCommand: model.onCommand };
  };
  // Section views (a <section data-tab> such as inbox) are not registry views and live in at most one tile, so one persistent model each.
  const sectionModels = new Map();
  const declareSection = (decl) => {
    const id = decl && decl.id;
    if (typeof id !== "string" || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error("declareSection: invalid section id " + JSON.stringify(id) + "; use the lowercase data-tab id such as inbox");
    if (sectionModels.has(id)) throw new Error("declareSection: section " + id + " is already declared; declare each section once");
    const norm = MenuKit.declareView({ id, title: decl.title, multi: false, menus: decl.menus, status: decl.status, controls: decl.controls });
    sectionModels.set(id, MenuKit.createWindowModel(norm));
  };
  const sectionModel = (id) => sectionModels.get(id);
  const sectionHost = (id) => {
    const model = sectionModels.get(id);
    if (!model) throw new Error("sectionHost: section " + JSON.stringify(id) + " is not declared; call declareSection first");
    return windowHost(model, {});
  };
  return { check, errorMessage, getJson, notice, setConn, stream, onActivate, poll, uuid, age, cell, messageRow, STALE_GRACE_MS, overlayPlan, staleOverlay, registerView, view, views, declaration, windowModel, windowHost, declareSection, sectionModel, sectionHost };
})());
`;

// Pane styles. Colour/spacing tokens live on :root in UI_CSS (shell.ts), which every page embeds with these.
export const PANE_CSS = `
.pane { --pane-inset: 0.75rem; --pane-gap: 0.5rem; --cell-y: 0.3125rem; --cell-x: 0.75rem; --fs-xs: 0.75rem; --fs-sm: 0.8125rem; --fs-md: 0.875rem; --fs-lg: 1rem; box-sizing: border-box; display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; padding: 0; }
.pane-body { flex: 1 1 auto; min-height: 0; min-width: 0; overflow: auto; }
.pane a { color: var(--accent); text-underline-offset: 0.15em; }
.pane a:hover { text-decoration-thickness: 2px; }
.pane .tablewrap { max-width: 100%; overflow-x: auto; }
.pane .tablewrap.pane-body { overflow: auto; background: var(--surface); }
/* standalone live/reports pages keep the card look: the only override of the bezel-less tile table */
body:not(.wm) .pane > * + * { margin-top: var(--gap); }
body:not(.wm) .pane .tablewrap { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.pane table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: var(--fs-md); }
.pane th, .pane td { text-align: left; padding: var(--cell-y) var(--cell-x); border-bottom: 1px solid var(--border); white-space: nowrap; }
.pane tbody tr:last-child td { border-bottom: 0; }
.pane th { color: var(--muted); background: var(--surface-2); font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.pane .tablewrap th { position: sticky; top: 0; z-index: 1; background: var(--surface-2); border-bottom: 1px solid var(--border-strong); }
.pane tbody tr:hover td { background: var(--hover); }
.pane td.empty { color: var(--muted); white-space: normal; }
.pane td.error { color: var(--err); white-space: normal; }
.pane-empty { margin: 0; padding: var(--pane-inset); color: var(--muted); font-size: var(--fs-md); }
.pane-notice { flex: 0 0 auto; padding: 0.125rem var(--pane-inset); font-size: var(--fs-sm); line-height: 1.4; white-space: normal; overflow-wrap: anywhere; max-height: 4.5rem; overflow: auto; }
.pane-notice:empty, .pane-notice[hidden] { display: none; }
.pane-notice.err { color: var(--err); }
.pane-notice.meta { color: var(--muted); }
ul.card-list.pane-body { list-style: none; margin: 0; display: grid; align-content: start; gap: var(--pane-gap); padding: var(--pane-inset); }
ul.card-list > li { padding: var(--pane-inset); background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--border-strong); border-radius: var(--radius); box-shadow: var(--shadow); }
ul.card-list > li > * + * { margin-top: var(--pane-gap); }
ul.card-list .actions { display: flex; flex-wrap: wrap; gap: var(--pane-gap); }
ul.card-list .actions input { flex: 1 1 12rem; }
ul.card-list > li.tone-warn { border-left: 3px solid var(--warn); }
ul.card-list > li.tone-err { border-left: 3px solid var(--err); }
ul.card-list > li.tone-info { border-left: 3px solid var(--info); }
.pane-form { display: flex; flex-direction: column; gap: var(--pane-gap); padding: var(--pane-inset); box-sizing: border-box; container-type: inline-size; container-name: tile; }
.pane-form label { display: block; margin: 0 0 0.25rem; color: var(--muted); font-size: var(--fs-md); font-weight: 600; }
.pane-form input, .pane-form select, .pane-form textarea { display: block; width: 100%; box-sizing: border-box; }
.pane-form textarea { flex: 1 1 auto; min-height: 6rem; resize: vertical; }
.pane-form input[type=checkbox] { display: inline-block; width: auto; margin-right: 0.5rem; }
.pane-form summary { cursor: pointer; color: var(--muted); font-size: var(--fs-md); font-weight: 600; }
.pane-form p { margin: 0; }
.pane-form .row { display: grid; grid-template-columns: 1fr; gap: var(--pane-gap); }
@container tile (min-width: 40rem) { .pane-form .row { grid-template-columns: 1fr 1fr; } }
.pane-form .row > :only-child { grid-column: 1 / -1; }
.pane button, .pane a.btn { font: inherit; font-size: var(--fs-sm); display: inline-flex; align-items: center; justify-content: center; gap: 0.375rem; padding: 0.125rem 0.5rem; color: var(--text); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); cursor: pointer; text-decoration: none; transition: background 0.15s, border-color 0.15s; }
.pane button:hover { background: var(--hover); }
.pane a.btn, .pane button.btn { color: var(--accent-fg); background: var(--accent); border-color: transparent; font-weight: 600; }
.pane a.btn:hover, .pane button.btn:hover { background: var(--accent-hover); }
.pane button:disabled { opacity: 0.55; cursor: default; }
.pane input, .pane textarea, .pane select { font: inherit; font-size: var(--fs-md); color: var(--text); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 0.1875rem 0.5rem; min-width: 0; transition: border-color 0.15s, box-shadow 0.15s; }
.pane input::placeholder, .pane textarea::placeholder { color: var(--muted); }
.pane input:focus-visible, .pane textarea:focus-visible, .pane select:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--focus); }
.pane tr.s-running td.state { color: var(--ok); font-weight: 600; }
.pane tr.s-yielded td.state { color: var(--warn); font-weight: 600; }
.pane tr.s-exited td.state { color: var(--info); font-weight: 600; }
.pane tr.s-exited td.state.failed { color: var(--err); }
.pane tr.s-pending td, .pane tr.s-reaped td { color: var(--muted); }
.pane .conn { display: inline-block; font-size: var(--fs-xs); line-height: 1.4; padding: 0.0625rem 0.625rem; border: 1px solid var(--border-strong); border-radius: 999px; margin-left: 0.5rem; color: var(--muted); background: var(--surface-2); vertical-align: middle; }
.pane .conn:empty { display: none; }
.pane .conn.ok { color: var(--ok); border-color: var(--ok); }
.pane .conn.stale { color: var(--warn); border-color: var(--warn); }
.pane .err { color: var(--err); }
.pane .meta { color: var(--muted); font-size: var(--fs-md); }
.pane td.state.live::before { content: ""; display: inline-block; width: 0.5rem; height: 0.5rem; margin-right: 0.375rem; border-radius: 50%; background: var(--ok); animation: livepulse 1.2s ease-in-out infinite; }
@keyframes livepulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.7); } }
@media (prefers-reduced-motion: reduce) { .pane td.state.live::before { animation: none; } }
@media (pointer: coarse) {
  .pane button, .pane a.btn, .pane input, .pane select, .pane textarea { min-height: 2.5rem; }
}
/* The inbox pane lives in the shared sheet: no inline style per pane (the drift test forbids it). */
.inbox li.hl { outline: 2px solid var(--accent); outline-offset: 2px; }
.inbox .head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.inbox .badge { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.0625rem 0.5rem; border: 1px solid var(--border-strong); border-radius: 999px; color: var(--muted); }
.inbox .subject { white-space: pre-wrap; overflow-wrap: anywhere; }
.inbox .actions.big button { flex: 1 1 6rem; min-height: 3rem; font-size: 1rem; }
.inbox li.compose { position: sticky; top: 0; z-index: 5; }
.inbox .compose form { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: flex-start; }
.inbox .compose input { flex: 1 1 9rem; }
.inbox .compose textarea { flex: 3 1 14rem; resize: vertical; font: inherit; }
.inbox .compose button { flex: 0 0 auto; }
/* Stale-content overlay (K.staleOverlay): veil over a view's kept last content; the pointer passes through to it. */
.stale-host { position: relative; }
.stale-overlay { position: absolute; inset: 0; z-index: 6; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.5rem; padding: var(--pane-inset, 0.75rem); background: rgb(0 0 0 / 0.45); background: color-mix(in srgb, var(--surface) 72%, transparent); color: var(--text); font-size: var(--fs-md, 0.875rem); text-align: center; overflow-wrap: anywhere; pointer-events: none; }
.stale-overlay[hidden] { display: none; }
.stale-overlay.stale-dead { color: var(--err); }
.stale-overlay.stale-idle { color: var(--muted); }
.stale-icon { font-size: 1.5rem; line-height: 1; }
.stale-spinner { box-sizing: border-box; width: 1.5rem; height: 1.5rem; border: 3px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: stalespin 0.9s linear infinite; }
@keyframes stalespin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .stale-spinner { animation: none; } }
.report-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
.report-body .md, .report-body pre { padding: var(--pane-inset); }
.report-frame { flex: 0 0 100%; width: 100%; height: 100%; border: 0; background: #fff; }
.report-img { flex: 0 0 100%; width: 100%; height: 100%; min-height: 0; object-fit: contain; }
`;
