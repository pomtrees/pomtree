// The loopback backend's wire format, as pure functions: the request bodies and paths it sends, the label rule it enforces before
// sending anything, and the parsing of what the provider returns. No I/O and no runtime imports beyond node: builtins, so the unit
// tests run with plain `node --test` and a reviewer can read the whole protocol in one file.
//
// The provider API is invented for this template ("the loopback sandbox API", served offline by conformance/loopback-server.mts):
//   POST /v1/sandboxes                        create; the body names the sandbox, so a repeated name is refused with 409 (unique-name)
//   GET  /v1/sandboxes?storeId=&maxEpoch=     list, filtered by the owner's store and epoch on the provider side (list.byTag)
//   GET  /v1/sandboxes/<name>                 one record, or 404
//   GET  /v1/sandboxes/<name>/wait?timeoutMs= long poll: the record once it is no longer running, or as is after the timeout
//   GET  /v1/sandboxes/<name>/logs?from=      log lines from an offset
//   POST /v1/sandboxes/<name>/stop | /kill    end it (exit 143 or 137); 404 when there is no such sandbox
//   GET  /v1/images/<ref>                     the image's content digest
//   GET  /v1/health                           readiness and the account id
import { createHash } from "node:crypto";
import type { SandboxListing, SandboxOwner, SandboxSpec } from "@pomtree/core";

export const API = "/v1";

// The provider's record of one sandbox.
export interface LoopbackRecord {
  name: string;
  agent: string;
  image: string;
  state: "running" | "exited" | "preempted";
  exitCode: number | null;
  labels: Record<string, string>;
  // The owner stamp the create body carried (SandboxSpec.host and generation); the provider stores and returns it untouched.
  host: string;
  generation: number;
  fingerprint: string; // sha256 of the create body the provider accepted
}

// SandboxSpec.labels: names of [A-Za-z0-9_.-], never starting with "pomtree" (reserved for the daemon's own tags). Returns the reason
// a label set is refused, or null. Checked before any request, so a refused start creates nothing.
const LABEL_NAME = /^[A-Za-z0-9_.-]+$/;
export function labelProblem(labels: Readonly<Record<string, string>> | undefined): string | null {
  for (const name of Object.keys(labels ?? {})) {
    if (!LABEL_NAME.test(name)) return `label name ${JSON.stringify(name)} is not [A-Za-z0-9_.-]+; rename the label`;
    if (name.toLowerCase().startsWith("pomtree")) return `label name ${JSON.stringify(name)} starts with "pomtree", which is reserved; rename the label`;
  }
  return null;
}

// Keys sorted, so one spec always serialises to the same bytes: the provider fingerprints the body, and a retry must match it.
const sorted = (o: Readonly<Record<string, string>> | undefined) =>
  Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// The create body for `spec` under the sandbox name derived from the idempotency key. Mounts, resources, runtime, egress and tty are
// not sent: the loopback provider runs no process and realises none of them, and the declaration says so (all those capabilities false).
export function createBody(name: string, spec: SandboxSpec): string {
  return JSON.stringify({
    name,
    agent: spec.agent,
    image: spec.image,
    env: sorted(spec.env),
    cmd: spec.cmd ?? null,
    labels: sorted(spec.labels),
    host: spec.host,
    generation: spec.generation,
  });
}

export const fingerprint = (body: string): string => createHash("sha256").update(body).digest("hex");

export const sandboxPath = (name: string, verb?: "wait" | "logs" | "stop" | "kill") =>
  `${API}/sandboxes/${encodeURIComponent(name)}${verb === undefined ? "" : `/${verb}`}`;

// The owner filter, sent as query parameters: the provider returns sandboxes whose store_id label is absent or equal to the owner's
// store and whose daemon_epoch label is absent or not newer than the owner's epoch.
export function listPath(owner: SandboxOwner): string {
  const q = new URLSearchParams({ storeId: owner.storeId, maxEpoch: String(owner.epoch) });
  return `${API}/sandboxes?${q}`;
}

export function parseRecord(raw: unknown): LoopbackRecord {
  const o = raw as Partial<LoopbackRecord> | null;
  if (
    typeof o !== "object" ||
    o === null ||
    typeof o.name !== "string" ||
    typeof o.agent !== "string" ||
    !(o.state === "running" || o.state === "exited" || o.state === "preempted") ||
    !(o.exitCode === null || typeof o.exitCode === "number") ||
    typeof o.labels !== "object" ||
    o.labels === null ||
    typeof o.host !== "string" ||
    typeof o.generation !== "number"
  ) {
    throw new Error(
      `the loopback provider returned a malformed sandbox record ${JSON.stringify(raw)}; check that sandbox.loopback.baseUrl points at a loopback sandbox API`,
    );
  }
  return o as LoopbackRecord;
}

// A record as the port's listing. Host and generation are the stamp the create body carried, read back by the rule core's readOwnerStamp applies (kept inline: this file imports nothing at runtime): an empty host or one with a control character, or a generation that is not a non-negative safe integer, reads null.
// The inline copy is held to core's rule by packages/testing/src/loopback-stamp-mirror.test.ts (this file and its copy under packages/testing/src/sandbox-loopback-broken).
export function toListing(r: LoopbackRecord): SandboxListing {
  return {
    id: r.name,
    agent: r.agent,
    backend: "loopback",
    host: r.host === "" || [...r.host].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) ? null : r.host,
    generation: Number.isSafeInteger(r.generation) && r.generation >= 0 ? r.generation : null,
    state: r.state === "preempted" ? "unknown" : r.state,
    ...(Object.keys(r.labels).length > 0 && { labels: r.labels }),
  };
}
