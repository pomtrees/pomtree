import { test } from "node:test";
import assert from "node:assert/strict";
import { TabRegistry, renderShell } from "./shell.ts";
import type { UiTabCtx } from "./shell.ts";
import { renderTreePane, renderReportsPane, scriptJson } from "./web.ts";

test("renderShell emits the launcher bar, the hidden sections, and the UI runtime", () => {
  const html = renderShell({
    title: "observe",
    tabs: [
      { id: "live", title: "Live", render: () => "<table></table>" },
      { id: "reports", title: "Reports", render: () => "<p>r</p>" },
    ],
  });
  assert.ok(html.includes("<title>observe</title>"));
  assert.ok(html.includes('<header id="lb-bar" class="lb"></header>'));
  assert.ok(!html.includes("<nav"), "the top-level navigation is replaced by the launcher bar");
  assert.ok(!html.includes('href="#/live"'));
  assert.ok(html.includes('<section data-tab="live" hidden>'));
  assert.ok(html.includes('<section data-tab="reports" hidden>'));
  // Tiling shell: tile host, notice area, a stash holding the sections, layout controls and the activation runtime.
  assert.ok(html.includes('<body class="wm">'));
  assert.ok(html.includes('id="wm-root"'));
  assert.ok(html.includes('id="wm-notices"'));
  assert.ok(html.includes('<div id="wm-stash" hidden><section data-tab="live" hidden>'));
  for (const id of ["wm-export", "wm-import", "wm-reset", "wm-file", "signout"]) assert.ok(!html.includes(`id="${id}"`), id);
  assert.ok(html.includes("const UI = {"));
  assert.ok(html.includes("register(id, activate, deactivate)"));
  assert.ok(html.includes("activate(id)"));
  assert.ok(html.includes("deactivate(id)"));
  assert.ok(!html.includes("show(id, target)"), "UI.show is gone: several views can be active at once");
  assert.ok(html.includes("const LayoutKit"));
  assert.ok(html.includes("createWindowManager("));
  assert.ok(html.includes("hashchange"));
  assert.ok(html.includes("@media (max-width: 640px)"));
  // The launcher script is its own block after the layout script, and mounts on the window manager.
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const bar = scripts.find((x) => x.includes("createLauncherBar(wm, "));
  assert.ok(bar, "launcher script block present");
  assert.ok(!scripts.some((x) => x.includes("createWindowManager(") && x.includes("createLauncherBar(")));
  assert.ok(html.includes("const wm = createWindowManager("));
  assert.doesNotThrow(() => new Function(bar!), "launcher script parses");
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
  // The title only reaches the page as JSON in the tabs list, where "<" is escaped.
  assert.ok(html.includes('"title":"\\u003cb>&\\"q\\""'));
  assert.ok(!html.includes("<b>&"));
  // Id is HTML-escaped in the section attribute and JSON-escaped in the tabs list.
  assert.ok(html.includes('data-tab="a&#34;b&#60;c&#62;"'));
  assert.ok(html.includes('createWindowManager([{"id":"a\\"b\\u003cc>"'));
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

test("renderShell inlines the UI command kit and driver and starts the driver on the stream path in its own script block", () => {
  const html = renderShell({ tabs: [{ id: "live", title: "Live", render: () => "" }] });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const wiring = scripts.find((x) => x.includes("createUiDriver(wm, {"));
  assert.ok(wiring, "driver wiring block present");
  assert.ok(wiring!.includes('"/live/ui"'));
  assert.ok(!wiring!.includes("createLauncherBar("));
  assert.doesNotThrow(() => new Function(wiring!), "driver wiring parses");
  const main = scripts.find((x) => x.includes("createWindowManager("))!;
  assert.ok(main.includes("const UiCommandKit") && main.includes("function createUiDriver("));
  assert.ok(main.indexOf("const LayoutKit") < main.indexOf("const UiCommandKit"), "the kit comes after LayoutKit");
  assert.ok(scripts.indexOf(wiring!) > scripts.findIndex((x) => x.includes("createLauncherBar(wm, ")), "after the launcher bar");
  for (const x of scripts) assert.doesNotThrow(() => new Function(x), "every inline script parses");
});

test("tree and reports panes ship the shared skeleton and declare their window sections", () => {
  const html = renderShell({
    tabs: [
      { id: "tree", title: "Tree", render: () => renderTreePane() },
      { id: "reports", title: "Reports", render: () => renderReportsPane() },
    ],
  });
  assert.ok(html.includes('<div class="tree pane">\n<div class="tablewrap pane-body">'));
  assert.ok(html.includes('<div class="reports pane">\n<div class="tablewrap pane-body">'));
  assert.ok(html.includes('id: "tree"'));
  assert.ok(html.includes('id: "reports"'));
  assert.ok(!html.includes("+ New agent"));
});
