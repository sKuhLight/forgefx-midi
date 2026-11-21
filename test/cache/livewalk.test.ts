/**
 * Live self-describe walk goldens.
 *
 * A test-only ENCODER inverts the wire: it packs a decoded record back into a
 * 36-byte definition block (or a septet-ASCII label), frames it as a func-0x01
 * reply, and serves it from a fake transport keyed on the committed FM3 fixture.
 * `liveWalk` then reconstructs the records purely from those frames.
 *
 * The end-to-end proof is source-agnosticism: `buildCache(live)` over the fake
 * transport is deep-equal to `buildCache(bytes)` over the SAME records
 * re-serialised into the raw cache grammar. The live build (paired with the
 * byte-sourced special table records, which are not param-addressable) also
 * clears the shared FM3 equivalence oracle. The encoder serves enum labels at
 * their RAW-VALUE sub ordinals (values[i] at sub = min + i, a below-min decoy
 * label under min, a cnt==0/tag-0x40 reply past max), so the equality proof is
 * off-by-one-sensitive: the fixture's min-1 lists make an index-based walker
 * fail the deep-equal. Unit cases pin the codec: 0x3a vs 0x00 tag equivalence,
 * sentinels, enum-count bounding + the 1024 cap, the 14-bit param
 * (body[4]/body[5]) and sub (body[6]/body[7]) splits, the min!=0 raw-value sub
 * walk across the 128 boundary, the cnt==0/tag-0x40 end reply, septet
 * round-trips at 7-byte boundaries, and abort + pacing.
 *
 * `src/cache/*` stays browser-safe; this TEST may use `node:fs`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCache, CACHE_SCHEMA, HW_SEEDS } from '../../src/cache/index.js';
import type { BuiltCache, LiveTransport } from '../../src/cache/index.js';
import {
  buildDefQuery,
  buildEnumQuery,
  buildValueQuery,
  decodeReply,
  decodeSeptetStream,
  liveWalk,
  liveWalkDetailed,
  liveSource,
  VIEW_DEFINITION,
  VIEW_ENUM_LABEL,
  VIEW_VALUE,
} from '../../src/cache/index.js';
import { parseUnit } from '../../src/cache/liveWalk.js';
import type { CacheRecord, EnumRecord } from '../../src/cache/types.js';
import { FM3_PARAMS } from '../../src/gen3/fm3/index.js';
import { assertFm3Equivalence } from './oracle.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FM3 = 0x11;

export const LIVEWALK_CASE_COUNT = 23;

// ===========================================================================
// Test-only wire ENCODER (inverse of the liveWalk codec)
// ===========================================================================

/** Continuous MSB-first septet packer — inverse of `decodeSeptetStream`. */
function encodeSeptetStream(raw: Uint8Array): Uint8Array {
  const wire: number[] = [];
  let acc = 0;
  let nbits = 0;
  for (const b of raw) {
    acc = (acc << 8) | b;
    nbits += 8;
    while (nbits >= 7) {
      nbits -= 7;
      wire.push((acc >> nbits) & 0x7f);
    }
  }
  if (nbits > 0) wire.push((acc << (7 - nbits)) & 0x7f);
  return Uint8Array.from(wire);
}

function fractalCksum(bytes: readonly number[]): number {
  let acc = 0;
  for (const b of bytes) acc ^= b;
  return acc & 0x7f;
}

/** Frame a func-0x01 reply carrying `raw` payload bytes. */
function replyFrame(selector: number, param: number, tag: number, raw: Uint8Array): Uint8Array {
  const inner = new Array<number>(15).fill(0);
  inner[0] = selector;
  inner[1] = 0x00;
  inner[2] = 0x01;
  inner[3] = 0x00;
  inner[4] = param & 0x7f;
  inner[5] = (param >> 7) & 0x7f;
  inner[6] = tag;
  const cnt = raw.length;
  inner[13] = cnt & 0xff;
  inner[14] = (cnt >> 8) & 0xff;
  const wire = encodeSeptetStream(raw);
  const core = [...[0xf0, 0x00, 0x01, 0x74], FM3, 0x01, ...inner, ...wire];
  return Uint8Array.from([...core, fractalCksum(core), 0xf7]);
}

/** A sentinel reply (tag 0x03, no payload) for absent slots. */
function sentinelFrame(selector: number, param: number): Uint8Array {
  const inner = new Array<number>(15).fill(0);
  inner[0] = selector;
  inner[4] = param & 0x7f;
  inner[6] = 0x03;
  const core = [...[0xf0, 0x00, 0x01, 0x74], FM3, 0x01, ...inner];
  return Uint8Array.from([...core, fractalCksum(core), 0xf7]);
}

/** The past-end enum reply: cnt == 0 under tag 0x40 (hardware end-of-range). */
function endOfRangeFrame(selector: number, param: number): Uint8Array {
  const inner = new Array<number>(15).fill(0);
  inner[0] = selector;
  inner[4] = param & 0x7f;
  inner[6] = 0x40; // NOT a 0x03/0x01 sentinel — end detection must be cnt-driven
  const core = [...[0xf0, 0x00, 0x01, 0x74], FM3, 0x01, ...inner];
  return Uint8Array.from([...core, fractalCksum(core), 0xf7]);
}

/**
 * Pack a record into a 36-byte definition block. `scale` is synthesised so the
 * numeric kind heuristic reproduces the record's known kind (enum→scale 0 with
 * step 0 & integral bounds; scalar→scale 1 so it never mis-reads as an enum).
 * `def` (the field the cache/records grammar carries) is preserved verbatim.
 */
function definitionBlock(r: CacheRecord): Uint8Array {
  const buf = new Uint8Array(36);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, r.id + 1, true); // symbol id — unique per param within a block (real params carry unique ids) and non-zero
  dv.setUint32(4, r.tc, true);
  dv.setFloat32(8, r.min, true);
  dv.setFloat32(12, r.max, true);
  dv.setFloat32(16, r.kind === 'enum' ? 0 : 1, true); // synthesised scale
  dv.setFloat32(20, r.def, true);
  dv.setFloat32(24, r.step, true);
  return buf;
}

function definitionReply(r: CacheRecord, param: number, tag = 0x3a): Uint8Array {
  return replyFrame(VIEW_DEFINITION, param, tag, definitionBlock(r));
}

/** `definitionBlock` with an EXPLICIT scale (Cases 13/14 pin the scale-gate). */
function definitionBlockScaled(r: CacheRecord, scale: number): Uint8Array {
  const buf = definitionBlock(r);
  new DataView(buf.buffer).setFloat32(16, scale, true);
  return buf;
}

function labelReply(label: string, param: number, tag = 0x3a): Uint8Array {
  const raw = Uint8Array.from([...label].map((c) => c.charCodeAt(0) & 0x7f));
  return replyFrame(VIEW_ENUM_LABEL, param, tag, raw);
}

/** A view-0x00 formatted-value reply, e.g. '200.00 Hz' (device-true readout). */
function valueReply(value: string, param: number, tag = 0x3a): Uint8Array {
  const raw = Uint8Array.from([...value].map((c) => c.charCodeAt(0) & 0x7f));
  return replyFrame(VIEW_VALUE, param, tag, raw);
}

/** Test-only wire encoders, shared with the sibling live-walk suites. */
export {
  encodeSeptetStream,
  replyFrame,
  sentinelFrame,
  endOfRangeFrame,
  definitionBlock,
  definitionBlockScaled,
  labelReply,
  valueReply,
  encodeCache,
};

// ===========================================================================
// Fake transport over the fixture
// ===========================================================================

interface FakeOpts {
  /** Count each request; abort after this many via the controller. */
  abortAfter?: number;
  controller?: AbortController;
}

class FixtureTransport implements LiveTransport {
  readonly byKey = new Map<string, CacheRecord>();
  requests = 0;
  private readonly opts: FakeOpts;

  constructor(records: readonly CacheRecord[], opts: FakeOpts = {}) {
    this.opts = opts;
    for (const r of records) this.byKey.set(`${r.section}:${r.id}`, r);
  }

  request(query: Uint8Array): Promise<Uint8Array | null> {
    this.requests += 1;
    if (this.opts.abortAfter !== undefined && this.requests >= this.opts.abortAfter) {
      this.opts.controller?.abort();
    }
    const view = query[6]!;
    const block = query[8]!;
    const param = query[10]! | (query[11]! << 7);
    const sub = query[12]! | (query[13]! << 7);
    const rec = this.byKey.get(`${block}:${param}`);
    if (view === VIEW_DEFINITION) {
      return Promise.resolve(rec ? definitionReply(rec, param) : sentinelFrame(VIEW_DEFINITION, param));
    }
    if (view === VIEW_ENUM_LABEL) {
      if (rec && rec.kind === 'enum') {
        // Hardware truth: the SUB ordinal is the parameter's RAW VALUE —
        // values[i] is served at sub = min + i, NOT at list index i.
        const lo = Math.round(rec.min);
        const idx = sub - lo;
        if (idx >= 0 && idx < rec.values.length) {
          return Promise.resolve(labelReply(rec.values[idx]!, param));
        }
        if (sub < lo) {
          // Below-min raw values answer with a REAL label that is not part of
          // the value list — a correct walker must never query these.
          return Promise.resolve(labelReply(`(below-min ${sub})`, param));
        }
      }
      // Past the end of the value range: cnt == 0 under tag 0x40.
      return Promise.resolve(endOfRangeFrame(VIEW_ENUM_LABEL, param));
    }
    return Promise.resolve(sentinelFrame(view, param));
  }
}

// ===========================================================================
// Local little-endian cache encoder (bytes-arm, inverse of parseCacheRecords)
// ===========================================================================

function encodeCache(records: readonly CacheRecord[]): Uint8Array {
  const bytes: number[] = [];
  const u16 = (v: number) => bytes.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (v: number) => bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const f32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    bytes.push(b[0]!, b[1]!, b[2]!, b[3]!);
  };
  const lp = (s: string) => {
    u32(s.length);
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
  };
  for (let i = 0; i < 0x2e; i++) bytes.push(0);
  const order: number[] = [];
  const bySection = new Map<number, CacheRecord[]>();
  for (const r of records) {
    let g = bySection.get(r.section);
    if (!g) {
      g = [];
      bySection.set(r.section, g);
      order.push(r.section);
    }
    g.push(r);
  }
  for (const tag of order) {
    const recs = bySection.get(tag)!;
    u32(tag);
    u32(recs.length);
    for (const r of recs) {
      u16(r.id);
      u16(r.tc);
      u16(0);
      f32(r.min);
      f32(r.max);
      f32(r.def);
      f32(r.step);
      if (r.kind === 'enum') {
        u32(r.values.length);
        for (const v of r.values) lp(v);
        if (r.id >= 0xfff0 && r.id <= 0xfffe) {
          u16(0);
          const ids = r.wireIds ?? [];
          u32(ids.length);
          for (const w of ids) u32(w);
        } else {
          u32(r.x);
          u16(0);
        }
      } else {
        u32(r.t1);
        u32(r.t2);
        u16(0);
      }
    }
  }
  return new Uint8Array(bytes);
}

// ===========================================================================
// Tests
// ===========================================================================

function dataOf(c: BuiltCache): Record<string, unknown> {
  const { meta: _m, model: _mo, firmware: _f, ...data } = c;
  return data;
}

export async function runLiveWalk(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[cache/livewalk] ${msg}`);
  };

  const walkText = readFileSync(join(FIXTURES, 'fm3-12p0.walk.json'), 'utf8');
  const all = (JSON.parse(walkText) as { records: CacheRecord[] }).records;
  const ordinary = all.filter((r) => r.id < 0xff00);
  const specials = all.filter((r) => r.id >= 0xff00);
  const sections = [...new Set(ordinary.map((r) => r.section))].sort((a, b) => a - b);
  const maxId = Math.max(...ordinary.map((r) => r.id));

  // ---- Case 1: septet round-trips at 7-byte boundaries ---------------------
  for (const n of [0, 1, 6, 7, 8, 13, 14, 15, 36, 331]) {
    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) raw[i] = (i * 37 + 11) & 0xff;
    const wire = encodeSeptetStream(raw);
    if (wire.length !== Math.ceil((n * 8) / 7)) fail(`septet width n=${n}: ${wire.length} != ${Math.ceil((n * 8) / 7)}`);
    const back = decodeSeptetStream(wire, n);
    if (back.length !== n || !raw.every((b, i) => b === back[i])) fail(`septet round-trip failed at n=${n}`);
  }
  console.log('  cache/livewalk: septet round-trips exact across 7-byte boundaries');

  // ---- Case 2: high-param (>127) body[4]/body[5] + sub body[6]/body[7] ------
  for (const param of [0, 1, 127, 128, 131, 200, 16383, maxId]) {
    const q = buildDefQuery(FM3, 3, param);
    if (q[10] !== (param & 0x7f) || q[11] !== ((param >> 7) & 0x7f)) {
      fail(`def query param ${param}: body[4]=${q[10]} body[5]=${q[11]}`);
    }
    const e = buildEnumQuery(FM3, 3, param, 5);
    if (e[10] !== (param & 0x7f) || e[11] !== ((param >> 7) & 0x7f) || e[12] !== 5 || e[13] !== 0) {
      fail(`enum query param ${param}: body[4]=${e[10]} body[5]=${e[11]} sub=${e[12]}/${e[13]}`);
    }
  }
  // SUB splits into body[6] low / body[7] high, composing with the param split.
  for (const sub of [0, 127, 128, 330, 1023]) {
    const e = buildEnumQuery(FM3, 3, 131, sub);
    if (e[12] !== (sub & 0x7f) || e[13] !== ((sub >> 7) & 0x7f)) {
      fail(`enum query sub ${sub}: body[6]=${e[12]} body[7]=${e[13]}`);
    }
    if (e[11] !== 1) fail(`enum query param 131 with sub ${sub}: body[5]=${e[11]} (high bytes must compose)`);
  }
  console.log('  cache/livewalk: 14-bit param (body[4]/[5]) and sub (body[6]/[7]) splits compose');

  // ---- Case 3: tag 0x3a and 0x00 decode identically ------------------------
  const probe = ordinary.find((r) => r.kind === 'float')!;
  const fresh = decodeReply(definitionReply(probe, probe.id, 0x3a));
  const reread = decodeReply(definitionReply(probe, probe.id, 0x00));
  if (JSON.stringify(fresh) !== JSON.stringify(reread) || !fresh || fresh.view !== 'definition') {
    fail('tag 0x3a vs 0x00 definition decode diverged');
  }
  if (Math.abs((fresh as { min: number }).min - probe.min) > 1e-6) fail('decoded min mismatch');
  console.log('  cache/livewalk: tag 0x3a (fresh) and 0x00 (re-read) decode identically');

  // ---- Case 4: sentinel / absent replies decode to null --------------------
  if (decodeReply(sentinelFrame(VIEW_DEFINITION, 4)) !== null) fail('tag-0x03 sentinel must decode null');
  {
    const inner = new Array<number>(15).fill(0);
    inner[6] = 0x01;
    const core = [0xf0, 0x00, 0x01, 0x74, FM3, 0x01, ...inner];
    if (decodeReply(Uint8Array.from([...core, fractalCksum(core), 0xf7])) !== null) fail('tag-0x01 sentinel must decode null');
  }
  if (decodeReply(Uint8Array.from([0xf0, 0x00, 0x01, 0x74, FM3, 0x02, 0x00, 0xf7])) !== null) fail('non-0x01 func must decode null');
  console.log('  cache/livewalk: sentinels (tag 0x03/0x01) and non-func-0x01 frames decode to null');

  // ---- Case 5: enum-count bounding + 1024 cap ------------------------------
  {
    // A synthetic enum whose declared count (max-min+1) is 5, but the transport
    // would serve labels forever — the walk must stop at 5 (count bound).
    const rec: EnumRecord = { kind: 'enum', section: 90, offset: 0, id: 2, tc: 16, min: 0, max: 4, def: 0, step: 0, count: 5, values: ['a', 'b', 'c', 'd', 'e'], x: 0 };
    const endless: LiveTransport = {
      request(q) {
        const view = q[6]!;
        const param = q[10]! | (q[11]! << 7);
        if (view === VIEW_DEFINITION && param === 2) return Promise.resolve(definitionReply(rec, 2));
        if (view === VIEW_ENUM_LABEL) return Promise.resolve(labelReply('L', param)); // never sentinels
        return Promise.resolve(sentinelFrame(view, param));
      },
    };
    const recs = await liveWalk(endless, { model: FM3, blocks: [90], maxParamId: 2, paramAbsentRunLimit: 4 });
    const e = recs.find((r) => r.id === 2) as EnumRecord | undefined;
    if (!e || e.kind !== 'enum' || e.values.length !== 5) fail(`enum count bound: got ${e?.kind} len=${(e as EnumRecord)?.values.length}`);

    // A declared count over the cap is clamped to the 1024 hard cap.
    const big: EnumRecord = { kind: 'enum', section: 91, offset: 0, id: 0, tc: 16, min: 0, max: 4000, def: 0, step: 0, count: 4001, values: [], x: 0 };
    const capped: LiveTransport = {
      request(q) {
        const view = q[6]!;
        const param = q[10]! | (q[11]! << 7);
        if (view === VIEW_DEFINITION && param === 0) return Promise.resolve(definitionReply(big, 0));
        if (view === VIEW_ENUM_LABEL) return Promise.resolve(labelReply('X', param));
        return Promise.resolve(sentinelFrame(view, param));
      },
    };
    const recs2 = await liveWalk(capped, { model: FM3, blocks: [91], maxParamId: 0, enumCountCap: 1024 });
    const e2 = recs2.find((r) => r.id === 0) as EnumRecord | undefined;
    if (!e2 || e2.values.length !== 1024) fail(`enum cap: expected 1024 labels, got ${e2?.values.length}`);
  }
  console.log('  cache/livewalk: enum walk bounded by declared count and hard-capped at 1024');

  // ---- Case 6: step!=0 enum recovered via 0x1f labels ----------------------
  {
    const stepEnum = ordinary.find((r) => r.kind === 'enum' && r.step !== 0) as EnumRecord | undefined;
    if (stepEnum) {
      const t = new FixtureTransport([stepEnum]);
      const recs = await liveWalk(t, {
        model: FM3,
        blocks: [stepEnum.section],
        maxParamId: stepEnum.id,
        paramAbsentRunLimit: stepEnum.id + 2,
        blockProbeDepth: stepEnum.id + 2, // isolated record: don't skip the block before reaching it
      });
      const got = recs.find((r) => r.id === stepEnum.id) as EnumRecord | undefined;
      if (!got || got.kind !== 'enum' || got.values.length !== stepEnum.values.length) {
        fail(`step!=0 enum not recovered as enum: kind=${got?.kind} len=${(got as EnumRecord)?.values.length}`);
      }
    }
  }
  console.log('  cache/livewalk: enum with non-zero step recovered as enum via 0x1f labels');

  // ---- Case 7: min!=0 enum walked at raw-value subs across the 128 boundary --
  {
    // min 1, count 148 → subs 1..148 exactly (never sub 0), body[7] set for
    // subs >= 128, and labels land at values[sub - min].
    const values = Array.from({ length: 148 }, (_, i) => `V${i + 1}`);
    const rec: EnumRecord = { kind: 'enum', section: 92, offset: 0, id: 0, tc: 16, min: 1, max: 148, def: 0, step: 0, count: 148, values, x: 0 };
    const subsSeen: number[] = [];
    let badHighByte = false;
    const t: LiveTransport = {
      request(q) {
        const view = q[6]!;
        const param = q[10]! | (q[11]! << 7);
        const sub = q[12]! | (q[13]! << 7);
        if (view === VIEW_DEFINITION && param === 0) return Promise.resolve(definitionReply(rec, 0));
        if (view === VIEW_ENUM_LABEL) {
          subsSeen.push(sub);
          if (q[13] !== ((sub >> 7) & 0x7f) || (sub >= 128 && q[13] !== 1)) badHighByte = true;
          const idx = sub - 1;
          if (idx >= 0 && idx < values.length) return Promise.resolve(labelReply(values[idx]!, 0));
          if (sub === 0) return Promise.resolve(labelReply('(below-min)', 0));
          return Promise.resolve(endOfRangeFrame(VIEW_ENUM_LABEL, 0));
        }
        return Promise.resolve(sentinelFrame(view, param));
      },
    };
    const recs = await liveWalk(t, { model: FM3, blocks: [92], maxParamId: 0 });
    const got = recs[0] as EnumRecord | undefined;
    if (!got || got.kind !== 'enum' || got.values.length !== 148) fail(`min-1 enum: got ${got?.kind} len=${(got as EnumRecord)?.values.length}`);
    if (got.values[0] !== 'V1' || got.values[147] !== 'V148') fail(`min-1 enum labels misaligned: [0]=${got.values[0]} [147]=${got.values[147]}`);
    if (subsSeen[0] !== 1 || subsSeen[subsSeen.length - 1] !== 148 || subsSeen.includes(0)) {
      fail(`min-1 enum queried subs ${subsSeen[0]}..${subsSeen[subsSeen.length - 1]} (must be exactly 1..148, never 0)`);
    }
    if (subsSeen.length !== 148 || badHighByte) fail(`min-1 enum: ${subsSeen.length} sub queries, badHighByte=${badHighByte}`);
  }
  console.log('  cache/livewalk: min!=0 enum walks raw-value subs min..max across the 128 boundary');

  // ---- Case 8: past-end reply (cnt==0, tag 0x40) ends the list --------------
  {
    if (decodeReply(endOfRangeFrame(VIEW_ENUM_LABEL, 3)) !== null) fail('cnt==0 tag-0x40 reply must decode null');
    // Walk-level: declared count 10, but the range ends after 3 labels.
    const rec: EnumRecord = { kind: 'enum', section: 93, offset: 0, id: 0, tc: 16, min: 0, max: 9, def: 0, step: 0, count: 10, values: ['a', 'b', 'c'], x: 0 };
    const t: LiveTransport = {
      request(q) {
        const view = q[6]!;
        const param = q[10]! | (q[11]! << 7);
        const sub = q[12]! | (q[13]! << 7);
        if (view === VIEW_DEFINITION && param === 0) return Promise.resolve(definitionReply(rec, 0));
        if (view === VIEW_ENUM_LABEL) {
          if (sub < 3) return Promise.resolve(labelReply(rec.values[sub]!, 0));
          return Promise.resolve(endOfRangeFrame(VIEW_ENUM_LABEL, 0));
        }
        return Promise.resolve(sentinelFrame(view, param));
      },
    };
    const recs = await liveWalk(t, { model: FM3, blocks: [93], maxParamId: 0 });
    const got = recs[0] as EnumRecord | undefined;
    if (!got || got.values.length !== 3) fail(`tag-0x40 end: expected 3 labels, got ${got?.values.length}`);
  }
  console.log('  cache/livewalk: cnt==0 tag-0x40 past-end reply terminates the label walk');

  // ---- Case 8b: a single dropped reply near the tail is retried, not treated
  // as the list's end (FORGEFX: live FM3 DISTORT roster came back 330/331) ----
  {
    const rec: EnumRecord = { kind: 'enum', section: 94, offset: 0, id: 0, tc: 16, min: 0, max: 4, def: 0, step: 0, count: 5, values: ['a', 'b', 'c', 'd', 'e'], x: 0 };
    let dropOnce = true;
    const t: LiveTransport = {
      request(q) {
        const view = q[6]!;
        const param = q[10]! | (q[11]! << 7);
        const sub = q[12]! | (q[13]! << 7);
        if (view === VIEW_DEFINITION && param === 0) return Promise.resolve(definitionReply(rec, 0));
        if (view === VIEW_ENUM_LABEL) {
          if (sub === 4 && dropOnce) {
            dropOnce = false;
            return Promise.resolve(null); // simulated timeout on the LAST entry, once
          }
          if (sub < rec.values.length) return Promise.resolve(labelReply(rec.values[sub]!, 0));
          return Promise.resolve(endOfRangeFrame(VIEW_ENUM_LABEL, 0));
        }
        return Promise.resolve(sentinelFrame(view, param));
      },
    };
    const pauses: number[] = [];
    const res = await liveWalkDetailed(t, {
      model: FM3,
      blocks: [94],
      maxParamId: 0,
      lostReplyDrainMs: 40,
      sleep: (ms) => {
        pauses.push(ms);
        return Promise.resolve();
      },
    });
    const got = res.records[0] as EnumRecord | undefined;
    if (!got || got.values.length !== 5 || got.values[4] !== 'e') {
      fail(`dropped-reply retry: expected all 5 labels incl. tail 'e', got ${got?.values.length} (${got?.values.join(',')})`);
    }
    if (dropOnce) fail('dropped-reply retry: the simulated drop never fired');
    if (res.lostReplies !== 1 || res.recoveredReplies !== 1 || res.unresolvedReplies !== 0) {
      fail(`dropped-reply accounting: lost ${res.lostReplies} recovered ${res.recoveredReplies} unresolved ${res.unresolvedReplies}`);
    }
    // One drain pause before the retry, one before the walk moves on.
    if (pauses.filter((ms) => ms === 40).length !== 2) fail(`dropped-reply drain: pauses ${JSON.stringify(pauses)}`);
  }
  console.log('  cache/livewalk: a single dropped reply (no frame at all) near the tail is retried, not treated as end-of-list');

  // ---- Case 8c: retries exhaust on a persistently missing reply — the walk
  // still terminates (bounded), it doesn't hang or loop forever -------------
  {
    const rec: EnumRecord = { kind: 'enum', section: 95, offset: 0, id: 0, tc: 16, min: 0, max: 4, def: 0, step: 0, count: 5, values: ['a', 'b', 'c', 'd', 'e'], x: 0 };
    let attempts = 0;
    const t: LiveTransport = {
      request(q) {
        const view = q[6]!;
        const param = q[10]! | (q[11]! << 7);
        const sub = q[12]! | (q[13]! << 7);
        if (view === VIEW_DEFINITION && param === 0) return Promise.resolve(definitionReply(rec, 0));
        if (view === VIEW_ENUM_LABEL) {
          if (sub === 4) {
            attempts += 1;
            return Promise.resolve(null); // never replies for this sub
          }
          if (sub < rec.values.length) return Promise.resolve(labelReply(rec.values[sub]!, 0));
          return Promise.resolve(endOfRangeFrame(VIEW_ENUM_LABEL, 0));
        }
        return Promise.resolve(sentinelFrame(view, param));
      },
    };
    const res = await liveWalkDetailed(t, { model: FM3, blocks: [95], maxParamId: 0, sleep: () => Promise.resolve() });
    const got = res.records[0] as EnumRecord | undefined;
    if (!got || got.values.length !== 4) fail(`retry exhaustion: expected the 4 recovered labels, got ${got?.values.length}`);
    if (attempts !== 3) fail(`retry exhaustion: expected 1 + 2 retries = 3 attempts, got ${attempts}`);
    if (res.lostReplies !== 3 || res.unresolvedReplies !== 1 || res.recoveredReplies !== 0) {
      fail(`retry exhaustion accounting: lost ${res.lostReplies} unresolved ${res.unresolvedReplies} recovered ${res.recoveredReplies}`);
    }
  }
  console.log('  cache/livewalk: a persistently missing reply still bounds the retry and ends the walk');

  // ---- Case 9: abort stops the walk ----------------------------------------
  {
    const controller = new AbortController();
    const t = new FixtureTransport(ordinary, { abortAfter: 25, controller });
    let threw = false;
    try {
      await liveWalk(t, { model: FM3, blocks: sections, maxParamId: maxId, signal: controller.signal });
    } catch {
      threw = true;
    }
    if (!threw) fail('abort did not stop the walk');
    if (t.requests > 40) fail(`abort too slow: ${t.requests} requests after abort at 25`);
  }
  console.log('  cache/livewalk: AbortSignal stops the walk promptly');

  // ---- Case 10: pacing invokes the injected scheduler -----------------------
  {
    let sleeps = 0;
    let total = 0;
    const t = new FixtureTransport([probe]);
    await liveWalk(t, {
      model: FM3,
      blocks: [probe.section],
      maxParamId: probe.id,
      paramAbsentRunLimit: probe.id + 2,
      interQueryMs: 3,
      blockPauseMs: 7,
      sleep: (ms) => {
        sleeps += 1;
        total += ms;
        return Promise.resolve();
      },
    });
    if (sleeps === 0 || total === 0) fail(`pacing scheduler not invoked (sleeps=${sleeps}, total=${total}ms)`);
  }
  console.log('  cache/livewalk: pacing routes delays through the injected scheduler');

  // ---- Case 11: end-to-end live == bytes (source-agnostic) ------------------
  // The fixture's empty rows (typecode 0, all-zero body) answer as empty slots. Inner ones come
  // back as placeholder records; TRAILING ones are unobservable (they answer exactly like the end
  // of the table), so the byte arm is built from the same observable record set.
  const isEmptyRow = (r: CacheRecord): boolean => r.tc === 0 && r.min === 0 && r.max === 0 && r.def === 0 && r.step === 0;
  const lastReal = new Map<number, number>();
  for (const r of ordinary) if (!isEmptyRow(r)) lastReal.set(r.section, Math.max(lastReal.get(r.section) ?? -1, r.id));
  const observable = ordinary.filter((r) => !isEmptyRow(r) || r.id < (lastReal.get(r.section) ?? -1));
  const innerEmpty = observable.filter(isEmptyRow).length;
  const transport = new FixtureTransport(ordinary);
  const liveRecords = await liveWalk(transport, {
    model: FM3,
    blocks: sections,
    maxParamId: maxId,
    paramAbsentRunLimit: 7000, // bridge the fixture's largest internal id gap
    interQueryMs: 0,
  });
  if (liveRecords.length !== observable.length) {
    fail(`live walk reached ${liveRecords.length} records, expected ${observable.length} observable (of ${ordinary.length} ordinary)`);
  }

  const fromLive = await buildCache(liveSource(transport, {
    model: FM3, blocks: sections, maxParamId: maxId, paramAbsentRunLimit: 7000,
  }), FM3_PARAMS, HW_SEEDS, { model: FM3, firmware: '12.0' });
  const fromBytes = await buildCache({ kind: 'bytes', buf: encodeCache(observable) }, FM3_PARAMS, HW_SEEDS, {
    model: FM3, firmware: '12.0',
  });
  if (fromLive.meta.schema !== CACHE_SCHEMA) fail(`live build schema ${fromLive.meta.schema} != ${CACHE_SCHEMA}`);
  const ws = fromLive.meta.walk;
  if (!ws || ws.lostReplies !== 0 || ws.unresolvedReplies !== 0 || ws.placeholderSlots !== innerEmpty) {
    fail(`liveSource walk stats not carried into meta.walk: ${JSON.stringify(ws)} (inner empty rows ${innerEmpty})`);
  }

  const a = JSON.stringify(dataOf(fromLive));
  const b = JSON.stringify(dataOf(fromBytes));
  if (a !== b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    fail(`live vs bytes diverged at char ${i}: live …${a.slice(Math.max(0, i - 40), i + 40)}… vs bytes …${b.slice(Math.max(0, i - 40), i + 40)}…`);
  }
  console.log(
    `  cache/livewalk: buildCache(live) deep-equals buildCache(bytes) (${liveRecords.length} records incl. ${innerEmpty} inner placeholders, ` +
      `${ordinary.length - observable.length} trailing empty rows unobservable, ${a.length} JSON chars)`,
  );

  // ---- Case 12: live build + byte-sourced special tables clears the oracle --
  const complete = await buildCache(
    { kind: 'live', walk: async () => [...liveRecords, ...specials] },
    FM3_PARAMS,
    HW_SEEDS,
    { model: FM3, firmware: '12.0' },
  );
  const m = assertFm3Equivalence(complete);
  console.log(
    `  cache/livewalk: live build clears FM3 oracle (enum ${m.enum.exact}/${m.enum.total}, ` +
      `ranges ${m.ranges.pct.toFixed(2)}%, DELAY ${m.delayRoster.count}, cab ${m.cabIrs.factory1}/${m.cabIrs.factory2}/${m.cabIrs.legacy})`,
  );

  // ---- Case 13: scale != 0 params get NO speculative 0x1f probes without a hint ----
  // FORGEFX-32: a 0x1f label query against a param with no label list is
  // out-of-contract and hard-freezes the FM3. A def with a non-zero `scale` slot
  // (the default value) may or may not have a list, and its numbers cannot tell —
  // without a caller hint the walk must emit only its definition query.
  {
    // Integral bounds + small span: WOULD pass the old enum heuristic, but scale=2 keeps it unprobed.
    const rec: CacheRecord = { kind: 'float', section: 94, offset: 0, id: 0, tc: 2, min: 0, max: 10, def: 5, step: 0, t1: 0, t2: 0 };
    let labelQueries = 0;
    const t: LiveTransport = {
      request(q) {
        const view = q[6]!;
        const param = q[10]! | (q[11]! << 7);
        if (view === VIEW_ENUM_LABEL) labelQueries += 1;
        if (view === VIEW_DEFINITION && param === 0) return Promise.resolve(replyFrame(VIEW_DEFINITION, 0, 0x3a, definitionBlockScaled(rec, 2)));
        return Promise.resolve(sentinelFrame(view, param));
      },
    };
    const recs = await liveWalk(t, { model: FM3, blocks: [94], maxParamId: 0 });
    if (labelQueries !== 0) fail(`scaled param got ${labelQueries} 0x1f probes (must be 0)`);
    if (recs[0]?.kind === 'enum') fail('scaled param mis-classified as enum');
  }
  console.log('  cache/livewalk: scale!=0 params are never 0x1f label-probed without a hint');

  // ---- Case 14: speculative probes never open a list at a high absolute sub --
  // The A440-style case: non-enum kind, scale 0, integral bounds far above 127
  // (e.g. 430..450). A speculative 0x1f at sub 430 is exactly the FORGEFX-32
  // freeze trigger — the walk must skip the probe (record stays non-enum).
  {
    const rec: CacheRecord = { kind: 'float', section: 95, offset: 0, id: 0, tc: 2, min: 430, max: 450, def: 440, step: 1, t1: 0, t2: 0 };
    let labelQueries = 0;
    const t: LiveTransport = {
      request(q) {
        const view = q[6]!;
        const param = q[10]! | (q[11]! << 7);
        if (view === VIEW_ENUM_LABEL) labelQueries += 1;
        if (view === VIEW_DEFINITION && param === 0) return Promise.resolve(replyFrame(VIEW_DEFINITION, 0, 0x3a, definitionBlockScaled(rec, 0)));
        return Promise.resolve(sentinelFrame(view, param));
      },
    };
    const recs = await liveWalk(t, { model: FM3, blocks: [95], maxParamId: 0 });
    if (labelQueries !== 0) fail(`high-min param got ${labelQueries} speculative 0x1f probes (must be 0)`);
    if (recs.length !== 1 || recs[0]!.kind === 'enum') fail('high-min param record wrong');
  }
  console.log('  cache/livewalk: speculative label probes never start above sub 127 (A440 guard)');

  // ---- Case 15: system-selector junk definitions are treated as absent ------
  // GOLDEN, captured from a real FM3 (2026-07-13 walk probe, FORGEFX-32 third freeze):
  // block 0 is a system selector that answers definition queries with junk — param 3's
  // "definition" decodes to subnormal bounds (≈3e-41) with tc 21540, which the old
  // tolerance-based integral() classified as a 1-value enum → 0x1f label query → the
  // device wedged (power-cycle). The walk must treat all four as ABSENT: no records,
  // no 0x1f, block skipped after the probe depth.
  {
    const BLOCK0_DEF_REPLIES: Record<number, string> = {
      0: 'f0 00 01 74 11 01 1c 00 00 00 00 00 00 00 00 00 00 00 00 24 00 03 00 00 0e 50 38 00 00 75 03 40 00 07 28 1c 00 00 3a 41 60 00 03 54 00 00 00 00 00 70 00 01 6a 07 00 00 0e 50 10 01 1f 72 40 7f f7',
      1: 'f0 00 01 74 11 01 1c 00 00 00 01 00 00 00 00 00 00 00 00 24 00 00 00 12 0e 28 43 7e 2f 70 48 16 00 41 44 01 70 10 38 60 0f 01 03 46 00 78 08 1c 30 07 40 41 63 0c 3c 13 7e 28 63 61 1f 72 40 30 f7',
      2: 'f0 00 01 74 11 01 1c 00 00 00 02 00 00 00 00 00 00 00 00 24 00 0c 3c 13 7e 28 63 61 1f 72 46 1e 09 7f 14 00 00 00 00 02 4f 04 7f 4a 14 78 27 7c 5d 42 48 00 00 04 15 00 00 00 31 28 00 00 00 1b f7',
      3: 'f0 00 01 74 11 01 1c 00 00 00 03 00 00 00 00 00 00 00 00 24 00 10 15 00 00 01 11 28 00 00 0a 0a 40 00 00 58 54 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 5f f7'
    };
    const parseHex = (s: string) => Uint8Array.from(s.split(' ').map((h) => parseInt(h, 16)));
    let labelQueries = 0;
    let defQueries = 0;
    const t: LiveTransport = {
      request(q) {
        const view = q[6]!;
        const param = q[10]! | (q[11]! << 7);
        if (view === VIEW_ENUM_LABEL) { labelQueries += 1; return Promise.resolve(endOfRangeFrame(VIEW_ENUM_LABEL, param)); }
        if (view === VIEW_DEFINITION) {
          defQueries += 1;
          const real = BLOCK0_DEF_REPLIES[param];
          return Promise.resolve(real ? parseHex(real) : sentinelFrame(VIEW_DEFINITION, param));
        }
        return Promise.resolve(sentinelFrame(view, param));
      }
    };
    const recs = await liveWalk(t, { model: FM3, blocks: [0], maxParamId: 127 });
    if (labelQueries !== 0) fail(`block-0 junk defs got ${labelQueries} 0x1f probes (must be 0 — this froze the FM3)`);
    if (recs.length !== 0) fail(`block-0 junk defs produced ${recs.length} records (must be 0)`);
    if (defQueries > 8) fail(`block 0 not skipped early: ${defQueries} def queries (probe depth must cut it short)`);
  }
  console.log('  cache/livewalk: real FM3 block-0 junk definitions are absent — no records, no 0x1f, early skip');

  // ---- Case 16: continuous unit vetoes the enum heuristic ------------------
  // CABINET_LOCUT1/2 (FM3 paramId 62/63) walk with scale==0, step==0 and integral
  // 20..200 bounds — the enum signature — but their device-true value string carries
  // a continuous 'Hz' unit. The heuristic must not tag them enum (that renders a
  // dropdown in Axis); a captured continuous unit downgrades the record to float.
  {
    const rec: CacheRecord = { kind: 'float', section: 96, offset: 0, id: 0, tc: 2, min: 20, max: 200, def: 20, step: 0, t1: 0, t2: 0 };
    const t: LiveTransport = {
      request(q) {
        const view = q[6]!;
        const param = q[10]! | (q[11]! << 7);
        if (view === VIEW_DEFINITION && param === 0) return Promise.resolve(replyFrame(VIEW_DEFINITION, 0, 0x3a, definitionBlockScaled(rec, 0)));
        if (view === VIEW_ENUM_LABEL) return Promise.resolve(endOfRangeFrame(VIEW_ENUM_LABEL, param));
        if (view === VIEW_VALUE && param === 0) return Promise.resolve(valueReply('200.00 Hz', 0));
        return Promise.resolve(sentinelFrame(view, param));
      },
    };
    const recs = await liveWalk(t, { model: FM3, blocks: [96], maxParamId: 0 });
    if (recs.length !== 1) fail(`LOCUT-style param produced ${recs.length} records (must be 1)`);
    if (recs[0]!.kind !== 'float') fail(`continuous-unit param mis-classified as ${recs[0]!.kind} (must be float)`);
    if (recs[0]!.unit !== 'Hz') fail(`continuous-unit param lost its unit: got ${recs[0]!.unit}`);
  }
  console.log('  cache/livewalk: a captured continuous unit vetoes the enum heuristic (LOCUT 20..200 Hz)');

  // ---- Case 17: view-0x00 value frames decode — interior NUL padding --------
  // Synthesized view-0x00 replies (model 0x11, built here from the documented layout:
  // 6-byte header, 15-byte inner header, cnt-byte payload as a continuous septet stream,
  // checksum, 0xF7 — i.e. complete 60-byte frames for a 32-byte payload). The payload is a
  // FIXED-WIDTH display buffer: a NUL-terminated display string followed by NUL padding.
  // A short value ('5.00', '0.00') pads with trailing NULs only, which a decode that trims
  // trailing NULs already handled. A string ('20.0 Hz') followed by NUL padding and then
  // further buffer content ('…Hz\0\0sec') leaves INTERIOR NUL padding; a decode that only
  // trims trailing NULs reads that padding as a non-printable byte and rejects the reply
  // with null, dropping the param's value AND its per-param unit on the live walk. The
  // string ends at the FIRST NUL.
  {
    const PAYLOAD = 32;
    // Zero-filled buffer = NUL padding; `extra` places a further field `gap` NULs after the string.
    const valueBuffer = (display: string, extra?: { gap: number; text: string }): Uint8Array => {
      const buf = new Uint8Array(PAYLOAD);
      for (let i = 0; i < display.length; i++) buf[i] = display.charCodeAt(i) & 0x7f;
      if (extra) {
        for (let i = 0; i < extra.text.length; i++) buf[display.length + extra.gap + i] = extra.text.charCodeAt(i) & 0x7f;
      }
      return buf;
    };
    const valueFrame = (display: string, param: number, extra?: { gap: number; text: string }): Uint8Array =>
      replyFrame(VIEW_VALUE, param, 0x3a, valueBuffer(display, extra));
    const DELAY = 70;
    const LOWCUT = 16;
    const trailingA = valueFrame('5.00', 33);
    const trailingB = valueFrame('0.00', 0);
    const interior = valueFrame('20.0 Hz', LOWCUT, { gap: 2, text: 'sec' });
    const interiorShort = valueFrame('-3.0 dB', 5, { gap: 1, text: 'ms' });

    // The synthesized frames have the documented shape: 60 bytes, cnt 32, payload recovered by
    // the septet decoder exactly as built.
    for (const f of [trailingA, trailingB, interior, interiorShort]) {
      if (f.length !== 60) fail(`synthesized value frame is ${f.length} bytes (expected 60)`);
      const inner = f.subarray(6, f.length - 2);
      if ((inner[13]! | (inner[14]! << 8)) !== PAYLOAD) fail('synthesized value frame cnt != 32');
    }
    const interiorPayload = decodeSeptetStream(interior.subarray(6, interior.length - 2), PAYLOAD, 15);
    if (interiorPayload[7] !== 0 || interiorPayload[8] !== 0 || interiorPayload[9] !== 0x73) {
      fail('synthesized interior-padding payload is not "20.0 Hz" + 2 NULs + "sec"');
    }

    const dA = decodeReply(trailingA);
    const dB = decodeReply(trailingB);
    const dInterior = decodeReply(interior);
    const dShort = decodeReply(interiorShort);
    if (!dA || dA.view !== 'value' || dA.value !== '5.00') {
      fail(`trailing-padding value frame decoded ${JSON.stringify(dA)} (expected value '5.00')`);
    }
    if (!dB || dB.view !== 'value' || dB.value !== '0.00') {
      fail(`trailing-padding value frame decoded ${JSON.stringify(dB)} (expected value '0.00')`);
    }
    if (!dInterior || dInterior.view !== 'value' || dInterior.value !== '20.0 Hz') {
      fail(`interior-padding value frame decoded ${JSON.stringify(dInterior)} (expected value '20.0 Hz')`);
    }
    if (!dShort || dShort.view !== 'value' || dShort.value !== '-3.0 dB') {
      fail(`single-NUL interior value frame decoded ${JSON.stringify(dShort)} (expected value '-3.0 dB')`);
    }

    // The side effect follows from the same decode: the walk's per-param unit
    // read uses view 0x00 and previously got null for this frame, so the
    // served record carried NO `unit`. A decoded value recovers it.
    const valueText = (d: ReturnType<typeof decodeReply>): string => (d && d.view === 'value' ? d.value : '');
    if (parseUnit(valueText(dInterior)) !== 'Hz') fail(`interior-padding unit not recovered: ${parseUnit(valueText(dInterior))}`);
    if (parseUnit(valueText(dShort)) !== 'dB') fail(`single-NUL interior unit not recovered: ${parseUnit(valueText(dShort))}`);
    const defRec: CacheRecord = { kind: 'float', section: DELAY, offset: 0, id: LOWCUT, tc: 0x241, min: 0, max: 100, def: 0, step: 0, t1: 0, t2: 0 };
    const t: LiveTransport = {
      request(q) {
        const view = q[6]!;
        const param = q[10]! | (q[11]! << 7);
        if (view === VIEW_DEFINITION && param === LOWCUT) return Promise.resolve(definitionReply(defRec, LOWCUT));
        if (view === VIEW_VALUE && param === LOWCUT) return Promise.resolve(interior);
        if (view === VIEW_ENUM_LABEL) return Promise.resolve(endOfRangeFrame(VIEW_ENUM_LABEL, param));
        return Promise.resolve(sentinelFrame(view, param));
      },
    };
    const recs = await liveWalk(t, {
      model: FM3,
      blocks: [DELAY],
      maxParamId: LOWCUT,
      paramAbsentRunLimit: LOWCUT + 4,
      blockProbeDepth: LOWCUT + 2,
    });
    const got = recs.find((r) => r.id === LOWCUT);
    if (!got || got.kind !== 'float') fail(`unit-read walk did not reach the interior-padding param (got ${JSON.stringify(got)})`);
    if (got?.unit !== 'Hz') fail(`interior-padding record unit=${JSON.stringify(got?.unit)} (interior-NUL value frame dropped the unit)`);

    // An ENUM-SHAPED definition (scale 0, step 0, integral 20..200 bounds) whose label
    // query gets NO answer at all: the unit read is then the only thing that can tell it
    // from a real enum. With interior padding in the value reply the unit comes back, and
    // the continuous unit keeps the record a float. (An answered-but-empty label list would
    // veto the enum on its own, so the label reply is a lost one here.)
    const SECTION = 96;
    const enumShaped: CacheRecord = { kind: 'float', section: SECTION, offset: 0, id: 0, tc: 2, min: 20, max: 200, def: 20, step: 0, t1: 0, t2: 0 };
    const t2: LiveTransport = {
      request(q) {
        const view = q[6]!;
        const param = q[10]! | (q[11]! << 7);
        if (view === VIEW_DEFINITION && param === 0) return Promise.resolve(replyFrame(VIEW_DEFINITION, 0, 0x3a, definitionBlockScaled(enumShaped, 0)));
        if (view === VIEW_ENUM_LABEL) return Promise.resolve(null);
        if (view === VIEW_VALUE && param === 0) return Promise.resolve(valueFrame('200.0 Hz', 0, { gap: 2, text: 'sec' }));
        return Promise.resolve(sentinelFrame(view, param));
      },
    };
    const recs2 = await liveWalk(t2, { model: FM3, blocks: [SECTION], maxParamId: 0, lostReplyDrainMs: 0 });
    if (recs2.length !== 1) fail(`enum-shaped interior-padding walk produced ${recs2.length} records (must be 1)`);
    if (recs2[0]!.kind !== 'float') fail(`enum-shaped param with an interior-padding unit became '${recs2[0]!.kind}' (must stay float)`);
    if (recs2[0]!.unit !== 'Hz') fail(`enum-shaped interior-padding record unit=${JSON.stringify(recs2[0]!.unit)} (must be 'Hz')`);
  }
  console.log('  cache/livewalk: view-0x00 value frames (incl. interior-NUL padding) decode and recover the unit');

  // ---- Case 18: decodeReply gates the DEFINITION branch on the VIEW byte -----
  // The branch used to be keyed on `cnt === 36` + five finite floats ALONE.
  // ASCII text always satisfies "finite float" (a byte ≤ 0x7E can never give an
  // exponent of 0xFF), so ANY 36-byte text reply under ANY view came back as a
  // bogus `definition`. The view echo is frame[6] (`selector`); the definition
  // view is 0x1c.
  {
    // (a) a REAL definition frame (view 0x1c) must still decode as 'definition'.
    const realDef = decodeReply(definitionReply(probe, probe.id));
    if (!realDef || realDef.view !== 'definition') {
      fail(`real view-0x1c definition frame decoded ${JSON.stringify(realDef)} (must be 'definition')`);
    }
    // (b) the SAME kind of 36-byte payload under a NON-definition view must NOT
    // decode as a definition. 36 ASCII 'A' (0x41) bytes — every f32 field is
    // finite (0x41414141 ≈ 12.078), which is exactly the misclassification.
    const text36 = Uint8Array.from(Array.from({ length: 36 }, () => 0x41));
    // It falls through to the string branch: a value under view 0x00, a label under 0x1f.
    const text36Str = 'A'.repeat(36);
    const underValue = decodeReply(replyFrame(VIEW_VALUE, 0, 0x3a, text36));
    if (underValue && underValue.view === 'definition') {
      fail('36-byte ASCII payload under view 0x00 mis-decoded as a definition');
    }
    if (!underValue || underValue.view !== 'value' || underValue.value !== text36Str) {
      fail(`36-byte ASCII payload under view 0x00 decoded ${JSON.stringify(underValue)} (expected the 36-char value)`);
    }
    const underLabel = decodeReply(replyFrame(VIEW_ENUM_LABEL, 0, 0x3a, text36));
    if (underLabel && underLabel.view === 'definition') {
      fail('36-byte ASCII payload under view 0x1f mis-decoded as a definition');
    }
    if (!underLabel || underLabel.view !== 'enum_label' || underLabel.label !== text36Str) {
      fail(`36-byte ASCII payload under view 0x1f decoded ${JSON.stringify(underLabel)} (expected the 36-char label)`);
    }
  }
  console.log('  cache/livewalk: decodeReply returns a definition ONLY under the view-0x1c echo');

  // ---- Case 19: an interior-NUL 0x1f reply does NOT flip a float to an enum --
  // With interior-NUL tolerance, a speculative 0x1f probe of a float with
  // integral bounds could decode a "printable prefix + NUL + junk" reply as a
  // label, and buildRecord's `labels.length > 0` then flipped the FLOAT to an
  // enum — so a re-walked cache would differ. A label buffer holds ONE string:
  // anything non-NUL after its terminator means the reply is not a label.
  //
  // Reachability: only a def `couldBeEnum` accepts is probed, which needs
  // scale == 0 (a scale!=0 def is never probed on its numbers, only on a caller
  // hint whose list fits it). A
  // scale-0 float with integral bounds IS reachable: bounds 0..5 with a
  // non-integral step 0.5 → classifyKind 'float'. That is the case below.
  {
    const bad = Uint8Array.from([0x41, 0x42, 0x00, 0x00, 0x80, 0xff, 0x7e]); // 'AB' + NUL + junk
    const badFrame = replyFrame(VIEW_ENUM_LABEL, 0, 0x3a, bad);
    if (decodeReply(badFrame) !== null) {
      fail('interior-NUL 0x1f reply decoded as a label (flips a numeric float to enum)');
    }

    const floatRec: CacheRecord = { kind: 'float', section: 94, offset: 0, id: 0, tc: 16, min: 0, max: 5, def: 0, step: 0.5, t1: 0, t2: 0 };
    let labelQueries = 0;
    const t: LiveTransport = {
      request(q) {
        const view = q[6]!;
        const param = q[10]! | (q[11]! << 7);
        const sub = q[12]! | (q[13]! << 7);
        if (view === VIEW_ENUM_LABEL) {
          labelQueries += 1;
          if (sub === 0) return Promise.resolve(badFrame);
          return Promise.resolve(endOfRangeFrame(VIEW_ENUM_LABEL, param));
        }
        if (view === VIEW_DEFINITION && param === 0) {
          return Promise.resolve(replyFrame(VIEW_DEFINITION, 0, 0x3a, definitionBlockScaled(floatRec, 0)));
        }
        return Promise.resolve(sentinelFrame(view, param));
      },
    };
    const recs = await liveWalk(t, { model: FM3, blocks: [94], maxParamId: 0 });
    if (labelQueries === 0) fail('the float was never 0x1f-probed — the case does not exercise the decode path');
    if (recs.length !== 1) fail(`interior-NUL float walk produced ${recs.length} records`);
    if (recs[0]!.kind !== 'float') {
      fail(`interior-NUL 0x1f reply reclassified the float as '${recs[0]!.kind}'`);
    }

    // POSITIVE CONTROL: a CLEAN trailing-NUL-padded label must still decode — the
    // strict rule sweeps away junk, not genuine labels.
    const clean = Uint8Array.from([0x55, 0x53, 0x41, 0x00, 0x00, 0x00]); // 'USA' + trailing NULs
    const cd = decodeReply(replyFrame(VIEW_ENUM_LABEL, 0, 0x3a, clean));
    if (!cd || cd.view !== 'enum_label' || cd.label !== 'USA') {
      fail(`clean trailing-NUL label decoded ${JSON.stringify(cd)} (expected enum_label 'USA')`);
    }
  }
  console.log('  cache/livewalk: an interior-NUL 0x1f reply is not a label — a numeric float stays a float');

  // ---- Case 20: a non-value view keeps the strict string rule ---------------
  // Only the value view (0x00) tolerates content after the first NUL. Every other
  // view — the large value dump 0x2e is one — still decodes a payload with non-NUL
  // bytes after its first NUL to null, exactly as it did before strings ended at
  // the first NUL. The same bytes under the value view are a value.
  {
    const VIEW_DUMP = 0x2e;
    const junk = Uint8Array.from([0x41, 0x42, 0x00, 0x05, 0x80, 0xff, 0x7e]); // 'AB' + NUL + junk
    const dump = decodeReply(replyFrame(VIEW_DUMP, 0, 0x3a, junk));
    if (dump !== null) fail(`view 0x2e payload with bytes after the first NUL decoded ${JSON.stringify(dump)} (must be null)`);
    const asValue = decodeReply(replyFrame(VIEW_VALUE, 0, 0x3a, junk));
    if (!asValue || asValue.view !== 'value' || asValue.value !== 'AB') {
      fail(`the same payload under the value view decoded ${JSON.stringify(asValue)} (expected value 'AB')`);
    }
    // POSITIVE CONTROL: a clean trailing-NUL-padded payload under 0x2e still decodes.
    const clean = decodeReply(replyFrame(VIEW_DUMP, 0, 0x3a, Uint8Array.from([0x41, 0x42, 0x00, 0x00, 0x00])));
    if (!clean || clean.view !== 'string' || clean.text !== 'AB') {
      fail(`clean trailing-NUL 0x2e payload decoded ${JSON.stringify(clean)} (expected string 'AB')`);
    }
  }
  console.log('  cache/livewalk: only the value view tolerates bytes after the first NUL — other views stay strict');

  // ---- Case 21: buildValueQuery frame bytes; the walk's value reads use it ----
  // The view-0x00 query is laid out like the definition / label queries: F0 00 01 74 <model> 01,
  // a 15-byte body (view, 0, block lo/hi, param lo/hi, sub lo/hi — zero for a value query — then
  // zero padding), the checksum (XOR of everything before it, & 0x7f) and F7. The walk's unit
  // read goes through this builder, so every view-0x00 frame it sends is byte-identical to it.
  {
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
    const layout = (model: number, block: number, param: number): Uint8Array => {
      const body = new Array<number>(15).fill(0);
      body[0] = VIEW_VALUE;
      body[2] = block & 0x7f;
      body[3] = (block >> 7) & 0x7f;
      body[4] = param & 0x7f;
      body[5] = (param >> 7) & 0x7f;
      const core = [0xf0, 0x00, 0x01, 0x74, model & 0x7f, 0x01, ...body];
      return Uint8Array.from([...core, fractalCksum(core), 0xf7]);
    };
    // A literal frame (FM3, block 70, param 16) pins the layout independently of the helper above.
    const literal = 'f0 00 01 74 11 01 00 00 46 00 10 00 00 00 00 00 00 00 00 00 00 43 f7';
    if (hex(buildValueQuery(FM3, 70, 16)) !== literal) fail(`buildValueQuery(FM3, 70, 16) = ${hex(buildValueQuery(FM3, 70, 16))}`);
    for (const [block, param] of [[70, 16], [0, 0], [96, 127], [130, 128], [129, 300]] as const) {
      const got = buildValueQuery(FM3, block, param);
      if (hex(got) !== hex(layout(FM3, block, param))) fail(`buildValueQuery(FM3, ${block}, ${param}) layout mismatch: ${hex(got)}`);
      // Same frame as the definition query apart from the view byte (and thus the checksum).
      const def = buildDefQuery(FM3, block, param);
      if (got.length !== def.length) fail('value and definition queries differ in length');
      for (let i = 0; i < got.length - 2; i++) {
        if (i !== 6 && got[i] !== def[i]) fail(`value query differs from the definition query at byte ${i}`);
      }
      if (got[6] !== VIEW_VALUE) fail(`value query view byte is ${got[6]}`);
    }

    // The walk's unit read sends exactly buildValueQuery's frame.
    const DELAY = 70;
    const LOWCUT = 16;
    const defRec: CacheRecord = { kind: 'float', section: DELAY, offset: 0, id: LOWCUT, tc: 0x241, min: 0, max: 100, def: 0, step: 0, t1: 0, t2: 0 };
    const sent: Uint8Array[] = [];
    const t: LiveTransport = {
      request(q) {
        const view = q[6]!;
        const param = q[10]! | (q[11]! << 7);
        if (view === VIEW_VALUE) {
          sent.push(Uint8Array.from(q));
          return Promise.resolve(valueReply('20.0 Hz', param));
        }
        if (view === VIEW_DEFINITION && param === LOWCUT) return Promise.resolve(definitionReply(defRec, LOWCUT));
        if (view === VIEW_ENUM_LABEL) return Promise.resolve(endOfRangeFrame(VIEW_ENUM_LABEL, param));
        return Promise.resolve(sentinelFrame(view, param));
      },
    };
    const recs = await liveWalk(t, {
      model: FM3,
      blocks: [DELAY],
      maxParamId: LOWCUT,
      paramAbsentRunLimit: LOWCUT + 4,
      blockProbeDepth: LOWCUT + 2,
    });
    if (sent.length === 0) fail('the walk sent no view-0x00 unit read');
    const want = hex(buildValueQuery(FM3, DELAY, LOWCUT));
    for (const q of sent) if (hex(q) !== want) fail(`the walk's unit read ${hex(q)} != buildValueQuery ${want}`);
    if (recs.find((r) => r.id === LOWCUT)?.unit !== 'Hz') fail('the walk did not record the unit read through buildValueQuery');
  }
  console.log('  cache/livewalk: buildValueQuery frame bytes are pinned and the walk\'s unit read sends exactly that frame');
}
