// Content-level publish scan (TODO(publish-pin)): a pure scanner over the ADDED lines of a `git log -p` stream and over the
// commit messages and author/committer lines, so a committed credential (or a CI/workflow change) is refused before an
// approver ever sees the diffstat. It lives beside the path denylist in publish-pin.ts, which runs it over every commit the
// push would deliver.
//
// Only high-confidence patterns: each is anchored on a distinctive prefix with a bounded body, so ordinary source,
// prose and placeholders do not match. Findings carry the rule name, commit, path and line NUMBER (or the field: commit
// message, author) and never the matched text: nothing here may echo a secret into an error, a log or the approval prompt.
//
// Accident guard, not a defence against a hostile agent: encoding, splitting, concatenation and padding defeat any
// pattern. This catches credentials that appear in plain text by mistake and nothing more.
//
// Not flagged by the content scan (they rely on the path denylist, which sees every touched path): an added EMPTY CI
// file, a mode-only change, and a deletion. A CI path that gains any added content is flagged whatever the denylist says,
// including a symlink there (its target is the added line).

export interface ScanFinding {
  commit: string;
  path: string;
  line: number; // 1-based line in the new file (or in the commit message); 0 when the finding is about the file as a whole
  rule: string;
  where?: string; // set for commit messages and author/committer lines, which have no path
}

interface Rule {
  name: string;
  re: RegExp;
  // Rejects a documented placeholder that matches the shape; the matched text is passed in and not retained.
  ignore?: (match: string) => boolean;
}

const NOT_WORD_BEFORE = "(?<![A-Za-z0-9_])";
const NOT_WORD_AFTER = "(?![A-Za-z0-9_])";
const NOT_ALNUM_AFTER = "(?![A-Za-z0-9])"; // GitHub tokens: a trailing `_` does not end the token
const allSame = (s: string) => /^(.)\1*$/.test(s);
// A whole-value placeholder: one repeated character, a run of `x`, or a `YOUR_`/`YOUR-` stand-in.
const placeholder = (s: string) => allSame(s) || /^x+$/i.test(s) || /^your[_-]/i.test(s);
// Obviously fake token text for the multi-part bot and JWT shapes: a run of one character, an all-`x`/`0`/`A` body, or a
// documented stand-in word anywhere in the match.
const fakeWord = (s: string) => /EXAMPLE|PLACEHOLDER|REDACTED|YOUR_/i.test(s);
const fakeBody = (s: string) => allSame(s) || /^[x0A]+$/.test(s) || fakeWord(s);

const RULES: readonly Rule[] = [
  // PEM, OpenSSH, PGP and PKCS#8 private key headers (a public key or certificate header never matches).
  { name: "private key header", re: /-----BEGIN (?:[A-Z0-9]{1,16} ){0,3}PRIVATE KEY(?: BLOCK)?-----/ },
  // AWS access key ids (long-term AKIA and temporary ASIA, plus the other IAM id prefixes); AWS's documented example id is allowed.
  {
    name: "AWS access key id",
    re: new RegExp(`${NOT_WORD_BEFORE}(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}${NOT_WORD_AFTER}`),
    ignore: (m) => m.endsWith("EXAMPLE"),
  },
  // GitHub classic and fine-grained tokens.
  { name: "GitHub token", re: new RegExp(`${NOT_WORD_BEFORE}(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})${NOT_ALNUM_AFTER}`) },
  { name: "GitLab token", re: new RegExp(`${NOT_WORD_BEFORE}glpat-[A-Za-z0-9_-]{20,64}${NOT_WORD_AFTER}`) },
  // Slack bot/user/app tokens and incoming-webhook URLs.
  { name: "Slack token", re: new RegExp(`${NOT_WORD_BEFORE}(?:xox[abprs]-[0-9A-Za-z-]{20,80}|xapp-[0-9]-[A-Z0-9]{8,}-[0-9]{8,}-[A-Za-z0-9]{20,})`) },
  { name: "Slack webhook URL", re: /hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{20,}/ },
  // Live-mode Stripe secret and restricted keys (test-mode keys cannot move money and are not matched).
  { name: "Stripe live key", re: new RegExp(`${NOT_WORD_BEFORE}[sr]k_live_[0-9A-Za-z]{24,99}${NOT_WORD_AFTER}`) },
  // Anthropic before OpenAI; the OpenAI shapes below do not match `sk-ant-` keys, so each key has one rule name.
  { name: "Anthropic API key", re: new RegExp(`${NOT_WORD_BEFORE}sk-ant-[A-Za-z0-9_-]{32,200}`) },
  {
    name: "OpenAI API key",
    re: new RegExp(
      `${NOT_WORD_BEFORE}(?:sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,200}|sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}|sk-[A-Za-z0-9]{48}${NOT_WORD_AFTER})`,
    ),
  },
  // Google API keys (the `google` provider authenticates with one).
  { name: "Google API key", re: new RegExp(`${NOT_WORD_BEFORE}AIza[0-9A-Za-z_-]{35}${NOT_WORD_AFTER}`) },
  // DeepSeek (`sk-` + 32 hex) and OpenRouter (`sk-or-v1-` + 64 hex). Neither matches the OpenAI or Anthropic shapes above
  // (they need letters past the hex run, or a dash), nor a 40-hex git sha (no `sk-` prefix).
  { name: "DeepSeek API key", re: new RegExp(`${NOT_WORD_BEFORE}sk-[0-9a-f]{32}${NOT_WORD_AFTER}`) },
  { name: "OpenRouter API key", re: new RegExp(`${NOT_WORD_BEFORE}sk-or-v1-[0-9a-f]{64}${NOT_WORD_AFTER}`) },
  // Discord bot token: base64url user id (leading M/N/O, 24-26 chars), timestamp (6) and HMAC (27-38), dot-separated.
  {
    name: "Discord bot token",
    re: new RegExp(`${NOT_WORD_BEFORE}[MNO][A-Za-z0-9_-]{23,25}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,38}${NOT_WORD_AFTER}`),
    ignore: (m) => fakeBody(m.slice(1).replace(/\./g, "")) || fakeWord(m),
  },
  // Telegram bot token: numeric bot id, colon, 35-character secret.
  {
    name: "Telegram bot token",
    re: new RegExp(`${NOT_WORD_BEFORE}[0-9]{8,10}:[A-Za-z0-9_-]{35}${NOT_WORD_AFTER}`),
    ignore: (m) => fakeBody(m.slice(m.indexOf(":") + 1)) || fakeWord(m),
  },
  // JSON Web Token: three base64url segments, each at least 10 characters (the header starts `eyJ`). The lookbehind
  // excludes the base64url class too, so a match starts only at a token boundary: the scan stays linear on `eyJ-eyJ-...`.
  {
    name: "JWT",
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{7,2048}\.[A-Za-z0-9_-]{10,2048}\.[A-Za-z0-9_-]{10,2048}/,
    ignore: (m) => fakeBody(m.slice(3).replace(/\./g, "")) || fakeWord(m),
  },
  // Credentials in URL userinfo (`scheme://user:password@host`). `$`, `{`, `<` and quotes are excluded from the password, so
  // `${VAR}` and `<placeholder>` references never match; a password that is a placeholder is ignored.
  {
    name: "URL credentials",
    re: /(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s:/@'"<>{}$]{1,100}:[^\s/@'"<>{}$]{6,200}@[A-Za-z0-9.-]{1,255}/,
    ignore: (m) => {
      const pw = m.slice(m.indexOf(":", m.indexOf("//") + 2) + 1, m.lastIndexOf("@"));
      return placeholder(pw) || /^(?:password|changeme)$/i.test(pw);
    },
  },
  // A literal bearer credential in an Authorization header/assignment. Only a WHOLE-value placeholder is ignored, so padding
  // `xxxx` or a repeated character into a real value does not hide it; `${var}` and `<token>` are not literals.
  {
    name: "Authorization bearer literal",
    re: /authorization["']?\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+/=_-]{20,512}/i,
    ignore: (m) => placeholder(m.replace(/^.*bearer\s+/i, "")),
  },
];

// Rule name of the first high-confidence credential pattern in a line, or undefined. Every match of every rule is checked,
// so an ignored placeholder earlier on the line does not hide a real value after it. Never returns the match.
export function scanLine(line: string): string | undefined {
  for (const rule of RULES) {
    for (const m of line.matchAll(new RegExp(rule.re.source, `${rule.re.flags}g`))) {
      if (!rule.ignore?.(m[0])) return rule.name;
    }
  }
  return undefined;
}

// Workflow and CI definition files of the common hosts. Independent of (and in addition to) the operator's path
// denylist, which publish.deny (POMTREED_PUBLISH_DENY) can replace or empty: a change that runs code on a remote's CI is never silent.
const CI_PATH_PATTERNS: readonly RegExp[] = [
  /^\.(?:github|gitea|forgejo)\/(?:workflows|actions)\//,
  /^\.circleci\//,
  /^\.buildkite\//,
  /^\.gitlab-ci\.ya?ml$/,
  /^\.gitlab\/ci\//,
  /^\.travis\.ya?ml$/,
  /^\.drone\.ya?ml$/,
  /^azure-pipelines(?:\.[^/]*)?\.ya?ml$/,
  /^bitbucket-pipelines\.ya?ml$/,
  /^cloudbuild\.ya?ml$/,
  /^\.woodpecker(?:\/|\.ya?ml$)/,
  /^\.cirrus\.ya?ml$/,
  /^\.?appveyor\.ya?ml$/,
  /^\.semaphore\//,
  /^bitrise\.ya?ml$/,
  /^\.github\/dependabot\.ya?ml$/,
  /(?:^|\/)jenkinsfile(?:\.[^/]*)?$/,
];

export function isCiPath(path: string): boolean {
  const p = path.normalize("NFC").toLowerCase().replace(/^\/+/, "");
  return CI_PATH_PATTERNS.some((re) => re.test(p));
}

// Marks the start of each commit's diff in the stream `scanDiff` reads: `git log` runs with `--format=%x01%H` (see
// publish-pin.ts), so each commit's section starts with the line `\x01<full sha>`.
export const COMMIT_MARK = "\x01";

// C-style unquote of a path git quoted (`"b/we\"ird\303\251"`); a plain path is returned as is.
function unquote(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const oct = /^[0-3][0-7]{2}/.exec(body.slice(i + 1, i + 4));
    if (oct) {
      bytes.push(Number.parseInt(oct[0], 8));
      i += 3;
    } else {
      const n = body[i + 1] ?? "\\";
      bytes.push(esc[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Scans the text of `git log -p -m` for credential patterns in ADDED lines and for added content in CI files. Hunks are
// consumed by their header line counts, so an added line that merely looks like a diff header (`+++ b/x`, a commit
// marker) is data, not structure. Pure: no I/O; findings are deduplicated and in stream order.
export function scanDiff(diff: string): ScanFinding[] {
  const out: ScanFinding[] = [];
  const seen = new Set<string>();
  const push = (f: ScanFinding) => {
    const key = `${f.commit}\0${f.path}\0${f.line}\0${f.rule}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  };
  let commit = "";
  let path = "";
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  let ciFlagged = false;
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      if (c === "+") {
        newLeft--;
        const rule = scanLine(line.slice(1));
        if (rule !== undefined && path !== "") push({ commit, path, line: newLine, rule });
        newLine++;
        continue;
      }
      if (c === "-") {
        oldLeft--;
        continue;
      }
      if (c === " ") {
        oldLeft--;
        newLeft--;
        newLine++;
        continue;
      }
      if (c === "\\") continue; // "\ No newline at end of file"
      oldLeft = 0; // malformed or truncated hunk: treat this line as structure
      newLeft = 0;
    }
    if (line.startsWith(COMMIT_MARK)) {
      commit = line.slice(1).trim();
      path = "";
      ciFlagged = false;
    } else if (line.startsWith("diff ")) {
      path = "";
      ciFlagged = false;
    } else if (line.startsWith("+++ ")) {
      const raw = line.slice(4).replace(/\t$/, "");
      path = raw === "/dev/null" ? "" : unquote(raw).replace(/^b\//, "");
    } else {
      const h = HUNK.exec(line);
      if (!h) continue;
      oldLeft = h[1] === undefined ? 1 : Number(h[1]);
      newLeft = h[3] === undefined ? 1 : Number(h[3]);
      newLine = Number(h[2]);
      if (newLeft > 0 && path !== "" && !ciFlagged && isCiPath(path)) {
        ciFlagged = true;
        push({ commit, path, line: 0, rule: "workflow/CI file change" });
      }
    }
  }
  return out;
}

// Scans the records of `git log -z --format=%H%x00%an <%ae>%x00%cn <%ce>%x00%B` (publish-pin.ts): per commit the sha, the
// author and committer lines, and the full message, each NUL-terminated field. A NUL cannot occur in a commit message, so
// the fixed field count splits the stream exactly and no text inside a message can misattribute a finding.
export function scanMessages(log: string): ScanFinding[] {
  const out: ScanFinding[] = [];
  const fields = log.split("\0");
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const commit = (fields[i] ?? "").trim();
    if (commit === "") continue;
    const seen = new Set<string>();
    const push = (line: number, where: string, rule: string) => {
      const key = `${where}\0${line}\0${rule}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ commit, path: "", line, rule, where });
      }
    };
    for (const id of [fields[i + 1] ?? "", fields[i + 2] ?? ""]) {
      const rule = scanLine(id);
      if (rule !== undefined) push(0, "author or committer", rule);
    }
    (fields[i + 3] ?? "").split("\n").forEach((text, n) => {
      const rule = scanLine(text);
      if (rule !== undefined) push(n + 1, "commit message", rule);
    });
  }
  return out;
}

// A one-line, secret-free description of the findings for an error message: rule, commit, file or field, and line only.
// The file name is sanitized and capped, so a hostile name cannot break or flood the line.
export function describeFindings(findings: readonly ScanFinding[], max = 5): string {
  const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, "?");
  const cap = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
  const shown = findings
    .slice(0, max)
    .map((f) => `${f.rule} in commit ${f.commit.slice(0, 12)} ${f.where ?? `file ${cap(clean(f.path))}`}${f.line > 0 ? ` line ${f.line}` : ""}`);
  const more = findings.length > max ? ` (+${findings.length - max} more)` : "";
  return `${shown.join("; ")}${more}`;
}
