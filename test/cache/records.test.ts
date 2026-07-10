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
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCacheRecords, WalkError } from '../../src/cache/records.js';
import type { CacheRecord, EnumRecord, FloatRecord } from '../../src/cache/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const REAL_CACHE =
  '/home/pascal/Dokumente/Repositorys/FractalAudio/fas-re/raw/archive/fm3-protocol/samples/effectDefinitions_11_12p0.cache';

export const RECORDS_CASE_COUNT = 3;

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
}
