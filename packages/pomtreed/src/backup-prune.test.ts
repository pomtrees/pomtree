import assert from "node:assert/strict";
import { test } from "node:test";
import { backupPruneLines } from "./daemon-util.ts";

test("backupPruneLines: one line per kept, removed and failed backup; the error message is one bounded line", () => {
  assert.deepEqual(
    backupPruneLines("pomtreed.sqlite", {
      kept: "/s/pomtreed.sqlite.pre-v9.bak",
      removed: ["/s/pomtreed.sqlite.pre-v7.bak", "/s/pomtreed.sqlite.pre-v8.bak"],
      errors: [{ path: "/s/pomtreed.sqlite.pre-v6.bak", message: "EACCES\nline2" }],
    }),
    [
      "pomtreed: pomtreed.sqlite migration backup kept: /s/pomtreed.sqlite.pre-v9.bak",
      "pomtreed: pomtreed.sqlite older migration backup removed: /s/pomtreed.sqlite.pre-v7.bak",
      "pomtreed: pomtreed.sqlite older migration backup removed: /s/pomtreed.sqlite.pre-v8.bak",
      "pomtreed: WARNING: pomtreed.sqlite older migration backup not removed: /s/pomtreed.sqlite.pre-v6.bak: EACCES\\nline2",
    ],
  );
  assert.deepEqual(backupPruneLines("state.sqlite", { kept: "k", removed: [], errors: [] }), ["pomtreed: state.sqlite migration backup kept: k"]);
});
