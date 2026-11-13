// DOM renderer for a window's menus and status footer over a MenuKit window model, shipped as source text like
// menuModel.ts and inlined as global `ChromeKit` (it calls the global MenuNav from menuNav.ts, so inline that first).
// createChrome(model, {document}) returns {controls, menus, overflow, footer, destroy}: the pane controls toolbar
// (div.tile-controls: button.tile-ctl and input.tile-search, built once and patched in place so a re-render never
// destroys a focused or half-typed input), the wide menubar (div.tile-menus), the single overflow button and panel
// (span.tile-overflow; CSS shows one form by tile width; the visible control buttons are listed in it as actions), and
// the status footer (div.tile-foot, `hidden` while nothing is shown). The controls are plain Tab stops, not part of the
// menubar's roving tabindex. A search dispatches model.invoke(command, text) on Enter, after a short pause in typing
// (deps.setTimeout/clearTimeout; without them it dispatches on every input) and on Escape, which clears it first. It re-renders on model.subscribe and keeps the open menu and focus
// across a re-render. Every label, hint, caution and status text is set with textContent only. Items are dispatched
// through model.invoke(command, arg): a toggle omits arg (flip), a radio passes the option value. A failed invoke
// shows its reason in the footer until the next successful action or the next time a menu opens.
// Plain JS, no backticks, no template interpolation, and every backslash doubled (it is a template literal).

import type { WindowModel } from "./menuModel.ts";

export interface ChromeDeps {
  document: Document;
  now?: () => number; // typeahead clock; default Date.now
  setTimeout?: (fn: () => void, ms: number) => unknown; // search debounce; default the global one, if any
  clearTimeout?: (handle: unknown) => void;
}
export interface Chrome {
  controls: HTMLElement;
  menus: HTMLElement;
  overflow: HTMLElement;
  footer: HTMLElement;
  destroy(): void;
}
export interface ChromeKitApi {
  createChrome(model: WindowModel, deps: ChromeDeps): Chrome;
}

export const WINDOW_CHROME_JS = `
const ChromeKit = globalThis.ChromeKit || (globalThis.ChromeKit = (() => {
  "use strict";
  const TYPEAHEAD_MS = 700;
  const SEARCH_DEBOUNCE_MS = 250;
  const SEARCH_MAX = 200;
  const show = (v) => {
    let t;
    try { t = JSON.stringify(v); } catch (e) { t = undefined; }
    if (typeof t !== "string") { try { t = String(v); } catch (e) { t = "?"; } }
    return t.length > 80 ? t.slice(0, 79) + "\\u2026" : t;
  };
  const MODEL_FNS = ["menus", "overflow", "status", "controls", "invoke", "subscribe"];

  const createChrome = (model, deps) => {
    if (!model || typeof model !== "object" || MODEL_FNS.some((k) => typeof model[k] !== "function")) {
      throw new Error("createChrome: the first argument must be a MenuKit window model (PaneKit.windowModel(id) or PaneKit.sectionModel(id)), got " + show(model) + "; pass the model of the window this chrome belongs to");
    }
    const doc = deps && deps.document;
    if (!doc || typeof doc.createElement !== "function" || typeof doc.addEventListener !== "function" || typeof doc.removeEventListener !== "function") {
      throw new Error("createChrome: deps.document must be a Document, got " + show(doc) + "; call createChrome(model, {document})");
    }
    const now = deps && typeof deps.now === "function" ? deps.now : () => Date.now();
    const setT = deps && typeof deps.setTimeout === "function" ? deps.setTimeout : typeof setTimeout === "function" ? setTimeout : null;
    const clearT = deps && typeof deps.clearTimeout === "function" ? deps.clearTimeout : typeof clearTimeout === "function" ? clearTimeout : () => {};
    const title = model.declaration && typeof model.declaration.title === "string" ? model.declaration.title : "Window";

    const el = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const controlsEl = el("div", "tile-controls");
    // TODO(pane-controls-keyboard): the scrollable .pane-notice (paneKit.ts) is not keyboard-focusable; the toolbar's own arrow-key navigation is built (roving tabindex, ctlStop).
    controlsEl.setAttribute("role", "toolbar");
    controlsEl.setAttribute("aria-label", title + " controls");
    const menusEl = el("div", "tile-menus");
    menusEl.setAttribute("role", "menubar");
    menusEl.setAttribute("aria-label", title + " menus");
    const overflowEl = el("span", "tile-overflow");
    const footerEl = el("div", "tile-foot");
    footerEl.setAttribute("aria-label", "Status");
    footerEl.hidden = true;

    let destroyed = false;
    let wide = []; // records of the wide menus, in order
    let ovRec = null; // record of the overflow menu, or null
    let openId = null; // id of the one open menu: a menu id, or "overflow"
    let barId = null; // roving-tabindex stop in the menubar
    let failure = null; // reason of the last failed invoke, shown in the footer
    let typed = "";
    let typedAt = 0;
    let ctlRecs = []; // one {ctl, el, shown} per declared control, built once
    let ctlHad = null; // the control that has focus, or lost it to a disabled or hidden state (see syncCtlStops)
    let ctlStop = null; // roving-tabindex stop in the toolbar: the record the one Tab stop sits on
    let elKey = new Map(); // element -> {id, kind: "button" | "row", row}
    const seen = new WeakSet(); // events the chrome handled, so the document click handler ignores them

    const all = () => (ovRec ? wide.concat([ovRec]) : wide);
    const recById = (id) => all().find((r) => r.id === id) || null;

    const focusEl = (e) => { if (e && typeof e.focus === "function") e.focus(); };
    const setBar = (id) => {
      barId = id;
      for (const r of wide) r.button.setAttribute("tabindex", r.id === barId ? "0" : "-1");
    };
    const focusButton = (rec) => { if (rec.id !== "overflow") setBar(rec.id); focusEl(rec.button); };
    const focusRow = (rec, i) => { if (i >= 0 && rec.rows[i] && rec.rows[i].el) focusEl(rec.rows[i].el); };

    const applyOpen = () => {
      for (const r of all()) {
        const o = r.id === openId;
        r.panel.hidden = !o;
        r.button.setAttribute("aria-expanded", o ? "true" : "false");
      }
    };
    const open = (rec, which) => {
      if (failure !== null) { failure = null; renderFooter(); }
      openId = rec.id;
      applyOpen();
      if (which === "first") focusRow(rec, MenuNav.firstIndex(rec.descs));
      else if (which === "last") focusRow(rec, MenuNav.lastIndex(rec.descs));
    };
    const close = (returnFocus) => {
      if (openId === null) return;
      const rec = recById(openId);
      openId = null;
      applyOpen();
      if (returnFocus && rec) focusButton(rec);
    };
    const neighbour = (rec, dir) => {
      const i = wide.indexOf(rec);
      return i < 0 || wide.length < 2 ? null : wide[(i + dir + wide.length) % wide.length];
    };

    const run = (command, arg, label) => {
      let res;
      try {
        res = model.invoke(command, arg);
      } catch (err) {
        res = { ok: false, reason: label + " failed: " + (err && err.message ? err.message : show(err)) + "; reload the page if it keeps failing." };
      }
      failure = res && res.ok === false ? String(res.reason) : null;
      renderFooter();
      return failure === null;
    };
    const activate = (rec, row) => {
      if (!row.enabled) return;
      if (row.kind === "action") close(true);
      else focusEl(row.el);
      run(row.command, row.kind === "radio-option" ? row.value : undefined, row.label);
    };

    const mods = (ev) => ({ ctrl: !!ev.ctrlKey, alt: !!ev.altKey, meta: !!ev.metaKey });
    const prevent = (ev) => { if (typeof ev.preventDefault === "function") ev.preventDefault(); };

    const onRowKey = (rec, row, ev) => {
      const a = MenuNav.keyAction("menu", ev.key, mods(ev));
      const from = rec.rows.indexOf(row);
      if (a.type === "none") return;
      if (a.type === "close") { close(true); return; } // Tab: the browser then moves focus on from the button
      prevent(ev);
      if (a.type === "move") focusRow(rec, MenuNav.nextIndex(rec.descs, from, a.dir));
      else if (a.type === "edge") focusRow(rec, a.edge === "first" ? MenuNav.firstIndex(rec.descs) : MenuNav.lastIndex(rec.descs));
      else if (a.type === "activate") activate(rec, row);
      else if (a.type === "close-return-focus") close(true);
      else if (a.type === "switch-menu") {
        const n = rec.id === "overflow" ? null : neighbour(rec, a.dir);
        if (n) open(n, "first");
      } else if (a.type === "typeahead") {
        const t = now();
        typed = t - typedAt > TYPEAHEAD_MS ? a.key : typed + a.key;
        typedAt = t;
        focusRow(rec, MenuNav.typeahead(rec.descs, from, typed));
      }
    };
    const onButtonKey = (rec, ev) => {
      const a = MenuNav.keyAction("bar-button", ev.key, mods(ev));
      if (a.type === "none") return;
      if (a.type === "close") { close(true); return; }
      prevent(ev);
      if (a.type === "open-first") open(rec, "first");
      else if (a.type === "open-last") open(rec, "last");
      else if (a.type === "close-return-focus") close(true);
      else if (a.type === "switch-menu" || a.type === "bar-edge") {
        if (rec.id === "overflow") return;
        const n = a.type === "switch-menu" ? neighbour(rec, a.dir) : wide[a.edge === "first" ? 0 : wide.length - 1];
        if (!n) return;
        if (openId !== null) open(n, "first");
        else focusButton(n);
      }
    };

    const buildRows = (entries) => {
      const rows = [];
      for (const it of entries) {
        if (it.kind === "separator") {
          rows.push({ kind: "separator" });
          if (it.label) rows.push({ kind: "heading", label: it.label });
        } else if (it.kind === "heading") {
          rows.push({ kind: "heading", label: it.label });
        } else if (it.kind === "radio") {
          rows.push({ kind: "heading", label: it.label });
          for (const o of it.options) rows.push({ kind: "radio-option", command: it.command, value: o.value, label: o.label, checked: o.checked, enabled: it.enabled });
        } else {
          rows.push({ kind: it.kind, command: it.command, label: it.label, enabled: it.enabled, checked: it.checked, hint: it.hint, caution: it.caution });
        }
      }
      return rows;
    };
    const ROLES = { action: "menuitem", toggle: "menuitemcheckbox", "radio-option": "menuitemradio" };

    const buildRecord = (id, label, entries, isOverflow) => {
      const rec = { id: id, wrap: el("span", "menuwrap"), button: null, panel: null, rows: buildRows(entries), descs: [] };
      const button = el("button", "tile-btn", label);
      button.setAttribute("type", "button");
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      if (isOverflow) {
        button.textContent = "\\u22EF";
        button.setAttribute("aria-label", "Menu");
        button.setAttribute("title", "Menu");
        button.setAttribute("tabindex", "0");
      } else button.setAttribute("tabindex", "-1");
      const panel = el("div", isOverflow ? "menu-drop right-edge" : "menu-drop");
      panel.setAttribute("role", "menu");
      panel.setAttribute("aria-label", isOverflow ? title + " menu" : label);
      panel.hidden = true;
      rec.button = button;
      rec.panel = panel;
      elKey.set(button, { id: id, kind: "button" });
      for (const row of rec.rows) {
        if (row.kind === "separator") { row.el = el("div", "menu-sep"); row.el.setAttribute("role", "separator"); }
        else if (row.kind === "heading") { row.el = el("div", "menu-head", row.label); row.el.setAttribute("role", "presentation"); }
        else {
          const item = el("div", "menu-item" + (row.caution ? " caution" : ""));
          item.setAttribute("role", ROLES[row.kind]);
          item.setAttribute("tabindex", "-1");
          if (row.kind !== "action") item.setAttribute("aria-checked", row.checked ? "true" : "false");
          if (!row.enabled) item.setAttribute("aria-disabled", "true");
          item.appendChild(el("span", "menu-label", row.label));
          if (row.hint) item.appendChild(el("span", "menu-hint", row.hint));
          if (row.caution) item.appendChild(el("span", "menu-caution", row.caution));
          item.addEventListener("click", (ev) => { seen.add(ev); activate(rec, row); });
          item.addEventListener("keydown", (ev) => { seen.add(ev); onRowKey(rec, row, ev); });
          row.el = item;
          elKey.set(item, { id: id, kind: "row", row: row });
        }
        panel.appendChild(row.el);
        rec.descs.push({ kind: row.kind, enabled: row.enabled !== false, label: row.label });
      }
      button.addEventListener("click", (ev) => {
        seen.add(ev);
        if (openId === id) close(false);
        else open(rec, "none");
        focusButton(rec);
      });
      button.addEventListener("keydown", (ev) => { seen.add(ev); onButtonKey(rec, ev); });
      button.addEventListener("keyup", (ev) => { if (ev.key === " ") prevent(ev); }); // some browsers click on Space keyup
      button.addEventListener("focus", () => { if (!isOverflow) setBar(id); });
      if (!isOverflow) {
        button.addEventListener("mouseenter", () => {
          if (openId !== null && openId !== id) { open(rec, "none"); focusButton(rec); }
        });
      }
      rec.wrap.appendChild(button);
      rec.wrap.appendChild(panel);
      return rec;
    };

    // The menus' overflow list led by the visible control buttons as actions (a search stays in the bar and shrinks).
    const overflowEntries = () => {
      const acts = model.controls().filter((c) => c.kind === "button" && c.visible).map((c) => ({ kind: "action", command: c.command, label: c.label, enabled: c.enabled }));
      const rest = model.overflow();
      return acts.length && rest.length ? acts.concat([{ kind: "separator" }], rest) : acts.concat(rest);
    };

    // Rendered, not just unhidden: the narrow-tile container query hides the buttons with display: none, and an invisible control must never hold the one Tab stop.
    const rendered = (e) => typeof e.getClientRects !== "function" || e.getClientRects().length > 0;
    const ctlEligible = () => ctlRecs.filter((r) => !r.el.hidden && !r.el.disabled && rendered(r.el));
    const syncCtlStops = () => {
      const ok = ctlEligible();
      const was = ctlHad;
      if (!ok.includes(ctlStop)) ctlStop = ok.length ? ok[0] : null;
      for (const r of ctlRecs) r.el.setAttribute("tabindex", r === ctlStop ? "0" : "-1");
      // Focus was on a control that is now disabled or hidden: hand it to the new stop instead of letting it fall to the body.
      const a = doc.activeElement;
      if (was && ctlStop && !ok.includes(was) && (a === was.el || !a || a === doc.body)) { ctlHad = ctlStop; focusEl(ctlStop.el); }
    };
    // WAI-ARIA toolbar: Left and Right move between the controls (wrapping), Home and End jump to the ends. A search keeps its own
    // keys for the text: Left at the very start and Right at the very end of an unselected caret leave it, Home and End stay in it.
    const onCtlKey = (rec, ev) => {
      if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return;
      const isBtn = rec.ctl.kind === "button";
      if (!isBtn) {
        const a = rec.el.selectionStart;
        const b = rec.el.selectionEnd;
        if (typeof a !== "number" || a !== b) return;
        if (!((ev.key === "ArrowLeft" && a === 0) || (ev.key === "ArrowRight" && a === String(rec.el.value).length))) return;
      }
      const ok = ctlEligible();
      const i = ok.indexOf(rec);
      let n = null;
      if (ev.key === "ArrowRight") n = ok[(i + 1) % ok.length];
      else if (ev.key === "ArrowLeft") n = ok[(i - 1 + ok.length) % ok.length];
      else if (isBtn && ev.key === "Home") n = ok[0];
      else if (isBtn && ev.key === "End") n = ok[ok.length - 1];
      else return;
      prevent(ev);
      if (n && n !== rec) focusEl(n.el);
    };
    const buildControls = () => {
      ctlRecs = model.controls().map((c) => {
        const rec = { ctl: c, el: null, shown: c.kind === "search" ? c.value : "", sent: null };
        if (c.kind === "button") {
          rec.el = el("button", "tile-ctl" + (c.primary ? " primary" : ""), c.label);
          rec.el.setAttribute("type", "button");
          rec.el.addEventListener("click", () => run(c.command, undefined, c.label));
        } else {
          const input = el("input", "tile-search");
          input.setAttribute("type", "search");
          input.setAttribute("aria-label", c.label);
          input.setAttribute("maxlength", String(SEARCH_MAX));
          if (c.placeholder) input.setAttribute("placeholder", c.placeholder);
          input.value = c.value;
          let timer = null;
          const stop = () => { if (timer !== null) { clearT(timer); timer = null; } };
          // Idempotent: Chrome also fires a search event after Enter and after the clear button, so an unchanged value is skipped.
          const send = () => {
            stop();
            if (destroyed || input.value === rec.sent) return;
            rec.sent = input.value;
            if (!run(c.command, input.value, c.label)) rec.sent = null; // a failed command can be retried with the same value
          };
          rec.stop = stop;
          input.addEventListener("input", () => {
            stop();
            if (setT === null) { send(); return; }
            timer = setT(send, SEARCH_DEBOUNCE_MS);
          });
          input.addEventListener("search", send);
          input.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") { prevent(ev); send(); }
            else if (ev.key === "Escape" && input.value !== "") { prevent(ev); input.value = ""; send(); }
          });
          rec.el = input;
        }
        rec.el.addEventListener("focus", () => { ctlStop = rec; ctlHad = rec; syncCtlStops(); });
        // Focus that left for anywhere else is forgotten; one lost because the control became disabled or hidden is kept for the hand-off.
        rec.el.addEventListener("blur", () => { if (!rec.el.disabled && rendered(rec.el)) ctlHad = null; });
        rec.el.addEventListener("keydown", (ev) => onCtlKey(rec, ev));
        return rec;
      });
      controlsEl.replaceChildren(...ctlRecs.map((r) => r.el));
    };
    // Patches in place; the input's own text is replaced only when the model's value changed since the last patch.
    const patchControls = () => {
      const now = model.controls();
      let any = false;
      ctlRecs.forEach((rec, i) => {
        const c = now[i];
        rec.el.disabled = !c.enabled;
        rec.el.hidden = !c.visible;
        if (c.visible) any = true;
        if (c.kind === "button") rec.el.textContent = c.label;
        else if (c.value !== rec.shown) {
          rec.shown = c.value;
          if (rec.el.value !== c.value) { rec.el.value = c.value; rec.sent = null; }
        }
      });
      controlsEl.hidden = !any;
      syncCtlStops();
    };

    const renderMenus = () => {
      const active = doc.activeElement;
      const was = active ? elKey.get(active) : undefined;
      elKey = new Map();
      wide = model.menus().map((m) => buildRecord(m.id, m.title, m.items, false));
      const entries = overflowEntries();
      ovRec = entries.some((e) => e.kind !== "separator" && e.kind !== "heading") ? buildRecord("overflow", "Menu", entries, true) : null;
      menusEl.replaceChildren(...wide.map((r) => r.wrap));
      menusEl.hidden = wide.length === 0;
      overflowEl.replaceChildren(...(ovRec ? [ovRec.wrap] : []));
      overflowEl.hidden = ovRec === null;
      if (!wide.some((r) => r.id === barId)) barId = wide.length ? wide[0].id : null;
      setBar(barId);
      if (openId !== null && !recById(openId)) openId = null;
      applyOpen();
      if (!was) return;
      const rec = recById(was.id);
      if (!rec) { const f = wide[0] || ovRec; if (f) focusButton(f); return; }
      if (was.kind === "button") { focusButton(rec); return; }
      const idx = rec.rows.findIndex((r) => r.command === was.row.command && r.value === was.row.value && r.kind === was.row.kind);
      if (openId === rec.id && idx >= 0) focusRow(rec, idx);
      else if (openId === rec.id) focusRow(rec, MenuNav.firstIndex(rec.descs));
      else focusButton(rec);
    };

    function renderFooter() {
      const kids = [];
      for (const s of model.status()) {
        const e = el("span", s.mono ? "stat mono" : "stat");
        e.setAttribute("title", s.title);
        if (s.tone) {
          e.setAttribute("data-tone", s.tone);
          const dot = el("span", "stat-dot");
          dot.setAttribute("aria-hidden", "true");
          e.appendChild(dot);
          e.appendChild(el("span", "stat-text", s.text));
        } else e.textContent = s.text;
        kids.push(e);
      }
      if (failure !== null) {
        const e = el("span", "stat");
        e.setAttribute("role", "alert");
        e.setAttribute("data-tone", "err");
        const dot = el("span", "stat-dot");
        dot.setAttribute("aria-hidden", "true");
        e.appendChild(dot);
        e.appendChild(el("span", "stat-text", failure));
        kids.push(e);
      }
      footerEl.replaceChildren(...kids);
      footerEl.hidden = kids.length === 0;
    }

    const onDocClick = (ev) => {
      if (destroyed || seen.has(ev)) return;
      close(false);
    };
    menusEl.addEventListener("click", (ev) => { seen.add(ev); });
    overflowEl.addEventListener("click", (ev) => { seen.add(ev); });
    doc.addEventListener("click", onDocClick);

    // The tile width decides which controls are rendered (container query), so the Tab stop is re-synced when the toolbar resizes.
    const win = doc.defaultView;
    const RO = deps && deps.ResizeObserver ? deps.ResizeObserver : win && typeof win.ResizeObserver === "function" ? win.ResizeObserver : null;
    let ro = null;
    let tileEl = null;
    // The container-query box is the tile, which is not an ancestor yet when the chrome is built, so it is found on the first callback.
    const watchTile = () => {
      const t = tileEl === null && typeof controlsEl.closest === "function" ? controlsEl.closest(".tile") : null;
      if (t && ro) { tileEl = t; ro.observe(t); }
    };
    ro = RO ? new RO(() => { if (destroyed) return; watchTile(); syncCtlStops(); }) : null;
    if (ro) ro.observe(controlsEl);
    const onWinResize = () => { if (!destroyed) syncCtlStops(); };
    if (win && typeof win.addEventListener === "function") win.addEventListener("resize", onWinResize);
    buildControls();
    patchControls();
    renderMenus();
    renderFooter();
    const unsubscribe = model.subscribe(() => {
      if (destroyed) return;
      patchControls();
      renderMenus();
      renderFooter();
    });

    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      doc.removeEventListener("click", onDocClick);
      if (ro) ro.disconnect();
      if (win && typeof win.removeEventListener === "function") win.removeEventListener("resize", onWinResize);
      openId = null;
      wide = [];
      ovRec = null;
      elKey = new Map();
      for (const r of ctlRecs) if (r.stop) r.stop();
      ctlRecs = [];
      ctlStop = null;
      ctlHad = null;
      controlsEl.replaceChildren();
      controlsEl.hidden = true;
      menusEl.replaceChildren();
      overflowEl.replaceChildren();
      footerEl.replaceChildren();
      footerEl.hidden = true;
    };
    return { controls: controlsEl, menus: menusEl, overflow: overflowEl, footer: footerEl, destroy: destroy };
  };

  return Object.freeze({ createChrome });
})());
`;
