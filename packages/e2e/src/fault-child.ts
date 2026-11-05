// Child process for fault.test.ts: a pomtreed-like process over the real store/workspace that the parent kill -9s.
// argv: repo stateDir count. Holds every agent open (never settles) and prints "ready" once all are running.
import { rig } from "./harness.ts";
import { acquireStateLock } from "@pomtree/pomtreed";

const [repo, stateDir, count] = process.argv.slice(2) as [string, string, string];
acquireStateLock(stateDir);
const r = rig({ repo, stateDir, play: () => ({ hold: new Promise<void>(() => {}), result: { status: "succeeded", result: null } }) });
const root = await r.daemon.root();
for (let i = 0; i < Number(count); i++) {
  void r.daemon.spawn(root.id, { name: `w${i}`, task: "t", idempotencyKey: `w${i}` }).then(() => console.log(`spawned ${i}`));
}
console.log("ready");
setInterval(() => {}, 1000);
