// Browser-side markdown renderer for the reports viewer, shipped as source text (like paneKit.ts) and embedded in
// the pane as global `MdKit`. Pure functions (markdown parsing, URL vetting, diff classification) plus a DOM
// builder that only ever uses createElement/createTextNode/textContent: report text never reaches innerHTML.
// Raw HTML in the text is just text. Links are https-only with rel="noopener noreferrer nofollow"; images
// render as links. Plain JS, no backticks and no template interpolation (it is a String.raw literal).

export const MD_LOGIC_JS = String.raw`
const Md = globalThis.MdKit || (globalThis.MdKit = (() => {
  const MAX_INPUT = 100000;
  const MAX_LINE = 5000;
  const MAX_DEPTH = 4;
  const MAX_BLOCKS = 2000;

  // https only; no whitespace, control chars, quotes, angle brackets or backslashes; bounded length.
  const safeUrl = (u) => {
    const s = String(u == null ? "" : u).trim();
    if (s.length > 2000 || /[\s\u0000-\u001f\u007f<>"'\\]/.test(s)) return null;
    return /^https:\/\/[^\/?#]+/i.test(s) ? s : null;
  };

  const inline = (s, depth) => {
    if (s.length > MAX_LINE || depth > MAX_DEPTH) return [{ t: "text", v: s }];
    const out = [];
    let buf = "";
    let i = 0;
    const flush = () => { if (buf) { out.push({ t: "text", v: buf }); buf = ""; } };
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\\" && i + 1 < s.length && "\\\u0060*[]()!".indexOf(s[i + 1]) >= 0) { buf += s[i + 1]; i += 2; continue; }
      if (ch === "\u0060") {
        const j = s.indexOf("\u0060", i + 1);
        if (j > i + 1) { flush(); out.push({ t: "code", v: s.slice(i + 1, j) }); i = j + 1; continue; }
      }
      if (ch === "*") {
        const mark = s[i + 1] === "*" ? "**" : "*";
        const j = s.indexOf(mark, i + mark.length);
        if (j > i + mark.length) {
          flush();
          out.push({ t: mark === "**" ? "b" : "i", c: inline(s.slice(i + mark.length, j), depth + 1) });
          i = j + mark.length;
          continue;
        }
      }
      if (ch === "[" || (ch === "!" && s[i + 1] === "[")) {
        const img = ch === "!";
        const st = i + (img ? 2 : 1);
        const mid = s.indexOf("](", st);
        const end = mid >= 0 ? s.indexOf(")", mid + 2) : -1;
        if (end >= 0) {
          const href = safeUrl(s.slice(mid + 2, end));
          if (href) {
            const label = s.slice(st, mid) || href;
            flush();
            out.push({ t: "a", href, v: img ? "[image: " + label + "]" : label });
            i = end + 1;
            continue;
          }
        }
      }
      if (ch === "h" && s.startsWith("https://", i)) {
        let j = i;
        while (j < s.length && !/[\s<>"')\]]/.test(s[j])) j++;
        const url = s.slice(i, j).replace(/[.,;:!?]+$/, "");
        const href = safeUrl(url);
        if (href) { flush(); out.push({ t: "a", href, v: url }); i += url.length; continue; }
      }
      buf += ch;
      i++;
    }
    flush();
    return out;
  };

  // Blocks: p (lines of inline nodes), h, list (ordered, items), code (lang, v). An unclosed fence runs to the
  // end of the input; input beyond MAX_INPUT is cut and flagged.
  const parse = (src) => {
    let text = String(src == null ? "" : src);
    const blocks = [];
    if (text.length > MAX_INPUT) { text = text.slice(0, MAX_INPUT); blocks.truncated = true; }
    const lines = text.split("\n");
    let para = [];
    const flushPara = () => { if (para.length) { blocks.push({ t: "p", c: para.map((l) => inline(l, 0)) }); para = []; } };
    let i = 0;
    while (i < lines.length && blocks.length < MAX_BLOCKS) {
      const line = lines[i].replace(/\r$/, "");
      const fence = /^ {0,3}\u0060{3,}\s*([A-Za-z0-9_+-]*)/.exec(line);
      if (fence) {
        flushPara();
        const body = [];
        i++;
        while (i < lines.length && !/^ {0,3}\u0060{3,}\s*$/.test(lines[i].replace(/\r$/, ""))) { body.push(lines[i]); i++; }
        i++;
        blocks.push({ t: "code", lang: fence[1].toLowerCase(), v: body.join("\n") });
        continue;
      }
      const li = /^ {0,6}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
      if (li) {
        flushPara();
        const ordered = /\d/.test(li[1]);
        const items = [];
        while (i < lines.length) {
          const m = /^ {0,6}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i].replace(/\r$/, ""));
          if (!m || /\d/.test(m[1]) !== ordered) break;
          items.push(inline(m[2], 0));
          i++;
        }
        blocks.push({ t: "list", ordered, c: items });
        continue;
      }
      const h = /^ {0,3}#{1,6}\s+(.*)$/.exec(line);
      if (h) { flushPara(); blocks.push({ t: "h", c: inline(h[1], 0) }); i++; continue; }
      if (line.trim() === "") flushPara(); else para.push(line);
      i++;
    }
    flushPara();
    return blocks;
  };

  // Unified-diff line class by first characters.
  const diffClass = (line) => {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) return "d-meta";
    if (line.startsWith("@@")) return "d-hunk";
    if (line.startsWith("+")) return "d-add";
    if (line.startsWith("-")) return "d-del";
    return "d-ctx";
  };
  const looksLikeDiff = (lang, v) => lang === "diff" || lang === "patch" || /^(diff --git |@@ -)/m.test(v);

  const mk = (doc, tag, text, cls) => {
    const el = doc.createElement(tag);
    if (text != null) el.textContent = String(text);
    if (cls) el.className = cls;
    return el;
  };
  const renderInline = (doc, nodes, parent) => {
    for (const n of nodes) {
      if (n.t === "text") parent.appendChild(doc.createTextNode(n.v));
      else if (n.t === "code") parent.appendChild(mk(doc, "code", n.v));
      else if (n.t === "b" || n.t === "i") {
        const el = doc.createElement(n.t === "b" ? "strong" : "em");
        renderInline(doc, n.c, el);
        parent.appendChild(el);
      } else if (n.t === "a") {
        const a = mk(doc, "a", n.v);
        a.href = n.href;
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer nofollow");
        parent.appendChild(a);
      }
    }
  };
  const copyBtn = (doc, getText) => {
    const b = mk(doc, "button", "copy", "copy");
    b.addEventListener("click", () => {
      try { navigator.clipboard.writeText(getText()).then(() => { b.textContent = "copied"; }, () => { b.textContent = "failed"; }); }
      catch (e) { b.textContent = "failed"; }
    });
    return b;
  };
  const renderCode = (doc, v, lang) => {
    const wrap = mk(doc, "div", null, "codewrap");
    wrap.appendChild(copyBtn(doc, () => v));
    const pre = doc.createElement("pre");
    if (looksLikeDiff(lang, v)) {
      pre.className = "diff";
      for (const l of v.split("\n")) pre.appendChild(mk(doc, "div", l === "" ? " " : l, diffClass(l)));
    } else {
      pre.appendChild(mk(doc, "code", v));
    }
    wrap.appendChild(pre);
    return wrap;
  };
  const render = (doc, text) => {
    const root = mk(doc, "div", null, "md");
    const blocks = parse(text);
    for (const b of blocks) {
      if (b.t === "code") root.appendChild(renderCode(doc, b.v, b.lang));
      else if (b.t === "list") {
        const ul = doc.createElement(b.ordered ? "ol" : "ul");
        for (const item of b.c) { const li = doc.createElement("li"); renderInline(doc, item, li); ul.appendChild(li); }
        root.appendChild(ul);
      } else if (b.t === "h") {
        const h = mk(doc, "div", null, "mdh");
        renderInline(doc, b.c, h);
        root.appendChild(h);
      } else {
        const p = doc.createElement("p");
        b.c.forEach((nodes, idx) => { if (idx > 0) p.appendChild(doc.createElement("br")); renderInline(doc, nodes, p); });
        root.appendChild(p);
      }
    }
    if (blocks.truncated) root.appendChild(mk(doc, "div", "[truncated: message too long]", "meta"));
    return root;
  };

  return { safeUrl, parse, render, diffClass, copyBtn };
})());
`;

export const MD_CSS = `
.pane .md { white-space: normal; overflow-wrap: anywhere; line-height: 1.55; }
.pane .md p, .pane .md ul, .pane .md ol { margin: 0.25rem 0; }
.pane .mdh { font-weight: 700; margin-top: 0.25rem; }
.pane .codewrap { position: relative; margin: 0.375rem 0; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.pane .codewrap pre { margin: 0; padding: 0.5rem 0.75rem; overflow-x: auto; white-space: pre; font-family: var(--mono); font-size: 0.8125rem; line-height: 1.5; }
.pane .codewrap button.copy { position: absolute; top: 0.25rem; right: 0.25rem; min-height: 0; padding: 0.0625rem 0.5rem; font-size: 0.75rem; color: var(--muted); }
.pane .d-add { color: var(--ok); background: color-mix(in srgb, var(--ok) 10%, transparent); white-space: pre; }
.pane .d-del { color: var(--err); background: color-mix(in srgb, var(--err) 10%, transparent); white-space: pre; }
.pane .d-hunk { color: var(--info); white-space: pre; }
.pane .d-meta { color: var(--muted); white-space: pre; }
.pane .d-ctx { white-space: pre; }
`;
