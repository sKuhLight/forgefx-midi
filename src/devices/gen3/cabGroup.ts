/**
 * Generic large-record cab group — `0x5A/0x5B/0x5C` (write direction).
 *
 * The reference client uses this family to write cab records that do not fit
 * the 8 KB `0x7A/0x7B/0x7C` group, including the FullRes profile. It is a pure
 * container: it splats a caller-supplied word array into frames and never
 * interprets, tags or encrypts a word.
 *
 *   - `0x5A` header, 6-byte payload: `dest` (7 bits), `index` (14 bits),
 *     `wordCount` (21 bits), all little-endian septets.
 *   - `0x5B` chunk, 1,290-byte frame: 2-byte word count (256) + 256 words as
 *     5 septets each (LSB-first; the fifth septet is `word >>> 28`).
 *   - `0x5C` footer: XOR32 of every record word as 5 septets.
 *
 * This module is framing only. It has no FullRes profile, no `0xB0` marker, no
 * key schedule, no record assembly and no send/apply sequence. The FullRes
 * `0xB0` record's word count is unresolved (the writer's packer argument and
 * the reader's fixed transform disagree by a factor of eight), so `wordCount`
 * is a caller-supplied input here and no `0xB0` size constant is defined.
 * The `0x67/0x68/0x69` read family and this write family do NOT share a header
 * encoding: `0x67` carries only the word count in `high, low, middle` order,
 * while `0x5A` carries a destination, an index and the word count LSB-first.
 */

import { buildFractalFrame } from './frame.js';

export const CAB_GROUP_FUNCS = Object.freeze({
  header: 0x5a,
  chunk: 0x5b,
  footer: 0x5c,
});

export const CAB_GROUP_HEADER_PAYLOAD_LEN = 6;
export const CAB_GROUP_CHUNK_WORDS = 256;
export const CAB_GROUP_CHUNK_PAYLOAD_LEN = 2 + CAB_GROUP_CHUNK_WORDS * 5;
export const CAB_GROUP_FOOTER_PAYLOAD_LEN = 5;
/** `0x800 >> 10` — the user-cab bank's destination field. */
export const CAB_GROUP_USER_CAB_DEST = 2;
/** Scratchpad / standalone sentinel (`0x7F`, `0x3FFF`). */
export const CAB_GROUP_SCRATCHPAD = Object.freeze({ destination: 0x7f, index: 0x3fff });

export interface CabGroupHeader {
  readonly destination: number;
  readonly index: number;
  readonly wordCount: number;
}

export interface CabGroupSlot {
  readonly destination: number;
  readonly index: number;
}

function assertUint(value: number, max: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${what}: ${value} is out of range (0..${max})`);
  }
}

/** Split a 14-bit absolute slot into the group's `(destination, index)` fields. */
export function cabGroupSlot(slot: number): CabGroupSlot {
  assertUint(slot, 0x3fff, 'cabGroupSlot');
  return { destination: (slot >> 10) & 0x7f, index: slot & 0x3ff };
}

/** Frames in a group: header + ceil(wordCount/256) chunks + footer. */
export function cabGroupFrameCount(wordCount: number): number {
  assertUint(wordCount, 0x1f_ffff, 'cabGroupFrameCount');
  return 2 + Math.ceil(wordCount / CAB_GROUP_CHUNK_WORDS);
}

/** Build the `0x5A` header. */
export function buildCabGroupHeader(header: CabGroupHeader, modelId: number): Uint8Array {
  assertUint(header.destination, 0x7f, 'buildCabGroupHeader destination');
  assertUint(header.index, 0x3fff, 'buildCabGroupHeader index');
  assertUint(header.wordCount, 0x1f_ffff, 'buildCabGroupHeader wordCount');
  return buildFractalFrame(modelId, CAB_GROUP_FUNCS.header, Uint8Array.from([
    header.destination,
    header.index & 0x7f,
    (header.index >> 7) & 0x7f,
    header.wordCount & 0x7f,
    (header.wordCount >> 7) & 0x7f,
    (header.wordCount >> 14) & 0x7f,
  ]));
}

/** Build one `0x5B` chunk; the reference writer always emits 256 words. */
export function buildCabGroupChunk(words: readonly number[], modelId: number): Uint8Array {
  if (words.length !== CAB_GROUP_CHUNK_WORDS) {
    throw new Error(
      `buildCabGroupChunk: ${words.length} words, expected exactly ${CAB_GROUP_CHUNK_WORDS}`,
    );
  }
  const payload = new Uint8Array(CAB_GROUP_CHUNK_PAYLOAD_LEN);
  payload[0] = CAB_GROUP_CHUNK_WORDS & 0x7f;
  payload[1] = (CAB_GROUP_CHUNK_WORDS >> 7) & 0x7f;
  for (let i = 0; i < CAB_GROUP_CHUNK_WORDS; i++) {
    const word = words[i];
    if (!Number.isInteger(word) || word < 0 || word > 0xffffffff) {
      throw new Error(`buildCabGroupChunk: word ${i} is not a uint32`);
    }
    const off = 2 + i * 5;
    payload[off] = word & 0x7f;
    payload[off + 1] = (word >>> 7) & 0x7f;
    payload[off + 2] = (word >>> 14) & 0x7f;
    payload[off + 3] = (word >>> 21) & 0x7f;
    payload[off + 4] = (word >>> 28) & 0x0f;
  }
  return buildFractalFrame(modelId, CAB_GROUP_FUNCS.chunk, payload);
}

/** XOR32 over every record word (the `0x5C` footer value). */
export function xor32Words(words: readonly number[]): number {
  let xor = 0;
  for (const word of words) xor = (xor ^ word) >>> 0;
  return xor;
}

/** Build the `0x5C` footer. */
export function buildCabGroupFooter(xor32: number, modelId: number): Uint8Array {
  assertUint(xor32, 0xffffffff, 'buildCabGroupFooter');
  return buildFractalFrame(modelId, CAB_GROUP_FUNCS.footer, Uint8Array.from([
    xor32 & 0x7f,
    (xor32 >>> 7) & 0x7f,
    (xor32 >>> 14) & 0x7f,
    (xor32 >>> 21) & 0x7f,
    (xor32 >>> 28) & 0x0f,
  ]));
}
