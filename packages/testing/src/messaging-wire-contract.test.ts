import assert from "node:assert/strict";
import { test } from "node:test";
import { MESSAGING_WIRE_CLAUSES, checkAdapterVersionHeader, runMessagingWireClause } from "./messaging-wire-contract.ts";
import type { MessagingWireDaemon } from "./messaging-wire-contract.ts";
import { brokenBootDaemon, stubWireAdapter } from "./messaging-wire-stub.ts";

// The suite machinery without pomtreed: the real-daemon runs live in packages/e2e (messaging-wire-contract.test.ts).

// A daemon that cannot start; only its boot check is scripted, with pomtreed's refusal wording.
const scripted: MessagingWireDaemon = {
  start: async () => {
    throw new Error("no daemon in this test");
  },
  bootError: ({ channels, senders }) =>
    senders.some((s) => !/^[^:\s]+:\S/.test(s))
      ? "pomtreed: refusing to start: POMTREED_MESSAGING_SENDERS entry must be of the form channel:sender"
      : senders.length === 0
        ? `pomtreed: refusing to start: POMTREED_MESSAGING_SENDERS is unset while chat channel(s) ${channels.join(", ")} are enabled`
        : null,
};

test("every clause has a title and a fix, and the ids are unique", () => {
  const ids = MESSAGING_WIRE_CLAUSES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 8);
  for (const c of MESSAGING_WIRE_CLAUSES) assert.ok(c.title && c.fix, c.id);
});

test("the stub passes the adapter half of version-handshake and the stub broken on it fails", async () => {
  await checkAdapterVersionHeader(stubWireAdapter("stub"));
  await assert.rejects(checkAdapterVersionHeader(stubWireAdapter("stub", "version-handshake")), /another messaging API version must be refused/);
});

// A stub whose every refusal carries the same fixed text, so the two texts of a real adapter are swapped on one half.
const alwaysRefusing = (text: string) => {
  const base = stubWireAdapter("stub");
  return {
    ...base,
    connect: (baseUrl: string, token: string) => {
      const c = base.connect(baseUrl, token);
      return {
        ...c,
        outbox: async (from: number) => {
          try {
            return await c.outbox(from);
          } catch {
            throw new Error(text);
          }
        },
      };
    },
  };
};

test("the version check fails an adapter whose mismatch refusal does not name the received version", async () => {
  const swapped = alwaysRefusing("response has no x-pomtree-messaging-api header; point POMTREED_URL at a pomtreed that speaks it");
  await assert.rejects(checkAdapterVersionHeader(swapped), /must name the received version 2, got: response has no/);
});

test("the version check fails an adapter whose missing-header refusal does not name the header", async () => {
  const swapped = alwaysRefusing('messaging API "2" is not the 1 this adapter speaks');
  await assert.rejects(checkAdapterVersionHeader(swapped), /must name x-pomtree-messaging-api, got: messaging API "2"/);
});

test("sender-allowlist-boot passes against a daemon that refuses like pomtreed and fails against one that always boots", async () => {
  await runMessagingWireClause("sender-allowlist-boot", stubWireAdapter("stub"), scripted);
  await assert.rejects(runMessagingWireClause("sender-allowlist-boot", stubWireAdapter("stub"), brokenBootDaemon(scripted)), (e: Error) => {
    assert.match(e.message, /^messaging wire contract \[sender-allowlist-boot\] violated by stub: /);
    assert.match(e.message, / Fix: .+/);
    assert.ok(e.cause instanceof Error, "the inner assertion is kept as cause");
    return true;
  });
});

test("a failing clause names the adapter, the cause and the fix; a daemon that cannot start is a clause failure too", async () => {
  await assert.rejects(runMessagingWireClause("host-token-scope", stubWireAdapter("stub"), scripted), (e: Error) => {
    assert.match(e.message, /^messaging wire contract \[host-token-scope\] violated by stub: no daemon in this test\. Fix: throw on any status/);
    return true;
  });
});
