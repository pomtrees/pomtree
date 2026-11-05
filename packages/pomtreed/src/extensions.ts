import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AgentId,
  AgentRecord,
  AgentState,
  Extension,
  ExtensionConfigView,
  ExtensionDeps,
  ExtensionHost,
  ExtensionJournalKind,
  ExtensionManifest,
  ExtensionName,
  ExtensionRegistry,
  HostCredential,
  HostId,
  Journal,
  JournalEntry,
  JournalPayload,
  JournalKindDef,
  LoadedExtension,
  Mailbox,
  Registry,
  RouteDef,
  Signal,
  SpawnIntent,
  SpawnSpec,
  StreamRouteDef,
  Subscription,
  VerbSpec,
  WorkflowDef,
} from "@pomtree/core";
import { extensionCredentialEnv, isExtensionAction } from "@pomtree/core";
import type { ExtensionDepName } from "@pomtree/core";
import { NAME_RE, RESERVED_NAMES, assertExtensionApiVersion, parseCapabilities, parseDeps, parseManifest } from "./extension-manifest.ts";
import { EXPIRED, raceUntil, type WorkflowHost } from "./workflows.ts";

const ROUTE_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

interface JournalHook {
  fn: (e: JournalEntry) => void | Promise<void>;
  disabled: boolean;
}
interface SpawnHook {
  fn: (e: { record: AgentRecord; requester: AgentId | null }) => void | Promise<void>;
  disabled: boolean;
}
interface SpawnSpecTransform {
  fn: (spec: SpawnSpec, intent: SpawnIntent) => SpawnSpec | Promise<SpawnSpec>;
  disabled: boolean;
}

// One loaded extension's runtime state. `status` is "ok" | "failed" | "degraded" (a start() throw).
interface Loaded {
  name: ExtensionName;
  dir: string; // realpathed extension subdirectory (empty for builtins)
  rootDir: string; // realpathed extensions root (for credential file resolution; empty for builtins)
  manifest: ExtensionManifest;
  status: LoadedExtension["status"];
  error?: string;
  builtin?: boolean; // compiled-in (registerBuiltin): may register top-level routes outside its /v1/ext prefix
  initPromise?: Promise<void>; // a builtin's async init, awaited before start
  ext?: Extension;
  host?: ExtensionHostImpl;
  routes: RouteDef[];
  streams: StreamRouteDef[];
  verbs: VerbSpec[];
  journalKinds: JournalKindDef[];
  journalHooks: Set<JournalHook>;
  spawnHooks: Set<SpawnHook>;
  spawnSpecs: SpawnSpecTransform[];
  workflows: WorkflowDef[];
  // True only while the extension's init runs (load or builtin registration). host.workflow outside it throws.
  registering?: boolean;
}

export interface ExtensionRegistryOptions {
  hostId: HostId;
  now: () => number;
  registry: Registry;
  journal: Journal;
  mailbox: Mailbox;
  root: () => Promise<AgentRecord>;
  // The resolved config an extension may read (core non-sensitive keys plus its own ext.<segment>.* keys), by extension name.
  // Absent = an empty view (embedders and tests without a registry).
  config?: (extension: ExtensionName) => ExtensionConfigView;
  // Applied to every extension-written journal payload (extension data is free-form and may echo host paths).
  redact?: (payload: JournalPayload) => JournalPayload;
  // Reviewed in-process workflow host. Absent = no workflows are admitted.
  workflows?: WorkflowHost;
  log?: (line: string) => void;
}

// The per-extension facade handed to extension code as `host.deps`. `store` is intentionally absent
// (undefined) until an extension store exists.
class ExtensionDepsFacade implements ExtensionDeps {
  readonly hostId: HostId;
  readonly journal: ExtensionDeps["journal"];
  private readonly opts: ExtensionRegistryOptions;
  private readonly entry: Loaded;

  constructor(opts: ExtensionRegistryOptions, entry: Loaded) {
    this.opts = opts;
    this.entry = entry;
    this.hostId = opts.hostId;
    this.journal = {
      read: async (o) => {
        this.need("journal", "deps.journal.read");
        return opts.journal.read(o);
      },
      subscribe: (o) => {
        this.need("journal", "deps.journal.subscribe");
        return opts.journal.subscribe(o);
      },
    };
  }

  // Undeclared is denied: every operation behind a manifest `deps` flag checks it here, naming the extension and the flag.
  private need(flag: ExtensionDepName, op: string): void {
    if (!this.entry.manifest.deps.includes(flag)) throw new Error(`extension ${this.entry.name}: ${op} requires deps "${flag}"`);
  }

  now(): number {
    return this.opts.now();
  }

  async getAgent(id: AgentId): Promise<AgentRecord | null> {
    this.need("registry", "deps.getAgent");
    return this.opts.registry.get(id);
  }

  async listAgents(o?: { parent?: AgentId; state?: AgentState }): Promise<AgentRecord[]> {
    this.need("registry", "deps.listAgents");
    return this.opts.registry.list(o);
  }

  async record(agent: AgentId | null, kind: string, data: unknown, idempotencyKey: string): Promise<JournalEntry> {
    this.need("record", "deps.record");
    const full: ExtensionJournalKind = `ext.${this.entry.name}.${kind}`;
    const def = this.entry.journalKinds.find((d) => d.kind === kind || d.kind === full);
    if (!def) throw new Error(`extension ${this.entry.name}: undeclared journal kind ${JSON.stringify(kind)}`);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error(`extension ${this.entry.name}: journal data must be a JSON object`);
    }
    const verdict = def.validate(data);
    if (verdict === false) throw new Error(`extension ${this.entry.name}: invalid data for journal kind ${kind}`);
    if (typeof verdict === "string") throw new Error(verdict);
    const rec = agent !== null ? await this.opts.registry.get(agent) : await this.opts.root();
    if (!rec) throw new Error(`extension ${this.entry.name}: unknown agent ${agent ?? "(host)"}`);
    // `kind` is authoritative: an extension's data must never override the namespaced kind.
    const raw = { ...(data as Record<string, unknown>), kind: full } as JournalPayload;
    const payload = this.opts.redact ? this.opts.redact(raw) : raw;
    return this.opts.journal.append({ agent: rec.id, host: rec.host, generation: rec.generation, payload, idempotencyKey });
  }

  async deliver(to: AgentId, signal: Signal, idempotencyKey: string): Promise<void> {
    this.need("deliver", "deps.deliver");
    // Host-mediated delivery reaches any agent that exists (the host's addressability is the whole
    // registry, mirroring sendMessage's existence check rather than an agent-to-agent fence).
    if (!(await this.opts.registry.get(to))) throw new Error(`extension ${this.entry.name}: unknown agent ${to}`);
    await this.opts.mailbox.send(to, signal, idempotencyKey);
  }

  // Only credentials declared in the manifest are readable: their env names are owned at startup (config extend.ts), so a name
  // outside the manifest is a typo or an undeclared read, never a silent miss.
  credential(name: string): HostCredential {
    this.need("credentials", "deps.credential");
    if (!(this.entry.manifest.credentials ?? []).includes(name))
      throw new Error(`extension ${this.entry.name}: credential ${JSON.stringify(name)} is not declared in manifest.credentials`);
    return { name, read: () => this.readCredential(name) };
  }

  private readCredential(name: string): string | undefined {
    // `POMTREED_EXT_<NAME>_<CRED>` first, then `<dir>/<name>/credentials.<cred>` (provisioned 0600).
    const env = extensionCredentialEnv(this.entry.name, name);
    const fromEnv = process.env[env];
    if (fromEnv !== undefined) return fromEnv;
    const path = join(this.entry.rootDir, this.entry.name, `credentials.${name}`);
    try {
      return readFileSync(path, "utf8").trim();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  // Deny-all over a closed action set (core EXTENSION_ACTIONS, empty today): an action outside it is false, never a guess.
  // TODO(authz-escalation): a granted action will route into the approval primitive; none is defined, so every call resolves false.
  async authorize(action: string): Promise<boolean> {
    this.need("authorize", "deps.authorize");
    if (!isExtensionAction(action)) return false;
    return false;
  }

  log(line: string): void {
    this.opts.log?.(`[ext:${this.entry.name}] ${line}`);
  }
}

class ExtensionHostImpl implements ExtensionHost {
  readonly deps: ExtensionDeps;
  readonly config: ExtensionConfigView;
  private readonly entry: Loaded;
  private readonly logFn: (line: string) => void;

  constructor(entry: Loaded, deps: ExtensionDeps, logFn: (line: string) => void, config: ExtensionConfigView) {
    this.entry = entry;
    this.deps = deps;
    this.logFn = logFn;
    this.config = config;
  }

  // A compiled-in extension may claim top-level paths (e.g. the observe builtin's /live, /reports);
  // file-loaded extensions must stay under their own /v1/ext/<name>/ prefix.
  private checkPath(path: string, method: string): void {
    if (this.entry.builtin) {
      if (!path.startsWith("/")) throw new Error(`extension ${this.entry.name}: route path ${JSON.stringify(path)} must be absolute`);
    } else {
      const prefix = `/v1/ext/${this.entry.name}/`;
      if (!path.startsWith(prefix))
        throw new Error(`extension ${this.entry.name}: route path ${JSON.stringify(path)} must start with ${JSON.stringify(prefix)}`);
    }
    if (!ROUTE_METHODS.has(method)) throw new Error(`extension ${this.entry.name}: unsupported method ${JSON.stringify(method)}`);
  }

  // Undeclared is denied: every registration behind a manifest `capabilities` flag checks it here.
  private need(allowed: boolean | undefined, op: string, flag: string): void {
    if (allowed !== true) throw new Error(`extension ${this.entry.name}: ${op} requires capabilities.${flag}`);
  }

  route(def: RouteDef): void {
    this.need(this.entry.manifest.capabilities.routes, "host.route", "routes");
    this.checkPath(def.path, def.method);
    this.entry.routes.push(def);
  }

  stream(def: StreamRouteDef): void {
    this.need(this.entry.manifest.capabilities.routes, "host.stream", "routes");
    this.checkPath(def.path, def.method);
    this.entry.streams.push(def);
  }

  verb(spec: VerbSpec): void {
    this.need(this.entry.manifest.capabilities.verbs, "host.verb", "verbs");
    // The host namespaces the verb to its own extension name so an extension cannot spoof another's.
    this.entry.verbs.push({ ...spec, extension: this.entry.name });
  }

  journalKind(def: JournalKindDef): void {
    this.need(this.entry.manifest.capabilities.journalKinds, "host.journalKind", "journalKinds");
    this.entry.journalKinds.push(def);
  }

  onJournal(handler: (e: JournalEntry) => void | Promise<void>): () => void {
    this.need(this.entry.manifest.capabilities.hooks?.journal, "host.onJournal", "hooks.journal");
    const hook: JournalHook = { fn: handler, disabled: false };
    this.entry.journalHooks.add(hook);
    return () => {
      this.entry.journalHooks.delete(hook);
    };
  }

  onSpawn(handler: (e: { record: AgentRecord; requester: AgentId | null }) => void | Promise<void>): () => void {
    this.need(this.entry.manifest.capabilities.hooks?.spawn, "host.onSpawn", "hooks.spawn");
    const hook: SpawnHook = { fn: handler, disabled: false };
    this.entry.spawnHooks.add(hook);
    return () => {
      this.entry.spawnHooks.delete(hook);
    };
  }

  spawnSpec(transform: (spec: SpawnSpec, intent: SpawnIntent) => SpawnSpec | Promise<SpawnSpec>): void {
    this.need(this.entry.manifest.capabilities.hooks?.spawn, "host.spawnSpec", "hooks.spawn");
    this.entry.spawnSpecs.push({ fn: transform, disabled: false });
  }

  // Registration only: names are checked here; duplicates and admission are checked when the registry commits the extension.
  // Any throw during init fails the whole extension, so a partial set of definitions is never committed.
  workflow(def: WorkflowDef): void {
    if (!this.entry.registering) throw new Error(`extension ${this.entry.name}: host.workflow is only valid during init`);
    if (typeof def !== "object" || def === null) throw new Error(`extension ${this.entry.name}: workflow must be an object`);
    if (typeof def.name !== "string" || !NAME_RE.test(def.name))
      throw new Error(`extension ${this.entry.name}: invalid workflow name ${JSON.stringify(def.name)}`);
    if (typeof def.validate !== "function" || typeof def.run !== "function")
      throw new Error(`extension ${this.entry.name}: workflow ${def.name} needs validate and run`);
    if (this.entry.workflows.some((w) => w.name === def.name)) throw new Error(`extension ${this.entry.name}: duplicate workflow ${def.name}`);
    this.entry.workflows.push(def);
  }

  log(line: string): void {
    this.logFn(`[ext:${this.entry.name}] ${line}`);
  }
}

// True when `child` is `base` or lexically inside `base` (both realpathed). Rejects `..` escapes.
function isInside(base: string, child: string): boolean {
  const rel = relative(base, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Opt-in strict cleanup for embedders that retain state after a failed stop. Existing daemon callers keep best-effort stops.
export interface ExtensionStopOptions {
  throwOnStopFailure?: boolean;
  // Absolute callback-join deadline for strict stops. Without one, the newly awaited dispatch is bounded to five seconds.
  deadlineAt?: number;
}

export class ExtensionRegistryImpl implements ExtensionRegistry {
  private loaded: Loaded[] = [];
  private subscription: Subscription | null = null;
  private dispatch: Promise<void> = Promise.resolve();
  private started = false;
  // Set by the first startAll and never cleared: loading is boot-only (no load or registerBuiltin after start).
  private sealed = false;
  // Set by a successful stopAll or stopForShutdown: terminal. startAll after it is refused.
  private stopped = false;
  private readonly opts: ExtensionRegistryOptions;

  constructor(opts: ExtensionRegistryOptions) {
    this.opts = opts;
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  private configFor(name: ExtensionName): ExtensionConfigView {
    return this.opts.config?.(name) ?? Object.freeze({});
  }

  async load(dir: string): Promise<LoadedExtension[]> {
    if (this.sealed) throw new Error("extensions are boot-only: load after startAll is refused");
    // Keep compiled-in extensions; only the file-loaded set is re-read (a load is a reload of the dir).
    this.loaded = this.loaded.filter((l) => l.builtin);
    const root = realpathSync(dir);
    const names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const name of names) {
      this.loaded.push(await this.loadOne(root, realpathSync(join(root, name)), name));
    }
    return this.loaded.map((l) => ({ manifest: l.manifest, status: l.status, ...(l.error !== undefined && { error: l.error }) }));
  }

  private async loadOne(root: string, sub: string, dirName: string): Promise<Loaded> {
    const placeholder = (error: string): Loaded => ({
      name: dirName,
      dir: sub,
      rootDir: root,
      manifest: { name: dirName, entry: "", capabilities: {}, deps: [] },
      status: "failed",
      error,
      routes: [],
      streams: [],
      verbs: [],
      journalKinds: [],
      journalHooks: new Set(),
      spawnHooks: new Set(),
      spawnSpecs: [],
      workflows: [],
    });
    let manifest: ExtensionManifest;
    try {
      manifest = parseManifest(readFileSync(join(sub, "manifest.json"), "utf8"));
    } catch (e) {
      return placeholder(e instanceof Error ? e.message : String(e));
    }
    const entry: Loaded = {
      name: manifest.name,
      dir: sub,
      rootDir: root,
      manifest,
      status: "ok",
      routes: [],
      streams: [],
      verbs: [],
      journalKinds: [],
      journalHooks: new Set(),
      spawnHooks: new Set(),
      spawnSpecs: [],
      workflows: [],
    };
    try {
      // Entry containment: lexical check first (a `..` escape fails even if the target does not exist),
      // then realpath so a symlink inside the dir pointing outside is caught too.
      const entryAbs = resolve(sub, manifest.entry);
      if (!isInside(sub, entryAbs)) throw new Error(`extension ${manifest.name}: entry escapes extension dir: ${JSON.stringify(manifest.entry)}`);
      const entryReal = realpathSync(entryAbs);
      if (!isInside(sub, entryReal)) throw new Error(`extension ${manifest.name}: entry escapes extension dir via symlink: ${JSON.stringify(manifest.entry)}`);
      const mod = await import(pathToFileURL(entryReal).href);
      const ext = (mod as { default?: unknown }).default ?? mod;
      if (typeof ext !== "object" || ext === null) throw new Error(`extension ${manifest.name}: entry must export an object`);
      entry.ext = ext as Extension;
      entry.host = new ExtensionHostImpl(entry, new ExtensionDepsFacade(this.opts, entry), (line) => this.log(line), this.configFor(entry.name));
      // Registration ends when init settles: synchronously for a sync return (so a microtask queued by init is refused),
      // or when an async init settles. A throw clears it through the catch below.
      entry.registering = true;
      let init: void | Promise<void>;
      try {
        init = entry.ext.init?.(entry.host);
      } catch (e) {
        entry.registering = false;
        throw e;
      }
      if (init instanceof Promise) {
        try {
          await init;
        } finally {
          entry.registering = false;
        }
      } else {
        entry.registering = false;
      }
      return entry;
    } catch (e) {
      entry.status = "failed";
      entry.error = e instanceof Error ? e.message : String(e);
      this.log(`extension ${manifest.name} failed to load: ${entry.error}`);
      return entry;
    }
  }

  // TODO(ext-gate-unreviewed): gate start, routes and hooks on reviewed owners. Current behavior: startAll starts every extension
  // whose status is ok with no reviewed-owner check; only workflow admission (workflows.commit) is policy-gated here.
  async startAll(): Promise<void> {
    if (this.stopped) throw new Error("extensions are terminal after stop: startAll refused");
    if (this.started) return;
    this.started = true;
    this.sealed = true;
    // A builtin with an async init finishes registering before any start() runs.
    await Promise.all(this.loaded.map((l) => l.initPromise ?? Promise.resolve()));
    this.startJournalDispatch();
    for (const l of this.loaded) {
      if (l.status !== "ok") continue;
      try {
        await l.ext?.start?.();
      } catch (e) {
        l.status = "degraded";
        l.error = e instanceof Error ? e.message : String(e);
        this.log(`extension ${l.name} failed to start (degraded): ${l.error}`);
      }
    }
    // Workflows are admitted only after every owning extension started: a degraded or failed extension exposes nothing.
    for (const l of this.loaded) {
      if (l.status !== "ok") continue;
      try {
        this.opts.workflows?.commit(l.name, l.workflows);
      } catch (e) {
        l.status = "failed";
        l.error = e instanceof Error ? e.message : String(e);
        this.log(`extension ${l.name} workflows refused: ${l.error}`);
        try {
          await l.ext?.stop?.();
        } catch {
          // best effort: the extension is already failed
        }
      }
    }
  }

  async stopAll(options: ExtensionStopOptions = {}): Promise<void> {
    // Refuses (throws before stopping anything) while deterministic tasks are pending or running; no force bypass.
    if (this.opts.workflows) await this.opts.workflows.close();
    this.stopJournalDispatch();
    const failed: string[] = [];
    for (const l of this.loaded) {
      if (l.status !== "ok" && l.status !== "degraded") continue;
      try {
        await l.ext?.stop?.();
      } catch {
        // Extension errors can contain credentials. Expose names, never raw exception messages.
        failed.push(l.name);
        this.log(`extension ${l.name} failed to stop`);
      }
    }
    this.started = false;
    this.stopped = true;
    await this.finishStrictStop(options, failed);
  }

  // Shutdown only (after the workflow drain): stops every extension not in `retained` and withdraws its workflows. A retained
  // owner keeps its handlers and is not stopped, because its task is still live. Management stop stays strict (stopAll).
  async stopForShutdown(retained: readonly string[], options: ExtensionStopOptions = {}): Promise<{ stopped: string[]; retained: string[] }> {
    const keep = new Set(retained);
    // Do not await dispatch yet: an in-flight callback may require stop() to release it. Retained owners keep dispatch.
    if (keep.size === 0) this.stopJournalDispatch();
    const stopped: string[] = [];
    const failed: string[] = [];
    for (const l of this.loaded) {
      if (l.status !== "ok" && l.status !== "degraded") continue;
      if (keep.has(l.name)) {
        this.log(`extension ${l.name} retained at shutdown: workflow task still live`);
        continue;
      }
      try {
        await l.ext?.stop?.();
      } catch {
        failed.push(l.name);
        this.log(`extension ${l.name} failed to stop`);
      }
      // A stopped owner receives no further journal hooks; retained owners keep theirs (the subscription stays open).
      l.journalHooks.clear();
      this.opts.workflows?.withdraw(l.name);
      stopped.push(l.name);
    }
    this.started = false;
    this.stopped = true;
    await this.finishStrictStop(options, failed, keep.size === 0);
    return { stopped, retained: [...keep].sort() };
  }

  private async finishStrictStop(options: ExtensionStopOptions, failed: string[], joinDispatch = true): Promise<void> {
    if (!options.throwOnStopFailure) return;
    const errors = failed.length > 0 ? [`extensions failed to stop: ${failed.join(", ")}`] : [];
    // Stop hooks have all run before this join. A standalone strict call must not introduce an unbounded callback wait.
    if (joinDispatch && (await raceUntil(this.dispatch, options.deadlineAt ?? Date.now() + 5_000)) === EXPIRED)
      errors.push("extensions journal dispatch did not settle before deadline");
    if (errors.length > 0) throw new Error(errors.join("; "));
  }

  // Final cleanup after a shutdown drain (the journal subscription is kept open while retained owners still need it).
  // Closing is synchronous as before; embedders can await the returned barrier to join an already-running journal hook.
  finishShutdown(): Promise<void> {
    this.stopJournalDispatch();
    return this.dispatch;
  }

  // Names of the loaded, non-failed extensions (the valid state owners besides "operator").
  names(): string[] {
    return this.loaded.filter((l) => l.status !== "failed").map((l) => l.name);
  }

  routes(): RouteDef[] {
    return this.loaded.filter((l) => l.status !== "failed").flatMap((l) => l.routes);
  }

  streams(): StreamRouteDef[] {
    return this.loaded.filter((l) => l.status !== "failed").flatMap((l) => l.streams);
  }

  verbs(): VerbSpec[] {
    return this.loaded.filter((l) => l.status !== "failed").flatMap((l) => l.verbs);
  }

  // Compile-in an extension (trusted code, not file-loaded). It runs init() immediately and is
  // preserved across load(); start/stop ride the same startAll/stopAll lifecycle as file-loaded ones.
  registerBuiltin(ext: Extension): void {
    if (this.sealed) throw new Error("extensions are boot-only: registerBuiltin after startAll is refused");
    const manifest = ext.manifest;
    if (!NAME_RE.test(manifest.name)) throw new Error(`builtin extension: invalid name ${JSON.stringify(manifest.name)}`);
    if (RESERVED_NAMES.has(manifest.name)) throw new Error(`builtin extension: name ${JSON.stringify(manifest.name)} is reserved for the daemon`);
    // Compiled in with the host, so an absent version is the build's; a present one must still match.
    if (manifest.apiVersion !== undefined) assertExtensionApiVersion(manifest.name, manifest.apiVersion);
    // Compiled-in extensions declare too: one facade enforces everything, and the manifest documents what the builtin uses.
    parseCapabilities(manifest.name, manifest.capabilities);
    parseDeps(manifest.name, manifest.deps);
    const entry: Loaded = {
      name: manifest.name,
      dir: "",
      rootDir: "",
      manifest,
      status: "ok",
      builtin: true,
      routes: [],
      streams: [],
      verbs: [],
      journalKinds: [],
      journalHooks: new Set(),
      spawnHooks: new Set(),
      spawnSpecs: [],
      workflows: [],
    };
    entry.ext = ext;
    entry.host = new ExtensionHostImpl(entry, new ExtensionDepsFacade(this.opts, entry), (line) => this.log(line), this.configFor(entry.name));
    this.loaded.push(entry);
    entry.registering = true;
    let init: void | Promise<void>;
    try {
      init = ext.init?.(entry.host);
    } catch (e) {
      // Boot-fatal, as at HEAD: the entry is marked failed (no routes, verbs or workflows are exposed) and the error propagates.
      entry.registering = false;
      entry.status = "failed";
      entry.error = e instanceof Error ? e.message : String(e);
      this.log(`builtin extension ${manifest.name} failed to init: ${entry.error}`);
      throw e;
    }
    if (init instanceof Promise) {
      entry.initPromise = init.then(
        () => {
          entry.registering = false;
        },
        (e) => {
          entry.registering = false;
          entry.status = "failed";
          entry.error = e instanceof Error ? e.message : String(e);
          this.log(`builtin extension ${manifest.name} failed to init: ${entry.error}`);
        },
      );
    } else {
      entry.registering = false;
    }
  }

  private startJournalDispatch(): void {
    if (this.subscription) return;
    this.subscription = this.opts.journal.subscribe({});
    this.dispatch = this.dispatchLoop(this.subscription);
  }

  private stopJournalDispatch(): void {
    this.subscription?.close();
    this.subscription = null;
  }

  private async dispatchLoop(subscription: Subscription): Promise<void> {
    try {
      for await (const entry of subscription) {
        if (this.subscription !== subscription) return; // a closed subscription may still have already-queued entries
        for (const l of this.loaded) {
          if (l.status === "failed") continue;
          for (const hook of [...l.journalHooks]) {
            if (this.subscription !== subscription) return;
            if (hook.disabled || !l.journalHooks.has(hook)) continue;
            try {
              await hook.fn(entry);
            } catch (e) {
              hook.disabled = true; // per-hook circuit breaker
              this.log(`extension ${l.name}: onJournal hook disabled after throw: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      }
    } catch (e) {
      this.log(`journal dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // TODO(extensions): wire these into Daemon.spawn once extensions drive spawning. The per-hook circuit
  // breaker (disable on throw) lives here so the wiring is a one-line call per hook.
  async dispatchSpawn(record: AgentRecord, requester: AgentId | null): Promise<void> {
    for (const l of this.loaded) {
      if (l.status === "failed") continue;
      for (const hook of [...l.spawnHooks]) {
        if (hook.disabled) continue;
        try {
          await hook.fn({ record, requester });
        } catch (e) {
          hook.disabled = true;
          this.log(`extension ${l.name}: onSpawn hook disabled after throw: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  async transformSpawnSpec(spec: SpawnSpec, intent: SpawnIntent): Promise<SpawnSpec> {
    let out = spec;
    for (const l of this.loaded) {
      if (l.status === "failed") continue;
      for (const t of [...l.spawnSpecs]) {
        if (t.disabled) continue;
        try {
          out = await t.fn(out, intent);
        } catch (e) {
          t.disabled = true;
          this.log(`extension ${l.name}: spawnSpec transform disabled after throw: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return out;
  }
}

export function createExtensionRegistry(opts: ExtensionRegistryOptions): ExtensionRegistryImpl {
  return new ExtensionRegistryImpl(opts);
}
