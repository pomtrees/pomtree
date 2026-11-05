import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_REGISTRY, type ConfigRegistry, extendRegistry, parseExtensionParams } from "@pomtree/core";
import { ROOT } from "./env-scan.ts";

// The core registry composed with the real examples/hn-digest manifest, exactly as pomtreed composes a present hn-digest extension:
// the digest's `ext.hnDigest.*` names live only in that manifest, so the
// env lint tests judge names against this registry, not CONFIG_REGISTRY alone.
export function digestComposedRegistry(): ConfigRegistry {
  const manifest = JSON.parse(readFileSync(join(ROOT, "examples", "hn-digest", "manifest.json"), "utf8")) as { name: string; params: unknown };
  const parsed = parseExtensionParams(manifest.name, manifest.params);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return extendRegistry(CONFIG_REGISTRY, [{ name: manifest.name, params: parsed.params }]);
}
