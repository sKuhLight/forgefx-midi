/**
 * FullRes cab-IR dump — the `0x67/0x68/0x69` group (32 KB, XTEA).
 *
 * This family is RECEIVE-ONLY in the reference client: it has no builder for
 * `0x67/0x68/0x69`, and no captured sample exists. The generic large-record
 * group `0x5A/0x5B/0x5C` (cabGroup.ts) is its write-direction sibling, but this
 * module deliberately exposes no FullRes write path.
 *
 * Container grammar (all gen-3):
 *   - `0x67` header, 3-byte payload: 21-bit word count in the code-literal
 *     `high, low, middle` septet order — `wc = (p0 << 14) | p1 | (p2 << 7)`.
 *     The order is code-literal and has not been confirmed by a capture.
 *   - `0x68` chunk, 1,290-byte frame: 2-byte word count (256) + 256 words,
 *     5 septets each, LSB-first: `w = b0 | b1<<7 | b2<<14 | b3<<21 | b4<<28`.
 *   - `0x69` footer: XOR32 of every assembled word, 5 septets.
 * Validation: per-frame XOR7, assembled bytes >> 2 == word count, footer XOR32.
 *
 * The assembled 32 KB body is ciphertext. Decryption takes the key as an
 * injected parameter; no key material lives in this package.
 */

import { splitFractalFrames, type FractalFrame } from './frame.js';
import { decryptXteaPairs, type XteaRecordKey } from '../../shared/xtea.js';

export { type XteaRecordKey };

export const FULLRES_IR_FUNCS = Object.freeze({
  header: 0x67,
  chunk: 0x68,
  footer: 0x69,
});

export const FULLRES_IR_HEADER_PAYLOAD_LEN = 3;
export const FULLRES_IR_CHUNK_PAYLOAD_LEN = 1282;
export const FULLRES_IR_FOOTER_PAYLOAD_LEN = 5;
export const FULLRES_IR_CHUNK_WORDS = 256;
export const FULLRES_IR_CHUNKS = 32;
export const FULLRES_IR_TOTAL_WORDS = 8192;
export const FULLRES_IR_TOTAL_BYTES = 32_768;
export const FULLRES_IR_FRAMES = 34;
export const FULLRES_IR_PAIR_COUNT = FULLRES_IR_TOTAL_BYTES / 8;

export interface ParsedFullResIr {
  readonly modelId: number;
  /** Declared word count (must be the FullRes 8,192-word record). */
  readonly wordCount: number;
  /** Assembled little-endian u32 words (ciphertext). */
  readonly words: Uint32Array;
  /** The assembled 32,768-byte record exactly as it arrived (ciphertext). */
  readonly cipher: Uint8Array;
  readonly footerXor: number;
}

function hex(n: number): string {
  return '0x' + (n & 0xff).toString(16).padStart(2, '0');
}

function decodeSeptetsLE(payload: Uint8Array, count: number, what: string): number {
  if (payload.length < count) throw new Error(`${what}: expected ${count} payload bytes, got ${payload.length}`);
  let value = 0;
  for (let i = 0; i < count; i++) {
    if (payload[i] > 0x7f) throw new Error(`${what}: septet ${i} is not 7-bit`);
    value |= payload[i] << (7 * i);
  }
  return value >>> 0;
}

/** Frames in a `0x67` group for a given word count: 1 + ceil(wc/256) + 1. */
export function fullResIrFrameCount(wordCount: number): number {
  if (!Number.isInteger(wordCount) || wordCount < 1 || wordCount > 0x1f_ffff) {
    throw new Error(`fullResIrFrameCount: word count ${wordCount} is out of range`);
  }
  return 2 + Math.ceil(wordCount / FULLRES_IR_CHUNK_WORDS);
}

/**
 * Reassemble and validate a `0x67/0x68/0x69` group. Only the FullRes record
 * size (8,192 words / 32 KB) is accepted: the reference reader always transforms
 * that fixed length, so a shorter declaration is a malformed record here.
 */
export function parseFullResIrFrames(
  frames: readonly FractalFrame[],
  expectedModelId?: number,
): ParsedFullResIr {
  if (frames.length !== FULLRES_IR_FRAMES) {
    throw new Error(`FullRes IR: ${frames.length} frames, expected ${FULLRES_IR_FRAMES}`);
  }
  const header = frames[0];
  if (header.func !== FULLRES_IR_FUNCS.header) {
    throw new Error(`FullRes IR: first frame is ${hex(header.func)}, expected ${hex(FULLRES_IR_FUNCS.header)}`);
  }
  if (header.payload.length !== FULLRES_IR_HEADER_PAYLOAD_LEN) {
    throw new Error(
      `FullRes IR: header payload is ${header.payload.length} bytes, expected ${FULLRES_IR_HEADER_PAYLOAD_LEN}`,
    );
  }
  // Code-literal order from the reference reader: high group, low group, middle group.
  const wordCount = ((header.payload[0] << 14) | header.payload[1] | (header.payload[2] << 7)) >>> 0;
  if (wordCount !== FULLRES_IR_TOTAL_WORDS) {
    throw new Error(`FullRes IR: header declares ${wordCount} words, expected ${FULLRES_IR_TOTAL_WORDS}`);
  }

  const modelId = expectedModelId ?? header.modelId;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].modelId !== modelId) {
      throw new Error(`FullRes IR: frame ${i + 1} model ${hex(frames[i].modelId)} != ${hex(modelId)}`);
    }
  }

  const words = new Uint32Array(FULLRES_IR_TOTAL_WORDS);
  let emitted = 0;
  for (let index = 0; index < FULLRES_IR_CHUNKS; index++) {
    const chunk = frames[1 + index];
    if (chunk.func !== FULLRES_IR_FUNCS.chunk) {
      throw new Error(
        `FullRes IR: chunk ${index + 1} has func ${hex(chunk.func)}, expected ${hex(FULLRES_IR_FUNCS.chunk)}`,
      );
    }
    if (chunk.payload.length !== FULLRES_IR_CHUNK_PAYLOAD_LEN) {
      throw new Error(
        `FullRes IR: chunk ${index + 1} payload is ${chunk.payload.length} bytes, ` +
          `expected ${FULLRES_IR_CHUNK_PAYLOAD_LEN}`,
      );
    }
    const chunkWords = decodeSeptetsLE(chunk.payload, 2, `FullRes IR chunk ${index + 1}`);
    if (chunkWords !== FULLRES_IR_CHUNK_WORDS) {
      throw new Error(
        `FullRes IR: chunk ${index + 1} declares ${chunkWords} words, expected ${FULLRES_IR_CHUNK_WORDS}`,
      );
    }
    if (chunk.payload.length !== 2 + chunkWords * 5) {
      throw new Error(`FullRes IR: chunk ${index + 1} payload does not match ${chunkWords} words`);
    }
    for (let w = 0; w < chunkWords; w++) {
      const off = 2 + w * 5;
      if (chunk.payload[off + 4] > 0x0f) {
        throw new Error(`FullRes IR: chunk ${index + 1} word ${w} has non-zero high septet bits`);
      }
      words[emitted + w] =
        (chunk.payload[off] |
          (chunk.payload[off + 1] << 7) |
          (chunk.payload[off + 2] << 14) |
          (chunk.payload[off + 3] << 21) |
          (chunk.payload[off + 4] << 28)) >>>
        0;
    }
    emitted += chunkWords;
  }
  if (emitted !== FULLRES_IR_TOTAL_WORDS) {
    throw new Error(`FullRes IR: assembled ${emitted} words, expected ${FULLRES_IR_TOTAL_WORDS}`);
  }

  const footer = frames[frames.length - 1];
  if (footer.func !== FULLRES_IR_FUNCS.footer) {
    throw new Error(
      `FullRes IR: last frame is ${hex(footer.func)}, expected ${hex(FULLRES_IR_FUNCS.footer)}`,
    );
  }
  if (footer.payload.length !== FULLRES_IR_FOOTER_PAYLOAD_LEN) {
    throw new Error(
      `FullRes IR: footer payload is ${footer.payload.length} bytes, expected ${FULLRES_IR_FOOTER_PAYLOAD_LEN}`,
    );
  }
  if (footer.payload[4] > 0x0f) {
    throw new Error('FullRes IR: footer XOR has non-zero high septet bits');
  }
  const footerXor = decodeSeptetsLE(footer.payload, 5, 'FullRes IR footer');
  let computedXor = 0;
  for (let i = 0; i < words.length; i++) computedXor = (computedXor ^ words[i]) >>> 0;
  if (computedXor !== footerXor) {
    throw new Error(
      `FullRes IR: footer XOR 0x${footerXor.toString(16)} does not match assembled 0x${computedXor.toString(16)}`,
    );
  }

  const cipher = new Uint8Array(FULLRES_IR_TOTAL_BYTES);
  const view = new DataView(cipher.buffer);
  for (let i = 0; i < words.length; i++) view.setUint32(i * 4, words[i], true);

  return { modelId, wordCount, words, cipher, footerXor };
}

/** Parse a complete `0x67/0x68/0x69` group from concatenated frame bytes. */
export function parseFullResIr(bytes: Uint8Array, expectedModelId?: number): ParsedFullResIr {
  const frames = splitFractalFrames(bytes, 'FullRes IR', expectedModelId);
  return parseFullResIrFrames(frames, expectedModelId);
}

/**
 * Decrypt a parsed FullRes record. The 32 KB body is XTEA ciphertext from
 * offset 0 (4,096 pairs). The caller supplies the key; nothing is cached or
 * logged.
 */
export function decryptFullResIr(parsed: ParsedFullResIr, key: XteaRecordKey): Uint8Array {
  return decryptXteaPairs(parsed.cipher, key, { pairCount: FULLRES_IR_PAIR_COUNT, offset: 0 });
}
