import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  type DocEl,
  type DocLike,
  EXTRACTION_REGION_FALLBACK,
  EXTRACTION_REGIONS,
  MAIN_CONTENT_TUNING,
  type PageSnapshot,
  snapshotInPage,
} from "./main-content.ts";

// A minimal DOM: elements with a tag, attributes, an inline style and children (elements or text). innerText joins visible children with
// newlines and omits display:none subtrees, script/style/noscript/template and [hidden], as a browser's innerText does for the
// styles these tests use. querySelectorAll understands comma lists of `tag`, `[attr]` and `[attr="value"]`, which is all the strip set uses.
class El implements DocEl {
  style = { cssText: "" };
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly kids: (El | string)[];
  constructor(tag: string, attrs: Record<string, string>, kids: (El | string)[]) {
    this.tag = tag;
    this.attrs = attrs;
    this.kids = kids;
  }
  get innerText(): string {
    const parts: string[] = [];
    for (const k of this.kids) {
      if (typeof k === "string") parts.push(k);
      else if (!k.invisible) parts.push(k.innerText);
    }
    return parts.join("\n");
  }
  get invisible(): boolean {
    return /display:\s*none/.test(this.style.cssText) || "hidden" in this.attrs || ["script", "style", "noscript", "template"].includes(this.tag);
  }
  matches(sel: string): boolean {
    return sel.split(",").some((part) => {
      const s = part.trim();
      const m = /^([a-z0-9]*)(?:\[([a-z-]+)(?:="([^"]*)")?\])?$/.exec(s);
      if (!m) throw new Error(`fake selector not supported: ${s}`);
      const [, tag, attr, value] = m;
      return (!tag || tag === this.tag) && (!attr || (attr in this.attrs && (value === undefined || this.attrs[attr] === value)));
    });
  }
  querySelectorAll(sel: string): El[] {
    const out: El[] = [];
    for (const k of this.kids) if (typeof k !== "string") out.push(...(k.matches(sel) ? [k] : []), ...k.querySelectorAll(sel));
    return out;
  }
}
const el = (tag: string, attrs: Record<string, string>, ...kids: (El | string)[]) => new El(tag, attrs, kids);
const t = (tag: string, ...kids: (El | string)[]) => el(tag, {}, ...kids);
const page = (...kids: (El | string)[]): { doc: DocLike; body: El } => {
  const body = t("body", ...kids);
  return { body, doc: { documentElement: { outerHTML: "<html>dom</html>" }, body, querySelectorAll: (s) => body.querySelectorAll(s) } };
};
const snap = (doc: DocLike) => snapshotInPage(MAIN_CONTENT_TUNING, doc);
const words = (n: number, w = "word") => Array.from({ length: n }, () => w).join(" ");
const ARTICLE = words(200, "article"); // well above rootMinChars

test("region labels are a closed set that includes the unrefined fallback", () => {
  assert.ok((EXTRACTION_REGIONS as readonly string[]).includes(EXTRACTION_REGION_FALLBACK));
  assert.equal(new Set(EXTRACTION_REGIONS).size, EXTRACTION_REGIONS.length);
});

test("nav, aside, header and footer inside the article are stripped from the retained text", () => {
  const { doc } = page(
    t("nav", "SITE-NAV"),
    t("article", t("header", "ARTICLE-HEADER"), t("p", ARTICLE), t("aside", "RELATED-LINKS"), t("nav", "IN-ARTICLE-NAV"), t("footer", "SHARE-FOOTER")),
    t("footer", "PAGE-FOOTER"),
  );
  const r = snap(doc);
  assert.equal(r.region, "main-content/article");
  assert.equal(r.text, ARTICLE);
  assert.equal(r.dom, "<html>dom</html>");
});

test("the largest article wins over an earlier small one", () => {
  const { doc } = page(t("article", t("p", words(80, "teaser"))), t("article", t("p", ARTICLE)));
  const r = snap(doc);
  assert.equal(r.region, "main-content/article");
  assert.equal(r.text, ARTICLE);
});

test("no article: main (or role=main) is the root and chrome inside it is stripped", () => {
  const a = snap(page(t("nav", "TOP"), t("main", t("p", ARTICLE), t("footer", "F")), t("footer", "PF")).doc);
  assert.equal(a.region, "main-content/main");
  assert.equal(a.text, ARTICLE);
  const b = snap(page(t("div", "SIDE"), el("div", { role: "main" }, t("p", ARTICLE), el("div", { role: "complementary" }, "WIDGET"))).doc);
  assert.equal(b.region, "main-content/main");
  assert.equal(b.text, ARTICLE);
});

test("no article or main: the body is the root with chrome stripped", () => {
  const r = snap(page(t("header", "BANNER"), t("nav", "MENU"), t("div", ARTICLE), el("div", { role: "dialog" }, "COOKIES"), t("footer", "LEGAL")).doc);
  assert.equal(r.region, "main-content/body");
  assert.equal(r.text, ARTICLE);
});

test("cookie banners by role and dialog elements are non-content", () => {
  const r = snap(page(t("main", t("p", ARTICLE), el("div", { role: "alertdialog" }, "ACCEPT-ALL"), t("dialog", "MODAL"))).doc);
  assert.equal(r.text, ARTICLE);
});

test("hidden text is removed and script/style/noscript never leak", () => {
  const r = snap(
    page(
      t(
        "article",
        t("p", ARTICLE),
        el("p", { hidden: "" }, "HIDDEN-ATTR"),
        t("script", "var SCRIPT=1"),
        t("style", ".STYLE{}"),
        t("noscript", "NOSCRIPT"),
        t("template", "TEMPLATE"),
      ),
    ).doc,
  );
  assert.equal(r.text, ARTICLE);
  assert.doesNotMatch(r.text, /HIDDEN|SCRIPT|STYLE|NOSCRIPT|TEMPLATE/);
});

test("a tiny article beside a large body is not the root: the body (chrome stripped) is read instead of the teaser", () => {
  const { doc } = page(t("article", "short teaser", t("nav", "ART-NAV")), t("div", words(500)));
  const r = snap(doc);
  assert.equal(r.region, "main-content/body");
  assert.equal(r.text, `short teaser\n${words(500)}`);
});

test("a small article is kept when it is most of the page, but not when it is below the absolute floor", () => {
  const big = words(250, "x"); // above rootMinChars, and the page is mostly this article
  assert.equal(snap(page(t("article", big), t("p", "tiny")).doc).region, "main-content/article");
  const floor = snap(page(t("article", "ten words only here"), t("p", "ab")).doc);
  assert.notEqual(floor.region, "main-content/article");
});

test("a page whose chrome tags hold all the text is not emptied: previous behavior is kept", () => {
  const { doc } = page(t("article", t("nav", "ALL"), t("footer", "THE"), t("header", "TEXT")));
  const r = snap(doc);
  assert.equal(r.region, EXTRACTION_REGION_FALLBACK);
  assert.equal(r.text, "ALL\nTHE\nTEXT");
});

test("a body that is mostly chrome keeps the previous behavior instead of a sliver", () => {
  const { doc } = page(t("nav", words(300, "menu")), t("p", "stub"));
  const r = snap(doc);
  assert.equal(r.region, EXTRACTION_REGION_FALLBACK);
  assert.equal(r.text, `${words(300, "menu")}\nstub`);
});

test("an empty page yields empty text with the fallback label", () => {
  const r = snap(page().doc);
  assert.deepEqual([r.text, r.region], ["", EXTRACTION_REGION_FALLBACK]);
});

test("the page is left exactly as found: inline styles are restored, including after a failing read", () => {
  const nav = t("nav", "N");
  nav.style.cssText = "color:red";
  const art = t("article", t("p", ARTICLE), nav);
  const { doc } = page(art);
  snap(doc);
  assert.equal(nav.style.cssText, "color:red");
  const bad = t("article", nav);
  Object.defineProperty(bad, "innerText", {
    get() {
      if (/display:\s*none/.test(nav.style.cssText)) throw new Error("boom");
      return ARTICLE;
    },
  });
  assert.throws(() => snap(page(bad).doc), /boom/);
  assert.equal(nav.style.cssText, "color:red");
});

// Playwright serializes `snapshotInPage` with toString() and runs it in the page, where no module binding exists. Running the in-process
// function cannot see a free variable (the live ReferenceError on EXTRACTION_REGION_FALLBACK), so each path below runs the serialized
// source in a fresh vm context whose only globals are a fake `document` and the JSON-clone of the tuning, called with the tuning alone
// as Playwright does. Each path asserts the label too, so a missing binding on any path fails here.
const inPage = (doc: DocLike): PageSnapshot => {
  const ctx = vm.createContext({ document: doc });
  const fn = vm.runInContext(`(${snapshotInPage.toString()})`, ctx) as (tuning: unknown) => PageSnapshot;
  return fn(JSON.parse(JSON.stringify(MAIN_CONTENT_TUNING)));
};

test("serialized source runs with no module bindings on every path", () => {
  const cases: [string, DocLike, string, string][] = [
    ["article tier", page(t("article", t("p", ARTICLE), t("nav", "N"))).doc, "main-content/article", ARTICLE],
    ["main tier", page(t("main", t("p", ARTICLE), t("footer", "F"))).doc, "main-content/main", ARTICLE],
    ["body tier", page(t("nav", "N"), t("p", ARTICLE)).doc, "main-content/body", ARTICLE],
    ["all tiers rejected (chrome holds the text)", page(t("article", t("nav", "ALL"), t("footer", "THE"))).doc, EXTRACTION_REGION_FALLBACK, "ALL\nTHE"],
    ["all tiers rejected (sliver)", page(t("nav", words(300, "menu")), t("p", "stub")).doc, EXTRACTION_REGION_FALLBACK, `${words(300, "menu")}\nstub`],
    ["empty page", page().doc, EXTRACTION_REGION_FALLBACK, ""],
  ];
  for (const [name, doc, region, text] of cases) {
    const r = inPage(doc);
    assert.equal(r.region, region, name);
    assert.equal(r.text, text, name);
    assert.equal(r.dom, "<html>dom</html>", name);
    assert.equal(r.rejected === undefined, region !== EXTRACTION_REGION_FALLBACK, name);
  }
});

test("serialized source with no document body at all still returns the fallback", () => {
  const doc: DocLike = { documentElement: { outerHTML: "<html></html>" }, body: null, querySelectorAll: () => [] };
  const r = inPage(doc);
  assert.deepEqual([r.text, r.region, r.rejected], ["", EXTRACTION_REGION_FALLBACK, "tier_rejected: article=none main=none body=none"]);
});

test("the fallback says why each tier was rejected, with sizes and closed codes only", () => {
  const empty = snap(page(t("article", t("nav", "ALL"), t("footer", "THE"), t("header", "TEXT"))).doc);
  assert.equal(empty.rejected, "tier_rejected: article=small(chars=12) main=none body=empty(before=12,after=0)");
  const sliver = snap(page(t("nav", words(300, "menu")), t("p", "stub")).doc);
  assert.match(sliver.rejected ?? "", /^tier_rejected: article=none main=none body=sliver\(before=\d+,after=4\)$/);
  assert.equal(snap(page().doc).rejected, "tier_rejected: article=none main=none body=empty(before=0,after=0)");
  assert.equal(snap(page(t("p", ARTICLE)).doc).rejected, undefined);
});
