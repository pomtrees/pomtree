// Pure parsing of the bytes at the front of a git bundle: header (prerequisites, refs) and the pack
// preamble (object count). Lets the controller reject on size, format, refs and prerequisites before
// any git process sees the data.

export interface BundleHeader {
  version: 2 | 3;
  prerequisites: string[]; // commit ids the receiver must already have
  refs: { name: string; oid: string }[];
  packOffset: number; // byte offset of "PACK"
  objectCount: number; // from the pack preamble
}

export type BundleParse = { ok: true; header: BundleHeader } | { ok: false; message: string };

export const MAX_BUNDLE_HEADER_BYTES = 1 << 20;

// `head` must hold at least the header plus 12 bytes of pack preamble (or the whole file if shorter).
export function parseBundleHead(head: Uint8Array): BundleParse {
  const buf = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  const fail = (message: string): BundleParse => ({ ok: false, message });
  let pos = 0;
  const line = (): string | null => {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) return null;
    const s = buf.toString("latin1", pos, nl);
    pos = nl + 1;
    return s;
  };
  const first = line();
  const version = first === "# v2 git bundle" ? 2 : first === "# v3 git bundle" ? 3 : 0;
  if (!version) return fail("not a git bundle (v2 or v3)");
  const prerequisites: string[] = [];
  const refs: { name: string; oid: string }[] = [];
  for (;;) {
    const l = line();
    if (l === null) return fail("truncated bundle header");
    if (l === "") break;
    if (version === 3 && l.startsWith("@")) {
      const cap = l.slice(1);
      if (cap.startsWith("filter=")) return fail("filtered bundles are not accepted");
      if (cap.startsWith("object-format=") && cap !== "object-format=sha1") return fail(`unsupported ${cap}`);
      continue;
    }
    if (l.startsWith("-")) {
      const m = /^-([0-9a-f]{40})(?: .*)?$/.exec(l);
      if (!m) return fail("malformed prerequisite line");
      prerequisites.push(m[1]!);
      continue;
    }
    const m = /^([0-9a-f]{40}) (.+)$/.exec(l);
    if (!m) return fail("malformed ref line");
    refs.push({ oid: m[1]!, name: m[2]! });
  }
  if (buf.length < pos + 12 || buf.toString("latin1", pos, pos + 4) !== "PACK") return fail("missing pack data");
  const packVersion = buf.readUInt32BE(pos + 4);
  if (packVersion !== 2 && packVersion !== 3) return fail("unsupported pack version");
  return { ok: true, header: { version, prerequisites, refs, packOffset: pos, objectCount: buf.readUInt32BE(pos + 8) } };
}
