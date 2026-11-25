/**
 * User-name redaction for Fractal editor `effectDefinitions_*.cache` files.
 *
 * Next to the firmware's definitions, a cache an editor writes for a connected unit carries the
 * unit owner's own names, in special-id records (ordinary parameter records have ids below
 * 0xff00):
 *
 *   - id 0xffff         — the preset-name table (one entry per preset slot)
 *   - ids 0xfff3..0xfffe — user / scratchpad cab-IR banks: names plus a parallel wire-id array.
 *                          Units with larger user libraries carry more than one such bank.
 *
 * Ids 0xfff0..0xfff2 are the factory 1 / factory 2 / legacy cab-IR banks — firmware content,
 * kept as is. No cache seen has a record at 0xff00..0xffef; such a record is treated as a user
 * name table too, so an unknown special table is blanked rather than passed on.
 *
 * `redactCacheUserNames` replaces every byte of every non-empty name in those tables with `_`
 * (0x5f), on a copy. Name lengths, entry counts, wire ids and every other byte stay as they are,
 * so the file size, all offsets and the walk's structure are unchanged (the walk is
 * count-driven). Empty names stay empty. A mandatory post-check re-parses the output strictly
 * and throws `CacheRedactionError` on any difference outside the name bytes. Redacting a
 * redacted cache returns identical bytes and counts.
 *
 * Error messages carry offsets, ids and reasons only — never name bytes.
 *
 * Pure and browser-safe — no `node:*`, no `Buffer`.
 */
import { parseCacheRecords, WalkError } from './records.js';
import type { CacheWalk, EnumRecord } from './types.js';

/** Version of the redaction rules; recorded with every redacted copy. */
export const REDACTION_VERSION = 1;

/** The byte every name byte of a user name table is replaced with (`_`). */
export const REDACTION_FILLER = 0x5f;

/**
 * What a user name table holds: preset names (id 0xffff), user/scratchpad cab-IR names
 * (0xfff3..0xfffe), or an unknown special table (0xff00..0xffef, blanked to be safe).
 */
export type UserNameTableKind = 'presetNames' | 'userCabNames' | 'reservedNames';

/** The kind of user name table a record id holds, or `null` for every other id. */
export function userNameTableKind(id: number): UserNameTableKind | null {
  if (!Number.isInteger(id)) return null;
  if (id === 0xffff) return 'presetNames';
  if (id >= 0xfff3 && id <= 0xfffe) return 'userCabNames';
  if (id >= 0xff00 && id <= 0xffef) return 'reservedNames';
  return null;
}

/**
 * True when records with this id carry user-owned names (preset names, user/scratchpad cab-IR
 * names, or an unknown special table) — the tables `redactCacheUserNames` blanks.
 */
export function isUserNameTable(id: number): boolean {
  return userNameTableKind(id) !== null;
}

/** Counts that travel with a redacted copy. */
export interface CacheRedaction {
  /** `REDACTION_VERSION`. */
  version: number;
  /** User name tables walked (enum records with a user-name-table id, empty banks included). */
  tables: number;
  /** Non-empty names replaced. */
  names: number;
  /** Name bytes written with the filler (a name already all filler counts too). */
  bytesReplaced: number;
}

/** Result of `redactCacheUserNames`. */
export interface RedactCacheResult {
  /** The redacted copy: same size, same structure, user name bytes all `_`. */
  bytes: Uint8Array;
  /** = `redaction.tables`. */
  tables: number;
  /** = `redaction.names`. */
  names: number;
  /** Non-empty names replaced, per kind of table. */
  byTable: Record<UserNameTableKind, number>;
  redaction: CacheRedaction;
}

/** The redacted copy failed the post-check (or the inputs to `verifyCacheRedaction` differ). */
export class CacheRedactionError extends Error {
  /** Short reason, e.g. `NAME-NOT-BLANK id=0xffff`. */
  readonly reason: string;
  /** Byte offset of the difference, when there is one. */
  readonly offset: number | null;

  constructor(reason: string, offset: number | null = null) {
    super(`cache redaction check failed: ${reason}${offset === null ? '' : ` at 0x${offset.toString(16)}`}`);
    this.name = 'CacheRedactionError';
    this.reason = reason;
    this.offset = offset;
  }
}

const hex = (n: number) => '0x' + n.toString(16);

/** Strict walk with name spans; `WalkError` on input that is not a cache. */
function walkWithSpans(buf: Uint8Array): CacheWalk {
  return parseCacheRecords(buf, { nameSpans: true });
}

/** Enum records whose id is a user name table. */
function isUserTable(r: CacheWalk['records'][number]): r is EnumRecord {
  return r.kind === 'enum' && isUserNameTable(r.id);
}

/**
 * Replace every name byte of every user name table with `_` (see the module comment). Works on
 * a copy; `buf` is not modified. Throws `WalkError` when `buf` does not parse strictly as a
 * cache, and `CacheRedactionError` when the post-check fails.
 */
export function redactCacheUserNames(buf: Uint8Array): RedactCacheResult {
  const walk = walkWithSpans(buf);
  const out = buf.slice();
  const byTable: Record<UserNameTableKind, number> = { presetNames: 0, userCabNames: 0, reservedNames: 0 };
  let tables = 0;
  let names = 0;
  let bytesReplaced = 0;
  for (const r of walk.records) {
    if (!isUserTable(r)) continue;
    const kind = userNameTableKind(r.id)!;
    tables += 1;
    for (const [o, L] of r.nameSpans!) {
      if (L === 0) continue;
      out.fill(REDACTION_FILLER, o, o + L);
      names += 1;
      byTable[kind] += 1;
      bytesReplaced += L;
    }
  }
  checkRedaction(buf, walk, out);
  return {
    bytes: out,
    tables,
    names,
    byTable,
    redaction: { version: REDACTION_VERSION, tables, names, bytesReplaced },
  };
}

/**
 * The post-check, standalone: `redacted` must be `original` with only user name bytes replaced
 * by `_`. Same size; a strict re-parse gives the same sections and records (kinds, offsets,
 * ids, typecodes, counts, wire ids, name positions and lengths); every user name is empty or
 * all `_`; every byte outside the user name bytes is identical. Throws `WalkError` when
 * `original` is not a cache and `CacheRedactionError` on any other difference.
 */
export function verifyCacheRedaction(original: Uint8Array, redacted: Uint8Array): void {
  checkRedaction(original, walkWithSpans(original), redacted);
}

/**
 * True when every name in every user name table is empty or all `_` — a copy as
 * `redactCacheUserNames` returns it. Throws `WalkError` when `buf` does not parse strictly.
 */
export function isCacheRedacted(buf: Uint8Array): boolean {
  for (const r of walkWithSpans(buf).records) {
    if (!isUserTable(r)) continue;
    for (const [o, L] of r.nameSpans!) {
      for (let i = o; i < o + L; i++) if (buf[i] !== REDACTION_FILLER) return false;
    }
  }
  return true;
}

function checkRedaction(original: Uint8Array, ow: CacheWalk, redacted: Uint8Array): void {
  const fail = (reason: string, offset: number | null = null): never => {
    throw new CacheRedactionError(reason, offset);
  };
  if (redacted.length !== original.length) fail(`SIZE ${original.length} -> ${redacted.length}`);

  let rw: CacheWalk;
  try {
    rw = walkWithSpans(redacted);
  } catch (e) {
    // Re-raise without the walker's hex dump (it would quote the surrounding bytes).
    if (e instanceof WalkError) fail(`REPARSE ${e.reason}`, e.offset);
    throw e;
  }

  // Sections: same tags, declared counts, offsets and walked counts.
  if (rw!.sections.length !== ow.sections.length) fail(`SECTIONS ${ow.sections.length} -> ${rw!.sections.length}`);
  for (let i = 0; i < ow.sections.length; i++) {
    const a = ow.sections[i]!;
    const b = rw!.sections[i]!;
    if (a.index !== b.index || a.count !== b.count || a.offset !== b.offset || a.records !== b.records) {
      fail(`SECTION ${i} tag=${a.index}`, a.offset);
    }
  }

  // Records: same shape everywhere; user names empty or all filler. Floats are compared through
  // the byte check below (NaN-safe).
  if (rw!.records.length !== ow.records.length) fail(`RECORDS ${ow.records.length} -> ${rw!.records.length}`);
  const spans: Array<readonly [number, number]> = [];
  for (let i = 0; i < ow.records.length; i++) {
    const a = ow.records[i]!;
    const b = rw!.records[i]!;
    const where = `record ${i} id=${hex(a.id)}`;
    if (a.kind !== b.kind || a.section !== b.section || a.offset !== b.offset || a.id !== b.id || a.tc !== b.tc) {
      fail(`RECORD ${where}`, a.offset);
    }
    if (a.kind === 'float' || b.kind === 'float') {
      if (a.kind === 'float' && b.kind === 'float' && (a.t1 !== b.t1 || a.t2 !== b.t2)) fail(`FLOAT-TAIL ${where}`, a.offset);
      continue;
    }
    if (a.count !== b.count || a.x !== b.x) fail(`ENUM ${where}`, a.offset);
    const wa = a.wireIds ?? [];
    const wb = b.wireIds ?? [];
    if ((a.wireIds === undefined) !== (b.wireIds === undefined) || wa.length !== wb.length || wa.some((v, k) => v !== wb[k])) {
      fail(`WIRE-IDS ${where}`, a.offset);
    }
    const sa = a.nameSpans!;
    const sb = b.nameSpans!;
    if (sa.length !== sb.length || sa.some(([o, L], k) => o !== sb[k]![0] || L !== sb[k]![1])) fail(`NAME-SPANS ${where}`, a.offset);
    if (!isUserTable(a)) continue;
    for (const [o, L] of sb) {
      for (let k = o; k < o + L; k++) if (redacted[k] !== REDACTION_FILLER) fail(`NAME-NOT-BLANK ${where}`, k);
      if (L > 0) spans.push([o, L]);
    }
  }

  // Every byte outside the user name bytes is unchanged (spans are in ascending offset order).
  let pos = 0;
  const same = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (original[k] !== redacted[k]) fail('BYTE-CHANGED', k);
  };
  for (const [o, L] of spans) {
    same(pos, o);
    pos = o + L;
  }
  same(pos, original.length);
}
