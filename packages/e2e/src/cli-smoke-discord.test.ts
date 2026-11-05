import assert from "node:assert/strict";
import type { Server } from "node:http";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { listenHost, issueToken } from "@pomtree/pomtreed";
import { pomtreedClient } from "../../messaging-discord/src/client.ts";
import { renderHostBody } from "../../messaging-discord/src/render.ts";
import type { Rig } from "./harness.ts";
import { rig, SECRET, until } from "./harness.ts";

// The generic messaging wire proof (outbox, answer/replay, status, spawn refusal, dead letters, scope/channel/garbage refusals, host-read
// status codes) is messaging-wire-contract.test.ts. This file keeps only the Discord renderer round trip: the REAL messaging-discord
// `pomtreedClient` and `renderHostBody` reading the REAL pomtreed host bodies over a real host TCP listener, so a body-shape drift renders
// "no agents" / "undefined" and fails here. Offline and Docker-free.

const hostTok = (channel: string) => issueToken(SECRET, { scope: "host", channel });
const discord = { messagingChannels: ["discord"], escalationChannels: ["discord"] };

async function withHost(fn: (r: Rig, base: string, held: AgentRecord) => Promise<void>): Promise<void> {
  let release!: () => void;
  const hold = new Promise<void>((res) => (release = res));
  const r = rig({ play: () => ({ hold, result: { status: "succeeded", result: null } }), deps: discord });
  let server: Server | undefined;
  try {
    const a = await r.daemon.spawn((await r.daemon.root()).id, { name: "w", task: "t", idempotencyKey: "w" });
    await until(async () => (await r.daemon.get(a.id))?.state === "running", "agent running");
    const l = await listenHost(r.daemon, "127.0.0.1", 0);
    server = l.server;
    await fn(r, `http://127.0.0.1:${l.port}`, a);
  } finally {
    server?.close();
    server?.closeAllConnections();
    release();
    await r.orchestrator.idle();
    r.store.close();
  }
}

test("real discord renderHostBody reads pomtreed's real host bodies: ps, budget, report", async () => {
  await withHost(async (_r, base, a) => {
    const client = pomtreedClient(base, hostTok("discord"));
    const read = await client.hostRead("/agents", "u1");
    assert.equal(read.status, 200);
    const ps = renderHostBody("ps", read.body);
    assert.ok(ps.includes(a.id) && ps.includes("running"), ps);
    const budget = await client.hostRead(`/agents/${a.id}/budget`, "u1");
    assert.equal(budget.status, 200);
    assert.ok(renderHostBody("budget", budget.body).startsWith(`${a.id}: spent $`), renderHostBody("budget", budget.body));
    assert.ok(!/undefined|NaN/.test(renderHostBody("budget", budget.body)));
    const rep = await client.hostRead(`/agents/${a.id}/report`, "u1");
    assert.equal(rep.status, 200);
    assert.ok(renderHostBody("report", rep.body).startsWith(`${a.id} running`), renderHostBody("report", rep.body));
  });
});
