import assert from "node:assert/strict";
import { test } from "node:test";
import { secretFileModePolicy } from "./secret-file-mode.ts";

test("secret-file mode policy: POSIX platforms get a mode reader (so a group- or other-readable secret is refused) and no warning", () => {
  for (const platform of ["linux", "darwin", "freebsd"] as const) {
    const p = secretFileModePolicy(platform, () => 0o100644);
    assert.equal(p.warning, undefined, platform);
    assert.equal(p.fileMode?.("/k"), 0o100644, platform);
  }
});

test("secret-file mode policy: win32 skips the check (no synthetic 0666 refusing every secret) and warns with cause and action", () => {
  let reads = 0;
  const p = secretFileModePolicy("win32", () => {
    reads++;
    return 0o100666;
  });
  assert.equal(p.fileMode, undefined);
  assert.equal(reads, 0);
  assert.match(p.warning ?? "", /Windows has no POSIX file modes/);
  assert.match(p.warning ?? "", /restrict .*ACL/);
});
