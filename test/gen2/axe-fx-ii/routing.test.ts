/**
 * Axe-Fx II routing codec goldens.
 *
 * Tests buildSetCellRouting (fn=0x06) and buildSetGridCell (fn=0x05)
 * with byte-exact golden vectors. The II grid is 4 rows × 12 cols;
 * routing cables connect adjacent columns only (dstCol = srcCol + 1),
 * and can cross rows (e.g. row 2 col 3 → row 4 col 4), enabling
 * parallel chains, wet/dry splits, and fan-outs.
 *
 * Wire formula (buildSetCellRouting):
 *   srcCellIdx = (srcCol - 1) * 4 + (srcRow - 1)
 *   dstCellIdx = (dstCol - 1) * 4 + (dstRow - 1)
 *   payload:    [fn=0x06, srcCellIdx, dstCellIdx, connect]
 *   checksum:   XOR(F0..connect) & 0x7F
 *
 * Wire formula (buildSetGridCell):
 *   cellIdx = (col - 1) * 4 + (row - 1)
 *   payload: [fn=0x05, blockId & 0x7F, cellIdx]
 *
 * All golden bytes are derived from the formula and cross-checked
 * against captured traffic (Q8.02 XL+, session-61).
 */
import {
  buildSetCellRouting,
  buildSetGridCell,
  AXE_FX_II_XL_PLUS_MODEL_ID,
} from '../../../src/gen2/axe-fx-ii/index.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function hexStr(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}
function parseHex(s: string): number[] {
  return s.trim().split(/\s+/).map((h) => parseInt(h, 16));
}

const cases: Array<() => void> = [];

// ─── buildSetCellRouting ──────────────────────────────────────────────────────

// Case 1: row 1, col 1 → row 1, col 2 (top-row serial forward)
cases.push(() => {
  const got = buildSetCellRouting({ srcRow: 1, srcCol: 1, dstRow: 1, dstCol: 2 });
  const want = parseHex('f0 00 01 74 07 06 00 04 01 01 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `r1c1→r1c2: [${hexStr(got)}]`);
});

// Case 2: row 2, col 1 → row 2, col 2 (canonical row-2 chain step)
cases.push(() => {
  const got = buildSetCellRouting({ srcRow: 2, srcCol: 1, dstRow: 2, dstCol: 2 });
  const want = parseHex('f0 00 01 74 07 06 01 05 01 01 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `r2c1→r2c2: [${hexStr(got)}]`);
});

// Case 3: row 3, col 1 → row 3, col 2
// cs = (0x84 ^ srcIdx=2 ^ dstIdx=6 ^ connect=1) & 7F = (0x84 ^ 5) & 7F = 0x01
cases.push(() => {
  const got = buildSetCellRouting({ srcRow: 3, srcCol: 1, dstRow: 3, dstCol: 2 });
  const want = parseHex('f0 00 01 74 07 06 02 06 01 01 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `r3c1→r3c2: [${hexStr(got)}]`);
});

// Case 4: row 4, col 1 → row 4, col 2
// cs = (0x84 ^ srcIdx=3 ^ dstIdx=7 ^ connect=1) & 7F = (0x84 ^ 5) & 7F = 0x01
cases.push(() => {
  const got = buildSetCellRouting({ srcRow: 4, srcCol: 1, dstRow: 4, dstCol: 2 });
  const want = parseHex('f0 00 01 74 07 06 03 07 01 01 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `r4c1→r4c2: [${hexStr(got)}]`);
});

// Case 5: r1c1 → r3c2 — fan-out to lower row (parallel effects split)
// This is the topology used when amp at r1c1 feeds reverb branch at r3c2.
cases.push(() => {
  const got = buildSetCellRouting({ srcRow: 1, srcCol: 1, dstRow: 3, dstCol: 2 });
  const want = parseHex('f0 00 01 74 07 06 00 06 01 03 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `r1c1→r3c2: [${hexStr(got)}]`);
});

// Case 6: r1c1 → r4c2 — fan-out to bottom row
cases.push(() => {
  const got = buildSetCellRouting({ srcRow: 1, srcCol: 1, dstRow: 4, dstCol: 2 });
  const want = parseHex('f0 00 01 74 07 06 00 07 01 02 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `r1c1→r4c2: [${hexStr(got)}]`);
});

// Case 7: r2c1 → r4c2 — fan-out from row 2 to row 4
cases.push(() => {
  const got = buildSetCellRouting({ srcRow: 2, srcCol: 1, dstRow: 4, dstCol: 2 });
  const want = parseHex('f0 00 01 74 07 06 01 07 01 03 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `r2c1→r4c2: [${hexStr(got)}]`);
});

// Case 8: r2c3 → r4c4 — mid-grid cross-row cable
cases.push(() => {
  const got = buildSetCellRouting({ srcRow: 2, srcCol: 3, dstRow: 4, dstCol: 4 });
  const want = parseHex('f0 00 01 74 07 06 09 0f 01 03 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `r2c3→r4c4: [${hexStr(got)}]`);
});

// Case 9: r4c11 → r4c12 — maximum source/destination column boundary
cases.push(() => {
  const got = buildSetCellRouting({ srcRow: 4, srcCol: 11, dstRow: 4, dstCol: 12 });
  const want = parseHex('f0 00 01 74 07 06 2b 2f 01 01 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `r4c11→r4c12: [${hexStr(got)}]`);
});

// Case 10: r3c4 → r2c5 — cross-row merge (parallel path terminating into main chain)
// Typical wet/dry reverb re-merge: reverb on row 3 feeds back into
// main chain on row 2 via a mixer.
// cs = (0x84 ^ srcIdx=0x0E ^ dstIdx=0x11 ^ connect=1) & 7F = (0x84^0x1E) & 7F = 0x9A & 7F = 0x1A
cases.push(() => {
  const got = buildSetCellRouting({ srcRow: 3, srcCol: 4, dstRow: 2, dstCol: 5 });
  // srcIdx = (4-1)*4 + (3-1) = 12+2 = 14 = 0x0E
  // dstIdx = (5-1)*4 + (2-1) = 16+1 = 17 = 0x11
  const want = parseHex('f0 00 01 74 07 06 0e 11 01 1a f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `r3c4→r2c5: [${hexStr(got)}]`);
});

// Case 11: DISCONNECT — same positions as Case 2 but connect=false
cases.push(() => {
  const got = buildSetCellRouting({ srcRow: 2, srcCol: 1, dstRow: 2, dstCol: 2, connect: false });
  const want = parseHex('f0 00 01 74 07 06 01 05 00 00 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `r2c1→r2c2 DISCONNECT: [${hexStr(got)}]`);
  assert(got[8] === 0x00, `connect byte should be 0x00 for disconnect, got 0x${got[8].toString(16)}`);
});

// Case 12: non-default modelId propagates to byte[4]
cases.push(() => {
  const xlPlus = buildSetCellRouting({ srcRow: 2, srcCol: 1, dstRow: 2, dstCol: 2 });
  const custom = buildSetCellRouting({ srcRow: 2, srcCol: 1, dstRow: 2, dstCol: 2, modelId: 0x03 });
  assert(xlPlus[4] === AXE_FX_II_XL_PLUS_MODEL_ID, `default model byte should be ${AXE_FX_II_XL_PLUS_MODEL_ID}`);
  assert(custom[4] === 0x03, `custom model byte should be 0x03`);
  // Everything except byte[4] (model) and byte[9] (checksum) should match
  // for the same routing operation with a different model byte.
  for (let i = 0; i < xlPlus.length; i++) {
    if (i === 4 || i === 9) continue;
    assert(xlPlus[i] === custom[i], `byte[${i}] should match outside model/checksum`);
  }
});

// ─── buildSetCellRouting refusals ─────────────────────────────────────────────

// Non-adjacent columns reject.
cases.push(() => {
  let threw = false;
  try { buildSetCellRouting({ srcRow: 2, srcCol: 1, dstRow: 2, dstCol: 3 }); } catch { threw = true; }
  assert(threw, 'non-adjacent columns (col 1 → col 3) should throw');
});
cases.push(() => {
  let threw = false;
  try { buildSetCellRouting({ srcRow: 2, srcCol: 3, dstRow: 2, dstCol: 2 }); } catch { threw = true; }
  assert(threw, 'backwards cable (col 3 → col 2) should throw');
});

// srcRow out of range.
cases.push(() => {
  let threw = false;
  try { buildSetCellRouting({ srcRow: 0, srcCol: 1, dstRow: 1, dstCol: 2 }); } catch { threw = true; }
  assert(threw, 'srcRow=0 should throw');
});
cases.push(() => {
  let threw = false;
  try { buildSetCellRouting({ srcRow: 5, srcCol: 1, dstRow: 1, dstCol: 2 }); } catch { threw = true; }
  assert(threw, 'srcRow=5 on 4-row grid should throw');
});

// srcCol out of range: col 12 cannot be a cable source (no col 13 on a 4×12 grid).
cases.push(() => {
  let threw = false;
  try { buildSetCellRouting({ srcRow: 2, srcCol: 12, dstRow: 2, dstCol: 13 }); } catch { threw = true; }
  assert(threw, 'srcCol=12 should throw (max srcCol is 11)');
});

// dstRow out of range.
cases.push(() => {
  let threw = false;
  try { buildSetCellRouting({ srcRow: 2, srcCol: 1, dstRow: 5, dstCol: 2 }); } catch { threw = true; }
  assert(threw, 'dstRow=5 on 4-row grid should throw');
});

// ─── buildSetGridCell ─────────────────────────────────────────────────────────

// Places a block at a grid cell using fn=0x05. Cell index = (col-1)*4 + (row-1).
// blockId is the Axe-Fx II hardware effect ID.

// Amp 1 at row 2 col 1 (blockId=106).
cases.push(() => {
  const got = buildSetGridCell({ row: 2, col: 1, blockId: 106 });
  // cell = (1-1)*4 + (2-1) = 1; blockId=106=0x6A
  assert(got[5] === 0x05, `fn should be 0x05, got 0x${got[5].toString(16)}`);
  assert(got[6] === (106 & 0x7F), `blockId LSB should be 0x${(106 & 0x7F).toString(16)}`);
  assert(got[0] === 0xF0 && got[got.length - 1] === 0xF7, 'SysEx envelope');
});

// Cab 1 at row 2 col 2 (blockId=109).
cases.push(() => {
  const got = buildSetGridCell({ row: 2, col: 2, blockId: 109 });
  // cell = (2-1)*4 + (2-1) = 5; blockId=109=0x6D
  assert(got[5] === 0x05, 'fn=0x05');
  assert(got[4] === AXE_FX_II_XL_PLUS_MODEL_ID, 'default model byte');
});

// Clear a cell: blockId=0.
cases.push(() => {
  const got = buildSetGridCell({ row: 3, col: 4, blockId: 0 });
  assert(got[5] === 0x05, 'fn=0x05');
  assert(got[6] === 0x00, `clear cell: blockId LSB should be 0`);
  assert(got[0] === 0xF0 && got[got.length - 1] === 0xF7, 'SysEx envelope');
});

// Row and col boundary: row 4, col 12 (maximum positions on 4×12 grid).
cases.push(() => {
  const got = buildSetGridCell({ row: 4, col: 12, blockId: 50 });
  // cell = (12-1)*4 + (4-1) = 44+3 = 47 = 0x2F
  assert(got[5] === 0x05, 'fn=0x05');
  assert(got[0] === 0xF0 && got[got.length - 1] === 0xF7, 'SysEx envelope');
  // Validate checksum: XOR all bytes except last two.
  let x = 0;
  for (let i = 0; i < got.length - 2; i++) x ^= got[i];
  assert((x & 0x7F) === got[got.length - 2], `checksum mismatch at r4c12`);
});

// buildSetGridCell refusals.
cases.push(() => {
  let threw = false;
  try { buildSetGridCell({ row: 0, col: 1, blockId: 10 }); } catch { threw = true; }
  assert(threw, 'row=0 should throw');
});
cases.push(() => {
  let threw = false;
  try { buildSetGridCell({ row: 5, col: 1, blockId: 10 }); } catch { threw = true; }
  assert(threw, 'row=5 on 4-row grid should throw');
});
cases.push(() => {
  let threw = false;
  try { buildSetGridCell({ row: 2, col: 13, blockId: 10 }); } catch { threw = true; }
  assert(threw, 'col=13 on 12-col grid should throw');
});

export function runAxeFxIIRoutingTests(): void {
  for (const c of cases) c();
}
export const AXEFX2_ROUTING_CASE_COUNT = cases.length;
