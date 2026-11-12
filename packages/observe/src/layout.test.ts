import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { LAYOUT_LOGIC_JS, type Layout, type LayoutKitApi } from "./layout.ts";

const K = runInContext(
  `(() => { ${LAYOUT_LOGIC_JS}; return LayoutKit; })()`,
  createContext({ globalThis: {}, JSON, Math, Number, String, isFinite, Object, Array }),
) as LayoutKitApi;

// hidden flag read from leaves() (the same data the bar uses)
const isHid = (l: Layout, id: string) => K.leaves(l).find((x) => x.id === id)?.hidden === true;
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

test("close of the last leaf leaves an empty layout that every operation tolerates and open refills", () => {
  const one = solo("tree");
  const e = K.close(one, "t1");
  assert.deepEqual(plain(e), { version: 1, next: 2, focus: "", root: null });
  assert.deepEqual(plain(K.leaves(e)), []);
  assert.deepEqual(plain(K.rects(e)), {});
  assert.equal(K.close(e, "t1"), e);
  assert.equal(K.split(e, "t1", "row", "tree"), e);
  assert.equal(K.focus(e, "t1"), e);
  assert.equal(K.focusDir(e, "left"), e);
  assert.equal(K.move(e, "t1", "t2", "left"), e);
  assert.equal(K.setView(e, "t1", "hosts"), e);
  assert.equal(K.find(e, "tree"), null);
  const back = K.open(e, "hosts");
  assert.deepEqual(plain(back), { version: 1, next: 3, focus: "t2", root: { kind: "leaf", id: "t2", view: "hosts", params: {} } });
  assert.equal(K.open(e, "Bad View"), e);
});

test("an empty layout serializes and parses back, with focus empty and no unknown views", () => {
  const e = K.close(solo("tree"), "t1");
  const r = K.parse(K.serialize(e), { views: ["tree"] });
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(plain(r.layout), plain(e));
    assert.deepEqual(plain(r.unknown), []);
  }
  assert.equal(K.parse('{"version":1,"next":1,"focus":"","root":null}').ok, true);
  assert.equal(K.parse('{"version":1,"next":0,"focus":"","root":null}').ok, false, "next must stay a positive integer");
  assert.equal(K.parse('{"version":1,"next":2,"focus":""}').ok, false, "a missing root is still invalid; only null means empty");
});

test("close no-ops on an unknown id", () => {
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

// ---- subjects: params are the closed set {agent?, report?}; a report needs its agent ----
const rp = (agent: string, report: string) => ({ agent, report });

test("params: report is accepted with its agent, refused alone, and any other key still refuses", () => {
  assert.deepEqual(plain(K.leaves(solo("report", rp("a1", "r1")))[0]?.params), rp("a1", "r1"));
  assert.equal(K.single("report", { report: "r1" }), null, "report without agent");
  assert.equal(K.single("report", { agent: "a1", report: 5 } as never), null);
  assert.equal(K.single("report", { agent: "a1", report: "r".repeat(257) }), null);
  assert.ok(K.single("report", { agent: "a1", report: "r".repeat(256) }));
  assert.equal(K.single("report", { agent: "a1", report: "r1", title: "x" } as never), null);
  const l = three();
  assert.equal(K.split(l, "t1", "row", "report", { report: "r1" }), l);
  assert.equal(K.setView(l, "t1", "report", { report: "r1" }), l);
  assert.equal(K.open(l, "report", { report: "r1" }, true), l);
});

test("parse rejects a report without an agent, a bad report and an unsupported key", () => {
  const rejects = (mut: (r: any) => void, needle: string) => {
    const r = plain(three());
    mut(r);
    const out = K.parse(JSON.stringify(r));
    assert.equal(out.ok, false, needle);
    if (!out.ok) assert.ok(out.reason.includes(needle), out.reason);
  };
  rejects((r) => (r.root.children[0].params = { report: "r1" }), "params.report");
  rejects((r) => (r.root.children[0].params = { agent: "a", report: 5 }), "params.report");
  rejects((r) => (r.root.children[0].params = { agent: "a", report: "r".repeat(257) }), "params.report");
  rejects((r) => (r.root.children[0].params = { agent: "a", report: "r", note: "x" }), 'unsupported key "note"');
  const ok = plain(three());
  ok.root.children[0].params = rp("a", "r".repeat(256));
  assert.ok(K.parse(JSON.stringify(ok)).ok);
});

test("find, setView and open distinguish report ids of one agent", () => {
  let l = K.split(solo("tree"), "t1", "row", "report", rp("a1", "r1")); // t2 shows a1/r1
  assert.equal(K.find(l, "report", rp("a1", "r1"), true), "t2");
  assert.equal(K.find(l, "report", rp("a1", "r2"), true), null);
  assert.equal(K.find(l, "report", rp("a2", "r1"), true), null);
  assert.equal(K.setView(l, "t2", "report", rp("a1", "r1")), l, "same subject: same reference");
  const moved = K.setView(l, "t2", "report", rp("a1", "r2"));
  assert.notEqual(moved, l);
  assert.deepEqual(plain(K.leaves(moved)[1]?.params), rp("a1", "r2"));
  assert.equal(K.open(l, "report", rp("a1", "r1"), true), l, "already focused");
  l = K.focus(l, "t1");
  assert.equal(K.open(l, "report", rp("a1", "r1"), true).focus, "t2", "open focuses the existing subject");
  const o = K.open(l, "report", rp("a1", "r9"), true);
  assert.deepEqual(plain(K.leaves(o)[0]), { kind: "leaf", id: "t1", view: "report", params: rp("a1", "r9") });
  // a leaf with only an agent is another subject than one with a report
  const t = K.split(solo("tree"), "t1", "row", "terminal", { agent: "a1" });
  assert.equal(K.find(t, "terminal", rp("a1", "r1"), true), null);
});

test("subjectKey is equal only for equal agent and report, including ids with separators", () => {
  assert.equal(K.subjectKey(rp("a", "b")), K.subjectKey(rp("a", "b")));
  assert.notEqual(K.subjectKey({ agent: "a" }), K.subjectKey(rp("a", "b")));
  assert.notEqual(K.subjectKey(rp("a|", "b")), K.subjectKey(rp("a", "|b")));
  assert.equal(K.subjectKey({}), K.subjectKey(undefined));
});

test("parse with opts.subjects accepts leaves with their subject and rejects those without, naming tile and view", () => {
  const subjects = { terminal: "agent", report: "report" } as const;
  const leafOf = (view: string, params: object) =>
    JSON.stringify({
      version: 1,
      next: 4,
      focus: "t1",
      root: {
        kind: "split",
        id: "s3",
        dir: "row",
        ratio: 0.5,
        children: [
          { kind: "leaf", id: "t1", view: "tree", params: {} },
          { kind: "leaf", id: "t2", view, params },
        ],
      },
    });
  const bad = (view: string, params: object, needle: string) => {
    const r = K.parse(leafOf(view, params), { subjects });
    assert.equal(r.ok, false, `${view} ${JSON.stringify(params)}`);
    if (!r.ok) assert.ok(r.reason.includes(needle), r.reason);
  };
  assert.ok(K.parse(leafOf("terminal", { agent: "a1" }), { subjects }).ok);
  assert.ok(K.parse(leafOf("report", rp("a1", "r1")), { subjects }).ok);
  bad("terminal", {}, "tile t2 shows terminal without an agent");
  bad("report", {}, "tile t2 shows report without an agent");
  bad("report", { agent: "a1" }, "tile t2 shows report without a report id");
  // views outside the map need no subject, and without opts nothing is checked
  assert.ok(K.parse(leafOf("hosts", {}), { subjects }).ok);
  assert.ok(K.parse(leafOf("terminal", {})).ok);
  assert.ok(K.parse(leafOf("terminal", {}), { views: ["terminal"] }).ok);
  // an inherited property name is not a subject requirement
  assert.ok(K.parse(leafOf("constructor", {}), { subjects }).ok);
});

// ---- maximize, minimize and the close variants ----

// t1 | (t2 / (t4 | t6)): reading order t1 t2 t4 t6, focus t6.
const four = () => K.split(three(), "t4", "row", "tree", {});
const hid = (l: Layout): string[] =>
  plain(
    K.leaves(l)
      .filter((x) => x.hidden)
      .map((x) => x.id),
  );
const shownIds = (l: Layout): string[] => Object.keys(K.rects(l)).sort();
const roundTrip = (l: Layout): Layout => {
  const r = K.parse(K.serialize(l));
  assert.ok(r.ok, "layout must reparse");
  return r.layout;
};

test("maximize sets max and focus, unhides the leaf and leaves the tree untouched", () => {
  const l = K.maximize(three(), "t1");
  assert.deepEqual([l.max, l.focus, K.maximized(l), K.maximized(three())], ["t1", "t1", "t1", ""]);
  assert.deepEqual(plain(l.root), plain(three().root));
  const h = K.maximize(K.minimize(three(), "t2"), "t2");
  assert.deepEqual([h.max, h.focus, isHid(h, "t2")], ["t2", "t2", false]);
  assert.equal(K.leaves(h)[1]?.hidden, undefined);
});

test("maximize returns the same reference for an unknown id, a split id and the maximized focused leaf", () => {
  const base = three();
  assert.equal(K.maximize(base, "t9"), base);
  assert.equal(K.maximize(base, "s3"), base);
  const l = K.maximize(base, "t2");
  assert.equal(K.maximize(l, "t2"), l);
  assert.notEqual(K.maximize(l, "t1"), l); // negative control: another leaf does change
});

test("restore: no id clears max, the max id clears it, a plain visible id is a no-op", () => {
  const l = K.maximize(three(), "t2");
  const a = K.restore(l);
  assert.equal("max" in a, false);
  assert.equal(a.focus, "t2");
  assert.equal("max" in K.restore(l, "t2"), false);
  assert.equal(K.restore(l, "t1"), l);
  assert.equal(K.restore(l, "t9"), l);
});

test("restore returns the same reference with nothing to restore", () => {
  const base = three();
  assert.equal(K.restore(base), base);
  assert.equal(K.restore(base, "t1"), base);
  assert.equal(K.restore(base, null), base);
});

test("restore of a hidden leaf unhides and focuses it", () => {
  const l = K.minimize(three(), "t1");
  const r = K.restore(l, "t1");
  assert.deepEqual([isHid(r, "t1"), r.focus], [false, "t1"]);
  assert.equal(K.leaves(r)[0]?.hidden, undefined);
});

test("restore of a hidden leaf while another is maximized hands the zoom to it", () => {
  const l = K.minimize(K.maximize(three(), "t2"), "t4"); // t4 hidden while t2 is maximized
  assert.deepEqual([l.max, isHid(l, "t4")], ["t2", true]);
  const r = K.restore(l, "t4");
  assert.deepEqual([r.max, r.focus, isHid(r, "t4")], ["t4", "t4", false]);
});

test("minimize hides the leaf in place and moves focus to the sibling subtree's visible leaf", () => {
  const l = K.minimize(three(), "t4"); // focus is t4
  assert.deepEqual(hid(l), ["t4"]);
  assert.equal(l.focus, "t2");
  assert.deepEqual(ids(l), ["t1", "t2", "t4"]); // still listed
  assert.deepEqual(plain(K.visibleLeaves(l).map((x) => x.id)), ["t1", "t2"]);
  assert.equal(isHid(l, "t4"), true);
  assert.equal(isHid(l, "t1"), false);
  assert.equal(isHid(l, "nope"), false);
});

test("minimize of an unfocused leaf keeps focus; of the maximized leaf clears max", () => {
  const a = K.minimize(three(), "t1");
  assert.equal(a.focus, "t4");
  const m = K.maximize(three(), "t1");
  const b = K.minimize(m, "t1");
  assert.equal("max" in b, false);
  assert.equal(b.focus, "t2");
  const c = K.minimize(K.maximize(three(), "t1"), "t2"); // another leaf: max stays
  assert.deepEqual([c.max, c.focus, hid(c)], ["t1", "t1", ["t2"]]);
});

test("minimize focus falls back to the nearest visible leaf when the sibling subtree is hidden", () => {
  const l = K.minimize(K.minimize(three(), "t2"), "t4"); // sibling t2 hidden, then t4 (focus) hidden
  assert.deepEqual([hid(l), l.focus], [["t2", "t4"], "t1"]);
  const m = K.minimize(K.minimize(K.focus(three(), "t4"), "t2"), "t4");
  assert.equal(m.focus, "t1");
});

test("minimizing the last shown leaf leaves an all-hidden layout with focus empty", () => {
  const l = K.minimize(K.minimize(K.minimize(three(), "t4"), "t2"), "t1");
  assert.deepEqual([hid(l), l.focus], [["t1", "t2", "t4"], ""]);
  assert.deepEqual(shownIds(l), []);
  assert.deepEqual(plain(K.splits(l)), []);
  assert.equal(K.focusDir(l, "left"), l);
  assert.equal(roundTrip(l).focus, "");
});

test("minimize returns the same reference for an already hidden leaf and an unknown id", () => {
  const l = K.minimize(three(), "t2");
  assert.equal(K.minimize(l, "t2"), l);
  assert.equal(K.minimize(l, "t9"), l);
  assert.notEqual(K.minimize(l, "t1"), l);
});

test("rects: a hidden child hands its area to the sibling; hidden leaves get no rect", () => {
  const l = K.minimize(three(), "t4");
  assert.deepEqual(plain(K.rects(l)), { t1: { x: 0, y: 0, w: 0.5, h: 1 }, t2: { x: 0.5, y: 0, w: 0.5, h: 1 } });
  assert.deepEqual(
    plain(K.splits(l)).map((s: { id: string }) => s.id),
    ["s3"],
  );
});

test("rects: a nested hidden subtree collapses entirely", () => {
  const l = K.minimize(K.minimize(four(), "t4"), "t6"); // the (t4 | t6) subtree is hidden
  assert.deepEqual(shownIds(l), ["t1", "t2"]);
  assert.deepEqual(plain(K.rects(l).t2), { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(
    plain(K.splits(l)).map((s: { id: string }) => s.id),
    ["s3"],
  );
  const one = K.minimize(K.minimize(four(), "t1"), "t2");
  assert.deepEqual(shownIds(one), ["t4", "t6"]);
  assert.deepEqual(plain(K.rects(one).t4), { x: 0, y: 0, w: 0.5, h: 1 });
});

test("splits geometry is reported on the collapsed tiling", () => {
  const l = K.minimize(K.minimize(four(), "t1"), "t2"); // only (t4 | t6) is shown, in the whole area
  const s = plain(K.splits(l));
  assert.equal(s.length, 1);
  assert.deepEqual(s[0], { id: "s7", dir: "row", ratio: 0.5, x: 0, y: 0, w: 1, h: 1 });
  // negative control: with everything shown the same split lives in a smaller box
  const all = plain(K.splits(four()));
  assert.deepEqual(
    all.map((x: { id: string }) => x.id),
    ["s3", "s5", "s7"],
  );
  assert.notDeepEqual(
    all.find((x: { id: string }) => x.id === "s7"),
    s[0],
  );
});

test("rects with max is only the maximized leaf over the whole area, and splits is empty", () => {
  const l = K.maximize(three(), "t2");
  assert.deepEqual(plain(K.rects(l)), { t2: { x: 0, y: 0, w: 1, h: 1 } });
  assert.deepEqual(plain(K.splits(l)), []);
  assert.deepEqual(ids(l), ["t1", "t2", "t4"]); // leaves stays all leaves
});

test("focusDir ignores hidden and non-maximized leaves", () => {
  const l = K.minimize(three(), "t2"); // t1 | t4 (t2 hidden)
  const f = K.focusDir(K.focus(l, "t1"), "right");
  assert.equal(f.focus, "t4");
  const m = K.maximize(three(), "t1");
  assert.equal(K.focusDir(m, "right"), m);
});

test("focus unhides a hidden leaf and, while max is set, moves max to the focused leaf", () => {
  const l = K.minimize(three(), "t1");
  const f = K.focus(l, "t1");
  assert.deepEqual([isHid(f, "t1"), f.focus], [false, "t1"]);
  assert.equal("max" in f, false);
  const m = K.focus(K.maximize(three(), "t1"), "t2");
  assert.deepEqual([m.max, m.focus], ["t2", "t2"]);
  const same = K.maximize(three(), "t1");
  assert.equal(K.focus(same, "t1"), same);
  assert.equal(K.focus(l, "t9"), l);
});

test("close of the maximized leaf clears max and focuses a visible leaf; of another leaf keeps max", () => {
  const m = K.maximize(three(), "t2");
  const a = K.close(m, "t2");
  assert.equal("max" in a, false);
  assert.equal(a.focus, "t4");
  const b = K.close(m, "t4");
  assert.deepEqual([b.max, b.focus], ["t2", "t2"]);
});

test("close keeps focus on a visible leaf when the sibling subtree is hidden", () => {
  const l = K.minimize(three(), "t4");
  const f = K.focus(l, "t2");
  const c = K.close(f, "t2"); // sibling t4 is hidden
  assert.equal(c.focus, "t1");
  assert.deepEqual(hid(c), ["t4"]);
});

test("closing the last visible leaf of a layout with hidden leaves leaves focus empty", () => {
  const l = K.minimize(K.focus(K.minimize(three(), "t2"), "t1"), "t4"); // t2 t4 hidden, t1 shown
  assert.equal(l.focus, "t1");
  const c = K.close(l, "t1");
  assert.deepEqual([c.focus, hid(c)], ["", ["t2", "t4"]]);
});

test("closeOthers keeps only that leaf, focuses it, keeps max only if it is the max", () => {
  const c = K.closeOthers(three(), "t2");
  assert.deepEqual([ids(c), c.focus, "max" in c], [["t2"], "t2", false]);
  assert.equal(plain(c.root).kind, "leaf");
  const keepMax = K.closeOthers(K.maximize(three(), "t2"), "t2");
  assert.equal(keepMax.max, "t2");
  const dropMax = K.closeOthers(K.maximize(three(), "t1"), "t2");
  assert.equal("max" in dropMax, false);
  assert.equal(c.next, three().next);
});

test("closeOthers no-ops: unknown id and only one leaf", () => {
  const one = solo("tree");
  assert.equal(K.closeOthers(one, "t1"), one);
  const l = three();
  assert.equal(K.closeOthers(l, "t9"), l);
});

test("closeLeft and closeRight follow leaves() order, hidden leaves included", () => {
  const l = K.minimize(four(), "t2"); // order t1 t2(hidden) t4 t6
  assert.deepEqual(ids(K.closeLeft(l, "t4")), ["t4", "t6"]);
  assert.deepEqual(ids(K.closeRight(l, "t1")), ["t1"]);
  assert.deepEqual(ids(K.closeRight(l, "t2")), ["t1", "t2"]);
  assert.deepEqual(hid(K.closeRight(l, "t2")), ["t2"]);
  assert.deepEqual(ids(K.closeLeft(four(), "t2")), ["t2", "t4", "t6"]);
});

test("closeLeft and closeRight focus: a closed focus goes to the kept leaf, an open one stays, max follows survival", () => {
  const l = four(); // focus t6
  const left = K.closeLeft(l, "t2");
  assert.equal(left.focus, "t6");
  const right = K.closeRight(l, "t2");
  assert.equal(right.focus, "t2");
  const keepMax = K.closeRight(K.maximize(l, "t1"), "t2");
  assert.deepEqual([keepMax.max, keepMax.focus], ["t1", "t1"]); // t1 is kept and maximized, so it is the focus
});

test("closeLeft keeps max when the maximized leaf survives and drops it when closed", () => {
  const m = K.maximize(four(), "t4");
  assert.equal(K.closeLeft(m, "t4").max, "t4");
  assert.equal("max" in K.closeLeft(m, "t6"), false);
  assert.equal(K.closeRight(m, "t2").max, undefined);
  assert.equal(K.closeRight(m, "t6").max, "t4");
});

test("closeLeft and closeRight no-op on the first and last leaf and on an unknown id", () => {
  const l = four();
  assert.equal(K.closeLeft(l, "t1"), l);
  assert.equal(K.closeRight(l, "t6"), l);
  assert.equal(K.closeLeft(l, "t9"), l);
  assert.equal(K.closeRight(l, "t9"), l);
  assert.notEqual(K.closeLeft(l, "t6"), l); // negative control
});

test("closing keeps a hidden kept leaf from taking focus: focus goes to the nearest visible leaf", () => {
  const l = K.minimize(four(), "t2"); // focus t6; t2 hidden
  const c = K.closeRight(l, "t2"); // t4, t6 closed: nothing visible remains but t1
  assert.deepEqual([ids(c), c.focus], [["t1", "t2"], "t1"]);
  const d = K.closeOthers(l, "t2");
  assert.deepEqual([ids(d), d.focus], [["t2"], ""]);
});

test("closeAll empties the layout, keeps next, clears max; no-op on an empty layout", () => {
  const c = K.closeAll(K.maximize(three(), "t1"));
  assert.deepEqual(plain(c), { version: 1, next: 6, focus: "", root: null });
  assert.equal(K.closeAll(c), c);
  assert.equal(K.open(c, "tree", {}).focus, "t6");
});

test("every existing operation carries max and hidden through", () => {
  const base = K.minimize(K.maximize(four(), "t1"), "t6"); // max t1, t6 hidden
  assert.deepEqual([base.max, hid(base)], ["t1", ["t6"]]);
  // resize
  const rs = K.resize(base, "s3", 0.3);
  assert.deepEqual([rs.max, hid(rs)], ["t1", ["t6"]]);
  // setView on the hidden leaf keeps it hidden, on the max leaf keeps max
  const sv = K.setView(base, "t6", "notes", {});
  assert.deepEqual([sv.max, hid(sv), views(sv)[3]], ["t1", ["t6"], "notes"]);
  const sv2 = K.setView(base, "t1", "notes", {});
  assert.deepEqual([sv2.max, hid(sv2)], ["t1", ["t6"]]);
  // focus on the max leaf's own id keeps both
  assert.equal(K.focus(base, "t1"), base);
  // focusDir
  assert.equal(K.focusDir(base, "right"), base);
  // open of a subject that exists elsewhere is a focus (moves max, hidden kept)
  const op = K.open(base, "agent", { agent: "a1" }, true);
  assert.deepEqual([op.max, op.focus, hid(op)], ["t2", "t2", ["t6"]]);
  // open that replaces the focused (max) leaf's view keeps max and hidden
  const op2 = K.open(base, "notes", {}, false);
  assert.deepEqual([op2.max, hid(op2), views(op2)[0]], ["t1", ["t6"], "notes"]);
  // move is refused while max is set
  assert.equal(K.move(base, "t1", "t2", "left"), base);
  // tile via parse: serialize then parse keeps both
  const rt = roundTrip(base);
  assert.deepEqual([rt.max, hid(rt)], ["t1", ["t6"]]);
  // close of a leaf other than max or the hidden one keeps both
  const cl = K.close(base, "t4");
  assert.deepEqual([cl.max, hid(cl)], ["t1", ["t6"]]);
});

test("move carries hidden leaves it does not touch, and refuses a hidden leaf as source or target", () => {
  const l = K.minimize(four(), "t6");
  assert.deepEqual(hid(K.move(l, "t1", "t2", "bottom")), ["t6"]);
  assert.deepEqual(hid(K.move(l, "t1", "t2", "center")), ["t6"]);
  assert.equal(K.move(l, "t6", "t1", "left"), l);
  assert.equal(K.move(l, "t1", "t6", "right"), l);
  assert.equal(K.move(l, "t1", "t6", "center"), l);
});

test("split clears max, may split a hidden leaf, and gives the new leaf focus", () => {
  const m = K.maximize(three(), "t1");
  const s = K.split(m, "t1", "row", "inbox", {});
  assert.equal("max" in s, false);
  assert.equal(s.focus, "t6");
  const h = K.split(K.minimize(three(), "t1"), "t1", "row", "inbox", {});
  assert.deepEqual([hid(h), h.focus], [["t1"], "t6"]);
});

test("open of a new subject with every window minimized splits it in beside the first leaf", () => {
  const l = K.minimize(solo("tree"), "t1");
  assert.equal(l.focus, "");
  const o = K.open(l, "inbox", {});
  assert.deepEqual([ids(o), hid(o), o.focus], [["t1", "t2"], ["t1"], "t2"]);
  // an existing subject is found, focused and unhidden instead
  const same = K.open(l, "tree", {});
  assert.deepEqual([hid(same), same.focus], [[], "t1"]);
});

test("serialize omits max and hidden when unset: a legacy layout round-trips byte-identical", () => {
  const legacy = K.serialize(three());
  assert.equal(legacy.includes("max"), false);
  assert.equal(legacy.includes("hidden"), false);
  const r = K.parse(legacy);
  assert.ok(r.ok);
  assert.equal(K.serialize(r.layout), legacy);
  const explicit = '{"version":1,"next":3,"focus":"t1","root":{"kind":"leaf","id":"t1","view":"tree","params":{}}}';
  const p = K.parse(explicit);
  assert.ok(p.ok);
  assert.equal(K.serialize(p.layout), explicit);
  // negative control: the new keys do appear when set
  assert.equal(K.serialize(K.maximize(three(), "t1")).includes('"max":"t1"'), true);
  assert.equal(K.serialize(K.minimize(three(), "t1")).includes('"hidden":true'), true);
});

test("parse accepts max and hidden, repairing focus and dropping invalid max silently", () => {
  const mk = (extra: object, leafExtra: object = {}) =>
    JSON.stringify({
      version: 1,
      next: 5,
      focus: "t1",
      ...extra,
      root: {
        kind: "split",
        id: "s3",
        dir: "row",
        ratio: 0.5,
        children: [
          { kind: "leaf", id: "t1", view: "tree", params: {}, ...leafExtra },
          { kind: "leaf", id: "t2", view: "tree", params: {} },
        ],
      },
    });
  const a = K.parse(mk({ max: "t2" }));
  assert.ok(a.ok);
  assert.deepEqual([a.layout.max, a.layout.focus], ["t2", "t2"]);
  const hiddenMax = K.parse(mk({ max: "t1" }, { hidden: true }));
  assert.ok(hiddenMax.ok);
  assert.deepEqual(["max" in hiddenMax.layout, hiddenMax.layout.focus, hid(hiddenMax.layout)], [false, "t2", ["t1"]]);
  const unknown = K.parse(mk({ max: "t9" }));
  assert.ok(unknown.ok);
  assert.equal("max" in unknown.layout, false);
  const falsy = K.parse(mk({}, { hidden: false }));
  assert.ok(falsy.ok);
  assert.equal(falsy.layout && JSON.stringify(falsy.layout).includes("hidden"), false);
  const allHidden = K.parse(JSON.stringify({ version: 1, next: 2, focus: "t1", root: { kind: "leaf", id: "t1", view: "tree", params: {}, hidden: true } }));
  assert.ok(allHidden.ok);
  assert.equal(allHidden.layout.focus, "");
  assert.equal(plain(allHidden.layout.root).hidden, true);
});

test("parse rejects malformed max and hidden with a reason that names the key", () => {
  const body = (extra: object, leafExtra: object = {}) =>
    JSON.stringify({ version: 1, next: 2, focus: "t1", ...extra, root: { kind: "leaf", id: "t1", view: "tree", params: {}, ...leafExtra } });
  for (const bad of ["yes", 1, null, {}]) {
    const r = K.parse(body({}, { hidden: bad }));
    assert.equal(r.ok, false, `hidden ${JSON.stringify(bad)}`);
    if (!r.ok) assert.match(r.reason, /hidden.*true or false|tile t1/);
  }
  for (const bad of [1, null, true, ["t1"]]) {
    const r = K.parse(body({ max: bad }));
    assert.equal(r.ok, false, `max ${JSON.stringify(bad)}`);
    if (!r.ok) assert.match(r.reason, /max .*tile id string.*reset to the default layout/);
  }
  assert.equal(K.parse(body({ max: "t1" })).ok, true); // negative control: a valid max is accepted
});

test("parse of a layout whose focus names a hidden leaf falls back to the first visible leaf", () => {
  const text = JSON.stringify({
    version: 1,
    next: 4,
    focus: "t1",
    root: {
      kind: "split",
      id: "s3",
      dir: "row",
      ratio: 0.5,
      children: [
        { kind: "leaf", id: "t1", view: "tree", params: {}, hidden: true },
        { kind: "leaf", id: "t2", view: "tree", params: {} },
      ],
    },
  });
  const r = K.parse(text);
  assert.ok(r.ok);
  assert.equal(r.layout.focus, "t2");
});

test("no operation mutates a frozen layout that carries max and hidden", () => {
  const base = deepFreeze(K.minimize(K.maximize(four(), "t1"), "t6"));
  const ops: Layout[] = [
    K.restore(base),
    K.restore(base, "t6"),
    K.minimize(base, "t2"),
    K.maximize(base, "t2"),
    K.closeOthers(base, "t2"),
    K.closeLeft(base, "t4"),
    K.closeRight(base, "t1"),
    K.closeAll(base),
    K.close(base, "t1"),
    K.focus(base, "t2"),
  ];
  assert.equal(ops.length, 10);
});

// Invariants after every operation (plan: I1 focus is a visible leaf whenever one exists, else ""; I2 max names a
// visible leaf and is the focus; I3 hidden leaves stay listed and ids are unique).
const invariants = (l: Layout, what: string): void => {
  const all = plain(K.leaves(l)) as { id: string; hidden?: boolean }[];
  const vis = all.filter((x) => !x.hidden);
  if (vis.length)
    assert.ok(
      vis.some((x) => x.id === l.focus),
      `${what}: focus ${JSON.stringify(l.focus)} must be a visible leaf`,
    );
  else assert.equal(l.focus, "", `${what}: focus must be empty when nothing is visible`);
  if (l.max) {
    assert.ok(
      vis.some((x) => x.id === l.max),
      `${what}: max must name a visible leaf`,
    );
    assert.equal(l.focus, l.max, `${what}: focus must equal max`);
  }
  assert.equal(new Set(all.map((x) => x.id)).size, all.length, `${what}: leaf ids are unique`);
  assert.deepEqual(
    plain(K.visibleLeaves(l)).map((x: { id: string }) => x.id),
    vis.map((x) => x.id),
    `${what}: visibleLeaves`,
  );
  assert.deepEqual(Object.keys(K.rects(l)).sort(), l.max ? [l.max] : vis.map((x) => x.id).sort(), `${what}: rects cover the shown leaves`);
  const re = K.parse(K.serialize(l));
  assert.ok(re.ok, `${what}: must reparse`);
  if (re.ok) assert.equal(K.serialize(re.layout), K.serialize(l), `${what}: round trip`);
};

test("invariants hold after every operation over plain, maximized, partly hidden and all-hidden layouts", () => {
  const allHidden = ["t1", "t2", "t4"].reduce((l, id) => K.minimize(l, id), three());
  const starts: [string, Layout][] = [
    ["three", three()],
    ["four", four()],
    ["max", K.maximize(four(), "t2")],
    ["hidden", K.minimize(four(), "t2")],
    ["hidden+max", K.minimize(K.maximize(four(), "t1"), "t6")],
    ["all hidden", allHidden],
    ["single", solo("tree")],
  ];
  let n = 0;
  for (const [name, l0] of starts) {
    invariants(l0, name);
    for (const id of ["t1", "t2", "t4", "t6", "t9"]) {
      const ops: [string, Layout][] = [
        ["maximize", K.maximize(l0, id)],
        ["restore", K.restore(l0, id)],
        ["minimize", K.minimize(l0, id)],
        ["close", K.close(l0, id)],
        ["closeOthers", K.closeOthers(l0, id)],
        ["closeLeft", K.closeLeft(l0, id)],
        ["closeRight", K.closeRight(l0, id)],
        ["focus", K.focus(l0, id)],
        ["split", K.split(l0, id, "row", "tree", {})],
        ["setView", K.setView(l0, id, "notes", {})],
        ["move", K.move(l0, id, "t1", "left")],
      ];
      for (const [op, l] of ops) {
        invariants(l, `${name}/${op}(${id})`);
        n++;
      }
    }
    const more: [string, Layout][] = [
      ["restore()", K.restore(l0)],
      ["closeAll", K.closeAll(l0)],
      ["open", K.open(l0, "notes", {})],
      ["open existing", K.open(l0, "tree", {})],
      ["focusDir", K.focusDir(l0, "right")],
      ["resize", K.resize(l0, "s3", 0.3)],
    ];
    for (const [op, l] of more) {
      invariants(l, `${name}/${op}`);
      n++;
    }
  }
  assert.ok(n > 300);
});

test("invariants check can fail: a layout with focus on a hidden leaf or a stray max is flagged", () => {
  const bad = { ...K.minimize(three(), "t1"), focus: "t1" } as Layout;
  assert.throws(() => invariants(bad, "bad"));
  const stray = { ...three(), max: "t1" } as Layout; // focus is t4, not the max
  assert.throws(() => invariants(stray, "stray"));
});

test("minimize and close pick the sibling subtree's visible edge leaf, else the first visible leaf", () => {
  const l = K.focus(four(), "t6");
  assert.equal(K.minimize(l, "t6").focus, "t4"); // sibling of t6 is t4 (t6 is the second child: last visible of sibling)
  const l2 = K.minimize(K.minimize(four(), "t6"), "t4"); // t6 hidden (focus t4), then t4: its sibling t6 is hidden
  assert.equal(l2.focus, "t1"); // falls to the first visible leaf in reading order
  assert.equal(K.close(K.minimize(K.focus(four(), "t4"), "t6"), "t4").focus, "t1");
});
