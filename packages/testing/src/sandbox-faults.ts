// Fault plan for the one shared sandbox fake (FakeSandbox): an ordered list of one-shot faults keyed by operation. Pure data and
// logic, no fs or network, so it is unit-testable on its own. Every fault surfaces through an error class the port defines
// (SandboxOutcomeUnknownError, SandboxTransferError, SandboxUnavailableError, or the caller's own Error for kind "error").
import type { Sandbox, SandboxHandle, SandboxId, SandboxOwner, SandboxSpec } from "@pomtree/core";
import { SandboxUnavailableError } from "@pomtree/core";

// Sandbox ids: by default FakeSandbox names sandboxes sbx-1, sbx-2, ... because older tests assert on those. With `derivedIds` (implied
// by `remote`) the id is sandboxIdForKey(idempotencyKey), as the port specifies. Either way a SandboxOutcomeUnknownError carries the id
// that a retry with the same key gets (in the default mode exact only if no other sandbox is created in between).

export type FaultOp = "start" | "stop" | "kill" | "list" | "inspect" | "wait" | "probe" | "files.put" | "files.get" | "connect";

export type SandboxFault =
  | { kind: "error"; error: Error } // the call rejects with this error
  | { kind: "timeout" } // the call never settles until plan.release(), then rejects with SandboxUnavailableError("provider-outage")
  | { kind: "preempt" } // the sandbox is taken away by the provider: wait() rejects, inspect() reports "preempted", channels error
  | { kind: "partial"; afterBytes: number } // a transfer ends early after this many bytes: SandboxTransferError "partial", nothing accepted
  | { kind: "hash-mismatch" } // a transfer's sha256 does not match: SandboxTransferError "hash-mismatch", nothing accepted
  | { kind: "unknown-outcome"; applied: boolean } // start throws SandboxOutcomeUnknownError; the sandbox exists iff applied
  | { kind: "duplicate-key" } // start is delivered twice with the same key; the second delivery must not create a second sandbox
  | { kind: "drop"; afterBytes: number }; // a connect channel's stream breaks after this many output bytes

// The operations each fault kind can attach to; anything else is a mistake in the test and is refused when the fault is added.
const ALLOWED: Record<SandboxFault["kind"], readonly FaultOp[]> = {
  error: ["start", "stop", "kill", "list", "inspect", "wait", "probe", "files.put", "files.get", "connect"],
  timeout: ["start", "stop", "kill", "list", "inspect", "wait", "probe", "files.put", "files.get", "connect"],
  preempt: ["start", "inspect", "wait"],
  partial: ["files.put", "files.get"],
  "hash-mismatch": ["files.put", "files.get"],
  "unknown-outcome": ["start"],
  "duplicate-key": ["start"],
  drop: ["connect"],
};

// Which selector fields can ever match each operation: `key` is the call's idempotency key, `id` its sandbox id. A selector outside
// this set would never match, so the fault would never fire; add() refuses it.
const SELECTORS: Record<FaultOp, readonly (keyof FaultSelector)[]> = {
  start: ["key"],
  stop: ["key", "id"],
  kill: ["key", "id"],
  "files.put": ["key", "id"],
  inspect: ["id"],
  wait: ["id"],
  "files.get": ["id"],
  connect: ["id"],
  list: [],
  probe: [],
};

// A fault applies to the first matching call of its operation; `key` matches the call's idempotency key and `id` its sandbox id.
export interface FaultSelector {
  key?: string;
  id?: SandboxId;
}

export interface PlannedFault {
  op: FaultOp;
  fault: SandboxFault;
  selector: FaultSelector;
}

export class FaultPlan {
  private planned: { entry: PlannedFault; fired: boolean }[] = [];
  private held: { resolve: () => void; op: FaultOp }[] = [];
  private released = false;

  constructor(faults: { op: FaultOp; fault: SandboxFault; selector?: FaultSelector }[] = []) {
    for (const f of faults) this.add(f.op, f.fault, f.selector);
  }

  // Appends a one-shot fault. Throws when the fault kind cannot attach to the operation.
  add(op: FaultOp, fault: SandboxFault, selector: FaultSelector = {}): this {
    if (!ALLOWED[fault.kind].includes(op)) {
      throw new Error(
        `fault kind "${fault.kind}" cannot attach to operation "${op}" (it applies to: ${ALLOWED[fault.kind].join(", ")}); plan it on one of those operations`,
      );
    }
    for (const field of Object.keys(selector) as (keyof FaultSelector)[]) {
      if (selector[field] !== undefined && !SELECTORS[op].includes(field)) {
        throw new Error(
          `selector "${field}" can never match operation "${op}" (allowed selectors: ${SELECTORS[op].join(", ") || "none"}); the fault would never fire, so select by one of those`,
        );
      }
    }
    this.planned.push({ entry: { op, fault, selector: { ...selector } }, fired: false });
    return this;
  }

  // Consumes and returns the first unfired fault for this operation whose selector matches the call; undefined when none.
  // Faults of one operation fire strictly in the order they were added, each once.
  take(op: FaultOp, call: { key?: string; id?: SandboxId } = {}): SandboxFault | undefined {
    for (const p of this.planned) {
      if (p.fired || p.entry.op !== op) continue;
      const { key, id } = p.entry.selector;
      if (key !== undefined && key !== call.key) continue;
      if (id !== undefined && id !== call.id) continue;
      p.fired = true;
      return p.entry.fault;
    }
    return undefined;
  }

  // Faults that have not fired yet, in plan order.
  pending(): PlannedFault[] {
    return this.planned.filter((p) => !p.fired).map((p) => p.entry);
  }

  // Faults that have fired, in plan order.
  fired(): PlannedFault[] {
    return this.planned.filter((p) => p.fired).map((p) => p.entry);
  }

  // Throws naming every unfired fault: a fault planned for a call that never happened is a test that proved nothing.
  assertSpent(): void {
    const left = this.pending();
    if (left.length === 0) return;
    const names = left.map((p) => `${p.fault.kind} on ${p.op}${describeSelector(p.selector)}`).join("; ");
    throw new Error(
      `${left.length} planned sandbox fault(s) never fired: ${names}; the code under test did not make that call, so fix the test's plan or the call it expects`,
    );
  }

  // The never-settling call of a timeout fault: pending until release(), then rejects as an unreachable provider.
  hold(op: FaultOp): Promise<never> {
    if (this.released) return Promise.reject(timeoutError(op));
    return new Promise<never>((_, reject) => {
      this.held.push({ op, resolve: () => reject(timeoutError(op)) });
    });
  }

  // Settles every timed-out call so far (and any later one) with its rejection; tests call it to finish a held call.
  release(): void {
    this.released = true;
    for (const h of this.held.splice(0)) h.resolve();
  }

  // Number of timed-out calls still waiting for release().
  get heldCount(): number {
    return this.held.length;
  }
}

function describeSelector(s: FaultSelector): string {
  const parts = [s.key !== undefined ? `key ${s.key}` : "", s.id !== undefined ? `id ${s.id}` : ""].filter(Boolean);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

function timeoutError(op: FaultOp): SandboxUnavailableError {
  return new SandboxUnavailableError("provider-outage", `sandbox ${op} timed out (injected fault); retry the call or treat the backend as unreachable`);
}

// The error a preempted sandbox's wait() and open channels report.
export function preemptedError(id: SandboxId): SandboxUnavailableError {
  return new SandboxUnavailableError(
    "provider-outage",
    `sandbox ${id} was preempted by the provider (injected fault); start a replacement with a new idempotency key`,
  );
}

// Conformance-style check for start idempotency: the same key twice returns the same sandbox and leaves exactly one in the
// backend's list. A backend that ignores the key creates a second sandbox and fails here with the cause and the action.
export async function assertStartIdempotent(sandbox: Sandbox, spec: SandboxSpec, key: string, owner: SandboxOwner): Promise<SandboxHandle> {
  const first = await sandbox.start(spec, key);
  const second = await sandbox.start(spec, key);
  if (first.id !== second.id) {
    throw new Error(
      `start with idempotency key ${key} returned sandbox ${first.id} and then ${second.id}; a repeated key must return the same sandbox, so make the backend derive the sandbox from the key`,
    );
  }
  const count = (await sandbox.list(owner)).filter((l) => l.agent === spec.agent).length;
  if (count !== 1) {
    throw new Error(
      `start with idempotency key ${key} twice left ${count} sandboxes for agent ${spec.agent} instead of 1; a repeated key must not create a second sandbox, so make the backend deduplicate by key`,
    );
  }
  return first;
}
