// Pure model of the top launcher bar (docs/ui-vision.md), shipped as source text like layout.ts and inlined into the
// page as global `LauncherKit`. It decides what the bar shows and how its keys behave; the DOM shell
// (launcherShell.ts) only renders these results. No DOM, fetch, storage, clock or randomness here; tested in
// launcherModel.test.ts through node:vm. Agent-controlled strings (names, ids) are plain data: this module never
// builds markup. Plain JS in the template literal: no backticks, no template interpolation, no backslashes.
//
// Decisions (rationale and reopen triggers are recorded in docs/ui-vision.md):
// - The omnibar accepts open windows (focus), view types not yet shown (open in a new tile), one entry per known
//   agent for each multi-instance view type, and a fixed list of actions. Free text is not a command: a query that
//   matches nothing shows "Nothing matches", it never runs anything. A leading ">" limits the list to actions.
// - Matching is case-insensitive and token-wise: every space-separated token must match the label, kind or hint;
//   a word-start match outranks a plain substring match. No fuzzy subsequence matching.
// - The open key is Alt+Shift+P, read from the physical key code so it works with any layout.
// - buildItems returns every agent entry; rank cuts the result list to MAX_AGENT_ITEMS agent entries per
//   multi-instance view type, after matching. So the unfiltered list is capped, while an agent beyond the cap is
//   still found by a name, prefix or id query.
// - One window-list entry per tile (a layout holds at most 16), in reading order, scrolling sideways; above 6
//   entries the list is compact (shorter labels).

export type Dot = "ok" | "warn" | "err" | "info" | "none";
export interface ViewDef {
  id: string;
  title: string;
  multi: boolean;
}
// A normalized row of GET /v1/agents; name is clipped, unknown fields are dropped.
export interface AgentInfo {
  id: string;
  name: string;
  state: string;
  exit: string | null;
}
export interface LeafLike {
  id: string;
  view: string;
  params: { agent?: string };
}
export type ActionId = "split-right" | "split-down" | "close-tile" | "reset-layout" | "export-layout" | "import-layout" | "sign-out";
export type Run = { type: "focus"; leaf: string } | { type: "open"; view: string; agent?: string } | { type: "action"; id: ActionId };
export type OmniKind = "open" | "new" | "action";
export interface OmniItem {
  key: string; // unique within one list
  kind: OmniKind;
  label: string;
  hint: string; // extra searchable text, shown muted ("" when none)
  dot: Dot;
  run: Run;
}
export interface BuildCtx {
  leaves: LeafLike[];
  focus: string;
  views: ViewDef[];
  agents: AgentInfo[];
  narrow: boolean;
  maxLeaves: number;
  inboxCount: number; // pending approvals + open escalations (0 when unknown)
}

export interface OmniState {
  open: boolean;
  query: string;
  sel: number;
}
export type OmniEvent =
  | { type: "open" }
  | { type: "close" }
  | { type: "toggle" }
  | { type: "input"; text: string }
  | { type: "key"; key: string }
  | { type: "hover"; index: number }
  | { type: "choose"; index: number };
export interface OmniStep {
  state: OmniState;
  // run: the shell executes item.run, then focuses the page (the state is already closed).
  effect: { type: "run"; item: OmniItem } | { type: "refocus" } | null;
}

export interface MenuState {
  open: boolean;
  sel: number;
}
export type MenuEvent =
  | { type: "open" }
  | { type: "close" }
  | { type: "toggle" }
  | { type: "hover"; index: number }
  | { type: "key"; key: string }
  | { type: "choose"; index: number };
export interface MenuEntry {
  kind: "head" | "sep" | "action";
  label: string;
  id?: ActionId;
}
export interface MenuStep {
  state: MenuState;
  effect: { type: "run"; id: ActionId } | { type: "refocus" } | null;
}

export interface WindowEntry {
  leaf: string;
  label: string;
  title: string; // tooltip: the full label plus the state in words
  dot: Dot;
  focused: boolean;
}
export interface WindowList {
  entries: WindowEntry[];
  compact: boolean;
  attention: number; // entries whose dot is err or warn
  label: string; // accessible name of the list, e.g. "Open windows, 2 need attention"
}

export interface ConnState {
  failures: number; // consecutive failed polls
  everOk: boolean;
  cause: string; // last failure cause, "" when none
}
export interface ConnView {
  label: "connecting" | "connected" | "reconnecting" | "offline";
  dot: Dot;
  title: string; // names the cause and what the page is doing about it
}
export interface Badge {
  hidden: boolean; // true when the count is 0
  text: string; // "3", "99+", or "?" when the counts could not be read
  label: string; // accessible name, e.g. "Inbox: 3 waiting"
  count: number;
}
export interface PollInput {
  agents: unknown; // parsed JSON or undefined when the request failed
  approvals: unknown;
  escalations: unknown;
  errors: string[]; // one cause per failed request, "" entries not allowed
}
export interface PollResult {
  agents: AgentInfo[] | null; // null: keep the previous list
  approvals: number | null; // null: unknown, keep the previous count
  escalations: number | null;
  ok: boolean; // true only when agents could be read
  cause: string;
}

export interface LauncherKitApi {
  MAX_AGENT_ITEMS: number;
  COMPACT_AT: number;
  FAIL_OFFLINE_AT: number;
  OPEN_SHORTCUT: string; // human text, "Alt+Shift+P"
  // data
  normalizeAgents(rows: unknown): AgentInfo[]; // junk rows are dropped, not thrown on; at most 1000 rows
  agentDot(agent: AgentInfo | undefined): Dot;
  summarizePoll(input: PollInput): PollResult;
  connNext(prev: ConnState, ok: boolean, cause: string): ConnState;
  connView(s: ConnState): ConnView;
  inboxBadge(approvals: number | null, escalations: number | null): Badge;
  // window list
  windowLabel(leaf: LeafLike, views: ViewDef[], agents: AgentInfo[]): string;
  windowList(leaves: LeafLike[], focus: string, views: ViewDef[], agents: AgentInfo[], inboxCount: number): WindowList;
  // omnibar
  buildItems(ctx: BuildCtx): OmniItem[]; // open windows, then new windows, then actions
  parseQuery(text: string): { actionsOnly: boolean; tokens: string[] };
  rank(items: OmniItem[], text: string): OmniItem[]; // empty query: all items in build order
  isOpenShortcut(ev: { altKey?: boolean; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; code?: string }): boolean;
  omniInitial(): OmniState;
  omniStep(state: OmniState, ev: OmniEvent, shown: OmniItem[]): OmniStep;
  // bar menu (fixed list)
  menuEntries(narrow: boolean): MenuEntry[];
  menuInitial(): MenuState;
  menuStep(state: MenuState, ev: MenuEvent, entries: MenuEntry[]): MenuStep;
}

export const LAUNCHER_LOGIC_JS = `
const LauncherKit = globalThis.LauncherKit || (globalThis.LauncherKit = (() => {
  "use strict";
  // TODO(omnibar-agent-cap): the unfiltered omnibar list is cut to MAX_AGENT_ITEMS entries per item view type, so past 200 agents some are not listed; exact, prefix and id queries still reach every one. Trigger: a fleet routinely exceeds 200 agents per view type.
  const MAX_AGENT_ITEMS = 200;
  const COMPACT_AT = 6;
  const FAIL_OFFLINE_AT = 3;
  // TODO(omnibar-open-key-untested): the omnibar opens on Alt+Shift+P, matched on the physical key code (isOpenShortcut); unverified on other OSes and browsers. Trigger: the key collides with a browser or OS shortcut.
  const OPEN_SHORTCUT = "Alt+Shift+P";
  const MAX_ROWS = 1000;
  const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);
  const isStr = (x) => typeof x === "string";

  function normalizeAgents(rows) {
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const r of rows) {
      if (out.length >= MAX_ROWS) break;
      if (!r || typeof r !== "object" || !isStr(r.id) || r.id === "" || r.id.length > 256) continue;
      out.push({
        id: r.id,
        name: isStr(r.name) && r.name !== "" ? clip(r.name, 80) : clip(r.id, 80),
        state: isStr(r.state) ? r.state : "unknown",
        exit: isStr(r.exit) ? r.exit : null,
      });
    }
    return out;
  }
  function agentDot(a) {
    if (!a) return "none";
    if (a.state === "running") return "ok";
    if (a.state === "pending") return "info";
    if (a.state === "yielded") return "warn";
    if (a.state === "exited" && (a.exit === "failed" || a.exit === "timed_out" || a.exit === "over_budget")) return "err";
    return "none";
  }
  function summarizePoll(input) {
    const agents = Array.isArray(input.agents) ? normalizeAgents(input.agents) : null;
    const count = (x) => (Array.isArray(x) ? x.length : null);
    const ok = agents !== null;
    const errs = [];
    for (const e of input.errors || []) if (isStr(e) && e !== "") errs.push(e);
    let cause = errs.length ? errs[0] : "";
    if (ok && (count(input.approvals) === null || count(input.escalations) === null)) {
      const what = errs.length ? errs.join("; ") : "GET /v1/approvals or /v1/escalations did not return a list";
      cause = "Inbox counts incomplete (" + what + "); the badge may undercount, the page keeps retrying";
    } else if (ok) cause = "";
    if (!ok && cause === "") cause = "GET /v1/agents did not return a list; check that the daemon is running, the page keeps retrying";
    return { agents, approvals: count(input.approvals), escalations: count(input.escalations), ok, cause };
  }
  function connNext(prev, ok, cause) {
    if (ok) return { failures: 0, everOk: true, cause }; // a non-empty cause on ok marks a partial poll
    return { failures: prev.failures + 1, everOk: prev.everOk, cause };
  }
  function connView(s) {
    const why = s.cause === "" ? "no cause reported" : s.cause;
    if (s.failures === 0) {
      if (!s.everOk) return { label: "connecting", dot: "info", title: "Connecting to the daemon; the page keeps retrying" };
      if (s.cause !== "") return { label: "connected", dot: "warn", title: "Connected to the daemon, but " + s.cause };
      return { label: "connected", dot: "ok", title: "Connected to the daemon" };
    }
    if (s.failures < FAIL_OFFLINE_AT) {
      return { label: "reconnecting", dot: "warn", title: "Last request failed (" + why + "); the page keeps retrying" };
    }
    return { label: "offline", dot: "err", title: "Daemon unreachable after " + s.failures + " tries (" + why + "); the page keeps retrying, check that the daemon is running" };
  }
  function inboxBadge(approvals, escalations) {
    if (approvals === null && escalations === null) return { hidden: false, text: "?", label: "Inbox: count unavailable", count: 0 };
    const count = (approvals === null ? 0 : approvals) + (escalations === null ? 0 : escalations);
    if (approvals === null || escalations === null) {
      const shown = count > 99 ? "99+" : count + "+";
      return { hidden: false, text: count === 0 ? "?" : shown, label: "Inbox: at least " + count + " waiting (some counts unavailable)", count };
    }
    return { hidden: count === 0, text: count > 99 ? "99+" : String(count), label: "Inbox: " + count + " waiting", count };
  }

  function viewTitle(leafView, views) {
    for (const v of views) if (v.id === leafView) return v.title === "" ? v.id : v.title;
    return leafView;
  }
  function findAgent(agents, id) {
    for (const a of agents) if (a.id === id) return a;
    return undefined;
  }
  function windowLabel(leaf, views, agents) {
    const t = viewTitle(leaf.view, views);
    const id = leaf.params && leaf.params.agent;
    if (!isStr(id)) return t;
    const a = findAgent(agents, id);
    return t + ": " + (a ? a.name : id);
  }
  function leafDot(leaf, agents, inboxCount) {
    if (leaf.view === "inbox") return inboxCount > 0 ? "warn" : "none";
    const id = leaf.params && leaf.params.agent;
    return isStr(id) ? agentDot(findAgent(agents, id)) : "none";
  }
  function stateWord(leaf, dot, agents) {
    const id = leaf.params && leaf.params.agent;
    if (isStr(id)) {
      const a = findAgent(agents, id);
      return a ? a.state : "unknown";
    }
    if (dot === "warn") return "needs attention";
    if (dot === "err") return "failed";
    return "idle";
  }
  function windowList(leaves, focus, views, agents, inboxCount) {
    const entries = [];
    let attention = 0;
    for (const lf of leaves) {
      const label = windowLabel(lf, views, agents);
      const dot = leafDot(lf, agents, inboxCount);
      if (dot === "err" || dot === "warn") attention++;
      entries.push({ leaf: lf.id, label, title: label + " (" + stateWord(lf, dot, agents) + ")", dot, focused: lf.id === focus });
    }
    let label = "Open windows";
    if (attention > 0) label += ", " + attention + (attention === 1 ? " needs attention" : " need attention");
    return { entries, compact: entries.length > COMPACT_AT, attention, label };
  }

  function buildItems(ctx) {
    const items = [];
    const shownViews = {};
    const shownAgents = {};
    for (const lf of ctx.leaves) {
      shownViews[lf.view] = true;
      const aid = lf.params && lf.params.agent;
      if (isStr(aid)) shownAgents[lf.view + "/" + aid] = true;
      items.push({
        key: "open:" + lf.id,
        kind: "open",
        label: windowLabel(lf, ctx.views, ctx.agents),
        hint: isStr(aid) ? aid + " " + lf.view : lf.view,
        dot: leafDot(lf, ctx.agents, ctx.inboxCount),
        run: { type: "focus", leaf: lf.id },
      });
    }
    for (const v of ctx.views) {
      if (!v.multi) {
        if (!shownViews[v.id]) items.push({ key: "new:" + v.id, kind: "new", label: v.title === "" ? v.id : v.title, hint: v.id, dot: "none", run: { type: "open", view: v.id } });
        continue;
      }
      const t = v.title === "" ? v.id : v.title;
      for (const a of ctx.agents) {
        if (a.state === "reaped" || shownAgents[v.id + "/" + a.id]) continue;
        items.push({ key: "new:" + v.id + "/" + a.id, kind: "new", label: t + ": " + (a.name === "" ? a.id : a.name), hint: a.id + " " + v.id, dot: agentDot(a), run: { type: "open", view: v.id, agent: a.id } });
      }
    }
    const act = (id, label, hint) => items.push({ key: "action:" + id, kind: "action", label, hint, dot: "none", run: { type: "action", id } });
    if (!ctx.narrow) {
      if (ctx.leaves.length < ctx.maxLeaves) {
        act("split-right", "Split right", "layout tile");
        act("split-down", "Split down", "layout tile");
      }
      if (ctx.leaves.length > 1) act("close-tile", "Close tile", "layout window");
    }
    act("reset-layout", "Reset layout", "layout");
    act("export-layout", "Export layout", "layout save");
    act("import-layout", "Import layout", "layout load");
    act("sign-out", "Sign out", "logout");
    return items;
  }

  function parseQuery(text) {
    let t = String(text).trim().toLowerCase();
    let actionsOnly = false;
    if (t.charAt(0) === ">") { actionsOnly = true; t = t.slice(1); }
    const tokens = [];
    let cur = "";
    for (let i = 0; i < t.length; i++) {
      if (t.charCodeAt(i) <= 32) {
        if (cur !== "") tokens.push(cur);
        cur = "";
      } else cur += t.charAt(i);
    }
    if (cur !== "") tokens.push(cur);
    return { actionsOnly, tokens };
  }
  function tokenScore(label, extra, tok) {
    const i = label.indexOf(tok);
    if (i === 0) return 400;
    if (i > 0) {
      let best = 100;
      let from = i;
      while (from >= 0) {
        if (from > 0 && /[^a-z0-9]/.test(label.charAt(from - 1))) { best = 300; break; }
        from = label.indexOf(tok, from + 1);
      }
      return best;
    }
    if (extra.indexOf(tok) >= 0) return 10;
    return 0;
  }
  function rank(items, text) {
    const q = parseQuery(text);
    const scored = [];
    items.forEach((it, idx) => {
      if (q.actionsOnly && it.kind !== "action") return;
      const label = it.label.toLowerCase();
      const extra = it.kind + " " + it.hint.toLowerCase();
      let sum = 0;
      for (const tok of q.tokens) {
        const s = tokenScore(label, extra, tok);
        if (s === 0) return;
        sum += s;
      }
      scored.push({ it, idx, sum });
    });
    scored.sort((a, b) => b.sum - a.sum || a.idx - b.idx);
    // the cap applies after ranking, per multi-instance view type
    const derived = {};
    const out = [];
    for (const s of scored) {
      const r = s.it.run;
      if (r.type === "open" && isStr(r.agent)) {
        derived[r.view] = (derived[r.view] || 0) + 1;
        if (derived[r.view] > MAX_AGENT_ITEMS) continue;
      }
      out.push(s.it);
    }
    return out;
  }
  function isOpenShortcut(ev) {
    return ev.altKey === true && ev.shiftKey === true && ev.ctrlKey !== true && ev.metaKey !== true && ev.code === "KeyP";
  }

  const clampSel = (sel, n) => (n <= 0 ? 0 : Math.min(Math.max(Number.isInteger(sel) ? sel : 0, 0), n - 1));
  function omniInitial() { return { open: false, query: "", sel: 0 }; }
  function omniStep(state, ev, shown) {
    const closed = { open: false, query: "", sel: 0 };
    const opened = { open: true, query: "", sel: 0 };
    const same = (sel) => ({ open: true, query: state.query, sel });
    if (ev.type === "open") return { state: state.open ? same(clampSel(state.sel, shown.length)) : opened, effect: null };
    if (ev.type === "toggle") return { state: state.open ? closed : opened, effect: null };
    if (!state.open) return { state: { open: false, query: state.query, sel: state.sel }, effect: null };
    const n = shown.length;
    const sel = clampSel(state.sel, n);
    if (ev.type === "close") return { state: closed, effect: null };
    if (ev.type === "input") return { state: { open: true, query: String(ev.text), sel: 0 }, effect: null };
    if (ev.type === "hover") return { state: same(clampSel(ev.index, n)), effect: null };
    if (ev.type === "choose") {
      if (!Number.isInteger(ev.index) || ev.index < 0 || ev.index >= n) return { state: same(sel), effect: null };
      return { state: closed, effect: { type: "run", item: shown[ev.index] } };
    }
    if (ev.type === "key") {
      const k = ev.key;
      if (k === "Escape") return { state: closed, effect: { type: "refocus" } };
      if (k === "Enter") {
        if (n === 0) return { state: same(0), effect: null };
        return { state: closed, effect: { type: "run", item: shown[sel] } };
      }
      if (n === 0) return { state: same(0), effect: null };
      if (k === "ArrowDown") return { state: same((sel + 1) % n), effect: null };
      if (k === "ArrowUp") return { state: same((sel + n - 1) % n), effect: null };
      if (k === "Home") return { state: same(0), effect: null };
      if (k === "End") return { state: same(n - 1), effect: null };
    }
    return { state: same(sel), effect: null };
  }

  function menuEntries(narrow) {
    // narrow is accepted for the shell call site; the bar menu is the same fixed list at every width.
    return [
      { kind: "head", label: "Layout" },
      { kind: "action", label: "Export layout", id: "export-layout" },
      { kind: "action", label: "Import layout", id: "import-layout" },
      { kind: "action", label: "Reset layout", id: "reset-layout" },
      { kind: "sep", label: "" },
      { kind: "action", label: "Sign out", id: "sign-out" },
    ];
  }
  function menuInitial() { return { open: false, sel: 0 }; }
  function menuStep(state, ev, entries) {
    const acts = [];
    entries.forEach((e, i) => { if (e.kind === "action") acts.push(i); });
    const first = acts.length ? acts[0] : 0;
    const closed = { open: false, sel: first };
    const opened = { open: true, sel: first };
    if (ev.type === "open") return { state: opened, effect: null };
    if (ev.type === "toggle") return { state: state.open ? closed : opened, effect: null };
    if (!state.open) return { state: { open: false, sel: state.sel }, effect: null };
    if (ev.type === "close") return { state: closed, effect: null };
    let pos = acts.indexOf(state.sel);
    if (pos < 0) pos = 0;
    const cur = acts.length ? acts[pos] : 0;
    const same = (sel) => ({ state: { open: true, sel }, effect: null });
    const runAt = (i) => ({ state: closed, effect: { type: "run", id: entries[i].id } });
    const isAct = (i) => Number.isInteger(i) && acts.indexOf(i) >= 0;
    if (ev.type === "hover") return same(isAct(ev.index) ? ev.index : cur);
    if (ev.type === "choose") return isAct(ev.index) ? runAt(ev.index) : same(cur);
    if (ev.type === "key") {
      const n = acts.length;
      const k = ev.key;
      if (k === "Escape") return { state: closed, effect: { type: "refocus" } };
      if (k === "Tab") return { state: closed, effect: null };
      if (n === 0) return same(0);
      if (k === "Enter" || k === " ") return runAt(cur);
      if (k === "ArrowDown") return same(acts[(pos + 1) % n]);
      if (k === "ArrowUp") return same(acts[(pos + n - 1) % n]);
      if (k === "Home") return same(acts[0]);
      if (k === "End") return same(acts[n - 1]);
    }
    return same(cur);
  }

  return {
    MAX_AGENT_ITEMS, COMPACT_AT, FAIL_OFFLINE_AT, OPEN_SHORTCUT,
    normalizeAgents, agentDot, summarizePoll, connNext, connView, inboxBadge,
    windowLabel, windowList, buildItems, parseQuery, rank, isOpenShortcut,
    omniInitial, omniStep, menuEntries, menuInitial, menuStep,
  };
})());
`;
