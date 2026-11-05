import {
  contract,
  journalAppendContractBody,
  journalSubscribeContractBody,
  journalUsageIdentityContractBody,
  registryProviderAttemptsContractBody,
  registryRootPoolContractBody,
} from "@pomtree/testing";
import type { JournalAppendContractWorld } from "@pomtree/testing";
import { openStore } from "./store.ts";

// Shared Journal bodies, run against the real store (the fake runs them in @pomtree/testing; retention runs in e2e/contract.test.ts).
const journal = contract<JournalAppendContractWorld>("Journal", { real: () => openStore() });
journal("append/read idempotency, fencing, filters", journalAppendContractBody);
journal("subscribe replay, tail, close", journalSubscribeContractBody);
journal("joined usage identity across keys and generations", journalUsageIdentityContractBody);

// Registry writes that journal atomically (setRootPool) and the provider ladder count, against the real store (the fake runs them in @pomtree/testing).
const registry = contract<JournalAppendContractWorld>("Registry", { real: () => openStore() });
registry("setRootPool: atomic top-up and withdrawal, refused in full past the unheld remainder", registryRootPoolContractBody);
registry("provider attempts: keyed bump, reset, per agent", registryProviderAttemptsContractBody);
