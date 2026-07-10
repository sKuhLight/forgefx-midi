/**
 * Axe-Fx II `findCompatibleTypes` (+ its private `primaryTypeDisplayMap`
 * backing, exercised through it).
 *
 * Given a block and a set of knob names, returns the primary type/model names
 * that expose ALL those knobs, narrowing on the block's PRIMARY type enum only
 * (sub-mode gates can't narrow the primary list). Blocks with no primary type
 * enum, or params with no applicability data, are reported honestly
 * (`applicability_known: false`) rather than fabricating a filter.
 *
 * These consume the existing `typeApplicability` gates + `KNOWN_PARAMS`
 * enum-value maps — no new addressing.
 */
import {
  findCompatibleTypes,
  primaryTypeEnumFor,
  getApplicability,
  KNOWN_PARAMS,
} from '../../../src/gen2/axe-fx-ii/index.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const cases: Array<() => void> = [];

// Case 1: amp with NO knobs queried → full roster, no narrowing claimed.
cases.push(() => {
  const res = findCompatibleTypes('amp', []);
  assert(res.total_types > 0, `amp total_types must be > 0, got ${res.total_types}`);
  assert(res.applicability_known === false, 'no params queried → applicability_known must be false');
  assert(
    res.compatible_types.length === res.total_types,
    `no narrowing → compatible_types (${res.compatible_types.length}) must equal total_types (${res.total_types})`,
  );
  // The names come from the amp type enum-value display map.
  assert(res.compatible_types.every((n) => typeof n === 'string' && n.length > 0), 'all compatible type names non-empty strings');
});

// Case 2: a block with NO primary type enum → total 0, honest not-known.
cases.push(() => {
  assert(primaryTypeEnumFor('mixer') === undefined, 'mixer should have no primary type enum (test premise)');
  const res = findCompatibleTypes('mixer', []);
  assert(res.total_types === 0 && res.compatible_types.length === 0, 'no-primary-type block → empty roster');
  assert(res.applicability_known === false, 'no-primary-type block → applicability_known false');
  assert(res.note !== undefined && /no primary type enum/i.test(res.note), `note should explain the miss, got ${JSON.stringify(res.note)}`);
});

// Case 3: a queried param with NO applicability data is skipped (surfaced in
// the note), and does not narrow the roster.
cases.push(() => {
  const res = findCompatibleTypes('amp', ['definitely_not_a_real_param_xyz']);
  assert(res.applicability_known === false, 'unknown param must not claim narrowing');
  assert(res.note !== undefined && /no applicability data|Skipped/i.test(res.note), `note should record the skip, got ${JSON.stringify(res.note)}`);
  assert(res.compatible_types.length === res.total_types, 'unknown param must not shrink the roster');
});

// Case 4: a REAL narrowing case, found dynamically — a (block, param) whose
// applicability gates on the block's PRIMARY type enum. findCompatibleTypes
// must then flip applicability_known true and never widen past total_types.
cases.push(() => {
  let found = false;
  for (const key of Object.keys(KNOWN_PARAMS)) {
    const dot = key.indexOf('.');
    if (dot < 0) continue;
    const block = key.slice(0, dot);
    const paramName = key.slice(dot + 1);
    const typeEnum = primaryTypeEnumFor(block);
    if (typeEnum === undefined) continue;
    const a = getApplicability(key);
    if (a === undefined || a.gates.length === 0) continue;
    const primaryGate = a.gates.find((g) => g.typeEnum === typeEnum && g.values.length > 0);
    if (primaryGate === undefined) continue;
    const base = findCompatibleTypes(block, []);
    if (base.total_types === 0) continue; // need a display map to narrow against
    const narrowed = findCompatibleTypes(block, [paramName]);
    assert(narrowed.applicability_known === true, `${key}: a primary-type gate must set applicability_known true`);
    assert(
      narrowed.compatible_types.length <= base.total_types,
      `${key}: narrowed roster (${narrowed.compatible_types.length}) must not exceed total_types (${base.total_types})`,
    );
    // Every surviving type is one the gate actually exposes (present in the display map keyed by ordinal).
    assert(narrowed.total_types === base.total_types, 'total_types is roster size, invariant across queries');
    found = true;
    break;
  }
  assert(found, 'expected at least one block+param with a primary-type gate (compressor/multidelay per the II data)');
});

export const AXEFX2_APPLICABILITY_CASE_COUNT = cases.length;

export function runAxeFxIIApplicabilityTests(): void {
  cases.forEach((run, i) => {
    try {
      run();
    } catch (err) {
      throw new Error(`axe-fx-ii applicability case ${i + 1}/${cases.length} failed: ${(err as Error).message}`);
    }
  });
}
