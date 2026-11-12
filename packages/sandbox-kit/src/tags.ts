// Tag codec for provider metadata, shared by every hosted adapter. Pure.
//
// Rule: a value is stored as-is when the backend accepts it; a value that is too long,
// uses an illegal character, or starts with `h.` is stored as `h.<first 40 hex of sha256(value)>`, with the full value kept
// in a non-selectable annotation. Selectors always use the encoded form. A value that legitimately starts with `h.` is
// encoded too, so `h.` always means "hashed" and decoding is unambiguous.
//
// Two placements: `metadata` (tags are provider labels plus annotations) and `name-encoded` (the provider has no metadata, so
// the owner fields live in the resource name).
//
// Hashed fields cannot be decoded: a name field that is not plain for the backend is stored as `h.<40 hex>`, which is one
// way. So `list(owner)` in name-encoded mode must match by RE-ENCODING the owner's fields (`encodeName` or `matchesField`)
// and comparing, never by reading values back out of a name.

import { createHash } from "node:crypto";

export const HASH_PREFIX = "h.";
const HASH_HEX_LENGTH = 40;
// Annotation key prefix for the full value of a hashed tag; a backend may override it.
export const DEFAULT_ANNOTATION_PREFIX = "pomtree.dev/tag.";

export class TagCodecError extends Error {
  override name = "TagCodecError";
}

// What one backend accepts as a tag value.
export interface TagLimits {
  maxValueLength: number;
  // Matches a whole legal value (anchor it).
  valuePattern: RegExp;
}

// Kubernetes label values: up to 63 characters of [A-Za-z0-9._-], starting and ending alphanumeric.
export const KUBERNETES_TAG_LIMITS: TagLimits = { maxValueLength: 63, valuePattern: /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/ };
// Kubernetes object names (DNS subdomain): up to 253 characters, lowercase alphanumerics, `-` and `.`. The 63-character limit
// applies to label values only.
export const KUBERNETES_NAME_LIMITS: NameLimits = { maxLength: 253, pattern: /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/ };
// A permissive default for providers with free-form metadata (E2B, Fly): printable, up to 256 characters.
export const FREEFORM_TAG_LIMITS: TagLimits = { maxValueLength: 256, valuePattern: /^[\x21-\x7e]+$/ };

export const hashValue = (value: string): string => `${HASH_PREFIX}${createHash("sha256").update(value).digest("hex").slice(0, HASH_HEX_LENGTH)}`;

export const isHashedValue = (encoded: string): boolean => encoded.startsWith(HASH_PREFIX);

export interface EncodedValue {
  encoded: string;
  // The full value, present only when `encoded` is a hash; the caller stores it in an annotation.
  annotation?: string;
}

export function encodeTagValue(value: string, limits: TagLimits): EncodedValue {
  if (value.length === 0) throw new TagCodecError("tag value is empty; pass a non-empty value (an unset tag is omitted, not stored empty)");
  const legal = value.length <= limits.maxValueLength && limits.valuePattern.test(value) && !isHashedValue(value);
  return legal ? { encoded: value } : { encoded: hashValue(value), annotation: value };
}

export interface EncodedTags {
  labels: Record<string, string>;
  // Keyed `<annotationPrefix><tagKey>`, only for hashed values.
  annotations: Record<string, string>;
}

export function encodeTags(tags: Readonly<Record<string, string>>, limits: TagLimits, annotationPrefix = DEFAULT_ANNOTATION_PREFIX): EncodedTags {
  const labels: Record<string, string> = {};
  const annotations: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    const e = encodeTagValue(value, limits);
    labels[key] = e.encoded;
    if (e.annotation !== undefined) annotations[`${annotationPrefix}${key}`] = e.annotation;
  }
  return { labels, annotations };
}

// The label selector for a lookup: the encoded form, so it matches only what encodeTags wrote.
export function tagSelector(tags: Readonly<Record<string, string>>, limits: TagLimits): Record<string, string> {
  return encodeTags(tags, limits).labels;
}

// Reads tags back. A hashed label whose annotation is missing or does not hash to the label is `unresolved` (reported by the
// caller as foreign or damaged, never trusted).
export function decodeTags(
  labels: Readonly<Record<string, string>>,
  annotations: Readonly<Record<string, string>>,
  annotationPrefix = DEFAULT_ANNOTATION_PREFIX,
): { tags: Record<string, string>; unresolved: string[] } {
  const tags: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const [key, label] of Object.entries(labels)) {
    if (!isHashedValue(label)) {
      tags[key] = label;
      continue;
    }
    const full = annotations[`${annotationPrefix}${key}`];
    if (full !== undefined && hashValue(full) === label) tags[key] = full;
    else unresolved.push(key);
  }
  return { tags, unresolved };
}

// ---- name-encoded mode ----

export interface NameLimits {
  maxLength: number;
  // Matches a whole legal name (anchor it).
  pattern: RegExp;
}

export interface NameSchema {
  // The pomtree prefix that marks a resource as ours; lowercase alphanumerics only.
  prefix: string;
  // Ordered field names, e.g. ["host", "generation", "sandbox"]. Order and count are part of the name format.
  fields: readonly string[];
  limits: NameLimits;
}

const SEPARATOR = "-";
const FIELD_OK = /^[A-Za-z0-9]+$/;

function checkSchema(s: NameSchema): void {
  if (!/^[a-z0-9]+$/.test(s.prefix)) throw new TagCodecError(`name prefix "${s.prefix}" must be lowercase alphanumeric; fix the adapter's name schema`);
  if (s.fields.length === 0) throw new TagCodecError("name schema has no fields; list the owner fields to encode");
}

// A field is plain when it is purely alphanumeric (so it cannot contain the separator or look hashed) and the backend's own
// name pattern accepts it (a lowercase-only backend hashes "AB12"); otherwise it is hashed. The field names are not in the
// name; their order is.
export function encodeField(schema: NameSchema, value: string): string {
  return FIELD_OK.test(value) && schema.limits.pattern.test(value) ? value : hashValue(value);
}

export function encodeName(schema: NameSchema, values: Readonly<Record<string, string>>): string {
  checkSchema(schema);
  const parts = schema.fields.map((f) => {
    const v = values[f];
    if (v === undefined || v === "") throw new TagCodecError(`name field "${f}" is missing; pass every field of the schema (${schema.fields.join(", ")})`);
    return encodeField(schema, v);
  });
  const name = [schema.prefix, ...parts].join(SEPARATOR);
  if (name.length > schema.limits.maxLength || !schema.limits.pattern.test(name)) {
    throw new TagCodecError(
      `encoded name is ${name.length} characters or has illegal characters for this backend (limit ${schema.limits.maxLength}); shorten the prefix or drop a field from the schema`,
    );
  }
  return name;
}

// Returns each field's ENCODED form (plain value or `h.<hex>`). Compare against `encodeTagValue`-style hashing of the
// expected value with `matchesField`. A name with a foreign prefix or the wrong shape is rejected: the caller treats the
// resource as foreign, never adopts or kills it.
export function decodeName(schema: NameSchema, name: string): Record<string, string> {
  checkSchema(schema);
  const parts = name.split(SEPARATOR);
  if (parts[0] !== schema.prefix) {
    throw new TagCodecError(
      `name "${name.slice(0, 80)}" does not start with the prefix "${schema.prefix}-"; it is foreign, so report it and do not adopt or delete it`,
    );
  }
  if (parts.length !== schema.fields.length + 1 || parts.slice(1).some((p) => p === "" || !(FIELD_OK.test(p) || /^h\.[0-9a-f]{40}$/.test(p)))) {
    throw new TagCodecError(
      `name "${name.slice(0, 80)}" has the prefix "${schema.prefix}-" but not the expected ${schema.fields.length} fields; treat it as damaged, do not adopt or delete it`,
    );
  }
  const out: Record<string, string> = {};
  schema.fields.forEach((f, i) => {
    out[f] = parts[i + 1] as string;
  });
  return out;
}

// True when a decoded field (plain or hashed) is the encoding of `expected`.
export function matchesField(schema: NameSchema, decoded: string, expected: string): boolean {
  return decoded === encodeField(schema, expected);
}
