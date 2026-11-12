// Boot check that the egress-proxy image really contains the proxy: an image built before the proxy moved in fails every agent
// spawn at sidecar start, far from the cause. The decision is pure; the shell probes the image with `<engine> run` (no network,
// never pulled, no capabilities, read-only) through the LocalEngine's CLI, not sandbox-docker's Exec: it needs the exit code
// (present 0 vs absent MISSING_EXIT vs the engine's own failures) and a timeout, and Exec yields only stdout or a classified error.
// The image is agent.egressProxyImage as configured: name[:tag]@sha256:<hex>, or the engine-local id, which is field 2 of the line
// the agent-image build prints (`<tag> <engineLocalId> <configDigest> [mediaType]`); the engine runs either form as given.
import { IMAGE_REBUILD_ACTION } from "@pomtree/core";
import { EGRESS_PROXY_PATH, type EngineCli } from "@pomtree/sandbox-docker";

const MISSING_EXIT = 3; // the probe's own exit code for "file absent", distinct from the engine CLI's 125-127 and node's 1
const PROBE_TIMEOUT_MS = 20_000;

export type ImageVerdict = { refuse: string } | { ok: true } | { unknown: string };

// proxyPresent undefined = the probe could not tell (engine unreachable, image missing): never a refusal, other checks own those.
export function imageCheckVerdict(o: { image: string; revision: string | undefined; proxyPresent: boolean | undefined; reason?: string }): ImageVerdict {
  if (o.proxyPresent === undefined)
    return { unknown: `agent image ${o.image}: could not check for the egress proxy (${o.reason ?? "probe failed"}); skipping`.trim() };
  if (o.proxyPresent) return { ok: true };
  return {
    refuse: `agent image ${o.image} (revision ${o.revision ?? "unknown"}) has no egress proxy; every agent spawn would fail at sidecar start; ${IMAGE_REBUILD_ACTION}.`,
  };
}

export const probeArgs = (image: string): string[] => [
  "run",
  "--rm",
  // A digest-pinned image absent locally must not make boot pull it (the adapter never pulls the proxy image either).
  "--pull",
  "never",
  "--network",
  "none",
  "--cap-drop=ALL",
  "--security-opt",
  "no-new-privileges",
  "--read-only",
  "--entrypoint",
  "node",
  image,
  "-e",
  `process.exit(require('node:fs').existsSync('${EGRESS_PROXY_PATH}')?0:${MISSING_EXIT})`,
];

export async function probeEgressProxy(image: string, engine: EngineCli): Promise<{ proxyPresent: boolean | undefined; reason?: string }> {
  const r = await engine.run(probeArgs(image), { timeoutMs: PROBE_TIMEOUT_MS });
  if (r.code === 0) return { proxyPresent: true };
  if (r.code === MISSING_EXIT) return { proxyPresent: false };
  const b = engine.binary;
  return { proxyPresent: undefined, reason: `${b} run exited ${r.code ?? `without a code (timeout or ${b} missing)`}: ${r.stderr.trim().slice(0, 200)}` };
}

// Boot hook: refuses the start (same format as main.ts's other refusals) when the image lacks the proxy; otherwise returns.
// TODO(boot-image-check-cost): one `<engine> run` per boot, failing open when the engine is unavailable or the probe times out.
export async function checkEgressImage(
  image: string,
  engine: EngineCli,
  io: { revision: (image: string) => string | undefined; log?: (line: string) => void; exit?: (code: number) => never },
): Promise<ImageVerdict> {
  const log = io.log ?? ((l: string) => console.error(l));
  const probe = await probeEgressProxy(image, engine);
  const v = imageCheckVerdict({ image, revision: io.revision(image), ...probe });
  if ("refuse" in v) {
    log(`pomtreed: refusing to start: ${v.refuse}`);
    (io.exit ?? process.exit)(1);
  } else if ("unknown" in v) log(`pomtreed: ${v.unknown}`);
  return v;
}
