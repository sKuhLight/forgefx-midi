/**
 * Deep equality for decoded-param goldens: exact everywhere except floats.
 *
 * The frozen `*.params.expected.json` goldens store decoded display values as exact IEEE
 * doubles. The log-taper params (gen3/taper.ts, `Math.pow`) and the other scaled knob decodes
 * can land on a neighbouring double depending on the platform / V8 build (`Math.pow` / `exp`
 * are not required to be correctly rounded and differ in the last ulp between, say, Windows
 * Node 25 and Linux Node 22). That is not a decode change, so floats are compared with a tight
 * relative tolerance; structure, keys, strings, booleans, nulls and integer-valued numbers are
 * still compared exactly, and any real difference (a wrong raw word, taper, range, ordinal)
 * is orders of magnitude above the tolerance and still fails.
 */

/** Relative tolerance for non-integer numbers: |a-b| <= tol * max(1, |a|, |b|). A few hundred ulps. */
export const GOLDEN_FLOAT_REL_TOL = 1e-12;

function floatsClose(a: number, e: number): boolean {
  if (a === e) return true;
  if (!Number.isFinite(a) || !Number.isFinite(e)) return false;
  return Math.abs(a - e) <= GOLDEN_FLOAT_REL_TOL * Math.max(1, Math.abs(a), Math.abs(e));
}

/** Deep equality with a path-reporting error, JSON-normalized (undefined keys drop). */
export function assertDeepEqual(actual: unknown, expected: unknown, path: string): void {
  const a = JSON.parse(JSON.stringify(actual ?? null));
  const e = JSON.parse(JSON.stringify(expected ?? null));
  diff(a, e, path);
}

function diff(a: unknown, e: unknown, path: string): void {
  if (Array.isArray(e)) {
    if (!Array.isArray(a)) throw new Error(`${path}: expected array, got ${typeof a}`);
    if (a.length !== e.length) throw new Error(`${path}: length ${a.length} !== expected ${e.length}`);
    for (let i = 0; i < e.length; i++) diff(a[i], e[i], `${path}[${i}]`);
    return;
  }
  if (e !== null && typeof e === 'object') {
    if (a === null || typeof a !== 'object') throw new Error(`${path}: expected object, got ${JSON.stringify(a)}`);
    const ak = Object.keys(a as object).sort();
    const ek = Object.keys(e as object).sort();
    if (ak.join(',') !== ek.join(',')) {
      throw new Error(`${path}: keys [${ak.join(',')}] !== expected [${ek.join(',')}]`);
    }
    for (const k of ek) diff((a as Record<string, unknown>)[k], (e as Record<string, unknown>)[k], `${path}.${k}`);
    return;
  }
  // Numbers: exact when both are integers (raw words, ordinals, counts); a tight relative
  // tolerance otherwise (decoded display floats).
  if (typeof a === 'number' && typeof e === 'number' && !(Number.isInteger(a) && Number.isInteger(e))) {
    if (floatsClose(a, e)) return;
  } else if (a === e) {
    return;
  }
  throw new Error(`${path}: ${JSON.stringify(a)} !== expected ${JSON.stringify(e)}`);
}
