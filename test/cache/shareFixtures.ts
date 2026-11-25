/**
 * Synthetic golden vectors for the share sanitizer and the fact hash (`src/cache/share.ts`).
 *
 * The vectors are built from COMMITTED catalog rows only (a few FM3 families: ranges, label lists,
 * effect ids, section tags): no cache bytes, no device frames, no captured data. They pin
 * `canonicalJson` and `sourceFactHash` byte for byte, so another implementation (the shared-
 * definitions backend runs on Deno) can reproduce them from the committed files:
 *
 *   - `test/fixtures/share/editor-cache.source.json`  an editor-cache source as shared
 *   - `test/fixtures/share/live-readonly.source.json` a live-readonly source as shared
 *   - `test/fixtures/share/fact-hashes.json`          expected fact hashes, `canonicalJson` vectors,
 *                                                     four tiny sources with their canonical text
 *
 * THESE FILES ARE COPIED VERBATIM INTO THE BACKEND REPOSITORY (axis-cloud), where they pin its
 * own implementation. Changing a byte of them therefore changes the contract: a regeneration
 * means the fact-hash definition changed, and that requires a `FACT_HASH_VERSION` bump (and the
 * backend update that goes with it). The committed files are the golden. Normal runs only READ
 * them; they are rewritten only with
 *
 *   UPDATE_SHARE_GOLDEN=1 npx tsx test/cache/share.test.ts
 *
 * (a catalog change never touches them). The `canonicalJson` vectors and the canonical text of the
 * four tiny sources below are written by hand (`CANONICAL_VECTORS`, `TINY_*_CANONICAL`),
 * independently of the implementation; the tests compare both.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPlaceholderRow, sourceFactCanonical, sourceFactHash, typecodeUnit } from '../../src/cache/index.js';
import type { EditorCacheRawSource, LiveRawSource, RawRecord, RawSource } from '../../src/cache/index.js';
import { FM3_CATALOG_SECTIONS, FM3_EFFECT_IDS, FM3_ENUM_OVERRIDES, FM3_RANGES } from '../../src/gen3/fm3/index.js';

export const SHARE_FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'share');

/** The model byte and firmware the vectors are filed under (an FM3 on a 12.0-style firmware). */
export const VECTOR_MODEL = 0x11;
export const VECTOR_FIRMWARE = '12.0';

/** Families of the vectors, in ascending section tag order (`FM3_CATALOG_SECTIONS`). */
const FAMILIES = ['COMP', 'REVERB', 'DELAY', 'CHORUS'] as const;

const CAPTURED_DAY = '2026-11-22T00:00:00.000Z';
const FIXTURE_CODEC = '0.0.0-fixture';

/** f32 rounding, like the editor cache stores floats (this is where the 6-digit number rule matters). */
const f32 = (x: number): number => (x === 0 ? 0 : Math.fround(x));

function sectionTag(family: string): number {
  const s = FM3_CATALOG_SECTIONS.find((c) => c.family === family);
  if (!s) throw new Error(`share fixtures: no section for ${family}`);
  return s.tag;
}

/** Records of one family from the catalog rows, in id order; `section` is the tag (cache) or effect id (live). */
function familyRecords(family: string, section: number, live: boolean): RawRecord[] {
  const rows = FM3_RANGES[family] ?? {};
  const labels = FM3_ENUM_OVERRIDES[family] ?? {};
  const out: RawRecord[] = [];
  for (const key of Object.keys(rows).sort((a, b) => Number(a) - Number(b))) {
    const row = rows[Number(key)]!;
    const id = Number(key);
    const span = row.displayMax - row.displayMin;
    // A live walk reads a unit token for a continuous float; the catalog rows carry none, so the typecode rule stands in.
    const unit = live && row.kind === 'float' && span > 0 ? (row.unit ?? typecodeUnit(row.typecode)?.unit) : undefined;
    if (row.kind === 'enum') {
      const values = labels[key];
      if (values === undefined) continue; // an enum without a committed label list is left out
      out.push({
        kind: 'enum',
        section,
        id,
        tc: row.typecode,
        min: f32(row.displayMin),
        max: f32(row.displayMax),
        def: row.defaultRaw ?? 0,
        step: f32(row.step),
        count: values.length,
        values: [...values],
        x: 0,
      });
      continue;
    }
    const norm = Math.min(1, Math.max(0, (row.defaultRaw ?? 0) / 65534));
    out.push({
      kind: 'float',
      section,
      id,
      tc: row.typecode,
      min: f32(row.displayMin),
      max: f32(row.displayMax),
      def: f32(row.displayMin + span * norm),
      step: f32(row.step),
      ...(unit !== undefined ? { unit } : {}),
      t1: (row.typecode >> 4) & 0xf,
      t2: row.typecode & 0xf,
      ...(live && isPlaceholderRow(row) ? { placeholder: true } : {}),
    });
  }
  return out;
}

/** An editor-cache source as `shareableSource` leaves it (no `id` / `origin`), from catalog rows. */
export function buildEditorCacheVector(): Omit<EditorCacheRawSource, 'id' | 'origin'> {
  const records: RawRecord[] = [];
  const sections: Array<{ tag: number; count: number }> = [{ tag: 4, count: 1 }]; // holds the omitted name table
  for (const family of FAMILIES) {
    const tag = sectionTag(family);
    const recs = familyRecords(family, tag, false);
    records.push(...recs);
    sections.push({ tag, count: recs.length });
  }
  return {
    kind: 'editor-cache',
    space: 'section',
    capturedAt: CAPTURED_DAY,
    firmware: VECTOR_FIRMWARE,
    codecVersion: FIXTURE_CODEC,
    sections,
    omitted: { tables: 1, records: 1 },
    header: { major: 12, minor: 0, sectionCount: sections.length },
    fileVersion: VECTOR_FIRMWARE,
    contentSha256: null,
    records,
  };
}

/** A live-readonly source as `shareableSource` leaves it (no `id` / `origin`), from catalog rows. */
export function buildLiveReadonlyVector(): Omit<LiveRawSource, 'id' | 'origin'> {
  const records: RawRecord[] = [];
  for (const family of FAMILIES) records.push(...familyRecords(family, FM3_EFFECT_IDS[family]!, true));
  const eids = FAMILIES.map((f) => FM3_EFFECT_IDS[f]!);
  return {
    kind: 'live-readonly',
    space: 'block',
    capturedAt: CAPTURED_DAY,
    firmware: VECTOR_FIRMWARE,
    codecVersion: FIXTURE_CODEC,
    scope: {
      // Deliberately not in ascending order: the hash sorts blocks and id lists.
      blocks: [eids[2]!, eids[3]!, eids[1]!, eids[0]!],
      maxParamId: 127,
      bounds: { [eids[3]!]: 40, [eids[1]!]: 100 },
      idLists: { [eids[2]!]: [140, 128, 129] },
      extended: false,
      above160: false,
      hinted: true,
    },
    walk: {
      queries: 1384,
      lostReplies: 2,
      recoveredReplies: 2,
      unresolvedReplies: 0,
      placeholderSlots: records.filter((r) => r.kind === 'float' && r.placeholder === true).length,
      missingSlots: 0,
      silentAddresses: 0,
      pseudoReplies: { endMarker: 4, duplicateId: 0, implausible: 0 },
      boundHits: [],
      extension: 'skipped',
    },
    records,
  };
}

// ---------------------------------------------------------------------------
// Tiny hand-written sources with hand-written canonical text
// ---------------------------------------------------------------------------

/**
 * Records and sections deliberately out of order, an f32-noise float, a non-ASCII label, an omitted
 * name table. The canonical text below is written by hand from the rules in `src/cache/share.ts`.
 */
export const TINY_EDITOR_CACHE: Omit<EditorCacheRawSource, 'id' | 'origin'> = {
  kind: 'editor-cache',
  space: 'section',
  capturedAt: CAPTURED_DAY,
  firmware: '12.0',
  codecVersion: FIXTURE_CODEC,
  sections: [
    { tag: 7, count: 2 },
    { tag: 4, count: 1 },
  ],
  omitted: { tables: 1, records: 1 },
  header: { major: 12, minor: 0, sectionCount: 2 },
  fileVersion: '12.0',
  contentSha256: null,
  records: [
    { kind: 'float', section: 7, id: 1, tc: 68, min: Math.fround(0.1), max: 1, def: 0.5, step: 0.001, t1: 4, t2: 4 },
    { kind: 'enum', section: 7, id: 0, tc: 16, min: 0, max: 1, def: 0, step: 0, count: 2, values: ['A', 'B \u00e9'], x: 0 },
  ],
};

export const TINY_EDITOR_CACHE_CANONICAL =
  '{"firmware":"12.0","header":{"major":12,"minor":0,"sectionCount":2},"kind":"editor-cache","model":17,' +
  '"omitted":{"records":1,"tables":1},"rawFormat":1,"records":[' +
  '{"count":2,"def":0,"id":0,"kind":"enum","max":1,"min":0,"section":7,"step":0,"tc":16,"values":["A","B \u00e9"],"x":0},' +
  '{"def":0.5,"id":1,"kind":"float","max":1,"min":0.1,"section":7,"step":0.001,"t1":4,"t2":4,"tc":68}],' +
  '"sections":[{"count":1,"tag":4},{"count":2,"tag":7}],"v":1}';

/** A live-full source: a placeholder row, a measured taper (6-digit rounding), unsorted blocks and id lists. */
export const TINY_LIVE_FULL: Omit<LiveRawSource, 'id' | 'origin'> = {
  kind: 'live-full',
  space: 'block',
  capturedAt: CAPTURED_DAY,
  firmware: '13.0',
  codecVersion: FIXTURE_CODEC,
  scope: { blocks: [78, 66], maxParamId: 127, bounds: { 66: 100 }, idLists: { 66: [130, 128] }, extended: true, above160: false, hinted: true },
  walk: {
    queries: 900,
    lostReplies: 0,
    recoveredReplies: 0,
    unresolvedReplies: 0,
    placeholderSlots: 1,
    missingSlots: 0,
    silentAddresses: 0,
    boundHits: [],
    extension: 'done',
  },
  records: [
    {
      kind: 'float',
      section: 66,
      id: 3,
      tc: 353,
      min: -60,
      max: 20,
      def: -12.5,
      step: Math.fround(0.1),
      unit: 'dB',
      t1: 0,
      t2: 1,
      taper: { shape: 'custom', err: 0.0123456789, reliable: true, points: [[0, -60], [0.5, -20.123456789], [1, 20]] },
    },
    { kind: 'float', section: 66, id: 1, tc: 0, min: 0, max: 0, def: 0, step: 0, t1: 0, t2: 0, placeholder: true },
  ],
};

/**
 * The live record projection is kind-free: the unit, the taper, `t1` / `t2`, `kind`, `count` and `x`
 * of the records and `maxParamId` / `bounds` / `idLists` of the scope are in the source but not in the
 * canonical text. Unsorted blocks; a flagged placeholder row.
 */
export const TINY_LIVE_FULL_CANONICAL =
  '{"firmware":"13.0","kind":"live-full","model":17,"rawFormat":1,"records":[' +
  '{"def":0,"id":1,"max":0,"min":0,"placeholder":true,"section":66,"step":0,"tc":0},' +
  '{"def":-12.5,"id":3,"max":20,"min":-60,"section":66,"step":0.1,"tc":353}],' +
  '"scope":{"above160":false,"blocks":[66,78],"extended":true,"hinted":true},"v":1}';

/**
 * A live-readonly source: an enum-shaped record WITHOUT labels (no `values`, no `count` in the text),
 * an enum with labels, a flagged placeholder, a float with a taper, a float with a unit. Records out of
 * order, unsorted blocks.
 */
export const TINY_LIVE_READONLY: Omit<LiveRawSource, 'id' | 'origin'> = {
  kind: 'live-readonly',
  space: 'block',
  capturedAt: CAPTURED_DAY,
  firmware: '12.0',
  codecVersion: FIXTURE_CODEC,
  scope: { blocks: [78, 66], maxParamId: 127, bounds: { 66: 100 }, idLists: { 66: [130, 128] }, extended: false, above160: false, hinted: true },
  walk: {
    queries: 700,
    lostReplies: 1,
    recoveredReplies: 1,
    unresolvedReplies: 0,
    placeholderSlots: 1,
    missingSlots: 0,
    silentAddresses: 0,
    boundHits: [],
    extension: 'skipped',
  },
  records: [
    { kind: 'float', section: 78, id: 1, tc: 353, min: -60, max: 20, def: -12.5, step: Math.fround(0.1), unit: 'dB', t1: 0, t2: 1 },
    { kind: 'enum', section: 66, id: 2, tc: 16, min: 0, max: 2, def: 1, step: 0, count: 3, values: ['A', 'B', 'C'], x: 0 },
    { kind: 'enum', section: 66, id: 1, tc: 16, min: 0, max: 5, def: 2, step: 1, count: 6, values: [], x: 0 },
    { kind: 'float', section: 66, id: 3, tc: 0, min: 0, max: 0, def: 0, step: 0, t1: 0, t2: 0, placeholder: true },
    {
      kind: 'float',
      section: 66,
      id: 4,
      tc: 68,
      min: Math.fround(0.1),
      max: 10,
      def: 5,
      step: 0.001,
      unit: 's',
      t1: 4,
      t2: 4,
      taper: { shape: 'log', err: 0.01, reliable: true, points: [[0, 0.1], [1, 10]] },
    },
  ],
};

export const TINY_LIVE_READONLY_CANONICAL =
  '{"firmware":"12.0","kind":"live-readonly","model":17,"rawFormat":1,"records":[' +
  '{"def":2,"id":1,"max":5,"min":0,"section":66,"step":1,"tc":16},' +
  '{"def":1,"id":2,"max":2,"min":0,"section":66,"step":0,"tc":16,"values":["A","B","C"]},' +
  '{"def":0,"id":3,"max":0,"min":0,"placeholder":true,"section":66,"step":0,"tc":0},' +
  '{"def":5,"id":4,"max":10,"min":0.1,"section":66,"step":0.001,"tc":68},' +
  '{"def":-12.5,"id":1,"max":20,"min":-60,"section":78,"step":0.1,"tc":353}],' +
  '"scope":{"above160":false,"blocks":[66,78],"extended":false,"hinted":true},"v":1}';

/**
 * An editor-cache source for the rules the other vectors leave out: `header: null`, `fileVersion: null`,
 * `capturedAt: null`, an enum with `wireIds`, the integer boundaries (section 65535, typecode and `x`
 * 4294967295, wire ids 0 / 4294967295 / 65536), sections out of order with a repeated tag (sorted by
 * `(tag, count)`), an IDENTICAL duplicate record (collapsed to one), records out of order, f32 noise and a
 * non-integer that rounds to six digits.
 */
export const TINY_EDITOR_CACHE_EDGE: Omit<EditorCacheRawSource, 'id' | 'origin'> = {
  kind: 'editor-cache',
  space: 'section',
  capturedAt: null,
  firmware: '13.0',
  codecVersion: FIXTURE_CODEC,
  sections: [
    { tag: 7, count: 2 },
    { tag: 65535, count: 1 },
    { tag: 0, count: 1 },
    { tag: 7, count: 1 },
  ],
  omitted: { tables: 0, records: 0 },
  header: null,
  fileVersion: null,
  contentSha256: null,
  records: [
    { kind: 'float', section: 7, id: 2, tc: 1393, min: Math.fround(0.01), max: 100, def: 1234567.875, step: 0.001, t1: 7, t2: 1 },
    {
      kind: 'enum',
      section: 65535,
      id: 65279,
      tc: 4294967295,
      min: 0,
      max: 2,
      def: 1,
      step: 0,
      count: 3,
      values: ['x', 'y', 'z'],
      x: 4294967295,
      wireIds: [4294967295, 0, 65536],
    },
    { kind: 'float', section: 0, id: 0, tc: 0, min: 0, max: 0, def: 0, step: 0, t1: 0, t2: 0 },
    { kind: 'float', section: 7, id: 2, tc: 1393, min: Math.fround(0.01), max: 100, def: 1234567.875, step: 0.001, t1: 7, t2: 1 },
  ],
};

export const TINY_EDITOR_CACHE_EDGE_CANONICAL =
  '{"firmware":"13.0","header":null,"kind":"editor-cache","model":17,"omitted":{"records":0,"tables":0},"rawFormat":1,"records":[' +
  '{"def":0,"id":0,"kind":"float","max":0,"min":0,"section":0,"step":0,"t1":0,"t2":0,"tc":0},' +
  '{"def":1234570,"id":2,"kind":"float","max":100,"min":0.01,"section":7,"step":0.001,"t1":7,"t2":1,"tc":1393},' +
  '{"count":3,"def":1,"id":65279,"kind":"enum","max":2,"min":0,"section":65535,"step":0,"tc":4294967295,"values":["x","y","z"],"wireIds":[4294967295,0,65536],"x":4294967295}],' +
  '"sections":[{"count":1,"tag":0},{"count":1,"tag":7},{"count":2,"tag":7},{"count":1,"tag":65535}],"v":1}';

// ---------------------------------------------------------------------------
// canonicalJson vectors (hand-written)
// ---------------------------------------------------------------------------

export interface CanonicalVector {
  name: string;
  input: unknown;
  expected: string;
}

/** Inputs are JSON data (they survive `JSON.parse` of the committed file); `expected` is the canonical text. */
export const CANONICAL_VECTORS: CanonicalVector[] = [
  { name: 'empty containers', input: { a: {}, b: [] }, expected: '{"a":{},"b":[]}' },
  {
    name: 'keys sort by UTF-16 code unit, not numerically',
    input: { b: 1, a: 2, B: 3, 10: 4, 9: 5, '\u00e9': 6, aa: 7 },
    expected: '{"10":4,"9":5,"B":3,"a":2,"aa":7,"b":1,"\u00e9":6}',
  },
  { name: 'literals and nesting', input: { z: null, y: true, x: false, w: [{ b: 1, a: [] }] }, expected: '{"w":[{"a":[],"b":1}],"x":false,"y":true,"z":null}' },
  {
    name: 'integers are exact',
    input: [0, 1, -1, 100, 20000, 1000000, 1234567, 16777216, 1e21],
    expected: '[0,1,-1,100,20000,1000000,1234567,16777216,1e+21]',
  },
  {
    name: 'other numbers have six significant digits',
    input: [0.5, -12.5, 0.1, 0.10000000149011612, 0.30000000000000004, 99.99999, 1234567.875, 0.000123456789, 1e-7, -1.234567e-7],
    expected: '[0.5,-12.5,0.1,0.1,0.3,100,1234570,0.000123457,1e-7,-1.23457e-7]',
  },
  {
    name: 'strings use the ECMAScript JSON form',
    input: ['a"b\\c', 'x\u0001y\nz\tq', '\u00e9\u20ac\u{1f3b8}', '\ud800', '</script>'],
    expected: '["a\\"b\\\\c","x\\u0001y\\nz\\tq","\u00e9\u20ac\u{1f3b8}","\\ud800","</script>"]',
  },
  { name: 'a key needing escapes', input: { 'k"\\': 1 }, expected: '{"k\\"\\\\":1}' },
];

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** One record per line, the other top-level fields as ordinary JSON lines: reviewable and compact. */
function stringifySource(source: object): string {
  const lines = Object.entries(source).map(([k, v]) => {
    if (k !== 'records') return `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
    const recs = (v as unknown[]).map((r) => `    ${JSON.stringify(r)}`).join(',\n');
    return `  "records": [\n${recs}\n  ]`;
  });
  return `{\n${lines.join(',\n')}\n}\n`;
}

/** The fixture files as text, by file name. */
export async function buildShareFixtureFiles(): Promise<Record<string, string>> {
  const editor = buildEditorCacheVector();
  const live = buildLiveReadonlyVector();
  // The cache/live shapes of the tiny sources need an id/origin only for typing; the hash ignores them.
  const withIds = <T extends object>(s: T) => ({ id: 'fixture#0', origin: 'local' as const, ...s }) as unknown as RawSource;
  const hashOf = (s: object, model: number, firmware: string) => sourceFactHash(withIds(s), { model, firmware });
  const canonicalOf = (s: object, model: number, firmware: string) => sourceFactCanonical(withIds(s), { model, firmware });
  const hashes = {
    format: 1,
    factHashVersion: 1,
    description:
      'Golden vectors for canonicalJson and sourceFactHash (synthetic, built from committed catalog rows). ' +
      'A fact hash is sha256 (lower-case hex) of the UTF-8 canonical JSON of the fact document; the sources below are ' +
      'hashed with the given model and firmware. Not part of the fact document, so they must not change the hash: id, ' +
      'origin, capturedAt, codecVersion, fileVersion, contentSha256, issues, the live walk statistics; for live sources ' +
      'also record kind, count, x, t1, t2, unit, taper and the scope maxParamId, bounds and idLists. The vectors are ' +
      'copied verbatim into the backend repository: changing them requires a FACT_HASH_VERSION bump.',
    canonicalJson: CANONICAL_VECTORS,
    sources: [
      { name: 'editor-cache', file: 'editor-cache.source.json', model: VECTOR_MODEL, firmware: VECTOR_FIRMWARE, factHash: await hashOf(editor, VECTOR_MODEL, VECTOR_FIRMWARE) },
      { name: 'live-readonly', file: 'live-readonly.source.json', model: VECTOR_MODEL, firmware: VECTOR_FIRMWARE, factHash: await hashOf(live, VECTOR_MODEL, VECTOR_FIRMWARE) },
    ],
    tiny: await Promise.all(
      [
        { name: 'tiny-editor-cache', model: VECTOR_MODEL, firmware: '12.0', source: TINY_EDITOR_CACHE },
        { name: 'tiny-editor-cache-edge', model: VECTOR_MODEL, firmware: '13.0', source: TINY_EDITOR_CACHE_EDGE },
        { name: 'tiny-live-full', model: VECTOR_MODEL, firmware: '13.0', source: TINY_LIVE_FULL },
        { name: 'tiny-live-readonly', model: VECTOR_MODEL, firmware: '12.0', source: TINY_LIVE_READONLY },
      ].map(async (t) => ({
        ...t,
        canonical: canonicalOf(t.source, t.model, t.firmware),
        factHash: await hashOf(t.source, t.model, t.firmware),
      })),
    ),
  };
  return {
    'editor-cache.source.json': stringifySource(editor),
    'live-readonly.source.json': stringifySource(live),
    'fact-hashes.json': `${JSON.stringify(hashes, null, 2)}\n`,
  };
}

/** Rewrite the committed fixture files (explicit `UPDATE_SHARE_GOLDEN=1` only; see the header). */
export async function writeShareFixtures(): Promise<string[]> {
  const files = await buildShareFixtureFiles();
  mkdirSync(SHARE_FIXTURE_DIR, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(SHARE_FIXTURE_DIR, name), body, 'utf8');
  return Object.keys(files);
}
