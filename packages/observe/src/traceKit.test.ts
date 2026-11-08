import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { TRACE_LOGIC_JS } from "./traceKit.ts";

const T = runInContext(TRACE_LOGIC_JS + "\nT;", createContext({ TextEncoder, encodeURIComponent, Number, String, Promise })) as any;

function el(tag: string): any {
  const n: any = { tag, children: [], style: {}, attrs: {}, value: "", textContent: "", className: "", listeners: {}, removed: false };
  n.appendChild = (c: any) => {
    n.children.push(c);
    c.parent = n;
  };
  n.remove = () => {
    n.removed = true;
    if (n.parent) n.parent.children = n.parent.children.filter((x: any) => x !== n);
  };
  n.setAttribute = (k: string, v: string) => {
    n.attrs[k] = v;
  };
  n.addEventListener = (k: string, f: () => void) => {
    n.listeners[k] = f;
  };
  n.select = () => {
    n.selected = true;
  };
  n.click = () => {
    n.clicked = true;
  };
  n.focus = () => {
    n.focused = (n.focused ?? 0) + 1;
  };
  return n;
}
function fakeDoc(execResult: boolean | "throw") {
  const doc: any = { body: el("body"), copied: [] as string[], created: [] as any[] };
  doc.keyListeners = [] as ((ev: unknown) => void)[];
  doc.addEventListener = (k: string, f: (ev: unknown) => void) => {
    if (k === "keydown") doc.keyListeners.push(f);
  };
  doc.removeEventListener = (k: string, f: (ev: unknown) => void) => {
    if (k === "keydown") doc.keyListeners = doc.keyListeners.filter((x: unknown) => x !== f);
  };
  doc.key = (key: string) => {
    for (const f of [...doc.keyListeners]) f({ key });
  };
  doc.createElement = (t: string) => {
    const n = el(t);
    doc.created.push(n);
    return n;
  };
  doc.execCommand = (cmd: string) => {
    if (execResult === "throw") throw new Error("nope");
    const ta = doc.body.children.find((c: any) => c.tag === "textarea");
    if (cmd === "copy" && execResult) doc.copied.push(ta.value);
    return execResult;
  };
  return doc;
}
const reply = (text: string, status = 200, headers: Record<string, string> = {}) => ({
  ok: status < 400,
  status,
  text: async () => text,
  headers: { get: (k: string) => headers[k] ?? null },
});

test("url builds query from options and encodes the id", () => {
  assert.equal(T.url("/v1/agents", "a/b", {}), "/v1/agents/a%2Fb/trace?format=md");
  assert.equal(T.url("/v1/agents", "x", { short: true, children: true, raw: true }), "/v1/agents/x/trace?format=md&short=1&include=children&raw=1");
});

test("copy succeeds through navigator.clipboard and reports size/events/redactions", async () => {
  const written: string[] = [];
  const urls: string[] = [];
  const deps = {
    fetch: async (u: string) => {
      urls.push(u);
      return reply("# Trace\n" + "x".repeat(2048), 200, { "x-trace-events": "12", "x-trace-redacted": "3" });
    },
    clipboard: {
      writeText: async (t: string) => {
        written.push(t);
      },
    },
    doc: fakeDoc(true),
  };
  const r = await T.copyTrace(deps, "/v1/agents", "a-1", {});
  assert.equal(r.ok, true);
  assert.equal(r.via, "clipboard");
  assert.equal(r.chip, "Copied 2.0 KB (12 events, 3 redacted)");
  assert.equal(written.length, 1);
  assert.equal(deps.doc.copied.length, 0);
  assert.deepEqual(urls, ["/v1/agents/a-1/trace?format=md"]);
  const raw = await T.copyTrace(deps, "/v1/agents", "a-1", { raw: true });
  assert.match(raw.chip, /NOT redacted/);
});

test("clipboard failure falls back to execCommand", async () => {
  const doc = fakeDoc(true);
  const deps = {
    fetch: async () => reply("hello"),
    clipboard: {
      writeText: async () => {
        throw new Error("denied");
      },
    },
    doc,
  };
  const r = await T.copyTrace(deps, "/b", "a", {});
  assert.equal(r.ok, true);
  assert.equal(r.via, "execCommand");
  assert.deepEqual(doc.copied, ["hello"]);
  assert.equal(doc.body.children.length, 0, "temp textarea removed");
  const noClip = await T.copyTrace({ fetch: async () => reply("hi"), clipboard: undefined, doc: fakeDoc(true) }, "/b", "a", {});
  assert.equal(noClip.via, "execCommand");
});

test("both copy paths failing returns the text for the manual modal", async () => {
  for (const exec of [false, "throw"] as const) {
    const doc = fakeDoc(exec);
    const r = await T.copyTrace(
      {
        fetch: async () => reply("secret-free text <b>x</b>"),
        clipboard: {
          writeText: () => {
            throw new Error("sync");
          },
        },
        doc,
      },
      "/b",
      "a",
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.text, "secret-free text <b>x</b>");
    assert.match(r.error, /manually/);
    const m = T.modal(doc, r.text, r.error);
    const box = m.children[0];
    const ta = box.children.find((c: any) => c.tag === "textarea");
    assert.equal(ta.value, "secret-free text <b>x</b>"); // set via .value, never markup
    assert.equal(ta.selected, true);
    assert.equal(box.children[0].textContent, r.error);
    assert.ok(doc.body.children.includes(m));
    box.children.find((c: any) => c.tag === "button").listeners.click();
    assert.ok(!doc.body.children.includes(m), "close removes the modal");
  }
});

test("HTTP and network errors are reported without a clipboard write", async () => {
  let wrote = false;
  const clipboard = {
    writeText: async () => {
      wrote = true;
    },
  };
  const a = await T.copyTrace({ fetch: async () => reply("", 401), clipboard, doc: fakeDoc(true) }, "/b", "a", {});
  assert.match(a.error, /Not signed in/);
  const b = await T.copyTrace({ fetch: async () => reply("", 500), clipboard, doc: fakeDoc(true) }, "/b", "a", {});
  assert.match(b.error, /HTTP 500/);
  const c = await T.copyTrace(
    {
      fetch: async () => {
        throw new Error("offline");
      },
      clipboard,
      doc: fakeDoc(true),
    },
    "/b",
    "a",
    {},
  );
  assert.match(c.error, /offline/);
  assert.equal(wrote, false);
});

test("download builds a markdown blob link and revokes the URL", () => {
  const doc = fakeDoc(true);
  const log: string[] = [];
  class FakeBlob {
    parts: unknown[];
    type: string;
    constructor(p: unknown[], o: { type: string }) {
      this.parts = p;
      this.type = o.type;
    }
  }
  const deps = {
    doc,
    Blob: FakeBlob,
    URL: {
      createObjectURL: (b: FakeBlob) => {
        log.push("create:" + b.type);
        return "blob:1";
      },
      revokeObjectURL: (u: string) => log.push("revoke:" + u),
    },
  };
  const name = T.download(deps, "text", T.filename("a/1", { short: true }));
  assert.equal(name, "trace-a_1-short.md");
  assert.deepEqual(log, ["create:text/markdown", "revoke:blob:1"]);
  const a = doc.created.find((n: any) => n.tag === "a");
  assert.equal(a.clicked, true);
  assert.equal(a.attrs.download, "trace-a_1-short.md");
});

test("terminal declaration exposes Copy trace, Short, options (children/raw caution) and Download, wired to the trace logic", async () => {
  const { TERMINAL_DECLARATION } = await import("./viewMenus.ts");
  const { renderTerminalPane } = await import("./tabs.ts");
  const items = (TERMINAL_DECLARATION.menus ?? []).flatMap((m: any) => m.items).filter((i: any) => i.command?.startsWith("terminal.trace-"));
  const byCmd = (c: string): any => items.find((i: any) => i.command === c);
  assert.equal(byCmd("terminal.trace-copy")?.label, "Copy trace");
  assert.equal(byCmd("terminal.trace-short")?.label, "Short");
  assert.equal(byCmd("terminal.trace-download")?.label, "Download .md");
  assert.equal(byCmd("terminal.trace-children")?.kind, "toggle");
  const raw = byCmd("terminal.trace-raw");
  assert.equal(raw?.kind, "toggle");
  assert.match(raw.label, /no redaction/);
  assert.match(raw.caution, /skips secret redaction/); // the raw-output warning
  assert.equal(raw.checked, false); // raw is off until confirmed
  const html = renderTerminalPane();
  assert.match(html, /const T = /); // trace logic is inlined into the pane script
  for (const c of ["trace-copy", "trace-short", "trace-download", "trace-children", "trace-raw"]) assert.ok(html.includes(`"terminal.${c}":`), c); // each command is wired in the script
});

beforeEach(() => T.dismissLive()); // the viewer is a singleton; each test starts with none live

const settle = () => new Promise((r) => setTimeout(r, 0));
const viewDeps = (over: Record<string, unknown> = {}, urls: string[] = []) => ({
  fetch: async (u: string) => {
    urls.push(u);
    return reply("# Trace\n<b>line</b>", 200, { "x-trace-events": "7", "x-trace-omitted": "0", "x-trace-redacted": "2" });
  },
  clipboard: { writeText: async () => {} },
  doc: fakeDoc(true),
  ...over,
});

test("view returns text and header counts; option flags reach the URL; errors carry the cause", async () => {
  const urls: string[] = [];
  const r = await T.view(viewDeps({}, urls), "/v1/agents", "a-1", { short: true, children: true, raw: true });
  assert.equal(r.ok, true);
  assert.equal(r.text, "# Trace\n<b>line</b>");
  assert.deepEqual({ ...r.meta }, { bytes: 19, events: 7, omitted: 0, redacted: 2, raw: true });
  assert.deepEqual(urls, ["/v1/agents/a-1/trace?format=md&short=1&include=children&raw=1"]);
  const plain: string[] = [];
  await T.view(viewDeps({}, plain), "/v1/agents", "a-1", {});
  assert.deepEqual(plain, ["/v1/agents/a-1/trace?format=md"]); // negative control: no flags unless asked
  assert.match((await T.view({ fetch: async () => reply("", 401) }, "/b", "a", {})).error, /Not signed in/);
  assert.match((await T.view({ fetch: async () => reply("", 500) }, "/b", "a", {})).error, /HTTP 500/);
  const off = await T.view(
    {
      fetch: async () => {
        throw new Error("offline");
      },
    },
    "/b",
    "a",
    {},
  );
  assert.equal(off.ok, false);
  assert.match(off.error, /offline/);
});

test("metaText shows size and counts, says NOT redacted for raw, and reports omitted events only when > 0", () => {
  assert.equal(T.metaText({ bytes: 2048, events: 12, omitted: 0, redacted: 3, raw: false }), "2.0 KB \u00b7 12 events \u00b7 3 redacted");
  assert.match(T.metaText({ bytes: 2048, events: 12, omitted: 0, redacted: 3, raw: true }), /NOT redacted/);
  assert.doesNotMatch(T.metaText({ bytes: 2048, events: 12, omitted: 0, redacted: 3, raw: true }), /3 redacted/);
  assert.match(T.metaText({ bytes: 2048, events: 12, omitted: 60, redacted: 0, raw: false }), /60 events omitted/);
  assert.doesNotMatch(T.metaText({ bytes: 2048, events: 12, omitted: 0, redacted: 0, raw: false }), /omitted/);
});

test("viewer opens as a labelled modal dialog, shows loading then text (via textContent) and counts, focuses Close", async () => {
  const deps = viewDeps();
  const opener = el("button");
  const v = T.viewer(deps, "/v1/agents", "a-1", {}, opener);
  const { body, meta, status, retry, close } = v.parts;
  assert.equal(v.overlay.attrs.role, "dialog");
  assert.equal(v.overlay.attrs["aria-modal"], "true");
  assert.equal(v.overlay.attrs["aria-labelledby"], "term-trace-view-title");
  assert.ok(deps.doc.body.children.includes(v.overlay));
  assert.equal(body.textContent, "Loading trace\u2026");
  assert.equal(close.focused, 1);
  await settle();
  assert.equal(body.textContent, "# Trace\n<b>line</b>"); // markup stays text
  assert.equal(meta.textContent, "0.0 KB \u00b7 7 events \u00b7 2 redacted");
  assert.equal(status.textContent, "");
  assert.equal(retry.hidden, true);
});

test("Escape, backdrop click and Close dismiss and return focus to the opener; clicks inside the box and other keys do not", async () => {
  for (const how of ["escape", "backdrop", "close"] as const) {
    const deps = viewDeps();
    const opener = el("button");
    const v = T.viewer(deps, "/b", "a", {}, opener);
    await settle();
    deps.doc.key("Enter");
    v.overlay.listeners.click({ target: v.parts.body });
    assert.ok(deps.doc.body.children.includes(v.overlay), "negative control: stays open");
    assert.equal(opener.focused, undefined);
    if (how === "escape")
      deps.doc.key("Escape"); // document-level: works wherever focus is
    else if (how === "backdrop") v.overlay.listeners.click({ target: v.overlay });
    else v.parts.close.listeners.click();
    assert.ok(!deps.doc.body.children.includes(v.overlay), how);
    assert.equal(opener.focused, 1, how);
    assert.equal(deps.doc.keyListeners.length, 0, "Escape listener removed on close");
    v.dismiss(); // idempotent
    assert.equal(opener.focused, 1);
  }
});

test("failed fetch shows the cause with Retry; Retry refetches and recovers", async () => {
  let n = 0;
  const deps = viewDeps({
    fetch: async () => {
      if (n++ === 0) return reply("", 500);
      return reply("ok text", 200, { "x-trace-events": "1" });
    },
  });
  const v = T.viewer(deps, "/b", "a", {}, el("button"));
  await settle();
  const { body, status, retry, meta } = v.parts;
  assert.equal(status.textContent, "Trace failed: HTTP 500");
  assert.equal(retry.hidden, false);
  assert.equal(body.textContent, "");
  retry.listeners.click();
  assert.equal(retry.hidden, true);
  assert.equal(body.textContent, "Loading trace\u2026");
  await settle();
  assert.equal(body.textContent, "ok text");
  assert.equal(status.textContent, "");
  assert.match(meta.textContent, /1 events/);
  assert.equal(n, 2);
});

test("Refresh refetches the same URL; a superseded or post-close response is ignored", async () => {
  const urls: string[] = [];
  const resolvers: ((r: unknown) => void)[] = [];
  const deps = viewDeps({
    fetch: (u: string) => {
      urls.push(u);
      return new Promise((res) => resolvers.push(res));
    },
  });
  const v = T.viewer(deps, "/b", "a", { children: true }, el("button"));
  v.parts.refresh.listeners.click(); // second request supersedes the first
  assert.deepEqual(urls, ["/b/a/trace?format=md&include=children", "/b/a/trace?format=md&include=children"]);
  resolvers[1]!(reply("new"));
  await settle();
  resolvers[0]!(reply("old"));
  await settle();
  assert.equal(v.parts.body.textContent, "new"); // stale reply did not overwrite
  v.parts.refresh.listeners.click();
  v.dismiss();
  resolvers[2]!(reply("late"));
  await settle();
  assert.equal(v.parts.body.textContent, "Loading trace\u2026"); // closed: untouched
});

test("in-viewer Copy writes the shown text through the clipboard helper and reports; failure says copy manually", async () => {
  const written: string[] = [];
  const deps = viewDeps({
    clipboard: {
      writeText: async (t: string) => {
        written.push(t);
      },
    },
  });
  const v = T.viewer(deps, "/b", "a", {}, el("button"));
  assert.equal(v.parts.copy.disabled, true); // nothing to copy while loading
  await settle();
  assert.equal(v.parts.copy.disabled, false);
  v.parts.copy.listeners.click();
  await settle();
  assert.deepEqual(written, ["# Trace\n<b>line</b>"]);
  assert.match(v.parts.status.textContent, /^Copied /);
  T.dismissLive();
  const bad = viewDeps({ clipboard: undefined, doc: fakeDoc(false) });
  const w = T.viewer(bad, "/b", "a", {}, el("button"));
  await settle();
  w.parts.copy.listeners.click();
  await settle();
  assert.match(w.parts.status.textContent, /manually/);
});

test("terminal declaration has View trace between Copy trace and Short and the viewer logic is inlined", async () => {
  const { TERMINAL_DECLARATION } = await import("./viewMenus.ts");
  const { renderTerminalPane } = await import("./tabs.ts");
  const cmds = (TERMINAL_DECLARATION.menus ?? []).flatMap((m: any) => m.items).map((i: any) => i.command);
  const view = cmds.indexOf("terminal.trace-view");
  assert.ok(view > 0 && cmds.indexOf("terminal.trace-copy") < view && view < cmds.indexOf("terminal.trace-short"));
  assert.equal((TERMINAL_DECLARATION.menus ?? []).flatMap((m: any) => m.items).find((i: any) => i.command === "terminal.trace-view").label, "View trace");
  const html = renderTerminalPane();
  assert.match(html, /"terminal\.trace-view": viewTrace/);
  assert.match(html, /TODO\(trace-view-autorefresh\)/);
});

test("a second open reuses the live viewer (one overlay); after close a new one opens", async () => {
  const deps = viewDeps();
  const a = T.viewer(deps, "/b", "a", {}, el("button"));
  const b = T.viewer(deps, "/b", "other", {}, el("button"));
  assert.equal(b, a);
  assert.equal(deps.doc.body.children.length, 1);
  assert.equal(deps.doc.keyListeners.length, 1);
  T.dismissLive();
  assert.equal(deps.doc.body.children.length, 0);
  const c = T.viewer(deps, "/b", "a", {}, el("button"));
  assert.notEqual(c, a);
  T.dismissLive();
  T.dismissLive(); // no live viewer: no-op
});

test("a Copy that resolves after a Refresh or Close does not write a stale status", async () => {
  let release: () => void = () => {};
  const deps = viewDeps({
    clipboard: {
      writeText: () =>
        new Promise<void>((r) => {
          release = r;
        }),
    },
  });
  const v = T.viewer(deps, "/b", "a", {}, el("button"));
  await settle();
  v.parts.copy.listeners.click();
  v.parts.refresh.listeners.click();
  release();
  await settle();
  assert.equal(v.parts.status.textContent, "", "superseded by Refresh");
  await settle();
  v.parts.copy.listeners.click();
  v.dismiss();
  release();
  await settle();
  assert.equal(v.parts.status.textContent, "", "closed");
});
