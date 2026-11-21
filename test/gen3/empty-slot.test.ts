/**
 * Gen-3 empty preset slot + bounded Huffman tree goldens.
 *
 * An unused preset slot reads back as a normal full-length dump (0x77 header,
 * N x 0x78 chunks, 0x79 footer) whose raw_patch is entirely zero: stored CRC 0,
 * sizes 0, no code tree. The dump is built SYNTHETICALLY here (no fixture file)
 * from the family-constant frame shapes, with real per-frame checksums.
 *
 * Proves:
 *   1. the empty dump frames, decodes as `empty` (no throw, empty body, CRC not
 *      valid), and every downstream reader/author entry point either returns an
 *      empty result or refuses with a clear Error;
 *   2. `isEmptyRawPatch` is exact (one non-zero byte anywhere makes it non-empty);
 *   3. the Huffman tree reader is bounded: truncated / garbage data throws a
 *      plain `Error` (never a RangeError stack overflow), while a legal
 *      256-symbol tree and the real preset fixture still decode unchanged.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHUNK_PAYLOAD_LEN,
  HEADER_LEN,
  CHUNK_LEN,
  FOOTER_LEN,
  parsePresetDump,
  serializePresetDump,
  type ParsedPresetDump,
} from '../../src/devices/gen3/presetDump.js';
import {
  decodeRawPatch,
  huffmanCompress,
  huffmanUncompress,
  isEmptyRawPatch,
} from '../../src/devices/gen3/presetHuffman.js';
import { decodeGen3Body, decodeGen3PresetDump, MODEL_FM3 } from '../../src/devices/gen3/presetBody.js';
import { readBlockParamsForModel, hasBlockParamModel } from '../../src/devices/gen3/blockParams.js';
import { validateGen3Preset } from '../../src/devices/gen3/presetValidate.js';
import { renamePreset, swapBlockType } from '../../src/devices/gen3/presetAuthor.js';
import { authorGen3PresetFromIR, authorGen3PresetFromIRFull } from '../../src/devices/gen3/presetAuthorIr.js';
import { FM3_DESCRIPTOR } from '../../src/devices/gen3/device.js';
import { makeGen3BroadcastMockResponder } from '../../src/devices/gen3/parityMock.js';
import type { DispatchCtx } from '../../src/core/protocol-generic/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FM3_PRESET_5 = join(HERE, 'fm3', 'fixtures', 'preset-5.syx');

export const EMPTY_SLOT_CASE_COUNT = 14;

const CHUNKS = 8; // FM3 / FM9 dumps carry 8 chunk frames; the Axe-Fx III carries 16

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[gen3/empty-slot] ${msg}`);
}

/** Run `f` and return the thrown value (fails the test if nothing is thrown). */
function thrown(f: () => unknown, what: string): Error {
  try {
    f();
  } catch (e) {
    assert(e instanceof Error, `${what}: threw a non-Error value`);
    return e as Error;
  }
  throw new Error(`[gen3/empty-slot] ${what}: expected a throw`);
}

/** A synthetic unused-slot dump: slot-addressed header, all-zero chunk bodies
 *  behind the usual 2-byte chunk discriminator, zero footer (XOR 0). With
 *  `named`, one name byte is set so the raw_patch is no longer all zero. */
function buildEmptyDump(modelId: number, slot: number, chunks = CHUNKS, named = false): Uint8Array {
  const chunkPayloads: Uint8Array[] = [];
  for (let i = 0; i < chunks; i++) {
    const p = new Uint8Array(CHUNK_PAYLOAD_LEN);
    p[0] = 0x00;
    p[1] = 0x08;
    chunkPayloads.push(p);
  }
  // raw_patch name field = word 4 -> septet triplet at payload offset 2 + 4 * 3.
  if (named) chunkPayloads[0]![2 + 4 * 3] = 0x41;
  const parsed: ParsedPresetDump = {
    modelId,
    raw: new Uint8Array(0),
    byteLength: HEADER_LEN + CHUNK_LEN * chunks + FOOTER_LEN,
    headerPayload: Uint8Array.from([(slot >> 7) & 0x7f, slot & 0x7f, 0x00, 0x40, 0x00]),
    chunkPayloads,
    footerPayload: new Uint8Array(3),
  };
  return serializePresetDump(parsed);
}

/** MSB-first bit writer for hand-built Huffman streams. */
class Bits {
  private readonly bytes: number[] = [];
  private cur = 0;
  private n = 0;
  bit(b: number): this {
    this.cur = ((this.cur << 1) | (b & 1)) & 0xff;
    if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
    return this;
  }
  leaf(sym: number): this {
    this.bit(1);
    for (let i = 7; i >= 0; i--) this.bit((sym >> i) & 1);
    return this;
  }
  done(): Uint8Array {
    const out = [...this.bytes];
    if (this.n > 0) out.push((this.cur << (8 - this.n)) & 0xff);
    return Uint8Array.from(out);
  }
}

/** Right-leaning chain tree over `leaves` symbols: internal(leaf0, internal(leaf1, ...)). */
function chainTree(w: Bits, leaves: number): void {
  for (let i = 0; i < leaves - 1; i++) w.bit(0).leaf(i & 0xff);
  w.leaf((leaves - 1) & 0xff);
}

/** Split a flat byte stream into F0..F7 frames. */
function framesOf(bytes: Uint8Array): number[][] {
  const frames: number[][] = [];
  let cur: number[] | null = null;
  for (const b of bytes) {
    if (b === 0xf0) cur = [b];
    else if (cur) {
      cur.push(b);
      if (b === 0xf7) { frames.push(cur); cur = null; }
    }
  }
  return frames;
}

/** Minimal dispatch context for the FM3 reader: every outgoing frame is answered by `reply`, and the
 *  answer is delivered to `onMessage` subscribers asynchronously (like inbound MIDI). */
function scriptedCtx(reply: (req: number[]) => number[][]): DispatchCtx {
  const handlers = new Set<(bytes: number[]) => void>();
  const conn = {
    send: (bytes: number[]): void => {
      const frames = reply(bytes);
      queueMicrotask(() => { for (const f of frames) for (const h of [...handlers]) h([...f]); });
    },
    onMessage: (h: (bytes: number[]) => void): (() => void) => {
      handlers.add(h);
      return () => { handlers.delete(h); };
    },
  };
  return { conn: conn as unknown as DispatchCtx['conn'], descriptor: FM3_DESCRIPTOR };
}

export async function runEmptySlotTests(): Promise<void> {
  const empty = buildEmptyDump(MODEL_FM3, 200);

  // 1. The synthetic dump is a well-formed gen-3 dump of the real size.
  assert(empty.length === HEADER_LEN + CHUNK_LEN * CHUNKS + FOOTER_LEN, `dump length ${empty.length}`);
  const parsed = parsePresetDump(empty, 0, MODEL_FM3);
  assert(parsed.chunkPayloads.length === CHUNKS, 'empty dump parses to 8 chunk frames');
  assert(parsed.byteLength === empty.length, 'empty dump parses to its full length');

  // 2. decodeRawPatch recognises it: no Huffman, empty body, CRC not valid.
  const raw = decodeRawPatch(parsed.chunkPayloads);
  assert(raw.empty === true, 'empty dump -> empty:true');
  assert(raw.crcValid === false, 'empty dump -> crcValid false');
  assert(raw.storedCrc === 0, 'empty dump -> stored CRC 0');
  assert(raw.decompSize === 0 && raw.compSize === 0, 'empty dump -> sizes 0');
  assert(raw.body.length === 0, 'empty dump -> empty body');
  assert(raw.rawPatch.length === 16384, `raw_patch length ${raw.rawPatch.length}`);
  assert(isEmptyRawPatch(raw.rawPatch), 'raw_patch of the empty dump is all zero');

  // 3. isEmptyRawPatch is exact.
  const oneByte = (i: number): Uint8Array => { const z = new Uint8Array(16384); z[i] = 1; return z; };
  assert(isEmptyRawPatch(new Uint8Array(16384)), 'all-zero image is empty');
  assert(!isEmptyRawPatch(oneByte(0)), 'a set byte at 0 is not empty');
  assert(!isEmptyRawPatch(oneByte(0x4c)), 'a set byte at the body start is not empty');
  assert(!isEmptyRawPatch(oneByte(16383)), 'a set byte at the very end is not empty');
  assert(!isEmptyRawPatch(new Uint8Array(0)), 'a zero-length image is not an empty slot');

  // 4. Whole-dump decode: no throw, empty snapshot.
  const d = decodeGen3PresetDump(empty, MODEL_FM3);
  assert(d.empty === true && d.crc_valid === false, 'decodeGen3PresetDump flags the empty slot');
  assert(d.preset_name === '' && d.decompressed_size === 0 && d.decompressed_body.length === 0, 'empty name/size/body');
  assert(d.grid === undefined && d.blocks === undefined && d.scene_names === undefined, 'no grid/blocks/scenes');

  // 5. Body-level readers behave on an empty body (every gen-3 model).
  for (const model of [0x10, 0x11, 0x12]) {
    assert(Object.keys(decodeGen3Body(new Uint8Array(0), model)).length === 0, `decodeGen3Body(empty) for 0x${model.toString(16)}`);
    if (!hasBlockParamModel(model)) continue;
    const placed = new Set<number>(Array.from({ length: 600 }, (_, i) => i));
    assert(readBlockParamsForModel(new Uint8Array(0), placed, model).length === 0, `readBlockParamsForModel(empty) for 0x${model.toString(16)}`);
  }

  // 6. The coherence validator refuses it as data, without throwing.
  const v = validateGen3Preset(empty, MODEL_FM3);
  assert(!v.ok && v.blockCount === 0 && v.issues.includes('invalid CRC'), `validator on empty slot: ${v.issues.join('; ')}`);

  // 7. Authoring entry points refuse an empty base with a clear Error.
  for (const [what, f] of [
    ['renamePreset', () => renamePreset(empty, 'x')],
    ['swapBlockType', () => swapBlockType(empty, 'Amp', 'x')],
    ['authorGen3PresetFromIR', () => authorGen3PresetFromIR(empty, { blocks: [] }, MODEL_FM3)],
    ['authorGen3PresetFromIRFull (empty scaffold)', () => authorGen3PresetFromIRFull(empty, { blocks: [] }, MODEL_FM3)],
  ] as const) {
    const e = thrown(f, what);
    assert(!(e instanceof RangeError) && /empty preset slot/.test(e.message), `${what}: ${e.message}`);
  }

  // 8. A 16-chunk (Axe-Fx III shaped) empty dump is recognised the same way.
  const empty16 = buildEmptyDump(0x10, 5, 16);
  assert(decodeRawPatch(parsePresetDump(empty16, 0, 0x10).chunkPayloads).empty === true, '16-chunk empty dump');

  // 9. Truncated / garbage compressed data: a clear Error, never a RangeError.
  const truncCases: Array<[string, Uint8Array, RegExp]> = [
    ['no data at all', new Uint8Array(0), /Huffman tree truncated/],
    ['internal nodes only, 16 bits', new Uint8Array(2), /Huffman tree truncated/],
    ['leaf cut off mid-symbol', Uint8Array.from([0b01000000]), /Huffman tree truncated/],
    ['all-zero, 32 bytes', new Uint8Array(32), /Huffman tree/],
    ['all-zero, max compressed size', new Uint8Array(0xffff), /Huffman tree malformed/],
    ['all-ones prefix then cut', Uint8Array.from([0xff]), /Huffman tree truncated/],
  ];
  for (const [what, data, re] of truncCases) {
    const e = thrown(() => huffmanUncompress(data, 100), what);
    assert(!(e instanceof RangeError), `${what}: stack overflow (${e.message})`);
    assert(re.test(e.message), `${what}: unexpected message "${e.message}"`);
  }
  // Same through the dump path: a raw_patch that is NOT all zero (it carries a
  // name byte) but claims compressed size 0 has no code tree to read.
  const noTree = parsePresetDump(buildEmptyDump(MODEL_FM3, 200, CHUNKS, true), 0, MODEL_FM3);
  const noTreeErr = thrown(() => decodeRawPatch(noTree.chunkPayloads), 'named patch without a body');
  assert(
    !(noTreeErr instanceof RangeError) && /Huffman tree truncated/.test(noTreeErr.message),
    `named patch without a body: ${noTreeErr.message}`,
  );

  // 10. More than 256 symbols can not be a byte-symbol tree.
  const tooMany = new Bits();
  chainTree(tooMany, 257);
  const tooManyErr = thrown(() => huffmanUncompress(tooMany.done(), 1), '257-leaf tree');
  assert(!(tooManyErr instanceof RangeError) && /Huffman tree malformed/.test(tooManyErr.message), `257 leaves: ${tooManyErr.message}`);

  // 11. ...but a legal 256-symbol tree (255 levels deep) still decodes exactly.
  const full = new Bits();
  chainTree(full, 256);
  for (let i = 0; i < 255; i++) full.bit(1); // 255 right-turns -> the deepest leaf, symbol 255
  full.bit(0); // leaf 0 (one left turn from the root)
  const fullOut = huffmanUncompress(full.done(), 2);
  assert(fullOut.length === 2 && fullOut[0] === 255 && fullOut[1] === 0, `256-leaf tree decoded ${Array.from(fullOut)}`);
  // A fully populated compressor tree round-trips.
  const everyByte = new Uint8Array(4096);
  for (let i = 0; i < everyByte.length; i++) everyByte[i] = (i * 7 + (i >> 3)) & 0xff;
  const rt = huffmanUncompress(huffmanCompress(everyByte), everyByte.length);
  assert(rt.length === everyByte.length && rt.every((b, i) => b === everyByte[i]), '256-symbol compress/decompress round-trip');

  // 12. A real preset is untouched: not empty, CRC valid, non-empty body.
  const real = new Uint8Array(readFileSync(FM3_PRESET_5));
  const realRaw = decodeRawPatch(parsePresetDump(real, 0, MODEL_FM3).chunkPayloads);
  assert(realRaw.empty === false && realRaw.crcValid === true && realRaw.body.length > 0, 'real preset decodes as before');

  // 13. get_preset(location) on an empty slot: an empty snapshot with a clear warning, not a
  //     "Huffman-decompressed ... CRC INVALID" decode report for a preset that does not exist.
  const reader = FM3_DESCRIPTOR.reader!;
  const emptyFrames = framesOf(buildEmptyDump(MODEL_FM3, 5));
  const emptySnap = await reader.getPreset!(scriptedCtx((req) => (req[5] === 0x03 ? emptyFrames : [])), { location: 5 });
  assert(emptySnap.name === '' && emptySnap.slots.length === 0, 'empty slot snapshot has no name and no slots');
  assert(emptySnap.whole_preset?.empty === true, 'empty slot snapshot: whole_preset.empty === true');
  assert(emptySnap.whole_preset?.crc_valid === false, 'empty slot snapshot: crc_valid false');
  const emptyWarn = emptySnap.read_warnings ?? [];
  assert(emptyWarn.length === 1 && /slot 5 is unused \(empty preset slot\)/.test(emptyWarn[0]!), `empty slot warning: ${emptyWarn.join(' | ')}`);
  assert(!emptyWarn.some((w) => /Huffman-decompressed|CRC INVALID/.test(w)), 'empty slot snapshot carries no decode/CRC warning');

  // 14. ...and a populated stored preset through the same reader is unchanged and never carries `empty`.
  const populated = makeGen3BroadcastMockResponder({ modelByte: MODEL_FM3 });
  const popSnap = await reader.getPreset!(scriptedCtx((req) => populated(req)), { location: 7 });
  assert(popSnap.name === 'Mock Preset', `populated snapshot name: ${popSnap.name}`);
  assert(popSnap.whole_preset !== undefined && !('empty' in popSnap.whole_preset), 'populated whole_preset has no `empty` key');
  assert(popSnap.whole_preset?.crc_valid === true, 'populated snapshot: crc_valid true');
  assert(/Huffman-decompressed/.test((popSnap.read_warnings ?? [])[0] ?? ''), 'populated snapshot keeps the decode warning');
}
