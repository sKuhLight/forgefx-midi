/**
 * Live walk — the scope additions of profile v2: explicit id lists, bound hits, the query guard and
 * the opt-in abort rules.
 *
 * - an explicit id list (`paramIdsByBlock`) sends ONE definition query per listed id beyond the
 *   block's ceiling, each followed by a liveness re-read of the block's last real definition, and
 *   never queries a neighbour id, a label or a value for them;
 * - the list stops at the first id that is not a real definition of that id (junk, an end marker,
 *   a repeated symbol id, a straggler echoing another param, silence);
 * - a device that freezes on a listed id rejects the walk at the liveness re-read; `abortOnSilence`
 *   rejects at the silent id itself;
 * - `boundHits`: a block whose last real definition sits within 4 ids of its ceiling;
 * - read-only results are unchanged without the new options (a pinned golden of records, accounting
 *   and traffic, and the same with empty / inert options);
 * - `guardWalkTransport` refuses every frame outside the walk's scope before it reaches the device,
 *   and `walkQueryBound` / `walkListedIds` / `walkQueryAllowed` / `liveWalkScope` describe that scope;
 * - `abortOnImplausibleFrom` rejects at junk at or above its id (junk below it is skipped as before).
 *
 * Every case runs the real `liveWalkDetailed` over a fake `LiveTransport` of synthetic frames (the
 * shared encoders of `livewalk.test.ts`, the shared fixture device of `cacheDevice.ts`); nothing
 * opens a port.
 */
import {
  buildDefQuery,
  buildEnumQuery,
  decodeWalkQuery,
  guardWalkTransport,
  LIVE_WALK_LIMITS,
  liveWalkScope,
  LiveWalkAbortError,
  liveWalkDetailed,
  VIEW_DEFINITION,
  VIEW_ENUM_LABEL,
  VIEW_VALUE,
  walkListedIds,
  walkQueryAllowed,
  walkQueryBound,
  WalkBoundError,
} from '../../src/cache/index.js';
import type { LiveTransport, LiveWalkOptions, LiveWalkResult } from '../../src/cache/index.js';
import { fnv1a32Hex } from '../../src/cache/fingerprint.js';
import { endOfRangeFrame, replyFrame, sentinelFrame, valueReply } from './livewalk.test.js';
import { cacheDevice } from './cacheDevice.js';
import { loadWalk } from './profile-doc.test.js';

export const LIVEWALK_SCOPE_CASE_COUNT = 7;

const FM3 = 0x11;
const noSleep = (): Promise<void> => Promise.resolve();

// ===========================================================================
// Synthetic definitions and a recording / freezing fake device
// ===========================================================================

interface Def {
  id: number;
  tc: number;
  min: number;
  max: number;
  scale: number;
  def: number;
  step: number;
}

/** A 36-byte definition reply for `param` (echoing `echo`, default the param itself). */
function defFrame(param: number, d: Def, echo = param): Uint8Array {
  const buf = new Uint8Array(36);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, d.id, true);
  dv.setUint32(4, d.tc, true);
  dv.setFloat32(8, d.min, true);
  dv.setFloat32(12, d.max, true);
  dv.setFloat32(16, d.scale, true);
  dv.setFloat32(20, d.def, true);
  dv.setFloat32(24, d.step, true);
  return replyFrame(VIEW_DEFINITION, echo, 0x3a, buf);
}

/** A real continuous param under symbol id `id` (scale != 0: never label-walked). */
const realFloat = (id: number): Def => ({ id, tc: 2, min: 0, max: 10, scale: 1, def: 5, step: 0 });
/** The past-the-end answer: typecode 0, empty body, one fixed non-zero symbol id. */
const endMarker = (scale: number): Def => ({ id: 30011, tc: 0, min: 0, max: 0, scale, def: 0, step: 0 });
/** Junk shaped like a definition: bounds in the wrong order (implausible). */
const junk = (id: number): Def => ({ id, tc: 2, min: 10, max: 0, scale: 1, def: 5, step: 0 });

/** What a listed (or any) id answers: a definition, or one of the special answers. */
type Answer = Def | 'silent' | 'straggler';

interface BlockSpec {
  /** Params 0..real-1 are real floats under symbol ids `idBase + param`. */
  real: number;
  idBase?: number;
  /** Per-param override. */
  at?: Record<number, Answer>;
}

interface Q {
  view: number;
  block: number;
  param: number;
}

interface Probe extends LiveTransport {
  readonly sent: Q[];
  frozen: boolean;
  /** Definition queries of `block` above `param`, in order. */
  defsAbove(block: number, param: number): number[];
  count(view: number, block?: number, param?: number): number;
}

/** Block tables shaped like a unit's; with `freezeAbove`, a query above it silences the device forever. */
function scopeDevice(blocks: Record<number, BlockSpec>, freezeAbove?: number): Probe {
  const sent: Q[] = [];
  const answer = (q: Q): Uint8Array | null => {
    const t = blocks[q.block];
    if (q.view === VIEW_ENUM_LABEL) return endOfRangeFrame(VIEW_ENUM_LABEL, q.param);
    if (q.view === VIEW_VALUE) return t ? valueReply('5.00 dB', q.param) : sentinelFrame(q.view, q.param);
    if (q.view !== VIEW_DEFINITION || !t) return sentinelFrame(q.view, q.param);
    const x = t.at?.[q.param];
    if (x === 'silent') return null;
    if (x === 'straggler') return defFrame(q.param, realFloat(7000 + q.param), q.param + 1);
    if (x !== undefined) return defFrame(q.param, x);
    if (q.param < t.real) return defFrame(q.param, realFloat((t.idBase ?? 100) + q.param));
    return defFrame(q.param, endMarker(q.param === t.real ? 0 : 128));
  };
  const p: Probe = {
    sent,
    frozen: false,
    request(query: Uint8Array): Promise<Uint8Array | null> {
      const q = { view: query[6]!, block: query[8]! | (query[9]! << 7), param: query[10]! | (query[11]! << 7) };
      sent.push(q);
      if (p.frozen) return Promise.resolve(null);
      if (freezeAbove !== undefined && q.param > freezeAbove) {
        p.frozen = true;
        return Promise.resolve(null);
      }
      return Promise.resolve(answer(q));
    },
    defsAbove: (block, param) => sent.filter((q) => q.view === VIEW_DEFINITION && q.block === block && q.param > param).map((q) => q.param),
    count: (view, block, param) => sent.filter((q) => q.view === view && (block === undefined || q.block === block) && (param === undefined || q.param === param)).length,
  };
  return p;
}

const paramsOf = (res: LiveWalkResult, block: number): number[] => res.records.filter((r) => r.section === block).map((r) => r.id);
const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const same = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

async function rejects(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

// ===========================================================================
// Tests
// ===========================================================================

export async function runLiveWalkScope(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[cache/livewalk-scope] ${msg}`);
  };
  const base: LiveWalkOptions = { model: FM3, sleep: noSleep };
  /** Block 5: real 0..9, then end markers; ceiling 20 (the contiguous walk queries 0..20). */
  const B = 5;
  const LAST = 9;
  const CEIL = 20;

  // ---- Case 1: an id list never queries a neighbour ---------------------------------------
  {
    const dev = scopeDevice({ [B]: { real: LAST + 1, at: { 40: realFloat(5040), 45: realFloat(5045), 300: realFloat(5300) } } });
    const opts: LiveWalkOptions = { ...base, blocks: [B], maxParamId: CEIL, paramIdsByBlock: { [B]: [300, 45, 40, 45, 12, 1.5, 20000, -1] } };
    const res = await liveWalkDetailed(dev, opts);
    // Beyond the ceiling: exactly the listed ids, each followed by the re-read of the last real one.
    const start = dev.sent.findIndex((q) => q.view === VIEW_DEFINITION && q.param === 40);
    const seq = dev.sent.slice(start).map((q) => (q.view === VIEW_DEFINITION && q.block === B ? q.param : -1));
    if (!same(seq, [40, LAST, 45, LAST, 300, LAST])) fail(`listed traffic ${seq.join(',')} (want 40,9,45,9,300,9)`);
    if (!same(dev.defsAbove(B, CEIL), [40, 45, 300])) fail(`queried above the ceiling: ${dev.defsAbove(B, CEIL).join(',')}`);
    if (!same(paramsOf(res, B), [...range(0, LAST), 40, 45, 300])) fail(`records ${paramsOf(res, B).join(',')}`);
    for (const p of [40, 45, 300]) {
      if (dev.count(VIEW_VALUE, B, p) + dev.count(VIEW_ENUM_LABEL, B, p) !== 0) fail(`listed id ${p} got a label or value query`);
      const r = res.records.find((x) => x.section === B && x.id === p)!;
      if (r.kind !== 'float' || r.unit !== undefined) fail(`listed id ${p} record ${JSON.stringify(r)}`);
    }
    if (res.queries !== dev.sent.length) fail(`queries ${res.queries} vs sent ${dev.sent.length}`);
    if (!same(walkListedIds(opts, B), [40, 45, 300]) || !walkQueryAllowed(opts, B, 40) || walkQueryAllowed(opts, B, 41) || walkQueryAllowed(opts, B, 12 + CEIL)) fail('scope helpers');
    // FULL mode on a sweepable block (the FM3 amp, 58): the contiguous floats are swept, a listed id never.
    const AMP = 58;
    const sets: number[] = [];
    const fullDev = scopeDevice({ [AMP]: { real: LAST + 1, at: { 40: realFloat(5040) } } });
    const full = await liveWalkDetailed(fullDev, {
      ...base,
      mode: 'full',
      blocks: [AMP],
      maxParamId: CEIL,
      paramIdsByBlock: { [AMP]: [40] },
      sweepSettleMs: 0,
      write: {
        send: (frame) => {
          sets.push((frame[10]! & 0x7f) | ((frame[11]! & 0x7f) << 7));
          return Promise.resolve();
        },
        reloadPreset: () => Promise.resolve(),
      },
    });
    if (sets.length === 0 || sets.some((p) => p > LAST) || !paramsOf(full, AMP).includes(40) || fullDev.count(VIEW_VALUE, AMP, 40) !== 0) fail(`full mode: writes to ${[...new Set(sets)].join(',')}`);
    console.log(`  cache/livewalk-scope: id list [40, 45, 300] beyond ceiling ${CEIL} — one query each + a re-read of ${LAST}, no neighbour, label or value query (never swept in full mode); ids at or below the ceiling, duplicates, fractions and out-of-range ids ignored`);
  }

  // ---- Case 2: the list stops at the first id that is not a real definition of that id -----
  {
    const stoppers: Array<[string, Answer, (r: LiveWalkResult, ref: LiveWalkResult) => boolean]> = [
      ['junk', junk(5045), (r, ref) => r.pseudoReplies.implausible === ref.pseudoReplies.implausible + 1],
      ['end marker', endMarker(128), (r, ref) => r.pseudoReplies.endMarker === ref.pseudoReplies.endMarker + 1],
      ['repeated symbol id', realFloat(100 + 3), (r, ref) => r.pseudoReplies.duplicateId === ref.pseudoReplies.duplicateId + 1],
      ['straggler', 'straggler', (r, ref) => JSON.stringify(r.pseudoReplies) === JSON.stringify(ref.pseudoReplies)],
      ['silence', 'silent', (r, ref) => r.silentAddresses === ref.silentAddresses + 1 && r.lostReplies === ref.lostReplies],
    ];
    const plain = await liveWalkDetailed(scopeDevice({ [B]: { real: LAST + 1 } }), { ...base, blocks: [B], maxParamId: CEIL });
    for (const [name, answer, counted] of stoppers) {
      const dev = scopeDevice({ [B]: { real: LAST + 1, at: { 40: realFloat(5040), 45: answer, 50: realFloat(5050) } } });
      const res = await liveWalkDetailed(dev, { ...base, blocks: [B], maxParamId: CEIL, paramIdsByBlock: { [B]: [40, 45, 50] } });
      if (!same(dev.defsAbove(B, CEIL), [40, 45])) fail(`${name}: queried ${dev.defsAbove(B, CEIL).join(',')} (want 40,45 — never 50)`);
      if (!same(paramsOf(res, B), [...range(0, LAST), 40])) fail(`${name}: records ${paramsOf(res, B).join(',')}`);
      if (dev.count(VIEW_DEFINITION, B, LAST) !== 1 + 2) fail(`${name}: ${dev.count(VIEW_DEFINITION, B, LAST)} reads of ${LAST} (walk + one re-read per listed id)`);
      if (!counted(res, plain)) fail(`${name}: accounting ${JSON.stringify({ pseudo: res.pseudoReplies, silent: res.silentAddresses, lost: res.lostReplies })}`);
    }
    console.log(`  cache/livewalk-scope: the list stops at junk, an end marker, a repeated symbol id, a straggler echoing another param, or silence (counted as such; the next id is never queried)`);
  }

  // ---- Case 3: freeze simulation rejects; abortOnSilence rejects at the id ---------------------
  {
    const dev = scopeDevice({ [B]: { real: LAST + 1, at: { 40: realFloat(5040), 50: realFloat(5050) } } }, 44);
    const err = await rejects(liveWalkDetailed(dev, { ...base, blocks: [B], maxParamId: CEIL, paramIdsByBlock: { [B]: [40, 45, 50] } }));
    if (!(err instanceof Error) || !/stopped answering/.test(err.message)) fail(`freeze: ${String(err)}`);
    const last = dev.sent[dev.sent.length - 1]!;
    if (!dev.frozen || dev.defsAbove(B, CEIL).join() !== '40,45' || last.param !== LAST || last.view !== VIEW_DEFINITION) fail(`freeze traffic: ${JSON.stringify(dev.sent.slice(-4))}`);
    const quiet = scopeDevice({ [B]: { real: LAST + 1, at: { 40: realFloat(5040), 45: 'silent', 50: realFloat(5050) } } });
    const abort = await rejects(liveWalkDetailed(quiet, { ...base, blocks: [B], maxParamId: CEIL, paramIdsByBlock: { [B]: [40, 45, 50] }, abortOnSilence: true }));
    if (!(abort instanceof LiveWalkAbortError) || abort.code !== 'silent-run' || abort.block !== B || abort.param !== 45) fail(`abortOnSilence: ${String(abort)}`);
    const tail = quiet.sent[quiet.sent.length - 1]!;
    if (tail.param !== 45) fail(`abortOnSilence must stop at the silent id, last query ${JSON.stringify(tail)}`);
    // Inside the contiguous walk: after its retries, a silent definition rejects with the option and
    // is booked as an unresolved reply without it.
    const gap = { [B]: { real: LAST + 1, at: { 5: 'silent' } as Record<number, Answer> } };
    const gerr = await rejects(liveWalkDetailed(scopeDevice(gap), { ...base, blocks: [B], maxParamId: CEIL, abortOnSilence: true }));
    if (!(gerr instanceof LiveWalkAbortError) || gerr.code !== 'silent-run' || gerr.block !== B || gerr.param !== 5) fail(`contiguous abortOnSilence: ${String(gerr)}`);
    const soft = await liveWalkDetailed(scopeDevice(gap), { ...base, blocks: [B], maxParamId: CEIL });
    if (paramsOf(soft, B).includes(5) || soft.unresolvedReplies !== 1 || soft.missingSlots !== 1) fail(`without abortOnSilence: ${JSON.stringify({ unresolved: soft.unresolvedReplies, missing: soft.missingSlots })}`);
    console.log('  cache/livewalk-scope: a device freezing on listed id 45 rejects the walk at the liveness re-read (no further id); abortOnSilence rejects at a silent listed or contiguous id (without it: an unresolved reply)');
  }

  // ---- Case 4: bound hits ------------------------------------------------------------------
  {
    const dev = scopeDevice({ 1: { real: 126 }, 2: { real: 123 }, 3: { real: 100 }, 4: { real: 124 }, 6: { real: 50 } });
    const res = await liveWalkDetailed(dev, { ...base, blocks: [1, 2, 3, 4, 6], maxParamId: 127, readValues: false, paramBoundByBlock: { 6: 48 } });
    const got = JSON.stringify(res.boundHits);
    const want = JSON.stringify([
      { block: 1, lastReal: 125, bound: 127 },
      { block: 4, lastReal: 123, bound: 127 },
      { block: 6, lastReal: 48, bound: 48 },
    ]);
    if (got !== want) fail(`bound hits ${got}, want ${want}`);
    if (LIVE_WALK_LIMITS.boundHitMargin !== 4) fail('margin');
    console.log(`  cache/livewalk-scope: bound hits — last real 125 / 123 of ceiling 127 and 48 of hard bound 48 reported; 122 of 127 (5 ids off) and a short table not`);
  }

  // ---- Case 5: read-only results unchanged without the new options -------------------------
  {
    const walk = loadWalk('fm3-12p0.walk.json');
    const blocks = [...new Set(walk.records.filter((r) => r.id < 0xff00).map((r) => r.section))].sort((a, b) => a - b);
    const run = async (extra: Partial<LiveWalkOptions>) => {
      const dev = cacheDevice(walk.records);
      const res = await liveWalkDetailed(dev, { model: FM3, blocks, maxParamId: 127, sleep: dev.sleep, ...extra });
      return { res, trace: dev.trace.join('|'), entries: dev.trace.length };
    };
    const plain = await run({});
    // Golden of the options-free walk, pinned from the walker before the scope additions (the same
    // records, counters and traffic): a change to the read-only path fails here, not only a
    // difference between option sets. Re-pin only for a deliberate change of the walk.
    const { records: plainRecords, boundHits: plainHits, ...counters } = plain.res;
    const golden = {
      records: plainRecords.length,
      recordsHash: fnv1a32Hex(JSON.stringify(plainRecords)),
      counters,
      traffic: plain.entries,
      trafficHash: fnv1a32Hex(plain.trace),
      boundHits: (plainHits ?? []).map((h) => `${h.block}:${h.lastReal}/${h.bound}`).join(),
    };
    const pinned = {
      records: 1869,
      recordsHash: '1f3e19a4',
      counters: { queries: 12560, enumLabels: 8164, lostReplies: 0, recoveredReplies: 0, unresolvedReplies: 0, placeholderSlots: 125, missingSlots: 0, silentAddresses: 0, pseudoReplies: { endMarker: 0, duplicateId: 0, implausible: 0 } },
      traffic: 12560,
      trafficHash: '524ce3ba',
      boundHits: '1:126/127,2:127/127,10:127/127,58:127/127',
    };
    if (JSON.stringify(golden) !== JSON.stringify(pinned)) fail(`fixture walk golden changed: ${JSON.stringify(golden)}`);
    const empty = await run({ paramIdsByBlock: {}, abortOnSilence: false });
    // A list naming only ids the contiguous walk owns, and a list for a block not walked: no effect.
    const inert = await run({ paramIdsByBlock: { [blocks[0]!]: [0, 5, 127], 999: [200] } });
    for (const [name, other] of [['empty options', empty], ['inert lists', inert]] as const) {
      if (JSON.stringify(other.res) !== JSON.stringify(plain.res) || other.trace !== plain.trace) fail(`${name}: result or traffic differs`);
    }
    // No implausible reply in a clean walk: the abort threshold changes nothing either.
    const guarded = await run({ abortOnImplausibleFrom: 0 });
    if (JSON.stringify(guarded.res) !== JSON.stringify(plain.res)) fail('abortOnImplausibleFrom on a clean walk');
    console.log(`  cache/livewalk-scope: fixture walk (${plain.res.records.length} records, ${plain.res.queries} queries) equals its pinned golden, and is identical with empty / inert lists and the abort options`);
  }

  // ---- Case 6: the query guard and the scope helpers ---------------------------------------
  {
    const opts: LiveWalkOptions = { model: FM3, blocks: [B, 7, 8], maxParamId: 20, paramBoundByBlock: { 7: -1 }, paramKnownSizeByBlock: { 8: 10 }, paramIdsByBlock: { [B]: [40] } };
    const bounds = [B, 7, 8, 9].map((b) => walkQueryBound(opts, b));
    if (bounds.join() !== '20,-1,20,-1') fail(`walkQueryBound ${bounds.join()}`);
    const wide = { ...opts, maxParamId: 127 };
    if (walkQueryBound(wide, 8) !== 10 - 1 + LIVE_WALK_LIMITS.stopRun || walkQueryBound({ ...wide, paramBoundByBlock: { 8: 200 } }, 8) !== 200) fail('known size / hard bound ceilings');
    const passed: number[] = [];
    const inner: LiveTransport = {
      request(q: Uint8Array) {
        passed.push(decodeWalkQuery(q)!.param);
        return Promise.resolve(null);
      },
    };
    const guarded = guardWalkTransport(inner, opts, { maxParamId: 30 });
    const ok = [buildDefQuery(FM3, B, 20), buildDefQuery(FM3, B, 0), buildEnumQuery(FM3, B, 3, 7)];
    for (const q of ok) await guarded.request(q);
    const refused: Array<[string, Uint8Array]> = [
      ['above the ceiling', buildDefQuery(FM3, B, 21)],
      ['listed id above the guard cap', buildDefQuery(FM3, B, 40)],
      ['skipped block', buildDefQuery(FM3, 7, 0)],
      ['block outside the scope', buildDefQuery(FM3, 9, 0)],
      ['another model', buildDefQuery(0x12, B, 0)],
      ['not a walk query', Uint8Array.from([0xf0, 0x00, 0x01, 0x74, FM3, 0x01, 0x52, 0x00, B, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0xf7])],
    ];
    for (const [name, q] of refused) {
      const e = await rejects(guarded.request(q));
      if (!(e instanceof WalkBoundError) || e.code !== 'walk-bound') fail(`${name}: ${String(e)}`);
    }
    const e = (await rejects(guarded.request(buildDefQuery(FM3, B, 21)))) as WalkBoundError;
    if (e.block !== B || e.param !== 21 || e.view !== VIEW_DEFINITION) fail(`WalkBoundError fields ${JSON.stringify({ b: e.block, p: e.param, v: e.view })}`);
    // Without the cap the listed id passes.
    await guardWalkTransport(inner, opts).request(buildDefQuery(FM3, B, 40));
    if (passed.join() !== '20,0,3,40') fail(`passed ${passed.join()}`);
    const d = decodeWalkQuery(buildDefQuery(FM3, 300, 200));
    if (!d || d.model !== FM3 || d.view !== VIEW_DEFINITION || d.block !== 300 || d.param !== 200 || d.sub !== 0) fail(`decodeWalkQuery ${JSON.stringify(d)}`);
    // The scope a raw source records, planned exactly like the walk (`liveWalkScope`).
    const scope = liveWalkScope({ ...wide, blocks: [8, B, 7, B], enumHintByBlock: {} });
    if (
      scope.blocks.join() !== `${B},8` ||
      scope.maxParamId !== 127 ||
      JSON.stringify(scope.bounds) !== JSON.stringify({ 8: 10 - 1 + LIVE_WALK_LIMITS.stopRun }) ||
      scope.idLists !== undefined ||
      !scope.hinted || scope.extended || scope.above160
    ) {
      fail(`liveWalkScope ${JSON.stringify(scope)}`);
    }
    for (const b of scope.blocks) if ((scope.bounds[b] ?? scope.maxParamId) !== walkQueryBound(wide, b)) fail(`scope ceiling of ${b}`);
    const listed = liveWalkScope({ ...opts, paramIdsByBlock: { [B]: [40, 10, 40] } }, { extended: true, hinted: false });
    if (JSON.stringify(listed.idLists) !== JSON.stringify({ [B]: [40] }) || !listed.extended || listed.hinted) fail(`liveWalkScope id lists ${JSON.stringify(listed)}`);
    console.log('  cache/livewalk-scope: the guard passes in-scope queries (listed ids included) and refuses ceilings, caps, skipped / foreign blocks, other models and non-walk frames before the device; liveWalkScope records the planned ceilings and lists');
  }

  // ---- Case 7: abortOnImplausibleFrom ------------------------------------------------------
  {
    const spec = { [B]: { real: 140, at: { 100: junk(9100), 128: junk(9128) } as Record<number, Answer> } };
    const plainDev = scopeDevice(spec);
    const plain = await liveWalkDetailed(plainDev, { ...base, blocks: [B], maxParamId: 200, readValues: false });
    if (paramsOf(plain, B).includes(128) || !paramsOf(plain, B).includes(139) || plain.pseudoReplies.implausible !== 2) fail(`without the option: ${plain.pseudoReplies.implausible} implausible`);
    const err = await rejects(liveWalkDetailed(scopeDevice(spec), { ...base, blocks: [B], maxParamId: 200, readValues: false, abortOnImplausibleFrom: 128 }));
    if (!(err instanceof LiveWalkAbortError) || err.code !== 'implausible-reply' || err.block !== B || err.param !== 128) fail(`abortOnImplausibleFrom: ${String(err)}`);
    // Listed ids obey it too.
    const listDev = scopeDevice({ [B]: { real: LAST + 1, at: { 200: junk(9200) } } });
    const lerr = await rejects(liveWalkDetailed(listDev, { ...base, blocks: [B], maxParamId: CEIL, paramIdsByBlock: { [B]: [200, 210] }, abortOnImplausibleFrom: 128 }));
    if (!(lerr instanceof LiveWalkAbortError) || lerr.param !== 200) fail(`listed junk: ${String(lerr)}`);
    console.log('  cache/livewalk-scope: abortOnImplausibleFrom 128 rejects at junk at 128 (and at a listed id), junk at 100 is skipped as before');
  }
}
