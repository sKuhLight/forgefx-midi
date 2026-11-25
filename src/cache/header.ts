/**
 * Header reader for Fractal editor `effectDefinitions_*.cache` files (gen-3 and AM4 caches,
 * whose first section header sits at 0x2e — see ./records.ts).
 *
 * Header layout (0x2e bytes, little-endian), as observed across FM3, FM9, Axe-Fx III and AM4
 * caches:
 *
 *   0x00  u32  major version — equals the `<major>` of the file name `…_<major>p<minor>.cache`
 *   0x04  u32  minor version — equals the `<minor>` of the file name
 *   0x08  u16  4 in every cache seen (meaning unknown; not read)
 *   0x0a  ascii[..0x2a]  build date, NUL-terminated (`Mmm dd yyyy hh:mm:ss`), present in some
 *              caches; zeros in the others
 *   0x2a  u32  section count — the number of sections the walk finds
 *
 * Every other header byte is zero in the caches seen. The reader is tolerant of unknown bytes
 * (it reads only the fields above and ignores the rest) and strict on size (a buffer shorter
 * than the header throws). The version is the cache's OWN version: it matches the file name,
 * but it is not necessarily the device firmware (a unit may report a different firmware), so it
 * is a hint next to the device's firmware read, never a replacement for it.
 *
 * Pure and browser-safe — no `node:*`, no `Buffer`.
 */
import { formatFirmwareVersion } from '../shared/firmware.js';
import type { CacheWalk } from './types.js';

/** Header size in bytes: the first section header starts right after it. */
export const CACHE_HEADER_BYTES = 0x2e;

/** Build-date field: first byte and the (exclusive) end, where the section count starts. */
const BUILD_DATE_START = 0x0a;
const BUILD_DATE_END = 0x2a;
/** Offset of the u32 section count. */
const SECTION_COUNT_AT = 0x2a;

/** The fields of a cache header (see the module comment for the layout). */
export interface CacheHeader {
  /** u32 LE @0x00: the cache's major version. */
  major: number;
  /** u32 LE @0x04: the cache's minor version. */
  minor: number;
  /** u32 LE @0x2a: the number of sections. */
  sectionCount: number;
  /**
   * ASCII build date @0x0a (up to the first NUL, at most 32 bytes), or `null` when the field is
   * zero or does not hold printable ASCII text.
   */
  buildDate: string | null;
}

/** A buffer too short to hold a cache header. */
export class CacheHeaderError extends Error {
  /** Short reason (e.g. `SHORT-HEADER`). */
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'CacheHeaderError';
    this.reason = reason;
  }
}

/**
 * Read the header of a cache buffer. Throws `CacheHeaderError` when the buffer is shorter than
 * `CACHE_HEADER_BYTES`; otherwise never throws (unknown header bytes are ignored).
 */
export function readCacheHeader(buf: Uint8Array): CacheHeader {
  if (buf.length < CACHE_HEADER_BYTES) {
    throw new CacheHeaderError(
      'SHORT-HEADER',
      `cache header needs ${CACHE_HEADER_BYTES} bytes, buffer has ${buf.length}`,
    );
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let buildDate = '';
  for (let i = BUILD_DATE_START; i < BUILD_DATE_END; i++) {
    const c = buf[i]!;
    if (c === 0) break;
    if (c < 0x20 || c > 0x7e) {
      buildDate = '';
      break;
    }
    buildDate += String.fromCharCode(c);
  }
  return {
    major: dv.getUint32(0, true),
    minor: dv.getUint32(4, true),
    sectionCount: dv.getUint32(SECTION_COUNT_AT, true),
    buildDate: buildDate.length > 0 ? buildDate : null,
  };
}

/** The header version spelled like a device firmware (`formatFirmwareVersion`), e.g. "13.0". */
export function cacheHeaderVersion(header: Pick<CacheHeader, 'major' | 'minor'>): string {
  return formatFirmwareVersion(header.major, header.minor);
}

/** Identity an editor-cache file name carries: `effectDefinitions_<modelHex>_<major>p<minor>.cache`. */
export interface CacheFileName {
  /** Model byte (the hex field: `11` → 0x11). */
  model: number;
  major: number;
  minor: number;
}

const CACHE_FILE_NAME = /^effectDefinitions_([0-9a-fA-F]{1,2})_(\d+)p(\d+)\.cache$/;

/**
 * Parse an editor-cache file name (a leading directory path is ignored), or `null` when the
 * name is not one. E.g. `effectDefinitions_11_13p0.cache` → `{ model: 0x11, major: 13, minor: 0 }`.
 */
export function parseCacheFileName(name: string): CacheFileName | null {
  const base = name.split(/[\\/]/).pop() ?? name;
  const m = CACHE_FILE_NAME.exec(base);
  if (!m) return null;
  return { model: parseInt(m[1]!, 16), major: Number(m[2]), minor: Number(m[3]) };
}

/**
 * True when the header carries the same version as the file name. A renamed file fails; so does
 * a name that is not an editor-cache name.
 */
export function headerMatchesFileName(header: Pick<CacheHeader, 'major' | 'minor'>, name: string): boolean {
  const f = parseCacheFileName(name);
  return f !== null && f.major === header.major && f.minor === header.minor;
}

/**
 * True when the header agrees with a walk of the same bytes: the first section starts right
 * after the header and the walk found exactly `sectionCount` sections. (A cache with a shorter
 * preamble, such as the Axe-Fx II one, has no header of this shape and fails.)
 */
export function headerMatchesWalk(header: Pick<CacheHeader, 'sectionCount'>, walk: Pick<CacheWalk, 'sections'>): boolean {
  return walk.sections[0]?.offset === CACHE_HEADER_BYTES && walk.sections.length === header.sectionCount;
}
