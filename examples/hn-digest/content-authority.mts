// Authority matches normalized native browser_capture telemetry, never bash stdout or a model's result/report IDs.
// The telemetry is trustworthy only because the worker has no exec or write tools: the allowlist (browser_capture, capture_finish) is enforced
// inside the immutable image by browser-run.ts, which refuses caller tool flags, and the capture chain runs by absolute path with a fixed PATH,
// so the model cannot forge the events file or plant a node/pomtree shim. The host supplies the immutable-image/template approval
// (`approvedBrowserWorker`). Residual risks: a Chromium renderer escape, the pinned pi-browser code (loaded in the worker's own process), and
// same-uid trust inside the container. This is not agent-independent attestation.
import type { AgentRecord, Journal, Registry } from "../../packages/core/src/index.ts";
import { checkPublicUrl } from "./article.mts";
import { parseNativeCaptureArgs } from "./browser-contract.mts";
import type { ContentBounds } from "./content-bounds.mts";
import { BROWSER_TEMPLATE } from "./content-browser-method.mts";
import { jsonHash, record, SHA } from "./content-contract.mts";
import type { Artifact, CaptureAuthority, CaptureReceipt } from "./content-evidence.mts";

export function parseCaptureReceipt(output: string): CaptureReceipt | null {
  if (Buffer.byteLength(output) > 65536) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    return null;
  }
  if (
    !record(raw) ||
    typeof raw.worker !== "string" ||
    raw.worker.length < 1 ||
    raw.worker.length > 200 ||
    !Number.isSafeInteger(raw.generation) ||
    (raw.generation as number) < 0 ||
    typeof raw.originalUrl !== "string" ||
    !checkPublicUrl(raw.originalUrl).ok ||
    typeof raw.finalUrl !== "string" ||
    !checkPublicUrl(raw.finalUrl).ok ||
    (raw.method !== "browser" && raw.method !== "static-http") ||
    !Number.isSafeInteger(raw.status) ||
    (raw.status as number) < 100 ||
    (raw.status as number) > 599 ||
    typeof raw.contentType !== "string" ||
    raw.contentType.length > 200
  )
    return null;
  const keys = [
    "worker",
    "generation",
    "originalUrl",
    "finalUrl",
    "method",
    "status",
    "contentType",
    "rawBodyReport",
    "textReport",
    ...(raw.method === "browser" ? ["domReport", "screenshotReport", "navigationReport"] : []),
    // Static worker only: optional truncation facts and fetch time (see CaptureReceipt).
    ...(raw.method === "static-http" ? ["truncated", "bytesRetained", "fetchedAt"].filter((key) => key in raw) : []),
  ];
  if ("truncated" in raw && typeof raw.truncated !== "boolean") return null;
  if ("bytesRetained" in raw && (!Number.isSafeInteger(raw.bytesRetained) || (raw.bytesRetained as number) < 0)) return null;
  if ("fetchedAt" in raw && (typeof raw.fetchedAt !== "string" || Number.isNaN(Date.parse(raw.fetchedAt)))) return null;
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !(key in raw))) return null;
  const artifact = (value: unknown): value is Artifact =>
    record(value) &&
    Object.keys(value).sort().join(",") === "id,sha256" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 200 &&
    typeof value.sha256 === "string" &&
    SHA.test(value.sha256);
  if (!artifact(raw.rawBodyReport) || !artifact(raw.textReport)) return null;
  if (raw.method === "browser" && (!artifact(raw.domReport) || !artifact(raw.navigationReport) || !artifact(raw.screenshotReport))) return null;
  return raw as unknown as CaptureReceipt;
}

// The host's approval of a browser worker: a container of the browser template, started as a browser worker (the controller-set
// `spec.browser` marker without an interactive profile, which makes the sandbox run browser-run.ts and its tool allowlist) from exactly the approved image digest.
export function approvedBrowserWorker(child: AgentRecord, approvedImage: string): boolean {
  return (
    child.executor === "container" &&
    child.spec.template === BROWSER_TEMPLATE &&
    child.spec.browser !== undefined &&
    child.spec.browser.profile === undefined &&
    child.spec.image === approvedImage
  );
}

export function createJournalCaptureAuthority(deps: {
  journal: Pick<Journal, "read">;
  registry: Pick<Registry, "get">;
  approvedWorker(child: AgentRecord): boolean;
  bounds: ContentBounds; // the capture argument range (browser.capture.*) the worker was given
}): CaptureAuthority {
  return {
    async receipt(worker, generation, expected) {
      const wanted = parseNativeCaptureArgs(expected, deps.bounds);
      if (!wanted) return null;
      const child = await deps.registry.get(worker);
      if (
        !child ||
        child.generation !== generation ||
        child.executor !== "container" ||
        child.spec.egress.kind !== "audited-public" ||
        !deps.approvedWorker(child)
      )
        return null;
      let invocation: { callId: string; valid: boolean } | null = null;
      let found: CaptureReceipt | null = null;
      let from = 0;
      // Count INVOCATIONS, including failed/malformed calls, independently of successful receipt parsing. Rejecting a retry
      // does not roll back a source request already dispatched and is not an upstream exactly-once guarantee.
      for (let page = 0; page < 20; page++) {
        const entries = await deps.journal.read({ agent: worker, from, limit: 500 });
        for (const entry of entries) {
          if (entry.agent !== worker || entry.generation !== generation || entry.host !== child.host) continue;
          const p = entry.payload;
          if (p.kind === "tool_call" && p.tool === "browser_capture") {
            if (invocation !== null) return null;
            const args = parseNativeCaptureArgs(p.input, deps.bounds);
            invocation = { callId: p.callId, valid: args !== null && jsonHash(args) === jsonHash(wanted) };
          }
          if (p.kind !== "tool_result" || !p.ok || !invocation?.valid || p.callId !== invocation.callId) continue;
          if (found !== null) return null;
          const capture = parseCaptureReceipt(p.output);
          if (!capture || capture.method !== "browser" || capture.worker !== worker || capture.generation !== generation || capture.originalUrl !== wanted.url)
            continue;
          found = capture;
        }
        if (entries.length < 500) return found;
        const last = entries.at(-1);
        if (!last) return null;
        from = last.seq + 1;
      }
      return null;
    },
  };
}
