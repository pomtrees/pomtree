// The in-container reader of the PTREE_CONFIG_JSON document. This file has no imports and only erasable TypeScript: it is
// copied verbatim into every generated container-contract.gen.ts (container-gen.ts), so the code tested here is the code the
// image runs. Fails closed: any doubt about the document is an error, never a fallback to defaults.

export type ContainerParamKind = "bytes" | "count" | "ms" | "micros" | "bool";
export type ContainerRelationOp = "lte" | "gte" | "lt" | "gt";

// One delivered key's contract: its kind, bounds and relations to other delivered keys. Defaults are not part of it.
export interface ContainerParamSpec {
  readonly path: string;
  readonly kind: ContainerParamKind;
  readonly min?: number;
  readonly max?: number;
  readonly relations?: readonly { readonly op: ContainerRelationOp; readonly key: string }[];
}

// What one image expects: the contract digest, the env name, the size cap, the delivered keys (sorted by path) and their
// defaults (used only when the document is absent and not required).
export interface ContainerReadSpec {
  readonly contract: string;
  readonly env: string;
  readonly maxBytes: number;
  readonly params: readonly ContainerParamSpec[];
  readonly defaults: Readonly<Record<string, number | boolean>>;
}

export interface ContainerReadOptions {
  // true: an absent document is an error (the browser worker). false: an absent document yields the defaults (pomtree's wait path).
  readonly required: boolean;
}

export class ContainerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerConfigError";
  }
}

const CONTRACT_RE = /^[0-9a-f]{16}$/;
const RELATION_SYMBOL: Readonly<Record<ContainerRelationOp, string>> = { lte: "<=", gte: ">=", lt: "<", gt: ">" };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const holds = (op: ContainerRelationOp, a: number, b: number): boolean => (op === "lte" ? a <= b : op === "gte" ? a >= b : op === "lt" ? a < b : a > b);

// The canonical text of a document: keys sorted, no whitespace. The producer writes exactly this, and the reader accepts only
// this, which also refuses duplicate keys and any re-encoding.
export function canonicalContainerDoc(contract: string, values: Readonly<Record<string, number | boolean>>): string {
  const sorted: Record<string, number | boolean> = {};
  for (const k of Object.keys(values).sort()) sorted[k] = values[k] as number | boolean;
  return JSON.stringify({ contract, values: sorted });
}

// Parses and validates `raw` (the env value, or undefined when unset) against `spec`. Throws ContainerConfigError naming the
// first problem. The result is frozen and holds exactly the delivered keys.
export function readContainerDoc(raw: string | undefined, spec: ContainerReadSpec, opts: ContainerReadOptions): Readonly<Record<string, number | boolean>> {
  const fail = (why: string): never => {
    throw new ContainerConfigError(`${spec.env}: ${why}`);
  };
  if (raw === undefined) {
    if (opts.required) fail("not set; this process requires the resolved config document from the controller (pomtreed)");
    const out: Record<string, number | boolean> = {};
    for (const p of spec.params) {
      const d = spec.defaults[p.path];
      if (d === undefined) fail(`no default for ${p.path}`);
      out[p.path] = d as number | boolean;
    }
    return Object.freeze(out);
  }
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > spec.maxBytes) fail(`${bytes} bytes exceeds the ${spec.maxBytes}-byte cap`);
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    fail("not valid JSON");
  }
  if (!isRecord(doc)) fail("not a JSON object");
  const top = doc as Record<string, unknown>;
  const keys = Object.keys(top).sort();
  if (keys.length !== 2 || keys[0] !== "contract" || keys[1] !== "values")
    fail(`expected exactly the keys contract and values, got ${keys.join(", ") || "none"}`);
  const contract = top.contract;
  if (typeof contract !== "string" || !CONTRACT_RE.test(contract)) fail("contract must be 16 lowercase hex digits");
  if (contract !== spec.contract)
    fail(
      `agent image contract ${spec.contract} does not match daemon contract ${String(contract)}: the image and the daemon are from different revisions; rebuild the image`,
    );
  if (!isRecord(top.values)) fail("values must be a JSON object");
  const values = top.values as Record<string, unknown>;
  const known = new Set(spec.params.map((p) => p.path));
  for (const k of Object.keys(values)) if (!known.has(k)) fail(`unknown key ${JSON.stringify(k)}`);
  const out: Record<string, number | boolean> = {};
  for (const p of spec.params) {
    if (!Object.hasOwn(values, p.path)) fail(`missing key ${p.path}`);
    const v = values[p.path];
    if (p.kind === "bool") {
      if (typeof v !== "boolean") fail(`${p.path} must be a boolean`);
    } else {
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail(`${p.path} must be a non-negative integer`);
      const n = v as number;
      if (p.min !== undefined && n < p.min) fail(`${p.path}=${n} is below its minimum ${p.min}`);
      if (p.max !== undefined && n > p.max) fail(`${p.path}=${n} is above its maximum ${p.max}`);
    }
    out[p.path] = v as number | boolean;
  }
  for (const p of spec.params) {
    for (const r of p.relations ?? []) {
      const a = out[p.path];
      const b = out[r.key];
      if (typeof a !== "number" || typeof b !== "number") fail(`${p.path} ${r.op} ${r.key} compares non-numbers`);
      if (!holds(r.op, a as number, b as number)) fail(`${p.path}=${String(a)} must be ${RELATION_SYMBOL[r.op]} ${r.key}=${String(b)}`);
    }
  }
  if (raw !== canonicalContainerDoc(contract as string, out)) fail("not in canonical form (keys sorted, no whitespace, no duplicate keys)");
  return Object.freeze(out);
}
