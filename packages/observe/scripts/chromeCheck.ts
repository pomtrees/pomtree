// Repeatable real-browser check of the window chrome, the launcher bar and opening an item window (TODO(chrome-browser-check)
// in src/chromeCss.ts, docs/ui-vision.md "Checked"). Run: `pnpm --filter @pomtree/observe check:chrome`, or
// `node scripts/chromeCheck.ts` from packages/observe. Uses a locally installed Chrome or Chromium (CHROME_BIN, else
// google-chrome / chromium on PATH) headless, no npm dependency: the page is served by a stubbed daemon on 127.0.0.1 and
// driven over the DevTools protocol with node built-ins. With no browser it prints why and exits 0 (a skip, not a pass).
//
// Each assertion reads real layout from the browser (rectangles, computed style, focus, real key events). To prove they can
// fail, the same run repeats on pages with one stylesheet rule deliberately broken and requires the matching assertion to
// fail there; a control that passes fails the run. Exit 0: all assertions hold and every control was caught (or skipped).
import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderNewAgentPane } from "../src/newAgent.ts";
import { renderInboxPane } from "../src/inbox.ts";
import { renderShell } from "../src/shell.ts";
import { renderAuditPane, renderHostsPane, renderSchedulesPane } from "../src/tabs.ts";
import { renderReportsPane, renderTreePane } from "../src/web.ts";
import { findChrome, parseDevToolsUrl, STUB_STREAMS, stubReply } from "./chromeCheckLib.ts";

const WIDE = { width: 1200, height: 800 };
const NARROW = { width: 380, height: 800 };
// Viewport heights tried, tallest first, for the menu-escape check; three stacked tiles share the height.
const HEIGHTS = [420, 340, 280, 240, 200, 160, 120];

interface Variant {
  name: string;
  mutate: (html: string) => string;
  // The assertion id that must fail on this page; null for the real page, where every assertion must pass.
  breaks: string | null;
}

// An invalid selector drops its whole rule, so renaming the pseudo-class removes the rule without touching anything else.
const VARIANTS: Variant[] = [
  { name: "real page", mutate: (h) => h, breaks: null },
  { name: "control: :has() rule removed", mutate: (h) => h.replace(".tile:has(", ".tile:has-removed("), breaks: "menu-escapes-tile" },
  {
    name: "control: container query removed",
    mutate: (h) => h.replace("@container tile (max-width", "@container tile (min-width: 99999px) and (max-width"),
    breaks: "narrow-tile-overflow-menu",
  },
];

function pageHtml(): string {
  const tab = (id: string, title: string, render: () => string) => ({ id, title, render });
  return renderShell({
    tabs: [
      tab("tree", "Tree", () => renderTreePane({ eventsPath: "/live/events" })),
      tab("reports", "Reports", () => renderReportsPane()),
      tab("audit", "Audit", () => renderAuditPane()),
      tab("new", "+ New agent", () => renderNewAgentPane()),
      tab("schedules", "Schedules", () => renderSchedulesPane()),
      tab("hosts", "Hosts", () => renderHostsPane()),
      tab("inbox", "Inbox", () => renderInboxPane()),
    ],
    prefix: "/",
    title: "pomtree chrome check",
  });
}

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// ---- the stubbed daemon ----
interface Stub {
  server: Server;
  origin: string;
  hits: Map<string, number>;
  close(): Promise<void>;
}

async function startStub(variants: Map<string, string>): Promise<Stub> {
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub.invalid");
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(variants.get(url.searchParams.get("variant") ?? "") ?? "");
      return;
    }
    if ((STUB_STREAMS as readonly string[]).includes(url.pathname)) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": open\n\n");
      return; // held open, nothing sent
    }
    const r = stubReply(req.url ?? "/");
    res.writeHead(r.status, { "content-type": r.type });
    res.end(r.body);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

// ---- a minimal DevTools protocol client ----
class Cdp {
  private next = 1;
  private pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  private ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.fail(new Error(msg.error.message));
      else p.ok(msg.result);
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((ok, fail) => {
      ws.addEventListener("open", () => ok(), { once: true });
      ws.addEventListener(
        "error",
        () => fail(new Error(`could not open the DevTools socket at ${url}; check that Chrome started and nothing blocks 127.0.0.1`)),
        { once: true },
      );
    });
    return new Cdp(ws);
  }
  send<T = unknown>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.next++;
    return new Promise<T>((ok, fail) => {
      this.pending.set(id, { ok: ok as (v: unknown) => void, fail });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close(): void {
    this.ws.close();
  }
}

class Page {
  private cdp: Cdp;
  private session: string;
  private target: string;
  constructor(cdp: Cdp, session: string, target: string) {
    this.cdp = cdp;
    this.session = session;
    this.target = target;
  }
  // Evaluates an expression in the page (awaiting a returned promise) and returns its JSON value.
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.cdp.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      this.session,
    );
    if (r.exceptionDetails) throw new Error(`page script threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }
  // Polls an expression in the page until it is truthy; rejects with the label when it never is.
  async waitFor(label: string, expression: string, ms = 8000): Promise<void> {
    const ok = await this.eval<boolean>(
      `new Promise((resolve) => { const end = Date.now() + ${ms}; const tick = () => { let v = false; try { v = !!(${expression}); } catch (e) {} if (v) resolve(true); else if (Date.now() > end) resolve(false); else setTimeout(tick, 50); }; tick(); })`,
    );
    if (!ok) throw new Error(`timed out after ${ms} ms waiting for ${label}; the page never reached that state (see the preceding assertions)`);
  }
  size(s: { width: number; height: number }): Promise<unknown> {
    return this.cdp.send("Emulation.setDeviceMetricsOverride", { ...s, deviceScaleFactor: 1, mobile: false }, this.session);
  }
  async key(key: string, code: string, windowsVirtualKeyCode: number): Promise<void> {
    for (const type of ["rawKeyDown", "keyUp"]) await this.cdp.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode }, this.session);
  }
  async navigate(url: string): Promise<void> {
    await this.cdp.send("Page.navigate", { url }, this.session);
  }
  async close(): Promise<void> {
    await this.cdp.send("Target.closeTarget", { targetId: this.target });
  }
  static async open(cdp: Cdp): Promise<Page> {
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(cdp, sessionId, targetId);
    await cdp.send("Page.enable", {}, sessionId);
    // A fresh layout every time: the shell restores its saved tiling from localStorage, which is shared across the pages.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.clear(); } catch (e) {}" }, sessionId);
    return page;
  }
}

// ---- the assertions ----
interface Result {
  id: string;
  ok: boolean;
  detail: string;
}

const results: Result[] = [];
async function check(id: string, body: () => Promise<string | true>): Promise<void> {
  try {
    const r = await body();
    results.push({ id, ok: r === true, detail: r === true ? "" : r });
  } catch (e) {
    results.push({ id, ok: false, detail: (e as Error).message });
  }
}

// Opens the first menu of the report tile and reports whether every item of its panel is the topmost element at its centre.
// The run only proves something when the last item sits below the tile's own bottom edge, otherwise it asks for a shorter page.
const MENU_ESCAPE_PROBE = `(async () => {
  const tile = document.querySelector(".md")?.closest(".tile") ?? document.querySelector(".tile");
  const btn = tile.querySelector(".tile-menus .tile-btn");
  btn.click();
  await new Promise((r) => setTimeout(r, 100));
  const items = [...btn.closest(".menuwrap").querySelectorAll(".menu-drop .menu-item")];
  const tileBottom = tile.getBoundingClientRect().bottom;
  const centre = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const covered = items.filter((i) => {
    const c = centre(i);
    if (c.y >= innerHeight) return false;
    const hit = document.elementFromPoint(c.x, c.y);
    return !(hit && (hit === i || i.contains(hit)));
  });
  const lastY = items.length ? centre(items[items.length - 1]).y : 0;
  btn.click();
  if (!items.length) return { ok: false, why: "the menu opened with no items" };
  if (lastY <= tileBottom) return { ok: false, why: "the last menu item (centre " + Math.round(lastY) + " px) is still inside its tile (" + Math.round(tileBottom) + " px bottom), so this run cannot show clipping; no height in HEIGHTS was short enough" };
  return covered.length === 0 ? { ok: true, why: "" } : { ok: false, why: covered.length + " of " + items.length + " menu items are covered or clipped (first: " + covered[0].textContent.trim() + ")" };
})()`;

async function runChecks(page: Page, stub: Stub, url: string): Promise<void> {
  results.length = 0;
  await page.size(WIDE);
  await page.navigate(url);

  await check("launcher-bar-connected", async () => {
    await page.waitFor(
      "the launcher bar to report a connection",
      `document.querySelector("#lb-bar .lb-start") && document.querySelector("#lb-bar .lb-dot.ok")`,
    );
    return true;
  });
  await check("launcher-polls-status-endpoints", async () => {
    const missing = ["/v1/agents", "/v1/approvals", "/v1/escalations"].filter((p) => (stub.hits.get(p) ?? 0) < 1);
    return missing.length === 0 ? true : `the bar never requested ${missing.join(", ")}`;
  });

  await check("item-window-opens-from-hash", async () => {
    await page.eval(`location.hash = "#/report/a1/r1"`);
    await page.waitFor(
      "the report window to show its text",
      `[...document.querySelectorAll(".tile")].some((t) => t.querySelector(".tile-title")?.textContent.includes("notes.md") && t.querySelector(".md")?.textContent.includes("Chrome check report"))`,
    );
    return true;
  });
  await check("launcher-lists-the-open-window", async () => {
    const labels = await page.eval<string[]>(`[...document.querySelectorAll("#lb-bar .lb-win")].map((b) => b.textContent)`);
    return labels.some((l) => l.includes("Report") && l.includes("r1")) ? true : `the bar lists ${JSON.stringify(labels)}, none naming the report r1`;
  });

  await check("wide-tile-shows-menu-bar", async () => {
    const r = await page.eval<{ menus: string; overflow: string; buttons: number }>(
      `(() => { const t = [...document.querySelectorAll(".tile")].find((x) => x.querySelector(".md")); return { menus: getComputedStyle(t.querySelector(".tile-menus")).display, overflow: getComputedStyle(t.querySelector(".tile-overflow")).display, buttons: t.querySelectorAll(".tile-menus .tile-btn").length }; })()`,
    );
    return r.menus !== "none" && r.overflow === "none" && r.buttons > 0
      ? true
      : `at 1200 px the menu bar is ${r.menus} with ${r.buttons} menus and the overflow button is ${r.overflow}; expected a visible bar and a hidden overflow button`;
  });

  await check("keyboard-opens-and-closes-menu", async () => {
    await page.eval(`document.querySelector(".md").closest(".tile").querySelector(".tile-menus .tile-btn").focus()`);
    await page.key("ArrowDown", "ArrowDown", 40);
    await page.waitFor(
      "a menu item to take focus after ArrowDown",
      `document.activeElement?.classList.contains("menu-item") && document.activeElement.closest(".menu-drop")`,
    );
    const open = await page.eval<boolean>(`document.activeElement.closest(".menuwrap").querySelector(".tile-btn").getAttribute("aria-expanded") === "true"`);
    if (!open) return "ArrowDown moved focus into a menu but its button is not aria-expanded";
    await page.key("Escape", "Escape", 27);
    await page.waitFor(
      "Escape to close the menu and return focus to its button",
      `document.activeElement?.classList.contains("tile-btn") && document.activeElement.getAttribute("aria-expanded") === "false"`,
    );
    return true;
  });

  await check("narrow-tile-overflow-menu", async () => {
    await page.size(NARROW);
    await page.eval(`wm.api.focus(wm.api.state().leaves.find((l) => l.view === "report").id)`);
    await page.waitFor("the narrow layout to settle", `document.documentElement.clientWidth <= ${NARROW.width}`);
    const r = await page.eval<{ menus: string; overflow: string }>(
      `(() => { const t = [...document.querySelectorAll(".tile")].find((x) => x.querySelector(".tile-menus")); return { menus: getComputedStyle(t.querySelector(".tile-menus")).display, overflow: getComputedStyle(t.querySelector(".tile-overflow")).display }; })()`,
    );
    if (r.menus !== "none" || r.overflow === "none")
      return `at ${NARROW.width} px the menu bar is ${r.menus} and the overflow button is ${r.overflow}; expected the bar hidden and the overflow button shown (container query)`;
    const n = await page.eval<number>(
      `(async () => { const b = document.querySelector(".tile-overflow .tile-btn"); b.click(); await new Promise((x) => setTimeout(x, 100)); const n = document.querySelectorAll(".tile-overflow .menu-item").length; b.click(); return n; })()`,
    );
    return n > 0 ? true : "the overflow button opened a menu with no items";
  });
  await page.size(WIDE);
  await page.waitFor("the wide layout to return", `!wm.api.state().narrow`);

  await check("menu-escapes-tile", async () => {
    // The report window split in two, twice, at a short height: the open menu's panel is taller than the room left in its own tile, so it only
    // shows if the tile stops clipping (the :has() rule) and stacks above its neighbour. The height shrinks until the
    // panel overruns its tile, so the check does not depend on one font size.
    for (let i = 0; i < 2; i++) {
      await page.eval(`wm.api.focus(wm.api.state().leaves.find((l) => l.view === "report").id)`);
      await page.eval(`wm.api.splitFocused("col")`);
    }
    await page.waitFor("the report window to be split twice", `wm.api.state().leaves.length >= 4`);
    let probe = { ok: false, why: "no height tried" };
    for (const height of HEIGHTS) {
      await page.size({ width: WIDE.width, height });
      probe = await page.eval<{ ok: boolean; why: string }>(MENU_ESCAPE_PROBE);
      if (probe.ok || !probe.why.includes("cannot show clipping")) break;
    }
    return probe.ok ? true : probe.why;
  });
}

// ---- launching Chrome ----
async function launch(chrome: string, profile: string): Promise<{ child: ChildProcess; url: string }> {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ];
  if (typeof process.getuid === "function" && process.getuid() === 0) args.unshift("--no-sandbox"); // Chrome refuses to run as root otherwise
  const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
  const url = await new Promise<string>((ok, fail) => {
    let seen = "";
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            `Chrome did not print its DevTools address within 20 s; output so far: ${seen.slice(-300)}. Run ${chrome} --headless=new by hand to see why.`,
          ),
        ),
      20000,
    );
    child.stderr?.on("data", (d: Buffer) => {
      seen += d.toString();
      const u = parseDevToolsUrl(seen);
      if (u) {
        clearTimeout(timer);
        ok(u);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(
        new Error(
          `Chrome exited with code ${code} before it was ready; output: ${seen.slice(-300)}. If it is sandboxing, run as a user that Chrome supports or set up its sandbox.`,
        ),
      );
    });
  });
  return { child, url };
}

async function main(): Promise<number> {
  const found = findChrome(process.env, isExecutable);
  if (found.kind === "skip") {
    console.log(`chrome check SKIPPED: ${found.reason}`);
    return 0;
  }
  if (found.kind === "error") {
    console.error(`chrome check ERROR: ${found.message}`);
    return 1;
  }
  console.log(`chrome check: using ${found.path} (from ${found.via})`);

  const base = pageHtml();
  const stub = await startStub(new Map(VARIANTS.map((v, i) => [String(i), v.mutate(base)])));
  const profile = mkdtempSync(join(tmpdir(), "pomtree-chrome-check-"));
  let child: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  let failed = 0;
  try {
    const launched = await launch(found.path, profile);
    child = launched.child;
    cdp = await Cdp.connect(launched.url);
    for (const [i, v] of VARIANTS.entries()) {
      const page = await Page.open(cdp);
      await runChecks(page, stub, `${stub.origin}/?variant=${i}`);
      await page.close();
      console.log(`\n${v.name}`);
      for (const r of results) {
        const expectedFail = r.id === v.breaks;
        const good = expectedFail ? !r.ok : v.breaks === null ? r.ok : true;
        console.log(`  ${r.ok ? "pass" : "FAIL"} ${r.id}${r.ok ? "" : `: ${r.detail}`}${expectedFail ? "  (expected to fail here)" : ""}`);
        if (!good) failed++;
      }
      if (v.breaks !== null && !results.some((r) => r.id === v.breaks)) {
        console.log(`  FAIL ${v.breaks}: assertion never ran on the control page`);
        failed++;
      }
    }
  } catch (e) {
    console.error(`chrome check ERROR: ${(e as Error).message}`);
    failed++;
  } finally {
    cdp?.close();
    const running = child;
    if (running && running.exitCode === null) {
      const exited = new Promise<void>((ok) => running.once("exit", () => ok()));
      running.kill("SIGTERM");
      const waitMs = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
      await Promise.race([exited, waitMs(5000)]);
      if (running.exitCode === null && running.signalCode === null) {
        // Chrome ignored SIGTERM: kill it so it cannot keep writing into the profile directory removed below.
        running.kill("SIGKILL");
        await Promise.race([exited, waitMs(2000)]);
      }
    }
    await stub.close();
    rmSync(profile, { recursive: true, force: true });
  }
  console.log(failed === 0 ? "\nchrome check PASSED" : `\nchrome check FAILED: ${failed} problem(s)`);
  return failed === 0 ? 0 : 1;
}

process.exitCode = await main();
