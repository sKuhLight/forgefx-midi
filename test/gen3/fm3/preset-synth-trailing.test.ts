/**
 * Scaffold trailing boundary for full-body synthesis.
 *
 * `authorGen3PresetFromIRFull` carries a scaffold's fixed trailing region
 * verbatim into the synthesized body. That region starts after the FULL
 * geometric chain walk (records advanced while cols/rows stay sane), not after
 * the last grid-placed effect block: a chain can end with preset-scoped records
 * the synthesizer does not re-emit, e.g. the 257x1 (560-byte) Scene MIDI record,
 * and anchoring on the last grid block dragged them into the new body.
 *
 * Measured boundaries (decompSize - tail):
 *   FM3 preset-96   12110 - 3832 = 8278  (0x2056)
 *   FM9 export      12708 -  736 = 11972
 *   Axe-Fx III      13028 - 3832 = 9196
 * In all three bundled scaffolds the last grid-placed block already ends on the
 * boundary, so the bundled output is unchanged; the synthetic case below adds a
 * Scene MIDI record after the last effect block to pin the difference.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePresetDump, serializePresetDump } from '../../../src/devices/gen3/presetDump.js';
import { decodeRawPatch, reencodeRawPatch } from '../../../src/devices/gen3/presetHuffman.js';
import { decodeGen3Body, MODEL_AXE_FX_III, MODEL_FM3, MODEL_FM9 } from '../../../src/devices/gen3/presetBody.js';
import { authorGen3PresetFromIRFull } from '../../../src/devices/gen3/presetAuthorIr.js';
import { reframeRawPatch } from '../../../src/devices/gen3/presetAuthor.js';
import { scaffoldTrailingSize, type SynthPreset } from '../../../src/devices/gen3/presetSynth.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const PRESET_SYNTH_TRAILING_CASE_COUNT = 2;

function fail(msg: string): never {
  throw new Error(`[fm3/preset-synth-trailing] ${msg}`);
}
function assert(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
}

const u16 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8)) & 0xffff;
const w16 = (b: Uint8Array, o: number, v: number): void => {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
};

/** One Amp block in column 0 — enough for the synthesizer to build a chain. */
const IR: SynthPreset = {
  name: 'Trailing Boundary',
  sceneNames: ['Scene 1'],
  blocks: [{ key: 'amp1', family: 'amp', typeValue: 40 }],
  routing: { gridCells: [{ row: 0, col: 0, effectId: 58, blockKey: 'amp1' }] },
};

function decodeDump(bytes: Uint8Array, model: number) {
  const parsed = parsePresetDump(bytes, 0, model);
  return { parsed, ...decodeRawPatch(parsed.chunkPayloads) };
}

/** Geometric chain walk, bounded by `limit` (the tail start). */
function walkRecords(body: Uint8Array, start: number, limit: number): { cols: number; rows: number; size: number }[] {
  const out: { cols: number; rows: number; size: number }[] = [];
  let pos = start;
  while (pos + 23 * 2 <= limit) {
    const cols = u16(body, pos + 30);
    const rows = u16(body, pos + 32);
    if (cols === 0 || rows === 0 || cols > 500 || rows > 8) break;
    const size = (23 + cols * rows) * 2;
    out.push({ cols, rows, size });
    pos += size;
  }
  return out;
}

export function runPresetSynthTrailingTests(): void {
  // ── 1. the bundled scaffolds end their chain exactly on the fixed tail ──
  const scaffolds = [
    { label: 'FM3', file: join(FIXTURES, 'preset-96.syx'), model: MODEL_FM3, chainStart: 0x120e, tail: 3832, decompSize: 12110 },
    { label: 'FM9', file: join(FIXTURES, '../../fm9/fixtures/devs-gift-of-tone.syx'), model: MODEL_FM9, chainStart: 0x1eb6, tail: 736, decompSize: 12708 },
    { label: 'Axe-Fx III', file: join(FIXTURES, '../../axe-fx-iii/fixtures/devs-gift-of-tone.syx'), model: MODEL_AXE_FX_III, chainStart: 0x141e, tail: 3832, decompSize: 13028 },
  ];
  for (const s of scaffolds) {
    const bytes = new Uint8Array(readFileSync(s.file));
    const scaf = decodeDump(bytes, s.model);
    assert(scaf.decompSize === s.decompSize, `${s.label}: scaffold decompSize ${scaf.decompSize} != ${s.decompSize}`);
    assert(scaffoldTrailingSize(s.model) === s.tail, `${s.label}: scaffoldTrailingSize ${scaffoldTrailingSize(s.model)} != ${s.tail}`);
    const tailStart = scaf.decompSize - s.tail;
    const firstBlock = (decodeGen3Body(scaf.body, s.model).blocks ?? [])[0];
    assert(firstBlock?.offset === s.chainStart, `${s.label}: chain start 0x${firstBlock?.offset.toString(16)} != 0x${s.chainStart.toString(16)}`);
    const recs = walkRecords(scaf.body, s.chainStart, tailStart);
    const chainBytes = recs.reduce((n, r) => n + r.size, 0);
    assert(s.chainStart + chainBytes === tailStart, `${s.label}: chain records end at ${s.chainStart + chainBytes}, tail starts at ${tailStart}`);

    const result = authorGen3PresetFromIRFull(bytes, IR, s.model);
    const authored = decodeDump(result.syx, s.model);
    const placedBytes = result.blocks.reduce((n, b) => n + (23 + b.cols * b.rows) * 2, 0);
    assert(
      authored.decompSize === s.chainStart + placedBytes + s.tail,
      `${s.label}: authored body ${authored.decompSize} != ${s.chainStart} + ${placedBytes} + ${s.tail}`,
    );
    const authoredTail = authored.body.subarray(authored.body.length - s.tail);
    const scaffoldTail = scaf.body.subarray(scaf.decompSize - s.tail);
    assert(
      authoredTail.every((v, i) => v === scaffoldTail[i]),
      `${s.label}: authored trailing region is not the scaffold's fixed tail`,
    );
  }

  // ── 2. a Scene MIDI record after the last grid block must not be carried ──
  const scaffoldBytes = new Uint8Array(readFileSync(join(FIXTURES, 'preset-96.syx')));
  const scaf = decodeDump(scaffoldBytes, MODEL_FM3);
  const tailStart = scaf.decompSize - 3832;
  const rec = new Uint8Array((23 + 257) * 2);
  w16(rec, 30, 257);
  w16(rec, 32, 1);
  w16(rec, 34, 2);

  const synthetic = new Uint8Array(scaf.body.length + rec.length);
  synthetic.set(scaf.body.subarray(0, tailStart), 0);
  synthetic.set(rec, tailStart);
  w16(synthetic, tailStart - 12, 190); // eid signature of the record
  synthetic.set(scaf.body.subarray(tailStart), tailStart + rec.length);
  assert(u16(synthetic, 0x104) === 0, 'preset-96 grid cell (0,0) must be free for this test');
  w16(synthetic, 0x104, 190); // place eid 190 so the decoder recognises the record

  const syntheticScaffold = serializePresetDump(
    reframeRawPatch(scaf.parsed, reencodeRawPatch(scaf.rawPatch, synthetic)),
  );
  const syntheticDecoded = decodeDump(syntheticScaffold, MODEL_FM3);
  assert(
    (decodeGen3Body(syntheticDecoded.body, MODEL_FM3).blocks ?? []).some(
      (b) => b.block === 'Scene MIDI' && b.cols === 257 && b.rows === 1,
    ),
    'the synthetic scaffold must carry a decodable 257x1 Scene MIDI record after the last effect block',
  );

  const result = authorGen3PresetFromIRFull(syntheticScaffold, IR, MODEL_FM3);
  const authored = decodeDump(result.syx, MODEL_FM3);
  const authoredChainStart = (decodeGen3Body(authored.body, MODEL_FM3).blocks ?? [])[0]?.offset ?? 0x120e;
  const authoredTailStart = authored.decompSize - 3832;
  const carried = walkRecords(authored.body, authoredChainStart, authoredTailStart);
  assert(
    !carried.some((r) => r.cols === 257 && r.rows === 1),
    'the synthesized body must not carry the scaffold\'s 257x1 Scene MIDI record',
  );
  assert(
    authored.decompSize === authoredChainStart + carried.reduce((n, r) => n + r.size, 0) + 3832,
    'the synthesized chain must end exactly on the fixed 3832-byte tail',
  );
}
