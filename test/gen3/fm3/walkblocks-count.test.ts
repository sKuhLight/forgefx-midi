/**
 * FM3 block-chain walk — placed-block COMPLETENESS + LABELLING (FORGEFXMID-41).
 *
 * `decodeGen3Body().blocks` (walkBlocks) must emit EXACTLY one record per
 * non-shunt grid block, correctly labelled. The pre-fix walk identified each
 * chain record by its column-count signature, which is lossy: cols collide
 * (Input eid 37 ↔ Vol/Pan eid 102 both cols=10; Output eid 42 ↔ PEQ cols=26)
 * and the cols→name map dropped placed families (cols-33 PEQ, cols-15 Vol/Pan),
 * so it under-counted (preset-55 10/11, preset-79 10/12) and mislabelled
 * Input/Output. The fix keys each record by its offset-12 grid-eid signature.
 *
 * These two fixtures were the diagnosed regressions: preset-55 places a cols-10
 * Input, a cols-26 Output and a cols-15 Vol/Pan; preset-79 places two cols-33
 * PEQ instances plus Input/Output. Both were mis-decoded before the fix.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePresetDump } from '../../../src/devices/gen3/presetDump.js';
import { decodeRawPatch } from '../../../src/devices/gen3/presetHuffman.js';
import { decodeGen3Body, effectFamily } from '../../../src/devices/gen3/presetBody.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FM3 = 0x11;

export const WALKBLOCKS_COUNT_CASE_COUNT = 2;

function fail(msg: string): never {
  throw new Error(`[fm3/walkblocks-count] ${msg}`);
}
function assert(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
}

const u16 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8)) & 0xffff;

/** Expected placed-block count + a few must-be-present, must-be-labelled blocks. */
interface Case {
  preset: number;
  count: number; // grid non-shunt count = expected walkBlocks length
}
const CASES: Case[] = [
  { preset: 55, count: 11 },
  { preset: 79, count: 12 },
];

export function runWalkBlocksCountTests(): void {
  for (const { preset, count } of CASES) {
    const syx = new Uint8Array(readFileSync(join(FIXTURES, `preset-${preset}.syx`)));
    const parsed = parsePresetDump(syx, 0, FM3);
    const decoded = decodeRawPatch(parsed.chunkPayloads);
    assert(decoded.crcValid, `preset-${preset}: CRC invalid — fixture corrupt?`);
    const body = decoded.body;

    const gen3 = decodeGen3Body(body, FM3);
    const blocks = gen3.blocks ?? [];
    const gridNonShunt = (gen3.grid ?? []).filter((c) => !c.is_shunt && c.effect_id > 0);

    // 1. exactly one walk block per non-shunt grid block.
    assert(
      gridNonShunt.length === count,
      `preset-${preset}: grid non-shunt count ${gridNonShunt.length} != expected ${count} (fixture drift)`,
    );
    assert(
      blocks.length === count,
      `preset-${preset}: walkBlocks emitted ${blocks.length} blocks, expected ${count} (${blocks.map((b) => b.block).join(', ')})`,
    );

    // 2. every walk block's family label matches its offset-12 grid-eid signature
    //    (no cols-collision mislabelling), and its signature is a placed grid eid.
    const placedEids = new Set(gridNonShunt.map((c) => c.effect_id));
    for (const b of blocks) {
      const sig = u16(body, b.offset - 12);
      const fam = effectFamily(sig);
      assert(fam !== undefined, `preset-${preset}: block @${b.offset} signature ${sig} maps to no family`);
      assert(b.block === fam, `preset-${preset}: block @${b.offset} labelled "${b.block}" but signature ${sig} → "${fam}"`);
      assert(placedEids.has(sig), `preset-${preset}: block @${b.offset} eid ${sig} is not placed on the grid`);
    }

    // 3. the walk-block family multiset equals the grid-cell family multiset.
    const famOf = (eid: number): string => effectFamily(eid) ?? `eid_${eid}`;
    const tally = (names: string[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
      return m;
    };
    const gridTally = tally(gridNonShunt.map((c) => famOf(c.effect_id)));
    const walkTally = tally(blocks.map((b) => b.block));
    assert(gridTally.size === walkTally.size, `preset-${preset}: family set size mismatch grid ${gridTally.size} vs walk ${walkTally.size}`);
    for (const [fam, n] of gridTally) {
      assert(walkTally.get(fam) === n, `preset-${preset}: family "${fam}" count grid ${n} != walk ${walkTally.get(fam) ?? 0}`);
    }
  }

  // ── targeted assertions on the specific families the fix recovers ──
  const decode = (preset: number) => {
    const syx = new Uint8Array(readFileSync(join(FIXTURES, `preset-${preset}.syx`)));
    const parsed = parsePresetDump(syx, 0, FM3);
    return decodeGen3Body(decodeRawPatch(parsed.chunkPayloads).body, FM3).blocks ?? [];
  };

  // preset-55: Input, Output and the cols-15 Vol/Pan all present + correctly labelled.
  const b55 = decode(55);
  const input55 = b55.find((b) => b.block === 'Input');
  const output55 = b55.find((b) => b.block === 'Output');
  const volpan55 = b55.find((b) => b.block === 'Vol/Pan');
  assert(input55 !== undefined && input55.cols === 10, 'preset-55: Input (cols=10) missing/mislabelled');
  assert(output55 !== undefined && output55.cols === 26, 'preset-55: Output (cols=26) missing/mislabelled');
  assert(volpan55 !== undefined && volpan55.cols === 15, 'preset-55: cols-15 Vol/Pan missing (was dropped by the cols map)');

  // preset-79: two cols-33 PEQ instances present + labelled, plus Input/Output.
  const b79 = decode(79);
  const peqs79 = b79.filter((b) => b.block === 'PEQ');
  assert(peqs79.length === 2, `preset-79: expected 2 PEQ blocks, got ${peqs79.length}`);
  for (const p of peqs79) assert(p.cols === 33, `preset-79: PEQ block cols ${p.cols} != 33 (cols-33 PEQ was dropped as an undefined Flanger)`);
  assert(b79.some((b) => b.block === 'Input' && b.cols === 10), 'preset-79: Input (cols=10) missing/mislabelled');
  assert(b79.some((b) => b.block === 'Output' && b.cols === 26), 'preset-79: Output (cols=26) missing/mislabelled');
}
