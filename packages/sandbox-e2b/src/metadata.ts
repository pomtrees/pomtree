// How pomtree's tags live in E2B sandbox metadata. Pure: no I/O.
//
// E2B stores a string-to-string `metadata` map given at create and filters the list call by it (`GET /v2/sandboxes?metadata=`,
// documented). The filter value is one URL-encoded `key=value&key=value` string, so a value holding `&`, `=` or `%` could not be
// selected exactly. The kit's tag codec stores such a value (and any longer than the limit) as `h.<40 hex>` with the full value in an
// annotation key, so a selector always matches what was written.
//
// Inferred, not documented: E2B's own limits on metadata key and value length and characters. E2B_TAG_LIMITS is a conservative guess
// (listed under "Unverified" in the package README).

import { SANDBOX_TAGS, type SandboxId } from "@pomtree/core";
import { DEFAULT_ANNOTATION_PREFIX, decodeTags, encodeTags, type TagLimits } from "@pomtree/sandbox-kit";

export const BACKEND_ID = "e2b";

// Inferred: 128 characters of letters, digits, `.`, `_`, `:` and `-`, none of which needs escaping in the filter string.
export const E2B_TAG_LIMITS: TagLimits = { maxValueLength: 128, valuePattern: /^[A-Za-z0-9._:-]+$/ };

// Caller labels (SandboxSpec.labels): the port's key rule. Keys starting with "pomtree" are reserved for the tags above.
const LABEL_KEY = /^[A-Za-z0-9_.-]+$/;

export function checkLabels(labels: Readonly<Record<string, string>> | undefined): void {
  for (const [k, v] of Object.entries(labels ?? {})) {
    if (!LABEL_KEY.test(k)) {
      throw new Error(`sandbox label key ${JSON.stringify(k)} is malformed: use only letters, digits, "_", "." and "-"; rename the label`);
    }
    if (k.toLowerCase().startsWith("pomtree")) {
      throw new Error(`sandbox label key ${JSON.stringify(k)} starts with "pomtree", which is reserved for pomtree's own tags; rename the label`);
    }
    if (typeof v !== "string" || v === "") throw new Error(`sandbox label ${k} has an empty value; give it a non-empty string value or drop it`);
  }
}

// The metadata a new sandbox is created with: pomtree's tags (encoded) and their annotations, plus the caller's labels verbatim.
export function sandboxMetadata(id: SandboxId, agent: string, labels: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const enc = encodeTags({ [SANDBOX_TAGS.sandbox]: id, [SANDBOX_TAGS.agent]: agent, [SANDBOX_TAGS.backend]: BACKEND_ID }, E2B_TAG_LIMITS);
  return { ...(labels ?? {}), ...enc.labels, ...enc.annotations };
}

// The selector for one sandbox id, and for every pomtree sandbox of this backend.
export const sandboxSelector = (id: SandboxId): Record<string, string> => encodeTags({ [SANDBOX_TAGS.sandbox]: id }, E2B_TAG_LIMITS).labels;
export const backendSelector = (): Record<string, string> => ({ [SANDBOX_TAGS.backend]: BACKEND_ID });

// The `metadata` query value: `k=v&k=v`, each part URL-encoded; the caller's URL builder encodes the whole string once more.
export function metadataQuery(selector: Readonly<Record<string, string>>): string {
  return Object.entries(selector)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export interface DecodedMetadata {
  // Decoded pomtree tags (sandbox, agent, backend), keyed by the SANDBOX_TAGS names.
  tags: Record<string, string>;
  // Tags whose hashed value had no matching annotation: the sandbox is damaged or foreign and is never adopted.
  unresolved: string[];
  // The caller's labels: every key that does not start with "pomtree".
  labels: Record<string, string>;
}

export function decodeMetadata(metadata: Readonly<Record<string, unknown>> | undefined): DecodedMetadata {
  const tagValues: Record<string, string> = {};
  const annotations: Record<string, string> = {};
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata ?? {})) {
    if (typeof v !== "string") continue;
    if (k.startsWith(DEFAULT_ANNOTATION_PREFIX)) annotations[k] = v;
    else if (k.toLowerCase().startsWith("pomtree")) tagValues[k] = v;
    else labels[k] = v;
  }
  const { tags, unresolved } = decodeTags(tagValues, annotations);
  return { tags, unresolved, labels };
}
