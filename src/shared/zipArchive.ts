/**
 * Minimal, strict PKZIP reader/writer for the offline file containers.
 *
 * The `.fasBundle` format is a plain ZIP whose entries are looked up by name
 * (`.bundle` is the XML manifest; the others are payloads). This module
 * implements exactly what that needs:
 *
 *   - read: one-disk, non-ZIP64 archives, methods `store` (0) and `deflate` (8),
 *     with a hand-written raw-inflate (no zlib, no Node built-ins);
 *   - write: deterministic `store` entries. A stored ZIP is a valid archive and
 *     every reader that accepts method 0 — including the editor that defines
 *     the format — accepts it. Writing deflate would need a compressor and is
 *     deliberately not included.
 *
 * All parsing is bounded and strict: declared sizes are capped, CRC-32 is
 * verified, names must be safe flat/relative names without `..`, backslashes,
 * drive colons or absolute roots, and duplicate names (case-insensitively) are
 * rejected. A malformed archive fails before any caller sees an entry.
 *
 * Pure code: `Uint8Array`/`DataView` only, so it stays browser-safe.
 */

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

export interface ZipLimits {
  /** Maximum number of entries in the archive. */
  maxEntries: number;
  /** Maximum entry-name length in bytes. */
  maxNameLength: number;
  /** Maximum uncompressed size of a single entry. */
  maxEntryBytes: number;
  /** Maximum sum of all uncompressed entry sizes. */
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 1024,
  maxNameLength: 255,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function u16(bytes: Uint8Array, off: number, what: string): number {
  if (off < 0 || off + 2 > bytes.length) throw new Error(`${what}: truncated 16-bit field at ${off}`);
  return bytes[off] | (bytes[off + 1] << 8);
}

function u32(bytes: Uint8Array, off: number, what: string): number {
  if (off < 0 || off + 4 > bytes.length) throw new Error(`${what}: truncated 32-bit field at ${off}`);
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

function hex(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

/** CRC-32 (IEEE 802.3, reflected) as used by ZIP. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function zipCrc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Validate one archive entry name: ASCII printable, no backslash or drive
 * colon, no absolute root, no `.`/`..` path segment, no empty segment, no
 * trailing dot/space in a segment. `what` prefixes the error.
 */
export function assertSafeEntryName(
  name: string,
  maxLength: number,
  what = 'zip entry',
): void {
  if (name.length === 0) throw new Error(`${what}: empty name`);
  if (name.length > maxLength) {
    throw new Error(`${what}: name is ${name.length} characters (maximum ${maxLength})`);
  }
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      throw new Error(`${what}: name contains a non-printable or non-ASCII character at ${i}`);
    }
    if (c === 0x5c) throw new Error(`${what}: name contains a backslash: ${JSON.stringify(name)}`);
    if (c === 0x3a) throw new Error(`${what}: name contains a drive/stream colon: ${JSON.stringify(name)}`);
  }
  if (name.startsWith('/')) throw new Error(`${what}: absolute name: ${JSON.stringify(name)}`);
  if (name.endsWith('/')) throw new Error(`${what}: directory-style name: ${JSON.stringify(name)}`);
  const segments = name.split('/');
  for (const segment of segments) {
    if (segment.length === 0) throw new Error(`${what}: empty path segment in ${JSON.stringify(name)}`);
    if (segment === '.' || segment === '..') {
      throw new Error(`${what}: path traversal segment in ${JSON.stringify(name)}`);
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      throw new Error(`${what}: segment ends with a dot or space in ${JSON.stringify(name)}`);
    }
  }
}

function decodeEntryName(bytes: Uint8Array): string {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x20 || b > 0x7e) {
      throw new Error(`zip entry: name is not printable ASCII at byte ${i}`);
    }
  }
  return String.fromCharCode(...bytes);
}

// ── Raw DEFLATE (RFC 1951) ─────────────────────────────────────────

class BitReader {
  private pos = 0;
  private bit = 0;
  constructor(private readonly data: Uint8Array, private readonly what: string) {}

  readBit(): number {
    const b = this.data[this.pos];
    if (b === undefined) throw new Error(`${this.what}: compressed data exhausted`);
    const out = (b >> this.bit) & 1;
    this.bit += 1;
    if (this.bit === 8) {
      this.bit = 0;
      this.pos += 1;
    }
    return out;
  }

  readBits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v |= this.readBit() << i;
    return v >>> 0;
  }

  alignToByte(): void {
    if (this.bit !== 0) {
      this.bit = 0;
      this.pos += 1;
    }
  }

  readAligned(n: number): Uint8Array {
    this.alignToByte();
    if (this.pos + n > this.data.length) throw new Error(`${this.what}: stored block truncated`);
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

interface HuffmanTree {
  readonly counts: Uint16Array;
  readonly symbols: Uint16Array;
}

function buildHuffman(lengths: Uint8Array, what: string): HuffmanTree {
  const counts = new Uint16Array(16);
  for (const len of lengths) {
    if (len > 15) throw new Error(`${what}: Huffman code length ${len} exceeds 15`);
    counts[len] += 1;
  }
  counts[0] = 0;
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left = (left << 1) - counts[len];
    if (left < 0) throw new Error(`${what}: over-subscribed Huffman code`);
  }
  const offsets = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offsets[len + 1] = offsets[len] + counts[len];
  const symbols = new Uint16Array(lengths.length);
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym];
    if (len !== 0) symbols[offsets[len]++] = sym;
  }
  return { counts, symbols };
}

function decodeSymbol(r: BitReader, tree: HuffmanTree, what: string): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= 15; len++) {
    code |= r.readBit();
    const count = tree.counts[len];
    if (code - first < count) return tree.symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error(`${what}: invalid Huffman code`);
}

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const FIXED_LITERAL_LENGTHS = (() => {
  const lengths = new Uint8Array(288);
  for (let i = 0; i < 144; i++) lengths[i] = 8;
  for (let i = 144; i < 256; i++) lengths[i] = 9;
  for (let i = 256; i < 280; i++) lengths[i] = 7;
  for (let i = 280; i < 288; i++) lengths[i] = 8;
  return lengths;
})();
const FIXED_DISTANCE_LENGTHS = new Uint8Array(32).fill(5);

/**
 * Decompress a raw DEFLATE stream to exactly `outputSize` bytes. The output
 * buffer is pre-sized and never grows, so the declared (and capped) size is a
 * hard bound on memory.
 */
function inflateRaw(data: Uint8Array, outputSize: number, what: string): Uint8Array {
  const out = new Uint8Array(outputSize);
  let outPos = 0;
  const r = new BitReader(data, what);

  const emit = (byte: number): void => {
    if (outPos >= out.length) throw new Error(`${what}: output exceeds declared size ${outputSize}`);
    out[outPos++] = byte;
  };

  for (;;) {
    const final = r.readBit();
    const type = r.readBits(2);
    if (type === 0) {
      const len = r.readAligned(2);
      const nlen = r.readAligned(2);
      const n = len[0] | (len[1] << 8);
      const nn = nlen[0] | (nlen[1] << 8);
      if ((n ^ 0xffff) !== nn) throw new Error(`${what}: stored-block length check failed`);
      const copy = r.readAligned(n);
      for (let i = 0; i < copy.length; i++) emit(copy[i]);
    } else if (type === 1 || type === 2) {
      let litTree: HuffmanTree;
      let distTree: HuffmanTree;
      if (type === 1) {
        litTree = buildHuffman(FIXED_LITERAL_LENGTHS, `${what} fixed literal tree`);
        distTree = buildHuffman(FIXED_DISTANCE_LENGTHS, `${what} fixed distance tree`);
      } else {
        const hlit = r.readBits(5) + 257;
        const hdist = r.readBits(5) + 1;
        const hclen = r.readBits(4) + 4;
        if (hlit > 286) throw new Error(`${what}: too many literal/length codes (${hlit})`);
        if (hdist > 32) throw new Error(`${what}: too many distance codes (${hdist})`);
        const clLengths = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clLengths[CODE_LENGTH_ORDER[i]] = r.readBits(3);
        const clTree = buildHuffman(clLengths, `${what} code-length tree`);
        const lengths = new Uint8Array(hlit + hdist);
        let n = 0;
        while (n < lengths.length) {
          const sym = decodeSymbol(r, clTree, `${what} code-length tree`);
          if (sym <= 15) {
            lengths[n++] = sym;
          } else if (sym === 16) {
            if (n === 0) throw new Error(`${what}: repeat code without a previous length`);
            const repeat = r.readBits(2) + 3;
            if (n + repeat > lengths.length) throw new Error(`${what}: code-length repeat overruns`);
            lengths.fill(lengths[n - 1], n, n + repeat);
            n += repeat;
          } else if (sym === 17) {
            const repeat = r.readBits(3) + 3;
            if (n + repeat > lengths.length) throw new Error(`${what}: code-length repeat overruns`);
            n += repeat;
          } else if (sym === 18) {
            const repeat = r.readBits(7) + 11;
            if (n + repeat > lengths.length) throw new Error(`${what}: code-length repeat overruns`);
            n += repeat;
          } else {
            throw new Error(`${what}: invalid code-length symbol ${sym}`);
          }
        }
        litTree = buildHuffman(lengths.subarray(0, hlit), `${what} literal tree`);
        distTree = buildHuffman(lengths.subarray(hlit), `${what} distance tree`);
      }

      for (;;) {
        const sym = decodeSymbol(r, litTree, `${what} literal tree`);
        if (sym < 256) {
          emit(sym);
        } else if (sym === 256) {
          break;
        } else {
          const lenIdx = sym - 257;
          if (lenIdx >= LENGTH_BASE.length) throw new Error(`${what}: invalid length symbol ${sym}`);
          const length = LENGTH_BASE[lenIdx] + r.readBits(LENGTH_EXTRA[lenIdx]);
          const distSym = decodeSymbol(r, distTree, `${what} distance tree`);
          if (distSym >= DIST_BASE.length) throw new Error(`${what}: invalid distance symbol ${distSym}`);
          const distance = DIST_BASE[distSym] + r.readBits(DIST_EXTRA[distSym]);
          if (distance > outPos) throw new Error(`${what}: distance ${distance} exceeds output position ${outPos}`);
          for (let i = 0; i < length; i++) emit(out[outPos - distance]);
        }
      }
    } else {
      throw new Error(`${what}: reserved DEFLATE block type 3`);
    }
    if (final === 1) break;
  }

  if (outPos !== out.length) {
    throw new Error(`${what}: inflated ${outPos} bytes, expected ${out.length}`);
  }
  return out;
}

// ── Reader ─────────────────────────────────────────────────────────

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  if (bytes.length < 22) throw new Error('zip: file is shorter than an end-of-central-directory record');
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (u32(bytes, i, 'zip') !== EOCD_SIG) continue;
    const commentLength = u16(bytes, i + 20, 'zip');
    if (i + 22 + commentLength === bytes.length) return i;
  }
  throw new Error('zip: end-of-central-directory record not found');
}

function resolveLimits(limits?: Partial<ZipLimits>): ZipLimits {
  return { ...DEFAULT_ZIP_LIMITS, ...limits };
}

function checkName(name: string, limits: ZipLimits, what: string): void {
  assertSafeEntryName(name, limits.maxNameLength, what);
}

/**
 * Parse a ZIP archive into an ordered name → bytes map. Throws on any
 * structural, checksum or limit violation; never returns a partial archive.
 */
export function readZipArchive(
  bytes: Uint8Array,
  limits?: Partial<ZipLimits>,
): Map<string, Uint8Array> {
  const lim = resolveLimits(limits);
  const eocd = findEndOfCentralDirectory(bytes);
  const disk = u16(bytes, eocd + 4, 'zip EOCD');
  const cdDisk = u16(bytes, eocd + 6, 'zip EOCD');
  const entriesThisDisk = u16(bytes, eocd + 8, 'zip EOCD');
  const totalEntries = u16(bytes, eocd + 10, 'zip EOCD');
  const cdSize = u32(bytes, eocd + 12, 'zip EOCD');
  const cdOffset = u32(bytes, eocd + 16, 'zip EOCD');
  if (disk !== 0 || cdDisk !== 0 || entriesThisDisk !== totalEntries) {
    throw new Error('zip: multi-disk archives are not supported');
  }
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('zip: ZIP64 archives are not supported');
  }
  if (totalEntries > lim.maxEntries) {
    throw new Error(`zip: ${totalEntries} entries (maximum ${lim.maxEntries})`);
  }
  if (cdOffset + cdSize !== eocd) {
    throw new Error(`zip: central directory at ${cdOffset}+${cdSize} does not end at EOCD ${eocd}`);
  }
  if (cdSize < totalEntries * 46) throw new Error('zip: central directory is too small for its entry count');

  const archive = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  let cursor = cdOffset;
  let totalBytes = 0;

  for (let index = 0; index < totalEntries; index++) {
    const what = `zip entry ${index + 1}`;
    if (cursor + 46 > cdOffset + cdSize) throw new Error(`${what}: central header truncated`);
    if (u32(bytes, cursor, what) !== CENTRAL_SIG) {
      throw new Error(`${what}: bad central header signature ${hex(u32(bytes, cursor, what))}`);
    }
    const flags = u16(bytes, cursor + 8, what);
    const method = u16(bytes, cursor + 10, what);
    const crc = u32(bytes, cursor + 16, what);
    const compressedSize = u32(bytes, cursor + 20, what);
    const uncompressedSize = u32(bytes, cursor + 24, what);
    const nameLength = u16(bytes, cursor + 28, what);
    const extraLength = u16(bytes, cursor + 30, what);
    const commentLength = u16(bytes, cursor + 32, what);
    const diskStart = u16(bytes, cursor + 34, what);
    const localOffset = u32(bytes, cursor + 42, what);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    const recordEnd = nameEnd + extraLength + commentLength;
    if (recordEnd > cdOffset + cdSize) throw new Error(`${what}: central header overruns the central directory`);
    if (nameLength === 0) throw new Error(`${what}: empty central name`);
    if (nameLength > lim.maxNameLength) {
      throw new Error(`${what}: name is ${nameLength} bytes (maximum ${lim.maxNameLength})`);
    }
    if (diskStart !== 0) throw new Error(`${what}: multi-disk entry`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`${what}: ZIP64 entry fields are not supported`);
    }
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || (flags & 0x2000) !== 0) {
      throw new Error(`${what}: encrypted entries are not supported`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`${what}: compression method ${method} is not supported (store/deflate only)`);
    }
    const name = decodeEntryName(bytes.subarray(nameStart, nameEnd));
    checkName(name, lim, what);
    if (seen.has(name.toLowerCase())) throw new Error(`${what}: duplicate entry name ${JSON.stringify(name)}`);
    seen.add(name.toLowerCase());

    if (uncompressedSize > lim.maxEntryBytes) {
      throw new Error(`${what}: ${uncompressedSize} bytes uncompressed (maximum ${lim.maxEntryBytes})`);
    }
    totalBytes += uncompressedSize;
    if (totalBytes > lim.maxTotalBytes) {
      throw new Error(`zip: total uncompressed size exceeds ${lim.maxTotalBytes} bytes`);
    }
    if (method === 0 && compressedSize !== uncompressedSize) {
      throw new Error(`${what}: stored entry has compressed size ${compressedSize} != ${uncompressedSize}`);
    }
    if (localOffset + 30 > cdOffset) throw new Error(`${what}: local header at ${localOffset} is outside the data area`);
    if (u32(bytes, localOffset, what) !== LOCAL_SIG) {
      throw new Error(`${what}: bad local header signature ${hex(u32(bytes, localOffset, what))}`);
    }
    const localFlags = u16(bytes, localOffset + 6, what);
    const localMethod = u16(bytes, localOffset + 8, what);
    const localCrc = u32(bytes, localOffset + 14, what);
    const localCompressed = u32(bytes, localOffset + 18, what);
    const localUncompressed = u32(bytes, localOffset + 22, what);
    const localNameLength = u16(bytes, localOffset + 26, what);
    const localExtraLength = u16(bytes, localOffset + 28, what);
    if (localMethod !== method) throw new Error(`${what}: local/central compression method mismatch`);
    if (localFlags !== flags) throw new Error(`${what}: local/central flags mismatch`);
    if (localNameLength > lim.maxNameLength) {
      throw new Error(`${what}: local name is ${localNameLength} bytes (maximum ${lim.maxNameLength})`);
    }
    if (localOffset + 30 + localNameLength + localExtraLength > cdOffset) {
      throw new Error(`${what}: local header overruns the data area`);
    }
    const localName = decodeEntryName(
      bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    );
    if (localName !== name) {
      throw new Error(`${what}: local name ${JSON.stringify(localName)} != central name ${JSON.stringify(name)}`);
    }
    const hasDescriptor = (flags & 0x0008) !== 0;
    if (!hasDescriptor) {
      if (localCrc !== crc || localCompressed !== compressedSize || localUncompressed !== uncompressedSize) {
        throw new Error(`${what}: local/central size or CRC mismatch`);
      }
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > cdOffset) {
      throw new Error(`${what}: compressed data overruns the data area`);
    }
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let data: Uint8Array;
    if (method === 0) {
      data = compressed.slice();
    } else {
      data = inflateRaw(compressed, uncompressedSize, `${what} (${name})`);
    }
    if (data.length !== uncompressedSize) {
      throw new Error(`${what}: produced ${data.length} bytes, expected ${uncompressedSize}`);
    }
    const actualCrc = zipCrc32(data);
    if (actualCrc !== crc) {
      throw new Error(`${what}: CRC-32 mismatch (stored ${hex(crc)}, computed ${hex(actualCrc)})`);
    }
    archive.set(name, data);
    cursor = recordEnd;
  }

  if (cursor !== cdOffset + cdSize) {
    throw new Error('zip: central directory has trailing bytes');
  }
  return archive;
}

// ── Writer ─────────────────────────────────────────────────────────

function writeU16(out: number[], value: number): void {
  out.push(value & 0xff, (value >>> 8) & 0xff);
}

function writeU32(out: number[], value: number): void {
  out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

/**
 * Build a deterministic ZIP with stored entries (method 0). Entry order is
 * preserved. Timestamps are fixed at 1980-01-01 00:00 so identical inputs
 * produce identical bytes.
 */
export function writeStoredZipArchive(
  entries: readonly ZipEntry[],
  limits?: Partial<ZipLimits>,
): Uint8Array {
  const lim = resolveLimits(limits);
  if (entries.length > lim.maxEntries) {
    throw new Error(`zip: ${entries.length} entries (maximum ${lim.maxEntries})`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const entry of entries) {
    checkName(entry.name, lim, 'zip entry');
    if (seen.has(entry.name.toLowerCase())) {
      throw new Error(`zip: duplicate entry name ${JSON.stringify(entry.name)}`);
    }
    seen.add(entry.name.toLowerCase());
    if (entry.data.length > lim.maxEntryBytes) {
      throw new Error(`zip entry ${JSON.stringify(entry.name)}: ${entry.data.length} bytes (maximum ${lim.maxEntryBytes})`);
    }
    totalBytes += entry.data.length;
    if (totalBytes > lim.maxTotalBytes) {
      throw new Error(`zip: total uncompressed size exceeds ${lim.maxTotalBytes} bytes`);
    }
    if (entry.data.length > 0xffffffff) throw new Error('zip: entry too large');
  }

  const out: number[] = [];
  const central: number[] = [];
  for (const entry of entries) {
    const nameBytes = Array.from(entry.name, (c) => c.charCodeAt(0));
    const crc = zipCrc32(entry.data);
    const localOffset = out.length;
    writeU32(out, LOCAL_SIG);
    writeU16(out, 20); // version needed
    writeU16(out, 0); // flags
    writeU16(out, 0); // method: store
    writeU16(out, 0); // DOS time 00:00
    writeU16(out, 0x21); // DOS date 1980-01-01
    writeU32(out, crc);
    writeU32(out, entry.data.length);
    writeU32(out, entry.data.length);
    writeU16(out, nameBytes.length);
    writeU16(out, 0); // extra length
    out.push(...nameBytes);
    for (const b of entry.data) out.push(b);

    writeU32(central, CENTRAL_SIG);
    writeU16(central, 20); // version made by
    writeU16(central, 20); // version needed
    writeU16(central, 0); // flags
    writeU16(central, 0); // method
    writeU16(central, 0); // DOS time
    writeU16(central, 0x21); // DOS date
    writeU32(central, crc);
    writeU32(central, entry.data.length);
    writeU32(central, entry.data.length);
    writeU16(central, nameBytes.length);
    writeU16(central, 0); // extra
    writeU16(central, 0); // comment
    writeU16(central, 0); // disk start
    writeU16(central, 0); // internal attributes
    writeU32(central, 0); // external attributes
    writeU32(central, localOffset);
    central.push(...nameBytes);
  }

  const cdOffset = out.length;
  out.push(...central);
  const cdSize = out.length - cdOffset;
  writeU32(out, EOCD_SIG);
  writeU16(out, 0); // disk
  writeU16(out, 0); // central directory disk
  writeU16(out, entries.length);
  writeU16(out, entries.length);
  writeU32(out, cdSize);
  writeU32(out, cdOffset);
  writeU16(out, 0); // comment length
  return Uint8Array.from(out);
}
