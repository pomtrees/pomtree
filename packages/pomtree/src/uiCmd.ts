// Pure pieces of `pomtree ui <verb>`: argv -> command body, and the daemon's reply -> output and exit code.
// The daemon (POST /v1/ui/command) is the validator; this only builds the body and refuses obvious usage errors.

export type UiBuild = { ok: true; command: Record<string, unknown> } | { ok: false; error: string };
export interface UiFlags {
  views?: string;
  of?: string;
  dir?: string;
  // Boolean scope flags of `ui close` (--others, --left, --right, --all).
  others?: boolean;
  left?: boolean;
  right?: boolean;
  all?: boolean;
}
export interface UiExit {
  error: number;
  usage: number;
  notFound: number;
}
export interface UiOutcome {
  out: string;
  err: string;
  code: number;
}

const PRESETS = ["single", "columns", "rows", "grid"];
const DIRS = ["left", "right", "up", "down"];
const VERBS = "open|focus|close|maximize|minimize|restore|arrange|reset|follow";
const SCOPE_FLAGS = ["others", "left", "right", "all"] as const;
const EXAMPLE: Record<string, string> = {
  open: "pomtree ui open terminal a1",
  focus: "pomtree ui focus terminal a1",
  close: "pomtree ui close terminal a1",
  maximize: "pomtree ui maximize terminal a1",
  minimize: "pomtree ui minimize terminal a1",
  restore: "pomtree ui restore terminal a1",
  arrange: "pomtree ui arrange grid",
  reset: "pomtree ui reset",
  follow: "pomtree ui follow on --views terminal,browser --of a1",
};

const fail = (error: string): UiBuild => ({ ok: false, error });

export function buildUiCommand(args: string[], flags: UiFlags): UiBuild {
  const [verb, ...rest] = args;
  if (verb === undefined || !(verb in EXAMPLE)) {
    return fail(`${verb === undefined ? "ui needs a verb" : `unknown ui verb "${verb}"`}: use ${VERBS}; for example: ${EXAMPLE.open}`);
  }
  const eg = (e = EXAMPLE[verb]!) => `; for example: ${e}`;
  if (flags.views !== undefined && verb !== "follow") return fail(`--views only applies to ui follow${eg(EXAMPLE.follow)}`);
  if (flags.of !== undefined && verb !== "follow") return fail(`--of only applies to ui follow${eg(EXAMPLE.follow)}`);
  if (flags.dir !== undefined && verb !== "focus") return fail(`--dir only applies to ui focus${eg("pomtree ui focus --dir left")}`);
  const scopes = SCOPE_FLAGS.filter((f) => flags[f]);
  if (scopes.length > 0 && verb !== "close") return fail(`--${scopes[0]} only applies to ui close${eg("pomtree ui close terminal a1 --others")}`);
  if (scopes.length > 1)
    return fail(
      `ui close takes one of --others, --left, --right or --all, not ${scopes.map((f) => `--${f}`).join(" and ")}${eg("pomtree ui close terminal a1 --others")}`,
    );
  const extra = (n: number): UiBuild | null => (rest.length > n ? fail(`unexpected extra argument "${rest[n]}"${eg()}`) : null);

  switch (verb) {
    case "open":
    case "focus":
    case "close":
    case "maximize":
    case "minimize":
    case "restore": {
      if (verb === "close" && flags.all) {
        if (rest.length > 0) return fail(`ui close --all closes every window and takes no view, got "${rest[0]}"${eg("pomtree ui close --all")}`);
        return { ok: true, command: { cmd: "close", scope: "all" } };
      }
      if (verb === "focus" && flags.dir !== undefined) {
        if (rest.length > 0) return fail(`ui focus takes either a view or --dir, not both${eg("pomtree ui focus --dir left")}`);
        if (!DIRS.includes(flags.dir)) return fail(`--dir "${flags.dir}" is not a direction: use left, right, up or down${eg("pomtree ui focus --dir left")}`);
        return { ok: true, command: { cmd: "focus", dir: flags.dir } };
      }
      const [view, agent, report] = rest;
      if (view === undefined && verb === "restore") return { ok: true, command: { cmd: "restore" } };
      if (view === undefined) {
        return fail(
          `${verb} needs a view${verb === "focus" ? " or --dir" : ""} (e.g. terminal, browser, report, tree)${eg(verb === "focus" ? "pomtree ui focus --dir left" : EXAMPLE[verb])}`,
        );
      }
      const e = extra(3);
      if (e) return fail(`unexpected extra argument "${rest[3]}"${eg(verb === "open" ? "pomtree ui open report a1 r1" : EXAMPLE[verb])}`);
      const scope = scopes[0];
      return {
        ok: true,
        command: { cmd: verb, view, ...(agent !== undefined && { agent }), ...(report !== undefined && { report }), ...(scope && { scope }) },
      };
    }
    case "arrange": {
      const [preset] = rest;
      if (preset === undefined) return fail(`arrange needs a preset (single, columns, rows or grid)${eg()}`);
      if (!PRESETS.includes(preset)) return fail(`"${preset}" is not an arrange preset: use single, columns, rows or grid${eg()}`);
      return extra(1) ?? { ok: true, command: { cmd: "arrange", preset } };
    }
    case "reset":
      return extra(0) ?? { ok: true, command: { cmd: "reset" } };
    default: {
      const [onOff] = rest;
      if (onOff === undefined) return fail(`follow needs on or off${eg("pomtree ui follow on")}`);
      if (onOff !== "on" && onOff !== "off") return fail(`"${onOff}" is not on or off: use on or off${eg("pomtree ui follow on")}`);
      const x = extra(1);
      if (x) return x;
      let views: string[] | undefined;
      if (flags.views !== undefined) {
        views = flags.views.split(",");
        if (views.length < 1 || views.length > 4 || views.some((v) => v === ""))
          return fail(`--views needs 1 to 4 view names separated by commas${eg("pomtree ui follow on --views terminal,browser")}`);
      }
      return { ok: true, command: { cmd: "follow", on: onOff === "on", ...(views && { views }), ...(flags.of !== undefined && { of: flags.of }) } };
    }
  }
}

// `res` is the daemon's 200 body ({seq, tabs}) or its 400 body ({error}). `tabs` counts tabs connected to this daemon
// when the command was accepted: it is not an acknowledgement that a tab applied it (a tab may reject it and say so itself).
// `exit` carries the CLI's named codes (passed in because importing EXIT from cli.ts would be a cycle).
export function formatUiResult(res: { seq: number; tabs: number } | { error: string }, exit: UiExit): UiOutcome {
  const r = res as { seq?: unknown; tabs?: unknown; error?: unknown };
  if (typeof r.error === "string") return { out: "", err: r.error, code: exit.usage };
  if (typeof r.seq !== "number" || typeof r.tabs !== "number")
    return { out: "", err: "daemon sent an unexpected reply to the ui command; check that pomtreed is the same version as pomtree", code: exit.error };
  if (r.tabs === 0)
    return {
      out: "",
      err: `ui command ${r.seq} was recorded but no UI tab is connected, so nothing applied and a tab that connects later will not replay it; open the operator UI (/ui) and run it again`,
      code: exit.notFound, // 3 = the target tab was not found
    };
  return { out: `sent ui command ${r.seq} to ${r.tabs} tab${r.tabs === 1 ? "" : "s"}`, err: "", code: 0 };
}
