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
 * Empty slots: the device answers an unused slot with an empty-slot definition
 * (typecode 0, all-zero body). Inner empty slots become the all-zero float
 * placeholder rows the `.cache` carries. Past the end of an effect table the
 * device answers a NO-PAYLOAD definition reply instead (payload count 0, FM3
 * fw 13.0), so a run of empty slots (symbol id 0) right after the last real
 * definition that ends in such a reply is the table's unused tail and is kept
 * too; a run with no such end (more empty slots up to the stop run, an end
 * marker, a sentinel-tagged or junk answer, silence) is trimmed (see
 * `liveWalkDetailed`).
 *
 * ── Coverage ────────────────────────────────────────────────────────────────
 * PARAM is 14-bit, so ids up to 16383 are addressable on the wire, but the walk
 * only queries up to a per-block ceiling (see "Table end, bounds and pseudo
 * definitions"). The special table records (id >= 0xff00: cab/IR bank tables,
 * padded rosters) are NOT param-addressable and are absent from a live walk by
 * design. They affect only a section's declared record count and the cab/IR
 * banks; every other derived table is reproduced exactly. A complete cache
 * pairs the live walk with those few byte-sourced table records.
 *
 * ── Table end, bounds and pseudo definitions ────────────────────────────────
 * A table does not announce its end, and a definition query far outside it is
 * out of contract. Read-only definition queries on an FM3 (fw 13.0) showed:
 *   - block 1 holds real params 0..132 (each definition carries its own `id`).
 *     From 133 on EVERY reply is the same end marker — typecode 0, empty body,
 *     one fixed non-zero `id`, `scale` 0 (at 133) or 128 (after); checked to 600.
 *   - much further out the same block answers junk that is shaped like a
 *     definition (an `id` reused from the end marker, an enum-shaped range of
 *     65 546 values, ...) or a short non-definition reply.
 *   - walks of an FM9 and an Axe-Fx III hold junk definitions too: a system block
 *     repeating one `id` and one near-zero float body over 250 params, rows with
 *     near-zero float fields, and records with `min > max`, a typecode 0 and a
 *     float bit pattern as `id`.
 *   - block 0 answers table-shaped definitions up to param 511. A single
 *     definition query for param 1000 of block 0 froze the unit: no reply, then
 *     no reply to anything until a power cycle. Queries inside its table
 *     (128..300) were fine.
 * So the walk never probes far past a table's last real definition, and in
 * FULL mode must not write to a parameter that does not exist:
 *   1. CEILING — no query above a per-block ceiling, the first that applies:
 *        - `paramBoundByBlock[block]`: a HARD ceiling (highest id, inclusive),
 *          never exceeded for any reason. It wins over `maxParamId` in both
 *          directions — and over a known size, even above n - 1 + the stop
 *          run, so a host passes it only as a cap tighter than that; a
 *          negative bound skips the block; a bound above 16383 is clamped
 *          (the wire field would wrap);
 *        - `paramKnownSizeByBlock[block]` = n (a table size from a catalog or
 *          cache): min(`maxParamId`, n - 1 + `paramAbsentRunLimit`) — the known
 *          table plus room for the params a newer unit appends;
 *        - `maxParamId`, which defaults to 127 in read-only mode (the validated
 *          envelope) and 511 in FULL mode (the largest table seen, well below
 *          the freeze at 1000) — never the whole 14-bit space.
 *   2. STOP RUN — a block ends once `paramAbsentRunLimit` (default 32, the
 *      `placeholderRunLimit` default) consecutive params in a row answered
 *      absent — an empty slot, the end marker, a pseudo definition, a sentinel
 *      or silence. A run of exactly that many ends the block, so inner empty
 *      runs are bridged (and kept as placeholders) only up to one less. A
 *      KNOWN SIZE n suspends the stop run for ids 0..n-1 only, so a sparse
 *      table keeps its real rows after long id gaps; past it the normal stop
 *      run applies, counted afresh from id n (the lookahead past the table is
 *      always a full run), up to the ceiling, which is how params appended by
 *      a newer unit are found. Pass only the EXACT table size of the attached firmware:
 *      an over-large known size removes the stop run up to it, and junk past a
 *      table's end that passes the pseudo checks is then walked and, in FULL
 *      mode, swept up to it. The stop run is also what holds a caller that
 *      passes a wide `maxParamId` and no bound away from the far ids.
 *   3. PSEUDO DEFINITIONS — treated exactly like an absent slot (no record, no
 *      label walk, no unit read, no sweep) and counted in
 *      `LiveWalkResult.pseudoReplies`:
 *        endMarker   typecode 0 + empty body with a non-zero `id` (any scale):
 *                    the past-the-end answer. It also counts an INNER unused
 *                    slot that answers with a non-zero `id` (that slot still
 *                    becomes a placeholder). An empty slot with `id` 0 is not
 *                    counted.
 *        duplicateId a definition whose NON-ZERO `id` was already seen in the same
 *                    block on a real definition or an end marker (non-zero ids
 *                    are unique per real param). Id 0 means "no symbol id" and
 *                    is shared by many real params — never a duplicate.
 *        implausible junk the typecode / float checks flag (`isGarbageDefinition`,
 *                    incl. non-zero magnitudes below 1e-9) or bounds in the
 *                    wrong order (`min > max`). NOT a size
 *                    limit on an enum-shaped range: real continuous params
 *                    whose bounds are integers (e.g. 200..20000) look like one,
 *                    and a range over `enumCountCap` only has its label list
 *                    clamped.
 *   4. WRITES — a FULL-mode taper sweep runs only on a definition that passed
 *      all of the above and sits at or below its block's bound. Far-id safety
 *      for a caller that passes a wide ceiling rests on the stop run (2).
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
 *      (typecode 0, all-zero body)? The placeholder rows rest on this. A trailing
 *      unused slot can be told from the table end only where the end answers
 *      differently (a no-payload reply, as on an FM3 at fw 13.0); a table whose
 *      end answers empty-slot definitions keeps its trailing unused slots hidden.
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

  // DEFINITION record: only under the DEFINITION view (0x1c), exactly 36 raw
  // bytes with finite numeric fields.
  //
  // The view byte MUST be checked: any 36-byte payload whose five f32 fields
  // are finite satisfies the shape test, and ASCII text always does (a top byte
  // <= 0x7E can never give an exponent of 0xFF, so the floats are always
  // finite). Without this the string/value branch is unreachable for a 36-byte
  // text reply — it would be returned as a bogus `definition`. `selector` is the
  // view echo (`frame[6]`). A reply that is NOT the definition view falls
  // through to the string branch below.
  if (selector === VIEW_DEFINITION && cnt === 36 && raw.length === 36) {
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
  //
  // The device returns a FIXED-WIDTH buffer whose display string is
  // NUL-terminated, so the string is the LEADING run of bytes up to the FIRST
  // NUL. Trimming only TRAILING NULs is not enough: a display string shorter
  // than the region the device packs ahead of further buffer content leaves
  // INTERIOR NUL padding (a delay low-cut reply reads "20.0 Hz\0\0sec"), and
  // that padding byte then fails the printable check, so the reply would decode
  // to null and the parameter would lose its value and unit. Ending the string
  // at the first NUL decodes trailing-only padding ("5.00\0\0…") identically,
  // skips interior padding, and still falls through to null for a payload whose
  // leading byte is a NUL or non-printable.
  //
  // The interior-NUL tolerance is scoped to the VALUE buffer (0x00): it packs
  // SEVERAL NUL-separated fields, so bytes after the first NUL are structural.
  // Every other view keeps the strict rule (as before): once the string ends,
  // only NUL padding may follow. A LABEL buffer (0x1f) holds exactly ONE string,
  // so any non-NUL content after the terminating NUL means the reply is not a
  // label (another field in the same fixed-width buffer, or a mis-targeted
  // read). Accepting it would let a speculative 0x1f probe of a numeric float
  // that answers with printable bytes, a NUL and then junk decode to a label,
  // and the `labels.length > 0` test in `buildRecord` would then turn that float
  // into an enum. A genuine label has no non-NUL byte after the terminator, so
  // the strict rule still recovers every real label.
  let end = 0;
  while (end < raw.length && raw[end] !== 0x00) end += 1;
  let clean = end > 0;
  if (clean && selector !== VIEW_VALUE) {
    for (let i = end; i < raw.length; i++) {
      if (raw[i] !== 0x00) {
        clean = false;
        break;
      }
    }
  }
  if (clean) {
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

  // The tag carries a payload but it is neither a definition record nor a clean
  // printable string (e.g. the 0x2e large value dump, or any non-value view with
  // non-NUL bytes after its first NUL): decodes to null. Not a parameter definition.
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
 * A well-formed self-describe reply echoing `view` whose payload count is 0 (under an ordinary tag).
 * Under the definition view this is how an effect table answers past its end (FM3 fw 13.0), as
 * opposed to the empty-slot definition of an unused slot inside it. A sentinel-tagged reply (0x01 /
 * 0x03) is NOT taken as a table end: it was never seen there, so it keeps its old meaning (a
 * non-slot answer that ends a run as a gap).
 */
function isNoPayloadReply(frame: Uint8Array, view: number): boolean {
  const n = frame.length;
  if (n < 10 || frame[0] !== 0xf0 || frame[1] !== 0x00 || frame[2] !== 0x01 || frame[3] !== 0x74 || frame[5] !== FN_SELFDESCRIBE || frame[n - 1] !== 0xf7) {
    return false;
  }
  const inner = frame.subarray(6, n - 2);
  if (inner.length < 15 || inner[0] !== view || TAG_SENTINELS.has(inner[6]!)) return false;
  return (inner[13]! | (inner[14]! << 8)) === 0;
}

/**
 * The record an unused slot INSIDE a table becomes: the all-zero float placeholder row the editor
 * `.cache` byte source carries for the same slot, so both sources agree on a section's slot count
 * (and thus its channel-block stride). Only emitted retroactively, once the slot is proven to lie
 * inside the parameter table: by a later real definition, or — for the unused tail of a table —
 * by the no-payload reply that ends the run of empty slots (see "Empty slots"). Flagged
 * `placeholder` so `buildDeviceCache` can refuse it where the section is a sparse id space rather
 * than a parameter table.
 */
function placeholderRecord(block: number, param: number): FloatRecord {
  return { kind: 'float', section: block, offset: 0, id: param, tc: 0, min: 0, max: 0, def: 0, step: 0, t1: 0, t2: 0, placeholder: true };
}

/** Largest plausible wire typecode — real catalogs top out ~3200; system-selector junk reads
 *  in the tens of thousands. */
const MAX_PLAUSIBLE_TC = 0x3fff;
/** Anything with magnitude below this (but non-zero) is junk (near-zero float bit patterns), not a
 *  value a parameter definition would carry. 1e-9 rather than the float32 subnormal edge: a system
 *  block fills hundreds of ids with one body of ~1e-36 floats and some effect blocks answer rows of
 *  1e-19..1e-10 floats, while the smallest non-zero magnitude of any real definition in the fixtures
 *  and replayed walks is 1e-6. */
const SUBNORMAL_FLOOR = 1e-9;

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
 * Structurally implausible even though `isGarbageDefinition` passes it: bounds in the wrong order.
 * Conservative on purpose — only rules that no definition of the FM3 / AM4 fixtures and no
 * plausible definition of the FM9 / Axe-Fx III replay walks satisfies are admitted (the replay
 * and fixture suites pin it). A size limit on an enum-shaped range is NOT one of them: real
 * integer-bounded continuous params (200..20000) span far more values than `enumCountCap`.
 */
function isImplausibleDefinition(d: LiveDefinition): boolean {
  return d.min > d.max;
}

/** What a decoded definition reply is, for the walk (see "Table end, bounds and pseudo definitions"). */
type DefinitionVerdict = 'real' | 'empty' | 'end-marker' | 'garbage' | 'duplicate-id' | 'implausible';

/**
 * Judge one decoded definition against the ids already seen in its block. Only `real` becomes a
 * record; every other verdict is an ABSENT slot (never label-walked, value-read or swept). `empty`
 * is the ordinary unused slot (symbol id 0); `end-marker` is the same empty body under a non-zero id,
 * the answer a table gives past its last real parameter.
 */
function judgeDefinition(d: LiveDefinition, seenIds: ReadonlySet<number>): DefinitionVerdict {
  if (isFillerDefinition(d)) return d.id === 0 ? 'empty' : 'end-marker';
  if (isGarbageDefinition(d)) return 'garbage';
  if (d.id !== 0 && seenIds.has(d.id)) return 'duplicate-id'; // id 0 = no symbol id, shared by real params
  if (isImplausibleDefinition(d)) return 'implausible';
  return 'real';
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
 * Default number of CONSECUTIVE absent params (empty slot, end marker, pseudo definition, sentinel
 * or silence) that end the sweep of a block WITHOUT a caller bound. A run of exactly this many ends
 * the block, so an inner empty run is bridged (and kept as placeholders) up to one less — the
 * placeholder run limit has the same value, and a longer inner run is an id-space gap. Small on
 * purpose — the table's real end is followed by an endless run of end-marker replies, and every
 * query past it is wasted traffic that moves toward the far ids a device may not survive (see "Table
 * end, bounds and pseudo definitions"). A block with a caller bound is walked to the bound instead.
 */
const DEFAULT_ABSENT_RUN_LIMIT = 32;

/** Highest param id the 14-bit PARAM field (body[4]/[5]) can carry; one more would wrap to 0. */
const MAX_WIRE_PARAM_ID = 16383;

/**
 * Default highest param id queried per block, READ-ONLY mode: the validated envelope (the id
 * space above 127 was never swept read-only on a unit), the same ceiling the host passes.
 */
const DEFAULT_READ_ONLY_MAX_PARAM_ID = 127;

/**
 * Default highest param id queried per block, FULL mode. The largest table seen on a unit ends at
 * id 511; a definition query for id 1000 of the same block froze the unit. 511 reaches every table
 * seen with a wide margin below that; a caller that knows a block's size passes
 * `paramKnownSizeByBlock` / `paramBoundByBlock` (a larger table than 511 is cut off here, never
 * over-probed).
 */
const DEFAULT_FULL_MAX_PARAM_ID = 511;

/** The effective inclusive param ceiling for a finite requested bound: floored, never above the wire limit. */
function clampParamBound(requested: number): number {
  return Math.min(MAX_WIRE_PARAM_ID, Math.floor(requested));
}

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
  /** Empty slots inside a table (inner ones, and a table's unused tail that a no-payload reply
   *  ended) emitted as placeholder records (flagged `placeholder`). */
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
  /**
   * Definition replies that were answered but are not real parameter definitions, so the walk
   * treated them as absent slots (no record, label walk, unit read or sweep) — see "Table end,
   * bounds and pseudo definitions". Not loss: these replies are the device's own answer.
   */
  pseudoReplies: PseudoReplyStats;
}

/** Breakdown of `LiveWalkResult.pseudoReplies`, counted per query answered. */
export interface PseudoReplyStats {
  /** Empty body under a non-zero symbol id: the answer a table gives past its last real param. Also
   *  counts an INNER unused slot that answers with a non-zero id (it still becomes a placeholder). */
  endMarker: number;
  /** A definition whose non-zero symbol id repeated one already seen in the same block. */
  duplicateId: number;
  /** Junk-shaped definitions (system-selector junk the float / typecode checks flag, `min > max`). */
  implausible: number;
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
   * Highest PARAM id queried per block, inclusive. Default 127 in read-only mode and 511 in FULL
   * mode — NOT the whole 14-bit space: a definition query far past a table's end is out of
   * contract and one such query (block 0, id 1000) froze a unit. Values above 16383 are clamped
   * (the wire field would wrap); a non-finite value (NaN, +-Infinity) is ignored and the mode
   * default applies. A block's entry in `paramBoundByBlock` takes precedence; an entry in
   * `paramKnownSizeByBlock` can only lower it (to size - 1 + `paramAbsentRunLimit`).
   */
  maxParamId?: number;
  /**
   * Table size per block (key = block address) known from a catalog or an editor cache: ids
   * 0..size-1 are walked WITHOUT the `paramAbsentRunLimit` stop, so a sparse table keeps real rows
   * that follow long id gaps. Past the known size the normal stop run applies, counted afresh from
   * id `size` (trailing empty slots inside the table do not eat into it), so params a newer unit
   * appends to the table are found. With no `paramBoundByBlock` entry the block's ceiling is
   * min(`maxParamId`, size - 1 + `paramAbsentRunLimit`) — never further. `blockProbeDepth` still
   * skips a block whose first params are all absent; raise it for a table that starts with a long
   * gap. Blocks without an entry keep the stop run and the `maxParamId` ceiling.
   *
   * Pass ONLY the exact table size of the attached firmware (from a catalog or a byte-exact
   * cache). An over-large size removes the stop run up to it: junk that a unit answers past a
   * table's end and that passes the pseudo checks is walked there and, in FULL mode, swept (written)
   * up to it. Only a finite integer >= 0 is used; NaN, Infinity, a fraction or a negative value is
   * ignored as if the block had no entry.
   */
  paramKnownSizeByBlock?: Record<number, number>;
  /**
   * HARD ceiling per block (key = block address): the highest PARAM id queried, inclusive. The walk
   * never queries above it, for any reason; it wins over `maxParamId` in both directions and over
   * `paramKnownSizeByBlock` (a bound below size - 1 truncates the known table; one above
   * size - 1 + `paramAbsentRunLimit` is honoured too, so pass a bound only as a cap tighter than
   * that, e.g. min(size - 1 + `paramAbsentRunLimit`, the mode cap)). It does not change
   * the stop run: on its own it only caps a walk that would otherwise go on. A negative value skips
   * the block (no queries); a value above 16383 is clamped. Only a finite integer is used; NaN,
   * Infinity or a fraction is ignored as if the block had no entry.
   */
  paramBoundByBlock?: Record<number, number>;
  /**
   * Consecutive absent params that end a block's sweep (default 32, like `placeholderRunLimit`).
   * Counted from the last real definition (and from the start of the block, until the first one is
   * found — see `blockProbeDepth`); suspended for ids below a block's `paramKnownSizeByBlock`
   * entry (and counted afresh from that size). Only a finite integer >= 1 is used; anything else
   * (NaN, Infinity, a fraction, 0, a negative value) is the default 32. A run of exactly this many ends the block, so an inner run of empty slots is bridged
   * (and kept as placeholders up to `placeholderRunLimit`) only when it is shorter; a longer one
   * ends the block. Raise it only for a section known to carry bigger internal id gaps, together
   * with `maxParamId` — the ceiling still bounds the sweep whatever this is. It also sets how far
   * past a known size the ceiling reaches (size - 1 + this).
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
   * as inner placeholder records (default 32); the same limit applies to the unused tail of a table
   * that a no-payload reply ends. Other trailing empty slots are always trimmed — they cannot be
   * told apart from the end of the table. 0 keeps none (the pre-placeholder behaviour).
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
  const vr = await transport.request(buildValueQuery(model, block, param));
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
 * Table end: a block ends a small run past its last real definition and never above its ceiling;
 * end markers, repeated non-zero ids and implausible junk are absent slots, never swept — see the
 * header section "Table end, bounds and pseudo definitions" (`paramAbsentRunLimit`, `maxParamId`,
 * `paramKnownSizeByBlock`, `paramBoundByBlock`, `LiveWalkResult.pseudoReplies`).
 *
 * Empty slots: an empty-slot definition between two real definitions (or before the first one)
 * is an unused slot INSIDE the parameter table — the editor cache keeps it as an all-zero float
 * placeholder, so the walk emits the same placeholder once the next real definition proves it is
 * inner. Trailing empty slots (symbol id 0) are kept the same way when the next answer is a
 * no-payload reply — the way an effect table answers past its end — and trimmed otherwise
 * (indistinguishable from the end of the table). A run longer than `placeholderRunLimit` is an
 * id-space gap, not placeholders.
 */
export async function liveWalkDetailed(transport: LiveTransport, opts: LiveWalkOptions): Promise<LiveWalkResult> {
  const model = opts.model;
  // 160 (not 127): the block byte now splits lo/hi (body[2]/[3]) so effectId>=128
  // blocks are reachable. Empty high blocks are skipped after `blockProbeDepth`
  // params (see the found===0 break below), so the extra range is nearly free.
  const maxBlock = opts.maxBlock ?? 160;
  const blocks = opts.blocks ?? Array.from({ length: maxBlock + 1 }, (_, i) => i);
  // FULL mode writes, so its default ceiling and the sweep guard below care about the mode early.
  const mode = opts.mode ?? 'read-only';
  const full = mode === 'full';
  const defaultMaxParamId = full ? DEFAULT_FULL_MAX_PARAM_ID : DEFAULT_READ_ONLY_MAX_PARAM_ID;
  // A non-finite value (NaN, +-Infinity) is no value: the mode default applies. Finite ones are clamped.
  const requestedMax = opts.maxParamId;
  const maxParamId = typeof requestedMax === 'number' && Number.isFinite(requestedMax) ? clampParamBound(requestedMax) : defaultMaxParamId;
  // Only a finite integer >= 1 is a run limit; anything else (NaN, Infinity, 1.5, 0, negative) is the default.
  const requestedRun = opts.paramAbsentRunLimit;
  const absentRunLimit = typeof requestedRun === 'number' && Number.isInteger(requestedRun) && requestedRun >= 1 ? requestedRun : DEFAULT_ABSENT_RUN_LIMIT;
  /**
   * A block's walk plan. `ceiling`: the highest id queried, inclusive — the caller's HARD bound when
   * given (wins over `maxParamId` both ways), else a known size's `size - 1 + absentRunLimit` capped
   * by `maxParamId`, else `maxParamId`. `knownSize`: ids below it are walked without the stop run
   * (0 = none known); past it the normal stop run applies, so appended params are found.
   */
  const planOf = (block: number): { ceiling: number; knownSize: number } => {
    // Only a finite INTEGER is trusted: NaN, Infinity and 1.5 are ignored (treated as no entry).
    // A negative bound is a deliberate "skip this block"; a negative size means nothing, so it is ignored.
    const bound = opts.paramBoundByBlock?.[block];
    const size = opts.paramKnownSizeByBlock?.[block];
    const hardBound = bound !== undefined && Number.isInteger(bound) ? bound : undefined;
    const knownSize = size !== undefined && Number.isInteger(size) && size >= 0 ? Math.min(MAX_WIRE_PARAM_ID + 1, size) : undefined;
    if (hardBound !== undefined) return { ceiling: clampParamBound(hardBound), knownSize: knownSize ?? 0 };
    if (knownSize !== undefined) return { ceiling: Math.min(maxParamId, clampParamBound(knownSize - 1 + absentRunLimit)), knownSize };
    return { ceiling: maxParamId, knownSize: 0 };
  };
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
  const pseudoReplies: PseudoReplyStats = { endMarker: 0, duplicateId: 0, implausible: 0 };
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
    let pendingId0 = true; // every pending empty slot carried symbol id 0 (no end marker among them)
    // The unused tail of the table: the pending empty slots that a no-payload reply ended (see
    // "Empty slots"), kept once the block ends without a further real definition.
    let tableTail: number[] | undefined;
    let lastReal = -1;
    // Symbol ids already seen in this block (real definitions + end markers): real params carry
    // unique ids, so a definition repeating one is a pseudo definition.
    const seenIds = new Set<number>();
    const { ceiling: bound, knownSize } = planOf(block);
    blockSilenceProven = false;
    blockSilentRun = 0;
    trailingSilentDefs = 0;
    silentSinceProof = 0;
    runBooked = { lost: 0, unresolved: 0 };
    for (let param = 0; param <= bound; param++) {
      throwIfAborted(signal);
      // Crossing a known table size: the stop run counts afresh, so the lookahead past the table is
      // always a full `absentRunLimit` (trailing empty slots inside the table do not eat into it).
      if (param === knownSize) absentRun = 0;
      // The block-probe phase (no definition found yet) stays one-shot, exactly as before:
      // retries there would multiply the cost of every empty block. So does a block whose
      // silent addresses the liveness check has already explained.
      const reply = await ask(buildDefQuery(model, block, param), found > 0 && !blockSilenceProven);
      const dec = reply ? decodeReply(reply) : null;
      const def = dec && dec.view === 'definition' ? dec : null;

      const verdict = def ? judgeDefinition(def, seenIds) : undefined;

      if (!def || verdict !== 'real') {
        if (verdict === 'empty' || verdict === 'end-marker') {
          pendingEmpty.push(param);
          if (verdict === 'end-marker') pendingId0 = false;
        } else if (reply) {
          // The first answer after the run that is not an empty slot. A no-payload reply there is
          // the end of the table, so a fully answered run of id-0 empty slots before it is the
          // table's unused tail (kept below unless a later real definition turns it inner).
          if (pendingIntact && pendingId0 && pendingUnknown === 0 && lastReal >= 0 && isNoPayloadReply(reply, VIEW_DEFINITION)) {
            tableTail = [...pendingEmpty];
          }
          pendingIntact = false; // a sentinel / pseudo / junk answer: not a table slot
        } else pendingUnknown += 1; // unanswered: the slot is simply unknown
        if (def) {
          // Answered, but not a parameter: counted so a build can report what it ignored.
          if (verdict === 'end-marker') {
            pseudoReplies.endMarker += 1;
            seenIds.add(def.id); // (non-zero by definition) a later definition reusing it is a copy
          } else if (verdict === 'duplicate-id') pseudoReplies.duplicateId += 1;
          else if (verdict === 'garbage' || verdict === 'implausible') pseudoReplies.implausible += 1;
        }
        absentRun += 1;
        // Skip an empty block once its opening params are all absent.
        if (found === 0 && param + 1 >= probeDepth) break;
        // The stop run; suspended inside a known table size (ids below it).
        if (absentRun >= absentRunLimit && param >= knownSize) break;
        continue;
      }
      absentRun = 0;
      found += 1;
      if (def.id !== 0) seenIds.add(def.id);

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
      pendingId0 = true;
      tableTail = undefined;
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
        const vr = await ask(buildValueQuery(model, block, param), true);
        const vd = vr ? decodeReply(vr) : null;
        if (vd && vd.view === 'value') unit = parseUnit(vd.value);
      }

      // FULL mode: sweep the taper of a CONTINUOUS FLOAT param only — never an
      // enum (a label list was found) nor an int/inert param (kind!=float or
      // max==min). Mirrors CaptureRig v2's `d["kind"]=="float" and max!=min`
      // (the label walk already claimed any enum). The sweep writes + restores;
      // its taper rides the FloatRecord and is threaded into the RangeDef.
      // WRITES only on a trustworthy record: reaching here means the definition passed every
      // pseudo / implausible check. `param <= bound` is defense in depth — the loop bound (the
      // block's ceiling) already guarantees it; it stays so a later change to the loop cannot let a
      // sweep write above the ceiling.
      let taper: FloatTaper | undefined;
      if (sweepCtx && labels.length === 0 && def.kind === 'float' && def.max !== def.min && param <= bound) {
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
    // Empty slots still pending here are TRAILING. Those a no-payload reply ended are the table's
    // unused tail and kept (the editor cache carries them as well); any others are dropped — they
    // cannot be told apart from the end of the table, so a section ending in such slots yields a
    // SHORTER stride than the editor cache (a lower bound).
    if (tableTail && tableTail.length > 0 && tableTail.length <= placeholderRunLimit) {
      for (const p of tableTail) records.push(placeholderRecord(block, p));
      placeholderSlots += tableTail.length;
    }

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
  return { records, queries, enumLabels, lostReplies, recoveredReplies, unresolvedReplies, placeholderSlots, missingSlots, silentAddresses, pseudoReplies };
}

/**
 * Convenience: a `RecordSource` that walks a live device, ready for
 * `buildCache(liveSource(transport, opts), params, seeds, …)`.
 */
export function liveSource(transport: LiveTransport, opts: LiveWalkOptions): RecordSource {
  return { kind: 'live', walk: () => liveWalkDetailed(transport, opts) };
}
