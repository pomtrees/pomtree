import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_REGISTRY } from "@pomtree/core";
import { GETTING_STARTED_BEGIN, GETTING_STARTED_END } from "./getting-started.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SKILL = join(ROOT, ".agents", "skills", "pomtree-onboarding");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));

// A registry key path as a whole token: not part of a longer dotted/path/word run.
function keyLeaks(text: string): string[] {
  return CONFIG_REGISTRY.params.map((p) => p.path).filter((path) => new RegExp(`(?<![\\w./-])${path.replaceAll(".", "\\.")}(?![\\w-])`).test(text));
}
function leaks(text: string): string[] {
  return /POMTREED_/.test(text) ? ["POMTREED_", ...keyLeaks(text)] : keyLeaks(text);
}

// Environment names in a text that are not the registry's (a name or its _FILE form); a registry name is allowed in the generated section.
const REGISTRY_ENV = new Set(CONFIG_REGISTRY.envOf.values());
function unknownEnvNames(text: string): string[] {
  return [...text.matchAll(/POMTREED_\w+/g)]
    .map((m) => m[0])
    .filter((n) => !(REGISTRY_ENV.has(n) || (n.endsWith("_FILE") && REGISTRY_ENV.has(n.slice(0, -"_FILE".length)))));
}

test("no file in the skill names a POMTREED_ variable or a config key path", () => {
  for (const f of files(SKILL)) assert.deepEqual(leaks(readFileSync(f, "utf8")), [], f);
});

test("the generated section of GETTING_STARTED.md names only registry environment names and no config key path", () => {
  const doc = readFileSync(join(ROOT, "GETTING_STARTED.md"), "utf8");
  const section = doc.slice(doc.indexOf(GETTING_STARTED_BEGIN), doc.indexOf(GETTING_STARTED_END));
  assert.ok(section.length > GETTING_STARTED_BEGIN.length);
  assert.deepEqual(unknownEnvNames(section), []);
  assert.deepEqual(keyLeaks(section), []);
  const egressEnv = CONFIG_REGISTRY.envOf.get("agent.egressProxyImage") as string;
  assert.ok(section.includes(`unset ${egressEnv}`), "the build-image step quotes the registry's env name");
});

test("the env-name check accepts a registry name and its _FILE form and rejects a made-up one (negative control)", () => {
  const name = CONFIG_REGISTRY.envOf.get("agent.egressProxyImage") as string;
  assert.deepEqual(unknownEnvNames(`unset ${name} and ${name}_FILE`), []);
  assert.deepEqual(unknownEnvNames("set POMTREED_MADE_UP_NAME and POMTREED_MADE_UP_NAME_FILE"), ["POMTREED_MADE_UP_NAME", "POMTREED_MADE_UP_NAME_FILE"]);
});

test("the leak check catches a variable and a key path (negative control)", () => {
  assert.deepEqual(leaks("set POMTREED_STATE_DIR"), ["POMTREED_"]);
  const key = CONFIG_REGISTRY.params[0]?.path as string;
  assert.deepEqual(leaks(`use ${key} here`), [key]);
  assert.deepEqual(leaks(`see ${key}x and a/${key}`), []);
});

test("SKILL.md stays under 500 lines and its name is the directory name", () => {
  const text = readFileSync(join(SKILL, "SKILL.md"), "utf8");
  assert.ok(text.split("\n").length <= 500);
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
  assert.equal(/^name: (.+)$/m.exec(front)?.[1], "pomtree-onboarding");
  assert.match(front, /^description: .*explicitly/m);
});

test("the skill is explicit-invocation only for Claude Code and Codex", () => {
  assert.match(readFileSync(join(SKILL, "SKILL.md"), "utf8"), /^disable-model-invocation: true$/m);
  assert.match(readFileSync(join(SKILL, "agents", "openai.yaml"), "utf8"), /^policy:\n {2}allow_implicit_invocation: false$/m);
});
