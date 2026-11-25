/**
 * Profile document v2: multi-source merge, provenance, coverage, roster diff.
 *
 * Sources: the FM3 fw 12.0 fixture as an editor-cache source, and synthetic live sources made
 * from the same rows in the live block-address space (FM3 effect ids): a unit on every
 * continuous float, two enums flipped to float (a live-walk kind artefact), one table a slot
 * short, a few altered rows.
 *
 * - units attach only on tuple-equal rows; the byte rows keep kind, labels and stride;
 * - conflicts are counted (kind flips are not), > 10 % of a family's rows -> disagreement;
 * - a live-full measured taper attaches (and wins over the catalog's knob taper);
 * - a local editor cache beats a newer cloud one; sources on another firmware are rejected;
 * - an extended live source and a standard one are unioned per (block, pid), newest covering wins;
 * - coverage gaps: high ids, far ids, blocks above 160, rosters (blocking only off the catalog
 *   firmware), walk losses and bound hits (only from walks that still provide a family), no-raw,
 *   instance evidence;
 * - bound hits of a real walk: a hit at the read-only cap inside a table the reference (catalog or
 *   editor cache) knows to run on raises no bound-hit (the high-ids gap covers it), a hit at a
 *   known-size ceiling does, and without a reference every hit does;
 * - suspects per source and the fallback to a non-suspect copy; suspect copies raise no conflict;
 * - `rosterDiff` vectors;
 * - same-kind live sources: an older record fills in where the newer walk has none;
 * - capture order by instant (ISO offsets, sub-seconds); `uniqueSourceIds` for undated sources;
 * - v1 documents take their source class from `meta.origin` (cloud / definitions file); without
 *   effect ids PRESET never counts as addressable.
 *
 * Public data only: the committed walk fixture, committed catalogs, synthetic records.
 */
import {
  buildCache,
  computeCoverage,
  deriveProfile,
  HW_SEEDS,
  isSyntheticFamilyKey,
  liveWalkDetailed,
  liveWalkScope,
  ProfileDerivationError,
  rawFromCacheBytes,
  rawFromLiveWalk,
  rawSourceId,
  rosterDiff,
  sourceRank,
  uniqueSourceIds,
} from '../../src/cache/index.js';
import type {
  BuiltCache,
  DerivedProfile,
  EditorCacheRawSource,
  LiveRawSource,
  LiveWalkOptions,
  ProfileCatalog,
  ProfileRaw,
  RawSource,
} from '../../src/cache/index.js';
import type { CacheRecord, CacheWalk, FloatTaper } from '../../src/cache/types.js';
import {
  FM3_CATALOG_SECTIONS,
  FM3_EFFECT_IDS,
  FM3_ENUM_OVERRIDES,
  FM3_PARAMS,
  FM3_RANGES,
} from '../../src/gen3/fm3/index.js';
import { VERSION } from '../../src/version.js';
import { cacheDevice } from './cacheDevice.js';
import { fixtureBytes, loadWalk } from './profile-doc.test.js';

export const MERGE_CASE_COUNT = 15;

type LiveRec = LiveRawSource['records'][number];

const raw = (...sources: RawSource[]): ProfileRaw => ({ format: 1, sources });

const T0 = '2026-11-20T10:00:00Z';
const T1 = '2026-11-21T10:00:00Z';
const T2 = '2026-11-22T10:00:00Z';

function liveSource(
  kind: LiveRawSource['kind'],
  capturedAt: string,
  records: LiveRec[],
  over: Partial<Pick<LiveRawSource, 'origin' | 'firmware' | 'scope' | 'walk'>> = {},
): LiveRawSource {
  return {
    id: `${kind}@${capturedAt}#0`,
    kind,
    origin: over.origin ?? 'local',
    capturedAt,
    firmware: over.firmware === undefined ? '12.0' : over.firmware,
    codecVersion: VERSION,
    space: 'block',
    scope: over.scope ?? { blocks: [...new Set(records.map((r) => r.section))].sort((a, b) => a - b), maxParamId: 127, bounds: {}, extended: false, above160: false, hinted: true },
    walk: over.walk ?? { queries: 0, lostReplies: 0, recoveredReplies: 0, unresolvedReplies: 0, placeholderSlots: 0, missingSlots: 0, silentAddresses: 0, boundHits: [] },
    records,
  };
}

/**
 * The fixture's assigned sections as a hinted live walk would read them, at FM3 effect ids
 * (instance tags at consecutive ids): ids in [minId, maxId], a unit on every continuous float
 * that is not a 0..10 knob.
 */
function liveFromBytes(byteDoc: DerivedProfile, walk: CacheWalk, maxId = 127, minId = 0, families?: readonly string[]): LiveRec[] {
  const out: LiveRec[] = [];
  for (const [fam, meta] of Object.entries(byteDoc.rangeSections)) {
    if (isSyntheticFamilyKey(fam) || (families && !families.includes(fam))) continue;
    const eid = FM3_EFFECT_IDS[fam];
    if (eid == null) continue;
    (meta.instanceTags ?? [meta.sectionTag]).forEach((tag, i) => {
      for (const r of walk.records) {
        if (r.section !== tag || r.id >= 0xff00 || r.id > maxId || r.id < minId) continue;
        const { offset: _o, ...rest } = r as CacheRecord & { nameSpans?: unknown };
        delete (rest as { nameSpans?: unknown }).nameSpans;
        const rec = { ...rest, section: eid + i } as LiveRec;
        if (rec.kind === 'float' && rec.max > rec.min && rec.tc !== 0x52) rec.unit = 'dB';
        out.push(rec);
      }
    });
  }
  return out;
}

const at = (recs: LiveRec[], block: number, id: number): LiveRec => {
  const r = recs.find((x) => x.section === block && x.id === id);
  if (!r) throw new Error(`[cache/merge] no live record ${block}:${id}`);
  return r;
};

export async function runMerge(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[cache/merge] ${msg}`);
  };
  const walk = loadWalk('fm3-12p0.walk.json');
  const buf = fixtureBytes(walk, 12, 0);
  const byte = await rawFromCacheBytes(buf, { capturedAt: T0, firmware: '12.0' });
  const opts = { model: 0x11, firmware: '12.0', catalogSections: FM3_CATALOG_SECTIONS };
  const byteDoc = deriveProfile(raw(byte), FM3_PARAMS, HW_SEEDS, opts);
  const eid = (f: string) => FM3_EFFECT_IDS[f]!;
  const floatPids = (f: string, n: number) =>
    Object.entries(byteDoc.ranges[f]!).filter(([, r]) => r.kind === 'float' && r.displayMax > r.displayMin && r.typecode !== 0x52).slice(0, n).map(([p]) => Number(p));
  const enumPids = (f: string, n: number) => Object.entries(byteDoc.ranges[f]!).filter(([, r]) => r.kind === 'enum').slice(0, n).map(([p]) => Number(p));

  // Synthetic live source with the artefacts listed in the module comment.
  const live = liveFromBytes(byteDoc, walk);
  const [revAltered] = floatPids('REVERB', 1);
  const formantAltered = floatPids('FORMANT', 2);
  const flipped = enumPids('DELAY', 2);
  const chorusStride = byteDoc.rangeSections['CHORUS']!.stride;
  {
    const r = at(live, eid('REVERB'), revAltered!);
    r.max += 1;
    r.unit = 'Hz';
    for (const p of formantAltered) at(live, eid('FORMANT'), p).min -= 0.5;
    for (const p of flipped) {
      const i = live.findIndex((x) => x.section === eid('DELAY') && x.id === p);
      const e = live[i]!;
      live[i] = { kind: 'float', section: e.section, id: e.id, tc: e.tc, min: e.min, max: e.max, def: e.def, step: e.step, t1: 0, t2: 0 };
    }
    const lastChorus = live.findIndex((x) => x.section === eid('CHORUS') && x.id === chorusStride - 1);
    live.splice(lastChorus, 1);
  }
  const liveRO = liveSource('live-readonly', T1, live);
  const merged = deriveProfile(raw(byte, liveRO), FM3_PARAMS, HW_SEEDS, opts);
  const liveOnlyRO = deriveProfile(raw(liveRO), FM3_PARAMS, HW_SEEDS, opts);

  // ---- Case 1: units attach only on tuple-equal rows -----------------------------------------
  {
    if (liveOnlyRO.rangeSections['REVERB']?.sectionTag !== eid('REVERB')) fail('the live voter must place REVERB at its effect id');
    let expected = 0;
    let attached = 0;
    for (const [fam, rows] of Object.entries(byteDoc.ranges)) {
      if (isSyntheticFamilyKey(fam)) continue;
      for (const [p, row] of Object.entries(rows)) {
        const m = merged.ranges[fam]![Number(p)]!;
        const continuous = row.kind === 'float' && row.displayMax > row.displayMin && row.typecode !== 0x52;
        const altered = (fam === 'REVERB' && Number(p) === revAltered) || (fam === 'FORMANT' && formantAltered.includes(Number(p)));
        const lowId = Number(p) <= 127 && FM3_EFFECT_IDS[fam] != null;
        const want = continuous && lowId && !altered && !(fam === 'CHORUS' && Number(p) === chorusStride - 1) ? 'dB' : undefined;
        if (want) expected += 1;
        if (m.unit !== want) fail(`${fam}[${p}] unit ${m.unit}, want ${want}`);
        if (m.unit) attached += 1;
        const { unit: _u, ...rest } = m;
        if (JSON.stringify(rest) !== JSON.stringify(row)) fail(`${fam}[${p}] changed beyond the unit`);
      }
    }
    if (attached !== expected || merged.coverage.units !== attached || merged.provenance.units[liveRO.id] !== attached) {
      fail(`units ${attached}/${expected}, coverage ${merged.coverage.units}, provenance ${merged.provenance.units[liveRO.id]}`);
    }
    console.log(`  cache/merge: ${attached} device units attached to tuple-equal byte rows; altered rows (REVERB[${revAltered}], FORMANT ${formantAltered.join('/')}) get none`);
  }

  // ---- Case 2: byte wins kind, labels, stride ------------------------------------------------
  {
    for (const p of flipped) {
      if (liveOnlyRO.ranges['DELAY']![p]!.kind !== 'float') fail('the live copy must carry the flipped kind');
      if (merged.ranges['DELAY']![p]!.kind !== 'enum' || JSON.stringify(merged.enumOverrides['DELAY']![String(p)]) !== JSON.stringify(byteDoc.enumOverrides['DELAY']![String(p)])) {
        fail(`DELAY[${p}] must stay the byte enum with its labels`);
      }
    }
    if (liveOnlyRO.rangeSections['CHORUS']!.stride !== chorusStride - 1 || merged.rangeSections['CHORUS']!.stride !== chorusStride) {
      fail(`CHORUS stride live ${liveOnlyRO.rangeSections['CHORUS']!.stride}, merged ${merged.rangeSections['CHORUS']!.stride}, byte ${chorusStride}`);
    }
    if (JSON.stringify(merged.rangeSections) !== JSON.stringify(byteDoc.rangeSections) || JSON.stringify(merged.rosters) !== JSON.stringify(byteDoc.rosters)) {
      fail('section meta and rosters come from the byte source');
    }
    if (JSON.stringify(merged.cabIrs) !== JSON.stringify(byteDoc.cabIrs) || merged.meta.source !== 'bytes' || merged.meta.walk !== undefined) fail('cab tables / meta from the byte source');
    if (merged.provenance.existence['REVERB'] !== byte.id || merged.provenance.existence['section:53'] !== byte.id) fail('existence goes to the byte source');
    if (merged.sections.filter((s) => s.space === 'block').length === 0 || merged.coverage.sections.total !== 45) fail('both units keep their sections; counts use the byte space');
    console.log(`  cache/merge: byte rows keep kind + labels (DELAY ${flipped.join('/')} flipped live), stride (CHORUS ${chorusStride} vs live ${chorusStride - 1}), section meta, rosters, cab tables`);
  }

  // ---- Case 3: conflicts counted, 10 % disagreement ------------------------------------------
  {
    const byKey = new Map(merged.provenance.conflicts.map((c) => [c.key, c]));
    const rev = byKey.get('REVERB');
    const fmt = byKey.get('FORMANT');
    if (!rev || rev.count !== 1 || rev.pids.join() !== String(revAltered) || rev.winner !== byte.id || rev.loser !== liveRO.id) fail(`REVERB conflict ${JSON.stringify(rev)}`);
    if (!fmt || fmt.count !== 2) fail(`FORMANT conflict ${JSON.stringify(fmt)}`);
    if (byKey.has('DELAY') || byKey.has('CHORUS')) fail('kind flips and a missing slot are not conflicts');
    if (merged.provenance.conflicts.length !== 2) fail(`conflicts ${JSON.stringify(merged.provenance.conflicts)}`);
    const gap = merged.coverage.gaps.find((g) => g.kind === 'disagreement');
    if (!gap || !gap.blocking || gap.families?.join() !== 'FORMANT' || merged.coverage.complete) fail(`disagreement gap ${JSON.stringify(gap)}`);
    console.log(`  cache/merge: conflicts REVERB 1 (1/${byteDoc.sections.find((s) => s.key === 'REVERB')!.informative} rows) and FORMANT 2 (> 10 % -> blocking disagreement); flips not counted`);
  }

  // ---- Case 4: live-full taper attaches and beats the catalog's knob taper -------------------
  {
    const knobFam = Object.keys(FM3_RANGES).find((f) => FM3_EFFECT_IDS[f] != null && Object.values(FM3_RANGES[f]!).some((r) => r.typecode === 0x52 && r.taper === 'linear'))!;
    const knobPid = Number(Object.entries(FM3_RANGES[knobFam]!).find(([p, r]) => r.typecode === 0x52 && r.taper === 'linear' && Number(p) <= 127)![0]);
    const logPid = floatPids('REVERB', 3)[2]!;
    const sweep: FloatTaper = { shape: 'log', err: 0.01, reliable: true, points: [[0, 1], [0.5, 10], [1, 100]] };
    const fullRecs = liveFromBytes(byteDoc, walk);
    (at(fullRecs, eid(knobFam), knobPid) as Extract<LiveRec, { kind: 'float' }>).taper = sweep;
    (at(fullRecs, eid('REVERB'), logPid) as Extract<LiveRec, { kind: 'float' }>).taper = sweep;
    // A read-only source carrying a taper (not a sweep result) must not contribute one.
    const roRecs = liveFromBytes(byteDoc, walk);
    (at(roRecs, eid('REVERB'), floatPids('REVERB', 4)[3]!) as Extract<LiveRec, { kind: 'float' }>).taper = sweep;
    const full = liveSource('live-full', T1, fullRecs);
    const ro = liveSource('live-readonly', T2, roRecs);
    const doc = deriveProfile(raw(byte, ro, full), FM3_PARAMS, HW_SEEDS, opts);
    const k = doc.ranges[knobFam]![knobPid]!;
    if (FM3_RANGES[knobFam]![knobPid]!.taper !== 'linear' || k.taper !== 'log' || (k.displayMin === 0 && k.displayMax === 10)) fail(`knob row ${knobFam}[${knobPid}] ${JSON.stringify(k)}`);
    if (doc.ranges['REVERB']![logPid]!.taper !== 'log' || doc.ranges['REVERB']![floatPids('REVERB', 4)[3]!]!.taper !== undefined) fail('live-full taper only');
    if (doc.provenance.tapers[full.id] !== 2 || doc.coverage.tapers !== 2 || doc.coverage.gaps.some((g) => g.kind === 'no-tapers')) {
      fail(`tapers provenance ${JSON.stringify(doc.provenance.tapers)}, coverage ${doc.coverage.tapers}`);
    }
    if (doc.provenance.units[full.id] === undefined || doc.provenance.units[ro.id] !== undefined) fail('units come from the best-ranked live source (live-full before live-readonly)');
    console.log(`  cache/merge: live-full log taper attached to ${knobFam}[${knobPid}] (catalog knob rule: linear 0..10) and REVERB[${logPid}]; a read-only taper is ignored`);
  }

  // ---- Case 5: local editor cache beats a newer cloud one -----------------------------------
  {
    const cloudRecords = byte.records.map((r) => (r.section === 12 && r.id === revAltered ? { ...r, max: r.max + 2 } : r));
    const cloud: EditorCacheRawSource = { ...byte, id: `editor-cache@${T2}#0`, origin: 'cloud', capturedAt: T2, records: cloudRecords };
    const doc = deriveProfile(raw(cloud, byte), FM3_PARAMS, HW_SEEDS, opts);
    if (JSON.stringify(doc.ranges['REVERB']) !== JSON.stringify(byteDoc.ranges['REVERB']) || doc.provenance.existence['REVERB'] !== byte.id) fail('local byte rows must win');
    const c = doc.provenance.conflicts.find((x) => x.key === 'REVERB');
    if (!c || c.winner !== byte.id || c.loser !== cloud.id || c.count !== 1) fail(`cloud conflict ${JSON.stringify(c)}`);
    if (sourceRank('editor-cache', 'local') >= sourceRank('editor-cache', 'cloud') || sourceRank('editor-cache', 'file') >= sourceRank('live-full', 'local')) fail('source ranks');
    if (doc.meta.recordCount !== byteDoc.meta.recordCount) fail('meta comes from the local source');
    console.log('  cache/merge: local editor cache beats a newer cloud one (rows, existence); the difference is a recorded conflict');
  }

  // ---- Case 6: firmware mismatch rejected -------------------------------------------------
  {
    const code = (f: () => void): string => {
      try {
        f();
      } catch (e) {
        return e instanceof ProfileDerivationError ? e.code : `other: ${String(e)}`;
      }
      return 'none';
    };
    const other = liveSource('live-readonly', T1, live, { firmware: '13.0' });
    const a = code(() => deriveProfile(raw(byte, other), FM3_PARAMS, HW_SEEDS, {}));
    const b = code(() => deriveProfile(raw(byte), FM3_PARAMS, HW_SEEDS, { firmware: '13.0' }));
    const c = code(() => deriveProfile(raw(byte, liveSource('live-readonly', T1, live, { firmware: null })), FM3_PARAMS, HW_SEEDS, { firmware: '12.0' }));
    if (a !== 'firmware-mismatch' || b !== 'firmware-mismatch' || c !== 'none') fail(`firmware checks ${a} / ${b} / ${c}`);
    console.log('  cache/merge: a source on another firmware is rejected (against each other and against the document key); unknown firmware passes');
  }

  // ---- Case 7: standard + extended live sources unioned per (block, pid) ---------------------
  {
    const standard = liveFromBytes(byteDoc, walk, 127);
    at(standard, eid('DISTORT'), 5).max += 3; // a stale value the newer walk corrects
    const extFams = ['DISTORT', 'CONTROLLERS', 'RESONATOR', 'LOOPER'];
    const extended = liveFromBytes(byteDoc, walk, 255, 0, extFams);
    const blocks = [...new Set(extended.map((r) => r.section))].sort((x, y) => x - y);
    const bounds = Object.fromEntries(blocks.map((b) => [b, 255]));
    const std = liveSource('live-readonly', T1, standard);
    const ext = liveSource('live-readonly', T2, extended, { scope: { blocks, maxParamId: 127, bounds, extended: true, above160: true, hinted: true } });
    const doc = deriveProfile(raw(std, ext), FM3_PARAMS, HW_SEEDS, opts);
    for (const f of extFams) {
      const want = byteDoc.rangeSections[f]!.stride;
      if (doc.rangeSections[f]?.stride !== want) fail(`${f} stride ${doc.rangeSections[f]?.stride}, byte ${want}`);
    }
    const d5 = doc.ranges['DISTORT']![5]!;
    if (d5.displayMax !== byteDoc.ranges['DISTORT']![5]!.displayMax) fail('the newer covering walk wins DISTORT[5]');
    if (Object.keys(doc.ranges['DISTORT']!).length !== 144 || doc.ranges['REVERB'] === undefined || doc.provenance.existence['REVERB'] !== std.id || doc.provenance.existence['DISTORT'] !== ext.id) {
      fail(`union: DISTORT ${Object.keys(doc.ranges['DISTORT']!).length} rows, existence ${doc.provenance.existence['REVERB']} / ${doc.provenance.existence['DISTORT']}`);
    }
    if (doc.meta.source !== 'live' || doc.sections.some((s) => s.space === 'section') || doc.meta.sources.length !== 2) fail('live-only meta');
    console.log(`  cache/merge: standard (ids <= 127) + newer extended walk (${extFams.join(', ')} to 255) unioned — strides equal the byte ones, newest covering walk wins per id`);
  }

  // ---- Case 8: coverage gaps of live-only and byte documents ---------------------------------
  {
    const catalog: ProfileCatalog = {
      firmware: '12.0',
      ranges: FM3_RANGES,
      enumOverrides: FM3_ENUM_OVERRIDES,
      rosters: Object.fromEntries(Object.entries(byteDoc.rosters)),
      familyFirstEid: FM3_EFFECT_IDS,
      sections: FM3_CATALOG_SECTIONS,
    };
    const kinds = (d: DerivedProfile) => d.coverage.gaps.map((g) => `${g.kind}${g.blocking ? '!' : ''}`).join(',');
    // Byte document on the catalog firmware: complete; only the never-blocking unit/taper gaps.
    const b = deriveProfile(raw(byte), FM3_PARAMS, HW_SEEDS, { ...opts, catalog });
    if (kinds(b) !== 'no-units,no-tapers' || !b.coverage.complete || b.coverage.highIds.expected === 0 || b.coverage.highIds.expected !== b.coverage.highIds.present) {
      fail(`byte coverage ${kinds(b)} ${JSON.stringify(b.coverage.highIds)}`);
    }
    // Live-only standard walk on newer firmware, without label lists for the roster selectors.
    // (A standard walk covers effect ids up to 160.)
    const recs = liveFromBytes(byteDoc, walk, 127)
      .filter((r) => r.section <= 160)
      .map((r) => (r.kind === 'enum' && r.values.length > 80 ? { ...r, values: [] } : r));
    const lo = liveSource('live-readonly', T1, recs, { firmware: '13.0' });
    const l = deriveProfile(raw(lo), FM3_PARAMS, HW_SEEDS, { ...opts, firmware: '13.0', catalog });
    const g = (k: string) => l.coverage.gaps.find((x) => x.kind === k);
    const high = g('high-ids');
    if (!high?.blocking || !high.families?.includes('DISTORT') || !high.families.includes('CONTROLLERS') || high.fix.join() !== 'read-extended,import-editor-cache') fail(`high-ids ${JSON.stringify(high)}`);
    if (!g('far-ids') || g('far-ids')!.blocking || !g('far-ids')!.families?.includes('GLOBAL')) fail(`far-ids ${JSON.stringify(g('far-ids'))}`);
    const above = g('blocks-above-160');
    if (!above?.blocking || above.families?.join() !== 'FDBKRET,FDBKSEND,LOOPER,MULTIPLEXER,PLEX,RESONATOR') fail(`blocks-above-160 ${JSON.stringify(above)}`);
    const ros = g('rosters');
    if (!ros?.blocking || !ros.families?.includes('DISTORT')) fail(`rosters ${JSON.stringify(ros)}`);
    if (!g('no-cab-tables') || l.coverage.complete || l.coverage.highIds.present >= l.coverage.highIds.expected) fail(`live-only coverage ${kinds(l)} ${JSON.stringify(l.coverage.highIds)}`);
    // Same walk on the catalog firmware: the firmware-dependent gaps stop blocking (the catalog's
    // own rows cover the high ids, the roster families and the blocks above 160).
    const same = deriveProfile(raw({ ...lo, firmware: '12.0' }), FM3_PARAMS, HW_SEEDS, { ...opts, catalog });
    const sg = (k: string) => same.coverage.gaps.find((x) => x.kind === k);
    if (sg('blocks-above-160')?.blocking !== false || sg('rosters')?.blocking !== false || sg('high-ids')?.blocking !== false || !same.coverage.complete) fail(`catalog-firmware coverage ${kinds(same)}`);
    // An unknown catalog firmware counts as differing: blocking again.
    const unknownFw = deriveProfile(raw({ ...lo, firmware: '12.0' }), FM3_PARAMS, HW_SEEDS, { ...opts, catalog: { ...catalog, firmware: null } });
    const ug = (k: string) => unknownFw.coverage.gaps.find((x) => x.kind === k);
    if (!ug('high-ids')?.blocking || !ug('blocks-above-160')?.blocking || !ug('rosters')?.blocking) fail(`unknown catalog firmware coverage ${kinds(unknownFw)}`);
    console.log(`  cache/merge: coverage — byte doc complete (${kinds(b)}, high ids ${b.coverage.highIds.present}/${b.coverage.highIds.expected}); live-only on 13.0: ${kinds(l)}; on the catalog firmware: ${kinds(same)}`);
  }

  // ---- Case 9: walk losses, bound hits, no-raw, instance evidence ----------------------------
  {
    const recs = liveFromBytes(byteDoc, walk, 127);
    const blocks = [...new Set(recs.map((r) => r.section)), eid('MULTITAP') + 1].sort((x, y) => x - y);
    const lossy = liveSource('live-readonly', T1, recs, {
      scope: { blocks, maxParamId: 127, bounds: {}, extended: false, above160: false, hinted: true },
      walk: { queries: 9000, lostReplies: 5, recoveredReplies: 2, unresolvedReplies: 3, placeholderSlots: 0, missingSlots: 1, silentAddresses: 0, boundHits: [{ block: 58, lastReal: 125, bound: 127 }] },
    });
    const catalog: ProfileCatalog = { familyFirstEid: FM3_EFFECT_IDS, instanceLimits: { INPUT: 2, OUTPUT: 2, MULTITAP: 2, DISTORT: 1 } };
    // Live-only: the lossy walk provides every family, so its losses are the document's.
    const d = deriveProfile(raw(lossy), FM3_PARAMS, HW_SEEDS, { ...opts, catalog });
    const g = (k: string) => d.coverage.gaps.find((x) => x.kind === k);
    if (g('unresolved-replies')?.count !== 3 || !g('unresolved-replies')?.blocking || g('missing-slots')?.count !== 1 || g('bound-hit')?.eids?.join() !== '58') {
      fail(`walk gaps ${JSON.stringify(d.coverage.gaps)}`);
    }
    if (JSON.stringify(d.coverage.walk) !== JSON.stringify({ lostReplies: 5, unresolvedReplies: 3, missingSlots: 1, boundHits: 1 })) fail(`coverage.walk ${JSON.stringify(d.coverage.walk)}`);
    if (JSON.stringify(d.coverage.instances) !== JSON.stringify([{ family: 'MULTITAP', static: 2, seen: 1 }])) fail(`instances ${JSON.stringify(d.coverage.instances)}`);
    // With the editor cache every family's existence comes from the bytes: the walk's losses no longer
    // matter (its units attach only to tuple-equal rows). Instance evidence still comes from the walk.
    const withByte = deriveProfile(raw(byte, lossy), FM3_PARAMS, HW_SEEDS, { ...opts, catalog });
    const walkKinds = ['unresolved-replies', 'missing-slots', 'bound-hit'];
    if (withByte.coverage.gaps.some((x) => walkKinds.includes(x.kind)) || JSON.stringify(withByte.coverage.walk) !== JSON.stringify({ lostReplies: 0, unresolvedReplies: 0, missingSlots: 0, boundHits: 0 })) {
      fail(`byte + lossy walk: ${JSON.stringify(withByte.coverage)}`);
    }
    if (JSON.stringify(withByte.coverage.instances) !== JSON.stringify(d.coverage.instances)) fail(`byte + lossy instances ${JSON.stringify(withByte.coverage.instances)}`);
    // The walk also read a block the catalog does not know (no editor-cache section matches): it
    // provides that block's family, so its reply losses count again — but its bound hit on the amp
    // block does not: the hit is at the 127 cap and the editor cache's amp table runs past it.
    const unknown = Array.from({ length: 12 }, (_, id): LiveRec => ({ kind: 'float', section: 203, id, tc: 0x31, min: 0, max: 7 + id / 3, def: 1, step: 0.01, t1: 0, t2: 0 }));
    const lossyNew = { ...lossy, records: [...lossy.records, ...unknown], scope: { ...lossy.scope, blocks: [...lossy.scope.blocks, 203] } };
    const partly = deriveProfile(raw(byte, lossyNew), FM3_PARAMS, HW_SEEDS, { ...opts, catalog });
    const pg = (k: string) => partly.coverage.gaps.find((x) => x.kind === k);
    if (partly.provenance.existence['block:203'] !== lossy.id || pg('unresolved-replies')?.count !== 3 || pg('missing-slots')?.count !== 1 || pg('bound-hit') !== undefined) {
      fail(`byte + walk with an unknown block: ${JSON.stringify(partly.coverage.gaps)}`);
    }
    // A newer complete walk supersedes the lossy one: the old losses are gone with it.
    const fresh = liveSource('live-readonly', T2, liveFromBytes(byteDoc, walk, 127), { scope: lossy.scope });
    const superseded = deriveProfile(raw(lossy, fresh), FM3_PARAMS, HW_SEEDS, { ...opts, catalog });
    if (superseded.coverage.gaps.some((x) => walkKinds.includes(x.kind)) || Object.values(superseded.provenance.existence).includes(lossy.id)) {
      fail(`superseded walk: ${JSON.stringify(superseded.coverage.gaps)}`);
    }
    // A v1 document (no raw): non-blocking no-raw; sections from the tables and the inventory.
    const v1 = await buildCache({ kind: 'bytes', buf }, FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '12.0' });
    const cv = computeCoverage(v1, { sections: FM3_CATALOG_SECTIONS });
    const noRaw = cv.gaps.find((x) => x.kind === 'no-raw');
    if (!noRaw || noRaw.blocking || !cv.complete || JSON.stringify(cv.sections) !== JSON.stringify({ total: 45, assigned: 41, system: 4, new: 0, unclassified: 0 })) {
      fail(`v1 coverage ${JSON.stringify(cv)}`);
    }
    console.log(
      '  cache/merge: walk losses and a bound hit block a live-only doc (counts + eids), not when the editor cache or a newer walk provides every family; ' +
        'a walk providing only an unknown block brings its losses back, not its bound hit on a byte-provided block; ' +
        'MULTITAP instance evidence 1/2 reported; a v1 doc reports non-blocking no-raw',
    );
  }

  // ---- Case 10: suspects per source, fallback to a non-suspect copy --------------------------
  {
    // Reference with REVERB and DELAY swapped: every source that mapped them right looks suspect.
    const swapped = { ...FM3_RANGES, REVERB: FM3_RANGES['DELAY']!, DELAY: FM3_RANGES['REVERB']! };
    const swappedEo = { ...FM3_ENUM_OVERRIDES, REVERB: FM3_ENUM_OVERRIDES['DELAY']!, DELAY: FM3_ENUM_OVERRIDES['REVERB']! };
    const catalog: ProfileCatalog = { ranges: swapped, enumOverrides: swappedEo };
    const both = deriveProfile(raw(byte, liveRO), FM3_PARAMS, HW_SEEDS, { ...opts, catalog });
    const s = both.provenance.suspects;
    if (!s[byte.id]?.includes('REVERB') || !s[byte.id]?.includes('DELAY') || !s[liveRO.id]?.includes('REVERB')) fail(`suspects ${JSON.stringify(s)}`);
    if (both.provenance.existence['REVERB'] !== byte.id) fail('all copies suspect: the best-ranked stays');
    // A live copy of REVERB that matches nothing in the reference is not suspect and wins.
    const recs = liveFromBytes(byteDoc, walk).map((r) => (r.section === eid('REVERB') && r.kind === 'float' && r.max > r.min ? { ...r, max: r.max * 1.37 } : r));
    const odd = liveSource('live-readonly', T1, recs);
    const fb = deriveProfile(raw(byte, odd), FM3_PARAMS, HW_SEEDS, { ...opts, catalog });
    if (fb.provenance.suspects[odd.id]?.includes('REVERB') || fb.provenance.existence['REVERB'] !== odd.id || fb.rangeSections['REVERB']?.sectionTag !== eid('REVERB')) {
      fail(`fallback: suspects ${JSON.stringify(fb.provenance.suspects[odd.id])}, existence ${fb.provenance.existence['REVERB']}`);
    }
    // Suspect copies are not rivals: no conflict, hence no disagreement nobody could fix. Both
    // copies suspect (`both`): the altered REVERB row of the live copy is not a conflict either;
    // FORMANT, suspect nowhere, still conflicts.
    const keys = (d: DerivedProfile) => d.provenance.conflicts.map((c) => c.key).sort().join();
    const disagreeing = (d: DerivedProfile) => d.coverage.gaps.find((x) => x.kind === 'disagreement')?.families ?? [];
    if (keys(both) !== 'FORMANT' || keys(fb) !== '' || disagreeing(fb).length > 0) fail(`suspect conflicts: both ${keys(both)}, fallback ${keys(fb)} ${JSON.stringify(disagreeing(fb))}`);
    // Control without the reference: the same two copies are rivals and disagree on REVERB.
    const control = deriveProfile(raw(byte, odd), FM3_PARAMS, HW_SEEDS, opts);
    const rc = control.provenance.conflicts.find((c) => c.key === 'REVERB');
    if (!rc || !disagreeing(control).includes('REVERB')) fail(`control conflicts ${keys(control)}`);
    console.log(`  cache/merge: suspects listed per source; a suspect byte copy falls back to the non-suspect live copy; suspect copies raise no conflict (without suspects: REVERB ${rc.count} rows, disagreement)`);
  }

  // ---- Case 11: rosterDiff --------------------------------------------------------------------
  {
    const base = Array.from({ length: 10 }, (_, i) => `M${i}`);
    const appended = rosterDiff(base, [...base, 'N1', 'N2']);
    if (appended.appended.join() !== 'N1,N2' || appended.renamed.length || appended.inserted.length || appended.ordinalShift || appended.after !== 12) fail(`appended ${JSON.stringify(appended)}`);
    const renamed = rosterDiff(base, [...base.slice(0, 4), 'X4', ...base.slice(5), 'N1']);
    if (JSON.stringify(renamed.renamed) !== JSON.stringify([{ ordinal: 4, from: 'M4', to: 'X4' }]) || renamed.appended.join() !== 'N1' || renamed.ordinalShift) fail(`renamed ${JSON.stringify(renamed)}`);
    const inserted = rosterDiff(base, [...base.slice(0, 3), 'I', ...base.slice(3)]);
    if (JSON.stringify(inserted.inserted) !== JSON.stringify([{ ordinal: 3, label: 'I' }]) || !inserted.ordinalShift || inserted.appended.length) fail(`inserted ${JSON.stringify(inserted)}`);
    const removed = rosterDiff(base, [...base.slice(0, 2), ...base.slice(3)]);
    if (JSON.stringify(removed.removed) !== JSON.stringify([{ ordinal: 2, label: 'M2' }]) || !removed.ordinalShift) fail(`removed ${JSON.stringify(removed)}`);
    const trailing = rosterDiff(['A ', 'B'], ['A', 'B']);
    if (trailing.renamed.length || trailing.ordinalShift) fail('trailing whitespace is not a rename');
    console.log('  cache/merge: rosterDiff — appended, renamed (no shift), inserted / removed (shift), trailing whitespace ignored');
  }

  // ---- Case 12: same-kind live sources — an older record fills in where the newer has none ---
  {
    const revPids = floatPids('REVERB', 3);
    const dropped = revPids.slice(0, 2);
    const changed = revPids[2]!;
    const olderRecs = liveFromBytes(byteDoc, walk, 127);
    const newerRecs = liveFromBytes(byteDoc, walk, 127).filter((r) => !(r.section === eid('REVERB') && dropped.includes(r.id)));
    at(newerRecs, eid('REVERB'), changed).max += 2;
    const older = liveSource('live-readonly', T1, olderRecs);
    const newer = liveSource('live-readonly', T2, newerRecs);
    const doc = deriveProfile(raw(older, newer), FM3_PARAMS, HW_SEEDS, opts);
    const oldOnly = deriveProfile(raw(older), FM3_PARAMS, HW_SEEDS, opts);
    const newOnly = deriveProfile(raw(newer), FM3_PARAMS, HW_SEEDS, opts);
    for (const p of dropped) {
      if (newOnly.ranges['REVERB']![p] !== undefined) fail(`the newer walk must lack REVERB[${p}]`);
      if (JSON.stringify(doc.ranges['REVERB']![p]) !== JSON.stringify(oldOnly.ranges['REVERB']![p])) fail(`REVERB[${p}] must fall back to the older walk`);
    }
    if (doc.ranges['REVERB']![changed]!.displayMax !== newOnly.ranges['REVERB']![changed]!.displayMax || doc.ranges['REVERB']![changed]!.displayMax === oldOnly.ranges['REVERB']![changed]!.displayMax) {
      fail(`REVERB[${changed}]: the newer walk wins where it has a record`);
    }
    if (doc.rangeSections['REVERB']!.stride !== oldOnly.rangeSections['REVERB']!.stride) fail('the fallback keeps the stride');
    console.log(`  cache/merge: two read-only walks — REVERB ${dropped.join('/')} missing in the newer one come from the older, REVERB[${changed}] from the newer`);
  }

  // ---- Case 13: capture order by instant; unique source ids ---------------------------------
  {
    // 10:00 at +02:00 is 08:00Z — older than 09:00Z, although its text sorts later.
    const stale = liveFromBytes(byteDoc, walk, 127);
    at(stale, eid('DISTORT'), 5).max += 3;
    const a = liveSource('live-readonly', '2026-11-22T10:00:00+02:00', stale);
    const b = liveSource('live-readonly', '2026-11-22T09:00:00Z', liveFromBytes(byteDoc, walk, 127));
    const byInstant = deriveProfile(raw(a, b), FM3_PARAMS, HW_SEEDS, opts);
    if (byInstant.ranges['DISTORT']![5]!.displayMax !== byteDoc.ranges['DISTORT']![5]!.displayMax || byInstant.provenance.existence['DISTORT'] !== b.id) fail('capture order must follow the instant, not the text');
    // A sub-second stamp is newer than the same second without one.
    const c = liveSource('live-readonly', '2026-11-22T09:00:00.500Z', stale);
    if (deriveProfile(raw(b, c), FM3_PARAMS, HW_SEEDS, opts).ranges['DISTORT']![5]!.displayMax === byteDoc.ranges['DISTORT']![5]!.displayMax) fail('09:00:00.500Z is newer than 09:00:00Z');
    // Two sources without a capture time share an id until `uniqueSourceIds` numbers them.
    const undated = (recs: LiveRec[]): LiveRawSource => ({ ...liveSource('live-readonly', T1, recs), capturedAt: null, id: rawSourceId('live-readonly', null) });
    const u1 = undated(liveFromBytes(byteDoc, walk, 127));
    const u2 = undated(liveFromBytes(byteDoc, walk, 127));
    let code = 'none';
    try {
      deriveProfile(raw(u1, u2), FM3_PARAMS, HW_SEEDS, opts);
    } catch (e) {
      code = e instanceof ProfileDerivationError ? e.code : String(e);
    }
    const fixed = uniqueSourceIds([u1, u2]);
    if (code !== 'duplicate-source-id' || fixed[0] !== u1 || fixed[1]!.id !== 'live-readonly@unknown#1' || u2.id !== 'live-readonly@unknown#0') fail(`unique ids: ${code} ${fixed.map((s) => s.id).join()}`);
    deriveProfile(raw(...fixed), FM3_PARAMS, HW_SEEDS, opts);
    // A renamed duplicate never takes an id a later source carries.
    const u3 = { ...u1, id: rawSourceId('live-readonly', null, 1) };
    if (uniqueSourceIds([u1, u2, u3]).map((s) => s.id.slice(-2)).join() !== '#0,#2,#1') fail('a renamed duplicate must skip ids in use');
    console.log('  cache/merge: capture order by instant (offsets, sub-seconds), not text; undated sources numbered #0/#1 by uniqueSourceIds (duplicates rejected otherwise)');
  }

  // ---- Case 14: coverage of v1 documents by source class; addressable families ---------------
  {
    const catalog: ProfileCatalog = {
      firmware: '12.0',
      ranges: FM3_RANGES,
      enumOverrides: FM3_ENUM_OVERRIDES,
      rosters: Object.fromEntries(Object.entries(byteDoc.rosters)),
      familyFirstEid: FM3_EFFECT_IDS,
    };
    // A live-only document on newer firmware, stored as a v1 document from the cloud.
    const lv = deriveProfile(raw(liveSource('live-readonly', T1, liveFromBytes(byteDoc, walk, 127).filter((r) => r.section <= 160), { firmware: '13.0' })), FM3_PARAMS, HW_SEEDS, { ...opts, firmware: '13.0' });
    const v1 = (source: string, origin?: string) =>
      ({
        enumOverrides: lv.enumOverrides,
        ranges: lv.ranges,
        rangeSections: lv.rangeSections,
        rosters: lv.rosters,
        cabIrs: lv.cabIrs,
        unmappedSections: lv.unmappedSections,
        unmappedFamilies: lv.unmappedFamilies,
        model: 0x11,
        firmware: '13.0',
        meta: { schema: 1, recordCount: lv.meta.recordCount, source, ...(origin !== undefined ? { origin } : {}) },
      }) as unknown as BuiltCache;
    const liveGaps = (d: BuiltCache) => computeCoverage(d, catalog).gaps.filter((g) => g.kind === 'blocks-above-160' || g.kind === 'rosters').length;
    const classes: Array<[string, string | undefined, boolean]> = [
      ['cloud', 'live', true],
      ['axisdefs', 'live', true],
      ['live', undefined, true],
      ['cloud', 'bytes', false],
      ['editor-cache', undefined, false],
      ['bytes', undefined, false],
    ];
    for (const [source, origin, isLive] of classes) {
      if ((liveGaps(v1(source, origin)) > 0) !== isLive) fail(`v1 ${source}/${origin}: treated as ${isLive ? 'byte' : 'live'}`);
    }
    // Without effect ids PRESET (no effect id) never counts as addressable: the families a live walk
    // read at a block address do (byte + live), a v1 byte document has none to tell.
    const withEids = computeCoverage({ ...merged, raw: raw(byte, liveRO) }, { familyFirstEid: FM3_EFFECT_IDS });
    const presetToo = computeCoverage({ ...merged, raw: raw(byte, liveRO) }, { familyFirstEid: { ...FM3_EFFECT_IDS, PRESET: 0 } });
    if (presetToo.highIds.expected <= withEids.highIds.expected) fail('fixture: PRESET must have informative rows above 127');
    if (merged.coverage.highIds.expected !== withEids.highIds.expected) fail(`byte + live without effect ids: ${merged.coverage.highIds.expected}, with: ${withEids.highIds.expected}`);
    const v1Byte = await buildCache({ kind: 'bytes', buf }, FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '12.0' });
    const cvb = computeCoverage(v1Byte, {});
    if (cvb.highIds.expected !== 0 || cvb.gaps.some((g) => g.kind === 'high-ids' || g.kind === 'far-ids')) fail(`v1 byte doc without effect ids: ${JSON.stringify(cvb.highIds)}`);
    console.log(
      `  cache/merge: v1 docs from cloud / definitions file take their class from meta.origin; high ids without effect ids: ${merged.coverage.highIds.expected} ` +
        `(= with effect ids; PRESET would add ${presetToo.highIds.expected - withEids.highIds.expected})`,
    );
  }

  // ---- Case 15: bound hits of a real walk — the read-only cap vs a known-size ceiling ----------
  {
    // Every fixture family at its FM3 effect ids (instances consecutive), ALL its ids on the fake
    // device; a standard read-only walk to the 127 cap, REVERB with a known size it outgrew (40).
    const recs: CacheRecord[] = [];
    for (const [fam, meta] of Object.entries(byteDoc.rangeSections)) {
      const first = FM3_EFFECT_IDS[fam];
      if (isSyntheticFamilyKey(fam) || first == null) continue;
      (meta.instanceTags ?? [meta.sectionTag]).forEach((tag, i) => {
        for (const r of walk.records) if (r.section === tag && r.id < 0xff00) recs.push({ ...r, section: first + i });
      });
    }
    const blocks = [...new Set(recs.map((r) => r.section))].sort((x, y) => x - y);
    const dev = cacheDevice(recs);
    const o: LiveWalkOptions = { model: 0x11, blocks, maxParamId: 127, paramKnownSizeByBlock: { [eid('REVERB')]: 40 }, readValues: false, sleep: dev.sleep };
    const res = await liveWalkDetailed(dev, o);
    const hitAt = (res.boundHits ?? []).map((h) => `${h.block}@${h.bound}`).join();
    // GLOBAL, CONTROLLERS and DISTORT run past the cap; REVERB (71 rows) reaches its 40 - 1 + 32 ceiling.
    if (hitAt !== `${eid('GLOBAL')}@127,${eid('CONTROLLERS')}@127,${eid('DISTORT')}@127,${eid('REVERB')}@71`) fail(`walk bound hits ${hitAt}`);
    const src = rawFromLiveWalk(res, liveWalkScope(o, { hinted: false }), { kind: 'live-readonly', capturedAt: T1, firmware: '12.0' });
    const limits = { INPUT: 2, OUTPUT: 2 };
    const catalog: ProfileCatalog = { firmware: '12.0', ranges: FM3_RANGES, enumOverrides: FM3_ENUM_OVERRIDES, familyFirstEid: FM3_EFFECT_IDS, instanceLimits: limits, sections: FM3_CATALOG_SECTIONS };
    const doc = deriveProfile(raw(src), FM3_PARAMS, HW_SEEDS, { ...opts, catalog });
    const g = (d: DerivedProfile, k: string) => d.coverage.gaps.find((x) => x.kind === k);
    // The cap hits sit inside tables the catalog knows to run on: the high-ids gap covers them (not
    // blocking on the catalog firmware). REVERB's ceiling came from a known size: blocking.
    const hit = g(doc, 'bound-hit');
    if (!hit?.blocking || hit.eids?.join() !== String(eid('REVERB')) || doc.coverage.walk?.boundHits !== 1) fail(`bound-hit ${JSON.stringify(hit)} walk ${JSON.stringify(doc.coverage.walk)}`);
    const high = g(doc, 'high-ids');
    if (!high || high.blocking || !high.families?.includes('DISTORT') || !high.families.includes('CONTROLLERS')) fail(`high-ids ${JSON.stringify(high)}`);
    // On newer firmware the high ids block (read-extended); the cap hits still raise no bound-hit.
    const newer = deriveProfile(raw({ ...src, firmware: '13.0' }), FM3_PARAMS, HW_SEEDS, { ...opts, firmware: '13.0', catalog });
    if (!g(newer, 'high-ids')?.blocking || g(newer, 'bound-hit')?.eids?.join() !== String(eid('REVERB'))) fail(`newer firmware ${JSON.stringify(newer.coverage.gaps)}`);
    // No reference table: nothing explains the cap hits, they block too.
    const bare = deriveProfile(raw(src), FM3_PARAMS, HW_SEEDS, { ...opts, catalog: { familyFirstEid: FM3_EFFECT_IDS, instanceLimits: limits } });
    const want = [eid('GLOBAL'), eid('CONTROLLERS'), eid('DISTORT'), eid('REVERB')].join();
    if (!g(bare, 'bound-hit')?.blocking || g(bare, 'bound-hit')?.eids?.join() !== want) fail(`no reference: ${JSON.stringify(g(bare, 'bound-hit'))}`);
    console.log(
      `  cache/merge: real walk — bound hits ${hitAt}; the 127-cap hits inside catalog tables raise no bound-hit (non-blocking high-ids on the catalog firmware, blocking on 13.0), ` +
        `REVERB's known-size ceiling blocks; without a reference table all ${hitAt.split(',').length} block`,
    );
  }
}
