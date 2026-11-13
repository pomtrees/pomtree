// Pure opt-in gate for live provider tests (real vendor calls that spend money). Returns a skip reason or false, like
// `imageRevisionSkip`. Every input is injected, so the gate reads nothing from the machine and makes no call itself.
//
// - `PTREE_LIVE_PROVIDERS=<id>[,<id>...]` lists adapter ids (built-in or contributed). `all` is refused, and credentials
//   alone never enable a test.
// - Credentials come from the provider's declared names through `POMTREED_SANDBOX_<ID>_<CRED>_FILE`; the file must be an
//   absolute path to a non-empty regular file with no group or other permission bits (the rule in
//   packages/core/src/config/resolve.ts). A raw key in `POMTREED_SANDBOX_<ID>_<CRED>` is refused.
// - `PTREE_LIVE_MAX_MICROS` (millionths of a dollar, docs/economy.md) must be at least the test's declared ceiling.
// Every problem found is listed at once; no path contents or values are printed.
import { isAbsolute } from "node:path";

export const LIVE_PROVIDERS_ENV = "PTREE_LIVE_PROVIDERS";
export const LIVE_MAX_MICROS_ENV = "PTREE_LIVE_MAX_MICROS";

export interface LiveGateInput {
  env: Readonly<Record<string, string | undefined>>;
  /** The credential names the adapter declares (for example `API_KEY`); the gate derives the env names from them. */
  credentials: readonly string[];
  /** Stat of a path, or undefined when it does not exist. */
  stat: (path: string) => { mode: number; size: number; isFile: boolean } | undefined;
}

const envId = (provider: string): string => provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");

export function liveSkip(provider: string, ceilingMicros: number, input: LiveGateInput): string | false {
  const { env, credentials, stat } = input;
  const listed = (env[LIVE_PROVIDERS_ENV] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (listed.includes("all")) {
    return `${LIVE_PROVIDERS_ENV} contains "all", which is not accepted because it would enable paid providers silently; list ids explicitly, for example ${LIVE_PROVIDERS_ENV}=${provider}`;
  }
  if (!listed.includes(provider)) {
    return `${LIVE_PROVIDERS_ENV} does not list ${provider} (live calls spend money; credentials alone do not enable them); set ${LIVE_PROVIDERS_ENV}=${provider} to opt in`;
  }
  const problems: string[] = [];
  if (!Number.isInteger(ceilingMicros) || ceilingMicros < 0) {
    problems.push(
      `the test's declared ceiling ${String(ceilingMicros)} is not a non-negative whole number of micros, so no cap can be enforced; fix the test's ceiling`,
    );
  }
  if (credentials.length === 0) {
    problems.push(`the ${provider} test declares no credentials, so nothing proves the run is authorised; declare the credential names the adapter needs`);
  }
  const cap = env[LIVE_MAX_MICROS_ENV];
  const capMicros = cap !== undefined && /^[0-9]+$/.test(cap) ? Number(cap) : undefined;
  if (capMicros === undefined) {
    problems.push(
      `${LIVE_MAX_MICROS_ENV} is ${cap === undefined ? "unset" : "not a whole number of micros"}; set it to the most you will spend, in millionths of a dollar (this test needs at least ${ceilingMicros})`,
    );
  } else if (ceilingMicros > capMicros) {
    problems.push(
      `the test's worst-case cost ${ceilingMicros} micros exceeds ${LIVE_MAX_MICROS_ENV}=${capMicros}; raise the cap to at least ${ceilingMicros} or do not run this test`,
    );
  }
  for (const cred of credentials) {
    const raw = `POMTREED_SANDBOX_${envId(provider)}_${cred}`;
    const fileVar = `${raw}_FILE`;
    if (env[raw] !== undefined)
      problems.push(`${raw} carries a raw key, which every child process would inherit; unset it and point ${fileVar} at a mode 600 file`);
    const file = env[fileVar];
    if (file === undefined || file === "") {
      problems.push(`${fileVar} is unset; point it at an absolute path to a mode 600 file holding the ${provider} ${cred}`);
    } else if (!isAbsolute(file)) {
      problems.push(`${fileVar} is not an absolute path; use an absolute path`);
    } else {
      const st = stat(file);
      if (st === undefined || !st.isFile) problems.push(`${fileVar} names ${file}, which is not an existing regular file; create it or fix the path`);
      else if ((st.mode & 0o077) !== 0) problems.push(`${fileVar} names ${file}, which is readable by group/other; run chmod 600 ${file}`);
      else if (st.size === 0) problems.push(`${fileVar} names ${file}, which is empty; write the ${cred} into it`);
    }
  }
  return problems.length === 0 ? false : `live ${provider} test not run: ${problems.join("; ")}`;
}
