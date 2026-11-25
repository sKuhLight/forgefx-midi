/**
 * Sharing raw definition sources: the sanitizer and the content fact hash.
 *
 * A raw source (`RawSource`, ./profileDoc.ts) holds firmware definitions only: ids, typecodes,
 * ranges, steps, label lists, section counts, the live scope and walk statistics. Before one leaves
 * the machine (a shared-definitions backend, a definitions file) two things are needed, and both
 * live here so every host and the backend agree on them byte for byte:
 *
 *   - `shareableSource`: a field-by-field COPY of a source with everything that identifies the
 *     installation or the moment removed, every free-text field checked against a closed pattern,
 *     or a refusal when the source must not be shared at all;
 *   - `sourceFactHash`: a sha256 over the CONTENT of a source (what it says about the firmware,
 *     not who read it, when, or in what state the device was), so two complete reads of the same
 *     firmware hash alike. Built on `canonicalJson`, a deterministic JSON text.
 *
 * Both are pure. The hash uses `globalThis.crypto.subtle` (browsers, Node >= 20, Deno); nothing
 * here imports a `node:*` module.
 *
 * ## The shared shape and its checks (`shareableSource`, `sourceFactCanonical`)
 *
 * Every field the shared shape names is checked; a violation throws `TypeError` naming the field
 * (never its value). Unknown keys are dropped, never copied. `-0` becomes `0`.
 *   - integers (a non-integer, a negative or an over-range value is refused): `section`, `id`,
 *     section `tag`, header `major` / `minor`, `scope.blocks` entries, `scope.maxParamId`,
 *     `scope.bounds` values and `scope.idLists` entries, boundHit fields: 0..65535;
 *     `tc`, `count`, `x`, `t1`, `t2`, `wireIds` entries, section `count`, header `sectionCount`,
 *     `omitted` counts, walk statistics: 0..4294967295;
 *   - floats (`min`, `max`, `def`, `step`, taper `err` and points): finite, magnitude <= 3.5e38;
 *   - `unit`: the walker's `UNIT_RE` (`^[A-Za-z%°µΩ/]{1,8}$`, ./liveWalk.ts);
 *   - `taper.shape`: `linear | log | flat | custom | unknown`; `walk.extension`: `done | skipped |
 *     aborted` (copied as that string, never as an object);
 *   - `firmware`, `fileVersion`: `null` or canonical `<major>.<minor>` (`^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$`,
 *     no leading zeros); `codecVersion`: printable ASCII, at most 64 characters;
 *   - block-keyed dictionaries (`scope.bounds`, `scope.idLists`): plain decimal integer keys only.
 * The copy shares no mutable value with its input: every object, array and primitive is rebuilt.
 *
 * Duplicates: two records with the same `(section, id)` (whatever their kind) are one position.
 * Identical repeats are harmless (a derivation keeps the first), a repeat whose content differs is
 * ambiguous, so `shareableSource` REFUSES it (`duplicates`; identical repeats are kept as they are,
 * so the section counts still add up) and `sourceFactCanonical` throws `TypeError`. "Content" is
 * what the fact hash sees of a record (below): the whole record of an editor cache, the kind-free
 * projection of a live record (two live repeats that differ only in unit or taper are identical).
 * Repeated entries in `scope.blocks` are refused the same way.
 *
 * ## `canonicalJson` (the text that is hashed)
 *
 * A JSON text with exactly one spelling per value, so another implementation can reproduce it:
 *   - no whitespace anywhere;
 *   - objects: own enumerable string keys, an entry whose value is `undefined` skipped, the
 *     remaining keys in ASCENDING order of their UTF-16 code units (the default JavaScript string
 *     order, so `"10"` sorts before `"9"`), each as `<key as a JSON string>:<value>`;
 *   - arrays: elements in order, separated by `,`; an `undefined` element is an error;
 *   - `null`, `true`, `false` as in JSON;
 *   - strings: `JSON.stringify(string)` (the ECMAScript JSON string form: `"` `\` and the C0
 *     controls escaped, `\b \f \n \r \t` short forms, other controls as `\u00xx` with lower-case
 *     hex, every other code point written as is, a lone surrogate as `\udxxx`);
 *   - numbers must be finite; an INTEGER is its decimal digits (`String(n)`, `-0` is `0`); any
 *     other number is the canonical number text of the parameter fingerprint (./fingerprint.ts,
 *     `canonicalNumber`): `String(Number(x.toPrecision(6)))`, six significant digits, which absorbs
 *     the f32 noise between differently derived tables (`0.10000000149011612` is `0.1`);
 *   - anything else (NaN, an infinity, `undefined`, a bigint, a function, a symbol, a class
 *     instance such as a `Date`, nesting deeper than 64 levels) throws.
 * The number rule is lossy by design: the text is for hashing, never for storing.
 *
 * ## The fact hash (`FACT_HASH_VERSION` 1)
 *
 * `sha256(utf8(canonicalJson(doc)))` as 64 lower-case hex digits, with
 *
 *   `doc = { v: 1, model, firmware, kind, rawFormat: RAW_FORMAT, records, ...kind part }`
 *
 *   - `model`: an integer 0..255 and `firmware`: canonical `<major>.<minor>` (anything else throws)
 *     are the key the caller files the source under, not read from the source;
 *   - `kind`: `editor-cache` | `live-readonly` | `live-full` (a `live-probe` has no fact hash);
 *   - `rawFormat` is the codec's `RAW_FORMAT` (a raw source carries no format of its own; the
 *     envelope does). A bump of `RAW_FORMAT` therefore changes the hash of every source: hash an
 *     older stored source only with the codec build that wrote it, or treat the hash as
 *     format-scoped (a backend keys rows by `(model, firmware, kind, rawFormat, factHash)` and
 *     computes with the envelope's format);
 *   - `records`: the records after the duplicate rule above (identical repeats collapsed to the
 *     first), each reduced as below, sorted ascending by `(section, id)` (a position is unique
 *     here, so nothing else breaks a tie);
 *   - editor-cache records are the full shared records: float
 *     `kind section id tc min max def step t1 t2` (a `unit` / `taper` / `placeholder` key a
 *     foreign source carries counts too), enum `kind section id tc min max def step count values x
 *     [wireIds]`. Editor-cache adds `sections` (`{ tag, count }` sorted by `(tag, count)`),
 *     `header` (`{ major, minor, sectionCount }` or `null`) and `omitted` (`{ tables, records }`);
 *   - LIVE records are a kind-free projection: `{ section, id, tc, min, max, def, step }` plus
 *     `values` only when the record has a non-empty label list, plus `placeholder: true` only for a
 *     flagged placeholder row. Left out: `kind`, `count`, `x`, `t1`, `t2`, `unit`, `taper`. What a
 *     live walk reads about a parameter's CURRENT state (its formatted value gives the unit; a
 *     unit decides whether a label-less enum-shaped definition is read as an enum or a float; a
 *     sweep gives the taper of the current preset) must not make two reads of one firmware differ.
 *     This mirrors `rowTuple` (./rowTuple.ts), which also leaves kind, unit and taper out;
 *   - live adds `scope`: `{ blocks` (ascending; a repeated block throws), `extended`, `above160`,
 *     `hinted }`. `maxParamId`, `bounds` and `idLists` are left out: they follow the host's
 *     settings and whether it holds a local editor cache.
 *
 * Left out on purpose: `id`, `origin`, `capturedAt`, `codecVersion`, `fileVersion`, `contentSha256`,
 * `issues` and the live `walk` statistics (including `extension` and `abortReason`). A walk that
 * lost replies is a quality property of the read, not different content, so two complete reads of
 * one firmware dedupe, and a re-read or a re-import does not change the hash.
 *
 * Browser-safe: pure, no `node:*`, no `Buffer`.
 */
import { canonicalNumber } from './fingerprint.js';
import { UNIT_RE } from './liveWalk.js';
import { RAW_FORMAT } from './profileDoc.js';
import type { EditorCacheRawSource, LiveRawSource, LiveSourceScope, RawRecord, RawSource } from './profileDoc.js';
import { isUserNameTable } from './redact.js';
import type { FloatTaper } from './types.js';

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/** Nesting limit of `canonicalJson` (a source is about 6 levels deep). */
const MAX_DEPTH = 64;

function isPlainObject(v: object): v is Record<string, unknown> {
  const p = Object.getPrototypeOf(v) as unknown;
  return p === Object.prototype || p === null;
}

/** Number text of `canonicalJson`: integers exact, everything else as `canonicalNumber`. */
function numberText(x: number): string {
  if (!Number.isFinite(x)) throw new TypeError('canonicalJson: non-finite number');
  return Number.isInteger(x) ? String(x) : canonicalNumber(x);
}

function writeCanonical(v: unknown, out: string[], depth: number): void {
  if (v === null) {
    out.push('null');
    return;
  }
  switch (typeof v) {
    case 'boolean':
      out.push(v ? 'true' : 'false');
      return;
    case 'number':
      out.push(numberText(v));
      return;
    case 'string':
      out.push(JSON.stringify(v));
      return;
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported value (${typeof v})`);
  }
  if (depth >= MAX_DEPTH) throw new RangeError(`canonicalJson: nested deeper than ${MAX_DEPTH} levels`);
  if (Array.isArray(v)) {
    out.push('[');
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.push(',');
      writeCanonical(v[i], out, depth + 1);
    }
    out.push(']');
    return;
  }
  if (!isPlainObject(v as object)) throw new TypeError('canonicalJson: only plain objects and arrays are supported');
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  out.push('{');
  keys.forEach((k, i) => {
    if (i > 0) out.push(',');
    out.push(JSON.stringify(k), ':');
    writeCanonical(o[k], out, depth + 1);
  });
  out.push('}');
}

/**
 * The canonical JSON text of a value (rules in the module comment): sorted keys, no whitespace, the
 * canonical number text. Throws `TypeError` / `RangeError` (never echoing a value) for anything that
 * is not plain JSON data.
 */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  writeCanonical(value, out, 0);
  return out.join('');
}

// ---------------------------------------------------------------------------
// Field checks and copies (the shared shape)
// ---------------------------------------------------------------------------

const U16 = 0xffff;
const U32 = 0xffffffff;
/** Magnitude of a float field (the largest f32). */
const FLOAT_LIMIT = 3.5e38;

const TAPER_SHAPES: readonly FloatTaper['shape'][] = ['linear', 'log', 'flat', 'custom', 'unknown'];
const EXTENSIONS: readonly NonNullable<LiveRawSource['walk']['extension']>[] = ['done', 'skipped', 'aborted'];
/** Canonical `<major>.<minor>` firmware spelling: decimal parts, no leading zeros. */
const VERSION_RE = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
const CODEC_VERSION_RE = /^[\x20-\x7e]{0,64}$/;

/** Every message names a field and a rule, never the offending value. */
const bad = (what: string): never => {
  throw new TypeError(`share: ${what}`);
};

const obj = (v: unknown, what: string): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : bad(`${what} is not an object`);
const list = (v: unknown, what: string): readonly unknown[] => (Array.isArray(v) ? (v as readonly unknown[]) : bad(`${what} is not an array`));
const int = (v: unknown, what: string, max: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? (v === 0 ? 0 : v) : bad(`${what} is not an integer 0..${max}`);
const flt = (v: unknown, what: string): number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= FLOAT_LIMIT ? (v === 0 ? 0 : v) : bad(`${what} is not a finite number`);
const text = (v: unknown, what: string): string => (typeof v === 'string' ? v : bad(`${what} is not a string`));
const oneOf = <T extends string>(v: unknown, what: string, set: readonly T[]): T =>
  typeof v === 'string' && (set as readonly string[]).includes(v) ? (v as T) : bad(`${what} is not one of ${set.join(' | ')}`);
const version = (v: unknown, what: string): string => (typeof v === 'string' && VERSION_RE.test(v) ? v : bad(`${what} is not a canonical major.minor version`));
const ints = (v: unknown, what: string, max: number): number[] => list(v, what).map((n, i) => int(n, `${what}[${i}]`, max));

function copyTaper(v: unknown, what: string): FloatTaper {
  const o = obj(v, what);
  return {
    shape: oneOf(o['shape'], `${what}.shape`, TAPER_SHAPES),
    err: o['err'] === null ? null : flt(o['err'], `${what}.err`),
    reliable: typeof o['reliable'] === 'boolean' ? o['reliable'] : bad(`${what}.reliable is not a boolean`),
    points: list(o['points'], `${what}.points`).map((p, i) => {
      const pair = list(p, `${what}.points[${i}]`);
      if (pair.length !== 2) bad(`${what}.points[${i}] is not a pair`);
      return [flt(pair[0], `${what}.points[${i}][0]`), flt(pair[1], `${what}.points[${i}][1]`)] as const;
    }),
  };
}

/** A record reduced to the known fields of the shared shape, in the codec's field order (a fresh object). */
function copyRecord(v: unknown, i: number): RawRecord {
  const at = `records[${i}]`;
  const r = obj(v, at);
  const section = int(r['section'], `${at}.section`, U16);
  const id = int(r['id'], `${at}.id`, U16);
  const tc = int(r['tc'], `${at}.tc`, U32);
  const min = flt(r['min'], `${at}.min`);
  const max = flt(r['max'], `${at}.max`);
  const def = flt(r['def'], `${at}.def`);
  const step = flt(r['step'], `${at}.step`);
  const unit = r['unit'] === undefined ? undefined : text(r['unit'], `${at}.unit`);
  if (unit !== undefined && !UNIT_RE.test(unit)) bad(`${at}.unit is not a unit token`);
  if (r['kind'] === 'float') {
    return {
      kind: 'float',
      section,
      id,
      tc,
      min,
      max,
      def,
      step,
      ...(unit !== undefined ? { unit } : {}),
      t1: int(r['t1'], `${at}.t1`, U32),
      t2: int(r['t2'], `${at}.t2`, U32),
      ...(r['taper'] !== undefined ? { taper: copyTaper(r['taper'], `${at}.taper`) } : {}),
      ...(r['placeholder'] === true ? { placeholder: true } : {}),
    };
  }
  if (r['kind'] === 'enum') {
    return {
      kind: 'enum',
      section,
      id,
      tc,
      min,
      max,
      def,
      step,
      ...(unit !== undefined ? { unit } : {}),
      count: int(r['count'], `${at}.count`, U32),
      values: list(r['values'], `${at}.values`).map((s, k) => text(s, `${at}.values[${k}]`)),
      x: int(r['x'], `${at}.x`, U32),
      ...(r['wireIds'] !== undefined ? { wireIds: ints(r['wireIds'], `${at}.wireIds`, U32) } : {}),
    };
  }
  return bad(`${at}.kind is neither float nor enum`);
}

function copyRecords(records: unknown): RawRecord[] {
  return list(records, 'records').map((r, i) => copyRecord(r, i));
}

/** `{ '<int>': T }` dictionary copy: plain decimal integer keys only (this also keeps `__proto__` out). */
function copyKeyed<T>(v: unknown, what: string, f: (x: unknown, w: string) => T): Record<number, T> {
  const o = obj(v, what);
  const out: Record<number, T> = {};
  for (const k of Object.keys(o)) {
    if (!/^(0|[1-9]\d*)$/.test(k)) bad(`${what} has a key that is not an integer`);
    out[k as unknown as number] = f(o[k], `${what}[${k}]`);
  }
  return out;
}

function copyScope(v: unknown): LiveSourceScope {
  const s = obj(v, 'scope');
  const flag = (k: string): boolean => (typeof s[k] === 'boolean' ? (s[k] as boolean) : bad(`scope.${k} is not a boolean`));
  return {
    blocks: ints(s['blocks'], 'scope.blocks', U16),
    maxParamId: int(s['maxParamId'], 'scope.maxParamId', U16),
    bounds: copyKeyed(s['bounds'], 'scope.bounds', (x, w) => int(x, w, U16)),
    ...(s['idLists'] !== undefined ? { idLists: copyKeyed(s['idLists'], 'scope.idLists', (x, w) => ints(x, w, U16)) } : {}),
    extended: flag('extended'),
    above160: flag('above160'),
    hinted: flag('hinted'),
  };
}

/** Records by `(section, id)`; `null` when two records of one position differ in `textOf`. Identical repeats collapse to the first. */
function uniqueByPosition<T extends { section: number; id: number }>(items: readonly T[], textOf: (t: T) => string): T[] | null {
  const seen = new Map<string, string>();
  const out: T[] = [];
  for (const it of items) {
    const key = `${it.section}:${it.id}`;
    const t = textOf(it);
    const prior = seen.get(key);
    if (prior === undefined) {
      seen.set(key, t);
      out.push(it);
    } else if (prior !== t) {
      return null;
    }
  }
  return out;
}

const hasRepeats = (xs: readonly number[]): boolean => new Set(xs).size !== xs.length;

// ---------------------------------------------------------------------------
// Coarsened capture time
// ---------------------------------------------------------------------------

// `YYYY-MM-DD`, or `YYYY-MM-DDThh:mm[:ss[.fraction]]` with a REQUIRED `Z` / `+hh:mm` offset (a stamp
// without an offset names no instant, so it is not guessed at).
const ISO_STAMP = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/;

const DAY_MS = 86_400_000;

function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * The UTC day of a capture stamp as `YYYY-MM-DDT00:00:00.000Z`. The stamp is read as an instant
 * (a `Z` or `+hh:mm` offset is applied first, so `2026-11-22T01:30:00+05:00` is the 21st in UTC); a
 * date-only stamp is that UTC day. Anything else (`null`, no offset, an impossible date, free text)
 * gives `null`: nothing is guessed, nothing unrecognized is passed on.
 */
export function coarsenCapturedAt(stamp: string | null | undefined): string | null {
  if (typeof stamp !== 'string') return null;
  const m = ISO_STAMP.exec(stamp);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMin = 0;
  const tz = m[7];
  if (tz !== undefined && tz !== 'Z') {
    const oh = Number(tz.slice(1, 3));
    const om = Number(tz.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offsetMin = (tz[0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day); // setUTCFullYear: no 0..99 -> 1900s mapping
  d.setUTCHours(hour, minute, second, 0);
  const utc = d.getTime() - offsetMin * 60_000;
  const iso = new Date(Math.floor(utc / DAY_MS) * DAY_MS).toISOString();
  return /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(iso) ? iso : null;
}

// ---------------------------------------------------------------------------
// shareableSource
// ---------------------------------------------------------------------------

/**
 * An editor-cache source as it is shared: no `id`, `origin` or `issues`; `contentSha256` always
 * `null`; `capturedAt` coarsened to the UTC day.
 */
export interface ShareableEditorCacheSource {
  kind: 'editor-cache';
  space: 'section';
  capturedAt: string | null;
  firmware: string | null;
  codecVersion: string;
  sections: Array<{ tag: number; count: number }>;
  omitted: { tables: number; records: number };
  header: { major: number; minor: number; sectionCount: number } | null;
  fileVersion: string | null;
  contentSha256: null;
  records: RawRecord[];
}

/**
 * A live source as it is shared: no `id` or `origin`; `capturedAt` coarsened to the UTC day; the
 * walk statistics without the free-text `abortReason` (the outcome `extension` stays).
 */
export interface ShareableLiveSource {
  kind: 'live-readonly' | 'live-full';
  space: 'block';
  capturedAt: string | null;
  firmware: string | null;
  codecVersion: string;
  scope: LiveSourceScope;
  walk: Omit<LiveRawSource['walk'], 'abortReason'>;
  records: RawRecord[];
}

export type ShareableSource = ShareableEditorCacheSource | ShareableLiveSource;

/**
 * Why a source is not shared: `probe` = a `live-probe` source (single-block probes are not shared);
 * `tolerant-source` = a tolerant parse that skipped damaged stretches (`issues`); `user-data` = a
 * record is a user name table (`isUserNameTable`; absent from sources built by this codec, so this
 * only guards against a foreign or hand-built source); `duplicates` = two records of one
 * `(section, id)` that differ, or a block listed twice in the live scope.
 */
export type ShareRefusal = 'probe' | 'tolerant-source' | 'user-data' | 'duplicates';

export interface ShareRefused {
  refused: ShareRefusal;
}

/** The kind-free projection of a live record (module comment). */
function liveProjection(r: RawRecord): Record<string, unknown> {
  const values = r.kind === 'enum' ? r.values : [];
  return {
    section: r.section,
    id: r.id,
    tc: r.tc,
    min: r.min,
    max: r.max,
    def: r.def,
    step: r.step,
    ...(values.length > 0 ? { values } : {}),
    ...(r.kind === 'float' && r.placeholder === true ? { placeholder: true } : {}),
  };
}

/** What the fact hash sees of the records (the duplicate rule compares exactly this): the full records of an editor cache, the kind-free projection of a live source. */
function projectRecords(kind: 'editor-cache' | 'live-readonly' | 'live-full', copies: readonly RawRecord[]): Array<{ section: number; id: number }> {
  return kind === 'editor-cache' ? [...copies] : copies.map((r) => liveProjection(r) as { section: number; id: number });
}

function sourceKind(src: unknown): 'editor-cache' | 'live-readonly' | 'live-full' | 'live-probe' {
  return oneOf(obj(src, 'source')['kind'], 'kind', ['editor-cache', 'live-readonly', 'live-full', 'live-probe'] as const);
}

/**
 * The shareable copy of a raw source, or the reason it cannot be shared. Never modifies `src` and
 * shares no mutable value with it.
 *
 * Dropped: `id` and `origin` (a receiver assigns its own), `contentSha256` (kept as `null`: it is a
 * per-installation fingerprint of the redacted file), `capturedAt` precision (coarsened to the UTC
 * day, see `coarsenCapturedAt`), `abortReason` (free text) and every key the shared shape does not
 * name. Refused: a `live-probe` source, a source with `issues`, a source with a user name table, a
 * source with conflicting duplicates (checked in this order). Every field is checked against the
 * rules in the module comment: `TypeError` (naming a field, never a value) for a malformed source
 * or a free-text field that does not match its closed pattern.
 */
export function shareableSource(src: RawSource): ShareableSource | ShareRefused {
  const kind = sourceKind(src);
  if (kind === 'live-probe') return { refused: 'probe' };
  if (kind === 'editor-cache' && (src as EditorCacheRawSource).issues !== undefined) return { refused: 'tolerant-source' };
  const records = list(src.records, 'records');
  for (let i = 0; i < records.length; i++) {
    if (isUserNameTable(obj(records[i], `records[${i}]`)['id'] as number)) return { refused: 'user-data' };
  }
  const common = {
    capturedAt: coarsenCapturedAt(src.capturedAt),
    firmware: src.firmware === null ? null : version(src.firmware, 'firmware'),
    codecVersion: typeof src.codecVersion === 'string' && CODEC_VERSION_RE.test(src.codecVersion) ? src.codecVersion : bad('codecVersion is not printable ASCII of at most 64 characters'),
  };
  const copies = copyRecords(records);
  if (uniqueByPosition(projectRecords(kind, copies), (r) => canonicalJson(r)) === null) return { refused: 'duplicates' };

  if (kind === 'editor-cache') {
    const e = obj(src, 'source') as unknown as Record<keyof EditorCacheRawSource, unknown>;
    if (e.space !== 'section') return bad('space of an editor-cache source is not section');
    const om = obj(e.omitted, 'omitted');
    const h = e.header === null ? null : obj(e.header, 'header');
    return {
      kind: 'editor-cache',
      space: 'section',
      ...common,
      sections: list(e.sections, 'sections').map((s, i) => {
        const o = obj(s, `sections[${i}]`);
        return { tag: int(o['tag'], `sections[${i}].tag`, U16), count: int(o['count'], `sections[${i}].count`, U32) };
      }),
      omitted: { tables: int(om['tables'], 'omitted.tables', U32), records: int(om['records'], 'omitted.records', U32) },
      header: h === null ? null : { major: int(h['major'], 'header.major', U16), minor: int(h['minor'], 'header.minor', U16), sectionCount: int(h['sectionCount'], 'header.sectionCount', U32) },
      fileVersion: e.fileVersion === null ? null : version(e.fileVersion, 'fileVersion'),
      contentSha256: null,
      records: copies,
    };
  }
  const l = obj(src, 'source') as unknown as Record<keyof LiveRawSource, unknown>;
  if (l.space !== 'block') return bad('space of a live source is not block');
  const scope = copyScope(l.scope);
  if (hasRepeats(scope.blocks)) return { refused: 'duplicates' };
  const w = obj(l.walk, 'walk');
  const stat = (k: string): number => int(w[k], `walk.${k}`, U32);
  const pseudo = w['pseudoReplies'] === undefined ? undefined : obj(w['pseudoReplies'], 'walk.pseudoReplies');
  const walk: ShareableLiveSource['walk'] = {
    queries: stat('queries'),
    lostReplies: stat('lostReplies'),
    recoveredReplies: stat('recoveredReplies'),
    unresolvedReplies: stat('unresolvedReplies'),
    placeholderSlots: stat('placeholderSlots'),
    missingSlots: stat('missingSlots'),
    silentAddresses: stat('silentAddresses'),
    ...(pseudo !== undefined
      ? {
          pseudoReplies: {
            endMarker: int(pseudo['endMarker'], 'walk.pseudoReplies.endMarker', U32),
            duplicateId: int(pseudo['duplicateId'], 'walk.pseudoReplies.duplicateId', U32),
            implausible: int(pseudo['implausible'], 'walk.pseudoReplies.implausible', U32),
          },
        }
      : {}),
    boundHits: list(w['boundHits'], 'walk.boundHits').map((h, i) => {
      const o = obj(h, `walk.boundHits[${i}]`);
      return {
        block: int(o['block'], `walk.boundHits[${i}].block`, U16),
        lastReal: int(o['lastReal'], `walk.boundHits[${i}].lastReal`, U16),
        bound: int(o['bound'], `walk.boundHits[${i}].bound`, U16),
      };
    }),
    ...(w['extension'] !== undefined ? { extension: oneOf(w['extension'], 'walk.extension', EXTENSIONS) } : {}),
  };
  return { kind: kind as 'live-readonly' | 'live-full', space: 'block', ...common, scope, walk, records: copies };
}

// ---------------------------------------------------------------------------
// Fact hash
// ---------------------------------------------------------------------------

/** Version of the fact document (`v` in it). Bump together with any change to what it covers. */
export const FACT_HASH_VERSION = 1;

/** What a source is filed under: the device model byte and the device firmware (canonical `12.0`). */
export interface SourceFactKey {
  model: number;
  firmware: string;
}

/** The fact document of a source (module comment). */
function factDocument(src: RawSource, key: SourceFactKey): Record<string, unknown> {
  const kind = sourceKind(src);
  if (kind === 'live-probe') throw new RangeError('share: a live-probe source has no fact hash');
  const k = obj(key, 'key');
  const model = int(k['model'], 'model', 255);
  const firmware = version(k['firmware'], 'firmware');
  const copies = copyRecords(src.records);
  const unique = uniqueByPosition(projectRecords(kind, copies), (r) => canonicalJson(r)) ?? bad('records repeat a (section, id) with different content');
  unique.sort((a, b) => a.section - b.section || a.id - b.id);
  const doc: Record<string, unknown> = { v: FACT_HASH_VERSION, model, firmware, kind, rawFormat: RAW_FORMAT, records: unique };
  if (kind === 'editor-cache') {
    const e = src as unknown as Record<keyof EditorCacheRawSource, unknown>;
    const om = obj(e.omitted, 'omitted');
    const h = e.header === null ? null : obj(e.header, 'header');
    doc['sections'] = list(e.sections, 'sections')
      .map((s, i) => {
        const o = obj(s, `sections[${i}]`);
        return { tag: int(o['tag'], `sections[${i}].tag`, U16), count: int(o['count'], `sections[${i}].count`, U32) };
      })
      .sort((a, b) => a.tag - b.tag || a.count - b.count);
    doc['header'] = h === null ? null : { major: int(h['major'], 'header.major', U16), minor: int(h['minor'], 'header.minor', U16), sectionCount: int(h['sectionCount'], 'header.sectionCount', U32) };
    doc['omitted'] = { tables: int(om['tables'], 'omitted.tables', U32), records: int(om['records'], 'omitted.records', U32) };
    return doc;
  }
  const s = copyScope((src as LiveRawSource).scope); // checks the whole scope, hashes the part below
  if (hasRepeats(s.blocks)) bad('scope.blocks lists a block twice');
  doc['scope'] = { blocks: [...s.blocks].sort((a, b) => a - b), extended: s.extended, above160: s.above160, hinted: s.hinted };
  return doc;
}

/**
 * The exact text `sourceFactHash` hashes: the canonical JSON of the fact document (module comment).
 * Exposed so another implementation can compare text before comparing digests. Throws `RangeError`
 * for a `live-probe` source and `TypeError` for a malformed one, a bad key, or conflicting
 * duplicates.
 */
export function sourceFactCanonical(src: RawSource, key: SourceFactKey): string {
  return canonicalJson(factDocument(src, key));
}

/**
 * Content hash of a raw source (module comment): sha256, lower-case hex, over the canonical JSON of
 * the source's records, sections, header, omitted counts and live scope, keyed by model and
 * firmware. Independent of `id`, `origin`, `capturedAt`, `codecVersion`, `fileVersion`,
 * `contentSha256`, `issues`, the live walk statistics, key order and record order, and, for a live
 * source, of everything that follows the device's current state (kind, unit, taper). Uses
 * `globalThis.crypto.subtle`; rejects when the runtime has none.
 */
export async function sourceFactHash(src: RawSource, key: SourceFactKey): Promise<string> {
  const doc = sourceFactCanonical(src, key);
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) throw new Error('share: crypto.subtle is not available in this runtime');
  const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(doc)));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}
