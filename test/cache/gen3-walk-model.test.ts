/**
 * Gen-3 definition walk — per-model constants, device-supplied parameter counts, and the label
 * gate.
 *
 * Every case runs synthetic frames through the real `liveWalkDetailed` (no device bytes, nothing
 * opens a port). The fakes record every query, so a case can assert exactly which ids a walk was
 * allowed to touch.
 *
 * The rule under test: a device-reported parameter count (`func 0x01 sub 0x01`, count at
 * descriptor `+0x1C` = payload `+0x04` of the 56-byte form) may only TIGHTEN a block's query
 * bound. Querying far past a table's end froze a unit, so the walk must never use a count to
 * widen what the caller allowed — and it must use a smaller count to stop early.
 *
 * Labels: the editors' gate is typecode class {1,10,11,12} AND a non-zero wire `+0x1C` label-table
 * word; labels are positional by arrival order.
 */
import {
  buildBlockDescriptorQuery,
  buildCabBankQuery,
  buildPresetNameQuery,
  decodeBlockDescriptor,
  decodeCabBankRecordReply,
  decodePresetNameReply,
  decodeReply,
  GEN3_LABEL_TYPECODE_CLASSES,
  gen3BlockSweepOrdinals,
  gen3TypecodeClass,
  gen3WalkProfile,
  GEN3_WALK_PROFILES,
  liveWalkDetailed,
  readBlockParamCounts,
  readCabBankRecords,
  readPresetNames,
  VIEW_DEFINITION,
  VIEW_ENUM_LABEL,
  VIEW_VALUE,
} from '../../src/cache/index.js';
import type { LiveTransport, LiveWalkOptions } from '../../src/cache/index.js';
import type { CacheRecord } from '../../src/cache/types.js';

export const GEN3_WALK_MODEL_CASE_COUNT = 13;

const III = 0x10;
const FM3 = 0x11;
const FM9 = 0x12;
const noSleep = (): Promise<void> => Promise.resolve();

// ---------------------------------------------------------------------------
// Synthetic wire encoders (test-only; inverse of the codec)
// ---------------------------------------------------------------------------

/** Continuous MSB-first septet packer — inverse of `decodeSeptetStream`. */
function septets(raw: Uint8Array): number[] {
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
  return wire;
}

function cksum(bytes: readonly number[]): number {
  let acc = 0;
  for (const b of bytes) acc ^= b;
  return acc & 0x7f;
}

/**
 * A func 0x01 reply: `inner[0]` = sub, `inner[2:4]` = `a` echo, `inner[4:6]` = `b` echo,
 * `inner[6:10]` = `c` word, `inner[13:15]` = payload count, payload = raw bytes.
 */
function reply(model: number, sub: number, a: number, b: number, c: number, raw: Uint8Array): Uint8Array {
  const inner = new Array<number>(15).fill(0);
  inner[0] = sub & 0x7f;
  inner[1] = (sub >> 7) & 0x7f;
  inner[2] = a & 0x7f;
  inner[3] = (a >> 7) & 0x7f;
  inner[4] = b & 0x7f;
  inner[5] = (b >> 7) & 0x7f;
  inner[6] = c & 0x7f;
  inner[7] = (c >> 7) & 0x7f;
  inner[8] = (c >> 14) & 0x7f;
  inner[9] = (c >> 21) & 0x7f;
  inner[13] = raw.length & 0x7f;
  inner[14] = (raw.length >> 7) & 0x7f;
  const core = [0xf0, 0x00, 0x01, 0x74, model, 0x01, ...inner, ...septets(raw)];
  return Uint8Array.from([...core, cksum(core), 0xf7]);
}

/** An answered no-payload reply (the past-the-end answer of an effect table). */
function emptyReply(model: number, sub: number, param: number, tag = 0x4d): Uint8Array {
  return reply(model, sub, 1, param, tag, new Uint8Array(0));
}

/** The same frame with the payload count written as a raw u16 (the old, wrong shape). */
function replyRawCount(model: number, sub: number, a: number, b: number, c: number, raw: Uint8Array): Uint8Array {
  const frame = reply(model, sub, a, b, c, raw);
  frame[19] = raw.length & 0xff;
  frame[20] = (raw.length >> 8) & 0xff;
  // Re-checksum the mutated frame so only the count shape is wrong.
  let ck = 0;
  for (let i = 0; i < frame.length - 2; i++) ck ^= frame[i]!;
  frame[frame.length - 2] = ck & 0x7f;
  return frame;
}

interface DefSpec {
  id: number;
  tc: number;
  min: number;
  max: number;
  /** The f32 at +16 (the parameter's default raw value, named `scale` for history). */
  scale: number;
  def: number;
  step: number;
  /** The u32 at +28: non-zero together with a label-capable class means "has labels". */
  labelTable?: number;
  flags?: number;
}

/** A 36-byte definition payload. */
function defBody(d: DefSpec): Uint8Array {
  const buf = new Uint8Array(36);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, d.id, true);
  dv.setUint32(4, d.tc, true);
  dv.setFloat32(8, d.min, true);
  dv.setFloat32(12, d.max, true);
  dv.setFloat32(16, d.scale, true);
  dv.setFloat32(20, d.def, true);
  dv.setFloat32(24, d.step, true);
  dv.setUint32(28, d.labelTable ?? 0, true);
  dv.setUint32(32, d.flags ?? 0, true);
  return buf;
}

const realFloat = (id: number): DefSpec => ({ id, tc: 2, min: 0, max: 10, scale: 1, def: 5, step: 0 });

/** A block descriptor payload: `count` at `+0x04` (56-byte form) or `+0x1C` (80-byte form). */
function descriptorBody(count: number, length: 56 | 80): Uint8Array {
  const buf = new Uint8Array(length);
  new DataView(buf.buffer).setUint32(length === 56 ? 4 : 0x1c, count, true);
  return buf;
}

// ---------------------------------------------------------------------------
// Recording fake device
// ---------------------------------------------------------------------------

interface Q {
  view: number;
  block: number;
  param: number;
  sub: number;
}

function decodeQuery(query: Uint8Array): Q {
  return {
    view: query[6]!,
    block: query[8]! | (query[9]! << 7),
    param: query[10]! | (query[11]! << 7),
    sub: query[12]! | (query[13]! << 7),
  };
}

interface Fake extends LiveTransport {
  readonly sent: Q[];
  frozen: boolean;
  count(view: number, block?: number, param?: number): number;
  maxParam(block: number): number;
}

/** `respond` answers a query; a query above `freezeAbove` silences the fake forever. */
function fake(respond: (q: Q) => Uint8Array | null, freezeAbove?: number): Fake {
  const sent: Q[] = [];
  const f: Fake = {
    sent,
    frozen: false,
    request(query: Uint8Array): Promise<Uint8Array | null> {
      const q = decodeQuery(query);
      sent.push(q);
      if (f.frozen) return Promise.resolve(null);
      if (freezeAbove !== undefined && q.param > freezeAbove) {
        f.frozen = true;
        return Promise.resolve(null);
      }
      return Promise.resolve(respond(q));
    },
    count: (view, block, param) =>
      sent.filter((q) => q.view === view && (block === undefined || q.block === block) && (param === undefined || q.param === param)).length,
    maxParam: (block) => sent.reduce((m, q) => (q.block === block ? Math.max(m, q.param) : m), -1),
  };
  return f;
}

interface TableSpec {
  /** Params `0..real-1` answer a real float definition under unique ids. */
  real: number;
  /** Per-param override: a definition, `null` for the past-the-end answer, `undefined` for the default. */
  extra?: (param: number) => DefSpec | null | undefined;
  /** Label texts per param, served at ascending raw ordinals. */
  labels?: (param: number) => readonly string[] | undefined;
}

/** A model-shaped device: real definitions, then no-payload table-end replies; labels by list. */
function tableDevice(blocks: Record<number, TableSpec>, model = FM3, freezeAbove?: number): Fake {
  return fake((q) => {
    const table = blocks[q.block];
    if (!table) return emptyReply(model, q.view, q.param);
    if (q.view === VIEW_ENUM_LABEL) {
      const labels = table.labels?.(q.param);
      if (labels !== undefined) {
        const text = labels[q.sub - Math.floor(table.extra?.(q.param)?.min ?? 0)];
        if (text !== undefined) return reply(model, VIEW_ENUM_LABEL, 1, q.param, 0, Uint8Array.from([...text].map((c) => c.charCodeAt(0) & 0x7f)));
      }
      return emptyReply(model, VIEW_ENUM_LABEL, q.param, 0x40);
    }
    if (q.view === VIEW_VALUE) return emptyReply(model, VIEW_VALUE, q.param);
    if (q.view !== VIEW_DEFINITION) return emptyReply(model, q.view, q.param);
    const x = table.extra?.(q.param);
    if (x === null) return emptyReply(model, VIEW_DEFINITION, q.param);
    if (x !== undefined) return reply(model, VIEW_DEFINITION, 1, q.param, 0, defBody(x));
    if (q.param < table.real) return reply(model, VIEW_DEFINITION, 1, q.param, 0, defBody(realFloat(100 + q.param)));
    return emptyReply(model, VIEW_DEFINITION, q.param);
  }, freezeAbove);
}

const paramsOf = (records: readonly CacheRecord[], block: number): number[] => records.filter((r) => r.section === block).map((r) => r.id);
const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const sameList = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

export async function runGen3WalkModel(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[cache/gen3-walk-model] ${msg}`);
  };
  const base: LiveWalkOptions = { model: FM3, readValues: false, sleep: noSleep };

  // ---- Case 1: the per-model constants are exactly the documented ones ---------------------
  {
    const models = [III, FM3, FM9].map((m) => gen3WalkProfile(m));
    if (models.some((p) => p === undefined)) fail('a gen-3 model has no profile');
    const [iii, fm3, fm9] = models as NonNullable<(typeof models)[number]>[];
    const rows: Array<[string, number, number, number, number, number]> = [
      // model, messageObjectSize, gridBlobSize, cabRecordSize, blockSweepBound, cabBankSub
      [III, 0x268, 640, 0x2b0, 0x3d, 0x68],
      [FM3, 0x1c0, 496, 0x220, 0x3b, 0x9f],
      [FM9, 0x1c0, 640, 0x2b0, 0x3b, 0xa4],
    ];
    for (const [model, objectSize, gridBlob, cabStride, sweep, bankSub] of rows) {
      const p = gen3WalkProfile(model)!;
      if (p.messageObjectSize !== objectSize || p.gridBlobSize !== gridBlob || p.cabRecordSize !== cabStride || p.blockSweepBound !== sweep || p.cabBankSub !== bankSub) {
        fail(`profile 0x${model.toString(16)}: ${JSON.stringify(p)}`);
      }
      const cabinet = p.effectIds.find((e) => e.family === 'CABINET');
      if (!cabinet || cabinet.firstId !== 62) fail(`profile 0x${model.toString(16)}: CABINET roster row is ${JSON.stringify(cabinet)}`);
    }
    if (GEN3_WALK_PROFILES.length !== 3 || gen3WalkProfile(0x14) !== undefined || gen3WalkProfile(undefined) !== undefined) {
      fail('the profile table must hold exactly the three gen-3 models and reject every other model');
    }
    if (iii!.name !== 'Axe-Fx III' || fm3!.name !== 'FM3' || fm9!.name !== 'FM9') fail('profile names changed');
  }
  console.log('  cache/gen3-walk-model: profiles — message object 0x268/0x1c0, grid blob 640/496/640, cab stride 0x2b0/0x220, sweep bound 0x3d/0x3b, cab sub 0x68/0x9f/0xa4');

  // ---- Case 2: model-generic request builders, with the documented cab/name goldens ---------
  {
    const sameBytes = (got: Uint8Array, want: readonly number[]): boolean => got.length === want.length && [...got].every((b, i) => b === want[i]);
    // 15-byte header: u16 sub (2 septets), u16 a, u16 b, u32 c, reserved, u16 d, u16 n.
    const cab0 = (model: number, sub: number, cs: number): number[] => [
      0xf0, 0x00, 0x01, 0x74, model, 0x01, sub & 0x7f, (sub >> 7) & 0x7f, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, cs, 0xf7,
    ];
    // The cab/IR record request: func 0x01, the model's own sub (a 14-bit field — `0x9F` is
    // `1F 01`, never a literal 0x9F byte), c = index, no payload.
    if (!sameBytes(buildCabBankQuery(FM3, 0), cab0(FM3, 0x9f, 0x0b))) fail(`FM3 cab query idx 0: ${[...buildCabBankQuery(FM3, 0)].join(',')}`);
    if (!sameBytes(buildCabBankQuery(FM9, 0), cab0(FM9, 0xa4, 0x33))) fail(`FM9 cab query idx 0: ${[...buildCabBankQuery(FM9, 0)].join(',')}`);
    if (!sameBytes(buildCabBankQuery(III, 0), cab0(III, 0x68, 0x7c))) fail(`III cab query idx 0: ${[...buildCabBankQuery(III, 0)].join(',')}`);
    // c = 1023 in the u32 c field (four septets): 7F 07 00 00.
    const idx1023 = [0xf0, 0x00, 0x01, 0x74, FM3, 0x01, 0x1f, 0x01, 0, 0, 0, 0, 0x7f, 0x07, 0, 0, 0, 0, 0, 0, 0, 0x73, 0xf7];
    if (!sameBytes(buildCabBankQuery(FM3, 1023), idx1023)) fail(`FM3 cab query idx 1023: ${[...buildCabBankQuery(FM3, 1023)].join(',')}`);
    // The preset-name request: sub 0x4B, c = 0x1000 reproduces the captured hardware frame
    // (a 16-slot batch ascending from 0x1000).
    const preset = [0xf0, 0x00, 0x01, 0x74, FM3, 0x01, 0x4b, 0, 0, 0, 0, 0, 0, 0x20, 0, 0, 0, 0, 0, 0, 0, 0x7e, 0xf7];
    if (!sameBytes(buildPresetNameQuery(FM3, 0x1000), preset)) fail(`preset-name query: ${[...buildPresetNameQuery(FM3, 0x1000)].join(',')}`);
    // The block descriptor: sub 0x01, a = block, b = 0.
    const dq = buildBlockDescriptorQuery(FM3, 300);
    if (dq[6] !== 0x01 || (dq[8]! | (dq[9]! << 7)) !== 300 || dq[10] !== 0 || dq[11] !== 0) fail(`descriptor query ${[...dq].join(',')}`);
    for (const [model, index] of [[III, 0], [FM9, 0], [FM3, 0], [0x14, 0]] as const) {
      let threw = false;
      try {
        buildCabBankQuery(model, index);
      } catch {
        threw = true;
      }
      if (model === 0x14 ? !threw : threw) fail(`cab query model gate: 0x${model.toString(16)} threw=${threw}`);
    }
  }
  console.log('  cache/gen3-walk-model: request builders — captured cab frames for FM3/FM9/III and the captured 0x4b preset-name frame reproduce byte-exactly');

  // ---- Case 3: block-descriptor decode, both payload forms ---------------------------------
  {
    const d56 = decodeBlockDescriptor(reply(FM3, 0x01, 1, 0, 0, descriptorBody(133, 56)));
    const d80 = decodeBlockDescriptor(reply(FM9, 0x01, 1, 0, 0, descriptorBody(7, 80)));
    if (!d56 || d56.paramCount !== 133 || d56.payloadBytes !== 56) fail(`56-byte descriptor ${JSON.stringify(d56)}`);
    if (!d80 || d80.paramCount !== 7 || d80.payloadBytes !== 80) fail(`80-byte descriptor ${JSON.stringify(d80)}`);
    for (const payload of [new Uint8Array(55), new Uint8Array(57), new Uint8Array(64)]) {
      if (decodeBlockDescriptor(reply(FM3, 0x01, 1, 0, 0, payload)) !== null) fail(`a ${payload.length}-byte descriptor must not decode`);
    }
    if (decodeBlockDescriptor(reply(FM3, 0x01, 1, 0, 0, descriptorBody(0x801, 56))) !== null) fail('a count above 0x800 must be rejected');
    if (decodeBlockDescriptor(emptyReply(FM3, 0x01, 0)) !== null) fail('a no-payload reply must not decode as a descriptor');
    if (decodeBlockDescriptor(reply(FM3, 0x1c, 1, 0, 0, descriptorBody(3, 56))) !== null) fail('a foreign sub must not decode as a descriptor');
  }
  console.log('  cache/gen3-walk-model: block descriptor — 56-byte count at payload+0x04, 80-byte at +0x1C; other lengths, counts above 0x800 and foreign subs reject');

  // ---- Case 4: a reported count TIGHTENS the bound -----------------------------------------
  {
    const layout = { 1: { real: 20 } };
    // Control: no count — real 0..19, then the stop run of 32.
    const control = tableDevice(layout);
    const rc = await liveWalkDetailed(control, { ...base, blocks: [1], maxParamId: 100 });
    if (control.maxParam(1) !== 19 + 32 || paramsOf(rc.records, 1).length !== 20) fail(`control: highest ${control.maxParam(1)}, ${paramsOf(rc.records, 1).length} records`);
    // Count 8: exactly 0..7, no lookahead.
    const counted = tableDevice(layout);
    const rk = await liveWalkDetailed(counted, { ...base, blocks: [1], maxParamId: 100, paramCountByBlock: { 1: 8 } });
    if (counted.maxParam(1) !== 7 || counted.count(VIEW_DEFINITION) !== 8 || !sameList(paramsOf(rk.records, 1), range(0, 7))) {
      fail(`count 8: highest ${counted.maxParam(1)}, ${counted.count(VIEW_DEFINITION)} queries, records ${paramsOf(rk.records, 1).join(',')}`);
    }
    // A hard bound and a known size are tightened the same way.
    const bounded = tableDevice(layout);
    await liveWalkDetailed(bounded, { ...base, blocks: [1], maxParamId: 100, paramBoundByBlock: { 1: 20 }, paramKnownSizeByBlock: { 1: 20 }, paramCountByBlock: { 1: 5 } });
    if (bounded.maxParam(1) !== 4) fail(`count 5 under bound/size 20: highest ${bounded.maxParam(1)}`);
  }
  console.log('  cache/gen3-walk-model: a reported count cuts the walk to 0..count-1 (no stop run, no lookahead) — control walks 0..51');

  // ---- Case 5: a reported count NEVER widens the caller's bound ----------------------------
  {
    const layout = { 1: { real: 30 } };
    // A count far above maxParamId: the caller's 20 still holds.
    const capped = tableDevice(layout);
    await liveWalkDetailed(capped, { ...base, blocks: [1], maxParamId: 20, paramCountByBlock: { 1: 500 } });
    if (capped.maxParam(1) !== 20) fail(`count 500 over maxParamId 20: highest ${capped.maxParam(1)}`);
    // A count above a known size's lookahead does not extend it.
    const sized = tableDevice(layout);
    await liveWalkDetailed(sized, { ...base, blocks: [1], maxParamId: 1000, paramKnownSizeByBlock: { 1: 10 }, paramCountByBlock: { 1: 900 } });
    if (sized.maxParam(1) !== 9 + 32) fail(`count 900 over known size 10: highest ${sized.maxParam(1)} (want ${9 + 32})`);
    // Invalid entries are ignored as if absent: NaN, Infinity, fractions and negatives.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1]) {
      const dev = tableDevice({ 1: { real: 3 } });
      await liveWalkDetailed(dev, { ...base, blocks: [1], maxParamId: 50, paramCountByBlock: { 1: bad } });
      if (dev.maxParam(1) !== 2 + 32) fail(`count ${String(bad)} was trusted: highest ${dev.maxParam(1)} (want 34)`);
    }
  }
  console.log('  cache/gen3-walk-model: a count cannot widen maxParamId or a known size; NaN/Infinity/fractional/negative counts are ignored');

  // ---- Case 6: count 0 skips the block; a count keeps a freezing device out of reach --------
  {
    const zero = tableDevice({ 1: { real: 10 } });
    const rz = await liveWalkDetailed(zero, { ...base, blocks: [1], maxParamId: 100, paramCountByBlock: { 1: 0 } });
    if (zero.sent.length !== 0 || rz.records.length !== 0) fail(`count 0 must skip the block: ${zero.sent.length} queries, ${rz.records.length} records`);
    // A transport that freezes above id 20: a count of 6 never reaches it; without the count the
    // same device is queried past 20 and freezes.
    const safe = tableDevice({ 1: { real: 6 } }, FM3, 20);
    const rs = await liveWalkDetailed(safe, { ...base, blocks: [1], maxParamId: 1000, paramCountByBlock: { 1: 6 } });
    if (safe.frozen || safe.maxParam(1) !== 5 || rs.records.length !== 6) fail(`counted freeze: frozen=${safe.frozen}, highest ${safe.maxParam(1)}, ${rs.records.length} records`);
    const unsafe = tableDevice({ 1: { real: 6 } }, FM3, 20);
    let error = '';
    try {
      await liveWalkDetailed(unsafe, { ...base, blocks: [1], maxParamId: 1000 });
    } catch (e) {
      error = (e as Error).message;
    }
    if (!unsafe.frozen || unsafe.maxParam(1) <= 20 || !/stopped answering/.test(error)) fail(`negative control: frozen=${unsafe.frozen}, highest ${unsafe.maxParam(1)}, "${error}"`);
  }
  console.log('  cache/gen3-walk-model: count 0 sends no query; a count keeps a device that freezes above id 20 untouched (the same device freezes without it)');

  // ---- Case 7: the label gate is class {1,10,11,12} AND the label-table word ---------------
  {
    const BLOCK = 4;
    // 0: class 1, no label word, numeric enum signature -> old heuristic walks it.
    // 1: class 2 + label word, non-zero default -> class is excluded, not walked.
    // 2: class 10 + label word, non-zero default -> the device's signal walks it.
    // 3: class 1, non-zero default, NO label word -> not walked (float).
    // 4: class 10, no label word, numeric enum signature -> old heuristic walks it.
    const specs: Record<number, DefSpec> = {
      0: { id: 1000, tc: 0x11, min: 0, max: 3, scale: 0, def: 0, step: 0 },
      1: { id: 1001, tc: 0x21, min: 0, max: 3, scale: 1, def: 0, step: 0, labelTable: 0x1234, flags: 1 },
      2: { id: 1002, tc: 0xa1, min: 0, max: 3, scale: 2, def: 0, step: 0, labelTable: 0x5678, flags: 1 },
      3: { id: 1003, tc: 0x11, min: 0, max: 3, scale: 2, def: 0, step: 0 },
      4: { id: 1004, tc: 0xa1, min: 0, max: 3, scale: 0, def: 0, step: 0 },
    };
    const labels = ['A', 'B', 'C', 'D'];
    const dev = tableDevice({
      [BLOCK]: {
        real: 5,
        extra: (p) => specs[p],
        labels: (p) => ([0, 2, 4].includes(p) ? labels : undefined),
      },
    });
    const res = await liveWalkDetailed(dev, { ...base, blocks: [BLOCK], maxParamId: 10 });
    const wantQueries: Array<[number, number]> = [[0, 4], [1, 0], [2, 4], [3, 0], [4, 4]];
    for (const [p, n] of wantQueries) {
      if (dev.count(VIEW_ENUM_LABEL, BLOCK, p) !== n) fail(`param ${p}: ${dev.count(VIEW_ENUM_LABEL, BLOCK, p)} label queries, want ${n}`);
    }
    for (const [p, kind] of [[0, 'enum'], [1, 'float'], [2, 'enum'], [3, 'float'], [4, 'enum']] as const) {
      const rec = res.records.find((r) => r.section === BLOCK && r.id === p);
      if (rec?.kind !== kind) fail(`param ${p}: kind ${rec?.kind}, want ${kind}`);
    }
    if (GEN3_LABEL_TYPECODE_CLASSES.size !== 4 || [1, 10, 11, 12].some((c) => !GEN3_LABEL_TYPECODE_CLASSES.has(c)) || GEN3_LABEL_TYPECODE_CLASSES.has(2)) {
      fail('the label class set must be exactly {1,10,11,12}');
    }
    if (gen3TypecodeClass(0xa1) !== 10) fail('typecode class extraction changed');
  }
  console.log('  cache/gen3-walk-model: labels — class {1,10,11,12} + non-zero label word walks even with a non-zero default; class 2 and a missing label word stay float');

  // ---- Case 8: labels are positional by arrival order --------------------------------------
  {
    const BLOCK = 5;
    const dev = tableDevice({
      [BLOCK]: {
        real: 1,
        extra: (p) => (p === 0 ? { id: 7, tc: 0x11, min: 0, max: 3, scale: 0, def: 0, step: 0, labelTable: 9, flags: 1 } : undefined),
        labels: (p) => (p === 0 ? ['L0', 'L1', 'L2', 'L3'] : undefined),
      },
    });
    const res = await liveWalkDetailed(dev, { ...base, blocks: [BLOCK], maxParamId: 2 });
    const rec = res.records.find((r) => r.id === 0);
    if (!rec || rec.kind !== 'enum' || rec.values.join(',') !== 'L0,L1,L2,L3') fail(`label order: ${JSON.stringify(rec)}`);
    const subs = dev.sent.filter((q) => q.view === VIEW_ENUM_LABEL && q.param === 0).map((q) => q.sub);
    if (!sameList(subs, [0, 1, 2, 3])) fail(`label ordinals ${subs.join(',')} (want ascending 0..3, never reordered)`);
    // An enum whose min is non-zero is walked at min..max (the sub is the raw value).
    const shifted = tableDevice({
      [BLOCK]: {
        real: 1,
        extra: (p) => (p === 0 ? { id: 8, tc: 0x11, min: 10, max: 12, scale: 0, def: 0, step: 0, labelTable: 9, flags: 1 } : undefined),
        labels: (p) => (p === 0 ? ['ten', 'eleven', 'twelve'] : undefined),
      },
    });
    const rs = await liveWalkDetailed(shifted, { ...base, blocks: [BLOCK], maxParamId: 2 });
    const recs = rs.records.find((r) => r.id === 0);
    if (!recs || recs.kind !== 'enum' || recs.values.join(',') !== 'ten,eleven,twelve') fail(`shifted list: ${JSON.stringify(recs)}`);
    const shiftedSubs = shifted.sent.filter((q) => q.view === VIEW_ENUM_LABEL && q.param === 0).map((q) => q.sub);
    if (!sameList(shiftedSubs, [10, 11, 12])) fail(`shifted ordinals ${shiftedSubs.join(',')} (want 10..12)`);
  }
  console.log('  cache/gen3-walk-model: labels are requested in ascending raw-value order (0..3, and 10..12 for a shifted list) and kept in arrival order');

  // ---- Case 9: readBlockParamCounts feeds the walk -----------------------------------------
  {
    const dev = fake((q) => {
      if (q.view !== VIEW_DEFINITION) return emptyReply(FM3, q.view, q.param);
      if (q.param < 10) return reply(FM3, VIEW_DEFINITION, 1, q.param, 0, defBody(realFloat(500 + q.param)));
      return emptyReply(FM3, VIEW_DEFINITION, q.param);
    });
    const desc = fake((q) => {
      if (q.view !== 0x01) return null;
      if (q.block === 2) return reply(FM3, 0x01, q.block, 0, 0, descriptorBody(5, 56));
      if (q.block === 3) return reply(FM3, 0x01, q.block, 0, 0, descriptorBody(7, 80));
      return null;
    });
    const counts = await readBlockParamCounts(desc, FM3, [2, 3, 4], { retries: 0, sleep: noSleep });
    if (counts.counts[2] !== 5 || counts.counts[3] !== 7 || counts.counts[4] !== undefined) fail(`counts ${JSON.stringify(counts.counts)}`);
    if (counts.lostReplies !== 1 || counts.queries !== 3) fail(`descriptor stats ${JSON.stringify(counts)}`);
    const walked = await liveWalkDetailed(dev, { ...base, blocks: [2, 3], maxParamId: 12, paramCountByBlock: counts.counts });
    if (dev.maxParam(2) !== 4 || dev.maxParam(3) !== 6) fail(`counted walk: highest ${dev.maxParam(2)} / ${dev.maxParam(3)} (want 4 / 6)`);
    if (paramsOf(walked.records, 2).length !== 5 || paramsOf(walked.records, 3).length !== 7) fail('counted walk lost records');
    // A descriptor that echoes ANOTHER block is a straggler: it must not tighten the wrong block.
    const mismatch = fake((q) => (q.view === 0x01 ? reply(FM3, 0x01, q.block + 1, 0, 0, descriptorBody(4, 56)) : null));
    const mm = await readBlockParamCounts(mismatch, FM3, [6], { retries: 0, sleep: noSleep });
    if (mm.counts[6] !== undefined || mm.malformedReplies !== 1) fail(`echo mismatch: ${JSON.stringify(mm)}`);
  }
  console.log('  cache/gen3-walk-model: readBlockParamCounts reads both descriptor forms, ignores a descriptor echoing another block, and its map drives the walk to 0..count-1');

  // ---- Case 10: preset-name replies --------------------------------------------------------
  {
    // The captured reply: a 32-byte name buffer whose leading string is "<EMPTY>", followed by
    // stale buffer content ("Performance Mode") after the NUL.
    const raw = new Uint8Array(32);
    const text = '<EMPTY>\0Performance Mode\0\0\0';
    for (let i = 0; i < text.length; i++) raw[i] = text.charCodeAt(i) & 0x7f;
    const decoded = decodePresetNameReply(reply(FM3, 0x4b, 0, 0, 0x17f, raw));
    if (!decoded || decoded.name !== '<EMPTY>') fail(`captured preset name decoded ${JSON.stringify(decoded)}`);
    // Trailing spaces before the NUL are part of the name (the cache copies them verbatim).
    const padded = new Uint8Array(32);
    const paddedText = '59 Bassguy   \0';
    for (let i = 0; i < paddedText.length; i++) padded[i] = paddedText.charCodeAt(i);
    const pd = decodePresetNameReply(reply(FM3, 0x4b, 0, 0, 0x17f, padded));
    if (!pd || pd.name !== '59 Bassguy   ') fail(`padded preset name decoded ${JSON.stringify(pd)}`);
    // A control byte inside the name is not a name.
    const bad = new Uint8Array(32);
    bad[0] = 0x41;
    bad[1] = 0x01;
    if (decodePresetNameReply(reply(FM3, 0x4b, 0, 0, 0x17f, bad)) !== null) fail('a control byte must reject the name');
    // The reader pairs names by request order.
    const dev = fake((q) => (q.view === 0x4b ? reply(FM3, 0x4b, 0, 0, 0x17f, q.sub === 0x1000 ? padded : raw) : null));
    const read = await readPresetNames(dev, FM3, [0x1000, 0x1001], { retries: 0, sleep: noSleep });
    if (read.names.length !== 2 || read.names[0]!.slotWord !== 0x1000 || read.names[0]!.name !== '59 Bassguy   ' || read.names[1]!.name !== '<EMPTY>') {
      fail(`preset read ${JSON.stringify(read.names)}`);
    }
  }
  console.log('  cache/gen3-walk-model: preset names — the leading NUL-terminated run is the name (captured "<EMPTY>" reply), padding kept, replies paired by request order');

  // ---- Case 11: cab/IR bank records stay raw ----------------------------------------------
  {
    const raw = new Uint8Array(0x220);
    raw[0] = 0x41;
    raw[0x21f] = 0x5a;
    const fm3 = decodeCabBankRecordReply(reply(FM3, 0x9f, 0, 0, 17, raw), FM3);
    if (!fm3 || fm3.bytes.length !== 0x220 || fm3.expectedRecordSize !== 0x220 || fm3.echoIndex !== 17) fail(`FM3 cab record ${JSON.stringify({ ...fm3, bytes: fm3?.bytes.length })}`);
    const iii = decodeCabBankRecordReply(reply(III, 0x68, 0, 0, 3, raw), III);
    if (!iii || iii.expectedRecordSize !== 0x2b0) fail(`III cab record ${JSON.stringify(iii && { ...iii, bytes: iii.bytes.length })}`);
    if (decodeCabBankRecordReply(reply(FM9, 0xa4, 0, 0, 0, raw), FM3) !== null) fail('a foreign cab sub must not decode');
    const dev = fake((q) => (q.view === (0x9f & 0x7f) ? reply(FM3, 0x9f, 0, 0, q.sub, raw) : emptyReply(FM3, q.view, q.param)));
    const read = await readCabBankRecords(dev, FM3, [0, 1], { retries: 0, sleep: noSleep });
    if (read.records.length !== 2 || read.records[1]!.index !== 1 || read.expectedRecordSize !== 0x220) fail(`cab read ${JSON.stringify({ ...read, records: read.records.length })}`);
    let threw = false;
    try {
      await readCabBankRecords(dev, 0x14, [0]);
    } catch {
      threw = true;
    }
    if (!threw) fail('an unknown model must reject the cab read');
  }
  console.log('  cache/gen3-walk-model: cab/IR reads return the raw payload and the model stride (0x220 FM3 / 0x2b0 III); nothing is interpreted');

  // ---- Case 12: the editor block-type ordinal bound ---------------------------------------
  {
    if (gen3BlockSweepOrdinals(III).length !== 60 || gen3BlockSweepOrdinals(III)[0] !== 1 || gen3BlockSweepOrdinals(III)[59] !== 60) fail('III sweep ordinals');
    if (gen3BlockSweepOrdinals(FM3).length !== 58 || gen3BlockSweepOrdinals(FM9).length !== 58) fail('FM3/FM9 sweep ordinals');
    if (gen3BlockSweepOrdinals(FM3)[57] !== 58) fail('FM3/FM9 sweep ends at ordinal 58');
    if (gen3BlockSweepOrdinals(0x14).length !== 0) fail('the VP4 has no gen-3 sweep bound');
  }
  console.log('  cache/gen3-walk-model: block sweep bound — ordinals 1..60 on the III, 1..58 on FM3/FM9, none for any other model');

  // ---- Case 13: payload counts above 127 are two septets, not a raw u16 --------------------
  {
    const ascii = (s: string): Uint8Array => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0x7f));
    // Hardware-sized cab records: 0x220 (FM3) and 0x2B0 (III/FM9). The count `20 04` is 544 and
    // `50 05` is 688; a raw-u16 read would see 1056 / 1360 and reject the frame.
    const fm3 = new Uint8Array(0x220);
    fm3[0] = 0x41;
    fm3[0x21f] = 0x5a;
    const fm3Read = decodeCabBankRecordReply(reply(FM3, 0x9f, 0, 0, 0, fm3), FM3);
    if (!fm3Read || fm3Read.bytes.length !== 0x220 || fm3Read.bytes[0] !== 0x41 || fm3Read.bytes[0x21f] !== 0x5a) {
      fail(`FM3 544-byte record decoded ${fm3Read?.bytes.length} bytes`);
    }
    for (const [model, sub] of [[III, 0x68], [FM9, 0xa4]] as const) {
      const big = new Uint8Array(0x2b0);
      big[0] = 0x42;
      big[0x2af] = 0x5b;
      const read = decodeCabBankRecordReply(reply(model, sub, 0, 0, 0, big), model);
      if (!read || read.bytes.length !== 0x2b0 || read.bytes[0] !== 0x42 || read.bytes[0x2af] !== 0x5b) {
        fail(`0x${model.toString(16)} 688-byte record decoded ${read?.bytes.length} bytes`);
      }
    }
    // The old raw-u16 shape must not silently pass: its implied septet count is 288, so the frame
    // length no longer matches and the decoder rejects it.
    if (decodeCabBankRecordReply(replyRawCount(FM3, 0x9f, 0, 0, 0, fm3), FM3) !== null) fail('a raw-u16 payload count must be rejected');
    // A label reply whose c low septet is 1/3 carries a real label (inner[6] is not a tag).
    for (const [c, text] of [[1, 'NO'], [3, 'YES']] as const) {
      const label = decodeReply(reply(FM3, VIEW_ENUM_LABEL, 1, 0, c, ascii(text)));
      if (!label || label.view !== 'enum_label' || label.label !== text) fail(`label reply with c=${c} decoded ${JSON.stringify(label)}`);
    }
    // And a definition reply with c=3 is still a definition.
    const def = decodeReply(reply(FM3, VIEW_DEFINITION, 1, 0, 3, defBody(realFloat(9))));
    if (!def || def.view !== 'definition' || def.id !== 9) fail(`definition reply with c=3 decoded ${JSON.stringify(def)}`);
    // A genuinely empty reply (cnt = 0) is still no payload.
    if (decodeReply(emptyReply(FM3, VIEW_ENUM_LABEL, 0)) !== null) fail('a cnt=0 reply must stay no-payload');
  }
  console.log('  cache/gen3-walk-model: counts 544/688 decode from their septet pair (the raw-u16 frame is rejected); a label reply with c=1/3 stays a real label');
}
