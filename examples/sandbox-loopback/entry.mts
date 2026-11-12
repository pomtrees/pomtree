// The extension's own entry module. Every extension has one (manifest.json `entry`); this one registers nothing, because the extension
// exists only to provide the `loopback` sandbox backend (manifest.json `provides`, module provider.mts). Type imports only: the
// extension host loads this file without the sandbox import guard, and a type import leaves nothing to resolve at run time.
import type { Extension } from "@pomtree/core";

const extension: Extension = {
  manifest: { name: "loopback", entry: "entry.mts", capabilities: {}, deps: [] },
};

export default extension;
