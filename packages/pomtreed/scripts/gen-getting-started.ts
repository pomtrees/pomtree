// Regenerates the sections compiled from packages/pomtreed/src/onboard/steps.ts: GETTING_STARTED.md (between its BEGIN/END GENERATED markers)
// and the skill's references/guardrails.md and references/repo-interview.md. Run `node packages/pomtreed/scripts/gen-getting-started.ts`. The
// regenerate-and-compare test (src/onboard/getting-started.test.ts) fails until the checked-in files match; a file whose bytes already
// match is left untouched, so a second run changes nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CAUSE_WORDING, START_FAILURE_CAUSE } from "@pomtree/core";
import { defaultSetupFacts } from "../src/onboard/facts.ts";
import {
  GETTING_STARTED_BEGIN,
  GETTING_STARTED_END,
  gettingStartedText,
  guardrailsText,
  repoTopicItemsText,
  spliceGenerated,
} from "../src/onboard/getting-started.ts";
import { GUARDRAILS, onboardingSteps, repoTopics, troubleshooting } from "../src/onboard/steps.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const write = (path: string, text: string): void => {
  let prior: string | null = null;
  try {
    prior = readFileSync(path, "utf8");
  } catch {}
  if (prior === text) {
    console.log(`unchanged ${path}`);
    return;
  }
  writeFileSync(path, text);
  console.log(`wrote ${path}`);
};

const facts = defaultSetupFacts(readFileSync(join(root, "package.json"), "utf8"));
const steps = onboardingSteps(facts);
for (const [rel, text] of [
  [
    "GETTING_STARTED.md",
    gettingStartedText(steps, GUARDRAILS, repoTopics(facts), {
      groups: troubleshooting(facts),
      glossary: { causes: EXIT_CAUSE_WORDING, startFailures: START_FAILURE_CAUSE },
    }),
  ],
  [join(".agents", "skills", "pomtree-onboarding", "references", "guardrails.md"), guardrailsText(GUARDRAILS)],
  [join(".agents", "skills", "pomtree-onboarding", "references", "repo-interview.md"), repoTopicItemsText(repoTopics(facts))],
] as const) {
  const path = join(root, rel);
  write(path, spliceGenerated(readFileSync(path, "utf8"), text, GETTING_STARTED_BEGIN, GETTING_STARTED_END));
}
