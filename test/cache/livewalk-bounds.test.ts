/**
 * Live walk — where it stops, what it ignores, what it may write.
 *
 * A device does not announce the end of a parameter table. Past the last real param every query
 * answers one fixed END MARKER (typecode 0, empty body, a fixed non-zero symbol id, scale 0 or 128);
 * much further out junk shaped like a definition comes back; and a single definition query far
 * outside a table froze a unit until a power cycle. The walk therefore (1) never queries above a
 * per-block ceiling (`paramBoundByBlock` is a HARD one; `paramKnownSizeByBlock` allows the known
 * table plus one stop run for params a newer firmware appends), (2) ends a block a small run past
 * its last real definition (the ids below a known table size are walked without that stop), (3)
 * treats end markers, repeated non-zero ids and implausible junk as ABSENT slots, and (4) in FULL
 * mode sweeps (= WRITES) only a trustworthy record inside its ceiling.
 *
 * Every case runs the real `liveWalkDetailed` over a fake `LiveTransport` of synthetic frames
 * (the shared encoders of `livewalk.test.ts`); no device bytes, nothing opens a port. The fakes
 * record every query, so a case can assert the highest param a walk ever sent, and the freezing fake
 * goes silent forever the moment one query crosses its threshold.
 */
import { buildCache, decodeReply, liveSource, liveWalkDetailed, VIEW_DEFINITION, VIEW_ENUM_LABEL, VIEW_VALUE } from '../../src/cache/index.js';
import type { LiveTransport, LiveWalkOptions, LiveWalkResult, LiveWalkWriteHooks } from '../../src/cache/index.js';
import type { DeviceParam } from '../../src/cache/types.js';
import { endOfRangeFrame, replyFrame, sentinelFrame, valueReply } from './livewalk.test.js';

export const LIVEWALK_BOUNDS_CASE_COUNT = 16;

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

/** A 36-byte definition reply for `param` (view 0x1c, tag 0x3a). */
function defFrame(param: number, d: Def): Uint8Array {
  const buf = new Uint8Array(36);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, d.id, true);
  dv.setUint32(4, d.tc, true);
  dv.setFloat32(8, d.min, true);
  dv.setFloat32(12, d.max, true);
  dv.setFloat32(16, d.scale, true);
  dv.setFloat32(20, d.def, true);
  dv.setFloat32(24, d.step, true);
  return replyFrame(VIEW_DEFINITION, param, 0x3a, buf);
}

/** A real continuous param (scale != 0, no hint → float, never label-walked) under a unique symbol id. */
const realFloat = (id: number): Def => ({ id, tc: 2, min: 0, max: 10, scale: 1, def: 5, step: 0 });
/** An enum-shaped body (step 0, scale 0, integral bounds): a label walk would follow if accepted. */
const enumShaped = (id: number): Def => ({ id, tc: 16, min: 0, max: 3, scale: 0, def: 0, step: 0 });
/** The past-the-end answer: typecode 0, empty body, one fixed non-zero symbol id. */
const END_MARKER_ID = 30011;
const endMarker = (scale: number): Def => ({ id: END_MARKER_ID, tc: 0, min: 0, max: 0, scale, def: 0, step: 0 });

interface Q {
  view: number;
  block: number;
  param: number;
  sub: number;
}

function decodeQuery(query: Uint8Array): Q {
  return { view: query[6]!, block: query[8]! | (query[9]! << 7), param: query[10]! | (query[11]! << 7), sub: query[12]! | (query[13]! << 7) };
}

type Responder = (q: Q) => Uint8Array | null;

interface Probe extends LiveTransport {
  readonly sent: Q[];
  /** True once a query crossed the freeze threshold: the device never answers again. */
  frozen: boolean;
  /** Highest param of any query (any view) sent to `block`, or -1. */
  maxParam(block: number): number;
  /** Queries of `view` (optionally for one block / param). */
  count(view: number, block?: number, param?: number): number;
}

/** Records every query; with `freezeAbove`, a query above it silences the device forever. */
function probe(respond: Responder, freezeAbove?: number): Probe {
  const sent: Q[] = [];
  const p: Probe = {
    sent,
    frozen: false,
    request(query: Uint8Array): Promise<Uint8Array | null> {
      const q = decodeQuery(query);
      sent.push(q);
      if (p.frozen) return Promise.resolve(null);
      if (freezeAbove !== undefined && q.param > freezeAbove) {
        p.frozen = true;
        return Promise.resolve(null);
      }
      return Promise.resolve(respond(q));
    },
    maxParam: (block) => sent.reduce((m, q) => (q.block === block ? Math.max(m, q.param) : m), -1),
    count: (view, block, param) => sent.filter((q) => q.view === view && (block === undefined || q.block === block) && (param === undefined || q.param === param)).length,
  };
  return p;
}

interface TableSpec {
  /** Params 0..real-1 are real floats under unique ids `idBase + param`. */
  real: number;
  idBase?: number;
  /** Per-param override: a definition, `null` for a sentinel, `undefined` for the default answer. */
  extra?: (param: number) => Def | null | undefined;
}

/**
 * Block tables shaped like a unit's: real params, then the end marker for EVERY further id (scale 0
 * at the first, 128 after), and a sentinel for blocks without a table. Label queries answer the
 * end-of-list reply, value queries a constant display.
 */
function tableDevice(blocks: Record<number, TableSpec>, freezeAbove?: number): Probe {
  return probe((q) => {
    const t = blocks[q.block];
    if (q.view === VIEW_ENUM_LABEL) return endOfRangeFrame(VIEW_ENUM_LABEL, q.param);
    if (q.view === VIEW_VALUE) return t ? valueReply('5.00', q.param) : sentinelFrame(q.view, q.param);
    if (q.view !== VIEW_DEFINITION || !t) return sentinelFrame(q.view, q.param);
    const x = t.extra?.(q.param);
    if (x === null) return sentinelFrame(q.view, q.param);
    if (x !== undefined) return defFrame(q.param, x);
    if (q.param < t.real) return defFrame(q.param, realFloat((t.idBase ?? 100) + q.param));
    return defFrame(q.param, endMarker(q.param === t.real ? 0 : 128));
  }, freezeAbove);
}

/** Continuous-SET frame (sub 0x52 0x00) → (block, param). The walk's only write. */
function decodeSet(frame: Uint8Array): { eid: number; pid: number } | null {
  if (frame.length !== 23 || frame[5] !== 0x01 || frame[6] !== 0x52 || frame[7] !== 0x00) return null;
  return { eid: (frame[8]! & 0x7f) | ((frame[9]! & 0x7f) << 7), pid: (frame[10]! & 0x7f) | ((frame[11]! & 0x7f) << 7) };
}

interface Writes {
  hooks: LiveWalkWriteHooks;
  sets: Array<{ eid: number; pid: number }>;
  reloads: number;
}

function writes(): Writes {
  const w: Writes = {
    sets: [],
    reloads: 0,
    hooks: {
      send: (frame) => {
        const d = decodeSet(frame);
        if (d) w.sets.push(d);
        return Promise.resolve();
      },
      reloadPreset: () => {
        w.reloads += 1;
        return Promise.resolve();
      },
    },
  };
  return w;
}

const paramsOf = (res: LiveWalkResult, block: number): number[] => res.records.filter((r) => r.section === block).map((r) => r.id);
const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const sameList = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

// ===========================================================================
// Tests
// ===========================================================================

export async function runLiveWalkBounds(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[cache/livewalk-bounds] ${msg}`);
  };
  const base: LiveWalkOptions = { model: FM3, readValues: false, sleep: noSleep };

  // ---- Case 1: the block-1 pattern — real 0..132, then the end marker ----------------------
  {
    // The old default walked the whole 14-bit space here; ForgeFX's FULL build still passes 16383.
    const dev = tableDevice({ 1: { real: 133 } });
    const res = await liveWalkDetailed(dev, { ...base, blocks: [1], maxParamId: 16383 });
    if (!sameList(paramsOf(res, 1), range(0, 132))) fail(`block-1 pattern: ${res.records.length} records, want the 133 real ones (0..132)`);
    // 133..164: the first 32 params past the table are the whole stop run — queries 0..164 and no more.
    if (dev.maxParam(1) !== 132 + 32 || res.queries !== 133 + 32) fail(`stop run: highest param ${dev.maxParam(1)}, ${res.queries} queries (want 164 / 165)`);
    if (res.pseudoReplies.endMarker !== 32 || res.pseudoReplies.duplicateId !== 0 || res.pseudoReplies.implausible !== 0) {
      fail(`pseudo stats: ${JSON.stringify(res.pseudoReplies)} (want 32 end markers)`);
    }
    // The marker at 133 is enum-shaped (scale 0): were it a record it would be label-walked.
    if (dev.count(VIEW_ENUM_LABEL) !== 0) fail(`${dev.count(VIEW_ENUM_LABEL)} label queries: an end marker was treated as a definition`);
    if (res.placeholderSlots !== 0 || res.lostReplies !== 0 || res.silentAddresses !== 0) fail(`unexpected accounting: ${JSON.stringify({ ...res, records: undefined })}`);
    // Both scales of the marker decode as an ordinary definition and are filler either way.
    for (const scale of [0, 128]) {
      const d = decodeReply(defFrame(140, endMarker(scale)));
      if (!d || d.view !== 'definition' || d.tc !== 0 || d.id !== END_MARKER_ID || d.scale !== scale) fail(`end marker (scale ${scale}) did not decode as expected`);
    }
    // The count reaches the persisted profile.
    const params: DeviceParam[] = [{ family: 'AMP', paramId: 0, name: 'AMP_GAIN' }];
    const built = await buildCache(liveSource(tableDevice({ 1: { real: 133 } }), { ...base, blocks: [1], maxParamId: 16383 }), params, {}, {});
    if (built.meta.walk?.pseudoReplies?.endMarker !== 32) fail(`meta.walk.pseudoReplies missing: ${JSON.stringify(built.meta.walk)}`);
    // A result from a walk that predates the count omits the field (no `pseudoReplies: undefined`).
    const older = { records: [], queries: 1, enumLabels: 0, lostReplies: 0, recoveredReplies: 0, unresolvedReplies: 0, placeholderSlots: 0, missingSlots: 0, silentAddresses: 0 };
    const legacy = await buildCache({ kind: 'live', walk: async () => older as unknown as LiveWalkResult }, params, {}, {});
    if (!legacy.meta.walk || 'pseudoReplies' in legacy.meta.walk) fail(`a result without pseudoReplies must omit the field: ${JSON.stringify(legacy.meta.walk)}`);
    // An INNER unused slot that answers with a non-zero id is counted as an end marker AND still becomes a placeholder.
    const inner = tableDevice({ 2: { real: 7, extra: (p) => (p === 3 ? endMarker(0) : undefined) } });
    const ri = await liveWalkDetailed(inner, { ...base, blocks: [2] });
    // Param 3 answers a marker body inside the table: real rows 0..2 and 4..6, plus a placeholder at 3.
    if (ri.placeholderSlots !== 1 || !sameList(ri.records.map((r) => r.id), range(0, 6))) {
      fail(`inner marker slot: ${ri.records.map((r) => r.id).join(',')} / placeholders ${ri.placeholderSlots}`);
    }
    if (ri.pseudoReplies.endMarker !== 1 + 32) fail(`inner marker slot counted ${ri.pseudoReplies.endMarker} end markers, want 1 + 32 trailing`);
  }
  console.log('  cache/livewalk-bounds: block-1 pattern — 133 real records, stop run of 32 end markers (scale 0 and 128), counted into meta.walk (field omitted for older results; an inner marker slot still becomes a placeholder)');

  // ---- Case 2: junk at far ids is never queried; a reused marker id is rejected ------------
  {
    const farJunk = (param: number): Def | null | undefined => {
      if (param === 2000) return { id: 7001, tc: 16, min: -5, max: 60000, scale: 0, def: 1, step: 0 };
      if (param === 9000) return { id: END_MARKER_ID, tc: 3001, min: 0, max: 30000, scale: 25000, def: 0, step: 0 };
      if (param === 16000) return null; // a short non-definition reply
      return undefined;
    };
    const dev = tableDevice({ 1: { real: 133, extra: farJunk } });
    const res = await liveWalkDetailed(dev, { ...base, blocks: [1], maxParamId: 16383 });
    const far = dev.sent.filter((q) => q.param > 164);
    if (far.length > 0 || !sameList(paramsOf(res, 1), range(0, 132))) fail(`far ids were queried (${far.map((q) => q.param).join(',')}) or the records changed`);
    // Negative control: forced to run far (the old behaviour), the same device DOES serve junk there —
    // the junk that repeats the marker's id is rejected, nothing at 9000 becomes a record.
    const old = tableDevice({ 1: { real: 133, extra: farJunk } });
    const forced = await liveWalkDetailed(old, { ...base, blocks: [1], maxParamId: 16383, paramAbsentRunLimit: 100000 });
    if (old.maxParam(1) !== 16383) fail(`negative control did not reach the far ids (${old.maxParam(1)})`);
    if (paramsOf(forced, 1).includes(9000) || forced.pseudoReplies.duplicateId < 1) {
      fail(`a definition reusing the end marker's id was kept: ${JSON.stringify(forced.pseudoReplies)}`);
    }
  }
  console.log('  cache/livewalk-bounds: junk at far ids is never queried; junk reusing the end-marker id is rejected when reached');

  // ---- Case 3: a device that freezes on a far query is never sent one ---------------------
  {
    const FREEZE = 600; // a query above this silences the fake for good
    const layout = { 0: { real: 512, idBase: 1000 }, 1: { real: 133, idBase: 5000 } };
    const w = writes();
    // (a) FULL mode on its defaults.
    const a = tableDevice(layout, FREEZE);
    const ra = await liveWalkDetailed(a, { ...base, blocks: [0, 1], mode: 'full', write: w.hooks });
    if (a.frozen || a.maxParam(0) !== 511 || a.maxParam(1) !== 164) fail(`full defaults: frozen=${a.frozen}, highest ${a.maxParam(0)} / ${a.maxParam(1)} (want 511 / 164)`);
    if (paramsOf(ra, 0).length !== 512 || paramsOf(ra, 1).length !== 133) fail('full defaults: records lost');
    if (w.sets.some((s) => s.pid > 511)) fail('full defaults: a SET above the ceiling');
    // (b) read-only and (c) FULL with the caller's old wide-open ceiling: the stop run alone holds the line.
    for (const mode of ['read-only', 'full'] as const) {
      const d = tableDevice(layout, FREEZE);
      await liveWalkDetailed(d, { ...base, blocks: [0, 1], maxParamId: 16383, ...(mode === 'full' ? { mode, write: writes().hooks } : {}) });
      if (d.frozen || d.maxParam(0) !== 511 + 32 || d.maxParam(1) !== 164) fail(`${mode} wide-open ceiling: frozen=${d.frozen}, highest ${d.maxParam(0)} / ${d.maxParam(1)}`);
    }
    // (d) hard bounds: exactly the table sizes, nothing past them.
    const bounded = tableDevice(layout, FREEZE);
    const rb = await liveWalkDetailed(bounded, { ...base, blocks: [0, 1], mode: 'full', write: writes().hooks, maxParamId: 16383, paramBoundByBlock: { 0: 511, 1: 132 } });
    if (bounded.frozen || bounded.maxParam(0) !== 511 || bounded.maxParam(1) !== 132 || bounded.count(VIEW_DEFINITION) !== 512 + 133) {
      fail(`hard bounds: frozen=${bounded.frozen}, highest ${bounded.maxParam(0)} / ${bounded.maxParam(1)}, ${bounded.count(VIEW_DEFINITION)} definition queries`);
    }
    if (rb.pseudoReplies.endMarker !== 0) fail('hard bounds: the walk still probed past the table');
    // (e) negative control — the old shape (run limit 256) DOES cross the threshold and the walk rejects.
    const old = tableDevice(layout, FREEZE);
    let error = '';
    try {
      await liveWalkDetailed(old, { ...base, blocks: [0, 1], maxParamId: 16383, paramAbsentRunLimit: 256 });
    } catch (e) {
      error = (e as Error).message;
    }
    if (!old.frozen || old.maxParam(0) <= FREEZE || !/stopped answering/.test(error)) fail(`negative control: frozen=${old.frozen}, highest ${old.maxParam(0)}, error "${error}"`);
  }
  console.log('  cache/livewalk-bounds: a transport that freezes above id 600 is never sent such a query (defaults, wide-open ceiling, hard bounds); the old run limit would have frozen it');

  // ---- Case 4: repeated non-zero ids are pseudo records; id 0 is shared by real params -----
  {
    const BLOCK = 5;
    const dev = tableDevice({
      [BLOCK]: {
        real: 10,
        extra: (p) => {
          if (p >= 10 && p <= 11) return realFloat(100 + p - 7); // float-shaped copies of ids 103, 104
          if (p >= 12 && p <= 14) return enumShaped(100 + p - 7); // enum-shaped copies of 105..107: a label walk if accepted
          if (p === 15 || p === 16) return realFloat(0); // two real params, both "no symbol id"
          if (p >= 17 && p <= 19) return realFloat(300 + p);
          if (p >= 20) return endMarker(128);
          return undefined;
        },
      },
    });
    const res = await liveWalkDetailed(dev, { ...base, blocks: [BLOCK], readValues: true });
    const want = [...range(0, 9), ...range(15, 19)];
    if (!sameList(paramsOf(res, BLOCK), want)) fail(`duplicate ids: records ${paramsOf(res, BLOCK).join(',')}, want ${want.join(',')}`);
    if (res.pseudoReplies.duplicateId !== 5) fail(`duplicate ids counted ${res.pseudoReplies.duplicateId}, want 5`);
    for (const p of range(10, 14)) {
      if (dev.count(VIEW_ENUM_LABEL, BLOCK, p) + dev.count(VIEW_VALUE, BLOCK, p) !== 0) fail(`param ${p} (a repeated id) was label- or value-probed`);
    }
    if (res.placeholderSlots !== 0) fail(`a run of repeated-id junk became ${res.placeholderSlots} placeholder rows`);
    // A definition that reuses the id of an END MARKER inside the table gap is the same junk.
    const gap = tableDevice({ 6: { real: 4, extra: (p) => (p === 10 ? { id: END_MARKER_ID, tc: 3001, min: 0, max: 30000, scale: 25000, def: 0, step: 0 } : undefined) } });
    const rg = await liveWalkDetailed(gap, { ...base, blocks: [6] });
    if (!sameList(paramsOf(rg, 6), range(0, 3)) || rg.pseudoReplies.duplicateId !== 1) fail(`marker-id reuse: ${paramsOf(rg, 6).join(',')} / ${JSON.stringify(rg.pseudoReplies)}`);
  }
  console.log('  cache/livewalk-bounds: a repeated non-zero symbol id is a pseudo record (no record, label walk or unit read); id 0 stays valid');

  // ---- Case 5: implausible definitions are rejected, wide integer-bounded ranges are kept ---
  {
    const BLOCK = 7;
    const dev = tableDevice({
      [BLOCK]: {
        real: 1,
        extra: (p) => {
          if (p === 1) return { id: 3100000001, tc: 0, min: 3e12, max: 0, scale: 0, def: 0, step: 0 }; // enum-shaped, min > max
          if (p === 2) return { id: 1060000001, tc: 11, min: 150, max: 1, scale: 0, def: -2e-7, step: 2e-7 }; // float, min > max
          if (p === 3) return { id: 2100000001, tc: 0, min: -5e-36, max: 0, scale: -5e-36, def: 0, step: -5e-36 }; // near-subnormal body
          if (p === 4) return { id: 0, tc: 0, min: 0, max: 600, scale: 0, def: 0, step: 3e-12 }; // a near-zero float field among real ones
          if (p === 5) return { id: 4101, tc: 600, min: 150, max: 18000, scale: 0, def: 1, step: 0 }; // a real Hz-style range that looks enum-shaped
          if (p === 6) return { id: 4102, tc: 2, min: 0, max: 1, scale: 1, def: 0, step: 1e-6 }; // a real fine step stays
          if (p >= 7) return endMarker(128);
          return undefined;
        },
      },
    });
    const res = await liveWalkDetailed(dev, { ...base, blocks: [BLOCK] });
    if (!sameList(paramsOf(res, BLOCK), [0, 5, 6])) fail(`implausible: records ${paramsOf(res, BLOCK).join(',')}, want 0,5,6`);
    if (res.pseudoReplies.implausible !== 4) fail(`implausible counted ${res.pseudoReplies.implausible}, want 4`);
    // Only the kept wide range was label-probed (one query: the answered-empty list makes it a float).
    if (dev.count(VIEW_ENUM_LABEL) !== 1 || dev.count(VIEW_ENUM_LABEL, BLOCK, 5) !== 1) fail(`label queries: ${dev.count(VIEW_ENUM_LABEL)} (want exactly 1, for param 5)`);
    if (res.records.find((r) => r.id === 5)?.kind !== 'float') fail('the 150..18000 range should classify float after its label list answered empty');
  }
  console.log('  cache/livewalk-bounds: min > max and near-zero float junk (below 1e-9) are rejected; an integer-bounded 150..18000 range and a 1e-6 step are kept');

  // ---- Case 6: FULL mode writes only trustworthy records inside their bound ----------------
  {
    const BLOCK = 8;
    const layout = {
      [BLOCK]: {
        real: 5,
        idBase: 100,
        extra: (p: number): Def | undefined => {
          if (p === 5 || p === 6) return realFloat(100 + p - 5); // repeated ids of params 0, 1
          if (p === 7 || p === 8) return { id: 900 + p, tc: 2, min: 10, max: 1, scale: 1, def: 5, step: 0 }; // min > max
          if (p >= 9 && p <= 12) return realFloat(200 + p); // real-looking params past the pseudo run
          if (p >= 13) return endMarker(128);
          return undefined;
        },
      },
    };
    const sweptPids = (w: Writes): number[] => [...new Set(w.sets.map((s) => s.pid))].sort((a, b) => a - b);
    // Bound 8: pseudo params 5..8 never swept, 9..12 never even queried.
    const wa = writes();
    const da = tableDevice(layout);
    const ra = await liveWalkDetailed(da, { ...base, blocks: [BLOCK], mode: 'full', write: wa.hooks, paramBoundByBlock: { [BLOCK]: 8 } });
    if (!sameList(paramsOf(ra, BLOCK), range(0, 4)) || !sameList(sweptPids(wa), range(0, 4)) || da.maxParam(BLOCK) !== 8) {
      fail(`bounded full walk: records ${paramsOf(ra, BLOCK).join(',')}, SETs to ${sweptPids(wa).join(',')}, highest query ${da.maxParam(BLOCK)}`);
    }
    if (wa.sets.some((s) => s.eid !== BLOCK) || wa.reloads !== 1) fail(`bounded full walk: SETs to another block or ${wa.reloads} reloads`);
    // No bound: the real-looking params past the pseudo run are swept, the pseudo ones still are not.
    const wb = writes();
    const rb = await liveWalkDetailed(tableDevice(layout), { ...base, blocks: [BLOCK], mode: 'full', write: wb.hooks });
    if (!sameList(paramsOf(rb, BLOCK), [...range(0, 4), ...range(9, 12)]) || !sameList(sweptPids(wb), [...range(0, 4), ...range(9, 12)])) {
      fail(`unbounded full walk: records ${paramsOf(rb, BLOCK).join(',')}, SETs to ${sweptPids(wb).join(',')}`);
    }
    if (rb.pseudoReplies.duplicateId !== 2 || rb.pseudoReplies.implausible !== 2) fail(`pseudo stats: ${JSON.stringify(rb.pseudoReplies)}`);
  }
  console.log('  cache/livewalk-bounds: full mode sends no write to a pseudo record or to a param above the block bound');

  // ---- Case 7: caller bounds win over maxParamId, skip, and clamp --------------------------
  {
    const layout = { 1: { real: 700 }, 2: { real: 700 }, 3: { real: 700 } };
    // Wins in both directions; a block without an entry keeps maxParamId.
    const lower = tableDevice(layout);
    await liveWalkDetailed(lower, { ...base, blocks: [1, 2], maxParamId: 500, paramBoundByBlock: { 1: 30 } });
    if (lower.maxParam(1) !== 30 || lower.maxParam(2) !== 500) fail(`bound below maxParamId: highest ${lower.maxParam(1)} / ${lower.maxParam(2)} (want 30 / 500)`);
    const higher = tableDevice(layout);
    await liveWalkDetailed(higher, { ...base, blocks: [1, 2], maxParamId: 20, paramBoundByBlock: { 1: 60 } });
    if (higher.maxParam(1) !== 60 || higher.maxParam(2) !== 20) fail(`bound above maxParamId: highest ${higher.maxParam(1)} / ${higher.maxParam(2)} (want 60 / 20)`);
    // A negative bound skips the block entirely.
    const skip = tableDevice(layout);
    const rs = await liveWalkDetailed(skip, { ...base, blocks: [3, 1], maxParamId: 10, paramBoundByBlock: { 3: -1 } });
    if (skip.maxParam(3) !== -1 || paramsOf(rs, 3).length !== 0 || paramsOf(rs, 1).length !== 11) fail('a negative bound must skip its block without a query');
    // A bound beyond the 14-bit field is clamped: the sweep ends at 16383 and never wraps back to 0.
    const wide = tableDevice({ 1: { real: 3 } });
    await liveWalkDetailed(wide, { ...base, blocks: [1], maxParamId: 5, paramAbsentRunLimit: 1_000_000, paramBoundByBlock: { 1: 99999 } });
    const defs = wide.sent.filter((q) => q.view === VIEW_DEFINITION).map((q) => q.param);
    if (defs.length !== 16384 || !defs.every((p, i) => p === i)) fail(`clamped bound: ${defs.length} definition queries, last ${defs[defs.length - 1]} (want 0..16383 in order, no wrap)`);
  }
  console.log('  cache/livewalk-bounds: paramBoundByBlock wins over maxParamId both ways, a negative bound skips the block, a huge bound clamps to 16383');

  // ---- Case 8: default ceilings — 127 read-only, 511 full, never the 14-bit space ----------
  {
    const layout = { 1: { real: 700 } };
    const ro = tableDevice(layout);
    const rr = await liveWalkDetailed(ro, { ...base, blocks: [1] });
    if (ro.maxParam(1) !== 127 || rr.records.length !== 128) fail(`read-only default: highest ${ro.maxParam(1)}, ${rr.records.length} records (want 127 / 128)`);
    const fl = tableDevice(layout);
    const rf = await liveWalkDetailed(fl, { ...base, blocks: [1], mode: 'full', write: writes().hooks });
    if (fl.maxParam(1) !== 511 || rf.records.length !== 512) fail(`full default: highest ${fl.maxParam(1)}, ${rf.records.length} records (want 511 / 512)`);
    const ex = tableDevice(layout);
    await liveWalkDetailed(ex, { ...base, blocks: [1], maxParamId: 300 });
    if (ex.maxParam(1) !== 300) fail(`explicit maxParamId: highest ${ex.maxParam(1)} (want 300)`);
  }
  console.log('  cache/livewalk-bounds: default ceilings are 127 (read-only) and 511 (full); an explicit maxParamId still applies');

  // ---- Case 9: a known table size keeps a sparse table's late rows ------------------------
  {
    const BLOCK = 4;
    // Real rows at 0..2 and at 216 (an unnamed 14-value enum), an id gap of 213 between them.
    const sparse = {
      [BLOCK]: {
        real: 3,
        extra: (p: number): Def | undefined => (p === 216 ? { id: 6001, tc: 16, min: 0, max: 13, scale: 0, def: 0, step: 0 } : undefined),
      },
    };
    const w = writes();
    const known = tableDevice(sparse);
    const rk = await liveWalkDetailed(known, { ...base, blocks: [BLOCK], mode: 'full', write: w.hooks, paramKnownSizeByBlock: { [BLOCK]: 220 } });
    if (!sameList(paramsOf(rk, BLOCK), [0, 1, 2, 216])) fail(`known size: records ${paramsOf(rk, BLOCK).join(',')}, want 0,1,2,216`);
    // Ids 0..219 are walked without the stop run; the stop run counts afresh from id 220, so the lookahead
    // past the table is a full 32: the walk ends at 219 + 32 = 251, which is also the ceiling.
    if (known.maxParam(BLOCK) !== 219 + 32) fail(`known size: highest query ${known.maxParam(BLOCK)} (want ${219 + 32})`);
    if (w.sets.some((x) => x.pid > 219 + 32)) fail('known size: a SET above the ceiling');
    // The gap is longer than any placeholder run: it is an id-space gap, no placeholder rows.
    if (rk.placeholderSlots !== 0) fail(`known size: ${rk.placeholderSlots} placeholders for an id-space gap`);
    // Without a known size the stop run ends the block inside the gap and the late row is lost.
    const unknown = tableDevice(sparse);
    const ru = await liveWalkDetailed(unknown, { ...base, blocks: [BLOCK], mode: 'full', write: writes().hooks });
    if (!sameList(paramsOf(ru, BLOCK), [0, 1, 2]) || unknown.maxParam(BLOCK) !== 2 + 32) fail(`no known size: records ${paramsOf(ru, BLOCK).join(',')}, highest query ${unknown.maxParam(BLOCK)} (want 0,1,2 / 34)`);
    // A hard bound alone does not suspend the stop run: it only caps.
    const hard = tableDevice(sparse);
    const rh = await liveWalkDetailed(hard, { ...base, blocks: [BLOCK], paramBoundByBlock: { [BLOCK]: 220 } });
    if (!sameList(paramsOf(rh, BLOCK), [0, 1, 2]) || hard.maxParam(BLOCK) !== 2 + 32) fail(`hard bound alone: records ${paramsOf(rh, BLOCK).join(',')}, highest query ${hard.maxParam(BLOCK)} (want 0,1,2 / 34)`);
    // An explicit run limit applies past the known size (and sets how far the ceiling reaches), never inside it.
    const explicit = tableDevice(sparse);
    const re = await liveWalkDetailed(explicit, { ...base, blocks: [BLOCK], maxParamId: 16383, paramAbsentRunLimit: 4, paramKnownSizeByBlock: { [BLOCK]: 220 } });
    if (!sameList(paramsOf(re, BLOCK), [0, 1, 2, 216]) || explicit.maxParam(BLOCK) !== 219 + 4) fail(`known size + run limit 4: highest query ${explicit.maxParam(BLOCK)} (want ${219 + 4})`);
  }
  console.log('  cache/livewalk-bounds: a known table size is walked without the stop run (sparse row at 216 kept), the stop run applies past it; a hard bound alone only caps');

  // ---- Case 10: params a newer firmware appends past the known size are found --------------
  {
    // FM3 fw 13 vs a fw 12 catalog: three tables grew (29 -> 32, 43 -> 44, 17 -> 21 params).
    const layout = { 1: { real: 32 }, 2: { real: 44 }, 3: { real: 21 } };
    const sizes = { 1: 29, 2: 43, 3: 17 };
    for (const wide of [16383, undefined]) {
      const dev = tableDevice(layout);
      const res = await liveWalkDetailed(dev, { ...base, blocks: [1, 2, 3], ...(wide !== undefined ? { maxParamId: wide } : {}), paramKnownSizeByBlock: sizes });
      for (const [b, real] of [[1, 32], [2, 44], [3, 21]] as const) {
        if (!sameList(paramsOf(res, b), range(0, real - 1))) fail(`appended rows, block ${b}: records ${paramsOf(res, b).length}, want ${real}`);
        // Nothing above size - 1 + 32: the known table plus one stop run.
        if (dev.maxParam(b) !== sizes[b] - 1 + 32) fail(`appended rows, block ${b}: highest query ${dev.maxParam(b)}, want ${sizes[b] - 1 + 32}`);
      }
    }
    // Any hard bound still caps — also below the appended rows' end, and below size - 1.
    const cap = tableDevice(layout);
    const rc = await liveWalkDetailed(cap, { ...base, blocks: [1], paramKnownSizeByBlock: { 1: 29 }, paramBoundByBlock: { 1: 30 } });
    if (cap.maxParam(1) !== 30 || paramsOf(rc, 1).length !== 31) fail(`appended rows under a bound: highest ${cap.maxParam(1)}, ${paramsOf(rc, 1).length} records (want 30 / 31)`);
    const cut = tableDevice(layout);
    const rt = await liveWalkDetailed(cut, { ...base, blocks: [1], paramKnownSizeByBlock: { 1: 29 }, paramBoundByBlock: { 1: 20 } });
    if (cut.maxParam(1) !== 20 || paramsOf(rt, 1).length !== 21) fail(`bound below size - 1: highest ${cut.maxParam(1)}, ${paramsOf(rt, 1).length} records (want 20 / 21)`);
  }
  console.log('  cache/livewalk-bounds: rows a newer firmware appends past a known size (29 -> 32, 43 -> 44, 17 -> 21) are found, nothing above size - 1 + 32 or above a bound is queried');

  // ---- Case 11: how known size, hard bound and maxParamId combine --------------------------
  {
    // Known size only: the ceiling is capped by maxParamId (127 read-only by default), never further.
    const layout = { 1: { real: 700 } };
    const ro = tableDevice(layout);
    await liveWalkDetailed(ro, { ...base, blocks: [1], paramKnownSizeByBlock: { 1: 300 } });
    if (ro.maxParam(1) !== 127) fail(`known size 300 in read-only: highest ${ro.maxParam(1)} (want maxParamId's 127)`);
    const wide = tableDevice(layout);
    await liveWalkDetailed(wide, { ...base, blocks: [1], maxParamId: 16383, paramKnownSizeByBlock: { 1: 300 } });
    if (wide.maxParam(1) !== 299 + 32) fail(`known size 300, wide maxParamId: highest ${wide.maxParam(1)} (want ${299 + 32})`);
    // A hard bound wins over a known size: below size - 1 it truncates, above it the stop run still applies.
    const trunc = tableDevice(layout);
    const rt = await liveWalkDetailed(trunc, { ...base, blocks: [1], maxParamId: 16383, paramKnownSizeByBlock: { 1: 100 }, paramBoundByBlock: { 1: 40 } });
    if (trunc.maxParam(1) !== 40 || paramsOf(rt, 1).length !== 41) fail(`bound below known size: highest ${trunc.maxParam(1)}, ${paramsOf(rt, 1).length} records (want 40 / 41)`);
    const above = tableDevice({ 1: { real: 41 } });
    const ra = await liveWalkDetailed(above, { ...base, blocks: [1], paramKnownSizeByBlock: { 1: 29 }, paramBoundByBlock: { 1: 100 } });
    if (above.maxParam(1) !== 40 + 32 || paramsOf(ra, 1).length !== 41) fail(`bound above known size: highest ${above.maxParam(1)}, ${paramsOf(ra, 1).length} records (want ${40 + 32} / 41)`);
    // A hard bound alone is only a cap: a table that ends early still ends at the stop run.
    const alone = tableDevice({ 1: { real: 3 } });
    await liveWalkDetailed(alone, { ...base, blocks: [1], paramBoundByBlock: { 1: 220 } });
    if (alone.maxParam(1) !== 2 + 32) fail(`hard bound alone: highest ${alone.maxParam(1)} (want 34)`);
    // Neither option: today's behaviour (stop run, 127 / 511 defaults).
    const none = tableDevice({ 1: { real: 3 } });
    await liveWalkDetailed(none, { ...base, blocks: [1] });
    if (none.maxParam(1) !== 2 + 32) fail(`no options: highest ${none.maxParam(1)} (want 34)`);
  }
  console.log('  cache/livewalk-bounds: known size is capped by maxParamId, a hard bound wins over it (truncates below, stop run above), a bound alone only caps');

  // ---- Case 12: non-finite or non-integer option values are ignored, never trusted ---------
  {
    const BLOCK = 4;
    const sparse = {
      [BLOCK]: {
        real: 3,
        extra: (p: number): Def | undefined => (p === 216 ? { id: 6001, tc: 16, min: 0, max: 13, scale: 0, def: 0, step: 0 } : undefined),
      },
    };
    const bad: number[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, 219.5];
    // A known size that is not a finite integer >= 0 is no known size: the stop run ends the block in the gap.
    for (const size of [...bad, -5]) {
      const dev = tableDevice(sparse);
      const res = await liveWalkDetailed(dev, { ...base, blocks: [BLOCK], paramKnownSizeByBlock: { [BLOCK]: size } });
      if (!sameList(paramsOf(res, BLOCK), [0, 1, 2]) || dev.maxParam(BLOCK) !== 2 + 32) fail(`known size ${size} was trusted: records ${paramsOf(res, BLOCK).join(',')}, highest ${dev.maxParam(BLOCK)}`);
    }
    // A bound that is not a finite integer is no bound: maxParamId applies (Infinity must not become 16383).
    for (const bound of bad) {
      const dev = tableDevice({ 1: { real: 700 } });
      await liveWalkDetailed(dev, { ...base, blocks: [1], maxParamId: 20, paramBoundByBlock: { 1: bound } });
      if (dev.maxParam(1) !== 20) fail(`bound ${bound} was trusted: highest ${dev.maxParam(1)} (want maxParamId's 20)`);
    }
    // Controls: the same device with a valid integer size keeps the late row; a valid negative bound still skips.
    const ok = tableDevice(sparse);
    const rk = await liveWalkDetailed(ok, { ...base, blocks: [BLOCK], maxParamId: 16383, paramKnownSizeByBlock: { [BLOCK]: 220 } });
    if (!sameList(paramsOf(rk, BLOCK), [0, 1, 2, 216])) fail('control: a valid known size must keep the late row');
    const skip = tableDevice({ 1: { real: 700 } });
    await liveWalkDetailed(skip, { ...base, blocks: [1], paramBoundByBlock: { 1: -1 } });
    if (skip.sent.length !== 0) fail('control: a negative integer bound must still skip the block');

    // paramAbsentRunLimit: only a finite integer >= 1 is a run limit, anything else is the default 32
    // (NaN / Infinity used to disable the stop run, 1.5 truncated it).
    const badRun: number[] = [...bad, 0, -3];
    for (const limit of badRun) {
      const plain = tableDevice({ 1: { real: 3 } });
      await liveWalkDetailed(plain, { ...base, blocks: [1], maxParamId: 16383, paramAbsentRunLimit: limit });
      if (plain.maxParam(1) !== 2 + 32) fail(`run limit ${limit}: highest ${plain.maxParam(1)} (want the default's 34)`);
      const sized = tableDevice({ 1: { real: 3 } });
      await liveWalkDetailed(sized, { ...base, blocks: [1], maxParamId: 16383, paramAbsentRunLimit: limit, paramKnownSizeByBlock: { 1: 29 } });
      if (sized.maxParam(1) !== 28 + 32) fail(`run limit ${limit} with known size 29: highest ${sized.maxParam(1)} (want 60)`);
    }
    const four = tableDevice({ 1: { real: 3 } });
    await liveWalkDetailed(four, { ...base, blocks: [1], maxParamId: 16383, paramAbsentRunLimit: 4 });
    if (four.maxParam(1) !== 2 + 4) fail(`control: run limit 4: highest ${four.maxParam(1)} (want 6)`);

    // maxParamId: a non-finite value is the mode default (Infinity must not mean "unbounded"); finite ones clamp at 16383.
    for (const max of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const ro = tableDevice({ 1: { real: 700 } });
      await liveWalkDetailed(ro, { ...base, blocks: [1], maxParamId: max });
      if (ro.maxParam(1) !== 127) fail(`read-only maxParamId ${max}: highest ${ro.maxParam(1)} (want the default 127)`);
      const fl = tableDevice({ 1: { real: 700 } });
      await liveWalkDetailed(fl, { ...base, blocks: [1], mode: 'full', write: writes().hooks, maxParamId: max });
      if (fl.maxParam(1) !== 511) fail(`full maxParamId ${max}: highest ${fl.maxParam(1)} (want the default 511)`);
    }
    const huge = tableDevice({ 1: { real: 3 } });
    await liveWalkDetailed(huge, { ...base, blocks: [1], maxParamId: 99999, paramAbsentRunLimit: 1_000_000 });
    const sweep = huge.sent.filter((q) => q.view === VIEW_DEFINITION).map((q) => q.param);
    if (sweep.length !== 16384 || !sweep.every((q, i) => q === i)) fail(`maxParamId 99999: ${sweep.length} definition queries (want 0..16383 in order)`);
  }
  console.log('  cache/livewalk-bounds: NaN, Infinity and fractional option values are ignored as if absent (a negative integer bound still skips); a run limit below 1 or not an integer is the default 32, a non-finite maxParamId the mode default');

  // ---- Case 13: a freezing device is never hit with known sizes ---------------------------
  {
    const FREEZE = 600;
    const layout = { 0: { real: 512, idBase: 1000 }, 1: { real: 133, idBase: 5000 } };
    const sizes = { 0: 512, 1: 133 };
    // Exact known sizes with the old wide-open maxParamId and the default run: size - 1 + 32, never more.
    for (const mode of ['read-only', 'full'] as const) {
      const d = tableDevice(layout, FREEZE);
      await liveWalkDetailed(d, { ...base, blocks: [0, 1], maxParamId: 16383, paramKnownSizeByBlock: sizes, ...(mode === 'full' ? { mode, write: writes().hooks } : {}) });
      if (d.frozen || d.maxParam(0) !== 511 + 32 || d.maxParam(1) !== 132 + 32) fail(`${mode}, known sizes: frozen=${d.frozen}, highest ${d.maxParam(0)} / ${d.maxParam(1)} (want 543 / 164)`);
    }
    // FULL defaults: the 511 default ceiling still caps block 0.
    const full = tableDevice(layout, FREEZE);
    const rf = await liveWalkDetailed(full, { ...base, blocks: [0, 1], mode: 'full', write: writes().hooks, paramKnownSizeByBlock: sizes });
    if (full.frozen || full.maxParam(0) !== 511 || full.maxParam(1) !== 164 || paramsOf(rf, 0).length !== 512) fail(`full defaults, known sizes: frozen=${full.frozen}, highest ${full.maxParam(0)} / ${full.maxParam(1)}`);
    // An OVER-LARGE known size drops the stop run up to it: here it reaches the freeze threshold and the walk rejects ...
    const over = tableDevice(layout, FREEZE);
    let error = '';
    try {
      await liveWalkDetailed(over, { ...base, blocks: [0, 1], maxParamId: 16383, paramKnownSizeByBlock: { 0: 4000, 1: 133 } });
    } catch (e) {
      error = (e as Error).message;
    }
    if (!over.frozen || !/stopped answering/.test(error)) fail(`an over-large known size should have walked into the freeze: frozen=${over.frozen}, error "${error}"`);
    // ... and a hard bound is what still holds it.
    const held = tableDevice(layout, FREEZE);
    await liveWalkDetailed(held, { ...base, blocks: [0, 1], maxParamId: 16383, paramKnownSizeByBlock: { 0: 4000, 1: 133 }, paramBoundByBlock: { 0: 511 } });
    if (held.frozen || held.maxParam(0) !== 511) fail(`hard bound over a wrong known size: frozen=${held.frozen}, highest ${held.maxParam(0)}`);
  }
  console.log('  cache/livewalk-bounds: a transport that freezes above id 600 is never hit with exact known sizes and the default run; an over-large known size is held by a hard bound');

  // ---- Case 14: the lookahead past a known size is always a full stop run ------------------
  {
    const BLOCK = 9;
    const empty: Def = { id: 0, tc: 0, min: 0, max: 0, scale: 0, def: 0, step: 0 };
    // A table of 40 ids that ENDS in unused slots: real rows 0..4, empty slots 5..39; an optional appended row.
    const table = (appendedAt?: number) => ({
      [BLOCK]: {
        real: 5,
        extra: (p: number): Def | undefined => {
          if (p >= 5 && p <= 39) return empty;
          if (p === appendedAt) return realFloat(8001);
          return undefined;
        },
      },
    });
    const opts: LiveWalkOptions = { ...base, blocks: [BLOCK], maxParamId: 16383, paramKnownSizeByBlock: { [BLOCK]: 40 } };
    // No appended row: exactly size - 1 + 32 = 71 and 72 definition queries — the 35 empty slots at the end of the
    // table do not eat into the lookahead (the old count stopped at 39 and never looked past the table).
    const none = tableDevice(table());
    await liveWalkDetailed(none, opts);
    if (none.maxParam(BLOCK) !== 39 + 32 || none.count(VIEW_DEFINITION, BLOCK) !== 72) fail(`table ending in empty slots: highest query ${none.maxParam(BLOCK)}, ${none.count(VIEW_DEFINITION, BLOCK)} queries (want 71 / 72)`);
    // A row appended at size + 4 is found, and the walk still never goes above size - 1 + 32.
    const appended = tableDevice(table(44));
    const ra = await liveWalkDetailed(appended, opts);
    if (!sameList(paramsOf(ra, BLOCK), [0, 1, 2, 3, 4, 44]) || appended.maxParam(BLOCK) !== 39 + 32) {
      fail(`appended row after a table ending in empty slots: records ${paramsOf(ra, BLOCK).join(',')}, highest query ${appended.maxParam(BLOCK)} (want 0..4,44 / 71)`);
    }
    // Without a known size the stop run ends the block inside the empty slots and loses the appended row.
    const unknown = tableDevice(table(44));
    const ru = await liveWalkDetailed(unknown, { ...base, blocks: [BLOCK], maxParamId: 16383 });
    if (!sameList(paramsOf(ru, BLOCK), [0, 1, 2, 3, 4]) || unknown.maxParam(BLOCK) !== 4 + 32) fail(`no known size: records ${paramsOf(ru, BLOCK).join(',')}, highest query ${unknown.maxParam(BLOCK)} (want 0..4 / 36)`);
  }
  console.log('  cache/livewalk-bounds: the stop run counts afresh at a known size — a table ending in empty slots gets a full lookahead (highest query size - 1 + 32) and an appended row at size + 4 is found');

  // ---- Case 15: a reused symbol id with a new body continuing a known table is real ----------
  {
    const BLOCK = 9;
    // A mixer-shaped table: six level rows under ids 600, 604, ... 620; the first two balance rows
    // reuse the ids of the last two level rows with a DIFFERENT body; then rows under fresh ids.
    const level = (id: number): Def => ({ id, tc: 1329, min: 0, max: 1, scale: 1, def: 100, step: 0.001 });
    const balance = (id: number): Def => ({ id, tc: 50, min: -1, max: 1, scale: 0.5, def: 100, step: 0.002 });
    const mixer = (extra?: (p: number) => Def | undefined) => ({
      [BLOCK]: {
        real: 0,
        extra: (p: number): Def | undefined => {
          const x = extra?.(p);
          if (x) return x;
          if (p <= 5) return level(600 + 4 * p);
          if (p <= 11) return balance(616 + 4 * (p - 6)); // 6 -> 616 (= p4's id), 7 -> 620 (= p5's id), 8.. fresh
          if (p <= 13) return realFloat(700 + p);
          return endMarker(128);
        },
      },
    });
    const known = { ...base, blocks: [BLOCK], paramKnownSizeByBlock: { [BLOCK]: 14 } };
    const rk = await liveWalkDetailed(tableDevice(mixer()), known);
    if (!sameList(paramsOf(rk, BLOCK), range(0, 13)) || rk.pseudoReplies.duplicateId !== 0) {
      fail(`reused ids inside a known table: records ${paramsOf(rk, BLOCK).join(',')}, ${JSON.stringify(rk.pseudoReplies)} (want 0..13, no duplicates)`);
    }
    // Without a known size the walk stays conservative: both reuses are copies.
    const ru = await liveWalkDetailed(tableDevice(mixer()), { ...base, blocks: [BLOCK] });
    if (!sameList(paramsOf(ru, BLOCK), [...range(0, 5), ...range(8, 13)]) || ru.pseudoReplies.duplicateId !== 2) {
      fail(`reused ids without a known size: records ${paramsOf(ru, BLOCK).join(',')}, ${JSON.stringify(ru.pseudoReplies)}`);
    }
    // Inside the known table a reuse with the SAME body is still a copy, and so is a reuse of an end
    // marker's id; a reuse past the known size is a copy whatever its body.
    const copies = tableDevice(mixer((p) => {
      if (p === 12) return level(600); // same body as param 0
      if (p === 9) return { ...endMarker(0) }; // an inner slot answering the marker body
      if (p === 10) return { id: END_MARKER_ID, tc: 50, min: -1, max: 1, scale: 0, def: 100, step: 0.002 }; // reuses the marker id
      return undefined;
    }));
    const rc = await liveWalkDetailed(copies, known);
    // (9 is no placeholder: the run it opens holds the pseudo answer at 10, so it is a gap.)
    if (!sameList(paramsOf(rc, BLOCK), [...range(0, 8), 11, 13]) || rc.pseudoReplies.duplicateId !== 2) {
      fail(`copies inside a known table: records ${paramsOf(rc, BLOCK).join(',')}, ${JSON.stringify(rc.pseudoReplies)} (want 0..8, 11, 13; 2 duplicates)`);
    }
    // A reuse with a new body that does NOT directly follow the last real definition (an empty slot
    // in between) stays a copy even inside the known table.
    const gap = tableDevice(mixer((p) => (p === 6 ? { id: 0, tc: 0, min: 0, max: 0, scale: 0, def: 0, step: 0 } : undefined)));
    const rgap = await liveWalkDetailed(gap, known);
    if (paramsOf(rgap, BLOCK).includes(7) || !paramsOf(rgap, BLOCK).includes(8) || rgap.pseudoReplies.duplicateId !== 1) {
      fail(`a reuse after a gap: records ${paramsOf(rgap, BLOCK).join(',')}, ${JSON.stringify(rgap.pseudoReplies)}`);
    }
    const past = await liveWalkDetailed(tableDevice(mixer()), { ...base, blocks: [BLOCK], paramKnownSizeByBlock: { [BLOCK]: 7 } });
    if (paramsOf(past, BLOCK).includes(7) || !paramsOf(past, BLOCK).includes(6) || past.pseudoReplies.duplicateId !== 1) {
      fail(`a reuse past the known size: records ${paramsOf(past, BLOCK).join(',')}, ${JSON.stringify(past.pseudoReplies)}`);
    }
  }
  console.log('  cache/livewalk-bounds: a reused symbol id with a new body right after the last real param of a known table is a real param; same-body and end-marker reuses, reuses after a gap and outside a known size stay copies');

  // ---- Case 16: the default block sweep stops at 160; higher blocks are the caller's opt-in ----
  {
    // Tables at 158 (inside the default range) and at 191 (a multiplexer address above it).
    const layout = { 158: { real: 3 }, 191: { real: 7 } };
    const dev = tableDevice(layout);
    const res = await liveWalkDetailed(dev, { ...base, maxParamId: 20 });
    const blocksQueried = [...new Set(dev.sent.map((q) => q.block))].sort((a, b) => a - b);
    if (!sameList(blocksQueried, range(0, 160))) fail(`default sweep queried blocks ${blocksQueried[0]}..${blocksQueried[blocksQueried.length - 1]} (${blocksQueried.length}), want 0..160`);
    if (!sameList(paramsOf(res, 158), range(0, 2)) || paramsOf(res, 191).length !== 0) fail('default sweep: the table at 158 must be found and 191 never queried');
    // An explicit block list reaches 191 (and only the listed blocks).
    const listed = tableDevice(layout);
    const rl = await liveWalkDetailed(listed, { ...base, maxParamId: 20, blocks: [158, 191] });
    const lb = [...new Set(listed.sent.map((q) => q.block))].sort((a, b) => a - b);
    if (!sameList(lb, [158, 191]) || !sameList(paramsOf(rl, 191), range(0, 6))) fail(`explicit block list: queried ${lb.join(',')}, records at 191 ${paramsOf(rl, 191).join(',')}`);
    // So does an explicit maxBlock.
    const wide = tableDevice(layout);
    const rw = await liveWalkDetailed(wide, { ...base, maxParamId: 20, maxBlock: 191 });
    if (!sameList(paramsOf(rw, 191), range(0, 6)) || wide.sent.some((q) => q.block > 191)) fail('explicit maxBlock 191: table missed or a block above it queried');
  }
  console.log('  cache/livewalk-bounds: the default sweep covers blocks 0..160 only; an explicit block list or maxBlock reaches the effect tables above');
}
