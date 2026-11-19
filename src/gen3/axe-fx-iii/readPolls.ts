/**
 * Gen-3 read/poll frames on the dual-use channels — recognised BYTE-FOR-BYTE.
 *
 * Function 0x01 (and the 0x0C / 0x14 SET_GET pairs) carry writes as well as
 * reads, so they are not on the read/query function list
 * (`shared/queryFunctions.ts`). A raw-probe path may still need the specific
 * read/poll frames this codec builds on them. `isGen3ReadPollFrame` accepts a
 * frame only when it is identical, byte for byte, to one of these builders'
 * output for the given model:
 *
 *   - tuner poll            `buildTunerPoll`        (fn 0x01 sub 0x19 field 0x02)
 *   - CPU poll              `buildCpuPoll`          (fn 0x01 sub 0x2E)
 *   - output-meter polls    `buildOutputMeterPoll`  (fn 0x01 sub 0x19, the four GEN3_OUTPUT_METERS)
 *   - tempo GET             `buildGetTempo`         (fn 0x14, query sentinel 7F 7F)
 *   - scene GET             `buildGetScene`         (fn 0x0C, query sentinel 7F)
 *   - raw param-value GET   `buildGetRawParamValue` (fn 0x01 sub 0x1B, any 14-bit effect / param id)
 *
 * Every other frame — including any other 0x01 sub-action or a variant of the
 * above with different padding — is not a read/poll frame.
 */
import { fractalChecksum } from '../../shared/checksum.js';
import { buildTunerPoll, buildCpuPoll, buildOutputMeterPoll, GEN3_OUTPUT_METERS } from './telemetry.js';
import { buildGetTempo, buildGetScene } from './setParam.js';

/** fn 0x01 sub-action that returns one parameter's RAW stored value (enum ordinal / label char). */
export const SUB_ACTION_GET_RAW_VALUE = 0x1b;

/**
 * Raw param-value GET: `F0 00 01 74 <model> 01 1B 00 <eid:2×7bit LE> <pid:2×7bit LE> 00×9 cs F7`.
 * The reply carries the field's raw value as a little-endian 7-bit int at body byte 12 (enum ordinal,
 * or an ASCII char for label fields); used for the Foot Controller live read-back.
 */
export function buildGetRawParamValue(effectId: number, paramId: number, modelByte: number): number[] {
  const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
  const body = [
    0xf0, 0x00, 0x01, 0x74, modelByte & 0x7f, 0x01, SUB_ACTION_GET_RAW_VALUE, 0x00,
    ...enc14(effectId), ...enc14(paramId),
    0, 0, 0, 0, 0, 0, 0, 0, 0,
  ];
  return [...body, fractalChecksum(body), 0xf7];
}

const RAW_VALUE_GET_LEN = 23;

function sameBytes(a: readonly number[], b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** True when `frame` is byte-identical to one of the gen-3 read/poll builders' output for `model`. */
export function isGen3ReadPollFrame(frame: ArrayLike<number>, model: number): boolean {
  const fixed = [
    buildTunerPoll(model),
    buildCpuPoll(model),
    ...GEN3_OUTPUT_METERS.map((m) => buildOutputMeterPoll(m, model)),
    buildGetTempo(model),
    buildGetScene(model),
  ];
  if (fixed.some((f) => sameBytes(f, frame))) return true;
  if (frame.length !== RAW_VALUE_GET_LEN || frame[5] !== 0x01 || frame[6] !== SUB_ACTION_GET_RAW_VALUE) return false;
  // Rebuild from the frame's own ids and compare — any other padding / model / checksum fails.
  const eid = (frame[8]! & 0x7f) | ((frame[9]! & 0x7f) << 7);
  const pid = (frame[10]! & 0x7f) | ((frame[11]! & 0x7f) << 7);
  return sameBytes(buildGetRawParamValue(eid, pid, model), frame);
}
