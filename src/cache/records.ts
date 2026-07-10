/**
 * Strict, zero-resync byte-walker for Fractal editor
 * `effectDefinitions_*.cache` files (FM9-Edit, AM4-Edit, AxeEdit II/III,
 * VP4-Edit).
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
 * (Axe-Fx II cache). Auto-detect: try 0x2e then 0x0e, accept where
 * 1<=tag<=64 && 1<=count<=8192. id=0xffff is a name table (plain enumTail);
 * ids 0xfff0..0xfffe are cab/IR tables (tableTail).
 *
 * The walk is fully deterministic: section headers carry exact record
 * counts. ZERO resync: any violation throws a `WalkError` with a
 * hex-context dump. Pure and browser-safe — no `node:*`, no `Buffer`;
 * bytes are read through a little-endian `DataView`.
 */
import type { CacheWalk, EnumRecord, Section } from './types.js';

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

/** ZERO-resync policy: any grammar violation throws with hex context. */
export class WalkError extends Error {
  constructor(reason: string, offset: number, recordsWalked: number, buf: Uint8Array) {
    const N = buf.length;
    super(
      `cache walk VIOLATION: ${reason} at ${hex(offset)} ` +
        `(${recordsWalked} records walked, ${N - offset} bytes remaining)\n` +
        hexdump(buf, offset - 64, 176, offset)
    );
    this.name = 'WalkError';
  }
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

/**
 * Parse a cache buffer into `{ sections, records }`, byte-for-byte
 * JSON-equivalent to the reference walker's `.walk.json` output.
 * Throws `WalkError` on any grammar violation.
 */
export function parseCacheRecords(buf: Uint8Array): CacheWalk {
  const N = buf.length;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  const f32 = (o: number) => dv.getFloat32(o, true);

  // -- Grammar primitives ---------------------------------------------------

  const tryLpString = (off: number, maxlen = 64): [string, number] | undefined => {
    if (off + 4 > N) return undefined;
    const L = u32(off);
    if (L < 1 || L > maxlen || off + 4 + L > N) return undefined;
    let s = '';
    for (let i = 0; i < L; i++) {
      const c = buf[off + 4 + i];
      if (c < 0x20 || c > 0x7e) return undefined;
      s += String.fromCharCode(c);
    }
    return [s, off + 4 + L];
  };

  const tryEnumBody = (off: number, maxcount = 4096): [number, string[], number] | undefined => {
    if (off + 4 > N) return undefined;
    const count = u32(off);
    if (count < 1 || count > maxcount) return undefined;
    let p = off + 4;
    const vals: string[] = [];
    for (let i = 0; i < count; i++) {
      const r = tryLpString(p);
      if (r === undefined) return undefined;
      vals.push(r[0]);
      p = r[1];
    }
    return [count, vals, p];
  };

  const sections: Section[] = [];
  const records: CacheWalk['records'] = [];

  // First section header position differs by editor generation:
  // AM4/gen-3 caches: 0x2e (after 38-byte preamble); II cache: 0x0e.
  let off: number | undefined;
  for (const cand of [0x2e, 0x0e]) {
    if (cand + 8 > N) continue;
    const A0 = u32(cand);
    const B0 = u32(cand + 4);
    if (A0 >= 1 && A0 <= 64 && B0 >= 1 && B0 <= 8192) {
      off = cand;
      break;
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
        throw new WalkError('TRAILING-BYTES', off, records.length, buf);
      }
      const A = u32(off);
      const B = u32(off + 4);
      if (A > 64 || B > 8192) {
        // Older cache revision marker: a standalone u16 0x8000 lands in the
        // would-be count field as 0x80000000 (seen on FM9 fw 9p0/9p1/9p2/10p0).
        if (A === 0 && B === 0x8000_0000) {
          throw new WalkError(
            'older cache revision (0x8000 markers), not supported',
            off,
            records.length,
            buf
          );
        }
        throw new WalkError(`BAD-SECTION-HEADER A=${A} B=${B}`, off, records.length, buf);
      }
      sec = { index: A, count: B, offset: off, records: 0 };
      sections.push(sec);
      remaining = B;
      off += 8;
      continue;
    }

    if (off + 22 > N) throw new WalkError('RECORD-EOF', off, records.length, buf);
    const idv = u16(off);
    const tc = u16(off + 2);
    const pad = u16(off + 4);
    if (pad !== 0) {
      throw new WalkError(`BAD-PAD id=${hex(idv)} tc=${hex(tc)} pad=${hex(pad)}`, off, records.length, buf);
    }
    const mn = f32(off + 6);
    const mx = f32(off + 10);
    const df = f32(off + 14);
    const st = f32(off + 18);

    const en = tryEnumBody(off + 22);
    if (en !== undefined) {
      const [count, vals, end] = en;
      if (end + 6 > N) throw new WalkError('ENUM-EOF', off, records.length, buf);
      const rec: EnumRecord = {
        kind: 'enum',
        section: sec!.index,
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
      if (idv >= 0xfff0 && idv <= 0xfffe) {
        // cab/IR table record: tail = u16 0, u32 cnt, cnt x u32 wire-ids
        const z = u16(end);
        const cnt = u32(end + 2);
        if (z !== 0 || cnt > 8192) {
          throw new WalkError(`BAD-FFF0-TAIL z=${hex(z)} cnt=${cnt}`, end, records.length, buf);
        }
        const idsEnd = end + 6 + 4 * cnt;
        if (idsEnd > N) throw new WalkError('FFF0-IDS-EOF', end, records.length, buf);
        rec.wireIds = [];
        for (let i = 0; i < cnt; i++) rec.wireIds.push(u32(end + 6 + 4 * i));
        records.push(rec);
        off = idsEnd;
      } else {
        const x = u32(end);
        const z = u16(end + 4);
        if (z !== 0) {
          throw new WalkError(`BAD-ENUM-TRAILER x=${hex(x)} z=${hex(z)}`, end, records.length, buf);
        }
        rec.x = x;
        records.push(rec);
        off = end + 6;
      }
    } else {
      if (off + 32 > N) throw new WalkError('FLOAT-EOF', off, records.length, buf);
      const t1 = u32(off + 22);
      const t2 = u32(off + 26);
      const z = u16(off + 30);
      if (z !== 0) {
        throw new WalkError(`BAD-FLOAT-TAIL t1=${hex(t1)} t2=${hex(t2)} z=${hex(z)}`, off + 30, records.length, buf);
      }
      records.push({
        kind: 'float',
        section: sec!.index,
        offset: off,
        id: idv,
        tc,
        min: mn,
        max: mx,
        def: df,
        step: st,
        t1,
        t2,
      });
      off += 32;
    }
    sec!.records += 1;
    remaining -= 1;
  }

  return { sections, records };
}
