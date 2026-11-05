// The `pomtreed init` interview, derived from the registry and the daemon's own refusals, never hand-listed: a key is asked when the
// same resolver as `pomtreed config show` refuses to start without it, or when the safety boot check forces a decision.
import { CONFIG_REGISTRY, type ParamDef, isSensitive } from "@pomtree/core";
import { planAgentListen } from "../agent-net.ts";
import { loadDaemonConfig } from "../daemon-config.ts";
import { safetyBootErrors } from "../safety-boot.ts";
import { type RepoTopicId, type SetupFacts, repoTopics } from "./steps.ts";

export type QuestionKind = "required" | "safety" | "optional" | "info";

export interface Question {
  id: string; // a registry path, `output` / `service` for the setup choices, or `repo.templates[].<field>` / `repo.schedules[].<field>`
  part: "machine" | "repo"; // machine: running the daemon here; repo: configuring it for one repository
  topic?: RepoTopicId; // repo questions: the topic (steps.ts repoTopics) this belongs to
  gap?: string; // info questions: the TODO tag naming the surface that does not exist yet
  kind: QuestionKind;
  prompt: string;
  valueKind: string; // the registry kind (string, path, enum, ...)
  choices?: readonly string[];
  sensitive: boolean;
  default: string | null;
}

export interface QuestionDefaults {
  facts: SetupFacts; // for the repo topics (steps.ts)
  stateDir: string; // what the daemon uses when state.dir is unset
  repoDir?: string; // the --repo the user gave; absent: no default (the daemon would fall back to its working directory, which during setup is usually the pomtree checkout)
}

const REPO_DIR_NOTE =
  "Answer with the absolute path of the git repository agents work on (not the pomtree checkout). There is no default: init never assumes the current directory.";

// Required keys: the registry paths the resolver refuses to start without. The refusals start with `<path> `.
// TODO(onboard-required-flag): core's ParamDef has no required/forced marker, so required keys are derived by probing the resolver's refusals; a registry field would replace this
export function requiredPaths(): string[] {
  const r = loadDaemonConfig({
    env: {},
    args: { set: [] },
    readFile: () => {
      throw new Error("no files");
    },
    defaultStateDir: "/nonexistent",
    scanExtensions: () => ({ extensions: [], errors: [] }),
  });
  if (r.ok) return [];
  return CONFIG_REGISTRY.params.map((p) => p.path).filter((path) => r.errors.some((e) => e.startsWith(`${path} `)));
}

/** The neutral boot facts: nothing detected, the agent listener unset, nothing wired that could add a refusal. */
export const NEUTRAL_SAFETY_FACTS = {
  checkRunnerWired: true,
  agentListen: planAgentListen({ listen: undefined, platform: "darwin", gateway: undefined }),
  bridgeGateway: undefined,
  loadDirs: { templates: "", extensions: "" },
  agentWritable: [],
} as const;

// Safety decisions: the registry paths the boot check refuses while unset (the same TODO(onboard-required-flag) applies).
export function safetyPaths(): string[] {
  const errors = safetyBootErrors(
    { "agent.egressProxyImage": "", "agent.untemplatedEgress": "", "extensions.approval": "", "merge.check": "", "listen.allowNonloopback": false },
    { ...NEUTRAL_SAFETY_FACTS, agentWritable: [] },
  );
  return CONFIG_REGISTRY.params.map((p) => p.path).filter((path) => errors.some((e) => e.includes(`refusing to start: ${path} is not set`)));
}

const KEY_FILE_NOTE =
  "Answer with the absolute path of a file that will hold the key; init creates it empty, mode 0600, and never reads or prints it. Put the key in that file yourself.";
const SAFETY_NOTE = "A safety decision with no default: it must be decided by the user, not guessed.";

function ask(p: ParamDef, kind: QuestionKind): Question {
  const sensitive = isSensitive(p);
  return {
    id: p.path,
    part: "machine",
    kind,
    prompt: `${p.doc}${sensitive ? ` ${KEY_FILE_NOTE}` : ""}${kind === "safety" ? ` ${SAFETY_NOTE}` : ""}`,
    valueKind: p.kind,
    ...(p.kind === "enum" && { choices: p.values }),
    sensitive,
    default: null,
  };
}

// Config-backed repo topics: the registry paths each answers. The one mapping table; a test checks every path exists and every
// "config" topic of steps.ts has at least one.
export const TOPIC_CONFIG_PATHS: Partial<Record<RepoTopicId, readonly string[]>> = {
  "state-artifacts": ["state.dir", "report.dir"],
  "model-budget": ["budget.defaultMicros", "budget.topLevelMicros"],
  extensions: ["extensions.dir", "workflow.reviewedExtensions", "workflow.templates"],
};

// Template-backed repo topics: the `repo.templates[]` entry fields each asks. Every field is a key core's Template has and the template
// store reads (a drift test checks it against template-dir's HANDLED_TEMPLATE_KEYS); `hosts` rides on `egress` allowlist.
export const TEMPLATE_TOPIC_FIELDS: Partial<Record<RepoTopicId, readonly string[]>> = {
  tasks: ["id", "systemPrompt", "disposition"],
  egress: ["egress"],
  "model-budget": ["provider", "model", "budgetMicros"],
};

const TEMPLATE_FIELD_QUESTIONS: Readonly<Record<string, { prompt: string; valueKind: string; choices?: readonly string[] }>> = {
  id: { prompt: "The template id: letters, digits, - and _. Spawns and schedules name the task by it.", valueKind: "string" },
  systemPrompt: { prompt: "The task's system prompt: what the agent is and does here.", valueKind: "string" },
  disposition: {
    prompt: "What happens to the result: hold it for review, or reap the container on exit.",
    valueKind: "enum",
    choices: ["hold", "reap-on-exit"],
  },
  egress: {
    prompt:
      'The network the task may reach: none, registry (the package registries), or allowlist (named hosts: answer {"kind": "allowlist", "hosts": [...]}). Audited public access is for browser workers only and is not offered here. No default: pick the most restrictive that works.',
    valueKind: "enum",
    choices: ["none", "registry", "allowlist"],
  },
  provider: { prompt: "The model provider for this task (requires a model too). Stating it makes no model call.", valueKind: "string" },
  model: { prompt: "The model id for this task.", valueKind: "string" },
  budgetMicros: { prompt: "The most one run of this task may cost, in micro-dollars (1000000 = $1). Spent only when a run starts.", valueKind: "micros" },
};

const SCHEDULE_FIELDS: Readonly<Record<string, { prompt: string; valueKind: string }>> = {
  id: { prompt: "The schedule id.", valueKind: "string" },
  cron: { prompt: "The cron expression.", valueKind: "string" },
  task: { prompt: "The task the schedule runs.", valueKind: "string" },
  tz: { prompt: "The IANA time zone of the cron expression (optional).", valueKind: "string" },
};

const valueText = (v: unknown): string | null =>
  v === "" || v === undefined ? null : Array.isArray(v) ? v.join(",") : typeof v === "object" ? JSON.stringify(v) : String(v);

export function deriveQuestions(defaults: QuestionDefaults): Question[] {
  const required = requiredPaths();
  const safety = safetyPaths();
  const byPath = CONFIG_REGISTRY.byPath;
  const def = (path: string): ParamDef => byPath.get(path) as ParamDef;
  const optional = (path: string, value: string | null): Question => ({ ...ask(def(path), "optional"), default: value });
  const topics = repoTopics(defaults.facts);
  const repoBase = (topic: RepoTopicId) => ({ part: "repo" as const, topic, sensitive: false });
  const repoQuestions: Question[] = [];
  for (const t of topics) {
    if (t.output === "none") {
      // TODO(onboard-repo-toolchain): no artifact yet; current: init asks nothing and prints a note
      // TODO(onboard-repo-secrets): no per-agent secret surface yet; current: init asks nothing and prints a note
      repoQuestions.push({
        ...repoBase(t.id),
        id: t.id,
        kind: "info",
        prompt: `${t.prose} Not configurable yet (${t.gap}): init prints a note and writes nothing.`,
        valueKind: "none",
        default: null,
        ...(t.gap !== undefined && { gap: t.gap }),
      });
    }
    for (const path of TOPIC_CONFIG_PATHS[t.id] ?? []) {
      if (path === "state.dir") continue; // asked once, below, with the daemon's default
      const p = def(path);
      repoQuestions.push({ ...ask(p, "optional"), ...repoBase(t.id), default: valueText(p.default) });
    }
    for (const field of TEMPLATE_TOPIC_FIELDS[t.id] ?? []) {
      const f = TEMPLATE_FIELD_QUESTIONS[field] as { prompt: string; valueKind: string; choices?: readonly string[] };
      repoQuestions.push({
        ...repoBase(t.id),
        id: `repo.templates[].${field}`,
        kind: "optional",
        prompt: f.prompt,
        valueKind: f.valueKind,
        ...(f.choices && { choices: f.choices }),
        default: null,
      });
    }
    if (t.id === "schedule")
      for (const [field, f] of Object.entries(SCHEDULE_FIELDS))
        repoQuestions.push({ ...repoBase(t.id), id: `repo.schedules[].${field}`, kind: "optional", prompt: f.prompt, valueKind: f.valueKind, default: null });
  }
  return [
    ...required.map((path) => ask(def(path), "required")),
    ...safety.map((path) => ask(def(path), "safety")),
    { ...optional("state.dir", defaults.stateDir), part: "repo", topic: "state-artifacts" },
    { ...ask(def("repo.dir"), "required"), prompt: `${def("repo.dir").doc} ${REPO_DIR_NOTE}`, default: defaults.repoDir ?? null },
    {
      id: "output",
      part: "machine",
      kind: "optional",
      prompt:
        "Where the settings go: env (a pomtreed.env file) or json (a pomtreed.json config file plus a small pomtreed.env that points at it and at the key file).",
      valueKind: "enum",
      choices: ["env", "json"],
      sensitive: false,
      default: "env",
    },
    {
      id: "service",
      part: "machine",
      kind: "optional",
      prompt: "Render a systemd unit (pomtreed.service) as well? It is only rendered here; installing it needs root and is left to the user.",
      valueKind: "enum",
      choices: ["systemd", "none"],
      sensitive: false,
      default: "none",
    },
    ...repoQuestions,
  ];
}

export function renderQuestionsText(qs: readonly Question[]): string[] {
  const lines = [
    'pomtreed init: answer these in an answers file (see: pomtreed init --answers FILE), as JSON {"config": {<id>: <value>}, "keyFile": "/abs/path", "output": "env|json", "service": "systemd|none"}',
    "",
  ];
  for (const q of qs) {
    lines.push(
      `${q.id} [${q.part}${q.topic ? `/${q.topic}` : ""} ${q.kind}${q.choices ? `: ${q.choices.join("|")}` : `: ${q.valueKind}`}]${q.default !== null ? ` (default ${q.default})` : ""}`,
    );
    lines.push(`  ${q.prompt}`);
  }
  return lines;
}
