import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { MENU_NAV_JS, type MenuNavApi, type NavItem } from "./menuNav.ts";

const N = runInContext(
  `(() => { ${MENU_NAV_JS}; return MenuNav; })()`,
  createContext({ globalThis: {}, JSON, Object, Array, String, Error, Number }),
) as MenuNavApi;

// The kit runs in a vm realm, so compare through JSON to avoid cross-realm prototype mismatches.
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

const rows: NavItem[] = [
  { kind: "heading", label: "Options" }, // 0
  { kind: "action", label: "Copy trace" }, // 1
  { kind: "action", label: "Cut", enabled: false }, // 2 disabled
  { kind: "separator" }, // 3
  { kind: "toggle", label: "Include raw" }, // 4
  { kind: "radio-option", label: "Copy all" }, // 5
];

test("nextIndex wraps and skips disabled rows, headings and separators", () => {
  assert.equal(N.nextIndex(rows, 1, 1), 4);
  assert.equal(N.nextIndex(rows, 5, 1), 1);
  assert.equal(N.nextIndex(rows, 1, -1), 5);
  assert.equal(N.nextIndex(rows, 4, -1), 1);
});

test("nextIndex with nothing focused starts at the matching end", () => {
  assert.equal(N.nextIndex(rows, -1, 1), 1);
  assert.equal(N.nextIndex(rows, -1, -1), 5);
});

test("nextIndex, firstIndex and lastIndex return -1 when nothing can take focus", () => {
  const dead: NavItem[] = [{ kind: "heading" }, { kind: "action", enabled: false }];
  assert.equal(N.nextIndex(dead, 0, 1), -1);
  assert.equal(N.firstIndex(dead), -1);
  assert.equal(N.lastIndex(dead), -1);
  assert.equal(N.firstIndex([]), -1);
  assert.equal(N.firstIndex(rows), 1);
  assert.equal(N.lastIndex(rows), 5);
});

test("typeahead: a letter cycles through matches, longer text matches a prefix, misses return -1", () => {
  const items: NavItem[] = [
    { kind: "action", label: "Smaller" },
    { kind: "action", label: "Short" },
    { kind: "action", label: "Shout", enabled: false },
    { kind: "action", label: "Reset" },
  ];
  assert.equal(N.typeahead(items, -1, "s"), 0);
  assert.equal(N.typeahead(items, 0, "s"), 1);
  assert.equal(N.typeahead(items, 1, "s"), 0, "disabled Shout skipped; wraps");
  assert.equal(N.typeahead(items, 0, "SH"), 1, "case-insensitive prefix");
  assert.equal(N.typeahead(items, 1, "ss"), 0, "a repeated letter cycles");
  assert.equal(N.typeahead(items, 0, "x"), -1);
  assert.equal(N.typeahead(items, 0, ""), -1);
  assert.equal(N.typeahead(rows, -1, "o"), -1, "heading text is not matched");
});

test("keyAction in a bar button", () => {
  const k = (key: string) => plain(N.keyAction("bar-button", key));
  assert.deepEqual(k("ArrowDown"), { type: "open-first" });
  assert.deepEqual(k("Enter"), { type: "open-first" });
  assert.deepEqual(k(" "), { type: "open-first" });
  assert.deepEqual(k("ArrowUp"), { type: "open-last" });
  assert.deepEqual(k("ArrowRight"), { type: "switch-menu", dir: 1 });
  assert.deepEqual(k("ArrowLeft"), { type: "switch-menu", dir: -1 });
  assert.deepEqual(k("Home"), { type: "bar-edge", edge: "first" });
  assert.deepEqual(k("End"), { type: "bar-edge", edge: "last" });
  assert.deepEqual(k("Escape"), { type: "close-return-focus" });
  assert.deepEqual(k("Tab"), { type: "close" });
  assert.deepEqual(k("a"), { type: "none" });
});

test("keyAction in a menu", () => {
  const k = (key: string) => plain(N.keyAction("menu", key));
  assert.deepEqual(k("ArrowDown"), { type: "move", dir: 1 });
  assert.deepEqual(k("ArrowUp"), { type: "move", dir: -1 });
  assert.deepEqual(k("Home"), { type: "edge", edge: "first" });
  assert.deepEqual(k("End"), { type: "edge", edge: "last" });
  assert.deepEqual(k("Enter"), { type: "activate" });
  assert.deepEqual(k(" "), { type: "activate" });
  assert.deepEqual(k("ArrowRight"), { type: "switch-menu", dir: 1 });
  assert.deepEqual(k("Escape"), { type: "close-return-focus" });
  assert.deepEqual(k("Tab"), { type: "close" });
  assert.deepEqual(k("q"), { type: "typeahead", key: "q" });
  assert.deepEqual(k("F5"), { type: "none" });
});

test("keyAction ignores keys held with ctrl, alt or meta", () => {
  assert.deepEqual(plain(N.keyAction("menu", "a", { ctrl: true })), { type: "none" });
  assert.deepEqual(plain(N.keyAction("bar-button", "ArrowDown", { alt: true })), { type: "none" });
  assert.deepEqual(plain(N.keyAction("menu", "Escape", { meta: true })), { type: "none" });
});

test("unusual input fails loudly with cause and action", () => {
  assert.throws(() => N.nextIndex("x" as never, 0, 1), /items must be an array.*pass the rows/);
  assert.throws(() => N.nextIndex(rows, 0, 2 as never), /dir must be 1 or -1.*use 1 for down/);
  assert.throws(() => N.keyAction("popup" as never, "a"), /unknown context.*use bar-button or menu/);
  assert.throws(() => N.keyAction("menu", 7 as never), /key must be.*pass event\.key/);
});
