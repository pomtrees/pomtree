// Browser-side tiling window manager for the operator shell, shipped as source text and inlined after LAYOUT_LOGIC_JS
// (layout.ts, the pure tree logic). It owns the DOM: tiles, splitters, notices, persistence and hash routing, and
// hosts views. A view is either a registry view (PaneKit.registerView: mounted per tile, unmounted on close) or a
// singleton tab section that is moved into the tile body and activated through UI.activate/UI.deactivate (so it is
// active exactly while it is in a visible tile). Agent data reaches the DOM only through textContent.
// Plain JS, no backticks, no template interpolation and no backslashes (it is a template literal).
export const LAYOUT_STORAGE_KEY = "pomtree.layout";

export const LAYOUT_SHELL_JS = `
function createWindowManager(tabs, storageKey) {
  "use strict";
  const LK = LayoutKit;
  const single = (view, params) => LK.single(view, params) || LK.single("tree", {});
  const K = globalThis.PaneKit || null;
  const MIN_W = 160;
  const MIN_H = 120;
  const NUDGE = 0.05;
  const VIEW_OK = /^[a-z][a-z0-9-]{0,63}$/;
  const DIRS = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
  const root = document.getElementById("wm-root");
  const stash = document.getElementById("wm-stash");
  const noticeBox = document.getElementById("wm-notices");

  const titles = new Map();
  const order = [];
  for (const t of tabs) { titles.set(t.id, t.title); order.push(t.id); }
  if (K && K.views) for (const d of K.views()) if (!titles.has(d.id)) { titles.set(d.id, d.title); order.push(d.id); }
  const sections = new Map();
  for (const s of document.querySelectorAll("section[data-tab]")) sections.set(s.getAttribute("data-tab"), s);
  const regDef = (id) => (K && K.view ? K.view(id) : undefined);
  const kindOf = (view) => (regDef(view) ? "mount" : sections.has(view) ? "section" : "none");
  const multiOf = (view) => { const d = regDef(view); return !!(d && d.multi); };
  const dedupeKey = (lf) => lf.view + (multiOf(lf.view) ? "|" + (lf.params.agent || "") : "");
  const errText = (e) => String(e && e.message ? e.message : e);
  const make = (tag, cls) => { const el = document.createElement(tag); if (cls) el.className = cls; return el; };
  const button = (label, fn, cls) => {
    const b = make("button", cls);
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  };
  const pct = (v) => Math.round(v * 100000) / 1000 + "%";

  // ---- notices: visible, dismissible, one per key ----
  const notices = new Map();
  const dismiss = (key) => { const b = notices.get(key); if (b) { b.remove(); notices.delete(key); } };
  const notify = (key, text, actions) => {
    dismiss(key);
    const box = make("div", "wm-notice");
    box.setAttribute("role", "status");
    const msg = make("span");
    msg.textContent = text;
    box.appendChild(msg);
    for (const a of actions || []) box.appendChild(button(a.label, a.run));
    const x = button("Dismiss", () => dismiss(key));
    x.setAttribute("aria-label", "Dismiss message");
    box.appendChild(x);
    noticeBox.appendChild(box);
    notices.set(key, box);
  };

  // ---- hash routing: #/<view>[/<agent>] ----
  const hashTarget = (hash) => {
    if (typeof hash !== "string" || !hash.startsWith("#/")) return null;
    const parts = hash.slice(2).split(/[/?#]/);
    let view = parts[0] || "";
    if (view === "escalations" && !sections.has("escalations") && sections.has("inbox")) view = "inbox";
    if (!VIEW_OK.test(view) || kindOf(view) === "none") return null;
    let agent = "";
    if (multiOf(view) && parts[1]) { try { agent = decodeURIComponent(parts[1]); } catch (e) { agent = ""; } }
    if (agent.length > 256) return null;
    return { view, agent };
  };
  const hashFor = (lf) => "#/" + lf.view + (lf.params.agent ? "/" + encodeURIComponent(lf.params.agent) : "");
  const openTarget = (l, t) => {
    const multi = multiOf(t.view);
    if (multi && !t.agent) {
      const hit = LK.leaves(l).find((x) => x.view === t.view);
      if (hit) return LK.focus(l, hit.id);
    }
    return LK.open(l, t.view, t.agent ? { agent: t.agent } : {}, multi);
  };

  // ---- state: the stored (desktop) layout, plus an in-memory single-leaf layout while narrow ----
  const defaultView = order.indexOf("tree") >= 0 ? "tree" : order[0] || "tree";
  const mq = typeof matchMedia === "function" ? matchMedia("(max-width: 640px)") : null;
  let narrow = !!(mq && mq.matches);
  let desktop = null;
  let narrowLayout = null;
  const layout = () => (narrow ? narrowLayout : desktop);
  const focusedLeaf = (l) => LK.leaves(l).find((x) => x.id === l.focus);

  const save = () => {
    try {
      globalThis.localStorage.setItem(storageKey, LK.serialize(desktop));
      dismiss("save");
    } catch (e) {
      notify("save", "The layout could not be saved (" + errText(e) + "). It lasts until you reload; use Export to keep a copy.", [{ label: "Export layout", run: doExport }]);
    }
  };
  // TODO(ui-layout-sync): the layout is stored per browser, so two browsers or devices show different layouts. Trigger: an operator uses several browsers and wants one layout.
  // TODO(ui-config-layout): no config keys (a server-set panel allowlist or default layout) exist, and a layout saved in the browser would win over a configured one. Trigger: an operator needs a fleet-wide default layout or a restricted panel set. A key lives in packages/core/src/config and changes on its own.
  const loadStored = () => {
    let text = null;
    try { text = globalThis.localStorage.getItem(storageKey); } catch (e) {
      notify("load", "The saved layout could not be read (" + errText(e) + "); showing the default layout.");
      return null;
    }
    if (text === null) return null;
    const r = LK.parse(text, { views: order });
    if (r.ok) return r.layout;
    notify("load", "The saved layout was not used. " + r.reason + " It stays as it is until you change the layout; it will be replaced when the layout is next changed.");
    return null;
  };
  const doExport = () => {
    try {
      const blob = new Blob([LK.serialize(desktop)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = make("a");
      a.href = url;
      a.download = "pomtree-layout.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      notify("export", "Export failed: " + errText(e));
    }
  };
  // TODO(layout-narrow-import): while narrow, doImport and doReset replace and save the desktop layout, but render() shows the in-memory single-view narrowLayout, so nothing visible changes yet the notice reports success. The saved layout shows once the window is wide again. Trigger: a user imports or resets on a phone, or the narrow notice wording is revisited.
  const doImport = (file) => {
    if (!file) return;
    Promise.resolve(file.text()).then((text) => {
      const r = LK.parse(text, { views: order });
      if (!r.ok) { notify("import", "Import failed. " + r.reason); return; }
      desktop = r.layout;
      render();
      save();
      syncHash();
      dismiss("load");
      notify("import", "Imported a layout with " + LK.leaves(r.layout).length + " tile(s)" + (r.unknown.length ? "; " + r.unknown.length + " show a view that is not available here" : "") + ".");
    }).catch((e) => notify("import", "Import failed: could not read the file (" + errText(e) + ")."));
  };
  const doReset = () => {
    desktop = single(defaultView);
    render();
    save();
    syncHash();
    dismiss("load");
    notify("reset", "Layout reset to the default.");
  };

  const commit = (next) => {
    if (next === layout()) return false;
    if (narrow) narrowLayout = next; else desktop = next;
    render();
    if (!narrow) save();
    syncHash();
    return true;
  };
  const syncHash = () => {
    const l = layout();
    const lf = l && focusedLeaf(l);
    if (!lf) return;
    const t = hashTarget(location.hash);
    if (t && t.view === lf.view && t.agent === (lf.params.agent || "")) return;
    try { history.replaceState(null, "", hashFor(lf)); } catch (e) {}
  };

  // ---- tiles ----
  const tiles = new Map();
  const splitEls = new Map();
  let splitInfo = new Map();
  let lastGeom = "";
  let fitQueued = false;
  const scheduleFit = () => {
    if (fitQueued) return;
    fitQueued = true;
    const run = () => {
      fitQueued = false;
      for (const rec of tiles.values()) if (rec.fit) { try { rec.fit(); } catch (e) {} }
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run); else setTimeout(run, 16);
  };
  const pickNewView = () => {
    const shown = new Set(LK.leaves(layout()).map((x) => x.view));
    for (const id of order) if (kindOf(id) === "section" && !shown.has(id)) return id;
    return regDef("terminal") ? "terminal" : defaultView;
  };
  const focusLeaf = (id) => { commit(LK.focus(layout(), id)); };
  const splitLeaf = (id, dir) => {
    const next = LK.split(layout(), id, dir, pickNewView());
    if (next === layout()) notify("limit", "Cannot split further: a layout holds at most " + LK.MAX_LEAVES + " tiles nested " + LK.MAX_DEPTH + " levels deep. Close a tile first.");
    else commit(next);
  };
  const changeView = (id, view) => {
    const l = layout();
    if (!multiOf(view) && kindOf(view) !== "none") {
      const at = LK.find(l, view, {}, false);
      if (at && at !== id) { if (!commit(LK.focus(l, at))) render(); return; }
    }
    if (!commit(LK.setView(l, id, view, {}))) render();
  };

  const release = (rec) => { if (rec.release) { try { rec.release(); } catch (e) {} rec.release = null; } rec.fit = null; };
  const buildTile = (lf, want) => {
    const rec = { sig: want.sig, view: lf.view, release: null, fit: null };
    const el = make("div", "tile");
    el.setAttribute("data-tile", lf.id);
    el.setAttribute("role", "group");
    el.setAttribute("tabindex", "-1");
    const bar = make("div", "tile-bar");
    const title = make("span", "tile-title");
    title.textContent = titles.get(lf.view) || lf.view;
    const sel = make("select", "tile-view");
    sel.setAttribute("aria-label", "View shown in this tile");
    const ids = order.indexOf(lf.view) >= 0 ? order : order.concat([lf.view]);
    for (const id of ids) {
      const o = make("option");
      o.value = id;
      o.textContent = titles.get(id) || id;
      sel.appendChild(o);
    }
    sel.value = lf.view;
    sel.addEventListener("change", () => changeView(lf.id, sel.value));
    const mk = (label, aria, fn) => {
      const b = button(label, fn, "tile-btn");
      b.setAttribute("aria-label", aria);
      b.setAttribute("title", aria);
      return b;
    };
    const bRight = mk("\\u25eb", "Split right", () => splitLeaf(lf.id, "row"));
    const bDown = mk("\\u2b13", "Split down", () => splitLeaf(lf.id, "col"));
    const bClose = mk("\\u00d7", "Close tile", () => commit(LK.close(layout(), lf.id)));
    for (const c of [title, sel, bRight, bDown, bClose]) bar.appendChild(c);
    const body = make("div", "tile-body");
    el.appendChild(bar);
    el.appendChild(body);
    el.addEventListener("pointerdown", () => focusLeaf(lf.id), true);
    el.addEventListener("focusin", () => focusLeaf(lf.id));
    Object.assign(rec, { el, title, sel, bClose, body });

    const note = (text) => {
      const n = make("div", "tile-note");
      n.textContent = text;
      body.appendChild(n);
    };
    if (want.kind === "note") note(want.note);
    else if (want.kind === "section") {
      const sec = sections.get(lf.view);
      body.appendChild(sec);
      sec.hidden = false;
      UI.activate(lf.view);
      rec.release = () => { UI.deactivate(lf.view); sec.hidden = true; stash.appendChild(sec); };
    } else {
      const host = make("div", "wm-mount");
      body.appendChild(host);
      const hostApi = { setTitle: (t) => { title.textContent = String(t); }, navigate: (h) => { location.hash = h; } };
      try {
        const inst = regDef(lf.view).mount(host, lf.params.agent ? { agent: lf.params.agent } : {}, hostApi);
        rec.release = () => { inst.unmount(); host.remove(); };
        rec.fit = inst.fit ? () => inst.fit() : null;
      } catch (e) {
        host.remove();
        note(lf.view + ": the view failed to load (" + errText(e) + "). Choose another view or close this tile.");
      }
    }
    return rec;
  };

  const splitsOf = (n, x, y, w, h, out) => {
    if (n.kind === "leaf") return out;
    out.set(n.id, { id: n.id, dir: n.dir, ratio: n.ratio, x, y, w, h });
    if (n.dir === "row") {
      const w1 = w * n.ratio;
      splitsOf(n.children[0], x, y, w1, h, out);
      splitsOf(n.children[1], x + w1, y, w - w1, h, out);
    } else {
      const h1 = h * n.ratio;
      splitsOf(n.children[0], x, y, w, h1, out);
      splitsOf(n.children[1], x, y + h1, w, h - h1, out);
    }
    return out;
  };
  const minRatioOf = (s) => {
    const box = root.getBoundingClientRect();
    const size = s.dir === "row" ? s.w * box.width : s.h * box.height;
    return size > 0 ? Math.min(0.5, (s.dir === "row" ? MIN_W : MIN_H) / size) : undefined;
  };
  const resizeTo = (id, ratio, persist) => {
    const s = splitInfo.get(id);
    if (!s) return;
    const next = LK.resize(layout(), id, ratio, minRatioOf(s));
    if (next === layout()) return;
    if (persist) commit(next);
    else { if (narrow) narrowLayout = next; else desktop = next; render(); }
  };
  const buildSplitter = (id) => {
    const el = make("div", "splitter");
    el.setAttribute("role", "separator");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", "Resize tiles");
    let dragging = false;
    el.addEventListener("pointerdown", (ev) => {
      dragging = true;
      if (el.setPointerCapture && ev.pointerId !== undefined) { try { el.setPointerCapture(ev.pointerId); } catch (e) {} }
      if (ev.preventDefault) ev.preventDefault();
    });
    el.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      const s = splitInfo.get(id);
      if (!s) return;
      const box = root.getBoundingClientRect();
      const ratio = s.dir === "row"
        ? (ev.clientX - box.left - s.x * box.width) / (s.w * box.width)
        : (ev.clientY - box.top - s.y * box.height) / (s.h * box.height);
      if (isFinite(ratio)) resizeTo(id, ratio, false);
    });
    const stop = (ev) => {
      if (!dragging) return;
      dragging = false;
      if (el.releasePointerCapture && ev && ev.pointerId !== undefined) { try { el.releasePointerCapture(ev.pointerId); } catch (e) {} }
      if (!narrow) save();
    };
    el.addEventListener("pointerup", stop);
    el.addEventListener("pointercancel", stop);
    el.addEventListener("dblclick", () => resizeTo(id, 0.5, true));
    el.addEventListener("keydown", (ev) => {
      const s = splitInfo.get(id);
      if (!s) return;
      const less = s.dir === "row" ? "ArrowLeft" : "ArrowUp";
      const more = s.dir === "row" ? "ArrowRight" : "ArrowDown";
      if (ev.key !== less && ev.key !== more) return;
      if (ev.preventDefault) ev.preventDefault();
      resizeTo(id, s.ratio + (ev.key === more ? NUDGE : -NUDGE), true);
    });
    return el;
  };

  const render = () => {
    const l = layout();
    const leaves = LK.leaves(l);
    const rects = LK.rects(l);
    const owners = new Set();
    const want = new Map();
    for (const lf of leaves) {
      let kind = kindOf(lf.view);
      let note = "";
      if (kind === "none") { kind = "note"; note = lf.view + ": view not available. Choose another view or close this tile."; }
      else {
        const dk = dedupeKey(lf);
        if (owners.has(dk)) { kind = "note"; note = lf.view + ": already shown in another tile. Choose another view or close this tile."; }
        else owners.add(dk);
      }
      want.set(lf.id, { kind, note, sig: lf.view + "|" + (lf.params.agent || "") + "|" + kind + "|" + note });
    }
    for (const [id, rec] of [...tiles]) {
      const w = want.get(id);
      if (!w || w.sig !== rec.sig) { release(rec); rec.el.remove(); tiles.delete(id); }
    }
    let geom = "";
    for (const lf of leaves) {
      let rec = tiles.get(lf.id);
      if (!rec) { rec = buildTile(lf, want.get(lf.id)); tiles.set(lf.id, rec); root.appendChild(rec.el); }
      const r = rects[lf.id];
      rec.el.style.left = pct(r.x);
      rec.el.style.top = pct(r.y);
      rec.el.style.width = pct(r.w);
      rec.el.style.height = pct(r.h);
      rec.el.className = lf.id === l.focus ? "tile tile-focused" : "tile";
      rec.sel.value = lf.view;
      rec.bClose.disabled = leaves.length < 2;
      geom += lf.id + ":" + rec.el.style.left + "," + rec.el.style.top + "," + rec.el.style.width + "," + rec.el.style.height + ";";
    }
    splitInfo = splitsOf(l.root, 0, 0, 1, 1, new Map());
    for (const [id, el] of [...splitEls]) if (!splitInfo.has(id)) { el.remove(); splitEls.delete(id); }
    for (const s of splitInfo.values()) {
      let el = splitEls.get(s.id);
      if (!el) { el = buildSplitter(s.id); splitEls.set(s.id, el); root.appendChild(el); }
      el.setAttribute("aria-orientation", s.dir === "row" ? "vertical" : "horizontal");
      el.setAttribute("aria-valuenow", String(Math.round(s.ratio * 100)));
      el.setAttribute("aria-valuemin", "0");
      el.setAttribute("aria-valuemax", "100");
      if (s.dir === "row") { el.style.left = pct(s.x + s.w * s.ratio); el.style.top = pct(s.y); el.style.height = pct(s.h); }
      else { el.style.top = pct(s.y + s.h * s.ratio); el.style.left = pct(s.x); el.style.width = pct(s.w); }
      geom += s.id + ":" + s.ratio + ";";
    }
    root.className = narrow ? "wm-root wm-narrow" : "wm-root";
    const fv = focusedLeaf(l);
    for (const a of document.querySelectorAll("nav a[data-nav]")) a.classList.toggle("active", !!fv && a.getAttribute("data-nav") === fv.view);
    if (geom !== lastGeom) { lastGeom = geom; scheduleFit(); }
  };

  // ---- narrow fallback: one view at a time, never persisted ----
  const applyNarrow = (on) => {
    if (on === narrow) return;
    narrow = on;
    if (on) { const f = focusedLeaf(desktop); narrowLayout = single(f.view, f.params); }
    else narrowLayout = null;
    render();
    syncHash();
  };
  if (mq && mq.addEventListener) mq.addEventListener("change", (ev) => applyNarrow(!!ev.matches));

  // ---- start ----
  const start = hashTarget(location.hash);
  const stored = loadStored();
  let base = stored || single(start ? start.view : defaultView, start && start.agent ? { agent: start.agent } : undefined);
  if (stored && start) base = openTarget(stored, start);
  desktop = base;
  if (narrow) { const f = focusedLeaf(desktop); narrowLayout = single(f.view, f.params); }
  render();
  if (stored && base !== stored) save();
  syncHash();

  // TODO(ui-arrangement-policy): nothing places a window when an agent appears or finishes; a window opens only from a hash link or the operator's own action. Trigger: building automatic window placement (see docs/ui-vision.md, Open questions).
  addEventListener("hashchange", () => {
    const t = hashTarget(location.hash);
    if (t) commit(openTarget(layout(), t));
  });
  document.addEventListener("keydown", (ev) => {
    if (!ev.altKey || !ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
    const dir = DIRS[ev.key];
    if (!dir || narrow) return;
    if (ev.preventDefault) ev.preventDefault();
    if (ev.stopPropagation) ev.stopPropagation();
    if (commit(LK.focusDir(desktop, dir))) {
      const rec = tiles.get(desktop.focus);
      if (rec && rec.el.focus) rec.el.focus();
    }
  }, true);
  const wire = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); };
  wire("wm-export", doExport);
  wire("wm-reset", doReset);
  const fileInput = document.getElementById("wm-file");
  if (fileInput) {
    wire("wm-import", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      doImport(f);
    });
  }
  return { layout, tiles };
}
`;
