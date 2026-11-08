// The decided menus and status of the terminal, browser and inbox views, per docs/ui-vision.md and the mock
// docs/mockups/ui-launcher-mock.html. Plain data, no functions and no logic. The window chrome does not use these
// yet: the registerView calls adopt them when the window chrome lands.

import type { ViewDeclaration } from "./menuModel.ts";

export const TERMINAL_DECLARATION: ViewDeclaration = {
  id: "terminal",
  title: "Terminal",
  multi: true,
  menus: [
    {
      id: "view",
      items: [
        { kind: "separator", label: "Font size" },
        { kind: "action", command: "terminal.font-smaller", label: "Smaller" },
        { kind: "action", command: "terminal.font-larger", label: "Larger" },
        { kind: "action", command: "terminal.font-reset", label: "Reset size" },
      ],
    },
    {
      id: "trace",
      items: [
        { kind: "action", command: "terminal.trace-copy", label: "Copy trace" },
        { kind: "action", command: "terminal.trace-view", label: "View trace" },
        { kind: "action", command: "terminal.trace-short", label: "Short", hint: "header + last 40 events + errors" },
        { kind: "separator", label: "Options" },
        { kind: "toggle", command: "terminal.trace-children", label: "Include children (condensed)", checked: false },
        {
          kind: "toggle",
          command: "terminal.trace-raw",
          label: "Include raw tool output (no redaction)",
          checked: false,
          caution: "Raw skips secret redaction. Do not paste it anywhere public.",
        },
        { kind: "separator" },
        { kind: "action", command: "terminal.trace-download", label: "Download .md" },
      ],
    },
    {
      id: "session",
      items: [{ kind: "action", command: "terminal.reconnect", label: "Reconnect", visible: false }],
    },
    {
      id: "help",
      items: [{ kind: "action", command: "terminal.keys", label: "Keys" }],
    },
  ],
  status: [
    { id: "state", title: "Agent state" },
    { id: "connection", title: "Connection" },
  ],
};

export const BROWSER_DECLARATION: ViewDeclaration = {
  id: "browser",
  title: "Browser",
  multi: true,
  menus: [
    {
      id: "view",
      items: [
        { kind: "toggle", command: "browser.fit", label: "Fit to window", checked: true },
        { kind: "toggle", command: "browser.actual-size", label: "Actual size", checked: false },
        { kind: "separator" },
        { kind: "action", command: "browser.copy-url", label: "Copy URL" },
      ],
    },
    {
      id: "help",
      items: [{ kind: "action", command: "browser.about", label: "About view-only", hint: "agent-controlled content" }],
    },
  ],
  status: [
    { id: "stream", title: "Stream" },
    { id: "view-only", title: "Access", text: "view-only", tone: "info" },
    { id: "url", title: "Page URL", mono: true },
  ],
};

export const INBOX_DECLARATION: ViewDeclaration = {
  id: "inbox",
  title: "Inbox",
  multi: false,
  menus: [
    {
      id: "view",
      items: [
        {
          kind: "radio",
          command: "inbox.filter",
          label: "Show",
          options: [
            { value: "all", label: "All" },
            { value: "message", label: "User messages" },
            { value: "escalation", label: "Escalations" },
            { value: "approval", label: "Approvals" },
          ],
        },
      ],
    },
    {
      id: "help",
      items: [{ kind: "action", command: "inbox.about", label: "About the Inbox" }],
    },
  ],
  status: [{ id: "pending", title: "Pending" }],
};

export const VIEW_DECLARATIONS: ViewDeclaration[] = [TERMINAL_DECLARATION, BROWSER_DECLARATION, INBOX_DECLARATION];
