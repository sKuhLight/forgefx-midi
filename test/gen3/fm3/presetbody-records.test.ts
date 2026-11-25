/**
 * Gen-3 prelude/chain records: scene controllers, the Scene MIDI record, and the
 * 32-slot pre-chain modifier table.
 *
 * Three boundaries that the block-chain walk must get exactly right:
 *  - the CONTROLLERS array: a `(wordsPerSlot, 4)` header followed by four channel
 *    records whose `n`-th word is CONTROLLERS paramId `n`; the scene-controller
 *    values are words 72..103 of slot 0 (SCENE1_VAL1..8 … SCENE4_VAL1..8);
 *  - the preset-scoped Scene MIDI record (grid effect 190, cols 0x0101, rows 1,
 *    560 bytes) — emitted only when the grid places 190, without entering
 *    `EFFECT_BASES`, and the walk must continue past it;
 *  - the 32 x 96-byte pre-chain modifier table at the walk start + 30, whose
 *    self-index word 27 is `4 + i` for the 31 unclipped slots and whose last slot
 *    is clipped by the first block header (word 27 there is the block's eid).
 *
 * FM3 fixture numbers are for preset-67 (scene values), preset-82 (a live
 * modifier plus three stale target-0 slots) and preset-96 (the clean scaffold);
 * the FM9/III exports pin the per-model CONTROLLERS bases and that the modifier
 * table is device-general.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePresetDump } from '../../../src/devices/gen3/presetDump.js';
import { decodeRawPatch } from '../../../src/devices/gen3/presetHuffman.js';
import {
  decodeGen3Body,
  effectFamily,
  EFFECT_BASES,
  MODEL_AXE_FX_III,
  MODEL_FM3,
  MODEL_FM9,
} from '../../../src/devices/gen3/presetBody.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const PRESETBODY_RECORDS_CASE_COUNT = 7;

function fail(msg: string): never {
  throw new Error(`[fm3/presetbody-records] ${msg}`);
}
function assert(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
}

const u16 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8)) & 0xffff;
const w16 = (b: Uint8Array, o: number, v: number): void => {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
};

function bodyOf(file: string, model: number): Uint8Array {
  const parsed = parsePresetDump(new Uint8Array(readFileSync(file)), 0, model);
  return decodeRawPatch(parsed.chunkPayloads).body;
}

/** The record walk start: the first of two consecutive 25x1 marker records. */
function recordWalkStart(body: Uint8Array): number {
  const step = (23 + 25) * 2;
  for (let off = 0x200; off < body.length - 70; off += 2) {
    if (u16(body, off + 30) !== 25 || u16(body, off + 32) !== 1) continue;
    const next = off + step;
    if (next + 34 <= body.length && u16(body, next + 30) === 25 && u16(body, next + 32) === 1) return off;
  }
  return -1;
}

/** A 257-word Scene MIDI record (23-word header + one value per param id). */
function sceneMidiRecord(): Uint8Array {
  const rec = new Uint8Array((23 + 257) * 2);
  w16(rec, 30, 257); // header word 15: cols
  w16(rec, 32, 1); // header word 16: rows
  w16(rec, 34, 2); // header word 17
  for (let i = 0; i < 257; i++) w16(rec, 46 + i * 2, i % 32 === 3 ? 0x000b : 0);
  return rec;
}

/** Records of the geometric chain walk (sane cols/rows), with their byte offsets. */
function chainRecords(body: Uint8Array, start: number, limit: number): { pos: number; cols: number; rows: number; size: number }[] {
  const out: { pos: number; cols: number; rows: number; size: number }[] = [];
  let pos = start;
  while (pos + 23 * 2 <= limit) {
    const cols = u16(body, pos + 30);
    const rows = u16(body, pos + 32);
    if (cols === 0 || rows === 0 || cols > 500 || rows > 8) break;
    const size = (23 + cols * rows) * 2;
    out.push({ pos, cols, rows, size });
    pos += size;
  }
  return out;
}

export function runPresetBodyRecordTests(): void {
  // ── 1. CONTROLLERS headers + the per-model scene-controller window ──
  const layouts = [
    ...[5, 42, 45, 55, 62, 63, 67, 79, 82, 96].map((n) => ({
      label: `FM3 preset-${n}`,
      file: join(FIXTURES, `preset-${n}.syx`),
      model: MODEL_FM3,
      base: 0x1f2,
      words: 130,
    })),
    { label: 'FM9 export', file: join(FIXTURES, '../../fm9/fixtures/devs-gift-of-tone.syx'), model: MODEL_FM9, base: 0xe9a, words: 130 },
    { label: 'Axe-Fx III export', file: join(FIXTURES, '../../axe-fx-iii/fixtures/devs-gift-of-tone.syx'), model: MODEL_AXE_FX_III, base: 0x282, words: 178 },
  ];
  for (const l of layouts) {
    const body = bodyOf(l.file, l.model);
    assert(
      u16(body, l.base - 4) === l.words && u16(body, l.base - 2) === 4,
      `${l.label}: CONTROLLERS array header must be (${l.words}, 4) at 0x${(l.base - 4).toString(16)}`,
    );
    const sc = decodeGen3Body(body, l.model).scene_controllers ?? [];
    assert(sc.length === 4, `${l.label}: expected 4 scene controllers, got ${sc.length}`);
    for (const [i, c] of sc.entries()) {
      assert(c.controller === `Scene Controller ${i + 1}`, `${l.label}: controller ${i} named "${c.controller}"`);
      assert(c.raw.length === 8 && c.values.length === 8, `${l.label}: ${c.controller} must carry 8 scenes`);
    }
  }

  // preset-67's only non-zero window is controller 3 (slot-0 words 88..95 =
  // SCENE3_VAL1..8, raw 1,1,0,1,1,1,1,1 — 1/65535 of full scale, not a param
  // default); pin it, plus that controllers 1 and 4 are all-zero — the window is
  // words 72..103, not the old, misaligned 0x294 (slot-0 word 81).
  const b67 = bodyOf(join(FIXTURES, 'preset-67.syx'), MODEL_FM3);
  const sc67 = decodeGen3Body(b67, MODEL_FM3).scene_controllers ?? [];
  assert(sc67[2]!.raw.join(',') === '1,1,0,1,1,1,1,1', `preset-67: controller 3 raw ${sc67[2]!.raw.join(',')}`);
  assert(sc67[0]!.raw.every((v) => v === 0) && sc67[3]!.raw.every((v) => v === 0), 'preset-67: controllers 1/4 must be all-zero');

  // Exact display values: valve the raw word to 50% / 100% in a committed body.
  const b67p = b67.slice();
  w16(b67p, 0x1f2 + 72 * 2, 0x8000);
  w16(b67p, 0x1f2 + 79 * 2, 0xffff);
  const sc67p = decodeGen3Body(b67p, MODEL_FM3).scene_controllers ?? [];
  assert(sc67p[0]!.raw[0] === 0x8000 && sc67p[0]!.values[0] === 50, `scene value 0x8000 must read 50%, got ${sc67p[0]!.values[0]}`);
  assert(sc67p[0]!.raw[7] === 0xffff && sc67p[0]!.values[7] === 100, `scene value 0xffff must read 100%, got ${sc67p[0]!.values[7]}`);

  // ── 2. a model with no CONTROLLERS layout emits no scene controllers ──
  assert(
    decodeGen3Body(b67, 0x15).scene_controllers === undefined,
    'a model without the CONTROLLERS layout must not invent scene controllers',
  );

  // ── 3. the Scene MIDI record (eid 190): gated on the grid, 560 bytes ──
  const b96 = bodyOf(join(FIXTURES, 'preset-96.syx'), MODEL_FM3);
  const tailStart = b96.length - 3832; // the fixed FM3 tail
  const rec = sceneMidiRecord();
  assert(rec.length === 560, `Scene MIDI record must be 560 bytes, got ${rec.length}`);

  // Insert the record immediately BEFORE the last chain record (Vol/Pan) and shift
  // that record 560 bytes, so a walk that stops at the preset-scoped record would
  // drop it. The moved record's eid signature is re-stamped 12 bytes above it.
  const chain = chainRecords(b96, 0x120e, tailStart);
  const lastRec = chain[chain.length - 1]!;
  const insertAt = lastRec.pos;
  const lastEid = u16(b96, insertAt - 12);
  assert(lastEid === 102, `preset-96: last chain record eid ${lastEid}, expected 102 (Vol/Pan)`);
  const withRecord = new Uint8Array(b96.length + rec.length);
  withRecord.set(b96.subarray(0, insertAt), 0);
  withRecord.set(rec, insertAt);
  w16(withRecord, insertAt - 12, 190); // the record's eid signature
  withRecord.set(b96.subarray(insertAt, tailStart), insertAt + rec.length);
  w16(withRecord, insertAt + rec.length - 12, lastEid); // the shifted record's signature
  withRecord.set(b96.subarray(tailStart), tailStart + rec.length);

  const notPlaced = decodeGen3Body(withRecord, MODEL_FM3);
  assert(
    !(notPlaced.blocks ?? []).some((b) => b.block === 'Scene MIDI'),
    'the Scene MIDI record must be dropped when the grid does not place eid 190',
  );
  assert(
    (notPlaced.blocks ?? []).some((b) => b.block === 'Vol/Pan' && b.offset === insertAt + rec.length),
    'without the grid cell the shifted chain must decode as before',
  );

  const placed = withRecord.slice();
  assert(u16(placed, 0x104) === 0, 'preset-96 grid cell (0,0) must be free for this test');
  w16(placed, 0x104, 190);
  const placedDecoded = decodeGen3Body(placed, MODEL_FM3);
  const sceneMidi = (placedDecoded.blocks ?? []).filter((b) => b.block === 'Scene MIDI');
  assert(sceneMidi.length === 1, `expected 1 Scene MIDI record, got ${sceneMidi.length}`);
  const sm = sceneMidi[0]!;
  assert(sm.cols === 257 && sm.rows === 1 && sm.offset === insertAt, `Scene MIDI geometry ${sm.cols}x${sm.rows} @${sm.offset}`);
  assert(
    (placedDecoded.grid ?? []).some((c) => c.effect_id === 190 && c.name === 'Scene MIDI'),
    'the grid cell for eid 190 must be labelled "Scene MIDI"',
  );
  assert(!(190 in EFFECT_BASES) && effectFamily(190) === undefined, 'eid 190 must stay out of EFFECT_BASES');
  // The walk continues past the record: the shifted Vol/Pan block is still emitted,
  // after the Scene MIDI record, and the chain is exactly one block longer.
  const shiftedVolPan = (placedDecoded.blocks ?? []).find((b) => b.block === 'Vol/Pan');
  assert(
    shiftedVolPan?.offset === insertAt + rec.length,
    `walk must continue past the Scene MIDI record (Vol/Pan @${shiftedVolPan?.offset} != ${insertAt + rec.length})`,
  );
  const baseCount = (decodeGen3Body(b96, MODEL_FM3).blocks ?? []).length;
  assert(
    placedDecoded.blocks!.length === baseCount + 1,
    `expected ${baseCount + 1} blocks with the Scene MIDI record, got ${placedDecoded.blocks!.length}`,
  );

  // ── 4. pre-chain modifier table: 32 x 96 bytes, self-index, stale slots ──
  const b82 = bodyOf(join(FIXTURES, 'preset-82.syx'), MODEL_FM3);
  const ws82 = recordWalkStart(b82);
  assert(ws82 === 0x60e, `preset-82 walk start 0x${ws82.toString(16)}, expected 0x60e`);
  const base82 = ws82 + 30;
  for (let i = 0; i < 31; i++) {
    const abs = base82 + i * 96;
    assert(u16(b82, abs) === 25 && u16(b82, abs + 2) === 1, `preset-82: entry ${i} marker missing`);
    assert(u16(b82, abs + 54) === i + 4, `preset-82: entry ${i} self-index ${u16(b82, abs + 54)} != ${i + 4}`);
  }
  // Entry 31 is clipped: its word 27 is the first block's grid-eid signature (58 =
  // Amp 1), not an index — the decoder must not read it as one, and its target word
  // is 0, so it never becomes a modifier.
  const last = base82 + 31 * 96;
  assert(u16(b82, last + 54) === 58, `preset-82: clipped entry 31 word 27 ${u16(b82, last + 54)} != 58`);
  assert((decodeGen3Body(b82, MODEL_FM3).blocks ?? [])[0]!.offset === ws82 + 32 * 96, 'chain must start after the 32 slots');

  const pre82 = (decodeGen3Body(b82, MODEL_FM3).modifiers ?? []).filter((m) => m.origin === 'pre-chain');
  assert(pre82.length === 1, `preset-82: expected 1 live pre-chain modifier, got ${pre82.length}`);
  assert(
    pre82[0]!.source === 'External 1' && pre82[0]!.target === 'Wah 1' && pre82[0]!.param === 5,
    `preset-82 live modifier: ${JSON.stringify(pre82[0])}`,
  );
  // Entries 1..3 are stale (target eid 0, leftover param ids 12/19/20): dropped.
  for (const staleParam of [12, 19, 20]) {
    assert(!pre82.some((m) => m.param === staleParam), `preset-82: stale target-0 slot (param ${staleParam}) surfaced`);
  }

  // The table is device-general: derived from each device's own walk start.
  const fm9Pre = (decodeGen3Body(bodyOf(join(FIXTURES, '../../fm9/fixtures/devs-gift-of-tone.syx'), MODEL_FM9), MODEL_FM9).modifiers ?? [])
    .filter((m) => m.origin === 'pre-chain');
  const iiiPre = (decodeGen3Body(bodyOf(join(FIXTURES, '../../axe-fx-iii/fixtures/devs-gift-of-tone.syx'), MODEL_AXE_FX_III), MODEL_AXE_FX_III).modifiers ?? [])
    .filter((m) => m.origin === 'pre-chain');
  assert(fm9Pre.length === 3, `FM9 export: expected 3 pre-chain modifiers, got ${fm9Pre.length}`);
  assert(iiiPre.length === 20, `Axe-Fx III export: expected 20 pre-chain modifiers, got ${iiiPre.length}`);
}
