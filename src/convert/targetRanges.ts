/**
 * Target-device parameter range resolution for the P2 conversion engine.
 *
 * When the engine lowers a param onto a target device it range-validates the
 * value against whatever range data the codebase actually ships for that
 * device. This module is deliberately conservative: it returns a range ONLY
 * when the data is real and keyed cleanly by native param name. Where no such
 * data exists the resolver returns `undefined` and the engine emits a
 * `param-unverified` event instead of guessing a range.
 *
 * Coverage today:
 *   - `am4`         — real display ranges from the AM4 param registry
 *                     (`KNOWN_PARAMS`, keyed `<block>.<name>`).
 *   - gen-3 family  — the amp tone knobs, which the gen-3 body decoder scales
 *                     to a device-true 0..10 display range (see the gen-3
 *                     adapter's `AMP_KNOB_MAX`). Other gen-3 params have no
 *                     name-keyed range table here → `undefined`.
 *   - everything else → `undefined` (param-unverified).
 */

import type { ConverterDeviceId, ConverterFamily } from './families.js';
import { normalizeConceptPort } from '../core/protocol-generic/concept-keys.js';
import { KNOWN_PARAMS } from '../am4/params.js';

/** A validated target range in the device's DISPLAY units. */
export interface TargetRange {
  readonly min: number;
  readonly max: number;
}

/**
 * gen-3 amp tone knobs share a 0..10 display range (the body decoder's scale).
 * These are the amp params the gen-3 / AM4 adapters actually lift, so this
 * small real table gives the amp conversion path meaningful clamping in both
 * directions without wiring the full (family, paramId) range tables by name.
 */
const GEN3_AMP_KNOB_RANGE: TargetRange = { min: 0, max: 10 };

/** Native amp-knob names (gen-3 display words) that use the 0..10 range. */
const GEN3_AMP_KNOB_NAMES: ReadonlySet<string> = new Set([
  'drive',
  'bass',
  'mid',
  'treble',
  'presence',
  'master',
  'level',
  'depth',
  'bright',
]);

/**
 * Resolve the display-unit range for `nativeName` on `device`'s `family` block,
 * or `undefined` when no real range data is available (→ param-unverified).
 */
export function resolveTargetRange(
  device: ConverterDeviceId,
  family: ConverterFamily,
  nativeName: string,
): TargetRange | undefined {
  const port = normalizeConceptPort(device);

  if (port === 'am4') {
    const rec = (KNOWN_PARAMS as Record<string, { displayMin?: number; displayMax?: number }>)[
      `${family}.${nativeName}`
    ];
    if (
      rec &&
      typeof rec.displayMin === 'number' &&
      typeof rec.displayMax === 'number' &&
      rec.displayMax !== rec.displayMin
    ) {
      const min = Math.min(rec.displayMin, rec.displayMax);
      const max = Math.max(rec.displayMin, rec.displayMax);
      return { min, max };
    }
    return undefined;
  }

  // gen-3 family (III / FM9 / FM3 / VP4 all normalize to the 'axe-fx-iii' port).
  if (port === 'axe-fx-iii' && family === 'amp' && GEN3_AMP_KNOB_NAMES.has(nativeName)) {
    return GEN3_AMP_KNOB_RANGE;
  }

  return undefined;
}
