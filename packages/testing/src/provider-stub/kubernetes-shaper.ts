import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, STATUS_CODES } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { type FaultName, FaultPlan } from "./faults.ts";
import type { Fixture, FixtureEntry } from "./fixture-loader.ts";
import type { RecordedRequest } from "./model.ts";

// A Kubernetes-shaped loopback API server for adapter tests: what the API server answers for a sandbox adapter that creates one namespaced Pod per
// sandbox and reaches it through exec. It is its own thin node:http shell, not a ResourceSpec of the generic ProviderModel, because the Kubernetes wire
// differs from that model in every verb: pods are keyed by NAME (a duplicate is 409 AlreadyExists, not an idempotency-key replay), errors are `Status`
// objects, and a pod's state is a lifecycle a test scripts. It reuses the stub's FaultPlan, RecordedRequest and strict-unmatched discipline: a request
// the shaper has no route for is recorded, answered 501 and fails `assertNoUnmatched`. @pomtree/testing must not import sandbox-kubernetes, so the v5
// exec frames are written by hand here.
//
// Shapes follow the Kubernetes API reference (core/v1 Pod, PodStatus, ContainerState, Status, NetworkPolicy) and the kubelet's reason strings. They are
// INFERRED from documentation, not captured from a cluster, and the fixtures say so.

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const EXEC_SUBPROTOCOL = "v5.channel.k8s.io";
const CH = { stdin: 0, stdout: 1, stderr: 2, status: 3, close: 255 } as const;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;

/** A scripted end state of a pod. */
export type PodOutcome =
  | { readonly kind: "running" }
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly exitCode: number }
  | { readonly kind: "oom-killed" }
  | { readonly kind: "deadline-exceeded" }
  | { readonly kind: "evicted"; readonly resource?: string }
  | { readonly kind: "preempted" };

export type PodSecurityLevel = "privileged" | "baseline" | "restricted";

export interface KubernetesShapeOptions {
  /** Namespaces that exist (default `["default"]`); any other is 404. */
  readonly namespaces?: readonly string[];
  /** Header names (names only, any case) every request must carry or it is unmatched (default `["authorization"]`: an adapter that drops its credential must not match). */
  readonly requireHeaderNames?: readonly string[];
  /** Pod Security Admission level enforced on pod create (default `privileged`: nothing enforced). */
  readonly podSecurity?: PodSecurityLevel;
  /** Pods start Running instead of Pending (default false: a test advances them with `setOutcome`). */
  readonly startRunning?: boolean;
  /** Whether the network plugin enforces NetworkPolicy; decides what canary pods see (default true). */
  readonly enforcesNetworkPolicy?: boolean;
  /** Label naming a canary pod (default `pomtree.canary`). A canary ends on creation: see `canaryExit`. */
  readonly canaryLabel?: string;
  /** Label the default-deny policy selects (default `pomtree.sandbox-pod`). */
  readonly policyLabel?: string;
  /** Exit codes a canary ends with: blocked by policy, or reached the target (defaults 0 and 10, the adapter's canary script). */
  readonly canaryExit?: { readonly blocked: number; readonly reached: number };
  /** Entries replayed verbatim, in order, when the next one matches a request's method, path, query and body; others fall through to the model. Stream entries are ignored. */
  readonly replay?: Fixture;
  /** Faults armed for the whole run (`rate-limit`, `timeout`, `server-error-after-apply`; use `shaper.faults.arm` for counted ones). */
  readonly faults?: readonly FaultName[];
  /** Clock for timestamps (default a fixed 2026-01-01T00:00:00Z so responses are deterministic). */
  readonly now?: () => Date;
  /** Cap on a request body in bytes (default 4 MiB). */
  readonly maxBodyBytes?: number;
}

export interface ExecScript {
  /** Only an exec with exactly this argv consumes the script (default: any). */
  readonly command?: readonly string[];
  readonly stdout?: string;
  readonly stderr?: string;
  /** Exit code reported on the status channel (default 0). */
  readonly exitCode?: number;
  /** Wait for the client's stdin half-close ([255, 0]) before answering; `echoStdin` replays the stdin bytes as stdout. */
  readonly waitForStdin?: boolean;
  readonly echoStdin?: boolean;
  /** Send this object as the status-channel JSON instead of the exit-code Status (for example a Failure that is not a command exit). */
  readonly status?: Record<string, unknown>;
  /** End the stream after the output with NO status frame (a dropped stream: the adapter must not read it as exit 0). */
  readonly drop?: boolean;
}

export interface RecordedExec {
  readonly namespace: string;
  readonly pod: string;
  readonly container: string | undefined;
  readonly command: readonly string[];
  /** Everything the client sent on the stdin channel, decoded as UTF-8. */
  readonly stdin: string;
}

type Obj = Record<string, unknown>;
type Out =
  | { readonly kind: "respond"; readonly status: number; readonly headers: Record<string, string>; readonly body: string; readonly bad?: string }
  | {
      readonly kind: "exec";
      readonly ns: string;
      readonly pod: string;
      readonly script: ExecScript;
      readonly container: string | undefined;
      readonly command: readonly string[];
    }
  | { readonly kind: "hang" }
  | { readonly kind: "unmatched"; readonly reason: string };

const asObj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const asArr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(asObj) : []);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The Kubernetes `Status` failure body: kind Status, apiVersion v1, status Failure, with reason, code, message and optional details. */
export function statusFailure(code: number, reason: string, message: string, details?: Obj): Obj {
  return { kind: "Status", apiVersion: "v1", metadata: {}, status: "Failure", message, reason, ...(details === undefined ? {} : { details }), code };
}

/**
 * The Pod Security Standards violations of a pod spec at `level`, worded as the PodSecurity admission plugin words them ("allowPrivilegeEscalation != false
 * (container "x" must set ...)"). Covers the baseline privileged, host-namespace and hostPath checks and the restricted privilege-escalation, capabilities,
 * runAsNonRoot and seccomp checks; the real plugin checks more (runAsUser, volume allowlist, sysctls, AppArmor), which an adapter test does not need.
 */
export function podSecurityViolations(spec: Obj, level: PodSecurityLevel): string[] {
  if (level === "privileged") return [];
  const containers = [...asArr(spec.initContainers), ...asArr(spec.containers)];
  const named = (xs: Obj[]) => xs.map((c) => `"${String(c.name)}"`).join(", ");
  const group = (what: string, bad: Obj[], rest: string) =>
    bad.length === 0 ? [] : [`${what} (${bad.length === 1 ? "container" : "containers"} ${named(bad)} ${rest})`];
  const sc = (c: Obj) => asObj(c.securityContext);
  const podSc = asObj(spec.securityContext);
  const out: string[] = [];
  out.push(
    ...group(
      "privileged",
      containers.filter((c) => sc(c).privileged === true),
      "must not set securityContext.privileged=true",
    ),
  );
  const hostNs = ["hostNetwork", "hostPID", "hostIPC"].filter((k) => spec[k] === true).map((k) => `${k}=true`);
  if (hostNs.length > 0) out.push(`host namespaces (${hostNs.join(", ")})`);
  for (const v of asArr(spec.volumes)) {
    if (v.hostPath !== undefined) out.push(`hostPath volumes (volume "${String(v.name)}")`);
  }
  if (level === "restricted") {
    out.push(
      ...group(
        "allowPrivilegeEscalation != false",
        containers.filter((c) => sc(c).allowPrivilegeEscalation !== false),
        "must set securityContext.allowPrivilegeEscalation=false",
      ),
    );
    out.push(
      ...group(
        "unrestricted capabilities",
        containers.filter((c) => !(Array.isArray(asObj(sc(c).capabilities).drop) && (asObj(sc(c).capabilities).drop as unknown[]).includes("ALL"))),
        'must set securityContext.capabilities.drop=["ALL"]',
      ),
    );
    out.push(
      ...group(
        "runAsNonRoot != true",
        containers.filter((c) => sc(c).runAsNonRoot === false || (sc(c).runAsNonRoot === undefined && podSc.runAsNonRoot !== true)),
        "must set securityContext.runAsNonRoot=true",
      ).map((s) => s.replace(/\((containers?) /, "(pod or $1 ")),
    );
    const seccompOk = (c: Obj) => ["RuntimeDefault", "Localhost"].includes(String(asObj(sc(c).seccompProfile).type ?? asObj(podSc.seccompProfile).type));
    out.push(
      ...group(
        "seccompProfile",
        containers.filter((c) => !seccompOk(c)),
        'must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost"',
      ).map((s) => s.replace(/\((containers?) /, "(pod or $1 ")),
    );
  }
  return out;
}

interface Selector {
  readonly test: (labels: Record<string, string>) => boolean;
}

/** Parses a Kubernetes label selector (`a=b,c!=d,e in (x,y),f notin (z),g,!h`). Returns an error message naming the bad term. */
export function parseLabelSelector(raw: string): Selector | { readonly error: string } {
  const terms = raw
    .split(/,(?![^(]*\))/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const tests: ((l: Record<string, string>) => boolean)[] = [];
  for (const t of terms) {
    const set = /^([^\s!=]+)\s+(in|notin)\s+\(([^)]*)\)$/.exec(t);
    const eq = /^([^\s!=]+)\s*(==|=|!=)\s*(.*)$/.exec(t);
    const absent = /^!([^\s!=]+)$/.exec(t);
    const present = /^([^\s!=()]+)$/.exec(t);
    if (set !== null) {
      const key = set[1]!;
      const vals = set[3]!.split(",").map((v) => v.trim());
      tests.push(set[2] === "in" ? (l) => key in l && vals.includes(l[key]!) : (l) => !(key in l) || !vals.includes(l[key]!));
    } else if (eq !== null) {
      const [key, op, val] = [eq[1]!, eq[2]!, eq[3]!];
      tests.push(op === "!=" ? (l) => l[key] !== val : (l) => l[key] === val);
    } else if (absent !== null) {
      const key = absent[1]!;
      tests.push((l) => !(key in l));
    } else if (present !== null) {
      const key = present[1]!;
      tests.push((l) => key in l);
    } else return { error: `unable to parse requirement "${t}"; use key, !key, key=value, key!=value, key in (a,b) or key notin (a,b)` };
  }
  return { test: (l) => tests.every((f) => f(l)) };
}

/** Builds the `v5.channel.k8s.io` message: one channel byte then the payload. */
export const execMessage = (channel: number, payload: Uint8Array | string = ""): Buffer =>
  Buffer.concat([Buffer.from([channel]), typeof payload === "string" ? Buffer.from(payload) : payload]);

/** The status-channel JSON for an exit code, as the kubelet reports it: Success for 0, else Failure/NonZeroExitCode with the code in details.causes. */
export function execStatus(exitCode: number): Obj {
  if (exitCode === 0) return { metadata: {}, status: "Success" };
  return {
    metadata: {},
    status: "Failure",
    message: `command terminated with non-zero exit code: Error executing in Docker Container: ${exitCode}`,
    reason: "NonZeroExitCode",
    details: { causes: [{ reason: "ExitCode", message: String(exitCode) }] },
  };
}

function wsFrame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head =
    n < 126
      ? Buffer.from([0x80 | opcode, n])
      : n < 65536
        ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), Buffer.alloc(8)]);
  if (n >= 65536) head.writeBigUInt64BE(BigInt(n), 2);
  return Buffer.concat([head, payload]);
}

/** Incremental parser of masked client frames; returns whole messages (fragments joined) and close/ping events. */
class ClientFrames {
  #buf = Buffer.alloc(0);
  #parts: Buffer[] = [];
  push(chunk: Buffer): { opcode: number; payload: Buffer }[] {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    const out: { opcode: number; payload: Buffer }[] = [];
    for (;;) {
      const b = this.#buf;
      if (b.length < 2) return out;
      let len = b[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return out;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return out;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      const masked = (b[1]! & 0x80) !== 0;
      const need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return out;
      const payload = Buffer.from(b.subarray(off + (masked ? 4 : 0), need));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ b[off + (i % 4)]!;
      const fin = (b[0]! & 0x80) !== 0;
      const opcode = b[0]! & 0x0f;
      this.#buf = b.subarray(need);
      if (opcode >= 8) out.push({ opcode, payload });
      else {
        this.#parts.push(payload);
        if (fin) {
          out.push({ opcode: opcode === 0 ? 2 : opcode, payload: Buffer.concat(this.#parts) });
          this.#parts = [];
        }
      }
    }
  }
}

interface PodRec {
  pod: Obj;
}

export class KubernetesShaper {
  readonly faults: FaultPlan;
  readonly baseUrl: string;
  readonly unmatched: { readonly index: number; readonly reason: string }[] = [];
  readonly #requests: RecordedRequest[] = [];
  readonly #execs: RecordedExec[] = [];
  readonly #opts: Required<
    Pick<KubernetesShapeOptions, "podSecurity" | "startRunning" | "enforcesNetworkPolicy" | "canaryLabel" | "policyLabel" | "canaryExit">
  >;
  readonly #namespaces: ReadonlySet<string>;
  readonly #required: readonly string[];
  readonly #now: () => Date;
  readonly #replay: readonly FixtureEntry[];
  #replayNext = 0;
  readonly #pods = new Map<string, Map<string, PodRec>>();
  readonly #policies = new Map<string, Map<string, Obj>>();
  readonly #scripts = new Map<string, ExecScript[]>();
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #maxBytes: number;
  #counter = 0;
  #closed = false;

  private constructor(opts: KubernetesShapeOptions, faults: FaultPlan, server: Server, port: number) {
    this.#opts = {
      podSecurity: opts.podSecurity ?? "privileged",
      startRunning: opts.startRunning ?? false,
      enforcesNetworkPolicy: opts.enforcesNetworkPolicy ?? true,
      canaryLabel: opts.canaryLabel ?? "pomtree.canary",
      policyLabel: opts.policyLabel ?? "pomtree.sandbox-pod",
      canaryExit: opts.canaryExit ?? { blocked: 0, reached: 10 },
    };
    this.#namespaces = new Set(opts.namespaces ?? ["default"]);
    this.#required = (opts.requireHeaderNames ?? ["authorization"]).map((h) => h.toLowerCase());
    this.#now = opts.now ?? (() => new Date("2026-01-01T00:00:00Z"));
    this.#replay = (opts.replay?.entries ?? []).filter((e) => e.stream === undefined);
    this.#maxBytes = opts.maxBodyBytes ?? 4 * 1024 * 1024;
    this.faults = faults;
    this.#server = server;
    this.baseUrl = `http://127.0.0.1:${port}`;
    for (const ns of this.#namespaces) {
      this.#pods.set(ns, new Map());
      this.#policies.set(ns, new Map());
    }
  }

  static async start(opts: KubernetesShapeOptions = {}): Promise<KubernetesShaper> {
    const faults = new FaultPlan();
    for (const f of opts.faults ?? []) faults.arm(f, { times: Number.POSITIVE_INFINITY });
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const shaper = new KubernetesShaper(opts, faults, server, (server.address() as AddressInfo).port);
    server.on("connection", (s) => {
      shaper.#sockets.add(s);
      s.on("close", () => shaper.#sockets.delete(s));
    });
    server.on("request", (req, res) => {
      shaper.#onRequest(req, res).catch((e) => {
        shaper.#reject(req, `the request failed before it could be answered (${(e as Error).message}); report this as a shaper bug`);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    server.on("upgrade", (req, socket, head) => shaper.#onUpgrade(req, socket as Socket, head));
    return shaper;
  }

  /** `ws://` URL of `path` on this server. */
  wsUrl(path: string): string {
    return `ws://127.0.0.1:${new URL(this.baseUrl).port}${path}`;
  }

  /** Every request received so far (header NAMES only, never values). */
  requests(): readonly RecordedRequest[] {
    return this.#requests;
  }

  /** Every exec stream that ran, with its argv and stdin. */
  execs(): readonly RecordedExec[] {
    return this.#execs;
  }

  /** Fails (naming every offender and the action) when any request matched no route. Call at the end of each test. */
  assertNoUnmatched(): void {
    assert.equal(
      this.unmatched.length,
      0,
      `kubernetes shaper received ${this.unmatched.length} unmatched request(s); each got an error response, never a default:\n${this.unmatched.map((x) => `  #${x.index} ${x.reason}`).join("\n")}\nfix the adapter's request or script the exchange`,
    );
  }

  /** Fails when replay entries were never requested. */
  assertReplayConsumed(): void {
    const left = this.#replay.slice(this.#replayNext);
    assert.equal(
      left.length,
      0,
      `replay entries never requested: ${left.map((e) => `seq ${e.seq} ${e.method} ${e.path}`).join("; ")}; the adapter did not make these calls`,
    );
  }

  /** The stored pod, or undefined. */
  pod(namespace: string, name: string): Obj | undefined {
    return this.#pods.get(namespace)?.get(name)?.pod;
  }

  pods(namespace: string): Obj[] {
    return [...(this.#pods.get(namespace)?.values() ?? [])].map((r) => r.pod);
  }

  networkPolicies(namespace: string): Obj[] {
    return [...(this.#policies.get(namespace)?.values() ?? [])];
  }

  /** Moves a pod to a scripted state, rewriting `status` (and `spec.nodeName`) the way the kubelet and scheduler would. Throws when the pod does not exist. */
  setOutcome(namespace: string, name: string, outcome: PodOutcome): void {
    const rec = this.#pods.get(namespace)?.get(name);
    assert.ok(rec, `setOutcome: pod ${namespace}/${name} does not exist; create it through the API first`);
    this.#apply(rec, outcome);
  }

  /** Removes a pod that is terminating (deletionTimestamp set), as the kubelet does once the containers are gone. */
  reap(namespace: string, name: string): void {
    assert.ok(this.#pods.get(namespace)?.delete(name), `reap: pod ${namespace}/${name} does not exist; nothing to reap`);
  }

  /** Queues what the next matching exec on the pod does. Unscripted execs are unmatched (strict). */
  scriptExec(namespace: string, name: string, script: ExecScript): void {
    const key = `${namespace}/${name}`;
    this.#scripts.set(key, [...(this.#scripts.get(key) ?? []), script]);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  // ---- plumbing ----

  /** RFC 3339 to the second, as the API server writes metav1.Time. */
  #iso(d: Date): string {
    return d.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  #record(req: IncomingMessage, served: string, body = ""): number {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const index = this.#requests.length;
    this.#requests.push({
      index,
      method: (req.method ?? "GET").toUpperCase(),
      path: url.pathname,
      query: [...url.searchParams]
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join("&"),
      headerNames: Object.keys(req.headers).sort(),
      idempotencyKey: undefined,
      rawBody: body,
      upgrade: false,
      served,
    });
    return index;
  }

  #reject(req: IncomingMessage, reason: string, body = ""): void {
    const index = this.#record(req, "UNMATCHED", body);
    this.unmatched.push({ index, reason: `${req.method} ${new URL(req.url ?? "/", "http://127.0.0.1").pathname}: ${reason}` });
  }

  #json(status: number, v: unknown, headers: Record<string, string> = {}): Out {
    return { kind: "respond", status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(v) };
  }

  #fail(status: number, reason: string, message: string, details?: Obj, bad?: string): Out {
    const o = this.#json(status, statusFailure(status, reason, message, details)) as Extract<Out, { kind: "respond" }>;
    return bad === undefined ? o : { ...o, bad };
  }

  async #onRequest(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > this.#maxBytes) {
        this.#reject(req, `request body exceeds ${this.#maxBytes} bytes; send less`);
        res
          .writeHead(413, { "content-type": "application/json", connection: "close" })
          .end(JSON.stringify(statusFailure(413, "RequestEntityTooLarge", "request body too large")));
        return;
      }
      chunks.push(c as Buffer);
    }
    if (this.#closed) return;
    const raw = Buffer.concat(chunks).toString("utf8");
    const out = this.#handle(req, raw);
    switch (out.kind) {
      case "hang":
        return;
      case "unmatched":
        res
          .writeHead(501, { "content-type": "application/json" })
          .end(JSON.stringify(statusFailure(501, "NotImplemented", `provider stub unmatched: ${out.reason}`)));
        return;
      case "exec":
        res.writeHead(426, { "content-type": "application/json" }).end(JSON.stringify(statusFailure(426, "UpgradeRequired", "exec needs a websocket upgrade")));
        return;
      case "respond":
        res.writeHead(out.status, out.headers).end(out.body);
    }
  }

  /** Routes one request: fixture replay, then faults, then the model. Records it exactly once. */
  #handle(req: IncomingMessage, raw: string, upgrade = false): Out {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = (req.method ?? "GET").toUpperCase();
    const unmatched = (reason: string): Out => {
      this.#reject(req, reason, raw);
      return { kind: "unmatched", reason: `${method} ${url.pathname}: ${reason}` };
    };
    const missing = this.#required.filter((h) => req.headers[h] === undefined);
    if (missing.length > 0) {
      this.#reject(req, `missing required header(s) ${missing.join(", ")}; the adapter must send its credential on every call`, raw);
      return this.#fail(401, "Unauthorized", "Unauthorized");
    }
    const replayed = this.#tryReplay(method, url, raw);
    if (replayed !== undefined) {
      this.#record(req, "replay", raw);
      return replayed;
    }
    if (this.faults.take("timeout", method, url.pathname)) {
      this.#record(req, "fault:timeout", raw);
      return { kind: "hang" };
    }
    const limited = this.faults.take("rate-limit", method, url.pathname);
    if (limited) {
      this.#record(req, "fault:rate-limit", raw);
      const s = limited.retryAfterS ?? 1;
      return this.#json(429, statusFailure(429, "TooManyRequests", "Too many requests, please try again later.", { retryAfterSeconds: s }), {
        "retry-after": String(s),
      });
    }
    const routed = this.#route(method, url, raw, req, upgrade);
    if (routed.kind === "unmatched") return unmatched(routed.reason);
    if (routed.kind === "respond" && routed.bad !== undefined) {
      this.#reject(req, routed.bad, raw);
      return routed;
    }
    if (routed.kind === "respond" && routed.status < 300 && method !== "GET") {
      const lost = this.faults.take("server-error-after-apply", method, url.pathname);
      if (lost) {
        this.#record(req, `fault:server-error-after-apply(${method})`, raw);
        const code = lost.status ?? 503;
        return this.#fail(
          code,
          code === 503 ? "ServiceUnavailable" : "InternalError",
          "stub server error after the request was applied: its outcome is unknown to the caller",
        );
      }
    }
    this.#record(req, routed.kind === "exec" ? "exec" : `${method} ${routed.kind === "respond" ? routed.status : ""}`.trim(), raw);
    return routed;
  }

  #tryReplay(method: string, url: URL, raw: string): Out | undefined {
    const e = this.#replay[this.#replayNext];
    if (e === undefined || e.method !== method || e.path !== url.pathname) return undefined;
    const got = [...url.searchParams].map(([k, v]) => `${k}=${v}`).sort();
    const want = Object.entries(e.query ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .sort();
    if (!isDeepStrictEqual(got, want)) return undefined;
    if ("requestBody" in e) {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return undefined;
      }
      if (!isDeepStrictEqual(body, e.requestBody)) return undefined;
    }
    this.#replayNext += 1;
    const headers = {
      ...(e.responseBody !== undefined && typeof e.responseBody !== "string" ? { "content-type": "application/json" } : {}),
      ...e.responseHeaders,
    };
    const body = e.responseBody === undefined ? "" : typeof e.responseBody === "string" ? e.responseBody : JSON.stringify(e.responseBody);
    return { kind: "respond", status: e.status, headers, body };
  }

  #route(method: string, url: URL, raw: string, req: IncomingMessage, upgrade: boolean): Out {
    const un = (reason: string): Out => ({ kind: "unmatched", reason });
    const m = /^\/api\/v1\/namespaces\/([^/]+)\/pods(?:\/([^/]+)(\/exec)?)?$/.exec(url.pathname);
    const np = /^\/apis\/networking\.k8s\.io\/v1\/namespaces\/([^/]+)\/networkpolicies(?:\/([^/]+))?$/.exec(url.pathname);
    const allowedQuery = (names: readonly string[]) => [...url.searchParams.keys()].filter((k) => !names.includes(k));
    if (m === null && np === null) {
      return un(`no route for this path; the shaper serves namespaced pods (and pods/exec) under /api/v1 and networkpolicies under /apis/networking.k8s.io/v1`);
    }
    const ns = decodeURIComponent((m ?? np)![1]!);
    if (!this.#namespaces.has(ns)) return this.#fail(404, "NotFound", `namespaces "${ns}" not found`, { name: ns, kind: "namespaces" });
    if (np !== null) return this.#networkPolicyRoute(method, ns, np[2], raw, un, allowedQuery);
    const name = m![2] === undefined ? undefined : decodeURIComponent(m![2]);
    if (m![3] !== undefined) {
      if (method !== "GET") return un(`pods/exec over websockets is a GET upgrade; got ${method}`);
      if (!upgrade) return un("pods/exec without a websocket upgrade; send Upgrade: websocket with Sec-WebSocket-Protocol: v5.channel.k8s.io");
      return this.#execRoute(ns, name!, url);
    }
    if (upgrade) return un("a websocket upgrade is served only on pods/{name}/exec");
    const pods = this.#pods.get(ns)!;
    if (name === undefined) {
      if (method === "POST") {
        const extra = allowedQuery(["dryRun", "fieldManager"]);
        return extra.length > 0
          ? un(`create takes only dryRun and fieldManager, got ${extra.join(", ")}`)
          : this.#createPod(ns, raw, url.searchParams.get("dryRun"));
      }
      if (method === "GET") {
        const extra = allowedQuery(["labelSelector", "fieldSelector"]);
        if (extra.length > 0) return un(`list takes only labelSelector and fieldSelector, got ${extra.join(", ")}`);
        return this.#listPods(ns, url.searchParams.get("labelSelector"), url.searchParams.get("fieldSelector"));
      }
      return un(`${method} is not served on the pods collection`);
    }
    const rec = pods.get(name);
    const notFound = () => this.#fail(404, "NotFound", `pods "${name}" not found`, { name, kind: "pods" });
    if (method === "GET") {
      const extra = allowedQuery([]);
      return extra.length > 0 ? un(`get takes no query, got ${extra.join(", ")}`) : rec === undefined ? notFound() : this.#json(200, rec.pod);
    }
    if (method === "DELETE") {
      const extra = allowedQuery(["gracePeriodSeconds"]);
      if (extra.length > 0) return un(`delete takes only gracePeriodSeconds, got ${extra.join(", ")}`);
      return rec === undefined ? notFound() : this.#deletePod(ns, name, rec, url.searchParams.get("gracePeriodSeconds"), raw);
    }
    if (method === "PATCH") {
      const type = String(req.headers["content-type"] ?? "");
      if (!/merge-patch\+json/.test(type))
        return un(`patch content-type is "${type}"; send application/merge-patch+json or application/strategic-merge-patch+json`);
      return rec === undefined ? notFound() : this.#patchPod(name, rec, raw);
    }
    return un(`${method} is not served on a pod`);
  }

  // ---- pods ----

  #createPod(ns: string, raw: string, dryRun: string | null): Out {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.#fail(
        400,
        "BadRequest",
        "the body of the request was in an unknown format - accepted media types include: application/json",
        undefined,
        "create body is not JSON; send the Pod as JSON",
      );
    }
    const body = asObj(parsed);
    if (body.kind !== undefined && body.kind !== "Pod") {
      return this.#fail(
        400,
        "BadRequest",
        `Object 'Kind' is '${String(body.kind)}', expected 'Pod'`,
        undefined,
        `create body kind is ${String(body.kind)}; send kind Pod`,
      );
    }
    if (dryRun !== null && dryRun !== "All")
      return this.#fail(400, "BadRequest", `dryRun "${dryRun}" is invalid; the only value is All`, undefined, `dryRun=${dryRun}`);
    const meta = asObj(body.metadata);
    if (meta.namespace !== undefined && meta.namespace !== ns) {
      return this.#fail(
        400,
        "BadRequest",
        "the namespace of the provided object does not match the namespace sent on the request",
        undefined,
        "body namespace differs from the URL namespace",
      );
    }
    this.#counter += 1;
    const name =
      typeof meta.name === "string" && meta.name !== ""
        ? meta.name
        : typeof meta.generateName === "string"
          ? `${meta.generateName}${this.#counter.toString(36).padStart(5, "0")}`
          : "";
    const spec = asObj(body.spec);
    const causes: { reason: string; message: string; field: string }[] = [];
    const bad = (field: string, message: string, reason = "FieldValueInvalid") => causes.push({ reason, message, field });
    if (name === "") bad("metadata.name", "name or generateName is required", "FieldValueRequired");
    else if (name.length > 253 || !DNS_SUBDOMAIN.test(name))
      bad(
        "metadata.name",
        `Invalid value: "${name}": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character`,
      );
    const containers = asArr(spec.containers);
    if (containers.length === 0) bad("spec.containers", "Required value", "FieldValueRequired");
    containers.forEach((c, i) => {
      if (typeof c.name !== "string" || c.name === "") bad(`spec.containers[${i}].name`, "Required value", "FieldValueRequired");
      if (typeof c.image !== "string" || c.image === "") bad(`spec.containers[${i}].image`, "Required value", "FieldValueRequired");
    });
    for (const [k, v] of Object.entries(asObj(meta.labels))) {
      if (typeof v !== "string" || v.length > 63 || !LABEL_VALUE.test(v))
        bad("metadata.labels", `Invalid value: "${String(v)}": must be no more than 63 characters and match the label value syntax (key "${k}")`);
    }
    if (causes.length > 0) {
      const text = causes.map((c) => `${c.field}: ${c.message}`);
      return this.#fail(422, "Invalid", `Pod "${name}" is invalid: ${text.length === 1 ? text[0] : `[${text.join(", ")}]`}`, { name, kind: "Pod", causes });
    }
    const violations = podSecurityViolations(spec, this.#opts.podSecurity);
    if (violations.length > 0) {
      return this.#fail(403, "Forbidden", `pods "${name}" is forbidden: violates PodSecurity "${this.#opts.podSecurity}:latest": ${violations.join(", ")}`, {
        name,
        kind: "pods",
      });
    }
    const store = this.#pods.get(ns)!;
    if (store.has(name)) return this.#fail(409, "AlreadyExists", `pods "${name}" already exists`, { name, kind: "pods" });
    const pod: Obj = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        ...meta,
        name,
        namespace: ns,
        uid: `00000000-0000-4000-8000-${String(this.#counter).padStart(12, "0")}`,
        resourceVersion: String(this.#counter),
        creationTimestamp: this.#iso(this.#now()),
      },
      spec: { restartPolicy: "Always", terminationGracePeriodSeconds: 30, dnsPolicy: "ClusterFirst", schedulerName: "default-scheduler", ...spec },
      status: { phase: "Pending", qosClass: "BestEffort" },
    };
    delete (pod.metadata as Obj).generateName;
    const rec: PodRec = { pod };
    this.#apply(rec, { kind: "running" }, true);
    if (dryRun === "All") return this.#json(201, rec.pod);
    store.set(name, rec);
    const labels = asObj(meta.labels);
    if (typeof labels[this.#opts.canaryLabel] === "string") this.#apply(rec, this.#canaryOutcome(ns, labels));
    else if (this.#opts.startRunning) this.#apply(rec, { kind: "running" });
    return this.#json(201, rec.pod);
  }

  /** A canary ends at once: blocked (exit 0) only when the network plugin enforces policy and a default-deny policy selects it, else it reaches the target. */
  #canaryOutcome(ns: string, labels: Obj): PodOutcome {
    const selected = typeof labels[this.#opts.policyLabel] === "string" && (this.#policies.get(ns)?.size ?? 0) > 0;
    const code = this.#opts.enforcesNetworkPolicy && selected ? this.#opts.canaryExit.blocked : this.#opts.canaryExit.reached;
    return code === 0 ? { kind: "succeeded" } : { kind: "failed", exitCode: code };
  }

  #listPods(ns: string, labelSelector: string | null, fieldSelector: string | null): Out {
    let sel: Selector | undefined;
    if (labelSelector !== null && labelSelector !== "") {
      const p = parseLabelSelector(labelSelector);
      if ("error" in p) return this.#fail(400, "BadRequest", `unable to parse requirement: ${p.error}`, undefined, `labelSelector: ${p.error}`);
      sel = p;
    }
    const fields: [string, string, boolean][] = [];
    for (const t of (fieldSelector ?? "").split(",").filter((x) => x !== "")) {
      const m = /^(metadata\.name|status\.phase)(=|==|!=)(.*)$/.exec(t);
      if (m === null)
        return this.#fail(
          400,
          "BadRequest",
          `field label not supported: ${t.split(/[=!]/)[0]}`,
          undefined,
          `fieldSelector "${t}" is not served; use metadata.name or status.phase`,
        );
      fields.push([m[1]!, m[3]!, m[2] === "!="]);
    }
    const items = this.pods(ns).filter((p) => {
      if (sel !== undefined && !sel.test(asObj(asObj(p.metadata).labels) as Record<string, string>)) return false;
      return fields.every(([f, v, neg]) => ((f === "metadata.name" ? asObj(p.metadata).name : asObj(p.status).phase) === v) !== neg);
    });
    return this.#json(200, { kind: "PodList", apiVersion: "v1", metadata: { resourceVersion: String(this.#counter) }, items });
  }

  #deletePod(ns: string, name: string, rec: PodRec, graceParam: string | null, raw: string): Out {
    let optGrace: number | undefined;
    if (raw !== "") {
      try {
        const g = asObj(JSON.parse(raw)).gracePeriodSeconds;
        if (typeof g === "number") optGrace = g;
      } catch {
        return this.#fail(400, "BadRequest", "the delete options body is not valid JSON", undefined, "delete body is not JSON; send DeleteOptions or no body");
      }
    }
    const meta = rec.pod.metadata as Obj;
    const grace = graceParam !== null ? Number(graceParam) : (optGrace ?? Number(asObj(rec.pod.spec).terminationGracePeriodSeconds ?? 30));
    if (!Number.isInteger(grace) || grace < 0)
      return this.#fail(400, "BadRequest", `gracePeriodSeconds "${graceParam}" must be a non-negative integer`, undefined, "bad gracePeriodSeconds");
    const phase = asObj(rec.pod.status).phase;
    // A pod the kubelet never started, or one that already finished, has nothing to wait for; so does a forced (grace 0) delete.
    const nothingRuns = phase !== "Running" || asObj(rec.pod.spec).nodeName === undefined;
    if (grace === 0 || nothingRuns) {
      this.#pods.get(ns)!.delete(name);
      return this.#json(200, { kind: "Status", apiVersion: "v1", metadata: {}, status: "Success", details: { name, kind: "pods", uid: meta.uid } });
    }
    this.#counter += 1;
    meta.resourceVersion = String(this.#counter);
    meta.deletionGracePeriodSeconds = grace;
    meta.deletionTimestamp ??= this.#iso(new Date(this.#now().getTime() + grace * 1000));
    return this.#json(200, rec.pod);
  }

  #patchPod(name: string, rec: PodRec, raw: string): Out {
    let patch: Obj;
    try {
      patch = asObj(JSON.parse(raw));
    } catch {
      return this.#fail(400, "BadRequest", "the patch body is not valid JSON", undefined, "patch body is not JSON");
    }
    const spec = asObj(patch.spec);
    const specKeys = Object.keys(spec);
    const otherTop = Object.keys(patch).filter((k) => k !== "spec" && k !== "metadata");
    const next = spec.activeDeadlineSeconds;
    if (otherTop.length > 0 || specKeys.some((k) => k !== "activeDeadlineSeconds") || specKeys.length === 0) {
      return this.#fail(
        422,
        "Invalid",
        `Pod "${name}" is invalid: spec: Forbidden: pod updates may not change fields other than \`spec.containers[*].image\`, \`spec.initContainers[*].image\`, \`spec.activeDeadlineSeconds\`, \`spec.tolerations\` (only additions to existing tolerations) or \`spec.terminationGracePeriodSeconds\` (allow it to be set to 1 if it was previously negative)`,
        {
          name,
          kind: "Pod",
          causes: [{ reason: "FieldValueForbidden", message: "Forbidden: pod updates may not change fields other than the mutable ones", field: "spec" }],
        },
      );
    }
    const prev = asObj(rec.pod.spec).activeDeadlineSeconds;
    if (typeof next !== "number" || !Number.isInteger(next) || next < 1 || (typeof prev === "number" && next > prev)) {
      return this.#fail(
        422,
        "Invalid",
        `Pod "${name}" is invalid: spec.activeDeadlineSeconds: Invalid value: ${JSON.stringify(next)}: must be between 1 and the previous value, activeDeadlineSeconds may only be lowered`,
        {
          name,
          kind: "Pod",
          causes: [{ reason: "FieldValueInvalid", message: "Invalid value: activeDeadlineSeconds may only be lowered", field: "spec.activeDeadlineSeconds" }],
        },
      );
    }
    this.#counter += 1;
    (asObj(rec.pod.metadata) as Obj).resourceVersion = String(this.#counter);
    (rec.pod.spec as Obj).activeDeadlineSeconds = next;
    return this.#json(200, rec.pod);
  }

  /** Rewrites `rec.pod.status` for an outcome. `quiet` skips the resourceVersion bump (used while building the object). */
  #apply(rec: PodRec, o: PodOutcome, quiet = false): void {
    const pod = rec.pod;
    const spec = asObj(pod.spec);
    const t = this.#iso(this.#now());
    const containers = asArr(spec.containers);
    const imageId = (image: string) => (image.includes("@sha256:") ? image : `${image}@sha256:${sha(image)}`);
    const statuses = (state: (c: Obj) => Obj, ready: boolean) =>
      containers.map((c) => ({
        name: c.name,
        image: c.image,
        imageID: imageId(String(c.image)),
        ready,
        started: o.kind === "running" && !quiet,
        restartCount: 0,
        state: state(c),
      }));
    const terminated = (exitCode: number, reason: string): Obj => ({ terminated: { exitCode, reason, startedAt: t, finishedAt: t } });
    const phase = (p: string, extra: Obj, cs?: Obj[], conditions: Obj[] = []) => {
      pod.status = {
        phase: p,
        qosClass: "BestEffort",
        ...extra,
        ...(conditions.length > 0 ? { conditions } : {}),
        ...(cs === undefined ? {} : { containerStatuses: cs }),
      };
    };
    const disruption = (reason: string, message: string): Obj => ({ type: "DisruptionTarget", status: "True", reason, message, lastTransitionTime: t });
    switch (o.kind) {
      case "running":
        if (quiet) {
          phase("Pending", {}, statuses(() => ({ waiting: { reason: "ContainerCreating" } }), false) as Obj[]);
          break;
        }
        spec.nodeName ??= "node-1";
        phase("Running", { startTime: t }, statuses(() => ({ running: { startedAt: t } }), true) as Obj[], [
          { type: "Ready", status: "True", lastTransitionTime: t },
        ]);
        break;
      case "succeeded":
        spec.nodeName ??= "node-1";
        phase("Succeeded", { startTime: t }, statuses(() => terminated(0, "Completed"), false) as Obj[]);
        break;
      case "failed":
        spec.nodeName ??= "node-1";
        phase("Failed", { startTime: t }, statuses(() => terminated(o.exitCode, "Error"), false) as Obj[]);
        break;
      case "oom-killed":
        spec.nodeName ??= "node-1";
        phase("Failed", { startTime: t }, statuses(() => terminated(137, "OOMKilled"), false) as Obj[]);
        break;
      case "deadline-exceeded":
        spec.nodeName ??= "node-1";
        phase(
          "Failed",
          { startTime: t, reason: "DeadlineExceeded", message: "Pod was active on the node longer than the specified deadline" },
          statuses(() => terminated(137, "Error"), false) as Obj[],
        );
        break;
      case "evicted": {
        spec.nodeName ??= "node-1";
        const resource = o.resource ?? "memory";
        const message = `The node was low on resource: ${resource}. Threshold quantity: 100Mi, available: 80Mi.`;
        phase("Failed", { reason: "Evicted", message }, undefined, [disruption("TerminationByKubelet", message)]);
        break;
      }
      case "preempted":
        spec.nodeName ??= "node-1";
        phase("Failed", {}, undefined, [disruption("PreemptionByScheduler", "kube-scheduler: preempting to accommodate a higher priority pod")]);
        break;
    }
    if (!quiet) {
      this.#counter += 1;
      (asObj(pod.metadata) as Obj).resourceVersion = String(this.#counter);
    }
  }

  // ---- network policies ----

  #networkPolicyRoute(
    method: string,
    ns: string,
    name: string | undefined,
    raw: string,
    un: (r: string) => Out,
    extraQ: (n: readonly string[]) => string[],
  ): Out {
    const store = this.#policies.get(ns)!;
    if (extraQ([]).length > 0) return un(`networkpolicies take no query, got ${extraQ([]).join(", ")}`);
    if (name === undefined && method === "POST") {
      let body: Obj;
      try {
        body = asObj(JSON.parse(raw));
      } catch {
        return this.#fail(
          400,
          "BadRequest",
          "the body of the request was in an unknown format - accepted media types include: application/json",
          undefined,
          "create body is not JSON",
        );
      }
      const n = asObj(body.metadata).name;
      if (typeof n !== "string" || n === "")
        return this.#fail(422, "Invalid", `NetworkPolicy "" is invalid: metadata.name: Required value: name or generateName is required`, {
          kind: "NetworkPolicy",
          causes: [{ reason: "FieldValueRequired", message: "Required value", field: "metadata.name" }],
        });
      if (store.has(n))
        return this.#fail(409, "AlreadyExists", `networkpolicies.networking.k8s.io "${n}" already exists`, {
          name: n,
          group: "networking.k8s.io",
          kind: "networkpolicies",
        });
      this.#counter += 1;
      const np = {
        ...body,
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: {
          ...asObj(body.metadata),
          namespace: ns,
          uid: `00000000-0000-4000-9000-${String(this.#counter).padStart(12, "0")}`,
          resourceVersion: String(this.#counter),
        },
      };
      store.set(n, np);
      return this.#json(201, np);
    }
    if (name === undefined && method === "GET")
      return this.#json(200, { kind: "NetworkPolicyList", apiVersion: "networking.k8s.io/v1", metadata: {}, items: [...store.values()] });
    if (name !== undefined && (method === "GET" || method === "DELETE")) {
      const np = store.get(name);
      if (np === undefined)
        return this.#fail(404, "NotFound", `networkpolicies.networking.k8s.io "${name}" not found`, {
          name,
          group: "networking.k8s.io",
          kind: "networkpolicies",
        });
      if (method === "GET") return this.#json(200, np);
      store.delete(name);
      return this.#json(200, {
        kind: "Status",
        apiVersion: "v1",
        metadata: {},
        status: "Success",
        details: { name, group: "networking.k8s.io", kind: "networkpolicies", uid: asObj(np.metadata).uid },
      });
    }
    return un(`${method} is not served on networkpolicies`);
  }

  // ---- exec ----

  #execRoute(ns: string, name: string, url: URL): Out {
    const rec = this.#pods.get(ns)!.get(name);
    if (rec === undefined) return this.#fail(404, "NotFound", `pods "${name}" not found`, { name, kind: "pods" });
    const q = url.searchParams;
    const unknownQ = [...q.keys()].filter((k) => !["command", "container", "stdin", "stdout", "stderr", "tty"].includes(k));
    if (unknownQ.length > 0) return { kind: "unmatched", reason: `exec takes command, container, stdin, stdout, stderr and tty, got ${unknownQ.join(", ")}` };
    const command = q.getAll("command");
    if (command.length === 0)
      return this.#fail(
        400,
        "BadRequest",
        "you must specify at least 1 command for the container",
        undefined,
        "exec without a command; send one repeated command= parameter per argv element",
      );
    const names = asArr(asObj(rec.pod.spec).containers).map((c) => String(c.name));
    const container = q.get("container") ?? undefined;
    if (container === undefined && names.length > 1) {
      return this.#fail(
        400,
        "BadRequest",
        `a container name must be specified for pod ${name}, choose one of: [${names.join(" ")}]`,
        undefined,
        "exec without container on a multi-container pod",
      );
    }
    if (container !== undefined && !names.includes(container))
      return this.#fail(400, "BadRequest", `container ${container} is not valid for pod ${name}`, undefined, `exec container ${container} not in the pod`);
    const phase = String(asObj(rec.pod.status).phase);
    if (asObj(rec.pod.spec).nodeName === undefined) return this.#fail(400, "BadRequest", "pod does not have a host assigned");
    if (phase === "Succeeded" || phase === "Failed")
      return this.#fail(400, "BadRequest", `cannot exec in a container in a completed pod; current phase is ${phase}`);
    if (phase !== "Running") return this.#fail(400, "BadRequest", `container not found ("${container ?? names[0]}")`);
    const queue = this.#scripts.get(`${ns}/${name}`) ?? [];
    const at = queue.findIndex((s) => s.command === undefined || isDeepStrictEqual(s.command, command));
    if (at < 0)
      return {
        kind: "unmatched",
        reason: `exec ${JSON.stringify(command)} on ${ns}/${name} has no script; call scriptExec for it (scripts left: ${queue.length})`,
      };
    const [script] = queue.splice(at, 1);
    return { kind: "exec", ns, pod: name, script: script!, container, command };
  }

  #onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const refuse = (status: string, why: string) =>
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(why)}\r\n\r\n${why}`);
    const key = req.headers["sec-websocket-key"];
    const offered = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((p) => p.trim());
    let out: Out;
    if (
      req.headers.upgrade?.toLowerCase() !== "websocket" ||
      typeof key !== "string" ||
      Buffer.from(key, "base64").length !== 16 ||
      req.headers["sec-websocket-version"] !== "13"
    ) {
      this.#reject(req, "not a websocket handshake: send Upgrade: websocket, Sec-WebSocket-Version: 13 and a 16-byte base64 Sec-WebSocket-Key");
      refuse("400 Bad Request", "not a websocket handshake");
      return;
    }
    if (!offered.includes(EXEC_SUBPROTOCOL)) {
      this.#reject(
        req,
        `the client offered subprotocols [${offered.join(", ")}] but the shaper speaks only ${EXEC_SUBPROTOCOL}; offer it in Sec-WebSocket-Protocol`,
      );
      refuse("400 Bad Request", `subprotocol ${EXEC_SUBPROTOCOL} not offered`);
      return;
    }
    out = this.#handle(req, "", true);
    if (out.kind === "hang") return;
    if (out.kind === "unmatched") {
      refuse("501 Not Implemented", out.reason);
      return;
    }
    if (out.kind === "respond") {
      const lines = Object.entries({ ...out.headers, "content-length": String(Buffer.byteLength(out.body)), connection: "close" }).map(
        ([k, v]) => `${k}: ${v}\r\n`,
      );
      socket.end(`HTTP/1.1 ${out.status} ${STATUS_CODES[out.status] ?? "Status"}\r\n${lines.join("")}\r\n${out.body}`);
      return;
    }
    const accept = createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${EXEC_SUBPROTOCOL}\r\n\r\n`,
    );
    this.#runExec(socket, out, head);
  }

  #runExec(socket: Socket, run: Extract<Out, { kind: "exec" }>, head: Buffer): void {
    const { script } = run;
    const reader = new ClientFrames();
    const stdin: Buffer[] = [];
    let answered = false;
    let ended = false;
    const send = (ch: number, payload: Uint8Array | string) => socket.write(wsFrame(2, execMessage(ch, payload)));
    const record = () =>
      this.#execs.push({ namespace: run.ns, pod: run.pod, container: run.container, command: run.command, stdin: Buffer.concat(stdin).toString("utf8") });
    const answer = () => {
      if (answered) return;
      answered = true;
      const out = script.stdout ?? (script.echoStdin ? Buffer.concat(stdin).toString("utf8") : "");
      if (out !== "") send(CH.stdout, out);
      if (script.stderr !== undefined && script.stderr !== "") send(CH.stderr, script.stderr);
      if (script.drop === true) {
        record();
        socket.destroy();
        return;
      }
      send(CH.status, JSON.stringify(script.status ?? execStatus(script.exitCode ?? 0)));
      send(CH.close, Buffer.from([CH.stdout]));
      record();
      socket.write(wsFrame(8, Buffer.from([0x03, 0xe8])));
      const t = setTimeout(() => socket.destroy(), 2000);
      t.unref();
      socket.once("close", () => clearTimeout(t));
    };
    const onData = (chunk: Buffer) => {
      for (const f of reader.push(chunk)) {
        if (f.opcode === 8) {
          ended = true;
          if (!answered) {
            answered = true;
            record();
            this.unmatched.push({
              index: this.#requests.length - 1,
              reason: `exec ${run.pod}: the client closed before the script answered; wait for the status frame`,
            });
          }
          socket.end(wsFrame(8, f.payload.subarray(0, 2)));
        } else if (f.opcode === 9) socket.write(wsFrame(10, f.payload));
        else if (f.opcode === 2 && f.payload.length > 0) {
          const ch = f.payload[0]!;
          if (ch === CH.stdin) stdin.push(Buffer.from(f.payload.subarray(1)));
          else if (ch === CH.close && f.payload[1] === CH.stdin && script.waitForStdin === true) answer();
        }
      }
    };
    socket.on("data", onData);
    socket.on("error", () => socket.destroy());
    socket.on("end", () => {
      if (!answered) record();
      if (!ended) socket.end();
    });
    if (script.waitForStdin !== true) answer();
    if (head.length > 0) onData(head);
  }
}

/** Starts a Kubernetes-shaped loopback API server. Call `close()` when done. */
export function kubernetesShape(options: KubernetesShapeOptions = {}): Promise<KubernetesShaper> {
  return KubernetesShaper.start(options);
}
