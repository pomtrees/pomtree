import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_REGISTRY } from "@pomtree/core";
import { HANDLED_TEMPLATE_KEYS } from "@pomtree/template-dir";
import { TEMPLATE_ANSWER_FIELDS } from "./repo.ts";
import { TEMPLATE_TOPIC_FIELDS, TOPIC_CONFIG_PATHS, deriveQuestions, renderQuestionsText, requiredPaths, safetyPaths } from "./questions.ts";
import { REPO_TOPIC_IDS, repoTopics } from "./steps.ts";

const facts = { nodeRange: ">=24", pnpmVersion: "10.19.0", minGit: "2.38.0", defaultImage: "pomtree/agent:dev" };
const questions = () => deriveQuestions({ stateDir: "/home/u/.pomtreed", repoDir: "/repo", facts });

test("the derived required set is exactly model.baseUrl, pi.provider, model.upstreamKey", () => {
  assert.deepEqual(
    [...requiredPaths()].sort(),
    ["model.baseUrl", "model.upstreamKey", "pi.provider"],
    "the set of keys the daemon refuses to start without changed: update the onboarding docs and answers.ts expectations, then this test",
  );
});

test("the derived safety set is exactly agent.egressProxyImage, agent.untemplatedEgress, extensions.approval", () => {
  assert.deepEqual(
    [...safetyPaths()].sort(),
    ["agent.egressProxyImage", "agent.untemplatedEgress", "extensions.approval"],
    "the set of forced safety decisions changed: update the guardrails in steps.ts and the onboarding docs, then this test",
  );
});

test("required and safety questions come from the registry docs; the key is asked as a file path, safety has no default", () => {
  const qs = questions();
  const key = qs.find((q) => q.id === "model.upstreamKey");
  assert.equal(key?.sensitive, true);
  assert.match(key?.prompt ?? "", /absolute path of a file/);
  assert.match(key?.prompt ?? "", /mode 0600/);
  for (const q of qs.filter((x) => x.kind === "safety")) {
    assert.equal(q.default, null);
    assert.match(q.prompt, /no default/);
    assert.ok(q.prompt.startsWith(CONFIG_REGISTRY.byPath.get(q.id)?.doc ?? "?"));
  }
  assert.deepEqual(
    qs.filter((q) => q.kind === "required" || q.kind === "safety").map((q) => q.part),
    Array(7).fill("machine"),
  );
});

test("question ids are unique, and the setup choices are present", () => {
  const ids = questions().map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["output", "service", "state.dir", "repo.dir"]) assert.ok(ids.includes(id), id);
});

test("every mapped topic path exists in the registry, and every config topic has at least one", () => {
  for (const [topic, paths] of Object.entries(TOPIC_CONFIG_PATHS))
    for (const p of paths ?? []) assert.ok(CONFIG_REGISTRY.byPath.has(p), `${topic}: ${p} is not a registry key; update TOPIC_CONFIG_PATHS`);
  for (const t of repoTopics(facts).filter((x) => x.output === "config"))
    assert.ok((TOPIC_CONFIG_PATHS[t.id] ?? []).length > 0, `topic ${t.id} has output config but no mapped registry path in TOPIC_CONFIG_PATHS`);
});

test("every template topic has fields, and every offered template field is one the template store handles (contract drift)", () => {
  for (const t of repoTopics(facts).filter((x) => x.output === "template"))
    assert.ok((TEMPLATE_TOPIC_FIELDS[t.id] ?? []).length > 0, `template topic ${t.id} asks no field`);
  const offered = new Set([...Object.values(TEMPLATE_TOPIC_FIELDS).flat(), ...TEMPLATE_ANSWER_FIELDS]);
  for (const f of offered)
    assert.ok((HANDLED_TEMPLATE_KEYS as readonly string[]).includes(f as string), `${f} is offered by init but not handled by the template store`);
  // negative control: the check can fail
  assert.ok(!(HANDLED_TEMPLATE_KEYS as readonly string[]).includes("notATemplateKey"));
});

test("every repo topic is covered by a question; info topics carry their gap tag; part and topic are set on repo questions", () => {
  const qs = questions();
  for (const id of REPO_TOPIC_IDS)
    assert.ok(
      qs.some((q) => q.topic === id),
      `no question for topic ${id}`,
    );
  for (const id of ["repo-toolchain", "secrets"] as const) {
    const q = qs.find((x) => x.id === id);
    assert.equal(q?.kind, "info");
    assert.match(q?.gap ?? "", /^onboard-repo-/);
  }
  assert.ok(qs.filter((q) => q.topic !== undefined).every((q) => q.part === "repo"));
  assert.ok(qs.some((q) => q.id === "repo.templates[].egress" && !q.choices?.includes("audited-public")));
  assert.ok(qs.some((q) => q.id === "repo.schedules[].cron"));
});

test("the text form lists every question", () => {
  const text = renderQuestionsText(questions()).join("\n");
  for (const q of questions()) assert.ok(text.includes(q.id));
});
