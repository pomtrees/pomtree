# Frequently asked questions

These are questions operators and extension authors ask first, answered briefly. Each answer links to the document or code that holds the authoritative statement and does not restate it; where the two disagree, the linked source wins. Terms used throughout: `pomtreed` is the daemon that runs agents, `pomtree` is its command-line client, and [Pi](https://github.com/earendil-works/pi) is the coding-agent program that runs inside each agent's Docker container; the *journal* is `pomtreed`'s append-only log of what each agent did. Known gaps are tracked as [GitHub issues](https://github.com/pomtrees/pomtree/issues), labelled when filed.

## Can I run it unattended or on several nodes?

Not in the first release, which is for supervised use on a single machine: an operator watches it, and the safety choices are forced at boot. See [`docs/safety-decisions.md`, Supervised use only](safety-decisions.md#supervised-use-only).

## Can I load extensions, templates and workflows from my own directory, and reload them while pomtreed runs?

Yes for the directory, partly for reloading. A *template* (a named agent definition: container image, tools, limits, network access) is read from `templates.dir` on every spawn, so a new or edited file applies to the next spawn; an agent already spawned keeps the copy saved at its spawn, with the template's digest (a hash of its content) recorded. *Extensions* (plugins whose code runs inside `pomtreed`), and the *workflows* (code-driven runs of agents) that only extensions can register, load from `extensions.dir` at boot only: after startup the extension host is sealed, and there is no hot reload or unload, so changing them means restarting `pomtreed`. Extension code is not pinned or hashed, and it is trusted, not isolated. Either directory may be any path that no agent can write (next question). See [`docs/configuration.md`, `templates`](configuration.md#templates) and [`extensions`](configuration.md#extensions), and [`docs/extending.md`](extending.md). Known gap: extension code is not pinned or hashed.

## Can an agent write a template or extension that pomtreed then loads?

There is no supported route. Agents have no API for writing templates or extensions, and `pomtreed` refuses to boot if `templates.dir` or `extensions.dir` overlaps any path an agent container can write, so a misconfiguration cannot open one. Files an agent pushes on its branch reach the operator like any other work and are installed only by hand. A flow in which an agent proposes a template and the operator approves it is planned for after the first release. See [`docs/safety-decisions.md`, Class 2](safety-decisions.md#class-2-decisions-the-framework-forces) (load directories). Known gap: there is no approval flow for an agent-proposed template.

## What does pomtree send as its User-Agent, and does it include my contact details?

The key `workflow.fetch.userAgent` defaults to the neutral product token `pomtree`, and a blank or unset value means that default. Browser captures and the interactive browser send Chromium's own User-Agent with that value appended. Nothing personal is sent unless you put it there; adding a contact (an email address or URL) is optional and recommended if you fetch at volume, and some sites ask for one. `robots.txt` rules are evaluated for the product token. See [`docs/configuration.md`, `workflow`](configuration.md#workflow).

## What wakes a yielded agent, and what does not?

An agent *yields* when it would wait longer than a short threshold (`POMTREED_WAIT_YIELD_MS`): its container is stopped, its state is saved in a *checkpoint*, and it is resumed later when its *wait condition* is met. A wait names one of: a message to the agent, the exit of any or all of a listed set of children, or a timer. An escalation addressed to the agent (a question or budget request climbing up from a descendant) wakes it whatever it waits on, and so does an operator's `pomtree send --interrupt`. An agent parked on its own open question wakes only for the answer or its timeout, an agent parked on an exhausted budget wakes only when its raise request is granted, and a session deadline that passes while an agent is yielded ends it as timed out instead of waking it. A *custody hand-up* (the exited child of a dead parent, delivered to its nearest live ancestor) wakes a message, timer or any-child wait, but not an all-children join, a question park or a budget park. Any other signal is not lost: it stays queued in the agent's inbox (`pomtree inbox`) for its next wake; signals are filtered because every wake costs a model turn and budget. See `satisfied()` in `packages/sched/src/wait.ts`, [`SPEC.md`, Signals](../SPEC.md#signals), [`docs/operating.md`, Waiting, yielding and interrupts](operating.md#waiting-yielding-and-interrupts).

## What does the yielded state guarantee?

When an agent's state reads `yielded`, its previous run is fully torn down: the container is stopped and its exit is journaled, the credential files staged for its container are removed, its key for the model proxy is revoked, and its admission slot (its place in the concurrent-session limit) is released. A resume therefore cannot be overtaken by a late teardown from the old run. Each resume also increases the agent's *generation*, a counter that fences out writes from any older instance. This holds both for an ordinary yield and for one completed by recovery after a daemon crash. See [`SPEC.md`, Resume](../SPEC.md#resume).

## What happens to a child's result when its parent dies?

A parent's live children are cancelled by default. Its exited children that nobody has collected (*reaped*) are held for the nearest live ancestor, the *custodian*; the daemon's permanent root supervisor (the parent of everything an operator or a schedule starts) counts as live, and what it holds is reported to the operator. Held results are never reaped automatically: the custodian is told once and may read and reap them, the child's declared disposition (`hold`, optionally with a time limit, or `reap-on-exit`) still applies, and an explicit reap or a time-limit expiry waits while the child's pushed work is unmerged. See [`SPEC.md`, Agent lifecycle and reaping](../SPEC.md#agent-lifecycle-and-reaping).

## What happens when an agent runs out of budget after a crash?

Each model call reserves budget before it is sent. If `pomtreed` dies with a call in flight, nobody knows what the provider billed, so after a restart the reservation is charged in full; this can never undercharge, at the cost of sometimes overcharging. An agent left below the minimum a call needs then raises a budget escalation to its parent (or to the operator) and parks, instead of stalling with its calls silently refused. See [`docs/economy.md`, section 13](economy.md#13-budget-exhaustion-and-escalation).

## Do traces and journals contain secrets?

They can. Tool input and output are journaled and shown raw up to a size cap, so anything a tool printed, credentials included, may be in the journal and in the operator UI; the only redaction applied to them is of host paths (`redactPaths` in `packages/pomtreed/src/daemon-util.ts`), so tool output is not redacted for secrets. `pomtree trace` additionally masks credential-looking text unless you pass `--raw`, but that pass is best-effort pattern matching. Review a journal or trace before you paste it anywhere public. See [`docs/operating.md`, Commands in depth](operating.md#commands-in-depth) (debugging traces).

## Can I see the last terminal screen of a suspended agent?

Not yet. `pomtreed` uses no terminal multiplexer such as tmux; it attaches to the container's terminal directly, and that connection ends when the container stops, so no screen is saved at yield. If the operator UI's terminal pane was open when the agent yielded, it keeps the last screen and labels it as frozen; otherwise the pane labels the agent "Yielded" instead of retrying the connection. A saved snapshot is planned for after the first release and must be redacted first, since a screen can show secrets.

## Can I replay a run from the logs, with mock models fed from recorded traffic?

Only partly. The journal records lifecycle events, signals, messages, tool calls and results (truncated to a size cap) and per-call model cost metadata, and the Pi session is saved at each checkpoint; it records events, not the full state, and it records no model request or response bodies. The only mock model is `FakeModelUpstream` in `@pomtree/testing`, which answers from hand-written scripts. Faithful replay would need a recorder for model traffic, a replay upstream that serves it back, clock and id seams in the store so timestamps and ids repeat, and a snapshot of each agent's workspace at spawn. That work is planned for after the first release.

## Why are pull requests rebase-merged, not squashed?

So that, from the first release onward, every commit lands on `main` as its author wrote it, keeping the stepwise history that makes `git bisect` and `git blame` useful. See [`CONTRIBUTING.md`](../CONTRIBUTING.md#history-rebase-only-and-force-pushing-your-branch).

When the same question is asked twice, add it here.
