import {
  admitBackend,
  SANDBOX_BACKEND_AUTO,
  validateDeclaration,
  type BackendNeeds,
  type SandboxBackendDeps,
  type SandboxBackendProvider,
  type SandboxDeclaration,
  type SandboxRequester,
} from "@pomtree/core";
import {
  dockerProvider,
  engineProfile,
  type EngineId,
  type EngineSelection,
  type LocalBackendProvider,
  type LocalBackendWiring,
  type LocalEngine,
  type OpenLocalEngineInput,
  podmanProvider,
} from "@pomtree/sandbox-docker";
import { createRequest } from "@pomtree/sandbox-kit";
import { createSandboxBackendDeps } from "./sandbox-backend-deps.ts";
import {
  indexSandboxProviders,
  type LoaderFs,
  type LoadedSandboxExtension,
  parseReviewedBackends,
  verifyContributedProvider,
} from "./sandbox-provider-load.ts";

// The sandbox backend registry: the first-party built-ins this build carries plus the backends extensions contribute. `resolveBackend`
// maps `sandbox.backend` to exactly one of them; nothing else is looked up or constructed. `auto` considers only the local engines
// (docker, podman), through the engine detector, and never a hosted or contributed backend. A contributed backend is checked against
// its content-hash pin without importing its module, and then refused, because this build runs agents only on the local engines.
// Boot admission (`admitAtBoot`) runs the core rules on the selected local engine's declaration. main.ts is the only production
// caller; everything here takes its ports by injection.

// A first-party backend id and, when this build carries its adapter, the provider. kubernetes, sail and e2b are reserved built-in
// ids whose adapters are not in this build yet (selecting one refuses the start); registering one is adding its provider here.
export interface BuiltinBackend {
  readonly id: string;
  // A local container engine on the operator's own machine: `auto` may pick it, it is opened through the engine detector, and it
  // may take the agent token in the container env without sandbox.secretsInEnv (bootNeeds). Hosted built-ins are never local.
  readonly localEngine: boolean;
  readonly provider?: () => SandboxBackendProvider;
}

export const BUILTIN_BACKENDS: readonly BuiltinBackend[] = [
  { id: "docker", localEngine: true, provider: () => dockerProvider },
  { id: "podman", localEngine: true, provider: () => podmanProvider },
  { id: "kubernetes", localEngine: false },
  { id: "sail", localEngine: false },
  { id: "e2b", localEngine: false },
];

// What the registry needs from the installed extensions: the contributed ids (from the manifests, nothing imported) and the pin check.
export interface ContributedSource {
  ids(): readonly { id: string; extension: string }[];
  // Checks the selected backend's manifest entry, containment and content-hash pin, importing nothing; throws with the cause and
  // the action (unpinned, pin mismatch, port version, entry outside the directory ...). Returns the realpathed directory and the pin.
  verify(id: string): { dir: string; pin: string };
}

export interface ContributedSourceOptions {
  extensions: readonly LoadedSandboxExtension[];
  reviewedBackends: readonly string[]; // sandbox.reviewedBackends
  fs?: LoaderFs;
}

// The contributed half of the registry. Indexing the manifests refuses an invalid id, an id two extensions provide (naming both) and
// one that collides with a built-in, before anything is selected.
export function createContributedSource(o: ContributedSourceOptions): ContributedSource {
  const index = indexSandboxProviders(
    o.extensions,
    BUILTIN_BACKENDS.map((b) => b.id),
  );
  const pins = parseReviewedBackends(o.reviewedBackends);
  return {
    ids: () => [...index].map(([id, { ext }]) => ({ id, extension: ext.manifest.name })),
    verify(id) {
      const v = verifyContributedProvider(id, index, pins, o.fs);
      return { dir: v.dirReal, pin: v.tree.hash };
    },
  };
}

export interface BackendRegistry {
  readonly builtins: readonly BuiltinBackend[];
  readonly contributed: ContributedSource;
}

export function createBackendRegistry(o: ContributedSourceOptions): BackendRegistry {
  return { builtins: BUILTIN_BACKENDS, contributed: createContributedSource(o) };
}

// The selectable values, for refusals: `auto`, the built-ins this build carries, and each contributed id with its extension.
export function availableBackends(registry: BackendRegistry): string {
  return [
    SANDBOX_BACKEND_AUTO,
    ...registry.builtins.filter((b) => b.provider !== undefined).map((b) => b.id),
    ...registry.contributed.ids().map((c) => `${c.id} (extension ${c.extension})`),
  ].join(", ");
}

export type ResolvedBackend =
  | {
      readonly origin: "builtin";
      readonly localEngine: true;
      readonly id: EngineId;
      readonly provider: LocalBackendProvider;
      readonly engine: LocalEngine;
    }
  | { readonly origin: "builtin"; readonly localEngine: false; readonly id: string; readonly provider: SandboxBackendProvider }
  // A contributed backend whose pin matched; its module has not been imported.
  | { readonly origin: "extension"; readonly localEngine: false; readonly id: string; readonly extension: string; readonly dir: string };

export interface OpenLocalFromConfigInput {
  backendConfig: (id: string) => Readonly<Record<string, unknown>>; // LoadedDaemonConfig.backendConfig
  env: Readonly<Record<string, string | undefined>>;
  open: (input: OpenLocalEngineInput) => Promise<LocalEngine>;
}

// The `openLocal` of resolveBackend: opens the engine with each engine's own configured socket (`sandbox.<id>.socket`, empty =
// detect), so an explicit engine reads only its own key (the other engine's socket is never read) and `auto` reads both.
export function openLocalFromConfig(i: OpenLocalFromConfigInput): (selection: EngineSelection) => Promise<LocalEngine> {
  const socket = (id: EngineId) => i.backendConfig(id)[engineProfile(id).socketConfigKey] as string | undefined;
  return (selection) =>
    i.open({
      selection,
      env: i.env,
      configured: selection === "auto" ? { docker: socket("docker"), podman: socket("podman") } : { [selection]: socket(selection) },
    });
}

// One finding per engine socket key that is set but ignored because `sandbox.backend` names the other engine explicitly.
export function ignoredSocketFindings(selection: string, backendConfig: (id: string) => Readonly<Record<string, unknown>>): string[] {
  if (selection !== "docker" && selection !== "podman") return [];
  const other: EngineId = selection === "docker" ? "podman" : "docker";
  const key = engineProfile(other).socketConfigKey;
  const value = backendConfig(other)[key];
  return typeof value === "string" && value !== ""
    ? [`${key} is set but sandbox.backend is ${selection}; unset it or set sandbox.backend to ${other} or auto`]
    : [];
}

export interface ResolveBackendInput {
  configured: string; // sandbox.backend
  registry: BackendRegistry;
  // Opens the local engine for an engine id or `auto` (openLocalEngine: the detector, which carries every refusal `auto` skipped as
  // a finding and throws on a configuration it refuses).
  openLocal: (selection: EngineSelection) => Promise<LocalEngine>;
}

// Maps `sandbox.backend` to one backend. Throws, naming the cause and the action, for an unknown id, a built-in this build does not
// carry, an `auto` detection that found no engine, and every pin refusal of a contributed backend. Constructs and imports nothing.
export async function resolveBackend(input: ResolveBackendInput): Promise<ResolvedBackend> {
  const { configured, registry } = input;
  const localEngine = (id: string) => registry.builtins.find((b) => b.id === id && b.localEngine && b.provider !== undefined);
  if (configured === SANDBOX_BACKEND_AUTO || localEngine(configured) !== undefined) {
    const engine = await input.openLocal(configured as EngineSelection);
    const builtin = localEngine(engine.id);
    if (builtin?.provider === undefined)
      throw new Error(`the local engine detector selected ${engine.id}, which is not a local backend of this build; set sandbox.backend to docker or podman`);
    return { origin: "builtin", localEngine: true, id: engine.id, provider: builtin.provider() as LocalBackendProvider, engine };
  }
  const builtin = registry.builtins.find((b) => b.id === configured);
  if (builtin !== undefined) {
    if (builtin.provider === undefined)
      throw new Error(
        `built-in backend ${configured} is not available in this build; available: ${availableBackends(registry)}; set sandbox.backend to one of them`,
      );
    return { origin: "builtin", localEngine: false, id: configured, provider: builtin.provider() };
  }
  const contributed = registry.contributed.ids().find((c) => c.id === configured);
  if (contributed === undefined)
    throw new Error(
      `sandbox.backend is ${JSON.stringify(configured)}, which no built-in backend or installed extension provides; available: ${availableBackends(registry)}; set sandbox.backend to one of them, or install the extension that provides it in extensions.dir`,
    );
  const { dir } = registry.contributed.verify(configured);
  return { origin: "extension", localEngine: false, id: configured, extension: contributed.extension, dir };
}

// What every agent needs from the backend, as far as boot knows. The agent token is always delivered, and create-time env delivery
// needs the operator's opt-in (sandbox.secretsInEnv), with one exception: a built-in entry marked `localEngine` (docker, podman) has
// always passed the token in the container env on the operator's own machine and has no post-start channel yet. Hosted built-ins
// (kubernetes, sail, e2b) and contributed backends never take this path. Remove the exception when the local engines gain a
// post-start delivery channel.
// TODO(sandbox-template-admission): check each template's egress and runtime block against the selected declaration when the
// template is admitted. Security-relevant fail-open: boot admits with no egress or isolation need, because templates are read per spawn, and
// nothing refuses a template the backend cannot honour (a Podman template that sets egress still starts, with egress isolation not enforced).
// Trigger: before Podman is documented as a supported backend or a template relies on egress isolation.
export function bootNeeds(resolved: Pick<ResolvedBackend, "origin" | "localEngine">, secretsInEnv: boolean): BackendNeeds {
  return {
    egress: false,
    daemonReach: true,
    terminal: true,
    workspace: "mount",
    secrets: { agentToken: true, envAllowed: secretsInEnv || resolved.localEngine },
  };
}

// Boot admission of the selected backend: the declaration must be registrable (validateDeclaration: an idempotency mechanism of
// none and an unknown capability are refused), and admitBackend's security- and reach-bearing rows refuse. The local engines have no
// readiness probe, so none is passed. Returns one refusal line per reason, each with the cause and the action; [] = admitted.
export function admitAtBoot(declaration: SandboxDeclaration, needs: BackendNeeds): string[] {
  const id = declaration.backend;
  const invalid = validateDeclaration(declaration);
  if (invalid.length > 0) return invalid.map((r) => `sandbox backend ${id} has an invalid declaration: ${r}`);
  const result = admitBackend(declaration, null, needs);
  return result.ok ? [] : result.refusals.map((r) => `sandbox backend ${id} is not admitted: ${r.cause}; ${r.action}`);
}

// A backend that is not a local engine cannot run agents in this build.
// TODO(sandbox-remote-boot): run agents on a backend without host mounts (workspace transfer, post-start credential delivery over
// connect, session event forwarding, a placement that does not assume the local engine). Current behavior: a contributed backend's
// pin is checked without importing its module and the start is refused with this text; nothing is imported, constructed or probed.
// When remote placement lands, loading (SandboxProviderLoader), construction through backendDeps, the readiness probe and boot
// admission of the probed declaration return on this path.
export function remoteBootRefusal(r: Exclude<ResolvedBackend, { localEngine: true }>): string {
  const who = r.origin === "extension" ? `extension ${r.extension}` : "built-in";
  return `sandbox backend ${r.id} (${who}) is selected, but this daemon build runs agents only on the local engines (docker, podman); set sandbox.backend to docker, podman or auto`;
}

export interface BackendDepsInput {
  id: string;
  credentials: readonly string[]; // the provider's declared names
  config: Readonly<Record<string, unknown>>; // LoadedDaemonConfig.backendConfig(id)
  userAgent: string; // workflow.fetch.userAgent
  env: Readonly<Record<string, string | undefined>>;
  log: (event: string, fields: Record<string, unknown>) => void;
  now?: () => number;
  fetch?: typeof fetch;
  request?: SandboxRequester;
}

// The one facade a provider gets (sandbox-backend-deps.ts): the fetch identity stamp and the credential reader scoped to the
// provider's declared names under the shared secret-file mode rule. No provider gets a credential any other way. The local engines
// declare no `run` dep, so none is offered.
export function backendDeps(i: BackendDepsInput): SandboxBackendDeps {
  return createSandboxBackendDeps({
    id: i.id,
    credentials: i.credentials,
    config: i.config,
    userAgent: i.userAgent,
    fetch: i.fetch ?? fetch,
    request: i.request ?? createRequest({ userAgent: i.userAgent }),
    env: i.env,
    log: i.log,
    now: i.now ?? Date.now,
    declaresRun: false,
  });
}

// Constructs the selected local engine's adapter: the provider gets the facade plus the engine and the adapter's host dependencies.
export function createLocalSandbox(provider: LocalBackendProvider, deps: SandboxBackendDeps, local: LocalBackendWiring) {
  return provider.create({ ...deps, local });
}
