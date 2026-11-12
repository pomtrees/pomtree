import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  BUILTIN_SANDBOX_BACKEND_IDS,
  SANDBOX_CAPABILITIES,
  SANDBOX_PORT_VERSION,
  type Sandbox,
  type SandboxBackendProvider,
  type SandboxDeclaration,
} from "@pomtree/core";
import {
  DOCKER_DECLARATION,
  DOCKER_PROFILE,
  dockerProvider,
  type EngineSelection,
  type LocalBackendProvider,
  type LocalEngine,
  PODMAN_DECLARATION,
  PODMAN_PROFILE,
  podmanProvider,
  scriptedLocalEngine,
} from "@pomtree/sandbox-docker";
import { parseManifest, scanExtensionManifests } from "./extension-manifest.ts";
import {
  BUILTIN_BACKENDS,
  type BackendRegistry,
  admitAtBoot,
  availableBackends,
  backendDeps,
  bootNeeds,
  type BuiltinBackend,
  type ContributedSource,
  createContributedSource,
  createLocalSandbox,
  remoteBootRefusal,
  resolveBackend,
} from "./sandbox-backends.ts";
import { type LoadedSandboxExtension, measureExtensionTree } from "./sandbox-provider-load.ts";

const roots: string[] = [];
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-backends-")));
  roots.push(d);
  return d;
}
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// A declaration with every capability false, then the overrides.
function decl(backend: string, caps: Partial<Record<(typeof SANDBOX_CAPABILITIES)[number], boolean>> = {}, extra: Partial<SandboxDeclaration> = {}) {
  return {
    backend,
    capabilities: { ...Object.fromEntries(SANDBOX_CAPABILITIES.map((c) => [c, false])), ...caps },
    region: null,
    idempotency: "unique-name",
    idempotencyWindowMs: null,
    tagging: "metadata",
    output: "poll",
    maxLifetimeMs: null,
    preemptible: false,
    billing: { unit: "none", whileStopped: false, whilePaused: false },
    ...extra,
  } as SandboxDeclaration;
}
// What a hosted backend that can run an agent declares: a channel to the daemon, limits, OCI images.
const ADMISSIBLE = { connect: true, "resources.limits": true, "image.ociPull": true } as const;

// Counts every construction of every provider, every provider lookup and every pin check, so a test sees what was never touched.
function counting() {
  const created: string[] = [];
  const looked: string[] = [];
  const provider = (id: string): SandboxBackendProvider => ({
    id,
    portVersion: SANDBOX_PORT_VERSION,
    declaration: decl(id, { "mounts.host": true, "resources.limits": true, "image.ociPull": true }),
    params: [],
    credentials: [],
    create() {
      created.push(id);
      return { declaration: decl(id) } as unknown as Sandbox;
    },
  });
  const builtin = (id: string, localEngine: boolean, available = true): BuiltinBackend => ({
    id,
    localEngine,
    ...(available && {
      provider: () => {
        looked.push(id);
        return provider(id);
      },
    }),
  });
  const verified: string[] = [];
  const contributed: ContributedSource = {
    ids: () => [
      { id: "toybox", extension: "toybox" },
      { id: "toybox-two", extension: "toybox" },
    ],
    verify: (id) => {
      verified.push(id);
      return { dir: `/ext/${id}`, pin: "sha256:x" };
    },
  };
  const registry: BackendRegistry = {
    builtins: [builtin("docker", true), builtin("podman", true), builtin("kubernetes", false, false)],
    contributed,
  };
  const opened: EngineSelection[] = [];
  const openLocal = async (selection: EngineSelection): Promise<LocalEngine> => {
    opened.push(selection);
    return scriptedLocalEngine({ profile: selection === "podman" ? PODMAN_PROFILE : DOCKER_PROFILE });
  };
  return { registry, created, looked, verified, opened, openLocal };
}

const noLog = () => {};
const deps = (id: string) => backendDeps({ id, credentials: [], config: {}, userAgent: "pomtree", env: {}, log: noLog });
const never = async (): Promise<LocalEngine> => {
  throw new Error("a contributed selection must not open a local engine");
};

test("the built-in table names exactly core's built-in ids; only docker and podman are local engines, carried at the daemon's port version", () => {
  assert.deepEqual(
    BUILTIN_BACKENDS.map((b) => b.id),
    [...BUILTIN_SANDBOX_BACKEND_IDS],
  );
  const carried = BUILTIN_BACKENDS.filter((b) => b.provider !== undefined).map((b) => b.provider?.());
  assert.deepEqual(carried, [dockerProvider, podmanProvider]);
  for (const p of carried) assert.equal(p?.portVersion, SANDBOX_PORT_VERSION);
  assert.deepEqual(
    BUILTIN_BACKENDS.filter((b) => b.localEngine).map((b) => b.id),
    ["docker", "podman"],
  );
});

test("an unselected provider is never constructed or looked up: docker touches no other provider, a contributed id only its own pin", async () => {
  const c = counting();
  const docker = await resolveBackend({ configured: "docker", registry: c.registry, openLocal: c.openLocal });
  assert.equal(docker.origin, "builtin");
  assert.deepEqual(c.created, [], "resolving constructs nothing");
  if (docker.localEngine) createLocalSandbox(docker.provider, deps("docker"), { engine: docker.engine, docker: {} as never });
  assert.deepEqual(c.created, ["docker"]);
  assert.deepEqual(c.looked, ["docker"], "the podman provider is not even looked up");
  assert.deepEqual(c.verified, [], "no contributed backend is checked");
  assert.deepEqual(c.opened, ["docker"]);

  const d = counting();
  const toy = await resolveBackend({ configured: "toybox", registry: d.registry, openLocal: d.openLocal });
  assert.deepEqual(toy, { origin: "extension", localEngine: false, id: "toybox", extension: "toybox", dir: "/ext/toybox" });
  assert.deepEqual(d.verified, ["toybox"], "toybox-two is never checked");
  assert.deepEqual([d.created, d.looked, d.opened], [[], [], []], "no provider is constructed and no local engine opened");
});

test("auto considers only the local engines: it never checks or selects a contributed backend", async () => {
  const c = counting();
  const r = await resolveBackend({ configured: "auto", registry: c.registry, openLocal: c.openLocal });
  assert.equal(r.origin, "builtin");
  assert.equal(r.id, "docker");
  assert.deepEqual(c.opened, ["auto"], "auto goes to the engine detector");
  assert.deepEqual(c.verified, []);
  // The detector's pick decides between the two engines, and the refusals it skipped reach the caller.
  const p = counting();
  const podman = await resolveBackend({
    configured: "auto",
    registry: p.registry,
    openLocal: async () => scriptedLocalEngine({ profile: PODMAN_PROFILE, findings: ["skipped docker: remote DOCKER_HOST"] }),
  });
  assert.equal(podman.id, "podman");
  assert.deepEqual(podman.localEngine && podman.engine.findings, ["skipped docker: remote DOCKER_HOST"]);
  // A detector refusal (nothing found) is the start's refusal, not a fallback to another backend.
  const q = counting();
  await assert.rejects(
    resolveBackend({
      configured: "auto",
      registry: q.registry,
      openLocal: async () => {
        throw new Error("no local engine answers");
      },
    }),
    /^Error: no local engine answers$/,
  );
  assert.deepEqual(q.verified, []);
});

test("an unknown id refuses with every available id, each contributed one naming its extension", async () => {
  const c = counting();
  await assert.rejects(resolveBackend({ configured: "nosuch", registry: c.registry, openLocal: c.openLocal }), {
    message:
      'sandbox.backend is "nosuch", which no built-in backend or installed extension provides; available: auto, docker, podman, toybox (extension toybox), toybox-two (extension toybox); set sandbox.backend to one of them, or install the extension that provides it in extensions.dir',
  });
  assert.deepEqual([c.created, c.verified, c.opened], [[], [], []]);
});

test("a built-in backend this build does not carry refuses with the available ids", async () => {
  const c = counting();
  await assert.rejects(resolveBackend({ configured: "kubernetes", registry: c.registry, openLocal: c.openLocal }), {
    message:
      "built-in backend kubernetes is not available in this build; available: auto, docker, podman, toybox (extension toybox), toybox-two (extension toybox); set sandbox.backend to one of them",
  });
  assert.deepEqual([c.created, c.verified, c.opened], [[], [], []]);
  for (const id of ["sail", "e2b"]) {
    const registry = { builtins: BUILTIN_BACKENDS, contributed: createContributedSource({ extensions: [], reviewedBackends: [] }) };
    await assert.rejects(resolveBackend({ configured: id, registry, openLocal: c.openLocal }), {
      message: `built-in backend ${id} is not available in this build; available: auto, docker, podman; set sandbox.backend to one of them`,
    });
  }
});

// ---- the contributed half, over the real pin check ----

// A provider module that records any import of itself, so a test can prove it was never loaded.
function extension(name: string, id: string, parent = tmp()): LoadedSandboxExtension {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "entry.mjs"), "export default {};\n");
  writeFileSync(
    join(dir, "provider.mjs"),
    `(globalThis.__t3bImported ??= []).push(${JSON.stringify(id)});\nexport const portVersion = ${SANDBOX_PORT_VERSION};\nexport const declaration = ${JSON.stringify(decl(id, ADMISSIBLE))};\nexport function create() { (globalThis.__t3bCreated ??= []).push(${JSON.stringify(id)}); return {}; }\n`,
  );
  const manifest = {
    apiVersion: 2,
    name,
    entry: "entry.mjs",
    capabilities: {},
    deps: [],
    provides: [{ kind: "sandbox", id, entry: "provider.mjs", portVersion: SANDBOX_PORT_VERSION, credentials: ["apiKey"] }],
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return { dir, manifest: parseManifest(JSON.stringify(manifest)) };
}
const touched = () => {
  const g = globalThis as { __t3bImported?: string[]; __t3bCreated?: string[] };
  return [g.__t3bImported ?? [], g.__t3bCreated ?? []];
};
const registryOf = (extensions: LoadedSandboxExtension[], reviewedBackends: string[]): BackendRegistry => ({
  builtins: BUILTIN_BACKENDS,
  contributed: createContributedSource({ extensions, reviewedBackends }),
});

test("an unpinned or mismatched contributed backend is refused with its hash and the action, and its module is never imported", async () => {
  const ext = extension("toybox", "toybox");
  const hash = measureExtensionTree(ext.dir).hash;
  await assert.rejects(resolveBackend({ configured: "toybox", registry: registryOf([ext], []), openLocal: never }), {
    message: `sandbox backend toybox is not reviewed: ${ext.dir} hashes to ${hash}; review the directory, then add toybox=${hash} to sandbox.reviewedBackends`,
  });
  const other = `sha256:${"0".repeat(64)}`;
  await assert.rejects(resolveBackend({ configured: "toybox", registry: registryOf([ext], [`toybox=${other}`]), openLocal: never }), {
    message: `sandbox backend toybox does not match its pin: ${ext.dir} hashes to ${hash} but sandbox.reviewedBackends pins ${other}; a file was changed, added, renamed or removed. Review the directory, then replace the pin with toybox=${hash}`,
  });
  assert.deepEqual(touched(), [[], []]);
});

test("a pinned contributed backend resolves to its directory without importing or constructing its module", async () => {
  const a = extension("toybox", "toybox");
  const b = extension("other", "other");
  const pins = [`toybox=${measureExtensionTree(a.dir).hash}`, `other=${measureExtensionTree(b.dir).hash}`];
  const r = await resolveBackend({ configured: "toybox", registry: registryOf([a, b], pins), openLocal: never });
  assert.deepEqual(r, { origin: "extension", localEngine: false, id: "toybox", extension: "toybox", dir: a.dir });
  assert.deepEqual(touched(), [[], []], "neither provider module was imported or constructed");
  assert.equal(
    remoteBootRefusal(r as Exclude<typeof r, { localEngine: true }>),
    "sandbox backend toybox (extension toybox) is selected, but this daemon build runs agents only on the local engines (docker, podman); set sandbox.backend to docker, podman or auto",
  );
});

test("two extensions providing one id refuse the registry, naming both", () => {
  const a = extension("toybox", "toybox");
  const b = extension("toybox", "toybox");
  assert.throws(
    () => createContributedSource({ extensions: [a, b], reviewedBackends: [] }),
    /sandbox backend toybox is provided by both extension toybox \(.*\) and extension toybox \(.*\); rename one id or remove one extension/,
  );
});

// ---- boot admission ----

test("the token-in-env exception follows the entry's localEngine flag: a hosted built-in without it needs sandbox.secretsInEnv", async () => {
  const envOnly = decl("hosted", { "secrets.env": true, "reach.outbound": true, "mounts.host": true, "resources.limits": true, "image.ociPull": true });
  const hostedProvider: SandboxBackendProvider = {
    id: "hosted",
    portVersion: SANDBOX_PORT_VERSION,
    declaration: envOnly,
    params: [],
    credentials: [],
    create: () => ({}) as Sandbox,
  };
  const c = counting();
  const registry: BackendRegistry = {
    builtins: [...c.registry.builtins, { id: "hosted", localEngine: false, provider: () => hostedProvider }],
    contributed: c.registry.contributed,
  };
  const hosted = await resolveBackend({ configured: "hosted", registry, openLocal: never });
  assert.deepEqual([hosted.origin, hosted.localEngine], ["builtin", false]);
  assert.deepEqual(admitAtBoot(envOnly, bootNeeds(hosted, false)), [
    "sandbox backend hosted is not admitted: the agent needs a credential delivered but backend hosted can neither deliver it after start over connect (not declared) nor take it as create-time env with the operator's opt-in (secrets.env not declared, env delivery not allowed); use a backend that declares connect, or one that declares secrets.env and enable env credential delivery in the configuration",
  ]);
  assert.deepEqual(admitAtBoot(envOnly, bootNeeds(hosted, true)), [], "sandbox.secretsInEnv admits it");
  assert.equal(
    remoteBootRefusal(hosted as Exclude<typeof hosted, { localEngine: true }>),
    "sandbox backend hosted (built-in) is selected, but this daemon build runs agents only on the local engines (docker, podman); set sandbox.backend to docker, podman or auto",
  );
  // The local engines take the token in env without the opt-in, as they always have.
  const docker = await resolveBackend({ configured: "docker", registry, openLocal: c.openLocal });
  assert.deepEqual(admitAtBoot(DOCKER_DECLARATION, bootNeeds(docker, false)), []);
  assert.deepEqual(admitAtBoot(PODMAN_DECLARATION, bootNeeds(docker, false)), []);
});

test("boot admission: the microVM row and an idempotency of none each refuse with the cause and the action", () => {
  const needs = bootNeeds({ origin: "extension", localEngine: false }, false);
  const ok = decl("toybox", ADMISSIBLE);
  assert.deepEqual(admitAtBoot(ok, needs), []);
  assert.deepEqual(admitAtBoot(decl("toybox", { ...ADMISSIBLE, "isolation.gvisor": true }), { ...needs, isolation: "microvm" }), [
    "sandbox backend toybox is not admitted: a template asks for microVM isolation but backend toybox does not provide it (isolation.microvm not declared); pomtree never falls back to a weaker runtime, and gVisor and microVM do not substitute for each other; use a backend that declares isolation.microvm, or remove the runtime block from the template",
  ]);
  const none = admitAtBoot(decl("toybox", ADMISSIBLE, { idempotency: "none" as never }), needs);
  assert.equal(none.length, 1);
  assert.match(
    none[0] as string,
    /^sandbox backend toybox has an invalid declaration: backend toybox declares idempotency "none": .*implement unique-name, native-token or tag-lookup$/,
  );
  // A local engine without limits is refused like any other backend.
  assert.deepEqual(
    admitAtBoot(
      decl("docker", { "mounts.host": true, "image.ociPull": true, "secrets.env": true }),
      bootNeeds({ origin: "builtin", localEngine: true }, false),
    ),
    [
      "sandbox backend docker is not admitted: backend docker does not enforce cpu, memory and pids limits (resources.limits not declared), and admission control assumes limits are enforced; use a backend that enforces resource limits, or fix the host (for rootless Podman, enable cgroup v2 delegation)",
    ],
  );
});

// ---- the facade and the local construction ----

test("credentials reach a provider only through the facade: its declared names, read from the _FILE variable under the shared mode rule", async () => {
  const key = join(tmp(), "toybox.key");
  writeFileSync(key, "s3cr3t\n", { mode: 0o644 });
  const d = backendDeps({
    id: "toybox",
    credentials: ["apiKey"],
    config: { "sandbox.toybox.baseUrl": "http://127.0.0.1:1" },
    userAgent: "pomtree",
    env: { POMTREED_SANDBOX_TOYBOX_APIKEY_FILE: key },
    log: noLog,
  });
  await assert.rejects(d.credential("otherKey"), /which it did not declare \(declared: apiKey\)/);
  await assert.rejects(d.credential("apiKey"), { message: `POMTREED_SANDBOX_TOYBOX_APIKEY_FILE: ${key} is readable by group/other; run chmod 600 ${key}` });
  chmodSync(key, 0o600);
  assert.equal(await d.credential("apiKey"), "s3cr3t");
  assert.deepEqual(d.config, { "sandbox.toybox.baseUrl": "http://127.0.0.1:1" });
  assert.equal(d.run, undefined, "no run dep is offered");
});

test("the local engine's provider builds the adapter with its own declaration and the engine's profile", () => {
  const engine = scriptedLocalEngine({ profile: PODMAN_PROFILE });
  const docker = { mounts: { resolve: async () => [] } } as never;
  const sandbox = createLocalSandbox(podmanProvider, deps("podman"), { engine, docker });
  assert.equal(sandbox.declaration, PODMAN_DECLARATION);
  assert.throws(
    () => createLocalSandbox(dockerProvider as LocalBackendProvider, deps("docker"), { engine, docker }),
    /sandbox backend docker was given the podman engine/,
  );
});

test("scanExtensionManifests lists each extension that provides a sandbox backend, with its real directory", () => {
  const root = tmp();
  const a = extension("toybox", "toybox", root);
  const plain = join(root, "plain");
  mkdirSync(plain);
  writeFileSync(join(plain, "manifest.json"), JSON.stringify({ apiVersion: 2, name: "plain", entry: "e.mjs", capabilities: {}, deps: [] }));
  const scan = scanExtensionManifests(root);
  assert.deepEqual(
    scan.extensions.map((e) => e.name),
    ["plain", "toybox"],
  );
  assert.deepEqual(
    scan.sandboxExtensions?.map((e) => [e.dir, e.manifest.name]),
    [[a.dir, "toybox"]],
  );
});

test("availableBackends lists auto, the carried built-ins and the contributed ids with their extensions", () => {
  assert.equal(availableBackends(counting().registry), "auto, docker, podman, toybox (extension toybox), toybox-two (extension toybox)");
});
