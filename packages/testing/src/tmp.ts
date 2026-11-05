import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs = new Set<string>();
let hooked = false;

function cleanup(): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

// Make a temp dir under os.tmpdir() that is removed when the test process exits (node:test runs each file in its own process)
// or is terminated by SIGINT/SIGTERM/SIGHUP (the 'exit' event does not fire for those, which leaked dirs on Ctrl-C and timeouts).
export function tmpDir(prefix: string): string {
  if (!hooked) {
    hooked = true;
    process.on("exit", cleanup);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const onSignal = () => {
        cleanup();
        process.off(sig, onSignal);
        process.kill(process.pid, sig);
      };
      process.on(sig, onSignal);
    }
  }
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.add(d);
  return d;
}
