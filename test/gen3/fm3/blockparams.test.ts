/**
 * FM3 generic block-param extraction — live-hardware goldens.
 *
 * Fixtures under fixtures/ were captured from a REAL FM3 through the
 * pre-migration ForgeFX server (migration Phase 0): `preset-<n>.syx` is the
 * raw 0x77/0x78/0x79 dump, `preset-<n>.params.expected.json` is the exact
 * decode its live-validated implementation produced. This suite re-decodes
 * every dump through the package pipeline (parsePresetDump → decodeRawPatch →
 * decodeGen3Body grid → readBlockParams) and requires field-exact equality —
 * it validates BOTH the upstreamed extraction logic and the package grid
 * decode's placed-block set against the live implementation.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePresetDump } from '../../../src/devices/gen3/presetDump.js';
import { decodeRawPatch } from '../../../src/devices/gen3/presetHuffman.js';
import { decodeGen3Body } from '../../../src/devices/gen3/presetBody.js';
import {
  readBlockParamsForModel,
  gen3BlockParamModel,
  hasBlockParamModel,
  modelsFromBlocks,
} from '../../../src/devices/gen3/blockParams.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FM3 = 0x11;

function listPresetFixtures(): number[] {
  return readdirSync(FIXTURES)
    .map((f) => /^preset-(\d+)\.syx$/.exec(f)?.[1])
    .filter((n): n is string => n != null)
    .map(Number)
    .sort((a, b) => a - b);
}

export const FM3_BLOCKPARAMS_CASE_COUNT = listPresetFixtures().length;

/** Deep equality with a path-reporting error, JSON-normalized (undefined keys drop). */
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
    if (ak.join(',') !== ek.join(',')) {
      throw new Error(`${path}: keys [${ak.join(',')}] !== expected [${ek.join(',')}]`);
    }
    for (const k of ek) diff((a as Record<string, unknown>)[k], (e as Record<string, unknown>)[k], `${path}.${k}`);
    return;
  }
  if (a !== e) throw new Error(`${path}: ${JSON.stringify(a)} !== expected ${JSON.stringify(e)}`);
}

export function runFm3BlockParamsTests(): void {
  // model gating: FM3 verified, III/FM9 refused (device-specific paramIds)
  if (!hasBlockParamModel(FM3)) throw new Error('[fm3/blockparams] FM3 (0x11) must be a verified model');
  gen3BlockParamModel(FM3);
  for (const other of [0x10, 0x12, 0x14]) {
    if (hasBlockParamModel(other)) throw new Error(`[fm3/blockparams] model 0x${other.toString(16)} must NOT be verified yet`);
    let threw = false;
    try { gen3BlockParamModel(other); } catch { threw = true; }
    if (!threw) throw new Error(`[fm3/blockparams] gen3BlockParamModel(0x${other.toString(16)}) must throw`);
  }

  const slots = listPresetFixtures();
  if (slots.length === 0) throw new Error('[fm3/blockparams] no preset fixtures found');

  for (const n of slots) {
    const syx = new Uint8Array(readFileSync(join(FIXTURES, `preset-${n}.syx`)));
    const expected = JSON.parse(readFileSync(join(FIXTURES, `preset-${n}.params.expected.json`), 'utf8')) as {
      blocks: { effectId: number }[];
    };

    const parsed = parsePresetDump(syx, 0, FM3);
    const decoded = decodeRawPatch(parsed.chunkPayloads);
    if (!decoded.crcValid) throw new Error(`[fm3/blockparams] preset-${n}: CRC invalid — fixture corrupt?`);

    const body3 = decodeGen3Body(decoded.body, FM3);
    const placedEids = new Set<number>(
      (body3.grid ?? []).filter((c) => !c.is_shunt && c.effect_id).map((c) => c.effect_id),
    );

    const blocks = readBlockParamsForModel(decoded.body, placedEids, FM3);
    assertDeepEqual(blocks, expected.blocks, `preset-${n}.blocks`);

    // models projection sanity: every rostered type name in the projection is non-#ordinal
    const models = modelsFromBlocks(blocks);
    for (const [slug, names] of Object.entries(models)) {
      for (const name of names) {
        if (name.startsWith('#')) throw new Error(`[fm3/blockparams] preset-${n}: models.${slug} leaked ordinal ${name}`);
      }
    }
  }
}
