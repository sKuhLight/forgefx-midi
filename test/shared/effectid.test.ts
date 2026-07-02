/**
 * Golden cases for the cross-device `resolveEffectId(modelByte, name)`.
 *
 * Five shared blocks per device, asserting the device-native block
 * identifier each model byte uses:
 *   - AM4 (0x15) returns the block pidLow.
 *   - Axe-Fx II (0x07) returns the per-instance effectId.
 *   - gen-3 (0x10 / 0x11 / 0x12 / 0x14) returns firstId + (instance - 1).
 *
 * Expected numbers are read straight from the device blockTypes tables
 * (am4/blockTypes.ts, axe-fx-ii/blockTypes.ts, axe-fx-iii/blockTypes.ts).
 * The same friendly name ("Reverb 1") resolves to a DIFFERENT id per
 * device. That is the point of the model-byte dispatch.
 */
import { resolveEffectId, FRACTAL_MODEL_BYTES } from '../../src/shared/effectId.js';

interface Case {
  label: string;
  modelByte: number;
  name: string;
  instance?: number;
  expected: number;
}

const CASES: Case[] = [
  // ── AM4 (0x15), block pidLow, single instance ───────────────────
  { label: 'AM4 Amp', modelByte: FRACTAL_MODEL_BYTES.am4, name: 'Amp', expected: 0x003a },
  { label: 'AM4 Reverb', modelByte: FRACTAL_MODEL_BYTES.am4, name: 'reverb', expected: 0x0042 },
  { label: 'AM4 Delay', modelByte: FRACTAL_MODEL_BYTES.am4, name: 'Delay 1', expected: 0x0046 },
  { label: 'AM4 Compressor', modelByte: FRACTAL_MODEL_BYTES.am4, name: 'Compressor', expected: 0x002e },
  { label: 'AM4 Drive', modelByte: FRACTAL_MODEL_BYTES.am4, name: 'drive', expected: 0x0076 },

  // ── Axe-Fx II (0x07), per-instance effectId ─────────────────────
  { label: 'II Amp 1', modelByte: FRACTAL_MODEL_BYTES.axeFxII, name: 'Amp 1', expected: 106 },
  { label: 'II Reverb 1', modelByte: FRACTAL_MODEL_BYTES.axeFxII, name: 'Reverb 1', expected: 110 },
  { label: 'II Reverb 2', modelByte: FRACTAL_MODEL_BYTES.axeFxII, name: 'Reverb', instance: 2, expected: 111 },
  { label: 'II Delay 1', modelByte: FRACTAL_MODEL_BYTES.axeFxII, name: 'Delay 1', expected: 112 },
  { label: 'II Compressor 1', modelByte: FRACTAL_MODEL_BYTES.axeFxII, name: 'Compressor 1', expected: 100 },
  { label: 'II Drive via group REV', modelByte: FRACTAL_MODEL_BYTES.axeFxII, name: 'REV', expected: 110 },

  // ── Axe-Fx III (0x10), firstId + (instance - 1) ─────────────────
  { label: 'III Amp 1', modelByte: FRACTAL_MODEL_BYTES.axeFxIII, name: 'Amp 1', expected: 58 },
  { label: 'III Reverb 1', modelByte: FRACTAL_MODEL_BYTES.axeFxIII, name: 'Reverb 1', expected: 66 },
  { label: 'III Reverb 2', modelByte: FRACTAL_MODEL_BYTES.axeFxIII, name: 'Reverb 2', expected: 67 },
  { label: 'III Delay 1', modelByte: FRACTAL_MODEL_BYTES.axeFxIII, name: 'Delay', expected: 70 },
  { label: 'III Compressor 1', modelByte: FRACTAL_MODEL_BYTES.axeFxIII, name: 'Compressor 1', expected: 46 },
  { label: 'III Drive 1', modelByte: FRACTAL_MODEL_BYTES.axeFxIII, name: 'Drive 1', expected: 118 },

  // ── FM3 (0x11) / FM9 (0x12), share the gen-3 roster ─────────────
  { label: 'FM3 Reverb 1', modelByte: FRACTAL_MODEL_BYTES.fm3, name: 'Reverb 1', expected: 66 },
  { label: 'FM9 Reverb 1', modelByte: FRACTAL_MODEL_BYTES.fm9, name: 'Reverb 1', expected: 66 },
  { label: 'FM9 Drive 2', modelByte: FRACTAL_MODEL_BYTES.fm9, name: 'Drive 2', expected: 119 },

  // ── VP4 (0x14), effects-only subset of the gen-3 roster ─────────
  { label: 'VP4 Reverb 1', modelByte: FRACTAL_MODEL_BYTES.vp4, name: 'Reverb 1', expected: 66 },
  { label: 'VP4 Delay 1', modelByte: FRACTAL_MODEL_BYTES.vp4, name: 'Delay 1', expected: 70 },
  { label: 'VP4 Chorus 1', modelByte: FRACTAL_MODEL_BYTES.vp4, name: 'Chorus 1', expected: 78 },
  { label: 'VP4 Flanger 1', modelByte: FRACTAL_MODEL_BYTES.vp4, name: 'Flanger 1', expected: 82 },
  { label: 'VP4 Phaser 1', modelByte: FRACTAL_MODEL_BYTES.vp4, name: 'Phaser 1', expected: 90 },
];

export const EFFECTID_CASE_COUNT = CASES.length;

export function runEffectIdTests(): void {
  const failed: string[] = [];
  for (const c of CASES) {
    let got: number | string;
    try {
      got = resolveEffectId(c.modelByte, c.name, c.instance);
    } catch (err) {
      got = `threw: ${(err as Error).message}`;
    }
    if (got !== c.expected) {
      failed.push(`${c.label}\n  expected: ${c.expected}\n  got:      ${got}`);
    }
  }

  // A few negative cases: bad model byte, unknown block, AM4 instance > 1.
  const negatives: Array<{ label: string; fn: () => number }> = [
    { label: 'unknown model byte 0x99', fn: () => resolveEffectId(0x99, 'Reverb 1') },
    { label: 'unknown AM4 block', fn: () => resolveEffectId(FRACTAL_MODEL_BYTES.am4, 'Nonesuch') },
    { label: 'AM4 instance 2 rejected', fn: () => resolveEffectId(FRACTAL_MODEL_BYTES.am4, 'Amp 2') },
  ];
  for (const n of negatives) {
    let threw = false;
    try {
      n.fn();
    } catch {
      threw = true;
    }
    if (!threw) failed.push(`${n.label}\n  expected: throw\n  got:      no error`);
  }

  if (failed.length > 0) {
    throw new Error(
      `${failed.length}/${CASES.length + negatives.length} resolveEffectId case(s) failed:\n` +
        failed.join('\n'),
    );
  }
}
