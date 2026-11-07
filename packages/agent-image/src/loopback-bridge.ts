// In-container loopback bridge: `node /opt/pomtree/loopback-bridge.ts <port>`. Pipes raw bytes between stdin/stdout and
// 127.0.0.1:<port>. The logic and exit codes are in loopback-bridge-core.ts; this shell only wires node:net and the process streams.
import { connect } from "node:net";
import { LOOPBACK_PORTS } from "./container-contract.gen.ts";
import { runBridge } from "./loopback-bridge-core.ts";

const code = await runBridge(process.argv.slice(2), LOOPBACK_PORTS, {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  connect: (port, host) => connect({ port, host }),
});
process.exitCode = code;
// A stdin that never ends (the daemon holds the exec open) must not keep the process alive once the socket side is done.
process.stdin.destroy();
