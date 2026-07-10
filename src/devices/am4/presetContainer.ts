/**
 * AM4 preset-dump CONTAINER decode: turn the 0x77/0x78/0x79 dump's opaque
 * chunk payloads into a CRC-validated 8,192-byte `raw_patch`, then
 * Huffman-decompress it to the preset body and extract the plaintext preset
 * name + the four scene names.
 *
 * The AM4 dump body is the gen-3 preset container verbatim, at the AM4's
 * chunk count (4 chunks × 1,024 words × 2 bytes = 8,192-byte raw_patch). The
 * low-level primitives (3-to-16 unpack, dynamic Huffman, CRC-16/CCITT, footer
 * XOR) are the SHARED gen-3 codec and are reused from
 * `../gen3/presetHuffman.js` — this module only adds the AM4-specific shape
 * (chunk count, name offset, chunk discriminator) and the body field map.
 *
 * raw_patch layout (little-endian):
 *   0x00 u16  firmware/format word: 0x0107 = fw 1.01, 0x0109 = fw 2.00
 *   0x02 u16  0xAA55 magic
 *   0x04 u16  CRC-16/CCITT poly 0x1021 init 0xAA55, over the whole raw_patch
 *             with bytes [0x04:0x06] zeroed
 *   0x08      32-byte ASCII preset name
 *   0x48 u16  decompressed body size
 *   0x4A u16  compressed body size
 *   0x4C ...  gen-3 dynamic-Huffman bitstream (zero-filled tail)
 *
 * The 0x79 footer payload is the septet-packed u16 XOR of all raw_patch LE
 * words (`computeRawPatchXor`).
 *
 * Decoded-BODY field map is PARTIAL (see `presetBody.ts` for the amp block):
 *   - Scene records @ 0x0004 + n×0x50 (n = 0..3): 32-byte ASCII scene name.
 *   - amp.gain channel A @ 0x0958 (base 0x0934 config; oracle 5.1 → 0x828E).
 *   - ONE VOLATILE u16 @ 0x140E: churns between no-op redumps; exclude from
 *     decoded-body diffs.
 * This is transport-agnostic and pure; it performs no MIDI I/O.
 */

import {
  decode3to16,
  computeRawPatchCrc,
  computeRawPatchXor,
  huffmanUncompress,
  RAW_PATCH_CRC_OFFSET,
  RAW_PATCH_DECOMP_SIZE_OFFSET,
  RAW_PATCH_COMP_SIZE_OFFSET,
  RAW_PATCH_BODY_OFFSET,
} from '../gen3/presetHuffman.js';

// ── Container shape (AM4 instantiation of the shared container) ──────

/** AM4 dumps carry 4 chunk frames (the III emits 16, FM3/FM9 emit 8). */
export const AM4_CONTAINER_CHUNK_COUNT = 4;
/** 4 chunks × 1,024 words × 2 bytes. */
export const AM4_RAW_PATCH_SIZE = 8192;
/** 32-byte ASCII preset name inside the raw_patch. */
export const AM4_RAW_PATCH_NAME_OFFSET = 0x08;
export const AM4_RAW_PATCH_NAME_LENGTH = 32;
/** Constant 2-byte chunk discriminator observed on every AM4 chunk. */
export const AM4_CHUNK_DISCRIMINATOR: readonly [number, number] = [0x00, 0x08];

/** raw_patch word 0 — firmware/format version word. */
export const AM4_FW_WORD_1P01 = 0x0107;
export const AM4_FW_WORD_2P00 = 0x0109;
/** raw_patch word 1 — container magic. */
export const AM4_RAW_PATCH_MAGIC = 0xaa55;

// ── Decoded-body field map (PARTIAL — see module doc + presetBody.ts) ─

export const AM4_SCENE_COUNT = 4;
/** First scene record's name field, in the DECOMPRESSED body. */
export const AM4_BODY_SCENE_NAME_OFFSET = 0x0004;
/** Stride between consecutive scene records. */
export const AM4_BODY_SCENE_RECORD_STRIDE = 0x50;
/** 32-byte ASCII, space-padded, NUL at index 31. */
export const AM4_BODY_SCENE_NAME_LENGTH = 32;
/** amp.gain channel A as LE u16 (0..65534) — pinned by warm-pair oracle. */
export const AM4_BODY_AMP_GAIN_CHA_OFFSET = 0x0958;
/** The one u16 that churns between no-op redumps; exclude from diffs. */
export const AM4_BODY_VOLATILE_WORD_OFFSET = 0x140e;

function u16le(buf: Uint8Array, off: number): number {
  return ((buf[off] ?? 0) | ((buf[off + 1] ?? 0) << 8)) & 0xffff;
}

/** Read a 32-byte ASCII name field: stop at NUL, strip trailing spaces. */
export function readAm4NameField(buf: Uint8Array, offset: number, length: number): string {
  let name = '';
  for (let i = offset; i < offset + length && i < buf.length; i++) {
    const c = buf[i];
    if (c === 0) break;
    name += String.fromCharCode(c);
  }
  return name.replace(/\s+$/, '');
}

/** The container-decoded form of one AM4 preset dump. */
export interface Am4ContainerDecode {
  /** The 8,192-byte unpacked LE raw_patch image. */
  readonly rawPatch: Uint8Array;
  /** 32-char ASCII preset name from raw_patch offset 0x08. */
  readonly name: string;
  /** raw_patch word 0: 0x0107 = fw 1.01, 0x0109 = fw 2.00. */
  readonly fwWord: number;
  /** word 1 === 0xAA55. */
  readonly magicValid: boolean;
  readonly storedCrc: number;
  readonly computedCrc: number;
  readonly crcValid: boolean;
  /** u16 from the 0x79 footer (septet-unpacked). */
  readonly storedFooterXor: number;
  readonly computedFooterXor: number;
  readonly footerXorValid: boolean;
  readonly decompSize: number;
  readonly compSize: number;
  /** True when the Huffman stream produced exactly decompSize bytes. */
  readonly huffmanComplete: boolean;
  /** The decompressed preset body (decompSize bytes). Field map is PARTIAL. */
  readonly decompressedBody: Uint8Array;
  /** The four 32-char scene names from the decoded body (may be empty). */
  readonly sceneNames: readonly [string, string, string, string];
}

/**
 * Decode the container layer from a parsed dump's chunk + footer payloads.
 *
 * `chunkPayloads` are the 3,074-byte chunk payloads (each = 2-byte
 * discriminator + 3,072 packed bytes); `footerPayload` is the 3-byte 0x79
 * footer payload. Reuses the shared gen-3 primitives to unpack, verify, and
 * decompress; CRC / footer-XOR / Huffman-termination are REPORTED via flags
 * (not thrown) so a caller can surface a corrupt dump usefully.
 *
 * Throws only on a raw_patch size other than 8,192 B (wrong chunk count).
 */
export function decodeAm4Container(
  chunkPayloads: readonly Uint8Array[],
  footerPayload: Uint8Array,
): Am4ContainerDecode {
  // Strip the 2-byte discriminator from each chunk, concatenate, 3-to-16 unpack.
  let total = 0;
  for (const c of chunkPayloads) total += c.length - 2;
  const packed = new Uint8Array(total);
  let off = 0;
  for (const c of chunkPayloads) {
    packed.set(c.subarray(2), off);
    off += c.length - 2;
  }
  const rawPatch = decode3to16(packed);
  if (rawPatch.length !== AM4_RAW_PATCH_SIZE) {
    throw new Error(
      `decodeAm4Container: expected an ${AM4_RAW_PATCH_SIZE}-byte raw_patch ` +
        `(${AM4_CONTAINER_CHUNK_COUNT} chunks), got ${rawPatch.length} bytes ` +
        `from ${chunkPayloads.length} chunks`,
    );
  }

  const storedCrc = u16le(rawPatch, RAW_PATCH_CRC_OFFSET);
  const computedCrc = computeRawPatchCrc(rawPatch);
  const decompSize = u16le(rawPatch, RAW_PATCH_DECOMP_SIZE_OFFSET);
  const compSize = u16le(rawPatch, RAW_PATCH_COMP_SIZE_OFFSET);
  const decompressedBody = huffmanUncompress(
    rawPatch.subarray(RAW_PATCH_BODY_OFFSET, RAW_PATCH_BODY_OFFSET + compSize),
    decompSize,
  );

  const fp = footerPayload;
  const storedFooterXor = ((fp[0] ?? 0) | ((fp[1] ?? 0) << 7) | ((fp[2] ?? 0) << 14)) & 0xffff;
  const computedFooterXor = computeRawPatchXor(rawPatch);

  const sceneNames = [0, 1, 2, 3].map((n) =>
    readAm4NameField(
      decompressedBody,
      AM4_BODY_SCENE_NAME_OFFSET + n * AM4_BODY_SCENE_RECORD_STRIDE,
      AM4_BODY_SCENE_NAME_LENGTH,
    ),
  ) as [string, string, string, string];

  return {
    rawPatch,
    name: readAm4NameField(rawPatch, AM4_RAW_PATCH_NAME_OFFSET, AM4_RAW_PATCH_NAME_LENGTH),
    fwWord: u16le(rawPatch, 0x00),
    magicValid: u16le(rawPatch, 0x02) === AM4_RAW_PATCH_MAGIC,
    storedCrc,
    computedCrc,
    crcValid: storedCrc === computedCrc,
    storedFooterXor,
    computedFooterXor,
    footerXorValid: storedFooterXor === computedFooterXor,
    decompSize,
    compSize,
    huffmanComplete: decompressedBody.length === decompSize,
    decompressedBody,
    sceneNames,
  };
}
