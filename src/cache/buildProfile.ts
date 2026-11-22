/**
 * Source-agnostic cache-profile orchestrator.
 *
 * Ties the byte-walker (`parseCacheRecords`) and the section→family voter
 * (`buildDeviceCache`) into one call that produces a complete `BuiltCache`
 * from either a decoded `.cache` byte buffer OR an injected live self-describe
 * walk. The two sources are interchangeable: given the same records they
 * produce byte-identical data, differing only in `meta.source`.
 *
 * Pure and browser-safe — no `node:*`, no `Buffer`. The `bytes` path decodes
 * through the browser-safe `DataView` walker; the `live` path just consumes an
 * injected `walk()` (the device self-describe that PRODUCES that walk is a
 * separate future module, blocked on the A0 reply-payload decode — not here).
 *
 * Determinism: this module NEVER stamps a wall-clock time. `Date.now()` /
 * `new Date()` are banned in this codebase's build/runtime seams and would make
 * the output non-reproducible. A `builtAt` stamp is taken from `opts` only when
 * the caller supplies one; otherwise it is left undefined.
 */
import { parseCacheRecords } from './records.js';
import { buildDeviceCache } from './assign.js';
import type { LiveWalkResult, PseudoReplyStats } from './liveWalk.js';
import type { BuiltCacheData, CacheRecord, CacheWalkIssue, DeviceParam } from './types.js';

/**
 * Current cache format schema. Bump whenever the live-walk classification or the section→family
 * assignment shape changes in a way that would make a previously-persisted cache serve wrong data
 * (e.g. the enum/float kind heuristic). Consuming runtimes reject docs whose `meta.schema` differs.
 *
 * History: 1 (first versioned schema) = a continuous unit or an answered-but-empty label list
 * vetoes the enum heuristic; a live walk keeps inner empty slots as (flagged) placeholder records,
 * counted as slots only in table-shaped sections; empty slots are recognised by their empty body.
 * Schema 1 also covers a later tightening of the live walk's reply decoding: a value reply whose
 * display string is followed by interior NUL padding now decodes, so units come back where the device
 * pads that way (and such a unit keeps a continuous param off the enum list); a 36-byte label or value
 * is no longer misread as a definition; and full-mode taper sweeps gain samples, because their display
 * read-back no longer drops those replies. A cache built before this may lack units and, for affected
 * params, carry the old kind (enum instead of float); rebuild it. Schema 1 also covers where the live
 * walk stops: a block now ends a small run (default 32) after its last real definition and is capped by a
 * per-block ceiling (never the whole 14-bit id space), and an end marker, a definition repeating a non-zero
 * id already seen in its block, or an implausible one (junk floats, `min > max`) is treated as an absent
 * slot, so none of them ever becomes a record (`meta.walk.pseudoReplies` counts them). A cache built by a
 * walk that probed past a table's end can carry junk records from far ids; rebuild it. Schema 1 also covers the
 * typecode-0x52 knob rule: such float records (dimensionless knobs) derive a linear 0..10 display (displayMin 0,
 * displayMax 10, taper 'linear', no unit) instead of the definition's `(min, max) * scale`, matching the shipped
 * catalogs.
 *
 * Policy: Schema stays 1 until the first release that carries it; after a release, every change to derived
 * output bumps it. (No bump while unreleased: the consuming runtime's schema gate lands in the same bundle.)
 * Precisely: bump `CACHE_SCHEMA` when an existing derived field changes value or meaning for the same raw input;
 * additive derived fields bump nothing (a profile document's `sections`, `blockMap`, `provenance`, `coverage`
 * and the synthetic `section:<tag>` / `block:<eid>` family keys were added without a bump, see ./profileDoc.ts).
 * A format-2 profile document (it carries its raw sources) re-derives on any bump; a format-1 document (derived
 * tables only) goes stale on the next bump.
 */
export const CACHE_SCHEMA = 1;

/**
 * Where the decoded cache records come from.
 *   - `bytes`: a raw decoded `.cache` buffer (walked here). `tolerant` keeps going past a
 *     damaged record (see `parseCacheRecords`); the skips land in `meta.issues`.
 *   - `live`: an injected async producer of already-decoded records (a device
 *     self-describe walk supplied by the caller).
 */
export type RecordSource =
  | { kind: 'bytes'; buf: Uint8Array; tolerant?: boolean }
  | { kind: 'live'; walk: () => Promise<CacheRecord[] | LiveWalkResult> };

/** Reply-loss accounting of a live walk, carried into `meta.walk` (see `LiveWalkResult`). */
export interface BuiltCacheWalkStats {
  queries: number;
  lostReplies: number;
  recoveredReplies: number;
  unresolvedReplies: number;
  placeholderSlots: number;
  missingSlots: number;
  silentAddresses: number;
  /** Answered-but-not-a-parameter definition replies the walk ignored (end markers, repeated ids,
   *  implausible junk); absent in a cache whose walk predates the count. */
  pseudoReplies?: PseudoReplyStats;
}

/**
 * A complete built cache: the derived device tables (`BuiltCacheData` shapes)
 * wrapped in a small identity/provenance envelope.
 */
export interface BuiltCache extends BuiltCacheData {
  /** Device model code, when the caller knows it (e.g. 0x11 for FM3). */
  model?: number;
  /** Firmware version string, when known (e.g. '12.0'). */
  firmware?: string;
  meta: {
    /** Cache format version — bumped whenever the walk/assign shape changes such that an older
     *  persisted doc must not be trusted (a stale build would serve wrong classifications). */
    schema?: number;
    /** Total decoded records consumed (incl. special table records). */
    recordCount: number;
    /** Caller-supplied build timestamp; never wall-clock-stamped here. */
    builtAt?: string;
    /** Which `RecordSource` variant produced the records. */
    source: 'bytes' | 'live';
    /** Live walks only, when the walk reported it (`liveSource` / `liveWalkDetailed`): reply-loss
     *  accounting. `unresolvedReplies > 0` means the profile may be incomplete; `missingSlots > 0`
     *  means some strides are short by that many slots (both count genuine loss only);
     *  `silentAddresses` counts addresses the device left unanswered while alive. */
    walk?: BuiltCacheWalkStats;
    /** Tolerant byte walks only, when something was skipped: the damaged stretches. Any entry
     *  means the profile lacks (part of) the named sections. */
    issues?: CacheWalkIssue[];
  };
}

/**
 * Build a complete `BuiltCache` from a byte buffer or an injected live walk.
 *
 * @param source `{ kind: 'bytes', buf }` decodes the buffer here;
 *               `{ kind: 'live', walk }` awaits the injected walk.
 * @param params device param catalog rows (e.g. `FM3_PARAMS`).
 * @param seeds  family → section-tag hardware anchors (e.g. `HW_SEEDS`).
 * @param opts   optional identity envelope (`model`/`firmware`) and a
 *               caller-supplied `builtAt` stamp (this module stamps none).
 */
export async function buildCache(
  source: RecordSource,
  params: DeviceParam[],
  seeds: Record<string, number>,
  opts: { model?: number; firmware?: string; builtAt?: string } = {},
): Promise<BuiltCache> {
  let records: CacheRecord[];
  let walk: BuiltCacheWalkStats | undefined;
  let issues: CacheWalkIssue[] | undefined;
  if (source.kind === 'bytes') {
    const parsed = parseCacheRecords(source.buf, { tolerant: source.tolerant === true });
    records = parsed.records;
    if (parsed.issues && parsed.issues.length > 0) issues = parsed.issues;
  } else {
    const walked = await source.walk();
    if (Array.isArray(walked)) {
      records = walked;
    } else {
      records = walked.records;
      const { queries, lostReplies, recoveredReplies, unresolvedReplies, placeholderSlots, missingSlots, silentAddresses, pseudoReplies } = walked;
      // A result from a walk that predates the count omits the field instead of carrying `undefined`.
      walk = {
        queries,
        lostReplies,
        recoveredReplies,
        unresolvedReplies,
        placeholderSlots,
        missingSlots,
        silentAddresses,
        ...(pseudoReplies !== undefined ? { pseudoReplies: { ...pseudoReplies } } : {}),
      };
    }
  }

  const data = buildDeviceCache(records, params, seeds);

  const meta: BuiltCache['meta'] = {
    schema: CACHE_SCHEMA,
    recordCount: records.length,
    source: source.kind,
  };
  if (opts.builtAt !== undefined) meta.builtAt = opts.builtAt;
  if (walk !== undefined) meta.walk = walk;
  if (issues !== undefined) meta.issues = issues;

  const out: BuiltCache = { ...data, meta };
  if (opts.model !== undefined) out.model = opts.model;
  if (opts.firmware !== undefined) out.firmware = opts.firmware;
  return out;
}
