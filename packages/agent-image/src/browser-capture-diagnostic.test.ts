import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPTURE_STDERR_TAIL_CHARS,
  captureFailureDiagnostic,
  captureFailureSuffix,
  captureToolOutcome,
  CLI_STDERR_TAIL_CHARS,
  DIAGNOSTIC_SINK_TYPE,
  diagnosticMessage,
  diagnosticSinkLine,
  parseDiagnosticMessage,
  parsePomtreeFailure,
  pomtreeFailureNote,
} from "../ext/pomtree-browser/capture-diagnostic.ts";
import { pomtree } from "./browser-capture.ts";

const noEnv = {};

test("empty stderr yields an empty tail and keeps code and signal", () => {
  assert.deepEqual(captureFailureDiagnostic({ code: 1, signal: null, stderr: "" }, noEnv), { code: 1, signal: null, stderrTail: "", cause: "other" });
  assert.deepEqual(captureFailureDiagnostic({ code: 1, stderr: undefined }, noEnv), { code: 1, signal: null, stderrTail: "", cause: "other" });
});

test("stderr shorter than the limit is kept whole", () => {
  const diagnostic = captureFailureDiagnostic({ code: 2, signal: null, stderr: "navigation timeout" }, noEnv);
  assert.equal(diagnostic.stderrTail, "navigation timeout");
});

test("stderr longer than the limit keeps only the last characters", () => {
  const stderr = `${"a".repeat(2500)}END-MARKER`;
  const { stderrTail } = captureFailureDiagnostic({ code: 1, stderr }, noEnv);
  assert.equal(stderrTail.length, CAPTURE_STDERR_TAIL_CHARS);
  assert.equal(CAPTURE_STDERR_TAIL_CHARS, 2000);
  assert.ok(stderrTail.endsWith("END-MARKER"));
  assert.equal(stderrTail, stderr.slice(-2000));
});

test("tail boundary does not split a surrogate pair", () => {
  const stderr = `${"x".repeat(1999)}😀tail`;
  const { stderrTail } = captureFailureDiagnostic({ code: 1, stderr }, noEnv);
  assert.ok(stderrTail.endsWith("😀tail"));
  assert.ok(!/^[\uDC00-\uDFFF]/.test(stderrTail));
});

test("non-UTF8 bytes are decoded with replacement characters instead of throwing", () => {
  const bytes = new Uint8Array([0x62, 0x61, 0x64, 0xff, 0xfe, 0x21]);
  const { stderrTail } = captureFailureDiagnostic({ code: 1, stderr: bytes }, noEnv);
  assert.equal(stderrTail, "bad��!");
});

test("signal is reported and a null code and signal are preserved as null", () => {
  assert.deepEqual(captureFailureDiagnostic({ code: null, signal: "SIGKILL", stderr: "" }, noEnv), {
    code: null,
    signal: "SIGKILL",
    stderrTail: "",
    cause: "killed",
  });
  assert.deepEqual(captureFailureDiagnostic({ code: null, signal: null, stderr: null }, noEnv), {
    code: null,
    signal: null,
    stderrTail: "",
    cause: "other",
  });
});

test("environment values are never included in the tail", () => {
  const env = { POMTREE_TOKEN: "local-offline-report-token", POMTREE_AGENT_ID: "agent-42", SHORT: "1" };
  const stderr = "upload with local-offline-report-token for agent-42, flag 1";
  const { stderrTail } = captureFailureDiagnostic({ code: 1, stderr }, env);
  assert.equal(stderrTail, "upload with [redacted-env] for [redacted-env], flag 1");
});

test("credentials in URLs and secret-looking key/value pairs are redacted", () => {
  const stderr = "GET https://user:hunter2pass@example.test/x failed; authorization: Bearer abc.def token=xyz123";
  const { stderrTail } = captureFailureDiagnostic({ code: 1, stderr }, noEnv);
  assert.equal(stderrTail, "GET https://example.test/[path-redacted] failed; authorization: [redacted] [redacted] token=[redacted]");
});

test("a URL keeps only scheme, host and port; path, query and fragment are dropped", () => {
  const stderr = "GET https://api.example.test:8443/v1/items/42?key=abc&page=2#frag done";
  const { stderrTail } = captureFailureDiagnostic({ code: 1, stderr }, noEnv);
  assert.equal(stderrTail, "GET https://api.example.test:8443/[path-redacted] done");
});

test("a URL with credentials keeps no userinfo", () => {
  const { stderrTail } = captureFailureDiagnostic({ code: 1, stderr: "fetch https://admin:s3cret@proxy.test:3128/a/b" }, noEnv);
  assert.equal(stderrTail, "fetch https://proxy.test:3128/[path-redacted]");
  assert.ok(!stderrTail.includes("s3cret") && !stderrTail.includes("admin"));
});

test("two URLs on one line are each reduced", () => {
  const stderr = "first http://a.test/p1?x=1 and HTTPS://b.test:444/p2#y end";
  const { stderrTail } = captureFailureDiagnostic({ code: 1, stderr }, noEnv);
  assert.equal(stderrTail, "first http://a.test/[path-redacted] and HTTPS://b.test:444/[path-redacted] end");
});

test("a comma inside a URL query is not a boundary, so nothing after it leaks", () => {
  const { stderrTail } = captureFailureDiagnostic({ code: 1, stderr: "get https://h.test/p?a=1,token=abc123 ok" }, noEnv);
  assert.equal(stderrTail, "get https://h.test/[path-redacted] ok");
});

test("a URL cut off at the end of the tail never leaks its path or partial credentials", () => {
  const cutPath = captureFailureDiagnostic({ code: 1, stderr: "ok https://host.test/private/segm" }, noEnv);
  assert.equal(cutPath.stderrTail, "ok https://host.test/[path-redacted]");
  const cutAuthority = captureFailureDiagnostic({ code: 1, stderr: "ok https://user:pa" }, noEnv);
  assert.equal(cutAuthority.stderrTail, "ok https://[redacted]/[path-redacted]");
  const longTail = captureFailureDiagnostic({ code: 1, stderr: `${"x".repeat(2000)} https://host.te/secret-path` }, noEnv);
  assert.equal(longTail.stderrTail.length, CAPTURE_STDERR_TAIL_CHARS);
  assert.ok(longTail.stderrTail.endsWith(" https://host.te/[path-redacted]"));
  assert.ok(!longTail.stderrTail.includes("secret-path"));
});

test("text without URLs is unchanged", () => {
  const stderr = "navigation failed: net::ERR_NAME_NOT_RESOLVED (code 7), retry in 5s; see docs";
  const { stderrTail } = captureFailureDiagnostic({ code: 1, stderr }, noEnv);
  assert.equal(stderrTail, stderr);
});

test("failure causes are classified from the fixed capture messages and net errors", () => {
  const cause = (stderr: string, signal: string | null = null) => captureFailureDiagnostic({ code: 1, signal, stderr }, noEnv);
  assert.equal(cause("browser capture deadline").cause, "deadline");
  assert.equal(cause("browser article capture requires an HTML main response").cause, "non_html");
  assert.equal(cause("main response exceeds capture bound").cause, "bound");
  assert.equal(cause("capture artifact exceeds byte bound (not truncated)").cause, "bound");
  assert.equal(cause("browser capture missing main response; no raw body receipt can be issued").cause, "no_response");
  assert.equal(cause("capture final URL changed during settle").cause, "navigation_changed");
  assert.equal(cause("scoped report publication failed").cause, "publish_failed");
  assert.equal(cause("capture requires a credential-free bounded HTTP(S) URL").cause, "bad_url");
  assert.equal(cause("browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9222").cause, "cdp_unavailable");
  assert.deepEqual((({ cause: c, netError }) => ({ c, netError }))(cause("page.goto: net::ERR_NAME_NOT_RESOLVED at https://user:pw@x.test/secret?q=1")), {
    c: "navigation_error",
    netError: "ERR_NAME_NOT_RESOLVED",
  });
  assert.equal(cause("", "SIGKILL").cause, "killed");
  assert.equal(
    cause("browser capture stopped: the site served a bot challenge (marker=aws-waf-interstitial); it is not solved or bypassed").cause,
    "bot_challenge",
  );
  assert.equal(cause("page.evaluate: Execution context was destroyed, most likely because of a navigation").cause, "navigation_changed");
  assert.equal(
    cause("browser capture main response cannot be archived (its URL or headers hold characters a WARC header refuses); no raw body receipt can be issued")
      .cause,
    "unarchivable",
  );
  assert.equal(cause("something unexpected").cause, "other");
});

test("the failure suffix has only the closed cause and the net error name", () => {
  assert.equal(captureFailureSuffix({ cause: "navigation_error", netError: "ERR_CONNECTION_RESET" }), "cause=navigation_error net=ERR_CONNECTION_RESET");
  assert.equal(captureFailureSuffix({ cause: "other" }), "cause=other");
});

test("a pomtree publish failure carries its exit code, timeout flag and a redacted one-line tail of at most 500 characters", () => {
  const env = { POMTREE_TOKEN: "local-offline-report-token" };
  const stderr = `browser capture failed\nscoped report publication failed (pomtree code=1 signal=null timedOut=false) stderr: ${"y".repeat(800)} token local-offline-report-token at http://127.0.0.1:3128/v1/reports?x=1\n`;
  const d = captureFailureDiagnostic({ code: 1, signal: null, stderr }, env);
  assert.equal(d.cause, "publish_failed");
  assert.equal(d.pomtree?.code, 1);
  assert.equal(d.pomtree?.timedOut, false);
  assert.equal(d.pomtree?.signal, null);
  const tail = d.pomtree?.stderrTail ?? "";
  assert.equal(Array.from(tail).length, CLI_STDERR_TAIL_CHARS);
  assert.ok(tail.endsWith("token [redacted-env] at http://127.0.0.1:3128/[path-redacted]"), tail);
  assert.doesNotMatch(JSON.stringify(d), /local-offline-report-token|v1\/reports/);
  assert.equal(pomtreeFailureNote(d.pomtree!), "pomtree exit 1");
});

test("pomtree failure notes: timeout, exit code, signal, Node error code; never stderr", () => {
  assert.equal(pomtreeFailureNote({ code: null, signal: "SIGTERM", timedOut: true }), "pomtree timed out");
  assert.equal(pomtreeFailureNote({ code: 7, signal: null, timedOut: false }), "pomtree exit 7");
  assert.equal(pomtreeFailureNote({ code: null, signal: "SIGKILL", timedOut: false }), "pomtree killed by SIGKILL");
  assert.equal(pomtreeFailureNote({ code: "ENOENT", signal: null, timedOut: false }), "pomtree error ENOENT");
  assert.equal(pomtreeFailureNote({ code: null, signal: null, timedOut: false }), "pomtree failed");
  assert.equal(parsePomtreeFailure("scoped report publication failed (pomtree code=ENOENT signal=null timedOut=false)", {})?.code, "ENOENT");
  assert.equal(parsePomtreeFailure("scoped report publication failed (pomtree code=lower;x signal=bogus timedOut=false)", {})?.code, null);
  assert.equal(parsePomtreeFailure("scoped report publication failed (pomtree code=lower;x signal=bogus timedOut=false)", {})?.signal, null);
  assert.equal(parsePomtreeFailure("other failure", {}), undefined);
  assert.equal(captureFailureDiagnostic({ code: 1, stderr: "navigation timeout" }, {}).pomtree, undefined);
});

test("round trip: the message a scripted failing pomtree child produces parses into the failure detail", async () => {
  const env = { POMTREE_TOKEN: "tok-secret-0123456789" };
  const script = 'echo "connect ECONNREFUSED 127.0.0.1:3128 with $POMTREE_TOKEN" >&2; exit 4';
  const message = await pomtree([], { file: "/bin/sh", argv: ["-c", script] }, env).then(
    () => "",
    (err: Error) => err.message,
  );
  const d = captureFailureDiagnostic({ code: 1, signal: null, stderr: `${message}\n` }, env);
  assert.deepEqual(d.pomtree, { code: 4, signal: null, timedOut: false, stderrTail: "connect ECONNREFUSED 127.0.0.1:3128 with [redacted-env]" });
  assert.equal(d.cause, "publish_failed");
  assert.doesNotMatch(JSON.stringify(d), /tok-secret/);
});

test("the operator diagnostic message round-trips, is one sink line, and a clipped detail loses only its stderr tails", () => {
  const diagnostic = captureFailureDiagnostic(
    { code: 1, stderr: "scoped report publication failed (pomtree code=3 signal=null timedOut=false) stderr: boom" },
    noEnv,
  );
  const detail = { tool: "browser_capture", toolCallId: "c1", ...diagnostic };
  const line = diagnosticSinkLine("browser-capture-failure", detail);
  assert.ok(line.endsWith("\n") && line.indexOf("\n") === line.length - 1, "exactly one line");
  const record = JSON.parse(line);
  assert.equal(record.type, DIAGNOSTIC_SINK_TYPE);
  assert.deepEqual(parseDiagnosticMessage(record.message), { name: "browser-capture-failure", detail: JSON.parse(JSON.stringify(detail)) });
  const big = { cause: "other", stderrTail: "𝒳".repeat(CAPTURE_STDERR_TAIL_CHARS * 3), pomtree: { code: 1, stderrTail: "𝒳".repeat(3000) } };
  const clipped = parseDiagnosticMessage(diagnosticMessage("browser-capture-failure", big));
  assert.deepEqual(clipped?.detail, { cause: "other", stderrTail: "", pomtree: { code: 1, stderrTail: "" }, clipped: true });
});

test("the diagnostic message refuses a bad name, and the parser rejects anything that is not one", () => {
  assert.throws(() => diagnosticMessage("Bad Name", {}), /diagnostic name/);
  for (const m of [
    "trusted browser capture failed",
    "operator-diagnostic",
    "operator-diagnostic x{}",
    "operator-diagnostic Bad {}",
    "operator-diagnostic a [1]",
    "operator-diagnostic a nope",
    "operator-diagnostic a null",
  ])
    assert.equal(parseDiagnosticMessage(m), undefined, m);
});

const CAUSE_AT_END = /\(cause=([a-z_]{1,32})(?: net=ERR_[A-Z0-9_]{1,64})?\)$/;
test("a capture killed at the tool timeout (Pi: code 0, killed, empty stdout) is a deadline failure with its stderr tail, never a JSON parse error", () => {
  const out = captureToolOutcome({ code: 0, killed: true, stdout: "", stderr: "page.goto at https://x.test/secret\n" }, false, noEnv);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.diagnostic.cause, "deadline");
  assert.equal(out.diagnostic.timedOut, true);
  assert.equal(out.diagnostic.stderrTail, "page.goto at https://x.test/[path-redacted]\n");
  assert.equal(
    out.message,
    "trusted browser capture failed; no receipt issued; the capture did not finish within its deadline and was stopped; retrying will not help, choose another source (cause=deadline)",
  );
  assert.equal(CAUSE_AT_END.exec(out.message)?.[1], "deadline");
  // The journaled copy is one operator-diagnostic sink line carrying the cause and the tail.
  const line = JSON.parse(diagnosticSinkLine("browser-capture-failure", { tool: "browser_capture", ...out.diagnostic })) as { message: string };
  assert.deepEqual(parseDiagnosticMessage(line.message)?.detail.cause, "deadline");
});

test("capture tool outcomes: a stopped worker is killed, an unparsable receipt is other, a failed exit keeps its classification, a receipt passes", () => {
  const stopped = captureToolOutcome({ code: 0, killed: true, stdout: "" }, true, noEnv);
  assert.equal(!stopped.ok && stopped.diagnostic.cause, "killed");
  assert.equal(!stopped.ok && stopped.diagnostic.timedOut, undefined);
  const garbled = captureToolOutcome({ code: 0, stdout: "not json" }, false, noEnv);
  assert.equal(!garbled.ok && garbled.diagnostic.cause, "other");
  assert.equal(!garbled.ok && garbled.diagnostic.unparsableReceipt, true);
  const challenge = captureToolOutcome(
    { code: 1, stdout: "", stderr: "browser capture stopped: the site served a bot challenge (marker=aws-waf-token-script); it is not solved or bypassed" },
    false,
    noEnv,
  );
  assert.equal(
    !challenge.ok && challenge.message,
    "trusted browser capture failed; no receipt issued; the site served a bot challenge; automated capture is not possible here; do not retry (cause=bot_challenge)",
  );
  const nav = captureToolOutcome({ code: 1, stdout: "", stderr: "capture page navigated after load (x)" }, false, noEnv);
  assert.equal(!nav.ok && CAUSE_AT_END.exec(nav.message)?.[1], "navigation_changed");
  assert.match(!nav.ok ? nav.message : "", /navigated away after loading.*retrying will not help/);
  const unarchivable = captureToolOutcome(
    { code: 1, stdout: "", stderr: "Error: browser capture main response cannot be archived (its URL or headers hold characters a WARC header refuses)" },
    false,
    noEnv,
  );
  assert.equal(
    !unarchivable.ok && unarchivable.message,
    "trusted browser capture failed; no receipt issued; the page's URL or response headers cannot be stored in an archive; retrying will not help, choose another source (cause=unarchivable)",
  );
  const bound = captureToolOutcome({ code: 1, stdout: "", stderr: "main response exceeds capture bound" }, false, noEnv);
  assert.equal(!bound.ok && bound.message, "trusted browser capture failed; no receipt issued (cause=bound)");
  assert.deepEqual(captureToolOutcome({ code: 0, stdout: '{"a":1}\n' }, false, noEnv), { ok: true, receipt: { a: 1 } });
});
