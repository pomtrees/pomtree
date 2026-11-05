// A scripted tool call that blocks until the test releases it, instead of a fixed `sleep N`: the call must still be running while the test
// kills or restarts pomtreed, and a constant long enough for that is dead time on every other path. The test releases it with `release`.
import { docker } from "./cli-crash.ts";

const FLAG = "/tmp/e2e-release";

// A bash command that returns once `release` has touched the flag inside this container.
export const holdUntilReleased = (then: string): string => `while [ ! -e ${FLAG} ]; do sleep 0.2; done; ${then}`;

// Release the held tool call of each named container (a running agent container, `pomtree-<sandbox id>`).
export async function release(containers: string[]): Promise<void> {
  for (const c of containers) await docker(["exec", c, "touch", FLAG]);
}
