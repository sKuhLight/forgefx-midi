/**
 * Cache special tables — the `>= 0xFF00` records a parameter walk cannot see.
 *
 * A cache carries two kinds of special record: the preset-name table (`0xFFFF`, the last record
 * of its section) and the cab/IR bank tables (`0xFFF0..0xFFFE`, the last records of the cabinet
 * section, each with a parallel `u32` array). A live definition walk cannot address either one, so
 * a profile built without them is short by 1 / N records in the carrying section and has empty
 * `cabIrs`. These cases pin the record shapes, the merge position, the privacy split (profile-safe
 * vs local-only) and the byte-walker parity.
 */
import {
  assertNoUserTables,
  buildDeviceCache,
  CACHE_CAB_BANK_SECTION,
  CACHE_PRESET_NAME_SECTION,
  cabBankTableRecord,
  isCabBankTableId,
  mergeSpecialTables,
  mergeSpecialTablesLocal,
  PRESET_NAME_TABLE_ID,
  presetNameTableRecord,
  specialTableRecords,
  userTableIds,
} from '../../src/cache/index.js';
import type { PresetNameTable, CabBankTable, ProfileRaw, RawSource, SpecialTables } from '../../src/cache/index.js';
import type { CacheRecord, DeviceParam } from '../../src/cache/types.js';
import { header, pushRecord, pushSection } from './cacheBytes.js';

export const SPECIAL_TABLES_CASE_COUNT = 8;

const fail = (msg: string): never => {
  throw new Error(`[cache/special-tables] ${msg}`);
};

const ordinaryFloat = (section: number, id: number): CacheRecord => ({
  kind: 'float',
  section,
  offset: 0,
  id,
  tc: 2,
  min: 0,
  max: 10,
  def: 1,
  step: 0,
  t1: 0,
  t2: 0,
});

/** A minimal profile source carrying `records` (the shape `assertNoUserTables` inspects). */
function sourceOf(records: CacheRecord[]): RawSource {
  return {
    id: 'live-readonly@unknown#0',
    kind: 'live-readonly',
    origin: 'local',
    capturedAt: null,
    firmware: '12.0',
    codecVersion: '0.0.0',
    space: 'block',
    scope: { blocks: [1], maxParamId: 127, bounds: {}, extended: false, above160: false, hinted: false },
    walk: { queries: 0, lostReplies: 0, recoveredReplies: 0, unresolvedReplies: 0, placeholderSlots: 0, missingSlots: 0, silentAddresses: 0, boundHits: [] },
    records: records.map((r) => {
      if (r.kind === 'enum') {
        const { offset: _o, nameSpans: _s, ...rest } = r;
        return rest;
      }
      const { offset: _o, ...rest } = r;
      return rest;
    }),
  } as RawSource;
}

export async function runSpecialTables(): Promise<void> {
  // ---- Case 1: the record shapes the cache grammar expects --------------------------------
  {
    const preset = presetNameTableRecord({ section: 1, names: ['59 Bassguy   ', '<EMPTY>'] });
    if (preset.kind !== 'enum' || preset.id !== 0xffff || preset.section !== 1 || preset.tc !== 0 || preset.count !== 2) fail(`preset table head ${JSON.stringify({ ...preset, values: undefined })}`);
    if (preset.min !== 0 || preset.max !== 0 || preset.def !== 0 || preset.step !== 0 || preset.x !== 0 || preset.wireIds !== undefined) fail('preset table numeric body must be all zero and it carries no wire ids');
    if (preset.values.join('|') !== '59 Bassguy   |<EMPTY>') fail('preset names must be copied verbatim (padding and <EMPTY> included)');
    const bank = cabBankTableRecord({ section: 11, id: 0xfff0, names: ['1x4 Pig 57', '<EMPTY>'], wireIds: [255, 1] });
    if (bank.kind !== 'enum' || bank.id !== 0xfff0 || bank.tc !== 0 || bank.count !== 2 || bank.wireIds?.join(',') !== '255,1') fail(`cab table ${JSON.stringify(bank)}`);
    if (!isCabBankTableId(0xfff0) || !isCabBankTableId(0xfffe) || isCabBankTableId(0xffef) || isCabBankTableId(0xffff)) fail('cab table id range');
  }
  console.log('  cache/special-tables: record shapes — 0xFFFF plain enum (all-zero body), 0xFFF0.. enum with the parallel wire-id array, names verbatim');

  // ---- Case 2: the merge position — last in its section, ascending id ---------------------
  {
    const records = [ordinaryFloat(11, 0), ordinaryFloat(11, 1), ordinaryFloat(2, 0)];
    const tables: SpecialTables = {
      presetNames: { section: 1, names: ['A'] },
      cabBanks: [
        { section: 11, id: 0xfff1, names: ['F2'], wireIds: [1] },
        { section: 11, id: 0xfff0, names: ['F1'], wireIds: [1] },
      ],
    };
    const merged = mergeSpecialTablesLocal(records, tables);
    const ids = merged.filter((r) => r.section === 11).map((r) => r.id.toString(16));
    if (ids.join(',') !== '0,1,fff0,fff1') fail(`section 11 order ${ids.join(',')}`);
    // The input order is untouched; section 2 stays where it was.
    if (records.length !== 3 || merged.filter((r) => r.section === 2).length !== 1) fail('merge modified its input or moved another section');
    // A section with no ordinary record is appended at the end.
    if (merged[merged.length - 1]!.section !== 1 || merged[merged.length - 1]!.id !== 0xffff) fail(`a new section must be appended: ${merged.map((r) => `${r.section}:${r.id}`).join(',')}`);
    // Empty names, a mismatched wire-id array and a duplicate table are refused.
    for (const bad of [
      () => presetNameTableRecord({ section: 1, names: [] }),
      () => cabBankTableRecord({ section: 11, id: 0xfff0, names: ['a', 'b'], wireIds: [1] }),
      () => cabBankTableRecord({ section: 11, id: 0xffef, names: ['a'], wireIds: [1] }),
      () => specialTableRecords({ cabBanks: [{ section: 11, id: 0xfff0, names: ['a'], wireIds: [1] }, { section: 11, id: 0xfff0, names: ['b'], wireIds: [1] }] }),
    ]) {
      let threw = false;
      try {
        bad();
      } catch {
        threw = true;
      }
      if (!threw) fail('an invalid special table was accepted');
    }
  }
  console.log('  cache/special-tables: merge — specials land last in their section in ascending id (0xFFF0 before 0xFFF1), a missing section is appended; invalid tables are refused');

  // ---- Case 3: the privacy split — profile-safe omits user tables, local keeps them --------
  {
    const records = [ordinaryFloat(1, 0), ordinaryFloat(11, 0)];
    const tables: SpecialTables = {
      presetNames: { section: 1, names: ['my preset'] },
      cabBanks: [
        { section: 11, id: 0xfff0, names: ['Factory A'], wireIds: [1] },
        { section: 11, id: 0xfff2, names: ['Legacy A'], wireIds: [1] },
        { section: 11, id: 0xfff3, names: ['My IR'], wireIds: [255] },
      ],
    };
    const safe = mergeSpecialTables(records, tables);
    const safeIds = safe.map((r) => r.id);
    if (safeIds.includes(0xffff) || safeIds.includes(0xfff3)) fail(`profile-safe merge kept a user table: ${safeIds.map((i) => i.toString(16)).join(',')}`);
    if (!safeIds.includes(0xfff0) || !safeIds.includes(0xfff2)) fail('profile-safe merge dropped a firmware bank');
    assertNoUserTables({ raw: { format: 1, sources: [sourceOf(safe)] } as ProfileRaw });
    const local = mergeSpecialTablesLocal(records, tables);
    if (!local.map((r) => r.id).includes(0xffff) || !local.map((r) => r.id).includes(0xfff3)) fail('local merge must keep every table');
    let threw = false;
    try {
      assertNoUserTables({ raw: { format: 1, sources: [sourceOf(local)] } as ProfileRaw });
    } catch {
      threw = true;
    }
    if (!threw) fail('assertNoUserTables accepted a local merge');
    const ids = userTableIds(tables).sort((a, b) => a - b);
    if (ids.join(',') !== `${0xfff3},${0xffff}`) fail(`user table ids ${ids.map((i) => i.toString(16)).join(',')}`);
  }
  console.log('  cache/special-tables: privacy — mergeSpecialTables keeps 0xFFF0..0xFFF2 and drops 0xFFFF / 0xFFF3+ (assertNoUserTables accepts it); the local merge keeps all and is rejected by the guard');

  // ---- Case 4: the derived tables a rebuild gains -----------------------------------------
  {
    const params: DeviceParam[] = [{ family: 'CABINET', paramId: 0, name: 'CABINET_TYPE', displayMin: 0, displayMax: 10 }];
    const bank: CabBankTable = { section: CACHE_CAB_BANK_SECTION, id: 0xfff0, names: ['1x4 Pig 57', 'TOTALLY-FLAT'], wireIds: [255, 255] };
    const preset: PresetNameTable = { section: CACHE_PRESET_NAME_SECTION, names: ['P1', '<EMPTY>'] };
    const plain = [ordinaryFloat(CACHE_CAB_BANK_SECTION, 0)];
    const bare = buildDeviceCache(plain, params, { CABINET: CACHE_CAB_BANK_SECTION });
    const rebuilt = buildDeviceCache(mergeSpecialTables(plain, { presetNames: preset, cabBanks: [bank] }), params, { CABINET: CACHE_CAB_BANK_SECTION });
    if (bare.cabIrs['FACTORY 1'] !== undefined) fail('without the specials cabIrs must be empty');
    if (rebuilt.cabIrs['FACTORY 1']?.join(',') !== '1x4 Pig 57,TOTALLY-FLAT') fail(`cabIrs ${JSON.stringify(rebuilt.cabIrs)}`);
    const bareCount = bare.rangeSections['CABINET']?.recordCount;
    const rebuiltCount = rebuilt.rangeSections['CABINET']?.recordCount;
    if (bareCount !== 1 || rebuiltCount !== 2) fail(`recordCount ${bareCount} -> ${rebuiltCount} (want 1 -> 2: ordinary + one cab table)`);
    // The preset table belongs to section 1; the profile-safe merge keeps it out, so section 1
    // does not appear as an unmapped section at all when it had no ordinary record.
    if (rebuilt.unmappedSections.some((s) => s.sectionTag === CACHE_PRESET_NAME_SECTION)) fail('the profile-safe merge leaked the preset-name section');
  }
  console.log('  cache/special-tables: a merge adds the FACTORY 1 names to cabIrs and the carrying section\'s recordCount (1 -> 2); the profile-safe merge leaves the preset table out');

  // ---- Case 5: byte-walker parity ---------------------------------------------------------
  {
    const records = [ordinaryFloat(11, 0), ordinaryFloat(11, 1)];
    const merged = mergeSpecialTablesLocal(records, {
      presetNames: { section: 1, names: ['A preset', '<EMPTY>'] },
      cabBanks: [{ section: 11, id: 0xfff0, names: ['IR one', 'IR two'], wireIds: [1, 255] }],
    });
    const bytes: number[] = [...header({ sectionCount: 2 })];
    const bySection = new Map<number, CacheRecord[]>();
    for (const r of merged) {
      const list = bySection.get(r.section);
      if (list) list.push(r);
      else bySection.set(r.section, [r]);
    }
    for (const [tag, list] of bySection) {
      pushSection(bytes, tag, list.length);
      for (const r of list) pushRecord(bytes, r);
    }
    // Re-walk the encoded cache and compare the record identity fields.
    const { parseCacheRecords } = await import('../../src/cache/records.js');
    const walk = parseCacheRecords(Uint8Array.from(bytes));
    const got = walk.records.map((r) => `${r.section}:${r.id}:${r.kind}:${r.tc}:${r.count ?? ''}:${r.kind === 'enum' ? (r.wireIds ?? []).join('') : ''}`).join('|');
    const want = merged.map((r) => `${r.section}:${r.id}:${r.kind}:${r.tc}:${r.count ?? ''}:${r.kind === 'enum' ? (r.wireIds ?? []).join('') : ''}`).join('|');
    if (got !== want) fail(`byte-walker parity:\n  got  ${got}\n  want ${want}`);
    const table = walk.records.find((r) => r.id === 0xfff0);
    if (!table || table.kind !== 'enum' || table.values.join(',') !== 'IR one,IR two' || table.wireIds?.join(',') !== '1,255') fail('the cab table did not survive the byte walk');
  }
  console.log('  cache/special-tables: byte-walker parity — the merged records re-encode to a cache the byte walker reads back identically (names and wire ids included)');

  // ---- Case 6: an unused bank with all-empty names is still a table ----------------------
  {
    // The grammar accepts an all-empty name list only for a cab table whose wire-id array has
    // exactly one id per name (an unused bank); the builder must write that tail.
    const bank = cabBankTableRecord({ section: 11, id: 0xfff1, names: ['', '', ''], wireIds: [255, 255, 255] });
    const bytes: number[] = [...header({ sectionCount: 1 })];
    pushSection(bytes, 11, 1);
    pushRecord(bytes, bank);
    const { parseCacheRecords } = await import('../../src/cache/records.js');
    const walk = parseCacheRecords(Uint8Array.from(bytes));
    const rec = walk.records[0];
    if (!rec || rec.kind !== 'enum' || rec.id !== 0xfff1 || rec.values.length !== 3 || rec.wireIds?.length !== 3) fail(`unused bank round-trip ${JSON.stringify(rec)}`);
  }
  console.log('  cache/special-tables: an unused cab bank (all names empty, one wire id per name) survives the byte walk as an enum table');

  // ---- Case 7: section constants and the id classification --------------------------------
  {
    if (CACHE_PRESET_NAME_SECTION !== 1 || CACHE_CAB_BANK_SECTION !== 11) fail('the documented carrying sections changed');
    if (PRESET_NAME_TABLE_ID !== 0xffff) fail('the preset-table id changed');
    for (const id of [0xfff0, 0xfff1, 0xfff2]) if (!isCabBankTableId(id)) fail(`0x${id.toString(16)} must be a cab bank id`);
    for (const id of [0xffef, 0xffff, 0x10000, 0xfff0 + 0.5]) if (isCabBankTableId(id)) fail(`0x${id.toString(16)} must not be a cab bank id`);
  }
  console.log('  cache/special-tables: 0xFFFF in section 1, 0xFFF0..0xFFFE in section 11; the id range is integer-only and excludes 0xFFFF');

  // ---- Case 8: a table with no live read stays unknown, never invented -------------------
  {
    // The gen-3 cab record layout is undecoded: the reader returns raw bytes only, so there is
    // no API here that fabricates names from them. The only supported inputs are decoded names.
    const { readCabBankRecords } = await import('../../src/cache/index.js');
    void readCabBankRecords; // type-level: the reader is the only gen-3 cab path, and its result is raw bytes
    // A caller that has no names must not build a table; an empty input is refused.
    let threw = false;
    try {
      cabBankTableRecord({ section: 11, id: 0xfff0, names: [], wireIds: [] });
    } catch {
      threw = true;
    }
    if (!threw) fail('an empty cab bank must be refused (the grammar needs at least one name)');
    // Firmware banks are not user tables; the user-bank guard keys on the id, not the content.
    const merged = mergeSpecialTables([], { cabBanks: [{ section: 11, id: 0xfff2, names: ['Legacy'], wireIds: [1] }] });
    if (merged.length !== 1) fail('a firmware bank must survive the profile-safe merge');
  }
  console.log('  cache/special-tables: an undecoded table cannot be invented — an empty/unknown bank is refused or reported raw, and only decoded names become a record');
}
