/**
 * FULL-mode live-walk taper sweep (FORGEFXMID-52 / META-27 Delta C, codec side).
 *
 * A fake `LiveTransport` + write hooks stands in for a gen-3 device: definition
 * queries (view 0x1c) describe synthetic float params, and formatted-value reads
 * (view 0x00) respond to the CONTINUOUS-SET frames the walk sends — LINEARLY,
 * LOGARITHMICALLY, on a CUSTOM (quadratic) curve, or NOT AT ALL (flat/inert).
 * The real `liveWalk` driver, in `mode: 'full'`, sweeps each, classifies the
 * taper, restores the original value, and reloads the preset per swept block.
 *
 * Cases pin: per-shape classification; the restore SET carries the analytic
 * inverse of the original display; `reloadPreset` fires once per swept block
 * (never for a block with nothing to sweep); enums/ints/inert params are NOT
 * swept; unreliable sweeps thread NO `RangeDef.taper` while reliable ones do
 * (custom keeps `taperPoints`); the built cache round-trips those fields through
 * JSON; full mode without hooks throws at walk start; and read-only mode ignores
 * write hooks entirely (no writes, no taper, byte-identical to a no-hooks walk).
 *
 * `src/cache/*` stays browser-safe; this TEST needs no `node:*`.
 */
import { buildDeviceCache, liveWalk } from '../../src/cache/index.js';
import type { LiveTransport, LiveWalkProgress, LiveWalkWriteHooks } from '../../src/cache/index.js';
import type { CacheRecord, DeviceParam, FloatRecord } from '../../src/cache/types.js';
import { VIEW_DEFINITION, VIEW_ENUM_LABEL, VIEW_VALUE } from '../../src/cache/index.js';

export const FULLWALK_CASE_COUNT = 9;

const MFR = [0xf0, 0x00, 0x01, 0x74] as const;
const MODEL = 0x12; // FM9
const BLOCK = 20;

// ===========================================================================
// Wire encoders (test-only; inverse of the liveWalk codec)
// ===========================================================================

function xor7(bytes: readonly number[]): number {
  let acc = 0;
  for (const b of bytes) acc ^= b;
  return acc & 0x7f;
}

/** Continuous MSB-first septet packer — inverse of `decodeSeptetStream`. */
function encodeSeptetStream(raw: Uint8Array): number[] {
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

function ascii(s: string): Uint8Array {
  return Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0x7f));
}

/** A 36-byte definition block (view 0x1c payload). */
function defBlock(id: number, tc: number, min: number, max: number, scale: number, def: number, step: number): Uint8Array {
  const buf = new Uint8Array(36);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, id, true);
  dv.setUint32(4, tc, true);
  dv.setFloat32(8, min, true);
  dv.setFloat32(12, max, true);
  dv.setFloat32(16, scale, true); // offset 16 = wire scale (0 => enum-kind, !=0 => float)
  dv.setFloat32(20, def, true);
  dv.setFloat32(24, step, true);
  return buf;
}

/** Frame a func-0x01 reply carrying `raw` payload bytes (tag 0x3a = "fresh"). */
function replyFrame(selector: number, param: number, raw: Uint8Array): Uint8Array {
  const inner = new Array<number>(15).fill(0);
  inner[0] = selector;
  inner[2] = 0x01;
  inner[4] = param & 0x7f;
  inner[5] = (param >> 7) & 0x7f;
  inner[6] = 0x3a;
  inner[13] = raw.length & 0xff;
  inner[14] = (raw.length >> 8) & 0xff;
  const core = [...MFR, MODEL, 0x01, ...inner, ...encodeSeptetStream(raw)];
  return Uint8Array.from([...core, xor7(core), 0xf7]);
}

/** Sentinel reply (tag 0x03, no payload) for absent slots. */
function sentinelFrame(selector: number, param: number): Uint8Array {
  const inner = new Array<number>(15).fill(0);
  inner[0] = selector;
  inner[4] = param & 0x7f;
  inner[5] = (param >> 7) & 0x7f;
  inner[6] = 0x03;
  const core = [...MFR, MODEL, 0x01, ...inner];
  return Uint8Array.from([...core, xor7(core), 0xf7]);
}

/** Past-end enum reply: cnt == 0 under tag 0x40 (decodes to null → list ends). */
function endOfRangeFrame(selector: number, param: number): Uint8Array {
  const inner = new Array<number>(15).fill(0);
  inner[0] = selector;
  inner[4] = param & 0x7f;
  inner[5] = (param >> 7) & 0x7f;
  inner[6] = 0x40;
  const core = [...MFR, MODEL, 0x01, ...inner];
  return Uint8Array.from([...core, xor7(core), 0xf7]);
}

/** Decode a continuous-SET frame (sub 52 00) back to (eid, pid, normalized). */
function decodeContinuousSet(frame: Uint8Array): { eid: number; pid: number; norm: number } | null {
  if (frame.length !== 23 || frame[5] !== 0x01 || frame[6] !== 0x52 || frame[7] !== 0x00) return null;
  const eid = (frame[8]! & 0x7f) | ((frame[9]! & 0x7f) << 7);
  const pid = (frame[10]! & 0x7f) | ((frame[11]! & 0x7f) << 7);
  const u =
    (((frame[12]! & 0x7f)) | ((frame[13]! & 0x7f) << 7) | ((frame[14]! & 0x7f) << 14) | ((frame[15]! & 0x7f) << 21) | ((frame[16]! & 0x7f) << 28)) >>> 0;
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = u;
  return { eid, pid, norm: new Float32Array(buf)[0]! };
}

// ===========================================================================
// Synthetic param specs + fake transport
// ===========================================================================

interface Spec {
  /** Effect/block id (defaults to BLOCK). */
  block?: number;
  param: number;
  kind: 'float' | 'enum';
  min: number;
  max: number;
  /** Float only: original normalized position (drives the restore target). */
  origNorm?: number;
  /** Float only: display value as a function of the current normalized value. */
  respond?: (n: number) => number;
  unit?: string;
  /** Enum only. */
  values?: string[];
}

class FullFakeTransport implements LiveTransport {
  readonly sends: Array<{ eid: number; pid: number; norm: number }> = [];
  reloads = 0;
  private readonly current = new Map<string, number>();
  private readonly byKey = new Map<string, Spec>();

  constructor(specs: Spec[]) {
    for (const s of specs) {
      const key = `${s.block ?? BLOCK}:${s.param}`;
      this.byKey.set(key, s);
      if (s.origNorm !== undefined) this.current.set(key, s.origNorm);
    }
  }

  request(query: Uint8Array): Promise<Uint8Array | null> {
    const view = query[6]!;
    const block = query[8]! | (query[9]! << 7);
    const param = query[10]! | (query[11]! << 7);
    const sub = query[12]! | (query[13]! << 7);
    const key = `${block}:${param}`;
    const s = this.byKey.get(key);
    if (!s) return Promise.resolve(sentinelFrame(view, param));

    if (view === VIEW_DEFINITION) {
      const wireScale = s.kind === 'enum' ? 0 : 1; // 0 => enum-kind, 1 => float-kind
      const tc = s.kind === 'enum' ? 16 : 2;
      return Promise.resolve(replyFrame(VIEW_DEFINITION, param, defBlock(param + 1, tc, s.min, s.max, wireScale, 0, 0)));
    }
    if (view === VIEW_ENUM_LABEL) {
      if (s.kind === 'enum' && s.values) {
        const idx = sub - Math.round(s.min);
        if (idx >= 0 && idx < s.values.length) return Promise.resolve(replyFrame(VIEW_ENUM_LABEL, param, ascii(s.values[idx]!)));
      }
      return Promise.resolve(endOfRangeFrame(VIEW_ENUM_LABEL, param));
    }
    if (view === VIEW_VALUE) {
      if (s.kind === 'float' && s.respond) {
        const n = this.current.get(key) ?? 0;
        const v = s.respond(n);
        return Promise.resolve(replyFrame(VIEW_VALUE, param, ascii(`${v}${s.unit ? ` ${s.unit}` : ''}`)));
      }
      return Promise.resolve(replyFrame(VIEW_VALUE, param, ascii('LABEL')));
    }
    return Promise.resolve(sentinelFrame(view, param));
  }

  hooks(): LiveWalkWriteHooks {
    return {
      send: (frame: Uint8Array): Promise<void> => {
        const d = decodeContinuousSet(frame);
        if (d) {
          this.sends.push(d);
          this.current.set(`${d.eid}:${d.pid}`, d.norm);
        }
        return Promise.resolve();
      },
      reloadPreset: (): Promise<void> => {
        this.reloads += 1;
        return Promise.resolve();
      },
    };
  }

  /** The last normalized value SET on (block, param) — the restore write. */
  lastNorm(param: number, block = BLOCK): number | undefined {
    for (let i = this.sends.length - 1; i >= 0; i--) {
      if (this.sends[i]!.eid === block && this.sends[i]!.pid === param) return this.sends[i]!.norm;
    }
    return undefined;
  }
}

// Param 0 = enum (never swept). 1 = linear, 2 = log, 3 = custom (quadratic),
// 4 = flat/inert. origNorm chosen so each restore inverse is a distinct value.
const SPECS: Spec[] = [
  { param: 0, kind: 'enum', min: 0, max: 2, values: ['A', 'B', 'C'] },
  { param: 1, kind: 'float', min: 0, max: 10, origNorm: 0.3, respond: (n) => 10 * n, unit: 'Hz' },
  { param: 2, kind: 'float', min: 0, max: 100, origNorm: 0.4, respond: (n) => 20 * Math.pow(100, n) },
  { param: 3, kind: 'float', min: 0, max: 10, origNorm: 0.5, respond: (n) => 1 + 9 * n * n },
  { param: 4, kind: 'float', min: 0, max: 10, origNorm: 0.6, respond: () => 5 },
];

const CATALOG: DeviceParam[] = [
  { family: 'AMP', paramId: 0, name: 'AMP_TYPE', unit: 'enum' },
  { family: 'AMP', paramId: 1, name: 'AMP_GAIN', displayMin: 0, displayMax: 10 },
  { family: 'AMP', paramId: 2, name: 'AMP_FREQ', displayMin: 0, displayMax: 100 },
  { family: 'AMP', paramId: 3, name: 'AMP_CUSTOM', displayMin: 0, displayMax: 10 },
  { family: 'AMP', paramId: 4, name: 'AMP_FLAT', displayMin: 0, displayMax: 10 },
];
const SEEDS = { AMP: BLOCK };

const noSleep = (): Promise<void> => Promise.resolve();

type WalkOpts = Parameters<typeof liveWalk>[1];

function fullWalkOpts(extra: Partial<WalkOpts> = {}): WalkOpts {
  return {
    model: MODEL,
    blocks: [BLOCK],
    maxParamId: 4,
    paramAbsentRunLimit: 8,
    blockProbeDepth: 8,
    sleep: noSleep,
    ...extra,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

export async function runFullWalk(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[cache/fullwalk] ${msg}`);
  };

  const t = new FullFakeTransport(SPECS);
  const progress: LiveWalkProgress[] = [];
  const records = await liveWalk(
    t,
    fullWalkOpts({ mode: 'full', write: t.hooks(), onProgress: (p: LiveWalkProgress) => progress.push(p) }),
  );

  const floatRec = (param: number): FloatRecord => {
    const r = records.find((x) => x.section === BLOCK && x.id === param);
    if (!r || r.kind !== 'float') fail(`param ${param} not a float record (got ${r?.kind})`);
    return r as FloatRecord;
  };

  // ---- Case 1: per-shape classification ------------------------------------
  const lin = floatRec(1).taper!;
  if (!lin || lin.shape !== 'linear' || !lin.reliable) fail(`linear param: shape=${lin?.shape} reliable=${lin?.reliable}`);
  const log = floatRec(2).taper!;
  if (!log || log.shape !== 'log' || !log.reliable) fail(`log param: shape=${log?.shape} reliable=${log?.reliable}`);
  const cus = floatRec(3).taper!;
  if (!cus || cus.shape !== 'custom' || !cus.reliable) fail(`custom param: shape=${cus?.shape} reliable=${cus?.reliable}`);
  if (cus.points.length !== 9) fail(`custom taper: ${cus.points.length} points (expected 9)`);
  const flat = floatRec(4).taper!;
  if (!flat || flat.shape !== 'flat' || flat.reliable) fail(`flat param: shape=${flat?.shape} reliable=${flat?.reliable}`);
  console.log('  cache/fullwalk: sweep classifies linear / log / custom (reliable) and flat (unreliable)');

  // ---- Case 2: enum is NOT swept -------------------------------------------
  const enumRec = records.find((x) => x.section === BLOCK && x.id === 0);
  if (!enumRec || enumRec.kind !== 'enum') fail(`param 0 not an enum record (got ${enumRec?.kind})`);
  if (t.sends.some((s) => s.pid === 0)) fail('enum param 0 received a SET (must not be swept)');
  console.log('  cache/fullwalk: enum/label params are never swept (no SET frames issued to them)');

  // ---- Case 3: restore SET carries the analytic inverse of the original ----
  const restoreCheck = (param: number, expected: number): void => {
    const back = t.lastNorm(param);
    if (back === undefined || Math.abs(back - expected) > 1e-4) {
      fail(`param ${param} restore SET norm ${back} != expected inverse ${expected}`);
    }
  };
  restoreCheck(1, 0.3); // linear: (target-lo)/(hi-lo)
  restoreCheck(2, 0.4); // log:    ln(target/lo)/ln(hi/lo)
  restoreCheck(3, 0.5); // custom: piecewise-linear interpolation over the samples
  console.log('  cache/fullwalk: restore SET issued with the classified-curve analytic inverse');

  // ---- Case 4: reloadPreset fires once per swept block ---------------------
  if (t.reloads !== 1) fail(`reloadPreset called ${t.reloads}x (expected 1 for one swept block)`);
  {
    // Blocks 30 & 32 each carry a swept float; block 31 carries only an enum.
    // Exactly two reloads: the enum-only block sweeps nothing, so it triggers none.
    const multiSpecs: Spec[] = [
      { block: 30, param: 0, kind: 'float', min: 0, max: 10, origNorm: 0.2, respond: (n) => 10 * n },
      { block: 31, param: 0, kind: 'enum', min: 0, max: 1, values: ['x', 'y'] },
      { block: 32, param: 0, kind: 'float', min: 0, max: 10, origNorm: 0.7, respond: (n) => 10 * n },
    ];
    const multi = new FullFakeTransport(multiSpecs);
    await liveWalk(multi, {
      model: MODEL,
      blocks: [30, 31, 32],
      maxParamId: 0,
      paramAbsentRunLimit: 4,
      blockProbeDepth: 4,
      mode: 'full',
      write: multi.hooks(),
      sleep: noSleep,
    });
    if (multi.reloads !== 2) fail(`multi-block reload: ${multi.reloads} reloads (expected 2 — enum-only block 31 sweeps nothing)`);
  }
  console.log('  cache/fullwalk: reloadPreset fires once per swept block, never for a sweep-free block');

  // ---- Case 5: reliable tapers thread into RangeDef; unreliable do not ------
  const built = buildDeviceCache(records, CATALOG, SEEDS);
  const amp = built.ranges['AMP'];
  if (!amp) fail('AMP family not mapped by the voter');
  if (amp[1]!.taper !== 'linear') fail(`RangeDef[1].taper=${amp[1]!.taper} (expected linear)`);
  if (amp[2]!.taper !== 'log') fail(`RangeDef[2].taper=${amp[2]!.taper} (expected log)`);
  if (amp[3]!.taper !== 'custom') fail(`RangeDef[3].taper=${amp[3]!.taper} (expected custom)`);
  if (!amp[3]!.taperPoints || amp[3]!.taperPoints.length !== 9) fail(`RangeDef[3].taperPoints missing/short: ${JSON.stringify(amp[3]!.taperPoints)}`);
  if (amp[1]!.taperPoints !== undefined) fail('linear RangeDef must not carry taperPoints (custom-only)');
  if (amp[4]!.taper !== undefined) fail(`flat (unreliable) RangeDef[4].taper=${amp[4]!.taper} (must be absent)`);
  if (amp[0]!.taper !== undefined) fail('enum RangeDef[0] must not carry a taper');
  console.log('  cache/fullwalk: reliable tapers thread into RangeDef (custom keeps taperPoints); unreliable/enum omit it');

  // ---- Case 6: BuiltCache round-trips the new fields through JSON -----------
  const round = JSON.parse(JSON.stringify(built)) as typeof built;
  const rr = round.ranges['AMP']!;
  if (rr[2]!.taper !== 'log') fail(`round-trip lost RangeDef[2].taper (${rr[2]!.taper})`);
  if (JSON.stringify(rr[3]!.taperPoints) !== JSON.stringify(amp[3]!.taperPoints)) fail('round-trip altered custom taperPoints');
  if (rr[4]!.taper !== undefined) fail('round-trip resurrected an absent taper');
  console.log('  cache/fullwalk: BuiltCache round-trips taper / taperPoints through JSON serialization');

  // ---- Case 7: full mode without hooks throws at walk start -----------------
  {
    let msg = '';
    const bare = new FullFakeTransport(SPECS);
    try {
      await liveWalk(bare, fullWalkOpts({ mode: 'full' }));
    } catch (e) {
      msg = (e as Error).message;
    }
    if (!/requires write hooks/.test(msg)) fail(`full mode without hooks did not throw clearly (got: ${msg || 'no throw'})`);
    if (bare.sends.length !== 0) fail('full mode threw but still issued wire writes');
  }
  console.log('  cache/fullwalk: full mode without write hooks throws a clear error before any wire traffic');

  // ---- Case 8: read-only ignores hooks; byte-identical to a no-hooks walk ---
  {
    const withHooks = new FullFakeTransport(SPECS);
    const roRecords = await liveWalk(withHooks, fullWalkOpts({ mode: 'read-only', write: withHooks.hooks() }));
    if (withHooks.sends.length !== 0 || withHooks.reloads !== 0) {
      fail(`read-only used hooks: ${withHooks.sends.length} sends, ${withHooks.reloads} reloads`);
    }
    if (roRecords.some((r) => r.kind === 'float' && r.taper !== undefined)) fail('read-only walk produced a taper');

    const noHooks = new FullFakeTransport(SPECS);
    const roRecords2 = await liveWalk(noHooks, fullWalkOpts());
    if (JSON.stringify(roRecords) !== JSON.stringify(roRecords2)) fail('read-only-with-hooks records diverged from a no-hooks walk');

    // read-only never emits the additive 'param-sweep' phase.
    const roProgress: LiveWalkProgress[] = [];
    await liveWalk(withHooks, fullWalkOpts({ mode: 'read-only', onProgress: (p: LiveWalkProgress) => roProgress.push(p) }));
    if (roProgress.some((p) => p.phase === 'param-sweep')) fail('read-only emitted a param-sweep progress event');
  }
  console.log('  cache/fullwalk: read-only mode ignores write hooks entirely (no writes, no taper, byte-identical records)');

  // ---- Case 9: full-mode sweep progress reports through onProgress ----------
  {
    const sweepEvents = progress.filter((p) => p.phase === 'param-sweep');
    if (sweepEvents.length !== 4) fail(`expected 4 param-sweep events (one per swept float), got ${sweepEvents.length}`);
    if (sweepEvents.some((p) => p.param === 0)) fail('param-sweep fired for the enum param 0');
    const last = sweepEvents[sweepEvents.length - 1]!;
    if (last.tapers !== 4) fail(`final param-sweep tapers=${last.tapers} (expected 4 cumulative)`);
    const blockDone = progress.find((p) => p.phase === 'block-done');
    if (!blockDone || blockDone.tapers !== 4) fail(`block-done tapers=${blockDone?.tapers} (expected 4)`);
  }
  console.log('  cache/fullwalk: full-mode sweep progress reports through onProgress (param-sweep + cumulative tapers)');
}
