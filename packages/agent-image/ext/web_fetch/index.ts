// Pi extension shim: registers the `web_fetch` tool and forwards every call to the host
// extension gateway via `pomtree --json ext call web_fetch '<input-json>'`. The sandbox injects
// POMTREE_API/POMTREE_TOKEN (or POMTREE_SOCKET); `pomtree` reads them itself, so the shim holds no secret.
// The gateway is SSRF-guarded and size-capped; the shim only relays its result.
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";

function relay(name: string, input: unknown): { ok: boolean; text: string; result: unknown } {
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, ["/opt/pomtree/pomtree/src/main.ts", "--json", "ext", "call", name, JSON.stringify(input ?? {})], {
      encoding: "utf8",
      timeout: 60_000,
      env: process.env,
    }).trim();
  } catch (e) {
    const err = e as { stderr?: unknown; message?: string };
    const reason = typeof err.stderr === "string" && err.stderr.trim() ? err.stderr.trim() : (err.message ?? String(e));
    return { ok: false, text: reason.slice(0, 1000), result: { ok: false, reason: reason.slice(0, 1000) } };
  }
  let parsed: { ok?: boolean; denied?: boolean; reason?: string; result?: unknown };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return { ok: false, text: stdout.slice(0, 1000), result: { ok: false, reason: `non-JSON: ${stdout.slice(0, 400)}` } };
  }
  if (parsed.ok !== true) {
    const reason = parsed.reason ?? (parsed.denied ? "denied" : "failed");
    return { ok: false, text: reason, result: { ok: false, denied: parsed.denied, reason } };
  }
  return { ok: true, text: typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result), result: parsed.result };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web fetch",
    description: "Fetch a URL over HTTP(S) through the host proxy (SSRF-guarded, size-capped, text media only).",
    promptSnippet: "Fetch a URL over HTTP(S) through the host proxy",
    parameters: Type.Object({ url: Type.String({ description: "URL to fetch (http or https)" }) }),
    async execute(_toolCallId, params) {
      const r = relay("web_fetch", params);
      return {
        content: [{ type: "text", text: r.ok ? r.text : `web_fetch failed: ${r.text}` }],
        details: { ok: r.ok, result: r.result },
        ...(r.ok ? {} : { isError: true }),
      };
    },
  });
}
