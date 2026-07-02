/**
 * VP4 fn=0x01 write-codec goldens.
 *
 * Byte-exact against two community captures (Kevin Iudicello, fw 4.03; the
 * 2026-06-09 edit session). Frames lifted verbatim from
 * `samples/captured/decoded/vp4-403-v2/FINDINGS.md`. Failure means the VP4
 * write codec drifted from the real device's wire shape.
 *
 * Status: 🟡 community beta. SAVE + bypass are strong-evidence (byte-identical,
 * echo-confirmed); continuous set_param ships normalized [0,1] (display
 * calibration pending a sweep).
 */
import {
  encodeVp4Float,
  decodeVp4Float,
  buildVp4SetParam,
  buildVp4SetBypass,
  buildVp4Save,
  parseVp4WriteEcho,
  isVp4SaveAck,
  VP4_BYPASS_ON_NORMALIZED,
} from '../../../src/gen3/vp4/index.js';

function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Case { label: string; built: number[]; expected: string; }

// Captured frames (F0 … F7), F0/F7 included.
const cases: Case[] = [
  // SAVE — byte-identical both times Kevin saved.
  { label: 'buildVp4Save()', built: buildVp4Save(), expected: 'f0000174140100000000 1b000000040030000000003f f7'.replace(/\s/g, '') },
  // BYPASS — Reverb#1 = effectId 66 (0x42). bypass-on / enable, captured verbatim.
  { label: 'buildVp4SetBypass(66, true)', built: buildVp4SetBypass(66, true), expected: 'f00001741401 42000300 01000000 0400 0000100378 3f f7'.replace(/\s/g, '') },
  { label: 'buildVp4SetBypass(66, false)', built: buildVp4SetBypass(66, false), expected: 'f00001741401 42000300 01000000 0400 0000000000 54 f7'.replace(/\s/g, '') },
];
// NOTE on continuous SET: the editor's captured drag frames carry noise in the top
// septet (e.g. value `45 69 02 23 78`, where s4=0x23 has bits beyond a 32-bit float
// the device masks), so they are NOT byte-reproducible from a clean float32. We emit
// a clean `encodeVp4Float(normalized)` (which the device masks the same way) and
// assert the continuous path structurally + round-trip below, not byte-exact vs drag.

export function runVp4SetParamTests(): void {
  const failed: string[] = [];

  // Envelope goldens.
  for (const c of cases) {
    const got = hex(c.built);
    if (got !== c.expected) failed.push(`${c.label}\n  expected: ${c.expected}\n  got:      ${got}`);
  }

  // encodeVp4Float / decodeVp4Float round-trip + the bypass-on constant.
  for (const v of [0, 0.145, 0.5, VP4_BYPASS_ON_NORMALIZED, 0.575, 1.0]) {
    const back = decodeVp4Float(encodeVp4Float(v));
    if (Math.abs(back - v) > 1e-6) failed.push(`float round-trip drift at ${v} — got ${back}`);
  }
  // bypass-on must encode to the captured bytes 00 00 10 03 78.
  if (hex(encodeVp4Float(VP4_BYPASS_ON_NORMALIZED)) !== '0000100378') {
    failed.push(`encodeVp4Float(bypass-on) drift — got ${hex(encodeVp4Float(VP4_BYPASS_ON_NORMALIZED))}`);
  }

  // CONTINUOUS set_param: structural + round-trip (drag frames aren't byte-reproducible).
  const cont = buildVp4SetParam(70, 14, 0.5, { continuous: true }); // Delay#1 DELAY_FEED
  const head = hex(cont.slice(0, 11)); // f0 ..14 01 [eid 46 00][pid 0e 00][tc 02]
  if (head !== 'f0000174140146000e0002') failed.push(`continuous header drift — got ${head}`);
  if (cont.length !== 23) failed.push(`continuous frame length drift — got ${cont.length}`);
  if (Math.abs(decodeVp4Float(cont.slice(16, 21)) - 0.5) > 1e-6) {
    failed.push(`continuous value round-trip drift — got ${decodeVp4Float(cont.slice(16, 21))}`);
  }

  // parseVp4WriteEcho — captured bypass-on echo carries same eid/pid/tc + value.
  const echo = [0xf0, 0x00, 0x01, 0x74, 0x14, 0x01, 0x42, 0x00, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x28, 0x00, 0x00, 0x00, 0x10, 0x03, 0x78, 0x02, 0xf7];
  const parsed = parseVp4WriteEcho(echo);
  if (!parsed || parsed.effectId !== 66 || parsed.paramId !== 3 || parsed.tc !== 0x01) {
    failed.push(`parseVp4WriteEcho drift — ${JSON.stringify(parsed)}`);
  } else if (hex(parsed.valueBytes) !== '0000100378') {
    failed.push(`parseVp4WriteEcho value drift — got ${hex(parsed.valueBytes)}`);
  }
  if (parseVp4WriteEcho([0xf0, 0x00, 0x01, 0x74, 0x10, 0x01]) !== null) {
    failed.push('parseVp4WriteEcho: expected null on a non-VP4 (III) frame');
  }

  // isVp4SaveAck — the 16-byte completion ack vs a normal frame.
  const saveAck = [0xf0, 0x00, 0x01, 0x74, 0x14, 0x01, 0x00, 0x00, 0x00, 0x00, 0x1b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0b, 0xf7];
  if (!isVp4SaveAck(saveAck)) failed.push('isVp4SaveAck: failed to recognize the captured SAVE ack');
  if (isVp4SaveAck(buildVp4Save())) failed.push('isVp4SaveAck: misclassified the 23-byte SAVE write as the ack');

  if (failed.length) {
    throw new Error(`VP4 set-param goldens failed:\n${failed.join('\n')}`);
  }
  console.log(`  vp4/setparam: ${VP4_SETPARAM_CASE_COUNT} cases PASS`);
}

export const VP4_SETPARAM_CASE_COUNT = cases.length + 6 + 1 + 3 + 3 + 2;
