/**
 * System + Global Blocks + FC dump tests: the `0x43` request, frame-count math,
 * and strict reassembly of the `0x51/0x52/0x53` group.
 *
 * Fixtures are synthetic words packed like the captured group.
 */
import {
  SYSTEM_DUMP_CANONICAL_FRAMES,
  SYSTEM_DUMP_CANONICAL_WORDS,
  SYSTEM_DUMP_CHUNK_PAYLOAD_LEN,
  SYSTEM_DUMP_CHUNK_WORDS,
  buildSystemDumpRequest,
  parseSystemDump,
  systemDumpFrameCount,
} from '../../src/devices/gen3/systemDump.js';
import { buildFractalFrame, splitFractalFrames } from '../../src/devices/gen3/frame.js';

export const SYSTEM_DUMP_CASE_COUNT = 26;

function fail(msg: string): never {
  throw new Error(`[gen3/systemDump] ${msg}`);
}

function expectThrow(fn: () => unknown, pattern: RegExp, label: string): void {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) fail(`${label}: wrong error: ${message}`);
    return;
  }
  fail(`${label}: did not throw`);
}

function septetsLE(value: number, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = (value >>> (7 * i)) & 0x7f;
  return out;
}

function packChunk(words: Uint16Array, offset: number, count: number): Uint8Array {
  // The 0x52 frame length is fixed at 3,082 bytes; only `count` words are meaningful.
  const payload = new Uint8Array(SYSTEM_DUMP_CHUNK_PAYLOAD_LEN);
  payload[0] = count & 0x7f;
  payload[1] = (count >> 7) & 0x7f;
  for (let i = 0; i < count; i++) {
    const word = words[offset + i];
    const off = 2 + i * 3;
    payload[off] = word & 0x7f;
    payload[off + 1] = (word >> 7) & 0x7f;
    payload[off + 2] = (word >> 14) & 0x7f;
  }
  return payload;
}

function xor16(words: Uint16Array): number {
  let xor = 0;
  for (let i = 0; i < words.length; i++) xor ^= words[i];
  return xor;
}

function joinFrames(frames: readonly Uint8Array[]): Uint8Array {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

function groupFrames(
  model: number,
  declared: number,
  chunkPayloads: readonly Uint8Array[],
  footerXor: number,
  funcs: { header?: number; chunk?: number; footer?: number } = {},
): Uint8Array[] {
  const frames: Uint8Array[] = [
    buildFractalFrame(model, funcs.header ?? 0x51, septetsLE(declared, 3)),
  ];
  for (const payload of chunkPayloads) {
    frames.push(buildFractalFrame(model, funcs.chunk ?? 0x52, payload));
  }
  frames.push(buildFractalFrame(model, funcs.footer ?? 0x53, septetsLE(footerXor, 3)));
  return frames;
}

function makeWords(count: number): Uint16Array {
  const words = new Uint16Array(count);
  for (let i = 0; i < count; i++) words[i] = (i * 13 + 7) & 0xffff;
  return words;
}

function makeGroup(words: Uint16Array, model = 0x11): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < words.length; offset += SYSTEM_DUMP_CHUNK_WORDS) {
    const count = Math.min(SYSTEM_DUMP_CHUNK_WORDS, words.length - offset);
    chunks.push(packChunk(words, offset, count));
  }
  return joinFrames(groupFrames(model, words.length, chunks, xor16(words)));
}

export function runSystemDumpTests(): void {
  // 1 ── request is the lone 0x43 frame with an empty payload
  const request = buildSystemDumpRequest(0x11);
  if (
    [...request].map((b) => b.toString(16).padStart(2, '0')).join(' ') !==
    'f0 00 01 74 11 43 57 f7'
  ) {
    fail(`request bytes ${[...request].map((b) => b.toString(16))}`);
  }

  // 2 ── request is model-specific and checksummed
  const iii = buildSystemDumpRequest(0x10);
  const iiiFrame = splitFractalFrames(iii, 'request', 0x10)[0];
  if (iiiFrame.func !== 0x43 || iiiFrame.payload.length !== 0) fail('III request frame');

  // 3 ── frame-count math: ceil(words / 1,024) + 2
  if (systemDumpFrameCount(65_536) !== 66) fail('frame count 65,536');
  if (systemDumpFrameCount(1_024) !== 3) fail('frame count 1,024');
  if (systemDumpFrameCount(1_025) !== 4) fail('frame count 1,025');
  if (systemDumpFrameCount(1) !== 3) fail('frame count 1');
  if (SYSTEM_DUMP_CANONICAL_WORDS !== 65_536 || SYSTEM_DUMP_CANONICAL_FRAMES !== 66) fail('canonical constants');

  // 4 ── frame-count inputs are range-checked
  expectThrow(() => systemDumpFrameCount(0), /out of range/, 'frame count 0');
  expectThrow(() => systemDumpFrameCount(-1), /out of range/, 'frame count negative');
  expectThrow(() => systemDumpFrameCount(1.5), /out of range/, 'frame count fractional');
  expectThrow(() => systemDumpFrameCount(0x20_0000), /out of range/, 'frame count too large');

  // 5 ── the canonical 66-frame group round-trips
  const canonicalWords = makeWords(65_536);
  const canonical = makeGroup(canonicalWords);
  if (canonical.length !== 197_270) fail(`canonical length ${canonical.length}`);
  const parsedCanonical = parseSystemDump(canonical, 0x11);
  if (parsedCanonical.declaredWords !== 65_536) fail('declared words');
  if (parsedCanonical.chunkWordCounts.length !== 64) fail('canonical chunk count');
  if (parsedCanonical.words.length !== 65_536) fail('canonical word length');
  if (parsedCanonical.footerXor !== xor16(canonicalWords)) fail('canonical footer');
  for (let i = 0; i < canonicalWords.length; i++) {
    if (parsedCanonical.words[i] !== canonicalWords[i]) fail(`canonical word ${i}`);
  }

  // 6 ── every canonical chunk declares 1,024 words
  if (parsedCanonical.chunkWordCounts.some((count) => count !== 1_024)) fail('canonical chunk word counts');

  // 7 ── a short group (3,072 words / 5 frames) parses
  const shortWords = makeWords(3_072);
  const shortParsed = parseSystemDump(makeGroup(shortWords));
  if (shortParsed.chunkWordCounts.join(',') !== '1024,1024,1024') fail('short chunk counts');
  if (shortParsed.words[3_071] !== shortWords[3_071]) fail('short words');

  // 8 ── a non-multiple size (1,025 words) has a 1-word last chunk
  const oddWords = makeWords(1_025);
  const oddParsed = parseSystemDump(makeGroup(oddWords));
  if (oddParsed.chunkWordCounts.join(',') !== '1024,1') fail(`odd chunk counts ${oddParsed.chunkWordCounts}`);

  // 9 ── header function byte must be 0x51
  expectThrow(
    () => parseSystemDump(joinFrames(groupFrames(0x11, 1_024, [packChunk(makeWords(1_024), 0, 1_024)], 0, { header: 0x52 }))),
    /first frame is 0x52/,
    'header func',
  );

  // 10 ── header payload must be 3 bytes
  const shortHeader = joinFrames([
    buildFractalFrame(0x11, 0x51, Uint8Array.from([0, 0])),
    buildFractalFrame(0x11, 0x52, packChunk(makeWords(1_024), 0, 1_024)),
    buildFractalFrame(0x11, 0x53, Uint8Array.from([0, 0, 0])),
  ]);
  expectThrow(() => parseSystemDump(shortHeader), /header payload is 2 bytes/, 'header payload');

  // 11 ── frame count must match the declaration
  const extraChunkFrames = groupFrames(
    0x11,
    1_024,
    [packChunk(makeWords(1_024), 0, 1_024), packChunk(makeWords(1_024), 0, 1_024)],
    0,
  );
  expectThrow(
    () => parseSystemDump(joinFrames(extraChunkFrames)),
    /frames for 1024 declared words/,
    'frame count',
  );

  // 12 ── chunk function byte must be 0x52
  expectThrow(
    () => parseSystemDump(
      joinFrames(groupFrames(0x11, 1_024, [packChunk(makeWords(1_024), 0, 1_024)], 0, { chunk: 0x53 })),
    ),
    /chunk 1 has func 0x53/,
    'chunk func',
  );

  // 13 ── chunk payload must be 3,074 bytes
  const badLengthChunk = new Uint8Array(3_073);
  badLengthChunk[0] = 0;
  badLengthChunk[1] = 8;
  expectThrow(
    () => parseSystemDump(joinFrames(groupFrames(0x11, 1_024, [badLengthChunk], 0))),
    /payload is 3073 bytes/,
    'chunk payload length',
  );

  // 14 ── a chunk must declare exactly the expected word count
  expectThrow(
    () => parseSystemDump(joinFrames(groupFrames(0x11, 1_024, [packChunk(makeWords(1_024), 0, 1_023)], 0))),
    /declares 1023 words, expected 1024/,
    'chunk word count',
  );

  // 15 ── a truncated chunk payload is rejected before reassembly
  const truncatedChunk = packChunk(makeWords(1_024), 0, 1_024).subarray(0, 3_073);
  expectThrow(
    () => parseSystemDump(joinFrames(groupFrames(0x11, 1_024, [truncatedChunk], 0))),
    /payload is 3073 bytes/,
    'chunk payload truncation',
  );

  // 16 ── footer function byte must be 0x53
  expectThrow(
    () => parseSystemDump(
      joinFrames(groupFrames(0x11, 1_024, [packChunk(makeWords(1_024), 0, 1_024)], 0, { footer: 0x51 })),
    ),
    /last frame is 0x51/,
    'footer func',
  );

  // 17 ── footer payload must be 3 bytes
  const words1024 = makeWords(1_024);
  const shortFooter = joinFrames([
    buildFractalFrame(0x11, 0x51, septetsLE(1_024, 3)),
    buildFractalFrame(0x11, 0x52, packChunk(words1024, 0, 1_024)),
    buildFractalFrame(0x11, 0x53, Uint8Array.from([0, 0])),
  ]);
  expectThrow(() => parseSystemDump(shortFooter), /footer payload is 2 bytes/, 'footer payload');

  // 18 ── footer XOR must match the assembled words
  expectThrow(
    () => parseSystemDump(
      joinFrames(groupFrames(0x11, 1_024, [packChunk(words1024, 0, 1_024)], xor16(words1024) ^ 1)),
    ),
    /footer XOR/,
    'footer XOR',
  );

  // 19 ── per-frame checksums are verified
  const corrupt = makeGroup(makeWords(1_024));
  corrupt[11 + 6 + 20] ^= 0x01;
  expectThrow(() => parseSystemDump(corrupt), /checksum/i, 'frame checksum');

  // 20 ── all frames must share one model byte
  const mixed = joinFrames([
    buildFractalFrame(0x11, 0x51, septetsLE(1_024, 3)),
    buildFractalFrame(0x12, 0x52, packChunk(words1024, 0, 1_024)),
    buildFractalFrame(0x11, 0x53, septetsLE(xor16(words1024), 3)),
  ]);
  expectThrow(() => parseSystemDump(mixed), /model/, 'model mismatch');

  // 21 ── a truncated group is rejected
  const complete = makeGroup(makeWords(1_024));
  expectThrow(() => parseSystemDump(complete.subarray(0, complete.length - 4)), /terminator|insufficient/, 'truncated');

  // 22 ── trailing bytes are rejected
  const trailing = new Uint8Array(complete.length + 1);
  trailing.set(complete);
  expectThrow(() => parseSystemDump(trailing), /expected F0/, 'trailing byte');

  // 23 ── too few frames
  expectThrow(() => parseSystemDump(new Uint8Array(0)), /at least 3 frames|expected F0/, 'empty group');
  expectThrow(
    () => parseSystemDump(joinFrames([buildFractalFrame(0x11, 0x51, septetsLE(1_024, 3))])),
    /at least 3 frames/,
    'one frame',
  );

  // 24 ── expected model is enforced
  expectThrow(() => parseSystemDump(complete, 0x12), /does not match expected/, 'expected model');

  // 25 ── a zero declaration is rejected
  expectThrow(
    () => parseSystemDump(
      joinFrames([
        buildFractalFrame(0x11, 0x51, Uint8Array.from([0, 0, 0])),
        buildFractalFrame(0x11, 0x52, Uint8Array.from([0, 0])),
        buildFractalFrame(0x11, 0x53, Uint8Array.from([0, 0, 0])),
      ]),
    ),
    /word count 0 is out of range/,
    'zero words',
  );

  // 26 ── the canonical group has exactly 1 + 64 + 1 frames
  const canonicalFrames = splitFractalFrames(canonical, 'canonical');
  if (canonicalFrames.length !== 66) fail(`canonical frames ${canonicalFrames.length}`);
  if (canonicalFrames.filter((frame) => frame.func === 0x52).length !== 64) fail('canonical 0x52 count');
}
