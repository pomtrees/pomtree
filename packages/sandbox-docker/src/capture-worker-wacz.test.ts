// Docker-gated, offline: the model-free capture worker (node capture-worker.ts, no Pi) captures a local fixture site through the real
// audited-public sidecar proxy. The fake hosts origin-a.test (302) and origin-b.test (HTML plus a script that renders the article text)
// are served inside a derived copy of the sidecar image by a preload that redirects only name resolution and the final dial
// (agent-image test-fixtures capture-proxy-seam.ts); admission, audit and forwarding are the real proxy.ts. The WACZ is read back from a
// fake daemon report endpoint and checked by the pure validator.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { parseWarcGz, sha256Hex } from "../../agent-image/src/warc.ts";
import type { CaptureWorkerReceipt } from "../../agent-image/src/capture-types.ts";
import { readZip } from "../../agent-image/src/zip.ts";
import { verifyWacz } from "../../agent-image/src/wacz.ts";
import { HOST_A, HOST_B, PAGE_PATH, PLACEHOLDER_PHRASE, RENDERED_PHRASE, SITE_PORT, START_PATH } from "../../agent-image/test-fixtures/capture-site.ts";
import { DiskEgressAudit } from "./audit.ts";
import { DockerSandbox } from "./docker.ts";
import { IMAGE, engineGate, gateEngine, gateExecFileSync, gateSandboxDeps, gateSpawn, testEgressNetwork } from "./docker-gate.ts";
import { captureWorkerMounts, containerConfigTestEnv, workerReadyMount, stubMounts, wsMount } from "./test-mounts.ts";

// engineGate, not gate(): gate() proves the image carries the committed adapter/image sources and skips on any uncommitted file. This
// run takes the worker sources from bind mounts of the worktree, so the image's own copies of them are not what it claims anything about.
const skip = engineGate() || (process.getuid?.() === 0 && "audited-public requires unprivileged host uid");
const egressNetwork = testEgressNetwork();

const TOKEN = "local-offline-report-token";
const USER_AGENT = "PomtreeCaptureTest/1.0 (+mailto:operator@example.test)";
const START_URL = `http://${HOST_A}:${SITE_PORT}${START_PATH}`;
const PAGE_URL = `http://${HOST_B}:${SITE_PORT}${PAGE_PATH}`;
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");

// A derived sidecar image: the existing image plus the fixture site and the preload, nothing pulled, nothing else changed.
function buildProxyImage(ctx: string): string {
  const fixtures = dirname(fileURLToPath(new URL("../../agent-image/test-fixtures/capture-site.ts", import.meta.url)));
  for (const f of ["capture-site.ts", "capture-proxy-seam.ts"]) copyFileSync(join(fixtures, f), join(ctx, f));
  writeFileSync(
    join(ctx, "Dockerfile"),
    `FROM ${IMAGE}\nCOPY --chmod=0644 capture-site.ts capture-proxy-seam.ts /opt/pomtree/egress/\nENV NODE_OPTIONS=--import=/opt/pomtree/egress/capture-proxy-seam.ts\n`,
  );
  const tag = `pomtree-test-capture-proxy:${process.pid}`;
  gateExecFileSync(["build", "-q", "-t", tag, ctx], { stdio: "pipe", timeout: 120000 });
  after(() => {
    try {
      gateExecFileSync(["rmi", tag], { stdio: "ignore", timeout: 20000 });
    } catch {
      /* already gone */
    }
  });
  return gateExecFileSync(["image", "inspect", "--format", "{{.Id}}", tag], { timeout: 10000 }).trim();
}

// Every command line in the container's pid namespace, sampled while it runs. `<engine> exec` ends once the container does.
function sampleProcesses(name: string, seen: Set<string>): () => Promise<void> {
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      await new Promise<void>((resolve) => {
        const p = gateSpawn(["exec", name, "sh", "-c", 'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline 2>/dev/null; echo; done']);
        let out = "";
        p.stdout.on("data", (c: Buffer) => {
          out += c;
        });
        p.once("error", () => resolve());
        p.once("close", () => {
          for (const l of out.split("\n")) if (l.trim()) seen.add(l.trim());
          resolve();
        });
      });
      await new Promise((r) => setTimeout(r, 150));
    }
  })();
  return async () => {
    stop = true;
    await loop;
  };
}

test("model-free capture worker records a cross-host redirect and script-rendered text into a valid WACZ", { skip, timeout: 170000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-docker-capture-")));
  const work = join(root, "work");
  mkdirSync(work, { mode: 0o755 });
  mkdirSync(join(root, "ctx"));
  chmodSync(root, 0o755);
  const proxyImage = buildProxyImage(join(root, "ctx"));
  const sb = new DockerSandbox({
    ...gateSandboxDeps(),
    mounts: stubMounts(() => work),
    egressProxyImage: proxyImage,
    egressAuditRoot: join(root, "audit"),
    egressNetwork,
    startRetries: 0,
    startTimeoutMs: 30000,
  });
  // Fake daemon: stores published report bytes by name and answers like the real route.
  // It deliberately models the S2 report-prefix scope (exact `capture/<job>/<role>` names, any media type incl. application/zip), not today's pomtreed, which slugifies names and refuses zip.
  const reports = new Map<string, { name: string; data: Buffer }>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://daemon.invalid");
    if (req.method !== "POST" || url.pathname !== "/v1/agents/self/reports" || req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(403);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 ** 2) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", () => {
      const data = Buffer.concat(chunks);
      const id = `local-report-${reports.size + 1}`;
      reports.set(id, { name: url.searchParams.get("name") ?? "", data });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ replayed: false, report: { id, sha256: hash(data) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as AddressInfo).port;
  const job = { job: "job-wacz-1", mode: "browser", url: START_URL, maxBytes: 262144, deadlineMs: 60000, userAgent: USER_AGENT };
  const h = await sb.start(
    {
      agent: "capture-gate",
      image: IMAGE,
      mounts: [wsMount("/work"), ...captureWorkerMounts(), workerReadyMount()],
      cmd: ["/usr/local/bin/node", "/opt/pomtree/capture-worker.ts"],
      env: {
        ...containerConfigTestEnv(),
        PTREE_BROWSER: "1",
        PTREE_BROWSER_MAX_STEPS: "8",
        PTREE_BROWSER_MAX_MS: "90000",
        PTREE_CAPTURE_JOB: JSON.stringify(job),
        POMTREE_AGENT_ID: "capture-gate",
        POMTREE_AGENT_GENERATION: "7",
        POMTREE_API: `http://host.docker.internal:${port}`,
        POMTREE_TOKEN: TOKEN,
      },
      egress: { allow: [], relay: [{ host: "host.docker.internal", port }], auditedPublic: { host: "local-host", generation: 7 } },
    },
    `capture:${Date.now()}-${randomUUID()}`,
  );
  const seen = new Set<string>();
  const stopSampling = sampleProcesses(`pomtree-${h.id}`, seen);
  try {
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      h.wait(),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(Error("capture gate timed out")), 150000);
      }),
    ]);
    clearTimeout(timer);
    await stopSampling();
    let logs = "";
    for await (const part of h.output()) logs += part.chunk;
    assert.equal(result.exitCode, 0, logs);

    // The receipt: the one stdout line that parses as a CaptureWorkerReceipt.
    const receipts = logs.split("\n").flatMap((line) => {
      try {
        const v = JSON.parse(line) as CaptureWorkerReceipt;
        return Array.isArray(v.artifacts) ? [v] : [];
      } catch {
        return [];
      }
    });
    assert.equal(receipts.length, 1, logs);
    const receipt = receipts[0]!;
    assert.equal(receipt.job, job.job);
    assert.equal(receipt.captureMethod, "cdp");
    assert.equal(receipt.fetch.requestedUrl, START_URL);
    assert.equal(receipt.fetch.finalUrl, PAGE_URL);
    assert.equal(receipt.fetch.status, 200);
    assert.equal(receipt.fetch.userAgent.includes(USER_AGENT), true, receipt.fetch.userAgent);
    // redirects lists the redirecting hops only; the final hop is finalUrl/status above, and the WARC check below records both.
    assert.deepEqual(receipt.fetch.redirects, [{ url: START_URL, status: 302 }]);

    // Every artifact: published under capture/<job>/<role>, with the receipt's size and digest equal to the stored bytes.
    const roles = receipt.artifacts.map((a) => a.role).sort();
    assert.deepEqual(roles, ["dom", "navigation", "raw", "screenshot", "text", "wacz"]);
    const bytesOf = (role: string): Buffer => {
      const a = receipt.artifacts.find((x) => x.role === role)!;
      const stored = reports.get(a.report.id);
      assert.ok(stored, `${role} report ${a.report.id} was published`);
      assert.equal(stored.name, `capture/${job.job}/${role}`);
      assert.equal(stored.data.length, a.sizeBytes, `${role} size`);
      assert.equal(hash(stored.data), a.sha256, `${role} sha256`);
      return stored.data;
    };
    for (const role of roles) bytesOf(role);
    assert.equal(reports.size, roles.length, "nothing is published beyond the receipt's artifacts");

    // The WACZ passes the pure validator, and its WARC holds both hops with the operator's UA on the requests.
    const wacz = bytesOf("wacz");
    const verdict = verifyWacz(wacz);
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
    const files = new Map(readZip(wacz).map((e) => [e.name, e.data]));
    const warcName = [...files.keys()].find((n) => /^archive\/.*\.warc\.gz$/.test(n));
    assert.ok(warcName, `a WARC member in ${[...files.keys()].join(", ")}`);
    const records = parseWarcGz(files.get(warcName)!);
    const typeOf = (r: (typeof records)[number]) => r.headers.get("warc-type");
    const uriOf = (r: (typeof records)[number]) => r.headers.get("warc-target-uri");
    const responses = records.filter((r) => typeOf(r) === "response");
    const requests = records.filter((r) => typeOf(r) === "request");
    const statusLine = (r: (typeof records)[number]) => text(r.block).split("\r\n")[0];
    const hopA = responses.find((r) => uriOf(r) === START_URL);
    const hopB = responses.find((r) => uriOf(r) === PAGE_URL);
    assert.ok(hopA && hopB, `response records for both hops, got ${responses.map(uriOf).join(", ")}`);
    assert.match(statusLine(hopA) ?? "", /^HTTP\/1\.[01] 302\b/);
    assert.match(statusLine(hopB) ?? "", /^HTTP\/1\.[01] 200\b/);
    assert.ok(
      responses.some((r) => uriOf(r) === `http://${HOST_B}:${SITE_PORT}/app.js`),
      "the script subresource is recorded",
    );
    for (const url of [START_URL, PAGE_URL]) {
      const req = requests.find((r) => uriOf(r) === url);
      assert.ok(req, `a request record for ${url}`);
      assert.ok(text(req.block).toLowerCase().includes(USER_AGENT.toLowerCase()), `operator UA on the request for ${url}`);
    }
    assert.ok(
      text(records.find((r) => typeOf(r) === "warcinfo")?.block ?? new Uint8Array()).includes("capture-method: cdp"),
      "warcinfo record names the CDP method",
    );

    // Rendered text: in pages.jsonl and the text artifact, not only the pre-script placeholder.
    const pages = text(files.get("pages/pages.jsonl") ?? new Uint8Array());
    assert.ok(pages.includes(RENDERED_PHRASE), "pages.jsonl text holds the script-rendered phrase");
    const textArtifact = text(bytesOf("text"));
    assert.ok(textArtifact.includes(RENDERED_PHRASE), "text artifact holds the script-rendered phrase");
    assert.ok(!textArtifact.includes(PLACEHOLDER_PHRASE), "the pre-script placeholder was replaced");
    assert.ok(text(bytesOf("dom")).includes(RENDERED_PHRASE), "rendered DOM holds the phrase");
    assert.ok(!text(bytesOf("raw")).includes(RENDERED_PHRASE) && text(bytesOf("raw")).includes(PLACEHOLDER_PHRASE), "raw body is the pre-script HTML");
    assert.ok(
      bytesOf("screenshot")
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      "screenshot is a PNG",
    );
    // gunzip is exercised too: every WARC member must be a standalone gzip member (parseWarcGz walks them; this is the independent check).
    assert.ok(gunzipSync(files.get(warcName)!).length > 0);
    assert.equal(sha256Hex(files.get(warcName)!).length, 64);

    // Both hops crossed the real proxy: the audit spool holds an allowed row for each fake authority.
    const rows = await new DiskEgressAudit({ root: join(root, "audit") }).read(h.id, 0);
    for (const authority of [`${HOST_A}:${SITE_PORT}`, `${HOST_B}:${SITE_PORT}`])
      assert.ok(
        rows.some((r) => r.authority === authority && r.outcome === "allowed"),
        `audit row allowed for ${authority}`,
      );
    assert.ok(!rows.some((r) => r.outcome === "denied" && r.authority.endsWith(`.test:${SITE_PORT}`)), "no fixture authority was denied");

    // No model: the container command is the capture worker and no Pi (or browser-run, which only launches Pi) process ever existed.
    // The sample is every command line in the container's pid namespace, polled every ~150 ms during the run; it must have caught the
    // capture worker and Chromium, so a miss of Pi cannot be a blind sampler.
    const inspected = JSON.parse(gateExecFileSync(["inspect", `pomtree-${h.id}`], { timeout: 10000 }))[0];
    assert.deepEqual(inspected.Config.Cmd, ["/usr/local/bin/node", "/opt/pomtree/capture-worker.ts"]);
    const lines = [...seen];
    assert.ok(
      lines.some((l) => l.includes("/opt/pomtree/capture-worker.ts")),
      `sampler saw the capture worker in ${lines.length} command lines`,
    );
    assert.ok(
      lines.some((l) => /chrom/i.test(l)),
      `sampler saw Chromium in ${JSON.stringify(lines).slice(0, 1500)}`,
    );
    const pi = lines.filter((l) => /pi-coding-agent|\/bin\/pi(\s|$)|browser-run\.ts|(^|\s)pi(\s|$)/.test(l));
    assert.deepEqual(pi, [], "no Pi process in the capture container");
  } finally {
    await stopSampling();
    await sb.kill(h.id, `test-kill:${h.id}`).catch(() => {});
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
