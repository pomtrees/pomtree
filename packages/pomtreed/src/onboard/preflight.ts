// `pomtreed preflight [--json]`: probe the host, evaluate findings, render them with the fix text from the onboarding steps. Pure over an
// injected ProbeRunner and host facts; cli.ts supplies the real ones. Optional tooling: nothing in the daemon's runtime path uses it.
import { isAbsolute } from "node:path";
import { type Finding, evaluateObservations, fixOf, hasError } from "./findings.ts";
import { parseFlags } from "./flags.ts";
import { type ProbeHost, type ProbeRunner, gatherObservations } from "./probes.ts";
import type { OnboardingStep } from "./steps.ts";

export const PREFLIGHT_USAGE = `usage: pomtreed preflight [--json] [--repo DIR] [--state DIR] [--image REF] [--key-file FILE]
  --json       print { ok, findings } as JSON, each fix inline
  --repo DIR   the repository agents work on, an absolute path (no default: without it the repository is not checked)
  --state DIR  the state directory (default: ~/.pomtreed)
  --image REF  the agent image (default: the agent.image default)
  --egress-image REF  the egress-proxy sidecar image pomtreed is configured with (default: the agent image)
  --key-file F also check the key file's mode and owner (it is never opened)
Exit 0 when no finding is an error, 1 when any is, 2 for a usage error.`;

export interface PreflightEnv {
  runner: ProbeRunner;
  /** Everything of the host except the flag-dependent paths; flags override repoDir (no default in the shell), stateDir, image and keyFile. */
  host: Omit<ProbeHost, "keyFile">;
  steps: readonly OnboardingStep[];
}

export interface CommandResult {
  code: number;
  lines: string[];
}

export function renderText(findings: readonly Finding[], steps: readonly OnboardingStep[]): string[] {
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(`[${f.severity}] ${f.id}: ${f.message}`);
    const fix = fixOf(f, steps);
    if (fix === undefined) continue;
    lines.push(`  fix (${fix.step}): ${fix.title}`);
    for (const c of fix.commands) lines.push(`    ${c.needsRoot ? "(run as root yourself) " : ""}${c.network ? "(needs network) " : ""}${c.run}`);
  }
  return lines;
}

export function renderJson(findings: readonly Finding[], steps: readonly OnboardingStep[]): string {
  return JSON.stringify(
    {
      ok: !hasError(findings),
      findings: findings.map((f) => {
        const fix = fixOf(f, steps);
        return { ...f, ...(fix !== undefined && { fix: { step: fix.step, commands: fix.commands } }) };
      }),
    },
    null,
    2,
  );
}

export async function runPreflight(argv: readonly string[], env: PreflightEnv): Promise<CommandResult> {
  const p = parseFlags(argv, { bools: ["--json"], values: ["--repo", "--state", "--image", "--egress-image", "--key-file"] });
  const errors = [...p.errors, ...p.positional.map((a) => `unexpected argument ${a}`)];
  const repoDir = p.values.get("--repo") ?? env.host.repoDir;
  if (repoDir !== undefined && !isAbsolute(repoDir)) errors.push(`--repo ${repoDir} must be an absolute path`);
  if (errors.length > 0) return { code: 2, lines: [...errors.map((e) => `pomtreed preflight: ${e}`), PREFLIGHT_USAGE] };
  const keyFile = p.values.get("--key-file");
  const host: ProbeHost = {
    ...env.host,
    ...(repoDir !== undefined && { repoDir }),
    stateDir: p.values.get("--state") ?? env.host.stateDir,
    image: p.values.get("--image") ?? env.host.image,
    ...((p.values.get("--egress-image") ?? env.host.egressImage) !== undefined && {
      egressImage: (p.values.get("--egress-image") ?? env.host.egressImage) as string,
    }),
    ...(keyFile !== undefined && { keyFile }),
  };
  const findings = evaluateObservations(await gatherObservations(host, env.runner), env.steps);
  return { code: hasError(findings) ? 1 : 0, lines: p.bools.has("--json") ? [renderJson(findings, env.steps)] : renderText(findings, env.steps) };
}
