/**
 * Shared display-scale readback-tolerance helpers: `displayQuantum` +
 * `withinDisplayQuantum`.
 *
 * The wire field is a fixed 65535-step ladder (0..65534), so a wide display
 * range cannot store every display value exactly — a readback lands on the
 * nearest rung. `displayQuantum` sizes one rung in display units at a given
 * wire position (constant for linear, value-dependent for log10);
 * `withinDisplayQuantum` uses it as the match tolerance for a written↔read
 * comparison. Both build only on the existing `displayToWire`/`wireToDisplay`.
 */
import {
  displayQuantum,
  withinDisplayQuantum,
  displayToWire,
  wireToDisplay,
} from '../../src/shared/index.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const KNOB = { displayMin: 0, displayMax: 10 } as const; // linear 0..10
const DELAY = { displayMin: 1, displayMax: 8000 } as const; // wide linear ms
const FREQ = { displayMin: 20, displayMax: 2000, displayScale: 'log10' } as const;

const cases: Array<() => void> = [];

// Case 1: linear quantum == range / 65534, constant across the ladder.
cases.push(() => {
  const expected = (KNOB.displayMax - KNOB.displayMin) / 65534;
  const qMid = displayQuantum(KNOB, 32767);
  const qLow = displayQuantum(KNOB, 100);
  const qHigh = displayQuantum(KNOB, 60000);
  assert(Math.abs(qMid - expected) < 1e-9, `linear quantum ${qMid} != ${expected}`);
  assert(Math.abs(qLow - expected) < 1e-9 && Math.abs(qHigh - expected) < 1e-9, 'linear quantum must be constant');
});

// Case 2: wide linear range — one wire step is ~0.122 ms, so a 0.1 ms readback
// delta is within tolerance but a 1 ms delta is not.
cases.push(() => {
  const q = displayQuantum(DELAY, displayToWire(400, DELAY));
  assert(q > 0.1 && q < 0.2, `delay quantum near 400 ms should be ~0.122, got ${q}`);
  assert(withinDisplayQuantum(400.1, 400, DELAY), '±0.1 ms must be within one delay quantum');
  assert(!withinDisplayQuantum(401, 400, DELAY), '±1 ms must exceed one delay quantum');
});

// Case 3: two ADJACENT wire rungs differ by exactly one quantum, so a readback
// landing on the neighbouring rung counts as a match (the on-rung display value
// is the exact `expected`, avoiding the up-to-half-a-rung quantization residue
// a raw target would carry).
cases.push(() => {
  const w = displayToWire(400, DELAY);
  const here = wireToDisplay(w, DELAY);
  const oneRungUp = wireToDisplay(w + 1, DELAY);
  assert(withinDisplayQuantum(oneRungUp, here, DELAY), 'one wire rung away must count as a match');
  // Two rungs away must exceed one quantum (tolerance is genuinely tight).
  const twoRungsUp = wireToDisplay(w + 2, DELAY);
  assert(!withinDisplayQuantum(twoRungsUp, here, DELAY), 'two wire rungs away must exceed one quantum');
});

// Case 4: log10 quantum GROWS with value (local step near the top of a
// frequency sweep is far larger than near the bottom).
cases.push(() => {
  const qLow = displayQuantum(FREQ, 200); // near 20 Hz end
  const qHigh = displayQuantum(FREQ, 65000); // near 2000 Hz end
  assert(qHigh > qLow, `log10 quantum must grow with value: high ${qHigh} should exceed low ${qLow}`);
  // withinDisplayQuantum sizes the quantum at the EXPECTED value's wire position,
  // so a tolerance that passes near 2000 Hz would be too loose near 20 Hz.
  const near2000 = wireToDisplay(displayToWire(1900, FREQ) + 1, FREQ);
  assert(withinDisplayQuantum(near2000, 1900, FREQ), 'one rung near 1900 Hz must match');
});

// Case 5: exact equality is trivially within quantum.
cases.push(() => {
  assert(withinDisplayQuantum(5, 5, KNOB), 'equal values must be within quantum');
  assert(withinDisplayQuantum(2000, 2000, FREQ), 'equal log10 values must be within quantum');
});

export const SHARED_DISPLAYSCALE_CASE_COUNT = cases.length;

export function runSharedDisplayScaleTests(): void {
  cases.forEach((run, i) => {
    try {
      run();
    } catch (err) {
      throw new Error(`shared displayScale case ${i + 1}/${cases.length} failed: ${(err as Error).message}`);
    }
  });
}
