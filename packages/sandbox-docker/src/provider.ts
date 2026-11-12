import { SANDBOX_PORT_VERSION, type ExtParamDecl, type SandboxBackendDeps, type SandboxBackendProvider, type SandboxDeclaration } from "@pomtree/core";
import manifest from "../manifest.json" with { type: "json" };
import { DOCKER_DECLARATION, DockerSandbox, type DockerDeps } from "./docker.ts";
import type { EngineId } from "./engine-profile.ts";
import type { LocalEngine } from "./local-engine.ts";

// The registry (pomtreed's sandbox-backends) supplies `deps.local` beside the standard deps; see LocalBackendDeps.
// The provider objects for the two local container engines. A provider is static: its declaration
// and params are readable without creating anything, and `create` only builds the adapter object (it opens no socket and runs no CLI).
// The keys it declares are the same ones packages/sandbox-docker/manifest.json gives the config composer; provider.test.ts pins the two together.

// What the daemon's host-side wiring supplies that SandboxBackendDeps does not carry: the engine object (profile and resolved socket,
// built once by openLocalEngine) and the adapter's own host dependencies (mounts, audit root, egress image ...). Local engines need none
// of the deps' fetch, request or credential members.
export interface LocalBackendWiring {
  readonly engine: LocalEngine;
  readonly docker: Omit<DockerDeps, "profile" | "socket">;
}
export type LocalBackendDeps = SandboxBackendDeps & { readonly local: LocalBackendWiring };

// `create` is declared with method syntax, so a LocalBackendProvider is assignable to SandboxBackendProvider; the registry passes
// `local` beside the standard deps.
export interface LocalBackendProvider extends SandboxBackendProvider {
  create(deps: LocalBackendDeps): DockerSandbox;
}

// Podman declares what its argv path implements and the design has verified. Left out against the Docker declaration:
// - egress.denyAll: the Docker path enforces default-deny with a shared bridge network that has inter-container communication off;
//   Podman has no equivalent (the rootless sidecar sits on a per-container pasta network, unverified), so it is not claimed.
// - egress.allowHost: the sidecar allowlist only holds when denyAll does, so a template that sets egress still starts on Podman,
//   and its egress isolation is not enforced (nothing refuses a template the backend cannot honour; bootNeeds hard-codes egress:false).
// - isolation.gvisor: detection of `runsc` on Podman is inferred from documentation, not run, so Podman does not declare it (a gVisor template is not refused at boot either; see the sandbox-template-admission marker in pomtreed).
// Everything else is the shared argv floor (terminal, host mounts, image pull and digest identity, tag listing, host alias, resource
// limits, seccomp, ipv6 sysctl); resources.limits is narrowed at runtime by the engine probe on a rootless host without cgroup v2 delegation.
// TODO(podman-inferred-details): Podman error patterns and the info and gateway-inspect formats come from documentation and fixtures, not a real Podman;
// `firewallHint` and the onboarding steps stay Docker-only and the doctor payload carries no engine id. Run against a real Podman and fix.
// TODO(podman-egress-isolation): security-relevant fail-open: Podman does not declare egress.denyAll or egress.allowHost, yet nothing refuses a
// template that sets egress (see the sandbox-template-admission marker in pomtreed), so such a template still starts and its egress is not isolated.
// Trigger: before Podman is documented as a supported backend or a template relies on egress isolation. Fix: declare both once the gated
// Podman suites pass the rootless sidecar path.
export const PODMAN_DECLARATION: SandboxDeclaration = {
  ...DOCKER_DECLARATION,
  backend: "podman",
  capabilities: {
    ...DOCKER_DECLARATION.capabilities,
    "egress.denyAll": false,
    "egress.allowHost": false,
    "isolation.gvisor": false,
    loopback: false, // the Podman loopback stream has not run against a real Podman
  },
};

// The manifest is the one definition of the keys: the config composer reads the file, and the provider's params are the same entries.
const manifestParams = (id: string): readonly ExtParamDecl[] => {
  const entry = manifest.sandboxBackends.find((b) => b.id === id);
  if (entry === undefined) throw new Error(`packages/sandbox-docker/manifest.json declares no backend ${id}; add its entry (id and params)`);
  return entry.params as ExtParamDecl[];
};

function localProvider(id: EngineId, declaration: SandboxDeclaration): LocalBackendProvider {
  return {
    id,
    portVersion: SANDBOX_PORT_VERSION,
    declaration,
    params: manifestParams(id),
    credentials: [],
    create(deps: LocalBackendDeps) {
      const local = (deps as Partial<LocalBackendDeps>).local;
      if (local === undefined) {
        throw new Error(
          `sandbox backend ${id} needs the local engine wiring (deps.local: the LocalEngine and the adapter's host dependencies); the daemon's composition root passes it, so add it where the ${id} provider is created`,
        );
      }
      if (local.engine.id !== id) {
        throw new Error(
          `sandbox backend ${id} was given the ${local.engine.id} engine; open the engine for sandbox.backend ${id} (openLocalEngine selection "${id}") and pass that one`,
        );
      }
      return new DockerSandbox({ ...local.docker, ...local.engine.sandboxDeps(), declaration });
    },
  };
}

export const dockerProvider: LocalBackendProvider = localProvider("docker", DOCKER_DECLARATION);
export const podmanProvider: LocalBackendProvider = localProvider("podman", PODMAN_DECLARATION);
