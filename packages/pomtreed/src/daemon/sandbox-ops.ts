import type { HostId, SandboxId, SandboxOwner } from "@pomtree/core";

// Pure helpers for the Sandbox port's keyed and owner-scoped calls.

// The idempotency key of a stop or kill. A sandbox id comes from one `start` (itself keyed `${agent}:${generation}:start`), so
// the id plus the operation names the operation without a random part, and a retry or restart repeats the same key.
export function sandboxOpKey(op: "stop" | "kill", sandbox: SandboxId): string {
  return `sandbox:${sandbox}:${op}`;
}

// The owner `list` and `reclaim` scope to: this daemon's host, store and epoch, the values main.ts hands the Docker adapter.
// `storeId` is "" when the deps carry none (a test daemon); `epoch` is the daemon's boot epoch (a millisecond timestamp string).
export function sandboxOwner(deps: { hostId: HostId; storeId?: string }, epoch: string): SandboxOwner {
  // A non-numeric epoch would give NaN, and every "newer epoch" comparison against NaN is false, silently disabling the exclusion.
  if (!/^\d+$/.test(epoch) || !Number.isSafeInteger(Number(epoch))) {
    throw new Error(
      `daemon epoch ${JSON.stringify(epoch)} is not a non-negative integer, so sandboxes cannot be scoped to it; restart the daemon so it takes a fresh millisecond-timestamp epoch`,
    );
  }
  return { host: deps.hostId, storeId: deps.storeId ?? "", epoch: Number(epoch) };
}
