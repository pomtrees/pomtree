// Structural CSS for the tiling window manager (layoutShell.ts): geometry, splitter hit areas, minimum sizes,
// overflow and the 640px one-view fallback. Colour comes only from token references with neutral fallbacks
// (--chrome-bg, --chrome-fg, --chrome-border, --chrome-accent and --chrome-accent-fg are optional tokens a theme may
// set; the fallbacks apply otherwise), and borders use longhands so a theme's border-color is never reset. Composed
// last into UI_CSS (shell.ts). The `.splitter:hover, .splitter:focus-visible` rule (opacity 0.5) is the unthemed cue;
// THEME_CSS (themeCss.ts) sets opacity 1 on the themed hover, active and focus-visible splitter states.
export const LAYOUT_CSS = `
body.wm { display: flex; flex-direction: column; height: 100vh; height: 100dvh; overflow: hidden; }
main.wm { flex: 1 1 auto; min-height: 0; width: auto; margin: 0; padding: 0; position: relative; }
.wm-notices { flex: 0 0 auto; }
.wm-notice { display: flex; align-items: center; gap: 0.5rem; padding: 0.375rem var(--pad, 1rem); border-bottom-width: 1px; border-bottom-style: solid; border-bottom-color: var(--chrome-border, var(--border, currentColor)); background: var(--chrome-bg, var(--surface-2, transparent)); color: var(--chrome-fg, inherit); font-size: 0.875rem; }
.wm-notice > span { flex: 1 1 auto; min-width: 0; }
.wm-root { position: relative; width: 100%; height: 100%; min-height: 0; }
.wm-empty { box-sizing: border-box; padding: 2rem var(--pad, 1rem); text-align: center; color: var(--muted, inherit); }
.tile { position: absolute; box-sizing: border-box; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; border-width: 1px; border-style: solid; border-color: var(--chrome-border, var(--border, currentColor)); background: var(--surface, transparent); }
.tile-focused { outline-width: 2px; outline-style: solid; outline-color: var(--chrome-accent, var(--accent, currentColor)); outline-offset: -2px; }
.tile-bar { display: flex; align-items: center; gap: 0.25rem; flex: 0 0 auto; min-height: 1.75rem; padding: 0.125rem 0.375rem; box-sizing: border-box; background: var(--chrome-bg, var(--surface-2, transparent)); color: var(--chrome-fg, inherit); border-bottom-width: 1px; border-bottom-style: solid; border-bottom-color: var(--chrome-border, var(--border, currentColor)); }
.tile-focused > .tile-bar { background: var(--chrome-accent, var(--chrome-bg, var(--surface-2, transparent))); color: var(--chrome-accent-fg, var(--chrome-fg, inherit)); }
.tile-title { flex: 1 1 auto; min-width: 3.5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.875rem; font-weight: 600; }
.tile-view { flex: 0 1 8rem; min-width: 0; font: inherit; font-size: 0.8125rem; }
.tile-btn { flex: 0 0 auto; min-width: 1.5rem; min-height: 1.5rem; padding: 0 0.25rem; font: inherit; line-height: 1; cursor: pointer; color: inherit; background: transparent; border-width: 1px; border-style: solid; border-color: transparent; border-radius: var(--radius-sm, 0.25rem); }
.tile-btn:disabled { opacity: 0.4; cursor: default; }
.tile-body { flex: 1 1 auto; min-width: 0; min-height: 0; position: relative; overflow: auto; }
.tile-body > section { box-sizing: border-box; padding: 0; height: 100%; }
.tile-note { padding: 1rem; color: var(--muted, inherit); }
.wm-mount { box-sizing: border-box; width: 100%; height: 100%; min-height: 0; }
.tile-body .wm-mount .pane.pane-fill { box-sizing: border-box; padding: 0; display: flex; flex-direction: column; height: 100%; min-height: 0; }
.tile-body .pane.browser canvas { flex: 1 1 auto; min-height: 0; width: 100%; height: 100%; object-fit: contain; display: block; }
.tile-body .termwrap { flex: 1 1 auto; min-height: 0; }
.tile-body .termhost { height: 100%; min-height: 0; }
.tile-body .pane-fill .termhost { padding: 0; border-width: 0; border-radius: 0; }
.tile-body .pane-fill .termnote, .tile-body .pane-fill .pane-note { padding: 0.25rem 0.5rem; }
.tile-body .termnote:empty { min-height: 0; margin: 0; padding: 0; }
.splitter { position: absolute; z-index: 5; touch-action: none; background: transparent; }
.splitter[aria-orientation="vertical"] { width: 8px; margin-left: -4px; cursor: col-resize; }
.splitter[aria-orientation="horizontal"] { height: 8px; margin-top: -4px; cursor: row-resize; }
.splitter:hover, .splitter:focus-visible { background: var(--chrome-accent, var(--accent, currentColor)); opacity: 0.5; }
.wm-narrow .splitter { display: none; }
.wm-narrow .tile-bar > :not(.tile-menus):not(.tile-overflow):not(.tile-controls) { display: none; }
.wm-narrow .tile-bar:not(:has(.tile-menus, .tile-overflow, .tile-controls)) { display: none; }
.wm-narrow .tile-bar > .tile-overflow { margin-left: auto; }
@media (max-width: 640px) {
  .tile { border-width: 0; }
  .tile-focused { outline-style: none; }
  .splitter { display: none; }
  .tile-bar > :not(.tile-menus):not(.tile-overflow):not(.tile-controls) { display: none; }
  .tile-bar:not(:has(.tile-menus, .tile-overflow, .tile-controls)) { display: none; }
  .tile-bar > .tile-overflow { margin-left: auto; }
}
@media (pointer: coarse) {
  .tile-btn { min-width: 2.5rem; min-height: 2.5rem; }
  .splitter[aria-orientation="vertical"] { width: 16px; margin-left: -8px; }
  .splitter[aria-orientation="horizontal"] { height: 16px; margin-top: -8px; }
}
`;
