// Axe-Fx Standard / Ultra (gen-1) parameter READ path.
//
// The gen-1 protocol is bidirectional: the SAME function 0x02 both sets and
// queries a parameter, selected by the trailing byte — query(0) or set(1).
// Querying returns a MIDI_PARAM_VALUE response carrying the live wire value
// (0..254) and the device's own display label string ("1.234 Hz", "5.00").
//
// Query request (function 0x02, flag 0):
//
//   F0 00 01 74 01 02 [bb bb] [pp pp] [00 00] 00 F7
//                                      ^^^^^ value irrelevant for a query
//                                            ^^ query(0)/set(1) flag = 0
//
// MIDI_PARAM_VALUE response (function 0x02):
//
//   F0 00 01 74 01 02 [bb bb] [pp pp] [vv vv] <ascii label…> 00 F7
//
//   [bb bb]   effect/block id (nibble-split, low first) — echoes the request
//   [pp pp]   parameter id    (nibble-split)            — echoes the request
//   [vv vv]   live value 0..254 (nibble-split)
//   <ascii…>  the device's own label, null-terminated
//
// Source: the community-maintained gen-1 wiki "Axe-Fx System Exclusive Message
// Spec" (wiki.fractalaudio.com/gen1), saved at
// docs/manuals/AxeFx-gen1-SysEx-Spec-wiki.wikitext.txt. The SET example on that
// page matches our setParam builder byte-for-byte, so the read half is the same
// wire, just the part the narrow "Ultra System Exclusive Messages" param-set doc
// (our original source) never documented.
//
// Status: community-beta, DECODED but NOT hardware-verified (the project owns no
// gen-1 unit). Same posture as the gen-1 SET path: the bytes are byte-exact from
// the vendor-sanctioned spec, but whether the hardware answers a query is for a
// community Standard/Ultra owner to confirm. The device's returned label is
// ground truth when it does answer.

import { nibbleSplit, nibbleJoin } from './nibble.js';
import { AXE_FX_GEN1_MODEL_ID } from './setParam.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const FUNC_PARAM = 0x02; // shared by SET, query, and the PARAM_VALUE response
const FLAG_QUERY = 0x00;

/**
 * Build a gen-1 parameter QUERY (read) message. Same function 0x02 as the set
 * builder, but the value is sent as 0 (irrelevant for a query) and the trailing
 * flag is 0 (query, not set).
 *
 * @param blockId wire block id (0..255)
 * @param paramId wire param id within the block (0..255)
 * @param model   model byte (defaults to Ultra 0x01)
 */
export function buildGetParam(
  blockId: number,
  paramId: number,
  model: number = AXE_FX_GEN1_MODEL_ID,
): number[] {
  return [
    SYSEX_START,
    ...FRACTAL_MFR,
    model,
    FUNC_PARAM,
    ...nibbleSplit(blockId),
    ...nibbleSplit(paramId),
    ...nibbleSplit(0),
    FLAG_QUERY,
    SYSEX_END,
  ];
}

export interface Gen1ParamValue {
  model: number;
  blockId: number;
  paramId: number;
  /** Live wire value, 0..254. */
  value: number;
  /** The device's own display label (e.g. "1.234 Hz", "5.00"). May be empty. */
  label: string;
}

/**
 * Parse a MIDI_PARAM_VALUE response (function 0x02 with a trailing label
 * string). Returns undefined if the bytes are not a well-formed gen-1
 * param-value response.
 *
 * Disambiguated from a SET/query REQUEST (which carries a single flag byte then
 * F7) by the null-terminated ASCII label that fills the tail before F7.
 */
export function parseParamValue(bytes: readonly number[]): Gen1ParamValue | undefined {
  // Minimum: F0 + 3 mfr + model + fn + 6 id/value nibble bytes + null + F7 = 14.
  if (bytes.length < 14) return undefined;
  if (bytes[0] !== SYSEX_START || bytes[bytes.length - 1] !== SYSEX_END) return undefined;
  if (bytes[1] !== FRACTAL_MFR[0] || bytes[2] !== FRACTAL_MFR[1] || bytes[3] !== FRACTAL_MFR[2]) {
    return undefined;
  }
  if (bytes[5] !== FUNC_PARAM) return undefined;
  // Label runs from index 12 up to the null terminator that precedes F7.
  // The byte at length-2 is the null character per the spec.
  const labelBytes = bytes.slice(12, bytes.length - 2);
  // ASCII-decode, stopping at any embedded null for safety.
  let label = '';
  for (const b of labelBytes) {
    if (b === 0x00) break;
    label += String.fromCharCode(b);
  }
  return {
    model: bytes[4],
    blockId: nibbleJoin(bytes[6], bytes[7]),
    paramId: nibbleJoin(bytes[8], bytes[9]),
    value: nibbleJoin(bytes[10], bytes[11]),
    label: label.trim(),
  };
}

/**
 * Predicate for `receiveSysExMatching`: accept the gen-1 PARAM_VALUE response
 * to a query built by `buildGetParam`. Matches the Fractal envelope + function
 * 0x02, echoes the request's block id (bytes 6-7) and param id (bytes 8-9), and
 * requires a label tail so an outbound query echo can't be mistaken for the
 * response.
 */
export function isParamValueResponse(request: readonly number[], resp: readonly number[]): boolean {
  if (resp.length < 14) return false;
  if (resp[0] !== SYSEX_START || resp[resp.length - 1] !== SYSEX_END) return false;
  if (resp[1] !== FRACTAL_MFR[0] || resp[2] !== FRACTAL_MFR[1] || resp[3] !== FRACTAL_MFR[2]) {
    return false;
  }
  if (resp[5] !== FUNC_PARAM) return false;
  // Echo the queried block + param ids (request bytes 6-9).
  for (let i = 6; i <= 9; i++) {
    if (resp[i] !== request[i]) return false;
  }
  // A genuine response carries a value + label tail beyond the 14-byte query
  // shape; the outbound query itself is exactly 14 bytes ending in flag(0) F7.
  // Treat a 14-byte inbound frame as a response only if its trailing payload
  // byte (the null terminator slot) is 0x00 AND it is not byte-identical to the
  // request (guards against a loopback echo on virtual ports).
  if (resp.length === request.length) {
    let identical = true;
    for (let i = 0; i < resp.length; i++) {
      if (resp[i] !== request[i]) {
        identical = false;
        break;
      }
    }
    if (identical) return false;
  }
  return true;
}
