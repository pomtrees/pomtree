// Offline checks for the model runtime factory: option validation, limits wiring, catalog gate, close-step bounds and the staged
// 1024-token recipe. The only open attempt fails before resource creation (no Docker, provider, auth file, or network).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { sessionDeadlineConfig } from "../../packages/pomtreed/src/daemon.ts";
import type { FetchFn } from "../../packages/pomtreed/src/ext-gateway.ts";
import { type Driver, LocalOrchestrator } from "../../packages/pomtreed/src/orchestrator.ts";
import {
  APPROVED_IMAGE,
  DEEPSEEK_FLASH_OVERRIDE,
  MODEL_BUDGET_MICROS,
  MODEL_DEADLINE_CAP_MS,
  MODEL_ID,
  MODEL_MAX_OUTPUT_TOKENS,
  MODEL_PROVIDER,
  type ModelRuntimeOptions,
  joinLifecycle,
  openModelRuntime,
  modelCatalogEnv,
  modelDaemonLimits,
  modelPiCommand,
  modelRuntimeCredentials,
  requirePricedModel,
  SHUTDOWN_BOUND_MS,
  teardownPartialOpen,
  teardownResources,
  selectSourceTransport,
  validateModelRuntimeOptions,
} from "./model-runtime.mts";
import { DEFAULT_FETCH_USER_AGENT } from "../../packages/core/src/index.ts";
import { type CloseLedger, resolveFetchUserAgent, TEST_FETCH_USER_AGENT } from "./runtime.mts";

const ok: ModelRuntimeOptions = {
  stateDir: "/tmp/mr-state",
  repoDir: "/tmp/mr-repo",
  extensionDir: "/tmp/mr-ext",
  upstreamKey: "k-test",
  fetch: (async () => new Response("")) as typeof globalThis.fetch,
  fetchUserAgent: TEST_FETCH_USER_AGENT,
};

// An offline Pi-shaped catalog for the route (rates are USD per million tokens, the override's), plus an empty Pi agent dir so no host
// install or models-store overlay is read: the tests run the same on every host.
const FIXTURE_CATALOG = mkdtempSync(join(tmpdir(), "mr-catalog-"));
const FIXTURE_AGENT_DIR = mkdtempSync(join(tmpdir(), "mr-agent-"));
writeFileSync(
  join(FIXTURE_CATALOG, `${MODEL_PROVIDER}.json`),
  JSON.stringify({
    "openai-completions": {
      [`chat:${MODEL_ID}`]: { id: MODEL_ID, type: "chat", api: "openai-completions", baseUrl: "https://api.deepseek.com", cost: DEEPSEEK_FLASH_OVERRIDE.cost },
    },
  }),
);
after(() => {
  rmSync(FIXTURE_CATALOG, { recursive: true, force: true });
  rmSync(FIXTURE_AGENT_DIR, { recursive: true, force: true });
});

test("valid options pass validation", () => {
  assert.doesNotThrow(() => validateModelRuntimeOptions(ok));
  assert.doesNotThrow(() => validateModelRuntimeOptions({ ...ok, image: APPROVED_IMAGE }));
});

test("missing paths, key or guarded fetch are rejected before anything opens", () => {
  assert.throws(() => validateModelRuntimeOptions({ ...ok, stateDir: " " }), /stateDir/);
  assert.throws(() => validateModelRuntimeOptions({ ...ok, repoDir: "" }), /repoDir/);
  assert.throws(() => validateModelRuntimeOptions({ ...ok, extensionDir: "" }), /extensionDir/);
  assert.throws(() => validateModelRuntimeOptions({ ...ok, upstreamKey: "" }), /upstreamKey/);
  assert.throws(() => validateModelRuntimeOptions({ ...ok, fetch: undefined as unknown as typeof fetch }), /fetch/);
});

test("resolveFetchUserAgent: unset or blank resolves to the registry default; a product token passes through", () => {
  assert.equal(resolveFetchUserAgent(undefined, "t"), DEFAULT_FETCH_USER_AGENT);
  assert.equal(resolveFetchUserAgent("", "t"), DEFAULT_FETCH_USER_AGENT);
  assert.equal(resolveFetchUserAgent("hn-digest", "t"), "hn-digest");
  assert.equal(resolveFetchUserAgent("hn-digest (+https://example.org/contact)", "t"), "hn-digest (+https://example.org/contact)");
});

test("resolveFetchUserAgent: a header-unsafe value is refused naming the key, env and action; a space-separated lookalike passes", () => {
  assert.throws(
    () => resolveFetchUserAgent("app a@b.c\r\nX-Evil: 1", "t"),
    /^Error: t: workflow\.fetch\.userAgent is refused .*POMTREED_WORKFLOW_FETCH_USER_AGENT.*to a product token.*leave it unset for the default/,
  );
  assert.equal(resolveFetchUserAgent("app a@b.c X-Evil: 1", "t"), "app a@b.c X-Evil: 1");
});

test("validateModelRuntimeOptions asserts the resolved-UA invariant: empty or header-unsafe values throw the invariant message", () => {
  assert.throws(
    () => validateModelRuntimeOptions({ ...ok, fetchUserAgent: "" }),
    /^Error: openModelRuntime: fetchUserAgent is empty; pass the value resolved from workflow\.fetch\.userAgent \(resolveConfig\), which is never blank/,
  );
  assert.throws(
    () => validateModelRuntimeOptions({ ...ok, fetchUserAgent: "x\r\ny" }),
    /^Error: openModelRuntime: fetchUserAgent is invalid: .*; pass the value resolved from workflow\.fetch\.userAgent/,
  );
});

test("only the approved immutable image digest is accepted", () => {
  assert.match(APPROVED_IMAGE, /@sha256:[0-9a-f]{64}$/);
  assert.throws(() => validateModelRuntimeOptions({ ...ok, image: "pomtree/agent:latest" }), /approved agent image/);
});

test("the upstream key never appears in validation errors (the failure must throw)", () => {
  let message: string | undefined;
  assert.throws(() => {
    try {
      validateModelRuntimeOptions({ ...ok, repoDir: "" });
    } catch (e) {
      message = (e as Error).message;
      throw e;
    }
  }, /repoDir/);
  assert.ok(message !== undefined, "validation must have thrown with a message");
  assert.ok(!message.includes(ok.upstreamKey), "error message must not contain the upstream key");
});

test("pinned binding, caps and daemon limits are the exported constants", () => {
  assert.equal(MODEL_PROVIDER, "deepseek");
  assert.equal(MODEL_ID, "deepseek-flash");
  assert.equal(MODEL_BUDGET_MICROS, 100_000);
  assert.equal(MODEL_MAX_OUTPUT_TOKENS, 1024);
  assert.equal(MODEL_DEADLINE_CAP_MS, 120_000);
  assert.equal(DEEPSEEK_FLASH_OVERRIDE.maxTokens, 1024);
  assert.equal(DEEPSEEK_FLASH_OVERRIDE.api, "openai-completions");
  assert.equal(DEEPSEEK_FLASH_OVERRIDE.compat?.maxTokensField, "max_tokens");
  // The factory spreads modelDaemonLimits() into DaemonDeps, so these assertions cover the real wiring values.
  const limits = modelDaemonLimits();
  assert.deepEqual(limits, {
    defaultSessionMs: MODEL_DEADLINE_CAP_MS,
    maxSessionMs: MODEL_DEADLINE_CAP_MS,
    rootBudgetMicros: MODEL_BUDGET_MICROS,
    defaultBudgetMicros: MODEL_BUDGET_MICROS,
  });
  assert.deepEqual(sessionDeadlineConfig(limits), { defaultSessionMs: MODEL_DEADLINE_CAP_MS, maxSessionMs: MODEL_DEADLINE_CAP_MS });
  assert.ok(SHUTDOWN_BOUND_MS >= 5_000 && SHUTDOWN_BOUND_MS <= 10_000);
});

test("credentials factory exposes only the provider id", () => {
  const cred = modelRuntimeCredentials("/tmp/mr-state-unused");
  assert.equal(typeof cred.stage, "function");
  assert.deepEqual(cred.providerIds?.(), [MODEL_PROVIDER]);
});

test("catalog gate refuses an unpriced or missing catalog before any paid startup", () => {
  const empty = mkdtempSync(join(tmpdir(), "mr-cat-"));
  try {
    assert.throws(() => requirePricedModel({ POMTREED_PI_CATALOG_DIR: empty, PATH: "" }), /openModelRuntime/);
    assert.throws(() => requirePricedModel({ PATH: "/nonexistent-dir-for-test" }), /openModelRuntime/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("catalog gate resolves the known deepseek-flash rate from the catalog", () => {
  assert.doesNotThrow(() => requirePricedModel({ POMTREED_PI_CATALOG_DIR: FIXTURE_CATALOG, PI_CODING_AGENT_DIR: FIXTURE_AGENT_DIR, PATH: "" }));
});

test("catalog lookup env carries only non-secret fields, never the upstream key", () => {
  const picked = modelCatalogEnv({
    PATH: "/usr/bin",
    POMTREED_PI_CATALOG_DIR: "/cat",
    PI_CODING_AGENT_DIR: "/agent",
    PTREE_E2E_MODEL_KEY: "k-test",
    OPENAI_API_KEY: "sk-other",
    HOME: "/home/x",
  });
  assert.deepEqual(picked, { PATH: "/usr/bin", POMTREED_PI_CATALOG_DIR: "/cat", PI_CODING_AGENT_DIR: "/agent" });
});

test("sourceFetch: a non-function is rejected before anything opens", () => {
  assert.throws(() => validateModelRuntimeOptions({ ...ok, sourceFetch: "https://x" as unknown as never }), /sourceFetch/);
  assert.doesNotThrow(() => validateModelRuntimeOptions({ ...ok, sourceFetch: (async () => ({})) as unknown as FetchFn }));
  assert.doesNotThrow(() => validateModelRuntimeOptions(ok));
});

test("sourceFetch: absent refuses without calling the model fetch or any network", async () => {
  let providerCalls = 0;
  const providerFetch = (async () => {
    providerCalls++;
    return new Response("");
  }) as typeof globalThis.fetch;
  const selected = selectSourceTransport({});
  await assert.rejects(() => selected("https://example.invalid/x", {} as Parameters<FetchFn>[1]), /source fetch transport configured/);
  assert.equal(providerCalls, 0);
  assert.equal(typeof providerFetch, "function");
});

test("sourceFetch: provided is returned as-is and called, with the provider fetch untouched", async () => {
  let providerCalls = 0;
  const providerFetch = (async () => {
    providerCalls++;
    return new Response("");
  }) as typeof globalThis.fetch;
  const seen: string[] = [];
  const source: FetchFn = async (url) => {
    seen.push(url);
    return { ok: true, status: 200, bytes: new Uint8Array() } as unknown as Awaited<ReturnType<FetchFn>>;
  };
  const selected = selectSourceTransport({ sourceFetch: source });
  assert.equal(selected, source);
  await selected("https://hacker-news.firebaseio.com/v0/item/1.json", {} as Parameters<FetchFn>[1]);
  assert.deepEqual(seen, ["https://hacker-news.firebaseio.com/v0/item/1.json"]);
  assert.equal(providerCalls, 0);
  assert.equal(typeof providerFetch, "function");
});

test("model pi command: --thinking off sits right after argv[0], before '--', and the prompt is unchanged", () => {
  const prompt = "summarize --thinking on";
  const argv = modelPiCommand(prompt);
  const i = argv.indexOf("--thinking");
  assert.equal(argv[0], "pi");
  assert.equal(i, 1);
  assert.equal(argv[i + 1], "off");
  assert.equal(argv.filter((a) => a === "--thinking").length, 1);
  const sep = argv.indexOf("--");
  assert.ok(sep > i + 1, "flag must precede the separator");
  assert.equal(argv[sep + 1], prompt);
  assert.equal(argv.length, sep + 2, "nothing appended after the prompt");
  assert.deepEqual(argv.slice(sep), ["--", prompt]);
});

test("model pi command: provider and model stay deepseek/deepseek-flash, with the rest of piArgv unchanged", () => {
  const argv = modelPiCommand("p");
  const p = argv.indexOf("--provider");
  const m = argv.indexOf("--model");
  assert.equal(argv[p + 1], MODEL_PROVIDER);
  assert.equal(argv[m + 1], MODEL_ID);
  assert.equal(argv.filter((a) => a === "--provider").length, 1);
  assert.equal(argv.filter((a) => a === "--model").length, 1);
  assert.equal(argv[argv.length - 2], "--");
});

test("partial-open teardown: reverse order, sanitized failures, later steps still run", async () => {
  const order: string[] = [];
  const failures = await teardownPartialOpen(
    [
      { label: "store close", run: async () => void order.push("store") },
      { label: "model proxy close", run: async () => void order.push("proxy") },
      {
        label: "host server close",
        run: async () => {
          throw new Error("bad sk-upstream-key");
        },
      },
    ],
    ["sk-upstream-key"],
  );
  assert.deepEqual(order, ["proxy", "store"]);
  assert.equal(failures.length, 1);
  assert.match(failures[0] ?? "", /host server close: bad \[redacted\]/);
});

test("partial-open teardown: a hung step is bounded and the store stays open", async () => {
  const order: string[] = [];
  const t0 = Date.now();
  const failures = await teardownPartialOpen(
    [
      { label: "store close", run: async () => void order.push("store") },
      { label: "agent server close", run: () => new Promise<void>(() => {}) },
    ],
    [],
    50,
  );
  assert.ok(Date.now() - t0 < 1_000);
  assert.deepEqual(order, []);
  assert.ok(failures.some((f) => /agent server close: timed out/.test(f)));
  assert.ok(failures.some((f) => /store close: skipped/.test(f)));
});

test("partial-open teardown: a rejected resource stop retains SQLite, not just its diagnostic directory", async () => {
  const order: string[] = [];
  const failures = await teardownPartialOpen(
    [
      {
        label: "store close",
        run: async () => {
          order.push("store");
        },
      },
      {
        label: "model proxy close",
        run: async () => {
          order.push("proxy");
        },
      },
      {
        label: "extensions stop",
        retainStoreOnFailure: true,
        run: async () => {
          throw new Error("live task stop refused");
        },
      },
    ],
    [],
  );
  assert.deepEqual(order, ["proxy"]);
  assert.match(failures.join("; "), /extensions stop: live task stop refused.*store close: skipped/);
});

test("partial-open teardown: a clean teardown reports no failures", async () => {
  assert.deepEqual(await teardownPartialOpen([{ label: "store close", run: async () => {} }], []), []);
});

function delayedLifecycle(order: string[]) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const orchestrator = new LocalOrchestrator();
  const driver: Driver = {
    now: Date.now,
    drive: async () => {
      await gate;
      order.push("revoke", "journal", "finish-tail");
    },
    runResumed: async () => {},
    wakeResume: async () => {},
    stop: async () => {
      order.push("cancel-requested");
    },
    deliver: async () => {},
    isYielded: async () => false,
  };
  orchestrator.bind(driver);
  return { orchestrator, release };
}

test("model cleanup: cancellation and physical exit do not close SQLite before delayed lifecycle settlement", async () => {
  const order: string[] = [];
  const { orchestrator, release } = delayedLifecycle(order);
  await orchestrator.start("a1", 0);
  await orchestrator.cancel("a1", 0);
  order.push("physical-exit"); // scripted sandbox exit; the drive's revocation and finish-tail are still blocked
  const ledger: CloseLedger = { failures: [], unjoined: false };
  let closed = false;
  const deadline = Date.now() + 1_000;
  const close = (async () => {
    await joinLifecycle(orchestrator, deadline, ledger);
    await teardownResources(
      [
        {
          label: "store close",
          run: async () => {
            closed = true;
            order.push("store");
          },
        },
      ],
      deadline,
      ledger,
    );
  })();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(closed, false, "the join is still blocked after cancel and physical exit");
  release();
  await close;
  assert.deepEqual(order, ["cancel-requested", "physical-exit", "revoke", "journal", "finish-tail", "store"]);
  assert.deepEqual(ledger, { failures: [], unjoined: false });
});

test("model cleanup: a delayed lifecycle past the absolute deadline keeps SQLite open and reports why", async () => {
  const order: string[] = [];
  const { orchestrator, release } = delayedLifecycle(order);
  await orchestrator.start("a1", 0);
  const ledger: CloseLedger = { failures: [], unjoined: false };
  const deadline = Date.now() + 20;
  try {
    assert.equal(await joinLifecycle(orchestrator, deadline, ledger), false);
    await teardownResources(
      [
        {
          label: "store close",
          run: async () => {
            order.push("store");
          },
        },
      ],
      deadline,
      ledger,
    );
    assert.equal(ledger.unjoined, true);
    assert.ok(!order.includes("store"));
    assert.match(ledger.failures.join("; "), /lifecycle settlement: timed out.*store close: skipped/);
  } finally {
    release();
    await orchestrator.idle();
  }
});

test("model open catch: a filesystem error is sanitized even after clean partial teardown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-open-redact-"));
  const stateDir = join(dir, ok.upstreamKey);
  const previous = process.env.POMTREED_PI_CATALOG_DIR;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.POMTREED_PI_CATALOG_DIR = FIXTURE_CATALOG;
  process.env.PI_CODING_AGENT_DIR = FIXTURE_AGENT_DIR;
  writeFileSync(stateDir, "not a directory");
  let fetchCalls = 0;
  try {
    await assert.rejects(
      () =>
        openModelRuntime({
          ...ok,
          stateDir,
          fetch: async () => {
            fetchCalls++;
            throw new Error("unexpected fetch");
          },
        }),
      (e: Error) => {
        assert.match(e.message, /EEXIST/);
        assert.ok(!e.message.includes(ok.upstreamKey));
        assert.ok(!e.message.includes(dir));
        assert.doesNotMatch(e.message, /teardown failures/);
        return true;
      },
    );
    assert.equal(fetchCalls, 0, "failure happens before proxy, Docker, or provider startup");
  } finally {
    if (previous === undefined) delete process.env.POMTREED_PI_CATALOG_DIR;
    else process.env.POMTREED_PI_CATALOG_DIR = previous;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
