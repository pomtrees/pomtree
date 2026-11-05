import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIT_MAX_BYTES,
  AUDIT_MAX_SPOOLS,
  AUDIT_ROOT_MAX_BYTES,
  FileEgressAuditWriter,
  markEgressSpoolClosed,
  prepareEgressSpool,
  type EgressAuditEvent,
  type EgressProxyConfig,
} from "./audit.ts";

const row: EgressAuditEvent = {
  connection: "0b9d3c1e-5f0a-4a52-9c1d-6b1f1d7f6a11",
  phase: "outcome",
  transport: "connect",
  authority: "api.example.test:443",
  outcome: "complete",
  peer: "93.184.216.34",
  peers: ["93.184.216.34"],
  trafficClass: undefined,
  admittedAt: "2026-10-24T12:00:00.000Z",
  durationMs: 1234,
  bytesIn: 51234,
  bytesOut: 2048,
};

function rootFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-audit-cap-")));
  const config = (sandbox: string): EgressProxyConfig => ({
    allow: [],
    relay: [],
    hostAddresses: [],
    identity: { sandbox, agent: "worker", host: "host", generation: 1 },
  });
  return { root, config, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test("the root disk bound is the spool count times the per-spool byte cap", () => {
  assert.equal(AUDIT_ROOT_MAX_BYTES, AUDIT_MAX_SPOOLS * AUDIT_MAX_BYTES);
  assert.equal(AUDIT_ROOT_MAX_BYTES, 2 * 1024 ** 3);
});

test("a typical row is a few hundred bytes, so a spool holds thousands of rows under AUDIT_MAX_BYTES", () => {
  const f = rootFixture();
  try {
    const { logDir } = prepareEgressSpool(f.root, "sized", f.config("sized"));
    const writer = new FileEgressAuditWriter(logDir, f.config("sized").identity!);
    writer.append({ ...row, phase: "admission", outcome: "allowed" });
    writer.append(row);
    const perRow = readFileSync(join(logDir, "events.jsonl")).length / 2;
    assert.ok(perRow > 300 && perRow < 600, `measured ${perRow} bytes per row (the audit.ts sizing comment says about 400)`);
  } finally {
    f.clean();
  }
});

test("64 sequential reruns on one root are never refused without a vacuum (the old 16-spool cap refused the 17th)", () => {
  const f = rootFixture();
  try {
    for (let i = 0; i < 64; i++) {
      const sandbox = `rerun-${i}`;
      const config = f.config(sandbox);
      const { logDir } = prepareEgressSpool(f.root, sandbox, config);
      new FileEgressAuditWriter(logDir, config.identity!).append(row);
      assert.equal(markEgressSpoolClosed(f.root, sandbox), true);
    }
  } finally {
    f.clean();
  }
});

test("the root still refuses a new spool at AUDIT_MAX_SPOOLS, naming the cap and the operator action", () => {
  const f = rootFixture();
  try {
    prepareEgressSpool(f.root, "s0", f.config("s0"));
    for (let i = 1; i < AUDIT_MAX_SPOOLS; i++) mkdirSync(join(f.root, `s${i}`), { mode: 0o700 }); // empty directories count against the cap
    assert.throws(
      () => prepareEgressSpool(f.root, "over", f.config("over")),
      new RegExp(`retention limit \\(${AUDIT_MAX_SPOOLS} spools\\); ${AUDIT_MAX_SPOOLS} never closed.*only vacuumed once closed.*\\.vacuumed`),
    );
    // An existing spool is still reusable at the cap (a restart of the same sandbox key is not a new spool).
    assert.doesNotThrow(() => prepareEgressSpool(f.root, "s0", f.config("s0")));
  } finally {
    f.clean();
  }
});
