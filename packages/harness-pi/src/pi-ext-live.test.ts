// Gated live verification of the in-image Pi extension loadout (TODO(pi-ext)).
//
// Registration-only check: runs Pi inside the agent image with the loadout's `--extension` flags and a
// trivial prompt, then asserts the initial system message's `toolsAdded` lists web_search and web_fetch.
// The process is stopped as soon as registration is observed, so this makes no model call.
//
// TODO(pi-ext): full tool-invocation check (needs a live model call + a `pomtree ext` verb in packages/pomtree
// to reach the daemon's /v1/ext proxy). Once that lands, run:
//   docker run --rm -v <scoped per-agent auth.json from the model proxy>:/home/node/.pi/agent/auth.json:ro \
//     -e POMTREE_TOKEN=<agent token> -e POMTREE_API=http://host.docker.internal:<agent port> \
//     pomtree/agent:dev pi --mode json --session /tmp/s.jsonl \
//     --extension /opt/pomtree/ext/web_search --extension /opt/pomtree/ext/web_fetch \
//     --provider deepseek --model deepseek-flash \
//     -- "Use web_search to search for pomtree, then stop."
// and assert a tool_execution_start/end record with toolName web_search appears in the JSONL.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gateCommand, runtimeSkip } from "../../sandbox-docker/src/docker-gate.ts";
import { PI_EXT_LOADOUT } from "./index.ts";

const IMAGE = process.env.PTREE_E2E_IMAGE;
const MODELS = join(homedir(), ".pi", "agent", "models-store.json");
const PROVIDER = process.env.POMTREED_PI_PROVIDER;
const MODEL = process.env.PTREE_LIVE_MODEL ?? "deepseek-flash";

// Runs the gate's engine CLI (docker or podman, per PTREE_SANDBOX_BACKEND) against the engine's verified socket.
const ok = (args: string[]): boolean => {
  try {
    const c = gateCommand(args, { stdio: "ignore" as const, timeout: 10_000 });
    return spawnSync(c.file, c.args, c.options).status === 0;
  } catch {
    return false;
  }
};

// TODO(pi-ext-live-stale): this test runs the image directly with no egress sidecar, and the image's egress worker (/opt/pomtree/egress/worker.ts) exits with
// "egress socket unavailable", so it fails on Docker as well (identical on the code before the engine threading). Under Podman it fails earlier on
// `--tmpfs ...:uid=1000,gid=1000` ("unknown mount option"). Current behavior: CI keeps it skipped (scripts/ci/skip-guard.py) and it fails when run with an image and a provider.
function skipReason(): string | false {
  const early = runtimeSkip("docker daemon unreachable");
  if (early) return early;
  const missing: string[] = [];
  if (!IMAGE) {
    missing.push("PTREE_E2E_IMAGE unset");
  } else {
    if (!ok(["info"])) missing.push("container engine unreachable");
    if (!ok(["image", "inspect", IMAGE])) missing.push(`image ${IMAGE} not present`);
  }
  if (!PROVIDER) missing.push("POMTREED_PI_PROVIDER unset (the provider the throwaway credential is written for)");
  return missing.length ? missing.join("; ") : false;
}

// Streams `<engine> run --rm <image> pi ... -- "<prompt>"` and resolves with the toolsAdded names from the
// first system message_end; the child is then stopped (no model call). Returns null when the process
// exits before a system message (e.g. provider auth failure), so the caller reports a clear reason.
// The credential is a throwaway placeholder written to a temp dir (the operator's Pi login is never mounted); the run stops
// before any model call, so the placeholder is never presented to a provider.
function registeredTools(timeoutMs: number, auth: string): Promise<{ tools: string[]; stderr: string }> {
  const args = [
    "run",
    "--rm",
    // Mirror production (sandbox-docker args.ts): run as the image user, with a user-owned writable agent dir.
    // Without it Docker creates the file mounts' parent dirs root-owned and Pi cannot create auth.json.lock.
    "--user",
    "1000:1000",
    "--tmpfs",
    "/home/node/.pi/agent:uid=1000,gid=1000",
    "-v",
    `${auth}:/home/node/.pi/agent/auth.json:ro`,
    ...(existsSync(MODELS) ? ["-v", `${MODELS}:/home/node/.pi/agent/models-store.json:ro`] : []),
    IMAGE!,
    "pi",
    "--mode",
    "json",
    "--session",
    "/tmp/pomtree-ext-live-session.jsonl",
    ...PI_EXT_LOADOUT.flatMap((e) => ["--extension", e.path]),
    "--provider",
    PROVIDER!,
    "--model",
    MODEL,
    "--thinking",
    "off",
    "--",
    "Reply with the single word: ok",
  ];
  return new Promise((resolve) => {
    const c = gateCommand(args, {});
    const child = spawn(c.file, c.args, { ...c.options, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let buf = "";
    let settled = false;
    const finish = (tools: string[]) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ tools, stderr });
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.stdout.on("data", (d: Buffer) => {
      if (settled) return;
      buf += d.toString();
      let idx = buf.indexOf("\n");
      while (idx !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
        if (!line) continue;
        let rec: { type?: string; message?: { role?: string; toolsAdded?: { name?: string }[] } };
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type === "message_end" && rec.message?.role === "system" && Array.isArray(rec.message.toolsAdded)) {
          clearTimeout(timer);
          finish(rec.message.toolsAdded.map((t) => t.name ?? "").filter(Boolean));
        }
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      finish([]);
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish([]);
    });
  });
}

test("in-image extension loadout registers web_search and web_fetch (no model call)", { skip: skipReason(), timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ext-live-"));
  chmodSync(dir, 0o755); // readable by the image user (uid 1000); the file holds only a placeholder
  const auth = join(dir, "auth.json");
  writeFileSync(auth, JSON.stringify({ [PROVIDER!]: { type: "api_key", key: "placeholder-never-sent" } }), { mode: 0o644 });
  const { tools, stderr } = await registeredTools(60_000, auth).finally(() => rmSync(dir, { recursive: true, force: true }));
  if (tools.length === 0) {
    assert.fail(`Pi exited before registering tools (auth/provider problem?). stderr: ${stderr.slice(0, 500)}`);
  }
  for (const name of ["web_search", "web_fetch"]) {
    assert.ok(tools.includes(name), `expected ${name} in toolsAdded, got ${tools.join(", ")}`);
  }
});
