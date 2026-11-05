// Browser action evidence complements (never replaces) the proxy's opaque connection audit.
import { captureFailureSuffix, classifyBrowserToolFailure, type PomtreeFailureDetail } from "./capture-diagnostic.ts";
import { BROWSER_MAX_STEPS_RANGE } from "./container-contract.gen.ts";
import { END_IN_TEXT, FINISH_MAX_ATTEMPTS } from "./finish.ts";

export interface BrowserPart {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}
export interface BrowserReceipt {
  id: string;
  sha256: string;
}
export interface BrowserEvidenceDeps {
  maxSteps: number;
  // The EXPERIMENTAL interactive profile (PTREE_BROWSER_PROFILE=interactive): its bounds below apply; absent keeps the capture worker's behaviour exactly.
  interactive?: boolean;
  publish(data: Uint8Array, name: string, mediaType: string): Promise<BrowserReceipt>;
  record(value: unknown): void;
  // Interactive only: the journal copy of an operator-relevant event (index.ts: one events-sink diagnostic line), beside `record`.
  diagnose?(name: string, data: Record<string, unknown>): void;
  // Interactive only: the run's wall-clock budget (PTREE_BROWSER_MAX_MS) and a clock, for the one low-time warning.
  maxMs?: number;
  now?: () => number;
}
// A failed evidence publication (index.ts publish); `pomtree` is the failed child's redacted detail, operator-only.
export class EvidencePublishError extends Error {
  readonly pomtree?: PomtreeFailureDetail;
  constructor(message: string, pomtree?: PomtreeFailureDetail) {
    super(message);
    this.pomtree = pomtree;
  }
}
// Interactive: after this many refusals of the reserved last step the refusal text escalates and the escalation is journaled once.
export const RESERVED_REFUSALS_BEFORE_ESCALATION = 3;
// Interactive: the share of maxMs after which one tool result carries a low-time warning.
export const TIME_WARNING_FRACTION = 0.8;
const FINISH_TOOL = "capture_finish";
// Pi's tool_call hook result for a refused call. Interactive reasons end with a closed `(cause=...)`, which pomtreed parses from the journal.
const blocked = (reason: string) => ({ block: true, reason });

// The bytes of tool-result text an interactive run hands the model per call: pi-browser caps only browser_snapshot (20 KB) and appends an
// uncapped snapshot to every action result. Mirrors INTERACTIVE_RESULT_TEXT_MAX_BYTES in src/browser-run.ts (the preamble states it; a test pins them equal).
// TODO(config-registry): a module constant like the other browser worker limits until browser.* limits migrate to the registry.
export const RESULT_TEXT_MAX_BYTES = 32 * 1024;
const SCREENSHOT_MAX_BYTES = 1024 ** 2;
const SCREENSHOTS_MAX_TOTAL_BYTES = 16 * 1024 ** 2;
const SCREENSHOTS_MAX = 32;

// The controller-set profile as the extension sees it: true for interactive, false when absent. browser-run has already refused any other
// value before Pi started; this re-check fails closed at extension load on the same input.
export function interactiveProfile(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env.PTREE_BROWSER_PROFILE;
  if (raw === undefined) return false;
  if (raw !== "interactive") throw new Error("browser extension refused an unknown PTREE_BROWSER_PROFILE");
  return true;
}

// Text parts capped to `max` UTF-8 bytes in total, never splitting a code point; the first truncated part ends with a visible marker and
// later text parts are dropped. Non-text parts pass through unchanged.
export function capResultText(content: BrowserPart[], max: number = RESULT_TEXT_MAX_BYTES): BrowserPart[] {
  let left = max;
  let total = 0;
  for (const p of content) if (p.type === "text" && typeof p.text === "string") total += Buffer.byteLength(p.text, "utf8");
  if (total <= max) return content;
  const out: BrowserPart[] = [];
  let marked = false;
  for (const p of content) {
    if (p.type !== "text" || typeof p.text !== "string") {
      out.push(p);
      continue;
    }
    if (marked) continue;
    const bytes = Buffer.from(p.text, "utf8");
    if (bytes.length <= left) {
      out.push(p);
      left -= bytes.length;
      continue;
    }
    const kept = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, left)).replace(/�+$/u, "");
    out.push({ ...p, text: `${kept}\n[pomtree: tool result truncated to ${max} of ${total} bytes; narrow it, e.g. browser_snapshot with a selector]` });
    marked = true;
  }
  return out;
}

// Why an interactive call is refused before it runs, or undefined to let it run. Only http(s) navigation without credentials (pi-browser
// prefixes a scheme-less value with https://), so file:, chrome:, javascript:, data: and view-source: never reach Chromium from the model;
// no full-page screenshot, so one call cannot produce an unbounded image. pi-browser's raw params reach its handlers, so no other browser
// tool may carry a url at all, and browser_tabs (list, create a blank tab, close, select; its pinned schema has no url) takes only that
// action and an optional tab index.
const TAB_ACTIONS = ["list", "new", "close", "select"];
export function interactiveRefusal(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName.startsWith("browser_") && toolName !== "browser_navigate" && "url" in input)
    return `${toolName} takes no url; only browser_navigate opens a page, and only http(s) URLs`;
  if (toolName === "browser_tabs") {
    if (typeof input.action !== "string" || !TAB_ACTIONS.includes(input.action)) return `browser_tabs action must be one of ${TAB_ACTIONS.join(", ")}`;
    if (input.index !== undefined && !(Number.isInteger(input.index) && (input.index as number) >= 0))
      return "browser_tabs index must be a non-negative integer";
  }
  if (toolName === "browser_navigate") {
    const raw = input.url;
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return "browser_navigate needs a url of at most 4096 characters";
    const parse = (v: string) => {
      try {
        return new URL(v);
      } catch {
        return undefined;
      }
    };
    const url = parse(raw) ?? parse(`https://${raw}`);
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return "only http(s) URLs may be opened";
    if (url.username || url.password) return "URLs carrying credentials are refused";
  }
  if (toolName === "browser_take_screenshot" && input.fullPage !== undefined && input.fullPage !== false)
    return "full-page screenshots are refused; take a viewport screenshot (omit fullPage) and scroll with browser_mouse_wheel";
  return undefined;
}
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
// Interactive: why a screenshot part is dropped (each bound named apart) and what the model can do instead, or undefined to keep it.
function screenshotRefusal(part: BrowserPart, shots: number, bytes: number): { why: string; advice: string } | undefined {
  const data = part.data ?? "";
  if (part.mimeType !== "image/png" && part.mimeType !== "image/jpeg") return { why: "unsupported screenshot media type", advice: "Continue without one." };
  if (!BASE64.test(data) || data.length % 4 !== 0) return { why: "invalid screenshot image data", advice: "Continue without one." };
  const size = Buffer.byteLength(data, "base64");
  if (size > SCREENSHOT_MAX_BYTES)
    return { why: `oversized screenshot: ${size} bytes > ${SCREENSHOT_MAX_BYTES}`, advice: "Take a smaller viewport screenshot or continue without one." };
  if (shots + 1 > SCREENSHOTS_MAX || bytes + size > SCREENSHOTS_MAX_TOTAL_BYTES)
    return {
      why: `screenshot budget spent: ${SCREENSHOTS_MAX} screenshots or ${SCREENSHOTS_MAX_TOTAL_BYTES} bytes per run`,
      advice: "Continue without screenshots.",
    };
  return undefined;
}
function safeInput(input: Record<string, unknown>): Record<string, unknown> {
  // Never copy typed text, selectors, cookies, credentials or arbitrary tool input into metadata.
  const value = input.url;
  if (typeof value !== "string") return {};
  try {
    return { url: `${new URL(value).origin}/[redacted]` };
  } catch {
    return {};
  }
}
export function browserEvidence(deps: BrowserEvidenceDeps) {
  let steps = 0;
  let shots = 0;
  let bytes = 0;
  // Interactive only: capture_finish calls seen, whether one succeeded, refusals of the reserved step, a failed /browser connect, the warning.
  let finishCalls = 0;
  let finished = false;
  let reservedRefusals = 0;
  let disconnected = false;
  let warned = false;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const inputs = new Map<string, Record<string, unknown>>();
  if (!Number.isInteger(deps.maxSteps) || deps.maxSteps < BROWSER_MAX_STEPS_RANGE.min || deps.maxSteps > BROWSER_MAX_STEPS_RANGE.max)
    throw new Error("invalid browser step budget");
  const remember = (event: { toolName: string; toolCallId: string; input: Record<string, unknown> }) => {
    if (event.toolName.startsWith("browser_") && event.toolName !== "browser_capture") inputs.set(event.toolCallId, safeInput(event.input));
  };
  const journal = (name: string, data: Record<string, unknown>) => {
    deps.record(data);
    deps.diagnose?.(name, data);
  };
  // The interactive profile's budget: every call spends a step, capture_finish included, but the last step is reserved for capture_finish,
  // and capture_finish may run past the budget until FINISH_MAX_ATTEMPTS calls in total, so a failure on the last step is recoverable.
  // Non-finish tools stay blocked at the reservation. A refused call does not spend the reserved step: a model that keeps trying is
  // bounded by the run's maxMs and spend cap, and after RESERVED_REFUSALS_BEFORE_ESCALATION refusals the text escalates.
  function interactiveCall(event: { toolName: string; toolCallId: string; input: Record<string, unknown> }) {
    const n = deps.maxSteps;
    if (event.toolName === FINISH_TOOL) {
      finishCalls++;
      if (steps < n) steps++;
      else if (finishCalls > FINISH_MAX_ATTEMPTS)
        return blocked(`Tool-call budget (${n}) exhausted and capture_finish attempts used up: no tool calls remain; ${END_IN_TEXT} (cause=budget)`);
      return undefined;
    }
    if (steps >= n) {
      const next = finished
        ? "the result is recorded; end the run now"
        : finishCalls >= FINISH_MAX_ATTEMPTS
          ? `capture_finish attempts are used up too; ${END_IN_TEXT}`
          : "call capture_finish now with your answer";
      return blocked(`Tool-call budget (${n}) exhausted: no browser calls remain; ${next} (cause=budget)`);
    }
    if (steps + 1 === n) {
      if (++reservedRefusals <= RESERVED_REFUSALS_BEFORE_ESCALATION)
        return blocked(`Tool-call budget (${n}): the last call is reserved for capture_finish; call it now with your answer. (cause=budget)`);
      if (reservedRefusals === RESERVED_REFUSALS_BEFORE_ESCALATION + 1)
        journal("browser-budget-escalated", {
          kind: "browser-budget-escalated",
          tool: event.toolName,
          toolCallId: event.toolCallId,
          refusals: reservedRefusals,
        });
      return blocked(
        `Tool-call budget (${n}): ${reservedRefusals} calls refused at the reserved last step; stop calling browser tools and call capture_finish now. (cause=budget)`,
      );
    }
    steps++;
    if (disconnected && event.toolName.startsWith("browser_")) {
      deps.record({ kind: "browser-refused", tool: event.toolName, toolCallId: event.toolCallId, cause: "cdp_unavailable" });
      return blocked("the browser is not connected; end the run with capture_finish status failed (cause=cdp_unavailable)");
    }
    const reason = interactiveRefusal(event.toolName, event.input ?? {});
    if (reason !== undefined) {
      deps.record({ kind: "browser-refused", tool: event.toolName, toolCallId: event.toolCallId, reason });
      return blocked(`${reason} (cause=refused)`);
    }
    remember(event);
    return undefined;
  }
  // Interactive: a failed publication never turns a browser action into an error. It is journaled, and the model is told what it lost.
  async function tryPublish(data: Uint8Array, name: string, mediaType: string, event: { toolName: string; toolCallId: string }, stage: string) {
    try {
      return await deps.publish(data, name, mediaType);
    } catch (err) {
      const pomtree = err instanceof EvidencePublishError ? err.pomtree : undefined;
      journal("browser-evidence-failure", {
        kind: "browser-evidence-failure",
        tool: event.toolName,
        toolCallId: event.toolCallId,
        stage,
        cause: "publish_failed",
        ...(pomtree && { pomtree }),
      });
      return undefined;
    }
  }
  return {
    // A failed /browser connect (index.ts): every later browser tool call is refused with advice the model can act on.
    connectFailed() {
      disconnected = true;
    },
    call(event: { toolName: string; toolCallId: string; input: Record<string, unknown> }) {
      if (deps.interactive) return interactiveCall(event);
      // Every call counts, refused or not, capture_finish included: the budget bounds model turns, not only browser actions.
      if (++steps > deps.maxSteps)
        return { block: true, reason: `Tool-call budget (${deps.maxSteps}) exhausted. Return verified evidence and state what is missing.` };
      remember(event);
      return undefined;
    },
    async result(event: { toolName: string; toolCallId: string; isError: boolean; content: BrowserPart[] }) {
      if (deps.interactive && event.toolName === FINISH_TOOL && !event.isError) finished = true;
      if (!event.toolName.startsWith("browser_") || event.toolName === "browser_capture") return undefined;
      const input = inputs.get(event.toolCallId) ?? {};
      inputs.delete(event.toolCallId);
      const screenshots: BrowserReceipt[] = [];
      // Interactive: an image over a bound is dropped from what the model sees and replaced by a note, so one oversize screenshot never
      // ends the run. Capture: a throw, which turns the call into an error (unchanged).
      const dropped: { why: string; advice: string }[] = [];
      const kept: BrowserPart[] = [];
      for (const part of event.content) {
        if (part.type !== "image" || typeof part.data !== "string") {
          kept.push(part);
          continue;
        }
        if (!deps.interactive) {
          // The capture worker's checks and throw texts, unchanged.
          if (part.mimeType !== "image/png" && part.mimeType !== "image/jpeg") throw new Error("unsupported browser screenshot media type");
          if (part.data.length > 4 * Math.ceil(SCREENSHOT_MAX_BYTES / 3) || !BASE64.test(part.data)) throw new Error("oversized/invalid browser screenshot");
        } else {
          const refused = screenshotRefusal(part, shots, bytes);
          if (refused) {
            dropped.push(refused);
            continue;
          }
        }
        const data = Buffer.from(part.data, "base64");
        if (data.length > SCREENSHOT_MAX_BYTES || bytes + data.length > SCREENSHOTS_MAX_TOTAL_BYTES || shots + 1 > SCREENSHOTS_MAX)
          throw new Error("browser screenshot evidence budget exhausted");
        shots++;
        bytes += data.length;
        const name = `browser-screenshot-${shots}`;
        // Checked above: png or jpeg.
        const mimeType = part.mimeType as "image/png" | "image/jpeg";
        if (!deps.interactive) {
          const receipt = await deps.publish(data, name, mimeType);
          screenshots.push(receipt);
          deps.record({ kind: "browser-screenshot", toolCallId: event.toolCallId, ...receipt });
          kept.push(part);
          continue;
        }
        // Interactive: an unpublished screenshot is not shown, so the model never sees an image the audit trail lacks.
        const receipt = await tryPublish(data, name, mimeType, event, "screenshot");
        if (!receipt) {
          dropped.push({ why: "evidence publication failed", advice: "Continue without it." });
          continue;
        }
        screenshots.push(receipt);
        deps.record({ kind: "browser-screenshot", toolCallId: event.toolCallId, ...receipt });
        kept.push(part);
      }
      // Interactive: a failed tool's closed cause and Chromium net error name (never the URL or typed text) join the action report.
      const failure = deps.interactive && event.isError ? classifyBrowserToolFailure(textOf(event.content)) : undefined;
      const action = {
        kind: "browser-action",
        tool: event.toolName,
        toolCallId: event.toolCallId,
        at: Date.now(),
        input,
        isError: event.isError,
        screenshots,
        ...(dropped.length > 0 && { droppedScreenshots: dropped.map((d) => d.why) }),
        ...(failure && { cause: failure.cause, ...(failure.netError && { netError: failure.netError }) }),
      };
      const notes = dropped.map(({ why, advice }) => ({
        type: "text",
        text: deps.interactive
          ? `Screenshot dropped (${why}); it was not published and is not shown. ${advice}`
          : `Screenshot dropped (${why}); it was not published and is not shown. Take a smaller viewport screenshot or continue without one.`,
      }));
      const actionData = Buffer.from(JSON.stringify(action));
      const actionName = `browser-action-${steps}`;
      if (!deps.interactive) {
        const receipt = await deps.publish(actionData, actionName, "application/json");
        deps.record({ ...action, report: receipt });
        return {
          content: [
            ...event.content,
            ...notes,
            {
              type: "text",
              text: `Browser action evidence: ${JSON.stringify(receipt)}. Screenshot evidence: ${JSON.stringify(screenshots)}. Cite actual report IDs/hashes; action metadata alone is not screenshot/content proof.`,
            },
          ],
        };
      }
      const receipt = await tryPublish(actionData, actionName, "application/json", event, "action");
      deps.record({ ...action, ...(receipt ? { report: receipt } : { reportFailed: true }) });
      const tail: BrowserPart[] = [
        {
          type: "text",
          text: receipt
            ? `Browser action evidence: ${JSON.stringify(receipt)}. Screenshot evidence: ${JSON.stringify(screenshots)}. Cite actual report IDs/hashes; action metadata alone is not screenshot/content proof.`
            : `Browser action evidence publication failed: this action has no evidence report, so do not cite it as evidence. Screenshot evidence: ${JSON.stringify(screenshots)}.`,
        },
      ];
      const elapsed = now() - startedAt;
      if (!warned && deps.maxMs !== undefined && elapsed >= deps.maxMs * TIME_WARNING_FRACTION) {
        warned = true;
        const left = Math.max(0, Math.floor((deps.maxMs - elapsed) / 1000));
        deps.record({ kind: "browser-time-warning", toolCallId: event.toolCallId, leftMs: Math.max(0, deps.maxMs - elapsed) });
        tail.push({ type: "text", text: `At most ${left} seconds of the run remain; call capture_finish soon.` });
      }
      // The cause stays LAST in the result text: pomtreed's toolFailureCauseOf parses `(cause=...)` at the very end.
      if (failure) tail.push({ type: "text", text: `Browser action failed: ${failure.hint} (${captureFailureSuffix(failure)})` });
      return { content: [...capResultText(kept), ...notes, ...tail] };
    },
  };
}
const textOf = (content: BrowserPart[]) => content.map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : "")).join("\n");

// The pinned pi-browser's `/browser connect <port>` handler never throws: it reports its outcome only through ctx.ui.notify, as
// `Connected via CDP (port N). K tab(s) found.` or `Connection failed: <message>`. Connected only on the exact success notice for this port
// (fail closed: no notice, or any other text, is a failure); `failure` is pi-browser's message, for the redacted operator diagnostic.
export function connectOutcome(notices: readonly string[], port: number): { connected: true } | { connected: false; failure: string } {
  if (notices.some((t) => t.startsWith(`Connected via CDP (port ${port}). `))) return { connected: true };
  const failed = notices.find((t) => t.startsWith("Connection failed: "));
  return { connected: false, failure: failed?.slice("Connection failed: ".length) ?? "no connect notice" };
}

// Exact browser_capture receipt shape (browser-capture.ts); anything else is not evidence.
const HEX64 = /^[0-9a-f]{64}$/;
function isRef(value: unknown): value is BrowserReceipt {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 2) return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.id === "string" && ref.id !== "" && typeof ref.sha256 === "string" && HEX64.test(ref.sha256);
}
export function parseCaptureReceipt(value: unknown): CaptureReceipt {
  const r = value as Record<string, unknown> | null;
  const keys = [
    "worker",
    "generation",
    "originalUrl",
    "finalUrl",
    "method",
    "status",
    "contentType",
    "rawBodyReport",
    "domReport",
    "textReport",
    "screenshotReport",
    "navigationReport",
  ];
  if (!r || typeof r !== "object" || Object.keys(r).length !== keys.length || keys.some((k) => !(k in r)))
    throw new Error("browser capture receipt has unexpected shape");
  if (typeof r.worker !== "string" || r.worker === "" || !Number.isSafeInteger(r.generation) || (r.generation as number) < 0)
    throw new Error("browser capture receipt identity invalid");
  if (typeof r.originalUrl !== "string" || typeof r.finalUrl !== "string" || r.method !== "browser")
    throw new Error("browser capture receipt URL/method invalid");
  if (
    !Number.isInteger(r.status) ||
    (r.status as number) < 100 ||
    (r.status as number) > 599 ||
    typeof r.contentType !== "string" ||
    r.contentType.length > 200
  )
    throw new Error("browser capture receipt response metadata invalid");
  for (const k of ["rawBodyReport", "domReport", "textReport", "screenshotReport", "navigationReport"])
    if (!isRef(r[k])) throw new Error(`browser capture receipt ${k} invalid`);
  return r as unknown as CaptureReceipt;
}
export interface CaptureReceipt {
  worker: string;
  generation: number;
  originalUrl: string;
  finalUrl: string;
  method: "browser";
  status: number;
  contentType: string;
  screenshotReport: BrowserReceipt;
  rawBodyReport: BrowserReceipt;
  domReport: BrowserReceipt;
  textReport: BrowserReceipt;
  navigationReport: BrowserReceipt;
}
