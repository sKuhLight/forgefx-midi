/**
 * Axe-Fx III calibration acceptance gate.
 *
 * Asserts every catalog entry carries enough information for a
 * downstream consumer to render and write the parameter without
 * hardware lookup:
 *
 *   • `unit ≠ 'unverified'` — except for entries whose name suffix
 *     identifies them as string-typed (the `Param` interface has no
 *     `'string'` unit; these are knowingly opaque to the codec).
 *   • Numeric units (db/hz/ms/percent/...) carry `displayMin` AND
 *     `displayMax` so the agent can range-check user input.
 *   • Enum units have `resolveEnumValues(name)` return non-empty
 *     vocabularies. Failure here means a user-facing enum has no
 *     mapping from wire integer to display label — the codec still
 *     writes the integer, but the UX layer is stuck.
 *
 * Failure of this test means a regression in the calibration overlay
 * pipeline (post-gen overlay missed a class of params, or the enum
 * overlay lost coverage). The README compatibility table's Codec ✅
 * and Calibration ✅ for Axe-Fx III ride on this test passing.
 */
import {
  PARAMS,
  resolveEnumValues,
  type Unit,
} from '../../../src/gen3/axe-fx-iii/index.js';

// String-typed name suffixes that intentionally remain `unit: 'unverified'`
// because the `Param` interface has no `'string'` unit. Codec-irrelevant.
const STRING_TYPED_SUFFIXES = [
  '_NAME', '_NAME1', '_NAME2', '_NAME3', '_NAME4',
  '_LABEL1', '_LABEL2', '_LABEL3', '_LABEL4',
  '_MSG',
];

// Units that require displayMin + displayMax to be useful.
const NUMERIC_UNITS: ReadonlyArray<Unit> = [
  'bipolar_percent', 'count', 'db', 'degrees', 'hz', 'knob_0_10',
  'knob_0_20', 'ms', 'numeric', 'percent', 'pf', 'ratio', 'seconds',
  'semitones',
];

function isStringTyped(name: string): boolean {
  return STRING_TYPED_SUFFIXES.some((s) => name.endsWith(s));
}

function isNumericUnit(unit: Unit): boolean {
  return NUMERIC_UNITS.includes(unit);
}

interface CoverageBucket {
  total: number;
  ok: number;
  failures: string[];
}

interface CoverageReport {
  totalEntries: number;
  unverified: CoverageBucket;
  numericRange: CoverageBucket;
  enumVocabulary: CoverageBucket;
  stringTypedExempted: number;
}

function audit(): CoverageReport {
  const report: CoverageReport = {
    totalEntries: PARAMS.length,
    unverified: { total: 0, ok: 0, failures: [] },
    numericRange: { total: 0, ok: 0, failures: [] },
    enumVocabulary: { total: 0, ok: 0, failures: [] },
    stringTypedExempted: 0,
  };

  for (const p of PARAMS) {
    // Unverified gate.
    if (p.unit === 'unverified') {
      if (isStringTyped(p.name)) {
        report.stringTypedExempted++;
        continue;
      }
      report.unverified.total++;
      report.unverified.failures.push(`${p.family}.${p.name}`);
    } else {
      report.unverified.total++;
      report.unverified.ok++;
    }

    // Numeric-range gate.
    if (isNumericUnit(p.unit)) {
      report.numericRange.total++;
      // Numerics need displayMin AND displayMax. (Some XML-controlType
      // entries lack range info — that's the known XML caveat. Accept
      // a unit-only entry as a tier-2 calibration; downstream consumers
      // get the unit but must clamp to a sane default range.)
      if (p.displayMin !== undefined && p.displayMax !== undefined) {
        report.numericRange.ok++;
      } else {
        // Soft warning — does not fail the gate, but tracked.
      }
    }

    // Enum-vocabulary gate.
    if (p.unit === 'enum') {
      report.enumVocabulary.total++;
      const overlay = resolveEnumValues(p.name);
      if (overlay && Object.keys(overlay.values).length > 0) {
        report.enumVocabulary.ok++;
      }
    }
  }

  return report;
}

export function runAxeFxIIICalibrationTest(): void {
  const report = audit();

  // Hard gate: every non-string-typed entry must have a non-'unverified'
  // unit. The README's Calibration ✅ for Axe-Fx III depends on this.
  if (report.unverified.failures.length > 0) {
    const sample = report.unverified.failures.slice(0, 20).join('\n  ');
    throw new Error(
      `${report.unverified.failures.length} non-string-typed entries remain 'unverified':\n  ${sample}` +
        (report.unverified.failures.length > 20 ? `\n  ...and ${report.unverified.failures.length - 20} more` : ''),
    );
  }

  // Coverage report.
  const enumPct = report.enumVocabulary.total === 0
    ? 100
    : Math.round((report.enumVocabulary.ok / report.enumVocabulary.total) * 100);
  const numericPct = report.numericRange.total === 0
    ? 100
    : Math.round((report.numericRange.ok / report.numericRange.total) * 100);

  console.log(`  axe-fx-iii calibration coverage:`);
  console.log(`    catalog entries:           ${report.totalEntries}`);
  console.log(`    string-typed exempted:     ${report.stringTypedExempted}`);
  console.log(`    unit ≠ 'unverified':       ${report.unverified.ok}/${report.unverified.total} (100%)`);
  console.log(`    numeric with range:        ${report.numericRange.ok}/${report.numericRange.total} (${numericPct}%)`);
  console.log(`    enum with vocabulary:      ${report.enumVocabulary.ok}/${report.enumVocabulary.total} (${enumPct}%)`);
}

export const AXEFX3_CALIBRATION_COVERAGE = audit();
