/**
 * Live walk — empty slots, strides and the empty-label-list kind rule.
 *
 * A device answers an unused or absent slot with an empty-slot definition (typecode 0, all-zero
 * body). The editor `.cache` keeps unused slots INSIDE a parameter table as all-zero float
 * placeholder rows, so a section's slot count — the fn=0x1F channel-block stride — includes them.
 * A live walk that drops every empty slot therefore under-counts the stride of every family with
 * an unused slot; channel B-D slices computed from it read the wrong params.
 *
 * Pinned here:
 *   - inner (and leading) empty slots come back as placeholder rows; trailing ones are trimmed
 *     unless a no-payload reply (the way an effect table answers past its end) ends them, which
 *     makes them the table's unused tail; a run longer than `placeholderRunLimit`, or one
 *     containing a sentinel/junk answer, is an id-space gap and stays empty;
 *   - an empty slot carrying a non-zero symbol id (the high-region past-the-end answer) is still
 *     empty: never label- or value-probed;
 *   - the committed FM3 fw 12.0 fixture, served by the shared fake device (`cacheDevice.ts`:
 *     unused slots, id gaps and the past-the-end region all answer empty-slot definitions),
 *     reproduces the shipped FM3 section strides for 38/39 families (was 20/39) and still clears
 *     the equivalence oracle; the one exception (VOLUME) ends in an unused slot, which a walk
 *     cannot see where the table end answers like an empty slot (the shared fake's model); the
 *     sparse GLOBAL section's gap rows are refused, so it stays at 186;
 *   - a label walk the device answers as EMPTY classifies the param as float (the cache rule:
 *     enum only with labels); an unanswered first label query is no evidence.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCache, HW_SEEDS, liveWalkDetailed, VIEW_DEFINITION, VIEW_ENUM_LABEL, VIEW_VALUE } from '../../src/cache/index.js';
import type { LiveTransport, LiveWalkOptions } from '../../src/cache/index.js';
import type { CacheRecord } from '../../src/cache/types.js';
import { FM3_PARAMS, FM3_RANGE_SECTIONS } from '../../src/gen3/fm3/index.js';
import { assertFm3Equivalence } from './oracle.js';
import { definitionBlockScaled, endOfRangeFrame, labelReply, replyFrame, sentinelFrame } from './livewalk.test.js';
import { cacheDevice, emptySlotFrame, isEmptyRow } from './cacheDevice.js';

export const LIVEWALK_SLOTS_CASE_COUNT = 8;

const FM3 = 0x11;
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface Q {
  view: number;
  block: number;
  param: number;
  sub: number;
}
function q(query: Uint8Array): Q {
  return { view: query[6]!, block: query[8]! | (query[9]! << 7), param: query[10]! | (query[11]! << 7), sub: query[12]! | (query[13]! << 7) };
}

const emptySlot = emptySlotFrame;

/** A real float definition (scale 1: never label-probed). */
function realDef(param: number, block: number): Uint8Array {
  const rec: CacheRecord = { kind: 'float', section: block, offset: 0, id: param, tc: 2, min: 0, max: 10, def: 1, step: 0, t1: 0, t2: 0 };
  return replyFrame(VIEW_DEFINITION, param, 0x3a, definitionBlockScaled(rec, 1));
}

const isPlaceholderRow = (r: CacheRecord): boolean => r.kind === 'float' && isEmptyRow(r);

/**
 * Serve one block from a slot map: 'R' real, 'E' empty slot, 'S' sentinel, 'J' junk definition,
 * 'N' no-payload definition reply (count 0), 'M' end marker (empty body, non-zero id), 'U' no
 * reply at all; past the map → `past` (default: empty slot, the shared fake's past-the-end answer).
 */
function slotDevice(block: number, map: string, past = 'E'): LiveTransport & { probes: number } {
  const t = {
    probes: 0,
    request(query: Uint8Array): Promise<Uint8Array | null> {
      const { view, param } = q(query);
      if (view !== VIEW_DEFINITION) {
        t.probes += 1;
        return Promise.resolve(sentinelFrame(view, param));
      }
      const c = map[param] ?? past;
      if (c === 'R') return Promise.resolve(realDef(param, block));
      if (c === 'S') return Promise.resolve(sentinelFrame(VIEW_DEFINITION, param));
      if (c === 'N') return Promise.resolve(replyFrame(VIEW_DEFINITION, param, 0x4d, new Uint8Array(0)));
      if (c === 'M') return Promise.resolve(emptySlot(param, 21000));
      if (c === 'U') return Promise.resolve(null);
      if (c === 'J') {
        const body = new Uint8Array(36);
        new DataView(body.buffer).setUint32(4, 0x7fff_0000, true); // implausible typecode = junk
        return Promise.resolve(replyFrame(VIEW_DEFINITION, param, 0x3a, body));
      }
      return Promise.resolve(emptySlot(param));
    },
  };
  return t;
}

const ids = (rs: readonly CacheRecord[]): string => rs.map((r) => `${r.id}${isPlaceholderRow(r) ? 'p' : ''}`).join(',');

export async function runLiveWalkSlots(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[cache/livewalk-slots] ${msg}`);
  };
  const base: LiveWalkOptions = { model: FM3, blocks: [70], maxParamId: 40, paramAbsentRunLimit: 12, readValues: false };

  // ---- Case 1: inner + leading empty slots become placeholders; trailing ones are trimmed ----
  {
    const res = await liveWalkDetailed(slotDevice(70, 'ERREERE'), base);
    if (ids(res.records) !== '0p,1,2,3p,4p,5') fail(`slot map ERREERE gave ${ids(res.records)}`);
    if (res.placeholderSlots !== 3) fail(`placeholderSlots ${res.placeholderSlots} != 3`);
    const ph = res.records.find((r) => r.id === 3)!;
    if (ph.kind !== 'float' || ph.tc !== 0 || ph.min !== 0 || ph.max !== 0 || ph.def !== 0 || ph.step !== 0) {
      fail(`placeholder row is not the all-zero float row: ${JSON.stringify(ph)}`);
    }
    const none = await liveWalkDetailed(slotDevice(70, 'ERREERE'), { ...base, placeholderRunLimit: 0 });
    if (ids(none.records) !== '1,2,5') fail(`placeholderRunLimit 0 must keep none, gave ${ids(none.records)}`);
  }
  console.log('  cache/livewalk-slots: inner/leading empty slots kept as placeholder rows, trailing ones trimmed');

  // ---- Case 2: id-space gaps stay empty (long runs, runs with a sentinel / junk answer) -----
  {
    const long = await liveWalkDetailed(slotDevice(70, 'R' + 'E'.repeat(6) + 'R'), { ...base, placeholderRunLimit: 5 });
    if (ids(long.records) !== '0,7') fail(`run of 6 > limit 5 must stay a gap, gave ${ids(long.records)}`);
    const withSentinel = await liveWalkDetailed(slotDevice(70, 'RESER'), base);
    if (ids(withSentinel.records) !== '0,4') fail(`run with a sentinel must stay a gap, gave ${ids(withSentinel.records)}`);
    const withJunk = await liveWalkDetailed(slotDevice(70, 'REJER'), base);
    if (ids(withJunk.records) !== '0,4') fail(`run with a junk answer must stay a gap, gave ${ids(withJunk.records)}`);
  }
  console.log('  cache/livewalk-slots: long runs and runs with a sentinel/junk answer stay id-space gaps');

  // ---- Case 3: an empty slot with a non-zero symbol id is still empty (never probed) ---------
  {
    let labelProbes = 0;
    let valueReads = 0;
    const t: LiveTransport = {
      request(query) {
        const { view, param } = q(query);
        if (view === VIEW_ENUM_LABEL) labelProbes += 1;
        if (view === VIEW_VALUE) valueReads += 1;
        if (view !== VIEW_DEFINITION) return Promise.resolve(sentinelFrame(view, param));
        if (param < 130) return Promise.resolve(param === 129 ? realDef(param, 70) : emptySlot(param));
        return Promise.resolve(emptySlot(param, 21000 + param)); // high-region past-the-end form
      },
    };
    const res = await liveWalkDetailed(t, { model: FM3, blocks: [70], maxParamId: 160, paramAbsentRunLimit: 140, blockProbeDepth: 200, readValues: true, placeholderRunLimit: 0 });
    if (ids(res.records) !== '129') fail(`high-region empty slots must be trimmed, gave ${ids(res.records)}`);
    if (labelProbes !== 0) fail(`empty slots were label-probed ${labelProbes}x`);
    if (valueReads !== 1) fail(`only the real param may get a value read, saw ${valueReads}`);
  }
  console.log('  cache/livewalk-slots: an empty slot with a non-zero symbol id is empty — no 0x1f/0x00 probes, trimmed');

  // ---- Case 8: a table's unused tail, ended by a no-payload reply, is kept --------------------
  // Past the end of an effect table the device answers a no-payload definition reply, an unused
  // slot an empty-slot definition: the empty slots between the last real definition and that reply
  // lie inside the table (the editor cache carries them), so the stride counts them.
  {
    const tail = await liveWalkDetailed(slotDevice(70, 'RRE', 'N'), base);
    if (ids(tail.records) !== '0,1,2p' || tail.placeholderSlots !== 1) fail(`tail ended by a no-payload reply: ${ids(tail.records)} / ${tail.placeholderSlots}`);
    const two = await liveWalkDetailed(slotDevice(70, 'ERREE', 'N'), base);
    if (ids(two.records) !== '0p,1,2,3p,4p' || two.placeholderSlots !== 3) fail(`leading + two-slot tail: ${ids(two.records)} / ${two.placeholderSlots}`);
    // Nothing to keep when the table ends right after its last real definition.
    const none = await liveWalkDetailed(slotDevice(70, 'RR', 'N'), base);
    if (ids(none.records) !== '0,1' || none.placeholderSlots !== 0) fail(`no tail: ${ids(none.records)}`);
    // Still trimmed: no no-payload end (the run reaches the stop run, or a sentinel-tagged reply or a
    // junk definition follows it), an end marker in the run, a slot nobody answered, a run longer
    // than the placeholder limit, or the limit 0.
    const cases: Array<[string, string, Partial<LiveWalkOptions>]> = [
      ['RRE', 'E', {}],
      // A sentinel-tagged reply or a junk definition after the run is no table end.
      ['RRE', 'S', {}],
      ['RRE', 'J', {}],
      ['RREM', 'N', {}],
      ['RREU', 'N', { lostReplyRetries: 0 }],
      ['RREEE', 'N', { placeholderRunLimit: 2 }],
      ['RRE', 'N', { placeholderRunLimit: 0 }],
    ];
    for (const [map, past, extra] of cases) {
      const r = await liveWalkDetailed(slotDevice(70, map, past), { ...base, ...extra });
      if (ids(r.records) !== '0,1') fail(`map ${map} past ${past} ${JSON.stringify(extra)}: tail must be trimmed, gave ${ids(r.records)}`);
    }
    // A no-payload reply INSIDE a table (a later real definition follows) leaves that run a gap, as
    // any other non-slot answer does — the tail rule only applies where the block ends.
    const inner = await liveWalkDetailed(slotDevice(70, 'RRENR', 'N'), base);
    if (ids(inner.records) !== '0,1,4') fail(`a no-payload reply inside the table: ${ids(inner.records)}`);
  }
  console.log('  cache/livewalk-slots: the unused tail of a table ended by a no-payload reply is kept; without that end, or with a marker, silence or an over-long run, it is trimmed');

  // ---- Case 4/5: FM3 fixture through the shared fake device — strides vs the shipped table --
  // The shared device model: unused slots, id gaps of sparse sections and everything past the end
  // of a table all answer with the empty-slot definition.
  const all = (JSON.parse(readFileSync(join(FIXTURES, 'fm3-12p0.walk.json'), 'utf8')) as { records: CacheRecord[] }).records;
  const ordinary = all.filter((r) => r.id < 0xff00);
  const specials = all.filter((r) => r.id >= 0xff00);
  const device = cacheDevice(all);
  const sections = [...new Set(ordinary.map((r) => r.section))].sort((a, b) => a - b);
  const maxId = Math.max(...ordinary.map((r) => r.id));
  const walkOpts: LiveWalkOptions = { model: FM3, blocks: sections, maxParamId: maxId, paramAbsentRunLimit: 7000, readValues: false };
  const strideCheck = async (placeholderRunLimit?: number) => {
    const res = await liveWalkDetailed(device, { ...walkOpts, ...(placeholderRunLimit !== undefined ? { placeholderRunLimit } : {}) });
    const built = await buildCache({ kind: 'live', walk: async () => [...res.records, ...specials] }, FM3_PARAMS, HW_SEEDS, {});
    const off: string[] = [];
    for (const [fam, m] of Object.entries(FM3_RANGE_SECTIONS)) {
      const got = built.rangeSections[fam];
      if (!got || got.stride !== m.stride) off.push(`${fam}:${got?.stride}/${m.stride}`);
    }
    return { res, built, off, total: Object.keys(FM3_RANGE_SECTIONS).length };
  };

  {
    const before = await strideCheck(0);
    if (before.off.length !== 19) fail(`pre-placeholder baseline drifted: ${before.total - before.off.length}/${before.total} (${before.off.join(' ')})`);
    const after = await strideCheck();
    if (after.off.join(' ') !== 'VOLUME:14/15') fail(`strides off after the fix: ${after.off.join(' ')}`);
    // GLOBAL's small id gaps DO come back as placeholder rows from the walk (the device answers
    // them like unused slots), but a sparse id space is not a table: buildDeviceCache refuses them.
    const globalTag = after.built.rangeSections['GLOBAL']?.sectionTag;
    const globalPh = after.res.records.filter((r) => r.section === globalTag && r.kind === 'float' && r.placeholder).length;
    if (globalPh === 0) fail('the walk should have produced provisional placeholders in the sparse GLOBAL section');
    if (after.built.rangeSections['GLOBAL']?.stride !== 186 || after.built.rangeSections['PRESET']?.stride !== 50) {
      fail(`sparse sections must not inflate: GLOBAL ${after.built.rangeSections['GLOBAL']?.stride}, PRESET ${after.built.rangeSections['PRESET']?.stride}`);
    }
    if (after.built.ranges['GLOBAL']?.[37] !== undefined) fail('a GLOBAL id gap must not become a range row');
    console.log(
      `  cache/livewalk-slots: FM3 live strides match the shipped sections ${after.total - after.off.length}/${after.total} ` +
        `(was ${before.total - before.off.length}/${before.total}); ${after.res.placeholderSlots} inner placeholders; ` +
        `only VOLUME differs (its table ends in an unused slot); ${globalPh} gap rows refused in sparse GLOBAL (stays 186)`,
    );
    // ---- Case 5: … and the result still clears the shared FM3 oracle ----------------------
    const m = assertFm3Equivalence(after.built);
    console.log(`  cache/livewalk-slots: placeholder-aware live build clears the FM3 oracle (ranges ${m.ranges.ok}/${m.ranges.total})`);
  }

  // ---- Case 6/7: an empty label list makes a float; no answer is no evidence ---------------
  {
    const kindFor = async (labelAnswer: 'labels' | 'empty' | 'none', scale = 0, min = 20, max = 200) => {
      const t: LiveTransport = {
        request(query) {
          const { view, param, sub } = q(query);
          if (view === VIEW_DEFINITION && param === 0) {
            const rec: CacheRecord = { kind: 'enum', section: 70, offset: 0, id: 0, tc: 16, min, max, def: 0, step: 0, count: 0, values: [], x: 0 };
            return Promise.resolve(replyFrame(VIEW_DEFINITION, 0, 0x3a, definitionBlockScaled(rec, scale)));
          }
          if (view === VIEW_ENUM_LABEL) {
            if (labelAnswer === 'labels' && sub - min < 3) return Promise.resolve(labelReply(`L${sub}`, 0));
            if (labelAnswer === 'none') return Promise.resolve(null);
            return Promise.resolve(endOfRangeFrame(VIEW_ENUM_LABEL, 0));
          }
          return Promise.resolve(sentinelFrame(view, param));
        },
      };
      const res = await liveWalkDetailed(t, { model: FM3, blocks: [70], maxParamId: 0, readValues: false, sleep: () => Promise.resolve() });
      return res.records[0]!;
    };
    if ((await kindFor('labels')).kind !== 'enum') fail('a captured label list must stay enum');
    if ((await kindFor('empty')).kind !== 'float') fail('an answered-but-empty label list must classify float');
    if ((await kindFor('none')).kind !== 'enum') fail('an unanswered first label query is no evidence: the enum guess must stand');
    console.log('  cache/livewalk-slots: an answered-empty label list classifies float; labels → enum; no answer → guess stands');

    // A table slot with a typecode but a zero range (the cache's float placeholder row) — the
    // enum signature with no labels — comes back as the same float row.
    const zeroRange = await kindFor('empty', 0, 0, 0);
    if (zeroRange.kind !== 'float' || !isEmptyRow({ ...zeroRange, tc: 0 })) fail(`zero-range slot came back as ${zeroRange.kind}`);
    console.log('  cache/livewalk-slots: a zero-range table slot with no labels becomes the float placeholder row');
  }
}
