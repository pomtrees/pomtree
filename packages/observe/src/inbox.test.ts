import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { INBOX_JS, renderInboxPane } from "./inbox.ts";

test("inbox pane markup has no executable inline script; the static script paints via textContent only and has its hooks", () => {
  const html = renderInboxPane();
  assert.ok(html.includes('id="inbox"'));
  assert.ok(html.includes('id="inbox-status"'));
  assert.ok(html.includes('id="inbox-compose"'));
  assert.deepEqual(
    [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]),
    [' type="application/json" id="inbox-config"', ' src="/ui/inbox.js"'],
  );
  assert.ok(!/<script>/.test(html));
  assert.ok(!/\son\w+=/.test(html));
  assert.ok(INBOX_JS.includes("textContent"));
  assert.ok(!INBOX_JS.includes("innerHTML"));
  assert.ok(!INBOX_JS.includes("insertAdjacentHTML"));
  assert.ok(!html.includes("innerHTML"));
  assert.ok(!html.includes("href="));
  const cfg = JSON.parse(html.match(/<script type="application\/json" id="inbox-config">([\s\S]*?)<\/script>/)![1]!);
  assert.deepEqual(cfg, {
    messages: "/live/messages",
    approvals: "/v1/approvals",
    escalations: "/v1/escalations",
    reply: "/v1/ui/reply",
    agents: "/v1/agents",
  });
  assert.ok(INBOX_JS.includes('"?state=pending"') || INBOX_JS.includes("?state=pending"));
  assert.ok(INBOX_JS.includes('"X-Pomtree-UI": "1"'));
  assert.ok(INBOX_JS.includes("K.poll(refresh, 5000)"));
  assert.ok(INBOX_JS.includes("K.uuid()"));
  assert.ok(INBOX_JS.includes("EventSource"));
  assert.ok(!INBOX_JS.includes("localStorage"));
  assert.ok(INBOX_JS.includes("(?:inbox|escalations)")); // deep-link hook
  assert.ok(INBOX_JS.includes("hashchange"));
  assert.ok(INBOX_JS.includes("Already handled"));
  const custom = renderInboxPane({ messagesPath: "/m", approvalsPath: "/a", escalationsPath: "/e", replyPath: "/r", agentsPath: "/g" });
  assert.deepEqual(JSON.parse(custom.match(/id="inbox-config">([\s\S]*?)<\/script>/)![1]!), {
    messages: "/m",
    approvals: "/a",
    escalations: "/e",
    reply: "/r",
    agents: "/g",
  });
});

test("inbox pane paths are JSON-escaped and cannot close the config block", () => {
  const bad = "</script><script>alert(1)</script>\u2028";
  const html = renderInboxPane({ messagesPath: bad, approvalsPath: bad, escalationsPath: bad, replyPath: bad, agentsPath: bad });
  assert.equal(html.match(/<\/script>/g)!.length, 2); // config block + src script
  assert.ok(!html.includes("\u2028"));
});

// --- behavior under node:vm with a minimal fake DOM -----------------------------------------
interface N {
  tagName: string;
  children: N[];
  textContent: string;
  className: string;
  disabled: boolean;
  value: string;
  placeholder: string;
  parent: N | null;
  listeners: Map<string, ((ev: unknown) => void)[]>;
  scrolled: number;
  appendChild(c: N): void;
  replaceChildren(...n: N[]): void;
  remove(): void;
  addEventListener(t: string, f: (ev: unknown) => void): void;
  scrollIntoView(): void;
}
const node = (tag = "div"): N => {
  const n: N = {
    tagName: tag,
    children: [],
    textContent: "",
    className: "",
    disabled: false,
    value: "",
    placeholder: "",
    parent: null,
    listeners: new Map(),
    scrolled: 0,
    appendChild(c) {
      c.parent = n;
      n.children.push(c);
    },
    replaceChildren(...k) {
      n.children = k;
      for (const c of k) c.parent = n;
    },
    remove() {
      if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
      n.parent = null;
    },
    addEventListener(t, f) {
      n.listeners.set(t, [...(n.listeners.get(t) ?? []), f]);
    },
    scrollIntoView() {
      n.scrolled++;
    },
  };
  return n;
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const all = (n: N): N[] => [n, ...n.children.flatMap(all)];
const click = (n: N) => {
  for (const f of n.listeners.get("click") ?? []) f({});
};

function run(
  opts: {
    hash?: string;
    store?: Record<string, string>;
    throwStore?: boolean;
    reply?: { status: number; body: unknown };
    approvals?: unknown[];
    escalations?: unknown[];
    agents?: unknown[];
  } = {},
  paths: Parameters<typeof renderInboxPane>[0] = {},
) {
  const byId = new Map<string, N>();
  const store = opts.store ?? {};
  const fetches: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
  const sources: { url: string; onmessage?: (ev: { data: string }) => void; onerror?: () => void; onopen?: () => void }[] = [];
  class EventSource {
    url: string;
    onmessage?: (ev: { data: string }) => void;
    constructor(url: string) {
      this.url = url;
      sources.push(this);
    }
  }
  const hashListeners: (() => void)[] = [];
  const intervals: (() => void)[] = [];
  const location = { hash: opts.hash ?? "" };
  const sandbox = {
    document: {
      getElementById: (id: string) => {
        if (!byId.has(id)) byId.set(id, node());
        return byId.get(id);
      },
      createElement: (t: string) => node(t),
      querySelectorAll: () => [],
    },
    location,
    localStorage: opts.throwStore
      ? {
          getItem: () => {
            throw new Error("blocked");
          },
          setItem: () => {
            throw new Error("blocked");
          },
        }
      : {
          getItem: (k: string) => store[k] ?? null,
          setItem: (k: string, v: string) => {
            store[k] = v;
          },
        },
    EventSource,
    fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      fetches.push({ url, init });
      if (init?.method === "POST") {
        const r = opts.reply ?? { status: 200, body: { ok: true } };
        return Promise.resolve({ ok: r.status < 400, status: r.status, json: async () => r.body });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () =>
          url === (paths.agentsPath ?? "/v1/agents")
            ? (opts.agents ?? [])
            : url.startsWith(paths.escalationsPath ?? "/v1/escalations")
              ? (opts.escalations ?? [])
              : (opts.approvals ?? []),
      });
    },
    encodeURIComponent,
    decodeURIComponent,
    JSON,
    setInterval: (fn: () => void) => {
      intervals.push(fn);
      return intervals.length;
    },
    clearInterval: () => {},
    addEventListener: (t: string, f: () => void) => {
      if (t === "hashchange") hashListeners.push(f);
    },
  };
  const html = renderInboxPane(paths);
  byId.set("inbox-config", Object.assign(node(), { textContent: html.match(/id="inbox-config">([\s\S]*?)<\/script>/)![1]! }));
  runInContext(INBOX_JS, createContext(sandbox));
  const push = (m: Record<string, unknown>) => sources[0]!.onmessage!({ data: JSON.stringify(m) });
  const msg = (seq: number, extra: Record<string, unknown> = {}) => ({
    seq,
    agent: "a1",
    channel: "ui",
    purpose: "status",
    subject: `s${seq}`,
    createdAt: Date.now() - 1000 * seq,
    ...extra,
  });
  return {
    byId,
    store,
    fetches,
    sources,
    push,
    msg,
    location,
    hashListeners,
    intervals,
    list: () => byId.get("inbox")!,
    status: () => byId.get("inbox-status")!,
  };
}

const buttons = (li: N) => all(li).filter((n) => n.tagName === "button");
const post = (f: ReturnType<typeof run>) => f.fetches.filter((x) => x.init?.method === "POST");

test("inbox: reload replays from zero despite a stale stored cursor and survives blocked storage", () => {
  const f = run({ store: { pomtreeInboxSeq: "41" } });
  assert.equal(f.sources[0]!.url, "/live/messages?from=0");
  f.push(f.msg(42));
  assert.equal(f.store.pomtreeInboxSeq, "41");
  f.push(f.msg(42));
  assert.equal(f.list().children.length, 1);
  const reload = run({ store: f.store });
  assert.equal(reload.sources[0]!.url, "/live/messages?from=0");
  reload.push(reload.msg(42));
  assert.equal(reload.list().children.length, 1);
  const g = run({ throwStore: true });
  assert.equal(g.sources[0]!.url, "/live/messages?from=0");
  g.push(g.msg(1));
  assert.equal(g.list().children.length, 1);
});

test("inbox: asks are pinned above newer status cards; agent text lands in textContent verbatim", () => {
  const f = run();
  f.push(f.msg(1, { purpose: "ask", replyTo: "esc-1", subject: "<img src=x onerror=alert(1)> http://x.test" }));
  f.push(f.msg(2, { subject: "newer status" }));
  const lis = f.list().children;
  assert.equal(lis.length, 2);
  assert.ok(lis[0]!.className.includes("p-ask"));
  assert.ok(all(lis[0]!).some((n) => n.textContent === "<img src=x onerror=alert(1)> http://x.test"));
  assert.ok(buttons(lis[1]!).every((b) => b.textContent === "Dismiss"));
  click(buttons(lis[1]!)[0]!);
  assert.equal(f.list().children.length, 1);
});

test("inbox: an ask reply posts {replyTo, body, idempotencyKey} with X-Pomtree-UI, disables while in flight, and reuses the key on retry", async () => {
  const f = run({ reply: { status: 500, body: {} } });
  f.push(f.msg(1, { purpose: "ask", replyTo: "esc-1" }));
  const li = f.list().children[0]!;
  const input = all(li).find((n) => n.tagName === "input")!;
  const [send] = buttons(li);
  input.value = "yes";
  click(send!);
  assert.ok(send!.disabled);
  click(send!); // ignored while in flight
  await flush();
  assert.equal(post(f).length, 1);
  const p = post(f)[0]!;
  assert.equal(p.url, "/v1/ui/reply");
  assert.equal(p.init!.headers!["X-Pomtree-UI"], "1");
  const body1 = JSON.parse(p.init!.body!);
  assert.deepEqual(Object.keys(body1).sort(), ["body", "idempotencyKey", "replyTo"]);
  assert.equal(body1.replyTo, "esc-1");
  assert.equal(body1.body, "yes");
  assert.ok(!send!.disabled); // re-enabled after failure
  assert.match(f.status().textContent, /Failed to send/);
  click(send!);
  await flush();
  assert.equal(JSON.parse(post(f)[1]!.init!.body!).idempotencyKey, body1.idempotencyKey);
});

test("inbox: Pass sends a decision; success removes the card; already-handled is not an error", async () => {
  const f = run({ reply: { status: 200, body: { kind: "rejected", reason: "already answered" } } });
  f.push(f.msg(1, { purpose: "ask", replyTo: "esc-1" }));
  click(buttons(f.list().children[0]!)[1]!);
  await flush();
  const body = JSON.parse(post(f)[0]!.init!.body!);
  assert.equal(body.decision, "pass");
  assert.ok(!("body" in body));
  assert.equal(f.list().children.length, 0);
  assert.equal(f.status().textContent, "Already handled");
  assert.equal(f.status().className, "meta");
});

test("inbox: pending approvals load, pin above asks, post a decision, and the deep link highlights and scrolls", async () => {
  const f = run({
    hash: "#/inbox/ap-1",
    approvals: [{ id: "ap-1", requester: "a9", summary: "rm -rf <b>", rung: "operator", deadlineAt: Date.now() + 60000 }],
    escalations: [{ id: "esc-1", agent: "a1", question: "question", options: [], holder: "root", createdAt: Date.now() }],
  });
  f.push(f.msg(1, { purpose: "ask", replyTo: "esc-1" }));
  await flush();
  assert.ok(f.fetches.some((x) => x.url === "/v1/approvals?state=pending"));
  const lis = f.list().children;
  assert.equal(lis.length, 2);
  assert.ok(lis[0]!.className.includes("p-approval"));
  assert.ok(lis[0]!.className.includes("hl"));
  assert.ok(lis[0]!.scrolled >= 1);
  assert.deepEqual(
    buttons(lis[0]!).map((b) => b.textContent),
    ["Approve", "Deny", "Pass"],
  );
  click(buttons(lis[0]!)[0]!);
  await flush();
  const body = JSON.parse(post(f)[0]!.init!.body!);
  assert.equal(body.replyTo, "ap-1");
  assert.equal(body.decision, "approve");
  assert.equal(f.list().children.length, 1);
});

test("inbox: budget_raise approval shows the requested dollars, labels Approve +$X, and replies without grantMicros", async () => {
  const f = run({
    approvals: [
      {
        id: "ap-b",
        requester: "a7",
        kind: "budget_raise",
        requestedMicros: 2_500_000,
        summary: "budget_raise <i>x</i>",
        rung: "operator",
        deadlineAt: Date.now() + 60000,
      },
    ],
  });
  await flush();
  const li = f.list().children[0]!;
  const texts = all(li).map((n) => n.textContent);
  assert.ok(texts.includes("a7 is out of budget"));
  assert.ok(texts.includes("Requested $2.50"));
  assert.deepEqual(
    buttons(li).map((b) => b.textContent),
    ["Approve +$2.50", "Deny", "Pass"],
  );
  click(buttons(li)[0]!);
  await flush();
  const p = post(f)[0]!;
  assert.equal(p.init!.headers!["X-Pomtree-UI"], "1");
  const body = JSON.parse(p.init!.body!);
  assert.deepEqual(Object.keys(body).sort(), ["decision", "idempotencyKey", "replyTo"]);
  assert.equal(body.replyTo, "ap-b");
  assert.equal(body.decision, "approve");
});

test("inbox: budget_raise without requestedMicros falls back to plain Approve; other kinds are unchanged", async () => {
  const f = run({
    approvals: [
      { id: "ap-1", requester: "a1", kind: "budget_raise", summary: "s1", rung: "operator", deadlineAt: Date.now() + 1000 },
      { id: "ap-2", requester: "a2", kind: "shell", requestedMicros: 5_000_000, summary: "s2", rung: "operator", deadlineAt: Date.now() + 2000 },
    ],
  });
  await flush();
  for (const li of f.list().children) {
    assert.deepEqual(
      buttons(li).map((b) => b.textContent),
      ["Approve", "Deny", "Pass"],
    );
    assert.ok(!all(li).some((n) => /out of budget|^Requested/.test(n.textContent)));
  }
  assert.ok(all(f.list().children[0]!).some((n) => n.textContent === "s1"));
});

test("inbox: a deep link to an unknown id highlights nothing", () => {
  const f = run({ hash: "#/inbox/nope" });
  f.push(f.msg(1, { purpose: "ask", replyTo: "esc-1" }));
  assert.ok(!f.list().children[0]!.className.includes("hl"));
});

test("inbox: authoritative open escalations dedupe replay, retain drafts, and remove resolved asks", async () => {
  const opts = {
    escalations: [{ id: "e1", agent: "a1", question: "Choose?", options: ["yes", "no"], holder: "root" as string | null, createdAt: Date.now() }],
  };
  const f = run(opts);
  f.push(f.msg(1, { purpose: "ask", replyTo: "e1" }));
  f.push(f.msg(2, { purpose: "ask", replyTo: "resolved" }));
  await flush();
  assert.equal(f.list().children.length, 1);
  const li = f.list().children[0]!;
  assert.ok(all(li).some((n) => n.textContent === "yes / no"));
  const input = all(li).find((n) => n.tagName === "input")!;
  input.value = "draft";
  f.push(f.msg(3, { purpose: "ask", replyTo: "e1" }));
  await flush();
  assert.equal(f.list().children.length, 1);
  assert.equal(f.list().children[0], li);
  assert.equal(input.value, "draft");
  opts.escalations[0]!.holder = null;
  f.intervals[0]!();
  await flush();
  assert.equal(buttons(li).find((b) => b.textContent === "Pass")!.disabled, true);
  opts.escalations = [];
  f.intervals[0]!();
  await flush();
  assert.equal(f.list().children.length, 0);
  f.push(f.msg(4, { purpose: "ask", replyTo: "e1" }));
  await flush();
  assert.equal(f.list().children.length, 0);
});

test("inbox: newly open requests arrive after the initial snapshot without waiting for the next poll", async () => {
  const opts: { escalations: unknown[] } = { escalations: [] };
  const f = run(opts);
  await flush();
  opts.escalations = [{ id: "new", agent: "a", question: "New question", options: [], holder: null, createdAt: Date.now() }];
  f.push(f.msg(1, { purpose: "ask", replyTo: "new" }));
  await flush();
  assert.equal(f.list().children.length, 1);
  assert.deepEqual(
    buttons(f.list().children[0]!).map((b) => b.textContent),
    ["Send"],
  );
});

test("inbox: rejected reply receipts keep the request and draft for retry", async () => {
  const f = run({
    reply: { status: 201, body: { kind: "rejected", reason: "ui channel disabled" } },
    escalations: [{ id: "e1", agent: "a", question: "Question", options: [], holder: null, createdAt: Date.now() }],
  });
  await flush();
  const li = f.list().children[0]!;
  const input = all(li).find((n) => n.tagName === "input")!;
  input.value = "answer";
  click(buttons(li)[0]!);
  await flush();
  assert.equal(f.list().children[0], li);
  assert.equal(input.value, "answer");
  assert.equal(buttons(li)[0]!.disabled, false);
  assert.match(f.status().textContent, /ui channel disabled/);
});

test("inbox: canonical asks answer through the operator route and reuse retry keys", async () => {
  const opts = {
    reply: { status: 500, body: {} },
    escalations: [{ id: "e/1", agent: "a", question: "Question", options: [], holder: null, createdAt: Date.now() }],
  };
  const f = run(opts, { escalationsPath: "/asks" });
  await flush();
  const li = f.list().children[0]!;
  const input = all(li).find((n) => n.tagName === "input")!;
  input.value = "answer";
  click(buttons(li)[0]!);
  await flush();
  assert.equal(f.list().children[0], li);
  assert.equal(input.value, "answer");
  const first = post(f)[0]!;
  assert.equal(first.url, "/asks/e%2F1/answer");
  const firstBody = JSON.parse(first.init!.body!);
  assert.equal(firstBody.body, "answer");
  assert.equal(firstBody.replyTo, undefined);
  opts.reply = { status: 201, body: { state: "answered" } };
  click(buttons(li)[0]!);
  await flush();
  assert.equal(JSON.parse(post(f)[1]!.init!.body!).idempotencyKey, firstBody.idempotencyKey);
  assert.equal(f.list().children.length, 0);
});

test("inbox: canonical Pass uses the operator route and keeps the open ask at its new holder", async () => {
  const f = run({
    reply: { status: 201, body: { state: "open", holder: null } },
    escalations: [{ id: "e1", agent: "a", question: "Question", options: [], holder: "root", createdAt: Date.now() }],
  });
  await flush();
  const li = f.list().children[0]!;
  const pass = buttons(li).find((b) => b.textContent === "Pass")!;
  click(pass);
  await flush();
  assert.equal(post(f)[0]!.url, "/v1/escalations/e1/pass");
  assert.deepEqual(Object.keys(JSON.parse(post(f)[0]!.init!.body!)), ["idempotencyKey"]);
  assert.equal(f.list().children[0], li);
  assert.equal(pass.disabled, true);
});

const submit = (f: ReturnType<typeof run>) => {
  for (const fn of f.byId.get("inbox-compose")!.listeners.get("submit") ?? []) fn({ preventDefault() {} });
};

test("inbox compose: posts {to, body, idempotencyKey} without replyTo, X-Pomtree-UI, shows the receipt, clears the box", async () => {
  const f = run({ reply: { status: 201, body: { kind: "signaled", to: "a7" } } });
  f.byId.get("inbox-to")!.value = " a7 ";
  f.byId.get("inbox-body")!.value = "<b>hi</b>";
  submit(f);
  assert.ok(f.byId.get("inbox-send")!.disabled); // in flight
  await flush();
  const p = post(f)[0]!;
  assert.equal(p.url, "/v1/ui/reply");
  assert.equal(p.init!.headers!["X-Pomtree-UI"], "1");
  const body = JSON.parse(p.init!.body!);
  assert.deepEqual(Object.keys(body).sort(), ["body", "idempotencyKey", "to"]);
  assert.equal(body.to, "a7");
  assert.equal(body.body, "<b>hi</b>");
  assert.equal(f.byId.get("inbox-body")!.value, "");
  assert.ok(!f.byId.get("inbox-send")!.disabled);
  assert.equal(f.status().textContent, "Message to a7");
  assert.equal(f.status().className, "meta");
});

test("inbox compose: a typed error shows in the status line, keeps the draft, and the retry reuses the key", async () => {
  const f = run({ reply: { status: 404, body: { error: "unknown agent a7" } } });
  f.byId.get("inbox-to")!.value = "a7";
  f.byId.get("inbox-body")!.value = "hello";
  submit(f);
  await flush();
  assert.equal(f.status().textContent, "Failed to send: unknown agent a7");
  assert.equal(f.status().className, "err");
  assert.equal(f.byId.get("inbox-body")!.value, "hello");
  submit(f);
  await flush();
  assert.equal(post(f).length, 2);
  assert.equal(JSON.parse(post(f)[1]!.init!.body!).idempotencyKey, JSON.parse(post(f)[0]!.init!.body!).idempotencyKey);
  f.byId.get("inbox-body")!.value = "changed";
  submit(f);
  await flush();
  assert.notEqual(JSON.parse(post(f)[2]!.init!.body!).idempotencyKey, JSON.parse(post(f)[0]!.init!.body!).idempotencyKey);
});

test("inbox compose: empty fields send nothing; the agent datalist is filled via textContent and skips reaped agents", async () => {
  const f = run({
    agents: [
      { id: "a1", name: "<i>x</i>", state: "running" },
      { id: "a2", name: "gone", state: "reaped" },
    ],
  });
  await flush();
  const opts = f.byId.get("inbox-agents")!.children;
  assert.equal(opts.length, 1);
  assert.equal(opts[0]!.value, "a1");
  assert.equal(opts[0]!.textContent, "<i>x</i>");
  submit(f);
  assert.equal(post(f).length, 0);
  assert.equal(f.status().className, "err");
});

test("inbox compose: a rejected receipt at 201 is a failure that keeps the draft; 409 and 400 show the error", async () => {
  const f = run({ reply: { status: 201, body: { kind: "rejected", reason: "not authorized" } } });
  f.byId.get("inbox-to")!.value = "a7";
  f.byId.get("inbox-body")!.value = "hello";
  submit(f);
  await flush();
  assert.equal(f.status().textContent, "Not sent: not authorized");
  assert.equal(f.status().className, "err");
  assert.equal(f.byId.get("inbox-body")!.value, "hello");
  for (const [status, error] of [
    [409, "agent a7 is reaped"],
    [400, "body too long"],
  ] as const) {
    const g = run({ reply: { status, body: { error } } });
    g.byId.get("inbox-to")!.value = "a7";
    g.byId.get("inbox-body")!.value = "x";
    submit(g);
    await flush();
    assert.equal(g.status().textContent, `Failed to send: ${error}`);
    assert.equal(g.byId.get("inbox-body")!.value, "x");
  }
});

test("inbox compose: the textarea carries maxlength 4000", () => {
  assert.ok(renderInboxPane().includes('id="inbox-body" rows="2" maxlength="4000"'));
});
