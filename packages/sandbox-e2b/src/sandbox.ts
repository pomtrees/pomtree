// The E2B Sandbox adapter. Lifecycle over E2B's REST API only: create, list by metadata, get and
// kill. Everything that would need envd (E2B's in-sandbox agent: process exec, files, streams) is left out, because the research
// notes do not document its wire protocol; see the package README ("Unverified") and the TODO tags below.
//
// Identity. The pomtree SandboxId is sandboxIdForKey(idempotencyKey), stamped into the sandbox's metadata (`pomtree.sandbox`);
// E2B's own sandboxID is a provider detail found by listing on that tag. Creates are deduplicated by the kit's createOnce with the
// tag-lookup mechanism: list by the tag first, create once, and after an unknown outcome look again instead of creating twice.
//
// Exit observations. E2B has no exit code for a sandbox and forgets a killed one. What this adapter saw end (its own stop or kill,
// or a sandbox it was tracking that vanished) is kept in a per-instance cache so wait() and inspect() report it; the cache is an
// observation, not state: a restarted daemon sees a vanished sandbox as gone (inspect null), which the port treats as "no such
// sandbox".
//
// Ownership. list(owner) fails closed: it returns only sandboxes labelled with the owner's store id, and reports the host and
// generation start() stamped from the spec. Admission still refuses this backend today (see the README).
//
// Output. The port has no declaration value for "no output", so `output` says "poll", the mode a REST-only adapter would use; in fact
// output() yields nothing until envd is spoken (TODO(e2b-envd-exec)).

import {
  type AgentId,
  type ImageIdentity,
  type ProbeResult,
  SANDBOX_TAGS,
  type Sandbox,
  SandboxCapabilityError,
  type SandboxDeclaration,
  type SandboxHandle,
  type SandboxId,
  type SandboxInfo,
  type SandboxListing,
  type SandboxOwner,
  type SandboxSpec,
  SandboxUnavailableError,
  ownerStampTags,
  readOwnerStamp,
  sandboxIdForKey,
} from "@pomtree/core";
import { type CreateFailure, createOnce, type FoundSandbox, type ProbePolicy } from "@pomtree/sandbox-kit/dedup";
import { defaultSleep } from "@pomtree/sandbox-kit/retry";
import { API_KEY_FILE_ENV, type E2BApi, E2BApiError, type E2BSandboxInfo } from "./api.ts";
import { BACKEND_ID, backendSelector, checkLabels, decodeMetadata, sandboxMetadata, sandboxSelector } from "./metadata.ts";

// The caller labels pomtreed stamps with the owning store and daemon epoch (the same names the Docker adapter filters on).
const OWNER_STORE_LABEL = "store_id";
const OWNER_EPOCH_LABEL = "daemon_epoch";

// Exit codes reported for an end the adapter caused: E2B kills in both cases, so these follow the container convention
// (SIGTERM for stop, SIGKILL for kill).
const STOP_EXIT = 143;
const KILL_EXIT = 137;

// The hard lifetime E2B enforces: 1 hour on the Hobby plan, 24 hours on Pro (documented, sandbox-lifetime FAQ). The declaration is
// static, so it states the shorter one; a Pro account rotates earlier than it must.
export const E2B_MAX_LIFETIME_MS = 3_600_000;

// What this adapter declares, from what the research notes document (README, "Capabilities"). Only list.byTag is claimed; every
// capability that would need envd, a REST endpoint the notes do not show, or an unverified limit is declared false.
export const E2B_DECLARATION: SandboxDeclaration = {
  backend: BACKEND_ID,
  capabilities: {
    terminal: false,
    connect: false,
    loopback: false,
    "files.put": false,
    "files.get": false,
    "files.volume": false,
    "mounts.host": false,
    "image.ociPull": false,
    "image.template": false,
    "image.digestAttest": false,
    "snapshot.disk": false,
    "snapshot.memory": false,
    fork: false,
    pause: false,
    "list.byTag": true,
    "egress.denyAll": false,
    "egress.allowHost": false,
    "egress.allowCidr": false,
    "reach.outbound": false,
    "reach.exposedPort": false,
    "reach.hostAlias": false,
    "secrets.env": false,
    "secrets.proxySwap": false,
    "resources.limits": false,
    "isolation.gvisor": false,
    "isolation.microvm": false,
    "lease.extend": false,
  },
  region: null,
  idempotency: "tag-lookup",
  idempotencyWindowMs: null,
  tagging: "metadata",
  output: "poll", // no "none" value exists in the port; output() yields nothing today (module header)
  maxLifetimeMs: E2B_MAX_LIFETIME_MS,
  preemptible: false,
  billing: { unit: "second", whileStopped: false, whilePaused: false },
};

export interface E2BSandboxOptions {
  api: E2BApi;
  // The template every sandbox starts from; "" = the spec's image reference is the template id.
  template: string;
  // The create-time timeout in seconds (E2B kills the sandbox when it lapses).
  timeoutS: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
  // How often wait() reads the sandbox's state (default 5 s).
  pollMs?: number;
  // Lookups after an unknown create outcome (default: the kit's 3 probes over about 10 s).
  probe?: ProbePolicy;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Ended {
  exitCode: number | null;
  // "stopped" and "killed": this adapter ended it. "expired": it vanished while tracked; E2B's timeout is the only documented way
  // the provider ends a sandbox on its own.
  reason: "stopped" | "killed" | "expired";
}

// Consecutive failed state reads wait() tolerates before reporting the provider as unavailable.
const WAIT_READ_FAILURES = 5;

const OCI_LIKE = /[/:@]/;

export class E2BSandbox implements Sandbox {
  readonly declaration = E2B_DECLARATION;
  readonly #api: E2BApi;
  readonly #template: string;
  readonly #timeoutS: number;
  readonly #log: (event: string, fields: Record<string, unknown>) => void;
  readonly #pollMs: number;
  readonly #probe: ProbePolicy | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  // pomtree id -> E2B sandboxID (immutable once known).
  readonly #providerIds = new Map<SandboxId, string>();
  // Sandboxes this instance started or attached.
  readonly #tracked = new Set<SandboxId>();
  readonly #ended = new Map<SandboxId, Ended>();
  readonly #endWaiters = new Map<SandboxId, (() => void)[]>();
  readonly #waits = new Map<SandboxId, Promise<{ exitCode: number }>>();

  constructor(o: E2BSandboxOptions) {
    if (!Number.isSafeInteger(o.timeoutS) || o.timeoutS < 1) {
      throw new Error(`E2B sandbox timeout ${o.timeoutS} s is not a whole number of seconds of at least 1; set sandbox.e2b.leaseMs to 1000 or more`);
    }
    this.#api = o.api;
    this.#template = o.template;
    this.#timeoutS = o.timeoutS;
    this.#log = o.log ?? (() => {});
    this.#pollMs = o.pollMs ?? 5000;
    this.#probe = o.probe;
    this.#sleep = o.sleep ?? ((ms) => defaultSleep(ms));
    this.#now = o.now ?? Date.now;
  }

  // ---- identity ----

  #found(info: E2BSandboxInfo): FoundSandbox | null {
    const meta = decodeMetadata(info.metadata);
    const id = meta.tags[SANDBOX_TAGS.sandbox];
    if (id === undefined || meta.unresolved.length > 0) {
      this.#log("sandbox.e2b.foreign", { provider: info.sandboxID, unresolved: meta.unresolved });
      return null;
    }
    this.#providerIds.set(id, info.sandboxID);
    return { id, tags: { ...meta.labels, ...meta.tags } };
  }

  // The E2B sandboxID of a pomtree id, or null when no live sandbox carries it.
  async #providerId(id: SandboxId): Promise<string | null> {
    const known = this.#providerIds.get(id);
    if (known !== undefined) return known;
    const found = (await this.#api.list(sandboxSelector(id))).map((i) => this.#found(i)).filter((f) => f?.id === id);
    if (found.length > 1) {
      throw new Error(`${found.length} E2B sandboxes carry pomtree id ${id}; kill the extra ones by hand (E2B dashboard or CLI), then retry`);
    }
    return found.length === 1 ? (this.#providerIds.get(id) ?? null) : null;
  }

  // ---- lifecycle ----

  #refuse(spec: SandboxSpec): string {
    // Checked before anything is created, so a refused start leaves nothing behind.
    if (spec.cmd !== undefined && spec.cmd.length > 0) {
      // TODO(e2b-envd-exec): running a command needs envd's process API, whose wire protocol the research notes do not document.
      // Current behavior: a spec with cmd is refused; the template's own start command is what runs.
      throw new Error(
        "sandbox backend e2b cannot run spec.cmd: commands run through E2B's envd, which this adapter does not speak yet; bake the command into the E2B template's start command and leave cmd unset",
      );
    }
    if (spec.egress !== undefined) {
      throw new Error(
        "sandbox backend e2b does not enforce an egress allowlist (egress.denyAll and egress.allowHost are not declared), and an egress spec must never run unenforced; use a backend that enforces egress, or remove egress from the template",
      );
    }
    if (spec.runtime !== undefined && Object.keys(spec.runtime).length > 0) {
      throw new Error("sandbox backend e2b has no selectable runtime; remove the runtime block from the template");
    }
    const bind = spec.mounts.find((m) => m.kind === "bind");
    if (bind !== undefined) {
      throw new Error(`sandbox backend e2b cannot bind-mount a host path (${bind.containerPath}): it is a hosted service; remove the bind mount`);
    }
    // Workspace, session and scratch mounts are not realised here: a hosted backend has no host mounts (mounts.host is false), and
    // boot admission decides how the workspace travels instead.
    checkLabels(spec.labels);
    const template = this.#template !== "" ? this.#template : spec.image;
    if (template === "" || OCI_LIKE.test(template)) {
      throw new Error(
        `sandbox backend e2b starts sandboxes from E2B templates, but the image reference ${JSON.stringify(spec.image)} is not a template id; set sandbox.e2b.template, or use an E2B template id as the image`,
      );
    }
    return template;
  }

  async start(spec: SandboxSpec, idempotencyKey: string): Promise<SandboxHandle> {
    const templateID = this.#refuse(spec);
    const id = sandboxIdForKey(idempotencyKey);
    const metadata = sandboxMetadata(id, spec.agent, spec, spec.labels);
    const result = await createOnce(
      {
        mechanism: "tag-lookup",
        key: idempotencyKey,
        ownerTags: { [SANDBOX_TAGS.agent]: spec.agent, [SANDBOX_TAGS.backend]: BACKEND_ID, ...ownerStampTags(spec) },
        lookupTags: { [SANDBOX_TAGS.sandbox]: id },
        ...(this.#probe === undefined ? {} : { probe: this.#probe }),
      },
      {
        create: async (req) => {
          const { sandboxID } = await this.#api.create({ templateID, timeout: this.#timeoutS, metadata, envVars: { ...spec.env } });
          this.#providerIds.set(req.derivedId, sandboxID);
          return { id: req.derivedId };
        },
        // The lookup selects on the encoded tag; adoption then compares the decoded tags createOnce asks for.
        find: async () =>
          (await this.#api.list(sandboxSelector(id))).flatMap((info) => {
            const f = this.#found(info);
            return f === null ? [] : [f];
          }),
        classify: (err): CreateFailure => {
          if (err instanceof E2BApiError) return err.applied === "unknown" ? "unknown" : "failed";
          if (err instanceof Error && err.name.startsWith("Sandbox")) return "failed"; // quota, auth: refused, nothing applied
          return "unknown"; // no reply: the create may have been applied
        },
        sleep: this.#sleep,
        now: this.#now,
      },
    );
    this.#ended.delete(id);
    this.#tracked.add(id);
    this.#log("sandbox.e2b.start", { sandbox: id, provider: this.#providerIds.get(id) ?? null, adopted: result.adopted });
    return this.#handle(id);
  }

  #handle(id: SandboxId): SandboxHandle {
    return { id, output: () => this.#output(id), wait: () => this.#wait(id) };
  }

  // TODO(e2b-envd-exec): process output streams through envd, which this adapter does not speak. Current behavior: output() yields
  // nothing and ends when the sandbox ends.
  async *#output(id: SandboxId): AsyncGenerator<{ stream: "stdout" | "stderr"; chunk: string }> {
    await this.#wait(id).catch(() => {});
  }

  #endSignal(id: SandboxId): Promise<void> {
    if (this.#ended.has(id)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.#endWaiters.get(id) ?? [];
      list.push(resolve);
      this.#endWaiters.set(id, list);
    });
  }

  #markEnded(id: SandboxId, ended: Ended): void {
    if (!this.#ended.has(id)) this.#ended.set(id, ended);
    this.#providerIds.delete(id);
    for (const w of this.#endWaiters.get(id) ?? []) w();
    this.#endWaiters.delete(id);
  }

  #expiredError(id: SandboxId): SandboxUnavailableError {
    return new SandboxUnavailableError(
      "not-found",
      `sandbox ${id} ended without pomtree stopping it: E2B removed it, most likely because its ${this.#timeoutS} s timeout expired (exit reason expired); resume the agent from its checkpoint`,
    );
  }

  #settled(id: SandboxId, e: Ended): { exitCode: number } {
    if (e.reason === "expired" || e.exitCode === null) throw this.#expiredError(id);
    return { exitCode: e.exitCode };
  }

  #wait(id: SandboxId): Promise<{ exitCode: number }> {
    let p = this.#waits.get(id);
    if (p === undefined) {
      p = this.#poll(id);
      this.#waits.set(id, p);
      p.catch(() => {}); // a caller that never awaits must not see an unhandled rejection
    }
    return p;
  }

  async #poll(id: SandboxId): Promise<{ exitCode: number }> {
    let failures = 0;
    for (;;) {
      const done = this.#ended.get(id);
      if (done !== undefined) return this.#settled(id, done);
      let live: boolean;
      try {
        live = (await this.#state(id)) !== null;
        failures = 0;
      } catch (e) {
        if (++failures >= WAIT_READ_FAILURES) {
          throw new SandboxUnavailableError(
            "provider-outage",
            `cannot read the state of sandbox ${id} from E2B after ${failures} attempts (${e instanceof Error ? e.message : String(e)}); check E2B's status and the network, the sandbox may still be running`,
          );
        }
        live = true;
      }
      if (!live) {
        this.#markEnded(id, { exitCode: null, reason: "expired" });
        continue;
      }
      await Promise.race([this.#sleep(this.#pollMs), this.#endSignal(id)]);
    }
  }

  // The provider's view: null when no sandbox carries the id any more.
  async #state(id: SandboxId): Promise<E2BSandboxInfo | null> {
    const providerId = await this.#providerId(id);
    if (providerId === null) return null;
    const info = await this.#api.get(providerId);
    if (info === null) this.#providerIds.delete(id);
    return info;
  }

  async attach(id: SandboxId, agent: AgentId): Promise<SandboxHandle> {
    const ended = this.#ended.get(id);
    const providerId = ended === undefined ? await this.#providerId(id) : null;
    if (providerId === null) {
      throw new SandboxUnavailableError("not-found", `sandbox ${id} is not running on E2B (no sandbox carries its metadata); start a new one`);
    }
    const info = await this.#api.get(providerId);
    if (info === null) throw new SandboxUnavailableError("not-found", `sandbox ${id} is no longer running on E2B; start a new one`);
    const owner = decodeMetadata(info.metadata).tags[SANDBOX_TAGS.agent];
    if (owner !== agent) {
      throw new Error(`sandbox ${id} belongs to agent ${owner ?? "(untagged)"}, not ${agent}; attach it for its own agent, or start a new sandbox`);
    }
    this.#tracked.add(id);
    return this.#handle(id);
  }

  async #end(id: SandboxId, ended: Ended): Promise<void> {
    if (this.#ended.has(id)) return; // already stopped or killed: success, and the first exit code stands
    const providerId = await this.#providerId(id);
    if (providerId !== null) {
      await this.#api.kill(providerId);
      this.#markEnded(id, ended);
    } else if (this.#tracked.has(id)) {
      this.#markEnded(id, { exitCode: null, reason: "expired" }); // it was already gone before this call
    }
    this.#log(ended.reason === "stopped" ? "sandbox.e2b.stop" : "sandbox.e2b.kill", { sandbox: id, provider: providerId });
  }

  // E2B has no graceful stop: the sandbox is killed and reported with the SIGTERM convention. The key only deduplicates journaling.
  async stop(id: SandboxId, _graceMs: number, _idempotencyKey: string): Promise<void> {
    await this.#end(id, { exitCode: STOP_EXIT, reason: "stopped" });
  }

  async kill(id: SandboxId, _idempotencyKey: string): Promise<void> {
    await this.#end(id, { exitCode: KILL_EXIT, reason: "killed" });
  }

  async inspect(id: SandboxId): Promise<SandboxInfo | null> {
    const ended = this.#ended.get(id);
    if (ended !== undefined)
      return { running: false, exitCode: ended.exitCode, status: ended.reason === "expired" ? "expired" : "exited", host: null, generation: null };
    const info = await this.#state(id);
    if (info === null) {
      if (!this.#tracked.has(id)) return null;
      this.#markEnded(id, { exitCode: null, reason: "expired" });
      return { running: false, exitCode: null, status: "expired", host: null, generation: null };
    }
    const stamp = readOwnerStamp(decodeMetadata(info.metadata).tags);
    return info.state === "running"
      ? { running: true, exitCode: null, status: "running", ...stamp }
      : { running: false, exitCode: null, status: info.state, ...stamp };
  }

  // Fail closed on ownership: only sandboxes whose store_id label equals owner.storeId (and whose daemon_epoch label, when present,
  // is not newer than the owner's). A sandbox with no store_id label is NOT returned at all, unlike the Docker adapter, because one E2B
  // account may serve several daemons and reconcile kills what list returns. Host and generation are the stamp start() wrote from
  // SandboxSpec.host and generation (null when absent or damaged, which reconcile never adopts).
  async list(owner: SandboxOwner): Promise<SandboxListing[]> {
    const out: SandboxListing[] = [];
    for (const info of await this.#api.list(backendSelector())) {
      const found = this.#found(info);
      if (found === null) continue;
      const meta = decodeMetadata(info.metadata);
      const store = meta.labels[OWNER_STORE_LABEL];
      if (store !== owner.storeId) continue;
      const epoch = Number(meta.labels[OWNER_EPOCH_LABEL]);
      if (Number.isFinite(epoch) && epoch > owner.epoch) continue;
      out.push({
        id: found.id,
        agent: meta.tags[SANDBOX_TAGS.agent] ?? "",
        backend: BACKEND_ID,
        ...readOwnerStamp(meta.tags),
        state: info.state === "running" ? "running" : info.state === "paused" ? "paused" : "unknown",
        ...(Object.keys(meta.labels).length > 0 ? { labels: meta.labels } : {}),
      });
    }
    return out;
  }

  // The adapter creates nothing beside the sandbox itself (no volumes, templates or snapshots), so there is nothing else to reclaim;
  // orphaned sandboxes are reconcile's to kill through list(owner).
  async reclaim(_owner: SandboxOwner): Promise<SandboxId[]> {
    return [];
  }

  async imageIdentity(_ref: string): Promise<ImageIdentity> {
    throw new SandboxCapabilityError(
      BACKEND_ID,
      "image.digestAttest",
      "E2B templates report no image digest, so the daemon resolves the image identity from the registry instead",
    );
  }

  // TODO(e2b-envd-exec): collecting the agent's work runs git inside the sandbox through envd. Current behavior: refused with this error.
  async resultWork(id: SandboxId): Promise<{ dirty: boolean; fingerprint: string; bundle?: AsyncIterable<Uint8Array> }> {
    throw new Error(
      `sandbox backend e2b cannot collect the work of sandbox ${id}: that runs git inside the sandbox through E2B's envd, which this adapter does not speak yet; use another backend for agents whose work must be collected`,
    );
  }

  // Readiness: one authenticated list call. E2B reports no account id the notes document, so `account` is null. A runtime block is
  // a problem, since E2B has no selectable runtime.
  async probe(runtime?: SandboxSpec["runtime"]): Promise<ProbeResult> {
    const problems: ProbeResult["problems"] = [];
    if (runtime !== undefined && Object.keys(runtime).length > 0) {
      problems.push({
        code: "runtime-block",
        cause: "a template asks for a runtime block, but E2B has no selectable runtime",
        action: "remove the runtime block from the template, or use a backend that supports it",
      });
    }
    try {
      await this.#api.list(backendSelector());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof SandboxUnavailableError && e.reason === "auth") {
        problems.push({ code: "auth", cause: msg, action: `write a valid E2B API key into the file ${API_KEY_FILE_ENV} names` });
      } else {
        problems.push({ code: "unreachable", cause: msg, action: "check sandbox.e2b.baseUrl, the network and E2B's status page, then restart" });
      }
    }
    return { withheld: [], problems, account: null };
  }
}
