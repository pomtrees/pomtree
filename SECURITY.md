# Security policy

## Supported versions

pomtree is pre-release. Only the latest `main` is supported; there are no backports.

## Reporting a vulnerability

Report privately through GitHub private vulnerability reporting for this repository: open the repository's Security tab and choose "Report a vulnerability", or go directly to https://github.com/pomtrees/pomtree/security/advisories/new. Do not open a public issue or pull request for a vulnerability.

Please include:

- The affected component and commit (or the date you pulled `main`).
- A description of the impact: which safety property fails and what an attacker or a misbehaving agent gains.
- Steps to reproduce, ideally a minimal configuration or test.
- Any suggested fix or mitigation.
- Whether and when you intend to disclose publicly.

## Scope

In scope are the safety properties the core owns under supervised, single-node operation: budget and credential handling at the model proxy, per-task credentials, fencing, result custody, the container hardening and egress templating the daemon applies, and the refuse-to-boot safety defaults. [docs/safety-decisions.md](docs/safety-decisions.md) is the authoritative list of these invariants and of the decisions around them.

Out of scope:

- Extensions and adapters maintained outside this repository; report those to their maintainers.
- Operator misconfiguration that the docs warn against.
- Escape from an agent container through the shared host kernel. Agents run in hardened containers that share the host kernel, which is not a boundary against a hostile agent, and egress confinement is not complete; both are documented limits rather than vulnerabilities. See [docs/safety-decisions.md](docs/safety-decisions.md#supervised-use-only) ("Supervised use only") for both limits.
- The silent defaults listed in [docs/safety-decisions.md, "Class 3: silent defaults (the gap list)"](docs/safety-decisions.md#class-3-silent-defaults-the-gap-list), and the prompt-injection risk recorded under ["Prompt injection posture"](docs/safety-decisions.md#prompt-injection-posture).

## Response

This is a single-maintainer project. Reports are acknowledged on a best-effort basis, with no fixed response or fix timeline (SLA) and no bounty.

## Disclosure

Please practice coordinated disclosure: give the maintainer a reasonable opportunity to investigate and fix before publishing details. Credit is given in the advisory unless you ask otherwise.
