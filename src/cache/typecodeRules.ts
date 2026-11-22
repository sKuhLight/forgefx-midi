/**
 * Typecode rules: what a parameter's `typecode` says about its value taper, its unit and
 * its role.
 *
 * Every definition row carries a `typecode`, an undecoded device bitfield. Comparing it with
 * the tapers and units the devices themselves reported shows a stable structure:
 *
 *   - the MIDDLE NIBBLE (`(tc >> 4) & 0xf`) predicts the taper: 4 is a log taper, 3 and 5..9
 *     are linear, every other nibble predicts nothing. The few misses are all `custom`
 *     curves; a row that was measured linear is never predicted log, and vice versa;
 *   - the HIGH BYTE (`tc >> 8`) appears to select a unit family, but only a handful of exact
 *     typecodes are applied here (see `UNIT_BY_TYPECODE`): the same low byte means different
 *     units under different high bytes, so a unit is only ever derived from the full typecode;
 *   - a few low bytes mark a ROLE (bypass, 0..10 knob, monitor, toggle row).
 *
 * The table is pure data plus three total functions. It is applied by consumers when values
 * are shown, never stored in a derived row, so refining it never needs a cache schema bump.
 *
 * Applicability: the table was derived from FM3 measurements and checked against the committed
 * FM3, FM9 and Axe-Fx III catalogs (`test/cache/typecode-rules.test.ts` pins the agreement); it
 * holds for all three, so the functions take no model argument.
 *
 * Pure and browser-safe: no `node:*`, no I/O.
 */
import { BYPASS_TYPECODE } from './fingerprint.js';

/**
 * How well a rule is supported.
 *   - `measured`: the exact typecode itself was measured on devices with at least 95 %
 *     agreement over at least five rows;
 *   - `rule`: extrapolated from the typecode's class (the middle nibble); the exact code was
 *     never measured, or its own measurements agree less than 95 %.
 */
export type TypecodeConfidence = 'measured' | 'rule';

/** Value taper a typecode predicts. A `custom` curve is never predicted. */
export type TypecodeTaperKind = 'linear' | 'log';

/**
 * Unit a typecode implies, as a catalog unit code (a subset of the gen-3 `Unit` union, so it
 * can be used wherever a catalog unit is expected).
 */
export type TypecodeUnitCode = 'hz' | 'db' | 'percent';

/** Role a typecode marks. */
export type TypecodeClassKind = 'bypass' | 'knob-0-10' | 'monitor' | 'toggle-row';

export interface TypecodeTaperRule {
  taper: TypecodeTaperKind;
  confidence: TypecodeConfidence;
}

export interface TypecodeUnitRule {
  unit: TypecodeUnitCode;
  confidence: TypecodeConfidence;
}

/** Typecode of dimensionless knobs: displayed on a linear 0..10 scale (see `assign.ts`). */
export const KNOB_0_10_TYPECODE = 0x52;

/** Low byte of rows the device reports as live readouts or action slots (semantics unconfirmed). */
export const MONITOR_TYPECODE_LOW_BYTE = 0xf0;

/** Low byte of per-block toggle slots (all-zero on FM3/FM9, a 0..1 toggle on the Axe-Fx III). */
export const TOGGLE_ROW_TYPECODE_LOW_BYTE = 0xd0;

/**
 * Exact typecodes whose taper was measured: at least five reliable measurements pooled over
 * FM3, FM9 and Axe-Fx III devices, at least 95 % of them equal to the middle-nibble
 * prediction. Typecodes outside this set that still hit the nibble rule are
 * reported with `confidence: 'rule'` (among them 0x42, 0x243 and 0x432, whose own
 * measurements agree less than 95 %, mostly because some of their rows are `custom`).
 */
const MEASURED_TAPER_TYPECODES: ReadonlySet<number> = new Set([
  0x31, 0x32, 0x33, 0x43, 0x44, 0x52, 0x62, 0x91,
  0x132, 0x161, 0x162, 0x181,
  0x240, 0x241, 0x242,
  0x431, 0x442, 0x443,
  0x531, 0x571, 0x631,
]);

/**
 * Typecodes that imply a unit. Each was measured on an FM3 with every reading equal to the
 * unit (at least seven rows per code) and agrees with the committed catalogs wherever they
 * name a unit. Keys are FULL typecodes. In low-byte shorthand they are 0x40/0x41 (Hz),
 * 0x61/0x62/0x81 (dB) and 0x71 (percent), carrying the high bytes 2, 1 and 5. The same low
 * byte under another high byte means another unit (0x441 is milliseconds) or none (a bare
 * 0x62), so matching the low byte alone would mislabel those rows.
 *
 * Deliberately short: a typecode whose rows carry mixed or no units (0x31, 0x32, 0x33, 0x42,
 * 0x43, 0x52, 0x91, ...) implies none.
 */
const UNIT_BY_TYPECODE: ReadonlyMap<number, TypecodeUnitCode> = new Map<number, TypecodeUnitCode>([
  [0x240, 'hz'],
  [0x241, 'hz'],
  [0x161, 'db'],
  [0x162, 'db'],
  [0x181, 'db'],
  [0x571, 'percent'],
]);

/** A typecode is an unsigned 16-bit integer; anything else is not a typecode. */
function isTypecode(tc: number): boolean {
  return Number.isInteger(tc) && tc >= 0 && tc <= 0xffff;
}

/**
 * Value taper the typecode predicts for a FLOAT row, or `null` when it predicts none.
 *
 * Middle nibble 4 is `log`; 3 and 5..9 are `linear`; nibbles 0..2 and a..f (which include the
 * bypass 0xE0, the toggle 0xD0 and the monitor 0xF0 low bytes) predict nothing: their rows
 * either were never swept or turned out `custom`. An explicit taper (device-measured or
 * catalog) always outranks this prediction.
 */
export function typecodeTaper(tc: number): TypecodeTaperRule | null {
  if (!isTypecode(tc)) return null;
  const nibble = (tc >> 4) & 0xf;
  const taper: TypecodeTaperKind | null = nibble === 4 ? 'log' : nibble >= 3 && nibble <= 9 ? 'linear' : null;
  if (taper === null) return null;
  return { taper, confidence: MEASURED_TAPER_TYPECODES.has(tc) ? 'measured' : 'rule' };
}

/**
 * Unit the typecode implies, or `null` for every typecode that has none (most of them).
 * Consumers use it only when neither the device nor the catalog supplies a unit.
 */
export function typecodeUnit(tc: number): TypecodeUnitRule | null {
  if (!isTypecode(tc)) return null;
  const unit = UNIT_BY_TYPECODE.get(tc);
  return unit === undefined ? null : { unit, confidence: 'measured' };
}

/**
 * Role the typecode marks, or `null`.
 *   - `bypass`: the block's bypass control (0xE0, `BYPASS_TYPECODE`);
 *   - `knob-0-10`: a dimensionless knob displayed on a linear 0..10 scale (0x52);
 *   - `monitor`: low byte 0xF0, live readouts and action slots (semantics unconfirmed);
 *   - `toggle-row`: low byte 0xD0, per-block toggle slots (all-zero rows on FM3/FM9).
 */
export function typecodeClass(tc: number): TypecodeClassKind | null {
  if (!isTypecode(tc)) return null;
  if (tc === BYPASS_TYPECODE) return 'bypass';
  if (tc === KNOB_0_10_TYPECODE) return 'knob-0-10';
  const low = tc & 0xff;
  if (low === MONITOR_TYPECODE_LOW_BYTE) return 'monitor';
  if (low === TOGGLE_ROW_TYPECODE_LOW_BYTE) return 'toggle-row';
  return null;
}
