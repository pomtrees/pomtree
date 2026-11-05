// Pure renderer for GETTING_STARTED.md and the onboarding skill's references/guardrails.md, compiled from steps.ts (the one source of
// every setup fact). The file I/O lives in packages/pomtreed/scripts/gen-getting-started.ts; the regenerate-and-compare test is
// getting-started.test.ts. Mirrors packages/core/scripts/config-docs.ts (marker pair, splice that refuses a document without them).
import type { AgentState, ExitCause, ExitStatus } from "@pomtree/core";
import type { Guardrail, OnboardingStep, RepoTopic, StepCommand, TroubleshootingGroup } from "./steps.ts";

export const GETTING_STARTED_BEGIN = "<!-- BEGIN GENERATED: getting-started (node packages/pomtreed/scripts/gen-getting-started.ts; do not edit by hand) -->";
export const GETTING_STARTED_END = "<!-- END GENERATED: getting-started -->";

// TODO(onboard-glossary-lists): core now exports AGENT_STATE_WORDING and EXIT_STATUS_WORDING; derive these local lists from their keys; current: hand-written lists.
// The `satisfies` plus the Exclude checks make a new state or status fail tsc until it is listed (and given a meaning) here.
export const AGENT_STATES = ["pending", "running", "yielded", "exited", "reaped"] as const satisfies readonly AgentState[];
export const EXIT_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "over_budget"] as const satisfies readonly ExitStatus[];
const _allStates: Exclude<AgentState, (typeof AGENT_STATES)[number]> extends never ? true : false = true;
const _allStatuses: Exclude<ExitStatus, (typeof EXIT_STATUSES)[number]> extends never ? true : false = true;
void [_allStates, _allStatuses];

const STATE_MEANING: Record<(typeof AGENT_STATES)[number], string> = {
  pending: "created, not yet started",
  running: "has a live process",
  yielded: "parked while waiting; resumes when what it waits on arrives",
  exited: "finished with an exit status and result, held until its parent or custodian collects it",
  reaped: "collected; the record and result stay in the store, and the folder is kept only for the reaped-folder grace period",
};
const STATUS_MEANING: Record<(typeof EXIT_STATUSES)[number], string> = {
  succeeded: "finished its work",
  failed: "ended with an error; the exit cause says why",
  cancelled: "stopped on request",
  timed_out: "its session deadline passed",
  over_budget: "its budget ran out, or a raise it asked for was denied or timed out",
};

/** The code tables the glossary is generated from; the generator passes the real ones so they cannot drift. */
export interface Glossary {
  causes: Readonly<Record<ExitCause, string>>; // EXIT_CAUSE_WORDING
  startFailures: Readonly<Record<string, ExitCause>>; // START_FAILURE_CAUSE
}

const cell = (x: string): string => x.replaceAll("|", "\\|");

export function glossaryText(g: Glossary): string {
  return [
    "### Glossary",
    "",
    "Agent states:",
    "",
    "| state | meaning |",
    "| --- | --- |",
    ...AGENT_STATES.map((x) => `| \`${x}\` | ${STATE_MEANING[x]} |`),
    "",
    "Exit statuses:",
    "",
    "| status | meaning |",
    "| --- | --- |",
    ...EXIT_STATUSES.map((x) => `| \`${x}\` | ${STATUS_MEANING[x]} |`),
    "",
    "Exit causes (why it ended; the wording is rendered from the code's own table):",
    "",
    "| cause | meaning |",
    "| --- | --- |",
    ...Object.entries(g.causes).map(([k, v]) => `| \`${k}\` | ${cell(v)} |`),
    "",
    "Start-failure kinds:",
    "",
    "| kind | ends as cause |",
    "| --- | --- |",
    ...Object.entries(g.startFailures).map(([k, v]) => `| \`${k}\` | \`${v}\` |`),
  ].join("\n");
}

// GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens.
const anchor = (h: string): string =>
  h
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-");

export function troubleshootingText(groups: readonly TroubleshootingGroup[], steps: readonly OnboardingStep[], g: Glossary): string {
  const link = (id: string): string => {
    const i = steps.findIndex((s) => s.id === id);
    if (i < 0) throw new Error(`troubleshooting names unknown step ${id}`);
    const h = `${i + 1}. ${steps[i]?.title}`;
    return `[step ${i + 1}, ${steps[i]?.title}](#${anchor(h)})`;
  };
  const body = groups.flatMap((grp) => [
    "",
    `### ${grp.title}`,
    ...grp.entries.flatMap((e) => [
      "",
      `- **${e.symptom}** ${e.fix}${e.step === undefined ? "" : ` Fix: ${link(e.step)}.`}${e.see === undefined ? "" : ` See ${e.see}.`}`,
    ]),
  ]);
  return ["## Troubleshooting", ...body, "", glossaryText(g)].join("\n");
}

// Flags first, so a reader sees what a command costs before what it does.
function commandLine(c: StepCommand): string {
  const tags = [
    ...(c.needsRoot === true ? ["run this yourself as root"] : []),
    ...(c.network === true ? ["needs network"] : []),
    ...(c.confirm === true ? ["ask before running"] : []),
    ...(c.note === undefined ? [] : [c.note]),
  ];
  return tags.length === 0 ? c.run : `${c.run}   # ${tags.join("; ")}`;
}

function platformNote(step: OnboardingStep): string | null {
  const p = step.platforms;
  if (p === undefined) return null;
  return `Platform: ${p.map((x) => (x === "darwin" ? "macOS" : "Linux")).join(" and ")} only.`;
}

export function guardrailsText(guardrails: readonly Guardrail[]): string {
  return ["## Guardrails for agents", "", ...guardrails.map((g) => `- ${g.rule}`)].join("\n");
}

const REPO_INTRO =
  "After the machine is ready, decide how pomtree works on your repository. Ask these in order. Each answer goes in the answers file's `repo` part, and `pomtreed init --answers` writes the agent templates and prints the schedule commands for you to run. Propose each safe default and apply it only after a yes.";

/** The numbered topic blocks (question, what the answer changes, proposal, gap tag); shared by GETTING_STARTED.md and the skill's repo-interview.md. */
export function repoTopicItemsText(topics: readonly RepoTopic[]): string {
  return topics
    .map((t, i) => {
      const lines = [`### ${i + 1}. ${t.title}`, "", t.prose, "", `What it changes: ${t.changes}`];
      if (t.proposal !== undefined) lines.push("", `Propose, never apply silently: ${t.proposal}`);
      if (t.output === "none" && t.gap !== undefined) lines.push("", "Not supported yet.");
      return lines.join("\n");
    })
    .join("\n\n");
}

export function repoTopicsText(topics: readonly RepoTopic[]): string {
  return ["## Configure for your repo", "", REPO_INTRO, "", repoTopicItemsText(topics)].join("\n");
}

export function gettingStartedText(
  steps: readonly OnboardingStep[],
  guardrails: readonly Guardrail[],
  topics: readonly RepoTopic[],
  trouble: { groups: readonly TroubleshootingGroup[]; glossary: Glossary },
): string {
  const sections = steps.map((s, i) => {
    const lines = [`## ${i + 1}. ${s.title}`, "", s.prose];
    const note = platformNote(s);
    if (note !== null) lines.push("", note);
    if (s.commands.length > 0) lines.push("", "```sh", ...s.commands.map(commandLine), "```");
    return lines.join("\n");
  });
  return [...sections, repoTopicsText(topics), troubleshootingText(trouble.groups, steps, trouble.glossary), guardrailsText(guardrails)].join("\n\n");
}

// The document with its generated section replaced (the markers stay); throws if the markers are missing or out of order.
export function spliceGenerated(doc: string, generated: string, begin: string, end: string): string {
  const b = doc.indexOf(begin);
  const e = doc.indexOf(end);
  if (b < 0 || e < b) throw new Error(`the document needs ${begin} before ${end}`);
  return `${doc.slice(0, b + begin.length)}\n\n${generated}\n${doc.slice(e)}`;
}
