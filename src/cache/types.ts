// Types for the Fractal editor `effectDefinitions_*.cache` byte-walker.
//
// These mirror the on-disk section/record grammar (solved 2026-06-09):
// a cache is a preamble followed by count-driven sections, each carrying an
// exact record count; records are either enum (a count-prefixed list of
// length-prefixed ASCII values) or float (a fixed 32-byte record).

export interface Section {
  index: number;
  count: number;
  offset: number;
  records: number;
}

export interface RecordBase {
  kind: 'enum' | 'float';
  section: number;
  offset: number;
  id: number;
  tc: number;
  min: number;
  max: number;
  def: number;
  step: number;
  /**
   * Device-true unit token parsed from the self-describe formatted value
   * (view 0x00), e.g. 'Hz' | 'ms' | 'dB' | '%' | 'ct'. Present only when the
   * live walk read values (`readValues`) and the display carried a plausible
   * unit; absent for enum/label params and for byte-source (`.cache`) walks.
   * This is device-true, unlike the AM4-name-overlay `unit` on the catalogs.
   */
  unit?: string;
}

export interface EnumRecord extends RecordBase {
  kind: 'enum';
  count: number;
  values: string[];
  x: number;
  wireIds?: number[];
}

/**
 * Knob-taper classification recovered by a FULL-mode live walk (a normalized
 * SET sweep read back through the device's own formatted-value view, then
 * curve-fit).
 *   - `shape` — 'linear'/'log'/'custom' are the reliable fits; 'flat' means the
 *     display never moved (block not instantiated / param inert — carries NO
 *     taper info) and 'unknown' means too few numeric samples. Both are
 *     `reliable: false`.
 *   - `err` — the winning fit's max relative error (null when unknown).
 *   - `points` — the swept `[normalized 0..1, display value]` samples that
 *     survived numeric parsing (drives the analytic-inverse restore + the
 *     'custom' taperPoints on the derived RangeDef).
 */
export interface FloatTaper {
  shape: 'linear' | 'log' | 'flat' | 'custom' | 'unknown';
  err: number | null;
  reliable: boolean;
  points: ReadonlyArray<readonly [number, number]>;
}

export interface FloatRecord extends RecordBase {
  kind: 'float';
  t1: number;
  t2: number;
  /**
   * Knob taper from a FULL-mode live-walk sweep. Present only for float params
   * swept in `mode: 'full'`; absent for read-only / byte-source (`.cache`)
   * walks. Only a `reliable` taper is threaded into the derived `RangeDef`.
   */
  taper?: FloatTaper;
  /**
   * Live walk only: an inner EMPTY slot — the device answered with an empty-slot definition, and a
   * later real definition placed it inside the parameter table. The all-zero row the editor cache
   * carries for the same slot. `buildDeviceCache` counts it as a slot only in table-shaped
   * sections; in a sparse id space (system data) an unanswered-for id is a gap, not a slot.
   */
  placeholder?: boolean;
}

export type CacheRecord = EnumRecord | FloatRecord;

/**
 * One stretch a TOLERANT cache walk could not parse and skipped (see
 * `parseCacheRecords(buf, { tolerant: true })`).
 */
export interface CacheWalkIssue {
  /** Section tag the damage was in (`null` for a damaged section header / trailing bytes). */
  section: number | null;
  /** 0-based record index within that section, when the damage was inside a record. */
  record: number | null;
  /** Byte offset of the violation. */
  offset: number;
  /** Short violation reason (e.g. `BAD-PAD id=0x5 tc=0x64 pad=0x1`). */
  reason: string;
  /** Good records of the damaged section that were dropped with it (the section is all or nothing). */
  droppedRecords: number;
  /** Bytes skipped from the damaged record/header to where the walk resumed (or to EOF). */
  skippedBytes: number;
  /** Offset of the section header the walk resumed at, or `null` when it stopped. */
  resumedAt: number | null;
}

export interface CacheWalk {
  sections: Section[];
  records: CacheRecord[];
  /** Tolerant walks only: every skipped stretch (empty when the cache parsed cleanly). */
  issues?: CacheWalkIssue[];
}

// ---------------------------------------------------------------------------
// Section→family assignment / device-build (see ./assign.ts)
// ---------------------------------------------------------------------------

/**
 * One row of a device's param catalog, as consumed by the section→family
 * voter. Structurally a subset of the gen-3 `Param` shape (family/paramId/
 * name/unit/displayMin/displayMax) so the shipped `FM3_PARAMS` etc. pass in
 * directly. `unit === 'enum'` marks catalog-enum params; `displayMin`/
 * `displayMax` (when present) let the voter reward range agreement.
 */
export interface DeviceParam {
  family: string;
  paramId: number;
  name: string;
  unit?: string;
  displayMin?: number;
  displayMax?: number;
}

/**
 * Device-true display range for one (family, paramId), mirroring the shipped
 * `Fm3ParamRange` shape (kind + display bounds + scale/step + raw typecode,
 * plus `enumCount` on enum-kind rows). `displayMin`/`displayMax` are the cache
 * `min`/`max` multiplied by `scale`, except typecode-0x52 float rows (dimensionless
 * knobs), which are shown on a linear 0..10 scale: they derive displayMin 0,
 * displayMax 10 and `taper: 'linear'` whatever their definition's min/max are (and
 * `display = value * scale` does not hold for them). Such a row carries no `unit`, and a
 * row whose walk observed a unit or a non-linear taper is not derived this way at all.
 * AM4/VP4 enum bounds are raw ordinals and use the pass-through scale (0).
 * Placeholder (unused) wire slots carry an all-zero float row.
 */
export interface RangeDef {
  kind: 'enum' | 'float';
  displayMin: number;
  displayMax: number;
  scale: number;
  step: number;
  typecode: number;
  enumCount?: number;
  /** Device-true unit token from the live-walk (view 0x00), e.g. 'Hz'|'ms'|'dB'.
   * Consumers show it verbatim next to the value, so it is only ever a token the
   * device itself displayed: present only when the walk read values and a unit came
   * back; absent for byte-source/`.cache` walks, enum params and dimensionless knobs.
   * Consumers should prefer this over the AM4-name-overlay unit. */
  unit?: string;
  /** Device-true value taper: from a FULL-mode live-walk sweep (reliable fits
   * only) 'linear'|'log' emitted bare, 'custom' also carries `taperPoints`; typecode-0x52
   * knob rows (see `KNOB_TYPECODE`) also get 'linear' by rule when no sweep measured one.
   * ('flat' is in the union for schema uniformity with the shipped catalogs but
   * is never emitted here — a flat sweep is unreliable.) Absent otherwise (read-only
   * walks, byte-source walks, unreliable sweeps on ordinary rows).
   * Same naming/shape as the generated catalog range fields. */
  taper?: 'linear' | 'log' | 'flat' | 'custom';
  /** Sample points `[normalized 0..1, display value]` for a 'custom' taper only,
   * mirroring the generated catalog `taperPoints`. */
  taperPoints?: ReadonlyArray<readonly [number, number]>;
}

/** Per-family cache section tag + fn=0x1F channel-block wire stride. */
export interface RangeSectionMeta {
  sectionTag: number;
  /**
   * Parameter slots of the section: ordinary records (id < 0xff00) INCLUDING the all-zero
   * placeholder slots — the fn=0x1F channel-block wire stride. Exact from the editor cache. From a
   * live walk it is exact for table-shaped sections — including a table that ends in unused slots
   * when the device answers past the table's end with a no-payload reply (FM3 fw 13.0: DELAY 89,
   * VOLUME 15) — unless the walk reported `missingSlots`, or the section ends in unused slots on a
   * device whose table end answers like an empty slot; it is then a lower bound. Live placeholder rows count
   * only where the section's records fill at least a quarter of their id span, so the id gaps of a
   * sparse system section walked in full are not slots. A sparse section walked only in part can
   * still look table-shaped and count its gaps (FM3 fw 12.0 GLOBAL in the read-only 0..127 window:
   * 127 incl. 33 gap rows, vs 186 from the cache) — treat live strides of system sections as
   * informational. Never let a live-derived stride shrink a known one.
   */
  stride: number;
  /** Declared cache section record count, INCLUDING special table records. */
  recordCount: number;
  /** Byte-identical instance sections for this family (e.g. Input 1..N). */
  instanceTags?: number[];
}

/** One device model entry: ordinal value + display name (+ optional lineage). */
export interface TypeModel {
  value: number;
  name: string;
  manufacturer: string | null;
  basedOn: string | null;
}

/**
 * Everything `buildDeviceCache` derives from a decoded cache + param catalog.
 * Shapes mirror the shipped gen-3 tables so a `cache:check` gate can compare
 * field-for-field:
 *   - `enumOverrides` -> `FM3_ENUM_OVERRIDES` (family -> paramId(string) -> labels)
 *   - `ranges`        -> `FM3_RANGES`         (family -> paramId(number) -> RangeDef)
 *   - `rangeSections` -> `FM3_RANGE_SECTIONS` (family -> section meta)
 *   - `cabIrs`        -> `FM3_CAB_IRS`        (bank -> IR names)
 *   - `rosters` is a convenience projection (family -> model list) derived from
 *     each family's model/type selector paramId.
 */
export interface BuiltCacheData {
  enumOverrides: Record<string, Record<string, string[]>>;
  ranges: Record<string, Record<number, RangeDef>>;
  rangeSections: Record<string, RangeSectionMeta>;
  rosters: Record<string, TypeModel[]>;
  cabIrs: Record<string, string[]>;
  /** Cache sections with no confident family match (system/telemetry blocks). */
  unmappedSections: { sectionTag: number; recordCount: number; wireStride: number }[];
  /** Catalog families that received no section (no confident cache match). */
  unmappedFamilies: string[];
}
