import {
  EGRESS_PROXY_PORT,
  EGRESS_SOCKET_DIR,
  EGRESS_SOCKET_NAME,
  type HostId,
  type PROXY_ENV_NAMES,
  type SandboxEgress,
  type SandboxId,
  type SandboxSpec,
} from "@pomtree/core";

// Every worker has network-none. Its loopback byte bridge forwards ONLY to its private shared
// Unix socket, where the sidecar's existing HTTP/CONNECT parser applies the resolved policy.
// Environment variables select that bridge for clients; they are not the confinement boundary.
// The proxy socket inside both containers (the image facts; worker.ts and proxy.ts derive the same path in-image).
export const EGRESS_SOCKET_PATH = `${EGRESS_SOCKET_DIR}/${EGRESS_SOCKET_NAME}`;
// Where the agent image's egress COPY (agent-image Dockerfile) puts the proxy entrypoint: the sidecar runs it, pomtreed's boot probe checks it.
export const EGRESS_PROXY_PATH = "/opt/pomtree/egress/proxy.ts";
export const EGRESS_PROXY_MEMORY_BYTES = 128 * 1024 ** 2;
export function defaultDenyEgress(spec: SandboxSpec): SandboxSpec {
  return spec.egress ? spec : { ...spec, egress: { allow: [] } };
}
// (host, generation) the egress audit is attributed to, for every egress mode: the audited-public policy's, else the spec's own
// `attribution`. Without either, a default-mode sandbox is unaudited (stderr denial lines only).
// TODO(egress-deny-audit): core SandboxEgress.attribution is not declared yet; this local type reads it until the contract batch lands, then delete it. Current behavior: a default-mode spec without it gets no spool (stderr denial line only).
type AttributedEgress = SandboxEgress & { attribution?: { host: HostId; generation: number } };
export function egressAttribution(spec: SandboxSpec): { host: HostId; generation: number } | undefined {
  const egress: AttributedEgress | undefined = spec.egress;
  return egress?.auditedPublic ?? egress?.attribution;
}
// Exact deterministic lifecycle names, not broad label cleanup. Audit lives independently on host.
export const egressProxyName = (id: SandboxId) => `pomtree-egress-proxy-${id}`;
export const egressSocketVolumeName = (id: SandboxId) => `pomtree-egress-socket-${id}`;

// The daemon owner of an egress sidecar / socket volume: the same store_id and daemon_epoch labels pomtreed stamps on every sandbox
// (SandboxSpec.labels; reconcile's ownsSandbox reads them), copied onto both at creation.
export const OWNER_STORE_LABEL = "store_id";
export const OWNER_EPOCH_LABEL = "daemon_epoch";
export interface EgressOwner {
  storeId: string;
  epoch: string;
}
// Whether an egress resource with these labels belongs to `owner`, so its orphan sweep may remove it. Stricter than reconcile's
// ownsSandbox: the store must match exactly, so a resource with no store_id (stamped by a daemon without one, or created before
// the owner labels existed) is never ours; there is no compatibility reading of unlabeled resources. A newer daemon_epoch on our
// store belongs to the newer daemon. A non-numeric epoch on either side does not block (ownsSandbox's rule).
export function egressOwnedBy(labels: Readonly<Record<string, string | undefined>>, owner: EgressOwner): boolean {
  if (labels[OWNER_STORE_LABEL] !== owner.storeId) return false;
  const stamped = labels[OWNER_EPOCH_LABEL];
  if (!stamped) return false;
  const theirs = Number(stamped);
  const mine = Number(owner.epoch);
  return !(Number.isFinite(theirs) && Number.isFinite(mine) && theirs > mine);
}
export function egressAllowCsv(spec: SandboxSpec): string {
  return spec.egress?.allow.map((t) => `${t.host}:${t.port ?? 443}`).join(",") ?? "";
}
export function buildNetworkArgs(id: SandboxId, spec: SandboxSpec): string[] {
  return spec.egress ? ["--network", "none", "--mount", `type=volume,source=${egressSocketVolumeName(id)},target=${EGRESS_SOCKET_DIR},readonly`] : [];
}
export function proxyEnv(_id: SandboxId, spec: SandboxSpec): Record<string, string> {
  if (!spec.egress) return {};
  const url = `http://127.0.0.1:${EGRESS_PROXY_PORT}`;
  // Controller/CDP process transport is loopback-local. Chromium separately removes its implicit
  // page loopback bypass, so page-originated local requests are still denied by the proxy.
  const local = "localhost,127.0.0.1,::1";
  // Typed by the image fact, so a name added to or dropped from PROXY_ENV_NAMES fails to compile here.
  const env: Record<(typeof PROXY_ENV_NAMES)[number], string> = {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NODE_USE_ENV_PROXY: "1",
    NO_PROXY: local,
    no_proxy: local,
  };
  return env;
}
