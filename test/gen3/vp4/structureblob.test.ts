/**
 * VP4 whole-preset STRUCTURE-blob goldens (eid206 pid0 tc=0x1f).
 *
 * Covers the single-round-trip structure read ported from upstream
 * fractal-midi 0.6.1:
 *   (a) buildVp4GetStructureBlob() emits the exact 18-byte GET frame
 *       VP4-Edit sends (byte-verbatim in both fw 4.03 captures);
 *   (b) parseVp4StructureBlob() decodes a hand-built 192-byte raw record
 *       (status flag, current scene, preset name, 4 scene names, 4 chain
 *       effectIds) to the expected fields;
 *   (c) an 8→7 packed 220-byte response payload round-trips back to the
 *       192-byte raw record via the shared chunked pack/unpack.
 *
 * The 192-byte raw record here is SYNTHETIC (constructed in-test), not a
 * captured device blob — the codec repo carries no VP4 structure `.syx`
 * fixture. Its layout mirrors the byte-offsets decoded from the fw 4.03
 * captures; the pack step uses the same `packValueChunked` the device's
 * response uses, so the round-trip exercises the real unpack path.
 */
import {
  buildVp4GetStructureBlob,
  parseVp4StructureBlob,
} from '../../../src/gen3/vp4/index.js';
import { encode14 } from '../../../src/shared/septet16.js';
import { packValueChunked } from '../../../src/shared/packValue.js';
import { fractalChecksum } from '../../../src/shared/checksum.js';

function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Write an ASCII name + NUL terminator into `raw` at `offset` (32-byte record). */
function writeName(raw: Uint8Array, offset: number, name: string): void {
  for (let i = 0; i < name.length; i++) raw[offset + i] = name.charCodeAt(i) & 0x7f;
  raw[offset + name.length] = 0; // NUL terminator
}

/** Write a u32 little-endian into `raw` at `offset`. */
function writeU32LE(raw: Uint8Array, offset: number, value: number): void {
  raw[offset] = value & 0xff;
  raw[offset + 1] = (value >> 8) & 0xff;
  raw[offset + 2] = (value >> 16) & 0xff;
  raw[offset + 3] = (value >> 24) & 0xff;
}

/** Build a synthetic 192-byte raw structure record. */
function buildRawRecord(): Uint8Array {
  const raw = new Uint8Array(192);
  raw[0] = 0x60; // status: edited
  raw[4] = 0x01; // structural-edit toggle (ignored by the parse)
  raw[8] = 2; // current scene, 0-based → display 3
  // [12..15] live telemetry float — must be EXCLUDED from the parse.
  writeU32LE(raw, 12, 0x3f800000); // arbitrary float32 bytes
  writeName(raw, 16, 'Virtual Pedalboard'); // preset name
  writeName(raw, 48, 'Scene One');
  writeName(raw, 80, 'Scene Two');
  writeName(raw, 112, 'Scene Three');
  writeName(raw, 144, 'Scene Four');
  // Chain: 4 × u32 LE effectId. 70=Delay, 118=Drive, 90=Phaser, 94=Wah on the
  // shared gen-3 block table; 0 = empty slot (use a real 4-full chain here).
  writeU32LE(raw, 176, 70);
  writeU32LE(raw, 180, 118);
  writeU32LE(raw, 184, 90);
  writeU32LE(raw, 188, 94);
  return raw;
}

/** Assemble a full eid206 pid0 tc=0x1f response frame around a raw record. */
function buildResponseFrame(raw: Uint8Array): number[] {
  const packed = Array.from(packValueChunked(raw));
  const body = [
    0xf0, 0x00, 0x01, 0x74, 0x14, 0x01,
    ...encode14(206), // eid
    ...encode14(0), // pid
    0x1f, // tc
    0x00, 0x00, 0x00,
    ...encode14(raw.length), // 14-bit raw-length tag (192 → 40 01)
    ...packed,
  ];
  return [...body, fractalChecksum(body), 0xf7];
}

export function runVp4StructureBlobTests(): void {
  const failed: string[] = [];

  // (a) GET-frame builder emits the exact captured 18 bytes.
  const getFrame = buildVp4GetStructureBlob();
  const expectedGet = 'f000017414014e0100001f000000000040f7';
  if (hex(getFrame) !== expectedGet) {
    failed.push(`GET frame drift\n  expected: ${expectedGet}\n  got:      ${hex(getFrame)}`);
  }
  if (getFrame.length !== 18) {
    failed.push(`GET frame length drift — expected 18, got ${getFrame.length}`);
  }

  // (b)+(c) parse a packed 220-byte response built from the synthetic raw record.
  const raw = buildRawRecord();
  const packedLen = packValueChunked(raw).length;
  if (packedLen !== 220) {
    failed.push(`packed length drift — expected 220, got ${packedLen}`);
  }
  const frame = buildResponseFrame(raw);
  const parsed = parseVp4StructureBlob(frame);

  if (parsed.statusFlag !== 0x60) failed.push(`statusFlag — got 0x${parsed.statusFlag.toString(16)}`);
  if (parsed.currentScene !== 2) failed.push(`currentScene — got ${parsed.currentScene}`);
  if (parsed.currentSceneDisplay !== 3) failed.push(`currentSceneDisplay — got ${parsed.currentSceneDisplay}`);
  if (parsed.presetName !== 'Virtual Pedalboard') failed.push(`presetName — got "${parsed.presetName}"`);
  const expectedScenes = ['Scene One', 'Scene Two', 'Scene Three', 'Scene Four'];
  for (let i = 0; i < 4; i++) {
    if (parsed.sceneNames[i] !== expectedScenes[i]) {
      failed.push(`sceneNames[${i}] — got "${parsed.sceneNames[i]}"`);
    }
  }
  const expectedChain = [70, 118, 90, 94];
  for (let i = 0; i < 4; i++) {
    const slot = parsed.chain[i];
    if (!slot || slot.effectId !== expectedChain[i]) {
      failed.push(`chain[${i}].effectId — got ${JSON.stringify(slot)}`);
    }
  }
  // Slot 0 = effectId 70 must resolve to the shared gen-3 block name "Delay".
  if (parsed.chain[0]?.name !== 'Delay') {
    failed.push(`chain[0].name — expected "Delay", got "${parsed.chain[0]?.name}"`);
  }

  // Empty-slot handling: effectId 0 → null.
  const rawEmpty = buildRawRecord();
  writeU32LE(rawEmpty, 180, 0); // slot 2 empty
  const parsedEmpty = parseVp4StructureBlob(buildResponseFrame(rawEmpty));
  if (parsedEmpty.chain[1] !== null) {
    failed.push(`empty slot — expected null, got ${JSON.stringify(parsedEmpty.chain[1])}`);
  }

  // Malformed frames must throw.
  const notVp4 = [0xf0, 0x00, 0x01, 0x74, 0x10, 0x01, 0x4e, 0x01, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00, 0x40, 0x01, 0x00, 0x00, 0x00, 0xf7];
  let threw = false;
  try { parseVp4StructureBlob(notVp4); } catch { threw = true; }
  if (!threw) failed.push('parseVp4StructureBlob: expected throw on non-VP4 (III) frame');

  // Bad checksum must throw.
  const badCks = [...frame];
  badCks[badCks.length - 2] = (badCks[badCks.length - 2] + 1) & 0x7f;
  threw = false;
  try { parseVp4StructureBlob(badCks); } catch { threw = true; }
  if (!threw) failed.push('parseVp4StructureBlob: expected throw on checksum mismatch');

  if (failed.length) {
    throw new Error(`VP4 structure-blob goldens failed:\n${failed.join('\n')}`);
  }
  console.log(`  vp4/structureblob: ${VP4_STRUCTUREBLOB_CASE_COUNT} cases PASS`);
}

// GET(2) + packedLen(1) + parse fields: status, scene, sceneDisplay, presetName,
// 4 scenes, 4 chain ids, chain[0] name, empty-slot, 2 throw-cases.
export const VP4_STRUCTUREBLOB_CASE_COUNT = 2 + 1 + 4 + 4 + 4 + 1 + 1 + 2;
