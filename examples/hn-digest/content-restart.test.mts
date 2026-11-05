// Abrupt separate-process restarts over the real SQLite/report directories. No fake in-process replay scheduler.
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
for (const boundary of [
  "selection",
  "story-reservation",
  "article-dispatched-before-id-save",
  "retained-before-reap",
  "capture-receipts",
  "analysis-reservation",
  "model-dispatched-before-id-save",
  "analysis-receipt",
  "draft",
  "report",
  "outbox",
]) {
  test(`content real-process restart: ${boundary} preserves same task, attempts, receipts and final artifact`, { timeout: 35000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "hn-content-restart-"));
    try {
      const crashed = spawnSync(process.execPath, [worker, dir, boundary], { encoding: "utf8", timeout: 15000 });
      assert.equal(crashed.status, 73, `${boundary} did not reach crash boundary: ${crashed.error ?? crashed.stderr}`);
      const fault = JSON.parse(readFileSync(join(dir, "fault.json"), "utf8")) as { rootId: string; childId?: string; beforeIdSave?: boolean };
      const resumed = spawnSync(process.execPath, [worker, dir, "resume"], { encoding: "utf8", timeout: 15000 });
      assert.equal(resumed.status, 0, String(resumed.error ?? resumed.stderr));
      const proof = JSON.parse(readFileSync(join(dir, "proof.json"), "utf8")) as {
        root: AgentRecord;
        agents: AgentRecord[];
        approvals: unknown[];
        dispatches: JournalEntry[];
        sources: JournalEntry[];
        publications: JournalEntry[];
        outboxes: JournalEntry[];
        journalErrors: JournalEntry[];
      };
      assert.equal(proof.root.id, fault.rootId, "same task resumes; a repair does not create another root/instance");
      assert.equal(proof.root.exit, "succeeded", JSON.stringify(proof.journalErrors));
      assert.equal(proof.dispatches.length, 2, "one actual article worker and one model dispatch across both process launches");
      if (boundary.includes("before-id-save")) {
        assert.equal(fault.beforeIdSave, true);
        assert.ok(
          proof.agents.some((a) => a.id === fault.childId),
          "existing terminal child rediscovered by stable key",
        );
        assert.equal(proof.dispatches.filter((e) => e.agent === fault.childId).length, 1, "lost ID-save reply never causes a repeated dispatch");
      }
      assert.equal(proof.sources.length, 2, "feed and selected record fetched once across launches");
      assert.equal(proof.approvals.length, 1, "same SHA-bound approval, no duplicate final gate");
      assert.equal(proof.publications.length, 1, "one actual final publication");
      assert.equal(proof.outboxes.length, 1, "one keyed final outbox");
      const result = proof.root.result as { reportBody: string; draftSha: string; stories: unknown[] };
      assert.equal(hash(result.reportBody), result.draftSha);
      assert.match(result.reportBody, /quiet batch loss/);
      assert.equal(result.stories.length, 1);
      const active = proof.agents.filter((a) => a.id !== proof.root.id && a.name !== "root" && a.state !== "reaped");
      assert.deepEqual(active, [], "all stage custody cleaned after root join");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
