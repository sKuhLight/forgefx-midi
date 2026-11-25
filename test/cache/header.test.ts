/**
 * Cache header reader (`readCacheHeader`) and its validation helpers.
 *
 * 1. Synthetic header: major @0, minor @4, section count @0x2a; no build date when zero.
 * 2. Build-date variant: NUL-terminated ASCII at 0x0a, a field filled up to 0x2a, and
 *    non-text bytes there (→ null).
 * 3. Tolerant of unknown header bytes: the three fields read the same whatever the rest holds.
 * 4. Strict on size: shorter than 0x2e bytes throws `CacheHeaderError`; exactly 0x2e reads.
 * 5. File-name helpers: `parseCacheFileName` and `headerMatchesFileName` (a renamed file fails).
 * 6. `headerMatchesWalk`: section count and first-section offset must agree with the walk.
 * 7. `cacheHeaderVersion` spells the version like `formatFirmwareVersion`.
 * 8. Committed FM3 / AM4 walks re-encoded behind a synthetic header: header and walk agree.
 *
 * Synthetic data and committed walk fixtures only.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCacheRecords,
  readCacheHeader,
  cacheHeaderVersion,
  parseCacheFileName,
  headerMatchesFileName,
  headerMatchesWalk,
  CacheHeaderError,
  CACHE_HEADER_BYTES,
} from '../../src/cache/index.js';
import type { CacheWalk } from '../../src/cache/index.js';
import { formatFirmwareVersion } from '../../src/shared/firmware.js';
import { encodeWalk, header, pushEnum, pushFloat, pushSection } from './cacheBytes.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const CACHE_HEADER_CASE_COUNT = 8;

const fail = (msg: string): never => {
  throw new Error(`[cache/header] ${msg}`);
};

/** A small valid cache behind the given header bytes (two sections). */
function smallCache(head: number[]): Uint8Array {
  const a = [...head];
  pushSection(a, 1, 2);
  pushFloat(a, 0);
  pushEnum(a, 1, ['ON', 'OFF']);
  pushSection(a, 11, 1);
  pushFloat(a, 3);
  return new Uint8Array(a);
}

export function runCacheHeader(): void {
  // ---- Case 1: plain synthetic header --------------------------------------
  {
    const h = readCacheHeader(new Uint8Array(header({ major: 13, minor: 0, sectionCount: 45 })));
    if (h.major !== 13 || h.minor !== 0 || h.sectionCount !== 45 || h.buildDate !== null) fail(`plain header ${JSON.stringify(h)}`);
    const big = readCacheHeader(new Uint8Array(header({ major: 28, minor: 247, sectionCount: 0x01020304 })));
    if (big.major !== 28 || big.minor !== 247 || big.sectionCount !== 0x01020304) fail(`u32 fields ${JSON.stringify(big)}`);
  }
  console.log('  cache/header: major @0, minor @4, section count @0x2a; no build date when the field is zero');

  // ---- Case 2: build date ---------------------------------------------------
  {
    const date = 'Jan 02 2025 03:04:05';
    const h = readCacheHeader(new Uint8Array(header({ major: 76, sectionCount: 49, buildDate: date })));
    if (h.buildDate !== date || h.major !== 76 || h.sectionCount !== 49) fail(`build-date header ${JSON.stringify(h)}`);
    const full = 'X'.repeat(0x2a - 0x0a); // fills the field, no NUL
    const hf = readCacheHeader(new Uint8Array(header({ buildDate: full, sectionCount: 7 })));
    if (hf.buildDate !== full || hf.sectionCount !== 7) fail(`full build-date field ${JSON.stringify(hf)}`);
    // bytes after the NUL are ignored
    const after = readCacheHeader(new Uint8Array(header({ buildDate: 'AB', bytes: [[0x0d, 0x43]] })));
    if (after.buildDate !== 'AB') fail(`bytes after the NUL: ${after.buildDate}`);
    // non-text bytes in the field → null
    const bin = readCacheHeader(new Uint8Array(header({ bytes: [[0x0a, 0x41], [0x0b, 0x07]] })));
    if (bin.buildDate !== null) fail(`control byte in the build date: ${JSON.stringify(bin.buildDate)}`);
    const hi = readCacheHeader(new Uint8Array(header({ bytes: [[0x0a, 0xc3], [0x0b, 0xa4]] })));
    if (hi.buildDate !== null) fail(`non-ASCII build date: ${JSON.stringify(hi.buildDate)}`);
  }
  console.log('  cache/header: ASCII build date at 0x0a (NUL-terminated, or up to 0x2a); non-text → null');

  // ---- Case 3: tolerant of unknown header bytes ----------------------------
  {
    const noise: Array<[number, number]> = [];
    for (let i = 8; i < 0x2a; i++) noise.push([i, (i * 37 + 11) & 0xff]);
    const h = readCacheHeader(new Uint8Array(header({ major: 32, minor: 6, sectionCount: 57, bytes: noise })));
    if (h.major !== 32 || h.minor !== 6 || h.sectionCount !== 57) fail(`noisy header ${JSON.stringify(h)}`);
    // the walk does not read the header at all: a noisy header still parses as a cache
    const cache = smallCache(header({ sectionCount: 2, bytes: noise }));
    const w = parseCacheRecords(cache);
    if (!headerMatchesWalk(readCacheHeader(cache), w)) fail('noisy header no longer matches its walk');
  }
  console.log('  cache/header: unknown header bytes are ignored');

  // ---- Case 4: strict on size -----------------------------------------------
  {
    for (const n of [0, 1, 8, CACHE_HEADER_BYTES - 1]) {
      let threw: unknown = null;
      try {
        readCacheHeader(new Uint8Array(n));
      } catch (e) {
        threw = e;
      }
      if (!(threw instanceof CacheHeaderError) || threw.reason !== 'SHORT-HEADER') fail(`${n}-byte buffer: expected CacheHeaderError`);
    }
    const exact = readCacheHeader(new Uint8Array(header({ major: 1, minor: 2, sectionCount: 3 })));
    if (CACHE_HEADER_BYTES !== 0x2e || exact.major !== 1 || exact.minor !== 2 || exact.sectionCount !== 3) fail('exact-size header');
    // a view into a larger buffer reads at its own offset
    const backing = new Uint8Array(100);
    backing.set(header({ major: 9, minor: 4, sectionCount: 5 }), 10);
    const view = readCacheHeader(backing.subarray(10));
    if (view.major !== 9 || view.minor !== 4 || view.sectionCount !== 5) fail(`subarray header ${JSON.stringify(view)}`);
  }
  console.log('  cache/header: a buffer shorter than 0x2e bytes throws; exactly 0x2e and subarray views read');

  // ---- Case 5: file-name helpers -------------------------------------------
  {
    const f = parseCacheFileName('effectDefinitions_11_13p0.cache');
    if (!f || f.model !== 0x11 || f.major !== 13 || f.minor !== 0) fail(`parse FM3 name ${JSON.stringify(f)}`);
    const p = parseCacheFileName('C:\\Users\\x\\AppData\\Roaming\\Editor\\effectDefinitions_11_28p247.cache');
    if (!p || p.major !== 28 || p.minor !== 247) fail(`parse windows path ${JSON.stringify(p)}`);
    const u = parseCacheFileName('/home/x/.config/effectDefinitions_0a_32p6.cache');
    if (!u || u.model !== 0x0a || u.major !== 32 || u.minor !== 6) fail(`parse posix path ${JSON.stringify(u)}`);
    for (const bad of ['effectDefinitions_11_13.cache', 'effectDefinitions_11_13p0.cache.bak', 'presets.syx', '', 'effectDefinitions_123_1p0.cache']) {
      if (parseCacheFileName(bad) !== null) fail(`not a cache name: ${bad}`);
    }
    const h13 = { major: 13, minor: 0 };
    if (!headerMatchesFileName(h13, 'effectDefinitions_11_13p0.cache')) fail('matching name rejected');
    if (headerMatchesFileName(h13, 'effectDefinitions_11_12p0.cache')) fail('renamed file (major) accepted');
    if (headerMatchesFileName({ major: 32, minor: 6 }, 'effectDefinitions_10_32p0.cache')) fail('renamed file (minor) accepted');
    if (headerMatchesFileName(h13, 'something.cache')) fail('non-cache name accepted');
  }
  console.log('  cache/header: file-name version parsed; header vs file name catches a renamed file');

  // ---- Case 6: headerMatchesWalk --------------------------------------------
  {
    const ok = smallCache(header({ major: 13, sectionCount: 2 }));
    const w = parseCacheRecords(ok);
    if (!headerMatchesWalk(readCacheHeader(ok), w)) fail('header with the right section count rejected');
    const wrong = smallCache(header({ major: 13, sectionCount: 3 }));
    if (headerMatchesWalk(readCacheHeader(wrong), parseCacheRecords(wrong))) fail('wrong section count accepted');
    // a cache whose first section sits at 0x0e (shorter preamble) has no header of this shape
    const shortPre = new Array<number>(0x0e).fill(0);
    pushSection(shortPre, 1, 1);
    pushFloat(shortPre, 0);
    const sw = parseCacheRecords(new Uint8Array(shortPre));
    if (sw.sections[0]?.offset !== 0x0e) fail('test setup: expected a 0x0e first section');
    if (headerMatchesWalk({ sectionCount: 1 }, sw)) fail('0x0e-preamble cache accepted');
    if (headerMatchesWalk({ sectionCount: 0 }, { sections: [] })) fail('empty walk accepted');
  }
  console.log('  cache/header: header vs walk (section count, first section right after the header)');

  // ---- Case 7: version spelling ---------------------------------------------
  {
    for (const [ma, mi] of [[13, 0], [32, 6], [28, 247], [76, 0]] as const) {
      if (cacheHeaderVersion({ major: ma, minor: mi }) !== formatFirmwareVersion(ma, mi)) fail(`version spelling ${ma}.${mi}`);
    }
    if (cacheHeaderVersion({ major: 13, minor: 0 }) !== '13.0') fail('13.0 spelling');
  }
  console.log('  cache/header: header version spelled like the device firmware ("13.0")');

  // ---- Case 8: committed walks behind a synthetic header -------------------
  {
    for (const [file, major, minor] of [['fm3-12p0.walk.json', 12, 0], ['am4-66p1.walk.json', 66, 1]] as const) {
      const walk = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as CacheWalk;
      const bytes = encodeWalk(walk, header({ major, minor, sectionCount: walk.sections.length }));
      const h = readCacheHeader(bytes);
      const w = parseCacheRecords(bytes);
      if (h.major !== major || h.minor !== minor || h.buildDate !== null) fail(`${file}: header ${JSON.stringify(h)}`);
      if (!headerMatchesWalk(h, w)) fail(`${file}: header (${h.sectionCount} sections) vs walk (${w.sections.length})`);
      if (!headerMatchesFileName(h, `effectDefinitions_11_${major}p${minor}.cache`)) fail(`${file}: file-name match`);
    }
  }
  console.log('  cache/header: committed FM3 / AM4 walks re-encoded behind a header agree with it');
}
