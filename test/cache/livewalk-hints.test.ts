/**
 * Live walk — label lists the caller names (`enumHintByBlock`).
 *
 * A 0x1f label query against a parameter WITHOUT a label list is out of contract for a device, so a
 * definition with a non-zero `scale` slot is never label-walked on its own numbers. Many genuine
 * label lists report a non-zero `scale` (the slot reads like the default ordinal), and nothing in the
 * device's own answers marks them safely: their formatted value can look like a number ('12 dB/OCT')
 * and continuous params can display words ('OFF'). A caller that KNOWS the list (a catalog or a
 * byte-exact cache of the model) names it with a hint, and only then is such a definition walked.
 *
 * Pinned here:
 *   - without a hint a non-zero-scale definition is never label-probed (it stays a float);
 *   - with a fitting hint (same count and typecode, integral bounds, first ordinal 0..127, within
 *     the cap, the `scale` slot an integer inside min..max) it is label-walked and becomes an enum,
 *     in the same query order as any label walk;
 *   - a hint that does not fit (fewer values, another typecode, fractional bounds, a high first
 *     ordinal, over the cap, a default slot that is fractional or out of range) never causes a
 *     label query; nor does an invalid hint (no typecode, a bad count);
 *   - a list that GREW by 1..4 past the hint is walked only when the formatted value, read first,
 *     is a label (never with `readValues: false`), and that value read is not repeated; growth
 *     beyond 4 is never walked;
 *   - FULL mode never sweeps (writes) a param with a hint entry — usable, unfitting or malformed —
 *     whatever its label walk gave; unhinted continuous params are still swept;
 *   - `enumHintsFromRanges` builds a block's hints from a family's range rows (typecode required).
 *
 * Synthetic frames only (the shared encoders of `livewalk.test.ts`); nothing opens a port.
 */
import { buildCache, enumHintsFromRanges, liveWalkDetailed, VIEW_DEFINITION, VIEW_ENUM_LABEL, VIEW_VALUE } from '../../src/cache/index.js';
import type { LiveEnumHint, LiveTransport, LiveWalkOptions, LiveWalkWriteHooks } from '../../src/cache/index.js';
import type { DeviceParam } from '../../src/cache/types.js';
import { endOfRangeFrame, labelReply, replyFrame, sentinelFrame, valueReply } from './livewalk.test.js';

export const LIVEWALK_HINTS_CASE_COUNT = 7;

const FM3 = 0x11;
const BLOCK = 66;
const noSleep = (): Promise<void> => Promise.resolve();

interface Def {
  id: number;
  tc: number;
  min: number;
  max: number;
  scale: number;
  def: number;
  step: number;
}

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

interface Param {
  def: Def;
  /** Labels at sub = min + i, when the param HAS a list. */
  labels?: string[];
  /** Formatted value (view 0x00). */
  display: string;
}

interface Q {
  view: number;
  param: number;
  sub: number;
}

interface Dev extends LiveTransport {
  readonly sent: Q[];
  /** Label queries sent to a param that has NO label list (the out-of-contract case). */
  readonly outOfContract: Q[];
  count(view: number, param?: number): number;
}

/**
 * One block of params (ids 0..n-1), then the no-payload end of the table. A label query to a param
 * without `labels` is recorded as out of contract (and answered empty, as a lenient device would).
 */
function device(params: readonly Param[]): Dev {
  const sent: Q[] = [];
  const outOfContract: Q[] = [];
  return {
    sent,
    outOfContract,
    count: (view, param) => sent.filter((q) => q.view === view && (param === undefined || q.param === param)).length,
    request(query: Uint8Array): Promise<Uint8Array | null> {
      const q: Q = { view: query[6]!, param: query[10]! | (query[11]! << 7), sub: query[12]! | (query[13]! << 7) };
      const block = query[8]! | (query[9]! << 7);
      sent.push(q);
      const p = block === BLOCK ? params[q.param] : undefined;
      if (!p) return Promise.resolve(q.view === VIEW_DEFINITION ? replyFrame(VIEW_DEFINITION, q.param, 0x00, new Uint8Array(0)) : sentinelFrame(q.view, q.param));
      if (q.view === VIEW_DEFINITION) return Promise.resolve(defFrame(q.param, p.def));
      if (q.view === VIEW_VALUE) return Promise.resolve(valueReply(p.display, q.param));
      if (q.view === VIEW_ENUM_LABEL) {
        if (!p.labels) {
          outOfContract.push(q);
          return Promise.resolve(endOfRangeFrame(VIEW_ENUM_LABEL, q.param));
        }
        const i = q.sub - Math.round(p.def.min);
        return Promise.resolve(i >= 0 && i < p.labels.length ? labelReply(p.labels[i]!, q.param) : endOfRangeFrame(VIEW_ENUM_LABEL, q.param));
      }
      return Promise.resolve(sentinelFrame(q.view, q.param));
    },
  };
}

/** A label list whose `scale` slot is non-zero (default ordinal 2): never walked without a hint. */
const typeList = (id: number, n = 4): Param => ({
  def: { id, tc: 16, min: 0, max: n - 1, scale: 2, def: 1, step: 0 },
  labels: Array.from({ length: n }, (_, i) => `TYPE ${String.fromCharCode(65 + i)}`),
  display: 'TYPE C',
});
/** A continuous param that DISPLAYS a word at its current value, integral bounds 0..10. */
const offFloat = (id: number): Param => ({ def: { id, tc: 240, min: 0, max: 10, scale: 0.5, def: 1000, step: 0.001 }, display: 'OFF' });
/** A continuous param with a unit. */
const level = (id: number): Param => ({ def: { id, tc: 305, min: -80, max: 20, scale: 0, def: 1, step: 0.1 }, display: '0.0 dB' });

const base: LiveWalkOptions = { model: FM3, blocks: [BLOCK], sleep: noSleep };
const hints = (h: Record<number, LiveEnumHint>): LiveWalkOptions => ({ ...base, enumHintByBlock: { [BLOCK]: h } });

export async function runLiveWalkHints(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[cache/livewalk-hints] ${msg}`);
  };

  // ---- Case 1: no hint, no label query; a fitting hint walks the list -------------------------
  {
    const params = [typeList(101), level(102)];
    const bare = device(params);
    const rb = await liveWalkDetailed(bare, base);
    if (bare.count(VIEW_ENUM_LABEL) !== 0 || rb.records[0]?.kind !== 'float') fail(`no hint: ${bare.count(VIEW_ENUM_LABEL)} label queries, kind ${rb.records[0]?.kind}`);
    const hinted = device(params);
    const rh = await liveWalkDetailed(hinted, hints({ 0: { count: 4, typecode: 16 } }));
    const r0 = rh.records[0];
    if (r0?.kind !== 'enum' || r0.values.join('|') !== 'TYPE A|TYPE B|TYPE C|TYPE D' || r0.count !== 4) fail(`hinted list: ${JSON.stringify(r0)}`);
    if (hinted.outOfContract.length !== 0) fail('a label query reached a param without a list');
    // Query order for the hinted param: definition, then the labels from sub = min; no value read
    // once labels came back (as for every label walk). The unhinted level keeps definition + value.
    const order = hinted.sent.filter((q) => q.param === 0).map((q) => `${q.view.toString(16)}:${q.sub}`).join(' ');
    if (order !== '1c:0 1f:0 1f:1 1f:2 1f:3') fail(`hinted query order: ${order}`);
    if (hinted.count(VIEW_ENUM_LABEL, 1) !== 0 || hinted.count(VIEW_VALUE, 1) !== 1) fail('the unhinted level param changed its queries');
  }
  console.log('  cache/livewalk-hints: a non-zero-scale list is never label-probed without a hint; a fitting hint walks it (def, then labels from sub = min)');

  // ---- Case 2: hints that do not fit never cause a label query ----------------------------------
  {
    const cases: Array<[string, Param, LiveEnumHint]> = [
      ['fewer values than the hint', typeList(201), { count: 5, typecode: 16 }],
      ['another typecode', typeList(202), { count: 4, typecode: 32 }],
      ['fractional bounds', { def: { id: 203, tc: 16, min: 0, max: 3.5, scale: 2, def: 1, step: 0 }, display: '1.5' }, { count: 4, typecode: 16 }],
      ['first ordinal above 127', { def: { id: 204, tc: 16, min: 430, max: 433, scale: 431, def: 1, step: 0 }, display: '431 Hz' }, { count: 4, typecode: 16 }],
      ['over the label cap', { def: { id: 205, tc: 16, min: 0, max: 2047, scale: 2, def: 1, step: 0 }, display: '2' }, { count: 2048, typecode: 16 }],
      ['a hint on a word-displaying float of another typecode', offFloat(206), { count: 11, typecode: 16 }],
      ['a fractional default slot', { ...typeList(208), def: { ...typeList(208).def, scale: 1.5 } }, { count: 4, typecode: 16 }],
      ['a default slot above max', { ...typeList(209), def: { ...typeList(209).def, scale: 9 } }, { count: 4, typecode: 16 }],
      ['a default slot below min', { ...typeList(210), def: { ...typeList(210).def, min: 1, max: 4, scale: -1 } }, { count: 4, typecode: 16 }],
    ];
    for (const [what, p, h] of cases) {
      const dev = device([p]);
      await liveWalkDetailed(dev, hints({ 0: h }));
      if (dev.count(VIEW_ENUM_LABEL) !== 0) fail(`${what}: ${dev.count(VIEW_ENUM_LABEL)} label queries`);
    }
    // Invalid hints are ignored like no hint.
    for (const h of [{ count: 4 }, { count: 0, typecode: 16 }, { count: Number.NaN, typecode: 16 }, { count: 2.5, typecode: 16 }, { count: 4, typecode: 1.5 }, { count: 4, typecode: Number.NaN }] as LiveEnumHint[]) {
      const dev = device([typeList(207)]);
      await liveWalkDetailed(dev, hints({ 0: h }));
      if (dev.count(VIEW_ENUM_LABEL) !== 0) fail(`invalid hint ${JSON.stringify(h)} was used`);
    }
  }
  console.log('  cache/livewalk-hints: a hint with fewer values, another typecode, fractional bounds, a high first ordinal, over the cap, a fractional or out-of-range default, no typecode or a bad count sends no label query');

  // ---- Case 3: a grown list needs a label display ------------------------------------------------
  {
    const grown = typeList(301, 5); // the device has 5 labels, the hint knows 4
    const dev = device([grown]);
    const r = await liveWalkDetailed(dev, hints({ 0: { count: 4, typecode: 16 } }));
    if (r.records[0]?.kind !== 'enum' || (r.records[0] as { values: string[] }).values.length !== 5) fail(`grown list with a label display: ${JSON.stringify(r.records[0])}`);
    const order = dev.sent.map((q) => q.view.toString(16)).slice(0, 3).join(' ');
    if (order !== '1c 0 1f' || dev.count(VIEW_VALUE) !== 1) fail(`grown list query order ${order}, ${dev.count(VIEW_VALUE)} value reads (want '1c 0 1f', 1)`);
    // A number-like display is no second sign: no label walk.
    const numeric = device([{ ...grown, display: '12 dB/OCT' }]);
    const rn = await liveWalkDetailed(numeric, hints({ 0: { count: 4, typecode: 16 } }));
    if (numeric.count(VIEW_ENUM_LABEL) !== 0 || rn.records[0]?.kind !== 'float' || numeric.count(VIEW_VALUE) !== 1) fail('a grown list with a number-like display was label-walked or read twice');
    // Without value reads there is no second sign either.
    const quiet = device([grown]);
    await liveWalkDetailed(quiet, { ...hints({ 0: { count: 4, typecode: 16 } }), readValues: false });
    if (quiet.count(VIEW_ENUM_LABEL) !== 0 || quiet.count(VIEW_VALUE) !== 0) fail('readValues false: a grown list must be neither read nor label-walked');
    // Growth is bounded: 4 more labels than the hint still walks, 5 more never does.
    const four = device([typeList(302, 8)]);
    const r4 = await liveWalkDetailed(four, hints({ 0: { count: 4, typecode: 16 } }));
    if (r4.records[0]?.kind !== 'enum' || (r4.records[0] as { values: string[] }).values.length !== 8) fail('a list grown by 4 with a label display was not walked');
    const five = device([typeList(303, 9)]);
    await liveWalkDetailed(five, hints({ 0: { count: 4, typecode: 16 } }));
    if (five.count(VIEW_ENUM_LABEL) !== 0 || five.count(VIEW_VALUE) !== 1) fail('a list grown by 5 was label-walked (or its unit read was lost)');
  }
  console.log('  cache/livewalk-hints: a list grown 1..4 past its hint is walked only after a label display (one value read, before the labels); more growth never');

  // ---- Case 4: params the numeric rule already walks are unaffected by hints ---------------------
  {
    const zeroScale: Param = { def: { id: 401, tc: 16, min: 0, max: 2, scale: 0, def: 1, step: 0 }, labels: ['A', 'B', 'C'], display: 'A' };
    const a = device([zeroScale]);
    const b = device([zeroScale]);
    await liveWalkDetailed(a, base);
    await liveWalkDetailed(b, hints({ 0: { count: 7, typecode: 99 } })); // a hint that would not even fit
    const trace = (d: Dev): string => d.sent.map((q) => `${q.view}:${q.param}:${q.sub}`).join(' ');
    if (trace(a) !== trace(b)) fail(`a scale-0 list walked differently with a hint:\n${trace(a)}\n${trace(b)}`);
  }
  console.log('  cache/livewalk-hints: a scale-0 list is walked exactly as before, hint or not');

  // ---- Case 5: FULL mode never sweeps a hinted param -------------------------------------------
  {
    const sets: number[] = [];
    const write: LiveWalkWriteHooks = {
      send: (frame) => {
        if (frame[6] === 0x52) sets.push((frame[10]! & 0x7f) | ((frame[11]! & 0x7f) << 7));
        return Promise.resolve();
      },
      reloadPreset: () => Promise.resolve(),
    };
    // 0: a hinted list; 1: a hinted param whose list does not fit (another typecode) — still never
    // written; 2: an unhinted continuous float — swept as before; 3..5: continuous floats whose hint
    // ENTRY is malformed (count 0, NaN, a fraction) — unusable for a label walk, yet the caller named
    // them as lists, so they are never written either.
    const dev = device([typeList(501), offFloat(502), level(503), level(504), level(505), level(506)]);
    const entries = {
      0: { count: 4, typecode: 16 },
      1: { count: 11, typecode: 16 },
      3: { count: 0, typecode: 305 },
      4: { count: Number.NaN, typecode: 305 },
      5: { count: 2.5, typecode: 305 },
    } as Record<number, LiveEnumHint>;
    await liveWalkDetailed(dev, { ...hints(entries), mode: 'full', write, taperPoints: 3 });
    const swept = [...new Set(sets)].sort((x, y) => x - y);
    if (swept.join(',') !== '2') fail(`full mode swept params ${swept.join(',')} (want only 2)`);
    if (dev.count(VIEW_ENUM_LABEL, 3) + dev.count(VIEW_ENUM_LABEL, 4) + dev.count(VIEW_ENUM_LABEL, 5) !== 0) fail('a malformed hint caused a label query');
  }
  console.log('  cache/livewalk-hints: full mode writes no param with a hint entry (listed, unfitting or malformed), and still sweeps unhinted continuous ones');

  // ---- Case 6: the hinted labels reach the built profile -----------------------------------------
  {
    const params: DeviceParam[] = [
      { family: 'REVERB', paramId: 0, name: 'REVERB_TYPE', unit: 'enum' },
      { family: 'REVERB', paramId: 1, name: 'REVERB_LEVEL', displayMin: -80, displayMax: 20 },
    ];
    const built = await buildCache(
      { kind: 'live', walk: () => liveWalkDetailed(device([typeList(601), level(602)]), hints({ 0: { count: 4, typecode: 16 } })) },
      params,
      {},
      {},
    );
    const roster = built.rosters['REVERB']?.map((m) => m.name).join('|');
    if (roster !== 'TYPE A|TYPE B|TYPE C|TYPE D' || built.ranges['REVERB']?.[0]?.kind !== 'enum') fail(`profile: roster ${roster}, kind ${built.ranges['REVERB']?.[0]?.kind}`);
  }
  console.log('  cache/livewalk-hints: a hinted type list becomes the family roster and an enum range');

  // ---- Case 7: enumHintsFromRanges ---------------------------------------------------------------
  {
    const rows: Record<number, { kind: string; enumCount?: number; typecode?: number }> = {
      0: { kind: 'enum', enumCount: 79, typecode: 16 },
      1: { kind: 'float', typecode: 305 },
      2: { kind: 'enum', enumCount: 3 },
      3: { kind: 'enum' },
      4: { kind: 'enum', enumCount: 0, typecode: 16 },
      5: { kind: 'enum', enumCount: 2.5, typecode: 16 },
    };
    const h = enumHintsFromRanges(rows);
    if (JSON.stringify(h) !== JSON.stringify({ 0: { count: 79, typecode: 16 } })) fail(`enumHintsFromRanges: ${JSON.stringify(h)}`);
  }
  console.log('  cache/livewalk-hints: enumHintsFromRanges keeps only enum rows with a usable count and an integer typecode');
}
