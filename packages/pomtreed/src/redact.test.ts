import { test } from "node:test";
import assert from "node:assert/strict";
import { redactPaths, redactPayload } from "./daemon-util.ts";

test("redactPaths replaces every root occurrence, longest root first", () => {
  const roots = ["/var/pomtreed", "/var/pomtreed/sessions"];
  assert.equal(redactPaths("ENOENT /var/pomtreed/sessions/a1/x and /var/pomtreed/workspaces/w", roots), "ENOENT <state>/a1/x and <state>/workspaces/w");
  assert.equal(redactPaths("nothing here", roots), "nothing here");
});

test("redactPaths ignores empty and root-only roots and trailing slashes", () => {
  assert.equal(redactPaths("/a/b /", ["", "/"]), "/a/b /");
  assert.equal(redactPaths("open /s/t/f", ["/s/t/"]), "open <state>/f");
});

test("redactPaths is path-boundary aware", () => {
  const roots = ["/tmp/x"];
  assert.equal(redactPaths("/tmp/xyz", roots), "/tmp/xyz");
  assert.equal(redactPaths("/tmp/x-1 /tmp/x_1 /tmp/x.json /a/tmp/x", roots), "/tmp/x-1 /tmp/x_1 /tmp/x.json /a/tmp/x");
  assert.equal(redactPaths("/tmp/x /tmp/x/ /tmp/x/sub", roots), "<state> <state>/ <state>/sub");
  assert.equal(redactPaths("at '/tmp/x'. then (/tmp/x), /tmp/x.", roots), "at '<state>'. then (<state>), <state>.");
  assert.equal(redactPaths("a+b /t/a+b/c /t/aab", ["/t/a+b"]), "a+b <state>/c /t/aab", "regex metacharacters in a root are literal");
});

test("redactPaths takes the longest root first, including nested and duplicate roots", () => {
  assert.equal(redactPaths("/r/repo/sub/f /r/repo2", ["/r", "/r/repo", "/r/repo", "/r/repo/sub"]), "<state>/f <state>/repo2");
  assert.equal(redactPaths("/r/repo2/f", ["/r/repo", "/r/repo2"]), "<state>/f", "a root that prefixes another does not eat it");
});

test("redactPayload walks every string in the payload and keeps untouched payloads by reference", () => {
  const roots = ["/state"];
  assert.deepEqual(redactPayload({ kind: "error", message: "boom /state/x" }, roots), { kind: "error", message: "boom <state>/x" });
  assert.deepEqual(redactPayload({ kind: "host_error", component: "sandbox", message: "/state" } as never, roots), {
    kind: "host_error",
    component: "sandbox",
    message: "<state>",
  });
  assert.deepEqual(redactPayload({ kind: "message", role: "assistant", text: "see /state/x" } as never, roots), {
    kind: "message",
    role: "assistant",
    text: "see <state>/x",
  });
  assert.deepEqual(
    redactPayload(
      { kind: "tool_call", callId: "c", tool: "t", input: { path: "/state/a", list: ["/state/b", 1, null], n: { deep: "/state" } } } as never,
      roots,
    ),
    { kind: "tool_call", callId: "c", tool: "t", input: { path: "<state>/a", list: ["<state>/b", 1, null], n: { deep: "<state>" } } },
  );
  const clean = { kind: "error", message: "fine", extra: { a: ["b"] } } as never;
  assert.equal(redactPayload(clean, roots), clean);
});
