import type { AgentId, AgentRecord, AgentState, HostId, JournalEntry, JsonValue, Report, Signal, SpawnSpec, StateDoc, StateKey, StateMeta } from "./types.ts";
import type { StateListOptions, StatePutResult, StateRemoveResult, Subscription } from "./ports.ts";
import type { DeterministicRunContext } from "./executor.ts";
import type { ExtParamDecl } from "./config/extend.ts";
import type { FetchMeta } from "./capture.ts";

// Extension architecture contracts. Extensions are user/operator-supplied plugins loaded
// by the daemon to add routes, verbs, journal kinds, and lifecycle hooks. Everything here
// is additive: it only references existing core types, never changes them.

// A stable extension name; `^[a-z0-9][a-z0-9_-]*$`
export type ExtensionName = string;

// A journal kind emitted by an extension; `ext.<name>.<kind>`
export type ExtensionJournalKind = `ext.${string}`;

export interface ExtensionJournalPayload {
  kind: ExtensionJournalKind;
  [k: string]: unknown;
}

// The version of the extension contract: the manifest, `ExtensionHost`, `ExtensionDeps`, route/verb/journal-kind shapes and the
// workflow definition and capability types in this file. It changes when one of them changes incompatibly (a member removed,
// renamed, retyped or made required, or a semantic change a conforming extension would notice) and when an addition needs host
// support to mean anything (a new manifest field the host must act on); adding an optional type member the host ignores does not. A file-loaded extension must declare the exact value in manifest.json; the host refuses any other, or none, at
// load. Separate from MESSAGING_API_VERSION (the adapter wire contract). 2 added the manifest `provides` list.
export const EXTENSION_API_VERSION = 2 as const;
export type ExtensionApiVersion = typeof EXTENSION_API_VERSION;

export interface ExtensionManifest {
  // Required in manifest.json (no default). Optional here only because compiled-in extensions are built with the host, so
  // their version is the build's; registerBuiltin refuses a present value that differs.
  apiVersion?: ExtensionApiVersion;
  name: ExtensionName;
  entry: string;
  // Required in manifest.json and in a compiled-in manifest (no default, no exemption): what the extension may register and which
  // host services it may call. Anything not declared is denied by the host facade (`extension <name>: <op> requires <flag>`). An
  // empty block (`{}`, `[]`) is valid and declares nothing. Flag-to-operation map: SPEC.md, extension section.
  capabilities: ExtensionCapabilities;
  deps: ExtensionDepName[];
  // The credential names the extension may read (`host.deps.credential(name)`); others are refused. Each owns the env name
  // POMTREED_EXT_<NAME>_<CRED> (config extend.ts), so no declared config key can collide with one.
  credentials?: string[];
  // The extension's config keys, declared statically (JSON; see ExtParamDecl). The loader composes them into the registry as
  // `ext.<segment>.<key>` before pomtreed starts, so they resolve with the same sources, origins and refusals as core keys.
  params?: ExtParamDecl[];
  store?: { name: ExtensionStoreName; dir?: string };
  // The components this extension contributes to the host besides its own `entry`, declared statically so config composition and
  // checks need no import of extension code. Only kind "sandbox" is accepted today (PROVIDES_KINDS); any other kind refuses the
  // extension at load. First-party backends are built into the host and declare nothing here.
  provides?: ExtensionProvides[];
  remote?: boolean;
}

export const PROVIDES_KINDS = ["sandbox"] as const;
export type ProvidesKind = (typeof PROVIDES_KINDS)[number];

// A sandbox backend contributed by the extension. `id` matches `^[a-z][a-z0-9-]{0,30}$`, equals the extension name or starts with
// `<name>-`, and may not be `auto`, a built-in backend id or begin with `pomtree`. `entry` is the provider module, relative to the
// extension directory and contained in it. `portVersion` is the sandbox port version the provider speaks (a positive integer).
// `params` and `credentials` follow the extension-level fields of the same name; `deps` is the subset of ExtensionDepName it uses.
export interface SandboxProvides {
  kind: "sandbox";
  id: string;
  entry: string;
  portVersion: number;
  params?: ExtParamDecl[];
  credentials?: string[];
  deps?: ExtensionDepName[];
}

// One member per accepted kind; a later kind adds a member and its PROVIDES_KINDS name.
export type ExtensionProvides = SandboxProvides;

// Registration capabilities. `routes`: host.route and host.stream. `verbs`: host.verb. `journalKinds`: host.journalKind.
// `hooks.journal`: host.onJournal. `hooks.spawn`: host.onSpawn and host.spawnSpec. `host.workflow` has no flag: it is gated by
// workflow admission (reviewed-owner policy).
export interface ExtensionCapabilities {
  routes?: boolean;
  verbs?: boolean;
  journalKinds?: boolean;
  hooks?: { journal?: boolean; spawn?: boolean };
}

export interface Extension {
  manifest: ExtensionManifest;
  init?(host: ExtensionHost): void | Promise<void>;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export type RouteScope =
  | { kind: "operator" }
  | { kind: "agent"; self?: boolean; allowChild?: boolean }
  | { kind: "host"; channel?: string }
  | { kind: "ext" }
  | { kind: "public" };

export interface RouteDef {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  scope: RouteScope;
  rawBody?: boolean;
  maxBodyBytes?: number;
  handler(req: ExtensionRequest): Promise<ExtensionResponse> | ExtensionResponse;
}

// A streaming (SSE-style) route: the handler writes frames over a connection that also
// signals client close, so the extension can unsubscribe its journal readers.
export interface StreamConnection {
  write(frame: string): void;
  end(): void;
  onClose(cb: () => void): void;
}
export interface StreamRouteDef {
  method: "GET";
  path: string;
  scope: RouteScope;
  handler(req: ExtensionRequest, conn: StreamConnection): void | Promise<void>;
}

export interface ExtensionRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export interface ExtensionResponse {
  status: number;
  body: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface VerbSpec {
  extension: ExtensionName;
  verb: string;
  subcommands?: string[];
  usage: string;
  audience: "operator";
  endpoint: { method: "GET" | "POST" | "PUT" | "DELETE"; path: string };
}

export interface JournalKindDef {
  kind: string;
  validate(data: unknown): boolean | string;
}

export interface SpawnIntent {
  name: string;
  task: string;
  budgetMicros?: number;
}

export interface HostCredential {
  name: string;
  read(): string | undefined;
}

// The closed set of actions `deps.authorize` can ever grant. Empty today: authorize is deny-all (TODO(authz-escalation): routing
// into the approval primitive is not built). An action is added here only per need, decided with the user, together with the
// policy that grants it.
export const EXTENSION_ACTIONS = [] as const;
export type ExtensionAction = (typeof EXTENSION_ACTIONS)[number];

export function isExtensionAction(action: string): action is ExtensionAction {
  return (EXTENSION_ACTIONS as readonly string[]).includes(action);
}

export interface ExtensionDeps {
  hostId: HostId;
  now(): number;
  getAgent(id: AgentId): Promise<AgentRecord | null>;
  listAgents(opts?: { parent?: AgentId; state?: AgentState }): Promise<AgentRecord[]>;
  journal: {
    read(opts: { from?: number; agent?: AgentId; limit?: number }): Promise<JournalEntry[]>;
    subscribe(opts: { from?: number; agent?: AgentId }): Subscription;
  };
  record(agent: AgentId | null, kind: string, data: unknown, idempotencyKey: string): Promise<JournalEntry>;
  deliver(to: AgentId, signal: Signal, idempotencyKey: string): Promise<void>;
  store?: unknown;
  credential(name: string): HostCredential;
  // Resolves false for every action outside EXTENSION_ACTIONS (all of them today); requires manifest deps "authorize".
  authorize(action: string): Promise<boolean>;
  log(line: string): void;
}

// Declared host capabilities of a reviewed workflow. Absent declares nothing (no workflow ops; fenced deterministic ops
// only). Every capability is denied unless declared here; the host validates and snapshots these at commit. Cooperative, not
// isolation: a reviewed handler can still reach ambient daemon code, so declarations bound what correct handlers use.
export interface WorkflowFetchCapability {
  hosts: string[]; // exact lowercase DNS hostnames, HTTPS only
  maxRequests: number; // requests SENT per TASK lifetime, each redirect hop included (a repaired task starts at zero; not run-wide)
  maxBytes: number; // per response body
  timeoutMs: number; // <= 10000
}
export interface WorkflowCapabilities {
  state?: boolean; // instance-scoped durable state (requires input.instance)
  store?: Record<string, never>; // keyed durable state owned by the extension (WorkflowRunOps.store); no options yet
  // Extension-wide keyed state shared by every workflow of the declaring extension (WorkflowRunOps.shared); "r" reads only.
  sharedStore?: { mode: "r" | "rw" };
  fetch?: WorkflowFetchCapability;
  reports?: { maxBytes: number }; // root-owned report publication
  ask?: boolean; // ask the user through the existing escalation path
  modelChildren?: { maxBudgetMicros: number }; // container children allowed, each carved within this ceiling
}

// `url` is the URL that answered (FetchMeta.finalUrl). The FetchMeta fields below are what the origin said: every redirect hop,
// the answering Content-Type, and the response headers on FETCH_HEADER_ALLOWLIST (capture.ts), so workflows and the capture broker
// share one shape.
// TODO(capture-broker): make required once examples/hn-digest fakes fill them
export interface WorkflowFetchResult extends Partial<Pick<FetchMeta, "finalUrl" | "redirects" | "contentType" | "headers">> {
  url: string;
  status: number;
  body: string;
  fetchedAt: number;
  sha256: string;
}

// The capability surface a handler receives. Methods reject when the capability is undeclared, the task is no longer live
// (generation, abort, deadline) or a cap is exceeded. Keys (current behavior):
// - setState, publishReport, sendToUser: the caller's key is scoped by the host to workflow + instance (not to the task), so a
//   replayed mutation with the same key and value is idempotent across repaired tasks.
// - getState and fetch take no key. fetch's maxRequests is a per-TASK budget (a repaired task starts at zero, no re-fetch), and
//   every request sent counts against it, each followed redirect hop included.
// - ask takes a key scoped to workflow + instance, but the escalation itself is task-owned today: a replacement task may ask
//   again. Handlers can persist their own durable markers to avoid repeating a question.
export interface WorkflowRunOps {
  readonly instance: string; // validated input.instance when state is declared; "" otherwise
  readonly runKey: string; // this task's execution id (fresh per launch); not a durable logical run. Handlers persist their own run id.
  // State is one instance cell: getState returns the latest accepted write; setState's key is a mutation idempotency key, not a cell name.
  getState(): Promise<JsonValue | null>;
  setState(value: JsonValue, key: string): Promise<void>;
  fetch(url: string): Promise<WorkflowFetchResult>;
  publishReport(req: { name: string; content: string; mediaType?: string }, key: string): Promise<Report>;
  sendToUser(body: string, key: string): Promise<void>;
  // Keyed state owned by the declaring extension (owner is fixed to its name; the host scopes keys to workflow + instance like
  // setState). Methods reject when `capabilities.store` is not declared. put/rm take a mutation idempotency key.
  store: {
    get(key: StateKey): Promise<StateDoc | null>;
    put(req: { key: StateKey; value: JsonValue; expectRev?: number | null }, idempotencyKey: string): Promise<StatePutResult>;
    list(opts?: StateListOptions): Promise<StateMeta[]>;
    rm(req: { key?: StateKey; prefix?: string; olderThanMs?: number; expectRev?: number }, idempotencyKey: string): Promise<StateRemoveResult>;
  };
  // Keyed state shared by ALL workflows of the declaring extension (owner fixed to its name, so no cross-extension access), under
  // the extension-wide prefix `ext/s/` (never a workflow scope, which is always `<wf>/g/` or `<wf>/i/<instance>/`); the prefix is
  // stripped on the way out. Same signatures, results and guards as `store` (fence, size caps and owner limits, expectRev
  // compare-and-set with null = must not exist, host-path refusal, one content-free state_op per mutation). Reject when
  // `capabilities.sharedStore` is not declared; put/rm also reject (403) under mode "r". A write is data only: it wakes,
  // delivers and launches nothing. The operator writes the same keys through /v1/state (`pomtree state put <ext> ext/s/<key>`), and
  // the doc's `writer` says who wrote it ({ operator: true }, or { workflow, instance } for a workflow; an agent may not write there).
  shared: {
    get(key: StateKey): Promise<StateDoc | null>;
    put(req: { key: StateKey; value: JsonValue; expectRev?: number | null }, idempotencyKey: string): Promise<StatePutResult>;
    list(opts?: StateListOptions): Promise<StateMeta[]>;
    rm(req: { key?: StateKey; prefix?: string; olderThanMs?: number; expectRev?: number }, idempotencyKey: string): Promise<StateRemoveResult>;
  };
  // TODO(workflow-ask-repair): pending decision on transferring a pending question to replacement tasks; current behavior
  // creates a task-owned escalation.
  ask(question: string, key: string): Promise<{ escalation: string }>;
}

export interface WorkflowRunContext extends DeterministicRunContext {
  workflow: WorkflowRunOps;
}

// A reviewed in-process workflow: a pure input validator plus a handler that speaks only the fenced context (identity,
// generation, deterministic ops and the declared workflow capabilities). Registered by an extension at init; the host qualifies
// it as `<extension>/<name>` and admits it only for host-approved extensions. Trust is cooperative, not isolation.
// `I` is the validated input type the handler receives (the normalized value persisted at admission). Methods, not
// properties, so a typed definition stays assignable to the default `WorkflowDef`.
export interface WorkflowDef<I extends JsonValue = JsonValue> {
  name: string; // `^[a-z0-9][a-z0-9_-]*$`, unique within the extension
  continuation?: boolean; // default false; reviewed workflow opts into same-task crash replay and durable suspend
  capabilities?: WorkflowCapabilities;
  validate(input: JsonValue): { ok: true; value: I } | { ok: false; error: string };
  run(ctx: WorkflowRunContext & { input: I }): Promise<void>;
}

// The resolved, frozen, read-only configuration an extension sees, keyed by full path: its own `ext.<segment>.*` keys plus
// every non-sensitive core key. Fixed at startup (all keys are restart-only).
export type ExtensionConfigView = Readonly<Record<string, unknown>>;

export interface ExtensionHost {
  readonly config: ExtensionConfigView;
  route(def: RouteDef): void;
  workflow(def: WorkflowDef): void;
  stream(def: StreamRouteDef): void;
  verb(spec: VerbSpec): void;
  journalKind(def: JournalKindDef): void;
  onJournal(handler: (e: JournalEntry) => void | Promise<void>): () => void;
  onSpawn(handler: (e: { record: AgentRecord; requester: AgentId | null }) => void | Promise<void>): () => void;
  spawnSpec(transform: (spec: SpawnSpec, intent: SpawnIntent) => SpawnSpec | Promise<SpawnSpec>): void;
  deps: ExtensionDeps;
  log(line: string): void;
}

export type ExtensionDepName = "registry" | "journal" | "record" | "deliver" | "authorize" | "credentials" | "store";
export type ExtensionStoreName = "reports" | "schedules" | "escalations" | "templates" | "sessions" | "state";

export type LoadedExtensionStatus = "ok" | "failed" | "degraded";

export interface LoadedExtension {
  manifest: ExtensionManifest;
  status: LoadedExtensionStatus;
  error?: string;
}

export interface ExtensionRegistry {
  load(dir: string): Promise<LoadedExtension[]>;
  startAll(): Promise<void>;
  stopAll(): Promise<void>;
  routes(): RouteDef[];
  streams(): StreamRouteDef[];
  verbs(): VerbSpec[];
}
