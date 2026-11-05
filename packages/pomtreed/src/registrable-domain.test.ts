import assert from "node:assert/strict";
import { test } from "node:test";
import { registrableDomain } from "./registrable-domain.ts";

test("registrableDomain: the last two labels, three under a listed multi-label suffix; IPs and short names are their own bucket", () => {
  for (const [host, want] of [
    ["data.sec.gov", "sec.gov"],
    ["www.sec.gov", "sec.gov"],
    ["WWW.SEC.GOV.", "sec.gov"], // case and a trailing dot do not split a bucket
    ["sec.gov", "sec.gov"],
    ["a.b.example.com", "example.com"],
    ["www.bbc.co.uk", "bbc.co.uk"],
    ["bbc.co.uk", "bbc.co.uk"],
    ["shop.example.com.au", "example.com.au"],
    ["localhost", "localhost"],
    ["93.184.216.34", "93.184.216.34"],
    ["[2606:4700::1111]", "2606:4700::1111"],
  ] as const)
    assert.equal(registrableDomain(host), want, host);
  // Documented gap (TODO(durable-quota)): an unlisted private suffix over-groups, which paces slower, never faster.
  assert.equal(registrableDomain("alice.github.io"), registrableDomain("bob.github.io"));
});
