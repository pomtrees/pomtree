import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelEntry {
  provider: string;
  id: string;
  label?: string;
  default?: boolean;
}
export interface ModelList {
  models: ModelEntry[];
  default?: { provider: string; id: string };
  source: "pi" | "none";
  reason?: string;
}
export interface ModelCatalog {
  list(): Promise<ModelList>;
}

// Pure: parse `pi --list-models` (a whitespace table: provider, model, context, max-out, thinking, images).
// Rows with fewer than two columns, the header, and "No models" notices are skipped. Duplicates collapse.
export function parsePiModelList(out: string): ModelEntry[] {
  const seen = new Set<string>();
  const models: ModelEntry[] = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // Prose such as 'No models matching "x"' has no table shape: a data row's third column is a context size.
    if (cols.length < 3 || !/^[a-z0-9][\w.-]*$/.test(cols[0]!) || !/^[\d.]+[KMB]?$/i.test(cols[2]!)) continue;
    if (cols[0] === "provider" && cols[1] === "model") continue;
    const [provider, id] = cols as [string, string];
    const key = `${provider}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ provider, id, label: `${id} (${cols[2]} ctx)` });
  }
  return models;
}

// Pure: the spawn default for a model-less spawn: the first listed model (of `provider` when given).
export function firstModel(models: readonly ModelEntry[], provider?: string): { provider: string; id: string } | undefined {
  const m = models.find((x) => !provider || x.provider === provider);
  return m && { provider: m.provider, id: m.id };
}

// Pure: the spawn default: Pi's settings default when it is listed (for `provider` when given), else the first listed model.
export function pickDefault(
  models: readonly ModelEntry[],
  provider?: string,
  piDefault?: { provider?: string; id?: string },
): { provider: string; id: string } | undefined {
  const inScope = models.filter((m) => !provider || m.provider === provider);
  const pi = piDefault?.id ? inScope.find((m) => m.id === piDefault.id && (!piDefault.provider || m.provider === piDefault.provider)) : undefined;
  return firstModel(pi ? [pi] : inScope);
}

// Pure: combine parsed rows into the API shape; the default is pickDefault over `provider`.
export function buildModelList(opts: {
  parsed: ModelEntry[] | null;
  failure?: string;
  provider?: string;
  piDefault?: { provider?: string; id?: string };
}): ModelList {
  const { parsed, provider } = opts;
  if (parsed && parsed.length > 0) {
    const pick = pickDefault(parsed, provider, opts.piDefault);
    const models = parsed.map((m) => (pick && m.provider === pick.provider && m.id === pick.id ? { ...m, default: true } : m));
    return { models, ...(pick && { default: pick }), source: "pi" };
  }
  return { models: [], source: "none", reason: opts.failure ?? "pi listed no models" };
}

export type ExecFn = (cmd: string, args: string[], opts: { timeoutMs: number; maxBytes: number }) => Promise<string>;

export const execFileText: ExecFn = (cmd, args, { timeoutMs, maxBytes }) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: maxBytes, encoding: "utf8", cwd: homedir() }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

// Reads only the two default-model keys from Pi's settings.json (never auth.json).
export function readPiDefault(path = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json")): {
  provider?: string;
  id?: string;
} {
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as { defaultProvider?: unknown; defaultModel?: unknown };
    return {
      ...(typeof s.defaultProvider === "string" && { provider: s.defaultProvider }),
      ...(typeof s.defaultModel === "string" && { id: s.defaultModel }),
    };
  } catch {
    return {};
  }
}

export function piModelCatalog(
  opts: {
    piBin?: string;
    exec?: ExecFn;
    provider?: string; // the provider the default is chosen from
    piDefault?: () => { provider?: string; id?: string };
    now?: () => number;
    ttlMs?: number;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): ModelCatalog {
  const exec = opts.exec ?? execFileText;
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 60_000;
  let cached: { at: number; value: ModelList } | undefined;
  let inflight: Promise<ModelList> | undefined;
  const load = async (): Promise<ModelList> => {
    try {
      const out = await exec(opts.piBin ?? "pi", ["--list-models"], { timeoutMs: opts.timeoutMs ?? 15_000, maxBytes: opts.maxBytes ?? 1_000_000 });
      return buildModelList({ parsed: parsePiModelList(out), provider: opts.provider, piDefault: (opts.piDefault ?? readPiDefault)() });
    } catch (e) {
      return buildModelList({
        parsed: null,
        failure: `pi --list-models failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`.slice(0, 200),
      });
    }
  };
  return {
    async list() {
      if (cached && now() - cached.at < ttl) return cached.value;
      inflight ??= load()
        .then((value) => {
          cached = { at: now(), value };
          return value;
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },
  };
}
