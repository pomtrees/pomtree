// Pure tiling-layout logic for the operator web UI, shipped as source text (like termKit.ts) and inlined into the
// page as global `LayoutKit`. A layout is a binary tiling tree of leaves (one view each) and splits; every function
// returns a new layout and never mutates its input, and an invalid operation returns the input itself (same
// reference) so callers can detect a no-op. No DOM, storage, clock or randomness here; tested in layout.test.ts.
// Stored data is only view ids and agent ids. Plain JS, no backticks and no template interpolation (it is a
// template literal, so it must also contain no backslashes).
// TODO(ui-floating-windows): windows tile only; there are no floating or overlapping windows. Trigger: an operator asks for floating windows or overlays.

export type ViewId = string;
export interface LeafParams {
  agent?: string;
}
export interface LeafNode {
  kind: "leaf";
  id: string;
  view: ViewId;
  params: LeafParams;
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
  focus: string;
  root: LayoutNode;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
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
  rects(layout: Layout): Record<string, Rect>;
  leaves(layout: Layout): LeafNode[];
  setView(layout: Layout, leafId: string, view: ViewId, params?: LeafParams): Layout;
  open(layout: Layout, view: ViewId, params?: LeafParams, multi?: boolean): Layout;
  find(layout: Layout, view: ViewId, params?: LeafParams, multi?: boolean): string | null;
  serialize(layout: Layout): string;
  parse(text: string, opts?: { views?: string[] }): ParseResult;
}

export const LAYOUT_LOGIC_JS = `
const LayoutKit = globalThis.LayoutKit || (globalThis.LayoutKit = (() => {
  "use strict";
  const VERSION = 1;
  const MAX_LEAVES = 16;
  const MAX_DEPTH = 8; // edges from the root to a leaf
  const MAX_TEXT = 65536;
  const MAX_AGENT = 256;
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
  const cleanParams = (p) => (p && typeof p.agent === "string" ? { agent: p.agent } : {});
  const agentOf = (p) => (p && typeof p.agent === "string" ? p.agent : null);
  const mkLeaf = (id, view, params) => ({ kind: "leaf", id, view, params: cleanParams(params) });
  const mkSplit = (id, dir, ratio, a, b) => ({ kind: "split", id, dir, ratio, children: [a, b] });

  // The one source of the leaf rules, shared by parse and every constructor: a problem description, or null when the
  // view id and params are storable. Absent params (undefined) read as empty.
  const leafProblem = (view, params) => {
    if (typeof view !== "string" || !VIEW_RE.test(view)) return "has an invalid view id " + show(view);
    const p = params === undefined ? {} : params;
    if (!plainObject(p)) return "params is not an object";
    const keys = Object.keys(p);
    for (const k of keys) if (k !== "agent") return "params has unsupported key " + show(k);
    if (keys.length && (typeof p.agent !== "string" || p.agent.length > MAX_AGENT)) return "params.agent is not a string of at most " + MAX_AGENT + " characters";
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
  const leaves = (layout) => leavesOf(layout.root, []);

  // Nodes from the root down to the node with this id, or null.
  const pathTo = (n, id, acc) => {
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
    return { version: VERSION, next: layout.next + 2, focus: nl.id, root };
  };

  // Closing the focused leaf moves focus to the sibling subtree's leaf nearest to where it was (first leaf if it
  // was the first child, else last); closing any other leaf keeps focus.
  const close = (layout, leafId) => {
    const d = detach(layout, leafId);
    if (!d) return layout;
    let focus = layout.focus;
    if (focus === leafId) {
      const ls = leavesOf(d.sibling, []);
      focus = (d.idx === 0 ? ls[0] : ls[ls.length - 1]).id;
    }
    return { version: VERSION, next: layout.next, focus, root: d.root };
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
    return { version: VERSION, next: layout.next, focus: layout.focus, root };
  };

  const EDGES = { left: ["row", true], right: ["row", false], top: ["col", true], bottom: ["col", false] };

  // Center swaps the two leaves' view and params (focus follows the dragged content to the target tile). An edge
  // detaches "from" and splits "to" there; the moved leaf keeps its id and gets focus.
  const move = (layout, fromId, toId, edge) => {
    if (fromId === toId) return layout;
    const a = leafPath(layout, fromId);
    const b = leafPath(layout, toId);
    if (!a || !b) return layout;
    const from = a[a.length - 1];
    const to = b[b.length - 1];
    if (badLeaf(from) || badLeaf(to)) return layout;
    if (edge === "center") {
      let root = replace(layout.root, fromId, () => mkLeaf(fromId, to.view, to.params));
      root = replace(root, toId, () => mkLeaf(toId, from.view, from.params));
      return { version: VERSION, next: layout.next, focus: toId, root };
    }
    const e = EDGES[edge];
    if (!e || layout.next + 1 > MAX_NEXT) return layout;
    const d = detach(layout, fromId);
    if (!d) return layout;
    const sid = "s" + layout.next;
    const root = replace(d.root, toId, (old) => (e[1] ? mkSplit(sid, e[0], 0.5, from, old) : mkSplit(sid, e[0], 0.5, old, from)));
    if (maxDepth(root) > MAX_DEPTH) return layout;
    return { version: VERSION, next: layout.next + 1, focus: fromId, root };
  };

  const focus = (layout, leafId) => (layout.focus === leafId || !leafPath(layout, leafId) ? layout : { version: VERSION, next: layout.next, focus: leafId, root: layout.root });

  const rects = (layout) => {
    const out = {};
    const go = (n, x, y, w, h) => {
      if (n.kind === "leaf") { out[n.id] = { x, y, w, h }; return; }
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
    go(layout.root, 0, 0, 1, 1);
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
    if (old.view === view && agentOf(old.params) === agentOf(params)) return layout;
    const root = replace(layout.root, leafId, () => mkLeaf(leafId, view, params));
    return { version: VERSION, next: layout.next, focus: layout.focus, root };
  };

  // First leaf in reading order showing this view (for multi views, the same params.agent too), else null.
  const find = (layout, view, params, multi) => {
    const ag = agentOf(params);
    for (const lf of leaves(layout)) {
      if (lf.view === view && (!multi || agentOf(lf.params) === ag)) return lf.id;
    }
    return null;
  };

  const open = (layout, view, params, multi) => {
    if (leafProblem(view, params)) return layout;
    const id = find(layout, view, params, multi);
    return id ? focus(layout, id) : setView(layout, layout.focus, view, params);
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
    if (raw.version !== VERSION) return fail("Layout version " + show(raw.version) + " is not supported (this build reads version " + VERSION + ")" + RESET + ".");
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
        return mkLeaf(n.id, n.view, n.params);
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
      root = node(raw.root, 0, "root");
      if (typeof raw.next !== "number" || !Number.isInteger(raw.next) || raw.next <= maxNum || raw.next > MAX_NEXT) {
        bad("next is " + show(raw.next) + ", which must be an integer above every used id number (" + maxNum + ") and at most " + MAX_NEXT);
      }
    } catch (e) {
      if (e && e.layoutError) return fail("Layout is invalid: " + e.layoutError + RESET + ".");
      throw e;
    }
    const first = leavesOf(root, [])[0].id;
    const focusId = typeof raw.focus === "string" && ids[raw.focus] === "leaf" ? raw.focus : first;
    const known = opts && Array.isArray(opts.views) ? opts.views : null;
    const unknown = known ? leavesOf(root, []).filter((l) => known.indexOf(l.view) < 0).map((l) => l.id) : [];
    return { ok: true, layout: { version: VERSION, next: raw.next, focus: focusId, root }, unknown };
  };

  return { MAX_LEAVES, MAX_DEPTH, MAX_TEXT, DEFAULT_MIN_RATIO, single, split, close, resize, move, focus, focusDir, rects, leaves, setView, open, find, serialize, parse };
})());
`;
