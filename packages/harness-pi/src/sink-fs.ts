// Thin fs shell for tailFollow: reads a host file by byte offset. Logic lives in tail.ts.
// The sink sits in the agent-writable session dir, so every (re)open goes through safeOpenRead: a planted FIFO, symlink or device
// is a SafeOpenError (the harness stops tailing and journals it) instead of a blocked event loop or a read of another file.
import { closeSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { safeOpenRead } from "./safe-open.ts";
import type { TailSource } from "./tail.ts";

export function fileTailSource(path: string): TailSource {
  let dec = new StringDecoder("utf8"); // keeps a multibyte char split across reads intact
  return {
    async read(offset) {
      const o = safeOpenRead(path);
      if (!o) return null;
      const { fd, size } = o;
      try {
        if (size < offset) {
          dec = new StringDecoder("utf8");
          return { text: "", offset: 0 };
        } // truncated
        if (size === offset) return { text: "", offset };
        const buf = Buffer.alloc(Math.min(size - offset, 1 << 20));
        const n = readSync(fd, buf, 0, buf.length, offset);
        return { text: dec.write(buf.subarray(0, n)), offset: offset + n };
      } finally {
        closeSync(fd);
      }
    },
  };
}
