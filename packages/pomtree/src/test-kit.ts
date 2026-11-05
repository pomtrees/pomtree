import type { Io } from "./cli.ts";
import type { Call, Reply } from "./client.ts";

// A recording Io for driving `run` in tests: every daemon call is captured and answered by `handler`; `extra` overrides any Io field.
export function harness(handler: (c: Call) => Reply | Promise<Reply>, extra: Partial<Io> = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    call: async (c) => (calls.push(c), handler(c)),
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    version: "0.0.0-test",
    ...extra,
  };
  return { calls, out, err, io };
}
