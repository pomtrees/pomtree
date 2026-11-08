import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { PANE_KIT_JS } from "./paneKit.ts";
import type { WindowModel } from "./menuModel.ts";

const load = () => {
  const ctx = createContext({ JSON, Object, Array, Set, Map, String, Error, RegExp, Date, Math, Number, WeakSet });
  return runInContext(`(() => { ${PANE_KIT_JS}; return K; })()`, ctx) as {
    declareSection(d: Record<string, unknown>): void;
    sectionModel(id: string): WindowModel | undefined;
    sectionHost(id: string): { setMenuState: unknown; setStatus: unknown; onCommand(h: (c: string, a: unknown) => void): void };
  };
};
const decl = {
  id: "inbox",
  title: "Inbox",
  menus: [{ id: "view", items: [{ kind: "action", command: "inbox.refresh", label: "Refresh" }] }],
  status: [{ id: "count", title: "Count" }],
};

test("declareSection creates one persistent model; sectionModel is undefined for an undeclared id", () => {
  const P = load();
  assert.equal(P.sectionModel("inbox"), undefined);
  P.declareSection(decl);
  const m = P.sectionModel("inbox")!;
  assert.equal(m.declaration.id, "inbox");
  assert.equal(m.declaration.multi, false);
  assert.equal(P.sectionModel("inbox"), m);
});

test("sectionHost drives the section model: state, status and commands", () => {
  const P = load();
  P.declareSection(decl);
  const h = P.sectionHost("inbox");
  const seen: string[] = [];
  h.onCommand((c) => seen.push(c));
  P.sectionModel("inbox")!.invoke("inbox.refresh");
  assert.deepEqual(seen, ["inbox.refresh"]);
  (h.setStatus as (i: string, p: object) => void)("count", { text: "3" });
  assert.equal(P.sectionModel("inbox")!.status()[0]!.text, "3");
});

test("declareSection and sectionHost errors name cause and action", () => {
  const P = load();
  assert.throws(() => P.declareSection({ ...decl, id: "Bad Id" }), /invalid section id.*lowercase data-tab id/);
  P.declareSection(decl);
  assert.throws(() => P.declareSection(decl), /already declared; declare each section once/);
  assert.throws(() => P.declareSection({ ...decl, id: "x", menus: [{ id: "nope", items: [] }] }), /declareView/);
  assert.throws(() => P.sectionHost("zzz"), /not declared; call declareSection first/);
});
