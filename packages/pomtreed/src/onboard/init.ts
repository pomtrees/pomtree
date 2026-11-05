// `pomtreed init`: print the derived interview (--questions), or turn an answers file into the env/JSON/unit files (--answers). Planning,
// validation (the same resolver and boot checks the daemon runs), diffing and applying are pure over an injected InitIo; cli.ts supplies
// the real filesystem. The key file is never read, opened or overwritten: it is created empty only when absent, and only stat'ed otherwise.
// TODO(onboard-ext-new): `pomtreed ext new` scaffold is not built
// TODO(onboard-install-skill): `pomtreed init --install-skill` (copy .agents/skills/pomtree-onboarding into ~/.claude/skills or ~/.agents/skills) is not built
import { dirname, isAbsolute, join } from "node:path";
import { CONFIG_FILE_ENV, CONFIG_REGISTRY, didYouMean, isSensitive, secretFileEnv } from "@pomtree/core";
import { loadDaemonConfig } from "../daemon-config.ts";
import { safetyBootErrors } from "../safety-boot.ts";
import { type Answers, parseAnswers } from "./answers.ts";
import { diffLines } from "./diff.ts";
import { parseFlags } from "./flags.ts";
import type { CommandResult } from "./preflight.ts";
import type { FileStat } from "./probes.ts";
import { NEUTRAL_SAFETY_FACTS, deriveQuestions, renderQuestionsText } from "./questions.ts";
import { redactSecrets } from "./redact.ts";
import { envLine, envValue, nestedConfigJson, parseEnvText, renderService } from "./render.ts";
import { scheduleCommand, shellWord, targetRepoRefusal, templateFileText, within } from "./repo.ts";
import { type SetupFacts, onboardingSteps, stepById } from "./steps.ts";

export const INIT_USAGE = `usage: pomtreed init --questions [--json] [--repo DIR]
       pomtreed init --answers FILE [--repo DIR] [--out DIR] [--write] [--force]
  --questions   print the setup interview, derived from the config registry and the daemon's own refusals
  --answers F   plan the files from an answers file {"config": {<registry path>: <value>}, "keyFile": "/abs/path", "output": "env|json", "service": "systemd|none", "repo": {"templates": [...], "schedules": [...]}}
  --repo DIR    the repository agents work on (an absolute path to a git repository, not the pomtree checkout); fills repo.dir when
                the answers leave it out. There is no default: init never assumes the current directory
  --out DIR     where the files go (default: \${XDG_CONFIG_HOME:-~/.config}/pomtreed)
  --write       apply the plan (default: dry run). Files are written mode 0600; a differing existing file is refused
  --force       with --write, overwrite a differing existing file (never the key file)
Exit 2 for a usage error or a refused plan.`;

export interface LStat extends FileStat {
  isSymlink: boolean;
  isFile: boolean; // a regular file
  dev: number; // with ino, the file's identity: two paths sharing both are hardlinks of one file
  ino: number;
}

export interface InitIo {
  /**
   * The text of an existing planned file (never the key file), opened without following a symlink. Throws when the path is no
   * longer the file `expected` (its lstat) describes: swapped for a symlink, a different file, or no longer a regular file.
   */
  readText(path: string, expected: Pick<LStat, "dev" | "ino">): string;
  lstat(path: string): LStat | null; // never follows a symlink
  mkdirp(dir: string, mode: number): void;
  writeText(path: string, content: string, mode: number): void; // atomic create or replace (temp file + rename), leaving the file at `mode`; never follows a symlink
  createEmpty(path: string, mode: number): void; // exclusive create; fails if the path exists
}

export interface InitEnv {
  io: InitIo;
  defaultOut: string;
  defaultStateDir: string;
  checkout: string;
  isGitRepo(dir: string): boolean; // `git -C dir rev-parse --git-dir` in the shell
  node: string;
  uid: number | null;
  readAnswers(path: string): string; // throws when unreadable
  readServiceTemplate(): string; // deploy/pomtreed.service; only called for service "systemd"
  facts: SetupFacts;
  realpath(path: string): string; // realpathLoose in the shell
  checkTemplates(files: readonly { id: string; content: string }[]): Promise<string[]>; // template-check.ts: the daemon's own store; one message per refusal
}

export interface PlannedFile {
  path: string;
  content: string;
}

export interface InitPlan {
  files: PlannedFile[];
  templates: { id: string; content: string }[]; // the template files, for the store check
  notes: string[]; // topics with no artifact yet, with their gap tags
  schedules: string[]; // `pomtree sched add` commands for the user to run
  keyFile: string;
  envFile: string;
  stateDir: string;
  repoDir: string;
  service: boolean;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Build the files and validate them with the daemon's own resolver and boot checks before anything is written. */
export function planInit(
  answers: Answers,
  ctx: Pick<InitEnv, "defaultStateDir" | "checkout" | "node" | "realpath" | "isGitRepo"> & { out: string; serviceTemplate?: string },
): { ok: true; plan: InitPlan } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const envOf = (path: string): string => CONFIG_REGISTRY.envOf.get(path) as string;
  const entries = Object.entries(answers.config).sort(([a], [b]) => a.localeCompare(b));
  for (const [path] of entries) {
    const p = CONFIG_REGISTRY.byPath.get(path);
    if (p === undefined)
      errors.push(
        `unknown key ${path}${didYouMean(path, [...CONFIG_REGISTRY.byPath.keys()])}; extension keys are not supported by init, see pomtreed config show for the registry keys`,
      );
    else if (isSensitive(p)) errors.push(`${path} is sensitive and cannot be answered under "config"; give "keyFile" (an absolute path) instead`);
  }
  if (errors.length > 0) return { ok: false, errors };

  // Templates are loaded from templates.dir; unanswered, that is <out>/templates so the files init writes are the ones the daemon reads.
  const config: Record<string, unknown> = { ...answers.config };
  if (answers.repo.templates.length > 0 && config["templates.dir"] === undefined) config["templates.dir"] = join(ctx.out, "templates");
  const envPath = join(ctx.out, "pomtreed.env");
  const jsonPath = join(ctx.out, "pomtreed.json");
  let envText: string;
  let jsonText: string | undefined;
  try {
    if (answers.output === "json") {
      jsonText = nestedConfigJson(config);
      envText = `${[envLine(CONFIG_FILE_ENV, jsonPath), envLine(secretFileEnv(envOf("model.upstreamKey")), answers.keyFile)].join("\n")}\n`;
    } else
      envText = `${[
        ...Object.entries(config)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([path, v]) => envLine(envOf(path), envValue(v))),
        envLine(secretFileEnv(envOf("model.upstreamKey")), answers.keyFile),
      ].join("\n")}\n`;
  } catch (e) {
    return { ok: false, errors: [message(e)] };
  }

  // Validate the generated text itself: parse it back and run the daemon's resolver over it. The key file is a placeholder, never read.
  const env = parseEnvText(envText);
  const loaded = loadDaemonConfig({
    env,
    args: { set: [] },
    readFile: (p) => {
      if (p === answers.keyFile) return "placeholder-key";
      if (jsonText !== undefined && p === jsonPath) return jsonText;
      throw new Error(`unexpected read of ${p}`);
    },
    fileMode: () => 0o100600,
    defaultStateDir: ctx.defaultStateDir,
    scanExtensions: () => ({ extensions: [], errors: [] }),
  });
  if (!loaded.ok) return { ok: false, errors: loaded.errors };
  const boot = safetyBootErrors(loaded.config, { ...NEUTRAL_SAFETY_FACTS, agentWritable: [] });
  if (boot.length > 0) return { ok: false, errors: boot };

  const stateDir = loaded.config["state.dir"] || ctx.defaultStateDir;
  // No default: the daemon falls back to its working directory, which during setup is usually the pomtree checkout.
  const repoDir = loaded.config["repo.dir"];
  if (!repoDir) return { ok: false, errors: ['repo.dir is not answered: give the target repository\'s absolute path under "config" or with --repo DIR'] };
  const real = ctx.realpath;
  const repoRefusal = targetRepoRefusal(real(repoDir), real(ctx.checkout));
  if (repoRefusal !== null) return { ok: false, errors: [`repo.dir: ${repoRefusal}`] };
  if (!ctx.isGitRepo(repoDir))
    return { ok: false, errors: [`repo.dir ${repoDir} is not a git repository; give the path of the repository agents work on, or git init it first`] };
  const templatesDir = loaded.config["templates.dir"] || join(stateDir, "templates");
  // The daemon's own load-dir overlap check, fed the same agent-writable state paths main.ts feeds it, then the repo itself: merged
  // work in the target repository could otherwise change the templates (or extensions) pomtreed later loads.
  const overlap = safetyBootErrors(loaded.config, {
    ...NEUTRAL_SAFETY_FACTS,
    loadDirs: { templates: real(templatesDir), extensions: real(loaded.extensionsDir) },
    agentWritable: [
      { key: "state.dir", path: real(join(stateDir, "workspaces")) },
      { key: "state.dir", path: real(join(stateDir, "agents")) },
      { key: "session.dir", path: real(loaded.config["session.dir"] || join(stateDir, "sessions")) },
      { key: "envCache.dir", path: real(loaded.config["envCache.dir"] || join(stateDir, "env-cache")) },
    ],
  });
  if (overlap.length > 0) return { ok: false, errors: overlap };
  for (const [key, dir] of [
    ["templates.dir", templatesDir],
    ["extensions.dir", loaded.extensionsDir],
  ] as const)
    if (within(real(dir), real(repoDir)))
      return {
        ok: false,
        errors: [
          `${key} (${dir}) is inside the repo dir ${repoDir}: work agents merge there could change what pomtreed loads. Set ${key} to a directory outside the repository`,
        ],
      };
  // The key file holds the secret: it must be neither a file init writes (the dry-run diff would print it, --force would replace it)
  // nor reachable by agents (the target repo, the agent-writable state paths).
  const keyReal = real(answers.keyFile);
  const writable = [
    join(stateDir, "workspaces"),
    join(stateDir, "agents"),
    loaded.config["session.dir"] || join(stateDir, "sessions"),
    loaded.config["envCache.dir"] || join(stateDir, "env-cache"),
  ];
  for (const [what, dir] of [["the repo dir", repoDir], ...writable.map((w) => ["an agent-writable path", w] as const)] as const)
    if (within(keyReal, real(dir)))
      return { ok: false, errors: [`keyFile ${answers.keyFile} is inside ${what} ${dir}, which agents can reach; choose a key file path outside it`] };
  const files: PlannedFile[] = [{ path: envPath, content: envText }];
  const templates = answers.repo.templates.map((t) => ({ id: t.id, content: templateFileText(t) }));
  for (const t of templates) files.push({ path: join(templatesDir, `${t.id}.json`), content: t.content });
  if (jsonText !== undefined) files.push({ path: jsonPath, content: jsonText });
  if (answers.service === "systemd") {
    if (ctx.serviceTemplate === undefined)
      return { ok: false, errors: ["service systemd needs the deploy/pomtreed.service template, which could not be read"] };
    try {
      files.push({
        path: join(ctx.out, "pomtreed.service"),
        content: renderService(ctx.serviceTemplate, { checkout: ctx.checkout, node: ctx.node, envFile: envPath, stateDir, repoDir }),
      });
    } catch (e) {
      return { ok: false, errors: [message(e)] };
    }
  }
  for (const f of files)
    if (f.path === answers.keyFile || real(f.path) === keyReal)
      return { ok: false, errors: [`keyFile ${answers.keyFile} is the same file as ${f.path}, which init writes; choose a different key file path`] };
  const notes = [
    // TODO(onboard-repo-toolchain): no artifact yet; current: a note that toolchains come from the agent image
    "repository toolchain (onboard-repo-toolchain): not configurable yet; agents get the toolchains of the agent image, so check it carries what the repository needs",
    // TODO(onboard-repo-secrets): no per-agent secret surface yet; current: a note that agents get none
    "secrets for agents (onboard-repo-secrets): there is no per-agent secret surface yet; agents receive only a scoped model credential",
  ];
  return {
    ok: true,
    plan: {
      files,
      templates,
      notes,
      schedules: answers.repo.schedules.map(scheduleCommand),
      keyFile: answers.keyFile,
      envFile: envPath,
      stateDir,
      repoDir,
      service: answers.service === "systemd",
    },
  };
}

type FileStatus = "new" | "unchanged" | "differs";

const mode9 = (st: FileStat): string => (st.mode & 0o777).toString(8);

function describeKeyFile(path: string, stat: LStat | null, uid: number | null): { line: string; exists: boolean; refusal?: string } {
  if (stat === null) return { line: `key file ${path}: new (created empty, mode 0600)`, exists: false };
  if (stat.isSymlink) return { line: "", exists: true, refusal: `key file ${path} is a symlink (dangling or not); point keyFile at the real file path` };
  if (!stat.isFile) return { line: "", exists: true, refusal: `key file ${path} is not a regular file; choose a file path` };
  const bad = (stat.mode & 0o077) !== 0 || (uid !== null && stat.uid !== uid);
  return {
    line: `key file ${path}: exists, left untouched (mode ${mode9(stat)}${bad ? `; WARNING: it must be mode 600 and owned by you, run chmod 600 ${shellWord(path)}` : ", ok"})`,
    exists: true,
  };
}

export function applyPlan(plan: InitPlan, env: InitEnv, opts: { write: boolean; force: boolean; out: string; extra?: string[] }): CommandResult {
  const { io } = env;
  const lines: string[] = [];
  // Every refusal is decided before the first write: symlinks and non-files (planned paths and the key file) never get followed.
  const refusals: string[] = [];
  const stats = new Map<string, LStat | null>();
  for (const f of plan.files) {
    const st = io.lstat(f.path);
    stats.set(f.path, st);
    if (st?.isSymlink) refusals.push(`${f.path} is a symlink; init does not write through symlinks, remove it or choose another --out`);
    else if (st !== null && !st.isFile) refusals.push(`${f.path} exists and is not a regular file; remove it or choose another --out`);
  }
  // The directories init creates below --out (such as <out>/templates): a symlink there would redirect the reads and writes.
  // --out itself and its ancestors are the user's choice and may be links (a dotfiles checkout, macOS /var).
  const parents = new Set<string>();
  for (const f of plan.files) for (let d = dirname(f.path); d !== opts.out && within(d, opts.out) && d !== dirname(d); d = dirname(d)) parents.add(d);
  for (const d of [...parents].sort()) {
    const st = io.lstat(d);
    if (st?.isSymlink) refusals.push(`${d} is a symlink; init does not write through a symlinked directory, remove it or choose another --out`);
    else if (st !== null && !st.isDirectory) refusals.push(`${d} exists and is not a directory; remove it or choose another --out`);
  }
  const keyStat = io.lstat(plan.keyFile);
  const key = describeKeyFile(plan.keyFile, keyStat, env.uid);
  if (key.refusal !== undefined) refusals.push(key.refusal);
  // A hardlink passes the realpath comparison in planInit; the dry-run diff would then read, and print, the key file through the planned path.
  if (keyStat !== null)
    for (const f of plan.files) {
      const st = stats.get(f.path);
      if (st && st.dev === keyStat.dev && st.ino === keyStat.ino)
        refusals.push(`keyFile ${plan.keyFile} is a hardlink of ${f.path}, which init writes; choose a different key file path or remove the link`);
    }
  if (refusals.length > 0) return { code: 2, lines: [...refusals.map((r) => `pomtreed init: ${r}`), "nothing was written"] };
  // Read through the identity lstat saw: a path swapped (for a symlink, or another file) after the check is refused, not followed.
  const existing = new Map<string, string>();
  for (const f of plan.files) {
    const st = stats.get(f.path) ?? null;
    if (st === null) continue;
    try {
      existing.set(f.path, io.readText(f.path, st));
    } catch (e) {
      refusals.push(`${f.path} changed while init was checking it (${message(e)}); make sure nothing else is writing to --out, then re-run`);
    }
  }
  if (refusals.length > 0) return { code: 2, lines: [...refusals.map((r) => `pomtreed init: ${r}`), "nothing was written"] };
  const status = new Map<string, FileStatus>();
  for (const f of plan.files) {
    const st = stats.get(f.path) ?? null;
    const before = existing.get(f.path) ?? null;
    status.set(f.path, before === null ? "new" : before === f.content ? "unchanged" : "differs");
    const loose = status.get(f.path) === "unchanged" && st !== null && (st.mode & 0o777) !== 0o600;
    lines.push(`${status.get(f.path)} ${f.path}${loose && st ? ` (mode ${mode9(st)}: run chmod 600 ${shellWord(f.path)})` : ""}`);
    if (before !== null && before !== f.content) {
      // An existing file is user content and may hold a secret: both sides are redacted before the diff, so no value of a
      // sensitive name reaches the output.
      const diff = diffLines(redactSecrets(before), redactSecrets(f.content));
      if (diff.length === 0) lines.push("  (only a sensitive value differs; it is not shown)");
      for (const d of diff) lines.push(`  ${d}`);
    }
  }
  lines.push(key.line);
  lines.push(...plan.notes.map((n) => `note: ${n}`));
  const differing = plan.files.filter((f) => status.get(f.path) === "differs");
  if (!opts.write)
    return {
      code: 0,
      lines: [
        ...lines,
        ...differing.map(
          (f) => `--write would refuse to overwrite ${f.path}: it differs from the plan; review the diff above, then merge by hand or pass --force`,
        ),
        "dry run: pass --write to apply",
      ],
    };
  if (differing.length > 0 && !opts.force)
    return {
      code: 2,
      lines: [
        ...lines,
        ...differing.map((f) => `refusing to overwrite ${f.path}: it differs from the plan; review the diff above, then merge by hand or re-run with --force`),
        "nothing was written",
      ],
    };
  const done: string[] = [];
  let current = opts.out;
  try {
    io.mkdirp(opts.out, 0o700);
    for (const f of plan.files) {
      if (status.get(f.path) === "unchanged") continue;
      current = f.path;
      io.mkdirp(dirname(f.path), 0o700);
      io.writeText(f.path, f.content, 0o600);
      done.push(f.path);
    }
    if (!key.exists) {
      current = plan.keyFile;
      io.mkdirp(dirname(plan.keyFile), 0o700);
      io.createEmpty(plan.keyFile, 0o600);
      done.push(plan.keyFile);
    }
  } catch (e) {
    return {
      code: 2,
      lines: [
        ...lines,
        `pomtreed init: wrote ${done.length > 0 ? done.join(", ") : "nothing"}; failed ${current}: ${message(e)}; fix the cause and re-run (a re-run only writes what is missing or changed)`,
      ],
    };
  }
  lines.push(...nextSteps(plan, env, opts.out));
  return { code: 0, lines };
}

/** A step command (steps.ts) with each word holding a `<placeholder>` filled from `values` and shell-quoted as one word; an unknown placeholder is left as written. */
export function fillCommand(run: string, values: Readonly<Record<string, string>>): string {
  return run.replace(/[^\s;]*<[a-z-]+>[^\s;]*/g, (word) => {
    const filled = word.replace(/<([a-z-]+)>/g, (ph, name: string) => values[name] ?? ph);
    return /<[a-z-]+>/.test(filled) ? filled : shellWord(filled);
  });
}

// The labels of the start-daemon step's commands an agent may run, in order; the commands themselves come from the step source.
export const NEXT_STEP_LABELS = ["load the settings", "check them", "start the daemon"] as const;

function nextSteps(plan: InitPlan, env: InitEnv, out: string): string[] {
  const steps = onboardingSteps(env.facts);
  const fill = (run: string) => fillCommand(run, { out, checkout: env.checkout, "key-file": plan.keyFile });
  const key = stepById(steps, "key-file").commands[0];
  const start = stepById(steps, "start-daemon").commands;
  const user = start.filter((c) => c.needsRoot !== true);
  const lines = [
    "",
    "next:",
    `  1. put the model API key in the key file yourself (mode 600; do not paste it into a chat or a command line): ${key ? fill(key.run) : shellWord(plan.keyFile)}`,
    ...NEXT_STEP_LABELS.map((label, i) => `  ${i + 2}. ${label}: ${fill(user[i]?.run ?? "")}`),
  ];
  if (plan.service) {
    lines.push(
      "  or run it as a systemd service; these need root, so you run them (an agent must not):",
      ...start.filter((c) => c.needsRoot === true).map((c) => `    ${fill(c.run)}`),
      "  the unit runs as user pomtreed with ProtectHome=yes: keep the key file, state dir and repo outside /home, or edit those lines (deploy/INSTALL.md)",
    );
  }
  if (plan.schedules.length > 0)
    lines.push("  5. once the daemon runs, add the schedules (you run these; init never does):", ...plan.schedules.map((c) => `    ${c}`));
  return lines;
}

export async function runInit(argv: readonly string[], env: InitEnv): Promise<CommandResult> {
  const p = parseFlags(argv, { bools: ["--questions", "--json", "--write", "--force"], values: ["--answers", "--out", "--repo"] });
  const errors = [...p.errors, ...p.positional.map((a) => `unexpected argument ${a}`)];
  const repoFlag = p.values.get("--repo");
  if (repoFlag !== undefined && !isAbsolute(repoFlag)) errors.push(`--repo ${repoFlag} must be an absolute path`);
  const questions = p.bools.has("--questions");
  const answersPath = p.values.get("--answers");
  if (!questions && answersPath === undefined) errors.push("pass --questions to see the interview, or --answers FILE to plan the files");
  if (questions && answersPath !== undefined) errors.push("--questions and --answers are separate steps");
  if (!questions && p.bools.has("--json")) errors.push("--json applies only to --questions");
  if (questions && (p.bools.has("--write") || p.bools.has("--force") || p.values.has("--out")))
    errors.push("--out, --write and --force apply only to --answers");
  if (!p.bools.has("--write") && p.bools.has("--force")) errors.push("--force applies only with --write");
  if (errors.length > 0) return { code: 2, lines: [...errors.map((e) => `pomtreed init: ${e}`), INIT_USAGE] };

  const qs = deriveQuestions({ stateDir: env.defaultStateDir, ...(repoFlag !== undefined && { repoDir: repoFlag }), facts: env.facts });
  if (questions) return { code: 0, lines: p.bools.has("--json") ? [JSON.stringify(qs, null, 2)] : renderQuestionsText(qs) };

  let text: string;
  try {
    text = env.readAnswers(answersPath as string);
  } catch (e) {
    return { code: 2, lines: [`pomtreed init: cannot read answers file ${answersPath}: ${message(e)}; check the path`] };
  }
  const parsed = parseAnswers(text, qs, repoFlag === undefined ? {} : { "repo.dir": { value: repoFlag, from: "--repo" } });
  if (!parsed.ok) return { code: 2, lines: [...parsed.errors.map((e) => `pomtreed init: ${e}`), "nothing was written"] };
  const out = p.values.get("--out") ?? env.defaultOut;
  let serviceTemplate: string | undefined;
  if (parsed.answers.service === "systemd") {
    try {
      serviceTemplate = env.readServiceTemplate();
    } catch (e) {
      return { code: 2, lines: [`pomtreed init: cannot read deploy/pomtreed.service: ${message(e)}; run from a full checkout`, "nothing was written"] };
    }
  }
  const planned = planInit(parsed.answers, { ...env, out, ...(serviceTemplate !== undefined && { serviceTemplate }) });
  if (!planned.ok) return { code: 2, lines: [...planned.errors.map((e) => `pomtreed init: ${e}`), "nothing was written"] };
  const refused = await env.checkTemplates(planned.plan.templates);
  if (refused.length > 0) return { code: 2, lines: [...refused.map((e) => `pomtreed init: ${e}`), "nothing was written"] };
  return applyPlan(planned.plan, env, { write: p.bools.has("--write"), force: p.bools.has("--force"), out });
}
