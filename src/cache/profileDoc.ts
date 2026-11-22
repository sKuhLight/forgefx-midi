/**
 * Profile document v2: raw definition sources plus the tables derived from them.
 *
 * A v1 device profile (`BuiltCache`) holds derived tables only, so it cannot be re-derived when
 * the derivation rules improve: the records it was built from are gone. A v2 document keeps the
 * raw records of every source it was built from (editor-cache reads, live definition reads) and
 * treats the derived tables as a cache of `deriveProfile(raw, catalog)`:
 *
 *   - the derived tables stay top-level with the v1 shapes (`BuiltCacheData` + `meta`), so every
 *     v1 consumer keeps working; everything new is additive (`raw`, `sections`, `blockMap`,
 *     `provenance`, `coverage`, `meta.format/derivedWith/derivedAt/sources`);
 *   - every section of every source is kept (`sections`), including the ones no catalog family
 *     claims: their rows go into the tables under a synthetic family key, `section:<tag>` for an
 *     editor-cache section and `block:<eid>` for a live block address;
 *   - several sources merge per family with a fixed precedence (./merge.ts);
 *   - derivation is pure and deterministic: no clocks (`derivedAt` is caller-supplied), no I/O.
 *
 * Privacy: user content never enters a document. An editor-cache source leaves out exactly the
 * records the cache redaction blanks (`isUserNameTable`: preset names, user/scratchpad cab-IR
 * banks, reserved special tables) and records only how many it left out; live sources carry no
 * user content. `assertNoUserTables` guards every persist, export and import.
 *
 * Schema policy: see `CACHE_SCHEMA` (./buildProfile.ts). No schema bump for this format; the
 * synthetic family keys and the new fields are additive derived output.
 *
 * Pure and browser-safe — no `node:*`, no `Buffer`; the content hash uses `globalThis.crypto.subtle`
 * when the runtime has it.
 */
import { VERSION } from '../version.js';
import { formatFirmwareVersion } from '../shared/firmware.js';
import { buildDeviceCacheDetailed, rangeRowOf } from './assign.js';
import type { DeviceCacheDetail } from './assign.js';
import { CACHE_SCHEMA } from './buildProfile.js';
import type { BuiltCache, BuiltCacheWalkStats } from './buildProfile.js';
import { isInformativeRow } from './fingerprint.js';
import { CACHE_HEADER_BYTES, cacheHeaderVersion, headerMatchesWalk, parseCacheFileName, readCacheHeader } from './header.js';
import type { LiveWalkResult } from './liveWalk.js';
import { computeCoverage, mergeDerived, planSourceUnits } from './merge.js';
import type { ProfileCatalog, ProfileCoverage, ProfileProvenance, SourceUnitPlan } from './merge.js';
import { parseCacheRecords } from './records.js';
import { isUserNameTable, redactCacheUserNames } from './redact.js';
import { rowsSignature, sectionSignatureRows } from './rowTuple.js';
import type { BuiltCacheData, CacheRecord, CacheWalkIssue, DeviceParam, EnumRecord, FloatRecord, RangeDef, RangeSectionMeta } from './types.js';

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Document format: 2 = carries raw sources. An absent `meta.format` (or 1) is a v1 derived-only doc. */
export const PROFILE_FORMAT = 2;

/** Format of `ProfileRaw` (the raw record envelope). */
export const RAW_FORMAT = 1;

/**
 * Lowest codec version (`meta.derivedWith`) whose derived tables a consumer keeps without
 * re-deriving a format-2 document. Every format-2 document was derived by a codec that already
 * writes this format, so the floor is open for now; raise it to a released version when an
 * additive derivation change (one that needs no `CACHE_SCHEMA` bump) must reach stored documents.
 * Compare with `compareCodecVersions`. (Unreleased builds report the version in package.json,
 * which lags the release tags.)
 */
export const MIN_DERIVED_WITH = '0.0.0';

/**
 * Numeric comparison of two dotted codec versions (`'0.6.1'`): negative when `a` is older, 0 when
 * equal, positive when newer. Missing parts count as 0; a pre-release or build suffix is ignored.
 */
export function compareCodecVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/, 1)[0]!.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Raw sources
// ---------------------------------------------------------------------------

export type RawSourceKind = 'editor-cache' | 'live-readonly' | 'live-full' | 'live-probe';
/** Where the source came from: this installation, the cloud, or a definitions file import. */
export type SourceOrigin = 'local' | 'cloud' | 'file';
/** A walker record without its byte position (and without name spans). */
export type RawRecord = Omit<FloatRecord, 'offset'> | Omit<EnumRecord, 'offset' | 'nameSpans'>;

interface RawSourceBase {
  /** `${kind}@${capturedAt ?? 'unknown'}#${n}` (`rawSourceId`) — unique within the document. */
  id: string;
  kind: RawSourceKind;
  origin: SourceOrigin;
  capturedAt: string | null;
  /** Device firmware it was taken on (live) or matched to (editor cache). */
  firmware: string | null;
  /** Codec version that produced the records. */
  codecVersion: string;
  records: RawRecord[];
}

export interface EditorCacheRawSource extends RawSourceBase {
  kind: 'editor-cache';
  space: 'section';
  /**
   * Every section of the walk with the number of records it holds, user name tables included
   * (they are omitted from `records`). Equals the declared count of the section header, except
   * for a section a tolerant walk dropped (0).
   */
  sections: ReadonlyArray<{ tag: number; count: number }>;
  /** User name tables left out (`isUserNameTable`): `tables` = such enum tables, `records` = all records. */
  omitted: { tables: number; records: number };
  /** The cache header, when the buffer has the gen-3/AM4 header shape; `null` otherwise. */
  header: { major: number; minor: number; sectionCount: number } | null;
  /** Firmware the file name names (`effectDefinitions_<model>_<major>p<minor>.cache`), when given. */
  fileVersion: string | null;
  /** sha256 (hex) of the redacted file bytes, or `null` when unavailable. */
  contentSha256: string | null;
  /** Tolerant parse only: the stretches it skipped. */
  issues?: CacheWalkIssue[];
}

/** What a live source covered. */
export interface LiveSourceScope {
  /** Block addresses walked. */
  blocks: number[];
  /** Default highest param id queried. */
  maxParamId: number;
  /** Per-block hard ceiling (wins over `maxParamId`). */
  bounds: Record<number, number>;
  /** Per-block explicit id lists queried beyond the contiguous range. */
  idLists?: Record<number, number[]>;
  /** Ids above 127 in known contiguous tables were walked. */
  extended: boolean;
  /** Blocks above eid 160 were walked. */
  above160: boolean;
  /** Enum label hints were given. */
  hinted: boolean;
}

/** A block whose last real definition sat within a few ids of its hard bound. */
export interface WalkBoundHit {
  block: number;
  lastReal: number;
  bound: number;
}

export interface LiveRawSource extends RawSourceBase {
  kind: 'live-readonly' | 'live-full' | 'live-probe';
  space: 'block';
  scope: LiveSourceScope;
  walk: BuiltCacheWalkStats & {
    boundHits: WalkBoundHit[];
    extension?: 'done' | 'skipped' | 'aborted';
    abortReason?: string;
  };
}

export type RawSource = EditorCacheRawSource | LiveRawSource;

export interface ProfileRaw {
  format: 1;
  sources: RawSource[];
}

/** One line per raw source in `meta.sources` (same order as `raw.sources`). */
export interface SourceSummary {
  id: string;
  kind: RawSourceKind;
  origin: SourceOrigin;
  capturedAt: string | null;
  firmware: string | null;
  records: number;
}

/** Source id: `${kind}@${capturedAt ?? 'unknown'}#${n}`. */
export function rawSourceId(kind: RawSourceKind, capturedAt: string | null | undefined, n = 0): string {
  return `${kind}@${capturedAt ?? 'unknown'}#${n}`;
}

function stripRecord(r: CacheRecord): RawRecord {
  if (r.kind === 'enum') {
    const { offset: _offset, nameSpans: _spans, ...rest } = r;
    return rest;
  }
  const { offset: _offset, ...rest } = r;
  return rest;
}

/** A raw record back as a walker record (byte position 0), for the derivation. */
export function cacheRecordOf(r: RawRecord): CacheRecord {
  return { ...r, offset: 0 } as CacheRecord;
}

async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) return null;
  try {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const digest = new Uint8Array(await subtle.digest('SHA-256', copy.buffer));
    let hex = '';
    for (const b of digest) hex += b.toString(16).padStart(2, '0');
    return hex;
  } catch {
    return null;
  }
}

export interface RawFromCacheBytesOptions {
  /** File name the bytes came from (sets `fileVersion`; a directory part is ignored). */
  fileName?: string;
  /** Caller-supplied ISO stamp (never wall-clock here). */
  capturedAt?: string;
  origin?: SourceOrigin;
  /** Firmware the cache was matched to. Default: the file name's version, else the header's. */
  firmware?: string;
  /** Tolerant parse (see `parseCacheRecords`): damaged sections are dropped and listed in `issues`. */
  tolerant?: boolean;
  /** The `#n` of the source id (default 0). */
  seq?: number;
}

/**
 * Raw source from editor-cache bytes: a strict walk (tolerant on request), records without byte
 * positions, user name tables omitted (counted in `omitted`), per-section record counts, header
 * and file version, and the sha256 of the redacted bytes (`redactCacheUserNames`), `null` when the
 * runtime has no `crypto.subtle` or the bytes do not walk strictly. Async only for the hash.
 * Throws `WalkError` when a strict walk fails.
 */
export async function rawFromCacheBytes(buf: Uint8Array, opts: RawFromCacheBytesOptions = {}): Promise<EditorCacheRawSource> {
  const walk = parseCacheRecords(buf, { tolerant: opts.tolerant === true });
  const records: RawRecord[] = [];
  const omitted = { tables: 0, records: 0 };
  for (const r of walk.records) {
    if (isUserNameTable(r.id)) {
      omitted.records += 1;
      if (r.kind === 'enum') omitted.tables += 1;
      continue;
    }
    records.push(stripRecord(r));
  }
  const header =
    buf.length >= CACHE_HEADER_BYTES && walk.sections[0]?.offset === CACHE_HEADER_BYTES
      ? (({ major, minor, sectionCount }) => ({ major, minor, sectionCount }))(readCacheHeader(buf))
      : null;
  const name = opts.fileName !== undefined ? parseCacheFileName(opts.fileName) : null;
  const fileVersion = name ? formatFirmwareVersion(name.major, name.minor) : null;
  const firmware =
    opts.firmware ?? fileVersion ?? (header !== null && headerMatchesWalk(header, walk) ? cacheHeaderVersion(header) : null);
  let contentSha256: string | null = null;
  try {
    contentSha256 = await sha256Hex(redactCacheUserNames(buf).bytes);
  } catch {
    contentSha256 = null; // not strictly walkable (tolerant input): no hash
  }
  const capturedAt = opts.capturedAt ?? null;
  const src: EditorCacheRawSource = {
    id: rawSourceId('editor-cache', capturedAt, opts.seq ?? 0),
    kind: 'editor-cache',
    origin: opts.origin ?? 'local',
    capturedAt,
    firmware,
    codecVersion: VERSION,
    space: 'section',
    sections: walk.sections.map((s) => ({ tag: s.index, count: s.records })),
    omitted,
    header,
    fileVersion,
    contentSha256,
    records,
  };
  if (walk.issues && walk.issues.length > 0) src.issues = walk.issues;
  return src;
}

export interface RawFromLiveWalkOptions {
  kind: LiveRawSource['kind'];
  /** Caller-supplied ISO stamp (never wall-clock here). */
  capturedAt?: string | null;
  /** Device firmware the walk ran on. */
  firmware?: string | null;
  origin?: SourceOrigin;
  /** The `#n` of the source id (default 0). */
  seq?: number;
  /** Outcome of an extension phase, when one ran or was skipped. */
  extension?: 'done' | 'skipped' | 'aborted';
  abortReason?: string;
}

/**
 * Raw source from a live definition walk: records without byte positions, the walk's reply-loss
 * statistics (and `boundHits`, when the walk reports them) and the caller's scope.
 */
export function rawFromLiveWalk(
  result: LiveWalkResult & { boundHits?: readonly WalkBoundHit[] },
  scope: LiveSourceScope,
  opts: RawFromLiveWalkOptions,
): LiveRawSource {
  const capturedAt = opts.capturedAt ?? null;
  const { queries, lostReplies, recoveredReplies, unresolvedReplies, placeholderSlots, missingSlots, silentAddresses, pseudoReplies } = result;
  const walk: LiveRawSource['walk'] = {
    queries,
    lostReplies,
    recoveredReplies,
    unresolvedReplies,
    placeholderSlots,
    missingSlots,
    silentAddresses,
    ...(pseudoReplies !== undefined ? { pseudoReplies: { ...pseudoReplies } } : {}),
    boundHits: (result.boundHits ?? []).map((h) => ({ block: h.block, lastReal: h.lastReal, bound: h.bound })),
  };
  if (opts.extension !== undefined) walk.extension = opts.extension;
  if (opts.abortReason !== undefined) walk.abortReason = opts.abortReason;
  return {
    id: rawSourceId(opts.kind, capturedAt, opts.seq ?? 0),
    kind: opts.kind,
    origin: opts.origin ?? 'local',
    capturedAt,
    firmware: opts.firmware ?? null,
    codecVersion: VERSION,
    space: 'block',
    scope: {
      blocks: [...scope.blocks],
      maxParamId: scope.maxParamId,
      bounds: { ...scope.bounds },
      ...(scope.idLists !== undefined
        ? { idLists: Object.fromEntries(Object.entries(scope.idLists).map(([b, ids]) => [b, [...ids]])) }
        : {}),
      extended: scope.extended,
      above160: scope.above160,
      hinted: scope.hinted,
    },
    walk,
    records: result.records.map(stripRecord),
  };
}

/** Summary line of a raw source (`records` = raw records, i.e. after user name tables were omitted). */
export function sourceSummary(s: RawSource): SourceSummary {
  return { id: s.id, kind: s.kind, origin: s.origin, capturedAt: s.capturedAt, firmware: s.firmware, records: s.records.length };
}

// ---------------------------------------------------------------------------
// Privacy guard
// ---------------------------------------------------------------------------

/** A document (or file) carries a user name table. */
export class ProfileUserDataError extends Error {
  readonly code = 'contains-user-data';

  constructor(message: string) {
    super(message);
    this.name = 'ProfileUserDataError';
  }
}

const FIRMWARE_CAB_BANKS = new Set(['FACTORY 1', 'FACTORY 2', 'LEGACY']);

/**
 * Throws `ProfileUserDataError` when any raw record is a user name table (`isUserNameTable`) or the
 * derived cab-IR banks hold anything but the firmware banks. The message names the source and the
 * record id only, never content.
 */
export function assertNoUserTables(doc: { raw?: ProfileRaw | null; cabIrs?: Readonly<Record<string, unknown>> }): void {
  for (const s of doc.raw?.sources ?? []) {
    for (const r of s.records) {
      if (isUserNameTable(r.id)) {
        throw new ProfileUserDataError(`source ${s.id} carries a user name table (record id 0x${r.id.toString(16)})`);
      }
    }
  }
  for (const bank of Object.keys(doc.cabIrs ?? {})) {
    if (!FIRMWARE_CAB_BANKS.has(bank)) throw new ProfileUserDataError('derived cab-IR banks carry a non-firmware bank');
  }
}

// ---------------------------------------------------------------------------
// Derived document
// ---------------------------------------------------------------------------

/** One section of the catalog's baseline editor cache (`*_CATALOG_SECTIONS`). */
export interface CatalogSection {
  tag: number;
  /** Catalog family of the section (also for a further instance tag); `null` for a system table. */
  family: string | null;
  /** Declared record count in the baseline cache (special table records included). */
  records: number;
}

/**
 * - `family` / `instance`: assigned to a catalog family (`instance` = a further tag of the
 *   family's instance group);
 * - `system`: unassigned, but listed in the catalog section inventory;
 * - `new`: unassigned and absent from the inventory (a section the catalog firmware lacks);
 * - `unclassified`: unassigned and no inventory to compare with (or a live block address).
 */
export type SectionRole = 'family' | 'instance' | 'system' | 'new' | 'unclassified';

export interface DerivedSection {
  /** `section` = editor-cache section tag, `block` = live block address. */
  space: 'section' | 'block';
  tag: number;
  /** Catalog family, `section:<tag>` or `block:<eid>`. */
  key: string;
  family: string | null;
  role: SectionRole;
  stride: number;
  recordCount: number;
  /** Rows with an editable span (`isInformativeRow`). */
  informative: number;
  /** `rowsSignature(sectionSignatureRows(rows))`. */
  signature: string;
  /** Source whose records the section holds (the one with most records in it). */
  sourceId: string;
}

export type BlockMapConfidence = 'catalog' | 'roster' | 'confirmed' | 'likely' | 'candidate';

/** Effect id ↔ section/family binding for a block the catalog cannot place (filled by the block matcher). */
export interface BlockMapEntry {
  eid: number;
  key: string | null;
  sectionTag: number | null;
  confidence: BlockMapConfidence;
  evidence: Array<'device-records' | 'live-only' | 'bulk-shape' | 'roster' | 'pack'>;
  compared?: { rows: number; equal: number; probedTo: number };
  candidates?: number[];
  channels: boolean | null;
}

export interface ProfileDoc extends BuiltCache {
  meta: BuiltCache['meta'] & {
    format: 2;
    /** Codec `VERSION` that derived the tables. */
    derivedWith: string;
    /** Caller-supplied ISO stamp (never wall-clock in the codec). */
    derivedAt?: string;
    /** One per raw source, same order. */
    sources: SourceSummary[];
  };
  /** The truth; the derived tables are a cache of `deriveProfile(raw, …)`. */
  raw: ProfileRaw;
  /** Every section of every source, unassigned ones included. */
  sections: DerivedSection[];
  /** Effect id ↔ section/family for blocks the catalog cannot place. */
  blockMap: BlockMapEntry[];
  /** Which source won per family, contributions, conflicts, suspects. */
  provenance: ProfileProvenance;
  /** Gaps and counts. */
  coverage: ProfileCoverage;
}

/** `deriveProfile` output: a document without its raw sources. */
export type DerivedProfile = Omit<ProfileDoc, 'raw'>;

export interface DeriveOptions {
  /** Catalog section inventory of the device (`*_CATALOG_SECTIONS`); without it unassigned sections are `unclassified`. */
  catalogSections?: readonly CatalogSection[];
  /** Caller-supplied ISO stamp for `meta.derivedAt`. */
  derivedAt?: string;
  model?: number;
  /** Firmware of the document key. Sources taken on another firmware are rejected. */
  firmware?: string;
  /** Static catalog facts for suspects and coverage (see `ProfileCatalog`). */
  catalog?: ProfileCatalog;
}

/** Why `deriveProfile` refused the raw sources. */
export type ProfileDerivationErrorCode = 'unsupported-raw-format' | 'no-sources' | 'firmware-mismatch' | 'duplicate-source-id';

export class ProfileDerivationError extends Error {
  readonly code: ProfileDerivationErrorCode;

  constructor(code: ProfileDerivationErrorCode, message: string) {
    super(message);
    this.name = 'ProfileDerivationError';
    this.code = code;
  }
}

/** Synthetic family key of an unassigned section (`section:<tag>`) or live block (`block:<eid>`). */
export function syntheticFamilyKey(space: 'section' | 'block', tag: number): string {
  return `${space}:${tag}`;
}

/** True for a `section:<tag>` / `block:<eid>` key (never a catalog family symbol). */
export function isSyntheticFamilyKey(key: string): boolean {
  return /^(section|block):\d+$/.test(key);
}

/** A source unit derived: the voter's tables (synthetic families included) and its sections. */
export interface DerivedUnit {
  plan: SourceUnitPlan;
  data: BuiltCacheData;
  detail: DeviceCacheDetail;
  sections: DerivedSection[];
}

function roleOf(space: 'section' | 'block', family: string | null, instance: boolean, tag: number, inventory: ReadonlySet<number> | null): SectionRole {
  if (family !== null) return instance ? 'instance' : 'family';
  if (space === 'block' || inventory === null) return 'unclassified';
  return inventory.has(tag) ? 'system' : 'new';
}

/**
 * Add every unassigned section of a unit as a synthetic family (rows, labels, section meta, after
 * the catalog families) and describe each section. `data` of the detail is copied, not modified.
 */
function deriveUnit(plan: SourceUnitPlan, detail: DeviceCacheDetail, inventory: ReadonlySet<number> | null): DerivedUnit {
  const base = detail.data;
  const enumOverrides: Record<string, Record<string, string[]>> = { ...base.enumOverrides };
  const ranges: Record<string, Record<number, RangeDef>> = { ...base.ranges };
  const rangeSections: Record<string, RangeSectionMeta> = { ...base.rangeSections };
  const sections: DerivedSection[] = [];
  for (const s of detail.sections) {
    const key = s.family ?? syntheticFamilyKey(plan.space, s.tag);
    let informative = 0;
    const rows: Record<number, RangeDef> = {};
    const labels: Record<string, string[]> = {};
    for (const [pid, r] of s.rows) {
      const d = rangeRowOf(r);
      if (isInformativeRow(d.row)) informative += 1;
      if (s.family === null) {
        rows[pid] = d.row;
        if (d.labels !== undefined) labels[String(pid)] = d.labels;
      }
    }
    if (s.family === null) {
      ranges[key] = rows;
      if (Object.keys(labels).length > 0) enumOverrides[key] = labels;
      rangeSections[key] = { sectionTag: s.tag, stride: s.stride, recordCount: s.recordCount };
    }
    sections.push({
      space: plan.space,
      tag: s.tag,
      key,
      family: s.family,
      role: roleOf(plan.space, s.family, s.instance, s.tag, inventory),
      stride: s.stride,
      recordCount: s.recordCount,
      informative,
      signature: rowsSignature(sectionSignatureRows([...s.rows.values()])),
      sourceId: plan.sectionSource(s.tag),
    });
  }
  return { plan, detail, data: { ...base, enumOverrides, ranges, rangeSections }, sections };
}

function checkSources(raw: ProfileRaw, firmware: string | undefined): void {
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.sources)) {
    throw new ProfileDerivationError('unsupported-raw-format', 'raw sources missing');
  }
  if (typeof raw.format !== 'number' || raw.format > RAW_FORMAT) {
    throw new ProfileDerivationError('unsupported-raw-format', `raw format ${String(raw.format)} is newer than ${RAW_FORMAT}`);
  }
  if (raw.sources.length === 0) throw new ProfileDerivationError('no-sources', 'no raw source to derive from');
  const ids = new Set<string>();
  for (const s of raw.sources) {
    if (ids.has(s.id)) throw new ProfileDerivationError('duplicate-source-id', `source id ${s.id} is not unique`);
    ids.add(s.id);
  }
  let target = firmware ?? null;
  for (const s of raw.sources) {
    if (s.firmware === null) continue;
    if (target === null) target = s.firmware;
    else if (s.firmware !== target) {
      throw new ProfileDerivationError('firmware-mismatch', `source ${s.id} was taken on firmware ${s.firmware}, not ${target}`);
    }
  }
}

/**
 * Derive the document tables from raw sources: each source unit (sources of one kind and origin,
 * see ./merge.ts) is built by the section voter on its own (editor-cache units with their declared
 * section counts), unassigned sections become synthetic families, the units merge per family by
 * source precedence, and provenance and coverage are computed.
 *
 * With a single editor-cache source the v1 fields (`BuiltCacheData` maps, `model`, `firmware`,
 * `meta.schema/recordCount/source/issues`) equal `buildCache({ kind: 'bytes', buf })` of the same
 * bytes, plus the synthetic family keys; with a single live source they equal
 * `buildCache({ kind: 'live' })` of the same walk (incl. `meta.walk`). `meta.builtAt` is never set.
 *
 * Throws `ProfileDerivationError` (format, no sources, duplicate ids, a source on another firmware),
 * `ProfileUserDataError` (a user name table in raw), or the voter's own error (seed disagreement).
 */
export function deriveProfile(
  raw: ProfileRaw,
  params: DeviceParam[],
  seeds: Record<string, number>,
  opts: DeriveOptions = {},
): DerivedProfile {
  checkSources(raw, opts.firmware);
  assertNoUserTables({ raw });

  const catalogSections = opts.catalogSections ?? opts.catalog?.sections;
  const inventory = catalogSections ? new Set(catalogSections.map((c) => c.tag)) : null;
  const units = planSourceUnits(raw.sources).map((plan) => {
    // A probe covers single blocks: no seeded core block is expected in it.
    const unitSeeds = plan.kind === 'live-probe' ? {} : seeds;
    const detail = buildDeviceCacheDetailed(plan.records, params, unitSeeds, plan.declaredCounts ? { declaredCounts: plan.declaredCounts } : {});
    return deriveUnit(plan, detail, inventory);
  });

  const merged = mergeDerived(units, opts.catalog);

  const meta: DerivedProfile['meta'] = {
    schema: CACHE_SCHEMA,
    recordCount: merged.recordCount,
    source: merged.source,
    ...(merged.walk !== undefined ? { walk: merged.walk } : {}),
    ...(merged.issues !== undefined ? { issues: merged.issues } : {}),
    format: PROFILE_FORMAT,
    derivedWith: VERSION,
    ...(opts.derivedAt !== undefined ? { derivedAt: opts.derivedAt } : {}),
    sources: raw.sources.map(sourceSummary),
  };

  const out = { ...merged.data, meta } as DerivedProfile;
  if (opts.model !== undefined) out.model = opts.model;
  if (opts.firmware !== undefined) out.firmware = opts.firmware;
  out.sections = units.flatMap((u) => u.sections);
  out.blockMap = [];
  out.provenance = merged.provenance;
  out.coverage = computeCoverage({ ...out, raw }, opts.catalog);
  return out;
}

/** `deriveProfile` plus the raw sources: a complete document ready to persist. */
export function buildProfileDoc(
  raw: ProfileRaw,
  params: DeviceParam[],
  seeds: Record<string, number>,
  opts: DeriveOptions = {},
): ProfileDoc {
  return { ...deriveProfile(raw, params, seeds, opts), raw };
}
