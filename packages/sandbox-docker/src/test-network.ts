// Test helper: the inspect answer of a correct shared egress network, and a fake-exec wrapper that serves it so the
// run-path unit tests keep their recorded call logs unchanged (the network decision has its own tests).
import { DockerSandbox, type DockerDeps, type Exec } from "./docker.ts";
import { EGRESS_LABEL } from "./args.ts";
import { EGRESS_NETWORK_ROLE_LABEL, ICC_OPTION } from "./network.ts";

export const OK_EGRESS_NETWORK = JSON.stringify({
  Name: "pomtree-egress",
  Driver: "bridge",
  Internal: false,
  Options: { [ICC_OPTION]: "false" },
  Labels: { [EGRESS_LABEL]: "1", [EGRESS_NETWORK_ROLE_LABEL]: "shared" },
});

export function withEgressNetwork(exec: Exec): Exec {
  return async (args, env) => (args[0] === "network" && args[1] === "inspect" ? OK_EGRESS_NETWORK : exec(args, env));
}

// DockerSandbox over a fake exec that also answers the shared-network inspect (real exec is left untouched).
export class NetSandbox extends DockerSandbox {
  constructor(deps: DockerDeps) {
    super(deps.exec ? { ...deps, exec: withEgressNetwork(deps.exec) } : deps);
  }
}
