import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { parseCatalogFile, parseStoreOverlay, ratesSourceOf } from "./rates.ts";
import type { ModelRates, RatesSource } from "./rates.ts";

// Thin fs shell over rates.ts: reads the pinned Pi's built-in catalog data plus Pi's `models-store.json` overlay.
// The files are read directly (fs + JSON.parse) because pi-ai's package exports hide them. Only the managed Pi
// install layout is understood (target only the pinned Pi, no other layouts).
//
// TODO(catalog-custom-models): `models.json` custom providers and per-model `cost` overrides are not read. Current
// behavior: a model defined or repriced only there is unknown here, so it charges the provider-reported cost or the
// per-request maximum (fail closed).

export const CATALOG_DIR_ENV = "POMTREED_PI_CATALOG_DIR";
const DATA_SUBPATH = ["node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data"];

export interface PiCatalog {
  dir: string;
  source: RatesSource;
  // Entries loaded per requested provider.
  entries: Map<string, number>;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

// The catalog data directory, or null when it cannot be found. `override` (pi.catalogDir; "" = unset) wins; when it is
// omitted the env map's POMTREED_PI_CATALOG_DIR stands in for it (TODO(config-registry): that fallback serves only the e2e live
// composition and examples/hn-digest, which pass an env map; pomtreed passes the resolved value). `env` otherwise supplies PATH. Otherwise the `pi` on
// PATH is Pi's managed launcher: its realpath is `<agent>/bin/pi`, and `<agent>/install/current-version` names the
// release whose node_modules hold pi-ai.
export function discoverCatalogDir(env: Record<string, string | undefined>, override = env[CATALOG_DIR_ENV] ?? ""): string | null {
  if (override !== "") return override;
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, "pi");
    if (!existsSync(candidate)) continue;
    try {
      const agentDir = dirname(dirname(realpathSync(candidate)));
      const version = readFileSync(join(agentDir, "install", "current-version"), "utf8").trim();
      return join(agentDir, "install", "releases", version, ...DATA_SUBPATH);
    } catch {}
    return null;
  }
  return null;
}

export function piAgentDir(env: Record<string, string | undefined>, home = homedir()): string {
  return env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
}

// Loads rates for the given providers. Returns null when the data directory is unusable (missing or unreadable
// provider file), so the caller can warn and run fail-closed; an absent or broken overlay just contributes nothing.
export function loadPiCatalog(o: { dir: string; providers: string[]; storePath?: string }): PiCatalog | null {
  let generatedAt: number | undefined;
  try {
    const t = Date.parse((readJson(join(o.dir, ".manifest.json")) as { generatedAt?: string }).generatedAt ?? "");
    generatedAt = Number.isNaN(t) ? undefined : t;
  } catch {}
  let store: Record<string, unknown> = {};
  if (o.storePath) {
    try {
      const parsed = readJson(o.storePath);
      if (typeof parsed === "object" && parsed !== null) store = parsed as Record<string, unknown>;
    } catch {}
  }
  const byProvider = new Map<string, Map<string, ModelRates>>();
  const entries = new Map<string, number>();
  for (const provider of o.providers) {
    let models: Map<string, ModelRates>;
    try {
      models = parseCatalogFile(readJson(join(o.dir, `${provider}.json`)));
    } catch {
      return null;
    }
    for (const [id, rates] of parseStoreOverlay(store[provider], generatedAt)) models.set(id, rates);
    byProvider.set(provider, models);
    entries.set(provider, models.size);
  }
  return { dir: o.dir, source: ratesSourceOf(byProvider), entries };
}

// Startup wiring for one provider: the rates source plus the single log line main.ts prints. A missing catalog is a
// warning, not an error: the source then knows no model, so every request charges the provider-reported cost or the
// per-request maximum (fail closed).
export function openPiCatalog(
  env: Record<string, string | undefined>,
  provider: string,
  home = homedir(),
  catalogDir?: string, // pi.catalogDir; see discoverCatalogDir
): { rates: RatesSource; message: string; found: boolean } {
  const dir = discoverCatalogDir(env, catalogDir);
  const catalog = dir ? loadPiCatalog({ dir, providers: [provider], storePath: join(piAgentDir(env, home), "models-store.json") }) : null;
  if (catalog)
    return {
      rates: catalog.source,
      found: true,
      message: `pomtreed: pi model catalog ${catalog.dir} (${catalog.entries.get(provider)} ${provider} models priced)`,
    };
  return {
    rates: { lookup: () => null },
    found: false,
    message: `pomtreed: WARNING: Pi model catalog not found${dir ? ` at ${dir}` : ` (no managed pi on PATH; set ${CATALOG_DIR_ENV})`}; requests without provider-reported cost charge the per-request maximum`,
  };
}
