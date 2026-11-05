import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  type AuditRow,
  type Check,
  type DebitRow,
  LOOPBACK_CDP,
  evaluateAudit,
  evaluateCost,
  evaluateSandboxStop,
  evaluateSteps,
  followsModelCall,
  labelRelay,
  recomputeReports,
  reportExtension,
  reportFilePlan,
  sanitizeJournal,
} from "./browser-live-audit.ts";

// Fixtures are synthetic: no live run, no network. Each failing case flips exactly one input so the named check is the one under test.

function named(checks: Check[], name: string): Check {
  const c = checks.find((x) => x.name === name);
  assert.ok(c, `no check named "${name}"`);
  return c;
}

const ARTICLE = "https://www.rfc-editor.org/rfc/rfc9110";
const RELAY = "host.docker.internal:4000";

function row(over: Partial<AuditRow> & { authority: string; outcome: string }): AuditRow {
  return { agent: "agent-1", host: "host-1", generation: 3, phase: "request", ...over };
}

function baseAudit(over: { rows?: AuditRow[]; extraAuthorities?: string[]; hostConfig?: { NetworkMode?: string; CapDrop?: string[] | null } } = {}) {
  return {
    rows: over.rows ?? [
      row({ authority: "www.rfc-editor.org:443", outcome: "allowed" }),
      row({ authority: "cdn.rfc-editor.org:443", outcome: "allowed" }),
      row({ authority: RELAY, outcome: "connected" }),
      row({ authority: "update.googleapis.com:443", outcome: "complete" }),
      row({ authority: LOOPBACK_CDP, outcome: "denied" }),
    ],
    agent: "agent-1",
    host: "host-1",
    generation: 3,
    articleUrl: ARTICLE,
    relayAuthorities: [RELAY],
    extraAuthorities: over.extraAuthorities,
    hostConfig: over.hostConfig ?? { NetworkMode: "none", CapDrop: ["ALL"] },
  };
}

test("audit: clean run passes every check", () => {
  const r = evaluateAudit(baseAudit());
  assert.equal(r.ok, true);
  assert.equal(r.checks.length, 7);
  assert.ok(r.checks.every((c) => c.ok));
});

test("audit: no rows fails rows-present", () => {
  const r = evaluateAudit(baseAudit({ rows: [] }));
  assert.equal(r.ok, false);
  assert.equal(named(r.checks, "rows present").ok, false);
});

test("audit: row from another agent fails the identity check", () => {
  const rows = [row({ authority: "www.rfc-editor.org:443", outcome: "allowed", agent: "agent-2" })];
  const r = evaluateAudit(baseAudit({ rows }));
  assert.equal(named(r.checks, "rows bound to this run").ok, false);
  assert.match(named(r.checks, "rows bound to this run").detail, /agent-2/);
});

test("audit: row from another generation fails the identity check", () => {
  const rows = [row({ authority: "www.rfc-editor.org:443", outcome: "allowed", generation: 2 })];
  assert.equal(named(evaluateAudit(baseAudit({ rows })).checks, "rows bound to this run").ok, false);
});

test("audit: metadata authority fails the allowed-set check and is named", () => {
  const rows = [row({ authority: "www.rfc-editor.org:443", outcome: "allowed" }), row({ authority: "169.254.169.254:80", outcome: "connected" })];
  const c = named(evaluateAudit(baseAudit({ rows })).checks, "authorities within allowed set");
  assert.equal(c.ok, false);
  assert.match(c.detail, /169\.254\.169\.254:80/);
});

test("audit: lookalike domain fails the allowed-set check", () => {
  const rows = [row({ authority: "www.rfc-editor.org:443", outcome: "allowed" }), row({ authority: "rfc-editor.org.attacker.test:443", outcome: "connected" })];
  const r = evaluateAudit(baseAudit({ rows }));
  assert.equal(named(r.checks, "authorities within allowed set").ok, false);
});

test("audit: extra authority is accepted when listed", () => {
  const rows = [row({ authority: "www.rfc-editor.org:443", outcome: "allowed" }), row({ authority: "telemetry.example.org:443", outcome: "connected" })];
  assert.equal(named(evaluateAudit(baseAudit({ rows, extraAuthorities: ["telemetry.example.org:443"] })).checks, "authorities within allowed set").ok, true);
});

test("audit: denied non-CDP flow fails the denials check", () => {
  const rows = [row({ authority: "www.rfc-editor.org:443", outcome: "allowed" }), row({ authority: "203.0.113.9:443", outcome: "denied" })];
  const c = named(evaluateAudit(baseAudit({ rows })).checks, "denials only for loopback CDP");
  assert.equal(c.ok, false);
  assert.match(c.detail, /203\.0\.113\.9:443/);
});

test("audit: denied loopback CDP probe is tolerated", () => {
  const rows = [row({ authority: "www.rfc-editor.org:443", outcome: "allowed" }), row({ authority: LOOPBACK_CDP, outcome: "denied" })];
  assert.equal(named(evaluateAudit(baseAudit({ rows })).checks, "denials only for loopback CDP").ok, true);
});

test("audit: a denied host.docker.internal authority fails the denials check unless the run declares it refused", () => {
  const local = "host.docker.internal:4002";
  const rows = [row({ authority: local, outcome: "denied" }), row({ authority: LOOPBACK_CDP, outcome: "denied" })];
  const plain = evaluateAudit(baseAudit({ rows })).checks;
  assert.equal(named(plain, "denials only for loopback CDP").ok, false);
  assert.match(named(plain, "denials only for loopback CDP").detail, /host\.docker\.internal:4002/);
  const negative = evaluateAudit({ ...baseAudit({ rows }), articleUrl: `http://${local}/article`, refusedAuthorities: [local] }).checks;
  assert.equal(named(negative, "denials only for loopback CDP").ok, true);
  assert.equal(named(negative, "article authority refused").ok, true);
  assert.equal(
    negative.some((c) => c.name === "article domain reached"),
    false,
  );
});

test("audit: a negative run with no denied row for the refused authority is vacuous and fails", () => {
  const local = "host.docker.internal:4002";
  const rows = [row({ authority: local, outcome: "allowed" })];
  const checks = evaluateAudit({ ...baseAudit({ rows }), articleUrl: `http://${local}/article`, refusedAuthorities: [local] }).checks;
  assert.equal(named(checks, "article authority refused").ok, false);
});

test("audit: no allowed article-domain flow fails the reached check", () => {
  const rows = [row({ authority: "www.rfc-editor.org:443", outcome: "connected" }), row({ authority: RELAY, outcome: "allowed" })];
  assert.equal(named(evaluateAudit(baseAudit({ rows })).checks, "article domain reached").ok, false);
});

test("audit: NetworkMode bridge fails", () => {
  const r = evaluateAudit(baseAudit({ hostConfig: { NetworkMode: "bridge", CapDrop: ["ALL"] } }));
  assert.equal(named(r.checks, "network mode is none").ok, false);
  assert.equal(r.ok, false);
});

test("audit: empty CapDrop fails", () => {
  const c = named(evaluateAudit(baseAudit({ hostConfig: { NetworkMode: "none", CapDrop: [] } })).checks, "capabilities dropped");
  assert.equal(c.ok, false);
  assert.equal(c.detail, "CapDrop=[]");
});

test("cost: consistent ledger passes, rows in any order", () => {
  const debitRows: DebitRow[] = [
    { request_id: "r3", status: "released", charged_micros: null, maximum_micros: 50, created_at: 3 },
    { request_id: "r2", status: "settled", charged_micros: 200, maximum_micros: 250, created_at: 2 },
    { request_id: "r1", status: "settled", charged_micros: 100, maximum_micros: 150, created_at: 1 },
  ];
  const r = evaluateCost({ capMicros: 1000, spentMicros: 300, debitRows, piCostsMicros: [100, 200] });
  assert.equal(r.ok, true);
  assert.equal(r.checks.length, 4);
});

function costRows(): DebitRow[] {
  return [
    { request_id: "r1", status: "settled", charged_micros: 100, maximum_micros: 150, created_at: 1 },
    { request_id: "r2", status: "settled", charged_micros: 200, maximum_micros: 250, created_at: 2 },
  ];
}

test("cost: spend over cap fails", () => {
  const c = named(evaluateCost({ capMicros: 250, spentMicros: 300, debitRows: costRows(), piCostsMicros: [100, 200] }).checks, "spend within cap");
  assert.equal(c.ok, false);
  assert.match(c.detail, /cap 250/);
});

test("cost: recomputed total differing from reported spend fails", () => {
  const c = named(evaluateCost({ capMicros: 1000, spentMicros: 301, debitRows: costRows(), piCostsMicros: [100, 200] }).checks, "spend equals settled debits");
  assert.equal(c.ok, false);
  assert.match(c.detail, /recomputed 300/);
});

test("cost: settled row without a charge fails the total check", () => {
  const rows: DebitRow[] = [...costRows(), { request_id: "r3", status: "settled", charged_micros: null, maximum_micros: 50, created_at: 3 }];
  assert.equal(
    named(evaluateCost({ capMicros: 1000, spentMicros: 300, debitRows: rows, piCostsMicros: [100, 200] }).checks, "spend equals settled debits").ok,
    false,
  );
});

test("cost: per-call mismatch by 2 micros fails", () => {
  const c = named(evaluateCost({ capMicros: 1000, spentMicros: 300, debitRows: costRows(), piCostsMicros: [102, 200] }).checks, "per-call cost matches Pi");
  assert.equal(c.ok, false);
  assert.match(c.detail, /100\/102/);
});

test("cost: per-call mismatch by 1 micro passes", () => {
  const c = named(evaluateCost({ capMicros: 1000, spentMicros: 300, debitRows: costRows(), piCostsMicros: [101, 200] }).checks, "per-call cost matches Pi");
  assert.equal(c.ok, true);
});

test("cost: unequal call counts fail", () => {
  const c = named(evaluateCost({ capMicros: 1000, spentMicros: 300, debitRows: costRows(), piCostsMicros: [100, 200, 50] }).checks, "per-call cost matches Pi");
  assert.equal(c.ok, false);
  assert.match(c.detail, /2 charged call\(s\) vs 3 Pi/);
});

test("cost: lingering reserved row fails the unresolved check", () => {
  const rows: DebitRow[] = [...costRows(), { request_id: "r3", status: "reserved", charged_micros: null, maximum_micros: 50, created_at: 3 }];
  const c = named(evaluateCost({ capMicros: 1000, spentMicros: 300, debitRows: rows, piCostsMicros: [100, 200] }).checks, "no unresolved debit rows");
  assert.equal(c.ok, false);
  assert.match(c.detail, /reserved/);
});

test("steps: capture mode with exactly browser_capture passes", () => {
  assert.equal(evaluateSteps({ mode: "capture", toolNames: ["browser_capture"], maxSteps: 1 }).ok, true);
});

test("steps: capture mode with two capture calls fails", () => {
  const r = evaluateSteps({ mode: "capture", toolNames: ["browser_capture", "browser_capture"], maxSteps: 1 });
  assert.equal(r.ok, false);
});

test("steps: browse mode within bound passes with or without browser_capture", () => {
  assert.equal(evaluateSteps({ mode: "browse", toolNames: ["navigate", "browser_capture"], maxSteps: 5 }).ok, true);
  assert.equal(evaluateSteps({ mode: "browse", toolNames: ["navigate"], maxSteps: 5 }).ok, true);
});

test("steps: browse mode with zero tools fails", () => {
  const c = named(evaluateSteps({ mode: "browse", toolNames: [], maxSteps: 5 }).checks, "browse step count within bound");
  assert.equal(c.ok, false);
});

test("steps: browse mode over maxSteps fails", () => {
  assert.equal(named(evaluateSteps({ mode: "browse", toolNames: ["a", "b", "c"], maxSteps: 2 }).checks, "browse step count within bound").ok, false);
});

test("steps: browse mode with two capture calls fails", () => {
  const c = named(
    evaluateSteps({ mode: "browse", toolNames: ["browser_capture", "navigate", "browser_capture"], maxSteps: 5 }).checks,
    "browser_capture at most once",
  );
  assert.equal(c.ok, false);
});

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

test("reportExtension maps the capture report names to file extensions", () => {
  assert.equal(reportExtension("browser-main-response"), "html");
  assert.equal(reportExtension("browser-rendered-dom"), "html");
  assert.equal(reportExtension("browser-dom-text"), "txt");
  assert.equal(reportExtension("browser-screenshot"), "png");
  assert.equal(reportExtension("browser-screenshot-2"), "png");
  assert.equal(reportExtension("browser-navigation"), "json");
  assert.equal(reportExtension("browser-action-3"), "json");
});

test("reportExtension throws on an unknown report name instead of guessing an extension", () => {
  for (const name of ["other", "", "browser-screenshot-", "browser-screenshot-x", "browser-action", "browser-navigation-2"])
    assert.throws(() => reportExtension(name), /no file extension/, JSON.stringify(name));
});

test("reportFilePlan stores an unknown or unnamed report as .bin with a warning and keeps every other file", () => {
  const names = new Map([
    ["r1", "browser-main-response"],
    ["r2", "agent-made-up"],
    ["r4", "browser-screenshot-2"],
  ]);
  const plan = reportFilePlan(["r1", "r2", "r3", "r4"], names);
  assert.deepEqual(
    [...plan.file],
    [
      ["r1", "reports/r1.html"],
      ["r2", "reports/r2.bin"],
      ["r3", "reports/r3.bin"],
      ["r4", "reports/r4.png"],
    ],
  );
  assert.deepEqual(
    plan.warnings.map((w) => w.name),
    ["unknown-report-name", "unknown-report-name"],
  );
  assert.match(plan.warnings[0]!.detail, /r2.*agent-made-up/);
  assert.deepEqual(reportFilePlan(["r1"], names).warnings, []);
});

test("recomputeReports hashes all five saved bodies and names every mismatch or missing one", () => {
  const bodies: Record<string, Buffer> = {};
  const receipt: Record<string, { id: string; sha256: string }> = {};
  for (const [i, k] of ["rawBodyReport", "domReport", "textReport", "screenshotReport", "navigationReport"].entries()) {
    bodies[`r${i}`] = Buffer.from(`body ${i}`);
    receipt[k] = { id: `r${i}`, sha256: sha(bodies[`r${i}`]!) };
  }
  const ok = recomputeReports(receipt, (id) => bodies[id]);
  assert.equal(ok.name, "reports-recompute");
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /5 of 5/);
  const bad = recomputeReports(receipt, (id) => (id === "r1" ? Buffer.from("tampered") : id === "r2" ? undefined : bodies[id]));
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /domReport/);
  assert.match(bad.detail, /textReport/);
  assert.equal(recomputeReports({}, () => undefined).ok, false);
});

test("labelRelay marks model and report relay rows by exact authority and leaves others null", () => {
  const relays = { model: "host.docker.internal:4000", report: "host.docker.internal:4001" };
  const rows = [
    row({ authority: "host.docker.internal:4000", outcome: "connected" }),
    row({ authority: "host.docker.internal:4001", outcome: "allowed" }),
    row({ authority: "host.docker.internal:4002", outcome: "allowed" }),
    row({ authority: "www.rfc-editor.org:443", outcome: "allowed" }),
  ];
  assert.deepEqual(
    labelRelay(rows, relays).map((r) => r.relay),
    ["model", "report", null, null],
  );
  assert.equal(labelRelay(rows, relays)[0]?.authority, "host.docker.internal:4000");
});

test("followsModelCall maps a turn to the settlement requestId only when turns and settlements line up", () => {
  assert.equal(followsModelCall(1, ["a", "b"], 2), "b");
  assert.equal(followsModelCall(null, ["a", "b"], 2), null);
  assert.equal(followsModelCall(1, ["a", "b"], 3), null);
  assert.equal(followsModelCall(5, ["a", "b"], 2), null);
});

test("sanitizeJournal keeps structured fields, truncates long strings, drops credential keys and scrubs secret values", () => {
  const long = "x".repeat(3000);
  const out = sanitizeJournal(
    [
      { seq: 1, ts: 5, agent: "a", host: "h", generation: 1, payload: { kind: "ext.pomtreed.model_settlement", tokensIn: 3, requestId: "r1" } },
      { seq: 2, ts: 6, agent: "a", host: "h", generation: 1, payload: { kind: "message_received", body: long, token: "abc", note: "has SENTINEL-KEY inside" } },
    ],
    ["SENTINEL-KEY"],
  );
  assert.deepEqual(out[0]?.payload, { kind: "ext.pomtreed.model_settlement", tokensIn: 3, requestId: "r1" });
  const p = out[1]?.payload as unknown as Record<string, string>;
  assert.match(p.body!, /^x{2048}\[truncated 952 chars\]$/);
  assert.equal(p.token, "[redacted]");
  assert.equal(p.note, "has [redacted] inside");
  assert.ok(!JSON.stringify(out).includes("SENTINEL-KEY"));
});

test("evaluateSandboxStop warns, never fails, unless the exited entry is clean and expected", () => {
  const exited = (d: object) => [{ payload: { kind: "ext.pomtreed.sandbox", phase: "exited", sandbox: "s", ...d } }];
  const clean = evaluateSandboxStop(exited({ exitCode: 0, expected: true, observedExitCode: 143 }));
  assert.equal(clean.name, "sandbox-clean-stop");
  assert.deepEqual([clean.ok, clean.warning], [true, undefined]);
  const dirty = evaluateSandboxStop(exited({ exitCode: 137 }));
  assert.deepEqual([dirty.ok, dirty.warning], [true, true]);
  assert.match(dirty.detail, /exitCode=137/);
  const none = evaluateSandboxStop([{ payload: { kind: "ext.pomtreed.sandbox", phase: "started" } }]);
  assert.deepEqual([none.ok, none.warning], [true, true]);
  assert.match(none.detail, /no .*exited/);
  const last = evaluateSandboxStop([...exited({ exitCode: 1 }), ...exited({ exitCode: 0, expected: true })]);
  assert.equal(last.warning, undefined);
});

test("steps: capture_finish is not a browsing step; a bash, read, write or edit call fails the run", () => {
  assert.equal(evaluateSteps({ mode: "capture", toolNames: ["browser_capture", "capture_finish"], maxSteps: 1 }).ok, true);
  assert.equal(evaluateSteps({ mode: "browse", toolNames: ["navigate", "capture_finish"], maxSteps: 1 }).ok, true);
  for (const tool of ["bash", "read", "write", "edit"]) {
    const r = evaluateSteps({ mode: "browse", toolNames: ["navigate", tool], maxSteps: 5 });
    assert.equal(r.ok, false, tool);
    assert.equal(named(r.checks, "no exec or write tool called").ok, false);
  }
});

test("steps: interactive mode within bound with only the profile's tools passes; an outside tool, browser_capture or over-budget fails", () => {
  const run = ["browser_navigate", "browser_snapshot", "browser_take_screenshot", "capture_finish"];
  assert.equal(evaluateSteps({ mode: "interactive", toolNames: run, maxSteps: 4 }).ok, true);
  assert.equal(named(evaluateSteps({ mode: "interactive", toolNames: run, maxSteps: 3 }).checks, "interactive step count within bound").ok, false);
  for (const outside of ["browser_capture", "browser_evaluate", "bash"]) {
    const r = evaluateSteps({ mode: "interactive", toolNames: [...run, outside], maxSteps: 16 });
    assert.equal(named(r.checks, "interactive calls only the profile's tools").ok, false, outside);
  }
  assert.equal(named(evaluateSteps({ mode: "interactive", toolNames: [], maxSteps: 4 }).checks, "interactive step count within bound").ok, false);
});
