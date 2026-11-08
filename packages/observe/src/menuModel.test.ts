import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { MENU_KIT_JS, type MenuKitApi, type OverflowEntry, type ResolvedMenu, type ViewDeclaration, type WindowModel } from "./menuModel.ts";
import { PANE_KIT_JS } from "./paneKit.ts";

const K = runInContext(
  `(() => { ${MENU_KIT_JS}; return MenuKit; })()`,
  createContext({ globalThis: {}, JSON, Object, Array, Set, Map, String, Error, WeakSet }),
) as MenuKitApi;

// The kit runs in a vm realm, so compare through JSON to avoid cross-realm prototype mismatches.
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

const terminal = (): ViewDeclaration => ({
  id: "terminal",
  title: "Terminal",
  multi: true,
  menus: [
    {
      id: "view",
      items: [
        { kind: "action", command: "terminal.font-smaller", label: "Smaller" },
        { kind: "action", command: "terminal.font-larger", label: "Larger" },
        { kind: "action", command: "terminal.font-reset", label: "Reset" },
      ],
    },
    {
      id: "trace",
      items: [
        { kind: "action", command: "trace.copy", label: "Copy trace" },
        { kind: "action", command: "trace.view", label: "View trace" },
        { kind: "action", command: "trace.short", label: "Short" },
        { kind: "separator", label: "Options" },
        { kind: "toggle", command: "trace.children", label: "Include children" },
        { kind: "toggle", command: "trace.raw", label: "Include raw", caution: "Raw skips secret redaction" },
        { kind: "separator" },
        { kind: "action", command: "trace.download", label: "Download" },
      ],
    },
    { id: "session", items: [{ kind: "action", command: "session.reconnect", label: "Reconnect" }] },
    { id: "help", items: [{ kind: "action", command: "help.keys", label: "Keys" }] },
  ],
});
const browser = (): ViewDeclaration => ({
  id: "browser",
  title: "Browser",
  multi: true,
  menus: [
    {
      id: "view",
      items: [
        { kind: "toggle", command: "browser.fit", label: "Fit to window", checked: true },
        { kind: "toggle", command: "browser.actual", label: "Actual size" },
        { kind: "action", command: "browser.copy-url", label: "Copy URL" },
      ],
    },
    { id: "help", items: [{ kind: "action", command: "help.keys", label: "Keys" }] },
  ],
  status: [
    { id: "connection", title: "Connection", tone: "ok", text: "live" },
    { id: "url", title: "URL", mono: true },
    { id: "view-only", title: "View only", text: "view only" },
  ],
});
const inbox = (): ViewDeclaration => ({
  id: "inbox",
  title: "Inbox",
  multi: false,
  menus: [
    {
      id: "view",
      items: [
        {
          kind: "radio",
          command: "inbox.filter",
          label: "Filter",
          options: [
            { value: "all", label: "All" },
            { value: "user", label: "User messages" },
            { value: "escalations", label: "Escalations" },
            { value: "approvals", label: "Approvals" },
          ],
        },
      ],
    },
  ],
});
const fixtures: Array<[string, () => ViewDeclaration]> = [
  ["terminal", terminal],
  ["browser", browser],
  ["inbox", inbox],
];

// ---- 1. declareView happy path ----

for (const [name, make] of fixtures) {
  test(`declareView accepts the ${name} fixture and returns a frozen copy`, () => {
    const input = make();
    const out = K.declareView(input);
    assert.equal(out.id, name);
    const deepFrozen = (x: unknown): boolean => !x || typeof x !== "object" || (Object.isFrozen(x) && Object.values(x).every(deepFrozen));
    assert.ok(deepFrozen(out), "declaration must be deeply frozen");
    assert.notEqual(out, input as unknown);
    assert.equal(Object.isFrozen(input), false, "input is not frozen");
  });
  test(`declareView round-trips the ${name} declaration through JSON`, () => {
    const a = K.declareView(make());
    const b = K.declareView(JSON.parse(JSON.stringify(a)));
    assert.deepEqual(plain(b), plain(a));
  });
}

test("declareView returns menus in canonical order even when declared shuffled", () => {
  const d = terminal();
  d.menus = [...(d.menus ?? [])].reverse();
  assert.deepEqual(plain(K.declareView(d).menus.map((m) => m.id)), ["view", "trace", "session", "help"]);
});

test("declareView defaults menus and status to empty lists", () => {
  const out = K.declareView({ id: "tree", title: "Tree", multi: false });
  assert.deepEqual(plain(out.menus), []);
  assert.deepEqual(plain(out.status), []);
});

// ---- 2. negative controls ----

const mk = (over: Record<string, unknown> = {}): ViewDeclaration =>
  ({
    id: "v",
    title: "V",
    multi: false,
    menus: [{ id: "view", items: [{ kind: "action", command: "v.a", label: "A" }] }],
    ...over,
  }) as ViewDeclaration;
const act = (command: string, extra: Record<string, unknown> = {}) => ({ kind: "action", command, label: "L", ...extra });
const withItems = (items: unknown[]) => mk({ menus: [{ id: "view", items }] });
const bad = (decl: unknown, re: RegExp) => assert.throws(() => K.declareView(decl as ViewDeclaration), re);

test("sanity: the base fixture is valid", () => {
  assert.doesNotThrow(() => K.declareView(mk()));
});

test("unknown field is rejected at view, menu, item, option and status level", () => {
  bad(mk({ extra: 1 }), /declareView: view "v".*unknown field "extra".*remove it/);
  bad(mk({ menus: [{ id: "view", items: [act("v.a")], extra: 1 }] }), /declareView: .*"v".*unknown field "extra".*remove it/);
  bad(withItems([act("v.a", { extra: 1 })]), /declareView: .*"v".*unknown field "extra".*remove it/);
  bad(withItems([{ kind: "radio", command: "v.r", label: "R", options: [{ value: "a", label: "A", extra: 1 }] }]), /unknown field "extra".*remove it/);
  bad(mk({ status: [{ id: "s", title: "S", extra: 1 }] }), /unknown field "extra".*remove it/);
  bad(withItems([{ kind: "separator", command: "x" }]), /unknown field "command"/);
  // an undefined-valued field is not "unknown"
  assert.doesNotThrow(() => K.declareView(mk({ extra: undefined })));
});

test("bad view id names the cause and the action", () => {
  bad(mk({ id: "Bad Id" }), /declareView: view "Bad Id".*id must be a lowercase name.*use lowercase/);
  bad(mk({ id: undefined }), /declareView: .*id must be a lowercase name/);
  assert.doesNotThrow(() => K.declareView(mk({ id: "good-id2" })));
});

test("non-object declaration is rejected", () => {
  bad(null, /declareView: view.*must be an object.*pass \{id/);
});

test("missing or non-boolean multi", () => {
  bad(mk({ multi: undefined }), /view "v".*multi must be true or false.*say whether/);
  bad(mk({ multi: "yes" }), /view "v".*multi must be true or false/);
});

test("unknown menu id", () => {
  bad(mk({ menus: [{ id: "file", items: [act("v.a")] }] }), /view "v".*menu id "file" is not one of view, trace, session, help.*name the menu/);
});

test("duplicate menu", () => {
  bad(
    mk({
      menus: [
        { id: "view", items: [act("v.a")] },
        { id: "view", items: [act("v.b")] },
      ],
    }),
    /menu "view".*declared twice.*merge/,
  );
});

test("empty items", () => {
  bad(mk({ menus: [{ id: "view", items: [] }] }), /view "v".*items must be a non-empty list.*add items or drop/);
});

test("unknown item kind", () => {
  bad(withItems([{ kind: "submenu", command: "v.a", label: "A" }]), /view "v".*unknown item kind "submenu".*use action, toggle, radio or separator/);
});

test("bad command id", () => {
  bad(withItems([act("Bad Command")]), /view "v".*command must be a lowercase id.*use lowercase letters/);
  bad(withItems([{ kind: "action", label: "L" }]), /command must be a lowercase id/);
});

test("duplicate command", () => {
  bad(withItems([act("v.a"), act("v.a")]), /view "v".*command v\.a is declared twice.*own command id/);
});

test("missing and over-long label", () => {
  bad(withItems([{ kind: "action", command: "v.a" }]), /command v\.a.*label must be a non-empty string.*short plain-text/);
  bad(withItems([act("v.a", { label: "  " })]), /label must be a non-empty string/);
  bad(withItems([act("v.a", { label: "x".repeat(K.MAX_LABEL + 1) })]), /label must be a non-empty string of at most 200/);
  assert.doesNotThrow(() => K.declareView(withItems([act("v.a", { label: "x".repeat(K.MAX_LABEL) })])));
});

test("radio option failures", () => {
  const radio = (extra: Record<string, unknown>) => ({
    kind: "radio",
    command: "v.r",
    label: "R",
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
    ...extra,
  });
  assert.doesNotThrow(() => K.declareView(withItems([radio({ value: "b" })])));
  bad(withItems([radio({ options: [] })]), /command v\.r.*options must be a list of 1 to 16.*list the choices/);
  bad(withItems([radio({ options: undefined })]), /options must be a list/);
  bad(
    withItems([
      radio({
        options: [
          { value: "a", label: "A" },
          { value: "a", label: "B" },
        ],
      }),
    ]),
    /option 2.*value a is declared twice.*distinct/,
  );
  bad(withItems([radio({ value: "z" })]), /command v\.r.*value "z" is not one of the options.*pick one of a, b/);
  bad(withItems([radio({ options: [{ value: "bad value", label: "A" }] })]), /option 1.*value must be letters.*short id/);
});

test("function-valued fields are rejected (callbacks are not data)", () => {
  bad(withItems([act("v.a", { onClick: () => {} })]), /unknown field "onClick"/);
  bad(withItems([act("v.a", { label: () => "x" })]), /label must be a non-empty string/);
  bad(withItems([act("v.a", { enabled: () => true })]), /enabled must be true or false.*use a boolean/);
  bad(mk({ status: [{ id: "s", title: "S", text: () => "x" }] }), /text must be a string/);
});

test("too many items and too many options", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => act(`v.a${i}`));
  assert.doesNotThrow(() => K.declareView(withItems(items(K.MAX_ITEMS))));
  bad(withItems(items(K.MAX_ITEMS + 1)), /view "v".*more than 64 menu items.*move rarely used/);
  const opts = Array.from({ length: K.MAX_OPTIONS + 1 }, (_, i) => ({ value: `o${i}`, label: "O" }));
  bad(withItems([{ kind: "radio", command: "v.r", label: "R", options: opts }]), /options must be a list of 1 to 16/);
});

test("too many status slots", () => {
  const slots = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: "S" }));
  assert.doesNotThrow(() => K.declareView(mk({ status: slots(K.MAX_STATUS) })));
  bad(mk({ status: slots(K.MAX_STATUS + 1) }), /view "v".*status must be a list of at most 8 slots.*declare slots/);
});

test("bad status tone, id and duplicate id", () => {
  assert.doesNotThrow(() => K.declareView(mk({ status: [{ id: "s", title: "S", tone: "warn" }] })));
  bad(mk({ status: [{ id: "s", title: "S", tone: "blue" }] }), /status 1.*tone "blue" is not one of ok, warn, err, info.*omit it/);
  bad(mk({ status: [{ id: "S!", title: "S" }] }), /status 1.*id must be a lowercase name.*use lowercase/);
  bad(
    mk({
      status: [
        { id: "s", title: "S" },
        { id: "s", title: "T" },
      ],
    }),
    /status 2.*status id s is declared twice.*own id/,
  );
});

// ---- 3. createWindowModel ----

const model = (make: () => ViewDeclaration): WindowModel => K.createWindowModel(K.declareView(make()));
const cmds = (menus: ResolvedMenu[]): string[] => menus.flatMap((m) => m.items.flatMap((i) => (i.kind === "separator" ? [] : [i.command]))).sort();
const find = (w: WindowModel, command: string) => {
  for (const m of w.menus()) for (const i of m.items) if (i.kind !== "separator" && i.command === command) return i;
  return undefined;
};

test("menus() resolves initial defaults", () => {
  const t = model(terminal);
  const raw = find(t, "trace.raw");
  assert.deepEqual(plain(raw), {
    kind: "toggle",
    command: "trace.raw",
    label: "Include raw",
    enabled: true,
    checked: false,
    caution: "Raw skips secret redaction",
  });
  assert.equal(find(model(browser), "browser.fit") && (find(model(browser), "browser.fit") as { checked: boolean }).checked, true);
  const f = find(model(inbox), "inbox.filter");
  assert.equal(f?.kind, "radio");
  assert.equal((f as { value: string }).value, "all");
  assert.deepEqual(plain((f as { options: unknown[] }).options.map((o) => (o as { checked: boolean }).checked)), [true, false, false, false]);
  assert.deepEqual(plain(t.menus().map((m) => m.title)), ["View", "Trace", "Session", "Help"]);
});

test("declared initial enabled/visible/value are honoured", () => {
  const d = mk({
    menus: [
      {
        id: "view",
        items: [
          act("v.a", { enabled: false }),
          act("v.b", { visible: false }),
          {
            kind: "radio",
            command: "v.r",
            label: "R",
            value: "b",
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
          },
        ],
      },
    ],
  });
  const w = model(() => d);
  assert.equal(find(w, "v.a")?.kind === "action" && (find(w, "v.a") as { enabled: boolean }).enabled, false);
  assert.equal(find(w, "v.b"), undefined);
  assert.equal((find(w, "v.r") as { value: string }).value, "b");
});

test("setState hides, disables and checks", () => {
  const w = model(terminal);
  w.setState("trace.copy", { enabled: false });
  assert.equal((find(w, "trace.copy") as { enabled: boolean }).enabled, false);
  w.setState("trace.copy", { visible: false });
  assert.equal(find(w, "trace.copy"), undefined);
  w.setState("trace.copy", { visible: true, enabled: true });
  assert.equal((find(w, "trace.copy") as { enabled: boolean }).enabled, true);
  w.setState("trace.raw", { checked: true });
  assert.equal((find(w, "trace.raw") as { checked: boolean }).checked, true);
  const i = model(inbox);
  i.setState("inbox.filter", { value: "approvals" });
  assert.equal((find(i, "inbox.filter") as { value: string }).value, "approvals");
});

test("a menu whose items are all hidden is omitted", () => {
  const w = model(terminal);
  w.setState("session.reconnect", { visible: false });
  assert.deepEqual(plain(w.menus().map((m) => m.id)), ["view", "trace", "help"]);
  // negative: a menu with a visible item stays
  w.setState("session.reconnect", { visible: true });
  assert.equal(w.menus().length, 4);
});

test("separators are tidied", () => {
  const items = [
    { kind: "separator" },
    act("v.a"),
    { kind: "separator" },
    { kind: "separator" },
    act("v.b"),
    { kind: "separator", label: "Options" },
    act("v.c"),
    { kind: "separator" },
    { kind: "separator", label: "Tail" },
  ];
  const w = model(() => withItems(items));
  const shape = (): string[] => plain(w.menus()[0]?.items.map((i) => (i.kind === "separator" ? `sep:${i.label ?? ""}` : i.command)));
  // leading rule dropped, doubled rule collapsed (the first of a pair before a rule is dropped), trailing rules dropped
  assert.deepEqual(shape(), ["v.a", "sep:", "v.b", "sep:Options", "v.c"]);
  // labelled separator dropped when nothing follows it
  w.setState("v.c", { visible: false });
  assert.deepEqual(shape(), ["v.a", "sep:", "v.b"]);
  // labelled separator kept when items follow
  w.setState("v.c", { visible: true });
  w.setState("v.b", { visible: false });
  assert.deepEqual(shape(), ["v.a", "sep:Options", "v.c"]);
});

test("a leading labelled separator is kept; a leading plain rule is not", () => {
  const w = model(() => withItems([{ kind: "separator", label: "Head" }, act("v.a")]));
  assert.deepEqual(plain(w.menus()[0]?.items.map((i) => i.kind)), ["separator", "action"]);
  const w2 = model(() => withItems([{ kind: "separator" }, act("v.a")]));
  assert.deepEqual(plain(w2.menus()[0]?.items.map((i) => i.kind)), ["action"]);
});

test("setState errors name the cause and the action", () => {
  const w = model(terminal);
  assert.throws(() => w.setState("nope", { enabled: false }), /setState: .*"terminal".*no command "nope".*use a command declared/);
  assert.throws(() => w.setState("trace.copy", { checked: true }), /checked applies to toggle items.*action/);
  assert.throws(() => w.setState("trace.raw", { checked: "yes" as unknown as boolean }), /checked applies to toggle items/);
  const i = model(inbox);
  assert.throws(() => i.setState("inbox.filter", { value: "nope" }), /value applies to radio items.*"nope"/);
  assert.throws(() => w.setState("trace.copy", { value: "x" }), /value applies to radio items/);
  assert.throws(() => w.setState("trace.copy", { bogus: 1 } as never), /unknown field "bogus".*use enabled, visible, checked or value/);
  assert.throws(() => w.setState("trace.copy", { enabled: "no" as unknown as boolean }), /enabled must be true or false/);
  assert.throws(() => w.setState("trace.copy", null as never), /needs a patch object/);
  // a failed patch changes nothing
  assert.equal((find(w, "trace.copy") as { enabled: boolean }).enabled, true);
});

test("setStatus sets text and tone, clears tone with null, and hides an empty slot", () => {
  const w = model(browser);
  assert.deepEqual(plain(w.status().map((s) => s.id)), ["connection", "view-only"]);
  assert.deepEqual(plain(w.status()[0]), { id: "connection", title: "Connection", text: "live", tone: "ok" });
  w.setStatus("url", { text: "https://example.test" });
  const url = w.status().find((s) => s.id === "url");
  assert.deepEqual(plain(url), { id: "url", title: "URL", text: "https://example.test", mono: true });
  w.setStatus("connection", { tone: "err", text: "lost" });
  assert.deepEqual(plain(w.status()[0]), { id: "connection", title: "Connection", text: "lost", tone: "err" });
  w.setStatus("connection", { tone: null });
  assert.equal("tone" in plain(w.status()[0]), false);
  w.setStatus("connection", { text: "" });
  assert.equal(
    w.status().some((s) => s.id === "connection"),
    false,
  );
});

test("setStatus clamps long text at MAX_STATUS_TEXT", () => {
  const w = model(browser);
  w.setStatus("url", { text: "x".repeat(K.MAX_STATUS_TEXT) });
  assert.equal(w.status().find((s) => s.id === "url")?.text.length, K.MAX_STATUS_TEXT);
  w.setStatus("url", { text: "x".repeat(K.MAX_STATUS_TEXT + 50) });
  const t = w.status().find((s) => s.id === "url")?.text ?? "";
  assert.equal(t.length, K.MAX_STATUS_TEXT);
  assert.ok(t.endsWith("\u2026"));
});

test("setStatus errors", () => {
  const w = model(browser);
  assert.throws(() => w.setStatus("nope", { text: "x" }), /setStatus: .*"browser".*no status slot "nope".*declare it/);
  assert.throws(() => w.setStatus("url", { tone: "blue" as never }), /tone "blue" is not one of.*or null to clear/);
  assert.throws(() => w.setStatus("url", { bogus: 1 } as never), /unknown field "bogus".*use text or tone/);
  assert.throws(() => w.setStatus("url", null as never), /needs a patch object/);
});

test("subscribe fires on setState, setStatus and invoke; unsubscribe stops it", () => {
  const w = model(browser);
  let n = 0;
  const off = w.subscribe(() => n++);
  w.setState("browser.copy-url", { enabled: false });
  assert.equal(n, 1);
  w.setStatus("url", { text: "u" });
  assert.equal(n, 2);
  w.onCommand(() => {});
  w.invoke("browser.actual");
  assert.equal(n, 3);
  off();
  w.setStatus("url", { text: "v" });
  w.setState("browser.copy-url", { enabled: true });
  assert.equal(n, 3);
});

test("createWindowModel rejects an undeclared object", () => {
  assert.throws(() => K.createWindowModel({ id: "x" } as never), /createWindowModel:.*call declareView first/);
});

// ---- 4. invoke ----

const recorder = (w: WindowModel) => {
  const calls: unknown[][] = [];
  w.onCommand((c, a) => {
    calls.push([c, a]);
  });
  return calls;
};

test("invoke action calls handler(command, undefined)", () => {
  const w = model(terminal);
  const calls = recorder(w);
  assert.deepEqual(plain(w.invoke("trace.copy")), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], "trace.copy");
  assert.equal(calls[0]?.[1], undefined);
});

test("invoke toggle flips with no arg, honours an explicit boolean, and updates checked", () => {
  const w = model(terminal);
  const calls = recorder(w);
  w.invoke("trace.raw");
  assert.deepEqual(calls[0], ["trace.raw", true]);
  assert.equal((find(w, "trace.raw") as { checked: boolean }).checked, true);
  w.invoke("trace.raw");
  assert.deepEqual(calls[1], ["trace.raw", false]);
  assert.equal((find(w, "trace.raw") as { checked: boolean }).checked, false);
  w.invoke("trace.raw", false);
  assert.deepEqual(calls[2], ["trace.raw", false]);
});

test("invoke radio passes the value and updates it", () => {
  const w = model(inbox);
  const calls = recorder(w);
  assert.deepEqual(plain(w.invoke("inbox.filter", "escalations")), { ok: true });
  assert.deepEqual(calls[0], ["inbox.filter", "escalations"]);
  assert.equal((find(w, "inbox.filter") as { value: string }).value, "escalations");
});

test("invoke failures return {ok:false, reason} and never call the handler", () => {
  const w = model(terminal);
  const calls = recorder(w);
  w.setState("trace.short", { visible: false });
  w.setState("trace.view", { enabled: false });
  const fail = (command: string, arg?: boolean | string) => {
    const r = w.invoke(command, arg);
    assert.equal(r.ok, false, `${command} must fail`);
    return r.ok ? "" : r.reason;
  };
  assert.match(fail("nope"), /Unknown command "nope".*reload/);
  assert.match(fail("trace.short"), /Short is not available/);
  assert.match(fail("trace.view"), /View trace is not available/);
  assert.match(fail("trace.raw", "yes"), /toggle and needs true or false/);
  assert.match(fail("trace.copy", true), /action and takes no argument/);
  assert.equal(calls.length, 0);
  // negative control: the valid sibling passes
  assert.equal(w.invoke("trace.copy").ok, true);
  assert.equal(calls.length, 1);
  const i = model(inbox);
  const icalls = recorder(i);
  const r = i.invoke("inbox.filter", "nope");
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /no option "nope"/);
  assert.equal(i.invoke("inbox.filter").ok, false);
  assert.equal(icalls.length, 0);
  assert.equal((find(i, "inbox.filter") as { value: string }).value, "all");
});

test("invoke without a handler explains onCommand and changes no state", () => {
  const w = model(terminal);
  const r = w.invoke("trace.raw");
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /onCommand/);
  assert.equal((find(w, "trace.raw") as { checked: boolean }).checked, false);
});

test("invoke reports a throwing handler with its message", () => {
  const w = model(terminal);
  w.onCommand(() => {
    throw new Error("boom");
  });
  const r = w.invoke("trace.copy");
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /Copy trace failed: boom/);
});

test("a second onCommand replaces the first handler; non-functions are rejected", () => {
  const w = model(terminal);
  const first = recorder(w);
  const second: unknown[][] = [];
  w.onCommand((c, a) => {
    second.push([c, a]);
  });
  w.invoke("trace.copy");
  assert.equal(first.length, 0);
  assert.equal(second.length, 1);
  assert.throws(() => w.onCommand("x" as never), /onCommand:.*needs a function/);
});

// ---- 5. overflow parity ----

const reachable = (entries: Array<{ kind: string; command?: string }>): string[] => entries.flatMap((e) => (e.command !== undefined ? [e.command] : [])).sort();

const patches: Array<Array<[string, { enabled?: boolean; visible?: boolean }]>> = [
  [],
  [["trace.raw", { visible: false }]],
  [
    ["trace.children", { enabled: false }],
    ["trace.download", { visible: false }],
  ],
  [
    ["session.reconnect", { visible: false }],
    ["help.keys", { enabled: false }],
  ],
  [
    ["browser.fit", { visible: false }],
    ["browser.actual", { visible: false }],
    ["browser.copy-url", { visible: false }],
  ],
  [["inbox.filter", { visible: false }]],
];

for (const [name, make] of fixtures) {
  test(`overflow matches menus for ${name} across state patches`, () => {
    const w = model(make);
    const known = new Set(cmds(w.menus()));
    for (const patch of patches) {
      for (const [c, p] of patch) if (known.has(c)) w.setState(c, p);
      const menus = w.menus();
      const over: OverflowEntry[] = w.overflow();
      assert.deepEqual(reachable(over as never), cmds(menus), `patch ${JSON.stringify(patch)}`);
      // headings: one per menu, in order, with a rule between menus
      const headings = over.filter((e) => e.kind === "heading").map((e) => (e as { menu: string }).menu);
      assert.deepEqual(
        headings,
        menus.map((m) => m.id),
      );
      const expectedKinds = menus.flatMap((m, i) => [...(i > 0 ? ["separator"] : []), "heading", ...m.items.map((x) => x.kind)]);
      assert.deepEqual(
        over.map((e) => e.kind),
        expectedKinds,
      );
      // items carry identical resolved state
      const flat = menus.flatMap((m) => m.items).filter((x) => x.kind !== "separator");
      const overItems = over.filter((e) => e.kind !== "heading" && e.kind !== "separator");
      assert.deepEqual(plain(overItems), plain(flat));
    }
  });
}

test("overflow parity detects a divergence (negative control)", () => {
  const w = model(terminal);
  w.setState("trace.raw", { visible: false });
  const over = w.overflow() as Array<{ command?: string }>;
  assert.notDeepEqual(reachable(over as never), cmds(model(terminal).menus()));
});

test("overflow of a view with no menus is empty", () => {
  assert.deepEqual(plain(model(() => ({ id: "tree", title: "Tree", multi: false })).overflow()), []);
});

// ---- 6. registry integration ----

// PANE_KIT_JS does not touch the DOM at load (document is only used inside helpers); it only needs a real
// globalThis object in the context, plus JSON/Object/Array/Set/Map/String/Error/RegExp/Date/Math.
const loadPaneKit = () => {
  const ctx = createContext({ JSON, Object, Array, Set, Map, String, Error, RegExp, Date, Math, Number, WeakSet });
  return runInContext(`(() => { ${PANE_KIT_JS}; return K; })()`, ctx) as {
    registerView(def: Record<string, unknown>): void;
    view(id: string): unknown;
    declaration(id: string): ReturnType<MenuKitApi["declareView"]> | undefined;
    windowModel(id: string): WindowModel;
  };
};
const mount = () => {};

test("registerView with menus registers; declaration and windowModel work", () => {
  const P = loadPaneKit();
  const d = terminal();
  P.registerView({ id: "terminal", title: "Terminal", multi: true, mount, menus: d.menus, status: [{ id: "connection", title: "Connection" }] });
  assert.ok(P.view("terminal"));
  const decl = P.declaration("terminal");
  assert.deepEqual(plain(decl?.menus.map((m) => m.id)), ["view", "trace", "session", "help"]);
  const w = P.windowModel("terminal");
  assert.equal(w.menus().length, 4);
  w.setStatus("connection", { text: "live" });
  // a second model is independent
  assert.equal(P.windowModel("terminal").status().length, 0);
});

test("registerView with invalid menus throws declareView: and leaves the view unregistered", () => {
  const P = loadPaneKit();
  assert.throws(
    () => P.registerView({ id: "bad", title: "Bad", multi: false, mount, menus: [{ id: "view", items: [] }] }),
    /^Error: declareView: .*"bad".*non-empty list/,
  );
  assert.equal(P.view("bad"), undefined);
  assert.equal(P.declaration("bad"), undefined);
  // negative control: the corrected declaration registers under the same id
  P.registerView({ id: "bad", title: "Bad", multi: false, mount, menus: [{ id: "view", items: [act("bad.a")] }] });
  assert.ok(P.view("bad"));
});

test("registerView without menus or status still registers", () => {
  const P = loadPaneKit();
  P.registerView({ id: "tree", title: "Tree", multi: false, mount });
  assert.ok(P.view("tree"));
  const w = P.windowModel("tree");
  assert.deepEqual(plain(w.menus()), []);
  assert.deepEqual(plain(w.status()), []);
});

test("windowModel on an unknown id throws naming registerView", () => {
  const P = loadPaneKit();
  assert.throws(() => P.windowModel("ghost"), /windowModel: view "ghost" is not registered.*registerView/);
});

// ---- 7. review hardening ----

// Run the kit with a stubbed console so reported failures can be asserted.
const withConsole = () => {
  const errors: string[] = [];
  const ctx = createContext({ globalThis: {}, JSON, Object, Array, Set, Map, String, Error, WeakSet, console: { error: (m: string) => errors.push(m) } });
  const kit = runInContext(`(() => { ${MENU_KIT_JS}; return MenuKit; })()`, ctx) as MenuKitApi;
  return { kit, errors };
};

test("a failing toggle handler restores the toggle state", () => {
  const w = model(terminal);
  w.onCommand(() => {
    throw new Error("boom");
  });
  assert.equal(w.invoke("trace.raw").ok, false);
  assert.equal((find(w, "trace.raw") as { checked: boolean }).checked, false);
});

test("a failing radio handler restores the radio value", () => {
  const w = model(inbox);
  w.onCommand(() => {
    throw new Error("boom");
  });
  assert.equal(w.invoke("inbox.filter", "approvals").ok, false);
  assert.equal((find(w, "inbox.filter") as { value: string }).value, "all");
});

test("the handler sees the new state, and a state it sets itself survives its own throw", () => {
  const w = model(terminal);
  let seen: boolean | undefined;
  w.onCommand(() => {
    seen = (find(w, "trace.raw") as { checked: boolean }).checked;
    w.setState("trace.raw", { checked: true });
    throw new Error("boom");
  });
  assert.equal(w.invoke("trace.raw").ok, false);
  assert.equal(seen, true);
  assert.equal((find(w, "trace.raw") as { checked: boolean }).checked, true);
});

test("a throwing listener neither skips the others nor throws into callers", () => {
  const { kit, errors } = withConsole();
  const w = kit.createWindowModel(kit.declareView(browser()));
  let second = 0;
  w.subscribe(() => {
    throw new Error("bad listener");
  });
  w.subscribe(() => second++);
  assert.doesNotThrow(() => w.setState("browser.copy-url", { enabled: false }));
  assert.doesNotThrow(() => w.setStatus("url", { text: "u" }));
  w.onCommand(() => {});
  assert.deepEqual(plain(w.invoke("browser.actual")), { ok: true });
  assert.equal(second, 3);
  assert.equal(errors.length, 3);
  assert.match(errors[0] ?? "", /^MenuKit: a subscriber threw: bad listener; fix the listener$/);
});

test("a throwing listener without a console does not throw either", () => {
  const w = model(browser);
  w.subscribe(() => {
    throw new Error("x");
  });
  assert.doesNotThrow(() => w.setStatus("url", { text: "u" }));
});

test("a rejecting async handler is reported, not unhandled, and invoke still returns ok", async () => {
  const { kit, errors } = withConsole();
  const w = kit.createWindowModel(kit.declareView(terminal()));
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    w.onCommand((async () => {
      throw new Error("async boom");
    }) as never);
    assert.deepEqual(plain(w.invoke("trace.copy")), { ok: true });
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /rejected: async boom.*setStatus/);
});

test("createWindowModel accepts only declareView results", () => {
  const declared = K.declareView(inbox());
  assert.doesNotThrow(() => K.createWindowModel(declared));
  const handBuilt = {
    id: "inbox",
    title: "Inbox",
    multi: false,
    menus: [{ id: "view", items: [{ kind: "radio", command: "inbox.filter", label: "F" }] }],
    status: [],
  };
  assert.throws(() => K.createWindowModel(handBuilt as never), /createWindowModel:.*declareView/);
  assert.throws(() => K.createWindowModel(JSON.parse(JSON.stringify(declared))), /createWindowModel:.*call declareView first/);
});

test("declareView messages never throw a bare TypeError", () => {
  bad(mk({ id: 10n }), /^Error: declareView: view 10: id must be a lowercase name/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  bad(mk({ title: cyclic }), /^Error: declareView: .*title must be a non-empty string/);
  bad(withItems([cyclic]), /^Error: declareView: .*kind/);
  bad(mk({ title: "x".repeat(300) }), /title must be a non-empty string.*\u2026/s);
});

test("setStatus text must be a string and whitespace-only text hides the slot", () => {
  const w = model(browser);
  assert.throws(() => w.setStatus("url", { text: null as never }), /setStatus: slot url: text must be a string, got null; pass a string/);
  assert.throws(() => w.setStatus("url", { text: 5 as never }), /text must be a string/);
  assert.equal(
    w.status().some((s) => s.id === "url"),
    false,
  );
  w.setStatus("url", { text: "u" });
  assert.equal(
    w.status().some((s) => s.id === "url"),
    true,
  );
  w.setStatus("url", { text: "   " });
  assert.equal(
    w.status().some((s) => s.id === "url"),
    false,
  );
});

test("an explicit undefined in a setState patch is ignored", () => {
  const w = model(terminal);
  assert.doesNotThrow(() => w.setState("trace.copy", { enabled: false, checked: undefined, value: undefined } as never));
  assert.equal((find(w, "trace.copy") as { enabled: boolean }).enabled, false);
});

test("windowHost adds the model hooks to a copy of base", () => {
  const P = loadPaneKit() as unknown as {
    registerView(d: Record<string, unknown>): void;
    windowModel(id: string): WindowModel;
    windowHost(m: unknown, b: unknown): Record<string, unknown>;
  };
  P.registerView({ id: "terminal", title: "Terminal", multi: true, mount, menus: terminal().menus });
  const m = P.windowModel("terminal");
  const base = { setTitle: () => {} };
  const h = P.windowHost(m, base);
  assert.equal(h.setTitle, base.setTitle);
  assert.equal(h.setMenuState, m.setState);
  assert.equal(h.setStatus, m.setStatus);
  assert.equal(h.onCommand, m.onCommand);
  assert.notEqual(h, base);
  assert.equal("onCommand" in base, false);
  assert.throws(() => P.windowHost({}, base), /windowHost: model must be a window model.*pass the result/);
  assert.throws(() => P.windowHost(m, null), /windowHost: base must be.*pass an object/);
});

// ---- pane controls (chrome-hosted buttons and search) ----

const btn = (command: string, extra: Record<string, unknown> = {}) => ({ kind: "button", command, label: "B", ...extra });
const search = (command: string, extra: Record<string, unknown> = {}) => ({ kind: "search", command, label: "S", ...extra });
const withControls = (controls: unknown[], over: Record<string, unknown> = {}) => mk({ controls, ...over });
const ctlModel = (controls: unknown[]): WindowModel => K.createWindowModel(K.declareView(withControls(controls)));

test("controls: default to [], normalize to a frozen copy and round-trip through JSON", () => {
  assert.deepEqual(plain(K.declareView(mk()).controls), []);
  const out = K.declareView(withControls([btn("v.new", { primary: true }), search("v.filter", { placeholder: "Filter", value: "x" })]));
  assert.deepEqual(plain(out.controls), [
    { kind: "button", command: "v.new", label: "B", primary: true },
    { kind: "search", command: "v.filter", label: "S", placeholder: "Filter", value: "x" },
  ]);
  assert.ok(Object.isFrozen(out.controls) && Object.isFrozen(out.controls[0]));
  assert.deepEqual(plain(K.declareView(JSON.parse(JSON.stringify(out)))), plain(out));
});

test("controls: each failure class names the cause and the action, and a valid control passes", () => {
  assert.doesNotThrow(() => K.declareView(withControls([btn("v.new"), search("v.filter")])), "negative control");
  bad(withControls("x" as unknown as unknown[]), /controls must be a list of at most 6 entries.*declare controls as/);
  bad(withControls([7]), /control 1: a control must be an object.*declare it as/);
  bad(withControls([{ kind: "toggle", command: "v.t", label: "T" }]), /unknown control kind "toggle".*use button or search/);
  bad(withControls([btn("Bad Cmd")]), /command must be a lowercase id.*use lowercase letters/);
  bad(withControls([btn("v.a")]), /command v\.a is declared twice.*own command id/); // clashes with the menu item
  bad(withControls([btn("v.x"), search("v.x")]), /command v\.x is declared twice/);
  bad(withControls([btn("v.x", { label: "" })]), /label must be a non-empty string/);
  bad(withControls([btn("v.x", { onClick: () => {} })]), /unknown field "onClick".*remove it/);
  bad(withControls([btn("v.x", { placeholder: "p" })]), /unknown field "placeholder"/);
  bad(withControls([search("v.x", { primary: true })]), /unknown field "primary"/);
  bad(withControls([btn("v.x", { primary: "yes" })]), /primary must be true or false/);
  bad(withControls([btn("v.x", { enabled: 1 })]), /enabled must be true or false/);
  bad(withControls([search("v.x", { placeholder: 3 })]), /placeholder must be a non-empty string/);
  bad(withControls([search("v.x", { value: 3 })]), /value must be a string of at most 200 characters.*omit value/);
  bad(withControls([search("v.x", { value: "x".repeat(201) })]), /value must be a string of at most 200/);
});

test("controls: at most MAX_CONTROLS", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => btn(`v.c${i}`));
  assert.equal(K.MAX_CONTROLS, 6);
  assert.doesNotThrow(() => K.declareView(withControls(many(K.MAX_CONTROLS))));
  bad(withControls(many(K.MAX_CONTROLS + 1)), /controls must be a list of at most 6 entries/);
});

test("controls(): resolves enabled/visible/value overlays and keeps hidden ones flagged", () => {
  const w = ctlModel([btn("v.new", { primary: true }), btn("v.off", { enabled: false, visible: false }), search("v.filter", { placeholder: "Filter" })]);
  assert.deepEqual(plain(w.controls()), [
    { kind: "button", command: "v.new", label: "B", enabled: true, visible: true, primary: true },
    { kind: "button", command: "v.off", label: "B", enabled: false, visible: false, primary: false },
    { kind: "search", command: "v.filter", label: "S", enabled: true, visible: true, value: "", placeholder: "Filter" },
  ]);
  let ticks = 0;
  w.subscribe(() => {
    ticks++;
  });
  w.setState("v.off", { enabled: true, visible: true });
  w.setState("v.filter", { value: "abc", enabled: false });
  assert.equal(ticks, 2);
  const now = plain(w.controls());
  assert.deepEqual([now[1].enabled, now[1].visible, now[2].value, now[2].enabled], [true, true, "abc", false]);
});

test("controls: setState rejects fields that do not apply, with cause", () => {
  const w = ctlModel([btn("v.new"), search("v.filter")]);
  assert.throws(() => w.setState("v.new", { value: "x" }), /value applies to radio items.*and search controls.*for a button/);
  assert.throws(() => w.setState("v.new", { checked: true }), /checked applies to toggle items/);
  assert.throws(() => w.setState("v.filter", { value: 5 as never }), /value must be a string of at most 200/);
  assert.throws(() => w.setState("v.filter", { value: "x".repeat(201) }), /at most 200/);
  assert.throws(() => w.setState("nope", { enabled: true }), /no command "nope".*menus or controls/);
  assert.doesNotThrow(() => w.setState("v.filter", { value: "" }), "negative control");
});

test("controls: a button invokes with no argument; an argument is refused", () => {
  const w = ctlModel([btn("v.new")]);
  const calls: unknown[][] = [];
  w.onCommand((c, a) => {
    calls.push([c, a]);
  });
  assert.deepEqual(plain(w.invoke("v.new")), { ok: true });
  assert.deepEqual(calls, [["v.new", undefined]]);
  const r = plain(w.invoke("v.new", "x"));
  assert.equal(r.ok, false);
  assert.match(r.reason, /B is a button and takes no argument/);
  assert.equal(calls.length, 1);
  w.setState("v.new", { enabled: false });
  assert.match(plain(w.invoke("v.new")).reason, /not available right now/);
});

test("controls: a search invokes with its string, stores it, and refuses non-strings and long text", () => {
  const w = ctlModel([search("v.filter")]);
  const calls: unknown[][] = [];
  w.onCommand((c, a) => {
    calls.push([c, a]);
  });
  assert.deepEqual(plain(w.invoke("v.filter", "abc")), { ok: true });
  assert.deepEqual(plain(w.invoke("v.filter", "")), { ok: true });
  assert.deepEqual(calls, [
    ["v.filter", "abc"],
    ["v.filter", ""],
  ]);
  w.invoke("v.filter", "abc");
  assert.equal(plain(w.controls())[0].value, "abc");
  for (const v of [undefined, 5, true, "x".repeat(201)]) {
    const r = plain(w.invoke("v.filter", v as never));
    assert.equal(r.ok, false);
    assert.match(r.reason, /S needs text of at most 200 characters/);
  }
  assert.equal(calls.length, 3, "refused calls never reach the handler");
  assert.deepEqual(plain(w.invoke("v.filter", "x".repeat(200))), { ok: true }, "negative control: the limit is inclusive");
});

test("controls: a throwing search handler restores the previous text", () => {
  const w = ctlModel([search("v.filter", { value: "old" })]);
  w.onCommand(() => {
    throw new Error("boom");
  });
  const r = plain(w.invoke("v.filter", "new"));
  assert.equal(r.ok, false);
  assert.match(r.reason, /failed: boom/);
  assert.equal(plain(w.controls())[0].value, "old");
});
