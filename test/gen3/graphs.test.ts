/**
 * Block graph curves (`fn 0x01 sub 0x23`) - device-fed curve channel.
 *
 * Every `graph_*` widget draws the float array the unit returns for
 * `(effectId, graphIndex)`; the RTA applies its own dB mapping and the Looper
 * uses slot 0 with a raw 7-bit envelope instead of floats. These cases pin the
 * request byte layout, the response matching, both payload encodings, and the
 * RTA band mapping - no hardware needed.
 */
import {
  SUB_GRAPH_CURVE,
  GRAPH_CURVE_SLOTS,
  GRAPH_CURVE_MAX_WIRE_LEN,
  buildGraphCurvePoll,
  isGraphCurveResponse,
  parseGraphCurve,
  rtaBandCount,
  parseRtaBands,
  buildLooperWaveformPoll,
  isLooperWaveformResponse,
  parseLooperWaveform,
} from '../../src/gen3/axe-fx-iii/telemetry.js';
import { encode5SeptetFloat32 } from '../../src/gen3/axe-fx-iii/setParam.js';
import { fractalChecksum } from '../../src/shared/checksum.js';

function fail(msg: string): never {
  throw new Error(`[gen3/graphs] ${msg}`);
}

const MODELS = [0x10, 0x11, 0x12, 0x14] as const;
const FM3 = 0x11;

function envelope(model: number, fn: number, payload: number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  return [...body, fractalChecksum(body), 0xf7];
}

/** Reply shape: 12-byte header (fn/sub/eid/slot), payload, checksum, F7. */
function reply(model: number, eid: number, slot: number, payload: number[]): number[] {
  return envelope(model, 0x01, [
    SUB_GRAPH_CURVE,
    0x00,
    eid & 0x7f,
    (eid >> 7) & 0x7f,
    slot & 0x7f,
    (slot >> 7) & 0x7f,
    ...payload,
  ]);
}

function septetCurve(values: readonly number[]): number[] {
  const out: number[] = [];
  for (const v of values) out.push(...encode5SeptetFloat32(v));
  return out;
}

export const GEN3_GRAPHS_CASE_COUNT = 9;

export function runGen3GraphsTests(): void {
  // 1 - request layout: sub 0x23, eid u16 LE at 8-9, graphIndex u32 LE at 10-13, rest zero
  for (const model of MODELS) {
    for (let slot = 0; slot < GRAPH_CURVE_SLOTS; slot++) {
      const frame = buildGraphCurvePoll(199, slot, model);
      if (frame[5] !== 0x01 || frame[6] !== SUB_GRAPH_CURVE) fail(`sub byte wrong @${model.toString(16)}/${slot}`);
      if (frame[4] !== model) fail(`model byte wrong @${model.toString(16)}`);
      if ((frame[8]! | (frame[9]! << 7)) !== 199) fail(`eid not echoed @${model.toString(16)}/${slot}`);
      if ((frame[10]! | (frame[11]! << 7)) !== slot) fail(`graphIndex wrong @${model.toString(16)}/${slot}`);
      if (frame[12] !== 0 || frame[13] !== 0) fail(`graphIndex high bytes not zero @${model.toString(16)}/${slot}`);
      for (const b of frame.slice(14, -2)) if (b !== 0) fail(`graph poll padding not zero @${model.toString(16)}/${slot}`);
      if (frame[0] !== 0xf0 || frame[frame.length - 1] !== 0xf7) fail('framing wrong');
    }
  }

  // 2 - the Looper waveform poll is the same opcode on the same channel: identical
  //     `sub 0x23, 0x00, eid` prefix; the Looper request stops two pad bytes earlier
  //     (13-byte payload vs the 15-byte `sub 0x19`-family shape used here). Slot 0 is
  //     all-zero in both, so the pad length is the only difference.
  const looperPoll = buildLooperWaveformPoll(166, FM3);
  const graphPoll = buildGraphCurvePoll(166, 0, FM3);
  if (looperPoll[6] !== SUB_GRAPH_CURVE || graphPoll[6] !== SUB_GRAPH_CURVE) fail('looper poll is not sub 0x23');
  if (looperPoll[5] !== 0x01 || graphPoll[5] !== 0x01) fail('graph/looper poll is not fn 0x01');
  for (let i = 0; i < 10; i++) {
    if (looperPoll[i] !== graphPoll[i]) fail(`looper/graph prefix differs at byte ${i}`);
  }
  if (graphPoll.length !== looperPoll.length + 2) {
    fail(`graph poll length ${graphPoll.length} should be looper ${looperPoll.length} + 2 pad bytes`);
  }

  // 3 - response matching accepts only the echoed eid+slot
  const curve = [0.25, 0.5, 1, 2, 4, -1];
  const septetReply = reply(FM3, 62, 3, septetCurve(curve));
  if (!isGraphCurveResponse(septetReply, 62, 3)) fail('valid curve reply rejected');
  if (isGraphCurveResponse(septetReply, 62, 2)) fail('wrong slot accepted');
  if (isGraphCurveResponse(septetReply, 63, 3)) fail('wrong eid accepted');
  if (isGraphCurveResponse(septetReply.slice(0, 13), 62, 3)) fail('truncated reply accepted');

  // 4 - 5-septet payload decode is exact
  const decoded = parseGraphCurve(septetReply);
  if (decoded.length !== curve.length) fail(`septet length ${decoded.length} !== ${curve.length}`);
  for (let i = 0; i < curve.length; i++) {
    if (Math.abs((decoded[i] ?? NaN) - curve[i]!) > 1e-6) fail(`septet value ${i}: ${decoded[i]} !== ${curve[i]}`);
  }

  // 5 - raw byte-aligned float32 payload decode (a length that is not a multiple of 5)
  const rawBytes: number[] = [];
  for (const v of curve) {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, v, true);
    const bytes = new Uint8Array(buf);
    rawBytes.push(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  }
  const rawReply = reply(FM3, 62, 0, rawBytes);
  const rawDecoded = parseGraphCurve(rawReply);
  if (rawDecoded.length !== curve.length) fail(`raw length ${rawDecoded.length} !== ${curve.length}`);
  for (let i = 0; i < curve.length; i++) {
    if (Math.abs((rawDecoded[i] ?? NaN) - curve[i]!) > 1e-6) fail(`raw value ${i}: ${rawDecoded[i]} !== ${curve[i]}`);
  }

  // 6 - RTA band count from the selector
  if (rtaBandCount(0) !== 32 || rtaBandCount(1) !== 64 || rtaBandCount(2) !== 128) {
    fail(`rtaBandCount: ${rtaBandCount(0)}/${rtaBandCount(1)}/${rtaBandCount(2)}`);
  }

  // 7 - RTA dB mapping: -110 dB floor, +10 dB ceiling, 0 dB at 70/120
  const rtaFrame = reply(FM3, 174, 0, septetCurve([1e-11, 0.0001, 1, 10, 100, 1000]));
  const bands = parseRtaBands(rtaFrame, 1);
  if (bands.length !== 6) fail(`rta band count ${bands.length}`);
  if (bands[0] !== 0) fail(`-110 dB floor -> ${bands[0]}, expected 0`);
  if (Math.abs((bands[2] ?? 0) - 110 / 120) > 1e-5) fail(`0 dB -> ${bands[2]}, expected ${110 / 120}`);
  if (bands[5] !== 1) fail(`+30 dB clamped -> ${bands[5]}, expected 1`);
  for (const b of bands) if (!(b >= 0 && b <= 1)) fail(`band ${b} out of 0..1`);

  // 8 - graph vs looper separation: the same frame is a curve for one caller and a
  //     wave envelope for the other, and the encoding differs (floats vs raw 7-bit)
  const wavePayload: number[] = [];
  for (let i = 0; i < 595; i++) wavePayload.push(i % 128);
  const waveReply = reply(FM3, 166, 0, wavePayload);
  if (!isLooperWaveformResponse(waveReply, 166)) fail('looper waveform reply rejected');
  if (isLooperWaveformResponse(septetReply, 62)) fail('short curve reply treated as a waveform');
  const wave = parseLooperWaveform(waveReply);
  if (wave.length !== 595) fail(`waveform length ${wave.length} !== 595`);
  if (wave[1] !== 1 / 127) fail(`waveform scaling ${wave[1]}`);

  // 9 - a curve reply never exceeds the wire cap, and an over-long buffer is not a curve
  if (GRAPH_CURVE_MAX_WIRE_LEN !== 128 * 5 + 14) fail(`wire cap ${GRAPH_CURVE_MAX_WIRE_LEN}`);
  const tooLong = reply(FM3, 62, 0, new Array(GRAPH_CURVE_MAX_WIRE_LEN).fill(0));
  if (isGraphCurveResponse(tooLong, 62, 0)) fail('over-long reply accepted as a curve');
}
