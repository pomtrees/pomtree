// The production CaptureParser (core ports.ts): every untrusted body the broker must interpret (a robots.txt, a Wayback availability
// answer) is parsed in a separate, short-lived child process running parser-child.ts, never inside pomtreed, which will hold the
// signing key (decision C9, L1). The child is process.execPath on a TypeScript file (Node strips the types natively), with an empty
// environment (no secrets), the input bounded and sent over stdin, a deadline that kills it, and a bounded answer on stdout. A crash,
// a timeout, an oversized input or a malformed answer rejects; the broker settles that as capture_failed. pomtreed parses only the
// child's own bounded JSON answer, never the body.
// TODO(capture-broker): S2 replaces this with the agent-image capture worker (parse-only mode)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CaptureParser, RobotsEvidence } from "@pomtree/core";

export const PARSER_TIMEOUT_MS = 5_000;
export const PARSER_MAX_INPUT_BYTES = 1024 * 1024; // above robots.txt's 500 KiB parse limit and the 64 KiB Wayback answer
const PARSER_MAX_OUTPUT_BYTES = 64 * 1024;
const CHILD = fileURLToPath(new URL("./parser-child.ts", import.meta.url));

// Why a parser call failed; `cause` is the BROWSER_FAILURE_CAUSES token the broker reports (capture_failed).
export class CaptureParserError extends Error {
  readonly failureCause: "deadline" | "killed";
  constructor(message: string, cause: "deadline" | "killed") {
    super(message);
    this.name = "CaptureParserError";
    this.failureCause = cause;
  }
}

export interface ProcessCaptureParserOptions {
  timeoutMs?: number;
  maxInputBytes?: number;
  script?: string; // the child script (tests point it at a misbehaving one); default parser-child.ts
}

export class ProcessCaptureParser implements CaptureParser {
  private readonly timeoutMs: number;
  private readonly maxInputBytes: number;
  private readonly script: string;
  constructor(o: ProcessCaptureParserOptions = {}) {
    this.timeoutMs = o.timeoutMs ?? PARSER_TIMEOUT_MS;
    this.maxInputBytes = o.maxInputBytes ?? PARSER_MAX_INPUT_BYTES;
    this.script = o.script ?? CHILD;
  }

  async robots(i: { body: Uint8Array; tokens: string[]; path: string }): Promise<Pick<RobotsEvidence, "verdict" | "rule">> {
    const a = await this.run({ method: "robots", body: i.body, tokens: i.tokens, path: i.path });
    const o = a as { verdict?: unknown; rule?: unknown } | null;
    if (o === null || typeof o !== "object" || (o.verdict !== "allow" && o.verdict !== "disallow") || !(o.rule === null || typeof o.rule === "string"))
      throw new CaptureParserError("capture parser returned a malformed robots verdict", "killed");
    return { verdict: o.verdict, rule: o.rule };
  }

  async waybackAvailability(i: { body: Uint8Array }): Promise<{ url: string; timestamp: string; archivedAt: number } | null> {
    const a = await this.run({ method: "waybackAvailability", body: i.body });
    if (a === null) return null;
    const o = a as { url?: unknown; timestamp?: unknown; archivedAt?: unknown };
    if (typeof o !== "object" || typeof o.url !== "string" || typeof o.timestamp !== "string" || typeof o.archivedAt !== "number")
      throw new CaptureParserError("capture parser returned a malformed wayback answer", "killed");
    return { url: o.url, timestamp: o.timestamp, archivedAt: o.archivedAt };
  }

  private run(req: { method: string; body: Uint8Array; tokens?: string[]; path?: string }): Promise<unknown> {
    if (req.body.byteLength > this.maxInputBytes)
      return Promise.reject(
        new CaptureParserError(`capture parser input is ${req.body.byteLength} bytes, over the ${this.maxInputBytes}-byte bound`, "killed"),
      );
    const input = JSON.stringify({ ...req, body: Buffer.from(req.body).toString("base64") });
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", this.script], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      let outBytes = 0;
      let settled = false;
      const done = (f: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        f();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done(() => reject(new CaptureParserError(`capture parser did not answer within ${this.timeoutMs} ms and was killed`, "deadline")));
      }, this.timeoutMs);
      child.stdout.on("data", (c: Buffer) => {
        outBytes += c.byteLength;
        if (outBytes > PARSER_MAX_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          done(() => reject(new CaptureParserError("capture parser answer exceeds its bound", "killed")));
        } else out.push(c);
      });
      child.stderr.resume();
      child.on("error", (e) => done(() => reject(new CaptureParserError(`capture parser failed to start: ${e.message}`, "killed"))));
      child.on("close", (code, signal) =>
        done(() => {
          if (code !== 0) return reject(new CaptureParserError(`capture parser exited with ${signal ?? `code ${code}`}`, "killed"));
          try {
            resolve(JSON.parse(Buffer.concat(out).toString("utf8")));
          } catch {
            reject(new CaptureParserError("capture parser answer is not JSON", "killed"));
          }
        }),
      );
      child.stdin.on("error", () => {}); // a child that dies before reading its input surfaces through close
      child.stdin.end(input);
    });
  }
}
