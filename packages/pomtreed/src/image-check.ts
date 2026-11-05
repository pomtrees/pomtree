// Boot check that the egress-proxy image really contains the proxy: an image built before the proxy moved in fails every agent
// spawn at sidecar start, far from the cause. The decision is pure; the shell probes the image with `docker run` (no network,
// never pulled, no capabilities, read-only). The probe keeps its own execFile, not sandbox-docker's Exec: it needs the exit code
// (present 0 vs absent MISSING_EXIT vs docker's own failures) and a timeout, and Exec yields only stdout or a classified error.
import { execFile } from "node:child_process";
import { IMAGE_REBUILD_ACTION } from "@pomtree/core";
import { EGRESS_PROXY_PATH } from "@pomtree/sandbox-docker";
import { imageRevision } from "./revision.ts";

const MISSING_EXIT = 3; // the probe's own exit code for "file absent", distinct from docker's 125-127 and node's 1

export type ImageVerdict = { refuse: string } | { ok: true } | { unknown: string };

// proxyPresent undefined = the probe could not tell (docker unreachable, image missing): never a refusal, other checks own those.
export function imageCheckVerdict(o: { image: string; revision: string | undefined; proxyPresent: boolean | undefined; reason?: string }): ImageVerdict {
  if (o.proxyPresent === undefined)
    return { unknown: `agent image ${o.image}: could not check for the egress proxy (${o.reason ?? "probe failed"}); skipping`.trim() };
  if (o.proxyPresent) return { ok: true };
  return {
    refuse: `agent image ${o.image} (revision ${o.revision ?? "unknown"}) has no egress proxy; every agent spawn would fail at sidecar start; ${IMAGE_REBUILD_ACTION}.`,
  };
}

export type ExecFn = (file: string, args: string[], opts: { timeout: number }) => Promise<{ code: number | null; stderr: string }>;

const realExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeout, encoding: "utf8" }, (err, _stdout, stderr) => {
      if (!err) return resolve({ code: 0, stderr });
      const code = (err as { code?: unknown }).code;
      resolve({ code: typeof code === "number" ? code : null, stderr: stderr || err.message });
    });
  });

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

export async function probeEgressProxy(image: string, exec: ExecFn = realExec): Promise<{ proxyPresent: boolean | undefined; reason?: string }> {
  const r = await exec("docker", probeArgs(image), { timeout: 20_000 });
  if (r.code === 0) return { proxyPresent: true };
  if (r.code === MISSING_EXIT) return { proxyPresent: false };
  return { proxyPresent: undefined, reason: `docker run exited ${r.code ?? "without a code (timeout or docker missing)"}: ${r.stderr.trim().slice(0, 200)}` };
}

// Boot hook: refuses the start (same format as main.ts's other refusals) when the image lacks the proxy; otherwise returns.
// TODO(boot-image-check-cost): one `docker run` per boot, failing open when Docker is unavailable or the probe times out.
export async function checkEgressImage(
  image: string,
  io: { exec?: ExecFn; revision?: (image: string) => string | undefined; log?: (line: string) => void; exit?: (code: number) => never } = {},
): Promise<ImageVerdict> {
  const log = io.log ?? ((l: string) => console.error(l));
  const probe = await probeEgressProxy(image, io.exec);
  const v = imageCheckVerdict({ image, revision: (io.revision ?? imageRevision)(image), ...probe });
  if ("refuse" in v) {
    log(`pomtreed: refusing to start: ${v.refuse}`);
    (io.exit ?? process.exit)(1);
  } else if ("unknown" in v) log(`pomtreed: ${v.unknown}`);
  return v;
}
