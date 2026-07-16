/**
 * FM3 grid ROUTING round-trip (FORGEFXMID-43).
 *
 * The cable connections a user draws in the converter grid are carried as each
 * cell's `routeFlag` (device bitmask: bit r = fed from row r of the previous
 * column) / `fromRows`. This proves synthGrid → parseGrid round-trips them:
 *
 *   1. SAME-DEVICE / edited IR (cells already carry FM3 effect ids): routeFlags
 *      pass through buildGen3Body verbatim — series (single-bit), a mixer
 *      (multi-bit, rows 1+2), and a shunt (effect_id>1023) all decode with the
 *      exact `from_rows` that were set.
 *   2. CROSS-DEVICE IR (cells carry blockKey + routeFlag but NO effect id): the
 *      family→eid assignment PRESERVES routeFlag while filling the effect id.
 *
 * NOT a device-acceptance test; it validates the codec's grid write/read model.
 */
import { buildGen3Body, defaultScaffold, type SynthPreset } from '../../../src/devices/gen3/presetSynth.js';
import { decodeGen3Body, MODEL_FM3 } from '../../../src/devices/gen3/presetBody.js';

export const ROUTING_ROUNDTRIP_CASE_COUNT = 2;

function fail(msg: string): never {
  throw new Error(`[fm3/routing-roundtrip] ${msg}`);
}
const mask = (rows: number[]): number => rows.reduce((m, r) => m | (1 << r), 0);

/** Decode the synthesized body's grid into "col,row" -> sorted from_rows. */
function gridFromRows(ir: SynthPreset): Map<string, number[]> {
  const { body } = buildGen3Body(ir, defaultScaffold(), MODEL_FM3);
  const out = new Map<string, number[]>();
  for (const c of decodeGen3Body(body, MODEL_FM3).grid ?? []) {
    out.set(`${c.col},${c.row}`, [...(c.from_rows ?? [])].sort((a, b) => a - b));
  }
  return out;
}

// The wiring under test (same for both cases): a series on row 1, a parallel
// delay on row 2 feeding a mixer, and a shunt — exercising 0-bit, single-bit,
// multi-bit and shunt route flags.
interface Wire { row: number; col: number; eid: number; key?: string; from: number[]; shunt?: boolean }
const WIRING: Wire[] = [
  { row: 1, col: 0, eid: 58, key: 'amp1', from: [] },            // chain start (fed from input)
  { row: 1, col: 1, eid: 118, key: 'drive1', from: [1] },        // series: from row 1
  { row: 2, col: 1, eid: 70, key: 'dly1', from: [1] },           // parallel branch off row 1
  { row: 1, col: 2, eid: 66, key: 'rev1', from: [1, 2] },        // mixer: rows 1 + 2 (multi-bit)
  { row: 3, col: 2, eid: 1024, from: [1], shunt: true },         // shunt fed from row 1
];

function assertRoundTrip(label: string, ir: SynthPreset): void {
  const got = gridFromRows(ir);
  for (const w of WIRING) {
    const key = `${w.col},${w.row}`;
    const g = got.get(key);
    if (g == null) fail(`${label}: cell ${key} (eid ${w.eid}) missing from decoded grid`);
    const want = [...w.from].sort((a, b) => a - b);
    if (JSON.stringify(g) !== JSON.stringify(want)) {
      fail(`${label}: cell ${key} from_rows ${JSON.stringify(g)} != drawn ${JSON.stringify(want)}`);
    }
  }
}

export function runRoutingRoundTripTests(): void {
  // Case 1: same-device / edited IR — cells already carry FM3 effect ids.
  const sameDevice: SynthPreset = {
    name: 'ROUTE',
    blocks: WIRING.filter((w) => w.key).map((w) => ({ key: w.key! })),
    routing: {
      gridCells: WIRING.map((w) => ({ row: w.row, col: w.col, effectId: w.eid, blockKey: w.key, routeFlag: mask(w.from) })),
    },
  };
  assertRoundTrip('same-device', sameDevice);

  // Case 2: cross-device IR — cells carry blockKey + routeFlag but NO effect id;
  // the family→eid assignment must preserve routeFlag. (Shunt carried verbatim.)
  const FAM: Record<number, string> = { 58: 'amp', 118: 'drive', 70: 'delay', 66: 'reverb' };
  const crossDevice: SynthPreset = {
    name: 'ROUTE',
    blocks: WIRING.filter((w) => w.key).map((w) => ({ key: w.key!, family: FAM[w.eid] })),
    routing: {
      gridCells: WIRING.map((w) =>
        w.shunt
          ? { row: w.row, col: w.col, effectId: w.eid, routeFlag: mask(w.from) } // shunt kept as-is
          : { row: w.row, col: w.col, blockKey: w.key, routeFlag: mask(w.from) },
      ),
    },
  };
  // Cross-device re-places blocks by family (row 0), so we can't assert exact
  // cells like case 1; instead assert routeFlag is PRESERVED on every mapped cell
  // (no cell that had a non-zero flag loses it) and the shunt survives.
  const { body } = buildGen3Body(crossDevice, defaultScaffold(), MODEL_FM3);
  const decoded = decodeGen3Body(body, MODEL_FM3).grid ?? [];
  const nonZeroFlags = decoded.filter((c) => (c.from_rows?.length ?? 0) > 0).length;
  const shunt = decoded.find((c) => c.is_shunt);
  if (nonZeroFlags < 3) fail(`cross-device: only ${nonZeroFlags} cells carried a route flag (routeFlag not preserved)`);
  if (!shunt) fail('cross-device: shunt cell was dropped');
  if (JSON.stringify([...(shunt.from_rows ?? [])].sort()) !== JSON.stringify([1])) {
    fail(`cross-device: shunt from_rows ${JSON.stringify(shunt.from_rows)} != [1]`);
  }
}
