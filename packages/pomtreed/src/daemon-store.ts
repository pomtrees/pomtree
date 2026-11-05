// The production store as every daemon entry point opens it: store-sqlite's openStore with the journal traced (trace-context.ts),
// so the extension host, the workflow host and any other writer handed `store.journal` stamp trace context exactly as the Daemon
// does. main.ts and the live example runtimes open their store through this; the Daemon constructor wraps again (a no-op here)
// so a Daemon built over a bare store still stamps its own writes.
import { type OpenOptions, openStore, type Store } from "@pomtree/store-sqlite";
import { tracedJournal } from "./trace-context.ts";

export function openDaemonStore(path?: string, opts?: OpenOptions): Store {
  const store = openStore(path, opts);
  return { ...store, journal: tracedJournal(store.journal, (id) => store.registry.get(id)) };
}
