// Pure helpers of the headless-Chrome check (chromeCheck.ts): finding a Chrome binary, reading the DevTools address
// Chrome prints, and the stubbed daemon API the page is served against. No process, socket or Chrome coupling, so
// src/chromeCheck.test.ts can test them on any host.
import { delimiter, join } from "node:path";

export const CHROME_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"] as const;

export type FindChrome = { kind: "found"; path: string; via: string } | { kind: "skip"; reason: string } | { kind: "error"; message: string };

// CHROME_BIN names a binary explicitly: a set but unusable value is an error (the operator asked for that one), not
// a skip. Otherwise the first of CHROME_NAMES found on PATH wins; none found is a skip with the reason printed.
export function findChrome(env: Record<string, string | undefined>, isExecutable: (path: string) => boolean): FindChrome {
  const override = env.CHROME_BIN;
  if (override !== undefined && override !== "") {
    return isExecutable(override)
      ? { kind: "found", path: override, via: "CHROME_BIN" }
      : { kind: "error", message: `CHROME_BIN=${override} is not an executable file; point it at a Chrome or Chromium binary, or unset it to search PATH` };
  }
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of CHROME_NAMES) {
      const path = join(dir, name);
      if (isExecutable(path)) return { kind: "found", path, via: "PATH" };
    }
  }
  return {
    kind: "skip",
    reason: `no Chrome found (looked for ${CHROME_NAMES.join(", ")} on PATH; set CHROME_BIN to a binary to use another)`,
  };
}

// The line headless Chrome prints once the DevTools endpoint is up: "DevTools listening on ws://127.0.0.1:PORT/devtools/browser/ID".
export function parseDevToolsUrl(stderrText: string): string | null {
  const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderrText);
  return m?.[1] ?? null;
}

export interface StubReply {
  status: number;
  type: string;
  body: string;
}

const json = (v: unknown, status = 200): StubReply => ({ status, type: "application/json", body: JSON.stringify(v) });

export const STUB_REPORT_TEXT = "# Chrome check report\n\nHello from the stubbed daemon.";

// The stubbed daemon API: two agents, one report of the first agent, nothing pending. Unknown paths are a 404 with a
// JSON body so a view that asks for something the check did not stub fails visibly instead of hanging.
export function stubReply(pathAndQuery: string): StubReply {
  const url = new URL(pathAndQuery, "http://stub.invalid");
  const p = url.pathname;
  if (p === "/v1/agents")
    return json([
      { id: "a1", name: "alpha", state: "running" },
      { id: "a2", name: "beta", state: "exited", exit: "failed" },
    ]);
  if (p === "/v1/reports") return json([{ agent: "alpha", report: { id: "r1", agent: "a1", name: "notes.md" } }]);
  if (p === "/v1/approvals" || p === "/v1/escalations") return json([]);
  if (p === "/v1/placement") return json({});
  if (p === "/v1/agents/a1/reports/r1") {
    return url.searchParams.has("raw")
      ? { status: 200, type: "text/markdown", body: STUB_REPORT_TEXT }
      : json({ id: "r1", agent: "a1", name: "notes.md", mediaType: "text/markdown" });
  }
  return json({ error: `check stub has no route for ${p}` }, 404);
}

// Paths the page opens as event streams; the stub keeps them open and sends nothing.
export const STUB_STREAMS = ["/live/events", "/live/ui"] as const;
