# Demos

What you can run to watch pomtree work, from a zero-spend rehearsal on a scripted fake model to scripted live demos that spend real money. Everything here needs the install in [Getting started](../GETTING_STARTED.md). A one-command scripted demo, signed run manifests and record-and-replay of a run are future work and are not built.

## Terms

- **Fake model**: a loopback server that answers the OpenAI and Anthropic wires from a rule script, so a real daemon, real containers and a real Pi run with no provider and no key. It lives in `packages/testing` (`FakeModelUpstream`).
- **Micros**: integer micro-dollars; 1,000,000 micros is $1 ([Economy](economy.md)). Every spend figure below is in micros.
- **Slim and full image**: the two build targets of `packages/agent-image`. The full image carries a browser, fonts and common toolchains; the slim `demo` image has git, curl, ripgrep, fd, Pi, `pomtree`, the egress sidecar and the guide, and leaves the rest out.

## Zero-spend rehearsal

[Try it locally](operating.md#try-it-locally) starts a first agent on the fake model: no key, no money, only Docker and the agent image. The same fake can be run on its own with `node packages/testing/bin/model-stub.ts` (also available as the workspace bin `pomtree-model-stub`, which is on `PATH` only inside the pnpm workspace). It prints one JSON line with its base URL and serves a built-in script (`happy-tool`, `tree`, `single-429`, `slow-stream`, `steer`, `passive-settle`) or one you write. None of the built-in scripts has the agent report a result, so an agent on a built-in ends with the cause `passive_settle`; [`examples/zero-spend/reporter.json`](../examples/zero-spend/reporter.json) is the script that reports and stops, as used in [Try it locally](operating.md#try-it-locally):

```
node packages/testing/bin/model-stub.ts --script tree
```

Point `scripts/pomtree-up --model-base-url <printed baseUrl> --model-key-file <0600 file> --provider <provider>` at it; the stub ignores the key, but `pomtree-up` requires a 0600 key file. The `tree` script has a parent spawn a child, which is the quickest way to see custody and nested budgets without a model (the agents end `passive_settle`, as above): `pomtree top` shows each agent's cost and what is left of its carve, and `pomtree trace <id>` prints an agent's whole journal with credential-looking text masked unless `--raw` is passed. `pomtree --help` lists every command.

## Live demos

The scripts in `packages/e2e/src/demo` drive real agents through a real model. Each spends real money (a few thousand micros per scenario), needs Docker, the agent image and a key file, and refuses to start unless `POMTREED_LIVE=1` is set. Each runs a real daemon in a temporary state directory and cleans up its containers on exit.

```
POMTREED_LIVE=1 POMTREED_PI_PROVIDER=<provider> POMTREED_MODEL_BASE_URL=<provider base url> \
  POMTREED_MODEL_UPSTREAM_KEY_FILE=<0600 key file> node packages/e2e/src/demo/<script>.ts
```

- `budget-escalate.ts`: an agent exhausts a deliberately small budget and parks behind a `budget_raise` approval. Scenario A approves it: the budget is raised, the agent resumes at the next generation in a new container with a fresh key and finishes. Scenario B denies it: the agent finishes `over_budget` with its checkpoint kept.
- `chapters.ts`: one root agent (`author`) is told to write chapter 1 of a book from an `outline.md` in a temporary git repo. It spawns two helpers with `pomtree spawn` to draft sections 1.1 and 1.2 in separate files, reaps them, merges their commits, commits `chapter1.md`, runs `pomtree push` and reports with `pomtree result`. The script prints the agent tree, the root result, the branch commits listed from the daemon's mirror, and the path of the merged `chapter1.md` read from the root agent's branch there.
- `escalation-chain.ts`: a three-level chain of agents (root, A, B and a leaf C). Scenario 1 passes a budget request up through ancestors that cannot cover it until one approves from its own remainder. Scenario 2 bubbles a question (`pomtree ask`) up the chain. Scenario 3 lets a tiny window expire so the question reaches the operator.
- `pi-ext.ts`: one root agent from a template `fetch` (the `web_fetch` extension, allowlist egress for `example.com` only) is told to fetch `https://example.com` with `web_fetch` and report the page title and the first part of the body with `pomtree result --summary`. It then checks the agent's events and result.
- `report.ts`: one root agent writes a short markdown file and publishes it with `pomtree report publish`. It then reads the report back from the store and checks that the media type is `text/markdown`, the size is above zero and the content is readable text.
- `yield-resume.ts`: a live agent is yielded and resumed twice in one run. At each yield it checks that the container is gone, the admission slot is free, the pre-yield model token is rejected and the checkpoint holds only ids and hashes; at each resume it checks the generation advanced, a new container and key were issued, and the agent remembers a code word from before the yield.

Every script binds the agent API through `agent-endpoint.ts`, which uses the same plan as pomtreed: on Linux the Docker bridge gateway plus loopback on the same port, elsewhere loopback, with `POMTREED_AGENT_LISTEN` as the override. Each builds its workspace through `demo-workspace.ts` with pomtreed's info-exclude setting, so the agent's own session files do not count as uncommitted work and `pomtree result` is accepted.

Common optional settings: `POMTREED_DEMO_MODEL` (the model the keys allow, default `deepseek-flash`), `POMTREED_DEMO_TIMEOUT_MS` (per phase), `POMTREED_AGENT_IMAGE` (default `pomtree/agent:dev`), and for the multi-scenario scripts `POMTREED_DEMO_SCENARIOS` (one character per live run). `budget-escalate.ts` takes `POMTREED_DEMO_AGENT_BUDGET_MICROS`, and `chapters.ts` takes its root budget from `POMTREED_BUDGET_ROOT_MICROS` (default 2000000). The scripts' header comments are the authority for the exact settings. The model proxy has been run against OpenRouter and DeepSeek; results for a release commit are recorded in [validation.md](validation.md).

The key file rules and the live-run runbook are in [scripts/live](../scripts/live/README.md).

## The slim image

The slim image is enough for runs that need no browser:

```
AGENT_IMAGE_TAG=<tag> pnpm --filter @pomtree/agent-image build:image:demo
```

The default tag is `pomtree/agent:demo`; the full image (`build:image`, default tag `pomtree/agent:dev`) is needed for browser capture and the digest example's browser method. The slim image is built locally and is not published. Set `POMTREED_AGENT_IMAGE` to the tag you built.

## Wait yields

A `pomtree wait` that outlasts `wait.yieldMs` (`POMTREED_WAIT_YIELD_MS`) yields: the container is released and the agent resumes later with a synthetic wake message, which changes the next request's shape to the model. For a scripted run whose behavior should not depend on timing, set `wait.yieldMs` well above any wait the scenario makes, so whether a wait yielded is never a race. The behavior is described in [Operating](operating.md#waiting-yielding-and-interrupts) and the setting in [Configuration](configuration.md).

## Image identity

Every agent image carries two labels that say which source and which Pi it contains: `org.opencontainers.image.revision` (the short git revision the image was built from) and `org.pomtree.pi.version` (the Pi version pinned in `packages/agent-image/scripts/build.ts`). The Pi version is read from the image, never assumed from the build script. `pomtree doctor` reports the daemon's git sha, the image's revision and whether they mismatch, and `scripts/pomtree-up` warns when the image it is about to use was built from a revision that is not the checkout's HEAD or an ancestor of it with no change to the image sources since (a docs-only commit is not stale).

## Reading a run

Each demo runs its own daemon in-process and exits when it finishes, so `pomtree top` and `pomtree trace` cannot be pointed at it afterwards. It prints the agent ids and, on its last line, the temporary directory it keeps (`pomtree-<name>-*` under the OS temp directory, or under `TMPDIR` if set). That directory holds the demo repository and the daemon's state (SQLite database, mirror, workspaces, sessions) and is never deleted by the script; delete it yourself when done. No script prints a log path or a cost, except `escalation-chain.ts`, which prints its leaf spend in micros.

To watch an agent tree live, use the [zero-spend rehearsal](#zero-spend-rehearsal) or a running `pomtreed` and run `pomtree top` and `pomtree trace <id>` against it. Neither output is signed or replayable.

Verdicts differ by script. `budget-escalate.ts`, `escalation-chain.ts` and `yield-resume.ts` print one PASS or FAIL line per check, end with `GATE PASS` or `GATE FAIL`, and exit nonzero if any check failed. `pi-ext.ts` prints the agent's final state and exit code with a check mark or cross on three checks (a `web_fetch` proxy call, an ok proxy result for that call, and a result that is non-empty, free of `failed` or `error`, and mentions `example` or `domain`), and exits nonzero if any check failed or the script threw; it exits 2 without running unless `POMTREED_LIVE=1`. `chapters.ts` asserts nothing about the content: it prints the report described above, and exits nonzero if the root agent timed out, it cannot read `chapter1.md` from the root agent's branch, or the script threw; it exits 2 without running unless `POMTREED_LIVE=1`. `report.ts` prints the stored report's id, name, media type, size, hash and a content preview with a check mark or cross on each of the three checks, and exits nonzero if no `chapter-report` was published, a check failed, the root agent timed out or the script threw.
