import { PANE_KIT_JS } from "./paneKit.ts";
import { MD_LOGIC_JS } from "./mdKit.ts";
import { scriptJson } from "./web.ts";
import { REPORT_DECLARATION } from "./viewMenus.ts";

// The "report" item view of the operator UI: one report per window, filling the whole window (the iframe or image
// takes the remaining height, a markdown or text body scrolls inside it). Registered with PaneKit.registerView as a
// multi-instance view with subject "report", so the shell opens it from #/report/<agent>/<id> and makes at most one
// window per (agent, report). It has no markup of its own; each mount builds its DOM inside the root it is given.
// Shipped alongside the Reports index (see renderReportsPane): a script only ships inside a tab section, and this
// view adds no nav tab. Report names and content are agent-controlled: names are textContent only; untrusted content
// never enters this document (active types go in an iframe with an EMPTY sandbox whose src is the locked /render
// endpoint, markdown goes through MdKit's textContent renderer, text is a <pre>). There is no scripts-enabled mode.
export function renderReportView(ctx: { agentsBase?: string } = {}): string {
  const base = scriptJson(ctx.agentsBase ?? "/v1/agents");
  return `<script>
(() => {
${PANE_KIT_JS}
${MD_LOGIC_JS}
const agentsBase = ${base};
const IMG = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const ACTIVE = ["text/html", "image/svg+xml", "application/xhtml+xml"];

const mountReportInstance = (root, params, hostApi) => {
  const agent = String(params && params.agent || "");
  const id = String(params && params.report || "");
  if (!agent || !id) throw new Error("the report view needs an agent id and a report id; open it from the Reports index or with #/report/<agent>/<id>");
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const link = (href, text, download) => {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    if (download) a.setAttribute("download", "");
    return a;
  };
  const note = (text) => el("p", "pane-empty", text);
  const base = agentsBase + "/" + encodeURIComponent(agent) + "/reports/" + encodeURIComponent(id);
  let active = true;
  const wrap = el("div", "report pane pane-fill");
  const body = el("div", "report-body");
  wrap.appendChild(body);
  root.appendChild(wrap);
  hostApi.setTitle("Report \u00b7 " + id.slice(0, 8));
  hostApi.setMenuState("report.view-source", { visible: false, enabled: false });
  hostApi.setMenuState("report.download", { enabled: false });
  // Download and View source work only once the report's metadata loaded; a failed load leaves them disabled.
  let loaded = false;
  const setLoaded = (on) => {
    loaded = on;
    hostApi.setMenuState("report.download", { enabled: on });
    hostApi.setMenuState("report.view-source", { enabled: on });
  };
  // The window menus drive the actions: Download hands the raw file to the browser, View source shows it as text.
  const showSource = () => {
    if (body.querySelector("pre")) return;
    fetch(base + "?raw=1").then(K.check).then((r) => r.text()).then((t) => {
      if (!active) return;
      const pre = document.createElement("pre");
      pre.textContent = t;
      body.appendChild(pre);
    }).catch((err) => { if (active) body.appendChild(note(K.errorMessage("source", err))); });
  };
  const COMMANDS = {
    "report.download": () => { if (!loaded) return; const a = link(base + "?raw=1", "Download", true); if (a.click) a.click(); },
    "report.view-source": () => { if (loaded) showSource(); },
    "report.sandbox": () => {},
  };
  hostApi.onCommand((command) => { if (active && Object.prototype.hasOwnProperty.call(COMMANDS, command)) COMMANDS[command](); });

  K.getJson(base).then((report) => {
    if (!active) return;
    setLoaded(true);
    hostApi.setTitle("Report \\u00b7 " + report.name);
    const type = String(report.mediaType).split(";")[0].trim().toLowerCase();
    const isActive = ACTIVE.includes(type);
    if (isActive || IMG.includes(type)) {
      hostApi.setStatus("sandbox", { text: "sandboxed", tone: "info" });
      let frame;
      if (isActive) {
        frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "");
        frame.setAttribute("referrerpolicy", "no-referrer");
        frame.setAttribute("title", report.name);
        frame.className = "report-frame";
      } else {
        frame = document.createElement("img");
        frame.setAttribute("alt", report.name);
        frame.className = "report-img";
      }
      frame.setAttribute("src", base + "/render");
      body.appendChild(frame);
      if (isActive) hostApi.setMenuState("report.view-source", { visible: true });
    } else if (type === "text/markdown" || type === "text/plain" || type === "application/json") {
      fetch(base + "?raw=1").then(K.check).then((r) => r.text()).then((t) => {
        if (!active) return;
        if (type === "text/markdown") { const md = document.createElement("div"); md.className = "md"; md.appendChild(Md.render(document, t)); body.appendChild(md); }
        else { const pre = document.createElement("pre"); pre.textContent = t; body.appendChild(pre); }
      }).catch((err) => { if (active) body.appendChild(note(K.errorMessage("report", err))); });
    } else {
      body.appendChild(note("This report type (" + report.mediaType + ") cannot be previewed; use Download."));
    }
  }).catch((err) => {
    if (!active) return;
    setLoaded(false);
    body.appendChild(note(err && err.status === 404 ? "This report is no longer available." : K.errorMessage("report", err)));
  });
  return { unmount() { active = false; root.replaceChildren(); } };
};
// A mount that throws after building markup would leave it in root, so setup failures clear root and rethrow for the
// host's failed-view placeholder.
const mountReport = (root, params, hostApi) => {
  try { return mountReportInstance(root, params, hostApi); }
  catch (e) { root.replaceChildren(); throw e; }
};

K.registerView({ id: "report", title: "Report", multi: true, subject: "report", menus: ${scriptJson(REPORT_DECLARATION.menus)}, status: ${scriptJson(REPORT_DECLARATION.status)}, mount: mountReport });
})();
</script>`;
}
