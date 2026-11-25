/**
 * Share sanitizer and fact hash (`src/cache/share.ts`).
 *
 *  1. `canonicalJson`: the hand-written vectors (key order, numbers, strings), `-0`, skipped
 *     `undefined` keys, and everything it must refuse.
 *  2. Golden vectors: the committed synthetic sources hash to the committed hashes; the same digest
 *     comes out of `node:crypto` over the canonical text; the four tiny sources match their
 *     hand-written canonical text; the committed sources are already sanitized.
 *  3. `shareableSource` strips and copies: exact key sets, `contentSha256` null, no `id` / `origin` /
 *     `issues` / `abortReason`, nothing shared with the input (no object identity), the input untouched.
 *  4. `capturedAt` coarsening to the UTC day (offsets, date-only, everything unrecognized).
 *  5. Refusals: probe, tolerant source, user name tables (id ranges), duplicates, precedence, no
 *     content echoed.
 *  6. Unknown keys dropped at every level, hostile keys and malformed sources.
 *  7. Real sources from `rawFromCacheBytes`: user tables omitted by construction, the content hash
 *     of the file never leaves, a tolerant parse is refused.
 *  8. Hash stability: key order, record / section / block / id-list order, `id`, `origin`,
 *     `capturedAt`, `codecVersion`, `fileVersion`, `contentSha256`, `issues`, identical duplicates,
 *     unknown keys, f32 noise, sanitizing first; for live sources also kind, unit, taper, `count`,
 *     `x`, `t1`, `t2` and the scope's `maxParamId`, `bounds`, `idLists`, walk statistics.
 *  9. Hash sensitivity: every field the fact document covers changes the hash (editor cache and live
 *     kind-free projection).
 * 10. The key (model, firmware, kind), digest format, `crypto.subtle` vs `node:crypto`, probes.
 * 11. The privacy gate: closed patterns for every free-text field, integer and range rules, no value
 *     in any error message.
 * 12. Duplicates: identical repeats collapse in the hash and stay in the copy, conflicting repeats
 *     and repeated blocks are refused (copy) or throw (hash).
 *
 * Synthetic data only (catalog rows, hand-written records, a synthetic cache); the golden files are
 * rewritten only with `UPDATE_SHARE_GOLDEN=1 npx tsx test/cache/share.test.ts` (which, because the
 * backend repository copies them verbatim, also needs a `FACT_HASH_VERSION` bump).
 */
import { deepStrictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  canonicalJson,
  coarsenCapturedAt,
  FACT_HASH_VERSION,
  isUserNameTable,
  rawFromCacheBytes,
  RAW_FORMAT,
  shareableSource,
  sourceFactCanonical,
  sourceFactHash,
} from '../../src/cache/index.js';
import type { RawRecord, RawSource, ShareableSource, SourceFactKey } from '../../src/cache/index.js';
import { header, pushEnum, pushFloat, pushHead, pushSection, pushTable, pushU16, pushU32 } from './cacheBytes.js';
import {
  CANONICAL_VECTORS,
  SHARE_FIXTURE_DIR,
  TINY_EDITOR_CACHE,
  TINY_EDITOR_CACHE_CANONICAL,
  TINY_EDITOR_CACHE_EDGE,
  TINY_EDITOR_CACHE_EDGE_CANONICAL,
  TINY_LIVE_FULL,
  TINY_LIVE_FULL_CANONICAL,
  TINY_LIVE_READONLY,
  TINY_LIVE_READONLY_CANONICAL,
  VECTOR_FIRMWARE,
  VECTOR_MODEL,
  writeShareFixtures,
} from './shareFixtures.js';

export const SHARE_CASE_COUNT = 12;

const fail = (msg: string): never => {
  throw new Error(`[cache/share] ${msg}`);
};

const KEY: SourceFactKey = { model: VECTOR_MODEL, firmware: VECTOR_FIRMWARE };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const readJson = (name: string): Json => JSON.parse(readFileSync(join(SHARE_FIXTURE_DIR, name), 'utf8')) as Json;
const clone = <T>(v: T): T => structuredClone(v);
/** A vector as a stored source: the id / origin a local source carries. */
const asRaw = (v: object): RawSource => ({ id: 'vector#0', origin: 'local', ...clone(v) }) as unknown as RawSource;
const hashOf = (s: object, key: SourceFactKey = KEY): Promise<string> => sourceFactHash(asRaw(s), key);
const sameJson = (a: unknown, b: unknown, what: string): void => {
  try {
    deepStrictEqual(a, b);
  } catch {
    fail(`${what}: values differ`);
  }
};
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Re-insert every key of every object in a random order, in place (arrays keep their order). */
function reorderKeys(v: unknown, rand: () => number): void {
  if (Array.isArray(v)) {
    for (const x of v) reorderKeys(x, rand);
    return;
  }
  if (v === null || typeof v !== 'object') return;
  const o = v as Record<string, unknown>;
  const entries = shuffled(Object.entries(o), rand);
  for (const k of Object.keys(o)) delete o[k];
  for (const [k, x] of entries) {
    o[k] = x;
    reorderKeys(x, rand);
  }
}

const throwsWith = (what: string, f: () => unknown, kind: ErrorConstructor, secret?: string): void => {
  try {
    f();
  } catch (e) {
    if (!(e instanceof kind)) fail(`${what}: threw ${String(e)}, expected ${kind.name}`);
    if (secret !== undefined && (e as Error).message.includes(secret)) fail(`${what}: the error message echoes a value`);
    return;
  }
  fail(`${what}: did not throw`);
};

/** True when `out` holds, at any depth, an object or array that is also somewhere in `input` (a shared mutable value). */
function sharesObjects(input: unknown, out: unknown): boolean {
  const seen = new Set<object>();
  const collect = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    seen.add(v);
    for (const x of Object.values(v)) collect(x);
  };
  collect(input);
  const hit = (v: unknown): boolean => v !== null && typeof v === 'object' && (seen.has(v) || Object.values(v).some(hit));
  return hit(out);
}

export async function runShare(): Promise<void> {
  if (process.env['UPDATE_SHARE_GOLDEN'] === '1') {
    const written = await writeShareFixtures();
    console.log(`share: UPDATE_SHARE_GOLDEN=1 rewrote ${written.join(', ')} in ${SHARE_FIXTURE_DIR}`);
  }

  const editorVec = readJson('editor-cache.source.json');
  const liveVec = readJson('live-readonly.source.json');
  const goldens = readJson('fact-hashes.json');

  // ---- Case 1: canonicalJson ------------------------------------------------
  {
    for (const v of CANONICAL_VECTORS) {
      const got = canonicalJson(v.input);
      if (got !== v.expected) fail(`canonicalJson vector '${v.name}': ${got} != ${v.expected}`);
    }
    // The committed vectors are the hand-written ones, and they survive a JSON round trip.
    sameJson(goldens['canonicalJson'], CANONICAL_VECTORS, 'committed canonicalJson vectors');
    for (const v of goldens['canonicalJson'] as Array<{ name: string; input: unknown; expected: string }>) {
      if (canonicalJson(v.input) !== v.expected) fail(`committed canonicalJson vector '${v.name}'`);
    }
    // Things the vectors cannot carry.
    if (canonicalJson(-0) !== '0' || canonicalJson([-0, 0]) !== '[0,0]') fail('-0 must be 0');
    if (canonicalJson({ a: undefined, b: 1 }) !== '{"b":1}') fail('an undefined property must be skipped');
    if (canonicalJson(Object.create(null, { x: { value: 1, enumerable: true } })) !== '{"x":1}') fail('a null-prototype object');
    if (canonicalJson('plain') !== '"plain"' || canonicalJson(null) !== 'null' || canonicalJson(7) !== '7') fail('a bare scalar');
    // Insertion order and integer-like keys never matter.
    if (canonicalJson({ b: 1, a: 2, 2: 3, 1: 4 }) !== canonicalJson({ 1: 4, 2: 3, a: 2, b: 1 })) fail('key order');
    // Everything that is not plain JSON data is refused (and no message carries the value).
    throwsWith('NaN', () => canonicalJson({ a: Number.NaN }), TypeError);
    throwsWith('Infinity', () => canonicalJson([Number.POSITIVE_INFINITY]), TypeError);
    throwsWith('-Infinity', () => canonicalJson(Number.NEGATIVE_INFINITY), TypeError);
    throwsWith('undefined', () => canonicalJson(undefined), TypeError);
    throwsWith('undefined element', () => canonicalJson([1, undefined]), TypeError);
    throwsWith('sparse array', () => canonicalJson([1, , 3]), TypeError); // eslint-disable-line no-sparse-arrays
    throwsWith('bigint', () => canonicalJson(10n), TypeError);
    throwsWith('function', () => canonicalJson({ f: () => 1 }), TypeError);
    throwsWith('symbol', () => canonicalJson(Symbol('s')), TypeError);
    throwsWith('Date', () => canonicalJson({ d: new Date(0) }), TypeError);
    throwsWith('Map', () => canonicalJson(new Map()), TypeError);
    class Boxed {
      readonly secret = 'hunter2';
    }
    throwsWith('class instance', () => canonicalJson(new Boxed()), TypeError, 'hunter2');
    let deep: unknown = 1;
    for (let i = 0; i < 80; i++) deep = [deep];
    throwsWith('nesting', () => canonicalJson(deep), RangeError);
    let ok: unknown = 1;
    for (let i = 0; i < 60; i++) ok = [ok];
    if (!canonicalJson(ok).startsWith('[[[[')) fail('60 levels must be accepted');
  }

  // ---- Case 2: golden vectors -----------------------------------------------
  {
    if (goldens['format'] !== 1 || goldens['factHashVersion'] !== FACT_HASH_VERSION || FACT_HASH_VERSION !== 1) fail('golden header');
    if (RAW_FORMAT !== 1) fail('the vectors pin raw format 1; a new raw format needs new vectors');
    for (const c of goldens['sources'] as Array<{ name: string; file: string; model: number; firmware: string; factHash: string }>) {
      const src = readJson(c.file);
      const key = { model: c.model, firmware: c.firmware };
      const got = await hashOf(src, key);
      if (got !== c.factHash) fail(`golden '${c.name}': ${got} != ${c.factHash}`);
      const canonical = sourceFactCanonical(asRaw(src), key);
      if (sha256(canonical) !== c.factHash) fail(`golden '${c.name}': node:crypto digest of the canonical text differs`);
      if (!/^[0-9a-f]{64}$/.test(c.factHash)) fail(`golden '${c.name}': hash format`);
    }
    // The committed sources are already in shared form (and say they are).
    for (const [name, src] of [['editor-cache', editorVec], ['live-readonly', liveVec]] as const) {
      for (const forbidden of ['id', 'origin', 'issues']) if (forbidden in src) fail(`${name} vector carries ${forbidden}`);
      if (name === 'editor-cache' && src['contentSha256'] !== null) fail('editor-cache vector: contentSha256 must be null');
      if (src['capturedAt'] !== coarsenCapturedAt(src['capturedAt'])) fail(`${name} vector: capturedAt is not coarsened`);
      if ((src['records'] as RawRecord[]).some((r) => isUserNameTable(r.id))) fail(`${name} vector holds a user name table`);
      const shared = shareableSource(asRaw(src));
      sameJson(shared, src, `${name} vector is not a fixed point of shareableSource`);
    }
    // The vectors exercise what they are for.
    const editorRecs = editorVec['records'] as RawRecord[];
    if (editorRecs.length < 100 || !editorRecs.some((r) => r.kind === 'enum' && r.values.length > 4)) fail('editor-cache vector is too thin');
    const liveRecs = liveVec['records'] as RawRecord[];
    if (!liveRecs.some((r) => r.kind === 'float' && r.unit !== undefined) || !liveRecs.some((r) => r.kind === 'float' && r.placeholder === true)) {
      fail('live vector lacks a unit or a placeholder row');
    }
    if (!editorRecs.some((r) => r.kind === 'float' && String(r.min).length > 10)) fail('editor-cache vector carries no f32-noise float');
    // The tiny sources: hand-written canonical text == implementation == committed text.
    const tiny = goldens['tiny'] as Array<{ name: string; model: number; firmware: string; source: object; canonical: string; factHash: string }>;
    const want: Record<string, [object, string]> = {
      'tiny-editor-cache': [TINY_EDITOR_CACHE, TINY_EDITOR_CACHE_CANONICAL],
      'tiny-editor-cache-edge': [TINY_EDITOR_CACHE_EDGE, TINY_EDITOR_CACHE_EDGE_CANONICAL],
      'tiny-live-full': [TINY_LIVE_FULL, TINY_LIVE_FULL_CANONICAL],
      'tiny-live-readonly': [TINY_LIVE_READONLY, TINY_LIVE_READONLY_CANONICAL],
    };
    if (tiny.length !== 4) fail('expected four tiny cases');
    for (const t of tiny) {
      const [src, canonical] = want[t.name] ?? fail(`unknown tiny case ${t.name}`);
      const key = { model: t.model, firmware: t.firmware };
      if (sourceFactCanonical(asRaw(src), key) !== canonical) fail(`${t.name}: canonical text differs from the hand-written text`);
      if (t.canonical !== canonical) fail(`${t.name}: committed canonical text differs`);
      sameJson(t.source, JSON.parse(JSON.stringify(src)), `${t.name}: committed source`);
      if (sha256(canonical) !== t.factHash) fail(`${t.name}: committed hash is not sha256 of the canonical text`);
      if ((await hashOf(t.source, key)) !== t.factHash) fail(`${t.name}: hash`);
    }
    // Distinct inputs, distinct goldens.
    const all = [...(goldens['sources'] as Array<{ factHash: string }>), ...tiny].map((c) => c.factHash);
    if (new Set(all).size !== all.length) fail('golden hashes are not distinct');
  }

  // ---- Case 3: shareableSource strips and copies ----------------------------
  {
    const editor = {
      id: 'editor-cache@2026-11-22T10:20:30Z#0',
      origin: 'local',
      ...clone(editorVec),
      capturedAt: '2026-11-22T10:20:30.456Z',
      contentSha256: 'a'.repeat(64),
    };
    const editorBefore = clone(editor);
    const out = shareableSource(editor as unknown as RawSource) as ShareableSource;
    if ('refused' in out) fail('editor-cache refused');
    sameJson(editor, editorBefore, 'the input was modified');
    const want = ['kind', 'space', 'capturedAt', 'firmware', 'codecVersion', 'sections', 'omitted', 'header', 'fileVersion', 'contentSha256', 'records'];
    deepStrictEqual(Object.keys(out), want);
    const o = out as unknown as Json;
    if (o['contentSha256'] !== null) fail('contentSha256 must be null');
    if (o['capturedAt'] !== '2026-11-22T00:00:00.000Z') fail(`capturedAt ${String(o['capturedAt'])}`);
    for (const k of ['id', 'origin', 'issues']) if (k in o) fail(`${k} must be dropped`);
    sameJson({ ...o, capturedAt: editorVec['capturedAt'] }, editorVec, 'editor-cache copy differs from the vector');
    // No aliasing: mutating the copy leaves the input alone.
    (o['records'] as Json[])[0]!['min'] = 12345;
    (o['sections'] as Json[])[0]!['count'] = 999;
    (o['header'] as Json)['major'] = 99;
    (o['records'] as Json[]).find((r) => r['kind'] === 'enum')!['values'].push('X');
    sameJson(editor, editorBefore, 'the copy shares a mutable value with the input');

    const live = {
      id: 'live-readonly@x#0',
      origin: 'cloud',
      ...clone(liveVec),
      capturedAt: '2026-11-22T23:59:59-02:00',
      walk: {
        ...(liveVec['walk'] as Json),
        boundHits: [{ block: 66, lastReal: 98, bound: 100 }],
        extension: 'aborted',
        abortReason: 'free text with a /private/path',
      },
    };
    const liveBefore = clone(live);
    const lout = shareableSource(live as unknown as RawSource) as ShareableSource;
    if ('refused' in lout) fail('live source refused');
    sameJson(live, liveBefore, 'the live input was modified');
    deepStrictEqual(Object.keys(lout), ['kind', 'space', 'capturedAt', 'firmware', 'codecVersion', 'scope', 'walk', 'records']);
    const lo = lout as unknown as Json;
    if (lo['capturedAt'] !== '2026-11-23T00:00:00.000Z') fail(`live capturedAt ${String(lo['capturedAt'])}`);
    if ('abortReason' in lo['walk']) fail('abortReason must be dropped');
    if (lo['walk'].extension !== 'aborted') fail('the extension outcome must stay');
    sameJson(lo['walk'].boundHits, [{ block: 66, lastReal: 98, bound: 100 }], 'boundHits');
    if (JSON.stringify(lout).includes('private')) fail('free text leaked');
    (lo['scope'].blocks as number[]).push(1);
    lo['scope'].idLists['70'].push(1);
    lo['walk'].boundHits.push(1);
    sameJson(live, liveBefore, 'the live copy shares a mutable value with the input');

    // A live-full source passes too; the optional fields travel.
    const full = shareableSource(asRaw(TINY_LIVE_FULL)) as ShareableSource;
    if ('refused' in full || full.kind !== 'live-full') fail('live-full refused');
    sameJson((full.records[0] as Json)['taper'], (TINY_LIVE_FULL.records[0] as Json)['taper'], 'taper copy');
    if ((full.records[1] as Json)['placeholder'] !== true || (full.records[0] as Json)['unit'] !== 'dB') fail('placeholder / unit copy');
    // `placeholder: false` and an absent unit do not turn into keys.
    const quiet = shareableSource(asRaw({ ...TINY_LIVE_FULL, records: [{ ...(TINY_LIVE_FULL.records[1] as object), placeholder: false }] })) as ShareableSource;
    if ('refused' in quiet || 'placeholder' in quiet.records[0]!) fail('placeholder:false must not be copied');
    // Output JSON is plain and round-trips.
    sameJson(JSON.parse(JSON.stringify(full)), full, 'JSON round trip');
    // Every call returns a fresh copy.
    const again = shareableSource(asRaw(TINY_LIVE_FULL)) as ShareableSource;
    if (again === full || again.records === full.records) fail('copies are not fresh');
    // No object or array of the input is anywhere in the output (walk.extension and the like are rebuilt).
    for (const src of [editorVec, liveVec, TINY_EDITOR_CACHE, TINY_EDITOR_CACHE_EDGE, TINY_LIVE_FULL, TINY_LIVE_READONLY]) {
      const input = {
        ...asRaw(src),
        ...(src.kind === 'editor-cache' ? {} : { walk: { ...clone((src as Json)['walk']), boundHits: [{ block: 1, lastReal: 2, bound: 3 }], pseudoReplies: { endMarker: 1, duplicateId: 2, implausible: 3 }, extension: 'done' } }),
      } as unknown as RawSource;
      const copy = shareableSource(input);
      if ('refused' in copy) fail('unexpected refusal');
      if (sharesObjects(input, copy)) fail(`the copy of a ${src.kind} source shares a mutable value with its input`);
    }
  }

  // ---- Case 4: coarsening ----------------------------------------------------
  {
    const day = (d: string) => `${d}T00:00:00.000Z`;
    const vectors: Array<[string | null | undefined, string | null]> = [
      ['2026-11-22T10:15:30Z', day('2026-11-22')],
      ['2026-11-22T00:00:00Z', day('2026-11-22')],
      ['2026-11-22T23:59:59.999Z', day('2026-11-22')],
      ['2026-11-22T10:00Z', day('2026-11-22')],
      ['2026-11-22T10:00:00.123456789Z', day('2026-11-22')],
      ['2026-11-22T01:30:00+05:00', day('2026-11-21')],
      ['2026-11-22T23:30:00-05:00', day('2026-11-23')],
      ['2026-11-22T00:00:00+00:00', day('2026-11-22')],
      ['2026-01-01T00:30:00+01:00', day('2025-12-31')],
      ['2026-11-22', day('2026-11-22')],
      ['2024-02-29T12:00:00Z', day('2024-02-29')],
      ['2000-02-29', day('2000-02-29')],
      ['0005-03-04T00:00:00Z', day('0005-03-04')],
      ['2026-02-29T12:00:00Z', null], // 2026 is not a leap year
      ['1900-02-29', null],
      ['2026-13-01T00:00:00Z', null],
      ['2026-00-10', null],
      ['2026-11-31', null],
      ['2026-11-22T24:00:00Z', null],
      ['2026-11-22T10:60:00Z', null],
      ['2026-11-22T10:00:60Z', null],
      ['2026-11-22T10:00:00+24:00', null],
      ['2026-11-22T10:00:00+0100', null], // the offset needs its colon
      ['2026-11-22T10:00:00', null], // no offset: no instant
      ['2026-11-22 10:00:00Z', null],
      ['2026-11-22T10:00:00z', null],
      ['9999-12-31T23:59:59-05:00', null], // leaves the four-digit years
      ['Nov 22 2026', null],
      ['yesterday', null],
      ['/home/someone/cache', null],
      ['', null],
      [null, null],
      [undefined, null],
    ];
    for (const [input, want] of vectors) {
      const got = coarsenCapturedAt(input);
      if (got !== want) fail(`coarsenCapturedAt(${JSON.stringify(input)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      if (got !== null && coarsenCapturedAt(got) !== got) fail(`coarsenCapturedAt is not idempotent for ${String(input)}`);
    }
    // The source carries it: an unrecognized stamp becomes null, never the original text.
    const odd = shareableSource(asRaw({ ...TINY_EDITOR_CACHE, capturedAt: 'Sunday, 22 Nov 2026 (home studio)' })) as ShareableSource;
    if ('refused' in odd || odd.capturedAt !== null) fail('an unrecognized capturedAt must become null');
    const none = shareableSource(asRaw({ ...TINY_EDITOR_CACHE, capturedAt: null })) as ShareableSource;
    if ('refused' in none || none.capturedAt !== null) fail('a null capturedAt stays null');
  }

  // ---- Case 5: refusals --------------------------------------------------------
  {
    const refused = (s: object): string => {
      const r = shareableSource(asRaw(s)) as Json;
      if (!('refused' in r)) return 'shared';
      deepStrictEqual(Object.keys(r), ['refused']); // the refusal carries nothing else
      return r['refused'] as string;
    };
    if (refused({ ...liveVec, kind: 'live-probe' }) !== 'probe') fail('probe');
    const issue = { section: 3, record: 1, offset: 100, reason: 'BAD-PAD id=0x1', droppedRecords: 2, skippedBytes: 40, resumedAt: null };
    if (refused({ ...editorVec, issues: [issue] }) !== 'tolerant-source') fail('tolerant source');
    if (refused({ ...editorVec, issues: [] }) !== 'tolerant-source') fail('an issues key is enough to refuse');
    if (refused({ ...editorVec, issues: undefined }) !== 'shared') fail('an undefined issues key is no issue');
    // `issues` is an editor-cache concept: on a live source it is just an unknown key.
    if (refused({ ...liveVec, issues: [issue] }) !== 'shared') fail('issues on a live source');
    const withRecord = (base: Json, id: number): object => ({
      ...base,
      records: [...base['records'], { kind: 'enum', section: 3, id, tc: 0, min: 0, max: 1, def: 0, step: 0, count: 1, values: ['PRIVATE NAME'], x: 0 }],
    });
    for (const id of [0xffff, 0xfffe, 0xfff3, 0xfff4, 0xff00, 0xff10, 0xffef]) {
      if (refused(withRecord(editorVec, id)) !== 'user-data') fail(`user table 0x${id.toString(16)} (editor-cache)`);
      if (refused(withRecord(liveVec, id)) !== 'user-data') fail(`user table 0x${id.toString(16)} (live)`);
    }
    for (const id of [0xfff0, 0xfff1, 0xfff2, 0xfeff, 0xfdff, 0x0001]) {
      if (refused(withRecord(editorVec, id)) !== 'shared') fail(`firmware id 0x${id.toString(16)} must be shared`);
    }
    // Precedence: probe, then tolerant, then user data.
    if (refused({ ...withRecord(liveVec, 0xffff), kind: 'live-probe' }) !== 'probe') fail('probe wins over user data');
    if (refused({ ...withRecord(editorVec, 0xffff), issues: [issue] }) !== 'tolerant-source') fail('tolerant wins over user data');
    // A refusal never carries content, whatever the source holds.
    if (JSON.stringify(shareableSource(asRaw(withRecord(editorVec, 0xffff)))).includes('PRIVATE')) fail('a refusal leaked a name');
    // A probe has no fact hash.
    let threw = false;
    try {
      await sourceFactHash(asRaw({ ...liveVec, kind: 'live-probe' }), KEY);
    } catch (e) {
      threw = e instanceof RangeError;
    }
    if (!threw) fail('a live-probe source must not hash');
  }

  // ---- Case 6: unknown keys and malformed sources ------------------------------
  {
    const dirty = clone(editorVec) as Json;
    dirty['extra'] = 1;
    dirty['header'].extraH = 2;
    dirty['omitted'].extraO = 3;
    dirty['sections'][0].extraS = 4;
    dirty['records'][0].extraR = 5;
    const enumIx = (dirty['records'] as Json[]).findIndex((r) => r['kind'] === 'enum');
    dirty['records'][enumIx].nameSpans = [[1, 2]];
    dirty['records'][enumIx].offset = 77;
    dirty['records'].forEach((r: Json) => {
      r['offset'] = 9;
    });
    sameJson(shareableSource(asRaw(dirty)), editorVec, 'unknown keys of an editor-cache source');

    const dirtyLive = clone(liveVec) as Json;
    dirtyLive['extra'] = 1;
    dirtyLive['scope'].extraSc = 1;
    dirtyLive['walk'].extraW = 1;
    dirtyLive['walk'].pseudoReplies.extraP = 1;
    dirtyLive['records'][0].extraR = 1;
    sameJson(shareableSource(asRaw(dirtyLive)), liveVec, 'unknown keys of a live source');
    const tinyDirty = clone(TINY_LIVE_FULL) as Json;
    tinyDirty['records'][0].taper.extraT = 1;
    sameJson((shareableSource(asRaw(tinyDirty)) as Json)['records'][0].taper, (TINY_LIVE_FULL.records[0] as Json)['taper'], 'unknown taper key');

    // A hostile key from parsed JSON never lands on a copy.
    const hostile = JSON.parse(
      JSON.stringify(TINY_EDITOR_CACHE).replace('"kind":"editor-cache"', '"kind":"editor-cache","__proto__":{"polluted":true},"constructor":1'),
    ) as object;
    const cleaned = shareableSource(asRaw(hostile)) as Json;
    if ('polluted' in cleaned || Object.keys(cleaned).includes('__proto__') || Object.keys(cleaned).includes('constructor')) fail('hostile key copied');
    if (({} as Json)['polluted'] !== undefined) fail('prototype polluted');
    // Block-keyed dictionaries take integer keys only (a parsed `__proto__` key included).
    for (const bounds of [{ abc: 5, 66: 100 }, JSON.parse('{"__proto__":5,"66":100}') as object, { '07': 1 }, { '-1': 1 }]) {
      const badScope = { id: 'x', origin: 'local', ...TINY_LIVE_FULL, scope: { ...TINY_LIVE_FULL.scope, bounds } } as unknown as RawSource;
      throwsWith('non-integer scope key', () => shareableSource(badScope), TypeError);
      throwsWith('non-integer scope key (hash)', () => sourceFactCanonical(badScope, KEY), TypeError);
    }
    // Malformed: a TypeError naming a field, never a value. The flag: the fact hash reads the field too.
    const SECRET = 'CONTENT-OF-A-FIELD';
    const malformed: Array<[string, boolean, (s: Json) => void]> = [
      ['min is a string', true, (s) => (s['records'][0].min = SECRET)],
      ['id is NaN', true, (s) => (s['records'][0].id = Number.NaN)],
      ['tc is infinite', true, (s) => (s['records'][0].tc = Number.POSITIVE_INFINITY)],
      ['unit is a number', true, (s) => (s['records'][0].unit = 5)],
      ['record kind unknown', true, (s) => (s['records'][0].kind = SECRET)],
      ['values hold a non-string', true, (s) => (s['records'][enumIx].values[0] = 7)],
      ['records missing', true, (s) => delete s['records']],
      ['records not an array', true, (s) => (s['records'] = SECRET)],
      ['section count missing', true, (s) => delete s['sections'][0].count],
      ['omitted missing', true, (s) => delete s['omitted']],
      ['header field missing', true, (s) => delete s['header'].major],
      ['kind unknown', true, (s) => (s['kind'] = SECRET)],
      ['codecVersion missing', false, (s) => delete s['codecVersion']],
      ['firmware not a string', false, (s) => (s['firmware'] = 12)],
      ['space wrong', false, (s) => (s['space'] = 'block')],
    ];
    for (const [what, hashed, mutate] of malformed) {
      const s = clone(editorVec) as Json;
      mutate(s);
      throwsWith(`shareableSource: ${what}`, () => shareableSource(asRaw(s)), TypeError, SECRET);
      if (hashed) throwsWith(`sourceFactCanonical: ${what}`, () => sourceFactCanonical(asRaw(s), KEY), TypeError, SECRET);
    }
    const malformedLive: Array<[string, (s: Json) => void]> = [
      ['scope.blocks not numbers', (s) => (s['scope'].blocks = ['66'])],
      ['walk missing', (s) => delete s['walk']],
      ['space wrong', (s) => (s['space'] = 'section')],
      ['walk.queries missing', (s) => delete s['walk'].queries],
      ['boundHits entry missing a field', (s) => (s['walk'].boundHits = [{ block: 1 }])],
    ];
    for (const [what, mutate] of malformedLive) {
      const s = clone(liveVec) as Json;
      mutate(s);
      throwsWith(`shareableSource (live): ${what}`, () => shareableSource(asRaw(s)), TypeError);
    }
    // A key that is not usable.
    throwsWith('model not an integer', () => sourceFactCanonical(asRaw(editorVec), { model: 1.5, firmware: '12.0' }), TypeError);
    throwsWith('firmware not a string', () => sourceFactCanonical(asRaw(editorVec), { model: 17, firmware: 12 as unknown as string }), TypeError);
  }

  // ---- Case 7: real sources from rawFromCacheBytes ------------------------------
  {
    const bytes = (broken: boolean): Uint8Array => {
      const a = header({ major: 12, minor: 0, sectionCount: 2 });
      pushSection(a, 1, broken ? 2 : 4);
      pushFloat(a, 0, 2, 0, 0, 0, 1, 0.5);
      if (broken) {
        pushHead(a, 1, 2, 0, 1, 0, 0, 1); // a non-zero pad: the strict walk refuses it
        pushU32(a, 0);
        pushU32(a, 0);
        pushU16(a, 0);
      } else {
        pushEnum(a, 1, ['ON', 'OFF']);
        pushEnum(a, 0xffff, ['My Secret Preset', ''], 0, 0);
        pushTable(a, 0xfff3, ['MY PRIVATE IR'], [7]);
      }
      pushSection(a, 2, 1);
      pushFloat(a, 0, 68, 4, 4, 0.1, 1, 0.5);
      return new Uint8Array(a);
    };
    const fileName = 'effectDefinitions_11_12p0.cache';
    const raw = await rawFromCacheBytes(bytes(false), { fileName, capturedAt: '2026-11-22T10:20:30+01:00', firmware: '12.0' });
    const fileHash = raw.contentSha256;
    if (fileHash === null || raw.omitted.records !== 2 || raw.omitted.tables !== 2 || raw.records.length !== 3) return fail('synthetic raw source');
    const shared = shareableSource(raw);
    if ('refused' in shared) return fail('a source built by the codec was refused');
    if (shared.kind !== 'editor-cache' || shared.contentSha256 !== null) return fail('contentSha256 must not travel');
    if (shared.capturedAt !== '2026-11-22T00:00:00.000Z') fail(`capturedAt ${String(shared.capturedAt)}`);
    const text = JSON.stringify(shared);
    for (const secret of ['Secret', 'PRIVATE', fileHash, raw.id, 'local']) if (text.includes(secret)) fail(`the shared source carries '${secret}'`);
    if (shared.sections.reduce((n, s) => n + s.count, 0) !== shared.records.length + shared.omitted.records) fail('section counts do not add up');
    // Sanitizing first does not change the hash; the key is the caller's.
    const key = { model: 0x11, firmware: '12.0' };
    if ((await sourceFactHash(raw, key)) !== (await sourceFactHash(asRaw(shared), key))) fail('sanitizing changed the fact hash');
    // The same bytes read at another time (another id, stamp, content hash) hash alike.
    const later = await rawFromCacheBytes(bytes(false), { fileName, capturedAt: '2027-01-02T03:04:05Z', firmware: '12.0', seq: 3 });
    later.codecVersion = '9.9.9';
    later.contentSha256 = 'b'.repeat(64);
    if ((await sourceFactHash(later, key)) !== (await sourceFactHash(raw, key))) fail('a re-read of the same bytes hashes differently');
    // A tolerant parse that skipped something is refused.
    const tolerant = await rawFromCacheBytes(bytes(true), { fileName, tolerant: true, firmware: '12.0' });
    if (tolerant.issues === undefined || tolerant.issues.length === 0) fail('the damaged cache produced no issues (test setup)');
    const r = shareableSource(tolerant) as Json;
    if (r['refused'] !== 'tolerant-source') fail('a tolerant source must be refused');
  }

  // ---- Case 8: hash stability ----------------------------------------------------
  {
    const baseE = await hashOf(editorVec);
    const baseL = await hashOf(liveVec);
    const rand = rng(0x5eed);
    const checks: Array<[string, object, string]> = [];
    const variants = (name: string, base: Json, baseHash: string, edits: Array<[string, (s: Json) => void]>): void => {
      for (const [what, edit] of edits) {
        const s = clone(base);
        edit(s);
        checks.push([`${name}: ${what}`, s, baseHash]);
      }
    };
    const floatOf = (s: Json): Json => s['records'].find((r: Json) => r['kind'] === 'float' && r['placeholder'] !== true && r['max'] > r['min']);
    const enumOf = (s: Json): Json => s['records'].find((r: Json) => r['kind'] === 'enum');
    const common: Array<[string, (s: Json) => void]> = [
      ['id', (s) => (s['id'] = 'another#7')],
      ['origin', (s) => (s['origin'] = 'cloud')],
      ['capturedAt', (s) => (s['capturedAt'] = '1999-01-01T00:00:00Z')],
      ['capturedAt null', (s) => (s['capturedAt'] = null)],
      ['codecVersion', (s) => (s['codecVersion'] = '9.9.9')],
      ['source.firmware (the key decides)', (s) => (s['firmware'] = null)],
      ['unknown source key', (s) => (s['mystery'] = { a: 1 })],
      ['unknown record key', (s) => (s['records'][3].offset = 12345)],
      ['every float at six significant digits (f32 noise absorbed)', (s) => {
        for (const r of s['records']) for (const k of ['min', 'max', 'def', 'step']) r[k] = Number(r[k].toPrecision(6));
      }],
      ['record order', (s) => (s['records'] = shuffled(s['records'], rand))],
      ['record order (reversed)', (s) => s['records'].reverse()],
      ['key order', (s) => reorderKeys(s, rand)],
      ['identical duplicate record', (s) => s['records'].push(clone(s['records'][5]))],
      ['identical duplicate record (first)', (s) => s['records'].unshift(clone(s['records'][0]))],
    ];
    variants('editor-cache', editorVec, baseE, [
      ...common,
      ['contentSha256', (s) => (s['contentSha256'] = 'c'.repeat(64))],
      ['fileVersion', (s) => (s['fileVersion'] = '99.9')],
      ['fileVersion null', (s) => (s['fileVersion'] = null)],
      ['issues present', (s) => (s['issues'] = [{ section: 1, record: null, offset: 1, reason: 'x', droppedRecords: 1, skippedBytes: 1, resumedAt: null }])],
      ['section order', (s) => (s['sections'] = shuffled(s['sections'], rand))],
      ['f32 noise on a float', (s) => {
        const r = s['records'].find((x: Json) => x['kind'] === 'float' && x['max'] === 1);
        r.max = 1.0000001;
      }],
    ]);
    // A live hash does not follow the device's current state: kind, unit, taper, t1/t2, count, x, and the
    // host-dependent scope (maxParamId, bounds, idLists) change nothing.
    const labelless = (s: Json): void => {
      Object.assign(floatOf(s), { kind: 'enum', count: 7, values: [], x: 0 });
    };
    variants('live-readonly', liveVec, baseL, [
      ...common,
      ['walk statistics', (s) => Object.assign(s['walk'], { queries: 1, lostReplies: 9, recoveredReplies: 9, unresolvedReplies: 5, missingSlots: 3, silentAddresses: 2, placeholderSlots: 0 })],
      ['walk bound hits', (s) => (s['walk'].boundHits = [{ block: 66, lastReal: 99, bound: 100 }])],
      ['walk extension', (s) => (s['walk'].extension = 'aborted')],
      ['walk abortReason', (s) => (s['walk'].abortReason = 'because')],
      ['walk pseudoReplies', (s) => (s['walk'].pseudoReplies = { endMarker: 0, duplicateId: 8, implausible: 8 })],
      ['walk pseudoReplies absent', (s) => delete s['walk'].pseudoReplies],
      ['scope.blocks order', (s) => (s['scope'].blocks = shuffled(s['scope'].blocks, rand))],
      ['scope.idLists order', (s) => (s['scope'].idLists['70'] = [129, 140, 128])],
      ['scope.idLists changed', (s) => (s['scope'].idLists = { 66: [1, 2, 3] })],
      ['scope.idLists absent', (s) => delete s['scope'].idLists],
      ['scope.bounds changed', (s) => (s['scope'].bounds = {})],
      ['scope.maxParamId', (s) => (s['scope'].maxParamId = 511)],
      ['unit changed on every float', (s) => s['records'].forEach((r: Json) => r['kind'] === 'float' && r['unit'] !== undefined && (r['unit'] = 'ms'))],
      ['unit added on every float', (s) => s['records'].forEach((r: Json) => r['kind'] === 'float' && (r['unit'] = 'Hz'))],
      ['unit removed everywhere', (s) => s['records'].forEach((r: Json) => delete r['unit'])],
      ['taper added', (s) => (floatOf(s)['taper'] = { shape: 'log', err: 0.01, reliable: true, points: [[0, 1], [1, 2]] })],
      ['t1 and t2', (s) => {
        floatOf(s)['t1'] += 1;
        floatOf(s)['t2'] += 1;
      }],
      ['enum count and x', (s) => {
        enumOf(s)['count'] += 1;
        enumOf(s)['x'] += 1;
      }],
      ['a float read as a label-less enum', labelless],
    ]);
    for (const [what, s, want] of checks) {
      if ((await hashOf(s)) !== want) fail(`hash changed: ${what}`);
    }
    // The other direction: a label-less enum read as a float.
    const tinyL = await hashOf(TINY_LIVE_READONLY, { model: VECTOR_MODEL, firmware: '12.0' });
    const labelFree = clone(TINY_LIVE_READONLY) as Json;
    Object.assign(labelFree['records'][2], { kind: 'float', t1: 0, t2: 0 });
    delete labelFree['records'][2].count;
    delete labelFree['records'][2].values;
    delete labelFree['records'][2].x;
    if ((await hashOf(labelFree, { model: VECTOR_MODEL, firmware: '12.0' })) !== tinyL) fail('a label-less enum read as a float changed the live hash');
    // Several at once, repeatedly.
    for (let i = 0; i < 8; i++) {
      const e = clone(editorVec) as Json;
      reorderKeys(e, rand);
      e['records'] = shuffled(e['records'], rand);
      e['sections'] = shuffled(e['sections'], rand);
      e['id'] = `e${i}`;
      if ((await hashOf(e)) !== baseE) fail(`editor-cache: combined reorder ${i}`);
      const l = clone(liveVec) as Json;
      reorderKeys(l, rand);
      l['records'] = shuffled(l['records'], rand);
      l['scope'].blocks = shuffled(l['scope'].blocks, rand);
      l['origin'] = 'file';
      if ((await hashOf(l)) !== baseL) fail(`live-readonly: combined reorder ${i}`);
    }
    // Sanitizing first changes nothing, for every source the case used.
    for (const src of [editorVec, liveVec, TINY_EDITOR_CACHE, TINY_EDITOR_CACHE_EDGE, TINY_LIVE_FULL, TINY_LIVE_READONLY]) {
      const dirty = { ...clone(src), id: 'x', origin: 'local', mystery: 1, contentSha256: src.kind === 'editor-cache' ? 'd'.repeat(64) : undefined } as Json;
      const shared = shareableSource(asRaw(dirty)) as ShareableSource;
      if ('refused' in shared) fail('unexpected refusal');
      const key = { model: VECTOR_MODEL, firmware: String(src.firmware) };
      if ((await hashOf(dirty, key)) !== (await hashOf(shared, key))) fail(`sanitizing changed the hash (${src.kind})`);
    }
  }

  // ---- Case 9: hash sensitivity ---------------------------------------------------
  {
    const mutate = async (name: string, base: Json, edits: Array<[string, (s: Json) => void]>): Promise<void> => {
      const seen = new Map<string, string>([[await hashOf(base), 'base']]);
      for (const [what, edit] of edits) {
        const s = clone(base);
        edit(s);
        const h = await hashOf(s);
        const prior = seen.get(h);
        if (prior !== undefined) fail(`${name}: '${what}' hashes like '${prior}'`);
        seen.set(h, what);
      }
    };
    const floatOf = (s: Json): Json => s['records'].find((r: Json) => r['kind'] === 'float' && r['placeholder'] !== true && r['max'] > r['min']);
    const enumOf = (s: Json): Json => s['records'].find((r: Json) => r['kind'] === 'enum');
    // What both kinds of source cover: the definition itself.
    const definitionEdits: Array<[string, (s: Json) => void]> = [
      ['float.min', (s) => (floatOf(s).min += 1)],
      ['float.max', (s) => (floatOf(s).max += 1)],
      ['float.def', (s) => (floatOf(s).def += 1)],
      ['float.step', (s) => (floatOf(s).step += 1)],
      ['float.tc', (s) => (floatOf(s).tc += 1)],
      ['float.section', (s) => (floatOf(s).section += 1)],
      ['float.id', (s) => (floatOf(s).id += 1000)],
      ['float.placeholder', (s) => (floatOf(s).placeholder = true)],
      ['min by one significant digit', (s) => (floatOf(s).min += 0.5)],
      ['enum.min', (s) => (enumOf(s).min += 1)],
      ['enum.max', (s) => (enumOf(s).max += 1)],
      ['enum.def', (s) => (enumOf(s).def += 1)],
      ['enum.step', (s) => (enumOf(s).step += 1)],
      ['enum.tc', (s) => (enumOf(s).tc += 1)],
      ['enum.values[0]', (s) => (enumOf(s).values[0] += 'x')],
      ['enum.values appended', (s) => enumOf(s).values.push('Extra')],
      ['enum.values reordered', (s) => enumOf(s).values.reverse()],
      ['enum.values emptied', (s) => (enumOf(s).values = [])],
      ['record removed', (s) => s['records'].pop()],
      ['record removed (first)', (s) => s['records'].shift()],
      ['record added', (s) => s['records'].push({ ...floatOf(s), id: 60000 })],
      ['float read as an enum WITH labels', (s) => Object.assign(floatOf(s), { kind: 'enum', count: 1, values: ['A'], x: 0 })],
    ];
    await mutate('editor-cache', editorVec, [
      ...definitionEdits,
      // An editor-cache record is hashed whole.
      ['float.t1', (s) => (floatOf(s).t1 += 1)],
      ['float.t2', (s) => (floatOf(s).t2 += 1)],
      ['float.unit set', (s) => (floatOf(s).unit = 'Hz')],
      ['float.taper', (s) => (floatOf(s).taper = { shape: 'log', err: 0.01, reliable: true, points: [[0, 1], [1, 2]] })],
      ['enum.count', (s) => (enumOf(s).count += 1)],
      ['enum.x', (s) => (enumOf(s).x += 1)],
      ['enum.wireIds', (s) => (enumOf(s).wireIds = [1, 2, 3])],
      ['enum.unit', (s) => (enumOf(s).unit = 'dB')],
      ['record kind flipped', (s) => Object.assign(floatOf(s), { kind: 'enum', count: 1, values: [], x: 0 })],
      ['section tag', (s) => (s['sections'][1].tag += 1)],
      ['section count', (s) => (s['sections'][1].count += 1)],
      ['section removed', (s) => s['sections'].pop()],
      ['section added', (s) => s['sections'].push({ tag: 200, count: 0 })],
      ['header.major', (s) => (s['header'].major += 1)],
      ['header.minor', (s) => (s['header'].minor += 1)],
      ['header.sectionCount', (s) => (s['header'].sectionCount += 1)],
      ['header null', (s) => (s['header'] = null)],
      ['omitted.tables', (s) => (s['omitted'].tables += 1)],
      ['omitted.records', (s) => (s['omitted'].records += 1)],
    ]);
    await mutate('live-readonly', liveVec, [
      ...definitionEdits,
      ['scope.blocks added', (s) => s['scope'].blocks.push(200)],
      ['scope.blocks removed', (s) => s['scope'].blocks.pop()],
      ['scope.extended', (s) => (s['scope'].extended = true)],
      ['scope.above160', (s) => (s['scope'].above160 = true)],
      ['scope.hinted', (s) => (s['scope'].hinted = false)],
      ['kind live-full', (s) => (s['kind'] = 'live-full')],
    ]);
    // The editor-cache and live documents of the same records are different documents.
    const asLive = { ...clone(liveVec), kind: 'live-full' };
    if ((await hashOf(asLive)) === (await hashOf(liveVec))) fail('kind must be part of the hash');
  }

  // ---- Case 10: the key, the digest ------------------------------------------------
  {
    const base = await hashOf(editorVec);
    if (!/^[0-9a-f]{64}$/.test(base)) fail('digest format');
    if ((await hashOf(editorVec, { model: 0x12, firmware: VECTOR_FIRMWARE })) === base) fail('model must be part of the hash');
    if ((await hashOf(editorVec, { model: VECTOR_MODEL, firmware: '12.1' })) === base) fail('firmware must be part of the hash');
    // The key must be canonical.
    for (const firmware of ['12', '12.00', '012.0', '12.0.1', '', ' 12.0', '12.0 ', 'v12.0', '1000.0', '12.-1', '12.x']) {
      throwsWith(`firmware '${firmware}'`, () => sourceFactCanonical(asRaw(editorVec), { model: 17, firmware }), TypeError);
    }
    for (const model of [-1, 256, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '17' as unknown as number]) {
      throwsWith(`model ${String(model)}`, () => sourceFactCanonical(asRaw(editorVec), { model, firmware: '12.0' }), TypeError);
    }
    for (const [model, firmware] of [[0, '0.0'], [255, '999.999'], [17, '13.10']] as const) sourceFactCanonical(asRaw(editorVec), { model, firmware });
    // The fact document, as text.
    const text = sourceFactCanonical(asRaw(TINY_EDITOR_CACHE), KEY);
    const doc = JSON.parse(text) as Json;
    deepStrictEqual(Object.keys(doc), ['firmware', 'header', 'kind', 'model', 'omitted', 'rawFormat', 'records', 'sections', 'v']);
    if (doc['v'] !== FACT_HASH_VERSION || doc['rawFormat'] !== RAW_FORMAT || doc['model'] !== 17 || doc['firmware'] !== '12.0') fail('fact document header');
    const liveDoc = JSON.parse(sourceFactCanonical(asRaw(TINY_LIVE_FULL), KEY)) as Json;
    deepStrictEqual(Object.keys(liveDoc), ['firmware', 'kind', 'model', 'rawFormat', 'records', 'scope', 'v']);
    deepStrictEqual(Object.keys(liveDoc['scope']), ['above160', 'blocks', 'extended', 'hinted']);
    for (const r of liveDoc['records'] as Json[]) {
      for (const k of Object.keys(r)) if (!['def', 'id', 'max', 'min', 'placeholder', 'section', 'step', 'tc', 'values'].includes(k)) fail(`live record key ${k}`);
    }
    // Left out of the document: nothing identifying, nothing about the walk, nothing state-dependent.
    const common = ['capturedAt', 'codecVersion', 'fileVersion', 'contentSha256', 'issues', 'walk', 'origin', '"id":"', 'abortReason'];
    const liveOnly = ['maxParamId', 'bounds', 'idLists', '"unit"', '"taper"', '"t1"', '"t2"', '"count"', '"x"', '"kind":"float"', '"kind":"enum"'];
    for (const banned of [...common, ...liveOnly]) {
      if (sourceFactCanonical(asRaw(liveVec), KEY).includes(banned)) fail(`the live fact document mentions ${banned}`);
    }
    for (const banned of common) {
      if (sourceFactCanonical(asRaw(editorVec), KEY).includes(banned)) fail(`the editor-cache fact document mentions ${banned}`);
    }
    // `crypto.subtle` and `node:crypto` agree on every vector; and the hash needs subtle.
    for (const src of [editorVec, liveVec, TINY_EDITOR_CACHE, TINY_LIVE_FULL]) {
      if ((await hashOf(src)) !== sha256(sourceFactCanonical(asRaw(src), KEY))) fail('digest differs from node:crypto');
    }
    const g = globalThis as { crypto?: unknown };
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    try {
      let rejected = false;
      try {
        await sourceFactHash(asRaw(TINY_EDITOR_CACHE), KEY);
      } catch (e) {
        rejected = e instanceof Error && !(e instanceof TypeError) && /crypto\.subtle/.test(e.message);
      }
      if (!rejected) fail('a runtime without crypto.subtle must reject');
    } finally {
      if (saved) Object.defineProperty(globalThis, 'crypto', saved);
      else delete g.crypto;
    }
    if ((await hashOf(editorVec)) !== base) fail('crypto not restored');
    // Deterministic and non-mutating.
    const input = asRaw(editorVec);
    const before = clone(input);
    const a = await sourceFactHash(input, KEY);
    const b = await sourceFactHash(input, KEY);
    if (a !== b) fail('not deterministic');
    sameJson(input, before, 'sourceFactHash modified its input');
    // Size sanity of the committed vectors (they are copied into another repository).
    for (const name of ['editor-cache.source.json', 'live-readonly.source.json', 'fact-hashes.json']) {
      const size = readFileSync(join(SHARE_FIXTURE_DIR, name)).length;
      if (size > 200_000) fail(`${name} is ${size} bytes`);
    }
    const sizeOf = (s: object): number => Buffer.byteLength(JSON.stringify(s), 'utf8');
    if (sizeOf(editorVec) > 2 * 1024 * 1024 || sizeOf(liveVec) > 2 * 1024 * 1024) fail('a vector exceeds the contribution size limit');
  }

  // ---- Case 11: the privacy gate ----------------------------------------------------
  {
    const PRIV = '/home/someone/Recorded at home';
    const set = (o: Json, path: string, value: unknown): unknown => {
      const parts = path.split('.');
      let at = o;
      for (const p of parts.slice(0, -1)) at = at[p];
      at[parts[parts.length - 1]!] = value;
      return value;
    };
    const liveHits = {
      ...clone(TINY_LIVE_READONLY),
      walk: { ...clone(TINY_LIVE_READONLY.walk), boundHits: [{ block: 66, lastReal: 98, bound: 100 }], pseudoReplies: { endMarker: 1, duplicateId: 0, implausible: 0 } },
    };
    // Free text: closed patterns. [what, base, path, value, the fact hash reads it too]
    const text: Array<[string, object, string, unknown, boolean]> = [
      ['extension object', TINY_LIVE_FULL, 'walk.extension', { path: PRIV }, false],
      ['extension text', TINY_LIVE_FULL, 'walk.extension', PRIV, false],
      ['extension path', TINY_LIVE_FULL, 'walk.extension', 'C:/Users/someone', false],
      ['extension case', TINY_LIVE_FULL, 'walk.extension', 'Done', false],
      ['extension number', TINY_LIVE_FULL, 'walk.extension', 1, false],
      ['taper shape text', TINY_LIVE_FULL, 'records.0.taper.shape', PRIV, true],
      ['taper shape case', TINY_LIVE_FULL, 'records.0.taper.shape', 'LOG', true],
      ['taper reliable', TINY_LIVE_FULL, 'records.0.taper.reliable', 'yes', true],
      ['taper err', TINY_LIVE_FULL, 'records.0.taper.err', PRIV, true],
      ['taper points', TINY_LIVE_FULL, 'records.0.taper.points', [[1]], true],
      ['unit text', TINY_LIVE_FULL, 'records.0.unit', PRIV, true],
      ['unit words', TINY_LIVE_FULL, 'records.0.unit', 'my name is X', true],
      ['unit long', TINY_LIVE_FULL, 'records.0.unit', 'ABCDEFGHI', true],
      ['unit empty', TINY_LIVE_FULL, 'records.0.unit', '', true],
      ['unit space', TINY_LIVE_FULL, 'records.0.unit', 'dB ', true],
      ['unit digit', TINY_LIVE_FULL, 'records.0.unit', 'x2', true],
      ['unit number', TINY_LIVE_FULL, 'records.0.unit', 5, true],
      ['unit on an enum', TINY_EDITOR_CACHE, 'records.1.unit', PRIV, true],
      ['firmware text', TINY_EDITOR_CACHE, 'firmware', 'DESKTOP-PASCAL', false],
      ['firmware leading zero', TINY_EDITOR_CACHE, 'firmware', '012.0', false],
      ['firmware two zeros', TINY_EDITOR_CACHE, 'firmware', '12.00', false],
      ['firmware no minor', TINY_EDITOR_CACHE, 'firmware', '12', false],
      ['firmware suffix', TINY_EDITOR_CACHE, 'firmware', '12.0.1', false],
      ['firmware space', TINY_EDITOR_CACHE, 'firmware', '12.0 ', false],
      ['firmware empty', TINY_EDITOR_CACHE, 'firmware', '', false],
      ['firmware number', TINY_EDITOR_CACHE, 'firmware', 12, false],
      ['fileVersion path', TINY_EDITOR_CACHE, 'fileVersion', '/Users/x/effectDefinitions_11_12p0.cache', false],
      ['fileVersion leading zero', TINY_EDITOR_CACHE, 'fileVersion', '12.01', false],
      ['codecVersion non-ASCII', TINY_EDITOR_CACHE, 'codecVersion', 'host=\u00e9', false],
      ['codecVersion long', TINY_EDITOR_CACHE, 'codecVersion', 'a'.repeat(65), false],
      ['codecVersion control', TINY_EDITOR_CACHE, 'codecVersion', 'a\nb', false],
      ['codecVersion number', TINY_EDITOR_CACHE, 'codecVersion', 5, false],
      ['codecVersion missing', TINY_EDITOR_CACHE, 'codecVersion', undefined, false],
      ['value label', TINY_EDITOR_CACHE, 'records.1.values.0', 7, true],
    ];
    for (const [what, base, path, value, hashed] of text) {
      const s = clone(base) as Json;
      set(s, path, value);
      const secrets = [PRIV, 'someone', 'DESKTOP-PASCAL', typeof value === 'string' && value.length >= 4 ? value : PRIV];
      for (const secret of secrets) throwsWith(`${what}`, () => shareableSource(asRaw(s)), TypeError, secret);
      if (hashed) throwsWith(`${what} (fact hash)`, () => sourceFactCanonical(asRaw(s), { model: 17, firmware: String(s['firmware']) }), TypeError, PRIV);
    }
    // Objects that are not objects.
    const shape: Array<[string, object, string, unknown]> = [
      ['pseudoReplies null', liveHits, 'walk.pseudoReplies', null],
      ['walk null', liveHits, 'walk', null],
      ['scope null', liveHits, 'scope', null],
      ['scope array', liveHits, 'scope', []],
      ['boundHits entry null', liveHits, 'walk.boundHits.0', null],
      ['scope flag text', liveHits, 'scope.hinted', 'yes'],
      ['header text', TINY_EDITOR_CACHE, 'header', PRIV],
      ['omitted null', TINY_EDITOR_CACHE, 'omitted', null],
      ['section entry null', TINY_EDITOR_CACHE, 'sections.0', null],
      ['record null', TINY_EDITOR_CACHE, 'records.0', null],
      ['record text', TINY_EDITOR_CACHE, 'records.0', PRIV],
      ['source text', TINY_EDITOR_CACHE, 'records', PRIV],
    ];
    for (const [what, base, path, value] of shape) {
      const s = clone(base) as Json;
      set(s, path, value);
      throwsWith(what, () => shareableSource(asRaw(s)), TypeError, PRIV);
    }
    throwsWith('source null', () => shareableSource(null as unknown as RawSource), TypeError);
    // What a real source holds is accepted and copied verbatim.
    for (const unit of ['dB', 'Hz', '%', '\u00b0', '\u00b5s', 'k\u03a9', 'dB/OCT', 'SAMPLES', 'SECONDS', 'ct']) {
      const out = shareableSource(asRaw({ ...TINY_LIVE_FULL, records: [{ ...(TINY_LIVE_FULL.records[0] as object), unit }] })) as ShareableSource;
      if ('refused' in out || (out.records[0] as Json)['unit'] !== unit) fail(`unit ${unit} must be accepted`);
    }
    for (const shape of ['linear', 'log', 'flat', 'custom', 'unknown']) {
      const s = clone(TINY_LIVE_FULL) as Json;
      s['records'][0].taper.shape = shape;
      const out = shareableSource(asRaw(s)) as Json;
      if ('refused' in out || out['records'][0].taper.shape !== shape) fail(`taper shape ${shape} must be accepted`);
    }
    for (const ext of ['done', 'skipped', 'aborted']) {
      const s = clone(TINY_LIVE_FULL) as Json;
      s['walk'].extension = ext;
      const out = shareableSource(asRaw(s)) as Json;
      if (out['walk'].extension !== ext || typeof out['walk'].extension !== 'string') fail(`extension ${ext} must be accepted as a string`);
    }
    for (const firmware of ['0.0', '12.0', '13.10', '32.6', '999.999']) {
      const out = shareableSource(asRaw({ ...TINY_EDITOR_CACHE, firmware, fileVersion: firmware })) as ShareableSource;
      if ('refused' in out || out.firmware !== firmware) fail(`firmware ${firmware} must be accepted`);
    }
    for (const codecVersion of ['', '0.4.3', '0.5.0-rc.1+build 7', 'a'.repeat(64)]) {
      const out = shareableSource(asRaw({ ...TINY_EDITOR_CACHE, codecVersion })) as ShareableSource;
      if ('refused' in out || out.codecVersion !== codecVersion) fail(`codecVersion '${codecVersion}' must be accepted`);
    }

    // Integers and ranges. [base, path, maximum, the fact hash reads it too]
    const numbers: Array<[object, string, number, boolean]> = [
      [TINY_EDITOR_CACHE, 'records.0.section', 0xffff, true],
      [TINY_EDITOR_CACHE, 'records.0.id', 0xffff, true],
      [TINY_EDITOR_CACHE, 'records.0.tc', 0xffffffff, true],
      [TINY_EDITOR_CACHE, 'records.0.t1', 0xffffffff, true],
      [TINY_EDITOR_CACHE, 'records.0.t2', 0xffffffff, true],
      [TINY_EDITOR_CACHE, 'records.1.count', 0xffffffff, true],
      [TINY_EDITOR_CACHE, 'records.1.x', 0xffffffff, true],
      [TINY_EDITOR_CACHE_EDGE, 'records.1.wireIds.0', 0xffffffff, true],
      [TINY_EDITOR_CACHE_EDGE, 'sections.0.tag', 0xffff, true],
      [TINY_EDITOR_CACHE_EDGE, 'sections.0.count', 0xffffffff, true],
      [TINY_EDITOR_CACHE_EDGE, 'omitted.tables', 0xffffffff, true],
      [TINY_EDITOR_CACHE_EDGE, 'omitted.records', 0xffffffff, true],
      [TINY_EDITOR_CACHE, 'header.major', 0xffff, true],
      [TINY_EDITOR_CACHE, 'header.minor', 0xffff, true],
      [TINY_EDITOR_CACHE, 'header.sectionCount', 0xffffffff, true],
      [TINY_LIVE_FULL, 'scope.blocks.0', 0xffff, true],
      [TINY_LIVE_FULL, 'scope.maxParamId', 0xffff, true],
      [TINY_LIVE_FULL, 'scope.bounds.66', 0xffff, true],
      [TINY_LIVE_FULL, 'scope.idLists.66.0', 0xffff, true],
      [TINY_LIVE_FULL, 'walk.queries', 0xffffffff, false],
      [TINY_LIVE_FULL, 'walk.lostReplies', 0xffffffff, false],
      [TINY_LIVE_FULL, 'walk.recoveredReplies', 0xffffffff, false],
      [TINY_LIVE_FULL, 'walk.unresolvedReplies', 0xffffffff, false],
      [TINY_LIVE_FULL, 'walk.placeholderSlots', 0xffffffff, false],
      [TINY_LIVE_FULL, 'walk.missingSlots', 0xffffffff, false],
      [TINY_LIVE_FULL, 'walk.silentAddresses', 0xffffffff, false],
      [liveHits, 'walk.pseudoReplies.endMarker', 0xffffffff, false],
      [liveHits, 'walk.pseudoReplies.duplicateId', 0xffffffff, false],
      [liveHits, 'walk.pseudoReplies.implausible', 0xffffffff, false],
      [liveHits, 'walk.boundHits.0.block', 0xffff, false],
      [liveHits, 'walk.boundHits.0.lastReal', 0xffff, false],
      [liveHits, 'walk.boundHits.0.bound', 0xffff, false],
    ];
    for (const [base, path, max, hashed] of numbers) {
      const key = { model: VECTOR_MODEL, firmware: String((base as Json)['firmware']) };
      for (const value of [0.5, 1.5, -1, max + 1, Number.NaN, Number.POSITIVE_INFINITY, '1', true, null]) {
        const s = clone(base) as Json;
        set(s, path, value);
        throwsWith(`${path} = ${String(value)}`, () => shareableSource(asRaw(s)), TypeError);
        if (hashed) throwsWith(`${path} = ${String(value)} (fact hash)`, () => sourceFactCanonical(asRaw(s), key), TypeError);
      }
      // The boundaries themselves are fine (a record id of 0xffff is a user name table: refused, not malformed).
      for (const value of path.endsWith('.id') ? [5] : [0, max]) {
        const s = clone(base) as Json;
        set(s, path, value);
        const out = shareableSource(asRaw(s));
        if ('refused' in out) fail(`${path} = ${value} was refused`);
        if (hashed) sourceFactCanonical(asRaw(s), key);
      }
    }
    // The reviewer's probes: a non-integer or negative id next to a user table range.
    for (const id of [65535.5, -1, 65536, 0xff00 - 0.5]) {
      const s = clone(editorVec) as Json;
      s['records'].push({ kind: 'enum', section: 4, id, tc: 0, min: 0, max: 1, def: 0, step: 0, count: 1, values: ['My Preset'], x: 0 });
      throwsWith(`record id ${id}`, () => shareableSource(asRaw(s)), TypeError, 'My Preset');
    }
    const userId = clone(editorVec) as Json;
    userId['records'].push({ kind: 'enum', section: 4, id: 65535, tc: 0, min: 0, max: 1, def: 0, step: 0, count: 1, values: ['My Preset'], x: 0 });
    if ((shareableSource(asRaw(userId)) as Json)['refused'] !== 'user-data') fail('id 65535 is a user name table');
    // Floats: finite, bounded; -0 becomes 0.
    for (const field of ['min', 'max', 'def', 'step']) {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 3.6e38, -3.6e38, '1', null]) {
        const s = clone(TINY_EDITOR_CACHE) as Json;
        set(s, `records.0.${field}`, value);
        throwsWith(`${field} = ${String(value)}`, () => shareableSource(asRaw(s)), TypeError);
        throwsWith(`${field} = ${String(value)} (fact hash)`, () => sourceFactCanonical(asRaw(s), KEY), TypeError);
      }
    }
    const negZero = clone(TINY_EDITOR_CACHE) as Json;
    set(negZero, 'records.0.min', -0);
    set(negZero, 'records.0.t1', -0);
    const nz = shareableSource(asRaw(negZero)) as Json;
    if (!Object.is(nz['records'][0].min, 0) || !Object.is(nz['records'][0].t1, 0)) fail('-0 must be copied as 0');
    for (const v of [3.4e38, -3.4e38, 1e-39]) {
      const s = clone(TINY_EDITOR_CACHE) as Json;
      set(s, 'records.0.max', v);
      shareableSource(asRaw(s));
    }
  }

  // ---- Case 12: duplicates ----------------------------------------------------------
  {
    const refusedOf = (s: object): string => {
      const r = shareableSource(asRaw(s)) as Json;
      return 'refused' in r ? (r['refused'] as string) : 'shared';
    };
    const repeat = (base: Json, i: number, patch: object): Json => {
      const s = clone(base);
      s['records'].push({ ...clone(s['records'][i]), ...patch });
      return s;
    };
    const floatAt = (base: Json): number => base['records'].findIndex((r: Json) => r['kind'] === 'float' && r['placeholder'] !== true && r['max'] > r['min']);
    const baseE = await hashOf(editorVec);
    const baseL = await hashOf(liveVec);
    const ie = floatAt(editorVec);
    const il = floatAt(liveVec);

    // Identical repeats: kept in the copy (the section counts still add up), one record in the hash.
    for (const [name, vec, i, base] of [['editor-cache', editorVec, ie, baseE], ['live-readonly', liveVec, il, baseL]] as const) {
      const s = repeat(vec, i, {});
      const out = shareableSource(asRaw(s)) as ShareableSource;
      if ('refused' in out) fail(`${name}: an identical repeat was refused`);
      if (out.records.length !== vec['records'].length + 1) fail(`${name}: the copy must keep an identical repeat`);
      if ((await hashOf(s)) !== base) fail(`${name}: an identical repeat changed the hash`);
      // A repeat that differs only below six significant digits (f32 noise) is identical too.
      const n = vec['records'].findIndex((r: Json) => r['kind'] === 'float' && r['placeholder'] !== true && String(r['min']).length > 10);
      if (n < 0) fail(`${name}: no f32-noise float in the vector`);
      const noise = repeat(vec, n, { min: Number(vec['records'][n].min.toPrecision(6)) });
      if (noise['records'][noise['records'].length - 1].min === vec['records'][n].min) fail('test setup: the repeat is bit-identical');
      if (refusedOf(noise) !== 'shared' || (await hashOf(noise)) !== base) fail(`${name}: a repeat equal at six digits must count as identical`);
    }
    // Conflicting repeats: refused by the copy, an error for the hash.
    const conflicts: Array<[string, Json, number, object]> = [
      ['editor def', editorVec, ie, { def: 12345 }],
      ['editor max', editorVec, ie, { max: 5e6 }],
      ['editor tc', editorVec, ie, { tc: 7 }],
      ['editor unit', editorVec, ie, { unit: 'Hz' }],
      ['editor kind', editorVec, ie, { kind: 'enum', count: 1, values: ['A'], x: 0 }],
      ['editor kind (label-less)', editorVec, ie, { kind: 'enum', count: 1, values: [], x: 0 }],
      ['editor t1', editorVec, ie, { t1: 9 }],
      ['live def', liveVec, il, { def: 12345 }],
      ['live min', liveVec, il, { min: -777 }],
      ['live tc', liveVec, il, { tc: 7 }],
      ['live placeholder', liveVec, il, { placeholder: true }],
      ['live kind with labels', liveVec, il, { kind: 'enum', count: 1, values: ['A'], x: 0 }],
    ];
    for (const [what, vec, i, patch] of conflicts) {
      const s = repeat(vec, i, patch);
      if (refusedOf(s) !== 'duplicates') fail(`${what}: a conflicting repeat must be refused`);
      throwsWith(`${what}: fact hash`, () => sourceFactCanonical(asRaw(s), KEY), TypeError);
    }
    // For a live source "differs" is what the hash sees: unit, taper, t1/t2 and a label-less kind flip are not content.
    const sameLive: Array<[string, object]> = [
      ['unit', { unit: 'ms' }],
      ['taper', { taper: { shape: 'log', err: 0.01, reliable: true, points: [[0, 1], [1, 2]] } }],
      ['t1', { t1: 9, t2: 9 }],
      ['label-less enum', { kind: 'enum', count: 3, values: [], x: 0 }],
    ];
    for (const [what, patch] of sameLive) {
      const s = repeat(liveVec, il, patch);
      if (refusedOf(s) !== 'shared' || (await hashOf(s)) !== baseL) fail(`live repeat differing only in ${what} must be identical`);
    }
    // The same position in two sections is not a repeat.
    const apart = repeat(editorVec, ie, { section: 3 });
    if (refusedOf(apart) !== 'shared') fail('the same id in another section is not a repeat');
    if ((await hashOf(apart)) === baseE) fail('an added record must change the hash');
    // Repeated blocks.
    for (const [name, vec] of [['live-readonly', liveVec], ['live-full', { ...clone(liveVec), kind: 'live-full' }]] as const) {
      const s = clone(vec) as Json;
      s['scope'].blocks.push(s['scope'].blocks[0]);
      if (refusedOf(s) !== 'duplicates') fail(`${name}: a repeated block must be refused`);
      throwsWith(`${name}: repeated block (fact hash)`, () => sourceFactCanonical(asRaw(s), KEY), TypeError);
    }
    // Precedence: probe, tolerant, user data, then duplicates.
    const both = repeat(editorVec, ie, { def: 12345 });
    both['records'].push({ kind: 'enum', section: 3, id: 0xffff, tc: 0, min: 0, max: 1, def: 0, step: 0, count: 1, values: ['PRIVATE'], x: 0 });
    if (refusedOf(both) !== 'user-data') fail('user data wins over duplicates');
    both['issues'] = [];
    if (refusedOf(both) !== 'tolerant-source') fail('tolerant wins over duplicates');
    const probe = repeat(liveVec, il, { def: 12345 });
    probe['kind'] = 'live-probe';
    if (refusedOf(probe) !== 'probe') fail('probe wins over duplicates');
    // The committed edge vector carries an identical repeat on purpose.
    const edge = clone(TINY_EDITOR_CACHE_EDGE) as Json;
    const edgeKey = { model: VECTOR_MODEL, firmware: '13.0' };
    const withRepeat = await hashOf(edge, edgeKey);
    edge['records'].pop();
    if ((await hashOf(edge, edgeKey)) !== withRepeat) fail('the edge vector\'s repeat must collapse');
    // The refusal reason is exactly 'duplicates' and carries nothing else.
    deepStrictEqual(shareableSource(asRaw(repeat(editorVec, ie, { def: 12345 }))), { refused: 'duplicates' });
  }
}

// `UPDATE_SHARE_GOLDEN=1 npx tsx test/cache/share.test.ts` runs this suite on its own (and rewrites the vectors).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runShare();
  console.log('PASS cache/share');
}
