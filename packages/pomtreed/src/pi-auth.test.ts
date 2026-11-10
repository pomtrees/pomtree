import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "@pomtree/testing";
import {
  agentAuthPath,
  PI_SETTINGS,
  PROXY_REQUEST_ID_COMMAND,
  PROXY_REQUEST_ID_HEADER,
  proxyAuthJson,
  proxyModelsJson,
  proxyPiCredentials,
  type BindMount,
  type ProxyModelOverride,
} from "./pi-auth.ts";

const tmp = () => tmpDir("pi-auth-");

test("proxy credential auth.json is scoped to the token only", () => {
  const json = proxyAuthJson("deepseek", "pg1.token.sig");
  assert.deepEqual(JSON.parse(json), {
    deepseek: { type: "api_key", key: "pg1.token.sig" },
  });
  assert.doesNotMatch(json, /operator-secret|sk-ant/);
  assert.deepEqual(JSON.parse(proxyAuthJson("google", "pg1.t.s")), {
    google: { type: "api_key", key: "pg1.t.s" },
  });
});

test("proxy models.json routes the provider through the proxy and injects a per-request idempotency header", () => {
  const json = proxyModelsJson("deepseek", "http://relay/v1");
  assert.deepEqual(JSON.parse(json), {
    providers: {
      deepseek: { baseUrl: "http://relay/v1", headers: { [PROXY_REQUEST_ID_HEADER]: PROXY_REQUEST_ID_COMMAND } },
    },
  });
  assert.equal(PROXY_REQUEST_ID_HEADER, "x-pomtree-request-id");
  assert.match(PROXY_REQUEST_ID_COMMAND, /^!/);
  assert.doesNotMatch(json, /operator-secret|sk-ant/);
});

test("proxy pi credentials stage a scoped auth.json and models.json, never the operator's key", () => {
  const state = tmp();
  const c = proxyPiCredentials({ stateDir: state, containerAuthPath: "/c/agent/auth.json", provider: "deepseek" });
  assert.throws(() => c.stage("a1", { key: "", baseUrl: "" }), /missing its issued key or base URL/);
  const [dirMount, settings] = c.stage("a1", { key: "pg1.token.sig", baseUrl: "http://relay/v1" }) as [BindMount, BindMount];
  assert.equal(dirMount.containerPath, "/c/agent");
  const auth = readFileSync(join(dirMount.hostPath, "auth.json"), "utf8");
  assert.deepEqual(JSON.parse(auth), {
    deepseek: { type: "api_key", key: "pg1.token.sig" },
  });
  assert.doesNotMatch(auth, /operator-secret|sk-ant/);
  const models = readFileSync(join(dirMount.hostPath, "models.json"), "utf8");
  assert.deepEqual(JSON.parse(models), {
    providers: {
      deepseek: { baseUrl: "http://relay/v1", headers: { [PROXY_REQUEST_ID_HEADER]: PROXY_REQUEST_ID_COMMAND } },
    },
  });
  assert.doesNotMatch(models, /operator-secret|sk-ant/);
  assert.deepEqual(c.providerIds?.(), ["deepseek"]);
  assert.equal(settings.readOnly, true);
  c.unstage("a1");
  assert.equal(existsSync(agentAuthPath(state, "a1")), false);
});

// The DeepSeek recipe lives in the caller, never in pi-auth: this is the proof-only override for the HN slice.
const DEEPSEEK_FLASH: ProxyModelOverride = {
  id: "deepseek-flash",
  name: "DeepSeek V4.1 Flash",
  api: "openai-completions",
  reasoning: true,
  input: ["text"],
  contextWindow: 1000000,
  maxTokens: 1024,
  cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  compat: {
    maxTokensField: "max_tokens",
    thinkingFormat: "deepseek",
    requiresReasoningContentOnAssistantMessages: true,
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsStrictMode: true,
  },
};
const withTmp = (fn: (dir: string) => void) => {
  const dir = tmp();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("absent model overrides keep the exact previous models.json bytes", () => {
  const expected = `${JSON.stringify(
    { providers: { deepseek: { baseUrl: "http://relay/v1", headers: { "x-pomtree-request-id": "!cat /proc/sys/kernel/random/uuid" } } } },
    null,
    2,
  )}\n`;
  assert.equal(proxyModelsJson("deepseek", "http://relay/v1"), expected);
  assert.equal(proxyModelsJson("deepseek", "http://relay/v1", undefined), expected);
});

test("model overrides are metadata-only and keep the proxy baseUrl and request-id header exactly", () => {
  const parsed = JSON.parse(proxyModelsJson("deepseek", "http://relay/v1", [DEEPSEEK_FLASH]));
  assert.deepEqual(parsed.providers.deepseek, {
    baseUrl: "http://relay/v1",
    headers: { [PROXY_REQUEST_ID_HEADER]: PROXY_REQUEST_ID_COMMAND },
    api: "openai-completions",
    models: [DEEPSEEK_FLASH],
  });
});

test("staged models.json carries the override metadata through proxyPiCredentials", () => {
  withTmp((state) => {
    const c = proxyPiCredentials({ stateDir: state, containerAuthPath: "/c/agent/auth.json", provider: "deepseek", modelOverrides: [DEEPSEEK_FLASH] });
    const [dir] = c.stage("a2", { key: "pg1.token.sig", baseUrl: "http://relay/v1" }) as [BindMount, BindMount];
    const models = JSON.parse(readFileSync(join(dir.hostPath, "models.json"), "utf8"));
    assert.equal(models.providers.deepseek.baseUrl, "http://relay/v1");
    assert.equal(models.providers.deepseek.headers[PROXY_REQUEST_ID_HEADER], PROXY_REQUEST_ID_COMMAND);
    assert.equal(models.providers.deepseek.api, "openai-completions");
    assert.equal(models.providers.deepseek.models[0].maxTokens, 1024);
    assert.equal(models.providers.deepseek.models[0].compat.maxTokensField, "max_tokens");
    assert.deepEqual(JSON.parse(readFileSync(join(dir.hostPath, "auth.json"), "utf8")), {
      deepseek: { type: "api_key", key: "pg1.token.sig" },
    });
    c.unstage("a2");
  });
});

test("the provider api is omitted when overrides do not name one", () => {
  const { api: _api, ...noApi } = DEEPSEEK_FLASH;
  const parsed = JSON.parse(proxyModelsJson("deepseek", "http://relay/v1", [noApi]));
  assert.equal("api" in parsed.providers.deepseek, false);
  assert.equal("api" in parsed.providers.deepseek.models[0], false);
});

test("invalid model overrides fail closed at construction", () => {
  const bad: [string, unknown][] = [
    ["empty array", []],
    ["over 16 models", Array.from({ length: 17 }, (_, i) => ({ ...DEEPSEEK_FLASH, id: `m${i}` }))],
    ["duplicate id", [DEEPSEEK_FLASH, { ...DEEPSEEK_FLASH }]],
    ["unknown field", [{ ...DEEPSEEK_FLASH, extra: 1 }]],
    ["per-model baseUrl", [{ ...DEEPSEEK_FLASH, baseUrl: "http://evil" }]],
    ["per-model headers", [{ ...DEEPSEEK_FLASH, headers: { "x-key": "!cat /etc/passwd" } }]],
    ["per-model auth", [{ ...DEEPSEEK_FLASH, auth: "k" }]],
    ["zero maxTokens", [{ ...DEEPSEEK_FLASH, maxTokens: 0 }]],
    ["fractional contextWindow", [{ ...DEEPSEEK_FLASH, contextWindow: 1.5 }]],
    ["oversized maxTokens", [{ ...DEEPSEEK_FLASH, maxTokens: 10_000_001 }]],
    ["negative cost", [{ ...DEEPSEEK_FLASH, cost: { ...DEEPSEEK_FLASH.cost, output: -1 } }]],
    ["unknown input", [{ ...DEEPSEEK_FLASH, input: ["audio"] }]],
    ["empty input", [{ ...DEEPSEEK_FLASH, input: [] }]],
    ["compat headers", [{ ...DEEPSEEK_FLASH, compat: { headers: { a: "b" } } }]],
    ["compat function", [{ ...DEEPSEEK_FLASH, compat: { run: () => 1 } }]],
    ["empty id", [{ ...DEEPSEEK_FLASH, id: " " }]],
    ["conflicting api", [DEEPSEEK_FLASH, { ...DEEPSEEK_FLASH, id: "other", api: "anthropic-messages" }]],
  ];
  for (const [label, overrides] of bad) {
    withTmp((state) => {
      assert.throws(
        () =>
          proxyPiCredentials({
            stateDir: state,
            containerAuthPath: "/c/agent/auth.json",
            provider: "deepseek",
            modelOverrides: overrides as ProxyModelOverride[],
          }),
        /modelOverrides|duplicated|unknown|must|may not|conflicting/,
        label,
      );
    });
  }
});

test("mutating the constructed options after construction does not change staged metadata", () => {
  withTmp((state) => {
    const overrides: ProxyModelOverride[] = [{ ...DEEPSEEK_FLASH, compat: { maxTokensField: "max_tokens" } }];
    const c = proxyPiCredentials({ stateDir: state, containerAuthPath: "/c/agent/auth.json", provider: "deepseek", modelOverrides: overrides });
    overrides[0]!.maxTokens = 999999;
    overrides[0]!.compat!.maxTokensField = "max_completion_tokens";
    overrides.push({ ...DEEPSEEK_FLASH, id: "late" });
    const [dir] = c.stage("a3", { key: "pg1.t.s", baseUrl: "http://relay/v1" }) as [BindMount, BindMount];
    const models = JSON.parse(readFileSync(join(dir.hostPath, "models.json"), "utf8")).providers.deepseek.models;
    assert.equal(models.length, 1);
    assert.equal(models[0].maxTokens, 1024);
    assert.equal(models[0].compat.maxTokensField, "max_tokens");
    c.unstage("a3");
  });
});

test("the staged Pi settings turn Pi's own retry ladder and cache warming off, so pomtreed's provider backoff is the only one (TODO(retry-ladder))", () => {
  const s = JSON.parse(PI_SETTINGS);
  assert.deepEqual(s, { defaultProjectTrust: "never", cacheWarming: "off", retry: { enabled: false, provider: { maxRetries: 0 } } });
});
