import { hostname } from "node:os";
import { SANDBOX_PORT_VERSION, type ExtParamDecl, type SandboxBackendDeps, type SandboxBackendProvider } from "@pomtree/core";
import manifest from "../manifest.json" with { type: "json" };
import { SAIL_BACKEND } from "./api.ts";
import { SAIL_DECLARATION, SailSandbox } from "./sail.ts";

// The Sailboxes provider. Static: its declaration and params are readable without creating anything, and
// `create` only builds the adapter object (no request is made until a port method is called). The keys are the ones manifest.json
// gives the config composer; provider.test.ts pins the two together. Registering it as a built-in is the registration task's job.

const entry = manifest.sandboxBackends.find((b) => b.id === SAIL_BACKEND);
if (entry === undefined) throw new Error(`packages/sandbox-sail/manifest.json declares no backend ${SAIL_BACKEND}; add its entry (id, params, credentials)`);
const params = entry.params as ExtParamDecl[];
const DEFAULT_BASE_URL = params.find((p) => p.key === "baseUrl")?.default as string;

const key = (k: string) => `sandbox.${SAIL_BACKEND}.${k}`;

export const sailProvider: SandboxBackendProvider = {
  id: SAIL_BACKEND,
  portVersion: SANDBOX_PORT_VERSION,
  declaration: SAIL_DECLARATION,
  params,
  credentials: entry.credentials,
  create(deps: SandboxBackendDeps): SailSandbox {
    const region = deps.config[key("region")];
    if (typeof region === "string" && region !== "") {
      throw new Error(
        `sandbox.${SAIL_BACKEND}.region is ${JSON.stringify(region)}, but Sailboxes documents no regions, so the adapter cannot honour it; unset sandbox.${SAIL_BACKEND}.region`,
      );
    }
    const baseUrl = deps.config[key("baseUrl")];
    // The daemon's own rule for host.id (unset: os.hostname()), so the tags name the same host the daemon stamps on its records.
    const host = deps.config["host.id"];
    return new SailSandbox({
      baseUrl: typeof baseUrl === "string" && baseUrl !== "" ? baseUrl : DEFAULT_BASE_URL,
      request: deps.request,
      credential: deps.credential,
      log: deps.log,
      now: deps.now,
      host: typeof host === "string" && host !== "" ? host : hostname(),
    });
  },
};
