import assert from "node:assert/strict";
import { test } from "node:test";
import { pollTree, renderRows } from "./top.ts";
import type { DisplayRow, TopFetch } from "./top.ts";

const row = (extra: Partial<DisplayRow> = {}): DisplayRow => ({
  name: "a",
  id: "a",
  depth: 0,
  state: "running",
  age: "0s",
  activity: "",
  tokens: 0,
  cost: "$0.0000",
  left: "$1.0000",
  wait: "",
  host: "h1",
  ...extra,
});

test("renderRows renders the table with headers and depth indent", () => {
  const out = renderRows([row(), row({ name: "b", id: "b", depth: 1, state: "exited:succeeded" })]);
  assert.match(out, /^AGENT\s+ID\s+STATE/);
  assert.match(out, /^ {2}b\s+b\s+exited:succeeded/m);
});

test("renderRows strips terminal control sequences from agent strings", () => {
  const out = renderRows([row({ name: "a\x1b[2J", host: "h\x1b]0;p\x07", activity: "tool bash\x1b[31m" })]);
  assert.ok(!out.includes("\x1b"));
  assert.match(out, /^a\s+a\s+running/m);
});

test("renderRows colors the state column only when asked", () => {
  assert.ok(!renderRows([row()]).includes("\x1b["));
  assert.ok(renderRows([row()], { color: true }).includes("\x1b["));
  assert.equal(renderRows([], { color: true }), "(no agents)");
});

test("pollTree polls /v1/tree once per interval and never finishes on its own", async () => {
  const calls: string[] = [];
  const fetch: TopFetch = (method, path) => {
    calls.push(`${method} ${path}`);
    return Promise.resolve([row({ name: "a" })]);
  };
  const it = pollTree(fetch, { intervalMs: 5 });
  const first = await it.next();
  assert.equal(first.done, false);
  assert.equal(first.value![0]!.name, "a");
  await it.return(undefined);
  assert.deepEqual(calls, ["GET /v1/tree"]);
});
