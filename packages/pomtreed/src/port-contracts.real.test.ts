import { test } from "node:test";
import { join } from "node:path";
import { openStore } from "@pomtree/store-sqlite";
import {
  FakeHostStore,
  FakeJournal,
  FakeModelDebitStore,
  FakeRegistry,
  modelGatewayContractBody,
  modelGatewayRegisterOn,
  placementContractBody,
  tmpDir,
} from "@pomtree/testing";
import type { ModelGatewayContractWorld, PlacementContractWorld } from "@pomtree/testing";
import type { HostStore } from "@pomtree/core";
import { ProxyCredentialGateway } from "./gateway.ts";
import { HostPlacement } from "./placement.ts";

// The real halves of the shared port contracts (fake halves: packages/testing/src/port-contracts.test.ts, TODO(contract-ports)).

const placementWorld = async (hosts: HostStore): Promise<PlacementContractWorld> => {
  await hosts.upsertHost({ id: "h1", labels: {}, capacity: { maxSessions: 2 }, images: [], state: "ready" }, "h1");
  return { placement: new HostPlacement({ hosts, host: "h1" }), host: "h1", maxConcurrent: 2 };
};

test("Placement [real HostPlacement, FakeHostStore] admit/queue/release/sync", async () => {
  await placementContractBody(await placementWorld(new FakeHostStore(Date.now)));
});

test("Placement [real HostPlacement, sqlite HostStore] admit/queue/release/sync", async () => {
  const s = openStore(join(tmpDir("pcr-"), "p.sqlite"));
  try {
    await placementContractBody(await placementWorld(s.hosts));
  } finally {
    s.close();
  }
});

const gatewayWorld = (withDebits: boolean): ModelGatewayContractWorld => {
  const now = () => Date.now();
  const registry = new FakeRegistry(now);
  const gateway = new ProxyCredentialGateway({
    journal: new FakeJournal(now),
    registry,
    secret: "controller-secret",
    proxyBaseUrl: "http://relay.internal/v1",
    tokenTtlMs: 60_000,
    ...(withDebits && { debits: new FakeModelDebitStore({ secret: "controller-secret", now }) }),
  });
  return { gateway, register: modelGatewayRegisterOn(registry) };
};

test("ModelGateway [real ProxyCredentialGateway, journal metering] issue/replay per agent, spend/revoke without a credential", async () => {
  await modelGatewayContractBody(gatewayWorld(false));
});

test("ModelGateway [real ProxyCredentialGateway, debit store] issue/replay per agent, spend/revoke without a credential", async () => {
  await modelGatewayContractBody(gatewayWorld(true));
});
