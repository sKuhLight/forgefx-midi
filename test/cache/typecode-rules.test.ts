/**
 * Typecode rules (`src/cache/typecodeRules.ts`).
 *
 * Public data only: the committed FM3 / FM9 / Axe-Fx III range catalogs (explicit tapers and
 * unit tokens per row) and their parameter catalogs (a catalog unit per row). Cases:
 *   1. taper vectors: middle nibble 4 is log, 3 and 5..9 are linear, everything else null, the
 *      high byte does not change the class;
 *   2. taper confidence: measured codes versus extrapolated ones;
 *   3. unit vectors (full typecodes) and the catalog unit-code subset;
 *   4. role vectors (bypass, knob, monitor, toggle row);
 *   5. non-typecode inputs yield null everywhere;
 *   6. taper agreement with the committed explicit tapers, per model, pinned: precision over the
 *      rows the rule predicts must stay at or above 95 % (otherwise that model would have to
 *      be excluded), and no row is ever predicted the opposite of its measured taper;
 *   7. the measured-taper typecodes hold on the committed catalogs too;
 *   8. unit agreement: device-true unit tokens and catalog units of the rows the unit table
 *      covers, and why the table is keyed on the full typecode;
 *   9. role agreement: bypass / toggle-row / knob rows on the committed catalogs.
 */
import { BYPASS_TYPECODE } from '../../src/cache/fingerprint.js';
import { KNOB_TYPECODE } from '../../src/cache/assign.js';
import {
  typecodeTaper,
  typecodeUnit,
  typecodeClass,
  KNOB_0_10_TYPECODE,
  type TypecodeUnitCode,
} from '../../src/cache/typecodeRules.js';
import type { Unit } from '../../src/gen3/types.js';
import { FM3_RANGES } from '../../src/gen3/fm3/ranges.generated.js';
import { FM3_PARAMS } from '../../src/gen3/fm3/params.js';
import { FM9_RANGES } from '../../src/gen3/fm9/ranges.generated.js';
import { FM9_PARAMS } from '../../src/gen3/fm9/params.js';
import { AXE3_RANGES } from '../../src/gen3/axe-fx-iii/ranges.generated.js';
import { PARAMS as AXE3_PARAMS } from '../../src/gen3/axe-fx-iii/params.js';

// Every unit code the table can return is a valid catalog unit (compile-time check).
type UnitCodesAreCatalogUnits = TypecodeUnitCode extends Unit ? true : never;
const unitCodesAreCatalogUnits: UnitCodesAreCatalogUnits = true;

const fail = (msg: string): never => {
  throw new Error(`[cache/typecode-rules] ${msg}`);
};
const hex = (n: number): string => `0x${n.toString(16)}`;

interface CatalogRow {
  readonly kind: 'enum' | 'float';
  readonly displayMin: number;
  readonly displayMax: number;
  readonly scale: number;
  readonly typecode: number;
  readonly unit?: string;
  readonly taper?: 'linear' | 'log' | 'flat' | 'custom';
}
type RangeTable = Readonly<Record<string, Readonly<Record<number, CatalogRow>>>>;
interface CatalogParam {
  readonly family: string;
  readonly paramId: number;
  readonly unit: string;
}

const MODELS: ReadonlyArray<{ name: string; ranges: RangeTable; params: readonly CatalogParam[] }> = [
  { name: 'FM3', ranges: FM3_RANGES as RangeTable, params: FM3_PARAMS },
  { name: 'FM9', ranges: FM9_RANGES as RangeTable, params: FM9_PARAMS },
  { name: 'Axe-Fx III', ranges: AXE3_RANGES as RangeTable, params: AXE3_PARAMS },
];

function allRows(ranges: RangeTable): Array<{ family: string; paramId: number; row: CatalogRow }> {
  const out: Array<{ family: string; paramId: number; row: CatalogRow }> = [];
  for (const [family, table] of Object.entries(ranges)) {
    for (const [pid, row] of Object.entries(table)) out.push({ family, paramId: Number(pid), row });
  }
  return out;
}

/**
 * Agreement of the taper rule with the explicit tapers of one range catalog. Only reliable
 * measured shapes count (`flat` carries no taper information). `precision` is `correct` over
 * `predicted`: rows the rule abstains on (typecodes 0x10, 0x20, 0xf0, whose measured tapers are
 * all `custom` curves the table cannot express) are not errors, they are reported as
 * `abstained`.
 */
function taperAgreement(ranges: RangeTable): {
  reliable: number;
  predicted: number;
  correct: number;
  flips: number;
  abstained: number;
} {
  let reliable = 0;
  let predicted = 0;
  let correct = 0;
  let flips = 0;
  for (const { row } of allRows(ranges)) {
    if (row.kind !== 'float' || !row.taper || row.taper === 'flat') continue;
    reliable += 1;
    const rule = typecodeTaper(row.typecode);
    if (!rule) continue;
    predicted += 1;
    if (rule.taper === row.taper) correct += 1;
    else if (row.taper !== 'custom') flips += 1;
  }
  return { reliable, predicted, correct, flips, abstained: reliable - predicted };
}

// Pinned agreement per catalog: re-pin deliberately when a catalog is regenerated. Counting the
// abstained rows as misses too (`correct / reliable`) gives FM9 184/194 (94.8 %) and Axe-Fx III
// 329/344 (95.6 %); precision over the predicted rows is 97.4 % and 97.6 %.
const PINNED_TAPER_AGREEMENT: Record<string, { reliable: number; predicted: number; correct: number }> = {
  FM3: { reliable: 17, predicted: 17, correct: 17 },
  FM9: { reliable: 194, predicted: 189, correct: 184 },
  'Axe-Fx III': { reliable: 344, predicted: 337, correct: 329 },
};

const NON_SPECIFIC_CATALOG_UNITS: ReadonlySet<string> = new Set([
  'numeric', 'unverified', 'enum', 'count', 'ratio', 'knob_0_10', 'knob_0_20',
]);
const TOKEN_TO_UNIT: Readonly<Record<string, TypecodeUnitCode>> = { Hz: 'hz', dB: 'db', '%': 'percent' };

const cases: Array<[string, () => void]> = [
  ['taper vectors', () => {
    for (let nibble = 0; nibble <= 0xf; nibble++) {
      const expected = nibble === 4 ? 'log' : nibble >= 3 && nibble <= 9 ? 'linear' : null;
      for (const high of [0x000, 0x100, 0x200, 0x500, 0xa00, 0xc00]) {
        for (const low of [0x0, 0x1, 0x2, 0x3]) {
          const tc = high | (nibble << 4) | low;
          const got = typecodeTaper(tc)?.taper ?? null;
          if (got !== expected) fail(`typecodeTaper(${hex(tc)}) = ${got}, expected ${expected}`);
        }
      }
    }
    // Named examples from the contract table.
    if (typecodeTaper(0x40)?.taper !== 'log') fail('0x40 must be log');
    if (typecodeTaper(0x240)?.taper !== 'log') fail('0x240 must be log');
    if (typecodeTaper(0x32)?.taper !== 'linear') fail('0x32 must be linear');
    if (typecodeTaper(0x531)?.taper !== 'linear') fail('0x531 must be linear');
    if (typecodeTaper(0x91)?.taper !== 'linear') fail('0x91 must be linear');
    if (typecodeTaper(KNOB_0_10_TYPECODE)?.taper !== 'linear') fail('0x52 must be linear');
    // Bypass / toggle / monitor low bytes and nibbles 0..2 predict nothing.
    for (const tc of [0x0, 0x10, 0x20, 0xa0, 0xb0, 0xc0, 0xd0, BYPASS_TYPECODE, 0xf0, 0x2f0, 0xb20]) {
      if (typecodeTaper(tc) !== null) fail(`typecodeTaper(${hex(tc)}) must be null`);
    }
  }],

  ['taper confidence', () => {
    for (const tc of [0x31, 0x32, 0x43, 0x52, 0x91, 0x181, 0x242, 0x531]) {
      if (typecodeTaper(tc)?.confidence !== 'measured') fail(`${hex(tc)} must be a measured taper`);
    }
    // Extrapolated: never measured, or measured below 95 % (0x42, 0x243, 0x432).
    for (const tc of [0x42, 0x243, 0x432, 0x34, 0x45, 0x67, 0x934]) {
      if (typecodeTaper(tc)?.confidence !== 'rule') fail(`${hex(tc)} must be a rule-confidence taper`);
    }
  }],

  ['unit vectors', () => {
    if (!unitCodesAreCatalogUnits) fail('unit codes must be catalog units');
    const table: Array<[number, TypecodeUnitCode]> = [
      [0x240, 'hz'], [0x241, 'hz'],
      [0x161, 'db'], [0x162, 'db'], [0x181, 'db'],
      [0x571, 'percent'],
    ];
    for (const [tc, unit] of table) {
      const got = typecodeUnit(tc);
      if (!got || got.unit !== unit || got.confidence !== 'measured') fail(`typecodeUnit(${hex(tc)}) = ${JSON.stringify(got)}`);
    }
    // Typecodes with mixed or no units imply none; so do the contract's low-byte shorthands
    // without their high byte, and the same low bytes under another high byte.
    for (const tc of [
      0x0, 0x10, 0x31, 0x32, 0x33, 0x42, 0x43, 0x52, 0x62, 0x91, 0xe0, 0xf0, 0xd0,
      0x40, 0x41, 0x61, 0x71, 0x81, 0x441, 0x541, 0x841, 0x531, 0x132, 0x442, 0x631,
    ]) {
      if (typecodeUnit(tc) !== null) fail(`typecodeUnit(${hex(tc)}) must be null`);
    }
  }],

  ['role vectors', () => {
    if (BYPASS_TYPECODE !== 0xe0) fail('BYPASS_TYPECODE changed');
    if (KNOB_0_10_TYPECODE !== KNOB_TYPECODE) fail('KNOB_0_10_TYPECODE must equal the knob rule typecode');
    const table: Array<[number, string | null]> = [
      [0xe0, 'bypass'], [0x52, 'knob-0-10'],
      [0xf0, 'monitor'], [0x2f0, 'monitor'],
      [0xd0, 'toggle-row'], [0x1d0, 'toggle-row'],
      [0x0, null], [0x10, null], [0x31, null], [0x32, null], [0x42, null], [0x43, null], [0x91, null],
      [0x152, null], [0x1e0, null], [0x240, null], [0x531, null], [0xb0, null],
    ];
    for (const [tc, expected] of table) {
      const got = typecodeClass(tc);
      if (got !== expected) fail(`typecodeClass(${hex(tc)}) = ${got}, expected ${expected}`);
    }
  }],

  ['non-typecode inputs', () => {
    for (const tc of [NaN, Infinity, -Infinity, -1, 0.5, 0x10000, 0x1ffff]) {
      if (typecodeTaper(tc) !== null) fail(`typecodeTaper(${tc}) must be null`);
      if (typecodeUnit(tc) !== null) fail(`typecodeUnit(${tc}) must be null`);
      if (typecodeClass(tc) !== null) fail(`typecodeClass(${tc}) must be null`);
    }
    // The largest valid typecode is still evaluated (nibble 0xf: no taper).
    if (typecodeTaper(0xffff) !== null) fail('typecodeTaper(0xffff) must be null');
  }],

  ...MODELS.map(({ name, ranges }): [string, () => void] => [`taper agreement with the ${name} catalog`, () => {
    const a = taperAgreement(ranges);
    const pinned = PINNED_TAPER_AGREEMENT[name];
    if (a.reliable !== pinned.reliable || a.predicted !== pinned.predicted || a.correct !== pinned.correct) {
      fail(`${name}: agreement ${a.correct}/${a.predicted} of ${a.reliable} reliable tapers, pinned ${pinned.correct}/${pinned.predicted} of ${pinned.reliable} (re-pin if the catalog was regenerated)`);
    }
    if (a.flips !== 0) fail(`${name}: ${a.flips} rows are predicted the opposite of their measured taper (every miss must be a custom curve)`);
    const precision = a.correct / a.predicted;
    if (precision < 0.95) {
      fail(`${name}: precision ${(precision * 100).toFixed(2)} % over the predicted rows is below 95 %; the table would have to exclude this model`);
    }
  }]),

  ['measured-taper typecodes hold on the committed catalogs', () => {
    // Every typecode reported as measured that has at least five explicit rows in a catalog
    // agrees with those rows at 95 % or better; rule-confidence codes are not claimed to.
    const checked = new Set<number>();
    for (const { name, ranges } of MODELS) {
      const per = new Map<number, { n: number; ok: number }>();
      for (const { row } of allRows(ranges)) {
        if (row.kind !== 'float' || !row.taper || row.taper === 'flat') continue;
        const rule = typecodeTaper(row.typecode);
        if (!rule || rule.confidence !== 'measured') continue;
        const e = per.get(row.typecode) ?? { n: 0, ok: 0 };
        e.n += 1;
        if (rule.taper === row.taper) e.ok += 1;
        per.set(row.typecode, e);
      }
      for (const [tc, { n, ok }] of per) {
        if (n < 5) continue;
        checked.add(tc);
        if (ok / n < 0.95) fail(`${name}: measured typecode ${hex(tc)} agrees ${ok}/${n} with the catalog, below 95 %`);
      }
    }
    // The dominant linear and log codes are among those the catalogs can check.
    for (const tc of [0x31, 0x32, 0x43, 0x52, 0x91]) {
      if (!checked.has(tc)) fail(`${hex(tc)} was not checked against any catalog`);
    }
  }],

  ['unit agreement with the committed catalogs', () => {
    let tokens = 0;
    let catalogUnits = 0;
    const covered = new Set<number>();
    for (const { name, ranges, params } of MODELS) {
      // (a) device-true unit tokens on the range rows (a few catalogs carry some).
      for (const { family, paramId, row } of allRows(ranges)) {
        const rule = typecodeUnit(row.typecode);
        if (!rule || !row.unit) continue;
        tokens += 1;
        if (TOKEN_TO_UNIT[row.unit] !== rule.unit) {
          fail(`${name} ${family}:${paramId} tc ${hex(row.typecode)}: unit token '${row.unit}' disagrees with '${rule.unit}'`);
        }
      }
      // (b) the catalog unit of the parameter, wherever it names a specific unit.
      for (const p of params) {
        const row = ranges[p.family]?.[p.paramId];
        if (!row || row.kind !== 'float') continue;
        const rule = typecodeUnit(row.typecode);
        if (!rule || NON_SPECIFIC_CATALOG_UNITS.has(p.unit)) continue;
        catalogUnits += 1;
        covered.add(row.typecode);
        if (p.unit !== rule.unit) {
          fail(`${name} ${p.family}:${p.paramId} tc ${hex(row.typecode)}: catalog unit '${p.unit}' disagrees with '${rule.unit}'`);
        }
      }
    }
    if (tokens < 1) fail('no unit token of a covered typecode was checked');
    if (catalogUnits < 100) fail(`only ${catalogUnits} catalog units checked`);
    for (const tc of [0x240, 0x241, 0x161, 0x162, 0x181, 0x571]) {
      if (!covered.has(tc)) fail(`${hex(tc)} has no named catalog unit to check against`);
    }
  }],

  ['unit table is keyed on the full typecode', () => {
    // Rows that share the low byte 0x41 but not the high byte 2 carry other units in the
    // catalogs, so matching the low byte alone would mislabel them.
    let other = 0;
    for (const { params, ranges } of MODELS) {
      for (const p of params) {
        const row = ranges[p.family]?.[p.paramId];
        if (!row || row.kind !== 'float' || (row.typecode & 0xff) !== 0x41 || row.typecode === 0x241) continue;
        if (NON_SPECIFIC_CATALOG_UNITS.has(p.unit)) continue;
        if (p.unit === 'hz') fail(`${p.family}:${p.paramId} tc ${hex(row.typecode)} is Hz but is not 0x241`);
        other += 1;
      }
    }
    if (other < 2) fail(`expected at least two rows with a low byte 0x41 and another unit, found ${other}`);
  }],

  ['role agreement with the committed catalogs', () => {
    for (const { name, ranges } of MODELS) {
      const counts = { bypass: 0, knob: 0, toggle: 0 };
      for (const { family, paramId, row } of allRows(ranges)) {
        const cls = typecodeClass(row.typecode);
        const at = `${name} ${family}:${paramId}`;
        if (cls === 'bypass') {
          counts.bypass += 1;
          // A bypass row is a 0..1 float switch.
          if (row.kind !== 'float' || row.displayMin !== 0 || row.displayMax !== 1) fail(`${at}: bypass row must be a 0..1 float`);
        } else if (cls === 'toggle-row') {
          counts.toggle += 1;
          // All-zero on FM3/FM9, a 0..1 toggle on the Axe-Fx III; never anything else.
          const zero = row.displayMin === 0 && row.displayMax === 0 && row.scale === 0;
          const toggle = row.displayMin === 0 && row.displayMax === 1;
          if (row.kind !== 'float' || (!zero && !toggle)) fail(`${at}: toggle row must be all-zero or 0..1`);
        } else if (cls === 'knob-0-10') {
          counts.knob += 1;
          if (row.kind !== 'float' || row.displayMin !== 0 || row.displayMax !== 10 || row.taper !== 'linear') {
            fail(`${at}: knob row must be a linear 0..10 float`);
          }
        }
      }
      if (counts.bypass < 30 || counts.knob < 15 || counts.toggle < 15) {
        fail(`${name}: too few role rows checked ${JSON.stringify(counts)}`);
      }
    }
  }],
];

export const TYPECODE_RULES_CASE_COUNT = cases.length;

export function runTypecodeRules(): void {
  for (const [name, run] of cases) {
    try {
      run();
    } catch (err) {
      throw new Error(`case '${name}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
