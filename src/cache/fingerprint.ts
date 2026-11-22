/**
 * Row predicates, parameter fingerprint and section-assignment cross-check.
 *
 * Pure and browser-safe: no `node:*`, no `Buffer`, no `node:crypto` (the hash is a
 * plain FNV-1a over the UTF-8 bytes of a canonical string). Everything here reads the
 * `RangeDef` rows and enum label lists that `buildCache` produces and that the shipped
 * catalogs carry, so a runtime can compare a device-built profile against the bundled
 * catalog row by row.
 *
 *   - Row predicates (`isPlaceholderRow`, `isInformativeRow`, `enumOrdinalBounds`,
 *     `BYPASS_TYPECODE`): which catalog rows describe a real, editable parameter.
 *   - Fingerprint (`paramFingerprint`, `labelsHash`): a short, stable identity of a row's
 *     shape (kind, typecode, display bounds, step, enum count, label list). It absorbs f32
 *     noise between differently derived tables and leaves out everything that differs
 *     between byte-built and live-built rows without identifying the parameter (unit,
 *     taper, scale, default).
 *   - Compatibility (`rowsCompatible`): "same parameter, revised in place?".
 *   - Cross-check (`familyAssignmentSuspects`): flags families whose profile rows match
 *     another family's reference rows clearly better than their own, i.e. a section that
 *     was assigned to the wrong family.
 *
 * Nothing in this module is persisted: fingerprints are computed at read time, so no
 * `CACHE_SCHEMA` change is involved.
 */
import type { RangeDef } from './types.js';

// ---------------------------------------------------------------------------
// Row predicates
// ---------------------------------------------------------------------------

/**
 * Typecode of bypass parameters. No other parameter on the gen-3 catalogs uses it, so a
 * row carrying it is the block's bypass control rather than an ordinary parameter.
 */
export const BYPASS_TYPECODE = 0xe0;

/**
 * All-zero slot: the editor cache's unused wire slot. Corresponds to `isPlaceholder` in
 * `assign.ts`, expressed on the derived `RangeDef` (a different predicate that agrees on
 * the shipped data).
 */
export function isPlaceholderRow(r: Pick<RangeDef, 'kind' | 'displayMin' | 'displayMax' | 'scale'>): boolean {
  return r.kind === 'float' && r.displayMin === 0 && r.displayMax === 0 && r.scale === 0;
}

/**
 * Carries an editable span (`displayMax > displayMin`). Excludes placeholders, degenerate
 * rows (e.g. `DISTORT_VERSION`) and the 0..0 typecode-0xF0 action rows.
 */
export function isInformativeRow(r: Pick<RangeDef, 'displayMin' | 'displayMax'>): boolean {
  return r.displayMax > r.displayMin;
}

/**
 * Ordinal (wire) bounds of an enum row. The display bounds of an enum are scaled
 * (`PHASER_ORDER`: scale 2, 0..10, six labels), so the ordinals are recovered by
 * dividing the scale back out: `s = scale > 0 ? scale : 1`, `lo = round(displayMin / s)`,
 * and `hi = lo + enumCount - 1` when the row carries a count, else `round(displayMax / s)`.
 *
 * Examples: `PHASER_ORDER` gives 0..5, `DELAY_SVFTYPE` gives 1..3, `CABINET_MODE`
 * (scale 0) gives 0..1.
 */
export function enumOrdinalBounds(
  r: Pick<RangeDef, 'scale' | 'displayMin' | 'displayMax' | 'enumCount'>,
): { lo: number; hi: number } {
  const s = r.scale > 0 ? r.scale : 1;
  const lo = Math.round(r.displayMin / s);
  const hi = r.enumCount != null ? lo + r.enumCount - 1 : Math.round(r.displayMax / s);
  return { lo, hi };
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/** Version of the canonical string below. Bump together with any change to it. */
export const FINGERPRINT_VERSION = 1;

const utf8 = new TextEncoder();

/** FNV-1a 32-bit over the UTF-8 bytes of `s`, as 8 lowercase hex digits. */
function fnv1a32Hex(s: string): string {
  const bytes = utf8.encode(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Hash of an ordered label list: FNV-1a 32 (hex) of the UTF-8 bytes of
 * `labels.map(trimEnd).join('\u0001')`. Order matters; trailing whitespace of a
 * label does not.
 */
export function labelsHash(labels: readonly string[]): string {
  return fnv1a32Hex(labels.map((l) => l.trimEnd()).join('\u0001'));
}

/**
 * Number text of the canonical string: six significant digits (absorbs the f32 noise
 * between the generator and `buildCache`), `-0` written as `0`, non-finite as `NaN`.
 */
function num(x: number): string {
  if (!Number.isFinite(x)) return 'NaN';
  const n = Number(x.toPrecision(6));
  return n === 0 ? '0' : String(n);
}

/**
 * Fingerprint of a row: `"<version>:<fnv1a32 hex>"` over the canonical string
 *
 *   `kind|typecode|displayMin|displayMax|step|enumCount|labelsHash`
 *
 * where the step is only present on floats (enum steps are noise), the count only on
 * enums, and the label hash only when a non-empty label list is given. Unit, taper,
 * scale and default are left out: they differ between byte and live sources and do not
 * identify the parameter (`displayMin`/`displayMax` already contain the scale).
 */
export function paramFingerprint(
  row: Pick<RangeDef, 'kind' | 'typecode' | 'displayMin' | 'displayMax' | 'step' | 'enumCount'>,
  labels?: readonly string[],
): string {
  const canonical = [
    row.kind,
    String(row.typecode),
    num(row.displayMin),
    num(row.displayMax),
    row.kind === 'float' ? num(row.step) : '',
    row.kind === 'enum' ? (row.enumCount ?? '') : '',
    labels && labels.length > 0 ? labelsHash(labels) : '',
  ].join('|');
  return `${FINGERPRINT_VERSION}:${fnv1a32Hex(canonical)}`;
}

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

/**
 * Same parameter, revised in place?
 *
 *   - Different kinds: never.
 *   - Enums: when either label list is empty, yes. Otherwise count the positions
 *     `i < min(len)` where the labels differ (trailing whitespace of a label is ignored,
 *     as in `labelsHash`, so rows with equal fingerprints are always compatible);
 *     compatible iff that is at most `max(1, floor(min(len) / 4))` (an appended or removed
 *     tail, or a few renames).
 *   - Floats: the unit-class nibble of the typecode (`(typecode >> 4) & 0xf`) is the same
 *     and the display spans overlap.
 */
export function rowsCompatible(
  a: Pick<RangeDef, 'kind' | 'typecode' | 'displayMin' | 'displayMax'>,
  la: readonly string[] | undefined,
  b: Pick<RangeDef, 'kind' | 'typecode' | 'displayMin' | 'displayMax'>,
  lb: readonly string[] | undefined,
): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'enum') {
    if (!la || !lb || la.length === 0 || lb.length === 0) return true;
    const n = Math.min(la.length, lb.length);
    let diff = 0;
    for (let i = 0; i < n; i++) if (la[i].trimEnd() !== lb[i].trimEnd()) diff++;
    return diff <= Math.max(1, Math.floor(n / 4));
  }
  return (
    ((a.typecode >> 4) & 0xf) === ((b.typecode >> 4) & 0xf) &&
    a.displayMin <= b.displayMax &&
    b.displayMin <= a.displayMax
  );
}

// ---------------------------------------------------------------------------
// Assignment cross-check
// ---------------------------------------------------------------------------

/**
 * The two tables the cross-check reads per device: `ranges` (family -> pid -> row) and
 * `enumOverrides` (family -> pid -> label list). Read-only on purpose, so the shipped
 * catalog constants (`FM3_RANGES`, `FM3_ENUM_OVERRIDES`, ...) and a `BuiltCacheData` are
 * both accepted as they are.
 */
export type FamilyTables = {
  readonly ranges: Readonly<Record<string, Readonly<Record<number, RangeDef>>>>;
  readonly enumOverrides: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
};

/** pid -> fingerprint of every informative row of `family`. */
function informativeFingerprints(t: FamilyTables, family: string): Map<number, string> {
  const out = new Map<number, string>();
  const rows = t.ranges[family];
  if (!rows) return out;
  const labelsOf = t.enumOverrides[family];
  for (const key of Object.keys(rows)) {
    const pid = Number(key);
    const row = rows[pid];
    if (!isInformativeRow(row)) continue;
    out.set(pid, paramFingerprint(row, labelsOf?.[String(pid)]));
  }
  return out;
}

/** Fraction of `own` rows whose fingerprint is equal at the same pid in `other`. */
function exactShare(own: ReadonlyMap<number, string>, other: ReadonlyMap<number, string>): number {
  if (own.size === 0) return 0;
  let hit = 0;
  for (const [pid, fp] of own) if (other.get(pid) === fp) hit++;
  return hit / own.size;
}

/**
 * Families whose profile rows match ANOTHER family's reference rows clearly better than
 * their own: a section that was assigned to the wrong family (two families swapped, or
 * one taking over another's section).
 *
 * `exactShare(P_F, R_G)` is the share of the informative rows of the profile family `F`
 * for which the reference family `G` has an informative row at the same pid with an equal
 * fingerprint. `F` is a suspect iff
 *   - `F` has at least `minRows` informative profile rows (default 4),
 *   - `F` is a family of the reference, and
 *   - some other reference family `G` reaches `best = exactShare(P_F, R_G) >= floor`
 *     (default 0.5) and `best >= exactShare(P_F, R_F) + margin` (default 0.25).
 *
 * The result is sorted by family name.
 */
export function familyAssignmentSuspects(
  profile: FamilyTables,
  reference: FamilyTables,
  opts?: { minRows?: number; floor?: number; margin?: number },
): string[] {
  const minRows = opts?.minRows ?? 4;
  const floor = opts?.floor ?? 0.5;
  const margin = opts?.margin ?? 0.25;

  const refFamilies = Object.keys(reference.ranges);
  const refFps = new Map<string, Map<number, string>>();
  for (const g of refFamilies) refFps.set(g, informativeFingerprints(reference, g));

  const suspects: string[] = [];
  for (const f of Object.keys(profile.ranges)) {
    const own = informativeFingerprints(profile, f);
    if (own.size < minRows) continue;
    const ownRef = refFps.get(f);
    if (!ownRef) continue;
    const ownShare = exactShare(own, ownRef);
    let best = 0;
    for (const g of refFamilies) {
      if (g === f) continue;
      const share = exactShare(own, refFps.get(g)!);
      if (share > best) best = share;
    }
    if (best >= floor && best >= ownShare + margin) suspects.push(f);
  }
  return suspects.sort();
}
