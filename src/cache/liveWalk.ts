/**
 * LIVE self-describe walk for gen-3 Fractal devices (FM3/FM9/Axe-Fx III).
 *
 * A device can be asked to describe its own parameters over SysEx function
 * 0x01. Sweeping that self-describe map yields the SAME `CacheRecord[]` the
 * `.cache` byte-walker (`records.ts`) produces, so either source feeds
 * `buildCache` and the derived device tables are identical (aside from the five
 * special table records — see "Coverage" below — and unused slots at the very
 * END of a table, which a walk cannot see; see "Empty slots").
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
 * non-zero is still an enum); a list the device answers as empty, or a continuous
 * unit in the formatted value, vetoes the numeric guess → float. The walk's 2-way
 * output is {enum,float}: `int` maps to `float` (the cache grammar has no integer
 * kind).
 *
 * Empty slots: the device answers an unused or absent slot with an empty-slot
 * definition (typecode 0, all-zero body). Inner empty slots become the all-zero
 * float placeholder rows the `.cache` carries; trailing ones are trimmed (see
 * `liveWalkDetailed`).
 *
 * ── Coverage ────────────────────────────────────────────────────────────────
 * PARAM is 14-bit, so ids up to 16383 are reachable; the special table records
 * (id >= 0xff00: cab/IR bank tables, padded rosters) are NOT param-addressable
 * and are absent from a live walk by design. They affect only a section's
 * declared record count and the cab/IR banks; every other derived table is
 * reproduced exactly. A complete cache pairs the live walk with those few
 * byte-sourced table records.
 *
 * ── Reply assumptions (open hardware questions) ─────────────────────────────
 * The reply handling below rests on assumptions not yet verified on hardware;
 * the walk is built to stay correct either way, but what it reports depends on
 * them:
 *   1. Does the device answer EVERY definition address — including blocks that
 *      do not exist, addresses past the end of a table and id gaps of sparse
 *      sections — with an empty-slot definition, or does it stay silent there?
 *      (Assumed: it answers. Silence is handled: re-read of a known definition,
 *      then counted as `silentAddresses`, not as loss.)
 *   2. Do unused slots INSIDE a table answer with the empty-slot definition
 *      (typecode 0, all-zero body)? The placeholder rows rest on this, and a
 *      trailing unused slot is indistinguishable from the table end.
 *   3. Does the end of a label list always answer with a no-payload reply?
 *   4. Can a reply arrive later than `lostReplyDrainMs` (500 ms), and does the
 *      host buffer frames between requests (then it must implement `drain`)?
 *   5. Does the formatted-value view (0x00) answer for every found param?
 * The shared test device (`test/cache/cacheDevice.ts`) models "answers
 * everything"; the suites also replay the opposite (silent addresses).
 */
import { fractalChecksum } from '../shared/checksum.js';
import { buildSetParameterContinuous } from '../gen3/axe-fx-iii/setParam.js';
import type { RecordSource } from './buildProfile.js';
import type { CacheRecord, EnumRecord, FloatRecord, FloatTaper } from './types.js';

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
  body[2] = block & 0x7f; // BLOCK_LO
  body[3] = (block >> 7) & 0x7f; // BLOCK_HI — reaches effectId>=128 (Synth 130-133,
  //                                Mixer 128/129). HW-verified FM3 fw12.00 2026-07-16;
  //                                symmetric to the param (body[5]) / sub (body[7]) splits.
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

/**
 * Build a FORMATTED-VALUE query (view 0x00) for (model, block, param).
 *
 * Read-only: the same query the live walk uses to read the device's own display string for a
 * parameter ('5.00', '0.316', '36.5 %'). Exported so a caller can ask the device what it shows for a
 * parameter, independent of the range tables.
 */
export function buildValueQuery(model: number, block: number, param: number): Uint8Array {
  return buildQuery(model, VIEW_VALUE, block, param, 0);
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
  // STRICT equality, not a tolerance window (FORGEFX-32): system selectors answer definition
  // queries with junk floats in the subnormal range (e.g. 3e-41), which a tolerance check
  // rounds to "integral 0" — classifying garbage as an enum and triggering a lethal 0x1f
  // label query. Real enum bounds are exact integers in the float32 payload, so exact
  // comparison loses nothing. (The HW-proven prober used exact integrality all along.)
  return Number.isFinite(x) && x === Math.round(x);
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

/**
 * The empty-slot definition a device returns for an unused / absent slot: typecode 0 and an
 * all-zero numeric body. Keyed on the typecode and the numeric fields, NOT on the symbol id: the
 * empty slot in the low param region carries id 0, but the past-the-end answer in the high
 * (param > 127) region carries a non-zero id with the same empty body. A real parameter always
 * has a non-zero typecode or a non-zero range, so nothing real is lost — and an empty slot is
 * never label- or value-probed.
 */
function isFillerDefinition(d: LiveDefinition): boolean {
  return d.tc === 0 && d.min === 0 && d.max === 0 && d.def === 0 && d.step === 0;
}

/**
 * The record an INNER empty slot becomes: the all-zero float placeholder row the editor `.cache`
 * byte source carries for the same slot, so both sources agree on a section's slot count (and
 * thus its channel-block stride). Only emitted retroactively, once a later real definition proves
 * the slot lies inside the parameter table — never for trailing empty slots, which a walk cannot
 * tell apart from the end of the table. Flagged `placeholder` so `buildDeviceCache` can refuse it
 * where the section is a sparse id space rather than a parameter table.
 */
function placeholderRecord(block: number, param: number): FloatRecord {
  return { kind: 'float', section: block, offset: 0, id: param, tc: 0, min: 0, max: 0, def: 0, step: 0, t1: 0, t2: 0, placeholder: true };
}

/** Largest plausible wire typecode — real catalogs top out ~3200; system-selector junk reads
 *  in the tens of thousands. */
const MAX_PLAUSIBLE_TC = 0x3fff;
/** Anything with magnitude below this (but non-zero) is float32 subnormal junk, not a value a
 *  parameter definition would carry. */
const SUBNORMAL_FLOOR = 1e-37;

/**
 * NOT a real parameter definition (FORGEFX-32): system selectors (e.g. FM3 block 0) answer
 * definition queries with junk — subnormal-range floats, implausible typecodes, non-finite
 * fields. Treat those as ABSENT so the walk skips the block after its opening probes instead
 * of recording garbage or, worse, label-probing it.
 */
function isGarbageDefinition(d: LiveDefinition): boolean {
  if (d.tc > MAX_PLAUSIBLE_TC) return true;
  const junk = (x: number): boolean => !Number.isFinite(x) || (x !== 0 && Math.abs(x) < SUBNORMAL_FLOOR);
  return junk(d.min) || junk(d.max) || junk(d.def) || junk(d.step) || junk(d.scale);
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
/** Plausible physical-unit token (rejects model/type NAMES that ride a discrete
 * param's value string, e.g. 'INPUT 2' — those contain a space or digits). */
const UNIT_RE = /^[A-Za-z%°µΩ/]{1,8}$/;

/** Parse the device's formatted value string (view 0x00) → its unit token, or
 * undefined. '440.0 Hz'→'Hz', '0.00 ct'→'ct', '100.0 %'→'%', 'ACTIVE'→undefined. */
export function parseUnit(display: string): string | undefined {
  const m = display.trim().match(/^[+-]?\d[\d.]*(?:[eE][+-]?\d+)?\s*(.*)$/);
  if (!m) return undefined; // no leading number = a label, not a valued param
  const tail = m[1]!.trim();
  return tail && UNIT_RE.test(tail) ? tail : undefined;
}

/**
 * Extract the leading numeric value from a device formatted-value string (view
 * 0x00), or `null` for a pure label. '200.00 Hz'→200, '-3.0 dB'→-3, 'ON'→null.
 * Port of CaptureRig v2's `parse_display` (value half). Full-mode taper sweeps
 * classify on these numbers; a non-numeric display makes that sample inert.
 */
export function parseDisplayValue(display: string): number | null {
  const m = display.trim().match(/^[+-]?\d[\d.]*(?:[eE][+-]?\d+)?/);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : null;
}

/** Round to 5 decimals — CaptureRig v2's `round(err, 5)` for the fit error. */
function round5(x: number): number {
  return Math.round(x * 1e5) / 1e5;
}

/**
 * Classify a normalized→display sweep into a knob taper. Faithful port of
 * CaptureRig v2's `classify_taper` (fas-re): fewer than 3 numeric points →
 * 'unknown' (unreliable); no movement (span ≤ 1e-9 or span/scale < 1e-4) →
 * 'flat' (unreliable — the block is not instantiated / the param is inert, so
 * the sweep carries no taper info); otherwise fit linear (`lo + span·n`) vs log
 * (`lo·(hi/lo)^n`, only when both endpoints > 0) by max relative error — log
 * wins if `log_err < lin_err && log_err < 0.02`, else linear if `lin_err <
 * 0.02`, else 'custom' (reliable, with the sample points).
 */
export function classifyTaper(samples: ReadonlyArray<readonly [number, number | null]>): FloatTaper {
  const pts: Array<readonly [number, number]> = [];
  for (const [n, v] of samples) if (v !== null) pts.push([n, v]);
  if (pts.length < 3) return { shape: 'unknown', err: null, reliable: false, points: pts };
  const vals = pts.map(([, v]) => v);
  const vspan = Math.max(...vals) - Math.min(...vals);
  let vscale = Math.max(...vals.map((v) => Math.abs(v)));
  if (!vscale) vscale = 1.0;
  if (vspan <= 1e-9 || vspan / vscale < 1e-4) {
    // no movement -> block not active / param inert -> no taper info
    return { shape: 'flat', err: 0.0, reliable: false, points: pts };
  }
  const lo = pts[0]![1];
  const hi = pts[pts.length - 1]![1];
  const span = hi - lo;
  const rel = (a: number, b: number): number => {
    const d = Math.max(Math.abs(a), Math.abs(b), 1e-9);
    return Math.abs(a - b) / d;
  };
  let linErr = 0;
  for (const [n, v] of pts) linErr = Math.max(linErr, rel(v, lo + span * n));
  let logErr: number | null = null;
  if (lo > 0 && hi > 0) {
    logErr = 0;
    for (const [n, v] of pts) logErr = Math.max(logErr, rel(v, lo * Math.pow(hi / lo, n)));
  }
  if (logErr !== null && logErr < linErr && logErr < 0.02) {
    return { shape: 'log', err: round5(logErr), reliable: true, points: pts };
  }
  if (linErr < 0.02) {
    return { shape: 'linear', err: round5(linErr), reliable: true, points: pts };
  }
  return { shape: 'custom', err: round5(Math.min(linErr, logErr ?? linErr)), reliable: true, points: pts };
}

/**
 * The normalized position that reproduces display `target` using a classified
 * taper — analytic inverse for log/linear, piecewise-linear interpolation over
 * the samples for custom/degenerate. Port of CaptureRig v2's `_invert`.
 */
function invertTaper(
  points: ReadonlyArray<readonly [number, number]>,
  target: number | null,
  shape: FloatTaper['shape'],
): number | null {
  if (target === null || points.length < 2) return null;
  const lo = points[0]![1];
  const hi = points[points.length - 1]![1];
  if (shape === 'log' && lo > 0 && hi > 0 && target > 0 && hi !== lo) {
    return Math.log(target / lo) / Math.log(hi / lo);
  }
  if (shape === 'linear' && hi !== lo) {
    return (target - lo) / (hi - lo);
  }
  for (let i = 0; i + 1 < points.length; i++) {
    const [na, va] = points[i]!;
    const [nb, vb] = points[i + 1]!;
    if ((va - target) * (vb - target) <= 0 && va !== vb) {
      return na + (nb - na) * (target - va) / (vb - va);
    }
  }
  let best = points[0]!;
  for (const p of points) if (Math.abs(p[1] - target) < Math.abs(best[1] - target)) best = p;
  return best[0];
}

/**
 * Kind: a captured label list always makes an enum. Without labels the numeric enum signature
 * (step 0, scale 0, integral bounds) is only a guess, and two pieces of device evidence veto it:
 *   - a continuous unit in the formatted value (e.g. a 20..200 Hz low cut);
 *   - `emptyList`: a label walk was attempted and the device ANSWERED its first query with an
 *     end-of-list reply — the param has no label list. That is exactly the editor cache's rule
 *     (a record is an enum only if it carries labels), and it turns integer-valued params
 *     (e.g. an effect-id or MIDI-number selector) and empty table slots into the float rows the
 *     cache has. A first query that got NO reply is not evidence and leaves the guess in place.
 */
function buildRecord(
  block: number,
  param: number,
  d: LiveDefinition,
  labels: readonly string[],
  unit?: string,
  taper?: FloatTaper,
  emptyList = false,
): CacheRecord {
  const enumKind = labels.length > 0 || (d.kind === 'enum' && !unit && !emptyList);
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
      ...(unit ? { unit } : {}),
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
    ...(unit ? { unit } : {}),
    t1: 0,
    t2: 0,
    ...(taper ? { taper } : {}),
  };
  return rec;
}

// ---------------------------------------------------------------------------
// Walk driver
// ---------------------------------------------------------------------------

/**
 * Default extra attempts for a query that got NO reply at all (`request()` resolved `null`).
 *
 * Assumed (see "Reply assumptions" above, questions 1-3): the device answers every self-describe
 * query — an empty slot with an empty-slot definition, the end of a label list with a no-payload
 * reply — so a `null` means the frame was dropped or is LATE. Where that assumption fails, the
 * liveness re-read books the silence as `silentAddresses` instead. A genuine end/sentinel reply is
 * never retried. Observed on a live FM3: the 331-entry amp roster and three other lists came back
 * short by exactly their tail entries — one dropped reply had ended each list early.
 */
const DEFAULT_LOST_REPLY_RETRIES = 2;

/**
 * Default pause (ms) after a lost reply — before every retry, and after a lost LABEL reply again
 * before the walk moves on to the next sub.
 *
 * A late reply is the dangerous case: a self-describe reply echoes view, block and param but NOT
 * the label SUB ordinal, so a late answer to sub `i` that is accepted for sub `i+1` would silently
 * shift every following label (a roster with the wrong model names — worse than a short one). The
 * pause lets a straggler arrive while no request is listening (and `LiveTransport.drain` discards
 * it where the host buffers frames). Only spent after a loss, so a clean walk is not slowed.
 */
const DEFAULT_LOST_REPLY_DRAIN_MS = 500;

/**
 * Default longest run of empty slots, bounded by real definitions, kept as inner placeholders.
 * Effect blocks carry runs of 1-6 unused slots inside their tables; a longer run is an id-space
 * gap (sparse system sections), which the editor cache does not fill either.
 */
const DEFAULT_PLACEHOLDER_RUN_LIMIT = 32;

/**
 * Default number of CONSECUTIVE unanswered queries after which the walk checks the device is
 * still alive: it re-sends the last definition query that DID get an answer. An answer proves the
 * silence is specific to those addresses — they are treated as absent and the walk goes on (with
 * no further retries in that block, as before retries existed). No answer means the device stopped
 * answering altogether (frozen or gone): the walk rejects rather than keep querying it.
 */
const DEFAULT_MAX_SILENT_QUERIES = 8;

/** After proven silence in a block, re-read the known definition every this many further silent
 *  definitions (no pause) so a device that freezes mid-block is still noticed. */
const FREEZE_RECHECK_EVERY = 32;

/**
 * Minimal transport the walk drives: send a query frame, resolve with the reply
 * frame (or `null` on timeout/no reply). Deliberately transport-agnostic — a
 * ForgeFX MIDI port, a browser Web-MIDI adapter, or a test fake all satisfy it.
 */
export interface LiveTransport {
  request(query: Uint8Array): Promise<Uint8Array | null>;
  /**
   * Optional: discard any reply frames the host has received but not yet handed out. The walk
   * calls it after each drain pause (before a retry, and after a lost label reply before the next
   * sub) so a LATE reply to an earlier query can never be returned for a later one. A host that
   * only listens while a request is pending may omit it — the drain pause alone lets a straggler
   * arrive unheard.
   */
  drain?(): Promise<void> | void;
}

/**
 * Outcome of a live walk: the records plus the reply-loss accounting a caller needs to judge
 * whether the profile is complete. Any `unresolvedReplies` means a definition may be missing or a
 * label list / unit cut short; `lostReplies > 0` with everything recovered is complete, but a
 * caller may still prefer a re-walk (a late reply cannot be matched to its sub — see
 * `lostReplyDrainMs`).
 */
export interface LiveWalkResult {
  records: CacheRecord[];
  /** Queries sent, retries included. */
  queries: number;
  /** Enum labels collected. */
  enumLabels: number;
  /** Attempts that got no reply at all and count as LOSS (dropped or late frames) — attempts at
   *  silent addresses (see `silentAddresses`) are not included. */
  lostReplies: number;
  /** Queries whose lost reply was recovered by a retry. */
  recoveredReplies: number;
  /** Queries left unanswered after every allowed retry that are genuine LOSS. Lost labels and unit
   *  reads always count here (a cut-short label list stays visible); definitions count unless a
   *  liveness check explained their silent run. Non-zero means the profile may be incomplete. */
  unresolvedReplies: number;
  /** Inner empty slots emitted as placeholder records (flagged `placeholder`). */
  placeholderSlots: number;
  /**
   * Slots inside a parameter table whose definition was LOST (never answered, not explained as a
   * silent address): neither a record nor a placeholder is emitted for them (that would invent
   * data), so the section's slot count — its stride — comes out short by this many. Non-zero
   * means re-walk before trusting strides.
   */
  missingSlots: number;
  /**
   * DEFINITION queries at addresses that stayed silent while the device demonstrably kept
   * answering — a silent run of `maxSilentQueries` in a row, or the silent run a block ends on,
   * followed by an answered re-read of a known definition: treated as absent, not as loss. Shorter
   * silent runs that an answer ends stay loss (`unresolvedReplies` / `missingSlots`): they cannot
   * be told apart from dropped replies. Expected to be 0 if the device answers every address (see
   * the hardware assumptions above).
   */
  silentAddresses: number;
}

/**
 * Host-provided WRITE side for a FULL-mode walk (`mode: 'full'`). The codec
 * stays transport-pure: it BUILDS the gen-3 continuous-SET frame with its own
 * encoder (`buildSetParameterContinuous`) and hands the finished bytes to
 * `send`; the host owns the wire. `reloadPreset` re-selects the current preset
 * to reload it from flash — the non-destructive safety net run after every
 * block whose params were swept, mirroring CaptureRig v2's per-block reload.
 * Ignored entirely in read-only mode.
 */
export interface LiveWalkWriteHooks {
  /** Send one raw SysEx frame (a codec-built continuous-SET) to the device. */
  send(frame: Uint8Array): Promise<void>;
  /** Reload the current preset from flash, discarding the sweep's writes. */
  reloadPreset(): Promise<void>;
}

/** Progress event, shaped for a future SSE surface. */
export interface LiveWalkProgress {
  /**
   * `block-start`/`block-done`/`done` fire for every walk; `param-sweep` fires
   * once per completed FULL-mode taper sweep (never in read-only mode — an
   * additive value existing read-only consumers never observe).
   */
  phase: 'block-start' | 'block-done' | 'done' | 'param-sweep';
  /** Current block address (undefined on `done`). */
  block?: number;
  /** Param id being swept (present only on `param-sweep`). */
  param?: number;
  blockIndex: number;
  blockCount: number;
  records: number;
  enumLabels: number;
  queries: number;
  /** Cumulative FULL-mode taper sweeps completed (present in full mode). */
  tapers?: number;
  /** Cumulative attempts that got no reply at all (see `LiveWalkResult.lostReplies`). */
  lostReplies?: number;
}

export interface LiveWalkOptions {
  /** Device model byte (FM3 0x11, FM9 0x12, Axe-Fx III 0x10). */
  model: number;
  /**
   * Walk mode (default `'read-only'`). `'read-only'` never writes and is
   * byte-identical to the original walk. `'full'` additionally sweeps every
   * continuous float param with a normalized CONTINUOUS-SET, reads the display
   * back to recover the knob taper (linear/log/custom), records it on the
   * `FloatRecord`, then RESTORES the original value (non-destructive). Full mode
   * REQUIRES `write` hooks — the walk throws at start when they are absent.
   */
  mode?: 'read-only' | 'full';
  /**
   * Host WRITE hooks — REQUIRED for `mode: 'full'` (the walk throws at start
   * when absent). Ignored entirely in read-only mode.
   */
  write?: LiveWalkWriteHooks;
  /**
   * Normalized sample count per taper sweep (default 9, matching CaptureRig v2):
   * n = i/(points-1) for i in 0..points-1. Full mode only.
   */
  taperPoints?: number;
  /**
   * Settle pause (ms) between a sweep SET and the display read-back, floored at
   * 20ms (CaptureRig v2's ≥20ms pacing). Routed through `sleep`. Full mode only.
   */
  sweepSettleMs?: number;
  /** Explicit block addresses to sweep; defaults to `0..maxBlock`. */
  blocks?: number[];
  /** Highest block address swept when `blocks` is omitted (default 160 — the block
   * byte splits lo/hi so effectId>=128 blocks are reachable). */
  maxBlock?: number;
  /**
   * Read the device's formatted value (self-describe view 0x00) for each found
   * param and record its device-true `unit` (default true). Read-only; adds one
   * query per param. Set false to skip (e.g. a faster minimal walk).
   */
  readValues?: boolean;
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
  /**
   * Extra attempts for a query that got no reply at all (default 2). Applies to definition
   * queries once a block's table has started (the block-probe phase stays one-shot), the unit
   * read and enum labels AFTER the first one (a list already proven by a label). The FIRST label
   * query of a param is never repeated: it may be a speculative probe, and those stay one-shot.
   * A genuine end/sentinel reply is never retried. 0 disables retries.
   */
  lostReplyRetries?: number;
  /**
   * Pause (ms) before a retry, and after a lost label reply before the next sub, so a late reply
   * cannot be taken for a later query (default 500; routed through `sleep`). See
   * `LiveTransport.drain` for hosts that buffer frames.
   */
  lostReplyDrainMs?: number;
  /**
   * Longest run of empty slots between real definitions (or before the first one) that is kept
   * as inner placeholder records (default 32). Trailing empty slots are always trimmed — they
   * cannot be told apart from the end of the table. 0 keeps none (the pre-placeholder behaviour).
   */
  placeholderRunLimit?: number;
  /**
   * Consecutive unanswered queries within a block before the walk re-sends the last answered
   * definition query as a liveness check (default 8; a block that ENDS in unanswered queries is
   * checked once at its end). If that answers, the silent addresses count as absent
   * (`silentAddresses`) and the rest of the block runs without retries or further checks; if not,
   * the walk rejects with a "device stopped answering" error. Also the number of unanswered
   * queries after which a walk that never got any answer rejects. Bounds the traffic aimed at a
   * frozen device without failing on addresses that merely do not answer.
   */
  maxSilentQueries?: number;
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

// ---------------------------------------------------------------------------
// Full-mode taper sweep (write + restore) — port of CaptureRig v2's Gen3Profile
// ---------------------------------------------------------------------------

/** CaptureRig v2's ≥20ms floor between a sweep SET and the display read-back. */
const MIN_SWEEP_SETTLE_MS = 20;

/** Default normalized sample count per sweep (CaptureRig v2 default). */
const DEFAULT_TAPER_POINTS = 9;

/** Read the device's formatted-value string (view 0x00), or `null`. */
async function readDisplay(transport: LiveTransport, model: number, block: number, param: number): Promise<string | null> {
  const vr = await transport.request(buildQuery(model, VIEW_VALUE, block, param, 0));
  const vd = vr ? decodeReply(vr) : null;
  return vd && vd.view === 'value' ? vd.value : null;
}

interface SweepContext {
  transport: LiveTransport;
  write: LiveWalkWriteHooks;
  model: number;
  points: number;
  settleMs: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Sweep one continuous float param: read the current display, drive normalized
 * 0..1 via CONTINUOUS-SET reading the display back at each step, classify the
 * taper, then RESTORE the original value through the classified curve's analytic
 * inverse. Faithful port of CaptureRig v2's `_sweep_taper`/`_restore`. Returns
 * the classified taper; ALWAYS attempts the restore (the codec builds every
 * SET with `buildSetParameterContinuous` and sends it via the host `write`
 * hook). `reads` counts the display queries issued (folded into `queries`).
 */
async function sweepTaper(ctx: SweepContext, block: number, param: number): Promise<{ taper: FloatTaper; reads: number }> {
  const { transport, write, model, points, settleMs, signal, sleep } = ctx;
  const settle = Math.max(settleMs, MIN_SWEEP_SETTLE_MS);
  let reads = 0;

  const origDisplay = await readDisplay(transport, model, block, param);
  reads += 1;
  const origVal = origDisplay === null ? null : parseDisplayValue(origDisplay);

  const samples: Array<readonly [number, number | null]> = [];
  const denom = points > 1 ? points - 1 : 1;
  for (let i = 0; i < points; i++) {
    throwIfAborted(signal);
    const n = i / denom;
    await write.send(Uint8Array.from(buildSetParameterContinuous(block, param, n, model)));
    await pace(settle, signal, sleep);
    const disp = await readDisplay(transport, model, block, param);
    reads += 1;
    samples.push([round5(n), disp === null ? null : parseDisplayValue(disp)] as const);
  }

  const taper = classifyTaper(samples);

  // Restore via the classified curve's analytic inverse (precise even for
  // wide-range log params); the per-block preset reload is the safety net.
  const n0 = invertTaper(taper.points, origVal, taper.shape);
  if (n0 !== null) {
    throwIfAborted(signal);
    await write.send(Uint8Array.from(buildSetParameterContinuous(block, param, Math.max(0, Math.min(1, n0)), model)));
    await pace(settle, signal, sleep);
    // Read back so the restore mirrors the hardware round-trip (result unused in
    // the record; a bad restore is caught by the per-block preset reload).
    await readDisplay(transport, model, block, param);
    reads += 1;
  }

  return { taper, reads };
}

/**
 * Sweep a device's self-describe map into `CacheRecord[]` deep-equivalent to the
 * `.cache` byte-walker's output (minus the unreachable special table records).
 * Shorthand for `liveWalkDetailed(...).records`.
 *
 * Feed the result straight to `buildCache({ kind: 'live', walk })` — or use
 * `liveSource(transport, opts)` to build that source in one call.
 */
export async function liveWalk(transport: LiveTransport, opts: LiveWalkOptions): Promise<CacheRecord[]> {
  return (await liveWalkDetailed(transport, opts)).records;
}

/**
 * The live walk with its reply-loss accounting (`LiveWalkResult`).
 *
 * Reply handling — a NO-REPLY (`null`) is never read as a device answer:
 *   - definition queries inside a block's table: retried (a lost definition would otherwise
 *     silently drop a param); still unanswered → the slot is skipped and counted in
 *     `unresolvedReplies` (and `missingSlots` when it is inner). The block-probe phase stays
 *     one-shot, as before;
 *   - enum labels: the FIRST label query of a param is one-shot exactly as before (it may be a
 *     speculative probe); a lost reply there ends the list. Later labels belong to a list the
 *     device has already proven, so a lost one is retried instead of truncating the list;
 *   - the unit read (view 0x00): retried.
 * A retry follows a drain pause (and `transport.drain`); a lost label is followed by one more
 * before the next sub — see `lostReplyDrainMs` for why a late reply must never answer a later
 * sub. After `maxSilentQueries` unanswered queries in a row the walk checks the device is alive
 * (see there) and either carries on or rejects. On a device that answers every query the query
 * and pause sequence is exactly the one the walk always sent.
 *
 * Empty slots: an empty-slot definition between two real definitions (or before the first one)
 * is an unused slot INSIDE the parameter table — the editor cache keeps it as an all-zero float
 * placeholder, so the walk emits the same placeholder once the next real definition proves it is
 * inner. Trailing empty slots are trimmed (indistinguishable from the end of the table), and a run
 * longer than `placeholderRunLimit` is an id-space gap, not placeholders.
 */
export async function liveWalkDetailed(transport: LiveTransport, opts: LiveWalkOptions): Promise<LiveWalkResult> {
  const model = opts.model;
  // 160 (not 127): the block byte now splits lo/hi (body[2]/[3]) so effectId>=128
  // blocks are reachable. Empty high blocks are skipped after `blockProbeDepth`
  // params (see the found===0 break below), so the extra range is nearly free.
  const maxBlock = opts.maxBlock ?? 160;
  const blocks = opts.blocks ?? Array.from({ length: maxBlock + 1 }, (_, i) => i);
  const maxParamId = opts.maxParamId ?? 16383;
  const absentRunLimit = opts.paramAbsentRunLimit ?? 256;
  const probeDepth = opts.blockProbeDepth ?? 4;
  const enumCap = opts.enumCountCap ?? 1024;
  // read view 0x00 per found param to capture the device-true unit (default on).
  const readValues = opts.readValues ?? true;
  const lostRetries = Math.max(0, opts.lostReplyRetries ?? DEFAULT_LOST_REPLY_RETRIES);
  const drainMs = opts.lostReplyDrainMs ?? DEFAULT_LOST_REPLY_DRAIN_MS;
  const placeholderRunLimit = Math.max(0, opts.placeholderRunLimit ?? DEFAULT_PLACEHOLDER_RUN_LIMIT);
  const maxSilent = Math.max(1, opts.maxSilentQueries ?? DEFAULT_MAX_SILENT_QUERIES);
  const interQueryMs = opts.interQueryMs ?? 0;
  const { signal, sleep, onProgress } = opts;

  // FULL mode: opt-in taper sweep. Requires host write hooks — fail fast at the
  // walk start (before any wire traffic) when they are missing.
  const mode = opts.mode ?? 'read-only';
  const full = mode === 'full';
  if (full && !opts.write) {
    throw new Error(
      "liveWalk: mode 'full' requires write hooks (opts.write.{send,reloadPreset}); pass them or use mode 'read-only'",
    );
  }
  const taperPoints = opts.taperPoints ?? DEFAULT_TAPER_POINTS;
  const sweepSettleMs = opts.sweepSettleMs ?? MIN_SWEEP_SETTLE_MS;
  const sweepCtx: SweepContext | undefined = full
    ? { transport, write: opts.write!, model, points: taperPoints, settleMs: sweepSettleMs, signal, sleep }
    : undefined;

  const records: CacheRecord[] = [];
  let queries = 0;
  let enumLabels = 0;
  let tapers = 0;
  let lostReplies = 0;
  let recoveredReplies = 0;
  let unresolvedReplies = 0;
  let placeholderSlots = 0;
  let missingSlots = 0;
  let silentAddresses = 0;
  let lastAnsweredDef: Uint8Array | undefined; // liveness probe: a definition query that answered
  let neverAnswered = 0; // unanswered queries before anything answered at all
  // Per block: consecutive unanswered queries, and whether the liveness check has shown that
  // this block's silence is address-specific (the device itself still answers).
  let blockSilentRun = 0;
  let blockSilenceProven = false;
  let trailingSilentDefs = 0; // unanswered definition queries since the block's last answered one
  let silentSinceProof = 0; // silent definitions since this block's silence was proven
  // DEFINITION queries booked as loss that a proof of silence may re-book as silent addresses:
  // the current silent run (reset by every answered query), and the runs of earlier blocks that
  // ended silent before anything had answered (no liveness check could cover them yet). Lost
  // labels and unit reads are never re-booked: they stay genuine loss.
  interface Booked {
    lost: number;
    unresolved: number;
  }
  let runBooked: Booked = { lost: 0, unresolved: 0 };
  let deferredBooked: Booked = { lost: 0, unresolved: 0 };

  /** After a lost reply: give a late frame time to arrive unheard, then drop anything buffered. */
  const settleAfterLoss = async (): Promise<void> => {
    await pace(drainMs, signal, sleep);
    throwIfAborted(signal);
    await transport.drain?.();
  };

  /**
   * Send one query (paced). A `null` reply is LOST. With `retry` the same query is re-sent after a
   * drain pause, up to `lostRetries` times. After a lost LABEL reply the walk drains again before
   * moving on: the next query is the next sub of the same param, and a straggler (the late answer,
   * or a duplicate after a successful retry) would be indistinguishable from its reply. Other
   * views move to a different view or param, which the reply echo tells apart. One-shot queries
   * that get no reply cost exactly what they always did — no pause, no retry.
   */
  const ask = async (query: Uint8Array, retry: boolean, label = false): Promise<Uint8Array | null> => {
    const attempts = retry ? lostRetries + 1 : 1;
    let lost = 0;
    let frame: Uint8Array | null = null;
    for (let a = 0; a < attempts; a++) {
      if (a > 0) await settleAfterLoss();
      throwIfAborted(signal);
      await pace(interQueryMs, signal, sleep);
      frame = await transport.request(query);
      queries += 1;
      if (frame) break;
      lost += 1;
    }
    const isDef = query[6] === VIEW_DEFINITION;
    if (isDef) {
      if (frame) lastAnsweredDef = query;
      trailingSilentDefs = frame ? 0 : trailingSilentDefs + 1;
    }
    if (frame) {
      blockSilentRun = 0;
      runBooked = { lost: 0, unresolved: 0 };
      if (lost > 0) {
        lostReplies += lost; // a late or dropped frame: the retry got the answer
        recoveredReplies += 1;
      }
    } else if (blockSilenceProven && isDef) {
      silentAddresses += 1; // this block's definition silence is already explained
      // Still notice a device that freezes later in the block: a cheap re-read now and then.
      if (++silentSinceProof % FREEZE_RECHECK_EVERY === 0) await stillAlive();
    } else {
      // Genuine loss — unless a later proof re-books it (definitions of the current run only).
      lostReplies += lost;
      unresolvedReplies += 1;
      if (isDef) {
        runBooked.lost += lost;
        runBooked.unresolved += 1;
      }
      if (!blockSilenceProven) {
        blockSilentRun += 1;
        if (!lastAnsweredDef && ++neverAnswered >= maxSilent) stopped(neverAnswered);
        if (lastAnsweredDef && blockSilentRun >= maxSilent) await proveSilence();
      }
    }
    if (lost > 0 && label) await settleAfterLoss(); // a straggler must not answer the next sub
    return frame;
  };

  const stopped = (n: number): never => {
    throw new Error(`liveWalk: device stopped answering (${n} consecutive queries unanswered, liveness check unanswered); walk aborted`);
  };

  /**
   * A silent run in this block: re-send the last definition query that DID answer. An answer
   * means the silence is specific to those addresses — the run's DEFINITION queries (and any
   * earlier unchecked block's) are re-booked from the loss counters to `silentAddresses`, and the
   * rest of the block runs without definition retries. No answer means the device stopped
   * answering: the walk rejects.
   */
  const proveSilence = async (): Promise<void> => {
    const n = blockSilentRun;
    await settleAfterLoss();
    await pace(interQueryMs, signal, sleep);
    const alive = await transport.request(lastAnsweredDef!);
    queries += 1;
    if (!alive) stopped(n);
    for (const b of [runBooked, deferredBooked]) {
      lostReplies -= b.lost;
      unresolvedReplies -= b.unresolved;
      silentAddresses += b.unresolved;
    }
    runBooked = { lost: 0, unresolved: 0 };
    deferredBooked = { lost: 0, unresolved: 0 };
    blockSilentRun = 0;
    silentSinceProof = 0;
    blockSilenceProven = true;
  };

  /** After proven silence: re-read the known definition (no pause — nothing is in flight). */
  const stillAlive = async (): Promise<void> => {
    await pace(interQueryMs, signal, sleep);
    const alive = await transport.request(lastAnsweredDef!);
    queries += 1;
    if (!alive) stopped(silentSinceProof);
  };

  type ProgressHead = Omit<LiveWalkProgress, 'records' | 'enumLabels' | 'queries' | 'tapers' | 'lostReplies'>;
  const progress = (p: ProgressHead): void => {
    onProgress?.({ ...p, records: records.length, enumLabels, queries, ...(full ? { tapers } : {}), lostReplies });
  };

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi]!;
    throwIfAborted(signal);
    progress({ phase: 'block-start', block, blockIndex: bi, blockCount: blocks.length });

    let absentRun = 0;
    let found = 0;
    let sweptInBlock = false;
    // Empty slots seen since the last real definition (candidate inner placeholders), and
    // whether that run is still placeholder-shaped (no sentinel / junk answer inside it).
    let pendingEmpty: number[] = [];
    let pendingUnknown = 0;
    let pendingIntact = true;
    let lastReal = -1;
    blockSilenceProven = false;
    blockSilentRun = 0;
    trailingSilentDefs = 0;
    silentSinceProof = 0;
    runBooked = { lost: 0, unresolved: 0 };
    for (let param = 0; param <= maxParamId; param++) {
      throwIfAborted(signal);
      // The block-probe phase (no definition found yet) stays one-shot, exactly as before:
      // retries there would multiply the cost of every empty block. So does a block whose
      // silent addresses the liveness check has already explained.
      const reply = await ask(buildDefQuery(model, block, param), found > 0 && !blockSilenceProven);
      const dec = reply ? decodeReply(reply) : null;
      const def = dec && dec.view === 'definition' ? dec : null;

      if (!def || isFillerDefinition(def) || isGarbageDefinition(def)) {
        if (def && isFillerDefinition(def)) pendingEmpty.push(param);
        else if (reply) pendingIntact = false; // a sentinel / junk answer: not a table slot
        else pendingUnknown += 1; // unanswered: the slot is simply unknown
        absentRun += 1;
        // Skip an empty block once its opening params are all absent.
        if (found === 0 && param + 1 >= probeDepth) break;
        if (absentRun >= absentRunLimit) break;
        continue;
      }
      absentRun = 0;
      found += 1;

      // This real definition proves the empty slots before it are INNER: keep them as the
      // all-zero placeholders the editor cache carries, unless the run is an id-space gap.
      if (pendingIntact && param - lastReal - 1 <= placeholderRunLimit) {
        for (const p of pendingEmpty) records.push(placeholderRecord(block, p));
        placeholderSlots += pendingEmpty.length;
        if (!blockSilenceProven) missingSlots += pendingUnknown; // inner slots nobody answered for
      }
      pendingEmpty = [];
      pendingUnknown = 0;
      pendingIntact = true;
      lastReal = param;

      const labels: string[] = [];
      let emptyList = false;
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
          // i === 0 is the first (possibly speculative) probe: one-shot, as always. From i > 0
          // the list is proven, so a NO-REPLY is retried rather than read as its end. A reply
          // that decodes to no label (sentinel / cnt == 0) is the genuine end either way.
          const er = await ask(buildEnumQuery(model, block, param, lo + i), i > 0, true);
          const ed = er ? decodeReply(er) : null;
          if (!ed || ed.view !== 'enum_label') {
            if (i === 0 && er) emptyList = true; // answered: there is no label list
            break;
          }
          labels.push(ed.label);
        }
        enumLabels += labels.length;
      }
      // UNIT: read the device's own formatted value (view 0x00) and parse the unit
      // token. Read-only, one extra query per found param; skipped when the caller
      // opts out or for enum/label params whose value carries no unit.
      let unit: string | undefined;
      if (readValues && labels.length === 0) {
        const vr = await ask(buildQuery(model, VIEW_VALUE, block, param, 0), true);
        const vd = vr ? decodeReply(vr) : null;
        if (vd && vd.view === 'value') unit = parseUnit(vd.value);
      }

      // FULL mode: sweep the taper of a CONTINUOUS FLOAT param only — never an
      // enum (a label list was found) nor an int/inert param (kind!=float or
      // max==min). Mirrors CaptureRig v2's `d["kind"]=="float" and max!=min`
      // (the label walk already claimed any enum). The sweep writes + restores;
      // its taper rides the FloatRecord and is threaded into the RangeDef.
      let taper: FloatTaper | undefined;
      if (sweepCtx && labels.length === 0 && def.kind === 'float' && def.max !== def.min) {
        await pace(interQueryMs, signal, sleep);
        const swept = await sweepTaper(sweepCtx, block, param);
        taper = swept.taper;
        queries += swept.reads;
        tapers += 1;
        sweptInBlock = true;
        progress({ phase: 'param-sweep', block, param, blockIndex: bi, blockCount: blocks.length });
      }

      records.push(buildRecord(block, param, def, labels, unit, taper, emptyList));
    }
    // Empty slots still pending here are TRAILING and dropped: a walk cannot tell them apart
    // from the end of the table, so a section ending in unused slots yields a SHORTER stride
    // than the editor cache (a lower bound).

    // A block whose definition sweep ENDED in a silent run: check the device is alive. An answer
    // re-books that run's definition queries as silent addresses; no answer ends the walk. With
    // nothing answered yet the check has nothing to re-read: keep the run booked for the next
    // successful check. Everything else unanswered (lost labels / unit reads, silent runs that an
    // answer ended) stays genuine loss.
    if (!blockSilenceProven && trailingSilentDefs > 0 && runBooked.unresolved > 0) {
      if (lastAnsweredDef) {
        await proveSilence();
      } else {
        deferredBooked = {
          lost: deferredBooked.lost + runBooked.lost,
          unresolved: deferredBooked.unresolved + runBooked.unresolved,
        };
      }
    }

    // FULL-mode safety net: reload the preset from flash after every block whose
    // params were swept, so an interrupt can never leave unsaved sweep edits
    // behind (CaptureRig v2's per-block `reload_preset`).
    if (sweepCtx && sweptInBlock) {
      throwIfAborted(signal);
      await sweepCtx.write.reloadPreset();
    }

    progress({ phase: 'block-done', block, blockIndex: bi, blockCount: blocks.length });
    await pace(opts.blockPauseMs ?? 0, signal, sleep);
  }

  progress({ phase: 'done', blockIndex: blocks.length, blockCount: blocks.length });
  return { records, queries, enumLabels, lostReplies, recoveredReplies, unresolvedReplies, placeholderSlots, missingSlots, silentAddresses };
}

/**
 * Convenience: a `RecordSource` that walks a live device, ready for
 * `buildCache(liveSource(transport, opts), params, seeds, …)`.
 */
export function liveSource(transport: LiveTransport, opts: LiveWalkOptions): RecordSource {
  return { kind: 'live', walk: () => liveWalkDetailed(transport, opts) };
}
