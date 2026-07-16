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

export interface FloatRecord extends RecordBase {
  kind: 'float';
  t1: number;
  t2: number;
}

export type CacheRecord = EnumRecord | FloatRecord;

export interface CacheWalk {
  sections: Section[];
  records: CacheRecord[];
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
 * `min`/`max` multiplied by `scale`; placeholder (unused) wire slots carry an
 * all-zero float row.
 */
export interface RangeDef {
  kind: 'enum' | 'float';
  displayMin: number;
  displayMax: number;
  scale: number;
  step: number;
  typecode: number;
  enumCount?: number;
}

/** Per-family cache section tag + fn=0x1F channel-block wire stride. */
export interface RangeSectionMeta {
  sectionTag: number;
  /** Ordinary records only (id < 0xff00). */
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
