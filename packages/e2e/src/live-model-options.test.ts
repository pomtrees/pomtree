import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "@pomtree/store-sqlite";
import { readUpstreamKeyFile, startLiveModel } from "./live-model.ts";

const base = { POMTREED_MODEL_BASE_URL: "http://127.0.0.1:1/api/v1", POMTREED_PI_CATALOG_DIR: "/nonexistent-w3" };

test("the live composition validates the daemon's model-proxy env (shared builder) and closes cleanly", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "w3-live-opts-"));
  const store = openStore(join(stateDir, "pomtreed.sqlite"));
  try {
    const keyFile = join(stateDir, "upstream.key");
    writeFileSync(keyFile, "k-file\n", { mode: 0o600 });
    const env = { ...base, POMTREED_MODEL_UPSTREAM_KEY_FILE: keyFile };
    const args = { store, secret: "s", stateDir, provider: "openrouter", platform: "darwin" };
    await assert.rejects(startLiveModel({ ...args, env: { ...env, POMTREED_MODEL_UPSTREAM_TIMEOUT_MS: "0" } }), /POMTREED_MODEL_UPSTREAM_TIMEOUT_MS/);
    const live = await startLiveModel({ ...args, env });
    await live.close();
    // An in-process caller that already holds the key passes it; no key file is needed then.
    const held = await startLiveModel({ ...args, env: base, upstreamKey: "k-held" });
    await held.close();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the upstream key is read only from a 0600 key file; a raw key in the env is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "w3-live-key-"));
  const store = openStore(join(dir, "pomtreed.sqlite"));
  try {
    const args = { store, secret: "s", stateDir: dir, provider: "openrouter", platform: "darwin" };
    const file = join(dir, "upstream.key");
    writeFileSync(file, "k-file\n", { mode: 0o600 });
    assert.equal(readUpstreamKeyFile({ POMTREED_MODEL_UPSTREAM_KEY_FILE: file }), "k-file");
    await assert.rejects(
      startLiveModel({ ...args, env: { ...base, PTREE_E2E_MODEL_KEY: "raw", POMTREED_MODEL_UPSTREAM_KEY_FILE: file } }),
      /PTREE_E2E_MODEL_KEY is retired .*POMTREED_MODEL_UPSTREAM_KEY_FILE/,
    );
    await assert.rejects(startLiveModel({ ...args, env: base }), /POMTREED_MODEL_UPSTREAM_KEY_FILE is required/);
    assert.throws(() => readUpstreamKeyFile({ POMTREED_MODEL_UPSTREAM_KEY_FILE: "upstream.key" }), /expected an absolute path/);
    assert.throws(() => readUpstreamKeyFile({ POMTREED_MODEL_UPSTREAM_KEY_FILE: join(dir, "missing.key") }), /cannot read .*missing\.key/);
    const empty = join(dir, "empty.key");
    writeFileSync(empty, "", { mode: 0o600 });
    assert.throws(() => readUpstreamKeyFile({ POMTREED_MODEL_UPSTREAM_KEY_FILE: empty }), /empty\.key is empty/);
    if (process.platform !== "win32") {
      const open = join(dir, "open.key");
      writeFileSync(open, "k-open", { mode: 0o644 });
      assert.throws(
        () => readUpstreamKeyFile({ POMTREED_MODEL_UPSTREAM_KEY_FILE: open }),
        (e: Error) => /chmod 600/.test(e.message) && !e.message.includes("k-open"),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
