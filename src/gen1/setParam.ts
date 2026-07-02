// Axe-Fx Standard / Ultra (gen-1) parameter-set message builder.
//
// Envelope (function 0x02, "set parameter value"):
//
//   F0 00 01 74 01 02 [bb bb] [pp pp] [vv vv] 01 F7
//
//   01            model byte (Ultra)
//   02            function = set OR query parameter value
//   [bb bb]       block id   (nibble-split, low nibble first)
//   [pp pp]       param id   (nibble-split)
//   [vv vv]       value      (nibble-split)
//   01            query(0)/set(1) flag. The builder emits 1 (set). This is NOT
//                 a checksum (the XOR of the payload is 0x02, not 0x01). For the
//                 query(0) form and the MIDI_PARAM_VALUE response, see
//                 readParam.ts. (Earlier this byte was read as a "fixed trailer"
//                 because the narrow param-set source doc only ever showed set
//                 messages, where it is always 1; the fuller gen-1 wiki spec
//                 documents it as the set/query selector.)
//
// Worked example (doc): set Compressor 2 (block 101) Knee (param 5) to SOFTER
// (value 2) -> F0 00 01 74 01 02 05 06 05 00 02 00 01 F7.
//
// Status: community-beta. Wire decoded byte-exactly from the published Ultra
// SysEx doc; NOT confirmed on gen-1 hardware (the project owns none). Callers
// must surface a beta warning and ask the user to confirm on the front panel.

import { nibbleSplit } from './nibble.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const FUNC_PARAM_SET = 0x02;
/** Trailing query(0)/set(1) flag before F7. The set builder emits 1 (set). */
const TRAILER = 0x01;

/** Model byte for the Axe-Fx Ultra (and the Standard, pending confirmation). */
export const AXE_FX_GEN1_MODEL_ID = 0x01;

/**
 * Build a gen-1 set-parameter SysEx message.
 *
 * @param blockId  wire block id (0..255), e.g. 106 for Amp 1
 * @param paramId  wire param id within the block (0..255)
 * @param wireValue raw wire value (0..254). Display-to-wire conversion happens
 *                  at the tool boundary; this builder takes wire.
 * @param model    model byte (defaults to Ultra 0x01)
 */
export function buildSetParam(
  blockId: number,
  paramId: number,
  wireValue: number,
  model: number = AXE_FX_GEN1_MODEL_ID,
): number[] {
  return [
    SYSEX_START,
    ...FRACTAL_MFR,
    model,
    FUNC_PARAM_SET,
    ...nibbleSplit(blockId),
    ...nibbleSplit(paramId),
    ...nibbleSplit(wireValue),
    TRAILER,
    SYSEX_END,
  ];
}

/**
 * Parse a gen-1 set-parameter message back to its fields (round-trip / test
 * helper). Returns undefined if the bytes are not a well-formed gen-1 set.
 */
export function parseSetParam(
  bytes: readonly number[],
): { model: number; blockId: number; paramId: number; value: number } | undefined {
  if (bytes.length !== 14) return undefined;
  if (bytes[0] !== SYSEX_START || bytes[13] !== SYSEX_END) return undefined;
  if (bytes[1] !== FRACTAL_MFR[0] || bytes[2] !== FRACTAL_MFR[1] || bytes[3] !== FRACTAL_MFR[2]) return undefined;
  if (bytes[5] !== FUNC_PARAM_SET || bytes[12] !== TRAILER) return undefined;
  return {
    model: bytes[4],
    blockId: (bytes[7] << 4) | bytes[6],
    paramId: (bytes[9] << 4) | bytes[8],
    value: (bytes[11] << 4) | bytes[10],
  };
}
