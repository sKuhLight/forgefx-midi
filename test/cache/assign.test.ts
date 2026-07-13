/**
 * Section→family assignment oracle.
 *
 * Runs `buildDeviceCache(records, FM3_PARAMS, HW_SEEDS)` on the committed FM3
 * fw-12.0 walk fixture and asserts the result reproduces the SHIPPED FM3
 * catalog tables via the shared `assertFm3Equivalence` oracle (same thresholds
 * the `cache:check` drift gate uses — factored into `./oracle.ts` so the two
 * cannot drift):
 *   - enum lists: every produced list that exists in FM3_ENUM_OVERRIDES is
 *     byte-exact (mismatch == 0); at least 466/471 oracle lists reproduced.
 *   - ranges: kind + display bounds agree on >= 99.5% of informative rows.
 *   - DELAY model roster (paramId 6) == 27 models starting 'Digital Mono'.
 *   - cab-IR FACTORY 1/2 + LEGACY reproduce FM3_CAB_IRS exactly.
 *   - every seeded family resolves to its anchored section tag.
 *
 * `src/cache/*` stays browser-safe; this TEST may use `node:fs` to load the
 * fixture.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeviceCache, HW_SEEDS } from '../../src/cache/index.js';
import type { CacheRecord, DeviceParam } from '../../src/cache/types.js';
import { FM3_PARAMS } from '../../src/gen3/fm3/index.js';
import { assertFm3Equivalence } from './oracle.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const ASSIGN_CASE_COUNT = 5;
export const ASSIGN_LIVE_CASE_COUNT = 4;

export function runAssign(): void {
  const walkText = readFileSync(join(FIXTURES, 'fm3-12p0.walk.json'), 'utf8');
  const walk = JSON.parse(walkText) as { records: CacheRecord[] };
  const built = buildDeviceCache(walk.records, FM3_PARAMS, HW_SEEDS);

  const m = assertFm3Equivalence(built);

  console.log(
    `  cache/assign enum lists: ${m.enum.exact}/${m.enum.total} exact ` +
      `(mismatch ${m.enum.mismatch}, missing ${m.enum.missing}, non-special missing ${m.enum.badMissing})`,
  );
  console.log(`  cache/assign ranges: ${m.ranges.ok}/${m.ranges.total} agree (${m.ranges.pct.toFixed(2)}%)`);
  console.log(`  cache/assign DELAY roster: ${m.delayRoster.count} models, [0]='${m.delayRoster.first}'`);
  console.log(
    `  cache/assign cab-IR banks: FACTORY 1=${m.cabIrs.factory1}, ` +
      `FACTORY 2=${m.cabIrs.factory2}, LEGACY=${m.cabIrs.legacy} (all exact)`,
  );
  console.log(
    `  cache/assign sections: ${m.sections.mapped} families mapped, ` +
      `${built.unmappedFamilies.length} unmapped, ${built.unmappedSections.length} unmapped sections`,
  );
}

// ===========================================================================
// Live block-id-space assignment (FORGEFX-32 follow-up)
//
// A real FM3 self-describe walk keys its "sections" on the fn-0x01 BLOCK ID,
// not the editor `.cache` section tag the HW_SEEDS anchor. So no seed anchor
// tag is even present, let alone a vote winner — the assigner must fall back to
// pure vote mapping (seeds become family-EXISTENCE checks), while the cache-tag
// byte space keeps its exact seed-anchored behaviour. These cases pin BOTH
// arms with a tiny synthetic catalog + hand-built live-space records (a compact
// analogue of the 2026-07-13 rig walk: one superset section that top-scores for
// several families, one byte-identical pair that must merge to instanceTags).
// ===========================================================================

export function runAssignLive(): void {
  const fail = (msg: string): never => {
    throw new Error(`[cache/assign-live] ${msg}`);
  };

  const fl = (section: number, id: number, min: number, max: number): CacheRecord => ({
    kind: 'float', section, offset: 0, id, tc: 2, min, max, def: 0, step: 0, t1: 0, t2: 0,
  });
  const en = (section: number, id: number, values: string[]): CacheRecord => ({
    kind: 'enum', section, offset: 0, id, tc: 16, min: 0, max: values.length - 1,
    def: 0, step: 0, count: values.length, values, x: 0,
  });

  // Mini catalog: AMP + CAB are seeded to cache tags 10/11; MOD is unseeded.
  const params: DeviceParam[] = [
    { family: 'AMP', paramId: 0, name: 'AMP_TYPE', unit: 'enum' },
    { family: 'AMP', paramId: 1, name: 'AMP_GAIN', displayMin: 0, displayMax: 10 },
    { family: 'AMP', paramId: 2, name: 'AMP_MASTER', displayMin: 0, displayMax: 10 },
    { family: 'AMP', paramId: 3, name: 'AMP_LEVEL', displayMin: -80, displayMax: 20 },
    { family: 'CAB', paramId: 0, name: 'CAB_TYPE', unit: 'enum' },
    { family: 'CAB', paramId: 1, name: 'CAB_LEVEL', displayMin: -80, displayMax: 20 },
    { family: 'MOD', paramId: 0, name: 'MOD_TYPE', unit: 'enum' },
    { family: 'MOD', paramId: 1, name: 'MOD_RATE', displayMin: 0, displayMax: 20 },
  ];
  const seeds = { AMP: 10, CAB: 11 };

  // ---- Case 1: live block-id space -> vote-only mapping + pair merge --------
  // Sections are block ids (20/30/31/40); the seed tags 10/11 are ABSENT. 20 is
  // a superset (full AMP match + partial CAB/MOD); 30 and 31 are byte-identical
  // (an X/Y or channel pair) and must merge to CAB's instanceTags.
  {
    const live: CacheRecord[] = [
      en(20, 0, ['A', 'B']), fl(20, 1, 0, 10), fl(20, 2, 0, 10), fl(20, 3, -80, 20),
      en(30, 0, ['X', 'Y', 'Z']), fl(30, 1, -80, 20),
      en(31, 0, ['X', 'Y', 'Z']), fl(31, 1, -80, 20),
      en(40, 0, ['m1', 'm2']), fl(40, 1, 0, 20),
    ];
    const b = buildDeviceCache(live, params, seeds);
    if (b.rangeSections['AMP']?.sectionTag !== 20) {
      fail(`vote-only AMP -> ${b.rangeSections['AMP']?.sectionTag}, expected superset block 20 (not seed tag 10)`);
    }
    if (b.rangeSections['CAB']?.sectionTag !== 30) fail(`vote-only CAB -> ${b.rangeSections['CAB']?.sectionTag}, expected 30`);
    const inst = b.rangeSections['CAB']?.instanceTags;
    if (!inst || inst.length !== 2 || inst[0] !== 30 || inst[1] !== 31) {
      fail(`CAB pair not merged: instanceTags=${JSON.stringify(inst)} (expected [30,31])`);
    }
    if (b.rangeSections['MOD']?.sectionTag !== 40) fail(`vote-only MOD -> ${b.rangeSections['MOD']?.sectionTag}, expected 40`);
    if (b.unmappedFamilies.length !== 0) fail(`unexpected unmapped families: ${b.unmappedFamilies.join(',')}`);
  }
  console.log('  cache/assign-live: block-id space votes seeds to real blocks (AMP 20, CAB 30+31, MOD 40), no seed anchor leaks');

  // ---- Case 2: cache-tag space still seed-ANCHORS (byte path unchanged) -----
  // Same records but keyed on the seed tags 10/11: every seed anchor wins its
  // own vote, so the assigner must take the anchored path and honour the seeds.
  {
    const cache: CacheRecord[] = [
      en(10, 0, ['A', 'B']), fl(10, 1, 0, 10), fl(10, 2, 0, 10), fl(10, 3, -80, 20),
      en(11, 0, ['X', 'Y', 'Z']), fl(11, 1, -80, 20),
      en(40, 0, ['m1', 'm2']), fl(40, 1, 0, 20),
    ];
    const b = buildDeviceCache(cache, params, seeds);
    if (b.rangeSections['AMP']?.sectionTag !== 10) fail(`anchored AMP -> ${b.rangeSections['AMP']?.sectionTag}, expected seed tag 10`);
    if (b.rangeSections['CAB']?.sectionTag !== 11) fail(`anchored CAB -> ${b.rangeSections['CAB']?.sectionTag}, expected seed tag 11`);
    if (b.rangeSections['MOD']?.sectionTag !== 40) fail(`anchored MOD -> ${b.rangeSections['MOD']?.sectionTag}, expected 40`);
  }
  console.log('  cache/assign-live: cache-tag space keeps exact seed-anchored mapping (byte path unchanged)');

  // ---- Case 3: a seeded family with NO positive section throws --------------
  // CAB's paramIds (here 90/91) never appear in the live records, so its vote
  // scores nothing — the existence guard must throw rather than silently drop a
  // core block.
  {
    const cabHigh: DeviceParam[] = [
      { family: 'AMP', paramId: 0, name: 'AMP_TYPE', unit: 'enum' },
      { family: 'AMP', paramId: 1, name: 'AMP_GAIN', displayMin: 0, displayMax: 10 },
      { family: 'CAB', paramId: 90, name: 'CAB_TYPE', unit: 'enum' },
      { family: 'CAB', paramId: 91, name: 'CAB_LEVEL', displayMin: -80, displayMax: 20 },
    ];
    const live: CacheRecord[] = [en(20, 0, ['A', 'B']), fl(20, 1, 0, 10)];
    let msg = '';
    try {
      buildDeviceCache(live, cabHigh, seeds);
    } catch (e) {
      msg = (e as Error).message;
    }
    if (!/no section for seeded famil/.test(msg) || !msg.includes('CAB')) {
      fail(`expected live seed-existence throw for CAB, got: ${msg || '(no throw)'}`);
    }
  }
  console.log('  cache/assign-live: a seeded family the vote cannot place throws (existence guard)');

  // ---- Case 4: MIXED coherence (some anchors win, some absent) still throws --
  // AMP's anchor 10 is present and wins; CAB's anchor 11 is absent (CAB lives at
  // 62). That is neither a clean cache-tag space nor a clean live space — it is
  // a genuine disagreement, and must fail loudly as before.
  {
    const mixed: CacheRecord[] = [
      en(10, 0, ['A', 'B']), fl(10, 1, 0, 10), fl(10, 2, 0, 10), fl(10, 3, -80, 20),
      en(62, 0, ['X', 'Y', 'Z']), fl(62, 1, -80, 20),
    ];
    let msg = '';
    try {
      buildDeviceCache(mixed, params, seeds);
    } catch (e) {
      msg = (e as Error).message;
    }
    if (!/seed disagreement for CAB/.test(msg)) {
      fail(`expected mixed-coherence 'seed disagreement for CAB' throw, got: ${msg || '(no throw)'}`);
    }
  }
  console.log('  cache/assign-live: mixed seed coherence (one anchor absent) still throws seed disagreement');
}
