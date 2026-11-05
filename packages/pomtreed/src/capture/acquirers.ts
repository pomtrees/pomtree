// The built-in official-API acquirers: a URL an acquirer recognizes is fetched from that
// publisher's documented API under its declared terms instead of through robots.txt and the static rung. The acquirer declares its
// resource id (so two URLs for one filing are one cache entry) and its freshness class (section 7). pomtreed dials the API URL and
// stores the bytes unread; it never parses them (decision C9). Pure: string matching over a canonical URL, no I/O.
import type { FreshnessClass } from "@pomtree/core";

export interface AcquirerMatch {
  acquirer: string; // the cache key's acquirer and the predicate's acquirer
  resource: string; // the acquirer's own resource id
  apiUrl: string; // what pomtreed dials
  freshness: FreshnessClass;
}

interface Acquirer {
  id: string;
  match(u: URL): Omit<AcquirerMatch, "acquirer"> | null;
}

// SEC EDGAR (https://www.sec.gov/os/accessing-edgar-data). data.sec.gov's JSON (submissions, company facts and concepts) changes
// as filings arrive, so it is daily. An accession document under www.sec.gov/Archives/edgar/data/<cik>/<accession>/ never changes
// once filed: immutable. The filing index at the accession directory itself is listed as daily (it is a generated page).
const EDGAR: Acquirer = {
  id: "edgar",
  match(u) {
    const host = u.hostname.toLowerCase();
    const path = u.pathname;
    if (u.protocol !== "https:") return null;
    if (host === "data.sec.gov") {
      const sub = /^\/submissions\/(CIK\d{10})\.json$/.exec(path);
      if (sub) return { resource: `edgar:submissions:${sub[1]}`, apiUrl: `https://data.sec.gov${path}`, freshness: "daily" };
      const api = /^\/api\/xbrl\/(companyfacts|companyconcept|frames)\/[A-Za-z0-9/._-]+\.json$/.exec(path);
      if (api && !path.includes(".."))
        return { resource: `edgar:xbrl:${path.slice("/api/xbrl/".length)}`, apiUrl: `https://data.sec.gov${path}`, freshness: "daily" };
      return null;
    }
    if (host === "www.sec.gov" || host === "sec.gov") {
      const doc = /^\/Archives\/edgar\/data\/(\d{1,10})\/(\d{18})\/([A-Za-z0-9._-]+)$/.exec(path);
      if (doc && !(doc[3] as string).startsWith(".")) {
        const cik = String(Number(doc[1]));
        return {
          resource: `edgar:archive:${cik}:${doc[2]}:${doc[3]}`,
          apiUrl: `https://www.sec.gov/Archives/edgar/data/${doc[1]}/${doc[2]}/${doc[3]}`,
          freshness: "immutable",
        };
      }
      return null;
    }
    return null;
  },
};

// Hacker News (https://github.com/HackerNews/API): an item page on news.ycombinator.com and the Firebase API item are one resource,
// read from the API. The API's story lists, users, max item and updates are read from it too. Items gain comments and scores and the
// lists change by the minute, so all are live.
const HN_LISTS = ["topstories", "newstories", "beststories", "askstories", "showstories", "jobstories", "maxitem", "updates"];
const HN: Acquirer = {
  id: "hn",
  match(u) {
    const host = u.hostname.toLowerCase();
    let n: string | null = null;
    if (host === "news.ycombinator.com" && u.pathname === "/item") {
      const id = u.searchParams.get("id");
      if (id !== null && /^\d{1,12}$/.test(id) && [...u.searchParams.keys()].every((k) => k === "id")) n = id;
    } else if (host === "hacker-news.firebaseio.com" && u.protocol === "https:" && u.search === "") {
      n = /^\/v0\/item\/(\d{1,12})\.json$/.exec(u.pathname)?.[1] ?? null;
      const list = /^\/v0\/([a-z]+)\.json$/.exec(u.pathname)?.[1];
      if (list !== undefined && HN_LISTS.includes(list))
        return { resource: `hn:${list}`, apiUrl: `https://hacker-news.firebaseio.com/v0/${list}.json`, freshness: "live" };
      const user = /^\/v0\/user\/([A-Za-z0-9_-]{1,64})\.json$/.exec(u.pathname)?.[1];
      if (user !== undefined) return { resource: `hn:user:${user}`, apiUrl: `https://hacker-news.firebaseio.com/v0/user/${user}.json`, freshness: "live" };
    }
    if (n === null) return null;
    const id = String(Number(n));
    return { resource: `hn:item:${id}`, apiUrl: `https://hacker-news.firebaseio.com/v0/item/${id}.json`, freshness: "live" };
  },
};

export const ACQUIRERS: readonly Acquirer[] = [EDGAR, HN];

// The acquirer for a canonical capture URL, or null (the web rungs: robots.txt, then static).
export function acquirerFor(canonicalUrl: string): AcquirerMatch | null {
  let u: URL;
  try {
    u = new URL(canonicalUrl);
  } catch {
    return null;
  }
  for (const a of ACQUIRERS) {
    const m = a.match(u);
    if (m !== null) return { acquirer: a.id, ...m };
  }
  return null;
}
