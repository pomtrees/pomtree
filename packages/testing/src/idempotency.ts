import { randomUUID } from "node:crypto";

// What a real client does (`pomtree` issues a key per invocation): a mutating call from a test helper carries a fresh idempotency key unless the
// test names one. Tests of the key requirement itself call handle() directly.
export const keyed = (method: string, body?: unknown): unknown => {
  if (method === "GET" || (body !== undefined && (typeof body !== "object" || body === null || Array.isArray(body) || ArrayBuffer.isView(body)))) return body;
  const b = (body ?? {}) as Record<string, unknown>;
  return "idempotencyKey" in b ? body : { ...b, idempotencyKey: randomUUID() };
};
