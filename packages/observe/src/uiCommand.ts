// The UI-command contract and its pure kit: how the operator CLI drives the web UI (open, focus, close, arrange,
// reset, follow). A command is closed data (never code); the same plain-JS rules run on the daemon (through
// parseUiCommand, which evaluates the kit once in a node:vm context) and in the page (inlined as global
// `UiCommandKit`, after LayoutKit), so the two cannot drift. View, agent and report rules are LayoutKit.single's.
// Only syntax is checked here: the UI knows which views exist. Tested in uiCommand.test.ts. The kit is a template
// literal: no backticks, no template interpolation, no backslashes.
import { createContext, runInContext } from "node:vm";
import { LAYOUT_LOGIC_JS } from "./layout.ts";

// Journal kind (the daemon records it as extension kind ext.observe.ui_command), HTTP route and SSE stream.
export const UI_COMMAND_KIND = "ui_command";
export const UI_COMMAND_PATH = "/v1/ui/command";
export const UI_STREAM_PATH = "/live/ui";
// D4: a command is ephemeral in meaning. On a resumed stream the daemon drops commands older than this, judged on the
// daemon clock that stamped the journal entry. 30 s outlasts an EventSource retry (about 3 s) plus a slow wake, but a
// minute-old "close" cannot surprise anyone.
export const UI_COMMAND_TTL_MS = 30000;

// TODO(ui-arrange-full-layout): arrange takes a preset only; an agent or script cannot set a full layout tree. Trigger: a script needs a layout no preset covers. Per-tab targeting is tracked by the ui-command-target tag in packages/pomtreed/src/builtin/uiDrive.ts.
export const UI_PRESETS = ["single", "columns", "rows", "grid"] as const;
export type UiPreset = (typeof UI_PRESETS)[number];
export const isUiPreset = (v: unknown): v is UiPreset => typeof v === "string" && (UI_PRESETS as readonly string[]).includes(v);

// Which windows `close` closes: absent = the named window; others/left/right are relative to the named window in the
// launcher bar's order; all takes no window.
export const UI_CLOSE_SCOPES = ["others", "left", "right", "all"] as const;
export type UiCloseScope = (typeof UI_CLOSE_SCOPES)[number];

export type UiDir = "left" | "right" | "up" | "down";
export type UiCommand =
  | { cmd: "open"; view: string; agent?: string; report?: string }
  | { cmd: "focus"; view: string; agent?: string; report?: string }
  | { cmd: "focus"; dir: UiDir }
  | { cmd: "close"; view: string; agent?: string; report?: string; scope?: UiCloseScope }
  | { cmd: "close"; scope: "all" }
  | { cmd: "maximize"; view: string; agent?: string; report?: string }
  | { cmd: "minimize"; view: string; agent?: string; report?: string }
  | { cmd: "restore"; view?: string; agent?: string; report?: string }
  | { cmd: "arrange"; preset: UiPreset }
  | { cmd: "reset" }
  | { cmd: "follow"; on: boolean; views?: string[]; of?: string };

export type UiFrame = { type: "command"; seq: number; ts: number; command: UiCommand } | { type: "spawned"; seq: number; agent: string; parent: string };

export type UiParseResult = { ok: true; command: UiCommand } | { ok: false; error: string };

export const UI_COMMAND_JS = `
const UiCommandKit = globalThis.UiCommandKit || (globalThis.UiCommandKit = (() => {
  "use strict";
  const MAX_BODY = 2048;
  const MAX_ID = 256;
  const MAX_VIEWS = 4;
  const CMDS = ["open", "focus", "close", "maximize", "minimize", "restore", "arrange", "reset", "follow"];
  const SCOPES = ["others", "left", "right", "all"];
  const DIRS = ["left", "right", "up", "down"];
  const PRESETS = ["single", "columns", "rows", "grid"];
  const VIEW_RE = /^[a-z][a-z0-9-]{0,63}$/;
  const SUBJECT_KEYS = ["agent", "report"];
  const MAX_NEXT = 999999990;

  const plainObject = (o) => !!o && typeof o === "object" && !Array.isArray(o);
  const show = (v) => {
    const s = typeof v === "string" ? JSON.stringify(v) : String(v);
    return s.length > 40 ? s.slice(0, 40) + "..." : s;
  };
  const err = (error) => ({ ok: false, error });

  const usage = (cmd) => cmd + " needs " + JSON.stringify("view") + " (for example " + JSON.stringify({ cmd, view: "terminal", agent: "<id>" }) + ")";

  // Rejects any key outside the allowed list, naming the first offender; null when all are allowed.
  const unknownKey = (raw, allowed) => {
    for (const k of Object.keys(raw)) {
      if (k !== "cmd" && allowed.indexOf(k) < 0) return "unknown key " + JSON.stringify(k) + " in the command; allowed keys for " + raw.cmd + " are: " + allowed.join(", ") + ". Remove it";
    }
    return null;
  };

  const subject = (raw) => {
    const params = {};
    for (const k of SUBJECT_KEYS) {
      if (raw[k] === undefined) continue;
      if (typeof raw[k] !== "string") return { error: JSON.stringify(k) + " must be a string id, got " + show(raw[k]) + "; pass the id as text" };
      if (raw[k].length > MAX_ID) return { error: JSON.stringify(k) + " is over " + MAX_ID + " characters; use the agent or report id as printed by pomtree" };
      params[k] = raw[k];
    }
    if (params.report !== undefined && params.agent === undefined) return { error: "report needs " + JSON.stringify("agent") + " (a report id belongs to one agent); add the agent id" };
    return { params };
  };

  const viewCommand = (raw) => {
    const bad = unknownKey(raw, ["view", "agent", "report"]);
    if (bad) return err(bad);
    if (typeof raw.view !== "string") return err(usage(raw.cmd));
    const s = subject(raw);
    if (s.error) return err(s.error);
    if (!LayoutKit.single(raw.view, s.params)) return err("view " + show(raw.view) + " is not a valid view id; use lowercase letters, digits and hyphens, starting with a letter (for example terminal)");
    const out = { cmd: raw.cmd, view: raw.view };
    if (s.params.agent !== undefined) out.agent = s.params.agent;
    if (s.params.report !== undefined) out.report = s.params.report;
    return { ok: true, command: out };
  };

  // close: a view window, or with scope others/left/right the windows around it, or scope all (no window named).
  const closeCommand = (raw) => {
    if (raw.scope === undefined) return viewCommand(raw);
    if (SCOPES.indexOf(raw.scope) < 0) return err("close scope " + show(raw.scope) + " is not a scope; use one of " + SCOPES.join(", ") + " or omit it to close the named window");
    if (raw.scope === "all") {
      const extra = ["view", "agent", "report"].filter((k) => raw[k] !== undefined)[0];
      if (extra) return err("close scope " + JSON.stringify("all") + " closes every window and takes no " + JSON.stringify(extra) + "; remove it (for example " + JSON.stringify({ cmd: "close", scope: "all" }) + ")");
      const bad = unknownKey(raw, ["scope"]);
      return bad ? err(bad) : { ok: true, command: { cmd: "close", scope: "all" } };
    }
    const rest = Object.assign({}, raw);
    delete rest.scope;
    const r = viewCommand(rest);
    if (r.ok) r.command.scope = raw.scope;
    return r;
  };

  // restore: like the other window commands, but the view is optional (no view un-maximizes).
  const restoreCommand = (raw) => {
    if (raw.view !== undefined) return viewCommand(raw);
    const bad = unknownKey(raw, ["view", "agent", "report"]);
    if (bad) return err(bad);
    const extra = SUBJECT_KEYS.filter((k) => raw[k] !== undefined)[0];
    if (extra) return err("restore with " + JSON.stringify(extra) + " needs " + JSON.stringify("view") + " too (for example " + JSON.stringify({ cmd: "restore", view: "terminal", agent: "<id>" }) + "); add the view or drop " + JSON.stringify(extra));
    return { ok: true, command: { cmd: "restore" } };
  };

  const focusCommand = (raw) => {
    const hasView = raw.view !== undefined;
    const hasDir = raw.dir !== undefined;
    if (hasView && hasDir) return err("focus takes " + JSON.stringify("view") + " or " + JSON.stringify("dir") + ", not both; drop one of them");
    if (!hasDir) {
      if (!hasView) return err("focus needs " + JSON.stringify("view") + " or " + JSON.stringify("dir") + " (for example " + JSON.stringify({ cmd: "focus", dir: "left" }) + ")");
      return viewCommand(raw);
    }
    const bad = unknownKey(raw, ["dir"]);
    if (bad) return err(bad);
    if (DIRS.indexOf(raw.dir) < 0) return err("dir " + show(raw.dir) + " is not a direction; use one of " + DIRS.join(", "));
    return { ok: true, command: { cmd: "focus", dir: raw.dir } };
  };

  const arrangeCommand = (raw) => {
    const bad = unknownKey(raw, ["preset"]);
    if (bad) return err(bad);
    if (PRESETS.indexOf(raw.preset) < 0) return err("arrange needs " + JSON.stringify("preset") + " " + show(raw.preset) + " to be one of " + PRESETS.join(", ") + "; pick one");
    return { ok: true, command: { cmd: "arrange", preset: raw.preset } };
  };

  const followCommand = (raw) => {
    const bad = unknownKey(raw, ["on", "views", "of"]);
    if (bad) return err(bad);
    if (typeof raw.on !== "boolean") return err("follow needs " + JSON.stringify("on") + " as true or false (for example " + JSON.stringify({ cmd: "follow", on: true }) + ")");
    const out = { cmd: "follow", on: raw.on };
    if (raw.views !== undefined) {
      const v = raw.views;
      const fix = "; pass 1 to " + MAX_VIEWS + " different view ids such as " + JSON.stringify(["terminal"]);
      if (!Array.isArray(v) || v.length < 1 || v.length > MAX_VIEWS) return err("follow views must be an array of 1 to " + MAX_VIEWS + " view ids" + fix);
      for (const x of v) if (typeof x !== "string" || !VIEW_RE.test(x)) return err("follow views has an invalid view id " + show(x) + fix);
      if (new Set(v).size !== v.length) return err("follow views has a repeated view id" + fix);
      out.views = v.slice();
    }
    if (raw.of !== undefined) {
      if (typeof raw.of !== "string" || raw.of.length < 1 || raw.of.length > MAX_ID) return err("follow " + JSON.stringify("of") + " must be a non-empty agent id of at most " + MAX_ID + " characters; pass the parent agent id or omit it");
      out.of = raw.of;
    }
    return { ok: true, command: out };
  };

  const parse = (raw) => {
    try {
      if (!plainObject(raw)) return err("command must be a JSON object (for example " + JSON.stringify({ cmd: "reset" }) + "); send one object");
      const text = JSON.stringify(raw);
      if (text.length > MAX_BODY) return err("command is " + text.length + " characters, over the " + MAX_BODY + " limit; send a smaller command");
      if (CMDS.indexOf(raw.cmd) < 0) return err("cmd " + show(raw.cmd) + " is not a command; use one of " + CMDS.join(", "));
      if (raw.cmd === "open" || raw.cmd === "maximize" || raw.cmd === "minimize") return viewCommand(raw);
      if (raw.cmd === "close") return closeCommand(raw);
      if (raw.cmd === "restore") return restoreCommand(raw);
      if (raw.cmd === "focus") return focusCommand(raw);
      if (raw.cmd === "arrange") return arrangeCommand(raw);
      if (raw.cmd === "follow") return followCommand(raw);
      const bad = unknownKey(raw, []);
      return bad ? err(bad) : { ok: true, command: { cmd: "reset" } };
    } catch (e) {
      return err("command could not be read (" + String(e && e.message ? e.message : e) + "); send plain JSON data");
    }
  };

  // Near-square tiling: a balanced binary tree over the leaves in reading order. Each split gives the first child
  // its share of the leaves as the ratio, so equal-count tiles get equal area. Split ids continue from layout.next.
  const build = (leaves, dirOf, depth, counter) => {
    if (leaves.length === 1) return leaves[0];
    const k = Math.ceil(leaves.length / 2);
    const id = "s" + counter.n++;
    const a = build(leaves.slice(0, k), dirOf, depth + 1, counter);
    const b = build(leaves.slice(k), dirOf, depth + 1, counter);
    return { kind: "split", id, dir: dirOf(depth), ratio: k / leaves.length, children: [a, b] };
  };

  // Re-tiles the CURRENT leaves (view, params and ids kept; focus kept). Null for an empty layout, an unknown preset
  // or a result LayoutKit.parse would refuse.
  const tile = (layout, preset) => {
    if (PRESETS.indexOf(preset) < 0 || !layout || !layout.root) return null;
    const all = LayoutKit.leaves(layout);
    if (all.length === 0) return null;
    const focused = all.filter((l) => l.id === layout.focus)[0] || all[0];
    const leaves = preset === "single" ? [focused] : all;
    if (layout.next + leaves.length > MAX_NEXT) return null;
    const dirOf = preset === "columns" ? () => "row" : preset === "rows" ? () => "col" : (d) => (d % 2 === 0 ? "row" : "col");
    const root = build(leaves.map((l) => ({ kind: "leaf", id: l.id, view: l.view, params: Object.assign({}, l.params) })), dirOf, 0, { n: layout.next });
    const next = layout.next + leaves.length - 1;
    const res = LayoutKit.parse(JSON.stringify({ version: 1, next: Math.max(next, layout.next), focus: focused.id, root }));
    return res.ok ? res.layout : null;
  };

  const str = (v) => typeof v === "string";
  const parseFrame = (text) => {
    let f;
    try { f = JSON.parse(text); } catch (e) { return null; }
    if (!plainObject(f) || typeof f.seq !== "number" || !isFinite(f.seq) || !Number.isInteger(f.seq) || f.seq < 0) return null;
    if (f.type === "spawned") return str(f.agent) && str(f.parent) ? { type: "spawned", seq: f.seq, agent: f.agent, parent: f.parent } : null;
    if (f.type === "command") {
      if (typeof f.ts !== "number" || !isFinite(f.ts) || f.ts < 0) return null;
      const r = parse(f.command);
      return r.ok ? { type: "command", seq: f.seq, ts: f.ts, command: r.command } : null;
    }
    return null;
  };

  return { parse, tile, parseFrame };
})());
`;

interface Kit {
  parse(raw: unknown): UiParseResult;
  parseFrame(text: string): UiFrame | null;
}
let kit: Kit | undefined;
// Evaluated once, lazily, in its own context so the kit's globals never touch the host realm.
const load = (): Kit => {
  if (!kit) {
    const ctx = createContext({ globalThis: {}, JSON, Math, Number, String, isFinite, Object, Array, Set });
    runInContext(LAYOUT_LOGIC_JS, ctx);
    kit = runInContext(`${UI_COMMAND_JS}; UiCommandKit`, ctx) as Kit;
  }
  return kit;
};
// Results are copied through JSON so no vm-realm object (with a foreign prototype) leaks to callers.
const plain = <T>(x: unknown): T => JSON.parse(JSON.stringify(x)) as T;

export const parseUiCommand = (raw: unknown): UiParseResult => plain<UiParseResult>(load().parse(raw));
export const parseUiFrame = (text: string): UiFrame | null => plain<UiFrame | null>(load().parseFrame(text));
