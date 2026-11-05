#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatBuildIdentity, REVISION_FILE, resolveBuildIdentity } from "@pomtree/core";
import { createInterface } from "node:readline/promises";
import { metaAction, run } from "./cli.ts";
import { httpTransport, socketTransport } from "./client.ts";
import type { Transport } from "./client.ts";
import { tokenFileProblem } from "./token-file.ts";

const env = process.env;
const argv = process.argv.slice(2);
const out = (s: string) => console.log(s);
const err = (s: string) => console.error(s);
const isTTY = process.stdout.isTTY;
// Build identity (core build-identity.ts), printed by `--version` as `v0.1.0 (abc1234)`. Inside the agent image the build
// bakes /opt/pomtree/pomtree/revision (short git sha) and its sibling `version` (the root package.json version): the baked
// revision wins and the image carries no dirty flag. From source: the root package.json version, the export tool's repo-root
// REVISION file if present, else git (an asterisk marks a dirty checkout). POMTREE_REVISION_FILE is the test seam (same pattern
// as POMTREED_STATE_DIR); its sibling `version` file moves with it. Resolved lazily: only `--version` pays for the git calls.
const revisionFile = env.POMTREE_REVISION_FILE ?? "/opt/pomtree/pomtree/revision";
const readOptional = (file: string | URL): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};
const packageVersion = (file: URL): string | undefined => {
  try {
    return (JSON.parse(readOptional(file) ?? "{}") as { version?: string }).version;
  } catch {
    return undefined;
  }
};
const repoRoot = new URL("../../../", import.meta.url);
const buildVersion = (): string => {
  const baked = readOptional(revisionFile);
  return formatBuildIdentity(
    resolveBuildIdentity(
      baked !== undefined
        ? {
            version: readOptional(join(dirname(revisionFile), "version")) ?? packageVersion(new URL("../package.json", import.meta.url)),
            stamped: baked,
            git: () => undefined,
          }
        : {
            version: packageVersion(new URL("package.json", repoRoot)) ?? packageVersion(new URL("../package.json", import.meta.url)),
            stamped: readOptional(new URL(REVISION_FILE, repoRoot)),
            git: (args) => {
              try {
                return execFileSync("git", args, { cwd: fileURLToPath(repoRoot), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
              } catch {
                return undefined;
              }
            },
          },
    ),
  );
};

// Help/version/bare invocations need no configuration; skip token/socket setup for them.
const meta = metaAction(argv) !== null;

let call: Transport;
if (meta) {
  call = async () => {
    throw new Error("no daemon call for help/version");
  };
} else {
  const stateDir = env.POMTREED_STATE_DIR ?? join(homedir(), ".pomtreed");
  const api = env.POMTREE_API;
  const socket = env.POMTREE_SOCKET ?? join(stateDir, "pomtreed.sock");
  let token = env.POMTREE_TOKEN;
  if (!token && !api && !env.POMTREE_SOCKET && !existsSync(join(stateDir, "operator.token"))) {
    console.error(
      "pomtree: not configured: set POMTREE_TOKEN and POMTREE_API (or POMTREE_SOCKET), or run where pomtreed's state dir (~/.pomtreed) is readable",
    );
    process.exit(2);
  }
  if (!token) {
    const file = join(stateDir, "operator.token");
    let fd: number;
    try {
      fd = openSync(file, "r");
    } catch {
      console.error(`pomtree: no POMTREE_TOKEN set and cannot read ${file}`);
      process.exit(4);
    }
    try {
      const problem = tokenFileProblem(fstatSync(fd), process.getuid?.(), file); // fstat the open fd: no check/use race
      if (problem) {
        console.error(`pomtree: ${problem}`);
        process.exit(4);
      }
      token = readFileSync(fd, "utf8").trim();
    } finally {
      closeSync(fd);
    }
  }
  call = api ? httpTransport(api, token) : socketTransport(socket, token);
}

const confirm = process.stdin.isTTY
  ? async (question: string): Promise<boolean> => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    }
  : undefined;

process.exitCode = await run(argv, {
  call,
  out,
  err,
  isTTY,
  get version() {
    return buildVersion();
  },
  env,
  confirm,
});
