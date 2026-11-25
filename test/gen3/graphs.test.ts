/**
 * Block graph curves (`fn 0x01 sub 0x23`) - the device-fed curve channel.
 *
 * Every `graph_*` widget draws the float32 magnitudes the unit returns for
 * `(effectId, graphIndex)`; the RTA applies its own dB mapping and the Looper
 * waveform is the same container at slot 0 (its values are the loop envelope).
 * A reply declares its payload byte count: 512 for the full-size cab/PEQ/filter/
 * looper curves, 128/256 for the 32/64-band RTA. These cases pin the 23-byte
 * request, the count/length/checksum rules, the continuous septet stream, the
 * smaller RTA shapes and every rejection path - no hardware needed. Synthetic
 * replies are built with a bit-writer that is the exact inverse of
 * `decodeSeptetStream`.
 */
import {
  SUB_GRAPH_CURVE,
  GRAPH_CURVE_SLOTS,
  GRAPH_CURVE_HEADER_LEN,
  GRAPH_CURVE_MAX_BYTES,
  GRAPH_CURVE_VALUE_COUNT,
  GRAPH_CURVE_SEPTETS,
  GRAPH_CURVE_WIRE_LEN,
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
import { decodeSeptetStream } from '../../src/shared/septetStream.js';
import { fractalChecksum } from '../../src/shared/checksum.js';
import { float32Bytes, packSeptetStream } from '../shared/septet-fixtures.js';

function fail(msg: string): never {
  throw new Error(`[gen3/graphs] ${msg}`);
}

const MODELS = [0x10, 0x11, 0x12, 0x14] as const;
const FM3 = 0x11;
const HEADER_LEN = 21;

/** Wire length the count implies: header + ceil(count*8/7) septets + checksum + F7. */
function wireLengthFor(count: number): number {
  return HEADER_LEN + Math.ceil((count * 8) / 7) + 2;
}

/** A curve reply for `values` (4 bytes each); `count`/`packBytes` override the shape. */
function curveReply(
  model: number,
  eid: number,
  slot: number,
  values: readonly number[],
  opts: { status?: number; count?: number; packBytes?: number } = {},
): number[] {
  const raw = float32Bytes(values);
  const count = opts.count ?? raw.length;
  const packBytes = opts.packBytes ?? Math.min(raw.length, count);
  const status = opts.status ?? 0;
  const header = [
    0xf0, 0x00, 0x01, 0x74, model, 0x01,
    SUB_GRAPH_CURVE, 0x00,
    eid & 0x7f, (eid >> 7) & 0x7f,
    slot & 0x7f, (slot >> 7) & 0x7f,
    0, 0, 0, 0, 0, // revision word: five septets
    status & 0x7f, (status >> 7) & 0x7f,
    count & 0x7f, (count >> 7) & 0x7f,
  ];
  if (header.length !== HEADER_LEN) fail(`synthetic header is ${header.length} bytes, expected ${HEADER_LEN}`);
  const body = [...header, ...packSeptetStream(raw.slice(0, packBytes))];
  return [...body, fractalChecksum(body), 0xf7];
}

/** Deterministic finite curve values with both signs and a wide magnitude range. */
function sampleCurve(seed: number, count = GRAPH_CURVE_VALUE_COUNT): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.sin((i + seed) / 9) * Math.cos(i / 17) * 12.5);
  }
  return out;
}

function expectRejected(frame: readonly number[], label: string): void {
  if (isGraphCurveResponse(frame, 62, 0)) fail(`${label} accepted`);
  let threw = false;
  try { parseGraphCurve(frame); } catch { threw = true; }
  if (!threw) fail(`${label} parsed`);
}

export const GEN3_GRAPHS_CASE_COUNT = 13;

export function runGen3GraphsTests(): void {
  // 1 - request layout: fn 0x01, sub 0x23 u16, eid u16 at 8-9, curve slot u16 at 10-11,
  //     nine zero pad bytes, 23 bytes total (the shape the editors emit).
  for (const model of MODELS) {
    for (let slot = 0; slot < GRAPH_CURVE_SLOTS; slot++) {
      const frame = buildGraphCurvePoll(199, slot, model);
      if (frame.length !== 23) fail(`graph poll is ${frame.length} bytes, expected 23`);
      if (frame[4] !== model) fail(`model byte wrong @${model.toString(16)}`);
      if (frame[5] !== 0x01) fail(`fn byte wrong @${model.toString(16)}`);
      if (frame[6] !== SUB_GRAPH_CURVE || frame[7] !== 0) fail(`sub not 0x23 @${model.toString(16)}`);
      if ((frame[8]! | (frame[9]! << 7)) !== 199) fail(`eid not echoed @${model.toString(16)}/${slot}`);
      if ((frame[10]! | (frame[11]! << 7)) !== slot) fail(`curve slot wrong @${model.toString(16)}/${slot}`);
      for (let i = 12; i < 21; i++) if (frame[i] !== 0) fail(`graph poll padding not zero @${i}`);
      if (fractalChecksum(frame.slice(0, -2)) !== frame[frame.length - 2]) fail('graph poll checksum wrong');
    }
  }

  // 2 - full-size geometry: 21 header + ceil(512*8/7) septets + checksum + F7 = 609.
  if (GRAPH_CURVE_HEADER_LEN !== 21) fail(`header length ${GRAPH_CURVE_HEADER_LEN}`);
  if (GRAPH_CURVE_SEPTETS !== 586) fail(`septet count ${GRAPH_CURVE_SEPTETS}`);
  if (GRAPH_CURVE_WIRE_LEN !== 609) fail(`wire length ${GRAPH_CURVE_WIRE_LEN}`);
  if (GRAPH_CURVE_MAX_WIRE_LEN !== 609) fail(`wire cap alias ${GRAPH_CURVE_MAX_WIRE_LEN}`);
  const values = sampleCurve(3);
  const reply = curveReply(FM3, 62, 0, values);
  if (reply.length !== 609) fail(`reply is ${reply.length} bytes, expected 609`);
  if ((reply[19]! | (reply[20]! << 7)) !== GRAPH_CURVE_MAX_BYTES) fail('declared count is not 512');
  if ((reply[17]! | (reply[18]! << 7)) !== 0) fail('status is not zero');
  if (fractalChecksum(reply.slice(0, -2)) !== reply[reply.length - 2]) fail('reply checksum wrong');

  // 3 - the septet writer/reader round-trip is exact (the test fixture is the inverse).
  const rawRoundTrip = decodeSeptetStream(reply, GRAPH_CURVE_MAX_BYTES, HEADER_LEN);
  if (rawRoundTrip.length !== 512) fail(`round-trip produced ${rawRoundTrip.length} bytes, expected 512`);

  // 4 - decode is exact: 128 finite float32 values, bit-for-bit.
  const decoded = parseGraphCurve(reply);
  if (decoded.length !== GRAPH_CURVE_VALUE_COUNT) fail(`decoded ${decoded.length} values, expected 128`);
  for (let i = 0; i < values.length; i++) {
    const expected = Math.fround(values[i]!);
    if (decoded[i] !== expected) fail(`value ${i}: ${decoded[i]} !== ${expected}`);
    if (!Number.isFinite(decoded[i]!)) fail(`value ${i} is not finite`);
  }

  // 5 - response matching accepts only the echoed eid + slot of a valid container.
  if (!isGraphCurveResponse(reply, 62, 0)) fail('valid curve reply rejected');
  if (isGraphCurveResponse(reply, 62, 1)) fail('wrong slot accepted');
  if (isGraphCurveResponse(reply, 63, 0)) fail('wrong eid accepted');
  if (!isGraphCurveResponse(curveReply(FM3, 62, 3, values), 62, 3)) fail('slot 3 reply rejected');

  // 6 - the RTA shapes: count 128 -> 32 floats (length 170), count 256 -> 64 floats (length 316).
  const rta32Values = sampleCurve(5, 32);
  const rta64Values = sampleCurve(7, 64);
  const rta32 = curveReply(FM3, 174, 0, rta32Values);
  const rta64 = curveReply(FM3, 174, 0, rta64Values);
  if (rta32.length !== wireLengthFor(128) || rta32.length !== 170) fail(`32-band reply is ${rta32.length} bytes`);
  if (rta64.length !== wireLengthFor(256) || rta64.length !== 316) fail(`64-band reply is ${rta64.length} bytes`);
  if (!isGraphCurveResponse(rta32, 174, 0)) fail('32-band reply rejected');
  if (!isGraphCurveResponse(rta64, 174, 0)) fail('64-band reply rejected');
  const bands32 = parseGraphCurve(rta32);
  const bands64 = parseGraphCurve(rta64);
  if (bands32.length !== 32) fail(`32-band reply decoded ${bands32.length} values`);
  if (bands64.length !== 64) fail(`64-band reply decoded ${bands64.length} values`);
  for (let i = 0; i < 32; i++) if (bands32[i] !== Math.fround(rta32Values[i]!)) fail(`32-band value ${i}`);
  for (let i = 0; i < 64; i++) if (bands64[i] !== Math.fround(rta64Values[i]!)) fail(`64-band value ${i}`);

  // 7 - a declared count that is not a multiple of 4 is rejected (geometry consistent).
  const notMultiple = curveReply(FM3, 62, 0, sampleCurve(11, 33), { count: 130, packBytes: 130 });
  if (notMultiple.length !== wireLengthFor(130)) fail(`count-130 frame is ${notMultiple.length} bytes`);
  expectRejected(notMultiple, 'count-130 reply');

  // 8 - a declared count above 512 is rejected (geometry consistent).
  const tooMany = curveReply(FM3, 62, 0, sampleCurve(13, 129), { count: 516, packBytes: 516 });
  if (tooMany.length !== wireLengthFor(516)) fail(`count-516 frame is ${tooMany.length} bytes`);
  expectRejected(tooMany, 'count-516 reply');

  // 9 - a frame length that disagrees with the declared count is rejected.
  const wrongLength = curveReply(FM3, 62, 0, values, { count: 128, packBytes: 512 });
  if (wrongLength.length !== 609) fail(`wrong-length fixture is ${wrongLength.length} bytes`);
  expectRejected(wrongLength, 'count-128/609-byte reply');
  const countPatched = reply.slice();
  countPatched[19] = 0x7f;
  countPatched[20] = 0x03; // 511, still inside a 609-byte frame
  countPatched[countPatched.length - 2] = fractalChecksum(countPatched.slice(0, -2));
  expectRejected(countPatched, 'count-511 reply');

  // 10 - truncated or over-long frames are rejected (length is part of the container).
  for (const cut of [600, 608, 610]) {
    const short = cut < reply.length ? reply.slice(0, cut) : [...reply, 0];
    expectRejected(short, `length-${cut} reply`);
  }

  // 11 - status and checksum are validated.
  const busyReply = curveReply(FM3, 62, 0, values, { status: 2 });
  if (isGraphCurveResponse(busyReply, 62, 0)) fail('status-2 reply accepted');
  const badChecksum = reply.slice();
  badChecksum[badChecksum.length - 2] = (badChecksum[badChecksum.length - 2]! ^ 0x01) & 0x7f;
  if (isGraphCurveResponse(badChecksum, 62, 0)) fail('bad-checksum reply accepted');

  // 12 - the Looper waveform uses the same opcode and container: slot 0, same request bytes.
  const looperPoll = buildLooperWaveformPoll(166, FM3);
  const graphPoll = buildGraphCurvePoll(166, 0, FM3);
  if (looperPoll.length !== 23) fail(`looper poll is ${looperPoll.length} bytes, expected 23`);
  if (looperPoll.join(',') !== graphPoll.join(',')) fail('looper poll differs from the slot-0 curve fetch');
  const envelope = sampleCurve(17).map((v) => Math.abs(v) / 10);
  const waveReply = curveReply(FM3, 166, 0, envelope);
  if (!isLooperWaveformResponse(waveReply, 166)) fail('looper waveform reply rejected');
  if (isLooperWaveformResponse(curveReply(FM3, 166, 1, envelope), 166)) fail('slot-1 curve treated as a waveform');
  if (isLooperWaveformResponse(reply, 166)) fail('cab curve accepted at the looper effect id');
  const wave = parseLooperWaveform(waveReply);
  if (wave.length !== GRAPH_CURVE_VALUE_COUNT) fail(`waveform length ${wave.length}`);
  for (let i = 0; i < envelope.length; i++) {
    if (wave[i] !== Math.fround(envelope[i]!)) fail(`waveform value ${i}: ${wave[i]} !== ${Math.fround(envelope[i]!)}`);
  }

  // 13 - RTA band count from the selector, band slicing, and the 120 dB dB mapping.
  if (rtaBandCount(0) !== 32 || rtaBandCount(1) !== 64 || rtaBandCount(2) !== 128) {
    fail(`rtaBandCount: ${rtaBandCount(0)}/${rtaBandCount(1)}/${rtaBandCount(2)}`);
  }
  const rta128Values = sampleCurve(19, 128);
  rta128Values[0] = 1e-11;
  rta128Values[1] = 0.0001;
  rta128Values[2] = 1;
  rta128Values[3] = 10;
  rta128Values[4] = 100;
  rta128Values[5] = 1000;
  const rta128 = curveReply(FM3, 174, 0, rta128Values);
  const bands = parseRtaBands(rta128, 2);
  if (bands.length !== 128) fail(`RTA selector 2 produced ${bands.length} bands, expected 128`);
  if (parseRtaBands(rta32, 0).length !== 32) fail('RTA selector 0 did not produce 32 bands');
  if (parseRtaBands(rta64, 1).length !== 64) fail('RTA selector 1 did not produce 64 bands');
  if (bands[0] !== 0) fail(`-110 dB floor -> ${bands[0]}, expected 0`);
  if (Math.abs((bands[2] ?? 0) - 110 / 120) > 1e-5) fail(`0 dB -> ${bands[2]}, expected ${110 / 120}`);
  if (bands[5] !== 1) fail(`+30 dB clamped -> ${bands[5]}, expected 1`);
  for (const b of bands) if (!(b >= 0 && b <= 1)) fail(`band ${b} out of 0..1`);
}
