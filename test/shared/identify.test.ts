/**
 * Identify handshake + model registry + frame-checksum fixer + preset-dump
 * retarget — goldens.
 *
 * The handshake reply frame comes from a REAL FM3 (fixtures/telemetry.expected.json,
 * migration Phase 0); the retarget golden re-runs the live-validated ForgeFX
 * "audition" transform on a real captured preset dump and asserts the exact
 * header bytes + checksum.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODEL_BROADCAST,
  DEVICE_MODELS,
  buildIdentifyBroadcast,
  isFractalHeaderFrame,
  parseIdentifyResponse,
  modelFromPortName,
} from '../../src/shared/identify.js';
import { fixFrameChecksums, fractalChecksum } from '../../src/shared/checksum.js';
import { retargetPresetDumpToEditBuffer, parsePresetDump } from '../../src/devices/gen3/presetDump.js';
import { decodeRawPatch } from '../../src/devices/gen3/presetHuffman.js';

const FM3_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'gen3', 'fm3', 'fixtures');

const parseHex = (h: string): number[] => (h.match(/../g) ?? []).map((x) => parseInt(x, 16));
const toHex = (b: readonly number[]): string => b.map((x) => x.toString(16).padStart(2, '0')).join('');

function fail(msg: string): never {
  throw new Error(`[shared/identify] ${msg}`);
}

export const IDENTIFY_CASE_COUNT = 11;

export function runIdentifyTests(): void {
  // ── broadcast frame golden (checksum-inclusive) ──
  const b = buildIdentifyBroadcast();
  // F0 00 01 74 7F 00 → cs = f0^00^01^74^7f^00 & 0x7f
  const cs = (0xf0 ^ 0x00 ^ 0x01 ^ 0x74 ^ 0x7f ^ 0x00) & 0x7f;
  const expected = [0xf0, 0x00, 0x01, 0x74, MODEL_BROADCAST, 0x00, cs, 0xf7];
  if (toHex(b) !== toHex(expected)) fail(`broadcast frame ${toHex(b)} !== ${toHex(expected)}`);

  // ── live FM3 handshake reply parses to modelId 0x11 ──
  const telemetry = JSON.parse(readFileSync(join(FM3_FIXTURES, 'telemetry.expected.json'), 'utf8')) as {
    entries: { name: string; runs: { frames: string[]; expected: { modelId?: number } }[] }[];
  };
  const hs = telemetry.entries.find((e) => e.name === 'handshake') ?? fail('handshake fixture missing');
  const reply = hs.runs[0]!.frames.map(parseHex).find((f) => isFractalHeaderFrame(f)) ?? fail('no header frame in handshake capture');
  const parsed = parseIdentifyResponse(reply) ?? fail('parseIdentifyResponse returned null');
  if (parsed.modelId !== 0x11) fail(`handshake modelId ${parsed.modelId} !== 0x11`);
  if (parsed.modelId !== hs.runs[0]!.expected.modelId) fail('parsed modelId disagrees with frozen expected value');

  // ── registry sanity: live-codec devices ──
  for (const [id, codec] of [[0x07, 'axe2'], [0x10, 'axe3'], [0x11, 'fm3'], [0x12, 'fm9'], [0x14, 'vp4'], [0x15, 'am4']] as const) {
    if (DEVICE_MODELS[id]?.codec !== codec) fail(`DEVICE_MODELS[0x${id.toString(16)}].codec !== '${codec}'`);
  }

  // ── port-name fallback: longest-name-first ordering ──
  const cases: [string, number | null][] = [
    ['Axe-Fx III MIDI In', 0x10],
    ['AXE-FX III:AXE-FX III MIDI 1', 0x10],
    ['FM3 MIDI In', 0x11],
    ['fm9 usb', 0x12],
    ['AM4 MIDI', 0x15],
    ['Axe-Fx II XL+ MIDI', 0x07], // gen-2 now has a live codec
    ['VP4 USB MIDI', 0x14],
    ['Some Random Interface', null],
  ];
  for (const [port, want] of cases) {
    const got = modelFromPortName(port);
    if (got !== want) fail(`modelFromPortName('${port}') = ${got}, want ${want}`);
  }

  // ── fixFrameChecksums: corrupt two frames, fixer restores both ──
  const streamA = buildIdentifyBroadcast();
  const streamB = buildIdentifyBroadcast();
  streamB[4] = 0x11; // different model → different checksum
  const stream = [...streamA, ...streamB];
  stream[6] = 0x00; // corrupt cs of frame A
  stream[14] = 0x00; // corrupt cs of frame B
  fixFrameChecksums(stream);
  if (stream[6] !== fractalChecksum(streamA.slice(0, 6))) fail('fixFrameChecksums missed frame A');
  if (stream[14] !== fractalChecksum([0xf0, 0x00, 0x01, 0x74, 0x11, 0x00])) fail('fixFrameChecksums missed frame B');

  // ── retargetPresetDumpToEditBuffer on a real FM3 dump ──
  const syx = Array.from(new Uint8Array(readFileSync(join(FM3_FIXTURES, 'preset-5.syx'))));
  const before = syx.slice();
  const found = retargetPresetDumpToEditBuffer(syx);
  if (!found) fail('retarget found no 0x77 header in a real dump');
  if (syx[6] !== 0x7f || syx[7] !== 0x7f) fail('retarget did not write the 7F 7F edit-buffer sentinel');
  // checksum of the header frame must validate: XOR from F0 to before-cs == cs
  const end = syx.indexOf(0xf7);
  if (fractalChecksum(syx.slice(0, end - 1)) !== syx[end - 1]) fail('retargeted header checksum invalid');
  // everything outside the header frame is untouched
  for (let i = end + 1; i < syx.length; i++) {
    if (syx[i] !== before[i]) fail(`retarget mutated byte ${i} outside the header frame`);
  }
  // and the retargeted dump still parses + CRC-validates through the codec pipeline
  const reparsed = parsePresetDump(Uint8Array.from(syx), 0, 0x11);
  const decoded = decodeRawPatch(reparsed.chunkPayloads);
  if (!decoded.crcValid) fail('retargeted dump no longer CRC-validates');

  // ── retarget is a no-op (false) on a non-dump stream ──
  const notDump = buildIdentifyBroadcast();
  if (retargetPresetDumpToEditBuffer(notDump)) fail('retarget claimed a header in a non-dump stream');
}
