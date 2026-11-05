import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { TabRegistry, renderShell } from "./shell.ts";
import type { UiTabCtx } from "./shell.ts";
import { renderTreePane, renderReportsPane, scriptJson } from "./web.ts";

test("an #/escalations route activates the Inbox tab when no separate escalations tab is registered", () => {
  for (const hasEscalations of [false, true]) {
    const ids = ["tree", "inbox", ...(hasEscalations ? ["escalations"] : [])];
    const sections = ids.map((id) => ({ getAttribute: () => id }));
    const html = renderShell({ tabs: ids.map((id) => ({ id, title: id, render: () => "" })) });
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1]!;
    const shown: { id: string; target: unknown }[] = [];
    runInNewContext(script, {
      location: { hash: "#/escalations/e1" },
      document: { querySelectorAll: () => sections, getElementById: () => ({ addEventListener: () => {} }) },
      addEventListener: () => {},
      UI: { show: (id: string, target: unknown) => shown.push({ id, target }) },
    });
    assert.equal(shown[0]!.id, hasEscalations ? "escalations" : "inbox");
    assert.equal(shown[0]!.target, sections.at(-1));
  }
});

test("renderShell emits the nav, the hidden sections, and the UI runtime", () => {
  const html = renderShell({
    title: "observe",
    tabs: [
      { id: "live", title: "Live", render: () => "<table></table>" },
      { id: "reports", title: "Reports", shortTitle: "Rep", render: () => "<p>r</p>" },
    ],
  });
  assert.ok(html.includes("<title>observe</title>"));
  assert.ok(html.includes('<nav class="top"'));
  assert.ok(html.includes('<nav class="bottom"'));
  assert.ok(html.includes('href="#/live"'));
  assert.ok(html.includes('href="#/reports"'));
  assert.ok(html.includes('<section data-tab="live" hidden>'));
  assert.ok(html.includes('<section data-tab="reports" hidden>'));
  assert.ok(html.includes("const UI = {"));
  assert.ok(html.includes("fns"));
  assert.ok(html.includes("deactivators"));
  assert.ok(html.includes("active"));
  assert.ok(html.includes("register(id, activate, deactivate)"));
  assert.ok(html.includes("show(id, target)"));
  assert.ok(html.includes("hashchange"));
  assert.ok(html.includes("@media (max-width: 640px)"));
  // The short title only labels the bottom (narrow) nav.
  assert.ok(html.includes(">Rep</a>"));
  assert.ok(html.includes(">Reports</a>"));
  assert.ok(!html.includes("src=")); // no external script or stylesheet, no build step
});

test("tabs render their fragment and receive a ctx that prefixes paths and hashes routes", () => {
  const seen: { path: string; href: string }[] = [];
  const html = renderShell({
    prefix: "/ob",
    tabs: [
      {
        id: "live",
        title: "Live",
        render: (ctx) => {
          seen.push({ path: ctx.path("events"), href: ctx.href("/live") });
          return '<div data-pane="live">events</div>';
        },
      },
    ],
  });
  assert.ok(html.includes('<div data-pane="live">events</div>'));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.path, "/ob/events");
  assert.equal(seen[0]!.href, "#/live");
});

test("TabRegistry records and lists tabs in registration order", () => {
  const r = new TabRegistry();
  const a = { id: "a", title: "A", render: () => "" };
  const b = { id: "b", title: "B", render: () => "" };
  r.register(a);
  r.register(b);
  assert.deepEqual(r.list(), [a, b]);
});

test("renderShell escapes titles and ids and JSON-escapes ctx paths into inline scripts", () => {
  const html = renderShell({
    prefix: "/p",
    tabs: [
      {
        id: 'a"b<c>',
        title: '<b>&"q"',
        render: (ctx) => `<script>const p = ${scriptJson(ctx.path("x</script>\u2028"))};</script>`,
      },
    ],
  });
  // Title is HTML-escaped.
  assert.ok(html.includes("&#60;b&#62;&#38;&#34;q&#34;"));
  assert.ok(!html.includes("<b>&"));
  // Id is HTML-escaped in the section attribute and the nav href.
  assert.ok(html.includes('data-tab="a&#34;b&#60;c&#62;"'));
  assert.ok(html.includes('href="#/a&#34;b&#60;c&#62;"'));
  // The ctx.path value cannot close the script or inject a raw line separator.
  assert.ok(html.includes("\\u003c/script>"));
  assert.ok(!html.includes("x</script>"));
  assert.ok(!html.includes("\u2028"));
});

test("renderShell exposes the tree and reports panes as tab fragments", () => {
  const html = renderShell({
    prefix: "/ob",
    tabs: [
      { id: "live", title: "Live", render: (ctx) => renderTreePane({ eventsPath: ctx.path("events") }) },
      { id: "reports", title: "Reports", render: (ctx) => renderReportsPane({ reportsPath: ctx.path("reports") }) },
    ],
  });
  assert.ok(html.includes('K.stream("/ob/events"'));
  assert.ok(html.includes('K.getJson("/ob/reports")'));
  assert.ok(html.includes("AGENT</th><th>NAME"));
});

test("ctx.path keeps relative paths relative when no prefix is set", () => {
  let ctx: UiTabCtx | undefined;
  renderShell({
    tabs: [
      {
        id: "x",
        title: "X",
        render: (c) => {
          ctx = c;
          return "";
        },
      },
    ],
  });
  assert.equal(ctx!.path("events"), "events");
  assert.equal(ctx!.path("/live/events"), "/live/events");
  assert.equal(ctx!.href("/live"), "#/live");
});

test("TabRegistry rejects duplicate and malformed tab ids", () => {
  const r = new TabRegistry();
  const t = (id: string) => ({ id, title: id, render: () => "" });
  r.register(t("a"));
  assert.throws(() => r.register(t("a")), /duplicate/);
  for (const bad of ["", "a/b", 'x"y', "a b"]) assert.throws(() => r.register(t(bad)), /invalid/);
});

test("auth guard fires once on a 401 fetch and probes on EventSource error", async () => {
  const { AUTH_GUARD_SCRIPT } = await import("./shell.ts");
  const install = new Function(`${AUTH_GUARD_SCRIPT}; return installAuthGuard;`)();
  const calls: string[] = [];
  const handlers: Array<() => void> = [];
  class ES {
    addEventListener(_: string, h: () => void) {
      handlers.push(h);
    }
  }
  const g: any = {
    fetch: async (u: string) => {
      calls.push(u);
      return { status: u === "/probe" || u === "/x" ? 401 : 200 };
    },
    EventSource: ES,
  };
  let fired = 0;
  install(
    g,
    () => {
      fired++;
    },
    "/probe",
  );
  await g.fetch("/ok");
  assert.equal(fired, 0);
  new g.EventSource("/s");
  handlers[0]!();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ["/ok", "/probe"]);
  assert.equal(fired, 1);
  await g.fetch("/x");
  assert.equal(fired, 1);
});
