import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { sandboxCredentialEnv, secretFileEnv, secretFileModeReason } from "@pomtree/core";
import type { ProcessRunner, SandboxBackendDeps, SandboxRequester } from "@pomtree/core";

// The dependency facade handed to one sandbox backend's `create`. One place enforces, for every backend: the project fetch identity
// on every outbound call (fetch, request, WebSocket), a credential reader limited to the backend's own declared names that reads
// through the shared secret-file mode rule, and `run` only when the manifest declared it. Guarantees hold against bugs and careless
// code. They are not isolation: the backend runs in-process with the daemon's full Node privileges and a hostile reviewed module can
// read the daemon's environment and files directly, so the operator's review of the module's bytes is what protects the daemon.

export interface SecretFileRead {
  mode: number;
  content: string;
}
// A credential is a token or key; anything larger is a mistake (or a device or a pipe fed endlessly).
export const SECRET_FILE_MAX_BYTES = 64 * 1024;

// Opens the file without blocking (a FIFO at the path then cannot hang the daemon), requires a regular file of bounded size, and
// reads its mode and contents from that one descriptor (never stat-then-read by path).
export function readSecretFileByDescriptor(path: string): SecretFileRead {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} is not a regular file; point the variable at a plain file holding the credential`);
    if (st.size > SECRET_FILE_MAX_BYTES)
      throw new Error(
        `${path} is ${st.size} bytes, over the ${SECRET_FILE_MAX_BYTES}-byte limit for a credential; point the variable at the file holding only the credential`,
      );
    return { mode: st.mode & 0o7777, content: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
}

export interface SandboxBackendDepsOptions {
  id: string; // the backend id
  credentials: readonly string[]; // the declared credential names
  config: Readonly<Record<string, unknown>>;
  userAgent: string; // the resolved workflow.fetch.userAgent
  fetch: typeof fetch; // the underlying fetch; the facade stamps it
  request: SandboxRequester; // the kit's requester (createRequest, built with the same userAgent); the facade also stamps and polices it
  env: Readonly<Record<string, string | undefined>>;
  readSecretFile?: (path: string) => SecretFileRead;
  log: (event: string, fields: Record<string, unknown>) => void;
  now: () => number;
  declaresRun: boolean; // the manifest's provides[].deps lists "run"
  run?: ProcessRunner; // the daemon's runner; handed over only when declaresRun
}

const UA = "user-agent";

function refuseCallerUserAgent(id: string): never {
  throw new TypeError(`sandbox backend ${id}: User-Agent is set by the daemon from workflow.fetch.userAgent; remove the header`);
}

function hasUserAgent(headers: Record<string, string> | undefined): boolean {
  return headers !== undefined && Object.keys(headers).some((k) => k.toLowerCase() === UA);
}

function stampHeaders(id: string, userAgent: string, headers: Record<string, string> | undefined): Record<string, string> {
  if (headers !== undefined) {
    if (typeof headers !== "object" || headers === null || ![Object.prototype, null].includes(Object.getPrototypeOf(headers)))
      throw new TypeError(
        `sandbox backend ${id}: request headers must be a plain object of name to string; pass { "X-Name": "value" }, not a Headers object or an array`,
      );
  }
  if (hasUserAgent(headers)) refuseCallerUserAgent(id);
  return { ...(headers ?? {}), "User-Agent": userAgent };
}

function deepFreeze<T>(id: string, v: T, path: string): T {
  if (ArrayBuffer.isView(v) && v.byteLength > 0)
    throw new TypeError(
      `sandbox backend ${id}: config value ${path} is a binary buffer, which cannot be frozen; use a string (for example base64) or an array`,
    );
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(id, (v as Record<string, unknown>)[k], `${path}.${k}`);
  }
  return v;
}

export function createSandboxBackendDeps(o: SandboxBackendDepsOptions): SandboxBackendDeps {
  const { id, userAgent } = o;
  const readSecret = o.readSecretFile ?? readSecretFileByDescriptor;
  const declared = [...o.credentials];

  const stampedFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    for (const [k, v] of new Headers(init?.headers)) headers.set(k, v);
    if (headers.has(UA)) refuseCallerUserAgent(id);
    headers.set("User-Agent", userAgent);
    // `redirect: "manual"`: a followed cross-origin redirect would forward the caller's credential headers to another origin, and the
    // provider then decides explicitly whether to follow (re-sending only what it should). No caller depends on automatic following.
    return o.fetch(input, { ...init, headers, redirect: "manual" });
  }) as typeof fetch;

  const request = Object.assign(
    (url: string, init: Parameters<SandboxRequester>[1]) => o.request(url, { ...init, headers: stampHeaders(id, userAgent, init.headers) }),
    {
      openWebSocket: (url: string, init?: { headers?: Record<string, string>; protocols?: string | string[] }) =>
        o.request.openWebSocket(url, { ...init, headers: stampHeaders(id, userAgent, init?.headers) }),
    },
  ) as SandboxRequester;

  async function credential(name: string): Promise<string> {
    if (!declared.includes(name))
      throw new Error(
        `sandbox backend ${id} asked for credential ${JSON.stringify(name)}, which it did not declare (declared: ${declared.length === 0 ? "none" : declared.join(", ")}); add it to provides[].credentials in the manifest`,
      );
    const variable = secretFileEnv(sandboxCredentialEnv(id, name));
    const file = o.env[variable];
    if (file === undefined || file === "")
      throw new Error(`sandbox backend ${id} needs credential ${name}; set ${variable} to the absolute path of a file (mode 0600) holding it`);
    if (!isAbsolute(file)) throw new Error(`${variable} must be an absolute path (the value is not shown); set it to the absolute path of the credential file`);
    let read: SecretFileRead;
    try {
      read = readSecret(file);
    } catch (e) {
      throw new Error(`${variable}: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}; check the path and that the daemon can read it`);
    }
    const refusal = secretFileModeReason(file, { mode: read.mode });
    if (refusal !== null) throw new Error(`${variable}: ${refusal}`);
    const secret = read.content.replace(/\r?\n$/, "");
    if (secret === "") throw new Error(`${variable}: ${file} is empty; write the credential into it`);
    return secret;
  }

  if (o.declaresRun && o.run === undefined)
    throw new Error(`sandbox backend ${id} declares the run dep but the daemon supplied no process runner; wire a ProcessRunner into the backend deps`);

  // Frozen, so a provider cannot swap the stamped transports or the credential reader on the shared object; `config` is a frozen
  // deep copy, so neither can it change the daemon's resolved configuration.
  Object.freeze(request);
  return Object.freeze({
    fetch: stampedFetch,
    request,
    credential,
    log: o.log,
    now: o.now,
    config: deepFreeze(id, structuredClone(o.config), "config"),
    ...(o.declaresRun && o.run !== undefined && { run: o.run }),
  });
}
