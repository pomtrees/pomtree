import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskEgressAudit, FileEgressAuditWriter, prepareEgressSpool, type EgressAuditEvent } from "./audit.ts";

const event: EgressAuditEvent = {
  connection: "c",
  phase: "admission",
  transport: "http",
  authority: "example.test:80",
  outcome: "allowed",
  url: "http://example.test/[redacted]",
  peer: "8.8.8.8",
};
const isRoot = process.getuid?.() === 0;
const rootSkip = isRoot && "root bypasses directory permissions";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-egress-publication-")));
  const identity = { sandbox: "sb", agent: "worker", host: "host", generation: 2 };
  const config = { allow: [], relay: [], hostAddresses: [], identity };
  const dirs = prepareEgressSpool(root, "sb", config);
  return { root, identity, config, ...dirs, disk: new DiskEgressAudit({ root }), clean: () => rmSync(root, { recursive: true, force: true }) };
}

// Creates an empty sandbox spool skeleton (private config dir) without publishing a config file.
function emptySpool(root: string, sandbox: string): string {
  const configDir = join(root, sandbox, "config");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  return configDir;
}

test("publication race: a link collision with a non-matching entry fails closed and keeps its pending file", () => {
  const f = fixture();
  try {
    const configDir = emptySpool(f.root, "race");
    const winner = join(configDir, "config.json");
    const outside = join(f.root, "nowhere");
    // existsSync() follows symlinks, so a dangling link looks absent, yet linkSync() collides with it (EEXIST).
    symlinkSync(outside, winner);
    assert.throws(
      () => prepareEgressSpool(f.root, "race", { ...f.config, identity: { ...f.identity, sandbox: "race" } }),
      /publication failed; pending evidence retained/,
    );
    const pending = readdirSync(configDir).filter((n) => n.startsWith("config.pending-"));
    assert.equal(pending.length, 1, "our fully written pending file is retained for operator recovery");
    assert.equal(lstatSync(winner).isSymbolicLink(), true, "the colliding entry is neither followed nor replaced");
    assert.equal(existsSync(outside), false, "nothing was created through the link");
  } finally {
    f.clean();
  }
});

test("publication failure before the pending file exists leaves no partial state; a retry after restoring permissions succeeds", { skip: rootSkip }, () => {
  const f = fixture();
  try {
    const configDir = emptySpool(f.root, "fresh");
    const config = { ...f.config, identity: { ...f.identity, sandbox: "fresh" } };
    chmodSync(configDir, 0o500);
    try {
      assert.throws(() => prepareEgressSpool(f.root, "fresh", config), /temporary publication failed/);
      assert.deepEqual(readdirSync(configDir), [], "no pending or published config remains after the failed publication");
    } finally {
      chmodSync(configDir, 0o700);
    }
    prepareEgressSpool(f.root, "fresh", config);
    assert.deepEqual(readdirSync(configDir), ["config.json"]);
    assert.equal(readFileSync(join(configDir, "config.json"), "utf8"), JSON.stringify(config));
  } finally {
    f.clean();
  }
});

test("interrupted publication after the link but before pending cleanup is recovered on retry", () => {
  const f = fixture();
  try {
    // Simulates a crash between linkSync(pending, file) and unlinkSync(pending): both names share one inode.
    linkSync(join(f.configDir, "config.json"), join(f.configDir, "config.pending-crashed"));
    prepareEgressSpool(f.root, "sb", f.config);
    assert.deepEqual(readdirSync(f.configDir), ["config.json"], "the retry removes the pending link to its own publication");
    assert.equal(lstatSync(join(f.configDir, "config.json")).nlink, 1);
  } finally {
    f.clean();
  }
});

test("corrupt spool records are rejected by read, ack and writer re-open; none is returned as a valid row", async () => {
  const f = fixture();
  try {
    const path = join(f.logDir, "events.jsonl");
    new FileEgressAuditWriter(f.logDir, f.identity).append(event);
    const good = JSON.parse(readFileSync(path, "utf8").trim()) as Record<string, unknown>;
    const line = (r: object) => `${JSON.stringify(r)}\n`;
    const cases: [string, string, RegExp][] = [
      ["bad JSON", "{not json\n", /invalid egress audit record JSON/],
      ["array", "[]\n", /invalid egress audit record JSON/],
      ["null", "null\n", /invalid egress audit record JSON/],
      ["wrong kind", line({ ...good, kind: "other" }), /identity\/sequence mismatch/],
      ["sequence gap", line({ ...good, sequence: 2, eventId: "sb:2" }), /identity\/sequence mismatch/],
      ["foreign sandbox", line({ ...good, sandbox: "other" }), /identity\/sequence mismatch/],
      ["non-numeric time", line({ ...good, at: "now" }), /identity\/sequence mismatch/],
      ["unknown key", line({ ...good, extra: 1 }), /invalid egress metadata/],
      ["userinfo in authority", line({ ...good, authority: "user@host:80" }), /invalid egress metadata/],
      ["unsafe URL", line({ ...good, url: "http://example.test/secret?q=1" }), /unsafe egress audit URL/],
    ];
    for (const [name, body, expected] of cases) {
      writeFileSync(path, body);
      await assert.rejects(f.disk.read("sb", 0), expected, `read: ${name}`);
      await assert.rejects(f.disk.ack("sb", 1), expected, `ack: ${name}`);
      assert.throws(() => new FileEgressAuditWriter(f.logDir, f.identity), expected, `writer re-open: ${name}`);
    }
    assert.equal(existsSync(join(f.logDir, "ack.json")), false, "no ack is recorded over a corrupt spool");
  } finally {
    f.clean();
  }
});

test("a successful ack leaves no temp file in the log directory", async () => {
  const f = fixture();
  try {
    const writer = new FileEgressAuditWriter(f.logDir, f.identity);
    writer.append(event);
    writer.append({ ...event, phase: "outcome", outcome: "complete" });
    await f.disk.ack("sb", 1);
    assert.deepEqual(readdirSync(f.logDir).sort(), ["ack.json", "events.jsonl"]);
    assert.deepEqual(JSON.parse(readFileSync(join(f.logDir, "ack.json"), "utf8")), {
      throughSequence: 1,
      offset: readFileSync(join(f.logDir, "events.jsonl"), "utf8").indexOf("\n") + 1,
      chain: (JSON.parse(readFileSync(join(f.logDir, "events.jsonl"), "utf8").split("\n")[0]!) as { chain: string }).chain,
    });
  } finally {
    f.clean();
  }
});

test("a temp file left by an interrupted ack is replaced and removed by the next ack", async () => {
  const f = fixture();
  try {
    new FileEgressAuditWriter(f.logDir, f.identity).append(event);
    writeFileSync(join(f.logDir, "ack.pending"), "stale-receipt", { mode: 0o600 });
    await f.disk.ack("sb", 1);
    assert.deepEqual(readdirSync(f.logDir).sort(), ["ack.json", "events.jsonl"]);
    assert.deepEqual(JSON.parse(readFileSync(join(f.logDir, "ack.json"), "utf8")), {
      throughSequence: 1,
      offset: readFileSync(join(f.logDir, "events.jsonl")).length,
      chain: (JSON.parse(readFileSync(join(f.logDir, "events.jsonl"), "utf8").split("\n")[0]!) as { chain: string }).chain,
    });
  } finally {
    f.clean();
  }
});

test("a symlinked ack temp entry is rejected, never followed, and its target is untouched", async () => {
  const f = fixture();
  try {
    new FileEgressAuditWriter(f.logDir, f.identity).append(event);
    const outside = join(f.root, "outside-target");
    writeFileSync(outside, "keep", { mode: 0o600 });
    symlinkSync(outside, join(f.logDir, "ack.pending"));
    await assert.rejects(f.disk.ack("sb", 1), /unsafe egress spool path/);
    assert.equal(readFileSync(outside, "utf8"), "keep");
    assert.equal(lstatSync(join(f.logDir, "ack.pending")).isSymbolicLink(), true);
    assert.equal(existsSync(join(f.logDir, "ack.json")), false);
  } finally {
    f.clean();
  }
});

test("a failed ack leaves no temp file and a later ack succeeds", { skip: rootSkip }, async () => {
  const f = fixture();
  try {
    new FileEgressAuditWriter(f.logDir, f.identity).append(event);
    chmodSync(f.logDir, 0o500);
    try {
      await assert.rejects(f.disk.ack("sb", 1), /EACCES/);
      assert.deepEqual(readdirSync(f.logDir).sort(), ["events.jsonl"], "no ack.pending or ack.json after the failed ack");
    } finally {
      chmodSync(f.logDir, 0o700);
    }
    await f.disk.ack("sb", 1);
    assert.deepEqual(readdirSync(f.logDir).sort(), ["ack.json", "events.jsonl"]);
  } finally {
    f.clean();
  }
});
