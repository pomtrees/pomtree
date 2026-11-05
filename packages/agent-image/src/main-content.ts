// Main-content selection for the browser capture. `snapshotInPage` runs inside the browser page (Playwright serializes it with
// Function.prototype.toString), so it is one self-contained function: no imports, no references to module scope, helpers nested.
// Everything it needs from outside (including the fallback region label) arrives through its `tuning` argument, whose single definition is MAIN_CONTENT_TUNING below.
// It is exercised on the host against a small DOM-like fake (main-content.test.ts), so the selection and strip logic is pure over the
// narrow interface in `DocLike`.

// The closed set of values of the navigation log's `extraction.region`; the host verifier accepts exactly these.
// "article/main/body" is the unrefined region (first <article>, else <main>, else <body>, taken as is): the fallback when no
// refinement qualified. The "main-content/*" labels say which root the refinement kept and that page chrome was stripped inside it.
export const EXTRACTION_REGION_FALLBACK = "article/main/body";
export const EXTRACTION_REGIONS = ["main-content/article", "main-content/main", "main-content/body", EXTRACTION_REGION_FALLBACK] as const;
export type ExtractionRegion = (typeof EXTRACTION_REGIONS)[number];

export interface MainContentTuning {
  // A root (article or main) qualifies only with at least this many normalized characters ...
  rootMinChars: number;
  // ... and at least this fraction of the whole body's normalized characters (a tiny article beside a large body is not the page).
  rootMinBodyRatio: number;
  // Stripping is rejected when it leaves less than this fraction of the unstripped root's characters (it would empty the page).
  stripMinKeepRatio: number;
  // Elements removed from the chosen root before reading its text: page chrome, non-content, and hidden elements.
  strip: string;
  // The region label returned when no tier qualified. It travels here because the function runs in the page and cannot see module scope.
  fallbackRegion: string;
}
export const MAIN_CONTENT_TUNING: MainContentTuning = {
  fallbackRegion: EXTRACTION_REGION_FALLBACK,
  rootMinChars: 400,
  rootMinBodyRatio: 0.25,
  stripMinKeepRatio: 0.2,
  strip: [
    "nav",
    "aside",
    "footer",
    "header",
    "script",
    "style",
    "noscript",
    "template",
    "dialog",
    "[hidden]",
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '[role="complementary"]',
    '[role="search"]',
    '[role="dialog"]',
    '[role="alertdialog"]',
  ].join(","),
};

// The slice of the DOM the snapshot reads and (temporarily) writes. The real `document` satisfies it.
export interface DocEl {
  innerText: string;
  style: { cssText: string };
  querySelectorAll(selector: string): ArrayLike<DocEl>;
}
export interface DocLike {
  documentElement: { outerHTML: string };
  body: DocEl | null;
  querySelectorAll(selector: string): ArrayLike<DocEl>;
}
export interface PageSnapshot {
  dom: string;
  text: string;
  region: ExtractionRegion;
  // Set only on the fallback path: why each tier was rejected, sizes and closed codes only, e.g.
  // `tier_rejected: article=none main=small(chars=120) body=empty(before=0)`. Codes: none (no such root), small (root under the
  // absolute or body-ratio minimum), empty (stripped text empty), sliver (stripped text under the keep ratio).
  rejected?: string;
}

// Must stay self-contained (see the file comment). `doc` defaults to the page's `document`: Playwright calls the function with
// the tuning argument only.
export function snapshotInPage(tuning: MainContentTuning, doc: DocLike = document as unknown as DocLike): PageSnapshot {
  const dom = doc.documentElement.outerHTML; // taken before any temporary style change
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const len = (e: DocEl | null | undefined) => (e ? norm(e.innerText ?? "").length : 0);
  const body = doc.body;
  const bodyLen = len(body);
  const largest = (list: ArrayLike<DocEl>) => {
    let best: DocEl | null = null;
    let bestLen = -1;
    for (let i = 0; i < list.length; i++) {
      const l = len(list[i]);
      if (l > bestLen) {
        best = list[i] ?? null;
        bestLen = l;
      }
    }
    return best;
  };
  // innerText of `root` with the strip set hidden; the inline style is restored whatever happens.
  const stripped = (root: DocEl) => {
    const hidden: { el: DocEl; css: string }[] = [];
    try {
      const found = root.querySelectorAll(tuning.strip);
      for (let i = 0; i < found.length; i++) {
        const el = found[i] as DocEl;
        hidden.push({ el, css: el.style.cssText });
        el.style.cssText = `${el.style.cssText};display:none !important`;
      }
      return root.innerText ?? "";
    } finally {
      for (let i = hidden.length - 1; i >= 0; i--) (hidden[i] as { el: DocEl; css: string }).el.style.cssText = (hidden[i] as { el: DocEl; css: string }).css;
    }
  };
  const why: string[] = [];
  const tiers: { label: ExtractionRegion; root: DocEl | null; needsRatio: boolean }[] = [
    { label: "main-content/article", root: largest(doc.querySelectorAll("article")), needsRatio: true },
    { label: "main-content/main", root: largest(doc.querySelectorAll('main,[role="main"]')), needsRatio: true },
    { label: "main-content/body", root: body, needsRatio: false },
  ];
  for (const { label, root, needsRatio } of tiers) {
    const name = label.slice(label.indexOf("/") + 1);
    if (!root) {
      why.push(`${name}=none`);
      continue;
    }
    const before = len(root);
    if (needsRatio && (before < tuning.rootMinChars || before < tuning.rootMinBodyRatio * bodyLen)) {
      why.push(`${name}=small(chars=${before})`);
      continue;
    }
    const text = stripped(root);
    const after = norm(text).length;
    if (after === 0 || after < tuning.stripMinKeepRatio * before) {
      why.push(`${name}=${after === 0 ? "empty" : "sliver"}(before=${before},after=${after})`);
      continue;
    }
    return { dom, text, region: label };
  }
  const legacy = (doc.querySelectorAll("article")[0] ?? doc.querySelectorAll("main")[0] ?? body) as DocEl | null | undefined;
  return { dom, text: legacy?.innerText ?? "", region: tuning.fallbackRegion as ExtractionRegion, rejected: `tier_rejected: ${why.join(" ")}` };
}
