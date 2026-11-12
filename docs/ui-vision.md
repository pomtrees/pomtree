# Operator UI vision: a window manager in the browser

This document states where the operator UI is going, which decisions are already made and why, what is built, and what is still open, so that separate pull requests for the pieces share one reference. It is a direction, not a specification: current behavior is in [Operator UI](operating.md#commands-in-depth). Where this document says "built", the code exists in the repository; "planned" and "speculative" mean nothing exists yet.

Terms: the operator is the person running pomtree and watching its UI; an agent, the daemon (`pomtreed`), the extension host and the journal (the daemon's ordered event log) are defined in [`README.md`](../README.md) and [`SPEC.md`](../SPEC.md), and extensions in [Extending](extending.md).

The idea is that the operator UI becomes a window manager that runs entirely inside the browser. Windows are tiled, can be resized, and each shows a view into an agent's work. The result should look like a computer with terminals, dashboards and browsers on screen, but every window is a view onto what an agent is doing, not something the operator drives. A tile here means one rectangular region of the screen that holds one window, and a view type is a kind of window (terminal, tree, report) that can be opened in a tile.

## What the operator sees

The screen is a set of tiles. Today the views are the existing tabs (Tree, Terminal, Reports, Audit, Hosts and others), each in a tile that can be split, resized by dragging a splitter, retargeted from a selector, and closed. The intended set is wider: a live terminal for an agent, dashboards and status panes, reports, the agent tree, and live browser views, meaning the headless Chromium an agent is using, streamed to the operator.

The arrangement is meant to be dynamic. Windows should come and go as agents start, finish or produce things, and the layout should adapt on its own. Extensions and workflows should eventually contribute their own view types, so that an extension has a visible shape in the UI instead of only a route. The visual identity is black and orange. Glossy effects in the style of Windows XP Luna and Mac OS X Aqua are confined to window chrome (title bars, buttons, splitters) on black backgrounds with orange accents; content areas stay flat so terminals and tables remain legible.

## Decisions and rejected alternatives

**Tiling first, not free-floating windows.** The layout is a tree of splits, which serializes to plain data, degrades to a single pane on a phone (a bottom navigation bar at narrow widths), and cannot lose a window off-screen. Overlapping windows make each of those properties harder to keep: a window can be dragged out of reach, and positions are coordinates rather than a tree (general reasoning, not a measured repo fact). Reopen if operators ask for overlapping windows; floating windows remain a possible later addition.

**Plain browser code, no framework, no bundler, no new dependency.** The layout logic is a pure module with unit tests and the DOM shell around it stays thin, in line with [`CONTRIBUTING.md`](../CONTRIBUTING.md). A framework or bundler was rejected because the repository allows no new dependency or build step without discussion (repo rule). Reopen when the shell script outgrows what can be unit-tested in isolation, or when a second contributor needs a component model.

**The layout lives in the browser's `localStorage`, with JSON export and import.** The stored layout holds only view ids and agent ids, no content, so it is safe to keep there. A stored layout that fails validation falls back to the default layout with a visible notice, and a view that fails to load or is unknown shows an inline note in its tile instead of crashing the layout. Two alternatives were rejected. A daemon journal record was rejected for repo-specific reasons: view state belongs to a device, the journal is an audit log, and the change would touch the core contract. A URL hash was rejected for a general engineering reason: a URL cannot carry an arbitrarily large layout, and some proxies and servers truncate long URLs. Reopen when operators use several browsers and want their layouts synchronized, or when several operators share a host.

**Browser views use Chrome DevTools Protocol screencast frames, relayed by the daemon, view-only.** CDP is the protocol Chromium exposes for remote inspection; its screencast feature pushes page frames. The daemon relays frames to the operator through a fixed allowlist of CDP methods; the viewer may only send a close request; the content is labelled as agent-controlled; and the debugging port is never published. VNC (remote-desktop sharing) was rejected for repo-specific reasons: it needs an X server, a second protocol and a second port, and conflicts with the agent image's sandbox tests. Polled screenshots were rejected on general grounds: they give low frame rate and fidelity. Reopen if operators must be able to click into the page.

**The black-and-orange palette replaces only the dark scheme.** The light scheme is unchanged. Because orange is now the accent colour in the dark scheme, its warning and error colours moved off orange so that status colours keep their meaning; the light scheme keeps its own colours.

**Views are read-only windows onto agents.** This is the intended model. The terminal window is the exception: it still accepts keyboard input, as the existing terminal tab does, and that was kept deliberately for now. Current behavior is in [Operator UI](operating.md#commands-in-depth); the question of per-window read-only is open below.

## Status

Built:

- the pure layout module (`packages/observe/src/layout.ts`);
- the tiling shell with persistence, import, export and the narrow-width fallback (`packages/observe/src/layoutShell.ts`);
- a terminal pane that can be mounted more than once per page, and an internal view registry (`registerView` in `packages/observe/src/paneKit.ts`);
- the black-and-orange dark scheme with window chrome (`packages/observe/src/themeCss.ts`), and its polish: a dark terminal palette (`packages/observe/src/termKit.ts`), a resting splitter grip, an accent fill on a keyboard-focused splitter, forced-colors (high-contrast mode) handling, and a chrome border pinned at 3:1 contrast or more by `themeCss.test.ts`.

The registry is internal. In the dark scheme the warning colour is now a yellow-green and the error colour a rose; the light scheme is unchanged and its warning colour is still a brown-orange.

Not built yet: the live browser view, which this document describes as intent.

Planned, not started: windows that appear and rearrange as agents come and go; a public view-type API so that extensions can contribute windows; layout synchronization across browsers. Speculative: floating windows. A dedicated placeholder for a window whose agent no longer exists is also not built; today such a tile shows the inline note for a view that failed to load or is not available, or the view's own message.

## Open questions

**Automatic arrangement policy.** When an agent appears or finishes, where does its window go? Options: append to the focused tile (simple, but it disturbs reading); split the largest tile (predictable, but it shrinks work in progress); open into a designated area that the operator can name (stable, but needs a fallback when full); never rearrange anything the operator placed by hand, and only fill or reclaim tiles the policy itself created. Recommended: the last option as a rule, with a designated area where new windows land, because the operator's own placement is the costliest thing to lose.

**How an extension declares a view type, and what it may render.** The existing precedent is `UiPane` in [Extending](extending.md#4-proposed-seams-not-built-future-work), which is gated on an open XSS risk (`TODO(ui-xss)`): agent-controlled text reaches the operator UI with operator scope. Options: a declarative manifest of fields and tables that the host renders; a function that mounts into a sandboxed origin; or a function that mounts directly in the page. Recommended: declarative first, with content set only through `textContent` as today, because it widens no exposure; a sandboxed form can follow once the XSS gap is closed.

**Per-window read-only.** The terminal accepts input today. Options: make every window read-only and remove terminal input; make read-only a per-window setting; or keep the terminal writable as a stated exception. Recommended: a per-window setting, read-only by default for new windows, so the existing terminal keeps working while the model becomes enforceable.

**Whether any window may take operator input.** Browser views are view-only by decision above, and the terminal is the one open case. Operator replies already go through the Inbox. Recommended: no window accepts input except an explicitly enabled terminal.

## Reading the history

`git log` restricted to `packages/observe/src` shows the built parts; each commit message says what changed and why. The layout module, the terminal pane's multi-instance mount and the palette and chrome commits are separate steps that can be reviewed independently. Split-out pull requests should link here for direction.
