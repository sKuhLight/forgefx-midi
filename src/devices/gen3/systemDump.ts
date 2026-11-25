/**
 * System + Global Blocks + Foot Controller dump (`0x43` request, `0x51/0x52/0x53`
 * reply group).
 *
 * The request is a lone `func 0x43` frame with an EMPTY payload — three
 * independent builders agree, e.g. on FM3:
 *
 *   F0 00 01 74 11 43 57 F7
 *
 * The reply is one `0x51` header, `ceil(words / 1024)` × `0x52` chunks, and one
 * `0x53` footer. The header's 3-byte payload is a 21-bit little-endian septet
 * word count; the captured group declares `00 00 04` = 65,536 words and arrives
 * as 1 + 64 + 1 = 66 frames. The same numeric field counts 16-bit words, not
 * bytes: 65,536 words is 64 chunks × 1,024 words (131,072 payload bytes). Each
 * `0x52` frame is 3,082 bytes: a 2-byte word count (LE septets, 1,024 on a full
 * chunk) followed by the declared 16-bit words packed 3 wire bytes per word; a
 * short last chunk still uses the fixed frame length. The `0x53` payload is the
 * XOR of every assembled 16-bit word, written as 3 LE septets.
 *
 * This module builds the request, the frame-count math and the reassembly /
 * validation only. It never opens a port and never applies anything.
 */

import { buildFractalFrame, type FractalFrame } from './frame.js';
import { splitFractalFrames } from './frame.js';

export const SYSTEM_DUMP_FUNCS = Object.freeze({
  request: 0x43,
  header: 0x51,
  chunk: 0x52,
  footer: 0x53,
});

export const SYSTEM_DUMP_HEADER_PAYLOAD_LEN = 3;
export const SYSTEM_DUMP_CHUNK_PAYLOAD_LEN = 3074;
export const SYSTEM_DUMP_FOOTER_PAYLOAD_LEN = 3;
export const SYSTEM_DUMP_CHUNK_WORDS = 1024;
/** Captured canonical group: 65,536 words → 1 + 64 + 1 frames. */
export const SYSTEM_DUMP_CANONICAL_WORDS = 65_536;
export const SYSTEM_DUMP_CANONICAL_FRAMES = 66;
/** The 21-bit header field can address at most 2,097,151 words. */
export const SYSTEM_DUMP_MAX_WORDS = 0x1f_ffff;

export interface ParsedSystemDump {
  readonly modelId: number;
  /** Word count declared by the `0x51` header. */
  readonly declaredWords: number;
  /** Per-chunk word counts in frame order. */
  readonly chunkWordCounts: readonly number[];
  /** Assembled little-endian 16-bit words (`declaredWords` entries). */
  readonly words: Uint16Array;
  /** XOR of every word, as carried by the `0x53` footer. */
  readonly footerXor: number;
}

function hex(n: number): string {
  return '0x' + (n & 0xff).toString(16).padStart(2, '0');
}

function assertWords(declaredWords: number, what: string): void {
  if (!Number.isInteger(declaredWords) || declaredWords < 1 || declaredWords > SYSTEM_DUMP_MAX_WORDS) {
    throw new Error(`${what}: word count ${declaredWords} is out of range (1..${SYSTEM_DUMP_MAX_WORDS})`);
  }
}

/** Number of frames in a system/GB/FC group: header + chunks + footer. */
export function systemDumpFrameCount(declaredWords: number): number {
  assertWords(declaredWords, 'systemDumpFrameCount');
  return 2 + Math.ceil(declaredWords / SYSTEM_DUMP_CHUNK_WORDS);
}

/** Build the `func 0x43` request (empty payload). */
export function buildSystemDumpRequest(modelId: number): Uint8Array {
  return buildFractalFrame(modelId, SYSTEM_DUMP_FUNCS.request, new Uint8Array(0));
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

/**
 * Reassemble a system/GB/FC group from parsed frames. Strict: exactly one
 * header first, exactly one footer last, the declared frame count, contiguous
 * `0x52` chunks, per-chunk word counts matching the declared total, and the
 * footer XOR.
 */
export function parseSystemDumpFrames(
  frames: readonly FractalFrame[],
  expectedModelId?: number,
): ParsedSystemDump {
  if (frames.length < 3) throw new Error(`system dump: expected at least 3 frames, got ${frames.length}`);
  const header = frames[0];
  const footer = frames[frames.length - 1];
  if (header.func !== SYSTEM_DUMP_FUNCS.header) {
    throw new Error(`system dump: first frame is ${hex(header.func)}, expected ${hex(SYSTEM_DUMP_FUNCS.header)}`);
  }
  if (header.payload.length !== SYSTEM_DUMP_HEADER_PAYLOAD_LEN) {
    throw new Error(
      `system dump: header payload is ${header.payload.length} bytes, expected ${SYSTEM_DUMP_HEADER_PAYLOAD_LEN}`,
    );
  }
  const declaredWords = decodeSeptetsLE(header.payload, 3, 'system dump header');
  assertWords(declaredWords, 'system dump');

  const expectedFrames = systemDumpFrameCount(declaredWords);
  if (frames.length !== expectedFrames) {
    throw new Error(
      `system dump: ${frames.length} frames for ${declaredWords} declared words, expected ${expectedFrames}`,
    );
  }

  const modelId = expectedModelId ?? header.modelId;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].modelId !== modelId) {
      throw new Error(`system dump: frame ${i + 1} model ${hex(frames[i].modelId)} != ${hex(modelId)}`);
    }
  }

  const chunks = frames.slice(1, -1);
  if (chunks.length !== Math.ceil(declaredWords / SYSTEM_DUMP_CHUNK_WORDS)) {
    throw new Error(`system dump: ${chunks.length} chunk frames for ${declaredWords} words`);
  }
  const words = new Uint16Array(declaredWords);
  const chunkWordCounts: number[] = [];
  let emitted = 0;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    if (chunk.func !== SYSTEM_DUMP_FUNCS.chunk) {
      throw new Error(`system dump: chunk ${index + 1} has func ${hex(chunk.func)}, expected ${hex(SYSTEM_DUMP_FUNCS.chunk)}`);
    }
    if (chunk.payload.length !== SYSTEM_DUMP_CHUNK_PAYLOAD_LEN) {
      throw new Error(
        `system dump: chunk ${index + 1} payload is ${chunk.payload.length} bytes, ` +
          `expected ${SYSTEM_DUMP_CHUNK_PAYLOAD_LEN}`,
      );
    }
    const chunkWords = decodeSeptetsLE(chunk.payload, 2, `system dump chunk ${index + 1}`);
    if (chunkWords < 1 || chunkWords > SYSTEM_DUMP_CHUNK_WORDS) {
      throw new Error(`system dump: chunk ${index + 1} declares ${chunkWords} words (maximum ${SYSTEM_DUMP_CHUNK_WORDS})`);
    }
    const expectedChunkWords = Math.min(SYSTEM_DUMP_CHUNK_WORDS, declaredWords - emitted);
    if (chunkWords !== expectedChunkWords) {
      throw new Error(
        `system dump: chunk ${index + 1} declares ${chunkWords} words, expected ${expectedChunkWords}`,
      );
    }
    for (let w = 0; w < chunkWords; w++) {
      const off = 2 + w * 3;
      words[emitted + w] =
        (chunk.payload[off] | (chunk.payload[off + 1] << 7) | (chunk.payload[off + 2] << 14)) & 0xffff;
    }
    emitted += chunkWords;
    chunkWordCounts.push(chunkWords);
  }
  if (emitted !== declaredWords) {
    throw new Error(`system dump: assembled ${emitted} words, header declares ${declaredWords}`);
  }

  if (footer.func !== SYSTEM_DUMP_FUNCS.footer) {
    throw new Error(
      `system dump: last frame is ${hex(footer.func)}, expected ${hex(SYSTEM_DUMP_FUNCS.footer)}`,
    );
  }
  if (footer.payload.length !== SYSTEM_DUMP_FOOTER_PAYLOAD_LEN) {
    throw new Error(
      `system dump: footer payload is ${footer.payload.length} bytes, expected ${SYSTEM_DUMP_FOOTER_PAYLOAD_LEN}`,
    );
  }
  const footerXor = decodeSeptetsLE(footer.payload, 3, 'system dump footer');
  let computedXor = 0;
  for (let i = 0; i < words.length; i++) computedXor ^= words[i];
  if (computedXor !== footerXor) {
    throw new Error(
      `system dump: footer XOR ${hex(footerXor)} does not match assembled ${hex(computedXor)}`,
    );
  }

  return { modelId, declaredWords, chunkWordCounts, words, footerXor };
}

/** Parse a complete system/GB/FC group from concatenated frame bytes. */
export function parseSystemDump(bytes: Uint8Array, expectedModelId?: number): ParsedSystemDump {
  const frames = splitFractalFrames(bytes, 'system dump', expectedModelId);
  return parseSystemDumpFrames(frames, expectedModelId);
}
