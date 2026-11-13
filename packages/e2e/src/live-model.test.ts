import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { MountProvider, SandboxEgress } from "@pomtree/core";
import { PI_AGENT_DIR, PI_AUTH_PATH } from "@pomtree/harness-pi";
import { DockerSandbox } from "@pomtree/sandbox-docker";
import { openStore } from "@pomtree/store-sqlite";
import type { ProxySettlement } from "../../pomtreed/src/model-proxy/service.ts";
import { engineEnv, liveEngine, pinnedImage, startLiveModel } from "./live-model.ts";
import { assertModelProxyReachable, modelRouteProblem, sandboxModelRouteProbe } from "./model-preflight.ts";
import { buildOpenAiJson } from "@pomtree/testing";
import { SECRET, tmp } from "./harness.ts";
import { sandboxOpKey } from "../../pomtreed/src/daemon/sandbox-ops.ts";

const UPSTREAM_KEY = "stub-upstream-key-0123456789";
// One non-stream chat completion from the shared fake-model wire builder (3 in, 2 out), plus OpenRouter's provider-reported
// `usage.cost`, which prices the call with no catalog. The upstream stays a local server because the tests assert the URL and the
// Authorization header it saw. TODO(fake-model): the stub can now script `usage.cost` but FakeModelUpstream records no headers or
// query; with that, these servers become FakeModelUpstream.start.
const stubCompletion = () => {
  const body = buildOpenAiJson({ kind: "text", text: "stub", usage: { input: 3, output: 2 } }, { model: "stub" }) as { usage: Record<string, unknown> };
  return JSON.stringify({ ...body, usage: { ...body.usage, cost: 0.00001 } });
};
// The key reaches startLiveModel as pomtreed's does: a mode-0600 file named by POMTREED_MODEL_UPSTREAM_KEY_FILE, inside the test's temp dir.
const keyFileEnv = (dir: string) => {
  const file = join(dir, "upstream.key");
  writeFileSync(file, UPSTREAM_KEY, { mode: 0o600 });
  return { POMTREED_MODEL_UPSTREAM_KEY_FILE: file };
};
const relayTo = (port: number): SandboxEgress => ({ allow: [], relay: [{ host: "host.docker.internal", port }] });

async function withLiveModel<T>(
  o: { platform?: string; gateway?: string; backend?: string },
  fn: (live: Awaited<ReturnType<typeof startLiveModel>>) => Promise<T>,
): Promise<T> {
  const stateDir = tmp("live-model");
  const store = openStore(join(stateDir, "pomtreed.sqlite"));
  const live = await startLiveModel({
    store,
    secret: SECRET,
    stateDir,
    provider: "openrouter",
    env: {
      POMTREED_MODEL_BASE_URL: "http://127.0.0.1:1/api/v1",
      ...keyFileEnv(stateDir),
      POMTREED_PI_CATALOG_DIR: join(stateDir, "no-catalog"),
      ...(o.backend !== undefined && { POMTREED_SANDBOX_BACKEND: o.backend }),
    },
    ...(o.platform !== undefined && { platform: o.platform }),
    ...(o.gateway !== undefined && { gateway: o.gateway }),
  });
  try {
    return await fn(live);
  } finally {
    await live.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("the model proxy never binds a wildcard: loopback off Linux, the injected bridge gateway on Linux", async () => {
  await withLiveModel({ platform: "darwin" }, async (live) => assert.equal(live.bind.host, "127.0.0.1"));
  // 127.0.0.1 stands in for the docker0 address so the bind succeeds on any host.
  await withLiveModel({ platform: "linux", gateway: "127.0.0.1" }, async (live) => assert.equal(live.bind.host, "127.0.0.1"));
});

test("the live model follows the daemon's engine selector: Podman binds loopback with no bridge gateway, Docker binds the gateway", async () => {
  // 192.0.2.1 (TEST-NET-1) cannot be bound on any host, so a Docker plan that uses the gateway fails, which proves the engine reaches the plan.
  await withLiveModel({ platform: "linux", gateway: "192.0.2.1", backend: "podman" }, async (live) => assert.equal(live.bind.host, "127.0.0.1"));
  await assert.rejects(
    withLiveModel({ platform: "linux", gateway: "192.0.2.1", backend: "docker" }, async () => undefined),
    /EADDRNOTAVAIL|listen/,
  );
  await assert.rejects(
    withLiveModel({ platform: "linux", backend: "auto" }, async () => undefined),
    /POMTREED_SANDBOX_BACKEND=auto.*docker or podman/,
  );
});

test("liveEngine: unset or empty is docker, docker and podman select their profile, auto and unknown values are refused", () => {
  assert.equal(liveEngine({}).binary, "docker");
  assert.equal(liveEngine({ POMTREED_SANDBOX_BACKEND: "" }).binary, "docker");
  assert.equal(liveEngine({ POMTREED_SANDBOX_BACKEND: "docker" }).id, "docker");
  assert.equal(liveEngine({ POMTREED_SANDBOX_BACKEND: "podman" }).binary, "podman");
  assert.throws(() => liveEngine({ POMTREED_SANDBOX_BACKEND: "auto" }), /auto cannot tell them which CLI/);
  assert.throws(() => liveEngine({ POMTREED_SANDBOX_BACKEND: "nerdctl" }), /nerdctl is not supported.*set it to docker or podman/);
});

test("engineEnv: the scrubbed-env harnesses forward the engine selector and socket locators, and nothing else", () => {
  const src = {
    POMTREED_SANDBOX_BACKEND: "podman",
    POMTREED_SANDBOX_PODMAN_SOCKET: "/run/user/1000/podman/podman.sock",
    POMTREED_SANDBOX_DOCKER_SOCKET: "/var/run/docker.sock",
    CONTAINER_HOST: "unix:///x",
    DOCKER_HOST: "unix:///y",
    XDG_RUNTIME_DIR: "/run/user/1000",
    POMTREED_MODEL_UPSTREAM_KEY_FILE: "/k",
    POMTREED_SANDBOX_EMPTY: "",
    HOME: "/h",
  };
  assert.deepEqual(engineEnv(src), {
    POMTREED_SANDBOX_BACKEND: "podman",
    POMTREED_SANDBOX_PODMAN_SOCKET: "/run/user/1000/podman/podman.sock",
    POMTREED_SANDBOX_DOCKER_SOCKET: "/var/run/docker.sock",
    CONTAINER_HOST: "unix:///x",
    DOCKER_HOST: "unix:///y",
    XDG_RUNTIME_DIR: "/run/user/1000",
  });
  assert.deepEqual(engineEnv({}), {});
});

const base = (port: number) => `http://host.docker.internal:${port}`;
test("modelRouteProblem: bind address, handed address and egress grant must be mutually reachable", () => {
  const ok = { platform: "darwin", bind: { host: "127.0.0.1", port: 9000 }, baseUrl: base(9000), egress: relayTo(9000) };
  assert.equal(modelRouteProblem(ok), undefined);
  assert.match(modelRouteProblem({ ...ok, egress: { allow: [] } }) ?? "", /grants no relay/); // the live-run failure: policy none
  assert.match(modelRouteProblem({ ...ok, egress: undefined }) ?? "", /grants no relay/);
  assert.match(modelRouteProblem({ ...ok, egress: relayTo(9001) }) ?? "", /grants no relay/);
  assert.match(modelRouteProblem({ ...ok, baseUrl: base(9001) }) ?? "", /differs from the bound port/);
  assert.match(modelRouteProblem({ ...ok, baseUrl: "http://127.0.0.1:9000" }) ?? "", /host alias/);
  assert.match(modelRouteProblem({ ...ok, platform: "linux" }) ?? "", /loopback/);
  assert.equal(modelRouteProblem({ ...ok, platform: "linux", bind: { host: "172.17.0.1", port: 9000 } }), undefined);
  assert.match(modelRouteProblem({ ...ok, bind: { host: "0.0.0.0", port: 9000 } }) ?? "", /exposed/);
});

test("modelRouteProblem: rootless Podman on Linux accepts a loopback bind (its sidecar maps host loopback); Docker on Linux still refuses it", () => {
  const linuxLoopback = { platform: "linux", bind: { host: "127.0.0.1", port: 9000 }, baseUrl: base(9000), egress: relayTo(9000) };
  assert.equal(modelRouteProblem({ ...linuxLoopback, engine: { id: "podman" } }), undefined);
  assert.match(modelRouteProblem({ ...linuxLoopback, engine: { id: "docker" } }) ?? "", /loopback/);
  assert.match(modelRouteProblem(linuxLoopback) ?? "", /loopback/, "no engine means Docker");
  // Podman relaxes only the loopback rule: a wildcard bind and a missing relay grant are still refused.
  assert.match(modelRouteProblem({ ...linuxLoopback, engine: { id: "podman" }, bind: { host: "0.0.0.0", port: 9000 } }) ?? "", /exposed/);
  assert.match(modelRouteProblem({ ...linuxLoopback, engine: { id: "podman" }, egress: { allow: [] } }) ?? "", /grants no relay/);
});

test("assertModelProxyReachable names the address on a failed probe and skips the probe when the relation is already broken", async () => {
  const good = { platform: "darwin", bind: { host: "127.0.0.1", port: 9000 }, baseUrl: base(9000), egress: relayTo(9000) };
  await assertModelProxyReachable({ ...good, probe: async () => 401 });
  await assert.rejects(
    assertModelProxyReachable({ ...good, probe: async () => Promise.reject(new Error("fetch failed")) }),
    /model proxy unreachable from container via http:\/\/host\.docker\.internal:9000: fetch failed/,
  );
  let probed = false;
  await assert.rejects(
    assertModelProxyReachable({
      ...good,
      egress: { allow: [] },
      probe: async () => {
        probed = true;
        return 200;
      },
    }),
    /unreachable from container via .*no relay/,
  );
  assert.equal(probed, false);
});

// Docker-gated: a container with the worker's network shape (--network none + egress sidecar), the staged proxy credential and a real
// key-issuing proxy in front of a local stub upstream. Nothing leaves the machine.
const image = process.env.PTREE_E2E_IMAGE;
function dockerSkip(): string | false {
  if (process.env.PTREE_DOCKER_TESTS !== "1") return "PTREE_DOCKER_TESTS not set (lite run)";
  if (!image) return "PTREE_E2E_IMAGE unset";
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 10_000 });
  } catch {
    return `${image} unavailable (docker unreachable or image not built; this test never pulls)`;
  }
  return false;
}

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
}

async function rig<T>(
  fn: (r: {
    stub: Seen[];
    live: Awaited<ReturnType<typeof startLiveModel>>;
    store: ReturnType<typeof openStore>;
    sandbox: DockerSandbox;
    work: string;
  }) => Promise<T>,
): Promise<T> {
  const stub: Seen[] = [];
  const server = createServer((q, r) => {
    q.resume();
    stub.push({ url: q.url ?? "", headers: q.headers });
    r.setHeader("content-type", "application/json");
    r.end(stubCompletion());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stateDir = tmp("live-model-docker");
  const store = openStore(join(stateDir, "pomtreed.sqlite"));
  const live = await startLiveModel({
    store,
    secret: SECRET,
    stateDir,
    provider: "openrouter",
    env: {
      POMTREED_MODEL_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`,
      ...keyFileEnv(stateDir),
      POMTREED_PI_CATALOG_DIR: join(stateDir, "no-catalog"),
    },
  });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-live-model-")));
  const work = join(root, "work");
  mkdirSync(work, { mode: 0o755 });
  chmodSync(root, 0o755);
  const mounts: MountProvider = {
    resolve: async (_a, m) => {
      if (m.kind === "workspace") return { type: "bind", hostPath: work, containerPath: m.containerPath, readOnly: false };
      if (m.kind === "bind") return { type: "bind", hostPath: m.hostPath, containerPath: m.containerPath, readOnly: m.readOnly ?? false };
      throw new Error(`unexpected mount ${m.kind}`);
    },
  };
  const sandbox = new DockerSandbox({
    mounts,
    egressProxyImage: pinnedImage(image!),
    egressAuditRoot: join(root, "audit"),
    startRetries: 0,
    startTimeoutMs: 30_000,
  });
  try {
    return await fn({ stub, live, store, sandbox, work });
  } finally {
    await live.close();
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
}

async function runIn(
  sandbox: DockerSandbox,
  agent: string,
  egress: SandboxEgress,
  staged: Awaited<ReturnType<typeof startLiveModel>>["credentials"],
  key: { key: string; baseUrl: string },
  script: string,
): Promise<string> {
  const h = await sandbox.start(
    {
      host: "host-test",
      generation: 0,
      agent,
      image: image!,
      env: {},
      mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/work" }, ...staged.stage(agent, key)],
      cmd: ["node", "-e", script],
      egress,
    },
    `${agent}:${Date.now()}`,
  );
  let out = "";
  try {
    for await (const part of h.output()) out += part.chunk;
    await h.wait().catch(() => {});
  } finally {
    await sandbox.kill(h.id, sandboxOpKey("kill", h.id)).catch(() => {});
  }
  return out;
}

// Reads the staged auth.json / models.json exactly as Pi would (key, baseUrl, request-id header command), then sends one chat completion.
const piLikeRequest = (withCredential: boolean) => `
  const fs=require('node:fs');
  const auth=JSON.parse(fs.readFileSync(${JSON.stringify(PI_AUTH_PATH)},'utf8'));
  const models=JSON.parse(fs.readFileSync(${JSON.stringify(`${PI_AGENT_DIR}/models.json`)},'utf8'));
  const p=Object.keys(models.providers)[0];
  const headers={'content-type':'application/json','x-pomtree-request-id':fs.readFileSync('/proc/sys/kernel/random/uuid','utf8').trim()};
  ${withCredential ? "headers.authorization='Bearer '+auth[p].key;" : ""}
  const leaked=Object.values(process.env).some(v=>String(v).includes(${JSON.stringify(UPSTREAM_KEY)}))||JSON.stringify(headers).includes(${JSON.stringify(UPSTREAM_KEY)});
  fetch(models.providers[p].baseUrl+'/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'stub',messages:[{role:'user',content:'hi'}],max_tokens:4})})
    .then(async r=>console.log('RESULT',JSON.stringify({status:r.status,leaked,body:(await r.text()).slice(0,200)})))
    .catch(e=>console.log('RESULT',JSON.stringify({error:e.message,leaked})));`;
const resultOf = (out: string) =>
  JSON.parse(/RESULT (.*)/.exec(out)?.[1] ?? "null") as { status?: number; error?: string; leaked: boolean; body?: string } | null;

test("grounded-model worker network: a chat completion reaches the stub via the scoped proxy, charged, with no upstream key in the container", {
  skip: dockerSkip(),
  timeout: 150_000,
}, async () => {
  await rig(async ({ stub, live, store, sandbox }) => {
    const agent = "live-model-ok";
    // Registered with the resolved model the gateway signs into the key's allowlist (the stub's `model: 'stub'`).
    await store.registry.create({
      id: agent,
      parent: null,
      name: agent,
      task: "t",
      host: "h1",
      budgetMicros: 100_000,
      idempotencyKey: agent,
      spec: { image: "img@sha256:e2e", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" }, model: "stub" },
    });
    const key = await live.gateway.issueKey(agent, 100_000);
    const egress = relayTo(live.bind.port);
    // The preflight an entry runs before any spend: same network shape, no credential.
    await assertModelProxyReachable({
      platform: process.platform,
      bind: live.bind,
      baseUrl: key.baseUrl,
      egress,
      probe: sandboxModelRouteProbe(sandbox, {
        agent: "live-model-pre",
        image: image!,
        mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/work" }],
        egress,
      }),
    });
    assert.equal(stub.length, 0, "the unauthenticated preflight must not reach the upstream");
    const r = resultOf(await runIn(sandbox, agent, egress, live.credentials, key, piLikeRequest(true)));
    assert.equal(r?.status, 200, JSON.stringify(r));
    assert.equal(r?.leaked, false);
    assert.equal(stub.length, 1);
    assert.equal(stub[0]?.url, "/api/v1/chat/completions");
    assert.equal(stub[0]?.headers.authorization, `Bearer ${UPSTREAM_KEY}`);
    assert.ok(store.modelDebit({ secret: SECRET }).spentFor(agent) > 0, "the debit ledger records the call");
  });
});

test("negative controls: no credential is refused; no relay grant (policy none) cannot reach the proxy; the stub sees nothing", {
  skip: dockerSkip(),
  timeout: 150_000,
}, async () => {
  await rig(async ({ stub, live, store, sandbox }) => {
    // Registered with a model so the key itself is valid: the refusals below come from the missing credential and relay, not the allowlist.
    await store.registry.create({
      id: "live-model-neg",
      parent: null,
      name: "live-model-neg",
      task: "t",
      host: "h1",
      budgetMicros: 100_000,
      idempotencyKey: "live-model-neg",
      spec: { image: "img@sha256:e2e", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" }, model: "stub" },
    });
    const key = await live.gateway.issueKey("live-model-neg", 100_000);
    const noCred = resultOf(await runIn(sandbox, "live-model-neg", relayTo(live.bind.port), live.credentials, key, piLikeRequest(false)));
    assert.equal(noCred?.status, 401, JSON.stringify(noCred));
    // Characterizes the live hn-content failure: egress `none` resolves to no relay, so Pi saw only "Connection error." (TODO(model-egress)).
    const none = resultOf(await runIn(sandbox, "live-model-none", { allow: [] }, live.credentials, key, piLikeRequest(true)));
    assert.ok(none?.error, JSON.stringify(none));
    assert.equal(stub.length, 0);
    await assert.rejects(
      assertModelProxyReachable({ platform: process.platform, bind: live.bind, baseUrl: key.baseUrl, egress: { allow: [] }, probe: async () => 200 }),
      /model proxy unreachable from container via/,
    );
  });
});

// Docker-free: a host-side request straight to the proxy listener against a stub upstream (sentinel key), judged on the debit
// ledger row and the journal. The negative control disables the sink, which is how startLiveModel was wired before it
// installed one: spend was charged but every call-metadata column stayed NULL and nothing was journaled.
async function oneCall(onSettlement?: (e: ProxySettlement) => void) {
  const server = createServer((q, r) => {
    q.resume();
    r.setHeader("content-type", "application/json");
    r.end(stubCompletion());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stateDir = tmp("live-model-audit");
  const store = openStore(join(stateDir, "pomtreed.sqlite"));
  const live = await startLiveModel({
    store,
    secret: SECRET,
    stateDir,
    provider: "openrouter",
    env: {
      POMTREED_MODEL_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`,
      ...keyFileEnv(stateDir),
      POMTREED_PI_CATALOG_DIR: join(stateDir, "no-catalog"),
    },
    ...(onSettlement && { onSettlement }),
  });
  try {
    const a = await store.registry.create({
      parent: null,
      name: "w",
      task: "t",
      host: "h1",
      budgetMicros: 100_000,
      idempotencyKey: "audit",
      // The resolved model the gateway signs into the key's allowlist; a spec without one issues a key that calls no model.
      spec: { image: "img@sha256:e2e", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" }, model: "stub" },
    });
    const key = await live.gateway.issueKey(a.id, 100_000);
    const res = await fetch(`http://${live.bind.host}:${live.bind.port}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key.key}`, "x-pomtree-request-id": "req-audit-1" },
      body: JSON.stringify({ model: "stub", messages: [{ role: "user", content: "hi" }], max_tokens: 4 }),
    });
    assert.equal(res.status, 200);
    await res.text();
    await new Promise((r) => setTimeout(r, 200)); // the sink journals asynchronously
    const row = new DatabaseSync(join(stateDir, "pomtreed.sqlite")).prepare("SELECT * FROM model_debit_requests WHERE agent=?").get(a.id) as Record<
      string,
      unknown
    >;
    const entries = (await store.journal.read({ agent: a.id })).filter((e) => (e.payload as { kind?: string }).kind === "ext.pomtreed.model_settlement");
    return { row, entries };
  } finally {
    await live.close();
    server.closeAllConnections();
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("startLiveModel records call metadata on the debit row and journals one model_settlement entry per call", async () => {
  const { row, entries } = await oneCall();
  assert.equal(row.status, "settled");
  assert.ok(row.settled_at !== null && row.settled_at !== undefined);
  assert.equal(row.model, "stub");
  assert.equal(row.tokens_in, 3);
  assert.equal(row.tokens_out, 2);
  assert.equal(row.upstream_status, 200);
  assert.equal(typeof row.latency_ms, "number");
  assert.equal(row.finish_reason, "stop");
  assert.equal(entries.length, 1);
  const p = entries[0]?.payload as Record<string, unknown>;
  assert.deepEqual(
    [p.settlement, p.requestId, p.model, p.tokensIn, p.tokensOut, p.upstreamStatus, p.route],
    ["priced", "req-audit-1", "stub", 3, 2, 200, "chat_completions"],
  );
});

test("negative control: with no settlement sink (the old wiring) the metadata columns stay NULL and nothing is journaled", async () => {
  const { row, entries } = await oneCall(() => {});
  assert.equal(row.status, "settled");
  for (const c of ["model", "tokens_in", "tokens_out", "upstream_status", "latency_ms", "finish_reason"]) assert.equal(row[c], null, c);
  assert.equal(entries.length, 0);
});
