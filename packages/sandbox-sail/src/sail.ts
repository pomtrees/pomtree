// The Sandbox port on Sail Research's Sailboxes (persistent microVMs behind a REST API). Built from the vendor documentation only:
// README.md lists what each choice rests on and what is unverified. The adapter keeps no state that a restart would need; the two
// in-memory maps below are caches of facts the provider also holds (the sailbox behind a sandbox id, the exec it started) plus the
// set of sandboxes this instance terminated, which only refines an exit report.
//
// Trust: one API key is one trust domain. The name prefix and the owner tags are identifiers, not secrets: anyone holding the same
// key (or another key of the same account) can create a sailbox with a matching name and tags, and this adapter would treat it as
// pomtree's. That is not a security boundary between tenants of one account; give each pomtree deployment its own account or key.

import { SANDBOX_CAPABILITIES, SANDBOX_TAGS, SandboxCapabilityError, SandboxQuotaError, SandboxUnavailableError, sandboxIdForKey } from "@pomtree/core";
import type {
  ByteChannel,
  ImageIdentity,
  ProbeResult,
  Sandbox,
  SandboxCapability,
  SandboxChannel,
  SandboxDeclaration,
  SandboxHandle,
  SandboxId,
  SandboxListing,
  SandboxOwner,
  SandboxSpec,
  TerminalClose,
} from "@pomtree/core";
import { FREEFORM_TAG_LIMITS, decodeName, decodeTags, encodeName, encodeTags, matchesField } from "@pomtree/sandbox-kit";
import type { NameSchema } from "@pomtree/sandbox-kit";
import { createOnce } from "@pomtree/sandbox-kit/dedup";
import type { CreateFailure, FoundSandbox, ProbePolicy } from "@pomtree/sandbox-kit/dedup";
import { defaultIsTransient } from "@pomtree/sandbox-kit/retry";
import { SAIL_BACKEND, SailApi, SailHttpError, canonicalJson } from "./api.ts";
import type { SailApiOptions, SailboxRecord } from "./api.ts";

const caps = (on: readonly SandboxCapability[]): Record<SandboxCapability, boolean> =>
  Object.fromEntries(SANDBOX_CAPABILITIES.map((c) => [c, on.includes(c)])) as Record<SandboxCapability, boolean>;

// Declared from the documentation only (README.md, "Declaration"). Everything else is false because its REST shape is unread or the
// adapter does not implement it: files, terminal, snapshots, fork, pause, lease, egress, secrets, resources.limits (pids limits are
// not documented), list.byTag (the list has no tag filter).
export const SAIL_DECLARATION: SandboxDeclaration = {
  backend: SAIL_BACKEND,
  capabilities: caps(["connect", "image.ociPull", "isolation.microvm"]),
  region: null,
  idempotency: "native-token",
  // "A result can expire 10 minutes after Sail first returns it, or 24 hours after the request if it is never read": the shorter
  // bound is the one a replay can rely on.
  idempotencyWindowMs: 10 * 60_000,
  tagging: "name-encoded",
  output: "poll",
  maxLifetimeMs: null,
  preemptible: false,
  // Billed per used vCPU- and GiB-second; billing while paused is not stated, so it is assumed.
  billing: { unit: "second", whileStopped: false, whilePaused: true },
};

// The resource name marks a sailbox as pomtree's and carries the sandbox id; Sail names are not unique, so the name is never trusted
// alone. Name limits are not documented: this DNS-label shape is a conservative guess.
export const SAIL_NAME_SCHEMA: NameSchema = {
  prefix: "pomtree",
  fields: ["sandbox"],
  limits: { maxLength: 63, pattern: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/ },
};
const NAME_ID_CHARS = 32;

// Sail has no labels or metadata, but a sailbox's create-time `env` is returned by get and list, so the owner tags and the spec's
// labels ride in one variable there, encoded with the kit's tag codec. It is visible to processes in the box and is not secret.
export const SAIL_TAGS_ENV = "SANDBOX_OWNER_TAGS";
// Sail accepts at most 100 create-time environment variables.
const MAX_ENV = 100;

// The worker inside the box listens on one loopback TCP port per channel; connect opens the documented tunnel to it.
// TODO(sail-worker-ports): no agent image serves these ports yet. Current behavior: connect opens the tunnel, and a box with no
// listener on the port fails the open or closes the channel without the end-of-stream marker, which the reader reports as an error.
export const SAIL_CHANNEL_PORTS: Readonly<Record<SandboxChannel, number>> = {
  "daemon-api": 7100,
  egress: 7101,
  "egress-browser": 7102,
  workspace: 7103,
};

// The exit code reported for a sandbox this adapter terminated (stop and kill both end the VM at once).
export const TERMINATED_EXIT_CODE = 137;

const LABEL_KEY = /^[A-Za-z0-9_.-]+$/;

export interface SailOptions extends Omit<SailApiOptions, "token"> {
  credential: (name: string) => Promise<string>;
  log: (event: string, fields: Record<string, unknown>) => void;
  now: () => number;
  // This daemon's host id, stamped on every sailbox it creates.
  host: string;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  probe?: ProbePolicy;
}

interface Decoded {
  sandbox: SandboxId;
  agent: string;
  host: string | null;
  generation: number | null;
  labels: Record<string, string>;
  record: SailboxRecord;
}

export class SailSandbox implements Sandbox {
  readonly declaration = SAIL_DECLARATION;
  readonly #api: SailApi;
  readonly #o: SailOptions;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #sailboxOf = new Map<SandboxId, string>();
  readonly #execOf = new Map<SandboxId, string>();
  readonly #terminated = new Set<SandboxId>();

  constructor(o: SailOptions) {
    this.#o = o;
    this.#api = new SailApi({ ...o, token: () => o.credential("apiToken") });
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  readonly connect = {
    open: (id: SandboxId, channel: SandboxChannel): Promise<ByteChannel> => this.#open(id, channel),
  };

  async start(spec: SandboxSpec, idempotencyKey: string): Promise<SandboxHandle> {
    const env = this.#createEnv(spec, idempotencyKey);
    const derivedId = sandboxIdForKey(idempotencyKey);
    const name = encodeName(SAIL_NAME_SCHEMA, { sandbox: derivedId.slice(0, NAME_ID_CHARS) });
    // Sorted-key JSON: a replay of this key sends byte-identical bytes.
    const body = canonicalJson({ name, image: spec.image, env: env.vars });
    const ownerTags = { [SANDBOX_TAGS.host]: this.#o.host, [SANDBOX_TAGS.agent]: spec.agent };
    const res = await createOnce(
      {
        mechanism: "native-token",
        key: idempotencyKey,
        // The token is the derived id (64 hex): stable for the key, and free of whatever characters the key holds.
        token: derivedId,
        ownerTags,
        lookupTags: { [SANDBOX_TAGS.sandbox]: derivedId },
        idempotencyWindowMs: SAIL_DECLARATION.idempotencyWindowMs ?? 0,
        ...(this.#o.probe && { probe: this.#o.probe }),
      },
      {
        create: async (req) => {
          const rec = await this.#api.create(body, req.token ?? derivedId);
          this.#sailboxOf.set(derivedId, rec.sailbox_id);
          this.#o.log("sail.create", { sandbox: derivedId, sailbox: rec.sailbox_id, agent: spec.agent });
          return { id: derivedId };
        },
        find: async (q) => (await this.#scan()).filter((d) => Object.entries(q.tags ?? {}).every(([k, v]) => tagOf(d, k) === v)).map(found),
        classify,
        sleep: this.#sleep,
        now: this.#o.now,
      },
    );
    if (res.adopted) this.#o.log("sail.adopt", { sandbox: res.id, agent: spec.agent });
    if (spec.cmd !== undefined && spec.cmd.length > 0) {
      const sailbox = await this.#resolve(res.id);
      if (sailbox === null)
        throw new SandboxUnavailableError("not-found", `sailbox for sandbox ${res.id} vanished right after it was created; start again with a new key`);
      // Sail never runs the image's ENTRYPOINT or CMD, so the command runs as a background exec. Its key is derived from the start
      // key, so a replayed start reaches the same exec instead of launching a second one.
      const execId = await this.#api.exec(sailbox, spec.cmd, `${derivedId}-exec`);
      this.#execOf.set(res.id, execId);
    }
    return this.#handle(res.id);
  }

  async attach(id: SandboxId, agent: string): Promise<SandboxHandle> {
    const d = (await this.#scan()).find((x) => x.sandbox === id);
    if (d === undefined || listingState(d.record.status) === "exited") {
      throw new SandboxUnavailableError("not-found", `sandbox ${id} has no running sailbox; start a new one, or let reconcile find its successor`);
    }
    if (d.agent !== agent) {
      throw new Error(`sandbox ${id} belongs to agent ${d.agent}, not ${agent}; attach the sandbox recorded for this agent`);
    }
    return this.#handle(id);
  }

  async stop(id: SandboxId, _graceMs: number, idempotencyKey: string): Promise<void> {
    // A sailbox has no graceful stop that ends it: sleep and pause keep it billable and resumable. Stop terminates, like kill.
    await this.kill(id, idempotencyKey);
  }

  async kill(id: SandboxId, _idempotencyKey: string): Promise<void> {
    const sailbox = await this.#resolve(id);
    // #resolve throws SailListTruncatedError when the listing may be partial, so a miss here comes from a complete listing: the box
    // never existed or is gone, which the port counts as success. A known sailbox is deleted directly, where 404 means gone.
    if (sailbox === null) {
      this.#o.log("sail.terminate-absent", { sandbox: id });
      return;
    }
    this.#terminated.add(id);
    await this.#api.terminate(sailbox);
    this.#o.log("sail.terminate", { sandbox: id, sailbox });
  }

  async inspect(id: SandboxId): Promise<{ running: boolean; exitCode: number | null; oomKilled?: boolean; status?: string } | null> {
    const sailbox = await this.#resolve(id);
    if (sailbox === null) return this.#terminated.has(id) ? { running: false, exitCode: TERMINATED_EXIT_CODE, status: "exited" } : null;
    const rec = await this.#api.get(sailbox);
    const state = rec === null ? "exited" : listingState(rec.status);
    if (state === "exited") {
      // Ended by this adapter: a kill. Ended otherwise (lifetime, provider action): not a clean exit, and no exit code is known.
      return this.#terminated.has(id)
        ? { running: false, exitCode: TERMINATED_EXIT_CODE, status: "exited" }
        : { running: false, exitCode: null, status: "terminated" };
    }
    const execId = this.#execOf.get(id);
    if (execId !== undefined) {
      const ex = await this.#api.execStatus(sailbox, execId);
      if (ex !== null && ex.exitCode !== null) return { running: false, exitCode: ex.exitCode, status: "exited" };
    }
    if (state === "paused") return { running: false, exitCode: null, status: "paused" };
    return { running: true, exitCode: null, status: rec?.status ?? "running" };
  }

  // Required on every backend. Sail has no server-side tag filter, so every sailbox is read and filtered here: pomtree's name prefix,
  // decodable owner tags, and not positively another owner's (another store id, or a newer daemon epoch).
  async list(owner: SandboxOwner): Promise<SandboxListing[]> {
    return (await this.#scan())
      .filter((d) => {
        const store = d.labels.store_id;
        if (store !== undefined && store !== owner.storeId) return false;
        const epoch = Number(d.labels.daemon_epoch);
        return !(Number.isFinite(epoch) && epoch > owner.epoch);
      })
      .map((d) => ({
        id: d.sandbox,
        agent: d.agent,
        backend: SAIL_BACKEND,
        host: d.host,
        generation: d.generation,
        state: listingState(d.record.status),
        ...(Object.keys(d.labels).length > 0 && { labels: d.labels }),
      }));
  }

  // The adapter creates nothing beside the sailbox itself (no volumes, checkpoints or saved policies), so nothing is left to reclaim.
  async reclaim(_owner: SandboxOwner): Promise<SandboxId[]> {
    return [];
  }

  // Sail has no runtime classes, so the runtime block changes nothing; the probe checks the API answers with this token.
  async probe(_runtime?: SandboxSpec["runtime"]): Promise<ProbeResult> {
    try {
      await this.#api.list();
      return { withheld: [], problems: [], account: null };
    } catch (e) {
      const auth = e instanceof SandboxUnavailableError && e.reason === "auth";
      return {
        withheld: [],
        problems: [
          {
            code: auth ? "auth" : "unreachable",
            cause: e instanceof Error ? e.message : String(e),
            action: auth
              ? "write a valid Sailboxes API key into the apiToken credential file"
              : "check sandbox.sail.baseUrl and network reachability, then restart",
          },
        ],
        account: null,
      };
    }
  }

  // Sail does not report what it ran, so image.digestAttest is not declared and, per the port, identity is not the adapter's to give.
  async imageIdentity(_ref: string): Promise<ImageIdentity> {
    throw new SandboxCapabilityError(
      SAIL_BACKEND,
      "image.digestAttest",
      "the daemon resolves the image identity from the image registry; pin the image as name@sha256:<digest> so Sailboxes runs exactly that",
    );
  }

  // TODO(sail-result-work): collecting result work needs exec output, whose NDJSON event shapes the documentation fixtures do not
  // cover. Current behavior: refuses with this message; nothing is read from the sandbox.
  async resultWork(id: SandboxId): Promise<{ dirty: boolean; fingerprint: string; bundle?: AsyncIterable<Uint8Array> }> {
    throw new Error(
      `collecting result work from sandbox ${id} is not implemented on the sail backend yet (exec output shapes are unverified); collect it with a local backend`,
    );
  }

  #createEnv(spec: SandboxSpec, key: string): { vars: Record<string, string> } {
    for (const k of Object.keys(spec.labels ?? {})) {
      if (!LABEL_KEY.test(k) || k.toLowerCase().startsWith("pomtree")) {
        throw new Error(`label name ${JSON.stringify(k)} is invalid: use [A-Za-z0-9_.-] and do not start with "pomtree" (reserved); rename the label`);
      }
    }
    if (spec.egress !== undefined) {
      throw new Error(
        "the sail backend cannot enforce the template's egress allowlist yet (Sail allowlists name hosts without ports, and the create-time policy shape is unverified); use a backend that declares egress.allowHost, or remove egress from the template",
      );
    }
    if (spec.runtime !== undefined && Object.keys(spec.runtime).length > 0) {
      throw new Error("the sail backend has no runtime block (every sailbox is a microVM); remove the runtime block from the template");
    }
    for (const m of spec.mounts) {
      if (m.kind === "bind" || m.kind === "session") {
        throw new Error(
          `a ${m.kind} mount needs a host directory, which a sailbox cannot see; use a backend with host mounts, or a template without ${m.kind} mounts`,
        );
      }
    }
    if (SAIL_TAGS_ENV in spec.env) throw new Error(`${SAIL_TAGS_ENV} is reserved for the sail backend's owner tags; remove it from the template env`);
    if (Object.keys(spec.env).length + 1 > MAX_ENV) {
      throw new Error(`Sailboxes accept at most ${MAX_ENV} environment variables and the adapter adds one; trim the template env to ${MAX_ENV - 1}`);
    }
    // The workspace mount carries the agent generation it was granted to; a spec without one is the first generation.
    const ws = spec.mounts.find((m) => m.kind === "workspace");
    const generation = ws?.generation ?? 0;
    const tags = encodeTags(
      {
        [SANDBOX_TAGS.sandbox]: sandboxIdForKey(key),
        [SANDBOX_TAGS.agent]: spec.agent,
        [SANDBOX_TAGS.backend]: SAIL_BACKEND,
        [SANDBOX_TAGS.host]: this.#o.host,
        [SANDBOX_TAGS.generation]: String(generation),
      },
      FREEFORM_TAG_LIMITS,
    );
    const value = canonicalJson({ tags: tags.labels, annotations: tags.annotations, labels: spec.labels ?? {} });
    return { vars: { ...spec.env, [SAIL_TAGS_ENV]: value } };
  }

  // Every pomtree sailbox, decoded; foreign or damaged ones are skipped (never adopted, listed or terminated).
  async #scan(): Promise<Decoded[]> {
    const out: Decoded[] = [];
    for (const record of await this.#api.list()) {
      const d = decode(record);
      if (d === null) continue;
      this.#sailboxOf.set(d.sandbox, record.sailbox_id);
      out.push(d);
    }
    return out;
  }

  async #resolve(id: SandboxId): Promise<string | null> {
    const known = this.#sailboxOf.get(id);
    if (known !== undefined) return known;
    return (await this.#scan()).find((d) => d.sandbox === id)?.record.sailbox_id ?? null;
  }

  #handle(id: SandboxId): SandboxHandle {
    return {
      id,
      // TODO(sail-exec-output): the exec output stream's NDJSON event shapes are not covered by the documentation fixtures, so no
      // output is read. Current behavior: output() ends at once; the agent's session events travel over the daemon-api channel.
      output: async function* () {},
      wait: () => this.#wait(id),
    };
  }

  // Polls until the main exec exits or the sailbox ends. A sailbox this adapter terminated reports 137; one that ended otherwise
  // (lifetime, provider action) rejects, since the port's wait cannot carry an expired or preempted reason yet (exit-reason-wiring).
  async #wait(id: SandboxId): Promise<{ exitCode: number }> {
    for (;;) {
      const st = await this.inspect(id);
      if (st === null || (!st.running && st.status !== "paused")) {
        if (st?.exitCode !== null && st?.exitCode !== undefined) return { exitCode: st.exitCode };
        throw new SandboxUnavailableError(
          "not-found",
          `sandbox ${id} ended without pomtree stopping it (the provider terminated the sailbox: lifetime or provider action); resume the agent in a new sandbox`,
        );
      }
      await this.#sleep(this.#o.pollMs ?? 2000);
    }
  }

  async #open(id: SandboxId, channel: SandboxChannel): Promise<ByteChannel> {
    const sailbox = await this.#resolve(id);
    if (sailbox === null) throw new SandboxUnavailableError("not-found", `sandbox ${id} has no sailbox to open channel ${channel} into; start it first`);
    const port = SAIL_CHANNEL_PORTS[channel];
    if (port === undefined) throw new Error(`unknown channel ${JSON.stringify(channel)}; use daemon-api, egress, egress-browser or workspace`);
    return tunnelChannel(await this.#api.tunnel(sailbox, port), `${channel} of sandbox ${id}`);
  }
}

const tagOf = (d: Decoded, key: string): string | undefined =>
  key === SANDBOX_TAGS.sandbox ? d.sandbox : key === SANDBOX_TAGS.agent ? d.agent : key === SANDBOX_TAGS.host ? (d.host ?? undefined) : undefined;

const found = (d: Decoded): FoundSandbox => ({
  id: d.sandbox,
  ...(d.record.name !== undefined && { name: d.record.name }),
  tags: {
    [SANDBOX_TAGS.sandbox]: d.sandbox,
    [SANDBOX_TAGS.agent]: d.agent,
    ...(d.host !== null && { [SANDBOX_TAGS.host]: d.host }),
  },
});

// A 5xx, or a transport failure after the request may have been sent, leaves a create's outcome unknown. Everything else (4xx,
// quota, bad credential) definitely created nothing.
export function classify(err: unknown): CreateFailure {
  // 408 (the request timed out) and 409 (a conflict, possibly with a create that landed) leave the outcome open too, so createOnce
  // looks the sandbox up by its tags; other 4xx are definite refusals.
  if (err instanceof SailHttpError) return err.status >= 500 || err.status === 408 || err.status === 409 ? "unknown" : "failed";
  if (err instanceof SandboxUnavailableError || err instanceof SandboxCapabilityError) return "failed";
  if (err instanceof SandboxQuotaError) return "failed";
  return defaultIsTransient(err) ? "unknown" : "failed";
}

// Undocumented status values are inferred: a record without one is read as running.
export function listingState(status: string | undefined): SandboxListing["state"] {
  switch (status) {
    case undefined:
    case "running":
    case "sleeping":
      return "running";
    case "creating":
    case "starting":
      return "creating";
    case "paused":
      return "paused";
    case "terminated":
    case "terminating":
      return "exited";
    default:
      return "unknown";
  }
}

function decode(record: SailboxRecord): Decoded | null {
  if (record.name === undefined) return null;
  let field: string;
  try {
    field = decodeName(SAIL_NAME_SCHEMA, record.name).sandbox as string;
  } catch {
    return null; // not pomtree's name, or damaged
  }
  const raw = record.env?.[SAIL_TAGS_ENV];
  if (raw === undefined) return null;
  let parsed: { tags?: unknown; annotations?: unknown; labels?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const strMap = (v: unknown): Record<string, string> =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"))
      : {};
  const { tags, unresolved } = decodeTags(strMap(parsed.tags), strMap(parsed.annotations));
  const sandbox = tags[SANDBOX_TAGS.sandbox];
  const agent = tags[SANDBOX_TAGS.agent];
  if (unresolved.length > 0 || sandbox === undefined || agent === undefined) return null;
  // The name and the tags must agree, or the record was edited by someone else.
  if (!matchesField(SAIL_NAME_SCHEMA, field, sandbox.slice(0, NAME_ID_CHARS))) return null;
  const gen = Number(tags[SANDBOX_TAGS.generation]);
  return {
    sandbox,
    agent,
    host: tags[SANDBOX_TAGS.host] ?? null,
    generation: Number.isInteger(gen) && gen >= 0 ? gen : null,
    labels: strMap(parsed.labels),
    record,
  };
}

const EOF = '{"type":"eof"}';

// One tunnel as a ByteChannel: binary frames carry the bytes both ways, `{"type":"eof"}` is the documented half-close. A tunnel that
// closes before the box sent eof was cut, so the reader throws instead of ending cleanly.
export function tunnelChannel(ws: WebSocket, what: string): ByteChannel {
  const queue: Uint8Array[] = [];
  let ended: { error?: Error } | undefined;
  let wake: (() => void) | undefined;
  let sawEof = false;
  let localClose = false;
  let settle!: (c: TerminalClose) => void;
  const closed = new Promise<TerminalClose>((r) => {
    settle = r;
  });
  const end = (error?: Error) => {
    if (ended !== undefined) return;
    ended = error === undefined ? {} : { error };
    settle(error !== undefined ? { reason: "error", error } : { reason: localClose ? "local" : "remote" });
    wake?.();
  };
  ws.addEventListener("message", (ev: MessageEvent) => {
    if (typeof ev.data === "string") {
      if (ev.data === EOF) {
        sawEof = true;
        end();
      } else {
        end(new Error(`tunnel ${what} sent an unexpected text frame; the provider protocol changed, so update the adapter`));
        ws.close();
      }
      return;
    }
    queue.push(new Uint8Array(ev.data as ArrayBuffer));
    wake?.();
  });
  ws.addEventListener("close", (ev: CloseEvent) => {
    if (sawEof || localClose) end();
    else end(new Error(`tunnel ${what} closed (code ${ev.code}) before the sandbox ended the stream; the connection was cut, so reopen the channel`));
  });
  ws.addEventListener("error", () => end(new Error(`tunnel ${what} failed; reopen the channel`)));
  return {
    async write(data) {
      if (ended !== undefined || ws.readyState !== WebSocket.OPEN) throw new Error(`tunnel ${what} is closed; reopen the channel`);
      ws.send(typeof data === "string" ? new TextEncoder().encode(data) : data);
      // Wait for the socket to take the bytes, so a fast writer cannot queue without bound.
      while (ws.bufferedAmount > 1 << 20 && ws.readyState === WebSocket.OPEN) await new Promise((r) => setTimeout(r, 5));
    },
    async *output() {
      for (;;) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (ended !== undefined) {
          if (ended.error !== undefined) throw ended.error;
          return;
        }
        await new Promise<void>((r) => {
          wake = r;
        });
        wake = undefined;
      }
    },
    close() {
      if (localClose || ended !== undefined) return;
      localClose = true;
      if (ws.readyState === WebSocket.OPEN) ws.send(EOF);
      ws.close(1000);
      end();
    },
    closed,
  };
}
