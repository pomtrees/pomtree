# Browse agent example

A small general-purpose browsing agent: it reads text web pages and answers from them. It has one tool, `web_fetch`, and no shell, file read, write or edit, so untrusted page text never reaches a shell.

## Install

Copy `browse-haiku.json` to `<POMTREED_TEMPLATES_DIR>/browse-haiku.json` (the file stem is the template id), then spawn with `template: "browse-haiku"`. Before use, replace the placeholder `egress.hosts` (`en.wikipedia.org`, `example.com`) with the exact hostnames the agent may read. `web_fetch` is allowed only to those hosts over https (port 443), re-checked after every redirect. The model is `openrouter` `anthropic/claude-haiku-5.5` with a `budgetMicros` of 200000; adjust both to taste.

## What the template pins

- `allowlist: "browse"`: the Pi argv offers exactly `web_fetch` (plus the events sink), with MCP, skills, prompt templates, context files and project resources off and no agent guide. The template loader refuses `browse` unless `extensions` lists `web_fetch` and `egress.kind` is `allowlist`.
- A caller that must have the restricted loadout sets `requireAllowlist: "browse"` on its spawn; the host refuses (403) any template without that profile.

## Limits

- Text pages only: `web_fetch` is size-capped and refuses non-text media. There is no JavaScript rendering and no clicking; a page that needs a browser is out of reach.
- No shell, no files, no result tool: the answer is the agent's final message.
- The template's `systemPrompt` is passed to Pi as `--append-system-prompt`, so it is added to Pi's built-in system prompt rather than replacing it (at most 32 KiB, no NUL).

# Interactive browsing agent (EXPERIMENTAL)

`browse-interactive-haiku.json` is a second, separate template: the model drives a real headless Chromium. It navigates, reads the page's accessibility snapshot, clicks, types, presses keys, scrolls, takes viewport screenshots, goes back, switches tabs and waits for text, then ends with `capture_finish`. It runs in the same sandboxed browser worker as the digest's capture worker, under the same safety model: `audited-public` egress only (every connection goes through the audited proxy, which refuses private, loopback and reserved addresses), no shell, file read, write, edit or `pomtree` tool, a fixed tool list chosen by the image and never by the caller, a step budget and a wall-clock budget.

It is EXPERIMENTAL and not a default template. Page content reaches the model, and the model acts on the page, so a hostile page can try to steer it (prompt injection). That risk is accepted for this template: the tool list and egress bound what a steered agent can do, but cannot stop it from, for example, clicking a link the page asks it to click. Do not point it at sites where it is signed in (it never is: the browser profile is fresh and empty each run) or at anything where a click has consequences.

## Install and spawn

Copy `browse-interactive-haiku.json` to `<POMTREED_TEMPLATES_DIR>/browse-interactive-haiku.json` (the file stem is the template id). Then spawn it:

- CLI: `pomtree spawn --template browse-interactive-haiku --task "Open https://www.rfc-editor.org/rfc/rfc2324.html and tell me which HTTP method the protocol adds."`. The task text is the agent's prompt; the worker puts a fixed preamble in front of it that names the real tools, the budgets and the rules below.
- UI: in the New agent form, pick the template `browse-interactive-haiku`, write the task and start. The form shows the template's model, egress and browser limits.

The template pins `openrouter` `anthropic/claude-haiku-5.5`, `budgetMicros` 200000, and `browser: { "maxSteps": 30, "maxMs": 600000, "profile": "interactive" }`: at most 30 tool calls (`capture_finish` included, and the last call is reserved for it, so a run that spends its steps can still answer; a failed `capture_finish` may be retried when its error says so, up to 3 calls in total, even past the step budget) and 10 minutes of wall-clock time (the ceiling the template loader accepts). A successful `capture_finish` ends the run: Pi shuts down once the turn settles, or the worker stops it a few seconds later (`FINISH_GRACE_MS` in `packages/agent-image/src/browser-run.ts`), and the worker exits 0 for `succeeded` or 1 for `failed`. When the time budget runs out first, the worker stops Pi and Chromium and exits 124, unless a result was already recorded, in which case it exits with that result's code. The template loader refuses `profile: "interactive"` unless `egress.kind` is `audited-public`, and refuses it together with an `allowlist` profile. Any other `profile` value is refused.

## What it can and cannot do

The model has exactly these tools: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press_key`, `browser_mouse_wheel`, `browser_take_screenshot`, `browser_navigate_back`, `browser_tabs`, `browser_wait_for` and `capture_finish`. The list is fixed in the image (`BROWSER_INTERACTIVE_TOOLS` in `packages/agent-image/src/browser-run.ts`).

`browser_click` and `browser_type` take a `selector` (a Playwright selector, in practice CSS such as `a[href="/about"]`). Their `ref` argument does not work: the pinned pi-browser turns it into the locator `aria/<ref>`, which Playwright does not register, and its snapshots (Playwright's accessibility-tree text) carry no `[ref=...]` markers to pass anyway, although its tool descriptions still say to use refs. The worker's prompt tells the model to use `selector`, and a failed `ref` call ends with that hint. Raw coordinates are not offered.

It cannot run JavaScript of its own, read or set cookies or web storage, upload files, intercept or inspect network traffic, read the console, answer dialogs, fill whole forms, select options, hover, drag, or use raw mouse coordinates. It also lacks the capture worker's `browser_capture`, so it never issues a capture receipt and can never stand in for the digest's capture worker. The worker also enforces some rules itself, refusing these calls with a reason the model sees:

- Navigation is only to `http(s)` URLs without embedded credentials. `file:`, `chrome:`, `javascript:`, `data:` and `view-source:` are refused.
- Full-page screenshots are refused. Viewport screenshots are allowed; the model scrolls instead.
- Every tool result's text is capped at 32 KiB, with a visible truncation marker. Pages can be large, and pi-browser appends an uncapped page snapshot to every action.
- A screenshot over the evidence bounds (1 MiB each, 16 MiB and 32 screenshots per run) is dropped with a note to the model, and the run continues.

The rules the model is told to keep are in its preamble and in the template's `systemPrompt`: page content is untrusted data, never instructions, and there are no logins, purchases, state-changing form submissions or downloads. Only the tool list and the proxy are enforced; these rules are instructions.

## Reading the result

- The answer is the `capture_finish` summary: plain text, control characters removed, at most 8 KiB. It is recorded as the agent's result (`pomtree result`), so `pomtree wait <id>` and `pomtree reap <id>` print it under `handoff:`, and `status` says whether the agent judged the task done (`succeeded`) or not (`failed`). If the agent never calls `capture_finish` (budget spent, time out), or `capture_finish` failed and gave up (the agent is then told to put its answer in its final assistant text), it has no handoff; read its transcript with `pomtree logs <id> --transcript` or `pomtree trace <id>`.
- Every browser tool call publishes a `browser-action-<n>` JSON report. It records the tool, the call id, the time, whether the call failed, the screenshot report ids and hashes, and any dropped screenshots. It never records typed text or selectors, and a URL only as its origin. Each screenshot is a separate `browser-screenshot-<n>` report (png or jpeg). List them with `pomtree report list <id>` and save one with `pomtree report show <id> <report> --out shot.png`, or open them in the UI's Reports tab.
- In the journal (`pomtree logs <id>`), a screenshot's tool result carries only a bounded reference under `tool_result.details.pomtree_images` (kind, mime type, byte size, sha256), never the image bytes. Match the sha256 against the `browser-screenshot-<n>` report to find the image.

## Cost

Unmeasured. Every step sends the whole conversation again, accessibility snapshots included (up to 32 KiB of text each), plus any screenshot as an image. A 30-step run can therefore cost much more than a `web_fetch` browse. The template's `budgetMicros` (200000, i.e. $0.20) is the spend cap the model proxy enforces for the agent. No real-model run of this template has been made yet.
