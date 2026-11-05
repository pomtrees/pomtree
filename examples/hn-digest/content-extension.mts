// Content mode is a separate, explicitly host-installed reviewed plugin. Metadata hn-digest/digest stays unchanged.
// Production hosts supply the actual container capture authority plus existing registry/report services; no ambient fallback.
import type { AgentRecord, Extension, Registry, ReportStore } from "../../packages/core/src/index.ts";
import type { ContentBounds } from "./content-bounds.mts";
import { type CaptureAuthority, createArticleVerifier } from "./content-evidence.mts";
import { createContentWorkflows } from "./content-workflow.mts";

export function createContentExtension(deps: {
  registry: Pick<Registry, "get">;
  reports: ReportStore;
  authority: CaptureAuthority;
  root(): Promise<AgentRecord>;
  bounds: ContentBounds; // the one resolved bound set shared by the workers, the verifier and the workflows
  now?: () => number;
}): Extension {
  const verifier = createArticleVerifier(deps);
  return {
    manifest: { name: "hn-content", entry: "content-extension.mts", capabilities: {}, deps: [] },
    init(host) {
      for (const workflow of createContentWorkflows(verifier, deps.bounds)) host.workflow(workflow);
    },
  };
}
