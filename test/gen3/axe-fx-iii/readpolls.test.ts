/**
 * Gen-3 read/poll frames on the dual-use channels (`readPolls.ts`) — accepted
 * only byte-for-byte: the exact builder output for the model, never a variant,
 * never another model's frame, never another 0x01 sub-action or a SET.
 */
import { buildGetRawParamValue, isGen3ReadPollFrame, SUB_ACTION_GET_RAW_VALUE } from '../../../src/gen3/axe-fx-iii/readPolls.js';
import {
  buildTunerPoll,
  buildCpuPoll,
  buildOutputMeterPoll,
  GEN3_OUTPUT_METERS,
} from '../../../src/gen3/axe-fx-iii/telemetry.js';
import { buildGetTempo, buildGetScene, createModernFractalCodec } from '../../../src/gen3/axe-fx-iii/setParam.js';
import { fractalChecksum } from '../../../src/shared/checksum.js';

function fail(msg: string): never {
  throw new Error(`[gen3/readPolls] ${msg}`);
}

const hx = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`;
const toHex = (b: readonly number[]): string => b.map((x) => x.toString(16).padStart(2, '0')).join('');

/** `F0 00 01 74 <model> <fn> <data…> cs F7` — the hand-built envelope the FM3 capture script uses. */
function envelope(model: number, fn: number, data: number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...data];
  return [...body, fractalChecksum(body), 0xf7];
}

export const GEN3_READPOLLS_CASE_COUNT = 6;

export function runGen3ReadPollsTests(): void {
  // 1 ── every read/poll builder's output is accepted for its own model
  for (const m of [0x10, 0x11, 0x12, 0x14]) {
    const frames: Array<[string, number[]]> = [
      ['buildTunerPoll', buildTunerPoll(m)],
      ['buildCpuPoll', buildCpuPoll(m)],
      ...GEN3_OUTPUT_METERS.map((meter): [string, number[]] => [`buildOutputMeterPoll(${meter.role})`, buildOutputMeterPoll(meter, m)]),
      ['buildGetTempo', buildGetTempo(m)],
      ['buildGetScene', buildGetScene(m)],
      ['buildGetRawParamValue', buildGetRawParamValue(199, 300, m)],
    ];
    for (const [name, f] of frames) {
      if (!isGen3ReadPollFrame(f, m)) fail(`${name}@${hx(m)} rejected`);
      if (!isGen3ReadPollFrame(Uint8Array.from(f), m)) fail(`${name}@${hx(m)} rejected as Uint8Array`);
      // 2 ── …and rejected for any other model byte
      const other = m === 0x11 ? 0x10 : 0x11;
      if (isGen3ReadPollFrame(f, other)) fail(`${name}@${hx(m)} accepted for model ${hx(other)}`);
    }
  }

  // 3 ── the FM3 golden-capture script's raw-probe frames are byte-identical to the builders (tooling keeps working)
  const M = 0x11;
  const script: Array<[string, number[]]> = [
    ['tuner-poll', envelope(M, 0x01, [0x19, 0x00, 0x23, 0x00, 0x02, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ['cpu-poll', envelope(M, 0x01, [0x2e, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ['scene', envelope(M, 0x0c, [0x7f])],
    ['tempo', envelope(M, 0x14, [0x7f, 0x7f])],
    ...[[0x2a, 0x10], [0x2a, 0x11], [0x2b, 0x10], [0x2b, 0x11]].map(([a, s]): [string, number[]] =>
      [`meter ${hx(a!)}/${hx(s!)}`, envelope(M, 0x01, [0x19, 0x00, a!, 0x00, s!, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]),
  ];
  for (const [name, f] of script) if (!isGen3ReadPollFrame(f, M)) fail(`capture-script ${name} frame rejected`);

  // 4 ── raw param-value GET golden: F0 00 01 74 11 01 1B 00 <eid LE 7-bit> <pid LE 7-bit> 00×9 cs F7
  const golden = envelope(M, 0x01, [SUB_ACTION_GET_RAW_VALUE, 0x00, 199 & 0x7f, 199 >> 7, 300 & 0x7f, 300 >> 7, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  if (toHex(buildGetRawParamValue(199, 300, M)) !== toHex(golden)) fail(`raw GET ${toHex(buildGetRawParamValue(199, 300, M))} !== ${toHex(golden)}`);

  // 5 ── variants are rejected: padding, length, checksum, other sub-actions, SETs, the empty-payload tempo frame
  const padded = envelope(M, 0x01, [SUB_ACTION_GET_RAW_VALUE, 0x00, 0x47, 0x01, 0x2c, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0x01]);
  const longer = envelope(M, 0x01, [SUB_ACTION_GET_RAW_VALUE, 0x00, 0x47, 0x01, 0x2c, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const badCs = [...golden];
  badCs[badCs.length - 2] = (badCs[badCs.length - 2]! ^ 0x01) & 0x7f;
  const c = createModernFractalCodec(M);
  const rejected: Array<[string, number[]]> = [
    ['raw GET with non-zero padding', padded],
    ['raw GET one byte longer', longer],
    ['raw GET with a bad checksum', badCs],
    ['sub 0x1A range read', envelope(M, 0x01, [0x1a, 0x00, 0x47, 0x01, 0x2c, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ['buildGetParameter', c.buildGetParameter(58, 1)],
    ['buildSetParameter', c.buildSetParameter(58, 1, 3)],
    ['buildStorePreset', c.buildStorePreset(5)],
    ['buildSetTempo', c.buildSetTempo(120)],
    ['buildSetScene', c.buildSetScene(2)],
    ['buildSetTuner', c.buildSetTuner(true)],
    ['empty-payload tempo frame', envelope(M, 0x14, [])],
  ];
  for (const [name, f] of rejected) if (isGen3ReadPollFrame(f, M)) fail(`${name} accepted`);

  // 6 ── non-frames are rejected
  if (isGen3ReadPollFrame([], M)) fail('empty buffer accepted');
  if (isGen3ReadPollFrame([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7], M)) fail('universal SysEx accepted');
}
