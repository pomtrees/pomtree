// SCH-4, GIT-6, GIT-4 and YLD-4 of cli-operator.test.ts (same harness, helpers in cli-operator-kit.ts; split so node --test runs the files in parallel).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { POMTREED_KINDS } from "@pomtree/core";
import type { ModelScript } from "@pomtree/testing";
import { freePort, showAgent } from "./cli-crash.ts";
import { formatYieldEvidence, Timeline } from "./operator-evidence.ts";
import { callReply, lineValue, SKIP, spawnAgent, summaryOf, TIMEOUT, textReply, toolLines, waitDone, withStack } from "./cli-operator-kit.ts";

// SCH-4: reports publish, list, show, render safely and delete. The render route is checked at header level over the UI listener, logged in
// the way a browser is (POST /ui/login with the operator token in state/operator.token, then the HttpOnly session cookie). The real-browser
// half (the <script> in r.html not running in the UI) is not covered: TODO(harness-browser-report) belongs with the browser suites.
test("cli operator SCH-4: md, html and svg reports publish and list; the render route sandboxes and blocks scripts and network; rm deletes", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const MD = "# hello report";
  const HTML = '<!doctype html><html><body><script>document.title="ran"</script><p>hi</p></body></html>';
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>1</script><rect width="4" height="4"/></svg>';
  const script: ModelScript = {
    name: "sch4",
    rules: [
      {
        id: "publish",
        when: { toolResults: 0 },
        reply: callReply(
          `printf '%s' '${MD}' > /tmp/r.md; printf '%s' '${HTML}' > /tmp/r.html; printf '%s' '${SVG}' > /tmp/r.svg; ` +
            "for f in r.md r.html r.svg; do pomtree report publish /tmp/$f --name $f; echo pub-$f=$?; done",
        ),
      },
      { id: "hold", when: { toolResults: 1 }, reply: callReply("sleep 240; echo held") },
    ],
  };
  const uiPort = await freePort();
  await withStack({ script, set: { "ui.listen": `127.0.0.1:${uiPort}` } }, async (s) => {
    const a = await spawnAgent(s, { task: "[[scn:sch4]] publish three reports", name: "reporter", budget: 500_000 });
    await s.until("three reports", async () => (await s.pomtree(["report", "list", a.id])).json<unknown[]>().length === 3, 120_000);
    const list = (await s.pomtree(["report", "list", a.id])).json<{ id: string; name: string; mediaType: string }[]>();
    t.diagnostic(`reports: ${list.map((r) => `${r.name}=${r.mediaType}`).join(", ")}`);
    const byName = Object.fromEntries(list.map((r) => [r.name, r]));
    assert.deepEqual(Object.keys(byName).sort(), ["r.html", "r.md", "r.svg"]);
    assert.equal(byName["r.html"]!.mediaType, "text/html");

    // show --out returns the published bytes.
    const dir = mkdtempSync(join(tmpdir(), "sch4-"));
    try {
      for (const [name, bytes] of [
        ["r.md", MD],
        ["r.html", HTML],
        ["r.svg", SVG],
      ] as const) {
        const out = join(dir, name);
        const shown = await s.pomtree(["report", "show", a.id, byName[name]!.id, "--out", out]);
        assert.equal(shown.code, 0, `report show ${name}: exit ${shown.code}: ${shown.err}`);
        assert.equal(readFileSync(out, "utf8"), bytes, `${name}: show --out must return the published bytes`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Log in to the UI listener as a browser would; the token is read programmatically and never printed.
    const base = `http://127.0.0.1:${uiPort}`;
    const token = readFileSync(join(s.stateDir, "operator.token"), "utf8").trim();
    const login = await fetch(`${base}/ui/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    assert.equal(login.status, 200, `ui login: expected 200, got ${login.status}`);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.ok(cookie.includes("="), "ui login must set a session cookie");
    const render = (rid: string, withCookie = true) =>
      fetch(`${base}/v1/agents/${a.id}/reports/${rid}/render`, { headers: withCookie ? { cookie } : {}, redirect: "manual" });

    assert.equal((await render(byName["r.html"]!.id, false)).status, 401, "the render route must refuse a request with no session");
    const html = await render(byName["r.html"]!.id);
    assert.equal(html.status, 200);
    const csp = html.headers.get("content-security-policy") ?? "";
    const dirs = new Map(
      csp
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const [k, ...v] = d.split(/\s+/);
          return [k!, v.join(" ")] as const;
        }),
    );
    t.diagnostic(
      `render headers: csp=${csp}; content-type=${html.headers.get("content-type")}; content-disposition=${html.headers.get("content-disposition")}`,
    );
    assert.ok(dirs.has("sandbox"), `CSP must carry a sandbox directive, got ${csp}`);
    assert.equal(dirs.get("sandbox"), "", "sandbox must be empty (no allow-* token)");
    assert.equal(dirs.get("default-src"), "'none'");
    assert.ok(!dirs.has("script-src") && !dirs.has("connect-src"), "no script or network grant");
    assert.equal(dirs.get("img-src"), "data:");
    assert.equal(dirs.get("form-action"), "'none'");
    assert.ok(!csp.includes("allow-") && !csp.includes("unsafe-eval"), csp);
    assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(html.headers.get("x-content-type-options"), "nosniff");
    // Observed for the other two media types (recorded, not asserted beyond "not a 5xx"): the unit test pins md to 415.
    const md = await render(byName["r.md"]!.id);
    const svg = await render(byName["r.svg"]!.id);
    t.diagnostic(
      `render r.md: ${md.status} ${md.headers.get("content-type")}; render r.svg: ${svg.status} ${svg.headers.get("content-type")} csp=${svg.headers.get("content-security-policy")}`,
    );
    assert.ok(md.status < 500 && svg.status < 500);
    if (svg.status === 200) assert.ok((svg.headers.get("content-security-policy") ?? "").includes("sandbox"), "a rendered svg must also be sandboxed");

    // rm deletes it; the other two remain.
    const rm = await s.pomtree(["report", "rm", a.id, byName["r.html"]!.id]);
    assert.equal(rm.code, 0, `report rm: exit ${rm.code}: ${rm.out} ${rm.err}`);
    assert.deepEqual(
      (await s.pomtree(["report", "list", a.id]))
        .json<{ name: string }[]>()
        .map((r) => r.name)
        .sort(),
      ["r.md", "r.svg"],
    );
    assert.equal((await render(byName["r.html"]!.id)).status, 404, "a removed report must no longer render");
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// GIT-6: uncommitted work blocks `pomtree result` until it is approved with the snapshot token; a token goes stale when the file changes.
test("cli operator GIT-6: uncommitted work refuses pomtree result (exit 5, snapshot token), a stale token is refused, the fresh token saves and ingests", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const tokenOf = (file: string) => `sed -n 's/.*--save-uncommitted \\([0-9a-zA-Z]*\\).*/\\1/p' ${file} | head -1`;
  const script: ModelScript = {
    name: "git6",
    rules: [
      {
        id: "blocked",
        when: { toolResults: 0 },
        reply: callReply(
          `echo cwd=$(pwd); echo one > f.txt; pomtree result --summary x > /tmp/o1 2>&1; echo blocked-exit=$?; cat /tmp/o1; ${tokenOf("/tmp/o1")} > /tmp/tok1; echo tok1=$(cat /tmp/tok1)`,
        ),
      },
      {
        id: "stale",
        when: { toolResults: 1 },
        reply: callReply(
          `echo two >> f.txt; pomtree result --summary x --save-uncommitted $(cat /tmp/tok1) > /tmp/o2 2>&1; echo stale-exit=$?; cat /tmp/o2; ${tokenOf("/tmp/o2")} > /tmp/tok2; echo tok2=$(cat /tmp/tok2)`,
        ),
      },
      { id: "approved", when: { toolResults: 2 }, reply: callReply("pomtree result --summary x --save-uncommitted $(cat /tmp/tok2); echo final-exit=$?") },
      { id: "done", when: { toolResults: 3 }, reply: textReply("STUB-DONE") },
    ],
  };
  await withStack({ script }, async (s) => {
    const a = await spawnAgent(s, { task: "[[scn:git6]] leave a file uncommitted", name: "dirty", budget: 500_000 });
    const rec = await waitDone(s, a.id);
    const lines = await toolLines(s, a.id);
    t.diagnostic(`cwd ${lineValue(lines, "cwd")}; blocked message: ${lines.find((l) => l.includes("uncommitted work"))}`);
    assert.equal(lineValue(lines, "blocked-exit"), "5", `first result: expected exit 5, got ${lineValue(lines, "blocked-exit")}`);
    const tok1 = lineValue(lines, "tok1");
    const tok2 = lineValue(lines, "tok2");
    assert.ok(tok1 && tok1.length > 8, `the refusal must carry a snapshot token, got ${JSON.stringify(tok1)}`);
    assert.equal(lineValue(lines, "stale-exit"), "5", `stale token: expected exit 5, got ${lineValue(lines, "stale-exit")}`);
    assert.ok(tok2 && tok2 !== tok1, `the changed file needs a fresh token: old ${tok1}, new ${tok2}`);
    // Observed: the stale-token refusal is the same "uncommitted work" refusal, now naming the fresh token (the file is still dirty).
    assert.ok(
      lines.some((l) => l.startsWith("pomtree: uncommitted work") && l.includes(tok2!)),
      "the stale-token refusal must name the fresh token",
    );
    assert.equal(lineValue(lines, "final-exit"), "0", `approved retry: expected exit 0, got ${lineValue(lines, "final-exit")}`);
    assert.equal(rec.exit, "succeeded", JSON.stringify(rec));
    assert.equal(summaryOf(rec), "x");
    assert.equal((await s.kinds(a.id, POMTREED_KINDS.result)).length, 1, "exactly one recorded result (the refused calls recorded none)");
    const approved = await s.kinds(a.id, POMTREED_KINDS.resultSaveApproved);
    assert.deepEqual(
      approved.map((e) => e.payload.fingerprint),
      [tok2],
      "only the fresh token is journaled as an approved save",
    );
    const kinds = (await s.events(a.id)).map((e) => String(e.payload.kind));
    t.diagnostic(`journal kinds: ${[...new Set(kinds)].join(", ")}`);
    assert.ok(kinds.includes("ingested"), `the approved save must be ingested, journal kinds: ${[...new Set(kinds)]}`);
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// GIT-4: work leaves a clone only through `pomtree push`, into the agent's own refs only. Agent B pushes (ingested), rewrites its history and
// pushes without --force (refused, exit 5, non_fast_forward; --force is operator-only, so an agent has no way around it), then pulls a
// sibling's work with `pomtree pull --from SIBLING` (refused, 403, exit 4). `pomtree peers` lists only self, parent and children, so the
// sibling's id reaches agent B by filling in the pull rule's command once the sibling exists (the stub reads its rules on every request). The sibling pushed one commit of its own and then sleeps.
test("cli operator GIT-4: pomtree push ingests, a rewritten history is refused without --force (exit 5), pulling a sibling is refused (exit 4)", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const commit = (file: string, msg: string) => `echo ${msg} > ${file}; git add ${file}; git -c user.name=t -c user.email=t@example.org commit -q -m ${msg}`;
  const script: ModelScript = {
    name: "git4",
    rules: [
      {
        id: "sibling-push",
        when: { lastUserIncludes: "[[scn:git4sib]]", toolResults: 0 },
        reply: callReply(`${commit("s.txt", "sibling")}; pomtree push; echo sibling-push-exit=$?`),
      },
      { id: "sibling-hold", when: { lastUserIncludes: "[[scn:git4sib]]", toolResults: 1 }, reply: callReply("sleep 240; echo held") },
      { id: "push1", when: { toolResults: 0 }, reply: callReply(`${commit("a.txt", "one")}; pomtree push > /tmp/p1 2>&1; echo push1-exit=$?; cat /tmp/p1`) },
      {
        id: "rewrite",
        when: { toolResults: 1 },
        reply: callReply(
          "git -c user.name=t -c user.email=t@example.org commit -q --amend -m rewritten; pomtree push > /tmp/p2 2>&1; echo push2-exit=$?; cat /tmp/p2; echo head=$(git rev-parse --short HEAD)",
        ),
      },
      { id: "pull-sibling", when: { toolResults: 2 }, reply: callReply("echo sibling-id-not-set") },
      { id: "result", when: { toolResults: 3 }, reply: callReply("pomtree result --summary 'git4 done'; echo result-exit=$?") },
      { id: "done", when: { toolResults: 4 }, reply: textReply("STUB-DONE") },
    ],
  };
  await withStack({ script }, async (s) => {
    const sib = await spawnAgent(s, { task: "[[scn:git4sib]] push then hold", name: "sibling", budget: 300_000 });
    await s.until("the sibling's push", async () => (await s.kinds(sib.id, "ingested")).length === 1, 120_000);
    script.rules.find((r) => r.id === "pull-sibling")!.reply = callReply(
      `echo sib=${sib.id}; pomtree pull --from ${sib.id} > /tmp/p3 2>&1; echo pull-sibling-exit=$?; cat /tmp/p3`,
    );
    const a = await spawnAgent(s, { task: "[[scn:git4b]] push, rewrite, pull", name: "pusher", budget: 300_000 });
    const rec = await waitDone(s, a.id);
    const lines = await toolLines(s, a.id);
    t.diagnostic(
      `push1: ${lines
        .slice(
          lines.findIndex((l) => l.startsWith("push1-exit")),
          lines.findIndex((l) => l.startsWith("push1-exit")) + 3,
        )
        .join(" | ")}`,
    );
    t.diagnostic(`push2: ${lines.filter((l) => l.includes("non_fast_forward")).join(" | ")}`);
    t.diagnostic(
      `pull sibling: ${lines
        .slice(
          lines.findIndex((l) => l.startsWith("pull-sibling-exit")),
          lines.findIndex((l) => l.startsWith("pull-sibling-exit")) + 3,
        )
        .join(" | ")}`,
    );
    assert.equal(lineValue(lines, "push1-exit"), "0", `first push: expected exit 0, got ${lineValue(lines, "push1-exit")}`);
    assert.ok(
      lines.some((l) => l.includes(`agent/${a.id}`)),
      "the first push must print its ingested ref agent/<id>",
    );
    assert.equal((await s.kinds(a.id, "ingested")).length >= 1, true, "the first push must be journaled as ingested");
    assert.equal(lineValue(lines, "push2-exit"), "5", `rewritten history without --force: expected exit 5, got ${lineValue(lines, "push2-exit")}`);
    assert.ok(
      lines.some((l) => l.includes("non_fast_forward")),
      "the refusal must name non_fast_forward",
    );
    assert.equal((await s.kinds(a.id, "ingested")).length, 1, "the refused push must not add an ingest");
    assert.equal(lineValue(lines, "pull-sibling-exit"), "4", `pull --from a sibling: expected exit 4, got ${lineValue(lines, "pull-sibling-exit")}`);
    assert.equal(lineValue(lines, "sib"), sib.id);
    assert.equal(lineValue(lines, "result-exit"), "0");
    assert.equal(rec.exit, "succeeded", JSON.stringify(rec));
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// YLD-4: `pomtree send ID TEXT --interrupt` aborts a running agent's turn (reply "interrupting") and wakes a yielded one ("woke"); either way
// the next model request carries the text and the generation is bumped once (one `resumed` entry, no double resume).
test("cli operator YLD-4: --interrupt replies interrupting on a running agent and woke on a yielded one; the text reaches the next request; one resume each", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const script: ModelScript = {
    name: "yld4",
    rules: [
      { id: "run-result", when: { lastUserIncludes: "INT-RUN-31" }, times: 1, reply: callReply("pomtree result --summary 'interrupted ok'") },
      { id: "yield-result", when: { lastUserIncludes: "INT-YLD-47" }, times: 1, reply: callReply("pomtree result --summary 'woken ok'") },
      { id: "after", when: { lastUserIncludes: "INT-" }, reply: textReply("STUB-DONE") },
      { id: "busy", when: { lastUserIncludes: "[[scn:yld4run]]", toolResults: 0 }, reply: callReply("sleep 120; echo slept") },
      { id: "yield", when: { lastUserIncludes: "[[scn:yld4yld]]", toolResults: 0 }, reply: callReply("pomtree yield --until message") },
      { id: "parked", when: { toolResults: 1 }, reply: textReply("parked") },
    ],
  };
  // Flake instrumentation (YLD-4): on failure, or shortly before the test timeout, the error carries the journal rows with timestamps
  // beside a harness timeline, so a lost wake (no `resumed` after the send), a slow one (large gaps) and a wrong row (extra `resumed`,
  // generation off) read differently. The success path writes nothing.
  await withStack({ script }, async (s) => {
    const tl = new Timeline();
    const ids: Record<string, string> = {};
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`body still running ${TIMEOUT - 20_000}ms in; aborted before the test timeout to keep the evidence`)),
        TIMEOUT - 20_000,
      );
    });
    const body = async () => {
      const run = await spawnAgent(s, { task: "[[scn:yld4run]] run a long tool", name: "runner", budget: 300_000 });
      const yld = await spawnAgent(s, { task: "[[scn:yld4yld]] yield", name: "yielder", budget: 300_000 });
      ids.runner = run.id;
      ids.yielder = yld.id;
      tl.mark(`spawned runner ${run.id} and yielder ${yld.id}`);
      await s.until(
        "the runner inside its tool and the yielder parked",
        async () => s.stub.calls.some((c) => c.matched === "busy") && (await showAgent(s, yld.id)).state === "yielded",
        120_000,
      );
      tl.mark("runner in its tool and yielder yielded");
      const genRun = (await showAgent(s, run.id)).generation;
      const genYld = (await showAgent(s, yld.id)).generation;

      tl.mark(`gen before: runner ${genRun}, yielder ${genYld}`);
      const sentRun = await s.pomtree(["send", run.id, "INT-RUN-31 finish now", "--interrupt"]);
      assert.equal(sentRun.code, 0, `send --interrupt (running): exit ${sentRun.code}: ${sentRun.out} ${sentRun.err}`);
      tl.mark(`send --interrupt to runner returned: ${sentRun.out.trim()}`);
      assert.equal(sentRun.json<{ delivered: string }>().delivered, "interrupting");
      const sentYld = await s.pomtree(["send", yld.id, "INT-YLD-47 finish now", "--interrupt"]);
      assert.equal(sentYld.code, 0, `send --interrupt (yielded): exit ${sentYld.code}: ${sentYld.out} ${sentYld.err}`);
      tl.mark(`send --interrupt to yielder returned: ${sentYld.out.trim()}`);
      assert.equal(sentYld.json<{ delivered: string }>().delivered, "woke");

      const recRun = await waitDone(s, run.id);
      tl.mark("runner exited");
      const recYld = await waitDone(s, yld.id);
      tl.mark("yielder exited");
      assert.equal(recRun.exit, "succeeded", JSON.stringify(recRun));
      assert.equal(recYld.exit, "succeeded", JSON.stringify(recYld));
      for (const [what, rec, id, gen, ruleId, text] of [
        ["running", recRun, run.id, genRun, "run-result", "INT-RUN-31"],
        ["yielded", recYld, yld.id, genYld, "yield-result", "INT-YLD-47"],
      ] as const) {
        const first = s.stub.calls.filter((c) => c.matched === ruleId);
        t.diagnostic(`${what}: next request user text ${JSON.stringify(first[0]?.lastUserText?.slice(0, 160))}`);
        assert.equal(first.length, 1, `${what}: the text must reach the next model request exactly once`);
        assert.ok(first[0]!.lastUserText?.includes(text));
        assert.equal(rec.generation, gen + 1, `${what}: generation bumped once (was ${gen}, now ${rec.generation})`);
        assert.equal((await s.kinds(id, "resumed")).length, 1, `${what}: exactly one resume`);
        const done = await s.kinds(id, POMTREED_KINDS.interruptDone);
        assert.equal(done.length, 1, `${what}: the interrupt is journaled delivered once`);
      }
      assert.deepEqual(s.stub.unmatched, []);
    };
    try {
      await Promise.race([guard, body()]);
    } catch (e) {
      let evidence: string;
      try {
        const states = await Promise.all(Object.entries(ids).map(async ([k, id]) => `${k}: ${JSON.stringify(await showAgent(s, id))}`));
        evidence = `${states.join("\n")}\n${formatYieldEvidence(join(s.stateDir, "pomtreed.sqlite"), ids, tl)}`;
      } catch (x) {
        evidence = `could not collect the evidence: ${(x as Error).message}`;
      }
      throw new Error(`${(e as Error).message}\n--- YLD-4 evidence\n${evidence}`, { cause: e });
    } finally {
      clearTimeout(timer);
    }
  });
});
