/**
 * XTEA decryption for the cab-IR record bodies (32 cycles, delta `0x9E3779B9`,
 * a rotating four-lane key whose schedule advances per 8-byte pair).
 *
 * The key is a caller-supplied parameter. No key material, seed or derived lane
 * is embedded here, printed, or included in an error message.
 *
 * Pure code: `Uint8Array`/`DataView` only, browser-safe.
 */

export const XTEA_DELTA = 0x9e3779b9;
export const XTEA_CYCLES = 32;

export interface XteaRecordKey {
  /** Four 32-bit lanes as supplied by the caller. Never stored by this module. */
  readonly seed: readonly [number, number, number, number];
  /** Per-pair lane advance; defaults to `[1, 1, 1, 1]`. */
  readonly increment?: readonly [number, number, number, number];
}

export interface XteaDecryptOptions {
  /** Number of 8-byte pairs to transform. */
  pairCount: number;
  /** Byte offset of the first pair; bytes outside the range are copied as-is. */
  offset?: number;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function readLaneTuple(value: unknown, what: string): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) throw new Error(`${what} must have four 32-bit lanes`);
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const lane = value[i];
    if (typeof lane !== 'number' || !Number.isInteger(lane) || lane < 0 || lane > 0xffffffff) {
      throw new Error(`${what} lane ${i} is not a uint32`);
    }
    out[i] = lane >>> 0;
  }
  return out;
}

/** Validate a key object without echoing any of its values. */
function resolveKey(key: XteaRecordKey): {
  seed: [number, number, number, number];
  increment: [number, number, number, number];
} {
  if (key === null || typeof key !== 'object') throw new Error('XTEA key is required');
  const seed = readLaneTuple(key.seed, 'XTEA key seed');
  const increment = key.increment === undefined
    ? ([1, 1, 1, 1] as [number, number, number, number])
    : readLaneTuple(key.increment, 'XTEA key increment');
  return { seed, increment };
}

/**
 * Decrypt `pairCount` XTEA pairs starting at `offset`, advancing the four key
 * lanes by `increment` before each pair. Returns a copy; the input is untouched.
 */
export function decryptXteaPairs(
  bytes: Uint8Array,
  key: XteaRecordKey,
  options: XteaDecryptOptions,
): Uint8Array {
  const { seed, increment } = resolveKey(key);
  const pairCount = options.pairCount;
  if (!Number.isInteger(pairCount) || pairCount < 0 || pairCount > 1 << 20) {
    throw new Error(`XTEA pair count ${pairCount} is out of range`);
  }
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`XTEA offset ${offset} is out of range`);
  if (offset + pairCount * 8 > bytes.length) {
    throw new Error(`XTEA range ${offset}+${pairCount * 8} exceeds ${bytes.length} bytes`);
  }

  const out = bytes.slice();
  const lanes: [number, number, number, number] = [0, 0, 0, 0];
  for (let pair = 0; pair < pairCount; pair++) {
    for (let lane = 0; lane < 4; lane++) {
      lanes[lane] = (seed[lane] + Math.imul(pair, increment[lane])) >>> 0;
    }
    const base = offset + pair * 8;
    let v0 = readU32(out, base);
    let v1 = readU32(out, base + 4);
    let sum = Math.imul(XTEA_CYCLES, XTEA_DELTA) >>> 0;
    for (let cycle = 0; cycle < XTEA_CYCLES; cycle++) {
      v1 = (v1 - (((((v0 << 4) ^ (v0 >>> 5)) + v0) >>> 0) ^ ((sum + lanes[(sum >>> 11) & 3]) >>> 0))) >>> 0;
      sum = (sum - XTEA_DELTA) >>> 0;
      v0 = (v0 - (((((v1 << 4) ^ (v1 >>> 5)) + v1) >>> 0) ^ ((sum + lanes[sum & 3]) >>> 0))) >>> 0;
    }
    writeU32(out, base, v0);
    writeU32(out, base + 4, v1);
  }
  return out;
}
