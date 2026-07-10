/**
 * AM4 `internalFromDisplay` — the exact inverse of `decode` (display → the
 * normalized [0,1] internal float the read register carries).
 *
 * The property under test is round-trip identity in BOTH directions, for a
 * LINEAR param and a LOG10 param:
 *   - decode(param, internalFromDisplay(param, d)) === d  for every display d
 *     in [displayMin, displayMax];
 *   - internalFromDisplay(param, decode(param, x)) === x  for every internal x
 *     in [0, 1].
 * This anchors the inverse independent of hardware: the two functions are
 * branch-for-branch mirrors (including the degenerate-log10 linear fallback),
 * so the composition must be identity to within float epsilon.
 */
import { decode, internalFromDisplay, KNOWN_PARAMS } from '../../src/am4/index.js';
import type { Param } from '../../src/am4/index.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

const cases: Array<() => void> = [];

// Pick a concrete LINEAR param (amp.gain: knob_0_10, no scaling) and a LOG10
// param (first registered scaling:'log10' entry with a positive range).
const linear = KNOWN_PARAMS['amp.gain'] as unknown as Param;
const log10Entry = Object.entries(KNOWN_PARAMS).find(
  ([, p]) => (p as { scaling?: string }).scaling === 'log10'
    && (p as Param).displayMin > 0
    && (p as { unit?: string }).unit !== 'enum',
);

const SAMPLE_FRACTIONS = [0, 0.05, 0.1, 0.25, 0.5, 0.6667, 0.75, 0.9, 1];

function roundTripCase(label: string, param: Param): () => void {
  return () => {
    const { displayMin, displayMax } = param;
    // display → internal → display
    for (const t of SAMPLE_FRACTIONS) {
      const d = displayMin + t * (displayMax - displayMin);
      const internal = internalFromDisplay(param, d);
      const back = decode(param, internal);
      assert(close(back, d), `${label}: decode∘internalFromDisplay(${d}) = ${back}, expected ${d}`);
    }
    // internal → display → internal (the read register's [0,1] space)
    for (const x of SAMPLE_FRACTIONS) {
      const d = decode(param, x);
      const x2 = internalFromDisplay(param, d);
      assert(close(x2, x), `${label}: internalFromDisplay∘decode(${x}) = ${x2}, expected ${x}`);
    }
  };
}

// Case 1: linear param (amp.gain, 0..10, no scaling).
cases.push(() => {
  assert(linear !== undefined, 'amp.gain must be registered');
  assert((linear as { scaling?: string }).scaling === undefined, 'amp.gain must be linear (no scaling)');
  roundTripCase('linear amp.gain', linear)();
});

// Case 2: log10 param (first scaling:'log10' entry).
cases.push(() => {
  assert(log10Entry !== undefined, 'expected at least one scaling:log10 param in KNOWN_PARAMS');
  const [key, p] = log10Entry!;
  const param = p as unknown as Param;
  assert(param.displayMin > 0, `${key}: log10 test param must have displayMin > 0`);
  roundTripCase(`log10 ${key}`, param)();
});

// Case 3: enum passthrough — internalFromDisplay returns the display value
// unchanged for an enum unit (mirrors decode's enum handling).
cases.push(() => {
  const enumEntry = Object.entries(KNOWN_PARAMS).find(([, p]) => (p as { unit?: string }).unit === 'enum');
  if (enumEntry === undefined) return; // no enum param registered — nothing to assert
  const param = enumEntry[1] as unknown as Param;
  for (const v of [0, 1, 2, 3]) {
    assert(internalFromDisplay(param, v) === v, `enum internalFromDisplay(${v}) must pass through`);
  }
});

// Case 4: degenerate range → 0 (decode is constant, so the inverse is 0).
cases.push(() => {
  const degenerate = { unit: 'count', displayMin: 5, displayMax: 5 } as unknown as Param;
  assert(internalFromDisplay(degenerate, 5) === 0, 'degenerate (min===max) range must return 0');
});

export const AM4_INTERNAL_FROM_DISPLAY_CASE_COUNT = cases.length;

export function runAm4InternalFromDisplayTests(): void {
  cases.forEach((run, i) => {
    try {
      run();
    } catch (err) {
      throw new Error(`am4 internalFromDisplay case ${i + 1}/${cases.length} failed: ${(err as Error).message}`);
    }
  });
}
