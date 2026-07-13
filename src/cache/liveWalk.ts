/**
 * LIVE self-describe walk for gen-3 Fractal devices (FM3/FM9/Axe-Fx III).
 *
 * A device can be asked to describe its own parameters over SysEx function
 * 0x01. Sweeping that self-describe map yields the SAME `CacheRecord[]` the
 * `.cache` byte-walker (`records.ts`) produces, so either source feeds
 * `buildCache` and the derived device tables are identical (aside from the five
 * special table records — see "Coverage" below).
 *
 * This module has two layers:
 *   1. a PURE codec — `buildDefQuery` / `buildEnumQuery` / `decodeReply` /
 *      `decodeSeptetStream` — fully unit-testable with no transport; and
 *   2. a WALK DRIVER — `liveWalk(transport, opts)` — that sweeps blocks/params
 *      over an injected transport, walks enum label lists, paces, supports an
 *      `AbortSignal`, and reports progress.
 *
 * Pure and browser-safe: no `node:*`, no `Buffer`; wire bytes go through a
 * little-endian `DataView`, and pacing uses the ambient `setTimeout` (or an
 * injected scheduler). The transport is an injected interface, so this file
 * carries NO MIDI/serial dependency.
 *
 * ── Wire facts (hardware-validated, FM3 fw 12.0) ────────────────────────────
 * Frame: `F0 00 01 74 <model> 01 <body…> <cksum> F7`, cksum = XOR of every byte
 * from F0 through the last body byte, masked to 7 bits. Gen-3 model bytes:
 * FM3 0x11, FM9 0x12, Axe-Fx III 0x10.
 *
 * Query body (15 bytes) addresses view × block × param × sub:
 *     [VIEW, 0, BLOCK, 0, PARAM_LO, PARAM_HI, SUB, 0,0,0,0,0,0,0,0]
 *   body[0] VIEW  = 0x1c definition record, 0x1f enum label,
 *                   0x00 formatted value string, 0x2e large value dump
 *   body[2] BLOCK = parameter section address (swept 0..127)
 *   body[4] PARAM_LO = param & 0x7f      body[5] PARAM_HI = param >> 7
 *   body[6] SUB_LO   = sub & 0x7f        body[7] SUB_HIGH = sub >> 7
 * PARAM and SUB are thus 14-bit values, each split into a low/high 7-bit pair
 * (hardware-verified, including both high bytes non-zero in one query); the
 * 14-bit SUB range is what makes the 1024-label enum cap reachable.
 *
 * Reply: `inner = frame[6:-2]`.
 *   inner[0]     = view echo          inner[4] = param-low echo
 *   inner[6]     = TAG: 0x3a "changed since last read" / 0x00 "re-read" — BOTH
 *                  carry payload, so decode is TAG-INDEPENDENT (driven by the
 *                  length word). 0x03 / 0x01 = genuine no-payload sentinel;
 *                  an enum ordinal past the end of the value range (sub > max)
 *                  answers cnt = 0 under tag 0x40 — any cnt = 0 reply is
 *                  treated as no-payload regardless of tag.
 *   inner[13:15] = u16 LE `cnt` = raw payload byte count
 *   inner[15:…]  = a CONTINUOUS MSB-first septet stream (ceil(cnt*8/7) septets)
 *                  yielding exactly `cnt` raw bytes.
 *
 * Definition record (view 0x1c) = 36 raw bytes, little-endian:
 *     u32 id, u32 tc, f32 min, f32 max, f32 scale, f32 def, f32 step, u32 0, u32 0
 * The wire `id` is the device's internal symbol id — NOT the walk param; the
 * emitted record's `id` is the PARAM POSITION that was queried. The `scale`
 * slot is absent from the `.cache` grammar and is dropped here (cache/records.ts
 * has no scale field); the field VALUES min/max/def/step/tc match the cache
 * record byte-for-byte.
 *
 * Enum labels (view 0x1f): one septet-ASCII label per SUB ordinal. The SUB
 * ordinal is the parameter's RAW VALUE (min..max), NOT an index into the value
 * list: values[i] lives at sub = min + i (hardware-verified; the two coincide
 * only when min = 0). Raw values below min can still answer with a label, but
 * those are outside the value list and are not part of the walk. The label
 * range does NOT self-terminate cleanly — it spills into a shared label pool —
 * so the walk is bounded by the definition's value count (max−min+1),
 * hard-capped, and ends early on the first end-sentinel/empty reply. Past-end
 * ordinals (sub > max) answer with cnt = 0 under tag 0x40 — end-of-list
 * detection keys off cnt == 0, tag-independent.
 *
 * kind: the wire typecode is ambiguous (e.g. tc=16 is used by both enum and
 * float params), so kind is derived from the numeric record and, decisively,
 * from whether a 0x1f label list exists:
 *     enum : step==0 && scale==0 && integral bounds        (count = max−min+1)
 *     int  : step is an integer >= 1
 *     float: otherwise
 * A captured 0x1f label list always wins → enum (a genuine enum whose step is
 * non-zero is still an enum). The walk's 2-way output is {enum,float}: `int`
 * maps to `float` (the cache grammar has no integer kind).
 *
 * ── Coverage ────────────────────────────────────────────────────────────────
 * PARAM is 14-bit, so ids up to 16383 are reachable; the special table records
 * (id >= 0xff00: cab/IR bank tables, padded rosters) are NOT param-addressable
 * and are absent from a live walk by design. They affect only a section's
 * declared record count and the cab/IR banks; every other derived table is
 * reproduced exactly. A complete cache pairs the live walk with those few
 * byte-sourced table records.
 */
import { fractalChecksum } from '../shared/checksum.js';
import type { RecordSource } from './buildProfile.js';
import type { CacheRecord, EnumRecord, FloatRecord } from './types.js';

// ---------------------------------------------------------------------------
// Frame constants
// ---------------------------------------------------------------------------

/** Fractal manufacturer SysEx header. */
const MFR = [0xf0, 0x00, 0x01, 0x74] as const;
/** Self-describe function byte. */
const FN_SELFDESCRIBE = 0x01;

/** Query view bytes (body[0]). */
export const VIEW_DEFINITION = 0x1c;
export const VIEW_ENUM_LABEL = 0x1f;
export const VIEW_VALUE = 0x00;

/** Reply TAG bytes (inner[6]) that carry NO payload (sentinels). */
const TAG_SENTINELS = new Set([0x01, 0x03]);

// ---------------------------------------------------------------------------
// Pure codec — query builders
// ---------------------------------------------------------------------------

function buildQuery(model: number, view: number, block: number, param: number, sub: number): Uint8Array {
  const body = new Array<number>(15).fill(0);
  body[0] = view & 0x7f;
  body[2] = block & 0x7f;
  body[4] = param & 0x7f; // PARAM_LO
  body[5] = (param >> 7) & 0x7f; // PARAM_HI
  body[6] = sub & 0x7f; // SUB_LO
  body[7] = (sub >> 7) & 0x7f; // SUB_HIGH
  const core = [...MFR, model & 0x7f, FN_SELFDESCRIBE, ...body];
  return Uint8Array.from([...core, fractalChecksum(core), 0xf7]);
}

/** Build a DEFINITION query (view 0x1c) for (model, block, param). */
export function buildDefQuery(model: number, block: number, param: number): Uint8Array {
  return buildQuery(model, VIEW_DEFINITION, block, param, 0);
}

/** Build an ENUM-LABEL query (view 0x1f) for (model, block, param, sub). */
export function buildEnumQuery(model: number, block: number, param: number, sub: number): Uint8Array {
  return buildQuery(model, VIEW_ENUM_LABEL, block, param, sub);
}

// ---------------------------------------------------------------------------
// Pure codec — septet stream
// ---------------------------------------------------------------------------

/**
 * Decode a CONTINUOUS MSB-first septet stream into exactly `nbytes` raw bytes.
 *
 * The wire is a bit stream: each 7-bit septet contributes its 7 low bits (MSB
 * first) to an accumulator from which 8-bit bytes are pulled off the top. `n`
 * raw bytes occupy ceil(8n/7) septets; the final septet's low padding bits are
 * discarded once `nbytes` bytes have been emitted. Returns fewer than `nbytes`
 * bytes only when the wire is too short (caller must check `.length`).
 */
export function decodeSeptetStream(wire: Uint8Array, nbytes: number, start = 0): Uint8Array {
  const out = new Uint8Array(nbytes);
  let acc = 0;
  let nbits = 0;
  let o = 0;
  for (let i = start; i < wire.length && o < nbytes; i++) {
    acc = (acc << 7) | (wire[i]! & 0x7f);
    nbits += 7;
    while (nbits >= 8 && o < nbytes) {
      nbits -= 8;
      out[o++] = (acc >>> nbits) & 0xff;
    }
  }
  return o < nbytes ? out.subarray(0, o) : out;
}

/** Wire septet count for `nbytes` raw payload bytes. */
function septetLen(nbytes: number): number {
  return Math.ceil((nbytes * 8) / 7);
}

// ---------------------------------------------------------------------------
// Pure codec — reply decode
// ---------------------------------------------------------------------------

/** A decoded self-describe DEFINITION record (view 0x1c). */
export interface LiveDefinition {
  view: 'definition';
  selector: number;
  param: number;
  /** Device-internal symbol id (NOT the walk param). */
  id: number;
  tc: number;
  /** Heuristic 3-way kind before the label-list confirmation. */
  kind: 'enum' | 'int' | 'float';
  min: number;
  max: number;
  scale: number;
  def: number;
  step: number;
}

/** Any decoded self-describe reply, or `null` for a sentinel / no payload. */
export type LiveReply =
  | LiveDefinition
  | { view: 'enum_label'; selector: number; param: number; label: string }
  | { view: 'value'; selector: number; param: number; value: string }
  | { view: 'string'; selector: number; param: number; text: string }
  | null;

function integral(x: number): boolean {
  return Math.abs(x - Math.round(x)) < 1e-6;
}

/** Numeric kind heuristic (3-way), mirroring the wire decode. */
function classifyKind(mn: number, mx: number, scale: number, st: number): 'enum' | 'int' | 'float' {
  if (st === 0 && scale === 0 && integral(mn) && integral(mx)) return 'enum';
  if (st !== 0 && integral(st) && st >= 1) return 'int';
  return 'float';
}

/**
 * Decode ONE self-describe reply frame. Returns a typed result, or `null` when
 * the frame is not a func-0x01 reply, is a sentinel (tag 0x03/0x01), or carries
 * no payload. Decode is TAG-INDEPENDENT: a 0x3a "fresh" and a 0x00 "re-read"
 * reply with the same payload decode identically.
 */
export function decodeReply(frame: Uint8Array): LiveReply {
  const n = frame.length;
  if (
    n < 10 ||
    frame[0] !== 0xf0 ||
    frame[1] !== 0x00 ||
    frame[2] !== 0x01 ||
    frame[3] !== 0x74 ||
    frame[5] !== FN_SELFDESCRIBE ||
    frame[n - 1] !== 0xf7
  ) {
    return null;
  }
  const inner = frame.subarray(6, n - 2);
  if (inner.length < 7) return null;
  const selector = inner[0]!;
  const param = inner[4]!;
  const tag = inner[6]!;
  if (TAG_SENTINELS.has(tag)) return null;
  if (inner.length < 15) return null;
  const cnt = inner[13]! | (inner[14]! << 8);
  if (cnt < 1) return null;
  if (inner.length < 15 + septetLen(cnt)) return null;
  const raw = decodeSeptetStream(inner, cnt, 15);
  if (raw.length < cnt) return null;

  // DEFINITION record: exactly 36 raw bytes with finite numeric fields.
  if (cnt === 36 && raw.length === 36) {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const id = dv.getUint32(0, true);
    const tc = dv.getUint32(4, true);
    const min = dv.getFloat32(8, true);
    const max = dv.getFloat32(12, true);
    const scale = dv.getFloat32(16, true);
    const def = dv.getFloat32(20, true);
    const step = dv.getFloat32(24, true);
    if ([min, max, scale, def, step].every((x) => Number.isFinite(x))) {
      return {
        view: 'definition',
        selector,
        param,
        id,
        tc,
        kind: classifyKind(min, max, scale, step),
        min,
        max,
        scale,
        def,
        step,
      };
    }
  }

  // STRING payload: enum label (0x1f) or formatted value (0x00).
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0x00) end -= 1;
  if (end > 0) {
    let printable = true;
    for (let i = 0; i < end; i++) {
      const c = raw[i]!;
      if (c < 0x20 || c >= 0x7f) {
        printable = false;
        break;
      }
    }
    if (printable) {
      let s = '';
      for (let i = 0; i < end; i++) s += String.fromCharCode(raw[i]!);
      if (selector === VIEW_ENUM_LABEL) return { view: 'enum_label', selector, param, label: s };
      if (selector === VIEW_VALUE) return { view: 'value', selector, param, value: s };
      return { view: 'string', selector, param, text: s };
    }
  }

  // tag carries payload but it is neither a clean record nor a printable string
  // (e.g. the 0x2e large value dump). Not a parameter definition.
  return null;
}

// ---------------------------------------------------------------------------
// Record synthesis
// ---------------------------------------------------------------------------

/** The all-zero definition body a device returns for an empty/absent slot. */
function isFillerDefinition(d: LiveDefinition): boolean {
  return d.id === 0 && d.tc === 0 && d.min === 0 && d.max === 0 && d.def === 0 && d.step === 0;
}

/**
 * A definition COULD be an enum worth a 0x1f label walk when its bounds are
 * integral and the value count is within the cap — regardless of `step` (an
 * enum with a non-zero step is still an enum, decided by whether labels exist).
 * Scaled controls (`scale != 0`) are NEVER label-walked: they are continuous by
 * contract, and a 0x1f label query against a param with no label list is
 * out-of-contract for the device — the FM3 hard-freezes on it (power-cycle
 * recovery). Genuine step!=0 enums all report scale == 0.
 */
function couldBeEnum(d: LiveDefinition, cap: number): boolean {
  if (d.kind === 'enum') return true;
  if (d.scale !== 0) return false;
  if (!integral(d.min) || !integral(d.max)) return false;
  const span = Math.round(d.max - d.min + 1);
  return span >= 1 && span <= cap;
}

/** Build one `CacheRecord` from a decoded definition (+ any 0x1f labels). */
function buildRecord(block: number, param: number, d: LiveDefinition, labels: readonly string[]): CacheRecord {
  const enumKind = labels.length > 0 || d.kind === 'enum';
  if (enumKind) {
    let count = Math.round(d.max - d.min + 1);
    if (count < 1) count = labels.length;
    const rec: EnumRecord = {
      kind: 'enum',
      section: block,
      offset: 0,
      id: param,
      tc: d.tc,
      min: d.min,
      max: d.max,
      def: d.def,
      step: d.step,
      count,
      values: [...labels],
      x: 0,
    };
    return rec;
  }
  const rec: FloatRecord = {
    kind: 'float',
    section: block,
    offset: 0,
    id: param,
    tc: d.tc,
    min: d.min,
    max: d.max,
    def: d.def,
    step: d.step,
    t1: 0,
    t2: 0,
  };
  return rec;
}

// ---------------------------------------------------------------------------
// Walk driver
// ---------------------------------------------------------------------------

/**
 * Minimal transport the walk drives: send a query frame, resolve with the reply
 * frame (or `null` on timeout/no reply). Deliberately transport-agnostic — a
 * ForgeFX MIDI port, a browser Web-MIDI adapter, or a test fake all satisfy it.
 */
export interface LiveTransport {
  request(query: Uint8Array): Promise<Uint8Array | null>;
}

/** Progress event, shaped for a future SSE surface. */
export interface LiveWalkProgress {
  phase: 'block-start' | 'block-done' | 'done';
  /** Current block address (undefined on `done`). */
  block?: number;
  blockIndex: number;
  blockCount: number;
  records: number;
  enumLabels: number;
  queries: number;
}

export interface LiveWalkOptions {
  /** Device model byte (FM3 0x11, FM9 0x12, Axe-Fx III 0x10). */
  model: number;
  /** Explicit block addresses to sweep; defaults to `0..maxBlock`. */
  blocks?: number[];
  /** Highest block address swept when `blocks` is omitted (default 127). */
  maxBlock?: number;
  /**
   * Highest PARAM id swept per block (default 16383 = the full 14-bit range).
   * The reachable id range can be capped here.
   */
  maxParamId?: number;
  /**
   * Consecutive absent params that end a block's sweep (default 256). Must
   * exceed a section's largest internal id gap to reach every record; raise it
   * to reach sparse high-id (param>127) records.
   */
  paramAbsentRunLimit?: number;
  /**
   * Absent params from the start of a block before the block is skipped as
   * empty (default 4).
   */
  blockProbeDepth?: number;
  /** Hard cap on labels collected per enum param (default 1024). */
  enumCountCap?: number;
  /** Pause between queries, ms (default 0 = none). */
  interQueryMs?: number;
  /** Pause between blocks, ms (default 0 = none). */
  blockPauseMs?: number;
  /** Abort the walk; a partial result is discarded (the walk rejects). */
  signal?: AbortSignal;
  /** Progress callback (block boundaries + `done`). */
  onProgress?: (p: LiveWalkProgress) => void;
  /**
   * Scheduler seam for pacing (default the ambient `setTimeout`). Injected in
   * tests to make pacing deterministic without real timers.
   */
  sleep?: (ms: number) => Promise<void>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = (signal as { reason?: unknown }).reason;
    throw reason instanceof Error ? reason : new Error('live walk aborted');
  }
}

async function pace(ms: number, signal: AbortSignal | undefined, sleep?: (ms: number) => Promise<void>): Promise<void> {
  if (!ms || ms <= 0) return;
  throwIfAborted(signal);
  if (sleep) {
    await sleep(ms);
  } else {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Sweep a device's self-describe map into `CacheRecord[]` deep-equivalent to the
 * `.cache` byte-walker's output (minus the unreachable special table records).
 *
 * Feed the result straight to `buildCache({ kind: 'live', walk })` — or use
 * `liveSource(transport, opts)` to build that source in one call.
 */
export async function liveWalk(transport: LiveTransport, opts: LiveWalkOptions): Promise<CacheRecord[]> {
  const model = opts.model;
  const maxBlock = opts.maxBlock ?? 127;
  const blocks = opts.blocks ?? Array.from({ length: maxBlock + 1 }, (_, i) => i);
  const maxParamId = opts.maxParamId ?? 16383;
  const absentRunLimit = opts.paramAbsentRunLimit ?? 256;
  const probeDepth = opts.blockProbeDepth ?? 4;
  const enumCap = opts.enumCountCap ?? 1024;
  const { signal, sleep, onProgress } = opts;

  const records: CacheRecord[] = [];
  let queries = 0;
  let enumLabels = 0;

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi]!;
    throwIfAborted(signal);
    onProgress?.({ phase: 'block-start', block, blockIndex: bi, blockCount: blocks.length, records: records.length, enumLabels, queries });

    let absentRun = 0;
    let found = 0;
    for (let param = 0; param <= maxParamId; param++) {
      throwIfAborted(signal);
      await pace(opts.interQueryMs ?? 0, signal, sleep);
      const reply = await transport.request(buildDefQuery(model, block, param));
      queries += 1;
      const dec = reply ? decodeReply(reply) : null;
      const def = dec && dec.view === 'definition' ? dec : null;

      if (!def || isFillerDefinition(def)) {
        absentRun += 1;
        // Skip an empty block once its opening params are all absent.
        if (found === 0 && param + 1 >= probeDepth) break;
        if (absentRun >= absentRunLimit) break;
        continue;
      }
      absentRun = 0;
      found += 1;

      let labels: string[] = [];
      const lo = Math.round(def.min);
      // SPECULATIVE probes (def not positively enum-kind) never open a list at a
      // high absolute sub: every hardware-verified enum starts at a small ordinal,
      // and an out-of-contract high-sub 0x1f (e.g. a 430..450 pitch range) is the
      // FORGEFX-32 freeze trigger. Positively-classified enums keep the full range.
      const speculative = def.kind !== 'enum';
      if (lo >= 0 && (!speculative || lo <= 127) && couldBeEnum(def, enumCap)) {
        // The SUB ordinal is the parameter's RAW VALUE, not a list index:
        // values[i] lives at sub = min + i, so the walk covers exactly
        // min..max. Raw values below min can answer with a label, but they are
        // outside the value list and are never queried. Bounded by the
        // declared count (max−min+1), hard-capped at `enumCountCap`.
        const span = Math.round(def.max - def.min + 1);
        const bound = Math.max(1, Math.min(span >= 1 ? span : enumCap, enumCap));
        for (let i = 0; i < bound; i++) {
          throwIfAborted(signal);
          await pace(opts.interQueryMs ?? 0, signal, sleep);
          const er = await transport.request(buildEnumQuery(model, block, param, lo + i));
          queries += 1;
          const ed = er ? decodeReply(er) : null;
          if (!ed || ed.view !== 'enum_label') break; // end sentinel / empty reply ends the list
          labels.push(ed.label);
        }
        enumLabels += labels.length;
      }
      records.push(buildRecord(block, param, def, labels));
    }

    onProgress?.({ phase: 'block-done', block, blockIndex: bi, blockCount: blocks.length, records: records.length, enumLabels, queries });
    await pace(opts.blockPauseMs ?? 0, signal, sleep);
  }

  onProgress?.({ phase: 'done', blockIndex: blocks.length, blockCount: blocks.length, records: records.length, enumLabels, queries });
  return records;
}

/**
 * Convenience: a `RecordSource` that walks a live device, ready for
 * `buildCache(liveSource(transport, opts), params, seeds, …)`.
 */
export function liveSource(transport: LiveTransport, opts: LiveWalkOptions): RecordSource {
  return { kind: 'live', walk: () => liveWalk(transport, opts) };
}
