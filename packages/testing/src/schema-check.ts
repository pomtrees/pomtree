import { isDeepStrictEqual } from "node:util";

// A validator for the small JSON-schema subset the vendored provider schemas use (no dependency). Supported keywords: type (one name or a list of
// object | array | string | number | integer | boolean | null), properties, required, additionalProperties (false, or a schema), items, enum, const.
// Anything else in a schema is rejected by name, so a schema never silently checks less than it appears to. Pure: no fs or network.

export type Schema = {
  readonly type?: SchemaType | readonly SchemaType[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | Schema;
  readonly items?: Schema;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
};
export type SchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export type SchemaFailure = { readonly path: string; readonly message: string };

const KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const"]);

const kindOf = (v: unknown): SchemaType | "undefined" =>
  v === null
    ? "null"
    : Array.isArray(v)
      ? "array"
      : typeof v === "object"
        ? "object"
        : typeof v === "string"
          ? "string"
          : typeof v === "boolean"
            ? "boolean"
            : typeof v === "number"
              ? Number.isInteger(v)
                ? "integer"
                : "number"
              : "undefined";

const typeOk = (want: SchemaType, got: SchemaType | "undefined"): boolean => want === got || (want === "number" && got === "integer");

const join = (path: string, key: string | number): string => (typeof key === "number" ? `${path}[${key}]` : `${path}.${key}`);

// Returns every failure (empty when the value conforms). Each message names the path, the cause and what to change: the body or the schema.
export function checkSchema(value: unknown, schema: Schema, path = "$"): SchemaFailure[] {
  const out: SchemaFailure[] = [];
  const fail = (p: string, message: string) => out.push({ path: p, message });
  for (const k of Object.keys(schema)) {
    if (!KEYWORDS.has(k))
      fail(path, `schema keyword "${k}" is outside the supported subset; remove it from the schema or extend schema-check.ts and its tests`);
  }
  const got = kindOf(value);
  if (schema.type !== undefined) {
    const want = typeof schema.type === "string" ? [schema.type] : schema.type;
    if (!want.some((w) => typeOk(w, got))) {
      fail(path, `expected type ${want.join(" | ")} but got ${got}; fix the body, or the schema if the provider really sends this`);
      return out;
    }
  }
  if ("const" in schema && !isDeepStrictEqual(value, schema.const)) {
    fail(
      path,
      `expected the constant ${JSON.stringify(schema.const)} but got ${JSON.stringify(value)}; fix the body, or change the schema if the provider documents another value`,
    );
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => isDeepStrictEqual(e, value))) {
    fail(
      path,
      `value ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}; use a documented value or add this one to the schema if the provider documents it`,
    );
  }
  if (got === "object") {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) {
      if (!Object.hasOwn(obj, r))
        fail(
          join(path, r),
          `missing required field "${r}"; add it to the body, or drop it from the schema's required list if the provider documents it as optional`,
        );
    }
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties !== undefined && Object.hasOwn(schema.properties, k) ? schema.properties[k] : undefined;
      if (sub !== undefined) out.push(...checkSchema(v, sub, join(path, k)));
      else if (schema.additionalProperties === false) {
        fail(
          join(path, k),
          `unexpected field "${k}" is not in the provider schema; remove it from the body; if it is real, check the provider's official reference and add it to the schema`,
        );
      } else if (typeof schema.additionalProperties === "object") out.push(...checkSchema(v, schema.additionalProperties, join(path, k)));
    }
  }
  if (got === "array" && schema.items !== undefined) {
    const items = schema.items;
    for (const [i, v] of (value as unknown[]).entries()) out.push(...checkSchema(v, items, join(path, i)));
  }
  return out;
}

// Throws one Error listing every failure, for use in tests that just want a pass or a named failure.
export function assertSchema(value: unknown, schema: Schema, what: string): void {
  const f = checkSchema(value, schema);
  if (f.length > 0) throw new Error(`${what} does not match its provider schema:\n${f.map((x) => `  ${x.path}: ${x.message}`).join("\n")}`);
}
