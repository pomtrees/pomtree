export const OUTLINE = `# The Lighthouse Keeper's Almanac

A short illustrated book about a keeper who records one year of weather, ships and small mysteries.

## Chapter 1: Autumn Light
- 1.1 Arrival: the keeper takes the post and learns the lamp's routine.
- 1.2 The First Storm: a night of gales, and a ship that does not answer the signal.
`;

export const ROOT_TASK = `Write chapter 1 of the book described in outline.md.
Spawn two helper agents with \`pomtree spawn\` to draft sections 1.1 and 1.2 in separate files (section-1-1.md and section-1-2.md), reap them, merge their commits, then commit chapter1.md, run \`pomtree push\`, and report via pomtree result.`;

export interface Plan {
  provider: string;
  image: string;
  budgetMicros: number;
  timeoutMs: number;
}

const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

// Names the auth file only; its contents are never read here.
export function describePlan(p: Plan): string {
  return [
    "pomtree chapters demo: this will make LIVE model calls and spend real money.",
    `  provider:   ${p.provider}`,
    `  image:      ${p.image}`,
    `  budget cap: ${dollars(p.budgetMicros)} for the whole tree`,
    `  timeout:    ${Math.round(p.timeoutMs / 1000)}s`,
    "  steps:      temp git repo with outline.md, one root agent that spawns two helpers, merge, report",
  ].join("\n");
}

export const REFUSAL = "refusing to run: set POMTREED_LIVE=1 to confirm this makes live model calls and spends real money.";

export interface AgentLine {
  id: string;
  name: string;
  parent: string | null;
  state: string;
  exit?: string | null;
}

export function formatTree(agents: AgentLine[], rootId: string): string {
  const by = new Map<string, AgentLine[]>();
  for (const a of agents) if (a.parent) by.set(a.parent, [...(by.get(a.parent) ?? []), a]);
  const lines: string[] = [];
  const walk = (a: AgentLine, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${a.name} (${a.id}) ${a.state}${a.exit ? ` ${a.exit}` : ""}`);
    for (const c of by.get(a.id) ?? []) walk(c, depth + 1);
  };
  const root = agents.find((a) => a.id === rootId);
  if (root) walk(root, 0);
  return lines.join("\n");
}

export interface Report {
  result: unknown;
  tree: string;
  branches: { branch: string; commit: string }[];
  chapterPath: string | null;
  tempDir: string;
  timedOut: boolean;
}

export function formatReport(r: Report): string {
  return [
    r.timedOut ? "TIMED OUT waiting for the root agent; partial state below." : "root result:",
    typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2),
    "",
    "agents:",
    r.tree || "  (none)",
    "",
    "branch commits:",
    ...(r.branches.length ? r.branches.map((b) => `  ${b.branch}  ${b.commit.slice(0, 12)}`) : ["  (none)"]),
    "",
    `merged chapter: ${r.chapterPath ?? "not found"}`,
    `temp dir: ${r.tempDir} (contains the repo and daemon state; delete it when done)`,
  ].join("\n");
}

// Parses `git for-each-ref refs/agents/ --format="%(refname) %(objectname)"` lines; agent work lives at refs/agents/<id>/heads/<name>.
export function parseAgentRefs(out: string): { branch: string; commit: string }[] {
  const found: { branch: string; commit: string }[] = [];
  for (const line of out.split("\n")) {
    const m = /^refs\/agents\/[^/\s]+\/heads\/(\S+) (\S+)$/.exec(line.trim());
    if (m) found.push({ branch: m[1] as string, commit: m[2] as string });
  }
  return found;
}
