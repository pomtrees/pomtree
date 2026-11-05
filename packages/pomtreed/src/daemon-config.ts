// The daemon's one configuration load: argv (`--config`, repeatable `--set`, `config show`) and the registry resolve
// (core config/resolve.ts: default < JSON file < env < --set), plus the pomtreed-owned semantic checks the registry delegates
// (listeners, state grants, workflow grants, journal retention, required model keys). Pure: the env, the argv and the file
// reader are injected; main.ts is the only caller with process access and passes the resolved values on by injection.
import { join } from "node:path";
import {
  CONFIG_FILE_ENV,
  CONFIG_REGISTRY,
  ConfigRegistryError,
  type ConfigRegistry,
  type ConfigRow,
  type ConfigValues,
  type ContainerConfigValues,
  EXT_NAMESPACE,
  type ExtensionConfigView,
  type ParamDef,
  configEnvIgnore,
  containerConfigDoc,
  containerConfigValues,
  describeConfig,
  extendRegistry,
  isSensitive,
  type ResolvedConfig,
  resolveConfig,
  secretFileEnv,
} from "@pomtree/core";
import { type ListenSpec, assertLoopbackOrAllowed, parseListen } from "./config.ts";
import { checkModelBaseUrl } from "./model-proxy/upstream.ts";
import type { ManifestScan } from "./extension-manifest.ts";
import { StatePolicy } from "./state-policy.ts";
import { WorkflowRuntimePolicy } from "./workflow-policy.ts";
import { parseTestFetchHosts, testFetchRefusal } from "./test-fetch.ts";

type Params = (typeof CONFIG_REGISTRY)["params"];
export type DaemonConfig = ConfigValues<Params>;
// The composed resolve (core keys plus the loaded extensions' `ext.<segment>.*` keys); values and origins are indexed by path.
export type DaemonResolved = ResolvedConfig<readonly ParamDef[]>;
export type ConfigPath = keyof DaemonConfig;

// The env name of a key (derived or explicit), for messages that tell the operator what to set.
export const envName = (path: ConfigPath): string => CONFIG_REGISTRY.envOf.get(path) as string;

// The exit code of every pre-start configuration refusal (startup and `config show` alike).
export const CONFIG_EXIT = 2;

export const DAEMON_USAGE = `usage: pomtreed [--config <file>] [--set key=value]...
       pomtreed config show [--origin] [--json] [--config <file>] [--set key=value]...
       pomtreed preflight [--json] [--repo DIR] [--state DIR] [--image REF] [--egress-image REF] [--key-file FILE]
       pomtreed init --questions [--json]
       pomtreed init --answers FILE [--out DIR] [--write] [--force]
       pomtreed --version   print the build identity (v<version>[*] (<revision>); * marks a dirty checkout)

Every setting is a registry key (packages/core/src/config). Precedence, lowest to highest:
  1. the key's default
  2. the JSON config file: --config <file>, else $${CONFIG_FILE_ENV}
  3. the key's env var (e.g. agent.maxDepth -> POMTREED_AGENT_MAX_DEPTH)
  4. --set key=value (repeatable; the last one wins)
Extension keys (ext.<segment>.<key>, declared in the manifests under extensions.dir) resolve the same way; those of an extension
that is not present, and undeclared POMTREED_EXT_* names, are refused.
Unknown keys, unknown POMTREED_/POMTREE_ env names, out-of-range values, ceilings and violated relations refuse
the start (exit ${CONFIG_EXIT}). Sensitive keys are read only from a file named by <ENV>_FILE. All keys are restart-only.

config show   resolve exactly like startup and print every key's value (sensitive ones as <redacted>)
  --origin    also print where each value came from and its default
  --json      print the rows as JSON

preflight     check this host for what setup needs (node, git, pnpm, Docker, the agent image, the target repo); exit 1 on any error
init          print the setup interview, or turn an answers file into the env/JSON config (and optional systemd unit); dry run unless --write
Both are optional setup aids: the daemon never needs them.`;

export interface DaemonArgs {
  command: "run" | "help" | "version" | "config-show" | "preflight" | "init";
  rest?: string[]; // preflight and init: the arguments after the subcommand, parsed by onboard/cli.ts
  configFile?: string;
  set: string[];
  origin: boolean;
  json: boolean;
}

export function parseDaemonArgv(argv: readonly string[]): { ok: true; args: DaemonArgs } | { ok: false; errors: string[] } {
  const args: DaemonArgs = { command: "run", set: [], origin: false, json: false };
  if (argv[0] === "preflight" || argv[0] === "init") return { ok: true, args: { ...args, command: argv[0], rest: argv.slice(1) } };
  const errors: string[] = [];
  const positional: string[] = [];
  let showFlag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (flag: string): string | undefined => {
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
      const v = argv[i + 1];
      if (v === undefined) {
        errors.push(`${flag} needs a value`);
        return undefined;
      }
      i++;
      return v;
    };
    if (a === "--config" || a.startsWith("--config=")) {
      const v = value("--config");
      if (v !== undefined) args.configFile = v;
    } else if (a === "--set" || a.startsWith("--set=")) {
      const v = value("--set");
      if (v !== undefined) args.set.push(v);
    } else if (a === "--help" || a === "-h") args.command = "help";
    else if (a === "--version" || a === "-V") {
      if (args.command !== "help") args.command = "version";
    } else if (a === "--origin") {
      args.origin = true;
      showFlag ??= a;
    } else if (a === "--json") {
      args.json = true;
      showFlag ??= a;
    } else if (a.startsWith("-")) errors.push(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length > 0) {
    if (positional.length === 2 && positional[0] === "config" && positional[1] === "show") {
      if (args.command === "run") args.command = "config-show";
    } else errors.push(`unknown command ${positional.join(" ")} (expected: config show)`);
  }
  if (showFlag !== undefined && args.command === "run") errors.push(`${showFlag} applies only to \`pomtreed config show\``);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, args };
}

export interface DaemonConfigInput {
  env: Readonly<Record<string, string | undefined>>;
  args: Pick<DaemonArgs, "configFile" | "set">;
  readFile: (path: string) => string; // the config file and the `<ENV>_FILE` secrets
  fileMode?: (path: string) => number; // permission bits of a `<ENV>_FILE` secret (resolveConfig refuses group/other bits)
  defaultStateDir: string; // state.dir when unset (extensions.dir defaults beneath it)
  // Reads the extension manifests under a directory as JSON (no extension code runs). Injected so this module stays pure;
  // main.ts passes extension-manifest.ts's scanExtensionManifests.
  scanExtensions: (dir: string) => ManifestScan;
}

export interface LoadedDaemonConfig {
  ok: true;
  config: DaemonConfig;
  registry: ConfigRegistry; // core plus the extensions composed from extensionsDir's manifests
  resolved: DaemonResolved;
  extensionsDir: string; // extensions.dir, or <state.dir>/extensions
  // Each extension's frozen read-only config view (ExtensionHost.config), by extension name; core-only for any other name.
  extensionConfig: (extension: string) => ExtensionConfigView;
  statePolicy: StatePolicy;
  workflowPolicy: WorkflowRuntimePolicy;
  uiSpec: ListenSpec | null; // null = off
  hostSpec: ListenSpec | null; // null = off
  journal: { retentionMs: number; keepPerAgent: number } | null; // null = no pruning
  // The delivered (container) subset, already accepted by the image's reader, so no container start can fail on it.
  containerConfig: ContainerConfigValues;
  testMode: boolean; // test.mode: admits the test-only seams; main.ts warns at start while it is on
  testFetchHosts: ReadonlyMap<string, number> | null; // test.fetchHosts (test-fetch.ts); null = off, always off outside test mode
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Phase 1 resolves the core keys alone to learn where the extensions live (`extensions.dir` is itself a key). Everything under
// `ext` is the extensions' business and is validated in phase 2, so it is withheld here: the file's `ext` subtree, `--set ext.*`
// entries and the POMTREED_EXT_ env family (unknown env names are reported once, by phase 2).
function withoutExtensionInputs(file: unknown, set: readonly string[]): { file?: unknown; set: string[] } {
  const isPlain = typeof file === "object" && file !== null && !Array.isArray(file);
  const { [EXT_NAMESPACE]: _ext, ...rest } = isPlain ? (file as Record<string, unknown>) : {};
  return {
    ...(file !== undefined && { file: isPlain ? rest : file }),
    set: set.filter((entry) => !entry.startsWith(`${EXT_NAMESPACE}.`)),
  };
}

// The view an extension gets: every non-sensitive core key plus its own keys, frozen.
function extensionViews(registry: ConfigRegistry, values: Readonly<Record<string, unknown>>): (extension: string) => ExtensionConfigView {
  const core = Object.fromEntries(
    registry.params.filter((p) => !p.path.startsWith(`${EXT_NAMESPACE}.`) && !isSensitive(p)).map((p) => [p.path, values[p.path]]),
  );
  const views = new Map(
    registry.extensions.map((e) => [e.name, Object.freeze({ ...core, ...Object.fromEntries(e.paths.map((path) => [path, values[path]])) })] as const),
  );
  const coreOnly = Object.freeze(core);
  return (extension) => views.get(extension) ?? coreOnly;
}

export function loadDaemonConfig(input: DaemonConfigInput): LoadedDaemonConfig | { ok: false; errors: string[] } {
  const path = input.args.configFile ?? input.env[CONFIG_FILE_ENV];
  let file: unknown;
  if (path !== undefined && path !== "") {
    let text: string;
    try {
      text = input.readFile(path);
    } catch (e) {
      return { ok: false, errors: [`config file ${path}: cannot read: ${message(e)}`] };
    }
    try {
      file = JSON.parse(text);
    } catch {
      // The parser's message can quote the file's text; the position-free refusal is enough to find it.
      return { ok: false, errors: [`config file ${path}: not valid JSON`] };
    }
  }
  // Phase 1: the core keys, to find the extensions directory.
  const early = withoutExtensionInputs(file, input.args.set);
  const first = resolveConfig(CONFIG_REGISTRY, {
    ...(early.file !== undefined && { file: early.file }),
    env: input.env,
    set: early.set,
    readFile: input.readFile,
    ...(input.fileMode !== undefined && { fileMode: input.fileMode }),
    skipUnknownEnv: true, // an extension's declared names are unknown until phase 2 composes them
  });
  if (!first.ok) return first;
  const extensionsDir = first.values["extensions.dir"] || join(first.values["state.dir"] || input.defaultStateDir, "extensions");
  // Phase 2: scan the manifests (JSON only), compose the registry, and resolve everything once over the merged table, so origins,
  // ceilings, relations and the unknown-name refusals are uniform. A bad `params` declaration or composition is a config error.
  const scan = input.scanExtensions(extensionsDir);
  if (scan.errors.length > 0) return { ok: false, errors: scan.errors };
  let registry: ConfigRegistry;
  try {
    registry = extendRegistry(CONFIG_REGISTRY, scan.extensions);
  } catch (e) {
    if (e instanceof ConfigRegistryError) return { ok: false, errors: [...e.errors] };
    throw e;
  }
  const r = resolveConfig(registry, {
    ...(file !== undefined && { file }),
    env: input.env,
    set: input.args.set,
    readFile: input.readFile,
    ...(input.fileMode !== undefined && { fileMode: input.fileMode }),
    ...configEnvIgnore(),
  });
  if (!r.ok) {
    // A name under `ext` that no composed extension owns may belong to one whose manifest was refused; say why instead of
    // leaving "no loaded extension" to hide the real fault.
    const unloaded = scan.unloaded ?? [];
    const orphan = r.errors.some((m) => m.includes("no loaded extension owns") || m.includes("names no loaded extension"));
    return orphan && unloaded.length > 0 ? { ok: false, errors: [...r.errors, ...unloaded.map((u) => `extension manifest not loaded: ${u}`)] } : r;
  }
  const c = r.values as unknown as DaemonConfig; // the composed values are a superset of the core keys
  const errors: string[] = [];
  const attempt = <T>(f: () => T): T | undefined => {
    try {
      return f();
    } catch (e) {
      errors.push(message(e));
      return undefined;
    }
  };
  const allowNonLoopback = c["listen.allowNonloopback"];
  const listener = (key: "ui.listen" | "host.listen"): ListenSpec | null | undefined =>
    attempt(() => {
      const spec = parseListen(envName(key), c[key], { allowOff: true });
      if (spec) assertLoopbackOrAllowed(envName(key), spec, allowNonLoopback);
      return spec;
    });
  const uiSpec = listener("ui.listen");
  const hostSpec = listener("host.listen");
  // Validated here only: whether a non-loopback agent.listen is allowed needs the detected docker bridge gateway, so main.ts refuses it
  // at boot (safety-boot.ts).
  if (c["agent.listen"] !== "") attempt(() => parseListen(envName("agent.listen"), c["agent.listen"], { allowOff: true }));
  // The registry checks only that these are JSON objects; the pomtreed parsers own their semantics.
  const statePolicy = attempt(() => new StatePolicy(JSON.stringify(c["state.grants"]), JSON.stringify(c["state.limits"])));
  const workflowPolicy = attempt(() => new WorkflowRuntimePolicy(c["workflow.reviewedExtensions"].join(","), JSON.stringify(c["workflow.templates"])));
  // keepPerAgent only bounds a prune; set without a retention window it would silently do nothing.
  // The container document is produced at every start; refuse here, before anything starts, if the image's reader would refuse it.
  // Of the delivered keys, pomtreed itself reads none: the six browser.capture.* keys (and wait.yieldMs) are read inside the image
  // (agent-image) and by the digest host. The digest's own keys are extension keys (ext.hnDigest.*), composed above.
  const containerConfig = attempt(() => {
    containerConfigDoc(CONFIG_REGISTRY, c);
    return containerConfigValues(CONFIG_REGISTRY, c);
  });
  // A test-only seam is admitted only in explicit test mode: set without it, the daemon refuses to start (never ignored silently).
  const fetchHosts = attempt(() => parseTestFetchHosts(c["test.fetchHosts"]));
  if (fetchHosts && fetchHosts.size > 0 && !c["test.mode"]) errors.push(testFetchRefusal(envName("test.mode")));
  if (r.origins["journal.keepPerAgent"] !== "default" && c["journal.retentionMs"] === 0)
    errors.push(`journal.keepPerAgent (${r.origins["journal.keepPerAgent"]}) requires journal.retentionMs > 0 (${envName("journal.retentionMs")})`);
  if (c["model.baseUrl"] === "") errors.push(`model.baseUrl is required: the model proxy is the only model path (set ${envName("model.baseUrl")})`);
  else {
    const base = checkModelBaseUrl(c["model.baseUrl"], envName("model.baseUrl"));
    if (!base.ok) errors.push(base.error);
  }
  if (c["pi.provider"] === "") errors.push(`pi.provider is required: set ${envName("pi.provider")} to the provider the model proxy serves (e.g. openrouter)`);
  if (c["model.upstreamKey"] === "")
    errors.push(`model.upstreamKey is required: set ${secretFileEnv(envName("model.upstreamKey"))} to a file holding the upstream API key`);
  if (
    errors.length > 0 ||
    statePolicy === undefined ||
    workflowPolicy === undefined ||
    uiSpec === undefined ||
    hostSpec === undefined ||
    containerConfig === undefined ||
    fetchHosts === undefined
  )
    return { ok: false, errors };
  return {
    ok: true,
    config: c,
    registry,
    resolved: r,
    extensionsDir,
    extensionConfig: extensionViews(registry, r.values),
    statePolicy,
    workflowPolicy,
    uiSpec,
    hostSpec,
    journal: c["journal.retentionMs"] > 0 ? { retentionMs: c["journal.retentionMs"], keepPerAgent: c["journal.keepPerAgent"] } : null,
    containerConfig,
    testMode: c["test.mode"],
    testFetchHosts: c["test.mode"] && fetchHosts.size > 0 ? fetchHosts : null,
  };
}

// The startup line naming the effective fetch identity (the resolved workflow.fetch.userAgent, never blank) and where to change it.
export const fetchIdentityLine = (value: string): string =>
  `pomtreed: fetch identity: User-Agent "${value}" (workflow.fetch.userAgent, env ${CONFIG_REGISTRY.envOf.get("workflow.fetch.userAgent")}); naming a contact in it is recommended, e.g. "pomtree (+https://example.org/contact)"`;

const shown = (v: unknown): string => (typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));

// `pomtreed config show`: one `path=value` line per key in registry order (`--origin` adds origin and default), or the rows as
// JSON. Values come from describeConfig, which redacts every set sensitive key; nothing else from the env is printed.
export function formatConfigShow(loaded: Pick<LoadedDaemonConfig, "registry" | "resolved">, opts: { origin?: boolean; json?: boolean } = {}): string {
  const rows: ConfigRow[] = describeConfig(loaded.registry, loaded.resolved);
  if (opts.json) return JSON.stringify(rows, null, 2);
  return rows.map((r) => `${r.path}=${shown(r.value)}${opts.origin ? `  origin=${r.origin} default=${shown(r.default)}` : ""}`).join("\n");
}
