#!/usr/bin/env node
// pomtree-model-stub: run the scripted fake model upstream on loopback so a
// human can point a real pomtreed stack at it at zero spend.

import { parseArgs } from "node:util";
import { BUILTIN_SCRIPTS_DIR, FakeModelUpstream, loadModelScript } from "../src/model-stub/index.ts";

const HELP = `Usage: pomtree-model-stub --script <name|path> [--port N] [--host H]

Serves a deterministic, scripted model upstream (OpenAI chat completions at
<base>/chat/completions, stream and non-stream; Anthropic Messages at
<base>/messages, stream only; GET <base>/models). Prints one JSON line
{"baseUrl": "...", "script": "..."} on stdout once listening; each request
that matches no rule is logged to stderr and answered with the script's
fallback. Runs until SIGINT/SIGTERM.

  --script S  a built-in script name (${BUILTIN_SCRIPTS_DIR}/<name>.json)
              or a path to a script JSON file (required)
  --port N    listen port (default 0: any free port)
  --host H    listen address (default 127.0.0.1)

Point a pomtreed stack at it (pomtreed's model proxy runs on the host, so
loopback is reachable; the stub ignores the key but pomtree-up requires a 0600
key file):
  printf stub > /tmp/stub-key && chmod 600 /tmp/stub-key
  scripts/pomtree-up --model-base-url http://127.0.0.1:<port>/v1 \\
    --model-key-file /tmp/stub-key --provider <provider>
(--model-base-url sets POMTREED_MODEL_BASE_URL, i.e. model.baseUrl.)

Rules match on request structure: turn, toolResults, lastTool, offersTool,
agentId ([[agent:<id>]] in the system prompt; pomtreed forwards no agent
header), marker ([[stub:<token>]] in the system prompt), lastUserIncludes.`;

function main(): void {
  let values: { script?: string; port?: string; host?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        script: { type: "string" },
        port: { type: "string" },
        host: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${HELP}\n`);
    process.exit(2);
  }
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (!values.script) {
    process.stderr.write(`--script is required\n\n${HELP}\n`);
    process.exit(2);
  }
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`--port must be an integer 0-65535, got ${values.port}\n`);
    process.exit(2);
  }
  let script: ReturnType<typeof loadModelScript>;
  try {
    script = loadModelScript(values.script);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }
  FakeModelUpstream.start({ script, port, host: values.host }).then(
    (up) => {
      process.stdout.write(`${JSON.stringify({ baseUrl: up.baseUrl, script: script.name })}\n`);
      const stop = () => {
        const n = up.unmatched.length;
        process.stderr.write(`fake model: ${up.calls.length} calls, ${n} unmatched\n`);
        up.close().then(() => process.exit(n === 0 ? 0 : 1));
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    },
    (e: Error) => {
      process.stderr.write(`fake model: cannot listen: ${e.message}\n`);
      process.exit(1);
    },
  );
}

main();
