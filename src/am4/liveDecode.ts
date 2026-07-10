/**
 * AM4 live-poll value decode.
 *
 * AM4-Edit drives its meters / tuner by polling ordinary `fn 0x01 PARAM_RW`
 * addresses (BigCapture 2026-07-05; see docs/AM4-CAPTURE-2026-07-05.md and
 * docs/AM4-LIVE-VALUE-DECODE-PLAN.md). A poll response is byte-shape-identical
 * to a short read — 23 bytes, `hdr4=0x0004`, a `float32` LE payload in `[0,1]`.
 *
 * This module turns such a response into a display value **when the polled
 * address is a known catalog param** (e.g. `compressor.gain_monitor` →
 * `9.25`), and otherwise annotates it with its `AM4_LIVE_POLL_CANDIDATES`
 * label. It is deliberately conservative: an address that is neither a
 * catalog param nor a correlated candidate returns `unknown: true` with the
 * raw float only — no invented scaling.
 *
 * Pure code — no MIDI transport. Browser-safe.
 */

import { KNOWN_PARAMS, decode, formatDisplay, type Param, type ParamKey, type Unit } from './params.js';
import { parseReadResponse, type ReadResponse } from './setParam.js';
import { am4LivePollCandidateFor, type Am4LivePollCandidate } from './livePolls.js';
import { isRawIntRegister, decodeRawIntRegister } from './midiRegisters.js';

/** Reverse index: `"<pidLow>,<pidHigh>"` → catalog param key. Built once. */
const PARAM_BY_PID: Map<string, ParamKey> = (() => {
  const m = new Map<string, ParamKey>();
  for (const key of Object.keys(KNOWN_PARAMS) as ParamKey[]) {
    const p = KNOWN_PARAMS[key] as Param;
    const pidKey = `${p.pidLow},${p.pidHigh}`;
    // First writer wins — the hand-keyed registry is authoritative and its
    // (pidLow,pidHigh) pairs are unique per addressable param. If a later
    // alias duplicates an address, keep the earlier canonical key.
    if (!m.has(pidKey)) m.set(pidKey, key);
  }
  return m;
})();

/** Look up the catalog param addressed by `(pidLow, pidHigh)`, if any. */
export function am4ParamKeyForPid(pidLow: number, pidHigh: number): ParamKey | undefined {
  return PARAM_BY_PID.get(`${pidLow},${pidHigh}`);
}

export interface Am4LiveDecodeResult {
  pidLow: number;
  pidHigh: number;
  /** Which read-like action produced this value (0x0E / 0x10 / 0x26). */
  action: number;
  /** The raw wire value as a little-endian `float32` (normalized `[0,1]`). */
  rawFloat: number;
  /** The raw wire value as a little-endian `uint32` (for enum/type registers). */
  rawUInt32: number;
  /** Catalog param key when the polled address is known. */
  paramKey?: ParamKey;
  /** Param display unit when a catalog param matched. */
  unit?: Unit;
  /** Decoded display value when a catalog param matched. */
  display?: number;
  /** Formatted display string (value + no suffix) when a catalog param matched. */
  formatted?: string;
  /** Live-poll candidate metadata when the address is in the candidate table. */
  candidate?: Am4LivePollCandidate;
  /**
   * True when neither a catalog param NOR a correlated candidate matched the
   * address — the value is returned raw with no scaling claim.
   */
  unknown: boolean;
}

/**
 * Decode a live-poll value for `(pidLow, pidHigh)` given its raw wire float
 * (`ReadResponse.asFloat32()`). Applies the catalog param's scaling when the
 * address is known; otherwise falls back to the candidate label / raw value.
 *
 * `action` defaults to the live-poll action (0x0010) for callers that only
 * have the address + value; pass the real action through when parsing a
 * response so the result records which poll variant it answered.
 */
export function decodeAm4LiveValue(
  pidLow: number,
  pidHigh: number,
  rawFloat: number,
  rawUInt32 = 0,
  action = 0x0010,
): Am4LiveDecodeResult {
  const paramKey = am4ParamKeyForPid(pidLow, pidHigh);
  const candidate = am4LivePollCandidateFor(pidLow, pidHigh);
  const base: Am4LiveDecodeResult = {
    pidLow,
    pidHigh,
    action,
    rawFloat,
    rawUInt32,
    candidate,
    unknown: paramKey === undefined && candidate === undefined,
  };
  if (paramKey === undefined) return base;

  const param = KNOWN_PARAMS[paramKey] as Param;
  if (param.unit === 'enum') {
    // Enum/type registers store an integer index, not a normalized float.
    const idx = rawUInt32;
    return {
      ...base,
      paramKey,
      unit: param.unit,
      display: idx,
      formatted: param.enumValues?.[idx] ?? String(idx),
    };
  }
  if (isRawIntRegister(param)) {
    // Raw-integer registers (global MIDI-config map + per-scene MIDI transmit
    // slots): the read u32 IS the display integer, NOT a Q16-scaled float.
    // Decode from the u32 directly and never touch the float path (BUG-6).
    const value = decodeRawIntRegister(param, rawUInt32);
    return {
      ...base,
      paramKey,
      unit: param.unit,
      display: typeof value === 'number' ? value : rawUInt32,
      formatted: String(value),
    };
  }
  const display = decode(param, rawFloat);
  return {
    ...base,
    paramKey,
    unit: param.unit,
    display,
    formatted: formatDisplay(param, display),
  };
}

/**
 * Convenience: decode a full 23-byte poll/read response (any of the
 * `POLL_READ_ACTIONS`) straight into an `Am4LiveDecodeResult`. Validates and
 * parses via `parseReadResponse`, then applies `decodeAm4LiveValue`.
 */
export function decodeAm4PollResponse(bytes: number[]): Am4LiveDecodeResult {
  const resp: ReadResponse = parseReadResponse(bytes);
  return decodeAm4LiveValue(resp.pidLow, resp.pidHigh, resp.asFloat32(), resp.asUInt32LE(), resp.action);
}
