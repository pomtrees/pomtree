import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  admitBackend,
  type BackendNeeds,
  checkPortVersion,
  parseSandboxManifest,
  SANDBOX_PORT_VERSION,
  type SandboxBackendConfigDecl,
  type SandboxBackendDeps,
  validateBackendId,
  validateDeclaration,
} from "@pomtree/core";
import { DOCKER_DECLARATION, DockerSandbox } from "./docker.ts";
import { DOCKER_PROFILE, PODMAN_PROFILE } from "./engine-profile.ts";
import { scriptedLocalEngine } from "./local-engine-fake.ts";
import { checkPodmanEgress, podmanEgressProbeResult } from "./podman-egress-probe.ts";
import { type LocalBackendDeps, type LocalBackendProvider, PODMAN_DECLARATION, dockerProvider, podmanProvider } from "./provider.ts";
import { stubMounts } from "./test-mounts.ts";

const MANIFEST_PATH = new URL("../manifest.json", import.meta.url);
const manifestText = () => readFileSync(MANIFEST_PATH, "utf8");

const baseDeps = (): SandboxBackendDeps => ({
  fetch: globalThis.fetch,
  request: Object.assign(
    async () => {
      throw new Error("a local engine makes no HTTP call through the request dep");
    },
    {
      openWebSocket: (): WebSocket => {
        throw new Error("a local engine opens no WebSocket through the dep");
      },
    },
  ),
  credential: async () => {
    throw new Error("a local engine declares no credentials");
  },
  log: () => {},
  now: () => 0,
  config: {},
});
const depsFor = (id: "docker" | "podman"): LocalBackendDeps => ({
  ...baseDeps(),
  local: { engine: scriptedLocalEngine({ profile: id === "podman" ? PODMAN_PROFILE : DOCKER_PROFILE }), docker: { mounts: stubMounts() } },
});

const needs = (over: Partial<BackendNeeds> = {}): BackendNeeds => ({
  egress: false,
  daemonReach: true,
  terminal: false,
  workspace: "mount",
  secrets: { agentToken: false, envAllowed: false },
  ...over,
});

test("podman declares the egress capabilities (verified by the gated rootless suite) but not gVisor or loopback; docker keeps all of them", () => {
  assert.equal(PODMAN_DECLARATION.capabilities["egress.denyAll"], true);
  assert.equal(PODMAN_DECLARATION.capabilities["egress.allowHost"], true);
  assert.equal(PODMAN_DECLARATION.capabilities["isolation.gvisor"], false);
  assert.equal(PODMAN_DECLARATION.capabilities.loopback, false);
  assert.equal(DOCKER_DECLARATION.capabilities.loopback, true);
  assert.equal(DOCKER_DECLARATION.capabilities["egress.denyAll"], true);
  assert.equal(podmanProvider.declaration, PODMAN_DECLARATION);
  assert.equal(PODMAN_DECLARATION.backend, "podman");
  // Every other capability is the shared argv floor, unchanged.
  for (const [cap, v] of Object.entries(DOCKER_DECLARATION.capabilities)) {
    if (!["isolation.gvisor", "loopback"].includes(cap))
      assert.equal(PODMAN_DECLARATION.capabilities[cap as keyof typeof PODMAN_DECLARATION.capabilities], v, cap);
  }
});

// The declaration-level rule; the daemon applies it to each template at spawn and start (pomtreed daemon.template-admission.test.ts).
test("admitBackend admits an egress template against the podman declaration; the boot probe's withheld egress refuses it (fail closed)", () => {
  assert.equal(admitBackend(PODMAN_DECLARATION, null, needs({ egress: true })).ok, true);
  assert.equal(admitBackend(DOCKER_DECLARATION, null, needs({ egress: true })).ok, true);
  const unsupported = podmanEgressProbeResult(checkPodmanEgress("podman: not json"));
  assert.deepEqual(unsupported.withheld, ["egress.denyAll", "egress.allowHost"]);
  const refused = admitBackend(PODMAN_DECLARATION, unsupported, needs({ egress: true }));
  assert.equal(refused.ok, false);
  assert.equal(admitBackend(PODMAN_DECLARATION, unsupported, needs()).ok, true, "an egress-none template still runs on an unsupported Podman");
  // The gVisor omission is a declaration gap, not a probe one.
  assert.equal(admitBackend(PODMAN_DECLARATION, null, needs({ isolation: "gvisor" })).ok, false);
});

test("both declarations pass validateDeclaration; a mutated one fails", () => {
  assert.deepEqual(validateDeclaration(dockerProvider.declaration), []);
  assert.deepEqual(validateDeclaration(podmanProvider.declaration), []);
  const { "egress.denyAll": _drop, ...rest } = PODMAN_DECLARATION.capabilities;
  assert.ok(validateDeclaration({ ...PODMAN_DECLARATION, capabilities: rest as never }).some((r) => r.includes("egress.denyAll")));
  assert.ok(validateDeclaration({ ...PODMAN_DECLARATION, idempotency: "none" }).length > 0);
});

test("providers carry the current port version and a valid built-in id", () => {
  for (const p of [dockerProvider, podmanProvider]) {
    assert.equal(p.portVersion, SANDBOX_PORT_VERSION);
    assert.doesNotThrow(() => checkPortVersion(p.id, p.portVersion));
    assert.equal(p.declaration.backend, p.id);
    assert.deepEqual(p.credentials, []);
    // A built-in id is reserved: it is the registry's, never an extension's.
    assert.throws(() => validateBackendId(p.id), /reserved/);
  }
  assert.equal(dockerProvider.id, "docker");
  assert.equal(podmanProvider.id, "podman");
  assert.throws(() => checkPortVersion("docker", SANDBOX_PORT_VERSION + 1), /port version/);
  assert.throws(() => validateBackendId("Docker!"), /invalid/);
});

test("manifest.json parses through parseSandboxManifest and matches the providers' params", () => {
  const parsed = parseSandboxManifest("sandbox-docker", JSON.parse(manifestText()));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
  assert.deepEqual(parsed.backends.map((b) => b.id).sort(), ["docker", "podman"]);
  for (const p of [dockerProvider, podmanProvider]) {
    const decl: SandboxBackendConfigDecl | undefined = parsed.backends.find((entry) => entry.id === p.id);
    assert.deepEqual(decl?.params, p.params);
    assert.deepEqual(
      p.params.map((x) => [x.key, x.kind, x.default]),
      [["socket", "string", ""]],
    );
    assert.equal(decl?.credentials?.length, 0);
    assert.equal(decl?.defaults, undefined);
  }
});

test("a manifest with a bad key or an unknown field fails to parse", () => {
  const m = JSON.parse(manifestText());
  m.sandboxBackends[0].params[0].kind = "path"; // not declarable in a manifest
  const bad = parseSandboxManifest("sandbox-docker", m);
  assert.equal(bad.ok, false);
  const extra = JSON.parse(manifestText());
  extra.sandboxBackends[1].secret = true;
  assert.equal(parseSandboxManifest("sandbox-docker", extra).ok, false);
});

test("create returns an adapter whose declaration equals the provider's, without running anything", () => {
  for (const p of [dockerProvider, podmanProvider] satisfies LocalBackendProvider[]) {
    const deps = depsFor(p.id as "docker" | "podman");
    const sandbox = p.create(deps);
    assert.ok(sandbox instanceof DockerSandbox);
    assert.deepEqual(sandbox.declaration, p.declaration);
    assert.deepEqual((deps.local.engine as ReturnType<typeof scriptedLocalEngine>).calls, []);
  }
  assert.notDeepEqual(podmanProvider.create(depsFor("podman")).declaration, dockerProvider.create(depsFor("docker")).declaration);
});

test("create refuses missing wiring or an engine of the other kind, naming the action", () => {
  assert.throws(() => (podmanProvider.create as (d: SandboxBackendDeps) => unknown)(baseDeps()), /needs the local engine wiring.*composition root/);
  assert.throws(() => podmanProvider.create(depsFor("docker")), /podman was given the docker engine; open the engine for sandbox.backend podman/);
  assert.throws(() => dockerProvider.create(depsFor("podman")), /docker was given the podman engine/);
});

test("the provider is assignable where the registry expects a SandboxBackendProvider", () => {
  const registry: import("@pomtree/core").SandboxBackendProvider[] = [dockerProvider, podmanProvider];
  assert.equal(registry.length, 2);
});

test("DockerSandbox reports the declaration it is built with; the default is Docker's", () => {
  assert.deepEqual(new DockerSandbox({ mounts: stubMounts() }).declaration, DOCKER_DECLARATION);
  assert.deepEqual(new DockerSandbox({ mounts: stubMounts(), declaration: PODMAN_DECLARATION }).declaration, PODMAN_DECLARATION);
});
