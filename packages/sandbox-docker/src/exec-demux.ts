// Pure demultiplexer for the Docker Engine's non-TTY attach/exec stream. Each frame is an 8-byte header (stream type byte, three
// zero bytes, uint32 big-endian payload length) followed by the payload. Headers and payloads may be split across any chunk
// boundary. No fs, socket or Docker coupling.

// Largest single frame accepted; Docker frames are small (<= 32 KiB in practice), so a larger claim is a corrupt or hostile stream.
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const HEADER_BYTES = 8;

export interface DemuxedChunk {
  stdout: Uint8Array[];
  stderr: Uint8Array[];
}

export interface ExecDemuxer {
  // Feeds the next bytes of the stream and returns the complete payload pieces they finished, in order. Throws on a malformed
  // header or a frame over the cap; the demuxer is then unusable (every later push throws the same error).
  push(chunk: Uint8Array): DemuxedChunk;
}

export function createExecDemuxer(maxFrame: number = MAX_FRAME_BYTES): ExecDemuxer {
  const header = Buffer.alloc(HEADER_BYTES);
  let headerFill = 0;
  let type = 0;
  let remaining = 0;
  let failure: Error | undefined;
  const fail = (msg: string): never => {
    failure = new Error(`${msg}; the exec stream is corrupt, close it and open a new one`);
    throw failure;
  };
  return {
    push(chunk) {
      if (failure) throw failure;
      const out: DemuxedChunk = { stdout: [], stderr: [] };
      let at = 0;
      while (at < chunk.length) {
        if (remaining === 0) {
          const take = Math.min(HEADER_BYTES - headerFill, chunk.length - at);
          header.set(chunk.subarray(at, at + take), headerFill);
          headerFill += take;
          at += take;
          if (headerFill < HEADER_BYTES) break;
          headerFill = 0;
          type = header[0]!;
          if (type > 2 || header[1] !== 0 || header[2] !== 0 || header[3] !== 0)
            fail(`invalid docker stream header (type ${type}, bytes ${header.subarray(1, 4).toString("hex")})`);
          remaining = header.readUInt32BE(4);
          if (remaining > maxFrame) fail(`docker stream frame of ${remaining} bytes exceeds the ${maxFrame}-byte cap`);
          continue;
        }
        const take = Math.min(remaining, chunk.length - at);
        const piece = Uint8Array.prototype.slice.call(chunk, at, at + take);
        at += take;
        remaining -= take;
        // Type 0 is stdin echo, which an exec never needs; drop it.
        if (type === 1) out.stdout.push(piece);
        else if (type === 2) out.stderr.push(piece);
      }
      return out;
    },
  };
}
