// The Docker-free parts of the CLI stack harness: the failure dump's errorLines and the Pi catalog fixture the stack pins.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { POMTREED_KINDS } from "@pomtree/core";
import { openPiCatalog } from "@pomtree/pomtreed";
import { CATALOG_COST, errorLines, type JournalEvent, MODEL, PROVIDER, writeCatalogFixture } from "./cli-scenarios-harness.ts";

// Read by pomtreed's own loader with no `pi` on PATH (the hosted runner's case) and a home whose models-store.json would reprice the model
// if its overlay applied.
test("the stack's catalog fixture prices the scenario model without a pi on PATH, and a home overlay does not reprice it", () => {
  const root = mkdtempSync(join(tmpdir(), "pcat-"));
  try {
    const dir = join(root, "catalog");
    writeCatalogFixture(dir);
    const home = join(root, "home");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    const overlay = { [PROVIDER]: { lastModified: Date.now(), models: [{ id: MODEL, cost: { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 } }] } };
    writeFileSync(join(home, ".pi", "agent", "models-store.json"), JSON.stringify(overlay));
    const c = openPiCatalog({ PATH: "" }, PROVIDER, home, dir);
    assert.equal(c.found, true, c.message);
    const rates = c.rates.lookup(PROVIDER, MODEL);
    assert.deepEqual(rates && { input: rates.input, output: rates.output }, { input: CATALOG_COST.input, output: CATALOG_COST.output });
    // Negative control: no catalog, as on the hosted runner, prices nothing (every stub response is then refused as unpriceable).
    const none = openPiCatalog({ PATH: "" }, PROVIDER, home, "");
    assert.equal(none.found, false);
    assert.match(none.message, /no managed pi on PATH/);
    assert.equal(none.rates.lookup(PROVIDER, MODEL), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const ev = (seq: number, generation: number, payload: JournalEvent["payload"]): JournalEvent => ({ seq, agent: "ag-1", generation, payload });

test("errorLines lists provider_error and error entries with code, generation and the quoted message head", () => {
  const events = [
    ev(1, 0, { kind: "started" }),
    ev(2, 0, { kind: "provider_error", code: "outage", message: "terminated\nsocket closed", retryable: true }),
    ev(3, 1, { kind: "error", message: "x".repeat(400) }),
    ev(4, 1, { kind: POMTREED_KINDS.modelSettlement, settlement: "failed", errorClass: "stream_cut", upstreamStatus: 200 }),
  ];
  assert.deepEqual(errorLines({ id: "ag-1", name: "parent" }, events), [
    'parent ag-1 gen 0 provider_error outage: "terminated\\nsocket closed"',
    `parent ag-1 gen 1 error: "${"x".repeat(300)}"`,
    `parent ag-1 gen 1 ${POMTREED_KINDS.modelSettlement} failed: errorClass=stream_cut upstreamStatus=200`,
  ]);
});

test("errorLines is empty for a journal without error entries or failed settlements (negative control)", () => {
  const events = [
    ev(1, 0, { kind: "started" }),
    ev(2, 0, { kind: "tool_result", output: "error: not an entry kind" }),
    ev(3, 0, { kind: POMTREED_KINDS.modelSettlement, settlement: "priced", micros: 5 }),
  ];
  assert.deepEqual(errorLines({ id: "ag-1", name: "parent" }, events), []);
});
