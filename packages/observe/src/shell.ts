// A single-document shell hosting tab panes behind a hash router: fully inline,
// no build step, no framework. Tab fragments are trusted extension HTML and are
// inserted raw; untrusted titles and ids go through escapeHtml, and any ctx.path /
// ctx.href value embedded in inline <script> text must go through scriptJson.
import { MD_CSS } from "./mdKit.ts";
import { TERM_CSS } from "./termKit.ts";
import { TRACE_CSS } from "./traceKit.ts";
import { PANE_CSS } from "./paneKit.ts";
import { LAYOUT_LOGIC_JS } from "./layout.ts";
import { LAYOUT_CSS } from "./layoutCss.ts";
import { LAYOUT_SHELL_JS, LAYOUT_STORAGE_KEY } from "./layoutShell.ts";
import { LAUNCHER_LOGIC_JS } from "./launcherModel.ts";
import { LAUNCHER_CSS, LAUNCHER_PATHS, LAUNCHER_POLL_MS, LAUNCHER_SHELL_JS } from "./launcherShell.ts";
import { MENU_NAV_JS } from "./menuNav.ts";
import { WINDOW_CHROME_JS } from "./windowChrome.ts";
import { CHROME_CSS } from "./chromeCss.ts";
import { THEME_CSS } from "./themeCss.ts";
import { escapeHtml, scriptJson } from "./web.ts";

export interface UiTabCtx {
  path(p: string): string;
  href(route: string): string;
}

export interface UiTab {
  id: string;
  title: string;
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
    --bg: #050505; --surface: #0e0e0e; --surface-2: #161616; --hover: #221a12; --code-bg: #0a0a0a;
    --border: #2b2b2b; --border-strong: #606060;
    --text: #f2f2f2; --muted: #a6a6a6;
    --accent: #ff8c1a; --accent-hover: #ffa647; --accent-fg: #000000; --focus: rgb(255 140 26 / 0.4);
    --ok: #4ade80; --warn: #d6e84a; --err: #ff5c8a; --info: #4cc9d9;
    --shadow: 0 1px 2px rgb(0 0 0 / 0.6);
  }
}
html { font-size: clamp(100%, 0.875rem + 0.25vw, 1.25rem); -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 1rem/1.5 var(--sans); }
[hidden] { display: none !important; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
h1 { margin: 0 0 var(--gap); font-size: 1.5rem; line-height: 1.25; }
code, pre { font-family: var(--mono); }
main { box-sizing: border-box; width: min(100% - 2 * var(--pad), 80rem); margin: 0 auto; padding: var(--pad) 0; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}
${PANE_CSS}${MD_CSS}${TERM_CSS}${TRACE_CSS}${LAYOUT_CSS}${CHROME_CSS}${LAUNCHER_CSS}${THEME_CSS}`;

export function renderShell(opts: { tabs: readonly UiTab[]; prefix?: string; title?: string }): string {
  const title = escapeHtml(opts.title ?? "pomtree");
  const prefix = opts.prefix ?? "";

  const ctx: UiTabCtx = {
    path: (p) => (p.startsWith("/") ? prefix + p : prefix === "" ? p : `${prefix}/${p}`),
    href: (route) => `#${route}`,
  };

  const sections = opts.tabs.map((t) => `<section data-tab="${escapeHtml(t.id)}" hidden>${t.render(ctx)}</section>`).join("");

  const tabsMeta = scriptJson(opts.tabs.map((t) => ({ id: t.id, title: t.title })));

  const launcherCfg = scriptJson({ paths: LAUNCHER_PATHS, pollMs: LAUNCHER_POLL_MS });

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
// Several views can be active at once: each tile hosting a singleton view activates it, and closing or changing
// that tile deactivates it. A view registering after it was activated (a late script) is activated on registration.
const UI = {
  fns: {},
  live: {},
  register(id, activate, deactivate) {
    this.fns[id] = { activate, deactivate };
    if (this.live[id] && activate) activate();
  },
  activate(id) {
    if (this.live[id]) return;
    this.live[id] = true;
    const f = this.fns[id];
    if (f && f.activate) f.activate();
  },
  deactivate(id) {
    if (!this.live[id]) return;
    delete this.live[id];
    const f = this.fns[id];
    if (f && f.deactivate) f.deactivate();
  },
};
</script>
</head>
<body class="wm">
<header id="lb-bar" class="lb"></header>
<div id="wm-notices" class="wm-notices" aria-live="polite"></div>
<main class="wm"><div id="wm-root" class="wm-root"></div><div id="wm-stash" hidden>${sections}</div></main>
<script>
${LAYOUT_LOGIC_JS}
${MENU_NAV_JS}
${WINDOW_CHROME_JS}
${LAYOUT_SHELL_JS}
const wm = createWindowManager(${tabsMeta}, ${scriptJson(LAYOUT_STORAGE_KEY)});
</script>
<script>
${LAUNCHER_LOGIC_JS}
${LAUNCHER_SHELL_JS}
createLauncherBar(wm, ${launcherCfg});
</script>
</body>
</html>
`;
}
