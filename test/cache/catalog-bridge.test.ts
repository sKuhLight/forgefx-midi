/**
 * Catalog-vs-profile bridge for the FM3 firmware 12.0 tables.
 *
 * The shipped FM3 catalog (`FM3_RANGES`, `FM3_ENUM_OVERRIDES`, `FM3_RANGE_SECTIONS`) is
 * derived from the firmware 12.0 editor data. This suite compares it with the profile
 * `buildCache` derives from the committed firmware 12.0 walk fixture and pins exactly what
 * agrees and what does not:
 *   1. the same families, the same row layout (every pid, placeholders included), the same
 *      strides and section tags;
 *   2. the same set of informative pids in every family (PRESET included);
 *   3. identical row shapes: with the label lists left out, all 1716 informative rows have
 *      the same fingerprint;
 *   4. with the label lists, fingerprint agreement is >= 99% excluding PRESET (1654 of
 *      1666), and the residue is pinned exactly: 12 enum rows whose label list the catalog
 *      does not carry (they differ in that and nothing else, and count as compatible);
 *   5. PRESET is excluded from (4) for the same reason: the catalog carries no PRESET
 *      label lists at all, while the walk-built rows do (all 50 informative PRESET rows are
 *      enums and count as compatible);
 *   6. the cross-check finds no suspect family when the built profile is checked against
 *      the catalog. The profile differs from the catalog in labels (PRESET and the residue
 *      families), so this is not the trivial identical-tables case.
 *
 * This TEST may use `node:fs`; `src/cache/*` stays browser-safe.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HW_SEEDS,
  buildCache,
  familyAssignmentSuspects,
  isInformativeRow,
  paramFingerprint,
  rowsCompatible,
} from '../../src/cache/index.js';
import type { BuiltCache } from '../../src/cache/index.js';
import type { CacheRecord } from '../../src/cache/types.js';
import { FM3_ENUM_OVERRIDES, FM3_PARAMS, FM3_RANGES, FM3_RANGE_SECTIONS } from '../../src/gen3/fm3/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const CATALOG_BRIDGE_CASE_COUNT = 6;

/**
 * Informative rows (outside PRESET) whose fingerprint differs between the catalog and the
 * walk-built profile. All are enum rows whose label list the catalog does not carry.
 */
const RESIDUE = [
  'FDBKRET:3',
  'FORMANT:0',
  'FORMANT:1',
  'FORMANT:2',
  'FORMANT:9',
  'FORMANT:11',
  'MIXER:14',
  'MIXER:15',
  'MULTIPLEXER:0',
  'MULTIPLEXER:1',
  'MULTIPLEXER:4',
  'MULTIPLEXER:6',
];

const fail = (msg: string): never => {
  throw new Error(`[cache/catalog-bridge] ${msg}`);
};

function eq<T>(got: T, want: T, what: string): void {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

const pidsOf = (rows: Readonly<Record<number, unknown>>): number[] =>
  Object.keys(rows)
    .map(Number)
    .sort((a, b) => a - b);

const informativePids = (rows: Readonly<Record<number, Parameters<typeof isInformativeRow>[0]>>): number[] =>
  pidsOf(rows).filter((pid) => isInformativeRow(rows[pid]));

export async function runCatalogBridge(): Promise<void> {
  let ran = 0;

  const walk = JSON.parse(readFileSync(join(FIXTURES, 'fm3-12p0.walk.json'), 'utf8')) as { records: CacheRecord[] };
  const built: BuiltCache = await buildCache({ kind: 'live', walk: async () => walk.records }, [...FM3_PARAMS], HW_SEEDS, {
    model: 0x11,
    firmware: '12.0',
  });
  const families = Object.keys(FM3_RANGES).sort();

  // ---- Case 1: families and row layout --------------------------------------
  eq(Object.keys(built.ranges).sort(), families, 'family set');
  eq(families.length, 39, 'family count');
  for (const family of families) {
    eq(pidsOf(built.ranges[family]), pidsOf(FM3_RANGES[family]), `${family} row pids (placeholders included)`);
    eq(built.rangeSections[family].stride, FM3_RANGE_SECTIONS[family].stride, `${family} stride`);
    eq(built.rangeSections[family].sectionTag, FM3_RANGE_SECTIONS[family].sectionTag, `${family} section tag`);
  }
  ran += 1;

  // ---- Case 2: the same informative pids per family -------------------------
  let informative = 0;
  for (const family of families) {
    const want = informativePids(FM3_RANGES[family]);
    eq(informativePids(built.ranges[family]), want, `${family} informative pid set`);
    informative += want.length;
  }
  eq(informative, 1716, 'informative rows across all families');
  ran += 1;

  // ---- Case 3: identical row shapes -----------------------------------------
  for (const family of families) {
    for (const pid of informativePids(FM3_RANGES[family])) {
      const a = paramFingerprint(FM3_RANGES[family][pid]);
      const b = paramFingerprint(built.ranges[family][pid]);
      if (a !== b) fail(`${family}:${pid} row shape differs between catalog and walk-built profile`);
    }
  }
  ran += 1;

  // ---- Case 4: fingerprint agreement with labels, residue pinned -------------
  let total = 0;
  let agree = 0;
  const residue: string[] = [];
  for (const family of families) {
    if (family === 'PRESET') continue;
    for (const pid of informativePids(FM3_RANGES[family])) {
      total += 1;
      const catalogLabels = FM3_ENUM_OVERRIDES[family]?.[String(pid)];
      const builtLabels = built.enumOverrides[family]?.[String(pid)];
      if (paramFingerprint(FM3_RANGES[family][pid], catalogLabels) === paramFingerprint(built.ranges[family][pid], builtLabels)) {
        agree += 1;
        continue;
      }
      residue.push(`${family}:${pid}`);
      // The residue is a label-list difference and nothing else: the catalog has no list, the
      // walk-built row has one, and the rows count as compatible.
      if (catalogLabels !== undefined) fail(`${family}:${pid} residue row unexpectedly has catalog labels`);
      if (builtLabels === undefined || builtLabels.length === 0) fail(`${family}:${pid} residue row has no walk-built labels`);
      if (!rowsCompatible(FM3_RANGES[family][pid], catalogLabels, built.ranges[family][pid], builtLabels)) {
        fail(`${family}:${pid} residue row is not compatible`);
      }
    }
  }
  eq(total, 1666, 'informative rows excluding PRESET');
  eq(residue, RESIDUE, 'fingerprint residue');
  eq(agree, 1654, 'agreeing rows excluding PRESET');
  if (agree / total < 0.99) fail(`fingerprint agreement ${(100 * agree) / total}% is below 99%`);
  ran += 1;

  // ---- Case 5: PRESET --------------------------------------------------------
  // The catalog has no PRESET label lists; the walk-built PRESET enum rows have them. The rows
  // themselves agree (case 3), and every PRESET row counts as compatible.
  eq(FM3_ENUM_OVERRIDES.PRESET, undefined, 'catalog PRESET label lists');
  const presetPids = informativePids(FM3_RANGES.PRESET);
  eq(presetPids.length, 50, 'PRESET informative row count');
  for (const pid of presetPids) {
    const row = FM3_RANGES.PRESET[pid];
    if (row.kind !== 'enum') fail(`PRESET:${pid} is not an enum row`);
    const builtLabels = built.enumOverrides.PRESET?.[String(pid)];
    if (builtLabels === undefined || builtLabels.length === 0) fail(`PRESET:${pid} has no walk-built labels`);
    if (!rowsCompatible(row, undefined, built.ranges.PRESET[pid], builtLabels)) fail(`PRESET:${pid} not compatible`);
  }
  ran += 1;

  // ---- Case 6: no assignment suspects ----------------------------------------
  eq(
    familyAssignmentSuspects(built, { ranges: FM3_RANGES, enumOverrides: FM3_ENUM_OVERRIDES }),
    [],
    'cross-check of the walk-built profile against the catalog',
  );
  ran += 1;

  if (ran !== CATALOG_BRIDGE_CASE_COUNT) fail(`ran ${ran} cases, CATALOG_BRIDGE_CASE_COUNT is ${CATALOG_BRIDGE_CASE_COUNT}`);
  console.log(
    `  cache/catalog-bridge: ${families.length} families, ${informative} informative rows, ` +
      `fp agreement ${agree}/${total} excluding PRESET (residue ${residue.length})`,
  );
}
