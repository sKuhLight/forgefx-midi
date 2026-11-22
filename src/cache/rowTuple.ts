/**
 * Canonical row tuples and section signatures over raw definition records.
 *
 * A tuple identifies a parameter definition independently of the space it was read in (an
 * editor-cache section or a live block address) and of what a live walk can get wrong or
 * leave out: the record kind and the labels are excluded (a live walk without enum hints may
 * read an enum with a non-zero default as a float; labels may be missing), and so are the unit
 * and the taper. Numbers are written with the M2 fingerprint's canonical number text.
 *
 *   tuple     = `${tc}|${num(min)}|${num(max)}|${num(def)}|${num(step)}|${kind === 'enum' ? count : ''}`
 *   signature = `"1:" + fnv1a32(sorted "pid:tuple" list joined with ",")`
 *
 * Only ordinary (id < 0xff00), non-placeholder records take part.
 *
 * Pure and browser-safe.
 */
import { canonicalNumber as num, fnv1a32Hex } from './fingerprint.js';
import type { CacheRecord } from './types.js';

/** Version of the signature text below; part of every signature. */
export const SECTION_SIGNATURE_VERSION = 1;

/** The record fields a tuple reads. */
export type TupleRecord = Pick<CacheRecord, 'kind' | 'id' | 'tc' | 'min' | 'max' | 'def' | 'step'> & {
  count?: number;
  placeholder?: boolean;
};

/**
 * All-zero unused slot (float with min, max and default 0), or a live walk's flagged placeholder.
 * Same predicate as the section voter's (`assign.ts`).
 */
export function isPlaceholderRecord(r: TupleRecord): boolean {
  return r.placeholder === true || (r.kind === 'float' && r.min === 0 && r.max === 0 && r.def === 0);
}

/** Canonical tuple of one record (see the module comment). */
export function rowTuple(r: TupleRecord): string {
  return `${r.tc}|${num(r.min)}|${num(r.max)}|${num(r.def)}|${num(r.step)}|${r.kind === 'enum' ? (r.count ?? '') : ''}`;
}

/**
 * pid -> canonical tuple of the ordinary, non-placeholder records of ONE section (or block);
 * the first record per pid wins, as in the section voter.
 */
export function sectionSignatureRows(records: readonly TupleRecord[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const r of records) {
    if (r.id >= 0xff00 || out.has(r.id) || isPlaceholderRecord(r)) continue;
    out.set(r.id, rowTuple(r));
  }
  return out;
}

/** Signature of a pid -> tuple map: `"1:" + fnv1a32` over the ascending `pid:tuple` list. */
export function rowsSignature(rows: ReadonlyMap<number, string>): string {
  const parts = [...rows.keys()].sort((a, b) => a - b).map((pid) => `${pid}:${rows.get(pid)}`);
  return `${SECTION_SIGNATURE_VERSION}:${fnv1a32Hex(parts.join(','))}`;
}
