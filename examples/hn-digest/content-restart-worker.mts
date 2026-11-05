// Offline subprocess fault probe, invoked only by content-restart.test.mts. No Docker, credentials or source/provider network.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptHarness } from "../../packages/testing/src/test-harness.ts";
import type { ExtensionJournalPayload } from "../../packages/core/src/index.ts";
import { runStaticWorker } from "./article-worker.mts";
import { DEFAULT_CONTENT_BOUNDS } from "./content-bounds.mts";
import { type ContentInput, EVIDENCE_BEGIN, EVIDENCE_END, type EvidenceBundle, jsonHash, record } from "./content-contract.mts";
import { parseCaptureReceipt } from "./content-authority.mts";
import { openContentRuntime } from "./content-runtime.mts";
import type { Runtime } from "./runtime.mts";

const dir = process.argv[2];
const fault = process.argv[3];
// Optional story count (default one); ids are 101.. so fan-out boundaries can crash between per-story reaps.
const storyCount = Number(process.argv[4] ?? 1);
if (!dir || !fault) throw new Error("restart probe needs a private scratch directory and boundary");
mkdirSync(join(dir, "extensions"), { recursive: true });
const body = readFileSync(new URL("./content-fixtures/article-positive.html", import.meta.url), "utf8");
const input: ContentInput = {
  instance: "restart-content",
  limit: storyCount,
  workers: {
    articleTemplate: "static",
    articleMethod: "static-http",
    publicEgressAuthorization: "offline-profile",
    modelTemplate: "model",
    modelRoute: "fixture/model",
    modelBudgetMicros: 5000,
    articleBudgetMicros: 1000,
    modelAuthorization: "offline-only",
  },
};
let rt!: Runtime;
const faultAt = async (p: ExtensionJournalPayload) => {
  if (p.kind !== "ext.pomtreed.workflow_state" || !record(p.value)) return;
  const s = p.value;
  const a = record(s.active) ? s.active : null;
  const article = record(s.article) ? s.article : null;
  const comments = record(s.comments) ? s.comments : null;
  const analysis = record(s.analysis) ? s.analysis : null;
  const matched =
    (fault === "selection" && a?.selectionComplete && Array.isArray(a.children) && a.children.every((c) => record(c) && c.child === null)) ||
    (fault === "fanout-partial" &&
      Array.isArray(a?.children) &&
      a.children.some((c) => record(c) && c.receipt) &&
      a.children.some((c) => record(c) && !c.receipt)) ||
    (fault === "story-reservation" && article?.child === null && comments?.child === null) ||
    (fault === "retained-before-reap" && s.articleVerificationComplete && article?.receipt === null) ||
    (fault === "capture-receipts" && article?.receipt && comments?.receipt && s.evidence === null) ||
    (fault === "analysis-reservation" && analysis?.child === null) ||
    (fault === "analysis-receipt" && analysis?.receipt && s.result === null) ||
    (fault === "draft" && a?.draft && a.approval === null) ||
    (fault === "report" && a?.report && a.outbox === false) ||
    (fault === "outbox" && a?.outbox === true && a.complete === false);
  if (matched) {
    writeFileSync(join(dir, "fault.json"), JSON.stringify({ fault, rootId: a?.owner ?? s.runId }));
    process.exit(73); // intentional abrupt process loss AFTER the actual SQLite write
  }
};
const beforeIdSave = async (p: ExtensionJournalPayload) => {
  if (p.kind !== "ext.pomtreed.workflow_state" || p.workflow !== "hn-content/story" || !record(p.value)) return;
  const stage = fault === "article-dispatched-before-id-save" ? "article" : fault === "model-dispatched-before-id-save" ? "analysis" : null;
  if (!stage || !record(p.value[stage]) || typeof p.value[stage].child !== "string") return;
  const childId = p.value[stage].child;
  const previous: unknown = (await rt.stores.journal.read({ agent: rt.root.id, limit: 5000 }))
    .map((e) => e.payload)
    .filter((v) => v.kind === "ext.pomtreed.workflow_state" && v.workflow === p.workflow && v.instance === p.instance)
    .at(-1);
  if (!record(previous) || !record(previous.value) || !record(previous.value[stage]) || previous.value[stage].child !== null) return;
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const child = await rt.daemon.get(childId);
    if (child && ["exited", "reaped"].includes(child.state)) {
      writeFileSync(join(dir, "fault.json"), JSON.stringify({ fault, rootId: p.value.runId, childId, beforeIdSave: true, childState: child.state }));
      process.exit(73); // real worker dispatch/result is durable; parent's ID receipt write has NOT happened
    }
    await new Promise((r) => setTimeout(r, 5)); // bounded offline fault probe, not workflow scheduling
  }
  throw new Error("native/model dispatch did not settle before ID-save fault probe");
};
const harness = new ScriptHarness(async (c) => {
  const agent = await rt.daemon.get(c.agent);
  if (!agent) throw new Error("missing fixture agent");
  await rt.stores.journal.append({
    agent: agent.id,
    host: agent.host,
    generation: agent.generation,
    payload: { kind: "ext.hn-fixture.dispatch", name: agent.name },
    idempotencyKey: `${agent.id}:fixture-dispatch:${randomUUID()}`,
  });
  if (agent.name.startsWith("article-")) {
    const task = JSON.parse(c.prompt.slice(c.prompt.indexOf('{"kind":"hn-article-capture"')));
    const result = await runStaticWorker(task.input, {
      worker: agent.id,
      generation: agent.generation,
      profile: "audited-public",
      bounds: DEFAULT_CONTENT_BOUNDS,
      signal: new AbortController().signal,
      transport: async () => ({
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
        body: (async function* () {
          yield new TextEncoder().encode(body);
        })(),
      }),
      publish: async (name, bytes) => {
        const got = await rt.reports.publish(agent.id, {
          name,
          content: bytes,
          mediaType: name.endsWith(".md") ? "text/plain" : "text/html",
          generation: agent.generation,
          key: name,
        });
        return { id: got.report.id, sha256: got.report.sha256 };
      },
      record: async (capture) => {
        await rt.stores.journal.append({
          agent: agent.id,
          host: agent.host,
          generation: agent.generation,
          payload: { kind: "ext.hn-fixture.capture", capture },
          idempotencyKey: `${agent.id}:fixture-capture`,
        });
      },
    });
    await rt.daemon.submitResult(agent.id, "succeeded", result, "static-result");
  } else {
    const evidence = JSON.parse(
      c.prompt.slice(c.prompt.lastIndexOf(EVIDENCE_BEGIN) + EVIDENCE_BEGIN.length, c.prompt.lastIndexOf(EVIDENCE_END)).trim(),
    ) as EvidenceBundle;
    await rt.daemon.submitResult(
      agent.id,
      "succeeded",
      {
        summary: "offline grounded analysis",
        storyId: evidence.story.id,
        evidenceHash: jsonHash(evidence),
        claims: [
          {
            observation: "The captured article discusses quiet batch loss and an attempt ledger.",
            basis: "article",
            tentative: true,
            citations: [{ kind: "article", id: evidence.story.id, sha256: evidence.article?.textHash, quote: "Most batch pipelines do not crash." }],
          },
        ],
        sentiment: null,
        sentimentEvidence: [],
      },
      "model-result",
    );
  }
});
rt = await openContentRuntime({
  stateDir: dir,
  extensionDir: join(dir, "extensions"),
  reviewedOwners: ["hn-content"],
  harness,
  durableGateway: true,
  workflowAfterRecord: faultAt,
  workflowBeforeRecord: beforeIdSave,
  templates: [
    { id: "static", provider: "fixture", model: "model", egress: { kind: "audited-public" } },
    { id: "model", provider: "fixture", model: "model", egress: { kind: "none" }, allowlist: "analyst" },
  ],
  mayUseTemplate: (_caller, template) => template.id === "static" || template.id === "model",
  models: { list: async () => ({ source: "pi", models: [{ provider: "fixture", id: "model" }] }) },
  captureAuthority: {
    receipt: async (worker, generation) => {
      const rows = await rt.stores.journal.read({ agent: worker, limit: 2000 });
      const row = rows.find((r) => r.generation === generation && r.payload.kind === "ext.hn-fixture.capture");
      const payload: unknown = row?.payload;
      return record(payload) ? parseCaptureReceipt(JSON.stringify(payload.capture)) : null;
    },
  },
  resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
  fetch: async (url) => {
    const root = await rt.daemon.root();
    await rt.stores.journal.append({
      agent: root.id,
      host: root.host,
      generation: root.generation,
      payload: { kind: "ext.hn-fixture.source", url: String(url) },
      idempotencyKey: `fixture-source:${randomUUID()}`,
    });
    const id = Number(String(url).match(/item\/(\d+)\.json$/)?.[1]);
    return new Response(
      JSON.stringify(
        String(url).endsWith("topstories.json")
          ? Array.from({ length: storyCount }, (_, i) => 101 + i)
          : { id, type: "story", title: `Restart-safe evidence ${id}`, url: "https://example.com/article", kids: [] },
      ),
      { status: 200 },
    );
  },
});
try {
  await rt.daemon.reconcile();
  const launched = await rt.cli([
    "--json",
    "workflow",
    "launch",
    "hn-content/content",
    "--input",
    JSON.stringify(input),
    "--key",
    "restart-root",
    "--budget",
    "5000",
  ]);
  if (launched.code !== 0) throw new Error(launched.err.join("\n"));
  const id = (JSON.parse(launched.out.join("\n")) as { agent: string }).agent;
  const end = Date.now() + 10000;
  let completed = false;
  while (Date.now() < end) {
    for (const approval of await rt.stores.approvals.list({ state: "pending" }))
      if (approval.action.kind === "publish")
        await rt.daemon.decideApproval(approval.id, "approve", "operator", "offline process-boundary fixture only", `fixture-approve:${approval.id}`);
    const root = await rt.daemon.get(id);
    if (root && ["exited", "reaped"].includes(root.state)) {
      const agents = await rt.stores.registry.list();
      const journal = await rt.stores.journal.read({ limit: 5000 });
      const proof = {
        root,
        agents,
        approvals: await rt.stores.approvals.list(),
        dispatches: journal.filter((e) => e.payload.kind === "ext.hn-fixture.dispatch"),
        sources: journal.filter((e) => e.payload.kind === "ext.hn-fixture.source"),
        publications: journal.filter((e) => e.payload.kind === "ext.pomtreed.workflow_report"),
        outboxes: journal.filter((e) => e.payload.kind === "message_sent" && e.agent === rt.root.id),
        journalErrors: journal.filter((e) => e.payload.kind === "error"),
        seen: journal
          .map((e) => e.payload)
          .filter((p) => p.kind === "ext.pomtreed.workflow_state" && record(p.value) && Array.isArray(p.value.seen))
          .map((p) => (p.kind === "ext.pomtreed.workflow_state" && record(p.value) ? p.value.seen : null))
          .at(-1),
      };
      writeFileSync(join(dir, "proof.json"), JSON.stringify(proof, null, 2));
      console.log(JSON.stringify({ id, exit: root.exit }));
      completed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 5)); // TEST OPERATOR driver, never workflow scheduling
  }
  if (!completed) throw new Error("restart probe timed out");
} finally {
  await rt.close();
}
