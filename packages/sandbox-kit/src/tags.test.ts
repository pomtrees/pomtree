import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ownerStampTags, readOwnerStamp } from "@pomtree/core";
import {
  DEFAULT_ANNOTATION_PREFIX,
  FREEFORM_TAG_LIMITS,
  KUBERNETES_NAME_LIMITS,
  KUBERNETES_TAG_LIMITS,
  TagCodecError,
  decodeName,
  decodeTags,
  encodeName,
  encodeTagValue,
  encodeTags,
  matchesField,
  tagSelector,
} from "./tags.ts";

const sha40 = (v: string) => `h.${createHash("sha256").update(v).digest("hex").slice(0, 40)}`;
const SCHEMA = { prefix: "pomtree", fields: ["host", "generation", "sandbox"], limits: { maxLength: 63, pattern: /^[a-z0-9][a-z0-9.-]*$/ } } as const;

test("tags: a legal value is stored as-is, with no annotation", () => {
  assert.deepEqual(encodeTagValue("agent-7.ok_1", KUBERNETES_TAG_LIMITS), { encoded: "agent-7.ok_1" });
});

test("tags: an over-limit value is hashed to h.<40 hex> and the full value is kept", () => {
  const long = "a".repeat(64);
  assert.deepEqual(encodeTagValue(long, KUBERNETES_TAG_LIMITS), { encoded: sha40(long), annotation: long });
  assert.equal(encodeTagValue("a".repeat(63), KUBERNETES_TAG_LIMITS).encoded, "a".repeat(63), "exactly at the limit is legal");
});

test("tags: an illegal character, or a non-alphanumeric edge, is hashed", () => {
  for (const v of ["has space", "a/b", "-lead", "trail."]) assert.equal(encodeTagValue(v, KUBERNETES_TAG_LIMITS).encoded, sha40(v), v);
});

test("tags: a value that starts with h. is hashed even though it would be legal", () => {
  const e = encodeTagValue("h.looks-hashed", KUBERNETES_TAG_LIMITS);
  assert.deepEqual(e, { encoded: sha40("h.looks-hashed"), annotation: "h.looks-hashed" });
});

test("tags: an empty value is refused with an action", () => {
  assert.throws(() => encodeTagValue("", KUBERNETES_TAG_LIMITS), /empty.*omitted/);
});

test("tags: selectors use the encoded form and match only it", () => {
  const long = "x".repeat(300);
  const { labels } = encodeTags({ "pomtree.host": long }, KUBERNETES_TAG_LIMITS);
  assert.deepEqual(tagSelector({ "pomtree.host": long }, KUBERNETES_TAG_LIMITS), { "pomtree.host": sha40(long) });
  assert.notEqual(tagSelector({ "pomtree.host": long }, KUBERNETES_TAG_LIMITS)["pomtree.host"], long, "the raw value is never the selector");
  assert.equal(labels["pomtree.host"], sha40(long));
});

test("tags: the same value is plain on a permissive backend and hashed on a strict one", () => {
  const v = "a".repeat(100);
  assert.equal(encodeTagValue(v, FREEFORM_TAG_LIMITS).encoded, v);
  assert.equal(encodeTagValue(v, KUBERNETES_TAG_LIMITS).encoded, sha40(v));
});

test("tags: metadata round trip restores hashed values from annotations", () => {
  const tags = { "pomtree.sandbox": "s".repeat(64), "pomtree.generation": "3" };
  const { labels, annotations } = encodeTags(tags, KUBERNETES_TAG_LIMITS);
  assert.deepEqual(Object.keys(annotations), [`${DEFAULT_ANNOTATION_PREFIX}pomtree.sandbox`]);
  assert.deepEqual(decodeTags(labels, annotations), { tags, unresolved: [] });
});

test("tags: a hashed label with a missing or wrong annotation is unresolved, not trusted", () => {
  const { labels, annotations } = encodeTags({ k: "y".repeat(80) }, KUBERNETES_TAG_LIMITS);
  assert.deepEqual(decodeTags(labels, {}), { tags: {}, unresolved: ["k"] });
  const forged = { [`${DEFAULT_ANNOTATION_PREFIX}k`]: "z".repeat(80) };
  assert.deepEqual(decodeTags(labels, forged), { tags: {}, unresolved: ["k"] });
  assert.equal(Object.keys(annotations).length, 1);
});

test("tags: name-encoded round trip, with a long host hashed", () => {
  const host = "host.example.com";
  const name = encodeName(SCHEMA, { host, generation: "12", sandbox: "ab12" });
  assert.equal(name, `pomtree-${sha40(host)}-12-ab12`);
  const d = decodeName(SCHEMA, name);
  assert.ok(matchesField(SCHEMA, d.host as string, host));
  assert.ok(!matchesField(SCHEMA, d.host as string, "other.example.com"));
  assert.equal(d.generation, "12");
});

test("tags: the name-encoded decoder rejects a foreign prefix", () => {
  assert.throws(
    () => decodeName(SCHEMA, "otherapp-1-2-3"),
    (e) => e instanceof TagCodecError && /foreign/.test(e.message) && /do not adopt or delete/.test(e.message),
  );
  // negative control: the same shape under our prefix decodes
  assert.doesNotThrow(() => decodeName(SCHEMA, "pomtree-1-2-3"));
});

test("tags: a name with our prefix but the wrong shape is rejected as damaged", () => {
  assert.throws(() => decodeName(SCHEMA, "pomtree-1-2"), /expected 3 fields/);
  assert.throws(() => decodeName(SCHEMA, "pomtree-1--3"), /expected 3 fields/);
  assert.throws(() => decodeName(SCHEMA, "pomtree-1-2-3-4"), /expected 3 fields/);
  assert.throws(() => decodeName(SCHEMA, "pomtree-1-2-h.zz"), /expected 3 fields/);
});

test("tags: an encoded name over the backend limit or with a missing field is refused with an action", () => {
  assert.throws(
    () => encodeName({ ...SCHEMA, limits: { ...SCHEMA.limits, maxLength: 30 } }, { host: "h.x", generation: "1", sandbox: "2" }),
    /shorten the prefix or drop a field/,
  );
  assert.throws(() => encodeName(SCHEMA, { host: "a", generation: "1" }), /field "sandbox" is missing/);
  assert.throws(() => encodeName({ ...SCHEMA, prefix: "Bad-Prefix" }, { host: "a", generation: "1", sandbox: "2" }), /lowercase alphanumeric/);
});

test("tags: an uppercase field on a lowercase-only backend is hashed, not thrown on, and re-encoding matches it", () => {
  const wide = { ...SCHEMA, limits: { ...SCHEMA.limits, maxLength: 253 } };
  const name = encodeName(wide, { host: "HostA", generation: "1", sandbox: "AB12" });
  assert.equal(name, `pomtree-${sha40("HostA")}-1-${sha40("AB12")}`);
  const d = decodeName(wide, name);
  assert.ok(matchesField(wide, d.host as string, "HostA"));
  assert.ok(!matchesField(wide, d.host as string, "hosta"));
  // a backend whose pattern accepts uppercase keeps it readable
  const mixed = { ...SCHEMA, limits: { maxLength: 63, pattern: /^[A-Za-z0-9][A-Za-z0-9.-]*$/ } };
  assert.equal(encodeName(mixed, { host: "HostA", generation: "1", sandbox: "x" }), "pomtree-HostA-1-x");
});

test("tags: KUBERNETES_NAME_LIMITS allow 253 characters and a pomtree-<64 hex> name", () => {
  const schema = { prefix: "pomtree", fields: ["sandbox"], limits: KUBERNETES_NAME_LIMITS };
  assert.equal(KUBERNETES_NAME_LIMITS.maxLength, 253);
  const hex = "a1".repeat(32);
  assert.doesNotThrow(() => encodeName(schema, { sandbox: hex }));
  assert.equal(encodeName(schema, { sandbox: "Z" }), `pomtree-${sha40("Z")}`, "uppercase is hashed against the lowercase-only pattern");
});

test("the owner stamp survives every provider's limits: a long or unsafe host is hashed on write and read back whole, a bad one is refused", () => {
  for (const limits of [KUBERNETES_TAG_LIMITS, FREEFORM_TAG_LIMITS]) {
    for (const host of ["host-a", "h".repeat(300), "host & a=b%", "h.looks-hashed"]) {
      const enc = encodeTags(ownerStampTags({ host, generation: 12 }), limits);
      for (const v of Object.values(enc.labels)) assert.ok(v.length <= limits.maxValueLength, `${host.slice(0, 12)}: ${v.length}`);
      const dec = decodeTags(enc.labels, enc.annotations);
      assert.deepEqual(dec.unresolved, []);
      assert.deepEqual(readOwnerStamp(dec.tags), { host, generation: 12 });
    }
  }
  // A hashed host whose annotation is lost does not decode: the stamp reads null, so the sandbox is never adopted.
  const enc = encodeTags(ownerStampTags({ host: "h".repeat(300), generation: 1 }), KUBERNETES_TAG_LIMITS);
  const lost = decodeTags(enc.labels, {});
  assert.deepEqual(lost.unresolved, ["pomtree.host"]);
  assert.deepEqual(readOwnerStamp(lost.tags), { host: null, generation: 1 });
  assert.throws(() => encodeTags(ownerStampTags({ host: "", generation: 1 }), KUBERNETES_TAG_LIMITS), /host id/);
});
