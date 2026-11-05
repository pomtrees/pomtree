import type { SpawnSpec } from "@pomtree/core";
import { isAllowlistProfile, isBrowserProfile, systemPromptProblem } from "@pomtree/core";
import { ALLOWLIST_PROFILE_TOOLS } from "@pomtree/agent-image";
import { piArgv } from "@pomtree/harness-pi";

// TODO(harness-driver): move Pi specifics behind the Harness port as a driver. Current behavior: harnessArgv in this file builds
// the Pi argv with piArgv from harness-pi, and main.ts wires it into the daemon as the harness command.
// The Pi argv for a spawn spec. A spec whose template named an allowlist profile gets exactly that profile's tools and extension
// (ALLOWLIST_PROFILE_TOOLS) and never the default loadout (bash, read, write, edit, web, steer, jobs); an unknown profile throws, so a
// corrupted or newer spec cannot fall through to the default. A spec with no profile gets the default loadout.
// A spec's systemPrompt (a template's instructions) is delivered as one `--append-system-prompt <text>` value just before the `--` prompt
// separator, on every path (default, allowlist, and the browser worker, which passes unrecognised flags through): APPENDED, so Pi's built-in
// tool guidance stays. One argv element, so text such as `--tools bash` is data, never a flag. Absent or empty, the argv is exactly piArgv's.
// On the standard worker this is a SECOND `--append-system-prompt` after piArgv's guide flag. That is deliberate: the pinned Pi (1.1.0) collects
// every occurrence (cli/args.js pushes each into an array) and joins the resolved values with a blank line in order (agent-session.js), so
// the guide then the template prompt both reach the model; each value is read as a file if it is an existing path, else as literal text.
// A spec whose browser block names the interactive profile gets only the events sink, no agent guide and no default loadout extensions: the
// in-image browser worker (agent-image browser-run.ts) appends that profile's tools, its extension and its prompt preamble. A browser block
// without a profile (the capture worker) keeps today's argv exactly; an unknown profile throws.
export function harnessArgv(
  task: string,
  spec: (Pick<SpawnSpec, "model" | "provider" | "allowlist" | "browser"> & { systemPrompt?: string | null }) | undefined,
  loadout: { steerExt: boolean; jobsExt: boolean },
): string[] {
  const argv = baseArgv(task, spec, loadout);
  const prompt = spec?.systemPrompt;
  if (prompt === undefined || prompt === null || prompt === "") return argv;
  const problem = systemPromptProblem(prompt);
  if (problem !== undefined) throw new Error(problem);
  const sep = argv.length - 2;
  if (argv[sep] !== "--") throw new Error("harnessArgv: expected the prompt separator before the task");
  return [...argv.slice(0, sep), "--append-system-prompt", prompt, ...argv.slice(sep)];
}

function baseArgv(
  task: string,
  spec: Pick<SpawnSpec, "model" | "provider" | "allowlist" | "browser"> | undefined,
  loadout: { steerExt: boolean; jobsExt: boolean },
): string[] {
  // The model is resolved at spawn (pick, template, parent, or the catalog's first); none here means no catalog.
  const model = spec?.model;
  const provider = model === undefined ? undefined : spec?.provider;
  const route = { ...(provider !== undefined && { provider }), ...(model !== undefined && { model }) };
  const browserProfile: unknown = spec?.browser?.profile;
  if (browserProfile !== undefined) {
    if (!isBrowserProfile(browserProfile)) throw new Error(`unknown browser profile ${JSON.stringify(browserProfile)}`);
    if (spec?.allowlist !== undefined) throw new Error("a browser profile excludes an allowlist profile");
    return piArgv({ prompt: task, ...route, extSet: "events", guide: false });
  }
  const profile: unknown = spec?.allowlist;
  if (profile !== undefined) {
    if (!isAllowlistProfile(profile)) throw new Error(`unknown allowlist profile ${JSON.stringify(profile)}`);
    return piArgv({ prompt: task, ...route, allowlist: ALLOWLIST_PROFILE_TOOLS[profile] });
  }
  return piArgv({ prompt: task, steerExt: loadout.steerExt, jobsExt: loadout.jobsExt, ...route });
}
