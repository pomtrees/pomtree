// The child side of ProcessCaptureParser (process-parser.ts): a short-lived Node process that parses one untrusted body and exits,
// so pomtreed itself never interprets a body (decision C9, L1). Input on stdin is one JSON request {method, body (base64), tokens?,
// path?}; the answer on stdout is one JSON value. It holds no secrets (its env is empty) and imports only core's pure parsers.
// TODO(capture-broker): S2 replaces this with the agent-image capture worker (parse-only mode)
import { parseWaybackAvailability, robotsVerdict } from "@pomtree/core";

const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", () => {
  const req = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method: string; body: string; tokens?: string[]; path?: string };
  const body = Buffer.from(req.body, "base64").toString("utf8");
  let answer: unknown;
  if (req.method === "robots") answer = robotsVerdict(body, req.tokens ?? [], req.path ?? "/");
  else if (req.method === "waybackAvailability") answer = parseWaybackAvailability(body);
  else {
    process.stderr.write(`unknown parser method ${JSON.stringify(req.method)}\n`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(answer));
});
