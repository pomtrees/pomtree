import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentListenPlan } from "./agent-net.ts";
import { envName } from "./daemon-config.ts";
import { buildSafetyBootFacts, realpathLoose, type SafetyBootFacts, safetyBootErrors, untemplatedEgressNoneWarning } from "./safety-boot.ts";

const IMAGE = `sha256:${"0".repeat(64)}`;
const safeCfg = {
  "agent.egressProxyImage": IMAGE,
  "agent.untemplatedEgress": "none",
  "extensions.approval": "all",
  "merge.check": "",
  "listen.allowNonloopback": false,
};
const plan = (mode: AgentListenPlan["mode"], host: string): AgentListenPlan => ({ mode, host, port: 0, extraHosts: [] });
const writable = [
  { key: "state.dir", path: "/s/workspaces" },
  { key: "session.dir", path: "/s/sessions" },
  { key: "socket.path", path: "/s/pomtreed.sock" },
];
const safeFacts: SafetyBootFacts = {
  checkRunnerWired: false,
  agentListen: plan("gateway", "172.17.0.1"),
  bridgeGateway: "172.17.0.1",
  loadDirs: { templates: "/s/templates", extensions: "/s/extensions" },
  agentWritable: writable,
};

const A = (e: string) => e.includes("agent.egressProxyImage is not set");
const B = (e: string) => e.includes("agent.untemplatedEgress is not set");
const C = (e: string) => e.includes("extensions.approval is not set");
const D = (e: string) => e.includes("agent.listen binds");
const E = (e: string) => e.includes("merge.check is set");
const F = (e: string) => e.includes("which agent containers can write");

const bad = {
  "agent.egressProxyImage": "",
  "agent.untemplatedEgress": "",
  "extensions.approval": "",
  "merge.check": "make test",
};
const badFacts: SafetyBootFacts = { ...safeFacts, agentListen: plan("explicit", "0.0.0.0"), bridgeGateway: undefined };

test("buildSafetyBootFacts lays the defaults out under the state dir, and explicit dirs override them", () => {
  const root = realpathLoose(mkdtempSync(join(tmpdir(), "safety-facts-")));
  try {
    const base = {
      stateDir: root,
      templatesDir: "",
      sessionDir: "",
      envCacheDir: "",
      extensionsDir: join(root, "extensions"),
      socketPath: join(root, "pomtreed.sock"),
      agentListen: plan("gateway", "172.17.0.1"),
      bridgeGateway: "172.17.0.1",
    };
    assert.deepEqual(buildSafetyBootFacts(base), {
      checkRunnerWired: false,
      agentListen: base.agentListen,
      bridgeGateway: "172.17.0.1",
      loadDirs: { templates: join(root, "templates"), extensions: join(root, "extensions") },
      agentWritable: [
        { key: "state.dir", path: join(root, "workspaces") },
        { key: "state.dir", path: join(root, "agents") },
        { key: "session.dir", path: join(root, "sessions") },
        { key: "envCache.dir", path: join(root, "env-cache") },
        { key: "socket.path", path: join(root, "pomtreed.sock") },
      ],
    });
    const over = buildSafetyBootFacts({
      ...base,
      templatesDir: join(root, "t2"),
      sessionDir: join(root, "s2"),
      envCacheDir: join(root, "e2"),
    });
    assert.equal(over.loadDirs.templates, join(root, "t2"));
    assert.deepEqual(
      over.agentWritable.map((w) => w.path),
      [join(root, "workspaces"), join(root, "agents"), join(root, "s2"), join(root, "e2"), join(root, "pomtreed.sock")],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fully safe config returns no errors", () => {
  assert.deepEqual(safetyBootErrors(safeCfg, safeFacts), []);
});

test("each violation alone returns exactly its one message", () => {
  const cases: [string, Parameters<typeof safetyBootErrors>[0], SafetyBootFacts, (e: string) => boolean][] = [
    ["a", { ...safeCfg, "agent.egressProxyImage": "" }, safeFacts, A],
    ["b", { ...safeCfg, "agent.untemplatedEgress": "" }, safeFacts, B],
    ["c", { ...safeCfg, "extensions.approval": "" }, safeFacts, C],
    ["d", safeCfg, badFacts, D],
    ["e", { ...safeCfg, "merge.check": "make test" }, safeFacts, E],
  ];
  for (const [name, cfg, facts, is] of cases) {
    const errs = safetyBootErrors(cfg, facts);
    assert.equal(errs.length, 1, name);
    assert.ok(is(errs[0] as string), name);
    assert.ok((errs[0] as string).startsWith("pomtreed: refusing to start: "), name);
  }
});

test("(b) message text and env names come from the registry", () => {
  const [e] = safetyBootErrors({ ...safeCfg, "agent.untemplatedEgress": "" }, safeFacts);
  assert.equal(envName("agent.untemplatedEgress"), "POMTREED_AGENT_UNTEMPLATED_EGRESS");
  assert.equal(
    e,
    "pomtreed: refusing to start: agent.untemplatedEgress is not set: a spawn that names no template runs the built-in code template, and its network reach is the operator's choice. Set POMTREED_AGENT_UNTEMPLATED_EGRESS=none (no network beyond the daemon relay) or POMTREED_AGENT_UNTEMPLATED_EGRESS=registry (the package registries only)",
  );
});

test("(a) (c) (e) messages name their env keys", () => {
  assert.match(
    safetyBootErrors({ ...safeCfg, "agent.egressProxyImage": "" }, safeFacts)[0] as string,
    /Set POMTREED_AGENT_EGRESS_PROXY_IMAGE to a digest-pinned image/,
  );
  const c = safetyBootErrors({ ...safeCfg, "extensions.approval": "" }, safeFacts)[0] as string;
  for (const s of ["POMTREED_EXTENSIONS_APPROVAL=all", "POMTREED_EXTENSIONS_APPROVAL=none", "comma list"]) assert.ok(c.includes(s), s);
  assert.match(safetyBootErrors({ ...safeCfg, "merge.check": "x" }, safeFacts)[0] as string, /Unset POMTREED_MERGE_CHECK /);
});

test("all five violations together return five messages in order", () => {
  const errs = safetyBootErrors({ ...bad, "listen.allowNonloopback": false }, badFacts);
  assert.equal(errs.length, 5);
  assert.deepEqual(
    [A, B, C, D, E].map((is, i) => is(errs[i] as string)),
    [true, true, true, true, true],
  );
});

test("(d) unset-listen plans, off, and explicit loopback pass", () => {
  for (const p of [
    plan("loopback", "127.0.0.1"),
    plan("gateway", "172.17.0.1"),
    plan("off", ""),
    plan("explicit", "127.0.0.1"),
    plan("explicit", "[::1]"),
    plan("explicit", "localhost"),
  ])
    assert.deepEqual(safetyBootErrors(safeCfg, { ...safeFacts, agentListen: p }), [], `${p.mode} ${p.host}`);
});

test("(d) an explicit host equal to the detected gateway passes", () => {
  assert.deepEqual(safetyBootErrors(safeCfg, { ...safeFacts, agentListen: plan("explicit", "172.17.0.1") }), []);
});

test("(d) explicit 0.0.0.0 and :: refuse, naming the gateway when detected", () => {
  for (const host of ["0.0.0.0", "::"]) {
    const [e, ...rest] = safetyBootErrors(safeCfg, { ...safeFacts, agentListen: plan("explicit", host) });
    assert.equal(rest.length, 0);
    assert.ok(D(e as string));
    assert.ok((e as string).includes(`binds ${host}, which is neither loopback nor the docker bridge gateway (172.17.0.1)`));
  }
});

test("(d) an explicit non-gateway host with no detected gateway refuses with 'not detected'", () => {
  const [e] = safetyBootErrors(safeCfg, { ...safeFacts, agentListen: plan("explicit", "192.168.1.5"), bridgeGateway: undefined });
  assert.ok((e as string).includes("(not detected)"));
  assert.ok(
    (e as string).includes(
      "Set POMTREED_AGENT_LISTEN to a loopback or bridge-gateway address (or leave it unset), or set POMTREED_LISTEN_ALLOW_NONLOOPBACK=1 to accept this",
    ),
  );
});

test("(d) listen.allowNonloopback accepts any explicit host", () => {
  assert.deepEqual(safetyBootErrors({ ...safeCfg, "listen.allowNonloopback": true }, badFacts), []);
});

test("(e) whitespace-only merge.check passes; a wired runner passes a set check", () => {
  assert.deepEqual(safetyBootErrors({ ...safeCfg, "merge.check": "  \t " }, safeFacts), []);
  assert.deepEqual(safetyBootErrors({ ...safeCfg, "merge.check": "make test" }, { ...safeFacts, checkRunnerWired: true }), []);
});

test("(b) none and registry both pass; (c) none, all and a list pass", () => {
  for (const v of ["none", "registry"]) assert.deepEqual(safetyBootErrors({ ...safeCfg, "agent.untemplatedEgress": v }, safeFacts), [], v);
  for (const v of ["none", "all", "a,b"]) assert.deepEqual(safetyBootErrors({ ...safeCfg, "extensions.approval": v }, safeFacts), [], v);
  assert.equal(safetyBootErrors({ ...safeCfg, "extensions.approval": "   " }, safeFacts).length, 1);
});

test("(f) message pin: names the dir, the overlapped path, its key and the action", () => {
  const [e, ...rest] = safetyBootErrors(safeCfg, { ...safeFacts, loadDirs: { templates: "/s/workspaces/t", extensions: "/s/extensions" } });
  assert.equal(rest.length, 0);
  assert.equal(
    e,
    "pomtreed: refusing to start: templates.dir (/s/workspaces/t) overlaps /s/workspaces, which agent containers can write (placed by state.dir): an agent could change what pomtreed later loads from templates.dir. Set POMTREED_TEMPLATES_DIR to a directory that neither contains, equals nor lies inside any agent-writable path (the default <state.dir>/templates is safe), or move state.dir",
  );
});

test("(f) each overlap direction refuses for both dirs; unrelated and sibling-prefix paths pass", () => {
  for (const [dirKey, loadKey] of [
    ["templates.dir", "templates"],
    ["extensions.dir", "extensions"],
  ] as const) {
    const withDir = (p: string): SafetyBootFacts => ({ ...safeFacts, loadDirs: { ...safeFacts.loadDirs, [loadKey]: p } });
    for (const [what, p] of [
      ["inside", "/s/sessions/x/y"],
      ["equal", "/s/sessions"],
      ["containing", "/s"],
      ["containing the root", "/"],
    ] as const) {
      const errs = safetyBootErrors(safeCfg, withDir(p));
      assert.equal(errs.length, 1, `${dirKey} ${what}`);
      assert.ok(F(errs[0] as string) && (errs[0] as string).includes(`${dirKey} (${p})`), `${dirKey} ${what}`);
    }
    // negative controls: a sibling that merely shares a name prefix, and a dir elsewhere
    for (const p of ["/s/sessions-extra", "/s/workspaces2/t", "/opt/pomtree/t"]) assert.deepEqual(safetyBootErrors(safeCfg, withDir(p)), [], `${dirKey} ${p}`);
  }
});

test("(f) an unset (empty) dir is skipped; both dirs violating give two lines in order", () => {
  assert.deepEqual(safetyBootErrors(safeCfg, { ...safeFacts, loadDirs: { templates: "", extensions: "" } }), []);
  const errs = safetyBootErrors(safeCfg, { ...safeFacts, loadDirs: { templates: "/s/sessions", extensions: "/s/workspaces" } });
  assert.equal(errs.length, 2);
  assert.ok((errs[0] as string).includes("templates.dir") && (errs[1] as string).includes("extensions.dir"));
});

test("all six violations together return six messages in order", () => {
  const errs = safetyBootErrors(
    { ...bad, "listen.allowNonloopback": false },
    { ...badFacts, loadDirs: { templates: "/s/sessions", extensions: "/s/extensions" } },
  );
  assert.equal(errs.length, 6);
  assert.deepEqual(
    [A, B, C, D, E, F].map((is, i) => is(errs[i] as string)),
    [true, true, true, true, true, true],
  );
});

test("(f) realpathLoose follows a symlinked dir, so a symlink into a writable path is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "safety-boot-link-"));
  try {
    const sessions = join(root, "sessions");
    mkdirSync(sessions);
    symlinkSync(sessions, join(root, "link"));
    const real = realpathLoose(sessions);
    // existing symlink, and a not-yet-existing child beneath it
    for (const p of [join(root, "link"), join(root, "link", "not", "yet")]) {
      const facts: SafetyBootFacts = {
        ...safeFacts,
        loadDirs: { templates: realpathLoose(p), extensions: "" },
        agentWritable: [{ key: "session.dir", path: real }],
      };
      assert.equal(safetyBootErrors(safeCfg, facts).length, 1, p);
    }
    // negative control: a plain sibling dir does not resolve into the writable path
    mkdirSync(join(root, "plain"));
    assert.deepEqual(
      safetyBootErrors(safeCfg, {
        ...safeFacts,
        loadDirs: { templates: realpathLoose(join(root, "plain")), extensions: "" },
        agentWritable: [{ key: "session.dir", path: real }],
      }),
      [],
    );
    assert.equal(realpathLoose(join(root, "nope", "x")), join(realpathLoose(root), "nope", "x"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("untemplated egress none warns with cause and action; registry and unset do not", () => {
  const w = untemplatedEgressNoneWarning("none");
  for (const s of ["agent.untemplatedEgress is none", "Connection error.", "no network", "POMTREED_AGENT_UNTEMPLATED_EGRESS=registry"])
    assert.ok(w.includes(s), s);
  assert.equal(untemplatedEgressNoneWarning("registry"), "");
  assert.equal(untemplatedEgressNoneWarning(""), "");
});
