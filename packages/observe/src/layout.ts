// Pure tiling-layout logic for the operator web UI, shipped as source text (like termKit.ts) and inlined into the
// page as global `LayoutKit`. A layout is a binary tiling tree of leaves (one view each) and splits; every function
// returns a new layout and never mutates its input, and an invalid operation returns the input itself (same
// reference) so callers can detect a no-op. No DOM, storage, clock or randomness here; tested in layout.test.ts.
// Stored data is only view ids, agent ids and report ids. Plain JS, no backticks and no template interpolation (it is a
// template literal, so it must also contain no backslashes).
// TODO(ui-floating-windows): windows tile only; there are no floating or overlapping windows. Trigger: an operator asks for floating windows or overlays.

export type ViewId = string;
// The closed set of leaf params: the subject a window shows. A report id is per agent, so report requires agent.
export interface LeafParams {
  agent?: string;
  report?: string;
}
// What a view needs to be shown: "agent" (an agent id) or "report" (an agent id and a report id).
export type Subject = "agent" | "report";
export interface LeafNode {
  kind: "leaf";
  id: string;
  view: ViewId;
  params: LeafParams;
  // Minimized: kept in the tree and listed in the launcher bar, but not tiled. The key is absent when not hidden.
  hidden?: true;
}
export interface SplitNode {
  kind: "split";
  id: string;
  dir: "row" | "col";
  ratio: number;
  children: [LayoutNode, LayoutNode];
}
export type LayoutNode = LeafNode | SplitNode;
export interface Layout {
  version: 1;
  next: number;
  // "" when the layout is empty.
  focus: string;
  // Null for an empty layout (every window closed); an empty layout is valid, stored and parsed like any other.
  root: LayoutNode | null;
  // The id of the maximized leaf (it fills the whole tiling area; the tree underneath is untouched). The key is absent
  // when nothing is maximized; the named leaf exists and is not hidden.
  max?: string;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface SplitRect extends Rect {
  id: string;
  dir: "row" | "col";
  ratio: number;
}
export type Edge = "left" | "right" | "top" | "bottom" | "center";
export type FocusDir = "left" | "right" | "up" | "down";
export type ParseResult = { ok: true; layout: Layout; unknown: string[] } | { ok: false; reason: string };

export interface LayoutKitApi {
  MAX_LEAVES: number;
  MAX_DEPTH: number;
  MAX_TEXT: number;
  DEFAULT_MIN_RATIO: number;
  // Null when view or params break the leaf rules that parse enforces (the caller falls back to its default layout).
  single(view: ViewId, params?: LeafParams): Layout | null;
  split(layout: Layout, leafId: string, dir: "row" | "col", view: ViewId, params?: LeafParams, place?: "after" | "before"): Layout;
  close(layout: Layout, leafId: string): Layout;
  resize(layout: Layout, splitId: string, ratio: number, minRatio?: number): Layout;
  move(layout: Layout, fromLeafId: string, toLeafId: string, edge: Edge): Layout;
  focus(layout: Layout, leafId: string): Layout;
  focusDir(layout: Layout, dir: FocusDir): Layout;
  // Rects of the shown leaves only: the maximized leaf alone fills the unit square; otherwise hidden subtrees collapse.
  rects(layout: Layout): Record<string, Rect>;
  // The splits with two shown subtrees (none while a leaf is maximized), with their geometry on the collapsed tiling.
  splits(layout: Layout): SplitRect[];
  // Every leaf in reading order, hidden ones included (the launcher bar's order).
  leaves(layout: Layout): LeafNode[];
  visibleLeaves(layout: Layout): LeafNode[];
  // The maximized leaf id, "" when none.
  maximized(layout: Layout): string;
  closeOthers(layout: Layout, leafId: string): Layout;
  // Left and right follow leaves() order.
  closeLeft(layout: Layout, leafId: string): Layout;
  closeRight(layout: Layout, leafId: string): Layout;
  closeAll(layout: Layout): Layout;
  maximize(layout: Layout, leafId: string): Layout;
  // No id: clear the maximized state. A hidden id is unhidden and focused; the maximized id is un-maximized.
  restore(layout: Layout, leafId?: string | null): Layout;
  minimize(layout: Layout, leafId: string): Layout;
  setView(layout: Layout, leafId: string, view: ViewId, params?: LeafParams): Layout;
  open(layout: Layout, view: ViewId, params?: LeafParams, multi?: boolean): Layout;
  find(layout: Layout, view: ViewId, params?: LeafParams, multi?: boolean): string | null;
  // A string equal for two params exactly when they name the same subject (agent and report).
  subjectKey(params?: LeafParams): string;
  serialize(layout: Layout): string;
  // opts.subjects maps a view id to the subject a leaf of that view must carry; views not in it need none.
  parse(text: string, opts?: { views?: string[]; subjects?: Record<string, Subject> }): ParseResult;
}

export const LAYOUT_LOGIC_JS = `
const LayoutKit = globalThis.LayoutKit || (globalThis.LayoutKit = (() => {
  "use strict";
  const VERSION = 1;
  const MAX_LEAVES = 16;
  const MAX_DEPTH = 8; // edges from the root to a leaf
  const MAX_TEXT = 65536;
  const MAX_PARAM = 256; // longest agent id or report id
  const PARAM_KEYS = ["agent", "report"];
  const MAX_NEXT = 999999990; // keeps every id at 9 digits or fewer
  const DEFAULT_MIN_RATIO = 0.1;
  const FLOOR_MIN_RATIO = 0.001; // ratios stay strictly inside (0,1), which parse requires
  const EPS = 1e-9;
  const VIEW_RE = /^[a-z][a-z0-9-]{0,63}$/;
  const LEAF_ID_RE = /^t[0-9]{1,9}$/;
  const SPLIT_ID_RE = /^s[0-9]{1,9}$/;

  const show = (v) => {
    const s = typeof v === "string" ? JSON.stringify(v) : String(v);
    return s.length > 40 ? s.slice(0, 40) + "..." : s;
  };
  const plainObject = (o) => !!o && typeof o === "object" && !Array.isArray(o);
  const cleanParams = (p) => {
    const out = {};
    if (p && typeof p.agent === "string") out.agent = p.agent;
    if (p && typeof p.report === "string") out.report = p.report;
    return out;
  };
  const agentOf = (p) => (p && typeof p.agent === "string" ? p.agent : null);
  const reportOf = (p) => (p && typeof p.report === "string" ? p.report : null);
  const subjectKey = (p) => JSON.stringify([agentOf(p), reportOf(p)]);
  const mkLeaf = (id, view, params, hidden) => {
    const lf = { kind: "leaf", id, view, params: cleanParams(params) };
    if (hidden === true) lf.hidden = true;
    return lf;
  };
  // The one place a layout is rebuilt: o overrides next, focus, root or max; max is carried and omitted when unset.
  const mk = (layout, o) => {
    const out = {
      version: VERSION,
      next: "next" in o ? o.next : layout.next,
      focus: "focus" in o ? o.focus : layout.focus,
      root: "root" in o ? o.root : layout.root,
    };
    const m = "max" in o ? o.max : layout.max;
    if (m) out.max = m;
    return out;
  };
  const mkSplit = (id, dir, ratio, a, b) => ({ kind: "split", id, dir, ratio, children: [a, b] });

  // The one source of the leaf rules, shared by parse and every constructor: a problem description, or null when the
  // view id and params are storable. Absent params (undefined) read as empty.
  const leafProblem = (view, params) => {
    if (typeof view !== "string" || !VIEW_RE.test(view)) return "has an invalid view id " + show(view);
    const p = params === undefined ? {} : params;
    if (!plainObject(p)) return "params is not an object";
    const keys = Object.keys(p);
    for (const k of keys) if (PARAM_KEYS.indexOf(k) < 0) return "params has unsupported key " + show(k);
    for (const k of keys) if (typeof p[k] !== "string" || p[k].length > MAX_PARAM) return "params." + k + " is not a string of at most " + MAX_PARAM + " characters";
    if (keys.indexOf("report") >= 0 && keys.indexOf("agent") < 0) return "params.report needs params.agent (a report id belongs to one agent)";
    return null;
  };
  const badLeaf = (lf) => leafProblem(lf.view, lf.params) !== null;

  // Null (not a layout) when view or params are invalid; every other operation returns its input instead.
  const single = (view, params) => (leafProblem(view, params) ? null : { version: VERSION, next: 2, focus: "t1", root: mkLeaf("t1", view, params) });

  const leavesOf = (n, out) => {
    if (n.kind === "leaf") out.push(n);
    else { leavesOf(n.children[0], out); leavesOf(n.children[1], out); }
    return out;
  };
  const leaves = (layout) => (layout.root ? leavesOf(layout.root, []) : []);
  const visibleLeaves = (layout) => leaves(layout).filter((l) => l.hidden !== true);
  const leafById = (layout, id) => {
    const p = layout.root ? pathTo(layout.root, id, []) : null;
    return p && p[p.length - 1].kind === "leaf" ? p[p.length - 1] : null;
  };
  const maximized = (layout) => (layout.max ? layout.max : "");
  const shown = (n) => (n.kind === "leaf" ? n.hidden !== true : shown(n.children[0]) || shown(n.children[1]));
  // The first visible leaf of root in reading order, "" when none.
  const firstVisible = (root) => {
    const v = root ? leavesOf(root, []).filter((l) => l.hidden !== true) : [];
    return v.length ? v[0].id : "";
  };
  // Focus after leafId leaves the tiling (closed or hidden): the visible edge leaf of its sibling subtree, as close
  // always did, else the first visible leaf in reading order, "" when none is left.
  const refocus = (layout, leafId, root) => {
    const path = leafPath(layout, leafId);
    if (path && path.length >= 2) {
      const parent = path[path.length - 2];
      const idx = parent.children[0].id === leafId ? 0 : 1;
      const vis = leavesOf(parent.children[1 - idx], []).filter((l) => l.hidden !== true);
      if (vis.length) return (idx === 0 ? vis[0] : vis[vis.length - 1]).id;
    }
    return firstVisible(root);
  };

  // Nodes from the root down to the node with this id, or null.
  const pathTo = (n, id, acc) => {
    if (!n) return null;
    acc.push(n);
    if (n.id === id) return acc;
    if (n.kind === "split" && (pathTo(n.children[0], id, acc) || pathTo(n.children[1], id, acc))) return acc;
    acc.pop();
    return null;
  };
  const leafPath = (layout, id) => {
    const p = pathTo(layout.root, id, []);
    return p && p[p.length - 1].kind === "leaf" ? p : null;
  };
  // Rebuilds only the spine above the node with this id; untouched subtrees are shared.
  const replace = (n, id, fn) => {
    if (n.id === id) return fn(n);
    if (n.kind !== "split") return n;
    const a = replace(n.children[0], id, fn);
    const b = replace(n.children[1], id, fn);
    return a === n.children[0] && b === n.children[1] ? n : mkSplit(n.id, n.dir, n.ratio, a, b);
  };
  const maxDepth = (n) => (n.kind === "leaf" ? 0 : 1 + Math.max(maxDepth(n.children[0]), maxDepth(n.children[1])));

  // Removes a leaf: its sibling takes the parent's place. Null for an unknown id or the only leaf.
  const detach = (layout, leafId) => {
    const path = leafPath(layout, leafId);
    if (!path || path.length < 2) return null;
    const parent = path[path.length - 2];
    const idx = parent.children[0].id === leafId ? 0 : 1;
    const sibling = parent.children[1 - idx];
    const root = parent === layout.root ? sibling : replace(layout.root, parent.id, () => sibling);
    return { root, sibling, idx, leaf: path[path.length - 1] };
  };

  const split = (layout, leafId, dir, view, params, place) => {
    if (dir !== "row" && dir !== "col") return layout;
    if (leafProblem(view, params)) return layout;
    const path = leafPath(layout, leafId);
    if (!path || path.length - 1 >= MAX_DEPTH) return layout;
    if (leaves(layout).length >= MAX_LEAVES || layout.next + 2 > MAX_NEXT) return layout;
    const nl = mkLeaf("t" + layout.next, view, params);
    const sid = "s" + (layout.next + 1);
    const root = replace(layout.root, leafId, (old) => (place === "before" ? mkSplit(sid, dir, 0.5, nl, old) : mkSplit(sid, dir, 0.5, old, nl)));
    return mk(layout, { next: layout.next + 2, focus: nl.id, root, max: undefined });
  };

  // Closing the focused leaf moves focus to the sibling subtree's leaf nearest to where it was (first leaf if it
  // was the first child, else last); closing any other leaf keeps focus. Closing the only leaf leaves an empty layout.
  const close = (layout, leafId) => {
    if (layout.root && layout.root.kind === "leaf" && layout.root.id === leafId) return mk(layout, { focus: "", root: null, max: undefined });
    const d = detach(layout, leafId);
    if (!d) return layout;
    const focus = layout.focus === leafId ? refocus(layout, leafId, d.root) : layout.focus;
    return mk(layout, { focus, root: d.root, max: layout.max === leafId ? undefined : layout.max });
  };

  // Drops every leaf in the set, keeping the ids and ratios of what stays; a split left with one child is replaced by it.
  const prune = (n, gone) => {
    if (n.kind === "leaf") return gone[n.id] ? null : n;
    const a = prune(n.children[0], gone);
    const b = prune(n.children[1], gone);
    if (a === n.children[0] && b === n.children[1]) return n;
    return a && b ? mkSplit(n.id, n.dir, n.ratio, a, b) : a || b;
  };
  // Closes the leaves picked by want(index of the kept leaf, index of the candidate); a no-op when none is picked.
  // A closed focus moves to the kept leaf (or, when that one is hidden, the first visible survivor); a surviving max
  // is the focus.
  const closeWhere = (layout, leafId, want) => {
    const all = leaves(layout);
    const at = all.findIndex((l) => l.id === leafId);
    if (at < 0) return layout;
    const gone = {};
    let n = 0;
    all.forEach((l, i) => { if (i !== at && want(at, i)) { gone[l.id] = true; n++; } });
    if (!n) return layout;
    const root = prune(layout.root, gone);
    let focus = layout.focus;
    if (gone[focus]) focus = all[at].hidden === true ? firstVisible(root) : leafId;
    const max = gone[layout.max] ? undefined : layout.max;
    return mk(layout, { focus: max || focus, root, max });
  };
  const closeOthers = (layout, leafId) => closeWhere(layout, leafId, () => true);
  const closeLeft = (layout, leafId) => closeWhere(layout, leafId, (at, i) => i < at);
  const closeRight = (layout, leafId) => closeWhere(layout, leafId, (at, i) => i > at);
  const closeAll = (layout) => (layout.root ? mk(layout, { focus: "", root: null, max: undefined }) : layout);

  // Maximize also unhides the leaf and focuses it; restore and minimize are its inverses (see the API comments).
  const maximize = (layout, leafId) => {
    const lf = leafById(layout, leafId);
    if (!lf) return layout;
    if (layout.max === leafId && layout.focus === leafId) return layout;
    const root = lf.hidden === true ? replace(layout.root, leafId, () => mkLeaf(lf.id, lf.view, lf.params)) : layout.root;
    return mk(layout, { focus: leafId, root, max: leafId });
  };
  const restore = (layout, leafId) => {
    if (leafId === undefined || leafId === null || leafId === "") return layout.max ? mk(layout, { max: undefined }) : layout;
    const lf = leafById(layout, leafId);
    if (!lf) return layout;
    if (lf.hidden === true) return focus(layout, leafId);
    return layout.max === leafId ? mk(layout, { max: undefined }) : layout;
  };
  const minimize = (layout, leafId) => {
    const lf = leafById(layout, leafId);
    if (!lf || lf.hidden === true) return layout;
    const root = replace(layout.root, leafId, () => mkLeaf(lf.id, lf.view, lf.params, true));
    const focusId = layout.focus === leafId ? refocus(layout, leafId, root) : layout.focus;
    return mk(layout, { focus: focusId, root, max: layout.max === leafId ? undefined : layout.max });
  };

  const resize = (layout, splitId, ratio, minRatio) => {
    if (typeof ratio !== "number" || !isFinite(ratio)) return layout;
    let m = typeof minRatio === "number" && isFinite(minRatio) ? minRatio : DEFAULT_MIN_RATIO;
    m = Math.min(0.5, Math.max(FLOOR_MIN_RATIO, m));
    const r = Math.min(1 - m, Math.max(m, ratio));
    const path = pathTo(layout.root, splitId, []);
    const node = path && path[path.length - 1];
    if (!node || node.kind !== "split" || node.ratio === r) return layout;
    const root = replace(layout.root, splitId, (s) => mkSplit(s.id, s.dir, r, s.children[0], s.children[1]));
    return mk(layout, { root });
  };

  const EDGES = { left: ["row", true], right: ["row", false], top: ["col", true], bottom: ["col", false] };

  // Center swaps the two leaves' view and params (focus follows the dragged content to the target tile). An edge
  // detaches "from" and splits "to" there; the moved leaf keeps its id and gets focus.
  const move = (layout, fromId, toId, edge) => {
    if (fromId === toId || layout.max) return layout;
    const a = leafPath(layout, fromId);
    const b = leafPath(layout, toId);
    if (!a || !b) return layout;
    const from = a[a.length - 1];
    const to = b[b.length - 1];
    if (from.hidden === true || to.hidden === true || badLeaf(from) || badLeaf(to)) return layout;
    if (edge === "center") {
      let root = replace(layout.root, fromId, () => mkLeaf(fromId, to.view, to.params));
      root = replace(root, toId, () => mkLeaf(toId, from.view, from.params));
      return mk(layout, { focus: toId, root });
    }
    const e = EDGES[edge];
    if (!e || layout.next + 1 > MAX_NEXT) return layout;
    const d = detach(layout, fromId);
    if (!d) return layout;
    const sid = "s" + layout.next;
    const root = replace(d.root, toId, (old) => (e[1] ? mkSplit(sid, e[0], 0.5, from, old) : mkSplit(sid, e[0], 0.5, old, from)));
    if (maxDepth(root) > MAX_DEPTH) return layout;
    return mk(layout, { next: layout.next + 1, focus: fromId, root });
  };

  // Focusing a hidden leaf unhides it; while a leaf is maximized the maximized state follows focus (bar entries act
  // as tabs).
  const focus = (layout, leafId) => {
    const lf = leafById(layout, leafId);
    if (!lf) return layout;
    const hidden = lf.hidden === true;
    if (layout.focus === leafId && !hidden && (!layout.max || layout.max === leafId)) return layout;
    const root = hidden ? replace(layout.root, leafId, () => mkLeaf(lf.id, lf.view, lf.params)) : layout.root;
    return mk(layout, { focus: leafId, root, max: layout.max ? leafId : undefined });
  };

  // Walks the shown tiling: a split with one fully hidden child gives the other child its whole area.
  const walk = (layout, onLeaf, onSplit) => {
    const go = (n, x, y, w, h) => {
      if (n.kind === "leaf") { if (n.hidden !== true) onLeaf(n, x, y, w, h); return; }
      const sa = shown(n.children[0]);
      const sb = shown(n.children[1]);
      if (!sa || !sb) {
        if (sa || sb) go(n.children[sa ? 0 : 1], x, y, w, h);
        return;
      }
      if (onSplit) onSplit(n, x, y, w, h);
      if (n.dir === "row") {
        const w1 = w * n.ratio;
        go(n.children[0], x, y, w1, h);
        go(n.children[1], x + w1, y, w - w1, h);
      } else {
        const h1 = h * n.ratio;
        go(n.children[0], x, y, w, h1);
        go(n.children[1], x, y + h1, w, h - h1);
      }
    };
    if (layout.root) go(layout.root, 0, 0, 1, 1);
  };
  const rects = (layout) => {
    const out = {};
    if (layout.max) { out[layout.max] = { x: 0, y: 0, w: 1, h: 1 }; return out; }
    walk(layout, (n, x, y, w, h) => { out[n.id] = { x, y, w, h }; }, null);
    return out;
  };
  const splits = (layout) => {
    const out = [];
    if (layout.max) return out;
    walk(layout, () => {}, (n, x, y, w, h) => { out.push({ id: n.id, dir: n.dir, ratio: n.ratio, x, y, w, h }); });
    return out;
  };

  // The adjacent leaf in that direction with the largest overlap on the cross axis; ties go to reading order.
  const focusDir = (layout, dir) => {
    if (dir !== "left" && dir !== "right" && dir !== "up" && dir !== "down") return layout;
    const r = rects(layout);
    const f = r[layout.focus];
    if (!f) return layout;
    let best = null;
    let bestOv = EPS;
    for (const lf of leaves(layout)) {
      if (lf.id === layout.focus) continue;
      const c = r[lf.id];
      if (!c) continue;
      let adj;
      let ov;
      if (dir === "left" || dir === "right") {
        adj = dir === "right" ? Math.abs(c.x - (f.x + f.w)) < EPS : Math.abs(c.x + c.w - f.x) < EPS;
        ov = Math.min(c.y + c.h, f.y + f.h) - Math.max(c.y, f.y);
      } else {
        adj = dir === "down" ? Math.abs(c.y - (f.y + f.h)) < EPS : Math.abs(c.y + c.h - f.y) < EPS;
        ov = Math.min(c.x + c.w, f.x + f.w) - Math.max(c.x, f.x);
      }
      if (adj && ov > bestOv) { best = lf; bestOv = ov; }
    }
    return best ? focus(layout, best.id) : layout;
  };

  const setView = (layout, leafId, view, params) => {
    if (leafProblem(view, params)) return layout;
    const path = leafPath(layout, leafId);
    if (!path) return layout;
    const old = path[path.length - 1];
    if (old.view === view && subjectKey(old.params) === subjectKey(params)) return layout;
    const root = replace(layout.root, leafId, () => mkLeaf(leafId, view, params, old.hidden));
    return mk(layout, { root });
  };

  // First leaf in reading order showing this view (for multi views, the same agent and report too), else null.
  const find = (layout, view, params, multi) => {
    const key = subjectKey(params);
    for (const lf of leaves(layout)) {
      if (lf.view === view && (!multi || subjectKey(lf.params) === key)) return lf.id;
    }
    return null;
  };

  const open = (layout, view, params, multi) => {
    if (leafProblem(view, params)) return layout;
    if (!layout.root) {
      if (layout.next + 1 > MAX_NEXT) return layout;
      const nl = mkLeaf("t" + layout.next, view, params);
      return mk(layout, { next: layout.next + 1, focus: nl.id, root: nl, max: undefined });
    }
    const id = find(layout, view, params, multi);
    if (id) return focus(layout, id);
    // Every window is minimized (focus ""): no tile to reuse, so the new window is split in beside the first leaf.
    if (!leafById(layout, layout.focus)) return split(layout, leaves(layout)[0].id, "row", view, params);
    return setView(layout, layout.focus, view, params);
  };

  const serialize = (layout) => JSON.stringify(layout);

  const RESET = "; reset to the default layout";
  const bad = (msg) => { throw { layoutError: msg }; };

  const parse = (text, opts) => {
    const fail = (reason) => ({ ok: false, reason });
    if (typeof text !== "string") return fail("Layout text is not a string" + RESET + ".");
    if (text.length > MAX_TEXT) return fail("Layout text is " + text.length + " characters, over the " + MAX_TEXT + " limit" + RESET + ".");
    let raw;
    try { raw = JSON.parse(text); } catch (e) { return fail("Layout text is not valid JSON" + RESET + "."); }
    if (!plainObject(raw)) return fail("Layout is not a JSON object" + RESET + ".");
    if (raw.max !== undefined && typeof raw.max !== "string") return fail("Layout is invalid: max is " + show(raw.max) + ", which must be a tile id string" + RESET + ".");
    if (raw.version !== VERSION) return fail("Layout version " + show(raw.version) + " is not supported (this build reads version " + VERSION + ")" + RESET + ".");
    const subjects = opts && plainObject(opts.subjects) ? opts.subjects : null;
    const ids = {};
    let maxNum = 0;
    let count = 0;
    const node = (n, depth, where) => {
      if (!plainObject(n)) bad(where + " is not an object");
      if (depth > MAX_DEPTH) bad("the tree is nested deeper than " + MAX_DEPTH + " levels");
      if (n.kind !== "leaf" && n.kind !== "split") bad(where + " has unknown kind " + show(n.kind));
      const re = n.kind === "leaf" ? LEAF_ID_RE : SPLIT_ID_RE;
      if (typeof n.id !== "string" || !re.test(n.id)) bad(where + " has a malformed id " + show(n.id));
      if (ids[n.id]) bad("id " + n.id + " is used twice");
      ids[n.id] = n.kind;
      maxNum = Math.max(maxNum, Number(n.id.slice(1)));
      if (n.kind === "leaf") {
        if (++count > MAX_LEAVES) bad("there are more than " + MAX_LEAVES + " tiles");
        const problem = leafProblem(n.view, n.params);
        if (problem) bad("tile " + n.id + " " + problem);
        const need = subjects && Object.prototype.hasOwnProperty.call(subjects, n.view) ? subjects[n.view] : null;
        if (need && !agentOf(n.params)) bad("tile " + n.id + " shows " + n.view + " without an agent");
        if (need === "report" && !reportOf(n.params)) bad("tile " + n.id + " shows " + n.view + " without a report id");
        if (n.hidden !== undefined && typeof n.hidden !== "boolean") bad("tile " + n.id + " has hidden " + show(n.hidden) + ", which must be true or false");
        return mkLeaf(n.id, n.view, n.params, n.hidden);
      }
      if (n.dir !== "row" && n.dir !== "col") bad("split " + n.id + " has invalid dir " + show(n.dir));
      if (typeof n.ratio !== "number" || !isFinite(n.ratio) || n.ratio <= 0 || n.ratio >= 1) bad("split " + n.id + " has ratio " + show(n.ratio) + ", which must be a number between 0 and 1 exclusive");
      if (!Array.isArray(n.children) || n.children.length !== 2) bad("split " + n.id + " must have exactly two children");
      const a = node(n.children[0], depth + 1, "a child of " + n.id);
      const b = node(n.children[1], depth + 1, "a child of " + n.id);
      return mkSplit(n.id, n.dir, n.ratio, a, b);
    };
    let root;
    try {
      root = raw.root === null ? null : node(raw.root, 0, "root");
      if (typeof raw.next !== "number" || !Number.isInteger(raw.next) || raw.next <= maxNum || raw.next > MAX_NEXT) {
        bad("next is " + show(raw.next) + ", which must be an integer above every used id number (" + maxNum + ") and at most " + MAX_NEXT);
      }
    } catch (e) {
      if (e && e.layoutError) return fail("Layout is invalid: " + e.layoutError + RESET + ".");
      throw e;
    }
    const all = root ? leavesOf(root, []) : [];
    const live = all.filter((l) => l.hidden !== true);
    // A max naming a hidden or unknown leaf is dropped; a kept max is the focus (focus follows the zoom).
    const maxId = typeof raw.max === "string" && live.some((l) => l.id === raw.max) ? raw.max : "";
    const focusOk = typeof raw.focus === "string" && live.some((l) => l.id === raw.focus);
    const focusId = maxId ? maxId : focusOk ? raw.focus : live.length ? live[0].id : "";
    const known = opts && Array.isArray(opts.views) ? opts.views : null;
    const unknown = known ? all.filter((l) => known.indexOf(l.view) < 0).map((l) => l.id) : [];
    const layout = { version: VERSION, next: raw.next, focus: focusId, root };
    if (maxId) layout.max = maxId;
    return { ok: true, layout, unknown };
  };

  return { MAX_LEAVES, MAX_DEPTH, MAX_TEXT, DEFAULT_MIN_RATIO, single, split, close, resize, move, focus, focusDir, rects, splits, leaves, visibleLeaves, maximized, closeOthers, closeLeft, closeRight, closeAll, maximize, restore, minimize, setView, open, find, subjectKey, serialize, parse };
})());
`;
