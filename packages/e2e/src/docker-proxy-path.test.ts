import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentId, MountProvider } from "@pomtree/core";
import { egressPolicy } from "@pomtree/pomtreed";
import { DiskEgressAudit, DockerSandbox } from "@pomtree/sandbox-docker";
import { CAPTURE_REPORT_NAMES } from "../../agent-image/src/browser-capture.ts";
import { CLI_POMTREE_TIMEOUT_MS } from "../../agent-image/src/container-contract.gen.ts";
import { agentBindPlan, detectBridgeGateway } from "../../pomtreed/src/agent-net.ts";
import { imageRevisionSkip } from "./image-gate.ts";
import { pinnedImage } from "./live-model.ts";

// Behavioral smoke of the browser worker's daemon path, before any paid run. A live digest once read 0/3 articles because the scrubbed
// `pomtree` child envs dropped the egress proxy selectors: the sandbox is --network none, so every publish and capture_finish failed, while
// every offline test passed. Here the REAL agent image runs under the REAL DockerSandbox (network none, audited-public egress sidecar,
// relay granted by pomtreed's egressPolicy) against a fake daemon on the host, and the shipped in-image modules make the calls: `pomtree()` from
// /opt/pomtree/browser-capture.ts (pomtreeEnv) for a report publish, and `createFinish` from the browser extension (finishEnv + finishArgv)
// for `pomtree result`. The negative half repeats both with the proxy selectors removed from the env those builders read (what the pre-fix
// builders produced) and must fail to reach the daemon. No Chromium, Pi or model runs; nothing is spent.
//
// Run: AGENT_IMAGE_TAG=pomtree/agent:smoke-<sha> node packages/agent-image/scripts/build.ts, then
//   PTREE_DOCKER_TESTS=1 PTREE_E2E_IMAGE=pomtree/agent:smoke-<sha> node --test packages/e2e/src/docker-proxy-path.test.ts
// Gate mirrors browser-live-run.test.ts (PTREE_AGENT_TEST_REVISION optional; default the checkout's short HEAD).
const image = process.env.PTREE_E2E_IMAGE;
const sh = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 20_000 }).trim();
  } catch {
    return undefined;
  }
};
function dockerSkip(): string | false {
  if (process.env.PTREE_DOCKER_TESTS !== "1") return "PTREE_DOCKER_TESTS not set (lite run)";
  if (!image) return "PTREE_E2E_IMAGE unset";
  if (process.getuid?.() === 0) return "audited-public requires unprivileged host uid";
  if (sh("docker", ["info"]) === undefined) return "docker daemon unreachable";
  if (sh("docker", ["image", "inspect", image]) === undefined) return `${image} unavailable (this test never pulls or builds)`;
  const revision = process.env.PTREE_AGENT_TEST_REVISION ?? sh("git", ["rev-parse", "--short", "HEAD"]);
  const paths = [":(top)packages/agent-image", ":(top)packages/sandbox-docker"];
  const dirty =
    sh("git", ["diff", "HEAD", "--stat", "--", ...paths]) !== "" || sh("git", ["ls-files", "--others", "--exclude-standard", "--", ...paths]) !== "";
  return imageRevisionSkip(
    image,
    sh("docker", ["image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}', image]),
    revision,
    dirty,
  );
}

const TOKEN = "smoke-dummy-pomtree-token-not-real";
const AGENT = "smoke-proxy-agent";
const GENERATION = 3;
const NAME = CAPTURE_REPORT_NAMES.text;
const BODY = "fixed proxy-path smoke report body\n";
const BODY_SHA = createHash("sha256").update(BODY).digest("hex");

// Runs inside the container as the sandbox command. It imports the modules the image ships (never host copies), so pomtreeEnv, finishEnv,
// finishArgv, CLI_POMTREE_MAIN and the spawn options are production's. `variant` keys tell the fake daemon's records apart.
const PROBE = `
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReportPublishJson, pomtree, publishArgv } from "/opt/pomtree/browser-capture.ts";
import { PROXY_ENV_NAMES } from "/opt/pomtree/container-contract.gen.ts";
import { createFinish } from "/opt/pomtree/ext/pomtree-browser/finish.ts";
const NAME = ${JSON.stringify(NAME)};
const BODY = ${JSON.stringify(BODY)};
const sha256 = createHash("sha256").update(BODY).digest("hex");
const file = join(mkdtempSync(join(tmpdir(), "pomtree-capture-")), NAME);
writeFileSync(file, BODY, { mode: 0o600 });
const stripped = Object.fromEntries(Object.entries(process.env).filter(([k]) => !PROXY_ENV_NAMES.includes(k)));
async function publish(env, variant) {
  const t0 = Date.now();
  try {
    const key = "browser-capture:" + process.env.POMTREE_AGENT_ID + ":" + process.env.POMTREE_AGENT_GENERATION + ":" + NAME + "-" + variant + ":" + sha256;
    const r = parseReportPublishJson(await pomtree(publishArgv(file, NAME, "text/plain", key), undefined, env), sha256);
    return { ok: true, ms: Date.now() - t0, id: r.id };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}
async function finish(env, variant) {
  const t0 = Date.now();
  const r = await createFinish({ env })("succeeded", "smoke " + variant);
  return { ok: r.ok, ms: Date.now() - t0, text: r.text, failure: r.failure };
}
const out = {
  proxyVars: PROXY_ENV_NAMES.filter((k) => k in process.env),
  strippedProxyVars: PROXY_ENV_NAMES.filter((k) => k in stripped),
  positive: { publish: await publish(process.env, "positive"), finish: await finish(process.env, "positive") },
  negative: { publish: await publish(stripped, "negative"), finish: await finish(stripped, "negative") },
};
console.log("SMOKE " + JSON.stringify(out));
`;

interface Call {
  ok: boolean;
  ms: number;
  id?: string;
  error?: string;
  text?: string;
  failure?: unknown;
}
interface ProbeOut {
  proxyVars: string[];
  strippedProxyVars: string[];
  positive: { publish: Call; finish: Call };
  negative: { publish: Call; finish: Call };
}
interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

test("browser worker pomtree paths reach a fake daemon through the real egress proxy, and fail without the proxy env", {
  skip: dockerSkip(),
  timeout: 180_000,
}, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-proxy-smoke-")));
  const work = join(root, "work");
  mkdirSync(work, { mode: 0o755 });
  const received: Received[] = [];
  // Fake pomtreed POMTREE_API: accepts only the bearer token, answers the two routes the worker uses with the daemon's reply shapes.
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(v));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: "unauthorized" });
      if (req.method === "POST" && req.url?.startsWith("/v1/agents/self/reports?"))
        return json(200, { replayed: false, report: { id: `report-${received.length}`, sha256: createHash("sha256").update(body).digest("hex") } });
      if (req.method === "POST" && req.url === "/v1/agents/self/result")
        return json(200, { id: AGENT, name: "smoke", state: "exited", generation: GENERATION, host: "smoke-host" });
      json(404, { error: "not found" });
    });
  });
  // Bind where pomtreed binds its agent endpoint (loopback on Docker Desktop, the bridge gateway on Linux); containers use host.docker.internal.
  const platform = process.platform;
  const plan = await agentBindPlan(platform, () => detectBridgeGateway(async (c, a) => execFileSync(c, a, { encoding: "utf8", timeout: 10_000 })));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, plan.mode === "off" ? "127.0.0.1" : plan.host, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const apiUrl = `http://host.docker.internal:${port}`;
  const authority = `host.docker.internal:${port}`;
  const egress = egressPolicy({
    policy: { kind: "audited-public" },
    manifest: { ecosystems: {} },
    agentApiUrl: apiUrl,
    host: "smoke-host",
    generation: GENERATION,
  });
  const mounts: MountProvider = {
    resolve: async (_a, m) => {
      if (m.kind === "workspace") return { type: "bind", hostPath: work, containerPath: m.containerPath, readOnly: false };
      throw new Error(`unexpected mount ${m.kind}`);
    },
  };
  const auditRoot = join(root, "audit");
  const sandbox = new DockerSandbox({ mounts, egressProxyImage: pinnedImage(image!), egressAuditRoot: auditRoot, startRetries: 0, startTimeoutMs: 60_000 });
  let id: string | undefined;
  try {
    const h = await sandbox.start(
      {
        agent: AGENT as AgentId,
        image: image!,
        mounts: [{ kind: "workspace", workspace: "ws-proxy-smoke", containerPath: "/work" }],
        cmd: ["node", "--input-type=module", "-e", PROBE],
        env: { POMTREE_AGENT_ID: AGENT, POMTREE_AGENT_GENERATION: String(GENERATION), POMTREE_API: apiUrl, POMTREE_TOKEN: TOKEN },
        egress,
      },
      `proxy-smoke:${Date.now()}`,
    );
    id = h.id;
    let logs = "";
    for await (const part of h.output()) logs += part.chunk;
    const exit = await h.wait();
    const line = logs.split("\n").find((l) => l.startsWith("SMOKE "));
    assert.ok(line, `probe printed no result (exit ${exit.exitCode}):\n${logs.slice(-3000)}`);
    const r = JSON.parse(line.slice("SMOKE ".length)) as ProbeOut;
    const detail = JSON.stringify(r, null, 2);
    for (const [variant, calls] of Object.entries({ positive: r.positive, negative: r.negative }))
      for (const [call, c] of Object.entries(calls)) t.diagnostic(`${variant} ${call}: ok=${c.ok} ${c.ms} ms`);

    // Premise: the sandbox set the proxy selectors, and the negative env really lacks them.
    assert.ok(r.proxyVars.includes("HTTP_PROXY") && r.proxyVars.includes("NODE_USE_ENV_PROXY"), detail);
    assert.deepEqual(r.strippedProxyVars, [], detail);

    // Positive: both calls succeed through the proxy, well inside pomtree's 15 s client timeout and the worker's 10 s publish bound.
    assert.equal(r.positive.publish.ok, true, detail);
    assert.equal(r.positive.finish.ok, true, detail);
    assert.equal(r.positive.finish.text, "result recorded", detail);
    assert.ok(r.positive.publish.ms < CLI_POMTREE_TIMEOUT_MS / 2, detail);
    assert.ok(r.positive.finish.ms < 7_500, detail);
    const publishes = received.filter((x) => x.method === "POST" && x.url.startsWith("/v1/agents/self/reports?"));
    const results = received.filter((x) => x.method === "POST" && x.url === "/v1/agents/self/result");
    assert.equal(publishes.length, 1, JSON.stringify(received.map((x) => x.url)));
    assert.equal(results.length, 1, JSON.stringify(received.map((x) => x.url)));
    const pub = publishes[0]!;
    const q = new URL(pub.url, "http://x").searchParams;
    assert.equal(q.get("name"), NAME);
    assert.match(q.get("key") ?? "", new RegExp(`^browser-capture:${AGENT}:${GENERATION}:${NAME}-positive:${BODY_SHA}$`));
    assert.equal(pub.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(pub.headers["content-type"], "application/octet-stream");
    assert.equal(pub.body.toString(), BODY);
    const res = results[0]!;
    assert.equal(res.headers.authorization, `Bearer ${TOKEN}`);
    const resBody = JSON.parse(res.body.toString()) as { status: string; result: { summary: string }; idempotencyKey: string };
    assert.equal(resBody.status, "succeeded");
    assert.equal(resBody.result.summary, "smoke positive");
    assert.ok(resBody.idempotencyKey);
    // Every request the fake saw carried the token, so none came from an unauthenticated path.
    assert.ok(received.every((x) => x.headers.authorization === `Bearer ${TOKEN}`));

    // Negative: without the proxy selectors neither call reaches the daemon (network none has no route), and both fail.
    assert.equal(r.negative.publish.ok, false, detail);
    assert.match(r.negative.publish.error ?? "", /^scoped report publication failed/, detail);
    assert.equal(r.negative.finish.ok, false, detail);
    assert.match(r.negative.finish.text ?? "", /^recording the result failed/, detail);
    assert.equal(received.length, 2, `negative calls reached the daemon: ${JSON.stringify(received.map((x) => x.url))}`);

    // The daemon-bound traffic went through the sidecar: its audit spool records the relay authority.
    const disk = new DiskEgressAudit({ root: auditRoot });
    const rows = (await disk.read(h.id, 0)) as unknown as { authority: string }[];
    assert.ok(
      rows.some((x) => x.authority === authority),
      `no audit row for ${authority}: ${JSON.stringify(rows.map((x) => x.authority))}`,
    );

    // The token appears only in the daemon-bound Authorization header: not in the container's stdout/stderr (including the redacted
    // failure tails), and not in the egress audit spool.
    assert.ok(!logs.includes(TOKEN), "token leaked into container output");
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(auditRoot)) assert.ok(!readFileSync(f).includes(TOKEN), `token leaked into ${f}`);
  } finally {
    if (id) await sandbox.kill(id as Parameters<typeof sandbox.kill>[0]).catch(() => {});
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
