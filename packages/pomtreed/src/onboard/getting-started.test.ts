import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_DEFAULTS, EXIT_CAUSE_WORDING, START_FAILURE_CAUSE } from "@pomtree/core";
import { defaultSetupFacts } from "./facts.ts";
import {
  GETTING_STARTED_BEGIN,
  GETTING_STARTED_END,
  gettingStartedText,
  guardrailsText,
  repoTopicItemsText,
  spliceGenerated,
  troubleshootingText,
} from "./getting-started.ts";
import { GUARDRAILS, onboardingSteps, REPO_TOPIC_IDS, repoTopics, troubleshooting } from "./steps.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const REPO_INTERVIEW_MD = join(".agents", "skills", "pomtree-onboarding", "references", "repo-interview.md");
const GUARDRAILS_MD = join(".agents", "skills", "pomtree-onboarding", "references", "guardrails.md");
const facts = defaultSetupFacts(read("package.json"));
const steps = onboardingSteps(facts);
const topics = repoTopics(facts);
const trouble = { groups: troubleshooting(facts), glossary: { causes: EXIT_CAUSE_WORDING, startFailures: START_FAILURE_CAUSE } };
const splice = (doc: string, text: string) => spliceGenerated(doc, text, GETTING_STARTED_BEGIN, GETTING_STARTED_END);

test("GETTING_STARTED.md matches steps.ts (regenerate: node packages/pomtreed/scripts/gen-getting-started.ts)", () => {
  const doc = read("GETTING_STARTED.md");
  assert.equal(doc, splice(doc, gettingStartedText(steps, GUARDRAILS, topics, trouble)));
});

test("the drift check can fail: a mutated step title renders differently from the checked-in GETTING_STARTED.md", () => {
  const doc = read("GETTING_STARTED.md");
  const mutated = steps.map((s, i) => (i === 0 ? { ...s, title: `${s.title} (changed)` } : s));
  assert.notEqual(doc, splice(doc, gettingStartedText(mutated, GUARDRAILS, topics, trouble)));
});

test("the skill's references/guardrails.md matches GUARDRAILS (regenerate: node packages/pomtreed/scripts/gen-getting-started.ts)", () => {
  const doc = read(GUARDRAILS_MD);
  assert.equal(doc, splice(doc, guardrailsText(GUARDRAILS)));
});

test("the skill's references/repo-interview.md matches the repo topics (regenerate: node packages/pomtreed/scripts/gen-getting-started.ts)", () => {
  const doc = read(REPO_INTERVIEW_MD);
  assert.equal(doc, splice(doc, repoTopicItemsText(topics)));
  const section = doc.slice(doc.indexOf(GETTING_STARTED_BEGIN), doc.indexOf(GETTING_STARTED_END));
  assert.match(section, /Propose, never apply silently: Give agents no secrets\./);
  assert.match(section, /Not supported yet\./);
  assert.ok(gettingStartedText(steps, GUARDRAILS, topics, trouble).includes(repoTopicItemsText(topics)), "GETTING_STARTED renders the same blocks");
});

test("the generated text flags root, network and confirm commands and ends with the guardrails", () => {
  const text = gettingStartedText(steps, GUARDRAILS, topics, trouble);
  assert.match(text, /sudo ufw allow in on docker0 {3}# run this yourself as root/);
  assert.match(text, /pnpm install {3}# needs network; ask before running/);
  assert.match(text, /^## 1\. Install Node\.js/m);
  const at = (h: string) => text.indexOf(h);
  assert.ok(at("## 15.") < at("## Configure for your repo") && at("## Configure for your repo") < at("## Guardrails for agents"));
});

test("the splice refuses a document without ordered markers", () => {
  assert.throws(() => splice("no markers", "x"), /needs/);
  assert.throws(() => splice(`${GETTING_STARTED_END}\n${GETTING_STARTED_BEGIN}`, "x"), /needs/);
});

test("the splice replaces only the section between the markers", () => {
  const doc = `intro\n${GETTING_STARTED_BEGIN}\n\nold\n${GETTING_STARTED_END}\noutro\n`;
  assert.equal(splice(doc, "new"), `intro\n${GETTING_STARTED_BEGIN}\n\nnew\n${GETTING_STARTED_END}\noutro\n`);
});

test("the repo section lists every topic in order, labels proposals and says so for an unsupported topic", () => {
  assert.deepEqual(
    topics.map((t) => t.id),
    [...REPO_TOPIC_IDS],
  );
  const text = gettingStartedText(steps, GUARDRAILS, topics, trouble);
  assert.match(text, /### 1\. The repository and its toolchain/);
  assert.match(text, /Propose, never apply silently: Give agents no secrets\./);
  assert.match(text, /Not supported yet\./);
  for (const t of topics) assert.equal(t.output === "none", t.gap !== undefined, `${t.id}: a gap iff no artifact exists`);
  assert.ok(!/Not supported yet/.test(text.slice(text.indexOf("### 2."), text.indexOf("### 4."))), "supported topics carry no gap note");
});

test("no annotation repeats on a command line (each flag appears once)", () => {
  const text = gettingStartedText(steps, GUARDRAILS, topics, trouble);
  for (const line of text.split("\n").filter((l) => l.includes("   # "))) {
    const tags = line.slice(line.indexOf("   # ") + 5).split("; ");
    assert.equal(new Set(tags).size, tags.length, line);
    for (const flag of ["ask before running", "needs network", "run this yourself as root"])
      assert.ok(line.split(flag).length <= 2, `${flag} repeats in: ${line}`);
  }
});

test("the configure step documents the repo part of the answers file and preflight's egress image flag", () => {
  const text = gettingStartedText(steps, GUARDRAILS, topics, trouble);
  for (const w of ['"repo"', '"templates"', '"schedules"', '"systemPrompt"', '"cron"']) assert.ok(text.includes(w), w);
});

test("the glossary names every exit cause and start-failure kind of the code tables", () => {
  const text = gettingStartedText(steps, GUARDRAILS, topics, trouble);
  for (const k of Object.keys(EXIT_CAUSE_WORDING)) assert.ok(text.includes(`| \`${k}\` |`), `cause ${k}`);
  for (const [k, v] of Object.entries(START_FAILURE_CAUSE)) assert.ok(text.includes(`| \`${k}\` | \`${v}\` |`), `start failure ${k}`);
});

test("the glossary follows the tables it is given (negative control: a new cause appears, a missing one does not)", () => {
  const extra = { ...trouble, glossary: { causes: { brand_new_cause: "x" } as never, startFailures: {} } };
  const text = gettingStartedText(steps, GUARDRAILS, topics, extra);
  assert.ok(text.includes("| `brand_new_cause` | x |"));
  assert.ok(!text.includes("| `oom_killed` |"));
});

test("every troubleshooting step exists and is linked; an unknown step is refused", () => {
  const ids = steps.map((s) => s.id);
  for (const g of trouble.groups) for (const e of g.entries) if (e.step !== undefined) assert.ok(ids.includes(e.step), `${g.id}/${e.id}`);
  const bad = [{ id: "g", title: "G", entries: [{ id: "e", symptom: "s", fix: "f", step: "nope" as never }] }];
  assert.throws(() => troubleshootingText(bad, steps, trouble.glossary), /unknown step nope/);
  assert.match(gettingStartedText(steps, GUARDRAILS, topics, trouble), /\[step 7, Start the Docker daemon\]\(#7-start-the-docker-daemon\)/);
});

test("troubleshooting sits between the repo section and the guardrails, quotes the grace default from the registry and names no key", () => {
  const text = gettingStartedText(steps, GUARDRAILS, topics, trouble);
  const at = (h: string) => text.indexOf(h);
  assert.ok(at("## Configure for your repo") < at("## Troubleshooting") && at("## Troubleshooting") < at("## Guardrails for agents"));
  assert.ok(text.includes(`reaped-folder grace period is ${CONFIG_DEFAULTS["folder.reapedGraceMs"]} ms`));
  assert.ok(!text.includes("folder.reapedGraceMs"));
});

test("the timed_out entry quotes the registry's session default in plain words", () => {
  const text = gettingStartedText(steps, GUARDRAILS, topics, trouble);
  assert.match(text, /gets the default of 4 h /);
  assert.ok(!text.includes("session.defaultMs"));
  assert.equal(CONFIG_DEFAULTS["session.defaultMs"], 4 * 3_600_000);
});
