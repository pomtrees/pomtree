// Browser-side "Copy trace" logic, shipped as source text and inlined into the terminal pane as global `T`.
// Everything with side effects (fetch, clipboard, DOM, Blob/URL) comes in through `deps`, so the vm test drives it
// with fakes. DOM is built with createElement/textContent/.value only: trace text (agent-controlled) never reaches
// innerHTML. Plain JS, no backticks, no template interpolation (it is a String.raw literal).

export const TRACE_LOGIC_JS = String.raw`
const T = (() => {
  const url = (base, id, o) => {
    const q = ["format=md"];
    if (o && o.short) q.push("short=1");
    if (o && o.children) q.push("include=children");
    if (o && o.raw) q.push("raw=1");
    return base + "/" + encodeURIComponent(id) + "/trace?" + q.join("&");
  };
  const kb = (bytes) => (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0);
  const chipText = (r) => "Copied " + kb(r.bytes) + " KB (" + r.events + " events, " + (r.raw ? "NOT redacted" : r.redacted + " redacted") + ")";
  const filename = (id, o) => "trace-" + String(id).replace(/[^A-Za-z0-9._-]/g, "_") + (o && o.short ? "-short" : "") + ".md";
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const byteLen = (s, deps) => deps && deps.byteLength ? deps.byteLength(s) : (typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s).length : s.length);

  // Hidden-textarea fallback (insecure context / permission denied). Returns true when execCommand reported success.
  const execCopy = (text, doc) => {
    let ta = null;
    try {
      ta = doc.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.left = "-9999px";
      doc.body.appendChild(ta);
      if (ta.select) ta.select();
      return doc.execCommand("copy") === true;
    } catch (e) {
      return false;
    } finally {
      if (ta && ta.remove) ta.remove();
    }
  };
  const writeClipboard = (text, deps) => {
    const cb = deps.clipboard;
    const fallback = () => execCopy(text, deps.doc) ? "execCommand" : null;
    if (cb && cb.writeText) {
      let p;
      try { p = Promise.resolve(cb.writeText(text)); } catch (e) { return Promise.resolve(fallback()); }
      return p.then(() => "clipboard", () => fallback());
    }
    return Promise.resolve(fallback());
  };

  // Fetch the trace and copy it. Resolves { ok, text, bytes, events, redacted, raw, chip, error }; ok=false with text
  // present means "fetched but could not copy" (the UI then shows the manual-copy textarea).
  const copyTrace = (deps, base, id, o) => {
    const opts = o || {};
    return deps.fetch(url(base, id, opts)).then((res) => {
      if (!res.ok) return { ok: false, error: res.status === 401 ? "Not signed in \u2014 reload to sign in" : "Trace failed: HTTP " + res.status };
      const hdr = (k) => res.headers && res.headers.get ? res.headers.get(k) : null;
      return res.text().then((text) => {
        const r = { text, bytes: byteLen(text, deps), events: num(hdr("x-trace-events")), omitted: num(hdr("x-trace-omitted")), redacted: num(hdr("x-trace-redacted")), raw: !!opts.raw };
        return writeClipboard(text, deps).then((via) => via
          ? Object.assign(r, { ok: true, via, chip: chipText(r) })
          : Object.assign(r, { ok: false, error: "Clipboard unavailable \u2014 copy the text below manually" }));
      });
    }, (err) => ({ ok: false, error: "Trace failed: " + String(err && err.message ? err.message : err) }));
  };

  // Manual-copy modal: a selectable textarea holding the trace. Returns the overlay node (already appended).
  const modal = (doc, text, message) => {
    const overlay = doc.createElement("div");
    overlay.className = "tracemodal";
    overlay.setAttribute("role", "dialog");
    const box = doc.createElement("div");
    box.className = "tracebox";
    const msg = doc.createElement("div");
    msg.textContent = message || "Copy the trace below";
    const ta = doc.createElement("textarea");
    ta.className = "tracetext";
    ta.value = text;
    ta.setAttribute("readonly", "");
    const close = doc.createElement("button");
    close.textContent = "Close";
    close.addEventListener("click", () => overlay.remove());
    box.appendChild(msg);
    box.appendChild(ta);
    box.appendChild(close);
    overlay.appendChild(box);
    doc.body.appendChild(overlay);
    if (ta.select) ta.select();
    return overlay;
  };

  // Fetch the trace for the viewer. Resolves { ok, text, meta, error }; same URL and error wording as copyTrace.
  const view = (deps, base, id, o) => {
    const opts = o || {};
    return deps.fetch(url(base, id, opts)).then((res) => {
      if (!res.ok) return { ok: false, error: res.status === 401 ? "Not signed in — reload to sign in" : "Trace failed: HTTP " + res.status };
      const hdr = (k) => res.headers && res.headers.get ? res.headers.get(k) : null;
      return res.text().then((text) => ({ ok: true, text, meta: { bytes: byteLen(text, deps), events: num(hdr("x-trace-events")), omitted: num(hdr("x-trace-omitted")), redacted: num(hdr("x-trace-redacted")), raw: !!opts.raw } }));
    }, (err) => ({ ok: false, error: "Trace failed: " + String(err && err.message ? err.message : err) }));
  };
  const metaText = (m) => kb(m.bytes) + " KB · " + m.events + " events · " + (m.raw ? "NOT redacted" : m.redacted + " redacted") + (m.omitted > 0 ? " · " + m.omitted + " events omitted from the middle (size cap)" : "");

  // In-app trace viewer: a labelled modal dialog over plain pre-wrap text (set via textContent, never markup). Escape,
  // a backdrop click and Close dismiss it and return focus to the opener. Refresh refetches; Retry shows on error.
  // TODO(trace-view-autorefresh): no auto-refresh while the agent runs; that needs an agent-state signal here (Refresh is manual).
  let live = null;
  const viewer = (deps, base, id, o, opener) => {
    if (live) return live; // one viewer at a time: a second open reuses the live one
    const doc = deps.doc;
    const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
    const overlay = el("div", "tracemodal");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "term-trace-view-title");
    const box = el("div", "tracebox");
    const title = el("strong", "", "Trace — " + id);
    title.id = "term-trace-view-title";
    const meta = el("div", "tracemeta");
    const status = el("div", "tracestatus");
    status.setAttribute("role", "status");
    const body = el("pre", "tracepre");
    body.tabIndex = 0;
    const bar = el("div", "tracebar");
    const retry = el("button", "", "Retry");
    const refresh = el("button", "", "Refresh");
    const copy = el("button", "", "Copy");
    const close = el("button", "", "Close");
    for (const b of [retry, refresh, copy, close]) b.setAttribute("type", "button");
    for (const n of [title, meta, status, body, bar]) box.appendChild(n);
    for (const b of [retry, refresh, copy, close]) bar.appendChild(b);
    overlay.appendChild(box);
    doc.body.appendChild(overlay);

    let text = "";
    let seq = 0;
    let closed = false;
    const busy = (on) => { refresh.disabled = on; copy.disabled = on || !text; };
    const load = () => {
      const mine = ++seq;
      text = "";
      body.textContent = "Loading trace…";
      meta.textContent = "";
      status.textContent = "";
      retry.hidden = true;
      busy(true);
      return view(deps, base, id, o).then((r) => {
        if (closed || mine !== seq) return r; // closed, or superseded by a newer Refresh/Retry
        if (r.ok) {
          text = r.text;
          body.textContent = r.text;
          meta.textContent = metaText(r.meta);
        } else {
          body.textContent = "";
          status.textContent = r.error;
          retry.hidden = false;
        }
        busy(false);
        return r;
      });
    };
    const dismiss = () => {
      if (closed) return;
      closed = true;
      live = null;
      if (doc.removeEventListener) doc.removeEventListener("keydown", onKey);
      overlay.remove();
      if (opener && opener.focus) opener.focus();
    };
    const onKey = (ev) => { if (ev && ev.key === "Escape") dismiss(); };
    retry.addEventListener("click", load);
    refresh.addEventListener("click", load);
    copy.addEventListener("click", () => {
      const mine = seq;
      writeClipboard(text, deps).then((via) => { if (closed || mine !== seq) return; status.textContent = via ? "Copied " + kb(byteLen(text, deps)) + " KB" : "Clipboard unavailable — select the text and copy it manually"; });
    });
    close.addEventListener("click", dismiss);
    overlay.addEventListener("click", (ev) => { if (ev && ev.target === overlay) dismiss(); });
    if (doc.addEventListener) doc.addEventListener("keydown", onKey); // document-level, so Escape works wherever focus is
    load();
    if (close.focus) close.focus();
    live = { overlay, load, dismiss, parts: { meta, status, body, retry, refresh, copy, close } };
    return live;
  };
  const dismissLive = () => { if (live) live.dismiss(); };

  // Save as a .md file through a temporary object URL.
  const download = (deps, text, name) => {
    const blob = new deps.Blob([text], { type: "text/markdown" });
    const href = deps.URL.createObjectURL(blob);
    const a = deps.doc.createElement("a");
    a.href = href;
    a.setAttribute("download", name);
    deps.doc.body.appendChild(a);
    if (a.click) a.click();
    if (a.remove) a.remove();
    if (deps.URL.revokeObjectURL) deps.URL.revokeObjectURL(href);
    return name;
  };
  return { url, kb, chipText, filename, execCopy, writeClipboard, copyTrace, view, metaText, viewer, dismissLive, modal, download };
})();
`;

export const TRACE_CSS = `
.pane .tracemenu { display: flex; flex-direction: column; gap: 0.25rem; padding: 0.5rem; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); font-size: 0.8125rem; }
.pane .tracemenu[hidden] { display: none; }
.pane .tracemenu .warn { color: var(--err); font-size: 0.75rem; }
.pane .tracechip { color: var(--muted); font-size: 0.75rem; }
.pane .tracechip.err { color: var(--err); }
.tracemodal { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.tracemodal .tracebox { display: flex; flex-direction: column; gap: 0.5rem; width: min(60rem, 92vw); max-height: 90vh; padding: 1rem; background: var(--surface, #181818); border: 1px solid var(--border-strong, #444); border-radius: var(--radius, 6px); }
.tracemodal .tracemeta, .tracemodal .tracestatus { color: var(--muted); font-size: 0.75rem; }
.tracemodal .tracepre { margin: 0; overflow: auto; max-height: 60vh; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono, monospace); font-size: 0.8125rem; }
.tracemodal .tracebar { display: flex; gap: 0.5rem; }
.tracemodal .tracebar [hidden] { display: none; }
.tracemodal .tracetext { width: 100%; height: 60vh; font-family: var(--mono, monospace); font-size: 0.8125rem; }
`;
