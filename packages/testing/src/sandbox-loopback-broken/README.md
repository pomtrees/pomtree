# Seeded broken copy of the loopback backend (test data)

A copy of [`examples/sandbox-loopback`](../../../../examples/sandbox-loopback) with exactly four deliberate defects in `provider.mts`. It is the negative control for the conformance command: `pnpm conformance:sandbox packages/testing/src/sandbox-loopback-broken` must exit 1 and fail exactly these clauses. Do not copy it; copy the template.

| Clause | Defect (marked `Seeded defect (<clause>)` in `provider.mts`) |
| --- | --- |
| `label-rules` | The label check validates the env names instead of the labels, so a reserved `pomtree.*` or malformed label is sent. |
| `lifecycle-run` | `wait()` swallows the exit code and reports 0 for a stopped or killed sandbox. |
| `list-by-owner` | `list(owner)` never sends the owner filter, so another store's or a newer epoch's sandboxes are listed. |
| `user-agent-stamped` | `stop` uses the global `fetch` instead of `deps.request`, so it carries Node's own User-Agent. |

The list defect also makes the suite floor report `list.byTag` as uncovered, since its only clause failed.

`packages/pomtreed/src/sandbox-loopback-conformance.test.ts` runs the command and asserts the exact failing set. It also checks that every other file is byte-identical to the template's, so a change to the template must be copied here (all files except `README.md`, `tsconfig.json` and `wire.test.mts`, then the four defects re-applied to `provider.mts`).
