import { createHash } from "node:crypto";
import { IdempotencyConflictError } from "./errors.ts";
import type { AgentId } from "./types.ts";

// The wire contract for session-event forwarding from a remote sandbox: the in-sandbox forwarder pushes chunks of a stream file to
// the daemon's append endpoint over the daemon-api channel, and the daemon writes the same host-side file a local sandbox writes
// directly. A resumed agent continues the same stream (its sandbox is seeded from the checkpoint), so a higher generation takes over
// at the acknowledged offset and keeps the chain; it never restarts the stream at 0. Pure: no fs, no sockets. Both sides call the same validators and `applyAppend`, so the forwarder and the handler cannot
// drift. Records hold ids, offsets and digests only, never local paths. The endpoint itself belongs to the daemon.

export const SESSION_APPEND_STREAMS = ["events", "session"] as const;
export type SessionAppendStream = (typeof SESSION_APPEND_STREAMS)[number];

// Bounds on one append: decoded chunk bytes and the length of the ids. A chunk is a byte range of the stream file, not a list of records.
export const MAX_SESSION_APPEND_BYTES = 1024 * 1024;
export const MAX_SESSION_APPEND_ID_LENGTH = 256;

// The chain before any chunk was accepted.
export const SESSION_APPEND_GENESIS = "0".repeat(64);

export interface SessionAppendRequest {
  readonly agent: AgentId;
  readonly generation: number;
  readonly stream: SessionAppendStream;
  // Byte offset of the first byte of `data` in the stream file; must equal the daemon's acknowledged offset.
  readonly offset: number;
  // The chunk, base64 (canonical, padded). Never empty.
  readonly data: string;
  // Lowercase hex sha256 of the decoded chunk bytes.
  readonly sha256: string;
  readonly idempotencyKey: string;
}

export interface SessionAppendResponse {
  // The stream length the daemon holds after this append: the offset to send next.
  readonly ackedOffset: number;
  // The chain digest after this append: `chainAfter(previous chain, chunk sha256)`. Lets the sender confirm the daemon holds the same bytes.
  readonly chainSha256: string;
}

export interface SessionAppendState {
  // The stream this state belongs to; a request for another agent or stream is refused.
  readonly agent: AgentId;
  readonly stream: SessionAppendStream;
  readonly generation: number;
  readonly offset: number;
  // Chain digest of everything acknowledged so far; 64 lowercase hex.
  readonly chainSha256: string;
  // The most recent accepted append, kept so an exact retry of it returns the original answer.
  readonly last: {
    readonly idempotencyKey: string;
    readonly generation: number;
    readonly offset: number;
    readonly chunkSha256: string;
    readonly response: SessionAppendResponse;
  } | null;
}

export const initialSessionAppendState = (agent: AgentId, stream: SessionAppendStream, generation: number): SessionAppendState => ({
  agent,
  stream,
  generation,
  offset: 0,
  chainSha256: SESSION_APPEND_GENESIS,
  last: null,
});

const MAX_BASE64_CHARS = Math.ceil(MAX_SESSION_APPEND_BYTES / 3) * 4;
const HEX64 = /^[0-9a-f]{64}$/;
const REQUEST_FIELDS = ["agent", "generation", "stream", "offset", "data", "sha256", "idempotencyKey"];
const RESPONSE_FIELDS = ["ackedOffset", "chainSha256"];
const MAX_ECHO = 80;

const sha256OfBytes = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
export const chainAfter = (previous: string, chunkSha256: string): string => createHash("sha256").update(`${previous}:${chunkSha256}`).digest("hex");

// Caller-supplied text is echoed in messages only clipped and safely printed (BigInt and cycles do not throw).
function show(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = Object.prototype.toString.call(v);
  }
  return s.length > MAX_ECHO ? `${s.slice(0, MAX_ECHO)}...` : s;
}

export type SessionAppendRejection = "invalid" | "mismatch" | "stale" | "gap" | "outOfOrder";

export type SessionAppendValidation =
  | { readonly ok: true; readonly value: SessionAppendRequest; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly kind: "invalid" | "mismatch"; readonly message: string };

const isRecord = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_SESSION_APPEND_ID_LENGTH;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function unknownFields(v: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  return extra.length === 0 ? null : show(extra.join(", "));
}

// Strict shape check, then the content check: the sha256 is recomputed over the decoded bytes. Used by the sender before it sends and
// by the handler before it writes, so a corrupted chunk is refused on both sides.
export function validateSessionAppendRequest(value: unknown): SessionAppendValidation {
  const bad = (message: string): SessionAppendValidation => ({ ok: false, kind: "invalid", message: `session append request ${message}` });
  if (!isRecord(value)) return bad("must be an object; send {agent, generation, stream, offset, data, sha256, idempotencyKey}");
  const extra = unknownFields(value, REQUEST_FIELDS);
  if (extra !== null) return bad(`has unknown field(s) ${extra}; send only ${REQUEST_FIELDS.join(", ")}`);
  if (!isId(value.agent)) return bad(`agent must be a non-empty id of at most ${MAX_SESSION_APPEND_ID_LENGTH} characters; send the agent's id`);
  if (!isCount(value.generation)) return bad(`generation must be a non-negative integer, got ${show(value.generation)}; send the agent's current generation`);
  if (typeof value.stream !== "string" || !(SESSION_APPEND_STREAMS as readonly string[]).includes(value.stream))
    return bad(`stream must be one of ${SESSION_APPEND_STREAMS.join(", ")}, got ${show(value.stream)}; name the stream being forwarded`);
  if (!isCount(value.offset)) return bad(`offset must be a non-negative integer, got ${show(value.offset)}; send the acknowledged offset`);
  if (!isId(value.idempotencyKey))
    return bad(`idempotencyKey must be a non-empty string of at most ${MAX_SESSION_APPEND_ID_LENGTH} characters; send a key per chunk and reuse it on retry`);
  if (typeof value.sha256 !== "string" || !HEX64.test(value.sha256))
    return bad("sha256 must be 64 lowercase hex characters; send the sha256 of the chunk bytes");
  if (typeof value.data !== "string" || value.data === "") return bad("data must be a non-empty base64 string; skip empty chunks instead of sending them");
  // Bound before decoding so an oversized string is not allocated.
  if (value.data.length > MAX_BASE64_CHARS)
    return bad(
      `data is longer than ${MAX_BASE64_CHARS} base64 characters, the encoding of ${MAX_SESSION_APPEND_BYTES} bytes; split the chunk and send it as several appends`,
    );
  const bytes = Buffer.from(value.data, "base64");
  if (bytes.toString("base64") !== value.data) return bad("data is not canonical padded base64; encode the chunk with standard base64");
  if (bytes.length > MAX_SESSION_APPEND_BYTES) return bad(`data exceeds ${MAX_SESSION_APPEND_BYTES} bytes; split the chunk and send it as several appends`);
  const actual = sha256OfBytes(bytes);
  if (actual !== value.sha256)
    return {
      ok: false,
      kind: "mismatch",
      message: `session append request sha256 ${value.sha256} does not match the chunk bytes (${actual}); the chunk was corrupted or mislabelled, so nothing was written; re-read the chunk from the stream file and resend it`,
    };
  return { ok: true, value: value as unknown as SessionAppendRequest, bytes };
}

export type SessionAppendResponseValidation = { readonly ok: true; readonly value: SessionAppendResponse } | { readonly ok: false; readonly message: string };

// Shape check of a response. When the sender passes the request it just made and the chain it held before, the response must also
// acknowledge exactly that request's end offset and the chain digest the sender computes itself, so a daemon that holds different
// bytes is detected before the forwarder advances.
export function validateSessionAppendResponse(
  value: unknown,
  expected?: { readonly request: SessionAppendRequest; readonly previousChain: string },
): SessionAppendResponseValidation {
  const bad = (message: string): SessionAppendResponseValidation => ({ ok: false, message: `session append response ${message}` });
  if (!isRecord(value)) return bad("must be an object; the daemon's append endpoint is incompatible, upgrade the daemon or the agent image");
  const extra = unknownFields(value, RESPONSE_FIELDS);
  if (extra !== null) return bad(`has unknown field(s) ${extra}; the daemon and the agent image disagree on the contract, upgrade them together`);
  if (!isCount(value.ackedOffset)) return bad(`ackedOffset must be a non-negative integer, got ${show(value.ackedOffset)}; report a daemon bug`);
  if (typeof value.chainSha256 !== "string" || !HEX64.test(value.chainSha256))
    return bad("chainSha256 must be 64 lowercase hex characters; report a daemon bug");
  const response = value as unknown as SessionAppendResponse;
  if (expected !== undefined) {
    if (!HEX64.test(expected.previousChain))
      return bad("cannot be checked: the sender's previous chain is not 64 lowercase hex; restart the forwarder from the daemon's current state");
    const length = Buffer.from(expected.request.data, "base64").length;
    const end = expected.request.offset + length;
    if (response.ackedOffset !== end)
      return bad(
        `acknowledged offset ${response.ackedOffset} but the chunk ends at ${end}; resume from the acknowledged offset by re-reading the stream file there`,
      );
    const chain = chainAfter(expected.previousChain, expected.request.sha256);
    if (response.chainSha256 !== chain)
      return bad(
        `chain digest ${response.chainSha256} differs from the sender's ${chain}; the daemon holds different bytes, so stop forwarding and report the stream as diverged`,
      );
  }
  return { ok: true, value: response };
}

export type SessionAppendResult =
  | { readonly kind: "accepted"; readonly state: SessionAppendState; readonly response: SessionAppendResponse; readonly bytes: Uint8Array }
  // The original answer to an exact retry of the last accepted append; no bytes are written again.
  | { readonly kind: "duplicate"; readonly state: SessionAppendState; readonly response: SessionAppendResponse }
  | { readonly kind: SessionAppendRejection; readonly message: string; readonly ackedOffset: number };

// Decide one append against the stream's state. Pure: the caller writes `bytes` and stores `state` only on "accepted". Throws
// IdempotencyConflictError when the key of the last accepted append is reused for different content, and Error when the state itself
// is malformed. Only the LAST accepted append is replayable: retrying an earlier one after later appends returns "outOfOrder" (no
// bytes added; the sender resyncs from `ackedOffset`); a wider replay window is a decision for the endpoint. A higher generation
// continues at the acknowledged offset; a retry of the last append from an older generation is "stale".
export function applyAppend(state: SessionAppendState, request: unknown): SessionAppendResult {
  if (!HEX64.test(state.chainSha256))
    throw new Error(`session append state chain ${show(state.chainSha256)} is not 64 lowercase hex; rebuild the state from the stored stream`);
  const checked = validateSessionAppendRequest(request);
  if (!checked.ok) return { kind: checked.kind, message: checked.message, ackedOffset: state.offset };
  const req = checked.value;
  if (req.agent !== state.agent || req.stream !== state.stream)
    return {
      kind: "invalid",
      message: `session append for agent ${show(req.agent)} stream ${show(req.stream)} was sent to the state of agent ${show(state.agent)} stream ${show(state.stream)}; route the append to its own stream or fix the sender's agent and stream`,
      ackedOffset: state.offset,
    };
  if (req.generation < state.generation)
    return {
      kind: "stale",
      message: `session append for agent ${show(req.agent)} carries generation ${req.generation} but the stream is at generation ${state.generation}; this forwarder was superseded, so stop forwarding`,
      ackedOffset: state.offset,
    };
  const last = state.last;
  if (last !== null && last.idempotencyKey === req.idempotencyKey) {
    if (last.generation !== req.generation || last.offset !== req.offset || last.chunkSha256 !== req.sha256)
      throw new IdempotencyConflictError("session.append", req.idempotencyKey);
    return { kind: "duplicate", state, response: last.response };
  }
  if (req.offset < state.offset)
    return {
      kind: "outOfOrder",
      message: `session append at offset ${req.offset} is behind the acknowledged offset ${state.offset}; it was already received or arrived late, so resume from ${state.offset}`,
      ackedOffset: state.offset,
    };
  if (req.offset > state.offset)
    return {
      kind: "gap",
      message: `session append at offset ${req.offset} leaves a gap after the acknowledged offset ${state.offset}; bytes ${state.offset}..${req.offset} were never received, so resend from ${state.offset}`,
      ackedOffset: state.offset,
    };
  const response: SessionAppendResponse = { ackedOffset: req.offset + checked.bytes.length, chainSha256: chainAfter(state.chainSha256, req.sha256) };
  const next: SessionAppendState = {
    agent: state.agent,
    stream: state.stream,
    generation: req.generation,
    offset: response.ackedOffset,
    chainSha256: response.chainSha256,
    last: { idempotencyKey: req.idempotencyKey, generation: req.generation, offset: req.offset, chunkSha256: req.sha256, response },
  };
  return { kind: "accepted", state: next, response, bytes: checked.bytes };
}
