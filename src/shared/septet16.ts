/**
 * Shared Fractal LSB-first septet integer codecs.
 *
 * Two primitives used identically across the Fractal family codecs:
 *
 *   - `encode14` / `decode14` — a 14-bit unsigned int as a 2-byte
 *     septet pair, low 7 bits first. Effect IDs, param IDs, preset
 *     numbers, and BPMs across the family use this (AM4, gen-2,
 *     gen-3, VP4).
 *   - `packValue16` / `unpackValue16` — a 16-bit unsigned int across
 *     three 7-bit septets (bits 6..0, 13..7, 15..14). The gen-2 and
 *     gen-3 codecs use this for parameter values; each codec's
 *     re-export site documents its own observed value-range note.
 *
 * NOT the AM4 chunked 8-to-7 sliding-window scheme — that is
 * `packValueChunked` in `shared/packValue.ts`, a different encoding.
 *
 * NOTE: a few gen-2 builders (`buildSwitchPreset`, `buildStorePreset`,
 * `buildPatchDumpRequest`) use **MSB-first** 14-bit byte order on the
 * wire — those stay inline in the gen-2 codec; do not swap them to
 * `encode14`.
 *
 * Byte-exact goldens live in the gen-2 and gen-3 codec test suites
 * (`test/gen2/axe-fx-ii/setparam.test.ts`,
 * `test/gen3/axe-fx-iii/setparam.test.ts`) and
 * `scripts/verify-axe-fx-ii-encoding.ts`.
 */

/**
 * Encode a 14-bit value as a 2-byte septet pair (low 7 bits, then high
 * 7 bits — little-endian). Throws on non-integer or out-of-range input.
 */
export function encode14(n: number): [number, number] {
  if (!Number.isInteger(n) || n < 0 || n > 0x3fff) {
    throw new Error(`encode14: ${n} out of range (0..16383)`);
  }
  return [n & 0x7f, (n >> 7) & 0x7f];
}

/** Decode a 2-byte septet pair (low 7 bits then high 7 bits) into a 14-bit integer. */
export function decode14(lo: number, hi: number): number {
  return (lo & 0x7f) | ((hi & 0x7f) << 7);
}

/**
 * Pack a 16-bit unsigned value into the wire's three 7-bit septets.
 *
 *   septet 0 = bits 6..0   (lowest seven bits)
 *   septet 1 = bits 13..7  (next seven bits)
 *   septet 2 = bits 15..14 (top two bits, zero-padded into a 7-bit byte)
 *
 * Accepts the full 16-bit range 0..65535; see each codec's re-export
 * site for its device-specific value-range note.
 */
export function packValue16(value: number): [number, number, number] {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`packValue16 input out of range: ${value}`);
  }
  return [
    value & 0x7f,
    (value >> 7) & 0x7f,
    (value >> 14) & 0x03,
  ];
}

/** Inverse of `packValue16`. Inputs may have unused upper bits — masked. */
export function unpackValue16(b0: number, b1: number, b2: number): number {
  return ((b0 & 0x7f)) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
}
