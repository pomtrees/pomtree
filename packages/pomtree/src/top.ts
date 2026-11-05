import { stripControl } from "./sanitize.ts";

// The daemon-API wrapper cli.ts already provides: decodes the body and throws on
// HTTP failure or an unreachable daemon. `top` stays a thin client on top of it,
// polling `GET /v1/tree` for the daemon's pre-formatted display rows instead of
// importing `@pomtree/observe` to build the tree client-side.
export type TopFetch = (method: string, path: string, body?: unknown, block?: boolean) => Promise<unknown>;

// Written before each live frame so the table replaces itself instead of scrolling.
export const CLEAR = "\x1b[H\x1b[2J";

// The display-ready row the daemon returns from GET /v1/tree: the same columns the
// terminal renderer shows, pre-formatted on the daemon side.
export interface DisplayRow {
  name: string;
  id: string;
  depth: number;
  state: string; // "exited:<exit>" once finished
  age: string;
  activity: string;
  tokens: number;
  cost: string;
  left: string;
  wait: string;
  host: string;
}

const HEADERS = ["AGENT", "ID", "STATE", "AGE", "ACTIVITY", "TOKENS", "COST", "LEFT", "WAIT", "HOST"];

function stateColor(state: string): string {
  if (state === "running") return "32";
  if (state === "yielded") return "33";
  if (state === "exited:succeeded") return "36";
  if (state.startsWith("exited:")) return "31";
  return "2";
}

// Strip terminal control characters from the daemon-supplied strings `top` renders, so a
// malicious agent cannot inject ANSI/OSC sequences into the operator terminal via its
// name, host, or the free-text event fields folded into the activity column.
const strip = (s: unknown) => stripControl(String(s ?? ""));

// A simple table over the daemon's pre-formatted rows. The state cell is colored in TTY
// mode.
export function renderRows(rows: readonly DisplayRow[], opts: { color?: boolean } = {}): string {
  if (rows.length === 0) return "(no agents)";
  const cells = rows.map((r) => [
    `${"  ".repeat(Math.max(0, r.depth ?? 0))}${strip(r.name)}`,
    strip(r.id),
    strip(r.state),
    strip(r.age),
    strip(r.activity),
    String(r.tokens ?? ""),
    strip(r.cost),
    strip(r.left),
    strip(r.wait),
    strip(r.host),
  ]);
  const widths = HEADERS.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[], color?: string) =>
    c
      .map((v, i) => {
        const padded = v.padEnd(widths[i]!);
        return color && i === 2 ? `\x1b[${color}m${padded}\x1b[0m` : padded;
      })
      .join("  ")
      .trimEnd();
  return [line(HEADERS), ...cells.map((c, i) => line(c, opts.color ? stateColor(rows[i]!.state) : undefined))].join("\n");
}

// Live loop: poll the daemon's tree snapshot once per interval and yield the rows (renderRows
// strips control sequences before any of them reach the terminal). Never finishes on its own;
// the caller stops it.
export async function* pollTree(fetch: TopFetch, opts: { intervalMs: number }): AsyncGenerator<DisplayRow[]> {
  for (;;) {
    yield (await fetch("GET", "/v1/tree")) as DisplayRow[];
    await new Promise<void>((r) => setTimeout(r, opts.intervalMs));
  }
}
