// The loopback sandbox backend: the provider module named by manifest.json's provides[0].entry. It exports exactly what the daemon's
// loader reads (`portVersion`, `declaration`, `create`); the loader fills `id`, `params` and `credentials` from the manifest.
//
// It talks to the invented loopback sandbox API (routes in wire.mts) at `sandbox.loopback.baseUrl`, only through `deps.request`, which
// stamps workflow.fetch.userAgent on every call. It reads its one credential, `apiKey`, through `deps.credential` on every request
// and never stores it. Imports: node: builtins, @pomtree/core (a package the daemon ships) and files in this directory; the loader's
// import guard refuses anything else.
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  IdempotencyConflictError,
  SANDBOX_CAPABILITIES,
  SANDBOX_PORT_VERSION,
  SandboxOutcomeUnknownError,
  SandboxUnavailableError,
  sandboxCredentialEnv,
  sandboxIdForKey,
  secretFileEnv,
} from "@pomtree/core";
import type {
  ImageIdentity,
  ProbeResult,
  Sandbox,
  SandboxBackendDeps,
  SandboxBackendModule,
  SandboxDeclaration,
  SandboxHandle,
  SandboxId,
  SandboxListing,
  SandboxOwner,
  SandboxSpec,
} from "@pomtree/core";
import { API, createBody, fingerprint, labelProblem, listPath, parseRecord, sandboxPath, toListing } from "./wire.mts";
import type { LoopbackRecord } from "./wire.mts";

const ID = "loopback";
// The variable the operator sets to the credential file's path, derived by core's naming rule; named in refusals only.
const CREDENTIAL_FILE_ENV = secretFileEnv(sandboxCredentialEnv(ID, "apiKey"));

export const portVersion = SANDBOX_PORT_VERSION;

// Static and exhaustive: every capability answered. The loopback API lists by owner on the provider side (list.byTag) and attests an
// image digest (image.digestAttest); it runs no process, so it offers no terminal, connect, files, egress or resource limits.
const DECLARED: readonly string[] = ["list.byTag", "image.digestAttest"];
export const declaration: SandboxDeclaration = {
  backend: ID,
  capabilities: Object.fromEntries(SANDBOX_CAPABILITIES.map((c) => [c, DECLARED.includes(c)])) as SandboxDeclaration["capabilities"],
  region: null,
  idempotency: "unique-name", // the sandbox name is derived from the idempotency key, and the provider refuses a taken name
  idempotencyWindowMs: null,
  tagging: "metadata",
  output: "poll",
  maxLifetimeMs: null,
  preemptible: true,
  billing: { unit: "none", whileStopped: false, whilePaused: false },
};

interface Reply {
  status: number;
  json: unknown;
}

export function create(deps: SandboxBackendDeps): Sandbox {
  const baseUrl = deps.config.baseUrl;
  if (typeof baseUrl !== "string" || baseUrl === "") {
    throw new Error(`sandbox backend ${ID}: sandbox.loopback.baseUrl is not set; set it to the loopback sandbox API's URL`);
  }

  // Every provider call goes through here: one place stamps the credential, so no call site can forget it, and one place maps transport
  // and auth failures to the port's errors. `deps.request` adds the User-Agent; setting one here would throw.
  async function call(method: "GET" | "POST", path: string, body?: string, timeoutMs?: number): Promise<Reply> {
    const headers: Record<string, string> = { authorization: `Bearer ${await deps.credential("apiKey")}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await deps.request(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body }),
      ...(timeoutMs !== undefined && { timeoutMs }),
    });
    if (res.status === 401) {
      throw new SandboxUnavailableError(
        "auth",
        `the loopback provider refused the credential (401); write a valid key into the file ${CREDENTIAL_FILE_ENV} names`,
      );
    }
    const text = new TextDecoder().decode(res.body);
    return { status: res.status, json: text === "" ? null : JSON.parse(text) };
  }
  // A transport failure on anything but create: the provider is unreachable.
  async function reach(method: "GET" | "POST", path: string, body?: string, timeoutMs?: number): Promise<Reply> {
    try {
      return await call(method, path, body, timeoutMs);
    } catch (e) {
      if (e instanceof SandboxUnavailableError) throw e;
      throw new SandboxUnavailableError(
        "provider-outage",
        `the loopback provider at ${baseUrl} did not answer ${method} ${path} (${e instanceof Error ? e.message : String(e)}); check sandbox.loopback.baseUrl and that the provider is up`,
      );
    }
  }
  const unexpected = (what: string, r: Reply) =>
    new Error(`the loopback provider answered ${what} with HTTP ${r.status} ${JSON.stringify(r.json)}; check the provider's logs`);

  async function get(id: SandboxId): Promise<LoopbackRecord | null> {
    const r = await reach("GET", sandboxPath(id));
    if (r.status === 404) return null;
    if (r.status !== 200) throw unexpected("a sandbox lookup", r);
    return parseRecord(r.json);
  }

  function handle(id: SandboxId): SandboxHandle {
    return {
      id,
      async *output() {
        let from = 0;
        for (;;) {
          const r = await reach("GET", `${sandboxPath(id, "logs")}?from=${from}`);
          if (r.status === 404) return;
          if (r.status !== 200) throw unexpected("a log read", r);
          const page = r.json as { lines: string[]; next: number; running: boolean };
          for (const line of page.lines) yield { stream: "stdout" as const, chunk: `${line}\n` };
          from = page.next;
          if (!page.running) return;
          await sleep(200);
        }
      },
      async wait() {
        for (;;) {
          const r = await reach("GET", `${sandboxPath(id, "wait")}?timeoutMs=10000`, undefined, 30_000);
          if (r.status === 404)
            throw new SandboxUnavailableError("not-found", `sandbox ${id} no longer exists on the loopback provider; reconcile will report it`);
          if (r.status !== 200) throw unexpected("a wait", r);
          const rec = parseRecord(r.json);
          if (rec.state === "preempted") {
            throw new SandboxUnavailableError("provider-outage", `the loopback provider preempted sandbox ${id}; resume the agent from its checkpoint`);
          }
          if (rec.state === "exited") return { exitCode: rec.exitCode ?? 1 };
        }
      },
    };
  }

  async function end(verb: "stop" | "kill", id: SandboxId): Promise<void> {
    const r = await reach("POST", sandboxPath(id, verb));
    if (r.status === 404) return; // already gone is success
    if (r.status !== 200) throw unexpected(verb, r);
  }

  return {
    declaration,

    async probe(): Promise<ProbeResult> {
      let r: Reply;
      try {
        r = await call("GET", `${API}/health`);
      } catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        const auth = e instanceof SandboxUnavailableError && e.reason === "auth";
        return {
          withheld: [],
          problems: [
            auth
              ? { code: "auth", cause, action: `write a valid key into the file ${CREDENTIAL_FILE_ENV} names` }
              : { code: "unreachable", cause, action: "check sandbox.loopback.baseUrl and that the provider is up" },
          ],
          account: null,
        };
      }
      const account = (r.json as { account?: unknown } | null)?.account;
      return { withheld: [], problems: [], account: typeof account === "string" ? createHash("sha256").update(account).digest("hex") : null };
    },

    async start(spec: SandboxSpec, idempotencyKey: string): Promise<SandboxHandle> {
      const problem = labelProblem(spec.labels);
      if (problem !== null) throw new Error(`sandbox backend ${ID} refused to start agent ${spec.agent}: ${problem}`);
      const name = sandboxIdForKey(idempotencyKey);
      const body = createBody(name, spec);
      let r: Reply;
      try {
        r = await call("POST", `${API}/sandboxes`, body);
      } catch (e) {
        if (e instanceof SandboxUnavailableError) throw e;
        // No reply: the create may or may not have taken effect. The name is derived from the key, so a retry is safe.
        throw new SandboxOutcomeUnknownError(name, idempotencyKey, e);
      }
      if (r.status === 201) return handle(parseRecord(r.json).name);
      if (r.status === 409) {
        const existing = parseRecord((r.json as { sandbox?: unknown } | null)?.sandbox);
        if (existing.fingerprint !== fingerprint(body)) throw new IdempotencyConflictError("sandbox start", idempotencyKey);
        return handle(existing.name); // the same start, repeated: return the sandbox it made
      }
      throw unexpected("a create", r);
    },

    async attach(id: SandboxId): Promise<SandboxHandle> {
      const rec = await get(id);
      if (rec === null) throw new SandboxUnavailableError("not-found", `sandbox ${id} does not exist on the loopback provider; nothing to attach`);
      if (rec.state !== "running") throw new SandboxUnavailableError(undefined, `sandbox ${id} is ${rec.state}, not running; nothing to attach`);
      return handle(id);
    },

    stop: (id: SandboxId) => end("stop", id),
    kill: (id: SandboxId) => end("kill", id),

    async inspect(id: SandboxId) {
      const rec = await get(id);
      if (rec === null) return null;
      return { running: rec.state === "running", exitCode: rec.exitCode, status: rec.state };
    },

    async list(owner: SandboxOwner): Promise<SandboxListing[]> {
      const r = await reach("GET", listPath(owner));
      if (r.status !== 200) throw unexpected("a list", r);
      return ((r.json as { sandboxes: unknown[] }).sandboxes ?? []).map((x) => toListing(parseRecord(x)));
    },

    // The provider keeps nothing besides sandboxes (no volumes, snapshots or templates), so there is nothing to reclaim.
    reclaim: async () => [],

    async imageIdentity(ref: string): Promise<ImageIdentity> {
      const r = await reach("GET", `${API}/images/${encodeURIComponent(ref)}`);
      if (r.status !== 200) throw unexpected("an image lookup", r);
      const digest = (r.json as { digest: string }).digest;
      return { engineLocalId: digest, configDigest: digest, revision: null };
    },

    // The loopback sandbox has no workspace (it runs no process and mounts nothing), so there is never work to collect.
    resultWork: async () => ({ dirty: false, fingerprint: "loopback-no-workspace" }),
  };
}

// Type check only: the module has exactly the shape the loader reads.
const _module: SandboxBackendModule = { portVersion, declaration, create };
void _module;
