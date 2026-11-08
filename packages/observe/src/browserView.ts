import { PANE_KIT_JS } from "./paneKit.ts";
import { TERM_LOGIC_JS } from "./termKit.ts";
import { scriptJson } from "./web.ts";
import { BROWSER_DECLARATION } from "./viewMenus.ts";

// The read-only "browser" view of the operator UI: a live JPEG screencast of the agent's Chromium, streamed by
// pomtreed over GET /v1/agents/:id/browser (websocket). Wire protocol, server to client only: a binary message is
// one complete JPEG; a text message is JSON, either {"type":"status","state":"connecting"|"live"|"no-browser",
// "url"?,"title"?,"width"?,"height"?} or {"type":"closed","reason":"ended"|"local"|"error"}. The view never sends
// anything (the daemon closes the socket with 1008 on any client data message).
// Everything the page shows (url, title) is controlled by the agent: it is rendered as textContent only, and the
// tile carries a fixed note saying so. Frames are decoded with createImageBitmap from a Blob (no blob: image URL, so
// the CSP is unchanged) and drawn on a canvas scaled to fit; while a decode is in flight only the newest frame waits.
// Reconnect reuses TermKit's backoff and stop/retry decision. This is the thin DOM/WebSocket glue plus BrowserKit,
// the pure logic (tested in browserView.test.ts). Plain JS, no backticks and no template interpolation in the
// shipped text: it is a String.raw literal.

// Route template of the browser websocket; ":id" is the agent id (same shape as TERMINAL_WS_PATH).
export const BROWSER_WS_PATH = "/v1/agents/:id/browser";

export const BROWSER_LOGIC_JS = String.raw`
const BrowserKit = globalThis.BrowserKit || (globalThis.BrowserKit = (() => {
  const STATES = ["connecting", "live", "no-browser"];
  const REASONS = ["ended", "local", "error"];
  const MAX_TEXT = 4096; // the daemon never sends more
  const MAX_FIELD = 512;
  const MAX_DIM = 16384;
  const clean = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, MAX_FIELD);

  // Server text message -> { type: "status", state, url?, title?, width?, height? } | { type: "closed", reason } |
  // null. Only the documented shapes are accepted: an unknown type, state or reason, a non-object or an oversize
  // message is ignored; an optional field of the wrong type is dropped, not trusted.
  const parseServerText = (s) => {
    if (typeof s !== "string" || s.length > MAX_TEXT) return null;
    let o;
    try { o = JSON.parse(s); } catch (e) { return null; }
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    if (o.type === "closed") return REASONS.indexOf(o.reason) >= 0 ? { type: "closed", reason: o.reason } : null;
    if (o.type !== "status" || STATES.indexOf(o.state) < 0) return null;
    const m = { type: "status", state: o.state };
    if (typeof o.url === "string") m.url = clean(o.url);
    if (typeof o.title === "string") m.title = clean(o.title);
    const dim = (n) => typeof n === "number" && Math.floor(n) === n && n >= 1 && n <= MAX_DIM;
    if (dim(o.width) && dim(o.height)) { m.width = o.width; m.height = o.height; }
    return m;
  };

  // Largest rectangle with the source aspect that fits the box, centred; null when any size is unusable.
  const fitRect = (srcW, srcH, boxW, boxH) => {
    const ok = (n) => typeof n === "number" && isFinite(n) && n > 0;
    if (!ok(srcW) || !ok(srcH) || !ok(boxW) || !ok(boxH)) return null;
    const scale = Math.min(boxW / srcW, boxH / srcH);
    const w = srcW * scale;
    const h = srcH * scale;
    return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
  };

  // Frame-drop policy: one decode at a time; a frame arriving mid-decode replaces the pending one (newest wins).
  // offer(frame) -> the frame to decode now, or null when it was queued; done() -> the pending frame to decode
  // next, or null. reset() forgets everything (new connection or unmount).
  const frameGate = () => {
    let busy = false;
    let pending = null;
    return {
      offer(frame) {
        if (busy) { pending = frame; return null; }
        busy = true;
        return frame;
      },
      done() {
        const next = pending;
        pending = null;
        busy = next !== null;
        return next;
      },
      reset() { busy = false; pending = null; },
    };
  };

  // Status line text for a daemon status state.
  const stateLabel = (state) => state === "live" ? "live" : state === "no-browser" ? "no browser running" : "connecting";
  // Status line text for a closed message (an earlier connection's reason).
  const closedLabel = (reason) => reason === "ended" ? "ended" : reason === "local" ? "daemon shut down" : "stream error";
  // Status line text for a TermKit.decide stop. TermKit words some stops for the terminal; this view says "browser".
  const stopLabel = (d) => {
    if (d.conn === "no agent") return "agent not found";
    if (d.conn === "yielded" || d.conn === "frozen") return "no browser: agent is waiting";
    if (d.conn === "no terminal") return "ended";
    return d.label;
  };

  // How to paint a decoded frame in a view mode. "fit": the canvas fills the box and the frame is the largest
  // aspect-preserving rectangle in it. "actual": the canvas takes the frame's natural pixel size (the pane scrolls)
  // and the frame is drawn at 1:1. Returns { canvasW, canvasH, rect } or null when a size is unusable.
  const drawPlan = (mode, srcW, srcH, boxW, boxH) => {
    const ok = (n) => typeof n === "number" && isFinite(n) && n > 0;
    if (!ok(srcW) || !ok(srcH)) return null;
    if (mode === "actual") return { canvasW: srcW, canvasH: srcH, rect: { x: 0, y: 0, w: srcW, h: srcH } };
    const rect = fitRect(srcW, srcH, boxW, boxH);
    return rect ? { canvasW: boxW, canvasH: boxH, rect } : null;
  };

  return { STATES, REASONS, parseServerText, fitRect, drawPlan, frameGate, stateLabel, closedLabel, stopLabel };
})());
`;

// The browser view script: registers the multi-instance "browser" view (PaneKit.registerView). It has no markup of
// its own; each mount builds its DOM from scratch inside the root it is given. Shipped alongside the terminal
// pane's section (see renderUiShell): a script only ships inside a tab section, and this view adds no nav tab.
export function renderBrowserView(ctx: { agentsBase?: string; browserPath?: string } = {}): string {
  const base = scriptJson(ctx.agentsBase ?? "/v1/agents");
  const wsPath = scriptJson(ctx.browserPath ?? BROWSER_WS_PATH);
  return `<script>
(() => {
${PANE_KIT_JS}
${TERM_LOGIC_JS}
${BROWSER_LOGIC_JS}
const base = ${base};
const wsPath = ${wsPath};

// TODO(browser-take-control-ui): the tile maps no pointer or keyboard input and has no take-control toggle. Trigger: after browser-controller-role; it needs an explicit toggle and a visible indicator that the operator is driving.
// TODO(browser-agent-notified): nothing tells the agent that an operator touched the page, so its snapshot assumptions can go stale. Trigger: after browser-controller-role; it needs a message or tool-result contract, which is a change in packages/core that lands on its own.
// TODO(ui-window-read-only): the browser view is view-only by decision, and the terminal accepts input; nothing is enforced per window. Trigger: making read-only enforceable, or any new view that takes operator input (a per-window flag enforced in the daemon, see docs/ui-vision.md).
const mountBrowserInstance = (root, params, hostApi) => {
  const agentId = String(params && params.agent || "");
  if (!agentId) throw new Error("browser needs an agent id; open it from the Tree or the top bar");
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const wrap = el("div", "browser pane pane-fill");
  const noteEl = el("p", "meta", "Content controlled by the agent");
  noteEl.setAttribute("role", "note");
  // Shown by the Help menu's "About view-only"; plain text, hidden until asked for.
  const aboutEl = el("p", "meta", "This view is view-only: it shows the agent's browser and cannot click or type. The agent controls the page, and everything it shows is untrusted.");
  aboutEl.setAttribute("role", "note");
  aboutEl.hidden = true;
  // Shown instead of the canvas when the agent no longer exists; textContent only.
  const goneEl = el("p", "meta pane-note", "This agent is no longer available.");
  goneEl.setAttribute("role", "status");
  goneEl.hidden = true;
  const canvas = el("canvas");
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.minHeight = "12rem";
  canvas.style.display = "block";
  for (const n of [noteEl, aboutEl, goneEl, canvas]) wrap.appendChild(n);
  root.appendChild(wrap);

  let active = true;
  let gone = false;
  let gen = 0;
  let epoch = 0; // bumped on no-browser, reconnect and unmount: an older in-flight decode is stale and must not draw or touch the gate
  let ws = null, openedAt = 0, shown = false;
  let attempt = 0, retryTimer = null, tickTimer = null;
  let closedReason = "";
  let bmp = null;
  const gate = BrowserKit.frameGate();
  const g2d = () => { try { return canvas.getContext("2d"); } catch (e) { return null; } };

  // Status goes to the tile footer: the "stream" slot carries the connection state plus any detail line (retry
  // countdown, why the stream closed) and a transient copy failure; the "url" slot carries the page URL.
  let stateText = "", stateTone = null, infoText = "", infoBad = false, copyNote = "";
  let pageUrl = "";
  let mode = "fit";
  const pushStream = () => {
    if (copyNote) { hostApi.setStatus("stream", { text: copyNote, tone: "err" }); return; }
    const text = stateText && infoText ? stateText + " \u2014 " + infoText : stateText || infoText;
    hostApi.setStatus("stream", { text, tone: infoBad ? "err" : stateTone });
  };
  const setState = (text, cls) => {
    stateText = text;
    stateTone = cls === "s-running" ? "ok" : cls === "s-pending" ? "warn" : cls === "s-exited" ? "err" : null; // null clears the tone: the status API rejects ""
    copyNote = "";
    pushStream();
  };
  const setInfo = (text, bad) => { infoText = text; infoBad = !!bad; copyNote = ""; pushStream(); };
  const setPage = (url) => {
    pageUrl = url;
    // The page URL is agent-controlled text: the footer renders it with textContent as read-only mono text.
    hostApi.setStatus("url", { text: url });
    hostApi.setMenuState("browser.copy-url", { enabled: url !== "" });
  };
  const closeBitmap = () => { if (bmp) { try { bmp.close(); } catch (e) {} bmp = null; } };
  const clearCanvas = () => {
    closeBitmap();
    const c = g2d();
    if (c) c.clearRect(0, 0, canvas.width, canvas.height);
  };
  const draw = () => {
    const c = g2d();
    if (!c || !bmp) return;
    const plan = BrowserKit.drawPlan(mode, bmp.width, bmp.height, Math.round(canvas.clientWidth) || 640, Math.round(canvas.clientHeight) || 400);
    if (!plan) return;
    if (canvas.width !== plan.canvasW) canvas.width = plan.canvasW;
    if (canvas.height !== plan.canvasH) canvas.height = plan.canvasH;
    c.clearRect(0, 0, plan.canvasW, plan.canvasH);
    c.drawImage(bmp, plan.rect.x, plan.rect.y, plan.rect.w, plan.rect.h);
  };
  // Fit: the canvas fills the pane (today's behaviour). Actual size: natural pixel size, the pane scrolls.
  const applyMode = (next) => {
    mode = next;
    const actual = next === "actual";
    wrap.style.overflow = actual ? "auto" : "";
    canvas.style.width = actual && bmp ? bmp.width + "px" : "100%";
    canvas.style.height = actual && bmp ? bmp.height + "px" : "100%";
    hostApi.setMenuState("browser.fit", { checked: !actual });
    hostApi.setMenuState("browser.actual-size", { checked: actual });
    draw();
  };
  const copyUrl = () => {
    const fail = (why) => { copyNote = "Copy failed: " + why; pushStream(); };
    if (!pageUrl) { fail("no page URL yet; wait for the page to load, then try again"); return; }
    let p;
    try { p = navigator.clipboard.writeText(pageUrl); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).catch(() => fail("the clipboard is unavailable or blocked; select the URL in the footer and copy it by hand"));
  };
  hostApi.onCommand((command) => {
    if (command === "browser.fit") applyMode("fit");
    else if (command === "browser.actual-size") applyMode("actual");
    else if (command === "browser.copy-url") copyUrl();
    else if (command === "browser.about") aboutEl.hidden = !aboutEl.hidden;
  });
  // One decode at a time: frames arriving meanwhile replace the single pending one (BrowserKit.frameGate).
  const decode = (buf) => {
    const e = epoch;
    createImageBitmap(new Blob([buf], { type: "image/jpeg" })).then((next) => {
      if (!active || e !== epoch) { try { next.close(); } catch (err) {} return false; }
      closeBitmap();
      bmp = next;
      if (mode === "actual") applyMode("actual");
      else draw();
      return true;
    }).catch(() => e === epoch).then((current) => {
      // A stale decode must not call done(): gate.reset() already started a new generation and busy belongs to it.
      if (!current || !active || e !== epoch) return;
      const more = gate.done();
      if (more) decode(more);
    });
  };
  const onFrame = (buf) => {
    const first = gate.offer(buf);
    if (first) decode(first);
  };

  const clearRetry = () => {
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
    if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null; }
  };
  // TODO(browser-agent-gone): the agent is only looked up after the socket closes (the daemon's close reasons ended/local/error
  // do not say "agent removed"), so a removed agent is detected on the next close, not while a stream stays open; there is no poll.
  // Agent record -> { state } | { missing } | null (lookup failed; treated as unknown, so it retries).
  const lookup = (id) => K.getJson(base + "/" + encodeURIComponent(id)).then((a) => ({ state: a && a.state }))
    .catch((err) => (err && err.status === 404) ? { missing: true } : null);

  const afterClose = () => {
    if (!active) return;
    attempt = TermKit.nextAttempt(attempt, openedAt ? Date.now() - openedAt : 0);
    const g = gen;
    lookup(agentId).then((agent) => {
      if (g !== gen || !active || ws) return;
      if (agent && agent.missing) {
        // The agent was removed: replace the canvas with the placeholder and stop (no retry timer is armed).
        gone = true;
        clearCanvas();
        canvas.style.display = "none";
        goneEl.hidden = false;
        setState(BrowserKit.stopLabel({ conn: "no agent", label: "agent not found" }), "s-exited");
        setInfo("", false);
        return;
      }
      const d = TermKit.decide({ attempt, agent, frozen: shown, rand: Math.random() });
      if (d.action === "stop") {
        setState(BrowserKit.stopLabel(d), "s-exited");
        setInfo(closedReason ? "Stream closed: " + BrowserKit.closedLabel(closedReason) : "", false);
        return;
      }
      attempt++;
      setState("reconnecting", "s-pending");
      const at = Date.now() + d.delayMs;
      const say = () => setInfo(d.label + " in " + Math.max(0, Math.ceil((at - Date.now()) / 1000)) + "s", false);
      say();
      tickTimer = setInterval(say, 1000);
      retryTimer = setTimeout(connect, d.delayMs);
    });
  };
  const connect = () => {
    clearRetry();
    if (!active || gone) return;
    closedReason = "";
    openedAt = 0;
    gate.reset();
    epoch++;
    const sock = new WebSocket(TermKit.wsUrl(location, wsPath, agentId));
    sock.binaryType = "arraybuffer";
    ws = sock;
    ++gen;
    setState("connecting", "s-pending");
    setInfo("", false);
    sock.onopen = () => {
      if (ws !== sock) return;
      openedAt = Date.now();
      shown = true;
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      if (typeof ev.data === "string") {
        const m = BrowserKit.parseServerText(ev.data);
        if (!m) return;
        if (m.type === "closed") { closedReason = m.reason; return; }
        setState(BrowserKit.stateLabel(m.state), m.state === "live" ? "s-running" : "s-pending");
        setPage(m.url || "");
        if (m.state === "no-browser") { gate.reset(); epoch++; clearCanvas(); }
        return;
      }
      if (ev.data) onFrame(ev.data);
    };
    sock.onerror = () => {};
    sock.onclose = () => { if (ws !== sock) return; ws = null; afterClose(); };
  };

  const unmount = () => {
    if (!active) return;
    active = false;
    gen++;
    epoch++;
    clearRetry();
    gate.reset();
    closeBitmap();
    const sock = ws;
    ws = null;
    if (sock) { try { sock.close(); } catch (e) {} }
    root.replaceChildren();
  };

  hostApi.setMenuState("browser.copy-url", { enabled: false });
  hostApi.setTitle("Browser · " + agentId.slice(0, 8));
  setState("", "");
  connect();
  return { unmount, fit: draw };
};
// A mount that throws after building markup would leave it in root, so setup failures clear root and rethrow for the
// host's failed-view placeholder (a missing agent id throws before any markup is built).
const mountBrowser = (root, params, hostApi) => {
  try { return mountBrowserInstance(root, params, hostApi); }
  catch (e) { root.replaceChildren(); throw e; }
};

K.registerView({ id: "browser", title: "Browser", multi: true, menus: ${scriptJson(BROWSER_DECLARATION.menus)}, status: ${scriptJson(BROWSER_DECLARATION.status)}, mount: mountBrowser });
})();
</script>`;
}
