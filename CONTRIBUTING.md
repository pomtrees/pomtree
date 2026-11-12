# Contributing to pomtree

This guide explains what the project values in a change, why, and how to get one accepted. Read it before your first pull request; reviewers link to its sections when a change falls short. The design lives in [`SPEC.md`](SPEC.md), setup and usage in [`README.md`](README.md), and a short rules file for AI agents working in the repository in [`CLAUDE.md`](CLAUDE.md).

pomtree is a pre-release project with a single maintainer. Review is best-effort and the bar is deliberately high: every change is read closely, and, from the first release onward, the commit history is kept so that a later reader can see why each change was made. Most of what follows exists to make that reading cheap.

## What we value and why

A change is accepted when it holds up under seven standards. They exist because one person reviews everything and later readers depend on the history being trustworthy, so a change has to be easy to check and safe to keep. An accepted change is **correct** across its whole lifecycle, error and cancellation cases included, and breaks nothing that already works. It is **concise**: the smallest change that does the job, reusing what exists rather than reimplementing it. It has **coverage**: its behavior is tested, with testable logic in pure modules (no file, socket, process or Docker access) and only thin wrappers around the parts that touch those. It is **consistent** with existing style and idioms. It stays in **scope**. It is **observable**: traceable, and verifiable in tests through a fake (a stand-in implementation that returns scripted results and records how it was called). And it respects **privacy**: no secrets, tokens, keys or machine-specific paths in code, fixtures or logs, and fixtures that work offline.

Review separates claim from proof. "Tests pass" in a description is a claim that the reviewer checks; equally, a review comment asserting a bug should point to the line or a reproduction.

Contributions prepared with AI assistance are held to exactly the same bar, because review checks the change, not how it was produced; you are accountable for every line you submit and should understand it well enough to defend it.

## The shape of a good change

Most of the standards above can only be checked on a change that is small and focused, so the shape of a change is what reviewers look at first. Some of the rules below are conventional; the ones that go further than most projects say why.

**Small and semi-atomic.** A pull request contains one logical change, and each commit in it is semi-atomic: one coherent step that builds and passes the checks on its own, even if it is not useful to an end user until the steps after it land. Several small pull requests are far easier to accept than one large one, because each can be read in one sitting, reverted alone, and searched with `git bisect` (which finds the commit that introduced a bug by testing commits in between, and only works if each one builds) [1, 2]. If a feature needs groundwork, such as a refactor, a new interface or tests for existing code, send the groundwork first. The cost is more round trips and some planning on your side; we accept it because large mixed changes are where reviews stall and bugs slip through. A reviewer may ask you to split a pull request for size alone, which is not a judgment on the code.

**No drive-by changes.** Do not reformat, rename, tidy or fix anything unrelated to the change, and do not commit incidental churn from tools, such as a lockfile rewrite you did not intend. Remove only what your own change left unused. This is stricter than many projects, and leaving a typo you noticed can feel wasteful, but every unrelated line costs the reviewer attention and hides the real change in the diff. Send what you noticed as an issue or its own small pull request.

**Docs in the same change.** If a change alters behavior, configuration or a documented fact, the doc update belongs in the same commit. Otherwise the history contains a state where the docs were wrong. The cost is that a small code change can carry a larger doc diff; a reviewer will help find the right place if you are unsure. A change to the configuration keys also runs `pnpm gen:config` in the same commit, which regenerates `docs/configuration.md`.

**One fact in one place.** Each fact lives in one document and others link to it. Docs carry no volatile numbers such as test counts, point to code by file or symbol name rather than line number, and are written one line per paragraph with no hard wrapping.

**Failure paths that name cause and action.** Every new error says what went wrong and what to do about it, reaches both the caller and the operator, and has a test per class of failure, as the safety refusals in [`docs/safety-decisions.md`](docs/safety-decisions.md) do.

**One fetch identity.** Browsing or fetching code uses the same fetch identity as the general configuration (`workflow.fetch.userAgent`; in browser captures it is appended to Chromium's own User-Agent), never its own string. Reviewers check this for any change that fetches.

**Deferred work is marked, not hidden.** Known gaps are tracked as [GitHub issues](https://github.com/pomtrees/pomtree/issues), labelled when filed. Open an issue describing the gap, and leave a `// TODO(tag)` at the exact spot in the code describing the current behavior, with the tag named in the issue. Reuse an existing tag when one fits; tags are unique across the repository.

**No new runtime dependency or build step without discussion.** The stack is `node:sqlite`, `node:test` and `tsc`, run directly from source. For a project with one maintainer, a dependency is a permanent maintenance and supply-chain cost, so the default is to write the small thing yourself. Open an issue first; a strong case can change the answer, which is why this is a discussion and not a ban.

A few conventions follow from the design. A new port (one of the interfaces in `packages/core` that adapters such as the store or sandbox implement) ships with a fake in `@pomtree/testing`, so every package tests against the same one. A new sandbox backend follows [`docs/sandbox-backends.md`](docs/sandbox-backends.md) and passes `pnpm conformance:sandbox`. `packages/core` is the contract every other package builds against, so change it deliberately and on its own, never in passing. Before the first release there are no compatibility aliases or shims: nobody depends on the old names yet, and carrying them would only add code to maintain. Likewise only the version of Pi (the agent harness that runs inside each sandbox) pinned in `packages/agent-image/scripts/build.ts` is supported, which keeps version branches out of the code.

## Getting set up and running the checks

Prerequisites and install are in [`GETTING_STARTED.md`](GETTING_STARTED.md), and running a local daemon is in [`docs/operating.md`](docs/operating.md#try-it-locally). Run `pnpm install` once at the repository root.

The gate for every pull request is `pnpm check:lite`. It runs the Biome format check, Biome lint, the TypeScript typecheck and every package's tests, with the Docker-gated suites (those that need a Docker daemon) skipped. `pnpm check` does the same with those suites enabled and needs a reachable Docker daemon. `pnpm format` fixes formatting. While working on one package, `pnpm --filter @pomtree/<name> test` runs its tests and `npx tsc -p packages/<name>` typechecks it. Zero lint errors are allowed. CI runs the same checks as separate jobs ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

A test that cannot run in your environment (no Docker, no local `pi`, no agent image, or too old a git) skips and prints why. A skip is not a pass; say in the pull request what skipped. Run Docker-gated suites one at a time, never two runs on the same host and never beside a running daemon, because suites and daemons running together on one host can interfere with each other's containers and networks. The end-to-end (`e2e`) package runs its files concurrently by default; to run them one at a time, run `PTREE_DOCKER_TESTS=1 node --test --test-concurrency=1 --test-timeout=120000 'src/**/*.test.ts'` from `packages/e2e`. Tests that call a live model spend real money and are never required of contributors.

**Test runs are memory-capped.** `pnpm test`, `test:lite`, `test:full` and `test:examples` run under `scripts/run-capped.sh`, so a runaway test is killed instead of exhausting the machine (two node processes once reached about 43 GB each and the kernel OOM-killed the whole session). The script runs the command in its own process group inside a systemd user scope with `MemoryMax` and `MemorySwapMax=0`, plus a wall-clock `timeout`; on a timeout it kills the whole group and confirms it stopped, and it prints the cause and the action for a cap kill (exit 137) or a timeout (exit 124). Use it directly as `scripts/run-capped.sh [--mem 8G] [--timeout 150s] -- <command>...`; the defaults are 8G and 150s, overridden by `POMTREE_RUN_MEM` and `POMTREE_RUN_TIMEOUT` (the flags win). The test scripts apply one cap to the whole fan-out of packages, not one per package: 16G and 30 minutes for `test:lite`, 16G and 60 minutes for `test:full`, 8G and 10 minutes for `test:examples`. A shared cap bounds the total for the machine, which matters because the packages run `WORKSPACE_TEST_CONCURRENCY` (default 6) at a time, and the kernel kills the largest process in the scope, so the culprit is the usual victim; raise `POMTREE_RUN_MEM` if a legitimate run is killed. Running one package with `pnpm --filter @pomtree/<name> test` is not capped; wrap it yourself. Without systemd (macOS, no user session bus) the script prints a notice and falls back to `ulimit -v`, a weaker cap on address space rather than resident memory, and refuses to run if that is unavailable too. The tighter cap wins when runs nest: inside an enclosing cgroup that already limits memory to at most the requested amount, the command stays in it (a nested systemd scope would escape it) and a notice says so. `POMTREE_RUN_UNCAPPED=1` bypasses the cap and the time limit and prints a notice; use it only to debug the cap itself. `packages/e2e/src/run-capped.test.ts` covers the script.

A local pass of new Docker-gated or end-to-end harness code can depend on your machine rather than on the code. A `pi` on your `PATH` supplies the model price catalog that pomtreed otherwise cannot find, and the memory admission gate never binds on a host with plenty of RAM. So before trusting such a pass, also run the candidate where neither holds: no `pi` on `PATH` (and no `POMTREED_PI_CATALOG_DIR`) and a Docker host with about 8 GB of memory. The hosted CI runner is shaped like that (2 vCPUs, about 7.7 GiB, no `pi` installed), so slow boots under load show up there as well.

## History: rebase-only, and force-pushing your branch

From the first release onward, `main` has a linear, curated history with no merge commits. Pull requests land by rebase-merge: the maintainer replays your commits onto `main` one by one, with no squash and no merge commit, and every commit is kept as you wrote it. So every commit on `main` was written and reviewed as a finished step, which keeps `git log` readable and `git bisect` reliable.

The consequence is that you will rewrite your own pull-request branch, and that is normal. Rebase onto `main` to pick up new work rather than merging it in, and address review feedback by fixing up the commit it concerns rather than stacking an "address review" commit on top. A fixup commit (`git commit --fixup`) is marked to be folded into an earlier commit, and `git rebase --autosquash` does the folding. Then force-push your branch with `--force-with-lease`, which refuses the push if the remote branch has changed since you last fetched it, so you cannot silently overwrite work you have not seen; Git's documentation calls this taking a "lease" on the branch [3]. With your fork as `origin` and this repository added once as `upstream`:

```sh
git remote add upstream https://github.com/pomtrees/pomtree.git   # once
git commit --fixup=<commit-being-fixed>     # for each review fix
git fetch upstream
git rebase -i --autosquash upstream/main    # onto the latest main, folding fixups in
git push --force-with-lease origin <your-branch>
```

Force-pushing is welcome on your own pull-request branch and never acceptable on `main` or anyone else's branch. A reasonable objection is that rewriting loses the trail of how review shaped the change, and that comments on a rewritten commit can be marked outdated. We accept that: the pull request's conversation keeps the discussion, and `main` keeps only the finished steps. If a rewrite makes the change hard to follow, say what changed in a comment.

Commit subjects are `area: imperative summary`, where `area` names the package, directory or document changed, for example `pomtreed: refuse an unset egress image` or `docs: fix the INSTALL firewall anchor`. Write lowercase after the prefix, no trailing period, at most 72 characters. Name any `TODO` tags the commit closes or adds. The body is one or more unwrapped paragraphs saying what changed and why.

## Pull requests and review

Open a pull request from a branch on your fork; GitHub fills the description with a short template that asks for the points below. A draft may be incomplete or failing; mark it ready for review only when `pnpm check:lite` passes, and say which checks and Docker-gated suites you ran. For a bug fix or behavior change, name the test that fails without your change, since a test that passes either way proves nothing. Put any caveat (a skipped suite, a known failure, an open question) in the description rather than leaving the reviewer to find it.

A pull request lands by rebase-merge, never squash, so each commit reaches `main` exactly as you wrote it and must stand on its own (semi-atomic, with its docs and a message that says why). Curate the history before you ask for review, not after. Common practice is to squash a pull request into one commit, which spares contributors this work; we ask for it anyway because a squash discards the stepwise history that makes `git bisect` and `git blame` useful, and we accept the cost to you of tidying commits.

Review comments are direct and specific. Respond as described above, then reply to or resolve each comment.

## Proposing larger work and extensions

For anything beyond a small fix, open an issue before writing much code, so the design is agreed before much effort goes in. Much of pomtree is meant to be extended without editing core, for example with new agent templates or messaging adapters. [`docs/extending.md`](docs/extending.md) says which extension points work today, which are hardwired and which are only proposed; read it before proposing a new one. If your change creates or affects a safety decision (a setting the daemon refuses to start without, or a default it applies silently), classify it as described in [`docs/safety-decisions.md`](docs/safety-decisions.md#adding-a-new-safety-decision) and say so in the proposal.

## Reporting problems and security issues

File bugs and proposals with the templates GitHub offers when you open an issue. Scrub tokens, API keys, credentials and personal paths from anything you paste, and never include them, even partially. Do not report a vulnerability in a public issue or pull request: follow [`SECURITY.md`](SECURITY.md), which uses GitHub's private vulnerability reporting.

## License

pomtree is licensed under the Apache License 2.0; see [`LICENSE`](LICENSE). Contributions are accepted under the same license (inbound equals outbound, as section 5 of [`LICENSE`](LICENSE) provides). There is no contributor license agreement and no sign-off requirement.

## Sources

1. Google Engineering Practices, "Small CLs": https://google.github.io/eng-practices/review/developer/small-cls.html
2. Linux kernel documentation, "Submitting patches", section "Separate your changes": https://www.kernel.org/doc/html/latest/process/submitting-patches.html
3. Git documentation, `git push`, option `--force-with-lease`: https://git-scm.com/docs/git-push
