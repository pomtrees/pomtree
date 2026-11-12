// The shared LocalEngine fake for pomtreed tests (one fake, no per-package copies; it moves to @pomtree/testing with the
// sandbox capability probe). It is the real object over a scripted EngineExec, so every method body is the production one: a test
// scripts CLI results by argv and asserts the recorded calls.
import { DOCKER_PROFILE, type EngineProfile, type ResolvedSocket } from "./engine-profile.ts";
import { type EngineExec, type EngineRunResult, type LocalEngine, localEngineFrom } from "./local-engine.ts";

export interface LocalEngineCall {
  file: string;
  args: string[];
  timeoutMs: number;
  env?: Readonly<Record<string, string>>;
  sync: boolean;
}

// A scripted answer: a fixed result, or a function of the argv. Unscripted calls fail as an unreachable engine would (exit 1).
export type ScriptedAnswer = Partial<EngineRunResult> | ((args: readonly string[]) => Partial<EngineRunResult>);

export interface ScriptedLocalEngine extends LocalEngine {
  readonly calls: LocalEngineCall[];
  // Sets the answer for argv joined with single spaces (`network inspect bridge -f ...`), or for every call starting with a prefix
  // when the key ends in " *".
  script(key: string, answer: ScriptedAnswer): void;
}

export interface ScriptedLocalEngineOptions {
  profile?: EngineProfile;
  socket?: ResolvedSocket;
  findings?: readonly string[];
  answers?: Record<string, ScriptedAnswer>;
}

const UNSCRIPTED: EngineRunResult = { code: 1, stdout: "", stderr: "unscripted call in scriptedLocalEngine" };

export function scriptedLocalEngine(options: ScriptedLocalEngineOptions = {}): ScriptedLocalEngine {
  const answers = new Map<string, ScriptedAnswer>(Object.entries(options.answers ?? {}));
  const calls: LocalEngineCall[] = [];
  const answer = (args: readonly string[]): EngineRunResult => {
    const key = args.join(" ");
    let a = answers.get(key);
    if (a === undefined) for (const [k, v] of answers) if (k.endsWith(" *") && key.startsWith(k.slice(0, -1))) a = v;
    if (a === undefined) return UNSCRIPTED;
    const r = typeof a === "function" ? a(args) : a;
    return { code: r.code === undefined ? 0 : r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const record = (file: string, args: readonly string[], opts: { timeoutMs: number; env?: Readonly<Record<string, string>> }, sync: boolean) =>
    calls.push({ file, args: [...args], timeoutMs: opts.timeoutMs, ...(opts.env && { env: opts.env }), sync });
  const exec: EngineExec = {
    run: async (file, args, opts) => {
      record(file, args, opts, false);
      return answer(args);
    },
    runSync: (file, args, opts) => {
      record(file, args, opts, true);
      return answer(args);
    },
  };
  const engine = localEngineFrom({
    profile: options.profile ?? DOCKER_PROFILE,
    ...(options.socket && { socket: options.socket }),
    ...(options.findings && { findings: options.findings }),
    exec,
  });
  return Object.assign(engine, { calls, script: (key: string, a: ScriptedAnswer) => void answers.set(key, a) });
}
