/**
 * AM4 per-block visual data: the 32-value curve read.
 *
 * AM4 block graphs do not use the gen-3 `sub 0x23` channel. They are read with
 * the ordinary `fn 0x01` message on `action 0x0D` (the long/read action) and a
 * per-slot pseudo-register:
 *
 *   pidHigh = 0x7DE + slot,  slot 0..3, no request payload
 *   reply    = 128-byte payload = 32 little-endian float32 values
 *
 * The register window `0x7D2..0x7EC` is reserved: a `pidHigh` inside it is
 * never a parameter index. The reply uses the standard AM4 header (pidLow,
 * pidHigh, action, reserved, declared payload byte count at bytes 14–15) and
 * chunked 7→8 packing from byte 16, so the payload is unpacked with the
 * declared count, not a hardcoded length.
 *
 * What the 32 values mean per block is NOT modelled here. The editor applies a
 * block-specific display transform before drawing them (at least one block
 * family converts dB↔linear), and that transform was not recovered.
 */

import {
  AM4_MODEL_ID,
  READ_TYPE_LONG,
  buildReadParam,
} from './setParam.js';
import { fractalChecksum } from '../shared/checksum.js';
import { unpackValueChunked } from '../shared/packValue.js';

/** First curve pseudo-register; slot `n` is `AM4_CURVE_PID_HIGH_BASE + n`. */
export const AM4_CURVE_PID_HIGH_BASE = 0x07de;
/** Curve slots a block can expose (0..3). */
export const AM4_CURVE_SLOTS = 4;
/** Float32 values in one curve reply. */
export const AM4_CURVE_FLOAT_COUNT = 32;
/** Raw payload bytes in one curve reply (32 × 4). */
export const AM4_CURVE_PAYLOAD_BYTES = AM4_CURVE_FLOAT_COUNT * 4;

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const FUNC_PARAM_RW = 0x01;
/** Header bytes before the payload: F0 + mfr + model + fn + five 14-bit fields. */
const REPLY_HEADER_LEN = 16;

/** Declared-count → packed wire length, chunked 7 raw bytes → 8 septets. */
function packedLength(rawLen: number): number {
  const chunks = Math.floor(rawLen / 7);
  const remainder = rawLen % 7;
  return chunks * 8 + (remainder > 0 ? remainder + 1 : 0);
}

/**
 * Build the curve read for one slot of `blockPidLow` (the block's catalog
 * `pidLow`). Read-only: `action 0x0D` with no payload.
 */
export function buildAm4CurvePoll(blockPidLow: number, slot: number): number[] {
  if (!Number.isInteger(slot) || slot < 0 || slot >= AM4_CURVE_SLOTS) {
    throw new Error(`AM4 curve slot must be 0..${AM4_CURVE_SLOTS - 1}, got ${slot}.`);
  }
  if (!Number.isInteger(blockPidLow) || blockPidLow < 0 || blockPidLow > 0x3fff) {
    throw new Error(`AM4 block pidLow must be 0..16383, got ${blockPidLow}.`);
  }
  return buildReadParam(
    { pidLow: blockPidLow, pidHigh: AM4_CURVE_PID_HIGH_BASE + slot },
    READ_TYPE_LONG,
  );
}

/**
 * True for a well-formed AM4 curve reply for `(blockPidLow, slot)`: envelope,
 * model, function, echoed register pair and action, declared 128-byte payload,
 * and a valid checksum. Never throws.
 */
export function isAm4CurveResponse(
  bytes: readonly number[],
  blockPidLow: number,
  slot: number,
): boolean {
  if (bytes.length < REPLY_HEADER_LEN + 2) return false;
  if (bytes[0] !== SYSEX_START || bytes[bytes.length - 1] !== SYSEX_END) return false;
  if (bytes[1] !== FRACTAL_MFR[0] || bytes[2] !== FRACTAL_MFR[1] || bytes[3] !== FRACTAL_MFR[2]) return false;
  if (bytes[4] !== AM4_MODEL_ID || bytes[5] !== FUNC_PARAM_RW) return false;
  const pidLow = (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 7);
  const pidHigh = (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 7);
  const action = (bytes[10] ?? 0) | ((bytes[11] ?? 0) << 7);
  const hdr4 = (bytes[14] ?? 0) | ((bytes[15] ?? 0) << 7);
  if (pidLow !== blockPidLow || pidHigh !== AM4_CURVE_PID_HIGH_BASE + slot) return false;
  if (action !== READ_TYPE_LONG) return false;
  if (hdr4 !== AM4_CURVE_PAYLOAD_BYTES) return false;
  if (bytes.length !== REPLY_HEADER_LEN + packedLength(hdr4) + 2) return false;
  return fractalChecksum(bytes.slice(0, -2)) === bytes[bytes.length - 2];
}

/**
 * Decode an AM4 curve reply → 32 little-endian float32 values, in wire order.
 * Throws when the frame is not the expected 128-byte-payload reply.
 */
export function parseAm4CurveResponse(
  bytes: readonly number[],
  blockPidLow: number,
  slot: number,
): number[] {
  if (!isAm4CurveResponse(bytes, blockPidLow, slot)) {
    throw new Error(
      `AM4 curve reply rejected for pidLow ${blockPidLow} slot ${slot}.`,
    );
  }
  const wire = Uint8Array.from(bytes.slice(REPLY_HEADER_LEN, bytes.length - 2));
  const raw = unpackValueChunked(wire, AM4_CURVE_PAYLOAD_BYTES);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: number[] = [];
  for (let i = 0; i < AM4_CURVE_FLOAT_COUNT; i++) out.push(view.getFloat32(i * 4, true));
  return out;
}
