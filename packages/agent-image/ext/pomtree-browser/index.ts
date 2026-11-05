// Explicitly loaded only by browser-run; never part of the default extension manifest.
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { browserEvidence, connectOutcome, EvidencePublishError, interactiveProfile, parseCaptureReceipt } from "./browser.ts";
import { DEFAULT_SINK_PATH } from "../pomtree-events/events.ts";
import { captureToolOutcome, diagnosticSinkLine, diagnosticTail, pomtreeFailureDetail } from "./capture-diagnostic.ts";
import { CDP_PORT, CLI_POMTREE_MAIN, CLI_POMTREE_TIMEOUT_MS, readContainerConfig } from "./container-contract.gen.ts";
import { clearFinishMarker, createFinish, FINISH_STATUSES, writeFinishMarker } from "./finish.ts";

// Every subprocess is Node by absolute path (process.execPath): PATH starts with agent-writable /workspace/.env/*/bin in the image, and
// browser-run already pins PATH for this Pi process. `pomtree` is run as its main.ts, never resolved by name.

// Grace beyond the capture's own deadline before pi.exec kills the child: Node startup and the bounded teardown (CAPTURE_TEARDOWN_MS in
// browser-capture.ts; CDP attach and the report publishes count against the deadline itself).
const CAPTURE_PROCESS_SLACK_MS = 10_000;

export default async function (pi: ExtensionAPI) {
  // The tool schema's bounds are the delivered config (browser-run has already refused a missing or invalid document; this throws at
  // load on the same input). They only guide the model: browser-capture.ts re-reads the document and enforces them itself.
  const config = readContainerConfig(process.env, { required: true });
  const maxSteps = Number(process.env.PTREE_BROWSER_MAX_STEPS);
  const interactive = interactiveProfile(process.env);
  // The operator-only failure diagnostic goes to the Pi session (as before) and, as one sink line, to the daemon journal (it reaches the journal as an `operator-diagnostic`
  // error event): the events sink is what the harness already reads, and a failed write only loses the journal copy.
  const sinkPath = process.env.PTREE_EVENTS_SINK || DEFAULT_SINK_PATH;
  const diagnose = (name: string, data: Record<string, unknown>) => {
    try {
      appendFileSync(sinkPath, diagnosticSinkLine(name, data));
    } catch {
      /* never throw into Pi */
    }
  };
  const recordFailure = (data: Record<string, unknown>) => {
    pi.appendEntry("browser-capture-failure", data);
    diagnose("browser-capture-failure", data);
  };
  const evidence = browserEvidence({
    maxSteps,
    interactive,
    record: (value) => pi.appendEntry("browser-evidence", value),
    // Interactive only (browser.ts reads them only for that profile): the journal copy, and the run's wall-clock budget for the low-time warning.
    diagnose,
    maxMs: Number(process.env.PTREE_BROWSER_MAX_MS),
    publish: async (data, name, mediaType) => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-browser-")));
      const file = join(dir, "evidence");
      const hash = createHash("sha256").update(data).digest("hex");
      try {
        writeFileSync(file, data, { mode: 0o600 });
        const result = await pi.exec(
          process.execPath,
          [
            CLI_POMTREE_MAIN,
            "report",
            "publish",
            file,
            "--name",
            name,
            "--media-type",
            mediaType,
            "--key",
            `browser:${process.env.POMTREE_AGENT_ID}:${process.env.POMTREE_AGENT_GENERATION}:${name}:${hash}`,
            "--json",
          ],
          { timeout: CLI_POMTREE_TIMEOUT_MS },
        );
        // The messages are unchanged; the redacted, bounded pomtree detail rides along for the interactive profile's operator-only failure entry.
        if (result.code !== 0)
          throw new EvidencePublishError(
            "browser evidence publication failed",
            pomtreeFailureDetail({ code: result.code, timedOut: result.killed === true, stderr: result.stderr }, process.env),
          );
        const report = JSON.parse(result.stdout) as { id: string; sha256: string };
        if (typeof report.id !== "string" || report.sha256 !== hash) throw new EvidencePublishError("browser evidence receipt mismatch");
        return { id: report.id, sha256: report.sha256 };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  });
  let browserCommand: RegisteredCommand | undefined;
  const wrapped = new Proxy(pi, {
    get(target, prop) {
      if (prop === "registerCommand")
        return (name: string, command: RegisteredCommand) => {
          if (name === "browser") browserCommand = command;
          return target.registerCommand(name, command);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const modulePath = "/opt/pomtree/pi-browser/index.ts";
  const { default: piBrowser } = await import(modulePath);
  await piBrowser(wrapped);
  pi.on("session_start", async (_event, ctx) => {
    if (!browserCommand) throw new Error("pinned pi-browser did not register /browser");
    // The pinned command's connect operation only needs lifecycle context; no session replacement.
    if (!interactive) {
      await browserCommand.handler(`connect ${CDP_PORT}`, ctx as Parameters<typeof browserCommand.handler>[1]);
      pi.appendEntry("browser-controller", { kind: "browser-connected", transport: "loopback-cdp", maxSteps });
      return;
    }
    // Interactive: the handler swallows a failed connect into ctx.ui.notify, so its notices are read (and still shown) to tell the outcome.
    const notices: string[] = [];
    const ui = ctx.ui;
    const probe = new Proxy(ctx, {
      get(target, prop) {
        if (prop !== "ui") return Reflect.get(target, prop, target);
        return new Proxy(ui, {
          get(u, key) {
            const value = Reflect.get(u, key, u);
            if (key !== "notify" || typeof value !== "function") return typeof value === "function" ? value.bind(u) : value;
            return (message: unknown, ...rest: unknown[]) => {
              notices.push(String(message));
              return value.call(u, message, ...rest);
            };
          },
        });
      },
    });
    await browserCommand.handler(`connect ${CDP_PORT}`, probe as Parameters<typeof browserCommand.handler>[1]);
    const outcome = connectOutcome(notices, CDP_PORT);
    if (outcome.connected) {
      pi.appendEntry("browser-controller", { kind: "browser-connected", transport: "loopback-cdp", maxSteps, profile: "interactive" });
      return;
    }
    const failed = { kind: "browser-connect-failed", transport: "loopback-cdp", maxSteps, profile: "interactive", cause: "cdp_unavailable" };
    pi.appendEntry("browser-controller", failed);
    diagnose("browser-connect-failure", { ...failed, detail: diagnosticTail(outcome.failure, process.env) });
    evidence.connectFailed();
  });
  pi.registerTool({
    name: "browser_capture",
    label: "Browser capture",
    description:
      "Capture a public page with the trusted in-image browser script. Mechanically publishes separate main-response entity, rendered DOM, DOM text, screenshot and navigation reports; returns their actual IDs/hashes. No model-generated text substitutes for artifacts.",
    parameters: Type.Object({
      url: Type.String(),
      maxBytes: Type.Integer({ minimum: 1, maximum: config["browser.capture.maxBytesCeiling"] }),
      deadlineMs: Type.Integer({ minimum: config["browser.capture.deadlineMinMs"], maximum: config["browser.capture.deadlineMaxMs"] }),
    }),
    async execute(_id, params, signal) {
      const result = await pi.exec(process.execPath, ["/opt/pomtree/browser-capture.ts", params.url, String(params.maxBytes), String(params.deadlineMs)], {
        timeout: params.deadlineMs + CAPTURE_PROCESS_SLACK_MS,
        signal,
      });
      // A timeout kill (Pi reports code 0 with `killed` and empty stdout) is a failure like any other, never a JSON parse error.
      const outcome = captureToolOutcome(result, signal?.aborted === true, process.env);
      if (!outcome.ok) {
        recordFailure({ tool: "browser_capture", toolCallId: _id, ...outcome.diagnostic });
        // The tool error reaches the daemon journal through the events sink; it carries only the closed cause, a fixed hint, the Chromium
        // error name and a failed pomtree's exit code or timeout, never stderr (captureFailureText).
        throw new Error(outcome.message);
      }
      const receipt = parseCaptureReceipt(outcome.receipt);
      pi.appendEntry("browser-capture-receipt", { tool: "browser_capture", toolCallId: _id, receipt });
      return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
    },
  });
  const markerFailure = (err: unknown) =>
    diagnose("browser-finish-marker-failure", { tool: "capture_finish", cause: "marker_unwritable", code: (err as NodeJS.ErrnoException).code ?? null });
  const finish = createFinish({
    interactive,
    // Interactive only: the worker ends the run with the recorded outcome's code. The intent is written as a pending marker BEFORE `pomtree
    // result` runs and removed again when the call failed in a way that cannot have recorded it, so a timeout or a lost settled write
    // still yields the right code. A failed write loses only that (Pi still shuts down cleanly, and the daemon keeps the recorded result
    // either way); the operator sees why in the journal.
    onPending: (status) => {
      try {
        writeFinishMarker(status, undefined, true);
      } catch (err) {
        markerFailure(err);
      }
    },
    onUnrecorded: () => {
      try {
        clearFinishMarker();
      } catch (err) {
        markerFailure(err);
      }
    },
    onRecorded: (status) => {
      try {
        writeFinishMarker(status);
      } catch (err) {
        markerFailure(err);
      }
    },
  });
  pi.registerTool({
    name: "capture_finish",
    label: "Finish capture",
    description:
      "End the browser run once: record the run result. status is succeeded or failed; summary is plain text (control characters are removed, capped at 8 KiB). Callable once.",
    parameters: Type.Object({
      status: Type.Union(FINISH_STATUSES.map((s) => Type.Literal(s))),
      summary: Type.String(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const outcome = await finish(params.status, params.summary);
      if (outcome.failure) recordFailure({ tool: "capture_finish", toolCallId: _id, pomtree: outcome.failure, ...(outcome.cause && { cause: outcome.cause }) });
      if (!outcome.ok) throw new Error(outcome.text);
      // Interactive: the result is recorded, so the run is over. Pi's clean shutdown waits for the turn to settle (the final assistant
      // message and the evidence publishes land first); the worker's FINISH_GRACE_MS bounds a model that keeps going.
      if (interactive) ctx.shutdown();
      return { content: [{ type: "text", text: outcome.text }], details: { status: params.status } };
    },
  });
  pi.on("tool_call", async (event) => evidence.call(event));
  pi.on("tool_result", async (event) => evidence.result(event));
}
