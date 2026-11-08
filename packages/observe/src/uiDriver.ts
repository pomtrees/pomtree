// The in-page driver for UI commands streamed from the daemon (uiCommand.ts has the contract and the kit): it
// listens on /live/ui, validates each frame with UiCommandKit.parseFrame, dedupes by journal seq and applies the
// command through the window manager api. A command is data: agent text reaches the DOM only through the api's
// notices (textContent). Follow is a tab-local flag in memory. Tested in uiDriver.test.ts. Plain JS in a template
// literal: no backticks, no template interpolation, no backslashes.
export const UI_DRIVER_JS = `
function createUiDriver(wm, cfg) {
  "use strict";
  const api = wm.api;
  const KEY = "ui-command";
  let last = -1; // high-water journal seq: seqs are the journal order, so anything at or below it was handled
  let follow = null; // { views, of } while following, else null; never persisted
  const say = (text) => { try { api.notify(KEY, text); } catch (e) {} };
  const subjectParams = (c) => {
    const p = {};
    if (c.agent !== undefined) p.agent = c.agent;
    if (c.report !== undefined) p.report = c.report;
    return p;
  };
  const known = (view) => api.views().some((v) => v.id === view);
  const label = (c) => c.view + (c.agent ? " for " + c.agent : "") + (c.report ? " (report " + c.report + ")" : "");

  const setFollow = (c) => {
    if (!c.on) { follow = null; return; }
    const views = c.views || ["terminal"];
    const agentViews = api.views().filter((v) => v.subject === "agent").map((v) => v.id);
    const bad = views.filter((v) => agentViews.indexOf(v) < 0);
    if (bad.length) {
      say("Follow was not changed: " + bad.join(", ") + " is not an agent view here. Use one of: " + agentViews.join(", ") + ".");
      return;
    }
    follow = { views, of: c.of };
  };

  const apply = (c) => {
    if (c.cmd === "open") {
      if (!known(c.view)) { say("View not available: " + c.view + ". Check the name with the views the launcher lists."); return; }
      api.openView(c.view, c.agent, c.report);
    } else if (c.cmd === "focus") {
      if (c.dir) {
        api.focusDirection(c.dir); // the window manager shows its own notice when it cannot move focus
      } else if (!api.focusSubject(c.view, subjectParams(c))) say("Cannot focus " + label(c) + ": that window is not open. Open it first.");
    } else if (c.cmd === "close") {
      if (!api.closeSubject(c.view, subjectParams(c))) say("Cannot close " + label(c) + ": that window is not open.");
    } else if (c.cmd === "arrange") {
      api.arrange(c.preset);
    } else if (c.cmd === "reset") {
      api.resetLayout();
    } else if (c.cmd === "follow") {
      setFollow(c);
    }
  };

  const onFrame = (f) => {
    if (f.type === "command") apply(f.command);
    else if (f.type === "spawned" && follow && (follow.of === undefined || f.parent === follow.of)) {
      for (const v of follow.views) api.openView(v, f.agent);
    }
  };

  const onMessage = (ev) => {
    const f = UiCommandKit.parseFrame(ev && ev.data);
    if (!f || f.seq <= last) return;
    last = f.seq;
    try { onFrame(f); } catch (e) {
      say("The UI command could not be applied (" + String(e && e.message ? e.message : e) + "). Reload the page and send it again.");
    }
  };

  // The browser retries a dropped stream itself and installAuthGuard (shell.ts) reloads on an expired cookie; a CLOSED
  // source (readyState 2) means the browser gave up (a 403 or a non-SSE reply), so say so once. A later frame clears it.
  const STREAM = "ui-stream";
  const clear = () => { if (shown) { shown = false; try { api.dismiss(STREAM); } catch (e) {} } };
  let shown = false;
  const es = new EventSource(cfg.path);
  es.addEventListener("message", (ev) => { clear(); onMessage(ev); });
  es.addEventListener("open", clear);
  es.addEventListener("error", () => {
    if (es.readyState !== 2 || shown) return;
    shown = true;
    try { api.notify(STREAM, "Live UI control stopped: the connection to /live/ui was closed by the browser or refused by the daemon. Reload the page; if it keeps failing, check that you are signed in and that pomtreed is running."); } catch (e) {}
  });
  return { close: () => { if (es.close) es.close(); } };
}
`;
