// The registrable domain ("eTLD+1") of a hostname, for pacing and quota buckets: data.sec.gov, www.sec.gov and efts.sec.gov share
// one bucket (sec.gov), because a site's fair-access limit applies to the organisation, not to each of its hostnames. Pure.
//
// Heuristic, not the Public Suffix List: the last two labels, or the last three when the last two are a known multi-label public
// suffix (co.uk, com.au, ...). IP literals and single-label names are their own bucket. An unknown multi-label suffix (e.g. a
// private-registry suffix like github.io) groups unrelated sites into one bucket, which errs toward slower pacing, never faster.
// TODO(durable-quota): no PSL dependency (no new runtime deps); an unlisted multi-label suffix over-groups. Swap in the PSL if the
// stack ever takes one, or extend MULTI_LABEL_SUFFIXES when a real target is mis-bucketed.
import { isIP } from "node:net";

// Second-level public suffixes common enough to matter for the hosts workflows fetch. Not exhaustive by design (see above).
export const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "ltd.uk",
  "plc.uk",
  "me.uk",
  "com.au",
  "net.au",
  "org.au",
  "gov.au",
  "edu.au",
  "co.nz",
  "org.nz",
  "govt.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "go.jp",
  "ac.jp",
  "co.kr",
  "or.kr",
  "go.kr",
  "com.br",
  "gov.br",
  "com.cn",
  "gov.cn",
  "com.hk",
  "gov.hk",
  "com.sg",
  "gov.sg",
  "co.in",
  "gov.in",
  "com.mx",
  "gob.mx",
  "co.za",
  "gov.za",
  "com.tw",
  "gov.tw",
  "co.il",
  "gov.il",
  "com.tr",
  "gov.tr",
]);

export function registrableDomain(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1); // a fully qualified name is the same host
  if (isIP(h) !== 0) return h;
  const labels = h.split(".");
  if (labels.length <= 2) return h;
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}
