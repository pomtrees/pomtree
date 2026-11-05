# CLAUDE.md (pomtree)

Rules for AI agents working in this repo. The standards for any change (what a change must hold up under, its shape, docs in the same change, history and review) are in [`CONTRIBUTING.md`](CONTRIBUTING.md) and bind agents exactly as they bind people; they are not restated here. [`SPEC.md`](SPEC.md) is the design.

## Working rules

- **Claim versus proof.** A report that tests pass is a claim; verify by running the check, opening the file or reading the diff.
- **Skips are findings.** If Docker, a local `pi`, an agent image or another dependency is missing, the gated tests skip with a printed reason. Report the skip; never fake a pass or delete a test.
- **Secrets.** Never print, echo or log tokens, keys or credentials. Test fixtures are offline and scrubbed of secrets and machine-specific paths; temporary databases and git repos for tests live under `os.tmpdir()` and are cleaned up by the suite.
- **Git.** Stage files by explicit path, never `git add -A` or a whole directory; rebase, never merge; never `git reset --hard`.
- **Spend and side effects.** Anything that costs money or leaves the machine (live model API calls, publishing) needs the maintainer's explicit go-ahead.
- **Dependencies.** No new npm dependency or build step without discussion; the stack is `node:sqlite`, `node:test` and `tsc`, run directly from source.

## Checks

- `pnpm check:lite` is the gate: Biome format check, Biome lint, TypeScript typecheck and every package's tests with Docker-gated suites skipped. `pnpm check` also runs the Docker-gated suites.
- Per package: `pnpm exec biome format <paths>`, `pnpm exec biome lint <paths>`, `npx tsc -p packages/<name>` and `pnpm --filter @pomtree/<name> test`. Zero lint errors are allowed.
- Run Docker, end-to-end and other heavy suites one at a time. Reproduce a suspected flake several times alone before calling it flaky.
- A change to the configuration keys or their exclusions runs `pnpm gen:config` in the same commit; a change to the onboarding steps runs `pnpm gen:getting-started`.

## Code rules specific to this repo

- Logic worth testing lives in pure modules with no fs, socket, or Docker coupling; sockets, processes, and Docker stay in thin shells. `pomtreed` handlers are pure functions over a `Daemon` that takes every port by injection.
- Design rules from `SPEC.md` bind all code: stable opaque ids, host id and generation on every record, idempotency keys on every mutating call, checkpoints hold ids and hashes (never local paths), no state in daemon memory, `pomtree` talks only to the daemon API.
- `packages/core` is the contract every other package builds against: change it deliberately and on its own, never in passing. A new port ships with a fake in `@pomtree/testing` that scripts results and records calls; do not write per-package copies.
- Target only the latest Pi, the version pinned in `packages/agent-image/scripts/build.ts`. No fallbacks, version sniffing or "older Pi" code paths or comments; when the pin is bumped, delete the code that handled the previous version.
- Any browsing or fetching code uses the same fetch identity as the general configuration (`workflow.fetch.userAgent`; in browser captures it is appended to Chromium's own User-Agent), never its own string.
- Before the first release there are no legacy aliases, renamed-key shims, compatibility readers or legacy version numbers: use the canonical names only. Public contract versions (messaging API version, extension `apiVersion`) are not legacy history.
- Vocabulary: credential issuance is "issue", never a word starting with "mint" in any case. `packages/e2e/src/vocabulary.test.ts` fails any tracked file under `packages/` or `examples/` that uses it, so a new identifier, comment or error message with it turns the suite red. Money added to the root is a "top-up" (`docs/economy.md`, section 10).

## Deferred work

Never leave a half-implementation: finish it, or defer it explicitly. Known gaps are tracked as [GitHub issues](https://github.com/pomtrees/pomtree/issues), labelled when filed. Open an issue describing the gap and leave a `// TODO(tag)` at the exact spot in the code, with the current behavior noted and the tag named in the issue. Reuse an existing tag when one fits; tags are unique across the repository. A newly created extension tag is prefixed with the extension's name (for example `discord-...`).
