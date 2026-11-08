import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import {
  LAUNCHER_LOGIC_JS,
  type AgentInfo,
  type BuildCtx,
  type LauncherKitApi,
  type LeafLike,
  type MenuEntry,
  type OmniItem,
  type ViewDef,
} from "./launcherModel.ts";

const K = runInContext(
  `(() => { ${LAUNCHER_LOGIC_JS}; return LauncherKit; })()`,
  createContext({ globalThis: {}, JSON, Math, Number, String, isFinite, Object, Array }),
) as LauncherKitApi;

// The kit runs in a vm realm, so compare through JSON to avoid cross-realm prototype mismatches.
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const deepFreeze = <T>(x: T): T => {
  if (x && typeof x === "object") {
    for (const v of Object.values(x)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
};

const VIEWS: ViewDef[] = [
  { id: "tree", title: "Tree", multi: false },
  { id: "inbox", title: "Inbox", multi: false },
  { id: "agent", title: "Agent", multi: true },
];
const ag = (id: string, name: string, state = "running", exit: string | null = null): AgentInfo => ({ id, name, state, exit });
const leaf = (id: string, view: string, agent?: string): LeafLike => ({ id, view, params: agent ? { agent } : {} });
const ctx = (over: Partial<BuildCtx> = {}): BuildCtx =>
  deepFreeze({
    leaves: [leaf("t1", "tree"), leaf("t2", "agent", "a1")],
    focus: "t2",
    views: VIEWS,
    agents: [ag("a1", "alpha"), ag("a2", "beta", "yielded"), ag("a3", "gone", "reaped")],
    narrow: false,
    maxLeaves: 16,
    inboxCount: 0,
    ...over,
  });
const labels = (items: OmniItem[]) => plain(items.map((i) => i.label));
const item = (label: string, kind: OmniItem["kind"] = "open", hint = ""): OmniItem => ({
  key: `${kind}:${label}`,
  kind,
  label,
  hint,
  dot: "none",
  run: { type: "action", id: "sign-out" },
});

test("constants", () => {
  assert.equal(K.MAX_AGENT_ITEMS, 200);
  assert.equal(K.COMPACT_AT, 6);
  assert.equal(K.FAIL_OFFLINE_AT, 3);
  assert.equal(K.OPEN_SHORTCUT, "Alt+Shift+P");
});

test("normalizeAgents drops junk rows, defaults fields, clips names, caps rows", () => {
  assert.deepEqual(plain(K.normalizeAgents("x")), []);
  assert.deepEqual(plain(K.normalizeAgents(undefined)), []);
  const long = "n".repeat(100);
  const rows = deepFreeze([
    null,
    5,
    "s",
    {},
    { id: 3 },
    { id: "" },
    { id: "i".repeat(257) },
    { id: "a", name: 7, state: 1, exit: 2, extra: "x" },
    { id: "b", name: long, state: "exited", exit: "failed" },
    { id: "c", name: "", state: "running", exit: null },
  ]);
  const out = plain(K.normalizeAgents(rows));
  assert.deepEqual(out[0], { id: "a", name: "a", state: "unknown", exit: null });
  assert.equal(out[1].name.length, 80);
  assert.equal(out[1].exit, "failed");
  assert.equal(out[2].name, "c");
  assert.equal(out.length, 3);
  const many = Array.from({ length: 1500 }, (_, i) => ({ id: `x${i}` }));
  assert.equal(K.normalizeAgents(many).length, 1000);
  assert.equal(K.normalizeAgents([{ id: "i".repeat(256) }])[0]?.id.length, 256);
});

test("agentDot maps states", () => {
  assert.equal(K.agentDot(ag("a", "a", "running")), "ok");
  assert.equal(K.agentDot(ag("a", "a", "pending")), "info");
  assert.equal(K.agentDot(ag("a", "a", "yielded")), "warn");
  for (const e of ["failed", "timed_out", "over_budget"]) assert.equal(K.agentDot(ag("a", "a", "exited", e)), "err");
  assert.equal(K.agentDot(ag("a", "a", "exited", "done")), "none");
  assert.equal(K.agentDot(ag("a", "a", "exited")), "none");
  assert.equal(K.agentDot(ag("a", "a", "reaped", "failed")), "none");
  assert.equal(K.agentDot(ag("a", "a", "unknown")), "none");
  assert.equal(K.agentDot(undefined), "none");
});

test("summarizePoll", () => {
  const rows = [{ id: "a1", name: "x", state: "running", exit: null }];
  const ok = plain(K.summarizePoll(deepFreeze({ agents: rows, approvals: [1, 2], escalations: [], errors: [] })));
  assert.equal(ok.ok, true);
  assert.equal(ok.agents.length, 1);
  assert.equal(ok.approvals, 2);
  assert.equal(ok.escalations, 0);
  assert.equal(ok.cause, "");
  const bad = plain(K.summarizePoll({ agents: { error: 1 }, approvals: "x", escalations: undefined, errors: [] }));
  assert.equal(bad.ok, false);
  assert.equal(bad.agents, null);
  assert.equal(bad.approvals, null);
  assert.equal(bad.escalations, null);
  assert.match(bad.cause, /GET \/v1\/agents did not return a list/);
  const err = plain(K.summarizePoll({ agents: undefined, approvals: [], escalations: [], errors: ["GET /v1/agents: 500", "other"] }));
  assert.equal(err.cause, "GET /v1/agents: 500");
  assert.equal(err.approvals, 0);
  // partial failure: agents readable, a count source failed
  const part = plain(K.summarizePoll(deepFreeze({ agents: rows, approvals: undefined, escalations: [], errors: ["GET /v1/approvals: 500"] })));
  assert.equal(part.ok, true);
  assert.equal(part.approvals, null);
  assert.equal(part.escalations, 0);
  assert.match(part.cause, /GET \/v1\/approvals: 500/);
  assert.match(part.cause, /undercount/);
  const partNoErr = plain(K.summarizePoll({ agents: rows, approvals: [], escalations: "x", errors: [] }));
  assert.equal(partNoErr.ok, true);
  assert.match(partNoErr.cause, /undercount/);
  assert.notEqual(plain(K.summarizePoll({ agents: 1, approvals: 1, escalations: 1, errors: [""] })).cause, "");
});

test("connNext and connView keep a partial cause on ok polls", () => {
  const s = K.connNext({ failures: 2, everOk: true, cause: "old" }, true, "Inbox counts incomplete (x)");
  assert.deepEqual(plain(s), { failures: 0, everOk: true, cause: "Inbox counts incomplete (x)" });
  const v = K.connView(s);
  assert.equal(v.label, "connected");
  assert.equal(v.dot, "warn");
  assert.match(v.title, /Inbox counts incomplete \(x\)/);
  const clean = K.connNext(s, true, "");
  assert.equal(clean.cause, "");
  assert.equal(K.connView(clean).dot, "ok");
});

test("connNext and connView", () => {
  const s0 = { failures: 0, everOk: false, cause: "" };
  assert.equal(K.connView(s0).label, "connecting");
  const f1 = K.connNext(deepFreeze(s0), false, "boom");
  assert.deepEqual(plain(f1), { failures: 1, everOk: false, cause: "boom" });
  assert.equal(K.connView(f1).label, "reconnecting");
  assert.equal(K.connView(f1).dot, "warn");
  assert.match(K.connView(f1).title, /boom/);
  assert.match(K.connView(f1).title, /keeps retrying/);
  const f2 = K.connNext(f1, false, "boom2");
  assert.equal(f2.failures, 2);
  assert.equal(f2.cause, "boom2");
  assert.equal(K.connView(f2).label, "reconnecting");
  const f3 = K.connNext(f2, false, "boom3");
  assert.equal(K.connView(f3).label, "offline");
  assert.equal(K.connView(f3).dot, "err");
  assert.match(K.connView(f3).title, /boom3/);
  const ok = K.connNext(f3, true, "");
  assert.deepEqual(plain(ok), { failures: 0, everOk: true, cause: "" });
  assert.equal(K.connView(ok).label, "connected");
  assert.equal(K.connView(ok).dot, "ok");
  assert.equal(K.connView(K.connNext(ok, false, "x")).label, "reconnecting");
});

test("inboxBadge", () => {
  assert.deepEqual(plain(K.inboxBadge(null, null)), { hidden: false, text: "?", label: "Inbox: count unavailable", count: 0 });
  assert.deepEqual(plain(K.inboxBadge(0, 0)), { hidden: true, text: "0", label: "Inbox: 0 waiting", count: 0 });
  assert.deepEqual(plain(K.inboxBadge(2, null)), {
    hidden: false,
    text: "2+",
    label: "Inbox: at least 2 waiting (some counts unavailable)",
    count: 2,
  });
  assert.equal(K.inboxBadge(null, 3).count, 3);
  assert.equal(K.inboxBadge(null, 3).text, "3+");
  assert.deepEqual(plain(K.inboxBadge(0, null)), {
    hidden: false,
    text: "?",
    label: "Inbox: at least 0 waiting (some counts unavailable)",
    count: 0,
  });
  assert.equal(K.inboxBadge(null, 150).text, "99+");
  assert.equal(K.inboxBadge(60, 40).text, "99+");
  assert.equal(K.inboxBadge(50, 49).text, "99");
});

test("windowLabel", () => {
  const agents = deepFreeze([ag("a1", "alpha")]);
  assert.equal(K.windowLabel(leaf("t1", "tree"), VIEWS, agents), "Tree");
  assert.equal(K.windowLabel(leaf("t2", "agent", "a1"), VIEWS, agents), "Agent: alpha");
  assert.equal(K.windowLabel(leaf("t3", "agent", "zz"), VIEWS, agents), "Agent: zz");
  assert.equal(K.windowLabel(leaf("t4", "mystery"), VIEWS, agents), "mystery");
});

test("windowList entries, attention, compact", () => {
  const c = ctx({ leaves: [leaf("t1", "tree"), leaf("t2", "agent", "a2"), leaf("t3", "inbox")], focus: "t2", inboxCount: 2 });
  const w = plain(K.windowList(c.leaves, c.focus, c.views, c.agents, c.inboxCount));
  assert.deepEqual(
    w.entries.map((e: { leaf: string }) => e.leaf),
    ["t1", "t2", "t3"],
  );
  assert.deepEqual(
    w.entries.map((e: { focused: boolean }) => e.focused),
    [false, true, false],
  );
  assert.deepEqual(
    w.entries.map((e: { dot: string }) => e.dot),
    ["none", "warn", "warn"],
  );
  assert.equal(w.entries[1].title, "Agent: beta (yielded)");
  assert.equal(w.entries[0].title, "Tree (idle)");
  assert.equal(w.attention, 2);
  assert.equal(w.compact, false);
  assert.equal(w.label, "Open windows, 2 need attention");
  const one = plain(K.windowList([leaf("t3", "inbox")], "t3", VIEWS, [], 1));
  assert.equal(one.label, "Open windows, 1 needs attention");
  const none = plain(K.windowList([leaf("t1", "tree")], "t1", VIEWS, [], 0));
  assert.equal(none.label, "Open windows");
  const seven = Array.from({ length: 7 }, (_, i) => leaf(`t${i}`, "tree"));
  assert.equal(K.windowList(seven, "t0", VIEWS, [], 0).compact, true);
  assert.equal(K.windowList(seven.slice(0, 6), "t0", VIEWS, [], 0).compact, false);
  assert.equal(K.windowList([leaf("q", "agent", "nope")], "q", VIEWS, [], 0).entries[0]?.title, "Agent: nope (unknown)");
});

test("buildItems order, kinds, dots, runs, unique keys", () => {
  const items = K.buildItems(ctx({ inboxCount: 1 }));
  assert.deepEqual(labels(items), [
    "Tree",
    "Agent: alpha",
    "Inbox",
    "Agent: beta",
    "Split right",
    "Split down",
    "Close tile",
    "Reset layout",
    "Export layout",
    "Import layout",
    "Sign out",
  ]);
  assert.deepEqual(plain(items.map((i) => i.kind)), ["open", "open", "new", "new", "action", "action", "action", "action", "action", "action", "action"]);
  assert.deepEqual(plain(items[0]?.run), { type: "focus", leaf: "t1" });
  assert.equal(items[1]?.dot, "ok");
  assert.deepEqual(plain(items[2]?.run), { type: "open", view: "inbox" });
  assert.deepEqual(plain(items[3]?.run), { type: "open", view: "agent", agent: "a2" });
  assert.equal(items[3]?.dot, "warn");
  assert.match(items[3]?.hint ?? "", /a2/);
  assert.equal(new Set(items.map((i) => i.key)).size, items.length);
  // inbox leaf badge
  const inb = K.buildItems(ctx({ leaves: [leaf("t1", "inbox")], inboxCount: 3 }));
  assert.equal(inb[0]?.dot, "warn");
  assert.equal(K.buildItems(ctx({ leaves: [leaf("t1", "inbox")], inboxCount: 0 }))[0]?.dot, "none");
});

test("buildItems hides disabled actions", () => {
  const has = (items: OmniItem[], l: string) => labels(items).includes(l);
  const narrow = K.buildItems(ctx({ narrow: true }));
  assert.equal(has(narrow, "Split right") || has(narrow, "Split down") || has(narrow, "Close tile"), false);
  assert.equal(has(narrow, "Reset layout"), true);
  assert.equal(has(narrow, "Sign out"), true);
  const full = K.buildItems(ctx({ maxLeaves: 2 }));
  assert.equal(has(full, "Split right"), false);
  assert.equal(has(full, "Split down"), false);
  assert.equal(has(full, "Close tile"), true);
  const solo = K.buildItems(ctx({ leaves: [leaf("t1", "tree")] }));
  assert.equal(has(solo, "Close tile"), false);
  assert.equal(has(solo, "Split right"), true);
});

test("the unfiltered list caps agent-derived items and skips reaped and shown agents", () => {
  const agents = Array.from({ length: 500 }, (_, i) => ag(`a${i}`, `n${i}`));
  const items = K.rank(K.buildItems(ctx({ agents, leaves: [leaf("t1", "agent", "a0")] })), "");
  const fresh = items.filter((i) => i.kind === "new" && i.run.type === "open" && i.run.agent !== undefined);
  assert.equal(fresh.length, 200);
  // the cap is per multi-instance view type, not cumulative
  const two = [...VIEWS, { id: "log", title: "Log", multi: true }];
  const perView = K.rank(K.buildItems(ctx({ agents, views: two, leaves: [leaf("t1", "tree")] })), "");
  const count = (v: string) => perView.filter((i) => i.run.type === "open" && i.run.view === v && i.run.agent).length;
  assert.equal(count("agent"), 200);
  assert.equal(count("log"), 200);
  assert.equal(
    fresh.some((i) => i.run.type === "open" && i.run.agent === "a0"),
    false,
  );
  const none = K.buildItems(ctx({ agents: [ag("r", "r", "reaped")] }));
  assert.equal(
    none.some((i) => i.run.type === "open" && i.run.agent === "r"),
    false,
  );
  assert.equal(
    K.buildItems(ctx({ agents: [ag("z", "")] })).some((i) => i.label === "Agent: z"),
    true,
  );
});

test("an agent past the cap is found by exact name, prefix or id, once", () => {
  const agents = Array.from({ length: 250 }, (_, i) => ag(`a${i}`, `n${i}`));
  const items = K.buildItems(ctx({ agents, leaves: [leaf("t1", "tree")] }));
  const isA = (i: { run: { type: string; agent?: string } }, id: string) => i.run.type === "open" && i.run.agent === id;
  assert.equal(
    K.rank(items, "").some((i) => isA(i, "a229")),
    false,
  );
  const exact = K.rank(items, "Agent: n229");
  assert.ok(isA(exact[0]!, "a229"));
  assert.equal(exact.filter((i) => isA(i, "a229")).length, 1);
  const prefix = K.rank(items, "n229");
  assert.ok(isA(prefix[0]!, "a229"));
  assert.equal(prefix.filter((i) => isA(i, "a229")).length, 1);
  assert.ok(K.rank(items, "a229").some((i) => isA(i, "a229")));
  // a broad query is still cut to the cap per view type
  assert.equal(K.rank(items, "n").filter((i) => i.run.type === "open" && i.run.agent).length, 200);
});

test("parseQuery", () => {
  assert.deepEqual(plain(K.parseQuery("  Foo   BAR ")), { actionsOnly: false, tokens: ["foo", "bar"] });
  assert.deepEqual(plain(K.parseQuery("")), { actionsOnly: false, tokens: [] });
  assert.deepEqual(plain(K.parseQuery(" >Split  right")), { actionsOnly: true, tokens: ["split", "right"] });
  assert.deepEqual(plain(K.parseQuery(">")), { actionsOnly: true, tokens: [] });
  assert.deepEqual(plain(K.parseQuery("a>b")), { actionsOnly: false, tokens: ["a>b"] });
});

test("rank ordering: prefix > word-start > substring > hint", () => {
  const items = deepFreeze([item("Xlog tail"), item("Tail of log"), item("Detail view"), item("Other", "open", "tail"), item("Big tail")]);
  assert.deepEqual(labels(K.rank(items, "tail")), ["Tail of log", "Xlog tail", "Big tail", "Detail view", "Other"]);
});

test("rank AND tokens, empty query, stability, no match", () => {
  const items = deepFreeze([item("Agent: alpha", "new", "a1"), item("Agent: beta", "new", "a2"), item("Split right", "action")]);
  assert.deepEqual(labels(K.rank(items, "")), labels(items));
  assert.deepEqual(labels(K.rank(items, "   ")), labels(items));
  assert.deepEqual(labels(K.rank(items, "agent")), ["Agent: alpha", "Agent: beta"]);
  assert.deepEqual(labels(K.rank(items, "agent beta")), ["Agent: beta"]);
  assert.deepEqual(labels(K.rank(items, "agent zzz")), []);
  assert.deepEqual(labels(K.rank(items, "a2")), ["Agent: beta"]);
  assert.deepEqual(labels(K.rank(items, "NEW alpha")), ["Agent: alpha"]);
  assert.deepEqual(labels(K.rank(items, "run commands")), []); // free text never matches by itself
});

test("rank > mode shows only actions", () => {
  const items = deepFreeze([item("Split tree", "open"), item("Split right", "action"), item("Sign out", "action")]);
  assert.deepEqual(labels(K.rank(items, ">")), ["Split right", "Sign out"]);
  assert.deepEqual(labels(K.rank(items, ">split")), ["Split right"]);
  assert.deepEqual(labels(K.rank(items, "split")), ["Split tree", "Split right"]);
});

test("isOpenShortcut", () => {
  const base = { altKey: true, shiftKey: true, code: "KeyP" };
  assert.equal(K.isOpenShortcut(base), true);
  assert.equal(K.isOpenShortcut({ ...base, ctrlKey: true }), false);
  assert.equal(K.isOpenShortcut({ ...base, metaKey: true }), false);
  assert.equal(K.isOpenShortcut({ ...base, altKey: false }), false);
  assert.equal(K.isOpenShortcut({ ...base, shiftKey: false }), false);
  assert.equal(K.isOpenShortcut({ ...base, code: "KeyO" }), false);
  assert.equal(K.isOpenShortcut({}), false);
});

const three = deepFreeze([item("a"), item("b"), item("c")]);
const openSt = (sel = 0, query = "q") => deepFreeze({ open: true, query, sel });

test("omniStep open, close, toggle, input", () => {
  const init = K.omniInitial();
  assert.deepEqual(plain(init), { open: false, query: "", sel: 0 });
  assert.deepEqual(plain(K.omniStep(deepFreeze(init), { type: "open" }, three)), { state: { open: true, query: "", sel: 0 }, effect: null });
  // open while already open keeps the query and selection
  assert.deepEqual(plain(K.omniStep(openSt(2), { type: "open" }, three).state), { open: true, query: "q", sel: 2 });
  assert.equal(K.omniStep(openSt(7), { type: "open" }, three).state.sel, 2);
  assert.equal(K.omniStep(openSt(2), { type: "close" }, three).state.open, false);
  assert.equal(K.omniStep(openSt(2), { type: "toggle" }, three).state.open, false);
  assert.equal(K.omniStep(deepFreeze(init), { type: "toggle" }, three).state.open, true);
  assert.deepEqual(plain(K.omniStep(openSt(2), { type: "input", text: "zz" }, three).state), { open: true, query: "zz", sel: 0 });
});

test("omniStep arrows wrap, Home/End, empty list", () => {
  const key = (sel: number, k: string, shown = three) => K.omniStep(openSt(sel), { type: "key", key: k }, shown).state.sel;
  assert.equal(key(0, "ArrowDown"), 1);
  assert.equal(key(2, "ArrowDown"), 0);
  assert.equal(key(0, "ArrowUp"), 2);
  assert.equal(key(2, "ArrowUp"), 1);
  assert.equal(key(1, "Home"), 0);
  assert.equal(key(0, "End"), 2);
  assert.equal(key(5, "ArrowDown"), 0); // stale sel is clamped to 2 first, then wraps
  const empty: OmniItem[] = [];
  for (const k of ["ArrowDown", "ArrowUp", "Home", "End", "Enter"]) {
    const r = K.omniStep(openSt(0), { type: "key", key: k }, empty);
    assert.deepEqual(plain(r), { state: { open: true, query: "q", sel: 0 }, effect: null });
  }
  assert.equal(K.omniStep(openSt(1), { type: "key", key: "x" }, three).state.sel, 1);
});

test("omniStep Enter, Escape, hover, choose", () => {
  const enter = K.omniStep(openSt(1), { type: "key", key: "Enter" }, three);
  assert.equal(enter.state.open, false);
  assert.deepEqual(plain(enter.effect), { type: "run", item: plain(three[1]) });
  assert.deepEqual(plain(K.omniStep(openSt(9), { type: "key", key: "Enter" }, three).effect), { type: "run", item: plain(three[2]) });
  const esc = K.omniStep(openSt(1), { type: "key", key: "Escape" }, three);
  assert.equal(esc.state.open, false);
  assert.deepEqual(plain(esc.effect), { type: "refocus" });
  assert.equal(K.omniStep(openSt(0), { type: "hover", index: 2 }, three).state.sel, 2);
  assert.equal(K.omniStep(openSt(0), { type: "hover", index: 99 }, three).state.sel, 2);
  assert.equal(K.omniStep(openSt(1), { type: "hover", index: -4 }, three).state.sel, 0);
  const ch = K.omniStep(openSt(0), { type: "choose", index: 2 }, three);
  assert.equal(ch.state.open, false);
  assert.deepEqual(plain(ch.effect), { type: "run", item: plain(three[2]) });
  for (const index of [3, -1]) {
    const r = K.omniStep(openSt(1), { type: "choose", index }, three);
    assert.deepEqual(plain(r), { state: { open: true, query: "q", sel: 1 }, effect: null });
  }
});

test("omniStep while closed ignores events and never mutates", () => {
  const closed = deepFreeze({ open: false, query: "", sel: 0 });
  for (const ev of [
    { type: "close" },
    { type: "input", text: "x" },
    { type: "key", key: "Enter" },
    { type: "key", key: "ArrowDown" },
    { type: "hover", index: 1 },
    { type: "choose", index: 0 },
  ] as const) {
    const r = K.omniStep(closed, ev, three);
    assert.deepEqual(plain(r), { state: { open: false, query: "", sel: 0 }, effect: null });
    assert.notEqual(r.state, closed);
  }
});

const entries: MenuEntry[] = deepFreeze(K.menuEntries(false));
const mOpen = (sel: number) => deepFreeze({ open: true, sel });

test("menuEntries", () => {
  const want = [
    { kind: "head", label: "Layout" },
    { kind: "action", label: "Export layout", id: "export-layout" },
    { kind: "action", label: "Import layout", id: "import-layout" },
    { kind: "action", label: "Reset layout", id: "reset-layout" },
    { kind: "sep", label: "" },
    { kind: "action", label: "Sign out", id: "sign-out" },
  ];
  assert.deepEqual(plain(K.menuEntries(false)), want);
  assert.deepEqual(plain(K.menuEntries(true)), want);
});

test("menuStep open lands on first action; arrows skip heads and separators and wrap", () => {
  assert.deepEqual(plain(K.menuInitial()), { open: false, sel: 0 });
  assert.deepEqual(plain(K.menuStep(K.menuInitial(), { type: "open" }, entries)), { state: { open: true, sel: 1 }, effect: null });
  assert.equal(K.menuStep(K.menuInitial(), { type: "toggle" }, entries).state.open, true);
  assert.equal(K.menuStep(mOpen(1), { type: "toggle" }, entries).state.open, false);
  assert.equal(K.menuStep(mOpen(1), { type: "close" }, entries).state.open, false);
  const key = (sel: number, k: string) => K.menuStep(mOpen(sel), { type: "key", key: k }, entries).state.sel;
  assert.equal(key(1, "ArrowDown"), 2);
  assert.equal(key(3, "ArrowDown"), 5); // skips the separator
  assert.equal(key(5, "ArrowDown"), 1); // wraps past the head
  assert.equal(key(1, "ArrowUp"), 5);
  assert.equal(key(5, "ArrowUp"), 3);
  assert.equal(key(3, "Home"), 1);
  assert.equal(key(1, "End"), 5);
  assert.equal(key(0, "ArrowDown"), 2); // a stale sel on the head is treated as the first action
});

test("menuStep Enter, Space, Escape, Tab, hover, choose, closed", () => {
  const enter = K.menuStep(mOpen(3), { type: "key", key: "Enter" }, entries);
  assert.deepEqual(plain(enter.effect), { type: "run", id: "reset-layout" });
  assert.equal(enter.state.open, false);
  assert.deepEqual(plain(K.menuStep(mOpen(5), { type: "key", key: " " }, entries).effect), { type: "run", id: "sign-out" });
  const esc = K.menuStep(mOpen(2), { type: "key", key: "Escape" }, entries);
  assert.equal(esc.state.open, false);
  assert.deepEqual(plain(esc.effect), { type: "refocus" });
  const tab = K.menuStep(mOpen(2), { type: "key", key: "Tab" }, entries);
  assert.equal(tab.state.open, false);
  assert.equal(tab.effect, null);
  assert.equal(K.menuStep(mOpen(1), { type: "hover", index: 3 }, entries).state.sel, 3);
  assert.equal(K.menuStep(mOpen(1), { type: "hover", index: 4 }, entries).state.sel, 1);
  assert.equal(K.menuStep(mOpen(1), { type: "hover", index: 99 }, entries).state.sel, 1);
  assert.deepEqual(plain(K.menuStep(mOpen(1), { type: "choose", index: 2 }, entries).effect), { type: "run", id: "import-layout" });
  assert.equal(K.menuStep(mOpen(1), { type: "choose", index: 0 }, entries).effect, null);
  assert.equal(K.menuStep(mOpen(1), { type: "choose", index: 0 }, entries).state.open, true);
  const closed = deepFreeze({ open: false, sel: 1 });
  assert.deepEqual(plain(K.menuStep(closed, { type: "key", key: "Enter" }, entries)), { state: { open: false, sel: 1 }, effect: null });
  assert.equal(K.menuStep(mOpen(1), { type: "key", key: "x" }, entries).state.sel, 1);
});
