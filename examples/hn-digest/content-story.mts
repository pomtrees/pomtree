// Pure story attribution shared by the live runtime, the model-call rows and the run outputs. No fs, network or clock access.

// Closed marker for a row whose story cannot be resolved.
export const UNATTRIBUTED = "unattributed";

// Story number ("story-N" -> "N") of an agent or its nearest ancestor named story-N; undefined when none (e.g. the root).
export function storyNumberOf(byId: ReadonlyMap<string, { name: string; parent?: string | null }>, id: string): string | undefined {
  for (let cur = byId.get(id); cur; cur = cur.parent ? byId.get(cur.parent) : undefined) {
    const m = /^story-(\d+)$/.exec(cur.name);
    if (m) return m[1];
  }
  return undefined;
}
