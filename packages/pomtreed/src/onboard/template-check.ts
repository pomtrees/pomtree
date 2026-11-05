// Validates planned template files with the store pomtreed itself uses: they are written to a fresh temp dir and read back through
// DirTemplateStore, so a file init would write is accepted exactly when the daemon would load it. The shell half of init's template
// handling (it touches the filesystem); the temp dir is always removed.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TemplateError } from "@pomtree/core";
import { DirTemplateStore } from "@pomtree/template-dir";

/** Returns one message per refused template (empty = all accepted). */
export async function checkTemplateFiles(files: readonly { id: string; content: string }[]): Promise<string[]> {
  if (files.length === 0) return [];
  const dir = mkdtempSync(join(tmpdir(), "pomtreed-init-templates-"));
  try {
    for (const f of files) writeFileSync(join(dir, `${f.id}.json`), f.content);
    const store = new DirTemplateStore({ root: dir });
    const errors: string[] = [];
    for (const f of files) {
      try {
        if ((await store.resolve(f.id)) === null) errors.push(`template ${f.id}: the store did not find the file it was given; this is a bug in pomtreed init`);
      } catch (e) {
        if (!(e instanceof TemplateError)) throw e;
        errors.push(`${e.message}; fix the template in the answers file`);
      }
    }
    return errors;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
