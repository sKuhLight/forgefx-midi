/**
 * Typecode-0x52 knob rule.
 *
 * A float parameter with typecode 0x52 is a dimensionless knob that the device
 * displays on a LINEAR 0..10 scale, whatever its definition's own min/max are.
 * These cases pin the rule end to end with SYNTHETIC records only:
 *   1. a 0x52 float record derives displayMin 0 / displayMax 10 / taper 'linear' /
 *      unit 'knob_0_10' (scale, step and typecode untouched);
 *   2. non-0x52 records are unchanged (a different typecode with the same low byte,
 *      an enum row carrying 0x52, an ordinary Hz float);
 *   3. an observed unit and a reliably measured taper win over the rule's defaults,
 *      an unreliable taper does not;
 *   4. the editor-cache byte import and the live walk agree on the rule;
 *   5. CACHE_SCHEMA is 2, so profiles built under the old derivation are rebuilt;
 *   6. every shipped 0x52 float row of FM3 / FM9 / Axe-Fx III carries the rule, and a
 *      profile built from the committed FM3 walk fixture agrees with the shipped
 *      FM3 rows field for field;
 *   7. the catalog calibration lets a device-true linear taper override the
 *      catalog's log10 scaling hint (without it these knobs would lose calibration
 *      once their display range becomes 0..10).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCache, buildDeviceCache, CACHE_SCHEMA, HW_SEEDS } from '../../src/cache/index.js';
import { KNOB_TYPECODE, KNOB_UNIT } from '../../src/cache/assign.js';
import type { CacheRecord, DeviceParam } from '../../src/cache/types.js';
import { createModernCatalog, type DeviceRangeTable } from '../../src/devices/gen3/catalog.js';
import { AXE_FX_III_BLOCKS, AXE3_RANGES } from '../../src/gen3/axe-fx-iii/index.js';
import { FM3_PARAMS, FM3_RANGES } from '../../src/gen3/fm3/index.js';
import { FM9_RANGES } from '../../src/gen3/fm9/index.js';
import { encodeCache } from './buildprofile.test.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const KNOBRULE_CASE_COUNT = 7;

const fail = (msg: string): never => {
  throw new Error(`[cache/knobrule] ${msg}`);
};

const fl = (id: number, tc: number, min: number, max: number, def: number, step: number, extra: Partial<CacheRecord> = {}): CacheRecord =>
  ({ kind: 'float', section: 10, offset: 0, id, tc, min, max, def, step, t1: 0, t2: 0, ...extra }) as CacheRecord;
const en = (id: number, tc: number, values: string[]): CacheRecord => ({
  kind: 'enum', section: 10, offset: 0, id, tc, min: 0, max: values.length - 1,
  def: 0, step: 0, count: values.length, values, x: 0,
});

// One family 'AMP' seeded to section 10; the catalog only needs kinds to vote.
const PARAMS: DeviceParam[] = [
  { family: 'AMP', paramId: 0, name: 'AMP_TYPE', unit: 'enum' },
  ...[1, 2, 3, 4, 5, 7, 8].map((paramId) => ({ family: 'AMP', paramId, name: `AMP_P${paramId}` })),
  { family: 'AMP', paramId: 6, name: 'AMP_P6', unit: 'enum' },
];
const SEEDS = { AMP: 10 };

export async function runKnobRule(): Promise<void> {
  const taper = (shape: 'linear' | 'log' | 'flat', reliable: boolean) =>
    ({ shape, err: reliable ? 0 : null, reliable, points: [[0, 1], [1, 10]] as const });

  const records: CacheRecord[] = [
    en(0, 0x10, ['A', 'B']),
    fl(1, KNOB_TYPECODE, 0.05, 50, 10, 0.001),
    fl(2, KNOB_TYPECODE, 0.5, 500, 10, 0.001),
    fl(3, KNOB_TYPECODE, 20, 2000, 10, 0),
    fl(4, 0x82, 20, 2000, 1, 0.1),
    fl(5, 0x152, 0, 1, 10, 0.001),
    en(6, KNOB_TYPECODE, ['X', 'Y', 'Z']),
    fl(7, KNOB_TYPECODE, 1, 20, 10, 0, { unit: 'dB', taper: taper('log', true) }),
    fl(8, KNOB_TYPECODE, 1, 20, 10, 0, { taper: taper('flat', false) }),
  ];

  // ---- Case 1: a 0x52 float record derives the linear 0..10 knob ------------
  const built = buildDeviceCache(records, PARAMS, SEEDS);
  const amp = built.ranges['AMP'];
  if (!amp) return fail('AMP family was not assigned');
  for (const [pid, step, min, max] of [[1, 0.001, 0.05, 50], [2, 0.001, 0.5, 500], [3, 0, 20, 2000]] as const) {
    const r = amp[pid]!;
    if (r.kind !== 'float' || r.displayMin !== 0 || r.displayMax !== 10) {
      fail(`pid ${pid} (definition ${min}..${max}): display ${r.displayMin}..${r.displayMax}, expected 0..10`);
    }
    if (r.taper !== 'linear' || r.unit !== KNOB_UNIT || r.unit !== 'knob_0_10') {
      fail(`pid ${pid}: taper=${r.taper} unit=${r.unit}, expected linear / knob_0_10`);
    }
    if (r.taperPoints !== undefined) fail(`pid ${pid}: linear rule row must not carry taperPoints`);
    if (r.scale !== 10 || r.step !== step || r.typecode !== KNOB_TYPECODE) {
      fail(`pid ${pid}: scale/step/typecode touched (${r.scale}/${r.step}/0x${r.typecode.toString(16)})`);
    }
  }
  console.log('  cache/knobrule: typecode 0x52 floats (0.05..50, 0.5..500, 20..2000) derive display 0..10, linear, knob_0_10');

  // ---- Case 2: non-0x52 records are unchanged ------------------------------
  {
    const hz = amp[4]!;
    if (hz.displayMin !== 20 || hz.displayMax !== 2000 || hz.unit !== undefined || hz.taper !== undefined) {
      fail(`ordinary float changed: ${JSON.stringify(hz)}`);
    }
    const other = amp[5]!; // typecode 0x152 shares only the low byte with 0x52
    if (other.displayMin !== 0 || other.displayMax !== 10 || other.unit !== undefined || other.taper !== undefined) {
      fail(`0x152 float must keep the plain (min,max)*scale derivation without unit/taper: ${JSON.stringify(other)}`);
    }
    const e = amp[6]!;
    if (e.kind !== 'enum' || e.unit !== undefined || e.taper !== undefined || e.enumCount !== 3) {
      fail(`enum row carrying typecode 0x52 must stay untouched: ${JSON.stringify(e)}`);
    }
  }
  console.log('  cache/knobrule: ordinary floats, a 0x152 float and a 0x52-typed enum row are unchanged');

  // ---- Case 3: observation beats the rule's defaults -----------------------
  {
    const seen = amp[7]!;
    if (seen.displayMin !== 0 || seen.displayMax !== 10) fail(`observed-unit row display ${seen.displayMin}..${seen.displayMax}`);
    if (seen.unit !== 'dB' || seen.taper !== 'log') fail(`observed unit/taper replaced: unit=${seen.unit} taper=${seen.taper}`);
    const flat = amp[8]!;
    if (flat.taper !== 'linear' || flat.unit !== 'knob_0_10') {
      fail(`unreliable taper must not block the rule: taper=${flat.taper} unit=${flat.unit}`);
    }
  }
  console.log('  cache/knobrule: an observed unit and a reliable measured taper win; an unreliable taper does not');

  // ---- Case 4: byte import and live walk agree -----------------------------
  const plain = records.filter((r) => !(r.kind === 'float' && (r.unit !== undefined || r.taper !== undefined)));
  const fromBytes = await buildCache({ kind: 'bytes', buf: encodeCache(plain) }, PARAMS, SEEDS);
  const fromLive = await buildCache({ kind: 'live', walk: async () => plain }, PARAMS, SEEDS);
  if (JSON.stringify(fromBytes.ranges) !== JSON.stringify(fromLive.ranges)) fail('bytes and live ranges diverge');
  const b2 = fromBytes.ranges['AMP']![2]!;
  if (b2.displayMin !== 0 || b2.displayMax !== 10 || b2.taper !== 'linear' || b2.unit !== 'knob_0_10') {
    fail(`byte-imported 0x52 row: ${JSON.stringify(b2)}`);
  }
  console.log('  cache/knobrule: editor-cache byte import and live walk derive the same knob rows');

  // ---- Case 5: schema ------------------------------------------------------
  if (CACHE_SCHEMA !== 2) fail(`CACHE_SCHEMA is ${CACHE_SCHEMA}, expected 2`);
  if (fromBytes.meta.schema !== 2 || fromLive.meta.schema !== 2) {
    fail(`built meta.schema ${fromBytes.meta.schema}/${fromLive.meta.schema}, expected 2`);
  }
  console.log('  cache/knobrule: CACHE_SCHEMA 2 stamped on bytes and live builds');

  // ---- Case 6: shipped rows carry the rule; a fresh FM3 build agrees -------
  type Row = { kind: string; typecode: number; displayMin: number; displayMax: number; unit?: string; taper?: string };
  type Table = Readonly<Record<string, Readonly<Record<number, Row>>>>;
  const shipped: Array<[string, Table]> = [
    ['FM3', FM3_RANGES as unknown as Table],
    ['FM9', FM9_RANGES as unknown as Table],
    ['AXE3', AXE3_RANGES as unknown as Table],
  ];
  for (const [dev, table] of shipped) {
    let knobs = 0;
    for (const [fam, rows] of Object.entries(table)) {
      for (const [pid, r] of Object.entries(rows)) {
        if (r.typecode === KNOB_TYPECODE && r.kind === 'float') {
          knobs += 1;
          if (r.displayMin !== 0 || r.displayMax !== 10 || r.unit !== 'knob_0_10' || r.taper !== 'linear') {
            fail(`${dev} ${fam}.${pid}: shipped 0x52 row is ${r.displayMin}..${r.displayMax} unit=${r.unit} taper=${r.taper}`);
          }
        } else if (r.unit === 'knob_0_10') {
          fail(`${dev} ${fam}.${pid}: knob_0_10 on a non-0x52 row (typecode 0x${r.typecode.toString(16)})`);
        }
      }
    }
    if (knobs === 0) fail(`${dev}: no typecode-0x52 rows found`);
  }
  // Known parameters (device-specific paramIds): amp Clarity, wah Drive, fuzz Slew.
  const byDev = Object.fromEntries(shipped) as Record<string, Table>;
  for (const [dev, fam, pid] of [
    ['FM3', 'DISTORT', 72], ['FM9', 'DISTORT', 76], ['AXE3', 'DISTORT', 70],
    ['FM3', 'WAH', 10], ['FM3', 'FUZZ', 6],
  ] as const) {
    const r = byDev[dev]?.[fam]?.[pid];
    if (!r || r.typecode !== KNOB_TYPECODE || r.displayMax !== 10 || r.displayMin !== 0) fail(`${dev} ${fam}.${pid}: ${JSON.stringify(r)}`);
  }
  const walk = JSON.parse(readFileSync(join(FIXTURES, 'fm3-12p0.walk.json'), 'utf8')) as { records: CacheRecord[] };
  const fresh = await buildCache({ kind: 'live', walk: async () => walk.records }, FM3_PARAMS, HW_SEEDS, { model: 0x11 });
  let agreed = 0;
  for (const [fam, rows] of Object.entries(byDev['FM3']!)) {
    for (const [pid, r] of Object.entries(rows)) {
      if (r.typecode !== KNOB_TYPECODE || r.kind !== 'float') continue;
      const g = fresh.ranges[fam]?.[Number(pid)];
      if (!g || g.displayMin !== r.displayMin || g.displayMax !== r.displayMax || g.unit !== r.unit || g.taper !== r.taper) {
        fail(`fresh FM3 build ${fam}.${pid} disagrees with the shipped row: ${JSON.stringify(g)} vs ${JSON.stringify(r)}`);
      }
      agreed += 1;
    }
  }
  if (agreed === 0) fail('no FM3 knob row was compared');
  console.log(`  cache/knobrule: shipped FM3/FM9/Axe-Fx III 0x52 rows carry the rule; ${agreed} fresh FM3 rows match the shipped ones exactly`);

  // ---- Case 7: a device-true linear taper overrides the catalog's log10 hint
  {
    const params = {
      DISTORT: [{ family: 'DISTORT', paramId: 1, name: 'DISTORT_CLARITY', displayLabel: 'Clarity', unit: 'knob_0_10', displayMin: 0, displayMax: 10, scaling: 'log10' }],
    } as never;
    const schemaFor = (row: object) => {
      const ranges = { DISTORT: { 1: { kind: 'float', ...row } } } as unknown as DeviceRangeTable;
      const c = createModernCatalog({ blocks: AXE_FX_III_BLOCKS, paramsByFamily: params, resolveEffectId: () => 58, deviceRanges: ranges });
      return c.blocks['amp']!.params['clarity']!;
    };
    const lin = schemaFor({ displayMin: 0, displayMax: 10, taper: 'linear' });
    if (lin.display_min !== 0 || lin.display_max !== 10) fail(`schema range ${lin.display_min}..${lin.display_max}`);
    if (Math.abs(lin.encode(5) - 32767) > 1 || Math.abs(Number(lin.decode(32767)) - 5) > 0.01) {
      fail(`linear-taper knob: encode(5)=${lin.encode(5)} decode(32767)=${lin.decode(32767)}, expected a linear 0..10 mapping`);
    }
    const log = schemaFor({ displayMin: 0.1, displayMax: 10, taper: 'log' });
    if (Math.abs(log.encode(5) - 55670) > 2) fail(`log-taper row lost its log10 mapping: encode(5)=${log.encode(5)}`);
    const hint = schemaFor({ displayMin: 0.1, displayMax: 10 });
    if (Math.abs(hint.encode(5) - 55670) > 2) fail(`row without a taper must keep the catalog's log10 hint: encode(5)=${hint.encode(5)}`);
  }
  console.log('  cache/knobrule: device-true linear taper beats the log10 hint; log and untapered rows keep it');
}
