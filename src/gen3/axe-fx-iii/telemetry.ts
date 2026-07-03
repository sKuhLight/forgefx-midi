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
 *   CPU — fn 0x01 sub 0x2E returns a ≥590-byte system-status frame; byte 37
 *     is the block DSP load → CPU% ≈ base + raw·slope (base 32, slope 0.5,
 *     matched to the FM3 front panel).
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

// ── CPU load ───────────────────────────────────────────────────────────

/** Minimum length of the fn 0x01 sub 0x2E system-status frame. */
export const CPU_RESPONSE_MIN_LEN = 590;
/** Byte offset of the block-DSP-load field inside the system-status frame. */
export const CPU_RAW_OFFSET = 37;
/** CPU% ≈ base + raw·slope (matched to the FM3 front-panel readout). */
export const CPU_BASE = 32;
export const CPU_SLOPE = 0.5;

/** Poll the system-status block (heavy ≥590-byte read — poll sparingly). */
export function buildCpuPoll(modelByte: number): number[] {
  return envelope(FN_PARAMETER, [SUB_SYSTEM_STATUS, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], modelByte);
}
/** True for a system-status reply. */
export function isCpuResponse(frame: readonly number[]): boolean {
  return frame[5] === FN_PARAMETER && frame[6] === SUB_SYSTEM_STATUS && frame.length >= CPU_RESPONSE_MIN_LEN;
}
/** Raw block-DSP-load byte. */
export function parseCpuRawLoad(frame: readonly number[]): number {
  return frame[CPU_RAW_OFFSET] ?? 0;
}
/** Raw load byte → CPU percent, 1-decimal rounded (reference math). */
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
