/**
 * Cache byte-walker goldens.
 *
 * 1. Synthetic grammar coverage: hand-built cache buffers (valid 0x2e
 *    preamble + section header) exercising an enum record, a float record,
 *    a 0xffff name table, and a 0xfff0 cab table with wireIds.
 * 2. Zero-resync: a non-zero record `pad` throws a WalkError (BAD-PAD).
 * 3. Guarded real-cache cross-check: if the raw FM3 12p0 `.cache` is present,
 *    parse it and assert JSON.stringify equality with the committed
 *    `fm3-12p0.walk.json` fixture. Skipped (not failed) when absent — CI
 *    won't have it.
 * 4. Empty names: a later empty entry and an empty first entry inside a cab/IR
 *    table are accepted; an all-empty table is a table only with a parallel
 *    wire-id array, otherwise a float-tailed record.
 * 5. Generous bounds: a section tag above 64, a long name, UTF-8 names.
 * 6. Strict errors name the section and record; a tolerant walk drops the
 *    damaged section whole, resumes at the next section (no tag order assumed)
 *    and reports the skip.
 * 7. A tolerant walk of a clean buffer equals the strict walk (no issues).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCacheRecords, WalkError } from '../../src/cache/records.js';
import type { CacheRecord, EnumRecord, FloatRecord } from '../../src/cache/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const REAL_CACHE =
  '/home/pascal/Dokumente/Repositorys/FractalAudio/fas-re/raw/archive/fm3-protocol/samples/effectDefinitions_11_12p0.cache';

export const RECORDS_CASE_COUNT = 7;

// --- little-endian byte builders --------------------------------------------

const pushU16 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff);
const pushU32 = (a: number[], v: number) =>
  a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
const pushF32 = (a: number[], v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, true);
  a.push(b[0], b[1], b[2], b[3]);
};
const pushLp = (a: number[], s: string) => {
  pushU32(a, s.length);
  for (let i = 0; i < s.length; i++) a.push(s.charCodeAt(i));
};
/** Length-prefixed raw bytes (e.g. a UTF-8 name). */
const pushLpBytes = (a: number[], bytes: readonly number[]) => {
  pushU32(a, bytes.length);
  a.push(...bytes);
};
const preamble = (): number[] => new Array<number>(0x2e).fill(0);
/** A 32-byte float record. */
const pushFloat = (a: number[], id: number, tc = 2, t1 = 0, t2 = 0) => {
  pushHead(a, id, tc, 0, 1, 1, 0);
  pushU32(a, t1);
  pushU32(a, t2);
  pushU16(a, 0);
};
/** A plain enum record. */
const pushEnum = (a: number[], id: number, names: readonly string[]) => {
  pushHead(a, id, 16, 0, names.length - 1, 0, 0);
  pushU32(a, names.length);
  for (const n of names) pushLp(a, n);
  pushU32(a, 0); // x
  pushU16(a, 0);
};

/** 22-byte record head: id, tc, pad, min, max, def, step. */
const pushHead = (
  a: number[],
  id: number,
  tc: number,
  min: number,
  max: number,
  def: number,
  step: number,
  pad = 0,
) => {
  pushU16(a, id);
  pushU16(a, tc);
  pushU16(a, pad);
  pushF32(a, min);
  pushF32(a, max);
  pushF32(a, def);
  pushF32(a, step);
};

export function runRecords(): void {
  const fail = (msg: string): never => {
    throw new Error(`[cache/records] ${msg}`);
  };

  // ---- Case 1: synthetic grammar coverage ---------------------------------
  {
    const a: number[] = [];
    for (let i = 0; i < 0x2e; i++) a.push(0); // 46-byte preamble filler
    // section header @ 0x2e: tag=1, count=4
    pushU32(a, 1);
    pushU32(a, 4);

    // enum record id=5
    pushHead(a, 5, 100, 0, 10, 5, 0.1);
    pushU32(a, 2); // count
    pushLp(a, 'AAA');
    pushLp(a, 'BB');
    pushU32(a, 7); // x
    pushU16(a, 0); // trailer z

    // float record id=6 (t1=0 -> enum body rejects count<1 -> float path)
    pushHead(a, 6, 200, 0, 1, 0.5, 0.01);
    pushU32(a, 0); // t1
    pushU32(a, 0); // t2
    pushU16(a, 0); // z

    // name table id=0xffff (plain enum tail)
    pushHead(a, 0xffff, 0, 0, 0, 0, 0);
    pushU32(a, 3); // count
    pushLp(a, 'N1');
    pushLp(a, 'N2');
    pushLp(a, 'N3');
    pushU32(a, 0); // x
    pushU16(a, 0); // z

    // cab table id=0xfff0 (tableTail with wireIds)
    pushHead(a, 0xfff0, 0, 0, 0, 0, 0);
    pushU32(a, 2); // count
    pushLp(a, 'C1');
    pushLp(a, 'C2');
    pushU16(a, 0); // table z
    pushU32(a, 3); // wire-id count
    pushU32(a, 10);
    pushU32(a, 20);
    pushU32(a, 30);

    const walk = parseCacheRecords(new Uint8Array(a));

    if (walk.sections.length !== 1) fail(`expected 1 section, got ${walk.sections.length}`);
    const s = walk.sections[0];
    if (s.index !== 1 || s.count !== 4 || s.offset !== 0x2e || s.records !== 4)
      fail(`bad section: ${JSON.stringify(s)}`);
    if (walk.records.length !== 4) fail(`expected 4 records, got ${walk.records.length}`);

    const [r0, r1, r2, r3] = walk.records as CacheRecord[];

    if (r0.kind !== 'enum') fail(`r0 kind ${r0.kind}`);
    const e0 = r0 as EnumRecord;
    if (
      e0.id !== 5 ||
      e0.tc !== 100 ||
      e0.count !== 2 ||
      e0.x !== 7 ||
      JSON.stringify(e0.values) !== JSON.stringify(['AAA', 'BB']) ||
      Math.abs(e0.min - 0) > 1e-6 ||
      Math.abs(e0.max - 10) > 1e-6 ||
      Math.abs(e0.def - 5) > 1e-6 ||
      Math.abs(e0.step - 0.1) > 1e-6
    )
      fail(`enum record mismatch: ${JSON.stringify(e0)}`);
    if ('wireIds' in e0 && e0.wireIds !== undefined) fail('plain enum should have no wireIds');

    if (r1.kind !== 'float') fail(`r1 kind ${r1.kind}`);
    const f1 = r1 as FloatRecord;
    if (
      f1.id !== 6 ||
      f1.tc !== 200 ||
      f1.t1 !== 0 ||
      f1.t2 !== 0 ||
      Math.abs(f1.min - 0) > 1e-6 ||
      Math.abs(f1.max - 1) > 1e-6 ||
      Math.abs(f1.def - 0.5) > 1e-6 ||
      Math.abs(f1.step - 0.01) > 1e-6
    )
      fail(`float record mismatch: ${JSON.stringify(f1)}`);

    if (r2.kind !== 'enum') fail(`r2 kind ${r2.kind}`);
    const e2 = r2 as EnumRecord;
    if (
      e2.id !== 0xffff ||
      e2.count !== 3 ||
      JSON.stringify(e2.values) !== JSON.stringify(['N1', 'N2', 'N3'])
    )
      fail(`name-table mismatch: ${JSON.stringify(e2)}`);
    if (e2.wireIds !== undefined) fail('name table (0xffff) must not carry wireIds');

    if (r3.kind !== 'enum') fail(`r3 kind ${r3.kind}`);
    const e3 = r3 as EnumRecord;
    if (
      e3.id !== 0xfff0 ||
      e3.count !== 2 ||
      JSON.stringify(e3.values) !== JSON.stringify(['C1', 'C2']) ||
      JSON.stringify(e3.wireIds) !== JSON.stringify([10, 20, 30])
    )
      fail(`cab-table mismatch: ${JSON.stringify(e3)}`);
  }

  // ---- Case 2: zero-resync (non-zero pad throws BAD-PAD) -------------------
  {
    const a: number[] = [];
    for (let i = 0; i < 0x2e; i++) a.push(0);
    pushU32(a, 1); // tag
    pushU32(a, 1); // count = 1 record
    pushHead(a, 5, 100, 0, 10, 5, 0.1, 0x0001); // pad != 0
    // pad extra bytes so off+22 is in-bounds
    pushU32(a, 0);
    pushU32(a, 0);
    pushU16(a, 0);

    let threw = false;
    try {
      parseCacheRecords(new Uint8Array(a));
    } catch (e) {
      threw = true;
      if (!(e instanceof WalkError)) fail(`expected WalkError, got ${String(e)}`);
      if (!/BAD-PAD/.test((e as Error).message))
        fail(`expected BAD-PAD in message, got: ${(e as Error).message.split('\n')[0]}`);
    }
    if (!threw) fail('expected parseCacheRecords to throw on non-zero pad');
  }

  // ---- Case 3: guarded real-cache cross-check -----------------------------
  {
    if (!existsSync(REAL_CACHE)) {
      console.log('  SKIP cache/records real-cache cross-check (FM3 .cache absent)');
    } else {
      const raw = readFileSync(REAL_CACHE);
      const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const walk = parseCacheRecords(bytes);
      const got = JSON.stringify(walk);
      const wantText = readFileSync(join(FIXTURES, 'fm3-12p0.walk.json'), 'utf8');
      const want = JSON.stringify(JSON.parse(wantText));
      if (got !== want) {
        // surface the first divergence for debugging
        let i = 0;
        while (i < got.length && i < want.length && got[i] === want[i]) i++;
        fail(
          `real-cache walk diverged from fixture at char ${i}: ` +
            `got …${got.slice(Math.max(0, i - 30), i + 30)}… ` +
            `want …${want.slice(Math.max(0, i - 30), i + 30)}…`,
        );
      }
    }
  }

  // ---- Case 4: empty names --------------------------------------------------
  {
    const a = preamble();
    pushU32(a, 11);
    pushU32(a, 5);
    // enum with an empty LAST entry: accepted
    pushHead(a, 3, 16, 0, 2, 0, 0);
    pushU32(a, 3);
    pushLp(a, 'MONO');
    pushLp(a, 'STEREO');
    pushLp(a, '');
    pushU32(a, 0);
    pushU16(a, 0);
    // cab/IR table with an empty FIRST entry: accepted
    pushHead(a, 0xfff3, 0, 0, 0, 0, 0);
    pushU32(a, 2);
    pushLp(a, '');
    pushLp(a, 'MY IR');
    pushU16(a, 0);
    pushU32(a, 2);
    pushU32(a, 7);
    pushU32(a, 8);
    // an unused bank: ALL names empty, parallel wire-id array of the same length → a table
    pushHead(a, 0xfff4, 0, 0, 0, 0, 0);
    pushU32(a, 3);
    for (let i = 0; i < 3; i++) pushU32(a, 0);
    pushU16(a, 0);
    pushU32(a, 3);
    for (let i = 0; i < 3; i++) pushU32(a, 0xff);
    // an unpopulated table record that is float-tailed (t1 = count, t2 = 0), followed by an
    // all-zero record: read as a table its zero bytes would be 4 empty names — but no parallel
    // wire-id array follows, so it stays a float record
    pushFloat(a, 0xfff5, 0, 4, 0);
    pushHead(a, 0, 0, 0, 0, 0, 0);
    pushU32(a, 0);
    pushU32(a, 0);
    pushU16(a, 0);
    const w = parseCacheRecords(new Uint8Array(a));
    const [e, t, bank, flt] = w.records as CacheRecord[];
    if (w.records.length !== 5) fail(`empty names: ${w.records.length} records`);
    if (e.kind !== 'enum' || JSON.stringify((e as EnumRecord).values) !== JSON.stringify(['MONO', 'STEREO', ''])) {
      fail(`empty last entry: ${JSON.stringify(e)}`);
    }
    if (t.kind !== 'enum' || (t as EnumRecord).values[0] !== '' || JSON.stringify((t as EnumRecord).wireIds) !== '[7,8]') {
      fail(`empty first table entry: ${JSON.stringify(t)}`);
    }
    if (bank.kind !== 'enum' || (bank as EnumRecord).values.join('|') !== '||' || (bank as EnumRecord).wireIds?.length !== 3) {
      fail(`all-empty bank with wire ids: ${JSON.stringify(bank)}`);
    }
    if (flt.kind !== 'float' || (flt as FloatRecord).t1 !== 4) fail(`float-tailed table record: ${JSON.stringify(flt)}`);

    // An empty FIRST entry outside a table is a float tail (t1 = 1, t2 = 0), not a one-name enum.
    const b = preamble();
    pushU32(b, 7);
    pushU32(b, 1);
    pushFloat(b, 9, 2, 1, 0);
    const f = parseCacheRecords(new Uint8Array(b)).records[0];
    if (f?.kind !== 'float') fail(`t1=1,t2=0 float tail read as ${f?.kind}`);
  }
  console.log('  cache/records: empty names accepted (later entries, table first entries, unused banks); float tails stay floats');

  // ---- Case 5: generous bounds ---------------------------------------------
  {
    const a = preamble();
    pushU32(a, 1);
    pushU32(a, 1);
    pushFloat(a, 0);
    pushU32(a, 200); // section tag > 64
    pushU32(a, 2);
    const long = 'X'.repeat(150); // name > 64 bytes
    pushEnum(a, 0, ['A', long]);
    // UTF-8 names (a device-synced name table): 'Sä' and a truncated sequence
    pushHead(a, 0xffff, 0, 0, 0, 0, 0);
    pushU32(a, 2);
    pushLpBytes(a, [0x53, 0xc3, 0xa4]);
    pushLpBytes(a, [0x53, 0xc3]);
    pushU32(a, 0);
    pushU16(a, 0);
    const w = parseCacheRecords(new Uint8Array(a));
    if (w.sections.map((x) => x.index).join(',') !== '1,200') fail(`section tags: ${w.sections.map((x) => x.index)}`);
    const en = w.records[1] as EnumRecord;
    if (en.kind !== 'enum' || en.values[1] !== long) fail('long name not accepted');
    const names = (w.records[2] as EnumRecord).values;
    if (names[0] !== 'S\u00e4' || names[1] !== 'S\uFFFD') fail(`UTF-8 names decoded as ${JSON.stringify(names)}`);

    // The FIRST section header may carry a tag above 64 too (detection uses the same bounds,
    // confirmed by the whole first section parsing).
    const b = preamble();
    pushU32(b, 100);
    pushU32(b, 1);
    pushFloat(b, 0);
    const first = parseCacheRecords(new Uint8Array(b));
    if (first.sections[0]?.index !== 100 || first.sections[0]?.offset !== 0x2e) fail(`first-header detection: ${JSON.stringify(first.sections)}`);
  }
  console.log('  cache/records: section tags > 64 (first header included), names > 64 bytes and UTF-8 names walk');

  // ---- Case 6: strict errors name the record; tolerant walks resume -------
  // Tags DESCEND (3, 2, 1) on purpose: device-synced caches do not list sections in order.
  const damaged = (): { buf: Uint8Array; third: number } => {
    const a = preamble();
    pushU32(a, 3);
    pushU32(a, 2);
    pushFloat(a, 0);
    pushEnum(a, 1, ['ON', 'OFF']);
    pushU32(a, 2);
    pushU32(a, 3);
    pushFloat(a, 0);
    pushHead(a, 1, 2, 0, 1, 1, 0, 0x00ff); // damaged: non-zero pad
    pushU32(a, 0);
    pushU32(a, 0);
    pushU16(a, 0);
    pushFloat(a, 2);
    const third = a.length;
    pushU32(a, 1);
    pushU32(a, 2);
    pushEnum(a, 0, ['A', 'B']);
    pushFloat(a, 1);
    return { buf: new Uint8Array(a), third };
  };
  {
    const { buf, third } = damaged();
    try {
      parseCacheRecords(buf);
      fail('strict walk must throw on a damaged record');
    } catch (e) {
      if (!(e instanceof WalkError)) throw e;
      if (!/BAD-PAD/.test(e.message) || !/in section 2 record 2\/3/.test(e.message)) {
        fail(`strict error must name the section/record: ${e.message.split('\n')[0]}`);
      }
      if (e.position?.section !== 2 || e.position.record !== 1) fail(`WalkError.position ${JSON.stringify(e.position)}`);
    }
    const w = parseCacheRecords(buf, { tolerant: true });
    const tags = w.sections.map((x) => `${x.index}:${x.records}/${x.count}`).join(' ');
    if (tags !== '3:2/2 2:0/3 1:2/2') fail(`tolerant sections: ${tags}`);
    if (w.records.length !== 4 || w.records.some((r) => r.section === 2)) fail(`tolerant records: ${w.records.length} (section 2 must be gone)`);
    const iss = w.issues ?? [];
    if (
      iss.length !== 1 || iss[0]!.section !== 2 || iss[0]!.record !== 1 || iss[0]!.droppedRecords !== 1 ||
      iss[0]!.resumedAt !== third || !/BAD-PAD/.test(iss[0]!.reason)
    ) {
      fail(`tolerant issue: ${JSON.stringify(iss)}`);
    }
    // Damage with no later section: the walk keeps the intact sections and reports the rest skipped.
    const tail = parseCacheRecords(buf.subarray(0, third - 10), { tolerant: true });
    const ti = tail.issues ?? [];
    if (tail.records.length !== 2 || ti.length !== 1 || ti[0]!.resumedAt !== null) fail(`tolerant tail: ${JSON.stringify(ti)}`);
  }
  console.log('  cache/records: strict errors name section/record; a tolerant walk drops the damaged section whole and resumes (any tag order)');

  // ---- Case 7: tolerant == strict on a clean buffer ------------------------
  {
    const { buf } = damaged();
    const clean = Uint8Array.from(buf);
    // repair the damaged pad
    const all = parseCacheRecords(buf, { tolerant: true });
    const badOff = all.issues![0]!.offset;
    clean[badOff + 4] = 0;
    clean[badOff + 5] = 0;
    const strict = parseCacheRecords(clean);
    const tol = parseCacheRecords(clean, { tolerant: true });
    if (JSON.stringify(tol.issues) !== '[]') fail(`clean buffer reported issues: ${JSON.stringify(tol.issues)}`);
    if (JSON.stringify({ ...tol, issues: undefined }) !== JSON.stringify(strict)) fail('tolerant walk of a clean buffer differs from strict');
    if ('issues' in strict) fail('a strict walk must not carry an issues key (fixture JSON equality)');
  }
  console.log('  cache/records: a tolerant walk of a clean buffer equals the strict walk');
}
