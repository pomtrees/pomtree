// The operator browser UI shell: a single document hosting the observe tab panes behind the hash
// router. No build step, no framework; every value that reaches the DOM is interpolated only
// through observe's escapeHtml/scriptJson or read from a form input.

import {
  renderAuditPane,
  renderHostsPane,
  renderInboxPane,
  renderNewAgentPane,
  renderReportsPane,
  renderSchedulesPane,
  renderShell,
  renderTerminalPane,
  renderTreePane,
} from "@pomtree/observe";
import type { UiTab } from "@pomtree/observe";

// Default lifetime of a UI session cookie (24h).
export const UI_COOKIE_TTL_MS = 24 * 60 * 60 * 1000;

// The operator UI shell: tree, reports, audit (journal), hosts (placement), terminal, and the inbox (messages and open requests).
// Each tab is a view the tiling shell can show in a tile (several at once); the tab order is the view selector order.
// The tree pane reuses the existing /live/events SSE path; the terminal view deep-links at #/terminal/<id>.
export function renderUiShell(): string {
  const tabs: UiTab[] = [
    { id: "tree", title: "Tree", render: () => renderTreePane({ eventsPath: "/live/events" }) },
    { id: "reports", title: "Reports", render: () => renderReportsPane() },
    { id: "audit", title: "Audit", render: () => renderAuditPane() },
    { id: "new", title: "+ New agent", render: () => renderNewAgentPane() },
    { id: "schedules", title: "Schedules", render: () => renderSchedulesPane() },
    { id: "hosts", title: "Hosts", render: () => renderHostsPane() },
    { id: "terminal", title: "Terminal", render: () => renderTerminalPane() },
    { id: "inbox", title: "Inbox", render: () => renderInboxPane() },
  ];
  return renderShell({ tabs, prefix: "/", title: "pomtree" });
}

// Login page served to browsers without a valid session. No token in the served HTML, no storage: the pasted token
// is POSTed as JSON to /ui/login and the HttpOnly cookie comes back; a bad token never echoes.
export function renderLoginPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pomtree: sign in</title>
<style>
  body { background: #111; color: #ddd; font: 13px/1.4 ui-monospace, monospace; margin: 0; display: flex; justify-content: center; padding-top: 12vh; }
  form { width: 28em; max-width: 90vw; }
  input, button { font: inherit; padding: 0.5em; margin: 0.3em 0; width: 100%; box-sizing: border-box; background: #181818; color: #ddd; border: 1px solid #333; }
  button { cursor: pointer; }
  #error { color: #e66; min-height: 1.4em; }
  p.hint { color: #888; }
</style>
</head>
<body>
<form id="login" autocomplete="off">
<h1>pomtree</h1>
<input id="token" name="token" type="password" placeholder="Paste your operator token" autocomplete="off" required autofocus>
<button type="submit">Sign in</button>
<div id="error" role="alert"></div>
<p class="hint">The token is in the operator.token file in the daemon state dir.</p>
</form>
<script>
const form = document.getElementById("login");
const input = document.getElementById("token");
const error = document.getElementById("error");
function signIn(token) {
  error.textContent = "";
  return fetch("/ui/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })
    .then((res) => {
      if (res.status === 200) { input.value = ""; location.reload(); return; }
      error.textContent = res.status === 401 || res.status === 403 ? "Invalid token" : "Sign-in failed (HTTP " + res.status + ")";
    })
    .catch(() => { error.textContent = "Sign-in failed (network error)"; });
}
form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  signIn(input.value.trim());
});
// One-click link: /ui#token=<operator token>. The fragment never reaches the server; strip it from the
// history entry first (synchronously), then sign in exactly like the form. Never stored or shown.
const m = /^#token=([^&]+)$/.exec(location.hash);
if (m) {
  let linkToken = "";
  try { linkToken = decodeURIComponent(m[1]); } catch (e) { linkToken = ""; }
  history.replaceState(null, "", location.pathname);
  if (linkToken) signIn(linkToken); else error.textContent = "Invalid token";
}
</script>
</body>
</html>
`;
}
