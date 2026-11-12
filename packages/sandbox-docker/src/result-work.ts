import { CONFIG_DEFAULTS } from "@pomtree/core";
import { RESULT_WORK_SCRIPT } from "@pomtree/workspace-git";
import type { SpawnFn } from "./docker.ts";

// The in-container program is shared with the exec path (workspace-git). Re-exported for the Docker tests.
export { RESULT_WORK_SCRIPT };

// `maxBytes` defaults to the registry default of push.maxBytes (for embedders that pass none); pomtreed passes its resolved value.
// `binary` is the engine's CLI (the profile's binary); the default keeps the Docker call unchanged.
export async function collectResultWork(
  spawn: SpawnFn,
  container: string,
  opts: { save?: boolean; expectedFingerprint?: string; maxBytes?: number } = {},
  binary = "docker",
) {
  const args = { ...opts, maxBytes: opts.maxBytes ?? CONFIG_DEFAULTS["push.maxBytes"] };
  const child = spawn(binary, ["exec", container, "node", "-e", RESULT_WORK_SCRIPT, JSON.stringify(args)]);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const timeout = setTimeout(() => child.kill(), 150_000);
  timeout.unref?.();
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`result workspace collection failed: ${stderr || `exit ${code}`}`));
    });
  });
  // Avoid an unhandled rejection while a consumer is still reading the stream header.
  void exited.catch(() => {});
  const output = child.stdout[Symbol.asyncIterator]();
  let header = Buffer.alloc(0);
  try {
    for (;;) {
      const next = await output.next();
      if (next.done) {
        await exited;
        throw new Error("result workspace collection returned no header");
      }
      header = Buffer.concat([header, next.value]);
      const end = header.indexOf(10);
      if (end < 0) {
        if (header.length > 4096) throw new Error("invalid result workspace collection header");
        continue;
      }
      if (end > 4096) throw new Error("invalid result workspace collection header");
      const result = JSON.parse(header.subarray(0, end).toString()) as { dirty?: unknown; fingerprint?: unknown; bundle?: unknown };
      if (typeof result.dirty !== "boolean" || typeof result.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(result.fingerprint))
        throw new Error("invalid result workspace collection header");
      if (!result.bundle) {
        await exited;
        return { dirty: result.dirty, fingerprint: result.fingerprint };
      }
      const first = header.subarray(end + 1);
      const stream = (async function* () {
        try {
          if (first.length) yield first;
          for (;;) {
            const next = await output.next();
            if (next.done) break;
            yield next.value as Uint8Array;
          }
          await exited;
        } finally {
          child.kill();
          clearTimeout(timeout);
        }
      })();
      // Async-generator return() does not enter its finally block until next() has run. A
      // deduplicated ingest may never read the bundle, so disposal must also work before next().
      const bundle = {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: () => stream.next(),
        async return() {
          child.kill();
          clearTimeout(timeout);
          return stream.return(undefined);
        },
      };
      return { dirty: result.dirty, fingerprint: result.fingerprint, bundle };
    }
  } catch (error) {
    child.kill();
    clearTimeout(timeout);
    throw error;
  }
}
