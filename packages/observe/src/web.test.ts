import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveStream, displayRows, encodeSseFrame, renderLivePage, renderReportsPage, renderTreePane } from "./web.ts";
import type { DisplayRow } from "./web.ts";
import { buildTree } from "./tree.ts";
import { agent, entry } from "./fixtures.ts";

const agents = [agent("root0000-x", null, { name: "root" }), agent("kid", "root0000-x", { name: "kid", state: "yielded", createdAt: 1 })];
const journal = [entry(1, "kid", { kind: "tool_call", tool: "bash", callId: "c", input: {} })];
const opts = { now: 90_000, waits: new Map([["kid", { kind: "message" } as const]]) };

test("displayRows carries the terminal renderer's columns, pre-formatted", () => {
  const d = displayRows(buildTree(agents, journal, opts));
  assert.equal(d.length, 2);
  assert.deepEqual(d[0], {
    name: "root",
    id: "root0000",
    fullId: "root0000-x",
    depth: 0,
    state: "running",
    age: "1m",
    activity: "",
    tokens: 0,
    cost: "$0.0000",
    left: "$1.0000",
    wait: "",
    host: "h1",
    deadline: "",
    lastTs: null,
    model: "",
  } satisfies DisplayRow);
  assert.deepEqual(d[1], {
    name: "kid",
    id: "kid",
    fullId: "kid",
    depth: 1,
    state: "yielded",
    age: "1m",
    activity: "tool bash",
    tokens: 0,
    cost: "$0.0000",
    left: "$1.0000",
    wait: "message",
    host: "h1",
    deadline: "",
    lastTs: 1010,
    model: "",
  } satisfies DisplayRow);
});

test("LiveStream folds entries into a 'rows' frame and ignores duplicates", () => {
  const s = new LiveStream();
  assert.equal(s.apply(entry(1, "a", { kind: "spawned" })), true);
  assert.equal(s.apply(entry(1, "a", { kind: "spawned" })), false);
  s.apply(entry(2, "a", { kind: "usage", inputTokens: 5, outputTokens: 1, costMicros: 7 }));
  const frame = s.frame([agent("a", null)], { now: 100 });
  assert.equal(frame.event, "rows");
  const rows = JSON.parse(frame.data) as DisplayRow[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.tokens, 6);
  assert.equal(rows[0]!.cost, "$0.0000");
  assert.equal(encodeSseFrame(frame), `event: rows\ndata: ${frame.data}\n\n`);
});

test("encodeSseFrame splits multi-line data per the SSE spec", () => {
  assert.equal(encodeSseFrame({ event: "x", data: "a\nb" }), "event: x\ndata: a\ndata: b\n\n");
});

test("the page is fully inline and subscribes to the configured events path", () => {
  const html = renderLivePage({ title: "t", eventsPath: "/live/events" });
  assert.ok(html.includes("<title>t</title>"));
  assert.ok(html.includes('K.stream("/live/events"'));
  assert.ok(html.includes("rows: (ev)"));
  assert.ok(!html.includes("src=")); // no external script or stylesheet, no build step
  const def = renderLivePage();
  assert.ok(def.includes('K.stream("events"'));
});

test("title is HTML-escaped and the events path cannot close the script", () => {
  const html = renderLivePage({ title: "<img src=x onerror=1>&", eventsPath: "</script><script>alert(1)</script>\u2028" });
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&#60;img src=x onerror=1&#62;&#38;"));
  assert.equal(html.match(/<\/script>/g)!.length, 1);
  assert.ok(!html.includes("\u2028"));
  assert.ok(html.includes('K.stream("\\u003c/script>'));
});

test("the reports page is fully inline, has the table scaffolding, and fetches the configured path", () => {
  const html = renderReportsPage({ title: "reports", reportsPath: "/v1/reports" });
  assert.ok(html.includes("<title>reports</title>"));
  assert.ok(html.includes('K.getJson("/v1/reports")'));
  assert.ok(html.includes("<th>AGENT</th><th>NAME</th><th>TYPE</th><th>SIZE</th><th>AGE</th><th>ID</th>"));
  assert.ok(html.includes('id="reports-rows"'));
  assert.ok(html.includes("No reports published yet."));
  assert.ok(html.includes("/v1/agents/"));
  assert.ok(html.includes("encodeURIComponent"));
  assert.ok(html.includes("textContent")); // data cells render via textContent, never innerHTML
  assert.ok(!html.includes("src=")); // no external script or stylesheet, no build step
  const def = renderReportsPage();
  assert.ok(def.includes('K.getJson("/v1/reports")'));
});

test("the reports page title is HTML-escaped and the reports path cannot close the script", () => {
  const html = renderReportsPage({ title: "<img src=x onerror=1>&", reportsPath: "</script><script>alert(1)</script>\u2028" });
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&#60;img src=x onerror=1&#62;&#38;"));
  assert.equal(html.match(/<\/script>/g)!.length, 1);
  assert.ok(!html.includes("\u2028"));
  assert.ok(html.includes('K.getJson("\\u003c/script>'));
});

test("tree pane markup is the shared skeleton: one pane-body tablewrap, no toolbar row, no New agent link, no connection element", () => {
  const html = renderTreePane();
  const pane = html.slice(0, html.indexOf("<script>"));
  assert.ok(pane.startsWith('<div class="tree pane">\n<div class="tablewrap pane-body"><table>'));
  assert.equal(pane.match(/pane-body/g)?.length, 1);
  assert.ok(!pane.includes("New agent"));
  assert.ok(!pane.includes("tree-conn"));
  assert.ok(html.includes("K.declareSection({"));
  assert.ok(html.includes('command: "tree.new", label: "New agent", primary: true'));
  assert.ok(html.includes('{ id: "connection", title: "Connection" }'));
  assert.ok(html.includes('{ ok: "ok", stale: "warn" }'));
});

test("standalone live page keeps its #tree-conn badge in the heading and offers no New agent", () => {
  const html = renderLivePage();
  assert.ok(html.includes('<h1>pomtree live <span id="tree-conn" class="conn"></span></h1>'));
  assert.ok(!html.includes("+ New agent"));
  assert.ok(!html.includes('<a class="btn"'));
});

test("reports pane markup: reports root with one pane-body tablewrap and a count slot", () => {
  const html = renderReportsPage();
  const pane = html.slice(html.indexOf('<div class="reports pane">'), html.indexOf("<script>"));
  assert.ok(pane.startsWith('<div class="reports pane">\n<div class="tablewrap pane-body"><table>'));
  assert.equal(pane.match(/pane-body/g)?.length, 1);
  assert.ok(html.includes('K.declareSection({ id: "reports", title: "Reports", status: [{ id: "count", title: "Reports" }] })'));
});
