// The one assembler of SetupFacts for the real checkout (cli.ts, the GETTING_STARTED generator and the drift tests all call it), so
// the registry-derived extras cannot drift between them. steps.ts stays dependency-free; the registry and git floor arrive here.
import { CONFIG_DEFAULTS, CONFIG_REGISTRY } from "@pomtree/core";
import { MIN_SAFE_GIT } from "@pomtree/workspace-git";
import { type SetupFacts, setupFacts } from "./steps.ts";

/** SetupFacts from the root package.json text, with every optional fact filled from the config registry. */
export function defaultSetupFacts(rootPackageJson: string): SetupFacts {
  return setupFacts(rootPackageJson, MIN_SAFE_GIT, CONFIG_DEFAULTS["agent.image"], {
    reapedGraceMs: CONFIG_DEFAULTS["folder.reapedGraceMs"],
    sessionDefaultMs: CONFIG_DEFAULTS["session.defaultMs"],
    egressProxyImageEnv: CONFIG_REGISTRY.envOf.get("agent.egressProxyImage") as string,
    stateDirEnv: CONFIG_REGISTRY.envOf.get("state.dir") as string,
  });
}
