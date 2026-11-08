import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { MENU_KIT_JS, type MenuKitApi, type ViewDeclaration } from "./menuModel.ts";
import { BROWSER_DECLARATION, INBOX_DECLARATION, REPORT_DECLARATION, TERMINAL_DECLARATION, VIEW_DECLARATIONS } from "./viewMenus.ts";

const K = runInContext(
  `(() => { ${MENU_KIT_JS}; return MenuKit; })()`,
  createContext({ globalThis: {}, JSON, Math, Number, String, isFinite, Object, Array }),
) as MenuKitApi;

// The kit runs in a vm realm, so compare through JSON to avoid cross-realm prototype mismatches.
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const menuIds = (d: ViewDeclaration) => (d.menus ?? []).map((m) => m.id);
const commandsOf = (d: ViewDeclaration) => (d.menus ?? []).flatMap((m) => m.items.filter((it) => it.kind !== "separator").map((it) => it.command));

test("each declaration passes declareView and keeps its id, title and multi flag", () => {
  const expected: Array<[string, string, boolean]> = [
    ["terminal", "Terminal", true],
    ["browser", "Browser", true],
    ["inbox", "Inbox", false],
    ["report", "Report", true],
  ];
  VIEW_DECLARATIONS.forEach((d, i) => {
    const n = K.declareView(d);
    assert.deepEqual([n.id, n.title, n.multi], expected[i]);
  });
});

test("menu id sets per view match the mock", () => {
  assert.deepEqual(menuIds(TERMINAL_DECLARATION), ["view", "trace", "session", "help"]);
  assert.deepEqual(menuIds(BROWSER_DECLARATION), ["view", "help"]);
  assert.deepEqual(menuIds(INBOX_DECLARATION), ["view", "help"]);
  assert.deepEqual(menuIds(REPORT_DECLARATION), ["view", "help"]);
});

test("each declaration deep-equals its own JSON round trip", () => {
  for (const d of VIEW_DECLARATIONS) assert.deepEqual(plain(d), d);
});

test("command ids are unique across all declarations", () => {
  const all = VIEW_DECLARATIONS.flatMap(commandsOf);
  assert.equal(new Set(all).size, all.length, `duplicate commands in ${all.join(", ")}`);
  assert.equal(all.length, 20);
});

test("negative control: a duplicated command is rejected by declareView", () => {
  const bad = structuredClone(TERMINAL_DECLARATION);
  const session = bad.menus?.find((m) => m.id === "session");
  assert.ok(session);
  session.items = [{ kind: "action", command: "terminal.font-reset", label: "Reconnect" }];
  assert.throws(() => K.declareView(bad), /declared twice/);
});

test("terminal Reconnect is hidden until shown, and the Session menu follows it", () => {
  const model = K.createWindowModel(K.declareView(TERMINAL_DECLARATION));
  assert.deepEqual(plain(model.menus().map((m) => m.id)), ["view", "trace", "help"]);
  model.setState("terminal.reconnect", { visible: true });
  assert.deepEqual(plain(model.menus().map((m) => m.id)), ["view", "trace", "session", "help"]);
});

test("the report declaration holds Download and View source in View, the sandbox warning in Help, and a sandbox status slot", () => {
  const n = K.declareView(REPORT_DECLARATION);
  assert.deepEqual(plain(commandsOf(REPORT_DECLARATION)), ["report.download", "report.view-source", "report.sandbox"]);
  assert.deepEqual(plain(n.status.map((x) => x.id)), ["sandbox"]);
  const warn = REPORT_DECLARATION.menus?.find((m) => m.id === "help")?.items.find((it) => it.kind === "action" && it.command === "report.sandbox");
  assert.ok(warn && warn.kind === "action" && /scripts and network are disabled/.test(warn.hint ?? ""));
});
