/**
 * Row predicates, parameter fingerprint and assignment cross-check goldens.
 *
 * Covers `src/cache/fingerprint.ts` with SYNTHETIC rows plus the committed FM3 / FM9 /
 * Axe-Fx III catalogs (no fixture files):
 *   1. `labelsHash`: published FNV-1a 32 vectors, UTF-8 bytes, trailing-space trim, order.
 *   2. Golden fingerprints for 6 fixed rows (pins the canonical string and the hash).
 *   3. f32-neighbour normalisation: one-ULP neighbours of a value fingerprint alike.
 *   4. Per-field sensitivity, and the fields that are deliberately ignored.
 *   5. Row predicates on synthetic rows.
 *   6. Catalog counts: FM3 1831 rows = 107 placeholder + 8 degenerate + 1716 informative
 *      (FM9 and Axe-Fx III pinned too).
 *   7. Typecode 0xE0 <=> the `_BYPASS` parameters (FM3 34, FM9 35, Axe-Fx III 39).
 *   8. `enumOrdinalBounds`: PHASER_ORDER, DELAY_SVFTYPE, CABINET_MODE, no-count rows, and
 *      the 29 FM3 enum rows whose first ordinal is not 0.
 *   9. `rowsCompatible` decision table.
 *  10. `familyAssignmentSuspects`: a MIXER/OUTPUT swap on the FM3 catalog flags both, a
 *      one-sided steal flags the thief, the thresholds are honoured at their exact boundary
 *      (floor, margin, minRows) and the guards behave. Identical tables flag nothing, but
 *      that is a sanity check only (every own share is 1.0, so it cannot fail); the
 *      false-positive evidence is the walk-built profile in `catalog-bridge.test.ts`.
 */
import {
  BYPASS_TYPECODE,
  FINGERPRINT_VERSION,
  enumOrdinalBounds,
  familyAssignmentSuspects,
  isInformativeRow,
  isPlaceholderRow,
  labelsHash,
  paramFingerprint,
  rowsCompatible,
} from '../../src/cache/index.js';
import type { FamilyTables } from '../../src/cache/index.js';
import type { RangeDef } from '../../src/cache/types.js';
import { AXE3_ENUM_OVERRIDES, AXE3_RANGES, PARAMS as AXE3_PARAMS } from '../../src/gen3/axe-fx-iii/index.js';
import { FM3_ENUM_OVERRIDES, FM3_PARAMS, FM3_RANGES } from '../../src/gen3/fm3/index.js';
import { FM9_ENUM_OVERRIDES, FM9_PARAMS, FM9_RANGES } from '../../src/gen3/fm9/index.js';

export const FINGERPRINT_CASE_COUNT = 10;

const fail = (msg: string): never => {
  throw new Error(`[cache/fingerprint] ${msg}`);
};

function eq<T>(got: T, want: T, what: string): void {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

type Tables = FamilyTables;
type FpRow = Parameters<typeof paramFingerprint>[0];

const flt = (typecode: number, displayMin: number, displayMax: number, step = 0, scale = 1): RangeDef => ({
  kind: 'float',
  typecode,
  displayMin,
  displayMax,
  step,
  scale,
});
const enm = (displayMin: number, displayMax: number, enumCount: number, scale = 1, step = 0): RangeDef => ({
  kind: 'enum',
  typecode: 0x10,
  displayMin,
  displayMax,
  step,
  scale,
  enumCount,
});

export function runFingerprint(): void {
  let ran = 0;

  // ---- Case 1: labelsHash ---------------------------------------------------
  // Published FNV-1a 32 test vectors ("", "a", "foobar") through the single-label path.
  eq(labelsHash([]), '811c9dc5', 'labelsHash([]) = FNV offset basis');
  eq(labelsHash(['a']), 'e40c292c', "labelsHash(['a'])");
  eq(labelsHash(['foobar']), 'bf9cf968', "labelsHash(['foobar'])");
  // UTF-8 bytes, not UTF-16 code units: 'é' is C3 A9.
  eq(labelsHash(['é']), '1e9de8c1', "labelsHash(['é']) hashes the UTF-8 bytes");
  // Labels are joined with U+0001, so the boundary between labels is part of the hash.
  if (labelsHash(['A', 'B']) === labelsHash(['AB'])) fail('label boundary must change the hash');
  // Order matters.
  if (labelsHash(['A', 'B']) === labelsHash(['B', 'A'])) fail('label order must change the hash');
  // Trailing whitespace of a label is ignored; leading and inner whitespace are not.
  eq(labelsHash(['A  ', 'B ']), labelsHash(['A', 'B']), 'trailing spaces ignored');
  if (labelsHash([' A', 'B']) === labelsHash(['A', 'B'])) fail('leading space must change the hash');
  if (labelsHash(['A B']) === labelsHash(['AB'])) fail('inner space must change the hash');
  if (!/^[0-9a-f]{8}$/.test(labelsHash(['x']))) fail('labelsHash must be 8 lowercase hex digits');
  ran += 1;

  // ---- Case 2: golden fingerprints (6 fixed rows) ---------------------------
  eq(FINGERPRINT_VERSION, 1, 'FINGERPRINT_VERSION');
  const goldens: Array<{ name: string; row: FpRow; labels?: readonly string[]; fp: string }> = [
    // float|50|0|10|0.001||
    { name: 'float knob', row: flt(0x32, 0, 10, 0.001), fp: '1:b8c6bac6' },
    // float|82|0|10|0||
    { name: 'dimensionless knob (tc 0x52)', row: flt(0x52, 0, 10, 0), fp: '1:a126f386' },
    // float|49|-12|12|0.1||
    { name: 'bipolar float', row: flt(0x31, -12, 12, 0.1), fp: '1:b2a123a2' },
    // enum|16|0|2||3|<labelsHash(LOW,MID,HIGH)>
    { name: 'enum with labels', row: enm(0, 2, 3, 1, 1), labels: ['LOW', 'MID', 'HIGH'], fp: '1:947cba5a' },
    // enum|16|1|3||3|
    { name: 'enum without labels', row: enm(1, 3, 3), fp: '1:1d0a65c6' },
    // float|208|0|1|0||<labelsHash(OFF,ON)>
    { name: 'float with labels', row: flt(0xd0, 0, 1, 0), labels: ['OFF', 'ON'], fp: '1:311d94f5' },
  ];
  for (const g of goldens) eq(paramFingerprint(g.row, g.labels), g.fp, `golden '${g.name}'`);
  for (const g of goldens) {
    if (!/^1:[0-9a-f]{8}$/.test(paramFingerprint(g.row, g.labels))) fail(`'${g.name}' fingerprint format`);
  }
  ran += 1;

  // ---- Case 3: f32-neighbour normalisation ----------------------------------
  // A value and its f32 neighbours (one and two ULPs either side) fingerprint alike: the
  // generator writes shortest decimals, `buildCache` derives from f32 values.
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  const neighbour = (x: number, ulps: number): number => {
    f32[0] = x;
    u32[0] += ulps;
    return f32[0];
  };
  const probe = [0.1, 0.3, 1 / 3, 2.5, 12.7, 66.6, 0.0005, 0.001, 0.02, 0.05, 0.7, 3.33, 7.77, 9.9, 100, 440, 20000, -12, -0.7];
  for (const x of probe) {
    const a = Math.fround(x);
    const row = (v: number): FpRow => ({ kind: 'float', typecode: 0x32, displayMin: v, displayMax: v + 1, step: v / 100 });
    const base = paramFingerprint(row(a));
    if (paramFingerprint(row(x)) !== base) fail(`decimal ${x} and its f32 value must fingerprint alike`);
    for (const d of [-2, -1, 1, 2]) {
      if (paramFingerprint(row(neighbour(a, d))) !== base) fail(`f32 neighbour ${d} ULP of ${x} must fingerprint alike`);
    }
  }
  // The normalisation is six significant digits: a real change survives it.
  const near = (v: number): FpRow => ({ kind: 'float', typecode: 0x32, displayMin: v, displayMax: 10, step: 0 });
  eq(paramFingerprint(near(0.1)), paramFingerprint(near(0.1000001)), 'sub-1e-6 relative change absorbed');
  if (paramFingerprint(near(0.1)) === paramFingerprint(near(0.100002))) fail('a 2e-5 relative change must not be absorbed');
  // -0 is written as 0; every non-finite value is written as NaN.
  eq(paramFingerprint(near(-0)), paramFingerprint(near(0)), '-0 equals 0');
  eq(paramFingerprint(near(Number.NaN)), paramFingerprint(near(Number.POSITIVE_INFINITY)), 'non-finite values both write NaN');
  if (paramFingerprint(near(Number.NaN)) === paramFingerprint(near(0))) fail('NaN must differ from 0');
  ran += 1;

  // ---- Case 4: per-field sensitivity ----------------------------------------
  const fBase = flt(0x32, 0, 10, 0.01);
  const fBaseFp = paramFingerprint(fBase);
  const differs = (what: string, row: FpRow, labels?: readonly string[], base: string = fBaseFp): void => {
    if (paramFingerprint(row, labels) === base) fail(`${what} must change the fingerprint`);
  };
  differs('float typecode', flt(0x33, 0, 10, 0.01));
  differs('float typecode high bits', flt(0x432, 0, 10, 0.01));
  differs('float displayMin', flt(0x32, 1, 10, 0.01));
  differs('float displayMax', flt(0x32, 0, 11, 0.01));
  differs('float step', flt(0x32, 0, 10, 0.02));
  differs('kind', { ...fBase, kind: 'enum' });
  differs('labels on a float', fBase, ['OFF', 'ON']);
  const eBase = enm(0, 3, 4);
  const eLabels = ['A', 'B', 'C', 'D'];
  const eBaseFp = paramFingerprint(eBase, eLabels);
  differs('enum typecode', { ...eBase, typecode: 0xa0 }, eLabels, eBaseFp);
  differs('enum displayMin', enm(1, 3, 4), eLabels, eBaseFp);
  differs('enum displayMax', enm(0, 4, 4), eLabels, eBaseFp);
  differs('enum count', enm(0, 3, 5), eLabels, eBaseFp);
  differs('enum labels removed', eBase, undefined, eBaseFp);
  differs('enum label renamed', eBase, ['A', 'B', 'C', 'E'], eBaseFp);
  differs('enum labels reordered', eBase, ['B', 'A', 'C', 'D'], eBaseFp);
  differs('enum label appended', eBase, [...eLabels, 'E'], eBaseFp);
  // Deliberately ignored: the enum step (noise: 0 or 1), the enum count on a float, an empty
  // label list, trailing label whitespace, and everything that is not part of the canonical
  // string (unit, taper, scale, default).
  eq(paramFingerprint(enm(0, 3, 4, 1, 1), eLabels), eBaseFp, 'enum step ignored');
  eq(paramFingerprint(enm(0, 3, 4, 2, 0), eLabels), eBaseFp, 'enum scale ignored');
  eq(paramFingerprint({ ...fBase, enumCount: 7 }), fBaseFp, 'enumCount on a float ignored');
  eq(paramFingerprint(eBase, []), paramFingerprint(eBase), 'empty label list equals no labels');
  eq(paramFingerprint(eBase, ['A ', 'B  ', 'C', 'D ']), eBaseFp, 'trailing label whitespace ignored');
  const decorated = { ...fBase, scale: 10, unit: 'Hz', taper: 'log' as const, defaultRaw: 123 };
  eq(paramFingerprint(decorated), fBaseFp, 'unit, taper, scale and default ignored');
  // An enum without a count keeps an empty count field and still differs from a counted one.
  differs('enum without a count', { kind: 'enum', typecode: 0x10, displayMin: 0, displayMax: 3, step: 0 }, eLabels, eBaseFp);
  ran += 1;

  // ---- Case 5: row predicates (synthetic) ------------------------------------
  const zero = flt(0, 0, 0, 0, 0);
  eq(isPlaceholderRow(zero), true, 'all-zero float is a placeholder');
  const zeroAction: RangeDef = { ...zero, typecode: 0xf0, step: 5 };
  eq(isPlaceholderRow(zeroAction), true, 'typecode and step do not matter for a placeholder');
  eq(isPlaceholderRow(flt(0xf0, 0, 0, 0, 1)), false, '0..0 with a scale is not a placeholder');
  eq(isPlaceholderRow({ ...zero, kind: 'enum' }), false, 'an enum is never a placeholder');
  eq(isPlaceholderRow(flt(0x32, 0, 10, 0, 0)), false, 'a span makes it a real row');
  eq(isInformativeRow(flt(0x32, 0, 10)), true, 'span > 0 is informative');
  eq(isInformativeRow(enm(1, 3, 3)), true, 'enum span is informative');
  eq(isInformativeRow(flt(0x32, 5, 5)), false, 'min == max is degenerate');
  eq(isInformativeRow(flt(0x32, 6, 5)), false, 'min > max is not informative');
  eq(isInformativeRow(zero), false, 'a placeholder is not informative');
  eq(BYPASS_TYPECODE, 0xe0, 'BYPASS_TYPECODE');
  ran += 1;

  // ---- Case 6: catalog counts ------------------------------------------------
  const countRows = (ranges: Readonly<Record<string, Readonly<Record<number, RangeDef>>>>) => {
    let total = 0;
    let placeholder = 0;
    let informative = 0;
    for (const rows of Object.values(ranges)) {
      for (const row of Object.values(rows)) {
        total += 1;
        if (isPlaceholderRow(row)) placeholder += 1;
        if (isInformativeRow(row)) informative += 1;
        if (isPlaceholderRow(row) && isInformativeRow(row)) fail('a row cannot be placeholder and informative');
      }
    }
    return { total, placeholder, informative, degenerate: total - placeholder - informative };
  };
  eq(countRows(FM3_RANGES), { total: 1831, placeholder: 107, informative: 1716, degenerate: 8 }, 'FM3 catalog row counts');
  eq(countRows(FM9_RANGES), { total: 1902, placeholder: 103, informative: 1791, degenerate: 8 }, 'FM9 catalog row counts');
  eq(countRows(AXE3_RANGES), { total: 2111, placeholder: 44, informative: 2059, degenerate: 8 }, 'Axe-Fx III catalog row counts');
  ran += 1;

  // ---- Case 7: typecode 0xE0 <=> `_BYPASS` ------------------------------------
  const bypassDevices = [
    { name: 'FM3', ranges: FM3_RANGES, params: FM3_PARAMS, want: 34 },
    { name: 'FM9', ranges: FM9_RANGES, params: FM9_PARAMS, want: 35 },
    { name: 'Axe-Fx III', ranges: AXE3_RANGES, params: AXE3_PARAMS, want: 39 },
  ] as const;
  for (const dev of bypassDevices) {
    const nameOf = new Map<string, string>();
    for (const p of dev.params) nameOf.set(`${p.family}:${p.paramId}`, p.name);
    let rows = 0;
    for (const [family, famRows] of Object.entries(dev.ranges)) {
      for (const [pid, row] of Object.entries(famRows)) {
        if (row.typecode !== BYPASS_TYPECODE) continue;
        rows += 1;
        const name = nameOf.get(`${family}:${pid}`) ?? '';
        if (!/_BYPASS$/.test(name)) fail(`${dev.name} ${family}:${pid} has typecode 0xE0 but is named '${name}'`);
      }
    }
    eq(rows, dev.want, `${dev.name} typecode-0xE0 rows`);
    // And back: every `_BYPASS` parameter that has a range row carries the typecode.
    for (const p of dev.params) {
      if (!/_BYPASS$/.test(p.name)) continue;
      const row = (dev.ranges as Readonly<Record<string, Readonly<Record<number, RangeDef>>>>)[p.family]?.[p.paramId];
      if (row && row.typecode !== BYPASS_TYPECODE) fail(`${dev.name} ${p.name} has a range row without typecode 0xE0`);
    }
  }
  ran += 1;

  // ---- Case 8: enumOrdinalBounds ----------------------------------------------
  // Scaled enum: PHASER_ORDER is 0..10 on a scale of 2 with six labels -> ordinals 0..5.
  eq(enumOrdinalBounds(FM3_RANGES.PHASER[1]), { lo: 0, hi: 5 }, 'PHASER_ORDER');
  // First ordinal is not 0: DELAY_SVFTYPE is 1..3.
  eq(enumOrdinalBounds(FM3_RANGES.DELAY[87]), { lo: 1, hi: 3 }, 'DELAY_SVFTYPE');
  // Scale 0 passes the display bounds through: CABINET_MODE is 0..1.
  eq(enumOrdinalBounds(FM3_RANGES.CABINET[31]), { lo: 0, hi: 1 }, 'CABINET_MODE');
  // Without a count the upper bound comes from the display span; a count overrides it.
  const noCount = (displayMin: number, displayMax: number, scale: number): RangeDef => ({ kind: 'enum', typecode: 0x10, displayMin, displayMax, scale, step: 0 });
  eq(enumOrdinalBounds(noCount(0, 10, 2)), { lo: 0, hi: 5 }, 'no count: round(max / scale)');
  eq(enumOrdinalBounds(noCount(4, 6, 0)), { lo: 4, hi: 6 }, 'no count, scale 0');
  eq(enumOrdinalBounds(enm(2, 99, 3)), { lo: 2, hi: 4 }, 'count overrides the display span');
  // Every catalog enum row has a count, and the bounds span exactly that many ordinals.
  let nonZeroLow = 0;
  for (const [family, rows] of Object.entries(FM3_RANGES)) {
    for (const [pid, row] of Object.entries(rows)) {
      if (row.kind !== 'enum') continue;
      const { lo, hi } = enumOrdinalBounds(row);
      if (row.enumCount == null || hi - lo + 1 !== row.enumCount) fail(`FM3 ${family}:${pid} bounds ${lo}..${hi} vs count ${row.enumCount}`);
      if (lo !== 0) nonZeroLow += 1;
    }
  }
  eq(nonZeroLow, 29, 'FM3 enum rows whose first ordinal is not 0');
  ran += 1;

  // ---- Case 9: rowsCompatible decision table ---------------------------------
  const L4 = ['A', 'B', 'C', 'D'];
  const L8 = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const withLabels = (n: number): string[] => Array.from({ length: n }, (_, i) => `L${i}`);
  const table: Array<{ name: string; a: RangeDef; la?: readonly string[]; b: RangeDef; lb?: readonly string[]; want: boolean }> = [
    { name: 'different kinds', a: flt(0x10, 0, 3), b: enm(0, 3, 4), want: false },
    // enums
    { name: 'enum: no labels on either side', a: enm(0, 3, 4), b: enm(0, 3, 4), want: true },
    { name: 'enum: empty list on one side', a: enm(0, 3, 4), la: [], b: enm(0, 3, 4), lb: L4, want: true },
    { name: 'enum: labels only on one side', a: enm(0, 3, 4), la: L4, b: enm(0, 3, 4), want: true },
    { name: 'enum: identical labels', a: enm(0, 3, 4), la: L4, b: enm(0, 3, 4), lb: L4, want: true },
    { name: 'enum: appended label', a: enm(0, 7, 8), la: L8, b: enm(0, 8, 9), lb: [...L8, 'I'], want: true },
    { name: 'enum: removed tail', a: enm(0, 8, 9), la: [...L8, 'I'], b: enm(0, 7, 8), lb: L8, want: true },
    { name: 'enum: appended tail to a short list', a: enm(0, 3, 4), la: L4, b: enm(0, 5, 6), lb: [...L4, 'E', 'F'], want: true },
    { name: 'enum: one rename of 4 (allowance max(1, 1))', a: enm(0, 3, 4), la: L4, b: enm(0, 3, 4), lb: ['A', 'B', 'C', 'X'], want: true },
    { name: 'enum: two renames of 4', a: enm(0, 3, 4), la: L4, b: enm(0, 3, 4), lb: ['A', 'B', 'X', 'Y'], want: false },
    { name: 'enum: two renames of 8 (allowance 2)', a: enm(0, 7, 8), la: L8, b: enm(0, 7, 8), lb: ['A', 'B', 'C', 'D', 'E', 'F', 'X', 'Y'], want: true },
    { name: 'enum: three renames of 8', a: enm(0, 7, 8), la: L8, b: enm(0, 7, 8), lb: ['A', 'B', 'C', 'D', 'E', 'X', 'Y', 'Z'], want: false },
    { name: 'enum: one rename of 2 labels', a: enm(0, 1, 2), la: ['OFF', 'ON'], b: enm(0, 1, 2), lb: ['OFF', 'ARMED'], want: true },
    { name: 'enum: both renamed of 2', a: enm(0, 1, 2), la: ['OFF', 'ON'], b: enm(0, 1, 2), lb: ['NO', 'YES'], want: false },
    { name: 'enum: reordered', a: enm(0, 3, 4), la: L4, b: enm(0, 3, 4), lb: ['D', 'C', 'B', 'A'], want: false },
    { name: 'enum: allowance grows with the list (12 labels, 3 renames)', a: enm(0, 11, 12), la: withLabels(12), b: enm(0, 11, 12), lb: [...withLabels(9), 'x', 'y', 'z'], want: true },
    { name: 'enum: 12 labels, 4 renames', a: enm(0, 11, 12), la: withLabels(12), b: enm(0, 11, 12), lb: [...withLabels(8), 'w', 'x', 'y', 'z'], want: false },
    // floats
    { name: 'float: identical', a: flt(0x32, 0, 10), b: flt(0x32, 0, 10), want: true },
    { name: 'float: typecode low-nibble change', a: flt(0x32, 0, 10), b: flt(0x31, 0, 10), want: true },
    { name: 'float: typecode bits above the low byte', a: flt(0x432, 0, 64), b: flt(0x32, 0, 10), want: true },
    { name: 'float: unit-class nibble differs', a: flt(0x32, 0, 10), b: flt(0x42, 0, 10), want: false },
    { name: 'float: neutralised row (0..1, typecode 0)', a: flt(0x32, 0, 10), b: flt(0x0, 0, 1), want: false },
    { name: 'float: span widened', a: flt(0x32, 0, 10), b: flt(0x32, 0, 20), want: true },
    { name: 'float: spans touch at one point', a: flt(0x32, 0, 10), b: flt(0x32, 10, 20), want: true },
    { name: 'float: spans disjoint', a: flt(0x32, 0, 10), b: flt(0x32, 11, 20), want: false },
    { name: 'float: spans disjoint (reverse)', a: flt(0x32, 11, 20), b: flt(0x32, 0, 10), want: false },
    { name: 'float: labels are not consulted', a: flt(0x32, 0, 10), la: ['A', 'B'], b: flt(0x32, 0, 10), lb: ['C', 'D'], want: true },
  ];
  for (const row of table) {
    eq(rowsCompatible(row.a, row.la, row.b, row.lb), row.want, `rowsCompatible '${row.name}'`);
    eq(rowsCompatible(row.b, row.lb, row.a, row.la), row.want, `rowsCompatible '${row.name}' (swapped)`);
  }
  // Invariant: the same fingerprint implies compatible. Trailing label whitespace is invisible to
  // the fingerprint, so it must be invisible to `rowsCompatible` too.
  const rowR = enm(0, 3, 4);
  const padded = ['A ', 'B  ', 'C   ', 'D '];
  eq(paramFingerprint(rowR, L4), paramFingerprint(rowR, padded), 'padded labels fingerprint alike');
  eq(rowsCompatible(rowR, L4, rowR, padded), true, 'trailing-space padding on every label is compatible');
  eq(rowsCompatible(rowR, padded, rowR, L4), true, 'trailing-space padding on every label is compatible (swapped)');
  // Padding on one side plus an appended label: the padded prefix is the same list, so one
  // appended label is within the allowance.
  const paddedPlus = [...padded, 'E'];
  eq(rowsCompatible(rowR, L4, enm(0, 4, 5), paddedPlus), true, 'padding on one side plus an appended label is compatible');
  eq(rowsCompatible(enm(0, 4, 5), paddedPlus, rowR, L4), true, 'padding on one side plus an appended label is compatible (swapped)');
  // Leading and inner whitespace still count as a difference (2 of 4 positions: over the allowance).
  eq(rowsCompatible(rowR, L4, rowR, [' A', ' B', 'C', 'D']), false, 'leading whitespace is a difference');
  ran += 1;

  // ---- Case 10: familyAssignmentSuspects --------------------------------------
  // The codec's own (read-only) catalog constants go in as they are, no casts.
  const fm3Ref: Tables = { ranges: FM3_RANGES, enumOverrides: FM3_ENUM_OVERRIDES };
  const fm9Ref: Tables = { ranges: FM9_RANGES, enumOverrides: FM9_ENUM_OVERRIDES };
  const axe3Ref: Tables = { ranges: AXE3_RANGES, enumOverrides: AXE3_ENUM_OVERRIDES };
  // Sanity only: a table checked against itself has an own share of 1.0 for every family, so
  // this cannot fail on a threshold change. It is not false-positive evidence; the walk-built
  // profile in `catalog-bridge.test.ts` is.
  eq(familyAssignmentSuspects(fm3Ref, fm3Ref), [], 'identical FM3 tables (sanity)');
  eq(familyAssignmentSuspects(fm9Ref, fm9Ref), [], 'identical FM9 tables (sanity)');
  eq(familyAssignmentSuspects(axe3Ref, axe3Ref), [], 'identical Axe-Fx III tables (sanity)');

  // MIXER and OUTPUT assigned each other's section: both are flagged, nothing else is.
  const swapped: Tables = {
    ranges: { ...fm3Ref.ranges, MIXER: fm3Ref.ranges.OUTPUT, OUTPUT: fm3Ref.ranges.MIXER },
    enumOverrides: { ...fm3Ref.enumOverrides, MIXER: fm3Ref.enumOverrides.OUTPUT, OUTPUT: fm3Ref.enumOverrides.MIXER },
  };
  eq(familyAssignmentSuspects(swapped, fm3Ref), ['MIXER', 'OUTPUT'], 'MIXER/OUTPUT swap');

  // One-sided: MIXER took OUTPUT's section while OUTPUT kept its own. Only the thief is flagged.
  const stolen: Tables = {
    ranges: { ...fm3Ref.ranges, MIXER: fm3Ref.ranges.OUTPUT },
    enumOverrides: { ...fm3Ref.enumOverrides, MIXER: fm3Ref.enumOverrides.OUTPUT },
  };
  eq(familyAssignmentSuspects(stolen, fm3Ref), ['MIXER'], 'one-sided steal');

  // The thresholds are honoured.
  eq(familyAssignmentSuspects(swapped, fm3Ref, { floor: 1.01 }), [], 'floor above any share flags nothing');
  eq(familyAssignmentSuspects(swapped, fm3Ref, { margin: 1.01 }), [], 'margin above any gap flags nothing');
  // After the swap the MIXER profile family carries OUTPUT's 23 informative rows and the OUTPUT
  // profile family carries MIXER's 17.
  eq(familyAssignmentSuspects(swapped, fm3Ref, { minRows: 18 }), ['MIXER'], 'minRows 18 spares the 17-row family');
  eq(familyAssignmentSuspects(swapped, fm3Ref, { minRows: 24 }), [], 'minRows above both row counts flags nothing');

  // Margin and floor decide on synthetic tables (ten distinct float rows per family).
  const synth = (shared: number, variant: number): Record<number, RangeDef> =>
    Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, i < shared ? flt(0x32, 0, 10 + i, 0.01) : flt(0x32, 0, 100 * variant + i, 0.01)]));
  // B shares 8 of A's 10 rows. A profile that gives family A the rows of B matches B on every row
  // (share 1.0) and A on 8 of 10 (share 0.8): a gap of 0.2, below the default margin of 0.25.
  const refAB: Tables = { ranges: { A: synth(10, 1), B: synth(8, 2) }, enumOverrides: {} };
  const aTakesB: Tables = { ranges: { A: synth(8, 2), B: synth(8, 2) }, enumOverrides: {} };
  eq(familyAssignmentSuspects(aTakesB, refAB), [], 'gap 0.2 is below the default margin');
  eq(familyAssignmentSuspects(aTakesB, refAB, { margin: 0.15 }), ['A'], 'gap 0.2 passes a margin of 0.15');
  // Only 4 of A's 10 profile rows match B (share 0.4, none match A): below the default floor of 0.5.
  const refAB0: Tables = { ranges: { A: synth(10, 1), B: synth(0, 2) }, enumOverrides: {} };
  const partial: Tables = {
    ranges: { A: Object.fromEntries(Object.entries(synth(0, 2)).map(([k, row]) => (Number(k) < 4 ? [k, row] : [k, flt(0x32, 0, 7777 + Number(k), 0.01)]))), B: synth(0, 2) },
    enumOverrides: {},
  };
  eq(familyAssignmentSuspects(partial, refAB0), [], 'share 0.4 is below the default floor');
  eq(familyAssignmentSuspects(partial, refAB0, { floor: 0.3 }), ['A'], 'share 0.4 passes a floor of 0.3');
  // Three informative rows that all match B and none of A: below the default minRows of 4, so not
  // judged; judged (and flagged) once minRows allows it.
  const rowsOfB = synth(0, 2);
  const tiny: Tables = { ranges: { A: { 0: rowsOfB[0], 1: rowsOfB[1], 2: rowsOfB[2] }, B: rowsOfB }, enumOverrides: {} };
  eq(familyAssignmentSuspects(tiny, refAB0), [], 'three rows are too few to judge');
  eq(familyAssignmentSuspects(tiny, refAB0, { minRows: 3 }), ['A'], 'three rows are judged with minRows 3');

  // Exact threshold boundary (a `>=` -> `>` or `<` -> `<=` regression must fail here). Two families
  // with four informative rows each. The profile's A has: pid 0 equal to reference A's row, pids 1
  // and 2 equal to reference B's rows, pid 3 equal to neither. So A's own share is 0.25 and the best
  // other share (B) is 0.5: exactly the default floor (0.5), exactly own + the default margin
  // (0.25 + 0.25), and exactly the default minRows (4 rows).
  const edgeRows = (variant: number): Record<number, RangeDef> =>
    Object.fromEntries(Array.from({ length: 4 }, (_, i) => [i, flt(0x32, 0, 100 * variant + i + 1, 0.01)]));
  const stray = (i: number): RangeDef => flt(0x32, 0, 9000 + i, 0.01);
  const refEdge: Tables = { ranges: { A: edgeRows(1), B: edgeRows(2) }, enumOverrides: {} };
  const onEdge: Tables = {
    ranges: { A: { 0: edgeRows(1)[0], 1: edgeRows(2)[1], 2: edgeRows(2)[2], 3: stray(3) }, B: edgeRows(2) },
    enumOverrides: {},
  };
  eq(familyAssignmentSuspects(onEdge, refEdge), ['A'], 'exactly on floor 0.5, margin 0.25 and minRows 4 is flagged');
  // One notch past each threshold alone, with the other two still satisfied: not flagged.
  eq(familyAssignmentSuspects(onEdge, refEdge, { floor: 0.5 + 1e-9 }), [], 'best share just below the floor');
  eq(familyAssignmentSuspects(onEdge, refEdge, { margin: 0.25 + 1e-9 }), [], 'gap just below the margin');
  eq(familyAssignmentSuspects(onEdge, refEdge, { minRows: 5 }), [], 'four rows with minRows 5 are not judged');
  // Natural one-row-fewer case on the default thresholds: only pid 1 matches B (best share 0.25,
  // own share 0), the gap passes the margin but the best share is below the floor.
  const belowFloor: Tables = {
    ranges: { A: { 0: stray(0), 1: edgeRows(2)[1], 2: stray(2), 3: stray(3) }, B: edgeRows(2) },
    enumOverrides: {},
  };
  eq(familyAssignmentSuspects(belowFloor, refEdge), [], 'best share 0.25 is below the default floor of 0.5');

  // A family that is not part of the reference is never flagged (nothing to compare against).
  const foreign: Tables = {
    ranges: { ...fm3Ref.ranges, UNLISTED: fm3Ref.ranges.OUTPUT },
    enumOverrides: { ...fm3Ref.enumOverrides, UNLISTED: fm3Ref.enumOverrides.OUTPUT },
  };
  eq(familyAssignmentSuspects(foreign, fm3Ref), [], 'family absent from the reference');

  // A family missing from the profile is not flagged either (only profile families are examined).
  const { OUTPUT: _dropped, ...withoutOutput } = fm3Ref.ranges;
  eq(familyAssignmentSuspects({ ranges: withoutOutput, enumOverrides: fm3Ref.enumOverrides }, fm3Ref), [], 'family absent from the profile');

  // A profile with every row of a family blanked to placeholders has no informative rows to judge.
  const blank = (rows: Readonly<Record<number, RangeDef>>): Record<number, RangeDef> =>
    Object.fromEntries(Object.keys(rows).map((k) => [Number(k), flt(0, 0, 0, 0, 0)]));
  eq(familyAssignmentSuspects({ ranges: { ...fm3Ref.ranges, MIXER: blank(fm3Ref.ranges.MIXER) }, enumOverrides: fm3Ref.enumOverrides }, fm3Ref), [], 'all-placeholder family');

  // A copy of one family's rows under another family's name is flagged on the copy only; the
  // original keeps matching its own reference rows.
  const twin: Tables = {
    ranges: { ...fm3Ref.ranges, OUTPUT: fm3Ref.ranges.MIXER, MIXER: fm3Ref.ranges.MIXER },
    enumOverrides: { ...fm3Ref.enumOverrides, OUTPUT: fm3Ref.enumOverrides.MIXER, MIXER: fm3Ref.enumOverrides.MIXER },
  };
  eq(familyAssignmentSuspects(twin, fm3Ref), ['OUTPUT'], 'a copy of MIXER under OUTPUT flags OUTPUT only');
  ran += 1;

  if (ran !== FINGERPRINT_CASE_COUNT) fail(`ran ${ran} cases, FINGERPRINT_CASE_COUNT is ${FINGERPRINT_CASE_COUNT}`);
  console.log(`  cache/fingerprint: ${ran} cases (goldens, f32 normalisation, catalog counts 1716/1791/2059 informative, bypass 34/35/39)`);
}
