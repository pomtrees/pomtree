import { execFile, execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CONFIG_REGISTRY, resolveConfig } from "@pomtree/core";
import { ModelProxy, ProxyCredentialGateway, createModelProxyServer, openPiCatalog, proxyPiCredentials } from "@pomtree/pomtreed";
import type { PiCredentials } from "@pomtree/pomtreed";
import { PI_AUTH_PATH } from "@pomtree/harness-pi";
import { DOCKER_PROFILE, engineProfile, normalizeImageId } from "@pomtree/sandbox-docker";
import type { EngineProfile } from "@pomtree/sandbox-docker";
import type { Store } from "@pomtree/store-sqlite";
import { agentBindPlan, detectBridgeGateway } from "../../pomtreed/src/agent-net.ts";
import { buildModelProxyOptions, startReservationReclaim } from "../../pomtreed/src/model-proxy-options.ts";
import type { ProxySettlement } from "../../pomtreed/src/model-proxy/service.ts";

// The model path of the live scripts and Docker-gated tests: the same key-issuing proxy pomtreed runs. The agent
// gets a scoped token and the proxy URL; the real upstream key stays in this process. Reads POMTREED_MODEL_BASE_URL
// and the key file POMTREED_MODEL_UPSTREAM_KEY_FILE names (the daemon's own name and secret-file rule; never a raw key in the env, which
// every child would inherit), unless the caller passes the key it already holds as `upstreamKey`; token prices come from Pi's own catalog (POMTREED_PI_CATALOG_DIR overrides its location).
// Containers reach the proxy at host.docker.internal through the egress sidecar, so the template's egress must relay
// the proxy endpoint (policy `none` grants no relay and therefore no model path). The bind is pomtreed's own plan
// (`planAgentListen`): loopback on Docker Desktop, which forwards host.docker.internal to host loopback, the
// docker bridge gateway on Docker on Linux (reachable from containers, not from the LAN), and loopback on rootless Podman
// (its egress sidecar maps the host loopback); never a wildcard. The engine is the daemon's own selector POMTREED_SANDBOX_BACKEND.
export interface LiveModel {
  gateway: ProxyCredentialGateway;
  credentials: PiCredentials;
  bind: { host: string; port: number }; // where the proxy listens on the host (containers use host.docker.internal:port)
  close(): Promise<void>;
}

export const SANDBOX_BACKEND_ENV = "POMTREED_SANDBOX_BACKEND";
// What a harness that spawns pomtreed with a scrubbed env forwards so the daemon picks the same engine and finds its socket: every
// POMTREED_SANDBOX_* setting (the selector SANDBOX_BACKEND_ENV and the per-engine socket keys) plus the engine CLIs' own locators.
// A prefix, not the socket key names: those are registered by the sandbox backends, not by core's registry.
const ENGINE_ENV_PREFIX = "POMTREED_SANDBOX_";
const ENGINE_ENV_NAMES = ["DOCKER_HOST", "CONTAINER_HOST", "XDG_RUNTIME_DIR"];
export function engineEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v && (k.startsWith(ENGINE_ENV_PREFIX) || ENGINE_ENV_NAMES.includes(k))) out[k] = v;
  return out;
}
export const UPSTREAM_KEY_FILE_ENV = "POMTREED_MODEL_UPSTREAM_KEY_FILE";
const RETIRED_KEY_ENV = "PTREE_E2E_MODEL_KEY";

// The upstream key from the file POMTREED_MODEL_UPSTREAM_KEY_FILE names, under core's secret-file rule exactly as pomtreed reads it (absolute
// path, no group/other permission bits, non-empty, one trailing newline dropped). Errors name the file and the fix, never the contents.
export function readUpstreamKeyFile(env: Record<string, string | undefined>): string {
  const file = env[UPSTREAM_KEY_FILE_ENV];
  if (!file)
    throw new Error(`${UPSTREAM_KEY_FILE_ENV} is required: it names the upstream key file (absolute path, mode 0600); pass only the path, never the key`);
  const r = resolveConfig(CONFIG_REGISTRY, {
    env: { [UPSTREAM_KEY_FILE_ENV]: file },
    readFile: (path) => readFileSync(path, "utf8"),
    // POSIX modes only, as in pomtreed's main.ts: win32 reports a synthetic 0666 for every file.
    ...(process.platform !== "win32" && { fileMode: (path: string) => statSync(realpathSync(path)).mode }),
  });
  if (!r.ok) throw new Error(`upstream model key: ${r.errors.join("; ")}`);
  return r.values["model.upstreamKey"];
}

// The container engine the live run drives: the profile for POMTREED_SANDBOX_BACKEND, as the daemon names it. Unset or empty means
// docker; `auto` is refused because it only resolves inside pomtreed and the live helpers must know which CLI to run.
export function liveEngine(env: Record<string, string | undefined>): EngineProfile {
  const v = env[SANDBOX_BACKEND_ENV];
  if (v === undefined || v === "") return DOCKER_PROFILE;
  if (v === "docker" || v === "podman") return engineProfile(v);
  throw new Error(
    `${SANDBOX_BACKEND_ENV}=${v} is not supported by the live runs: set it to docker or podman (auto cannot tell them which CLI to use), or unset it for docker`,
  );
}

// The egress proxy image as DockerSandbox requires it: digest-pinned (`sha256:<hex>`, the local image id, resolved once per engine and name;
// Podman prints bare hex, which normalizeImageId prefixes). An already pinned reference (`name@sha256:<hex>` or `sha256:<hex>`) is returned as is.
// TODO(egress-image): this duplicates gatePinnedImage in sandbox-docker's docker-gate.ts, which imports node:test and so cannot be used from a non-test helper; replace it once sandbox-docker exports a resolver outside the test gate.
const pinnedImages = new Map<string, string>();
export function pinnedImage(image: string, engine: EngineProfile = DOCKER_PROFILE): string {
  if (/^sha256:[0-9a-f]{64}$/.test(image) || /@sha256:[0-9a-f]{64}$/.test(image)) return image;
  const key = `${engine.id}:${image}`;
  let id = pinnedImages.get(key);
  if (id === undefined) {
    const raw = execFileSync(engine.binary, ["image", "inspect", "--format", "{{.Id}}", image], { encoding: "utf8", timeout: 10_000 }).trim();
    id = normalizeImageId(engine, raw);
    if (id === undefined) throw new Error(`${engine.binary} image inspect ${image} returned ${JSON.stringify(raw)}, not a sha256 image id`);
    pinnedImages.set(key, id);
  }
  return id;
}

const engineExec = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => execFile(cmd, args, { timeout: 10_000 }, (e, out) => (e ? reject(e) : resolve(out))));

export async function startLiveModel(o: {
  store: Pick<Store, "journal" | "registry" | "modelDebit">;
  secret: string;
  stateDir: string;
  provider: string | undefined;
  env: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch; // optional injection (counting/guard wrapper); default unchanged
  platform?: string; // test seam for the bind plan; default process.platform
  gateway?: string; // test seam: the bridge gateway; default detected from the Docker CLI on Linux (Podman binds loopback and needs none)
  // Settlement hook. Default: pomtreed's own sink (`settlementSink`) over `store`, so every call's metadata lands on its debit
  // ledger row and one `ext.pomtreed.model_settlement` entry is journaled, exactly as in the daemon. Override only to observe or
  // (in a negative control) to disable it.
  onSettlement?: (e: ProxySettlement) => void;
  host?: string; // journal host for settlement entries; default each agent record's own host
  upstreamKey?: string; // the key, for a caller that already read it from its own key file; default readUpstreamKeyFile(env)
}): Promise<LiveModel> {
  const need = (k: string): string => {
    const v = o.env[k];
    if (!v) throw new Error(`${k} is required: the live model path is the key-issuing proxy`);
    return v;
  };
  if (!o.provider) throw new Error("POMTREED_PI_PROVIDER is required: the scoped credential is written for one provider");
  if (o.env[RETIRED_KEY_ENV] !== undefined)
    throw new Error(`${RETIRED_KEY_ENV} is retired (a raw key in the env reaches every child): write the key to a 0600 file and set ${UPSTREAM_KEY_FILE_ENV}`);
  const engine = liveEngine(o.env);
  const upstreamKey = o.upstreamKey ?? readUpstreamKeyFile(o.env);
  const catalog = openPiCatalog(o.env, o.provider);
  if (!catalog.found) console.error(catalog.message);
  const debits = o.store.modelDebit({ secret: o.secret });
  const {
    proxy: proxyOptions,
    tokenTtlMs,
    upstreamTimeoutMs,
  } = buildModelProxyOptions({
    env: o.env,
    provider: o.provider,
    upstream: { baseUrl: need("POMTREED_MODEL_BASE_URL"), key: upstreamKey },
    catalog,
    debits,
    registry: o.store.registry,
    journal: o.store.journal,
    ...(o.host !== undefined && { host: o.host }),
    ...(o.fetch && { fetch: o.fetch }),
    ...(o.onSettlement && { onSettlement: o.onSettlement }),
  });
  const proxy = new ModelProxy(proxyOptions);
  const reclaim = startReservationReclaim(debits, upstreamTimeoutMs, (m) => console.error(m));
  const platform = o.platform ?? process.platform;
  const plan = await agentBindPlan(platform, async () => o.gateway ?? detectBridgeGateway(engineExec, false, engine), engine);
  if (plan.warning) console.error(plan.warning);
  const server: Server = createModelProxyServer(proxy);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, plan.mode === "off" ? "127.0.0.1" : plan.host, resolve);
  });
  server.unref();
  const { address: host, port } = server.address() as AddressInfo;
  return {
    bind: { host, port },
    gateway: new ProxyCredentialGateway({
      journal: o.store.journal,
      registry: o.store.registry,
      secret: o.secret,
      proxyBaseUrl: `http://host.docker.internal:${port}`,
      tokenTtlMs,
      debits,
    }),
    credentials: proxyPiCredentials({ stateDir: o.stateDir, containerAuthPath: PI_AUTH_PATH, provider: o.provider }),
    close: () => {
      clearInterval(reclaim);
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
