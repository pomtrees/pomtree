// Abrupt separate-process restarts during per-story fan-out: partial child reaping must not duplicate work or seen-marking.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentRecord, JournalEntry } from "../../packages/core/src/index.ts";
import { hash } from "./content-contract.mts";

const worker = fileURLToPath(new URL("./content-restart-worker.mts", import.meta.url));

type RestartProof = {
  root: AgentRecord;
  agents: AgentRecord[];
  approvals: unknown[];
  dispatches: JournalEntry[];
  sources: JournalEntry[];
  publications: JournalEntry[];
  outboxes: JournalEntry[];
  journalErrors: JournalEntry[];
  seen: number[];
};

test("content real-process restart: fanout-partial with two stories (one reaped, one in flight) has no duplicate children, dispatches, or seen-marking", {
  timeout: 35000,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "hn-content-restart-"));
  try {
    const crashed = spawnSync(process.execPath, [worker, dir, "fanout-partial", "2"], { encoding: "utf8", timeout: 15000 });
    assert.equal(crashed.status, 73, `fanout-partial did not reach crash boundary: ${crashed.error ?? crashed.stderr}`);
    const fault = JSON.parse(readFileSync(join(dir, "fault.json"), "utf8")) as { rootId: string };
    const resumed = spawnSync(process.execPath, [worker, dir, "resume", "2"], { encoding: "utf8", timeout: 15000 });
    assert.equal(resumed.status, 0, String(resumed.error ?? resumed.stderr));
    const proof = JSON.parse(readFileSync(join(dir, "proof.json"), "utf8")) as RestartProof;
    assert.equal(proof.root.id, fault.rootId, "same task resumes; a repair does not create another root/instance");
    assert.equal(proof.root.exit, "succeeded", JSON.stringify(proof.journalErrors));
    assert.equal(proof.dispatches.length, 4, "one article worker and one model dispatch per story, across both process launches");
    assert.equal(proof.sources.length, 3, "feed and each selected record fetched once across launches");
    assert.equal(proof.approvals.length, 1, "same SHA-bound approval, no duplicate final gate");
    assert.equal(proof.publications.length, 1, "one actual final publication");
    assert.equal(proof.outboxes.length, 1, "one keyed final outbox");
    for (const name of ["story-101", "story-102", "article-101", "article-102", "analysis-101", "analysis-102"]) {
      assert.equal(proof.agents.filter((a) => a.name === name).length, 1, `exactly one child named ${name}; a re-reserved child would duplicate it`);
    }
    assert.deepEqual(proof.seen, [101, 102], "each story marked seen exactly once");
    const result = proof.root.result as { reportBody: string; draftSha: string; stories: unknown[]; entryIds: number[] };
    assert.equal(hash(result.reportBody), result.draftSha);
    assert.equal(result.stories.length, 2);
    assert.deepEqual(result.entryIds, [101, 102]);
    assert.match(result.reportBody, /Restart-safe evidence 101/);
    assert.match(result.reportBody, /Restart-safe evidence 102/);
    assert.match(result.reportBody, /quiet batch loss/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Pinned behavior: resume skips the keyed report/outbox that already exist, then sets seen at completion.
// So a story is never published twice, and never marked seen without a published report.
test("content real-process restart: crash after report publication but before seen is set publishes once and then marks seen", { timeout: 35000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "hn-content-restart-"));
  try {
    const crashed = spawnSync(process.execPath, [worker, dir, "report", "1"], { encoding: "utf8", timeout: 15000 });
    assert.equal(crashed.status, 73, `report did not reach crash boundary: ${crashed.error ?? crashed.stderr}`);
    const fault = JSON.parse(readFileSync(join(dir, "fault.json"), "utf8")) as { rootId: string };
    const resumed = spawnSync(process.execPath, [worker, dir, "resume", "1"], { encoding: "utf8", timeout: 15000 });
    assert.equal(resumed.status, 0, String(resumed.error ?? resumed.stderr));
    const proof = JSON.parse(readFileSync(join(dir, "proof.json"), "utf8")) as RestartProof;
    assert.equal(proof.root.id, fault.rootId, "same task resumes; a repair does not create another root/instance");
    assert.equal(proof.root.exit, "succeeded", JSON.stringify(proof.journalErrors));
    assert.equal(proof.publications.length, 1, "report published once across both launches");
    assert.equal(proof.outboxes.length, 1, "one keyed outbox across both launches");
    assert.deepEqual(proof.seen, [101], "story marked seen exactly once, after the report was published");
    const result = proof.root.result as { entryIds: number[] };
    assert.deepEqual(result.entryIds, [101]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
