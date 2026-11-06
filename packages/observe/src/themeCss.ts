// Window-manager chrome theme: colours, gradients, bevels and states only (no geometry) for the tiling-window
// classes the layout emits: .tile, .tile-bar (the title bar, glossed whole; .tile-title stays transparent over it), .tile-body, .tile-btn, .splitter and .tile-focused. The look is
// XP Luna / Mac OS X Aqua flavoured: glossy title bars, gel buttons, bevels as inset box-shadows. Content
// (.tile-body) stays flat. The resting splitter carries a centred 2px grip line in --chrome-border so it reads against the page and tile bodies. It ends UI_CSS (shell.ts), so it can use its tokens and wins ties; the five --chrome-*
// tokens are defined here for both colour schemes.
export const THEME_CSS = `
:root {
  --chrome-bg: #e9edf3; --chrome-fg: #1c2025; --chrome-border: #7d8590; --chrome-accent: #2557d6; --chrome-accent-fg: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --chrome-bg: #1a1a1a; --chrome-fg: #f2f2f2; --chrome-border: #626262; --chrome-accent: #ff8c1a; --chrome-accent-fg: #000000;
  }
}
.tile { background: var(--surface); border-color: var(--chrome-border); border-radius: var(--radius); box-shadow: var(--shadow), inset 0 1px 0 rgb(255 255 255 / 0.12); }
.tile-focused { border-color: var(--chrome-accent); box-shadow: var(--shadow), 0 0 0 1px var(--chrome-accent), 0 0 0.75rem var(--focus); }
.tile-bar {
  color: var(--chrome-fg); border-color: var(--chrome-border); border-radius: calc(var(--radius) - 1px) calc(var(--radius) - 1px) 0 0;
  background-color: var(--chrome-bg);
  background-image: linear-gradient(to bottom, color-mix(in srgb, var(--chrome-fg) 22%, var(--chrome-bg)) 0%, color-mix(in srgb, var(--chrome-fg) 8%, var(--chrome-bg)) 48%, var(--chrome-bg) 52%, color-mix(in srgb, var(--chrome-bg) 82%, #000) 100%);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.28), inset 0 -1px 0 rgb(0 0 0 / 0.35);
  text-shadow: 0 1px 0 rgb(255 255 255 / 0.35);
}
@media (prefers-color-scheme: dark) {
  .tile-bar { text-shadow: 0 1px 0 rgb(0 0 0 / 0.7); box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.14), inset 0 -1px 0 rgb(0 0 0 / 0.6); }
}
.tile-focused > .tile-bar {
  color: var(--chrome-accent-fg); border-color: var(--chrome-accent);
  background-color: var(--chrome-accent);
  background-image: linear-gradient(to bottom, var(--chrome-accent) 0%, var(--chrome-accent) 50%, color-mix(in srgb, var(--chrome-accent) 82%, #000) 51%, color-mix(in srgb, var(--chrome-accent) 72%, #000) 100%);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.55), inset 0 -1px 0 rgb(0 0 0 / 0.3);
  text-shadow: 0 1px 0 rgb(0 0 0 / 0.35);
}
@media (prefers-color-scheme: dark) {
  .tile-focused > .tile-bar { text-shadow: 0 1px 0 rgb(255 255 255 / 0.3); background-image: linear-gradient(to bottom, color-mix(in srgb, var(--chrome-accent) 60%, #fff) 0%, color-mix(in srgb, var(--chrome-accent) 85%, #fff) 50%, var(--chrome-accent) 51%, color-mix(in srgb, var(--chrome-accent) 82%, #000) 100%); }
}
.tile-title { background: transparent; }
.tile-body { background: var(--surface); color: var(--text); border-color: var(--chrome-border); }
.tile-btn {
  color: var(--chrome-fg); border-color: var(--chrome-border); border-radius: 999px;
  background-color: var(--chrome-bg);
  background-image: linear-gradient(to bottom, color-mix(in srgb, var(--chrome-fg) 26%, var(--chrome-bg)) 0%, color-mix(in srgb, var(--chrome-fg) 8%, var(--chrome-bg)) 50%, var(--chrome-bg) 51%, color-mix(in srgb, var(--chrome-fg) 14%, var(--chrome-bg)) 100%);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.5), inset 0 -1px 1px rgb(0 0 0 / 0.3), 0 1px 1px rgb(0 0 0 / 0.35);
  transition: filter 0.12s, box-shadow 0.12s;
}
.tile-btn:hover { filter: brightness(1.18); border-color: var(--chrome-accent); }
.tile-btn:active { filter: brightness(0.9); box-shadow: inset 0 2px 3px rgb(0 0 0 / 0.55), inset 0 0 0 1px rgb(0 0 0 / 0.2); background-image: linear-gradient(to bottom, color-mix(in srgb, var(--chrome-bg) 80%, #000), color-mix(in srgb, var(--chrome-fg) 10%, var(--chrome-bg))); }
.tile-btn:focus-visible { outline-color: var(--chrome-accent); box-shadow: 0 0 0 2px var(--focus); }
.tile-focused .tile-btn { color: var(--chrome-accent-fg); border-color: color-mix(in srgb, var(--chrome-accent) 70%, #000); text-shadow: 0 1px 0 rgb(0 0 0 / 0.35);
  background-color: var(--chrome-accent);
  background-image: linear-gradient(to bottom, var(--chrome-accent) 0%, var(--chrome-accent) 50%, color-mix(in srgb, var(--chrome-accent) 82%, #000) 51%, color-mix(in srgb, var(--chrome-accent) 72%, #000) 100%); }
@media (prefers-color-scheme: dark) {
  .tile-focused .tile-btn { text-shadow: 0 1px 0 rgb(255 255 255 / 0.3); background-image: linear-gradient(to bottom, color-mix(in srgb, var(--chrome-accent) 60%, #fff) 0%, color-mix(in srgb, var(--chrome-accent) 85%, #fff) 50%, var(--chrome-accent) 51%, color-mix(in srgb, var(--chrome-accent) 82%, #000) 100%); }
}
.tile-focused .tile-btn:hover { filter: none; border-color: var(--chrome-fg); box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.5), 0 0 0 2px var(--focus), 0 1px 1px rgb(0 0 0 / 0.35); }
.tile-focused .tile-btn:active { filter: none; background-image: linear-gradient(to bottom, color-mix(in srgb, var(--chrome-accent) 70%, #000), color-mix(in srgb, var(--chrome-accent) 85%, #000)); }
.splitter {
  background-color: var(--chrome-bg); border-color: var(--chrome-border); border-radius: 999px;
  background-image: linear-gradient(to right, color-mix(in srgb, var(--chrome-fg) 12%, var(--chrome-bg)), var(--chrome-bg) calc(50% - 1px), var(--chrome-border) calc(50% - 1px), var(--chrome-border) calc(50% + 1px), var(--chrome-bg) calc(50% + 1px), color-mix(in srgb, var(--chrome-fg) 12%, var(--chrome-bg)));
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.08);
  transition: background-color 0.12s, box-shadow 0.12s;
}
.splitter:hover, .splitter:active { background-color: var(--chrome-accent); border-color: var(--chrome-accent); background-image: linear-gradient(to right, color-mix(in srgb, var(--chrome-accent) 80%, #000), var(--chrome-accent) 50%, color-mix(in srgb, var(--chrome-accent) 80%, #000)); box-shadow: 0 0 0.5rem var(--focus); }
.splitter:focus-visible { outline-color: var(--chrome-accent); background-color: var(--chrome-accent); border-color: var(--chrome-accent); background-image: linear-gradient(to right, color-mix(in srgb, var(--chrome-accent) 80%, #000), var(--chrome-accent) 50%, color-mix(in srgb, var(--chrome-accent) 80%, #000)); box-shadow: 0 0 0 2px var(--focus); }
.splitter:hover, .splitter:active, .splitter:focus-visible { opacity: 1; }
@media (prefers-color-scheme: dark) {
  .splitter:focus-visible { box-shadow: 0 0 0 2px var(--chrome-accent-fg), 0 0 0 4px var(--chrome-fg); }
}
.splitter[aria-orientation="horizontal"] { background-image: linear-gradient(to bottom, color-mix(in srgb, var(--chrome-fg) 12%, var(--chrome-bg)), var(--chrome-bg) calc(50% - 1px), var(--chrome-border) calc(50% - 1px), var(--chrome-border) calc(50% + 1px), var(--chrome-bg) calc(50% + 1px), color-mix(in srgb, var(--chrome-fg) 12%, var(--chrome-bg))); }
.splitter[aria-orientation="horizontal"]:hover, .splitter[aria-orientation="horizontal"]:active, .splitter[aria-orientation="horizontal"]:focus-visible { background-image: linear-gradient(to bottom, color-mix(in srgb, var(--chrome-accent) 80%, #000), var(--chrome-accent) 50%, color-mix(in srgb, var(--chrome-accent) 80%, #000)); }
@media (forced-colors: active) {
  .tile, .tile-title, .tile-body, .tile-btn, .splitter, .tile-focused, .tile-focused .tile-btn, .tile-btn:hover, .tile-btn:active, .tile-btn:focus-visible, .tile-focused .tile-btn:hover, .tile-focused .tile-btn:active, .splitter:hover, .splitter:active, .splitter:focus-visible, .splitter[aria-orientation="horizontal"], .splitter[aria-orientation="horizontal"]:hover, .splitter[aria-orientation="horizontal"]:active, .splitter[aria-orientation="horizontal"]:focus-visible { background-image: none; box-shadow: none; text-shadow: none; filter: none; }
  .tile, .tile-body { background-color: Canvas; color: CanvasText; border-color: ButtonBorder; }
  .tile-bar { background-color: ButtonFace; color: ButtonText; border-color: ButtonBorder; }
  .tile-title { background-color: transparent; color: inherit; border-color: transparent; }
  .tile-focused { border-color: Highlight; }
  .tile-focused .tile-title { background-color: transparent; color: inherit; border-color: transparent; }
  .tile-focused > .tile-bar { background-color: ButtonFace; color: ButtonText; border-color: Highlight; }
  .tile-bar, .tile-focused > .tile-bar { background-image: none; box-shadow: none; text-shadow: none; filter: none; }
  .wm-notice { background-color: Canvas; color: CanvasText; border-color: CanvasText; }
  .tile-btn, .tile-focused .tile-btn { background-color: ButtonFace; color: ButtonText; border-color: ButtonBorder; }
  .tile-btn:hover, .tile-btn:active, .tile-focused .tile-btn:hover, .tile-focused .tile-btn:active { background-color: Highlight; color: HighlightText; border-color: Highlight; }
  .splitter { background-color: ButtonBorder; border-color: ButtonBorder; }
  .splitter:hover, .splitter:active, .splitter:focus-visible { background-color: Highlight; border-color: Highlight; }
}
`;
