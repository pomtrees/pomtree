// The canonical window command model for the operator web UI, shipped as source text (like layout.ts) and inlined into
// the page as global `WindowMenuKit`, after `LayoutKit`. One table maps a command id to its label, its enable rule
// and its pure layout operation; the context menu, the tile-bar controls and the `ui` drive commands all go through
// it, so there is no second source of policy. Menu items are plain serializable data (command ids, no callbacks).
// No DOM, storage or clock here; tested in windowMenu.test.ts. Plain JS, no backticks and no template interpolation
// (it is a template literal, so it must also contain no backslashes).

import type { Layout } from "./layout.ts";

export type WindowCommandId =
  | "window.close"
  | "window.close-others"
  | "window.close-left"
  | "window.close-right"
  | "window.close-all"
  | "window.maximize"
  | "window.restore"
  | "window.minimize";

// The MenuKit ResolvedItem shape for host-owned menus.
export type WindowMenuItem = { kind: "action"; command: WindowCommandId; label: string; enabled: boolean; visible: boolean } | { kind: "separator" };

// The ui drive command objects fromUiCommand reads (the wire shape is owned by uiCommand.ts).
export interface WindowUiCommand {
  cmd?: string;
  scope?: string;
}

export interface WindowMenuKitApi {
  COMMANDS: WindowCommandId[];
  // Narrow mode shows one window at a time: maximize, restore and minimize are hidden and the multi-window close
  // variants are disabled; close and close all stay enabled.
  items(layout: Layout, leafId: string | null, opts?: { narrow?: boolean }): WindowMenuItem[];
  enabled(layout: Layout, command: string, leafId: string | null, opts?: { narrow?: boolean }): boolean;
  // Why the command does nothing for that window (the text of the "does nothing here" notice); "" when it is enabled.
  reason(layout: Layout, command: string, leafId: string | null, opts?: { narrow?: boolean }): string;
  // The same layout reference when the command is disabled or does nothing. leafId may be null only for
  // window.close-all and window.restore (which then un-maximizes).
  apply(layout: Layout, command: string, leafId: string | null, opts?: { narrow?: boolean }): Layout;
  // The command id for a ui drive command object, null for any other command.
  fromUiCommand(cmd: WindowUiCommand | null | undefined): WindowCommandId | null;
}

export const WINDOW_MENU_JS = `
const WindowMenuKit = globalThis.WindowMenuKit || (globalThis.WindowMenuKit = (() => {
  "use strict";
  const COMMANDS = ["window.close", "window.close-others", "window.close-left", "window.close-right", "window.close-all", "window.maximize", "window.restore", "window.minimize"];
  const LABELS = {
    "window.restore": "Restore",
    "window.maximize": "Maximize",
    "window.minimize": "Minimize",
    "window.close": "Close",
    "window.close-others": "Close others",
    "window.close-left": "Close to the left",
    "window.close-right": "Close to the right",
    "window.close-all": "Close all",
  };
  const ZOOM = { "window.maximize": true, "window.restore": true, "window.minimize": true };
  const ORDER = ["window.restore", "window.maximize", "window.minimize", null, "window.close", "window.close-others", "window.close-left", "window.close-right", "window.close-all"];

  const enabled = (layout, command, leafId, opts) => {
    if (COMMANDS.indexOf(command) < 0) return false;
    const narrow = !!(opts && opts.narrow);
    if (command === "window.close-all") return !!layout.root;
    if (command === "window.restore" && (leafId === null || leafId === undefined)) return !narrow && !!LayoutKit.maximized(layout);
    const all = LayoutKit.leaves(layout);
    const at = all.findIndex((l) => l.id === leafId);
    if (at < 0) return false;
    if (narrow && (ZOOM[command] || command === "window.close-others" || command === "window.close-left" || command === "window.close-right")) return false;
    const hidden = all[at].hidden === true;
    const isMax = LayoutKit.maximized(layout) === leafId;
    switch (command) {
      case "window.close": return true;
      case "window.close-others": return all.length > 1;
      case "window.close-left": return at > 0;
      case "window.close-right": return at < all.length - 1;
      case "window.maximize": return !isMax && (hidden || LayoutKit.visibleLeaves(layout).length > 1);
      case "window.restore": return isMax || hidden;
      case "window.minimize": return !hidden;
      default: return false;
    }
  };

  const reason = (layout, command, leafId, opts) => {
    if (enabled(layout, command, leafId, opts)) return "";
    const narrow = !!(opts && opts.narrow);
    if (narrow && (ZOOM[command] || command === "window.close-others" || command === "window.close-left" || command === "window.close-right")) return "narrow screens show one window at a time. Make the window wider than 640px.";
    if (command === "window.close-all") return "no windows are open.";
    if (command === "window.restore" && (leafId === null || leafId === undefined)) return "no window is maximized.";
    const all = LayoutKit.leaves(layout);
    const at = all.findIndex((l) => l.id === leafId);
    if (at < 0) return "that window is not open.";
    const hidden = all[at].hidden === true;
    switch (command) {
      case "window.close-others": return "there is no other window.";
      case "window.close-left": return "it is the first window in the bar.";
      case "window.close-right": return "it is the last window in the bar.";
      case "window.maximize": return LayoutKit.maximized(layout) === leafId ? "it is already maximized." : "it is the only window shown.";
      case "window.restore": return "it is neither maximized nor minimized.";
      case "window.minimize": return hidden ? "it is already minimized." : "that window cannot be minimized.";
      default: return "the command does not apply to that window.";
    }
  };

  const apply = (layout, command, leafId, opts) => {
    if (!enabled(layout, command, leafId, opts)) return layout;
    switch (command) {
      case "window.close": return LayoutKit.close(layout, leafId);
      case "window.close-others": return LayoutKit.closeOthers(layout, leafId);
      case "window.close-left": return LayoutKit.closeLeft(layout, leafId);
      case "window.close-right": return LayoutKit.closeRight(layout, leafId);
      case "window.close-all": return LayoutKit.closeAll(layout);
      case "window.maximize": return LayoutKit.maximize(layout, leafId);
      case "window.restore": return LayoutKit.restore(layout, leafId);
      case "window.minimize": return LayoutKit.minimize(layout, leafId);
      default: return layout;
    }
  };

  // Order: Restore, Maximize, Minimize, separator, Close, Close others, Close to the left, Close to the right, Close
  // all. Restore is visible only when enabled; in narrow mode the three zoom items are hidden.
  const items = (layout, leafId, opts) => {
    const narrow = !!(opts && opts.narrow);
    return ORDER.map((command) => {
      if (command === null) return { kind: "separator" };
      const on = enabled(layout, command, leafId, opts);
      const visible = narrow && ZOOM[command] ? false : command === "window.restore" ? on : true;
      return { kind: "action", command, label: LABELS[command], enabled: on, visible };
    });
  };

  const SCOPES = { others: "window.close-others", left: "window.close-left", right: "window.close-right", all: "window.close-all" };
  const fromUiCommand = (cmd) => {
    if (!cmd || typeof cmd !== "object") return null;
    if (cmd.cmd === "close") {
      if (cmd.scope === undefined) return "window.close";
      return Object.prototype.hasOwnProperty.call(SCOPES, cmd.scope) ? SCOPES[cmd.scope] : null;
    }
    if (cmd.cmd === "maximize") return "window.maximize";
    if (cmd.cmd === "minimize") return "window.minimize";
    if (cmd.cmd === "restore") return "window.restore";
    return null;
  };

  return { COMMANDS, items, enabled, reason, apply, fromUiCommand };
})());
`;
