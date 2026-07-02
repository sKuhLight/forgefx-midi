/**
 * Gen-3 routing codec goldens (buildSetGridRouting, fn=0x01 sub=0x35).
 *
 * Grid sizes:
 *   Axe-Fx III: 6 rows × 14 cols (model 0x10)
 *   FM9:        6 rows × 14 cols (model 0x12)
 *   FM3:        4 rows × 12 cols (model 0x11) — 4-row routing decoded (FM3-Edit loopMIDI)
 *   VP4:        serial 4-slot     (model 0x14) — no routing primitive
 *
 * Wire encoding formula (6-row grids only, validated against 24 FM9-Edit
 * loopMIDI captures, 2026-06-05):
 *
 *   srcGp    = (srcCol - 1) * 6 + (srcRow - 1)
 *   b21      = floor(srcGp / 2)
 *   colTerm  = floor(3 * (srcCol - 1) / 2) + 1
 *   destSign = destRow >= 3 ? 1 : 0
 *   b22      = ((srcGp & 1) << 6) | (colTerm + destSign)
 *   b23      = ((|destRow - 3| + (srcCol % 2 === 0 ? 2 : 0)) % 4) << 5
 *
 * Frame layout (26 bytes):
 *   F0 00 01 74 <model> 01 35 00 00 00 00 00 <OP> 00 00 00 00 00 00 02 00 <b21> <b22> <b23> <cs> F7
 *   Fixed-prefix XOR (bytes 0-11): FM9=0xA3, III=0xA1
 *   cs (CONNECT):    (0xA0 ^ b21 ^ b22 ^ b23) & 7F  [FM9];  (0xA2 ^ b21 ^ b22 ^ b23) & 7F [III]
 *   cs (DISCONNECT): (0xA3 ^ b21 ^ b22 ^ b23) & 7F  [FM9];  (0xA1 ^ b21 ^ b22 ^ b23) & 7F [III]
 *
 * The codec is shared across III/FM9/VP4 (same fn+sub). FM3 uses the same
 * codec family with a different 4-row baseline/mod-4 formula, now decoded and
 * byte-confirmed (FM3-Edit loopMIDI, 2026-06-05) and golden-tested below; only
 * a 3-row grid still throws.
 */
import { createModernFractalCodec, ROUTING_OP_CONNECT, ROUTING_OP_DISCONNECT } from '../../../src/gen3/axe-fx-iii/index.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function hexStr(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}
function parseHex(s: string): number[] {
  return s.trim().split(/\s+/).map((h) => parseInt(h, 16));
}

const FM9 = 0x12;
const III = 0x10;

const cases: Array<() => void> = [];

// ─── CONNECT goldens ──────────────────────────────────────────────────────────

// Case 1: r2c1 → r2c2 — same-row serial forward (most common topology).
// FM9 and III both golden to verify model-byte propagation: only bytes[4]
// (model) and bytes[24] (checksum) differ; payload bytes[6..23] are identical.
cases.push(() => {
  const fm9 = createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 2 });
  const iii = createModernFractalCodec(III).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 2 });
  const wantFm9 = parseHex('f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 41 20 41 f7');
  const wantIii = parseHex('f0 00 01 74 10 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 41 20 43 f7');
  assert(fm9.length === wantFm9.length && fm9.every((b, i) => b === wantFm9[i]),
    `FM9 r2c1→r2c2: [${hexStr(fm9)}]`);
  assert(iii.length === wantIii.length && iii.every((b, i) => b === wantIii[i]),
    `III r2c1→r2c2: [${hexStr(iii)}]`);
  // Bytes outside model byte (index 4) and checksum (index 24) must match.
  for (let i = 0; i < fm9.length; i++) {
    if (i === 4 || i === 24) continue;
    assert(fm9[i] === iii[i], `FM9 vs III byte[${i}] should match outside model+checksum`);
  }
});

// Case 2: r2c1 → r4c2 — fan-out to lower row (parallel effects split).
// Primary parallel topology: amp at r2c1 feeds both delay (same row) and
// reverb (row 4) simultaneously.
cases.push(() => {
  const got = createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 4 });
  const want = parseHex('f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 42 20 42 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM9 r2c1→r4c2: [${hexStr(got)}]`);
});

// Case 3: r2c1 → r6c2 — fan-out to bottom row (6-row grid maximum row).
cases.push(() => {
  const got = createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 6 });
  const want = parseHex('f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 42 60 02 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM9 r2c1→r6c2: [${hexStr(got)}]`);
});

// Case 4: r3c1 → r2c2 — row-3 source merging into row 2.
// Typical for two col-1 blocks fanning into a single row-2 chain.
cases.push(() => {
  const got = createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 3, srcCol: 1, destRow: 2 });
  const want = parseHex('f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 01 01 20 00 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM9 r3c1→r2c2: [${hexStr(got)}]`);
});

// Case 5: r4c1 → r6c2 — lower rows, cross-row.
// srcGp=3, b21=1; colTerm=1, destSign=1; b22=(1<<6)|(1+1)=66=0x42; b23=(3%4)<<5=0x60
// cs=(A0^01^42^60)&7F=(A1^42=E3,E3^60=83)&7F=0x03
cases.push(() => {
  const got = createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 4, srcCol: 1, destRow: 6 });
  const want = parseHex('f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 01 42 60 03 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM9 r4c1→r6c2: [${hexStr(got)}]`);
});

// Case 6: r5c1 → r5c2 — row 5, same-row serial.
// srcGp=4, b21=2; colTerm=1, destSign=1 (5>=3); b22=(0<<6)|(1+1)=2=0x02; b23=(2%4)<<5=0x40
// cs=(A0^02^02^40)&7F=(A0^40)&7F=E0&7F=0x60
cases.push(() => {
  const got = createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 5, srcCol: 1, destRow: 5 });
  const want = parseHex('f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 02 02 40 60 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM9 r5c1→r5c2: [${hexStr(got)}]`);
});

// Case 7: r6c1 → r6c2 — bottom row, same-row serial.
// srcGp=5, b21=2; colTerm=1, destSign=1 (6>=3); b22=(1<<6)|(1+1)=66=0x42; b23=(3%4)<<5=0x60
// cs=(A0^02^42^60)&7F=(A2^42=E0,E0^60=80)&7F=0x00
cases.push(() => {
  const got = createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 6, srcCol: 1, destRow: 6 });
  const want = parseHex('f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 02 42 60 00 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM9 r6c1→r6c2: [${hexStr(got)}]`);
});

// Case 8: r1c1 → r1c2 — row 1, odd col source forward.
// Row-1 odd-column case (col 1 validated; formula generalises to other odd cols).
cases.push(() => {
  const got = createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 1, srcCol: 1, destRow: 1 });
  const want = parseHex('f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 01 40 61 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM9 r1c1→r1c2: [${hexStr(got)}]`);
});

// Case 9: r1c1 → r3c2 — row 1 odd-col fan-out to row 3.
cases.push(() => {
  const got = createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 1, srcCol: 1, destRow: 3 });
  const want = parseHex('f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 02 00 22 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM9 r1c1→r3c2: [${hexStr(got)}]`);
});

// Case 10: r2c2 → r2c3 — even srcCol, same-row.
// Exercises the even-srcCol formula branch (colTerm advances, b23 adds +2 offset).
cases.push(() => {
  const got = createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 2, srcCol: 2, destRow: 2 });
  const want = parseHex('f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 03 42 60 01 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM9 r2c2→r2c3: [${hexStr(got)}]`);
});

// Case 11: r4c3 → r2c4 — mid-grid cross-row merge.
// Reverb branch on row 4 merging back into row 2 chain at col 4.
cases.push(() => {
  const got = createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 4, srcCol: 3, destRow: 2 });
  const want = parseHex('f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 07 44 20 43 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM9 r4c3→r2c4: [${hexStr(got)}]`);
});

// Case 12: r6c3 → r4c4 — bottom row, mid-grid cross-row.
cases.push(() => {
  const got = createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 6, srcCol: 3, destRow: 4 });
  const want = parseHex('f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 08 45 20 4d f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM9 r6c3→r4c4: [${hexStr(got)}]`);
});

// Case 13: r5c5 → r3c6 — high row + high col (exercises full formula range).
cases.push(() => {
  const got = createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 5, srcCol: 5, destRow: 3 });
  const want = parseHex('f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 0e 08 00 26 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM9 r5c5→r3c6: [${hexStr(got)}]`);
});

// Case 14: r2c13 → r2c14 — maximum srcCol boundary on a 14-col grid.
// The 6-row grid extends to col 14 (III/FM9). srcCol max = 13.
cases.push(() => {
  const got = createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 2, srcCol: 13, destRow: 2 });
  // srcGp=(13-1)*6+(2-1)=73; b21=36=0x24; colTerm=floor(3*12/2)+1=18+1=19=0x13
  // destSign=0; b22=((73&1)<<6)|(19+0)=64|19=83=0x53; b23=(1+0)%4<<5=32=0x20
  const want = parseHex('f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 24 53 20 77 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM9 r2c13→r2c14: [${hexStr(got)}]`);
});

// ─── DISCONNECT golden ────────────────────────────────────────────────────────

// Case 15: DISCONNECT variant — same positions as Case 1 but op=DISCONNECT.
// Only byte[12] (OP=0x02) and byte[24] (checksum) change vs. the CONNECT variant.
cases.push(() => {
  const got = createModernFractalCodec(FM9).buildSetGridRouting({
    srcRow: 2, srcCol: 1, destRow: 2, op: ROUTING_OP_DISCONNECT,
  });
  const want = parseHex('f0 00 01 74 12 01 35 00 00 00 00 00 02 00 00 00 00 00 00 02 00 00 41 20 42 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM9 r2c1→r2c2 DISCONNECT: [${hexStr(got)}]`);
  assert(got[12] === ROUTING_OP_DISCONNECT, `op byte: got 0x${got[12].toString(16)}, want 0x02`);
});

// ─── FM3 4-row goldens (byte-confirmed FM3-Edit loopMIDI, 2026-06-05) ─────────
//
// Formula: srcGp=(srcCol-1)*4+(srcRow-1); b21=floor(srcGp/2);
//          b22=((srcGp&1)<<6)|srcCol; b23=(destRow-1)<<5
// FM3 model byte 0x11; fixed prefix XOR = 0xA0 (CONNECT).
// cs = (0xA0 ^ b21 ^ b22 ^ b23) & 0x7F  [CONNECT path]

// FM3 r2c1→r2c2 (baseline, srcGp=1): confirms 4-row formula matches Rig-A capture.
cases.push(() => {
  const got = createModernFractalCodec(0x11).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 2, rows: 4 });
  const want = parseHex('f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 41 20 42 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM3 r2c1→r2c2: [${hexStr(got)}]`);
});

// FM3 r4c1→r4c2 (srcGp=3, destRow=4 → b23=0x60): bottom row, cross-col.
// Key: b22 uses colTerm=srcCol=1 (no destSign), b23=(4-1)*32=0x60.
cases.push(() => {
  const got = createModernFractalCodec(0x11).buildSetGridRouting({ srcRow: 4, srcCol: 1, destRow: 4, rows: 4 });
  const want = parseHex('f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 01 41 60 03 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM3 r4c1→r4c2: [${hexStr(got)}]`);
});

// FM3 r2c1→r4c2 (fan-out to bottom row, srcGp=1, destRow=4).
cases.push(() => {
  const got = createModernFractalCodec(0x11).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 4, rows: 4 });
  const want = parseHex('f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 41 60 02 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM3 r2c1→r4c2: [${hexStr(got)}]`);
});

// FM3 r1c1→r1c2 (row-1 odd-col, srcGp=0).
cases.push(() => {
  const got = createModernFractalCodec(0x11).buildSetGridRouting({ srcRow: 1, srcCol: 1, destRow: 1, rows: 4 });
  const want = parseHex('f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 01 00 22 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM3 r1c1→r1c2: [${hexStr(got)}]`);
});

// FM3 r2c2→r2c3 (even srcCol, srcGp=5): key discriminator that proved 4-row formula.
// b21=2 (not 3 as 6-row predicts), b22=((1<<6)|2)=0x42, b23=0x20.
cases.push(() => {
  const got = createModernFractalCodec(0x11).buildSetGridRouting({ srcRow: 2, srcCol: 2, destRow: 2, rows: 4 });
  const want = parseHex('f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 02 42 20 43 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM3 r2c2→r2c3: [${hexStr(got)}]`);
});

// FM3 r2c3→r2c4 (srcGp=9): b21=4 (not 6 as 6-row predicts), b22=0x43 (colTerm=srcCol=3).
cases.push(() => {
  const got = createModernFractalCodec(0x11).buildSetGridRouting({ srcRow: 2, srcCol: 3, destRow: 2, rows: 4 });
  const want = parseHex('f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 04 43 20 44 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM3 r2c3→r2c4: [${hexStr(got)}]`);
});

// FM3 r1c2→r1c3 (row-1 EVEN-COL, srcGp=4): works on FM3 (refused on 6-row).
// Confirms the even-col gate only applies to 6-row grids.
cases.push(() => {
  const got = createModernFractalCodec(0x11).buildSetGridRouting({ srcRow: 1, srcCol: 2, destRow: 1, rows: 4 });
  const want = parseHex('f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 02 02 00 23 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM3 r1c2→r1c3 (row-1 even-col, now works): [${hexStr(got)}]`);
});

// ─── Model byte smoke: all gen-3 devices produce well-formed frames ───────────

// Case 16: VP4 (0x14) routing frames are not hardware-validated but must
// have correct header, model byte, and checksum. FM3 (0x11) is excluded
// here because its 4-row formula is gated by the rows≠6 guard.
function isWellFormed(bytes: number[], model: number): boolean {
  if (bytes[0] !== 0xf0 || bytes[bytes.length - 1] !== 0xf7) return false;
  if (bytes[1] !== 0x00 || bytes[2] !== 0x01 || bytes[3] !== 0x74 || bytes[4] !== model) return false;
  let x = 0;
  for (let i = 0; i < bytes.length - 2; i++) x ^= bytes[i];
  return (x & 0x7f) === bytes[bytes.length - 2];
}
for (const [name, mb, rows] of [['III', 0x10, 6], ['FM3', 0x11, 4], ['FM9', 0x12, 6], ['VP4', 0x14, 6]] as const) {
  const nameCopy = name;
  const mbCopy = mb;
  const rowsCopy = rows;
  cases.push(() => {
    const frame = createModernFractalCodec(mbCopy).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 2, rows: rowsCopy });
    assert(isWellFormed(frame, mbCopy),
      `${nameCopy} routing frame well-formed: [${hexStr(frame)}]`);
    assert(frame.length === 26, `${nameCopy} routing frame length should be 26, got ${frame.length}`);
    assert(frame[5] === 0x01, `${nameCopy} fn byte should be 0x01`);
    assert(frame[6] === 0x35, `${nameCopy} sub-action should be 0x35`);
  });
}

// ─── Refusal tests ────────────────────────────────────────────────────────────

// rows=3 (invalid) throws; rows=4 and rows=6 are both valid.
cases.push(() => {
  let threw = false;
  try {
    createModernFractalCodec(0x11).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 2, rows: 3 });
  } catch { threw = true; }
  assert(threw, 'rows=3 (invalid) should throw');
});

// Row-1 even-col: encoding not yet decoded (4 data points, pattern not closed).
cases.push(() => {
  let threw = false;
  try {
    createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 1, srcCol: 2, destRow: 1 });
  } catch { threw = true; }
  assert(threw, 'srcRow=1 srcCol=2 (even col) should throw');
});
cases.push(() => {
  let threw = false;
  try {
    createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 1, srcCol: 4, destRow: 1 });
  } catch { threw = true; }
  assert(threw, 'srcRow=1 srcCol=4 (even col) should throw');
});

// srcRow out of range.
cases.push(() => {
  let threw = false;
  try { createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 0, srcCol: 1, destRow: 2 }); } catch { threw = true; }
  assert(threw, 'srcRow=0 should throw');
});
cases.push(() => {
  let threw = false;
  try { createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 7, srcCol: 1, destRow: 2 }); } catch { threw = true; }
  assert(threw, 'srcRow=7 on 6-row grid should throw');
});

// destRow out of range.
cases.push(() => {
  let threw = false;
  try { createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 0 }); } catch { threw = true; }
  assert(threw, 'destRow=0 should throw');
});
cases.push(() => {
  let threw = false;
  try { createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 7 }); } catch { threw = true; }
  assert(threw, 'destRow=7 on 6-row grid should throw');
});

// srcCol out of range: max srcCol is 13 (destCol 14 is the boundary).
cases.push(() => {
  let threw = false;
  try { createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 2, srcCol: 14, destRow: 2 }); } catch { threw = true; }
  assert(threw, 'srcCol=14 should throw (max is 13 on a 14-col grid)');
});

// Invalid op.
cases.push(() => {
  let threw = false;
  try {
    createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 2, op: 0x99 });
  } catch { threw = true; }
  assert(threw, 'op=0x99 should throw (only CONNECT=0x01 or DISCONNECT=0x02 allowed)');
});

export function runGen3RoutingTests(): void {
  for (const c of cases) c();
}
export const GEN3_ROUTING_CASE_COUNT = cases.length;
