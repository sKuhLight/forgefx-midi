/**
 * Gen-3 GET CURRENT TYPE NAME (fn=0x01 sub=0x1F) + the `displayName` field on
 * `parseGen3SetValueEcho`.
 *
 * `buildRequestCurrentTypeName` emits the editor's read-a-block's-current-
 * type/model-NAME frame (23 bytes): `F0 00 01 74 <model> 01 1F 00 <eid:14b LE>
 * <pid:14b LE> 00*9 <cks> F7`. The reply is the long fn=0x01 GET frame whose
 * display-string region carries the model name; `parseGen3SetValueEcho` now
 * surfaces that string as `displayName` (for a discrete type/model selector the
 * float value field is zero — the NAME is the answer).
 *
 * Request goldens are hand-computed byte literals (checksum = 7-bit XOR over
 * F0..last-payload). The displayName parse cases reuse the real-hardware FM9
 * GET captures already goldened in `setparam.test.ts` (model 0x12).
 */
import {
  buildRequestCurrentTypeName,
  SUB_ACTION_GET_TYPE_NAME,
  parseGen3SetValueEcho,
  parseGetParameterResponse,
  buildSetParameter,
} from '../../../src/gen3/axe-fx-iii/index.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function hexStr(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}
function parseHex(s: string): number[] {
  return s.trim().split(/\s+/).map((h) => parseInt(h, 16));
}
function assertBytes(got: readonly number[], want: readonly number[], label: string): void {
  assert(
    got.length === want.length && got.every((b, i) => b === want[i]),
    `${label}\n  got:  [${hexStr(got)}]\n  want: [${hexStr(want)}]`,
  );
}

const III = 0x10;
const FM9 = 0x12;

const cases: Array<() => void> = [];

// Case 1: exact 23-byte request frame, model III (0x10), effectId 110, typeParamId 0.
cases.push(() => {
  const got = buildRequestCurrentTypeName(110, 0, III);
  const want = parseHex('f0 00 01 74 10 01 1f 00 6e 00 00 00 00 00 00 00 00 00 00 00 00 65 f7');
  assertBytes(got, want, 'buildRequestCurrentTypeName III eid=110 pid=0');
  assert(got.length === 23, `type-name request must be 23 bytes, got ${got.length}`);
  assert(got[6] === SUB_ACTION_GET_TYPE_NAME, 'sub-action byte must be 0x1F at pos 6');
  assert(got[7] === 0x00, 'sub-action high byte must be 0x00 at pos 7');
  // Value field (bytes 12..20) carries no value — all zero.
  for (let i = 12; i <= 20; i++) assert(got[i] === 0x00, `value byte[${i}] must be zero (read carries no value)`);
});

// Case 2: SUB_ACTION_GET_TYPE_NAME const.
cases.push(() => {
  assert(SUB_ACTION_GET_TYPE_NAME === 0x1f, `SUB_ACTION_GET_TYPE_NAME must be 0x1f, got 0x${SUB_ACTION_GET_TYPE_NAME.toString(16)}`);
});

// Case 3: model-byte propagation — FM9 frame differs only at byte 4 + checksum.
cases.push(() => {
  const iii = buildRequestCurrentTypeName(110, 0, III);
  const fm9 = buildRequestCurrentTypeName(110, 0, FM9);
  const wantFm9 = parseHex('f0 00 01 74 12 01 1f 00 6e 00 00 00 00 00 00 00 00 00 00 00 00 67 f7');
  assertBytes(fm9, wantFm9, 'buildRequestCurrentTypeName FM9 eid=110 pid=0');
  for (let i = 0; i < fm9.length; i++) {
    if (i === 4 || i === 21) continue;
    assert(fm9[i] === iii[i], `FM9 vs III byte[${i}] must match outside model+checksum`);
  }
});

// Case 4: septet-LE effectId + paramId fields (nonzero, both spilling a high septet).
cases.push(() => {
  const eid = 200; // 0xc8 -> lo 0x48, hi 0x01
  const pid = 130; // 0x82 -> lo 0x02, hi 0x01
  const got = buildRequestCurrentTypeName(eid, pid, III);
  assert(got[8] === (eid & 0x7f) && got[9] === ((eid >> 7) & 0x7f), 'effectId septet-LE at bytes 8-9');
  assert(got[10] === (pid & 0x7f) && got[11] === ((pid >> 7) & 0x7f), 'paramId septet-LE at bytes 10-11');
});

// Case 5: parseGen3SetValueEcho surfaces `displayName` for a discrete type/model
// GET reply. Real-hardware FM9 GET captures (model 0x12) — the same frames
// goldened in setparam.test.ts. displayName must equal the frame's own display
// string and the numeric value field decodes to 0.0 (float value is the wrong
// thing to read for a type selector — the NAME is the answer).
cases.push(() => {
  const GET_AMP = [0xf0,0x00,0x01,0x74,0x12,0x01,0x09,0x00,0x3a,0x00,0x05,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x20,0x00,0x22,0x53,0x48,0x74,0x0a,0x1d,0x0a,0x44,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x14,0xf7];
  const GET_DLY = [0xf0,0x00,0x01,0x74,0x12,0x01,0x09,0x00,0x46,0x00,0x11,0x00,0x00,0x00,0x00,0x78,0x03,0x00,0x00,0x20,0x00,0x18,0x0b,0x46,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x46,0xf7];
  for (const [label, frame, eff, pid] of [
    ['GET_AMP', GET_AMP, 58, 5],
    ['GET_DLY', GET_DLY, 70, 17],
  ] as const) {
    const echo = parseGen3SetValueEcho(frame);
    const ref = parseGetParameterResponse(frame, 0x12).displayString;
    assert(echo.effectId === eff, `${label}: effectId ${echo.effectId} !== ${eff}`);
    assert(echo.paramId === pid, `${label}: paramId ${echo.paramId} !== ${pid}`);
    assert(echo.displayName === ref, `${label}: displayName ${JSON.stringify(echo.displayName)} !== ${JSON.stringify(ref)}`);
    assert(typeof echo.displayName === 'string' && echo.displayName.length > 0, `${label}: displayName must be non-empty`);
    assert(/^[\x20-\x7e]+$/.test(echo.displayName!), `${label}: displayName must be printable`);
  }
});

// Case 6: a plain 23-byte SET-echo carries NO display string — displayName undefined.
cases.push(() => {
  const setEcho = buildSetParameter(66, 0, 100);
  const echo = parseGen3SetValueEcho(setEcho);
  assert(echo.displayName === undefined, `SET-echo must not surface a displayName, got ${JSON.stringify(echo.displayName)}`);
  assert(echo.effectId === 66 && echo.paramId === 0, 'SET-echo effectId/paramId still decode');
});

export const GEN3_TYPENAME_CASE_COUNT = cases.length;

export function runGen3TypeNameTests(): void {
  cases.forEach((run, i) => {
    try {
      run();
    } catch (err) {
      throw new Error(`gen-3 type-name case ${i + 1}/${cases.length} failed: ${(err as Error).message}`);
    }
  });
}
