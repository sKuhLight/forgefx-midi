/**
 * Byte-walker for Fractal editor `effectDefinitions_*.cache` files (FM9-Edit,
 * AM4-Edit, AxeEdit II/III, VP4-Edit).
 *
 * Cache section/record grammar (solved 2026-06-09):
 *
 *   file    := preamble , section+
 *   section := u32 sectionTag , u32 recordCount , record{recordCount}
 *   record  := u16 id , u16 typecode , u16 pad(=0) ,
 *              f32 min , f32 max , f32 default , f32 step ,
 *              ( enumTail | floatTail | tableTail )
 *   enumTail  := u32 count , count * (u32 len , ascii[len]) , u32 x , u16 0
 *   floatTail := u32 t1 , u32 t2 , u16 0          (record = 32 bytes)
 *   tableTail := (id in 0xfff0..0xfffe only)
 *                u32 count , count * (u32 len , ascii[len]) ,
 *                u16 0 , u32 idCount , idCount * u32 wireId
 *
 * Preamble: first section header at 0x2e (AM4/gen-3 caches) or 0x0e
 * (Axe-Fx II cache). Auto-detect: try 0x2e then 0x0e, accept the first whose
 * whole first section parses within the walk's bounds (fallback: the classic
 * 1<=tag<=64 && 1<=count<=8192 check). id=0xffff is a name table (plain enumTail);
 * ids 0xfff0..0xfffe are cab/IR tables (tableTail). The 0x2e-byte preamble is a
 * header with version fields (`readCacheHeader`, ./header.ts); user name tables
 * are blanked by `redactCacheUserNames` (./redact.ts).
 *
 * Names: a name may be EMPTY (len 0) — device-synced caches carry them (an
 * empty first entry in a user cab/IR table, an empty last entry in a mode
 * list). An empty entry is accepted anywhere after the first; an empty FIRST
 * entry only inside a cab/IR table (elsewhere `count=1, len=0` is exactly a
 * float tail with t1 = 1, t2 = 0). A body whose names are ALL empty is an enum
 * only as a cab/IR table whose parallel wire-id array has exactly one id per
 * name (an unused bank); otherwise it is a float-tailed record (t1 = count,
 * t2 = 0) of an unpopulated table.
 *
 * Names are ASCII in editor-shipped data; device-synced name tables (preset
 * names) can carry UTF-8, which is decoded (a malformed sequence becomes
 * U+FFFD). Control bytes still reject a name.
 *
 * Bounds are generous sanity limits, not format facts: section tags up to
 * 0xffff, up to 65535 records per section, names up to 255 bytes, up to 16384
 * names per list.
 *
 * The walk is deterministic: section headers carry exact record counts.
 * Strict (default): any violation throws a `WalkError` naming the section and
 * record with a hex-context dump. `tolerant`: a damaged section is dropped
 * whole (its header stays listed with `records: 0`), the walk resynchronises at
 * the next section that parses cleanly from header to end, and each skip is
 * reported in `issues`.
 * Pure and browser-safe — no `node:*`, no `Buffer`; bytes are read through a
 * little-endian `DataView`.
 */
import type { CacheWalk, CacheWalkIssue, EnumRecord, Section } from './types.js';

// ---------------------------------------------------------------------------
// Sanity bounds (generous; the grammar is count-driven, these only reject
// obviously corrupt values)
// ---------------------------------------------------------------------------

/** Highest section tag accepted inside the walk. */
const MAX_SECTION_TAG = 0xffff;
/** Most records one section may declare. */
const MAX_SECTION_RECORDS = 0xffff;
/** Longest accepted name (bytes). */
const MAX_NAME_LEN = 255;
/** Most names one enum/table record may carry. */
const MAX_NAMES = 16384;
/** Most wire ids a cab/IR table may carry. */
const MAX_WIRE_IDS = 0xffff;

// ---------------------------------------------------------------------------
// Hex helpers (pure, no console)
// ---------------------------------------------------------------------------

function hex(n: number): string {
  return '0x' + n.toString(16);
}

function hexdump(buf: Uint8Array, start: number, length: number, mark?: number): string {
  const N = buf.length;
  const out: string[] = [];
  for (let base = Math.max(0, start) & ~0xf; base < Math.min(start + length, N); base += 16) {
    const bs = buf.subarray(base, base + 16);
    const hx = [...bs].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const asc = [...bs].map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('');
    const m = mark !== undefined && base <= mark && mark < base + 16 ? ' <<<' : '';
    out.push(`  0x${base.toString(16).padStart(6, '0')}: ${hx.padEnd(48)} ${asc}${m}`);
  }
  return out.join('\n');
}

/**
 * Decode `len` bytes as UTF-8 (pure; no TextDecoder). A malformed or truncated
 * sequence yields U+FFFD for its lead byte and decoding resumes after it.
 */
function decodeUtf8(buf: Uint8Array, start: number, len: number): string {
  let s = '';
  const end = start + len;
  let i = start;
  while (i < end) {
    const b = buf[i];
    if (b < 0x80) {
      s += String.fromCharCode(b);
      i += 1;
      continue;
    }
    // continuation-byte count for a valid lead byte (0 = not a lead byte)
    const n = b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : 0;
    let cp = b & (n === 1 ? 0x1f : n === 2 ? 0x0f : 0x07);
    let ok = n > 0 && i + n < end;
    for (let k = 1; ok && k <= n; k++) {
      const c = buf[i + k];
      if ((c & 0xc0) !== 0x80) ok = false;
      else cp = (cp << 6) | (c & 0x3f);
    }
    // reject overlong forms, surrogates and out-of-range code points
    if (ok && ((n === 2 && cp < 0x800) || (n === 3 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff))) {
      ok = false;
    }
    if (!ok) {
      s += '\uFFFD';
      i += 1;
      continue;
    }
    s += String.fromCodePoint(cp);
    i += n + 1;
  }
  return s;
}

/** Where in the grammar a violation happened (section tag + 0-based record index). */
interface WalkPosition {
  section: number;
  record: number;
  count: number;
}

/** A grammar violation, with the section/record it hit and a hex-context dump. */
export class WalkError extends Error {
  /** Short violation reason (e.g. `BAD-PAD id=0x5 ...`). */
  readonly reason: string;
  /** Byte offset of the violation. */
  readonly offset: number;
  /** Section tag / record index, when the violation is inside a record. */
  readonly position?: { section: number; record: number };

  constructor(reason: string, offset: number, recordsWalked: number, buf: Uint8Array, at?: WalkPosition) {
    const N = buf.length;
    const where = at ? ` in section ${at.section} record ${at.record + 1}/${at.count}` : '';
    super(
      `cache walk VIOLATION: ${reason} at ${hex(offset)}${where} ` +
        `(${recordsWalked} records walked, ${N - offset} bytes remaining)\n` +
        hexdump(buf, offset - 64, 176, offset)
    );
    this.name = 'WalkError';
    this.reason = reason;
    this.offset = offset;
    if (at) this.position = { section: at.section, record: at.record };
  }
}

/** Options for `parseCacheRecords`. */
export interface ParseCacheOptions {
  /**
   * Keep going past a damaged record instead of throwing: the damaged section
   * is dropped whole (a section cut short would yield a stride and ranges a
   * consumer would trust), the walk resumes at the next section that parses
   * cleanly from header to end, and every skip lands in `issues`.
   * Default false (strict). An unsupported cache revision still throws.
   */
  tolerant?: boolean;
  /**
   * Also report where each name's bytes sit: every enum record (and cab/IR table) gets
   * `nameSpans`, one `[offset, byteLength]` per entry of `values` — the bytes after the entry's
   * u32 length (`byteLength` 0 for an empty name; UTF-8 names count bytes, not characters).
   * Default false: the walk result is then byte-identical to a walk without the option (no
   * `nameSpans` key at all).
   */
  nameSpans?: boolean;
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

/**
 * Parse a cache buffer into `{ sections, records }`, byte-for-byte
 * JSON-equivalent to the reference walker's `.walk.json` output.
 * Strict by default: throws `WalkError` on any grammar violation. With
 * `{ tolerant: true }` it returns everything it could walk plus `issues`.
 */
export function parseCacheRecords(buf: Uint8Array, opts: ParseCacheOptions = {}): CacheWalk {
  const N = buf.length;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tolerant = opts.tolerant === true;
  const wantSpans = opts.nameSpans === true;

  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  const f32 = (o: number) => dv.getFloat32(o, true);

  // -- Grammar primitives ---------------------------------------------------

  const tryLpString = (off: number, allowEmpty: boolean): [string, number] | undefined => {
    if (off + 4 > N) return undefined;
    const L = u32(off);
    if (L < (allowEmpty ? 0 : 1) || L > MAX_NAME_LEN || off + 4 + L > N) return undefined;
    let ascii = true;
    for (let i = 0; i < L; i++) {
      const c = buf[off + 4 + i];
      if (c < 0x20 || c === 0x7f) return undefined; // control bytes are never part of a name
      if (c > 0x7e) ascii = false;
    }
    if (!ascii) return [decodeUtf8(buf, off + 4, L), off + 4 + L];
    let s = '';
    for (let i = 0; i < L; i++) s += String.fromCharCode(buf[off + 4 + i]);
    return [s, off + 4 + L];
  };

  /**
   * Names may be empty after the first; an empty first only in a cab/IR table. An ALL-empty
   * list is accepted only for a table whose tail carries a parallel wire-id array of the same
   * length — the one shape that tells an unused bank from a float tail with t1 = count.
   */
  const tryEnumBody = (off: number, isTable: boolean): [number, string[], number] | undefined => {
    if (off + 4 > N) return undefined;
    const count = u32(off);
    if (count < 1 || count > MAX_NAMES) return undefined;
    let p = off + 4;
    const vals: string[] = [];
    let anyName = false;
    for (let i = 0; i < count; i++) {
      const r = tryLpString(p, i > 0 || isTable);
      if (r === undefined) return undefined;
      if (r[0] !== '') anyName = true;
      vals.push(r[0]);
      p = r[1];
    }
    if (!anyName && !(isTable && p + 6 <= N && u16(p) === 0 && u32(p + 2) === count)) return undefined;
    return [count, vals, p];
  };

  const sections: Section[] = [];
  const records: CacheWalk['records'] = [];
  const issues: CacheWalkIssue[] = [];

  /**
   * Read ONE record at `off` of section `sec` (record index `ri`). Returns the
   * record and the offset after it; throws `WalkError` on a violation. Pure
   * with respect to the walk state, so a tolerant resync can probe with it.
   */
  const readRecord = (off: number, sec: Section, ri: number): [CacheWalk['records'][number], number] => {
    const at: WalkPosition = { section: sec.index, record: ri, count: sec.count };
    const err = (reason: string, o: number) => new WalkError(reason, o, records.length, buf, at);
    if (off + 22 > N) throw err('RECORD-EOF', off);
    const idv = u16(off);
    const tc = u16(off + 2);
    const pad = u16(off + 4);
    if (pad !== 0) throw err(`BAD-PAD id=${hex(idv)} tc=${hex(tc)} pad=${hex(pad)}`, off);
    const mn = f32(off + 6);
    const mx = f32(off + 10);
    const df = f32(off + 14);
    const st = f32(off + 18);
    const isTable = idv >= 0xfff0 && idv <= 0xfffe;

    const en = tryEnumBody(off + 22, isTable);
    if (en !== undefined) {
      const [count, vals, end] = en;
      if (end + 6 > N) throw err('ENUM-EOF', off);
      const rec: EnumRecord = {
        kind: 'enum',
        section: sec.index,
        offset: off,
        id: idv,
        tc,
        min: mn,
        max: mx,
        def: df,
        step: st,
        count,
        values: vals,
        x: 0,
      };
      if (wantSpans) {
        // Re-walk the (already validated) name list: u32 len, then len name bytes.
        const spans: Array<readonly [number, number]> = [];
        let p = off + 26;
        for (let i = 0; i < count; i++) {
          const L = u32(p);
          spans.push([p + 4, L]);
          p += 4 + L;
        }
        rec.nameSpans = spans;
      }
      if (isTable) {
        // cab/IR table record: tail = u16 0, u32 cnt, cnt x u32 wire-ids
        const z = u16(end);
        const cnt = u32(end + 2);
        if (z !== 0 || cnt > MAX_WIRE_IDS) throw err(`BAD-FFF0-TAIL z=${hex(z)} cnt=${cnt}`, end);
        const idsEnd = end + 6 + 4 * cnt;
        if (idsEnd > N) throw err('FFF0-IDS-EOF', end);
        rec.wireIds = [];
        for (let i = 0; i < cnt; i++) rec.wireIds.push(u32(end + 6 + 4 * i));
        return [rec, idsEnd];
      }
      const x = u32(end);
      const z = u16(end + 4);
      if (z !== 0) throw err(`BAD-ENUM-TRAILER x=${hex(x)} z=${hex(z)}`, end);
      rec.x = x;
      return [rec, end + 6];
    }
    if (off + 32 > N) throw err('FLOAT-EOF', off);
    const t1 = u32(off + 22);
    const t2 = u32(off + 26);
    const z = u16(off + 30);
    if (z !== 0) throw err(`BAD-FLOAT-TAIL t1=${hex(t1)} t2=${hex(t2)} z=${hex(z)}`, off + 30);
    return [
      { kind: 'float', section: sec.index, offset: off, id: idv, tc, min: mn, max: mx, def: df, step: st, t1, t2 },
      off + 32,
    ];
  };

  /** A plausible in-walk section header at `off` (sanity bounds only). */
  const headerAt = (off: number): [number, number] | undefined => {
    if (off + 8 > N) return undefined;
    const A = u32(off);
    const B = u32(off + 4);
    return A <= MAX_SECTION_TAG && B <= MAX_SECTION_RECORDS ? [A, B] : undefined;
  };

  /**
   * The offset after a WHOLE section (header at `h`, tag `A`, `B` records) when every record
   * parses cleanly, else `undefined`.
   */
  const sectionEnd = (h: number, A: number, B: number): number | undefined => {
    const probe: Section = { index: A, count: B, offset: h, records: 0 };
    let p = h + 8;
    for (let i = 0; i < B; i++) {
      try {
        p = readRecord(p, probe, i)[1];
      } catch {
        return undefined;
      }
    }
    return p;
  };

  /** Tags of the sections walked so far (a cache lists each section once). */
  const seenTags = new Set<number>();

  /**
   * Tolerant resync: the first offset after `from` holding a section header (non-zero tag not
   * seen yet, at least one record) whose WHOLE section parses cleanly and ends at EOF or at a
   * further section header of the same kind whose first record parses. No tag ORDER is assumed —
   * device-synced caches do not list their sections ascending. Zero-filled stretches parse as
   * all-zero records, so the candidate must be followed by a real-looking header too.
   * `undefined` when none exists.
   */
  const resyncFrom = (from: number): number | undefined => {
    for (let h = from; h + 8 <= N; h++) {
      const A = u32(h);
      const B = u32(h + 4);
      if (A < 1 || A > MAX_SECTION_TAG || B < 1 || B > MAX_SECTION_RECORDS || seenTags.has(A)) continue;
      const p = sectionEnd(h, A, B);
      if (p === undefined) continue;
      if (p === N) return h;
      const next = headerAt(p);
      if (!next || next[0] < 1 || next[1] < 1 || next[0] === A || seenTags.has(next[0])) continue;
      if (sectionEnd(p, next[0], 1) !== undefined) return h;
    }
    return undefined;
  };

  /**
   * Strict: rethrow. Tolerant: drop the damaged section's records (a section cut short would
   * yield a stride and ranges a consumer would trust), log the issue and resync (or stop).
   */
  const recover = (e: unknown, at: number, sec: Section | undefined): number | undefined => {
    if (!tolerant || !(e instanceof WalkError)) throw e;
    let droppedRecords = 0;
    if (sec && sec.records > 0) {
      droppedRecords = sec.records;
      records.splice(records.length - sec.records, sec.records);
      sec.records = 0;
    }
    const next = resyncFrom(at + 1);
    issues.push({
      section: sec?.index ?? null,
      record: e.position?.record ?? null,
      offset: e.offset,
      reason: e.reason,
      droppedRecords,
      skippedBytes: (next ?? N) - at,
      resumedAt: next ?? null,
    });
    return next;
  };

  // First section header position differs by editor generation:
  // AM4/gen-3 caches: 0x2e (after 38-byte preamble); II cache: 0x0e. Prefer the candidate whose
  // whole first section parses within the walk's bounds; fall back to the classic tight check
  // (1<=tag<=64, 1<=count<=8192) so a damaged first section still reaches the walk's error path.
  let off: number | undefined;
  for (const cand of [0x2e, 0x0e]) {
    if (cand + 8 > N) continue;
    const A0 = u32(cand);
    const B0 = u32(cand + 4);
    if (A0 >= 1 && A0 <= MAX_SECTION_TAG && B0 >= 1 && B0 <= MAX_SECTION_RECORDS && sectionEnd(cand, A0, B0) !== undefined) {
      off = cand;
      break;
    }
  }
  if (off === undefined) {
    for (const cand of [0x2e, 0x0e]) {
      if (cand + 8 > N) continue;
      const A0 = u32(cand);
      const B0 = u32(cand + 4);
      if (A0 >= 1 && A0 <= 64 && B0 >= 1 && B0 <= 8192) {
        off = cand;
        break;
      }
    }
  }
  if (off === undefined) {
    throw new WalkError('no initial section header found at 0x2e or 0x0e', 0, 0, buf);
  }

  let sec: Section | undefined;
  let remaining = 0;

  while (off < N) {
    if (remaining === 0) {
      if (off + 8 > N) {
        if (off === N) break;
        const e = new WalkError('TRAILING-BYTES', off, records.length, buf);
        if (!tolerant) throw e;
        issues.push({ section: null, record: null, offset: off, reason: e.reason, droppedRecords: 0, skippedBytes: N - off, resumedAt: null });
        break;
      }
      const hdr = headerAt(off);
      if (hdr === undefined) {
        const A = u32(off);
        const B = u32(off + 4);
        // Older cache revision marker: a standalone u16 0x8000 lands in the
        // would-be count field as 0x80000000 (seen on FM9 fw 9p0/9p1/9p2/10p0).
        // A different format, not damage: always fatal.
        if (A === 0 && B === 0x8000_0000) {
          throw new WalkError('older cache revision (0x8000 markers), not supported', off, records.length, buf);
        }
        const next = recover(new WalkError(`BAD-SECTION-HEADER A=${A} B=${B}`, off, records.length, buf), off, undefined);
        if (next === undefined) break;
        off = next;
        continue;
      }
      sec = { index: hdr[0], count: hdr[1], offset: off, records: 0 };
      sections.push(sec);
      seenTags.add(hdr[0]);
      remaining = hdr[1];
      off += 8;
      continue;
    }

    let parsed: [CacheWalk['records'][number], number];
    try {
      parsed = readRecord(off, sec!, sec!.records);
    } catch (e) {
      const next = recover(e, off, sec);
      if (next === undefined) break;
      remaining = 0;
      off = next;
      continue;
    }
    records.push(parsed[0]);
    off = parsed[1];
    sec!.records += 1;
    remaining -= 1;
  }

  return tolerant ? { sections, records, issues } : { sections, records };
}
