/**
 * Block map: effect id <-> section (or family) for blocks the catalog cannot place.
 *
 * An editor cache holds every definition table of a firmware, keyed by section tag, but no
 * effect id; a live definition walk reads tables at effect ids (block addresses), but only for
 * the blocks it was allowed to walk. A block the static catalog does not know (a new block type,
 * or a catalog family without an effect id of its own) is bound to its editor-cache section by
 * comparing rows:
 *
 *   - `confirmed` (evidence `device-records`): over the pids the live source covered (`probedTo`),
 *     every informative live row has an equal canonical tuple in section T, every informative T row
 *     has an equal live row, at least min(8, informative rows of T) rows were compared, and no other
 *     section passes. The live table must also END where T ends: the walk covered at least one id
 *     past T's highest pid and found no row there (`probedTo > maxPid(T)`) — unless the walk stopped
 *     at its mode's cap (`liveWalkCaps`) inside T (T's highest pid >= `probedTo`: a 150-row table
 *     probed to 127). A bound hit on the block (its walk reached the ceiling still finding rows)
 *     forbids `confirmed`, except one at a mode cap inside T; a block whose `probedTo` is unknown (no
 *     scope lists it) is never `confirmed`. One section may confirm several effect ids (instances).
 *     The tuples are kind- and label-free (./rowTuple.ts); a live row read as a float where the
 *     section has an enum (a walk without label hints) still counts as equal when typecode and
 *     numbers agree.
 *   - `confirmed` (evidence `live-only`): the document has no editor-cache source; the live rows
 *     are the block's family (`block:<eid>`, or the family the section voter put them under).
 *     Consumers serve these read-only (the kind of a row may be a walk guess).
 *   - `candidate`: several sections pass (`candidates` = their tags), or none does (`candidates`
 *     empty); `key` is null.
 *   - `roster`: a caller's roster hint names the family, nothing on the device confirmed it.
 *   - `likely` (runtime only, never persisted): `matchBulkShape` — exactly one unassigned section
 *     whose stride fits a bulk read of the placed block and whose enum rows hold the read values.
 *
 * A persisted map is a pure function of the raw sources (and the catalog given to the
 * derivation), so re-derivation reproduces it. Consumers allow writes only on `confirmed`
 * entries with `device-records` evidence; everything else is read-only or unknown.
 *
 * Pure and browser-safe.
 */
import { AXE3_EFFECT_ID_TABLE } from '../gen3/axe-fx-iii/effectIds.js';
import { FM3_EFFECT_ID_TABLE } from '../gen3/fm3/effectIds.js';
import { FM9_EFFECT_ID_TABLE } from '../gen3/fm9/effectIds.js';
import { enumOrdinalBounds } from './fingerprint.js';
import { effectIdOwners, liveWalkCaps } from './merge.js';
import { sectionSignatureRows } from './rowTuple.js';
import type { RangeDef } from './types.js';
import type { ProfileCatalog } from './merge.js';
import type { BlockMapEntry, DerivedSection, DerivedUnit, LiveRawSource } from './profileDoc.js';

export type { BlockMapConfidence, BlockMapEntry } from './profileDoc.js';
export { sectionSignatureRows } from './rowTuple.js';

/** Fewest rows a `confirmed` comparison needs (or all informative rows of a smaller section). */
export const BLOCK_MAP_MIN_ROWS = 8;

/** Typecode of the dimensionless 0..10 knob (always an editable span). */
const KNOB_TYPECODE = 0x52;

interface TupleParts {
  /** `tc|min|max|def|step` */
  head: string;
  /** Enum value count, '' for a float row. */
  count: string;
  informative: boolean;
}

function partsOf(tuple: string): TupleParts {
  const cut = tuple.lastIndexOf('|');
  const head = tuple.slice(0, cut);
  const [tc, min, max] = head.split('|');
  return { head, count: tuple.slice(cut + 1), informative: Number(tc) === KNOB_TYPECODE || Number(max) > Number(min) };
}

/**
 * Two canonical tuples describe the same definition: equal, or equal apart from the value count
 * where one side is a float row (a label list the live walk did not read).
 */
export function tuplesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const x = partsOf(a);
  const y = partsOf(b);
  return x.head === y.head && (x.count === '' || y.count === '');
}

/** Comparison of live rows with one section's rows over pids <= `probedTo`. */
export interface BlockRowsComparison {
  /** Pids where either side has an informative row. */
  rows: number;
  /** Of those, the pids where both sides have matching tuples. */
  equal: number;
  probedTo: number;
}

/** Compare a live block's tuples with a section's over the pids the live source covered. */
export function compareBlockRows(live: ReadonlyMap<number, string>, section: ReadonlyMap<number, string>, probedTo: number): BlockRowsComparison {
  let rows = 0;
  let equal = 0;
  const pids = new Set<number>();
  for (const p of live.keys()) if (p <= probedTo) pids.add(p);
  for (const p of section.keys()) if (p <= probedTo) pids.add(p);
  for (const p of pids) {
    const l = live.get(p);
    const t = section.get(p);
    if (!(l !== undefined && partsOf(l).informative) && !(t !== undefined && partsOf(t).informative)) continue;
    rows += 1;
    if (l !== undefined && t !== undefined && tuplesMatch(l, t)) equal += 1;
  }
  return { rows, equal, probedTo };
}

function informativeCount(rows: ReadonlyMap<number, string>): number {
  let n = 0;
  for (const t of rows.values()) if (partsOf(t).informative) n += 1;
  return n;
}

function maxPidOf(rows: ReadonlyMap<number, unknown>): number {
  let max = -1;
  for (const p of rows.keys()) if (p > max) max = p;
  return max;
}

/** What the live walks say about where a block's table ends (see `MatchBlocksInput`). */
interface BlockExtent {
  probedTo: number;
  capped: boolean;
  boundHits: ReadonlyArray<{ bound: number; capped: boolean }>;
}

/** The `confirmed` rule for one (block, section) pair (see the module comment). */
function confirms(
  cmp: BlockRowsComparison,
  live: ReadonlyMap<number, string>,
  section: ReadonlyMap<number, string>,
  extent: BlockExtent,
): boolean {
  if (!(cmp.rows > 0 && cmp.equal === cmp.rows && cmp.rows >= Math.min(BLOCK_MAP_MIN_ROWS, informativeCount(section)))) return false;
  const end = maxPidOf(section);
  // The walk looked past T's end and found nothing there ...
  let pastEnd = extent.probedTo > end;
  if (pastEnd) for (const p of live.keys()) if (p > end && p <= extent.probedTo) pastEnd = false;
  // ... or it stopped at its mode's cap inside T.
  const atCap = extent.capped && end >= extent.probedTo;
  if (!pastEnd && !atCap) return false;
  // A walk that hit its ceiling still finding rows saw no table end, unless the ceiling is a cap inside T.
  return extent.boundHits.every((h) => h.capped && end >= h.bound);
}

export interface MatchBlocksInput {
  /**
   * Editor-cache sections a block may bind to: the unassigned ones (role `new` / `system` /
   * `unclassified`) and, optionally, sections of catalog families without an effect id of their
   * own. A confirmed entry's `key` is the section's `key`. Duplicate tags: the first wins.
   */
  byteSections: readonly DerivedSection[];
  /** pid -> canonical tuple of a section (`sectionSignatureRows`). */
  byteRows: (tag: number) => ReadonlyMap<number, string>;
  /** Effect id -> pid -> canonical tuple, for the live blocks the catalog does not place. */
  liveBlocks: ReadonlyMap<number, ReadonlyMap<number, string>>;
  /**
   * Effect id -> highest pid the live source covered contiguously (its walk ceiling for that
   * block, from the source's scope). A block without an entry has an unknown extent: it is never
   * `confirmed` against an editor-cache section (`candidate` instead).
   */
  liveProbedTo?: ReadonlyMap<number, number>;
  /**
   * Effect ids whose `liveProbedTo` is a cap of the walk's mode (`liveWalkCaps`): the walk could not
   * look further, so a section that runs on past it may still confirm.
   */
  liveCapped?: ReadonlySet<number>;
  /**
   * Effect id -> the ceilings at which a walk reported a bound hit for the block (`capped`: that
   * ceiling is a cap of the walk's mode). Any hit forbids `confirmed`, except one at a cap that the
   * section reaches.
   */
  liveBoundHits?: ReadonlyMap<number, ReadonlyArray<{ bound: number; capped: boolean }>>;
  /** Effect id -> family key the live block's rows sit under (key of a live-only entry; default `block:<eid>`). */
  liveFamily?: ReadonlyMap<number, string>;
  /** The document has an editor-cache source (default: `byteSections` is non-empty). */
  byteSource?: boolean;
  /** Effect id -> family a roster names (unverified). Adds `roster` entries / evidence. */
  rosterHints?: ReadonlyMap<number, { family: string; sectionTag: number | null }>;
}

/**
 * Bind live blocks to editor-cache sections (see the module comment). One entry per live block
 * (and per roster hint without a live block), ascending by effect id; `channels` is always null
 * (a persisted map knows no grid state).
 */
export function matchBlocks(input: MatchBlocksInput): BlockMapEntry[] {
  const sections: DerivedSection[] = [];
  const seen = new Set<number>();
  for (const s of input.byteSections) {
    if (seen.has(s.tag)) continue;
    seen.add(s.tag);
    sections.push(s);
  }
  const rowsByTag = new Map<number, ReadonlyMap<number, string>>();
  const rowsOf = (tag: number): ReadonlyMap<number, string> => {
    let r = rowsByTag.get(tag);
    if (r === undefined) rowsByTag.set(tag, (r = input.byteRows(tag)));
    return r;
  };
  const byteSource = input.byteSource ?? sections.length > 0;
  const hints = input.rosterHints ?? new Map<number, { family: string; sectionTag: number | null }>();
  const out: BlockMapEntry[] = [];

  for (const eid of [...input.liveBlocks.keys()].sort((a, b) => a - b)) {
    const live = input.liveBlocks.get(eid)!;
    const hint = hints.get(eid);
    if (!byteSource) {
      out.push({ eid, key: input.liveFamily?.get(eid) ?? `block:${eid}`, sectionTag: null, confidence: 'confirmed', evidence: ['live-only'], channels: null });
      continue;
    }
    const probedTo = input.liveProbedTo?.get(eid);
    const passing: Array<{ s: DerivedSection; cmp: BlockRowsComparison }> = [];
    if (probedTo !== undefined) {
      const extent: BlockExtent = { probedTo, capped: input.liveCapped?.has(eid) === true, boundHits: input.liveBoundHits?.get(eid) ?? [] };
      for (const s of sections) {
        const rows = rowsOf(s.tag);
        const cmp = compareBlockRows(live, rows, probedTo);
        if (confirms(cmp, live, rows, extent)) passing.push({ s, cmp });
      }
    }
    if (passing.length === 1) {
      const { s, cmp } = passing[0]!;
      const evidence: BlockMapEntry['evidence'] = ['device-records'];
      if (hint && (hint.family === s.key || hint.sectionTag === s.tag)) evidence.push('roster');
      out.push({ eid, key: s.key, sectionTag: s.tag, confidence: 'confirmed', evidence, compared: cmp, channels: null });
    } else {
      const candidates = passing.map((p) => p.s.tag).sort((a, b) => a - b);
      out.push({ eid, key: null, sectionTag: null, confidence: 'candidate', evidence: ['device-records'], candidates, channels: null });
    }
  }

  for (const [eid, hint] of hints) {
    if (input.liveBlocks.has(eid)) continue;
    out.push({ eid, key: hint.family, sectionTag: hint.sectionTag, confidence: 'roster', evidence: ['roster'], channels: null });
  }
  return out.sort((a, b) => a.eid - b.eid);
}

/**
 * The editor-cache sections a block may be bound to (the block map and the runtime bulk-shape
 * match use the same rule): an unassigned section (no family; role `new`, `system` or
 * `unclassified`), or — with `familyFirstEid` — the section of a catalog family that has no effect
 * id there (absent or `null`, e.g. the Axe-Fx III Dynamic Distortion: its table is known, its block
 * address is not). A further instance tag of such a family never is (its first tag stands for it).
 */
export function blockBindableSection(s: DerivedSection, familyFirstEid?: Readonly<Record<string, number | null>>): boolean {
  if (s.space !== 'section') return false;
  if (s.family === null) return true;
  return s.role === 'family' && familyFirstEid !== undefined && familyFirstEid[s.family] == null;
}

/**
 * Runtime shape match of a placed block that has no definitions (`likely`, never persisted): the
 * editor-cache sections a block may bind to (`blockBindableSection`: unassigned ones, and with
 * `catalog.familyFirstEid` those of catalog families without an effect id) whose stride fits the
 * bulk read (`itemCount` = stride, or 4 x stride for a channel-bearing block) and whose enum rows
 * hold the read values (raw ordinal inside `enumOrdinalBounds`, integral). `rowsOf(tag)` returns a
 * section's rows (`ranges[section.key]`).
 *
 * `enumRaw`: bulk item index -> raw value. The bulk body is whole channel slices back to back, so
 * item i is pid `i % stride` of the candidate section (for a block without channels, index = pid).
 *
 * Exactly one fitting section: `likely`, its tag, `channels` = itemCount === 4 x stride. Several:
 * `candidate` with their tags (`channels` when they all agree, else null). None: `candidate` with
 * empty `candidates` (no information).
 */
export function matchBulkShape(
  itemCount: number,
  enumRaw: ReadonlyMap<number, number>,
  sections: readonly DerivedSection[],
  rowsOf: (tag: number) => ReadonlyMap<number, RangeDef>,
  catalog?: Pick<ProfileCatalog, 'familyFirstEid'>,
): Pick<BlockMapEntry, 'sectionTag' | 'confidence' | 'candidates' | 'channels'> {
  const fits: Array<{ tag: number; channels: boolean }> = [];
  const seen = new Set<number>();
  for (const s of sections) {
    if (!blockBindableSection(s, catalog?.familyFirstEid) || seen.has(s.tag)) continue;
    seen.add(s.tag);
    const stride = s.stride;
    if (!(stride > 0) || !(itemCount === stride || itemCount === 4 * stride)) continue;
    const rows = rowsOf(s.tag);
    let ok = true;
    for (const [index, raw] of enumRaw) {
      if (!Number.isInteger(index) || index < 0 || index >= itemCount) continue;
      const r = rows.get(index % stride);
      if (r === undefined || r.kind !== 'enum') continue;
      const { lo, hi } = enumOrdinalBounds(r);
      if (!Number.isFinite(raw) || Math.abs(raw - Math.round(raw)) > 1e-6 || raw < lo || raw > hi) {
        ok = false;
        break;
      }
    }
    if (ok) fits.push({ tag: s.tag, channels: itemCount === 4 * stride });
  }
  if (fits.length === 1) return { sectionTag: fits[0]!.tag, confidence: 'likely', channels: fits[0]!.channels };
  const agree = fits.length > 0 && fits.every((f) => f.channels === fits[0]!.channels);
  return { sectionTag: null, confidence: 'candidate', candidates: fits.map((f) => f.tag).sort((a, b) => a - b), channels: agree ? fits[0]!.channels : null };
}

// ---------------------------------------------------------------------------
// Derivation: the persisted map of a document, and the bridging of live blocks
// ---------------------------------------------------------------------------

/** The effect ids the static catalog places (`effectIdOwners`), or null without `familyFirstEid`. */
function staticEids(catalog: Pick<ProfileCatalog, 'familyFirstEid' | 'instanceLimits'> | undefined): ReadonlySet<number> | null {
  const owners = effectIdOwners(catalog);
  return owners ? new Set(owners.keys()) : null;
}

/** Model byte -> the codec's family / effect-id table of that model. */
type EffectIdRow = { readonly family: string; readonly firstId: number | null; readonly instances: number };
const EFFECT_ID_TABLES: ReadonlyMap<number, readonly EffectIdRow[]> = new Map<number, readonly EffectIdRow[]>([
  [0x10, AXE3_EFFECT_ID_TABLE],
  [0x11, FM3_EFFECT_ID_TABLE],
  [0x12, FM9_EFFECT_ID_TABLE],
]);

/**
 * The codec's own effect-id spans of a gen-3 model (Axe-Fx III 0x10, FM3 0x11, FM9 0x12): every
 * family's first effect id (`null` for a family without one, e.g. PRESET) and, as `instanceLimits`,
 * the instance count its effect-id table reserves where that is above one. `null` for any other or
 * an absent model. `deriveProfile` restricts the live vote and the block map to these spans when the
 * caller's catalog has no `familyFirstEid` of its own (a host's table always wins: it may hide a
 * family, or carry the unit's device-true instance counts).
 */
export function effectIdSpansForModel(model: number | undefined): Required<Pick<ProfileCatalog, 'familyFirstEid' | 'instanceLimits'>> | null {
  const table = model === undefined ? undefined : EFFECT_ID_TABLES.get(model);
  if (!table) return null;
  const familyFirstEid: Record<string, number | null> = {};
  const instanceLimits: Record<string, number> = {};
  for (const e of table) {
    if (Object.prototype.hasOwnProperty.call(familyFirstEid, e.family)) continue;
    familyFirstEid[e.family] = e.firstId;
    if (e.firstId !== null && e.instances > 1) instanceLimits[e.family] = e.instances;
  }
  return { familyFirstEid, instanceLimits };
}

/**
 * What a live unit's members say about where `block`'s table ends: the highest ceiling any member
 * whose scope lists the block walked it to (`probedTo`; `undefined` when no scope lists it), whether
 * that ceiling is a cap of the member's mode (`liveWalkCaps`; ties: any), and every member's bound
 * hits on the block.
 */
function unitExtent(u: DerivedUnit, block: number): BlockExtent | undefined {
  let probedTo: number | undefined;
  let capped = false;
  const boundHits: Array<{ bound: number; capped: boolean }> = [];
  for (const m of u.plan.members) {
    if (m.kind === 'editor-cache') continue;
    const caps = liveWalkCaps(m as LiveRawSource);
    for (const h of m.walk.boundHits ?? []) if (h.block === block) boundHits.push({ bound: h.bound, capped: caps.includes(h.bound) });
    if (!m.scope.blocks.includes(block)) continue;
    const c = m.scope.bounds[block] ?? m.scope.maxParamId;
    if (probedTo === undefined || c > probedTo) {
      probedTo = c;
      capped = caps.includes(c);
    } else if (c === probedTo && caps.includes(c)) capped = true;
  }
  return probedTo === undefined ? undefined : { probedTo, capped, boundHits };
}

/** Tag -> the family key a unit's rows of that tag sit under, and the tags of each key's group. */
function unitKeys(u: DerivedUnit): { keyOf: Map<number, string>; repOf: Map<string, number>; groupOf: Map<string, number[]> } {
  const keyOf = new Map<number, string>();
  const repOf = new Map<string, number>();
  const groupOf = new Map<string, number[]>();
  for (const [key, meta] of Object.entries(u.data.rangeSections)) {
    const group = meta.instanceTags ? [...meta.instanceTags] : [meta.sectionTag];
    repOf.set(key, meta.sectionTag);
    groupOf.set(key, group);
    for (const t of group) if (!keyOf.has(t)) keyOf.set(t, key);
  }
  return { keyOf, repOf, groupOf };
}

/**
 * The persisted block map of a document's source units (best-ranked first).
 *
 * Live blocks taking part (first live unit that has the block wins):
 *   - with `catalog.familyFirstEid`: every block outside the static effect-id spans
 *     (`effectIdOwners`). The restricted vote (./profileDoc.ts) leaves such a block unassigned,
 *     unless its table is identical to a placed block's and it joined that family as a further
 *     instance (a copy of a known table, e.g. the modifier slots): that one does not take part;
 *   - without it: the blocks the voter left unassigned.
 * A further instance of an unassigned block group takes part like its first block (its own entry;
 * a live-only entry's key is the group's `block:<eid>`).
 * Editor-cache sections taking part (best-ranked editor-cache unit first): `blockBindableSection`
 * (the unassigned ones, and with `familyFirstEid` the sections of catalog families that have no
 * effect id there).
 * A live-only entry's key is the family the live rows sit under (`block:<eid>` when unassigned).
 * Each block's extent (`probedTo`, cap, bound hits) comes from the scopes and walk statistics of the
 * unit's members (`MatchBlocksInput`); a block no member's scope lists is never `confirmed`.
 *
 * `catalog`: the effect-id spans the unit votes were restricted to (`deriveProfile` passes the
 * host's `familyFirstEid` or the codec default for the model, `effectIdSpansForModel`).
 */
export function deriveBlockMap(units: readonly DerivedUnit[], catalog?: Pick<ProfileCatalog, 'familyFirstEid' | 'instanceLimits'>): BlockMapEntry[] {
  const placed = staticEids(catalog);
  const firstEid = catalog?.familyFirstEid;
  const noEid = (family: string): boolean => firstEid !== undefined && firstEid[family] == null;

  const byteSections: DerivedSection[] = [];
  const byteRows = new Map<number, ReadonlyMap<number, string>>();
  let byteSource = false;
  for (const u of units) {
    if (u.plan.space !== 'section') continue;
    byteSource = true;
    const rows = new Map(u.detail.sections.map((s) => [s.tag, s.rows]));
    for (const s of u.sections) {
      if (byteRows.has(s.tag) || !blockBindableSection(s, firstEid)) continue;
      byteSections.push(s);
      byteRows.set(s.tag, sectionSignatureRows([...(rows.get(s.tag)?.values() ?? [])]));
    }
  }

  const liveBlocks = new Map<number, ReadonlyMap<number, string>>();
  const liveProbedTo = new Map<number, number>();
  const liveCapped = new Set<number>();
  const liveBoundHits = new Map<number, ReadonlyArray<{ bound: number; capped: boolean }>>();
  const liveFamily = new Map<number, string>();
  for (const u of units) {
    if (u.plan.space !== 'block') continue;
    const rows = new Map(u.detail.sections.map((s) => [s.tag, s.rows]));
    const { keyOf, groupOf } = unitKeys(u);
    for (const s of u.sections) {
      if (liveBlocks.has(s.tag)) continue;
      if (placed === null) {
        if (s.family !== null) continue;
      } else {
        if (placed.has(s.tag)) continue;
        if (s.family !== null && !noEid(s.family) && (groupOf.get(s.family) ?? []).some((t) => placed.has(t))) continue;
      }
      liveBlocks.set(s.tag, sectionSignatureRows([...(rows.get(s.tag)?.values() ?? [])]));
      const extent = unitExtent(u, s.tag);
      if (extent !== undefined) {
        liveProbedTo.set(s.tag, extent.probedTo);
        if (extent.capped) liveCapped.add(s.tag);
        if (extent.boundHits.length > 0) liveBoundHits.set(s.tag, extent.boundHits);
      }
      const key = keyOf.get(s.tag);
      if (key !== undefined) liveFamily.set(s.tag, key);
    }
  }

  return matchBlocks({
    byteSections,
    byteRows: (tag) => byteRows.get(tag) ?? new Map(),
    liveBlocks,
    liveProbedTo,
    liveCapped,
    liveBoundHits,
    liveFamily,
    byteSource,
  });
}

/**
 * Live units with every byte-bridged block (`confirmed` by `device-records`) moved to the entry's
 * key, so the merge meets the editor-cache section there instead of a `block:<eid>` family: the
 * family the block's rows sit under (its `block:<eid>` family, or the group's when the block is a
 * further instance), when the block is that family's first tag, is renamed to the key (rows, labels,
 * section meta incl. instance tags; a roster is dropped) — or dropped when the unit already has the
 * key (a further block bridged to the same section) — and every `sections` entry under it takes the
 * key. Units are copied, never modified.
 */
export function bridgeLiveUnits(units: readonly DerivedUnit[], map: readonly BlockMapEntry[]): DerivedUnit[] {
  const bridged = new Map<number, string>();
  for (const e of map) if (e.confidence === 'confirmed' && e.key !== null && e.evidence.includes('device-records')) bridged.set(e.eid, e.key);
  if (bridged.size === 0) return [...units];
  return units.map((u) => {
    if (u.plan.space !== 'block') return u;
    const { keyOf, repOf } = unitKeys(u);
    const ranges = { ...u.data.ranges };
    const enumOverrides = { ...u.data.enumOverrides };
    const rangeSections = { ...u.data.rangeSections };
    const rosters = { ...u.data.rosters };
    const renamed = new Map<string, string>();
    for (const [eid, key] of [...bridged].sort((a, b) => a[0] - b[0])) {
      const from = keyOf.get(eid);
      if (from === undefined || from === key || repOf.get(from) !== eid || ranges[from] === undefined) continue;
      if (ranges[key] === undefined) {
        ranges[key] = ranges[from]!;
        if (enumOverrides[from] !== undefined) enumOverrides[key] = enumOverrides[from]!;
        rangeSections[key] = rangeSections[from]!;
      }
      delete ranges[from];
      delete enumOverrides[from];
      delete rangeSections[from];
      delete rosters[from];
      renamed.set(from, key);
    }
    if (renamed.size === 0) return u;
    const sections = u.sections.map((s) => {
      const key = renamed.get(s.key);
      return key !== undefined ? { ...s, key } : s;
    });
    return { ...u, data: { ...u.data, ranges, enumOverrides, rangeSections, rosters }, sections };
  });
}
