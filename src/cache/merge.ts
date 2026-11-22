/**
 * Multi-source merge, provenance and coverage for profile documents (./profileDoc.ts).
 *
 * Source units. Sources of the same kind and origin form one unit before anything is derived:
 *   - editor-cache sources: the newest `capturedAt` wins per section;
 *   - live sources: per (block, pid) the newest source whose scope covers that id wins, so a
 *     newer walk replaces an older one where both looked, and walks with disjoint scopes (a
 *     standard walk plus an extension, or probes of different blocks) are unioned.
 * Each unit is derived on its own by the section voter (editor-cache units in section-tag space,
 * live units in block-address space).
 *
 * Precedence (`sourceRank`), per family: local editor-cache > cloud/file editor-cache > local
 * live-full > cloud/file live-full > local live-readonly > cloud/file live-readonly > local
 * live-probe > cloud/file live-probe; equal ranks go to the newest unit. The best-ranked unit
 * that has a family provides its existence facts — pid set, kinds, ranges, labels, stride,
 * section meta, roster — unless that unit's copy is an assignment suspect against the catalog
 * (then the next unit's copy, if any is not suspect). Byte families (section tags) and live
 * families (block addresses) meet at the catalog family both voters assign.
 *
 * Field classes beyond existence: a live row's device unit is attached to the winning row when
 * the winning row has none and both rows have the same canonical tuple (./rowTuple.ts); a
 * live-full row's reliable measured taper likewise (float rows). The attached row is re-derived
 * by the voter's own row rule (`rangeRowOf`). Cab-IR banks come from an editor-cache unit only.
 *
 * Conflicts: per family and losing unit, the pids whose canonical tuples differ (a kind flip
 * with the same typecode is a known live-walk artefact, not a conflict; unit and taper never
 * count).
 *
 * Coverage (`computeCoverage`): the document-level gaps and counts; runtime-only gaps (a placed
 * block without a family) are the consumer's.
 *
 * Pure and browser-safe.
 */
import { rangeRowOf } from './assign.js';
import type { BuiltCache, BuiltCacheWalkStats } from './buildProfile.js';
import { familyAssignmentSuspects, isInformativeRow } from './fingerprint.js';
import type { FamilyTables } from './fingerprint.js';
import { isPlaceholderRecord, rowTuple } from './rowTuple.js';
import type { BuiltCacheData, CacheRecord, CacheWalkIssue, RangeDef, RangeSectionMeta, TypeModel } from './types.js';
import type {
  CatalogSection,
  DerivedSection,
  DerivedUnit,
  EditorCacheRawSource,
  LiveRawSource,
  ProfileRaw,
  RawSource,
  RawSourceKind,
  SourceOrigin,
} from './profileDoc.js';

// ---------------------------------------------------------------------------
// Provenance and coverage types
// ---------------------------------------------------------------------------

export interface ProfileProvenance {
  /** Family key -> source id that provided its existence facts. */
  existence: Record<string, string>;
  /** Source id -> merged rows whose device unit it contributed. */
  units: Record<string, number>;
  /** Source id -> merged rows whose measured taper it contributed. */
  tapers: Record<string, number>;
  /** Per family and losing source: pids whose canonical tuples differ (`pids`: the first 8). */
  conflicts: Array<{ key: string; count: number; pids: number[]; winner: string; loser: string }>;
  /** Source id -> families its unit assigned suspiciously (empty without catalog tables). */
  suspects: Record<string, string[]>;
}

export type CoverageGapKind =
  | 'no-raw'
  | 'high-ids'
  | 'far-ids'
  | 'blocks-above-160'
  | 'unresolved-replies'
  | 'missing-slots'
  | 'bound-hit'
  | 'rosters'
  | 'new-section'
  | 'unmapped-block'
  | 'disagreement'
  | 'no-units'
  | 'no-tapers'
  | 'no-cab-tables';

export type CoverageFix = 'import-editor-cache' | 'read-from-device' | 'read-extended' | 'probe-block' | 'full-capture' | 'pack';

export interface CoverageGap {
  kind: CoverageGapKind;
  blocking: boolean;
  families?: string[];
  eids?: number[];
  tags?: number[];
  count?: number;
  fix: CoverageFix[];
}

export interface ProfileCoverage {
  /** No blocking gap (document level; a runtime adds `unmapped-block`). */
  complete: boolean;
  gaps: CoverageGap[];
  /** Merged rows with a device unit. */
  units: number;
  /** Merged rows with a measured taper (the typecode-0x52 knob rule does not count). */
  tapers: number;
  /** Informative rows above id 127 in addressable families: expected from the editor cache, else the catalog. */
  highIds: { expected: number; present: number };
  sections: { total: number; assigned: number; system: number; new: number; unclassified: number };
  /** Instance-count mismatches against the static limits only. */
  instances: Array<{ family: string; static: number; seen: number }>;
  /** Live sources' reply-loss totals, when the document has live data. */
  walk?: { lostReplies: number; unresolvedReplies: number; missingSlots: number; boundHits: number };
}

/**
 * Static catalog facts of the device, all optional: the more is given, the more coverage and the
 * suspect check can say. Families are catalog family symbols.
 */
export interface ProfileCatalog {
  /** Catalog baseline firmware (`*_CATALOG_BASELINE.firmware`); `null`/absent = unknown. */
  firmware?: string | null;
  /** Reference rows (`*_RANGES`). With `enumOverrides`: enables the assignment suspect check. */
  ranges?: FamilyTables['ranges'];
  /** Reference label lists (`*_ENUM_OVERRIDES`). */
  enumOverrides?: FamilyTables['enumOverrides'];
  /** Reference rosters (`*_ROSTERS`): families that carry a model list. */
  rosters?: Readonly<Record<string, readonly unknown[]>>;
  /** Family -> first effect id (`null`/absent = not addressable, e.g. PRESET). */
  familyFirstEid?: Readonly<Record<string, number | null>>;
  /** Family -> static instance count. */
  instanceLimits?: Readonly<Record<string, number>>;
  /** Catalog section inventory (`*_CATALOG_SECTIONS`). */
  sections?: readonly CatalogSection[];
}

// ---------------------------------------------------------------------------
// Source units
// ---------------------------------------------------------------------------

/** Precedence rank of a source (lower wins), see the module comment. */
export function sourceRank(kind: RawSourceKind, origin: SourceOrigin): number {
  const k = kind === 'editor-cache' ? 0 : kind === 'live-full' ? 1 : kind === 'live-readonly' ? 2 : 3;
  return k * 2 + (origin === 'local' ? 0 : 1);
}

/** The records one source unit feeds to the section voter. */
export interface SourceUnitPlan {
  kind: RawSourceKind;
  origin: SourceOrigin;
  rank: number;
  space: 'section' | 'block';
  /** Member sources, newest first. */
  members: RawSource[];
  /** Combined records (byte position 0). */
  records: CacheRecord[];
  /** Editor-cache units: declared record count per section (user name tables included). */
  declaredCounts?: Record<number, number>;
  /** Record -> id of the member source it came from. */
  sourceOf: ReadonlyMap<CacheRecord, string>;
  /** Member with the most records in a section (ties: the newest). */
  sectionSource(tag: number): string;
  /** Records consumed, user name tables included (editor cache) — the v1 `meta.recordCount`. */
  recordCount: number;
  /** Live units: summed reply-loss statistics of the members. */
  walk?: BuiltCacheWalkStats;
  /** Editor-cache units: tolerant-parse issues of the members. */
  issues?: CacheWalkIssue[];
}

const isLive = (s: RawSource): s is LiveRawSource => s.kind !== 'editor-cache';

/** Newest first: `null` (unknown) sorts oldest. */
function newer(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? 1 : -1;
}

function covers(s: LiveRawSource, block: number, pid: number): boolean {
  if (!s.scope.blocks.includes(block)) return false;
  const ceiling = s.scope.bounds[block] ?? s.scope.maxParamId;
  return pid <= ceiling || (s.scope.idLists?.[block]?.includes(pid) ?? false);
}

function sumWalk(members: readonly LiveRawSource[]): BuiltCacheWalkStats {
  const w: BuiltCacheWalkStats = {
    queries: 0,
    lostReplies: 0,
    recoveredReplies: 0,
    unresolvedReplies: 0,
    placeholderSlots: 0,
    missingSlots: 0,
    silentAddresses: 0,
  };
  let pseudo: BuiltCacheWalkStats['pseudoReplies'];
  for (const m of members) {
    w.queries += m.walk.queries;
    w.lostReplies += m.walk.lostReplies;
    w.recoveredReplies += m.walk.recoveredReplies;
    w.unresolvedReplies += m.walk.unresolvedReplies;
    w.placeholderSlots += m.walk.placeholderSlots;
    w.missingSlots += m.walk.missingSlots;
    w.silentAddresses += m.walk.silentAddresses;
    const p = m.walk.pseudoReplies;
    if (p !== undefined) {
      pseudo ??= { endMarker: 0, duplicateId: 0, implausible: 0 };
      pseudo.endMarker += p.endMarker;
      pseudo.duplicateId += p.duplicateId;
      pseudo.implausible += p.implausible;
    }
  }
  return pseudo !== undefined ? { ...w, pseudoReplies: pseudo } : w;
}

function planUnit(members: RawSource[]): SourceUnitPlan {
  const first = members[0]!;
  const records: CacheRecord[] = [];
  const sourceOf = new Map<CacheRecord, string>();
  const take = (m: RawSource, r: RawSource['records'][number]) => {
    const c = { ...r, offset: 0 } as CacheRecord;
    records.push(c);
    sourceOf.set(c, m.id);
  };
  let declaredCounts: Record<number, number> | undefined;
  let recordCount: number;
  let walk: BuiltCacheWalkStats | undefined;
  let issues: CacheWalkIssue[] | undefined;

  if (first.kind === 'editor-cache') {
    const byte = members as EditorCacheRawSource[];
    const owner = new Map<number, EditorCacheRawSource>();
    for (const m of byte) {
      const tags = new Set<number>(m.sections.filter((s) => s.count > 0).map((s) => s.tag));
      for (const r of m.records) tags.add(r.section);
      for (const t of tags) if (!owner.has(t)) owner.set(t, m);
    }
    declaredCounts = {};
    recordCount = 0;
    for (const m of byte) {
      for (const r of m.records) if (owner.get(r.section) === m) take(m, r);
      for (const s of m.sections) {
        if (owner.get(s.tag) !== m) continue;
        declaredCounts[s.tag] = s.count;
        recordCount += s.count;
      }
      for (const t of new Set(m.records.map((r) => r.section))) {
        if (owner.get(t) === m && !m.sections.some((s) => s.tag === t)) recordCount += m.records.filter((r) => r.section === t).length;
      }
    }
    const all = byte.flatMap((m) => m.issues ?? []);
    if (all.length > 0) issues = all;
  } else {
    const live = members as LiveRawSource[];
    live.forEach((m, i) => {
      for (const r of m.records) {
        if (live.slice(0, i).some((n) => covers(n, r.section, r.id))) continue;
        take(m, r);
      }
    });
    recordCount = records.length;
    walk = sumWalk(live);
  }

  const bySection = new Map<number, Map<string, number>>();
  for (const r of records) {
    let m = bySection.get(r.section);
    if (!m) bySection.set(r.section, (m = new Map()));
    const id = sourceOf.get(r)!;
    m.set(id, (m.get(id) ?? 0) + 1);
  }
  const sectionSource = (tag: number): string => {
    const counts = bySection.get(tag);
    let best = first.id;
    let n = -1;
    for (const m of members) {
      const c = counts?.get(m.id) ?? 0;
      if (c > n) {
        best = m.id;
        n = c;
      }
    }
    return best;
  };

  const plan: SourceUnitPlan = {
    kind: first.kind,
    origin: first.origin,
    rank: sourceRank(first.kind, first.origin),
    space: first.kind === 'editor-cache' ? 'section' : 'block',
    members,
    records,
    sourceOf,
    sectionSource,
    recordCount,
  };
  if (declaredCounts !== undefined) plan.declaredCounts = declaredCounts;
  if (walk !== undefined) plan.walk = walk;
  if (issues !== undefined) plan.issues = issues;
  return plan;
}

/**
 * Group sources into units (same kind and origin) and combine each unit's records (see the
 * module comment). Best-ranked unit first; equal ranks newest first, then in source order.
 */
export function planSourceUnits(sources: readonly RawSource[]): SourceUnitPlan[] {
  const groups = new Map<string, Array<{ s: RawSource; i: number }>>();
  sources.forEach((s, i) => {
    const key = `${s.kind}|${s.origin}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push({ s, i });
  });
  const units = [...groups.values()].map((g) => {
    const members = [...g].sort((a, b) => newer(a.s.capturedAt, b.s.capturedAt) || a.i - b.i);
    return { plan: planUnit(members.map((x) => x.s)), first: members[0]! };
  });
  units.sort((a, b) => a.plan.rank - b.plan.rank || newer(a.first.s.capturedAt, b.first.s.capturedAt) || a.first.i - b.first.i);
  return units.map((u) => u.plan);
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** What `mergeDerived` returns: the merged tables plus the v1 meta fields of the primary unit. */
export interface MergeResult {
  data: BuiltCacheData;
  provenance: ProfileProvenance;
  /** Primary (best-ranked) unit's record count. */
  recordCount: number;
  /** `bytes` when any unit is an editor-cache unit, else `live`. */
  source: 'bytes' | 'live';
  /** Primary unit's walk statistics, when the primary unit is live. */
  walk?: BuiltCacheWalkStats;
  /** Primary unit's parse issues, when the primary unit is an editor-cache unit. */
  issues?: CacheWalkIssue[];
}

type Measured = NonNullable<Extract<CacheRecord, { kind: 'float' }>['taper']>;

function measuredTaperOf(r: CacheRecord): Measured | undefined {
  if (r.kind !== 'float' || !r.taper || !r.taper.reliable) return undefined;
  const s = r.taper.shape;
  return s === 'linear' || s === 'log' || s === 'custom' ? r.taper : undefined;
}

/**
 * Merge derived units (best-ranked first, as `planSourceUnits` orders them) per family by
 * precedence, attach units and tapers, record provenance and conflicts. With one unit the tables
 * are that unit's tables unchanged.
 */
export function mergeDerived(units: readonly DerivedUnit[], catalog: ProfileCatalog = {}): MergeResult {
  if (units.length === 0) throw new Error('mergeDerived: no source unit');
  const primary = units[0]!;
  const provenance: ProfileProvenance = { existence: {}, units: {}, tapers: {}, conflicts: [], suspects: {} };

  const reference =
    catalog.ranges && catalog.enumOverrides ? { ranges: catalog.ranges, enumOverrides: catalog.enumOverrides } : null;
  const suspectsOf = new Map<DerivedUnit, Set<string>>();
  for (const u of units) {
    const list = reference ? familyAssignmentSuspects(u.data, reference) : [];
    suspectsOf.set(u, new Set(list));
    if (reference) for (const m of u.plan.members) provenance.suspects[m.id] = [...list];
  }

  const sectionIndex = new Map<DerivedUnit, Map<number, ReadonlyMap<number, CacheRecord>>>();
  for (const u of units) sectionIndex.set(u, new Map(u.detail.sections.map((s) => [s.tag, s.rows])));
  const rowsOf = (u: DerivedUnit, key: string): ReadonlyMap<number, CacheRecord> | undefined => {
    const meta = u.data.rangeSections[key];
    return meta ? sectionIndex.get(u)!.get(meta.sectionTag) : undefined;
  };
  const sourceOfKey = (u: DerivedUnit, key: string): string => {
    const meta = u.data.rangeSections[key];
    return meta ? u.plan.sectionSource(meta.sectionTag) : u.plan.members[0]!.id;
  };
  const bump = (m: Record<string, number>, id: string | undefined) => {
    if (id !== undefined) m[id] = (m[id] ?? 0) + 1;
  };

  const keys: string[] = [];
  const seen = new Set<string>();
  for (const u of units) {
    for (const k of Object.keys(u.data.ranges)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }

  const enumOverrides: Record<string, Record<string, string[]>> = {};
  const ranges: Record<string, Record<number, RangeDef>> = {};
  const rangeSections: Record<string, RangeSectionMeta> = {};
  const rosters: Record<string, TypeModel[]> = {};

  for (const key of keys) {
    const cands = units.filter((u) => u.data.ranges[key] !== undefined);
    const winner = cands.find((u) => !suspectsOf.get(u)!.has(key)) ?? cands[0]!;
    const winnerId = sourceOfKey(winner, key);
    provenance.existence[key] = winnerId;
    const wRows = rowsOf(winner, key);
    const rg: Record<number, RangeDef> = { ...winner.data.ranges[key] };

    const live = cands.filter((u) => u !== winner && u.plan.space === 'block');
    for (const [pid, wr] of wRows ?? []) {
      if (isPlaceholderRecord(wr)) continue;
      let unit = wr.unit;
      let unitFrom = unit !== undefined ? winner.plan.sourceOf.get(wr) : undefined;
      let taper = measuredTaperOf(wr);
      let taperFrom = taper !== undefined ? winner.plan.sourceOf.get(wr) : undefined;
      const tuple = rowTuple(wr);
      let attached = false;
      for (const u of live) {
        if (unit !== undefined && (taper !== undefined || wr.kind !== 'float')) break;
        const lr = rowsOf(u, key)?.get(pid);
        if (!lr || isPlaceholderRecord(lr) || rowTuple(lr) !== tuple) continue;
        if (unit === undefined && lr.unit) {
          unit = lr.unit;
          unitFrom = u.plan.sourceOf.get(lr);
          attached = true;
        }
        const lt = u.plan.kind === 'live-full' && wr.kind === 'float' ? measuredTaperOf(lr) : undefined;
        if (taper === undefined && lt !== undefined) {
          taper = lt;
          taperFrom = u.plan.sourceOf.get(lr);
          attached = true;
        }
      }
      if (attached) {
        const aug = { ...wr, ...(unit !== undefined ? { unit } : {}), ...(wr.kind === 'float' && taper !== undefined ? { taper } : {}) } as CacheRecord;
        rg[pid] = rangeRowOf(aug).row;
      }
      if (unit !== undefined) bump(provenance.units, unitFrom);
      if (taper !== undefined) bump(provenance.tapers, taperFrom);
    }

    for (const u of cands) {
      if (u === winner || !wRows) continue;
      const lRows = rowsOf(u, key);
      if (!lRows) continue;
      let count = 0;
      const pids: number[] = [];
      for (const [pid, wr] of wRows) {
        const lr = lRows.get(pid);
        if (!lr) continue;
        const wp = isPlaceholderRecord(wr);
        const lp = isPlaceholderRecord(lr);
        if (wp && lp) continue;
        if (!wp && !lp && wr.kind !== lr.kind && wr.tc === lr.tc) continue; // kind flip, same typecode
        if (wp !== lp || rowTuple(wr) !== rowTuple(lr)) {
          count += 1;
          if (pids.length < 8) pids.push(pid);
        }
      }
      if (count > 0) provenance.conflicts.push({ key, count, pids, winner: winnerId, loser: sourceOfKey(u, key) });
    }

    ranges[key] = rg;
    const eo = winner.data.enumOverrides[key];
    if (eo !== undefined) enumOverrides[key] = { ...eo };
    rangeSections[key] = { ...winner.data.rangeSections[key]! };
    const roster = winner.data.rosters[key];
    if (roster !== undefined) rosters[key] = [...roster];
  }

  const byteUnit = units.find((u) => u.plan.space === 'section');
  const data: BuiltCacheData = {
    enumOverrides,
    ranges,
    rangeSections,
    rosters,
    cabIrs: { ...(byteUnit ?? primary).data.cabIrs },
    unmappedSections: primary.data.unmappedSections.map((s) => ({ ...s })),
    unmappedFamilies: primary.data.unmappedFamilies.filter((f) => ranges[f] === undefined),
  };
  const out: MergeResult = {
    data,
    provenance,
    recordCount: primary.plan.recordCount,
    source: byteUnit !== undefined ? 'bytes' : 'live',
  };
  if (primary.plan.space === 'block' && primary.plan.walk !== undefined) out.walk = primary.plan.walk;
  if (primary.plan.space === 'section' && primary.plan.issues !== undefined) out.issues = primary.plan.issues;
  return out;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/** Absent ids after a block's last real definition that end a contiguous read (the walk's stop run). */
const STOP_RUN = 32;
/** Highest id an extended read-only walk queries. */
const EXTENDED_CAP = 255;
/** Highest id a standard read-only walk queries. */
const STANDARD_CAP = 127;
/** Highest effect id a standard walk covers. */
const STANDARD_MAX_BLOCK = 160;

const isSynthetic = (key: string): boolean => /^(section|block):\d+$/.test(key);

/** A document to assess: a v1 `BuiltCache` (no raw) or a v2 document. */
export type CoverageInput = BuiltCache & {
  raw?: ProfileRaw | null;
  sections?: readonly DerivedSection[];
  provenance?: ProfileProvenance;
};

const sortedUnique = (xs: Iterable<number>): number[] => [...new Set(xs)].sort((a, b) => a - b);

/**
 * Document-level coverage: gaps (with blocking flag and fixes) and counts. A v1 document (no raw
 * sources) reports the non-blocking `no-raw` gap. Rules:
 *   - `high-ids` / `far-ids`: informative rows above id 127 the reference (the editor cache, else
 *     the catalog) has in addressable families and the document lacks; `high` = reachable by a
 *     contiguous read (gaps under the 32-id stop run, at most id 255), `far` = beyond that. High
 *     ids block a live-only document; far ids never block.
 *   - `blocks-above-160`: a live-only document lacks catalog families above effect id 160;
 *     blocking when the firmware is not the catalog firmware (or either is unknown).
 *   - `unresolved-replies`, `missing-slots`, `bound-hit`: from the live sources; always blocking.
 *   - `rosters`: a live-only document lacks catalog roster families; blocking as above.
 *   - `new-section`: editor-cache sections absent from the catalog inventory; never blocking.
 *   - `disagreement`: a family whose conflicts with one source exceed 10 % of its informative
 *     rows; always blocking.
 *   - `no-units`, `no-tapers`, `no-cab-tables`: nothing of that kind; never blocking.
 */
export function computeCoverage(doc: CoverageInput, catalog: ProfileCatalog = {}): ProfileCoverage {
  const sources = doc.raw?.sources ?? [];
  const hasRaw = sources.length > 0;
  const live = sources.filter(isLive);
  const hasByte = hasRaw ? sources.some((s) => s.kind === 'editor-cache') : doc.meta.source !== 'live';
  const liveOnly = !hasByte;
  const fwDiffers = catalog.firmware == null || doc.firmware == null || doc.firmware !== catalog.firmware;
  const addressable = (f: string): boolean =>
    !isSynthetic(f) && (catalog.familyFirstEid ? catalog.familyFirstEid[f] != null : true);
  const gaps: CoverageGap[] = [];

  if (!hasRaw) gaps.push({ kind: 'no-raw', blocking: false, fix: ['import-editor-cache', 'read-from-device'] });

  // High / far ids.
  const ref = hasByte ? doc.ranges : catalog.ranges;
  let expected = 0;
  let present = 0;
  const highMissing = new Map<string, number>();
  const farMissing = new Map<string, number>();
  const base = ref ?? doc.ranges;
  for (const f of Object.keys(base)) {
    if (!addressable(f)) continue;
    const rows = base[f]!;
    const pids = Object.keys(rows).map(Number).sort((a, b) => a - b);
    let end = -1;
    for (const p of pids) {
      if (p - end - 1 >= STOP_RUN) break;
      end = p;
    }
    const reach = Math.min(end, EXTENDED_CAP);
    for (const p of pids) {
      if (p <= STANDARD_CAP || !isInformativeRow(rows[p]!)) continue;
      expected += 1;
      const mine = doc.ranges[f]?.[p];
      if (mine && isInformativeRow(mine)) {
        present += 1;
        continue;
      }
      const into = p <= reach ? highMissing : farMissing;
      into.set(f, (into.get(f) ?? 0) + 1);
    }
  }
  const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  if (highMissing.size > 0) {
    gaps.push({ kind: 'high-ids', blocking: liveOnly, families: [...highMissing.keys()].sort(), count: total(highMissing), fix: ['read-extended', 'import-editor-cache'] });
  }
  if (farMissing.size > 0) {
    gaps.push({ kind: 'far-ids', blocking: false, families: [...farMissing.keys()].sort(), count: total(farMissing), fix: ['import-editor-cache'] });
  }

  // Families above effect id 160.
  if (liveOnly && catalog.familyFirstEid && catalog.ranges) {
    const eids = catalog.familyFirstEid;
    const missing = Object.keys(catalog.ranges).filter((f) => (eids[f] ?? -1) > STANDARD_MAX_BLOCK && doc.ranges[f] === undefined);
    if (missing.length > 0) {
      gaps.push({ kind: 'blocks-above-160', blocking: fwDiffers, families: missing.sort(), fix: ['read-extended', 'import-editor-cache'] });
    }
  }

  // Walk losses.
  let lost = 0;
  let unresolved = 0;
  let missingSlots = 0;
  const hits: number[] = [];
  let walked = live.length > 0;
  for (const s of live) {
    lost += s.walk.lostReplies;
    unresolved += s.walk.unresolvedReplies;
    missingSlots += s.walk.missingSlots;
    for (const h of s.walk.boundHits ?? []) hits.push(h.block);
  }
  if (!hasRaw && doc.meta.walk) {
    walked = true;
    lost = doc.meta.walk.lostReplies;
    unresolved = doc.meta.walk.unresolvedReplies;
    missingSlots = doc.meta.walk.missingSlots;
  }
  if (unresolved > 0) gaps.push({ kind: 'unresolved-replies', blocking: true, count: unresolved, fix: ['read-from-device'] });
  if (missingSlots > 0) gaps.push({ kind: 'missing-slots', blocking: true, count: missingSlots, fix: ['read-from-device'] });
  if (hits.length > 0) gaps.push({ kind: 'bound-hit', blocking: true, eids: sortedUnique(hits), count: hits.length, fix: ['read-from-device'] });

  // Rosters.
  if (liveOnly && catalog.rosters) {
    const cat = catalog.rosters;
    const missing = Object.keys(cat).filter((f) => cat[f]!.length > 0 && !((doc.rosters[f]?.length ?? 0) > 0));
    if (missing.length > 0) gaps.push({ kind: 'rosters', blocking: fwDiffers, families: missing.sort(), fix: ['import-editor-cache'] });
  }

  // New sections.
  const secs = doc.sections ?? [];
  const newTags = sortedUnique(secs.filter((s) => s.space === 'section' && s.role === 'new').map((s) => s.tag));
  if (newTags.length > 0) gaps.push({ kind: 'new-section', blocking: false, tags: newTags, fix: ['pack'] });

  // Disagreement.
  const informative = (key: string): number => Object.values(doc.ranges[key] ?? {}).filter((r) => isInformativeRow(r)).length;
  const disagree = new Set<string>();
  for (const c of doc.provenance?.conflicts ?? []) if (c.count > 0.1 * informative(c.key)) disagree.add(c.key);
  if (disagree.size > 0) gaps.push({ kind: 'disagreement', blocking: true, families: [...disagree].sort(), fix: ['import-editor-cache'] });

  // Units, tapers, cab tables.
  let units = 0;
  let tapers = 0;
  for (const rows of Object.values(doc.ranges)) {
    for (const r of Object.values(rows)) {
      if (r.unit) units += 1;
      if (r.taper && !(r.typecode === 0x52 && r.taper === 'linear' && !r.unit)) tapers += 1;
    }
  }
  if (units === 0) gaps.push({ kind: 'no-units', blocking: false, fix: ['read-from-device'] });
  if (tapers === 0) gaps.push({ kind: 'no-tapers', blocking: false, fix: ['full-capture'] });
  if (Object.keys(doc.cabIrs ?? {}).length === 0) gaps.push({ kind: 'no-cab-tables', blocking: false, fix: ['import-editor-cache'] });

  // Section counts: the editor-cache sections when there are any, else the live blocks; one per tag.
  const sections = { total: 0, assigned: 0, system: 0, new: 0, unclassified: 0 };
  if (secs.length > 0) {
    const space = secs.some((s) => s.space === 'section') ? 'section' : 'block';
    const byTag = new Map<number, DerivedSection>();
    for (const s of secs) if (s.space === space && !byTag.has(s.tag)) byTag.set(s.tag, s);
    for (const s of byTag.values()) {
      sections.total += 1;
      if (s.role === 'family' || s.role === 'instance') sections.assigned += 1;
      else sections[s.role] += 1;
    }
  } else {
    const inventory = catalog.sections ? new Set(catalog.sections.map((c) => c.tag)) : null;
    for (const [key, m] of Object.entries(doc.rangeSections)) {
      if (isSynthetic(key)) continue;
      const n = m.instanceTags?.length ?? 1;
      sections.total += n;
      sections.assigned += n;
    }
    for (const u of doc.unmappedSections) {
      sections.total += 1;
      if (inventory === null) sections.unclassified += 1;
      else if (inventory.has(u.sectionTag)) sections.system += 1;
      else sections.new += 1;
    }
  }

  // Instance evidence (report only).
  const instances: ProfileCoverage['instances'] = [];
  if (catalog.instanceLimits && secs.length > 0) {
    const walkedBlocks = new Set(live.flatMap((s) => s.scope.blocks));
    for (const f of Object.keys(catalog.instanceLimits).sort()) {
      const stat = catalog.instanceLimits[f]!;
      let seenCount: number | null = null;
      const first = catalog.familyFirstEid?.[f];
      if (live.length > 0 && first != null) {
        let all = true;
        for (let e = first; e < first + stat; e++) if (!walkedBlocks.has(e)) all = false;
        if (all) seenCount = new Set(secs.filter((s) => s.space === 'block' && s.family === f).map((s) => s.tag)).size;
      }
      if (seenCount === null) {
        const n = new Set(secs.filter((s) => s.space === 'section' && s.family === f).map((s) => s.tag)).size;
        if (n > 1) seenCount = n;
      }
      if (seenCount !== null && seenCount !== stat) instances.push({ family: f, static: stat, seen: seenCount });
    }
  }

  const out: ProfileCoverage = {
    complete: !gaps.some((g) => g.blocking),
    gaps,
    units,
    tapers,
    highIds: { expected, present },
    sections,
    instances,
  };
  if (walked) out.walk = { lostReplies: lost, unresolvedReplies: unresolved, missingSlots, boundHits: hits.length };
  return out;
}

// ---------------------------------------------------------------------------
// Roster diff
// ---------------------------------------------------------------------------

/** How a model list changed between two firmware (labels compared without trailing whitespace). */
export interface RosterDiff {
  before: number;
  after: number;
  /** Labels added after the last kept label. */
  appended: string[];
  /** Labels added before a kept label (`ordinal` in the new list). */
  inserted: Array<{ ordinal: number; label: string }>;
  /** Same position between kept labels, different label (`ordinal` in the new list). */
  renamed: Array<{ ordinal: number; from: string; to: string }>;
  /** Labels gone (`ordinal` in the old list). */
  removed: Array<{ ordinal: number; label: string }>;
  /** Some kept label sits at another ordinal now (stored selections would change meaning). */
  ordinalShift: boolean;
}

/**
 * Diff two model lists (e.g. a catalog roster and a profile roster, cleaned labels): a longest
 * common subsequence keeps labels; between two kept labels, removed and added labels pair up as
 * renames first; added labels after the last kept one are appended, the others inserted.
 */
export function rosterDiff(before: readonly string[], after: readonly string[]): RosterDiff {
  const a = before.map((l) => l.trimEnd());
  const b = after.map((l) => l.trimEnd());
  const n = a.length;
  const m = b.length;
  // LCS table (suffix lengths).
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    }
  }
  const matches: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      matches.push([i, j]);
      i += 1;
      j += 1;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) i += 1;
    else j += 1;
  }
  const out: RosterDiff = { before: n, after: m, appended: [], inserted: [], renamed: [], removed: [], ordinalShift: false };
  let pi = 0;
  let pj = 0;
  const gap = (i1: number, j1: number, tail: boolean) => {
    const k = Math.min(i1 - pi, j1 - pj);
    for (let x = 0; x < k; x++) {
      out.renamed.push({ ordinal: pj + x, from: before[pi + x]!, to: after[pj + x]! });
      if (pi + x !== pj + x) out.ordinalShift = true;
    }
    for (let i = pi + k; i < i1; i++) out.removed.push({ ordinal: i, label: before[i]! });
    for (let j = pj + k; j < j1; j++) {
      if (tail) out.appended.push(after[j]!);
      else out.inserted.push({ ordinal: j, label: after[j]! });
    }
  };
  for (const [i, j] of matches) {
    gap(i, j, false);
    if (i !== j) out.ordinalShift = true;
    pi = i + 1;
    pj = j + 1;
  }
  gap(n, m, true);
  return out;
}
