// ProcessCaptureParser (L1): real child processes. The verdicts come from core's parsers in the child; a hang is killed at the
// deadline, a crash and an oversized input reject, and the child sees no environment.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CaptureParserError, ProcessCaptureParser } from "./process-parser.ts";

const enc = (s: string) => new TextEncoder().encode(s);

test("robots verdicts and Wayback answers are parsed in the child", async () => {
  const p = new ProcessCaptureParser();
  assert.deepEqual(await p.robots({ body: enc("User-agent: Claude-User\nDisallow: /feed\n"), tokens: ["pomtree-test", "Claude-User"], path: "/feed/x" }), {
    verdict: "disallow",
    rule: "Disallow: /feed",
  });
  assert.deepEqual(await p.robots({ body: enc("User-agent: ClaudeBot\nDisallow: /\n"), tokens: ["pomtree-test", "Claude-User"], path: "/" }), {
    verdict: "allow",
    rule: null,
  });
  const answer = JSON.stringify({
    archived_snapshots: {
      closest: { status: "200", available: true, url: "http://web.archive.org/web/20261020120000/https://example.com/a", timestamp: "20261020120000" },
    },
  });
  assert.deepEqual(await p.waybackAvailability({ body: enc(answer) }), {
    url: "https://example.com/a",
    timestamp: "20261020120000",
    archivedAt: Date.UTC(2026, 9, 20, 12, 0, 0),
  });
  assert.equal(await p.waybackAvailability({ body: enc("not json at all") }), null, "a malformed answer is no snapshot, not a failure");
});

test("a hung, crashing, or environment-reading child is handled, and oversized input is refused", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "capture-parser-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hang = join(dir, "hang.mjs");
  writeFileSync(hang, "setInterval(() => {}, 1000);\n");
  const crash = join(dir, "crash.mjs");
  writeFileSync(crash, "process.exit(3);\n");
  const envDump = join(dir, "env.mjs");
  writeFileSync(
    envDump,
    'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ verdict: "allow", rule: JSON.stringify(Object.keys(process.env)) })));\n',
  );
  const t0 = Date.now();
  await assert.rejects(new ProcessCaptureParser({ script: hang, timeoutMs: 200 }).robots({ body: enc(""), tokens: [], path: "/" }), (e: unknown) => {
    assert.ok(e instanceof CaptureParserError);
    assert.equal(e.failureCause, "deadline");
    return true;
  });
  assert.ok(Date.now() - t0 < 3000, "killed at the deadline");
  await assert.rejects(new ProcessCaptureParser({ script: crash }).robots({ body: enc(""), tokens: [], path: "/" }), (e: unknown) => {
    assert.ok(e instanceof CaptureParserError);
    assert.equal(e.failureCause, "killed");
    return true;
  });
  await assert.rejects(new ProcessCaptureParser({ maxInputBytes: 10 }).robots({ body: enc("x".repeat(11)), tokens: [], path: "/" }), /over the 10-byte bound/);
  process.env.CAPTURE_PARSER_SECRET_PROBE = "must-not-leak";
  try {
    const v = await new ProcessCaptureParser({ script: envDump }).robots({ body: enc(""), tokens: [], path: "/" });
    assert.ok(!(v.rule ?? "").includes("CAPTURE_PARSER_SECRET_PROBE"), `the child saw ${v.rule}`);
  } finally {
    delete process.env.CAPTURE_PARSER_SECRET_PROBE;
  }
});
