import { randomUUID } from "node:crypto";

// Idempotency key (every mutating call carries one): `--key` if given, to retry a send whose reply
// was lost without duplicating it; else fresh per invocation, so identical intentional messages are not deduplicated.
export function effectiveSendKey(key?: string): string {
  return key ?? randomUUID();
}
