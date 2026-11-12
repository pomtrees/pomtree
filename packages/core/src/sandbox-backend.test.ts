import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { request as nodeHttpsRequest } from "node:https";
import { SANDBOX_PORT_VERSION, checkPortVersion, hashExtensionTree, validateBackendId } from "./index.ts";
import type { ExtensionTreeEntry, SandboxBackendDeps, SandboxBackendProvider, SandboxRequestFn, SandboxRequester } from "./index.ts";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const file = (path: string, body: string): ExtensionTreeEntry => ({ path, size: Buffer.byteLength(body), sha256: sha(body) });

const TREE: ExtensionTreeEntry[] = [file("manifest.json", "{}"), file("provider.mts", "export const a = 1;\n"), file("lib/util.mjs", "x")];

// Compile-time control: a provider missing a required field must fail type checking. If `credentials` ever becomes optional this
// directive is unused and `npx tsc -p packages/core` fails.
// @ts-expect-error missing required field `credentials`
export const incomplete: SandboxBackendProvider = {
  id: "toybox",
  portVersion: 1,
  declaration: undefined as never,
  params: [],
  create: () => undefined as never,
};

// Compile-time control: node's own https.request must not satisfy the adapter-facing request type, and a conforming function must.
// @ts-expect-error node:https request has a different shape
export const rawHttps: SandboxBackendDeps["request"] = undefined as unknown as typeof nodeHttpsRequest;
// @ts-expect-error a requester without openWebSocket is not a SandboxRequester
export const noWs: SandboxBackendDeps["request"] = async () => ({ status: 200, headers: {}, body: new Uint8Array() });
// @ts-expect-error a response missing the required `body` field is not a SandboxResponse
export const noBody: SandboxRequestFn = async () => ({ status: 200, headers: {} });
export const conformingRequester: SandboxRequester = Object.assign(async () => ({ status: 200, headers: {}, body: new Uint8Array() }), {
  openWebSocket: (): WebSocket => undefined as never,
});
export const conforming: SandboxRequestFn = async (_url, init) => ({ status: init.upgrade ? 101 : 200, headers: {}, body: new Uint8Array() });

test("SANDBOX_PORT_VERSION starts at 1", () => {
  assert.equal(SANDBOX_PORT_VERSION, 1);
});

test("checkPortVersion accepts an equal version", () => {
  checkPortVersion("toybox", SANDBOX_PORT_VERSION);
});

test("checkPortVersion refuses a different version with cause and action", () => {
  for (const v of [SANDBOX_PORT_VERSION + 1, SANDBOX_PORT_VERSION - 1, "1", undefined]) {
    assert.throws(
      () => checkPortVersion("toybox", v),
      (e: Error) =>
        e.message.includes(`sandbox backend toybox speaks port version ${String(v)}; this daemon speaks ${SANDBOX_PORT_VERSION}`) &&
        e.message.includes("update the backend"),
    );
  }
});

test("hashExtensionTree: pin is sha256: plus 64 hex and matches the documented line format", () => {
  const pin = hashExtensionTree(TREE);
  assert.match(pin, /^sha256:[0-9a-f]{64}$/);
  const lines = [...TREE].sort((a, b) => (a.path < b.path ? -1 : 1)).map((e) => `${e.path}\0${e.size}\0${e.sha256}\n`);
  assert.equal(pin, `sha256:${sha(lines.join(""))}`);
});

test("hashExtensionTree: input order does not matter", () => {
  assert.equal(hashExtensionTree([...TREE].reverse()), hashExtensionTree(TREE));
});

test("hashExtensionTree: sorts by UTF-8 byte order, not locale", () => {
  const a = [file("B", "1"), file("a", "2"), file("é", "3")];
  assert.equal(hashExtensionTree(a), hashExtensionTree([...a].reverse()));
  const lines = a.map((e) => `${e.path}\0${e.size}\0${e.sha256}\n`).join(""); // B (0x42) < a (0x61) < é (0xC3..)
  assert.equal(hashExtensionTree(a), `sha256:${sha(lines)}`);
});

test("hashExtensionTree: changing one byte changes the pin", () => {
  const changed = TREE.map((e) => (e.path === "provider.mts" ? file("provider.mts", "export const a = 2;\n") : e));
  assert.notEqual(hashExtensionTree(changed), hashExtensionTree(TREE));
});

test("hashExtensionTree: adding one file changes the pin", () => {
  assert.notEqual(hashExtensionTree([...TREE, file("extra.txt", "")]), hashExtensionTree(TREE));
});

test("hashExtensionTree: renaming one file changes the pin", () => {
  const renamed = TREE.map((e) => (e.path === "lib/util.mjs" ? { ...e, path: "lib/util2.mjs" } : e));
  assert.notEqual(hashExtensionTree(renamed), hashExtensionTree(TREE));
});

test("hashExtensionTree: the pin depends only on the listing, so a copy at another path gives the same pin", () => {
  const copy = TREE.map((e) => ({ ...e }));
  assert.equal(hashExtensionTree(copy), hashExtensionTree(TREE));
});

test("hashExtensionTree: an empty listing is a valid pin", () => {
  assert.match(hashExtensionTree([]), /^sha256:[0-9a-f]{64}$/);
});

test("hashExtensionTree refuses malformed entries with cause and action", () => {
  const bad: ExtensionTreeEntry[] = [
    { path: "/abs", size: 1, sha256: sha("a") },
    { path: "../up", size: 1, sha256: sha("a") },
    { path: "a//b", size: 1, sha256: sha("a") },
    { path: "a\nb", size: 1, sha256: sha("a") },
    { path: "a\0b", size: 1, sha256: sha("a") },
    { path: "a\\b", size: 1, sha256: sha("a") },
    { path: "a", size: -1, sha256: sha("a") },
    { path: "a", size: 1.5, sha256: sha("a") },
    { path: "a", size: 1, sha256: "ABC" },
  ];
  for (const e of bad) assert.throws(() => hashExtensionTree([e]), /extension file.*(list|pass)/s, JSON.stringify(e));
  assert.throws(() => hashExtensionTree([file("a", "1"), file("a", "2")]), /listed twice; list each file once/);
});

test("validateBackendId accepts a contributed id", () => {
  assert.equal(validateBackendId("toybox"), "toybox");
  assert.equal(validateBackendId("a-b1"), "a-b1");
});

test("validateBackendId refuses reserved and malformed ids with cause and action", () => {
  for (const id of ["auto", "docker", "podman", "kubernetes", "sail", "e2b", "pomtree", "pomtree-x"]) {
    assert.throws(() => validateBackendId(id), /is reserved.*choose another id/, id);
  }
  for (const id of ["", "Toy", "1toy", "to_y", "toy:prod", "a".repeat(32)]) {
    assert.throws(() => validateBackendId(id), /is invalid.*rename the backend/, id);
  }
});
