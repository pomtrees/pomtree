// Shared gate for the real-Docker suites: the image must be the one built from a committed revision whose adapter/image sources are unchanged.
// Default `pnpm test` skips these suites, so they drift silently: rerun them (PTREE_DOCKER_TESTS=1, the rebuilt image and its revision)
// at the end of any wave that changes the agent image, browser-run.ts, the browser extension or this adapter's run args.
import { execFileSync } from "node:child_process";
import { after } from "node:test";

export const IMAGE = process.env.PTREE_AGENT_TEST_IMAGE ?? "pomtree/agent:dev";

// IMAGE pinned by its local image id (`sha256:<hex>`), the digest-pinned form DockerSandbox requires for egressProxyImage.
// Call it only once a gate is open (inside a test body or fixture): it runs `docker image inspect` and throws without Docker.
let pinned: string | undefined;
export function pinnedImage(): string {
  pinned ??= execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE], { encoding: "utf8", timeout: 10000 }).trim();
  return pinned;
}
export function gate(): string | false {
  if (process.env.PTREE_DOCKER_TESTS !== "1") return "PTREE_DOCKER_TESTS not set (no Docker execution)";
  const revision = process.env.PTREE_AGENT_TEST_REVISION;
  if (!revision || !/^[0-9a-f]{7,40}$/.test(revision)) return "explicit committed PTREE_AGENT_TEST_REVISION required; no old-image proof";
  let expected: string;
  try {
    expected = execFileSync("git", ["rev-parse", "--short", revision], { encoding: "utf8", timeout: 5000 }).trim();
    execFileSync("git", ["diff", "--quiet", revision, "--", ":(top)packages/agent-image", ":(top)packages/sandbox-docker"], { stdio: "ignore", timeout: 5000 });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", ":(top)packages/agent-image", ":(top)packages/sandbox-docker"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (untracked.trim()) return "commit adapter/image checkpoint before Docker gates; untracked sources are not image proof";
  } catch {
    return "adapter/image source differs from requested committed image revision";
  }
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10000 });
  } catch {
    return "Docker unavailable; network-none/UDS/browser confinement unverified";
  }
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 10000 });
  } catch {
    return `rebuilt ${IMAGE} unavailable; this gate never pulls or builds`;
  }
  try {
    const actual = execFileSync("docker", ["image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}', IMAGE], {
      encoding: "utf8",
      timeout: 10000,
    }).trim();
    if (actual !== expected) return `image revision ${actual || "missing"} does not match approved ${expected}`;
  } catch {
    return "cannot establish rebuilt image revision";
  }
  return false;
}

// Lighter gate for suites that prove a Docker ENGINE property (the shared egress network's ICC-off isolation) rather
// than image confinement: Docker reachable and IMAGE present, without the committed-revision proof, so the suite also
// runs against an uncommitted adapter. It must not be used to claim anything about the image's own sources.
export function engineGate(): string | false {
  if (process.env.PTREE_DOCKER_TESTS !== "1") return "PTREE_DOCKER_TESTS not set (no Docker execution)";
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10000 });
  } catch {
    return "Docker unavailable; egress network isolation unverified";
  }
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 10000 });
  } catch {
    return `${IMAGE} unavailable; this gate never pulls or builds`;
  }
  return false;
}

// Gated suites run their sidecars on a per-process pomtree-test- network, never the production EGRESS_NETWORK (which by
// design outlives every sandbox), and remove it once the file's tests are done.
export function testEgressNetwork(): string {
  const name = `pomtree-test-egress-${process.pid}`;
  if (process.env.PTREE_DOCKER_TESTS === "1")
    after(() => {
      try {
        execFileSync("docker", ["network", "rm", name], { stdio: "ignore", timeout: 20000 });
      } catch {
        /* never created (skipped suite) or already removed */
      }
    });
  return name;
}
