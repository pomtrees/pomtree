// Docker-gated AND network-gated: scripted offline Pi (no model call) drives browser_capture at a real public article through the audited-public egress path.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DEFAULTS } from "@pomtree/core";
import { DockerSandbox } from "./docker.ts";
import { BROWSER_BACKGROUND } from "./egress.ts";
import { AUDIT_CHAIN_RE, DiskEgressAudit, sealAuditChain, type EgressAuditRecord } from "./audit.ts";
import { IMAGE, pinnedImage, gate, testEgressNetwork } from "./docker-gate.ts";
import { containerConfigTestEnv, OFFLINE_BROWSER_EXT, offlineBrowserExtMount, stubMounts, wsMount } from "./test-mounts.ts";
const egressNetwork = testEgressNetwork();

const ARTICLE = "https://www.rfc-editor.org/rfc/rfc2324.html";
const PHRASE = "Hyper Text Coffee Pot Control Protocol";
// Every authority the page is expected to pull; anything else (private, loopback, metadata, unknown host) fails the test.
const PAGE_AUTHORITIES = new Set(["www.rfc-editor.org:443"]);
const skip =
  gate() ||
  (process.env.PTREE_NET_TESTS !== "1" && "PTREE_NET_TESTS not set (public-web test; offline CI skips)") ||
  (process.getuid?.() === 0 && "audited-public requires unprivileged host uid");
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

test("scripted Pi browser_capture reads a real public article through the audited-public proxy", { skip, timeout: 150000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-docker-article-")));
  const work = join(root, "work");
  mkdirSync(work, { mode: 0o755 });
  chmodSync(root, 0o755);
  const sb = new DockerSandbox({
    mounts: stubMounts(() => work),
    egressProxyImage: pinnedImage(),
    egressAuditRoot: join(root, "audit"),
    egressNetwork,
    startRetries: 0,
    startTimeoutMs: 30000,
  });
  const reports = new Map<string, Buffer>();
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/agents/self/reports?") || req.headers.authorization !== "Bearer local-offline-report-token") {
      res.writeHead(403);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 ** 2) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", () => {
      const data = Buffer.concat(chunks);
      const id = `local-report-${reports.size + 1}`;
      reports.set(id, data);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ replayed: false, report: { id, sha256: hash(data) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as AddressInfo).port;
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const h = await sb.start(
    {
      agent: "local-gate",
      image: IMAGE,
      mounts: [wsMount("/work"), offlineBrowserExtMount()],
      cmd: [
        "pi",
        "--mode",
        "json",
        "--provider",
        "pomtree-offline-capture",
        "--model",
        "scripted",
        "--no-extensions",
        "--no-session",
        "--no-skills",
        "--no-context-files",
        "--extension",
        OFFLINE_BROWSER_EXT,
        "offline capture",
      ],
      env: {
        ...containerConfigTestEnv(),
        PTREE_BROWSER: "1",
        PTREE_BROWSER_MAX_STEPS: "8",
        PTREE_BROWSER_MAX_MS: "90000",
        PTREE_BROWSER_USER_AGENT: CONFIG_DEFAULTS["workflow.fetch.userAgent"], // the resolved identity pomtreed's browserEnv passes, at the registry default
        PTREE_TEST_CAPTURE_URL: ARTICLE,
        POMTREE_AGENT_ID: "local-gate",
        POMTREE_AGENT_GENERATION: "7",
        POMTREE_API: `http://host.docker.internal:${port}`,
        POMTREE_TOKEN: "local-offline-report-token",
      },
      egress: { allow: [], relay: [{ host: "host.docker.internal", port }], auditedPublic: { host: "local-host", generation: 7 } },
    },
    `article:${Date.now()}-${randomUUID()}`,
  );
  try {
    const result = await Promise.race([
      h.wait(),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(Error("article gate timed out")), 120000);
      }),
    ]);
    clearTimeout(timer);
    const wallMs = Date.now() - t0;
    let logs = "";
    for await (const part of h.output()) logs += part.chunk;
    const disk = new DiskEgressAudit({ root: join(root, "audit") });
    const rows = await disk.read(h.id, 0);
    // The real proxy's chained output, asserted directly: every row carries a chain value and re-chaining the rows reproduces them.
    assert.ok(rows.length > 0 && rows.length < 256, "rows fit one read page");
    for (const r of rows) assert.match(r.chain, AUDIT_CHAIN_RE);
    const bare = rows.map(({ chain: _chain, ...r }) => r);
    assert.deepEqual(
      sealAuditChain(h.id, bare).map((r) => r.chain),
      rows.map((r) => r.chain),
    );
    const authorities = [...new Set(rows.map((r) => `${r.authority} ${r.phase}/${r.outcome}`))].sort();
    console.log(`article-gate wallMs=${wallMs} audit=${JSON.stringify(authorities)}`);
    assert.equal(result.exitCode, 0, logs);
    const events = logs.split("\n").flatMap((line) => {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: Pi JSON event lines are untyped
        return [JSON.parse(line) as Record<string, any>];
      } catch {
        return [];
      }
    });
    const start = events.find((e) => e.type === "tool_execution_start" && e.toolName === "browser_capture");
    const end = events.find((e) => e.type === "tool_execution_end" && e.toolCallId === start?.toolCallId);
    assert.equal(end?.isError, false, JSON.stringify(authorities) + logs);
    const receipt = JSON.parse(end!.result.content[0].text);
    assert.equal(receipt.originalUrl, ARTICLE);
    for (const key of ["rawBodyReport", "domReport", "textReport", "navigationReport"])
      assert.equal(hash(reports.get(receipt[key].id)!), receipt[key].sha256, key);
    const text = reports.get(receipt.textReport.id)!;
    assert.ok(text.toString().includes(PHRASE), `text report lacks "${PHRASE}"`);
    const nav = JSON.parse(reports.get(receipt.navigationReport.id)!.toString());
    console.log(`article-gate extraction.region=${JSON.stringify(nav.extraction?.region)}`);
    const png = reports.get(nav.screenshotReport.id)!;
    assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "screenshot is a PNG");
    assert.equal(hash(png), nav.screenshotReport.sha256);
    console.log(`article-gate textBytes=${text.length} textSha256=${receipt.textReport.sha256} screenshotBytes=${png.length}`);

    for (const outcome of ["allowed", "connected", "complete"])
      assert.ok(
        rows.some((r) => r.authority === "www.rfc-editor.org:443" && r.outcome === outcome),
        `rfc-editor.org:443 ${outcome}`,
      );
    assert.ok(rows.every((r) => r.agent === "local-gate" && r.host === "local-host" && r.generation === 7));
    // No denial of any kind, and no authority outside the explicit list (this also excludes private, loopback and metadata ranges).
    for (const r of rows) {
      assert.ok(
        PAGE_AUTHORITIES.has(r.authority) || BROWSER_BACKGROUND.has(r.authority) || r.authority === `host.docker.internal:${port}`,
        `unexpected authority ${r.authority}`,
      );
      assert.notEqual(r.outcome, "denied", `denied ${r.authority}`);
    }
    // Worker never had a direct route: network-none, reachable only through the audited proxy.
    const hc = JSON.parse(execFileSync("docker", ["inspect", `pomtree-${h.id}`], { encoding: "utf8", timeout: 10000 }))[0].HostConfig;
    assert.equal(hc.NetworkMode, "none");
    assert.deepEqual(hc.CapDrop, ["ALL"]);

    // Vacuum path from a spool the real proxy wrote: stop the sandbox (the proxy is gone, the spool is marked closed), ingest the
    // whole spool page by page as pomtreed does (read with the journaled head, then ack), and vacuum it.
    await sb.kill(h.id);
    const all: EgressAuditRecord[] = [];
    for (;;) {
      const last = all.at(-1);
      const page = await disk.read(h.id, last?.sequence ?? 0, 256, last?.chain);
      if (page.length === 0) break;
      all.push(...page);
    }
    assert.ok(all.length >= rows.length, "the stopped spool holds at least the rows read while running");
    assert.deepEqual(
      all.slice(0, rows.length).map((r) => r.chain),
      rows.map((r) => r.chain),
      "rows read while running are a prefix of the final spool",
    );
    const tail = all.at(-1)!;
    await disk.ack(h.id, tail.sequence, tail.chain);
    const candidate = await disk.vacuumCandidate(h.id, 0, Date.now());
    assert.ok(candidate, "closed, fully acknowledged spool is a vacuum candidate");
    assert.equal(candidate.throughSequence, tail.sequence);
    assert.equal(candidate.chain, tail.chain);
    assert.equal(disk.vacuum(candidate), true);
    assert.deepEqual(await disk.discover(), [], "the vacuumed spool is no longer discovered");
  } finally {
    await sb.kill(h.id).catch(() => {});
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
