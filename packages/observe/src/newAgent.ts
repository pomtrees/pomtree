// The "New agent" pane (#/new): a form that POSTs the operator spawn body to /v1/agents.
// Field names follow pomtreed api.ts's POST /v1/agents (and `pomtree spawn`): name?, task, idempotencyKey, template?,
// budgetMicros? (positive integer), deadlineMs? (>= 0; 0 = unlimited, operator-only), wrapupMs? (positive integer),
// model?, fork? (boolean), fromCommit?, sessionRef? (operator-only). Pure form logic lives in NEW_AGENT_LOGIC_JS (plain
// JS source, embedded in the pane and unit-tested under node:vm); the pane script only wires the DOM.
import { PANE_KIT_JS } from "./paneKit.ts";
import { scriptJson } from "./web.ts";

// Defines `N` = { validate(f), signature(f), body(f, key) } with f = { task, name, template, budget, model, deadline,
// wrapup, fork, fromCommit, sessionRef } (strings, except fork: boolean; budget is dollars, optional leading "$").
// validate -> { ok, errors: { field: message } }. A blank budget/deadline/wrapup is omitted from the body so the
// template's, then the daemon's, default applies.
// TODO(contract-drift): DURATION_RE and the budget grammar duplicate packages/pomtree/src/cli.ts (deadlineDuration) and ux.ts
// (parseBudgetFlag); observe cannot import pomtree (thin client, no cross-package dependency), so tabs.test.ts pins the copies
// against the CLI's accepted/rejected examples. Move both into one shared pure module in @pomtree/core when contracts are batched.
// No backticks or template interpolation: this is a TS template literal.
export const NEW_AGENT_LOGIC_JS = `
const N = (() => {
  const str = (v) => String(v == null ? "" : v).trim();
  // Dollars (the field is labelled USD), optionally "$"-prefixed as in the CLI's "$5"; unlike the CLI a bare number is dollars, not micros.
  const parseBudget = (raw) => {
    const s = str(raw);
    if (s === "") return { micros: undefined };
    const t = s.startsWith("$") ? s.slice(1) : s;
    const bad = { error: "budget must be a positive dollar amount like 5 or 0.50" };
    if (!/^(\\d+\\.?\\d*|\\.\\d+)$/.test(t)) return bad;
    const micros = Math.round(Number(t) * 1e6);
    if (micros < 1) return { error: "budget is too small (minimum $0.000001)" };
    if (!Number.isSafeInteger(micros)) return { error: "budget is out of range" };
    return { micros };
  };
  // A bare integer is milliseconds; suffixes ms, s, m, h. Same grammar as pomtree's --deadline/--wrapup.
  const DURATION_RE = /^(\\d+)(ms|s|m|h)?$/;
  const parseDuration = (raw, what, allowZero) => {
    const s = str(raw);
    if (s === "") return { ms: undefined };
    const m = DURATION_RE.exec(s);
    if (!m) return { error: what + " must be a duration such as 4h, 90m, 45s or 60000 (ms)" + (allowZero ? " (0 = unlimited)" : "") };
    const ms = Number(m[1]) * (m[2] === "h" ? 3600000 : m[2] === "m" ? 60000 : m[2] === "s" ? 1000 : 1);
    if (!Number.isSafeInteger(ms)) return { error: what + " is out of range" };
    if (ms === 0 && !allowZero) return { error: what + " must be positive" };
    return { ms };
  };
  const validate = (f) => {
    const errors = {};
    if (!str(f.task)) errors.task = "task is required";
    const b = parseBudget(f.budget);
    if (b.error) errors.budget = b.error;
    const d = parseDuration(f.deadline, "deadline", true);
    if (d.error) errors.deadline = d.error;
    const w = parseDuration(f.wrapup, "wrapup", false);
    if (w.error) errors.wrapup = w.error;
    return { ok: Object.keys(errors).length === 0, errors };
  };
  const body = (f, key) => {
    const out = { task: str(f.task), idempotencyKey: key };
    const name = str(f.name);
    if (name) out.name = name;
    const tpl = str(f.template);
    if (tpl) out.template = tpl;
    const b = parseBudget(f.budget);
    if (b.micros !== undefined) out.budgetMicros = b.micros;
    const d = parseDuration(f.deadline, "deadline", true);
    if (d.ms !== undefined) out.deadlineMs = d.ms;
    const w = parseDuration(f.wrapup, "wrapup", false);
    if (w.ms !== undefined) out.wrapupMs = w.ms;
    const mk = str(f.model);
    const slash = mk.indexOf("/");
    if (slash > 0 && slash < mk.length - 1) out.model = { provider: mk.slice(0, slash), id: mk.slice(slash + 1) };
    if (f.fork === true) out.fork = true;
    const fc = str(f.fromCommit);
    if (fc) out.fromCommit = fc;
    const sr = str(f.sessionRef);
    if (sr) out.sessionRef = sr;
    return out;
  };
  const money = (micros) => "$" + (micros / 1e6).toFixed(2);
  // Detail lines for a GET /v1/templates row: only fields that are present.
  const templateLines = (t) => {
    if (!t) return [];
    const out = [];
    if (t.model || t.provider) out.push("model: " + (t.provider && t.model ? t.provider + "/" + t.model : t.model || t.provider));
    if (t.egress && t.egress.kind) out.push("egress: " + t.egress.kind + (t.egress.kind === "allowlist" && Array.isArray(t.egress.hosts) ? " (" + t.egress.hosts.join(", ") + ")" : ""));
    if (t.allowlist) out.push("allowlist profile: " + t.allowlist);
    if (t.browser) out.push("browser: " + t.browser.maxSteps + " steps, " + t.browser.maxMs + " ms");
    if (typeof t.budgetMicros === "number") out.push("budget: " + money(t.budgetMicros) + " (used when the budget field is blank)");
    return out;
  };
  // A model is keyed "provider/id" (provider names contain no slash; ids may).
  const modelKey = (m) => m.provider + "/" + m.id;
  // Default selection: last-chosen (if still listed), else the catalog default, else the first entry.
  const pickModel = (data, stored) => {
    const list = data && Array.isArray(data.models) ? data.models : [];
    if (list.length === 0) return "";
    const keys = list.map(modelKey);
    if (stored && keys.includes(stored)) return stored;
    if (data.default && keys.includes(modelKey(data.default))) return modelKey(data.default);
    const flagged = list.find((m) => m.default);
    return modelKey(flagged || list[0]);
  };
  const modelHint = (data) => {
    if (!data || data.source === "pi") return "";
    if (data.source === "env") return "Pi's model list is unavailable (" + (data.reason || "unknown") + "); showing the configured model only";
    return "Model list unavailable (" + (data.reason || "unknown") + ")";
  };
  // Same signature => same request => a retry reuses the idempotency key.
  const signature = (f) => JSON.stringify(body(f, ""));
  // Server text is shown verbatim except control characters (made spaces) and outer whitespace; the DOM gets it via textContent, so markup stays inert.
  const clean = (s) => String(s).replace(/[\\u0000-\\u001f\\u007f]/g, " ").trim();
  const errorText = (status, payload) => {
    const msg = payload && typeof payload.error === "string" ? clean(payload.error) : "";
    if (status === 401) return "Not signed in \\u2014 reload to sign in";
    return "HTTP " + status + (msg ? ": " + msg : "");
  };
  const NO_DAEMON = "could not reach the daemon (check that it is running and reload)";
  // Why the template picker is absent or degraded: 400 = pomtreed has no templates directory; anything else is a real failure to surface.
  const templatesNotice = (status, payload) => status === 400
    ? { cls: "meta", text: "templates are not configured on this daemon (set POMTREED_TEMPLATES_DIR or place files in <state>/templates)" }
    : { cls: "err", text: "could not load templates: " + errorText(status, payload) };
  // A template's model as "provider/id", or "" when it names none.
  const templateModel = (t) => !t ? "" : t.provider && t.model ? t.provider + "/" + t.model : String(t.model || "");
  // First model option while a template is selected: sends no model, so the template's (else the daemon's) applies.
  const modelLead = (t) => !t ? null : templateModel(t) ? "(template's model: " + templateModel(t) + ")" : "(default)";
  // A remembered model must not silently override a template; it applies only with no template selected.
  const modelDefault = (data, stored, hasTemplate) => hasTemplate ? "" : pickModel(data, stored);
  const overrideHint = (t, key) => {
    const tm = templateModel(t);
    if (!tm || !key || key === tm || (!t.provider && key.endsWith("/" + tm))) return "";
    return "overrides the template's model";
  };
  return { validate, body, signature, clean, errorText, NO_DAEMON, templatesNotice, templateModel, modelLead, modelDefault, overrideHint, pickModel, modelHint, modelKey, templateLines };
})();
`;

export function renderNewAgentPane(ctx: { agentsPath?: string; templatesPath?: string; modelsPath?: string } = {}): string {
  const models = scriptJson(ctx.modelsPath ?? "/v1/models");
  const agents = scriptJson(ctx.agentsPath ?? "/v1/agents");
  const templates = scriptJson(ctx.templatesPath ?? "/v1/templates");
  return `<div class="newagent pane">
<div id="new-status" class="pane-notice" role="status"></div>
<div class="pane-form pane-body">
<div class="row">
  <div>
    <label for="new-task">Task *</label>
    <textarea id="new-task" placeholder="What should the agent do?"></textarea>
    <div id="new-task-err" class="err"></div>
  </div>
</div>
<div class="row">
  <div>
    <label for="new-name">Name (optional)</label>
    <input id="new-name" placeholder="agent">
  </div>
  <div id="new-template-wrap" hidden>
    <label for="new-template">Template (optional)</label>
    <select id="new-template"></select>
    <div id="new-template-detail" class="meta"></div>
    <div id="new-template-errors" class="err"></div>
  </div>
  <div id="new-model-wrap" hidden>
    <label for="new-model">Model</label>
    <select id="new-model"></select>
    <div id="new-model-hint" class="meta"></div>
    <div id="new-model-override" class="meta"></div>
  </div>
</div>
<div id="new-template-notice" class="meta"></div>
<div class="row">
  <div>
    <label for="new-budget">Budget (USD)</label>
    <input id="new-budget" placeholder="blank = the template's or default budget">
    <div class="meta">USD; the agent is stopped when spend exceeds this. Blank uses the template's budget, else the daemon default.</div>
    <div id="new-budget-err" class="err"></div>
  </div>
  <div>
    <label for="new-deadline">Deadline</label>
    <input id="new-deadline" placeholder="blank = default; e.g. 4h, 90m, 0 = unlimited">
    <div class="meta">Session limit as a duration (4h, 90m, 45s, or milliseconds); 0 = unlimited.</div>
    <div id="new-deadline-err" class="err"></div>
  </div>
</div>
<details id="new-advanced">
<summary>Advanced</summary>
<div class="row">
  <div>
    <label for="new-wrapup">Wrap-up time</label>
    <input id="new-wrapup" placeholder="blank = default; e.g. 45s">
    <div class="meta">Time allowed after the result to wrap up (positive duration).</div>
    <div id="new-wrapup-err" class="err"></div>
  </div>
  <div>
    <label for="new-fromcommit">From commit (optional)</label>
    <input id="new-fromcommit" placeholder="commit to start the agent's branch from">
  </div>
  <div>
    <label for="new-sessionref">Session reference (optional)</label>
    <input id="new-sessionref" placeholder="Pi session to inherit">
  </div>
</div>
<label><input type="checkbox" id="new-fork"> Fork (branch from the parent's latest session)</label>
</details>
<p><button id="new-submit" class="btn">Create agent</button></p>
</div>
</div>
<script>
(() => {
${PANE_KIT_JS}
${NEW_AGENT_LOGIC_JS}
const $ = (id) => document.getElementById(id);
const task = $("new-task"), nameEl = $("new-name"), budget = $("new-budget"), tplEl = $("new-template");
const tplWrap = $("new-template-wrap"), submit = $("new-submit"), status = $("new-status");
const modelEl = $("new-model"), modelWrap = $("new-model-wrap"), modelHint = $("new-model-hint"), modelOverride = $("new-model-override");
const deadlineEl = $("new-deadline"), wrapupEl = $("new-wrapup"), forkEl = $("new-fork");
const fromCommitEl = $("new-fromcommit"), sessionRefEl = $("new-sessionref"), tplDetail = $("new-template-detail");
const tplNotice = $("new-template-notice"), tplErrors = $("new-template-errors");
const form = () => ({
  task: task.value, name: nameEl.value, template: tplEl.value, budget: budget.value, model: modelEl.value,
  deadline: deadlineEl.value, wrapup: wrapupEl.value, fork: forkEl.checked === true, fromCommit: fromCommitEl.value, sessionRef: sessionRefEl.value,
});
const LAST = "pomtree.lastModel";
const readLast = () => { try { return localStorage.getItem(LAST) || ""; } catch (e) { return ""; } };
const writeLast = (v) => { try { if (v) localStorage.setItem(LAST, v); } catch (e) { /* benign UI pref */ } };
let modelData = null;
let tplRows = [];
const selectedTemplate = () => tplRows.find((t) => t.id === tplEl.value && typeof t.error !== "string");
const showOverride = () => { modelOverride.textContent = N.overrideHint(selectedTemplate(), modelEl.value); };
const renderModels = () => {
  const list = modelData && Array.isArray(modelData.models) ? modelData.models : [];
  if (list.length === 0) { modelEl.replaceChildren(); modelWrap.hidden = true; showOverride(); return; }
  const opts = list.map((m) => { const o = K.cell("option", m.label ? m.provider + " / " + m.label : m.provider + " / " + m.id); o.value = N.modelKey(m); return o; });
  const tpl = selectedTemplate();
  const lead = N.modelLead(tpl);
  if (lead) { const o = K.cell("option", lead); o.value = ""; opts.unshift(o); }
  modelEl.replaceChildren(...opts);
  modelEl.value = N.modelDefault(modelData, readLast(), !!tpl);
  modelHint.textContent = N.modelHint(modelData);
  modelWrap.hidden = false;
  showOverride();
};
modelEl.addEventListener("change", showOverride);
const loadModels = () => K.getJson(${models}).then((data) => { modelData = data; renderModels(); }).catch(() => { modelData = null; modelWrap.hidden = true; });
let lastSig = null;
let key = null;
let inflight = false;
const say = (cls, text) => K.notice(status, cls, text);
const showTemplate = () => {
  const lines = N.templateLines(selectedTemplate());
  tplDetail.replaceChildren(...lines.map((l) => K.cell("div", l)));
};
tplEl.addEventListener("change", () => { showTemplate(); renderModels(); });
const noTemplates = (notice) => {
  tplRows = []; tplWrap.hidden = true;
  tplNotice.className = notice ? notice.cls : "meta";
  tplNotice.textContent = notice ? notice.text : "";
  renderModels();
};
const loadTemplates = () => fetch(${templates}).then((res) => res.json().catch(() => null).then((payload) => {
  if (!res.ok) { noTemplates(N.templatesNotice(res.status, payload)); return; }
  if (!Array.isArray(payload) || payload.length === 0) { noTemplates(null); return; }
  tplRows = payload;
  tplNotice.textContent = "";
  const none = K.cell("option", "(default)");
  none.value = "";
  tplEl.replaceChildren(none, ...payload.map((t) => {
    const bad = typeof t.error === "string";
    const o = K.cell("option", bad ? t.id + " (invalid: see message)" : t.name ? t.id + " \\u2014 " + t.name : t.id);
    o.value = t.id;
    if (bad) o.disabled = true;
    return o;
  }));
  tplErrors.replaceChildren(...payload.filter((t) => typeof t.error === "string").map((t) => K.cell("div", t.id + ": " + N.clean(t.error))));
  tplWrap.hidden = false;
  showTemplate();
  renderModels();
})).catch(() => noTemplates({ cls: "err", text: "could not load templates: " + N.NO_DAEMON }));
submit.addEventListener("click", () => {
  if (inflight) return;
  const f = form();
  const v = N.validate(f);
  $("new-task-err").textContent = v.errors.task || "";
  $("new-budget-err").textContent = v.errors.budget || "";
  $("new-deadline-err").textContent = v.errors.deadline || "";
  $("new-wrapup-err").textContent = v.errors.wrapup || "";
  if (v.errors.wrapup) $("new-advanced").open = true;
  if (!v.ok) return;
  writeLast(f.model);
  const sig = N.signature(f);
  if (sig !== lastSig || key === null) { lastSig = sig; key = K.uuid(); }
  inflight = true;
  submit.disabled = true;
  say("meta", "creating\\u2026");
  fetch(${agents}, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(N.body(f, key)),
  }).then((res) => res.json().catch(() => null).then((payload) => {
    if (!res.ok) { say("err", N.errorText(res.status, payload)); return; }
    say("meta", "Created " + payload.id);
    lastSig = null; key = null;
    task.value = "";
    location.hash = "#/terminal/" + encodeURIComponent(payload.id);
  })).catch(() => say("err", "Failed to create agent: " + N.NO_DAEMON)).then(() => {
    inflight = false;
    submit.disabled = false;
  });
});
K.onActivate("new", () => { say("meta", ""); loadTemplates(); loadModels(); });
})();
</script>`;
}
