import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { Reconcile } from "./reconcile.ts";

// Drives the orphan-refusal branches of Reconcile with hand-built ports: an empty registry beside one live container and
// one workspace folder, so both refusals journal a host_error against the root. `root()` fails after its first call and
// `record` always rejects, the shape that left the record promise unhandled when the root was resolved inside `.catch(...)`.
const root = { id: "root", generation: 1 } as unknown as AgentRecord;

function make() {
  let rootCalls = 0;
  const recorded: string[] = [];
  const ctx = {
    deps: {
      sandbox: { list: async () => [{ id: "sb1", agent: "ghost", labels: { daemon_epoch: "0" } }] },
      workspace: { list: async () => ["ghost"] },
      registry: { list: async () => [] },
      adoptOrphans: false,
    },
    hub: {
      root: {
        root: async () => {
          if (++rootCalls > 1) throw new Error("root unavailable");
          return root;
        },
      },
    },
    record: async (_r: AgentRecord, payload: { kind: string; message?: string }, key: string) => {
      recorded.push(`${payload.kind}:${key}`);
      throw new Error("journal down");
    },
  };
  const tree = { rootAgentId: async () => "root" };
  const r = new Reconcile(ctx as never, tree as never, {} as never, {} as never, new Map(), "0");
  return { r, recorded, rootCalls: () => rootCalls };
}

for (const which of ["reconcileSandboxes", "reconcileWorktrees"] as const) {
  test(`${which}: a failing record is journalled via host_error with no unhandled rejection even if root() later fails`, async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const errors = console.error;
    console.error = () => {};
    try {
      const { r, recorded, rootCalls } = make();
      await (r as unknown as Record<string, () => Promise<void>>)[which]!();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(rootCalls(), 1, "root resolved once");
      assert.equal(recorded.length, 2, "orphan host_error attempted, then the journal-failure host_error");
      assert.ok(recorded.every((k) => k.startsWith("host_error:")));
      assert.deepEqual(unhandled, []);
    } finally {
      console.error = errors;
      process.off("unhandledRejection", onUnhandled);
    }
  });
}
