import assert from "node:assert/strict";
import { test } from "node:test";
import { USER_TEXT_MAX, relayOf, statusSubject, toUser } from "./to-user.ts";

const Z = "\u200b";

test("toUser strips bidi, zero-width, and line-separator characters", () => {
  const cases: [string, string, string][] = [
    ["bidi override", "a\u202eb\u202ac\u202dd", "abcd"],
    ["bidi isolates", "a\u2066b\u2069c", "abc"],
    ["LRM/RLM/ALM", "a\u200eb\u200fc\u061cd", "abcd"],
    ["zero-width", "a\u200bb\u200cc\u200dd\u2060e\ufeff", "abcde"],
    ["NEL/LS/PS", "a\u0085b\u2028c\u2029d", "abcd"],
    ["ANSI/control via clipText", "a\u001b[31mb\u0000c\u007f", "a[31mbc"],
  ];
  for (const [name, input, want] of cases) assert.equal(toUser(input), want, name);
});

test("toUser neutralises Discord mentions", () => {
  const cases: [string, string, string][] = [
    ["@everyone", "hi @everyone now", `hi @${Z}everyone now`],
    ["@here", "@here!", `@${Z}here!`],
    ["@user", "ping @bob_1", `ping @${Z}bob_1`],
    ["<@id>", "<@123>", `<${Z}@${Z}123>`],
    ["<@!id>", "<@!1>", `<${Z}@!1>`],
    ["<@&id>", "<@&1>", `<${Z}@&1>`],
    ["<#id>", "<#1>", `<${Z}#1>`],
    ["bare @ untouched", "a @ b", "a @ b"],
    ["mention hidden by zero-width is still broken", "@\u200beveryone", `@${Z}everyone`],
  ];
  for (const [name, input, want] of cases) assert.equal(toUser(input), want, name);
});

test("toUser is idempotent over a generated set", () => {
  const atoms = ["@everyone", "@here", "@x", "<@1>", "<@!2>", "<@&3>", "<#4>", "\u202e", "\u200b", "\u001b[1m", "plain", " ", "\n", "@", "<", "é"];
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let i = 0; i < 300; i++) {
    let s = "";
    for (let j = rnd(40); j >= 0; j--) s += atoms[rnd(atoms.length)];
    const max = [10, 50, 200, USER_TEXT_MAX][rnd(4)]!;
    const once = toUser(s, max);
    assert.equal(toUser(once, max), once, JSON.stringify(s));
    assert.ok(once.length <= max);
  }
});

test("toUser bounds length and truncates once", () => {
  const huge = toUser("x".repeat(100 * 1024));
  assert.ok(huge.length <= USER_TEXT_MAX);
  assert.equal(huge.match(/\[truncated/g)?.length, 1);
  assert.match(huge, /… \[truncated \d+ chars\]$/);

  const exact = "y".repeat(USER_TEXT_MAX);
  assert.equal(toUser(exact), exact);
  assert.match(toUser(`${exact}z`), /\[truncated/);

  // Mention-breaking growth must not push past max.
  const mentions = toUser("@a".repeat(5000));
  assert.ok(mentions.length <= USER_TEXT_MAX);
  assert.equal(mentions.match(/\[truncated/g)?.length, 1);
  const again = toUser(mentions);
  assert.equal(again, mentions);

  // Re-running on already-truncated text does not add a second marker.
  assert.equal(toUser(huge).match(/\[truncated/g)?.length, 1);
  assert.ok(toUser("abc", 5).length <= 5);
  assert.ok(toUser("x".repeat(100), 5).length <= 5);
});

test("statusSubject formats present parts and omits absent ones", () => {
  const cases: [string, Parameters<typeof statusSubject>[0], string][] = [
    ["minimal", { id: "a1", exit: "done" }, "a1 done: no handoff"],
    ["cause", { id: "a1", exit: "failed", cause: "oom" }, "a1 failed (oom): no handoff"],
    ["handoff", { id: "a1", exit: "done", handoff: "fixed it" }, "a1 done: fixed it"],
    ["blank handoff", { id: "a1", exit: "done", handoff: "  " }, "a1 done: no handoff"],
    ["spent and budget", { id: "a1", exit: "done", spentMicros: 1_234_567, budgetMicros: 5_000_000 }, "a1 done: no handoff | spent $1.23/$5.00"],
    ["spent only", { id: "a1", exit: "done", spentMicros: 0 }, "a1 done: no handoff | spent $0.00"],
    ["budget only", { id: "a1", exit: "done", budgetMicros: 1_000_000 }, "a1 done: no handoff | budget $1.00"],
    [
      "everything",
      { id: "a1", exit: "failed", cause: "timeout", handoff: "h", spentMicros: 500_000, budgetMicros: 1_000_000, branch: "agent/a1" },
      "a1 failed (timeout): h | spent $0.50/$1.00 | branch agent/a1",
    ],
  ];
  for (const [name, input, want] of cases) assert.equal(statusSubject(input), want, name);
});

test("toUser breaks an escalation id so it cannot be parsed back out of quoted text", () => {
  const id = `es-${"a1".repeat(32)}`;
  const out = toUser(`reply to ${id}`);
  assert.ok(!out.includes(id));
  assert.equal(out.replace(/\u200b/g, ""), `reply to ${id}`);
  assert.equal(toUser("lines-abc"), "lines-abc");
});

test("relayOf renders an exit as a status and a message with sender attribution; other kinds are not relayed", () => {
  assert.deepEqual(
    relayOf({
      kind: "child_exited",
      child: "a1",
      exit: "failed",
      cause: "oom_killed",
      handoff: "h",
      branch: "agent/a1",
      spentMicros: 500_000,
      budgetMicros: 1_000_000,
    }),
    {
      purpose: "status",
      subject: "a1 failed (oom_killed): h | spent $0.50/$1.00 | branch agent/a1",
    },
  );
  assert.deepEqual(relayOf({ kind: "message", from: "a1", body: "hello" }), { purpose: "report", subject: "[from a1] hello" });
  assert.equal(relayOf({ kind: "human_message", from: { channel: "c", sender: "s" }, body: "x" }), undefined);
});
