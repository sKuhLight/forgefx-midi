// AM4 raw-integer MIDI-config register class (BUG-6 / GAP-2).
//
// The global MIDI map + per-scene MIDI transmit slots read back the literal
// display integer, NOT a Q16-scaled float; _cc CC-assignment registers use
// 128 = the "None"/unassigned sentinel. This suite pins the classification,
// the decode (integer + None), and the write path (numeric + None → 128).

import {
  KNOWN_PARAMS,
  isRawIntRegister,
  rawIntRegisterHasNone,
  decodeRawIntRegister,
  encodeRawIntRegister,
  buildSetParam,
  buildSetRawIntRegister,
  type Param,
} from '../../src/am4/index.js';
import { decodeAm4LiveValue } from '../../src/am4/liveDecode.js';

const P = (key: string): Param => KNOWN_PARAMS[key as keyof typeof KNOWN_PARAMS] as Param;

function eq(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export const AM4_MIDI_REGISTERS_CASE_COUNT = 12;

export function runAm4MidiRegisterTests(): void {
  const failed: string[] = [];

  // 1-4. Classification. global _cc + scene-MIDI slots are raw-int; the
  //       negative-range tuner offset knob and a normal knob are NOT.
  if (!isRawIntRegister(P('global.scene_cc'))) failed.push('global.scene_cc should be raw-int');
  if (!isRawIntRegister(P('preset.scene_1_midi_1_channel'))) failed.push('scene_1_midi_1_channel should be raw-int');
  if (isRawIntRegister(P('global.offset1'))) failed.push('global.offset1 (-25..25) must NOT be raw-int (stays on Q16 path)');
  if (isRawIntRegister(P('amp.gain'))) failed.push('amp.gain (normalized knob) must NOT be raw-int');

  // 5-6. None-sentinel eligibility: only _cc CC-assignment registers.
  if (!rawIntRegisterHasNone(P('global.scene_cc'))) failed.push('global.scene_cc should carry the None sentinel');
  if (rawIntRegisterHasNone(P('preset.scene_1_midi_1_channel'))) failed.push('scene-MIDI channel slot has no None state');

  // 7-9. Decode: integer verbatim; 128 → None on a _cc register; 128 stays an
  //       integer on a non-None raw-int register.
  if (decodeRawIntRegister(P('global.scene_cc'), 34) !== 34) failed.push('scene_cc 34 should decode to 34');
  if (decodeRawIntRegister(P('global.scene_cc'), 128) !== 'None') failed.push('scene_cc 128 should decode to None');
  if (decodeRawIntRegister(P('preset.scene_1_midi_1_channel'), 128) !== 128) failed.push('non-None raw-int 128 should stay 128');

  // 10. The BUG-6 regression guard: live decode of a scene-CC of 34 must read
  //     the u32 (34) directly, NOT the float path (which yields 34/65534 ≈ 0).
  const live = decodeAm4LiveValue(0x0001, 0x004a, 34 / 65534, 34, 0x0010);
  if (live.paramKey !== 'global.scene_cc') failed.push(`expected global.scene_cc, got ${live.paramKey}`);
  if (live.display !== 34) failed.push(`BUG-6: scene-CC 34 should decode to 34, got ${live.display}`);
  if (live.formatted !== '34') failed.push(`expected formatted '34', got '${live.formatted}'`);
  const liveNone = decodeAm4LiveValue(0x0001, 0x004a, 128 / 65534, 128, 0x0010);
  if (liveNone.formatted !== 'None') failed.push(`scene-CC 128 should format as None, got '${liveNone.formatted}'`);

  // 11. Write path: 'None' → 128, numeric passes through; both match the plain
  //     buildSetParam bytes for the resolved integer (count scale = 1).
  if (!eq(buildSetRawIntRegister('global.scene_cc', 'None'), buildSetParam('global.scene_cc', 128))) {
    failed.push("buildSetRawIntRegister(scene_cc,'None') must equal buildSetParam(scene_cc,128)");
  }
  if (!eq(buildSetRawIntRegister('global.scene_cc', 34), buildSetParam('global.scene_cc', 34))) {
    failed.push('buildSetRawIntRegister(scene_cc,34) must equal buildSetParam(scene_cc,34)');
  }

  // 12. Guards: out-of-range integer and 'None' on a non-None register throw.
  let threwRange = false;
  try { encodeRawIntRegister(P('global.scene_cc'), 200); } catch { threwRange = true; }
  if (!threwRange) failed.push('scene_cc 200 (>127) should throw');
  let threwNone = false;
  try { encodeRawIntRegister(P('preset.scene_1_midi_1_channel'), 'None'); } catch { threwNone = true; }
  if (!threwNone) failed.push("'None' on a non-None raw-int register should throw");

  if (failed.length > 0) {
    throw new Error(`[am4/midiregisters] ${failed.length} failure(s):\n` + failed.join('\n'));
  }
}
