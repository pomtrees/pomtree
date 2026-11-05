// S0 rig (in-process, no Docker): pomtreed's REAL model proxy HTTP server over the scripted FakeModelUpstream, wired to a REAL in-process
// Daemon with the REAL ProxyCredentialGateway. Mirrors main.ts: one store, one debit ledger (`store.modelDebit`) shared by the gateway
// and the proxy, one SECRET, the default settlement sink, `proxyPiCredentials` staging the issued key. The agent's credential is what
// the daemon really issued (captured where main.ts hands it to Pi's staging), never hand-encoded. Only the upstream, the rate card and
// the clock are test-owned. Used by proxy-budget.test.ts and proxy-credentials.test.ts.
import { rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { POMTREED_KINDS } from "@pomtree/core";
import type { AgentId, AgentLedger, Harness, JournalEntry } from "@pomtree/core";
import { PI_AUTH_PATH } from "@pomtree/harness-pi";
import { ModelProxy, ProxyCredentialGateway, createModelProxyServer, proxyPiCredentials } from "@pomtree/pomtreed";
import type { PiCredentials, StagedModelCredential } from "@pomtree/pomtreed";
import { FakeModelCatalog, FakeModelUpstream } from "@pomtree/testing";
import type { ModelScript } from "@pomtree/testing";
import { buildModelProxyOptions } from "../../pomtreed/src/model-proxy-options.ts";
import { createRequestEstimate } from "../../pomtreed/src/model-proxy/price.ts";
import type { ModelRates, RatesSource } from "../../pomtreed/src/model-proxy/rates.ts";
import { SECRET, gitRepo, playHarness, rig, tmp } from "./harness.ts";
import type { Rig, RigOpts } from "./harness.ts";

export const PROVIDER = "deepseek"; // any non-anthropic provider: bearer auth, OpenAI chat-completions wire
export const MODEL = "stub-model"; // the catalog default, so every spawned agent's credential allows exactly this model
export const OTHER_MODEL = "other-model"; // catalogued and priced, but outside every agent's allowlist
// USD per million tokens, so micros per token equal these numbers: input 500 + output 500 = 500*1 + 500*2 = 1500 micros.
export const RATES: ModelRates = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 };
const rates: RatesSource = {
  lookup: (p, m) => (p === PROVIDER && (m === MODEL || m === OTHER_MODEL) ? RATES : null),
  ceiling: () => ({ inputMicrosPerToken: 2.5, outputMicrosPerToken: 2 }),
};
export const PATH = "/chat/completions";

export interface ProxyRigOpts {
  script: ModelScript;
  upstreamKey?: string; // the key only the proxy may hold (CRD-2 uses a random canary)
  tokenTtlMs?: number; // the gateway's credential lifetime (model.proxy.ttlMs)
  rootBudgetMicros?: number;
  maxSessions?: number;
  play?: RigOpts["play"];
  resume?: RigOpts["resume"];
}

export interface CallOpts {
  requestId: string;
  maxTokens?: number;
  marker?: string;
  model?: string;
}

export interface CallResult {
  status: number;
  text: string;
  error?: string; // the proxy's JSON `error` string, when the answer is an error
  headers: Headers;
}

export interface Settlement {
  settlement: string;
  micros: number;
  requestId: string;
  upstreamStatus?: number;
  [k: string]: unknown;
}

export interface ProxyRig {
  r: Rig;
  stub: FakeModelUpstream;
  debits: ReturnType<Rig["store"]["modelDebit"]>;
  clock: { t: number }; // the gateway's and the debit store's clock; advance it to expire a credential
  baseUrl: string; // the real proxy server
  stateDir: string;
  upstreamKey: string;
  upstreamCarriedKey: boolean[]; // per upstream request the proxy made: did its Authorization equal `Bearer <upstreamKey>` (a flag, never the value)
  staged: { agent: AgentId; key: string; baseUrl: string }[]; // every credential the daemon staged for Pi, in order
  harnessCalls: string[]; // JSON of every Harness start/resume argument set
  keyOf(agent: AgentId): string; // the agent's latest staged credential
  keysOf(agent: AgentId): string[];
  call(credential: string, o: CallOpts): Promise<CallResult>;
  requestBody(o: Omit<CallOpts, "requestId">): Record<string, unknown>;
  estimate(o: Omit<CallOpts, "requestId">): { promptMicros: number; microsPerToken: number; reserveMicros: number };
  ledger(agent: AgentId): AgentLedger;
  settlements(agent: AgentId): Promise<Settlement[]>;
  settlement(agent: AgentId, requestId: string): Promise<Settlement>; // polls (bounded): the sink journals after the body ends
  journalOf(agent: AgentId): Promise<JournalEntry[]>;
  releaseHolds(): void; // releases every hold() now (the agents then submit their results)
  hold(): Promise<void>; // a promise for Play.hold that close() releases, so a held agent never blocks teardown
  close(): Promise<void>; // closes the servers and store, removes every temp dir
}

export async function proxyRig(o: ProxyRigOpts): Promise<ProxyRig> {
  const stateDir = tmp("proxy-state");
  const repo = gitRepo();
  const upstreamKey = o.upstreamKey ?? "stub-upstream-key-not-real";
  const stub = await FakeModelUpstream.start({ script: o.script });
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const releases: (() => void)[] = [];
  const staged: ProxyRig["staged"] = [];
  const harnessCalls: string[] = [];
  const upstreamCarriedKey: boolean[] = [];
  const realCredentials = proxyPiCredentials({ stateDir, containerAuthPath: PI_AUTH_PATH, provider: PROVIDER });
  const credentials: PiCredentials = {
    ...realCredentials,
    stage(id, model: StagedModelCredential) {
      staged.push({ agent: id, key: model.key, baseUrl: model.baseUrl });
      return realCredentials.stage(id, model);
    },
  };
  const inner = playHarness(() => px.r.daemon, o.play ?? (() => ({ result: { status: "succeeded", result: null } })), o.resume);
  const harness: Harness = {
    start(a) {
      harnessCalls.push(JSON.stringify(a));
      return inner.start(a);
    },
    resume(a) {
      harnessCalls.push(JSON.stringify(a));
      return inner.resume(a);
    },
  };
  const r = rig({
    repo,
    stateDir,
    harness,
    maxSessions: o.maxSessions ?? 8,
    deps: {
      credentials,
      models: new FakeModelCatalog(
        [
          { provider: PROVIDER, id: MODEL },
          { provider: PROVIDER, id: OTHER_MODEL },
        ],
        { provider: PROVIDER, id: MODEL },
      ),
      ...(o.rootBudgetMicros !== undefined && { rootBudgetMicros: o.rootBudgetMicros }),
    },
  });
  // main.ts: the durable debit store is shared by the gateway and the proxy server.
  const debits = r.store.modelDebit({ secret: SECRET, now });
  const { proxy: options } = buildModelProxyOptions({
    env: {},
    provider: PROVIDER,
    upstream: { baseUrl: stub.baseUrl, key: upstreamKey },
    catalog: { found: true, rates },
    debits,
    registry: r.store.registry,
    journal: r.store.journal,
    log: () => {},
    fetch: (input, init) => {
      upstreamCarriedKey.push(new Headers(init?.headers).get("authorization") === `Bearer ${upstreamKey}`);
      return globalThis.fetch(input, init);
    },
  });
  const server: Server = createModelProxyServer(new ModelProxy(options));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The daemon reads `deps.gateway` at call time (relay.test.ts assigns extensionHost the same way); no agent has started yet.
  r.daemon.deps.gateway = new ProxyCredentialGateway({
    journal: r.store.journal,
    registry: r.store.registry,
    secret: SECRET,
    proxyBaseUrl: baseUrl,
    tokenTtlMs: o.tokenTtlMs ?? 3_600_000,
    now,
    debits,
    catalog: { provider: PROVIDER, source: rates },
  });

  const estimateOf = createRequestEstimate(rates, PROVIDER);
  const requestBody = (c: Omit<CallOpts, "requestId">): Record<string, unknown> => ({
    model: c.model ?? MODEL,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: c.maxTokens ?? 100,
    messages: [
      { role: "system", content: `you are a test agent [[stub:${c.marker ?? "text"}]]` },
      { role: "user", content: "go" },
    ],
  });
  const px: ProxyRig = {
    r,
    stub,
    debits,
    clock,
    baseUrl,
    stateDir,
    upstreamKey,
    upstreamCarriedKey,
    staged,
    harnessCalls,
    keysOf: (agent) => staged.filter((s) => s.agent === agent).map((s) => s.key),
    keyOf(agent) {
      const keys = px.keysOf(agent);
      if (keys.length === 0)
        throw new Error(`no credential was staged for ${agent}: the agent has not started; wait for its harness start before reading its key`);
      return keys[keys.length - 1]!;
    },
    async call(credential, c) {
      const res = await fetch(`${baseUrl}${PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "x-pomtree-request-id": c.requestId, "content-type": "application/json" },
        body: JSON.stringify(requestBody(c)),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      let error: string | undefined;
      if (res.status >= 400) {
        try {
          const e = (JSON.parse(text) as { error?: unknown }).error;
          if (typeof e === "string") error = e;
        } catch {
          /* a non-JSON error body is left in `text` */
        }
      }
      return { status: res.status, text, ...(error !== undefined && { error }), headers: res.headers };
    },
    requestBody,
    estimate(c) {
      const out = estimateOf(Buffer.from(JSON.stringify(requestBody(c))), PATH);
      if ("refuse" in out || !out.estimate?.output) throw new Error(`estimate refused the rig's own request body: ${JSON.stringify(out)}`);
      return { promptMicros: out.estimate.output.promptMicros, microsPerToken: out.estimate.output.microsPerToken, reserveMicros: out.estimate.reserveMicros };
    },
    ledger(agent) {
      return debits.ledgerFor(agent);
    },
    journalOf: (agent) => r.store.journal.read({ agent }),
    async settlements(agent) {
      return (await r.store.journal.read({ agent }))
        .map((e) => e.payload as unknown as Settlement & { kind: string })
        .filter((p) => p.kind === POMTREED_KINDS.modelSettlement);
    },
    async settlement(agent, requestId) {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const hit = (await px.settlements(agent)).find((s) => s.requestId === requestId);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`no settlement journaled for ${requestId} of ${agent} within 10 s: the proxy did not settle the call`);
        await new Promise((res) => setTimeout(res, 25));
      }
    },
    releaseHolds() {
      for (const release of releases) release();
    },
    hold: () => new Promise<void>((res) => releases.push(res)),
    async close() {
      px.releaseHolds();
      await r.orchestrator.idle().catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((res) => server.close(() => res()));
      await stub.close();
      r.store.close();
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
  return px;
}
