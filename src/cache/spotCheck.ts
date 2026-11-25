/**
 * Spot check: verify shared device definitions against the connected device before they are trusted.
 *
 * A profile from another installation (a cloud source, or a v1 cloud profile) decides which
 * parameters exist and what their ranges are. Before a host adopts it, a few of its rows are read
 * back from the device with READ-ONLY definition queries and compared. Two halves:
 *
 *   1. `spotCheckTargets` (pure, RNG injected) picks the rows to read (`SPOT_CHECK_TARGETS` = 24):
 *        - eligible: a row of a family whose winning source is a cloud source (`winners`), a catalog
 *          family (no `section:` / `block:` key), an informative non-placeholder derived row, and for
 *          a v1 row (no raw records given) not a typecode-0x52 knob row (its display range is a rule,
 *          not the device's) — whose ADDRESS is inside the read-only envelope: a static first effect
 *          id (`eidOf`; first instance only), effect id <= 160 (<= 255 only with the `above160`
 *          gate), pid <= the block's HARD bound (`boundOf`) and <= 127 (<= 255 only with the
 *          `extendedIds` gate), not a GLOBAL pid above 127. A cloud-won row that is otherwise a
 *          candidate but whose address is outside that envelope (no effect id, block not walked,
 *          above its bound or a cap) cannot be verified: it is counted in `pools.unverifiable` so a
 *          host can surface it;
 *        - raw records: what the derivation uses is compared. Placeholder records (flagged, or an
 *          all-zero float) and special records (id >= 0xff00) at the row's address are dropped —
 *          the derivation lets a placeholder fill only an otherwise empty id, and the first real
 *          record wins — and EVERY remaining record must match the device (so extra records can
 *          only make a check stricter). When none remains, the derived row is compared as a v1
 *          row (`rangeMatchesDefinition`): extra records never take a row out of the check;
 *        - priority 1 (<= 16): rows the static catalog lacks (`new`) or that are `incompatible`
 *          with it (`catalogCompare`; a row the host could not classify counts here too) — and,
 *          when the profile is on the catalog's own baseline firmware (`catalogBaseline`), every
 *          row that differs from the catalog row at all (`compatible` too): the catalog is the
 *          truth for that firmware, so any change is suspect. A random 16 when there are more;
 *        - priority 2 (<= 4): on any other firmware, rows that are a `compatible` revision of the
 *          catalog row (expected there: a newer firmware revises rows in place), random;
 *        - priority 3: random from every remaining eligible row (any class) with at most 3 per
 *          family, then — only when the per-family cap left the selection short of N — random from
 *          the rest regardless of family, so a profile that wins few families is still checked
 *          with N rows;
 *        - fewer than 12 eligible rows: `insufficient` (nothing may be adopted); no row of a cloud-
 *          won family at all: `not-needed`.
 *      Rows are ordered by (family, pid) before any random draw, so a seeded RNG (`spotCheckRng`)
 *      gives the same targets for the same input; production uses `crypto.getRandomValues`.
 *
 *   2. `runSpotCheck` sends ONE definition query per target (one retry after the lost-reply drain
 *      pause), decodes the answer with the walk's decoder and pseudo-reply rules, and compares it
 *      with the expected definition:
 *        - a row with raw records (a profile document): `tuplesMatch(rowTuple(device),
 *          rowTuple(record))` against EVERY raw record the winning source unit holds at that
 *          address — kind-free, so the enum value count is compared only when both sides know it
 *          (the device side never does here: no label query is sent);
 *        - a v1 row (derived tables only): `rangeMatchesDefinition` (typecode, display min, display
 *          max);
 *        - a well-formed answer that is an empty slot, an end marker, a no-payload reply, a
 *          sentinel, junk (a 36-byte payload whose fields are not a usable definition) or a copy
 *          where the profile has a real row: a mismatch;
 *        - no answer, or a structurally broken one (a payload count other than 36 or 0, a payload
 *          cut short, a frame too short to carry its header), or a frame that answers another query
 *          (view or pid echo differs): LOST — retried once, then unanswered (never a mismatch: it
 *          cannot be told from a dropped reply). The pid echo checks both halves (`frame[10]`,
 *          `frame[11]`), stricter than the walk, which reads the low half only; that the device
 *          echoes the high half too rests on the host's reply matcher, not on a hardware run of this
 *          code — if it did not, a pid above 127 would read as lost and the check end as
 *          `inconclusive` or `aborted` (safe). The reply checksum is not checked (as in the walk):
 *          its presence on these replies is not verified. After any lost attempt (also one a retry
 *          recovered) the next query waits out the drain pause, because replies echo the view and
 *          pid but not the block. After 2 consecutive unanswered targets the device's liveness is
 *          checked by re-reading the first answered target (or the caller's `anchor` while none
 *          answered); no answer: `aborted` ("device stopped answering"), as the walk does.
 *      Verdict: `passed` iff no mismatch and at least 90 % of the planned targets answered (22 of
 *      24); `failed` on any mismatch; `inconclusive` otherwise, and whenever the time budget
 *      (`SPOT_CHECK_BUDGET_MS`, 15 s) or the query cap (targets + 8, 32 at N = 24) ran out first;
 *      `aborted` when the device stopped answering; `insufficient` (no traffic) for fewer than 12
 *      targets. Units, tapers and labels are never compared.
 *
 * Safety by construction: the runner can only put DEFINITION queries for its own targets (and the
 * caller's anchor) on the wire. Every address is validated before the first query (integer block
 * and pid, an explicit integer bound >= 0 — never a default ceiling —, pid <= that bound, block and
 * pid inside the gated caps) — a violation rejects with `WalkBoundError` and nothing is sent — and
 * the transport is wrapped twice (`guardSpotCheckTransport`): an exact allow-list (definition view,
 * sub 0, the model, the listed (block, pid) pairs only) around the walk's own bound watchdog
 * (`guardWalkTransport` with the targets' bounds as hard per-block bounds). No label query, no value
 * read, no write can leave it. The bounds themselves are the host's: they MUST come from the static
 * catalog or a LOCAL byte-exact source of this installation, never from cloud data.
 *
 * Trust of the inputs: which rows a cloud source decides (`winners`, `spotCheckRows`) must be
 * computed by the HOST from raw sources it validated and derived itself — a document's own
 * `provenance` or source `origin` fields as downloaded are attacker-controlled. `spotCheckRows`
 * fails closed (a family whose winning source is missing or unknown counts as cloud-won) and takes
 * the host's list of cloud source ids; a v1 document is passed as `{ ranges }` only.
 *
 * Pure and browser-safe: no `node:*`, no `Buffer`; pacing and pauses use the ambient `setTimeout`
 * or an injected `sleep`, the clock `Date.now` or an injected `now`.
 */
import { KNOB_TYPECODE, rangeRowOf } from './assign.js';
import { tuplesMatch } from './blockMap.js';
import { canonicalNumber as num, isInformativeRow, isPlaceholderRow } from './fingerprint.js';
import {
  buildDefQuery,
  decodeReply,
  decodeWalkQuery,
  DEFAULT_LOST_REPLY_DRAIN_MS,
  guardWalkTransport,
  judgeDefinition,
  LIVE_WALK_LIMITS,
  REPLY_SENTINEL_TAGS,
  VIEW_DEFINITION,
  WalkBoundError,
} from './liveWalk.js';
import type { LiveDefinition, LiveTransport, LiveWalkOptions } from './liveWalk.js';
import { planSourceUnits } from './merge.js';
import type { ProfileProvenance, SourceUnitPlan } from './merge.js';
import { isSyntheticFamilyKey } from './profileDoc.js';
import type { ProfileRaw, SourceOrigin } from './profileDoc.js';
import { isPlaceholderRecord, rowTuple } from './rowTuple.js';
import type { TupleRecord } from './rowTuple.js';
import type { FloatRecord, RangeDef } from './types.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Targets per spot check (N). */
export const SPOT_CHECK_TARGETS = 24;
/** Time budget of one spot check, ms; running out makes the check `inconclusive`. */
export const SPOT_CHECK_BUDGET_MS = 15_000;

/**
 * The numbers of the spot check (see the module comment):
 *   - `targets` N, `minTargets` the fewest eligible rows (and targets) a check runs with;
 *   - `newRows` / `changedRows` the caps of priority 1 / 2, `perFamily` the priority-3 cap per family;
 *   - `passPercent` the share of planned targets that must answer for `passed`;
 *   - `budgetMs`, `extraQueries` (query cap = targets + this), `maxFailures` (failures listed);
 *   - `silentTargets` consecutive unanswered targets before a liveness re-read;
 *   - `maxBlock` / `maxBlockGated`, `maxParamId` / `maxParamIdGated`: the address caps without /
 *     with the `above160` / `extendedIds` gates (the walk's read-only envelope);
 *   - `pacingMs` default pause before every query, `drainMs` the walk's lost-reply drain pause.
 */
export const SPOT_CHECK_LIMITS = Object.freeze({
  targets: SPOT_CHECK_TARGETS,
  minTargets: 12,
  newRows: 16,
  changedRows: 4,
  perFamily: 3,
  passPercent: 90,
  budgetMs: SPOT_CHECK_BUDGET_MS,
  extraQueries: 8,
  maxFailures: 8,
  silentTargets: 2,
  maxBlock: LIVE_WALK_LIMITS.standardMaxBlock,
  maxBlockGated: 255,
  maxParamId: LIVE_WALK_LIMITS.readOnlyMaxParamId,
  maxParamIdGated: LIVE_WALK_LIMITS.extendedReadOnlyMaxParamId,
  pacingMs: 3,
  drainMs: DEFAULT_LOST_REPLY_DRAIN_MS,
});

/** GLOBAL ids above the read-only envelope are never spot-checked (a sparse system table). */
const GLOBAL_FAMILY = 'GLOBAL';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * How a profile row relates to the static catalog row at the same pid (the host's catalog
 * comparison): `new` (no informative catalog row), `incompatible`, `compatible` (a revision of the
 * catalog row: same kind, overlapping span), `exact` (same fingerprint).
 */
export type SpotCheckRowClass = 'new' | 'incompatible' | 'compatible' | 'exact';

/** The derived-row fields the spot check reads. */
export type SpotCheckRange = Pick<RangeDef, 'kind' | 'typecode' | 'displayMin' | 'displayMax' | 'scale'> & { enumCount?: number };

/** One row of the candidate profile (see `spotCheckRows`). */
export interface SpotCheckRow {
  /** Family key of the merged profile. */
  family: string;
  pid: number;
  /** The merged (derived) row. */
  range: SpotCheckRange;
  /**
   * The raw records the winning source unit holds at the row's address (normally one), for a
   * profile document. Absent (or empty) for a v1 row: the range row is compared instead.
   */
  records?: readonly TupleRecord[];
}

/** Host gates that widen the read-only envelope (both off by default). */
export interface SpotCheckGates {
  /** Effect ids above 160 were verified for this model and firmware. */
  above160?: boolean;
  /** Ids above 127 in known tables were verified for this model and firmware. */
  extendedIds?: boolean;
}

export interface SpotCheckTargetsInput {
  /** Rows of the candidate profile. */
  rows: Iterable<SpotCheckRow>;
  /** Families whose winning source (existence facts) is a cloud source. */
  winners: Iterable<string>;
  /** The row's class against the static catalog; `undefined` counts as `new`. */
  catalogCompare: (family: string, pid: number) => SpotCheckRowClass | undefined;
  /**
   * The profile's firmware equals the static catalog's baseline firmware for the model (e.g.
   * `FM3_CATALOG_BASELINE.firmware`): then a `compatible` row is a priority-1 row like an
   * `incompatible` one (see the module comment). False on any other or an unknown firmware, where
   * compatible revisions are expected and go to priority 2. Required, so a host decides it explicitly.
   */
  catalogBaseline: boolean;
  /** The family's static first effect id; `null` / `undefined` = not addressable. */
  eidOf: (family: string) => number | null | undefined;
  /**
   * The block's HARD bound: the highest pid a read-only walk may query there (inclusive), e.g.
   * `walkBlockLimits(model, 'read-only', localByteSource(doc)).bound[eid]` — derived from the STATIC
   * catalog or a LOCAL byte-exact source only, never from cloud data, and never a walk's default
   * ceiling for a block without a hard bound. A negative integer = no hard bound / not walked: the
   * block's rows are unverifiable. Anything but an integer (undefined, NaN, a fraction) is a host
   * bug: `spotCheckTargets` throws a `TypeError`.
   */
  boundOf: (eid: number) => number;
  gates?: SpotCheckGates;
  /** Targets wanted (default `SPOT_CHECK_TARGETS`). */
  n?: number;
  /** Uniform random numbers in [0, 1) (`spotCheckRng`). */
  rng: () => number;
}

/** One planned definition query and the definition the device must answer. */
export interface SpotCheckTarget {
  family: string;
  pid: number;
  /** Effect id queried (the family's static first effect id). */
  block: number;
  /** The block's query bound (static / local), capped by the gated id envelope. */
  bound: number;
  priority: 1 | 2 | 3;
  range: SpotCheckRange;
  /** Expected raw records (tuple fields only); absent for a v1 row. */
  records?: TupleRecord[];
}

export interface SpotCheckPlan {
  /** `insufficient`: fewer than `needed` eligible rows; `not-needed`: no row of a cloud-won family. */
  status: 'ready' | 'insufficient' | 'not-needed';
  /** Eligible rows. */
  eligible: number;
  /** Fewest eligible rows a check runs with (`SPOT_CHECK_LIMITS.minTargets`). */
  needed: number;
  /**
   * Eligible rows per priority class (`new` = new + incompatible + unclassified, + compatible on the
   * catalog baseline), and `unverifiable`: cloud-won candidate rows whose address lies outside the
   * read-only envelope (no static effect id, block not walked, above the block's bound, the id or
   * block cap, GLOBAL above 127) — the cloud decides them, the check cannot read them.
   */
  pools: { new: number; changed: number; other: number; unverifiable: number };
  /** Empty unless `ready`; priority 1 first, then 2, then 3. */
  targets: SpotCheckTarget[];
}

/** A definition query outside the target list's own rows: a liveness anchor (a catalog row). */
export interface SpotCheckAnchor {
  block: number;
  pid: number;
  bound: number;
}

export interface SpotCheckRunOptions {
  /** Device model byte. */
  model: number;
  targets: readonly SpotCheckTarget[];
  /** Pause before every query, ms (default 3, the hardware-proven walk pace). Finite, >= 0. */
  pacingMs?: number;
  /**
   * Per-query timeout, ms, raced against the transport's request (default none). Leave it unset, or
   * set it at or above the transport's own timeout: a shorter one only turns slow answers into lost
   * ones. Finite, > 0 when given.
   */
  timeoutMs?: number;
  /** Time budget, ms (default `SPOT_CHECK_BUDGET_MS`). Finite, >= 0. */
  budgetMs?: number;
  /** Pause after a lost reply before the next query, ms (default the walk's 500). Finite, >= 0. */
  drainMs?: number;
  /** Query cap, retries and liveness re-reads included (default targets + 8). An integer >= 0. */
  maxQueries?: number;
  /** Liveness re-read while no target has answered yet (a catalog row inside its bound). */
  anchor?: SpotCheckAnchor;
  gates?: SpotCheckGates;
  signal?: AbortSignal;
  /** Called after every target. */
  onProgress?: (p: { done: number; total: number }) => void;
  /** Scheduler seam for pauses (default the ambient `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
  /** Clock seam for the budget (default `Date.now`). */
  now?: () => number;
}

export type SpotCheckVerdict = 'passed' | 'failed' | 'inconclusive' | 'aborted' | 'insufficient';

/** Why an answered target did not match: the definition differs, or the device has no real row there. */
export type SpotCheckMismatchReason = 'differs' | 'empty-slot' | 'end-marker' | 'no-definition' | 'pseudo';

export interface SpotCheckTargetResult {
  family: string;
  pid: number;
  block: number;
  priority: 1 | 2 | 3;
  /** `not-checked`: the check stopped before this target. */
  outcome: 'match' | 'mismatch' | 'unanswered' | 'not-checked';
  reason?: SpotCheckMismatchReason;
}

/** Outcome of `runSpotCheck` (definitions only; no parameter value is ever read). */
export interface SpotCheckResult {
  verdict: SpotCheckVerdict;
  /** Targets given. */
  planned: number;
  /** Targets queried. */
  checked: number;
  /** Targets the device answered (match or mismatch). */
  answered: number;
  mismatches: number;
  /** The first mismatched rows (at most `SPOT_CHECK_LIMITS.maxFailures`). */
  failures: Array<{ family: string; pid: number }>;
  durationMs: number;
  /** Queries sent: retries and liveness re-reads included. */
  queries: number;
  /** Why the check ended before its last target. */
  stopped?: 'budget' | 'queries' | 'device-stopped-answering';
  /** One per target, in target order. */
  results: SpotCheckTargetResult[];
}

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------

/**
 * Random source for `spotCheckTargets`: with a `seed`, a deterministic generator (mulberry32 over
 * the seed's low 32 bits) for tests and reproducible plans; without one, `crypto.getRandomValues`
 * (throws when the runtime has none).
 */
export function spotCheckRng(seed?: number): () => number {
  if (seed !== undefined) {
    if (!Number.isFinite(seed)) throw new TypeError('spotCheckRng: seed must be a finite number');
    let a = Math.floor(seed) >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const c = (globalThis as { crypto?: { getRandomValues?: <T extends ArrayBufferView>(a: T) => T } }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('spotCheckRng: crypto.getRandomValues is not available');
  const buf = new Uint32Array(1);
  return () => {
    c.getRandomValues!(buf);
    return buf[0]! / 4294967296;
  };
}

/** A draw from `rng` as an index below `n`; a value outside [0, 1) is a caller bug. */
function drawIndex(rng: () => number, n: number): number {
  const r = rng();
  if (typeof r !== 'number' || !(r >= 0 && r < 1)) throw new RangeError('spotCheckTargets: rng must return a number in [0, 1)');
  return Math.min(n - 1, Math.floor(r * n));
}

/** Fisher-Yates over a copy: the first `k` entries of a uniform random permutation. */
function sample<T>(items: readonly T[], k: number, rng: () => number): T[] {
  const a = [...items];
  const take = Math.max(0, Math.min(k, a.length));
  for (let i = 0; i < take; i++) {
    const j = i + drawIndex(rng, a.length - i);
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a.slice(0, take);
}

// ---------------------------------------------------------------------------
// Rows of a candidate profile
// ---------------------------------------------------------------------------

/** The document fields `spotCheckRows` reads (a v2 `ProfileDoc` or a v1 `BuiltCache`). */
export interface SpotCheckDoc {
  ranges: Readonly<Record<string, Readonly<Record<number, SpotCheckRange>>>>;
  rangeSections?: Readonly<Record<string, { sectionTag: number }>>;
  raw?: ProfileRaw | null;
  provenance?: Pick<ProfileProvenance, 'existence'> | null;
}

/** The tuple fields of a record (no labels, units or tapers travel with a target). */
function tupleFields(r: TupleRecord): TupleRecord {
  const out: TupleRecord = { kind: r.kind, id: r.id, tc: r.tc, min: r.min, max: r.max, def: r.def, step: r.step };
  if (r.kind === 'enum' && r.count !== undefined) out.count = r.count;
  if (r.placeholder === true) out.placeholder = true;
  return out;
}

/** The range fields a target carries. */
function rangeFields(r: SpotCheckRange): SpotCheckRange {
  const out: SpotCheckRange = { kind: r.kind, typecode: r.typecode, displayMin: r.displayMin, displayMax: r.displayMax, scale: r.scale };
  if (r.enumCount !== undefined) out.enumCount = r.enumCount;
  return out;
}

/** Which sources of a candidate document are cloud sources (see `spotCheckRows`). */
export interface SpotCheckRowsOptions {
  /**
   * Ids of the raw sources the HOST merged in from the cloud (preferred). When given, a family is
   * cloud-won when its winning source id is listed here — whatever `origin` the source carries.
   */
  cloudSourceIds?: Iterable<string>;
  /** Without `cloudSourceIds`: the source origins that count as cloud (default `['cloud']`). */
  origins?: readonly SourceOrigin[];
}

/**
 * The rows and cloud-won families of a candidate profile, ready for `spotCheckTargets`.
 *
 * TRUST: pass a document the HOST derived itself (`deriveProfile` over raw sources it validated, the
 * foreign ones rewritten to origin `cloud`), with the host's own `cloudSourceIds`. A downloaded
 * document's `raw`, `provenance` and source `origin` fields are attacker-controlled: a v1 document
 * (or anything downloaded that the host did not derive) is passed as `{ ranges }` only.
 *
 * A profile document (raw sources + `provenance.existence`): a catalog family is cloud-won when the
 * source that provides its existence facts is a cloud source (`cloudSourceIds`, else its `origin` in
 * `origins`) — and, failing CLOSED, when the family has no existence entry or names a source the
 * document does not carry. Each row of a cloud-won family carries the raw records that source's unit
 * (sources of one kind and origin, combined as the derivation combines them: `planSourceUnits`) holds
 * at the family's section or block (`rangeSections[family].sectionTag`) and pid — distinct tuples,
 * placeholders included (`spotCheckTargets` drops them). A row whose records cannot be found carries
 * none and is compared as a v1 row.
 *
 * A v1 document (no raw sources or no provenance): every catalog family is cloud-won (the whole
 * document is adopted from the cloud) and no row carries records.
 *
 * Synthetic family keys (`section:<tag>` / `block:<eid>`) are never listed.
 */
export function spotCheckRows(doc: SpotCheckDoc, opts: SpotCheckRowsOptions = {}): { rows: SpotCheckRow[]; winners: string[] } {
  const rows: SpotCheckRow[] = [];
  const winners: string[] = [];
  const families = Object.keys(doc.ranges ?? {}).filter((f) => !isSyntheticFamilyKey(f));
  const sources = doc.raw && Array.isArray(doc.raw.sources) ? doc.raw.sources : null;
  const existence = doc.provenance?.existence;
  const pidsOf = (family: string): number[] =>
    Object.keys(doc.ranges[family] ?? {})
      .map(Number)
      .filter((p) => Number.isInteger(p) && p >= 0)
      .sort((a, b) => a - b);

  if (!sources || !existence) {
    for (const family of families) {
      winners.push(family);
      for (const pid of pidsOf(family)) rows.push({ family, pid, range: doc.ranges[family]![pid]! });
    }
    return { rows, winners };
  }

  const cloudIds = opts.cloudSourceIds !== undefined ? new Set(opts.cloudSourceIds) : null;
  const origins = new Set<SourceOrigin>(opts.origins ?? ['cloud']);
  const byId = new Map(sources.map((s) => [s.id, s]));
  let plans: SourceUnitPlan[] | undefined;
  const index = new Map<SourceUnitPlan, Map<string, TupleRecord[]>>();
  const recordsAt = (sourceId: string, section: number, pid: number): TupleRecord[] => {
    plans ??= planSourceUnits(sources);
    const plan = plans.find((p) => p.members.some((m) => m.id === sourceId));
    if (!plan) return [];
    let at = index.get(plan);
    if (!at) {
      at = new Map();
      for (const r of plan.records) {
        const key = `${r.section}:${r.id}`;
        const list = at.get(key);
        const t = tupleFields(r);
        if (!list) at.set(key, [t]);
        else if (!list.some((x) => rowTuple(x) === rowTuple(t) && x.kind === t.kind && x.placeholder === t.placeholder)) list.push(t);
      }
      index.set(plan, at);
    }
    return at.get(`${section}:${pid}`) ?? [];
  };

  for (const family of families) {
    const winnerId = Object.prototype.hasOwnProperty.call(existence, family) ? existence[family] : undefined;
    const source = typeof winnerId === 'string' ? byId.get(winnerId) : undefined;
    // Fail closed: no existence entry, or one naming a source the document lacks, counts as cloud-won.
    const cloudWon = !source || (cloudIds ? cloudIds.has(source.id) : origins.has(source.origin));
    if (!cloudWon) continue;
    winners.push(family);
    const tag = doc.rangeSections?.[family]?.sectionTag;
    for (const pid of pidsOf(family)) {
      const range = doc.ranges[family]![pid]!;
      const records = source && typeof tag === 'number' ? recordsAt(source.id, tag, pid) : [];
      rows.push(records.length > 0 ? { family, pid, range, records } : { family, pid, range });
    }
  }
  return { rows, winners };
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

/** The id and block caps of the read-only envelope under the gates. */
function envelope(gates: SpotCheckGates | undefined): { maxBlock: number; maxParamId: number } {
  return {
    maxBlock: gates?.above160 === true ? SPOT_CHECK_LIMITS.maxBlockGated : SPOT_CHECK_LIMITS.maxBlock,
    maxParamId: gates?.extendedIds === true ? SPOT_CHECK_LIMITS.maxParamIdGated : SPOT_CHECK_LIMITS.maxParamId,
  };
}

/**
 * The records the comparison uses: what the derivation can have used — every record at the address
 * except placeholders (flagged, or an all-zero float) and special records (id >= 0xff00). `null`: the
 * row came without records (a v1 row). An empty list: records were given but none is usable; the
 * derived row is then compared as a v1 row. Extra records never make a row ineligible.
 */
function usableRecords(row: SpotCheckRow): TupleRecord[] | null {
  const recs = row.records;
  if (!recs || recs.length === 0) return null;
  const out: TupleRecord[] = [];
  for (const r of recs) {
    if (!r || typeof r !== 'object' || isPlaceholderRecord(r) || !(r.id < 0xff00)) continue;
    out.push(tupleFields(r));
  }
  return out;
}

type Eligibility = { target: Omit<SpotCheckTarget, 'priority'> } | 'skip' | 'unverifiable';

/**
 * A row as a target; `skip` when it is no candidate (not cloud-won, synthetic, not an informative
 * row, a v1 knob row); `unverifiable` when it is a candidate whose address lies outside the
 * read-only envelope (see the module comment). Throws `TypeError` when `boundOf` returns no integer.
 */
function eligibility(row: SpotCheckRow, input: SpotCheckTargetsInput, winners: ReadonlySet<string>, env: { maxBlock: number; maxParamId: number }): Eligibility {
  const { family, pid, range } = row;
  if (typeof family !== 'string' || !winners.has(family) || isSyntheticFamilyKey(family)) return 'skip';
  if (!Number.isInteger(pid) || pid < 0) return 'skip';
  if (!range || !isInformativeRow(range) || isPlaceholderRow(range)) return 'skip';
  const records = usableRecords(row);
  if (records === null && range.typecode === KNOB_TYPECODE) return 'skip'; // the 0..10 knob display is a rule, not the device's
  const eid = input.eidOf(family);
  if (typeof eid !== 'number' || !Number.isInteger(eid) || eid < 0 || eid > env.maxBlock) return 'unverifiable';
  const bound = input.boundOf(eid);
  if (typeof bound !== 'number' || !Number.isInteger(bound)) {
    throw new TypeError(`spotCheckTargets: boundOf(${eid}) must return the block's hard bound as an integer (negative = none)`);
  }
  if (bound < 0 || pid > bound || pid > env.maxParamId) return 'unverifiable';
  if (family === GLOBAL_FAMILY && pid > LIVE_WALK_LIMITS.readOnlyMaxParamId) return 'unverifiable';
  const target: Omit<SpotCheckTarget, 'priority'> = { family, pid, block: eid, bound: Math.min(bound, env.maxParamId), range: rangeFields(range) };
  if (records !== null && records.length > 0) target.records = records;
  return { target };
}

/**
 * Pick the rows to read back from the device (eligibility, priorities and caps: see the module
 * comment). Pure; all randomness comes from `rng`.
 */
export function spotCheckTargets(input: SpotCheckTargetsInput): SpotCheckPlan {
  const n = input.n ?? SPOT_CHECK_TARGETS;
  if (!Number.isInteger(n) || n < 1) throw new RangeError('spotCheckTargets: n must be a positive integer');
  const needed = SPOT_CHECK_LIMITS.minTargets;
  const winners = new Set(input.winners);
  const env = envelope(input.gates);

  let cloudRows = 0;
  let unverifiable = 0;
  const seen = new Set<string>();
  const eligible: Array<Omit<SpotCheckTarget, 'priority'> & { cls: SpotCheckRowClass }> = [];
  for (const row of input.rows) {
    if (!row || !winners.has(row.family)) continue;
    cloudRows += 1;
    const key = `${row.family}\u0000${String(row.pid)}`;
    if (seen.has(key)) continue; // one target per (family, pid)
    seen.add(key);
    const e = eligibility(row, input, winners, env);
    if (e === 'skip') continue;
    if (e === 'unverifiable') {
      unverifiable += 1;
      continue;
    }
    const t = e.target;
    const c = input.catalogCompare(t.family, t.pid);
    const cls: SpotCheckRowClass = c === 'exact' || c === 'compatible' || c === 'incompatible' ? c : 'new';
    eligible.push({ ...t, cls });
  }
  // Deterministic order before any draw: by family, then pid.
  eligible.sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : a.pid - b.pid));

  // On the catalog's own firmware any difference from the catalog row is suspect: compatible rows join P1.
  const baseline = input.catalogBaseline === true;
  const p1 = eligible.filter((t) => t.cls === 'new' || t.cls === 'incompatible' || (baseline && t.cls === 'compatible'));
  const p2 = baseline ? [] : eligible.filter((t) => t.cls === 'compatible');
  const pools = { new: p1.length, changed: p2.length, other: eligible.length - p1.length - p2.length, unverifiable };
  if (cloudRows === 0) return { status: 'not-needed', eligible: eligible.length, needed, pools, targets: [] };
  if (eligible.length < needed) return { status: 'insufficient', eligible: eligible.length, needed, pools, targets: [] };

  const strip = ({ cls: _cls, ...t }: (typeof eligible)[number], priority: 1 | 2 | 3): SpotCheckTarget => ({ ...t, priority });
  const picked = new Set<(typeof eligible)[number]>();
  const targets: SpotCheckTarget[] = [];
  const take = (t: (typeof eligible)[number], priority: 1 | 2 | 3) => {
    picked.add(t);
    targets.push(strip(t, priority));
  };
  for (const t of sample(p1, Math.min(SPOT_CHECK_LIMITS.newRows, n), input.rng)) take(t, 1);
  for (const t of sample(p2, Math.min(SPOT_CHECK_LIMITS.changedRows, n - targets.length), input.rng)) take(t, 2);
  if (targets.length < n) {
    const rest = sample(
      eligible.filter((t) => !picked.has(t)),
      eligible.length,
      input.rng,
    );
    const perFamily = new Map<string, number>();
    for (const t of rest) {
      if (targets.length >= n) break;
      const k = perFamily.get(t.family) ?? 0;
      if (k >= SPOT_CHECK_LIMITS.perFamily) continue;
      perFamily.set(t.family, k + 1);
      take(t, 3);
    }
    // The per-family cap only spreads the random rows; it never leaves the check short of N.
    for (const t of rest) {
      if (targets.length >= n) break;
      if (!picked.has(t)) take(t, 3);
    }
  }
  return { status: 'ready', eligible: eligible.length, needed, pools, targets };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** The device's answer as a tuple record: kind-free (a float row, so no value count is claimed). */
function deviceRecord(d: Pick<LiveDefinition, 'tc' | 'min' | 'max' | 'def' | 'step'>, pid: number): FloatRecord {
  return { kind: 'float', section: 0, offset: 0, id: pid, tc: d.tc, min: d.min, max: d.max, def: d.def, step: d.step, t1: 0, t2: 0 };
}

/**
 * Does a v1 range row (derived tables only, no raw record) describe the device's definition?
 * Compares the typecode and the display bounds the codec derives from the definition (`rangeRowOf`:
 * min / max times the display multiplier), by the fingerprint's canonical number text (six
 * significant digits). The enum value count is not compared — the device side knows none without a
 * label query, which the spot check never sends; the ordinal bounds are part of the display bounds.
 * A typecode-0x52 knob row shows a fixed 0..10 display whatever the definition says, so it is not
 * checkable this way (the target selection leaves such v1 rows out).
 */
export function rangeMatchesDefinition(
  range: Pick<RangeDef, 'typecode' | 'displayMin' | 'displayMax'>,
  def: Pick<LiveDefinition, 'tc' | 'min' | 'max' | 'def' | 'step'>,
): boolean {
  if (range.typecode !== def.tc) return false;
  const dev = rangeRowOf(deviceRecord(def, 0)).row;
  return num(dev.displayMin) === num(range.displayMin) && num(dev.displayMax) === num(range.displayMax);
}

/** The device's definition against a target's expectation. */
function definitionMatches(t: Pick<SpotCheckTarget, 'records' | 'range' | 'pid'>, d: LiveDefinition): boolean {
  if (t.records && t.records.length > 0) {
    const dev = rowTuple(deviceRecord(d, t.pid));
    return t.records.every((r) => tuplesMatch(dev, rowTuple(r)));
  }
  return rangeMatchesDefinition(t.range, d);
}

// ---------------------------------------------------------------------------
// Transport guard
// ---------------------------------------------------------------------------

/** One address a spot check may query. */
type Address = { block: number; pid: number; bound: number };

function refuse(model: number, a: { block: unknown; pid: unknown }, why: string): WalkBoundError {
  const block = typeof a.block === 'number' ? a.block : -1;
  const param = typeof a.pid === 'number' ? a.pid : -1;
  return new WalkBoundError(`spotCheck: refused block ${String(a.block)} param ${String(a.pid)} (${why})`, { model, view: VIEW_DEFINITION, block, param, sub: 0 });
}

/** Every address valid and inside the gated envelope, else `WalkBoundError` (nothing is sent). */
function checkAddresses(model: number, addresses: readonly Address[], gates: SpotCheckGates | undefined): void {
  const env = envelope(gates);
  for (const a of addresses) {
    if (!a || typeof a !== 'object') throw refuse(model, { block: undefined, pid: undefined }, 'not an address');
    if (!Number.isInteger(a.block) || a.block < 0 || a.block > env.maxBlock) throw refuse(model, a, `block outside 0..${env.maxBlock}`);
    if (!Number.isInteger(a.bound) || a.bound < 0) throw refuse(model, a, 'no usable bound');
    if (!Number.isInteger(a.pid) || a.pid < 0) throw refuse(model, a, 'not a param id');
    if (a.pid > Math.min(a.bound, env.maxParamId)) throw refuse(model, a, `above its bound ${Math.min(a.bound, env.maxParamId)}`);
  }
}

/**
 * Wrap a transport so that only the spot check's own definition queries can pass: an exact
 * allow-list (a definition query of `model`, sub 0, for one of the listed (block, pid) addresses)
 * around the walk's bound watchdog (`guardWalkTransport` scoped to the listed blocks, each bounded
 * by the lowest bound listed for it, and the gated id cap). Anything else rejects with
 * `WalkBoundError` before it reaches `transport`. Throws `WalkBoundError` up front for an address
 * that is not valid or lies outside the gated envelope.
 */
export function guardSpotCheckTransport(
  transport: LiveTransport,
  scope: { model: number; targets: readonly Address[]; anchor?: Address; gates?: SpotCheckGates },
): LiveTransport {
  const model = scope.model & 0x7f;
  const addresses: Address[] = [...scope.targets, ...(scope.anchor ? [scope.anchor] : [])];
  checkAddresses(model, addresses, scope.gates);
  const env = envelope(scope.gates);
  const bounds: Record<number, number> = {};
  const allowed = new Set<string>();
  for (const a of addresses) {
    const b = Math.min(a.bound, env.maxParamId);
    bounds[a.block] = bounds[a.block] === undefined ? b : Math.min(bounds[a.block]!, b);
    allowed.add(`${a.block}:${a.pid}`);
  }
  const walkScope: LiveWalkOptions = {
    model,
    mode: 'read-only',
    blocks: Object.keys(bounds).map(Number),
    paramBoundByBlock: bounds,
    maxParamId: env.maxParamId,
  };
  const bounded = guardWalkTransport(transport, walkScope, { maxParamId: env.maxParamId });
  const guarded: LiveTransport = {
    request(query: Uint8Array): Promise<Uint8Array | null> {
      const q = decodeWalkQuery(query);
      if (q === null || q.model !== model || q.view !== VIEW_DEFINITION || q.sub !== 0) {
        return Promise.reject(new WalkBoundError('spotCheck: refused a frame that is not a definition query', q));
      }
      if (!allowed.has(`${q.block}:${q.param}`)) {
        return Promise.reject(new WalkBoundError(`spotCheck: refused a query for block ${q.block} param ${q.param} (not a target)`, q));
      }
      return bounded.request(query);
    },
  };
  if (bounded.drain) guarded.drain = () => bounded.drain!();
  return guarded;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = (signal as { reason?: unknown }).reason;
    throw reason instanceof Error ? reason : new Error('spot check aborted');
  }
}

async function pause(ms: number, sleep?: (ms: number) => Promise<void>): Promise<void> {
  if (!(ms > 0)) return;
  if (sleep) await sleep(ms);
  else await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** `transport.request`, resolved with `null` when `timeoutMs` passes first (a later reply is ignored). */
function requestWithin(transport: LiveTransport, query: Uint8Array, timeoutMs: number | undefined): Promise<Uint8Array | null> {
  const pending = transport.request(query);
  if (timeoutMs === undefined || !(timeoutMs > 0) || !Number.isFinite(timeoutMs)) return pending;
  return new Promise<Uint8Array | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    pending.then(
      (frame) => {
        clearTimeout(timer);
        resolve(frame);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * A self-describe reply that answers a DEFINITION query for `pid`: it echoes the definition view and
 * both param halves. (The block address is not echoed, so a late reply for the same pid of another
 * block cannot be told apart — the runner drains after every loss.)
 */
function answersDefinition(frame: Uint8Array, pid: number): boolean {
  const n = frame.length;
  return (
    n >= 14 &&
    frame[0] === 0xf0 &&
    frame[1] === 0x00 &&
    frame[2] === 0x01 &&
    frame[3] === 0x74 &&
    frame[5] === 0x01 &&
    frame[n - 1] === 0xf7 &&
    frame[6] === VIEW_DEFINITION &&
    frame[10] === (pid & 0x7f) &&
    frame[11] === ((pid >> 7) & 0x7f)
  );
}

/** Payload bytes of a definition record. */
const DEFINITION_BYTES = 36;

/** What a frame is as the answer to a definition query for one pid (see the module comment). */
type ReplyShape = { def: LiveDefinition } | 'no-definition' | 'junk' | 'lost';

/**
 * Classify a frame: `lost` when it does not answer this query (view / pid echo) or is structurally
 * broken (too short for its header, a payload count other than 0 or 36, a payload cut short);
 * `no-definition` for a well-formed sentinel or no-payload reply; `junk` for a complete 36-byte
 * payload that does not decode to a definition (non-finite fields); else the decoded definition.
 */
function replyShape(frame: Uint8Array, pid: number): ReplyShape {
  if (!answersDefinition(frame, pid)) return 'lost';
  const inner = frame.subarray(6, frame.length - 2);
  if (inner.length < 7) return 'lost';
  if (REPLY_SENTINEL_TAGS.has(inner[6]!)) return 'no-definition';
  if (inner.length < 15) return 'lost';
  const cnt = inner[13]! | (inner[14]! << 8);
  if (cnt === 0) return 'no-definition';
  if (cnt !== DEFINITION_BYTES || inner.length < 15 + Math.ceil((DEFINITION_BYTES * 8) / 7)) return 'lost';
  const dec = decodeReply(frame);
  return dec && dec.view === 'definition' ? { def: dec } : 'junk';
}

/** A finite number >= 0 (`integer`: also an integer), or undefined; else `RangeError`. */
function checkOption(name: string, v: unknown, integer = false): void {
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (integer && !Number.isInteger(v))) {
    throw new RangeError(`runSpotCheck: ${name} must be a finite ${integer ? 'integer' : 'number'} >= 0`);
  }
}

/**
 * Read the targets back from the device and judge the candidate profile (see the module comment).
 * Throws `RangeError` for invalid options and rejects with `WalkBoundError` — both before any query —
 * when a target or the anchor lies outside its bound or the gated envelope; with the signal's reason
 * when aborted; with a transport error as is.
 */
export async function runSpotCheck(transport: LiveTransport, opts: SpotCheckRunOptions): Promise<SpotCheckResult> {
  const { model, targets, anchor, gates, signal, sleep, onProgress } = opts;
  if (!Number.isInteger(model) || model < 0 || model > 0x7f) throw new RangeError('runSpotCheck: model must be a model byte (0..127)');
  if (!Array.isArray(targets)) throw new TypeError('runSpotCheck: targets must be an array');
  checkOption('pacingMs', opts.pacingMs);
  checkOption('drainMs', opts.drainMs);
  checkOption('budgetMs', opts.budgetMs);
  checkOption('maxQueries', opts.maxQueries, true);
  if (opts.timeoutMs !== undefined && !(typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0)) {
    throw new RangeError('runSpotCheck: timeoutMs must be a finite number > 0 (or unset)');
  }
  const now = opts.now ?? Date.now;
  const start = now();
  const guarded = guardSpotCheckTransport(transport, { model, targets, ...(anchor ? { anchor } : {}), ...(gates ? { gates } : {}) });
  const planned = targets.length;
  const results: SpotCheckTargetResult[] = targets.map((t) => ({ family: t.family, pid: t.pid, block: t.block, priority: t.priority, outcome: 'not-checked' }));
  const failures: Array<{ family: string; pid: number }> = [];
  let queries = 0;
  let checked = 0;
  let answered = 0;
  let mismatches = 0;
  let stopped: SpotCheckResult['stopped'];
  const finish = (verdict: SpotCheckVerdict): SpotCheckResult => ({
    verdict,
    planned,
    checked,
    answered,
    mismatches,
    failures,
    durationMs: Math.max(0, now() - start),
    queries,
    ...(stopped !== undefined ? { stopped } : {}),
    results,
  });
  if (planned < SPOT_CHECK_LIMITS.minTargets) return finish('insufficient');

  const pacingMs = opts.pacingMs ?? SPOT_CHECK_LIMITS.pacingMs;
  const drainMs = opts.drainMs ?? SPOT_CHECK_LIMITS.drainMs;
  const budgetMs = opts.budgetMs ?? SPOT_CHECK_BUDGET_MS;
  const maxQueries = opts.maxQueries ?? planned + SPOT_CHECK_LIMITS.extraQueries;
  const seenIds = new Map<number, Map<number, LiveDefinition[] | null>>();
  // Set after any attempt without a usable answer: the next query waits out a straggler first.
  let afterLoss = false;

  /** May one more query go out? Records why not. */
  const mayQuery = (): boolean => {
    if (queries >= maxQueries) stopped = 'queries';
    else if (now() - start >= budgetMs) stopped = 'budget';
    return stopped === undefined;
  };

  /** One paced query, after the drain pause when the last one was lost. */
  const send = async (block: number, pid: number): Promise<Uint8Array | null> => {
    if (afterLoss) {
      await pause(drainMs, sleep);
      throwIfAborted(signal);
      await guarded.drain?.();
      afterLoss = false;
    }
    throwIfAborted(signal);
    await pause(pacingMs, sleep);
    throwIfAborted(signal);
    queries += 1;
    return requestWithin(guarded, buildDefQuery(model, block, pid), opts.timeoutMs);
  };

  /**
   * A target's answer: one query, one retry after the drain pause. `shape` null = unanswered (or the
   * check had to stop before the retry); `sent` 0 = the check stopped before the first query.
   */
  const ask = async (block: number, pid: number): Promise<{ shape: Exclude<ReplyShape, 'lost'> | null; sent: number }> => {
    let sent = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!mayQuery()) break;
      const frame = await send(block, pid);
      sent += 1;
      const shape = frame ? replyShape(frame, pid) : 'lost';
      // Silence, a straggler or a broken frame: lost. After ANY lost attempt — also one the retry
      // recovered — the reply to it may still arrive late, so the next query waits it out first.
      afterLoss = shape === 'lost' || sent > 1;
      if (shape !== 'lost') return { shape, sent };
    }
    return { shape: null, sent };
  };

  /** Re-read a definition that answered before: is the device still answering? */
  const alive = async (probe: Address): Promise<boolean | 'stop'> => {
    if (!mayQuery()) return 'stop';
    afterLoss = true; // the re-read always follows a silent run: let stragglers arrive unheard first
    const frame = await send(probe.block, probe.pid);
    if (!frame) return false;
    afterLoss = !answersDefinition(frame, probe.pid);
    return true;
  };

  let firstAnswered: Address | undefined;
  let silentRun = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const { shape, sent } = await ask(t.block, t.pid);
    if (sent === 0) break; // budget or query cap: this target was never queried
    checked += 1;
    const res = results[i]!;
    if (shape === null) {
      res.outcome = 'unanswered';
      if (stopped !== undefined) break;
      silentRun += 1;
      if (silentRun >= SPOT_CHECK_LIMITS.silentTargets) {
        const probe = firstAnswered ?? anchor;
        const ok = probe ? await alive(probe) : false;
        if (ok === 'stop') break;
        if (!ok) {
          stopped = 'device-stopped-answering';
          break;
        }
        silentRun = 0;
      }
      onProgress?.({ done: i + 1, total: planned });
      continue;
    }
    silentRun = 0;
    answered += 1;
    firstAnswered ??= t;
    let reason: SpotCheckMismatchReason | undefined;
    if (shape === 'no-definition') {
      reason = 'no-definition'; // a well-formed no-payload or sentinel reply
    } else if (shape === 'junk') {
      reason = 'pseudo'; // a complete 36-byte payload that is no usable definition
    } else {
      const dec = shape.def;
      let seen = seenIds.get(t.block);
      if (!seen) seenIds.set(t.block, (seen = new Map()));
      // Sparse reads: a reused symbol id is a copy only when an end marker carried it or a real
      // definition with the same body did (never "a new body after a gap", as in a contiguous walk).
      const verdict = judgeDefinition(dec, seen, true);
      if (verdict === 'real') {
        if (dec.id !== 0) {
          const bodies = seen.get(dec.id);
          if (bodies) bodies.push(dec);
          else seen.set(dec.id, [dec]);
        }
        if (!definitionMatches(t, dec)) reason = 'differs';
      } else if (verdict === 'empty') {
        reason = 'empty-slot';
      } else if (verdict === 'end-marker') {
        seen.set(dec.id, null);
        reason = 'end-marker';
      } else {
        reason = 'pseudo';
      }
    }
    if (reason === undefined) {
      res.outcome = 'match';
    } else {
      res.outcome = 'mismatch';
      res.reason = reason;
      mismatches += 1;
      if (failures.length < SPOT_CHECK_LIMITS.maxFailures) failures.push({ family: t.family, pid: t.pid });
    }
    onProgress?.({ done: i + 1, total: planned });
  }

  if (stopped === 'device-stopped-answering') return finish('aborted');
  if (mismatches > 0) return finish('failed');
  if (stopped !== undefined) return finish('inconclusive');
  return finish(answered * 100 >= planned * SPOT_CHECK_LIMITS.passPercent ? 'passed' : 'inconclusive');
}
