/**
 * Axe-Fx III effectId <-> family table (`src/gen3/axe-fx-iii/effectIds.ts`).
 *
 * Committed data only. Cross-checks the table against the shared block roster
 * (`AXE_FX_III_BLOCKS`), the III parameter and range catalogs, and the FM3 table that shares
 * the roster:
 *   1. every entry's family exists in the III catalogs; families are unique;
 *   2. every placeable entry's first id and instance span equal the roster's;
 *   3. the six roster-only ids are `roster`, every other entry is `verified`;
 *   4. Dynamic Distortion and NAM have no entry; the only roster ids without an entry are the
 *      tuner and the Preset FC (no parameter family);
 *   5. reserved id spans never overlap, and the instance-aware lookup resolves every instance;
 *   6. the base-id reverse map is identical to the FM3 / FM9 map (the roster is shared);
 *   7. the III catalog sections of the roster-only families sit at the roster's effect-type
 *      position (hint evidence), with the documented exceptions;
 *   8. the `(family, instance)` resolver;
 *   9. the families the III catalog has but no id reaches are exactly DYNDIST and PRESET.
 */
import {
  AXE_FX_III_BLOCKS,
  AXE3_EFFECT_ID_TABLE,
  AXE3_EFFECT_IDS,
  AXE3_FAMILY_BY_EFFECT_ID,
  AXE3_RANGES,
  AXE3_RANGE_SECTIONS,
  FAMILIES,
  PARAMS_BY_FAMILY,
  axe3EffectId,
  axe3EffectIdEntry,
} from '../../../src/gen3/axe-fx-iii/index.js';
import { FM3_EFFECT_ID_TABLE, FM3_FAMILY_BY_EFFECT_ID } from '../../../src/gen3/fm3/index.js';
import { FM9_FAMILY_BY_EFFECT_ID } from '../../../src/gen3/fm9/index.js';

const fail = (msg: string): never => {
  throw new Error(`[axe-fx-iii/effect-ids] ${msg}`);
};

/** The six ids whose binding no device read has confirmed (FORGEFX-45). */
const ROSTER_ONLY: ReadonlyArray<readonly [family: string, firstId: number]> = [
  ['IRCAPTURE', 36],
  ['VOCODER', 134],
  ['CROSSOVER', 142],
  ['TONEMATCH', 170],
  ['RTA', 174],
  ['IRPLAYER', 195],
];

const cases: Array<[string, () => void]> = [
  ['families exist in the III catalogs and are unique', () => {
    const seen = new Set<string>();
    for (const e of AXE3_EFFECT_ID_TABLE) {
      if (seen.has(e.family)) fail(`family ${e.family} appears twice`);
      seen.add(e.family);
      if (!FAMILIES.includes(e.family)) fail(`family ${e.family} is not an Axe-Fx III family`);
      if (!Array.isArray(PARAMS_BY_FAMILY[e.family]) || PARAMS_BY_FAMILY[e.family].length === 0) {
        fail(`family ${e.family} has no params in PARAMS_BY_FAMILY`);
      }
      if (e.addressing === 'block' && !(e.family in AXE3_RANGES)) fail(`block family ${e.family} has no range table`);
      if (e.addressing === 'none' ? e.firstId !== null : e.firstId === null) fail(`${e.family}: firstId must be null exactly when addressing is 'none'`);
      if (e.instances < 1) fail(`${e.family}: instances must be at least 1`);
    }
    // 48 III families: every one but DYNDIST has an entry.
    if (AXE3_EFFECT_ID_TABLE.length !== FAMILIES.length - 1) {
      fail(`expected ${FAMILIES.length - 1} entries, got ${AXE3_EFFECT_ID_TABLE.length}`);
    }
  }],

  ['placeable first ids and instance spans match the roster', () => {
    for (const e of AXE3_EFFECT_ID_TABLE) {
      if (e.addressing !== 'block') continue;
      const block = AXE_FX_III_BLOCKS.find((b) => b.firstId === e.firstId);
      if (!block) fail(`block ${e.family} firstId ${e.firstId} not present in AXE_FX_III_BLOCKS`);
      else {
        if (block.instances !== e.instances) fail(`${e.family}: ${e.instances} instances, roster ${block.instances}`);
        if (block.name !== e.name) fail(`${e.family}: name '${e.name}', roster '${block.name}'`);
      }
    }
    // Virtual entries that the roster lists agree with it as well.
    for (const [family, firstId] of [['CONTROLLERS', 2], ['MIDIBLOCK', 190], ['FC', 199], ['IRCAPTURE', 36]] as const) {
      const e = AXE3_EFFECT_ID_TABLE.find((x) => x.family === family);
      const block = AXE_FX_III_BLOCKS.find((b) => b.firstId === firstId);
      if (!e || e.firstId !== firstId || !block) fail(`${family} must sit at roster id ${firstId}`);
    }
  }],

  ['exactly the six roster-only ids are roster', () => {
    const roster = AXE3_EFFECT_ID_TABLE.filter((e) => e.confidence === 'roster');
    if (roster.length !== ROSTER_ONLY.length) fail(`expected ${ROSTER_ONLY.length} roster entries, got ${roster.length}`);
    for (const [family, firstId] of ROSTER_ONLY) {
      const e = AXE3_EFFECT_ID_TABLE.find((x) => x.family === family);
      if (!e || e.firstId !== firstId || e.confidence !== 'roster') fail(`${family} must be a roster entry at ${firstId}`);
      if (axe3EffectIdEntry(firstId)?.entry.confidence !== 'roster') fail(`lookup of ${firstId} must be roster`);
    }
    for (const e of AXE3_EFFECT_ID_TABLE) {
      if (!ROSTER_ONLY.some(([f]) => f === e.family) && e.confidence !== 'verified') fail(`${e.family} must be verified`);
    }
    // The IR Capture utility is virtual; the other five are placeable blocks.
    const virtual = roster.filter((e) => e.addressing === 'virtual').map((e) => e.family);
    if (virtual.join() !== 'IRCAPTURE') fail(`unexpected virtual roster entries ${virtual.join()}`);
  }],

  ['Dynamic Distortion and NAM have no entry', () => {
    for (const key of ['DYNDIST', 'NAM']) {
      if (key in AXE3_EFFECT_IDS) fail(`${key} must have no effect id entry`);
      if (AXE3_EFFECT_ID_TABLE.some((e) => e.family === key)) fail(`${key} must not be in the table`);
      if (axe3EffectId(key) !== null) fail(`axe3EffectId(${key}) must be null`);
    }
    for (const name of ['Dynamic Distortion', 'NAM']) {
      if (AXE3_EFFECT_ID_TABLE.some((e) => e.name === name)) fail(`'${name}' must not be in the table`);
      const b = AXE_FX_III_BLOCKS.find((x) => x.name === name);
      if (!b || b.firstId !== null) fail(`roster entry '${name}' must have no first id`);
    }
    // Every roster id without an entry is a block without a parameter family.
    const inTable = new Set(AXE3_EFFECT_ID_TABLE.map((e) => e.firstId));
    const missing = AXE_FX_III_BLOCKS.filter((b) => b.firstId !== null && !inTable.has(b.firstId)).map((b) => b.firstId);
    if (missing.join() !== '35,200') fail(`roster ids without an entry: ${missing.join()} (expected the tuner 35 and the Preset FC 200)`);
  }],

  ['reserved id spans are disjoint and every instance resolves', () => {
    let reserved = 0;
    const owner = new Map<number, string>();
    for (const e of AXE3_EFFECT_ID_TABLE) {
      if (e.firstId === null) continue;
      for (let i = 0; i < e.instances; i++) {
        const id = e.firstId + i;
        reserved += 1;
        const prev = owner.get(id);
        if (prev) fail(`effectId ${id} reserved by both ${prev} and ${e.family}`);
        owner.set(id, e.family);
        const hit = axe3EffectIdEntry(id);
        if (!hit || hit.entry.family !== e.family || hit.instance !== i + 1) fail(`axe3EffectIdEntry(${id}) must be ${e.family} instance ${i + 1}`);
      }
    }
    if (reserved !== owner.size) fail('reserved id count mismatch');
    // Ids outside the table: unmapped, the tuner, the Preset FC, later modifier slots, far ids.
    for (const id of [0, 4, 34, 35, 200, 201, 5000, -1, 1.5, NaN]) {
      if (axe3EffectIdEntry(id) !== undefined) fail(`axe3EffectIdEntry(${id}) must be undefined`);
    }
    // Instance ids of a roster entry carry its confidence.
    const vocoder2 = axe3EffectIdEntry(135);
    if (!vocoder2 || vocoder2.entry.family !== 'VOCODER' || vocoder2.instance !== 2 || vocoder2.entry.confidence !== 'roster') {
      fail('effectId 135 must be Vocoder instance 2 (roster)');
    }
    const input5 = axe3EffectIdEntry(41);
    if (!input5 || input5.entry.family !== 'INPUT' || input5.instance !== 5) fail('effectId 41 must be Input instance 5');
  }],

  ['base-id map equals the FM3 / FM9 map (shared roster)', () => {
    const iii = JSON.stringify(Object.entries(AXE3_FAMILY_BY_EFFECT_ID).sort((a, b) => Number(a[0]) - Number(b[0])));
    const fm3 = JSON.stringify(Object.entries(FM3_FAMILY_BY_EFFECT_ID).sort((a, b) => Number(a[0]) - Number(b[0])));
    const fm9 = JSON.stringify(Object.entries(FM9_FAMILY_BY_EFFECT_ID).sort((a, b) => Number(a[0]) - Number(b[0])));
    if (iii !== fm3) fail('AXE3_FAMILY_BY_EFFECT_ID differs from FM3_FAMILY_BY_EFFECT_ID');
    if (iii !== fm9) fail('AXE3_FAMILY_BY_EFFECT_ID differs from FM9_FAMILY_BY_EFFECT_ID');
    for (const e of FM3_EFFECT_ID_TABLE) {
      if (AXE3_EFFECT_IDS[e.family] !== e.firstId) fail(`${e.family}: III id ${AXE3_EFFECT_IDS[e.family]} differs from FM3 ${e.firstId}`);
    }
    if (AXE3_FAMILY_BY_EFFECT_ID[58] !== 'DISTORT' || AXE3_FAMILY_BY_EFFECT_ID[118] !== 'FUZZ') fail('DISTORT=Amp 58 and FUZZ=Drive 118 must hold');
    if (59 in AXE3_FAMILY_BY_EFFECT_ID) fail('the base-id map must not list instance ids');
  }],

  ['roster-only families sit at the roster effect-type position in the III catalog', () => {
    // The shared roster's effect-type column equals the cache section tag for the placeable
    // families (exceptions: Input, Output and Controllers, which have per-instance or shifted
    // sections). Hint evidence for the roster entries, never a binding.
    const exceptions = new Set(['INPUT', 'OUTPUT', 'CONTROLLERS']);
    let agree = 0;
    for (const e of FM3_EFFECT_ID_TABLE) {
      const section = (AXE3_RANGE_SECTIONS as Record<string, { sectionTag: number } | undefined>)[e.family];
      if (!section || e.effectType === null || exceptions.has(e.family)) continue;
      if (section.sectionTag !== e.effectType) fail(`${e.family}: III section ${section.sectionTag}, roster effect type ${e.effectType}`);
      agree += 1;
    }
    if (agree !== 38) fail(`expected 38 agreeing families, got ${agree}`);
    for (const family of ['VOCODER', 'CROSSOVER', 'TONEMATCH', 'RTA', 'IRPLAYER']) {
      if (!(family in AXE3_RANGE_SECTIONS)) fail(`${family} has no III catalog section`);
    }
    if ('IRCAPTURE' in AXE3_RANGE_SECTIONS) fail('IRCAPTURE is virtual and has no catalog section');
  }],

  ['(family, instance) resolver', () => {
    const table: Array<[string, number | undefined, number | null]> = [
      ['DISTORT', undefined, 58], ['DISTORT', 4, 61], ['DISTORT', 5, null], ['DISTORT', 0, null], ['DISTORT', 1.5, null],
      ['INPUT', 5, 41], ['OUTPUT', 4, 45], ['OUTPUT', 5, null], ['VOCODER', 2, 135], ['FUZZ', 1, 118],
      ['MULTIPLEXER', 4, 194], ['FC', 1, 199], ['GLOBAL', 1, 1], ['MOD', 1, 3], ['MOD', 2, null],
      ['IRCAPTURE', 1, 36], ['PRESET', 1, null], ['DYNDIST', 1, null], ['NAM', 1, null], ['NO_SUCH_FAMILY', 1, null],
    ];
    for (const [family, instance, expected] of table) {
      const got = instance === undefined ? axe3EffectId(family) : axe3EffectId(family, instance);
      if (got !== expected) fail(`axe3EffectId(${family}, ${instance}) = ${got}, expected ${expected}`);
    }
  }],

  ['the only catalog families no id reaches are DYNDIST and PRESET', () => {
    const reached = new Set(AXE3_EFFECT_ID_TABLE.filter((e) => e.firstId !== null).map((e) => e.family));
    const unreached = FAMILIES.filter((f) => !reached.has(f)).sort().join();
    if (unreached !== 'DYNDIST,PRESET') fail(`unreached families: ${unreached}`);
    // The six ids that had no family before this table (36, 134, 142, 170, 174, 195) now resolve.
    for (const [family, firstId] of ROSTER_ONLY) {
      if (AXE3_FAMILY_BY_EFFECT_ID[firstId] !== family) fail(`effectId ${firstId} must resolve to ${family}`);
    }
  }],
];

export const AXE3_EFFECT_IDS_CASE_COUNT = cases.length;

export function runAxe3EffectIdsTests(): void {
  for (const [name, run] of cases) {
    try {
      run();
    } catch (err) {
      throw new Error(`case '${name}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
