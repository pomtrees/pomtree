import type { AgentRecord, DeterministicSpec, JournalEntry, JournalPayload, SpawnSpec } from "@pomtree/core";

export const entry = (seq: number, agent: string, payload: JournalPayload, extra: Partial<JournalEntry> = {}): JournalEntry => ({
  seq,
  ts: 1000 + seq * 10,
  agent,
  host: "h1",
  generation: 0,
  payload,
  ...extra,
});

// Fixture overrides keep the discriminant and its spec together: a deterministic override must carry a DeterministicSpec.
type AgentFixtureExtra =
  | (Partial<Omit<AgentRecord, "executor" | "spec">> & { executor?: "container"; spec?: SpawnSpec })
  | (Partial<Omit<AgentRecord, "executor" | "spec">> & { executor: "deterministic"; spec: DeterministicSpec });

export const agent = (id: string, parent: string | null, extra: AgentFixtureExtra = {}): AgentRecord => {
  const common = {
    id,
    parent,
    name: id,
    task: "t",
    state: "running" as const,
    exit: null,
    result: null,
    host: "h1",
    sandbox: null,
    generation: 0,
    budgetMicros: 1_000_000,
    createdAt: 0,
    updatedAt: 0,
  };
  if (extra.executor === "deterministic") return { ...common, ...extra, executor: "deterministic", spec: extra.spec };
  return {
    ...common,
    ...extra,
    executor: "container",
    spec: extra.spec ?? { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "registry" } },
  };
};
