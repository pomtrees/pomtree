import assert from "node:assert/strict";
import { test } from "node:test";
import { CHROME_NAMES, findChrome, parseDevToolsUrl, STUB_REPORT_TEXT, stubReply } from "../scripts/chromeCheckLib.ts";

const exists =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

test("findChrome: CHROME_BIN wins over PATH when it is executable", () => {
  const r = findChrome({ CHROME_BIN: "/opt/c/chrome", PATH: "/usr/bin" }, exists("/opt/c/chrome", "/usr/bin/google-chrome"));
  assert.deepEqual(r, { kind: "found", path: "/opt/c/chrome", via: "CHROME_BIN" });
});

test("findChrome: a set but unusable CHROME_BIN is an error naming the value and the action, not a skip", () => {
  const r = findChrome({ CHROME_BIN: "/nope", PATH: "/usr/bin" }, exists("/usr/bin/google-chrome"));
  assert.equal(r.kind, "error");
  assert.match(r.kind === "error" ? r.message : "", /CHROME_BIN=\/nope.*not an executable.*unset it/);
});

test("findChrome: searches PATH in directory order, then in name order", () => {
  const first = findChrome({ PATH: "/a:/b" }, exists("/b/chromium", "/a/chromium-browser"));
  assert.deepEqual(first, { kind: "found", path: "/a/chromium-browser", via: "PATH" });
  const named = findChrome({ PATH: "/a" }, exists("/a/chromium", "/a/google-chrome"));
  assert.deepEqual(named, { kind: "found", path: "/a/google-chrome", via: "PATH" });
});

test("findChrome: nothing found is a skip that lists the names tried and the override", () => {
  const r = findChrome({ PATH: "/a:/b" }, exists());
  assert.equal(r.kind, "skip");
  const reason = r.kind === "skip" ? r.reason : "";
  for (const n of CHROME_NAMES) assert.ok(reason.includes(n), n);
  assert.match(reason, /CHROME_BIN/);
  assert.equal(findChrome({}, exists("/usr/bin/google-chrome")).kind, "skip"); // no PATH at all
});

test("parseDevToolsUrl reads the address from Chrome's banner and ignores other output", () => {
  const banner = "[1:1:ERROR] noise\nDevTools listening on ws://127.0.0.1:41233/devtools/browser/abc-123\n";
  assert.equal(parseDevToolsUrl(banner), "ws://127.0.0.1:41233/devtools/browser/abc-123");
  assert.equal(parseDevToolsUrl("DevTools listening on"), null);
  assert.equal(parseDevToolsUrl(""), null);
});

test("stubReply serves the agents, the report and its raw text; an unknown path is a 404 naming it", () => {
  assert.equal(stubReply("/v1/agents").status, 200);
  assert.equal(JSON.parse(stubReply("/v1/agents").body).length, 2);
  assert.equal(JSON.parse(stubReply("/v1/reports").body)[0].report.id, "r1");
  assert.equal(stubReply("/v1/approvals?state=pending").body, "[]");
  assert.equal(JSON.parse(stubReply("/v1/agents/a1/reports/r1").body).mediaType, "text/markdown");
  assert.equal(stubReply("/v1/agents/a1/reports/r1?raw=1").body, STUB_REPORT_TEXT);
  const missing = stubReply("/v1/other");
  assert.equal(missing.status, 404);
  assert.match(missing.body, /no route for \/v1\/other/);
});
