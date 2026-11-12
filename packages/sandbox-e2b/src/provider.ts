import { type ExtParamDecl, SANDBOX_PORT_VERSION, type SandboxBackendDeps, type SandboxBackendProvider } from "@pomtree/core";
import manifest from "../manifest.json" with { type: "json" };
import { API_KEY_CREDENTIAL, E2BApi } from "./api.ts";
import { BACKEND_ID } from "./metadata.ts";
import { E2B_DECLARATION, E2B_MAX_LIFETIME_MS, E2BSandbox } from "./sandbox.ts";

// The provider object of the E2B hosted backend. Static: its declaration, params and credential names
// are readable without creating anything, and `create` only builds the adapter (it makes no request). The keys are the ones
// packages/sandbox-e2b/manifest.json gives the config composer; provider.test.ts pins the two together. Registering the provider in
// pomtreed's BUILTIN_BACKENDS is TODO(e2b-builtin-registration); current behavior: selecting e2b refuses to start.

const entry = manifest.sandboxBackends.find((b) => b.id === BACKEND_ID);
if (entry === undefined) throw new Error(`packages/sandbox-e2b/manifest.json declares no backend ${BACKEND_ID}; add its entry (id, params, credentials)`);

// The standard lease key every backend gets (core STANDARD_SANDBOX_KEYS); its default is 15 minutes.
const DEFAULT_LEASE_MS = 900_000;
const key = (k: string) => `sandbox.${BACKEND_ID}.${k}`;

function stringParam(config: Readonly<Record<string, unknown>>, name: string): string {
  const v = config[key(name)];
  if (v === undefined) return (entry?.params.find((p) => p.key === name)?.default as string | undefined) ?? "";
  if (typeof v !== "string") throw new Error(`${key(name)} is not a string; set it to a string value`);
  return v;
}

// https, or http to a loopback address only (a local test endpoint); the API key must never travel in clear text off the machine.
export function checkBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${key("baseUrl")} ${JSON.stringify(raw)} is not a URL; set it to the E2B API address, for example https://api.e2b.dev`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${key("baseUrl")} uses ${url.protocol} to a non-loopback host, which would send the API key in clear text; use an https: URL`);
  }
  return raw;
}

// The create-time timeout: the configured lease in whole seconds, never past E2B's hard lifetime.
export function timeoutSeconds(config: Readonly<Record<string, unknown>>): number {
  const lease = config[key("leaseMs")] ?? DEFAULT_LEASE_MS;
  if (typeof lease !== "number" || !Number.isFinite(lease) || lease < 1000) {
    throw new Error(`${key("leaseMs")} is ${String(lease)}; set it to 1000 ms or more (E2B timeouts are whole seconds)`);
  }
  return Math.min(Math.ceil(lease / 1000), E2B_MAX_LIFETIME_MS / 1000);
}

export const e2bProvider: SandboxBackendProvider = {
  id: BACKEND_ID,
  portVersion: SANDBOX_PORT_VERSION,
  declaration: E2B_DECLARATION,
  params: entry.params as ExtParamDecl[],
  credentials: entry.credentials,
  create(deps: SandboxBackendDeps): E2BSandbox {
    const api = new E2BApi({
      baseUrl: checkBaseUrl(stringParam(deps.config, "baseUrl")),
      request: deps.request,
      apiKey: () => deps.credential(API_KEY_CREDENTIAL),
    });
    return new E2BSandbox({ api, template: stringParam(deps.config, "template"), timeoutS: timeoutSeconds(deps.config), log: deps.log, now: deps.now });
  },
};
