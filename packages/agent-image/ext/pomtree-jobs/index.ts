// Pi extension 'pomtree-jobs' (TODO(background-jobs) v1): job_start/job_status/job_tail/job_kill/job_wait.
// OPT-IN (harness loads it only with POMTREED_HARNESS_JOBS_EXT=1) and UNVERIFIED against a real Pi run. Every Pi API call is
// wrapped so a changed API leaves the extension inert instead of crashing the session.
// Shell execution (start, kill) goes through Pi's built-in bash tool (createBashTool(...).execute); status/tail/wait
// only read the job files (plain fs, no shell).
// Jobs escape Pi's bash-timeout group kill via setsid in the wrapper and enforce their own timeout there.
// TODO(background-jobs): follow-ups not in v1: journal events job_started/heartbeat/exited (core contract + agent
// endpoint route + harness normalization); watchdog treating a live job as blocked-wait (pomtreed daemon.ts);
// refusing/warning `pomtree yield` while jobs are live (pomtreed + pomtree CLI); UI jobs pane; completion notification via
// the mailbox extension steer signal.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  JOBS_ROOT,
  MAX_WAIT_MS,
  clampWaitMs,
  deriveStatus,
  formatStatus,
  isValidId,
  jobDir,
  killCommand,
  newId,
  sanitizeName,
  startCommand,
  tailText,
  validateStart,
  waitFor,
  type JobStatus,
} from "./jobs.ts";

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], details: { isError } });

function statusOf(id: string, root = JOBS_ROOT): JobStatus {
  const d = jobDir(id, root);
  return deriveStatus(id, { meta: read(`${d}/meta.json`), pid: read(`${d}/pid`), exit: read(`${d}/exit`) }, alive);
}
function listIds(root = JOBS_ROOT): string[] {
  try {
    return readdirSync(root).filter(isValidId);
  } catch {
    return [];
  }
}

export default function (pi: ExtensionAPI) {
  try {
    let runBash: ((cmd: string, signal?: AbortSignal) => Promise<string>) | undefined;
    const bash = async (cmd: string, signal?: AbortSignal): Promise<string> => {
      if (!runBash) {
        try {
          const mod: any = await import("@earendil-works/pi-coding-agent");
          const tool = mod.createBashTool(process.cwd());
          runBash = async (c, s) => {
            const r = await tool.execute(`jobs-${Date.now().toString(36)}`, { command: c, timeout: 30 }, s, undefined);
            return (r?.content ?? []).map((x: { text?: string }) => x.text ?? "").join("");
          };
        } catch {
          // TODO(pi-fallback): drop this pi.exec path once the pinned Pi (scripts/build.ts) is confirmed to export createBashTool; the Pi source was not available offline to check. Current behavior: used when the import or createBashTool fails.
          runBash = async (c) => {
            const r = await (pi as any).exec("sh", ["-c", c], { timeout: 30_000 });
            return `${r?.stdout ?? ""}${r?.stderr ?? ""}`;
          };
        }
      }
      return runBash(cmd, signal);
    };
    const tail = (id: string, lines?: number) => tailText(read(`${jobDir(id)}/out.log`) ?? "", lines);
    const report = (id: string, withTail: boolean, lines?: number) => {
      const s = statusOf(id);
      return formatStatus(s) + (withTail ? `\n--- tail ---\n${tail(id, lines)}` : "");
    };
    const reg = (def: Record<string, unknown>) => {
      try {
        (pi as any).registerTool(def);
      } catch {
        /* inert */
      }
    };
    const obj = (props: Record<string, unknown>, required: string[]) => ({ type: "object", properties: props, required });

    reg({
      name: "job_start",
      label: "job_start",
      description:
        "Start a background shell command that outlives this tool call. timeout_s is required (enforced by the job itself). Jobs die at yield/exit/container restart; logs stay in /workspace/.jobs/<id>/out.log.",
      parameters: obj({ cmd: { type: "string" }, timeout_s: { type: "number" }, name: { type: "string" } }, ["cmd", "timeout_s"]),
      async execute(_id: string, p: any, signal?: AbortSignal) {
        try {
          const live = listIds().filter((i) => statusOf(i).state === "running").length;
          const v = validateStart(p ?? {}, live, process.env, Date.now());
          if (!v.ok) return text(`error: ${v.error}`, true);
          const id = newId();
          const meta = { id, name: sanitizeName(v.name, id), cmd: v.cmd, startedAt: new Date().toISOString(), timeoutS: v.timeoutS };
          const out = await bash(startCommand(meta), signal);
          const pid = Number(out.trim().split("\n").pop());
          if (!Number.isInteger(pid) || pid <= 0) return text(`error: job did not start: ${out.slice(0, 500)}`, true);
          const deadlineAt = new Date(Date.parse(meta.startedAt) + v.timeoutS * 1000).toISOString();
          return text(`started ${id} (${meta.name}) pid=${pid} log=${jobDir(id)}/out.log deadlineAt=${deadlineAt}`);
        } catch (e) {
          return text(`error: ${(e as Error).message}`, true);
        }
      },
    });
    reg({
      name: "job_status",
      label: "job_status",
      description: "Status of one job (id) or all jobs. A job with no live process and no exit record is 'lost' (died with the container).",
      parameters: obj({ id: { type: "string" } }, []),
      async execute(_id: string, p: any) {
        try {
          if (p?.id !== undefined)
            return isValidId(p.id) && existsSync(jobDir(p.id)) ? text(formatStatus(statusOf(p.id))) : text("error: unknown job id", true);
          const ids = listIds();
          return text(ids.length ? ids.map((i) => formatStatus(statusOf(i))).join("\n") : "no jobs");
        } catch (e) {
          return text(`error: ${(e as Error).message}`, true);
        }
      },
    });
    reg({
      name: "job_tail",
      label: "job_tail",
      description: "Last N lines (default 50, max 200) of a job's output, ANSI stripped.",
      parameters: obj({ id: { type: "string" }, lines: { type: "number" } }, ["id"]),
      async execute(_id: string, p: any) {
        try {
          return isValidId(p?.id) && existsSync(jobDir(p.id)) ? text(tail(p.id, p.lines)) : text("error: unknown job id", true);
        } catch (e) {
          return text(`error: ${(e as Error).message}`, true);
        }
      },
    });
    reg({
      name: "job_kill",
      label: "job_kill",
      description: "Stop a job (TERM, then KILL after 5s). Idempotent: killing a finished job is a no-op.",
      parameters: obj({ id: { type: "string" } }, ["id"]),
      async execute(_id: string, p: any, signal?: AbortSignal) {
        try {
          if (!isValidId(p?.id) || !existsSync(jobDir(p.id))) return text("error: unknown job id", true);
          const s = statusOf(p.id);
          if (s.state === "running" && s.pid !== undefined) await bash(killCommand(s.pid), signal);
          return text(report(p.id, false));
        } catch (e) {
          return text(`error: ${(e as Error).message}`, true);
        }
      },
    });
    reg({
      name: "job_wait",
      label: "job_wait",
      description: `Wait up to ms (max ${MAX_WAIT_MS}; loop for longer, so steering/cancel can interleave; abort returns immediately) for a job to finish; returns status and output tail either way.`,
      parameters: obj({ id: { type: "string" }, ms: { type: "number" } }, ["id", "ms"]),
      async execute(_id: string, p: any, signal?: AbortSignal) {
        try {
          if (!isValidId(p?.id) || !existsSync(jobDir(p.id))) return text("error: unknown job id", true);
          const r = await waitFor(() => statusOf(p.id).state !== "running", p.ms, signal);
          const body = report(p.id, r !== "interrupted");
          return text(
            r === "interrupted" ? `interrupted\n${body}` : r === "timeout" ? `still running after ${clampWaitMs(p.ms)}ms; call job_wait again\n${body}` : body,
          );
        } catch (e) {
          return text(`error: ${(e as Error).message}`, true);
        }
      },
    });

    // On (re)start of a session, surface jobs that died with the container. Never restarted.
    // TODO(background-jobs): `session_start` event name/signature is UNVERIFIED by a live run.
    (pi as any).on("session_start", async () => {
      try {
        const lost = listIds()
          .map((i) => statusOf(i))
          .filter((s) => s.state === "lost");
        if (lost.length)
          (pi as any).sendUserMessage(
            `Background jobs lost (container restarted; not restarted): ${lost.map((s) => `${s.id} ${s.name}`).join(", ")}. Logs remain in ${JOBS_ROOT}/<id>/out.log.`,
            { deliverAs: "followUp" },
          );
      } catch {
        /* inert */
      }
    });
  } catch {
    // best-effort: a changed Pi API leaves the extension inert
  }
}
