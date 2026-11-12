import { randomBytes } from "node:crypto";

// Post-start credential delivery into a remote sandbox, and the scan that proves a secret never rode the create call.
// Pure over an injected transport (the `connect` channel or exec): this module owns the policy (where a secret may live,
// which mode, atomic replace, revocation), the transport owns the bytes. The secret value is handed to `put` and nowhere
// else: not to an error, a trace event or a returned object.

export const DEFAULT_SECRET_DIR = "/run/pomtree/secrets";
const DEFAULT_REVOKE_TIMEOUT_MS = 10_000;

// Contract for the injected transport (the connect channel or exec inside the sandbox). An implementation that does not
// meet it makes the channel's guarantees void:
// - `put` creates the file exclusively (O_EXCL, never following a symlink at the path) with exactly the requested mode,
//   owned by the sandbox user, inside a secret directory that is not world-writable, and fsyncs the data before it
//   returns, so a later `rename` cannot publish unflushed bytes. It never writes into an existing file.
// - `rename` is rename(2): atomic, replacing the target.
// - `remove` deletes a file; an absent file is not an error.
export interface CredentialTransport {
  put(path: string, bytes: Uint8Array, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

// Events carry names and paths, never values.
export type CredentialTraceEvent = { op: "deliver" | "rotate" | "revoke"; name: string; path: string };

export interface DeliverCredentialOptions {
  transport: CredentialTransport;
  // Variable-style name of the credential, e.g. `API_TOKEN`; the env var returned is `<name>_FILE`.
  name: string;
  value: string;
  mode: number;
  path: string;
  secretDir?: string;
  // A throwing trace never affects delivery, rotation or revocation.
  trace?: (event: CredentialTraceEvent) => void;
  // Injected for tests; resolves after `ms`.
  sleep?: (ms: number) => Promise<void>;
}

export interface CredentialHandle {
  readonly envName: string;
  readonly path: string;
  // Atomically replaces the file's content: a concurrent reader sees the old or the new value, never a partial one.
  rotate(newValue: string): Promise<void>;
  // Refuses later rotations at once, waits up to `timeoutMs` for an in-flight rotation, then removes the file and any
  // temp file a failed cleanup left behind. A removal that still fails throws naming the paths; retry revoke.
  revoke(opts?: { timeoutMs?: number }): Promise<void>;
}

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
// 0600 lets the owner replace or chmod the file; rotation itself never writes in place (it renames a new file over it).
const ALLOWED_MODES = new Set([0o400, 0o600]);
const TEMP_MARK = ".tmp-";

// Paths with a live handle, per transport (one sandbox), released when the handle is fully revoked.
const activePaths = new WeakMap<CredentialTransport, Set<string>>();

function checkPath(path: string, dir: string): void {
  const base = dir.replace(/\/+$/, "");
  const rest = path.startsWith(`${base}/`) ? path.slice(base.length + 1) : undefined;
  if (rest === undefined || rest === "" || rest.includes("/") || rest === "." || rest === ".." || rest.includes("\0")) {
    throw new Error(
      `the secret path ${JSON.stringify(path)} is not a file directly inside the secret directory ${base}; give a path of the form ${base}/<file> (no subdirectories, no ".." and no NUL)`,
    );
  }
  if (rest.includes(TEMP_MARK)) {
    throw new Error(
      `the secret file name ${JSON.stringify(rest)} contains "${TEMP_MARK}", which is reserved for the channel's temporary files; choose a name without it`,
    );
  }
}

// Redacts the value and its common encodings from text: raw, base64 (padded and not), base64url, hex (both cases),
// URL-encoded, and each non-blank line of a multi-line value. Forms are computed once. Limit: an arbitrary transform
// (compression, a cipher, splitting the value) is not recognised; transports must not echo request bodies.
function makeRedactor(value: string): (text: string) => string {
  const buf = Buffer.from(value, "utf8");
  const forms = new Set<string>([
    value,
    buf.toString("base64"),
    buf.toString("base64").replace(/=+$/, ""),
    buf.toString("base64url"),
    buf.toString("hex"),
    buf.toString("hex").toUpperCase(),
    encodeURIComponent(value),
  ]);
  for (const line of value.split(/\r?\n/)) if (line.trim() !== "" && line !== value) forms.add(line);
  const ordered = [...forms].filter((f) => f !== "").sort((x, y) => y.length - x.length);
  return (text) => ordered.reduce((t, f) => t.split(f).join("[REDACTED]"), text);
}

const describe = (e: unknown, redact: (t: string) => string): string => redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export async function deliverCredential(opts: DeliverCredentialOptions): Promise<CredentialHandle> {
  const { transport, name, mode, path } = opts;
  const dir = opts.secretDir ?? DEFAULT_SECRET_DIR;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!NAME_RE.test(name)) {
    throw new Error(
      `the credential name ${JSON.stringify(name)} is not an environment-style name (A-Z, 0-9, underscore, starting with a letter); pass a name like API_TOKEN`,
    );
  }
  if (!ALLOWED_MODES.has(mode)) {
    throw new Error(
      `the secret file mode 0${mode.toString(8)} would let other users read the credential; request 0400 (or 0600 when the owner must be able to rewrite it)`,
    );
  }
  if (opts.value === "") {
    throw new Error(`the credential ${name} has an empty value, so there is nothing to deliver; fetch the value before delivering it`);
  }
  checkPath(path, dir);
  const active = activePaths.get(transport) ?? new Set<string>();
  activePaths.set(transport, active);
  if (active.has(path)) {
    throw new Error(
      `another credential handle already owns ${path} in this sandbox, and two handles would overwrite each other; revoke the existing handle first or choose a different file name`,
    );
  }
  active.add(path);

  const emit = (event: CredentialTraceEvent) => {
    try {
      opts.trace?.(event);
    } catch {
      // A broken trace sink must not undo a delivery or block a revocation.
    }
  };

  const envName = `${name}_FILE`;
  const redactors = [makeRedactor(opts.value)];
  const redactAll = (t: string) => redactors.reduce((acc, r) => r(acc), t);
  let revoked = false;
  let removed = false;
  // Files a failed cleanup may have left holding a secret; retried on the next rotate and on revoke.
  const orphans = new Set<string>();
  // Operations run in order so a rotate cannot interleave with another rotate; the chain never rejects.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const cleanup = async (p: string): Promise<boolean> => {
    try {
      await transport.remove(p);
      orphans.delete(p);
      return true;
    } catch {
      orphans.add(p);
      return false;
    }
  };
  const retryOrphans = async () => {
    for (const p of [...orphans]) await cleanup(p);
  };

  // Write a sibling temp file with a random name, then rename over the target; a failure leaves the old content.
  const replace = async (value: string, op: "deliver" | "rotate"): Promise<void> => {
    const redact = makeRedactor(value);
    if (op === "rotate") redactors.push(redact);
    const tmp = `${path}${TEMP_MARK}${randomBytes(8).toString("hex")}`;
    try {
      await transport.put(tmp, new TextEncoder().encode(value), mode);
      await transport.rename(tmp, path);
    } catch (e) {
      const clean = await cleanup(tmp);
      const left = clean ? "" : `; the temporary file ${tmp} could not be removed and may hold the new credential, revoke() retries its removal`;
      throw new Error(
        `could not ${op} the credential ${name} into ${path}: ${describe(e, redact)}${left}; the file keeps its previous content, check the sandbox connection and retry`,
      );
    }
    if (revoked) {
      // A revoke overtook this rotation: do not leave the new file behind.
      await cleanup(path);
      return;
    }
    emit({ op, name, path });
  };

  try {
    await replace(opts.value, "deliver");
  } catch (e) {
    active.delete(path);
    throw e;
  }

  return {
    envName,
    path,
    rotate: (newValue) =>
      serial(async () => {
        if (revoked) {
          throw new Error(
            `the credential ${name} was revoked, so ${path} was removed and cannot be refreshed; deliver a new credential through a new deliverCredential call if access should be restored`,
          );
        }
        if (newValue === "") {
          throw new Error(`the replacement for credential ${name} is empty, so the file keeps its current value; fetch the new value before rotating`);
        }
        await retryOrphans();
        await replace(newValue, "rotate");
      }),
    revoke: async (o) => {
      revoked = true;
      // A hung rotation must not block revocation: wait for it only up to the timeout, then remove regardless.
      await Promise.race([chain, sleep(o?.timeoutMs ?? DEFAULT_REVOKE_TIMEOUT_MS)]);
      if (!removed) {
        try {
          await transport.remove(path);
          removed = true;
        } catch (e) {
          orphans.add(path);
          throw new Error(
            `could not remove ${path} while revoking the credential ${name}: ${describe(e, redactAll)}; later rotations are already refused, retry revoke to remove the file`,
          );
        }
        orphans.delete(path);
      }
      await retryOrphans();
      if (orphans.size > 0) {
        throw new Error(
          `revoked the credential ${name} but could not remove ${[...orphans].join(", ")}, which may still hold it; later rotations are refused, retry revoke or remove the file by other means`,
        );
      }
      active.delete(path);
      emit({ op: "revoke", name, path });
    },
  };
}

export interface LeakScanInput {
  // What the adapter sent at create time.
  createEnv: Readonly<Record<string, string>>;
  createArgs?: readonly string[];
  labels?: Readonly<Record<string, string>>;
  sentinel: string;
}

// Plain-text match only: encoded leaks (base64, URL-encoded) are not detected. Throws naming where the sentinel was
// found (never the sentinel itself) when it is present in the create-time environment, args or labels.
export function leakScan(input: LeakScanInput): void {
  const { sentinel } = input;
  if (sentinel === "") throw new Error("the leak scan was given an empty sentinel, which would match everything; plant a unique non-empty value");
  const hide = (s: string) => s.replaceAll(sentinel, "<secret>");
  const found: string[] = [];
  for (const [k, v] of Object.entries(input.createEnv)) {
    if (k.includes(sentinel) || v.includes(sentinel)) found.push(`environment variable ${hide(k)}`);
  }
  (input.createArgs ?? []).forEach((a, i) => {
    if (a.includes(sentinel)) found.push(`argument ${i}`);
  });
  for (const [k, v] of Object.entries(input.labels ?? {})) {
    if (k.includes(sentinel) || v.includes(sentinel)) found.push(`label ${hide(k)}`);
  }
  if (found.length > 0) {
    throw new Error(
      `the planted secret appears in the create-time ${found.join(", ")}; deliver it by proxy swap or after start through deliverCredential into a 0400 file, and put one in the create call only when the operator sets sandbox.secretsInEnv`,
    );
  }
}
