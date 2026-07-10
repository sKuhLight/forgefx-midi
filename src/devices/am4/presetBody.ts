/**
 * AM4 decoded-BODY block-record chain walker + AMP param-value decode.
 *
 * The AM4 preset body (`decodeAm4Container(...).decompressedBody`) is a
 * WALKABLE variable-length BLOCK-RECORD CHAIN, not a fixed offset table (an
 * amp type-swap shrinks the body — downstream offsets shift when a block's
 * type changes, so a fixed table cannot describe it).
 *
 * ── Structure (AMP block, byte-exact) ────────────────────────────────
 *   marker  u16 == the block's pidLow (amp = BLOCK_TYPE_VALUES.amp = 0x003a)
 *           followed by a 0x0E-byte record header, then 4 per-channel records
 *           A/B/C/D at `AM4_BODY_CHANNEL_STRIDE` (0x130 bytes) each.
 *
 *   Within a channel record, a param's word lives at
 *     off = ampMarker + channel*0x130 + 0x0E + pidHigh*2
 *   (the "pidHigh + 7 words" rule; 0x0E header bytes = 7 words).
 *
 * CONFIRMED anchors (byte-exact, warm-pair oracle):
 *   - amp.type   chA pidHigh 0x0A  off 0x22  (ordinal -> AMP_TYPES roster)
 *   - amp.gain   chA pidHigh 0x0B  off 0x24  (0x828E = round(5.1/10*65534))
 *   - amp.gain   chB pidHigh 0x0B  off 0x154 (pins the 0x130 channel stride)
 *   - amp.master chA pidHigh 0x0F  off 0x2C  (0x828E = 5.1)
 * The remaining registered amp knobs ride the SAME confirmed record geometry
 * and are decoded through the shipped param scaling.
 *
 * ── Config-dependent base (MUST be walked, never hardcoded) ──────────
 * The amp marker sits at body offset 0x0934 in most factory presets and
 * 0x0A92 in some (an extra pre-amp record enlarges the modifier region by
 * 0x15E), and is ABSENT in empty presets. `locateAm4AmpBlock` scans +
 * validates the record shape, so it finds the marker in every config.
 *
 * ── Scope: AMP block ONLY ────────────────────────────────────────────
 * Only the amp block has a validated record shape + an ordinal-bounded TYPE
 * enum to reject false-positive markers; cab / FX blocks are intentionally
 * NOT decoded here (their per-block stride / formula is UNVERIFIED).
 *
 * Pure; performs no MIDI I/O.
 */

import {
  KNOWN_PARAMS,
  decode as am4Decode,
  roundDisplayValue,
  type Param,
} from '../../am4/params.js';
import { AMP_TYPES } from '../../am4/cacheEnums.js';
import { BLOCK_TYPE_VALUES } from '../../am4/blockTypes.js';

/** amp effectId marker (== amp pidLow) in the decoded body. */
const AMP_MARKER = BLOCK_TYPE_VALUES.amp; // 0x003a
/**
 * Amp TYPE ordinal bound — a valid marker's 4 channel types are all < this.
 *
 * Bound to OUR roster length (250), NOT the upstream hardcoded 248: our
 * AMP_TYPES has two extra entries, and a hardcoded 248 would reject presets
 * whose amp type is ordinal 248/249.
 */
const AMP_TYPE_ORDINAL_COUNT = AMP_TYPES.length; // 250

/** Per-channel record stride (A -> B -> C -> D), in BYTES. */
export const AM4_BODY_CHANNEL_STRIDE = 0x130;
/** Record-header size between the effectId marker and the pidHigh-0 param word, in BYTES. */
export const AM4_BODY_BLOCK_HEADER_BYTES = 0x0e;
/** Number of per-channel records in an amp block (A/B/C/D). */
export const AM4_BODY_AMP_CHANNEL_COUNT = 4;

const CHANNEL_LETTERS = ['A', 'B', 'C', 'D'] as const;

/** amp.type pidHigh — used to read the raw ordinal for `type_id`. */
const AMP_TYPE_PID_HIGH = 0x0a;

/** Body-scan lower bound: the amp block always follows the scene + modifier
 *  region. Scanning from here skips the preset/scene header. */
export const AMP_SCAN_START = 0x0200;
/** Body-scan upper bound: the amp block base has never exceeded ~0x0B00. */
export const AMP_SCAN_END = 0x1400;

function u16le(body: Uint8Array, off: number): number {
  return ((body[off] ?? 0) | ((body[off + 1] ?? 0) << 8)) & 0xffff;
}

/**
 * Locate the AMP block's marker offset in a decoded preset body, or return
 * `undefined` when the preset has no amp.
 *
 * Validation (rejects value-collision false positives):
 *   1. `u16 == AMP_MARKER` (0x003a).
 *   2. Record-header words 1..4 (offsets +2,+4,+6,+8) are all zero.
 *   3. All four channel TYPE ordinals (base + ch*stride + 0x22) are a valid
 *      AMP_TYPES index (< AMP_TYPE_ORDINAL_COUNT).
 *   4. The full 4-channel span fits inside the decompressed body.
 */
export function locateAm4AmpBlock(body: Uint8Array, decompSize?: number): number | undefined {
  const limit = Math.min(decompSize ?? body.length, body.length);
  const lastChannelBase = (AM4_BODY_AMP_CHANNEL_COUNT - 1) * AM4_BODY_CHANNEL_STRIDE;
  const typeOff = AM4_BODY_BLOCK_HEADER_BYTES + AMP_TYPE_PID_HIGH * 2; // 0x22
  const scanEnd = Math.min(AMP_SCAN_END, limit);
  for (let o = AMP_SCAN_START; o + lastChannelBase + typeOff + 1 < limit && o < scanEnd; o += 2) {
    if (u16le(body, o) !== AMP_MARKER) continue;
    if (
      u16le(body, o + 2) !== 0 ||
      u16le(body, o + 4) !== 0 ||
      u16le(body, o + 6) !== 0 ||
      u16le(body, o + 8) !== 0
    )
      continue;
    let ok = true;
    for (let ch = 0; ch < AM4_BODY_AMP_CHANNEL_COUNT; ch++) {
      if (u16le(body, o + ch * AM4_BODY_CHANNEL_STRIDE + typeOff) >= AMP_TYPE_ORDINAL_COUNT) {
        ok = false;
        break;
      }
    }
    if (ok) return o;
  }
  return undefined;
}

/**
 * Decode one stored amp-record chunk word to its display value. Mirrors the
 * shipped per-paramId decode:
 *   - enum: `enumValues[wire]`, falling back to the raw ordinal.
 *   - non-enum: internal = wire / 65534, then the shipped `am4Decode` applies
 *     the per-unit scale.
 */
function decodeAmpChunkValue(param: Param, wire: number): number | string {
  if (param.unit === 'enum') {
    const enumValues = param.enumValues as Record<number, string> | undefined;
    return enumValues?.[wire] ?? wire;
  }
  const internal = wire / 65534;
  return roundDisplayValue(param, am4Decode(param, internal));
}

/** Per-channel amp knob maps: `{ A: { type, gain, ... }, B: {...}, ... }`. */
export interface Am4AmpBlockValues {
  /** Body offset of the amp effectId marker (config-dependent; walked). */
  readonly base: number;
  /** Channel letter -> (param name -> display value). */
  readonly channels: Record<string, Record<string, number | string>>;
}

/**
 * Locate + decode the AMP block from a decoded preset body. Returns
 * `undefined` when the preset has no amp block (the marker doesn't validate).
 *
 * Surfaces every REGISTERED amp param (`block === 'amp'`, `pidLow === 0x003a`)
 * whose word fits inside the channel record, for all four channels A/B/C/D,
 * decoded to display units through the shipped param scaling. Each channel
 * also carries `type_id` (the raw amp-model ordinal). Params that overflow
 * the channel stride are skipped rather than misattributed.
 */
export function decodeAm4AmpBlock(body: Uint8Array, decompSize?: number): Am4AmpBlockValues | undefined {
  const base = locateAm4AmpBlock(body, decompSize);
  if (base === undefined) return undefined;
  const limit = Math.min(decompSize ?? body.length, body.length);

  const ampParams = Object.values(KNOWN_PARAMS)
    .map((p) => p as Param)
    .filter((p) => p.block === 'amp' && p.pidLow === AMP_MARKER);

  const channels: Record<string, Record<string, number | string>> = {};
  for (let ch = 0; ch < AM4_BODY_AMP_CHANNEL_COUNT; ch++) {
    const chBase = base + ch * AM4_BODY_CHANNEL_STRIDE;
    const chOut: Record<string, number | string> = {};

    // type_id: the raw amp-model ordinal.
    const typeOff = chBase + AM4_BODY_BLOCK_HEADER_BYTES + AMP_TYPE_PID_HIGH * 2;
    if (typeOff + 1 < limit) chOut.type_id = u16le(body, typeOff);

    for (const p of ampParams) {
      const rel = AM4_BODY_BLOCK_HEADER_BYTES + p.pidHigh * 2;
      if (rel >= AM4_BODY_CHANNEL_STRIDE) continue; // would overflow into the next channel
      const offAbs = chBase + rel;
      if (offAbs + 1 >= limit) continue;
      chOut[p.name] = decodeAmpChunkValue(p, u16le(body, offAbs));
    }
    channels[CHANNEL_LETTERS[ch]] = chOut;
  }
  return { base, channels };
}
