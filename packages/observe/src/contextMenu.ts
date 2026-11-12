// Pop-up context menu for the window manager (docs/ui-vision.md), shipped as source text like menuNav.ts and inlined as
// global `ContextMenuKit` after MENU_NAV_JS (it calls the global MenuNav.keyAction for keys). Plain data in (the
// MenuKit ResolvedItem action/separator shape plus `visible`), a command id out through onPick; no layout knowledge.
// All labels go through textContent. Plain JS in a template literal: no backticks, no template interpolation, and no
// backslashes at all (so none need doubling).

export type ContextMenuItem =
  | { kind: "action"; command: string; label: string; enabled: boolean; visible?: boolean }
  | { kind: "separator"; visible?: boolean };

export interface ContextMenuOpen {
  items: ContextMenuItem[];
  x: number;
  y: number;
  label: string;
  opener?: { focus(): void } | null;
  onPick?: (command: string) => void;
}
export interface ContextMenu {
  open(spec: ContextMenuOpen): boolean; // false when nothing was shown (no visible action rows, bad input)
  close(): void;
  isOpen(): boolean;
}
export interface ContextMenuAttach {
  menu: ContextMenu;
  items: () => ContextMenuItem[];
  onPick?: (command: string) => void;
  label: string;
  keyTarget?: unknown;
  // Element that receives focus on Escape or a pick; defaults to el. Pass a focusable element when el itself is not focusable.
  opener?: { focus(): void } | null;
}
export interface ContextMenuKitApi {
  create(deps: { document: unknown }): ContextMenu;
  attach(el: unknown, opts: ContextMenuAttach): () => void;
}

// TODO(wm-menu-touch): the menu opens from a right-click and from the ContextMenu key or Shift+F10; long-press on a touch screen is not built (a touch user reaches the window commands through the tile-bar buttons only).
export const CONTEXT_MENU_JS = `
const ContextMenuKit = globalThis.ContextMenuKit || (globalThis.ContextMenuKit = (() => {
  "use strict";
  const TYPEAHEAD_MS = 700;
  let current = null; // the one open menu across every create(): opening a second closes the first
  const show = (v) => {
    let t;
    try { t = JSON.stringify(v); } catch (e) { t = undefined; }
    if (typeof t !== "string") { try { t = String(v); } catch (e) { t = "?"; } }
    return t.length > 80 ? t.slice(0, 79) + "..." : t;
  };
  const report = (msg) => { try { console.error(msg); } catch (e) { /* no console */ } };
  const mods = (ev) => ({ ctrl: !!ev.ctrlKey, alt: !!ev.altKey, meta: !!ev.metaKey });
  const prevent = (ev) => { if (ev && typeof ev.preventDefault === "function") ev.preventDefault(); };

  // Visible rows only; separators at the edges and doubled separators are dropped. [] when no action row remains.
  const visibleRows = (items) => {
    const rows = [];
    let actions = 0;
    for (const it of items) {
      if (!it || it.visible === false) continue;
      if (it.kind === "separator") {
        if (rows.length && rows[rows.length - 1].kind !== "separator") rows.push({ kind: "separator" });
      } else if (it.kind === "action" && typeof it.command === "string") {
        rows.push({ kind: "action", command: it.command, label: String(it.label), enabled: it.enabled !== false });
        actions++;
      }
    }
    while (rows.length && rows[rows.length - 1].kind === "separator") rows.pop();
    return actions ? rows : [];
  };

  const create = (deps) => {
    const doc = deps && deps.document;
    if (!doc || typeof doc.createElement !== "function" || !doc.body) throw new Error("ContextMenuKit.create: needs {document} with createElement and body, got " + show(deps) + "; pass the page document");
    const win = doc.defaultView || globalThis.window || null;
    let state = null; // { popup, rows, els, onPick, opener, cleanup, typed, typedAt, done }
    const self = {};

    const close = () => {
      const s = state;
      if (!s) return;
      state = null;
      if (current === self) current = null;
      s.cleanup();
      s.popup.remove();
    };
    const focusRow = (s, i) => { if (i >= 0 && s.els[i]) s.els[i].focus(); };
    const rowDescs = (s) => s.rows.map((r) => ({ kind: r.kind, enabled: r.enabled, label: r.label }));

    const activate = (s, i) => {
      const row = s.rows[i];
      if (!row || row.kind !== "action" || !row.enabled || s.done || state !== s) return;
      s.done = true;
      close();
      if (s.opener && typeof s.opener.focus === "function") s.opener.focus();
      if (typeof s.onPick !== "function") return;
      try {
        s.onPick(row.command);
      } catch (err) {
        report("ContextMenuKit: the handler for " + row.command + " failed: " + (err && err.message ? err.message : show(err)) + "; the menu closed, retry the command or reload the page if it keeps failing.");
      }
    };

    const onKey = (s, i, ev) => {
      if (s.done || state !== s) return;
      const a = MenuNav.keyAction("menu", ev.key, mods(ev));
      if (a.type === "none" || a.type === "switch-menu") return;
      if (a.type === "close") { close(); return; } // Tab: the browser then moves focus on
      prevent(ev);
      if (typeof ev.stopPropagation === "function") ev.stopPropagation();
      const d = rowDescs(s);
      if (a.type === "move") focusRow(s, MenuNav.nextIndex(d, i, a.dir));
      else if (a.type === "edge") focusRow(s, a.edge === "first" ? MenuNav.firstIndex(d) : MenuNav.lastIndex(d));
      else if (a.type === "activate") activate(s, i);
      else if (a.type === "close-return-focus") {
        const op = s.opener;
        close();
        if (op && typeof op.focus === "function") op.focus();
      } else if (a.type === "typeahead") {
        const t = Date.now();
        s.typed = t - s.typedAt > TYPEAHEAD_MS ? a.key : s.typed + a.key;
        s.typedAt = t;
        focusRow(s, MenuNav.typeahead(d, i, s.typed));
      }
    };

    const place = (popup, x, y) => {
      if (!popup.style) return;
      const root = doc.documentElement;
      const vw = (root && root.clientWidth) || (win && win.innerWidth) || 0;
      const vh = (root && root.clientHeight) || (win && win.innerHeight) || 0;
      const w = popup.offsetWidth || 0;
      const h = popup.offsetHeight || 0;
      const px = Number.isFinite(x) ? x : 0;
      const py = Number.isFinite(y) ? y : 0;
      const left = vw > 0 ? Math.max(0, Math.min(px, vw - w)) : Math.max(0, px);
      const top = vh > 0 ? Math.max(0, Math.min(py, vh - h)) : Math.max(0, py);
      popup.style.left = Math.round(left) + "px";
      popup.style.top = Math.round(top) + "px";
    };

    self.open = (spec) => {
      if (!spec || !Array.isArray(spec.items)) {
        report("ContextMenuKit.open: items must be an array of {kind, command, label, enabled} rows, got " + show(spec && spec.items) + "; pass the output of the menu model.");
        return false;
      }
      const rows = visibleRows(spec.items);
      if (!rows.length) return false;
      if (current) current.close();
      close();
      const popup = doc.createElement("div");
      popup.className = "ctx-menu";
      popup.setAttribute("role", "menu");
      popup.setAttribute("aria-label", String(spec.label || "Menu"));
      popup.setAttribute("tabindex", "-1");
      const s = { popup, rows, els: [], onPick: spec.onPick, opener: spec.opener || null, cleanup: () => {}, typed: "", typedAt: 0, done: false };
      rows.forEach((r, i) => {
        let el;
        if (r.kind === "separator") {
          el = doc.createElement("div");
          el.className = "ctx-sep";
          el.setAttribute("role", "separator");
        } else {
          el = doc.createElement("button");
          el.className = "ctx-item";
          el.setAttribute("type", "button");
          el.setAttribute("role", "menuitem");
          el.setAttribute("tabindex", "-1");
          el.textContent = r.label;
          if (!r.enabled) el.setAttribute("aria-disabled", "true");
          el.addEventListener("click", (ev) => { prevent(ev); activate(s, i); });
          el.addEventListener("keydown", (ev) => onKey(s, i, ev));
        }
        s.els.push(el);
        popup.appendChild(el);
      });
      popup.addEventListener("keydown", (ev) => { if (ev.target === popup) onKey(s, -1, ev); });
      doc.body.appendChild(popup);
      place(popup, spec.x, spec.y);
      state = s;
      current = self;

      const onDown = (ev) => { if (!popup.contains(ev.target)) close(); };
      const onAway = () => close();
      doc.addEventListener("pointerdown", onDown, true);
      const rm = [];
      // No capture: element blur and scroll do not bubble, so focusing a row or scrolling a pane inside the page must not close the menu.
      if (win && typeof win.addEventListener === "function") {
        for (const t of ["blur", "resize", "scroll"]) { win.addEventListener(t, onAway); rm.push([win, t, onAway]); }
      }
      s.cleanup = () => {
        if (typeof doc.removeEventListener === "function") doc.removeEventListener("pointerdown", onDown, true);
        for (const [target, t, fn] of rm) if (typeof target.removeEventListener === "function") target.removeEventListener(t, fn);
      };
      const first = MenuNav.firstIndex(rowDescs(s));
      if (first >= 0) focusRow(s, first);
      else popup.focus();
      return true;
    };
    self.close = close;
    self.isOpen = () => state !== null;
    return Object.freeze(self);
  };

  const attach = (el, opts) => {
    if (!el || typeof el.addEventListener !== "function") throw new Error("ContextMenuKit.attach: el must be an element, got " + show(el) + "; pass the bar entry or title element");
    if (!opts || !opts.menu || typeof opts.items !== "function") throw new Error("ContextMenuKit.attach: opts needs {menu, items: () => items, label}, got " + show(opts) + "; create the menu with ContextMenuKit.create first");
    const openAt = (x, y) => {
      let items;
      try {
        items = opts.items();
      } catch (err) {
        report("ContextMenuKit: could not build the menu items: " + (err && err.message ? err.message : show(err)) + "; reload the page if it keeps failing.");
        return;
      }
      opts.menu.open({ items, x, y, label: opts.label, opener: opts.opener || el, onPick: opts.onPick });
    };
    const onContext = (ev) => {
      prevent(ev);
      openAt(Number(ev.clientX) || 0, Number(ev.clientY) || 0);
    };
    const onKeyDown = (ev) => {
      const plain = !ev.ctrlKey && !ev.altKey && !ev.metaKey;
      const hit = ev.key === "ContextMenu" || (ev.key === "F10" && !!ev.shiftKey && plain);
      if (!hit) return;
      prevent(ev);
      const r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
      openAt(r ? r.left : 0, r ? r.bottom : 0);
    };
    // keyTarget (e.g. the focusable tile root): only keys aimed at it directly count, so views inside keep their keys.
    const kt = opts.keyTarget && typeof opts.keyTarget.addEventListener === "function" ? opts.keyTarget : null;
    const onTargetKey = (ev) => { if (ev.target === kt) onKeyDown(ev); };
    el.addEventListener("contextmenu", onContext);
    el.addEventListener("keydown", onKeyDown);
    if (kt) kt.addEventListener("keydown", onTargetKey);
    return () => {
      if (typeof el.removeEventListener === "function") {
        el.removeEventListener("contextmenu", onContext);
        el.removeEventListener("keydown", onKeyDown);
      }
      if (kt && typeof kt.removeEventListener === "function") kt.removeEventListener("keydown", onTargetKey);
    };
  };
  return Object.freeze({ create, attach });
})());
`;

export const CONTEXT_MENU_CSS = `
.ctx-menu { position: fixed; z-index: 60; box-sizing: border-box; display: flex; flex-direction: column; min-width: 11rem; max-width: min(20rem, 100vw); max-height: 100vh; overflow: auto; padding: 0.25rem; background: var(--surface-2, var(--surface, Canvas)); color: var(--text, CanvasText); border-width: 1px; border-style: solid; border-color: var(--border-strong, currentColor); border-radius: var(--radius-sm, 0.25rem); box-shadow: 0 6px 18px color-mix(in srgb, black 50%, transparent); font-size: 0.875rem; }
.ctx-menu:focus { outline: none; }
.ctx-item { display: block; width: 100%; box-sizing: border-box; padding: 0.375rem 0.75rem; text-align: left; font: inherit; color: inherit; cursor: pointer; background: none; border-width: 1px; border-style: solid; border-color: transparent; border-radius: var(--radius-sm, 0.25rem); transition: background-color 0.12s; }
.ctx-item:hover, .ctx-item:focus-visible { background: var(--hover, transparent); border-color: var(--border-strong, currentColor); outline: none; }
.ctx-item[aria-disabled="true"] { opacity: 0.5; cursor: default; }
.ctx-item[aria-disabled="true"]:hover { background: none; border-color: transparent; }
.ctx-sep { flex: 0 0 auto; height: 0; margin: 0.25rem 0; border-top-width: 1px; border-top-style: solid; border-top-color: var(--border, currentColor); }
@media (pointer: coarse) {
  .ctx-item { min-height: 2.75rem; min-width: 2.75rem; }
}
@media (prefers-reduced-motion: reduce) {
  .ctx-item { transition: none; }
}
@media (forced-colors: active) {
  .ctx-menu { background-color: Canvas; color: CanvasText; border-color: ButtonBorder; box-shadow: none; }
  .ctx-item:hover, .ctx-item:focus-visible { background-color: Highlight; color: HighlightText; border-color: Highlight; }
  .ctx-item[aria-disabled="true"] { opacity: 1; color: GrayText; }
  .ctx-item[aria-disabled="true"]:hover { background-color: Canvas; color: GrayText; border-color: transparent; }
  .ctx-sep { border-top-color: ButtonBorder; }
}
`;
