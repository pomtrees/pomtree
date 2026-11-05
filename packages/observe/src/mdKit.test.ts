import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { MD_LOGIC_JS } from "./mdKit.ts";

interface N {
  tag: string;
  text: string;
  cls: string;
  href: string;
  attrs: Record<string, string>;
  kids: N[];
}
const node = (tag: string): N & Record<string, unknown> => {
  const n: N & Record<string, unknown> = {
    tag,
    text: "",
    cls: "",
    href: "",
    attrs: {},
    kids: [],
    appendChild(c: N) {
      n.kids.push(c);
    },
    setAttribute(k: string, v: string) {
      n.attrs[k] = v;
    },
    addEventListener() {},
  };
  Object.defineProperty(n, "textContent", {
    get: () => n.text,
    set: (v: string) => {
      n.text = v;
    },
  });
  Object.defineProperty(n, "className", {
    get: () => n.cls,
    set: (v: string) => {
      n.cls = v;
    },
  });
  return n;
};
const doc = {
  createElement: (t: string) => node(t),
  createTextNode: (t: string) => {
    const n = node("#text");
    n.text = t;
    return n;
  },
};
// Any innerHTML/outerHTML/insertAdjacentHTML write would be an own-property assignment the nodes never define.
const C = runInContext(`(() => { ${MD_LOGIC_JS}; return Md; })()`, createContext({ globalThis: {} })) as {
  safeUrl(u: string): string | null;
  parse(s: string): { t: string; [k: string]: unknown }[];
  render(d: typeof doc, s: string): N;
  diffClass(l: string): string;
};

const walk = (n: N, f: (n: N) => void) => {
  f(n);
  n.kids.forEach((k) => {
    walk(k, f);
  });
};
const all = (s: string) => {
  const out: N[] = [];
  walk(C.render(doc, s), (n) => out.push(n));
  return out;
};

test("logic source never uses innerHTML-style sinks", () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(MD_LOGIC_JS));
});

test("safeUrl: https only, no junk characters", () => {
  assert.equal(C.safeUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  for (const bad of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "http://x.com",
    "data:text/html,<script>",
    "//x.com",
    "https://",
    'https://x.com/"onmouseover=1',
    "https://x.com/a b",
    "https://x.com/<b>",
    "vbscript:x",
    "file:///etc/passwd",
    "https://x.com/\u0000",
    "\thttps://x.com/\nfoo",
  ]) {
    assert.equal(C.safeUrl(bad), null, bad);
  }
});

test("markdown: fences, inline code, bold/italic, lists, https links render as expected", () => {
  const nodes = all("hello **bold** and *it* and `code` [site](https://a.com)\n\n- one\n- two\n\n1. x\n\n```js\nlet a = 1 < 2;\n```");
  const tags = nodes.map((n) => n.tag);
  for (const t of ["strong", "em", "code", "a", "ul", "ol", "pre", "button"]) assert.ok(tags.includes(t), t);
  const a = nodes.find((n) => n.tag === "a")!;
  assert.equal(a.href, "https://a.com");
  assert.equal(a.attrs.rel, "noopener noreferrer nofollow");
  assert.equal(a.attrs.target, "_blank");
  assert.ok(nodes.some((n) => n.tag === "code" && n.text === "let a = 1 < 2;")); // verbatim text, no escaping needed (textContent)
});

test("XSS: script tags, event handlers and raw html stay text", () => {
  const nodes = all('<script>alert(1)</script> <img src=x onerror=alert(1)> <a href="javascript:alert(1)">x</a>');
  assert.ok(nodes.every((n) => !["script", "img", "iframe"].includes(n.tag)));
  assert.ok(nodes.every((n) => n.tag !== "a"));
  assert.ok(nodes.some((n) => n.tag === "#text" && n.text.includes("<script>alert(1)</script>")));
});

test("XSS: javascript:/data: links and images are not linked; https images become links", () => {
  for (const src of [
    "[x](javascript:alert(1))",
    "[x](JAVASCRIPT:alert(1))",
    "![x](data:image/svg+xml,<svg onload=1>)",
    "[x](http://plain.com)",
    "[x](  javascript:alert(1))",
  ]) {
    assert.ok(
      all(src).every((n) => n.tag !== "a" && n.tag !== "img"),
      src,
    );
  }
  assert.ok(all('[x](https://a.com/"onclick=1)').every((n) => n.tag !== "a" || !/["\s]/.test(n.href)));
  const img = all("![alt](https://a.com/i.png)").filter((n) => n.tag === "a");
  assert.equal(img.length, 1);
  assert.equal(img[0]!.text, "[image: alt]");
  assert.ok(all("see https://a.com/x, ok").some((n) => n.tag === "a" && n.href === "https://a.com/x"));
});

test("fences: unclosed and nested fences terminate and keep content as text", () => {
  const unclosed = C.parse("```\n<b>x</b>\nno end");
  assert.equal(unclosed.length, 1);
  assert.equal(unclosed[0]!.v, "<b>x</b>\nno end");
  assert.ok(all("```\n**x**\n```").every((n) => n.tag !== "strong"));
  assert.doesNotThrow(() => C.parse("``` ``` ``` ```\n```\n```"));
});

test("giant and pathological input is bounded and fast", () => {
  const t0 = Date.now();
  const huge = "a".repeat(5_000_000);
  const blocks = C.parse(huge);
  assert.ok((blocks as unknown as { truncated?: boolean }).truncated);
  C.parse("**".repeat(2500) + "\n" + "[".repeat(4000) + "\n" + "*".repeat(100000));
  C.parse("- x\n".repeat(50000));
  C.parse("*[a](https://x.com) ".repeat(300));
  assert.ok(Date.now() - t0 < 5000, "parse time");
  const deep = "*".repeat(2) + "a".repeat(10) + "**";
  assert.doesNotThrow(() => C.render(doc, "*".repeat(10000) + deep));
});

test("diff blocks color lines by first char", () => {
  assert.equal(C.diffClass("+x"), "d-add");
  assert.equal(C.diffClass("-x"), "d-del");
  assert.equal(C.diffClass("@@ -1 +1 @@"), "d-hunk");
  assert.equal(C.diffClass("+++ b/f"), "d-meta");
  assert.equal(C.diffClass(" ctx"), "d-ctx");
  const pre = all("```diff\n@@ -1 +1 @@\n-a\n+<img onerror=1>\n```").filter((n) => n.cls.startsWith("d-"));
  assert.deepEqual(
    pre.map((n) => n.cls),
    ["d-hunk", "d-del", "d-add"],
  );
  assert.equal(pre[2]!.text, "+<img onerror=1>");
});
