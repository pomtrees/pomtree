// OPS-2 and an OPS-4 transport check: real pomtreed/containers/Pi, fake model, and a local HTTP OTLP capture receiver.
// The receiver checks the wire and lifecycle spans; it is not an OpenTelemetry Collector interoperability test.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelScript } from "@pomtree/testing";
import { freePort, showAgent } from "./cli-crash.ts";
import { holdUntilReleased, release } from "./cli-hold.ts";
import { type AgentJson, bash, cliScenarioSkip, MODEL, PROVIDER, startStack } from "./cli-scenarios-harness.ts";

test("cli observe OPS-2/4: two live agents remain diagnosable after exit, traces redact, and OTLP lifecycle spans reach HTTP", {
  skip: cliScenarioSkip(),
  timeout: 120_000,
}, async (t) => {
  const canary = "sk-ops2-synthetic-canary-0123456789";
  const posts: { method: string; url: string; type: string; body: string }[] = [];
  const receiver = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (part: string) => (body += part));
    req.on("end", () => {
      posts.push({ method: req.method ?? "", url: req.url ?? "", type: req.headers["content-type"] ?? "", body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(0, "127.0.0.1", resolve);
  });
  const port = (receiver.address() as { port: number }).port;
  const script: ModelScript = {
    name: "operator-observe",
    rules: [
      {
        id: "slow-failed-tool",
        when: { toolResults: 0 },
        reply: { kind: "tool_calls", calls: [bash(holdUntilReleased(`printf '%s\\n' '${canary}'; false`))], usage: { input: 100, output: 10 } },
      },
      {
        id: "result",
        when: { toolResults: 1 },
        reply: { kind: "tool_calls", calls: [bash("pomtree result --summary 'operator observation complete'")], usage: { input: 100, output: 10 } },
      },
      { id: "done", when: { toolResults: 2 }, reply: { kind: "text", text: "STUB-DONE", usage: { input: 100, output: 10 } } },
    ],
  };
  const outDir = mkdtempSync(join(tmpdir(), "ops-observe-"));
  let stack: Awaited<ReturnType<typeof startStack>> | undefined;
  try {
    stack = await startStack({ script, set: { "model.proxy.port": String(await freePort()), "otlp.endpoint": `http://127.0.0.1:${port}` } });
    const s = stack;
    const agents: AgentJson[] = [];
    for (const name of ["observe-a", "observe-b"]) {
      const spawned = await s.pomtree([
        "spawn",
        "--task",
        "run the scripted observation",
        "--name",
        name,
        "--budget",
        "300000",
        "--model",
        `${PROVIDER}/${MODEL}`,
      ]);
      assert.equal(spawned.code, 0, spawned.err);
      agents.push(spawned.json<AgentJson>());
    }
    await s.until(
      "both agents inside the slow tool",
      async () => {
        const entries = await Promise.all(agents.map((a) => s.kinds(a.id, "tool_call")));
        return entries.every((xs) => xs.length > 0);
      },
      30_000,
    );

    const checkViews = async (phase: string) => {
      const ps = await s.pomtree(["ps"]);
      assert.equal(ps.code, 0, ps.err);
      const listed = ps.json<AgentJson[]>();
      for (const a of agents) {
        const record = listed.find((r) => r.id === a.id);
        assert.ok(record, `${phase}: ps contains ${a.name}`);
        assert.ok(phase === "running" ? record.state === "running" : ["exited", "reaped"].includes(record.state), `${phase}: ${a.name} is ${record.state}`);
      }
      for (const args of [["tree"], ["top", "--once"]]) {
        const view = await s.pomtree(args);
        assert.equal(view.code, 0, view.err);
        assert.ok(
          agents.every((a) => view.out.includes(a.name)),
          `${phase}: ${args.join(" ")} contains both agents`,
        );
      }
      const top = (await s.pomtree(["top", "--once"])).json<{ fullId: string; model: string; host: string }[]>();
      for (const a of agents) {
        const row = top.find((r) => r.fullId === a.id);
        assert.ok(row, `${phase}: top identifies ${a.name}`);
        assert.ok(row.model.includes(MODEL), `${phase}: top identifies the model`);
        assert.ok(row.host.length > 0, `${phase}: top identifies the host`);
        const shown = await s.pomtree(["show", a.id]);
        assert.equal(shown.code, 0, shown.err);
        const record = shown.json<{ agent: AgentJson }>().agent;
        assert.equal(record.parent, a.parent);
        assert.equal(record.name, a.name);
      }
      const spend = await s.pomtree(["spend"]);
      assert.equal(spend.code, 0, spend.err);
      assert.ok(Number.isSafeInteger(spend.json<{ totalSpendMicros: number }>().totalSpendMicros));
      const escalations = await s.pomtree(["escalations", "ls"]);
      assert.equal(escalations.code, 0, escalations.err);
      assert.deepEqual(escalations.json(), []);
    };
    await checkViews("running");
    await release(await Promise.all(agents.map(async (a) => `pomtree-${(await showAgent(s, a.id)).sandbox}`)));
    const followed = agents.map((a) => s.pomtree(["logs", a.id, "-f"], 45_000));
    for (const a of agents) {
      const ended = await s.waitExited(a.id, 45_000);
      assert.equal(ended.code, 0, ended.err);
      assert.equal(ended.json<{ record: AgentJson }>().record.exit, "succeeded");
    }
    for (const logs of await Promise.all(followed)) {
      assert.equal(logs.code, 0, logs.err);
      assert.match(logs.out, /tool_result/);
      assert.match(logs.out, /exited/);
    }
    await checkViews("ended");
    for (const a of agents) {
      assert.ok(
        (await s.kinds(a.id, "tool_result")).some((e) => e.payload.ok === false),
        "failed tool is recorded independently of reported success",
      );
      const output = join(outDir, `${a.name}.md`);
      const trace = await s.pomtree(["trace", a.id, "--children", "--out", output]);
      assert.equal(trace.code, 0, trace.err);
      const text = readFileSync(output, "utf8");
      assert.match(text, /redacted: [1-9]\d* values/);
      assert.ok(!text.includes(canary), "redacted trace excludes the synthetic canary");
      assert.match(text, /\*\*ERROR\*\*/);
    }
    assert.deepEqual(s.stub.unmatched, []);
    // Small runs are below the export batch threshold. Graceful daemon shutdown must flush their spans.
    await s.close();
    stack = undefined;
    const spans = posts.flatMap((p) => {
      assert.equal(p.method, "POST");
      assert.equal(p.url, "/v1/traces");
      assert.equal(p.type, "application/json");
      const body = JSON.parse(p.body) as { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] };
      return body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((scope) => scope.spans));
    });
    for (const a of agents)
      assert.ok(
        spans.some((span) => span.name === `invoke_agent ${a.id}`),
        "HTTP receiver sees each agent lifecycle span",
      );
    assert.ok(
      posts.every((p) => !p.body.includes(canary)),
      "OTLP excludes tool content by default",
    );
    t.diagnostic(`HTTP capture: ${posts.length} POST(s) to /v1/traces; both agent lifecycle spans present after graceful shutdown`);
  } finally {
    try {
      await stack?.close();
    } finally {
      receiver.closeAllConnections();
      try {
        await new Promise<void>((resolve, reject) => receiver.close((e) => (e ? reject(e) : resolve())));
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    }
  }
});
