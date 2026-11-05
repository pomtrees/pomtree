import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AUDIT_MAX_SPOOLS,
  DiskEgressAudit,
  EgressSpoolCorruptError,
  FileEgressAuditWriter,
  auditChainGenesis,
  auditChainNext,
  markEgressSpoolClosed,
  prepareEgressSpool,
  sealAuditChain,
  type EgressAuditEvent,
  type EgressAuditRecord,
} from "./audit.ts";

const event: EgressAuditEvent = {
  connection: "c",
  phase: "admission",
  transport: "http",
  authority: "example.test:80",
  outcome: "allowed",
  url: "http://example.test/[redacted]",
  peer: "8.8.8.8",
};
const outcome: EgressAuditEvent = { ...event, phase: "outcome", outcome: "complete", status: 200 };

function fixture(rows = 3) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-egress-chain-")));
  const identity = { sandbox: "sb", agent: "worker", host: "host", generation: 2 };
  const config = { allow: [], relay: [], hostAddresses: [], identity };
  const dirs = prepareEgressSpool(root, "sb", config);
  const writer = new FileEgressAuditWriter(dirs.logDir, identity);
  for (let i = 0; i < rows; i++) writer.append(i % 2 === 0 ? event : outcome);
  const events = join(dirs.logDir, "events.jsonl");
  return {
    root,
    identity,
    config,
    ...dirs,
    events,
    disk: new DiskEgressAudit({ root }),
    lines: () => readFileSync(events, "utf8").split("\n").filter(Boolean),
    rows: () =>
      readFileSync(events, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as EgressAuditRecord),
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
// What an attacker with the proxy's write access can do: rewrite the whole spool consistently, recomputing the chain (no secret exists).
function rewrite(f: ReturnType<typeof fixture>, edit: (rows: Omit<EgressAuditRecord, "chain">[]) => Omit<EgressAuditRecord, "chain">[]): void {
  const bare = f.rows().map(({ chain: _chain, ...r }) => r);
  writeFileSync(
    f.events,
    `${sealAuditChain("sb", edit(bare))
      .map((r) => JSON.stringify(r))
      .join("\n")}\n`,
  );
}
const corrupt = (re: RegExp) => (e: unknown) => e instanceof EgressSpoolCorruptError && re.test(e.message);

test("every row chains from the sandbox genesis and the chain is recomputable from the row text alone", () => {
  const f = fixture();
  try {
    let head = auditChainGenesis("sb");
    for (const { chain, ...rest } of f.rows()) {
      head = auditChainNext(head, rest);
      assert.equal(chain, head);
    }
    assert.notEqual(auditChainGenesis("sb"), auditChainGenesis("other"), "genesis is per sandbox, so a row cannot be moved between spools");
  } finally {
    f.clean();
  }
});

test("tamper detection: a modified, deleted, reordered or inserted row fails the read, and a restarted writer refuses the spool", async () => {
  const mutations: [string, (lines: string[]) => string[]][] = [
    ["modified (same length)", (l) => [l[0]!, l[1]!.replace("example.test", "example.tesu"), l[2]!]],
    ["deleted", (l) => [l[0]!, l[2]!]],
    ["reordered", (l) => [l[1]!, l[0]!, l[2]!]],
    ["duplicated", (l) => [l[0]!, l[1]!, l[1]!, l[2]!]],
  ];
  for (const [name, mutate] of mutations) {
    const f = fixture();
    try {
      writeFileSync(f.events, `${mutate(f.lines()).join("\n")}\n`);
      await assert.rejects(f.disk.read("sb", 0), (e) => e instanceof EgressSpoolCorruptError, name);
      assert.throws(() => new FileEgressAuditWriter(f.logDir, f.identity), /./, `${name}: the writer fails closed on a tampered spool`);
    } finally {
      f.clean();
    }
  }
});

test("a modified row is named as a chain mismatch, not as a generic failure", async () => {
  const f = fixture();
  try {
    writeFileSync(f.events, `${[f.lines()[0], f.lines()[1]!.replace("example.test", "example.tesu"), f.lines()[2]].join("\n")}\n`);
    await assert.rejects(f.disk.read("sb", 0), corrupt(/chain mismatch/));
  } finally {
    f.clean();
  }
});

test("a rewrite that re-chains consistently is caught by the journaled head, even with a forged ack receipt", async () => {
  const f = fixture();
  try {
    const journaled = f.rows()[1]!.chain; // what pomtreed journaled for row 2
    await f.disk.ack("sb", 2, journaled);
    // The attacker rewrites history behind the ack and re-chains it, then forges an ack that matches the new bytes.
    rewrite(f, (rows) => rows.map((r, i) => (i === 0 ? { ...r, authority: "evil.test:80" } : r)));
    const forged = f.rows();
    const offset = f.lines().slice(0, 2).join("\n").length + 1;
    writeFileSync(join(f.logDir, "ack.json"), JSON.stringify({ throughSequence: 2, offset, chain: forged[1]!.chain }));
    // Without the journaled head the new spool looks self-consistent; with it, the read refuses.
    assert.equal((await f.disk.read("sb", 2)).length, 1);
    await assert.rejects(f.disk.read("sb", 2, 256, journaled), corrupt(/journaled chain head/));
    await assert.rejects(f.disk.ack("sb", 3, journaled), corrupt(/journaled chain head/));
  } finally {
    f.clean();
  }
});

test("truncation behind the journaled head is detected: ack beyond the file, and a consistent forged ack on a shortened file", async () => {
  const f = fixture();
  try {
    const journaled = f.rows()[2]!.chain;
    await f.disk.ack("sb", 3, journaled);
    truncateSync(f.events, f.lines().slice(0, 2).join("\n").length + 1);
    await assert.rejects(f.disk.read("sb", 3, 256, journaled), corrupt(/corrupt egress ack/), "ack offset now lies beyond the file");
    const forged = f.rows()[1]!;
    writeFileSync(join(f.logDir, "ack.json"), JSON.stringify({ throughSequence: 2, offset: readFileSync(f.events).length, chain: forged.chain }));
    await assert.rejects(f.disk.read("sb", 3, 256, journaled), corrupt(/journaled chain head/), "the file is shorter than the journaled cursor");
  } finally {
    f.clean();
  }
});

test("a legacy spool whose rows carry no chain is corrupt (deterministic, quarantinable), never accepted", async () => {
  const f = fixture(0);
  try {
    const row = { kind: "egress", eventId: "sb:1", sequence: 1, at: 1, ...f.identity, ...event };
    writeFileSync(f.events, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    await assert.rejects(f.disk.read("sb", 0), (e) => e instanceof EgressSpoolCorruptError);
  } finally {
    f.clean();
  }
});

// --- vacuum -----------------------------------------------------------------------------------------------------------------

const DAY = 86_400_000;
async function acked(f: ReturnType<typeof fixture>): Promise<void> {
  const rows = f.rows();
  await f.disk.read("sb", 0);
  await f.disk.ack("sb", rows.length, rows[rows.length - 1]!.chain);
}

test("vacuum eligibility: an open spool, an unexpired grace and any un-acked row each keep the spool", async () => {
  const f = fixture();
  try {
    assert.equal(await f.disk.vacuumCandidate("sb", 0, Date.now()), undefined, "no closed marker: the proxy may still append");
    assert.equal(markEgressSpoolClosed(f.root, "sb", 1000), true);
    await acked(f);
    assert.equal(await f.disk.vacuumCandidate("sb", DAY, 1000 + DAY - 1), undefined, "grace not elapsed");
    // un-acked tail: only rows 1-2 acknowledged
    const g = fixture(3);
    try {
      markEgressSpoolClosed(g.root, "sb", 0);
      await g.disk.read("sb", 0);
      await g.disk.ack("sb", 2, g.rows()[1]!.chain);
      assert.equal(await g.disk.vacuumCandidate("sb", 0, DAY), undefined, "row 3 is not acknowledged");
      assert.equal(await g.disk.vacuumCandidate("sb", 0, DAY), undefined);
      assert.ok(existsSync(g.events), "nothing was removed");
    } finally {
      g.clean();
    }
  } finally {
    f.clean();
  }
});

test("vacuum removes a closed, fully acknowledged, graced spool; leaves a tombstone; the id cannot be reused; the spool stops counting", async () => {
  const f = fixture();
  try {
    markEgressSpoolClosed(f.root, "sb", 1000);
    await acked(f);
    const candidate = await f.disk.vacuumCandidate("sb", DAY, 1000 + DAY);
    assert.ok(candidate);
    assert.equal(candidate.throughSequence, 3);
    assert.equal(candidate.chain, f.rows()[2]!.chain);
    assert.equal(f.disk.vacuum(candidate, 5), true);
    assert.deepEqual(readdirSync(f.root), ["sb.vacuumed"]);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, "sb.vacuumed"), "utf8")), {
      sandbox: "sb",
      throughSequence: 3,
      chain: candidate.chain,
      vacuumedAt: 5,
    });
    assert.deepEqual(await f.disk.discover(), [], "a tombstone is not a spool and is not reported as a stray");
    assert.throws(() => prepareEgressSpool(f.root, "sb", f.config), /vacuumed/);
    for (let i = 1; i <= AUDIT_MAX_SPOOLS; i++) {
      const sandbox = `n${i}`;
      mkdirSync(join(f.root, sandbox), { mode: 0o700 }); // an empty directory counts against the cap; skips 256 fsynced prepares
    }
    assert.equal((await f.disk.discover()).length, AUDIT_MAX_SPOOLS, "the tombstone does not count against the retention cap");
  } finally {
    f.clean();
  }
});

test("vacuum refuses a spool that changed after the candidate was taken: grown, reopened or re-acked", async () => {
  const f = fixture();
  try {
    markEgressSpoolClosed(f.root, "sb", 0);
    await acked(f);
    const candidate = (await f.disk.vacuumCandidate("sb", 0, 1))!;
    new FileEgressAuditWriter(f.logDir, f.identity).append(event); // a row arrives after the candidate
    assert.equal(f.disk.vacuum(candidate), false);
    assert.ok(existsSync(f.events));
    assert.equal(await f.disk.vacuumCandidate("sb", 0, 1), undefined, "the new row is not acknowledged");
    await f.disk.read("sb", 3);
    await f.disk.ack("sb", 4, f.rows()[3]!.chain);
    const second = (await f.disk.vacuumCandidate("sb", 0, 1))!;
    assert.ok(second);
    // a start reuses the spool: it is no longer closed
    prepareEgressSpool(f.root, "sb", f.config);
    assert.equal(f.disk.vacuum(second), false);
    assert.equal(await f.disk.vacuumCandidate("sb", 0, 1), undefined);
    assert.ok(existsSync(f.events));
  } finally {
    f.clean();
  }
});

test("vacuum never deletes a tampered spool: the candidate scan throws and the files stay for forensics", async () => {
  const f = fixture();
  try {
    markEgressSpoolClosed(f.root, "sb", 0);
    await acked(f);
    writeFileSync(f.events, readFileSync(f.events, "utf8").replace("example.test", "example.tesu"));
    await assert.rejects(f.disk.vacuumCandidate("sb", 0, 1), (e) => e instanceof EgressSpoolCorruptError);
    assert.ok(existsSync(f.events));
    assert.equal(readdirSync(f.root).includes("sb.vacuumed"), false);
  } finally {
    f.clean();
  }
});

test("vacuum never deletes a spool whose acknowledgement lies about its content", async () => {
  const f = fixture();
  try {
    markEgressSpoolClosed(f.root, "sb", 0);
    await acked(f);
    const size = readFileSync(f.events).length;
    writeFileSync(join(f.logDir, "ack.json"), JSON.stringify({ throughSequence: 3, offset: size, chain: "0".repeat(64) }));
    await assert.rejects(f.disk.vacuumCandidate("sb", 0, 1), corrupt(/acknowledgement/));
    assert.ok(existsSync(f.events));
  } finally {
    f.clean();
  }
});

test("crash windows: a tombstone left before the rename resumes; a half-removed spool is reaped; marking a missing spool is a no-op", async () => {
  const f = fixture();
  try {
    assert.equal(markEgressSpoolClosed(f.root, "nope", 0), false);
    markEgressSpoolClosed(f.root, "sb", 0);
    await acked(f);
    const candidate = (await f.disk.vacuumCandidate("sb", 0, 1))!;
    // crashed after the tombstone, before the rename: the spool is still there and still vacuumable
    writeFileSync(join(f.root, "sb.vacuumed"), JSON.stringify({ sandbox: "sb", throughSequence: 3, chain: candidate.chain, vacuumedAt: 1 }), { mode: 0o600 });
    assert.deepEqual(await f.disk.discover(), ["sb"]);
    assert.equal(f.disk.vacuum(candidate, 2), true);
    // crashed after the rename, before the removal
    mkdirSync(join(f.root, "x.vacuuming", "log"), { recursive: true, mode: 0o700 });
    writeFileSync(join(f.root, "x.vacuuming", "log", "events.jsonl"), "partial");
    assert.deepEqual(await f.disk.discover(), []);
    assert.equal(f.disk.reapVacuumed(), 1);
    assert.deepEqual(readdirSync(f.root).sort(), ["sb.vacuumed"]);
  } finally {
    f.clean();
  }
});

test("marking closed when no spool root exists is a quiet no-op (a sandbox that never audited), but an unsafe root still throws", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-egress-noroot-")));
  try {
    assert.equal(markEgressSpoolClosed(join(root, "never-created"), "sb", 0), false);
    writeFileSync(join(root, "file-root"), "x", { mode: 0o600 });
    assert.throws(() => markEgressSpoolClosed(join(root, "file-root"), "sb", 0), /unsafe egress spool path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed or oversized closed.json is a corrupt marker (EgressSpoolCorruptError), never a plain SyntaxError", async () => {
  for (const bad of ["{not json", "x".repeat(300), JSON.stringify({ closedAt: -1 }), "null"]) {
    const f = fixture();
    try {
      writeFileSync(join(f.root, "sb", "closed.json"), bad, { mode: 0o600 });
      await assert.rejects(f.disk.vacuumCandidate("sb", 0, 1), (e) => e instanceof EgressSpoolCorruptError, bad.slice(0, 12));
      assert.ok(existsSync(f.events), "the spool is retained");
    } finally {
      f.clean();
    }
  }
});

test("retention(): counts spools and names the never-closed ones; the cap refusal says what to do and how", () => {
  const f = fixture();
  try {
    markEgressSpoolClosed(f.root, "sb", 0);
    for (let i = 1; i < AUDIT_MAX_SPOOLS; i++) {
      const sandbox = `n${i}`;
      mkdirSync(join(f.root, sandbox), { mode: 0o700 }); // an empty directory counts against the cap; skips 256 fsynced prepares
    }
    const r = f.disk.retention();
    assert.deepEqual({ spools: r.spools, max: r.max, closed: r.closed }, { spools: AUDIT_MAX_SPOOLS, max: AUDIT_MAX_SPOOLS, closed: 1 });
    assert.equal(r.open.length, AUDIT_MAX_SPOOLS - 1);
    assert.ok(r.open.includes("n1") && !r.open.includes("sb"));
    assert.throws(
      () => prepareEgressSpool(f.root, "extra", { ...f.config, identity: { ...f.identity, sandbox: "extra" } }),
      new RegExp(
        `retention limit \\(${AUDIT_MAX_SPOOLS} spools\\); ${AUDIT_MAX_SPOOLS - 1} never closed \\(crashed, or quarantined: n1 .*\\) and 1 closed.*\\.vacuumed`,
      ),
    );
    assert.equal(new DiskEgressAudit({ root: join(f.root, "missing") }).retention().spools, 0, "no root: nothing retained");
  } finally {
    f.clean();
  }
});

test("operator procedure: moving a never-closed spool to <id>.vacuumed frees its cap slot, keeps the evidence and blocks id reuse", async () => {
  const f = fixture();
  try {
    prepareEgressSpool(f.root, "n1", { ...f.config, identity: { ...f.identity, sandbox: "n1" } }); // a real spool: its evidence is checked below
    for (let i = 2; i < AUDIT_MAX_SPOOLS; i++) {
      const sandbox = `n${i}`;
      mkdirSync(join(f.root, sandbox), { mode: 0o700 }); // an empty directory counts against the cap; skips 256 fsynced prepares
    }
    const extra = { ...f.config, identity: { ...f.identity, sandbox: "extra" } };
    assert.throws(() => prepareEgressSpool(f.root, "extra", extra), /retention limit/);
    renameSync(join(f.root, "n1"), join(f.root, "n1.vacuumed"));
    assert.equal(f.disk.retention().spools, AUDIT_MAX_SPOOLS - 1);
    assert.ok(!(await f.disk.discover()).includes("n1"), "no longer ingested");
    prepareEgressSpool(f.root, "extra", extra);
    assert.ok(existsSync(join(f.root, "n1.vacuumed", "config")), "evidence kept");
    assert.throws(() => prepareEgressSpool(f.root, "n1", { ...f.config, identity: { ...f.identity, sandbox: "n1" } }), /vacuumed/);
  } finally {
    f.clean();
  }
});
