/**
 * Profile document v2: every section kept, synthetic families, section roles, catalog inventory.
 *
 * - FM3 fw 12.0 fixture with the FM3 inventory: 39 family + 2 instance + 4 system sections, the
 *   four unassigned ones as `section:<tag>` families (rows, labels, section meta);
 * - a synthetic NEW section appended to the fixture: role `new`, rows under `section:60`, its
 *   stride, a `new-section` coverage gap, and every existing top-level field unchanged
 *   (equal to `buildCache` of the same bytes, and the catalog families equal to the fixture's);
 * - no inventory -> `unclassified`; an unassigned live block -> `block:<eid>`;
 * - section signatures: equal for byte-identical instance sections, label-free;
 * - `*_CATALOG_SECTIONS` agree with the committed catalogs (FM3, FM9, Axe-Fx III) and the FM3
 *   fixture's sections.
 *
 * Public data only: the committed walk fixture, committed catalogs, synthetic records.
 */
import {
  buildCache,
  deriveProfile,
  HW_SEEDS,
  isSyntheticFamilyKey,
  rawFromCacheBytes,
  rowsSignature,
  sectionSignatureRows,
} from '../../src/cache/index.js';
import type { DerivedProfile, LiveRawSource, ProfileRaw, RawSource } from '../../src/cache/index.js';
import type { CacheRecord, CacheWalk, EnumRecord, FloatRecord } from '../../src/cache/types.js';
import { FM3_CATALOG_SECTIONS, FM3_PARAMS, FM3_RANGE_SECTIONS, FM3_UNMAPPED_SECTIONS } from '../../src/gen3/fm3/index.js';
import { FM9_CATALOG_SECTIONS, FM9_RANGE_SECTIONS, FM9_UNMAPPED_SECTIONS } from '../../src/gen3/fm9/index.js';
import { AXE3_CATALOG_SECTIONS, AXE3_RANGE_SECTIONS, AXE3_UNMAPPED_SECTIONS } from '../../src/gen3/axe-fx-iii/index.js';
import { VERSION } from '../../src/version.js';
import { fixtureBytes, loadWalk, v1Differences, withoutSynthetic, jsonDiff } from './profile-doc.test.js';

export const PROFILE_SECTIONS_CASE_COUNT = 6;

const raw = (...sources: RawSource[]): ProfileRaw => ({ format: 1, sources });

const NEW_TAG = 60;

/** A small parameter table no catalog family matches: label lists in front, a few knobs behind. */
function newSectionRecords(): CacheRecord[] {
  const out: CacheRecord[] = [];
  for (let id = 0; id < 8; id++) {
    const values = ['Mode A', 'Mode B', 'Mode C'];
    const r: EnumRecord = { kind: 'enum', section: NEW_TAG, offset: 0, id, tc: 0x10, min: 0, max: 2, def: 0, step: 1, count: 3, values, x: 0 };
    out.push(r);
  }
  for (let id = 8; id < 12; id++) {
    const r: FloatRecord = { kind: 'float', section: NEW_TAG, offset: 0, id, tc: 0x31, min: 0, max: 7.5 + id, def: 1, step: 0.05, t1: 0, t2: 0 };
    out.push(r);
  }
  return out;
}

function countRoles(doc: DerivedProfile, space: 'section' | 'block'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of doc.sections) if (s.space === space) out[s.role] = (out[s.role] ?? 0) + 1;
  return out;
}

/** Inventory vs committed catalog: family tags (instance tags too) and counts, null tags = unmapped. */
function inventoryProblems(
  inv: readonly { tag: number; family: string | null; records: number }[],
  sections: Readonly<Record<string, { sectionTag: number; recordCount: number; instanceTags?: readonly number[] }>>,
  unmapped: readonly { sectionTag: number; recordCount: number }[],
): string[] {
  const want = new Map<number, [string | null, number]>();
  for (const [fam, m] of Object.entries(sections)) for (const t of m.instanceTags ?? [m.sectionTag]) want.set(t, [fam, m.recordCount]);
  for (const u of unmapped) want.set(u.sectionTag, [null, u.recordCount]);
  const out: string[] = [];
  const tags = inv.map((s) => s.tag);
  if (tags.some((t, i) => i > 0 && t <= tags[i - 1]!)) out.push('tags not strictly ascending');
  if (inv.length !== want.size) out.push(`${inv.length} entries, catalog has ${want.size} tags`);
  for (const s of inv) {
    const w = want.get(s.tag);
    if (!w) out.push(`tag ${s.tag} not in the catalog`);
    else if (w[0] !== s.family || w[1] !== s.records) out.push(`tag ${s.tag}: ${s.family}/${s.records} vs catalog ${w[0]}/${w[1]}`);
  }
  return out;
}

export async function runProfileSections(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[cache/profile-sections] ${msg}`);
  };
  const walk = loadWalk('fm3-12p0.walk.json');
  const buf = fixtureBytes(walk, 12, 0);
  const src = await rawFromCacheBytes(buf, { capturedAt: '2026-11-22T10:00:00Z' });
  const opts = { model: 0x11, firmware: '12.0', catalogSections: FM3_CATALOG_SECTIONS };
  const doc = deriveProfile(raw(src), FM3_PARAMS, HW_SEEDS, opts);

  // ---- Case 1: FM3 fixture — every section kept, roles, synthetic families -----------------
  {
    const roles = countRoles(doc, 'section');
    if (doc.sections.length !== 45 || roles.family !== 39 || roles.instance !== 2 || roles.system !== 4 || roles.new || roles.unclassified) {
      fail(`roles ${JSON.stringify(roles)} over ${doc.sections.length} sections`);
    }
    const system = doc.sections.filter((s) => s.role === 'system').map((s) => `${s.tag}=${s.key}`).join(',');
    if (system !== '4=section:4,53=section:53,56=section:56,58=section:58') fail(`system sections ${system}`);
    for (const u of FM3_UNMAPPED_SECTIONS) {
      const key = `section:${u.sectionTag}`;
      const meta = doc.rangeSections[key];
      const rows = Object.keys(doc.ranges[key] ?? {}).length;
      if (!meta || meta.sectionTag !== u.sectionTag || meta.stride !== u.wireStride || meta.recordCount !== u.recordCount || rows !== u.wireStride) {
        fail(`${key}: meta ${JSON.stringify(meta)}, ${rows} rows (catalog ${JSON.stringify(u)})`);
      }
    }
    if (!doc.enumOverrides['section:56'] || doc.rosters['section:56'] !== undefined) fail('section:56 labels / no roster');
    if (jsonDiff(doc.unmappedSections, FM3_UNMAPPED_SECTIONS)) fail('unmappedSections must stay as today');
    const inst = doc.sections.filter((s) => s.role === 'instance').map((s) => `${s.tag}:${s.key}`).join(',');
    if (inst !== '42:INPUT,47:OUTPUT') fail(`instance sections ${inst}`);
    const delay = doc.sections.find((s) => s.key === 'DELAY')!;
    if (delay.tag !== 13 || delay.stride !== 88 || delay.recordCount !== 88 || delay.sourceId !== src.id || delay.space !== 'section') {
      fail(`DELAY section ${JSON.stringify(delay)}`);
    }
    if (doc.coverage.sections.total !== 45 || doc.coverage.sections.assigned !== 41 || doc.coverage.sections.system !== 4) {
      fail(`coverage.sections ${JSON.stringify(doc.coverage.sections)}`);
    }
    console.log(`  cache/profile-sections: FM3 — 45 sections kept (39 family, 2 instance, 4 system as section:4/53/56/58 with rows + meta)`);
  }

  // ---- Case 2: a new section appended — role new, rows under section:60, fields unchanged ---
  {
    const extra = newSectionRecords();
    const grown: CacheWalk = {
      sections: [...walk.sections, { index: NEW_TAG, count: extra.length, offset: 0, records: extra.length }],
      records: [...walk.records, ...extra],
    };
    const gbuf = fixtureBytes(grown, 13, 0);
    const gsrc = await rawFromCacheBytes(gbuf);
    const gdoc = deriveProfile(raw(gsrc), FM3_PARAMS, HW_SEEDS, { ...opts, firmware: '13.0' });
    const built = await buildCache({ kind: 'bytes', buf: gbuf }, FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '13.0' });
    const diffs = v1Differences(gdoc, built);
    if (diffs.length > 0) fail(`grown fixture determinism:\n  ${diffs.join('\n  ')}`);
    const sec = gdoc.sections.find((s) => s.tag === NEW_TAG);
    if (!sec || sec.role !== 'new' || sec.key !== `section:${NEW_TAG}` || sec.family !== null || sec.stride !== 12 || sec.informative !== 12) {
      fail(`new section ${JSON.stringify(sec)}`);
    }
    const key = `section:${NEW_TAG}`;
    const rows = gdoc.ranges[key] ?? {};
    if (Object.keys(rows).length !== 12 || rows[3]?.kind !== 'enum' || rows[3]?.enumCount !== 3 || rows[9]?.kind !== 'float' || rows[9]?.displayMax !== 16.5) {
      fail(`section:60 rows ${JSON.stringify(rows[3])} / ${JSON.stringify(rows[9])}`);
    }
    if (gdoc.enumOverrides[key]?.['0']?.join('|') !== 'Mode A|Mode B|Mode C') fail('section:60 labels');
    const meta = gdoc.rangeSections[key];
    if (meta?.sectionTag !== NEW_TAG || meta.stride !== 12 || meta.recordCount !== 12) fail(`section:60 meta ${JSON.stringify(meta)}`);
    // Catalog families: unchanged against the fixture's profile.
    for (const f of ['enumOverrides', 'ranges', 'rangeSections', 'rosters', 'cabIrs'] as const) {
      const a = withoutSynthetic(gdoc[f]);
      const b = withoutSynthetic(doc[f]);
      const diff = jsonDiff(a, b);
      if (diff) fail(`${f} of the catalog families changed: ${diff}`);
    }
    if (gdoc.unmappedSections.map((s) => s.sectionTag).join(',') !== '4,53,56,58,60') fail('unmappedSections lists the new tag like buildCache');
    const gap = gdoc.coverage.gaps.find((g) => g.kind === 'new-section');
    if (!gap || gap.blocking || gap.tags?.join(',') !== String(NEW_TAG) || gdoc.coverage.sections.new !== 1) {
      fail(`new-section gap ${JSON.stringify(gap)}, counts ${JSON.stringify(gdoc.coverage.sections)}`);
    }
    console.log(`  cache/profile-sections: appended tag ${NEW_TAG} — role new, 12 rows + labels under ${key}, stride 12, non-blocking new-section gap; catalog families unchanged`);
  }

  // ---- Case 3: no inventory -> unclassified ------------------------------------------------
  {
    const bare = deriveProfile(raw(src), FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '12.0' });
    const roles = countRoles(bare, 'section');
    if (roles.unclassified !== 4 || roles.system || roles.new || bare.coverage.sections.unclassified !== 4) fail(`roles without inventory ${JSON.stringify(roles)}`);
    if (jsonDiff(bare.ranges, doc.ranges)) fail('the inventory must not change the tables');
    console.log('  cache/profile-sections: without an inventory the 4 unassigned sections are unclassified (tables identical)');
  }

  // ---- Case 4: live space — an unassigned block becomes block:<eid> ------------------------
  {
    const ordinary = walk.records.filter((r) => r.id < 0xff00 && r.id <= 127);
    const records = [...ordinary, ...newSectionRecords().map((r) => ({ ...r, section: 203 }))].map((r) => {
      const { offset: _o, ...rest } = r as CacheRecord & { nameSpans?: unknown };
      delete (rest as { nameSpans?: unknown }).nameSpans;
      return rest;
    });
    const live: LiveRawSource = {
      id: 'live-readonly@unknown#0',
      kind: 'live-readonly',
      origin: 'local',
      capturedAt: null,
      firmware: null,
      codecVersion: VERSION,
      space: 'block',
      scope: { blocks: [...new Set(records.map((r) => r.section))], maxParamId: 127, bounds: {}, extended: false, above160: false, hinted: true },
      walk: { queries: 0, lostReplies: 0, recoveredReplies: 0, unresolvedReplies: 0, placeholderSlots: 0, missingSlots: 0, silentAddresses: 0, boundHits: [] },
      records: records as LiveRawSource['records'],
    };
    const ldoc = deriveProfile(raw(live), FM3_PARAMS, HW_SEEDS, { catalogSections: FM3_CATALOG_SECTIONS });
    const blk = ldoc.sections.find((s) => s.tag === 203);
    if (!blk || blk.space !== 'block' || blk.key !== 'block:203' || blk.role !== 'unclassified' || Object.keys(ldoc.ranges['block:203'] ?? {}).length !== 12) {
      fail(`live block 203 ${JSON.stringify(blk)}`);
    }
    if (ldoc.sections.some((s) => s.space === 'section') || ldoc.rangeSections['block:203']?.sectionTag !== 203) fail('live sections are block space');
    if (Object.keys(ldoc.ranges).some((k) => k.startsWith('section:'))) fail('a live-only document has no section: keys');
    console.log(`  cache/profile-sections: live-only — unassigned block 203 kept as block:203 (role unclassified, 12 rows)`);
  }

  // ---- Case 5: section signatures ------------------------------------------------------------
  {
    const sig = (tag: number) => doc.sections.find((s) => s.tag === tag)!.signature;
    if (sig(41) !== sig(42) || sig(46) !== sig(47) || sig(41) === sig(46) || !/^1:[0-9a-f]{8}$/.test(sig(41))) fail('instance signatures');
    const rows = walk.records.filter((r) => r.section === 13);
    const relabelled = rows.map((r) => (r.kind === 'enum' ? { ...r, values: r.values.map((v) => `${v}*`) } : r));
    if (rowsSignature(sectionSignatureRows(rows)) !== sig(13) || rowsSignature(sectionSignatureRows(relabelled)) !== sig(13)) fail('signature must ignore labels');
    const changed = rows.map((r) => (r.id === 5 ? { ...r, max: r.max + 1 } : r));
    if (rowsSignature(sectionSignatureRows(changed)) === sig(13)) fail('signature must see a range change');
    console.log('  cache/profile-sections: signatures equal for instance sections, ignore labels, see range changes');
  }

  // ---- Case 6: catalog section inventories agree with the committed catalogs --------------
  {
    const checks: Array<[string, string[]]> = [
      ['FM3', inventoryProblems(FM3_CATALOG_SECTIONS, FM3_RANGE_SECTIONS, FM3_UNMAPPED_SECTIONS)],
      ['FM9', inventoryProblems(FM9_CATALOG_SECTIONS, FM9_RANGE_SECTIONS, FM9_UNMAPPED_SECTIONS)],
      ['AXE3', inventoryProblems(AXE3_CATALOG_SECTIONS, AXE3_RANGE_SECTIONS, AXE3_UNMAPPED_SECTIONS)],
    ];
    for (const [dev, problems] of checks) if (problems.length > 0) fail(`${dev} inventory: ${problems.join('; ')}`);
    const fixture = walk.sections.map((s) => `${s.index}:${s.count}`).join(',');
    const inv = FM3_CATALOG_SECTIONS.map((s) => `${s.tag}:${s.records}`).join(',');
    if (fixture !== inv) fail('FM3 inventory vs fixture sections');
    if (FM9_CATALOG_SECTIONS.length !== 49 || AXE3_CATALOG_SECTIONS.length !== 57) fail('FM9/III inventory sizes');
    console.log(`  cache/profile-sections: inventories agree with the catalogs (FM3 ${FM3_CATALOG_SECTIONS.length}, FM9 ${FM9_CATALOG_SECTIONS.length}, III ${AXE3_CATALOG_SECTIONS.length} sections) and the FM3 fixture`);
  }
}
