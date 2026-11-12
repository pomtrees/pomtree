// `pnpm conformance:sandbox <extension dir> [--backend <id>] [--accept-closed]`: runs the sandbox conformance suite against a backend
// contributed by an extension, through the daemon's own path. In order: parse `<dir>/manifest.json` with the daemon's `parseManifest`
// (its message is printed verbatim on failure); pin the directory (`measureExtensionTree`, printed as the `sandbox.reviewedBackends`
// entry); load the provider with `SandboxProviderLoader` and the installed resolve guard in a scratch configuration that pins only that
// entry; build the provider's deps through the daemon's facade (`createSandboxBackendDeps`); run every clause and the suite floor; print
// each result, the summary line and the floor line; exit 0 only when nothing failed and the floor holds.
//
// Location: the original plan places this script at packages/testing/scripts. It lives in packages/pomtreed
// instead because it must import the daemon's parser and loader, and @pomtree/testing may not depend on @pomtree/pomtreed (pomtreed
// already has testing as a dev dependency, so the reverse edge would be a cycle). Reopen when pomtree publishes packages: the entry
// point then moves into the published testing package.
//
// Offline by design: the deps' `fetch` and `request` reach only loopback hosts (a descriptor's `conformance.mts` may start a local
// loopback provider), every declared credential reads a sentinel value, and config is the manifest params' defaults. A backend that
// needs what this command cannot supply (a live endpoint, a local engine) is gated with a printed reason, by its conformance.mts
// returning a `gate`, or here when the loader reports the `run` dep; a gated run exits non-zero unless `--accept-closed` is passed,
// because a run in which nothing ran proves nothing.
//
// `<dir>/conformance.mts` (optional, inside the pinned tree, so it is loaded from the reviewed bytes under the same guard) default-exports
// `({ provider, deps, base }) => SandboxUnderTest`, where `base` is the descriptor built here; it returns `base` with the hooks, gate or
// options its backend needs.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_FETCH_USER_AGENT, sandboxCredentialEnv, secretFileEnv } from "@pomtree/core";
import type { ExtensionManifest, SandboxBackendDeps, SandboxBackendProvider, SandboxRequester } from "@pomtree/core";
import { createRequest } from "@pomtree/sandbox-kit";
import {
  coverageCounts,
  coverageTableFindings,
  effectiveCapabilities,
  evaluateSandboxConformance,
  SANDBOX_CAPABILITY_COVERAGE,
  SANDBOX_CONFORMANCE_CLAUSES,
  suiteFloorFindings,
} from "@pomtree/testing";
import type { SandboxUnderTest } from "@pomtree/testing";
import { parseManifest } from "../src/extension-manifest.ts";
import { createSandboxBackendDeps } from "../src/sandbox-backend-deps.ts";
import { installResolveGuard, measureExtensionTree, SandboxProviderLoader } from "../src/sandbox-provider-load.ts";

export const USAGE = "usage: pnpm conformance:sandbox <extension dir> [--backend <id>] [--accept-closed]";

export interface ConformanceCommandIo {
  out(line: string): void;
  err(line: string): void;
  // The directory a relative <extension dir> resolves against (pnpm runs root scripts from the repo root; INIT_CWD is where it was typed).
  cwd: string;
  // Test seam: runs after the pin is computed and before the loader re-measures and imports (a tampered file must then be refused).
  afterPin?(dir: string): void;
}

interface Args {
  dir: string;
  backend?: string;
  acceptClosed: boolean;
}

function parseArgs(argv: readonly string[]): Args | string {
  let dir: string | undefined;
  let backend: string | undefined;
  let acceptClosed = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--backend") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return "--backend needs a backend id";
      backend = v;
    } else if (a === "--accept-closed") acceptClosed = true;
    else if (a.startsWith("--")) return `unknown option ${a}`;
    else if (dir === undefined) dir = a;
    else return `unexpected argument ${a}; pass one extension directory`;
  }
  if (dir === undefined) return "missing the extension directory";
  return { dir, acceptClosed, ...(backend !== undefined && { backend }) };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
function assertLoopback(id: string, url: string): void {
  const host = new URL(url).hostname;
  if (!LOOPBACK_HOSTS.has(host))
    throw new Error(
      `sandbox backend ${id} called ${host} during an offline conformance run; only loopback hosts are reachable here, so point the backend at a local loopback provider from conformance.mts`,
    );
}
const urlOf = (input: Parameters<typeof fetch>[0]): string => (input instanceof Request ? input.url : String(input));

// The backend's deps through the daemon's facade: loopback-only transports stamped with the default fetch identity, sentinel credentials.
function offlineDeps(provider: SandboxBackendProvider, io: ConformanceCommandIo): SandboxBackendDeps {
  const id = provider.id;
  const env: Record<string, string> = {};
  for (const name of provider.credentials) env[secretFileEnv(sandboxCredentialEnv(id, name))] = `/conformance-sentinel/${name}`;
  const kit = createRequest({ userAgent: DEFAULT_FETCH_USER_AGENT });
  const request = Object.assign(
    async (url: string, init: Parameters<SandboxRequester>[1]) => {
      assertLoopback(id, url);
      return kit(url, init);
    },
    {
      openWebSocket: (url: string, init?: Parameters<SandboxRequester["openWebSocket"]>[1]) => {
        assertLoopback(id, url);
        return kit.openWebSocket(url, init);
      },
    },
  ) as SandboxRequester;
  return createSandboxBackendDeps({
    id,
    credentials: provider.credentials,
    config: Object.fromEntries(provider.params.flatMap((p) => (p.default === undefined ? [] : [[p.key, p.default]]))),
    userAgent: DEFAULT_FETCH_USER_AGENT,
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assertLoopback(id, urlOf(input));
      return fetch(input, init);
    }) as typeof fetch,
    request,
    env,
    readSecretFile: (path) => ({ mode: 0o600, content: `conformance-sentinel-${id}-${path.slice(path.lastIndexOf("/") + 1)}` }),
    log: (event, fields) => io.err(`backend log: ${event} ${JSON.stringify(fields)}`),
    now: () => Date.now(),
    declaresRun: false,
  });
}

function pickBackend(manifest: ExtensionManifest, wanted: string | undefined): string {
  const ids = (manifest.provides ?? []).filter((p) => p.kind === "sandbox").map((p) => p.id);
  if (ids.length === 0) throw new Error(`extension ${manifest.name} provides no sandbox backend; add a provides entry of kind "sandbox" to its manifest.json`);
  if (wanted !== undefined) {
    if (!ids.includes(wanted))
      throw new Error(`extension ${manifest.name} does not provide sandbox backend ${wanted} (it provides ${ids.join(", ")}); fix --backend`);
    return wanted;
  }
  if (ids.length > 1) throw new Error(`extension ${manifest.name} provides several sandbox backends (${ids.join(", ")}); choose one with --backend <id>`);
  return ids[0] as string;
}

// Runs the command and returns its exit code: 0 conformant, 1 a clause or the floor failed (or the run was gated), 2 the extension
// could not be read, parsed, pinned or loaded.
export async function conformanceCommand(argv: readonly string[], io: ConformanceCommandIo): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    io.err(`conformance:sandbox: ${args}`);
    io.err(USAGE);
    return 2;
  }
  const dir = isAbsolute(args.dir) ? args.dir : resolve(io.cwd, args.dir);
  const manifestPath = join(dir, "manifest.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (e) {
    io.err(
      `conformance:sandbox: cannot read ${manifestPath} (${e instanceof Error ? e.message : String(e)}); pass the directory that holds the extension's manifest.json`,
    );
    return 2;
  }
  let manifest: ExtensionManifest;
  try {
    manifest = parseManifest(raw);
  } catch (e) {
    io.err(`conformance:sandbox: the daemon's manifest parser refused ${manifestPath}:`);
    io.err(e instanceof Error ? e.message : String(e));
    io.err("fix manifest.json; the daemon would refuse to load this extension for the same reason");
    return 2;
  }

  const guard = installResolveGuard();
  try {
    let sut: SandboxUnderTest;
    try {
      const id = pickBackend(manifest, args.backend);
      const pin = measureExtensionTree(dir);
      io.out(`pin: ${id}=${pin.hash}`);
      io.afterPin?.(pin.dir);
      const loader = new SandboxProviderLoader({ extensions: [{ dir, manifest }], reviewedBackends: [`${id}=${pin.hash}`], guard });
      const loaded = await loader.load(id);
      const deps = offlineDeps(loaded.provider, io);
      const why = loaded.run
        ? `backend ${id} declares the run dep (a local engine), which this offline command does not provide; run the engine's own gated suite`
        : undefined;
      const base: SandboxUnderTest = {
        name: id,
        capabilities: loaded.provider.declaration,
        make: async () => ({ sandbox: loaded.provider.create(deps) }),
        ...(why !== undefined && { gate: () => why }),
      };
      sut = base;
      if (pin.contents.has("conformance.mts")) {
        const mod = (await import(pathToFileURL(join(loaded.dir, "conformance.mts")).href)) as { default?: unknown };
        if (typeof mod.default !== "function")
          throw new Error(`${join(loaded.dir, "conformance.mts")} must default-export ({ provider, deps, base }) => descriptor; add the default export`);
        sut = await (mod.default as (ctx: object) => SandboxUnderTest | Promise<SandboxUnderTest>)({ provider: loaded.provider, deps, base });
      }
    } catch (e) {
      io.err(`conformance:sandbox: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }

    const report = await evaluateSandboxConformance(sut);
    for (const r of report.results) {
      if (r.status === "passed") io.out(`PASS ${r.id}`);
      else if (r.status === "failed") io.out(`FAIL ${r.id}: ${r.error.message}`);
      else io.out(`${r.status.toUpperCase()} ${r.id}: ${r.reason}`);
    }
    io.out(`CONFORMANCE ${sut.name}: ${report.summary}`);

    // The floor, as runSandboxConformance applies it after a full run.
    const table = SANDBOX_CAPABILITY_COVERAGE;
    const counts = coverageCounts(table);
    io.out(`CONFORMANCE ${sut.name} floor: ${counts.covered} capabilities covered, ${counts.deferred} deferred`);
    const problems = coverageTableFindings(table);
    const gated = report.results.filter((r) => r.status === "gated");
    if (gated.length > 0) {
      if (!args.acceptClosed)
        problems.push(
          `conformance for ${sut.name}: ${gated.length} check(s) were gated, so the run proves nothing; open the gate, or pass --accept-closed if a closed environment is expected here`,
        );
    } else {
      const eff = await effectiveCapabilities(sut);
      problems.push(
        ...suiteFloorFindings({
          name: sut.name,
          declared: [...eff.declared].filter((c) => !eff.withheld.has(c)),
          results: report.results,
          table,
          clauseIds: SANDBOX_CONFORMANCE_CLAUSES.map((c) => c.id),
        }),
      );
    }
    for (const p of problems) io.out(`FLOOR ${p}`);
    return report.results.some((r) => r.status === "failed") || problems.length > 0 ? 1 : 0;
  } finally {
    guard.deregister();
  }
}

const invoked = process.argv[1] !== undefined && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  process.exitCode = await conformanceCommand(process.argv.slice(2), {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    cwd: process.env.INIT_CWD ?? process.cwd(),
  });
}
