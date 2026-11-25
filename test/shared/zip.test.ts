/**
 * ZIP container tests: stored/deflate read, deterministic stored write, and
 * the strict limits (path traversal, duplicates, size caps, CRC, method).
 *
 * Deflate fixtures are produced in-test with Node's zlib; the archive bytes are
 * synthetic. The reader itself is a hand-written raw inflate.
 */
import { deflateRawSync } from 'node:zlib';
import {
  assertSafeEntryName,
  readZipArchive,
  writeStoredZipArchive,
  zipCrc32,
  type ZipEntry,
} from '../../src/shared/zipArchive.js';

export const ZIP_CASE_COUNT = 22;

function fail(msg: string): never {
  throw new Error(`[shared/zip] ${msg}`);
}

function u16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff];
}

function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

function text(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function readU16(bytes: Uint8Array, off: number): number {
  return bytes[off] | (bytes[off + 1] << 8);
}

function readU32(bytes: Uint8Array, off: number): number {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

/** Build a ZIP with deflate entries (level controls stored vs dynamic blocks). */
function makeDeflateZip(entries: readonly ZipEntry[], level = 9): Uint8Array {
  const out: number[] = [];
  const central: number[] = [];
  for (const entry of entries) {
    const name = Array.from(entry.name, (c) => c.charCodeAt(0));
    const compressed = deflateRawSync(entry.data, { level });
    const crc = zipCrc32(entry.data);
    const offset = out.length;
    out.push(
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(compressed.length), ...u32(entry.data.length),
      ...u16(name.length), ...u16(0), ...name, ...compressed,
    );
    central.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(compressed.length), ...u32(entry.data.length),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name,
    );
  }
  const cdOffset = out.length;
  out.push(...central);
  out.push(
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(out.length - cdOffset), ...u32(cdOffset), ...u16(0),
  );
  return Uint8Array.from(out);
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

function patch16(bytes: Uint8Array, off: number, value: number): void {
  bytes[off] = value & 0xff;
  bytes[off + 1] = (value >>> 8) & 0xff;
}

function patch32(bytes: Uint8Array, off: number, value: number): void {
  bytes[off] = value & 0xff;
  bytes[off + 1] = (value >>> 8) & 0xff;
  bytes[off + 2] = (value >>> 16) & 0xff;
  bytes[off + 3] = (value >>> 24) & 0xff;
}

function eocdOffset(bytes: Uint8Array): number {
  return bytes.length - 22;
}

function firstCentral(bytes: Uint8Array): number {
  return readU32(bytes, eocdOffset(bytes) + 16);
}

export function runZipTests(): void {
  // 1 ── CRC-32 known vector
  if (zipCrc32(text('123456789')) !== 0xcbf43926) fail('CRC-32("123456789") mismatch');

  // 2 ── stored round-trip preserves names, order and bytes
  const stored = writeStoredZipArchive([
    { name: '.bundle', data: text('<map/>') },
    { name: 'dir/cab-0', data: Uint8Array.from([0, 1, 2, 250, 255]) },
  ]);
  const readStored = readZipArchive(stored);
  if ([...readStored.keys()].join('|') !== '.bundle|dir/cab-0') fail('stored entry order changed');
  if (readStored.get('.bundle')?.length !== 6) fail('stored entry length wrong');
  const cabBytes = readStored.get('dir/cab-0');
  if (cabBytes === undefined || cabBytes[3] !== 250 || cabBytes[4] !== 255) fail('stored bytes changed');

  // 3 ── stored writer is deterministic
  const again = writeStoredZipArchive([
    { name: '.bundle', data: text('<map/>') },
    { name: 'dir/cab-0', data: Uint8Array.from([0, 1, 2, 250, 255]) },
  ]);
  if (again.length !== stored.length || again.some((b, i) => b !== stored[i])) fail('writer is not deterministic');

  // 4 ── empty archive is valid
  const empty = readZipArchive(writeStoredZipArchive([]));
  if (empty.size !== 0) fail('empty archive produced entries');

  // 5 ── deflate level 9 (dynamic Huffman)
  const dynamic = makeDeflateZip([
    { name: 'text.txt', data: text('the quick brown fox '.repeat(200)) },
    { name: 'bin.dat', data: Uint8Array.from({ length: 5000 }, (_, i) => (i * 37) & 0xff) },
  ]);
  const readDynamic = readZipArchive(dynamic);
  if (readDynamic.get('text.txt')?.length !== 4000) fail('deflate text length wrong');
  if (readDynamic.get('bin.dat')?.[4999] !== ((4999 * 37) & 0xff)) fail('deflate bytes wrong');

  // 6 ── deflate level 0 (stored blocks inside method 8)
  const storedBlocks = makeDeflateZip([{ name: 'zero', data: text('stored-block payload '.repeat(50)) }], 0);
  if (readZipArchive(storedBlocks).get('zero')?.length !== 1050) fail('stored-block deflate failed');

  // 7 ── empty entry round-trips
  const emptyEntry = readZipArchive(makeDeflateZip([{ name: 'empty', data: new Uint8Array(0) }]));
  if (emptyEntry.get('empty')?.length !== 0) fail('empty deflate entry failed');

  // 8 ── path traversal names are rejected on write
  for (const name of ['../x', '/abs', 'a\\b', 'C:x', 'a/../b', 'a/./b', 'a//b', 'a.']) {
    expectThrow(() => assertSafeEntryName(name, 255, 'test'), /name|path|absolute|backslash|colon|segment/, `name ${JSON.stringify(name)}`);
  }

  // 9 ── duplicate names (case-insensitive) are rejected on write and read
  expectThrow(
    () => writeStoredZipArchive([{ name: 'Cab', data: text('a') }, { name: 'cab', data: text('b') }]),
    /duplicate/,
    'duplicate write',
  );
  expectThrow(
    () => readZipArchive(makeDeflateZip([{ name: 'Cab', data: text('a') }, { name: 'cab', data: text('b') }])),
    /duplicate/,
    'duplicate read',
  );

  // 10 ── entry-count limit (write + read)
  expectThrow(
    () => writeStoredZipArchive([{ name: 'a', data: text('a') }, { name: 'b', data: text('b') }], { maxEntries: 1 }),
    /entries/,
    'write maxEntries',
  );
  expectThrow(
    () => readZipArchive(makeDeflateZip([{ name: 'a', data: text('a') }, { name: 'b', data: text('b') }]), { maxEntries: 1 }),
    /entries/,
    'read maxEntries',
  );

  // 11 ── name-length limit
  expectThrow(
    () => writeStoredZipArchive([{ name: 'abcdef', data: text('a') }], { maxNameLength: 3 }),
    /maximum 3/,
    'write maxNameLength',
  );
  expectThrow(
    () => readZipArchive(makeDeflateZip([{ name: 'abcdef', data: text('a') }]), { maxNameLength: 3 }),
    /maximum 3/,
    'read maxNameLength',
  );

  // 12 ── per-entry uncompressed limit
  expectThrow(
    () => readZipArchive(makeDeflateZip([{ name: 'big', data: new Uint8Array(1000) }]), { maxEntryBytes: 999 }),
    /uncompressed/,
    'maxEntryBytes',
  );

  // 13 ── total uncompressed limit
  expectThrow(
    () => readZipArchive(
      makeDeflateZip([{ name: 'a', data: new Uint8Array(600) }, { name: 'b', data: new Uint8Array(600) }]),
      { maxTotalBytes: 1000 },
    ),
    /total uncompressed/,
    'maxTotalBytes',
  );

  // 14 ── stored data corruption is caught by CRC-32
  const corrupt = writeStoredZipArchive([{ name: 'a', data: text('hello') }]);
  const dataStart = 30 + 1; // local header (30) + one-byte name
  corrupt[dataStart] ^= 0x01;
  expectThrow(() => readZipArchive(corrupt), /CRC-32/, 'CRC mismatch');

  // 15 ── encrypted entries are rejected
  const encrypted = writeStoredZipArchive([{ name: 'a', data: text('x') }]);
  const central = firstCentral(encrypted);
  const local = readU32(encrypted, central + 42);
  patch16(encrypted, central + 8, 0x0001);
  patch16(encrypted, local + 6, 0x0001);
  expectThrow(() => readZipArchive(encrypted), /encrypted/, 'encrypted flag');

  // 16 ── unsupported compression method
  const unsupported = writeStoredZipArchive([{ name: 'a', data: text('x') }]);
  const uc = firstCentral(unsupported);
  const ul = readU32(unsupported, uc + 42);
  patch16(unsupported, uc + 10, 12);
  patch16(unsupported, ul + 8, 12);
  expectThrow(() => readZipArchive(unsupported), /method 12/, 'unsupported method');

  // 17 ── ZIP64 markers are rejected
  const zip64 = writeStoredZipArchive([{ name: 'a', data: text('x') }]);
  patch16(zip64, eocdOffset(zip64) + 8, 0xffff);
  patch16(zip64, eocdOffset(zip64) + 10, 0xffff);
  expectThrow(() => readZipArchive(zip64), /ZIP64/, 'ZIP64 EOCD');

  // 18 ── truncated archive / missing EOCD
  expectThrow(() => readZipArchive(stored.subarray(0, stored.length - 1)), /end-of-central-directory/, 'truncated');
  expectThrow(() => readZipArchive(new Uint8Array(10)), /shorter than/, 'tiny input');

  // 19 ── local/central name mismatch
  const mismatch = writeStoredZipArchive([{ name: 'abc', data: text('x') }]);
  mismatch[30] = 'z'.charCodeAt(0);
  expectThrow(() => readZipArchive(mismatch), /local name/, 'name mismatch');

  // 20 ── non-ASCII entry name is rejected
  const nonAscii = makeDeflateZip([{ name: 'ok', data: text('x') }]);
  const nc = firstCentral(nonAscii);
  const nameStart = nc + 46;
  nonAscii[nameStart] = 0xc3;
  expectThrow(() => readZipArchive(nonAscii), /ASCII/, 'non-ASCII name');

  // 21 ── bad local header signature
  const badLocal = writeStoredZipArchive([{ name: 'a', data: text('x') }]);
  patch32(badLocal, 0, 0xdeadbeef);
  expectThrow(() => readZipArchive(badLocal), /local header signature/, 'bad local signature');

  // 22 ── central directory must end at the EOCD
  const shifted = writeStoredZipArchive([{ name: 'a', data: text('x') }]);
  patch32(shifted, eocdOffset(shifted) + 12, readU32(shifted, eocdOffset(shifted) + 12) + 1);
  expectThrow(() => readZipArchive(shifted), /central directory/, 'central size');
}
