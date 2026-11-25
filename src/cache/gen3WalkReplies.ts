/**
 * Reply decoding and read helpers for the gen-3 func 0x01 self-describe view:
 *
 *   - the block descriptor (`sub 0x01`) that supplies a block's parameter count;
 *   - the per-slot preset-name read (`sub 0x4B`);
 *   - the cab/IR bank record read (`sub 0x68` / `0x9F` / `0xA4`) whose layout is NOT decoded.
 *
 * All three share one reply framing: `F0 00 01 74 <model> 01 | inner | cksum F7`,
 * `inner = frame[6:-2]`, with the same 15-byte header as a request: `inner[0:2]` = u16-LE `sub`,
 * `inner[2:4]` = u16-LE `a`, `inner[4:6]` = u16-LE `b`, `inner[6:11]` = u32-LE `c` (four septets
 * plus a high-nibble byte), `inner[11:13]` = the header's second u16 word,
 * `inner[13:15]` = the raw payload count as a two-septet u16 (`inner[13] | inner[14] << 7`, so
 * `70 03` = 496), `inner[15:]` = a continuous MSB-first septet stream yielding exactly `cnt`
 * raw bytes. Decoding is count-driven.
 *
 * The block descriptor's count is the device's own answer, at descriptor `+0x1C` — for the
 * 56-byte payload form that is `payload+0x04`, for the 80-byte form `payload+0x1C`. It is the
 * only parameter count a walk may use; there is no fixed in-memory count constant. A reported count
 * may only TIGHTEN a walk's bound (`LiveWalkOptions.paramCountByBlock`): a count larger than the
 * caller's bound must not widen the walk.
 *
 * The cab/IR bank reply layout is undecoded on every model (no reply has been captured, and the
 * per-bank record stride is code-derived). This module therefore returns the raw payload bytes
 * and the profile's expected stride — it never interprets names or ids.
 *
 * Pure and browser-safe — no `node:*`, no `Buffer`.
 */
import { decodeSeptetStream } from './liveWalk.js';
import type { LiveTransport } from './liveWalk.js';
import { buildBlockDescriptorQuery, buildCabBankQuery, buildPresetNameQuery, GEN3_BLOCK_DESCRIPTOR_SUB, GEN3_PRESET_NAME_SUB, gen3WalkProfile } from './gen3WalkModel.js';

/** Extra attempts for a read that got no reply at all (default 1, the descriptor retry of the definition path). */
const DEFAULT_READ_RETRIES = 1;

/** One decoded gen-3 func-0x01 reply body (see the module comment). */
interface Gen3ReplyBody {
  model: number;
  sub: number;
  /** `a` echo (u16 LE at `inner[2:4]`). */
  a: number;
  /** `b` echo (u16 LE at `inner[4:6]`). */
  b: number;
  /** `c` word (four septets plus the high-nibble byte, `inner[6:11]`). */
  c: number;
  /** Raw payload bytes, `cnt` long. */
  raw: Uint8Array;
}

/** True for a well-formed func 0x01 reply envelope of a gen-3 model. */
function isSelfDescribeFrame(frame: Uint8Array): boolean {
  const n = frame.length;
  return n >= 23 && frame[0] === 0xf0 && frame[1] === 0x00 && frame[2] === 0x01 && frame[3] === 0x74 && frame[5] === 0x01 && frame[n - 1] === 0xf7;
}

/** Decode one func 0x01 reply body expected under `sub`, or `null`. */
function decodeGen3Reply(frame: Uint8Array, sub: number): Gen3ReplyBody | null {
  if (!isSelfDescribeFrame(frame)) return null;
  const inner = frame.subarray(6, frame.length - 2);
  if (inner.length < 15) return null;
  if ((inner[0]! | (inner[1]! << 7)) !== sub) return null;
  // The payload count is a 14-bit wire field: two little-endian septets. A raw u16 read is wrong
  // for every count >= 128 (a 544-byte cab record's `20 04` would read as 1056).
  const cnt = inner[13]! | (inner[14]! << 7);
  if (cnt < 1) return null;
  const wireLen = Math.ceil((cnt * 8) / 7);
  // Exact framing: extra bytes after the septet stream are a malformed/straggler frame, not a
  // payload this decoder can trust (and they are what a raw-u16 count would leave behind).
  if (inner.length !== 15 + wireLen) return null;
  const raw = decodeSeptetStream(inner, cnt, 15);
  if (raw.length !== cnt) return null;
  return {
    model: frame[4]!,
    sub,
    a: inner[2]! | (inner[3]! << 7),
    b: inner[4]! | (inner[5]! << 7),
    // `c` is four septets plus a high-nibble byte; values below 2^28 (every index this codec
    // sends) have a zero high byte.
    c: ((inner[6]! | (inner[7]! << 7) | (inner[8]! << 14) | (inner[9]! << 21)) + inner[10]! * 0x10000000) >>> 0,
    raw,
  };
}

/** A decoded func 0x01 sub 0x01 block descriptor. */
export interface Gen3BlockDescriptor {
  /** `a` echo (the block id, when the reply echoes it). */
  echoBlock: number;
  /** Number of parameters the device reports for the block (0 = the block has none). */
  paramCount: number;
  /** Payload form the count came from: the 56-byte short descriptor or the 80-byte long one. */
  payloadBytes: 56 | 80;
}

/**
 * Decode a block-descriptor reply. The count is the u32 at `payload+0x04` of the 56-byte form,
 * or at `payload+0x1C` of the 80-byte form. Returns `null` for any other payload length, an
 * impossible count (above `0x800`, the definition path's own sanity bound) or a malformed frame.
 */
export function decodeBlockDescriptor(frame: Uint8Array): Gen3BlockDescriptor | null {
  const body = decodeGen3Reply(frame, GEN3_BLOCK_DESCRIPTOR_SUB);
  if (!body) return null;
  const raw = body.raw;
  let count: number;
  if (raw.length === 56) count = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(4, true);
  else if (raw.length === 80) count = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0x1c, true);
  else return null;
  if (!Number.isInteger(count) || count < 0 || count > 0x800) return null;
  return { echoBlock: body.a, paramCount: count, payloadBytes: raw.length as 56 | 80 };
}

/** A decoded func 0x01 sub 0x4B preset-name reply. */
export interface Gen3PresetNameReply {
  /**
   * The leading NUL-terminated, printable run of the 32-byte name payload. Trailing spaces that
   * the device puts before the NUL are part of the name (the cache copies names verbatim); the
   * bytes after the terminator are stale buffer content and are ignored.
   */
  name: string;
}

/**
 * Decode a preset-name reply. Replies are ORDER-MATCHED — the captured reply's `c` word was a
 * constant, not the requested slot — so this returns the name only; the caller pairs it with the
 * slot it asked for.
 */
export function decodePresetNameReply(frame: Uint8Array): Gen3PresetNameReply | null {
  const body = decodeGen3Reply(frame, GEN3_PRESET_NAME_SUB);
  if (!body) return null;
  const raw = body.raw;
  let end = 0;
  while (end < raw.length && raw[end] !== 0x00) end += 1;
  let name = '';
  for (let i = 0; i < end; i++) {
    const c = raw[i]!;
    if (c < 0x20 || c >= 0x7f) return null; // a control byte inside a name is not a name
    name += String.fromCharCode(c);
  }
  return { name };
}

/** One raw cab/IR bank record read. */
export interface Gen3CabBankRecordReply {
  /**
   * The `c` word of the reply. The definition path keys each record by the index it reads from the
   * reply header (code-derived, MED); a caller may use it as a hint but should pair by request
   * order — no `0x68`/`0x9F`/`0xA4` reply has ever been captured.
   */
  echoIndex: number;
  /** Raw record bytes, exactly as the device answered them. */
  bytes: Uint8Array;
  /** The profile's cab-array stride (`cabRecordSize`); NOT a claim about `bytes.length`. */
  expectedRecordSize: number;
}

/**
 * Decode a cab/IR bank record reply into its RAW payload bytes. The record layout is undecoded
 * on every model, so nothing here is interpreted. The `sub` expected is the model's own
 * `cabBankSub`; an unknown model or a foreign `sub` returns `null`.
 */
export function decodeCabBankRecordReply(frame: Uint8Array, model: number): Gen3CabBankRecordReply | null {
  const profile = gen3WalkProfile(model);
  if (!profile) return null;
  const body = decodeGen3Reply(frame, profile.cabBankSub);
  if (!body) return null;
  return { echoIndex: body.c, bytes: body.raw, expectedRecordSize: profile.cabRecordSize };
}

/** Pacing / abort options shared by the gen-3 read helpers. */
export interface Gen3ReadOptions {
  /** Extra attempts for a read that got no reply at all (default 1; 0 = one attempt). */
  retries?: number;
  /** Pause before every retry, ms (default 0). A host that needs pacing between queries paces its transport. */
  interQueryMs?: number;
  /** Abort between queries (rejects with `Error('gen3 read aborted')`). */
  signal?: AbortSignal;
  /** Scheduler seam for `interQueryMs` (default the ambient `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
}

/** Query / loss accounting of one read helper. */
export interface Gen3ReadStats {
  /** Frames sent (retries included). */
  queries: number;
  /** Attempts that got no reply. */
  lostReplies: number;
  /** Replies that arrived but did not decode as the expected view. */
  malformedReplies: number;
}

async function pause(ms: number, sleep?: (ms: number) => Promise<void>): Promise<void> {
  if (ms <= 0) return;
  if (sleep) await sleep(ms);
  else await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('gen3 read aborted');
}

/**
 * Send one query (with the retries) and return its reply frame, or `null`. `lostReplies` counts
 * every unanswered attempt; a frame that arrives is the caller's to decode.
 */
async function requestFrame(transport: LiveTransport, query: Uint8Array, opts: Gen3ReadOptions, stats: Gen3ReadStats): Promise<Uint8Array | null> {
  const attempts = Math.max(0, opts.retries ?? DEFAULT_READ_RETRIES) + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    throwIfAborted(opts.signal);
    if (attempt > 0) await pause(opts.interQueryMs ?? 0, opts.sleep);
    const frame = await transport.request(query);
    stats.queries += 1;
    if (frame) return frame;
    stats.lostReplies += 1;
  }
  return null;
}

/** Outcome of `readBlockParamCounts`. */
export interface Gen3BlockParamCounts extends Gen3ReadStats {
  /** Device-reported parameter count per block (only blocks that answered a valid descriptor). */
  counts: Record<number, number>;
}

/**
 * Read the device-supplied parameter count of each block (`func 0x01 sub 0x01`). Feed the result
 * straight into `LiveWalkOptions.paramCountByBlock`: the walk lets a count only TIGHTEN the
 * block's bound, never widen it.
 */
export async function readBlockParamCounts(
  transport: LiveTransport,
  model: number,
  blocks: readonly number[],
  opts: Gen3ReadOptions = {},
): Promise<Gen3BlockParamCounts> {
  const stats: Gen3ReadStats = { queries: 0, lostReplies: 0, malformedReplies: 0 };
  const counts: Record<number, number> = {};
  for (const block of blocks) {
    const frame = await requestFrame(transport, buildBlockDescriptorQuery(model, block), opts, stats);
    if (!frame) continue;
    const descriptor = decodeBlockDescriptor(frame);
    if (!descriptor || descriptor.echoBlock !== block) {
      // A descriptor that echoes another block is a straggler: it must not tighten the wrong block.
      stats.malformedReplies += 1;
      continue;
    }
    counts[block] = descriptor.paramCount;
  }
  return { counts, ...stats };
}

/** One preset-name read result. */
export interface Gen3PresetName {
  /** The `c` slot word the name was requested with. */
  slotWord: number;
  /** The decoded name (see `Gen3PresetNameReply.name`). */
  name: string;
}

/** Outcome of `readPresetNames`. */
export interface Gen3PresetNameRead extends Gen3ReadStats {
  /** Names in request order (only slots that answered a valid name reply). */
  names: Gen3PresetName[];
}

/**
 * Read the preset-name table one slot at a time (`func 0x01 sub 0x4B`, `c` = slot word). The
 * device answers `<EMPTY>` for an empty slot; names are kept verbatim. User content: a caller
 * that persists the result must keep it local and redacted (see ./specialTables.ts).
 */
export async function readPresetNames(
  transport: LiveTransport,
  model: number,
  slotWords: readonly number[],
  opts: Gen3ReadOptions = {},
): Promise<Gen3PresetNameRead> {
  const stats: Gen3ReadStats = { queries: 0, lostReplies: 0, malformedReplies: 0 };
  const names: Gen3PresetName[] = [];
  for (const slotWord of slotWords) {
    const frame = await requestFrame(transport, buildPresetNameQuery(model, slotWord), opts, stats);
    if (!frame) continue;
    const reply = decodePresetNameReply(frame);
    if (!reply) {
      stats.malformedReplies += 1;
      continue;
    }
    names.push({ slotWord, name: reply.name });
  }
  return { names, ...stats };
}

/** One raw cab/IR bank record read result. */
export interface Gen3CabBankRecordRead {
  /** The record index that was requested. */
  index: number;
  /** Raw record bytes (layout undecoded — do not interpret). */
  bytes: Uint8Array;
}

/** Outcome of `readCabBankRecords`. */
export interface Gen3CabBankRead extends Gen3ReadStats {
  /** Raw records in request order. */
  records: Gen3CabBankRecordRead[];
  /** The profile's array stride, for a caller that wants to compare payload lengths. */
  expectedRecordSize: number;
}

/**
 * Read cab/IR bank records one index at a time (`func 0x01` with the model's `cabBankSub`,
 * `c` = index). Returns the RAW payloads: the record layout is undecoded on every model, so the
 * result cannot be turned into a name/id table. A caller that needs a `0xFFF0..` table must take
 * the names from a cache or another proven source and mark the table unknown otherwise.
 */
export async function readCabBankRecords(
  transport: LiveTransport,
  model: number,
  indices: readonly number[],
  opts: Gen3ReadOptions = {},
): Promise<Gen3CabBankRead> {
  const profile = gen3WalkProfile(model);
  if (!profile) throw new Error(`gen3 self-describe: model 0x${model.toString(16)} has no cab/IR bank read`);
  const stats: Gen3ReadStats = { queries: 0, lostReplies: 0, malformedReplies: 0 };
  const records: Gen3CabBankRecordRead[] = [];
  for (const index of indices) {
    const frame = await requestFrame(transport, buildCabBankQuery(model, index), opts, stats);
    if (!frame) continue;
    const reply = decodeCabBankRecordReply(frame, model);
    if (!reply) {
      stats.malformedReplies += 1;
      continue;
    }
    records.push({ index, bytes: reply.bytes });
  }
  return { records, expectedRecordSize: profile.cabRecordSize, ...stats };
}
