import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import type { ExtParamDecl } from "./config/extend.ts";
import type { Sandbox } from "./ports.ts";
import type { SandboxDeclaration } from "./sandbox-capabilities.ts";
import type { SandboxBackendId } from "./types.ts";

// The provider contract every sandbox backend implements, built-in or contributed by an extension, plus the two pure decisions the
// loader takes about a contributed one: the port version match and the content-hash pin. Pure: no fs. The caller walks the extension
// directory and hands `hashExtensionTree` the listing.

// The version of the Sandbox port: its methods and facets, SandboxDeclaration, SandboxBackendDeps and the error contract. A
// provider's `portVersion` must equal it exactly. Bump when a port method, facet, dependency or error class changes shape or
// meaning. Adding a name to SANDBOX_CAPABILITIES does not bump: a declaration parsed at runtime reads a missing capability as false
// and refuses an unknown one. Built-ins carry the same constant.
export const SANDBOX_PORT_VERSION = 1;

// Used only by the optional `run` dep. Runs an argv (never a shell string) with a timeout and an explicit environment. Present in SandboxBackendDeps only when the
// manifest declares the `run` dep; declaring it is for review visibility and for scripting through a fake, not enforcement.
export interface ProcessRunOptions {
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}
export interface ProcessRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export type ProcessRunner = (argv: readonly string[], options: ProcessRunOptions) => Promise<ProcessRunResult>;

// The adapter-facing HTTP call. A structural mirror of `RequestFn`, `RequestInit`, `KitResponse` and `Requester` in
// packages/sandbox-kit/src/request.ts (core cannot import the kit); the kit's implementation is checked against these types, so a
// change to either side must change both. The composition root injects the kit's `createRequest`, which stamps
// workflow.fetch.userAgent and applies `tls` per call only.
export interface SandboxRequestOptions {
  method: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  tls?: { ca?: string; cert?: string; key?: string };
  upgrade?: boolean; // resolve on an HTTP upgrade with the raw socket in `socket`
  signal?: AbortSignal;
  maxBytes?: number; // cap on the buffered response body; the call rejects when exceeded (kit default 16 MiB)
  timeoutMs?: number; // reject when no complete response arrives in time (kit default 60 s; none for `upgrade`)
}
export interface SandboxResponse {
  status: number;
  headers: Record<string, string>; // lower-cased names; repeated headers joined with ", "
  body: Uint8Array;
  socket?: Duplex; // only when `upgrade` was requested and the server switched protocols
  head?: Uint8Array; // bytes read past the headers on an upgrade
}
export type SandboxRequestFn = (url: string, init: SandboxRequestOptions) => Promise<SandboxResponse>;
// The request function plus a WebSocket opener bound to the same User-Agent. The kit's test-only `WebSocketImpl` option is not
// offered to adapters; the kit's opener accepts a superset of this parameter, so it is assignable here.
export interface SandboxRequester extends SandboxRequestFn {
  openWebSocket(url: string, init?: { headers?: Record<string, string>; protocols?: string | string[] }): WebSocket;
}

export interface SandboxBackendDeps {
  // Stamps the resolved workflow.fetch.userAgent; a call that sets its own User-Agent throws.
  fetch: typeof fetch;
  // Stamps the same User-Agent on HTTP calls and, through `openWebSocket`, on WebSocket handshakes. This replaces a separate
  // `WebSocket` constructor dep: the global one cannot set headers, and a second path would be a way around the stamp. Raw
  // node:https and node:tls are not offered to adapters.
  request: SandboxRequester;
  // Resolves only the provider's own declared credential names; re-read per use; the file is mode-checked.
  credential(name: string): Promise<string>;
  log: (event: string, fields: Record<string, unknown>) => void;
  now: () => number;
  run?: ProcessRunner;
  // The provider's own sandbox.<id>.* values plus non-sensitive core keys.
  config: Readonly<Record<string, unknown>>;
}

export interface SandboxBackendProvider {
  id: SandboxBackendId;
  portVersion: number;
  declaration: SandboxDeclaration; // static; readable without create()
  params: readonly ExtParamDecl[]; // composed under sandbox.<id>.*
  credentials: readonly string[]; // names only
  create(deps: SandboxBackendDeps): Sandbox;
}

// The module a contributed backend exports: the loader fills `id`, `params` and `credentials` from the manifest entry.
export type SandboxBackendModule = Pick<SandboxBackendProvider, "portVersion" | "declaration" | "create">;

// Note: packages/pomtreed/src/extension-manifest.ts still duplicates this id pattern and reserved list; the
// extension loader should import them from here instead. Current behavior: both copies are identical.
// Ids no extension may provide: `auto` (the selection keyword) and the built-in backends, first-party ones included.
export const RESERVED_SANDBOX_BACKEND_IDS: readonly string[] = ["auto", "docker", "podman", "kubernetes", "sail", "e2b"];
const BACKEND_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;

// Refuses an id a contributed backend may not use. Returns the id so a caller can chain it.
export function validateBackendId(id: string): string {
  if (!BACKEND_ID_RE.test(id)) {
    throw new Error(`sandbox backend id ${JSON.stringify(id)} is invalid: it must match ${BACKEND_ID_RE.source}; rename the backend`);
  }
  if (RESERVED_SANDBOX_BACKEND_IDS.includes(id) || id.startsWith("pomtree")) {
    throw new Error(`sandbox backend id "${id}" is reserved (auto, the built-in backends and anything starting with "pomtree"); choose another id`);
  }
  return id;
}

// The provider's port version must equal the daemon's exactly; no range negotiation.
export function checkPortVersion(id: string, portVersion: unknown): void {
  if (portVersion !== SANDBOX_PORT_VERSION) {
    throw new Error(
      `sandbox backend ${id} speaks port version ${String(portVersion)}; this daemon speaks ${SANDBOX_PORT_VERSION}; ` +
        "update the backend to the current port version or run a daemon that speaks its version",
    );
  }
}

// One regular file of an extension directory, as the caller measured it. `path` is relative to the directory, POSIX separators.
export interface ExtensionTreeEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string; // lowercase hex of the contents
}

// The pin of an extension directory: `sha256:` plus the SHA-256 over one line per file, `<path>\0<size>\0<sha256>\n`, sorted by
// path in byte order. The caller lists EVERY file (no exclusions) and refuses symlinks before calling. The input order and the
// directory's own location do not matter, so a copy elsewhere pins the same.
export function hashExtensionTree(entries: readonly ExtensionTreeEntry[]): string {
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.path === "" || e.path.startsWith("/") || e.path.includes("\\") || e.path.includes("\0") || e.path.includes("\n")) {
      throw new Error(
        `extension file path ${JSON.stringify(e.path)} is not a relative POSIX path without NUL or newline; list files relative to the extension directory`,
      );
    }
    if (e.path.split("/").some((s) => s === "" || s === "." || s === "..")) {
      throw new Error(`extension file path ${JSON.stringify(e.path)} has an empty, "." or ".." segment; list normalised relative paths`);
    }
    if (seen.has(e.path)) {
      throw new Error(`extension file path ${JSON.stringify(e.path)} is listed twice; list each file once`);
    }
    seen.add(e.path);
    if (!Number.isSafeInteger(e.size) || e.size < 0) {
      throw new Error(`extension file ${JSON.stringify(e.path)} has size ${String(e.size)}; pass the byte length as a non-negative integer`);
    }
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) {
      throw new Error(`extension file ${JSON.stringify(e.path)} has a malformed sha256; pass 64 lowercase hex characters`);
    }
  }
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  const h = createHash("sha256");
  for (const e of sorted) h.update(`${e.path}\0${e.size}\0${e.sha256}\n`);
  return `sha256:${h.digest("hex")}`;
}
