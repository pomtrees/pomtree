import { ECOSYSTEMS, normalize, type Ecosystem, type EnvManifest } from "./manifest.ts";

const REGISTRY_HOSTS: Record<Ecosystem, string[]> = {
  npm: ["registry.npmjs.org"],
  pip: ["pypi.org", "files.pythonhosted.org"],
  // verify: crates.io itself is only needed for login/publish/API calls; the sparse index and downloads use the two hosts below.
  cargo: ["index.crates.io", "static.crates.io", "crates.io"],
};

// Registry hostnames the sandbox needs for the ecosystems the manifest actually uses.
// The allowlist covers registry hosts only. Host-side web_fetch is scoped separately (webFetchScope in pomtreed's
// ext-gateway.ts: allowlist templates get exactly their hosts, everything else is refused), and the staged auth.json
// holds only a scoped per-agent proxy token, never the operator's credentials.
export function registryAllowlist(manifest: EnvManifest): string[] {
  const n = normalize(manifest);
  return [...new Set(ECOSYSTEMS.filter((e) => n.ecosystems[e]).flatMap((e) => REGISTRY_HOSTS[e]))].sort();
}
