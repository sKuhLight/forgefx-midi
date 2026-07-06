/**
 * FM9 + Axe-Fx III generic block-param extraction — cross-device goldens.
 *
 * Fixture: the "Devs Gift Of Tone" artist preset, released by its author for
 * BOTH devices (fm9/fixtures/devs-gift-of-tone.syx + axe-fx-iii/…). The same
 * preset on two devices is the calibration ground truth for the FM9/III body
 * layouts (paramArrayBase 0x2e, ampChannelStride FM9 0x122 / III 0x118 — see
 * src/devices/gen3/blockParams.ts calibration block): both bodies must decode
 * to the SAME models at the same ordinals through each device's OWN param
 * table and enum vocabulary.
 *
 * Two gates per device:
 *   1. field-exact equality against the frozen golden decode
 *      (devs-gift-of-tone.params.expected.json);
 *   2. the cross-device `modelsFromBlocks` projections must agree exactly
 *      (amp 'Herbie CH3', drive 'T808 OD', delay 'Stereo BBD', …).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePresetDump } from '../../../src/devices/gen3/presetDump.js';
import { decodeRawPatch } from '../../../src/devices/gen3/presetHuffman.js';
import { decodeGen3Body } from '../../../src/devices/gen3/presetBody.js';
import {
  readBlockParamsForModel,
  hasBlockParamModel,
  gen3BlockParamModel,
  modelsFromBlocks,
  type DecodedBlock,
} from '../../../src/devices/gen3/blockParams.js';

const GEN3 = join(dirname(fileURLToPath(import.meta.url)), '..');

export const CROSS_BLOCKPARAMS_CASE_COUNT = 2;

function assertDeepEqual(actual: unknown, expected: unknown, path: string): void {
  const a = JSON.parse(JSON.stringify(actual ?? null));
  const e = JSON.parse(JSON.stringify(expected ?? null));
  diff(a, e, path);
}
function diff(a: unknown, e: unknown, path: string): void {
  if (Array.isArray(e)) {
    if (!Array.isArray(a)) throw new Error(`${path}: expected array, got ${typeof a}`);
    if (a.length !== e.length) throw new Error(`${path}: length ${a.length} !== expected ${e.length}`);
    for (let i = 0; i < e.length; i++) diff(a[i], e[i], `${path}[${i}]`);
    return;
  }
  if (e !== null && typeof e === 'object') {
    if (a === null || typeof a !== 'object') throw new Error(`${path}: expected object, got ${JSON.stringify(a)}`);
    const ak = Object.keys(a as object).sort();
    const ek = Object.keys(e as object).sort();
    if (ak.join(',') !== ek.join(',')) throw new Error(`${path}: keys [${ak.join(',')}] !== expected [${ek.join(',')}]`);
    for (const k of ek) diff((a as Record<string, unknown>)[k], (e as Record<string, unknown>)[k], `${path}.${k}`);
    return;
  }
  if (a !== e) throw new Error(`${path}: ${JSON.stringify(a)} !== expected ${JSON.stringify(e)}`);
}

function decodeFixture(dir: string, model: number): DecodedBlock[] {
  const syx = new Uint8Array(readFileSync(join(GEN3, dir, 'fixtures', 'devs-gift-of-tone.syx')));
  const parsed = parsePresetDump(syx, 0, model);
  const decoded = decodeRawPatch(parsed.chunkPayloads);
  if (!decoded.crcValid) throw new Error(`[${dir}] devs-gift-of-tone: CRC invalid — fixture corrupt?`);
  const body3 = decodeGen3Body(decoded.body, model);
  const placedEids = new Set<number>(
    (body3.grid ?? []).filter((c) => !c.is_shunt && c.effect_id).map((c) => c.effect_id),
  );
  return readBlockParamsForModel(decoded.body, placedEids, model);
}

export function runCrossBlockParamsTests(): void {
  // model gating: FM3 + FM9 + III verified; VP4 must still refuse.
  for (const verified of [0x10, 0x11, 0x12]) {
    if (!hasBlockParamModel(verified)) throw new Error(`[blockparams-cross] model 0x${verified.toString(16)} must be verified`);
    gen3BlockParamModel(verified);
  }
  if (hasBlockParamModel(0x14)) throw new Error('[blockparams-cross] VP4 (0x14) must NOT be verified');
  let threw = false;
  try { gen3BlockParamModel(0x14); } catch { threw = true; }
  if (!threw) throw new Error('[blockparams-cross] gen3BlockParamModel(0x14) must throw');

  const projections: Record<string, Record<string, string[]>> = {};
  for (const { dir, model } of [
    { dir: 'fm9', model: 0x12 },
    { dir: 'axe-fx-iii', model: 0x10 },
  ]) {
    const blocks = decodeFixture(dir, model);
    const expected = JSON.parse(
      readFileSync(join(GEN3, dir, 'fixtures', 'devs-gift-of-tone.params.expected.json'), 'utf8'),
    ) as { blocks: unknown[] };
    assertDeepEqual(blocks, expected.blocks, `${dir}.blocks`);
    projections[dir] = modelsFromBlocks(blocks);
  }

  // Cross-device ground truth: the SAME preset must name the SAME models on both devices.
  assertDeepEqual(projections['fm9'], projections['axe-fx-iii'], 'models(fm9 vs iii)');
  const amp = projections['fm9']!['amp'];
  if (!amp || amp[0] !== 'Herbie CH3') throw new Error(`[blockparams-cross] amp model expected 'Herbie CH3', got ${JSON.stringify(amp)}`);
}
