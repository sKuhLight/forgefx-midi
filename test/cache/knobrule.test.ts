/**
 * Typecode-0x52 knob rule.
 *
 * A float parameter with typecode 0x52 is a dimensionless knob that the device
 * displays on a LINEAR 0..10 scale, whatever its definition's own min/max are.
 * These cases pin the rule end to end with SYNTHETIC records only:
 *   1. a 0x52 float record derives displayMin 0 / displayMax 10 / taper 'linear' and
 *      NO unit (scale, step and typecode untouched);
 *   2. non-0x52 records are unchanged (a different typecode with the same low byte,
 *      an enum row carrying 0x52, an ordinary Hz float);
 *   3. observation beats the premise: a row with an observed unit or a measured
 *      non-linear taper is skipped by the rule entirely, a measured linear taper is
 *      kept, and a sweep without information (flat / unknown / unreliable) is not an
 *      observation;
 *   4. the editor-cache byte import and the live walk agree on the rule;
 *   5. the built profile carries the current CACHE_SCHEMA stamp;
 *   6. every shipped 0x52 float row of FM3 / FM9 / Axe-Fx III carries the rule (and no
 *      unit), the wire default of five known knobs is the LOG normalisation, and a
 *      profile built from the committed FM3 walk fixture agrees with the shipped FM3
 *      rows field for field;
 *   7. the catalog calibration lets a device-true linear taper override the
 *      catalog's log10 scaling hint (without it these knobs would lose calibration
 *      once their display range becomes 0..10);
 *   8. the FM3 descriptor maps the 0x52 knobs linearly (encode(5) = mid wire,
 *      decode(mid wire) = 5, range 0..10), like FM9 / Axe-Fx III.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCache, buildDeviceCache, CACHE_SCHEMA, HW_SEEDS } from '../../src/cache/index.js';
import { KNOB_TYPECODE } from '../../src/cache/assign.js';
import type { CacheRecord, DeviceParam } from '../../src/cache/types.js';
import { createModernCatalog, type DeviceRangeTable } from '../../src/devices/gen3/catalog.js';
import { FM3_DESCRIPTOR } from '../../src/devices/gen3/index.js';
import { AXE_FX_III_BLOCKS, AXE3_RANGES } from '../../src/gen3/axe-fx-iii/index.js';
import { FM3_PARAMS, FM3_RANGES } from '../../src/gen3/fm3/index.js';
import { FM9_RANGES } from '../../src/gen3/fm9/index.js';
import { encodeCache } from './buildprofile.test.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const KNOBRULE_CASE_COUNT = 8;

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
  ...[1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12].map((paramId) => ({ family: 'AMP', paramId, name: `AMP_P${paramId}` })),
  { family: 'AMP', paramId: 6, name: 'AMP_P6', unit: 'enum' },
];
const SEEDS = { AMP: 10 };

type Row = { kind: string; typecode: number; displayMin: number; displayMax: number; defaultRaw?: number; unit?: string; taper?: string };
type Table = Readonly<Record<string, Readonly<Record<number, Row>>>>;

export async function runKnobRule(): Promise<void> {
  const sweep = (shape: 'linear' | 'log' | 'flat' | 'unknown', reliable: boolean) =>
    ({ shape, err: reliable ? 0 : null, reliable, points: [[0, 1], [1, 10]] as const });

  const records: CacheRecord[] = [
    en(0, 0x10, ['A', 'B']),
    fl(1, KNOB_TYPECODE, 0.05, 50, 10, 0.001),
    fl(2, KNOB_TYPECODE, 0.5, 500, 10, 0.001),
    fl(3, KNOB_TYPECODE, 20, 2000, 10, 0),
    fl(4, 0x82, 20, 2000, 1, 0.1),
    fl(5, 0x152, 0, 1, 10, 0.001),
    en(6, KNOB_TYPECODE, ['X', 'Y', 'Z']),
    fl(7, KNOB_TYPECODE, 1, 20, 10, 0, { unit: 'dB' }),
    fl(8, KNOB_TYPECODE, 1, 20, 10, 0, { taper: sweep('log', true) }),
    fl(9, KNOB_TYPECODE, 1, 20, 10, 0, { taper: sweep('linear', true) }),
    fl(10, KNOB_TYPECODE, 1, 20, 10, 0, { taper: sweep('flat', false) }),
    fl(11, KNOB_TYPECODE, 1, 20, 10, 0, { taper: sweep('unknown', false) }),
    fl(12, KNOB_TYPECODE, 1, 20, 10, 0, { taper: sweep('log', false) }),
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
    if (r.taper !== 'linear') fail(`pid ${pid}: taper=${r.taper}, expected linear`);
    if (r.unit !== undefined) fail(`pid ${pid}: a knob row must not carry a unit token, got ${JSON.stringify(r.unit)}`);
    if (r.taperPoints !== undefined) fail(`pid ${pid}: linear rule row must not carry taperPoints`);
    if (r.scale !== 10 || r.step !== step || r.typecode !== KNOB_TYPECODE) {
      fail(`pid ${pid}: scale/step/typecode touched (${r.scale}/${r.step}/0x${r.typecode.toString(16)})`);
    }
  }
  console.log('  cache/knobrule: typecode 0x52 floats (0.05..50, 0.5..500, 20..2000) derive display 0..10, linear, no unit');

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

  // ---- Case 3: observation beats the premise --------------------------------
  {
    // An observed unit or a measured non-linear taper: the rule is skipped for the row entirely
    // (derived as an ordinary float: (min, max) * scale = 10..200), nothing is half-applied.
    const seen = amp[7]!;
    if (seen.displayMin !== 10 || seen.displayMax !== 200 || seen.unit !== 'dB' || seen.taper !== undefined) {
      fail(`observed-unit row must skip the rule: ${JSON.stringify(seen)}`);
    }
    const log = amp[8]!;
    if (log.displayMin !== 10 || log.displayMax !== 200 || log.taper !== 'log' || log.unit !== undefined) {
      fail(`measured-log row must skip the rule: ${JSON.stringify(log)}`);
    }
    // A measured LINEAR taper is consistent with the premise: the rule applies, the measurement is kept.
    const lin = amp[9]!;
    if (lin.displayMin !== 0 || lin.displayMax !== 10 || lin.taper !== 'linear' || lin.unit !== undefined) {
      fail(`measured-linear row: ${JSON.stringify(lin)}`);
    }
    // Sweeps without information (flat, unknown, or an unreliable fit of any shape) are not observations.
    for (const pid of [10, 11, 12]) {
      const r = amp[pid]!;
      if (r.displayMin !== 0 || r.displayMax !== 10 || r.taper !== 'linear' || r.unit !== undefined) {
        fail(`pid ${pid}: an uninformative sweep must not block the rule: ${JSON.stringify(r)}`);
      }
    }
  }
  console.log('  cache/knobrule: an observed unit or non-linear taper skips the rule whole; linear / uninformative sweeps do not');

  // ---- Case 4: byte import and live walk agree -----------------------------
  const plain = records.filter((r) => !(r.kind === 'float' && (r.unit !== undefined || r.taper !== undefined)));
  const fromBytes = await buildCache({ kind: 'bytes', buf: encodeCache(plain) }, PARAMS, SEEDS);
  const fromLive = await buildCache({ kind: 'live', walk: async () => plain }, PARAMS, SEEDS);
  if (JSON.stringify(fromBytes.ranges) !== JSON.stringify(fromLive.ranges)) fail('bytes and live ranges diverge');
  const b2 = fromBytes.ranges['AMP']![2]!;
  if (b2.displayMin !== 0 || b2.displayMax !== 10 || b2.taper !== 'linear' || b2.unit !== undefined) {
    fail(`byte-imported 0x52 row: ${JSON.stringify(b2)}`);
  }
  console.log('  cache/knobrule: editor-cache byte import and live walk derive the same knob rows');

  // ---- Case 5: schema stamp -------------------------------------------------
  if (!Number.isInteger(CACHE_SCHEMA) || CACHE_SCHEMA < 1) fail(`CACHE_SCHEMA is ${CACHE_SCHEMA}`);
  if (fromBytes.meta.schema !== CACHE_SCHEMA || fromLive.meta.schema !== CACHE_SCHEMA) {
    fail(`built meta.schema ${fromBytes.meta.schema}/${fromLive.meta.schema}, expected ${CACHE_SCHEMA}`);
  }
  console.log(`  cache/knobrule: CACHE_SCHEMA ${CACHE_SCHEMA} stamped on bytes and live builds`);

  // ---- Case 6: shipped rows carry the rule; defaults are log; a fresh FM3 build agrees
  const byDev: Record<string, Table> = {
    FM3: FM3_RANGES as unknown as Table,
    FM9: FM9_RANGES as unknown as Table,
    AXE3: AXE3_RANGES as unknown as Table,
  };
  for (const [dev, table] of Object.entries(byDev)) {
    let knobs = 0;
    for (const [fam, rows] of Object.entries(table)) {
      for (const [pid, r] of Object.entries(rows)) {
        if (r.typecode === KNOB_TYPECODE && r.kind === 'float') {
          knobs += 1;
          if (r.displayMin !== 0 || r.displayMax !== 10 || r.taper !== 'linear' || r.unit !== undefined) {
            fail(`${dev} ${fam}.${pid}: shipped 0x52 row is ${r.displayMin}..${r.displayMax} unit=${r.unit} taper=${r.taper}`);
          }
        } else if (r.unit === 'knob_0_10') {
          fail(`${dev} ${fam}.${pid}: a knob_0_10 unit token leaked into the range tables`);
        }
      }
    }
    if (knobs === 0) fail(`${dev}: no typecode-0x52 rows found`);
  }
  // Known parameters (device-specific paramIds): amp Clarity, wah Drive, fuzz Slew.
  for (const [dev, fam, pid] of [
    ['FM3', 'DISTORT', 72], ['FM9', 'DISTORT', 76], ['AXE3', 'DISTORT', 70],
    ['FM3', 'WAH', 10], ['FM3', 'FUZZ', 6],
  ] as const) {
    const r = byDev[dev]?.[fam]?.[pid];
    if (!r || r.typecode !== KNOB_TYPECODE || r.displayMax !== 10 || r.displayMin !== 0) fail(`${dev} ${fam}.${pid}: ${JSON.stringify(r)}`);
  }
  // The wire position of a 0x52 knob is log-normalised between the definition's min and max, so the
  // stored default is 65534 * ln(def/min) / ln(max/min) (0 when def <= min), not the linear fraction.
  // Pinned for five knobs whose definition (min, max, default) sits strictly inside its range:
  //   Delay Q (0.2..20, def 0.5) 13039, Amp Power-Amp Hardness (0.25..4, def 1) 32767,
  //   Reverb Drive (0.01..1, def 0.033) 16990, Filter EV Freq 39196 and Filter Sens 32767.
  const PINNED: Record<string, ReadonlyArray<readonly [string, number, number]>> = {
    FM3: [['DELAY', 58, 13039], ['DISTORT', 90, 32767], ['REVERB', 32, 16990], ['FILTER', 25, 39196], ['FILTER', 28, 32767]],
    FM9: [['DELAY', 62, 13039], ['DISTORT', 94, 32767], ['REVERB', 36, 16990], ['FILTER', 25, 39196], ['FILTER', 28, 32767]],
    AXE3: [['DELAY', 58, 13039], ['DISTORT', 88, 32767], ['REVERB', 32, 16990], ['FILTER', 25, 39196], ['FILTER', 28, 32767]],
  };
  for (const [dev, pins] of Object.entries(PINNED)) {
    for (const [fam, pid, want] of pins) {
      const r = byDev[dev]?.[fam]?.[pid];
      if (!r || r.typecode !== KNOB_TYPECODE || r.defaultRaw !== want) {
        fail(`${dev} ${fam}.${pid}: defaultRaw ${r?.defaultRaw}, expected ${want} (log normalisation of the definition default)`);
      }
    }
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
  console.log(`  cache/knobrule: shipped 0x52 rows carry the rule with no unit and log defaults (15 pinned); ${agreed} fresh FM3 rows match exactly`);

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

  // ---- Case 8: the FM3 descriptor maps the 0x52 knobs linearly ----------------
  {
    // Chorus / Rotary Drive carried the AM4's log 0.5..500 hint (encode(5) = 21845, decode(mid) = 15.81)
    // and Amp Clarity / Flanger / Wah Drive passed the raw wire through before FM3 wired its knob rows.
    for (const [slug, key] of [
      ['chorus', 'drive'], ['rotary', 'drive'], ['amp', 'clarity'], ['flanger', 'drive'],
      ['wah', 'drive'], ['reverb', 'drive'], ['delay', 'drive'], ['cab', 'drive'],
    ] as const) {
      const s = FM3_DESCRIPTOR.blocks[slug]?.params[key];
      if (!s) { fail(`FM3 ${slug}.${key} is missing from the descriptor`); continue; }
      if (s.display_min !== 0 || s.display_max !== 10) fail(`FM3 ${slug}.${key}: schema range ${s.display_min}..${s.display_max}, expected 0..10`);
      const e5 = s.encode(5);
      const d = Number(s.decode(32767));
      if (Math.abs(e5 - 32767) > 1 || Math.abs(d - 5) > 0.01) {
        fail(`FM3 ${slug}.${key}: encode(5)=${e5}, decode(32767)=${d}, expected 32767 / 5`);
      }
      if (Math.abs(Number(s.decode(0))) > 0.01 || Math.abs(Number(s.decode(65534)) - 10) > 0.01) {
        fail(`FM3 ${slug}.${key}: decode(0)=${s.decode(0)} decode(65534)=${s.decode(65534)}, expected 0 / 10`);
      }
    }
  }
  console.log('  cache/knobrule: FM3 descriptor maps the 0x52 knobs linearly (encode(5) = mid wire, decode(mid) = 5)');
}
