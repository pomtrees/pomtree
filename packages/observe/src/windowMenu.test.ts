import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { LAYOUT_LOGIC_JS, type Layout, type LayoutKitApi } from "./layout.ts";
import { WINDOW_MENU_JS, type WindowMenuKitApi } from "./windowMenu.ts";

const load = `(() => { ${LAYOUT_LOGIC_JS}; ${WINDOW_MENU_JS}; return { LayoutKit, WindowMenuKit }; })()`;
const kits = runInContext(load, createContext({ globalThis: {}, JSON, Math, Number, String, isFinite, Object, Array })) as {
  LayoutKit: LayoutKitApi;
  WindowMenuKit: WindowMenuKitApi;
};
const L = kits.LayoutKit;
const W = kits.WindowMenuKit;

const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
// t1 | (t2 / (t4 | t6)): reading order t1 t2 t4 t6, focus t6.
const four = (): Layout => {
  const a = L.single("tree");
  assert.ok(a);
  return L.split(L.split(L.split(a, "t1", "row", "agent", { agent: "a1" }), "t2", "col", "inbox", {}), "t4", "row", "tree", {});
};
const ids = (l: Layout): string[] => plain(L.leaves(l).map((x) => x.id));
const row = (l: Layout, leaf: string | null, opts?: { narrow?: boolean }) =>
  Object.fromEntries(
    plain(W.items(l, leaf, opts))
      .filter((i: { kind: string }) => i.kind === "action")
      .map((i: { command: string; enabled: boolean; visible: boolean }) => [i.command, `${i.enabled ? "on" : "off"}${i.visible ? "" : "/hidden"}`]),
  ) as Record<string, string>;

test("COMMANDS lists the eight window command ids", () => {
  assert.deepEqual(plain(W.COMMANDS), [
    "window.close",
    "window.close-others",
    "window.close-left",
    "window.close-right",
    "window.close-all",
    "window.maximize",
    "window.restore",
    "window.minimize",
  ]);
});

test("items order and labels: Restore, Maximize, Minimize, separator, Close, Close others, left, right, all", () => {
  const items = plain(W.items(four(), "t2")) as { kind: string; label?: string }[];
  assert.deepEqual(
    items.map((i) => (i.kind === "separator" ? "---" : i.label)),
    ["Restore", "Maximize", "Minimize", "---", "Close", "Close others", "Close to the left", "Close to the right", "Close all"],
  );
  assert.deepEqual(plain(items[1]), { kind: "action", command: "window.maximize", label: "Maximize", enabled: true, visible: true });
});

test("plain leaf in a multi-window layout: restore hidden, everything else enabled by position", () => {
  assert.deepEqual(row(four(), "t2"), {
    "window.restore": "off/hidden",
    "window.maximize": "on",
    "window.minimize": "on",
    "window.close": "on",
    "window.close-others": "on",
    "window.close-left": "on",
    "window.close-right": "on",
    "window.close-all": "on",
  });
});

test("close to the left is disabled on the first leaf, close to the right on the last, in leaves() order", () => {
  assert.equal(row(four(), "t1")["window.close-left"], "off");
  assert.equal(row(four(), "t1")["window.close-right"], "on");
  assert.equal(row(four(), "t6")["window.close-right"], "off");
  assert.equal(row(four(), "t6")["window.close-left"], "on");
});

test("close-left and close-right count hidden leaves: the first leaf being hidden still enables close-left on the second", () => {
  const l = L.minimize(four(), "t1");
  assert.equal(row(l, "t2")["window.close-left"], "on");
  assert.equal(row(l, "t1")["window.close-left"], "off");
});

test("a single window: close others, left, right and maximize are disabled; close, close all and minimize on", () => {
  const one = L.single("tree");
  assert.ok(one);
  assert.deepEqual(row(one, "t1"), {
    "window.restore": "off/hidden",
    "window.maximize": "off",
    "window.minimize": "on",
    "window.close": "on",
    "window.close-others": "off",
    "window.close-left": "off",
    "window.close-right": "off",
    "window.close-all": "on",
  });
});

test("the maximized leaf shows Restore enabled and Maximize disabled, never both enabled", () => {
  const m = L.maximize(four(), "t2");
  const r = row(m, "t2");
  assert.equal(r["window.restore"], "on");
  assert.equal(r["window.maximize"], "off");
  // negative control: a different leaf in the same layout is neither restorable nor un-maximizable
  const other = row(m, "t1");
  assert.equal(other["window.restore"], "off/hidden");
  assert.equal(other["window.maximize"], "on");
});

test("a hidden leaf shows both Restore and Maximize enabled and Minimize disabled", () => {
  const h = L.minimize(four(), "t2");
  const r = row(h, "t2");
  assert.deepEqual([r["window.restore"], r["window.maximize"], r["window.minimize"]], ["on", "on", "off"]);
});

test("maximize on a hidden last visible-window layout stays enabled because the leaf is hidden", () => {
  const one = L.minimize(L.single("tree") as Layout, "t1");
  assert.equal(row(one, "t1")["window.maximize"], "on");
});

test("narrow mode hides maximize, restore and minimize and disables the multi-window closes; close and close all stay on", () => {
  const m = L.maximize(four(), "t2");
  for (const l of [four(), m, L.minimize(four(), "t2")]) {
    assert.deepEqual(row(l, "t2", { narrow: true }), {
      "window.restore": "off/hidden",
      "window.maximize": "off/hidden",
      "window.minimize": "off/hidden",
      "window.close": "on",
      "window.close-others": "off",
      "window.close-left": "off",
      "window.close-right": "off",
      "window.close-all": "on",
    });
  }
  assert.equal(W.enabled(four(), "window.maximize", "t2", { narrow: true }), false);
  assert.equal(W.enabled(four(), "window.maximize", "t2"), true); // negative control
});

test("enabled is false for an unknown leaf, an unknown command and a null leaf, except close-all and restore", () => {
  const l = four();
  assert.equal(W.enabled(l, "window.close", "t9"), false);
  assert.equal(W.enabled(l, "window.nope", "t1"), false);
  assert.equal(W.enabled(l, "window.close", null), false);
  assert.equal(W.enabled(l, "window.close-all", null), true);
  assert.equal(W.enabled(l, "window.restore", null), false);
  assert.equal(W.enabled(L.maximize(l, "t2"), "window.restore", null), true);
  const empty = L.closeAll(l);
  assert.equal(W.enabled(empty, "window.close-all", null), false);
});

test("apply delegates to LayoutKit for every command", () => {
  const l = four();
  assert.deepEqual(ids(W.apply(l, "window.close", "t2")), ["t1", "t4", "t6"]);
  assert.deepEqual(ids(W.apply(l, "window.close-others", "t2")), ["t2"]);
  assert.deepEqual(ids(W.apply(l, "window.close-left", "t4")), ["t4", "t6"]);
  assert.deepEqual(ids(W.apply(l, "window.close-right", "t4")), ["t1", "t2", "t4"]);
  assert.deepEqual(ids(W.apply(l, "window.close-all", null)), []);
  assert.equal(W.apply(l, "window.maximize", "t2").max, "t2");
  assert.deepEqual(
    plain(
      L.leaves(W.apply(l, "window.minimize", "t2"))
        .filter((x) => x.hidden)
        .map((x) => x.id),
    ),
    ["t2"],
  );
  const m = W.apply(l, "window.maximize", "t2");
  assert.equal("max" in W.apply(m, "window.restore", "t2"), false);
  assert.equal("max" in W.apply(m, "window.restore", null), false);
  const h = W.apply(l, "window.minimize", "t2");
  assert.equal(L.isHidden(W.apply(h, "window.restore", "t2"), "t2"), false);
});

test("apply returns the same reference when the command is disabled", () => {
  const l = four();
  assert.equal(W.apply(l, "window.close-left", "t1"), l);
  assert.equal(W.apply(l, "window.close-right", "t6"), l);
  assert.equal(W.apply(l, "window.restore", "t2"), l);
  assert.equal(W.apply(l, "window.close", "t9"), l);
  assert.equal(W.apply(l, "window.nope", "t1"), l);
  assert.equal(W.apply(l, "window.maximize", null), l);
  const m = W.apply(l, "window.maximize", "t2");
  assert.equal(W.apply(m, "window.maximize", "t2"), m);
  const h = W.apply(l, "window.minimize", "t2");
  assert.equal(W.apply(h, "window.minimize", "t2"), h);
  const one = L.single("tree") as Layout;
  assert.equal(W.apply(one, "window.maximize", "t1"), one);
  assert.equal(W.apply(one, "window.close-others", "t1"), one);
  const empty = L.closeAll(l);
  assert.equal(W.apply(empty, "window.close-all", null), empty);
  assert.equal(W.apply(l, "window.close-others", "t2", { narrow: true }), l);
});

test("fromUiCommand maps drive commands to ids and everything else to null", () => {
  assert.equal(W.fromUiCommand({ cmd: "close" }), "window.close");
  assert.equal(W.fromUiCommand({ cmd: "close", scope: "others" }), "window.close-others");
  assert.equal(W.fromUiCommand({ cmd: "close", scope: "left" }), "window.close-left");
  assert.equal(W.fromUiCommand({ cmd: "close", scope: "right" }), "window.close-right");
  assert.equal(W.fromUiCommand({ cmd: "close", scope: "all" }), "window.close-all");
  assert.equal(W.fromUiCommand({ cmd: "maximize" }), "window.maximize");
  assert.equal(W.fromUiCommand({ cmd: "minimize" }), "window.minimize");
  assert.equal(W.fromUiCommand({ cmd: "restore" }), "window.restore");
  for (const bad of [{ cmd: "open" }, { cmd: "focus" }, { cmd: "close", scope: "bogus" }, { cmd: "close", scope: "toString" }, {}, null, undefined]) {
    assert.equal(W.fromUiCommand(bad as never), null, JSON.stringify(bad));
  }
});

test("every id produced by items and fromUiCommand is in COMMANDS (no second table)", () => {
  const set = new Set(plain(W.COMMANDS));
  for (const i of plain(W.items(four(), "t2")) as { kind: string; command?: string }[]) if (i.kind === "action") assert.ok(set.has(i.command));
  for (const c of [{ cmd: "close", scope: "all" }, { cmd: "maximize" }, { cmd: "restore" }, { cmd: "minimize" }]) assert.ok(set.has(W.fromUiCommand(c)));
});
