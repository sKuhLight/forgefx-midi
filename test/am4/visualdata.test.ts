/**
 * AM4 per-block visual data: the action 0x0D curve read at pidHigh 0x7DE..0x7E1.
 *
 * Pins the read-only request shape, the 128-byte payload count, the 32 float32
 * values, and the strict rejection paths. Synthetic replies only.
 */
import {
  AM4_CURVE_PID_HIGH_BASE,
  AM4_CURVE_SLOTS,
  AM4_CURVE_FLOAT_COUNT,
  AM4_CURVE_PAYLOAD_BYTES,
  buildAm4CurvePoll,
  isAm4CurveResponse,
  parseAm4CurveResponse,
} from '../../src/am4/visualData.js';
import { buildReadParam, READ_TYPE_LONG, AM4_MODEL_ID } from '../../src/am4/setParam.js';
import { packValueChunked } from '../../src/shared/packValue.js';
import { fractalChecksum } from '../../src/shared/checksum.js';

function fail(msg: string): never {
  throw new Error(`[am4/visualData] ${msg}`);
}

const BLOCK = 0x3a;

function u14(v: number): number[] {
  return [v & 0x7f, (v >> 7) & 0x7f];
}

/** Synthetic curve reply: 16-byte header + chunked-packed 128-byte payload + cs + F7. */
function curveReply(
  blockPidLow: number,
  slot: number,
  values: readonly number[],
  opts: { hdr4?: number; action?: number } = {},
): number[] {
  const raw: number[] = [];
  for (const v of values) {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, v, true);
    raw.push(...new Uint8Array(buf));
  }
  const hdr4 = opts.hdr4 ?? raw.length;
  const packed = Array.from(packValueChunked(Uint8Array.from(raw)));
  const body = [
    0xf0, 0x00, 0x01, 0x74, AM4_MODEL_ID, 0x01,
    ...u14(blockPidLow),
    ...u14(AM4_CURVE_PID_HIGH_BASE + slot),
    ...u14(opts.action ?? READ_TYPE_LONG),
    0, 0,
    ...u14(hdr4),
    ...packed,
  ];
  return [...body, fractalChecksum(body), 0xf7];
}

export const AM4_VISUALDATA_CASE_COUNT = 6;

export function runAm4VisualDataTests(): void {
  // 1 - request is the ordinary action-0x0D read with no payload: 18 bytes, slots 0..3.
  for (let slot = 0; slot < AM4_CURVE_SLOTS; slot++) {
    const expected = buildReadParam(
      { pidLow: BLOCK, pidHigh: AM4_CURVE_PID_HIGH_BASE + slot },
      READ_TYPE_LONG,
    );
    const frame = buildAm4CurvePoll(BLOCK, slot);
    if (frame.join(',') !== expected.join(',')) fail(`slot ${slot} request differs from buildReadParam`);
    if (frame.length !== 18) fail(`request is ${frame.length} bytes, expected 18`);
    if ((frame[8]! | (frame[9]! << 7)) !== AM4_CURVE_PID_HIGH_BASE + slot) fail(`slot ${slot} pidHigh wrong`);
    if ((frame[10]! | (frame[11]! << 7)) !== READ_TYPE_LONG) fail('request action is not 0x0D');
    if ((frame[14]! | (frame[15]! << 7)) !== 0) fail('request carries a payload count');
    if (fractalChecksum(frame.slice(0, -2)) !== frame[frame.length - 2]) fail('request checksum wrong');
  }
  let threw = false;
  try { buildAm4CurvePoll(BLOCK, 4); } catch { threw = true; }
  if (!threw) fail('slot 4 request accepted');
  threw = false;
  try { buildAm4CurvePoll(BLOCK, -1); } catch { threw = true; }
  if (!threw) fail('negative slot request accepted');

  // 2 - reply geometry: hdr4 128 → 18 full chunks (144) + a 2-byte tail (3) → 147 septets.
  const values: number[] = [];
  for (let i = 0; i < AM4_CURVE_FLOAT_COUNT; i++) values.push(Math.cos(i / 7) * 6);
  const reply = curveReply(BLOCK, 2, values);
  if (reply.length !== 16 + 147 + 2) fail(`reply is ${reply.length} bytes, expected 165`);
  if ((reply[14]! | (reply[15]! << 7)) !== AM4_CURVE_PAYLOAD_BYTES) fail('declared payload is not 128');
  if (!isAm4CurveResponse(reply, BLOCK, 2)) fail('valid curve reply rejected');

  // 3 - decode is exact: 32 float32 values in wire order.
  const decoded = parseAm4CurveResponse(reply, BLOCK, 2);
  if (decoded.length !== AM4_CURVE_FLOAT_COUNT) fail(`decoded ${decoded.length} values, expected 32`);
  for (let i = 0; i < values.length; i++) {
    if (decoded[i] !== Math.fround(values[i]!)) fail(`value ${i}: ${decoded[i]} !== ${Math.fround(values[i]!)}`);
  }

  // 4 - the echoed register pair identifies the reply.
  if (isAm4CurveResponse(reply, BLOCK, 1)) fail('wrong slot accepted');
  if (isAm4CurveResponse(reply, 0x76, 2)) fail('wrong block pidLow accepted');
  threw = false;
  try { parseAm4CurveResponse(reply, BLOCK, 1); } catch { threw = true; }
  if (!threw) fail('wrong-slot reply parsed');

  // 5 - a different declared count or action is not a curve reply.
  const fortyByte = curveReply(BLOCK, 2, values, { hdr4: 0x28 });
  if (isAm4CurveResponse(fortyByte, BLOCK, 2)) fail('40-byte-count reply accepted as a curve');
  const wrongAction = curveReply(BLOCK, 2, values, { action: 0x0e });
  if (isAm4CurveResponse(wrongAction, BLOCK, 2)) fail('action 0x0E reply accepted as a curve');

  // 6 - truncated frames and bad checksums are rejected.
  for (const cut of [reply.length - 1, 100, 16]) {
    if (isAm4CurveResponse(reply.slice(0, cut), BLOCK, 2)) fail(`truncated (${cut}) reply accepted`);
  }
  const bad = reply.slice();
  bad[bad.length - 2] = (bad[bad.length - 2]! ^ 0x02) & 0x7f;
  if (isAm4CurveResponse(bad, BLOCK, 2)) fail('bad-checksum reply accepted');
  threw = false;
  try { parseAm4CurveResponse(bad, BLOCK, 2); } catch { threw = true; }
  if (!threw) fail('bad-checksum reply parsed');
}
