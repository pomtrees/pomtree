import assert from "node:assert/strict";
import { test } from "node:test";
import { SANDBOX_TAGS, readOwnerStamp } from "@pomtree/core";
import { pathToFileURL } from "node:url";
import type { SandboxListing } from "@pomtree/core";
import * as broken from "./sandbox-loopback-broken/wire.mts";
import type { LoopbackRecord } from "./sandbox-loopback-broken/wire.mts";

// The example is imported by path: it lives outside this package's project and resolves @pomtree/core only for types.
const example = (await import(pathToFileURL(new URL("../../../examples/sandbox-loopback/wire.mts", import.meta.url).pathname).href)) as {
  toListing(r: LoopbackRecord): SandboxListing;
};

// The loopback example reads the owner stamp back inline because it must stay import-free; this test holds both copies of its
// toListing (the example and the seeded broken copy) to core's readOwnerStamp over the same values, so a change to core's rule
// that the copies do not follow fails here.

const HOSTS = ["host-a", "", "x", "host\nb", "host\u0000", "host\u007f", "host\u001f", "tab\there", "ü-host", "h&=".repeat(50), " "];
const GENERATIONS = [0, 1, 5, 2 ** 53 - 1, 2 ** 53, 1e21, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

function record(host: string, generation: number): LoopbackRecord {
  return { name: "n", agent: "a", image: "i", state: "running", exitCode: null, labels: {}, host, generation, fingerprint: "f" };
}

// What core reads from the tags a create body stamps for this host and generation (the generation is written as its decimal string).
const coreReads = (host: string, generation: number) => readOwnerStamp({ [SANDBOX_TAGS.host]: host, [SANDBOX_TAGS.generation]: String(generation) });

for (const [name, wire] of [
  ["example", example],
  ["seeded broken copy", broken],
] as const) {
  test(`loopback stamp mirror: the ${name} toListing reads host and generation as core's readOwnerStamp does`, () => {
    for (const host of HOSTS) {
      for (const generation of GENERATIONS) {
        const l = wire.toListing(record(host, generation));
        const want = coreReads(host, generation);
        assert.equal(
          l.host,
          want.host,
          `host ${JSON.stringify(host)}: the ${name} wire.mts must read it as core does (${String(want.host)}); update its inline rule`,
        );
        assert.equal(
          l.generation,
          want.generation,
          `generation ${String(generation)}: the ${name} wire.mts must read it as core does (${String(want.generation)}); update its inline rule`,
        );
      }
    }
  });
}
