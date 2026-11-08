// CSS for the per-tile window chrome: the wide menu bar, the single overflow button, the menu panels and the status footer.
// Overflow is a CSS container query on the tile, not JS (docs/ui-vision.md): both forms are in the DOM and the query shows one.
// Panels are positioned inside the tile (a .menuwrap is the positioning parent) because .tile clips with overflow:hidden; they are
// capped to the tile's own width (cqw) and a viewport-relative height so a long list scrolls instead of being cut off. Colour comes
// only from existing tokens with neutral fallbacks (no literals); the Aqua/Luna gradients stay in themeCss.ts, content stays flat.
// Tile width below which the menu bar collapses to the overflow button (docs/ui-vision.md).
// TODO(chrome-browser-check): the window chrome, the launcher bar and opening an item window have only static and unit checks, plus one ad hoc headless Chrome render of the panes with stubbed data (wide, narrow, four tiles) that is not repeatable (no harness or screenshots were kept). Not verified in a browser: an open menu escaping its tile (the :has() rule), container queries, keyboard use, live data and other browsers. Trigger: before any release or demo.
export const OVERFLOW_WIDTH_PX = 420;
export const CHROME_CSS = `
.tile { container-type: inline-size; container-name: tile; }
.tile-menus { display: flex; align-items: center; gap: 0.125rem; flex: 0 1 auto; min-width: 0; margin-left: 0.25rem; }
.menuwrap { position: relative; flex: 0 0 auto; }
.tile-menus .tile-btn { padding: 0 0.5rem; background-image: none; box-shadow: none; border-color: transparent; border-radius: var(--radius-sm, 0.25rem); }
.tile-menus .tile-btn:hover, .tile-menus .tile-btn[aria-expanded="true"] { filter: none; background-color: color-mix(in srgb, var(--chrome-fg, currentColor) 18%, transparent); border-color: transparent; }
.tile-menus .tile-btn:focus-visible, .tile-overflow .tile-btn:focus-visible { outline-width: 2px; outline-style: solid; outline-offset: -2px; outline-color: var(--chrome-accent, currentColor); }
.tile-overflow { display: none; position: relative; flex: 0 0 auto; }
@container tile (max-width: ${OVERFLOW_WIDTH_PX}px) {
  .tile-menus { display: none; }
  .tile-overflow { display: inline-flex; }
}
.menu-drop { position: absolute; z-index: 40; top: calc(100% + 2px); left: 0; box-sizing: border-box; min-width: 12rem; max-width: calc(100cqw - 0.5rem); max-height: min(24rem, 70vh); overflow: auto; padding: 0.25rem; color: var(--text, CanvasText); text-shadow: none; background: var(--surface-2, Canvas); border-width: 1px; border-style: solid; border-color: var(--border-strong, currentColor); border-radius: var(--radius-sm, 0.25rem); box-shadow: 0 6px 18px color-mix(in srgb, var(--text, currentColor) 35%, transparent); }
.menu-drop[hidden] { display: none; }
.menu-drop.right-edge { left: auto; right: 0; }
.menu-item { display: flex; justify-content: space-between; align-items: center; gap: 1.5rem; box-sizing: border-box; width: 100%; padding: 0.25rem 0.625rem; text-align: left; font: inherit; font-size: 0.875rem; white-space: nowrap; color: inherit; background: none; border-width: 0; border-radius: 0.25rem; cursor: pointer; }
.menu-item:hover, .menu-item:focus-visible { background: var(--hover, transparent); }
.menu-item:focus-visible { outline-width: 2px; outline-style: solid; outline-offset: -2px; outline-color: var(--chrome-accent, currentColor); }
.menu-item[role="menuitemcheckbox"][aria-checked="true"]::before, .menu-item[role="menuitemradio"][aria-checked="true"]::before { content: "\\2713"; margin-right: 0.375rem; color: var(--accent, currentColor); }
.menu-item[aria-disabled="true"] { opacity: 0.4; cursor: default; }
.menu-item[aria-disabled="true"]:hover { background: none; }
.menu-item.caution { box-shadow: inset 0.1875rem 0 0 var(--warn, currentColor); }
.menu-hint { color: var(--muted, inherit); font-size: 0.75rem; }
.menu-caution { margin: 0.25rem 0.5rem; max-width: 16rem; font-size: 0.75rem; white-space: normal; padding-left: 0.375rem; border-left-width: 0.1875rem; border-left-style: solid; border-left-color: var(--warn, currentColor); }
.menu-head { margin: 0.25rem 0.5rem 0; font-size: 0.6875rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted, inherit); }
.menu-sep { height: 0; margin: 0.25rem 0; border-width: 0; border-top-width: 1px; border-top-style: solid; border-top-color: var(--border, currentColor); }
.tile-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 0.25rem 0.5rem; flex: 0 0 auto; padding: 0.125rem 0.5rem; font-size: 0.75rem; color: var(--muted, inherit); background: var(--surface-2, transparent); border-top-width: 1px; border-top-style: solid; border-top-color: var(--border, currentColor); }
.tile-foot[hidden] { display: none; }
.stat { display: inline-flex; align-items: center; gap: 0.25rem; min-width: 0; }
.stat.mono { font-family: var(--mono, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stat-dot { display: inline-block; flex: 0 0 auto; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--muted, currentColor); }
.stat[data-tone="ok"] .stat-dot { background: var(--ok, currentColor); }
.stat[data-tone="warn"] .stat-dot { background: var(--warn, currentColor); }
.stat[data-tone="err"] .stat-dot { background: var(--err, currentColor); }
.stat[data-tone="info"] .stat-dot { background: var(--info, currentColor); }
@media (forced-colors: active) {
  .menu-drop { background-color: Canvas; color: CanvasText; border-color: CanvasText; box-shadow: none; }
  .menu-item { color: CanvasText; forced-color-adjust: auto; }
  .menu-item:hover, .menu-item:focus-visible { background-color: Highlight; color: HighlightText; }
  .menu-item[aria-disabled="true"] { color: GrayText; opacity: 1; }
  .menu-item.caution, .menu-hint, .menu-caution, .menu-head { color: inherit; }
  .menu-sep { border-top-color: CanvasText; }
  .tile-menus .tile-btn:hover, .tile-menus .tile-btn[aria-expanded="true"] { background-color: Highlight; color: HighlightText; }
  .tile-foot { background-color: Canvas; color: CanvasText; border-top-color: CanvasText; }
  .stat-dot, .stat[data-tone] .stat-dot { background-color: CanvasText; forced-color-adjust: none; }
  .stat[data-tone="err"] .stat-dot { background-color: Mark; }
}
`;
