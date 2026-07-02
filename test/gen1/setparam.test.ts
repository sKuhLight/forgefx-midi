/**
 * Axe-Fx Standard / Ultra (gen-1) codec golden vectors.
 *
 * Source: the published "Axe-FX Ultra System Exclusive Messages" doc. The
 * headline golden is the doc's own worked example, built from the generated
 * catalog so it exercises the data AND the encoder together:
 *
 *   set Compressor 2 Knee = SOFTER
 *     -> F0 00 01 74 01 02 05 06 05 00 02 00 01 F7
 *
 * Failure means the codec drifted from the doc's byte-level wire reality.
 */
import {
  buildSetParam,
  parseSetParam,
  nibbleSplit,
  nibbleJoin,
  AXE_FX_GEN1_MODEL_ID,
  KNOWN_PARAMS,
  blockIdFor,
} from '../../src/gen1/index.js';

function eqBytes(actual: readonly number[], expected: readonly number[]): boolean {
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) return false;
  return true;
}
function hex(bs: readonly number[]): string {
  return Array.from(bs, (b) => b.toString(16).padStart(2, '0')).join(' ');
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

interface Case {
  label: string;
  built: number[];
  expected: number[];
}

const CASES: Case[] = [
  // Literal worked example: block 101, param 5, value 2.
  {
    label: 'Compressor 2 Knee = SOFTER (literal)',
    built: buildSetParam(101, 5, 2),
    expected: [0xf0, 0x00, 0x01, 0x74, 0x01, 0x02, 0x05, 0x06, 0x05, 0x00, 0x02, 0x00, 0x01, 0xf7],
  },
  // Amp 1 TYPE = max (70 = 0x46 -> 06 04); block 106 = 0x6A -> 0A 06.
  {
    label: 'Amp 1 TYPE = 70 (max)',
    built: buildSetParam(106, 0, 70),
    expected: [0xf0, 0x00, 0x01, 0x74, 0x01, 0x02, 0x0a, 0x06, 0x00, 0x00, 0x06, 0x04, 0x01, 0xf7],
  },
  // Non-trivial value 200 = 0xC8 -> 08 0C (catches a nibble/septet confusion).
  {
    label: 'Amp 1 Drive = 200',
    built: buildSetParam(106, 1, 200),
    expected: [0xf0, 0x00, 0x01, 0x74, 0x01, 0x02, 0x0a, 0x06, 0x01, 0x00, 0x08, 0x0c, 0x01, 0xf7],
  },
];

export const AXEFXGEN1_GOLDEN_CASE_COUNT = CASES.length;

export function runAxeFxGen1SetParamTests(): void {
  // 1. Byte-exact goldens.
  for (const c of CASES) {
    if (!eqBytes(c.built, c.expected)) {
      throw new Error(`gen-1 golden "${c.label}":\n  built    ${hex(c.built)}\n  expected ${hex(c.expected)}`);
    }
  }

  // 2. nibble round-trip over the full 0..255 range (the encoder under test).
  for (let v = 0; v <= 255; v++) {
    const [lo, hi] = nibbleSplit(v);
    assert(lo >= 0 && lo <= 15 && hi >= 0 && hi <= 15, `nibble bytes out of range for ${v}`);
    assert(nibbleJoin(lo, hi) === v, `nibble round-trip failed for ${v}`);
  }
  assert(AXE_FX_GEN1_MODEL_ID === 0x01, 'gen-1 model byte must be 0x01');

  // 3. Range guard.
  let threw = false;
  try { nibbleSplit(256); } catch { threw = true; }
  assert(threw, 'nibbleSplit must reject 256');

  // 4. parseSetParam inverts buildSetParam.
  const round = parseSetParam(buildSetParam(106, 1, 200));
  assert(!!round && round.blockId === 106 && round.paramId === 1 && round.value === 200, 'parseSetParam round-trip failed');

  // 5. Catalog-derived worked example: the generated catalog must place
  //    Compressor 2 at blockId 101 and Knee at paramId 5 with value 2 = SOFTER,
  //    reproducing the literal golden above end-to-end.
  const compKnee = KNOWN_PARAMS['compressor.knee'];
  assert(!!compKnee, 'catalog missing compressor.knee');
  assert(compKnee.paramId === 5, `compressor.knee paramId expected 5, got ${compKnee.paramId}`);
  const softer = compKnee.enumValues?.[2];
  assert(/SOFTER/i.test(softer ?? ''), `compressor.knee value 2 expected SOFTER, got ${softer}`);
  const comp2 = blockIdFor('compressor', 2);
  assert(comp2 === 101, `compressor instance 2 blockId expected 101, got ${comp2}`);
  const derived = buildSetParam(comp2!, compKnee.paramId, 2);
  assert(
    eqBytes(derived, CASES[0].expected),
    `catalog-derived worked example mismatch:\n  ${hex(derived)}\n  ${hex(CASES[0].expected)}`,
  );
}
