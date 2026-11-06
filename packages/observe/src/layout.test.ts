import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { LAYOUT_LOGIC_JS, type Layout, type LayoutKitApi } from "./layout.ts";

const K = runInContext(
  `(() => { ${LAYOUT_LOGIC_JS}; return LayoutKit; })()`,
  createContext({ globalThis: {}, JSON, Math, Number, String, isFinite, Object, Array }),
) as LayoutKitApi;

// The kit runs in a vm realm, so compare through JSON to avoid cross-realm prototype mismatches.
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const deepFreeze = <T>(x: T): T => {
  if (x && typeof x === "object") {
    for (const v of Object.values(x)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
};
// single is null for invalid input; these fixtures are valid.
const solo = (view: string, params?: { agent?: string }): Layout => {
  const l = K.single(view, params);
  assert.ok(l, `single(${view}) must be a layout`);
  return l;
};
const ids = (l: Layout): string[] => plain(K.leaves(l).map((x) => x.id));
const views = (l: Layout): string[] => plain(K.leaves(l).map((x) => x.view));

// a | b : t1 (tree) beside t2 (agent a1); focus t2, split s3, next 4.
const two = () => K.split(solo("tree"), "t1", "row", "agent", { agent: "a1" });
// t1 | (t2 / t4)
const three = () => K.split(two(), "t2", "col", "inbox", {});

test("single makes a one-leaf layout", () => {
  assert.deepEqual(plain(solo("tree", { agent: "a1" })), {
    version: 1,
    next: 2,
    focus: "t1",
    root: { kind: "leaf", id: "t1", view: "tree", params: { agent: "a1" } },
  });
  assert.equal(K.single("tree", { agent: 5, other: "x" } as never), null); // invalid params are refused, not silently cleaned
});

test("split row after adds a focused leaf at ratio 0.5 with deterministic ids", () => {
  assert.deepEqual(plain(two()), {
    version: 1,
    next: 4,
    focus: "t2",
    root: {
      kind: "split",
      id: "s3",
      dir: "row",
      ratio: 0.5,
      children: [
        { kind: "leaf", id: "t1", view: "tree", params: {} },
        { kind: "leaf", id: "t2", view: "agent", params: { agent: "a1" } },
      ],
    },
  });
  assert.equal(K.serialize(two()), K.serialize(two()));
});

test("split before puts the new leaf first, and col splits stack", () => {
  const l = K.split(solo("tree"), "t1", "col", "inbox", {}, "before");
  assert.deepEqual(ids(l), ["t2", "t1"]);
  assert.equal(plain(l.root).dir, "col");
  assert.equal(l.focus, "t2");
});

test("split no-ops on an unknown id, a split id or a bad dir", () => {
  const l = two();
  assert.equal(K.split(l, "t9", "row", "x"), l);
  assert.equal(K.split(l, "s3", "row", "x"), l);
  assert.equal(K.split(l, "t1", "diag" as never, "x"), l);
});

test("split no-ops at 16 leaves and past depth 8", () => {
  let l = solo("tree");
  for (let i = 0; i < 15; i++) {
    const rs = plain(K.rects(l)) as Record<string, { w: number; h: number }>;
    const area = (r: typeof rs, id: string) => (r[id] ? (r[id]?.w ?? 0) * (r[id]?.h ?? 0) : 0);
    const biggest = ids(l).reduce((a, b) => (area(rs, b) > area(rs, a) + 1e-12 ? b : a));
    l = K.split(l, biggest, i % 2 ? "row" : "col", "agent");
  }
  assert.equal(ids(l).length, 16);
  assert.equal(K.split(l, "t1", "row", "x"), l);
  let d = solo("tree");
  for (let i = 0; i < 8; i++) d = K.split(d, d.focus, "row", "agent");
  assert.equal(ids(d).length, 9);
  assert.equal(K.split(d, d.focus, "row", "x"), d);
  assert.notEqual(K.split(d, "t1", "row", "x"), d); // a shallower leaf still splits
});

test("close lifts the sibling and refocuses the nearest leaf of its subtree", () => {
  const l = three(); // t1 | (t2 / t4), focus t4
  const c = K.close(l, "t4");
  assert.deepEqual(ids(c), ["t1", "t2"]);
  assert.equal(c.focus, "t2"); // t4 was the second child, sibling t2
  const c2 = K.close(K.focus(l, "t1"), "t1");
  assert.deepEqual(plain(c2.root).kind, "split");
  assert.deepEqual(ids(c2), ["t2", "t4"]);
  assert.equal(c2.focus, "t2"); // closed the first child, so the sibling's first leaf
  assert.equal(c2.next, l.next);
  const c3 = K.close(K.focus(l, "t2"), "t2"); // sibling t4, the focused leaf was closed
  assert.equal(c3.focus, "t4");
});

test("close of an unfocused leaf keeps focus; sibling subtree edge leaf is chosen", () => {
  const l = three();
  assert.equal(K.close(l, "t1").focus, "t4"); // t1 not focused
  const f = K.focus(l, "t1");
  assert.equal(K.close(f, "t1").focus, "t2");
  // closing the last child picks the last leaf of the sibling subtree
  const four = K.split(K.focus(three(), "t2"), "t2", "row", "agent"); // t1 | ((t2|t6) / t4)
  assert.deepEqual(ids(four), ["t1", "t2", "t6", "t4"]);
  assert.equal(K.close(K.focus(four, "t1"), "t1").focus, "t2");
});

test("close no-ops on the last leaf or an unknown id", () => {
  const one = solo("tree");
  assert.equal(K.close(one, "t1"), one);
  const l = two();
  assert.equal(K.close(l, "t9"), l);
  assert.equal(K.close(l, "s3"), l);
});

test("resize sets the ratio and clamps to the min ratio", () => {
  const l = two();
  assert.equal(plain(K.resize(l, "s3", 0.3).root).ratio, 0.3);
  assert.equal(plain(K.resize(l, "s3", 0.01).root).ratio, 0.1);
  assert.equal(plain(K.resize(l, "s3", 5).root).ratio, 0.9);
  assert.equal(plain(K.resize(l, "s3", 0.01, 0.25).root).ratio, 0.25);
  assert.equal(plain(K.resize(l, "s3", 0.99, 0.25).root).ratio, 0.75);
  assert.equal(plain(K.resize(l, "s3", 0.9, 0.9).root).ratio, 0.5); // min clamped to 0.5
  const tiny = plain(K.resize(l, "s3", 0, 0).root).ratio; // min 0 still stays inside (0,1)
  assert.ok(tiny > 0 && tiny < 1);
  assert.equal(plain(K.resize(l, "s3", 0.02, Number.NaN).root).ratio, 0.1); // non-finite min -> default
});

test("resize no-ops on non-finite values, unknown ids, leaf ids and an unchanged ratio", () => {
  const l = two();
  for (const bad of [Number.NaN, Infinity, -Infinity, "0.3", null, undefined]) assert.equal(K.resize(l, "s3", bad as never), l);
  assert.equal(K.resize(l, "s9", 0.3), l);
  assert.equal(K.resize(l, "t1", 0.3), l);
  assert.equal(K.resize(l, "s3", 0.5), l);
});

test("move to an edge detaches and re-splits, keeping the moved leaf id and focusing it", () => {
  const l = three(); // t1 | (t2 / t4)
  const m = K.move(l, "t1", "t4", "bottom");
  assert.deepEqual(ids(m), ["t2", "t4", "t1"]);
  assert.equal(m.focus, "t1");
  assert.equal(m.next, l.next + 1);
  assert.deepEqual(plain(m.root), {
    kind: "split",
    id: "s5",
    dir: "col",
    ratio: 0.5,
    children: [
      { kind: "leaf", id: "t2", view: "agent", params: { agent: "a1" } },
      {
        kind: "split",
        id: "s6",
        dir: "col",
        ratio: 0.5,
        children: [
          { kind: "leaf", id: "t4", view: "inbox", params: {} },
          { kind: "leaf", id: "t1", view: "tree", params: {} },
        ],
      },
    ],
  });
});

test("move covers all four edges", () => {
  const l = two();
  const dirOf = (e: "left" | "right" | "top" | "bottom") => {
    const m = K.move(l, "t1", "t2", e);
    const r = plain(m.root);
    return [r.dir, ids(m).join()];
  };
  assert.deepEqual(dirOf("left"), ["row", "t1,t2"]);
  assert.deepEqual(dirOf("right"), ["row", "t2,t1"]);
  assert.deepEqual(dirOf("top"), ["col", "t1,t2"]);
  assert.deepEqual(dirOf("bottom"), ["col", "t2,t1"]);
});

test("move center swaps view and params and keeps ids and structure", () => {
  const l = two();
  const m = K.move(l, "t1", "t2", "center");
  assert.deepEqual(ids(m), ["t1", "t2"]);
  assert.deepEqual(plain(K.leaves(m)), [
    { kind: "leaf", id: "t1", view: "agent", params: { agent: "a1" } },
    { kind: "leaf", id: "t2", view: "tree", params: {} },
  ]);
  assert.equal(m.next, l.next);
});

test("move no-ops on itself, unknown ids, a bad edge and the only leaf", () => {
  const l = two();
  assert.equal(K.move(l, "t1", "t1", "left"), l);
  assert.equal(K.move(l, "t1", "t9", "left"), l);
  assert.equal(K.move(l, "t9", "t1", "left"), l);
  assert.equal(K.move(l, "s3", "t1", "left"), l);
  assert.equal(K.move(l, "t1", "t2", "middle" as never), l);
  const one = solo("tree");
  assert.equal(K.move(one, "t1", "t1", "center"), one);
});

test("move no-ops when the result would exceed the depth cap", () => {
  let d = K.split(solo("tree"), "t1", "row", "agent"); // t1 | t2
  d = K.split(d, "t1", "col", "inbox"); // (t1 / t4) | t2
  d = K.focus(d, "t2");
  for (let i = 0; i < 7; i++) d = K.split(d, d.focus, "row", "agent"); // t2 now sits 8 deep
  const deepest = d.focus;
  // detaching t4 lifts nothing on the deep side, so a split under the deepest leaf would reach depth 9
  assert.equal(K.move(d, "t4", deepest, "left"), d);
  assert.notEqual(K.move(d, "t4", "t1", "left"), d); // a shallow target is fine
});

test("focus changes focus and no-ops on unknown ids or the current focus", () => {
  const l = two();
  assert.equal(K.focus(l, "t1").focus, "t1");
  assert.equal(K.focus(l, "t2"), l);
  assert.equal(K.focus(l, "t9"), l);
  assert.equal(K.focus(l, "s3"), l);
});

test("rects tile the unit square", () => {
  const r = plain(K.rects(three()));
  assert.deepEqual(r, {
    t1: { x: 0, y: 0, w: 0.5, h: 1 },
    t2: { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    t4: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  });
  const sized = K.resize(three(), "s3", 0.25);
  const area = Object.values(plain(K.rects(sized)) as Record<string, { w: number; h: number }>).reduce((a, q) => a + q.w * q.h, 0);
  assert.ok(Math.abs(area - 1) < 1e-12);
});

test("leaves lists in reading order", () => {
  const l = K.split(three(), "t1", "col", "agent", {}, "before"); // (t6 / t1) | (t2 / t4)
  assert.deepEqual(ids(l), ["t6", "t1", "t2", "t4"]);
});

test("focusDir picks the adjacent leaf with the most overlap", () => {
  let l = K.resize(three(), "s5", 0.7); // t1 | (t2 70% / t4 30%)
  l = K.focus(l, "t1");
  assert.equal(K.focusDir(l, "right").focus, "t2"); // t2 overlaps t1 more than t4
  l = K.resize(l, "s5", 0.2);
  assert.equal(K.focusDir(l, "right").focus, "t4");
  assert.equal(K.focusDir(K.focus(l, "t4"), "left").focus, "t1");
  assert.equal(K.focusDir(K.focus(l, "t4"), "up").focus, "t2");
  assert.equal(K.focusDir(K.focus(l, "t2"), "down").focus, "t4");
});

test("focusDir no-ops with no neighbor, on a corner-only touch and on a bad direction", () => {
  const l = K.focus(three(), "t1");
  assert.equal(K.focusDir(l, "left"), l);
  assert.equal(K.focusDir(l, "up"), l);
  assert.equal(K.focusDir(l, "down"), l);
  assert.equal(K.focusDir(l, "sideways" as never), l);
  const one = solo("tree");
  assert.equal(K.focusDir(one, "right"), one);
  // t2 (top right) is not below t1's span-adjacent in "down": only a shared edge counts
  assert.equal(K.focusDir(K.focus(three(), "t2"), "left").focus, "t1");
  // a corner touch alone is not adjacency: (a|b) / (c|d) with a narrow top row split offset from the bottom
  let g = K.split(solo("a"), "t1", "col", "c"); // t1 / t2
  g = K.split(g, "t1", "row", "b"); // (t1|t4) / t2
  const f = K.focus(g, "t4");
  assert.equal(K.focusDir(f, "down").focus, "t2");
  assert.equal(K.focusDir(f, "left").focus, "t1");
});

test("setView swaps one leaf's view and params and no-ops when unchanged", () => {
  const l = two();
  const s = K.setView(l, "t1", "agent", { agent: "a2" });
  assert.deepEqual(plain(K.leaves(s)[0]), { kind: "leaf", id: "t1", view: "agent", params: { agent: "a2" } });
  assert.equal(K.setView(l, "t1", "tree", {}), l);
  assert.equal(K.setView(l, "t9", "x", {}), l);
  assert.equal(K.setView(l, "s3", "x", {}), l);
});

test("find and open follow the view and, for multi views, the agent", () => {
  const l = two(); // t1 tree, t2 agent a1 (focus)
  assert.equal(K.find(l, "tree", {}, false), "t1");
  assert.equal(K.find(l, "agent", { agent: "a1" }, true), "t2");
  assert.equal(K.find(l, "agent", { agent: "a2" }, true), null);
  assert.equal(K.find(l, "agent", { agent: "a2" }, false), "t2"); // single-instance views ignore params
  assert.equal(K.find(l, "inbox", {}, false), null);
  assert.equal(K.open(l, "tree", {}, false).focus, "t1"); // focus the existing tile
  assert.equal(K.open(l, "agent", { agent: "a1" }, true), l); // already focused: same reference
  const o = K.open(l, "agent", { agent: "a2" }, true); // replaces the focused leaf
  assert.deepEqual(plain(K.leaves(o)[1]?.params), { agent: "a2" });
  assert.deepEqual(ids(o), ["t1", "t2"]);
  const n = K.open(l, "inbox", {}, false);
  assert.deepEqual(views(n), ["tree", "inbox"]);
});

test("open keeps at most one tile per agent", () => {
  let l = K.open(two(), "agent", { agent: "a2" }, true);
  l = K.open(l, "agent", { agent: "a1" }, true); // focused leaf now shows a1
  l = K.open(l, "agent", { agent: "a1" }, true);
  assert.equal(K.leaves(l).filter((x) => x.params.agent === "a1").length, 1);
});

test("serialize and parse round-trip", () => {
  const l = three();
  const r = K.parse(K.serialize(l));
  assert.ok(r.ok);
  assert.deepEqual(plain(r.layout), plain(l));
  assert.deepEqual(plain(r.unknown), []);
});

// Mutable raw layout for rejection cases.
// biome-ignore lint/suspicious/noExplicitAny: test fixture edited by path
type Raw = any;
const raw = (): Raw => plain(three());
const rejects = (edit: (r: Raw) => void, includes: string) => {
  const r = raw();
  edit(r);
  const out = K.parse(JSON.stringify(r));
  assert.equal(out.ok, false, includes);
  if (!out.ok) {
    assert.ok(out.reason.includes(includes), `${out.reason} should mention ${includes}`);
    assert.match(out.reason, /reset to the default layout/);
  }
};

test("parse rejects non-string, oversized and non-JSON text", () => {
  assert.equal(K.parse(42 as never).ok, false);
  const big = K.parse(" ".repeat(65537));
  assert.equal(big.ok, false);
  if (!big.ok) assert.match(big.reason, /65537 characters/);
  assert.equal(K.parse("{nope").ok, false);
  for (const t of ["[]", "null", "3", '"x"']) assert.equal(K.parse(t).ok, false, t);
  assert.equal(K.parse(" ".repeat(65536)).ok, false); // at the limit it is read, then fails as JSON
});

test("parse rejects every version other than 1 and names it", () => {
  rejects((r) => (r.version = 2), "version 2");
  rejects((r) => (r.version = 0), "version 0");
  rejects((r) => delete r.version, "version undefined");
  rejects((r) => (r.version = "1"), 'version "1"');
});

test("parse rejects structural errors", () => {
  rejects((r) => (r.root.kind = "pane"), 'unknown kind "pane"');
  rejects((r) => delete r.root, "root is not an object");
  rejects((r) => (r.root.children[0].id = "x1"), "malformed id");
  rejects((r) => (r.root.children[0].id = "s1"), "malformed id"); // a leaf must use a t id
  rejects((r) => (r.root.id = "t1"), "malformed id"); // a split must use an s id
  rejects((r) => (r.root.children[1].children[0].id = "t1"), "id t1 is used twice");
  rejects((r) => r.root.children.pop(), "exactly two children");
  rejects((r) => r.root.children.push(r.root.children[0]), "exactly two children");
  rejects((r) => (r.root.children = "ab"), "exactly two children");
  rejects((r) => (r.root.dir = "diag"), 'invalid dir "diag"');
  for (const bad of [0, 1, -0.5, 1.5, "0.5", null]) rejects((r) => (r.root.ratio = bad), "ratio");
});

test("parse rejects bad views and params", () => {
  for (const v of ["Tree", "1tree", "", "a b", "x".repeat(65), 5]) rejects((r) => (r.root.children[0].view = v), "invalid view id");
  rejects((r) => (r.root.children[0].params = { title: "x" }), 'unsupported key "title"');
  rejects((r) => (r.root.children[0].params = { agent: 5 }), "params.agent");
  rejects((r) => (r.root.children[0].params = { agent: "a".repeat(257) }), "params.agent");
  rejects((r) => (r.root.children[0].params = []), "params is not an object");
  const ok = raw();
  ok.root.children[0].params = { agent: "a".repeat(256) };
  assert.ok(K.parse(JSON.stringify(ok)).ok);
  delete ok.root.children[0].params; // missing params read as empty
  assert.ok(K.parse(JSON.stringify(ok)).ok);
});

test("parse rejects next at or below a used id, and non-integers", () => {
  rejects((r) => (r.next = 5), "next is 5"); // s5 is used, so next must be 6
  rejects((r) => (r.next = 1.5), "next is 1.5");
  rejects((r) => (r.next = "9"), "next is");
  rejects((r) => delete r.next, "next is");
  const ok = raw();
  ok.next = 6;
  assert.ok(K.parse(JSON.stringify(ok)).ok);
});

// Builds a raw tree from a nesting spec: balanced leaf count or a right-leaning chain.
const rawChain = (splits: number): Raw => {
  let n = 0;
  const leaf = () => ({ kind: "leaf", id: `t${++n}`, view: "tree", params: {} });
  const go = (k: number): Raw => {
    if (k === 0) return leaf();
    const a = leaf();
    const b = go(k - 1);
    return { kind: "split", id: `s${++n}`, dir: "row", ratio: 0.5, children: [a, b] };
  };
  const root = go(splits);
  return { version: 1, next: n + 1, focus: "t1", root };
};
const rawFlat = (count: number): Raw => {
  let n = 0;
  const go = (k: number): Raw => {
    if (k === 1) return { kind: "leaf", id: `t${++n}`, view: "tree", params: {} };
    const h = Math.floor(k / 2);
    const a = go(h);
    const b = go(k - h);
    return { kind: "split", id: `s${++n}`, dir: "col", ratio: 0.5, children: [a, b] };
  };
  const root = go(count);
  return { version: 1, next: n + 1, focus: "t1", root };
};

test("parse enforces the leaf and depth caps", () => {
  assert.ok(K.parse(JSON.stringify(rawFlat(16))).ok);
  const many = K.parse(JSON.stringify(rawFlat(17)));
  assert.equal(many.ok, false);
  if (!many.ok) assert.match(many.reason, /more than 16 tiles/);
  assert.ok(K.parse(JSON.stringify(rawChain(8))).ok);
  const deep = K.parse(JSON.stringify(rawChain(9)));
  assert.equal(deep.ok, false);
  if (!deep.ok) assert.match(deep.reason, /deeper than 8 levels/);
});

test("parse repairs a missing or non-leaf focus to the first leaf", () => {
  for (const f of ["t99", "s3", 7, null]) {
    const r = raw();
    r.focus = f;
    const out = K.parse(JSON.stringify(r));
    assert.ok(out.ok);
    if (out.ok) assert.equal(out.layout.focus, "t1");
  }
  const r = raw();
  r.focus = "t4";
  const out = K.parse(JSON.stringify(r));
  assert.ok(out.ok && out.layout.focus === "t4");
});

test("parse accepts unknown views and reports them only when a known list is given", () => {
  const text = K.serialize(three()); // views tree, agent, inbox
  const none = K.parse(text);
  assert.ok(none.ok && none.unknown.length === 0);
  const some = K.parse(text, { views: ["tree", "agent"] });
  assert.ok(some.ok);
  if (some.ok) assert.deepEqual(plain(some.unknown), ["t4"]);
});

test("parse drops extra keys and rebuilds a canonical layout", () => {
  const r = raw();
  r.extra = 1;
  r.root.children[0].title = "secret title";
  const out = K.parse(JSON.stringify(r));
  assert.ok(out.ok);
  if (out.ok) assert.deepEqual(plain(out.layout), plain(three()));
});

test("no operation mutates its input, and results are new objects", () => {
  const l = deepFreeze(three());
  const before = JSON.stringify(l);
  const results = [
    K.split(l, "t1", "row", "x", {}, "before"),
    K.close(l, "t2"),
    K.resize(l, "s3", 0.3),
    K.move(l, "t1", "t4", "left"),
    K.move(l, "t1", "t4", "center"),
    K.focus(l, "t1"),
    K.focusDir(K.focus(l, "t1"), "right"),
    K.setView(l, "t1", "x", { agent: "q" }),
    K.open(l, "x", {}, false),
    K.open(l, "agent", { agent: "a1" }, true),
  ];
  assert.equal(JSON.stringify(l), before);
  for (const r of results) assert.notEqual(r, l);
  K.rects(l);
  K.leaves(l);
  K.find(l, "tree", {}, false);
  K.serialize(l);
  assert.equal(JSON.stringify(l), before);
});

test("ids are unique and never reused after a close", () => {
  let l = two();
  l = K.close(l, "t2");
  l = K.split(l, "t1", "row", "agent");
  assert.equal(l.focus, "t4"); // t2 was freed but next kept counting
  assert.equal(l.next, 6);
});

// Limits live in one validator shared by parse and every constructor, so a layout built in the page always loads.
const BAD_VIEWS: unknown[] = ["Bad View", "", "1tree", "x".repeat(65), 5, null, undefined];
const BAD_PARAMS: unknown[] = [{ agent: "x".repeat(257) }, { agent: 5 }, { title: "x" }, { agent: "a", title: "x" }, [], "a1"];
const GOOD_PARAMS: unknown[] = [undefined, {}, { agent: "a1" }, { agent: "x".repeat(256) }];
const loads = (l: Layout) => {
  const r = K.parse(K.serialize(l));
  assert.ok(r.ok, `${K.serialize(l).slice(0, 120)} must load`);
  return r.ok ? plain(r.layout) : null;
};

test("mutators no-op on an invalid view or params, returning the same layout", () => {
  const l = three();
  for (const v of BAD_VIEWS) {
    assert.equal(K.split(l, "t1", "row", v as string), l, `split view ${String(v)}`);
    assert.equal(K.setView(l, "t1", v as string), l, `setView view ${String(v)}`);
    assert.equal(K.open(l, v as string), l, `open view ${String(v)}`);
  }
  for (const p of BAD_PARAMS) {
    const d = JSON.stringify(p).slice(0, 20);
    assert.equal(K.split(l, "t1", "row", "ok", p as never), l, `split params ${d}`);
    assert.equal(K.setView(l, "t1", "ok", p as never), l, `setView params ${d}`);
    assert.equal(K.open(l, "ok", p as never), l, `open params ${d}`);
    assert.equal(K.open(l, "agent", p as never, true), l, `open multi params ${d}`);
  }
});

test("move no-ops when a leaf it carries holds an invalid view or params", () => {
  // A leaf can only be invalid if it came from outside the kit; the swap and re-split must not launder it into a layout.
  const l = three();
  const evil = plain(l);
  evil.root.children[0].view = "Bad View";
  for (const edge of ["center", "left", "right", "top", "bottom"] as const) {
    assert.equal(K.move(evil, "t1", "t2", edge), evil, `move ${edge} from invalid leaf`);
    assert.equal(K.move(evil, "t2", "t1", edge), evil, `move ${edge} onto invalid leaf`);
  }
});

test("single returns null on an invalid view or params, else a layout that loads", () => {
  for (const v of BAD_VIEWS) assert.equal(K.single(v as string), null, `view ${String(v)}`);
  for (const p of BAD_PARAMS) assert.equal(K.single("tree", p as never), null, `params ${JSON.stringify(p).slice(0, 20)}`);
  for (const p of GOOD_PARAMS) assert.ok(loads(K.single("tree", p as never) as Layout));
});

test("round trip: every mutator's result loads, for valid and invalid inputs", () => {
  const bases = [K.single("tree") as Layout, two(), three()];
  const all: Layout[] = [];
  const add = (l: Layout | null) => {
    if (l) all.push(l);
  };
  for (const v of ["ok", ...BAD_VIEWS]) {
    for (const p of [...GOOD_PARAMS, ...BAD_PARAMS]) {
      add(K.single(v as string, p as never));
      for (const b of bases) {
        add(K.split(b, "t1", "row", v as string, p as never));
        add(K.split(b, "t1", "col", v as string, p as never, "before"));
        add(K.setView(b, "t1", v as string, p as never));
        add(K.open(b, v as string, p as never));
        add(K.open(b, v as string, p as never, true));
      }
    }
  }
  for (const b of bases) {
    for (const edge of ["center", "left", "right", "top", "bottom"] as const) add(K.move(b, "t1", "t2", edge));
    add(K.close(b, "t2"));
    add(K.resize(b, "s3", 0.3));
    add(K.focusDir(b, "right"));
  }
  assert.ok(all.length > 100);
  for (const l of all) loads(l);
  // Valid inputs are accepted, not just rejected wholesale.
  const ok = K.split(two(), "t1", "row", "my-view", { agent: "x".repeat(256) });
  assert.notEqual(ok, two());
  loads(ok);
});
