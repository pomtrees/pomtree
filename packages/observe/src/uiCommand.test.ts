import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { LAYOUT_LOGIC_JS, type Layout, type LayoutKitApi } from "./layout.ts";
import {
  UI_COMMAND_JS,
  UI_COMMAND_KIND,
  UI_COMMAND_PATH,
  UI_COMMAND_TTL_MS,
  UI_PRESETS,
  UI_STREAM_PATH,
  isUiPreset,
  parseUiCommand,
  parseUiFrame,
} from "./uiCommand.ts";

interface KitApi {
  parse(raw: unknown): unknown;
  tile(layout: Layout, preset: string): Layout | null;
  parseFrame(text: string): unknown;
}
// A fresh context: LayoutKit first, then the command kit as a separate script (as the page does).
const fresh = () => {
  const ctx = createContext({ globalThis: {}, JSON, Math, Number, String, isFinite, Object, Array });
  runInContext(LAYOUT_LOGIC_JS, ctx);
  return {
    L: runInContext("LayoutKit", ctx) as LayoutKitApi,
    K: runInContext(`${UI_COMMAND_JS}; UiCommandKit`, ctx) as KitApi,
  };
};
const { L, K } = fresh();
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const json = (x: unknown) => JSON.stringify(x);

test("constants", () => {
  assert.equal(UI_COMMAND_KIND, "ui_command");
  assert.equal(UI_COMMAND_TTL_MS, 30000);
  assert.equal(UI_COMMAND_PATH, "/v1/ui/command");
  assert.equal(UI_STREAM_PATH, "/live/ui");
  assert.equal(json(UI_PRESETS), '["single","columns","rows","grid"]');
  assert.equal(isUiPreset("grid"), true);
  assert.equal(isUiPreset("tabs"), false);
  assert.equal(isUiPreset(5), false);
});

const VALID: unknown[] = [
  { cmd: "open", view: "terminal", agent: "a1" },
  { cmd: "open", view: "tree" },
  { cmd: "open", view: "report", agent: "a1", report: "r1" },
  { cmd: "focus", view: "browser", agent: "a1" },
  { cmd: "focus", dir: "left" },
  { cmd: "focus", dir: "down" },
  { cmd: "close", view: "terminal", agent: "a1" },
  { cmd: "close", view: "terminal", agent: "a1", scope: "others" },
  { cmd: "close", view: "tree", scope: "left" },
  { cmd: "close", view: "report", agent: "a1", report: "r1", scope: "right" },
  { cmd: "close", scope: "all" },
  { cmd: "close", focused: true },
  { cmd: "close", focused: true, scope: "others" },
  { cmd: "close", focused: true, scope: "right" },
  { cmd: "maximize", focused: true },
  { cmd: "minimize", focused: true },
  { cmd: "maximize", view: "terminal", agent: "a1" },
  { cmd: "maximize", view: "report", agent: "a1", report: "r1" },
  { cmd: "minimize", view: "tree" },
  { cmd: "restore" },
  { cmd: "restore", view: "terminal", agent: "a1" },
  { cmd: "arrange", preset: "grid" },
  { cmd: "reset" },
  { cmd: "follow", on: true },
  { cmd: "follow", on: false },
  { cmd: "follow", on: true, views: ["terminal", "browser"], of: "a1" },
];

test("each valid command is accepted unchanged, as plain data", () => {
  for (const c of VALID) {
    const r = parseUiCommand(c);
    assert.equal(json(r), json({ ok: true, command: c }), json(c));
  }
});

test("follow leaves views and of absent when absent", () => {
  assert.equal(json(parseUiCommand({ cmd: "follow", on: true })), '{"ok":true,"command":{"cmd":"follow","on":true}}');
});

const NEGATIVE: Array<[string, unknown, string]> = [
  ["unknown key", { cmd: "reset", extra: 1 }, 'unknown key "extra"'],
  ["unknown key on open", { cmd: "open", view: "tree", agnet: "a1" }, 'unknown key "agnet"'],
  ["unknown cmd", { cmd: "explode" }, "cmd"],
  ["missing cmd", { view: "tree" }, "cmd"],
  ["bad view charset", { cmd: "open", view: "Bad View" }, "view"],
  ["open without view", { cmd: "open" }, 'open needs "view"'],
  ["close without view", { cmd: "close", agent: "a1" }, 'close needs "view"'],
  ["report without agent", { cmd: "open", view: "report", report: "r1" }, "report"],
  ["non-string agent", { cmd: "open", view: "terminal", agent: 5 }, "agent"],
  ["non-string report", { cmd: "open", view: "report", agent: "a", report: {} }, "report"],
  ["over-long agent", { cmd: "open", view: "terminal", agent: "x".repeat(257) }, "256"],
  ["focus with neither", { cmd: "focus" }, "view"],
  ["focus with both", { cmd: "focus", view: "tree", dir: "left" }, "not both"],
  ["focus bad dir", { cmd: "focus", dir: "sideways" }, "left"],
  ["focus dir with agent", { cmd: "focus", dir: "left", agent: "a1" }, "agent"],
  ["unknown preset", { cmd: "arrange", preset: "tabs" }, "single"],
  ["focused false", { cmd: "close", focused: false }, "focused must be true"],
  ["focused with view", { cmd: "close", focused: true, view: "tree" }, "takes no"],
  ["focused with agent", { cmd: "maximize", focused: true, agent: "a1" }, "takes no"],
  ["focused on open", { cmd: "open", focused: true }, "only applies to close, maximize and minimize"],
  ["focused on restore", { cmd: "restore", focused: true }, "only applies"],
  ["focused close all", { cmd: "close", focused: true, scope: "all" }, "others, left or right"],
  ["focused maximize with scope", { cmd: "maximize", focused: true, scope: "left" }, "unknown key"],
  ["focused unknown key", { cmd: "close", focused: true, foo: 1 }, "unknown key"],
  ["arrange without preset", { cmd: "arrange" }, "preset"],
  ["follow without on", { cmd: "follow" }, '"on"'],
  ["follow on not boolean", { cmd: "follow", on: "yes" }, '"on"'],
  ["follow of number", { cmd: "follow", on: true, of: 5 }, '"of"'],
  ["follow of empty", { cmd: "follow", on: true, of: "" }, '"of"'],
  ["follow of too long", { cmd: "follow", on: true, of: "x".repeat(257) }, '"of"'],
  ["close scope self", { cmd: "close", view: "tree", scope: "self" }, "others, left, right, all"],
  ["close scope typo", { cmd: "close", view: "tree", scope: "other" }, "others, left, right, all"],
  ["close scope non-string", { cmd: "close", view: "tree", scope: 3 }, "scope"],
  ["close scope others without view", { cmd: "close", scope: "others" }, "needs"],
  ["close scope left without view", { cmd: "close", scope: "left", agent: "a1" }, "needs"],
  ["close all with view", { cmd: "close", scope: "all", view: "tree" }, "takes no"],
  ["close all with agent", { cmd: "close", scope: "all", agent: "a1" }, "takes no"],
  ["close all with report", { cmd: "close", scope: "all", report: "r1" }, "takes no"],
  ["close all unknown key", { cmd: "close", scope: "all", foo: 1 }, "unknown key"],
  ["close scope with unknown key", { cmd: "close", view: "tree", scope: "left", foo: 1 }, "unknown key"],
  ["maximize without view", { cmd: "maximize" }, "needs"],
  ["maximize with scope", { cmd: "maximize", view: "tree", scope: "all" }, "unknown key"],
  ["minimize without view", { cmd: "minimize" }, "needs"],
  ["minimize report without agent", { cmd: "minimize", view: "report", report: "r1" }, "agent"],
  ["restore agent without view", { cmd: "restore", agent: "a1" }, "needs"],
  ["restore report without view", { cmd: "restore", report: "r1" }, "needs"],
  ["restore unknown key", { cmd: "restore", foo: 1 }, "unknown key"],
  ["restore bad view", { cmd: "restore", view: "Tree" }, "view"],
  ["follow views empty", { cmd: "follow", on: true, views: [] }, "views"],
  ["follow views five", { cmd: "follow", on: true, views: ["a", "b", "c", "d", "e"] }, "views"],
  ["follow views dupes", { cmd: "follow", on: true, views: ["tree", "tree"] }, "views"],
  ["follow views bad charset", { cmd: "follow", on: true, views: ["Tree"] }, "views"],
  ["follow views non-array", { cmd: "follow", on: true, views: "tree" }, "views"],
  ["null", null, "object"],
  ["array", [], "object"],
  ["string", "reset", "object"],
  ["number", 3, "object"],
  ["oversize", { cmd: "open", view: "terminal", agent: "a1", pad: "x".repeat(3000) }, "2048"],
];

test("negative controls are rejected with a cause and a fix", () => {
  for (const [name, input, needle] of NEGATIVE) {
    const r = plain(parseUiCommand(input)) as { ok: boolean; error?: string };
    assert.equal(r.ok, false, name);
    assert.equal(typeof r.error === "string" && r.error.length > 10, true, name);
    assert.equal(r.error?.includes(needle), true, `${name}: ${r.error}`);
  }
});

test("the command list names the new window commands and a typo lists them", () => {
  const e = (plain(parseUiCommand({ cmd: "maximise", view: "tree" })) as { error: string }).error;
  for (const c of ["close", "maximize", "minimize", "restore"]) assert.equal(e.includes(c), true, e);
});

test("close scope and plain close stay distinct in the parsed data", () => {
  const plainClose = plain(parseUiCommand({ cmd: "close", view: "tree" })) as { command: object };
  assert.equal("scope" in plainClose.command, false);
  assert.equal(json(plain(parseUiCommand({ cmd: "restore" }))), '{"ok":true,"command":{"cmd":"restore"}}');
});

test("parseFrame accepts the new window commands and rejects an invalid scope", () => {
  const f = (command: unknown) => json({ type: "command", seq: 1, ts: 1, command });
  assert.notEqual(parseUiFrame(f({ cmd: "close", scope: "all" })), null);
  assert.notEqual(parseUiFrame(f({ cmd: "restore" })), null);
  assert.equal(parseUiFrame(f({ cmd: "close", view: "tree", scope: "self" })), null);
  assert.equal(parseUiFrame(f({ cmd: "restore", agent: "a1" })), null);
});

test("open missing view names the fix with an example", () => {
  const r = plain(parseUiCommand({ cmd: "open" })) as { error: string };
  assert.equal(r.error.includes('{"cmd":"open","view":"terminal","agent":"<id>"}'), true);
});

test("path-like and empty agent ids are what LayoutKit.single accepts (opaque strings)", () => {
  for (const agent of ["../x", ""]) {
    const viaKit = L.single("terminal", { agent }) !== null;
    const r = plain(parseUiCommand({ cmd: "open", view: "terminal", agent })) as { ok: boolean };
    assert.equal(r.ok, viaKit, JSON.stringify(agent));
  }
});

test("a throwing input does not escape", () => {
  const evil = {
    get cmd(): string {
      throw new Error("boom");
    },
  };
  assert.equal((plain(parseUiCommand(evil)) as { ok: boolean }).ok, false);
});

test("parseFrame accepts good frames and rejects bad ones", () => {
  const cmd = { cmd: "reset" };
  const good = [
    { type: "command", seq: 3, ts: 1735689600000, command: cmd },
    { type: "spawned", seq: 0, agent: "a2", parent: "a1" },
  ];
  for (const f of good) assert.equal(json(parseUiFrame(json(f))), json(f));
  const bad = [
    "not json",
    "null",
    "[]",
    json({ type: "other", seq: 1 }),
    json({ type: "spawned", seq: -1, agent: "a", parent: "b" }),
    json({ type: "spawned", seq: 1.5, agent: "a", parent: "b" }),
    json({ type: "spawned", seq: "1", agent: "a", parent: "b" }),
    json({ type: "spawned", seq: 1, agent: 3, parent: "b" }),
    json({ type: "spawned", seq: 1, agent: "a" }),
    json({ type: "command", seq: 1, ts: 1, command: { cmd: "explode" } }),
    json({ type: "command", seq: 1, command: cmd }),
    json({ type: "command", seq: 1, ts: "2025-01-01", command: cmd }),
  ];
  for (const t of bad) assert.equal(parseUiFrame(t), null, t);
  assert.equal(K.parseFrame("not json"), null);
});

const many = (n: number): Layout => {
  let l = L.single("tree") as Layout;
  // Split the largest tile each time so the tree stays shallow enough for 16 leaves.
  for (let i = 1; i < n; i++) {
    const r = Object.entries(plain(L.rects(l)) as Record<string, { w: number; h: number }>);
    const [big, rc] = r.reduce((a, b) => (b[1].w * b[1].h > a[1].w * a[1].h + 1e-12 ? b : a));
    l = L.split(l, big, rc.w >= rc.h ? "row" : "col", "terminal", { agent: `a${i}` });
  }
  assert.equal(L.leaves(l).length, n);
  return l;
};
const sig = (l: Layout) =>
  plain(L.leaves(l))
    .map((x: { view: string; params: unknown }) => json([x.view, x.params]))
    .sort()
    .join("|");

test("tile re-tiles current leaves for every preset and leaf count", () => {
  for (const n of [1, 2, 3, 5, 16]) {
    const src = many(n);
    for (const preset of UI_PRESETS) {
      const out = K.tile(src, preset);
      assert.ok(out, `${preset} ${n}`);
      const again = L.parse(L.serialize(out as Layout));
      assert.equal(again.ok, true, `${preset} ${n} parses`);
      if (preset === "single") {
        assert.equal(L.leaves(out as Layout).length, 1);
        const focused = L.leaves(src).find((x) => x.id === src.focus);
        assert.equal(sig(out as Layout), sig(L.single(focused?.view as string, focused?.params) as Layout));
        assert.equal((out as Layout).focus, src.focus);
      } else {
        assert.equal(sig(out as Layout), sig(src), `${preset} ${n} keeps views`);
        assert.equal((out as Layout).focus, src.focus);
        assert.equal(L.leaves(out as Layout).length, n);
      }
    }
  }
});

test("tile shapes: columns are side by side, rows stacked, deterministic", () => {
  const src = many(3);
  const cols = K.tile(src, "columns") as Layout;
  const rects = Object.values(plain(L.rects(cols))) as Array<{ x: number; y: number; w: number; h: number }>;
  assert.equal(
    rects.every((r) => r.h === 1 && Math.abs(r.w - 1 / 3) < 1e-9),
    true,
  );
  const rows = K.tile(src, "rows") as Layout;
  const rr = Object.values(plain(L.rects(rows))) as Array<{ w: number; h: number }>;
  assert.equal(
    rr.every((r) => r.w === 1 && Math.abs(r.h - 1 / 3) < 1e-9),
    true,
  );
  assert.equal(L.serialize(K.tile(src, "grid") as Layout), L.serialize(K.tile(src, "grid") as Layout));
});

test("tile on an empty layout is null; unknown preset is null", () => {
  const empty = L.close(L.single("tree") as Layout, "t1");
  assert.equal(K.tile(empty, "grid"), null);
  assert.equal(K.tile(many(2), "tabs"), null);
});

// A layout of n agent terminals where the leaves whose index is in `hide` are minimized (via the layout kit itself).
const withHidden = (n: number, hide: number[], focusIdx = 0): Layout => {
  let l = many(n);
  const all = L.leaves(l).map((x) => x.id) as string[];
  l = L.focus(l, all[focusIdx] as string);
  for (const i of hide) l = L.minimize(l, all[i] as string);
  return l;
};
const area = (l: Layout) =>
  Object.values(plain(L.rects(l)) as Record<string, { w: number; h: number }>)
    .reduce((a, r) => a + r.w * r.h, 0)
    .toFixed(9);
const ids = (l: Layout) => L.leaves(l).map((x) => x.id);

test("tile with hidden leaves: shown tiles fill the area, hidden flags and ids kept, max cleared", () => {
  for (const preset of ["columns", "rows", "grid"]) {
    const src = withHidden(6, [1, 4], 2);
    const out = K.tile(src, preset) as Layout;
    assert.ok(out, preset);
    assert.equal(L.parse(L.serialize(out)).ok, true, `${preset} parses`);
    assert.equal(Object.keys(plain(L.rects(out))).length, 4, `${preset} shows 4`);
    assert.equal(area(out), "1.000000000", `${preset} shown tiles fill the area`);
    const hid = L.leaves(out).filter((x) => x.hidden === true);
    assert.equal(json(hid.map((x) => x.id).sort()), json([ids(src)[1], ids(src)[4]].sort()), `${preset} hidden ids`);
    assert.equal(sig(out), sig(src), `${preset} keeps views`);
    assert.equal(out.focus, src.focus, `${preset} focus kept when shown`);
    assert.equal(out.max, undefined);
    // negative control: shown windows are exactly the non-hidden ones
    assert.equal(
      json(Object.keys(plain(L.rects(out))).sort()),
      json(
        L.visibleLeaves(src)
          .map((x) => x.id)
          .sort(),
      ),
    );
  }
});

test("tile with hidden leaves: shown areas equal a tiling of only the shown leaves (grid)", () => {
  const src = withHidden(5, [0, 3]);
  const out = K.tile(src, "grid") as Layout;
  const solo = K.tile(many(3), "grid") as Layout;
  const a = Object.values(plain(L.rects(out)) as Record<string, { w: number; h: number }>).map((r) => (r.w * r.h).toFixed(9));
  const b = Object.values(plain(L.rects(solo)) as Record<string, { w: number; h: number }>).map((r) => (r.w * r.h).toFixed(9));
  assert.equal(json(a), json(b));
  // negative control: tiling all five would give different areas
  const five = Object.values(plain(L.rects(K.tile(many(5), "grid") as Layout)) as Record<string, { w: number; h: number }>).map((r) => (r.w * r.h).toFixed(9));
  assert.notEqual(json(a), json(five));
});

test("tile clears max and falls back focus to the first shown leaf when the focused one is hidden", () => {
  let src = many(3);
  const [a, b, c] = ids(src) as [string, string, string];
  src = L.maximize(src, b);
  assert.equal(src.max, b);
  const out = K.tile(src, "columns") as Layout;
  assert.equal(out.max, undefined);
  assert.equal(out.focus, b);
  const hiddenFocus = { ...L.minimize(many(3), a), focus: a } as Layout; // focus on a hidden leaf (invalid input, parse would repair)
  const out2 = K.tile(hiddenFocus, "rows") as Layout;
  assert.equal(out2.focus, b);
  assert.equal(L.parse(L.serialize(out2)).ok, true);
  assert.notEqual(out2.focus, c);
});

test("tile with every leaf hidden keeps the hidden subtree and focus is empty; single is null", () => {
  const src = withHidden(3, [0, 1, 2]);
  for (const preset of ["columns", "rows", "grid"]) {
    const out = K.tile(src, preset) as Layout;
    assert.ok(out, preset);
    assert.equal(
      L.leaves(out).every((x) => x.hidden === true),
      true,
    );
    assert.equal(out.focus, "");
    assert.equal(L.parse(L.serialize(out)).ok, true);
  }
  assert.equal(K.tile(src, "single"), null);
});

test("tile single keeps only the focused shown leaf, dropping hidden ones; hidden focus falls to first shown", () => {
  const src = withHidden(4, [0, 2], 3);
  const out = K.tile(src, "single") as Layout;
  assert.equal(json(ids(out)), json([ids(src)[3]]));
  assert.equal(L.leaves(out)[0]?.hidden, undefined);
  const hf = { ...src, focus: ids(src)[0] } as Layout;
  assert.equal(json(ids(K.tile(hf, "single") as Layout)), json([ids(src)[1]]));
});

test("tile without hidden leaves is unchanged by the hidden handling (no extra split, next as before)", () => {
  const src = many(5);
  const out = K.tile(src, "grid") as Layout;
  assert.equal(out.next, src.next + 4);
  assert.equal(
    L.leaves(out).some((x) => x.hidden !== undefined),
    false,
  );
});

test("tile depth stays within MAX_DEPTH at 16 leaves with hidden windows, every preset", () => {
  for (const [n, hide] of [
    [16, [9, 10, 11, 12, 13, 14, 15]],
    [16, Array.from({ length: 15 }, (_, i) => i + 1)],
    [16, [0]],
  ] as Array<[number, number[]]>) {
    const src = withHidden(n, hide, 0);
    for (const preset of UI_PRESETS) {
      const out = K.tile(src, preset) as Layout;
      assert.ok(out, `${preset} ${hide.length} hidden`);
      assert.equal(L.parse(L.serialize(out)).ok, true, `${preset} ${hide.length} hidden parses`);
      assert.equal(L.leaves(out).length, preset === "single" ? 1 : 16);
    }
  }
});

test("kit source is template-literal safe", () => {
  assert.equal(UI_COMMAND_JS.includes("`"), false);
  assert.equal(UI_COMMAND_JS.includes("${"), false);
  assert.equal(UI_COMMAND_JS.includes("\\"), false);
});

test("standalone kit and TS wrapper give the same verdicts", () => {
  const inputs = [...VALID, ...NEGATIVE.map((n) => n[1])];
  for (const i of inputs) assert.equal(json(K.parse(i)), json(parseUiCommand(i)), json(i)?.slice(0, 80));
});
