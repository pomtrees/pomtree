// Bounded byte ring buffer for replaying recent raw terminal output to
// late-joining viewers. Pure: no fs/net coupling.

export const DEFAULT_RING_CAPACITY = 256 * 1024;

export class RingBuffer {
  readonly capacity: number;
  #buf: Uint8Array;
  #start = 0; // index of the oldest byte
  #size = 0;

  constructor(capacity: number = DEFAULT_RING_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`ring capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.#buf = new Uint8Array(capacity);
  }

  get size(): number {
    return this.#size;
  }

  /** Append bytes, evicting the oldest when full. Oversized input keeps its tail. */
  append(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (bytes.length >= this.capacity) {
      this.#buf.set(bytes.subarray(bytes.length - this.capacity));
      this.#start = 0;
      this.#size = this.capacity;
      return;
    }
    const end = (this.#start + this.#size) % this.capacity;
    const first = Math.min(bytes.length, this.capacity - end);
    this.#buf.set(bytes.subarray(0, first), end);
    if (first < bytes.length) this.#buf.set(bytes.subarray(first), 0);
    const overflow = this.#size + bytes.length - this.capacity;
    if (overflow > 0) {
      this.#start = (this.#start + overflow) % this.capacity;
      this.#size = this.capacity;
    } else {
      this.#size += bytes.length;
    }
  }

  /** Contiguous copy, oldest to newest. */
  snapshot(): Uint8Array {
    const out = new Uint8Array(this.#size);
    const first = Math.min(this.#size, this.capacity - this.#start);
    out.set(this.#buf.subarray(this.#start, this.#start + first), 0);
    if (first < this.#size) out.set(this.#buf.subarray(0, this.#size - first), first);
    return out;
  }

  clear(): void {
    this.#start = 0;
    this.#size = 0;
  }
}

const ESC = 0x1b;
const BEL = 0x07;

/**
 * End index (exclusive) of the escape sequence starting at `i` (bytes[i] is
 * ESC), or -1 when the sequence is incomplete in `bytes`.
 */
function escapeEnd(bytes: Uint8Array, i: number): number {
  if (i + 1 >= bytes.length) return -1;
  const kind = bytes[i + 1]!;
  if (kind === 0x5b) {
    // CSI: parameters 0x30-0x3F, intermediates 0x20-0x2F, final 0x40-0x7E.
    for (let j = i + 2; j < bytes.length; j++) {
      const b = bytes[j]!;
      if (b >= 0x40 && b <= 0x7e) return j + 1;
      if (b < 0x20 || b > 0x3f) return j; // malformed: treat as ended before it
    }
    return -1;
  }
  // OSC (]), DCS (P), SOS (X), PM (^), APC (_): terminated by BEL or ESC \.
  if (kind === 0x5d || kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) {
    for (let j = i + 2; j < bytes.length; j++) {
      if (bytes[j] === BEL && kind === 0x5d) return j + 1;
      if (bytes[j] === ESC) return j + 1 < bytes.length ? (bytes[j + 1] === 0x5c ? j + 2 : j) : -1;
    }
    return -1;
  }
  return i + 2; // two-byte escape (ESC 7, ESC =, ...)
}

/**
 * Drop leading bytes of a ring snapshot up to the first safe replay boundary,
 * so the cut that eviction made cannot start mid-escape or mid-UTF-8 char.
 *
 * Order: (1) after the first newline; else (2) after the first complete
 * escape sequence (CSI/OSC/two-byte); else (3) only strip leading UTF-8
 * continuation bytes. Returns a subarray (no copy); empty when the only
 * escape found is incomplete.
 *
 * Limits: this cannot restore terminal state (colors, cursor position,
 * alternate-screen mode, scroll regions set by the dropped bytes), and with
 * no newline and no ESC a cut inside a bare CSI tail ("31m...") is not
 * detectable and is returned as-is.
 */
export function trimToSafeStart(bytes: Uint8Array): Uint8Array {
  const nl = bytes.indexOf(0x0a);
  if (nl >= 0) return bytes.subarray(nl + 1);
  const esc = bytes.indexOf(ESC);
  if (esc >= 0) {
    const end = escapeEnd(bytes, esc);
    return end < 0 ? bytes.subarray(bytes.length) : bytes.subarray(end);
  }
  let i = 0;
  while (i < bytes.length && (bytes[i]! & 0xc0) === 0x80) i++;
  return bytes.subarray(i);
}
