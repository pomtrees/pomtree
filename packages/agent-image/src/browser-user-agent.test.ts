// The Pi tool capture's User-Agent (decision C4): Chromium's own string with the operator's workflow.fetch.userAgent appended, set at
// context creation, checked against the header the main request sent, and recorded in the navigation log. Offline: scripted fakes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  BROWSER_USER_AGENT_ENV,
  BROWSER_VIEWPORT,
  browserOperatorUserAgent,
  type CaptureBrowserLike,
  type CapturePage,
  captureBrowser,
  captureLimits,
  composeUserAgent,
  composeUserAgentOnce,
  openCaptureContext,
  runCaptureProcess,
} from "./browser-capture.ts";
import { BROWSER_PROXY_URL, type ChromiumLauncher, chromiumArgs, launchIdentifiedChromium, startChromium } from "./browser-run.ts";
import { CONTAINER_DEFAULTS } from "./container-contract.gen.ts";

const CHROMIUM = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36";
const CONFIGURED = "acme-research (+https://example.org/contact)";
// The registry default of workflow.fetch.userAgent (core DEFAULT_FETCH_USER_AGENT); this layer never supplies it, pomtreed passes it.
const DEFAULT = "pomtree";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const LIMITS = captureLimits(CONTAINER_DEFAULTS);
const sha = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");

// A page whose main request carries `sent` as its User-Agent header (undefined: the response exposes no request, as a stub that sends none).
function fakePage(sent: string | null | undefined): CapturePage {
  const response = {
    body: async () => new TextEncoder().encode("<html><p>ok</p></html>"),
    status: () => 200,
    headerValue: async (n: string) => (n === "content-type" ? "text/html" : null),
    ...(sent !== undefined && { request: () => ({ headerValue: async (n: string) => (n === "user-agent" ? sent : null) }) }),
  };
  return {
    goto: async () => response,
    url: () => "https://example.test/a",
    evaluate: async () => ({ dom: "<html><p>ok</p></html>", text: "ok" }),
    screenshot: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    close: async () => {},
  };
}
// A Playwright Browser stand-in: Browser.getVersion answers `chromium`; each context's page sends the context's userAgent, unless
// `pageSends` scripts another header (a hard-coded identity) or none.
function fakeBrowser(chromium: unknown, pageSends?: (contextUa: string) => string | null | undefined) {
  const contexts: Parameters<CaptureBrowserLike["newContext"]>[0][] = [];
  const browser: CaptureBrowserLike = {
    newBrowserCDPSession: async () => ({ send: async () => ({ userAgent: chromium }) }),
    newContext: async (opts) => {
      contexts.push(opts);
      return { newPage: async () => fakePage(pageSends ? pageSends(opts.userAgent) : opts.userAgent), close: async () => {} };
    },
  };
  return { browser, contexts };
}
function publisher() {
  const published: { name: string; data: Uint8Array }[] = [];
  return {
    published,
    publish: async (data: Uint8Array, name: string) => {
      published.push({ name, data });
      return { id: `id-${published.length}`, sha256: sha(data) };
    },
  };
}
const opts = (pub: ReturnType<typeof publisher>) => ({
  url: "https://example.test/a",
  maxBytes: 65536,
  deadlineMs: 5000,
  limits: LIMITS,
  settle: { pollMs: 1, stablePolls: 2, maxMs: 50 },
  worker: "w1",
  generation: 1,
  publish: pub.publish,
});
const navigationOf = (pub: ReturnType<typeof publisher>) =>
  JSON.parse(new TextDecoder().decode(pub.published.find((p) => p.name === "browser-navigation")!.data)) as Record<string, unknown>;

test("the composed User-Agent is Chromium's own plus a space and the operator value, for a configured value and for the default", () => {
  assert.equal(composeUserAgent(CHROMIUM, CONFIGURED), `${CHROMIUM} ${CONFIGURED}`);
  assert.equal(composeUserAgent(CHROMIUM, DEFAULT), `${CHROMIUM} pomtree`);
  assert.ok(composeUserAgent(CHROMIUM, DEFAULT).startsWith(CHROMIUM), "Chromium's string stays the base, never replaced");
});

test("browserOperatorUserAgent reads PTREE_BROWSER_USER_AGENT verbatim; absent, empty or header-unsafe refuses naming workflow.fetch.userAgent", () => {
  assert.equal(BROWSER_USER_AGENT_ENV, "PTREE_BROWSER_USER_AGENT");
  assert.equal(browserOperatorUserAgent({ PTREE_BROWSER_USER_AGENT: CONFIGURED }), CONFIGURED);
  assert.equal(browserOperatorUserAgent({ PTREE_BROWSER_USER_AGENT: DEFAULT }), DEFAULT);
  assert.throws(
    () => browserOperatorUserAgent({}),
    /^Error: browser capture refused: PTREE_BROWSER_USER_AGENT is not set; pomtreed must pass the resolved workflow\.fetch\.userAgent/,
  );
  assert.throws(
    () => browserOperatorUserAgent({ PTREE_BROWSER_USER_AGENT: "" }),
    /browser capture refused: PTREE_BROWSER_USER_AGENT is empty; pomtreed must pass the resolved workflow\.fetch\.userAgent/,
  );
  assert.throws(() => browserOperatorUserAgent({ PTREE_BROWSER_USER_AGENT: "a\r\nX-Injected: 1" }), /must be printable ASCII/);
});

test("openCaptureContext sets the composed User-Agent at context creation (configured value and default)", async () => {
  for (const operator of [CONFIGURED, DEFAULT]) {
    const { browser, contexts } = fakeBrowser(CHROMIUM);
    const session = await openCaptureContext(browser, operator);
    assert.equal(session.userAgent, `${CHROMIUM} ${operator}`);
    assert.deepEqual(contexts, [{ acceptDownloads: false, serviceWorkers: "block", viewport: BROWSER_VIEWPORT, userAgent: `${CHROMIUM} ${operator}` }]);
  }
  const unread = fakeBrowser(undefined);
  await assert.rejects(openCaptureContext(unread.browser, CONFIGURED), /browser capture could not read Chromium's own User-Agent over CDP/);
  assert.equal(unread.contexts.length, 0, "no context opens without Chromium's own string");
});

test("the navigation log records the User-Agent header the main request sent, which equals the composed one", async () => {
  for (const operator of [CONFIGURED, DEFAULT]) {
    const { browser } = fakeBrowser(CHROMIUM);
    const pub = publisher();
    await runCaptureProcess(() => openCaptureContext(browser, operator), opts(pub));
    assert.equal(navigationOf(pub).userAgent, `${CHROMIUM} ${operator}`);
  }
});

test("negative controls: a page that sends no User-Agent, or a hard-coded desktop one, fails with no navigation log", async () => {
  for (const [sends, re] of [
    [() => undefined, /could not read the User-Agent the main request sent; no receipt is issued/],
    [() => null, /could not read the User-Agent the main request sent/],
    [() => DESKTOP, /browser capture sent User-Agent "Mozilla\/5\.0 \(Windows NT 10\.0.*not the composed ".*HeadlessChrome.* acme-research/],
    [() => CHROMIUM, /not the composed/],
  ] as const) {
    const { browser } = fakeBrowser(CHROMIUM, sends);
    const pub = publisher();
    await assert.rejects(
      runCaptureProcess(() => openCaptureContext(browser, CONFIGURED), opts(pub)),
      re,
    );
    assert.equal(
      pub.published.some((p) => p.name === "browser-navigation"),
      false,
    );
  }
});

test("a capture given no User-Agent (a host-side harness) neither checks nor records one", async () => {
  const pub = publisher();
  await captureBrowser(fakePage(undefined), opts(pub));
  assert.equal("userAgent" in navigationOf(pub), false);
});

test("openCaptureContext under the Pi worker's --user-agent: a reported string that is already the composition is not appended twice", async () => {
  for (const operator of [CONFIGURED, DEFAULT]) {
    assert.equal(composeUserAgentOnce(`${CHROMIUM} ${operator}`, operator), `${CHROMIUM} ${operator}`);
    assert.equal(composeUserAgentOnce(CHROMIUM, operator), `${CHROMIUM} ${operator}`);
    const { browser, contexts } = fakeBrowser(`${CHROMIUM} ${operator}`);
    const session = await openCaptureContext(browser, operator);
    assert.equal(session.userAgent, `${CHROMIUM} ${operator}`);
    assert.equal(contexts[0]?.userAgent, `${CHROMIUM} ${operator}`);
  }
  assert.throws(() => composeUserAgentOnce("", CONFIGURED), /could not read Chromium's own User-Agent/);
});

// A scripted launcher over startChromium with a recording spawn: the real argv of each start, and the order of starts and stops.
function fakeLauncher(o: { own?: string | undefined; failSecond?: boolean } = {}) {
  const log: string[] = [];
  const argvs: (readonly string[])[] = [];
  const spawnFn = ((_file: string, args: readonly string[]) => {
    argvs.push(args);
    return { n: argvs.length } as never;
  }) as never;
  let started = 0;
  const launcher: ChromiumLauncher<{ n: number }> = {
    start(userAgent) {
      log.push(`start:${userAgent ?? "own"}`);
      startChromium(BROWSER_PROXY_URL, spawnFn, userAgent);
      return { n: ++started };
    },
    async ready(chrome) {
      log.push(`ready:${chrome.n}`);
      if (o.failSecond && chrome.n === 2)
        throw new Error("Chromium sandbox/CDP unavailable; no --no-sandbox fallback. Verify platform seccomp/user namespaces and Chromium stderr.");
    },
    async userAgent() {
      log.push("read-ua");
      return "own" in o ? o.own : CHROMIUM;
    },
    async stop(chrome) {
      log.push(`stop:${chrome.n}`);
    },
  };
  return { launcher, log, argvs };
}
const userAgentFlags = (argv: readonly string[]) => argv.filter((a) => a.startsWith("--user-agent"));

test("launchIdentifiedChromium restarts Chromium with --user-agent=<own> <operator> (configured value and default); the first start carries none", async () => {
  for (const operator of [CONFIGURED, DEFAULT]) {
    const { launcher, log, argvs } = fakeLauncher();
    const { chrome, userAgent } = await launchIdentifiedChromium(launcher, operator);
    assert.equal(userAgent, `${CHROMIUM} ${operator}`);
    assert.equal(chrome.n, 2);
    assert.deepEqual(log, ["start:own", "ready:1", "read-ua", "stop:1", `start:${CHROMIUM} ${operator}`, "ready:2"]);
    assert.equal(argvs.length, 2);
    assert.deepEqual(userAgentFlags(argvs[0]!), []);
    assert.deepEqual(userAgentFlags(argvs[1]!), [`--user-agent=${CHROMIUM} ${operator}`]);
    // The flag only adds the identity: every other hardening flag of the first start is unchanged, and about:blank stays last.
    assert.deepEqual(
      argvs[1]!.filter((a) => !a.startsWith("--user-agent")),
      argvs[0],
    );
    assert.equal(argvs[1]!.at(-1), "about:blank");
  }
});

test("launchIdentifiedChromium: a failed second start fails the worker naming the restart, with no stock-User-Agent fallback", async () => {
  const { launcher, log, argvs } = fakeLauncher({ failSecond: true });
  await assert.rejects(
    launchIdentifiedChromium(launcher, CONFIGURED),
    /^Error: browser worker could not restart Chromium with --user-agent \(Chromium's own plus workflow\.fetch\.userAgent\); it does not fall back to the stock User-Agent\. Chromium sandbox\/CDP unavailable/,
  );
  assert.equal(argvs.length, 2, "no third start without the flag");
  assert.deepEqual(log.slice(-2), [`start:${CHROMIUM} ${CONFIGURED}`, "ready:2"]);
});

test("launchIdentifiedChromium: an unreadable or unsafe own User-Agent stops the first Chromium and never starts a second", async () => {
  for (const own of [undefined, "", "Chromium\r\nX-Injected: 1"]) {
    const { launcher, log, argvs } = fakeLauncher({ own });
    await assert.rejects(
      launchIdentifiedChromium(launcher, CONFIGURED),
      /could not read Chromium's own User-Agent from CDP \/json\/version.*does not fall back to the stock User-Agent/,
    );
    assert.equal(argvs.length, 1);
    assert.deepEqual(log, ["start:own", "ready:1", "read-ua", "stop:1"]);
  }
});

test("negative control: the stock User-Agent never reaches the final launch, and chromiumArgs refuses a header-unsafe --user-agent", async () => {
  const { launcher, argvs } = fakeLauncher();
  await launchIdentifiedChromium(launcher, CONFIGURED);
  const final = userAgentFlags(argvs.at(-1)!);
  assert.equal(final.length, 1);
  assert.notEqual(final[0], `--user-agent=${CHROMIUM}`);
  assert.ok(final[0]!.endsWith(` ${CONFIGURED}`));
  assert.throws(() => chromiumArgs(BROWSER_PROXY_URL, `${CHROMIUM}\r\nX-Injected: 1`), /refused a --user-agent that is not printable ASCII/);
  // The worker reads the operator value before Chromium starts, with browserOperatorUserAgent's named "browser capture refused" error.
  for (const v of ["", "a\r\nX-Injected: 1"])
    assert.throws(() => browserOperatorUserAgent({ [BROWSER_USER_AGENT_ENV]: v }), /^Error: browser capture refused: PTREE_BROWSER_USER_AGENT /);
});
