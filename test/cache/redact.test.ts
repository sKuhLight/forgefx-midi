/**
 * User-name redaction (`redactCacheUserNames` and its post-check).
 *
 * 1. Mixed synthetic cache (name table, user + scratchpad + unused cab banks, factory/legacy
 *    banks, an unknown special table, ordinary records): exactly the user name bytes change,
 *    to `_`, same lengths; size, offsets, wire ids, factory tables and every other byte stay;
 *    counts per table kind; the input buffer is not modified.
 * 2. UTF-8, truncated UTF-8, empty, 31-byte and 255-byte names: replaced byte for byte, empty
 *    names stay empty.
 * 3. Idempotent; the output re-parses strictly with the same structure; `isCacheRedacted`
 *    tells the two apart.
 * 4. Input that does not parse strictly throws `WalkError`.
 * 5. The post-check (`verifyCacheRedaction`) throws `CacheRedactionError` on tampered output,
 *    and its messages carry no name text.
 * 6. `nameSpans` is absent unless asked for: the committed FM3 walk re-encoded parses back to
 *    the fixture byte for byte; with the option every span points at its name's bytes.
 * 7. Id rules of `isUserNameTable` / `userNameTableKind`.
 * 8. The committed FM3 fw 12.0 and AM4 walks, re-encoded: the expected tables and counts,
 *    factory tables and ordinary records untouched.
 *
 * Synthetic data and committed walk fixtures only; no output prints a name.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCacheRecords,
  WalkError,
  redactCacheUserNames,
  verifyCacheRedaction,
  isCacheRedacted,
  isUserNameTable,
  userNameTableKind,
  CacheRedactionError,
  REDACTION_VERSION,
  REDACTION_FILLER,
} from '../../src/cache/index.js';
import type { CacheWalk, EnumRecord } from '../../src/cache/index.js';
import { encodeWalk, header, nameBytes, pushEnum, pushFloat, pushSection, pushTable } from './cacheBytes.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const REDACT_CASE_COUNT = 8;

const fail = (msg: string): never => {
  throw new Error(`[cache/redact] ${msg}`);
};

// Synthetic user names (asserted to never appear in an error message).
const PRESETS = ['My Clean', 'Crunch Lead', '', 'Ambient Pad'];
const USER_IRS = ['', 'MY IR', 'Other IR 2x12'];
const SCRATCH = ['SCRATCH ONE'];
const RESERVED = ['RES A'];
const ALL_USER_NAMES = [...PRESETS, ...USER_IRS, ...SCRATCH, ...RESERVED].filter((n) => n !== '');

/** A cache with every kind of table; returns the bytes. */
function mixedCache(): Uint8Array {
  const a = header({ major: 13, minor: 0, sectionCount: 3 });
  pushSection(a, 1, 3);
  pushFloat(a, 0);
  pushEnum(a, 1, ['ON', 'OFF']);
  pushEnum(a, 0xffff, PRESETS, 0, 0);
  pushSection(a, 11, 7);
  pushTable(a, 0xfff0, ['FACTORY A', 'FACTORY B'], [1, 2]);
  pushTable(a, 0xfff1, ['FACTORY C'], [3]);
  pushTable(a, 0xfff2, ['LEGACY A'], [4]);
  pushTable(a, 0xfff3, USER_IRS, [7, 8, 9]);
  pushTable(a, 0xfff4, SCRATCH, [10]);
  pushTable(a, 0xfff5, ['', ''], [0xff, 0xff]); // unused bank: all names empty
  pushFloat(a, 3, 2, 0, 0, -12, 12, 0);
  pushSection(a, 200, 3);
  pushEnum(a, 0xff10, RESERVED);
  pushEnum(a, 5, ['A', 'B'], 7);
  pushFloat(a, 6, 200, 0, 0, 0, 10, 5);
  return new Uint8Array(a);
}

/** Sum of the byte lengths of the given names. */
const byteLen = (names: readonly string[]) => names.reduce((s, n) => s + nameBytes(n).length, 0);

/** Offsets of every user-name byte (non-empty names of user tables), from a spans walk. */
function userNameOffsets(buf: Uint8Array): Set<number> {
  const s = new Set<number>();
  for (const r of parseCacheRecords(buf, { nameSpans: true }).records) {
    if (r.kind !== 'enum' || !isUserNameTable(r.id)) continue;
    for (const [o, L] of r.nameSpans!) for (let k = o; k < o + L; k++) s.add(k);
  }
  return s;
}

/** Strict walk with nameSpans stripped (the shape a plain walk has). */
const plainWalk = (buf: Uint8Array): CacheWalk => parseCacheRecords(buf);

/**
 * Assert: `out` re-parses with the same structure as `inp`; every user name is the filler
 * repeated for the name's byte length (or empty); every other record is JSON-identical.
 */
function assertSameStructure(inp: Uint8Array, out: Uint8Array, label: string): void {
  const a = parseCacheRecords(inp, { nameSpans: true });
  const b = parseCacheRecords(out, { nameSpans: true });
  if (JSON.stringify(a.sections) !== JSON.stringify(b.sections)) fail(`${label}: sections differ`);
  if (a.records.length !== b.records.length) fail(`${label}: record count ${a.records.length} -> ${b.records.length}`);
  for (let i = 0; i < a.records.length; i++) {
    const ra = a.records[i]!;
    const rb = b.records[i]!;
    if (ra.kind === 'enum' && isUserNameTable(ra.id)) {
      const eb = rb as EnumRecord;
      if (
        rb.kind !== 'enum' || eb.count !== ra.count || JSON.stringify(eb.wireIds) !== JSON.stringify(ra.wireIds) ||
        JSON.stringify(eb.nameSpans) !== JSON.stringify(ra.nameSpans)
      ) {
        fail(`${label}: user table id=0x${ra.id.toString(16)} changed shape`);
      }
      for (let k = 0; k < ra.values.length; k++) {
        if (eb.values[k] !== '_'.repeat(ra.nameSpans![k]![1])) fail(`${label}: user table id=0x${ra.id.toString(16)} entry ${k} not blank`);
      }
      continue;
    }
    if (JSON.stringify(ra) !== JSON.stringify(rb)) fail(`${label}: record ${i} id=0x${ra.id.toString(16)} changed`);
  }
}

export function runRedact(): void {
  // ---- Case 1: mixed synthetic cache ---------------------------------------
  {
    const inp = mixedCache();
    const before = inp.slice();
    const res = redactCacheUserNames(inp);
    const out = res.bytes;
    if (out === inp || out.buffer === inp.buffer) fail('redaction must work on a copy');
    if (inp.some((b, i) => b !== before[i])) fail('input buffer was modified');
    if (out.length !== inp.length) fail(`size ${inp.length} -> ${out.length}`);

    const presetNames = PRESETS.filter((n) => n !== '').length;
    const userCabNames = [...USER_IRS, ...SCRATCH].filter((n) => n !== '').length;
    const want = { presetNames, userCabNames, reservedNames: 1 };
    if (JSON.stringify(res.byTable) !== JSON.stringify(want)) fail(`byTable ${JSON.stringify(res.byTable)}`);
    // tables: 0xffff, 0xfff3, 0xfff4, 0xfff5 (unused bank), 0xff10
    if (res.tables !== 5 || res.names !== presetNames + userCabNames + 1) fail(`tables=${res.tables} names=${res.names}`);
    const bytes = byteLen(ALL_USER_NAMES);
    if (
      res.redaction.version !== REDACTION_VERSION || res.redaction.tables !== res.tables ||
      res.redaction.names !== res.names || res.redaction.bytesReplaced !== bytes
    ) {
      fail(`redaction summary ${JSON.stringify(res.redaction)}`);
    }

    // exactly the user name bytes differ, and each became the filler
    const allowed = userNameOffsets(inp);
    let changed = 0;
    for (let i = 0; i < inp.length; i++) {
      if (inp[i] === out[i]) continue;
      changed++;
      if (!allowed.has(i)) fail(`byte 0x${i.toString(16)} changed outside a user name`);
      if (out[i] !== REDACTION_FILLER) fail(`byte 0x${i.toString(16)} is not the filler`);
    }
    if (changed !== bytes || allowed.size !== bytes) fail(`changed ${changed} bytes, expected ${bytes}`);

    // factory / legacy tables byte-equal (values and wire ids)
    const wa = plainWalk(inp);
    const wb = plainWalk(out);
    for (const id of [0xfff0, 0xfff1, 0xfff2]) {
      const ra = wa.records.find((r) => r.id === id);
      const rb = wb.records.find((r) => r.id === id);
      if (!ra || JSON.stringify(ra) !== JSON.stringify(rb)) fail(`factory table 0x${id.toString(16)} changed`);
    }
    assertSameStructure(inp, out, 'mixed');
  }
  console.log('  cache/redact: only user name bytes change (to "_"), factory tables, wire ids, size and offsets stay');

  // ---- Case 2: UTF-8, empty, 31- and 255-byte names ------------------------
  {
    const utf = 'Sätt über'; // 2-byte sequences
    const long31 = 'L'.repeat(31);
    const long255 = 'M'.repeat(255);
    const truncated = [0x41, 0xc3]; // a lead byte without its continuation
    const a = header({ major: 13, sectionCount: 2 });
    pushSection(a, 1, 1);
    pushEnum(a, 0xffff, [utf, '', long31, truncated, long255], 0, 0);
    pushSection(a, 11, 1);
    pushTable(a, 0xfff3, ['', 'Å IR', ''], [1, 2, 3]);
    const inp = new Uint8Array(a);
    const res = redactCacheUserNames(inp);
    const w = plainWalk(res.bytes);
    const names = (w.records[0] as EnumRecord).values;
    const want = [
      '_'.repeat(nameBytes(utf).length),
      '',
      '_'.repeat(31),
      '__',
      '_'.repeat(255),
    ];
    if (JSON.stringify(names) !== JSON.stringify(want)) fail('preset names not blanked byte for byte');
    if (nameBytes(utf).length === utf.length) fail('test setup: the UTF-8 name must have multi-byte characters');
    const cab = (w.records[1] as EnumRecord).values;
    if (JSON.stringify(cab) !== JSON.stringify(['', '_'.repeat(nameBytes('Å IR').length), ''])) fail('user cab names not blanked');
    if (res.names !== 5 || res.byTable.presetNames !== 4 || res.byTable.userCabNames !== 1) fail(`counts ${JSON.stringify(res.byTable)}`);
    const wantBytes = nameBytes(utf).length + 31 + 2 + 255 + nameBytes('Å IR').length;
    if (res.redaction.bytesReplaced !== wantBytes) fail(`bytesReplaced ${res.redaction.bytesReplaced} != ${wantBytes}`);
    assertSameStructure(inp, res.bytes, 'utf8');
  }
  console.log('  cache/redact: UTF-8 (incl. malformed), empty, 31- and 255-byte names are blanked byte for byte');

  // ---- Case 3: idempotent, strict re-parse, isCacheRedacted ----------------
  {
    const inp = mixedCache();
    const r1 = redactCacheUserNames(inp);
    const r2 = redactCacheUserNames(r1.bytes);
    if (r2.bytes.length !== r1.bytes.length || r2.bytes.some((b, i) => b !== r1.bytes[i])) fail('second redaction changed bytes');
    if (JSON.stringify(r2.redaction) !== JSON.stringify(r1.redaction) || JSON.stringify(r2.byTable) !== JSON.stringify(r1.byTable)) {
      fail('second redaction reported different counts');
    }
    assertSameStructure(r1.bytes, r2.bytes, 'idempotent');
    if (isCacheRedacted(inp)) fail('original reported as redacted');
    if (!isCacheRedacted(r1.bytes)) fail('redacted copy not reported as redacted');
    verifyCacheRedaction(inp, r1.bytes);
    verifyCacheRedaction(r1.bytes, r2.bytes);
    // A cache with no user tables: nothing to do, still a valid (unchanged) copy.
    const b = header({ sectionCount: 1 });
    pushSection(b, 1, 2);
    pushFloat(b, 0);
    pushTable(b, 0xfff0, ['FACTORY A'], [1]);
    const plain = new Uint8Array(b);
    const r3 = redactCacheUserNames(plain);
    if (r3.tables !== 0 || r3.names !== 0 || r3.bytes.some((x, i) => x !== plain[i])) fail('cache without user tables changed');
    if (!isCacheRedacted(plain)) fail('a cache without user tables is trivially redacted');
  }
  console.log('  cache/redact: idempotent; output re-parses strictly with the same structure');

  // ---- Case 4: non-cache input throws WalkError ----------------------------
  {
    const full = mixedCache();
    const damagedPad = full.slice();
    damagedPad[0x2e + 8 + 4] = 1; // first record's pad
    const trailing = new Uint8Array([...full, 0, 0, 0]);
    const inputs: Array<[string, Uint8Array]> = [
      ['empty', new Uint8Array(0)],
      ['all 0xff', new Uint8Array(400).fill(0xff)],
      ['header only', new Uint8Array(header({ sectionCount: 1 }))],
      ['truncated', full.subarray(0, full.length - 5)],
      ['damaged record', damagedPad],
      ['trailing bytes', trailing],
    ];
    for (const [label, buf] of inputs) {
      let threw: unknown = null;
      try {
        redactCacheUserNames(buf);
      } catch (e) {
        threw = e;
      }
      if (!(threw instanceof WalkError)) fail(`${label}: expected WalkError, got ${threw === null ? 'no error' : String(threw).split('\n')[0]}`);
      // isCacheRedacted refuses the same input
      let threw2 = false;
      try {
        isCacheRedacted(buf);
      } catch (e) {
        threw2 = e instanceof WalkError;
      }
      if (!threw2) fail(`${label}: isCacheRedacted must throw WalkError`);
    }
  }
  console.log('  cache/redact: input that does not parse strictly is refused (WalkError)');

  // ---- Case 5: the post-check catches tampering ----------------------------
  {
    const inp = mixedCache();
    const good = redactCacheUserNames(inp).bytes;
    const spans = parseCacheRecords(inp, { nameSpans: true });
    const rec = (id: number) => spans.records.find((r) => r.id === id) as EnumRecord;
    const factory = rec(0xfff0);
    const user = rec(0xfff3);
    const presets = rec(0xffff);
    const ordinary = spans.records.find((r) => r.id === 6)!;

    const tamper = (label: string, mutate: (b: Uint8Array) => Uint8Array, reason: RegExp): void => {
      const t = mutate(good.slice());
      let err: unknown = null;
      try {
        verifyCacheRedaction(inp, t);
      } catch (e) {
        err = e;
      }
      if (!(err instanceof CacheRedactionError)) fail(`${label}: expected CacheRedactionError, got ${err === null ? 'none' : String(err).split('\n')[0]}`);
      const e = err as CacheRedactionError;
      if (!reason.test(e.reason)) fail(`${label}: reason ${e.reason}`);
      if (ALL_USER_NAMES.some((n) => e.message.includes(n))) fail(`${label}: error message quotes a name`);
    };
    tamper('factory name byte', (b) => { b[factory.nameSpans![0]![0]] ^= 1; return b; }, /^BYTE-CHANGED/);
    tamper('user name left', (b) => {
      const [o, L] = user.nameSpans![1]!;
      b.set(inp.subarray(o, o + L), o);
      return b;
    }, /^NAME-NOT-BLANK/);
    tamper('one preset byte left', (b) => { const [o] = presets.nameSpans![0]!; b[o] = inp[o]!; return b; }, /^NAME-NOT-BLANK/);
    tamper('wire id', (b) => {
      const [o, L] = user.nameSpans![user.nameSpans!.length - 1]!;
      b[o + L + 2 + 4] ^= 1; // u16 0, u32 count, then the first wire id
      return b;
    }, /^WIRE-IDS/);
    tamper('float field', (b) => { b[ordinary.offset + 10] ^= 1; return b; }, /^BYTE-CHANGED/);
    tamper('size', (b) => b.subarray(0, b.length - 1), /^SIZE/);
    tamper('name length', (b) => {
      const [o] = presets.nameSpans![0]!;
      b[o - 4] -= 1; // shorten the first preset name: the rest of the record no longer lines up
      return b;
    }, /^(REPARSE|NAME-SPANS|ENUM|RECORD|SECTION|BYTE-CHANGED)/);
    const label = rec(1); // ordinary enum ['ON', 'OFF']
    tamper('filler in an ordinary label', (b) => { b[label.nameSpans![0]![0]] = REDACTION_FILLER; return b; }, /^BYTE-CHANGED/);

    // a non-cache ORIGINAL is the caller's input problem: WalkError
    let walkErr = false;
    try {
      verifyCacheRedaction(new Uint8Array(10), good);
    } catch (e) {
      walkErr = e instanceof WalkError;
    }
    if (!walkErr) fail('a non-cache original must throw WalkError');
  }
  console.log('  cache/redact: the post-check throws on tampered output (bytes, names, wire ids, size, structure)');

  // ---- Case 6: nameSpans only when asked -----------------------------------
  const fm3Text = readFileSync(join(FIXTURES, 'fm3-12p0.walk.json'), 'utf8');
  const fm3Walk = JSON.parse(fm3Text) as CacheWalk;
  const fm3Bytes = encodeWalk(fm3Walk, header({ major: 12, minor: 0, sectionCount: fm3Walk.sections.length }));
  {
    const plain = parseCacheRecords(fm3Bytes);
    if (JSON.stringify(plain) !== JSON.stringify(JSON.parse(fm3Text))) fail('re-encoded FM3 walk does not parse back to the fixture');
    if (JSON.stringify(plain).includes('nameSpans')) fail('nameSpans present without the option');
    const tol = parseCacheRecords(fm3Bytes, { tolerant: true });
    if (JSON.stringify(tol).includes('nameSpans')) fail('nameSpans present in a tolerant walk without the option');

    const spans = parseCacheRecords(fm3Bytes, { nameSpans: true });
    let checked = 0;
    for (const r of spans.records) {
      if (r.kind !== 'enum') continue;
      const s = r.nameSpans;
      if (!s || s.length !== r.count) fail(`record id=0x${r.id.toString(16)}: ${s?.length} spans for ${r.count} names`);
      for (let k = 0; k < s!.length; k++) {
        const [o, L] = s![k]!;
        const got = String.fromCharCode(...fm3Bytes.subarray(o, o + L));
        if (got !== r.values[k]) fail(`record id=0x${r.id.toString(16)} span ${k} does not cover its name`);
        const lenAt = new DataView(fm3Bytes.buffer, fm3Bytes.byteOffset).getUint32(o - 4, true);
        if (lenAt !== L) fail(`record id=0x${r.id.toString(16)} span ${k} length`);
        checked++;
      }
      delete (r as { nameSpans?: unknown }).nameSpans;
    }
    if (JSON.stringify(spans) !== JSON.stringify(plain)) fail('a nameSpans walk differs from the plain walk beyond the spans');
    if (checked < 1000) fail(`only ${checked} spans checked`);
  }
  console.log('  cache/redact: nameSpans absent unless asked (re-encoded FM3 walk equals the fixture); spans cover their names');

  // ---- Case 7: id rules ----------------------------------------------------
  {
    const cases: Array<[number, string | null]> = [
      [0xffff, 'presetNames'],
      [0xfff3, 'userCabNames'],
      [0xfff4, 'userCabNames'],
      [0xfffe, 'userCabNames'],
      [0xfff0, null],
      [0xfff1, null],
      [0xfff2, null],
      [0xff00, 'reservedNames'],
      [0xffef, 'reservedNames'],
      [0xfeff, null],
      [0, null],
      [5, null],
      [0x10000, null],
      [-1, null],
      [0xffff + 0.5, null],
    ];
    for (const [id, kind] of cases) {
      if (userNameTableKind(id) !== kind) fail(`userNameTableKind(0x${id.toString(16)}) = ${userNameTableKind(id)}`);
      if (isUserNameTable(id) !== (kind !== null)) fail(`isUserNameTable(0x${id.toString(16)})`);
    }
  }
  console.log('  cache/redact: id rules (0xffff presets, 0xfff3..0xfffe user banks, 0xff00..0xffef unknown; factory 0xfff0..2 kept)');

  // ---- Case 8: committed walks, re-encoded --------------------------------
  {
    const check = (label: string, bytes: Uint8Array, want: { tables: number; presetNames: number; userCabNames: number }, factoryIds: number[]) => {
      const res = redactCacheUserNames(bytes);
      if (
        res.tables !== want.tables || res.byTable.presetNames !== want.presetNames ||
        res.byTable.userCabNames !== want.userCabNames || res.byTable.reservedNames !== 0 ||
        res.names !== want.presetNames + want.userCabNames
      ) {
        fail(`${label}: tables=${res.tables} byTable=${JSON.stringify(res.byTable)}`);
      }
      if (res.bytes.length !== bytes.length) fail(`${label}: size changed`);
      assertSameStructure(bytes, res.bytes, label);
      const before = plainWalk(bytes);
      const after = plainWalk(res.bytes);
      for (const id of factoryIds) {
        const a = before.records.find((r) => r.id === id);
        const b = after.records.find((r) => r.id === id);
        if (!a || JSON.stringify(a) !== JSON.stringify(b)) fail(`${label}: factory table 0x${id.toString(16)} changed`);
      }
      // (the original's state is not asserted: it depends on the fixture's content)
      if (!isCacheRedacted(res.bytes)) fail(`${label}: redacted copy not reported as redacted`);
      verifyCacheRedaction(bytes, res.bytes);
      return res;
    };
    const fm3 = check('FM3 12.0', fm3Bytes, { tables: 2, presetNames: 512, userCabNames: 512 }, [0xfff0, 0xfff1, 0xfff2]);
    const am4Walk = JSON.parse(readFileSync(join(FIXTURES, 'am4-66p1.walk.json'), 'utf8')) as CacheWalk;
    const am4Bytes = encodeWalk(am4Walk, header({ major: 66, minor: 1, sectionCount: am4Walk.sections.length }));
    check('AM4 66.1', am4Bytes, { tables: 1, presetNames: 104, userCabNames: 0 }, [0xfff0]);
    console.log(`  cache/redact: committed FM3 walk -> ${fm3.tables} tables, ${fm3.names} names; AM4 walk -> preset names only`);
  }
}
