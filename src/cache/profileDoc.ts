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
 *     `provenance`, `coverage`, `meta.format/derivedWith/derivedRevision/derivedAt/sources`);
 *   - a stored document re-derives when the rules change: on a `CACHE_SCHEMA` bump, or when its
 *     `meta.derivedRevision` is below `DERIVATION_REVISION` (`needsRederive`);
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
import { bridgeLiveUnits, deriveBlockMap, effectIdSpansForModel } from './blockMap.js';
import type { DeviceCacheDetail } from './assign.js';
import { CACHE_SCHEMA } from './buildProfile.js';
import type { BuiltCache, BuiltCacheWalkStats } from './buildProfile.js';
import { isInformativeRow } from './fingerprint.js';
import { CACHE_HEADER_BYTES, cacheHeaderVersion, headerMatchesWalk, parseCacheFileName, readCacheHeader } from './header.js';
import type { LiveWalkResult } from './liveWalk.js';
import { computeCoverage, effectIdOwners, mergeDerived, planSourceUnits } from './merge.js';
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

/**
 * Format of `ProfileRaw` (the raw record envelope).
 *
 * Policy: a raw source is not only stored in a profile document, it is also what is shared with a
 * definitions backend (`shareableSource`, `sourceFactHash`: ./share.ts) and what that backend
 * validates against its own copy of this shape. Any change to a raw field (a field added, removed,
 * retyped or given another meaning, in a source, a record, the live scope or the walk statistics)
 * therefore BUMPS `RAW_FORMAT`, and the backend's validator must accept the new format (and be
 * deployed) before a client that writes it ships. Within one format a reader drops keys it does not
 * know: they are never stored and never derived from.
 */
export const RAW_FORMAT = 1;

/**
 * Revision of the derivation rules within one `CACHE_SCHEMA`, persisted as `meta.derivedRevision`.
 * Raise it by one whenever an additive derivation change (one that needs no `CACHE_SCHEMA` bump —
 * e.g. a better block matcher or voter restriction) must reach stored format-2 documents: a document
 * derived under a lower revision is re-derived from its raw sources (`needsRederive`). An integer, not
 * the codec version: a development build reports the version in package.json, a release the git tag,
 * so version strings do not order derivations reliably.
 *
 * History: 1 = derivation of the first format-2 documents: the restricted live vote (a block takes
 * only the family whose effect-id span holds it, the host's spans or the model's), the
 * inventory-restricted editor-cache vote (a section takes only the family the catalog section
 * inventory lists for its tag), the block map (a `confirmed` binding needs the live table to end where
 * the section ends) and block-space instance groups. Format-2 documents without the field count as
 * revision 0.
 */
export const DERIVATION_REVISION = 1;

/**
 * True when a stored document's derived tables must be re-derived from its raw sources before use:
 * a format-2 document (`meta.format === 2`) whose `meta.schema` is not this codec's `CACHE_SCHEMA`, or
 * whose `meta.derivedRevision` (absent = 0) is lower than `DERIVATION_REVISION`. A document from a
 * newer codec (higher revision, same schema) is kept as it is. False for a format-1 document (it has
 * no raw sources; a schema mismatch makes it stale instead) and for anything that is not a meta object.
 * The caller still checks that it can read the raw envelope (`raw.format <= RAW_FORMAT`).
 */
export function needsRederive(meta: { format?: unknown; schema?: unknown; derivedRevision?: unknown } | null | undefined): boolean {
  if (meta === null || typeof meta !== 'object' || meta.format !== PROFILE_FORMAT) return false;
  if (meta.schema !== CACHE_SCHEMA) return true;
  const rev = typeof meta.derivedRevision === 'number' && Number.isFinite(meta.derivedRevision) ? meta.derivedRevision : 0;
  return rev < DERIVATION_REVISION;
}

/**
 * @deprecated Use `needsRederive` / `DERIVATION_REVISION`: version strings do not order derivations
 * (a development build reports package.json, a release the git tag). Kept at '0.0.0' (never triggers)
 * so older callers keep compiling; it will be removed.
 */
export const MIN_DERIVED_WITH = '0.0.0';

/**
 * Numeric comparison of two dotted codec versions (`'0.6.1'`): negative when `a` is older, 0 when
 * equal, positive when newer. Missing parts count as 0; a pre-release or build suffix is ignored.
 *
 * @deprecated For re-derivation decisions use `needsRederive`; this helper will be removed together
 * with `MIN_DERIVED_WITH`.
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

/**
 * The sources with unique ids: a source whose id an earlier source already carries (two sources of
 * one kind without a capture time, or a re-imported source) gets the lowest free `#n` for its kind
 * and capture time (`rawSourceId`). Sources with unique ids are returned unchanged (same objects);
 * renamed ones are copies. Deterministic. Call it before appending sources to a document —
 * `deriveProfile` itself rejects duplicate ids.
 */
export function uniqueSourceIds<T extends RawSource>(sources: readonly T[]): T[] {
  // Every id's first carrier keeps it; a renamed duplicate never takes an id another source carries.
  const used = new Set(sources.map((s) => s.id));
  const kept = new Set<string>();
  return sources.map((s) => {
    if (!kept.has(s.id)) {
      kept.add(s.id);
      return s;
    }
    let n = 0;
    while (used.has(rawSourceId(s.kind, s.capturedAt, n))) n += 1;
    const id = rawSourceId(s.kind, s.capturedAt, n);
    used.add(id);
    return { ...s, id };
  });
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
  /** Catalog family, `section:<tag>` or `block:<eid>` (a live block the block map bridged to a section: that section's key). */
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

/** Effect id ↔ section/family binding for a block the catalog cannot place (filled by the block matcher, ./blockMap.ts). */
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
    /** Codec `VERSION` that derived the tables (informational; re-derivation goes by `derivedRevision`). */
    derivedWith: string;
    /** `DERIVATION_REVISION` of the codec that derived the tables (see `needsRederive`). */
    derivedRevision: number;
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
  /**
   * Catalog section inventory of the device (`*_CATALOG_SECTIONS`; default `catalog.sections`).
   * Classifies unassigned sections (`system` / `new`; without it `unclassified`) and restricts the
   * editor-cache vote: a section may only take the family the inventory lists for its tag, and a
   * tag the inventory does not list takes none (`voteRestriction`).
   */
  catalogSections?: readonly CatalogSection[];
  /** Caller-supplied ISO stamp for `meta.derivedAt`. */
  derivedAt?: string;
  /** Model byte. Without `catalog.familyFirstEid` it selects the codec's default effect-id spans (`effectIdSpansForModel`). */
  model?: number;
  /** Firmware of the document key. Sources taken on another firmware are rejected. */
  firmware?: string;
  /**
   * Static catalog facts for suspects, coverage, the block map and the restricted vote (see
   * `ProfileCatalog`). `familyFirstEid` (+ `instanceLimits`) sets the block-space restriction: a
   * live block may only take the catalog family whose reserved effect-id span holds it
   * (`effectIdOwners`), every other block stays `block:<eid>` for the block map. Without
   * `familyFirstEid` the codec's own spans of `model` apply (`effectIdSpansForModel`); without
   * those either, live units assign no family at all (as probes).
   */
  catalog?: ProfileCatalog;
  /**
   * TEST / PARITY ONLY. Without `catalog.familyFirstEid`, read-only and full live walks vote
   * unrestricted — the tables of `buildCache({ kind: 'live' })`, which can hand a block to an
   * unrelated family whose table looks alike — instead of being restricted to the model's default
   * spans (probes still assign nothing). Ignored when `catalog.familyFirstEid` is given. Never set
   * it in a host: it exists for the v1 parity tests (and walks recorded in section-tag space).
   */
  unrestrictedLiveVote?: boolean;
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
 * the catalog families) and describe each section. In block space an unassigned block whose table is
 * identical to a lower unassigned block (`instanceOf`) is an instance of it, like the instances of a
 * catalog family: it gets no family of its own, its section takes the first block's `block:<eid>`
 * key, and that family's `rangeSections` entry lists both (`instanceTags`). Editor-cache sections are
 * never grouped (two identical sections stay two candidates for the block map). `data` of the detail
 * is copied, not modified.
 */
function deriveUnit(plan: SourceUnitPlan, detail: DeviceCacheDetail, inventory: ReadonlySet<number> | null): DerivedUnit {
  const base = detail.data;
  const enumOverrides: Record<string, Record<string, string[]>> = { ...base.enumOverrides };
  const ranges: Record<string, Record<number, RangeDef>> = { ...base.ranges };
  const rangeSections: Record<string, RangeSectionMeta> = { ...base.rangeSections };
  const sections: DerivedSection[] = [];
  const unassigned = new Set(detail.sections.filter((s) => s.family === null).map((s) => s.tag));
  const groupTags = new Map<string, number[]>();
  for (const s of detail.sections) {
    const first = plan.space === 'block' && s.family === null && s.instanceOf !== undefined && unassigned.has(s.instanceOf) ? s.instanceOf : s.tag;
    const key = s.family ?? syntheticFamilyKey(plan.space, first);
    if (s.family === null && first !== s.tag) {
      // A further instance of an unassigned block group: described, but no family of its own.
      const tags = groupTags.get(key);
      if (tags) tags.push(s.tag);
      else groupTags.set(key, [first, s.tag]);
      sections.push({
        space: plan.space,
        tag: s.tag,
        key,
        family: null,
        role: roleOf(plan.space, null, false, s.tag, inventory),
        stride: s.stride,
        recordCount: s.recordCount,
        informative: sections.find((x) => x.tag === first)?.informative ?? 0,
        signature: rowsSignature(sectionSignatureRows([...s.rows.values()])),
        sourceId: plan.sectionSource(s.tag),
      });
      continue;
    }
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
  for (const [key, tags] of groupTags) rangeSections[key] = { ...rangeSections[key]!, instanceTags: tags };
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

/** How one source unit votes (see `voteRestriction`). */
interface UnitVote {
  /** `BuildDeviceCacheOptions.allowFamily`; absent = unrestricted. */
  allowFamily?: (family: string, tag: number) => boolean;
  /** `BuildDeviceCacheOptions.unownedTwinsFollow`. */
  unownedTwinsFollow: boolean;
  /** No family can be assigned: the seed anchors are dropped (nothing could satisfy them). */
  assignsNothing: boolean;
}

/**
 * The section-vote restriction of a unit (`BuildDeviceCacheOptions.allowFamily`):
 *   - block space (live units) with effect-id spans (`spans`: the caller's `familyFirstEid`, else
 *     the codec's own of the model): a block may only take the family whose reserved span holds it
 *     (`effectIdOwners`). A block outside every span — a block the catalog does not know, or a family
 *     hidden from it — keeps no family and goes to the block map, so it can never be claimed by an
 *     unrelated family whose table happens to look alike. A block identical to a lower block a family
 *     may take follows that family as a further instance (`unownedTwinsFollow`: the modifier slots);
 *   - block space without spans: nothing is assigned — unless `unrestrictedLive` (test/parity only),
 *     where read-only and full walks vote unrestricted (`buildCache` parity); a probe never does;
 *   - tag space (editor-cache units) with a section inventory: a section may only take the family
 *     the inventory lists for its tag (an instance tag: its family too). A family the inventory does
 *     not list takes no section; a tag the inventory does not list (a section the catalog firmware
 *     lacks) takes no family and stays `section:<tag>` (role `new`) — it can reach a family only
 *     through device evidence (the block map). Identical sections never follow across owners;
 *   - tag space without an inventory: the unrestricted vote (the tables of `buildCache({ kind:
 *     'bytes' })`, which may give a family a section that only looks like its table).
 */
function voteRestriction(
  catalogSections: readonly CatalogSection[] | undefined,
  spans: Pick<ProfileCatalog, 'familyFirstEid' | 'instanceLimits'> | null,
  unrestrictedLive: boolean,
): (plan: SourceUnitPlan) => UnitVote {
  const owners = effectIdOwners(spans ?? undefined);
  const inventory = catalogSections ? new Map(catalogSections.map((c) => [c.tag, c.family])) : null;
  return (plan) => {
    if (plan.space === 'block') {
      if (owners) return { allowFamily: (family, tag) => owners.get(tag) === family, unownedTwinsFollow: true, assignsNothing: false };
      if (unrestrictedLive && plan.kind !== 'live-probe') return { unownedTwinsFollow: false, assignsNothing: false };
      return { allowFamily: () => false, unownedTwinsFollow: false, assignsNothing: true };
    }
    if (inventory) return { allowFamily: (family, tag) => inventory.get(tag) === family, unownedTwinsFollow: false, assignsNothing: false };
    return { unownedTwinsFollow: false, assignsNothing: false };
  };
}

/**
 * Derive the document tables from raw sources: each source unit (sources of one kind and origin,
 * see ./merge.ts) is built by the section voter on its own (editor-cache units with their declared
 * section counts; the vote restricted as `voteRestriction` describes), unassigned sections become
 * synthetic families, the block map binds live blocks the catalog cannot place to editor-cache
 * sections (./blockMap.ts; a byte-bridged block's rows join the section's family instead of
 * `block:<eid>`), the units merge per family by source precedence, and provenance and coverage are
 * computed.
 *
 * Relation to v1 (`buildCache`), field by field for the v1 fields (`BuiltCacheData` maps, `model`,
 * `firmware`, `meta.schema/recordCount/source/issues/walk`), plus the synthetic family keys:
 *   - a single editor-cache source WITHOUT a section inventory equals `buildCache({ kind: 'bytes',
 *     buf })` of the same bytes. WITH an inventory the tag-space vote is restricted (a section only
 *     takes the family the inventory lists for it, see `voteRestriction`), so it MAY differ from
 *     `buildCache(bytes)`: on a cache whose voter result already matches the inventory (the
 *     committed FM3 fixture) the tables are equal; where the unrestricted voter would hand a section
 *     to the wrong family (MIXER / OUTPUT on real FM9 / Axe-Fx III caches) or give a section the
 *     catalog firmware lacks to a look-alike family, the restricted one does not;
 *   - a single live source equals `buildCache({ kind: 'live' })` of the same walk only with
 *     `unrestrictedLiveVote` (and no `catalog.familyFirstEid`). Otherwise the live vote is restricted
 *     to effect-id spans (the host's `familyFirstEid`, else the model's), which on a walk in the
 *     device's block-address space gives the same catalog families wherever the unrestricted vote
 *     placed every family at its own effect id; without any spans live units assign nothing.
 * `meta.builtAt` is never set.
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
  // Effect-id spans of the live vote and the block map: the host's table wins (it may hide a family
  // or carry device-true instance counts), else the codec's own for the model.
  const spans = opts.catalog?.familyFirstEid
    ? { familyFirstEid: opts.catalog.familyFirstEid, ...(opts.catalog.instanceLimits ? { instanceLimits: opts.catalog.instanceLimits } : {}) }
    : opts.unrestrictedLiveVote === true
      ? null
      : effectIdSpansForModel(opts.model);
  const voteOf = voteRestriction(catalogSections, spans, opts.unrestrictedLiveVote === true);
  const derived = planSourceUnits(raw.sources).map((plan) => {
    const vote = voteOf(plan);
    // A probe covers single blocks: no seeded core block is expected in it (nor in a unit that
    // can take no family at all).
    const unitSeeds = plan.kind === 'live-probe' || vote.assignsNothing ? {} : seeds;
    const detail = buildDeviceCacheDetailed(plan.records, params, unitSeeds, {
      ...(plan.declaredCounts ? { declaredCounts: plan.declaredCounts } : {}),
      ...(vote.allowFamily ? { allowFamily: vote.allowFamily, unownedTwinsFollow: vote.unownedTwinsFollow } : {}),
    });
    return deriveUnit(plan, detail, inventory);
  });

  // Block map: live blocks the catalog cannot place, bound to editor-cache sections by their rows.
  // A byte-bridged block's rows join the section's family instead of a `block:<eid>` family.
  const blockMap = deriveBlockMap(derived, spans ?? undefined);
  const units = bridgeLiveUnits(derived, blockMap);

  const merged = mergeDerived(units, opts.catalog);

  const meta: DerivedProfile['meta'] = {
    schema: CACHE_SCHEMA,
    recordCount: merged.recordCount,
    source: merged.source,
    ...(merged.walk !== undefined ? { walk: merged.walk } : {}),
    ...(merged.issues !== undefined ? { issues: merged.issues } : {}),
    format: PROFILE_FORMAT,
    derivedWith: VERSION,
    derivedRevision: DERIVATION_REVISION,
    ...(opts.derivedAt !== undefined ? { derivedAt: opts.derivedAt } : {}),
    sources: raw.sources.map(sourceSummary),
  };

  const out = { ...merged.data, meta } as DerivedProfile;
  if (opts.model !== undefined) out.model = opts.model;
  if (opts.firmware !== undefined) out.firmware = opts.firmware;
  out.sections = units.flatMap((u) => u.sections);
  out.blockMap = blockMap;
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
