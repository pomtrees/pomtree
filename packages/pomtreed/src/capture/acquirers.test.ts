import assert from "node:assert/strict";
import { test } from "node:test";
import { acquirerFor } from "./acquirers.ts";

test("acquirerFor: EDGAR JSON, accession documents and every Hacker News API resource; anything else is the web rungs", () => {
  const r = (u: string) => {
    const m = acquirerFor(u);
    return m === null ? null : [m.acquirer, m.resource, m.freshness];
  };
  assert.deepEqual(r("https://data.sec.gov/submissions/CIK0000320193.json"), ["edgar", "edgar:submissions:CIK0000320193", "daily"]);
  assert.deepEqual(r("https://www.sec.gov/Archives/edgar/data/320193/000032019326000077/a.htm"), [
    "edgar",
    "edgar:archive:320193:000032019326000077:a.htm",
    "immutable",
  ]);
  assert.deepEqual(r("https://hacker-news.firebaseio.com/v0/item/101.json"), ["hn", "hn:item:101", "live"]);
  assert.deepEqual(r("https://news.ycombinator.com/item?id=101"), ["hn", "hn:item:101", "live"], "one resource for both URLs");
  for (const list of ["topstories", "newstories", "beststories", "askstories", "showstories", "jobstories", "maxitem", "updates"])
    assert.deepEqual(r(`https://hacker-news.firebaseio.com/v0/${list}.json`), ["hn", `hn:${list}`, "live"], list);
  assert.deepEqual(r("https://hacker-news.firebaseio.com/v0/user/pg.json"), ["hn", "hn:user:pg", "live"]);
  // Negatives: not an API resource, a query, plain http, another host.
  for (const u of [
    "https://hacker-news.firebaseio.com/v0/secrets.json",
    "https://hacker-news.firebaseio.com/v0/topstories.json?print=pretty",
    "http://hacker-news.firebaseio.com/v0/item/1.json",
    "https://news.ycombinator.com/news",
    "https://data.sec.gov/other.json",
    "https://example.com/a",
  ])
    assert.equal(r(u), null, u);
});
