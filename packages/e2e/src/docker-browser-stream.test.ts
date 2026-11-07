import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelScript } from "@pomtree/testing";
import { WS_OPCODE, browserWsConnect, waitForMessage } from "./browser-stream-ws.ts";
import { freePort } from "./cli-crash.ts";
import { MODEL_FLAG, TIMEOUT, withStack } from "./cli-operator-kit.ts";
import { type AgentJson, cliScenarioSkip } from "./cli-scenarios-harness.ts";

// Docker-gated, no live model: a browser worker's container runs the real Chromium (started by the in-image worker before Pi, with its
// sandbox on) while its scripted model reply streams slowly, so the browser outlives the test. The operator then opens the daemon's
// read-only view, GET /v1/agents/<id>/browser, as a websocket, and the test checks the live-view contract end to end: the daemon reaches
// Chromium's loopback DevTools port through `docker exec` only, so one JPEG frame arrives, the status says "live", and the container
// publishes no port. The skip reasons are cliScenarioSkip's (Docker opt-in, image named, present, built from this checkout) plus a
// non-root host, which the audited-public egress the browser template uses requires.
//
// Run: AGENT_IMAGE_TAG=pomtree/agent:smoke-<sha> node packages/agent-image/scripts/build.ts, then
//   PTREE_DOCKER_TESTS=1 PTREE_E2E_IMAGE=pomtree/agent:smoke-<sha> node --test packages/e2e/src/docker-browser-stream.test.ts
// TODO(browser-click-e2e): this test asserts a frame, the live status and no published port, and sends no input. Trigger: after the browser input steps (browser-input-relay); send a click, assert the page changed and record a row in docs/validation.md. It needs Docker and the maintainer's go-ahead.
// TODO(docker-teardown-unverified): after a run, container, network and volume listings were empty, but teardown was not checked beyond that (orphan processes, leftover sockets, temp directories). Trigger: the next Docker-gated run, or a stray container or volume seen after one.
const skip = (): string | false => cliScenarioSkip() || (process.getuid?.() === 0 ? "audited-public egress requires an unprivileged host uid" : false);

const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 20_000 }).trim();

// Every model request is answered with a slow 120 s stream (240 chunks, 500 ms apart): Pi, and so Chromium, stays up until the test kills the agent.
const script: ModelScript = {
  name: "browser-stream-hold",
  rules: [{ id: "hold", when: {}, reply: { kind: "fault", fault: { type: "slow_stream", chunkDelayMs: 500, chunks: 240 } } }],
};
const templates = {
  "scn-browser": {
    provider: "deepseek",
    model: "deepseek-flash",
    systemPrompt: "Scripted browser worker. [[stub:browser]]",
    egress: { kind: "audited-public" },
    browser: { maxSteps: 12, maxMs: 300_000, profile: "interactive" },
  },
};

test("docker browser stream: the operator websocket delivers a live JPEG frame and the container publishes no port", {
  skip: skip(),
  timeout: TIMEOUT,
}, async () => {
  const uiPort = await freePort();
  await withStack({ script, templates, set: { "ui.listen": `127.0.0.1:${uiPort}` } }, async (s) => {
    const spawned = await s.pomtree([
      "spawn",
      "--task",
      "hold the browser open",
      "--name",
      "viewed",
      "--budget",
      "300000",
      "--model",
      MODEL_FLAG,
      "--template",
      "scn-browser",
    ]);
    assert.equal(spawned.code, 0, `spawn viewed: exit ${spawned.code}: ${spawned.err} stdout: ${spawned.out}`);
    const agent = spawned.json<AgentJson>();
    await s.until(
      "the agent running",
      async () => (await s.pomtree(["ps"])).json<AgentJson[]>().some((a) => a.id === agent.id && a.state === "running"),
      90_000,
    );

    const token = readFileSync(join(s.stateDir, "operator.token"), "utf8").trim();
    const origin = `http://127.0.0.1:${uiPort}`;
    // The browser route answers 409 while the sandbox is not up yet, so a refused upgrade is retried until the deadline.
    let ws = await browserWsConnect(uiPort, `/v1/agents/${agent.id}/browser`, { authorization: `Bearer ${token}`, origin });
    for (const end = Date.now() + 60_000; !ws.head.startsWith("HTTP/1.1 101") && Date.now() < end; ) {
      await new Promise((r) => setTimeout(r, 1000));
      ws = await browserWsConnect(uiPort, `/v1/agents/${agent.id}/browser`, { authorization: `Bearer ${token}`, origin });
    }
    assert.match(ws.head, /^HTTP\/1\.1 101/, `browser route refused the upgrade: ${ws.head}`);
    try {
      // Chromium starts before Pi, and the daemon retries discovery every 2 s, so the first frame can lag the connect by a while.
      const frame = await waitForMessage(
        ws,
        "binary JPEG frame (FF D8 FF)",
        (m) => m.opcode === WS_OPCODE.binary && m.payload.subarray(0, 3).toString("hex") === "ffd8ff",
        60_000,
      );
      assert.ok(frame.payload.length > 3 && frame.payload.length <= 2 * 1024 * 1024, `JPEG frame size ${frame.payload.length} is outside the 2 MiB bound`);
      const live = await waitForMessage(
        ws,
        'status message with state "live"',
        (m) =>
          m.opcode === WS_OPCODE.text &&
          (JSON.parse(m.payload.toString()) as { type?: string; state?: string }).type === "status" &&
          (JSON.parse(m.payload.toString()) as { state?: string }).state === "live",
        30_000,
      );
      assert.equal(JSON.parse(live.payload.toString()).state, "live");
      // Only status/closed text and JPEG binary messages ever leave the relay (the contract); nothing else.
      for (const m of ws.messages) {
        if (m.opcode === WS_OPCODE.binary) assert.equal(m.payload.subarray(0, 3).toString("hex"), "ffd8ff", "a binary message that is not a JPEG");
        else if (m.opcode === WS_OPCODE.text) assert.match((JSON.parse(m.payload.toString()) as { type: string }).type, /^(status|closed)$/);
      }
    } finally {
      ws.close();
      await ws.closed;
    }

    // Nothing is published: neither `docker port` nor the network settings list a port, and the worker has no network.
    const names = docker(["ps", "--filter", `label=pomtree.agent=${agent.id}`, "--format", "{{.Names}}"])
      .split("\n")
      .filter(Boolean);
    assert.equal(names.length, 1, `expected one container for agent ${agent.id}, found [${names.join(", ")}]; the agent may have exited early`);
    const name = names[0]!;
    console.log(
      `FRAMES binary=${ws.messages.filter((m) => m.opcode === WS_OPCODE.binary).length} docker-port=${JSON.stringify(docker(["port", name]))} container=${name}`,
    );
    console.log(
      `LIMITS ${docker(["inspect", "--format", "{{.Name}} mem={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} pids={{.HostConfig.PidsLimit}}", name])}`,
    );
    assert.equal(docker(["port", name]), "", `docker port ${name} listed a published port`);
    assert.equal(docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", name]), "{}", "the container's network settings publish a port");
    assert.equal(docker(["inspect", "--format", "{{json .HostConfig.PortBindings}}", name]), "{}", "the container's host config binds a port");
    assert.equal(docker(["inspect", "--format", "{{.HostConfig.NetworkMode}}", name]), "none", "the browser worker should run with --network none");
  });
});
