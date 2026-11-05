## What and why

<!-- One or two sentences: what this changes and why. Link the issue if there is one. -->

## Scope

- [ ] This is one logical change, and each commit builds and passes the checks on its own.
- [ ] No drive-by changes: no unrelated cleanup, reformatting or tool churn.
- [ ] Docs are updated in the same change (or nothing documented changed); known gaps have an issue.
- [ ] No new runtime dependency or build step (or it was agreed in an issue, linked above).

## Checks

<!-- Which did you run? Say what skipped and why; a skip is not a pass. -->

- [ ] `pnpm check:lite`
- [ ] Docker-gated suites (`pnpm check`, or the packages you ran, one at a time):

## Test that fails without this change

<!-- For a bug fix or behavior change: name the test. For docs or refactors: say "none, no behavior change". -->

## Notes for reviewers

<!-- Caveats, open questions, behavior you chose not to change, anything that skipped. Scrub tokens, keys and personal paths from any pasted output. -->
