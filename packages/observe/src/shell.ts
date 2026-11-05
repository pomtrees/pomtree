// A single-document shell hosting tab panes behind a hash router: fully inline,
// no build step, no framework. Tab fragments are trusted extension HTML and are
// inserted raw; untrusted titles and ids go through escapeHtml, and any ctx.path /
// ctx.href value embedded in inline <script> text must go through scriptJson.
import { MD_CSS } from "./mdKit.ts";
import { TERM_CSS } from "./termKit.ts";
import { TRACE_CSS } from "./traceKit.ts";
import { PANE_CSS } from "./paneKit.ts";
import { escapeHtml, scriptJson } from "./web.ts";

export interface UiTabCtx {
  path(p: string): string;
  href(route: string): string;
}

export interface UiTab {
  id: string;
  title: string;
  shortTitle?: string;
  nav?: "main" | "more";
  render(ctx: UiTabCtx): string;
}

export class TabRegistry {
  #tabs: UiTab[] = [];

  register(tab: UiTab): void {
    if (!/^[A-Za-z0-9_-]+$/.test(tab.id)) throw new Error(`invalid tab id: ${JSON.stringify(tab.id)}`);
    if (this.#tabs.some((t) => t.id === tab.id)) throw new Error(`duplicate tab id: ${tab.id}`);
    this.#tabs.push(tab);
  }

  list(): readonly UiTab[] {
    return this.#tabs;
  }
}

// Client-side session guard (plain JS, embedded in the shell). Any fetch answered 401 means the UI cookie
// expired or was invalidated: `onUnauthorized` fires once (the shell reloads, and /ui then serves the login
// page). EventSource errors carry no status, so each failing stream triggers one probe fetch to `probePath`,
// whose 401 is caught by the same wrapper. Installed against an injectable global so it is unit-testable.
export const AUTH_GUARD_SCRIPT = `function installAuthGuard(g, onUnauthorized, probePath) {
  let fired = false;
  const fire = () => { if (!fired) { fired = true; onUnauthorized(); } };
  const origFetch = g.fetch.bind(g);
  g.fetch = (...args) => origFetch(...args).then((res) => { if (res && res.status === 401) fire(); return res; });
  const OrigES = g.EventSource;
  if (OrigES) {
    g.EventSource = function (...args) {
      const es = new OrigES(...args);
      es.addEventListener("error", () => { g.fetch(probePath).catch(() => {}); });
      return es;
    };
    g.EventSource.prototype = OrigES.prototype;
  }
  return fire;
}`;

// The one stylesheet shared by the shell, live and reports pages: tokens, page chrome, then the pane kit.
// All type is rem-based; the root size grows with the viewport so HiDPI/large screens are not tiny.
export const UI_CSS = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --surface: #fff; --surface-2: #f0f2f5; --hover: #eef1f6; --code-bg: #f3f4f7;
  --border: #e2e5ea; --border-strong: #c9ced6;
  --text: #1c2025; --muted: #626b78;
  --accent: #2557d6; --accent-hover: #1d46ad; --accent-fg: #fff; --focus: rgb(37 87 214 / 0.28);
  --ok: #17803d; --warn: #a76100; --err: #c62828; --info: #0b7a8a;
  --shadow: 0 1px 2px rgb(16 24 40 / 0.06);
  --radius: 0.625rem; --radius-sm: 0.375rem; --gap: 1rem; --pad: clamp(1rem, 3vw, 2rem);
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216; --surface: #171b21; --surface-2: #1d222a; --hover: #222833; --code-bg: #12161b;
    --border: #272d37; --border-strong: #38404c;
    --text: #e6e9ee; --muted: #9099a7;
    --accent: #6d9bff; --accent-hover: #86adff; --accent-fg: #0b1220; --focus: rgb(109 155 255 / 0.35);
    --ok: #4ade80; --warn: #f5b942; --err: #ff7b72; --info: #4cc9d9;
    --shadow: 0 1px 2px rgb(0 0 0 / 0.4);
  }
}
html { font-size: clamp(100%, 0.875rem + 0.25vw, 1.25rem); -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 1rem/1.5 var(--sans); }
[hidden] { display: none !important; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
h1 { margin: 0 0 var(--gap); font-size: 1.5rem; line-height: 1.25; }
code, pre { font-family: var(--mono); }
nav { display: flex; align-items: stretch; gap: 0.25rem; overflow-x: auto; scrollbar-width: none; }
nav::-webkit-scrollbar { display: none; }
nav a, nav button { font: inherit; color: var(--muted); text-decoration: none; padding: 0.625rem 0.875rem; border: 0; border-radius: var(--radius-sm); background: none; cursor: pointer; white-space: nowrap; transition: color 0.15s, background 0.15s; }
nav a:hover, nav button:hover { color: var(--text); background: var(--hover); }
nav a.active { color: var(--accent); font-weight: 600; background: color-mix(in srgb, var(--accent) 12%, transparent); }
nav.top { padding: 0.375rem max(var(--pad), calc((100% - 80rem) / 2)); background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; }
nav.top button#signout { margin-left: auto; }
nav.bottom { display: none; }
main { box-sizing: border-box; width: min(100% - 2 * var(--pad), 80rem); margin: 0 auto; padding: var(--pad) 0; }
@media (max-width: 640px) {
  nav.top a { display: none; }
  nav.bottom { display: flex; position: fixed; bottom: 0; left: 0; right: 0; z-index: 10; justify-content: space-around; padding: 0.25rem 0.25rem calc(0.25rem + env(safe-area-inset-bottom)); background: var(--surface); border-top: 1px solid var(--border); }
  nav.bottom a { flex: 1 1 0; text-align: center; padding: 0.625rem 0.25rem; font-size: 0.8125rem; }
  main { padding-bottom: 5rem; }
}
@media (pointer: coarse) {
  nav a, nav button { min-height: 2.5rem; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}
${PANE_CSS}${MD_CSS}${TERM_CSS}${TRACE_CSS}`;

export function renderShell(opts: { tabs: readonly UiTab[]; prefix?: string; title?: string }): string {
  const title = escapeHtml(opts.title ?? "pomtree");
  const prefix = opts.prefix ?? "";

  const ctx: UiTabCtx = {
    path: (p) => (p.startsWith("/") ? prefix + p : prefix === "" ? p : `${prefix}/${p}`),
    href: (route) => `#${route}`,
  };

  const navLink = (tab: UiTab, short: boolean): string => {
    const id = escapeHtml(tab.id);
    const href = escapeHtml(ctx.href(`/${tab.id}`));
    const label = escapeHtml(short ? (tab.shortTitle ?? tab.title) : tab.title);
    return `<a href="${href}" data-nav="${id}">${label}</a>`;
  };

  const top = opts.tabs.map((t) => navLink(t, false)).join("");
  const bottom = opts.tabs.map((t) => navLink(t, true)).join("");
  const sections = opts.tabs.map((t) => `<section data-tab="${escapeHtml(t.id)}" hidden>${t.render(ctx)}</section>`).join("");

  const defaultId = scriptJson(opts.tabs[0]?.id ?? "");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>${UI_CSS}</style>
<script>
${AUTH_GUARD_SCRIPT}
installAuthGuard(globalThis, () => location.reload(), "/v1/placement");
const UI = {
  fns: {},
  deactivators: [],
  active: null,
  register(id, activate, deactivate) {
    this.fns[id] = { activate, deactivate };
  },
  show(id, target) {
    if (id === this.active) return;
    while (this.deactivators.length) {
      const deactivate = this.deactivators.pop();
      if (deactivate) deactivate();
    }
    for (const s of document.querySelectorAll("section[data-tab]")) s.hidden = s !== target;
    for (const a of document.querySelectorAll("nav a[data-nav]")) a.classList.toggle("active", a.getAttribute("data-nav") === id);
    this.active = id;
    const next = this.fns[id];
    if (next) {
      if (next.deactivate) this.deactivators.push(next.deactivate);
      if (next.activate) next.activate();
    }
  },
};
</script>
</head>
<body>
<nav class="top">${top}<button id="signout" type="button">Sign out</button></nav>
<main>${sections}</main>
<nav class="bottom">${bottom}</nav>
<script>
const idFromHash = () => {
  const h = location.hash;
  if (!h.startsWith("#/")) return ${defaultId};
  let id = h.slice(2);
  for (const sep of ["/", "?", "#"]) {
    const i = id.indexOf(sep);
    if (i !== -1) id = id.slice(0, i);
  }
  return id || ${defaultId};
};
const showFromHash = () => {
  let id = idFromHash();
  let target = null;
  for (const s of document.querySelectorAll("section[data-tab]")) {
    if (s.getAttribute("data-tab") === id) { target = s; break; }
  }
  if (!target && id === "escalations") {
    for (const s of document.querySelectorAll("section[data-tab]")) {
      if (s.getAttribute("data-tab") === "inbox") { target = s; id = "inbox"; break; }
    }
  }
  UI.show(id, target);
};
document.getElementById("signout").addEventListener("click", () => {
  fetch("/ui/logout", { method: "POST" }).finally(() => location.reload());
});
addEventListener("hashchange", showFromHash);
showFromHash();
</script>
</body>
</html>
`;
}
