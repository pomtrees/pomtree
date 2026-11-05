// Image content blocks in a Pi tool result become bounded, non-binary references, never the base64 payload.
// Shape of a block ([verified] against a real Pi session record, a `read` toolResult: `{ type: "image", data: <base64>, mimeType: "image/png" }`;
// the live `tool_execution_end` event's `result.content` is assumed to carry the same blocks [knowledge-only]).
import { createHash } from "node:crypto";
import { boundToolDetails, type JsonValue } from "@pomtree/core";

// Decoded bytes hashed per image at most; past it the size is derived from the base64 length and nothing is decoded.
export const MAX_IMAGE_HASH_BYTES = 8 * 1024 * 1024;
// Refs kept per result; the rest are counted, so the journaled details stay under their 1 KiB bound.
export const MAX_IMAGE_REFS = 6;
export const IMAGES_KEY = "pomtree_images";
export const IMAGES_OMITTED_KEY = "pomtree_images_omitted";
// Where a tool's own non-object details go when images share the details value.
export const TOOL_DETAILS_KEY = "pomtree_tool_details";

// ok: decoded and hashed. oversize: `bytes` derived from the base64 length, no hash. malformed: not base64 (no size). no_data: `data` absent or not a string.
export type ImageStatus = "ok" | "oversize" | "malformed" | "no_data";
export interface ImageRef {
  kind: "image";
  mime: string;
  bytes?: number;
  sha256?: string;
  status: ImageStatus;
}

const MIME = /^[a-z][a-z0-9.+-]{0,40}\/[a-z0-9][a-z0-9.+-]{0,60}$/i;
// Flat (no nested groups: a grouped repeat overflows the regex stack on multi-megabyte input); the length rule covers the grouping.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_HASH_BYTES / 3) * 4;

export function imageRef(block: Record<string, unknown>): ImageRef {
  const mime = typeof block.mimeType === "string" && MIME.test(block.mimeType) ? block.mimeType.toLowerCase() : "unknown";
  const data = block.data;
  if (typeof data !== "string" || data.length === 0) return { kind: "image", mime, status: "no_data" };
  if (data.length > MAX_BASE64_CHARS) {
    // Not decoded or validated: the size is an estimate from the length and the tail's padding.
    const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    return { kind: "image", mime, bytes: Math.floor((data.length * 3) / 4) - pad, status: "oversize" };
  }
  if (data.length % 4 !== 0 || !BASE64.test(data)) return { kind: "image", mime, status: "malformed" };
  const bytes = Buffer.from(data, "base64");
  return { kind: "image", mime, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), status: "ok" };
}

export function imageRefs(content: unknown): { refs: ImageRef[]; omitted: number } {
  const all = Array.isArray(content)
    ? content.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "image")
    : [];
  return { refs: all.slice(0, MAX_IMAGE_REFS).map(imageRef), omitted: Math.max(0, all.length - MAX_IMAGE_REFS) };
}

// The one `details` value a tool_result journals: the tool's own bounded details plus the image refs under a reserved key, bounded once more as a
// whole. The refs win over the tool's details when both do not fit (the tool's details become the drop marker), so an image is never unrecorded.
// No images: exactly boundToolDetails(details).
export function detailsWithImages(details: unknown, content: unknown): JsonValue | undefined {
  const { refs, omitted } = imageRefs(content);
  const own = boundToolDetails(details);
  if (refs.length === 0) return own;
  const images = { [IMAGES_KEY]: refs as unknown as JsonValue, ...(omitted > 0 && { [IMAGES_OMITTED_KEY]: omitted }) };
  const base: JsonValue | undefined =
    own !== null && typeof own === "object" && !Array.isArray(own) ? own : own === undefined ? undefined : { [TOOL_DETAILS_KEY]: own };
  const merged = boundToolDetails({ ...base, ...images });
  if (merged !== undefined && !("pomtree_dropped" in (merged as object))) return merged;
  return boundToolDetails({ pomtree_dropped: "oversize", ...images }) as JsonValue;
}
