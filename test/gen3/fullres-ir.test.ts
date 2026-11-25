/**
 * FullRes cab-IR (`0x67/0x68/0x69`) tests: container reassembly/validation, the
 * 32 KB XTEA transform with an injected key, and the absence of any write path.
 *
 * The ciphertext is synthesized in-test from a non-protocol test key; no key
 * material from a real editor/device is used.
 */
import * as fullResIrModule from '../../src/devices/gen3/fullResIr.js';
import {
  FULLRES_IR_CHUNKS,
  FULLRES_IR_CHUNK_PAYLOAD_LEN,
  FULLRES_IR_CHUNK_WORDS,
  FULLRES_IR_FOOTER_PAYLOAD_LEN,
  FULLRES_IR_FRAMES,
  FULLRES_IR_FUNCS,
  FULLRES_IR_HEADER_PAYLOAD_LEN,
  FULLRES_IR_PAIR_COUNT,
  FULLRES_IR_TOTAL_BYTES,
  FULLRES_IR_TOTAL_WORDS,
  decryptFullResIr,
  fullResIrFrameCount,
  parseFullResIr,
  type ParsedFullResIr,
} from '../../src/devices/gen3/fullResIr.js';
import { decryptXteaPairs, type XteaRecordKey } from '../../src/shared/xtea.js';
import { buildFractalFrame, splitFractalFrames } from '../../src/devices/gen3/frame.js';

export const FULLRES_IR_CASE_COUNT = 23;

function fail(msg: string): never {
  throw new Error(`[gen3/fullResIr] ${msg}`);
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

const TEST_KEY: XteaRecordKey = {
  seed: [0x11111111, 0x22222222, 0x33333333, 0x44444444],
};

const DELTA = 0x9e3779b9;

/** Independent forward transform; used only to synthesize ciphertext. */
function encryptPair(v0: number, v1: number, key: readonly number[]): [number, number] {
  let sum = 0;
  for (let cycle = 0; cycle < 32; cycle++) {
    v0 = (v0 + (((((v1 << 4) ^ (v1 >>> 5)) + v1) >>> 0) ^ ((sum + key[sum & 3]) >>> 0))) >>> 0;
    sum = (sum + DELTA) >>> 0;
    v1 = (v1 + (((((v0 << 4) ^ (v0 >>> 5)) + v0) >>> 0) ^ ((sum + key[(sum >>> 11) & 3]) >>> 0))) >>> 0;
  }
  return [v0 >>> 0, v1 >>> 0];
}

function lanesForPair(pair: number): [number, number, number, number] {
  return [
    (TEST_KEY.seed[0] + pair) >>> 0,
    (TEST_KEY.seed[1] + pair) >>> 0,
    (TEST_KEY.seed[2] + pair) >>> 0,
    (TEST_KEY.seed[3] + pair) >>> 0,
  ];
}

function cipherWordsFor(plain: Uint32Array): Uint32Array {
  const cipher = new Uint32Array(plain.length);
  for (let i = 0; i < plain.length; i += 2) {
    const [v0, v1] = encryptPair(plain[i], plain[i + 1], lanesForPair(i / 2));
    cipher[i] = v0;
    cipher[i + 1] = v1;
  }
  return cipher;
}

function makePlainWords(): Uint32Array {
  const words = new Uint32Array(FULLRES_IR_TOTAL_WORDS);
  for (let i = 0; i < words.length; i++) words[i] = Math.imul(i + 1, 2654435761) >>> 0;
  return words;
}

function septetsLE(value: number, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = (value >>> (7 * i)) & 0x7f;
  return out;
}

function xor32(words: Uint32Array, count = words.length): number {
  let xor = 0;
  for (let i = 0; i < count; i++) xor = (xor ^ words[i]) >>> 0;
  return xor;
}

function packChunk(words: Uint32Array, offset: number, count = FULLRES_IR_CHUNK_WORDS): Uint8Array {
  const payload = new Uint8Array(2 + count * 5);
  payload[0] = count & 0x7f;
  payload[1] = (count >> 7) & 0x7f;
  for (let i = 0; i < count; i++) {
    const word = words[offset + i];
    const off = 2 + i * 5;
    payload[off] = word & 0x7f;
    payload[off + 1] = (word >>> 7) & 0x7f;
    payload[off + 2] = (word >>> 14) & 0x7f;
    payload[off + 3] = (word >>> 21) & 0x7f;
    payload[off + 4] = (word >>> 28) & 0x0f;
  }
  return payload;
}

function headerPayload(wordCount: number): Uint8Array {
  // Code-literal high, low, middle septet order.
  return Uint8Array.from([
    (wordCount >> 14) & 0x7f,
    wordCount & 0x7f,
    (wordCount >> 7) & 0x7f,
  ]);
}

interface GroupOptions {
  model?: number;
  wordCount?: number;
  chunkFunc?: number;
  footerFunc?: number;
  footerXor?: number;
  chunkPayloads?: readonly Uint8Array[];
  footerPayload?: Uint8Array;
}

function groupFrames(cipherWords: Uint32Array, options: GroupOptions = {}): Uint8Array[] {
  const model = options.model ?? 0x11;
  const wordCount = options.wordCount ?? FULLRES_IR_TOTAL_WORDS;
  const footerXor = options.footerXor ?? xor32(cipherWords);
  const chunkPayloads = options.chunkPayloads ?? Array.from({ length: FULLRES_IR_CHUNKS }, (_, i) =>
    packChunk(cipherWords, i * FULLRES_IR_CHUNK_WORDS),
  );
  const frames: Uint8Array[] = [
    buildFractalFrame(model, FULLRES_IR_FUNCS.header, headerPayload(wordCount)),
  ];
  for (const payload of chunkPayloads) {
    frames.push(buildFractalFrame(model, options.chunkFunc ?? FULLRES_IR_FUNCS.chunk, payload));
  }
  frames.push(
    buildFractalFrame(
      model,
      options.footerFunc ?? FULLRES_IR_FUNCS.footer,
      options.footerPayload ?? septetsLE(footerXor, FULLRES_IR_FOOTER_PAYLOAD_LEN),
    ),
  );
  return frames;
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

function buildGroup(cipherWords: Uint32Array, options?: GroupOptions): Uint8Array {
  return joinFrames(groupFrames(cipherWords, options));
}

function plainWordsOf(parsed: ParsedFullResIr): Uint32Array {
  const plain = decryptFullResIr(parsed, TEST_KEY);
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const words = new Uint32Array(plain.length / 4);
  for (let i = 0; i < words.length; i++) words[i] = view.getUint32(i * 4, true);
  return words;
}

export function runFullResIrTests(): void {
  // 1 ── container constants
  if (FULLRES_IR_FUNCS.header !== 0x67 || FULLRES_IR_FUNCS.chunk !== 0x68 || FULLRES_IR_FUNCS.footer !== 0x69) {
    fail('func constants');
  }
  if (FULLRES_IR_HEADER_PAYLOAD_LEN !== 3 || FULLRES_IR_CHUNK_PAYLOAD_LEN !== 1282 || FULLRES_IR_FOOTER_PAYLOAD_LEN !== 5) {
    fail('payload length constants');
  }
  if (
    FULLRES_IR_CHUNK_WORDS !== 256 ||
    FULLRES_IR_CHUNKS !== 32 ||
    FULLRES_IR_TOTAL_WORDS !== 8192 ||
    FULLRES_IR_TOTAL_BYTES !== 32768 ||
    FULLRES_IR_FRAMES !== 34 ||
    FULLRES_IR_PAIR_COUNT !== 4096
  ) {
    fail('size constants');
  }

  // 2 ── frame-count math
  if (fullResIrFrameCount(8192) !== 34) fail('frame count 8192');
  if (fullResIrFrameCount(256) !== 3) fail('frame count 256');
  if (fullResIrFrameCount(1) !== 3) fail('frame count 1');
  expectThrow(() => fullResIrFrameCount(0), /out of range/, 'frame count 0');
  expectThrow(() => fullResIrFrameCount(1.5), /out of range/, 'frame count fractional');

  // 3 ── XTEA known answer, pair 0
  const kat = Uint8Array.from([0x2c, 0x8b, 0x66, 0x7e, 0x08, 0x03, 0xfd, 0xf1]);
  const katPlain = decryptXteaPairs(kat, TEST_KEY, { pairCount: 1 });
  const expectedKat = Uint8Array.from([0x67, 0x45, 0x23, 0x01, 0xef, 0xcd, 0xab, 0x89]);
  if (katPlain.some((b, i) => b !== expectedKat[i])) fail('XTEA known answer');

  // 4 ── the key schedule advances per pair (pair 3 vector)
  const multi = new Uint8Array(32);
  multi.set([0x67, 0x5d, 0xea, 0x84, 0x50, 0x82, 0xeb, 0x54], 24);
  const multiPlain = decryptXteaPairs(multi, TEST_KEY, { pairCount: 4 });
  const expectedPair3 = Uint8Array.from([0xef, 0xbe, 0xad, 0xde, 0xbe, 0xba, 0xfe, 0xca]);
  if (multiPlain.subarray(24).some((b, i) => b !== expectedPair3[i])) fail('XTEA per-pair schedule');

  // 5 ── decryptXteaPairs does not mutate its input
  const untouched = kat.slice();
  decryptXteaPairs(kat, TEST_KEY, { pairCount: 1 });
  if (kat.some((b, i) => b !== untouched[i])) fail('decrypt mutated input');

  // 6 ── key validation does not echo key material
  try {
    decryptXteaPairs(kat, { seed: [0x11111111, 0x22222222, 0x33333333] } as unknown as XteaRecordKey, { pairCount: 1 });
    fail('short key accepted');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/four 32-bit lanes/.test(message)) fail(`short key error: ${message}`);
    if (message.includes('11111111')) fail('key material echoed');
  }
  expectThrow(
    () => decryptXteaPairs(kat, { seed: [0x11111111, 0x22222222, 0.5, 0x44444444] } as unknown as XteaRecordKey, { pairCount: 1 }),
    /uint32/,
    'non-integer key lane',
  );

  // 7 ── pair-count and range validation
  expectThrow(() => decryptXteaPairs(kat, TEST_KEY, { pairCount: 2 }), /exceeds/, 'pair range');
  expectThrow(() => decryptXteaPairs(kat, TEST_KEY, { pairCount: -1 }), /out of range/, 'negative pair count');
  expectThrow(() => decryptXteaPairs(kat, TEST_KEY, { pairCount: 1, offset: 4 }), /exceeds/, 'offset range');

  // 8 ── a synthetic FullRes group parses
  const plain = makePlainWords();
  const cipherWords = cipherWordsFor(plain);
  const group = buildGroup(cipherWords);
  const parsed = parseFullResIr(group, 0x11);
  if (parsed.wordCount !== FULLRES_IR_TOTAL_WORDS) fail('parsed word count');
  if (parsed.cipher.length !== FULLRES_IR_TOTAL_BYTES) fail('parsed cipher size');
  if (parsed.words.length !== FULLRES_IR_TOTAL_WORDS) fail('parsed words length');
  if (parsed.footerXor !== xor32(cipherWords)) fail('parsed footer');

  // 9 ── assembled bytes are little-endian words in order
  const view = new DataView(parsed.cipher.buffer, parsed.cipher.byteOffset, parsed.cipher.byteLength);
  if (view.getUint32(0, true) !== cipherWords[0]) fail('cipher word 0');
  if (view.getUint32(4 * 8191, true) !== cipherWords[8191]) fail('cipher last word');

  // 10 ── decryption recovers the plaintext
  const recovered = plainWordsOf(parsed);
  for (let i = 0; i < plain.length; i++) {
    if (recovered[i] !== plain[i]) fail(`decrypted word ${i}`);
  }

  // 11 ── the group is 34 frames: 1 header + 32 chunks + 1 footer
  const frames = splitFractalFrames(group, 'fullres');
  if (frames.length !== FULLRES_IR_FRAMES) fail('frame count');
  if (frames.filter((frame) => frame.func === FULLRES_IR_FUNCS.chunk).length !== FULLRES_IR_CHUNKS) {
    fail('chunk frame count');
  }

  // 12 ── header word count must be the 8,192-word FullRes record
  expectThrow(
    () => parseFullResIr(buildGroup(cipherWords, { wordCount: 4096 })),
    /declares 4096 words/,
    'header word count',
  );

  // 13 ── exactly 34 frames
  expectThrow(
    () => parseFullResIr(joinFrames(groupFrames(cipherWords).slice(0, -1))),
    /33 frames, expected 34/,
    'frame count 33',
  );
  expectThrow(
    () => parseFullResIr(
      joinFrames([
        ...groupFrames(cipherWords).slice(0, -1),
        buildFractalFrame(0x11, FULLRES_IR_FUNCS.chunk, packChunk(cipherWords, 0)),
        buildFractalFrame(0x11, FULLRES_IR_FUNCS.footer, septetsLE(xor32(cipherWords), 5)),
      ]),
    ),
    /35 frames, expected 34/,
    'frame count 35',
  );

  // 14 ── every chunk must declare 256 words
  const wrongCount = new Uint8Array(FULLRES_IR_CHUNK_PAYLOAD_LEN);
  wrongCount[0] = 255 & 0x7f;
  wrongCount[1] = 1;
  expectThrow(
    () => parseFullResIr(buildGroup(cipherWords, { chunkPayloads: [wrongCount, ...groupFrames(cipherWords).slice(2, -1).map((frame) => frame.subarray(6, frame.length - 2))] })),
    /declares 255 words, expected 256/,
    'chunk word count',
  );

  // 15 ── chunk payload must be 1,282 bytes
  expectThrow(
    () => parseFullResIr(
      buildGroup(cipherWords, {
        chunkPayloads: [packChunk(cipherWords, 0).subarray(0, 1281), ...groupFrames(cipherWords).slice(2, -1).map((frame) => frame.subarray(6, frame.length - 2))],
      }),
    ),
    /payload is 1281 bytes/,
    'chunk payload length',
  );

  // 16 ── chunk function byte must be 0x68
  expectThrow(
    () => parseFullResIr(buildGroup(cipherWords, { chunkFunc: 0x69 })),
    /chunk 1 has func 0x69/,
    'chunk func',
  );

  // 17 ── footer function byte must be 0x69
  expectThrow(
    () => parseFullResIr(buildGroup(cipherWords, { footerFunc: 0x68 })),
    /last frame is 0x68/,
    'footer func',
  );

  // 18 ── footer payload must be 5 bytes
  expectThrow(
    () => parseFullResIr(buildGroup(cipherWords, { footerPayload: Uint8Array.from([0, 0, 0, 0]) })),
    /footer payload is 4 bytes/,
    'footer payload length',
  );

  // 19 ── footer XOR must match the assembled words
  expectThrow(
    () => parseFullResIr(buildGroup(cipherWords, { footerXor: xor32(cipherWords) ^ 1 })),
    /footer XOR/,
    'footer XOR',
  );

  // 20 ── the fifth septet of a word carries only 4 bits
  const highWord = new Uint8Array(1282);
  highWord[0] = 0;
  highWord[1] = 2;
  highWord[6] = 0x10; // fifth septet of word 0
  expectThrow(
    () => parseFullResIr(
      buildGroup(cipherWords, {
        chunkPayloads: [highWord, ...groupFrames(cipherWords).slice(2, -1).map((frame) => frame.subarray(6, frame.length - 2))],
      }),
    ),
    /non-zero high septet/,
    'chunk high septet',
  );

  // 21 ── the footer's fifth septet is likewise 4 bits
  expectThrow(
    () => parseFullResIr(buildGroup(cipherWords, { footerPayload: Uint8Array.from([0, 0, 0, 0, 0x10]) })),
    /high septet/,
    'footer high septet',
  );

  // 22 ── checksum, model, truncation and trailing bytes are rejected
  const corrupt = buildGroup(cipherWords);
  corrupt[11 + 6 + 20] ^= 0x01;
  expectThrow(() => parseFullResIr(corrupt), /checksum/i, 'frame checksum');
  expectThrow(
    () => parseFullResIr(
      joinFrames([
        buildFractalFrame(0x11, FULLRES_IR_FUNCS.header, headerPayload(8192)),
        buildFractalFrame(0x12, FULLRES_IR_FUNCS.chunk, packChunk(cipherWords, 0)),
        ...groupFrames(cipherWords).slice(2),
      ]),
    ),
    /model/,
    'model mismatch',
  );
  expectThrow(() => parseFullResIr(group.subarray(0, group.length - 4)), /terminator|insufficient/, 'truncated');
  const trailing = new Uint8Array(group.length + 1);
  trailing.set(group);
  expectThrow(() => parseFullResIr(trailing), /expected F0/, 'trailing');
  expectThrow(() => parseFullResIr(group, 0x12), /does not match expected/, 'expected model');

  // 23 ── receive-only: the module exposes no build/write/encode path
  const writeExports = Object.keys(fullResIrModule).filter((name) => /^(build|write|encode|send)/.test(name));
  if (writeExports.length !== 0) fail(`unexpected write exports: ${writeExports.join(',')}`);
}
