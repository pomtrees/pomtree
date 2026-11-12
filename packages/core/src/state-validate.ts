import { SANDBOX_BACKEND_ID_RE } from "./config/sandbox-manifest.ts";
import { SandboxBackendMismatchError } from "./errors.ts";
import type { AgentId, SandboxBackendId, SandboxId } from "./types.ts";

// The single definition of the agent record's sandbox backend field, shared by every Registry realization (the store on read and
// write, the fake) and the daemon. Pure: every function either returns or throws.

// `sandboxBackend` is null while the record holds no sandbox and a backend id while it does. A missing (undefined), empty or
// malformed value is invalid state, for example a row written by a build before the field existed, and is never read as null.
export function checkAgentSandboxBackend(agent: AgentId, value: unknown): SandboxBackendId | null {
  if (value === null) return null;
  if (typeof value === "string" && SANDBOX_BACKEND_ID_RE.test(value)) return value;
  throw new Error(
    `agent ${agent} has an invalid sandbox backend ${JSON.stringify(value)}: a record holds null while it has no sandbox and a backend id (${SANDBOX_BACKEND_ID_RE.source}) while it has one; the record was written by an incompatible build or damaged, so move the database file aside and restart to re-initialize`,
  );
}

// The fence: while a record holds a backend it does not change. Returns the backend the record holds after the write; throws
// SandboxBackendMismatchError when a different backend is selected against a recorded one.
export function fenceSandboxBackend(
  record: { sandbox: SandboxId | null; sandboxBackend: SandboxBackendId | null },
  selected: SandboxBackendId,
): SandboxBackendId {
  if (typeof selected !== "string" || !SANDBOX_BACKEND_ID_RE.test(selected)) {
    throw new Error(
      `the selected sandbox backend ${JSON.stringify(selected)} is not a backend id (${SANDBOX_BACKEND_ID_RE.source}); pass the id of the backend about to start the sandbox`,
    );
  }
  if (record.sandboxBackend !== null && record.sandboxBackend !== selected) {
    throw new SandboxBackendMismatchError(record.sandbox, record.sandboxBackend, selected);
  }
  return selected;
}

// The pin lifecycle, applied by every Registry.setSandbox: the backend is pinned for as long as the record holds a sandbox id.
// Clearing the sandbox (null) clears the pin, so a run whose first start failed definitively under backend A can start under B,
// and passing a backend with null is a caller bug. Setting a sandbox without a backend keeps the pin; with one, it is fenced.
export function sandboxBackendAfter(
  record: { sandbox: SandboxId | null; sandboxBackend: SandboxBackendId | null },
  sandbox: SandboxId | null,
  backend: SandboxBackendId | undefined,
): SandboxBackendId | null {
  if (sandbox === null) {
    if (backend !== undefined) {
      throw new Error(
        `a sandbox backend (${backend}) was passed while clearing the sandbox; the backend is recorded together with a sandbox id, so pass the sandbox id too, or omit the backend`,
      );
    }
    return null;
  }
  return backend === undefined ? record.sandboxBackend : fenceSandboxBackend(record, backend);
}
