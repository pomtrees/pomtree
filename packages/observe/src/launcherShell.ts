// Thin DOM shell of the top launcher bar (docs/ui-vision.md), shipped as source text and inlined after
// LAUNCHER_LOGIC_JS (launcherModel.ts, the pure model, global LauncherKit) and the window manager (layoutShell.ts,
// whose api it drives). Every decision (what the lists hold, how keys move, what the pill says) comes from
// LauncherKit; this file only renders it and runs the chosen effect. All text goes through textContent (agent names
// and ids are data, never markup). Plain JS in a template literal: no backticks, no template interpolation, no
// backslashes.
export const LAUNCHER_PATHS = {
  agents: "/v1/agents",
  reports: "/v1/reports",
  approvals: "/v1/approvals?state=pending",
  escalations: "/v1/escalations?state=open",
  logout: "/ui/logout",
} as const;
export const LAUNCHER_POLL_MS = 5000;

// Structural and themed CSS of the bar. Colour comes only from token references with neutral fallbacks (the
// --chrome-* tokens are optional), so no colour literal appears here; composed into UI_CSS by shell.ts.
export const LAUNCHER_CSS = `
.lb { --lb-a: var(--chrome-accent, var(--accent, currentColor)); --lb-afg: var(--chrome-accent-fg, var(--accent-fg, Canvas)); position: relative; z-index: 30; flex: 0 0 auto; box-sizing: border-box; display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0.5rem; background: var(--surface, transparent); color: var(--text, inherit); border-bottom-width: 1px; border-bottom-style: solid; border-bottom-color: var(--border, currentColor); }
.lb button, .lb input { font: inherit; color: inherit; }
.lb-start { display: inline-flex; align-items: center; gap: 0.375rem; flex: 0 0 auto; padding: 0.25rem 0.875rem; border-radius: 999px; font-weight: 700; cursor: pointer; border-width: 1px; border-style: solid; border-color: color-mix(in srgb, var(--lb-a) 70%, black); color: var(--lb-afg); background-color: var(--lb-a); background-image: linear-gradient(to bottom, color-mix(in srgb, var(--lb-a) 60%, white) 0%, color-mix(in srgb, var(--lb-a) 85%, white) 50%, var(--lb-a) 51%, color-mix(in srgb, var(--lb-a) 82%, black) 100%); box-shadow: inset 0 1px 0 color-mix(in srgb, white 50%, transparent), 0 1px 1px color-mix(in srgb, black 35%, transparent); transition: filter 0.12s; }
.lb-start:hover { filter: brightness(1.1); }
.lb-start[aria-expanded="true"] { filter: brightness(0.9); box-shadow: inset 0 2px 3px color-mix(in srgb, black 55%, transparent); }
.lb-winlist { flex: 1 1 auto; min-width: 0; display: flex; gap: 0.25rem; overflow-x: auto; scrollbar-width: none; }
.lb-winlist::-webkit-scrollbar { display: none; }
.lb-win { display: inline-flex; align-items: center; gap: 0.375rem; flex: 0 0 auto; white-space: nowrap; padding: 0.25rem 0.625rem; border-width: 1px; border-style: solid; border-color: transparent; border-radius: var(--radius-sm, 0.25rem); background: none; color: var(--muted, inherit); cursor: pointer; font-size: 0.875rem; transition: background-color 0.12s; }
.lb-win:hover { color: var(--text, inherit); background: var(--hover, transparent); }
.lb-win.on { color: var(--accent, inherit); border-color: var(--border-strong, currentColor); background: color-mix(in srgb, var(--lb-a) 12%, transparent); }
.lb-winlist.compact .lb-win > span:last-child { max-width: 8rem; overflow: hidden; text-overflow: ellipsis; }
.lb-dot { display: inline-block; flex: 0 0 auto; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--muted, currentColor); }
.lb-dot.ok { background: var(--ok, currentColor); }
.lb-dot.warn { background: var(--warn, currentColor); }
.lb-dot.err { background: var(--err, currentColor); }
.lb-dot.info { background: var(--info, currentColor); }
.lb-dot.none { background: var(--muted, currentColor); }
.lb-right { margin-left: auto; display: flex; align-items: center; gap: 0.5rem; flex: 0 0 auto; }
.lb-conn { display: inline-flex; align-items: center; gap: 0.375rem; padding: 0 0.5rem; font-size: 0.75rem; line-height: 1.375rem; white-space: nowrap; border-radius: 999px; border-width: 1px; border-style: solid; border-color: var(--border-strong, currentColor); color: var(--text, inherit); background: var(--surface-2, transparent); }
.lb-badge { display: inline-flex; align-items: center; gap: 0.375rem; padding: 0.125rem 0.625rem; font-size: 0.875rem; cursor: pointer; border-width: 1px; border-style: solid; border-color: transparent; border-radius: var(--radius-sm, 0.25rem); background: none; }
.lb-badge:hover { background: var(--hover, transparent); }
.lb-badge b { min-width: 1.25rem; padding: 0 0.375rem; text-align: center; font-size: 0.75rem; border-radius: 999px; background: var(--lb-a); color: var(--lb-afg); }
.lb-menubtn { padding: 0.125rem 0.5rem; font-size: 1.125rem; line-height: 1.5; cursor: pointer; border-width: 1px; border-style: solid; border-color: transparent; border-radius: var(--radius-sm, 0.25rem); background: none; }
.lb-menubtn:hover, .lb-menubtn[aria-expanded="true"] { background: var(--hover, transparent); border-color: var(--border-strong, currentColor); }
.lb-notice { max-width: 20rem; font-size: 0.75rem; white-space: normal; color: var(--warn, inherit); }
.lb-drop { position: absolute; z-index: 40; box-sizing: border-box; min-width: 12rem; max-height: min(24rem, 70vh); overflow: auto; padding: 0.25rem; background: var(--surface-2, var(--surface, transparent)); color: var(--text, inherit); border-width: 1px; border-style: solid; border-color: var(--border-strong, currentColor); border-radius: var(--radius-sm, 0.25rem); box-shadow: 0 6px 18px color-mix(in srgb, black 50%, transparent); }
.lb-drop[hidden] { display: none; }
.lb-menu { top: calc(100% + 2px); right: 0.5rem; }
.lb-menu-head { margin: 0.25rem 0.5rem 0; font-size: 0.6875rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted, inherit); }
.lb-sep { border: 0; border-top-width: 1px; border-top-style: solid; border-top-color: var(--border, currentColor); margin: 0.25rem 0; }
.lb-menu-item { display: flex; width: 100%; padding: 0.25rem 0.625rem; text-align: left; font-size: 0.875rem; white-space: nowrap; cursor: pointer; border: 0; border-radius: 0.25rem; background: none; }
.lb-menu-item:hover, .lb-menu-item:focus-visible { background: var(--hover, transparent); outline-offset: -2px; }
.lb-launcher { top: calc(100% + 2px); left: 0.5rem; width: min(26rem, calc(100vw - 1rem)); max-height: min(30rem, 75vh); display: flex; flex-direction: column; gap: 0.5rem; padding: 0.5rem; }
.lb-omni { box-sizing: border-box; width: 100%; padding: 0.5rem 0.75rem; border-radius: var(--radius-sm, 0.25rem); border-width: 1px; border-style: solid; border-color: var(--border-strong, currentColor); background: var(--bg, transparent); }
.lb-omni:focus { border-color: var(--lb-a); outline: 2px solid var(--focus, var(--lb-a)); }
.lb-list { list-style: none; margin: 0; padding: 0; overflow: auto; }
.lb-item { display: flex; align-items: center; gap: 0.625rem; padding: 0.375rem 0.5rem; border-radius: 0.25rem; cursor: pointer; }
.lb-item.sel { background: var(--hover, transparent); }
.lb-item .lb-hint { color: var(--muted, inherit); font-size: 0.75rem; }
.lb-kind { margin-left: auto; font-size: 0.6875rem; color: var(--muted, inherit); text-transform: uppercase; letter-spacing: 0.05em; }
.lb-empty { padding: 0.5rem; color: var(--muted, inherit); font-size: 0.875rem; }
@media (max-width: 640px) {
  .lb-conn { position: relative; }
  .lb-conn-label { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .lb-launcher { left: 0; right: 0; width: auto; }
  .lb-menu { right: 0; }
}
@media (pointer: coarse) {
  .lb-start, .lb-win, .lb-badge, .lb-menubtn, .lb-menu-item, .lb-item { min-height: 2.5rem; min-width: 2.5rem; }
}
@media (prefers-reduced-motion: reduce) {
  .lb-start, .lb-win { transition: none; }
}
@media (forced-colors: active) {
  .lb-start, .lb-win, .lb-badge b { background-image: none; box-shadow: none; filter: none; }
  .lb, .lb-drop, .lb-omni { background-color: Canvas; color: CanvasText; border-color: ButtonBorder; }
  .lb-start, .lb-badge b { background-color: ButtonFace; color: ButtonText; border-color: ButtonBorder; }
  .lb-win.on, .lb-item.sel { border-color: Highlight; background-color: Highlight; color: HighlightText; }
  .lb-dot { background-color: CanvasText; forced-color-adjust: none; }
  .lb-conn { border-color: ButtonBorder; background: Canvas; color: CanvasText; }
  .lb-menu-item:hover, .lb-menu-item:focus-visible { background-color: Highlight; color: HighlightText; }
}
`;

export const LAUNCHER_SHELL_JS = `
function createLauncherBar(wm, cfg) {
  "use strict";
  const K = LauncherKit;
  const api = wm.api;
  const bar = document.getElementById("lb-bar");
  if (!bar) throw new Error('launcher bar: element "#lb-bar" is missing; the page shell must emit <header id="lb-bar" class="lb"></header> before the bar script runs');

  const data = { agents: [], reports: [], approvals: null, escalations: null };
  let conn = { failures: 0, everOk: false, cause: "" };
  let omni = K.omniInitial();
  let menu = K.menuInitial();
  let menuEntries = [];
  let lastWinSig = "";
  let busy = false;
  let reportsSeq = 0;
  let omniSig = "";
  let omniLis = [];
  let omniSelShown = -1;
  let menuBuilt = false;
  let menuEls = [];
  let menuFocused = -1;
  let rendering = false;
  let pointerIn = false;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function msgOf(e) {
    const m = e && e.message ? e.message : String(e);
    return m || "unknown error";
  }
  function inside(node, target) {
    return !!(target && node.contains(target));
  }

  // ---- static structure ----
  const start = el("button", "lb-start");
  start.type = "button";
  start.setAttribute("aria-haspopup", "dialog");
  start.setAttribute("aria-expanded", "false");
  start.setAttribute("aria-controls", "lb-launcher");
  const startMark = el("span", null, String.fromCharCode(9679));
  startMark.setAttribute("aria-hidden", "true");
  start.appendChild(startMark);
  start.appendChild(el("span", null, "Start"));

  const winlist = el("nav", "lb-winlist");

  const right = el("div", "lb-right");
  const connEl = el("span", "lb-conn");
  connEl.setAttribute("role", "status");
  const connDot = el("span", "lb-dot none");
  connDot.setAttribute("aria-hidden", "true");
  const connLabel = el("span", "lb-conn-label", "connecting");
  connEl.appendChild(connDot);
  connEl.appendChild(connLabel);

  const badgeBtn = el("button", "lb-badge");
  badgeBtn.type = "button";
  const badgeCount = el("b", null, "0");
  badgeBtn.appendChild(el("span", null, "Inbox"));
  badgeBtn.appendChild(badgeCount);

  const notice = el("span", "lb-notice");
  notice.setAttribute("role", "alert");
  notice.hidden = true;

  const menuBtn = el("button", "lb-menubtn", "...");
  menuBtn.type = "button";
  menuBtn.setAttribute("aria-haspopup", "menu");
  menuBtn.setAttribute("aria-expanded", "false");
  menuBtn.setAttribute("aria-label", "Menu");
  menuBtn.setAttribute("aria-controls", "lb-menu");

  right.appendChild(notice);
  right.appendChild(connEl);
  right.appendChild(badgeBtn);
  right.appendChild(menuBtn);

  const menuPanel = el("div", "lb-drop lb-menu");
  menuPanel.id = "lb-menu";
  menuPanel.setAttribute("role", "menu");
  menuPanel.setAttribute("aria-label", "Menu");
  menuPanel.hidden = true;

  const launcher = el("div", "lb-drop lb-launcher");
  launcher.id = "lb-launcher";
  launcher.setAttribute("role", "dialog");
  launcher.setAttribute("aria-label", "Launcher");
  launcher.hidden = true;
  const input = el("input", "lb-omni");
  input.type = "text";
  input.setAttribute("autocomplete", "off");
  input.setAttribute("aria-label", "Omnibar");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", "lb-list");
  input.setAttribute("placeholder", "Search windows, view types, agents, actions (" + K.OPEN_SHORTCUT + ")");
  const list = el("ul", "lb-list");
  list.id = "lb-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Windows and actions");
  const empty = el("div", "lb-empty");
  empty.hidden = true;
  launcher.appendChild(input);
  launcher.appendChild(list);
  launcher.appendChild(empty);

  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.setAttribute("accept", "application/json,.json");
  fileInput.hidden = true;

  bar.appendChild(start);
  bar.appendChild(winlist);
  bar.appendChild(right);
  bar.appendChild(menuPanel);
  bar.appendChild(launcher);
  bar.appendChild(fileInput);

  // ---- context for the model ----
  function inboxCount() {
    return (data.approvals || 0) + (data.escalations || 0);
  }
  function ctx() {
    const st = api.state();
    return { leaves: st.leaves, focus: st.focus, views: api.views(), agents: data.agents, reports: data.reports, narrow: !!st.narrow, maxLeaves: st.maxLeaves, inboxCount: inboxCount() };
  }
  function shownItems() {
    return K.rank(K.buildItems(ctx()), omni.query);
  }

  function setNotice(text) {
    notice.textContent = text;
    notice.hidden = !text;
  }

  // ---- actions ----
  function attempt(what, action) {
    const fail = (e) => setNotice(what + " failed: " + msgOf(e) + ". Reload the page and try again.");
    try {
      const r = action();
      if (r && typeof r.then === "function") r.then(null, fail);
    } catch (e) {
      fail(e);
    }
  }
  function signOut() {
    fetch(cfg.paths.logout, { method: "POST" })
      .then((r) => {
        if (!r.ok) throw new Error(cfg.paths.logout + " returned HTTP " + r.status);
        location.reload();
      })
      .catch((e) => setNotice("Sign out failed: " + msgOf(e) + ". Check the connection and choose Sign out again."));
  }
  function runAction(id) {
    if (id === "split-right") attempt("Split right", () => api.splitFocused("row"));
    else if (id === "split-down") attempt("Split down", () => api.splitFocused("col"));
    else if (id === "close-tile") attempt("Close tile", () => api.closeFocused());
    else if (id === "reset-layout") attempt("Reset layout", () => api.resetLayout());
    else if (id === "export-layout") attempt("Export layout", () => api.exportLayout());
    else if (id === "import-layout") attempt("Import layout", () => fileInput.click());
    else if (id === "sign-out") signOut();
    else setNotice("Unknown action " + id + ". Reload the page to get a matching launcher.");
  }
  // After a choice, focus must not fall to the page body: windows take it back through the window manager, actions
  // return it to the control that opened the panel; import (the file dialog) and sign out (page reload) keep theirs.
  function settleFocus(run, back) {
    if (run.type === "action") {
      if (run.id === "import-layout" || run.id === "sign-out") return;
      back.focus();
    } else if (typeof api.focusDom === "function") api.focusDom();
  }
  function runItem(run, back) {
    setNotice("");
    if (run.type === "focus") attempt("Focus window", () => api.focus(run.leaf));
    else if (run.type === "open") attempt("Open " + run.view, () => api.openView(run.view, run.agent, run.report));
    else if (run.type === "action") runAction(run.id);
    settleFocus(run, back);
  }
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (file) attempt("Import layout", () => api.importFile(file));
  });

  // ---- launcher panel ----
  // The list is rebuilt only when its content changes; a hover, a poll with the same data or a key press that only moves
  // the selection updates classes and aria in place, so nodes under the pointer survive.
  function renderOmni() {
    start.setAttribute("aria-expanded", omni.open ? "true" : "false");
    launcher.hidden = !omni.open;
    input.setAttribute("aria-expanded", omni.open ? "true" : "false");
    if (!omni.open) {
      omniSig = "";
      return;
    }
    if (input.value !== omni.query) input.value = omni.query;
    const shown = shownItems();
    const sig = JSON.stringify(shown.map((it) => [it.key, it.label, it.hint, it.dot, it.kind]));
    if (sig !== omniSig) {
      omniSig = sig;
      list.replaceChildren();
      omniLis = shown.map((item, i) => {
        const li = el("li", "lb-item");
        li.id = "lb-opt-" + i;
        li.setAttribute("role", "option");
        if (item.kind !== "action") {
          const dot = el("span", "lb-dot " + item.dot);
          dot.setAttribute("aria-hidden", "true");
          li.appendChild(dot);
        }
        li.appendChild(el("span", null, item.label));
        if (item.hint) li.appendChild(el("span", "lb-hint", item.hint));
        li.appendChild(el("span", "lb-kind", item.kind));
        li.addEventListener("click", () => omniEvent({ type: "choose", index: i }));
        li.addEventListener("mouseenter", () => omniEvent({ type: "hover", index: i }));
        list.appendChild(li);
        return li;
      });
      list.hidden = shown.length === 0;
      empty.hidden = shown.length !== 0;
      empty.textContent = shown.length ? "" : "Nothing matches " + String.fromCharCode(8220) + omni.query + String.fromCharCode(8221) + ".";
      omniSelShown = -1;
    }
    omniLis.forEach((li, i) => {
      const on = i === omni.sel;
      const cls = "lb-item" + (on ? " sel" : "");
      if (li.className !== cls) li.className = cls;
      li.setAttribute("aria-selected", on ? "true" : "false");
    });
    if (omniLis.length && omni.sel < omniLis.length) {
      input.setAttribute("aria-activedescendant", "lb-opt-" + omni.sel);
      if (omniSelShown !== omni.sel && typeof omniLis[omni.sel].scrollIntoView === "function") omniLis[omni.sel].scrollIntoView({ block: "nearest" });
      omniSelShown = omni.sel;
    } else input.removeAttribute("aria-activedescendant");
  }
  // Applies one omnibar event through the model. keepFocus: ignore a refocus effect (click outside).
  function omniEvent(ev, keepFocus) {
    const was = omni.open;
    const step = K.omniStep(omni, ev, shownItems());
    omni = step.state;
    if (omni.open && !was) {
      closeMenu();
      loadReports();
    }
    renderOmni();
    if (omni.open && (!was || ev.type === "open")) input.focus();
    const fx = step.effect;
    if (fx && fx.type === "run") runItem(fx.item.run, start);
    else if (fx && fx.type === "refocus" && !keepFocus) start.focus();
  }
  start.addEventListener("click", () => omniEvent({ type: "toggle" }));
  input.addEventListener("input", () => omniEvent({ type: "input", text: input.value }));
  input.addEventListener("keydown", (ev) => {
    const k = ev.key;
    if (k === "ArrowDown" || k === "ArrowUp" || k === "Home" || k === "End" || k === "Enter" || k === "Escape") {
      ev.preventDefault();
      omniEvent({ type: "key", key: k });
    }
  });
  // Capture phase so the key also works while a terminal (which swallows keys) has focus.
  document.addEventListener("keydown", (ev) => {
    pointerIn = false;
    if (!K.isOpenShortcut(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    omniEvent({ type: "open" });
  }, true);

  // ---- bar menu ----
  function closeMenu() {
    if (!menu.open) return;
    menu = K.menuInitial();
    renderMenu();
  }
  function renderMenu() {
    menuBtn.setAttribute("aria-expanded", menu.open ? "true" : "false");
    menuPanel.hidden = !menu.open;
    if (!menu.open) {
      menuBuilt = false;
      menuFocused = -1;
      return;
    }
    if (!menuBuilt) {
      menuBuilt = true;
      menuFocused = -1;
      menuEls = [];
      rendering = true;
      menuPanel.replaceChildren();
      menuEntries.forEach((entry, i) => {
        if (entry.kind === "head") menuPanel.appendChild(el("div", "lb-menu-head", entry.label));
        else if (entry.kind === "sep") {
          const hr = el("hr", "lb-sep");
          hr.setAttribute("role", "separator");
          menuPanel.appendChild(hr);
        } else {
          const b = el("button", "lb-menu-item", entry.label);
          b.type = "button";
          b.setAttribute("role", "menuitem");
          b.addEventListener("click", () => menuEvent({ type: "choose", index: i }));
          b.addEventListener("mouseenter", () => menuEvent({ type: "hover", index: i }));
          menuPanel.appendChild(b);
          menuEls[i] = b;
        }
      });
      rendering = false;
    }
    menuEls.forEach((b, i) => {
      if (b) b.setAttribute("tabindex", i === menu.sel ? "0" : "-1");
    });
    if (menu.sel !== menuFocused) {
      menuFocused = menu.sel;
      if (menuEls[menu.sel]) menuEls[menu.sel].focus();
    }
  }
  function menuEvent(ev) {
    const was = menu.open;
    if (ev.type === "open" || ev.type === "toggle") menuEntries = K.menuEntries(!!api.state().narrow);
    const step = K.menuStep(menu, ev, menuEntries);
    menu = step.state;
    if (menu.open && !was) {
      setNotice("");
      if (omni.open) omniEvent({ type: "close" }, true);
    }
    renderMenu();
    const fx = step.effect;
    if (fx && fx.type === "run") {
      runAction(fx.id);
      settleFocus({ type: "action", id: fx.id }, menuBtn);
    } else if (fx && fx.type === "refocus") menuBtn.focus();
  }
  menuBtn.addEventListener("click", () => menuEvent({ type: "toggle" }));
  function menuKey(ev) {
    const k = ev.key;
    if (!menu.open) {
      if (ev.target === menuBtn && k === "ArrowDown") {
        ev.preventDefault();
        menuEvent({ type: "open" });
      }
      return;
    }
    if (k === "ArrowDown" || k === "ArrowUp" || k === "Home" || k === "End" || k === "Enter" || k === " " || k === "Escape") ev.preventDefault();
    menuEvent({ type: "key", key: k });
  }
  menuBtn.addEventListener("keydown", menuKey);
  menuPanel.addEventListener("keydown", menuKey);

  // Pointer-down outside closes whichever panel is open, without moving focus away from where the press landed.
  // Focus leaving a panel closes it too; a focusout with no relatedTarget is a press on a non-focusable part of the
  // panel (pointerIn says so) or focus leaving the page.
  function insideOmni(t) {
    return inside(launcher, t) || inside(start, t);
  }
  function insideMenu(t) {
    return inside(menuPanel, t) || inside(menuBtn, t);
  }
  document.addEventListener("pointerdown", (ev) => {
    const t = ev.target;
    pointerIn = insideOmni(t) || insideMenu(t);
    if (omni.open && !insideOmni(t)) omniEvent({ type: "close" }, true);
    if (menu.open && !insideMenu(t)) closeMenu();
  }, true);
  bar.addEventListener("focusout", (ev) => {
    if (rendering) return;
    const rt = ev.relatedTarget;
    if (omni.open && (rt ? !insideOmni(rt) : !pointerIn)) omniEvent({ type: "close" }, true);
    if (menu.open && (rt ? !insideMenu(rt) : !pointerIn)) closeMenu();
  });

  // ---- badge ----
  badgeBtn.addEventListener("click", () => {
    if (!api.views().some((v) => v.id === "inbox")) return;
    attempt("Open Inbox", () => api.openView("inbox"));
  });

  // ---- window list ----
  function renderWindows() {
    const st = api.state();
    const wl = K.windowList(st.leaves, st.focus, api.views(), data.agents, inboxCount());
    const sig = JSON.stringify(wl);
    if (sig === lastWinSig) return;
    lastWinSig = sig;
    winlist.className = "lb-winlist" + (wl.compact ? " compact" : "");
    winlist.setAttribute("aria-label", wl.label);
    winlist.replaceChildren();
    wl.entries.forEach((entry) => {
      const b = el("button", "lb-win" + (entry.focused ? " on" : ""));
      b.type = "button";
      b.setAttribute("aria-pressed", entry.focused ? "true" : "false");
      b.setAttribute("title", entry.title);
      const dot = el("span", "lb-dot " + entry.dot);
      dot.setAttribute("aria-hidden", "true");
      b.appendChild(dot);
      b.appendChild(el("span", null, entry.label));
      b.addEventListener("click", () => attempt("Focus window", () => api.focus(entry.leaf)));
      winlist.appendChild(b);
      if (entry.focused && typeof b.scrollIntoView === "function") b.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  function renderStatus() {
    const cv = K.connView(conn);
    connEl.setAttribute("title", cv.title);
    connDot.className = "lb-dot " + cv.dot;
    connLabel.textContent = cv.label;
    const bd = K.inboxBadge(data.approvals, data.escalations);
    badgeBtn.setAttribute("aria-label", bd.label);
    badgeCount.textContent = bd.text;
    badgeCount.hidden = bd.hidden;
  }
  function renderAll() {
    renderWindows();
    renderStatus();
    if (omni.open) renderOmni();
  }

  // ---- polling ----
  // TODO(launcher-status-seam): the bar polls the three list endpoints itself until the menu/status data seam lands; replace this poller with that seam's feed.
  // TODO(launcher-inbox-messages): the Inbox badge excludes user-bound messages, which need the SSE stream the Inbox view reads.
  function fetchJson(url) {
    return fetch(url).then(
      (r) => {
        if (r.status === 401 || r.status === 403) return { err: url + " returned HTTP " + r.status + ": the session probably expired; the page will reload to sign in" };
        if (!r.ok) return { err: url + " returned HTTP " + r.status };
        return r.json().then((v) => ({ v: v }), (e) => ({ err: url + " returned unreadable JSON (" + msgOf(e) + ")" }));
      },
      (e) => ({ err: url + " failed: " + msgOf(e) }),
    );
  }
  // Report entries come from GET /v1/reports, read once each time the launcher panel opens (no poll). A failure leaves
  // the report entries absent, tells the operator once in the launcher notice, and never touches the agent entries or the
  // connection pill; the next open tries again and clears that notice.
  let reportsNoticed = false;
  function loadReports() {
    const seq = ++reportsSeq;
    if (reportsNoticed) { reportsNoticed = false; setNotice(""); }
    return fetchJson(cfg.paths.reports).then((r) => {
      if (seq !== reportsSeq) return;
      data.reports = r.err ? [] : K.normalizeReports(r.v);
      if (r.err) {
        reportsNoticed = true;
        setNotice("Reports could not be listed (" + r.err + "); reopen the launcher to retry.");
      }
      if (omni.open) renderOmni();
    });
  }
  function poll() {
    if (busy) return Promise.resolve();
    busy = true;
    return Promise.all([fetchJson(cfg.paths.agents), fetchJson(cfg.paths.approvals), fetchJson(cfg.paths.escalations)])
      .then((rs) => {
        const res = K.summarizePoll({ agents: rs[0].v, approvals: rs[1].v, escalations: rs[2].v, errors: rs.filter((r) => r.err).map((r) => r.err) });
        if (res.agents !== null) data.agents = res.agents;
        if (res.approvals !== null) data.approvals = res.approvals;
        if (res.escalations !== null) data.escalations = res.escalations;
        conn = K.connNext(conn, res.ok, res.cause);
      })
      .catch((e) => {
        conn = K.connNext(conn, false, "status poll failed: " + msgOf(e));
      })
      .then(() => {
        busy = false;
        renderAll();
      });
  }

  const unsub = api.onChange(renderAll);
  renderAll();
  poll();
  const timer = setInterval(() => {
    if (!document.hidden) poll();
  }, cfg.pollMs);

  return {
    poll: poll,
    dispose: () => {
      clearInterval(timer);
      if (typeof unsub === "function") unsub();
    },
  };
}
`;
