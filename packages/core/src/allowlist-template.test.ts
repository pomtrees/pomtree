import assert from "node:assert/strict";
import test from "node:test";
import { allowlistTemplateProblem } from "./allowlist-template.ts";

test("analyst and specialist accept no extensions and only none, registry or absent egress", () => {
  for (const allowlist of ["analyst", "specialist"] as const) {
    for (const egress of [undefined, { kind: "none" as const }, { kind: "registry" as const }])
      assert.equal(allowlistTemplateProblem({ allowlist, extensions: [], ...(egress && { egress }) }), undefined);
    assert.equal(allowlistTemplateProblem({ allowlist }), undefined);
    assert.equal(
      allowlistTemplateProblem({ allowlist, extensions: ["web_fetch"] }),
      `allowlist ${allowlist} loads only its own profile extension: remove extensions ["web_fetch"] from the template`,
    );
    assert.equal(
      allowlistTemplateProblem({ allowlist, egress: { kind: "allowlist", hosts: ["a.test"] } }),
      `allowlist ${allowlist} has no network beyond the node relay: egress.kind must be none or registry, not allowlist; set egress to {"kind":"registry"}`,
    );
    assert.match(allowlistTemplateProblem({ allowlist, egress: { kind: "audited-public" } }) ?? "", /not audited-public; set egress/);
  }
});

test("analyst and specialist carry no env: a template env or a spec envManifestHash is refused (registry egress would open its hosts)", () => {
  for (const allowlist of ["analyst", "specialist"] as const) {
    const msg = `allowlist ${allowlist} has no network beyond the node relay, and an env manifest opens its package-registry hosts: remove env from the template`;
    for (const env of [{ ecosystems: { npm: { specs: ["left-pad@1.3.0"] } } }, {}, null]) assert.equal(allowlistTemplateProblem({ allowlist, env }), msg);
    assert.equal(allowlistTemplateProblem({ allowlist, egress: { kind: "registry" }, envManifestHash: "ab".repeat(32) }), msg);
    assert.equal(allowlistTemplateProblem({ allowlist, egress: { kind: "registry" }, envManifestHash: null }), undefined);
  }
  assert.equal(allowlistTemplateProblem({ allowlist: "browse", envManifestHash: "ab".repeat(32), env: {} }), undefined);
});

test("other profiles and no profile are not this rule's concern", () => {
  assert.equal(allowlistTemplateProblem({ extensions: ["web_fetch"], egress: { kind: "audited-public" } }), undefined);
  assert.equal(allowlistTemplateProblem({ allowlist: "browse", extensions: ["web_fetch"], egress: { kind: "allowlist", hosts: ["a.test"] } }), undefined);
});
