/**
 * Synthetic cache-byte builders for the header and redaction suites: little-endian primitives,
 * record builders (enum, float, name table, cab/IR table), a 0x2e-byte header builder, and an
 * encoder that turns a committed `.walk.json` fixture back into cache bytes (so a suite can run
 * byte-level code on the committed walk without any raw cache file).
 */
import type { CacheRecord, CacheWalk } from '../../src/cache/types.js';

/** A name: a string (written as UTF-8) or raw bytes. */
export type NameBytes = string | readonly number[];

export const pushU16 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff);
export const pushU32 = (a: number[], v: number) =>
  a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
export const pushF32 = (a: number[], v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, true);
  a.push(b[0]!, b[1]!, b[2]!, b[3]!);
};

const utf8 = new TextEncoder();
/** The bytes a name is written as. */
export const nameBytes = (n: NameBytes): number[] => (typeof n === 'string' ? [...utf8.encode(n)] : [...n]);

/** Length-prefixed name. */
export const pushLp = (a: number[], n: NameBytes) => {
  const b = nameBytes(n);
  pushU32(a, b.length);
  a.push(...b);
};

/** 22-byte record head: id, tc, pad, min, max, def, step. */
export const pushHead = (a: number[], id: number, tc: number, min: number, max: number, def: number, step: number, pad = 0) => {
  pushU16(a, id);
  pushU16(a, tc);
  pushU16(a, pad);
  pushF32(a, min);
  pushF32(a, max);
  pushF32(a, def);
  pushF32(a, step);
};

/** A 32-byte float record. */
export const pushFloat = (a: number[], id: number, tc = 2, t1 = 0, t2 = 0, min = 0, max = 1, def = 1) => {
  pushHead(a, id, tc, min, max, def, 0);
  pushU32(a, t1);
  pushU32(a, t2);
  pushU16(a, 0);
};

/** A plain enum record (also the shape of a 0xffff name table): count, names, u32 x, u16 0. */
export const pushEnum = (a: number[], id: number, names: readonly NameBytes[], x = 0, tc = 16) => {
  pushHead(a, id, tc, 0, Math.max(0, names.length - 1), 0, 0);
  pushU32(a, names.length);
  for (const n of names) pushLp(a, n);
  pushU32(a, x);
  pushU16(a, 0);
};

/** A cab/IR table record (ids 0xfff0..0xfffe): count, names, u16 0, u32 idCount, wire ids. */
export const pushTable = (a: number[], id: number, names: readonly NameBytes[], wireIds: readonly number[]) => {
  pushHead(a, id, 0, 0, 0, 0, 0);
  pushU32(a, names.length);
  for (const n of names) pushLp(a, n);
  pushU16(a, 0);
  pushU32(a, wireIds.length);
  for (const w of wireIds) pushU32(a, w);
};

/** Section header: tag, record count. */
export const pushSection = (a: number[], tag: number, count: number) => {
  pushU32(a, tag);
  pushU32(a, count);
};

/** Fields of a synthetic 0x2e-byte header. */
export interface HeaderSpec {
  major?: number;
  minor?: number;
  sectionCount?: number;
  /** ASCII written at 0x0a (NUL-padded up to 0x2a). */
  buildDate?: string;
  /** Raw byte overrides `[offset, value]`, applied last. */
  bytes?: ReadonlyArray<readonly [number, number]>;
}

/** A 0x2e-byte header: u32 major @0, u32 minor @4, u16 4 @8, build date @0x0a, u32 sections @0x2a. */
export function header(spec: HeaderSpec = {}): number[] {
  const a: number[] = [];
  pushU32(a, spec.major ?? 0);
  pushU32(a, spec.minor ?? 0);
  pushU16(a, 4);
  const date = spec.buildDate ?? '';
  for (let i = 0; i < 0x2a - 0x0a; i++) a.push(i < date.length ? date.charCodeAt(i) : 0);
  pushU32(a, spec.sectionCount ?? 0);
  for (const [o, v] of spec.bytes ?? []) a[o] = v;
  return a;
}

/** Append one walked record exactly as the byte grammar lays it out. */
export function pushRecord(a: number[], r: CacheRecord): void {
  pushHead(a, r.id, r.tc, r.min, r.max, r.def, r.step);
  if (r.kind === 'float') {
    pushU32(a, r.t1);
    pushU32(a, r.t2);
    pushU16(a, 0);
    return;
  }
  pushU32(a, r.count);
  for (const v of r.values) pushLp(a, v);
  if (r.wireIds !== undefined) {
    pushU16(a, 0);
    pushU32(a, r.wireIds.length);
    for (const w of r.wireIds) pushU32(a, w);
    return;
  }
  pushU32(a, r.x);
  pushU16(a, 0);
}

/**
 * Encode a strict walk (e.g. a committed `.walk.json` fixture) back into cache bytes behind a
 * header (default: all zeros). Sections in walk order, each followed by its walked records.
 */
export function encodeWalk(walk: CacheWalk, head: readonly number[] = header()): Uint8Array {
  const a: number[] = [...head];
  let k = 0;
  for (const s of walk.sections) {
    pushSection(a, s.index, s.count);
    for (let i = 0; i < s.records; i++) pushRecord(a, walk.records[k++]!);
  }
  return new Uint8Array(a);
}
