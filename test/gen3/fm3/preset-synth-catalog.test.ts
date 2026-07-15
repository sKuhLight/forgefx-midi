/**
 * FM3 catalog/defaults-driven block builder (FORGEFXMID-40).
 *
 * `buildCatalogBlock` builds a block record from AUTHORITATIVE geometry
 * (FM3_BLOCK_GEOMETRY, fixture word15×word16) + every cataloged param slot filled
 * with its catalog `defaultRaw` (FORGEFXMID-39) — the template-free synthesis path.
 * This suite proves it on the 25 families that HAVE geometry:
 *
 *   1. every geometry family builds (non-null), and the record's word15/word16 +
 *      byte length match FM3_BLOCK_GEOMETRY exactly (chain-walk size correctness);
 *   2. placing the record at an offset with its eid signature and decoding through
 *      `readBlockParams` returns each cataloged param's `defaultRaw` byte-exact
 *      (the write→read contract the synthesizer relies on), across all amp channels;
 *   3. the 10 untemplated families (no fixture) carry NO geometry — `buildCatalogBlock`
 *      returns null (never fabricated), matching the FORGEFXMID-40 rigor rule.
 *
 * NOT a device-acceptance test; it validates the codec's own build/read model.
 */
import {
  buildCatalogBlock,
  FM3_BLOCK_GEOMETRY,
} from '../../../src/devices/gen3/presetSynth.js';
import { gen3BlockParamModel, readBlockParams } from '../../../src/devices/gen3/blockParams.js';
import { EFFECT_BASES, MODEL_FM3 } from '../../../src/devices/gen3/presetBody.js';

const HEADER_PRELUDE_GAP = 12;
const BLOCK_HEADER_WORDS = 23;

export const PRESET_SYNTH_CATALOG_CASE_COUNT = Object.keys(FM3_BLOCK_GEOMETRY).length;

function fail(msg: string): never {
  throw new Error(`[fm3/preset-synth-catalog] ${msg}`);
}

/** The 10 families no fixture places — must have no geometry (rigor rule). */
const UNTEMPLATED = [54, 98, 102, 126, 130, 138, 158, 162, 166, 191];

export function runPresetSynthCatalogTests(): void {
  const { tables, layout } = gen3BlockParamModel(MODEL_FM3);
  const u16 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8)) & 0xffff;

  // (3) untemplated families carry no geometry and refuse to build.
  for (const base of UNTEMPLATED) {
    if (FM3_BLOCK_GEOMETRY[base] != null) fail(`untemplated family ${EFFECT_BASES[base]}(${base}) unexpectedly has geometry`);
    if (buildCatalogBlock(base, layout, tables) != null) fail(`buildCatalogBlock fabricated a record for untemplated ${EFFECT_BASES[base]}(${base})`);
  }

  let built = 0;
  let roundTripParams = 0;
  for (const baseStr of Object.keys(FM3_BLOCK_GEOMETRY)) {
    const base = Number(baseStr);
    const g = FM3_BLOCK_GEOMETRY[base];
    const rec = buildCatalogBlock(base, layout, tables);
    if (!rec) fail(`geometry family ${EFFECT_BASES[base]}(${base}) built null`);
    built++;

    // (1) geometry + size.
    if (u16(rec.bytes, 30) !== g.cols || u16(rec.bytes, 32) !== g.rows) {
      fail(`${EFFECT_BASES[base]}(${base}): header word15/16 ${u16(rec.bytes, 30)}x${u16(rec.bytes, 32)} != geometry ${g.cols}x${g.rows}`);
    }
    const expSize = (BLOCK_HEADER_WORDS + g.cols * g.rows) * 2;
    if (rec.bytes.length !== expSize) fail(`${EFFECT_BASES[base]}(${base}): record ${rec.bytes.length}B != expected ${expSize}B`);

    // (2) place at a header (sig at offset-12) and read defaults back.
    const family = tables.familyByEffectId[String(base)];
    if (!family || !tables.paramsByFamily[family]) continue; // not a readBlockParams family (e.g. I/O) — geometry checked, skip param read
    const floor = layout.paramRegionFloor;
    const blockOffset = floor + HEADER_PRELUDE_GAP;
    const body = new Uint8Array(blockOffset + rec.bytes.length + 16);
    body.set(rec.bytes, blockOffset);
    body[floor] = base & 0xff; // eid signature (+ 8 zero bytes already zero)
    body[floor + 1] = (base >> 8) & 0xff;

    const decoded = readBlockParams(body, new Set([base]), tables, layout);
    if (decoded.length === 0) fail(`${EFFECT_BASES[base]}(${base}): readBlockParams found no block`);
    const ranges = tables.ranges[family] as unknown as Record<number, { defaultRaw?: number }>;
    for (const b of decoded) {
      for (const p of b.params) {
        const dr = ranges[p.paramId]?.defaultRaw;
        if (dr == null) continue;
        if (p.raw !== dr) {
          fail(`${EFFECT_BASES[base]}(${base}) ch${b.channel ?? 0} pid ${p.paramId}: read ${p.raw} != defaultRaw ${dr}`);
        }
        roundTripParams++;
      }
    }
  }

  if (built !== PRESET_SYNTH_CATALOG_CASE_COUNT) fail(`built ${built} != ${PRESET_SYNTH_CATALOG_CASE_COUNT} geometry families`);
  if (roundTripParams < 200) fail(`only ${roundTripParams} default params round-tripped — not meaningful`);
  console.log(`  [preset-synth-catalog] ${built} families built from geometry+defaults; ${roundTripParams} defaultRaw params read back byte-exact; ${UNTEMPLATED.length} untemplated families correctly refused`);
}
