import type { AgentId, Journal, JsonValue, WaitCondition } from "@pomtree/core";
import { isJsonValue, validWorkflowWait } from "@pomtree/core";

export const CONTINUATION_KIND = "ext.workflow.continuation";
export interface WorkflowContinuation {
  generation: number;
  state: JsonValue;
  wait: WaitCondition;
  inbox: string[];
}

// TODO(continuation-scan): skip and journal a malformed continuation row instead of failing. Current behavior:
// latestContinuation scans the agent's whole journal in pages of 500 and throws on any malformed continuation row.
// Task-local journal snapshots deliberately do not masquerade as container checkpoints. Audit-kind retention preserves them.
export async function latestContinuation(journal: Journal, agent: AgentId): Promise<WorkflowContinuation | undefined> {
  let from = 0;
  let latest: WorkflowContinuation | undefined;
  for (;;) {
    const page = await journal.read({ agent, from, limit: 500 });
    for (const entry of page) {
      if (entry.payload.kind !== CONTINUATION_KIND) continue;
      const p = entry.payload as unknown as Record<string, unknown>;
      if (!isJsonValue(p.state) || !validWorkflowWait(p.wait) || !Array.isArray(p.inbox) || !p.inbox.every((id) => typeof id === "string"))
        throw new Error("invalid workflow continuation");
      latest = { generation: entry.generation, state: p.state, wait: p.wait, inbox: p.inbox as string[] };
    }
    if (page.length < 500) return latest;
    from = page[page.length - 1]!.seq + 1;
  }
}
