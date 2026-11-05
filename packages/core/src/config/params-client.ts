// Registry entries for what the pomtree client reads from its environment beyond the shared daemon keys (state.dir and
// wait.yieldMs, in params-daemon.ts, list the client among their consumers). The connection vars POMTREE_TOKEN, POMTREE_API and
// POMTREE_SOCKET are the contract pomtreed injects into containers, so they stay outside (exclusions.ts).
// The pomtree client reads its key's live name (POMTREE_CLIENT_DEBUG) directly from its env by design: pomtree ships inside the agent
// image without the resolver, so this entry declares the name and default, and the registry refuses any other POMTREE_ name.
import type { ParamDef } from "./registry.ts";

const POMTREE = "@pomtree/pomtree";

export const CLIENT_PARAMS = [
  {
    path: "client.debug",
    kind: "bool",
    default: false,
    doc: "Rethrow unexpected CLI failures with their stack instead of one line.",
    scope: "operator",
    consumers: [POMTREE],
  },
] as const satisfies readonly ParamDef[];
