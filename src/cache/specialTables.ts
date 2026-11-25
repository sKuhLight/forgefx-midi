/**
 * The two kinds of cache record a parameter walk cannot see — the special tables with ids
 * `>= 0xFF00` — and how live reads of them merge back into a record list.
 *
 * Cache grammar (identical on gen-3 and AM4/VP4):
 *
 *   - `0xFFFF` — the preset-name table: one plain enum record, `count` names, tail `u32 x, u16 0`.
 *     It is the LAST record of its section (section 1 in every cache seen).
 *   - `0xFFF0..0xFFFE` — the cab/IR bank tables: enum records with typecode 0 and an all-zero
 *     numeric body, a name list, then the table tail `u16 0, u32 idCount, idCount × u32`
 *     (the parallel wire-id array). They are the LAST records of the CABINET section (11 in
 *     every cache seen), ascending by id. `0xFFF0..0xFFF2` are firmware content (FACTORY 1 /
 *     FACTORY 2 / LEGACY); `0xFFF3+` are the unit's own user/scratchpad IR banks.
 *
 * Merging matters because a live definition walk cannot address either table: without them a
 * profile's `recordCount` for the carrying sections is short by 1 (preset names) or N (cab
 * banks), and `cabIrs` is empty. With the live reads of ./gen3WalkReplies.ts (gen-3 preset names;
 * raw cab records, layout undecoded) and ./../am4/specialTables.js (AM4 preset and cab names)
 * plus these builders, a cache file is rebuildable from the device alone — except where a live
 * read is not decoded (the gen-3 cab record layout), which must be reported as unknown and never
 * guessed.
 *
 * PRIVACY. The preset-name table and the user cab banks are the unit owner's own names. Two
 * functions make the distinction explicit:
 *
 *   - `mergeSpecialTables` is the PROFILE path: it filters the special tables IT inserts and drops
 *     every `isUserNameTable` record (`0xFFFF`, `0xFFF3..0xFFFE`, and any unknown table in
 *     `0xFF00..0xFFEF`), so its output can be persisted, shared or uploaded; `assertNoUserTables`
 *     accepts it. User-name records already present in the input are NOT removed here — that guard
 *     is the caller's (`assertNoUserTables`), so the merge cannot silently launder an input that
 *     already carries one.
 *   - `mergeSpecialTablesLocal` keeps every table and is ONLY for a cache file that stays on the
 *     machine that read it. Never persist, export or upload its output. (A cache file that does
 *     leave the machine must be passed through `redactCacheUserNames` first.)
 *
 * Pure and browser-safe — no `node:*`, no `Buffer`.
 */
import { isUserNameTable } from './redact.js';
import type { CacheRecord, EnumRecord } from './types.js';

/** Record id of the preset-name table. */
export const PRESET_NAME_TABLE_ID = 0xffff;
/** Lowest cab/IR bank table id. */
export const CAB_BANK_TABLE_ID_MIN = 0xfff0;
/** Highest cab/IR bank table id the cache grammar defines. */
export const CAB_BANK_TABLE_ID_MAX = 0xfffe;
/**
 * Cache section that carries the preset-name table (`0xFFFF`) in every cache seen. This is
 * a cache-section tag, not a live block address: a live walk keys its records by block id, so a
 * byte rebuild maps blocks to section tags first.
 */
export const CACHE_PRESET_NAME_SECTION = 1;
/** Cache section that carries the cab/IR bank tables in every cache seen. */
export const CACHE_CAB_BANK_SECTION = 11;

/** True for a cab/IR bank table id (`0xFFF0..0xFFFE`). */
export function isCabBankTableId(id: number): boolean {
  return Number.isInteger(id) && id >= CAB_BANK_TABLE_ID_MIN && id <= CAB_BANK_TABLE_ID_MAX;
}

/** A `0xFFFF` preset-name table read from the device. */
export interface PresetNameTable {
  /** Cache section that carries the table (see `CACHE_PRESET_NAME_SECTION`). */
  section: number;
  /** One name per preset slot, in slot order. Copied verbatim: `<EMPTY>` and any padding included. */
  names: readonly string[];
}

/** A `0xFFF0..0xFFFE` cab/IR bank table read from the device. */
export interface CabBankTable {
  /** Cache section that carries the table (see `CACHE_CAB_BANK_SECTION`). */
  section: number;
  /** Table record id (`0xFFF0..0xFFFE`). */
  id: number;
  /** One IR name per slot, in slot order, copied verbatim. */
  names: readonly string[];
  /** The parallel `u32` array: exactly one word per name (the device's per-slot attribute). */
  wireIds: readonly number[];
}

/** Live special-table reads, ready to merge. */
export interface SpecialTables {
  presetNames?: PresetNameTable;
  cabBanks?: readonly CabBankTable[];
}

/** The enum record a `0xFFFF` preset-name table becomes. */
export function presetNameTableRecord(table: PresetNameTable): EnumRecord {
  if (!Array.isArray(table.names) || table.names.length === 0) throw new Error('special tables: a preset-name table needs at least one name');
  return {
    kind: 'enum',
    section: table.section,
    offset: 0,
    id: PRESET_NAME_TABLE_ID,
    tc: 0,
    min: 0,
    max: 0,
    def: 0,
    step: 0,
    count: table.names.length,
    values: [...table.names],
    x: 0,
  };
}

/** The enum record (with `wireIds`) a `0xFFF0..0xFFFE` cab/IR bank table becomes. */
export function cabBankTableRecord(table: CabBankTable): EnumRecord {
  if (!isCabBankTableId(table.id)) throw new Error(`special tables: 0x${table.id.toString(16)} is not a cab/IR bank table id`);
  if (!Array.isArray(table.names) || table.names.length === 0) throw new Error('special tables: a cab/IR bank table needs at least one name');
  if (!Array.isArray(table.wireIds) || table.wireIds.length !== table.names.length) {
    throw new Error('special tables: the wire-id array must carry exactly one word per name');
  }
  for (const w of table.wireIds) if (!Number.isInteger(w) || w < 0 || w > 0xffffffff) throw new Error(`special tables: wire id ${String(w)} is not a u32`);
  return {
    kind: 'enum',
    section: table.section,
    offset: 0,
    id: table.id,
    tc: 0,
    min: 0,
    max: 0,
    def: 0,
    step: 0,
    count: table.names.length,
    values: [...table.names],
    x: 0,
    wireIds: [...table.wireIds],
  };
}

/**
 * Every special-table record of `tables`, ascending by (section, id). Throws on a duplicate id in
 * one section: a cache carries each table once.
 */
export function specialTableRecords(tables: SpecialTables): EnumRecord[] {
  const out: EnumRecord[] = [];
  if (tables.presetNames !== undefined) out.push(presetNameTableRecord(tables.presetNames));
  for (const bank of tables.cabBanks ?? []) out.push(cabBankTableRecord(bank));
  out.sort((a, b) => a.section - b.section || a.id - b.id);
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.section === out[i - 1]!.section && out[i]!.id === out[i - 1]!.id) {
      throw new Error(`special tables: two tables for section ${out[i]!.section} id 0x${out[i]!.id.toString(16)}`);
    }
  }
  return out;
}

/**
 * Insert the special records after the ordinary records of their section (the position the cache
 * grammar gives them: the LAST records of the section), in ascending id. A table whose section has
 * no ordinary record is appended at the end of the list.
 */
function mergeInto(records: readonly CacheRecord[], specials: readonly EnumRecord[]): CacheRecord[] {
  const out = [...records];
  for (const rec of specials) {
    let insertAt = out.length;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i]!.section === rec.section) {
        insertAt = i + 1;
        break;
      }
    }
    out.splice(insertAt, 0, rec);
  }
  return out;
}

/**
 * PROFILE-SAFE merge: the special tables minus every user name table (`isUserNameTable`:
 * `0xFFFF`, the user banks `0xFFF3..0xFFFE`, and any unknown `0xFF00..0xFFEF` record). The
 * firmware banks `0xFFF0..0xFFF2` stay. The result can be persisted, shared or uploaded;
 * `assertNoUserTables` accepts it. Use this for a profile document.
 */
export function mergeSpecialTables(records: readonly CacheRecord[], tables: SpecialTables): CacheRecord[] {
  return mergeInto(records, specialTableRecords(tables).filter((r) => !isUserNameTable(r.id)));
}

/**
 * LOCAL-ONLY merge: keeps EVERY special table, the preset names and the user cab banks included.
 * Its output is a local cache image and must never be persisted, exported or uploaded — such a
 * file must go through `redactCacheUserNames` first. For a profile document use
 * `mergeSpecialTables`.
 */
export function mergeSpecialTablesLocal(records: readonly CacheRecord[], tables: SpecialTables): CacheRecord[] {
  return mergeInto(records, specialTableRecords(tables));
}

/** Ids of the user name tables a `SpecialTables` input would add (empty when all are firmware content). */
export function userTableIds(tables: SpecialTables): number[] {
  return specialTableRecords(tables)
    .map((r) => r.id)
    .filter((id) => isUserNameTable(id));
}
