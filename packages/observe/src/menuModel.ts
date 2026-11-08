// Pure model of what a view type declares for its window chrome: per-window menus and status, as plain
// serializable data (no callbacks). The chrome renders it (textContent only); actions are named command ids
// that the chrome dispatches through the view's registered handler. Shipped as source text like layout.ts and
// inlined as global `MenuKit` by PANE_KIT_JS (paneKit.ts); the types below describe the same shapes for tests and
// other TypeScript. No DOM, storage, clock or randomness; tested in menuModel.test.ts. Plain JS, no backticks, no
// template interpolation, and every backslash doubled (it is a template literal).
//
// Two layers. A declaration (declareView) is static data a view type registers once. A window model
// (createWindowModel) is the per-tile runtime state over one declaration: enabled/visible/checked/value overlays
// and status text that the view pushes, the resolved menus the chrome renders, and the dispatch of a picked item.
// The wide menu bar (menus) and the narrow overflow list (overflow) are two views of the same resolved menus, so
// they can never disagree about which commands exist.
//
// Handler return values are ignored. An async handler's rejection is only logged (console.error); the handler must
// report its own failure to the operator, for example through setStatus. A synchronous throw makes invoke return
// {ok:false} and restore the toggle/radio state it had before the call.
//
// Renderer notes. Roles derive from kind: menubar/menu for the menus, menuitem for actions, menuitemcheckbox for
// toggles, menuitemradio for radio options inside a group named by the radio label, and separator for rules. Status
// text and labels are set with textContent only. A tone is never the only cue because the text is always present.
// The overflow form is the same resolved menus flattened by overflow().

export type MenuId = "view" | "trace" | "session" | "help";
export type StatusTone = "ok" | "warn" | "err" | "info";

interface ItemBase {
  // Command id handed to the view's handler, unique within the view: lowercase words, "-" and "." (e.g. "terminal.reconnect").
  command: string;
  label: string;
  enabled?: boolean; // initial; default true. A disabled item stays visible, greyed.
  visible?: boolean; // initial; default true. Hidden items (and menus left with none) are not rendered.
}
export interface ActionItem extends ItemBase {
  kind: "action";
  hint?: string; // secondary text beside the label (e.g. a shortcut or a short explanation)
  caution?: string; // warning text shown with the item (e.g. "Raw skips secret redaction")
}
export interface ToggleItem extends ItemBase {
  kind: "toggle";
  checked?: boolean; // initial; default false
  hint?: string;
  caution?: string;
}
export interface RadioOption {
  value: string;
  label: string;
}
// A group of mutually exclusive options under one command; `label` is the group heading.
export interface RadioItem extends ItemBase {
  kind: "radio";
  options: RadioOption[];
  value?: string; // initial; default the first option
}
// A rule, with an optional section heading (e.g. "Options").
export interface SeparatorItem {
  kind: "separator";
  label?: string;
}
export type MenuItem = ActionItem | ToggleItem | RadioItem | SeparatorItem;
export interface MenuDecl {
  id: MenuId;
  items: MenuItem[];
}
// One slot of status. The view fills `text` at runtime; a slot with empty text is not rendered. A tone draws a
// coloured dot (a pill); no tone is plain text. `title` names the slot for assistive technology.
export interface StatusDecl {
  id: string;
  title: string;
  text?: string;
  tone?: StatusTone;
  mono?: boolean;
}
export interface ViewDeclaration {
  id: string;
  title: string;
  multi: boolean;
  menus?: MenuDecl[];
  status?: StatusDecl[];
}
export interface NormalizedViewDeclaration {
  id: string;
  title: string;
  multi: boolean;
  menus: MenuDecl[]; // canonical order: view, trace, session, help
  status: StatusDecl[];
}

export type ResolvedItem =
  | { kind: "action"; command: string; label: string; enabled: boolean; hint?: string; caution?: string }
  | { kind: "toggle"; command: string; label: string; enabled: boolean; checked: boolean; hint?: string; caution?: string }
  | { kind: "radio"; command: string; label: string; enabled: boolean; value: string; options: Array<{ value: string; label: string; checked: boolean }> }
  | { kind: "separator"; label?: string };
export interface ResolvedMenu {
  id: MenuId;
  title: string;
  items: ResolvedItem[];
}
// The overflow form: every menu's items in one list, each menu introduced by a heading and divided by a rule.
export type OverflowEntry = ResolvedItem | { kind: "heading"; menu: MenuId; label: string };
export interface ResolvedStatus {
  id: string;
  title: string;
  text: string;
  tone?: StatusTone;
  mono?: boolean;
}
export interface StatePatch {
  enabled?: boolean;
  visible?: boolean;
  checked?: boolean; // toggles only
  value?: string; // radio groups only; one of the declared option values
}
export interface StatusPatch {
  text?: string;
  tone?: StatusTone | null; // null clears the tone
}
// action: arg undefined; toggle: the new checked boolean (omitted means flip); radio: the chosen option value.
export type CommandArg = boolean | string | undefined;
export type CommandHandler = (command: string, arg: CommandArg) => void;
export type InvokeResult = { ok: true } | { ok: false; reason: string };

export interface WindowModel {
  declaration: NormalizedViewDeclaration;
  menus(): ResolvedMenu[];
  overflow(): OverflowEntry[];
  status(): ResolvedStatus[];
  setState(command: string, patch: StatePatch): void;
  setStatus(id: string, patch: StatusPatch): void;
  onCommand(handler: CommandHandler): void;
  invoke(command: string, arg?: CommandArg): InvokeResult;
  subscribe(listener: () => void): () => void;
}
export interface MenuKitApi {
  MENU_IDS: MenuId[];
  MENU_TITLES: Record<MenuId, string>;
  MAX_ITEMS: number;
  MAX_OPTIONS: number;
  MAX_STATUS: number;
  MAX_LABEL: number;
  MAX_STATUS_TEXT: number;
  // Validates and normalizes; throws an Error naming the cause and the fix. The result is a fresh frozen copy.
  declareView(decl: ViewDeclaration): NormalizedViewDeclaration;
  createWindowModel(decl: NormalizedViewDeclaration): WindowModel;
}

export const MENU_KIT_JS = `
const MenuKit = globalThis.MenuKit || (globalThis.MenuKit = (() => {
  "use strict";
  const MENU_IDS = ["view", "trace", "session", "help"];
  const MENU_TITLES = { view: "View", trace: "Trace", session: "Session", help: "Help" };
  const TONES = ["ok", "warn", "err", "info"];
  const MAX_ITEMS = 64; // per view, all menus together
  const MAX_OPTIONS = 16;
  const MAX_STATUS = 8;
  const MAX_LABEL = 200;
  const MAX_STATUS_TEXT = 500;
  const NAME = /^[a-z][a-z0-9-]*$/;
  const COMMAND = /^[a-z][a-z0-9-]*([.][a-z0-9-]+)*$/;
  const VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  // Failure text must never itself throw (BigInt, cycles) and stays short.
  const show = (v) => {
    let t;
    try { t = JSON.stringify(v); } catch (e) { t = undefined; }
    if (typeof t !== "string") { try { t = String(v); } catch (e) { t = "?"; } }
    return t.length > 80 ? t.slice(0, 79) + "\\u2026" : t;
  };
  const report = (msg) => { if (typeof console !== "undefined" && console && typeof console.error === "function") console.error(msg); };
  const declared = new WeakSet(); // results of declareView; createWindowModel accepts only these
  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  const fail = (where, cause, action) => { throw new Error("declareView: " + where + ": " + cause + "; " + action); };
  const keysOf = (o, allowed, where) => {
    for (const k of Object.keys(o)) {
      if (o[k] !== undefined && !allowed.includes(k)) fail(where, "unknown field " + show(k), "remove it; the allowed fields are " + allowed.join(", "));
    }
  };
  const str = (v, where, field, required) => {
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string" || v.trim() === "" || v.length > MAX_LABEL) fail(where, field + " must be a non-empty string of at most " + MAX_LABEL + " characters, got " + show(v), "set " + field + " to a short plain-text string");
    return v;
  };
  const bool = (v, where, field) => {
    if (v === undefined) return undefined;
    if (typeof v !== "boolean") fail(where, field + " must be true or false, got " + show(v), "use a boolean");
    return v;
  };
  const put = (o, k, v) => { if (v !== undefined) o[k] = v; return o; };

  const normItem = (raw, where, commands) => {
    if (!isObj(raw)) fail(where, "an item must be an object, got " + show(raw), "declare it as {kind, command, label}");
    const kind = raw.kind;
    if (kind === "separator") {
      keysOf(raw, ["kind", "label"], where);
      return put({ kind: "separator" }, "label", str(raw.label, where, "label", false));
    }
    if (kind !== "action" && kind !== "toggle" && kind !== "radio") fail(where, "unknown item kind " + show(kind), "use action, toggle, radio or separator");
    keysOf(raw, kind === "radio" ? ["kind", "command", "label", "enabled", "visible", "options", "value"]
      : kind === "toggle" ? ["kind", "command", "label", "enabled", "visible", "checked", "hint", "caution"]
      : ["kind", "command", "label", "enabled", "visible", "hint", "caution"], where);
    const command = raw.command;
    if (typeof command !== "string" || !COMMAND.test(command)) fail(where, "command must be a lowercase id such as terminal.reconnect, got " + show(command), "use lowercase letters, digits and - separated by dots");
    if (commands.has(command)) fail(where, "command " + command + " is declared twice", "give each item its own command id (state is kept per command)");
    commands.add(command);
    where = where + " (command " + command + ")";
    const out = { kind: kind, command: command, label: str(raw.label, where, "label", true) };
    put(out, "enabled", bool(raw.enabled, where, "enabled"));
    put(out, "visible", bool(raw.visible, where, "visible"));
    if (kind === "radio") {
      if (!Array.isArray(raw.options) || raw.options.length === 0 || raw.options.length > MAX_OPTIONS) fail(where, "options must be a list of 1 to " + MAX_OPTIONS + " entries", "list the choices as [{value, label}]");
      const seen = new Set();
      out.options = raw.options.map((o, i) => {
        const ow = where + ", option " + (i + 1);
        if (!isObj(o)) fail(ow, "an option must be an object, got " + show(o), "declare it as {value, label}");
        keysOf(o, ["value", "label"], ow);
        if (typeof o.value !== "string" || !VALUE.test(o.value)) fail(ow, "value must be letters, digits, . _ or -, got " + show(o.value), "use a short id such as all or 13");
        if (seen.has(o.value)) fail(ow, "value " + o.value + " is declared twice", "give each option a distinct value");
        seen.add(o.value);
        return { value: o.value, label: str(o.label, ow, "label", true) };
      });
      if (raw.value !== undefined && !seen.has(raw.value)) fail(where, "value " + show(raw.value) + " is not one of the options", "pick one of " + [...seen].join(", ") + " or omit value");
      put(out, "value", raw.value);
    } else {
      put(out, "hint", str(raw.hint, where, "hint", false));
      put(out, "caution", str(raw.caution, where, "caution", false));
      if (kind === "toggle") put(out, "checked", bool(raw.checked, where, "checked"));
    }
    return out;
  };

  const freeze = (x) => {
    if (x && typeof x === "object") { for (const k of Object.keys(x)) freeze(x[k]); Object.freeze(x); }
    return x;
  };

  const declareView = (raw) => {
    const w0 = "view " + show(raw && raw.id);
    if (!isObj(raw)) fail("view", "the declaration must be an object, got " + show(raw), "pass {id, title, multi, menus?, status?}");
    keysOf(raw, ["id", "title", "multi", "menus", "status"], w0);
    if (typeof raw.id !== "string" || !NAME.test(raw.id)) fail(w0, "id must be a lowercase name such as terminal", "use lowercase letters, digits and -");
    const title = str(raw.title, w0, "title", true);
    if (typeof raw.multi !== "boolean") fail(w0, "multi must be true or false, got " + show(raw.multi), "say whether the view can open more than once");
    const menusIn = raw.menus === undefined ? [] : raw.menus;
    if (!Array.isArray(menusIn)) fail(w0, "menus must be a list of {id, items}", "declare menus as [{id: \\"view\\", items: [...]}]");
    const commands = new Set();
    const seenMenus = new Set();
    let total = 0;
    const menus = menusIn.map((m, i) => {
      if (!isObj(m)) fail(w0, "menu " + (i + 1) + " must be an object, got " + show(m), "declare it as {id, items}");
      const mw = w0 + ", menu " + show(m.id);
      keysOf(m, ["id", "items"], mw);
      if (!MENU_IDS.includes(m.id)) fail(w0, "menu id " + show(m.id) + " is not one of " + MENU_IDS.join(", "), "name the menu with one of those ids");
      if (seenMenus.has(m.id)) fail(mw, "menu declared twice", "merge the two into one items list");
      seenMenus.add(m.id);
      if (!Array.isArray(m.items) || m.items.length === 0) fail(mw, "items must be a non-empty list", "add items or drop the menu");
      total += m.items.length;
      if (total > MAX_ITEMS) fail(mw, "more than " + MAX_ITEMS + " menu items in this view", "move rarely used actions out of the window menus");
      return { id: m.id, items: m.items.map((it, j) => normItem(it, mw + ", item " + (j + 1), commands)) };
    });
    menus.sort((a, b) => MENU_IDS.indexOf(a.id) - MENU_IDS.indexOf(b.id));
    const statusIn = raw.status === undefined ? [] : raw.status;
    if (!Array.isArray(statusIn) || statusIn.length > MAX_STATUS) fail(w0, "status must be a list of at most " + MAX_STATUS + " slots", "declare slots as [{id, title}]");
    const slotIds = new Set();
    const status = statusIn.map((s, i) => {
      const sw = w0 + ", status " + (i + 1);
      if (!isObj(s)) fail(sw, "a status slot must be an object, got " + show(s), "declare it as {id, title}");
      keysOf(s, ["id", "title", "text", "tone", "mono"], sw);
      if (typeof s.id !== "string" || !NAME.test(s.id)) fail(sw, "id must be a lowercase name such as connection, got " + show(s.id), "use lowercase letters, digits and -");
      if (slotIds.has(s.id)) fail(sw, "status id " + s.id + " is declared twice", "give each slot its own id");
      slotIds.add(s.id);
      const out = { id: s.id, title: str(s.title, sw, "title", true) };
      if (s.text !== undefined) { if (typeof s.text !== "string" || s.text.length > MAX_STATUS_TEXT) fail(sw, "text must be a string of at most " + MAX_STATUS_TEXT + " characters", "shorten it or set it at runtime with setStatus"); out.text = s.text; }
      if (s.tone !== undefined && !TONES.includes(s.tone)) fail(sw, "tone " + show(s.tone) + " is not one of " + TONES.join(", "), "use one of those tones or omit it");
      put(out, "tone", s.tone);
      put(out, "mono", bool(s.mono, sw, "mono"));
      return out;
    });
    const result = freeze({ id: raw.id, title: title, multi: raw.multi, menus: menus, status: status });
    declared.add(result);
    return result;
  };

  const createWindowModel = (decl) => {
    const where = "window model for view " + show(decl && decl.id);
    if (!decl || typeof decl !== "object" || !declared.has(decl)) throw new Error("createWindowModel: " + where + " needs a declaration returned by declareView; call declareView first");
    const items = new Map(); // command -> declared item
    const state = new Map(); // command -> { enabled, visible, checked?, value? }
    for (const m of decl.menus) for (const it of m.items) {
      if (it.kind === "separator") continue;
      items.set(it.command, it);
      const s = { enabled: it.enabled !== false, visible: it.visible !== false };
      if (it.kind === "toggle") s.checked = it.checked === true;
      if (it.kind === "radio") s.value = it.value !== undefined ? it.value : it.options[0].value;
      state.set(it.command, s);
    }
    const slots = new Map();
    for (const s of decl.status) slots.set(s.id, { text: s.text === undefined ? "" : s.text, tone: s.tone });
    const listeners = new Set();
    let handler = null;
    const notify = () => {
      for (const l of [...listeners]) {
        try { l(); } catch (err) { report("MenuKit: a subscriber threw: " + (err && err.message ? err.message : show(err)) + "; fix the listener"); }
      }
    };

    const resolveItem = (it) => {
      if (it.kind === "separator") return put({ kind: "separator" }, "label", it.label);
      const s = state.get(it.command);
      const out = { kind: it.kind, command: it.command, label: it.label, enabled: s.enabled };
      if (it.kind === "radio") {
        out.value = s.value;
        out.options = it.options.map((o) => ({ value: o.value, label: o.label, checked: o.value === s.value }));
        return out;
      }
      if (it.kind === "toggle") out.checked = s.checked;
      put(out, "hint", it.hint);
      put(out, "caution", it.caution);
      return out;
    };
    // Drops hidden items, then rules that would lead, trail or double up, and headings with nothing under them.
    const resolveItems = (list) => {
      const shown = list.filter((it) => it.kind === "separator" || state.get(it.command).visible).map(resolveItem);
      const out = [];
      for (let i = 0; i < shown.length; i++) {
        const it = shown[i];
        if (it.kind === "separator") {
          const next = shown[i + 1];
          const orphan = next === undefined || next.kind === "separator";
          if (orphan) continue;
          if (it.label === undefined && out.length === 0) continue;
        }
        out.push(it);
      }
      return out;
    };
    const menus = () => {
      const res = [];
      for (const m of decl.menus) {
        const its = resolveItems(m.items);
        if (its.some((it) => it.kind !== "separator")) res.push({ id: m.id, title: MENU_TITLES[m.id], items: its });
      }
      return res;
    };
    const overflow = () => {
      const out = [];
      menus().forEach((m, i) => {
        if (i > 0) out.push({ kind: "separator" });
        out.push({ kind: "heading", menu: m.id, label: m.title });
        for (const it of m.items) out.push(it);
      });
      return out;
    };
    const status = () => {
      const out = [];
      for (const s of decl.status) {
        const v = slots.get(s.id);
        if (v.text.trim() === "") continue;
        const r = { id: s.id, title: s.title, text: v.text };
        put(r, "tone", v.tone);
        put(r, "mono", s.mono);
        out.push(r);
      }
      return out;
    };

    const setState = (command, patch) => {
      const it = items.get(command);
      if (!it) throw new Error("setState: " + where + " has no command " + show(command) + "; use a command declared in the view's menus");
      if (!isObj(patch)) throw new Error("setState: command " + command + " needs a patch object such as {enabled: false}, got " + show(patch));
      const s = state.get(command);
      const next = { ...s };
      for (const k of Object.keys(patch)) {
        const v = patch[k];
        if (v === undefined) continue;
        if (k === "enabled" || k === "visible") {
          if (typeof v !== "boolean") throw new Error("setState: command " + command + ": " + k + " must be true or false, got " + show(v));
          next[k] = v;
        } else if (k === "checked") {
          if (it.kind !== "toggle" || typeof v !== "boolean") throw new Error("setState: command " + command + ": checked applies to toggle items and must be true or false; this item is a " + it.kind + " with " + show(v));
          next.checked = v;
        } else if (k === "value") {
          if (it.kind !== "radio" || !it.options.some((o) => o.value === v)) throw new Error("setState: command " + command + ": value applies to radio items and must be one of their options; got " + show(v) + " for a " + it.kind);
          next.value = v;
        } else {
          throw new Error("setState: command " + command + ": unknown field " + show(k) + "; use enabled, visible, checked or value");
        }
      }
      state.set(command, next);
      notify();
    };
    const setStatus = (id, patch) => {
      const slot = slots.get(id);
      if (!slot) throw new Error("setStatus: " + where + " has no status slot " + show(id) + "; declare it in the view's status list");
      if (!isObj(patch)) throw new Error("setStatus: slot " + id + " needs a patch object such as {text: \\"live\\"}, got " + show(patch));
      const next = { text: slot.text, tone: slot.tone };
      for (const k of Object.keys(patch)) {
        const v = patch[k];
        if (v === undefined) continue;
        if (k === "text") {
          if (typeof v !== "string") throw new Error("setStatus: slot " + id + ": text must be a string, got " + show(v) + "; pass a string (use \\"\\" to hide the slot)");
          next.text = v.length > MAX_STATUS_TEXT ? v.slice(0, MAX_STATUS_TEXT - 1) + "\\u2026" : v;
        }
        else if (k === "tone") {
          if (v !== null && !TONES.includes(v)) throw new Error("setStatus: slot " + id + ": tone " + show(v) + " is not one of " + TONES.join(", ") + "; use one of those or null to clear");
          next.tone = v === null ? undefined : v;
        } else throw new Error("setStatus: slot " + id + ": unknown field " + show(k) + "; use text or tone");
      }
      slots.set(id, next);
      notify();
    };
    const onCommand = (fn) => {
      if (typeof fn !== "function") throw new Error("onCommand: " + where + " needs a function (command, arg); pass the view's command handler");
      handler = fn;
    };
    // The chrome calls this when the operator picks an item. Failures come back as {ok:false, reason} for the chrome to show.
    const invoke = (command, arg) => {
      const it = items.get(command);
      if (!it) return { ok: false, reason: "Unknown command " + show(command) + " for this window; reload the page if the menu is stale." };
      const s = state.get(command);
      if (!s.visible || !s.enabled) return { ok: false, reason: it.label + " is not available right now." };
      let value;
      if (it.kind === "toggle") {
        value = arg === undefined ? !s.checked : arg;
        if (typeof value !== "boolean") return { ok: false, reason: it.label + " is a toggle and needs true or false, got " + show(arg) + "." };
      } else if (it.kind === "radio") {
        value = arg;
        if (!it.options.some((o) => o.value === value)) return { ok: false, reason: it.label + " has no option " + show(arg) + "; choose one of the listed options." };
      } else if (arg !== undefined) {
        return { ok: false, reason: it.label + " is an action and takes no argument, got " + show(arg) + "." };
      }
      if (!handler) return { ok: false, reason: it.label + " has no handler yet; the view has not registered one with onCommand, so nothing was done." };
      let optimistic = s;
      if (it.kind === "toggle") optimistic = { ...s, checked: value };
      if (it.kind === "radio") optimistic = { ...s, value: value };
      state.set(command, optimistic);
      try {
        const r = handler(command, value);
        if (r && typeof r.then === "function") r.then(undefined, (err) => report("MenuKit: the handler for " + command + " rejected: " + (err && err.message ? err.message : show(err)) + "; report failures from the handler itself (for example with setStatus)"));
      } catch (err) {
        if (state.get(command) === optimistic) state.set(command, s); // keep a state the handler set itself
        notify();
        return { ok: false, reason: it.label + " failed: " + (err && err.message ? err.message : show(err)) };
      }
      notify();
      return { ok: true };
    };
    const subscribe = (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
    return { declaration: decl, menus, overflow, status, setState, setStatus, onCommand, invoke, subscribe };
  };

  return { MENU_IDS, MENU_TITLES, MAX_ITEMS, MAX_OPTIONS, MAX_STATUS, MAX_LABEL, MAX_STATUS_TEXT, declareView, createWindowModel };
})());
`;
