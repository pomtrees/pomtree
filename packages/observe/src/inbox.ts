// The operator's inbox for root's passthrough: a mobile-first single-column card list.
// Server contract (pomtreed, operator-cookie authenticated):
//   GET  <messagesPath>?from=<seq>   SSE; frames carry `id: <seq>` and data
//        { seq, agent, channel, purpose, subject, replyTo?, createdAt } for `message_sent` on channel `ui`.
//        EventSource resumes via Last-Event-ID itself. Full loads replay from zero because cards
//        live only in memory; a persisted cursor would skip the cards it no longer has.
//   GET  <approvalsPath>?state=pending   JSON [{ id, requester, kind, requestedMicros? (budget_raise only), summary, rung, deadlineAt }], polled every 5s while active.
//   GET  <escalationsPath>?state=open   JSON open asks, authoritative over replayed ask messages.
//   POST <escalationsPath>/<id>/answer|pass   operator actions for authoritative asks, independent of channel configuration.
//   POST <replyPath>  { replyTo, body? | decision?: "approve"|"deny"|"pass", idempotencyKey }
//        with header X-Pomtree-UI: 1. Answers with the receipt/record, or an "already handled" receipt
//        ({ alreadyHandled: true } or a rejection whose reason says already answered/handled/decided,
//        also on HTTP 409) which is shown as "already handled", not as an error.
// Asks (purpose ask) and pending approvals are pinned on top; the rest is newest-first and read-only
// with a client-side dismiss. Agent-influenced text (subject, summary, agent ids) is painted only via
// textContent; ids are opaque data kept in memory and checked against the loaded list (never put in
// selectors or HTML); nothing is autolinked. Deep link: #/inbox/<id> scrolls to and highlights the card
// whose replyTo (escalation) or approval id matches.
// The script is a static asset (INBOX_JS, served by pomtreed at /ui/inbox.js under script-src 'self'); the pane
// markup carries only a JSON config block, so the Inbox needs no inline script.
// Compose row: POST <replyPath> { to, body, idempotencyKey } (no replyTo) with X-Pomtree-UI: 1 sends a free-text message
// to any agent (201 { kind: signaled, to } or { kind: rejected, reason }; HTTP errors are { error }); the agent-id datalist is filled from GET <agentsPath>.

import { PANE_KIT_JS } from "./paneKit.ts";
import { INBOX_DECLARATION } from "./viewMenus.ts";
import { scriptJson } from "./web.ts";

export const INBOX_CSS = `
.pane #inbox { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--gap); }
.pane #inbox li { padding: var(--gap); background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--border-strong); border-radius: var(--radius); box-shadow: var(--shadow); }
.pane #inbox li.p-ask, .pane #inbox li.p-approval { border-left-color: var(--warn); }
.pane #inbox li.p-alert { border-left-color: var(--err); }
.pane #inbox li.hl { outline: 2px solid var(--accent); outline-offset: 2px; }
.pane #inbox li > * + * { margin-top: 0.5rem; }
.pane #inbox .head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.pane #inbox .badge { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.0625rem 0.5rem; border: 1px solid var(--border-strong); border-radius: 999px; color: var(--muted); }
.pane #inbox .subject { white-space: pre-wrap; overflow-wrap: anywhere; }
.pane #inbox .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.pane #inbox .actions input { flex: 1 1 12rem; }
.pane #inbox .actions.big button { flex: 1 1 6rem; min-height: 3rem; font-size: 1rem; }
.pane .compose { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0 0 var(--gap); }
.pane .compose input { flex: 1 1 10rem; }
.pane .compose textarea { flex: 1 1 100%; resize: vertical; font: inherit; }
.pane .compose button { flex: 0 0 auto; min-height: 2.75rem; }
.pane #inbox-status { position: sticky; top: 3.25rem; z-index: 5; }
.pane #inbox-status:not(:empty) { padding: 0.5rem 0.75rem; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); }
`;

/** The Inbox pane's browser script, served as a static asset at INBOX_SCRIPT_URL (config is read from the #inbox-config JSON block). */
export const INBOX_JS = `(() => {
${PANE_KIT_JS}
const cfg = JSON.parse(document.getElementById("inbox-config").textContent);
const list = document.getElementById("inbox");
const status = document.getElementById("inbox-status");
const MAX_MESSAGES = 200;
const items = new Map(); // key -> { key, kind, id, replyTo, purpose, agent, subject, createdAt, deadlineAt, seq, el, ageEl, busy, pending }
let active = false;
let lastApprovals = [];
let lastEscalations = null;
let lastSeq = 0;
let filter = "all"; // the View menu's "Show" radio; per page load, never persisted

// The Inbox is a section view: PaneKit keeps one window model for it and the tile chrome renders its menu and footer.
K.declareSection(${scriptJson(INBOX_DECLARATION)});
const win = K.sectionHost("inbox");
const FILTERS = { all: "All", message: "User messages", escalation: "Escalations", approval: "Approvals" };

const say = (text, bad) => { status.className = bad ? "err" : "meta"; status.textContent = text; };

const pinned = (it) => it.kind === "approval" || it.purpose === "ask";
const rank = (a, b) => {
  if (pinned(a) !== pinned(b)) return pinned(a) ? -1 : 1;
  if (a.kind !== b.kind && (a.kind === "approval" || b.kind === "approval")) return a.kind === "approval" ? -1 : 1;
  if (a.kind === "approval") return (a.deadlineAt || 0) - (b.deadlineAt || 0);
  return (b.createdAt || 0) - (a.createdAt || 0) || (b.seq || 0) - (a.seq || 0);
};

const dollars = (micros) => "$" + (micros / 1e6).toFixed(Math.round(micros / 1e4) * 1e4 === micros ? 2 : 4);

const dueText = (it) => it.deadlineAt ? "due in " + K.age(Math.max(0, it.deadlineAt - Date.now())) : "";

const forget = (it) => { it.el.remove(); items.delete(it.key); };

// POST one reply. The idempotency key is issued once per distinct payload and reused if the same click is retried.
const send = (it, fields) => {
  if (it.busy) return;
  const sig = JSON.stringify(fields);
  if (!it.pending || it.pending.sig !== sig) it.pending = { sig, key: K.uuid() };
  it.busy = true;
  setBusy(it, true);
  say("Sending\\u2026", false);
  const operatorAsk = it.kind === "escalation";
  const url = operatorAsk ? cfg.escalations + "/" + encodeURIComponent(it.id) + (fields.decision === "pass" ? "/pass" : "/answer") : cfg.reply;
  const payload = operatorAsk ? (fields.decision === "pass" ? {} : { body: fields.body }) : Object.assign({ replyTo: it.id }, fields);
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pomtree-UI": "1" },
    body: JSON.stringify(Object.assign(payload, { idempotencyKey: it.pending.key })),
  }).then((res) => res.json().catch(() => ({})).then((rec) => ({ res, rec }))).then(({ res, rec }) => {
    const reason = rec && typeof rec.reason === "string" ? rec.reason : "";
    if ((rec && rec.alreadyHandled === true) || /already (answered|handled|decided)/i.test(reason)) {
      forget(it); say("Already handled", false); return;
    }
    if (!res.ok) throw Object.assign(new Error("HTTP " + res.status), { status: res.status });
    if (rec && rec.kind === "rejected") throw new Error(reason || "Reply rejected");
    if (operatorAsk && rec.state === "open") {
      it.holder = rec.holder;
      it.busy = false;
      it.pending = null;
      setBusy(it, false);
      say("", false);
      render();
      return;
    }
    forget(it); say(items.size === 0 ? "Inbox empty" : "", false);
  }).catch((err) => {
    it.busy = false;
    setBusy(it, false);
    say((err && err.status === 401) ? K.errorMessage("", err) : "Failed to send: " + String(err), true);
  });
};

const setBusy = (it, busy) => { for (const b of it.buttons) b.disabled = busy || (it.kind === "escalation" && it.holder === null && b.textContent === "Pass"); if (it.input) it.input.disabled = busy; };

const build = (it) => {
  const li = document.createElement("li");
  li.className = "p-" + (it.kind === "approval" ? "approval" : it.purpose);
  const head = document.createElement("div");
  head.className = "head";
  head.appendChild(K.cell("span", it.kind === "approval" ? "approval" : it.purpose, "badge"));
  head.appendChild(K.cell("span", it.agent, "meta"));
  it.ageEl = K.cell("span", "", "meta");
  head.appendChild(it.ageEl);
  li.appendChild(head);
  const raise = it.kind === "approval" && it.actionKind === "budget_raise" && typeof it.requestedMicros === "number" && it.requestedMicros > 0;
  li.appendChild(K.cell("div", raise ? it.agent + " is out of budget" : it.subject, "subject"));
  if (raise) li.appendChild(K.cell("div", "Requested " + dollars(it.requestedMicros), "meta"));
  if (it.options && it.options.length) li.appendChild(K.cell("div", it.options.join(" / "), "meta"));
  it.buttons = [];
  it.input = null;
  const row = document.createElement("div");
  const act = (label, cls, fn) => { const b = K.cell("button", label, cls); b.addEventListener("click", fn); it.buttons.push(b); row.appendChild(b); return b; };
  if (it.kind === "approval") {
    row.className = "actions big";
    act(raise ? "Approve +" + dollars(it.requestedMicros) : "Approve", "btn", () => send(it, { decision: "approve" }));
    act("Deny", "", () => send(it, { decision: "deny" }));
    act("Pass", "", () => send(it, { decision: "pass" }));
  } else if (it.purpose === "ask" && it.replyTo) {
    row.className = "actions";
    const input = document.createElement("input");
    input.placeholder = "answer";
    it.input = input;
    row.appendChild(input);
    act("Send", "btn", () => { if (input.value) send(it, { body: input.value }); });
    if (it.holder !== null) act("Pass", "", () => send(it, { decision: "pass" }));
  } else {
    row.className = "actions";
    act("Dismiss", "", () => { forget(it); say(items.size === 0 ? "Inbox empty" : "", false); });
  }
  li.appendChild(row);
  it.el = li;
};

const deepLink = () => {
  const m = /^#\\/(?:inbox|escalations)\\/([^/?#]+)/.exec(location.hash || "");
  for (const it of items.values()) it.el.className = it.el.className.replace(" hl", "");
  if (!m) return;
  let id = m[1];
  try { id = decodeURIComponent(id); } catch (e) { return; }
  for (const it of items.values()) {
    if (it.id !== id) continue;
    it.el.className += " hl";
    if (it.el.scrollIntoView) it.el.scrollIntoView({ block: "center" });
    return;
  }
};

// Cards that wait for the operator's answer: approvals and asks (escalations).
const paintPending = () => {
  let n = 0;
  for (const it of items.values()) if (it.kind === "approval" || it.purpose === "ask") n++;
  win.setStatus("pending", n > 0 ? { text: n + " pending", tone: "warn" } : { text: "" });
};

const emptyFilterLine = () => {
  const li = document.createElement("li");
  li.className = "meta";
  li.textContent = "No " + FILTERS[filter] + " cards. Choose View \\u203a Show \\u203a All to see every card.";
  return li;
};

const render = () => {
  const sorted = [...items.values()].sort(rank);
  for (const it of sorted) {
    it.ageEl.textContent = it.kind === "approval" ? dueText(it) : K.age(Date.now() - it.createdAt);
  }
  const shown = filter === "all" ? sorted : sorted.filter((it) => it.kind === filter);
  list.replaceChildren(...(shown.length === 0 && filter !== "all" ? [emptyFilterLine()] : shown.map((it) => it.el)));
  paintPending();
  if (items.size > 0 && status.textContent === "Inbox empty") say("", false);
  if (items.size === 0 && !status.textContent) say("Inbox empty", false);
  deepLink();
};

const addMessage = (m) => {
  const key = "m:" + m.seq;
  if (items.has(key)) return;
  const it = { key, kind: "message", id: m.replyTo == null ? null : String(m.replyTo), replyTo: m.replyTo == null ? null : String(m.replyTo),
    purpose: String(m.purpose || "status"), agent: m.agent, subject: m.subject, createdAt: m.createdAt, seq: m.seq, busy: false, pending: null };
  if (it.purpose === "ask" && it.replyTo && lastApprovals.some((a) => a.id === it.replyTo)) return; // the approval card covers it
  if (it.purpose === "ask" && it.replyTo) {
    if (lastEscalations !== null) return; // authoritative open asks are added by the poller
    if ([...items.values()].some((x) => x.purpose === "ask" && x.replyTo === it.replyTo)) return;
  }
  build(it);
  items.set(key, it);
  let msgs = [...items.values()].filter((x) => x.kind === "message").sort(rank);
  for (const old of msgs.slice(MAX_MESSAGES)) if (!pinned(old)) forget(old);
};

const refreshApprovals = () => K.getJson(cfg.approvals + "?state=pending").then((rows) => {
  lastApprovals = rows;
  const ids = new Set(rows.map((a) => a.id));
  for (const it of [...items.values()]) if (it.kind === "approval" && !ids.has(it.id)) forget(it);
  for (const a of rows) {
    const key = "a:" + a.id;
    for (const it of [...items.values()]) if (it.kind !== "approval" && it.replyTo === a.id) forget(it);
    const known = items.get(key);
    if (known) { known.deadlineAt = a.deadlineAt; continue; }
    const it = { key, kind: "approval", id: a.id, replyTo: a.id, purpose: "approval", agent: a.requester,
      subject: a.summary, actionKind: a.kind, requestedMicros: a.requestedMicros, deadlineAt: a.deadlineAt, createdAt: 0, seq: 0, busy: false, pending: null };
    build(it);
    items.set(key, it);
    }
  if (status.className === "err" && /^Failed to load approvals/.test(status.textContent)) say("", false);
  render();
}).catch((err) => say(K.errorMessage("approvals", err), true));

const refreshEscalations = () => K.getJson(cfg.escalations + "?state=open").then((rows) => {
  lastEscalations = rows;
  const ids = new Set(rows.map((e) => e.id));
  for (const it of [...items.values()]) {
    if (it.purpose === "ask" && it.replyTo && !ids.has(it.replyTo)) forget(it);
  }
  for (const e of rows) {
    if (lastApprovals.some((a) => a.id === e.id)) continue;
    const known = [...items.values()].find((it) => it.purpose === "ask" && it.replyTo === e.id);
    if (known) {
      if (known.kind !== "escalation") {
        known.kind = "escalation";
        if (e.options && e.options.length) known.el.appendChild(K.cell("div", e.options.join(" / "), "meta"));
      }
      known.holder = e.holder;
      const pass = known.buttons.find((b) => b.textContent === "Pass");
      if (pass) pass.disabled = known.busy || e.holder === null;
      continue; // preserve a draft and in-flight reply
    }
    const key = "e:" + e.id;
    const it = { key, kind: "escalation", id: e.id, replyTo: e.id, purpose: "ask", agent: e.agent,
      subject: e.question, options: e.options, holder: e.holder, createdAt: e.createdAt, seq: 0, busy: false, pending: null };
    build(it);
    items.set(key, it);
    }
  if (status.className === "err" && /^Failed to load escalations/.test(status.textContent)) say("", false);
  render();
}).catch((err) => say(K.errorMessage("escalations", err), true));

let refreshing = null;
let refreshAgain = false;
const refresh = () => {
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = Promise.all([refreshApprovals(), refreshEscalations()]).finally(() => {
    refreshing = null;
    if (refreshAgain) { refreshAgain = false; refresh(); }
  });
  return refreshing;
};

// Compose: a free-text message to any agent. The key is issued once per distinct (to, body) and reused if the same send is retried.
const composeForm = document.getElementById("inbox-compose");
const toInput = document.getElementById("inbox-to");
const bodyInput = document.getElementById("inbox-body");
const sendBtn = document.getElementById("inbox-send");
const agentList = document.getElementById("inbox-agents");
let composePending = null;
let composeBusy = false;

const compose = () => {
  if (composeBusy) return;
  const to = toInput.value.trim();
  const body = bodyInput.value;
  if (!to || !body.trim()) { say("Enter an agent id and a message", true); return; }
  const sig = JSON.stringify([to, body]);
  if (!composePending || composePending.sig !== sig) composePending = { sig, key: K.uuid() };
  composeBusy = true;
  sendBtn.disabled = true;
  say("Sending\\u2026", false);
  fetch(cfg.reply, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pomtree-UI": "1" },
    body: JSON.stringify({ to, body, idempotencyKey: composePending.key }),
  }).then((res) => res.json().catch(() => ({})).then((rec) => ({ res, rec }))).then(({ res, rec }) => {
    if (!res.ok) {
      const why = rec && typeof rec.error === "string" ? rec.error : "HTTP " + res.status;
      throw Object.assign(new Error(why), { status: res.status });
    }
    if (rec && rec.kind === "rejected") { say("Not sent: " + (typeof rec.reason === "string" ? rec.reason : "rejected"), true); return; }
    composePending = null;
    bodyInput.value = "";
    say("Message to " + to, false);
  }).catch((err) => {
    say((err && err.status === 401) ? K.errorMessage("", err) : "Failed to send: " + String((err && err.message) || err), true);
  }).finally(() => { composeBusy = false; sendBtn.disabled = false; });
};
composeForm.addEventListener("submit", (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); compose(); });

const refreshAgents = () => K.getJson(cfg.agents).then((rows) => {
  const opts = [];
  for (const a of rows) {
    if (!a || typeof a.id !== "string" || a.state === "reaped") continue;
    const o = document.createElement("option");
    o.value = a.id;
    o.textContent = typeof a.name === "string" ? a.name : "";
    opts.push(o);
  }
  agentList.replaceChildren(...opts);
}).catch(() => {}); // autocomplete is a convenience; the input still takes a typed id

const base = cfg.messages;
let retryMs = 2000;
const open = () => {
  const es = new EventSource(base + "?from=" + encodeURIComponent(String(lastSeq)));
  const badge = document.createElement("span");
  es.onopen = () => { retryMs = 2000; K.setConn(badge, true); if (status.className === "err" && /^(Stream|Inbox stream)/.test(status.textContent)) say("", false); };
  // TODO(inbox-stream-cause): the cause of the "Stream interrupted / reconnecting" notice is unconfirmed; the suspects are a 401, a 503 from the 64-stream SSE cap (MAX_SSE_STREAMS in packages/pomtreed/src/server.ts; each tab holds two streams) and a server close. Nobody has checked /live/messages in devtools. Trigger: the operator sees the notice again; first read the status and the close in the Network tab.
  es.onerror = () => {
    K.setConn(badge, false);
    if (es.readyState === 2) {
      // CLOSED for good (the browser will not retry itself): say so, and reopen on a capped backoff.
      say("Inbox stream closed (the server refused it, e.g. sign-in expired or too many streams) \\u2014 reload the page", true);
      es.close();
      const wait = retryMs;
      retryMs = Math.min(retryMs * 2, 30000);
      setTimeout(open, wait);
    } else say("Stream interrupted \\u2014 reconnecting", true);
  };
  es.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || typeof m.seq !== "number" || m.channel !== "ui") return;
    addMessage(m);
    if (m.purpose === "ask" && m.replyTo) refresh();
    if (m.seq > lastSeq) lastSeq = m.seq;
    render();
  };
};
open();

win.onCommand((command, arg) => {
  if (command === "inbox.filter") {
    if (typeof arg !== "string" || !Object.prototype.hasOwnProperty.call(FILTERS, arg)) return;
    filter = arg;
    render();
  } else if (command === "inbox.about") {
    say("The Inbox lists agent messages, escalations and approvals for you. Approvals and asks stay on top until answered; other messages can be dismissed.", false);
  }
});

const poller = K.poll(refresh, 5000);
K.onActivate("inbox", () => { active = true; poller.start(); refreshAgents(); render(); }, () => { active = false; poller.stop(); });
addEventListener("hashchange", deepLink);
})();`;

export const INBOX_SCRIPT_URL = "/ui/inbox.js";

export function renderInboxPane(
  ctx: { messagesPath?: string; approvalsPath?: string; escalationsPath?: string; replyPath?: string; agentsPath?: string } = {},
): string {
  const cfg = scriptJson({
    messages: ctx.messagesPath ?? "/live/messages",
    approvals: ctx.approvalsPath ?? "/v1/approvals",
    escalations: ctx.escalationsPath ?? "/v1/escalations",
    reply: ctx.replyPath ?? "/v1/ui/reply",
    agents: ctx.agentsPath ?? "/v1/agents",
  });
  return `<div class="inbox pane">
<style>${INBOX_CSS}</style>
<div id="inbox-status" class="meta" role="status"></div>
<form id="inbox-compose" class="compose" autocomplete="off">
<input id="inbox-to" list="inbox-agents" placeholder="agent id" aria-label="Agent id">
<datalist id="inbox-agents"></datalist>
<textarea id="inbox-body" rows="2" maxlength="4000" placeholder="Message an agent" aria-label="Message"></textarea>
<button id="inbox-send" class="btn" type="submit">Send</button>
</form>
<ul id="inbox"></ul>
</div>
<script type="application/json" id="inbox-config">${cfg}</script>
<script src="${INBOX_SCRIPT_URL}"></script>`;
}
