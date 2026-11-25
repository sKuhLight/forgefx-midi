/**
 * Gen-3 live telemetry: tuner, output meters, CPU load, and the FM3-validated
 * tempo write. Reverse-engineered from FM3-Edit captures and LIVE-VALIDATED on
 * FM3 hardware by the pre-migration ForgeFX server; the raw frames + the values
 * that implementation computed are frozen as goldens under
 * `test/gen3/fm3/fixtures/telemetry.expected.json` (migration Phase 0).
 *
 * These are STATE reads on the fn=0x01 channel (sub 0x19 field reads and the
 * sub 0x2E system-status block), not documented in Fractal's public spec:
 *
 *   TUNER — FM3-Edit opens the tuner page (fn 0x12 sub 0x1e), then polls
 *     fn 0x01 sub 0x19 field 0x02; the reply's value field (5-septet LE
 *     float32 at pos 12) is the detected fundamental in Hz.
 *   METERS — fn 0x01 sub 0x19 over Output 1/2 × L/R (addr 0x2A/0x2B,
 *     sub 0x10/0x11); the 23-byte reply carries RMS energy as a 5-septet
 *     float32 at pos 12 → dB = 10·log10(v). These are the REAL calibrated
 *     leveling meters (matched FM3-Edit's readout to ~1 dB); the 0x2E
 *     bytes-35/36 meters saturate and are NOT used.
 *   CPU — fn 0x01 sub 0x2E returns preset status and the routing grid.
 *     CPU load is a float32 percentage at offset 0x0C of its unpacked payload.
 *   TEMPO WRITE — the fn 0x14 SET does not take on FM3; FM3-Edit writes the
 *     global-tempo parameter instead (fn 0x01 typed SET, effectId 2
 *     (Controllers), paramId 0x20, value = float32 BPM).
 *
 * Every builder REQUIRES the model byte — there is deliberately NO 0x10
 * default here. Telemetry polls are fired continuously at whatever unit is
 * attached; a defaulted model byte is exactly how the wrong-codec bug class
 * (frames silently ignored by the device) kept re-emerging.
 */
import { fractalChecksum } from '../../shared/checksum.js';
import { decodeSeptetStream } from '../../shared/septetStream.js';
import { decode5SeptetFloat32, encode5SeptetFloat32 } from './setParam.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR_PREFIX = [0x00, 0x01, 0x74] as const;

/** fn=0x12 display/page control: sub 0x1e opens the tuner page, 0x08 returns to the layout. */
export const FN_DISPLAY_PAGE = 0x12;
export const SUB_PAGE_TUNER_OPEN = 0x1e;
export const SUB_PAGE_TUNER_CLOSE = 0x08;

/** fn=0x01 channel sub-actions used by telemetry. */
export const FN_PARAMETER = 0x01;
export const SUB_STATE_READ = 0x19;
export const SUB_SYSTEM_STATUS = 0x2e;
export const SUB_ACTION_SET_TYPED_LO = 0x09; // fn 0x01 typed-SET sub-action low byte

/** State-read field id polled for the tuner's detected fundamental. */
export const TUNER_FIELD_ADDR = 0x23;
export const TUNER_FIELD_SUB = 0x02;

/** Global tempo parameter address (FM3-validated): Controllers block, param 0x20. */
export const TEMPO_EFFECT_ID = 0x02;
export const TEMPO_PARAM_ID = 0x20;

function envelope(fn: number, payload: readonly number[], modelByte: number): number[] {
  const body = [SYSEX_START, ...FRACTAL_MFR_PREFIX, modelByte, fn, ...payload];
  return [...body, fractalChecksum(body), SYSEX_END];
}

// ── tuner ──────────────────────────────────────────────────────────────

/** Open the device's tuner page (required before tuner polls return a live frequency). */
export function buildTunerPageOpen(modelByte: number): number[] {
  return envelope(FN_DISPLAY_PAGE, [SUB_PAGE_TUNER_OPEN], modelByte);
}
/** Leave the tuner page (back to the layout view). */
export function buildTunerPageClose(modelByte: number): number[] {
  return envelope(FN_DISPLAY_PAGE, [SUB_PAGE_TUNER_CLOSE], modelByte);
}
/** Poll the detected fundamental (fn 0x01 sub 0x19 field 0x23/0x02). */
export function buildTunerPoll(modelByte: number): number[] {
  return envelope(FN_PARAMETER, [SUB_STATE_READ, 0x00, TUNER_FIELD_ADDR, 0x00, TUNER_FIELD_SUB, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0], modelByte);
}
/** True for a tuner state-read reply (any gen-3 model byte). */
export function isTunerResponse(frame: readonly number[]): boolean {
  return frame[5] === FN_PARAMETER && frame[6] === SUB_STATE_READ && frame[10] === TUNER_FIELD_SUB;
}
/** Detected fundamental in Hz (float32 at pos 12). 0 when no signal. */
export function parseTunerFreqHz(frame: readonly number[]): number {
  return decode5SeptetFloat32(frame[12] ?? 0, frame[13] ?? 0, frame[14] ?? 0, frame[15] ?? 0, frame[16] ?? 0);
}

// ── output meters ──────────────────────────────────────────────────────

export interface Gen3OutputMeter {
  role: 'out1L' | 'out1R' | 'out2L' | 'out2R';
  /** State-read address: 0x2A = Output 1, 0x2B = Output 2. */
  addr: number;
  /** Address sub-field: 0x10 = L, 0x11 = R. */
  sub: number;
}
/** The 4 leveling meters, in the round-robin order the reference poller uses. */
export const GEN3_OUTPUT_METERS: readonly Gen3OutputMeter[] = [
  { role: 'out1L', addr: 0x2a, sub: 0x10 },
  { role: 'out1R', addr: 0x2a, sub: 0x11 },
  { role: 'out2L', addr: 0x2b, sub: 0x10 },
  { role: 'out2R', addr: 0x2b, sub: 0x11 },
];

/** Expected length of a leveling-meter reply frame. */
export const METER_RESPONSE_LEN = 23;
/** Display floor/ceiling in dB (matches FM3-Edit's Preset Leveling page; live-verified peaks to +5.8 dB). */
export const METER_FLOOR_DB = -40;
export const METER_CEIL_DB = 6;

/** Poll one leveling meter (tiny 23-byte read — safe at UI rates on fast links). */
export function buildOutputMeterPoll(meter: Pick<Gen3OutputMeter, 'addr' | 'sub'>, modelByte: number): number[] {
  return envelope(FN_PARAMETER, [SUB_STATE_READ, 0x00, meter.addr, 0x00, meter.sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], modelByte);
}
/** True for the reply to `buildOutputMeterPoll(meter, …)`. */
export function isOutputMeterResponse(frame: readonly number[], meter: Pick<Gen3OutputMeter, 'addr' | 'sub'>): boolean {
  return frame[5] === FN_PARAMETER && frame[6] === SUB_STATE_READ
    && frame[8] === meter.addr && frame[10] === meter.sub && frame.length === METER_RESPONSE_LEN;
}
/** Raw RMS energy from a meter reply (float32 at pos 12). */
export function parseOutputMeterRms(frame: readonly number[]): number {
  return decode5SeptetFloat32(frame[12] ?? 0, frame[13] ?? 0, frame[14] ?? 0, frame[15] ?? 0, frame[16] ?? 0);
}
/** RMS energy → calibrated dB (10·log10, clamped to [floor, ceil]). */
export function meterRmsToDb(rms: number, floorDb = METER_FLOOR_DB, ceilDb = METER_CEIL_DB): number {
  if (!(rms > 1e-7)) return floorDb;
  const db = 10 * Math.log10(rms);
  return Math.max(floorDb, Math.min(ceilDb, db));
}

// ── per-block monitor meters (VU / level / gain-reduction) ───────────────
// Same fn 0x01 sub 0x19 state-read as the output meters, but addressed by (effectId, monitorPid)
// rather than a fixed output address — this is exactly how FM3-Edit polls each block's live meter
// (FM3 capture 2026-07-04: comp eid46/pid25, gate eid146/pid13, m-comp eid154/pids 28-30; the output
// meters are just the same frame at pseudo-address 0x2a/0x2b sub 0x10/0x11). The reply's value @12..16
// is a NORMALIZED 0..1 float (`parseBlockMonitorNorm`), mapped to dB by the device's monitor table
// (`fm3MonitorDb`/`fm9MonitorDb`/`axe3MonitorDb`). Model-generic across gen-3 (III/FM3/FM9/VP4).
export function buildBlockMonitorPoll(effectId: number, monitorPid: number, modelByte: number): number[] {
  const e14 = [effectId & 0x7f, (effectId >> 7) & 0x7f];
  const p14 = [monitorPid & 0x7f, (monitorPid >> 7) & 0x7f];
  return envelope(FN_PARAMETER, [SUB_STATE_READ, 0x00, ...e14, ...p14, 0, 0, 0, 0, 0, 0, 0, 0, 0], modelByte);
}
/** True for the reply to `buildBlockMonitorPoll(effectId, monitorPid, …)` (echoes eid+pid at 8-11). */
export function isBlockMonitorResponse(frame: readonly number[], effectId: number, monitorPid: number): boolean {
  return frame[5] === FN_PARAMETER && frame[6] === SUB_STATE_READ
    && (((frame[8] ?? 0) | ((frame[9] ?? 0) << 7)) === effectId)
    && (((frame[10] ?? 0) | ((frame[11] ?? 0) << 7)) === monitorPid)
    && frame.length === METER_RESPONSE_LEN;
}
/** Normalized 0..1 monitor level from a block-monitor reply (5-septet float @12..16, clamped).
 *  NOTE: this field is a 0..1 position, NOT the RMS energy the output meters carry — map it to dB
 *  with the monitor table's linear `minDb + norm·(maxDb−minDb)`, not `meterRmsToDb`. */
export function parseBlockMonitorNorm(frame: readonly number[]): number {
  const v = decode5SeptetFloat32(frame[12] ?? 0, frame[13] ?? 0, frame[14] ?? 0, frame[15] ?? 0, frame[16] ?? 0);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

// ── looper waveform (Looper block; FM3 capture 2026-07-04) ───────────────
// The looper page's live waveform is streamed via fn 0x01 sub 0x23 addressed at the Looper effectId
// (FM3: eid 166). The reply is a ~609-byte frame whose payload (bytes 12..len-2) is ~595 RAW 7-bit
// envelope magnitudes (0..127), one per display column — NOT a float. The playhead position and the
// looper level ride the ordinary block-monitor poll (sub 0x19): position at pid 14, level at pid 22
// (both via `buildBlockMonitorPoll`/`parseBlockMonitorNorm`). Model-generic across gen-3 loopers
// (FM3 renders the waveform too, contrary to older notes; FM9/III share the block).
export const SUB_LOOPER_WAVEFORM = 0x23;
export function buildLooperWaveformPoll(effectId: number, modelByte: number): number[] {
  const e14 = [effectId & 0x7f, (effectId >> 7) & 0x7f];
  return envelope(FN_PARAMETER, [SUB_LOOPER_WAVEFORM, 0x00, ...e14, 0, 0, 0, 0, 0, 0, 0, 0, 0], modelByte);
}
/** True for a looper-waveform reply (the long fn 0x01 sub 0x23 frame at `effectId`). */
export function isLooperWaveformResponse(frame: readonly number[], effectId: number): boolean {
  return frame[5] === FN_PARAMETER && frame[6] === SUB_LOOPER_WAVEFORM
    && (((frame[8] ?? 0) | ((frame[9] ?? 0) << 7)) === effectId)
    && frame.length > 100;
}
/** Decode the looper waveform envelope → normalized 0..1 magnitudes (one per display column).
 *  Payload = raw 7-bit samples between the 12-byte header and the checksum+F7. */
export function parseLooperWaveform(frame: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 12; i < frame.length - 2; i++) out.push((frame[i] ?? 0) / 127);
  return out;
}

// ── looper transport control (Record / Play / Stop / Overdub / Undo / Once / Reverse / Half) ──
// FM3 capture 2026-07-04: FM3-Edit toggles these via fn 0x01 SUB 0x10 → the Looper (effectId, controlPid)
// with a 5-septet‑LE float value 1.0 (on/press) or 0.0 (off). e.g. Record on = `…01 10 00 <eid> 08 00
// 00 00 00 7c 03` (0x3F800000 = 1.0); off = `…00 00 00 00 00`. Same envelope on all gen-3.
export const SUB_LOOPER_CONTROL = 0x10;
const F32_ONE_SEPTETS = [0x00, 0x00, 0x00, 0x7c, 0x03]; // 1.0f as 5 LE septets
const F32_ZERO_SEPTETS = [0x00, 0x00, 0x00, 0x00, 0x00]; // 0.0f
export function buildLooperControl(effectId: number, controlPid: number, on: boolean, modelByte: number): number[] {
  const e14 = [effectId & 0x7f, (effectId >> 7) & 0x7f];
  const p14 = [controlPid & 0x7f, (controlPid >> 7) & 0x7f];
  return envelope(FN_PARAMETER, [SUB_LOOPER_CONTROL, 0x00, ...e14, ...p14, ...(on ? F32_ONE_SEPTETS : F32_ZERO_SEPTETS)], modelByte);
}

// ── CPU load ───────────────────────────────────────────────────────────

/** @deprecated Historical minimum observed frame length. Use `isCpuResponse` to match a reply. */
export const CPU_RESPONSE_MIN_LEN = 590;
/** @deprecated Raw byte used by the old estimate. Use `parseCpuPercent` instead. */
export const CPU_RAW_OFFSET = 37;
/** @deprecated Coefficient of the old estimate. Use `parseCpuPercent` instead. */
export const CPU_BASE = 32;
/** @deprecated Coefficient of the old estimate. Use `parseCpuPercent` instead. */
export const CPU_SLOPE = 0.5;

const STATUS_LENGTH_OFFSET = 19;
const STATUS_PAYLOAD_OFFSET = 21;
const CPU_PERCENT_OFFSET = 0x0c;
const CPU_PAYLOAD_BYTES = CPU_PERCENT_OFFSET + 4;
const CPU_PACKED_BYTES = Math.ceil(CPU_PAYLOAD_BYTES * 8 / 7);
/** FM3 model byte — the only model with observed sub 0x2E replies. */
const MODEL_BYTE_FM3 = 0x11;

/** Poll preset status and the routing grid (poll sparingly). */
export function buildCpuPoll(modelByte: number): number[] {
  return envelope(FN_PARAMETER, [SUB_SYSTEM_STATUS, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], modelByte);
}
/** True for a preset-status reply with a complete declared payload.
 *  Reply layout: `F0 00 01 74 <model> 01 2E` + 14-bit sub/field words, the
 *  14-bit payload BYTE COUNT at 19..20, the septet payload from 21, checksum +
 *  `F7`. The frame length is `21 + ceil(count*8/7) + 2` (590 for a 496-byte FM3
 *  payload, 755 for 640 bytes), so the count — not a per-model constant — sizes it.
 *  Field 4 (bytes 17..18) is additionally required to be 0 on FM3, the only model
 *  with observed status replies; it is not constrained on the other model bytes. */
export function isCpuResponse(frame: readonly number[]): boolean {
  if (
    frame.length < STATUS_PAYLOAD_OFFSET + CPU_PACKED_BYTES + 2 ||
    frame[0] !== SYSEX_START ||
    !FRACTAL_MFR_PREFIX.every((byte, i) => frame[i + 1] === byte) ||
    frame[5] !== FN_PARAMETER ||
    frame[6] !== SUB_SYSTEM_STATUS ||
    frame[7] !== 0 || // 14-bit sub-op/selector high byte
    frame[frame.length - 1] !== SYSEX_END ||
    fractalChecksum(frame.slice(0, -2)) !== frame[frame.length - 2]
  ) return false;
  if (frame[4] === MODEL_BYTE_FM3 && (frame[17] !== 0 || frame[18] !== 0)) return false;
  const length = frame[STATUS_LENGTH_OFFSET] | (frame[STATUS_LENGTH_OFFSET + 1] << 7);
  return length >= CPU_PAYLOAD_BYTES && STATUS_PAYLOAD_OFFSET + Math.ceil(length * 8 / 7) + 2 === frame.length;
}

/** Decode the CPU percentage, or return `null` for an invalid reply. */
export function parseCpuPercent(frame: readonly number[]): number | null {
  if (!isCpuResponse(frame)) return null;
  // The payload is one continuous MSB-first septet stream (no per-chunk re-alignment);
  // the CPU load is a float32 little-endian percentage at payload offset 0x0C.
  const payload = decodeSeptetStream(frame, CPU_PAYLOAD_BYTES, STATUS_PAYLOAD_OFFSET);
  const percent = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getFloat32(CPU_PERCENT_OFFSET, true);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
}

/** @deprecated Raw byte used by the old estimate. Use `parseCpuPercent` instead. */
export function parseCpuRawLoad(frame: readonly number[]): number {
  return frame[CPU_RAW_OFFSET] ?? 0;
}
/** @deprecated Preserve the old estimate for existing callers. Use `parseCpuPercent` instead. */
export function cpuPercentFromRaw(raw: number, base = CPU_BASE, slope = CPU_SLOPE): number {
  return Math.round((base + raw * slope) * 10) / 10;
}

// ── tempo write (FM3-validated param-address path) ─────────────────────

/**
 * Set the global tempo the way FM3-Edit does: a typed fn 0x01 SET at the
 * global-tempo parameter (effectId 2, paramId 0x20), BPM as a raw float32
 * value. The documented fn 0x14 SET does not take on FM3.
 */
export function buildSetTempoViaParam(bpm: number, modelByte: number): number[] {
  const val = encode5SeptetFloat32(bpm);
  return envelope(FN_PARAMETER, [
    SUB_ACTION_SET_TYPED_LO, 0x00,
    TEMPO_EFFECT_ID, 0x00,
    TEMPO_PARAM_ID, 0x00,
    ...val,
    0, 0, 0, 0,
  ], modelByte);
}
