// Shared Sandbox port contract (@pomtree/testing) against the fake always, and against DockerSandbox when the
// real-Docker gate passes (PTREE_DOCKER_TESTS=1, PTREE_AGENT_TEST_REVISION, image PTREE_AGENT_TEST_IMAGE).
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contract, createFakes, sandboxContractBody, type SandboxContractWorld } from "@pomtree/testing";
import { DockerSandbox } from "./docker.ts";
import { IMAGE, pinnedImage, gate, testEgressNetwork } from "./docker-gate.ts";
import { stubMounts } from "./test-mounts.ts";
const egressNetwork = testEgressNetwork();

const roots: string[] = [];
process.on("exit", () => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const sandbox = contract<SandboxContractWorld>("Sandbox", {
  fake: () => createFakes(),
  real: () => {
    // Explicit reason on skip (contract() turns a throw into t.skip with this message).
    const why = gate();
    if (why) throw new Error(why);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-sandbox-contract-")));
    roots.push(root);
    const work = join(root, "work");
    mkdirSync(work, { mode: 0o755 });
    const docker = new DockerSandbox({
      mounts: stubMounts(work),
      egressProxyImage: pinnedImage(),
      egressAuditRoot: join(root, "audit"),
      egressNetwork,
      startRetries: 0,
      startTimeoutMs: 60000,
    });
    return {
      sandbox: docker,
      imageRef: IMAGE,
      workspaceId: "ws-contract",
      // The image's egress worker exits 1 without a command, before the contract can kill it and read 137, so the world supplies a
      // long-lived one.
      cmd: ["sleep", "300"],
    };
  },
});
sandbox("start/list/attach/wait/inspect/kill", sandboxContractBody);
