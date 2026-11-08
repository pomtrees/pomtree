// Pure keyboard logic for window menus (WAI-ARIA menubar and menu button patterns), shipped as source text like
// menuModel.ts and inlined as global `MenuNav`. No DOM, clock or storage; tested in menuNav.test.ts. The chrome
// renderer (windowChrome.ts) is the only caller: it maps each rendered row to an item descriptor
// {kind, enabled, label} and each key press to an action with keyAction. Only action, toggle and radio-option rows can
// take focus; headings and separators are skipped. Plain JS, no backticks, no template interpolation, and every
// backslash doubled (it is a template literal).

export type NavKind = "action" | "toggle" | "radio-option" | "separator" | "heading";
export interface NavItem {
  kind: NavKind;
  enabled?: boolean; // default true; a disabled row is skipped by navigation
  label?: string;
}
export type NavContext = "bar-button" | "menu";
export type NavAction =
  | { type: "open-first" }
  | { type: "open-last" }
  | { type: "move"; dir: 1 | -1 }
  | { type: "edge"; edge: "first" | "last" } // inside a menu
  | { type: "bar-edge"; edge: "first" | "last" } // on a menubar button
  | { type: "switch-menu"; dir: 1 | -1 }
  | { type: "activate" }
  | { type: "typeahead"; key: string }
  | { type: "close-return-focus" } // Escape
  | { type: "close" } // Tab: close and let the browser move focus on
  | { type: "none" };
export interface NavMods {
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}
export interface MenuNavApi {
  nextIndex(items: NavItem[], from: number, dir: 1 | -1): number;
  firstIndex(items: NavItem[]): number;
  lastIndex(items: NavItem[]): number;
  typeahead(items: NavItem[], from: number, typed: string): number;
  keyAction(context: NavContext, key: string, mods?: NavMods): NavAction;
}

export const MENU_NAV_JS = `
const MenuNav = globalThis.MenuNav || (globalThis.MenuNav = (() => {
  "use strict";
  const FOCUSABLE = ["action", "toggle", "radio-option"];
  const show = (v) => {
    let t;
    try { t = JSON.stringify(v); } catch (e) { t = undefined; }
    if (typeof t !== "string") { try { t = String(v); } catch (e) { t = "?"; } }
    return t.length > 80 ? t.slice(0, 79) + "\\u2026" : t;
  };
  const focusable = (it) => !!it && FOCUSABLE.includes(it.kind) && it.enabled !== false;
  const check = (items, fn) => {
    if (!Array.isArray(items)) throw new Error("MenuNav." + fn + ": items must be an array of {kind, enabled, label} rows, got " + show(items) + "; pass the rows of the open menu");
  };
  const firstIndex = (items) => { check(items, "firstIndex"); return items.findIndex(focusable); };
  const lastIndex = (items) => {
    check(items, "lastIndex");
    for (let i = items.length - 1; i >= 0; i--) if (focusable(items[i])) return i;
    return -1;
  };
  // Next focusable row from "from" in direction dir, wrapping. from outside the list (-1: nothing focused) starts at the matching end. -1 when none can take focus.
  const nextIndex = (items, from, dir) => {
    check(items, "nextIndex");
    if (dir !== 1 && dir !== -1) throw new Error("MenuNav.nextIndex: dir must be 1 or -1, got " + show(dir) + "; use 1 for down and -1 for up");
    const n = items.length;
    if (!Number.isInteger(from) || from < 0 || from >= n) return dir > 0 ? firstIndex(items) : lastIndex(items);
    for (let k = 1; k <= n; k++) {
      const i = (((from + dir * k) % n) + n) % n;
      if (focusable(items[i])) return i;
    }
    return -1;
  };
  // Row whose label starts with the typed text (case-insensitive). One character, or one repeated character, cycles forward from the row after "from"; longer text matches from "from" itself. -1 when none.
  const typeahead = (items, from, typed) => {
    check(items, "typeahead");
    if (typeof typed !== "string" || typed === "") return -1;
    const t = typed.toLowerCase();
    const n = items.length;
    const cycle = t.length === 1 || t.split("").every((c) => c === t[0]);
    const needle = cycle ? t[0] : t;
    const f = Number.isInteger(from) ? from : -1;
    const start = cycle ? f + 1 : f;
    for (let k = 0; k < n; k++) {
      const i = (((start + k) % n) + n) % n;
      if (focusable(items[i]) && String(items[i].label || "").toLowerCase().startsWith(needle)) return i;
    }
    return -1;
  };
  const NONE = { type: "none" };
  const keyAction = (context, key, mods) => {
    if (context !== "bar-button" && context !== "menu") throw new Error("MenuNav.keyAction: unknown context " + show(context) + "; use bar-button or menu");
    if (typeof key !== "string") throw new Error("MenuNav.keyAction: key must be a KeyboardEvent key string, got " + show(key) + "; pass event.key");
    if (mods && (mods.ctrl || mods.alt || mods.meta)) return NONE;
    if (key === "Escape") return { type: "close-return-focus" };
    if (key === "Tab") return { type: "close" };
    if (key === "ArrowRight") return { type: "switch-menu", dir: 1 };
    if (key === "ArrowLeft") return { type: "switch-menu", dir: -1 };
    if (context === "bar-button") {
      if (key === "ArrowDown" || key === "Enter" || key === " ") return { type: "open-first" };
      if (key === "ArrowUp") return { type: "open-last" };
      if (key === "Home") return { type: "bar-edge", edge: "first" };
      if (key === "End") return { type: "bar-edge", edge: "last" };
      return NONE;
    }
    if (key === "ArrowDown") return { type: "move", dir: 1 };
    if (key === "ArrowUp") return { type: "move", dir: -1 };
    if (key === "Home") return { type: "edge", edge: "first" };
    if (key === "End") return { type: "edge", edge: "last" };
    if (key === "Enter" || key === " ") return { type: "activate" };
    if (key.length === 1) return { type: "typeahead", key: key };
    return NONE;
  };
  return Object.freeze({ nextIndex, firstIndex, lastIndex, typeahead, keyAction });
})());
`;
