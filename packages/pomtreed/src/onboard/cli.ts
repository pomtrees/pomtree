// The thin shell of `pomtreed preflight` and `pomtreed init`: the real command runner (child_process, per-command timeout), the real
// filesystem and the checkout facts, handed to the pure modules. No logic worth testing lives here.
import { execFile, execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathLoose } from "../safety-boot.ts";
import { defaultSetupFacts } from "./facts.ts";
import { type InitIo, type LStat, runInit } from "./init.ts";
import { runPreflight } from "./preflight.ts";
import type { FileStat, ProbeResult, ProbeRunner } from "./probes.ts";
import { onboardingSteps } from "./steps.ts";
import { checkTemplateFiles } from "./template-check.ts";

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const DEFAULT_TIMEOUT_MS = 5000;
// Maps execFile's callback to a ProbeResult. A numeric exit code is a real answer; a string code (ENOENT, EACCES), a signal (timeout kill)
// or no code means it never answered, and a string code is kept as `spawnError` so findings can tell "not on PATH" from "cannot be run".
export function execResult(err: Error | null, stdout: string, stderr: string): ProbeResult {
  if (err === null) return { code: 0, stdout, stderr };
  const c = (err as { code?: unknown }).code;
  if (typeof c === "number") return { code: c, stdout, stderr };
  return { code: null, stdout, stderr, ...(typeof c === "string" && { spawnError: c }) };
}

const realRunner: ProbeRunner = {
  run: (command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, cwd, env } = {}) =>
    new Promise<ProbeResult>((resolve) => {
      const options = {
        timeout: timeoutMs,
        encoding: "utf8" as const,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        ...(cwd !== undefined && { cwd }),
        ...(env !== undefined && { env: { ...process.env, ...env } }),
      };
      execFile(command, [...args], options, (err, stdout, stderr) => {
        resolve(execResult(err, String(stdout ?? ""), String(stderr ?? "")));
      });
    }),
};

function stat(path: string): FileStat | null {
  try {
    const s = statSync(path);
    return { mode: s.mode, uid: s.uid, isDirectory: s.isDirectory() };
  } catch {
    return null;
  }
}

function lstat(path: string): LStat | null {
  try {
    const s = lstatSync(path);
    return { mode: s.mode, uid: s.uid, isDirectory: s.isDirectory(), isSymlink: s.isSymbolicLink(), isFile: s.isFile(), dev: s.dev, ino: s.ino };
  } catch {
    return null;
  }
}

export function isGitRepo(dir: string): boolean {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--git-dir"], { timeout: DEFAULT_TIMEOUT_MS, stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export const realIo: InitIo = {
  // O_NOFOLLOW refuses a symlink swapped in after the lstat (ELOOP), O_NONBLOCK keeps a swapped-in FIFO from blocking the open,
  // and the fstat compares the opened file with the one lstat saw.
  readText: (path, expected) => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.dev !== expected.dev || s.ino !== expected.ino)
        throw new Error(`${path} is no longer the regular file init checked (it was replaced)`);
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  },
  lstat,
  mkdirp: (dir, mode) => void mkdirSync(dir, { recursive: true, mode }),
  // A temp file in the same directory (exclusive create, so it cannot follow a planted link), then rename over the target:
  // a symlink at `path` is replaced, never written through, and a crash leaves the old file or the new one.
  writeText: (path, content, mode) => {
    const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
    try {
      writeFileSync(tmp, content, { mode, flag: "wx" });
      renameSync(tmp, path);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        // no temp file to remove
      }
      throw e;
    }
  },
  createEmpty: (path, mode) => closeSync(openSync(path, "wx", mode)), // exclusive: never touches an existing file or link
};

export async function runOnboardCommand(command: "preflight" | "init", rest: readonly string[]): Promise<number> {
  const uid = process.platform === "win32" ? null : (process.getuid?.() ?? null);
  const defaultStateDir = join(homedir(), ".pomtreed");
  let result: { code: number; lines: string[] };
  try {
    if (command === "preflight") {
      const facts = defaultSetupFacts(readFileSync(join(CHECKOUT, "package.json"), "utf8"));
      result = await runPreflight(rest, {
        runner: realRunner,
        steps: onboardingSteps(facts),
        host: {
          platform: process.platform,
          nodeVersion: process.version,
          uid,
          facts,
          checkout: CHECKOUT,
          stateDir: defaultStateDir,
          image: facts.defaultImage,
          stat,
          realpath: realpathLoose,
        },
      });
    } else {
      result = await runInit(rest, {
        facts: defaultSetupFacts(readFileSync(join(CHECKOUT, "package.json"), "utf8")),
        realpath: realpathLoose,
        checkTemplates: checkTemplateFiles,
        io: realIo,
        defaultOut: join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pomtreed"),
        defaultStateDir,
        checkout: CHECKOUT,
        isGitRepo,
        node: process.execPath,
        uid,
        readAnswers: (path) => readFileSync(path, "utf8"),
        readServiceTemplate: () => readFileSync(join(CHECKOUT, "deploy", "pomtreed.service"), "utf8"),
      });
    }
  } catch (e) {
    console.error(`pomtreed ${command}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const print = result.code === 0 || command === "preflight" ? console.log : console.error;
  for (const line of result.lines) print(line);
  return result.code;
}
