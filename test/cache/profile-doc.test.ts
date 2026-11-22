/**
 * Profile document v2: raw sources and determinism.
 *
 * - `deriveProfile` over one editor-cache source equals `buildCache({ kind: 'bytes' })` of the same
 *   bytes in every v1 field (plus the synthetic `section:<tag>` keys), on both committed walk
 *   fixtures (FM3 fw 12.0, AM4), re-encoded to cache bytes behind a header;
 * - the same over one live source vs `buildCache({ kind: 'live' })`, on the shared fake device;
 * - user name tables are omitted from raw (counted), declared section counts keep `recordCount`;
 * - `contentSha256` is the sha256 of the redacted bytes;
 * - a tolerant source carries its issues into `meta.issues` like `buildCache`;
 * - size budget of a byte + synthetic live document;
 * - `assertNoUserTables` positive / negative; `deriveProfile` input errors.
 *
 * Public data only: the committed (redacted) walk fixtures and synthetic records.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCache,
  buildDeviceCache,
  buildProfileDoc,
  CACHE_SCHEMA,
  compareCodecVersions,
  deriveProfile,
  HW_SEEDS,
  isSyntheticFamilyKey,
  isUserNameTable,
  liveWalkDetailed,
  MIN_DERIVED_WITH,
  parseCacheRecords,
  PROFILE_FORMAT,
  ProfileDerivationError,
  ProfileUserDataError,
  rawFromCacheBytes,
  rawFromLiveWalk,
  assertNoUserTables,
  redactCacheUserNames,
} from '../../src/cache/index.js';
import type { BuiltCache, DerivedProfile, LiveRawSource, LiveSourceScope, ProfileRaw, RawSource } from '../../src/cache/index.js';
import type { CacheRecord, CacheWalk } from '../../src/cache/types.js';
import { FM3_PARAMS } from '../../src/gen3/fm3/index.js';
import { AM4_CACHE_PARAMS, AM4_SEEDS } from '../../src/am4/index.js';
import { VERSION } from '../../src/version.js';
import { encodeWalk, header } from './cacheBytes.js';
import { cacheDevice } from './cacheDevice.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const PROFILE_DOC_CASE_COUNT = 9;

const V1_DATA_FIELDS = ['enumOverrides', 'ranges', 'rangeSections', 'rosters', 'cabIrs', 'unmappedSections', 'unmappedFamilies'] as const;
const KEYED_FIELDS = new Set(['enumOverrides', 'ranges', 'rangeSections', 'rosters']);

/** Load a committed walk fixture. */
export function loadWalk(name: string): CacheWalk {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as CacheWalk;
}

/** Cache bytes of a fixture walk behind a matching header. */
export function fixtureBytes(walk: CacheWalk, major: number, minor: number): Uint8Array {
  return encodeWalk(walk, header({ major, minor, sectionCount: walk.sections.length }));
}

/** A v1 field of a derived profile without the synthetic family keys. */
export function withoutSynthetic(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !isSyntheticFamilyKey(k)));
}

/** First difference between two JSON texts, for a readable failure. */
export function jsonDiff(a: unknown, b: unknown): string | null {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x === y) return null;
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return `…${x.slice(Math.max(0, i - 40), i + 40)}… vs …${y.slice(Math.max(0, i - 40), i + 40)}…`;
}

/**
 * Every v1 field of `derived` equals `built` (the keyed maps after dropping synthetic keys, in the
 * same key order); returns the problems found.
 */
export function v1Differences(derived: DerivedProfile, built: BuiltCache): string[] {
  const out: string[] = [];
  for (const f of V1_DATA_FIELDS) {
    const d = KEYED_FIELDS.has(f) ? withoutSynthetic(derived[f]) : derived[f];
    const diff = jsonDiff(d, built[f]);
    if (diff) out.push(`${f}: ${diff}`);
  }
  if (derived.model !== built.model) out.push(`model ${derived.model} vs ${built.model}`);
  if (derived.firmware !== built.firmware) out.push(`firmware ${derived.firmware} vs ${built.firmware}`);
  const { schema, recordCount, source, builtAt, walk, issues } = derived.meta;
  const diff = jsonDiff({ schema, recordCount, source, builtAt, walk, issues }, {
    schema: built.meta.schema,
    recordCount: built.meta.recordCount,
    source: built.meta.source,
    builtAt: built.meta.builtAt,
    walk: built.meta.walk,
    issues: built.meta.issues,
  });
  if (diff) out.push(`meta: ${diff}`);
  return out;
}

const raw = (...sources: RawSource[]): ProfileRaw => ({ format: 1, sources });

export async function runProfileDoc(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[cache/profile-doc] ${msg}`);
  };
  const fm3Walk = loadWalk('fm3-12p0.walk.json');
  const fm3Buf = fixtureBytes(fm3Walk, 12, 0);
  const stamp = '2026-11-22T10:00:00Z';

  // ---- Case 1: FM3 editor-cache source — determinism vs buildCache(bytes) --------------------
  const fm3Src = await rawFromCacheBytes(fm3Buf, { fileName: 'effectDefinitions_11_12p0.cache', capturedAt: stamp });
  const fm3Built = await buildCache({ kind: 'bytes', buf: fm3Buf }, FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '12.0' });
  const fm3Doc = deriveProfile(raw(fm3Src), FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '12.0', derivedAt: stamp });
  {
    const diffs = v1Differences(fm3Doc, fm3Built);
    if (diffs.length > 0) fail(`FM3 bytes determinism:\n  ${diffs.join('\n  ')}`);
    const synthetic = Object.keys(fm3Doc.ranges).filter(isSyntheticFamilyKey);
    const want = fm3Built.unmappedSections.map((s) => `section:${s.sectionTag}`);
    if (synthetic.join(',') !== want.join(',')) fail(`FM3 synthetic keys ${synthetic.join(',')} vs unmapped sections ${want.join(',')}`);
    console.log(`  cache/profile-doc: FM3 fw 12.0 — deriveProfile(raw from bytes) equals buildCache(bytes) in every v1 field (+ ${synthetic.join(', ')})`);
  }

  // ---- Case 2: AM4 editor-cache source — determinism ---------------------------------------
  {
    const am4Walk = loadWalk('am4-66p1.walk.json');
    const buf = fixtureBytes(am4Walk, 66, 1);
    const src = await rawFromCacheBytes(buf, { fileName: 'effectDefinitions_15_66p1.cache' });
    const built = await buildCache({ kind: 'bytes', buf }, AM4_CACHE_PARAMS, AM4_SEEDS, {});
    const doc = deriveProfile(raw(src), AM4_CACHE_PARAMS, AM4_SEEDS, {});
    const diffs = v1Differences(doc, built);
    if (diffs.length > 0) fail(`AM4 bytes determinism:\n  ${diffs.join('\n  ')}`);
    if (src.omitted.tables !== 1 || src.omitted.records !== 1) fail(`AM4 omitted ${JSON.stringify(src.omitted)}`);
    console.log(`  cache/profile-doc: AM4 — deriveProfile(raw from bytes) equals buildCache(bytes); 1 user name table omitted`);
  }

  // ---- Case 3: user tables omitted, declared counts keep recordCount ----------------------
  {
    const walked = parseCacheRecords(fm3Buf).records;
    const users = walked.filter((r) => isUserNameTable(r.id));
    if (users.length !== 2 || fm3Src.omitted.tables !== 2 || fm3Src.omitted.records !== 2) {
      fail(`FM3 omitted ${JSON.stringify(fm3Src.omitted)} (walk has ${users.length} user tables)`);
    }
    if (fm3Src.records.some((r) => isUserNameTable(r.id))) fail('a user name table reached raw');
    if (fm3Src.records.length !== walked.length - 2) fail(`raw records ${fm3Src.records.length}, want ${walked.length - 2}`);
    const declared = fm3Src.sections.reduce((n, s) => n + s.count, 0);
    if (declared !== walked.length || fm3Src.sections.length !== fm3Walk.sections.length) fail(`declared counts ${declared}/${fm3Src.sections.length}`);
    if (fm3Src.records.some((r) => 'offset' in r || 'nameSpans' in r)) fail('raw records must not carry offsets or name spans');
    // Without the declared counts the omitted preset-name table would shorten GLOBAL's record count.
    const cut = buildDeviceCache(fm3Src.records.map((r) => ({ ...r, offset: 0 }) as CacheRecord), FM3_PARAMS, HW_SEEDS);
    if (cut.rangeSections['GLOBAL']?.recordCount !== 186 || fm3Doc.rangeSections['GLOBAL']?.recordCount !== 187) {
      fail(`GLOBAL recordCount without/with declared counts: ${cut.rangeSections['GLOBAL']?.recordCount}/${fm3Doc.rangeSections['GLOBAL']?.recordCount}`);
    }
    if (fm3Doc.rangeSections['CABINET']?.recordCount !== 110 || fm3Doc.meta.recordCount !== walked.length) {
      fail(`CABINET recordCount ${fm3Doc.rangeSections['CABINET']?.recordCount}, meta.recordCount ${fm3Doc.meta.recordCount}`);
    }
    if (fm3Doc.meta.sources[0]?.records !== walked.length - 2) fail(`summary records ${fm3Doc.meta.sources[0]?.records}`);
    console.log(`  cache/profile-doc: 2 user name tables omitted (${fm3Src.records.length} raw records); declared counts keep GLOBAL 187 / CABINET 110 (186 without)`);
  }

  // ---- Case 4: source identity, header, hash ----------------------------------------------
  {
    const want = createHash('sha256').update(redactCacheUserNames(fm3Buf).bytes).digest('hex');
    if (fm3Src.contentSha256 !== want) fail(`contentSha256 ${fm3Src.contentSha256} vs ${want}`);
    const h = fm3Src.header;
    if (!h || h.major !== 12 || h.minor !== 0 || h.sectionCount !== 45) fail(`header ${JSON.stringify(h)}`);
    if (fm3Src.fileVersion !== '12.0' || fm3Src.firmware !== '12.0') fail(`fileVersion ${fm3Src.fileVersion}, firmware ${fm3Src.firmware}`);
    if (fm3Src.id !== `editor-cache@${stamp}#0` || fm3Src.origin !== 'local' || fm3Src.codecVersion !== VERSION) {
      fail(`identity ${fm3Src.id} ${fm3Src.origin} ${fm3Src.codecVersion}`);
    }
    // The header alone names the firmware when no file name is given; a zero header names none.
    const bare = await rawFromCacheBytes(fm3Buf);
    const zero = await rawFromCacheBytes(encodeWalk(fm3Walk));
    if (bare.firmware !== '12.0' || bare.fileVersion !== null || zero.firmware !== null) {
      fail(`firmware defaults: header ${bare.firmware}, zero header ${zero.firmware}`);
    }
    const m = fm3Doc.meta;
    if (m.format !== PROFILE_FORMAT || m.derivedWith !== VERSION || m.derivedAt !== stamp || m.schema !== CACHE_SCHEMA) {
      fail(`meta ${JSON.stringify({ format: m.format, derivedWith: m.derivedWith, derivedAt: m.derivedAt, schema: m.schema })}`);
    }
    if (m.builtAt !== undefined || (fm3Doc as { raw?: unknown }).raw !== undefined) fail('deriveProfile must not stamp builtAt or carry raw');
    if (compareCodecVersions(VERSION, MIN_DERIVED_WITH) < 0 || compareCodecVersions('0.10.0', '0.9.9') <= 0 || compareCodecVersions('1.2', '1.2.0') !== 0) {
      fail('compareCodecVersions');
    }
    console.log(`  cache/profile-doc: contentSha256 = sha256(redacted bytes); header 12.0/45, id ${fm3Src.id}; meta format ${m.format}, derivedWith ${m.derivedWith}`);
  }

  // ---- Case 5: tolerant source keeps the issues like buildCache --------------------------
  {
    const damaged = Uint8Array.from(fm3Buf);
    const victim = parseCacheRecords(fm3Buf).records.find((r) => r.section === 58 && r.id === 10)!;
    damaged[victim.offset + 4] = 0x7f; // non-zero pad
    const src = await rawFromCacheBytes(damaged, { tolerant: true });
    const built = await buildCache({ kind: 'bytes', buf: damaged, tolerant: true }, FM3_PARAMS, HW_SEEDS, {});
    const doc = deriveProfile(raw(src), FM3_PARAMS, HW_SEEDS, {});
    const diffs = v1Differences(doc, built);
    if (diffs.length > 0) fail(`tolerant determinism:\n  ${diffs.join('\n  ')}`);
    if (!src.issues || src.issues.length !== 1 || src.contentSha256 !== null) fail(`tolerant source: issues ${src.issues?.length}, sha ${src.contentSha256}`);
    if (src.sections.find((s) => s.tag === 58)?.count !== 0) fail('a dropped section counts 0 records');
    let threw = false;
    try {
      await rawFromCacheBytes(damaged);
    } catch {
      threw = true;
    }
    if (!threw) fail('a strict raw source must reject damaged bytes');
    console.log('  cache/profile-doc: tolerant source — issues and dropped section carried exactly like buildCache; strict rejects');
  }

  // ---- Case 6: live source — determinism vs buildCache(live) on the shared fake ------------
  {
    const all = fm3Walk.records;
    const sections = [...new Set(all.filter((r) => r.id < 0xff00).map((r) => r.section))];
    const blocks = [...sections, 0, 5, 99].sort((a, b) => a - b);
    const dev = cacheDevice(all);
    const res = await liveWalkDetailed(dev, { model: 0x11, blocks, maxParamId: 127, sleep: dev.sleep });
    const scope: LiveSourceScope = { blocks, maxParamId: 127, bounds: {}, extended: false, above160: false, hinted: false };
    const src = rawFromLiveWalk(res, scope, { kind: 'live-readonly', capturedAt: stamp, firmware: '12.0' });
    const built = await buildCache({ kind: 'live', walk: async () => res }, FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '12.0' });
    const doc = deriveProfile(raw(src), FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '12.0' });
    const diffs = v1Differences(doc, built);
    if (diffs.length > 0) fail(`live determinism:\n  ${diffs.join('\n  ')}`);
    if (!doc.meta.walk || doc.meta.walk.queries !== res.queries || src.walk.boundHits.length !== 0) fail('live walk stats not carried');
    if (src.records.length !== res.records.length || src.records.some((r) => 'offset' in r)) fail('live raw records');
    if (doc.meta.source !== 'live' || doc.meta.sources[0]?.kind !== 'live-readonly') fail(`live meta ${doc.meta.source}`);
    console.log(`  cache/profile-doc: live — deriveProfile(raw from walk) equals buildCache(live) incl. meta.walk (${res.records.length} records, ${res.queries} queries)`);
  }

  // ---- Case 7: size budget (byte + synthetic live source) ----------------------------------
  // The live source is the byte rows as a hinted walk returns them (labels, a unit on every
  // continuous float). Read-only shape: ids up to 127 (the read-only cap) — expected < 1.2 MiB.
  // Worst case: every ordinary id of every section — within the 2 MiB document budget.
  {
    const syntheticLive = (maxParamId: number): LiveRawSource => {
      const records = fm3Walk.records
        .filter((r) => r.id < 0xff00 && r.id <= maxParamId)
        .map((r) => {
          const { offset: _o, ...rest } = r;
          return r.kind === 'float' && r.max > r.min ? { ...rest, unit: 'dB' } : rest;
        });
      return {
        id: `live-readonly@${stamp}#0`,
        kind: 'live-readonly',
        origin: 'local',
        capturedAt: stamp,
        firmware: '12.0',
        codecVersion: VERSION,
        space: 'block',
        scope: { blocks: [...new Set(records.map((r) => r.section))], maxParamId, bounds: {}, extended: false, above160: false, hinted: true },
        walk: { queries: 0, lostReplies: 0, recoveredReplies: 0, unresolvedReplies: 0, placeholderSlots: 0, missingSlots: 0, silentAddresses: 0, boundHits: [] },
        records: records as LiveRawSource['records'],
      };
    };
    const size = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length;
    const readOnly = buildProfileDoc(raw(fm3Src, syntheticLive(127)), FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '12.0' });
    const whole = buildProfileDoc(raw(fm3Src, syntheticLive(0xfeff)), FM3_PARAMS, HW_SEEDS, { model: 0x11, firmware: '12.0' });
    const a = size(readOnly);
    const b = size(whole);
    if (a >= 1.2 * 1024 * 1024) fail(`read-only shaped document is ${a} bytes (expected < 1.2 MiB)`);
    if (b > 2 * 1024 * 1024) fail(`whole-table document is ${b} bytes (budget 2 MiB)`);
    console.log(
      `  cache/profile-doc: size — byte + read-only live ${(a / 1024).toFixed(0)} KiB (raw ${(size(readOnly.raw) / 1024).toFixed(0)} KiB) < 1.2 MiB; ` +
        `byte + whole-table live ${(b / 1024).toFixed(0)} KiB <= 2 MiB`,
    );
  }

  // ---- Case 8: assertNoUserTables --------------------------------------------------------
  {
    assertNoUserTables({ raw: raw(fm3Src), cabIrs: fm3Doc.cabIrs });
    const injected = { ...fm3Src, records: [...fm3Src.records, { kind: 'enum', section: 1, id: 0xffff, tc: 0, min: 0, max: 0, def: 0, step: 0, count: 1, values: ['secret preset'], x: 0 }] } as RawSource;
    const expectThrow = (what: string, f: () => void) => {
      try {
        f();
      } catch (e) {
        if (!(e instanceof ProfileUserDataError) || e.code !== 'contains-user-data' || e.message.includes('secret')) fail(`${what}: wrong error ${String(e)}`);
        return;
      }
      fail(`${what}: no error`);
    };
    expectThrow('user table in raw', () => assertNoUserTables({ raw: raw(injected) }));
    expectThrow('user bank in cabIrs', () => assertNoUserTables({ cabIrs: { ...fm3Doc.cabIrs, 'USER 1': ['secret cab'] } }));
    expectThrow('deriveProfile refuses user data', () => deriveProfile(raw(injected), FM3_PARAMS, HW_SEEDS));
    console.log('  cache/profile-doc: assertNoUserTables passes a clean document, rejects a user table in raw / a user cab bank (no content in the message)');
  }

  // ---- Case 9: deriveProfile input errors -------------------------------------------------
  {
    const code = (f: () => void): string => {
      try {
        f();
      } catch (e) {
        return e instanceof ProfileDerivationError ? e.code : `other: ${String(e)}`;
      }
      return 'none';
    };
    const checks: Array<[string, string]> = [
      [code(() => deriveProfile({ format: 2 as 1, sources: [fm3Src] }, FM3_PARAMS, HW_SEEDS)), 'unsupported-raw-format'],
      [code(() => deriveProfile(raw(), FM3_PARAMS, HW_SEEDS)), 'no-sources'],
      [code(() => deriveProfile(raw(fm3Src, fm3Src), FM3_PARAMS, HW_SEEDS)), 'duplicate-source-id'],
    ];
    for (const [got, want] of checks) if (got !== want) fail(`input error ${got}, want ${want}`);
    console.log('  cache/profile-doc: deriveProfile rejects a newer raw format, no sources, duplicate source ids');
  }
}

