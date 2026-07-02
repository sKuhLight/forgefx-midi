/**
 * AM4 decode (wire → display) regression vectors.
 *
 * The companion setparam goldens prove the BUILD path byte-for-byte. This
 * file guards the READ path: that each param's [displayMin, displayMax]
 * range decodes a captured normalized wire value to the dB the device's
 * own front panel shows.
 *
 * Anchored by the 2026-06-06 dev-laptop session
 * (docs/_private/0.2.0-dev-test-2026-06-06.md): the four Scene Level trims
 * are ±20 dB on the device, NOT the -80..+20 span of preset.level. Before
 * the fix, set +10 read back as -5 because decode scaled the same 0.75 wire
 * against -80..+20. The encode/write path is unit-scale based and was always
 * correct; only decode (and therefore get_param / get_preset / list_params)
 * was wrong.
 */
import { decode, KNOWN_PARAMS } from '../../src/am4/index.js';

interface Case {
  label: string;
  key: keyof typeof KNOWN_PARAMS;
  wire: number; // normalized [0,1] as read back (raw register / 65534)
  expected: number; // dB the device front panel shows
}

const cases: Case[] = [
  // Scene Level trims — ±20 dB. Wire values captured live 2026-06-06.
  { label: 'scene_1_level wire 0.75 → +10 dB', key: 'preset.scene_1_level', wire: 0.75, expected: 10 },
  { label: 'scene_2_level wire 0.40 → -4 dB', key: 'preset.scene_2_level', wire: 0.4, expected: -4 },
  { label: 'scene_3_level wire 0.65 → +6 dB', key: 'preset.scene_3_level', wire: 0.65, expected: 6 },
  { label: 'scene_4_level wire 0.425 → -3 dB', key: 'preset.scene_4_level', wire: 0.425, expected: -3 },
  { label: 'scene_1_level wire 0.5 → 0 dB (unity)', key: 'preset.scene_1_level', wire: 0.5, expected: 0 },
  // preset.level genuinely spans -80..+20 and must NOT be touched by the fix.
  { label: 'preset.level wire 0.80 → 0 dB', key: 'preset.level', wire: 0.8, expected: 0 },
];

export function runAm4DecodeTests(): void {
  const failed: string[] = [];
  for (const c of cases) {
    const param = KNOWN_PARAMS[c.key];
    const got = Math.round(decode(param, c.wire) * 100) / 100;
    if (Math.abs(got - c.expected) > 0.01) {
      failed.push(`${c.label}\n  expected: ${c.expected}\n  got:      ${got}`);
    }
  }
  // Range invariants: scene levels are ±20, preset.level is -80..+20.
  for (const k of [
    'preset.scene_1_level',
    'preset.scene_2_level',
    'preset.scene_3_level',
    'preset.scene_4_level',
  ] as const) {
    const p = KNOWN_PARAMS[k];
    if (p.displayMin !== -20 || p.displayMax !== 20) {
      failed.push(`${k} range drifted: expected [-20, 20], got [${p.displayMin}, ${p.displayMax}]`);
    }
  }
  if (KNOWN_PARAMS['preset.level'].displayMin !== -80) {
    failed.push('preset.level displayMin must stay -80 (genuine full-range output trim)');
  }
  if (failed.length > 0) {
    throw new Error(
      `${failed.length}/${cases.length + 5} AM4 decode case(s) failed:\n` + failed.join('\n'),
    );
  }
}

export const AM4_DECODE_CASE_COUNT = cases.length;
