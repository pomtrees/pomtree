import { PANE_KIT_JS } from "./paneKit.ts";
import { MD_LOGIC_JS } from "./mdKit.ts";
import { UI_CSS } from "./shell.ts";
import type { AgentId, AgentRecord, JournalEntry, WaitCondition } from "@pomtree/core";
import { LiveView } from "./live.ts";
import { describeWait, formatAge, formatDeadline, formatRowCost, formatRowLeft } from "./render.ts";
import type { Row } from "./tree.ts";

// The page side of the SSE live view: pure mapping from tree rows to the SSE
// payloads and to the static page. The HTTP/SSE endpoint itself belongs to pomtreed.

// Display-ready row: the same columns the terminal renderer shows, pre-formatted
// so the page's inline script only paints text.
export interface DisplayRow {
  name: string;
  id: string;
  fullId: string; // untruncated agent id, for deep links (#/terminal/<fullId>)
  depth: number;
  state: string; // "exited:<exit>" once finished, like renderTree
  age: string;
  activity: string;
  tokens: number;
  cost: string;
  left: string;
  wait: string;
  host: string;
  deadline: string; // formatted remaining time ("expired" past due, "" none)
  lastTs: number | null; // ms ts of the newest journal entry (client ticks "last activity Ns ago")
  model: string;
  pendingReason?: string; // why a pending agent is queued (absent otherwise)
  waitingSince?: number; // running agent idle after a settled turn (absent otherwise); the row state stays running
}

export function displayRow(r: Row): DisplayRow {
  return {
    name: r.name,
    id: r.id.slice(0, 8),
    fullId: r.id,
    depth: r.depth,
    state: r.state === "exited" && r.exit ? `exited:${r.exit}` : r.state,
    age: formatAge(r.ageMs),
    activity: r.pendingReason ? `queued \u2014 ${r.pendingReason}` : r.waitingSince !== null ? "waiting" : (r.activity ?? ""),
    tokens: r.tokens,
    cost: formatRowCost(r),
    left: formatRowLeft(r),
    wait: r.wait ? describeWait(r.wait) : "",
    host: r.host,
    deadline: formatDeadline(r.deadlineAt, Date.now()),
    lastTs: r.lastTs,
    model: r.model,
    ...(r.pendingReason && { pendingReason: r.pendingReason }),
    ...(r.waitingSince !== null && { waitingSince: r.waitingSince }),
  };
}

export const displayRows = (rows: readonly Row[]): DisplayRow[] => rows.map(displayRow);

export interface SseFrame {
  event: string;
  data: string;
}

// Wire format: "event: <event>\ndata: <line>\n...\n\n"; multi-line data splits per the SSE spec.
export function encodeSseFrame(f: SseFrame): string {
  const data = f.data
    .split("\n")
    .map((l) => `data: ${l}`)
    .join("\n");
  return `event: ${f.event}\n${data}\n\n`;
}

// One full snapshot; the page replaces its table on each "rows" event.
export function snapshotFrame(rows: readonly Row[]): SseFrame {
  return { event: "rows", data: JSON.stringify(displayRows(rows)) };
}

export class LiveStream {
  readonly #view: LiveView;

  constructor(opts: { includeContent?: boolean } = {}) {
    this.#view = new LiveView(opts);
  }

  // Returns false for a duplicate delivery; the wiring skips the frame then.
  apply(e: JournalEntry): boolean {
    return this.#view.apply(e);
  }

  frame(agents: readonly AgentRecord[], opts: { now: number; waits?: ReadonlyMap<AgentId, WaitCondition> }): SseFrame {
    return snapshotFrame(this.#view.rows(agents, opts));
  }
}

// The static pages: fully inline, no build step, no framework. The script opens an
// EventSource (live) or fetches (reports) and re-renders the table; the endpoint path
// is relative so pomtreed can mount the pair under any prefix. Panes are the reusable
// table bodies; pages wrap a pane in a minimal standalone document.

// HTML-escape for attribute/text interpolation: untrusted ids and titles go through this.
// TODO(ui-xss): harden the UI against agent-controlled text. Current behavior: ids and titles pass through this escape.
// Client code sets text with textContent. Reopen if the UI is exposed beyond localhost.
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// JSON for embedding inside an inline <script>: `<` and the JS line separators are escaped.
export const scriptJson = (v: unknown) =>
  JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

export function renderTreePane(ctx: { eventsPath?: string } = {}): string {
  const events = scriptJson(ctx.eventsPath ?? "events");
  return `<div class="tree pane">
<div><a class="btn" href="#/new">+ New agent</a><span id="tree-conn" class="conn"></span></div>
<div class="tablewrap"><table>
<thead><tr><th>AGENT</th><th>ID</th><th>STATE</th><th>AGE</th><th>LAST</th><th>ACTIVITY</th><th>TOKENS</th><th>COST</th><th>LEFT</th><th>WAIT</th><th>HOST</th><th>DEADLINE</th></tr></thead>
<tbody id="tree-rows"></tbody>
</table></div>
</div>
<script>
(() => {
${PANE_KIT_JS}
const COLS = ["name", "id", "state", "age", "last", "activity", "tokens", "cost", "left", "wait", "host", "deadline"];
const tbody = document.getElementById("tree-rows");
const conn = document.getElementById("tree-conn");
let es = null;
let lasts = [];
const lastText = (r) => typeof r.lastTs === "number" ? K.age(Date.now() - r.lastTs) + " ago" : "";
let ticker = null;
const paint = (rows) => {
  lasts = [];
  if (rows.length === 0) {
    const row = K.messageRow(COLS.length, "empty", "No agents yet \u2014 start one with \`pomtree spawn --task \\"...\\"\` or ");
    const cta = document.createElement("a");
    cta.href = "#/new";
    cta.textContent = "spawn one here";
    row.children[0].appendChild(cta);
    tbody.replaceChildren(row);
    return;
  }
  tbody.replaceChildren(...rows.map((r) => {
    const tr = document.createElement("tr");
    const state = String(r.state).split(":")[0];
    tr.className = "s-" + state;
    for (const c of COLS) {
      const td = document.createElement("td");
      if (c === "name") {
        td.style.paddingLeft = (r.depth * 1.5) + "em";
        if (r.fullId) {
          const a = document.createElement("a");
          a.href = "#/terminal/" + encodeURIComponent(r.fullId);
          a.textContent = String(r.name);
          td.appendChild(a);
        } else td.textContent = String(r.name);
      } else if (c === "last") {
        td.textContent = lastText(r);
        lasts.push({ td, r });
      } else td.textContent = String(r[c]);
      if (c === "state") td.className = (String(r.state).endsWith(":failed") ? "state failed" : "state") + (state === "running" ? " live" : "");
      tr.appendChild(td);
    }
    return tr;
  }));
};
const open = () => {
  if (es) es.close();
  es = K.stream(${events}, { rows: (ev) => paint(JSON.parse(ev.data)) }, conn);
  if (ticker === null) ticker = setInterval(() => { for (const l of lasts) l.td.textContent = lastText(l.r); }, 1000);
};
const close = () => { if (es) { es.close(); es = null; } if (ticker !== null) { clearInterval(ticker); ticker = null; } };
K.onActivate("tree", open, close);
})();
</script>`;
}

export function renderReportsPane(ctx: { reportsPath?: string } = {}): string {
  const reports = scriptJson(ctx.reportsPath ?? "/v1/reports");
  return `<div class="reports pane">
<div id="reports-list">
<div class="tablewrap"><table>
<thead><tr><th>AGENT</th><th>NAME</th><th>TYPE</th><th>SIZE</th><th>AGE</th><th>ID</th><th></th></tr></thead>
<tbody id="reports-rows"></tbody>
</table></div>
</div>
<div id="reports-viewer" hidden></div>
</div>
<script>
(() => {
${PANE_KIT_JS}
${MD_LOGIC_JS}
const listEl = document.getElementById("reports-list");
const viewer = document.getElementById("reports-viewer");
const rawUrl = (agent, id) => "/v1/agents/" + encodeURIComponent(agent) + "/reports/" + encodeURIComponent(id);
// Hash route #/reports/<agent>/<id> opens the viewer; anything else shows the list.
const viewerRoute = (hash) => {
  const parts = hash.slice(1).split(/[?#]/)[0].split("/");
  if (hash.slice(0, 2) !== "#/" || parts.length < 3 || parts[1] !== "reports" || !parts[2] || !parts[3]) return null;
  try { return { agent: decodeURIComponent(parts[2]), id: decodeURIComponent(parts[3]) }; } catch (e) { return null; }
};
const IMG = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const ACTIVE = ["text/html", "image/svg+xml", "application/xhtml+xml"];
const link = (href, text, download) => {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = text;
  if (download) a.setAttribute("download", "");
  return a;
};
// Untrusted report content is never put in this document: active types go in an iframe with an EMPTY sandbox
// (opaque origin, no scripts/forms/popups/top-navigation) whose src is the locked /render endpoint;
// markdown goes through MdKit's createElement/textContent renderer; text is a <pre>. There is no scripts-enabled mode.
const openViewer = (route) => {
  const base = rawUrl(route.agent, route.id);
  viewer.replaceChildren();
  const back = link("#/reports", "\u2190 All reports");
  viewer.appendChild(back);
  const title = document.createElement("h2");
  title.textContent = "Report " + route.id;
  viewer.appendChild(title);
  const body = document.createElement("div");
  const actions = document.createElement("div");
  actions.className = "report-actions";
  const dl = link(base + "?raw=1", "Download", true);
  actions.appendChild(dl);
  const note = (text) => { const p = document.createElement("p"); p.className = "empty"; p.textContent = text; return p; };
  K.getJson(base).then((report) => {
    title.textContent = report.name;
    const type = String(report.mediaType).split(";")[0].trim().toLowerCase();
    const isActive = ACTIVE.includes(type);
    if (isActive || IMG.includes(type)) {
      const banner = document.createElement("div");
      banner.className = "report-banner";
      banner.setAttribute("role", "note");
      banner.appendChild(document.createTextNode("Rendered in a locked sandbox: scripts and network are disabled. "));
      banner.appendChild(actions);
      viewer.appendChild(banner);
      let frame;
      if (isActive) {
        frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "");
        frame.setAttribute("referrerpolicy", "no-referrer");
        frame.setAttribute("title", report.name);
        frame.style.cssText = "width:100%;height:70vh;border:1px solid var(--border);background:#fff";
      } else {
        frame = document.createElement("img");
        frame.setAttribute("alt", report.name);
        frame.style.maxWidth = "100%";
      }
      frame.setAttribute("src", base + "/render");
      body.appendChild(frame);
      if (isActive) {
        const src = document.createElement("a");
        src.href = "#";
        src.textContent = "View source";
        src.addEventListener("click", (ev) => {
          ev.preventDefault();
          if (body.querySelector("pre")) return;
          fetch(base + "?raw=1").then(K.check).then((r) => r.text()).then((t) => {
            const pre = document.createElement("pre");
            pre.textContent = t;
            body.appendChild(pre);
          }).catch((err) => body.appendChild(note(K.errorMessage("source", err))));
        });
        actions.appendChild(document.createTextNode(" \u00b7 "));
        actions.appendChild(src);
      }
    } else if (type === "text/markdown" || type === "text/plain" || type === "application/json") {
      viewer.appendChild(actions);
      fetch(base + "?raw=1").then(K.check).then((r) => r.text()).then((t) => {
        if (type === "text/markdown") { const md = document.createElement("div"); md.className = "md"; md.appendChild(Md.render(document, t)); body.appendChild(md); }
        else { const pre = document.createElement("pre"); pre.textContent = t; body.appendChild(pre); }
      }).catch((err) => body.appendChild(note(K.errorMessage("report", err))));
    } else {
      viewer.appendChild(actions);
      body.appendChild(note("This report type (" + report.mediaType + ") cannot be previewed; use Download."));
    }
    viewer.appendChild(body);
  }).catch((err) => viewer.appendChild(note(K.errorMessage("report", err))));
};
const route = () => {
  const r = viewerRoute(location.hash);
  listEl.hidden = r !== null;
  viewer.hidden = r === null;
  if (r) openViewer(r); else viewer.replaceChildren();
};
const tbody = document.getElementById("reports-rows");
const td = (text) => {
  const el = document.createElement("td");
  el.textContent = text;
  return el;
};
const fmtSize = (b) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = b, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? String(v) : (Number.isInteger(v) ? String(v) : v.toFixed(1))) + " " + units[i];
};
const fmtAge = (ms) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h" + String(m % 60).padStart(2, "0") + "m";
  return Math.floor(h / 24) + "d";
};
const empty = (cls, text) => {
  const tr = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 7;
  cell.className = cls;
  cell.textContent = text;
  tr.appendChild(cell);
  tbody.replaceChildren(tr);
};
const load = () => K.getJson(${reports}).then((rows) => {
  if (rows.length === 0) { empty("empty", "No reports published yet."); return; }
  tbody.replaceChildren(...rows.map(({ report, agent }) => {
    const tr = document.createElement("tr");
    tr.appendChild(td(agent));
    const nameTd = document.createElement("td");
    const a = document.createElement("a");
    a.href = "#/reports/" + encodeURIComponent(report.agent) + "/" + encodeURIComponent(report.id);
    a.textContent = report.name;
    nameTd.appendChild(a);
    tr.appendChild(nameTd);
    tr.appendChild(td(report.mediaType));
    tr.appendChild(td(fmtSize(report.sizeBytes)));
    tr.appendChild(td(fmtAge(Date.now() - report.createdAt)));
    tr.appendChild(td(report.id));
    const dlTd = document.createElement("td");
    dlTd.appendChild(link(rawUrl(report.agent, report.id) + "?raw=1", "download", true));
    tr.appendChild(dlTd);
    return tr;
  }));
}).catch((err) => empty("error", K.errorMessage("reports", err)));
K.onActivate("reports", () => { route(); load(); addEventListener("hashchange", route); }, () => removeEventListener("hashchange", route));
})();
</script>`;
}

export function renderLivePage(opts: { title?: string; eventsPath?: string } = {}): string {
  const title = escapeHtml(opts.title ?? "pomtree live");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>${UI_CSS}</style>
</head>
<body>
<main class="page">
<h1>${title}</h1>
${renderTreePane({ eventsPath: opts.eventsPath })}
</main>
</body>
</html>
`;
}

export function renderReportsPage(opts: { title?: string; reportsPath?: string } = {}): string {
  const title = escapeHtml(opts.title ?? "pomtree reports");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>${UI_CSS}</style>
</head>
<body>
<main class="page">
<h1>${title}</h1>
${renderReportsPane({ reportsPath: opts.reportsPath })}
</main>
</body>
</html>
`;
}
