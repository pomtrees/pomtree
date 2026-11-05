import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileTailSource } from "./sink-fs.ts";

// Links of the open descriptors that point at `target` (Linux /proc, or the /dev/fd fallback).
function descriptorsFor(target: string): string[] {
  const dirs = ["/proc/self/fd", "/dev/fd"];
  for (const dir of dirs) {
    try {
      const entries = readdirSync(dir);
      return entries
        .map((entry) => {
          try {
            return readlinkSync(join(dir, entry));
          } catch {
            return "";
          }
        })
        .filter((link) => link === target);
    } catch {
      // Try the next descriptor directory.
    }
  }
  throw new Error("no file-descriptor directory available");
}

test("fileTailSource closes the descriptor after a read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sink-fd-"));
  try {
    const p = join(dir, "events.jsonl");
    writeFileSync(p, "hello");
    const target = realpathSync(p);

    const src = fileTailSource(p);
    assert.deepEqual(await src.read(0), { text: "hello", offset: 5 });

    assert.deepEqual(descriptorsFor(target), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
