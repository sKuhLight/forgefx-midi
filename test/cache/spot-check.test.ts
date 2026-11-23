/**
 * Spot check (`src/cache/spotCheck.ts`): target selection and the read-only runner.
 *
 * Synthetic data only: definition records built from the committed FM3 catalog rows (ranges,
 * typecodes, effect ids), served by the shared fake device (./cacheDevice.ts) at the catalog's
 * effect ids, with a thin script layer for lost, late, pseudo and dead answers. No cache bytes, no
 * device frames.
 *
 * Cases pin: a pass; one mismatch -> failed; every pseudo answer (empty slot, end marker,
 * no-payload, junk) -> mismatch; lost replies (3 lost -> inconclusive, 2 -> passed, a recovered
 * retry, a straggler, a timeout); liveness (address-specific silence passes, a dead unit -> aborted,
 * with and without an anchor); the bound guard (refused before the wire, the exact allow-list, the
 * inner bound watchdog); the TX audit over every run (definition queries only, sub 0, each a target
 * inside its bound, no label / value query, no write); P1 priority (a mutated catalog-known row is
 * always selected while P1 <= 16), the P1 / P2 caps; the per-family cap; insufficient / not-needed;
 * the eligibility rules; determinism under a seed; v1 rows (`rangeMatchesDefinition`); rows of a
 * derived profile document (`spotCheckRows`) end to end; budget, query cap, abort and progress; the
 * catalog-baseline rule (on the catalog's own firmware a compatible edit is always priority 1 and
 * fails the check; on another firmware it stays a priority-2 row).
 */
import { deepStrictEqual } from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  buildDefQuery,
  buildEnumQuery,
  buildValueQuery,
  decodeWalkQuery,
  deriveProfile,
  guardSpotCheckTransport,
  isInformativeRow,
  paramFingerprint,
  rangeMatchesDefinition,
  rangeRowOf,
  rowsCompatible,
  runSpotCheck,
  SPOT_CHECK_LIMITS,
  SPOT_CHECK_TARGETS,
  spotCheckRng,
  spotCheckRows,
  spotCheckTargets,
  VIEW_DEFINITION,
  WalkBoundError,
} from '../../src/cache/index.js';
import type {
  LiveRawSource,
  LiveTransport,
  ProfileRaw,
  RangeDef,
  SpotCheckPlan,
  SpotCheckResult,
  SpotCheckRow,
  SpotCheckRowClass,
  SpotCheckRunOptions,
  SpotCheckTarget,
  SpotCheckTargetsInput,
} from '../../src/cache/index.js';
import type { CacheRecord, DeviceParam } from '../../src/cache/types.js';
import { FM3_EFFECT_IDS, FM3_PARAMS, FM3_RANGES } from '../../src/gen3/fm3/index.js';
import { VERSION } from '../../src/version.js';
import { cacheDevice, emptySlotFrame } from './cacheDevice.js';
import { endOfRangeFrame, replyFrame, sentinelFrame } from './livewalk.test.js';

export const SPOT_CHECK_CASE_COUNT = 18;

const FM3 = 0x11;
/** Families with a static effect id <= 160 (eight of them: 190 informative rows). */
const FAMILIES = ['COMP', 'CHORUS', 'FLANGER', 'PHASER', 'GATE', 'TREMOLO', 'VOLUME', 'ENHANCER'] as const;

const fail = (msg: string): never => {
  throw new Error(`[cache/spot-check] ${msg}`);
};

// ---------------------------------------------------------------------------
// Synthetic data from the catalog
// ---------------------------------------------------------------------------

const f32 = (x: number): number => (x === 0 ? 0 : Math.fround(x));
const CATALOG = FM3_RANGES as unknown as Readonly<Record<string, Readonly<Record<number, RangeDef>>>>;
const eidOf = (family: string): number | null => FM3_EFFECT_IDS[family] ?? null;
/** The FM3 param catalog as the derivation takes it. */
const PARAMS = FM3_PARAMS as unknown as DeviceParam[];

/** One catalog row as a definition record at `block` (enum rows keep their value count, no labels). */
function catalogRecord(family: string, pid: number, block: number): CacheRecord {
  const row = CATALOG[family]![pid]!;
  const base = { section: block, offset: 0, id: pid, tc: row.typecode, min: f32(row.displayMin), max: f32(row.displayMax), step: f32(row.step) };
  if (row.kind === 'enum') {
    return { ...base, kind: 'enum', def: 0, count: row.enumCount ?? Math.round(row.displayMax - row.displayMin + 1), values: [], x: 0 };
  }
  return { ...base, kind: 'float', def: f32(row.scale), t1: 0, t2: 0 };
}

/** Every catalog row of the families, at their effect ids. */
function honestRecords(families: readonly string[]): CacheRecord[] {
  const out: CacheRecord[] = [];
  for (const family of families) {
    const eid = eidOf(family)!;
    for (const key of Object.keys(CATALOG[family]!).map(Number).sort((a, b) => a - b)) out.push(catalogRecord(family, key, eid));
  }
  return out;
}

const familyOfEid = new Map<number, string>(Object.entries(FM3_EFFECT_IDS).filter((e): e is [string, number] => typeof e[1] === 'number').map(([f, e]) => [e, f]));
const key = (family: string, pid: number): string => `${family}:${pid}`;

/** Profile rows (with their raw record) from records at effect ids. `v1`: range rows only. */
function rowsOf(records: readonly CacheRecord[], v1 = false): SpotCheckRow[] {
  return records.map((r) => {
    const family = familyOfEid.get(r.section)!;
    const range = rangeRowOf(r).row;
    return v1 ? { family, pid: r.id, range } : { family, pid: r.id, range, records: [r] };
  });
}

/** The host's catalog comparison (as the server's row classifier): honest catalog rows vs the profile's. */
function classifier(rows: readonly SpotCheckRow[]): (family: string, pid: number) => SpotCheckRowClass | undefined {
  const reference = new Map<string, RangeDef>();
  for (const r of rowsOf(honestRecords(FAMILIES))) reference.set(key(r.family, r.pid), r.range as RangeDef);
  const own = new Map(rows.map((r) => [key(r.family, r.pid), r.range as RangeDef]));
  return (family, pid) => {
    const row = own.get(key(family, pid));
    if (!row) return undefined;
    const base = reference.get(key(family, pid));
    if (!base || !isInformativeRow(base)) return 'new';
    if (paramFingerprint(base) === paramFingerprint(row)) return 'exact';
    return rowsCompatible(base, undefined, row, undefined) ? 'compatible' : 'incompatible';
  };
}

/** The read-only bound a host derives from the static catalog: table end + 32, capped at 127. */
function boundOf(eid: number): number {
  const family = familyOfEid.get(eid);
  if (!family || !CATALOG[family]) return -1;
  return Math.min(127, Math.max(...Object.keys(CATALOG[family]!).map(Number)) + 32);
}

function plan(rows: readonly SpotCheckRow[], seed: number, over: Partial<SpotCheckTargetsInput> = {}): SpotCheckPlan {
  return spotCheckTargets({
    rows,
    winners: [...new Set(rows.map((r) => r.family))],
    catalogCompare: classifier(rows),
    catalogBaseline: false,
    eidOf,
    boundOf,
    rng: spotCheckRng(seed),
    ...over,
  });
}

const T0 = '2026-11-20T10:00:00Z';
const T1 = '2026-11-21T10:00:00Z';
type LiveRec = LiveRawSource['records'][number];

/** A read-only live source over records at effect ids (synthetic walk statistics). */
function liveSource(origin: 'local' | 'cloud', at: string, recs: readonly CacheRecord[]): LiveRawSource {
  return {
    id: `live-readonly@${at}#0`,
    kind: 'live-readonly',
    origin,
    capturedAt: at,
    firmware: '12.0',
    codecVersion: VERSION,
    space: 'block',
    scope: { blocks: [...new Set(recs.map((r) => r.section))].sort((a, b) => a - b), maxParamId: 127, bounds: {}, extended: false, above160: false, hinted: true },
    walk: { queries: 0, lostReplies: 0, recoveredReplies: 0, unresolvedReplies: 0, placeholderSlots: 0, missingSlots: 0, silentAddresses: 0, boundHits: [] },
    records: recs.map(({ offset: _o, ...r }) => r as LiveRec),
  };
}

/** Derive a profile document the way a host does (FM3, catalog effect ids). */
const derive = (raw: ProfileRaw) => deriveProfile(raw, PARAMS, {}, { model: FM3, firmware: '12.0', catalog: { familyFirstEid: FM3_EFFECT_IDS } });

/** Replace one record (same address) in a list. */
function replaced(records: readonly CacheRecord[], family: string, pid: number, change: Partial<CacheRecord>): CacheRecord[] {
  const eid = eidOf(family)!;
  return records.map((r) => (r.section === eid && r.id === pid ? ({ ...r, ...change } as CacheRecord) : r));
}

// ---------------------------------------------------------------------------
// The fake device with a script layer, and the TX audit
// ---------------------------------------------------------------------------

interface Wire {
  block: number;
  param: number;
  /** 1-based count of queries for this (block, param) so far. */
  nth: number;
  /** 1-based count of all queries so far. */
  total: number;
}

type Script = (w: Wire, honest: Uint8Array | null) => Uint8Array | null | Promise<Uint8Array | null> | undefined;

interface ScriptedDevice extends LiveTransport {
  trace: string[];
  sleep: (ms: number) => Promise<void>;
  drains: number;
}

/** Every frame any device of this suite received, for the suite-wide TX audit (case 7). */
const ALL_TX: Uint8Array[] = [];

function device(records: readonly CacheRecord[], script?: Script): ScriptedDevice {
  const dev = cacheDevice(records);
  const counts = new Map<string, number>();
  let total = 0;
  const out: ScriptedDevice = {
    trace: dev.trace,
    sleep: dev.sleep,
    drains: 0,
    async request(query: Uint8Array): Promise<Uint8Array | null> {
      ALL_TX.push(Uint8Array.from(query));
      const honest = await dev.request(query);
      const block = query[8]! | (query[9]! << 7);
      const param = query[10]! | (query[11]! << 7);
      const k = `${block}:${param}`;
      const nth = (counts.get(k) ?? 0) + 1;
      counts.set(k, nth);
      total += 1;
      const o = script?.({ block, param, nth, total }, honest);
      return o === undefined ? honest : o;
    },
    drain() {
      out.drains += 1;
    },
  };
  return out;
}

const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));

/** Every query on the trace is a definition query of a target (or `extra`) inside its bound. Returns the query count. */
function audit(label: string, trace: readonly string[], targets: readonly Pick<SpotCheckTarget, 'block' | 'pid' | 'bound'>[]): number {
  const allowed = new Map(targets.map((t) => [`${t.block}:${t.pid}`, t.bound]));
  let n = 0;
  for (const e of trace) {
    if (e.startsWith('sleep:')) continue;
    n += 1;
    const q = decodeWalkQuery(hexBytes(e));
    if (!q) fail(`${label}: a frame that is not a self-describe query: ${e}`);
    if (q!.model !== FM3 || q!.view !== VIEW_DEFINITION || q!.sub !== 0) fail(`${label}: not a definition query: ${e}`);
    const bound = allowed.get(`${q!.block}:${q!.param}`);
    if (bound === undefined) fail(`${label}: query for ${q!.block}:${q!.param} is not a target`);
    if (q!.param > bound!) fail(`${label}: query above its bound`);
  }
  return n;
}

const run = (dev: ScriptedDevice, targets: readonly SpotCheckTarget[], over: Partial<SpotCheckRunOptions> = {}): Promise<SpotCheckResult> =>
  runSpotCheck(dev, { model: FM3, targets, sleep: dev.sleep, ...over });

const count = (trace: readonly string[], entry: string): number => trace.filter((e) => e === entry).length;

async function rejectsWith(label: string, p: () => Promise<unknown>, cls: new (...a: never[]) => Error): Promise<Error> {
  try {
    await p();
  } catch (err) {
    if (!(err instanceof cls)) fail(`${label}: wrong error ${String(err)}`);
    return err as Error;
  }
  return fail(`${label}: did not reject`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

export async function runSpotCheckSuite(): Promise<void> {
  const honest = honestRecords(FAMILIES);
  const honestRows = rowsOf(honest);
  const base = plan(honestRows, 1);
  if (base.status !== 'ready' || base.targets.length !== SPOT_CHECK_TARGETS) fail(`honest plan: ${base.status} ${base.targets.length}`);
  const T = base.targets;

  // ---- Case 1: a pass ---------------------------------------------------------
  {
    const dev = device(honest);
    const progress: number[] = [];
    const r = await run(dev, T, { onProgress: (p) => (p.total === 24 ? progress.push(p.done) : fail('progress total')) });
    if (r.verdict !== 'passed') fail(`pass: ${r.verdict}`);
    if (r.planned !== 24 || r.checked !== 24 || r.answered !== 24 || r.mismatches !== 0 || r.failures.length !== 0) fail('pass: counts');
    if (r.queries !== 24 || audit('pass', dev.trace, T) !== 24) fail('pass: one query per target');
    if (r.results.some((x) => x.outcome !== 'match')) fail('pass: every target matches');
    if (count(dev.trace, `sleep:${SPOT_CHECK_LIMITS.pacingMs}`) !== 24) fail('pass: paced before every query');
    if (dev.trace.some((e) => e === `sleep:${SPOT_CHECK_LIMITS.drainMs}`) || dev.drains !== 0) fail('pass: no drain without a loss');
    deepStrictEqual(progress, Array.from({ length: 24 }, (_, i) => i + 1));
    if (r.stopped !== undefined) fail('pass: not stopped');
  }

  // ---- Case 2: one mismatch -> failed ----------------------------------------------
  {
    // The profile edits one catalog-known float row so that it no longer overlaps the catalog's.
    const victim = T.find((t) => t.records![0]!.kind === 'float' && t.range.typecode !== 0x52)!;
    const rec = victim.records![0]!;
    const doc = rowsOf(replaced(honest, victim.family, victim.pid, { min: f32(rec.max + 100), max: f32(rec.max + 200) }));
    const p = plan(doc, 1);
    const hit = p.targets.find((t) => t.family === victim.family && t.pid === victim.pid);
    if (!hit || hit.priority !== 1) fail('mismatch: the edited row is a priority-1 target');
    const dev = device(honest);
    const r = await run(dev, p.targets);
    if (r.verdict !== 'failed' || r.mismatches !== 1 || r.answered !== 24) fail(`mismatch: ${r.verdict} ${r.mismatches}`);
    deepStrictEqual(r.failures, [{ family: victim.family, pid: victim.pid }]);
    const res = r.results.find((x) => x.family === victim.family && x.pid === victim.pid)!;
    if (res.outcome !== 'mismatch' || res.reason !== 'differs') fail('mismatch: reason');
    audit('mismatch', dev.trace, p.targets);
    // A def (display multiplier) or step edit is a mismatch too; a kind flip with equal numbers is not.
    const enumT = T.find((t) => t.records![0]!.kind === 'enum')!;
    const flipped = T.map((t) => (t === enumT ? { ...t, records: [{ ...t.records![0]!, kind: 'float' as const, count: undefined }] } : t));
    const stepT = T.find((t) => t.records![0]!.kind === 'float' && t !== victim)!;
    const stepped = T.map((t) => (t === stepT ? { ...t, records: [{ ...t.records![0]!, def: t.records![0]!.def + 1 }] } : t));
    if ((await run(device(honest), flipped)).verdict !== 'passed') fail('mismatch: a kind flip with equal numbers matches');
    const s = await run(device(honest), stepped);
    if (s.verdict !== 'failed' || s.failures[0]!.pid !== stepT.pid) fail('mismatch: a def edit fails');
    // Two records at one address (ambiguous source): every one must match.
    const twice = T.map((t, i) => (i === 0 ? { ...t, records: [t.records![0]!, { ...t.records![0]!, tc: t.records![0]!.tc + 1 }] } : t));
    if ((await run(device(honest), twice)).verdict !== 'failed') fail('mismatch: every record at an address must match');
  }

  // ---- Case 3: pseudo answers where the profile has a real row -> mismatch -------------
  {
    const at = (i: number) => T[i]!;
    const junk = new Uint8Array(36);
    const dv = new DataView(junk.buffer);
    dv.setUint32(0, 0x4242, true);
    dv.setUint32(4, 5, true);
    dv.setFloat32(8, 1e-30, true); // a near-zero float body: junk
    dv.setFloat32(12, 2e-30, true);
    const script: Script = (w) => {
      if (w.block === at(2).block && w.param === at(2).pid) return emptySlotFrame(w.param); // empty slot (id 0)
      if (w.block === at(5).block && w.param === at(5).pid) return emptySlotFrame(w.param, 0x777); // end marker
      if (w.block === at(8).block && w.param === at(8).pid) return endOfRangeFrame(VIEW_DEFINITION, w.param); // no payload
      if (w.block === at(11).block && w.param === at(11).pid) return sentinelFrame(VIEW_DEFINITION, w.param); // sentinel
      if (w.block === at(14).block && w.param === at(14).pid) return replyFrame(VIEW_DEFINITION, w.param, 0x3a, junk);
      return undefined;
    };
    const dev = device(honest, script);
    const r = await run(dev, T);
    if (r.verdict !== 'failed' || r.mismatches !== 5 || r.answered !== 24 || r.queries !== 24) fail(`pseudo: ${r.verdict} ${r.mismatches} ${r.queries}`);
    deepStrictEqual(
      [2, 5, 8, 11, 14].map((i) => r.results[i]!.reason),
      ['empty-slot', 'end-marker', 'no-definition', 'no-definition', 'pseudo'],
    );
    // A real-looking copy: the same symbol id and body as an earlier target of the same block.
    const sameBlock = T.filter((t) => t.block === T[0]!.block);
    if (sameBlock.length < 2) fail('pseudo: the plan has two targets in one block');
    {
      const [first, second] = sameBlock;
      const firstAnswer = await device(honest).request(buildDefQuery(FM3, first!.block, first!.pid));
      const copy: Script = (w) => (w.block === second!.block && w.param === second!.pid ? Uint8Array.from([...firstAnswer!.subarray(0, 10), second!.pid & 0x7f, ...firstAnswer!.subarray(11)]) : undefined);
      // (the param echo byte is rewritten; the checksum is not checked by the decoder)
      const c = await run(device(honest, copy), T);
      const cr = c.results.find((x) => x.pid === second!.pid && x.block === second!.block)!;
      if (cr.outcome !== 'mismatch' || cr.reason !== 'pseudo') fail(`pseudo: a copy of another target's definition is a pseudo answer (${cr.outcome} ${cr.reason})`);
    }
    audit('pseudo', dev.trace, T);
  }

  // ---- Case 4: lost replies -------------------------------------------------------------
  {
    const lost = (idx: readonly number[], times = 2): Script => (w) =>
      idx.some((i) => T[i]!.block === w.block && T[i]!.pid === w.param) && w.nth <= times ? null : undefined;
    // 3 lost (after their retry) -> 21 of 24 answered -> inconclusive.
    const d3 = device(honest, lost([3, 10, 17]));
    const r3 = await run(d3, T);
    if (r3.verdict !== 'inconclusive' || r3.answered !== 21 || r3.mismatches !== 0 || r3.checked !== 24) fail(`3 lost: ${r3.verdict} ${r3.answered}`);
    if (r3.queries !== 27 || audit('3 lost', d3.trace, T) !== 27) fail('3 lost: one retry per lost target');
    if ([3, 10, 17].some((i) => r3.results[i]!.outcome !== 'unanswered')) fail('3 lost: outcome');
    // A drain pause (and the host's drain) before every retry and before the query after a loss.
    if (count(d3.trace, `sleep:${SPOT_CHECK_LIMITS.drainMs}`) !== 6 || d3.drains !== 6) fail(`3 lost: drains ${d3.drains}`);
    // 2 lost -> 22 of 24 -> passed.
    const r2 = await run(device(honest, lost([3, 10])), T);
    if (r2.verdict !== 'passed' || r2.answered !== 22) fail(`2 lost: ${r2.verdict}`);
    // A reply lost once is recovered by the retry.
    const r1 = await run(device(honest, lost([4], 1)), T);
    if (r1.verdict !== 'passed' || r1.answered !== 24 || r1.queries !== 25) fail('recovered: retry');
    // A straggler (a definition reply for another pid) is not this target's answer: retried.
    const stray: Script = (w, h) => (w.block === T[6]!.block && w.param === T[6]!.pid && w.nth === 1 ? replyFrame(VIEW_DEFINITION, (w.param + 1) & 0x7f, 0x3a, new Uint8Array(36)) : h ?? undefined);
    const rs = await run(device(honest, stray), T);
    if (rs.verdict !== 'passed' || rs.queries !== 25 || rs.results[6]!.outcome !== 'match') fail('straggler: retried, then matched');
    // A reply that never comes within the per-query timeout counts as lost.
    const hang: Script = (w) => (w.block === T[7]!.block && w.param === T[7]!.pid && w.nth === 1 ? new Promise<Uint8Array | null>(() => {}) : undefined);
    const rt = await run(device(honest, hang), T, { timeoutMs: 5 });
    if (rt.verdict !== 'passed' || rt.queries !== 25) fail('timeout: lost, then retried');
  }

  // ---- Case 5: liveness -----------------------------------------------------------------
  {
    // Two consecutive silent targets on a live unit: the re-read of the first answered target
    // answers, the check goes on; 22 answered -> passed.
    const silent: Script = (w) => ([5, 6].some((i) => T[i]!.block === w.block && T[i]!.pid === w.param) ? null : undefined);
    const ds = device(honest, silent);
    const rs = await run(ds, T);
    if (rs.verdict !== 'passed' || rs.answered !== 22 || rs.queries !== 24 + 2 + 1) fail(`silent addresses: ${rs.verdict} ${rs.queries}`);
    const reread = ds.trace.filter((e) => !e.startsWith('sleep:'))[9]!; // 5 + 4 silent attempts, then the re-read
    if (reread !== Array.from(buildDefQuery(FM3, T[0]!.block, T[0]!.pid), (b) => b.toString(16).padStart(2, '0')).join('')) fail('liveness: re-reads the first answered target');
    // A unit that dies after 5 answers: 2 silent targets, an unanswered re-read -> aborted.
    const dead = (after: number): Script => (w) => (w.total > after ? null : undefined);
    const dd = device(honest, dead(5));
    const rd = await run(dd, T);
    if (rd.verdict !== 'aborted' || rd.stopped !== 'device-stopped-answering') fail(`dead: ${rd.verdict}`);
    if (rd.queries !== 5 + 4 + 1 || rd.checked !== 7 || rd.answered !== 5) fail(`dead: ${rd.queries} queries, ${rd.checked} checked`);
    if (rd.results.slice(7).some((x) => x.outcome !== 'not-checked')) fail('dead: nothing after the abort');
    audit('dead', dd.trace, T);
    // Dead from the start: without an anchor nothing can prove liveness -> aborted after 2 targets.
    const d0 = device(honest, dead(0));
    const r0 = await run(d0, T);
    if (r0.verdict !== 'aborted' || r0.queries !== 4) fail('dead from the start: aborted after two targets');
    // With a catalog anchor: re-read the anchor (inside its bound), then abort.
    const anchor = { block: eidOf('COMP')!, pid: 0, bound: boundOf(eidOf('COMP')!) };
    const da = device(honest, dead(0));
    const ra = await run(da, T, { anchor });
    if (ra.verdict !== 'aborted' || ra.queries !== 5) fail('anchor: re-read once');
    const last = da.trace.filter((e) => !e.startsWith('sleep:')).pop()!;
    if (last !== Array.from(buildDefQuery(FM3, anchor.block, 0), (b) => b.toString(16).padStart(2, '0')).join('')) fail('anchor: the re-read is the anchor');
    audit('anchor', da.trace, [...T, anchor]);
    // A mismatch found before the unit died does not outweigh the abort.
    const victim = T[1]!;
    const wrong = T.map((t) => (t === victim ? { ...t, records: [{ ...t.records![0]!, tc: t.records![0]!.tc + 1 }] } : t));
    if ((await run(device(honest, dead(5)), wrong)).verdict !== 'aborted') fail('dead: aborted wins over a mismatch');
  }

  // ---- Case 6: bound guard ----------------------------------------------------------------
  {
    // A target above its bound is refused before anything is sent.
    const above = T.map((t, i) => (i === 3 ? { ...t, bound: t.pid - 1 } : t));
    const d1 = device(honest);
    const e1 = (await rejectsWith('above bound', () => run(d1, above), WalkBoundError)) as WalkBoundError;
    if (d1.trace.length !== 0 || e1.block !== T[3]!.block || e1.param !== T[3]!.pid) fail('above bound: nothing reaches the device');
    // Ids above 127 need the extendedIds gate, effect ids above 160 the above160 gate.
    const highId = T.map((t, i) => (i === 0 ? { ...t, pid: 130, bound: 200 } : t));
    const d2 = device(honest);
    await rejectsWith('id above 127', () => run(d2, highId), WalkBoundError);
    const highEid = T.map((t, i) => (i === 0 ? { ...t, block: 162, pid: 0, bound: 60 } : t));
    await rejectsWith('eid above 160', () => run(d2, highEid), WalkBoundError);
    await rejectsWith('eid above 255', () => run(d2, highEid.map((t, i) => (i === 0 ? { ...t, block: 256 } : t)), { gates: { above160: true } }), WalkBoundError);
    await rejectsWith('anchor above bound', () => run(d2, T, { anchor: { block: 46, pid: 50, bound: 40 } }), WalkBoundError);
    await rejectsWith('negative bound', () => run(d2, T.map((t, i) => (i === 0 ? { ...t, bound: -1 } : t))), WalkBoundError);
    await rejectsWith('fractional pid', () => run(d2, T.map((t, i) => (i === 0 ? { ...t, pid: 1.5 } : t))), WalkBoundError);
    if (d2.trace.length !== 0) fail('gates: nothing reaches the device');
    // The wire guard on its own: only the listed definition queries pass.
    const eid = eidOf('COMP')!;
    const d3 = device(honest);
    const g = guardSpotCheckTransport(d3, { model: FM3, targets: [{ block: eid, pid: 5, bound: 68 }, { block: eid, pid: 35, bound: 40 }] });
    if (!(await g.request(buildDefQuery(FM3, eid, 5)))) fail('guard: a target passes');
    const refused: Array<[string, Uint8Array]> = [
      ['an unlisted pid', buildDefQuery(FM3, eid, 6)],
      ['another block', buildDefQuery(FM3, eid + 1, 5)],
      ['a label query', buildEnumQuery(FM3, eid, 5, 0)],
      ['a value read', buildValueQuery(FM3, eid, 5)],
      ['another model', buildDefQuery(0x12, eid, 5)],
      ['a sub ordinal', (() => { const q = buildDefQuery(FM3, eid, 5); q[12] = 1; return q; })()],
      ['a write frame', Uint8Array.from([0xf0, 0x00, 0x01, 0x74, FM3, 0x02, 0x00, 0x00, 0xf7])],
    ];
    for (const [what, q] of refused) await rejectsWith(`guard: ${what}`, () => g.request(q), WalkBoundError);
    // The inner bound watchdog: two targets of one block -> the block's bound is the lower one, so
    // a listed pid above it never leaves the transport either.
    const g2 = guardSpotCheckTransport(d3, { model: FM3, targets: [{ block: eid, pid: 35, bound: 40 }, { block: eid, pid: 5, bound: 20 }] });
    const e2 = (await rejectsWith('inner bound', () => g2.request(buildDefQuery(FM3, eid, 35)), WalkBoundError)) as WalkBoundError;
    if (!/above its bound 20/.test(e2.message)) fail(`inner bound: ${e2.message}`);
    if (count(d3.trace, Array.from(buildDefQuery(FM3, eid, 5), (b) => b.toString(16).padStart(2, '0')).join('')) !== 1 || d3.trace.length !== 1) fail('guard: only the one allowed query reached the device');
    // Selection never plans a row above its bound.
    const tight = plan(honestRows, 3, { boundOf: (e) => (e === eid ? 10 : boundOf(e)) });
    if (tight.targets.some((t) => t.block === eid && t.pid > 10)) fail('selection: a row above its bound');
    if (tight.targets.some((t) => t.bound !== (t.block === eid ? 10 : boundOf(t.block)))) fail('selection: target bound');
  }

  // ---- Case 8: P1 priority and the P1 / P2 caps --------------------------------------------------
  {
    // 8 rows the catalog lacks (appended to COMP) + 1 edited catalog-known row = 9 in P1.
    const comp = eidOf('COMP')!;
    const extra: CacheRecord[] = Array.from({ length: 20 }, (_, i) => ({ ...catalogRecord('COMP', 0, comp), id: 37 + i }));
    // An edit no catalog row overlaps: an incompatible float row.
    const vRec = honest.find((r) => r.section === eidOf('CHORUS') && r.kind === 'float' && r.max > r.min && r.tc !== 0x52)!;
    const victim = { family: 'CHORUS', pid: vRec.id };
    const edited = replaced(honest, victim.family, victim.pid, { min: f32(vRec.max + 100), max: f32(vRec.max + 200) });
    const doc9 = rowsOf([...edited, ...extra.slice(0, 8)]);
    for (let seed = 1; seed <= 200; seed++) {
      const p = plan(doc9, seed);
      const v = p.targets.find((t) => t.family === victim.family && t.pid === victim.pid);
      if (!v || v.priority !== 1) fail(`P1: seed ${seed} misses the edited row`);
      if (p.targets.filter((t) => t.priority === 1).length !== 9 || p.pools.new !== 9) fail(`P1: seed ${seed} P1 size`);
      if (p.targets.findIndex((t) => t.priority !== 1) !== 9) fail('P1: priority-1 targets come first');
    }
    // The device answers the new rows (it has them) and the honest edited row -> exactly that one fails.
    const p9 = plan(doc9, 7);
    const r9 = await run(device([...honest, ...extra.slice(0, 8)]), p9.targets);
    if (r9.verdict !== 'failed') fail('P1: the edited row fails');
    deepStrictEqual(r9.failures, [victim]);
    // P1 > 16: a random 16 (the edited row is no longer certain — the accepted residual risk).
    const doc21 = rowsOf([...edited, ...extra]);
    let hits = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const p = plan(doc21, seed);
      if (p.targets.filter((t) => t.priority === 1).length !== SPOT_CHECK_LIMITS.newRows || p.pools.new !== 21) fail('P1: capped at 16');
      if (p.targets.some((t) => t.family === victim.family && t.pid === victim.pid && t.priority === 1)) hits += 1;
    }
    if (hits === 0 || hits === 200) fail(`P1 > 16: the edited row is drawn at random (${hits}/200)`);
    // P2: compatible revisions (same typecode, overlapping span) -> at most 4, at random.
    let changed = honest;
    const compatibleRows = honest.filter((r) => r.kind === 'float' && r.max > r.min && r.tc !== 0x52).slice(0, 10);
    for (const r of compatibleRows) changed = replaced(changed, familyOfEid.get(r.section)!, r.id, { max: f32(r.max + (r.max - r.min) / 2) });
    const docP2 = rowsOf(changed);
    for (let seed = 1; seed <= 50; seed++) {
      const p = plan(docP2, seed);
      if (p.pools.changed !== 10 || p.targets.filter((t) => t.priority === 2).length !== SPOT_CHECK_LIMITS.changedRows) fail('P2: capped at 4');
      if (p.targets.length !== 24) fail('P2: still N targets');
    }
  }

  // ---- Case 9: per-family cap -------------------------------------------------------------------
  {
    // 8 families, all rows catalog-exact: 24 random rows, at most 3 per family (exactly 3 here).
    for (let seed = 1; seed <= 100; seed++) {
      const p = plan(honestRows, seed);
      if (p.pools.other !== p.eligible || p.targets.some((t) => t.priority !== 3)) fail('cap: all priority 3');
      const per = new Map<string, number>();
      for (const t of p.targets) per.set(t.family, (per.get(t.family) ?? 0) + 1);
      if ([...per.values()].some((n) => n !== 3) || per.size !== 8) fail(`cap: seed ${seed} ${JSON.stringify([...per])}`);
    }
    // Two families: the cap spreads the first picks (3 + 3), the rest fills N regardless of family.
    const two = rowsOf(honestRecords(['COMP', 'CHORUS']));
    const p = plan(two, 5);
    if (p.targets.length !== 24) fail('cap: fills to N');
    const first6 = p.targets.slice(0, 6);
    if (first6.filter((t) => t.family === 'COMP').length !== 3 || first6.filter((t) => t.family === 'CHORUS').length !== 3) fail('cap: the first picks are spread');
    // P1 and P2 rows do not count against the priority-3 cap of their family.
    const comp = eidOf('COMP')!;
    const newRows = Array.from({ length: 5 }, (_, i) => ({ ...catalogRecord('COMP', 0, comp), id: 40 + i }));
    const withNew = plan(rowsOf([...honest, ...newRows]), 5);
    if (withNew.targets.filter((t) => t.family === 'COMP' && t.priority === 3).length > 3) fail('cap: priority-3 cap per family');
  }

  // ---- Case 10: insufficient, not-needed ---------------------------------------------------------
  {
    const enh = rowsOf(honestRecords(['ENHANCER']));
    if (enh.length !== 12) fail(`insufficient: ENHANCER fixture has ${enh.length} rows`);
    const ok = plan(enh, 1);
    if (ok.status !== 'ready' || ok.eligible !== 12 || ok.targets.length !== 12) fail('insufficient: 12 eligible rows are enough');
    const short = plan(enh.slice(1), 1);
    if (short.status !== 'insufficient' || short.eligible !== 11 || short.needed !== 12 || short.targets.length !== 0) fail('insufficient: 11');
    // Rows exist, but only of families a local source won: nothing to check.
    const none = plan(honestRows, 1, { winners: [] });
    if (none.status !== 'not-needed' || none.targets.length !== 0) fail('not-needed');
    // A cloud-won family without a checkable row (no effect id) is not "not needed": insufficient.
    const preset = plan([{ family: 'PRESET', pid: 1, range: { kind: 'float', typecode: 2, displayMin: 0, displayMax: 1, scale: 1 } }], 1);
    if (preset.status !== 'insufficient' || preset.eligible !== 0 || preset.pools.unverifiable !== 1) fail('insufficient: unaddressable family');
    // The runner refuses fewer than 12 targets without any traffic (an empty plan never passes).
    const d = device(honest);
    for (const ts of [[], T.slice(0, 11)]) {
      const r = await run(d, ts);
      if (r.verdict !== 'insufficient' || r.queries !== 0) fail('runner: insufficient');
    }
    if (d.trace.length !== 0) fail('runner: insufficient sends nothing');
  }

  // ---- Case 11: eligibility rules ------------------------------------------------------------------
  {
    const range = (over: Partial<RangeDef> = {}): RangeDef => ({ kind: 'float', typecode: 0x43, displayMin: 0, displayMax: 10, scale: 1, step: 0, ...over });
    const rec = (pid: number, over: Partial<CacheRecord> = {}): CacheRecord => ({ kind: 'float', section: 0, offset: 0, id: pid, tc: 0x43, min: 0, max: 10, def: 1, step: 0, t1: 0, t2: 0, ...over } as CacheRecord);
    const row = (family: string, pid: number, over: Partial<SpotCheckRow> = {}): SpotCheckRow => ({ family, pid, range: range(), records: [rec(pid)], ...over });
    const good = Array.from({ length: 12 }, (_, i) => row('COMP', i));
    const candidates: SpotCheckRow[] = [
      ...good,
      row('ENHANCER', 0), // not a cloud-won family: skipped
      row('PRESET', 0), // no effect id: unverifiable
      row('block:200', 0), // synthetic key: skipped
      row('section:7', 0),
      row('GLOBAL', 5), // ok
      row('GLOBAL', 130), // GLOBAL above 127: never (unverifiable)
      row('RESONATOR', 0), // eid 162: only with above160 (else unverifiable)
      row('COMP', 100), // above the bound (60 here): unverifiable
      row('CHORUS', 130), // above 127: only with extendedIds (bound 200 here; else unverifiable)
      row('CHORUS', 1, { range: range({ displayMin: 5, displayMax: 5 }) }), // not informative: skipped
      // Only a placeholder / a special record at the address: still checked, as a v1 row.
      row('CHORUS', 2, { records: [rec(2, { min: 0, max: 0, def: 0, placeholder: true } as Partial<CacheRecord>)] }),
      row('CHORUS', 3, { records: [rec(3, { id: 0xff01 })] }),
      { family: 'CHORUS', pid: 4, range: range({ typecode: 0x52 }) }, // a v1 knob row: skipped
      row('CHORUS', 5, { range: range({ typecode: 0x52 }), records: [rec(5, { tc: 0x52 })] }), // a knob row with its record: ok
      { family: 'CHORUS', pid: 6, range: range() }, // a v1 row: ok
      // A real record next to placeholders (flagged before it, an all-zero float after it): the real one is checked.
      row('CHORUS', 8, { records: [rec(8, { min: 0, max: 0, def: 0, placeholder: true } as Partial<CacheRecord>), rec(8, { max: 9 }), rec(8, { min: 0, max: 0, def: 0 })] }),
      row('CHORUS', -1),
      row('CHORUS', 7.5),
      row('COMP', 0), // a repeat of (COMP, 0): one target
    ];
    const winners = ['COMP', 'GLOBAL', 'RESONATOR', 'CHORUS', 'PRESET', 'block:200', 'section:7'];
    const bounds: Record<number, number> = { [eidOf('COMP')!]: 60, [eidOf('CHORUS')!]: 200, [eidOf('GLOBAL')!]: 200, [eidOf('RESONATOR')!]: 60 };
    const planFor = (gates: SpotCheckTargetsInput['gates']) =>
      spotCheckTargets({ rows: candidates, winners, catalogCompare: () => 'exact', catalogBaseline: false, eidOf, boundOf: (e) => bounds[e] ?? -1, gates, n: 1000, rng: spotCheckRng(9) });
    const pick = (gates: SpotCheckTargetsInput['gates']) => planFor(gates).targets.map((t) => key(t.family, t.pid)).sort();
    const expect = (extra: string[]) => [...good.map((r) => key(r.family, r.pid)), 'GLOBAL:5', 'CHORUS:2', 'CHORUS:3', 'CHORUS:5', 'CHORUS:6', 'CHORUS:8', ...extra].sort();
    deepStrictEqual(pick(undefined), expect([]));
    deepStrictEqual(pick({ above160: true }), expect(['RESONATOR:0']));
    deepStrictEqual(pick({ extendedIds: true }), expect(['CHORUS:130']));
    // Unverifiable: PRESET:0, GLOBAL:130, RESONATOR:0, COMP:100, CHORUS:130 — one fewer under each gate.
    if (planFor(undefined).pools.unverifiable !== 5 || planFor({ above160: true }).pools.unverifiable !== 4 || planFor({ extendedIds: true }).pools.unverifiable !== 4) fail('eligibility: unverifiable count');
    // A v1 row carries no records; a raw row carries tuple fields only, placeholders dropped.
    const ts = planFor(undefined).targets;
    const at = (f: string, p: number) => ts.find((t) => t.family === f && t.pid === p)!;
    for (const p of [2, 3, 6]) if (at('CHORUS', p).records !== undefined) fail(`eligibility: CHORUS:${p} is compared as a v1 row`);
    deepStrictEqual(at('CHORUS', 8).records, [{ kind: 'float', id: 8, tc: 0x43, min: 0, max: 9, def: 1, step: 0 }]);
    const raw = at('COMP', 0);
    deepStrictEqual(raw.records, [{ kind: 'float', id: 0, tc: 0x43, min: 0, max: 10, def: 1, step: 0 }]);
    if (raw.block !== eidOf('COMP') || raw.bound !== 60) fail('eligibility: block and bound');
    // A bound above the gated id cap is capped in the target.
    const capped = spotCheckTargets({ rows: good, winners: ['COMP'], catalogCompare: () => 'exact', catalogBaseline: false, eidOf, boundOf: () => 500, rng: spotCheckRng(1) });
    if (capped.targets.some((t) => t.bound !== 127)) fail('eligibility: target bound capped at 127');
    // No hard bound supplied (not an integer) is a host bug: refused before any plan exists.
    for (const bad of [undefined, Number.NaN, 12.5, '40']) {
      let threw = false;
      try {
        spotCheckTargets({ rows: good, winners: ['COMP'], catalogCompare: () => 'exact', catalogBaseline: false, eidOf, boundOf: () => bad as unknown as number, rng: spotCheckRng(1) });
      } catch (e) {
        threw = e instanceof TypeError;
      }
      if (!threw) fail(`eligibility: boundOf returning ${String(bad)} must throw`);
    }
  }

  // ---- Case 12: deterministic with a seed ---------------------------------------------------------
  {
    deepStrictEqual(plan(honestRows, 1234), plan(honestRows, 1234));
    // Row order of the input does not matter.
    deepStrictEqual(plan([...honestRows].reverse(), 1234), plan(honestRows, 1234));
    const differs = [2, 3, 4, 5].some((s) => JSON.stringify(plan(honestRows, s).targets) !== JSON.stringify(plan(honestRows, 1).targets));
    if (!differs) fail('seed: different seeds give different draws');
    // The seeded generator is pinned (mulberry32).
    const g = spotCheckRng(42);
    deepStrictEqual([g(), g(), g()].map((x) => x.toFixed(10)), RNG_42);
    // Production randomness: crypto, uniform in [0, 1).
    const c = spotCheckRng();
    for (let i = 0; i < 100; i++) {
      const x = c();
      if (!(x >= 0 && x < 1)) fail('crypto rng: out of range');
    }
    // A broken rng is a caller bug.
    let threw = false;
    try {
      plan(honestRows, 1, { rng: () => 1 });
    } catch (e) {
      threw = e instanceof RangeError;
    }
    if (!threw) fail('rng: a value outside [0, 1) throws');
  }

  // ---- Case 13: v1 rows (derived tables only) ---------------------------------------------------------
  {
    const v1Rows = rowsOf(honest, true);
    const p = plan(v1Rows, 11);
    if (p.status !== 'ready' || p.targets.some((t) => t.records !== undefined || t.range.typecode === 0x52)) fail('v1: range targets, no knob rows');
    const r = await run(device(honest), p.targets);
    if (r.verdict !== 'passed') fail(`v1: ${r.verdict}`);
    // An edited display maximum fails; the device's own definition matches its derived row.
    const t0 = p.targets[0]!;
    const edited = p.targets.map((t) => (t === t0 ? { ...t, range: { ...t.range, displayMax: t.range.displayMax + 1 } } : t));
    const re = await run(device(honest), edited);
    if (re.verdict !== 'failed' || re.results[0]!.reason !== 'differs') fail('v1: an edited row fails');
    const rec = honest.find((h) => h.section === t0.block && h.id === t0.pid)!;
    if (!rangeMatchesDefinition(rangeRowOf(rec).row, rec)) fail('rangeMatchesDefinition: own row');
    if (rangeMatchesDefinition({ ...rangeRowOf(rec).row, typecode: rec.tc + 1 }, rec)) fail('rangeMatchesDefinition: typecode');
    // f32 noise is absorbed (six significant digits).
    if (!rangeMatchesDefinition({ typecode: 7, displayMin: 0.1, displayMax: 20 }, { tc: 7, min: Math.fround(0.1), max: 20, def: 0, step: 0 })) fail('rangeMatchesDefinition: f32 noise');
    if (!rangeMatchesDefinition({ typecode: 7, displayMin: 1, displayMax: 100 }, { tc: 7, min: 0.001, max: 0.1, def: 1000, step: 0 })) fail('rangeMatchesDefinition: display multiplier');
  }

  // ---- Case 14: rows of a derived profile document, end to end -------------------------------------------
  {
    const live = liveSource;
    const localFamilies = ['COMP', 'CHORUS'];
    const cloudFamilies = ['FLANGER', 'PHASER', 'TREMOLO', 'GATE'];
    // The cloud source also carries COMP (with an edited row): the local source wins COMP, so that row is never a target.
    const cloudRecs = [...honestRecords(cloudFamilies), ...replaced(honestRecords(['COMP']), 'COMP', 0, { tc: 999 })];
    const raw: ProfileRaw = { format: 1, sources: [live('local', T0, honestRecords(localFamilies)), live('cloud', T1, cloudRecs)] };
    const doc = deriveProfile(raw, PARAMS, {}, { model: FM3, firmware: '12.0', catalog: { familyFirstEid: FM3_EFFECT_IDS } });
    for (const f of [...localFamilies, ...cloudFamilies]) if (!doc.ranges[f]) fail(`derived doc: ${f} not assigned`);
    const { rows, winners } = spotCheckRows({ ...doc, raw });
    deepStrictEqual([...winners].sort(), [...cloudFamilies].sort());
    if (rows.some((r) => !cloudFamilies.includes(r.family))) fail('spotCheckRows: rows of cloud-won families only');
    for (const r of rows) {
      const src = cloudRecs.find((c) => c.section === eidOf(r.family) && c.id === r.pid);
      if (!src) fail(`spotCheckRows: ${r.family}:${r.pid} has no cloud record`);
      deepStrictEqual(r.records, [{ kind: src!.kind, id: src!.id, tc: src!.tc, min: src!.min, max: src!.max, def: src!.def, step: src!.step, ...(src!.kind === 'enum' ? { count: src!.count } : {}) }]);
    }
    // With local sources counted as well (a host option), every family is listed.
    if (spotCheckRows({ ...doc, raw }, { origins: ['cloud', 'local'] }).winners.length !== 6) fail('spotCheckRows: origins');
    // The host's own list of cloud source ids wins over the origins a document carries.
    const [localSrc, cloudSrc] = raw.sources as [LiveRawSource, LiveRawSource];
    deepStrictEqual(spotCheckRows({ ...doc, raw }, { cloudSourceIds: [cloudSrc.id] }).winners.sort(), [...cloudFamilies].sort());
    deepStrictEqual(spotCheckRows({ ...doc, raw }, { cloudSourceIds: [localSrc.id] }).winners.sort(), [...localFamilies].sort());
    // A downloaded document claiming its foreign source is 'local': the host's ids still catch it.
    const relabeled: ProfileRaw = { format: 1, sources: [localSrc, { ...cloudSrc, origin: 'local' }] };
    if (spotCheckRows({ ...doc, raw: relabeled }).winners.length !== 0) fail('spotCheckRows: an origin-only check trusts the label (documented)');
    deepStrictEqual(spotCheckRows({ ...doc, raw: relabeled }, { cloudSourceIds: [cloudSrc.id] }).winners.sort(), [...cloudFamilies].sort());
    // Fail closed: a family without an existence entry, or naming a source the document lacks, is cloud-won.
    const { COMP: _dropped, ...rest } = doc.provenance.existence;
    const tampered = { ...doc, raw, provenance: { ...doc.provenance, existence: { ...rest, CHORUS: 'live-readonly@nowhere#9' } } };
    const tw = spotCheckRows(tampered);
    deepStrictEqual(tw.winners.sort(), [...cloudFamilies, 'COMP', 'CHORUS'].sort());
    if (tw.rows.some((x) => (x.family === 'COMP' || x.family === 'CHORUS') && x.records !== undefined)) fail('fail closed: no records from an unknown winner (compared as v1 rows)');
    const tp = spotCheckTargets({ ...tw, catalogCompare: classifier(tw.rows), catalogBaseline: false, eidOf, boundOf, n: 1000, rng: spotCheckRng(3) });
    if (!tp.targets.some((t) => t.family === 'COMP') || !tp.targets.some((t) => t.family === 'CHORUS')) fail('fail closed: those rows are checked');
    // End to end: plan from the document, read back from the device.
    const p = spotCheckTargets({ rows, winners, catalogCompare: classifier(rows), catalogBaseline: false, eidOf, boundOf, rng: spotCheckRng(77) });
    if (p.status !== 'ready' || p.targets.some((t) => !cloudFamilies.includes(t.family))) fail('doc plan');
    const d = device(honest); // the unit has every family's honest table
    const r = await run(d, p.targets);
    if (r.verdict !== 'passed') fail(`doc run: ${r.verdict}`);
    audit('doc', d.trace, p.targets);
    // A v1 document (no raw): every catalog family is a winner, no row carries records.
    const v1 = spotCheckRows({ ranges: doc.ranges });
    if (v1.rows.some((x) => x.records !== undefined) || v1.winners.length !== Object.keys(doc.ranges).filter((k) => !/^(section|block):/.test(k)).length) fail('spotCheckRows: v1');
    // A local-only document: nothing is cloud-won -> not needed.
    const localOnly = deriveProfile({ format: 1, sources: [raw.sources[0]!] }, PARAMS, {}, { model: FM3, firmware: '12.0', catalog: { familyFirstEid: FM3_EFFECT_IDS } });
    const lo = spotCheckRows({ ...localOnly, raw: { format: 1, sources: [raw.sources[0]!] } });
    if (lo.winners.length !== 0 || lo.rows.length !== 0) fail('spotCheckRows: local-only');
    if (spotCheckTargets({ ...lo, catalogCompare: () => 'exact', catalogBaseline: false, eidOf, boundOf, rng: spotCheckRng(1) }).status !== 'not-needed') fail('local-only: not needed');
  }

  // ---- Case 15: budget, query cap, abort ---------------------------------------------------------------
  {
    // A slow unit: 1 s per query -> the 15 s budget ends the check after 15 targets.
    let clock = 0;
    const slow = device(honest, () => {
      clock += 1000;
      return undefined;
    });
    const rb = await run(slow, T, { now: () => clock });
    if (rb.verdict !== 'inconclusive' || rb.stopped !== 'budget' || rb.checked !== 15 || rb.queries !== 15 || rb.durationMs !== 15000) fail(`budget: ${rb.verdict} ${rb.checked} ${rb.durationMs}`);
    if (rb.results.slice(15).some((x) => x.outcome !== 'not-checked')) fail('budget: later targets not checked');
    // A mismatch before the budget ran out still fails.
    clock = 0;
    const wrong = T.map((t, i) => (i === 2 ? { ...t, records: [{ ...t.records![0]!, tc: t.records![0]!.tc + 1 }] } : t));
    if ((await run(device(honest, () => ((clock += 1000), undefined)), wrong, { now: () => clock })).verdict !== 'failed') fail('budget: a mismatch still fails');
    // An explicit query cap.
    const rq = await run(device(honest), T, { maxQueries: 20 });
    if (rq.verdict !== 'inconclusive' || rq.stopped !== 'queries' || rq.queries !== 20) fail('query cap');
    // Abort: the signal's reason rejects the check.
    const ctl = new AbortController();
    const reason = new Error('cancelled by host');
    const ab = device(honest, (w) => {
      if (w.total === 3) ctl.abort(reason);
      return undefined;
    });
    const err = await rejectsWith('abort', () => run(ab, T, { signal: ctl.signal }), Error);
    if (err !== reason || audit('abort', ab.trace, T) !== 3) fail('abort: stops at once with the reason');
    // A transport failure propagates as is.
    const broken: LiveTransport = { request: () => Promise.reject(new TypeError('port closed')) };
    await rejectsWith('transport error', () => runSpotCheck(broken, { model: FM3, targets: T, sleep: async () => {} }), TypeError);
  }

  // ---- Case 16: catalog baseline firmware — a compatible edit is priority 1 ------------------------------
  {
    // An edit that stays a compatible revision of the catalog row: a raised maximum (same typecode,
    // overlapping span) of one catalog-known float row.
    const vRec = honest.find((r) => r.section === eidOf('PHASER') && r.kind === 'float' && r.max > r.min && r.tc !== 0x52)!;
    const victim = { family: 'PHASER', pid: vRec.id };
    const doc = rowsOf(replaced(honest, victim.family, victim.pid, { max: f32(vRec.max + (vRec.max - vRec.min) / 2) }));
    if (classifier(doc)(victim.family, victim.pid) !== 'compatible') fail('baseline: the raised maximum is a compatible revision');
    // On the catalog's own firmware: always a priority-1 target, and the check fails on it.
    for (let seed = 1; seed <= 300; seed++) {
      const p = plan(doc, seed, { catalogBaseline: true });
      const v = p.targets.find((t) => t.family === victim.family && t.pid === victim.pid);
      if (!v || v.priority !== 1) fail(`baseline: seed ${seed} misses the compatible edit`);
      if (p.pools.new !== 1 || p.pools.changed !== 0 || p.targets.some((t) => t.priority === 2)) fail('baseline: no priority-2 pool on the baseline');
    }
    const pb = plan(doc, 31, { catalogBaseline: true });
    const rb = await run(device(honest), pb.targets);
    if (rb.verdict !== 'failed') fail(`baseline: ${rb.verdict}`);
    deepStrictEqual(rb.failures, [victim]);
    if (rb.results.find((x) => x.family === victim.family && x.pid === victim.pid)!.reason !== 'differs') fail('baseline: reason');
    // On another firmware the rule stays: a compatible revision is a priority-2 row (4 of the
    // compatible pool at random), not certain to be read.
    let changed = honest;
    const compatibleRows = honest.filter((r) => r.kind === 'float' && r.max > r.min && r.tc !== 0x52).slice(0, 10);
    for (const r of compatibleRows) changed = replaced(changed, familyOfEid.get(r.section)!, r.id, { max: f32(r.max + (r.max - r.min) / 2) });
    const docNewer = rowsOf(changed);
    const first = compatibleRows[0]!;
    const firstKey = { family: familyOfEid.get(first.section)!, pid: first.id };
    let hits = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const p = plan(docNewer, seed, { catalogBaseline: false });
      if (p.pools.new !== 0 || p.pools.changed !== 10 || p.targets.filter((t) => t.priority === 2).length !== SPOT_CHECK_LIMITS.changedRows) fail('newer firmware: P2 rule');
      const v = p.targets.find((t) => t.family === firstKey.family && t.pid === firstKey.pid);
      if (v && v.priority === 2) hits += 1;
    }
    if (hits === 0 || hits === 200) fail(`newer firmware: a compatible revision is drawn at random (${hits}/200)`);
    // The same ten edits on the baseline: all ten are priority 1.
    const onBaseline = plan(docNewer, 1, { catalogBaseline: true });
    if (onBaseline.pools.new !== 10 || onBaseline.targets.filter((t) => t.priority === 1).length !== 10) fail('baseline: all compatible edits in P1');
  }

  // ---- Case 17: extra placeholder records never take an edited row out of the check -----------------------
  {
    // A cloud source carries an edited PHASER row plus, at the same address, a flagged placeholder;
    // a second edited row is followed by an unflagged all-zero float. The derivation uses the edited
    // records; the spot check must select both rows (priority 1) and fail them.
    const phaser = eidOf('PHASER')!;
    const floats = honest.filter((r) => r.section === phaser && r.kind === 'float' && r.max > r.min && r.tc !== 0x52);
    const [a, b] = [floats[0]!, floats[1]!];
    const edit = (r: CacheRecord): CacheRecord => ({ ...r, min: f32(r.max + 100), max: f32(r.max + 200) } as CacheRecord);
    const flagged: CacheRecord = { kind: 'float', section: phaser, offset: 0, id: a.id, tc: 0, min: 0, max: 0, def: 0, step: 0, t1: 0, t2: 0, placeholder: true };
    const zero: CacheRecord = { kind: 'float', section: phaser, offset: 0, id: b.id, tc: 0, min: 0, max: 0, def: 0, step: 0, t1: 0, t2: 0 };
    const cloudRecs = honestRecords(['PHASER', 'FLANGER', 'TREMOLO'])
      .map((r) => (r.section === phaser && (r.id === a.id || r.id === b.id) ? edit(r) : r))
      .flatMap((r) => (r.section === phaser && r.id === a.id ? [flagged, r] : r.section === phaser && r.id === b.id ? [r, zero] : [r]));
    const raw: ProfileRaw = { format: 1, sources: [liveSource('local', T0, honestRecords(['COMP', 'CHORUS'])), liveSource('cloud', T1, cloudRecs)] };
    const doc = derive(raw);
    for (const r of [a, b]) {
      const derived = doc.ranges['PHASER']![r.id]!;
      if (derived.displayMax !== rangeRowOf(edit(r)).row.displayMax) fail(`placeholders: the derivation uses the edited record of PHASER:${r.id}`);
    }
    const { rows, winners } = spotCheckRows({ ...doc, raw });
    const rowA = rows.find((x) => x.family === 'PHASER' && x.pid === a.id)!;
    if (rowA.records?.length !== 2) fail('placeholders: spotCheckRows keeps every record at the address');
    for (let seed = 1; seed <= 100; seed++) {
      const p = spotCheckTargets({ rows, winners, catalogCompare: classifier(rows), catalogBaseline: false, eidOf, boundOf, rng: spotCheckRng(seed) });
      for (const r of [a, b]) {
        const t = p.targets.find((x) => x.family === 'PHASER' && x.pid === r.id);
        if (!t || t.priority !== 1) fail(`placeholders: seed ${seed} drops PHASER:${r.id}`);
        if (t!.records?.length !== 1 || t!.records![0]!.max !== edit(r).max) fail('placeholders: only the real record is expected');
      }
    }
    const p = spotCheckTargets({ rows, winners, catalogCompare: classifier(rows), catalogBaseline: false, eidOf, boundOf, rng: spotCheckRng(5) });
    const d = device(honest);
    const res = await run(d, p.targets);
    if (res.verdict !== 'failed') fail(`placeholders: ${res.verdict}`);
    deepStrictEqual(res.failures.map((f) => f.pid).sort((x, y) => x - y), [a.id, b.id].sort((x, y) => x - y));
    audit('placeholders', d.trace, p.targets);
  }

  // ---- Case 18: late replies, broken frames, option checks ---------------------------------------------------
  {
    // Targets alternate between two blocks at the SAME pid: replies echo the pid, not the block.
    const comp = eidOf('COMP')!;
    const chorus = eidOf('CHORUS')!;
    const byAddr = new Map(honestRows.map((r) => [`${eidOf(r.family)}:${r.pid}`, r]));
    const pairs: SpotCheckTarget[] = [];
    for (let pid = 0; pid <= 28 && pairs.length < 24; pid++) {
      const x = byAddr.get(`${comp}:${pid}`);
      const y = byAddr.get(`${chorus}:${pid}`);
      if (!x || !y || !isInformativeRow(x.range) || !isInformativeRow(y.range)) continue;
      if (x.records![0]!.tc === y.records![0]!.tc) continue; // a straggler must be told apart by its definition
      for (const r of [x, y]) pairs.push({ family: r.family, pid, block: eidOf(r.family)!, bound: boundOf(eidOf(r.family)!), priority: 3, range: r.range, records: [...r.records!] });
    }
    if (pairs.length < 12) fail(`late: only ${pairs.length} paired targets`);
    // The first COMP target loses its first reply; the retry answers — and the lost reply then
    // arrives late, held by the host until the next request unless it drains first.
    const lateDevice = (): ScriptedDevice => {
      let pending: Uint8Array | null = null;
      const inner = device(honest, (w, h) => {
        if (w.block === pairs[0]!.block && w.param === pairs[0]!.pid) {
          if (w.nth === 1) return null;
          if (w.nth === 2) pending = h; // the first reply, late
          return undefined;
        }
        if (pending) {
          const late = pending;
          pending = null;
          return late;
        }
        return undefined;
      });
      const drain = inner.drain!.bind(inner);
      inner.drain = () => {
        pending = null;
        drain();
      };
      return inner;
    };
    const ld = lateDevice();
    const rl = await run(ld, pairs);
    if (rl.verdict !== 'passed' || rl.mismatches !== 0) fail(`late reply after a recovered retry: ${rl.verdict} ${JSON.stringify(rl.failures)}`);
    if (ld.drains !== 2) fail(`late: drain before the retry and before the next target (${ld.drains})`);
    audit('late', ld.trace, pairs);

    // Structurally broken frames are lost (retried), never a mismatch.
    const honestFrame = async (t: SpotCheckTarget) => (await cacheDevice(honest).request(buildDefQuery(FM3, t.block, t.pid)))!;
    const truncated = async (t: SpotCheckTarget) => {
      const f = await honestFrame(t);
      return Uint8Array.from([...f.subarray(0, f.length - 12), 0x00, 0xf7]); // payload cut short
    };
    const shortPayload = (t: SpotCheckTarget) => replyFrame(VIEW_DEFINITION, t.pid, 0x3a, new Uint8Array(20)); // count 20
    const headerOnly = (t: SpotCheckTarget) => Uint8Array.from([0xf0, 0x00, 0x01, 0x74, FM3, 0x01, VIEW_DEFINITION, 0, 1, 0, t.pid & 0x7f, 0, 0x00, 0xf7]);
    const nanBody = (t: SpotCheckTarget) => replyFrame(VIEW_DEFINITION, t.pid, 0x3a, new Uint8Array(36).fill(0xff)); // complete, but no definition
    const frames = new Map<number, (t: SpotCheckTarget) => Uint8Array | Promise<Uint8Array>>([
      [2, truncated],
      [5, shortPayload],
      [8, headerOnly],
    ]);
    const brokenOnce: Script = (w) => {
      const i = T.findIndex((t) => t.block === w.block && t.pid === w.param);
      const make = frames.get(i);
      return make && w.nth === 1 ? Promise.resolve(make(T[i]!)) : undefined;
    };
    const rbk = await run(device(honest, brokenOnce), T);
    if (rbk.verdict !== 'passed' || rbk.queries !== 27 || [2, 5, 8].some((i) => rbk.results[i]!.outcome !== 'match')) fail(`broken frames are lost and retried: ${rbk.verdict} ${rbk.queries}`);
    const brokenAlways: Script = (w) => (T[4]!.block === w.block && T[4]!.pid === w.param ? shortPayload(T[4]!) : undefined);
    const rba = await run(device(honest, brokenAlways), T);
    if (rba.results[4]!.outcome !== 'unanswered' || rba.mismatches !== 0 || rba.verdict !== 'passed') fail('broken frames: unanswered, not a mismatch');
    const junk: Script = (w) => (T[6]!.block === w.block && T[6]!.pid === w.param ? nanBody(T[6]!) : undefined);
    const rj = await run(device(honest, junk), T);
    if (rj.results[6]!.reason !== 'pseudo' || rj.queries !== 24) fail('a complete payload without a definition is junk: a mismatch');

    // Invalid options are refused before any traffic.
    const d = device(honest);
    const bad: Array<Partial<SpotCheckRunOptions>> = [
      { pacingMs: -1 },
      { drainMs: Number.NaN },
      { budgetMs: Number.POSITIVE_INFINITY },
      { maxQueries: 1.5 },
      { maxQueries: -2 },
      { timeoutMs: 0 },
      { timeoutMs: Number.NaN },
      { model: 0x80 },
    ];
    for (const o of bad) {
      let threw = false;
      try {
        await run(d, T, o);
      } catch (e) {
        threw = e instanceof RangeError;
      }
      if (!threw) fail(`options: ${JSON.stringify(o)} must be refused`);
    }
    if (d.trace.length !== 0) fail('options: nothing sent');
    // maxQueries 0 is valid: nothing is sent, the check is inconclusive.
    const r0 = await run(d, T, { maxQueries: 0 });
    if (r0.verdict !== 'inconclusive' || r0.queries !== 0 || d.trace.length !== 0) fail('options: maxQueries 0');
  }

  // ---- Case 7 (runs last): TX audit over every run of this suite ------------------------------------------------
  {
    // A healthy check stays within 24 queries; even a lossy one within the cap of 32.
    const cap = SPOT_CHECK_TARGETS + SPOT_CHECK_LIMITS.extraQueries;
    const lossy = await run(device(honest, (w) => (w.total % 3 === 0 ? null : undefined)), T);
    if (lossy.queries > cap || lossy.stopped !== 'queries' || lossy.verdict !== 'inconclusive') fail(`query cap: ${lossy.queries} ${lossy.stopped}`);
    if (ALL_TX.length < 500) fail(`TX audit: too few frames (${ALL_TX.length})`);
    for (const f of ALL_TX) {
      const q = decodeWalkQuery(f);
      if (!q || q.model !== FM3 || q.view !== VIEW_DEFINITION || q.sub !== 0) fail('TX audit: a frame that is not a definition query reached a device');
      if (q!.block > SPOT_CHECK_LIMITS.maxBlock || q!.param > SPOT_CHECK_LIMITS.maxParamId) fail('TX audit: outside the read-only envelope');
    }
  }
}

/** `spotCheckRng(42)`: the first three draws (mulberry32), to 10 decimals. */
const RNG_42 = ['0.6011037519', '0.4482905590', '0.8524657935'];

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSpotCheckSuite();
  console.log('PASS cache/spot-check');
}
