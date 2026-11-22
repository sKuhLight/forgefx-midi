/**
 * Block map: live blocks the catalog cannot place, bound to editor-cache sections by their rows.
 *
 * - leave-one-out on catalog data: RESONATOR removed from the FM3 catalog leaves its fixture section
 *   unassigned (with the section inventory a section only takes the family the inventory lists for
 *   it); a synthetic live block 162 made from the same rows is `confirmed` to it (also with enums
 *   read as floats, as a walk without label hints reads them; also from a probe), its rows join
 *   `section:<tag>` (units attach), no `block:162` family is left; the same for FDBKRET probed at
 *   186. Only the parity option `unrestrictedLiveVote` gives the unrestricted live vote
 *   (`buildCache` parity), where the block is claimed by an unrelated family;
 * - a probe prefix: probedTo 127 (the probe cap) on a 150-row table confirms; a scope claiming more
 *   than the live rows show, or one altered row, does not;
 * - two identical candidate sections -> `candidate` with both tags; live-only -> `block:<eid>`;
 * - instances: two effect ids confirm one section;
 * - runtime bulk shape: unique stride -> `likely` (+ channels), enum ordinal out of bounds -> none,
 *   two fitting sections -> candidates, assigned sections never take part, a catalog family without
 *   an effect id takes part (same rule as the block map);
 * - matcher vectors: tuple equality with kind flips, the min-rows rule, the table-end rule (probedTo
 *   past the section's end, or a cap inside it; bound hits; unknown extent), roster hints;
 * - the restricted live vote: hiding each FM3 family in turn, no other family claims its probed
 *   block and the block confirms to its section (the inventory keeps the section free); a block
 *   above 160 is never given a family whose effect-id span does not hold it; on a walk in
 *   block-address space the restriction changes nothing (equals `buildCache(live)`); without a
 *   catalog the model's own spans apply, a host's spans win, and without either nothing is assigned;
 * - identical unassigned blocks form one `block:<eid>` family with instance tags; a family keeps its
 *   own block when an identical lower block lies outside its span; higher copies follow it;
 * - the editor-cache vote with an inventory: a float-heavy new table and near-copies of catalog
 *   tables at an unlisted tag stay `section:<tag>` (role `new`, `new-section` gap); no family moves;
 * - real walks: a probe that stops at the section's last pid, one that reads past it into more rows,
 *   a walk whose scope does not list the block, a walk that hits its ceiling, and a 2-row section
 *   whose rows open another table: none confirms; the table itself probed past its end does.
 *
 * Public data only: the committed walk fixture, committed catalogs, synthetic records.
 */
import {
  BLOCK_MAP_MIN_ROWS,
  buildCache,
  cacheRecordOf,
  compareBlockRows,
  deriveProfile,
  effectIdOwners,
  effectIdSpansForModel,
  HW_SEEDS,
  isSyntheticFamilyKey,
  liveWalkDetailed,
  liveWalkScope,
  matchBlocks,
  matchBulkShape,
  rawFromCacheBytes,
  rawFromLiveWalk,
  rowTuple,
  sectionSignatureRows,
  tuplesMatch,
} from '../../src/cache/index.js';
import type {
  BlockMapEntry,
  DerivedProfile,
  DerivedSection,
  EditorCacheRawSource,
  LiveRawSource,
  LiveWalkOptions,
  ProfileCatalog,
  ProfileRaw,
  RawSource,
} from '../../src/cache/index.js';
import type { CacheRecord, CacheWalk, EnumRecord, FloatRecord, RangeDef } from '../../src/cache/types.js';
import { FM3_CATALOG_SECTIONS, FM3_EFFECT_IDS, FM3_PARAMS } from '../../src/gen3/fm3/index.js';
import { VERSION } from '../../src/version.js';
import { cacheDevice } from './cacheDevice.js';
import { fixtureBytes, loadWalk, v1Differences } from './profile-doc.test.js';

export const BLOCK_MAP_CASE_COUNT = 16;

type LiveRec = LiveRawSource['records'][number];

const raw = (...sources: RawSource[]): ProfileRaw => ({ format: 1, sources });
const T0 = '2026-11-20T10:00:00Z';
const T1 = '2026-11-21T10:00:00Z';

/** The family left out of the catalog, its fixture section and its FM3 effect id. */
const HIDDEN = 'RESONATOR';
const HID_TAG = 39;
const HID_EID = 162;
/** A second one above eid 160 (probe only). */
const HIDDEN_HIGH = 'FDBKRET';
const HIGH_TAG = 30;
const HIGH_EID = 186;
const NEW_TAG = 60;
const NEW_EID = 203;

function liveSource(kind: LiveRawSource['kind'], capturedAt: string, records: LiveRec[], scope?: Partial<LiveRawSource['scope']>): LiveRawSource {
  return {
    id: `${kind}@${capturedAt}#0`,
    kind,
    origin: 'local',
    capturedAt,
    firmware: '12.0',
    codecVersion: VERSION,
    space: 'block',
    scope: {
      blocks: [...new Set(records.map((r) => r.section))].sort((a, b) => a - b),
      maxParamId: 127,
      bounds: {},
      extended: false,
      above160: false,
      hinted: true,
      ...scope,
    },
    walk: { queries: 0, lostReplies: 0, recoveredReplies: 0, unresolvedReplies: 0, placeholderSlots: 0, missingSlots: 0, silentAddresses: 0, boundHits: [] },
    records,
  };
}

/** A walk record as a live walk reads it at block `eid` (no byte position, no name spans), a unit on continuous floats. */
function asLive(r: CacheRecord, eid: number): LiveRec {
  const { offset: _o, ...rest } = r as CacheRecord & { nameSpans?: unknown };
  delete (rest as { nameSpans?: unknown }).nameSpans;
  const rec = { ...rest, section: eid } as LiveRec;
  if (rec.kind === 'float' && rec.max > rec.min && rec.tc !== 0x52) rec.unit = 'dB';
  return rec;
}

/** Records of one section of a walk at a live block (ordinary ids up to `maxId`). */
function sectionAsLive(records: readonly CacheRecord[], tag: number, eid: number, maxId = 127): LiveRec[] {
  return records.filter((r) => r.section === tag && r.id < 0xff00 && r.id <= maxId).map((r) => asLive(r, eid));
}

/** The seeded core blocks at their FM3 effect ids (a read-only walk always has them). */
function coreLive(walk: CacheWalk): LiveRec[] {
  return Object.entries(HW_SEEDS).flatMap(([fam, tag]) => sectionAsLive(walk.records, tag, FM3_EFFECT_IDS[fam]!));
}

/** An enum read as a float (typecode and numbers kept). */
function flipped(r: LiveRec): LiveRec {
  return { kind: 'float', section: r.section, id: r.id, tc: r.tc, min: r.min, max: r.max, def: r.def, step: r.step, t1: 0, t2: 0 };
}

/** A synthetic parameter table no catalog family matches: `n` rows, enums and floats interleaved. */
function newTable(tag: number, n: number): CacheRecord[] {
  const out: CacheRecord[] = [];
  for (let id = 0; id < n; id++) {
    if (id % 2 === 0) {
      const e: EnumRecord = { kind: 'enum', section: tag, offset: 0, id, tc: 0x10, min: 0, max: 2, def: 0, step: 0, count: 3, values: ['Lo', 'Mid', 'Hi'], x: 0 };
      out.push(e);
    } else {
      const f: FloatRecord = { kind: 'float', section: tag, offset: 0, id, tc: 0x31, min: 0, max: 10 + id / 4, def: 1, step: 0.01, t1: 0, t2: 0 };
      out.push(f);
    }
  }
  return out;
}

/** The fixture walk with extra sections appended. */
function grownWalk(walk: CacheWalk, extra: Array<{ tag: number; records: CacheRecord[] }>): CacheWalk {
  return {
    sections: [...walk.sections, ...extra.map((x) => ({ index: x.tag, count: x.records.length, offset: 0, records: x.records.length }))],
    records: [...walk.records, ...extra.flatMap((x) => x.records)],
  };
}

const entryOf = (doc: DerivedProfile, eid: number): BlockMapEntry | undefined => doc.blockMap.find((e) => e.eid === eid);

function rowsOfDoc(doc: DerivedProfile): (tag: number) => ReadonlyMap<number, RangeDef> {
  return (tag) => new Map(Object.entries(doc.ranges[`section:${tag}`] ?? {}).map(([p, r]) => [Number(p), r]));
}

export async function runBlockMap(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[cache/block-map] ${msg}`);
  };
  const walk = loadWalk('fm3-12p0.walk.json');
  const byte = await rawFromCacheBytes(fixtureBytes(walk, 12, 0), { capturedAt: T0, firmware: '12.0' });

  // RESONATOR (HIDDEN) left out of the catalog: params, effect ids.
  const hiddenParams = FM3_PARAMS.filter((p) => p.family !== HIDDEN);
  const hiddenCatalog: ProfileCatalog = {
    familyFirstEid: Object.fromEntries(Object.entries(FM3_EFFECT_IDS).filter(([f]) => f !== HIDDEN)),
    sections: FM3_CATALOG_SECTIONS,
  };
  const opts = { model: 0x11, firmware: '12.0', catalogSections: FM3_CATALOG_SECTIONS, catalog: hiddenCatalog };
  const byteOnly = deriveProfile(raw(byte), hiddenParams, HW_SEEDS, opts);
  const hidSection = byteOnly.sections.find((s) => s.tag === HID_TAG);
  if (!hidSection || hidSection.family !== null || hidSection.key !== `section:${HID_TAG}`) fail(`leave-one-out: section ${HID_TAG} ${JSON.stringify(hidSection)}`);
  if (byteOnly.blockMap.length !== 0) fail('an editor cache alone has no block to map');
  const hidRows = sectionAsLive(walk.records, HID_TAG, HID_EID);
  const hidInformative = Object.values(byteOnly.ranges[`section:${HID_TAG}`]!).filter((r) => r.displayMax > r.displayMin).length;

  // ---- Case 1: leave-one-out — live block 162 confirmed to the RESONATOR section -------------
  {
    const live = liveSource('live-readonly', T1, [...coreLive(walk), ...hidRows]);
    const doc = deriveProfile(raw(byte, live), hiddenParams, HW_SEEDS, opts);
    const e = entryOf(doc, HID_EID);
    if (!e || e.confidence !== 'confirmed' || e.key !== `section:${HID_TAG}` || e.sectionTag !== HID_TAG || e.evidence.join() !== 'device-records' || e.channels !== null) {
      fail(`block ${HID_EID} ${JSON.stringify(e)}`);
    }
    if (!e.compared || e.compared.rows !== e.compared.equal || e.compared.probedTo !== 127 || e.compared.rows < hidInformative) fail(`compared ${JSON.stringify(e.compared)}`);
    if (doc.ranges[`block:${HID_EID}`] !== undefined) fail('a byte-bridged block keeps no block:<eid> family');
    const key = `section:${HID_TAG}`;
    const merged = doc.ranges[key]!;
    let units = 0;
    for (const [p, row] of Object.entries(byteOnly.ranges[key]!)) {
      const m = merged[Number(p)]!;
      const { unit, ...rest } = m;
      if (JSON.stringify(rest) !== JSON.stringify(row)) fail(`${key}[${p}] changed beyond the unit`);
      if (unit !== undefined) units += 1;
    }
    if (units === 0 || doc.provenance.existence[key] !== byte.id || (doc.provenance.units[live.id] ?? 0) < units) fail(`units on ${key}: ${units}, provenance ${JSON.stringify(doc.provenance.units)}`);
    if (doc.provenance.conflicts.some((c) => c.key === key)) fail('a confirmed block has no conflicting rows');
    const blk = doc.sections.find((s) => s.space === 'block' && s.tag === HID_EID);
    if (!blk || blk.key !== key || blk.family !== null) fail(`block section ${JSON.stringify(blk)}`);
    // With effect ids in the catalog the live vote never gives block 162 a family (no span holds
    // it). Only the parity option gives the unrestricted vote of `buildCache`: an unrelated family
    // claims the block, and only the voter's unassigned blocks reach the map, so nothing is mapped.
    const voterOnly = deriveProfile(raw(byte, live), hiddenParams, HW_SEEDS, { model: 0x11, firmware: '12.0', catalogSections: FM3_CATALOG_SECTIONS, unrestrictedLiveVote: true });
    const guess = voterOnly.sections.find((s) => s.space === 'block' && s.tag === HID_EID)?.family;
    if (!guess || entryOf(voterOnly, HID_EID) !== undefined) fail(`voter-only path: guess ${guess}, entry ${JSON.stringify(entryOf(voterOnly, HID_EID))}`);
    if (doc.sections.some((s) => s.space === 'block' && s.family === guess && s.tag === HID_EID)) fail(`the restricted vote gave block ${HID_EID} to ${guess}`);
    // The editor-cache side: with the inventory no other family may take the listed section.
    if (byteOnly.sections.find((s) => s.space === 'section' && s.tag === HID_TAG)?.family !== null) fail('byte section stolen');
    // Control: the family known to the catalog -> its block is placed, nothing to map.
    const known = deriveProfile(raw(byte, live), FM3_PARAMS, HW_SEEDS, { ...opts, catalog: { familyFirstEid: FM3_EFFECT_IDS } });
    if (known.blockMap.length !== 0 || known.ranges[HIDDEN] === undefined || known.rangeSections[HIDDEN]?.sectionTag !== HID_TAG) fail(`catalog-known control: ${JSON.stringify(known.blockMap)}`);
    console.log(`  cache/block-map: ${HIDDEN} hidden — live block ${HID_EID} confirmed to section ${HID_TAG} (${e.compared.equal}/${e.compared.rows} rows to pid 127), ${units} units attached, no block:${HID_EID} family; unrestricted (parity option) the block goes to ${guess}`);
  }

  // ---- Case 2: kind flips (enums read as floats) still confirm; a probe confirms alone -------
  {
    const enums = hidRows.filter((r) => r.kind === 'enum').slice(0, 2);
    if (enums.length === 0) fail(`fixture: ${HIDDEN} has no enum row to flip`);
    const flippedRows = hidRows.map((r) => (enums.includes(r) ? flipped(r) : r));
    const live = liveSource('live-readonly', T1, [...coreLive(walk), ...flippedRows]);
    const doc = deriveProfile(raw(byte, live), hiddenParams, HW_SEEDS, opts);
    const e = entryOf(doc, HID_EID);
    if (e?.confidence !== 'confirmed' || e.compared?.rows !== e.compared?.equal) fail(`kind flips: ${JSON.stringify(e)}`);
    for (const r of enums) if (doc.ranges[`section:${HID_TAG}`]![r.id]!.kind !== 'enum') fail('the byte row keeps its kind');
    const probe = liveSource('live-probe', T1, hidRows);
    const pdoc = deriveProfile(raw(byte, probe), hiddenParams, HW_SEEDS, opts);
    const pe = entryOf(pdoc, HID_EID);
    if (pe?.confidence !== 'confirmed' || pe.key !== `section:${HID_TAG}` || pdoc.ranges[`block:${HID_EID}`] !== undefined) fail(`probe: ${JSON.stringify(pe)}`);
    // Above eid 160: FDBKRET left out, its section probed at 186.
    const highParams = FM3_PARAMS.filter((p) => p.family !== HIDDEN_HIGH);
    const highCatalog: ProfileCatalog = { familyFirstEid: Object.fromEntries(Object.entries(FM3_EFFECT_IDS).filter(([f]) => f !== HIDDEN_HIGH)) };
    const hdoc = deriveProfile(raw(byte, liveSource('live-probe', T1, sectionAsLive(walk.records, HIGH_TAG, HIGH_EID))), highParams, HW_SEEDS, { ...opts, catalog: highCatalog });
    const he = entryOf(hdoc, HIGH_EID);
    if (he?.confidence !== 'confirmed' || he.key !== `section:${HIGH_TAG}` || he.compared?.rows !== he.compared?.equal) fail(`probe at ${HIGH_EID}: ${JSON.stringify(he)}`);
    console.log(`  cache/block-map: ${enums.length} enums read as floats still confirm (byte kind kept); probes of block ${HID_EID} and of ${HIDDEN_HIGH} at ${HIGH_EID} confirm alone`);
  }

  // A 150-row table the catalog does not know, appended to the fixture.
  const big = newTable(NEW_TAG, 150);
  const bigByte = await rawFromCacheBytes(fixtureBytes(grownWalk(walk, [{ tag: NEW_TAG, records: big }]), 12, 0), { capturedAt: T0, firmware: '12.0' });
  const fm3Opts = { model: 0x11, firmware: '12.0', catalogSections: FM3_CATALOG_SECTIONS, catalog: { familyFirstEid: FM3_EFFECT_IDS, sections: FM3_CATALOG_SECTIONS } };

  // ---- Case 3: probe prefix — probedTo 127 on a 150-row table -------------------------------
  {
    const prefix = sectionAsLive(big, NEW_TAG, NEW_EID, 127);
    const doc = deriveProfile(raw(bigByte, liveSource('live-probe', T1, prefix)), FM3_PARAMS, HW_SEEDS, fm3Opts);
    const sec = doc.sections.find((s) => s.space === 'section' && s.tag === NEW_TAG);
    if (sec?.role !== 'new') fail(`new section ${JSON.stringify(sec)}`);
    const e = entryOf(doc, NEW_EID);
    if (e?.confidence !== 'confirmed' || e.key !== `section:${NEW_TAG}` || e.compared?.probedTo !== 127 || e.compared.rows !== 128 || e.compared.equal !== 128) fail(`prefix: ${JSON.stringify(e)}`);
    if (doc.ranges[`block:${NEW_EID}`] !== undefined || Object.keys(doc.ranges[`section:${NEW_TAG}`] ?? {}).length !== 150) fail('prefix: rows under the section, all 150');
    // A scope that claims ids 128..140 were walked: the section's rows there have no live row.
    const claimed = deriveProfile(raw(bigByte, liveSource('live-probe', T1, prefix, { bounds: { [NEW_EID]: 140 } })), FM3_PARAMS, HW_SEEDS, fm3Opts);
    const c = entryOf(claimed, NEW_EID);
    if (c?.confidence !== 'candidate' || c.key !== null || c.candidates?.length !== 0 || claimed.ranges[`block:${NEW_EID}`] === undefined) fail(`claimed 140: ${JSON.stringify(c)}`);
    // One altered row inside the probed range.
    const altered = prefix.map((r) => (r.id === 41 ? { ...r, max: r.max + 1 } : r));
    const a = entryOf(deriveProfile(raw(bigByte, liveSource('live-probe', T1, altered)), FM3_PARAMS, HW_SEEDS, fm3Opts), NEW_EID);
    if (a?.confidence !== 'candidate' || a.candidates?.length !== 0) fail(`altered row: ${JSON.stringify(a)}`);
    console.log(`  cache/block-map: probe to pid 127 of a 150-row new section confirms (128/128); a scope claiming 140, or one altered row, does not`);
  }

  // Two identical small new sections.
  const twin = (tag: number) => newTable(tag, 20);
  const twinByte = await rawFromCacheBytes(
    fixtureBytes(grownWalk(walk, [{ tag: NEW_TAG, records: twin(NEW_TAG) }, { tag: NEW_TAG + 1, records: twin(NEW_TAG + 1) }]), 12, 0),
    { capturedAt: T0, firmware: '12.0' },
  );

  // ---- Case 4: two identical candidate sections -> candidates --------------------------------
  {
    const doc = deriveProfile(raw(twinByte, liveSource('live-probe', T1, sectionAsLive(twin(NEW_TAG), NEW_TAG, NEW_EID))), FM3_PARAMS, HW_SEEDS, fm3Opts);
    const e = entryOf(doc, NEW_EID);
    if (e?.confidence !== 'candidate' || e.key !== null || e.sectionTag !== null || e.candidates?.join() !== `${NEW_TAG},${NEW_TAG + 1}`) fail(`twins: ${JSON.stringify(e)}`);
    if (doc.ranges[`block:${NEW_EID}`] === undefined) fail('an unbridged block keeps its block:<eid> family');
    console.log(`  cache/block-map: two identical sections ${NEW_TAG}/${NEW_TAG + 1} -> candidate [${e.candidates!.join(', ')}], block:${NEW_EID} kept`);
  }

  // ---- Case 5: live-only -> block:<eid> ------------------------------------------------------
  {
    const live = liveSource('live-readonly', T1, [...coreLive(walk), ...sectionAsLive(twin(NEW_TAG), NEW_TAG, NEW_EID)]);
    const doc = deriveProfile(raw(live), FM3_PARAMS, HW_SEEDS, fm3Opts);
    const e = entryOf(doc, NEW_EID);
    if (e?.confidence !== 'confirmed' || e.key !== `block:${NEW_EID}` || e.sectionTag !== null || e.evidence.join() !== 'live-only' || e.compared !== undefined) fail(`live-only: ${JSON.stringify(e)}`);
    if (Object.keys(doc.ranges[`block:${NEW_EID}`] ?? {}).length !== 20) fail('live-only rows under block:<eid>');
    if (doc.blockMap.some((x) => x.eid !== NEW_EID)) fail(`live-only: only the unplaced block is mapped, got ${doc.blockMap.map((x) => x.eid).join()}`);
    console.log(`  cache/block-map: no editor cache — block ${NEW_EID} confirmed live-only as block:${NEW_EID} (read-only for consumers)`);
  }

  // ---- Case 6: instances — two effect ids confirm one section --------------------------------
  {
    const live = liveSource('live-readonly', T1, [...coreLive(walk), ...hidRows, ...sectionAsLive(walk.records, HID_TAG, HID_EID + 1)]);
    const doc = deriveProfile(raw(byte, live), hiddenParams, HW_SEEDS, opts);
    const key = `section:${HID_TAG}`;
    for (const eid of [HID_EID, HID_EID + 1]) {
      const e = entryOf(doc, eid);
      if (e?.confidence !== 'confirmed' || e.key !== key) fail(`instance ${eid}: ${JSON.stringify(e)}`);
      if (doc.ranges[`block:${eid}`] !== undefined || doc.sections.find((s) => s.space === 'block' && s.tag === eid)?.key !== key) fail(`instance ${eid}: tables`);
    }
    console.log(`  cache/block-map: instances — blocks ${HID_EID} and ${HID_EID + 1} both confirmed to ${key}`);
  }

  // ---- Case 7: runtime bulk shape ------------------------------------------------------------
  {
    const rowsOf = rowsOfDoc(byteOnly);
    const stride = hidSection!.stride;
    const one = matchBulkShape(stride, new Map(), byteOnly.sections, rowsOf);
    if (one.confidence !== 'likely' || one.sectionTag !== HID_TAG || one.channels !== false) fail(`bulk stride: ${JSON.stringify(one)}`);
    const enumPid = Number(Object.entries(byteOnly.ranges[`section:${HID_TAG}`]!).find(([, r]) => r.kind === 'enum')![0]);
    const count = byteOnly.ranges[`section:${HID_TAG}`]![enumPid]!.enumCount!;
    // Four channel slices; channel C's enum value in range.
    const four = matchBulkShape(4 * stride, new Map([[2 * stride + enumPid, count - 1]]), byteOnly.sections, rowsOf);
    if (four.confidence !== 'likely' || four.sectionTag !== HID_TAG || four.channels !== true) fail(`bulk 4 x stride: ${JSON.stringify(four)}`);
    const out = matchBulkShape(4 * stride, new Map([[3 * stride + enumPid, count + 5]]), byteOnly.sections, rowsOf);
    if (out.confidence !== 'candidate' || out.sectionTag !== null || out.candidates?.length !== 0) fail(`ordinal out of bounds: ${JSON.stringify(out)}`);
    const delay = byteOnly.rangeSections['DELAY']!.stride;
    const assigned = matchBulkShape(delay, new Map(), byteOnly.sections, rowsOf);
    if (assigned.confidence !== 'candidate' || assigned.candidates?.length !== 0) fail(`assigned sections take no part: ${JSON.stringify(assigned)}`);
    const twinDoc = deriveProfile(raw(twinByte), FM3_PARAMS, HW_SEEDS, fm3Opts);
    const tie = matchBulkShape(20, new Map(), twinDoc.sections, rowsOfDoc(twinDoc));
    if (tie.confidence !== 'candidate' || tie.candidates?.join() !== `${NEW_TAG},${NEW_TAG + 1}` || tie.channels !== false) fail(`bulk tie: ${JSON.stringify(tie)}`);
    // A catalog family without an effect id (FORMANT left out of the effect ids) takes part as in the
    // block map — only when the caller passes the effect ids that say so.
    const noEidFirst = Object.fromEntries(Object.entries(FM3_EFFECT_IDS).filter(([f]) => f !== 'FORMANT'));
    const fdoc = deriveProfile(raw(byte), FM3_PARAMS, HW_SEEDS, { ...opts, catalog: { familyFirstEid: noEidFirst, sections: FM3_CATALOG_SECTIONS } });
    const fSec = fdoc.sections.find((s) => s.space === 'section' && s.key === 'FORMANT')!;
    const byKey = (tag: number) => {
      const key = fdoc.sections.find((s) => s.space === 'section' && s.tag === tag)?.key ?? '';
      return new Map(Object.entries(fdoc.ranges[key] ?? {}).map(([p, r]) => [Number(p), r]));
    };
    const named = matchBulkShape(fSec.stride, new Map(), fdoc.sections, byKey, { familyFirstEid: noEidFirst });
    const unnamed = matchBulkShape(fSec.stride, new Map(), fdoc.sections, byKey);
    if (named.confidence !== 'likely' || named.sectionTag !== fSec.tag || unnamed.confidence !== 'candidate' || unnamed.candidates?.length !== 0) {
      fail(`bulk shape of a family without an effect id: ${JSON.stringify(named)} / ${JSON.stringify(unnamed)}`);
    }
    console.log(
      `  cache/block-map: bulk shape — stride ${stride} likely (channels at ${4 * stride}), ordinal out of bounds -> none, assigned sections ignored, twin strides -> candidates, ` +
        `FORMANT without an effect id likely to its section ${fSec.tag}`,
    );
  }

  // ---- Case 8: tuple equality and the min-rows rule ------------------------------------------
  {
    const f: FloatRecord = { kind: 'float', section: 1, offset: 0, id: 0, tc: 0x10, min: 0, max: 2, def: 0, step: 0, t1: 0, t2: 0 };
    const e: EnumRecord = { kind: 'enum', section: 1, offset: 0, id: 0, tc: 0x10, min: 0, max: 2, def: 0, step: 0, count: 3, values: ['a', 'b', 'c'], x: 0 };
    const e4: EnumRecord = { ...e, max: 3, count: 4, values: ['a', 'b', 'c', 'd'] };
    if (!tuplesMatch(rowTuple(f), rowTuple(e)) || tuplesMatch(rowTuple(e), rowTuple(e4)) || tuplesMatch(rowTuple(f), rowTuple({ ...f, tc: 0x11 }))) fail('tuple equality vectors');
    const table = (n: number): Map<number, string> =>
      sectionSignatureRows(Array.from({ length: n }, (_, id): FloatRecord => ({ kind: 'float', section: 1, offset: 0, id, tc: 0x31, min: 0, max: 10 + id, def: 1, step: 0.1, t1: 0, t2: 0 })));
    const sec = (tag: number, n: number): DerivedSection => ({ space: 'section', tag, key: `section:${tag}`, family: null, role: 'new', stride: n, recordCount: n, informative: n, signature: '', sourceId: 's' });
    const live5 = table(5);
    const cmp = compareBlockRows(live5, table(12), 4);
    if (cmp.rows !== 5 || cmp.equal !== 5) fail(`comparison ${JSON.stringify(cmp)}`);
    type Extent = { probedTo?: number; capped?: boolean; hits?: Array<{ bound: number; capped: boolean }> };
    const match = (n: number, live: Map<number, string>, x: Extent) =>
      matchBlocks({
        byteSections: [sec(70, n)],
        byteRows: () => table(n),
        liveBlocks: new Map([[300, live]]),
        ...(x.probedTo !== undefined ? { liveProbedTo: new Map([[300, x.probedTo]]) } : {}),
        ...(x.capped ? { liveCapped: new Set([300]) } : {}),
        ...(x.hits ? { liveBoundHits: new Map([[300, x.hits]]) } : {}),
      })[0]!;
    // The min-rows rule (the walk looked past the table's end in both).
    if (match(12, live5, { probedTo: 40 }).confidence !== 'candidate') fail(`5 rows of a 12-row table must not confirm (min ${BLOCK_MAP_MIN_ROWS})`);
    if (match(5, live5, { probedTo: 40 }).confidence !== 'confirmed') fail('every row of a 5-row table confirms');
    // The table-end rule: probedTo must pass the section's last pid (4) ...
    if (match(5, live5, { probedTo: 4 }).confidence !== 'candidate') fail('a walk that stopped at the section\'s last pid saw no table end');
    if (match(5, live5, {}).confidence !== 'candidate') fail('an unknown extent never confirms');
    // ... and find no row there, not even one without an editable span.
    const flatRow = new Map(live5).set(6, '49|5|5|1|0|');
    if (match(5, flatRow, { probedTo: 40 }).confidence !== 'candidate') fail('a row past the section\'s end must not confirm');
    // ... unless the walk stopped at its cap inside the section (8 rows to pid 7 of a 12-row table).
    const ten = match(12, table(10), { probedTo: 7, capped: true });
    if (ten.confidence !== 'confirmed' || ten.compared?.rows !== 8) fail(`8 rows to the cap 7 of a 12-row table confirm: ${JSON.stringify(ten)}`);
    if (match(12, table(10), { probedTo: 7 }).confidence !== 'candidate') fail('a prefix below a non-cap ceiling must not confirm');
    // Bound hits: one at a cap inside the section is the cap case; any other forbids `confirmed`.
    if (match(12, table(10), { probedTo: 7, capped: true, hits: [{ bound: 7, capped: true }] }).confidence !== 'confirmed') fail('a hit at the cap inside the section');
    if (match(5, live5, { probedTo: 8, hits: [{ bound: 8, capped: false }] }).confidence !== 'candidate') fail('a hit below the cap must not confirm');
    const none = matchBlocks({ byteSections: [], byteRows: () => new Map(), liveBlocks: new Map([[300, live5]]), byteSource: true })[0]!;
    if (none.confidence !== 'candidate' || none.candidates?.length !== 0) fail('a byte source without unassigned sections: no match, not live-only');
    console.log(
      `  cache/block-map: kind flips equal, value counts not; 5 of 12 rows do not confirm, 8 rows (min ${BLOCK_MAP_MIN_ROWS}) or a whole small table do; ` +
        'the walk must pass the section\'s end and find nothing there, or stop at its cap inside it; a bound hit or an unknown extent never confirms',
    );
  }

  // ---- Case 9: roster hints ------------------------------------------------------------------
  {
    const rows = sectionSignatureRows(sectionAsLive(walk.records, HID_TAG, 0));
    const sec: DerivedSection = { ...hidSection! };
    const out = matchBlocks({
      byteSections: [sec],
      byteRows: () => rows,
      liveBlocks: new Map([[HID_EID, rows]]),
      liveProbedTo: new Map([[HID_EID, 127]]),
      rosterHints: new Map([
        [HID_EID, { family: HIDDEN, sectionTag: HID_TAG }],
        [170, { family: 'TONEMATCH', sectionTag: null }],
      ]),
    });
    const [a, b] = out;
    if (out.length !== 2 || a?.eid !== HID_EID || a.confidence !== 'confirmed' || a.evidence.join() !== 'device-records,roster') fail(`hint + records: ${JSON.stringify(a)}`);
    if (b?.eid !== 170 || b.confidence !== 'roster' || b.key !== 'TONEMATCH' || b.evidence.join() !== 'roster' || b.sectionTag !== null) fail(`hint only: ${JSON.stringify(b)}`);
    console.log('  cache/block-map: a roster hint adds evidence to a confirmed block and stands alone as a roster entry');
  }

  // The fixture's catalog families with an effect id: family -> section meta (instance tags included).
  const placedFamilies = Object.entries(byteOnly.rangeSections)
    .filter(([f]) => !isSyntheticFamilyKey(f) && FM3_EFFECT_IDS[f] != null)
    .concat([[HIDDEN, { sectionTag: HID_TAG, stride: hidSection!.stride, recordCount: hidSection!.recordCount }]])
    .sort((a, b) => a[0].localeCompare(b[0]));

  // ---- Case 10: leave-one-out over every FM3 family — no other family claims the block ------
  {
    let confirmed = 0;
    const takenByte: string[] = [];
    const instanceGroups: string[] = [];
    for (const [fam, meta] of placedFamilies) {
      const eid = FM3_EFFECT_IDS[fam]!;
      const params = FM3_PARAMS.filter((p) => p.family !== fam);
      const seeds = Object.fromEntries(Object.entries(HW_SEEDS).filter(([f]) => f !== fam));
      const catalog: ProfileCatalog = { familyFirstEid: Object.fromEntries(Object.entries(FM3_EFFECT_IDS).filter(([f]) => f !== fam)), sections: FM3_CATALOG_SECTIONS };
      const probe = liveSource('live-probe', T1, sectionAsLive(walk.records, meta.sectionTag, eid));
      const doc = deriveProfile(raw(byte, probe), params, seeds, { ...opts, catalog });
      const blk = doc.sections.find((s) => s.space === 'block' && s.tag === eid);
      if (!blk || blk.family !== null) fail(`${fam} hidden: block ${eid} claimed by ${blk?.family}`);
      for (const [key, src] of Object.entries(doc.provenance.existence)) {
        if (src === probe.id && !isSyntheticFamilyKey(key)) fail(`${fam} hidden: the probe provides catalog family ${key}`);
      }
      const e = entryOf(doc, eid);
      const sec = doc.sections.find((s) => s.space === 'section' && s.tag === meta.sectionTag)!;
      if (meta.instanceTags) {
        // Identical instance sections: ambiguous by design.
        if (e?.confidence !== 'candidate' || e.candidates?.join() !== meta.instanceTags.join()) fail(`${fam} hidden: instance sections ${JSON.stringify(e)}`);
        instanceGroups.push(fam);
      } else if (sec.family === null) {
        if (e?.confidence !== 'confirmed' || e.key !== `section:${meta.sectionTag}` || doc.ranges[`block:${eid}`] !== undefined) fail(`${fam} hidden: ${JSON.stringify(e)}`);
        confirmed += 1;
      } else {
        // The section inventory lists the hidden family's tag: no other family may take it.
        takenByte.push(`${fam}->${sec.family}`);
      }
    }
    if (takenByte.length > 0) fail(`with the inventory no other family takes a hidden family's section: ${takenByte.join(', ')}`);
    // A catalog family the catalog knows but has no effect id for (like the Axe-Fx III Dynamic
    // Distortion): its section stays the family's, the probed block binds to it by rows and its rows
    // join the named family — no span claims the block, no `block:<eid>` family is left.
    const noEid: ProfileCatalog = { familyFirstEid: Object.fromEntries(Object.entries(FM3_EFFECT_IDS).filter(([f]) => f !== 'FORMANT')), sections: FM3_CATALOG_SECTIONS };
    const fTag = byteOnly.rangeSections['FORMANT']!.sectionTag;
    const fEid = FM3_EFFECT_IDS['FORMANT']!;
    const fdoc = deriveProfile(raw(byte, liveSource('live-probe', T1, sectionAsLive(walk.records, fTag, fEid))), FM3_PARAMS, HW_SEEDS, { ...opts, catalog: noEid });
    const fe = entryOf(fdoc, fEid);
    if (fe?.confidence !== 'confirmed' || fe.key !== 'FORMANT' || fe.sectionTag !== fTag || fdoc.ranges[`block:${fEid}`] !== undefined || fdoc.sections.find((s) => s.space === 'block' && s.tag === fEid)?.key !== 'FORMANT') {
      fail(`family without an effect id: ${JSON.stringify(fe)}`);
    }
    if (confirmed + instanceGroups.length !== placedFamilies.length) {
      fail(`leave-one-out: ${confirmed} confirmed, instances ${instanceGroups.join(', ')} of ${placedFamilies.length}`);
    }
    console.log(
      `  cache/block-map: leave-one-out over ${placedFamilies.length} FM3 families — no block claimed by another family, no section taken by another family; ` +
        `${confirmed} confirmed, ${instanceGroups.join('/')} ambiguous instance sections; ` +
        `FORMANT without an effect id binds block ${FM3_EFFECT_IDS['FORMANT']} to its named family`,
    );
  }

  // ---- Case 11: a block outside every effect-id span takes no family ------------------------
  {
    const owners = effectIdOwners({ familyFirstEid: FM3_EFFECT_IDS })!;
    const fm3Catalog: ProfileCatalog = { familyFirstEid: FM3_EFFECT_IDS, sections: FM3_CATALOG_SECTIONS };
    const plexEid = FM3_EFFECT_IDS['PLEX']!;
    let checked = 0;
    for (const [fam, meta] of placedFamilies) {
      if (fam === HIDDEN) continue;
      // The family's own table probed at 250 (no span) and at PLEX's first id (PLEX's span).
      for (const eid of [250, plexEid]) {
        const probe = liveSource('live-probe', T1, sectionAsLive(walk.records, meta.sectionTag, eid));
        const doc = deriveProfile(raw(byte, probe), FM3_PARAMS, HW_SEEDS, { ...opts, catalog: fm3Catalog });
        const blk = doc.sections.find((s) => s.space === 'block' && s.tag === eid)!;
        if (blk.family !== null && owners.get(eid) !== blk.family) fail(`${fam}'s table at block ${eid} went to ${blk.family}`);
        checked += 1;
      }
    }
    // Without effect ids (no catalog, no model) a probe unit assigns no family at all (not even the
    // table's own one).
    const reverbTag = byteOnly.rangeSections['REVERB']!.sectionTag;
    const bare = deriveProfile(raw(byte, liveSource('live-probe', T1, sectionAsLive(walk.records, reverbTag, 250))), FM3_PARAMS, HW_SEEDS, { firmware: '12.0', catalogSections: FM3_CATALOG_SECTIONS });
    if (bare.sections.find((s) => s.space === 'block' && s.tag === 250)?.family !== null || bare.ranges['block:250'] === undefined) fail('a probe without effect ids must assign nothing');
    // Live-only, a whole block-address walk: the restriction changes nothing (buildCache parity).
    const spanCatalog: ProfileCatalog = { familyFirstEid: FM3_EFFECT_IDS, instanceLimits: { INPUT: 2, OUTPUT: 2 } };
    const spanOwners = effectIdOwners(spanCatalog)!;
    const pseudoReplies = { endMarker: 0, duplicateId: 0, implausible: 0 };
    const both = async (recs: LiveRec[]) => {
      const result = { records: recs.map(cacheRecordOf), queries: 0, enumLabels: 0, lostReplies: 0, recoveredReplies: 0, unresolvedReplies: 0, placeholderSlots: 0, missingSlots: 0, silentAddresses: 0, pseudoReplies };
      const built = await buildCache({ kind: 'live', walk: async () => result }, FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '12.0' });
      const src = liveSource('live-readonly', T1, recs);
      src.walk.pseudoReplies = { ...pseudoReplies };
      return { built, spans: deriveProfile(raw(src), FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '12.0', catalog: spanCatalog }) };
    };
    const recs: LiveRec[] = [];
    for (const [fam, meta] of placedFamilies) {
      (meta.instanceTags ?? [meta.sectionTag]).forEach((tag, i) => recs.push(...sectionAsLive(walk.records, tag, FM3_EFFECT_IDS[fam]! + i)));
    }
    const whole = await both(recs);
    const diffs = v1Differences(whole.spans, whole.built);
    if (diffs.length > 0) fail(`restricted vote vs buildCache(live):\n  ${diffs.join('\n  ')}`);
    // The same walk without the RESONATOR block (not walked, or not on the unit): the unrestricted
    // vote moves catalog families onto other families' blocks; the restricted one never does.
    const gap = await both(recs.filter((r) => r.section !== HID_EID));
    const outside = (secs: Record<string, { sectionTag: number }>) =>
      Object.entries(secs).filter(([f, m]) => !isSyntheticFamilyKey(f) && spanOwners.get(m.sectionTag) !== f).map(([f, m]) => `${f}@${m.sectionTag}`);
    if (outside(gap.spans.rangeSections).length > 0 || gap.spans.rangeSections[HIDDEN] !== undefined) fail(`restricted vote misplaced ${outside(gap.spans.rangeSections).join()}`);
    console.log(
      `  cache/block-map: ${checked} probes of catalog tables at block 250 / ${plexEid} — none given a family outside its span; a full block-address walk derives the same tables as buildCache(live); ` +
        `without block ${HID_EID} the unrestricted vote misplaces ${outside(gap.built.rangeSections).join(', ') || 'nothing'}, the restricted one nothing`,
    );
  }

  // ---- Case 12: identical unassigned blocks form one block:<eid> family --------------------
  {
    const rows = (eid: number) => sectionAsLive(twin(NEW_TAG), NEW_TAG, eid);
    const live = liveSource('live-readonly', T1, [...coreLive(walk), ...rows(NEW_EID), ...rows(NEW_EID + 1)]);
    const doc = deriveProfile(raw(live), FM3_PARAMS, HW_SEEDS, fm3Opts);
    const key = `block:${NEW_EID}`;
    if (doc.ranges[`block:${NEW_EID + 1}`] !== undefined || doc.rangeSections[key]?.instanceTags?.join() !== `${NEW_EID},${NEW_EID + 1}`) {
      fail(`live-only instances: ${JSON.stringify(doc.rangeSections[key])}`);
    }
    for (const eid of [NEW_EID, NEW_EID + 1]) {
      const e = entryOf(doc, eid);
      if (e?.confidence !== 'confirmed' || e.key !== key || doc.sections.find((s) => s.space === 'block' && s.tag === eid)?.key !== key) fail(`live-only instance ${eid}: ${JSON.stringify(e)}`);
    }
    // With the editor cache: both probed blocks bridge to the section, no block:<eid> family remains.
    const prefix = (eid: number) => sectionAsLive(big, NEW_TAG, eid, 127);
    const bdoc = deriveProfile(raw(bigByte, liveSource('live-probe', T1, [...prefix(NEW_EID), ...prefix(NEW_EID + 1)])), FM3_PARAMS, HW_SEEDS, fm3Opts);
    for (const eid of [NEW_EID, NEW_EID + 1]) {
      const e = entryOf(bdoc, eid);
      if (e?.confidence !== 'confirmed' || e.key !== `section:${NEW_TAG}` || bdoc.sections.find((s) => s.space === 'block' && s.tag === eid)?.key !== `section:${NEW_TAG}`) fail(`bridged instance ${eid}: ${JSON.stringify(e)}`);
    }
    if (Object.keys(bdoc.ranges).some((k) => k.startsWith('block:'))) fail(`bridged instances left ${Object.keys(bdoc.ranges).filter((k) => k.startsWith('block:')).join()}`);
    console.log(`  cache/block-map: identical unknown blocks ${NEW_EID}/${NEW_EID + 1} — one ${key} family (instance tags) live-only, both bridged to section:${NEW_TAG} with the editor cache`);
  }

  // ---- Case 13: the inventory-restricted editor-cache vote ---------------------------------
  {
    const fullCatalog: ProfileCatalog = { familyFirstEid: FM3_EFFECT_IDS, sections: FM3_CATALOG_SECTIONS };
    const base = deriveProfile(raw(byte), FM3_PARAMS, HW_SEEDS, { ...opts, catalog: fullCatalog });
    // The fixture's editor-cache source with one more section (as `rawFromCacheBytes` of the grown
    // bytes would read it; built directly to keep the 44 derivations fast).
    const withSection = (records: CacheRecord[]): EditorCacheRawSource => ({
      ...byte,
      sections: [...byte.sections, { tag: NEW_TAG, count: records.length }],
      records: [
        ...byte.records,
        ...records.map((r) => {
          const { offset: _o, ...rest } = r as CacheRecord & { nameSpans?: unknown };
          delete (rest as { nameSpans?: unknown }).nameSpans;
          return rest as EditorCacheRawSource['records'][number];
        }),
      ],
    });
    const placement = (d: DerivedProfile) =>
      Object.entries(d.rangeSections)
        .filter(([f]) => !isSyntheticFamilyKey(f))
        .map(([f, m]) => `${f}@${(m.instanceTags ?? [m.sectionTag]).join('/')}`)
        .sort()
        .join(',');
    // Float-heavy new tables (scored by every float-tolerant family, unlike the enum/float
    // alternation of `newTable`), a few enums first; deterministic pseudo-random ranges.
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const floatHeavy = (n: number, enums: number): CacheRecord[] =>
      Array.from({ length: n }, (_, id): CacheRecord =>
        id < enums
          ? { kind: 'enum', section: NEW_TAG, offset: 0, id, tc: 0x10, min: 0, max: 3, def: 0, step: 0, count: 4, values: ['A', 'B', 'C', 'D'], x: 0 }
          : { kind: 'float', section: NEW_TAG, offset: 0, id, tc: 0x31 + (id % 3) * 0x10, min: 0, max: Math.round(1 + rnd() * 20), def: 1, step: 0.01, t1: 0, t2: 0 },
      );
    const tables: Array<[string, CacheRecord[]]> = [];
    for (const n of [12, 24, 48]) for (const enums of [0, 4]) tables.push([`float-heavy ${n}/${enums}`, floatHeavy(n, enums)]);
    // Near-copies of every catalog family's table: one default changed, one row appended (a revised
    // block type of a newer firmware).
    for (const [fam, meta] of Object.entries(base.rangeSections)) {
      if (isSyntheticFamilyKey(fam)) continue;
      const copy = walk.records.filter((r) => r.section === meta.sectionTag && r.id < 0xff00).map((r) => ({ ...r, section: NEW_TAG }));
      const f = copy.find((r) => r.kind === 'float' && r.max > r.min);
      if (!f) continue;
      f.def += 0.5;
      copy.push({ kind: 'float', section: NEW_TAG, offset: 0, id: Math.max(...copy.map((r) => r.id)) + 1, tc: 0x31, min: 0, max: 10, def: 1, step: 0.01, t1: 0, t2: 0 });
      tables.push([`near-copy of ${fam}`, copy]);
    }
    let unrestrictedTaken = 0;
    for (const [name, records] of tables) {
      const grown = withSection(records);
      const doc = deriveProfile(raw(grown), FM3_PARAMS, HW_SEEDS, { ...opts, catalog: fullCatalog });
      const sec = doc.sections.find((s) => s.space === 'section' && s.tag === NEW_TAG);
      if (sec?.role !== 'new' || sec.family !== null || sec.key !== `section:${NEW_TAG}` || doc.ranges[`section:${NEW_TAG}`] === undefined) fail(`${name}: section ${NEW_TAG} ${JSON.stringify(sec)}`);
      if (placement(doc) !== placement(base)) fail(`${name}: catalog families moved (${placement(doc)})`);
      const gap = doc.coverage.gaps.find((g) => g.kind === 'new-section');
      if (!gap || gap.blocking || !gap.tags?.includes(NEW_TAG)) fail(`${name}: new-section gap ${JSON.stringify(gap)}`);
      // Control (float-heavy tables): without the inventory the unrestricted vote may hand them out.
      if (name.startsWith('float-heavy')) {
        const control = deriveProfile(raw(grown), FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '12.0' });
        if (control.sections.find((s) => s.space === 'section' && s.tag === NEW_TAG)?.family != null) unrestrictedTaken += 1;
      }
    }
    if (unrestrictedTaken === 0) fail('control: without the inventory some float-heavy table must go to a family (else the case tests nothing)');
    console.log(
      `  cache/block-map: inventory vote — ${tables.length} new tables at tag ${NEW_TAG} (6 float-heavy, ${tables.length - 6} near-copies of catalog tables) stay section:${NEW_TAG} ` +
        `(role new, new-section gap), no family moves; without the inventory ${unrestrictedTaken}/6 float-heavy tables go to a catalog family`,
    );
  }

  // ---- Case 14: the table-end rule on real walks --------------------------------------------
  {
    const probeSource = async (records: CacheRecord[], block: number, maxParamId: number): Promise<LiveRawSource> => {
      const dev = cacheDevice(records);
      const o: LiveWalkOptions = { model: 0x11, blocks: [block], maxParamId, readValues: false, sleep: dev.sleep };
      const res = await liveWalkDetailed(dev, o);
      return rawFromLiveWalk(res, liveWalkScope(o), { kind: 'live-probe', capturedAt: T1, firmware: '12.0' });
    };
    const at = (rows: CacheRecord[], eid: number) => rows.map((r) => ({ ...r, section: eid }));
    const sec20 = newTable(NEW_TAG, 20);
    const byte20 = await rawFromCacheBytes(fixtureBytes(grownWalk(walk, [{ tag: NEW_TAG, records: sec20 }]), 12, 0), { capturedAt: T0, firmware: '12.0' });
    const entry = (src: RawSource, base: RawSource = byte20, o = fm3Opts, eid = NEW_EID) => entryOf(deriveProfile(raw(base, src), FM3_PARAMS, HW_SEEDS, o), eid);
    // The device's block holds 30 rows whose first 20 equal the 20-row section.
    const device30 = at(newTable(NEW_TAG, 30), NEW_EID);
    // A: the probe stops at the section's last pid (19) — it hits its ceiling, sees no table end.
    const a = await probeSource(device30, NEW_EID, 19);
    if (a.walk.boundHits.map((h) => `${h.block}:${h.bound}`).join() !== `${NEW_EID}:19`) fail(`probe to 19: bound hits ${JSON.stringify(a.walk.boundHits)}`);
    if (entry(a)?.confidence !== 'candidate') fail(`probe to the section's last pid: ${JSON.stringify(entry(a))}`);
    // A2: the probe reads on (to 19 + 32) and finds rows 20..29 the section lacks.
    if (entry(await probeSource(device30, NEW_EID, 51))?.confidence !== 'candidate') fail('a longer device table must not confirm');
    // The device table IS the section: the probe passes its end, finds nothing there — confirmed.
    const exact = entry(await probeSource(at(sec20, NEW_EID), NEW_EID, 51));
    if (exact?.confidence !== 'confirmed' || exact.key !== `section:${NEW_TAG}` || exact.compared?.probedTo !== 51) fail(`exact table: ${JSON.stringify(exact)}`);
    // ... but not when the walk hit its ceiling 3 ids past the end (stop run cut short).
    const near = await probeSource(at(sec20, NEW_EID), NEW_EID, 22);
    if (near.walk.boundHits.length !== 1 || entry(near)?.confidence !== 'candidate') fail(`ceiling 22: ${JSON.stringify(near.walk.boundHits)} ${JSON.stringify(entry(near))}`);
    // B: a source whose scope does not list the block (its records joined without the scope).
    const unscoped = liveSource('live-probe', T1, sectionAsLive(newTable(NEW_TAG, 10), NEW_TAG, NEW_EID), { blocks: [] });
    if (entry(unscoped)?.confidence !== 'candidate') fail(`unscoped block: ${JSON.stringify(entry(unscoped))}`);
    // A 2-row section whose rows open another table: FDBKSEND left out of the catalog, its block
    // holding the FDBKRET table (whose first 2 rows equal FDBKSEND's 2-row table).
    const send = 'FDBKSEND';
    const sendTag = byteOnly.sections.find((s) => s.key === send)!.tag;
    const retTag = byteOnly.sections.find((s) => s.key === 'FDBKRET')!.tag;
    const sendEid = FM3_EFFECT_IDS[send]!;
    const sendOpts = {
      ...opts,
      catalog: { familyFirstEid: Object.fromEntries(Object.entries(FM3_EFFECT_IDS).filter(([f]) => f !== send)), sections: FM3_CATALOG_SECTIONS },
    };
    const sendParams = FM3_PARAMS.filter((p) => p.family !== send);
    const sendEntry = async (rows: CacheRecord[], maxParamId: number) =>
      entryOf(deriveProfile(raw(byte, await probeSource(at(rows, sendEid), sendEid, maxParamId)), sendParams, HW_SEEDS, sendOpts), sendEid);
    const retRows = walk.records.filter((r) => r.section === retTag && r.id < 0xff00);
    const sendRows = walk.records.filter((r) => r.section === sendTag && r.id < 0xff00);
    const cut = await sendEntry(retRows, sendRows.length - 1);
    const past = await sendEntry(retRows, sendRows.length - 1 + 32);
    const own = await sendEntry(sendRows, sendRows.length - 1 + 32);
    if (cut?.confidence !== 'candidate' || past?.confidence !== 'candidate') fail(`the FDBKRET table at ${sendEid}: ${JSON.stringify(cut)} / ${JSON.stringify(past)}`);
    if (own?.confidence !== 'confirmed' || own.sectionTag !== sendTag) fail(`the FDBKSEND table at ${sendEid}: ${JSON.stringify(own)}`);
    console.log(
      `  cache/block-map: real walks — probes to the section's last pid (bound hit), into a longer table, or ending 3 ids past the section, and a block no scope lists: candidate; ` +
        `the exact table probed past its end: confirmed; ${send}'s 2-row section never confirms to the FDBKRET table, its own table does`,
    );
  }

  // ---- Case 15: effect-id spans — host, model default, none -----------------------------------
  {
    const recs: LiveRec[] = [];
    for (const [fam, meta] of placedFamilies) {
      (meta.instanceTags ?? [meta.sectionTag]).forEach((tag, i) => recs.push(...sectionAsLive(walk.records, tag, FM3_EFFECT_IDS[fam]! + i)));
    }
    const live = liveSource('live-readonly', T1, recs);
    const tablesOf = (d: DerivedProfile) => JSON.stringify([d.ranges, d.rangeSections, d.enumOverrides, d.rosters, d.sections.map((s) => `${s.tag}:${s.key}`)]);
    const host = deriveProfile(raw(live), FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '12.0', catalog: { familyFirstEid: FM3_EFFECT_IDS, instanceLimits: { INPUT: 2, OUTPUT: 2 } } });
    const byModel = deriveProfile(raw(live), FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '12.0' });
    if (tablesOf(byModel) !== tablesOf(host)) fail('the model\'s default spans must place the walk like the host\'s table');
    const spans = effectIdSpansForModel(0x11)!;
    if (spans.familyFirstEid['DISTORT'] !== 58 || spans.instanceLimits['DISTORT'] !== 4 || spans.familyFirstEid['PRESET'] !== null || effectIdSpansForModel(0x15) !== null || effectIdSpansForModel(undefined) !== null) {
      fail(`effectIdSpansForModel ${JSON.stringify(spans.instanceLimits)}`);
    }
    if (effectIdSpansForModel(0x10)!.instanceLimits['INPUT'] !== 5) fail('Axe-Fx III spans');
    // The host's table wins over the model default (the leave-one-out hook hides a family).
    const hiddenFirst = Object.fromEntries(Object.entries(FM3_EFFECT_IDS).filter(([f]) => f !== HIDDEN));
    for (const unrestrictedLiveVote of [false, true]) {
      const hidden = deriveProfile(raw(live), FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '12.0', catalog: { familyFirstEid: hiddenFirst }, unrestrictedLiveVote });
      const blk = hidden.sections.find((s) => s.space === 'block' && s.tag === HID_EID);
      if (blk?.family !== null || blk.key !== `block:${HID_EID}` || hidden.ranges[HIDDEN] !== undefined) fail(`host spans (unrestricted option ${unrestrictedLiveVote}): block ${HID_EID} ${JSON.stringify(blk)}`);
    }
    if (byModel.sections.find((s) => s.space === 'block' && s.tag === HID_EID)?.family !== HIDDEN) fail('the model default places RESONATOR');
    // Neither a host table nor a known model: live units assign nothing (and need no seed).
    const none = deriveProfile(raw(live), FM3_PARAMS, HW_SEEDS, { firmware: '12.0' });
    if (none.sections.some((s) => s.family !== null) || !Object.keys(none.ranges).every(isSyntheticFamilyKey)) fail('without spans nothing is assigned');
    // Instance limits are keyed by family symbol, case-insensitively; a UI slug is ignored.
    const owners = effectIdOwners({ familyFirstEid: FM3_EFFECT_IDS, instanceLimits: { input: 2, Output: 2, amp: 4, MULTITAP: 3, multitap: 1 } })!;
    if (owners.get(38) !== 'INPUT' || owners.get(43) !== 'OUTPUT' || owners.get(59) !== undefined || owners.get(76) !== 'MULTITAP') {
      fail(`instance limit keys: 38 ${owners.get(38)}, 43 ${owners.get(43)}, 59 ${owners.get(59)}, 76 ${owners.get(76)}`);
    }
    console.log(
      '  cache/block-map: spans — without a catalog the FM3 model\'s own effect ids place a block-address walk like the host\'s table; a host table that hides RESONATOR wins ' +
        '(also over the parity option); no table and no model: nothing assigned; instance limit keys case-insensitive, slugs ignored',
    );
  }

  // ---- Case 16: identical tables of different owners ----------------------------------------
  {
    const revTag = byteOnly.rangeSections['REVERB']!.sectionTag;
    const modTag = byteOnly.rangeSections['MOD']!.sectionTag;
    const modEid = FM3_EFFECT_IDS['MOD']!;
    // REVERB's table also at block 20 (outside every span, below REVERB's own block); MOD's table at
    // its block and at the next three (unplaced modifier slots answer the same table).
    const recs = [
      ...coreLive(walk),
      ...sectionAsLive(walk.records, revTag, 20),
      ...[0, 1, 2, 3].flatMap((i) => sectionAsLive(walk.records, modTag, modEid + i)),
    ];
    const doc = deriveProfile(raw(liveSource('live-readonly', T1, recs)), FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '12.0', catalog: { familyFirstEid: FM3_EFFECT_IDS } });
    const twin20 = doc.sections.find((s) => s.space === 'block' && s.tag === 20);
    if (doc.rangeSections['REVERB']?.sectionTag !== FM3_EFFECT_IDS['REVERB'] || twin20?.family !== null || twin20.key !== 'block:20') {
      fail(`REVERB and its lower twin: ${JSON.stringify(doc.rangeSections['REVERB'])} / ${JSON.stringify(twin20)}`);
    }
    if (doc.rangeSections['MOD']?.instanceTags?.join() !== [0, 1, 2, 3].map((i) => modEid + i).join()) fail(`modifier copies: ${JSON.stringify(doc.rangeSections['MOD'])}`);
    // Editor-cache tags: an identical copy of the INPUT tables at a tag the inventory does not list
    // stays a new section (the unrestricted vote would make it a third INPUT instance).
    const inTag = byteOnly.rangeSections['INPUT']!.sectionTag;
    const copyTag = 43;
    const copy = walk.records.filter((r) => r.section === inTag).map((r) => ({ ...r, section: copyTag }));
    const grown = await rawFromCacheBytes(fixtureBytes(grownWalk(walk, [{ tag: copyTag, records: copy }]), 12, 0), { capturedAt: T0, firmware: '12.0' });
    const restricted = deriveProfile(raw(grown), FM3_PARAMS, HW_SEEDS, opts);
    const unrestricted = deriveProfile(raw(grown), FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '12.0' });
    const copySec = restricted.sections.find((s) => s.space === 'section' && s.tag === copyTag);
    if (restricted.rangeSections['INPUT']?.instanceTags?.join() !== '41,42' || copySec?.role !== 'new' || copySec.key !== `section:${copyTag}`) {
      fail(`INPUT copy at ${copyTag}: ${JSON.stringify(restricted.rangeSections['INPUT'])} / ${JSON.stringify(copySec)}`);
    }
    if (unrestricted.rangeSections['INPUT']?.instanceTags?.join() !== `41,42,${copyTag}`) fail(`unrestricted INPUT: ${JSON.stringify(unrestricted.rangeSections['INPUT'])}`);
    console.log(
      `  cache/block-map: identical tables — REVERB keeps its block although block 20 below it holds the same table (block:20); modifier copies ${modEid + 1}..${modEid + 3} follow MOD; ` +
        `an INPUT copy at the unlisted tag ${copyTag} stays new (unrestricted: a third INPUT instance)`,
    );
  }
}
