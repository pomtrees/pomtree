// Mechanical static-reader adapter for an ACTUAL container worker. No model-generated evidence and no ambient fetch.
// The worker host injects its audited-public proxy transport, scoped report publisher and authoritative audit callback.
// Importing this file never performs I/O. Browser rendering belongs to the separate real browser adapter.
import type { ArticleInput } from "./article.mts";
import { captureStaticArticleDetailed, checkPublicUrl, validateArticleInput } from "./article.mts";
import type { ContentBounds } from "./content-bounds.mts";
import type { Artifact, CaptureReceipt } from "./content-evidence.mts";
import { hash } from "./content-contract.mts";

export interface StaticWorkerServices {
  worker: string;
  generation: number;
  signal: AbortSignal;
  // REQUIRED actual worker profile. This assertion is an adapter invariant, not launch-input authorization.
  profile: "audited-public";
  transport(
    url: string,
    init: { redirect: "manual"; signal: AbortSignal },
  ): Promise<{ status: number; headers: { get(name: string): string | null }; body: AsyncIterable<Uint8Array> | null }>;
  publish(name: string, bytes: Uint8Array): Promise<Artifact>;
  record(receipt: CaptureReceipt): Promise<void>;
  bounds: ContentBounds; // the input ceiling and article text bound (the same resolved set the host verifier uses)
  now?: () => number;
}

// Drops a trailing incomplete UTF-8 sequence left by the byte cap, so the retained prefix decodes strictly.
function trimIncompleteUtf8(bytes: Uint8Array): Uint8Array {
  for (let i = bytes.byteLength - 1; i >= Math.max(0, bytes.byteLength - 3); i--) {
    const b = bytes[i] as number;
    if ((b & 0xc0) === 0x80) continue;
    const length = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return length > bytes.byteLength - i ? bytes.subarray(0, i) : bytes;
  }
  return bytes;
}

export async function runStaticWorker(raw: ArticleInput, services: StaticWorkerServices): Promise<{ summary: string; capture: CaptureReceipt }> {
  const checked = validateArticleInput(raw, services.bounds);
  if (!checked.ok) throw new Error(checked.error);
  if (services.profile !== "audited-public") throw new Error("static capture requires actual audited-public worker transport");
  const input = checked.value;
  let url = input.url;
  let status = 0;
  let contentType = "";
  let bytes: Uint8Array = new Uint8Array();
  let truncated = false;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (services.signal.aborted) throw new Error("article capture cancelled");
    const response = await services.transport(url, { redirect: "manual", signal: services.signal });
    status = response.status;
    contentType = response.headers.get("content-type") ?? "";
    const location = response.headers.get("location");
    if (status >= 300 && status < 400 && location) {
      // Release/cancel the redirect response without consuming unbounded bytes before opening the next public target.
      if (response.body) await response.body[Symbol.asyncIterator]().return?.();
      if (redirects === 3) throw new Error("article public redirect bound exceeded");
      const target = new URL(location, url).href;
      if (!checkPublicUrl(target).ok) throw new Error("article redirect is not a credential-free public URL");
      url = target;
      continue;
    }
    // Reads at most maxBytes. Leaving the loop early releases the body; a body of exactly maxBytes is not truncated.
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body)
      for await (const chunk of response.body) {
        if (services.signal.aborted) throw new Error("article capture cancelled");
        if (chunk.byteLength === 0) continue;
        if (size + chunk.byteLength > input.maxBytes) {
          chunks.push(chunk.subarray(0, input.maxBytes - size));
          size = input.maxBytes;
          truncated = true;
          break;
        }
        size += chunk.byteLength;
        chunks.push(chunk);
      }
    bytes = new Uint8Array(Buffer.concat(chunks));
    if (truncated) bytes = trimIncompleteUtf8(bytes);
    break;
  }
  const fetchedAt = new Date((services.now ?? Date.now)()).toISOString();
  const retention = truncated ? { truncated, bytesRetained: bytes.byteLength } : {};
  const body = Buffer.from(bytes).toString("utf8");
  // Static extractor consumes UTF-8 HTML. Refuse a lossy decode rather than attest to hashes of different source bytes.
  if (!Buffer.from(body).equals(Buffer.from(bytes))) throw new Error("article encoding unsupported (UTF-8 required)");
  const { evidence, text } = captureStaticArticleDetailed(input, { status, body, sha256: hash(body), contentType }, services.bounds, {
    ...retention,
    fetchedAt,
  });
  const rawBodyReport = await services.publish("article-body.html", bytes);
  const textBytes = new TextEncoder().encode(text);
  const textReport = await services.publish("article-text.md", textBytes);
  if (rawBodyReport.sha256 !== hash(body) || textReport.sha256 !== hash(text)) throw new Error("worker artifact publisher returned wrong hashes");
  const capture: CaptureReceipt = {
    worker: services.worker,
    generation: services.generation,
    originalUrl: input.url,
    finalUrl: url,
    method: "static-http",
    status,
    contentType,
    rawBodyReport,
    textReport,
    ...retention,
    fetchedAt,
  };
  // The real host adapter, not a model result, owns this receipt. Record BEFORE the task submits its result.
  await services.record(capture);
  return { summary: `Static article capture ${evidence.status}; no JavaScript/rendering proof`, capture };
}
