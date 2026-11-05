import type { AllowlistProfile } from "@pomtree/core";
import { ANALYST_EXT, ANALYST_TOOLS } from "../ext/pomtree-analyst/analyst-contract.ts";
import { SPECIALIST_EXT, SPECIALIST_TOOLS } from "../ext/pomtree-specialist/specialist-contract.ts";

const BROWSE_TOOL = "web_fetch";
const BROWSE_EXT = "/opt/pomtree/ext/web_fetch";

// The one definition of every tool-allowlist profile a template may name (core ALLOWLIST_PROFILES): the exact Pi tool names and the one
// in-image extension that provides them. Exhaustive over core's closed list (a new profile without an entry fails the typecheck). The host
// resolves a spawn spec's profile here (pomtreed command argv) and the digest's live runtime reads the same entry, so there is no second copy.
// Shaped like harness-pi's PiAllowlist (agent-image cannot import harness-pi).
export const ALLOWLIST_PROFILE_TOOLS: Readonly<Record<AllowlistProfile, { readonly tools: readonly string[]; readonly extension: string }>> = {
  analyst: { tools: ANALYST_TOOLS, extension: ANALYST_EXT },
  // The default loadout's own web_fetch shim (it relays to the host gateway through pomtree by absolute path, so it needs no shell); only its tool is offered.
  browse: { tools: [BROWSE_TOOL], extension: BROWSE_EXT },
  specialist: { tools: SPECIALIST_TOOLS, extension: SPECIALIST_EXT },
};
